use crate::storage::AppState;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const MAX_ACTIVE_DELEGATION_TARGETS: i64 = 2;
const MAX_DELEGATION_TARGETS: usize = 2;
const MAX_DELEGATIONS: i64 = 500;
const CAPACITY_ERROR_PREFIX: &str = "LOCAL_RUN_CAPACITY:";

type DelegationRow = (String, String, String, i64, String, String, String, String);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotDelegationTarget {
    pub bot_id: String,
    pub thread_id: String,
    pub bot_name: String,
    pub bot_version: i64,
    pub status: String,
    pub max_actions: u8,
    pub deadline_at: String,
    pub bot_snapshot: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotDelegation {
    pub id: String,
    pub parent_bot_id: String,
    pub parent_thread_id: String,
    pub parent_bot_name: String,
    pub parent_bot_version: i64,
    pub task: String,
    pub expected_output: String,
    pub shared_memory_snapshot_hash: String,
    pub status: String,
    pub max_parallel: u8,
    pub targets: Vec<LocalBotDelegationTarget>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateLocalBotDelegationRequest {
    pub id: String,
    pub parent_bot_id: String,
    pub target_bot_ids: Vec<String>,
    pub task: String,
    pub expected_output: String,
    pub max_actions: u8,
    pub deadline_at: String,
    pub shared_memory_snapshot_hash: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartLocalBotDelegationTargetRequest {
    pub id: String,
    pub target_bot_id: String,
    pub run_id: String,
    pub provider_id: String,
    pub provider_quota_state: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishLocalBotDelegationTargetRequest {
    pub id: String,
    pub target_bot_id: String,
    pub run_id: String,
    pub outcome: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    pub finished_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegationBody {
    schema_version: u8,
    task: String,
    expected_output: String,
    target_bot_ids: Vec<String>,
    shared_memory_snapshot_hash: String,
    max_parallel: u8,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegationTargetSnapshot {
    schema_version: u8,
    bot_snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelegationTargetResult {
    schema_version: u8,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    detail: Option<String>,
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS bot_delegations (
                id TEXT PRIMARY KEY,
                parent_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                parent_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                parent_bot_name TEXT NOT NULL,
                parent_bot_version INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN (
                    'queued', 'running', 'awaiting-approval', 'completed', 'failed', 'canceled'
                )),
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT
             );
             CREATE TABLE IF NOT EXISTS bot_delegation_targets (
                delegation_id TEXT NOT NULL REFERENCES bot_delegations(id) ON DELETE CASCADE,
                bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                bot_name TEXT NOT NULL,
                bot_version INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN (
                    'queued', 'running', 'awaiting-approval', 'completed', 'failed', 'canceled'
                )),
                max_actions INTEGER NOT NULL,
                deadline_at TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                run_id TEXT,
                provider_id TEXT,
                provider_family TEXT,
                queue_detail TEXT,
                result_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT,
                PRIMARY KEY (delegation_id, bot_id)
             );
             CREATE INDEX IF NOT EXISTS idx_bot_delegations_parent
                ON bot_delegations(parent_bot_id, created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_bot_delegations_status
                ON bot_delegations(status, updated_at DESC);
             CREATE INDEX IF NOT EXISTS idx_bot_delegation_targets_status
                ON bot_delegation_targets(status, updated_at ASC);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_delegation_target_run
                ON bot_delegation_targets(run_id) WHERE run_id IS NOT NULL;",
        )
        .map_err(error_text)?;
    add_column_if_missing(connection, "bot_delegation_targets", "provider_id", "TEXT")?;
    add_column_if_missing(
        connection,
        "bot_delegation_targets",
        "provider_family",
        "TEXT",
    )?;
    add_column_if_missing(connection, "bot_delegation_targets", "queue_detail", "TEXT")?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (13, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (18, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn list_local_bot_delegations(
    state: &AppState,
    parent_bot_id: Option<&str>,
) -> Result<Vec<LocalBotDelegation>, String> {
    if let Some(id) = parent_bot_id {
        validate_identifier(id, "parent bot")?;
    }
    let connection = state.connection()?;
    let ids = if let Some(id) = parent_bot_id {
        let mut statement = connection
            .prepare(
                "SELECT id FROM bot_delegations
                 WHERE parent_bot_id = ?1 ORDER BY created_at DESC, id ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    } else {
        let mut statement = connection
            .prepare("SELECT id FROM bot_delegations ORDER BY created_at DESC, id ASC")
            .map_err(error_text)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    ids.into_iter()
        .map(|id| load_delegation(state, &id))
        .collect::<Result<Vec<_>, _>>()
}

pub fn create_local_bot_delegation(
    state: &AppState,
    request: CreateLocalBotDelegationRequest,
) -> Result<LocalBotDelegation, String> {
    validate_identifier(&request.id, "delegation")?;
    validate_identifier(&request.parent_bot_id, "parent bot")?;
    validate_text(&request.task, 4_000, "delegated task")?;
    validate_text(&request.expected_output, 500, "expected output")?;
    validate_snapshot_hash(&request.shared_memory_snapshot_hash)?;
    if !(1..=8).contains(&request.max_actions) {
        return Err("A delegated task must allow between one and eight actions.".into());
    }
    if request.target_bot_ids.is_empty() || request.target_bot_ids.len() > MAX_DELEGATION_TARGETS {
        return Err("Delegate to one or two specialist bots at a time.".into());
    }
    let mut unique_targets = HashSet::new();
    for target_id in &request.target_bot_ids {
        validate_identifier(target_id, "target bot")?;
        if target_id == &request.parent_bot_id || !unique_targets.insert(target_id.clone()) {
            return Err("Choose one or two different specialist bots for this handoff.".into());
        }
    }
    let created_at = canonical_time(&request.created_at, "delegation creation time")?;
    let deadline_at = canonical_time(&request.deadline_at, "delegation deadline")?;
    let created = parse_time(&created_at, "delegation creation time")?;
    let deadline = parse_time(&deadline_at, "delegation deadline")?;
    if deadline <= created || deadline - created > Duration::hours(24) {
        return Err("A delegated task deadline must be within the next 24 hours.".into());
    }
    let parent = crate::storage::load_bot(state, &request.parent_bot_id)?
        .ok_or_else(|| "The bot creating this handoff is no longer available.".to_string())?;
    let mut targets = Vec::new();
    for target_id in &request.target_bot_ids {
        targets.push(crate::storage::load_bot(state, target_id)?.ok_or_else(|| {
            "One of the selected specialist bots is no longer available.".to_string()
        })?);
    }
    let body = DelegationBody {
        schema_version: 1,
        task: request.task.trim().to_string(),
        expected_output: request.expected_output.trim().to_string(),
        target_bot_ids: request.target_bot_ids.clone(),
        shared_memory_snapshot_hash: request.shared_memory_snapshot_hash,
        max_parallel: request.target_bot_ids.len() as u8,
        created_at: created_at.clone(),
    };
    let body_json = serde_json::to_string(&body).map_err(error_text)?;
    let sealed_body = state
        .cipher()
        .seal(&delegation_context(&request.id), &body_json)?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    if transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bot_delegations WHERE id = ?1)",
            params![request.id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(error_text)?
    {
        return Err("That bot handoff already exists.".into());
    }
    prune_old_delegations(&transaction)?;
    let count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM bot_delegations", [], |row| row.get(0))
        .map_err(error_text)?;
    if count >= MAX_DELEGATIONS {
        return Err("This workspace has reached its bounded handoff history. Export or clear older completed work first.".into());
    }
    transaction
        .execute(
            "INSERT INTO bot_delegations
                (id, parent_bot_id, parent_thread_id, parent_bot_name, parent_bot_version,
                 status, body_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?7)",
            params![
                request.id,
                parent.id,
                parent.thread_id,
                parent.name,
                parent.current_version,
                sealed_body,
                created_at,
            ],
        )
        .map_err(error_text)?;
    for target in &targets {
        let snapshot = DelegationTargetSnapshot {
            schema_version: 1,
            bot_snapshot: target.spec.clone(),
        };
        let sealed_snapshot = state.cipher().seal(
            &delegation_target_snapshot_context(&request.id, &target.id),
            &serde_json::to_string(&snapshot).map_err(error_text)?,
        )?;
        transaction
            .execute(
                "INSERT INTO bot_delegation_targets
                    (delegation_id, bot_id, thread_id, bot_name, bot_version, status,
                     max_actions, deadline_at, snapshot_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?9, ?9)",
                params![
                    request.id,
                    target.id,
                    target.thread_id,
                    target.name,
                    target.current_version,
                    request.max_actions,
                    deadline_at,
                    sealed_snapshot,
                    created_at,
                ],
            )
            .map_err(error_text)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO bot_thread_members (bot_id, thread_id, role, created_at)
                 VALUES (?1, ?2, 'delegate', ?3)",
                params![target.id, parent.thread_id, created_at],
            )
            .map_err(error_text)?;
    }
    transaction.commit().map_err(error_text)?;
    load_delegation(state, &request.id)
}

pub fn start_local_bot_delegation_target(
    state: &AppState,
    request: StartLocalBotDelegationTargetRequest,
) -> Result<LocalBotDelegation, String> {
    validate_identifier(&request.id, "delegation")?;
    validate_identifier(&request.target_bot_id, "target bot")?;
    validate_identifier(&request.run_id, "delegated run")?;
    validate_identifier(&request.provider_id, "provider")?;
    let provider_family =
        crate::providers::provider_family(&request.provider_id).ok_or_else(|| {
            "Choose an available intelligence provider for this specialist.".to_string()
        })?;
    let provider_quota_state = validate_provider_quota_state(&request.provider_quota_state)?;
    let started_at = canonical_time(&request.started_at, "delegated run start")?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let target: Option<(String, i64, String)> = transaction
        .query_row(
            "SELECT status, bot_version, deadline_at FROM bot_delegation_targets
             WHERE delegation_id = ?1 AND bot_id = ?2",
            params![request.id, request.target_bot_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(error_text)?;
    let Some((status, reviewed_version, deadline_at)) = target else {
        return Err("That specialist is no longer part of this handoff.".into());
    };
    if status != "queued" {
        return Err("That specialist handoff has already started.".into());
    }
    if parse_time(&started_at, "delegated run start")?
        > parse_time(&deadline_at, "delegation deadline")?
    {
        transaction
            .execute(
                "UPDATE bot_delegation_targets
                 SET status = 'failed', updated_at = ?3, completed_at = ?3
                 WHERE delegation_id = ?1 AND bot_id = ?2 AND status = 'queued'",
                params![request.id, request.target_bot_id, started_at],
            )
            .map_err(error_text)?;
        update_aggregate_status(&transaction, &request.id, &started_at)?;
        transaction.commit().map_err(error_text)?;
        return Err("This handoff reached its deadline before the specialist could start.".into());
    }
    let current_version: Option<i64> = transaction
        .query_row(
            "SELECT current_version FROM bots WHERE id = ?1",
            params![request.target_bot_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(error_text)?;
    if current_version != Some(reviewed_version) {
        return Err("This specialist changed after the handoff was reviewed. Ask again so the new bot version is explicit.".into());
    }
    let active: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM bot_delegation_targets
             WHERE status = 'running'",
            [],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    let active_for_provider: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM bot_delegation_targets
             WHERE status = 'running' AND provider_id = ?1",
            params![request.provider_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    let active_local: bool = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM bot_delegation_targets
                WHERE status = 'running' AND provider_family = 'local'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    #[cfg(test)]
    let device_capacity = crate::system_resources::healthy_background_run_capacity_for_test();
    #[cfg(not(test))]
    let device_capacity = crate::system_resources::background_run_capacity();
    if let Some(detail) = delegation_capacity_issue(
        device_capacity,
        provider_family,
        provider_quota_state,
        active,
        active_for_provider,
        active_local,
    ) {
        transaction
            .execute(
                "UPDATE bot_delegation_targets SET queue_detail = ?3
                 WHERE delegation_id = ?1 AND bot_id = ?2 AND status = 'queued'",
                params![request.id, request.target_bot_id, detail],
            )
            .map_err(error_text)?;
        transaction.commit().map_err(error_text)?;
        return Err(format!("{CAPACITY_ERROR_PREFIX}{detail}"));
    }
    let changed = transaction
        .execute(
            "UPDATE bot_delegation_targets
             SET status = 'running', run_id = ?3, provider_id = ?4,
                 provider_family = ?5, queue_detail = NULL, updated_at = ?6
             WHERE delegation_id = ?1 AND bot_id = ?2 AND status = 'queued'",
            params![
                request.id,
                request.target_bot_id,
                request.run_id,
                request.provider_id,
                provider_family,
                started_at
            ],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("That specialist handoff changed before it could start.".into());
    }
    update_aggregate_status(&transaction, &request.id, &started_at)?;
    transaction.commit().map_err(error_text)?;
    load_delegation(state, &request.id)
}

pub fn finish_local_bot_delegation_target(
    state: &AppState,
    request: FinishLocalBotDelegationTargetRequest,
) -> Result<LocalBotDelegation, String> {
    validate_identifier(&request.id, "delegation")?;
    validate_identifier(&request.target_bot_id, "target bot")?;
    validate_identifier(&request.run_id, "delegated run")?;
    let finished_at = canonical_time(&request.finished_at, "delegated run finish")?;
    let target_status = match request.outcome.as_str() {
        "completed" => "completed",
        "failed" => "failed",
        "canceled" => "canceled",
        "approval-required" => "awaiting-approval",
        _ => return Err(
            "A delegated run outcome must be completed, failed, canceled, or approval required."
                .into(),
        ),
    };
    if target_status == "completed" {
        validate_text(
            request.result.as_deref().unwrap_or(""),
            12_000,
            "delegated result",
        )?;
    } else if let Some(result) = request.result.as_deref() {
        validate_optional_text(result, 12_000, "delegated result")?;
    }
    if let Some(detail) = request.detail.as_deref() {
        validate_optional_text(detail, 1_000, "delegated status detail")?;
    }
    let result_body = DelegationTargetResult {
        schema_version: 1,
        result: request.result.map(|value| value.trim().to_string()),
        detail: request.detail.map(|value| value.trim().to_string()),
    };
    let sealed_result = state.cipher().seal(
        &delegation_target_result_context(&request.id, &request.target_bot_id),
        &serde_json::to_string(&result_body).map_err(error_text)?,
    )?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let current: Option<(String, Option<String>)> = transaction
        .query_row(
            "SELECT status, run_id FROM bot_delegation_targets
             WHERE delegation_id = ?1 AND bot_id = ?2",
            params![request.id, request.target_bot_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(error_text)?;
    let Some((current_status, run_id)) = current else {
        return Err("That specialist is no longer part of this handoff.".into());
    };
    if run_id.as_deref() != Some(request.run_id.as_str())
        || !matches!(current_status.as_str(), "running" | "awaiting-approval")
        || (target_status == "awaiting-approval" && current_status != "running")
    {
        return Err("This delegated run is stale or already finished.".into());
    }
    let completed_at = if target_status == "awaiting-approval" {
        None
    } else {
        Some(finished_at.clone())
    };
    transaction
        .execute(
            "UPDATE bot_delegation_targets
             SET status = ?4, result_json = ?5, updated_at = ?6, completed_at = ?7
             WHERE delegation_id = ?1 AND bot_id = ?2 AND run_id = ?3",
            params![
                request.id,
                request.target_bot_id,
                request.run_id,
                target_status,
                sealed_result,
                finished_at,
                completed_at,
            ],
        )
        .map_err(error_text)?;
    update_aggregate_status(&transaction, &request.id, &finished_at)?;
    transaction.commit().map_err(error_text)?;
    load_delegation(state, &request.id)
}

pub fn recover_local_bot_delegations(state: &AppState) -> Result<Vec<LocalBotDelegation>, String> {
    let recovered_at = canonical_now();
    let interrupted = {
        let connection = state.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT delegation_id, bot_id FROM bot_delegation_targets
                 WHERE status = 'running' ORDER BY updated_at ASC, delegation_id ASC, bot_id ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    if interrupted.is_empty() {
        return list_local_bot_delegations(state, None);
    }

    let result = DelegationTargetResult {
        schema_version: 1,
        result: None,
        detail: Some(
            "Codelit closed before this specialist finished. Ask the bot again to retry.".into(),
        ),
    };
    let result_json = serde_json::to_string(&result).map_err(error_text)?;
    let sealed_results = interrupted
        .iter()
        .map(|(delegation_id, bot_id)| {
            state
                .cipher()
                .seal(
                    &delegation_target_result_context(delegation_id, bot_id),
                    &result_json,
                )
                .map(|sealed| (delegation_id.clone(), bot_id.clone(), sealed))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let mut changed_delegations = HashSet::new();
    for (delegation_id, bot_id, sealed_result) in sealed_results {
        let changed = transaction
            .execute(
                "UPDATE bot_delegation_targets
                 SET status = 'failed', result_json = ?3, updated_at = ?4, completed_at = ?4
                 WHERE delegation_id = ?1 AND bot_id = ?2 AND status = 'running'",
                params![delegation_id, bot_id, sealed_result, recovered_at],
            )
            .map_err(error_text)?;
        if changed == 1 {
            changed_delegations.insert(delegation_id);
        }
    }
    for delegation_id in changed_delegations {
        update_aggregate_status(&transaction, &delegation_id, &recovered_at)?;
    }
    transaction.commit().map_err(error_text)?;
    list_local_bot_delegations(state, None)
}

pub fn cancel_local_bot_delegation(
    state: &AppState,
    id: &str,
) -> Result<LocalBotDelegation, String> {
    validate_identifier(id, "delegation")?;
    let now = canonical_now();
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let changed = transaction
        .execute(
            "UPDATE bot_delegation_targets
             SET status = 'canceled', updated_at = ?2, completed_at = ?2
             WHERE delegation_id = ?1
               AND status IN ('queued', 'running', 'awaiting-approval')",
            params![id, now],
        )
        .map_err(error_text)?;
    if changed == 0
        && !transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM bot_delegations WHERE id = ?1)",
                params![id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(error_text)?
    {
        return Err("That bot handoff is no longer available.".into());
    }
    update_aggregate_status(&transaction, id, &now)?;
    transaction.commit().map_err(error_text)?;
    load_delegation(state, id)
}

fn load_delegation(state: &AppState, id: &str) -> Result<LocalBotDelegation, String> {
    let connection = state.connection()?;
    let row: Option<DelegationRow> = connection
        .query_row(
            "SELECT parent_bot_id, parent_thread_id, parent_bot_name, parent_bot_version,
                    status, body_json, created_at, updated_at
             FROM bot_delegations WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()
        .map_err(error_text)?;
    let Some((
        parent_bot_id,
        parent_thread_id,
        parent_bot_name,
        parent_bot_version,
        status,
        sealed_body,
        created_at,
        updated_at,
    )) = row
    else {
        return Err("That bot handoff is no longer available.".into());
    };
    let body: DelegationBody =
        serde_json::from_str(&state.cipher().open(&delegation_context(id), &sealed_body)?)
            .map_err(|_| "The encrypted bot handoff definition is invalid.".to_string())?;
    validate_body(&body)?;
    let mut statement = connection
        .prepare(
            "SELECT bot_id, thread_id, bot_name, bot_version, status, max_actions,
                    deadline_at, snapshot_json, run_id, provider_id, queue_detail,
                    result_json, completed_at, updated_at
             FROM bot_delegation_targets
             WHERE delegation_id = ?1 ORDER BY created_at ASC, bot_id ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u8>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, String>(13)?,
            ))
        })
        .map_err(error_text)?;
    let mut targets = Vec::new();
    for row in rows {
        let (
            bot_id,
            thread_id,
            bot_name,
            bot_version,
            target_status,
            max_actions,
            deadline_at,
            sealed_snapshot,
            run_id,
            provider_id,
            queue_detail,
            sealed_result,
            completed_at,
            target_updated_at,
        ) = row.map_err(error_text)?;
        let snapshot: DelegationTargetSnapshot = serde_json::from_str(&state.cipher().open(
            &delegation_target_snapshot_context(id, &bot_id),
            &sealed_snapshot,
        )?)
        .map_err(|_| "An encrypted specialist snapshot is invalid.".to_string())?;
        validate_target_snapshot(&snapshot, &bot_id, bot_version)?;
        let result = sealed_result
            .map(|sealed| {
                let plaintext = state
                    .cipher()
                    .open(&delegation_target_result_context(id, &bot_id), &sealed)?;
                serde_json::from_str::<DelegationTargetResult>(&plaintext)
                    .map_err(|_| "An encrypted specialist result is invalid.".to_string())
            })
            .transpose()?;
        targets.push(LocalBotDelegationTarget {
            bot_id,
            thread_id,
            bot_name,
            bot_version,
            status: target_status,
            max_actions,
            deadline_at,
            bot_snapshot: snapshot.bot_snapshot,
            run_id,
            provider_id,
            result: result.as_ref().and_then(|value| value.result.clone()),
            detail: result.and_then(|value| value.detail).or(queue_detail),
            completed_at,
            updated_at: target_updated_at,
        });
    }
    if targets.len() != body.target_bot_ids.len()
        || !body
            .target_bot_ids
            .iter()
            .all(|target_id| targets.iter().any(|target| &target.bot_id == target_id))
    {
        return Err("The bot handoff target list is incomplete.".into());
    }
    Ok(LocalBotDelegation {
        id: id.into(),
        parent_bot_id,
        parent_thread_id,
        parent_bot_name,
        parent_bot_version,
        task: body.task,
        expected_output: body.expected_output,
        shared_memory_snapshot_hash: body.shared_memory_snapshot_hash,
        status,
        max_parallel: body.max_parallel,
        targets,
        created_at,
        updated_at,
    })
}

fn update_aggregate_status(
    transaction: &Transaction<'_>,
    id: &str,
    updated_at: &str,
) -> Result<(), String> {
    let statuses = {
        let mut statement = transaction
            .prepare(
                "SELECT status FROM bot_delegation_targets
                 WHERE delegation_id = ?1 ORDER BY bot_id ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    if statuses.is_empty() {
        return Err("The bot handoff no longer has any specialists.".into());
    }
    let status = if statuses.iter().any(|value| value == "running")
        || statuses.iter().any(|value| value == "queued")
    {
        if statuses.iter().all(|value| value == "queued") {
            "queued"
        } else {
            "running"
        }
    } else if statuses.iter().any(|value| value == "awaiting-approval") {
        "awaiting-approval"
    } else if statuses.iter().any(|value| value == "completed") {
        "completed"
    } else if statuses.iter().all(|value| value == "canceled") {
        "canceled"
    } else {
        "failed"
    };
    let completed_at = if matches!(status, "completed" | "failed" | "canceled") {
        Some(updated_at)
    } else {
        None
    };
    let changed = transaction
        .execute(
            "UPDATE bot_delegations
             SET status = ?2, updated_at = ?3, completed_at = ?4 WHERE id = ?1",
            params![id, status, updated_at, completed_at],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("That bot handoff is no longer available.".into());
    }
    Ok(())
}

fn prune_old_delegations(transaction: &Transaction<'_>) -> Result<(), String> {
    let count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM bot_delegations", [], |row| row.get(0))
        .map_err(error_text)?;
    if count < MAX_DELEGATIONS {
        return Ok(());
    }
    transaction
        .execute(
            "DELETE FROM bot_delegations WHERE id IN (
                SELECT id FROM bot_delegations
                WHERE status IN ('completed', 'failed', 'canceled')
                ORDER BY updated_at ASC, id ASC LIMIT 25
             )",
            [],
        )
        .map_err(error_text)?;
    Ok(())
}

fn delegation_capacity_issue(
    device: crate::system_resources::BackgroundRunCapacity,
    provider_family: &str,
    provider_quota_state: &str,
    active: i64,
    active_for_provider: i64,
    active_local: bool,
) -> Option<String> {
    if provider_quota_state == "exhausted" {
        return Some("Waiting for this provider's usage limit to reset.".into());
    }
    if device.max_parallel == 0 {
        return Some(device.detail.into());
    }
    if active > 0 && (provider_family == "local" || active_local) {
        return Some(
            "Running one specialist at a time while an on-device engine is active.".into(),
        );
    }
    if active >= i64::from(device.max_parallel.min(MAX_ACTIVE_DELEGATION_TARGETS as u8)) {
        return Some(device.detail.into());
    }
    let provider_limit = if provider_family == "local" || provider_quota_state == "limited" {
        1
    } else {
        MAX_ACTIVE_DELEGATION_TARGETS
    };
    if active_for_provider >= provider_limit {
        return Some(if provider_quota_state == "limited" {
            "Waiting for the current provider run because its available capacity is limited.".into()
        } else {
            "Waiting for an active run on the same provider to finish.".into()
        });
    }
    None
}

fn validate_provider_quota_state(value: &str) -> Result<&str, String> {
    match value {
        "unknown" | "available" | "limited" | "exhausted" | "not-applicable" => Ok(value),
        _ => Err("The provider capacity state is invalid.".into()),
    }
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(error_text)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(error_text)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error_text)?;
    if names.iter().any(|name| name == column) {
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

fn validate_body(body: &DelegationBody) -> Result<(), String> {
    if body.schema_version != 1
        || body.target_bot_ids.is_empty()
        || body.target_bot_ids.len() > MAX_DELEGATION_TARGETS
        || usize::from(body.max_parallel) != body.target_bot_ids.len()
    {
        return Err("This bot handoff definition is unsupported.".into());
    }
    validate_text(&body.task, 4_000, "delegated task")?;
    validate_text(&body.expected_output, 500, "expected output")?;
    validate_snapshot_hash(&body.shared_memory_snapshot_hash)?;
    canonical_time(&body.created_at, "delegation creation time")?;
    Ok(())
}

fn validate_target_snapshot(
    snapshot: &DelegationTargetSnapshot,
    bot_id: &str,
    bot_version: i64,
) -> Result<(), String> {
    if snapshot.schema_version != 1
        || snapshot
            .bot_snapshot
            .get("schemaVersion")
            .and_then(Value::as_i64)
            != Some(1)
        || snapshot.bot_snapshot.get("botId").and_then(Value::as_str) != Some(bot_id)
        || snapshot.bot_snapshot.get("version").and_then(Value::as_i64) != Some(bot_version)
        || !snapshot
            .bot_snapshot
            .get("permissionPolicy")
            .is_some_and(Value::is_object)
    {
        return Err("The reviewed specialist snapshot is invalid.".into());
    }
    Ok(())
}

pub(crate) fn validate_archived_delegation_body(body: &Value) -> Result<(), String> {
    let decoded: DelegationBody = serde_json::from_value(body.clone())
        .map_err(|_| "An archived bot handoff definition is invalid.".to_string())?;
    validate_body(&decoded)
}

pub(crate) fn validate_archived_delegation_target_snapshot(
    body: &Value,
    bot_id: &str,
    bot_version: i64,
) -> Result<(), String> {
    let decoded: DelegationTargetSnapshot = serde_json::from_value(body.clone())
        .map_err(|_| "An archived specialist snapshot is invalid.".to_string())?;
    validate_target_snapshot(&decoded, bot_id, bot_version)
}

pub(crate) fn validate_archived_delegation_target_result(body: &Value) -> Result<(), String> {
    let decoded: DelegationTargetResult = serde_json::from_value(body.clone())
        .map_err(|_| "An archived specialist result is invalid.".to_string())?;
    if decoded.schema_version != 1 {
        return Err("An archived specialist result is unsupported.".into());
    }
    if let Some(result) = decoded.result.as_deref() {
        validate_optional_text(result, 12_000, "archived delegated result")?;
    }
    if let Some(detail) = decoded.detail.as_deref() {
        validate_optional_text(detail, 1_000, "archived delegated detail")?;
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 180
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        return Err(format!("The {label} identifier is invalid."));
    }
    Ok(())
}

fn validate_text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > max
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(format!("The {label} is invalid."));
    }
    Ok(())
}

fn validate_optional_text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.len() > max
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(format!("The {label} is invalid."));
    }
    Ok(())
}

fn validate_snapshot_hash(value: &str) -> Result<(), String> {
    if value != "none" && (value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("The shared-memory snapshot is invalid.".into());
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

pub(crate) fn delegation_context(id: &str) -> String {
    format!("bot-delegations:{id}:definition")
}

pub(crate) fn delegation_target_snapshot_context(id: &str, bot_id: &str) -> String {
    format!("bot-delegations:{id}:targets:{bot_id}:snapshot")
}

pub(crate) fn delegation_target_result_context(id: &str, bot_id: &str) -> String {
    format!("bot-delegations:{id}:targets:{bot_id}:result")
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage;
    use tempfile::tempdir;

    fn add_bot(state: &AppState, id: &str, name: &str, at: &str) -> storage::LocalBotRecord {
        storage::create_local_bot(
            state,
            storage::CreateLocalBotRequest {
                id: id.into(),
                name: name.into(),
                job: format!("Handle {name} specialist work."),
                avatar: None,
                created_at: at.into(),
            },
        )
        .expect("bot created")
        .active_bot
    }

    fn request(
        parent: &storage::LocalBotRecord,
        targets: &[&storage::LocalBotRecord],
    ) -> CreateLocalBotDelegationRequest {
        CreateLocalBotDelegationRequest {
            id: "delegation-release-review".into(),
            parent_bot_id: parent.id.clone(),
            target_bot_ids: targets.iter().map(|bot| bot.id.clone()).collect(),
            task: "Review the release evidence and name the highest-risk gap.".into(),
            expected_output: "One concise evidence-backed recommendation per specialist.".into(),
            max_actions: 4,
            deadline_at: "2099-08-19T12:30:00.000Z".into(),
            shared_memory_snapshot_hash: "a".repeat(64),
            created_at: "2099-08-19T12:00:00.000Z".into(),
        }
    }

    #[test]
    fn migration_adds_admission_columns_to_an_existing_handoff_ledger() {
        let connection = Connection::open_in_memory().expect("connection");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 CREATE TABLE bot_delegations (
                    id TEXT PRIMARY KEY, parent_bot_id TEXT NOT NULL,
                    parent_thread_id TEXT NOT NULL, parent_bot_name TEXT NOT NULL,
                    parent_bot_version INTEGER NOT NULL, status TEXT NOT NULL,
                    body_json TEXT NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, completed_at TEXT
                 );
                 CREATE TABLE bot_delegation_targets (
                    delegation_id TEXT NOT NULL, bot_id TEXT NOT NULL,
                    thread_id TEXT NOT NULL, bot_name TEXT NOT NULL,
                    bot_version INTEGER NOT NULL, status TEXT NOT NULL,
                    max_actions INTEGER NOT NULL, deadline_at TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL, run_id TEXT, result_json TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    completed_at TEXT, PRIMARY KEY (delegation_id, bot_id)
                 );",
            )
            .expect("old delegation schema");

        migrate(&connection).expect("migration");
        let mut statement = connection
            .prepare("PRAGMA table_info(bot_delegation_targets)")
            .expect("table info");
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("column names");
        for column in ["provider_id", "provider_family", "queue_detail"] {
            assert!(columns.iter().any(|candidate| candidate == column));
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM schema_migrations WHERE version IN (13, 18)",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("migration versions"),
            2
        );
    }

    #[test]
    fn adaptive_capacity_serializes_local_engines_and_honors_device_pauses() {
        let healthy = crate::system_resources::BackgroundRunCapacity {
            max_parallel: 2,
            detail: "Waiting for one active specialist to finish.",
        };
        assert!(
            delegation_capacity_issue(healthy, "local", "not-applicable", 1, 0, false)
                .is_some_and(|detail| detail.contains("on-device engine"))
        );
        assert!(
            delegation_capacity_issue(healthy, "subscription", "unknown", 1, 0, true)
                .is_some_and(|detail| detail.contains("on-device engine"))
        );
        let paused = crate::system_resources::BackgroundRunCapacity {
            max_parallel: 0,
            detail: "Waiting for this Mac to cool before starting another specialist.",
        };
        assert!(
            delegation_capacity_issue(paused, "subscription", "unknown", 0, 0, false)
                .is_some_and(|detail| detail.contains("cool"))
        );
    }

    #[test]
    fn delegation_is_encrypted_bounded_and_aggregates_parallel_results() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let parent = storage::bootstrap_local_bots(&state)
            .expect("bots")
            .active_bot;
        let researcher = add_bot(
            &state,
            "bot-researcher",
            "Researcher",
            "2099-08-19T11:00:00.000Z",
        );
        let reviewer = add_bot(
            &state,
            "bot-reviewer",
            "Reviewer",
            "2099-08-19T11:01:00.000Z",
        );
        let saved =
            create_local_bot_delegation(&state, request(&parent, &[&researcher, &reviewer]))
                .expect("delegation saved");
        assert_eq!(saved.status, "queued");
        assert_eq!(saved.targets.len(), 2);
        let (body, snapshot): (String, String) = state
            .connection()
            .expect("connection")
            .query_row(
                "SELECT d.body_json, t.snapshot_json
                 FROM bot_delegations d JOIN bot_delegation_targets t
                   ON t.delegation_id = d.id
                 WHERE d.id = ?1 AND t.bot_id = ?2",
                params![saved.id, researcher.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("sealed delegation");
        assert!(crate::crypto::DataCipher::is_sealed(&body));
        assert!(crate::crypto::DataCipher::is_sealed(&snapshot));
        assert!(!body.contains("highest-risk"));

        let first = start_local_bot_delegation_target(
            &state,
            StartLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: researcher.id.clone(),
                run_id: "run-delegated-research".into(),
                provider_id: "codex".into(),
                provider_quota_state: "unknown".into(),
                started_at: "2099-08-19T12:01:00.000Z".into(),
            },
        )
        .expect("first target started");
        assert_eq!(first.status, "running");
        start_local_bot_delegation_target(
            &state,
            StartLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: reviewer.id.clone(),
                run_id: "run-delegated-review".into(),
                provider_id: "copilot".into(),
                provider_quota_state: "unknown".into(),
                started_at: "2099-08-19T12:01:01.000Z".into(),
            },
        )
        .expect("second target started");
        let first_done = finish_local_bot_delegation_target(
            &state,
            FinishLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: researcher.id.clone(),
                run_id: "run-delegated-research".into(),
                outcome: "completed".into(),
                result: Some("The evidence is complete.".into()),
                detail: None,
                finished_at: "2099-08-19T12:02:00.000Z".into(),
            },
        )
        .expect("first target completed");
        assert_eq!(first_done.status, "running");
        let waiting = finish_local_bot_delegation_target(
            &state,
            FinishLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: reviewer.id.clone(),
                run_id: "run-delegated-review".into(),
                outcome: "approval-required".into(),
                result: None,
                detail: Some("Waiting for website access.".into()),
                finished_at: "2099-08-19T12:02:01.000Z".into(),
            },
        )
        .expect("approval recorded");
        assert_eq!(waiting.status, "awaiting-approval");
        let completed = finish_local_bot_delegation_target(
            &state,
            FinishLocalBotDelegationTargetRequest {
                id: saved.id,
                target_bot_id: reviewer.id,
                run_id: "run-delegated-review".into(),
                outcome: "completed".into(),
                result: Some("The launch needs a rollback owner.".into()),
                detail: None,
                finished_at: "2099-08-19T12:03:00.000Z".into(),
            },
        )
        .expect("delegation completed");
        assert_eq!(completed.status, "completed");
        assert_eq!(
            completed.targets[0].result.as_deref(),
            Some("The evidence is complete.")
        );
        assert_eq!(
            completed.targets[1].result.as_deref(),
            Some("The launch needs a rollback owner.")
        );
    }

    #[test]
    fn limited_provider_capacity_keeps_the_next_specialist_queued_until_release() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let parent = storage::bootstrap_local_bots(&state)
            .expect("bots")
            .active_bot;
        let first_target = add_bot(
            &state,
            "bot-capacity-first",
            "First Specialist",
            "2099-08-19T11:00:00.000Z",
        );
        let second_target = add_bot(
            &state,
            "bot-capacity-second",
            "Second Specialist",
            "2099-08-19T11:01:00.000Z",
        );
        let saved =
            create_local_bot_delegation(&state, request(&parent, &[&first_target, &second_target]))
                .expect("delegation saved");
        start_local_bot_delegation_target(
            &state,
            StartLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: first_target.id.clone(),
                run_id: "run-capacity-first".into(),
                provider_id: "codex".into(),
                provider_quota_state: "limited".into(),
                started_at: "2099-08-19T12:01:00.000Z".into(),
            },
        )
        .expect("first specialist started");
        let error = start_local_bot_delegation_target(
            &state,
            StartLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: second_target.id.clone(),
                run_id: "run-capacity-second".into(),
                provider_id: "codex".into(),
                provider_quota_state: "limited".into(),
                started_at: "2099-08-19T12:01:01.000Z".into(),
            },
        )
        .expect_err("second specialist queued");
        assert!(error.starts_with(CAPACITY_ERROR_PREFIX));
        let queued = load_delegation(&state, &saved.id).expect("queued handoff");
        assert_eq!(queued.targets[0].provider_id.as_deref(), Some("codex"));
        assert_eq!(queued.targets[1].status, "queued");
        assert!(
            queued.targets[1]
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("capacity is limited"))
        );

        finish_local_bot_delegation_target(
            &state,
            FinishLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: first_target.id,
                run_id: "run-capacity-first".into(),
                outcome: "completed".into(),
                result: Some("First result".into()),
                detail: None,
                finished_at: "2099-08-19T12:02:00.000Z".into(),
            },
        )
        .expect("first specialist finished");
        let started = start_local_bot_delegation_target(
            &state,
            StartLocalBotDelegationTargetRequest {
                id: saved.id,
                target_bot_id: second_target.id,
                run_id: "run-capacity-second".into(),
                provider_id: "codex".into(),
                provider_quota_state: "limited".into(),
                started_at: "2099-08-19T12:02:01.000Z".into(),
            },
        )
        .expect("queued specialist started after release");
        assert_eq!(started.targets[1].status, "running");
        assert_eq!(started.targets[1].detail, None);
    }

    #[test]
    fn delegation_rejects_stale_bot_versions_and_self_handoffs() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let parent = storage::bootstrap_local_bots(&state)
            .expect("bots")
            .active_bot;
        let target = add_bot(
            &state,
            "bot-specialist",
            "Specialist",
            "2099-08-19T11:00:00.000Z",
        );
        let saved = create_local_bot_delegation(&state, request(&parent, &[&target]))
            .expect("delegation saved");
        storage::update_local_bot_profile(
            &state,
            storage::UpdateLocalBotProfileRequest {
                id: target.id.clone(),
                name: "Changed Specialist".into(),
                avatar: None,
                updated_at: "2099-08-19T12:00:30.000Z".into(),
            },
        )
        .expect("target changed");
        let error = start_local_bot_delegation_target(
            &state,
            StartLocalBotDelegationTargetRequest {
                id: saved.id,
                target_bot_id: target.id,
                run_id: "run-stale-target".into(),
                provider_id: "codex".into(),
                provider_quota_state: "unknown".into(),
                started_at: "2099-08-19T12:01:00.000Z".into(),
            },
        )
        .expect_err("stale target rejected");
        assert!(error.contains("changed after the handoff"));

        let self_error = create_local_bot_delegation(&state, request(&parent, &[&parent]))
            .expect_err("self delegation rejected");
        assert!(self_error.contains("different specialist bots"));
    }

    #[test]
    fn canceling_a_handoff_revokes_every_unfinished_target() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let parent = storage::bootstrap_local_bots(&state)
            .expect("bots")
            .active_bot;
        let target = add_bot(
            &state,
            "bot-cancel-target",
            "Cancel Target",
            "2099-08-19T11:00:00.000Z",
        );
        let saved = create_local_bot_delegation(&state, request(&parent, &[&target]))
            .expect("delegation saved");
        start_local_bot_delegation_target(
            &state,
            StartLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: target.id,
                run_id: "run-cancel-target".into(),
                provider_id: "codex".into(),
                provider_quota_state: "unknown".into(),
                started_at: "2099-08-19T12:01:00.000Z".into(),
            },
        )
        .expect("target started");
        let canceled = cancel_local_bot_delegation(&state, &saved.id).expect("delegation canceled");
        assert_eq!(canceled.status, "canceled");
        assert_eq!(canceled.targets[0].status, "canceled");
        assert!(
            finish_local_bot_delegation_target(
                &state,
                FinishLocalBotDelegationTargetRequest {
                    id: saved.id,
                    target_bot_id: canceled.targets[0].bot_id.clone(),
                    run_id: "run-cancel-target".into(),
                    outcome: "completed".into(),
                    result: Some("stale".into()),
                    detail: None,
                    finished_at: "2099-08-19T12:02:00.000Z".into(),
                },
            )
            .is_err()
        );
    }

    #[test]
    fn restart_recovery_fails_interrupted_runs_and_preserves_reviewable_work() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        let parent = storage::bootstrap_local_bots(&state)
            .expect("bots")
            .active_bot;
        let running_target = add_bot(
            &state,
            "bot-recovery-running",
            "Recovery Runner",
            "2099-08-19T11:00:00.000Z",
        );
        let approval_target = add_bot(
            &state,
            "bot-recovery-approval",
            "Recovery Reviewer",
            "2099-08-19T11:01:00.000Z",
        );
        let saved = create_local_bot_delegation(
            &state,
            request(&parent, &[&running_target, &approval_target]),
        )
        .expect("delegation saved");
        start_local_bot_delegation_target(
            &state,
            StartLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: running_target.id.clone(),
                run_id: "run-recovery-running".into(),
                provider_id: "codex".into(),
                provider_quota_state: "unknown".into(),
                started_at: "2099-08-19T12:01:00.000Z".into(),
            },
        )
        .expect("running target started");
        start_local_bot_delegation_target(
            &state,
            StartLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: approval_target.id.clone(),
                run_id: "run-recovery-approval".into(),
                provider_id: "copilot".into(),
                provider_quota_state: "unknown".into(),
                started_at: "2099-08-19T12:01:01.000Z".into(),
            },
        )
        .expect("approval target started");
        finish_local_bot_delegation_target(
            &state,
            FinishLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: approval_target.id.clone(),
                run_id: "run-recovery-approval".into(),
                outcome: "approval-required".into(),
                result: None,
                detail: Some("Waiting for reviewed website access.".into()),
                finished_at: "2099-08-19T12:02:00.000Z".into(),
            },
        )
        .expect("approval retained");
        let mut queued_request = request(&parent, &[&running_target]);
        queued_request.id = "delegation-recovery-queued".into();
        let queued =
            create_local_bot_delegation(&state, queued_request).expect("queued delegation saved");

        let recovered = recover_local_bot_delegations(&state).expect("delegations recovered");
        let interrupted = recovered
            .iter()
            .find(|delegation| delegation.id == saved.id)
            .expect("interrupted delegation listed");
        let failed = interrupted
            .targets
            .iter()
            .find(|target| target.bot_id == running_target.id)
            .expect("interrupted target listed");
        let awaiting = interrupted
            .targets
            .iter()
            .find(|target| target.bot_id == approval_target.id)
            .expect("approval target listed");
        assert_eq!(interrupted.status, "awaiting-approval");
        assert_eq!(failed.status, "failed");
        assert!(
            failed
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("closed before this specialist finished"))
        );
        assert_eq!(awaiting.status, "awaiting-approval");
        let still_queued = recovered
            .iter()
            .find(|delegation| delegation.id == queued.id)
            .expect("queued delegation listed");
        assert_eq!(still_queued.status, "queued");
        assert_eq!(still_queued.targets[0].status, "queued");

        let sealed_result: String = state
            .connection()
            .expect("connection")
            .query_row(
                "SELECT result_json FROM bot_delegation_targets
                 WHERE delegation_id = ?1 AND bot_id = ?2",
                params![saved.id, running_target.id],
                |row| row.get(0),
            )
            .expect("recovery result");
        assert!(crate::crypto::DataCipher::is_sealed(&sealed_result));
        assert!(!sealed_result.contains("closed before"));
    }

    #[test]
    fn portable_restore_keeps_handoff_history_but_cancels_unfinished_work() {
        let source_directory = tempdir().expect("source tempdir");
        let source = AppState::for_test(source_directory.path()).expect("source state");
        let parent = storage::bootstrap_local_bots(&source)
            .expect("bots")
            .active_bot;
        let target = add_bot(
            &source,
            "bot-portable-target",
            "Portable Target",
            "2099-08-19T11:00:00.000Z",
        );
        let saved = create_local_bot_delegation(&source, request(&parent, &[&target]))
            .expect("delegation saved");
        start_local_bot_delegation_target(
            &source,
            StartLocalBotDelegationTargetRequest {
                id: saved.id.clone(),
                target_bot_id: target.id.clone(),
                run_id: "run-portable-target".into(),
                provider_id: "codex".into(),
                provider_quota_state: "unknown".into(),
                started_at: "2099-08-19T12:01:00.000Z".into(),
            },
        )
        .expect("delegation started");
        storage::update_local_bot_group_members(
            &source,
            storage::UpdateLocalBotGroupMembersRequest {
                owner_bot_id: parent.id.clone(),
                member_bot_ids: vec![target.id.clone()],
                updated_at: "2099-08-19T12:02:00.000Z".into(),
            },
        )
        .expect("target promoted to persistent teammate");
        let archive = storage::export_workspace_archive(&source).expect("archive exported");

        let target_directory = tempdir().expect("target tempdir");
        let restored = AppState::for_test(target_directory.path()).expect("target state");
        storage::restore_workspace_archive(&restored, &archive, true).expect("archive restored");
        let delegations =
            list_local_bot_delegations(&restored, Some(&parent.id)).expect("restored delegations");
        assert_eq!(delegations.len(), 1);
        assert_eq!(delegations[0].status, "canceled");
        assert_eq!(delegations[0].targets[0].status, "canceled");
        assert!(delegations[0].targets[0].run_id.is_none());
        assert!(
            delegations[0].targets[0]
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("portable backup"))
        );
        assert_eq!(
            storage::list_local_bot_group_members(&restored, &parent.id)
                .expect("restored teammates")[0]
                .id,
            target.id
        );
        storage::update_local_bot_group_members(
            &restored,
            storage::UpdateLocalBotGroupMembersRequest {
                owner_bot_id: parent.id.clone(),
                member_bot_ids: vec![],
                updated_at: "2099-08-19T12:03:00.000Z".into(),
            },
        )
        .expect("active membership removed");
        let retained_role: String = restored
            .connection()
            .expect("connection")
            .query_row(
                "SELECT role FROM bot_thread_members WHERE bot_id = ?1 AND thread_id = ?2",
                params![target.id, parent.thread_id],
                |row| row.get(0),
            )
            .expect("historical membership retained");
        assert_eq!(retained_role, "delegate");
    }
}
