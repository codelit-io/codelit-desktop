use crate::storage::AppState;
use rusqlite::params;
use serde::Serialize;

const MAX_ACTIVITY_ITEMS: usize = 60;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineActivityItem {
    pub id: String,
    pub bot_id: String,
    pub bot_name: String,
    pub routine_id: String,
    pub title: String,
    pub trigger_kind: String,
    pub status: String,
    pub run_id: String,
    pub occurred_at: String,
}

pub fn list_recent_routine_activity(state: &AppState) -> Result<Vec<RoutineActivityItem>, String> {
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT id, bot_id, bot_name, routine_id, title, trigger_kind, status, run_id, occurred_at
             FROM (
                SELECT o.idempotency_key AS id, b.id AS bot_id, b.name AS bot_name,
                       s.id AS routine_id, b.name || ' routine' AS title,
                       'schedule' AS trigger_kind,
                       CASE
                         WHEN o.status = 'paused' AND o.next_attempt_at IS NULL THEN 'attention'
                         WHEN o.status IN ('paused', 'retry') THEN 'retrying'
                         ELSE o.status
                       END AS status,
                       o.run_id AS run_id, COALESCE(o.completed_at, o.updated_at) AS occurred_at
                FROM schedule_occurrences o
                JOIN local_schedules s ON s.id = o.schedule_id
                JOIN bots b ON b.thread_id = s.thread_id
                WHERE o.status IN ('completed', 'failed', 'paused', 'retry')

                UNION ALL

                SELECT o.idempotency_key AS id, b.id AS bot_id, b.name AS bot_name,
                       r.id AS routine_id, r.title AS title, 'project-change' AS trigger_kind,
                       CASE
                         WHEN o.status = 'paused' AND o.next_attempt_at IS NULL THEN 'attention'
                         WHEN o.status IN ('paused', 'retry') THEN 'retrying'
                         ELSE o.status
                       END AS status,
                       o.run_id AS run_id, COALESCE(o.completed_at, o.updated_at) AS occurred_at
                FROM event_routine_occurrences o
                JOIN routines r ON r.id = o.routine_id
                JOIN bots b ON b.id = r.bot_id
                WHERE o.status IN ('completed', 'failed', 'paused', 'retry')
             )
             ORDER BY occurred_at DESC, id ASC
             LIMIT ?1",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![MAX_ACTIVITY_ITEMS], |row| {
            Ok(RoutineActivityItem {
                id: row.get(0)?,
                bot_id: row.get(1)?,
                bot_name: row.get(2)?,
                routine_id: row.get(3)?,
                title: row.get(4)?,
                trigger_kind: row.get(5)?,
                status: row.get(6)?,
                run_id: row.get(7)?,
                occurred_at: row.get(8)?,
            })
        })
        .map_err(error_text)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(error_text)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn routine_activity_returns_a_compact_latest_first_timeline() {
        let directory = tempdir().expect("tempdir");
        let state = AppState::for_test(directory.path()).expect("state");
        state
            .connection()
            .expect("connection")
            .execute_batch(
                "PRAGMA foreign_keys = OFF;
                 INSERT INTO threads (
                    id, owner_uid, title, status, latest_block_sequence,
                    body_json, created_at, updated_at
                 ) VALUES (
                    'thread-activity', 'local', 'Activity bot', 'active', 0,
                    '{}', '2026-08-19T15:00:00.000Z', '2026-08-19T15:00:00.000Z'
                 );
                 INSERT INTO bots (
                    id, thread_id, current_version, name, status, latest_status,
                    active, created_at, updated_at
                 ) VALUES (
                    'bot-activity', 'thread-activity', 1, 'Release Bot', 'watching',
                    'Watching release', 0, '2026-08-19T15:00:00.000Z',
                    '2026-08-19T15:00:00.000Z'
                 );
                 INSERT INTO local_schedules (
                    id, thread_id, artifact_id, artifact_version, enabled, cadence,
                    timezone, revision, body_json, created_at, updated_at
                 ) VALUES (
                    'schedule-activity', 'thread-activity', 'artifact-local', 'v1', 1,
                    'daily', 'America/Denver', 1, '{}',
                    '2026-08-19T15:00:00.000Z', '2026-08-19T15:00:00.000Z'
                 );
                 INSERT INTO schedule_occurrences (
                    idempotency_key, schedule_id, schedule_revision, scheduled_for,
                    status, attempt, run_id, created_at, updated_at, completed_at
                 ) VALUES (
                    'activity-complete', 'schedule-activity', 1,
                    '2026-08-19T17:00:00.000Z', 'completed', 1, 'activity-run',
                    '2026-08-19T17:00:00.000Z', '2026-08-19T17:05:00.000Z',
                    '2026-08-19T17:05:00.000Z'
                 );
                 PRAGMA foreign_keys = ON;",
            )
            .expect("activity fixture");

        assert_eq!(
            list_recent_routine_activity(&state).expect("activity"),
            vec![RoutineActivityItem {
                id: "activity-complete".into(),
                bot_id: "bot-activity".into(),
                bot_name: "Release Bot".into(),
                routine_id: "schedule-activity".into(),
                title: "Release Bot routine".into(),
                trigger_kind: "schedule".into(),
                status: "completed".into(),
                run_id: "activity-run".into(),
                occurred_at: "2026-08-19T17:05:00.000Z".into(),
            }]
        );
    }
}
