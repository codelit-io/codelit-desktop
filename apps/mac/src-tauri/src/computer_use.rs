use crate::macos;
use crate::run_control::{RunEventEmitter, RunRegistry};
use crate::storage::AppState;
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::thread;
use std::time::Duration;

const MAX_SCOPES_PER_BOT: i64 = 24;
const CODELIT_BUNDLE_ID: &str = "io.codelit.desktop";
const MAX_ACTION_CONTINUITY_GAP: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseReadiness {
    pub available: bool,
    pub accessibility: &'static str,
    pub screen_recording: &'static str,
    pub ready: bool,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<ComputerEnvironmentSnapshot>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerEnvironmentSnapshot {
    pub status: String,
    pub session: String,
    pub accessibility: bool,
    pub screen_recording: bool,
    pub active_display_count: usize,
    pub awake_display_count: usize,
    pub topology_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActionEnvironment {
    pub before: ComputerEnvironmentSnapshot,
    pub after: ComputerEnvironmentSnapshot,
    pub continuity: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerPermissionRequest {
    permission: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningComputerApp {
    pub bundle_id: String,
    pub name: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSemanticElement {
    pub role: String,
    pub label: String,
    pub enabled: bool,
    pub actions: Vec<String>,
    pub sensitive: bool,
    pub occurrence: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAppInspection {
    pub bundle_id: String,
    pub app_name: String,
    pub elements: Vec<ComputerSemanticElement>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ComputerSemanticAction {
    Press {
        target: String,
        role: Option<String>,
        occurrence: Option<usize>,
    },
    SetValue {
        target: String,
        role: Option<String>,
        occurrence: Option<usize>,
        value: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectComputerAppRequest {
    pub bot_id: String,
    pub bundle_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunComputerActionRequest {
    pub run_id: String,
    pub bot_id: String,
    pub bundle_id: String,
    pub action: ComputerSemanticAction,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActionResult {
    pub run_id: String,
    pub status: String,
    pub summary: String,
    pub before: ComputerAppInspection,
    pub after: ComputerAppInspection,
    pub evidence: Vec<ComputerEvidenceFrame>,
    pub environment: ComputerActionEnvironment,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerEvidenceFrame {
    pub phase: String,
    pub mime_type: String,
    pub data_url: String,
    pub sha256: String,
    pub window_id: u32,
    pub width: usize,
    pub height: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAppScope {
    pub bot_id: String,
    pub bundle_id: String,
    pub app_name: String,
    pub access: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveComputerAppScopeRequest {
    pub bot_id: String,
    pub bundle_id: String,
    pub access: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteComputerAppScopeRequest {
    pub bot_id: String,
    pub bundle_id: String,
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS computer_app_scopes (
                id TEXT PRIMARY KEY,
                bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                bundle_id_hash TEXT NOT NULL,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(bot_id, bundle_id_hash)
             );
             CREATE INDEX IF NOT EXISTS idx_computer_app_scopes_bot
                ON computer_app_scopes(bot_id, updated_at DESC);",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (17, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn probe_readiness() -> ComputerUseReadiness {
    if !available_in_build() {
        return ComputerUseReadiness {
            available: false,
            accessibility: "unavailable",
            screen_recording: "unavailable",
            ready: false,
            detail: "Computer use is available in Codelit's notarized Direct build.".into(),
            environment: None,
        };
    }
    let environment = computer_environment_snapshot();
    let accessibility = environment.accessibility;
    let screen_recording = environment.screen_recording;
    let ready = environment.status == "ready";
    let detail = environment_detail(&environment);
    ComputerUseReadiness {
        available: true,
        accessibility: if accessibility { "granted" } else { "required" },
        screen_recording: if screen_recording {
            "granted"
        } else {
            "required"
        },
        ready,
        detail,
        environment: Some(environment),
    }
}

pub fn request_permission(
    request: ComputerPermissionRequest,
) -> Result<ComputerUseReadiness, String> {
    ensure_available()?;
    match request.permission.as_str() {
        "accessibility" => macos::open_accessibility_settings()?,
        "screen-recording" => {
            macos::request_screen_capture_permission();
        }
        _ => return Err("Choose Accessibility or Screen Recording permission.".into()),
    }
    Ok(probe_readiness())
}

pub fn list_running_apps() -> Result<Vec<RunningComputerApp>, String> {
    ensure_available()?;
    let mut seen = HashSet::new();
    let mut apps = macos::list_running_applications()
        .into_iter()
        .filter(|app| app_is_allowed(&app.bundle_id, &app.name))
        .filter(|app| seen.insert(app.bundle_id.to_lowercase()))
        .map(|app| RunningComputerApp {
            bundle_id: app.bundle_id,
            name: app.name,
            active: app.active,
        })
        .collect::<Vec<_>>();
    apps.sort_by(|left, right| {
        right
            .active
            .cmp(&left.active)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.bundle_id.cmp(&right.bundle_id))
    });
    Ok(apps)
}

pub fn list_app_scopes(state: &AppState, bot_id: &str) -> Result<Vec<ComputerAppScope>, String> {
    ensure_available()?;
    validate_identifier(bot_id, "bot")?;
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT id, body_json, created_at, updated_at
             FROM computer_app_scopes
             WHERE bot_id = ?1
             ORDER BY updated_at DESC, id ASC",
        )
        .map_err(error_text)?;
    statement
        .query_map(params![bot_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(error_text)?
        .map(|row| {
            let (id, body, created_at, updated_at) = row.map_err(error_text)?;
            open_scope(state, bot_id, &id, &body, &created_at, &updated_at)
        })
        .collect()
}

pub fn save_app_scope(
    state: &AppState,
    request: SaveComputerAppScopeRequest,
) -> Result<ComputerAppScope, String> {
    ensure_available()?;
    let app = list_running_apps()?
        .into_iter()
        .find(|app| app.bundle_id == request.bundle_id)
        .ok_or_else(|| "Open the app first, then approve it for this bot.".to_string())?;
    save_scope_record(
        state,
        &request.bot_id,
        &app.bundle_id,
        &app.name,
        &request.access,
    )
}

pub fn delete_app_scope(
    state: &AppState,
    request: DeleteComputerAppScopeRequest,
) -> Result<bool, String> {
    ensure_available()?;
    validate_identifier(&request.bot_id, "bot")?;
    validate_bundle_id(&request.bundle_id)?;
    let deleted = state
        .connection()?
        .execute(
            "DELETE FROM computer_app_scopes WHERE bot_id = ?1 AND bundle_id_hash = ?2",
            params![request.bot_id, bundle_id_hash(&request.bundle_id)],
        )
        .map_err(error_text)?;
    Ok(deleted > 0)
}

pub fn inspect_app(
    state: &AppState,
    request: InspectComputerAppRequest,
) -> Result<ComputerAppInspection, String> {
    ensure_computer_ready()?;
    let scope = approved_scope(state, &request.bot_id, &request.bundle_id)?;
    let application = running_application(&scope.bundle_id)?;
    crate::computer_accessibility::inspect(
        application.process_id,
        &application.bundle_id,
        &application.name,
    )
}

pub fn run_action(
    state: &AppState,
    runs: &RunRegistry,
    request: RunComputerActionRequest,
    channel: Option<tauri::ipc::Channel<crate::run_control::ProviderRunEvent>>,
) -> Result<ComputerActionResult, String> {
    let initial_environment = ensure_computer_ready()?;
    validate_identifier(&request.run_id, "run")?;
    let scope = approved_scope(state, &request.bot_id, &request.bundle_id)?;
    if scope.access != "interact" {
        return Err("This bot has observation-only access to that app.".into());
    }
    validate_action(&request.action)?;
    let application = running_application(&scope.bundle_id)?;
    let emitter = RunEventEmitter::new(
        request.run_id.clone(),
        "computer",
        application.name.clone(),
        channel,
    );
    let active = runs.begin(&request.run_id)?;
    let cancellation = active.token();
    emitter.emit("started", format!("Inspecting {}", application.name), None);
    let before = crate::computer_accessibility::inspect(
        application.process_id,
        &application.bundle_id,
        &application.name,
    )?;
    let before_evidence =
        crate::computer_accessibility::capture_window(application.process_id, "before")?;
    if cancellation.is_canceled() {
        emitter.emit(
            "canceled",
            "Computer action stopped before it changed the app.",
            None,
        );
        return Ok(ComputerActionResult {
            run_id: request.run_id,
            status: "canceled".into(),
            summary: "Stopped before changing the app.".into(),
            after: before.clone(),
            before,
            evidence: vec![before_evidence],
            environment: ComputerActionEnvironment {
                before: initial_environment.clone(),
                after: initial_environment,
                continuity: "canceled-before-action".into(),
            },
        });
    }
    let pre_dispatch_environment = computer_environment_snapshot();
    let pre_dispatch_issue = if pre_dispatch_environment.status != "ready" {
        Some(environment_detail(&pre_dispatch_environment))
    } else if initial_environment.topology_sha256 != pre_dispatch_environment.topology_sha256 {
        Some("The active display configuration changed before the approved action.".into())
    } else {
        None
    };
    if let Some(issue) = pre_dispatch_issue {
        let summary = format!("Stopped before changing {}. {issue}", scope.app_name);
        emitter.emit("failed", summary.clone(), None);
        return Ok(ComputerActionResult {
            run_id: request.run_id,
            status: "blocked-before-action".into(),
            summary,
            after: before.clone(),
            before,
            evidence: vec![before_evidence],
            environment: ComputerActionEnvironment {
                before: initial_environment,
                after: pre_dispatch_environment,
                continuity: "blocked-before-action".into(),
            },
        });
    }
    approved_scope(state, &request.bot_id, &request.bundle_id)?;
    let current_application = running_application(&scope.bundle_id)?;
    if current_application.process_id != application.process_id {
        return Err("The approved app restarted before the action. Ask again so its new process is explicit.".into());
    }
    macos::activate_application(&scope.bundle_id)?;
    let summary = action_summary(&request.action, &scope.app_name);
    emitter.emit("progress", summary.clone(), None);
    let action_started_at = macos::continuous_time_nanos()?;
    crate::computer_accessibility::perform(application.process_id, &request.action)?;
    for _ in 0..8 {
        if cancellation.is_canceled() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let after_environment = computer_environment_snapshot();
    let action_elapsed = macos::continuous_time_nanos()?
        .checked_sub(action_started_at)
        .map(Duration::from_nanos)
        .ok_or_else(|| {
            "The macOS continuous clock moved backwards during the action.".to_string()
        })?;
    let mut post_action_issue = continuity_issue(
        &pre_dispatch_environment,
        &after_environment,
        action_elapsed,
    );
    if post_action_issue.is_none()
        && let Err(error) = approved_scope(state, &request.bot_id, &request.bundle_id)
    {
        post_action_issue = Some(error);
    }
    if post_action_issue.is_none() {
        match running_application(&scope.bundle_id) {
            Ok(current) if current.process_id == application.process_id => {}
            Ok(_) => {
                post_action_issue = Some("The approved app restarted during the action.".into());
            }
            Err(error) => post_action_issue = Some(error),
        }
    }
    if let Some(issue) = post_action_issue {
        let summary = format!(
            "The approved action may have run in {}, but Codelit lost continuity. {issue} Inspect the app before retrying; Codelit will not retry automatically.",
            scope.app_name,
        );
        emitter.emit("failed", summary.clone(), None);
        return Ok(ComputerActionResult {
            run_id: request.run_id,
            status: "continuity-lost".into(),
            summary,
            after: before.clone(),
            before,
            evidence: vec![before_evidence],
            environment: ComputerActionEnvironment {
                before: pre_dispatch_environment,
                after: after_environment,
                continuity: "interrupted-after-dispatch".into(),
            },
        });
    }
    let after = crate::computer_accessibility::inspect(
        application.process_id,
        &application.bundle_id,
        &application.name,
    );
    let after_evidence =
        crate::computer_accessibility::capture_window(application.process_id, "after");
    let canceled = cancellation.is_canceled();
    let status = if canceled { "canceled" } else { "completed" };
    let (status, summary, after, evidence) = match (after, after_evidence) {
        (Ok(after), Ok(after_evidence)) => {
            let summary = if canceled {
                format!("Stopped after the approved action in {}.", scope.app_name)
            } else {
                summary
            };
            (
                status,
                summary,
                after,
                vec![before_evidence, after_evidence],
            )
        }
        (after, evidence) => {
            let inspection_detail = after
                .as_ref()
                .err()
                .map(|error| format!(" Inspection failed: {error}."))
                .unwrap_or_default();
            let capture_detail = evidence
                .as_ref()
                .err()
                .map(|error| format!(" Screenshot failed: {error}."))
                .unwrap_or_default();
            (
                "evidence-failed",
                format!(
                    "The approved action ran in {}, but Codelit could not verify the after state. Verify the app before retrying.{}{}",
                    scope.app_name, inspection_detail, capture_detail
                ),
                after.unwrap_or_else(|_| before.clone()),
                vec![before_evidence],
            )
        }
    };
    emitter.emit(status, summary.clone(), None);
    Ok(ComputerActionResult {
        run_id: request.run_id,
        status: status.into(),
        summary,
        before,
        after,
        evidence,
        environment: ComputerActionEnvironment {
            before: pre_dispatch_environment,
            after: after_environment,
            continuity: "continuous".into(),
        },
    })
}

pub fn take_over(
    state: &AppState,
    runs: &RunRegistry,
    request: InspectComputerAppRequest,
    run_id: &str,
) -> Result<bool, String> {
    ensure_available()?;
    validate_identifier(run_id, "run")?;
    // Cancellation must remain available if the app closes or its scope is revoked mid-run.
    let canceled = runs.cancel(run_id);
    let scope = approved_scope(state, &request.bot_id, &request.bundle_id)?;
    running_application(&scope.bundle_id)?;
    macos::activate_application(&scope.bundle_id)?;
    Ok(canceled)
}

fn approved_scope(
    state: &AppState,
    bot_id: &str,
    bundle_id: &str,
) -> Result<ComputerAppScope, String> {
    validate_identifier(bot_id, "bot")?;
    validate_bundle_id(bundle_id)?;
    list_app_scopes(state, bot_id)?
        .into_iter()
        .find(|scope| scope.bundle_id == bundle_id)
        .ok_or_else(|| "Approve this app for the bot before starting computer use.".to_string())
}

fn running_application(bundle_id: &str) -> Result<macos::RunningApplicationInfo, String> {
    macos::list_running_applications()
        .into_iter()
        .find(|application| {
            application.bundle_id == bundle_id
                && application.process_id > 0
                && app_is_allowed(&application.bundle_id, &application.name)
        })
        .ok_or_else(|| "Open the approved app before the bot uses it.".to_string())
}

fn ensure_computer_ready() -> Result<ComputerEnvironmentSnapshot, String> {
    let environment = computer_environment_snapshot();
    if environment.status == "ready" {
        Ok(environment)
    } else {
        Err(environment_detail(&environment))
    }
}

fn computer_environment_snapshot() -> ComputerEnvironmentSnapshot {
    let accessibility = macos::accessibility_permission_granted();
    let screen_recording = macos::screen_capture_permission_granted();
    computer_environment_snapshot_from(
        accessibility,
        screen_recording,
        macos::computer_environment(),
    )
}

fn computer_environment_snapshot_from(
    accessibility: bool,
    screen_recording: bool,
    environment: Result<macos::ComputerEnvironmentInfo, String>,
) -> ComputerEnvironmentSnapshot {
    let (session, displays) = match environment {
        Ok(environment) => {
            let session = if !environment.session_on_console {
                "unavailable"
            } else if environment.screen_locked {
                "locked"
            } else {
                "unlocked"
            };
            (session, environment.displays)
        }
        Err(_) => ("unavailable", Vec::new()),
    };
    let active_display_count = displays.len();
    let awake_display_count = displays
        .iter()
        .filter(|display| display.awake && display.online)
        .count();
    let mut topology = displays
        .iter()
        .map(|display| {
            format!(
                "{:016x}:{:016x}:{:016x}:{:016x}:{}:{}",
                display.x_bits,
                display.y_bits,
                display.width_bits,
                display.height_bits,
                u8::from(display.awake),
                u8::from(display.online),
            )
        })
        .collect::<Vec<_>>();
    topology.sort();
    let topology_sha256 = hex_hash(topology.join("|").as_bytes());
    let status = if !accessibility {
        "accessibility-required"
    } else if !screen_recording {
        "screen-recording-required"
    } else if session == "locked" {
        "locked"
    } else if session != "unlocked" {
        "session-unavailable"
    } else if active_display_count == 0 {
        "no-active-display"
    } else if awake_display_count != active_display_count {
        "display-asleep"
    } else {
        "ready"
    };
    ComputerEnvironmentSnapshot {
        status: status.into(),
        session: session.into(),
        accessibility,
        screen_recording,
        active_display_count,
        awake_display_count,
        topology_sha256,
    }
}

fn environment_detail(environment: &ComputerEnvironmentSnapshot) -> String {
    match environment.status.as_str() {
        "ready" => format!(
            "Ready on {} active {}. Each bot can use only the apps you approve.",
            environment.active_display_count,
            if environment.active_display_count == 1 {
                "display"
            } else {
                "displays"
            },
        ),
        "accessibility-required" => {
            "Allow Accessibility so Codelit can target visible controls by name.".into()
        }
        "screen-recording-required" => {
            "Allow Screen Recording so every action can include visible before-and-after evidence."
                .into()
        }
        "locked" => "Unlock this Mac before a bot uses an app.".into(),
        "display-asleep" => "Wake every active display before a bot uses an app.".into(),
        "no-active-display" => "Connect and wake a display before a bot uses an app.".into(),
        _ => {
            "Computer use is paused because the active macOS desktop session is unavailable.".into()
        }
    }
}

fn continuity_issue(
    before: &ComputerEnvironmentSnapshot,
    after: &ComputerEnvironmentSnapshot,
    elapsed: Duration,
) -> Option<String> {
    if after.status != "ready" {
        return Some(environment_detail(after));
    }
    if before.topology_sha256 != after.topology_sha256 {
        return Some("The active display configuration changed during the approved action.".into());
    }
    if elapsed > MAX_ACTION_CONTINUITY_GAP {
        return Some("The Mac slept or paused during the approved action.".into());
    }
    None
}

fn validate_action(action: &ComputerSemanticAction) -> Result<(), String> {
    let (target, role, occurrence) = match action {
        ComputerSemanticAction::Press {
            target,
            role,
            occurrence,
        }
        | ComputerSemanticAction::SetValue {
            target,
            role,
            occurrence,
            ..
        } => (target, role, occurrence),
    };
    if target.trim().is_empty()
        || target.chars().count() > 160
        || target.chars().any(char::is_control)
        || role.as_ref().is_some_and(|value| {
            value.is_empty()
                || value.len() > 80
                || !value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        || occurrence.is_some_and(|value| value > 99)
    {
        return Err("The requested computer control is invalid.".into());
    }
    if let ComputerSemanticAction::SetValue { value, .. } = action
        && (value.is_empty()
            || value.len() > 2_000
            || value
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\t')))
    {
        return Err("Text entered into an app must be 2,000 characters or fewer.".into());
    }
    Ok(())
}

fn action_summary(action: &ComputerSemanticAction, app_name: &str) -> String {
    match action {
        ComputerSemanticAction::Press { target, .. } => {
            format!("Pressed {target} in {app_name}.")
        }
        ComputerSemanticAction::SetValue { target, .. } => {
            format!("Entered approved text in {target} in {app_name}.")
        }
    }
}

fn save_scope_record(
    state: &AppState,
    bot_id: &str,
    bundle_id: &str,
    app_name: &str,
    access: &str,
) -> Result<ComputerAppScope, String> {
    validate_identifier(bot_id, "bot")?;
    validate_bundle_id(bundle_id)?;
    validate_app_name(app_name)?;
    if !app_is_allowed(bundle_id, app_name) {
        return Err("Codelit cannot grant computer access to that app.".into());
    }
    if !matches!(access, "observe" | "interact") {
        return Err("Choose observe or interact access for this app.".into());
    }
    let connection = state.connection()?;
    let bot_exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bots WHERE id = ?1)",
            params![bot_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(error_text)?;
    if !bot_exists {
        return Err("That bot is no longer available on this Mac.".into());
    }
    let bundle_hash = bundle_id_hash(bundle_id);
    let existing = connection
        .query_row(
            "SELECT id, created_at FROM computer_app_scopes
             WHERE bot_id = ?1 AND bundle_id_hash = ?2",
            params![bot_id, bundle_hash],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(error_text)?;
    if existing.is_none() {
        let count = connection
            .query_row(
                "SELECT COUNT(*) FROM computer_app_scopes WHERE bot_id = ?1",
                params![bot_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(error_text)?;
        if count >= MAX_SCOPES_PER_BOT {
            return Err(format!(
                "This bot already has the maximum of {MAX_SCOPES_PER_BOT} approved apps."
            ));
        }
    }
    let now = canonical_now();
    let id = existing
        .as_ref()
        .map(|value| value.0.clone())
        .unwrap_or_else(|| {
            format!(
                "computer-app-scope-{}",
                &scope_id_hash(bot_id, bundle_id)[..24]
            )
        });
    let created_at = existing.map(|value| value.1).unwrap_or_else(|| now.clone());
    let body = json!({
        "bundleId": bundle_id,
        "appName": app_name,
        "access": access,
    });
    let sealed = state
        .cipher()
        .seal(&scope_context(bot_id, &id), &body.to_string())?;
    connection
        .execute(
            "INSERT INTO computer_app_scopes
                (id, bot_id, bundle_id_hash, body_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(bot_id, bundle_id_hash) DO UPDATE SET
                body_json = excluded.body_json,
                updated_at = excluded.updated_at",
            params![id, bot_id, bundle_hash, sealed, created_at, now],
        )
        .map_err(error_text)?;
    Ok(ComputerAppScope {
        bot_id: bot_id.into(),
        bundle_id: bundle_id.into(),
        app_name: app_name.into(),
        access: access.into(),
        created_at,
        updated_at: now,
    })
}

fn open_scope(
    state: &AppState,
    bot_id: &str,
    id: &str,
    body: &str,
    created_at: &str,
    updated_at: &str,
) -> Result<ComputerAppScope, String> {
    let plaintext = state.cipher().open(&scope_context(bot_id, id), body)?;
    let value = serde_json::from_str::<serde_json::Value>(&plaintext).map_err(error_text)?;
    let bundle_id = value["bundleId"]
        .as_str()
        .ok_or_else(|| "An approved app record is invalid.".to_string())?;
    let app_name = value["appName"]
        .as_str()
        .ok_or_else(|| "An approved app record is invalid.".to_string())?;
    let access = value["access"]
        .as_str()
        .ok_or_else(|| "An approved app record is invalid.".to_string())?;
    validate_bundle_id(bundle_id)?;
    validate_app_name(app_name)?;
    if !matches!(access, "observe" | "interact") {
        return Err("An approved app record has an unsupported access level.".into());
    }
    Ok(ComputerAppScope {
        bot_id: bot_id.into(),
        bundle_id: bundle_id.into(),
        app_name: app_name.into(),
        access: access.into(),
        created_at: created_at.into(),
        updated_at: updated_at.into(),
    })
}

fn app_is_allowed(bundle_id: &str, name: &str) -> bool {
    let bundle = bundle_id.to_lowercase();
    let name = name.to_lowercase();
    if bundle == CODELIT_BUNDLE_ID
        || bundle == "com.apple.keychainaccess"
        || bundle == "com.apple.passwords"
        || bundle == "com.apple.systempreferences"
        || bundle == "com.apple.systemsettings"
        || bundle.contains("1password")
        || bundle.contains("bitwarden")
        || bundle.contains("dashlane")
        || bundle.contains("lastpass")
        || bundle.contains("keepersecurity")
        || bundle.contains("nordpass")
        || bundle.contains("proton.pass")
        || bundle.contains("authenticator")
        || name.contains("keychain access")
        || name == "passwords"
        || name.contains("1password")
        || name.contains("bitwarden")
        || name.contains("dashlane")
        || name.contains("lastpass")
        || name.contains("keeper password")
        || name.contains("nordpass")
        || name.contains("proton pass")
        || name.contains("authenticator")
    {
        return false;
    }
    validate_bundle_id(bundle_id).is_ok() && validate_app_name(name.as_str()).is_ok()
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("The {label} identifier is invalid."));
    }
    Ok(())
}

fn validate_bundle_id(value: &str) -> Result<(), String> {
    if value.len() < 3
        || value.len() > 255
        || !value.contains('.')
        || value.split('.').any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err("The app bundle identifier is invalid.".into());
    }
    Ok(())
}

fn validate_app_name(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 120 || trimmed.chars().any(char::is_control) {
        return Err("The app name is invalid.".into());
    }
    Ok(())
}

fn bundle_id_hash(bundle_id: &str) -> String {
    hex_hash(bundle_id.to_lowercase().as_bytes())
}

fn scope_id_hash(bot_id: &str, bundle_id: &str) -> String {
    hex_hash(format!("{bot_id}:{}", bundle_id.to_lowercase()).as_bytes())
}

fn hex_hash(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn scope_context(bot_id: &str, id: &str) -> String {
    format!("computer-app-scopes:{bot_id}:{id}")
}

fn canonical_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn available_in_build() -> bool {
    !cfg!(feature = "app-store-release")
}

fn ensure_available() -> Result<(), String> {
    if available_in_build() {
        Ok(())
    } else {
        Err("Computer use is available in Codelit's notarized Direct build.".into())
    }
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(feature = "app-store-release"))]
    use crate::storage;
    #[cfg(not(feature = "app-store-release"))]
    use tempfile::tempdir;

    #[cfg(not(feature = "app-store-release"))]
    fn state_and_bot() -> (tempfile::TempDir, AppState, String) {
        let directory = tempdir().unwrap();
        let state = AppState::for_test(directory.path()).unwrap();
        let bot_id = storage::bootstrap_local_bots(&state).unwrap().active_bot.id;
        (directory, state, bot_id)
    }

    #[cfg(not(feature = "app-store-release"))]
    #[test]
    fn app_scopes_are_encrypted_and_isolated_per_bot() {
        let (_directory, state, bot_id) = state_and_bot();
        let saved =
            save_scope_record(&state, &bot_id, "com.apple.Safari", "Safari", "interact").unwrap();
        assert_eq!(saved.app_name, "Safari");
        assert_eq!(list_app_scopes(&state, &bot_id).unwrap(), vec![saved]);

        let connection = state.connection().unwrap();
        let body: String = connection
            .query_row("SELECT body_json FROM computer_app_scopes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(body.starts_with("enc:v1:"));
        assert!(!body.contains("Safari"));
    }

    #[cfg(not(feature = "app-store-release"))]
    #[test]
    fn app_scope_updates_preserve_creation_and_delete_with_bot() {
        let (_directory, state, bot_id) = state_and_bot();
        let first =
            save_scope_record(&state, &bot_id, "com.apple.Safari", "Safari", "observe").unwrap();
        let updated =
            save_scope_record(&state, &bot_id, "com.apple.Safari", "Safari", "interact").unwrap();
        assert_eq!(updated.created_at, first.created_at);
        assert_eq!(updated.access, "interact");
        assert_eq!(list_app_scopes(&state, &bot_id).unwrap().len(), 1);

        state
            .connection()
            .unwrap()
            .execute("DELETE FROM bots WHERE id = ?1", params![bot_id])
            .unwrap();
        let remaining: i64 = state
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM computer_app_scopes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[cfg(not(feature = "app-store-release"))]
    #[test]
    fn sensitive_apps_and_implicit_access_are_rejected() {
        let (_directory, state, bot_id) = state_and_bot();
        assert!(
            save_scope_record(
                &state,
                &bot_id,
                "com.agilebits.onepassword7",
                "1Password",
                "interact",
            )
            .is_err()
        );
        assert!(
            save_scope_record(&state, &bot_id, "com.apple.Safari", "Safari", "always",).is_err()
        );
        assert!(
            save_scope_record(
                &state,
                &bot_id,
                "com.lastpass.LastPass",
                "LastPass",
                "interact",
            )
            .is_err()
        );
    }

    #[test]
    fn semantic_actions_are_bounded_before_accessibility_dispatch() {
        assert!(
            validate_action(&ComputerSemanticAction::Press {
                target: "New Tab".into(),
                role: Some("AXButton".into()),
                occurrence: Some(0),
            })
            .is_ok()
        );
        assert!(
            validate_action(&ComputerSemanticAction::SetValue {
                target: "Message".into(),
                role: Some("AXTextArea".into()),
                occurrence: Some(0),
                value: String::new(),
            })
            .is_err()
        );
        assert!(
            validate_action(&ComputerSemanticAction::Press {
                target: "New Tab".into(),
                role: Some("AX Button".into()),
                occurrence: Some(0),
            })
            .is_err()
        );
        assert!(
            validate_action(&ComputerSemanticAction::Press {
                target: "New Tab".into(),
                role: Some("AXButton".into()),
                occurrence: Some(100),
            })
            .is_err()
        );
        assert!(
            validate_action(&ComputerSemanticAction::Press {
                target: "\u{6d88}".repeat(160),
                role: Some("AXButton".into()),
                occurrence: Some(0),
            })
            .is_ok()
        );
        assert!(
            validate_action(&ComputerSemanticAction::Press {
                target: "\u{6d88}".repeat(161),
                role: Some("AXButton".into()),
                occurrence: Some(0),
            })
            .is_err()
        );
    }

    fn environment(status: &str, topology: &str) -> ComputerEnvironmentSnapshot {
        ComputerEnvironmentSnapshot {
            status: status.into(),
            session: if status == "locked" {
                "locked"
            } else {
                "unlocked"
            }
            .into(),
            accessibility: status != "accessibility-required",
            screen_recording: status != "screen-recording-required",
            active_display_count: 2,
            awake_display_count: if status == "display-asleep" { 1 } else { 2 },
            topology_sha256: topology.into(),
        }
    }

    #[test]
    fn lifecycle_continuity_accepts_stable_multi_display_actions() {
        let before = environment("ready", "stable-topology");
        let after = environment("ready", "stable-topology");
        assert_eq!(
            continuity_issue(&before, &after, Duration::from_millis(450)),
            None,
        );
    }

    #[test]
    fn lifecycle_continuity_fails_closed_after_lock_permission_or_display_changes() {
        let before = environment("ready", "stable-topology");
        for status in [
            "locked",
            "accessibility-required",
            "screen-recording-required",
            "display-asleep",
            "session-unavailable",
        ] {
            let issue = continuity_issue(
                &before,
                &environment(status, "stable-topology"),
                Duration::from_millis(450),
            )
            .expect("lifecycle interruption");
            assert!(!issue.is_empty(), "{status}");
        }
        assert!(
            continuity_issue(
                &before,
                &environment("ready", "changed-topology"),
                Duration::from_millis(450),
            )
            .unwrap()
            .contains("display configuration changed"),
        );
    }

    #[test]
    fn lifecycle_continuity_treats_a_long_monotonic_gap_as_sleep_or_pause() {
        let before = environment("ready", "stable-topology");
        let issue = continuity_issue(
            &before,
            &environment("ready", "stable-topology"),
            MAX_ACTION_CONTINUITY_GAP + Duration::from_millis(1),
        )
        .unwrap();
        assert!(issue.contains("slept or paused"));
    }

    fn display(x: f64, awake: bool) -> macos::ComputerDisplayInfo {
        macos::ComputerDisplayInfo {
            x_bits: x.to_bits(),
            y_bits: 0_f64.to_bits(),
            width_bits: 1_440_f64.to_bits(),
            height_bits: 900_f64.to_bits(),
            awake,
            online: true,
        }
    }

    #[test]
    fn environment_probe_classifies_lock_permissions_and_multi_display_readiness() {
        let ready = computer_environment_snapshot_from(
            true,
            true,
            Ok(macos::ComputerEnvironmentInfo {
                session_on_console: true,
                screen_locked: false,
                displays: vec![display(1_440.0, true), display(0.0, true)],
            }),
        );
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.active_display_count, 2);
        assert_eq!(ready.awake_display_count, 2);

        let reversed = computer_environment_snapshot_from(
            true,
            true,
            Ok(macos::ComputerEnvironmentInfo {
                session_on_console: true,
                screen_locked: false,
                displays: vec![display(0.0, true), display(1_440.0, true)],
            }),
        );
        assert_eq!(ready.topology_sha256, reversed.topology_sha256);

        let locked = computer_environment_snapshot_from(
            true,
            true,
            Ok(macos::ComputerEnvironmentInfo {
                session_on_console: true,
                screen_locked: true,
                displays: vec![display(0.0, true)],
            }),
        );
        assert_eq!(locked.status, "locked");

        let sleeping_display = computer_environment_snapshot_from(
            true,
            true,
            Ok(macos::ComputerEnvironmentInfo {
                session_on_console: true,
                screen_locked: false,
                displays: vec![display(0.0, true), display(1_440.0, false)],
            }),
        );
        assert_eq!(sleeping_display.status, "display-asleep");
        assert_eq!(sleeping_display.awake_display_count, 1);

        let revoked = computer_environment_snapshot_from(
            false,
            true,
            Err("window server unavailable".into()),
        );
        assert_eq!(revoked.status, "accessibility-required");
    }

    #[cfg(all(target_os = "macos", not(feature = "app-store-release")))]
    #[test]
    #[ignore = "requires an active, unlocked macOS desktop session"]
    fn live_quartz_environment_probe_reports_the_visible_desktop() {
        let environment = macos::computer_environment().expect("Quartz environment");
        assert!(environment.session_on_console);
        assert!(!environment.screen_locked);
        assert!(!environment.displays.is_empty());
        assert!(
            environment
                .displays
                .iter()
                .all(|display| display.online && display.awake),
        );
    }

    #[cfg(not(feature = "app-store-release"))]
    #[test]
    fn take_over_cancels_before_revalidating_revoked_scope() {
        let (_directory, state, bot_id) = state_and_bot();
        let runs = RunRegistry::default();
        let active = runs.begin("run-take-over").unwrap();
        let token = active.token();

        let result = take_over(
            &state,
            &runs,
            InspectComputerAppRequest {
                bot_id,
                bundle_id: "com.apple.Safari".into(),
            },
            "run-take-over",
        );

        assert!(result.is_err());
        assert!(token.is_canceled());
    }

    #[cfg(feature = "app-store-release")]
    #[test]
    fn app_store_build_keeps_computer_use_unavailable() {
        let readiness = probe_readiness();
        assert!(!readiness.available);
        assert!(!readiness.ready);
        assert_eq!(readiness.accessibility, "unavailable");
        assert_eq!(readiness.screen_recording, "unavailable");
        assert!(list_running_apps().is_err());
        assert!(
            request_permission(ComputerPermissionRequest {
                permission: "accessibility".into(),
            })
            .is_err()
        );
    }
}
