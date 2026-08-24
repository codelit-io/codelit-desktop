use crate::copilot::{self, CopilotProgress, CopilotRunLimits, CopilotRunRequest};
use crate::lmstudio;
use crate::model_manager;
use crate::ollama;
use crate::provider_api::{ByokApiRequest, ByokStreamEvent, execute_byok_request};
use crate::provider_credentials::{ProviderCredentialRef, ProviderCredentialStore, SecretBytes};
use crate::providers::{
    byok_provider, ensure_provider_execution_allowed, read_version, resolve_provider_command,
};
use crate::run_control::{
    CancellationToken, OutputStream, ProviderRunEvent, RunEventEmitter, RunRegistry,
    configure_process_group, run_line_process, run_line_process_guarded, stop_child_tree,
    wait_for_message,
};
use crate::system_resources::{self, MlxOperation};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const PROVIDER_TIMEOUT: Duration = Duration::from_secs(120);
const MODEL_PREPARE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MODEL_BENCHMARK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_PROMPT_CHARS: usize = 8_000;
const MAX_CAPTURE_BYTES: usize = 512 * 1024;
const MAX_CODEX_STDOUT_LINE_BYTES: usize = 64 * 1024;
const CODEX_STDOUT_READ_BUFFER_BYTES: usize = 8 * 1024;
const MAX_STREAMED_STRUCTURED_BYTES: usize = 64 * 1024;
const MAX_STREAMED_REASONING_CHARS: usize = 4_000;
const MAX_STRUCTURED_SUMMARY_BYTES: usize = 2_800;
const MAX_STRUCTURED_ITEMS: usize = 3;
const MAX_STRUCTURED_ITEM_BYTES: usize = 350;
const MAX_FORMATTED_ANSWER_BYTES: usize = 4_000;
static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

struct ExecutionControl<'a> {
    timeout: Duration,
    cancellation: &'a CancellationToken,
    emitter: &'a RunEventEmitter,
}

fn output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_STRUCTURED_SUMMARY_BYTES
            },
            "items": {
                "type": "array",
                "maxItems": MAX_STRUCTURED_ITEMS,
                "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MAX_STRUCTURED_ITEM_BYTES
                }
            }
        },
        "required": ["summary", "items"]
    })
}

#[derive(Default)]
struct StructuredSummaryStream {
    raw: String,
    emitted: String,
}

impl StructuredSummaryStream {
    fn push(&mut self, chunk: &str, emitter: &RunEventEmitter) {
        if chunk.is_empty() || self.raw.len() >= MAX_STREAMED_STRUCTURED_BYTES {
            return;
        }
        let remaining = MAX_STREAMED_STRUCTURED_BYTES - self.raw.len();
        self.raw.push_str(utf8_prefix(chunk, remaining));
        if let Some(summary) = streamed_summary_prefix(&self.raw) {
            self.emit_new_summary(&summary, emitter);
        }
    }

    fn finish(&mut self, summary: &str, emitter: &RunEventEmitter) {
        self.emit_new_summary(summary, emitter);
    }

    fn emit_new_summary(&mut self, summary: &str, emitter: &RunEventEmitter) {
        let bounded = utf8_prefix(summary, MAX_STRUCTURED_SUMMARY_BYTES).to_string();
        let Some(delta) = bounded.strip_prefix(&self.emitted) else {
            return;
        };
        if delta.is_empty() {
            return;
        }
        emitter.emit("output-delta", delta, None);
        self.emitted = bounded;
    }
}

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn streamed_summary_prefix(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut index = 0;
    let mut depth = 0_i32;
    while index < bytes.len() {
        match bytes[index] {
            b'{' | b'[' => {
                depth += 1;
                index += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                index += 1;
            }
            b'"' => {
                let start = index;
                let end = complete_json_string_end(bytes, start)?;
                index = end + 1;
                if depth != 1 {
                    continue;
                }
                let mut separator = index;
                while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
                    separator += 1;
                }
                if bytes.get(separator) != Some(&b':') {
                    continue;
                }
                let key = serde_json::from_slice::<String>(&bytes[start..=end]).ok()?;
                if key != "summary" {
                    continue;
                }
                separator += 1;
                while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
                    separator += 1;
                }
                if bytes.get(separator) != Some(&b'"') {
                    return None;
                }
                return partial_json_string(value, separator);
            }
            _ => index += 1,
        }
    }
    None
}

fn complete_json_string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate().skip(start + 1) {
        if escaped {
            escaped = false;
        } else if *byte == b'\\' {
            escaped = true;
        } else if *byte == b'"' {
            return Some(index);
        }
    }
    None
}

fn partial_json_string(value: &str, start: usize) -> Option<String> {
    let bytes = value.as_bytes();
    let complete_end = complete_json_string_end(bytes, start);
    if let Some(end) = complete_end {
        return serde_json::from_slice::<String>(&bytes[start..=end]).ok();
    }

    let mut raw_end = value.len();
    while raw_end > start + 1 {
        let candidate = format!("{}\"", &value[start..raw_end]);
        if let Ok(decoded) = serde_json::from_str::<String>(&candidate) {
            return Some(decoded);
        }
        raw_end -= 1;
        while raw_end > start + 1 && !value.is_char_boundary(raw_end) {
            raw_end -= 1;
        }
    }
    Some(String::new())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTaskRequest {
    #[serde(default)]
    pub run_id: Option<String>,
    pub provider: String,
    #[serde(default = "default_provider_model")]
    pub model: String,
    pub prompt: String,
    pub working_directory: Option<String>,
    #[serde(default)]
    pub selection_mode: Option<String>,
}

fn default_provider_model() -> String {
    "default".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTaskResult {
    pub run_id: String,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub structured_output: Option<Value>,
    pub text: String,
    pub duration_ms: u64,
    pub command_path: String,
    pub version: Option<String>,
    pub evidence: Vec<String>,
    pub selection_mode: String,
    pub billing_fallback: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelManagerRequest {
    #[serde(default)]
    pub run_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub action: String,
}

pub fn manage_local_model(
    request: ModelManagerRequest,
    app_data_dir: &Path,
    registry: &RunRegistry,
    channel: Option<Channel<ProviderRunEvent>>,
) -> Result<model_manager::ProviderModel, String> {
    if request.provider != "mlx" {
        return Err("Only Codelit's built-in MLX models are managed by this app.".into());
    }
    let run_id = normalize_run_id(request.run_id.as_deref())?;
    let model_id = request.model.trim();
    let action = request.action.trim();
    if !matches!(
        action,
        "download" | "resume" | "update" | "benchmark" | "delete"
    ) {
        return Err("Unsupported local model action.".into());
    }
    let active_run = registry.begin(&run_id)?;
    let cancellation = active_run.token();
    let emitter = RunEventEmitter::new(&run_id, "mlx", model_id, channel);
    emitter.emit("queued", "Model action queued", None);
    emitter.emit(
        "started",
        match action {
            "delete" => "Removing the on-device model",
            "benchmark" => "Benchmarking the on-device model",
            _ => "Preparing the on-device model",
        },
        None,
    );

    let result = match action {
        "delete" => model_manager::delete_model(app_data_dir, model_id),
        "benchmark" => benchmark_mlx_model(model_id, app_data_dir, &cancellation, &emitter),
        _ => download_mlx_model(model_id, app_data_dir, &cancellation, &emitter),
    };
    match result {
        Ok(model) => {
            emitter.emit(
                "completed",
                if action == "delete" {
                    "On-device model removed"
                } else if model.status == "ready" {
                    "On-device model is ready"
                } else {
                    "Model benchmark completed with limited capability"
                },
                serde_json::to_value(&model).ok(),
            );
            Ok(model)
        }
        Err(error) => {
            emitter.emit(
                if cancellation.is_canceled() {
                    "canceled"
                } else {
                    "failed"
                },
                if cancellation.is_canceled() {
                    "Model download paused"
                } else {
                    "The model action did not complete"
                },
                None,
            );
            Err(error)
        }
    }
}

fn download_mlx_model(
    model_id: &str,
    app_data_dir: &Path,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
) -> Result<model_manager::ProviderModel, String> {
    let model = model_manager::prepare_download(app_data_dir, model_id)?;
    let current = model_manager::probe_model_by_id(app_data_dir, model_id)?;
    if current.status == "ready" {
        return Ok(current);
    }
    if current.installed_bytes.is_some()
        && matches!(
            current.status.as_str(),
            "benchmark-required" | "incompatible"
        )
    {
        return benchmark_mlx_model(model_id, app_data_dir, cancellation, emitter);
    }
    let command_path = resolve_provider_command("mlx")
        .ok_or("Codelit's bundled MLX runtime is unavailable in this build.")?;
    let mut command = Command::new(&command_path);
    command
        .args([
            "--model",
            model_id,
            "--revision",
            &model.revision,
            "--prepare-model",
        ])
        .current_dir(env::temp_dir())
        .stdin(Stdio::null());
    configure_provider_environment(&mut command, &command_path);
    configure_mlx_managed_home(&mut command, app_data_dir)?;
    let output = run_line_process_guarded(
        command,
        MODEL_PREPARE_TIMEOUT,
        cancellation,
        |stream, line| {
            if stream == OutputStream::Stderr {
                let message = line.trim();
                if message.starts_with("Loading ") || message.starts_with("Model download ") {
                    emitter.emit("message", message, None);
                }
            }
        },
        || system_resources::ensure_mlx_allowed(MlxOperation::Download),
    )?;
    if !output.status.success() {
        return Err(friendly_mlx_error(&output.stderr));
    }
    let prepared: Value = serde_json::from_str(output.stdout.trim())
        .map_err(|_| "The on-device model helper returned an invalid completion receipt.")?;
    if prepared.get("status").and_then(Value::as_str) != Some("ready")
        || prepared.get("model").and_then(Value::as_str) != Some(model_id)
        || prepared.get("revision").and_then(Value::as_str) != Some(model.revision.as_str())
    {
        return Err("The on-device model helper returned a mismatched completion receipt.".into());
    }
    let verified = model_manager::probe_model_by_id(app_data_dir, model_id)?;
    if !matches!(verified.status.as_str(), "ready" | "benchmark-required") {
        return Err(format!(
            "The model download finished but integrity verification failed. {}",
            verified.detail
        ));
    }
    if verified.status == "ready" {
        Ok(verified)
    } else {
        benchmark_mlx_model(model_id, app_data_dir, cancellation, emitter)
    }
}

fn benchmark_mlx_model(
    model_id: &str,
    app_data_dir: &Path,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
) -> Result<model_manager::ProviderModel, String> {
    let model = model_manager::manifest_entry(model_id)?;
    let installed = model_manager::probe_model_by_id(app_data_dir, model_id)?;
    if installed.installed_bytes.is_none()
        || !matches!(
            installed.status.as_str(),
            "ready" | "benchmark-required" | "incompatible"
        )
    {
        return Err("Download and verify the on-device model before benchmarking it.".into());
    }
    let command_path = resolve_provider_command("mlx")
        .ok_or("Codelit's bundled MLX runtime is unavailable in this build.")?;
    let mut command = Command::new(&command_path);
    command
        .args([
            "--model",
            model_id,
            "--revision",
            &model.revision,
            "--benchmark",
        ])
        .current_dir(env::temp_dir())
        .stdin(Stdio::null());
    configure_provider_environment(&mut command, &command_path);
    configure_mlx_managed_home(&mut command, app_data_dir)?;
    let output = run_line_process_guarded(
        command,
        MODEL_BENCHMARK_TIMEOUT,
        cancellation,
        |stream, line| {
            if stream == OutputStream::Stderr {
                let message = line.trim();
                if message.starts_with("Loading ") || message.starts_with("Benchmarking ") {
                    emitter.emit("message", message, None);
                }
            }
        },
        || system_resources::ensure_mlx_allowed(MlxOperation::Benchmark),
    )?;
    if !output.status.success() {
        return Err(friendly_mlx_error(&output.stderr));
    }
    let benchmark = serde_json::from_str::<model_manager::ModelBenchmark>(output.stdout.trim())
        .map_err(|_| "The on-device model returned an invalid benchmark receipt.")?;
    model_manager::save_benchmark(app_data_dir, model_id, &benchmark)?;
    let measured = model_manager::probe_model_by_id(app_data_dir, model_id)?;
    if !matches!(measured.status.as_str(), "ready" | "incompatible") {
        return Err("The model benchmark could not be verified after it finished.".into());
    }
    Ok(measured)
}

pub fn run_provider_task_stream(
    request: ProviderTaskRequest,
    managed_home: Option<PathBuf>,
    registry: &RunRegistry,
    channel: Option<Channel<ProviderRunEvent>>,
) -> Result<ProviderTaskResult, String> {
    let run_id = normalize_run_id(request.run_id.as_deref())?;
    let provider = request.provider.trim();
    let model = request.model.trim();
    let selection_mode = normalize_selection_mode(request.selection_mode.as_deref())?;
    ensure_provider_execution_allowed(provider)?;
    if model.is_empty() || model.chars().count() > 180 {
        return Err("Choose a valid model before starting the local run.".into());
    }
    let prompt = validate_prompt(&request.prompt)?;
    let working_directory = resolve_working_directory(request.working_directory.as_deref())?;
    validate_provider_model(provider, model, managed_home.as_deref())?;
    let command_path = if byok_provider(provider).is_some() {
        PathBuf::from("native-https")
    } else if provider == "lmstudio" {
        PathBuf::from("loopback-http")
    } else {
        resolve_provider_command(provider)
            .ok_or_else(|| format!("{provider} is not installed on this Mac."))?
    };
    let active_run = registry.begin(&run_id)?;
    let cancellation = active_run.token();
    let emitter = RunEventEmitter::new(&run_id, provider, model, channel);
    emitter.emit("queued", "Local run queued", None);
    emitter.emit("started", "Local intelligence started", None);
    let started_at = Instant::now();
    let mut metered_provider_invocation_started = false;

    let execution = match provider {
        "codex" => run_codex(
            &command_path,
            prompt,
            &working_directory,
            PROVIDER_TIMEOUT,
            &cancellation,
            &emitter,
        ),
        "claude" => run_claude(
            &command_path,
            prompt,
            &working_directory,
            PROVIDER_TIMEOUT,
            &cancellation,
            &emitter,
        ),
        "copilot" => managed_home
            .as_deref()
            .ok_or_else(|| "GitHub Copilot's Codelit profile is unavailable.".to_string())
            .and_then(|app_data_dir| {
                run_copilot(
                    &command_path,
                    app_data_dir,
                    prompt,
                    PROVIDER_TIMEOUT,
                    &cancellation,
                    &emitter,
                )
            }),
        "antigravity" => Err(
            "Gemini subscription execution is unavailable because Antigravity cannot isolate provider sign-in from ambient user settings, agents, hooks, plugins, and MCP configuration. Use Gemini API, Codex, Copilot, or a verified local model."
                .into(),
        ),
        "openai" | "anthropic" | "gemini" => run_byok_api(
            provider,
            model,
            prompt,
            PROVIDER_TIMEOUT,
            &cancellation,
            &emitter,
            selection_mode == "auto",
            &mut metered_provider_invocation_started,
        ),
        "ollama" => run_ollama(
            &command_path,
            model,
            prompt,
            &working_directory,
            PROVIDER_TIMEOUT,
            &cancellation,
            &emitter,
        ),
        "lmstudio" => run_lmstudio(
            model,
            prompt,
            PROVIDER_TIMEOUT,
            &cancellation,
            &emitter,
        ),
        "mlx" => run_mlx(
            &command_path,
            model,
            prompt,
            &working_directory,
            managed_home.as_deref(),
            &ExecutionControl {
                timeout: PROVIDER_TIMEOUT,
                cancellation: &cancellation,
                emitter: &emitter,
            },
        ),
        _ => Err("Unsupported local intelligence provider.".into()),
    };

    let mut result = match execution {
        Ok(result) => result,
        Err(detail) => {
            let status = if cancellation.is_canceled() {
                "canceled"
            } else {
                classify_provider_error(&detail, None)
            };
            let failure_text = if provider == "mlx" && status == "failed" {
                let detail = detail.trim();
                if detail.starts_with("The on-device model")
                    || detail
                        .starts_with("Codelit could not finish downloading the on-device model")
                {
                    detail.to_string()
                } else {
                    friendly_provider_status_message(provider_label(provider), status)
                }
            } else {
                friendly_provider_status_message(provider_label(provider), status)
            };
            provider_result(
                provider,
                &command_path,
                status,
                None,
                if status == "canceled" {
                    "The local run was canceled.".into()
                } else {
                    failure_text
                },
                started_at,
                vec![
                    "Only the selected provider was invoked".into(),
                    "No API-key environment inherited".into(),
                ],
            )
        }
    };
    result.run_id = run_id;
    result.model = model.into();
    result.selection_mode = selection_mode.into();
    result.billing_fallback = metered_billing_fallback(
        provider,
        selection_mode,
        metered_provider_invocation_started,
    );
    let event_type = match result.status.as_str() {
        "completed" => "completed",
        "canceled" => "canceled",
        _ => "failed",
    };
    let terminal_message = result
        .structured_output
        .as_ref()
        .and_then(structured_output_summary)
        .unwrap_or(&result.text)
        .to_string();
    emitter.emit(
        event_type,
        terminal_message,
        result.structured_output.clone(),
    );
    Ok(result)
}

fn normalize_run_id(value: Option<&str>) -> Result<String, String> {
    let run_id = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "local-{}-{}",
                chrono::Utc::now().timestamp_millis(),
                RUN_COUNTER.fetch_add(1, Ordering::Relaxed)
            )
        });
    if run_id.len() > 128
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The local run identifier is invalid.".into());
    }
    Ok(run_id)
}

fn normalize_selection_mode(value: Option<&str>) -> Result<&'static str, String> {
    match value.unwrap_or("fixed") {
        "fixed" => Ok("fixed"),
        "auto" => Ok("auto"),
        _ => Err("The provider selection mode is invalid.".into()),
    }
}

fn validate_provider_model(
    provider: &str,
    model: &str,
    app_data_dir: Option<&Path>,
) -> Result<(), String> {
    match provider {
        "codex" | "copilot" | "claude" if model == "default" => Ok(()),
        "openai" | "anthropic" | "gemini" => {
            let provider = byok_provider(provider).ok_or("Unsupported API provider.")?;
            if model == provider.default_model() {
                Ok(())
            } else {
                Err("This API provider currently uses Codelit's reviewed default model.".into())
            }
        }
        "mlx" => {
            let app_data_dir = app_data_dir
                .ok_or("The on-device model directory is unavailable in this build.")?;
            let model = model_manager::probe_model_by_id(app_data_dir, model)?;
            if model.status == "ready" {
                Ok(())
            } else {
                Err(model.detail)
            }
        }
        "ollama" => ollama::preflight_local_model(model, Duration::from_millis(750)).map(|_| ()),
        "lmstudio" => lmstudio::preflight_model(model, Duration::from_millis(750)).map(|_| ()),
        "antigravity" => Err(
            "Google subscription execution is blocked until an approved provider path exists."
                .into(),
        ),
        "codex" | "copilot" | "claude" => Err(
            "This subscription provider currently uses its provider-owned default model.".into(),
        ),
        _ => Err("Unsupported local intelligence provider.".into()),
    }
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "codex" => "Codex",
        "copilot" => "GitHub Copilot",
        "claude" => "Claude Code",
        "ollama" => "Ollama",
        "lmstudio" => "LM Studio",
        "mlx" => "On-device model",
        "openai" => "OpenAI API",
        "anthropic" => "Anthropic API",
        "gemini" => "Gemini API",
        _ => "The provider",
    }
}

fn run_copilot(
    command_path: &Path,
    app_data_dir: &Path,
    prompt: &str,
    timeout: Duration,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
) -> Result<ProviderTaskResult, String> {
    let started_at = Instant::now();
    let mut summary_stream = StructuredSummaryStream::default();
    let result = copilot::run(
        command_path,
        app_data_dir,
        &CopilotRunRequest {
            prompt: prompt.into(),
            model: None,
            limits: CopilotRunLimits {
                timeout,
                ..CopilotRunLimits::default()
            },
        },
        cancellation,
        |progress| match progress {
            CopilotProgress::Thinking => {
                emitter.emit("progress", "GitHub Copilot is thinking", None);
            }
            CopilotProgress::OutputDelta(delta) => summary_stream.push(&delta, emitter),
        },
    )
    .map_err(|error| error.to_string())?;
    summary_stream.finish(&result.reply.summary, emitter);
    let structured_output = serde_json::to_value(&result.reply)
        .map_err(|_| "GitHub Copilot returned an invalid structured response.".to_string())?;
    Ok(provider_result(
        "copilot",
        command_path,
        "completed",
        Some(structured_output),
        result.reply.summary,
        started_at,
        vec![
            "Only GitHub Copilot CLI was invoked".into(),
            "Tools, MCP, file access, shell access, URLs, hooks, extensions, and remote sessions were denied".into(),
            "Authentication and subscription quota remain owned by GitHub".into(),
        ],
    ))
}

#[allow(clippy::too_many_arguments)]
fn run_byok_api(
    provider_id: &str,
    model: &str,
    prompt: &str,
    timeout: Duration,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
    metered_fallback: bool,
    metered_provider_invocation_started: &mut bool,
) -> Result<ProviderTaskResult, String> {
    run_byok_api_with_loader(
        provider_id,
        model,
        prompt,
        timeout,
        cancellation,
        emitter,
        metered_fallback,
        metered_provider_invocation_started,
        |reference| {
            ProviderCredentialStore::default()
                .load(reference)
                .map_err(|error| error.to_string())
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn run_byok_api_with_loader<L>(
    provider_id: &str,
    model: &str,
    prompt: &str,
    timeout: Duration,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
    metered_fallback: bool,
    metered_provider_invocation_started: &mut bool,
    load_credential: L,
) -> Result<ProviderTaskResult, String>
where
    L: FnOnce(&ProviderCredentialRef) -> Result<Option<SecretBytes>, String>,
{
    let provider = byok_provider(provider_id).ok_or("Unsupported API provider.")?;
    let reference =
        ProviderCredentialRef::new(provider, "default").map_err(|error| error.to_string())?;
    let credential = load_credential(&reference)?
        .ok_or_else(|| format!("{} API key is not configured.", provider_label(provider_id)))?;
    let request = ByokApiRequest::new(provider, model, prompt)
        .and_then(|request| request.with_timeout(timeout))
        .map_err(|error| error.to_string())?;
    let response = execute_byok_request(
        &request,
        &credential,
        || cancellation.is_canceled(),
        |event| match event {
            ByokStreamEvent::InvocationStarted => {
                *metered_provider_invocation_started = true;
                emitter.emit(
                    "provider-invocation-started",
                    "Metered provider request started",
                    None,
                );
            }
            ByokStreamEvent::OutputDelta { delta } => {
                emitter.emit("output-delta", delta, None);
            }
        },
    )
    .map_err(|error| error.to_string())?;
    let structured_output = serde_json::to_value(&response.structured_output)
        .map_err(|_| "The API provider returned an invalid structured response.".to_string())?;
    Ok(ProviderTaskResult {
        run_id: String::new(),
        provider: provider_id.into(),
        model: response.model,
        status: "completed".into(),
        structured_output: Some(structured_output),
        text: response.text,
        duration_ms: response.duration_ms,
        command_path: "native-https".into(),
        version: None,
        evidence: byok_selection_evidence(metered_fallback),
        selection_mode: if metered_fallback { "auto" } else { "fixed" }.into(),
        billing_fallback: metered_fallback,
    })
}

fn metered_billing_fallback(
    provider: &str,
    selection_mode: &str,
    metered_provider_invocation_started: bool,
) -> bool {
    byok_provider(provider).is_some()
        && selection_mode == "auto"
        && metered_provider_invocation_started
}

fn byok_selection_evidence(metered_fallback: bool) -> Vec<String> {
    vec![
        if metered_fallback {
            "Auto selected this API provider after the user enabled metered fallback"
        } else {
            "The user explicitly selected this API provider"
        }
        .into(),
        "The API key was read from macOS Keychain and was not added to the process environment"
            .into(),
        if metered_fallback {
            "This request is metered; no ready local or subscription engine was available"
        } else {
            "This request is metered by the selected provider; no provider fallback was used"
        }
        .into(),
    ]
}

fn run_lmstudio(
    model: &str,
    prompt: &str,
    timeout: Duration,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
) -> Result<ProviderTaskResult, String> {
    let started_at = Instant::now();
    let mut summary_stream = StructuredSummaryStream::default();
    let structured_output = lmstudio::generate_structured(
        model,
        prompt,
        timeout,
        || cancellation.is_canceled(),
        |delta| summary_stream.push(delta, emitter),
    )?;
    let summary = structured_output_summary(&structured_output)
        .ok_or("LM Studio returned an invalid structured response.")?
        .to_string();
    summary_stream.finish(&summary, emitter);
    Ok(ProviderTaskResult {
        run_id: String::new(),
        provider: "lmstudio".into(),
        model: model.into(),
        status: "completed".into(),
        structured_output: Some(structured_output),
        text: summary,
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        command_path: "http://127.0.0.1:1234".into(),
        version: None,
        evidence: vec![
            "Only LM Studio's fixed 127.0.0.1:1234 local server was contacted".into(),
            "The selected model was revalidated locally before the prompt was sent".into(),
            "No API key, Authorization header, tools, MCP, or persisted server session was used"
                .into(),
        ],
        selection_mode: "fixed".into(),
        billing_fallback: false,
    })
}

fn validate_prompt(prompt: &str) -> Result<&str, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Enter a task before running the provider.".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(format!(
            "Provider tasks are limited to {MAX_PROMPT_CHARS} characters in this build."
        ));
    }
    Ok(prompt)
}

fn resolve_working_directory(value: Option<&str>) -> Result<PathBuf, String> {
    let candidate = value
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("The selected working folder is unavailable: {error}"))?;
    if !canonical.is_dir() {
        return Err("The selected working folder is not a directory.".into());
    }
    Ok(canonical)
}

fn configure_provider_environment(command: &mut Command, command_path: &Path) {
    let mut path_entries = vec![
        command_path
            .parent()
            .unwrap_or_else(|| Path::new("/usr/bin"))
            .to_path_buf(),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    path_entries.dedup();
    let path = env::join_paths(path_entries).unwrap_or_else(|_| "/usr/bin:/bin".into());

    command
        .env_clear()
        .env("PATH", path)
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .env("LANG", "en_US.UTF-8");
    for key in ["HOME", "USER", "LOGNAME", "TMPDIR"] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
}

fn provider_result(
    provider: &str,
    command_path: &Path,
    status: &str,
    structured_output: Option<Value>,
    text: String,
    started_at: Instant,
    evidence: Vec<String>,
) -> ProviderTaskResult {
    ProviderTaskResult {
        run_id: String::new(),
        provider: provider.into(),
        model: "default".into(),
        status: status.into(),
        structured_output,
        text: truncate(&text, 1_200),
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        command_path: command_path.to_string_lossy().into_owned(),
        version: read_version(command_path).ok(),
        evidence,
        selection_mode: "fixed".into(),
        billing_fallback: false,
    }
}

fn run_claude(
    command_path: &Path,
    prompt: &str,
    working_directory: &Path,
    timeout: Duration,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
) -> Result<ProviderTaskResult, String> {
    let started_at = Instant::now();
    let mut summary_stream = StructuredSummaryStream::default();
    let schema = serde_json::to_string(&output_schema()).map_err(|error| error.to_string())?;
    let mut command = Command::new(command_path);
    command
        .args([
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--json-schema",
            &schema,
            "--permission-mode",
            "plan",
            "--tools",
            "",
            "--safe-mode",
            "--no-chrome",
            "--no-session-persistence",
        ])
        .current_dir(working_directory)
        .stdin(Stdio::null());
    configure_provider_environment(&mut command, command_path);

    let mut payloads = Vec::new();
    let output = run_line_process(command, timeout, cancellation, |stream, line| {
        if stream != OutputStream::Stdout {
            return;
        }
        let Ok(payload) = serde_json::from_str::<Value>(line.trim()) else {
            return;
        };
        if let Some(delta) = claude_stream_delta(&payload) {
            summary_stream.push(delta, emitter);
        }
        payloads.push(payload);
    })?;
    let payload = payloads
        .iter()
        .rev()
        .find(|payload| payload.get("type").and_then(Value::as_str) == Some("result"))
        .or_else(|| payloads.last())
        .ok_or_else(|| {
            format!(
                "Claude Code returned no structured events. {}",
                truncate(&output.stderr, 400)
            )
        })?;
    let message = payload
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("Claude Code did not return a result.")
        .to_string();
    let is_error = payload
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(!output.status.success());
    if is_error || !output.status.success() {
        let status = classify_provider_error(&message, payload.get("api_error_status"));
        return Ok(provider_result(
            "claude",
            command_path,
            status,
            None,
            message,
            started_at,
            vec![
                "Claude Code owned authentication".into(),
                "Plan permission mode; built-in tools disabled".into(),
                "No API-key environment inherited".into(),
            ],
        ));
    }

    let structured_output = payload
        .get("structured_output")
        .cloned()
        .or_else(|| serde_json::from_str::<Value>(&message).ok())
        .filter(is_valid_structured_output)
        .ok_or_else(|| {
            "Claude Code completed without the required structured output.".to_string()
        })?;
    let summary = structured_output_summary(&structured_output)
        .ok_or("Claude Code completed without a summary.")?
        .to_string();
    summary_stream.finish(&summary, emitter);
    Ok(provider_result(
        "claude",
        command_path,
        "completed",
        Some(structured_output),
        summary,
        started_at,
        vec![
            "Claude Code owned authentication".into(),
            "JSON Schema output validated".into(),
            "Plan permission mode; built-in tools disabled".into(),
            "No API-key environment inherited".into(),
        ],
    ))
}

fn claude_stream_delta(payload: &Value) -> Option<&str> {
    if payload.get("type").and_then(Value::as_str) != Some("stream_event") {
        return None;
    }
    let event = payload.get("event")?;
    if event.get("type").and_then(Value::as_str) != Some("content_block_delta") {
        return None;
    }
    event.pointer("/delta/text").and_then(Value::as_str)
}

fn run_mlx(
    command_path: &Path,
    model_id: &str,
    prompt: &str,
    working_directory: &Path,
    managed_home: Option<&Path>,
    control: &ExecutionControl<'_>,
) -> Result<ProviderTaskResult, String> {
    let started_at = Instant::now();
    let mut summary_stream = StructuredSummaryStream::default();
    let model = model_manager::manifest_entry(model_id)?;
    let mut command = Command::new(command_path);
    command
        .args([
            "--model",
            model_id,
            "--revision",
            &model.revision,
            "--prompt",
            prompt,
        ])
        .current_dir(working_directory)
        .stdin(Stdio::null());
    configure_provider_environment(&mut command, command_path);
    if let Some(managed_home) = managed_home {
        configure_mlx_managed_home(&mut command, managed_home)?;
    }

    let output = run_line_process_guarded(
        command,
        control.timeout,
        control.cancellation,
        |stream, line| {
            if stream == OutputStream::Stderr {
                let message = line.trim();
                if let Some(delta) = mlx_stream_delta(message) {
                    summary_stream.push(&delta, control.emitter);
                } else if message.starts_with("Loading ") || message.starts_with("Model download ")
                {
                    control.emitter.emit("message", message, None);
                }
            }
        },
        || system_resources::ensure_mlx_allowed(MlxOperation::Inference),
    )?;
    let body = output.stdout.trim();
    if !output.status.success() {
        return Err(friendly_mlx_error(&output.stderr));
    }
    let structured_output = serde_json::from_str::<Value>(body)
        .ok()
        .filter(is_valid_structured_output)
        .ok_or_else(|| {
            "The on-device model completed without valid structured output.".to_string()
        })?;
    let summary = structured_output_summary(&structured_output)
        .ok_or("The on-device model completed without a summary.")?
        .to_string();
    summary_stream.finish(&summary, control.emitter);

    Ok(provider_result(
        "mlx",
        command_path,
        "completed",
        Some(structured_output),
        summary,
        started_at,
        vec![
            "Inference completed on this Mac".into(),
            "Validated JSON output".into(),
            "No API-key environment inherited".into(),
        ],
    ))
}

fn mlx_stream_delta(line: &str) -> Option<String> {
    let payload = line.strip_prefix("Codelit stream ")?;
    let delta = serde_json::from_str::<String>(payload).ok()?;
    (!delta.is_empty() && delta.chars().count() <= 8_000).then_some(delta)
}

fn run_ollama(
    command_path: &Path,
    model: &str,
    prompt: &str,
    _working_directory: &Path,
    timeout: Duration,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
) -> Result<ProviderTaskResult, String> {
    let started_at = Instant::now();
    let mut summary_stream = StructuredSummaryStream::default();
    let structured_output = ollama::generate_structured(
        model,
        prompt,
        &output_schema(),
        timeout,
        cancellation,
        |chunk| {
            summary_stream.push(chunk, emitter);
        },
    )?;
    if !is_valid_structured_output(&structured_output) {
        return Err("Ollama completed without the required structured output.".into());
    }
    let text = structured_output
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("Ollama completed the local task.")
        .to_string();
    summary_stream.finish(&text, emitter);
    Ok(provider_result(
        "ollama",
        command_path,
        "completed",
        Some(structured_output),
        text,
        started_at,
        vec![
            "Local Ollama API restricted to 127.0.0.1".into(),
            "Selected installed model used without provider fallback".into(),
            "No API-key environment inherited".into(),
        ],
    ))
}

fn friendly_mlx_error(detail: &str) -> String {
    let normalized = detail.to_ascii_lowercase();
    if normalized.contains("operation not permitted") || normalized.contains("authorization denied")
    {
        "The on-device model could not access its local cache. Reopen Codelit or reset the local model."
            .into()
    } else if normalized.contains("required json shape")
        || normalized.contains("valid structured output")
    {
        "The on-device model returned an unexpected response. Retry once or choose another local model."
            .into()
    } else if normalized.contains("network")
        || normalized.contains("download")
        || normalized.contains("connection")
    {
        "Codelit could not finish downloading the on-device model. Check the connection and retry."
            .into()
    } else {
        "The on-device model did not complete. Retry or choose another provider.".into()
    }
}

fn configure_mlx_managed_home(command: &mut Command, app_data_dir: &Path) -> Result<(), String> {
    let runtime_home = app_data_dir.join("runtime/mlx");
    let cache_home = runtime_home.join("Library/Caches");
    let model_home = app_data_dir.join("models/huggingface");
    let temporary_home = runtime_home.join("tmp");
    for directory in [&runtime_home, &cache_home, &model_home, &temporary_home] {
        std::fs::create_dir_all(directory)
            .map_err(|error| format!("Could not prepare the on-device model directory: {error}"))?;
    }
    command
        .env("HOME", &runtime_home)
        .env("CFFIXED_USER_HOME", &runtime_home)
        .env("APP_SANDBOX_CONTAINER_ID", "io.codelit.desktop")
        .env("HF_HOME", &model_home)
        .env("XDG_CACHE_HOME", &cache_home)
        .env("TMPDIR", &temporary_home);
    Ok(())
}

fn run_codex(
    command_path: &Path,
    prompt: &str,
    working_directory: &Path,
    timeout: Duration,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
) -> Result<ProviderTaskResult, String> {
    let started_at = Instant::now();
    let mut command = Command::new(command_path);
    command
        .args(["app-server", "--stdio"])
        .current_dir(working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_provider_environment(&mut command, command_path);
    configure_process_group(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Codex app-server: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Codex stdin was unavailable.")?;
    let stdout = child.stdout.take().ok_or("Codex stdout was unavailable.")?;
    let stderr = child.stderr.take().ok_or("Codex stderr was unavailable.")?;
    let (line_sender, line_receiver) = mpsc::channel();
    let stdout_thread = capture_codex_stdout(stdout, line_sender);
    let stderr_thread = thread::spawn(move || drain_reader(stderr));
    let deadline = started_at + timeout;

    let result = (|| {
        write_json_line(
            &mut stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "codelit-mac",
                        "title": "Codelit",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {}
                }
            }),
        )?;
        read_response(&line_receiver, 1, deadline, cancellation)?;
        write_json_line(&mut stdin, &json!({ "method": "initialized" }))?;
        write_json_line(
            &mut stdin,
            &json!({
                "id": 2,
                "method": "thread/start",
                "params": {
                    "cwd": working_directory.to_string_lossy(),
                    "ephemeral": true,
                    "sandbox": "read-only",
                    "approvalPolicy": "never",
                    "personality": "none",
                    "developerInstructions": "Return only the requested JSON. Do not modify files, invoke tools, or request permissions."
                }
            }),
        )?;
        let thread_response = read_response(&line_receiver, 2, deadline, cancellation)?;
        let thread_id = thread_response
            .pointer("/result/thread/id")
            .and_then(Value::as_str)
            .ok_or("Codex thread/start did not return a thread ID.")?;
        write_json_line(
            &mut stdin,
            &json!({
                "id": 3,
                "method": "turn/start",
                "params": {
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": prompt }],
                    "summary": "concise",
                    "outputSchema": output_schema()
                }
            }),
        )?;
        read_response(&line_receiver, 3, deadline, cancellation)?;
        emitter.emit("progress", "Codex is thinking", None);
        read_codex_turn(&line_receiver, deadline, cancellation, emitter)
    })();

    drop(stdin);
    stop_child_tree(&mut child);
    let _ = stdout_thread.join();
    let stderr = stderr_thread.join().unwrap_or_default();
    let agent_text = match result {
        Ok(agent_text) => agent_text,
        Err(error) => {
            if cancellation.is_canceled() {
                return Err("Provider task was canceled.".into());
            }
            let detail = if stderr.trim().is_empty() {
                error
            } else {
                format!("{error} {}", truncate(&stderr, 400))
            };
            let status = classify_provider_error(&detail, None);
            return Ok(provider_result(
                "codex",
                command_path,
                status,
                None,
                friendly_provider_status_message("Codex", status),
                started_at,
                vec![
                    "Codex app-server owned authentication".into(),
                    "Ephemeral thread with read-only sandbox".into(),
                    "No provider credentials read or copied".into(),
                ],
            ));
        }
    };
    let structured_output = serde_json::from_str::<Value>(agent_text.trim())
        .ok()
        .filter(is_valid_structured_output)
        .ok_or_else(|| "Codex completed without the required structured output.".to_string())?;
    let summary = structured_output_summary(&structured_output)
        .ok_or("Codex completed without a summary.")?
        .to_string();

    Ok(provider_result(
        "codex",
        command_path,
        "completed",
        Some(structured_output),
        summary,
        started_at,
        vec![
            "Codex app-server owned authentication".into(),
            "Ephemeral thread with read-only sandbox".into(),
            "Approval policy set to never".into(),
            "JSON Schema output validated".into(),
            "No API-key environment inherited".into(),
        ],
    ))
}

fn capture_codex_stdout(
    reader: impl Read + Send + 'static,
    sender: mpsc::Sender<Result<String, String>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::with_capacity(CODEX_STDOUT_READ_BUFFER_BYTES, reader);
        let mut line_bytes = Vec::with_capacity(MAX_CODEX_STDOUT_LINE_BYTES);
        loop {
            let buffer = match reader.fill_buf() {
                Ok(buffer) => buffer,
                Err(error) => {
                    let _ = sender.send(Err(format!(
                        "Codex app-server stdout could not be read: {error}"
                    )));
                    return;
                }
            };
            if buffer.is_empty() {
                break;
            }

            let consumed = if let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
                if newline > MAX_CODEX_STDOUT_LINE_BYTES.saturating_sub(line_bytes.len()) {
                    send_codex_stdout_overflow(&sender);
                    return;
                }
                line_bytes.extend_from_slice(&buffer[..newline]);
                if !send_codex_stdout_line(&sender, &line_bytes) {
                    return;
                }
                line_bytes.clear();
                newline + 1
            } else {
                if buffer.len() > MAX_CODEX_STDOUT_LINE_BYTES.saturating_sub(line_bytes.len()) {
                    send_codex_stdout_overflow(&sender);
                    return;
                }
                line_bytes.extend_from_slice(buffer);
                buffer.len()
            };
            reader.consume(consumed);
        }

        if !line_bytes.is_empty() {
            let _ = send_codex_stdout_line(&sender, &line_bytes);
        }
    })
}

fn send_codex_stdout_line(
    sender: &mpsc::Sender<Result<String, String>>,
    line_bytes: &[u8],
) -> bool {
    let line_bytes = line_bytes.strip_suffix(b"\r").unwrap_or(line_bytes);
    let line = String::from_utf8(line_bytes.to_vec())
        .map_err(|_| "Codex app-server stdout was not valid UTF-8.".to_string());
    let is_valid = line.is_ok();
    sender.send(line).is_ok() && is_valid
}

fn send_codex_stdout_overflow(sender: &mpsc::Sender<Result<String, String>>) {
    let _ = sender.send(Err(format!(
        "Codex app-server stdout emitted a line larger than {MAX_CODEX_STDOUT_LINE_BYTES} bytes and was stopped."
    )));
}

fn write_json_line(writer: &mut impl Write, payload: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, payload).map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn read_response(
    receiver: &Receiver<Result<String, String>>,
    id: u64,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<Value, String> {
    loop {
        let message = read_codex_message(receiver, deadline, cancellation)?;
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            if message.get("id").is_some() && message.get("method").is_some() {
                return Err("Codex requested an action during a read-only health check.".into());
            }
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(format!("Codex request failed: {}", compact_json(error)));
        }
        return Ok(message);
    }
}

fn read_codex_turn(
    receiver: &Receiver<Result<String, String>>,
    deadline: Instant,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
) -> Result<String, String> {
    let mut agent_text = None;
    let mut summary_stream = StructuredSummaryStream::default();
    let mut reasoning_summary_index = None;
    let mut reasoning_chars = 0;
    loop {
        let message = read_codex_message(receiver, deadline, cancellation)?;
        if message.get("id").is_some() && message.get("method").is_some() {
            return Err("Codex requested approval during a read-only health check.".into());
        }
        match message.get("method").and_then(Value::as_str) {
            Some("item/agentMessage/delta") => {
                if let Some(delta) = message
                    .pointer("/params/delta")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    summary_stream.push(delta, emitter);
                }
            }
            Some("item/reasoning/summaryTextDelta") => {
                if let Some(delta) = message
                    .pointer("/params/delta")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    if reasoning_chars >= MAX_STREAMED_REASONING_CHARS {
                        continue;
                    }
                    let index = message
                        .pointer("/params/summaryIndex")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    if reasoning_summary_index.is_some_and(|previous| previous != index) {
                        emitter.emit("reasoning-delta", "\n", None);
                        reasoning_chars += 1;
                    }
                    reasoning_summary_index = Some(index);
                    let bounded = delta
                        .chars()
                        .take(MAX_STREAMED_REASONING_CHARS.saturating_sub(reasoning_chars))
                        .collect::<String>();
                    reasoning_chars += bounded.chars().count();
                    if !bounded.is_empty() {
                        emitter.emit("reasoning-delta", bounded, None);
                    }
                }
            }
            Some("item/completed") => {
                let item = message.pointer("/params/item");
                if item
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                    == Some("agentMessage")
                {
                    agent_text = item
                        .and_then(|value| value.get("text"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
            }
            Some("turn/completed") => {
                let status = message
                    .pointer("/params/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                if status != "completed" {
                    let detail = message
                        .pointer("/params/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex did not complete the structured task.");
                    return Err(detail.into());
                }
                let agent_text = agent_text
                    .ok_or_else(|| "Codex completed without an agent message.".to_string())?;
                if let Some(summary) = serde_json::from_str::<Value>(agent_text.trim())
                    .ok()
                    .filter(is_valid_structured_output)
                    .as_ref()
                    .and_then(structured_output_summary)
                {
                    summary_stream.finish(summary, emitter);
                }
                return Ok(agent_text);
            }
            Some("error") => {
                if message
                    .pointer("/params/willRetry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    emitter.emit("progress", "Codex is reconnecting", None);
                    continue;
                }
                return Err(codex_error_detail(&message));
            }
            _ => {}
        }
    }
}

fn codex_error_detail(message: &Value) -> String {
    let detail = message
        .pointer("/params/error/message")
        .or_else(|| message.pointer("/params/error/additionalDetails"))
        .or_else(|| message.pointer("/params/message"))
        .and_then(Value::as_str)
        .unwrap_or("Codex reported a provider error.");
    let status = message
        .pointer("/params/error/codexErrorInfo/responseStreamDisconnected/httpStatusCode")
        .and_then(Value::as_u64)
        .map(|status| format!(" HTTP {status}"))
        .unwrap_or_default();
    truncate(&format!("{detail}{status}"), 500)
}

fn read_codex_message(
    receiver: &Receiver<Result<String, String>>,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<Value, String> {
    let line = wait_for_message(
        receiver,
        deadline,
        cancellation,
        "Codex structured task timed out.",
    )?;
    serde_json::from_str(&line).map_err(|error| format!("Codex returned invalid JSON: {error}"))
}

fn is_valid_structured_output(value: &Value) -> bool {
    let Some(summary) = structured_output_summary(value) else {
        return false;
    };
    let Some(items) = value.get("items").and_then(Value::as_array) else {
        return false;
    };
    if items.len() > MAX_STRUCTURED_ITEMS {
        return false;
    }
    let mut formatted_bytes = summary.trim().len();
    for item in items {
        let Some(item) = item.as_str() else {
            return false;
        };
        if item.len() > MAX_STRUCTURED_ITEM_BYTES {
            return false;
        }
        let item = item.trim();
        if item.is_empty() {
            return false;
        }
        formatted_bytes = formatted_bytes.saturating_add(3 + item.len());
    }
    formatted_bytes <= MAX_FORMATTED_ANSWER_BYTES
}

fn structured_output_summary(value: &Value) -> Option<&str> {
    value
        .get("summary")
        .and_then(Value::as_str)
        .filter(|summary| {
            !summary.trim().is_empty() && summary.len() <= MAX_STRUCTURED_SUMMARY_BYTES
        })
}

fn classify_provider_error(message: &str, status: Option<&Value>) -> &'static str {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("thermal pressure") {
        "resource-paused"
    } else if normalized.contains("disabled") || normalized.contains("policy") {
        "blocked-by-policy"
    } else if normalized.contains("sign in")
        || normalized.contains("login")
        || normalized.contains("authentication")
        || normalized.contains("missing bearer")
        || (normalized.contains("api key")
            && (normalized.contains("not configured") || normalized.contains("rejected")))
        || normalized.contains("unauthorized")
        || normalized.contains("401")
        || status.and_then(Value::as_u64) == Some(401)
    {
        "signed-out"
    } else if normalized.contains("quota")
        || normalized.contains("rate limit")
        || status.and_then(Value::as_u64) == Some(429)
    {
        "quota-hit"
    } else {
        "failed"
    }
}

fn friendly_provider_status_message(provider: &str, status: &str) -> String {
    match status {
        "signed-out" => format!(
            "{provider} could not use the current provider sign-in. Open {provider}, sign in, then retry."
        ),
        "quota-hit" => format!(
            "{provider} has reached its current usage limit. Retry when the provider quota resets."
        ),
        "blocked-by-policy" => format!(
            "{provider} is installed, but the provider policy blocked this read-only check."
        ),
        "resource-paused" => format!(
            "{provider} paused because this Mac is under thermal pressure. Let it cool, then retry."
        ),
        _ if provider == "On-device model" =>
            "The on-device model could not complete this request. Retry, or choose another ready engine in Settings."
                .into(),
        _ => format!(
            "{provider} could not complete this request. Open {provider} to confirm it is ready, then retry."
        ),
    }
}

fn drain_reader(mut reader: impl Read) -> String {
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = MAX_CAPTURE_BYTES.saturating_sub(captured.len());
                captured.extend_from_slice(&buffer[..read.min(remaining)]);
            }
        }
    }
    String::from_utf8_lossy(&captured).into_owned()
}

fn compact_json(value: &Value) -> String {
    truncate(
        &serde_json::to_string(value).unwrap_or_else(|_| "unknown error".into()),
        500,
    )
}

fn truncate(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(limit).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

    fn executable_script(body: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("provider");
        fs::write(&executable, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut permissions = fs::metadata(&executable).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).expect("permissions");
        (directory, executable)
    }

    fn recording_emitter(
        run_id: &str,
        provider: &str,
        model: &str,
    ) -> (RunEventEmitter, Arc<Mutex<Vec<ProviderRunEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let emitter = RunEventEmitter::new(run_id, provider, model, None).with_observer(Arc::new(
            move |event| recorded.lock().expect("event lock").push(event),
        ));
        (emitter, events)
    }

    #[test]
    fn structured_summary_stream_decodes_escapes_without_leaking_items() {
        let (emitter, events) = recording_emitter("summary-stream", "codex", "default");
        let mut stream = StructuredSummaryStream::default();
        stream.push(r#"{"summary":"A natural \"answer\" on line\n"#, &emitter);
        stream.push(r#"two with \uD83D"#, &emitter);
        stream.push(r#"\uDE80","items":["private item"]}"#, &emitter);

        let output = events
            .lock()
            .expect("event lock")
            .iter()
            .filter(|event| event.event_type == "output-delta")
            .map(|event| event.message.as_str())
            .collect::<String>();
        assert_eq!(output, "A natural \"answer\" on line\ntwo with 🚀");
        assert!(!output.contains("private item"));
    }

    #[test]
    fn structured_summary_stream_is_bounded_and_finds_a_later_summary_key() {
        assert_eq!(
            streamed_summary_prefix(r#"{"items":[],"summary":"later"}"#),
            Some("later".into())
        );
        let (emitter, events) = recording_emitter("bounded-stream", "codex", "default");
        let mut stream = StructuredSummaryStream::default();
        stream.push(&"x".repeat(MAX_STREAMED_STRUCTURED_BYTES + 500), &emitter);
        stream.push(r#"{"summary":"must not be appended","items":[]}"#, &emitter);
        assert_eq!(stream.raw.len(), MAX_STREAMED_STRUCTURED_BYTES);
        assert!(events.lock().expect("event lock").is_empty());
    }

    #[test]
    fn structured_output_contract_matches_utf8_persistence_limits() {
        let schema = output_schema();
        assert_eq!(
            schema.pointer("/properties/summary/maxLength"),
            Some(&json!(MAX_STRUCTURED_SUMMARY_BYTES))
        );
        assert_eq!(
            schema.pointer("/properties/items/maxItems"),
            Some(&json!(MAX_STRUCTURED_ITEMS))
        );
        assert_eq!(
            schema.pointer("/properties/items/items/maxLength"),
            Some(&json!(MAX_STRUCTURED_ITEM_BYTES))
        );

        let largest_ascii = json!({
            "summary": "s".repeat(MAX_STRUCTURED_SUMMARY_BYTES),
            "items": vec!["i".repeat(MAX_STRUCTURED_ITEM_BYTES); MAX_STRUCTURED_ITEMS]
        });
        assert!(is_valid_structured_output(&largest_ascii));

        let multibyte_overflow = json!({
            "summary": "🚀".repeat(MAX_STRUCTURED_SUMMARY_BYTES / 4 + 1),
            "items": []
        });
        assert!(!is_valid_structured_output(&multibyte_overflow));
        assert!(!is_valid_structured_output(&json!({
            "summary": "ready",
            "items": vec!["item"; MAX_STRUCTURED_ITEMS + 1]
        })));
        assert!(!is_valid_structured_output(&json!({
            "summary": "ready",
            "items": ["i".repeat(MAX_STRUCTURED_ITEM_BYTES + 1)]
        })));
        assert!(!is_valid_structured_output(&json!({
            "summary": "ready",
            "items": ["é".repeat(MAX_STRUCTURED_ITEM_BYTES / 2 + 1)]
        })));
    }

    #[test]
    fn claude_policy_error_is_typed_without_exposing_raw_payload() {
        let (directory, executable) = executable_script(
            r#"printf '%s\n' '{"type":"result","is_error":true,"api_error_status":403,"result":"Subscription access disabled by policy"}'"#,
        );
        let registry = RunRegistry::default();
        let run = registry.begin("claude-policy").expect("start run");
        let emitter = RunEventEmitter::new("claude-policy", "claude", "default", None);
        let result = run_claude(
            &executable,
            "health check",
            directory.path(),
            Duration::from_secs(2),
            &run.token(),
            &emitter,
        )
        .expect("typed result");
        assert_eq!(result.status, "blocked-by-policy");
        assert!(result.structured_output.is_none());
    }

    #[test]
    fn provider_transport_failures_become_safe_typed_messages() {
        let detail = "websocket failed: HTTP 401 Unauthorized token=secret";
        let status = classify_provider_error(detail, None);
        let message = friendly_provider_status_message("Codex", status);
        assert_eq!(status, "signed-out");
        assert!(message.contains("sign in"));
        assert!(!message.contains("secret"));
        assert!(!message.contains("websocket"));
        assert_eq!(
            classify_provider_error("rate limit reached", None),
            "quota-hit"
        );
    }

    #[test]
    fn claude_stream_contract_emits_natural_output_and_validates_the_result() {
        let (directory, executable) = executable_script(
            r#"printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"working"}}}'
printf '%s\n' '{"type":"result","is_error":false,"result":"done","structured_output":{"summary":"provider ready","items":["read-only"]}}'"#,
        );
        let registry = RunRegistry::default();
        let run = registry.begin("claude-stream").expect("start run");
        let (emitter, events) = recording_emitter("claude-stream", "claude", "default");
        let result = run_claude(
            &executable,
            "health check",
            directory.path(),
            Duration::from_secs(2),
            &run.token(),
            &emitter,
        )
        .expect("streamed result");
        assert_eq!(result.status, "completed");
        assert_eq!(result.text, "provider ready");
        assert!(events.lock().expect("event lock").iter().any(|event| {
            event.event_type == "output-delta" && event.message == "provider ready"
        }));
    }

    #[test]
    fn codex_app_server_contract_streams_reasoning_and_natural_output() {
        let script = r#"
count=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> requests.log
  count=$((count + 1))
  case "$count" in
    1) printf '%s\n' '{"id":1,"result":{"userAgent":"test"}}' ;;
    3) printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-test"}}}' ;;
    4)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-test"}}}'
      printf '%s\n' '{"method":"item/reasoning/summaryTextDelta","params":{"delta":"Checking approved evidence","summaryIndex":0}}'
      printf '%s\n' '{"method":"item/reasoning/textDelta","params":{"delta":"hidden chain of thought","contentIndex":0}}'
      printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"{\"summary\":\"provider "}}'
      printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"ready\",\"items\":[\"read-only\"]}"}}'
      printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"item-test","text":"{\"summary\":\"provider ready\",\"items\":[\"read-only\"]}"}}}'
      printf '%s\n' '{"method":"turn/completed","params":{"turn":{"id":"turn-test","items":[],"status":"completed"}}}'
      ;;
  esac
done
"#;
        let (directory, executable) = executable_script(script);
        let registry = RunRegistry::default();
        let run = registry.begin("codex-contract").expect("start run");
        let (emitter, events) = recording_emitter("codex-contract", "codex", "default");
        let result = run_codex(
            &executable,
            "health check",
            directory.path(),
            Duration::from_secs(2),
            &run.token(),
            &emitter,
        )
        .expect("structured result");
        assert_eq!(result.status, "completed");
        assert_eq!(result.text, "provider ready");
        assert_eq!(
            result
                .structured_output
                .as_ref()
                .and_then(|value| value.get("summary"))
                .and_then(Value::as_str),
            Some("provider ready")
        );
        let events = events.lock().expect("event lock");
        let output = events
            .iter()
            .filter(|event| event.event_type == "output-delta")
            .map(|event| event.message.as_str())
            .collect::<String>();
        let reasoning = events
            .iter()
            .filter(|event| event.event_type == "reasoning-delta")
            .map(|event| event.message.as_str())
            .collect::<String>();
        assert_eq!(output, "provider ready");
        assert_eq!(reasoning, "Checking approved evidence");
        assert!(
            !events
                .iter()
                .any(|event| event.message.contains("hidden chain"))
        );
        assert!(!output.contains("read-only"));
        drop(events);
        let request_log = fs::read_to_string(directory.path().join("requests.log"))
            .expect("captured Codex app-server requests");
        assert!(request_log.contains("\"name\":\"codelit-mac\""));
        assert!(request_log.contains("\"title\":\"Codelit\""));
        assert!(request_log.contains(env!("CARGO_PKG_VERSION")));
        assert!(request_log.contains("\"summary\":\"concise\""));
    }

    #[test]
    fn bounded_codex_stdout_reader_reports_explicit_overflow() {
        let (sender, receiver) = mpsc::channel();
        let capture =
            capture_codex_stdout(std::io::Cursor::new(vec![b'x'; 8 * 1024 * 1024]), sender);
        let error = receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("bounded reader response")
            .expect_err("oversized Codex stdout line");

        assert!(error.contains("Codex app-server stdout"));
        assert!(error.contains(&MAX_CODEX_STDOUT_LINE_BYTES.to_string()));
        capture.join().expect("capture thread");
    }

    #[test]
    fn codex_app_server_stops_on_multi_megabyte_newline_free_stdout() {
        let script = r#"
if [ "$1" = "--version" ]; then
  printf '%s\n' 'Codex test'
  exit 0
fi
/usr/bin/yes x | /usr/bin/tr -d '\n' | /usr/bin/head -c 8388608
/bin/sleep 30
"#;
        let (directory, executable) = executable_script(script);
        let registry = RunRegistry::default();
        let run = registry.begin("codex-stdout-overflow").expect("start run");
        let emitter = RunEventEmitter::new("codex-stdout-overflow", "codex", "default", None);
        let started = Instant::now();
        let result = run_codex(
            &executable,
            "health check",
            directory.path(),
            Duration::from_secs(5),
            &run.token(),
            &emitter,
        )
        .expect("typed overflow result");

        assert_eq!(result.status, "failed");
        assert!(result.structured_output.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn codex_reconnect_event_is_not_treated_as_a_final_failure() {
        let script = r#"
count=0
while IFS= read -r line; do
  count=$((count + 1))
  case "$count" in
    1) printf '%s\n' '{"id":1,"result":{"userAgent":"test"}}' ;;
    3) printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-test"}}}' ;;
    4)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-test"}}}'
      printf '%s\n' '{"method":"error","params":{"error":{"message":"Reconnecting... 1/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":503}}},"willRetry":true}}'
      printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"item-test","text":"{\"summary\":\"provider ready\",\"items\":[\"read-only\"]}"}}}'
      printf '%s\n' '{"method":"turn/completed","params":{"turn":{"id":"turn-test","items":[],"status":"completed"}}}'
      ;;
  esac
done
"#;
        let (directory, executable) = executable_script(script);
        let registry = RunRegistry::default();
        let run = registry.begin("codex-reconnect").expect("start run");
        let (emitter, events) = recording_emitter("codex-reconnect", "codex", "default");
        let result = run_codex(
            &executable,
            "health check",
            directory.path(),
            Duration::from_secs(2),
            &run.token(),
            &emitter,
        )
        .expect("recovered result");
        assert_eq!(result.status, "completed");
        assert!(events.lock().expect("event lock").iter().any(|event| {
            event.event_type == "progress" && event.message == "Codex is reconnecting"
        }));
    }

    #[test]
    fn codex_final_unauthorized_error_becomes_a_sign_in_state() {
        let script = r#"
count=0
while IFS= read -r line; do
  count=$((count + 1))
  case "$count" in
    1) printf '%s\n' '{"id":1,"result":{"userAgent":"test"}}' ;;
    3) printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-test"}}}' ;;
    4)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-test"}}}'
      printf '%s\n' '{"method":"error","params":{"error":{"message":"Missing bearer authentication","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}}},"willRetry":false}}'
      ;;
  esac
done
"#;
        let (directory, executable) = executable_script(script);
        let registry = RunRegistry::default();
        let run = registry.begin("codex-signed-out").expect("start run");
        let emitter = RunEventEmitter::new("codex-signed-out", "codex", "default", None);
        let result = run_codex(
            &executable,
            "health check",
            directory.path(),
            Duration::from_secs(2),
            &run.token(),
            &emitter,
        )
        .expect("typed result");
        assert_eq!(result.status, "signed-out");
        assert!(result.text.contains("sign in"));
        assert!(!result.text.contains("bearer"));
    }

    #[test]
    fn mlx_helper_contract_returns_validated_json() {
        let (directory, executable) = executable_script(
            r#"if [ "$1" = "--version" ]; then
  printf '%s\n' 'Codelit MLX helper test'
else
  printf '%s\n' '{"summary":"provider ready","items":["read-only"]}'
fi"#,
        );
        let registry = RunRegistry::default();
        let run = registry.begin("mlx-contract").expect("start run");
        let emitter =
            RunEventEmitter::new("mlx-contract", "mlx", "mlx-community/Qwen3-0.6B-4bit", None);
        let result = run_mlx(
            &executable,
            "mlx-community/Qwen3-0.6B-4bit",
            "health check",
            directory.path(),
            Some(&directory.path().join("managed-runtime")),
            &ExecutionControl {
                timeout: Duration::from_secs(2),
                cancellation: &run.token(),
                emitter: &emitter,
            },
        )
        .expect("structured result");
        assert_eq!(result.status, "completed");
        assert_eq!(result.version.as_deref(), Some("Codelit MLX helper test"));
        assert_eq!(
            result
                .structured_output
                .as_ref()
                .and_then(|value| value.get("summary"))
                .and_then(Value::as_str),
            Some("provider ready")
        );
    }

    #[test]
    fn mlx_failures_are_actionable_without_exposing_raw_runtime_logs() {
        let raw = "NetworkStorageDB failed: Operation not permitted /private/secret/cache";
        let message = friendly_mlx_error(raw);
        assert!(message.contains("local cache"));
        assert!(!message.contains("/private/secret"));

        let raw = "The local model did not return the required JSON shape: <think>details</think>";
        let message = friendly_mlx_error(raw);
        assert!(message.contains("unexpected response"));
        assert!(!message.contains("<think>"));

        let status = classify_provider_error(
            "The on-device model paused because this Mac is under thermal pressure.",
            None,
        );
        assert_eq!(status, "resource-paused");
        assert!(
            friendly_provider_status_message("On-device model", status).contains("Let it cool")
        );
        let generic = friendly_provider_status_message("On-device model", "failed");
        assert!(generic.contains("choose another ready engine in Settings"));
        assert!(!generic.contains("Open On-device model"));
    }

    #[test]
    fn mlx_stream_deltas_are_json_framed_and_bounded() {
        let framed = format!(
            "Codelit stream {}",
            serde_json::to_string(&"{\"summary\":").expect("encode stream delta")
        );
        assert_eq!(mlx_stream_delta(&framed), Some("{\"summary\":".into()));
        assert!(mlx_stream_delta("Codelit stream not-json").is_none());
        assert!(
            mlx_stream_delta(&format!(
                "Codelit stream {}",
                serde_json::to_string(&"x".repeat(8_001)).expect("encode oversized delta")
            ))
            .is_none()
        );
    }

    #[test]
    fn prompt_and_folder_boundaries_are_enforced() {
        assert!(validate_prompt("   ").is_err());
        assert!(resolve_working_directory(Some("/definitely/not/a/codelit/folder")).is_err());
        assert!(normalize_run_id(Some("bad run id")).is_err());
        assert_eq!(normalize_selection_mode(None), Ok("fixed"));
        assert_eq!(normalize_selection_mode(Some("auto")), Ok("auto"));
        assert!(normalize_selection_mode(Some("metered")).is_err());
        assert!(validate_provider_model("codex", "paid-api-model", None).is_err());
    }

    #[test]
    fn byok_evidence_distinguishes_explicit_selection_from_auto_fallback() {
        let fixed = byok_selection_evidence(false).join(" ");
        let automatic = byok_selection_evidence(true).join(" ");
        assert!(fixed.contains("explicitly selected"));
        assert!(fixed.contains("no provider fallback"));
        assert!(automatic.contains("user enabled metered fallback"));
        assert!(automatic.contains("no ready local or subscription engine"));
    }

    #[test]
    fn missing_api_key_does_not_claim_a_metered_provider_invocation() {
        let registry = RunRegistry::default();
        let run = registry.begin("missing-byok-key").expect("start run");
        let cancellation = run.token();
        let (emitter, events) = recording_emitter("missing-byok-key", "openai", "gpt-5.6-terra");
        emitter.emit("started", "Local intelligence started", None);
        let metered_fallback_authorized = true;
        let mut metered_provider_invocation_started = false;

        let error = run_byok_api_with_loader(
            "openai",
            "gpt-5.6-terra",
            "Answer with the required structure.",
            Duration::from_secs(1),
            &cancellation,
            &emitter,
            metered_fallback_authorized,
            &mut metered_provider_invocation_started,
            |_| Ok(None),
        )
        .expect_err("missing key fails before request construction and send");

        assert!(error.contains("not configured"));
        assert!(metered_fallback_authorized);
        assert!(!metered_provider_invocation_started);
        assert!(!metered_billing_fallback(
            "openai",
            "auto",
            metered_provider_invocation_started,
        ));
        assert!(
            events
                .lock()
                .expect("event lock")
                .iter()
                .all(|event| { event.event_type != "provider-invocation-started" })
        );
    }

    #[test]
    fn provider_environment_never_inherits_api_billing_keys() {
        let mut command = Command::new("/usr/bin/true");
        command
            .env("OPENAI_API_KEY", "do-not-inherit")
            .env("ANTHROPIC_API_KEY", "do-not-inherit")
            .env("GOOGLE_API_KEY", "do-not-inherit");
        configure_provider_environment(&mut command, Path::new("/usr/bin/true"));
        let inherited = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|_| key.to_string_lossy().into_owned()))
            .collect::<Vec<_>>();
        assert!(!inherited.iter().any(|key| key.ends_with("API_KEY")));
    }

    #[cfg(all(feature = "direct-release", not(feature = "app-store-release")))]
    #[test]
    fn direct_release_rejects_claude_before_dispatch() {
        let registry = RunRegistry::default();
        let error = run_provider_task_stream(
            ProviderTaskRequest {
                run_id: Some("blocked-claude".into()),
                provider: "claude".into(),
                model: "default".into(),
                prompt: "Run a read-only health check.".into(),
                working_directory: Some("/definitely/not/a/codelit/folder".into()),
                selection_mode: None,
            },
            None,
            &registry,
            None,
        )
        .expect_err("Direct release must block subscription-backed Claude execution");
        assert!(error.contains("Anthropic's current policy"));
    }

    #[cfg(feature = "app-store-release")]
    #[test]
    fn app_store_release_rejects_external_agents_before_dispatch() {
        let registry = RunRegistry::default();
        let error = run_provider_task_stream(
            ProviderTaskRequest {
                run_id: Some("blocked-codex".into()),
                provider: "codex".into(),
                model: "default".into(),
                prompt: "Run a read-only health check.".into(),
                working_directory: Some("/definitely/not/a/codelit/folder".into()),
                selection_mode: None,
            },
            None,
            &registry,
            None,
        )
        .expect_err("App Store release must block external agents");
        assert!(error.contains("notarized Direct build"));
    }

    #[test]
    #[ignore = "requires an installed, signed-in Codex subscription"]
    fn live_codex_subscription_probe() {
        let executable = resolve_provider_command("codex").expect("Codex installation");
        let registry = RunRegistry::default();
        let run = registry.begin("live-codex").expect("start run");
        let (emitter, events) = recording_emitter("live-codex", "codex", "default");
        let result = run_codex(
            &executable,
            "Return JSON with summary exactly \"provider ready\" and items containing exactly \"read-only\". Do not use tools or modify files.",
            &env::temp_dir(),
            PROVIDER_TIMEOUT,
            &run.token(),
            &emitter,
        )
        .expect("Codex structured task");
        println!("Codex live probe status: {}", result.status);
        assert_eq!(result.status, "completed");
        assert_eq!(result.text, "provider ready");
        let output = events
            .lock()
            .expect("live event lock")
            .iter()
            .filter(|event| event.event_type == "output-delta")
            .map(|event| event.message.as_str())
            .collect::<String>();
        assert_eq!(output, "provider ready");
    }

    #[test]
    #[ignore = "requires an installed Claude Code subscription"]
    fn live_claude_subscription_probe_returns_a_typed_state() {
        let executable = resolve_provider_command("claude").expect("Claude Code installation");
        let registry = RunRegistry::default();
        let run = registry.begin("live-claude").expect("start run");
        let emitter = RunEventEmitter::new("live-claude", "claude", "default", None);
        let result = run_claude(
            &executable,
            "Return JSON with summary exactly \"provider ready\" and items containing exactly \"read-only\". Do not use tools or modify files.",
            &env::temp_dir(),
            PROVIDER_TIMEOUT,
            &run.token(),
            &emitter,
        )
        .expect("Claude Code typed result");
        println!("Claude Code live probe status: {}", result.status);
        assert!(matches!(
            result.status.as_str(),
            "completed" | "signed-out" | "blocked-by-policy" | "quota-hit" | "failed"
        ));
    }

    #[test]
    #[ignore = "requires the built Codelit MLX helper and downloaded probe model"]
    fn live_mlx_probe() {
        let executable = resolve_provider_command("mlx").expect("MLX helper");
        let registry = RunRegistry::default();
        let run = registry.begin("live-mlx").expect("start run");
        let emitter =
            RunEventEmitter::new("live-mlx", "mlx", "mlx-community/Qwen3-0.6B-4bit", None);
        let result = run_mlx(
            &executable,
            "mlx-community/Qwen3-0.6B-4bit",
            "Reply with exactly this single-line JSON object and no other content: {\"summary\":\"provider ready\",\"items\":[\"read-only\"]}",
            &env::temp_dir(),
            None,
            &ExecutionControl {
                timeout: PROVIDER_TIMEOUT,
                cancellation: &run.token(),
                emitter: &emitter,
            },
        )
        .expect("MLX structured task");
        println!("MLX live probe status: {}", result.status);
        assert_eq!(result.status, "completed");
    }

    #[test]
    #[ignore = "downloads, verifies, runs, and deletes the pinned MLX model"]
    fn live_mlx_model_manager_round_trip() {
        let directory = tempdir().expect("temporary app data");
        let registry = RunRegistry::default();
        let model_id = "mlx-community/Qwen3-0.6B-4bit";
        let model = manage_local_model(
            ModelManagerRequest {
                run_id: Some("live-model-download".into()),
                provider: "mlx".into(),
                model: model_id.into(),
                action: "download".into(),
            },
            directory.path(),
            &registry,
            None,
        )
        .expect("downloaded and verified model");
        assert_eq!(model.status, "ready");

        let executable = resolve_provider_command("mlx").expect("MLX helper");
        let run = registry.begin("live-model-inference").expect("start run");
        let (emitter, events) = recording_emitter("live-model-inference", "mlx", model_id);
        let result = run_mlx(
            &executable,
            model_id,
            "Reply with exactly this single-line JSON object and no other content: {\"summary\":\"provider ready\",\"items\":[\"read-only\"]}",
            &env::temp_dir(),
            Some(directory.path()),
            &ExecutionControl {
                timeout: PROVIDER_TIMEOUT,
                cancellation: &run.token(),
                emitter: &emitter,
            },
        )
        .expect("MLX structured task");
        assert_eq!(result.status, "completed");
        let streamed = events
            .lock()
            .expect("stream events")
            .iter()
            .filter(|event| event.event_type == "output-delta")
            .map(|event| event.message.as_str())
            .collect::<String>();
        assert_eq!(streamed, "provider ready");

        let removed =
            model_manager::delete_model(directory.path(), model_id).expect("delete verified model");
        assert_eq!(removed.status, "download-required");
    }
}
