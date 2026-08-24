use crate::storage::AppState;
use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const POLICY_ID: i64 = 1;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotAutonomyPolicy {
    pub globally_paused: bool,
    pub quiet_hours_enabled: bool,
    pub quiet_start: String,
    pub quiet_end: String,
    pub daily_digest_enabled: bool,
    pub daily_digest_time: String,
    pub timezone: String,
    pub status: String,
    pub status_detail: String,
    pub resumes_at: Option<String>,
    pub can_start_work: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateBotAutonomyPolicyRequest {
    pub globally_paused: bool,
    pub quiet_hours_enabled: bool,
    pub quiet_start: String,
    pub quiet_end: String,
    pub daily_digest_enabled: bool,
    pub daily_digest_time: String,
    pub timezone: String,
}

#[derive(Debug, Clone)]
struct StoredPolicy {
    globally_paused: bool,
    quiet_hours_enabled: bool,
    quiet_start: String,
    quiet_end: String,
    daily_digest_enabled: bool,
    daily_digest_time: String,
    last_digest_local_date: Option<String>,
    timezone: String,
    updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DueDailyDigest {
    local_date: NaiveDate,
    completed: u32,
    needs_attention: u32,
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS bot_autonomy_policy (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                globally_paused INTEGER NOT NULL DEFAULT 0 CHECK (globally_paused IN (0, 1)),
                quiet_hours_enabled INTEGER NOT NULL DEFAULT 0 CHECK (quiet_hours_enabled IN (0, 1)),
                quiet_start TEXT NOT NULL DEFAULT '22:00',
                quiet_end TEXT NOT NULL DEFAULT '07:00',
                daily_digest_enabled INTEGER NOT NULL DEFAULT 0 CHECK (daily_digest_enabled IN (0, 1)),
                daily_digest_time TEXT NOT NULL DEFAULT '17:00',
                last_digest_local_date TEXT,
                timezone TEXT NOT NULL DEFAULT 'UTC',
                updated_at TEXT NOT NULL
             );",
        )
        .map_err(error_text)?;
    add_column_if_missing(
        connection,
        "bot_autonomy_policy",
        "daily_digest_enabled",
        "INTEGER NOT NULL DEFAULT 0 CHECK (daily_digest_enabled IN (0, 1))",
    )?;
    add_column_if_missing(
        connection,
        "bot_autonomy_policy",
        "daily_digest_time",
        "TEXT NOT NULL DEFAULT '17:00'",
    )?;
    add_column_if_missing(
        connection,
        "bot_autonomy_policy",
        "last_digest_local_date",
        "TEXT",
    )?;
    connection
        .execute(
            "INSERT OR IGNORE INTO bot_autonomy_policy (
                id, globally_paused, quiet_hours_enabled, quiet_start, quiet_end,
                daily_digest_enabled, daily_digest_time, timezone, updated_at
             ) VALUES (1, 0, 0, '22:00', '07:00', 0, '17:00', 'UTC', ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn read_policy(state: &AppState, timezone: Option<&str>) -> Result<BotAutonomyPolicy, String> {
    let connection = state.connection()?;
    if let Some(timezone) = timezone {
        validate_timezone(timezone)?;
        connection
            .execute(
                "UPDATE bot_autonomy_policy SET timezone = ?2, updated_at = CASE
                    WHEN timezone = ?2 THEN updated_at ELSE ?3 END
                 WHERE id = ?1",
                params![POLICY_ID, timezone, canonical_now()],
            )
            .map_err(error_text)?;
    }
    policy_at(load_stored(&connection)?, Utc::now())
}

pub fn update_policy(
    state: &AppState,
    request: UpdateBotAutonomyPolicyRequest,
) -> Result<BotAutonomyPolicy, String> {
    validate_request(&request)?;
    let connection = state.connection()?;
    let previous = load_stored(&connection)?;
    let timezone = validate_timezone(&request.timezone)?;
    let last_digest_local_date = if request.daily_digest_enabled
        && !previous.daily_digest_enabled
        && previous.last_digest_local_date.is_none()
    {
        Utc::now()
            .with_timezone(&timezone)
            .date_naive()
            .pred_opt()
            .map(|date| date.to_string())
    } else {
        previous.last_digest_local_date.clone()
    };
    let updated_at = canonical_now();
    connection
        .execute(
            "UPDATE bot_autonomy_policy
             SET globally_paused = ?2, quiet_hours_enabled = ?3,
                 quiet_start = ?4, quiet_end = ?5,
                 daily_digest_enabled = ?6, daily_digest_time = ?7,
                 last_digest_local_date = ?8, timezone = ?9, updated_at = ?10
             WHERE id = ?1",
            params![
                POLICY_ID,
                request.globally_paused,
                request.quiet_hours_enabled,
                request.quiet_start,
                request.quiet_end,
                request.daily_digest_enabled,
                request.daily_digest_time,
                last_digest_local_date,
                request.timezone,
                updated_at,
            ],
        )
        .map_err(error_text)?;
    if !previous.globally_paused && request.globally_paused {
        crate::scheduler::pause_all_schedule_claims(state, "Paused by you.")?;
        crate::event_routines::defer_all_event_claims(state, "Paused by you.")?;
    }
    read_policy(state, None)
}

#[cfg(feature = "direct-release")]
pub fn set_global_pause(state: &AppState, paused: bool) -> Result<BotAutonomyPolicy, String> {
    let current = load_stored(&state.connection()?)?;
    update_policy(
        state,
        UpdateBotAutonomyPolicyRequest {
            globally_paused: paused,
            quiet_hours_enabled: current.quiet_hours_enabled,
            quiet_start: current.quiet_start,
            quiet_end: current.quiet_end,
            daily_digest_enabled: current.daily_digest_enabled,
            daily_digest_time: current.daily_digest_time,
            timezone: current.timezone,
        },
    )
}

pub fn new_work_allowed(state: &AppState) -> Result<bool, String> {
    Ok(read_policy(state, None)?.can_start_work)
}

pub fn continuation_allowed(state: &AppState) -> Result<bool, String> {
    Ok(!load_stored(&state.connection()?)?.globally_paused)
}

pub fn notification_delivery_allowed(state: &AppState) -> Result<bool, String> {
    let policy = load_stored(&state.connection()?)?;
    Ok(!quiet_resume_at(&policy, Utc::now())?.is_some())
}

pub fn deliver_due_daily_digest(
    app: &AppHandle,
    state: &AppState,
) -> Result<Option<crate::local_notifications::LocalNotificationRoute>, String> {
    let Some(digest) = claim_due_daily_digest_at(state, Utc::now())? else {
        return Ok(None);
    };
    if digest.completed == 0 && digest.needs_attention == 0 {
        return Ok(None);
    }
    let date = digest.local_date.format("%Y-%m-%d").to_string();
    let body = digest_body(&digest);
    crate::local_notifications::show_local_notification(
        app,
        state,
        crate::local_notifications::ShowLocalNotificationRequest {
            thread_id: "local-workspace".into(),
            artifact_id: "all-activity".into(),
            artifact_kind: "activity".into(),
            run_id: format!("daily-digest-{date}"),
            title: "Your Codelit day".into(),
            body,
        },
    )
    .map(Some)
}

fn claim_due_daily_digest_at(
    state: &AppState,
    now: DateTime<Utc>,
) -> Result<Option<DueDailyDigest>, String> {
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let policy = load_stored(&transaction)?;
    if !policy.daily_digest_enabled
        || policy.globally_paused
        || quiet_resume_at(&policy, now)?.is_some()
    {
        transaction.commit().map_err(error_text)?;
        return Ok(None);
    }
    let timezone = validate_timezone(&policy.timezone)?;
    let digest_time = parse_local_time_with_label(&policy.daily_digest_time, "Daily digest time")?;
    let local_now = now.with_timezone(&timezone);
    let candidate_date = if local_now.time() >= digest_time {
        local_now.date_naive()
    } else {
        local_now
            .date_naive()
            .pred_opt()
            .ok_or_else(|| "Daily digest date is outside the supported range.".to_string())?
    };
    let candidate_date_text = candidate_date.to_string();
    if policy
        .last_digest_local_date
        .as_deref()
        .is_some_and(|date| date >= candidate_date_text.as_str())
    {
        transaction.commit().map_err(error_text)?;
        return Ok(None);
    }
    let start = resolve_local_time(timezone, candidate_date, NaiveTime::MIN)?;
    let next_date = candidate_date
        .succ_opt()
        .ok_or_else(|| "Daily digest date is outside the supported range.".to_string())?;
    let end = resolve_local_time(timezone, next_date, NaiveTime::MIN)?;
    let start_text = canonical_time(start);
    let end_text = canonical_time(end);
    let (completed, needs_attention): (u32, u32) = transaction
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM schedule_occurrences
                  WHERE status = 'completed'
                    AND COALESCE(completed_at, updated_at) >= ?1
                    AND COALESCE(completed_at, updated_at) < ?2)
                +
                (SELECT COUNT(*) FROM event_routine_occurrences
                  WHERE status = 'completed'
                    AND COALESCE(completed_at, updated_at) >= ?1
                    AND COALESCE(completed_at, updated_at) < ?2),
                (SELECT COUNT(*) FROM schedule_occurrences
                  WHERE (status = 'failed' OR (status = 'paused' AND next_attempt_at IS NULL))
                    AND updated_at >= ?1 AND updated_at < ?2)
                +
                (SELECT COUNT(*) FROM event_routine_occurrences
                  WHERE (status = 'failed' OR (status = 'paused' AND next_attempt_at IS NULL))
                    AND updated_at >= ?1 AND updated_at < ?2)",
            params![start_text, end_text],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "UPDATE bot_autonomy_policy SET last_digest_local_date = ?2 WHERE id = ?1",
            params![POLICY_ID, candidate_date_text],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    Ok(Some(DueDailyDigest {
        local_date: candidate_date,
        completed,
        needs_attention,
    }))
}

fn digest_body(digest: &DueDailyDigest) -> String {
    let mut parts = Vec::new();
    if digest.completed > 0 {
        parts.push(if digest.completed == 1 {
            "1 routine completed".into()
        } else {
            format!("{} routines completed", digest.completed)
        });
    }
    if digest.needs_attention > 0 {
        parts.push(if digest.needs_attention == 1 {
            "1 routine needs attention".into()
        } else {
            format!("{} routines need attention", digest.needs_attention)
        });
    }
    format!(
        "{}. Open All activity for exact receipts.",
        parts.join(" · ")
    )
}

fn load_stored(connection: &Connection) -> Result<StoredPolicy, String> {
    connection
        .query_row(
            "SELECT globally_paused, quiet_hours_enabled, quiet_start, quiet_end,
                    daily_digest_enabled, daily_digest_time, last_digest_local_date,
                    timezone, updated_at
             FROM bot_autonomy_policy WHERE id = ?1",
            params![POLICY_ID],
            |row| {
                Ok(StoredPolicy {
                    globally_paused: row.get(0)?,
                    quiet_hours_enabled: row.get(1)?,
                    quiet_start: row.get(2)?,
                    quiet_end: row.get(3)?,
                    daily_digest_enabled: row.get(4)?,
                    daily_digest_time: row.get(5)?,
                    last_digest_local_date: row.get(6)?,
                    timezone: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .map_err(error_text)
}

fn policy_at(policy: StoredPolicy, now: DateTime<Utc>) -> Result<BotAutonomyPolicy, String> {
    let quiet_resume = quiet_resume_at(&policy, now)?;
    let (status, status_detail, resumes_at) = if policy.globally_paused {
        ("paused", "All routines are paused".to_string(), None)
    } else if let Some(resume) = quiet_resume {
        (
            "quiet-hours",
            format!("Quiet until {}", policy.quiet_end),
            Some(canonical_time(resume)),
        )
    } else {
        ("active", "Routines are active".to_string(), None)
    };
    Ok(BotAutonomyPolicy {
        globally_paused: policy.globally_paused,
        quiet_hours_enabled: policy.quiet_hours_enabled,
        quiet_start: policy.quiet_start,
        quiet_end: policy.quiet_end,
        daily_digest_enabled: policy.daily_digest_enabled,
        daily_digest_time: policy.daily_digest_time,
        timezone: policy.timezone,
        status: status.into(),
        status_detail,
        resumes_at,
        can_start_work: !policy.globally_paused && quiet_resume.is_none(),
        updated_at: policy.updated_at,
    })
}

fn quiet_resume_at(
    policy: &StoredPolicy,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, String> {
    if !policy.quiet_hours_enabled {
        return Ok(None);
    }
    let timezone = validate_timezone(&policy.timezone)?;
    let start = parse_local_time(&policy.quiet_start)?;
    let end = parse_local_time(&policy.quiet_end)?;
    if start == end {
        return Ok(None);
    }
    let local_now = now.with_timezone(&timezone);
    let current = local_now.time();
    let date = local_now.date_naive();
    let resume_date = if start < end {
        if current < start || current >= end {
            return Ok(None);
        }
        date
    } else if current >= start {
        date.succ_opt()
            .ok_or_else(|| "Quiet-hours date is outside the supported range.".to_string())?
    } else if current < end {
        date
    } else {
        return Ok(None);
    };
    Ok(Some(resolve_local_time(timezone, resume_date, end)?))
}

fn resolve_local_time(
    timezone: Tz,
    date: NaiveDate,
    time: NaiveTime,
) -> Result<DateTime<Utc>, String> {
    let mut local = NaiveDateTime::new(date, time);
    for _ in 0..=180 {
        match timezone.from_local_datetime(&local) {
            LocalResult::Single(value) => return Ok(value.with_timezone(&Utc)),
            LocalResult::Ambiguous(first, second) => {
                return Ok(first.min(second).with_timezone(&Utc));
            }
            LocalResult::None => local += Duration::minutes(1),
        }
    }
    Err("Quiet-hours end could not be resolved in the selected timezone.".into())
}

fn validate_request(request: &UpdateBotAutonomyPolicyRequest) -> Result<(), String> {
    let start = parse_local_time(&request.quiet_start)?;
    let end = parse_local_time(&request.quiet_end)?;
    if request.quiet_hours_enabled && start == end {
        return Err("Choose different start and end times for quiet hours.".into());
    }
    parse_local_time_with_label(&request.daily_digest_time, "Daily digest time")?;
    validate_timezone(&request.timezone)?;
    Ok(())
}

fn parse_local_time(value: &str) -> Result<NaiveTime, String> {
    parse_local_time_with_label(value, "Quiet-hours time")
}

fn parse_local_time_with_label(value: &str, label: &str) -> Result<NaiveTime, String> {
    if value.len() != 5 {
        return Err(format!("{label} must use HH:MM."));
    }
    NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| format!("Choose a valid {label}."))
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    if column_exists(connection, table, column)? {
        return Ok(());
    }
    connection
        .execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )
        .map_err(error_text)?;
    Ok(())
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(error_text)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(error_text)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error_text)?;
    Ok(names.iter().any(|name| name == column))
}

fn validate_timezone(value: &str) -> Result<Tz, String> {
    value
        .parse::<Tz>()
        .map_err(|_| "The current device timezone is not supported.".into())
}

fn canonical_now() -> String {
    canonical_time(Utc::now())
}

fn canonical_time(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(feature = "direct-release")]
const AUTONOMY_TRAY_ID: &str = "codelit-autonomy";

#[cfg(feature = "direct-release")]
const AUTONOMY_TRAY_ICON_RGBA: &[u8] = include_bytes!("../icons/tray-template.rgba");

#[cfg(feature = "direct-release")]
fn autonomy_tray_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::new(AUTONOMY_TRAY_ICON_RGBA, 44, 44)
}

#[cfg(feature = "direct-release")]
pub fn install_menu_bar(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use tauri::tray::TrayIconBuilder;

    let policy = read_policy(&app.state::<AppState>(), None)?;
    let menu = autonomy_menu(app, &policy).map_err(error_text)?;
    TrayIconBuilder::with_id(AUTONOMY_TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip(menu_tooltip(&policy))
        .on_menu_event(handle_menu_event)
        .icon(autonomy_tray_icon())
        .icon_as_template(true)
        .build(app)
        .map_err(error_text)?;
    Ok(())
}

#[cfg(feature = "direct-release")]
pub fn refresh_menu_bar(app: &tauri::AppHandle, policy: &BotAutonomyPolicy) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(AUTONOMY_TRAY_ID) else {
        return Ok(());
    };
    tray.set_menu(Some(autonomy_menu(app, policy).map_err(error_text)?))
        .map_err(error_text)?;
    tray.set_tooltip(Some(menu_tooltip(policy)))
        .map_err(error_text)
}

#[cfg(feature = "direct-release")]
fn autonomy_menu(
    app: &tauri::AppHandle,
    policy: &BotAutonomyPolicy,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};

    let status = MenuItem::with_id(
        app,
        "autonomy-status",
        format!("Status: {}", menu_status(policy)),
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "autonomy-open", "Open Codelit", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(
        app,
        "autonomy-pause",
        "Pause all routines",
        true,
        policy.globally_paused,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        "autonomy-settings",
        "Autonomy settings...",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "autonomy-quit", "Quit Codelit", true, None::<&str>)?;
    Menu::with_items(app, &[&status, &open, &pause, &settings, &separator, &quit])
}

#[cfg(feature = "direct-release")]
fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    use tauri::{Emitter, Manager};

    let result = match event.id().as_ref() {
        "autonomy-open" => show_main_window(app),
        "autonomy-settings" => show_main_window(app)
            .and_then(|_| app.emit("open-bot-settings", "general").map_err(error_text)),
        "autonomy-pause" => {
            let state = app.state::<AppState>();
            read_policy(&state, None)
                .and_then(|policy| set_global_pause(&state, !policy.globally_paused))
                .and_then(|policy| {
                    refresh_menu_bar(app, &policy)?;
                    app.emit("bot-autonomy-policy-changed", &policy)
                        .map_err(error_text)
                })
        }
        "autonomy-quit" => {
            app.exit(0);
            Ok(())
        }
        _ => Ok(()),
    };
    if let Err(error) = result {
        eprintln!("Codelit menu-bar action failed: {error}");
    }
}

#[cfg(feature = "direct-release")]
fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The Codelit window is unavailable.".to_string())?;
    window.show().map_err(error_text)?;
    window.unminimize().map_err(error_text)?;
    window.set_focus().map_err(error_text)
}

#[cfg(feature = "direct-release")]
fn menu_status(policy: &BotAutonomyPolicy) -> String {
    match policy.status.as_str() {
        "paused" => "Paused".into(),
        "quiet-hours" => format!("Quiet until {}", policy.quiet_end),
        _ => "Active".into(),
    }
}

#[cfg(feature = "direct-release")]
fn menu_tooltip(policy: &BotAutonomyPolicy) -> String {
    format!("Codelit - {}", menu_status(policy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::tempdir;

    fn stored(start: &str, end: &str, timezone: &str) -> StoredPolicy {
        StoredPolicy {
            globally_paused: false,
            quiet_hours_enabled: true,
            quiet_start: start.into(),
            quiet_end: end.into(),
            daily_digest_enabled: false,
            daily_digest_time: "17:00".into(),
            last_digest_local_date: None,
            timezone: timezone.into(),
            updated_at: "2026-08-19T00:00:00.000Z".into(),
        }
    }

    #[cfg(feature = "direct-release")]
    #[test]
    fn menu_bar_icon_is_a_transparent_template_instead_of_a_solid_tile() {
        let icon = autonomy_tray_icon();
        assert_eq!((icon.width(), icon.height()), (44, 44));
        assert_eq!(icon.rgba().len(), 44 * 44 * 4);

        let alphas = icon
            .rgba()
            .as_chunks::<4>()
            .0
            .iter()
            .map(|pixel| pixel[3])
            .collect::<Vec<_>>();
        let visible = alphas.iter().filter(|alpha| **alpha > 0).count();
        assert!(
            alphas.contains(&0),
            "the menu-bar canvas must stay transparent"
        );
        assert!(
            alphas.contains(&255),
            "the Codelit glyph must remain visible"
        );
        assert!(
            visible < alphas.len() / 2,
            "the glyph must not become a square mask"
        );
    }

    #[test]
    fn overnight_quiet_hours_resume_on_the_next_local_morning() {
        let now = Utc.with_ymd_and_hms(2026, 8, 20, 5, 30, 0).unwrap();
        let policy = policy_at(stored("22:00", "07:00", "America/Denver"), now).expect("policy");
        assert_eq!(policy.status, "quiet-hours");
        assert_eq!(
            policy.resumes_at.as_deref(),
            Some("2026-08-20T13:00:00.000Z")
        );
        assert!(!policy.can_start_work);
    }

    #[test]
    fn daytime_window_is_active_outside_the_bounded_interval() {
        let now = Utc.with_ymd_and_hms(2026, 8, 19, 19, 0, 0).unwrap();
        let policy = policy_at(stored("09:00", "12:00", "America/Denver"), now).expect("policy");
        assert_eq!(policy.status, "active");
        assert!(policy.can_start_work);
    }

    #[test]
    fn policy_persists_and_rejects_an_ambiguous_full_day_window() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let error = update_policy(
            &state,
            UpdateBotAutonomyPolicyRequest {
                globally_paused: false,
                quiet_hours_enabled: true,
                quiet_start: "08:00".into(),
                quiet_end: "08:00".into(),
                daily_digest_enabled: false,
                daily_digest_time: "17:00".into(),
                timezone: "America/Denver".into(),
            },
        )
        .expect_err("same time must fail");
        assert!(error.contains("different start and end"));

        let saved = update_policy(
            &state,
            UpdateBotAutonomyPolicyRequest {
                globally_paused: false,
                quiet_hours_enabled: true,
                quiet_start: "21:30".into(),
                quiet_end: "06:45".into(),
                daily_digest_enabled: true,
                daily_digest_time: "18:15".into(),
                timezone: "America/Denver".into(),
            },
        )
        .expect("save policy");
        assert_eq!(saved.quiet_start, "21:30");
        assert!(saved.daily_digest_enabled);
        assert_eq!(saved.daily_digest_time, "18:15");
        assert_eq!(
            read_policy(&state, None).expect("reload").quiet_end,
            "06:45"
        );
    }

    fn configure_digest(state: &AppState, time: &str, last_date: Option<&str>, quiet_hours: bool) {
        state
            .connection()
            .expect("connection")
            .execute(
                "UPDATE bot_autonomy_policy
                 SET globally_paused = 0, quiet_hours_enabled = ?1,
                     quiet_start = '22:00', quiet_end = '07:00',
                     daily_digest_enabled = 1, daily_digest_time = ?2,
                     last_digest_local_date = ?3, timezone = 'America/Denver'
                 WHERE id = 1",
                params![quiet_hours, time, last_date],
            )
            .expect("digest policy");
    }

    fn insert_digest_occurrences(state: &AppState) {
        state
            .connection()
            .expect("connection")
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 INSERT INTO schedule_occurrences (
                    idempotency_key, schedule_id, schedule_revision, scheduled_for,
                    status, attempt, run_id, created_at, updated_at, completed_at
                 ) VALUES (
                    'digest-schedule-complete', 'digest-schedule', 1,
                    '2026-08-19T18:00:00.000Z', 'completed', 1, 'digest-run-1',
                    '2026-08-19T18:00:00.000Z', '2026-08-19T18:10:00.000Z',
                    '2026-08-19T18:10:00.000Z'
                 );
                 INSERT INTO event_routine_occurrences (
                    idempotency_key, routine_id, routine_version, observed_at,
                    previous_fingerprint, fingerprint, status, attempt, run_id,
                    pause_reason, created_at, updated_at
                 ) VALUES (
                    'digest-event-attention', 'digest-event', 1,
                    '2026-08-19T19:00:00.000Z', 'before', 'after', 'paused', 1,
                    'digest-run-2', 'Approval required',
                    '2026-08-19T19:00:00.000Z', '2026-08-19T19:10:00.000Z'
                 );
                 PRAGMA foreign_keys = ON;",
            )
            .expect("digest occurrences");
    }

    #[test]
    fn daily_digest_is_off_by_default() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let now = Utc.with_ymd_and_hms(2026, 8, 20, 0, 0, 0).unwrap();
        assert_eq!(
            claim_due_daily_digest_at(&state, now).expect("digest"),
            None
        );
    }

    #[test]
    fn migration_adds_digest_columns_without_changing_an_existing_policy() {
        let connection = Connection::open_in_memory().expect("connection");
        connection
            .execute_batch(
                "CREATE TABLE bot_autonomy_policy (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    globally_paused INTEGER NOT NULL DEFAULT 0,
                    quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
                    quiet_start TEXT NOT NULL DEFAULT '22:00',
                    quiet_end TEXT NOT NULL DEFAULT '07:00',
                    timezone TEXT NOT NULL DEFAULT 'UTC',
                    updated_at TEXT NOT NULL
                 );
                 INSERT INTO bot_autonomy_policy (
                    id, globally_paused, quiet_hours_enabled, quiet_start, quiet_end,
                    timezone, updated_at
                 ) VALUES (
                    1, 1, 1, '21:30', '06:30', 'America/Denver',
                    '2026-08-19T00:00:00.000Z'
                 );",
            )
            .expect("legacy policy");
        migrate(&connection).expect("migration");
        let policy = load_stored(&connection).expect("policy");
        assert!(policy.globally_paused);
        assert!(policy.quiet_hours_enabled);
        assert_eq!(policy.quiet_start, "21:30");
        assert_eq!(policy.quiet_end, "06:30");
        assert!(!policy.daily_digest_enabled);
        assert_eq!(policy.daily_digest_time, "17:00");
        assert_eq!(policy.last_digest_local_date, None);
    }

    #[test]
    fn daily_digest_counts_local_outcomes_and_claims_once() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        configure_digest(&state, "17:00", Some("2026-08-18"), false);
        insert_digest_occurrences(&state);
        let now = Utc.with_ymd_and_hms(2026, 8, 20, 0, 0, 0).unwrap();
        let digest = claim_due_daily_digest_at(&state, now)
            .expect("digest")
            .expect("due digest");
        assert_eq!(digest.local_date.to_string(), "2026-08-19");
        assert_eq!(digest.completed, 1);
        assert_eq!(digest.needs_attention, 1);
        assert_eq!(
            digest_body(&digest),
            "1 routine completed · 1 routine needs attention. Open All activity for exact receipts."
        );
        assert_eq!(
            claim_due_daily_digest_at(&state, now).expect("second digest"),
            None
        );
    }

    #[test]
    fn daily_digest_waits_until_the_selected_local_time() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        configure_digest(&state, "17:00", Some("2026-08-18"), false);
        let before = Utc.with_ymd_and_hms(2026, 8, 19, 22, 59, 0).unwrap();
        assert_eq!(
            claim_due_daily_digest_at(&state, before).expect("digest"),
            None
        );
    }

    #[test]
    fn missed_digest_runs_once_after_quiet_hours_end() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        configure_digest(&state, "23:00", Some("2026-08-18"), true);
        insert_digest_occurrences(&state);
        let quiet = Utc.with_ymd_and_hms(2026, 8, 20, 5, 30, 0).unwrap();
        assert_eq!(
            claim_due_daily_digest_at(&state, quiet).expect("quiet digest"),
            None
        );
        let resumed = Utc.with_ymd_and_hms(2026, 8, 20, 13, 0, 0).unwrap();
        assert_eq!(
            claim_due_daily_digest_at(&state, resumed)
                .expect("resumed digest")
                .expect("due digest")
                .local_date
                .to_string(),
            "2026-08-19"
        );
        assert_eq!(
            claim_due_daily_digest_at(&state, resumed).expect("once"),
            None
        );
    }

    #[test]
    fn empty_daily_digest_marks_the_day_without_creating_noise() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        configure_digest(&state, "17:00", Some("2026-08-18"), false);
        let now = Utc.with_ymd_and_hms(2026, 8, 20, 0, 0, 0).unwrap();
        let digest = claim_due_daily_digest_at(&state, now)
            .expect("digest")
            .expect("evaluated digest");
        assert_eq!((digest.completed, digest.needs_attention), (0, 0));
        assert_eq!(claim_due_daily_digest_at(&state, now).expect("once"), None);
    }
}
