use crate::storage::AppState;
use chrono::{DateTime, SecondsFormat, Utc};
use getrandom::fill as fill_random;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

const PILOT_REPORT_KIND: &str = "codelit-local-pilot-report";
const PILOT_REPORT_SCHEMA_VERSION: u8 = 2;
const UNEXPECTED_ACTION_CATEGORIES: [&str; 4] = [
    "unexpected-action",
    "unapproved-write",
    "sensitive-data",
    "other",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPilotReport {
    schema_version: u8,
    kind: String,
    report_id: String,
    participant_id: String,
    generated_at: String,
    app: PilotAppIdentity,
    measurement_window: PilotMeasurementWindow,
    privacy: PilotPrivacyBoundary,
    activation: PilotActivationMetrics,
    runs: PilotRunMetrics,
    delegations: PilotDelegationMetrics,
    routines: PilotRoutineMetrics,
    approvals: PilotApprovalMetrics,
    unexpected_actions: PilotUnexpectedActionMetrics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotAppIdentity {
    version: String,
    build_channel: String,
    source_commit: String,
    source_dirty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotMeasurementWindow {
    started_at: String,
    ended_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotPrivacyBoundary {
    local_only: bool,
    automatic_upload: bool,
    excluded: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotActivationMetrics {
    custom_bot_created: bool,
    first_run_attempted: bool,
    first_run_completed: bool,
    first_useful_result_completed: bool,
    seconds_to_first_useful_result: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotRunMetrics {
    started: u64,
    completed: u64,
    failed: u64,
    canceled: u64,
    active_days: u64,
    repeat_task_within_seven_days: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotDelegationMetrics {
    started: u64,
    completed: u64,
    repeated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotRoutineMetrics {
    created: u64,
    enabled: u64,
    occurrences: u64,
    completed_occurrences: u64,
    reused: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotApprovalMetrics {
    requested: u64,
    awaiting: u64,
    resolved: u64,
    approved: u64,
    held_or_denied: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotUnexpectedActionMetrics {
    total: u64,
    categories: Vec<PilotUnexpectedActionCategory>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PilotUnexpectedActionCategory {
    category: String,
    count: u64,
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_pilot_identity (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                participant_id TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS local_unexpected_action_reports (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL CHECK(category IN (
                    'unexpected-action', 'unapproved-write', 'sensitive-data', 'other'
                )),
                created_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_local_unexpected_action_reports_created
                ON local_unexpected_action_reports(created_at DESC);",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (21, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn build_local_pilot_report(state: &AppState) -> Result<LocalPilotReport, String> {
    let connection = state.connection()?;
    let generated_at = canonical_now();
    let participant_id = ensure_participant_id(&connection, &generated_at)?;
    build_report(&connection, participant_id, generated_at)
}

pub fn record_unexpected_action(
    state: &AppState,
    category: &str,
) -> Result<LocalPilotReport, String> {
    if !UNEXPECTED_ACTION_CATEGORIES.contains(&category) {
        return Err("Choose a valid unexpected-action category.".into());
    }
    let connection = state.connection()?;
    let created_at = canonical_now();
    connection
        .execute(
            "INSERT INTO local_unexpected_action_reports (id, category, created_at)
             VALUES (?1, ?2, ?3)",
            params![random_identifier("unexpected")?, category, created_at],
        )
        .map_err(error_text)?;
    let participant_id = ensure_participant_id(&connection, &created_at)?;
    build_report(&connection, participant_id, created_at)
}

fn build_report(
    connection: &Connection,
    participant_id: String,
    generated_at: String,
) -> Result<LocalPilotReport, String> {
    let measurement_start = connection
        .query_row("SELECT MIN(created_at) FROM bots", [], |row| {
            row.get::<_, Option<String>>(0)
        })
        .map_err(error_text)?
        .unwrap_or_else(|| generated_at.clone());
    let custom_bots = query_count(
        connection,
        "SELECT COUNT(*) FROM bots WHERE id <> 'bot-codelit'",
    )?;
    let (runs_started, runs_completed, runs_failed, runs_canceled, active_days): (
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = connection
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN r.status IN ('failed', 'halted', 'interrupted') THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN r.status = 'canceled' THEN 1 ELSE 0 END), 0),
                    COUNT(DISTINCT substr(r.created_at, 1, 10))
             FROM runs r JOIN bots b ON b.thread_id = r.thread_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(error_text)?;
    let first_run_status = connection
        .query_row(
            "SELECT r.status
             FROM runs r JOIN bots b ON b.thread_id = r.thread_id
             ORDER BY r.created_at ASC, r.id ASC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error_text)?;
    let first_completed_at = connection
        .query_row(
            "SELECT MIN(r.updated_at)
             FROM runs r JOIN bots b ON b.thread_id = r.thread_id
             WHERE r.status = 'completed'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(error_text)?;
    let first_two_run_times = query_first_two_times(
        connection,
        "SELECT r.created_at
         FROM runs r JOIN bots b ON b.thread_id = r.thread_id
         ORDER BY r.created_at ASC, r.id ASC LIMIT 2",
    )?;
    let seconds_to_first_useful_result = first_completed_at
        .as_deref()
        .and_then(|completed_at| elapsed_seconds(&measurement_start, completed_at));

    let (delegations_started, delegations_completed): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)
             FROM bot_delegations",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(error_text)?;

    let scheduled_routines = query_count(
        connection,
        "SELECT COUNT(*) FROM local_schedules s
         JOIN bots b ON b.thread_id = s.thread_id
         WHERE s.deleted_at IS NULL",
    )?;
    let enabled_scheduled_routines = query_count(
        connection,
        "SELECT COUNT(*) FROM local_schedules s
         JOIN bots b ON b.thread_id = s.thread_id
         WHERE s.deleted_at IS NULL AND s.enabled = 1",
    )?;
    let event_routines = query_count(
        connection,
        "SELECT COUNT(*) FROM routines WHERE trigger_kind = 'project-change'",
    )?;
    let enabled_event_routines = query_count(
        connection,
        "SELECT COUNT(*) FROM routines
         WHERE trigger_kind = 'project-change' AND enabled = 1",
    )?;
    let schedule_occurrences = query_count(
        connection,
        "SELECT COUNT(*) FROM schedule_occurrences o
         JOIN local_schedules s ON s.id = o.schedule_id
         JOIN bots b ON b.thread_id = s.thread_id",
    )?;
    let completed_schedule_occurrences = query_count(
        connection,
        "SELECT COUNT(*) FROM schedule_occurrences o
         JOIN local_schedules s ON s.id = o.schedule_id
         JOIN bots b ON b.thread_id = s.thread_id
         WHERE o.status = 'completed'",
    )?;
    let event_occurrences = query_count(
        connection,
        "SELECT COUNT(*) FROM event_routine_occurrences o
         JOIN routines r ON r.id = o.routine_id
         WHERE r.trigger_kind = 'project-change'",
    )?;
    let completed_event_occurrences = query_count(
        connection,
        "SELECT COUNT(*) FROM event_routine_occurrences o
         JOIN routines r ON r.id = o.routine_id
         WHERE r.trigger_kind = 'project-change' AND o.status = 'completed'",
    )?;
    let routine_reused = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM (
                    SELECT o.schedule_id AS routine_id
                    FROM schedule_occurrences o
                    JOIN local_schedules s ON s.id = o.schedule_id
                    JOIN bots b ON b.thread_id = s.thread_id
                    WHERE o.status = 'completed'
                    GROUP BY o.schedule_id HAVING COUNT(*) >= 2
                    UNION ALL
                    SELECT o.routine_id
                    FROM event_routine_occurrences o
                    JOIN routines r ON r.id = o.routine_id
                    WHERE r.trigger_kind = 'project-change' AND o.status = 'completed'
                    GROUP BY o.routine_id HAVING COUNT(*) >= 2
                ) reused
             )",
            [],
            |row| row.get::<_, bool>(0),
        )
        .map_err(error_text)?;

    let (approvals_requested, approvals_awaiting, approvals_resolved, approvals_approved, approvals_held): (
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = connection
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN a.status = 'awaiting' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN a.status <> 'awaiting' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN a.status IN ('held', 'edit', 'denied') THEN 1 ELSE 0 END), 0)
             FROM approvals a
             JOIN runs r ON r.id = a.run_id
             JOIN bots b ON b.thread_id = r.thread_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(error_text)?;

    let unexpected_categories = unexpected_action_categories(connection)?;
    let unexpected_total = unexpected_categories.iter().map(|item| item.count).sum();

    Ok(LocalPilotReport {
        schema_version: PILOT_REPORT_SCHEMA_VERSION,
        kind: PILOT_REPORT_KIND.into(),
        report_id: random_identifier("report")?,
        participant_id,
        generated_at: generated_at.clone(),
        app: PilotAppIdentity {
            version: env!("CARGO_PKG_VERSION").into(),
            build_channel: build_channel().into(),
            source_commit: env!("CODELIT_SOURCE_COMMIT").into(),
            source_dirty: env!("CODELIT_SOURCE_DIRTY") == "true",
        },
        measurement_window: PilotMeasurementWindow {
            started_at: measurement_start,
            ended_at: generated_at,
        },
        privacy: PilotPrivacyBoundary {
            local_only: true,
            automatic_upload: false,
            excluded: [
                "prompt text",
                "browser content and URLs",
                "file names and contents",
                "screenshots",
                "memories",
                "credentials",
                "provider responses and model output",
                "local database rows",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        },
        activation: PilotActivationMetrics {
            custom_bot_created: custom_bots > 0,
            first_run_attempted: first_run_status.is_some(),
            first_run_completed: first_run_status.as_deref() == Some("completed"),
            first_useful_result_completed: first_completed_at.is_some(),
            seconds_to_first_useful_result,
        },
        runs: PilotRunMetrics {
            started: checked_count(runs_started)?,
            completed: checked_count(runs_completed)?,
            failed: checked_count(runs_failed)?,
            canceled: checked_count(runs_canceled)?,
            active_days: checked_count(active_days)?,
            repeat_task_within_seven_days: within_seven_days(&first_two_run_times),
        },
        delegations: PilotDelegationMetrics {
            started: checked_count(delegations_started)?,
            completed: checked_count(delegations_completed)?,
            repeated: delegations_started >= 2,
        },
        routines: PilotRoutineMetrics {
            created: scheduled_routines + event_routines,
            enabled: enabled_scheduled_routines + enabled_event_routines,
            occurrences: schedule_occurrences + event_occurrences,
            completed_occurrences: completed_schedule_occurrences + completed_event_occurrences,
            reused: routine_reused,
        },
        approvals: PilotApprovalMetrics {
            requested: checked_count(approvals_requested)?,
            awaiting: checked_count(approvals_awaiting)?,
            resolved: checked_count(approvals_resolved)?,
            approved: checked_count(approvals_approved)?,
            held_or_denied: checked_count(approvals_held)?,
        },
        unexpected_actions: PilotUnexpectedActionMetrics {
            total: unexpected_total,
            categories: unexpected_categories,
        },
    })
}

fn ensure_participant_id(connection: &Connection, created_at: &str) -> Result<String, String> {
    if let Some(id) = connection
        .query_row(
            "SELECT participant_id FROM local_pilot_identity WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error_text)?
    {
        return Ok(id);
    }
    let participant_id = random_identifier("participant")?;
    connection
        .execute(
            "INSERT OR IGNORE INTO local_pilot_identity (id, participant_id, created_at)
             VALUES (1, ?1, ?2)",
            params![participant_id, created_at],
        )
        .map_err(error_text)?;
    connection
        .query_row(
            "SELECT participant_id FROM local_pilot_identity WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(error_text)
}

fn unexpected_action_categories(
    connection: &Connection,
) -> Result<Vec<PilotUnexpectedActionCategory>, String> {
    let mut statement = connection
        .prepare(
            "SELECT category, COUNT(*)
             FROM local_unexpected_action_reports
             GROUP BY category ORDER BY category ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(error_text)?;
    let mut categories = Vec::new();
    for row in rows {
        let (category, count) = row.map_err(error_text)?;
        categories.push(PilotUnexpectedActionCategory {
            category,
            count: checked_count(count)?,
        });
    }
    Ok(categories)
}

fn query_count(connection: &Connection, sql: &str) -> Result<u64, String> {
    checked_count(
        connection
            .query_row(sql, [], |row| row.get::<_, i64>(0))
            .map_err(error_text)?,
    )
}

fn checked_count(value: i64) -> Result<u64, String> {
    value
        .try_into()
        .map_err(|_| "The local product report contains an invalid count.".into())
}

fn query_first_two_times(connection: &Connection, sql: &str) -> Result<Vec<String>, String> {
    connection
        .prepare(sql)
        .map_err(error_text)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(error_text)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error_text)
}

fn elapsed_seconds(start: &str, end: &str) -> Option<u64> {
    let start = DateTime::parse_from_rfc3339(start).ok()?;
    let end = DateTime::parse_from_rfc3339(end).ok()?;
    u64::try_from((end - start).num_seconds()).ok()
}

fn within_seven_days(values: &[String]) -> bool {
    values.len() == 2
        && elapsed_seconds(&values[0], &values[1])
            .is_some_and(|seconds| seconds <= 7 * 24 * 60 * 60)
}

fn random_identifier(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    fill_random(&mut bytes)
        .map_err(|_| "macOS could not create a private report identifier.".to_string())?;
    let suffix = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{prefix}-{suffix}"))
}

fn build_channel() -> &'static str {
    #[cfg(feature = "direct-release")]
    return "direct";
    #[cfg(all(not(feature = "direct-release"), feature = "app-store-release"))]
    return "app-store";
    #[cfg(not(any(feature = "direct-release", feature = "app-store-release")))]
    "development"
}

fn canonical_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tempfile::tempdir;

    #[test]
    fn empty_report_is_local_only_and_contains_no_workspace_content() {
        let directory = tempdir().expect("temp directory");
        let state = AppState::for_test(directory.path()).expect("state");

        let first = build_local_pilot_report(&state).expect("report");
        let second = build_local_pilot_report(&state).expect("second report");
        let value = serde_json::to_value(&first).expect("serialize report");
        let serialized = serde_json::to_string(&value).expect("serialized report");

        assert_eq!(value["kind"], PILOT_REPORT_KIND);
        assert_eq!(value["schemaVersion"], 2);
        assert_eq!(
            value["app"]["sourceCommit"].as_str().map(str::len),
            Some(40)
        );
        assert!(value["app"]["sourceDirty"].is_boolean());
        assert_eq!(value["privacy"]["localOnly"], true);
        assert_eq!(value["privacy"]["automaticUpload"], false);
        assert_eq!(value["runs"]["started"], 0);
        assert_eq!(value["activation"]["firstRunAttempted"], false);
        assert_eq!(first.participant_id, second.participant_id);
        assert_ne!(first.report_id, second.report_id);
        assert!(!serialized.contains("I investigate your local projects"));
        assert!(!serialized.contains("Codelit could not create"));
    }

    #[test]
    fn report_derives_repeat_use_routines_approvals_and_safety_counts() {
        let directory = tempdir().expect("temp directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let connection = state.connection().expect("connection");
        let artifact_id: String = connection
            .query_row("SELECT id FROM artifacts ORDER BY id LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("artifact");
        for (id, status, created_at, updated_at) in [
            (
                "run-pilot-1",
                "completed",
                "2026-08-20T10:00:00.000Z",
                "2026-08-20T10:01:00.000Z",
            ),
            (
                "run-pilot-2",
                "failed",
                "2026-08-21T10:00:00.000Z",
                "2026-08-21T10:01:00.000Z",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO runs (id, thread_id, artifact_id, status, created_at, updated_at)
                     VALUES (?1, 'thread-bot-codelit', ?2, ?3, ?4, ?5)",
                    params![id, artifact_id, status, created_at, updated_at],
                )
                .expect("run");
        }
        connection
            .execute(
                "INSERT INTO approvals
                    (id, run_id, step_index, status, body_json, created_at, updated_at)
                 VALUES ('approval-pilot', 'run-pilot-1', 0, 'approved', 'sealed',
                         '2026-08-20T10:00:30.000Z', '2026-08-20T10:00:45.000Z')",
                [],
            )
            .expect("approval");
        connection
            .execute(
                "INSERT INTO local_schedules
                    (id, thread_id, artifact_id, artifact_version, enabled, cadence, timezone,
                     revision, next_due_at, body_json, created_at, updated_at)
                 VALUES ('schedule-pilot', 'thread-bot-codelit', ?1, '1', 1, 'daily', 'UTC',
                         1, '2026-08-23T10:00:00.000Z', 'sealed',
                         '2026-08-20T10:00:00.000Z', '2026-08-20T10:00:00.000Z')",
                params![artifact_id],
            )
            .expect("schedule");
        for (index, run_id) in ["run-routine-1", "run-routine-2"].into_iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO schedule_occurrences
                        (idempotency_key, schedule_id, schedule_revision, scheduled_for, status,
                         attempt, run_id, created_at, updated_at, completed_at)
                     VALUES (?1, 'schedule-pilot', 1, ?2, 'completed', 1, ?3, ?2, ?2, ?2)",
                    params![
                        format!("occurrence-{index}"),
                        format!("2026-08-2{}T10:00:00.000Z", index + 1),
                        run_id
                    ],
                )
                .expect("occurrence");
        }
        connection
            .execute(
                "INSERT INTO bot_delegations
                    (id, parent_bot_id, parent_thread_id, parent_bot_name, parent_bot_version,
                     status, body_json, created_at, updated_at, completed_at)
                 VALUES ('delegation-pilot-1', 'bot-codelit', 'thread-bot-codelit', 'Codelit', 1,
                         'completed', 'sealed', '2026-08-20T10:00:00.000Z',
                         '2026-08-20T10:02:00.000Z', '2026-08-20T10:02:00.000Z'),
                        ('delegation-pilot-2', 'bot-codelit', 'thread-bot-codelit', 'Codelit', 1,
                         'failed', 'sealed', '2026-08-21T10:00:00.000Z',
                         '2026-08-21T10:02:00.000Z', '2026-08-21T10:02:00.000Z')",
                [],
            )
            .expect("delegations");
        drop(connection);

        record_unexpected_action(&state, "unapproved-write").expect("safety report");
        let report = build_local_pilot_report(&state).expect("report");
        let value: Value = serde_json::to_value(report).expect("serialize report");

        assert_eq!(value["activation"]["firstRunCompleted"], true);
        assert_eq!(value["runs"]["started"], 2);
        assert_eq!(value["runs"]["completed"], 1);
        assert_eq!(value["runs"]["failed"], 1);
        assert_eq!(value["runs"]["activeDays"], 2);
        assert_eq!(value["runs"]["repeatTaskWithinSevenDays"], true);
        assert_eq!(value["routines"]["created"], 1);
        assert_eq!(value["routines"]["completedOccurrences"], 2);
        assert_eq!(value["routines"]["reused"], true);
        assert_eq!(value["approvals"]["requested"], 1);
        assert_eq!(value["approvals"]["approved"], 1);
        assert_eq!(value["delegations"]["started"], 2);
        assert_eq!(value["delegations"]["repeated"], true);
        assert_eq!(value["unexpectedActions"]["total"], 1);
        assert_eq!(
            value["unexpectedActions"]["categories"][0]["category"],
            "unapproved-write"
        );
    }

    #[test]
    fn rejects_unbounded_unexpected_action_details() {
        let directory = tempdir().expect("temp directory");
        let state = AppState::for_test(directory.path()).expect("state");

        let error = record_unexpected_action(&state, "The bot clicked a private URL")
            .expect_err("free-form details must fail");
        assert_eq!(error, "Choose a valid unexpected-action category.");
        let report = serde_json::to_value(build_local_pilot_report(&state).expect("report"))
            .expect("serialize report");
        assert_eq!(report["unexpectedActions"]["total"], 0);
    }
}
