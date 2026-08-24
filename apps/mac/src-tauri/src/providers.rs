use crate::copilot::{self, CopilotCompatibility};
use crate::lmstudio;
use crate::model_manager::{self, ProviderModel};
use crate::ollama;
use crate::provider_credentials::{ByokProvider, ProviderCredentialRef, ProviderCredentialStore};
use serde::Serialize;
use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use wait_timeout::ChildExt;

const CLAUDE_SUBSCRIPTION_POLICY_DETAIL: &str = "Claude subscription execution is unavailable in Codelit because Anthropic's current policy does not permit third-party products to route requests through Free, Pro, or Max credentials. Use Codelit Local, Ollama, Codex, or an approved API connection when available.";
const GOOGLE_SUBSCRIPTION_POLICY_DETAIL: &str = "Gemini subscription execution is unavailable because the current Antigravity CLI cannot isolate provider sign-in from ambient user settings, agents, hooks, plugins, and MCP configuration. Use Gemini API, Codex, Copilot, or a verified local model.";
const APP_STORE_EXTERNAL_PROVIDER_DETAIL: &str = "This provider runs only in Codelit's notarized Direct build; the App Store sandbox does not include external agents.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderPolicyProfile {
    Development,
    Direct,
    AppStore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexAuthState {
    SignedIn,
    SignedOut,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuota {
    pub state: &'static str,
    pub detail: &'static str,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbe {
    pub id: &'static str,
    pub label: &'static str,
    pub family: &'static str,
    pub auth_kind: &'static str,
    pub billing_mode: &'static str,
    pub distribution: &'static str,
    pub status: &'static str,
    pub health: &'static str,
    pub can_run: bool,
    pub command_path: Option<String>,
    pub version: Option<String>,
    pub capabilities: Vec<&'static str>,
    pub models: Vec<ProviderModel>,
    pub quota: ProviderQuota,
    pub detail: String,
}

struct ProviderDefinition {
    id: &'static str,
    label: &'static str,
    family: &'static str,
    distribution: &'static str,
    command: &'static str,
    fixed_candidates: &'static [&'static str],
    capabilities: &'static [&'static str],
    missing_detail: &'static str,
}

impl ProviderDefinition {
    fn auth_kind(&self) -> &'static str {
        match self.family {
            "api" => "api-key",
            "local" => "none",
            _ => "provider-owned",
        }
    }

    fn billing_mode(&self) -> &'static str {
        match self.family {
            "api" => "metered",
            "local" => "local",
            _ => "subscription",
        }
    }
}

const PROVIDERS: [ProviderDefinition; 10] = [
    ProviderDefinition {
        id: "codex",
        label: "Codex",
        family: "subscription",
        distribution: "direct-only",
        command: "codex",
        fixed_candidates: &["/Applications/ChatGPT.app/Contents/Resources/codex"],
        capabilities: &[
            "structured-output",
            "streaming",
            "cancellation",
            "app-server",
            "provider-owned-auth",
        ],
        missing_detail: "Install Codex or the ChatGPT Mac app to use your existing Codex sign-in.",
    },
    ProviderDefinition {
        id: "claude",
        label: "Claude Code",
        family: "subscription",
        distribution: "direct-only",
        command: "claude",
        fixed_candidates: &[],
        capabilities: &[
            "structured-output",
            "streaming",
            "cancellation",
            "print-mode",
            "provider-owned-auth",
        ],
        missing_detail: "Install Claude Code to run development compatibility probes.",
    },
    ProviderDefinition {
        id: "copilot",
        label: "GitHub Copilot",
        family: "subscription",
        distribution: "direct-only",
        command: "copilot",
        fixed_candidates: &["/opt/homebrew/bin/copilot", "/usr/local/bin/copilot"],
        capabilities: &[
            "structured-output",
            "streaming",
            "cancellation",
            "provider-owned-auth",
        ],
        missing_detail: "Install GitHub Copilot CLI to use an eligible Copilot subscription.",
    },
    ProviderDefinition {
        id: "antigravity",
        label: "Gemini subscription",
        family: "subscription",
        distribution: "unsupported",
        command: "agy",
        fixed_candidates: &[],
        capabilities: &[],
        missing_detail: GOOGLE_SUBSCRIPTION_POLICY_DETAIL,
    },
    ProviderDefinition {
        id: "openai",
        label: "OpenAI API",
        family: "api",
        distribution: "all",
        command: "",
        fixed_candidates: &[],
        capabilities: &[
            "structured-output",
            "streaming",
            "cancellation",
            "api-key-auth",
        ],
        missing_detail: "Add an OpenAI API key to use metered OpenAI models.",
    },
    ProviderDefinition {
        id: "anthropic",
        label: "Anthropic API",
        family: "api",
        distribution: "all",
        command: "",
        fixed_candidates: &[],
        capabilities: &[
            "structured-output",
            "streaming",
            "cancellation",
            "api-key-auth",
        ],
        missing_detail: "Add an Anthropic API key to use metered Claude models.",
    },
    ProviderDefinition {
        id: "gemini",
        label: "Gemini API",
        family: "api",
        distribution: "all",
        command: "",
        fixed_candidates: &[],
        capabilities: &[
            "structured-output",
            "streaming",
            "cancellation",
            "api-key-auth",
        ],
        missing_detail: "Add a Gemini API key to use metered Gemini models.",
    },
    ProviderDefinition {
        id: "ollama",
        label: "Ollama",
        family: "local",
        distribution: "direct-only",
        command: "ollama",
        fixed_candidates: &["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"],
        capabilities: &[
            "structured-output",
            "local-models",
            "streaming",
            "cancellation",
            "offline-after-download",
        ],
        missing_detail: "Install Ollama to use models already managed on this Mac.",
    },
    ProviderDefinition {
        id: "lmstudio",
        label: "LM Studio",
        family: "local",
        distribution: "direct-only",
        command: "",
        fixed_candidates: &[],
        capabilities: &[
            "structured-output",
            "local-models",
            "streaming",
            "cancellation",
            "offline-after-download",
        ],
        missing_detail: "Install LM Studio, load a local model, and start its local server on 127.0.0.1:1234.",
    },
    ProviderDefinition {
        id: "mlx",
        label: "Built-in MLX",
        family: "local",
        distribution: "all",
        command: "codelit-mlx-helper",
        fixed_candidates: &[],
        capabilities: &[
            "structured-output",
            "local-models",
            "streaming",
            "cancellation",
            "offline-after-download",
            "apple-silicon",
        ],
        missing_detail: "Codelit's bundled on-device runtime is unavailable in this build.",
    },
];

pub fn probe_providers(app_data_dir: &Path) -> Vec<ProviderProbe> {
    let sandboxed = app_sandbox_active();
    let profile = compiled_policy_profile();
    PROVIDERS
        .iter()
        .map(|definition| probe_provider(definition, app_data_dir, profile, sandboxed))
        .collect()
}

pub(crate) fn ensure_provider_execution_allowed(provider_id: &str) -> Result<(), String> {
    provider_policy_block(provider_id, compiled_policy_profile(), app_sandbox_active())
        .map_or(Ok(()), |detail| Err(detail.into()))
}

pub(crate) fn start_codex_sign_in() -> Result<(), String> {
    ensure_provider_execution_allowed("codex")?;
    let path = resolve_provider_command("codex")
        .ok_or_else(|| "Install Codex or the ChatGPT Mac app before signing in.".to_string())?;
    let mut command = Command::new(&path);
    command
        .arg("login")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_probe_environment(&mut command, &path);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Codex sign-in could not start: {error}"))?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub(crate) fn start_copilot_sign_in(app_data_dir: &Path) -> Result<(), String> {
    ensure_provider_execution_allowed("copilot")?;
    let path = copilot::resolve_executable(None)
        .ok_or_else(|| "Install GitHub Copilot CLI before signing in.".to_string())?;
    let mut command =
        copilot::sign_in_command(&path, app_data_dir).map_err(|error| error.to_string())?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("GitHub Copilot sign-in could not start: {error}"))?;
    let app_data_dir = app_data_dir.to_path_buf();
    thread::spawn(move || {
        let _ = child.wait();
        let _ = copilot::cleanup_profile_runtime_state(&app_data_dir);
    });
    Ok(())
}

fn compiled_policy_profile() -> ProviderPolicyProfile {
    if cfg!(feature = "app-store-release") {
        ProviderPolicyProfile::AppStore
    } else if cfg!(feature = "direct-release") {
        ProviderPolicyProfile::Direct
    } else {
        ProviderPolicyProfile::Development
    }
}

fn app_sandbox_active() -> bool {
    env::var_os("APP_SANDBOX_CONTAINER_ID").is_some()
}

fn provider_policy_block(
    provider_id: &str,
    profile: ProviderPolicyProfile,
    sandboxed: bool,
) -> Option<&'static str> {
    if provider_id == "antigravity" {
        return Some(GOOGLE_SUBSCRIPTION_POLICY_DETAIL);
    }
    if provider_id == "claude" && profile != ProviderPolicyProfile::Development {
        return Some(CLAUDE_SUBSCRIPTION_POLICY_DETAIL);
    }
    if (profile == ProviderPolicyProfile::AppStore || sandboxed)
        && matches!(
            provider_id,
            "codex" | "copilot" | "claude" | "ollama" | "lmstudio"
        )
    {
        return Some(APP_STORE_EXTERNAL_PROVIDER_DETAIL);
    }
    None
}

fn probe_provider(
    definition: &ProviderDefinition,
    app_data_dir: &Path,
    profile: ProviderPolicyProfile,
    sandboxed: bool,
) -> ProviderProbe {
    if let Some(detail) = provider_policy_block(definition.id, profile, sandboxed) {
        return unavailable_probe(definition, "blocked-by-policy", "policy-blocked", detail);
    }
    if definition.family == "api" {
        return probe_api_provider(definition);
    }
    if definition.id == "copilot" {
        return probe_copilot(definition);
    }
    if definition.id == "lmstudio" {
        return probe_lmstudio(definition);
    }
    let Some(path) = resolve_definition_command(definition) else {
        return unavailable_probe(
            definition,
            "not-installed",
            "missing",
            definition.missing_detail,
        );
    };
    let version = match read_version(&path) {
        Ok(version) => version,
        Err(detail) => {
            let mut probe = unavailable_probe(
                definition,
                "version-unsupported",
                "version-check-failed",
                &detail,
            );
            probe.command_path = Some(path.to_string_lossy().into_owned());
            return probe;
        }
    };

    match definition.id {
        "mlx" => probe_mlx(definition, app_data_dir, path, version),
        "ollama" => probe_ollama(definition, path, version),
        "codex" => probe_codex(definition, path, version),
        "claude" => ready_external_probe(definition, path, version),
        _ => unavailable_probe(
            definition,
            "blocked-by-policy",
            "policy-blocked",
            definition.missing_detail,
        ),
    }
}

fn probe_copilot(definition: &ProviderDefinition) -> ProviderProbe {
    match copilot::probe(None) {
        Ok(probe) => match probe.compatibility {
            CopilotCompatibility::Supported => {
                let mut ready = ready_external_probe(definition, probe.executable, probe.version);
                ready.health = "unchecked-auth";
                ready.detail = "GitHub Copilot CLI is ready. Subscription sign-in and limits are checked by GitHub when a run starts.".into();
                ready
            }
            CopilotCompatibility::Unsupported { detail } => installed_unavailable_probe(
                definition,
                probe.executable,
                probe.version,
                "version-unsupported",
                "version-check-failed",
                &detail,
            ),
        },
        Err(copilot::CopilotError::NotInstalled) => unavailable_probe(
            definition,
            "not-installed",
            "missing",
            definition.missing_detail,
        ),
        Err(error) => unavailable_probe(
            definition,
            "version-unsupported",
            "version-check-failed",
            &error.to_string(),
        ),
    }
}

fn probe_lmstudio(definition: &ProviderDefinition) -> ProviderProbe {
    match lmstudio::list_models(Duration::from_millis(750)) {
        Ok(models) => {
            let models = models
                .into_iter()
                .map(|model| ProviderModel {
                    id: model.id,
                    label: model.label,
                    status: "ready".into(),
                    capabilities: vec!["structured-output".into(), "local-inference".into()],
                    local: true,
                    download_bytes: None,
                    installed_bytes: Some(model.size_bytes),
                    license: None,
                    recommended: false,
                    detail: [
                        (!model.publisher.is_empty()).then_some(model.publisher),
                        model.parameter_size,
                        model.quantization,
                        Some(model.format.to_ascii_uppercase()),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" - "),
                    benchmark: None,
                })
                .collect::<Vec<_>>();
            let can_run = !models.is_empty();
            ProviderProbe {
                id: definition.id,
                label: definition.label,
                family: definition.family,
                auth_kind: definition.auth_kind(),
                billing_mode: definition.billing_mode(),
                distribution: definition.distribution,
                status: "ready",
                health: if can_run {
                    "ready"
                } else {
                    "model-setup-required"
                },
                can_run,
                command_path: None,
                version: None,
                capabilities: definition.capabilities.to_vec(),
                models,
                quota: local_quota(),
                detail: if can_run {
                    "LM Studio's loopback-only local server and a local model are ready.".into()
                } else {
                    "LM Studio is running, but no compatible local model is available.".into()
                },
            }
        }
        Err(detail) => ProviderProbe {
            id: definition.id,
            label: definition.label,
            family: definition.family,
            auth_kind: definition.auth_kind(),
            billing_mode: definition.billing_mode(),
            distribution: definition.distribution,
            status: "not-installed",
            health: "service-stopped",
            can_run: false,
            command_path: None,
            version: None,
            capabilities: definition.capabilities.to_vec(),
            models: Vec::new(),
            quota: local_quota(),
            detail,
        },
    }
}

fn probe_codex(definition: &ProviderDefinition, path: PathBuf, version: String) -> ProviderProbe {
    match read_codex_auth_state(&path) {
        Ok(CodexAuthState::SignedIn) => {
            let mut probe = ready_external_probe(definition, path, version);
            probe.health = "ready";
            probe.detail = "Codex and this Mac user's ChatGPT sign-in are ready.".into();
            probe
        }
        Ok(CodexAuthState::SignedOut) => installed_unavailable_probe(
            definition,
            path,
            version,
            "signed-out",
            "signed-out",
            "Codex is installed, but this Mac user is not signed in. Sign in with Codex, then return to Codelit.",
        ),
        Err(detail) => installed_unavailable_probe(
            definition,
            path,
            version,
            "signed-out",
            "signed-out",
            &format!(
                "Codelit could not confirm this Mac user's Codex sign-in: {detail} Sign in with Codex, then return to Codelit."
            ),
        ),
    }
}

fn ready_external_probe(
    definition: &ProviderDefinition,
    path: PathBuf,
    version: String,
) -> ProviderProbe {
    ProviderProbe {
        id: definition.id,
        label: definition.label,
        family: definition.family,
        auth_kind: definition.auth_kind(),
        billing_mode: definition.billing_mode(),
        distribution: definition.distribution,
        status: "ready",
        health: "unchecked-auth",
        can_run: true,
        command_path: Some(path.to_string_lossy().into_owned()),
        version: Some(version),
        capabilities: definition.capabilities.to_vec(),
        models: vec![ProviderModel {
            id: "default".into(),
            label: format!("{} default", definition.label),
            status: "ready".into(),
            capabilities: vec!["structured-output".into()],
            local: false,
            download_bytes: None,
            installed_bytes: None,
            license: None,
            recommended: true,
            detail: "Uses the model selected by the provider-owned subscription.".into(),
            benchmark: None,
        }],
        quota: unknown_quota(),
        detail:
            "Runtime ready. Sign-in and quota are checked by the provider only when you run it."
                .into(),
    }
}

fn probe_api_provider(definition: &ProviderDefinition) -> ProviderProbe {
    let Some(provider) = byok_provider(definition.id) else {
        return unavailable_probe(
            definition,
            "blocked-by-policy",
            "policy-blocked",
            definition.missing_detail,
        );
    };
    let reference = match ProviderCredentialRef::new(provider, "default") {
        Ok(reference) => reference,
        Err(_) => {
            return unavailable_probe(
                definition,
                "signed-out",
                "signed-out",
                "The provider credential profile is invalid.",
            );
        }
    };
    match ProviderCredentialStore::default().probe(&reference) {
        Ok(status) if status.configured => ProviderProbe {
            id: definition.id,
            label: definition.label,
            family: definition.family,
            auth_kind: definition.auth_kind(),
            billing_mode: definition.billing_mode(),
            distribution: definition.distribution,
            status: "ready",
            health: "ready",
            can_run: true,
            command_path: None,
            version: None,
            capabilities: definition.capabilities.to_vec(),
            models: vec![ProviderModel {
                id: provider.default_model().into(),
                label: provider.default_model().into(),
                status: "ready".into(),
                capabilities: vec!["structured-output".into()],
                local: false,
                download_bytes: None,
                installed_bytes: None,
                license: None,
                recommended: true,
                detail: "Uses the API key saved in this Mac user's Keychain.".into(),
                benchmark: None,
            }],
            quota: metered_quota(),
            detail: "API key is stored in Keychain. Requests are metered and Auto uses this provider only after the user enables metered fallback.".into(),
        },
        Ok(_) => unavailable_probe(
            definition,
            "signed-out",
            "signed-out",
            definition.missing_detail,
        ),
        Err(_) => unavailable_probe(
            definition,
            "signed-out",
            "signed-out",
            "Codelit could not access provider credentials in the macOS Keychain.",
        ),
    }
}

pub(crate) fn byok_provider(provider_id: &str) -> Option<ByokProvider> {
    match provider_id {
        "openai" => Some(ByokProvider::OpenAi),
        "anthropic" => Some(ByokProvider::Anthropic),
        "gemini" => Some(ByokProvider::Gemini),
        _ => None,
    }
}

fn probe_mlx(
    definition: &ProviderDefinition,
    app_data_dir: &Path,
    path: PathBuf,
    version: String,
) -> ProviderProbe {
    match model_manager::probe_models(app_data_dir) {
        Ok(models) => {
            let can_run = models.iter().any(|model| model.status == "ready");
            ProviderProbe {
                id: definition.id,
                label: definition.label,
                family: definition.family,
                auth_kind: definition.auth_kind(),
                billing_mode: definition.billing_mode(),
                distribution: definition.distribution,
                status: "ready",
                health: if can_run {
                    "ready"
                } else {
                    "model-setup-required"
                },
                can_run,
                command_path: Some(path.to_string_lossy().into_owned()),
                version: Some(version),
                capabilities: definition.capabilities.to_vec(),
                models,
                quota: local_quota(),
                detail: if can_run {
                    "Bundled runtime and a verified on-device model are ready.".into()
                } else {
                    "Bundled runtime is ready. Download a compatible model before the first run."
                        .into()
                },
            }
        }
        Err(detail) => {
            let mut probe = unavailable_probe(
                definition,
                "version-unsupported",
                "manifest-invalid",
                &detail,
            );
            probe.command_path = Some(path.to_string_lossy().into_owned());
            probe.version = Some(version);
            probe
        }
    }
}

fn probe_ollama(definition: &ProviderDefinition, path: PathBuf, version: String) -> ProviderProbe {
    match ollama::list_models(Duration::from_millis(750)) {
        Ok(models) => {
            let models = models
                .into_iter()
                .filter(|model| !model.name.trim().is_empty())
                .map(|model| {
                    let id = if model.model.trim().is_empty() {
                        model.name
                    } else {
                        model.model
                    };
                    let detail = [
                        model.details.parameter_size,
                        model.details.quantization_level,
                        model.details.family,
                    ]
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" - ");
                    ProviderModel {
                        label: id.clone(),
                        id,
                        status: "ready".into(),
                        capabilities: vec!["structured-output".into(), "local-inference".into()],
                        local: true,
                        download_bytes: None,
                        installed_bytes: Some(model.size),
                        license: None,
                        recommended: false,
                        detail: if detail.is_empty() {
                            format!("Installed locally. Digest {}", short_digest(&model.digest))
                        } else {
                            format!("{detail}. Digest {}", short_digest(&model.digest))
                        },
                        benchmark: None,
                    }
                })
                .collect::<Vec<_>>();
            let can_run = !models.is_empty();
            ProviderProbe {
                id: definition.id,
                label: definition.label,
                family: definition.family,
                auth_kind: definition.auth_kind(),
                billing_mode: definition.billing_mode(),
                distribution: definition.distribution,
                status: "ready",
                health: if can_run {
                    "ready"
                } else {
                    "model-setup-required"
                },
                can_run,
                command_path: Some(path.to_string_lossy().into_owned()),
                version: Some(version),
                capabilities: definition.capabilities.to_vec(),
                models,
                quota: local_quota(),
                detail: if can_run {
                    "Local service and installed models are ready.".into()
                } else {
                    "Ollama is running, but no local model is installed.".into()
                },
            }
        }
        Err(detail) => ProviderProbe {
            id: definition.id,
            label: definition.label,
            family: definition.family,
            auth_kind: definition.auth_kind(),
            billing_mode: definition.billing_mode(),
            distribution: definition.distribution,
            status: "ready",
            health: "service-stopped",
            can_run: false,
            command_path: Some(path.to_string_lossy().into_owned()),
            version: Some(version),
            capabilities: definition.capabilities.to_vec(),
            models: Vec::new(),
            quota: local_quota(),
            detail,
        },
    }
}

fn unavailable_probe(
    definition: &ProviderDefinition,
    status: &'static str,
    health: &'static str,
    detail: &str,
) -> ProviderProbe {
    ProviderProbe {
        id: definition.id,
        label: definition.label,
        family: definition.family,
        auth_kind: definition.auth_kind(),
        billing_mode: definition.billing_mode(),
        distribution: definition.distribution,
        status,
        health,
        can_run: false,
        command_path: None,
        version: None,
        capabilities: definition.capabilities.to_vec(),
        models: Vec::new(),
        quota: if definition.family == "local" {
            local_quota()
        } else {
            unknown_quota()
        },
        detail: detail.into(),
    }
}

fn installed_unavailable_probe(
    definition: &ProviderDefinition,
    path: PathBuf,
    version: String,
    status: &'static str,
    health: &'static str,
    detail: &str,
) -> ProviderProbe {
    let mut probe = unavailable_probe(definition, status, health, detail);
    probe.command_path = Some(path.to_string_lossy().into_owned());
    probe.version = Some(version);
    probe
}

fn local_quota() -> ProviderQuota {
    ProviderQuota {
        state: "not-applicable",
        detail: "Runs locally with no Codelit model charge.",
        resets_at: None,
    }
}

fn metered_quota() -> ProviderQuota {
    ProviderQuota {
        state: "unknown",
        detail: "Usage is metered by the selected provider's API account.",
        resets_at: None,
    }
}

fn unknown_quota() -> ProviderQuota {
    ProviderQuota {
        state: "unknown",
        detail: "The provider reports limits only when a run starts.",
        resets_at: None,
    }
}

fn short_digest(value: &str) -> &str {
    value.get(..12).unwrap_or(value)
}

pub(crate) fn resolve_provider_command(provider_id: &str) -> Option<PathBuf> {
    PROVIDERS
        .iter()
        .find(|provider| provider.id == provider_id)
        .and_then(resolve_definition_command)
}

pub(crate) fn provider_family(provider_id: &str) -> Option<&'static str> {
    PROVIDERS
        .iter()
        .find(|provider| provider.id == provider_id)
        .map(|provider| provider.family)
}

fn resolve_definition_command(definition: &ProviderDefinition) -> Option<PathBuf> {
    if definition.id == "copilot" {
        return copilot::resolve_executable(None);
    }
    if definition.id == "mlx" {
        return resolve_mlx_helper();
    }
    resolve_command(definition.command, definition.fixed_candidates)
}

fn resolve_mlx_helper() -> Option<PathBuf> {
    let mut candidates = env::var_os("CODELIT_MLX_HELPER")
        .map(PathBuf::from)
        .into_iter()
        .collect::<Vec<_>>();
    if let Ok(executable) = env::current_exe()
        && let Some(directory) = executable.parent()
    {
        candidates.push(directory.join("codelit-mlx-helper"));
    }
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../native/mlx-helper/.build/xcode/Build/Products/Release/codelit-mlx-helper"),
    );
    candidates
        .into_iter()
        .find(|candidate| is_executable(candidate))
}

fn resolve_command(command: &str, fixed_candidates: &[&str]) -> Option<PathBuf> {
    let mut candidates = fixed_candidates
        .iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin").join(command));
        candidates.push(home.join(".cargo/bin").join(command));
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|directory| directory.join(command)));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin").join(command),
        PathBuf::from("/usr/local/bin").join(command),
        PathBuf::from("/usr/bin").join(command),
    ]);
    candidates
        .into_iter()
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

pub(crate) fn read_version(path: &Path) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_probe_environment(&mut command, path);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let status = child
        .wait_timeout(Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Version probe timed out after three seconds.".into());
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("Warning:"))
        .unwrap_or("Installed; version was not reported.");
    let version = version.chars().take(200).collect::<String>();
    if output.status.success() {
        Ok(version)
    } else {
        Err(format!("Version probe failed: {version}"))
    }
}

fn read_codex_auth_state(path: &Path) -> Result<CodexAuthState, String> {
    let mut command = Command::new(path);
    command
        .args(["login", "status"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_probe_environment(&mut command, path);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let status = child
        .wait_timeout(Duration::from_secs(3))
        .map_err(|error| error.to_string())?;
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("The sign-in check timed out.".into());
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(CodexAuthState::SignedIn);
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let normalized = combined.to_ascii_lowercase();
    if normalized.contains("not logged in")
        || normalized.contains("not signed in")
        || normalized.contains("login required")
        || normalized.contains("sign in")
    {
        return Ok(CodexAuthState::SignedOut);
    }
    let detail = combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("Warning:"))
        .unwrap_or("The Codex sign-in check failed.")
        .chars()
        .take(200)
        .collect::<String>();
    Err(detail)
}

fn configure_probe_environment(command: &mut Command, command_path: &Path) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn finds_and_probes_an_explicit_executable_without_credentials() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("provider-test");
        let mut file = fs::File::create(&executable).expect("create executable");
        writeln!(file, "#!/bin/sh\nprintf 'provider 1.2.3\\n'").expect("write executable");
        let mut permissions = file.metadata().expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).expect("set executable");

        assert_eq!(
            read_version(&executable).expect("version"),
            "provider 1.2.3"
        );
        assert_eq!(
            resolve_command("provider-test", &[executable.to_str().expect("path")]),
            Some(executable)
        );
    }

    #[test]
    fn missing_executable_is_not_reported_as_ready() {
        assert!(resolve_command("definitely-not-a-codelit-provider", &[]).is_none());
    }

    #[test]
    fn codex_probe_requires_a_provider_owned_sign_in() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("codex-test");
        let mut file = fs::File::create(&executable).expect("create executable");
        writeln!(
            file,
            "#!/bin/sh\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then\n  printf 'Not logged in\\n'\n  exit 1\nfi\nprintf 'codex 1.2.3\\n'"
        )
        .expect("write executable");
        let mut permissions = file.metadata().expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).expect("set executable");

        let probe = probe_codex(&PROVIDERS[0], executable.clone(), "codex 1.2.3".into());
        assert_eq!(probe.status, "signed-out");
        assert_eq!(probe.health, "signed-out");
        assert!(!probe.can_run);
        assert!(probe.models.is_empty());
        assert_eq!(
            probe.command_path,
            Some(executable.to_string_lossy().into_owned())
        );
        assert!(probe.detail.contains("not signed in"));
    }

    #[test]
    fn codex_probe_is_ready_after_provider_owned_sign_in() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("codex-test");
        let mut file = fs::File::create(&executable).expect("create executable");
        writeln!(
            file,
            "#!/bin/sh\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then\n  printf 'Logged in using ChatGPT\\n'\n  exit 0\nfi\nprintf 'codex 1.2.3\\n'"
        )
        .expect("write executable");
        let mut permissions = file.metadata().expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).expect("set executable");

        let probe = probe_codex(&PROVIDERS[0], executable, "codex 1.2.3".into());
        assert_eq!(probe.status, "ready");
        assert_eq!(probe.health, "ready");
        assert!(probe.can_run);
        assert_eq!(probe.models.len(), 1);
        assert!(probe.detail.contains("sign-in are ready"));
    }

    #[test]
    fn app_store_sandbox_blocks_external_subscription_adapters() {
        let definition = &PROVIDERS[0];
        let directory = tempdir().expect("temporary directory");
        let probe = probe_provider(
            definition,
            directory.path(),
            ProviderPolicyProfile::Development,
            true,
        );
        assert_eq!(probe.status, "blocked-by-policy");
        assert!(!probe.can_run);
        assert!(probe.models.is_empty());
    }

    #[test]
    fn direct_policy_blocks_unapproved_subscription_adapters() {
        assert!(provider_policy_block("codex", ProviderPolicyProfile::Direct, false).is_none());
        assert!(provider_policy_block("copilot", ProviderPolicyProfile::Direct, false).is_none());
        assert!(provider_policy_block("ollama", ProviderPolicyProfile::Direct, false).is_none());
        assert!(provider_policy_block("lmstudio", ProviderPolicyProfile::Direct, false).is_none());
        assert!(provider_policy_block("mlx", ProviderPolicyProfile::Direct, false).is_none());
        for provider in ["openai", "anthropic", "gemini"] {
            assert!(
                provider_policy_block(provider, ProviderPolicyProfile::Direct, false).is_none(),
                "{provider} API unexpectedly failed the Direct provider policy"
            );
        }
        assert_eq!(
            provider_policy_block("claude", ProviderPolicyProfile::Direct, false),
            Some(CLAUDE_SUBSCRIPTION_POLICY_DETAIL)
        );
        assert_eq!(
            provider_policy_block("antigravity", ProviderPolicyProfile::Direct, false),
            Some(GOOGLE_SUBSCRIPTION_POLICY_DETAIL)
        );
    }

    #[test]
    fn direct_discovery_removes_claude_subscription_models() {
        let directory = tempdir().expect("temporary directory");
        let probe = probe_provider(
            &PROVIDERS[1],
            directory.path(),
            ProviderPolicyProfile::Direct,
            false,
        );
        assert_eq!(probe.id, "claude");
        assert_eq!(probe.status, "blocked-by-policy");
        assert!(!probe.can_run);
        assert!(probe.models.is_empty());
    }

    #[test]
    fn app_store_policy_allows_bundled_local_and_keychain_api_runtimes() {
        for provider in [
            "codex",
            "copilot",
            "claude",
            "antigravity",
            "ollama",
            "lmstudio",
        ] {
            assert!(
                provider_policy_block(provider, ProviderPolicyProfile::AppStore, false).is_some(),
                "{provider} unexpectedly passed the App Store provider policy"
            );
        }
        assert!(provider_policy_block("mlx", ProviderPolicyProfile::AppStore, false).is_none());
        for provider in ["openai", "anthropic", "gemini"] {
            assert!(
                provider_policy_block(provider, ProviderPolicyProfile::AppStore, false).is_none(),
                "{provider} API unexpectedly failed the App Store provider policy"
            );
        }
    }

    #[test]
    fn app_store_discovery_removes_codex_subscription_models() {
        let directory = tempdir().expect("temporary directory");
        let probe = probe_provider(
            &PROVIDERS[0],
            directory.path(),
            ProviderPolicyProfile::AppStore,
            false,
        );
        assert_eq!(probe.id, "codex");
        assert_eq!(probe.status, "blocked-by-policy");
        assert!(!probe.can_run);
        assert!(probe.models.is_empty());
    }

    #[test]
    fn development_keeps_the_claude_compatibility_probe_available() {
        assert!(
            provider_policy_block("claude", ProviderPolicyProfile::Development, false).is_none()
        );
        assert!(
            provider_policy_block("antigravity", ProviderPolicyProfile::Development, false)
                .is_some()
        );
    }

    #[cfg(all(feature = "direct-release", not(feature = "app-store-release")))]
    #[test]
    fn compiled_direct_release_uses_the_direct_policy() {
        assert_eq!(compiled_policy_profile(), ProviderPolicyProfile::Direct);
        assert!(ensure_provider_execution_allowed("codex").is_ok());
        assert!(ensure_provider_execution_allowed("copilot").is_ok());
        assert!(ensure_provider_execution_allowed("ollama").is_ok());
        assert!(ensure_provider_execution_allowed("lmstudio").is_ok());
        assert!(ensure_provider_execution_allowed("mlx").is_ok());
        assert!(ensure_provider_execution_allowed("openai").is_ok());
        assert!(ensure_provider_execution_allowed("anthropic").is_ok());
        assert!(ensure_provider_execution_allowed("gemini").is_ok());
        assert!(ensure_provider_execution_allowed("claude").is_err());
        assert!(ensure_provider_execution_allowed("antigravity").is_err());
    }

    #[cfg(feature = "app-store-release")]
    #[test]
    fn compiled_app_store_release_uses_the_app_store_policy() {
        assert_eq!(compiled_policy_profile(), ProviderPolicyProfile::AppStore);
        assert!(ensure_provider_execution_allowed("mlx").is_ok());
        for provider in ["openai", "anthropic", "gemini"] {
            assert!(ensure_provider_execution_allowed(provider).is_ok());
        }
        for provider in [
            "codex",
            "copilot",
            "claude",
            "antigravity",
            "ollama",
            "lmstudio",
        ] {
            assert!(
                ensure_provider_execution_allowed(provider).is_err(),
                "{provider} unexpectedly passed the compiled App Store policy"
            );
        }
    }

    #[cfg(not(any(feature = "direct-release", feature = "app-store-release")))]
    #[test]
    fn compiled_development_profile_keeps_compatibility_probes_available() {
        assert_eq!(
            compiled_policy_profile(),
            ProviderPolicyProfile::Development
        );
        assert!(ensure_provider_execution_allowed("claude").is_ok());
        assert!(ensure_provider_execution_allowed("antigravity").is_err());
    }

    #[test]
    fn provider_statuses_use_the_published_contract() {
        let directory = tempdir().expect("temporary directory");
        let probes = PROVIDERS
            .iter()
            // API-key readiness intentionally remains a runtime Keychain check. Unit tests must
            // never touch the user's real Keychain; the credential module uses its memory backend.
            .filter(|provider| provider.family != "api")
            .map(|provider| {
                probe_provider(
                    provider,
                    directory.path(),
                    ProviderPolicyProfile::Development,
                    true,
                )
            })
            .collect::<Vec<_>>();
        let allowed = [
            "not-installed",
            "signed-out",
            "ready",
            "quota-hit",
            "version-unsupported",
            "blocked-by-policy",
        ];
        assert!(probes.iter().all(|probe| allowed.contains(&probe.status)));
        for provider in PROVIDERS.iter().filter(|provider| provider.family == "api") {
            assert_eq!(provider.auth_kind(), "api-key");
            assert_eq!(provider.billing_mode(), "metered");
            assert_eq!(provider.distribution, "all");
        }
    }
}
