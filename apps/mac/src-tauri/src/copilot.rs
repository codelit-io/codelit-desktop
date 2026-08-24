use crate::run_control::{
    CancellationToken, OutputStream, run_line_process, run_line_process_guarded,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fmt;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const SHARED_CAPTURE_LIMIT: usize = 512 * 1024;
const MAX_SUMMARY_BYTES: usize = 2_800;
const MAX_ITEMS: usize = 3;
const MAX_ITEM_BYTES: usize = 350;
const MAX_FORMATTED_REPLY_BYTES: usize = 4_000;
const PROVIDER_PROFILES_DIRECTORY: &str = "provider-profiles";
const COPILOT_PROFILE_DIRECTORY: &str = "copilot";
const COPILOT_AUTH_STATE_FILE: &str = "config.json";
const COPILOT_GH_ISOLATION_DIRECTORY: &str = "gh";
const COPILOT_RUNTIME_STATE_ENTRIES: [&str; 5] = [
    "command-history-state",
    "ide",
    "logs",
    "session-state",
    "session-store.db",
];
const COPILOT_CONTROL_STATE_ENTRIES: [&str; 15] = [
    "agents",
    "copilot-instructions.md",
    "extensions",
    "hooks",
    "installed-plugins",
    "instructions",
    "lsp-config.json",
    "mcp-config.json",
    "mcp-oauth-config",
    "mcp-secrets",
    "permissions-config",
    "permissions-config.json",
    "plugin-data",
    "settings.json",
    "skills",
];
const REQUIRED_HELP_FLAGS: [&str; 19] = [
    "--available-tools",
    "--deny-tool",
    "--deny-url",
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    "--no-ask-user",
    "--no-auto-update",
    "--no-banner",
    "--no-bash-env",
    "--no-color",
    "--no-custom-instructions",
    "--no-experimental",
    "--no-remote",
    "--no-remote-export",
    "--log-dir",
    "--log-level",
    "--output-format",
    "--prompt",
    "--stream",
];
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Result of a non-mutating Copilot CLI installation probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopilotProbe {
    pub executable: PathBuf,
    pub version: String,
    pub auth: CopilotAuthState,
    pub compatibility: CopilotCompatibility,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopilotAuthState {
    /// Copilot CLI has no documented, non-consuming auth-status command.
    /// Authentication is therefore confirmed by the first provider run.
    RuntimeCheckRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopilotCompatibility {
    Supported,
    Unsupported { detail: String },
}

#[derive(Debug, Clone)]
pub struct CopilotRunLimits {
    pub timeout: Duration,
    pub max_prompt_chars: usize,
    pub max_output_bytes: usize,
    pub max_events: usize,
}

impl Default for CopilotRunLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(120),
            max_prompt_chars: 8_000,
            max_output_bytes: 128 * 1024,
            max_events: 2_048,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CopilotRunRequest {
    pub prompt: String,
    pub model: Option<String>,
    pub limits: CopilotRunLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CopilotReply {
    pub summary: String,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopilotRunResult {
    pub reply: CopilotReply,
    pub event_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopilotProgress {
    Thinking,
    OutputDelta(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopilotError {
    NotInstalled,
    ProbeFailed(String),
    UnsupportedCli(String),
    AuthenticationRequired(String),
    RateLimited(String),
    Canceled,
    TimedOut,
    OutputLimitExceeded,
    UnsafeActivity(String),
    InvalidRequest(String),
    InvalidOutput(String),
    ProcessFailed(String),
}

impl fmt::Display for CopilotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotInstalled => write!(formatter, "GitHub Copilot CLI is not installed."),
            Self::ProbeFailed(detail)
            | Self::UnsupportedCli(detail)
            | Self::AuthenticationRequired(detail)
            | Self::RateLimited(detail)
            | Self::UnsafeActivity(detail)
            | Self::InvalidRequest(detail)
            | Self::InvalidOutput(detail)
            | Self::ProcessFailed(detail) => formatter.write_str(detail),
            Self::Canceled => write!(formatter, "The GitHub Copilot run was canceled."),
            Self::TimedOut => write!(formatter, "The GitHub Copilot run timed out."),
            Self::OutputLimitExceeded => {
                write!(formatter, "GitHub Copilot exceeded the local output limit.")
            }
        }
    }
}

impl std::error::Error for CopilotError {}

/// Resolves only the official `copilot` executable name and documented install locations.
/// An explicit path is useful for a user-selected binary and deterministic tests.
pub fn resolve_executable(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return is_executable(path).then(|| path.to_path_buf());
    }

    let mut candidates = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin/copilot"));
        candidates.push(home.join(".npm-global/bin/copilot"));
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|directory| directory.join("copilot")));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/copilot"),
        PathBuf::from("/usr/local/bin/copilot"),
    ]);
    candidates.into_iter().find(|path| is_executable(path))
}

/// Runs version and help probes only. It never reads credentials or starts OAuth.
pub fn probe(explicit: Option<&Path>) -> Result<CopilotProbe, CopilotError> {
    let executable = resolve_executable(explicit).ok_or(CopilotError::NotInstalled)?;
    let version = probe_command(&executable, &["--version"])?;
    let help = probe_command(&executable, &["--help"])?;
    let missing = REQUIRED_HELP_FLAGS
        .iter()
        .copied()
        .filter(|flag| !help.contains(flag))
        .collect::<Vec<_>>();
    let compatibility = if missing.is_empty() {
        CopilotCompatibility::Supported
    } else {
        CopilotCompatibility::Unsupported {
            detail: format!(
                "This GitHub Copilot CLI version lacks required safety or structured-output flags: {}. Update Copilot CLI before using it in Codelit.",
                missing.join(", ")
            ),
        }
    };
    Ok(CopilotProbe {
        executable,
        version: first_bounded_line(&version),
        auth: CopilotAuthState::RuntimeCheckRequired,
        compatibility,
    })
}

/// Returns a provider-owned OAuth command for an explicit user action.
/// Codelit must launch this command as-is and must never inspect the resulting token.
pub fn sign_in_command(executable: &Path, app_data_dir: &Path) -> Result<Command, CopilotError> {
    if !is_executable(executable) {
        return Err(CopilotError::NotInstalled);
    }
    let profile = prepare_persistent_profile(app_data_dir)?;
    prepare_profile_for_operation(&profile)?;
    let mut command = Command::new(executable);
    command.arg("login").arg("--web-flow");
    configure_base_environment(&mut command, executable);
    configure_profile_environment(&mut command, &profile);
    Ok(command)
}

/// Executes one fresh, tool-free Copilot prompt.
///
/// GitHub documents `-p/--prompt` only as a command-line value, not as stdin input,
/// so the prompt must be passed as an argument. All session/config state is redirected
/// to a Codelit-owned persistent profile. Runtime cwd, cache, and logs remain in a
/// private temporary directory that is removed when the run finishes.
pub fn run<F>(
    executable: &Path,
    app_data_dir: &Path,
    request: &CopilotRunRequest,
    cancellation: &CancellationToken,
    mut on_progress: F,
) -> Result<CopilotRunResult, CopilotError>
where
    F: FnMut(CopilotProgress),
{
    validate_request(executable, request)?;
    let probe = probe(Some(executable))?;
    if let CopilotCompatibility::Unsupported { detail } = probe.compatibility {
        return Err(CopilotError::UnsupportedCli(detail));
    }

    let profile = prepare_persistent_profile(app_data_dir)?;
    let _profile_cleanup = PersistentProfileCleanup::begin(&profile)?;
    let sealed = SealedTempDirectory::new("codelit-copilot-runtime")?;
    let cache_home = sealed.path().join("cache");
    let gh_home = sealed.path().join("gh");
    let logs_home = sealed.path().join("logs");
    for directory in [&cache_home, &gh_home, &logs_home] {
        create_private_directory(directory)?;
    }

    let prompt = structured_prompt(&request.prompt);
    let mut command = Command::new(executable);
    command
        .arg("--prompt")
        .arg(prompt)
        .args([
            "--output-format=json",
            "--stream=on",
            "--available-tools=ask_user",
            "--no-ask-user",
            "--deny-tool=shell,write,read,url,memory",
            "--deny-url=*",
            "--disable-builtin-mcps",
            "--disallow-temp-dir",
            "--no-custom-instructions",
            "--no-remote",
            "--no-remote-export",
            "--no-experimental",
            "--no-auto-update",
            "--no-bash-env",
            "--no-banner",
            "--no-color",
            "--log-level=none",
        ])
        .arg(format!("--log-dir={}", logs_home.display()))
        .current_dir(sealed.path())
        .stdin(Stdio::null());
    if let Some(model) = request.model.as_deref() {
        command.arg(format!("--model={model}"));
    }
    configure_base_environment(&mut command, executable);
    configure_profile_environment(&mut command, &profile);
    command
        .env("COPILOT_CACHE_HOME", &cache_home)
        .env("GH_CONFIG_DIR", &gh_home)
        .env("COPILOT_AUTO_UPDATE", "false")
        .env("COPILOT_MCP_TOOL_CACHE", "false")
        .env("COPILOT_OTEL_ENABLED", "false")
        .env("GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS", "false")
        .env("GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS", "false")
        .env("GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP", "false");

    let observed_bytes = Arc::new(AtomicUsize::new(0));
    let output_exceeded = Arc::new(AtomicBool::new(false));
    let guard_exceeded = output_exceeded.clone();
    let mut parser = CopilotJsonlParser::new(request.limits.max_events);
    let mut parser_error = None;
    on_progress(CopilotProgress::Thinking);

    let process = run_line_process_guarded(
        command,
        request.limits.timeout,
        cancellation,
        |stream, line| {
            let new_total = observed_bytes.fetch_add(line.len(), Ordering::Relaxed) + line.len();
            if new_total > request.limits.max_output_bytes {
                output_exceeded.store(true, Ordering::Release);
                return;
            }
            if stream == OutputStream::Stdout
                && parser_error.is_none()
                && let Err(error) = parser.push(line, &mut on_progress)
            {
                parser_error = Some(error);
            }
        },
        move || {
            if guard_exceeded.load(Ordering::Acquire) {
                Err("GitHub Copilot exceeded the local output limit.".into())
            } else {
                Ok(())
            }
        },
    );

    if output_exceeded.load(Ordering::Acquire) {
        return Err(CopilotError::OutputLimitExceeded);
    }
    if let Some(error) = parser_error {
        return Err(error);
    }
    let output = process.map_err(|detail| map_process_error(&detail, cancellation))?;
    if !output.status.success() {
        return Err(classify_failure(&output.stderr, &output.stdout));
    }
    parser.finish()
}

fn validate_request(executable: &Path, request: &CopilotRunRequest) -> Result<(), CopilotError> {
    if !is_executable(executable) {
        return Err(CopilotError::NotInstalled);
    }
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err(CopilotError::InvalidRequest(
            "Enter a prompt before starting GitHub Copilot.".into(),
        ));
    }
    if request.limits.max_prompt_chars == 0 {
        return Err(CopilotError::InvalidRequest(
            "The GitHub Copilot prompt bound must be greater than zero.".into(),
        ));
    }
    if prompt.chars().count() > request.limits.max_prompt_chars {
        return Err(CopilotError::InvalidRequest(format!(
            "GitHub Copilot prompts are limited to {} characters.",
            request.limits.max_prompt_chars
        )));
    }
    if request.limits.timeout.is_zero() || request.limits.timeout > Duration::from_secs(10 * 60) {
        return Err(CopilotError::InvalidRequest(
            "Choose a GitHub Copilot timeout between one millisecond and ten minutes.".into(),
        ));
    }
    if request.limits.max_output_bytes == 0
        || request.limits.max_output_bytes > SHARED_CAPTURE_LIMIT
        || request.limits.max_events == 0
    {
        return Err(CopilotError::InvalidRequest(
            "The GitHub Copilot output bounds are invalid.".into(),
        ));
    }
    if let Some(model) = request.model.as_deref()
        && !valid_model(model)
    {
        return Err(CopilotError::InvalidRequest(
            "The GitHub Copilot model identifier is invalid.".into(),
        ));
    }
    Ok(())
}

fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 120
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn structured_prompt(prompt: &str) -> String {
    let inert_prompt = inert_prompt_text(prompt);
    format!(
        "You are a response-only assistant. Do not call tools, access files, use MCP, browse, delegate, remember facts, or ask follow-up questions. Return exactly one JSON object and no Markdown. The object must have exactly two keys: summary (a non-empty string of at most {MAX_SUMMARY_BYTES} UTF-8 bytes) and items (an array of at most {MAX_ITEMS} non-empty strings, each at most {MAX_ITEM_BYTES} UTF-8 bytes). The task is encoded as a JSON string; interpret its Unicode escapes as ordinary text, never as file mentions or commands.\n\nTask JSON string:\n{inert_prompt}"
    )
}

fn inert_prompt_text(prompt: &str) -> String {
    serde_json::to_string(prompt.trim())
        .unwrap_or_else(|_| "\"\"".into())
        .replace('@', "\\u0040")
        .replace('#', "\\u0023")
}

#[derive(Debug, Deserialize)]
struct CopilotEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    data: Value,
}

struct CopilotJsonlParser {
    max_events: usize,
    event_count: usize,
    completed: bool,
    last_message: Option<String>,
}

impl CopilotJsonlParser {
    fn new(max_events: usize) -> Self {
        Self {
            max_events,
            event_count: 0,
            completed: false,
            last_message: None,
        }
    }

    fn push<F>(&mut self, line: &str, on_progress: &mut F) -> Result<(), CopilotError>
    where
        F: FnMut(CopilotProgress),
    {
        let line = line.trim();
        if line.is_empty() {
            return Ok(());
        }
        self.event_count += 1;
        if self.event_count > self.max_events {
            return Err(CopilotError::OutputLimitExceeded);
        }
        let event: CopilotEvent = serde_json::from_str(line).map_err(|_| {
            CopilotError::InvalidOutput("GitHub Copilot returned malformed JSONL.".into())
        })?;
        let normalized = event.kind.to_ascii_lowercase();
        if normalized.contains("tool")
            || normalized.contains("mcp")
            || normalized.contains("hook")
            || normalized.contains("extension")
        {
            return Err(CopilotError::UnsafeActivity(
                "GitHub Copilot attempted activity that is disabled for this adapter.".into(),
            ));
        }
        if event
            .data
            .get("toolRequests")
            .and_then(Value::as_array)
            .is_some_and(|requests| !requests.is_empty())
            || event
                .data
                .get("tools")
                .and_then(Value::as_array)
                .is_some_and(|tools| !tools.is_empty())
            || event
                .data
                .get("parentToolCallId")
                .is_some_and(|value| !value.is_null())
        {
            return Err(CopilotError::UnsafeActivity(
                "GitHub Copilot attempted a tool or delegated-agent action that is disabled."
                    .into(),
            ));
        }
        match event.kind.as_str() {
            "assistant.message_delta" => {
                if let Some(delta) = event
                    .data
                    .get("deltaContent")
                    .or_else(|| event.data.get("content"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    on_progress(CopilotProgress::OutputDelta(delta.to_string()));
                }
            }
            "assistant.message" => {
                let content = event
                    .data
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        CopilotError::InvalidOutput(
                            "GitHub Copilot returned an assistant message without text.".into(),
                        )
                    })?;
                self.last_message = Some(content.to_string());
            }
            "assistant.turn_end" | "session.idle" | "session.shutdown" => self.completed = true,
            "assistant.intent"
            | "assistant.reasoning"
            | "assistant.reasoning_delta"
            | "assistant.streaming_delta"
            | "assistant.turn_start"
            | "assistant.usage"
            | "session.context_changed"
            | "session.model_change"
            | "session.model_changed"
            | "session.start"
            | "session.title_changed"
            | "session.usage_info"
            | "user.message" => {}
            "session.error" => {
                return Err(CopilotError::ProcessFailed(
                    "GitHub Copilot reported a session error.".into(),
                ));
            }
            _ => {
                return Err(CopilotError::InvalidOutput(
                    "GitHub Copilot returned an unsupported JSONL event.".into(),
                ));
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<CopilotRunResult, CopilotError> {
        if !self.completed {
            return Err(CopilotError::InvalidOutput(
                "GitHub Copilot ended without a terminal JSONL event.".into(),
            ));
        }
        let message = self.last_message.ok_or_else(|| {
            CopilotError::InvalidOutput(
                "GitHub Copilot completed without an assistant message.".into(),
            )
        })?;
        let reply: CopilotReply = serde_json::from_str(message.trim()).map_err(|_| {
            CopilotError::InvalidOutput(
                "GitHub Copilot completed without the required structured reply.".into(),
            )
        })?;
        validate_reply(&reply)?;
        Ok(CopilotRunResult {
            reply,
            event_count: self.event_count,
        })
    }
}

fn validate_reply(reply: &CopilotReply) -> Result<(), CopilotError> {
    let summary = reply.summary.trim();
    if summary.is_empty()
        || reply.summary.len() > MAX_SUMMARY_BYTES
        || contains_disallowed_control(&reply.summary)
        || reply.items.len() > MAX_ITEMS
    {
        return Err(CopilotError::InvalidOutput(
            "GitHub Copilot returned a reply outside the structured limits.".into(),
        ));
    }
    let mut formatted_bytes = summary.len();
    for item in &reply.items {
        if item.trim().is_empty()
            || item.len() > MAX_ITEM_BYTES
            || contains_disallowed_control(item)
        {
            return Err(CopilotError::InvalidOutput(
                "GitHub Copilot returned a reply outside the structured limits.".into(),
            ));
        }
        formatted_bytes = formatted_bytes.saturating_add(3 + item.trim().len());
    }
    if formatted_bytes > MAX_FORMATTED_REPLY_BYTES {
        return Err(CopilotError::InvalidOutput(
            "GitHub Copilot returned a reply outside the structured limits.".into(),
        ));
    }
    Ok(())
}

fn contains_disallowed_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
}

fn probe_command(executable: &Path, arguments: &[&str]) -> Result<String, CopilotError> {
    let mut command = Command::new(executable);
    command.args(arguments).stdin(Stdio::null());
    configure_base_environment(&mut command, executable);
    let output = run_line_process(
        command,
        PROBE_TIMEOUT,
        &CancellationToken::default(),
        |_, _| {},
    )
    .map_err(|detail| CopilotError::ProbeFailed(sanitize_detail(&detail)))?;
    let combined = format!("{}\n{}", output.stdout, output.stderr);
    if output.status.success() {
        Ok(combined)
    } else {
        Err(CopilotError::ProbeFailed(format!(
            "GitHub Copilot CLI probe failed: {}",
            first_bounded_line(&combined)
        )))
    }
}

fn configure_base_environment(command: &mut Command, executable: &Path) {
    let mut path_entries = vec![
        executable
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
        .env("LANG", "en_US.UTF-8")
        .env("COPILOT_AUTO_UPDATE", "false")
        .env("COPILOT_MCP_TOOL_CACHE", "false")
        .env("COPILOT_OTEL_ENABLED", "false");
    for key in ["HOME", "USER", "LOGNAME", "TMPDIR"] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
}

fn configure_profile_environment(command: &mut Command, profile: &Path) {
    command.env("COPILOT_HOME", profile).env(
        "GH_CONFIG_DIR",
        profile.join(COPILOT_GH_ISOLATION_DIRECTORY),
    );
}

fn map_process_error(detail: &str, cancellation: &CancellationToken) -> CopilotError {
    if cancellation.is_canceled() || detail.to_ascii_lowercase().contains("canceled") {
        CopilotError::Canceled
    } else if detail.to_ascii_lowercase().contains("timed out") {
        CopilotError::TimedOut
    } else {
        CopilotError::ProcessFailed(sanitize_detail(detail))
    }
}

fn classify_failure(stderr: &str, stdout: &str) -> CopilotError {
    let combined = format!("{}\n{}", stderr, stdout);
    let normalized = combined.to_ascii_lowercase();
    let detail = first_bounded_line(&combined);
    if normalized.contains("no authentication")
        || normalized.contains("not logged in")
        || normalized.contains("not signed in")
        || normalized.contains("login required")
        || normalized.contains("authentication failed")
    {
        CopilotError::AuthenticationRequired(
            "Sign in with GitHub Copilot CLI, then retry this run.".into(),
        )
    } else if normalized.contains("rate limit")
        || normalized.contains("quota")
        || normalized.contains("credits")
    {
        CopilotError::RateLimited(if detail.is_empty() {
            "GitHub Copilot is temporarily rate limited.".into()
        } else {
            detail
        })
    } else if normalized.contains("unknown option")
        || normalized.contains("unknown argument")
        || normalized.contains("unrecognized option")
    {
        CopilotError::UnsupportedCli(
            "This GitHub Copilot CLI version does not support the required safe execution flags."
                .into(),
        )
    } else {
        CopilotError::ProcessFailed(if detail.is_empty() {
            "GitHub Copilot CLI did not complete the request.".into()
        } else {
            detail
        })
    }
}

fn first_bounded_line(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("No detail was reported.")
        .chars()
        .take(400)
        .collect()
}

fn sanitize_detail(value: &str) -> String {
    first_bounded_line(value)
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

struct SealedTempDirectory {
    path: PathBuf,
}

impl SealedTempDirectory {
    fn new(prefix: &str) -> Result<Self, CopilotError> {
        let base = env::temp_dir();
        for _ in 0..32 {
            let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = base.join(format!(
                "{prefix}-{}-{nanos:x}-{counter:x}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(
                        |_| {
                            CopilotError::ProcessFailed(
                                "Could not seal the GitHub Copilot temporary directory.".into(),
                            )
                        },
                    )?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => {
                    return Err(CopilotError::ProcessFailed(
                        "Could not prepare the GitHub Copilot temporary directory.".into(),
                    ));
                }
            }
        }
        Err(CopilotError::ProcessFailed(
            "Could not allocate the GitHub Copilot temporary directory.".into(),
        ))
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for SealedTempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn create_private_directory(path: &Path) -> Result<(), CopilotError> {
    fs::create_dir_all(path).map_err(|_| {
        CopilotError::ProcessFailed(
            "Could not prepare GitHub Copilot's isolated runtime profile.".into(),
        )
    })?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| {
        CopilotError::ProcessFailed(
            "Could not seal GitHub Copilot's isolated runtime profile.".into(),
        )
    })
}

fn prepare_persistent_profile(app_data_dir: &Path) -> Result<PathBuf, CopilotError> {
    let profiles = app_data_dir.join(PROVIDER_PROFILES_DIRECTORY);
    ensure_private_directory_target(&profiles)?;
    let profile = profiles.join(COPILOT_PROFILE_DIRECTORY);
    ensure_private_directory_target(&profile)?;
    ensure_private_directory_target(&profile.join(COPILOT_GH_ISOLATION_DIRECTORY))?;
    Ok(profile)
}

/// Removes only documented Copilot runtime/control sidecars from Codelit's profile.
/// File contents are never read. The provider-managed authentication file survives.
pub fn cleanup_profile_runtime_state(app_data_dir: &Path) -> Result<(), CopilotError> {
    let profile = prepare_persistent_profile(app_data_dir)?;
    cleanup_generated_profile_state(&profile)
}

/// Removes Codelit's entire provider-owned Copilot profile without reading file contents.
/// Symlinks are unlinked at the owned path and are never followed.
pub fn delete_persistent_profile(app_data_dir: &Path) -> Result<(), CopilotError> {
    let profiles = app_data_dir.join(PROVIDER_PROFILES_DIRECTORY);
    let metadata = match fs::symlink_metadata(&profiles) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(profile_deletion_error()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        fs::remove_file(&profiles).map_err(|_| profile_deletion_error())?;
        return Ok(());
    }

    remove_owned_profile_entry_without_reading(&profiles.join(COPILOT_PROFILE_DIRECTORY))?;
    match fs::remove_dir(&profiles) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(_) => Err(profile_deletion_error()),
    }
}

fn remove_owned_profile_entry_without_reading(path: &Path) -> Result<(), CopilotError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(profile_deletion_error()),
    };
    let result = if metadata.file_type().is_symlink() || !metadata.is_dir() {
        fs::remove_file(path)
    } else {
        // Rust's Unix implementation removes entries relative to opened directory handles and
        // does not follow symlinks encountered while recursively deleting the owned tree.
        fs::remove_dir_all(path)
    };
    result.map_err(|_| profile_deletion_error())
}

fn profile_deletion_error() -> CopilotError {
    CopilotError::ProcessFailed("Could not remove Codelit's GitHub Copilot sign-in profile.".into())
}

fn prepare_profile_for_operation(profile: &Path) -> Result<(), CopilotError> {
    cleanup_documented_runtime_state(profile)?;
    let gh_directory = profile.join(COPILOT_GH_ISOLATION_DIRECTORY);
    ensure_empty_private_directory(&gh_directory)?;

    let entries = fs::read_dir(profile).map_err(|_| {
        CopilotError::ProcessFailed("Could not inspect GitHub Copilot's persistent profile.".into())
    })?;
    for entry in entries {
        let entry = entry.map_err(|_| {
            CopilotError::ProcessFailed(
                "Could not inspect GitHub Copilot's persistent profile.".into(),
            )
        })?;
        let name = entry.file_name();
        if name == COPILOT_AUTH_STATE_FILE {
            validate_private_auth_file(&entry.path())?;
        } else if name == COPILOT_GH_ISOLATION_DIRECTORY {
            continue;
        } else {
            return Err(CopilotError::UnsafeActivity(
                "GitHub Copilot's Codelit profile contains unsupported customization, control, or unknown state. Remove that state or sign in with a fresh Codelit profile."
                    .into(),
            ));
        }
    }
    Ok(())
}

fn cleanup_documented_runtime_state(profile: &Path) -> Result<(), CopilotError> {
    for name in COPILOT_RUNTIME_STATE_ENTRIES {
        remove_profile_entry_without_reading(&profile.join(name))?;
    }
    Ok(())
}

fn cleanup_generated_profile_state(profile: &Path) -> Result<(), CopilotError> {
    for name in COPILOT_RUNTIME_STATE_ENTRIES
        .into_iter()
        .chain(COPILOT_CONTROL_STATE_ENTRIES)
    {
        remove_profile_entry_without_reading(&profile.join(name))?;
    }
    reset_private_directory_without_reading(&profile.join(COPILOT_GH_ISOLATION_DIRECTORY))?;
    let auth_file = profile.join(COPILOT_AUTH_STATE_FILE);
    if auth_file.exists() {
        validate_private_auth_file(&auth_file)?;
    }
    Ok(())
}

fn reset_private_directory_without_reading(path: &Path) -> Result<(), CopilotError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(CopilotError::UnsafeActivity(
                "GitHub Copilot's isolated GitHub fallback must be a private local directory."
                    .into(),
            ));
        }
        Ok(_) => fs::remove_dir_all(path).map_err(|_| {
            CopilotError::ProcessFailed(
                "Could not clear GitHub Copilot's isolated GitHub fallback.".into(),
            )
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(CopilotError::ProcessFailed(
                "Could not inspect GitHub Copilot's isolated GitHub fallback.".into(),
            ));
        }
    }
    ensure_private_directory_target(path)
}

fn remove_profile_entry_without_reading(path: &Path) -> Result<(), CopilotError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(CopilotError::ProcessFailed(
                "Could not inspect GitHub Copilot's generated runtime state.".into(),
            ));
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(CopilotError::UnsafeActivity(
            "GitHub Copilot's generated runtime state cannot be a symlink.".into(),
        ));
    }
    let result = if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else if metadata.is_file() {
        fs::remove_file(path)
    } else {
        return Err(CopilotError::UnsafeActivity(
            "GitHub Copilot's generated runtime state has an unsupported file type.".into(),
        ));
    };
    result.map_err(|_| {
        CopilotError::ProcessFailed(
            "Could not remove GitHub Copilot's generated runtime state.".into(),
        )
    })
}

fn ensure_empty_private_directory(path: &Path) -> Result<(), CopilotError> {
    ensure_private_directory_target(path)?;
    let mut entries = fs::read_dir(path).map_err(|_| {
        CopilotError::ProcessFailed(
            "Could not inspect GitHub Copilot's GitHub isolation state.".into(),
        )
    })?;
    if entries
        .next()
        .transpose()
        .map_err(|_| {
            CopilotError::ProcessFailed(
                "Could not inspect GitHub Copilot's GitHub isolation state.".into(),
            )
        })?
        .is_some()
    {
        return Err(CopilotError::UnsafeActivity(
            "GitHub Copilot's isolated GitHub fallback must remain empty.".into(),
        ));
    }
    Ok(())
}

fn validate_private_auth_file(path: &Path) -> Result<(), CopilotError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        CopilotError::ProcessFailed(
            "Could not inspect GitHub Copilot's authentication state.".into(),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CopilotError::UnsafeActivity(
            "GitHub Copilot's authentication state must be a private local file.".into(),
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| {
        CopilotError::ProcessFailed("Could not seal GitHub Copilot's authentication state.".into())
    })
}

struct PersistentProfileCleanup {
    profile: PathBuf,
}

impl PersistentProfileCleanup {
    fn begin(profile: &Path) -> Result<Self, CopilotError> {
        prepare_profile_for_operation(profile)?;
        Ok(Self {
            profile: profile.to_path_buf(),
        })
    }
}

impl Drop for PersistentProfileCleanup {
    fn drop(&mut self) {
        let _ = cleanup_generated_profile_state(&self.profile);
    }
}

fn ensure_private_directory_target(path: &Path) -> Result<(), CopilotError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => validate_private_directory_target(path, &metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::create_dir(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => {
                    return Err(CopilotError::ProcessFailed(
                        "Could not prepare GitHub Copilot's persistent profile.".into(),
                    ));
                }
            }
            let metadata = fs::symlink_metadata(path).map_err(|_| {
                CopilotError::ProcessFailed(
                    "Could not verify GitHub Copilot's persistent profile.".into(),
                )
            })?;
            validate_private_directory_target(path, &metadata)
        }
        Err(_) => Err(CopilotError::ProcessFailed(
            "Could not inspect GitHub Copilot's persistent profile.".into(),
        )),
    }
}

fn validate_private_directory_target(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), CopilotError> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CopilotError::UnsafeActivity(
            "GitHub Copilot's persistent profile must be a private local directory.".into(),
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| {
        CopilotError::ProcessFailed("Could not seal GitHub Copilot's persistent profile.".into())
    })?;
    let verified = fs::symlink_metadata(path).map_err(|_| {
        CopilotError::ProcessFailed("Could not verify GitHub Copilot's persistent profile.".into())
    })?;
    if verified.file_type().is_symlink() || !verified.is_dir() {
        return Err(CopilotError::UnsafeActivity(
            "GitHub Copilot's persistent profile changed while Codelit prepared it.".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    fn executable_script(body: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("copilot");
        let mut file = fs::File::create(&executable).expect("create executable");
        writeln!(file, "#!/bin/sh\n{body}").expect("write executable");
        let mut permissions = file.metadata().expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).expect("set executable");
        (directory, executable)
    }

    fn compatible_script(run_body: &str) -> (tempfile::TempDir, PathBuf) {
        executable_script(&format!(
            r#"
if [ "$1" = "--version" ]; then
  printf '%s\n' 'GitHub Copilot CLI 1.0.69'
  exit 0
fi
if [ "$1" = "--help" ]; then
  printf '%s\n' '{}'
  exit 0
fi
{run_body}
"#,
            REQUIRED_HELP_FLAGS.join(" ")
        ))
    }

    #[test]
    fn probe_fails_closed_when_required_flag_is_missing() {
        let (_directory, executable) = executable_script(
            r#"
if [ "$1" = "--version" ]; then printf '%s\n' 'copilot 1.0.1'; else printf '%s\n' '--output-format'; fi
"#,
        );
        let probe = probe(Some(&executable)).expect("probe");
        assert!(matches!(
            probe.compatibility,
            CopilotCompatibility::Unsupported { .. }
        ));
        assert_eq!(probe.auth, CopilotAuthState::RuntimeCheckRequired);
    }

    #[test]
    fn parser_accepts_only_exact_summary_and_items_contract() {
        let mut parser = CopilotJsonlParser::new(10);
        let mut progress = Vec::new();
        parser
            .push(
                r#"{"type":"assistant.turn_start","data":{}}"#,
                &mut |event| progress.push(event),
            )
            .expect("turn start");
        parser
            .push(
                r#"{"type":"assistant.message","data":{"content":"{\"summary\":\"Ready\",\"items\":[\"One\"]}"}}"#,
                &mut |event| progress.push(event),
            )
            .expect("message");
        parser
            .push(r#"{"type":"assistant.turn_end","data":{}}"#, &mut |event| {
                progress.push(event)
            })
            .expect("turn end");
        let result = parser.finish().expect("structured result");
        assert_eq!(result.reply.summary, "Ready");
        assert_eq!(result.reply.items, ["One"]);

        let invalid: Result<CopilotReply, _> =
            serde_json::from_str(r#"{"summary":"Ready","items":[],"unexpected":true}"#);
        assert!(invalid.is_err());
    }

    #[test]
    fn parser_rejects_tool_activity_even_if_process_reports_success() {
        let mut parser = CopilotJsonlParser::new(10);
        let error = parser
            .push(
                r#"{"type":"tool.execution_start","data":{"toolName":"view"}}"#,
                &mut |_| {},
            )
            .expect_err("tool activity must fail");
        assert!(matches!(error, CopilotError::UnsafeActivity(_)));
    }

    #[test]
    fn prompt_neutralizes_file_and_issue_mentions() {
        let prompt = structured_prompt("Review @/private/key and #42");
        assert!(!prompt.contains("@/private/key"));
        assert!(!prompt.contains("#42"));
        assert!(prompt.contains("\\u0040/private/key"));
        assert!(prompt.contains("\\u002342"));
    }

    #[test]
    fn login_profile_is_reused_by_runs_while_runtime_state_is_removed() {
        let (_directory, executable) = compatible_script(
            r#"
if [ "$1" = "login" ]; then
  case "$COPILOT_HOME" in
    */provider-profiles/copilot) ;;
    *) printf '%s\n' 'login profile was not Codelit-owned' >&2; exit 7 ;;
  esac
  if [ "$GH_CONFIG_DIR" != "$COPILOT_HOME/gh" ]; then
    printf '%s\n' 'GitHub profile was not nested in the Copilot profile' >&2
    exit 8
  fi
  printf '%s\n' '{"loggedInUsers":["fake-user"]}' > "$COPILOT_HOME/config.json"
  printf '%s\n' "$HOME" > "$COPILOT_HOME/../../login-home"
  exit 0
fi
if ! grep -q 'fake-user' "$COPILOT_HOME/config.json"; then
  printf '%s\n' 'login state was not visible to the run' >&2
  exit 9
fi
case "$COPILOT_HOME" in
  */provider-profiles/copilot) ;;
  *) printf '%s\n' 'run profile was not Codelit-owned' >&2; exit 10 ;;
esac
if [ "$GH_CONFIG_DIR" = "$COPILOT_HOME/gh" ]; then
  printf '%s\n' 'run GitHub fallback was not temporary' >&2
  exit 11
fi
printf '%s\n' "$PWD" > "$COPILOT_HOME/../../runtime-paths"
printf '%s\n' "$COPILOT_CACHE_HOME" >> "$COPILOT_HOME/../../runtime-paths"
printf '%s\n' "$GH_CONFIG_DIR" >> "$COPILOT_HOME/../../runtime-paths"
for argument in "$@"; do
  case "$argument" in
    --log-dir=*) printf '%s\n' "${argument#--log-dir=}" >> "$COPILOT_HOME/../../runtime-paths" ;;
  esac
done
mkdir -p "$COPILOT_HOME/session-state" "$COPILOT_HOME/logs"
printf '%s\n' 'ephemeral session' > "$COPILOT_HOME/session-state/run"
printf '%s\n' 'ephemeral history' > "$COPILOT_HOME/session-store.db"
printf '%s\n' '{"type":"assistant.turn_start","data":{}}'
printf '%s\n' '{"type":"assistant.message_delta","data":{"deltaContent":"{\"summary\":"}}'
printf '%s\n' '{"type":"assistant.message","data":{"content":"{\"summary\":\"Provider ready\",\"items\":[\"No tools\"]}"}}'
printf '%s\n' '{"type":"assistant.turn_end","data":{}}'
"#,
        );
        let app_data = tempdir().expect("app data directory");
        let mut sign_in = sign_in_command(&executable, app_data.path()).expect("sign-in command");
        let login = sign_in.output().expect("run fake sign-in");
        assert!(
            login.status.success(),
            "fake sign-in failed: {}",
            String::from_utf8_lossy(&login.stderr)
        );
        let profile = app_data
            .path()
            .join(PROVIDER_PROFILES_DIRECTORY)
            .join(COPILOT_PROFILE_DIRECTORY);
        assert_eq!(
            fs::metadata(&profile)
                .expect("profile metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::read_to_string(app_data.path().join("login-home"))
                .expect("recorded HOME")
                .trim(),
            env::var("HOME").expect("real HOME")
        );
        let request = CopilotRunRequest {
            prompt: "Give a short answer".into(),
            model: None,
            limits: CopilotRunLimits::default(),
        };
        let mut progress = Vec::new();
        let result = run(
            &executable,
            app_data.path(),
            &request,
            &CancellationToken::default(),
            |event| progress.push(event),
        )
        .expect("run");
        assert_eq!(result.reply.summary, "Provider ready");
        assert_eq!(result.reply.items, ["No tools"]);
        assert!(progress.contains(&CopilotProgress::Thinking));
        assert_eq!(
            fs::read_to_string(profile.join(COPILOT_AUTH_STATE_FILE))
                .expect("persistent login state")
                .trim(),
            "{\"loggedInUsers\":[\"fake-user\"]}"
        );
        assert_eq!(
            fs::metadata(profile.join(COPILOT_AUTH_STATE_FILE))
                .expect("authentication state metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let runtime_paths = fs::read_to_string(app_data.path().join("runtime-paths"))
            .expect("recorded runtime paths")
            .lines()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        assert_eq!(runtime_paths.len(), 4);
        assert!(runtime_paths.iter().all(|path| !path.exists()));
        assert!(!profile.join("session-state").exists());
        assert!(!profile.join("logs").exists());
        assert!(!profile.join("session-store.db").exists());
        assert!(profile.is_dir());
    }

    #[test]
    fn reset_removes_unreadable_copilot_auth_state_and_empty_profiles_parent() {
        let app_data = tempdir().expect("app data directory");
        let profile = app_data
            .path()
            .join(PROVIDER_PROFILES_DIRECTORY)
            .join(COPILOT_PROFILE_DIRECTORY);
        fs::create_dir_all(&profile).expect("create profile");
        let config = profile.join(COPILOT_AUTH_STATE_FILE);
        fs::write(&config, b"credential contents must not be read").expect("write auth state");
        fs::set_permissions(&config, fs::Permissions::from_mode(0o000))
            .expect("make auth state unreadable");

        delete_persistent_profile(app_data.path()).expect("delete owned profile");

        assert!(!config.exists());
        assert!(!profile.exists());
        assert!(!app_data.path().join(PROVIDER_PROFILES_DIRECTORY).exists());
    }

    #[test]
    fn reset_unlinks_copilot_profile_symlink_without_touching_its_target() {
        let app_data = tempdir().expect("app data directory");
        let profiles = app_data.path().join(PROVIDER_PROFILES_DIRECTORY);
        fs::create_dir(&profiles).expect("create profiles directory");
        let outside = app_data.path().join("outside-profile");
        fs::create_dir(&outside).expect("create outside profile");
        let outside_config = outside.join(COPILOT_AUTH_STATE_FILE);
        fs::write(&outside_config, b"outside").expect("write outside state");
        symlink(&outside, profiles.join(COPILOT_PROFILE_DIRECTORY))
            .expect("link profile outside owned tree");

        delete_persistent_profile(app_data.path()).expect("unlink owned profile path");

        assert!(outside_config.exists());
        assert!(!profiles.exists());
    }

    #[test]
    fn persistent_profile_rejects_symlink_and_non_directory_targets() {
        let (_directory, executable) = compatible_script("exit 0");

        let symlink_app_data = tempdir().expect("symlink app data");
        let profiles = symlink_app_data.path().join(PROVIDER_PROFILES_DIRECTORY);
        fs::create_dir(&profiles).expect("profiles directory");
        let target = symlink_app_data.path().join("redirected-profile");
        fs::create_dir(&target).expect("symlink target");
        symlink(&target, profiles.join(COPILOT_PROFILE_DIRECTORY)).expect("profile symlink");
        assert!(matches!(
            sign_in_command(&executable, symlink_app_data.path()),
            Err(CopilotError::UnsafeActivity(_))
        ));

        let file_app_data = tempdir().expect("file app data");
        let profiles = file_app_data.path().join(PROVIDER_PROFILES_DIRECTORY);
        fs::create_dir(&profiles).expect("profiles directory");
        fs::write(profiles.join(COPILOT_PROFILE_DIRECTORY), b"not a directory")
            .expect("profile file");
        assert!(matches!(
            sign_in_command(&executable, file_app_data.path()),
            Err(CopilotError::UnsafeActivity(_))
        ));
    }

    #[test]
    fn persistent_profile_rejects_customization_and_runtime_symlinks() {
        let (_directory, executable) = compatible_script("exit 0");

        let customized = tempdir().expect("customized app data");
        let profile = prepare_persistent_profile(customized.path()).expect("profile");
        fs::write(profile.join("settings.json"), b"{}").expect("custom settings");
        assert!(matches!(
            sign_in_command(&executable, customized.path()),
            Err(CopilotError::UnsafeActivity(_))
        ));

        let linked_runtime = tempdir().expect("linked runtime app data");
        let profile = prepare_persistent_profile(linked_runtime.path()).expect("profile");
        let target = linked_runtime.path().join("runtime-target");
        fs::create_dir(&target).expect("runtime target");
        symlink(&target, profile.join("session-state")).expect("runtime symlink");
        assert!(matches!(
            sign_in_command(&executable, linked_runtime.path()),
            Err(CopilotError::UnsafeActivity(_))
        ));
    }
}
