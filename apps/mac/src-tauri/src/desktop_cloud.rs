use crate::scheduler::LocalSchedule;
use crate::storage::{AppState, WorkspaceSnapshot};
use chrono::DateTime;
#[cfg(test)]
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MAX_PROMOTIONS: usize = 12;
const MAX_RESULT_LENGTH: usize = 3_000;
const MAX_ERROR_LENGTH: usize = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudAccount {
    pub plan: String,
    pub plan_name: String,
    pub entitlement_version: String,
    pub status: String,
    pub source: String,
    pub build_channel: String,
    pub commerce: String,
    pub limits: DesktopCloudLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudLimits {
    pub hosted_workflows: u32,
    pub managed_browser_minutes: u32,
    pub workspace_seats: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudCapability {
    pub id: String,
    pub available: bool,
    pub required_plan: String,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub href: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudSource {
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub schedule_id: Option<String>,
    pub artifact_id: String,
    pub artifact_version: String,
    pub artifact_kind: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudState {
    pub state: String,
    pub changed: bool,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub artifact_id: Option<String>,
    #[serde(default)]
    pub deployment_id: Option<String>,
    #[serde(default)]
    pub review_href: Option<String>,
    #[serde(default)]
    pub project_href: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHostedResult {
    pub version: u8,
    pub promotion_id: String,
    pub payload_hash: String,
    pub deployment_id: String,
    pub project_id: String,
    pub artifact_id: String,
    pub source_schedule_id: String,
    pub source_artifact_id: String,
    pub source_artifact_version: String,
    pub artifact_kind: String,
    pub run_id: String,
    pub recovery_attempt: u8,
    pub status: String,
    pub workflow_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub completed_at: String,
    pub steps: u32,
    pub total_approx_usd: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub receipt_digest: String,
    pub receipt_href: String,
    pub sync_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudPromotion {
    pub promotion_id: String,
    pub status: String,
    pub payload_hash: String,
    pub mode: String,
    pub readiness: String,
    pub created_at: String,
    #[serde(default)]
    pub imported_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    pub source: DesktopCloudSource,
    pub cloud: DesktopCloudState,
    #[serde(default)]
    pub latest_result: Option<DesktopHostedResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudSyncResponse {
    pub version: u8,
    pub checked_at: String,
    pub account: DesktopCloudAccount,
    pub capabilities: Vec<DesktopCloudCapability>,
    pub promotions: Vec<DesktopCloudPromotion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudLink {
    pub promotion_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    pub thread_id: String,
    pub artifact_id: String,
    pub source_artifact_version: String,
    pub artifact_kind: String,
    pub title: String,
    pub payload_hash: String,
    pub mode: String,
    pub status: String,
    pub cloud_state: String,
    pub conflict_state: String,
    pub local_changed: bool,
    pub cloud_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_href: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_href: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_result: Option<DesktopCloudResultSummary>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudResultSummary {
    pub run_id: String,
    pub status: String,
    pub summary: String,
    pub completed_at: String,
    pub receipt_href: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudImportedResult {
    pub thread_id: String,
    pub artifact_id: String,
    pub artifact_kind: String,
    pub run_id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudSyncView {
    pub version: u8,
    pub checked_at: String,
    pub account: DesktopCloudAccount,
    pub capabilities: Vec<DesktopCloudCapability>,
    pub promotions: Vec<DesktopCloudLink>,
    pub imported_results: Vec<DesktopCloudImportedResult>,
    pub workspace: WorkspaceSnapshot,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCloudLinkBody {
    title: String,
    mode: String,
    status: String,
    cloud_state: String,
    conflict_state: String,
    local_changed: bool,
    cloud_changed: bool,
    cloud_revision: Option<String>,
    project_href: Option<String>,
    review_href: Option<String>,
    latest_result: Option<DesktopCloudResultSummaryBody>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCloudResultSummaryBody {
    run_id: String,
    status: String,
    summary: String,
    completed_at: String,
    receipt_href: String,
}

struct CloudLinkRow {
    promotion_id: String,
    schedule_id: Option<String>,
    thread_id: String,
    artifact_id: String,
    source_artifact_version: String,
    artifact_kind: String,
    payload_hash: String,
    latest_sync_digest: Option<String>,
    body_json: String,
    created_at: String,
    updated_at: String,
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS desktop_cloud_links (
                promotion_id TEXT PRIMARY KEY,
                schedule_id TEXT,
                thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
                source_artifact_version TEXT NOT NULL,
                artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('agent-team', 'product-plan', 'architecture')),
                payload_hash TEXT NOT NULL,
                latest_sync_digest TEXT,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_desktop_cloud_links_schedule
               ON desktop_cloud_links(schedule_id, created_at DESC);
             INSERT OR IGNORE INTO schema_migrations (version, applied_at)
               VALUES (9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));",
        )
        .map_err(error_text)?;
    let version_ten_applied: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 10)",
            [],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if version_ten_applied {
        return Ok(());
    }
    let schedule_not_null: bool = connection
        .prepare("PRAGMA table_info(desktop_cloud_links)")
        .map_err(error_text)?
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, bool>(3)?))
        })
        .map_err(error_text)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error_text)?
        .into_iter()
        .find(|(name, _)| name == "schedule_id")
        .map(|(_, not_null)| not_null)
        .ok_or_else(|| "The cloud-link schema is incomplete.".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error_text)?;
    if schedule_not_null {
        transaction
            .execute_batch(
                "ALTER TABLE desktop_cloud_links RENAME TO desktop_cloud_links_v9;
                 DROP INDEX IF EXISTS idx_desktop_cloud_links_schedule;
                 CREATE TABLE desktop_cloud_links (
                    promotion_id TEXT PRIMARY KEY,
                    schedule_id TEXT,
                    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
                    source_artifact_version TEXT NOT NULL,
                    artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('agent-team', 'product-plan', 'architecture')),
                    payload_hash TEXT NOT NULL,
                    latest_sync_digest TEXT,
                    body_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 INSERT INTO desktop_cloud_links (
                    promotion_id, schedule_id, thread_id, artifact_id, source_artifact_version,
                    artifact_kind, payload_hash, latest_sync_digest, body_json, created_at, updated_at
                 ) SELECT
                    promotion_id, schedule_id, thread_id, artifact_id, source_artifact_version,
                    artifact_kind, payload_hash, latest_sync_digest, body_json, created_at, updated_at
                 FROM desktop_cloud_links_v9;
                 DROP TABLE desktop_cloud_links_v9;
                 CREATE INDEX idx_desktop_cloud_links_schedule
                   ON desktop_cloud_links(schedule_id, created_at DESC);",
            )
            .map_err(error_text)?;
    }
    transaction
        .execute(
            "INSERT INTO schema_migrations (version, applied_at)
             VALUES (10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)
}

#[derive(Debug, Clone)]
pub struct LocalPromotionSource {
    pub schedule_id: Option<String>,
    pub thread_id: String,
    pub artifact_id: String,
    pub artifact_version: String,
    pub artifact_kind: String,
    pub title: String,
    pub mode: String,
}

impl LocalPromotionSource {
    pub fn from_schedule(schedule: &LocalSchedule, title: String) -> Result<Self, String> {
        let artifact_kind = schedule
            .snapshot
            .get("artifactKind")
            .and_then(Value::as_str)
            .ok_or_else(|| "The saved schedule is missing its artifact boundary.".to_string())?;
        Ok(Self {
            schedule_id: Some(schedule.id.clone()),
            thread_id: schedule.thread_id.clone(),
            artifact_id: schedule.artifact_id.clone(),
            artifact_version: schedule.artifact_version.clone(),
            artifact_kind: artifact_kind.into(),
            title,
            mode: if artifact_kind == "agent-team" {
                "run-24-7".into()
            } else {
                "sync-only".into()
            },
        })
    }
}

pub fn record_pending_promotion(
    state: &AppState,
    source: &LocalPromotionSource,
    promotion_id: &str,
    payload_hash: &str,
    review_href: &str,
    created_at: &str,
) -> Result<DesktopCloudLink, String> {
    validate_promotion_id(promotion_id)?;
    validate_payload_hash(payload_hash)?;
    validate_time(created_at, "promotion time")?;
    trusted_relative_href(review_href, "/desktop/promotion/")?;
    validate_artifact_kind(&source.artifact_kind)?;
    validate_local_id(&source.thread_id, "source thread")?;
    validate_local_id(&source.artifact_id, "source artifact")?;
    validate_local_id(&source.artifact_version, "source version")?;
    if let Some(schedule_id) = &source.schedule_id {
        validate_local_id(schedule_id, "source schedule")?;
    }
    if !matches!(source.mode.as_str(), "run-24-7" | "sync-only")
        || (source.mode == "run-24-7" && source.schedule_id.is_none())
    {
        return Err("The hosted review has the wrong local boundary.".into());
    }
    let title = bounded_text(&source.title, 120, "artifact title")?;
    let body = StoredCloudLinkBody {
        title,
        mode: source.mode.clone(),
        status: "review".into(),
        cloud_state: "review".into(),
        conflict_state: "pending-review".into(),
        local_changed: false,
        cloud_changed: false,
        cloud_revision: None,
        project_href: None,
        review_href: Some(review_href.into()),
        latest_result: None,
    };
    let sealed = seal_link_body(state, promotion_id, &body)?;
    let connection = state.connection()?;
    connection
        .execute(
            "INSERT INTO desktop_cloud_links (
                promotion_id, schedule_id, thread_id, artifact_id, source_artifact_version,
                artifact_kind, payload_hash, latest_sync_digest, body_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?9)",
            params![
                promotion_id,
                source.schedule_id,
                source.thread_id,
                source.artifact_id,
                source.artifact_version,
                source.artifact_kind,
                payload_hash,
                sealed,
                created_at,
            ],
        )
        .map_err(error_text)?;
    load_link(state, promotion_id)?
        .ok_or_else(|| "The hosted review link could not be saved on this Mac.".into())
}

pub fn reconcile(
    state: &AppState,
    response: DesktopCloudSyncResponse,
) -> Result<DesktopCloudSyncView, String> {
    validate_sync_response(&response)?;
    let mut connection = state.connection()?;
    let transaction = connection.transaction().map_err(error_text)?;
    let mut imported_results = Vec::new();

    for promotion in &response.promotions {
        let mut row = load_or_adopt_link(&transaction, state, promotion, &response.checked_at)?;
        if row.payload_hash != promotion.payload_hash {
            return Err("A hosted review no longer matches the snapshot saved on this Mac.".into());
        }
        let current_version: String = transaction
            .query_row(
                "SELECT current_version FROM artifacts WHERE id = ?1",
                params![row.artifact_id],
                |result| result.get(0),
            )
            .map_err(error_text)?;
        let local_changed = current_version != row.source_artifact_version;
        let cloud_changed = promotion.cloud.changed;
        let conflict_state = if local_changed && cloud_changed {
            "diverged"
        } else if local_changed {
            "local-changed"
        } else if cloud_changed {
            "cloud-changed"
        } else if promotion.cloud.state == "attention" {
            "attention"
        } else if promotion.cloud.state == "review" || promotion.cloud.state == "setup-required" {
            "pending-review"
        } else {
            "in-sync"
        };

        let latest_result =
            promotion
                .latest_result
                .as_ref()
                .map(|result| DesktopCloudResultSummaryBody {
                    run_id: result.run_id.clone(),
                    status: result.status.clone(),
                    summary: result_summary(result),
                    completed_at: result.completed_at.clone(),
                    receipt_href: result.receipt_href.clone(),
                });
        let body = StoredCloudLinkBody {
            title: promotion.source.title.clone(),
            mode: promotion.mode.clone(),
            status: promotion.status.clone(),
            cloud_state: promotion.cloud.state.clone(),
            conflict_state: conflict_state.into(),
            local_changed,
            cloud_changed,
            cloud_revision: promotion.cloud.revision.clone(),
            project_href: promotion.cloud.project_href.clone(),
            review_href: promotion.cloud.review_href.clone(),
            latest_result,
        };

        if let Some(result) = &promotion.latest_result {
            validate_hosted_result(result, promotion)?;
            if row.latest_sync_digest.as_deref() != Some(result.sync_digest.as_str()) {
                if import_hosted_result(&transaction, state, &row, result, &response.checked_at)? {
                    imported_results.push(DesktopCloudImportedResult {
                        thread_id: row.thread_id.clone(),
                        artifact_id: row.artifact_id.clone(),
                        artifact_kind: row.artifact_kind.clone(),
                        run_id: local_cloud_run_id(result),
                        title: format!(
                            "{} {}",
                            promotion.source.title,
                            result_status_label(&result.status)
                        ),
                        body: result_summary(result),
                    });
                }
                row.latest_sync_digest = Some(result.sync_digest.clone());
            }
        }
        row.body_json = seal_link_body(state, &row.promotion_id, &body)?;
        row.updated_at = response.checked_at.clone();
        transaction
            .execute(
                "UPDATE desktop_cloud_links
                 SET latest_sync_digest = ?2, body_json = ?3, updated_at = ?4
                 WHERE promotion_id = ?1",
                params![
                    row.promotion_id,
                    row.latest_sync_digest,
                    row.body_json,
                    row.updated_at,
                ],
            )
            .map_err(error_text)?;
    }

    transaction.commit().map_err(error_text)?;
    Ok(DesktopCloudSyncView {
        version: response.version,
        checked_at: response.checked_at,
        account: response.account,
        capabilities: response.capabilities,
        promotions: list_links(state)?,
        imported_results,
        workspace: crate::storage::bootstrap_local_workspace(state)?,
    })
}

pub fn list_links(state: &AppState) -> Result<Vec<DesktopCloudLink>, String> {
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT promotion_id, schedule_id, thread_id, artifact_id,
                    source_artifact_version, artifact_kind, payload_hash,
                    latest_sync_digest, body_json, created_at, updated_at
             FROM desktop_cloud_links ORDER BY created_at DESC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map([], cloud_link_row)
        .map_err(error_text)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error_text)?;
    rows.into_iter()
        .map(|row| link_from_row(state, row))
        .collect()
}

fn load_link(state: &AppState, promotion_id: &str) -> Result<Option<DesktopCloudLink>, String> {
    let connection = state.connection()?;
    let row = connection
        .query_row(
            "SELECT promotion_id, schedule_id, thread_id, artifact_id,
                    source_artifact_version, artifact_kind, payload_hash,
                    latest_sync_digest, body_json, created_at, updated_at
             FROM desktop_cloud_links WHERE promotion_id = ?1",
            params![promotion_id],
            cloud_link_row,
        )
        .optional()
        .map_err(error_text)?;
    row.map(|value| link_from_row(state, value)).transpose()
}

fn load_or_adopt_link(
    transaction: &Transaction<'_>,
    state: &AppState,
    promotion: &DesktopCloudPromotion,
    checked_at: &str,
) -> Result<CloudLinkRow, String> {
    if let Some(row) = transaction
        .query_row(
            "SELECT promotion_id, schedule_id, thread_id, artifact_id,
                    source_artifact_version, artifact_kind, payload_hash,
                    latest_sync_digest, body_json, created_at, updated_at
             FROM desktop_cloud_links WHERE promotion_id = ?1",
            params![promotion.promotion_id],
            cloud_link_row,
        )
        .optional()
        .map_err(error_text)?
    {
        if row.schedule_id != promotion.source.schedule_id
            || promotion
                .source
                .thread_id
                .as_deref()
                .is_some_and(|thread_id| thread_id != row.thread_id)
            || row.artifact_id != promotion.source.artifact_id
            || row.source_artifact_version != promotion.source.artifact_version
            || row.artifact_kind != promotion.source.artifact_kind
        {
            return Err("A hosted review points to different local work.".into());
        }
        let stored_body: StoredCloudLinkBody = serde_json::from_value(open_body(
            state,
            &link_context(&row.promotion_id),
            &row.body_json,
        )?)
        .map_err(error_text)?;
        if stored_body.title != promotion.source.title || stored_body.mode != promotion.mode {
            return Err("A hosted review points to different local work.".into());
        }
        return Ok(row);
    }

    let association = if let Some(schedule_id) = &promotion.source.schedule_id {
        transaction
            .query_row(
                "SELECT s.thread_id, s.artifact_id, s.artifact_version, a.kind
                 FROM local_schedules s
                 JOIN artifacts a ON a.id = s.artifact_id
                 WHERE s.id = ?1 AND s.deleted_at IS NULL",
                params![schedule_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(error_text)?
            .ok_or_else(|| {
                "A hosted review no longer has its original local schedule.".to_string()
            })?
    } else {
        let thread_id =
            promotion.source.thread_id.as_deref().ok_or_else(|| {
                "A hosted review is missing its original local Thread.".to_string()
            })?;
        transaction
            .query_row(
                "SELECT t.id, a.id, a.current_version, a.kind
                 FROM artifacts a
                 JOIN threads t ON t.id = ?1
                 WHERE a.id = ?2",
                params![thread_id, promotion.source.artifact_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(error_text)?
            .ok_or_else(|| {
                "A hosted review no longer has its original local artifact.".to_string()
            })?
    };
    if association.1 != promotion.source.artifact_id
        || association.2 != promotion.source.artifact_version
        || association.3 != promotion.source.artifact_kind
    {
        return Err("A hosted review no longer matches its original local schedule.".into());
    }
    let body = StoredCloudLinkBody {
        title: promotion.source.title.clone(),
        mode: promotion.mode.clone(),
        status: promotion.status.clone(),
        cloud_state: promotion.cloud.state.clone(),
        conflict_state: "pending-review".into(),
        local_changed: false,
        cloud_changed: promotion.cloud.changed,
        cloud_revision: promotion.cloud.revision.clone(),
        project_href: promotion.cloud.project_href.clone(),
        review_href: promotion.cloud.review_href.clone(),
        latest_result: None,
    };
    let sealed = seal_link_body(state, &promotion.promotion_id, &body)?;
    transaction
        .execute(
            "INSERT INTO desktop_cloud_links (
                promotion_id, schedule_id, thread_id, artifact_id, source_artifact_version,
                artifact_kind, payload_hash, latest_sync_digest, body_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10)",
            params![
                promotion.promotion_id,
                promotion.source.schedule_id,
                association.0,
                promotion.source.artifact_id,
                promotion.source.artifact_version,
                promotion.source.artifact_kind,
                promotion.payload_hash,
                sealed,
                promotion.created_at,
                checked_at,
            ],
        )
        .map_err(error_text)?;
    Ok(CloudLinkRow {
        promotion_id: promotion.promotion_id.clone(),
        schedule_id: promotion.source.schedule_id.clone(),
        thread_id: association.0,
        artifact_id: promotion.source.artifact_id.clone(),
        source_artifact_version: promotion.source.artifact_version.clone(),
        artifact_kind: promotion.source.artifact_kind.clone(),
        payload_hash: promotion.payload_hash.clone(),
        latest_sync_digest: None,
        body_json: sealed,
        created_at: promotion.created_at.clone(),
        updated_at: checked_at.into(),
    })
}

fn import_hosted_result(
    transaction: &Transaction<'_>,
    state: &AppState,
    link: &CloudLinkRow,
    result: &DesktopHostedResult,
    imported_at: &str,
) -> Result<bool, String> {
    let run_id = local_cloud_run_id(result);
    let receipt_id = local_cloud_receipt_id(result);
    if let Some(existing) = transaction
        .query_row(
            "SELECT body_json FROM receipts WHERE id = ?1",
            params![receipt_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error_text)?
    {
        let body = open_body(state, &format!("receipts:{receipt_id}"), &existing)?;
        if body["details"]["syncDigest"] != result.sync_digest {
            return Err("A hosted receipt identifier was reused with different evidence.".into());
        }
        return Ok(false);
    }

    let status = if result.status == "completed" {
        "completed"
    } else {
        "failed"
    };
    let summary = result_summary(result);
    transaction
        .execute(
            "INSERT INTO runs (id, thread_id, artifact_id, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                run_id,
                link.thread_id,
                link.artifact_id,
                status,
                result.completed_at,
                imported_at
            ],
        )
        .map_err(error_text)?;
    for (sequence, event_type, payload) in [
        (
            1_i64,
            "run.queued",
            json!({
                "status": "queued",
                "provider": "codelit-cloud",
                "hostedRunId": result.run_id,
                "promotionId": result.promotion_id,
            }),
        ),
        (
            2_i64,
            if result.status == "completed" {
                "run.completed"
            } else {
                "run.failed"
            },
            json!({
                "status": result.status,
                "provider": "codelit-cloud",
                "message": summary,
                "receiptDigest": result.receipt_digest,
            }),
        ),
    ] {
        let context = format!("run-events:{run_id}:{sequence}");
        let sealed = state.cipher().seal(&context, &payload.to_string())?;
        transaction
            .execute(
                "INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![run_id, sequence, event_type, sealed, result.completed_at],
            )
            .map_err(error_text)?;
    }

    let receipt_body = json!({
        "status": result.status,
        "summary": summary,
        "runId": run_id,
        "artifactId": link.artifact_id,
        "provider": "codelit-cloud",
        "model": result.workflow_version.as_deref().unwrap_or("hosted"),
        "eventCount": 2,
        "billingFallback": false,
        "details": {
            "hostedRunId": result.run_id,
            "promotionId": result.promotion_id,
            "receiptDigest": result.receipt_digest,
            "syncDigest": result.sync_digest,
            "completedAt": result.completed_at,
            "steps": result.steps,
            "totalApproxUsd": result.total_approx_usd,
            "result": result.result,
            "error": result.error,
        },
    });
    let sealed_receipt = state
        .cipher()
        .seal(&format!("receipts:{receipt_id}"), &receipt_body.to_string())?;
    transaction
        .execute(
            "INSERT INTO receipts (id, run_id, artifact_id, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                receipt_id,
                run_id,
                link.artifact_id,
                sealed_receipt,
                result.completed_at
            ],
        )
        .map_err(error_text)?;

    let receipt_artifact_id = "artifact-receipt-local";
    let receipt_version = format!("cloud-{}", &result.sync_digest[7..47]);
    let sealed_artifact = state.cipher().seal(
        &format!("artifact-versions:{receipt_artifact_id}:{receipt_version}"),
        &receipt_body.to_string(),
    )?;
    transaction
        .execute(
            "INSERT INTO artifact_versions (artifact_id, version, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                receipt_artifact_id,
                receipt_version,
                sealed_artifact,
                result.completed_at
            ],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "UPDATE artifacts SET current_version = ?2, updated_at = ?3 WHERE id = ?1",
            params![receipt_artifact_id, receipt_version, imported_at],
        )
        .map_err(error_text)?;

    let (thread_json, current_sequence, current_status): (String, i64, String) = transaction
        .query_row(
            "SELECT body_json, latest_block_sequence, status FROM threads WHERE id = ?1",
            params![link.thread_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(error_text)?;
    let run_sequence = current_sequence + 1;
    let receipt_sequence = current_sequence + 2;
    let run_block = json!({
        "id": format!("block-{run_id}"),
        "sequence": run_sequence,
        "createdAt": result.completed_at,
        "type": "run",
        "runId": run_id,
        "label": "Codelit Cloud run",
        "detail": summary,
        "status": if result.status == "completed" { "completed" } else { "failed" },
    });
    let receipt_block = json!({
        "id": format!("block-receipt-{run_id}"),
        "sequence": receipt_sequence,
        "createdAt": result.completed_at,
        "type": "receipt",
        "artifact": {
            "kind": "receipt",
            "id": receipt_artifact_id,
            "version": receipt_version,
            "projectId": "local-project",
            "title": "Hosted run receipt",
            "editorHref": "/local/receipt/artifact-receipt-local",
            "createdAt": result.completed_at,
        },
        "summary": "Codelit Cloud returned a verified hosted receipt to this Mac.",
    });
    for (sequence, kind, block) in [
        (run_sequence, "run", run_block),
        (receipt_sequence, "receipt", receipt_block),
    ] {
        let sealed = state.cipher().seal(
            &format!("thread-blocks:{}:{sequence}", link.thread_id),
            &block.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO thread_blocks (thread_id, sequence, id, kind, body_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    link.thread_id,
                    sequence,
                    block["id"].as_str(),
                    kind,
                    sealed,
                    result.completed_at
                ],
            )
            .map_err(error_text)?;
    }

    let mut thread = open_body(state, &format!("threads:{}", link.thread_id), &thread_json)?;
    let local_run_active = matches!(current_status.as_str(), "working" | "needs-input");
    let next_status = if local_run_active {
        current_status.as_str()
    } else if result.status == "completed" {
        "completed"
    } else {
        "failed"
    };
    thread["latestBlockSequence"] = json!(receipt_sequence);
    thread["status"] = json!(next_status);
    thread["updatedAt"] = json!(imported_at);
    if !local_run_active {
        thread["activeRunRef"] = json!(run_id);
    }
    if let Some(reference) = thread
        .get_mut("activeArtifactRefs")
        .and_then(Value::as_array_mut)
        .and_then(|references| {
            references.iter_mut().find(|reference| {
                reference.get("id").and_then(Value::as_str) == Some(receipt_artifact_id)
            })
        })
    {
        reference["version"] = json!(receipt_version);
        reference["createdAt"] = json!(result.completed_at);
    }
    let sealed_thread = state
        .cipher()
        .seal(&format!("threads:{}", link.thread_id), &thread.to_string())?;
    transaction
        .execute(
            "UPDATE threads SET body_json = ?2, status = ?3, latest_block_sequence = ?4,
                    active_run_ref = CASE WHEN ?5 THEN active_run_ref ELSE ?6 END, updated_at = ?7
             WHERE id = ?1",
            params![
                link.thread_id,
                sealed_thread,
                next_status,
                receipt_sequence,
                local_run_active,
                run_id,
                imported_at,
            ],
        )
        .map_err(error_text)?;
    Ok(true)
}

fn validate_sync_response(response: &DesktopCloudSyncResponse) -> Result<(), String> {
    if response.version != 1
        || response.promotions.len() > MAX_PROMOTIONS
        || response.capabilities.len() > 8
    {
        return Err("Codelit Cloud returned an unsupported sync response.".into());
    }
    validate_time(&response.checked_at, "sync time")?;
    if !matches!(response.account.plan.as_str(), "free" | "pro" | "max")
        || !matches!(
            response.account.status.as_str(),
            "free" | "active" | "trialing" | "attention"
        )
        || !matches!(response.account.commerce.as_str(), "direct" | "app-store")
        || !matches!(
            response.account.source.as_str(),
            "stripe" | "app-store" | "account"
        )
        || !matches!(
            response.account.build_channel.as_str(),
            "direct" | "app-store" | "development"
        )
    {
        return Err("Codelit Cloud returned invalid account access.".into());
    }
    let channel = crate::hosted_bridge::build_channel();
    if (channel == "app-store"
        && (response.account.build_channel != "app-store"
            || response.account.commerce != "app-store"
            || response
                .capabilities
                .iter()
                .any(|capability| capability.href.is_some())))
        || (channel == "direct"
            && (response.account.build_channel != "direct"
                || response.account.commerce != "direct"))
    {
        return Err(
            "Codelit Cloud returned account access for a different Mac distribution channel."
                .into(),
        );
    }
    if response.account.limits.hosted_workflows > 10_000
        || response.account.limits.managed_browser_minutes > 1_000_000
        || response.account.limits.workspace_seats > 10_000
    {
        return Err("Codelit Cloud returned invalid account limits.".into());
    }
    bounded_text(&response.account.plan_name, 80, "plan name")?;
    bounded_text(
        &response.account.entitlement_version,
        180,
        "entitlement version",
    )?;
    for capability in &response.capabilities {
        if !matches!(
            capability.id.as_str(),
            "run-24-7" | "cloud-browser" | "public-trigger" | "collaboration"
        ) || !matches!(capability.required_plan.as_str(), "pro" | "max")
        {
            return Err("Codelit Cloud returned an unknown capability.".into());
        }
        bounded_text(&capability.title, 80, "capability title")?;
        bounded_text(&capability.detail, 300, "capability detail")?;
        if let Some(href) = &capability.href {
            trusted_relative_href(href, "/pricing")?;
        }
    }
    for promotion in &response.promotions {
        validate_promotion(promotion)?;
    }
    Ok(())
}

fn validate_promotion(promotion: &DesktopCloudPromotion) -> Result<(), String> {
    validate_promotion_id(&promotion.promotion_id)?;
    validate_payload_hash(&promotion.payload_hash)?;
    validate_time(&promotion.created_at, "promotion time")?;
    if let Some(value) = &promotion.imported_at {
        validate_time(value, "promotion import time")?;
    }
    if let Some(value) = &promotion.completed_at {
        validate_time(value, "promotion completion time")?;
    }
    if !matches!(
        promotion.status.as_str(),
        "review" | "imported" | "completed" | "cancelled"
    ) || !matches!(promotion.mode.as_str(), "run-24-7" | "sync-only")
        || !matches!(
            promotion.readiness.as_str(),
            "ready-for-cloud-review" | "needs-cloud-setup" | "sync-only"
        )
        || !matches!(
            promotion.cloud.state.as_str(),
            "review" | "setup-required" | "active" | "paused" | "synced" | "changed" | "attention"
        )
    {
        return Err("Codelit Cloud returned an invalid hosted review state.".into());
    }
    if let Some(value) = &promotion.source.thread_id {
        validate_local_id(value, "source thread")?;
    }
    if let Some(value) = &promotion.source.schedule_id {
        validate_local_id(value, "source schedule")?;
    }
    if promotion.source.schedule_id.is_none() && promotion.source.thread_id.is_none() {
        return Err("The hosted review has no local source.".into());
    }
    if promotion.mode == "run-24-7" && promotion.source.schedule_id.is_none() {
        return Err("The hosted 24/7 review has no source schedule.".into());
    }
    validate_local_id(&promotion.source.artifact_id, "source artifact")?;
    validate_local_id(&promotion.source.artifact_version, "source version")?;
    validate_artifact_kind(&promotion.source.artifact_kind)?;
    bounded_text(&promotion.source.title, 120, "source title")?;
    if let Some(value) = &promotion.cloud.revision {
        validate_sha256(value, "cloud revision")?;
    }
    for (value, label) in [
        (&promotion.cloud.project_id, "cloud project"),
        (&promotion.cloud.artifact_id, "cloud artifact"),
        (&promotion.cloud.deployment_id, "cloud deployment"),
    ] {
        if let Some(value) = value {
            validate_local_id(value, label)?;
        }
    }
    if let Some(href) = &promotion.cloud.review_href {
        trusted_relative_href(href, "/desktop/promotion/")?;
    }
    if let Some(href) = &promotion.cloud.project_href {
        trusted_relative_href(href, "/projects/")?;
    }
    Ok(())
}

fn validate_hosted_result(
    result: &DesktopHostedResult,
    promotion: &DesktopCloudPromotion,
) -> Result<(), String> {
    if result.version != 1
        || result.promotion_id != promotion.promotion_id
        || result.payload_hash != promotion.payload_hash
        || promotion.source.schedule_id.as_deref() != Some(result.source_schedule_id.as_str())
        || result.source_artifact_id != promotion.source.artifact_id
        || result.source_artifact_version != promotion.source.artifact_version
        || result.artifact_kind != promotion.source.artifact_kind
        || promotion.cloud.deployment_id.as_deref() != Some(result.deployment_id.as_str())
        || promotion.cloud.project_id.as_deref() != Some(result.project_id.as_str())
        || promotion.cloud.artifact_id.as_deref() != Some(result.artifact_id.as_str())
        || !matches!(result.status.as_str(), "completed" | "halted" | "failed")
        || result.recovery_attempt > 20
        || result.steps > 100
        || bounded_json_number(&result.total_approx_usd, 10_000.0).is_none()
        || result.duration_ms.as_ref().is_some_and(|value| {
            bounded_json_number(value, 30.0 * 24.0 * 60.0 * 60_000.0).is_none()
        })
    {
        return Err("A hosted result does not match its reviewed local snapshot.".into());
    }
    for (value, label) in [
        (&result.deployment_id, "deployment"),
        (&result.project_id, "project"),
        (&result.artifact_id, "cloud artifact"),
        (&result.run_id, "hosted run"),
    ] {
        validate_local_id(value, label)?;
    }
    validate_time(&result.completed_at, "completion time")?;
    if let Some(value) = &result.run_created_at {
        validate_time(value, "run creation time")?;
    }
    if let Some(value) = &result.started_at {
        validate_time(value, "run start time")?;
    }
    bounded_text(&result.workflow_name, 120, "workflow name")?;
    if let Some(value) = &result.workflow_version {
        validate_sha256(value, "workflow version")?;
    }
    if let Some(value) = &result.result {
        bounded_text_allow_empty(value, MAX_RESULT_LENGTH, "hosted result")?;
    }
    if let Some(value) = &result.error {
        bounded_text_allow_empty(value, MAX_ERROR_LENGTH, "hosted error")?;
    }
    validate_sha256(&result.receipt_digest, "receipt digest")?;
    validate_sha256(&result.sync_digest, "sync digest")?;
    trusted_relative_href(&result.receipt_href, "/inbox?")?;
    if result.receipt_href != format!("/inbox?run={}", result.run_id) {
        return Err("The hosted receipt link is invalid.".into());
    }
    let mut value = serde_json::to_value(result).map_err(error_text)?;
    value
        .as_object_mut()
        .ok_or_else(|| "The hosted result is invalid.".to_string())?
        .remove("syncDigest");
    let actual = format!(
        "sha256:{:x}",
        Sha256::digest(canonical_json(&value)?.as_bytes())
    );
    if actual != result.sync_digest {
        return Err("A hosted result failed sync integrity validation.".into());
    }
    Ok(())
}

fn result_summary(result: &DesktopHostedResult) -> String {
    result
        .result
        .as_deref()
        .or(result.error.as_deref())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("Hosted run {}.", result_status_label(&result.status)))
}

fn result_status_label(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "halted" => "needs review",
        _ => "failed",
    }
}

fn local_cloud_run_id(result: &DesktopHostedResult) -> String {
    let digest = Sha256::digest(format!(
        "codelit-local-cloud-run-v1\n{}\n{}\n{}\n{}",
        result.promotion_id, result.run_id, result.status, result.recovery_attempt
    ));
    format!("cloud-run-{}", hex_prefix(&digest, 20))
}

fn local_cloud_receipt_id(result: &DesktopHostedResult) -> String {
    format!("receipt-{}", local_cloud_run_id(result))
}

fn cloud_link_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CloudLinkRow> {
    Ok(CloudLinkRow {
        promotion_id: row.get(0)?,
        schedule_id: row.get(1)?,
        thread_id: row.get(2)?,
        artifact_id: row.get(3)?,
        source_artifact_version: row.get(4)?,
        artifact_kind: row.get(5)?,
        payload_hash: row.get(6)?,
        latest_sync_digest: row.get(7)?,
        body_json: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn link_from_row(state: &AppState, row: CloudLinkRow) -> Result<DesktopCloudLink, String> {
    let body: StoredCloudLinkBody = serde_json::from_value(open_body(
        state,
        &link_context(&row.promotion_id),
        &row.body_json,
    )?)
    .map_err(error_text)?;
    Ok(DesktopCloudLink {
        promotion_id: row.promotion_id,
        schedule_id: row.schedule_id,
        thread_id: row.thread_id,
        artifact_id: row.artifact_id,
        source_artifact_version: row.source_artifact_version,
        artifact_kind: row.artifact_kind,
        title: body.title,
        payload_hash: row.payload_hash,
        mode: body.mode,
        status: body.status,
        cloud_state: body.cloud_state,
        conflict_state: body.conflict_state,
        local_changed: body.local_changed,
        cloud_changed: body.cloud_changed,
        cloud_revision: body.cloud_revision,
        project_href: body.project_href,
        review_href: body.review_href,
        latest_result: body.latest_result.map(|value| DesktopCloudResultSummary {
            run_id: value.run_id,
            status: value.status,
            summary: value.summary,
            completed_at: value.completed_at,
            receipt_href: value.receipt_href,
        }),
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn seal_link_body(
    state: &AppState,
    promotion_id: &str,
    body: &StoredCloudLinkBody,
) -> Result<String, String> {
    state.cipher().seal(
        &link_context(promotion_id),
        &serde_json::to_string(body).map_err(error_text)?,
    )
}

fn open_body(state: &AppState, context: &str, body: &str) -> Result<Value, String> {
    let plaintext = state.cipher().open(context, body)?;
    serde_json::from_str(&plaintext).map_err(error_text)
}

fn link_context(promotion_id: &str) -> String {
    format!("desktop-cloud-link:{promotion_id}")
}

fn trusted_relative_href(value: &str, prefix: &str) -> Result<(), String> {
    if !value.starts_with(prefix)
        || value.starts_with("//")
        || value.contains("\\")
        || value.chars().any(char::is_control)
        || value.len() > 500
    {
        return Err("Codelit Cloud returned an untrusted link.".into());
    }
    Ok(())
}

fn validate_promotion_id(value: &str) -> Result<(), String> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("The hosted review identifier is invalid.".into());
    }
    Ok(())
}

fn validate_payload_hash(value: &str) -> Result<(), String> {
    if value.len() != 43
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("The hosted review fingerprint is invalid.".into());
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("The hosted {label} is invalid."));
    }
    Ok(())
}

fn validate_local_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 180
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
    {
        return Err(format!("The hosted {label} identifier is invalid."));
    }
    Ok(())
}

fn validate_artifact_kind(value: &str) -> Result<(), String> {
    if !matches!(value, "agent-team" | "product-plan" | "architecture") {
        return Err("The hosted artifact type is invalid.".into());
    }
    Ok(())
}

fn validate_time(value: &str, label: &str) -> Result<(), String> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| format!("The hosted {label} is invalid."))
}

fn bounded_json_number(value: &Value, maximum: f64) -> Option<f64> {
    let value = value.as_f64()?;
    (value.is_finite() && value >= 0.0 && value <= maximum).then_some(value)
}

fn bounded_text(value: &str, maximum: usize, label: &str) -> Result<String, String> {
    let clean = value.trim();
    if clean.is_empty() || clean.len() > maximum || clean.chars().any(char::is_control) {
        return Err(format!("The hosted {label} is invalid."));
    }
    Ok(clean.into())
}

fn bounded_text_allow_empty(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    if value.len() > maximum || value.chars().any(char::is_control) {
        return Err(format!("The hosted {label} is invalid."));
    }
    Ok(())
}

fn canonical_json(value: &Value) -> Result<String, String> {
    match value {
        Value::Null => Ok("null".into()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::String(value) => serde_json::to_string(value).map_err(error_text),
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            Ok(format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, nested)| Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(error_text)?,
                        canonical_json(nested)?
                    )))
                    .collect::<Result<Vec<_>, String>>()?
                    .join(",")
            ))
        }
    }
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    bytes
        .iter()
        .take(count)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
fn canonical_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler::{SaveLocalScheduleRequest, save_local_schedule};
    use crate::storage::{SaveArtifactRequest, save_artifact_version};
    use tempfile::tempdir;

    fn schedule(state: &AppState) -> LocalSchedule {
        save_local_schedule(
            state,
            SaveLocalScheduleRequest {
                id: "schedule-cloud".into(),
                expected_revision: None,
                thread_id: "local-welcome".into(),
                artifact_id: "artifact-agent-local".into(),
                artifact_version: "v1".into(),
                title: "Release team".into(),
                enabled: true,
                cadence: "daily".into(),
                local_time: "09:00".into(),
                timezone: "America/Denver".into(),
                weekdays: vec![],
                missed_policy: "run-once".into(),
                max_retries: 2,
                provider: "codex".into(),
                model: "default".into(),
                requires_network: true,
                snapshot: json!({
                    "artifactKind": "agent-team",
                    "artifactTitle": "Release team",
                    "artifactPayload": { "goal": "Ship safely" },
                }),
                one_time_at: None,
            },
        )
        .expect("schedule")
    }

    fn response(promotion_id: &str, payload_hash: &str) -> DesktopCloudSyncResponse {
        let channel = crate::hosted_bridge::build_channel();
        let mut result = DesktopHostedResult {
            version: 1,
            promotion_id: promotion_id.into(),
            payload_hash: payload_hash.into(),
            deployment_id: "deployment-cloud".into(),
            project_id: "project-cloud".into(),
            artifact_id: "artifact-cloud".into(),
            source_schedule_id: "schedule-cloud".into(),
            source_artifact_id: "artifact-agent-local".into(),
            source_artifact_version: "v1".into(),
            artifact_kind: "agent-team".into(),
            run_id: "hosted-run-1".into(),
            recovery_attempt: 0,
            status: "completed".into(),
            workflow_name: "Release team".into(),
            workflow_version: Some(format!("sha256:{}", "a".repeat(64))),
            run_created_at: Some("2026-08-11T14:00:00.000Z".into()),
            started_at: Some("2026-08-11T14:00:01.000Z".into()),
            completed_at: "2026-08-11T14:00:03.000Z".into(),
            steps: 3,
            total_approx_usd: json!(0.04),
            duration_ms: Some(json!(2000)),
            result: Some("Release verified.".into()),
            error: None,
            receipt_digest: format!("sha256:{}", "b".repeat(64)),
            receipt_href: "/inbox?run=hosted-run-1".into(),
            sync_digest: String::new(),
        };
        let mut result_value = serde_json::to_value(&result).expect("result value");
        result_value.as_object_mut().unwrap().remove("syncDigest");
        result.sync_digest = format!(
            "sha256:{:x}",
            Sha256::digest(canonical_json(&result_value).expect("canonical").as_bytes())
        );
        DesktopCloudSyncResponse {
            version: 1,
            checked_at: "2026-08-11T14:01:00.000Z".into(),
            account: DesktopCloudAccount {
                plan: "pro".into(),
                plan_name: "Pro".into(),
                entitlement_version: "entitlement-1".into(),
                status: "active".into(),
                source: if channel == "app-store" {
                    "account"
                } else {
                    "stripe"
                }
                .into(),
                build_channel: channel.into(),
                commerce: if channel == "app-store" {
                    "app-store"
                } else {
                    "direct"
                }
                .into(),
                limits: DesktopCloudLimits {
                    hosted_workflows: 1,
                    managed_browser_minutes: 15,
                    workspace_seats: 1,
                },
            },
            capabilities: vec![DesktopCloudCapability {
                id: "run-24-7".into(),
                available: true,
                required_plan: "pro".into(),
                title: "Run 24/7".into(),
                detail: "Keep one workflow running.".into(),
                href: None,
            }],
            promotions: vec![DesktopCloudPromotion {
                promotion_id: promotion_id.into(),
                status: "completed".into(),
                payload_hash: payload_hash.into(),
                mode: "run-24-7".into(),
                readiness: "ready-for-cloud-review".into(),
                created_at: "2026-08-11T13:00:00.000Z".into(),
                imported_at: Some("2026-08-11T13:10:00.000Z".into()),
                completed_at: Some("2026-08-11T13:20:00.000Z".into()),
                source: DesktopCloudSource {
                    thread_id: Some("local-welcome".into()),
                    schedule_id: Some("schedule-cloud".into()),
                    artifact_id: "artifact-agent-local".into(),
                    artifact_version: "v1".into(),
                    artifact_kind: "agent-team".into(),
                    title: "Release team".into(),
                },
                cloud: DesktopCloudState {
                    state: "active".into(),
                    changed: false,
                    revision: Some(format!("sha256:{}", "c".repeat(64))),
                    project_id: Some("project-cloud".into()),
                    artifact_id: Some("artifact-cloud".into()),
                    deployment_id: Some("deployment-cloud".into()),
                    review_href: None,
                    project_href: Some("/projects/project-cloud".into()),
                },
                latest_result: Some(result),
            }],
        }
    }

    fn promotion_source(schedule: &LocalSchedule) -> LocalPromotionSource {
        LocalPromotionSource::from_schedule(schedule, "Release team".into())
            .expect("promotion source")
    }

    fn artifact_source() -> LocalPromotionSource {
        LocalPromotionSource {
            schedule_id: None,
            thread_id: "local-welcome".into(),
            artifact_id: "artifact-agent-local".into(),
            artifact_version: "v1".into(),
            artifact_kind: "agent-team".into(),
            title: "Local release team".into(),
            mode: "sync-only".into(),
        }
    }

    fn direct_response(promotion_id: &str, payload_hash: &str) -> DesktopCloudSyncResponse {
        let mut value = response(promotion_id, payload_hash);
        let promotion = &mut value.promotions[0];
        promotion.status = "imported".into();
        promotion.mode = "sync-only".into();
        promotion.readiness = "needs-cloud-setup".into();
        promotion.completed_at = None;
        promotion.source.schedule_id = None;
        promotion.source.title = "Local release team".into();
        promotion.cloud.state = "setup-required".into();
        promotion.cloud.deployment_id = None;
        promotion.latest_result = None;
        value
    }

    #[test]
    fn release_profiles_reject_cloud_commerce_for_another_distribution_channel() {
        let channel = crate::hosted_bridge::build_channel();
        if channel == "development" {
            return;
        }
        let mut mismatched = response(&"x".repeat(32), &"y".repeat(43));
        mismatched.account.build_channel = if channel == "app-store" {
            "direct"
        } else {
            "app-store"
        }
        .into();
        mismatched.account.commerce = mismatched.account.build_channel.clone();
        assert_eq!(
            validate_sync_response(&mismatched).unwrap_err(),
            "Codelit Cloud returned account access for a different Mac distribution channel."
        );

        if channel == "app-store" {
            let mut checkout = response(&"a".repeat(32), &"b".repeat(43));
            checkout.capabilities[0].available = false;
            checkout.capabilities[0].href =
                Some("/pricing?source=desktop&placement=capability".into());
            assert!(validate_sync_response(&checkout).is_err());
        }
    }

    #[test]
    fn stores_and_reconciles_artifact_bound_cloud_links_without_a_schedule() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let promotion_id = "a".repeat(32);
        let payload_hash = "b".repeat(43);
        let link = record_pending_promotion(
            &state,
            &artifact_source(),
            &promotion_id,
            &payload_hash,
            &format!("/desktop/promotion/{promotion_id}"),
            "2026-08-11T13:00:00.000Z",
        )
        .expect("artifact promotion link");
        assert_eq!(link.schedule_id, None);
        assert_eq!(link.thread_id, "local-welcome");

        let synced = reconcile(&state, direct_response(&promotion_id, &payload_hash))
            .expect("direct artifact sync");
        assert!(synced.imported_results.is_empty());
        assert_eq!(synced.promotions[0].cloud_state, "setup-required");
        assert_eq!(synced.promotions[0].conflict_state, "pending-review");
    }

    #[test]
    fn migrates_v9_schedule_links_to_nullable_artifact_links_without_data_loss() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let schedule = schedule(&state);
        let promotion_id = "m".repeat(32);
        record_pending_promotion(
            &state,
            &promotion_source(&schedule),
            &promotion_id,
            &"n".repeat(43),
            &format!("/desktop/promotion/{promotion_id}"),
            "2026-08-11T13:00:00.000Z",
        )
        .expect("old promotion link");

        let connection = state.connection().expect("connection");
        connection
            .execute_batch(
                "DELETE FROM schema_migrations WHERE version = 10;
                 DROP INDEX idx_desktop_cloud_links_schedule;
                 ALTER TABLE desktop_cloud_links RENAME TO desktop_cloud_links_nullable;
                 CREATE TABLE desktop_cloud_links (
                    promotion_id TEXT PRIMARY KEY,
                    schedule_id TEXT NOT NULL,
                    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
                    source_artifact_version TEXT NOT NULL,
                    artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('agent-team', 'product-plan', 'architecture')),
                    payload_hash TEXT NOT NULL,
                    latest_sync_digest TEXT,
                    body_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 INSERT INTO desktop_cloud_links SELECT * FROM desktop_cloud_links_nullable;
                 DROP TABLE desktop_cloud_links_nullable;
                 CREATE INDEX idx_desktop_cloud_links_schedule
                   ON desktop_cloud_links(schedule_id, created_at DESC);",
            )
            .expect("v9 fixture");
        migrate(&connection).expect("v10 migration");

        let schedule_not_null: bool = connection
            .prepare("PRAGMA table_info(desktop_cloud_links)")
            .expect("table info")
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, bool>(3)?))
            })
            .expect("columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("column rows")
            .into_iter()
            .find(|(name, _)| name == "schedule_id")
            .expect("schedule column")
            .1;
        let preserved: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM desktop_cloud_links WHERE promotion_id = ?1",
                params![promotion_id],
                |row| row.get(0),
            )
            .expect("preserved link");
        assert!(!schedule_not_null);
        assert_eq!(preserved, 1);
    }

    #[test]
    fn stores_encrypted_promotion_links_and_imports_one_receipt_once() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let schedule = schedule(&state);
        let promotion_id = "p".repeat(32);
        let payload_hash = "h".repeat(43);
        let source = promotion_source(&schedule);
        let link = record_pending_promotion(
            &state,
            &source,
            &promotion_id,
            &payload_hash,
            &format!("/desktop/promotion/{promotion_id}"),
            "2026-08-11T13:00:00.000Z",
        )
        .expect("promotion link");
        assert_eq!(link.conflict_state, "pending-review");

        let connection = state.connection().expect("connection");
        let body: String = connection
            .query_row(
                "SELECT body_json FROM desktop_cloud_links WHERE promotion_id = ?1",
                params![promotion_id],
                |row| row.get(0),
            )
            .expect("link body");
        assert!(crate::crypto::DataCipher::is_sealed(&body));
        assert!(!body.contains("Release team"));
        drop(connection);

        let first = reconcile(&state, response(&promotion_id, &payload_hash)).expect("first sync");
        assert_eq!(first.imported_results.len(), 1);
        assert_eq!(first.promotions[0].conflict_state, "in-sync");
        assert_eq!(first.workspace.receipts.len(), 1);
        let second = reconcile(&state, response(&promotion_id, &payload_hash)).expect("retry sync");
        assert!(second.imported_results.is_empty());
        assert_eq!(second.workspace.receipts.len(), 1);
        assert_eq!(second.workspace.blocks.len(), first.workspace.blocks.len());
    }

    #[test]
    fn reports_divergence_without_overwriting_either_artifact() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let schedule = schedule(&state);
        let promotion_id = "q".repeat(32);
        let payload_hash = "j".repeat(43);
        let source = promotion_source(&schedule);
        record_pending_promotion(
            &state,
            &source,
            &promotion_id,
            &payload_hash,
            &format!("/desktop/promotion/{promotion_id}"),
            "2026-08-11T13:00:00.000Z",
        )
        .expect("promotion link");
        save_artifact_version(
            &state,
            SaveArtifactRequest {
                thread_id: "local-welcome".into(),
                artifact_id: "artifact-agent-local".into(),
                kind: "agent-team".into(),
                version: "v2-local".into(),
                title: "Local edit".into(),
                project_id: "local-project".into(),
                payload: json!({ "goal": "Changed locally" }),
                created_at: canonical_now(),
            },
        )
        .expect("local edit");
        let mut cloud = response(&promotion_id, &payload_hash);
        cloud.promotions[0].cloud.changed = true;
        cloud.promotions[0].cloud.state = "changed".into();
        let synced = reconcile(&state, cloud).expect("divergent sync");
        assert_eq!(synced.promotions[0].conflict_state, "diverged");
        let artifact = synced
            .workspace
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == "artifact-agent-local")
            .expect("local artifact");
        assert_eq!(artifact.version, "v2-local");
        assert_eq!(artifact.payload["goal"], "Changed locally");
    }

    #[test]
    fn rejects_tampered_results_before_local_writes() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let schedule = schedule(&state);
        let promotion_id = "r".repeat(32);
        let payload_hash = "k".repeat(43);
        let source = promotion_source(&schedule);
        record_pending_promotion(
            &state,
            &source,
            &promotion_id,
            &payload_hash,
            &format!("/desktop/promotion/{promotion_id}"),
            "2026-08-11T13:00:00.000Z",
        )
        .expect("promotion link");
        let mut tampered = response(&promotion_id, &payload_hash);
        tampered.promotions[0]
            .latest_result
            .as_mut()
            .unwrap()
            .result = Some("Different".into());
        assert!(
            reconcile(&state, tampered)
                .unwrap_err()
                .contains("integrity")
        );
        assert!(
            crate::storage::bootstrap_local_workspace(&state)
                .expect("workspace")
                .receipts
                .is_empty()
        );
    }
}
