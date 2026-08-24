use crate::run_control::{
    CancellationToken, ProviderRunEvent, RunEventEmitter, RunRegistry, run_line_process,
};
use crate::storage::{self, AppState};
use crate::{local_browser, local_mcp, macos};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, ipc::Channel};

const TOOL_TIMEOUT: Duration = Duration::from_secs(30);
const PROJECT_CHECK_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TOOLS: usize = 8;
const MAX_CONTEXT_CHARS: usize = 32_000;
const MAX_PATHS: usize = 120;
const MAX_PATCH_BYTES: usize = 128 * 1024;
const MAX_CHANGED_PATHS: usize = 80;
const MAX_UNTRACKED_PROJECT_FILES: usize = 80;
const MAX_UNTRACKED_PROJECT_FILE_BYTES: usize = 1024 * 1024;
const MAX_UNTRACKED_PROJECT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROJECT_FINGERPRINT_FILES: usize = 10_000;
const MAX_PROJECT_FINGERPRINT_DEPTH: usize = 12;
const SAFE_GIT_PATHS: &[&str] = &[
    ".",
    ":(exclude,icase,glob)**/.env",
    ":(exclude,icase,glob)**/.env.*",
    ":(exclude,icase,glob)**/*secret*.json",
    ":(exclude,icase,glob)**/*secret*.yaml",
    ":(exclude,icase,glob)**/*secret*.yml",
    ":(exclude,icase,glob)**/*secret*.toml",
    ":(exclude,icase,glob)**/*secret*.txt",
    ":(exclude,icase,glob)**/*secret*.csv",
    ":(exclude,icase,glob)**/*credential*.json",
    ":(exclude,icase,glob)**/*credential*.yaml",
    ":(exclude,icase,glob)**/*credential*.yml",
    ":(exclude,icase,glob)**/*credential*.toml",
    ":(exclude,icase,glob)**/*credential*.txt",
    ":(exclude,icase,glob)**/*credential*.csv",
    ":(exclude,icase,glob)**/*private-key*.json",
    ":(exclude,icase,glob)**/*private-key*.yaml",
    ":(exclude,icase,glob)**/*private-key*.yml",
    ":(exclude,icase,glob)**/*private-key*.toml",
    ":(exclude,icase,glob)**/*private-key*.txt",
    ":(exclude,icase,glob)**/*.pem",
    ":(exclude,icase,glob)**/*.key",
    ":(exclude,icase,glob)**/*.p12",
    ":(exclude,icase,glob)**/*.pfx",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolBatchRequest {
    pub run_id: String,
    pub tools: Vec<String>,
    #[serde(default)]
    pub handoff: String,
    #[serde(default)]
    pub approval_sha256: Option<String>,
    #[serde(default)]
    pub tool_inputs: BTreeMap<String, Value>,
    #[serde(default)]
    pub browser_session_id: Option<String>,
    #[serde(default)]
    pub browser_project_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolApprovalRequest {
    pub run_id: String,
    pub tools: Vec<String>,
    pub source: String,
    #[serde(default)]
    pub tool_inputs: BTreeMap<String, Value>,
    #[serde(default)]
    pub browser_session_id: Option<String>,
    #[serde(default)]
    pub browser_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolApprovalPreview {
    pub run_id: String,
    pub status: String,
    pub summary: String,
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedLocalTool {
    pub tool_id: String,
    pub tool_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolFailure {
    pub tool_id: String,
    pub tool_name: String,
    pub code: String,
    pub retryable: bool,
    pub uncertain_write: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolBatchResult {
    pub run_id: String,
    pub status: String,
    pub context: Vec<String>,
    pub completed_tools: Vec<CompletedLocalTool>,
    pub failure: Option<LocalToolFailure>,
    pub browser_proofs: Vec<local_browser::LocalBrowserProof>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProjectFingerprint {
    pub sha256: String,
    pub file_count: usize,
    pub truncated: bool,
    pub captured_at: String,
}

pub fn read_local_project_fingerprint(state: &AppState) -> Result<LocalProjectFingerprint, String> {
    let bookmark = storage::load_workspace_bookmark(state)?
        .ok_or_else(|| "Choose a project folder before watching for changes.".to_string())?;
    macos::with_workspace_folder_access(&bookmark.bookmark, project_fingerprint)
}

#[derive(Debug)]
struct ToolDefinition {
    id: String,
    name: String,
    kind: ToolKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ToolKind {
    Files,
    FolderListing,
    SelectedFiles,
    GitStatus,
    GitDiff,
    Check,
    PatchApply,
    ProjectTest,
    ProjectTypecheck,
    ProjectLint,
    Mcp,
    BrowserRead,
    BrowserAct,
}

impl ToolKind {
    fn project_script(&self) -> Option<&'static str> {
        match self {
            Self::ProjectTest => Some("test"),
            Self::ProjectTypecheck => Some("typecheck"),
            Self::ProjectLint => Some("lint"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedProjectCheck {
    schema_version: u8,
    run_id: String,
    tool_name: String,
    script_name: String,
    script_body: String,
    command_display: String,
    program: String,
    package_manager: String,
    arguments: Vec<String>,
    program_sha256: String,
    package_manager_sha256: String,
    package_json_sha256: String,
    repository_state_sha256: String,
}

#[derive(Debug)]
struct RepositoryState {
    staged_diff: String,
    unstaged_diff: String,
    untracked_files: Vec<UntrackedProjectFile>,
    sha256: String,
}

#[derive(Debug)]
struct UntrackedProjectFile {
    relative: String,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct ResolvedProjectCommand {
    script_body: String,
    program: PathBuf,
    package_manager: PathBuf,
    arguments: Vec<String>,
    display: String,
}

pub fn prepare_local_tool_approval(
    state: &AppState,
    request: LocalToolApprovalRequest,
    registry: &RunRegistry,
    channel: Option<Channel<ProviderRunEvent>>,
) -> Result<LocalToolApprovalPreview, String> {
    validate_run_id(&request.run_id)?;
    if request.tools.is_empty() || request.tools.len() > MAX_TOOLS {
        return Err(format!("Choose between 1 and {MAX_TOOLS} local tools."));
    }
    let tools = request
        .tools
        .iter()
        .map(|name| resolve_tool(name))
        .collect::<Result<Vec<_>, _>>()?;
    let browser_tools = tools
        .iter()
        .filter(|tool| matches!(&tool.kind, ToolKind::BrowserRead | ToolKind::BrowserAct))
        .collect::<Vec<_>>();
    if !browser_tools.is_empty() {
        if browser_tools.len() != tools.len() {
            return Err("Review browser actions separately from project and MCP tools.".into());
        }
        if !browser_tools
            .iter()
            .any(|tool| matches!(&tool.kind, ToolKind::BrowserAct))
        {
            return Err("Browser reads do not require a write approval.".into());
        }
        let session_id = request
            .browser_session_id
            .as_deref()
            .ok_or("Open this Project's Browser panel before reviewing the action.")?;
        let project_id = request
            .browser_project_id
            .as_deref()
            .ok_or("The browser action is missing its local Project boundary.")?;
        let active_run = registry.begin(&request.run_id)?;
        let _cancellation = active_run.token();
        let emitter = RunEventEmitter::new(&request.run_id, "local-browser", "native", channel);
        emitter.emit("started", "Rechecking the exact browser action", None);
        let preview = local_browser::prepare_browser_tool_batch(
            state,
            &request.run_id,
            session_id,
            project_id,
            &request.tools,
            &request.tool_inputs,
            &request.source,
        )?;
        emitter.emit(
            "checkpoint",
            "Exact browser action is ready for review",
            Some(json!({ "approvalSha256": preview.approval_sha256 })),
        );
        return Ok(LocalToolApprovalPreview {
            run_id: request.run_id,
            status: "ready".into(),
            summary: preview.summary,
            evidence: preview.evidence,
            patch_sha256: None,
            approval_sha256: Some(preview.approval_sha256),
        });
    }
    let mcp_tools = tools
        .iter()
        .filter(|tool| matches!(&tool.kind, ToolKind::Mcp))
        .collect::<Vec<_>>();
    if !mcp_tools.is_empty() {
        if mcp_tools.len() != tools.len() {
            return Err("Review local MCP calls separately from project tools.".into());
        }
        reject_external_tools_in_app_sandbox(&tools)?;
        let active_run = registry.begin(&request.run_id)?;
        let cancellation = active_run.token();
        let emitter = RunEventEmitter::new(&request.run_id, "local-mcp", "native", channel);
        emitter.emit("started", "Rechecking the exact local MCP calls", None);
        let preview = local_mcp::prepare_mcp_tool_batch(
            state,
            &request.run_id,
            &request.tools,
            &request.tool_inputs,
            &request.source,
            &cancellation,
        )?;
        emitter.emit(
            "checkpoint",
            "Exact local MCP calls are ready for review",
            Some(json!({ "approvalSha256": preview.approval_sha256 })),
        );
        return Ok(LocalToolApprovalPreview {
            run_id: request.run_id,
            status: "ready".into(),
            summary: preview.summary,
            evidence: preview.evidence,
            patch_sha256: None,
            approval_sha256: Some(preview.approval_sha256),
        });
    }
    let prepares_patch = tools
        .iter()
        .any(|tool| matches!(&tool.kind, ToolKind::PatchApply));
    let project_checks = tools
        .iter()
        .filter(|tool| tool.kind.project_script().is_some())
        .collect::<Vec<_>>();
    if !prepares_patch && project_checks.is_empty() {
        return Err("This local action does not have a preparation step.".into());
    }
    if prepares_patch && !project_checks.is_empty() {
        return Err("Review a patch and project checks as separate local actions.".into());
    }
    reject_external_tools_in_app_sandbox(&tools)?;
    let bookmark = storage::load_workspace_bookmark(state)?
        .ok_or("Choose a project folder before preparing local changes.")?;
    let active_run = registry.begin(&request.run_id)?;
    let cancellation = active_run.token();
    let emitter = RunEventEmitter::new(&request.run_id, "local-tools", "native", channel);
    emitter.emit(
        "started",
        if prepares_patch {
            "Preparing an isolated patch preview"
        } else {
            "Preparing isolated project checks"
        },
        None,
    );
    let result = macos::with_workspace_folder_access(&bookmark.bookmark, |root| {
        if prepares_patch {
            prepare_patch_in_root(
                &request.run_id,
                root,
                &state.app_data_dir(),
                &request.source,
                &cancellation,
            )
        } else {
            prepare_project_checks_in_root(
                &request.run_id,
                root,
                &state.app_data_dir(),
                &project_checks,
                &package_manager_search_dirs(),
                &cancellation,
            )
        }
    })?;
    emitter.emit(
        "checkpoint",
        if prepares_patch {
            "Isolated patch preview is ready for review"
        } else {
            "Project checks are ready for review"
        },
        Some(json!({ "patchSha256": result.patch_sha256, "summary": result.summary })),
    );
    Ok(result)
}

pub fn run_local_tool_batch_with_browser(
    app: &AppHandle,
    state: &AppState,
    browser_registry: &local_browser::BrowserRegistry,
    request: LocalToolBatchRequest,
    registry: &RunRegistry,
    channel: Option<Channel<ProviderRunEvent>>,
) -> Result<LocalToolBatchResult, String> {
    run_local_tool_batch_inner(
        state,
        request,
        registry,
        channel,
        Some(app),
        Some(browser_registry),
    )
}

fn run_local_tool_batch_inner(
    state: &AppState,
    request: LocalToolBatchRequest,
    registry: &RunRegistry,
    channel: Option<Channel<ProviderRunEvent>>,
    app: Option<&AppHandle>,
    browser_registry: Option<&local_browser::BrowserRegistry>,
) -> Result<LocalToolBatchResult, String> {
    validate_run_id(&request.run_id)?;
    if request.tools.is_empty() || request.tools.len() > MAX_TOOLS {
        return Err(format!("Choose between 1 and {MAX_TOOLS} local tools."));
    }
    if request.handoff.chars().count() > 12_000 {
        return Err("The local tool handoff is too large.".into());
    }
    let tools = request
        .tools
        .iter()
        .map(|name| resolve_tool(name))
        .collect::<Result<Vec<_>, _>>()?;
    let browser_tool_count = tools
        .iter()
        .filter(|tool| matches!(&tool.kind, ToolKind::BrowserRead | ToolKind::BrowserAct))
        .count();
    if browser_tool_count > 0 {
        if browser_tool_count != tools.len() {
            return Err("Run browser actions separately from project and MCP tools.".into());
        }
        let app = app.ok_or("The in-window browser is unavailable in this runtime.")?;
        let browser_registry = browser_registry
            .ok_or("The in-window browser registry is unavailable in this runtime.")?;
        let session_id = request
            .browser_session_id
            .as_deref()
            .ok_or("Open this Project's Browser panel before running the browser step.")?;
        let project_id = request
            .browser_project_id
            .as_deref()
            .ok_or("The browser step is missing its local Project boundary.")?;
        let active_run = registry.begin(&request.run_id)?;
        let cancellation = active_run.token();
        let emitter = RunEventEmitter::new(&request.run_id, "local-browser", "native", channel);
        emitter.emit("queued", "Local browser step queued", None);
        emitter.emit("started", "Inspecting the approved in-window page", None);
        let executed = local_browser::execute_browser_tool_batch(
            app,
            state,
            browser_registry,
            &request.run_id,
            session_id,
            project_id,
            &request.tools,
            &request.tool_inputs,
            &request.handoff,
            request.approval_sha256.as_deref(),
            &cancellation,
        )?;
        let mut context = Vec::new();
        let mut completed_tools = Vec::new();
        let mut browser_proofs = Vec::new();
        for tool in executed.completed {
            let remaining = MAX_CONTEXT_CHARS.saturating_sub(context_size(&context));
            let bounded = bound_text(&tool.output, remaining);
            if bounded.is_empty() {
                return Err("Local browser output exceeded the safe context limit.".into());
            }
            context.push(format!("{}:\n{}", tool.tool_name, bounded));
            completed_tools.push(CompletedLocalTool {
                tool_id: tool.tool_id.clone(),
                tool_name: tool.tool_name.clone(),
            });
            browser_proofs.push(tool.proof);
            emitter.emit(
                "tool-result",
                format!("{} finished", tool.tool_name),
                Some(json!({ "toolId": tool.tool_id, "toolName": tool.tool_name })),
            );
        }
        let failure = executed.failure.map(|failure| {
            emitter.emit(
                if failure.code == "cancelled" {
                    "canceled"
                } else {
                    "failed"
                },
                failure.message,
                Some(json!({
                    "toolId": failure.tool_id,
                    "toolName": failure.tool_name,
                    "uncertainWrite": failure.uncertain_write,
                })),
            );
            LocalToolFailure {
                tool_id: failure.tool_id,
                tool_name: failure.tool_name,
                code: failure.code,
                retryable: failure.retryable,
                uncertain_write: failure.uncertain_write,
            }
        });
        if failure.is_none() {
            emitter.emit("completed", "Local browser step completed", None);
        }
        return Ok(LocalToolBatchResult {
            run_id: request.run_id,
            status: if failure.is_some() {
                "failed"
            } else {
                "completed"
            }
            .into(),
            context,
            completed_tools,
            failure,
            browser_proofs,
        });
    }
    reject_external_tools_in_app_sandbox(&tools)?;
    let mcp_tool_count = tools
        .iter()
        .filter(|tool| matches!(&tool.kind, ToolKind::Mcp))
        .count();
    if mcp_tool_count > 0 {
        if mcp_tool_count != tools.len() {
            return Err("Run local MCP calls separately from project tools.".into());
        }
        let approval_sha256 = request
            .approval_sha256
            .as_deref()
            .ok_or("Review and approve the exact local MCP call before it runs.")?;
        let active_run = registry.begin(&request.run_id)?;
        let cancellation = active_run.token();
        let emitter = RunEventEmitter::new(&request.run_id, "local-mcp", "native", channel);
        emitter.emit("queued", "Approved local MCP calls queued", None);
        emitter.emit("started", "Rechecking local MCP approvals", None);
        let executed = local_mcp::execute_prepared_mcp_batch(
            state,
            &request.run_id,
            &request.tools,
            approval_sha256,
            &cancellation,
        )?;
        let mut context = Vec::new();
        let mut completed_tools = Vec::new();
        for tool in executed.completed {
            let remaining = MAX_CONTEXT_CHARS.saturating_sub(context_size(&context));
            let bounded = bound_text(&tool.output, remaining);
            if bounded.is_empty() {
                return Err("Local MCP output exceeded the safe context limit.".into());
            }
            context.push(format!("{}:\n{}", tool.tool_name, bounded));
            completed_tools.push(CompletedLocalTool {
                tool_id: tool.tool_reference.clone(),
                tool_name: tool.tool_name.clone(),
            });
            emitter.emit(
                "tool-result",
                format!("{} finished", tool.tool_name),
                Some(json!({
                    "toolId": tool.tool_reference,
                    "toolName": tool.tool_name,
                    "effect": tool.effect,
                })),
            );
        }
        let failure = executed.failure.map(|failure| {
            emitter.emit(
                if failure.code == "cancelled" {
                    "canceled"
                } else {
                    "failed"
                },
                failure.message,
                Some(json!({
                    "toolId": failure.tool_reference,
                    "toolName": failure.tool_name,
                    "uncertainWrite": failure.uncertain_write,
                })),
            );
            LocalToolFailure {
                tool_id: failure.tool_reference,
                tool_name: failure.tool_name,
                code: failure.code,
                retryable: failure.retryable,
                uncertain_write: failure.uncertain_write,
            }
        });
        if failure.is_none() {
            emitter.emit("completed", "Local MCP calls completed", None);
        }
        return Ok(LocalToolBatchResult {
            run_id: request.run_id,
            status: if failure.is_some() {
                "failed"
            } else {
                "completed"
            }
            .into(),
            context,
            completed_tools,
            failure,
            browser_proofs: Vec::new(),
        });
    }
    let bookmark = storage::load_workspace_bookmark(state)?
        .ok_or("Choose a project folder before running local tools.")?;
    let active_run = registry.begin(&request.run_id)?;
    let cancellation = active_run.token();
    let emitter = RunEventEmitter::new(&request.run_id, "local-tools", "native", channel);
    emitter.emit("queued", "Local tools queued", None);
    emitter.emit("started", "Inspecting the selected project", None);

    let execution = macos::with_workspace_folder_access(&bookmark.bookmark, |root| {
        execute_in_root(
            &request.run_id,
            root,
            &state.app_data_dir(),
            &request.handoff,
            tools,
            &cancellation,
            &emitter,
        )
    });
    match execution {
        Ok(result) => {
            emitter.emit(
                "completed",
                "Local tools completed",
                Some(json!({ "completedTools": &result.completed_tools })),
            );
            Ok(result)
        }
        Err(error) => {
            emitter.emit(
                if cancellation.is_canceled() {
                    "canceled"
                } else {
                    "failed"
                },
                if cancellation.is_canceled() {
                    "Local tools were stopped"
                } else {
                    "Local tools could not complete"
                },
                None,
            );
            Err(error)
        }
    }
}

fn execute_in_root(
    run_id: &str,
    root: &Path,
    app_data_dir: &Path,
    handoff: &str,
    tools: Vec<ToolDefinition>,
    cancellation: &CancellationToken,
    emitter: &RunEventEmitter,
) -> Result<LocalToolBatchResult, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "The selected project folder is no longer available.".to_string())?;
    if !root.is_dir() {
        return Err("The selected project folder is no longer a directory.".into());
    }
    let mut context = Vec::new();
    let mut completed_tools = Vec::new();
    let has_project_checks = tools
        .iter()
        .any(|tool| tool.kind.project_script().is_some());
    let execution = (|| {
        for tool in tools {
            if cancellation.is_canceled() {
                return Err("Local tool execution was canceled.".into());
            }
            let effect = if matches!(&tool.kind, ToolKind::PatchApply) {
                "write"
            } else {
                "read"
            };
            emitter.emit(
                "tool-request",
                format!("Running {}", tool.name),
                Some(json!({ "toolId": tool.id, "toolName": tool.name, "effect": effect })),
            );
            let output = match tool.kind {
                ToolKind::Files => repository_context(&root)?,
                ToolKind::FolderListing => folder_listing_context(&root)?,
                ToolKind::SelectedFiles => selected_file_context(&root, handoff)?,
                ToolKind::GitStatus => {
                    git_context(&root, &["status", "--short", "--branch"], cancellation)?
                }
                ToolKind::GitDiff => git_context(
                    &root,
                    &["diff", "--no-ext-diff", "--unified=3"],
                    cancellation,
                )?,
                ToolKind::Check => git_context(&root, &["diff", "--check"], cancellation)?,
                ToolKind::PatchApply => {
                    apply_prepared_patch(&root, app_data_dir, run_id, cancellation)?
                }
                ToolKind::ProjectTest | ToolKind::ProjectTypecheck | ToolKind::ProjectLint => {
                    let script_name = tool
                        .kind
                        .project_script()
                        .ok_or("The selected project check is invalid.")?;
                    execute_prepared_project_check(
                        &root,
                        app_data_dir,
                        run_id,
                        &tool.name,
                        script_name,
                        cancellation,
                    )?
                }
                ToolKind::Mcp => {
                    return Err(
                        "Local MCP tools must run through their reviewed call boundary.".into(),
                    );
                }
                ToolKind::BrowserRead | ToolKind::BrowserAct => {
                    return Err(
                        "Browser tools must run through the in-window browser boundary.".into(),
                    );
                }
            };
            let bounded = bound_text(
                &output,
                MAX_CONTEXT_CHARS.saturating_sub(context_size(&context)),
            );
            if bounded.is_empty() {
                return Err("Local tool output exceeded the safe context limit.".into());
            }
            context.push(format!("{}:\n{}", tool.name, bounded));
            completed_tools.push(CompletedLocalTool {
                tool_id: tool.id.clone(),
                tool_name: tool.name.clone(),
            });
            emitter.emit(
                "tool-result",
                format!("{} finished", tool.name),
                Some(json!({ "toolId": tool.id, "toolName": tool.name, "effect": effect })),
            );
        }
        Ok(LocalToolBatchResult {
            run_id: run_id.into(),
            status: "completed".into(),
            context,
            completed_tools,
            failure: None,
            browser_proofs: Vec::new(),
        })
    })();
    if has_project_checks {
        cleanup_staging(&root, &staging_run_dir(app_data_dir, run_id), cancellation);
    }
    execution
}

fn resolve_tool(name: &str) -> Result<ToolDefinition, String> {
    let cleaned = name.trim();
    if local_mcp::parse_local_mcp_tool_reference(cleaned)?.is_some() {
        return Ok(ToolDefinition {
            id: cleaned.into(),
            name: cleaned.into(),
            kind: ToolKind::Mcp,
        });
    }
    let normalized = cleaned.to_ascii_lowercase();
    let (id, kind) = match normalized.as_str() {
        "browser read" => ("browser-read", ToolKind::BrowserRead),
        "browser act" => ("browser-act", ToolKind::BrowserAct),
        "selected folder" | "filesystem read" | "repository files" => {
            ("filesystem-read", ToolKind::Files)
        }
        "folder listing" | "list selected folder" | "directory listing" => {
            ("folder-listing", ToolKind::FolderListing)
        }
        "selected files" | "file read" | "repository file read" => {
            ("selected-files-read", ToolKind::SelectedFiles)
        }
        "git read" | "git status" => ("git-read", ToolKind::GitStatus),
        "diff read" | "git diff" => ("git-diff", ToolKind::GitDiff),
        "local checks" | "diff check" => ("shell-check", ToolKind::Check),
        "project test" => ("project-test", ToolKind::ProjectTest),
        "project typecheck" => ("project-typecheck", ToolKind::ProjectTypecheck),
        "project lint" => ("project-lint", ToolKind::ProjectLint),
        "patch apply" | "apply patch" | "apply approved patch" => {
            ("patch-apply", ToolKind::PatchApply)
        }
        _ => {
            return Err(format!(
                "{cleaned} is not available in the local tool runtime yet."
            ));
        }
    };
    Ok(ToolDefinition {
        id: id.into(),
        name: cleaned.to_string(),
        kind,
    })
}

fn reject_external_tools_in_app_sandbox(tools: &[ToolDefinition]) -> Result<(), String> {
    if std::env::var_os("APP_SANDBOX_CONTAINER_ID").is_some()
        && tools.iter().any(|tool| {
            !matches!(
                &tool.kind,
                ToolKind::Files | ToolKind::FolderListing | ToolKind::SelectedFiles
            )
        })
    {
        return Err(
            "Git and developer tools are available only in Codelit's notarized Direct build."
                .into(),
        );
    }
    Ok(())
}

fn prepare_project_checks_in_root(
    run_id: &str,
    root: &Path,
    app_data_dir: &Path,
    tools: &[&ToolDefinition],
    search_dirs: &[PathBuf],
    cancellation: &CancellationToken,
) -> Result<LocalToolApprovalPreview, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "The selected project folder is no longer available.".to_string())?;
    ensure_git_repository(&root, cancellation)?;
    if tools.is_empty() {
        return Err("Choose at least one project check to review.".into());
    }
    let run_dir = staging_run_dir(app_data_dir, run_id);
    let worktree = run_dir.join("worktree");
    cleanup_staging(&root, &run_dir, cancellation);
    fs::create_dir_all(&run_dir)
        .map_err(|_| "Codelit could not create isolated check staging.".to_string())?;

    let setup = (|| {
        require_git_success(
            run_git(
                &root,
                vec![
                    "worktree".into(),
                    "add".into(),
                    "--detach".into(),
                    worktree.as_os_str().to_owned(),
                    "HEAD".into(),
                ],
                cancellation,
                true,
            )?,
            "Codelit could not create the isolated check worktree.",
        )?;
        let repository_state = repository_state(&root, cancellation)?;
        apply_repository_state(&worktree, &run_dir, &repository_state, cancellation)?;
        remove_protected_worktree_files(&worktree)?;
        copy_untracked_project_files(&worktree, &repository_state.untracked_files)?;
        let dependency_roots = link_project_dependencies(&root, &worktree)?;
        let package_json =
            read_bounded_file(&worktree.join("package.json"), 1024 * 1024).map_err(|_| {
                "This project does not have a readable package.json at its root.".to_string()
            })?;
        let package_json_sha256 = sha256_hex(&package_json);
        let mut prepared = Vec::new();
        let mut evidence = Vec::new();
        for tool in tools {
            let script_name = tool
                .kind
                .project_script()
                .ok_or("Only predefined project checks can use this approval.")?;
            let command = resolve_project_command(&root, &package_json, script_name, search_dirs)?;
            let program_sha256 = sha256_file(&command.program)?;
            let package_manager_sha256 = sha256_file(&command.package_manager)?;
            evidence.push(format!(
                "{}\nScript: {} = {}",
                command.display, script_name, command.script_body
            ));
            prepared.push(PreparedProjectCheck {
                schema_version: 1,
                run_id: run_id.into(),
                tool_name: tool.name.clone(),
                script_name: script_name.into(),
                script_body: command.script_body,
                command_display: command.display,
                program: command.program.to_string_lossy().into_owned(),
                package_manager: command.package_manager.to_string_lossy().into_owned(),
                arguments: command.arguments,
                program_sha256,
                package_manager_sha256,
                package_json_sha256: package_json_sha256.clone(),
                repository_state_sha256: repository_state.sha256.clone(),
            });
        }
        let profile_path = run_dir.join("project-check.sb");
        let profile =
            project_check_sandbox_profile(&run_dir, &worktree, &dependency_roots, &prepared)?;
        fs::write(&profile_path, profile)
            .map_err(|_| "Codelit could not save the isolated check policy.".to_string())?;
        write_prepared_project_checks(&run_dir, &prepared)?;
        evidence.push("Network: blocked".into());
        evidence.push("Writes: isolated staging only".into());
        evidence.push(format!("Source snapshot: {}", repository_state.sha256));
        Ok(LocalToolApprovalPreview {
            run_id: run_id.into(),
            status: "ready".into(),
            summary: format!(
                "{} project {} ready in isolated staging",
                prepared.len(),
                if prepared.len() == 1 {
                    "check is"
                } else {
                    "checks are"
                },
            ),
            evidence,
            patch_sha256: None,
            approval_sha256: None,
        })
    })();
    if setup.is_err() {
        cleanup_staging(&root, &run_dir, cancellation);
    }
    setup
}

fn execute_prepared_project_check(
    root: &Path,
    app_data_dir: &Path,
    run_id: &str,
    tool_name: &str,
    script_name: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let run_dir = staging_run_dir(app_data_dir, run_id);
    let worktree = run_dir.join("worktree");
    let prepared = read_prepared_project_checks(&run_dir)?;
    let check = prepared
        .iter()
        .find(|candidate| {
            candidate.run_id == run_id
                && candidate.tool_name.eq_ignore_ascii_case(tool_name)
                && candidate.script_name == script_name
        })
        .ok_or("Prepare and review this project check again before running it.")?;
    if check.schema_version != 1 {
        return Err("The prepared project check uses an unsupported version.".into());
    }
    let current_state = repository_state(root, cancellation)?;
    if current_state.sha256 != check.repository_state_sha256 {
        return Err(
            "The selected repository changed after review. Prepare the project check again.".into(),
        );
    }
    let canonical_run_dir = run_dir
        .canonicalize()
        .map_err(|_| "The isolated project check is missing. Prepare it again.".to_string())?;
    let canonical_worktree = worktree
        .canonicalize()
        .map_err(|_| "The isolated check worktree is missing. Prepare it again.".to_string())?;
    if !canonical_worktree.starts_with(&canonical_run_dir) {
        return Err("The isolated check worktree failed its path boundary.".into());
    }
    let package_json = read_bounded_file(&canonical_worktree.join("package.json"), 1024 * 1024)
        .map_err(|_| "The reviewed package.json is no longer available.".to_string())?;
    if sha256_hex(&package_json) != check.package_json_sha256 {
        return Err("package.json changed after review. Prepare the project check again.".into());
    }
    let program = canonical_approved_executable(Path::new(&check.program), root)?;
    let package_manager = canonical_approved_executable(Path::new(&check.package_manager), root)?;
    if sha256_file(&program)? != check.program_sha256
        || sha256_file(&package_manager)? != check.package_manager_sha256
    {
        return Err("A reviewed project-check executable changed. Prepare the check again.".into());
    }
    if check.arguments.first().map(String::as_str)
        != Some(package_manager.to_string_lossy().as_ref())
    {
        return Err("The prepared project-check command failed its integrity check.".into());
    }
    let profile = canonical_run_dir.join("project-check.sb");
    if !profile.is_file() || !Path::new("/usr/bin/sandbox-exec").is_file() {
        return Err("The local project-check sandbox is unavailable on this Mac.".into());
    }
    let home = canonical_run_dir.join("home");
    let temporary = canonical_run_dir.join("tmp");
    let cache = canonical_run_dir.join("cache");
    for directory in [&home, &temporary, &cache] {
        fs::create_dir_all(directory)
            .map_err(|_| "Codelit could not prepare isolated check storage.".to_string())?;
    }
    let path = format!(
        "{}:/usr/bin:/bin",
        program
            .parent()
            .unwrap_or(Path::new("/usr/bin"))
            .to_string_lossy()
    );
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .arg("-f")
        .arg(&profile)
        .arg(&program)
        .args(&check.arguments)
        .current_dir(&canonical_worktree)
        .env_clear()
        .env("PATH", path)
        .env("HOME", &home)
        .env("TMPDIR", &temporary)
        .env("XDG_CACHE_HOME", &cache)
        .env("npm_config_cache", cache.join("npm"))
        .env(
            "npm_config_userconfig",
            canonical_run_dir.join("empty-npmrc"),
        )
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdin(Stdio::null());
    let output = run_line_process(command, PROJECT_CHECK_TIMEOUT, cancellation, |_, _| {})?;
    let detail = sanitize_tool_output(&format!("{}\n{}", output.stdout, output.stderr));
    Ok(format!(
        "{}\nScript: {} = {}\nexit={}\n{}",
        check.command_display,
        check.script_name,
        check.script_body,
        output.status.code().unwrap_or(-1),
        if detail.trim().is_empty() {
            "No output.".into()
        } else {
            bound_text(detail.trim(), 28_000)
        }
    ))
}

fn package_manager_search_dirs() -> Vec<PathBuf> {
    let mut directories = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            if directory.is_absolute() && !directories.contains(&directory) {
                directories.push(directory);
            }
        }
    }
    directories
}

fn resolve_project_command(
    root: &Path,
    package_json: &[u8],
    script_name: &str,
    search_dirs: &[PathBuf],
) -> Result<ResolvedProjectCommand, String> {
    let package: serde_json::Value = serde_json::from_slice(package_json)
        .map_err(|_| "package.json is not valid JSON.".to_string())?;
    let scripts = package
        .get("scripts")
        .and_then(serde_json::Value::as_object)
        .ok_or("package.json does not define project scripts.")?;
    let script_body = scripts
        .get(script_name)
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            !value.trim().is_empty()
                && value.len() <= 4096
                && value
                    .chars()
                    .all(|character| matches!(character, '\n' | '\t') || !character.is_control())
        })
        .ok_or_else(|| format!("package.json does not define a safe {script_name} script."))?
        .to_string();
    let package_manager_name = package
        .get("packageManager")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.split('@').next())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            if root.join("pnpm-lock.yaml").is_file() {
                Some("pnpm".into())
            } else if root.join("package-lock.json").is_file() {
                Some("npm".into())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "npm".into());
    if !matches!(package_manager_name.as_str(), "npm" | "pnpm") {
        return Err(format!(
            "{package_manager_name} project checks are not available yet. Use npm or pnpm."
        ));
    }
    let package_manager = find_approved_executable(&package_manager_name, search_dirs, root)?;
    let program = find_approved_executable("node", search_dirs, root)?;
    let arguments = vec![
        package_manager.to_string_lossy().into_owned(),
        "run".into(),
        script_name.into(),
    ];
    let display = display_command(&program, &arguments);
    Ok(ResolvedProjectCommand {
        script_body,
        program,
        package_manager,
        arguments,
        display,
    })
}

fn find_approved_executable(
    name: &str,
    search_dirs: &[PathBuf],
    root: &Path,
) -> Result<PathBuf, String> {
    for directory in search_dirs {
        let candidate = directory.join(name);
        if let Ok(canonical) = canonical_approved_executable(&candidate, root) {
            return Ok(canonical);
        }
    }
    Err(format!(
        "Install {name}, then prepare this project check again."
    ))
}

fn canonical_approved_executable(path: &Path, root: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Project-check executables must use absolute paths.".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "A project-check executable is no longer available.".to_string())?;
    let root = root
        .canonicalize()
        .map_err(|_| "The selected project folder is no longer available.".to_string())?;
    let metadata = fs::metadata(&canonical)
        .map_err(|_| "A project-check executable is no longer available.".to_string())?;
    if !metadata.is_file() || canonical.starts_with(root) {
        return Err("Project-check executables cannot come from the selected repository.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("A project-check executable is not executable.".into());
        }
    }
    Ok(canonical)
}

fn repository_state(
    root: &Path,
    cancellation: &CancellationToken,
) -> Result<RepositoryState, String> {
    ensure_git_repository(root, cancellation)?;
    let head = require_git_success(
        run_git(
            root,
            vec!["rev-parse".into(), "HEAD".into()],
            cancellation,
            false,
        )?,
        "The selected repository does not have a readable HEAD revision.",
    )?
    .stdout;
    let staged_diff = require_git_success(
        run_git_with_safe_paths(
            root,
            &["diff", "--cached", "--no-ext-diff", "--binary"],
            cancellation,
            false,
        )?,
        "Codelit could not snapshot staged project changes.",
    )?
    .stdout;
    let unstaged_diff = require_git_success(
        run_git_with_safe_paths(
            root,
            &["diff", "--no-ext-diff", "--binary"],
            cancellation,
            false,
        )?,
        "Codelit could not snapshot project changes.",
    )?
    .stdout;
    let untracked = require_git_success(
        run_git_with_safe_paths(
            root,
            &["ls-files", "--others", "--exclude-standard", "-z"],
            cancellation,
            false,
        )?,
        "Codelit could not inspect untracked project files.",
    )?
    .stdout;
    let untracked_files = read_untracked_project_files(root, &untracked)?;
    let mut digest = Sha256::new();
    digest.update(head.as_bytes());
    digest.update([0]);
    digest.update(staged_diff.as_bytes());
    digest.update([0]);
    digest.update(unstaged_diff.as_bytes());
    digest.update([0]);
    for file in &untracked_files {
        digest.update(file.relative.as_bytes());
        digest.update([0]);
        digest.update(&file.bytes);
        digest.update([0]);
    }
    Ok(RepositoryState {
        staged_diff,
        unstaged_diff,
        untracked_files,
        sha256: format!("{:x}", digest.finalize()),
    })
}

fn read_untracked_project_files(
    root: &Path,
    raw_paths: &str,
) -> Result<Vec<UntrackedProjectFile>, String> {
    let mut relative_paths = raw_paths
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    relative_paths.sort();
    relative_paths.dedup();
    if relative_paths.len() > MAX_UNTRACKED_PROJECT_FILES {
        return Err(format!(
            "This project has more than {MAX_UNTRACKED_PROJECT_FILES} safe untracked files. Stage or remove some before review."
        ));
    }

    let mut total_bytes = 0_usize;
    let mut files = Vec::with_capacity(relative_paths.len());
    for relative in relative_paths {
        let relative_path = Path::new(&relative);
        if relative_path.is_absolute() || !safe_text_path(relative_path) {
            return Err("An untracked project file has a protected or unsafe path.".into());
        }
        if !safe_file_without_symlinks(root, relative_path) {
            return Err("Untracked symbolic links cannot enter an isolated project check.".into());
        }
        let bytes = read_bounded_file(
            &root.join(relative_path),
            MAX_UNTRACKED_PROJECT_FILE_BYTES,
        )
        .map_err(|_| {
            format!(
                "Untracked file {relative} exceeds the 1 MiB project-check limit or could not be read."
            )
        })?;
        total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| "The untracked project snapshot is too large.".to_string())?;
        if total_bytes > MAX_UNTRACKED_PROJECT_BYTES {
            return Err("Safe untracked files exceed the 8 MiB project-check limit.".into());
        }
        files.push(UntrackedProjectFile { relative, bytes });
    }
    Ok(files)
}

fn apply_repository_state(
    worktree: &Path,
    run_dir: &Path,
    state: &RepositoryState,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let mut changed = false;
    for (name, diff) in [
        ("staged-source.diff", state.staged_diff.as_str()),
        ("unstaged-source.diff", state.unstaged_diff.as_str()),
    ] {
        if diff.trim().is_empty() {
            continue;
        }
        changed = true;
        let path = run_dir.join(name);
        fs::write(&path, diff.as_bytes())
            .map_err(|_| "Codelit could not save the isolated source snapshot.".to_string())?;
        let applied = require_git_success(
            run_git(
                worktree,
                vec!["apply".into(), path.as_os_str().to_owned()],
                cancellation,
                true,
            )?,
            "The current project changes could not be copied into isolated staging.",
        );
        let _ = fs::remove_file(&path);
        applied?;
    }
    if changed {
        validate_changed_paths(worktree, cancellation)?;
    }
    Ok(())
}

fn copy_untracked_project_files(
    worktree: &Path,
    files: &[UntrackedProjectFile],
) -> Result<(), String> {
    for file in files {
        let relative = Path::new(&file.relative);
        let destination = worktree.join(relative);
        let parent = destination
            .parent()
            .ok_or_else(|| "An untracked project path has no safe parent.".to_string())?;
        create_project_directories_without_symlinks(worktree, parent)?;
        if fs::symlink_metadata(&destination).is_ok() {
            return Err("An untracked project file conflicts with isolated staging.".into());
        }
        fs::write(&destination, &file.bytes).map_err(|_| {
            "Codelit could not copy a safe untracked file into isolated staging.".to_string()
        })?;
    }
    Ok(())
}

fn create_project_directories_without_symlinks(
    root: &Path,
    destination: &Path,
) -> Result<(), String> {
    let relative = destination
        .strip_prefix(root)
        .map_err(|_| "An untracked project path escaped isolated staging.".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(
                    "An untracked project directory conflicts with isolated staging.".into(),
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| {
                    "Codelit could not create an isolated untracked project directory.".to_string()
                })?;
            }
            Err(_) => {
                return Err("Codelit could not inspect an isolated project directory.".into());
            }
        }
    }
    Ok(())
}

fn link_project_dependencies(root: &Path, worktree: &Path) -> Result<Vec<PathBuf>, String> {
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    let mut linked = Vec::new();
    while let Some((directory, depth)) = pending.pop() {
        if depth > 5 || linked.len() >= 24 {
            continue;
        }
        let mut entries = fs::read_dir(&directory)
            .map_err(|_| "Codelit could not inspect project dependency folders.".to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Codelit could not inspect project dependency folders.".to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let file_type = entry
                .file_type()
                .map_err(|_| "Codelit could not inspect a dependency folder.".to_string())?;
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "node_modules" {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| "A dependency folder escaped the selected project.".to_string())?
                    .to_path_buf();
                let canonical = entry
                    .path()
                    .canonicalize()
                    .map_err(|_| "A project dependency folder is unavailable.".to_string())?;
                let destination = worktree.join(&relative);
                let parent = destination
                    .parent()
                    .ok_or("A dependency folder has an invalid destination.")?;
                fs::create_dir_all(parent).map_err(|_| {
                    "Codelit could not prepare a nested dependency mount.".to_string()
                })?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(&canonical, &destination).map_err(|_| {
                    "Codelit could not attach project dependencies to isolated staging.".to_string()
                })?;
                linked.push(canonical);
                if linked.len() >= 24 {
                    break;
                }
                continue;
            }
            if excluded_name(&name) {
                continue;
            }
            pending.push((entry.path(), depth + 1));
        }
    }
    Ok(linked)
}

fn remove_protected_worktree_files(worktree: &Path) -> Result<(), String> {
    let mut pending = vec![worktree.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|_| "Codelit could not sanitize isolated check staging.".to_string())?;
        for entry in entries {
            let entry = entry
                .map_err(|_| "Codelit could not sanitize a staged project item.".to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            let file_type = entry
                .file_type()
                .map_err(|_| "Codelit could not inspect a staged project item.".to_string())?;
            if file_type.is_symlink() {
                fs::remove_file(entry.path())
                    .map_err(|_| "Codelit could not remove a staged symbolic link.".to_string())?;
            } else if excluded_name(&name) {
                if file_type.is_dir() {
                    fs::remove_dir_all(entry.path()).map_err(|_| {
                        "Codelit could not remove a protected staged directory.".to_string()
                    })?;
                } else {
                    fs::remove_file(entry.path()).map_err(|_| {
                        "Codelit could not remove a protected staged file.".to_string()
                    })?;
                }
            } else if file_type.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

fn project_check_sandbox_profile(
    run_dir: &Path,
    worktree: &Path,
    dependencies: &[PathBuf],
    prepared: &[PreparedProjectCheck],
) -> Result<String, String> {
    let run_dir = run_dir
        .canonicalize()
        .map_err(|_| "The isolated check folder is unavailable.".to_string())?;
    let worktree = worktree
        .canonicalize()
        .map_err(|_| "The isolated check worktree is unavailable.".to_string())?;
    let mut readable = vec![
        run_dir.clone(),
        worktree,
        PathBuf::from("/System"),
        PathBuf::from("/usr"),
        PathBuf::from("/bin"),
        PathBuf::from("/sbin"),
        PathBuf::from("/Library"),
        PathBuf::from("/dev"),
        PathBuf::from("/private/var/db/dyld"),
    ];
    readable.extend(dependencies.iter().cloned());
    for check in prepared {
        for executable in [&check.program, &check.package_manager] {
            let path = Path::new(executable);
            readable.push(path.to_path_buf());
            if let Some(root) = executable_installation_root(path) {
                readable.push(root);
            }
        }
    }
    readable.sort();
    readable.dedup();
    for path in &readable {
        validate_sandbox_path(path)?;
    }
    let mut ancestors = readable
        .iter()
        .flat_map(|path| path.ancestors().skip(1))
        .filter(|path| *path != Path::new("/"))
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    ancestors.sort();
    ancestors.dedup();
    let ancestor_rules = ancestors
        .iter()
        .map(|path| format!("    (literal \"{}\")", sandbox_escape(path)))
        .collect::<Vec<_>>()
        .join("\n");
    let deny_rules = protected_read_deny_rules(&readable, &ancestors);
    let read_rules = readable
        .iter()
        .map(|path| format!("    (subpath \"{}\")", sandbox_escape(path)))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "(version 1)\n(deny default)\n(allow process*)\n(allow sysctl-read)\n(allow mach-lookup)\n(allow ipc-posix-shm)\n(allow file-read*)\n{deny_rules}\n(allow file-read-data\n{ancestor_rules})\n(allow file-read*\n{read_rules})\n(allow file-write*\n    (subpath \"{}\"))\n(deny network*)\n",
        sandbox_escape(&run_dir),
    ))
}

fn protected_read_deny_rules(readable: &[PathBuf], ancestors: &[PathBuf]) -> String {
    [
        Path::new("/Users"),
        Path::new("/Volumes"),
        Path::new("/Network"),
        Path::new("/private/tmp"),
        Path::new("/private/var/folders"),
    ]
    .iter()
    .map(|protected| {
        let mut exceptions = readable
            .iter()
            .filter(|path| path.starts_with(protected))
            .map(|path| {
                format!(
                    "        (require-not (subpath \"{}\"))",
                    sandbox_escape(path)
                )
            })
            .chain(
                ancestors
                    .iter()
                    .filter(|path| path.starts_with(protected))
                    .map(|path| {
                        format!(
                            "        (require-not (literal \"{}\"))",
                            sandbox_escape(path)
                        )
                    }),
            )
            .collect::<Vec<_>>();
        exceptions.sort();
        exceptions.dedup();
        if exceptions.is_empty() {
            format!(
                "(deny file-read-data (subpath \"{}\"))",
                sandbox_escape(protected)
            )
        } else {
            format!(
                "(deny file-read-data\n    (require-all\n        (subpath \"{}\")\n{}))",
                sandbox_escape(protected),
                exceptions.join("\n")
            )
        }
    })
    .collect::<Vec<_>>()
    .join("\n")
}

fn executable_installation_root(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    if parent.file_name().is_some_and(|name| name == "bin") {
        let installation = parent.parent()?;
        if installation != Path::new("/") {
            return Some(installation.to_path_buf());
        }
    }
    Some(parent.to_path_buf())
}

fn sandbox_escape(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn validate_sandbox_path(path: &Path) -> Result<(), String> {
    let value = path
        .to_str()
        .ok_or("A local project path cannot be represented safely in the sandbox policy.")?;
    if value.chars().any(char::is_control) {
        return Err("A local project path contains unsupported control characters.".into());
    }
    Ok(())
}

fn display_command(program: &Path, arguments: &[String]) -> String {
    let mut parts = vec![shell_quote(&program.to_string_lossy())];
    parts.extend(arguments.iter().map(|argument| shell_quote(argument)));
    format!("Command: {}", parts.join(" "))
}

fn shell_quote(value: &str) -> String {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"-._/:@".contains(&byte))
    {
        value.into()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn prepared_project_checks_path(run_dir: &Path) -> PathBuf {
    run_dir.join("project-checks.json")
}

fn write_prepared_project_checks(
    run_dir: &Path,
    prepared: &[PreparedProjectCheck],
) -> Result<(), String> {
    let bytes = serde_json::to_vec(prepared)
        .map_err(|_| "Codelit could not encode the project-check approval.".to_string())?;
    if bytes.len() > 128 * 1024 {
        return Err("The project-check approval is too large.".into());
    }
    fs::write(prepared_project_checks_path(run_dir), &bytes)
        .map_err(|_| "Codelit could not save the project-check approval.".to_string())?;
    fs::write(run_dir.join("project-checks.sha256"), sha256_hex(&bytes))
        .map_err(|_| "Codelit could not save the project-check integrity record.".to_string())?;
    Ok(())
}

fn read_prepared_project_checks(run_dir: &Path) -> Result<Vec<PreparedProjectCheck>, String> {
    let bytes =
        read_bounded_file(&prepared_project_checks_path(run_dir), 128 * 1024).map_err(|_| {
            "Prepare and review this project check again before running it.".to_string()
        })?;
    let expected = fs::read_to_string(run_dir.join("project-checks.sha256"))
        .map_err(|_| "The project-check integrity record is missing.".to_string())?;
    if sha256_hex(&bytes) != expected.trim() {
        return Err("The prepared project check changed after review. Prepare it again.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The prepared project check is invalid. Prepare it again.".to_string())
}

fn read_bounded_file(path: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > max_bytes as u64 {
        return Err("The file exceeds its local safety limit.".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() > max_bytes {
        return Err("The file exceeds its local safety limit.".into());
    }
    Ok(bytes)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = read_bounded_file(path, 256 * 1024 * 1024)
        .map_err(|_| "A project-check executable could not be verified.".to_string())?;
    Ok(sha256_hex(&bytes))
}

fn sanitize_tool_output(value: &str) -> String {
    let mut output = String::with_capacity(value.len().min(28_000));
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' {
            if characters.next_if_eq(&'[').is_some() {
                while characters
                    .next()
                    .is_some_and(|next| !next.is_ascii_alphabetic())
                {}
            }
            continue;
        }
        if character == '\n' || character == '\t' || !character.is_control() {
            output.push(character);
        }
        if output.len() >= 28_000 {
            break;
        }
    }
    output
}

fn prepare_patch_in_root(
    run_id: &str,
    root: &Path,
    app_data_dir: &Path,
    source: &str,
    cancellation: &CancellationToken,
) -> Result<LocalToolApprovalPreview, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "The selected project folder is no longer available.".to_string())?;
    ensure_git_repository(&root, cancellation)?;
    let patch = extract_unified_patch(source)?;
    let run_dir = staging_run_dir(app_data_dir, run_id);
    let worktree = run_dir.join("worktree");
    cleanup_staging(&root, &run_dir, cancellation);
    fs::create_dir_all(&run_dir)
        .map_err(|_| "Codelit could not create isolated patch staging.".to_string())?;

    let setup = (|| {
        require_git_success(
            run_git(
                &root,
                vec![
                    "worktree".into(),
                    "add".into(),
                    "--detach".into(),
                    worktree.as_os_str().to_owned(),
                    "HEAD".into(),
                ],
                cancellation,
                true,
            )?,
            "Codelit could not create the isolated Git worktree.",
        )?;
        let proposal_path = run_dir.join("proposal.patch");
        fs::write(&proposal_path, patch.as_bytes())
            .map_err(|_| "Codelit could not save the isolated patch proposal.".to_string())?;
        for arguments in [
            vec![
                "apply".into(),
                "--check".into(),
                "--whitespace=error-all".into(),
                proposal_path.as_os_str().to_owned(),
            ],
            vec![
                "apply".into(),
                "--whitespace=error-all".into(),
                proposal_path.as_os_str().to_owned(),
            ],
        ] {
            require_git_success(
                run_git(&worktree, arguments, cancellation, true)?,
                "The proposed patch does not apply cleanly to the pinned repository version.",
            )?;
        }
        validate_changed_paths(&worktree, cancellation)?;
        require_git_success(
            run_git_with_safe_paths(&worktree, &["diff", "--check"], cancellation, false)?,
            "The proposed patch contains invalid whitespace or conflict markers.",
        )?;
        let diff = require_git_success(
            run_git_with_safe_paths(
                &worktree,
                &["diff", "--no-ext-diff", "--binary", "--unified=3"],
                cancellation,
                false,
            )?,
            "Codelit could not render the isolated patch preview.",
        )?
        .stdout;
        if diff.trim().is_empty() {
            return Err("The proposed patch did not produce any reviewable changes.".into());
        }
        if diff.len() > MAX_PATCH_BYTES {
            return Err("The proposed patch is too large for one local approval.".into());
        }
        fs::write(run_dir.join("prepared.diff"), diff.as_bytes())
            .map_err(|_| "Codelit could not preserve the approved patch preview.".to_string())?;
        let hash = sha256_hex(diff.as_bytes());
        fs::write(run_dir.join("prepared.sha256"), hash.as_bytes())
            .map_err(|_| "Codelit could not preserve the patch integrity record.".to_string())?;
        let changed = changed_paths(&worktree, cancellation)?;
        Ok(LocalToolApprovalPreview {
            run_id: run_id.into(),
            status: "ready".into(),
            summary: format!(
                "{} changed {} ready in isolated staging",
                changed.len(),
                if changed.len() == 1 {
                    "file is"
                } else {
                    "files are"
                },
            ),
            evidence: vec![format!("Patch SHA-256: {hash}"), bound_text(&diff, 24_000)],
            patch_sha256: Some(hash),
            approval_sha256: None,
        })
    })();
    if setup.is_err() {
        cleanup_staging(&root, &run_dir, cancellation);
    }
    setup
}

fn apply_prepared_patch(
    root: &Path,
    app_data_dir: &Path,
    run_id: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "The selected project folder is no longer available.".to_string())?;
    ensure_git_repository(&root, cancellation)?;
    let run_dir = staging_run_dir(app_data_dir, run_id);
    let diff_path = run_dir.join("prepared.diff");
    let hash_path = run_dir.join("prepared.sha256");
    let diff = fs::read(&diff_path)
        .map_err(|_| "Prepare and review this patch again before applying it.".to_string())?;
    if diff.is_empty() || diff.len() > MAX_PATCH_BYTES {
        return Err("The prepared patch is missing or exceeds the local approval limit.".into());
    }
    let expected_hash = fs::read_to_string(&hash_path)
        .map_err(|_| "The patch integrity record is missing. Prepare it again.".to_string())?;
    let actual_hash = sha256_hex(&diff);
    if expected_hash.trim() != actual_hash {
        return Err("The prepared patch changed after review. Prepare it again.".into());
    }
    let status = require_git_success(
        run_git_with_safe_paths(
            &root,
            &["status", "--porcelain", "--untracked-files=all"],
            cancellation,
            false,
        )?,
        "Codelit could not verify the selected repository state.",
    )?;
    if !status.stdout.trim().is_empty() {
        return Err(
            "The selected repository changed after the preview. Commit or stash those changes, then prepare the patch again."
                .into(),
        );
    }
    for arguments in [
        vec![
            "apply".into(),
            "--check".into(),
            diff_path.as_os_str().to_owned(),
        ],
        vec![
            "apply".into(),
            "--whitespace=error-all".into(),
            diff_path.as_os_str().to_owned(),
        ],
    ] {
        require_git_success(
            run_git(&root, arguments, cancellation, true)?,
            "The reviewed patch no longer applies cleanly. Prepare it again.",
        )?;
    }
    let applied = require_git_success(
        run_git_with_safe_paths(
            &root,
            &["diff", "--no-ext-diff", "--binary", "--unified=3"],
            cancellation,
            false,
        )?,
        "The patch was applied, but Codelit could not render its local evidence.",
    )?
    .stdout;
    cleanup_staging(&root, &run_dir, cancellation);
    Ok(format!(
        "Approved patch applied to the selected project.\nPatch SHA-256: {actual_hash}\n{}",
        bound_text(&applied, 24_000),
    ))
}

fn extract_unified_patch(source: &str) -> Result<String, String> {
    if source.is_empty() || source.len() > MAX_PATCH_BYTES || source.contains('\0') {
        return Err("The teammate did not produce one bounded unified diff.".into());
    }
    let start = source
        .find("diff --git ")
        .ok_or("The teammate output does not contain a unified Git diff.")?;
    let mut patch = source[start..].trim().to_string();
    if let Some(end) = patch.find("\n```") {
        patch.truncate(end);
    }
    if !patch.ends_with('\n') {
        patch.push('\n');
    }
    if patch.len() > MAX_PATCH_BYTES {
        return Err("The proposed patch is too large for one local approval.".into());
    }
    Ok(patch)
}

fn staging_run_dir(app_data_dir: &Path, run_id: &str) -> PathBuf {
    app_data_dir.join("tool-staging").join(run_id)
}

fn cleanup_staging(root: &Path, run_dir: &Path, _cancellation: &CancellationToken) {
    let cleanup_cancellation = CancellationToken::default();
    let worktree = run_dir.join("worktree");
    if worktree.exists() {
        let _ = run_git(
            root,
            vec![
                "worktree".into(),
                "remove".into(),
                "--force".into(),
                worktree.as_os_str().to_owned(),
            ],
            &cleanup_cancellation,
            true,
        );
    }
    let _ = fs::remove_dir_all(run_dir);
}

fn ensure_git_repository(root: &Path, cancellation: &CancellationToken) -> Result<(), String> {
    require_git_success(
        run_git(
            root,
            vec!["rev-parse".into(), "--is-inside-work-tree".into()],
            cancellation,
            false,
        )?,
        "The selected folder is not a Git repository.",
    )?;
    Ok(())
}

fn validate_changed_paths(root: &Path, cancellation: &CancellationToken) -> Result<(), String> {
    for relative in changed_paths(root, cancellation)? {
        let path = Path::new(&relative);
        if path.is_absolute() || !safe_text_path(path) {
            return Err("The proposed patch includes a protected or unsafe path.".into());
        }
        if fs::symlink_metadata(root.join(path))
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("The proposed patch cannot create or modify symbolic links.".into());
        }
    }
    Ok(())
}

fn changed_paths(root: &Path, cancellation: &CancellationToken) -> Result<Vec<String>, String> {
    let output = require_git_success(
        run_git_with_safe_paths(root, &["diff", "--name-only", "-z"], cancellation, false)?,
        "Codelit could not validate the proposed patch paths.",
    )?;
    let paths = output
        .stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if paths.is_empty() || paths.len() > MAX_CHANGED_PATHS {
        return Err("The proposed patch must change between 1 and 80 safe files.".into());
    }
    Ok(paths)
}

fn run_git_with_safe_paths(
    root: &Path,
    args: &[&str],
    cancellation: &CancellationToken,
    allow_locks: bool,
) -> Result<crate::run_control::ProcessOutput, String> {
    let mut owned = args.iter().map(OsString::from).collect::<Vec<_>>();
    owned.push("--".into());
    owned.extend(SAFE_GIT_PATHS.iter().map(OsString::from));
    run_git(root, owned, cancellation, allow_locks)
}

fn run_git(
    root: &Path,
    args: Vec<OsString>,
    cancellation: &CancellationToken,
    allow_locks: bool,
) -> Result<crate::run_control::ProcessOutput, String> {
    let mut command = Command::new("/usr/bin/git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.hooksPath=/dev/null", "-c", "diff.external="])
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_OPTIONAL_LOCKS", if allow_locks { "1" } else { "0" })
        .stdin(Stdio::null());
    run_line_process(command, TOOL_TIMEOUT, cancellation, |_, _| {})
}

fn require_git_success(
    output: crate::run_control::ProcessOutput,
    message: &str,
) -> Result<crate::run_control::ProcessOutput, String> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(message.into())
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn repository_context(root: &Path) -> Result<String, String> {
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    let mut paths = Vec::new();
    while let Some((directory, depth)) = pending.pop() {
        if depth > 7 || paths.len() >= MAX_PATHS {
            continue;
        }
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| format!("Could not inspect the selected project: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not inspect the selected project: {error}"))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if paths.len() >= MAX_PATHS {
                break;
            }
            let file_type = entry
                .file_type()
                .map_err(|error| format!("Could not inspect a project item: {error}"))?;
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if excluded_name(&name) {
                continue;
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "A project path escaped the selected folder.".to_string())?;
            if file_type.is_dir() {
                pending.push((path, depth + 1));
            } else if file_type.is_file() && safe_text_path(relative) {
                paths.push(relative.to_string_lossy().into_owned());
            }
        }
    }
    let root_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Selected project");
    Ok(format!(
        "Project: {root_name}\nVisible text files ({}{}):\n{}",
        paths.len(),
        if paths.len() == MAX_PATHS { "+" } else { "" },
        if paths.is_empty() {
            "(none)".into()
        } else {
            paths.join("\n")
        },
    ))
}

fn folder_listing_context(root: &Path) -> Result<String, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "The selected folder is no longer available.".to_string())?;
    let mut entries = fs::read_dir(&root)
        .map_err(|error| format!("Could not inspect the selected folder: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not inspect the selected folder: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());

    let mut folders = Vec::new();
    let mut files = Vec::new();
    let mut omitted = 0_usize;
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(file_type) = entry.file_type() else {
            omitted += 1;
            continue;
        };
        if file_type.is_symlink()
            || name.starts_with('.')
            || name.chars().any(char::is_control)
            || excluded_name(&name)
        {
            omitted += 1;
            continue;
        }
        if folders.len() + files.len() >= MAX_PATHS {
            omitted += 1;
            continue;
        }
        if file_type.is_dir() {
            folders.push(name);
        } else if file_type.is_file() {
            files.push(name);
        } else {
            omitted += 1;
        }
    }

    let folder_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Selected folder");
    let visible_count = folders.len() + files.len();
    let mut sections = vec![format!(
        "**{folder_name}** has {visible_count} visible top-level {}.",
        if visible_count == 1 { "item" } else { "items" }
    )];
    if !folders.is_empty() {
        sections.push(format!(
            "**Folders ({})**\n{}",
            folders.len(),
            folders
                .iter()
                .map(|name| format!("- {name}/"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !files.is_empty() {
        sections.push(format!(
            "**Files ({})**\n{}",
            files.len(),
            files
                .iter()
                .map(|name| format!("- {name}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if omitted > 0 {
        sections.push(format!(
            "{omitted} hidden, protected, unsupported, or additional {} omitted.",
            if omitted == 1 {
                "item was"
            } else {
                "items were"
            }
        ));
    }
    Ok(sections.join("\n\n"))
}

fn project_fingerprint(root: &Path) -> Result<LocalProjectFingerprint, String> {
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    let mut records = Vec::new();
    let mut truncated = false;
    while let Some((directory, depth)) = pending.pop() {
        if depth > MAX_PROJECT_FINGERPRINT_DEPTH {
            truncated = true;
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if directory == root => {
                return Err(format!("Could not inspect the selected project: {error}"));
            }
            Err(_) => continue,
        };
        let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if excluded_name(&name) {
                continue;
            }
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            if file_type.is_dir() {
                if depth == MAX_PROJECT_FINGERPRINT_DEPTH {
                    truncated = true;
                } else {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() || !safe_text_path(relative) {
                continue;
            }
            if records.len() == MAX_PROJECT_FINGERPRINT_FILES {
                truncated = true;
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let modified_nanos = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_nanos())
                .unwrap_or_default();
            records.push((
                relative.to_string_lossy().into_owned(),
                metadata.len(),
                modified_nanos,
            ));
        }
    }
    records.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    for (path, size, modified_nanos) in &records {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update(size.to_le_bytes());
        hasher.update(modified_nanos.to_le_bytes());
        hasher.update([0]);
    }
    Ok(LocalProjectFingerprint {
        sha256: format!("{:x}", hasher.finalize()),
        file_count: records.len(),
        truncated,
        captured_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn selected_file_context(root: &Path, handoff: &str) -> Result<String, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "The selected project folder is no longer available.".to_string())?;
    let mut selected: Vec<String> = Vec::new();
    for token in handoff.split(|character: char| {
        character.is_whitespace()
            || matches!(character, ',' | ';' | '[' | ']' | '(' | ')' | '{' | '}')
    }) {
        let candidate = token
            .trim_matches(|character| matches!(character, '`' | '\'' | '"' | ':' | '*'))
            .trim_start_matches("FILES=")
            .trim_start_matches("FILES:");
        if candidate.is_empty() || candidate.len() > 240 {
            continue;
        }
        let relative = Path::new(candidate);
        if relative.is_absolute()
            || !safe_text_path(relative)
            || selected.iter().any(|path| path == candidate)
        {
            continue;
        }
        let path = root.join(relative);
        if !safe_file_without_symlinks(&root, relative) {
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > 64 * 1024 {
            continue;
        }
        selected.push(candidate.to_string());
        if selected.len() == 8 {
            break;
        }
    }
    if selected.is_empty() {
        return Err(
            "The previous teammate did not select any safe repository files. Return paths like FILES: src/app.ts, README.md."
                .into(),
        );
    }
    let mut context = Vec::new();
    for relative in selected {
        let bytes = fs::read(root.join(&relative))
            .map_err(|_| "A selected repository file could not be read.".to_string())?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| "A selected repository file is not UTF-8 text.".to_string())?;
        let remaining = MAX_CONTEXT_CHARS.saturating_sub(context_size(&context));
        if remaining < 256 {
            break;
        }
        context.push(format!(
            "File {relative}:\n{}",
            bound_text(text, remaining.min(8_000))
        ));
    }
    if context.is_empty() {
        return Err("The selected files exceed the safe local context limit.".into());
    }
    Ok(context.join("\n\n"))
}

fn safe_file_without_symlinks(root: &Path, relative: &Path) -> bool {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let Ok(metadata) = fs::symlink_metadata(&current) else {
            return false;
        };
        if metadata.file_type().is_symlink() {
            return false;
        }
    }
    true
}

fn git_context(
    root: &Path,
    args: &[&str],
    cancellation: &CancellationToken,
) -> Result<String, String> {
    ensure_git_repository(root, cancellation)?;
    let output = require_git_success(
        run_git_with_safe_paths(root, args, cancellation, false)?,
        "The local Git inspection could not complete.",
    )?;
    let stdout = output.stdout.trim();
    let stderr = output.stderr.trim();
    let detail = if stdout.is_empty() {
        if stderr.is_empty() {
            "No changes reported."
        } else {
            stderr
        }
    } else {
        stdout
    };
    Ok(format!(
        "exit={}\n{}",
        output.status.code().unwrap_or(-1),
        detail
    ))
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || run_id.len() > 128
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The local run identifier is invalid.".into());
    }
    Ok(())
}

fn excluded_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        ".cache"
            | ".ds_store"
            | ".git"
            | ".next"
            | ".turbo"
            | ".venv"
            | "build"
            | "coverage"
            | "deriveddata"
            | "dist"
            | "node_modules"
            | "target"
            | "vendor"
    ) || matches!(
        lower.as_str(),
        ".env" | ".npmrc" | ".yarnrc" | ".yarnrc.yml" | ".pypirc" | ".netrc"
    ) || lower.starts_with(".env.")
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
        || (contains_sensitive_name_marker(&lower) && !has_source_code_extension(&lower))
}

fn contains_sensitive_name_marker(name: &str) -> bool {
    name.contains("secret") || name.contains("credential") || name.contains("private-key")
}

fn has_source_code_extension(name: &str) -> bool {
    let Some(extension) = Path::new(name).extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        extension,
        "c" | "cc"
            | "cpp"
            | "cs"
            | "css"
            | "go"
            | "h"
            | "hpp"
            | "java"
            | "js"
            | "jsx"
            | "kt"
            | "kts"
            | "mjs"
            | "cjs"
            | "php"
            | "py"
            | "rb"
            | "rs"
            | "scss"
            | "svelte"
            | "swift"
            | "ts"
            | "tsx"
            | "vue"
    )
}

fn safe_text_path(path: &Path) -> bool {
    path.components().all(|component| {
        component.as_os_str().to_str().is_some_and(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && !segment.chars().any(char::is_control)
                && !excluded_name(segment)
        })
    })
}

fn context_size(context: &[String]) -> usize {
    context.iter().map(String::len).sum()
}

fn bound_text(value: &str, limit: usize) -> String {
    let mut end = value.len().min(limit);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

    fn initialize_repository(root: &Path) {
        fs::write(root.join("README.md"), "# Safe project\n").expect("readme");
        fs::write(root.join(".env"), "SECRET=never-show\n").expect("secret fixture");
        let status = Command::new("/usr/bin/git")
            .args(["init", "--quiet"])
            .current_dir(root)
            .status()
            .expect("git init");
        assert!(status.success());
    }

    fn commit_readme(root: &Path) {
        let add = Command::new("/usr/bin/git")
            .args(["add", "README.md"])
            .current_dir(root)
            .status()
            .expect("git add");
        assert!(add.success());
        let commit = Command::new("/usr/bin/git")
            .args([
                "-c",
                "user.name=Codelit Test",
                "-c",
                "user.email=test@codelit.local",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ])
            .current_dir(root)
            .status()
            .expect("git commit");
        assert!(commit.success());
    }

    fn add_project_scripts(root: &Path) {
        fs::write(
            root.join("package.json"),
            r#"{"packageManager":"npm@10.0.0","scripts":{"test":"node test.js","lint":"node lint.js","typecheck":"node typecheck.js"}}"#,
        )
        .expect("package json");
        fs::write(root.join("package-lock.json"), "{}\n").expect("package lock");
        fs::write(root.join(".gitignore"), "node_modules/\n").expect("gitignore");
        let add = Command::new("/usr/bin/git")
            .args([
                "add",
                "-f",
                "package.json",
                "package-lock.json",
                ".gitignore",
                ".env",
            ])
            .current_dir(root)
            .status()
            .expect("git add package files");
        assert!(add.success());
        let commit = Command::new("/usr/bin/git")
            .args([
                "-c",
                "user.name=Codelit Test",
                "-c",
                "user.email=test@codelit.local",
                "commit",
                "--quiet",
                "-m",
                "package scripts",
            ])
            .current_dir(root)
            .status()
            .expect("git commit package files");
        assert!(commit.success());
    }

    fn fake_node_toolchain(root: &Path, forbidden_file: Option<&Path>) -> Vec<PathBuf> {
        use std::os::unix::fs::PermissionsExt;

        fs::create_dir_all(root).expect("toolchain directory");
        let node = root.join("node");
        let npm = root.join("npm");
        let forbidden_probe = forbidden_file.map_or_else(String::new, |path| {
            format!(
                "if /bin/cat {} >/dev/null 2>&1; then printf 'outside read leaked\\n'; else printf 'outside read denied\\n'; fi\n",
                shell_quote(&path.to_string_lossy())
            )
        });
        let dependency_write_probe = "if [ -d node_modules ]; then if printf blocked > node_modules/codelit-write-probe 2>/dev/null; then printf 'dependency write leaked\\n'; else printf 'dependency write denied\\n'; fi; fi\n";
        let protected_file_probe = "if [ -e .env ]; then printf 'protected file leaked\\n'; else printf 'protected file removed\\n'; fi\n";
        let untracked_file_probe =
            "if [ -e src/untracked.ts ]; then printf 'untracked source copied\\n'; fi\n";
        fs::write(
            &node,
            format!(
                "#!/bin/sh\n{forbidden_probe}{dependency_write_probe}{protected_file_probe}{untracked_file_probe}printf 'isolated project check: %s\\n' \"$*\"\n"
            ),
        )
        .expect("fake node");
        fs::write(&npm, "// fake npm entry\n").expect("fake npm");
        for path in [&node, &npm] {
            let mut permissions = fs::metadata(path).expect("tool metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("tool permissions");
        }
        vec![root.to_path_buf()]
    }

    fn test_emitter() -> (RunEventEmitter, Arc<Mutex<Vec<ProviderRunEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let emitter = RunEventEmitter::new("run-tools", "local-tools", "native", None)
            .with_observer(Arc::new(move |event| {
                recorded.lock().expect("event lock").push(event);
            }));
        (emitter, events)
    }

    #[test]
    fn repository_tools_are_bounded_and_exclude_secrets() {
        let directory = tempdir().expect("tempdir");
        let app_data = tempdir().expect("app data");
        initialize_repository(directory.path());
        let registry = RunRegistry::default();
        let active = registry.begin("run-tools").expect("active run");
        let (emitter, events) = test_emitter();
        let result = execute_in_root(
            "run-tools",
            directory.path(),
            app_data.path(),
            "",
            vec![
                resolve_tool("Selected folder").expect("tool"),
                resolve_tool("Git read").expect("tool"),
            ],
            &active.token(),
            &emitter,
        )
        .expect("tool result");

        assert_eq!(result.status, "completed");
        assert_eq!(result.completed_tools.len(), 2);
        let joined = result.context.join("\n");
        assert!(joined.contains("README.md"));
        assert!(!joined.contains(".env"));
        assert!(!joined.contains("never-show"));
        assert!(
            events
                .lock()
                .expect("events")
                .iter()
                .any(|event| event.event_type == "tool-result")
        );
    }

    #[test]
    fn protected_name_filter_keeps_source_modules_without_exposing_secret_files() {
        assert!(!excluded_name("credential-display.ts"));
        assert!(!excluded_name("secret-manager.rs"));
        assert!(!excluded_name("private-key-policy.py"));
        assert!(excluded_name("api-secret.txt"));
        assert!(excluded_name("credentials.json"));
        assert!(excluded_name("private-key.pem"));
        assert!(excluded_name(".env.local"));
    }

    #[cfg(unix)]
    #[test]
    fn folder_listing_is_top_level_sorted_and_hides_protected_items_and_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().expect("folder");
        let outside = tempdir().expect("outside");
        fs::create_dir(directory.path().join("Zeta Folder")).expect("folder");
        fs::create_dir(directory.path().join("Alpha Folder")).expect("folder");
        fs::write(directory.path().join("notes.txt"), "notes").expect("notes");
        fs::write(directory.path().join("Photo.JPG"), [1_u8, 2, 3]).expect("photo");
        fs::write(directory.path().join(".env"), "SECRET=hidden").expect("secret");
        fs::write(outside.path().join("outside.txt"), "outside").expect("outside file");
        symlink(outside.path(), directory.path().join("Linked Folder")).expect("symlink");

        let context = folder_listing_context(directory.path()).expect("listing");
        assert!(context.contains("**Folders (2)**\n- Alpha Folder/\n- Zeta Folder/"));
        assert!(context.contains("**Files (2)**\n- notes.txt\n- Photo.JPG"));
        assert!(
            context.contains("2 hidden, protected, unsupported, or additional items were omitted.")
        );
        assert!(!context.contains("SECRET"));
        assert!(!context.contains("Linked Folder"));
        assert!(!context.contains("outside.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn repository_walk_does_not_follow_symlinks_outside_the_root() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().expect("tempdir");
        let outside = tempdir().expect("outside");
        initialize_repository(directory.path());
        fs::write(outside.path().join("outside.txt"), "private").expect("outside file");
        symlink(outside.path(), directory.path().join("linked-folder")).expect("symlink");

        let context = repository_context(directory.path()).expect("context");
        assert!(!context.contains("outside.txt"));
        assert!(!context.contains("linked-folder"));
    }

    #[test]
    fn project_fingerprint_is_stable_bounded_and_changes_with_safe_files() {
        let directory = tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("src")).expect("source directory");
        fs::create_dir_all(directory.path().join("node_modules/pkg")).expect("generated directory");
        fs::write(
            directory.path().join("src/app.ts"),
            "export const first = 1;\n",
        )
        .expect("source file");
        fs::write(directory.path().join(".env"), "TOKEN=never-show\n").expect("secret file");
        fs::write(
            directory.path().join("node_modules/pkg/index.js"),
            "generated\n",
        )
        .expect("generated file");

        let first = project_fingerprint(directory.path()).expect("first fingerprint");
        let repeated = project_fingerprint(directory.path()).expect("repeated fingerprint");
        assert_eq!(first.sha256, repeated.sha256);
        assert_eq!(first.file_count, 1);
        assert!(!first.truncated);

        fs::write(
            directory.path().join("src/app.ts"),
            "export const second = 22;\n",
        )
        .expect("changed source file");
        let changed = project_fingerprint(directory.path()).expect("changed fingerprint");
        assert_ne!(first.sha256, changed.sha256);

        fs::write(directory.path().join(".env"), "TOKEN=still-hidden\n")
            .expect("changed secret file");
        fs::write(
            directory.path().join("node_modules/pkg/index.js"),
            "generated change\n",
        )
        .expect("changed generated file");
        let excluded = project_fingerprint(directory.path()).expect("excluded fingerprint");
        assert_eq!(changed.sha256, excluded.sha256);
    }

    #[test]
    fn selected_file_read_uses_handoff_paths_and_rejects_protected_files() {
        let directory = tempdir().expect("tempdir");
        initialize_repository(directory.path());
        fs::create_dir(directory.path().join("src")).expect("src");
        fs::write(
            directory.path().join("src/app.ts"),
            "export const ready = true;\n",
        )
        .expect("source");

        let context = selected_file_context(
            directory.path(),
            "FILES: `README.md`, `src/app.ts`, `.env`, `../outside.txt`",
        )
        .expect("selected context");

        assert!(context.contains("File README.md"));
        assert!(context.contains("File src/app.ts"));
        assert!(context.contains("export const ready"));
        assert!(!context.contains("SECRET="));
        assert!(!context.contains("outside.txt"));
    }

    #[test]
    fn selected_file_read_fails_closed_without_safe_paths() {
        let directory = tempdir().expect("tempdir");
        initialize_repository(directory.path());
        let error = selected_file_context(directory.path(), "FILES: `.env`, `../outside.txt`")
            .expect_err("protected selection");
        assert!(error.contains("did not select any safe repository files"));
    }

    #[test]
    fn unknown_tools_fail_closed_before_folder_access() {
        let error = resolve_tool("Unreviewed shell").expect_err("unknown tool");
        assert!(error.contains("not available"));
    }

    #[test]
    fn project_check_metadata_rejects_terminal_and_policy_control_characters() {
        let directory = tempdir().expect("project");
        let package_json = br#"{"scripts":{"test":"printf '\u001b[2J'"}}"#;
        let error = resolve_project_command(directory.path(), package_json, "test", &[])
            .expect_err("terminal control script");
        assert!(error.contains("safe test script"));
        assert!(validate_sandbox_path(Path::new("/tmp/project\n(allow default)")).is_err());
    }

    #[test]
    fn patch_is_staged_reviewed_and_applied_only_after_approval_boundary() {
        let repository = tempdir().expect("repository");
        let app_data = tempdir().expect("app data");
        initialize_repository(repository.path());
        commit_readme(repository.path());
        let registry = RunRegistry::default();
        let active = registry.begin("run-patch").expect("active run");
        let patch = r#"Proposed change:
```diff
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Safe project
+Local patch
```
"#;

        let preview = prepare_patch_in_root(
            "run-patch",
            repository.path(),
            app_data.path(),
            patch,
            &active.token(),
        )
        .expect("patch preview");

        assert_eq!(
            fs::read_to_string(repository.path().join("README.md")).unwrap(),
            "# Safe project\n"
        );
        assert!(preview.summary.contains("1 changed file"));
        let patch_sha256 = preview.patch_sha256.as_deref().expect("patch digest");
        assert_eq!(patch_sha256.len(), 64);
        assert!(preview.evidence.join("\n").contains("+Local patch"));

        let applied = apply_prepared_patch(
            repository.path(),
            app_data.path(),
            "run-patch",
            &active.token(),
        )
        .expect("approved patch");
        assert!(applied.contains(patch_sha256));
        assert_eq!(
            fs::read_to_string(repository.path().join("README.md")).unwrap(),
            "# Safe project\nLocal patch\n"
        );
        assert!(!staging_run_dir(app_data.path(), "run-patch").exists());
    }

    #[test]
    fn patch_staging_rejects_protected_paths() {
        let repository = tempdir().expect("repository");
        let app_data = tempdir().expect("app data");
        initialize_repository(repository.path());
        commit_readme(repository.path());
        let registry = RunRegistry::default();
        let active = registry.begin("run-secret").expect("active run");
        let patch = r#"diff --git a/api-secret.txt b/api-secret.txt
new file mode 100644
--- /dev/null
+++ b/api-secret.txt
@@ -0,0 +1 @@
+never store this
"#;

        let error = prepare_patch_in_root(
            "run-secret",
            repository.path(),
            app_data.path(),
            patch,
            &active.token(),
        )
        .expect_err("protected patch");

        assert!(error.contains("between 1 and 80 safe files") || error.contains("protected"));
        assert!(!repository.path().join("api-secret.txt").exists());
        assert!(!staging_run_dir(app_data.path(), "run-secret").exists());
    }

    #[test]
    fn approved_patch_stops_when_the_selected_repository_changed() {
        let repository = tempdir().expect("repository");
        let app_data = tempdir().expect("app data");
        initialize_repository(repository.path());
        commit_readme(repository.path());
        let registry = RunRegistry::default();
        let active = registry.begin("run-stale").expect("active run");
        let patch = r#"diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Safe project
+Approved line
"#;
        prepare_patch_in_root(
            "run-stale",
            repository.path(),
            app_data.path(),
            patch,
            &active.token(),
        )
        .expect("patch preview");
        fs::write(repository.path().join("README.md"), "# User changed this\n")
            .expect("user change");

        let error = apply_prepared_patch(
            repository.path(),
            app_data.path(),
            "run-stale",
            &active.token(),
        )
        .expect_err("stale repository");

        assert!(error.contains("changed after the preview"));
        assert_eq!(
            fs::read_to_string(repository.path().join("README.md")).unwrap(),
            "# User changed this\n"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn project_script_is_previewed_and_runs_only_in_isolated_staging() {
        let repository = tempdir().expect("repository");
        let app_data = tempdir().expect("app data");
        let toolchain = tempdir().expect("toolchain");
        let outside = tempdir().expect("outside");
        let outside_file = outside.path().join("private.txt");
        fs::write(&outside_file, "must not be readable\n").expect("outside file");
        initialize_repository(repository.path());
        commit_readme(repository.path());
        add_project_scripts(repository.path());
        fs::write(
            repository.path().join("README.md"),
            "# Safe project\nLocal draft\n",
        )
        .expect("unstaged source");
        fs::create_dir(repository.path().join("src")).expect("source directory");
        fs::write(
            repository.path().join("src/untracked.ts"),
            "export const localDraft = true;\n",
        )
        .expect("untracked source");
        fs::create_dir(repository.path().join("node_modules")).expect("dependencies");
        fs::write(
            repository.path().join("node_modules/dependency.js"),
            "module.exports = 1;\n",
        )
        .expect("dependency fixture");
        let search_dirs = fake_node_toolchain(toolchain.path(), Some(&outside_file));
        let registry = RunRegistry::default();
        let active = registry.begin("run-project-test").expect("active run");
        let test_tool = resolve_tool("Project test").expect("project test");
        let preview = prepare_project_checks_in_root(
            "run-project-test",
            repository.path(),
            app_data.path(),
            &[&test_tool],
            &search_dirs,
            &active.token(),
        )
        .expect("project check preview");

        let run_dir = staging_run_dir(app_data.path(), "run-project-test");
        assert!(!run_dir.join("staged-source.diff").exists());
        assert!(!run_dir.join("unstaged-source.diff").exists());

        assert!(preview.patch_sha256.is_none());
        assert!(preview.summary.contains("1 project check"));
        assert!(
            preview
                .evidence
                .join("\n")
                .contains("Script: test = node test.js")
        );
        assert!(preview.evidence.join("\n").contains("Network: blocked"));
        assert!(!repository.path().join("test-output.txt").exists());

        let (emitter, _) = test_emitter();
        let result = execute_in_root(
            "run-project-test",
            repository.path(),
            app_data.path(),
            "",
            vec![resolve_tool("Project test").expect("project test")],
            &active.token(),
            &emitter,
        )
        .expect("isolated project check");

        assert!(
            result.context.join("\n").contains("isolated project check"),
            "{:?}",
            result.context
        );
        assert!(
            result.context.join("\n").contains("exit=0"),
            "{:?}",
            result.context
        );
        assert!(result.context.join("\n").contains("outside read denied"));
        assert!(!result.context.join("\n").contains("must not be readable"));
        assert!(
            result
                .context
                .join("\n")
                .contains("dependency write denied")
        );
        assert!(result.context.join("\n").contains("protected file removed"));
        assert!(!result.context.join("\n").contains("protected file leaked"));
        assert!(
            result
                .context
                .join("\n")
                .contains("untracked source copied")
        );
        assert!(
            !repository
                .path()
                .join("node_modules/codelit-write-probe")
                .exists()
        );
        assert!(!staging_run_dir(app_data.path(), "run-project-test").exists());
    }

    #[test]
    fn project_script_refuses_a_repository_changed_after_review() {
        let repository = tempdir().expect("repository");
        let app_data = tempdir().expect("app data");
        let toolchain = tempdir().expect("toolchain");
        initialize_repository(repository.path());
        commit_readme(repository.path());
        add_project_scripts(repository.path());
        fs::create_dir(repository.path().join("src")).expect("source directory");
        let untracked = repository.path().join("src/untracked.ts");
        fs::write(&untracked, "export const first = true;\n").expect("untracked source");
        let search_dirs = fake_node_toolchain(toolchain.path(), None);
        let registry = RunRegistry::default();
        let active = registry.begin("run-stale-check").expect("active run");
        let test_tool = resolve_tool("Project test").expect("project test");
        prepare_project_checks_in_root(
            "run-stale-check",
            repository.path(),
            app_data.path(),
            &[&test_tool],
            &search_dirs,
            &active.token(),
        )
        .expect("project check preview");
        fs::write(&untracked, "export const second = true;\n")
            .expect("stale untracked source change");

        let error = execute_prepared_project_check(
            repository.path(),
            app_data.path(),
            "run-stale-check",
            "Project test",
            "test",
            &active.token(),
        )
        .expect_err("stale project check");

        assert!(error.contains("changed after review"));
        cleanup_staging(
            repository.path(),
            &staging_run_dir(app_data.path(), "run-stale-check"),
            &active.token(),
        );
    }

    #[test]
    fn untracked_project_files_are_bounded_and_exclude_protected_paths() {
        let repository = tempdir().expect("repository");
        initialize_repository(repository.path());
        commit_readme(repository.path());
        fs::create_dir(repository.path().join("src")).expect("source directory");
        fs::write(
            repository.path().join("src/untracked.ts"),
            "export const localDraft = true;\n",
        )
        .expect("untracked source");
        fs::write(repository.path().join("api-secret.txt"), "do not copy\n")
            .expect("protected untracked source");

        let state = repository_state(repository.path(), &CancellationToken::default())
            .expect("bounded untracked state");
        assert_eq!(state.untracked_files.len(), 1);
        assert_eq!(state.untracked_files[0].relative, "src/untracked.ts");
        assert_eq!(
            state.untracked_files[0].bytes,
            b"export const localDraft = true;\n"
        );

        let worktree = tempdir().expect("isolated worktree");
        copy_untracked_project_files(worktree.path(), &state.untracked_files)
            .expect("copy safe untracked source");
        assert_eq!(
            fs::read(worktree.path().join("src/untracked.ts")).expect("copied source"),
            b"export const localDraft = true;\n"
        );
        assert!(!worktree.path().join("api-secret.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn untracked_project_files_reject_symlinks_and_oversized_files() {
        use std::os::unix::fs::symlink;

        let repository = tempdir().expect("repository");
        let outside = tempdir().expect("outside");
        initialize_repository(repository.path());
        commit_readme(repository.path());
        fs::write(outside.path().join("outside.ts"), "private\n").expect("outside source");
        symlink(
            outside.path().join("outside.ts"),
            repository.path().join("linked.ts"),
        )
        .expect("untracked symlink");
        let symlink_error = repository_state(repository.path(), &CancellationToken::default())
            .expect_err("untracked symlink rejected");
        assert!(symlink_error.contains("symbolic links"));

        fs::remove_file(repository.path().join("linked.ts")).expect("remove symlink");
        fs::write(
            repository.path().join("oversized.ts"),
            vec![b'x'; MAX_UNTRACKED_PROJECT_FILE_BYTES + 1],
        )
        .expect("oversized source");
        let size_error = repository_state(repository.path(), &CancellationToken::default())
            .expect_err("oversized untracked file rejected");
        assert!(size_error.contains("1 MiB"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires the Codelit checkout, installed dependencies, and npm"]
    fn live_project_typecheck_probe() {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .expect("Codelit repository");
        let app_data = tempdir().expect("app data");
        let registry = RunRegistry::default();
        let active = registry
            .begin("live-project-typecheck")
            .expect("active run");
        let tool = resolve_tool("Project typecheck").expect("project typecheck");
        prepare_project_checks_in_root(
            "live-project-typecheck",
            &repository,
            app_data.path(),
            &[&tool],
            &package_manager_search_dirs(),
            &active.token(),
        )
        .expect("typecheck preview");
        let (emitter, _) = test_emitter();
        let result = execute_in_root(
            "live-project-typecheck",
            &repository,
            app_data.path(),
            "",
            vec![resolve_tool("Project typecheck").expect("project typecheck")],
            &active.token(),
            &emitter,
        )
        .expect("isolated typecheck");

        assert!(
            result.context.join("\n").contains("exit=0"),
            "{:?}",
            result.context
        );
    }
}
