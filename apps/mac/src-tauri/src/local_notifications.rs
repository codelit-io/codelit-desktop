use crate::storage::AppState;
use chrono::{SecondsFormat, Utc};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

const NOTIFICATION_EVENT: &str = "local-notification-open";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowLocalNotificationRequest {
    pub thread_id: String,
    pub artifact_id: String,
    pub artifact_kind: String,
    pub run_id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalNotificationRoute {
    pub id: String,
    pub thread_id: String,
    pub artifact_id: String,
    pub artifact_kind: String,
    pub run_id: String,
}

pub fn show_local_notification(
    app: &AppHandle,
    state: &AppState,
    request: ShowLocalNotificationRequest,
) -> Result<LocalNotificationRoute, String> {
    validate_request(&request)?;
    ensure_schema(state)?;
    let route = LocalNotificationRoute {
        id: notification_id(&request),
        thread_id: request.thread_id.clone(),
        artifact_id: request.artifact_id.clone(),
        artifact_kind: request.artifact_kind.clone(),
        run_id: request.run_id.clone(),
    };
    let now = canonical_now();
    let detail = state.cipher().seal(
        &notification_context(&route.id),
        &serde_json::json!({ "title": request.title, "body": request.body }).to_string(),
    )?;
    let connection = state.connection()?;
    let inserted = connection
        .execute(
            "INSERT OR IGNORE INTO local_notifications (
                id, thread_id, artifact_id, artifact_kind, run_id,
                detail_json, created_at, opened_at, consumed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL)",
            params![
                route.id,
                route.thread_id,
                route.artifact_id,
                route.artifact_kind,
                route.run_id,
                detail,
                now,
            ],
        )
        .map_err(error_text)?;
    if inserted == 1 && crate::autonomy::notification_delivery_allowed(state)? {
        platform::show_notification(
            app,
            &route.id,
            &request.title,
            &request.body,
            &request.thread_id,
        )?;
    }
    Ok(route)
}

pub fn take_opened_local_notification(
    state: &AppState,
) -> Result<Option<LocalNotificationRoute>, String> {
    ensure_schema(state)?;
    let now = canonical_now();
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let route = transaction
        .query_row(
            "SELECT id, thread_id, artifact_id, artifact_kind, run_id
             FROM local_notifications
             WHERE opened_at IS NOT NULL AND consumed_at IS NULL
             ORDER BY opened_at ASC LIMIT 1",
            [],
            route_from_row,
        )
        .optional()
        .map_err(error_text)?;
    if let Some(route) = &route {
        transaction
            .execute(
                "UPDATE local_notifications SET consumed_at = ?2 WHERE id = ?1",
                params![route.id, now],
            )
            .map_err(error_text)?;
    }
    transaction.commit().map_err(error_text)?;
    Ok(route)
}

pub fn consume_local_notification(state: &AppState, id: &str) -> Result<(), String> {
    validate_identifier(id, "notification")?;
    ensure_schema(state)?;
    state
        .connection()?
        .execute(
            "UPDATE local_notifications SET consumed_at = ?2 WHERE id = ?1",
            params![id, canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

fn mark_opened(state: &AppState, id: &str) -> Result<Option<LocalNotificationRoute>, String> {
    validate_identifier(id, "notification")?;
    ensure_schema(state)?;
    let connection = state.connection()?;
    connection
        .execute(
            "UPDATE local_notifications SET opened_at = ?2 WHERE id = ?1",
            params![id, canonical_now()],
        )
        .map_err(error_text)?;
    connection
        .query_row(
            "SELECT id, thread_id, artifact_id, artifact_kind, run_id
             FROM local_notifications WHERE id = ?1",
            [id],
            route_from_row,
        )
        .optional()
        .map_err(error_text)
}

fn ensure_schema(state: &AppState) -> Result<(), String> {
    let connection = state.connection()?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_notifications (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                artifact_id TEXT NOT NULL,
                artifact_kind TEXT NOT NULL,
                run_id TEXT NOT NULL,
                detail_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                opened_at TEXT,
                consumed_at TEXT
             );
             CREATE INDEX IF NOT EXISTS local_notifications_opened_idx
               ON local_notifications (opened_at, consumed_at);
             INSERT OR IGNORE INTO schema_migrations (version, applied_at)
               VALUES (8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));",
        )
        .map_err(error_text)
}

fn route_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalNotificationRoute> {
    Ok(LocalNotificationRoute {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        artifact_id: row.get(2)?,
        artifact_kind: row.get(3)?,
        run_id: row.get(4)?,
    })
}

fn validate_request(request: &ShowLocalNotificationRequest) -> Result<(), String> {
    validate_identifier(&request.thread_id, "thread")?;
    validate_identifier(&request.artifact_id, "artifact")?;
    validate_identifier(&request.run_id, "run")?;
    if !matches!(
        request.artifact_kind.as_str(),
        "agent-team" | "product-plan" | "architecture" | "bot" | "activity"
    ) {
        return Err("Notification artifact type is unsupported.".into());
    }
    validate_label(&request.title, 120, "notification title")?;
    validate_label(&request.body, 500, "notification body")
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 180
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("The {label} identifier is invalid."));
    }
    Ok(())
}

fn validate_label(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(format!("The {label} is invalid."));
    }
    Ok(())
}

fn notification_id(request: &ShowLocalNotificationRequest) -> String {
    let digest = Sha256::digest(format!(
        "{}:{}:{}:{}",
        request.thread_id, request.artifact_id, request.artifact_kind, request.run_id
    ));
    format!("notification-{}", hex_prefix(&digest, 16))
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    bytes
        .iter()
        .take(count)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn notification_context(id: &str) -> String {
    format!("local-notification:{id}")
}

fn canonical_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{AppState, LocalNotificationRoute, NOTIFICATION_EVENT, mark_opened};
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::cell::RefCell;
    use tauri::{AppHandle, Emitter, Manager};

    struct NotificationDelegateIvars {
        app: AppHandle,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = NotificationDelegateIvars]
        struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &DynBlock<dyn Fn()>,
            ) {
                let id = response.notification().request().identifier().to_string();
                let app = &self.ivars().app;
                if let Ok(Some(route)) = mark_opened(&app.state::<AppState>(), &id) {
                    let _ = app.emit(NOTIFICATION_EVENT, &route);
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                completion.call(());
            }
        }
    );

    impl NotificationDelegate {
        fn new(mtm: MainThreadMarker, app: AppHandle) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(NotificationDelegateIvars { app });
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        static DELEGATE: RefCell<Option<Retained<NotificationDelegate>>> = const { RefCell::new(None) };
    }

    pub fn install_notification_delegate(app: &AppHandle) -> Result<(), String> {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let delegate = NotificationDelegate::new(mtm, handle);
            UNUserNotificationCenter::currentNotificationCenter()
                .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            DELEGATE.with(|slot| slot.replace(Some(delegate)));
        })
        .map_err(|error| error.to_string())
    }

    pub fn show_notification(
        app: &AppHandle,
        id: &str,
        title: &str,
        body: &str,
        thread_id: &str,
    ) -> Result<(), String> {
        let id = id.to_string();
        let title = title.to_string();
        let body = body.to_string();
        let thread_id = thread_id.to_string();
        app.run_on_main_thread(move || {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let delivery_center = center.clone();
            let permission = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                if !granted.as_bool() {
                    if !error.is_null() {
                        eprintln!("macOS notification permission was not granted.");
                    }
                    return;
                }
                let content = UNMutableNotificationContent::new();
                content.setTitle(&NSString::from_str(&title));
                content.setBody(&NSString::from_str(&body));
                content.setThreadIdentifier(&NSString::from_str(&thread_id));
                let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                    &NSString::from_str(&id),
                    &content,
                    None,
                );
                let completion = RcBlock::new(|error: *mut NSError| {
                    if !error.is_null() {
                        eprintln!("macOS could not deliver a local schedule notification.");
                    }
                });
                delivery_center
                    .addNotificationRequest_withCompletionHandler(&request, Some(&completion));
            });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &permission,
            );
        })
        .map_err(|error| error.to_string())
    }

    #[allow(dead_code)]
    fn _route_type_check(_: LocalNotificationRoute) {}
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::AppHandle;

    pub fn install_notification_delegate(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }

    pub fn show_notification(
        _app: &AppHandle,
        _id: &str,
        _title: &str,
        _body: &str,
        _thread_id: &str,
    ) -> Result<(), String> {
        Err("Local notifications are available only on macOS.".into())
    }
}

pub use platform::install_notification_delegate;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn request() -> ShowLocalNotificationRequest {
        ShowLocalNotificationRequest {
            thread_id: "local-thread".into(),
            artifact_id: "artifact-agent-team-local".into(),
            artifact_kind: "agent-team".into(),
            run_id: "scheduled-0123456789abcdef0123456789abcdef".into(),
            title: "Morning review complete".into(),
            body: "Open the exact local run receipt.".into(),
        }
    }

    #[test]
    fn opened_route_is_durable_and_consumed_once() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        ensure_schema(&state).expect("schema");
        let request = request();
        let route = LocalNotificationRoute {
            id: notification_id(&request),
            thread_id: request.thread_id,
            artifact_id: request.artifact_id,
            artifact_kind: request.artifact_kind,
            run_id: request.run_id,
        };
        let detail = state
            .cipher()
            .seal(&notification_context(&route.id), "{\"body\":\"private\"}")
            .expect("encrypted detail");
        state
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO local_notifications (
                    id, thread_id, artifact_id, artifact_kind, run_id,
                    detail_json, created_at, opened_at, consumed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL)",
                params![
                    route.id,
                    route.thread_id,
                    route.artifact_id,
                    route.artifact_kind,
                    route.run_id,
                    detail,
                    canonical_now(),
                ],
            )
            .expect("notification row");

        assert_eq!(
            mark_opened(&state, &route.id).expect("opened"),
            Some(route.clone())
        );
        assert_eq!(
            take_opened_local_notification(&state).expect("taken"),
            Some(route)
        );
        assert_eq!(
            take_opened_local_notification(&state).expect("taken once"),
            None
        );
    }

    #[test]
    fn notification_detail_is_encrypted() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        ensure_schema(&state).expect("schema");
        let request = request();
        let id = notification_id(&request);
        let detail = state
            .cipher()
            .seal(
                &notification_context(&id),
                &serde_json::json!({ "title": request.title, "body": request.body }).to_string(),
            )
            .expect("encrypted detail");
        assert!(!detail.contains("Morning review"));
        assert!(!detail.contains("exact local run"));
    }

    #[test]
    fn all_activity_is_a_supported_notification_destination() {
        let mut request = request();
        request.thread_id = "local-workspace".into();
        request.artifact_id = "all-activity".into();
        request.artifact_kind = "activity".into();
        request.run_id = "daily-digest-2026-08-19".into();
        assert!(validate_request(&request).is_ok());
    }
}
