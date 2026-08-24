use crate::storage::AppState;
use crate::tool_runtime::LocalProjectFingerprint;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use getrandom::fill as fill_random;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

const CLAIM_LEASE_MINUTES: i64 = 2;
const MAX_EVENT_ROUTINES: i64 = 32;
const MAX_EVENT_OCCURRENCES_PER_ROUTINE: i64 = 200;

type EventRoutineStateRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRoutineTrigger {
    pub kind: String,
    pub label: String,
    pub debounce_seconds: u16,
    pub cooldown_minutes: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRoutineBudget {
    pub max_actions: u8,
    pub max_retries: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEventRoutine {
    pub id: String,
    pub version: i64,
    pub bot_id: String,
    pub thread_id: String,
    pub title: String,
    pub enabled: bool,
    pub prompt: String,
    pub trigger: EventRoutineTrigger,
    pub budget: EventRoutineBudget,
    pub provider: String,
    pub model: String,
    pub requires_network: bool,
    pub bot_snapshot: Value,
    pub memory_snapshot_hash: String,
    pub skill_versions: BTreeMap<String, i64>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_triggered_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_file_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_truncated: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLocalEventRoutineRequest {
    pub id: String,
    pub bot_id: String,
    pub title: String,
    pub prompt: String,
    pub trigger: EventRoutineTrigger,
    pub budget: EventRoutineBudget,
    pub provider: String,
    pub model: String,
    pub requires_network: bool,
    pub bot_snapshot: Value,
    pub memory_snapshot_hash: String,
    #[serde(default)]
    pub skill_versions: BTreeMap<String, i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLocalEventRoutineEnabledRequest {
    pub id: String,
    pub enabled: bool,
    #[serde(default)]
    pub fingerprint: Option<LocalProjectFingerprint>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimChangedEventRoutinesRequest {
    pub owner: String,
    pub fingerprint: LocalProjectFingerprint,
    #[serde(default = "default_claim_limit")]
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishEventRoutineOccurrenceRequest {
    pub idempotency_key: String,
    pub claim_token: String,
    pub outcome: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRoutineOccurrenceStatus {
    pub idempotency_key: String,
    pub routine_id: String,
    pub status: String,
    pub attempt: u8,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pause_reason: Option<String>,
    pub run_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedEventRoutineOccurrence {
    pub idempotency_key: String,
    pub claim_token: String,
    pub observed_at: String,
    pub attempt: u8,
    pub run_id: String,
    pub previous_fingerprint: String,
    pub fingerprint: String,
    pub routine: LocalEventRoutine,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventRoutineBody {
    schema_version: u8,
    prompt: String,
    trigger: EventRoutineTrigger,
    budget: EventRoutineBudget,
    provider: String,
    model: String,
    requires_network: bool,
    bot_snapshot: Value,
    memory_snapshot_hash: String,
    skill_versions: BTreeMap<String, i64>,
    created_at: String,
}

#[derive(Debug)]
struct RoutineRow {
    id: String,
    bot_id: String,
    thread_id: String,
    version: i64,
    title: String,
    enabled: bool,
    paused_reason: Option<String>,
    body_json: String,
    created_at: String,
    updated_at: String,
    last_checked_at: Option<String>,
    last_triggered_at: Option<String>,
    last_outcome: Option<String>,
    last_file_count: Option<u32>,
    last_truncated: Option<bool>,
}

#[derive(Debug)]
struct ClaimMeta {
    idempotency_key: String,
    claim_token: String,
    routine_id: String,
    observed_at: String,
    attempt: u8,
    run_id: String,
    previous_fingerprint: String,
    fingerprint: String,
}

fn default_claim_limit() -> usize {
    1
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    if !column_exists(connection, "routines", "trigger_kind")? {
        connection
            .execute(
                "ALTER TABLE routines ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'project-change'",
                [],
            )
            .map_err(error_text)?;
    }
    if !column_exists(connection, "routines", "paused_reason")? {
        connection
            .execute("ALTER TABLE routines ADD COLUMN paused_reason TEXT", [])
            .map_err(error_text)?;
    }
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS event_routine_state (
                routine_id TEXT PRIMARY KEY REFERENCES routines(id) ON DELETE CASCADE,
                baseline_sha256 TEXT,
                pending_sha256 TEXT,
                pending_since TEXT,
                last_checked_at TEXT,
                last_triggered_at TEXT,
                last_file_count INTEGER,
                last_truncated INTEGER,
                sequence INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS event_routine_occurrences (
                idempotency_key TEXT PRIMARY KEY,
                routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
                routine_version INTEGER NOT NULL,
                observed_at TEXT NOT NULL,
                previous_fingerprint TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN (
                    'claimed', 'running', 'retry', 'paused', 'completed', 'failed', 'canceled'
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
             CREATE INDEX IF NOT EXISTS idx_event_routines_enabled
                ON routines(enabled, trigger_kind, updated_at);
             CREATE INDEX IF NOT EXISTS idx_event_occurrences_resume
                ON event_routine_occurrences(status, next_attempt_at, lease_expires_at);
             CREATE INDEX IF NOT EXISTS idx_event_occurrences_routine
                ON event_routine_occurrences(routine_id, observed_at DESC);",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (12, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn list_local_event_routines(state: &AppState) -> Result<Vec<LocalEventRoutine>, String> {
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT r.id, r.bot_id, b.thread_id, r.current_version, r.title, r.enabled,
                    r.paused_reason, v.body_json, r.created_at, r.updated_at,
                    s.last_checked_at, s.last_triggered_at,
                    (SELECT o.status FROM event_routine_occurrences o
                     WHERE o.routine_id = r.id ORDER BY o.updated_at DESC LIMIT 1),
                    s.last_file_count, s.last_truncated
             FROM routines r
             JOIN bots b ON b.id = r.bot_id
             JOIN routine_versions v
               ON v.routine_id = r.id AND v.version = r.current_version
             LEFT JOIN event_routine_state s ON s.routine_id = r.id
             WHERE r.trigger_kind = 'project-change'
             ORDER BY r.updated_at DESC, r.id ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map([], routine_row_from_sql)
        .map_err(error_text)?;
    let mut routines = Vec::new();
    for row in rows {
        routines.push(open_routine(state, row.map_err(error_text)?)?);
    }
    Ok(routines)
}

pub fn save_local_event_routine(
    state: &AppState,
    request: SaveLocalEventRoutineRequest,
) -> Result<LocalEventRoutine, String> {
    validate_identifier(&request.id, "event routine")?;
    validate_identifier(&request.bot_id, "bot")?;
    validate_label(&request.title, 100, "routine title")?;
    validate_label(&request.prompt, 4_000, "routine task")?;
    validate_trigger(&request.trigger)?;
    validate_budget(&request.budget)?;
    validate_label(&request.provider, 80, "routine provider")?;
    validate_label(&request.model, 180, "routine model")?;
    validate_snapshot_hash(&request.memory_snapshot_hash, "memory snapshot")?;
    validate_skill_versions(&request.skill_versions)?;
    validate_bot_snapshot(&request.bot_snapshot, &request.bot_id)?;
    let created_at = canonical_time(&request.created_at, "routine creation time")?;
    let body = EventRoutineBody {
        schema_version: 1,
        prompt: request.prompt.trim().to_string(),
        trigger: request.trigger,
        budget: request.budget,
        provider: request.provider.trim().to_string(),
        model: request.model.trim().to_string(),
        requires_network: request.requires_network,
        bot_snapshot: request.bot_snapshot,
        memory_snapshot_hash: request.memory_snapshot_hash,
        skill_versions: request.skill_versions,
        created_at: created_at.clone(),
    };
    validate_body(&body, &request.bot_id)?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let bot_version: Option<i64> = transaction
        .query_row(
            "SELECT current_version FROM bots WHERE id = ?1",
            params![request.bot_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(error_text)?;
    let Some(bot_version) = bot_version else {
        return Err("That bot is no longer available on this Mac.".into());
    };
    if body.bot_snapshot.get("version").and_then(Value::as_i64) != Some(bot_version) {
        return Err("The bot changed before this routine was reviewed. Try again.".into());
    }
    if transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM routines WHERE id = ?1)",
            params![request.id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(error_text)?
    {
        return Err("That event routine already exists.".into());
    }
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM routines WHERE trigger_kind = 'project-change'",
            [],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if count >= MAX_EVENT_ROUTINES {
        return Err(
            "This Mac already has 32 project-change routines. Remove one before adding another."
                .into(),
        );
    }
    let body_json = serde_json::to_string(&body).map_err(error_text)?;
    let sealed = state
        .cipher()
        .seal(&routine_version_context(&request.id, 1), &body_json)?;
    transaction
        .execute(
            "INSERT INTO routines
                (id, bot_id, current_version, title, enabled, created_at, updated_at,
                 trigger_kind, paused_reason)
             VALUES (?1, ?2, 1, ?3, 0, ?4, ?4, 'project-change', NULL)",
            params![request.id, request.bot_id, request.title.trim(), created_at],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO routine_versions (routine_id, version, body_json, created_at)
             VALUES (?1, 1, ?2, ?3)",
            params![request.id, sealed, created_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_routine(state, &request.id)?
        .ok_or_else(|| "The event routine could not be reloaded after saving.".into())
}

pub fn set_local_event_routine_enabled(
    state: &AppState,
    request: SetLocalEventRoutineEnabledRequest,
) -> Result<LocalEventRoutine, String> {
    validate_identifier(&request.id, "event routine")?;
    if request.enabled && request.fingerprint.is_none() {
        return Err("Capture the current project before starting this routine.".into());
    }
    if let Some(fingerprint) = &request.fingerprint {
        validate_fingerprint(fingerprint)?;
    }
    let now = canonical_now();
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let routine = load_routine_from_connection(state, &transaction, &request.id)?
        .ok_or_else(|| "That project-change routine is no longer available.".to_string())?;
    if request.enabled
        && !crate::storage::bot_allows_background_routine(
            state,
            &transaction,
            &routine.bot_id,
            &request.id,
        )?
    {
        return Err("Review this routine with its bot before starting background work.".into());
    }
    let changed = transaction
        .execute(
            "UPDATE routines
             SET enabled = ?2, paused_reason = NULL, updated_at = ?3
             WHERE id = ?1 AND trigger_kind = 'project-change'",
            params![request.id, request.enabled, now],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("That project-change routine is no longer available.".into());
    }
    if let Some(fingerprint) = request.fingerprint {
        transaction
            .execute(
                "INSERT INTO event_routine_state
                    (routine_id, baseline_sha256, pending_sha256, pending_since,
                     last_checked_at, last_file_count, last_truncated, sequence)
                 VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, 0)
                 ON CONFLICT(routine_id) DO UPDATE SET
                    baseline_sha256 = excluded.baseline_sha256,
                    pending_sha256 = NULL,
                    pending_since = NULL,
                    last_checked_at = excluded.last_checked_at,
                    last_file_count = excluded.last_file_count,
                    last_truncated = excluded.last_truncated",
                params![
                    request.id,
                    fingerprint.sha256,
                    now,
                    fingerprint.file_count,
                    fingerprint.truncated,
                ],
            )
            .map_err(error_text)?;
    }
    if !request.enabled {
        transaction
            .execute(
                "UPDATE event_routine_occurrences
                 SET status = 'canceled', claim_owner = NULL, claim_token = NULL,
                     lease_expires_at = NULL, next_attempt_at = NULL,
                     completed_at = ?2, updated_at = ?2
                 WHERE routine_id = ?1 AND status IN ('claimed', 'running', 'retry')",
                params![request.id, now],
            )
            .map_err(error_text)?;
    }
    transaction.commit().map_err(error_text)?;
    load_routine(state, &request.id)?
        .ok_or_else(|| "The event routine could not be reloaded after changing it.".into())
}

pub fn delete_local_event_routine(state: &AppState, id: &str) -> Result<(), String> {
    validate_identifier(id, "event routine")?;
    let changed = state
        .connection()?
        .execute(
            "DELETE FROM routines WHERE id = ?1 AND trigger_kind = 'project-change'",
            params![id],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("That project-change routine is no longer available.".into());
    }
    Ok(())
}

pub fn claim_changed_event_routines(
    state: &AppState,
    request: ClaimChangedEventRoutinesRequest,
) -> Result<Vec<ClaimedEventRoutineOccurrence>, String> {
    validate_label(&request.owner, 120, "routine worker")?;
    validate_fingerprint(&request.fingerprint)?;
    if request.limit == 0 || request.limit > 4 {
        return Err("Claim between one and four project-change routines at a time.".into());
    }
    claim_changed_event_routines_at(state, request, Utc::now())
}

fn claim_changed_event_routines_at(
    state: &AppState,
    request: ClaimChangedEventRoutinesRequest,
    now: DateTime<Utc>,
) -> Result<Vec<ClaimedEventRoutineOccurrence>, String> {
    let now_text = canonical_time_value(now);
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let routine_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT id FROM routines
                 WHERE enabled = 1 AND trigger_kind = 'project-change'
                 ORDER BY updated_at ASC, id ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    let mut claims = Vec::new();
    for routine_id in routine_ids {
        if claims.len() >= request.limit {
            break;
        }
        if let Some(meta) = claim_retry(
            state,
            &transaction,
            &routine_id,
            &request.owner,
            &request.fingerprint,
            now,
        )? {
            claims.push(meta);
            continue;
        }
        if active_occurrence_exists(&transaction, &routine_id)? {
            touch_state(&transaction, &routine_id, &request.fingerprint, &now_text)?;
            continue;
        }
        let Some(routine) = load_routine_from_connection(state, &transaction, &routine_id)? else {
            continue;
        };
        let state_row: Option<EventRoutineStateRow> = transaction
            .query_row(
                "SELECT baseline_sha256, pending_sha256, pending_since,
                        last_triggered_at, sequence
                 FROM event_routine_state WHERE routine_id = ?1",
                params![routine_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(error_text)?;
        let Some((baseline, pending, pending_since, last_triggered_at, sequence)) = state_row
        else {
            transaction
                .execute(
                    "INSERT INTO event_routine_state
                        (routine_id, baseline_sha256, last_checked_at, last_file_count,
                         last_truncated, sequence)
                     VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                    params![
                        routine_id,
                        request.fingerprint.sha256,
                        now_text,
                        request.fingerprint.file_count,
                        request.fingerprint.truncated,
                    ],
                )
                .map_err(error_text)?;
            continue;
        };
        let Some(baseline) = baseline else {
            transaction
                .execute(
                    "UPDATE event_routine_state
                     SET baseline_sha256 = ?2, pending_sha256 = NULL, pending_since = NULL,
                         last_checked_at = ?3, last_file_count = ?4, last_truncated = ?5
                     WHERE routine_id = ?1",
                    params![
                        routine_id,
                        request.fingerprint.sha256,
                        now_text,
                        request.fingerprint.file_count,
                        request.fingerprint.truncated,
                    ],
                )
                .map_err(error_text)?;
            continue;
        };
        if baseline == request.fingerprint.sha256 {
            transaction
                .execute(
                    "UPDATE event_routine_state
                     SET pending_sha256 = NULL, pending_since = NULL, last_checked_at = ?2,
                         last_file_count = ?3, last_truncated = ?4
                     WHERE routine_id = ?1",
                    params![
                        routine_id,
                        now_text,
                        request.fingerprint.file_count,
                        request.fingerprint.truncated,
                    ],
                )
                .map_err(error_text)?;
            continue;
        }
        if pending.as_deref() != Some(request.fingerprint.sha256.as_str()) {
            transaction
                .execute(
                    "UPDATE event_routine_state
                     SET pending_sha256 = ?2, pending_since = ?3, last_checked_at = ?3,
                         last_file_count = ?4, last_truncated = ?5
                     WHERE routine_id = ?1",
                    params![
                        routine_id,
                        request.fingerprint.sha256,
                        now_text,
                        request.fingerprint.file_count,
                        request.fingerprint.truncated,
                    ],
                )
                .map_err(error_text)?;
            continue;
        }
        let stable_since = pending_since
            .as_deref()
            .map(|value| parse_time(value, "pending project change"))
            .transpose()?
            .unwrap_or(now);
        if now - stable_since < Duration::seconds(i64::from(routine.trigger.debounce_seconds)) {
            touch_state(&transaction, &routine_id, &request.fingerprint, &now_text)?;
            continue;
        }
        if let Some(last_triggered_at) = last_triggered_at {
            let last_triggered = parse_time(&last_triggered_at, "last routine trigger")?;
            if now - last_triggered < Duration::minutes(i64::from(routine.trigger.cooldown_minutes))
            {
                touch_state(&transaction, &routine_id, &request.fingerprint, &now_text)?;
                continue;
            }
        }
        let next_sequence = sequence + 1;
        let idempotency_key = format!("event-{routine_id}-{}-{next_sequence}", routine.version);
        let claim_token = random_token()?;
        let run_id = deterministic_run_id(&idempotency_key);
        transaction
            .execute(
                "INSERT INTO event_routine_occurrences
                    (idempotency_key, routine_id, routine_version, observed_at,
                     previous_fingerprint, fingerprint, status, claim_owner, claim_token,
                     lease_expires_at, attempt, run_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'claimed', ?7, ?8, ?9, 1, ?10, ?4, ?4)",
                params![
                    idempotency_key,
                    routine_id,
                    routine.version,
                    now_text,
                    baseline,
                    request.fingerprint.sha256,
                    request.owner,
                    claim_token,
                    canonical_time_value(now + Duration::minutes(CLAIM_LEASE_MINUTES)),
                    run_id,
                ],
            )
            .map_err(error_text)?;
        transaction
            .execute(
                "UPDATE event_routine_state
                 SET sequence = ?2, last_checked_at = ?3, last_file_count = ?4,
                     last_truncated = ?5
                 WHERE routine_id = ?1",
                params![
                    routine_id,
                    next_sequence,
                    now_text,
                    request.fingerprint.file_count,
                    request.fingerprint.truncated,
                ],
            )
            .map_err(error_text)?;
        claims.push(ClaimMeta {
            idempotency_key,
            claim_token,
            routine_id,
            observed_at: now_text.clone(),
            attempt: 1,
            run_id,
            previous_fingerprint: baseline,
            fingerprint: request.fingerprint.sha256.clone(),
        });
    }
    transaction.commit().map_err(error_text)?;
    claims
        .into_iter()
        .map(|meta| claim_from_meta(state, meta))
        .collect()
}

pub fn mark_event_routine_occurrence_running(
    state: &AppState,
    idempotency_key: &str,
    claim_token: &str,
) -> Result<EventRoutineOccurrenceStatus, String> {
    transition_claim(state, idempotency_key, claim_token, "running")
}

pub fn renew_event_routine_occurrence_lease(
    state: &AppState,
    idempotency_key: &str,
    claim_token: &str,
) -> Result<EventRoutineOccurrenceStatus, String> {
    validate_identifier(idempotency_key, "event occurrence")?;
    validate_claim_token(claim_token)?;
    let now = Utc::now();
    let changed = state
        .connection()?
        .execute(
            "UPDATE event_routine_occurrences
             SET lease_expires_at = ?3, updated_at = ?4
             WHERE idempotency_key = ?1 AND claim_token = ?2
               AND status IN ('claimed', 'running')",
            params![
                idempotency_key,
                claim_token,
                canonical_time_value(now + Duration::minutes(CLAIM_LEASE_MINUTES)),
                canonical_time_value(now),
            ],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("This project-change claim is stale or no longer runnable.".into());
    }
    load_occurrence_status(state, idempotency_key)?
        .ok_or_else(|| "The project-change occurrence no longer exists.".into())
}

pub fn event_routine_execution_permitted(
    state: &AppState,
    idempotency_key: &str,
    claim_token: &str,
) -> Result<bool, String> {
    validate_identifier(idempotency_key, "event occurrence")?;
    validate_claim_token(claim_token)?;
    state
        .connection()?
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM event_routine_occurrences o
                JOIN routines r ON r.id = o.routine_id
                WHERE o.idempotency_key = ?1 AND o.claim_token = ?2
                  AND o.status IN ('claimed', 'running')
                  AND r.enabled = 1 AND r.trigger_kind = 'project-change'
                  AND r.current_version = o.routine_version
             )",
            params![idempotency_key, claim_token],
            |row| row.get(0),
        )
        .map_err(error_text)
}

pub fn finish_event_routine_occurrence(
    state: &AppState,
    request: FinishEventRoutineOccurrenceRequest,
) -> Result<EventRoutineOccurrenceStatus, String> {
    if !matches!(
        request.outcome.as_str(),
        "completed" | "failed" | "paused" | "approval-required"
    ) {
        return Err(
            "Event routine outcome must be completed, failed, paused, or approval required.".into(),
        );
    }
    validate_identifier(&request.idempotency_key, "event occurrence")?;
    validate_claim_token(&request.claim_token)?;
    if request
        .detail
        .as_deref()
        .is_some_and(|value| value.len() > 500 || value.chars().any(char::is_control))
    {
        return Err("Event routine outcome detail is invalid.".into());
    }
    finish_event_routine_occurrence_at(state, request, Utc::now())
}

pub fn pause_all_event_claims(state: &AppState, reason: &str) -> Result<(), String> {
    validate_label(reason, 240, "routine pause reason")?;
    let now = canonical_now();
    let detail = encrypt_detail(state, "background-paused", Some(reason))?;
    state
        .connection()?
        .execute(
            "UPDATE event_routine_occurrences
             SET status = 'paused', claim_owner = NULL, claim_token = NULL,
                 lease_expires_at = NULL, next_attempt_at = NULL, pause_reason = ?1,
                 detail_json = ?2, updated_at = ?3
             WHERE status IN ('claimed', 'running', 'retry')",
            params![reason, detail, now],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn defer_all_event_claims(state: &AppState, reason: &str) -> Result<(), String> {
    defer_all_event_claims_at(state, reason, Utc::now())
}

fn defer_all_event_claims_at(
    state: &AppState,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    validate_label(reason, 240, "routine pause reason")?;
    let now = canonical_time_value(now);
    let detail = encrypt_detail(state, "autonomy-paused", Some(reason))?;
    state
        .connection()?
        .execute(
            "UPDATE event_routine_occurrences
             SET status = 'paused', claim_owner = NULL, claim_token = NULL,
                 lease_expires_at = NULL, next_attempt_at = ?1, pause_reason = ?2,
                 detail_json = ?3, updated_at = ?1
             WHERE status IN ('claimed', 'running', 'retry', 'paused')",
            params![now, reason, detail],
        )
        .map_err(error_text)?;
    Ok(())
}

fn finish_event_routine_occurrence_at(
    state: &AppState,
    request: FinishEventRoutineOccurrenceRequest,
    now: DateTime<Utc>,
) -> Result<EventRoutineOccurrenceStatus, String> {
    let now_text = canonical_time_value(now);
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let row: Option<(String, u8, String, String)> = transaction
        .query_row(
            "SELECT routine_id, attempt, status, fingerprint
             FROM event_routine_occurrences
             WHERE idempotency_key = ?1 AND claim_token = ?2",
            params![request.idempotency_key, request.claim_token],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(error_text)?;
    let Some((routine_id, attempt, current_status, fingerprint)) = row else {
        return Err("This project-change claim is stale or no longer exists.".into());
    };
    if !matches!(current_status.as_str(), "claimed" | "running") {
        return Err("This project-change occurrence is no longer running.".into());
    }
    let routine =
        load_routine_from_connection(state, &transaction, &routine_id)?.ok_or_else(|| {
            "The project-change routine was deleted while it was running.".to_string()
        })?;
    let detail = encrypt_detail(state, &request.idempotency_key, request.detail.as_deref())?;
    if !routine.enabled {
        finish_occurrence(
            &transaction,
            &request,
            "canceled",
            None,
            None,
            detail,
            &now_text,
        )?;
    } else if request.outcome == "completed" {
        finish_occurrence(
            &transaction,
            &request,
            "completed",
            None,
            None,
            detail,
            &now_text,
        )?;
        transaction
            .execute(
                "UPDATE event_routine_state
                 SET baseline_sha256 = ?2, pending_sha256 = NULL, pending_since = NULL,
                     last_triggered_at = ?3
                 WHERE routine_id = ?1",
                params![routine_id, fingerprint, now_text],
            )
            .map_err(error_text)?;
        transaction
            .execute(
                "UPDATE routines SET paused_reason = NULL, updated_at = ?2 WHERE id = ?1",
                params![routine_id, now_text],
            )
            .map_err(error_text)?;
    } else if request.outcome == "failed" && attempt <= routine.budget.max_retries {
        let next_attempt = canonical_time_value(now + Duration::minutes(i64::from(attempt) * 5));
        finish_occurrence(
            &transaction,
            &request,
            "retry",
            Some(next_attempt),
            None,
            detail,
            &now_text,
        )?;
    } else {
        let reason = request
            .detail
            .as_deref()
            .unwrap_or("The project-change routine needs attention.");
        let status = if matches!(request.outcome.as_str(), "paused" | "approval-required") {
            "paused"
        } else {
            "failed"
        };
        finish_occurrence(
            &transaction,
            &request,
            status,
            None,
            Some(reason),
            detail,
            &now_text,
        )?;
        transaction
            .execute(
                "UPDATE routines SET enabled = 0, paused_reason = ?2, updated_at = ?3
                 WHERE id = ?1",
                params![routine_id, reason, now_text],
            )
            .map_err(error_text)?;
    }
    prune_occurrences(&transaction, &routine_id)?;
    transaction.commit().map_err(error_text)?;
    load_occurrence_status(state, &request.idempotency_key)?
        .ok_or_else(|| "The project-change occurrence no longer exists.".into())
}

fn finish_occurrence(
    transaction: &rusqlite::Transaction<'_>,
    request: &FinishEventRoutineOccurrenceRequest,
    status: &str,
    next_attempt_at: Option<String>,
    pause_reason: Option<&str>,
    detail: Option<String>,
    now: &str,
) -> Result<(), String> {
    let completed_at = if matches!(status, "completed" | "failed" | "canceled") {
        Some(now)
    } else {
        None
    };
    let changed = transaction
        .execute(
            "UPDATE event_routine_occurrences
             SET status = ?3, claim_owner = NULL, claim_token = NULL,
                 lease_expires_at = NULL, next_attempt_at = ?4, pause_reason = ?5,
                 detail_json = ?6, completed_at = ?7, updated_at = ?8
             WHERE idempotency_key = ?1 AND claim_token = ?2",
            params![
                request.idempotency_key,
                request.claim_token,
                status,
                next_attempt_at,
                pause_reason,
                detail,
                completed_at,
                now,
            ],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("This project-change occurrence changed before it could finish.".into());
    }
    Ok(())
}

fn claim_retry(
    state: &AppState,
    transaction: &rusqlite::Transaction<'_>,
    routine_id: &str,
    owner: &str,
    fingerprint: &LocalProjectFingerprint,
    now: DateTime<Utc>,
) -> Result<Option<ClaimMeta>, String> {
    let now_text = canonical_time_value(now);
    let row: Option<(String, String, String, String, String, u8)> = transaction
        .query_row(
            "SELECT idempotency_key, observed_at, run_id, previous_fingerprint,
                    fingerprint, attempt
             FROM event_routine_occurrences
             WHERE routine_id = ?1 AND (
                (status IN ('retry', 'paused') AND next_attempt_at <= ?2)
                OR (status IN ('claimed', 'running') AND lease_expires_at <= ?2)
             )
             ORDER BY updated_at ASC LIMIT 1",
            params![routine_id, now_text],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(error_text)?;
    let Some((key, observed_at, run_id, previous_fingerprint, expected_fingerprint, attempt)) = row
    else {
        return Ok(None);
    };
    if expected_fingerprint != fingerprint.sha256 {
        transaction
            .execute(
                "UPDATE event_routine_occurrences
                 SET status = 'canceled', claim_owner = NULL, claim_token = NULL,
                     lease_expires_at = NULL, completed_at = ?2, updated_at = ?2
                 WHERE idempotency_key = ?1",
                params![key, now_text],
            )
            .map_err(error_text)?;
        return Ok(None);
    }
    let routine = load_routine_from_connection(state, transaction, routine_id)?
        .ok_or_else(|| "The project-change routine is no longer available.".to_string())?;
    if attempt >= routine.budget.max_retries.saturating_add(1) {
        return Ok(None);
    }
    let claim_token = random_token()?;
    let next_attempt = attempt.saturating_add(1);
    let changed = transaction
        .execute(
            "UPDATE event_routine_occurrences
             SET status = 'claimed', claim_owner = ?2, claim_token = ?3,
                 lease_expires_at = ?4, attempt = ?5, next_attempt_at = NULL,
                 pause_reason = NULL, updated_at = ?6
             WHERE idempotency_key = ?1 AND (
                (status IN ('retry', 'paused') AND next_attempt_at <= ?6)
                OR (status IN ('claimed', 'running') AND lease_expires_at <= ?6)
             )",
            params![
                key,
                owner,
                claim_token,
                canonical_time_value(now + Duration::minutes(CLAIM_LEASE_MINUTES)),
                next_attempt,
                now_text,
            ],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Ok(None);
    }
    Ok(Some(ClaimMeta {
        idempotency_key: key,
        claim_token,
        routine_id: routine_id.to_string(),
        observed_at,
        attempt: next_attempt,
        run_id,
        previous_fingerprint,
        fingerprint: expected_fingerprint,
    }))
}

fn transition_claim(
    state: &AppState,
    idempotency_key: &str,
    claim_token: &str,
    status: &str,
) -> Result<EventRoutineOccurrenceStatus, String> {
    validate_identifier(idempotency_key, "event occurrence")?;
    validate_claim_token(claim_token)?;
    let now = Utc::now();
    let changed = state
        .connection()?
        .execute(
            "UPDATE event_routine_occurrences
             SET status = ?3, lease_expires_at = ?4, updated_at = ?5
             WHERE idempotency_key = ?1 AND claim_token = ?2 AND status = 'claimed'",
            params![
                idempotency_key,
                claim_token,
                status,
                canonical_time_value(now + Duration::minutes(CLAIM_LEASE_MINUTES)),
                canonical_time_value(now),
            ],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("This project-change claim is stale or no longer runnable.".into());
    }
    load_occurrence_status(state, idempotency_key)?
        .ok_or_else(|| "The project-change occurrence no longer exists.".into())
}

fn claim_from_meta(
    state: &AppState,
    meta: ClaimMeta,
) -> Result<ClaimedEventRoutineOccurrence, String> {
    let routine = load_routine(state, &meta.routine_id)?
        .ok_or_else(|| "The claimed project-change routine no longer exists.".to_string())?;
    Ok(ClaimedEventRoutineOccurrence {
        idempotency_key: meta.idempotency_key,
        claim_token: meta.claim_token,
        observed_at: meta.observed_at,
        attempt: meta.attempt,
        run_id: meta.run_id,
        previous_fingerprint: meta.previous_fingerprint,
        fingerprint: meta.fingerprint,
        routine,
    })
}

fn load_routine(state: &AppState, id: &str) -> Result<Option<LocalEventRoutine>, String> {
    let connection = state.connection()?;
    load_routine_from_connection(state, &connection, id)
}

fn load_routine_from_connection(
    state: &AppState,
    connection: &Connection,
    id: &str,
) -> Result<Option<LocalEventRoutine>, String> {
    let row = connection
        .query_row(
            "SELECT r.id, r.bot_id, b.thread_id, r.current_version, r.title, r.enabled,
                    r.paused_reason, v.body_json, r.created_at, r.updated_at,
                    s.last_checked_at, s.last_triggered_at,
                    (SELECT o.status FROM event_routine_occurrences o
                     WHERE o.routine_id = r.id ORDER BY o.updated_at DESC LIMIT 1),
                    s.last_file_count, s.last_truncated
             FROM routines r
             JOIN bots b ON b.id = r.bot_id
             JOIN routine_versions v
               ON v.routine_id = r.id AND v.version = r.current_version
             LEFT JOIN event_routine_state s ON s.routine_id = r.id
             WHERE r.id = ?1 AND r.trigger_kind = 'project-change'",
            params![id],
            routine_row_from_sql,
        )
        .optional()
        .map_err(error_text)?;
    row.map(|row| open_routine(state, row)).transpose()
}

fn routine_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoutineRow> {
    Ok(RoutineRow {
        id: row.get(0)?,
        bot_id: row.get(1)?,
        thread_id: row.get(2)?,
        version: row.get(3)?,
        title: row.get(4)?,
        enabled: row.get(5)?,
        paused_reason: row.get(6)?,
        body_json: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        last_checked_at: row.get(10)?,
        last_triggered_at: row.get(11)?,
        last_outcome: row.get(12)?,
        last_file_count: row.get(13)?,
        last_truncated: row.get(14)?,
    })
}

fn open_routine(state: &AppState, row: RoutineRow) -> Result<LocalEventRoutine, String> {
    let plaintext = state.cipher().open(
        &routine_version_context(&row.id, row.version),
        &row.body_json,
    )?;
    let body: EventRoutineBody = serde_json::from_str(&plaintext).map_err(error_text)?;
    validate_body(&body, &row.bot_id)?;
    Ok(LocalEventRoutine {
        id: row.id,
        version: row.version,
        bot_id: row.bot_id,
        thread_id: row.thread_id,
        title: row.title,
        enabled: row.enabled,
        prompt: body.prompt,
        trigger: body.trigger,
        budget: body.budget,
        provider: body.provider,
        model: body.model,
        requires_network: body.requires_network,
        bot_snapshot: body.bot_snapshot,
        memory_snapshot_hash: body.memory_snapshot_hash,
        skill_versions: body.skill_versions,
        created_at: row.created_at,
        updated_at: row.updated_at,
        paused_reason: row.paused_reason,
        last_checked_at: row.last_checked_at,
        last_triggered_at: row.last_triggered_at,
        last_outcome: row.last_outcome,
        last_file_count: row.last_file_count,
        last_truncated: row.last_truncated,
    })
}

fn load_occurrence_status(
    state: &AppState,
    idempotency_key: &str,
) -> Result<Option<EventRoutineOccurrenceStatus>, String> {
    state
        .connection()?
        .query_row(
            "SELECT idempotency_key, routine_id, status, attempt, observed_at,
                    next_attempt_at, pause_reason, run_id, updated_at
             FROM event_routine_occurrences WHERE idempotency_key = ?1",
            params![idempotency_key],
            |row| {
                Ok(EventRoutineOccurrenceStatus {
                    idempotency_key: row.get(0)?,
                    routine_id: row.get(1)?,
                    status: row.get(2)?,
                    attempt: row.get(3)?,
                    observed_at: row.get(4)?,
                    next_attempt_at: row.get(5)?,
                    pause_reason: row.get(6)?,
                    run_id: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(error_text)
}

fn active_occurrence_exists(
    transaction: &rusqlite::Transaction<'_>,
    routine_id: &str,
) -> Result<bool, String> {
    transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM event_routine_occurrences
                WHERE routine_id = ?1 AND status IN ('claimed', 'running', 'retry', 'paused')
             )",
            params![routine_id],
            |row| row.get(0),
        )
        .map_err(error_text)
}

fn touch_state(
    transaction: &rusqlite::Transaction<'_>,
    routine_id: &str,
    fingerprint: &LocalProjectFingerprint,
    now: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE event_routine_state
             SET last_checked_at = ?2, last_file_count = ?3, last_truncated = ?4
             WHERE routine_id = ?1",
            params![
                routine_id,
                now,
                fingerprint.file_count,
                fingerprint.truncated
            ],
        )
        .map_err(error_text)?;
    Ok(())
}

fn prune_occurrences(
    transaction: &rusqlite::Transaction<'_>,
    routine_id: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM event_routine_occurrences
             WHERE routine_id = ?1 AND idempotency_key IN (
                SELECT idempotency_key FROM event_routine_occurrences
                WHERE routine_id = ?1 AND status IN ('completed', 'failed', 'canceled')
                ORDER BY updated_at DESC LIMIT -1 OFFSET ?2
             )",
            params![routine_id, MAX_EVENT_OCCURRENCES_PER_ROUTINE],
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

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 180
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
    {
        return Err(format!("Invalid {label} identifier."));
    }
    Ok(())
}

fn validate_label(value: &str, max_length: usize, label: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_length || value.chars().any(char::is_control) {
        return Err(format!("The local {label} is invalid."));
    }
    Ok(())
}

fn validate_trigger(trigger: &EventRoutineTrigger) -> Result<(), String> {
    if trigger.kind != "project-change"
        || !(10..=300).contains(&trigger.debounce_seconds)
        || !(1..=1_440).contains(&trigger.cooldown_minutes)
    {
        return Err("The project-change trigger is outside its safe timing bounds.".into());
    }
    validate_label(&trigger.label, 120, "routine trigger")
}

fn validate_budget(budget: &EventRoutineBudget) -> Result<(), String> {
    if !(1..=16).contains(&budget.max_actions) || budget.max_retries > 5 {
        return Err("The event routine budget is outside its safe limits.".into());
    }
    Ok(())
}

fn validate_bot_snapshot(snapshot: &Value, bot_id: &str) -> Result<(), String> {
    if snapshot.get("schemaVersion").and_then(Value::as_i64) != Some(1)
        || snapshot.get("botId").and_then(Value::as_str) != Some(bot_id)
        || snapshot
            .get("version")
            .and_then(Value::as_i64)
            .is_none_or(|value| value < 1)
        || !snapshot
            .get("permissionPolicy")
            .is_some_and(Value::is_object)
        || !snapshot.get("goal").is_some_and(Value::is_object)
    {
        return Err("The event routine's reviewed bot snapshot is invalid.".into());
    }
    Ok(())
}

fn validate_snapshot_hash(value: &str, label: &str) -> Result<(), String> {
    if value != "none" && (value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(format!("The event routine {label} is invalid."));
    }
    Ok(())
}

fn validate_skill_versions(values: &BTreeMap<String, i64>) -> Result<(), String> {
    if values.len() > 16 {
        return Err("An event routine can pin at most 16 skills.".into());
    }
    let mut seen = HashSet::new();
    for (id, version) in values {
        validate_identifier(id, "routine skill")?;
        if *version < 1 || !seen.insert(id) {
            return Err("An event routine has an invalid skill version.".into());
        }
    }
    Ok(())
}

fn validate_body(body: &EventRoutineBody, bot_id: &str) -> Result<(), String> {
    if body.schema_version != 1 {
        return Err("This project-change routine version is unsupported.".into());
    }
    validate_label(&body.prompt, 4_000, "routine task")?;
    validate_trigger(&body.trigger)?;
    validate_budget(&body.budget)?;
    validate_label(&body.provider, 80, "routine provider")?;
    validate_label(&body.model, 180, "routine model")?;
    validate_bot_snapshot(&body.bot_snapshot, bot_id)?;
    validate_snapshot_hash(&body.memory_snapshot_hash, "memory snapshot")?;
    validate_skill_versions(&body.skill_versions)?;
    canonical_time(&body.created_at, "routine creation time")?;
    Ok(())
}

pub(crate) fn validate_archived_event_routine_body(
    bot_id: &str,
    body: &Value,
) -> Result<(), String> {
    let decoded: EventRoutineBody = serde_json::from_value(body.clone())
        .map_err(|_| "An archived project-change routine body is invalid.".to_string())?;
    validate_body(&decoded, bot_id)
}

pub(crate) fn archived_event_routine_context(id: &str, version: i64) -> String {
    routine_version_context(id, version)
}

fn validate_fingerprint(value: &LocalProjectFingerprint) -> Result<(), String> {
    validate_snapshot_hash(&value.sha256, "project fingerprint")?;
    if value.file_count > 10_000 {
        return Err("The project fingerprint exceeds its bounded file count.".into());
    }
    canonical_time(&value.captured_at, "project fingerprint time")?;
    Ok(())
}

fn validate_claim_token(value: &str) -> Result<(), String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The event routine claim token is invalid.".into());
    }
    Ok(())
}

fn canonical_time(value: &str, label: &str) -> Result<String, String> {
    parse_time(value, label).map(canonical_time_value)
}

fn parse_time(value: &str, label: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|_| format!("The {label} is invalid."))
}

fn canonical_time_value(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn canonical_now() -> String {
    canonical_time_value(Utc::now())
}

fn routine_version_context(id: &str, version: i64) -> String {
    format!("routine-versions:{id}:{version}")
}

fn occurrence_detail_context(id: &str) -> String {
    format!("event-routine-occurrences:{id}:detail")
}

fn encrypt_detail(
    state: &AppState,
    id: &str,
    detail: Option<&str>,
) -> Result<Option<String>, String> {
    detail
        .map(|value| state.cipher().seal(&occurrence_detail_context(id), value))
        .transpose()
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    fill_random(&mut bytes)
        .map_err(|_| "Could not create an event routine claim token.".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn deterministic_run_id(idempotency_key: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(idempotency_key.as_bytes()));
    format!("eventrun-{}", &digest[..32])
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage;
    use serde_json::json;
    use tempfile::tempdir;

    fn fingerprint(hash: char, captured_at: &str) -> LocalProjectFingerprint {
        LocalProjectFingerprint {
            sha256: hash.to_string().repeat(64),
            file_count: 12,
            truncated: false,
            captured_at: captured_at.into(),
        }
    }

    fn save_request(
        bot: &storage::LocalBotRecord,
        created_at: &str,
    ) -> SaveLocalEventRoutineRequest {
        SaveLocalEventRoutineRequest {
            id: "routine-project-change".into(),
            bot_id: bot.id.clone(),
            title: "Summarize project changes".into(),
            prompt: "Summarize the material project changes and cite the affected files.".into(),
            trigger: EventRoutineTrigger {
                kind: "project-change".into(),
                label: "When this project changes".into(),
                debounce_seconds: 30,
                cooldown_minutes: 1,
            },
            budget: EventRoutineBudget {
                max_actions: 4,
                max_retries: 1,
            },
            provider: "codex".into(),
            model: "default".into(),
            requires_network: false,
            bot_snapshot: serde_json::to_value(bot.spec.clone()).expect("bot snapshot"),
            memory_snapshot_hash: "none".into(),
            skill_versions: BTreeMap::new(),
            created_at: created_at.into(),
        }
    }

    fn authorize_background(state: &AppState, bot_id: &str, routine_id: &str, at: &str) {
        storage::update_local_bot_routines(
            state,
            storage::UpdateLocalBotRoutinesRequest {
                id: bot_id.into(),
                routine_ids: vec![routine_id.into()],
                allow_background: true,
                updated_at: at.into(),
            },
        )
        .expect("background routine authorized");
    }

    #[test]
    fn project_change_routine_debounces_deduplicates_and_retries() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let catalog = storage::bootstrap_local_bots(&state).expect("bots");
        let bot = catalog.active_bot;
        let start = "2026-08-19T12:00:00.000Z";
        let saved = save_local_event_routine(&state, save_request(&bot, start)).expect("routine");
        assert!(!saved.enabled);
        authorize_background(&state, &bot.id, &saved.id, start);
        let stored: String = state
            .connection()
            .expect("connection")
            .query_row(
                "SELECT body_json FROM routine_versions WHERE routine_id = ?1",
                params![saved.id],
                |row| row.get(0),
            )
            .expect("stored body");
        assert!(crate::crypto::DataCipher::is_sealed(&stored));

        let baseline = fingerprint('a', start);
        let enabled = set_local_event_routine_enabled(
            &state,
            SetLocalEventRoutineEnabledRequest {
                id: saved.id.clone(),
                enabled: true,
                fingerprint: Some(baseline.clone()),
            },
        )
        .expect("enabled");
        assert!(enabled.enabled);

        let first_change_at = parse_time("2026-08-19T12:01:00.000Z", "test").expect("time");
        let changed = fingerprint('b', "2026-08-19T12:01:00.000Z");
        let request = ClaimChangedEventRoutinesRequest {
            owner: "test-worker".into(),
            fingerprint: changed.clone(),
            limit: 1,
        };
        assert!(
            claim_changed_event_routines_at(&state, request.clone(), first_change_at)
                .expect("first observation")
                .is_empty()
        );
        assert!(
            claim_changed_event_routines_at(
                &state,
                request.clone(),
                first_change_at + Duration::seconds(29),
            )
            .expect("debounced observation")
            .is_empty()
        );
        let claims = claim_changed_event_routines_at(
            &state,
            request.clone(),
            first_change_at + Duration::seconds(31),
        )
        .expect("stable change");
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].previous_fingerprint, baseline.sha256);
        assert_eq!(claims[0].fingerprint, changed.sha256);
        assert!(
            claim_changed_event_routines_at(
                &state,
                request.clone(),
                first_change_at + Duration::seconds(40),
            )
            .expect("deduplicated claim")
            .is_empty()
        );

        let claim = &claims[0];
        mark_event_routine_occurrence_running(&state, &claim.idempotency_key, &claim.claim_token)
            .expect("running");
        let failed = finish_event_routine_occurrence_at(
            &state,
            FinishEventRoutineOccurrenceRequest {
                idempotency_key: claim.idempotency_key.clone(),
                claim_token: claim.claim_token.clone(),
                outcome: "failed".into(),
                detail: Some("Temporary provider interruption".into()),
            },
            first_change_at + Duration::seconds(45),
        )
        .expect("retry scheduled");
        assert_eq!(failed.status, "retry");

        let retry = claim_changed_event_routines_at(
            &state,
            request.clone(),
            first_change_at + Duration::minutes(6),
        )
        .expect("retry claim");
        assert_eq!(retry.len(), 1);
        assert_eq!(retry[0].idempotency_key, claim.idempotency_key);
        assert_eq!(retry[0].attempt, 2);
        mark_event_routine_occurrence_running(
            &state,
            &retry[0].idempotency_key,
            &retry[0].claim_token,
        )
        .expect("retry running");
        let completed = finish_event_routine_occurrence_at(
            &state,
            FinishEventRoutineOccurrenceRequest {
                idempotency_key: retry[0].idempotency_key.clone(),
                claim_token: retry[0].claim_token.clone(),
                outcome: "completed".into(),
                detail: Some("Change summarized".into()),
            },
            first_change_at + Duration::minutes(6) + Duration::seconds(5),
        )
        .expect("completed");
        assert_eq!(completed.status, "completed");
        assert!(
            claim_changed_event_routines_at(
                &state,
                request,
                first_change_at + Duration::minutes(8),
            )
            .expect("same fingerprint")
            .is_empty()
        );
    }

    #[test]
    fn disabling_project_change_routine_revokes_its_active_claim() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let bot = storage::bootstrap_local_bots(&state)
            .expect("bots")
            .active_bot;
        let created_at = "2026-08-19T12:00:00.000Z";
        let saved =
            save_local_event_routine(&state, save_request(&bot, created_at)).expect("routine");
        authorize_background(&state, &bot.id, &saved.id, created_at);
        set_local_event_routine_enabled(
            &state,
            SetLocalEventRoutineEnabledRequest {
                id: saved.id.clone(),
                enabled: true,
                fingerprint: Some(fingerprint('a', created_at)),
            },
        )
        .expect("enabled");
        let observed = parse_time("2026-08-19T12:01:00.000Z", "test").expect("time");
        let changed = fingerprint('b', "2026-08-19T12:01:00.000Z");
        let request = ClaimChangedEventRoutinesRequest {
            owner: "test-worker".into(),
            fingerprint: changed,
            limit: 1,
        };
        claim_changed_event_routines_at(&state, request.clone(), observed).expect("pending change");
        let claim =
            claim_changed_event_routines_at(&state, request, observed + Duration::seconds(31))
                .expect("claim")
                .remove(0);
        set_local_event_routine_enabled(
            &state,
            SetLocalEventRoutineEnabledRequest {
                id: saved.id,
                enabled: false,
                fingerprint: None,
            },
        )
        .expect("disabled");
        assert!(
            !event_routine_execution_permitted(&state, &claim.idempotency_key, &claim.claim_token,)
                .expect("permission")
        );
        assert_eq!(
            load_occurrence_status(&state, &claim.idempotency_key)
                .expect("status")
                .expect("occurrence")
                .status,
            "canceled"
        );
    }

    #[test]
    fn global_pause_preserves_and_reclaims_the_same_project_change() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let bot = storage::bootstrap_local_bots(&state)
            .expect("bots")
            .active_bot;
        let created_at = "2026-08-19T12:00:00.000Z";
        let saved =
            save_local_event_routine(&state, save_request(&bot, created_at)).expect("routine");
        authorize_background(&state, &bot.id, &saved.id, created_at);
        set_local_event_routine_enabled(
            &state,
            SetLocalEventRoutineEnabledRequest {
                id: saved.id,
                enabled: true,
                fingerprint: Some(fingerprint('a', created_at)),
            },
        )
        .expect("enabled");
        let observed = parse_time("2026-08-19T12:01:00.000Z", "test").expect("time");
        let request = ClaimChangedEventRoutinesRequest {
            owner: "test-worker".into(),
            fingerprint: fingerprint('b', "2026-08-19T12:01:00.000Z"),
            limit: 1,
        };
        claim_changed_event_routines_at(&state, request.clone(), observed).expect("pending change");
        let claim = claim_changed_event_routines_at(
            &state,
            request.clone(),
            observed + Duration::seconds(31),
        )
        .expect("claim")
        .remove(0);
        mark_event_routine_occurrence_running(&state, &claim.idempotency_key, &claim.claim_token)
            .expect("running");

        defer_all_event_claims_at(&state, "Paused by you.", observed + Duration::seconds(32))
            .expect("deferred");
        let paused = load_occurrence_status(&state, &claim.idempotency_key)
            .expect("status")
            .expect("occurrence");
        assert_eq!(paused.status, "paused");
        assert_eq!(paused.pause_reason.as_deref(), Some("Paused by you."));
        assert!(
            !event_routine_execution_permitted(&state, &claim.idempotency_key, &claim.claim_token)
                .expect("stale permission")
        );

        let resumed =
            claim_changed_event_routines_at(&state, request, observed + Duration::seconds(33))
                .expect("resumed claim");
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].idempotency_key, claim.idempotency_key);
        assert_eq!(resumed[0].attempt, 2);
    }

    #[test]
    fn project_change_routine_rejects_stale_or_unbounded_reviews() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let bot = storage::bootstrap_local_bots(&state)
            .expect("bots")
            .active_bot;
        let mut request = save_request(&bot, "2026-08-19T12:00:00.000Z");
        request.bot_snapshot["version"] = json!(bot.current_version + 1);
        assert!(
            save_local_event_routine(&state, request)
                .expect_err("stale bot snapshot rejected")
                .contains("changed before")
        );

        let mut request = save_request(&bot, "2026-08-19T12:00:00.000Z");
        request.budget.max_actions = 17;
        assert!(
            save_local_event_routine(&state, request)
                .expect_err("budget rejected")
                .contains("budget")
        );

        let saved =
            save_local_event_routine(&state, save_request(&bot, "2026-08-19T12:00:00.000Z"))
                .expect("reviewed routine");
        assert!(
            set_local_event_routine_enabled(
                &state,
                SetLocalEventRoutineEnabledRequest {
                    id: saved.id,
                    enabled: true,
                    fingerprint: Some(fingerprint('a', "2026-08-19T12:00:00.000Z")),
                },
            )
            .expect_err("background policy required")
            .contains("Review this routine")
        );
    }

    #[test]
    fn project_change_routine_restores_paused_without_folder_state() {
        let source_directory = tempdir().expect("source tempdir");
        let source = AppState::for_test(source_directory.path()).expect("source state");
        let bot = storage::bootstrap_local_bots(&source)
            .expect("source bots")
            .active_bot;
        let created_at = "2026-08-19T12:00:00.000Z";
        let saved = save_local_event_routine(&source, save_request(&bot, created_at))
            .expect("source routine");
        authorize_background(&source, &bot.id, &saved.id, created_at);
        set_local_event_routine_enabled(
            &source,
            SetLocalEventRoutineEnabledRequest {
                id: saved.id,
                enabled: true,
                fingerprint: Some(fingerprint('a', created_at)),
            },
        )
        .expect("source enabled");
        let archive = storage::export_workspace_archive(&source).expect("event routine archive");

        let target_directory = tempdir().expect("target tempdir");
        let target = AppState::for_test(target_directory.path()).expect("target state");
        storage::restore_workspace_archive(&target, &archive, true).expect("restored archive");
        let restored = list_local_event_routines(&target).expect("restored routines");
        assert_eq!(restored.len(), 1);
        assert!(!restored[0].enabled);
        assert_eq!(
            restored[0].paused_reason.as_deref(),
            Some("Choose a project and start this routine again.")
        );
        assert!(restored[0].last_checked_at.is_none());
        let connection = target.connection().expect("target connection");
        let body: String = connection
            .query_row(
                "SELECT body_json FROM routine_versions WHERE routine_id = ?1",
                params![restored[0].id],
                |row| row.get(0),
            )
            .expect("restored routine body");
        assert!(crate::crypto::DataCipher::is_sealed(&body));
        let state_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM event_routine_state", [], |row| {
                row.get(0)
            })
            .expect("event state count");
        assert_eq!(state_rows, 0);
    }
}
