mod artifact_store;
mod autonomy;
mod bot_data;
mod browser_downloads;
mod computer_accessibility;
mod computer_use;
mod copilot;
mod crypto;
mod delegations;
mod desktop_cloud;
mod event_routines;
mod hosted_bridge;
mod lmstudio;
mod local_browser;
mod local_mcp;
mod local_notifications;
mod macos;
mod model_discovery;
mod model_manager;
mod ollama;
mod pilot_metrics;
mod provider_api;
mod provider_credentials;
mod provider_runtime;
mod providers;
mod routine_activity;
mod run_control;
mod scheduler;
mod storage;
mod system_resources;
mod tool_runtime;
mod updater;

#[cfg(all(feature = "direct-release", feature = "app-store-release"))]
compile_error!("Choose exactly one Codelit release channel.");
#[cfg(all(
    not(debug_assertions),
    not(any(feature = "direct-release", feature = "app-store-release"))
))]
compile_error!("Release builds require the direct-release or app-store-release feature.");

use autonomy::{BotAutonomyPolicy, UpdateBotAutonomyPolicyRequest};
use bot_data::{
    AppendLocalBotTableRowRequest, CreateLocalBotTableRequest, LocalBotTable, LocalBotTableView,
};
use browser_downloads::QuarantinedBrowserDownload;
use computer_use::{
    ComputerActionResult, ComputerAppInspection, ComputerAppScope, ComputerPermissionRequest,
    ComputerUseReadiness, DeleteComputerAppScopeRequest, InspectComputerAppRequest,
    RunComputerActionRequest, RunningComputerApp, SaveComputerAppScopeRequest,
};
use delegations::{
    CreateLocalBotDelegationRequest, FinishLocalBotDelegationTargetRequest, LocalBotDelegation,
    StartLocalBotDelegationTargetRequest,
};
use event_routines::{
    ClaimChangedEventRoutinesRequest, ClaimedEventRoutineOccurrence, EventRoutineOccurrenceStatus,
    FinishEventRoutineOccurrenceRequest, LocalEventRoutine, SaveLocalEventRoutineRequest,
    SetLocalEventRoutineEnabledRequest,
};
use local_browser::{
    BrowserHistoryRequest, BrowserNavigationPreview, BrowserRegistry, BrowserSessionRequest,
    BrowserVisibilityRequest, LocalBrowserSession, LocalBrowserTeachingCapture,
    LocalBrowserTeachingDryRun, NavigateLocalBrowserRequest, OpenLocalBrowserRequest,
    ResizeLocalBrowserRequest, UpdateBrowserDomainsRequest,
};
use local_mcp::{
    LocalMcpInspection, LocalMcpServer, LocalMcpServerDraft, SaveLocalMcpServerRequest,
};
use local_notifications::{LocalNotificationRoute, ShowLocalNotificationRequest};
use macos::BackgroundServiceProbe;
use model_discovery::LocalModelDiscovery;
use pilot_metrics::LocalPilotReport;
use provider_credentials::{
    ByokProvider, ProviderCredentialRef, ProviderCredentialStatus, ProviderCredentialStore,
    SecretBytes,
};
use provider_runtime::{ModelManagerRequest, ProviderTaskRequest, ProviderTaskResult};
use providers::ProviderProbe;
use routine_activity::RoutineActivityItem;
use run_control::{ProviderRunEvent, RunRegistry};
use scheduler::{
    ClaimedScheduleOccurrence, FinishScheduleOccurrenceRequest, LocalSchedule,
    SaveLocalScheduleRequest, ScheduleEnvironment, ScheduleOccurrenceStatus,
    SetLocalScheduleEnabledRequest,
};
use storage::{
    AppState, AppendMessageRequest, BeginLocalRunRequest, ClearLocalBotMemoriesRequest,
    CreateLocalBotMemoryProposalRequest, CreateLocalBotRequest, DeleteLocalBotMemoryRequest,
    DeleteLocalBotSkillRequest, LocalBotContext, LocalBotMemoryProposalRecord,
    LocalBotMemoryRecord, LocalBotRecord, LocalBotSkillRecord, LocalBotsSnapshot,
    RecordLocalCheckRequest, RecordRunApprovalRequest, ReviewImportedBotSkillRequest,
    ReviewLocalBotMemoryProposalRequest, SaveArtifactRequest, SaveLocalBotMemoryRequest,
    SaveLocalBotSkillRequest, SaveRunCheckpointRequest, StoreArtifactFileRequest,
    UpdateLocalBotApprovalModeRequest, UpdateLocalBotBrowserDomainsRequest,
    UpdateLocalBotEnginePolicyRequest, UpdateLocalBotGoalRequest,
    UpdateLocalBotGroupMembersRequest, UpdateLocalBotProfileRequest, UpdateLocalBotRoutinesRequest,
    UpdateLocalBotStatusRequest, WorkspaceSnapshot,
};
use tauri::{AppHandle, Manager, State};
use tool_runtime::{
    LocalProjectFingerprint, LocalToolApprovalPreview, LocalToolApprovalRequest,
    LocalToolBatchRequest, LocalToolBatchResult,
};
use updater::DesktopUpdateState;
#[cfg(feature = "direct-release")]
use updater::UpdateRegistry;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedWorkspace {
    path: String,
    snapshot: WorkspaceSnapshot,
}

const DEFAULT_PROVIDER_CREDENTIAL_ACCOUNT: &str = "default";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProviderApiKeyRequest {
    provider: ByokProvider,
    api_key: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteProviderApiKeyRequest {
    provider: ByokProvider,
}

#[tauri::command]
fn bootstrap_local_workspace(state: State<'_, AppState>) -> Result<WorkspaceSnapshot, String> {
    refresh_workspace_folder(&state);
    storage::bootstrap_local_workspace(&state)
}

#[tauri::command]
fn bootstrap_local_bots(state: State<'_, AppState>) -> Result<LocalBotsSnapshot, String> {
    refresh_workspace_folder(&state);
    storage::bootstrap_local_bots(&state)
}

#[tauri::command]
fn create_local_bot(
    state: State<'_, AppState>,
    request: CreateLocalBotRequest,
) -> Result<LocalBotsSnapshot, String> {
    storage::create_local_bot(&state, request)
}

#[tauri::command]
fn set_active_local_bot(
    state: State<'_, AppState>,
    id: String,
) -> Result<LocalBotsSnapshot, String> {
    storage::set_active_local_bot(&state, &id)
}

#[tauri::command]
fn open_local_bot_context(
    state: State<'_, AppState>,
    id: String,
) -> Result<LocalBotContext, String> {
    storage::open_local_bot_context(&state, &id)
}

#[tauri::command]
fn list_local_bot_group_members(
    state: State<'_, AppState>,
    owner_bot_id: String,
) -> Result<Vec<LocalBotRecord>, String> {
    storage::list_local_bot_group_members(&state, &owner_bot_id)
}

#[tauri::command]
fn update_local_bot_group_members(
    state: State<'_, AppState>,
    request: UpdateLocalBotGroupMembersRequest,
) -> Result<Vec<LocalBotRecord>, String> {
    storage::update_local_bot_group_members(&state, request)
}

#[tauri::command]
fn list_local_bot_tables(
    state: State<'_, AppState>,
    bot_id: String,
) -> Result<Vec<LocalBotTable>, String> {
    bot_data::list_local_bot_tables(&state, &bot_id)
}

#[tauri::command]
fn create_local_bot_table(
    state: State<'_, AppState>,
    request: CreateLocalBotTableRequest,
) -> Result<LocalBotTableView, String> {
    bot_data::create_local_bot_table(&state, request)
}

#[tauri::command]
fn append_local_bot_table_row(
    state: State<'_, AppState>,
    request: AppendLocalBotTableRowRequest,
) -> Result<LocalBotTableView, String> {
    bot_data::append_local_bot_table_row(&state, request)
}

#[tauri::command]
fn open_local_bot_table(
    state: State<'_, AppState>,
    bot_id: String,
    table_id: String,
    limit: i64,
) -> Result<LocalBotTableView, String> {
    bot_data::open_local_bot_table(&state, &bot_id, &table_id, limit)
}

#[tauri::command]
fn export_local_bot_table_csv(
    state: State<'_, AppState>,
    bot_id: String,
    table_id: String,
) -> Result<Option<String>, String> {
    let export = bot_data::export_local_bot_table_csv(&state, &bot_id, &table_id)?;
    macos::save_bot_table_csv(&export.file_name, export.data.as_bytes())
}

#[tauri::command]
fn list_quarantined_browser_downloads(
    state: State<'_, AppState>,
    bot_id: String,
) -> Result<Vec<QuarantinedBrowserDownload>, String> {
    browser_downloads::list_quarantined_downloads(&state, &bot_id)
}

#[tauri::command]
fn release_quarantined_browser_download(
    state: State<'_, AppState>,
    bot_id: String,
    download_id: String,
) -> Result<Option<String>, String> {
    let verified = browser_downloads::verify_for_release(&state, &bot_id, &download_id)?;
    let released = macos::release_browser_download(
        &verified.download.file_name,
        &verified.download.source_url,
        &verified.bytes,
    )?;
    if released.is_some() {
        browser_downloads::mark_released(&state, &bot_id, &download_id)?;
    }
    Ok(released)
}

#[tauri::command]
fn delete_quarantined_browser_download(
    state: State<'_, AppState>,
    bot_id: String,
    download_id: String,
) -> Result<(), String> {
    browser_downloads::delete_quarantined_download(&state, &bot_id, &download_id)
}

#[tauri::command]
fn probe_computer_use_readiness() -> ComputerUseReadiness {
    computer_use::probe_readiness()
}

#[tauri::command]
fn request_computer_use_permission(
    request: ComputerPermissionRequest,
) -> Result<ComputerUseReadiness, String> {
    computer_use::request_permission(request)
}

#[tauri::command]
fn list_running_computer_apps() -> Result<Vec<RunningComputerApp>, String> {
    computer_use::list_running_apps()
}

#[tauri::command]
fn list_computer_app_scopes(
    state: State<'_, AppState>,
    bot_id: String,
) -> Result<Vec<ComputerAppScope>, String> {
    computer_use::list_app_scopes(&state, &bot_id)
}

#[tauri::command]
fn save_computer_app_scope(
    state: State<'_, AppState>,
    request: SaveComputerAppScopeRequest,
) -> Result<ComputerAppScope, String> {
    computer_use::save_app_scope(&state, request)
}

#[tauri::command]
fn delete_computer_app_scope(
    state: State<'_, AppState>,
    request: DeleteComputerAppScopeRequest,
) -> Result<bool, String> {
    computer_use::delete_app_scope(&state, request)
}

#[tauri::command]
async fn inspect_computer_app(
    state: State<'_, AppState>,
    request: InspectComputerAppRequest,
) -> Result<ComputerAppInspection, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || computer_use::inspect_app(&state, request))
        .await
        .map_err(|error| format!("Computer inspection worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn run_computer_action(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: RunComputerActionRequest,
    on_event: tauri::ipc::Channel<ProviderRunEvent>,
) -> Result<ComputerActionResult, String> {
    let state = state.inner().clone();
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        computer_use::run_action(&state, &runs, request, Some(on_event))
    })
    .await
    .map_err(|error| format!("Computer action worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn take_over_computer_run(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: InspectComputerAppRequest,
    run_id: String,
) -> Result<bool, String> {
    computer_use::take_over(&state, &runs, request, &run_id)
}

#[tauri::command]
fn list_local_bot_delegations(
    state: State<'_, AppState>,
    parent_bot_id: Option<String>,
) -> Result<Vec<LocalBotDelegation>, String> {
    delegations::list_local_bot_delegations(&state, parent_bot_id.as_deref())
}

#[tauri::command]
fn create_local_bot_delegation(
    state: State<'_, AppState>,
    request: CreateLocalBotDelegationRequest,
) -> Result<LocalBotDelegation, String> {
    delegations::create_local_bot_delegation(&state, request)
}

#[tauri::command]
fn start_local_bot_delegation_target(
    state: State<'_, AppState>,
    request: StartLocalBotDelegationTargetRequest,
) -> Result<LocalBotDelegation, String> {
    delegations::start_local_bot_delegation_target(&state, request)
}

#[tauri::command]
fn finish_local_bot_delegation_target(
    state: State<'_, AppState>,
    request: FinishLocalBotDelegationTargetRequest,
) -> Result<LocalBotDelegation, String> {
    delegations::finish_local_bot_delegation_target(&state, request)
}

#[tauri::command]
fn recover_local_bot_delegations(
    state: State<'_, AppState>,
) -> Result<Vec<LocalBotDelegation>, String> {
    delegations::recover_local_bot_delegations(&state)
}

#[tauri::command]
fn cancel_local_bot_delegation(
    state: State<'_, AppState>,
    id: String,
) -> Result<LocalBotDelegation, String> {
    delegations::cancel_local_bot_delegation(&state, &id)
}

#[tauri::command]
fn list_local_bot_memories(
    state: State<'_, AppState>,
    bot_id: String,
) -> Result<Vec<LocalBotMemoryRecord>, String> {
    storage::list_local_bot_memories(&state, &bot_id)
}

#[tauri::command]
fn save_local_bot_memory(
    state: State<'_, AppState>,
    request: SaveLocalBotMemoryRequest,
) -> Result<LocalBotMemoryRecord, String> {
    storage::save_local_bot_memory(&state, request)
}

#[tauri::command]
fn list_local_bot_memory_proposals(
    state: State<'_, AppState>,
    bot_id: String,
) -> Result<Vec<LocalBotMemoryProposalRecord>, String> {
    storage::list_local_bot_memory_proposals(&state, &bot_id)
}

#[tauri::command]
fn create_local_bot_memory_proposal(
    state: State<'_, AppState>,
    request: CreateLocalBotMemoryProposalRequest,
) -> Result<Option<LocalBotMemoryProposalRecord>, String> {
    storage::create_local_bot_memory_proposal(&state, request)
}

#[tauri::command]
fn review_local_bot_memory_proposal(
    state: State<'_, AppState>,
    request: ReviewLocalBotMemoryProposalRequest,
) -> Result<Option<LocalBotMemoryRecord>, String> {
    storage::review_local_bot_memory_proposal(&state, request)
}

#[tauri::command]
fn delete_local_bot_memory(
    state: State<'_, AppState>,
    request: DeleteLocalBotMemoryRequest,
) -> Result<LocalBotMemoryRecord, String> {
    storage::delete_local_bot_memory(&state, request)
}

#[tauri::command]
fn clear_local_bot_memories(
    state: State<'_, AppState>,
    request: ClearLocalBotMemoriesRequest,
) -> Result<usize, String> {
    storage::clear_local_bot_memories(&state, request)
}

#[tauri::command]
fn list_local_bot_skills(state: State<'_, AppState>) -> Result<Vec<LocalBotSkillRecord>, String> {
    storage::list_local_bot_skills(&state)
}

#[tauri::command]
fn save_local_bot_skill(
    state: State<'_, AppState>,
    request: SaveLocalBotSkillRequest,
) -> Result<LocalBotSkillRecord, String> {
    storage::save_local_bot_skill(&state, request)
}

#[tauri::command]
fn import_local_bot_skill(
    state: State<'_, AppState>,
    actor_bot_id: String,
) -> Result<Option<LocalBotSkillRecord>, String> {
    let Some(selected) = macos::open_skill_package()? else {
        return Ok(None);
    };
    storage::import_local_bot_skill_package(
        &state,
        &actor_bot_id,
        &selected.bytes,
        &chrono::Utc::now().to_rfc3339(),
    )
    .map(Some)
}

#[tauri::command]
fn review_imported_bot_skill(
    state: State<'_, AppState>,
    request: ReviewImportedBotSkillRequest,
) -> Result<Option<LocalBotSkillRecord>, String> {
    storage::review_imported_bot_skill(&state, request)
}

#[tauri::command]
fn delete_local_bot_skill(
    state: State<'_, AppState>,
    request: DeleteLocalBotSkillRequest,
) -> Result<LocalBotSkillRecord, String> {
    storage::delete_local_bot_skill(&state, request)
}

#[tauri::command]
fn update_local_bot_status(
    state: State<'_, AppState>,
    request: UpdateLocalBotStatusRequest,
) -> Result<LocalBotRecord, String> {
    storage::update_local_bot_status(&state, request)
}

#[tauri::command]
fn update_local_bot_approval_mode(
    state: State<'_, AppState>,
    request: UpdateLocalBotApprovalModeRequest,
) -> Result<LocalBotRecord, String> {
    storage::update_local_bot_approval_mode(&state, request)
}

#[tauri::command]
fn update_local_bot_browser_domains(
    state: State<'_, AppState>,
    request: UpdateLocalBotBrowserDomainsRequest,
) -> Result<LocalBotRecord, String> {
    storage::update_local_bot_browser_domains(&state, request)
}

#[tauri::command]
fn update_local_bot_engine_policy(
    state: State<'_, AppState>,
    request: UpdateLocalBotEnginePolicyRequest,
) -> Result<LocalBotRecord, String> {
    storage::update_local_bot_engine_policy(&state, request)
}

#[tauri::command]
fn update_local_bot_profile(
    state: State<'_, AppState>,
    request: UpdateLocalBotProfileRequest,
) -> Result<LocalBotRecord, String> {
    storage::update_local_bot_profile(&state, request)
}

#[tauri::command]
fn update_local_bot_goal(
    state: State<'_, AppState>,
    request: UpdateLocalBotGoalRequest,
) -> Result<LocalBotRecord, String> {
    storage::update_local_bot_goal(&state, request)
}

#[tauri::command]
fn update_local_bot_routines(
    state: State<'_, AppState>,
    request: UpdateLocalBotRoutinesRequest,
) -> Result<LocalBotRecord, String> {
    storage::update_local_bot_routines(&state, request)
}

fn refresh_workspace_folder(state: &AppState) {
    let stored = match storage::load_workspace_bookmark(state) {
        Ok(Some(stored)) => stored,
        Ok(None) => return,
        Err(error) => {
            eprintln!("Could not read the stored workspace folder: {error}");
            return;
        }
    };
    match macos::resolve_workspace_bookmark(&stored.bookmark) {
        Ok(grant) => {
            if let Err(error) = storage::save_workspace_folder(
                state,
                &grant.path,
                &grant.bookmark,
                grant.stale,
                grant.access_validated,
            ) {
                eprintln!("Could not refresh the workspace folder permission: {error}");
            }
        }
        Err(error) => {
            eprintln!("Could not restore access to {}: {error}", stored.path);
            if let Err(mark_error) = storage::mark_workspace_folder_unavailable(state) {
                eprintln!("Could not update the workspace folder status: {mark_error}");
            }
        }
    }
}

#[tauri::command]
fn choose_workspace_folder(
    state: State<'_, AppState>,
    purpose: Option<String>,
) -> Result<Option<WorkspaceSnapshot>, String> {
    let Some(grant) = macos::choose_workspace_folder(purpose.as_deref())? else {
        return Ok(None);
    };
    storage::save_workspace_folder(
        &state,
        &grant.path,
        &grant.bookmark,
        grant.stale,
        grant.access_validated,
    )
    .map(Some)
}

#[tauri::command]
async fn read_local_project_fingerprint(
    state: State<'_, AppState>,
) -> Result<LocalProjectFingerprint, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        tool_runtime::read_local_project_fingerprint(&state)
    })
    .await
    .map_err(|error| format!("Project change detection stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn choose_local_mcp_executable() -> Result<Option<String>, String> {
    macos::choose_local_executable()
}

#[tauri::command]
fn list_local_mcp_servers(state: State<'_, AppState>) -> Result<Vec<LocalMcpServer>, String> {
    local_mcp::list_local_mcp_servers(&state)
}

#[tauri::command]
async fn inspect_local_mcp_server(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: LocalMcpServerDraft,
    on_event: tauri::ipc::Channel<ProviderRunEvent>,
) -> Result<LocalMcpInspection, String> {
    let state = state.inner().clone();
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        local_mcp::inspect_local_mcp_server(&state, request, &runs, Some(on_event))
    })
    .await
    .map_err(|error| format!("Local MCP inspection stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn save_local_mcp_server(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: SaveLocalMcpServerRequest,
    on_event: tauri::ipc::Channel<ProviderRunEvent>,
) -> Result<LocalMcpServer, String> {
    let state = state.inner().clone();
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        local_mcp::save_local_mcp_server(&state, request, &runs, Some(on_event))
    })
    .await
    .map_err(|error| format!("Local MCP save stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn delete_local_mcp_server(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<LocalMcpServer>, String> {
    local_mcp::delete_local_mcp_server(&state, &id)
}

#[tauri::command]
fn discard_prepared_mcp_approval(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    local_mcp::discard_prepared_mcp_approval(&state, &run_id)
}

#[tauri::command]
fn discard_prepared_local_tool_approval(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), String> {
    local_browser::discard_prepared_browser_approval(&state, &run_id);
    local_mcp::discard_prepared_mcp_approval(&state, &run_id)
}

#[tauri::command]
fn open_local_browser(
    app: AppHandle,
    state: State<'_, AppState>,
    browsers: State<'_, BrowserRegistry>,
    request: OpenLocalBrowserRequest,
) -> Result<LocalBrowserSession, String> {
    local_browser::open_local_browser(&app, &state, &browsers, request)
}

#[tauri::command]
fn resize_local_browser(
    app: AppHandle,
    browsers: State<'_, BrowserRegistry>,
    request: ResizeLocalBrowserRequest,
) -> Result<LocalBrowserSession, String> {
    local_browser::resize_local_browser(&app, &browsers, request)
}

#[tauri::command]
fn set_local_browser_visibility(
    app: AppHandle,
    browsers: State<'_, BrowserRegistry>,
    request: BrowserVisibilityRequest,
) -> Result<LocalBrowserSession, String> {
    local_browser::set_local_browser_visibility(
        &app,
        &browsers,
        &request.session_id,
        request.visible,
    )
}

#[tauri::command]
fn preview_local_browser_navigation(
    browsers: State<'_, BrowserRegistry>,
    request: NavigateLocalBrowserRequest,
) -> Result<BrowserNavigationPreview, String> {
    local_browser::preview_local_browser_navigation(&browsers, &request)
}

#[tauri::command]
fn update_local_browser_domains(
    browsers: State<'_, BrowserRegistry>,
    request: UpdateBrowserDomainsRequest,
) -> Result<LocalBrowserSession, String> {
    local_browser::update_local_browser_domains(&browsers, request)
}

#[tauri::command]
fn navigate_local_browser(
    app: AppHandle,
    browsers: State<'_, BrowserRegistry>,
    request: NavigateLocalBrowserRequest,
) -> Result<LocalBrowserSession, String> {
    local_browser::navigate_local_browser(&app, &browsers, request)
}

#[tauri::command]
fn browser_history_action(
    app: AppHandle,
    browsers: State<'_, BrowserRegistry>,
    request: BrowserHistoryRequest,
) -> Result<LocalBrowserSession, String> {
    local_browser::browser_history_action(&app, &browsers, &request.session_id, &request.direction)
}

#[tauri::command]
fn arm_local_browser_download(
    browsers: State<'_, BrowserRegistry>,
    request: BrowserSessionRequest,
) -> Result<LocalBrowserSession, String> {
    local_browser::arm_local_browser_download(&browsers, &request.session_id)
}

#[tauri::command]
fn start_local_browser_teaching(
    app: AppHandle,
    browsers: State<'_, BrowserRegistry>,
    request: BrowserSessionRequest,
) -> Result<LocalBrowserTeachingCapture, String> {
    local_browser::start_local_browser_teaching(&app, &browsers, &request.session_id)
}

#[tauri::command]
fn capture_local_browser_teaching(
    app: AppHandle,
    browsers: State<'_, BrowserRegistry>,
    request: BrowserSessionRequest,
) -> Result<LocalBrowserTeachingCapture, String> {
    local_browser::capture_local_browser_teaching(&app, &browsers, &request.session_id)
}

#[tauri::command]
fn finish_local_browser_teaching(
    app: AppHandle,
    browsers: State<'_, BrowserRegistry>,
    request: BrowserSessionRequest,
) -> Result<LocalBrowserTeachingCapture, String> {
    local_browser::finish_local_browser_teaching(&app, &browsers, &request.session_id)
}

#[tauri::command]
async fn dry_run_local_browser_teaching(
    app: AppHandle,
    browsers: State<'_, BrowserRegistry>,
    request: BrowserSessionRequest,
) -> Result<LocalBrowserTeachingDryRun, String> {
    let browsers = browsers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        local_browser::dry_run_local_browser_teaching(&app, &browsers, &request.session_id)
    })
    .await
    .map_err(|error| format!("Browser replay check stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn close_local_browser(
    app: AppHandle,
    state: State<'_, AppState>,
    browsers: State<'_, BrowserRegistry>,
    request: BrowserSessionRequest,
) -> Result<(), String> {
    local_browser::close_local_browser(&app, &state, &browsers, &request.session_id)
}

#[tauri::command]
fn probe_background_service() -> BackgroundServiceProbe {
    macos::probe_background_service()
}

#[tauri::command]
fn set_background_work_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<BackgroundServiceProbe, String> {
    let probe = macos::set_background_service_enabled(enabled)?;
    if !enabled || probe.status != "enabled" {
        scheduler::pause_all_schedule_claims(&state, "Paused until background work is enabled.")?;
        event_routines::pause_all_event_claims(&state, "Paused until background work is enabled.")?;
    }
    Ok(probe)
}

#[tauri::command]
fn open_background_work_settings() {
    macos::open_background_service_settings();
}

#[tauri::command]
fn get_bot_autonomy_policy(
    app: AppHandle,
    state: State<'_, AppState>,
    timezone: String,
) -> Result<BotAutonomyPolicy, String> {
    let policy = autonomy::read_policy(&state, Some(&timezone))?;
    #[cfg(feature = "direct-release")]
    autonomy::refresh_menu_bar(&app, &policy)?;
    #[cfg(not(feature = "direct-release"))]
    let _ = app;
    Ok(policy)
}

#[tauri::command]
fn update_bot_autonomy_policy(
    app: AppHandle,
    state: State<'_, AppState>,
    request: UpdateBotAutonomyPolicyRequest,
) -> Result<BotAutonomyPolicy, String> {
    let policy = autonomy::update_policy(&state, request)?;
    #[cfg(feature = "direct-release")]
    autonomy::refresh_menu_bar(&app, &policy)?;
    #[cfg(not(feature = "direct-release"))]
    let _ = app;
    Ok(policy)
}

#[tauri::command]
fn deliver_due_daily_digest(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<LocalNotificationRoute>, String> {
    autonomy::deliver_due_daily_digest(&app, &state)
}

#[tauri::command]
fn list_recent_routine_activity(
    state: State<'_, AppState>,
) -> Result<Vec<RoutineActivityItem>, String> {
    routine_activity::list_recent_routine_activity(&state)
}

#[tauri::command]
fn list_local_schedules(state: State<'_, AppState>) -> Result<Vec<LocalSchedule>, String> {
    scheduler::list_local_schedules(&state)
}

#[tauri::command]
fn list_local_event_routines(state: State<'_, AppState>) -> Result<Vec<LocalEventRoutine>, String> {
    event_routines::list_local_event_routines(&state)
}

#[tauri::command]
fn save_local_event_routine(
    state: State<'_, AppState>,
    request: SaveLocalEventRoutineRequest,
) -> Result<LocalEventRoutine, String> {
    event_routines::save_local_event_routine(&state, request)
}

#[tauri::command]
fn set_local_event_routine_enabled(
    state: State<'_, AppState>,
    request: SetLocalEventRoutineEnabledRequest,
) -> Result<LocalEventRoutine, String> {
    event_routines::set_local_event_routine_enabled(&state, request)
}

#[tauri::command]
fn delete_local_event_routine(state: State<'_, AppState>, id: String) -> Result<(), String> {
    event_routines::delete_local_event_routine(&state, &id)
}

#[tauri::command]
fn claim_changed_event_routines(
    state: State<'_, AppState>,
    request: ClaimChangedEventRoutinesRequest,
) -> Result<Vec<ClaimedEventRoutineOccurrence>, String> {
    if macos::probe_background_service().status != "enabled" {
        return Ok(Vec::new());
    }
    if !autonomy::new_work_allowed(&state)? {
        return Ok(Vec::new());
    }
    event_routines::claim_changed_event_routines(&state, request)
}

#[tauri::command]
fn mark_event_routine_occurrence_running(
    state: State<'_, AppState>,
    idempotency_key: String,
    claim_token: String,
) -> Result<EventRoutineOccurrenceStatus, String> {
    event_routines::mark_event_routine_occurrence_running(&state, &idempotency_key, &claim_token)
}

#[tauri::command]
fn renew_event_routine_occurrence_lease(
    state: State<'_, AppState>,
    idempotency_key: String,
    claim_token: String,
) -> Result<EventRoutineOccurrenceStatus, String> {
    event_routines::renew_event_routine_occurrence_lease(&state, &idempotency_key, &claim_token)
}

#[tauri::command]
fn finish_event_routine_occurrence(
    state: State<'_, AppState>,
    request: FinishEventRoutineOccurrenceRequest,
) -> Result<EventRoutineOccurrenceStatus, String> {
    event_routines::finish_event_routine_occurrence(&state, request)
}

#[tauri::command]
fn event_routine_execution_permitted(
    state: State<'_, AppState>,
    idempotency_key: String,
    claim_token: String,
) -> Result<bool, String> {
    if macos::probe_background_service().status != "enabled" {
        return Ok(false);
    }
    if !autonomy::continuation_allowed(&state)? {
        return Ok(false);
    }
    event_routines::event_routine_execution_permitted(&state, &idempotency_key, &claim_token)
}

#[tauri::command]
fn save_local_schedule(
    state: State<'_, AppState>,
    request: SaveLocalScheduleRequest,
) -> Result<LocalSchedule, String> {
    scheduler::save_local_schedule(&state, request)
}

#[tauri::command]
fn set_local_schedule_enabled(
    state: State<'_, AppState>,
    request: SetLocalScheduleEnabledRequest,
) -> Result<LocalSchedule, String> {
    scheduler::set_local_schedule_enabled(&state, request)
}

#[tauri::command]
fn delete_local_schedule(state: State<'_, AppState>, id: String) -> Result<(), String> {
    scheduler::delete_local_schedule(&state, &id)
}

#[tauri::command]
fn claim_due_local_schedules(
    state: State<'_, AppState>,
    owner: String,
    limit: usize,
    online: bool,
) -> Result<Vec<ClaimedScheduleOccurrence>, String> {
    if !autonomy::new_work_allowed(&state)? {
        return Ok(Vec::new());
    }
    let environment = ScheduleEnvironment {
        background_enabled: macos::probe_background_service().status == "enabled",
        online,
        ..ScheduleEnvironment::default()
    };
    scheduler::claim_due_schedules(&state, &owner, &environment, limit)
}

#[tauri::command]
fn mark_schedule_occurrence_running(
    state: State<'_, AppState>,
    idempotency_key: String,
    claim_token: String,
) -> Result<ScheduleOccurrenceStatus, String> {
    scheduler::mark_schedule_occurrence_running(&state, &idempotency_key, &claim_token)
}

#[tauri::command]
fn renew_schedule_occurrence_lease(
    state: State<'_, AppState>,
    idempotency_key: String,
    claim_token: String,
) -> Result<ScheduleOccurrenceStatus, String> {
    scheduler::renew_schedule_occurrence_lease(&state, &idempotency_key, &claim_token)
}

#[tauri::command]
fn finish_schedule_occurrence(
    state: State<'_, AppState>,
    request: FinishScheduleOccurrenceRequest,
) -> Result<ScheduleOccurrenceStatus, String> {
    scheduler::finish_schedule_occurrence(&state, request)
}

#[tauri::command]
fn schedule_execution_permitted(
    state: State<'_, AppState>,
    idempotency_key: String,
    claim_token: String,
) -> Result<bool, String> {
    if macos::probe_background_service().status != "enabled" {
        return Ok(false);
    }
    if !autonomy::continuation_allowed(&state)? {
        return Ok(false);
    }
    scheduler::schedule_execution_permitted(&state, &idempotency_key, &claim_token)
}

#[tauri::command]
fn list_schedule_occurrences(
    state: State<'_, AppState>,
    schedule_id: String,
) -> Result<Vec<ScheduleOccurrenceStatus>, String> {
    scheduler::list_schedule_occurrences(&state, &schedule_id)
}

#[tauri::command]
fn show_local_notification(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ShowLocalNotificationRequest,
) -> Result<LocalNotificationRoute, String> {
    local_notifications::show_local_notification(&app, &state, request)
}

#[tauri::command]
fn take_opened_local_notification(
    state: State<'_, AppState>,
) -> Result<Option<LocalNotificationRoute>, String> {
    local_notifications::take_opened_local_notification(&state)
}

#[tauri::command]
fn consume_local_notification(state: State<'_, AppState>, id: String) -> Result<(), String> {
    local_notifications::consume_local_notification(&state, &id)
}

#[tauri::command]
fn export_local_workspace(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let bytes = storage::export_workspace_archive(&state)?;
    macos::save_workspace_archive(&bytes)
}

#[tauri::command]
fn get_local_pilot_report(state: State<'_, AppState>) -> Result<LocalPilotReport, String> {
    pilot_metrics::build_local_pilot_report(&state)
}

#[tauri::command]
fn record_local_unexpected_action(
    state: State<'_, AppState>,
    category: String,
) -> Result<LocalPilotReport, String> {
    pilot_metrics::record_unexpected_action(&state, &category)
}

#[tauri::command]
fn export_local_pilot_report(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let report = pilot_metrics::build_local_pilot_report(&state)?;
    let bytes = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
    macos::save_pilot_report(&bytes)
}

#[tauri::command]
fn import_local_workspace(
    state: State<'_, AppState>,
    confirm_replace: bool,
) -> Result<Option<ImportedWorkspace>, String> {
    if !confirm_replace {
        return Err("Confirm that this backup should replace the current local workspace.".into());
    }
    let Some(selected) = macos::open_workspace_archive()? else {
        return Ok(None);
    };
    let snapshot = storage::restore_workspace_archive(&state, &selected.bytes, true)?;
    Ok(Some(ImportedWorkspace {
        path: selected.path,
        snapshot,
    }))
}

#[tauri::command]
async fn delete_local_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    browsers: State<'_, BrowserRegistry>,
    confirmation: String,
) -> Result<WorkspaceSnapshot, String> {
    if confirmation != "DELETE" {
        return Err("Type DELETE to remove all local Codelit data.".into());
    }
    delete_all_saved_credentials(&state.app_data_dir())?;
    local_browser::delete_all_browser_data(&app, &state, &browsers).await?;
    storage::delete_local_data(&state)
}

fn delete_all_saved_credentials(app_data_dir: &std::path::Path) -> Result<(), String> {
    delete_all_saved_credentials_with(
        hosted_bridge::delete_all_credentials,
        delete_all_provider_api_keys,
        || copilot::delete_persistent_profile(app_data_dir).map_err(|error| error.to_string()),
    )
}

fn delete_all_saved_credentials_with(
    delete_hosted: impl FnOnce() -> Result<(), String>,
    delete_provider_api_keys: impl FnOnce() -> Result<(), String>,
    delete_copilot_profile: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Err(error) = delete_hosted() {
        failures.push(error);
    }
    if let Err(error) = delete_provider_api_keys() {
        failures.push(error);
    }
    if let Err(error) = delete_copilot_profile() {
        failures.push(format!("GitHub Copilot: {error}"));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Saved credential cleanup was incomplete, so local workspace data was not deleted. {}",
            failures.join(" ")
        ))
    }
}

fn delete_all_provider_api_keys() -> Result<(), String> {
    let store = ProviderCredentialStore::default();
    delete_all_provider_api_keys_with(|provider| {
        let reference = provider_credential_reference(provider)?;
        store
            .delete(&reference)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

fn delete_all_provider_api_keys_with(
    mut delete: impl FnMut(ByokProvider) -> Result<(), String>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for provider in [
        ByokProvider::OpenAi,
        ByokProvider::Anthropic,
        ByokProvider::Gemini,
    ] {
        if let Err(error) = delete(provider) {
            failures.push(format!("{}: {error}", provider.as_str()));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Provider API credential cleanup was incomplete: {}",
            failures.join(" ")
        ))
    }
}

#[cfg(test)]
mod credential_cleanup_tests {
    use super::*;

    #[test]
    fn provider_key_cleanup_attempts_every_provider_and_aggregates_failures() {
        let mut attempted = Vec::new();
        let error = delete_all_provider_api_keys_with(|provider| {
            attempted.push(provider);
            if provider == ByokProvider::Anthropic {
                Ok(())
            } else {
                Err("Keychain unavailable.".into())
            }
        })
        .expect_err("two provider deletions fail");

        assert_eq!(
            attempted,
            [
                ByokProvider::OpenAi,
                ByokProvider::Anthropic,
                ByokProvider::Gemini
            ]
        );
        assert!(error.contains("openai: Keychain unavailable."));
        assert!(error.contains("gemini: Keychain unavailable."));
    }

    #[test]
    fn credential_preflight_attempts_hosted_and_provider_cleanup() {
        let attempted = std::cell::RefCell::new(Vec::new());
        let error = delete_all_saved_credentials_with(
            || {
                attempted.borrow_mut().push("hosted");
                Err("Hosted cleanup failed.".into())
            },
            || {
                attempted.borrow_mut().push("provider");
                Err("Provider cleanup failed.".into())
            },
            || {
                attempted.borrow_mut().push("copilot-profile");
                Err("Copilot profile cleanup failed.".into())
            },
        )
        .expect_err("all credential cleanup groups report failures");

        assert_eq!(
            *attempted.borrow(),
            ["hosted", "provider", "copilot-profile"]
        );
        assert!(error.contains("local workspace data was not deleted"));
        assert!(error.contains("Hosted cleanup failed."));
        assert!(error.contains("Provider cleanup failed."));
        assert!(error.contains("Copilot profile cleanup failed."));
    }

    #[test]
    fn copilot_profile_cleanup_failure_preserves_workspace_data() {
        let directory = tempfile::tempdir().expect("workspace directory");
        let workspace = directory.path().join("codelit.sqlite3");
        std::fs::write(&workspace, b"workspace must survive").expect("seed workspace");
        let reset_attempted = std::cell::Cell::new(false);

        let cleanup = delete_all_saved_credentials_with(
            || Ok(()),
            || Ok(()),
            || Err("Could not remove the Copilot sign-in profile.".into()),
        );
        if cleanup.is_ok() {
            reset_attempted.set(true);
            std::fs::remove_file(&workspace).expect("delete workspace");
        }

        let error = cleanup.expect_err("profile cleanup blocks reset");
        assert!(error.contains("local workspace data was not deleted"));
        assert!(!reset_attempted.get());
        assert_eq!(
            std::fs::read(&workspace).expect("workspace preserved"),
            b"workspace must survive"
        );
    }
}

#[tauri::command]
fn probe_desktop_cloud() -> Result<hosted_bridge::DesktopCloudStatus, String> {
    hosted_bridge::status()
}

#[tauri::command]
async fn start_desktop_cloud_pairing(
    app: AppHandle,
) -> Result<hosted_bridge::DesktopPairingStart, String> {
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || hosted_bridge::start(&version))
        .await
        .map_err(|error| format!("Codelit Cloud pairing worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn finish_desktop_cloud_pairing() -> Result<hosted_bridge::DesktopCloudStatus, String> {
    tauri::async_runtime::spawn_blocking(hosted_bridge::finish)
        .await
        .map_err(|error| format!("Codelit Cloud pairing worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn disconnect_desktop_cloud() -> Result<hosted_bridge::DesktopCloudStatus, String> {
    hosted_bridge::disconnect()
}

#[tauri::command]
async fn publish_desktop_hosted_promotion(
    state: State<'_, AppState>,
    envelope: serde_json::Value,
) -> Result<hosted_bridge::DesktopPromotionStart, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || hosted_bridge::publish(&state, envelope))
        .await
        .map_err(|error| format!("Codelit Cloud promotion worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn sync_desktop_cloud(
    state: State<'_, AppState>,
) -> Result<desktop_cloud::DesktopCloudSyncView, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || hosted_bridge::sync(&state))
        .await
        .map_err(|error| format!("Codelit Cloud sync worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn list_desktop_cloud_links(
    state: State<'_, AppState>,
) -> Result<Vec<desktop_cloud::DesktopCloudLink>, String> {
    desktop_cloud::list_links(&state)
}

#[tauri::command]
fn open_desktop_cloud_href(href: String) -> Result<(), String> {
    hosted_bridge::open_href(&href)
}

#[tauri::command]
fn append_thread_message(
    state: State<'_, AppState>,
    request: AppendMessageRequest,
) -> Result<WorkspaceSnapshot, String> {
    storage::append_thread_message(&state, request)
}

#[tauri::command]
fn save_artifact_version(
    state: State<'_, AppState>,
    request: SaveArtifactRequest,
) -> Result<WorkspaceSnapshot, String> {
    storage::save_artifact_version(&state, request)
}

#[tauri::command]
fn begin_local_run(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: BeginLocalRunRequest,
) -> Result<WorkspaceSnapshot, String> {
    let run_id = request.run_id.clone();
    runs.start_lifecycle(&run_id)?;
    match storage::begin_local_run(&state, request) {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            runs.finish_lifecycle(&run_id);
            Err(error)
        }
    }
}

#[tauri::command]
fn save_run_checkpoint(
    state: State<'_, AppState>,
    request: SaveRunCheckpointRequest,
) -> Result<WorkspaceSnapshot, String> {
    storage::save_run_checkpoint(&state, request)
}

#[tauri::command]
fn record_run_approval(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: RecordRunApprovalRequest,
) -> Result<WorkspaceSnapshot, String> {
    let run_id = request.run_id.clone();
    let lifecycle_started = runs.ensure_lifecycle(&run_id)?;
    match storage::record_run_approval(&state, request) {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            if lifecycle_started {
                runs.finish_lifecycle(&run_id);
            }
            Err(error)
        }
    }
}

#[tauri::command]
fn record_local_check(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: RecordLocalCheckRequest,
) -> Result<WorkspaceSnapshot, String> {
    let run_id = request.run_id.clone();
    let result = storage::record_local_check(&state, request);
    runs.finish_lifecycle(&run_id);
    result
}

#[tauri::command]
fn store_artifact_file(
    state: State<'_, AppState>,
    request: StoreArtifactFileRequest,
) -> Result<WorkspaceSnapshot, String> {
    storage::store_artifact_file(&state, request)
}

#[tauri::command]
async fn probe_providers(state: State<'_, AppState>) -> Result<Vec<ProviderProbe>, String> {
    let app_data_dir = state.app_data_dir();
    tauri::async_runtime::spawn_blocking(move || providers::probe_providers(&app_data_dir))
        .await
        .map_err(|error| format!("Provider discovery worker stopped unexpectedly: {error}"))
}

#[tauri::command]
async fn discover_local_models(state: State<'_, AppState>) -> Result<LocalModelDiscovery, String> {
    let app_data_dir = state.app_data_dir();
    tauri::async_runtime::spawn_blocking(move || {
        model_discovery::discover_local_models(&app_data_dir)
    })
    .await
    .map_err(|error| format!("Local model discovery worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn open_local_model_page(model_id: String) -> Result<(), String> {
    let url = model_discovery::model_page_url(model_id.trim())?;
    macos::open_hugging_face_model_page(url.as_str())
}

fn provider_credential_reference(provider: ByokProvider) -> Result<ProviderCredentialRef, String> {
    ProviderCredentialRef::new(provider, DEFAULT_PROVIDER_CREDENTIAL_ACCOUNT)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn probe_provider_api_keys() -> Result<Vec<ProviderCredentialStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let store = ProviderCredentialStore::default();
        [
            ByokProvider::OpenAi,
            ByokProvider::Anthropic,
            ByokProvider::Gemini,
        ]
        .into_iter()
        .map(|provider| {
            let reference = provider_credential_reference(provider)?;
            Ok(store.probe_status(&reference))
        })
        .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|error| format!("Provider credential worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn save_provider_api_key(
    request: SaveProviderApiKeyRequest,
) -> Result<ProviderCredentialStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let reference = provider_credential_reference(request.provider)?;
        let secret =
            SecretBytes::from_string(request.api_key).map_err(|error| error.to_string())?;
        ProviderCredentialStore::default()
            .save(&reference, secret)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Provider credential worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn delete_provider_api_key(
    request: DeleteProviderApiKeyRequest,
) -> Result<ProviderCredentialStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let reference = provider_credential_reference(request.provider)?;
        ProviderCredentialStore::default()
            .delete(&reference)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Provider credential worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn open_codex_sign_in() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(providers::start_codex_sign_in)
        .await
        .map_err(|error| format!("Codex sign-in worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn open_copilot_sign_in(state: State<'_, AppState>) -> Result<(), String> {
    let app_data_dir = state.app_data_dir();
    tauri::async_runtime::spawn_blocking(move || providers::start_copilot_sign_in(&app_data_dir))
        .await
        .map_err(|error| format!("GitHub Copilot sign-in worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn open_provider_setup(provider: String) -> Result<(), String> {
    let url = match provider.trim() {
        "codex" => "https://developers.openai.com/codex/cli",
        "copilot" => {
            "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli"
        }
        "antigravity" => "https://antigravity.google/docs/cli-install",
        "ollama" => "https://ollama.com/download/mac",
        "lmstudio" => "https://lmstudio.ai/download",
        _ => return Err("No approved setup page exists for this provider.".into()),
    };
    macos::open_external_https(url)
}

#[tauri::command]
async fn run_provider_task(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: ProviderTaskRequest,
) -> Result<ProviderTaskResult, String> {
    let app_data_dir = state.app_data_dir();
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        provider_runtime::run_provider_task_stream(request, Some(app_data_dir), &runs, None)
    })
    .await
    .map_err(|error| format!("Provider task worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn run_provider_task_stream(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: ProviderTaskRequest,
    on_event: tauri::ipc::Channel<ProviderRunEvent>,
) -> Result<ProviderTaskResult, String> {
    let app_data_dir = state.app_data_dir();
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        provider_runtime::run_provider_task_stream(
            request,
            Some(app_data_dir),
            &runs,
            Some(on_event),
        )
    })
    .await
    .map_err(|error| format!("Provider task worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
fn cancel_provider_task(runs: State<'_, RunRegistry>, run_id: String) -> bool {
    runs.cancel(run_id.trim())
}

#[tauri::command]
async fn manage_local_model(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: ModelManagerRequest,
    on_event: tauri::ipc::Channel<ProviderRunEvent>,
) -> Result<model_manager::ProviderModel, String> {
    let app_data_dir = state.app_data_dir();
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        provider_runtime::manage_local_model(request, &app_data_dir, &runs, Some(on_event))
    })
    .await
    .map_err(|error| format!("Model manager worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn run_local_tool_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    browsers: State<'_, BrowserRegistry>,
    request: LocalToolBatchRequest,
    on_event: tauri::ipc::Channel<ProviderRunEvent>,
) -> Result<LocalToolBatchResult, String> {
    let state = state.inner().clone();
    let runs = runs.inner().clone();
    let browsers = browsers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        tool_runtime::run_local_tool_batch_with_browser(
            &app,
            &state,
            &browsers,
            request,
            &runs,
            Some(on_event),
        )
    })
    .await
    .map_err(|error| format!("Local tool worker stopped unexpectedly: {error}"))?
}

#[tauri::command]
async fn prepare_local_tool_approval(
    state: State<'_, AppState>,
    runs: State<'_, RunRegistry>,
    request: LocalToolApprovalRequest,
    on_event: tauri::ipc::Channel<ProviderRunEvent>,
) -> Result<LocalToolApprovalPreview, String> {
    let state = state.inner().clone();
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        tool_runtime::prepare_local_tool_approval(&state, request, &runs, Some(on_event))
    })
    .await
    .map_err(|error| format!("Local approval worker stopped unexpectedly: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let background_launch =
        std::env::args().any(|argument| argument == "--process-local-schedules");
    let builder = tauri::Builder::default();
    #[cfg(feature = "direct-release")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    let app = builder
        .setup(move |app| {
            #[cfg(debug_assertions)]
            let app_data_dir = if let Some(path) = std::env::var_os("CODELIT_DEV_DATA_DIR") {
                let path = std::path::PathBuf::from(path);
                if !path.is_absolute() {
                    return Err(std::io::Error::other(
                        "CODELIT_DEV_DATA_DIR must be an absolute path.",
                    )
                    .into());
                }
                path
            } else {
                app.path().app_data_dir()?
            };
            #[cfg(not(debug_assertions))]
            let app_data_dir = app.path().app_data_dir()?;
            let state = AppState::new(app_data_dir).map_err(std::io::Error::other)?;
            app.manage(state);
            app.manage(RunRegistry::default());
            app.manage(BrowserRegistry::default());
            #[cfg(feature = "direct-release")]
            app.manage(UpdateRegistry::default());
            local_notifications::install_notification_delegate(app.handle())?;
            #[cfg(feature = "direct-release")]
            autonomy::install_menu_bar(app.handle()).map_err(std::io::Error::other)?;
            if background_launch && let Some(window) = app.get_webview_window("main") {
                window.hide()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_local_workspace,
            bootstrap_local_bots,
            create_local_bot,
            set_active_local_bot,
            open_local_bot_context,
            list_local_bot_group_members,
            update_local_bot_group_members,
            list_local_bot_tables,
            create_local_bot_table,
            append_local_bot_table_row,
            open_local_bot_table,
            export_local_bot_table_csv,
            list_quarantined_browser_downloads,
            release_quarantined_browser_download,
            delete_quarantined_browser_download,
            probe_computer_use_readiness,
            request_computer_use_permission,
            list_running_computer_apps,
            list_computer_app_scopes,
            save_computer_app_scope,
            delete_computer_app_scope,
            inspect_computer_app,
            run_computer_action,
            take_over_computer_run,
            list_local_bot_delegations,
            create_local_bot_delegation,
            start_local_bot_delegation_target,
            finish_local_bot_delegation_target,
            recover_local_bot_delegations,
            cancel_local_bot_delegation,
            list_local_bot_memories,
            save_local_bot_memory,
            list_local_bot_memory_proposals,
            create_local_bot_memory_proposal,
            review_local_bot_memory_proposal,
            delete_local_bot_memory,
            clear_local_bot_memories,
            list_local_bot_skills,
            save_local_bot_skill,
            import_local_bot_skill,
            review_imported_bot_skill,
            delete_local_bot_skill,
            update_local_bot_status,
            update_local_bot_approval_mode,
            update_local_bot_browser_domains,
            update_local_bot_engine_policy,
            update_local_bot_profile,
            update_local_bot_goal,
            update_local_bot_routines,
            choose_workspace_folder,
            read_local_project_fingerprint,
            choose_local_mcp_executable,
            list_local_mcp_servers,
            inspect_local_mcp_server,
            save_local_mcp_server,
            delete_local_mcp_server,
            discard_prepared_mcp_approval,
            discard_prepared_local_tool_approval,
            open_local_browser,
            resize_local_browser,
            set_local_browser_visibility,
            preview_local_browser_navigation,
            update_local_browser_domains,
            navigate_local_browser,
            browser_history_action,
            arm_local_browser_download,
            start_local_browser_teaching,
            capture_local_browser_teaching,
            finish_local_browser_teaching,
            dry_run_local_browser_teaching,
            close_local_browser,
            probe_background_service,
            set_background_work_enabled,
            open_background_work_settings,
            get_bot_autonomy_policy,
            update_bot_autonomy_policy,
            deliver_due_daily_digest,
            list_recent_routine_activity,
            list_local_schedules,
            list_local_event_routines,
            save_local_event_routine,
            set_local_event_routine_enabled,
            delete_local_event_routine,
            claim_changed_event_routines,
            mark_event_routine_occurrence_running,
            renew_event_routine_occurrence_lease,
            finish_event_routine_occurrence,
            event_routine_execution_permitted,
            save_local_schedule,
            set_local_schedule_enabled,
            delete_local_schedule,
            claim_due_local_schedules,
            mark_schedule_occurrence_running,
            renew_schedule_occurrence_lease,
            finish_schedule_occurrence,
            schedule_execution_permitted,
            list_schedule_occurrences,
            show_local_notification,
            take_opened_local_notification,
            consume_local_notification,
            get_local_pilot_report,
            record_local_unexpected_action,
            export_local_pilot_report,
            export_local_workspace,
            import_local_workspace,
            delete_local_workspace,
            probe_desktop_cloud,
            start_desktop_cloud_pairing,
            finish_desktop_cloud_pairing,
            disconnect_desktop_cloud,
            publish_desktop_hosted_promotion,
            sync_desktop_cloud,
            list_desktop_cloud_links,
            open_desktop_cloud_href,
            probe_desktop_update,
            check_desktop_update,
            install_desktop_update,
            append_thread_message,
            save_artifact_version,
            begin_local_run,
            save_run_checkpoint,
            record_run_approval,
            record_local_check,
            store_artifact_file,
            probe_providers,
            discover_local_models,
            open_local_model_page,
            probe_provider_api_keys,
            save_provider_api_key,
            delete_provider_api_key,
            open_codex_sign_in,
            open_copilot_sign_in,
            open_provider_setup,
            run_provider_task,
            run_provider_task_stream,
            cancel_provider_task,
            manage_local_model,
            prepare_local_tool_approval,
            run_local_tool_batch,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Codelit");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Reopen { .. })
            && let Some(window) = app_handle.get_webview_window("main")
        {
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
}

#[cfg(feature = "direct-release")]
#[tauri::command]
async fn probe_desktop_update() -> DesktopUpdateState {
    updater::probe()
}

#[cfg(feature = "app-store-release")]
#[tauri::command]
async fn probe_desktop_update() -> DesktopUpdateState {
    DesktopUpdateState::managed_by_app_store()
}

#[cfg(not(any(feature = "direct-release", feature = "app-store-release")))]
#[tauri::command]
async fn probe_desktop_update() -> DesktopUpdateState {
    DesktopUpdateState::development()
}

#[cfg(feature = "direct-release")]
#[tauri::command]
async fn check_desktop_update(
    app: AppHandle,
    updates: State<'_, UpdateRegistry>,
) -> Result<DesktopUpdateState, String> {
    updater::check(&app, &updates).await
}

#[cfg(not(feature = "direct-release"))]
#[tauri::command]
async fn check_desktop_update(app: AppHandle) -> Result<DesktopUpdateState, String> {
    let _ = app;
    Ok(probe_desktop_update().await)
}

#[cfg(feature = "direct-release")]
#[tauri::command]
async fn install_desktop_update(
    app: AppHandle,
    updates: State<'_, UpdateRegistry>,
) -> Result<(), String> {
    updater::install(&app, &updates).await
}

#[cfg(not(feature = "direct-release"))]
#[tauri::command]
async fn install_desktop_update(app: AppHandle) -> Result<(), String> {
    let _ = app;
    if cfg!(feature = "app-store-release") {
        Err("The Mac App Store installs Codelit updates automatically.".into())
    } else {
        Err("Signed updates are available in Codelit's Direct release build.".into())
    }
}

pub fn background_service_probe_json() -> Result<String, String> {
    serde_json::to_string(&macos::probe_background_service()).map_err(|error| error.to_string())
}

pub fn resource_policy_probe_json() -> Result<String, String> {
    system_resources::resource_policy_probe_json()
}

#[cfg(not(feature = "app-store-release"))]
pub fn computer_use_readiness_json() -> Result<String, String> {
    serde_json::to_string(&computer_use::probe_readiness()).map_err(|error| error.to_string())
}
