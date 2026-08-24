use crate::storage::AppState;
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use getrandom::fill as fill_random;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_CATCH_UP_OCCURRENCES: usize = 24;
const CLAIM_LEASE_MINUTES: i64 = 10;
const MAX_RETRIES_LIMIT: u8 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSchedule {
    pub id: String,
    pub thread_id: String,
    pub artifact_id: String,
    pub artifact_version: String,
    pub title: String,
    pub enabled: bool,
    pub cadence: String,
    pub local_time: String,
    pub timezone: String,
    pub weekdays: Vec<u8>,
    pub missed_policy: String,
    pub max_retries: u8,
    pub provider: String,
    pub model: String,
    pub requires_network: bool,
    pub revision: i64,
    pub next_due_at: Option<String>,
    pub paused_reason: Option<String>,
    pub snapshot: Value,
    pub one_time_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLocalScheduleRequest {
    pub id: String,
    #[serde(default)]
    pub expected_revision: Option<i64>,
    pub thread_id: String,
    pub artifact_id: String,
    pub artifact_version: String,
    pub title: String,
    pub enabled: bool,
    pub cadence: String,
    pub local_time: String,
    pub timezone: String,
    #[serde(default)]
    pub weekdays: Vec<u8>,
    pub missed_policy: String,
    pub max_retries: u8,
    pub provider: String,
    pub model: String,
    #[serde(default = "default_true")]
    pub requires_network: bool,
    pub snapshot: Value,
    #[serde(default)]
    pub one_time_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLocalScheduleEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedScheduleOccurrence {
    pub idempotency_key: String,
    pub claim_token: String,
    pub scheduled_for: String,
    pub attempt: u8,
    pub run_id: String,
    pub schedule: LocalSchedule,
}

#[derive(Debug, Clone)]
pub struct ScheduleEnvironment {
    pub background_enabled: bool,
    pub online: bool,
    pub on_battery: bool,
    pub low_power_mode: bool,
    pub folder_access: bool,
    pub provider_available: bool,
    pub provider_quota_available: bool,
}

impl Default for ScheduleEnvironment {
    fn default() -> Self {
        Self {
            background_enabled: true,
            online: true,
            on_battery: false,
            low_power_mode: false,
            folder_access: true,
            provider_available: true,
            provider_quota_available: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishScheduleOccurrenceRequest {
    pub idempotency_key: String,
    pub claim_token: String,
    pub outcome: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleOccurrenceStatus {
    pub idempotency_key: String,
    pub schedule_id: String,
    pub status: String,
    pub attempt: u8,
    pub scheduled_for: String,
    pub next_attempt_at: Option<String>,
    pub pause_reason: Option<String>,
    pub run_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleBody {
    title: String,
    local_time: String,
    weekdays: Vec<u8>,
    missed_policy: String,
    max_retries: u8,
    provider: String,
    model: String,
    requires_network: bool,
    snapshot: Value,
    one_time_at: Option<String>,
}

#[derive(Debug, Clone)]
struct ScheduleRow {
    id: String,
    thread_id: String,
    artifact_id: String,
    artifact_version: String,
    enabled: bool,
    cadence: String,
    timezone: String,
    revision: i64,
    next_due_at: Option<String>,
    paused_reason: Option<String>,
    body_json: String,
    created_at: String,
    updated_at: String,
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_schedules (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                artifact_id TEXT NOT NULL REFERENCES artifacts(id),
                artifact_version TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                cadence TEXT NOT NULL CHECK(cadence IN ('once', 'daily', 'weekdays', 'weekly')),
                timezone TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                next_due_at TEXT,
                paused_reason TEXT,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
             );
             CREATE TABLE IF NOT EXISTS schedule_occurrences (
                idempotency_key TEXT PRIMARY KEY,
                schedule_id TEXT NOT NULL REFERENCES local_schedules(id) ON DELETE CASCADE,
                schedule_revision INTEGER NOT NULL,
                scheduled_for TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN (
                    'waking', 'claimed', 'running', 'retry', 'paused', 'completed',
                    'failed', 'skipped', 'canceled'
                )),
                claim_owner TEXT,
                claim_token TEXT,
                lease_expires_at TEXT,
                attempt INTEGER NOT NULL DEFAULT 0,
                next_attempt_at TEXT,
                run_id TEXT NOT NULL,
                pause_reason TEXT,
                detail_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_local_schedules_due
                ON local_schedules(enabled, next_due_at)
                WHERE deleted_at IS NULL;
             CREATE INDEX IF NOT EXISTS idx_schedule_occurrences_resume
                ON schedule_occurrences(status, next_attempt_at, lease_expires_at);
             CREATE INDEX IF NOT EXISTS idx_schedule_occurrences_schedule
                ON schedule_occurrences(schedule_id, scheduled_for);",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (7, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn save_local_schedule(
    state: &AppState,
    request: SaveLocalScheduleRequest,
) -> Result<LocalSchedule, String> {
    save_local_schedule_at(state, request, Utc::now())
}

fn save_local_schedule_at(
    state: &AppState,
    request: SaveLocalScheduleRequest,
    now: DateTime<Utc>,
) -> Result<LocalSchedule, String> {
    validate_schedule_request(&request)?;
    let timezone = parse_timezone(&request.timezone)?;
    let body = ScheduleBody {
        title: request.title.trim().to_string(),
        local_time: request.local_time.clone(),
        weekdays: normalized_weekdays(&request.cadence, &request.weekdays)?,
        missed_policy: request.missed_policy.clone(),
        max_retries: request.max_retries,
        provider: request.provider.trim().to_string(),
        model: request.model.trim().to_string(),
        requires_network: request.requires_network,
        snapshot: request.snapshot,
        one_time_at: request.one_time_at,
    };
    let next_due_at = if request.enabled {
        next_occurrence_after(
            &request.cadence,
            timezone,
            &body,
            now - Duration::milliseconds(1),
        )?
        .map(canonical_time)
    } else {
        None
    };
    if request.enabled && next_due_at.is_none() {
        return Err("Choose a future time before enabling this schedule.".into());
    }
    let now_text = canonical_time(now);
    let body_json = serde_json::to_string(&body).map_err(error_text)?;
    if body_json.len() > 2 * 1024 * 1024 {
        return Err("The pinned schedule snapshot is larger than the 2 MB local limit.".into());
    }
    let encrypted = state
        .cipher()
        .seal(&schedule_context(&request.id), &body_json)?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    ensure_artifact_version(
        &transaction,
        &request.thread_id,
        &request.artifact_id,
        &request.artifact_version,
    )?;
    let existing: Option<(i64, String)> = transaction
        .query_row(
            "SELECT revision, created_at FROM local_schedules WHERE id = ?1",
            params![request.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(error_text)?;
    if let Some(expected_revision) = request.expected_revision
        && existing.as_ref().map(|(revision, _)| *revision) != Some(expected_revision)
    {
        return Err("That routine changed before this update. Review it and try again.".into());
    }
    let revision = existing.as_ref().map_or(1, |(revision, _)| revision + 1);
    let created_at = existing
        .map(|(_, created_at)| created_at)
        .unwrap_or_else(|| now_text.clone());
    transaction
        .execute(
            "INSERT INTO local_schedules (
                id, thread_id, artifact_id, artifact_version, enabled, cadence,
                timezone, revision, next_due_at, paused_reason, body_json,
                created_at, updated_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, NULL)
             ON CONFLICT(id) DO UPDATE SET
                thread_id = excluded.thread_id,
                artifact_id = excluded.artifact_id,
                artifact_version = excluded.artifact_version,
                enabled = excluded.enabled,
                cadence = excluded.cadence,
                timezone = excluded.timezone,
                revision = excluded.revision,
                next_due_at = excluded.next_due_at,
                paused_reason = NULL,
                body_json = excluded.body_json,
                updated_at = excluded.updated_at,
                deleted_at = NULL",
            params![
                request.id,
                request.thread_id,
                request.artifact_id,
                request.artifact_version,
                request.enabled,
                request.cadence,
                request.timezone,
                revision,
                next_due_at,
                encrypted,
                created_at,
                now_text,
            ],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "UPDATE schedule_occurrences
             SET status = 'canceled', claim_owner = NULL, claim_token = NULL,
                 lease_expires_at = NULL, completed_at = ?2, updated_at = ?2,
                 detail_json = NULL
             WHERE schedule_id = ?1
               AND status IN ('waking', 'claimed', 'running', 'retry', 'paused')",
            params![request.id, now_text],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_schedule(state, &request.id)?.ok_or_else(|| "The local schedule was not saved.".into())
}

pub fn list_local_schedules(state: &AppState) -> Result<Vec<LocalSchedule>, String> {
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT id, thread_id, artifact_id, artifact_version, enabled, cadence,
                    timezone, revision, next_due_at, paused_reason, body_json,
                    created_at, updated_at
             FROM local_schedules
             WHERE deleted_at IS NULL
             ORDER BY created_at ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map([], schedule_row_from_sql)
        .map_err(error_text)?;
    let mut schedules = Vec::new();
    for row in rows {
        schedules.push(open_schedule(state, row.map_err(error_text)?)?);
    }
    Ok(schedules)
}

pub fn set_local_schedule_enabled(
    state: &AppState,
    request: SetLocalScheduleEnabledRequest,
) -> Result<LocalSchedule, String> {
    validate_identifier(&request.id, "schedule")?;
    let schedule = load_schedule(state, &request.id)?
        .ok_or_else(|| "The local schedule no longer exists.".to_string())?;
    let timezone = parse_timezone(&schedule.timezone)?;
    let body = schedule_body(&schedule);
    let now = Utc::now();
    let now_text = canonical_time(now);
    let next_due_at = if request.enabled {
        next_occurrence_after(
            &schedule.cadence,
            timezone,
            &body,
            now - Duration::milliseconds(1),
        )?
        .map(canonical_time)
    } else {
        None
    };
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let changed = transaction
        .execute(
            "UPDATE local_schedules
             SET enabled = ?2, next_due_at = ?3, paused_reason = NULL, updated_at = ?4
             WHERE id = ?1 AND deleted_at IS NULL",
            params![request.id, request.enabled, next_due_at, now_text],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("The local schedule no longer exists.".into());
    }
    if !request.enabled {
        cancel_open_occurrences(
            &transaction,
            &request.id,
            &now_text,
            "The schedule was disabled.",
        )?;
    }
    transaction.commit().map_err(error_text)?;
    load_schedule(state, &request.id)?.ok_or_else(|| "The local schedule no longer exists.".into())
}

pub fn delete_local_schedule(state: &AppState, id: &str) -> Result<(), String> {
    validate_identifier(id, "schedule")?;
    let now = canonical_now();
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let changed = transaction
        .execute(
            "UPDATE local_schedules
             SET enabled = 0, next_due_at = NULL, paused_reason = NULL,
                 deleted_at = ?2, updated_at = ?2
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("The local schedule no longer exists.".into());
    }
    cancel_open_occurrences(&transaction, id, &now, "The schedule was deleted.")?;
    transaction.commit().map_err(error_text)
}

pub fn pause_all_schedule_claims(state: &AppState, reason: &str) -> Result<(), String> {
    validate_label(reason, 180, "schedule pause reason")?;
    let now = canonical_now();
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    transaction
        .execute(
            "UPDATE schedule_occurrences
             SET status = 'paused', claim_owner = NULL, claim_token = NULL,
                 lease_expires_at = NULL, next_attempt_at = ?1,
                 pause_reason = ?2, detail_json = NULL, updated_at = ?1
             WHERE status IN ('waking', 'claimed', 'running', 'retry', 'paused')",
            params![now, reason],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "UPDATE local_schedules SET paused_reason = ?1, updated_at = ?2
             WHERE enabled = 1 AND deleted_at IS NULL",
            params![reason, now],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)
}

pub fn claim_due_schedules(
    state: &AppState,
    owner: &str,
    environment: &ScheduleEnvironment,
    limit: usize,
) -> Result<Vec<ClaimedScheduleOccurrence>, String> {
    claim_due_schedules_at(state, owner, environment, limit, Utc::now())
}

fn claim_due_schedules_at(
    state: &AppState,
    owner: &str,
    environment: &ScheduleEnvironment,
    limit: usize,
    now: DateTime<Utc>,
) -> Result<Vec<ClaimedScheduleOccurrence>, String> {
    validate_owner(owner)?;
    let limit = limit.clamp(1, MAX_CATCH_UP_OCCURRENCES);
    let now_text = canonical_time(now);
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let rows = load_due_schedule_rows(&transaction, &now_text)?;
    let mut claimed = Vec::new();

    for row in rows {
        if claimed.len() >= limit {
            break;
        }
        let schedule = open_schedule(state, row)?;
        let pause_reason = schedule_pause_reason(&schedule, environment);
        let due_at = schedule
            .next_due_at
            .as_deref()
            .ok_or_else(|| "A due schedule is missing its next occurrence.".to_string())?;
        let due = parse_time(due_at, "next schedule occurrence")?;
        let occurrences = due_occurrences(&schedule, due, now, limit - claimed.len())?;

        if schedule.missed_policy == "skip" && due < now {
            record_skipped_occurrence(&transaction, &schedule, due, &now_text)?;
            advance_schedule_after(&transaction, &schedule, now, &now_text)?;
            continue;
        }

        if let Some(reason) = pause_reason {
            let scheduled_for = occurrences.first().copied().unwrap_or(due);
            record_paused_occurrence(&transaction, &schedule, scheduled_for, &reason, &now_text)?;
            transaction
                .execute(
                    "UPDATE local_schedules SET paused_reason = ?2, updated_at = ?3 WHERE id = ?1",
                    params![schedule.id, reason, now_text],
                )
                .map_err(error_text)?;
            continue;
        }

        transaction
            .execute(
                "UPDATE local_schedules SET paused_reason = NULL, updated_at = ?2 WHERE id = ?1",
                params![schedule.id, now_text],
            )
            .map_err(error_text)?;

        let advance_after = if schedule.missed_policy == "run-every" {
            occurrences.last().copied().unwrap_or(due)
        } else {
            now
        };
        for scheduled_for in occurrences {
            if claimed.len() >= limit {
                break;
            }
            if let Some(value) =
                claim_occurrence(&transaction, &schedule, scheduled_for, owner, now)?
            {
                claimed.push(value);
            }
        }
        advance_schedule_after(&transaction, &schedule, advance_after, &now_text)?;
    }

    claim_retryable_occurrences(
        state,
        &transaction,
        owner,
        environment,
        now,
        limit,
        &mut claimed,
    )?;
    transaction.commit().map_err(error_text)?;
    Ok(claimed)
}

pub fn mark_schedule_occurrence_running(
    state: &AppState,
    idempotency_key: &str,
    claim_token: &str,
) -> Result<ScheduleOccurrenceStatus, String> {
    transition_claimed_occurrence(state, idempotency_key, claim_token, "running")
}

pub fn renew_schedule_occurrence_lease(
    state: &AppState,
    idempotency_key: &str,
    claim_token: &str,
) -> Result<ScheduleOccurrenceStatus, String> {
    validate_identifier(idempotency_key, "schedule occurrence")?;
    validate_claim_token(claim_token)?;
    let now = Utc::now();
    let connection = state.connection()?;
    let changed = connection
        .execute(
            "UPDATE schedule_occurrences
             SET lease_expires_at = ?3, updated_at = ?4
             WHERE idempotency_key = ?1 AND claim_token = ?2
               AND status IN ('claimed', 'running')",
            params![
                idempotency_key,
                claim_token,
                canonical_time(now + Duration::minutes(CLAIM_LEASE_MINUTES)),
                canonical_time(now),
            ],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("This schedule claim is stale or no longer runnable.".into());
    }
    load_occurrence_status(state, idempotency_key)?
        .ok_or_else(|| "The schedule occurrence no longer exists.".into())
}

pub fn finish_schedule_occurrence(
    state: &AppState,
    request: FinishScheduleOccurrenceRequest,
) -> Result<ScheduleOccurrenceStatus, String> {
    if !matches!(
        request.outcome.as_str(),
        "completed" | "failed" | "paused" | "approval-required"
    ) {
        return Err(
            "Schedule outcome must be completed, failed, paused, or approval required.".into(),
        );
    }
    validate_identifier(&request.idempotency_key, "schedule occurrence")?;
    validate_claim_token(&request.claim_token)?;
    if request
        .detail
        .as_deref()
        .is_some_and(|value| value.len() > 500 || value.chars().any(char::is_control))
    {
        return Err("Schedule outcome detail is invalid.".into());
    }
    let now = Utc::now();
    finish_schedule_occurrence_at(state, request, now)
}

fn finish_schedule_occurrence_at(
    state: &AppState,
    request: FinishScheduleOccurrenceRequest,
    now: DateTime<Utc>,
) -> Result<ScheduleOccurrenceStatus, String> {
    let now_text = canonical_time(now);
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let row: Option<(String, i64, i64, String)> = transaction
        .query_row(
            "SELECT o.schedule_id, o.attempt, s.revision, o.status
             FROM schedule_occurrences o
             JOIN local_schedules s ON s.id = o.schedule_id
             WHERE o.idempotency_key = ?1 AND o.claim_token = ?2",
            params![request.idempotency_key, request.claim_token],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(error_text)?;
    let Some((schedule_id, attempt, _revision, current_status)) = row else {
        return Err("This schedule claim is stale or no longer exists.".into());
    };
    if !matches!(current_status.as_str(), "claimed" | "running") {
        return Err("This schedule occurrence is no longer running.".into());
    }
    let schedule = load_schedule_in_transaction(state, &transaction, &schedule_id)?
        .ok_or_else(|| "The local schedule was deleted while it was running.".to_string())?;
    if !schedule.enabled {
        transaction
            .execute(
                "UPDATE schedule_occurrences
                 SET status = 'canceled', claim_owner = NULL, claim_token = NULL,
                     lease_expires_at = NULL, detail_json = NULL,
                     completed_at = ?3, updated_at = ?3
                 WHERE idempotency_key = ?1 AND claim_token = ?2",
                params![request.idempotency_key, request.claim_token, now_text],
            )
            .map_err(error_text)?;
    } else if request.outcome == "completed" {
        transaction
            .execute(
                "UPDATE schedule_occurrences
                 SET status = 'completed', claim_owner = NULL, claim_token = NULL,
                     lease_expires_at = NULL, next_attempt_at = NULL, pause_reason = NULL,
                     detail_json = ?3, completed_at = ?4, updated_at = ?4
                 WHERE idempotency_key = ?1 AND claim_token = ?2",
                params![
                    request.idempotency_key,
                    request.claim_token,
                    encrypted_optional_detail(
                        state,
                        &request.idempotency_key,
                        request.detail.as_deref()
                    )?,
                    now_text
                ],
            )
            .map_err(error_text)?;
    } else if matches!(request.outcome.as_str(), "paused" | "approval-required") {
        let reason = request
            .detail
            .as_deref()
            .unwrap_or("The run needs attention.");
        transaction
            .execute(
                "UPDATE schedule_occurrences
                 SET status = 'paused', claim_owner = NULL, claim_token = NULL,
                     lease_expires_at = NULL, next_attempt_at = ?3, pause_reason = ?4,
                     detail_json = ?5, updated_at = ?6
                 WHERE idempotency_key = ?1 AND claim_token = ?2",
                params![
                    request.idempotency_key,
                    request.claim_token,
                    if request.outcome == "approval-required" {
                        None
                    } else {
                        Some(canonical_time(now + Duration::minutes(5)))
                    },
                    reason,
                    encrypted_optional_detail(state, &request.idempotency_key, Some(reason))?,
                    now_text,
                ],
            )
            .map_err(error_text)?;
    } else if attempt < i64::from(schedule.max_retries) + 1 {
        let delay_minutes = retry_delay_minutes(attempt as u8);
        transaction
            .execute(
                "UPDATE schedule_occurrences
                 SET status = 'retry', claim_owner = NULL, claim_token = NULL,
                     lease_expires_at = NULL, next_attempt_at = ?3, pause_reason = NULL,
                     detail_json = ?4, updated_at = ?5
                 WHERE idempotency_key = ?1 AND claim_token = ?2",
                params![
                    request.idempotency_key,
                    request.claim_token,
                    canonical_time(now + Duration::minutes(delay_minutes)),
                    encrypted_optional_detail(
                        state,
                        &request.idempotency_key,
                        request.detail.as_deref()
                    )?,
                    now_text,
                ],
            )
            .map_err(error_text)?;
    } else {
        transaction
            .execute(
                "UPDATE schedule_occurrences
                 SET status = 'failed', claim_owner = NULL, claim_token = NULL,
                     lease_expires_at = NULL, next_attempt_at = NULL,
                     detail_json = ?3, completed_at = ?4, updated_at = ?4
                 WHERE idempotency_key = ?1 AND claim_token = ?2",
                params![
                    request.idempotency_key,
                    request.claim_token,
                    encrypted_optional_detail(
                        state,
                        &request.idempotency_key,
                        request.detail.as_deref()
                    )?,
                    now_text
                ],
            )
            .map_err(error_text)?;
    }
    let paused_reason = if matches!(request.outcome.as_str(), "paused" | "approval-required") {
        Some(
            request
                .detail
                .as_deref()
                .unwrap_or("The run needs attention."),
        )
    } else {
        None
    };
    transaction
        .execute(
            "UPDATE local_schedules SET paused_reason = ?2, updated_at = ?3
             WHERE id = ?1 AND deleted_at IS NULL",
            params![schedule_id, paused_reason, now_text],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_occurrence_status(state, &request.idempotency_key)?
        .ok_or_else(|| "The schedule occurrence no longer exists.".into())
}

pub fn schedule_execution_permitted(
    state: &AppState,
    idempotency_key: &str,
    claim_token: &str,
) -> Result<bool, String> {
    validate_identifier(idempotency_key, "schedule occurrence")?;
    validate_claim_token(claim_token)?;
    let connection = state.connection()?;
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM schedule_occurrences o
                JOIN local_schedules s ON s.id = o.schedule_id
                WHERE o.idempotency_key = ?1
                  AND o.claim_token = ?2
                  AND o.status IN ('claimed', 'running')
                  AND s.enabled = 1
                  AND s.deleted_at IS NULL
                  AND s.revision = o.schedule_revision
             )",
            params![idempotency_key, claim_token],
            |row| row.get(0),
        )
        .map_err(error_text)
}

pub fn list_schedule_occurrences(
    state: &AppState,
    schedule_id: &str,
) -> Result<Vec<ScheduleOccurrenceStatus>, String> {
    validate_identifier(schedule_id, "schedule")?;
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT idempotency_key, schedule_id, status, attempt, scheduled_for,
                    next_attempt_at, pause_reason, run_id, updated_at
             FROM schedule_occurrences
             WHERE schedule_id = ?1
             ORDER BY scheduled_for ASC, created_at ASC",
        )
        .map_err(error_text)?;
    statement
        .query_map(params![schedule_id], occurrence_status_from_sql)
        .map_err(error_text)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error_text)
}

fn load_schedule(state: &AppState, id: &str) -> Result<Option<LocalSchedule>, String> {
    let connection = state.connection()?;
    load_schedule_in_connection(state, &connection, id)
}

fn load_schedule_in_connection(
    state: &AppState,
    connection: &Connection,
    id: &str,
) -> Result<Option<LocalSchedule>, String> {
    let row = connection
        .query_row(
            "SELECT id, thread_id, artifact_id, artifact_version, enabled, cadence,
                    timezone, revision, next_due_at, paused_reason, body_json,
                    created_at, updated_at
             FROM local_schedules WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            schedule_row_from_sql,
        )
        .optional()
        .map_err(error_text)?;
    row.map(|row| open_schedule(state, row)).transpose()
}

fn load_schedule_in_transaction(
    state: &AppState,
    transaction: &Transaction<'_>,
    id: &str,
) -> Result<Option<LocalSchedule>, String> {
    let row = transaction
        .query_row(
            "SELECT id, thread_id, artifact_id, artifact_version, enabled, cadence,
                    timezone, revision, next_due_at, paused_reason, body_json,
                    created_at, updated_at
             FROM local_schedules WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            schedule_row_from_sql,
        )
        .optional()
        .map_err(error_text)?;
    row.map(|row| open_schedule(state, row)).transpose()
}

fn load_due_schedule_rows(
    transaction: &Transaction<'_>,
    now: &str,
) -> Result<Vec<ScheduleRow>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, thread_id, artifact_id, artifact_version, enabled, cadence,
                    timezone, revision, next_due_at, paused_reason, body_json,
                    created_at, updated_at
             FROM local_schedules
             WHERE enabled = 1 AND deleted_at IS NULL
               AND next_due_at IS NOT NULL AND next_due_at <= ?1
             ORDER BY next_due_at ASC, id ASC",
        )
        .map_err(error_text)?;
    statement
        .query_map(params![now], schedule_row_from_sql)
        .map_err(error_text)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error_text)
}

fn schedule_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduleRow> {
    Ok(ScheduleRow {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        artifact_id: row.get(2)?,
        artifact_version: row.get(3)?,
        enabled: row.get(4)?,
        cadence: row.get(5)?,
        timezone: row.get(6)?,
        revision: row.get(7)?,
        next_due_at: row.get(8)?,
        paused_reason: row.get(9)?,
        body_json: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn open_schedule(state: &AppState, row: ScheduleRow) -> Result<LocalSchedule, String> {
    let plaintext = state
        .cipher()
        .open(&schedule_context(&row.id), &row.body_json)?;
    let body: ScheduleBody = serde_json::from_str(&plaintext).map_err(error_text)?;
    Ok(LocalSchedule {
        id: row.id,
        thread_id: row.thread_id,
        artifact_id: row.artifact_id,
        artifact_version: row.artifact_version,
        title: body.title,
        enabled: row.enabled,
        cadence: row.cadence,
        local_time: body.local_time,
        timezone: row.timezone,
        weekdays: body.weekdays,
        missed_policy: body.missed_policy,
        max_retries: body.max_retries,
        provider: body.provider,
        model: body.model,
        requires_network: body.requires_network,
        revision: row.revision,
        next_due_at: row.next_due_at,
        paused_reason: row.paused_reason,
        snapshot: body.snapshot,
        one_time_at: body.one_time_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn schedule_body(schedule: &LocalSchedule) -> ScheduleBody {
    ScheduleBody {
        title: schedule.title.clone(),
        local_time: schedule.local_time.clone(),
        weekdays: schedule.weekdays.clone(),
        missed_policy: schedule.missed_policy.clone(),
        max_retries: schedule.max_retries,
        provider: schedule.provider.clone(),
        model: schedule.model.clone(),
        requires_network: schedule.requires_network,
        snapshot: schedule.snapshot.clone(),
        one_time_at: schedule.one_time_at.clone(),
    }
}

fn due_occurrences(
    schedule: &LocalSchedule,
    first_due: DateTime<Utc>,
    now: DateTime<Utc>,
    limit: usize,
) -> Result<Vec<DateTime<Utc>>, String> {
    if schedule.missed_policy != "run-every" {
        return Ok(vec![first_due]);
    }
    let timezone = parse_timezone(&schedule.timezone)?;
    let body = schedule_body(schedule);
    let mut values = vec![first_due];
    let mut cursor = first_due;
    while values.len() < limit.min(MAX_CATCH_UP_OCCURRENCES) {
        let Some(next) = next_occurrence_after(&schedule.cadence, timezone, &body, cursor)? else {
            break;
        };
        if next > now {
            break;
        }
        values.push(next);
        cursor = next;
    }
    Ok(values)
}

fn claim_occurrence(
    transaction: &Transaction<'_>,
    schedule: &LocalSchedule,
    scheduled_for: DateTime<Utc>,
    owner: &str,
    now: DateTime<Utc>,
) -> Result<Option<ClaimedScheduleOccurrence>, String> {
    let idempotency_key = occurrence_key(schedule, scheduled_for);
    let run_id = deterministic_run_id(&idempotency_key);
    let now_text = canonical_time(now);
    let scheduled_text = canonical_time(scheduled_for);
    transaction
        .execute(
            "INSERT OR IGNORE INTO schedule_occurrences (
                idempotency_key, schedule_id, schedule_revision, scheduled_for,
                status, attempt, run_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'waking', 0, ?5, ?6, ?6)",
            params![
                idempotency_key,
                schedule.id,
                schedule.revision,
                scheduled_text,
                run_id,
                now_text,
            ],
        )
        .map_err(error_text)?;
    let claim_token = random_token()?;
    let lease = canonical_time(now + Duration::minutes(CLAIM_LEASE_MINUTES));
    let changed = transaction
        .execute(
            "UPDATE schedule_occurrences
             SET status = 'claimed', claim_owner = ?2, claim_token = ?3,
                 lease_expires_at = ?4, attempt = attempt + 1,
                 next_attempt_at = NULL, pause_reason = NULL, updated_at = ?5
             WHERE idempotency_key = ?1
               AND schedule_revision = ?6
               AND (
                    status IN ('waking', 'retry', 'paused')
                    OR (status IN ('claimed', 'running') AND lease_expires_at <= ?5)
               )",
            params![
                idempotency_key,
                owner,
                claim_token,
                lease,
                now_text,
                schedule.revision,
            ],
        )
        .map_err(error_text)?;
    if changed == 0 {
        return Ok(None);
    }
    let attempt = transaction
        .query_row(
            "SELECT attempt FROM schedule_occurrences WHERE idempotency_key = ?1",
            params![idempotency_key],
            |row| row.get::<_, u8>(0),
        )
        .map_err(error_text)?;
    Ok(Some(ClaimedScheduleOccurrence {
        idempotency_key,
        claim_token,
        scheduled_for: scheduled_text,
        attempt,
        run_id,
        schedule: schedule.clone(),
    }))
}

fn claim_retryable_occurrences(
    state: &AppState,
    transaction: &Transaction<'_>,
    owner: &str,
    environment: &ScheduleEnvironment,
    now: DateTime<Utc>,
    limit: usize,
    claimed: &mut Vec<ClaimedScheduleOccurrence>,
) -> Result<(), String> {
    if claimed.len() >= limit {
        return Ok(());
    }
    let now_text = canonical_time(now);
    let mut statement = transaction
        .prepare(
            "SELECT DISTINCT schedule_id
             FROM schedule_occurrences
             WHERE (
                    status IN ('retry', 'paused') AND next_attempt_at <= ?1
                  ) OR (
                    status = 'waking' AND claim_owner = 'scheduler-helper'
                  ) OR (
                    status IN ('waking', 'claimed', 'running') AND lease_expires_at <= ?1
                  )
             ORDER BY updated_at ASC",
        )
        .map_err(error_text)?;
    let schedule_ids = statement
        .query_map(params![now_text], |row| row.get::<_, String>(0))
        .map_err(error_text)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error_text)?;
    drop(statement);
    for schedule_id in schedule_ids {
        if claimed.len() >= limit {
            break;
        }
        let Some(schedule) = load_schedule_in_transaction(state, transaction, &schedule_id)? else {
            continue;
        };
        if !schedule.enabled || schedule_pause_reason(&schedule, environment).is_some() {
            continue;
        }
        let mut statement = transaction
            .prepare(
                "SELECT scheduled_for
                 FROM schedule_occurrences
                 WHERE schedule_id = ?1 AND schedule_revision = ?2
                   AND (
                        (status IN ('retry', 'paused') AND next_attempt_at <= ?3)
                        OR (status = 'waking' AND claim_owner = 'scheduler-helper')
                        OR (status IN ('waking', 'claimed', 'running') AND lease_expires_at <= ?3)
                   )
                 ORDER BY scheduled_for ASC LIMIT 1",
            )
            .map_err(error_text)?;
        let scheduled_for: Option<String> = statement
            .query_row(params![schedule.id, schedule.revision, now_text], |row| {
                row.get(0)
            })
            .optional()
            .map_err(error_text)?;
        drop(statement);
        if let Some(scheduled_for) = scheduled_for
            && let Some(value) = claim_occurrence(
                transaction,
                &schedule,
                parse_time(&scheduled_for, "scheduled occurrence")?,
                owner,
                now,
            )?
        {
            transaction
                .execute(
                    "UPDATE local_schedules SET paused_reason = NULL, updated_at = ?2
                     WHERE id = ?1 AND deleted_at IS NULL",
                    params![schedule.id, now_text],
                )
                .map_err(error_text)?;
            claimed.push(value);
        }
    }
    Ok(())
}

fn transition_claimed_occurrence(
    state: &AppState,
    idempotency_key: &str,
    claim_token: &str,
    status: &str,
) -> Result<ScheduleOccurrenceStatus, String> {
    validate_identifier(idempotency_key, "schedule occurrence")?;
    validate_claim_token(claim_token)?;
    let now = canonical_now();
    let lease = canonical_time(Utc::now() + Duration::minutes(CLAIM_LEASE_MINUTES));
    let connection = state.connection()?;
    let changed = connection
        .execute(
            "UPDATE schedule_occurrences
             SET status = ?3, lease_expires_at = ?4, updated_at = ?5
             WHERE idempotency_key = ?1 AND claim_token = ?2 AND status = 'claimed'",
            params![idempotency_key, claim_token, status, lease, now],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("This schedule claim is stale or no longer runnable.".into());
    }
    load_occurrence_status(state, idempotency_key)?
        .ok_or_else(|| "The schedule occurrence no longer exists.".into())
}

fn load_occurrence_status(
    state: &AppState,
    idempotency_key: &str,
) -> Result<Option<ScheduleOccurrenceStatus>, String> {
    let connection = state.connection()?;
    connection
        .query_row(
            "SELECT idempotency_key, schedule_id, status, attempt, scheduled_for,
                    next_attempt_at, pause_reason, run_id, updated_at
             FROM schedule_occurrences WHERE idempotency_key = ?1",
            params![idempotency_key],
            occurrence_status_from_sql,
        )
        .optional()
        .map_err(error_text)
}

fn occurrence_status_from_sql(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ScheduleOccurrenceStatus> {
    Ok(ScheduleOccurrenceStatus {
        idempotency_key: row.get(0)?,
        schedule_id: row.get(1)?,
        status: row.get(2)?,
        attempt: row.get(3)?,
        scheduled_for: row.get(4)?,
        next_attempt_at: row.get(5)?,
        pause_reason: row.get(6)?,
        run_id: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn advance_schedule_after(
    transaction: &Transaction<'_>,
    schedule: &LocalSchedule,
    after: DateTime<Utc>,
    updated_at: &str,
) -> Result<(), String> {
    let next_due = next_occurrence_after(
        &schedule.cadence,
        parse_timezone(&schedule.timezone)?,
        &schedule_body(schedule),
        after,
    )?
    .map(canonical_time);
    transaction
        .execute(
            "UPDATE local_schedules SET next_due_at = ?2, updated_at = ?3
             WHERE id = ?1 AND revision = ?4 AND enabled = 1 AND deleted_at IS NULL",
            params![schedule.id, next_due, updated_at, schedule.revision],
        )
        .map_err(error_text)?;
    Ok(())
}

fn record_skipped_occurrence(
    transaction: &Transaction<'_>,
    schedule: &LocalSchedule,
    scheduled_for: DateTime<Utc>,
    now: &str,
) -> Result<(), String> {
    let key = occurrence_key(schedule, scheduled_for);
    transaction
        .execute(
            "INSERT OR IGNORE INTO schedule_occurrences (
                idempotency_key, schedule_id, schedule_revision, scheduled_for,
                status, attempt, run_id, detail_json, created_at, updated_at, completed_at
             ) VALUES (?1, ?2, ?3, ?4, 'skipped', 0, ?5,
                       NULL, ?6, ?6, ?6)",
            params![
                key,
                schedule.id,
                schedule.revision,
                canonical_time(scheduled_for),
                deterministic_run_id(&key),
                now,
            ],
        )
        .map_err(error_text)?;
    Ok(())
}

fn record_paused_occurrence(
    transaction: &Transaction<'_>,
    schedule: &LocalSchedule,
    scheduled_for: DateTime<Utc>,
    reason: &str,
    now: &str,
) -> Result<(), String> {
    let key = occurrence_key(schedule, scheduled_for);
    transaction
        .execute(
            "INSERT INTO schedule_occurrences (
                idempotency_key, schedule_id, schedule_revision, scheduled_for,
                status, attempt, next_attempt_at, run_id, pause_reason, detail_json,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'paused', 0, ?5, ?6, ?7, NULL, ?5, ?5)
             ON CONFLICT(idempotency_key) DO UPDATE SET
                status = CASE
                    WHEN schedule_occurrences.status IN ('completed', 'failed', 'skipped', 'canceled')
                    THEN schedule_occurrences.status ELSE 'paused' END,
                next_attempt_at = CASE
                    WHEN schedule_occurrences.status IN ('completed', 'failed', 'skipped', 'canceled')
                    THEN schedule_occurrences.next_attempt_at ELSE excluded.next_attempt_at END,
                pause_reason = CASE
                    WHEN schedule_occurrences.status IN ('completed', 'failed', 'skipped', 'canceled')
                    THEN schedule_occurrences.pause_reason ELSE excluded.pause_reason END,
                detail_json = CASE
                    WHEN schedule_occurrences.status IN ('completed', 'failed', 'skipped', 'canceled')
                    THEN schedule_occurrences.detail_json ELSE excluded.detail_json END,
                updated_at = excluded.updated_at",
            params![
                key,
                schedule.id,
                schedule.revision,
                canonical_time(scheduled_for),
                now,
                deterministic_run_id(&key),
                reason,
            ],
        )
        .map_err(error_text)?;
    Ok(())
}

fn cancel_open_occurrences(
    transaction: &Transaction<'_>,
    schedule_id: &str,
    now: &str,
    _detail: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE schedule_occurrences
             SET status = 'canceled', claim_owner = NULL, claim_token = NULL,
                 lease_expires_at = NULL, next_attempt_at = NULL, pause_reason = NULL,
                 detail_json = NULL, completed_at = ?2, updated_at = ?2
             WHERE schedule_id = ?1
               AND status IN ('waking', 'claimed', 'running', 'retry', 'paused')",
            params![schedule_id, now],
        )
        .map_err(error_text)?;
    Ok(())
}

fn ensure_artifact_version(
    transaction: &Transaction<'_>,
    thread_id: &str,
    artifact_id: &str,
    artifact_version: &str,
) -> Result<(), String> {
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM threads t
                JOIN artifacts a ON a.id = ?2
                JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = ?3
                WHERE t.id = ?1
             )",
            params![thread_id, artifact_id, artifact_version],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if !exists {
        return Err("Choose a saved Thread and artifact version before scheduling.".into());
    }
    Ok(())
}

fn encrypted_optional_detail(
    state: &AppState,
    idempotency_key: &str,
    detail: Option<&str>,
) -> Result<Option<String>, String> {
    detail
        .map(|detail| {
            state.cipher().seal(
                &format!("schedule-occurrence:{idempotency_key}:detail"),
                detail,
            )
        })
        .transpose()
}

fn schedule_pause_reason(
    schedule: &LocalSchedule,
    environment: &ScheduleEnvironment,
) -> Option<String> {
    if !environment.background_enabled {
        Some("Paused until background work is enabled.".into())
    } else if environment.low_power_mode {
        Some("Paused while Low Power Mode is on.".into())
    } else if environment.on_battery {
        Some("Paused while this Mac is running on battery.".into())
    } else if schedule.requires_network && !environment.online {
        Some("Paused until this Mac is online.".into())
    } else if !environment.folder_access {
        Some("Paused until project folder access is restored.".into())
    } else if !environment.provider_available {
        Some("Paused until the selected model provider is available.".into())
    } else if !environment.provider_quota_available {
        Some("Paused until the selected provider quota resets.".into())
    } else {
        None
    }
}

fn validate_schedule_request(request: &SaveLocalScheduleRequest) -> Result<(), String> {
    validate_identifier(&request.id, "schedule")?;
    validate_identifier(&request.thread_id, "thread")?;
    validate_identifier(&request.artifact_id, "artifact")?;
    validate_identifier(&request.artifact_version, "artifact version")?;
    validate_label(&request.title, 120, "schedule title")?;
    validate_label(&request.provider, 80, "provider")?;
    validate_label(&request.model, 160, "model")?;
    if request
        .expected_revision
        .is_some_and(|revision| revision < 1)
    {
        return Err("The expected routine revision must be positive.".into());
    }
    if !matches!(
        request.cadence.as_str(),
        "once" | "daily" | "weekdays" | "weekly"
    ) {
        return Err("Choose once, daily, weekdays, or weekly for this schedule.".into());
    }
    if !matches!(
        request.missed_policy.as_str(),
        "skip" | "run-once" | "run-every"
    ) {
        return Err("Choose skip, run once, or run every for missed work.".into());
    }
    if request.max_retries > MAX_RETRIES_LIMIT {
        return Err(format!(
            "Local schedules support at most {MAX_RETRIES_LIMIT} retries."
        ));
    }
    parse_local_time(&request.local_time)?;
    parse_timezone(&request.timezone)?;
    normalized_weekdays(&request.cadence, &request.weekdays)?;
    if request.cadence == "once" {
        let at = request
            .one_time_at
            .as_deref()
            .ok_or_else(|| "Choose when this one-time schedule should run.".to_string())?;
        parse_time(at, "one-time schedule")?;
    }
    validate_safe_snapshot(&request.snapshot, "snapshot", 0)
}

fn validate_safe_snapshot(value: &Value, path: &str, depth: usize) -> Result<(), String> {
    if depth > 32 {
        return Err("The pinned schedule snapshot is too deeply nested.".into());
    }
    match value {
        Value::Object(values) => {
            for (key, value) in values {
                let normalized = key.to_ascii_lowercase();
                if [
                    "apikey",
                    "api_key",
                    "token",
                    "secret",
                    "password",
                    "authorization",
                    "cookie",
                    "credential",
                ]
                .iter()
                .any(|candidate| normalized.contains(candidate))
                {
                    return Err(format!(
                        "Remove credentials from the pinned schedule snapshot ({path}.{key})."
                    ));
                }
                validate_safe_snapshot(value, &format!("{path}.{key}"), depth + 1)?;
            }
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                validate_safe_snapshot(value, &format!("{path}[{index}]"), depth + 1)?;
            }
        }
        Value::String(value) if value.len() > 128 * 1024 => {
            return Err("The pinned schedule snapshot contains an oversized value.".into());
        }
        _ => {}
    }
    Ok(())
}

fn normalized_weekdays(cadence: &str, weekdays: &[u8]) -> Result<Vec<u8>, String> {
    let mut values = if cadence == "weekdays" {
        vec![1, 2, 3, 4, 5]
    } else {
        weekdays.to_vec()
    };
    values.sort_unstable();
    values.dedup();
    if values.iter().any(|day| !(1..=7).contains(day)) {
        return Err("Weekdays must use values 1 through 7.".into());
    }
    if cadence == "weekly" && values.is_empty() {
        return Err("Choose at least one weekday for a weekly schedule.".into());
    }
    Ok(values)
}

fn next_occurrence_after(
    cadence: &str,
    timezone: Tz,
    body: &ScheduleBody,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, String> {
    if cadence == "once" {
        let at = body
            .one_time_at
            .as_deref()
            .ok_or_else(|| "A one-time schedule is missing its run time.".to_string())?;
        let at = parse_time(at, "one-time schedule")?;
        return Ok((at > after).then_some(at));
    }
    let time = parse_local_time(&body.local_time)?;
    let local_after = after.with_timezone(&timezone);
    let start = local_after.date_naive();
    for offset in 0..=370 {
        let date = start
            .checked_add_signed(Duration::days(offset))
            .ok_or_else(|| "The schedule date is outside the supported range.".to_string())?;
        if !schedule_runs_on_date(cadence, &body.weekdays, date) {
            continue;
        }
        let Some(candidate) = local_datetime(timezone, date, time)? else {
            continue;
        };
        let candidate = candidate.with_timezone(&Utc);
        if candidate > after {
            return Ok(Some(candidate));
        }
    }
    Err("Could not calculate the next schedule occurrence.".into())
}

fn schedule_runs_on_date(cadence: &str, weekdays: &[u8], date: NaiveDate) -> bool {
    match cadence {
        "daily" => true,
        "weekdays" => date.weekday().number_from_monday() <= 5,
        "weekly" => weekdays.contains(&(date.weekday().number_from_monday() as u8)),
        _ => false,
    }
}

fn local_datetime(
    timezone: Tz,
    date: NaiveDate,
    time: NaiveTime,
) -> Result<Option<DateTime<Tz>>, String> {
    let naive = date.and_time(time);
    match timezone.from_local_datetime(&naive) {
        LocalResult::Single(value) => Ok(Some(value)),
        LocalResult::Ambiguous(first, _) => Ok(Some(first)),
        LocalResult::None => {
            for minutes in 1..=180 {
                let shifted = naive + Duration::minutes(minutes);
                match timezone.from_local_datetime(&shifted) {
                    LocalResult::Single(value) => return Ok(Some(value)),
                    LocalResult::Ambiguous(first, _) => return Ok(Some(first)),
                    LocalResult::None => {}
                }
            }
            Ok(None)
        }
    }
}

fn parse_local_time(value: &str) -> Result<NaiveTime, String> {
    NaiveTime::parse_from_str(value, "%H:%M")
        .map_err(|_| "Schedule time must use 24-hour HH:MM format.".to_string())
}

fn parse_timezone(value: &str) -> Result<Tz, String> {
    value
        .parse::<Tz>()
        .map_err(|_| "Choose a valid IANA time zone for this schedule.".to_string())
}

fn parse_time(value: &str, label: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| format!("The {label} time is invalid."))
}

fn occurrence_key(schedule: &LocalSchedule, scheduled_for: DateTime<Utc>) -> String {
    format!(
        "{}:{}:{}",
        schedule.id,
        schedule.revision,
        scheduled_for.timestamp_millis()
    )
}

fn deterministic_run_id(idempotency_key: &str) -> String {
    let digest = Sha256::digest(idempotency_key.as_bytes());
    format!("scheduled-{}", hex_lower(&digest[..16]))
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    fill_random(&mut bytes).map_err(|_| "Could not create a schedule claim token.".to_string())?;
    Ok(hex_lower(&bytes))
}

fn retry_delay_minutes(attempt: u8) -> i64 {
    2_i64.pow(u32::from(attempt.saturating_sub(1))).clamp(1, 16)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(HEX[(byte >> 4) as usize] as char);
        value.push(HEX[(byte & 0x0f) as usize] as char);
    }
    value
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 180
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ":_-".contains(character))
    {
        return Err(format!("Invalid {label} identifier."));
    }
    Ok(())
}

fn validate_owner(value: &str) -> Result<(), String> {
    validate_label(value, 120, "schedule worker")
}

fn validate_claim_token(value: &str) -> Result<(), String> {
    if value.len() != 48 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("The schedule claim token is invalid.".into());
    }
    Ok(())
}

fn validate_label(value: &str, max_length: usize, label: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_length || value.chars().any(char::is_control) {
        return Err(format!("The {label} is invalid."));
    }
    Ok(())
}

fn schedule_context(id: &str) -> String {
    format!("schedule:{id}")
}

fn canonical_now() -> String {
    canonical_time(Utc::now())
}

fn canonical_time(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn default_true() -> bool {
    true
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use tempfile::tempdir;

    fn at(value: &str) -> DateTime<Utc> {
        parse_time(value, "test").expect("test time")
    }

    fn schedule_request() -> SaveLocalScheduleRequest {
        SaveLocalScheduleRequest {
            id: "schedule-release".into(),
            expected_revision: None,
            thread_id: "local-welcome".into(),
            artifact_id: "artifact-agent-local".into(),
            artifact_version: "v1".into(),
            title: "Weekday release check".into(),
            enabled: true,
            cadence: "weekdays".into(),
            local_time: "09:00".into(),
            timezone: "America/Denver".into(),
            weekdays: Vec::new(),
            missed_policy: "run-once".into(),
            max_retries: 2,
            provider: "codex".into(),
            model: "default".into(),
            requires_network: true,
            snapshot: json!({"goal": "Verify one release", "artifactVersion": "v1"}),
            one_time_at: None,
        }
    }

    #[test]
    fn saves_an_encrypted_pinned_schedule_and_calculates_dst_safely() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let saved = save_local_schedule_at(&state, schedule_request(), at("2026-03-06T18:00:00Z"))
            .expect("schedule");
        assert_eq!(
            saved.next_due_at.as_deref(),
            Some("2026-03-09T15:00:00.000Z")
        );
        assert_eq!(saved.weekdays, vec![1, 2, 3, 4, 5]);

        let connection = state.connection().expect("connection");
        let encrypted: String = connection
            .query_row(
                "SELECT body_json FROM local_schedules WHERE id = 'schedule-release'",
                [],
                |row| row.get(0),
            )
            .expect("stored schedule");
        assert!(crate::crypto::DataCipher::is_sealed(&encrypted));
        assert!(!encrypted.contains("Verify one release"));
    }

    #[test]
    fn schedule_updates_require_the_current_revision() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let created =
            save_local_schedule_at(&state, schedule_request(), at("2026-08-19T14:00:00Z"))
                .expect("created schedule");

        let mut update = schedule_request();
        update.expected_revision = Some(created.revision);
        update.local_time = "10:00".into();
        let updated = save_local_schedule_at(&state, update, at("2026-08-19T14:01:00Z"))
            .expect("revision-matched update");
        assert_eq!(updated.revision, created.revision + 1);
        assert_eq!(updated.local_time, "10:00");

        let mut stale = schedule_request();
        stale.expected_revision = Some(created.revision);
        stale.local_time = "11:00".into();
        let error = save_local_schedule_at(&state, stale, at("2026-08-19T14:02:00Z"))
            .expect_err("stale update must fail");
        assert_eq!(
            error,
            "That routine changed before this update. Review it and try again."
        );

        let persisted = list_local_schedules(&state).expect("persisted schedules");
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].revision, updated.revision);
        assert_eq!(persisted[0].local_time, "10:00");
    }

    #[test]
    fn accepts_a_credential_free_bot_routine_bound_to_its_local_thread() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let bots = crate::storage::bootstrap_local_bots(&state).expect("starter bot");
        let artifact = bots
            .workspace
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == "artifact-plan-ship-local")
            .expect("bot run artifact");
        let mut request = schedule_request();
        request.id = "routine-bot-release-proof".into();
        request.thread_id = bots.active_bot.thread_id.clone();
        request.artifact_id = artifact.artifact_id.clone();
        request.artifact_version = artifact.version.clone();
        request.enabled = false;
        request.snapshot = json!({
            "schemaVersion": 1,
            "kind": "bot-routine",
            "routineId": request.id,
            "botId": bots.active_bot.id,
            "botVersion": bots.active_bot.current_version,
            "goalId": bots.active_bot.spec["goal"]["id"],
            "prompt": "Review the latest release proof.",
            "triggerLabel": "Every weekday at 9:00 AM",
            "permissionSnapshot": bots.active_bot.spec["permissionPolicy"],
            "createdAt": "2026-08-19T15:00:00.000Z"
        });

        let saved = save_local_schedule_at(&state, request, at("2026-08-19T15:00:00Z"))
            .expect("bot routine");
        assert_eq!(saved.thread_id, "thread-bot-codelit");
        assert_eq!(saved.snapshot["kind"], "bot-routine");
        assert_eq!(saved.snapshot["botId"], "bot-codelit");
        assert!(!saved.enabled);
    }

    #[test]
    fn duplicate_wakes_claim_each_occurrence_exactly_once() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        save_local_schedule_at(&state, schedule_request(), at("2026-08-10T14:00:00Z"))
            .expect("schedule");
        let now = at("2026-08-10T15:01:00Z");
        let first = claim_due_schedules_at(
            &state,
            "app-worker-one",
            &ScheduleEnvironment::default(),
            4,
            now,
        )
        .expect("first wake");
        let duplicate = claim_due_schedules_at(
            &state,
            "app-worker-two",
            &ScheduleEnvironment::default(),
            4,
            now,
        )
        .expect("duplicate wake");
        assert_eq!(first.len(), 1);
        assert!(duplicate.is_empty());
        assert!(
            schedule_execution_permitted(&state, &first[0].idempotency_key, &first[0].claim_token)
                .expect("permission")
        );
    }

    #[test]
    fn concurrent_wakes_still_claim_one_occurrence() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        save_local_schedule_at(&state, schedule_request(), at("2026-08-10T14:00:00Z"))
            .expect("schedule");
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|index| {
                let state = state.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    claim_due_schedules_at(
                        &state,
                        &format!("concurrent-worker-{index}"),
                        &ScheduleEnvironment::default(),
                        1,
                        at("2026-08-10T15:01:00Z"),
                    )
                    .expect("concurrent claim")
                    .len()
                })
            })
            .collect::<Vec<_>>();
        let claimed = handles
            .into_iter()
            .map(|handle| handle.join().expect("worker joined"))
            .sum::<usize>();
        assert_eq!(claimed, 1);
    }

    #[test]
    fn app_adopts_a_fresh_helper_wake_without_waiting_for_its_lease() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let schedule =
            save_local_schedule_at(&state, schedule_request(), at("2026-08-10T14:00:00Z"))
                .expect("schedule");
        let scheduled_for = at("2026-08-10T15:00:00Z");
        let key = occurrence_key(&schedule, scheduled_for);
        let connection = state.connection().expect("connection");
        connection
            .execute(
                "UPDATE local_schedules SET next_due_at = '2026-08-11T15:00:00.000Z'
                 WHERE id = 'schedule-release'",
                [],
            )
            .expect("advanced schedule");
        connection
            .execute(
                "INSERT INTO schedule_occurrences (
                    idempotency_key, schedule_id, schedule_revision, scheduled_for,
                    status, claim_owner, claim_token, lease_expires_at, attempt,
                    run_id, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'waking', 'scheduler-helper',
                           'helper-token', '2026-08-10T15:03:00.000Z', 0, ?5, ?6, ?6)",
                params![
                    key,
                    schedule.id,
                    schedule.revision,
                    canonical_time(scheduled_for),
                    deterministic_run_id(&key),
                    "2026-08-10T15:01:00.000Z",
                ],
            )
            .expect("helper wake");
        drop(connection);

        let claims = claim_due_schedules_at(
            &state,
            "app-worker",
            &ScheduleEnvironment::default(),
            1,
            at("2026-08-10T15:01:00Z"),
        )
        .expect("adopted wake");
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].idempotency_key, key);
        assert_eq!(claims[0].attempt, 1);
    }

    #[test]
    fn background_consent_pauses_and_revokes_active_work() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        save_local_schedule_at(&state, schedule_request(), at("2026-08-10T14:00:00Z"))
            .expect("schedule");
        let claim = claim_due_schedules_at(
            &state,
            "app-worker",
            &ScheduleEnvironment::default(),
            1,
            at("2026-08-10T15:01:00Z"),
        )
        .expect("claim")
        .remove(0);
        pause_all_schedule_claims(&state, "Paused until background work is enabled.")
            .expect("paused all claims");
        assert!(
            !schedule_execution_permitted(&state, &claim.idempotency_key, &claim.claim_token)
                .expect("permission revoked")
        );
        let occurrence = list_schedule_occurrences(&state, "schedule-release")
            .expect("occurrences")
            .remove(0);
        assert_eq!(occurrence.status, "paused");
        assert_eq!(
            occurrence.pause_reason.as_deref(),
            Some("Paused until background work is enabled.")
        );
    }

    #[test]
    fn disabling_or_deleting_revokes_an_inflight_claim() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        save_local_schedule_at(&state, schedule_request(), at("2026-08-10T14:00:00Z"))
            .expect("schedule");
        let claim = claim_due_schedules_at(
            &state,
            "app-worker",
            &ScheduleEnvironment::default(),
            1,
            at("2026-08-10T15:01:00Z"),
        )
        .expect("claim")
        .remove(0);
        set_local_schedule_enabled(
            &state,
            SetLocalScheduleEnabledRequest {
                id: "schedule-release".into(),
                enabled: false,
            },
        )
        .expect("disabled");
        assert!(
            !schedule_execution_permitted(&state, &claim.idempotency_key, &claim.claim_token)
                .expect("permission")
        );
        assert_eq!(
            list_schedule_occurrences(&state, "schedule-release").expect("occurrences")[0].status,
            "canceled"
        );

        set_local_schedule_enabled(
            &state,
            SetLocalScheduleEnabledRequest {
                id: "schedule-release".into(),
                enabled: true,
            },
        )
        .expect("enabled");
        delete_local_schedule(&state, "schedule-release").expect("deleted");
        assert!(list_local_schedules(&state).expect("schedules").is_empty());
    }

    #[test]
    fn missed_policy_can_skip_run_once_or_catch_up_without_duplicates() {
        for (policy, expected) in [("skip", 0), ("run-once", 1), ("run-every", 4)] {
            let directory = tempdir().expect("temporary directory");
            let state = AppState::for_test(directory.path()).expect("state");
            let mut request = schedule_request();
            request.cadence = "daily".into();
            request.missed_policy = policy.into();
            save_local_schedule_at(&state, request, at("2026-08-07T14:00:00Z")).expect("schedule");
            let claims = claim_due_schedules_at(
                &state,
                "wake-worker",
                &ScheduleEnvironment::default(),
                10,
                at("2026-08-10T15:01:00Z"),
            )
            .expect("claims");
            assert_eq!(claims.len(), expected, "policy {policy}");
            let duplicate = claim_due_schedules_at(
                &state,
                "duplicate-worker",
                &ScheduleEnvironment::default(),
                10,
                at("2026-08-10T15:01:00Z"),
            )
            .expect("duplicate claims");
            assert!(duplicate.is_empty(), "policy {policy}");
        }
    }

    #[test]
    fn unsafe_environment_pauses_and_then_resumes_the_same_occurrence() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        save_local_schedule_at(&state, schedule_request(), at("2026-08-10T14:00:00Z"))
            .expect("schedule");
        let blocked = ScheduleEnvironment {
            online: false,
            ..ScheduleEnvironment::default()
        };
        let now = at("2026-08-10T15:01:00Z");
        assert!(
            claim_due_schedules_at(&state, "worker", &blocked, 1, now)
                .expect("blocked claim")
                .is_empty()
        );
        let paused = list_schedule_occurrences(&state, "schedule-release")
            .expect("occurrences")
            .remove(0);
        assert_eq!(paused.status, "paused");
        assert_eq!(
            paused.pause_reason.as_deref(),
            Some("Paused until this Mac is online.")
        );

        let resumed = claim_due_schedules_at(
            &state,
            "worker",
            &ScheduleEnvironment::default(),
            1,
            now + Duration::minutes(6),
        )
        .expect("resumed");
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].idempotency_key, paused.idempotency_key);
        assert_eq!(
            list_local_schedules(&state).expect("schedules")[0].paused_reason,
            None
        );

        finish_schedule_occurrence_at(
            &state,
            FinishScheduleOccurrenceRequest {
                idempotency_key: resumed[0].idempotency_key.clone(),
                claim_token: resumed[0].claim_token.clone(),
                outcome: "paused".into(),
                detail: Some("Paused until project folder access is restored.".into()),
            },
            now + Duration::minutes(6),
        )
        .expect("runtime pause");
        assert_eq!(
            list_local_schedules(&state).expect("schedules")[0]
                .paused_reason
                .as_deref(),
            Some("Paused until project folder access is restored.")
        );
    }

    #[test]
    fn environment_pause_reasons_are_specific_and_local_models_work_offline() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let networked =
            save_local_schedule_at(&state, schedule_request(), at("2026-08-10T14:00:00Z"))
                .expect("schedule");
        let cases = [
            (
                ScheduleEnvironment {
                    background_enabled: false,
                    ..ScheduleEnvironment::default()
                },
                "Paused until background work is enabled.",
            ),
            (
                ScheduleEnvironment {
                    online: false,
                    ..ScheduleEnvironment::default()
                },
                "Paused until this Mac is online.",
            ),
            (
                ScheduleEnvironment {
                    folder_access: false,
                    ..ScheduleEnvironment::default()
                },
                "Paused until project folder access is restored.",
            ),
            (
                ScheduleEnvironment {
                    provider_available: false,
                    ..ScheduleEnvironment::default()
                },
                "Paused until the selected model provider is available.",
            ),
            (
                ScheduleEnvironment {
                    provider_quota_available: false,
                    ..ScheduleEnvironment::default()
                },
                "Paused until the selected provider quota resets.",
            ),
        ];
        for (environment, expected) in cases {
            assert_eq!(
                schedule_pause_reason(&networked, &environment).as_deref(),
                Some(expected)
            );
        }

        let mut local = networked;
        local.requires_network = false;
        assert_eq!(
            schedule_pause_reason(
                &local,
                &ScheduleEnvironment {
                    online: false,
                    ..ScheduleEnvironment::default()
                }
            ),
            None
        );
    }

    #[test]
    fn failures_retry_with_a_bound_and_keep_the_same_run_identity() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        save_local_schedule_at(&state, schedule_request(), at("2026-08-10T14:00:00Z"))
            .expect("schedule");
        let due = at("2026-08-10T15:01:00Z");
        let first =
            claim_due_schedules_at(&state, "worker", &ScheduleEnvironment::default(), 1, due)
                .expect("first claim")
                .remove(0);
        let retry = finish_schedule_occurrence_at(
            &state,
            FinishScheduleOccurrenceRequest {
                idempotency_key: first.idempotency_key.clone(),
                claim_token: first.claim_token,
                outcome: "failed".into(),
                detail: Some("Provider unavailable.".into()),
            },
            due,
        )
        .expect("retry state");
        assert_eq!(retry.status, "retry");
        let connection = state.connection().expect("connection");
        let encrypted_detail: String = connection
            .query_row(
                "SELECT detail_json FROM schedule_occurrences WHERE idempotency_key = ?1",
                params![first.idempotency_key],
                |row| row.get(0),
            )
            .expect("encrypted failure detail");
        assert!(crate::crypto::DataCipher::is_sealed(&encrypted_detail));
        assert!(!encrypted_detail.contains("Provider unavailable"));
        drop(connection);
        let second = claim_due_schedules_at(
            &state,
            "worker",
            &ScheduleEnvironment::default(),
            1,
            due + Duration::minutes(1),
        )
        .expect("second claim")
        .remove(0);
        assert_eq!(second.run_id, first.run_id);

        let retry = finish_schedule_occurrence_at(
            &state,
            FinishScheduleOccurrenceRequest {
                idempotency_key: second.idempotency_key.clone(),
                claim_token: second.claim_token,
                outcome: "failed".into(),
                detail: Some("Provider unavailable.".into()),
            },
            due + Duration::minutes(1),
        )
        .expect("second retry state");
        assert_eq!(retry.status, "retry");
        let third = claim_due_schedules_at(
            &state,
            "worker",
            &ScheduleEnvironment::default(),
            1,
            due + Duration::minutes(3),
        )
        .expect("third claim")
        .remove(0);
        let failed = finish_schedule_occurrence_at(
            &state,
            FinishScheduleOccurrenceRequest {
                idempotency_key: third.idempotency_key,
                claim_token: third.claim_token,
                outcome: "failed".into(),
                detail: Some("Provider unavailable.".into()),
            },
            due + Duration::minutes(3),
        )
        .expect("terminal failure");
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.attempt, 3);
    }

    #[test]
    fn rejects_credentials_in_schedule_snapshots() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let mut request = schedule_request();
        request.snapshot = json!({"provider": {"apiKey": "must-not-persist"}});
        let error =
            save_local_schedule_at(&state, request, Utc::now()).expect_err("credentials rejected");
        assert!(error.contains("Remove credentials"));
    }

    #[test]
    fn schedule_survives_reopen_and_idempotent_schema_upgrade() {
        let directory = tempdir().expect("temporary directory");
        {
            let state = AppState::for_test(directory.path()).expect("state");
            save_local_schedule_at(&state, schedule_request(), at("2026-08-10T14:00:00Z"))
                .expect("schedule");
        }
        let reopened = AppState::for_test(directory.path()).expect("reopened state");
        let schedules = list_local_schedules(&reopened).expect("persisted schedules");
        assert_eq!(schedules.len(), 1);
        assert_eq!(schedules[0].title, "Weekday release check");
        let connection = reopened.connection().expect("connection");
        let migrations: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 7",
                [],
                |row| row.get(0),
            )
            .expect("migration count");
        assert_eq!(migrations, 1);
    }
}
