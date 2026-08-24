use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::StatusCode;
use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
use url::Url;

use crate::storage::AppState;

const PENDING_ACCOUNT: &str = "pending-pairing-v1";
const SESSION_ACCOUNT: &str = "desktop-session-v1";
const MAX_RESPONSE_BYTES: u64 = 128 * 1024;
const MAX_PROMOTION_BYTES: usize = 320_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudStatus {
    pub status: String,
    pub detail: String,
    pub pairing_code: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPairingStart {
    pub status: String,
    pub detail: String,
    pub pairing_code: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPromotionStart {
    pub status: String,
    pub promotion_id: String,
    pub payload_hash: String,
    pub review_url: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingPairing {
    pairing_id: String,
    pairing_code: String,
    verifier: String,
    verification_url: String,
    expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostedSessionCredential {
    session_id: String,
    token: String,
    expires_at: String,
    scopes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingResponse {
    pairing_id: String,
    pairing_code: String,
    verification_url: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeResponse {
    session_id: String,
    token: String,
    expires_at: String,
    scopes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromotionResponse {
    promotion_id: String,
    payload_hash: String,
    created_at: String,
    review_url: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
struct ErrorResponse {
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequest<'a> {
    challenge: &'a str,
    device_name: &'a str,
    app_version: &'a str,
    build_channel: &'a str,
}

#[derive(Debug, Serialize)]
struct ExchangeRequest<'a> {
    verifier: &'a str,
}

pub(crate) fn build_channel() -> &'static str {
    if cfg!(feature = "app-store-release") {
        "app-store"
    } else if cfg!(feature = "direct-release") {
        "direct"
    } else {
        "development"
    }
}

fn server_base_url() -> Result<Url, String> {
    #[cfg(debug_assertions)]
    let candidate =
        std::env::var("CODELIT_DESKTOP_SERVER_URL").unwrap_or_else(|_| "https://codelit.io".into());
    #[cfg(not(debug_assertions))]
    let candidate = "https://codelit.io".to_string();
    validate_server_base_url(&candidate, cfg!(debug_assertions))
}

fn validate_server_base_url(candidate: &str, allow_localhost: bool) -> Result<Url, String> {
    let url = Url::parse(candidate).map_err(|_| "Codelit Cloud address is invalid.".to_string())?;
    let production =
        url.scheme() == "https" && url.host_str() == Some("codelit.io") && url.port().is_none();
    let development =
        allow_localhost && url.scheme() == "http" && url.host_str() == Some("localhost");
    if (!production && !development)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Codelit Cloud address is not trusted.".into());
    }
    Ok(url)
}

fn endpoint(path: &str) -> Result<Url, String> {
    server_base_url()?
        .join(path)
        .map_err(|_| "Codelit Cloud endpoint is invalid.".into())
}

fn cloud_href(value: &str) -> Result<Url, String> {
    if value.len() > 500
        || !value.starts_with('/')
        || value.starts_with("//")
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err("The Codelit Cloud link is not trusted.".into());
    }
    let url = endpoint(value.trim_start_matches('/'))?;
    if url.fragment().is_some() {
        return Err("The Codelit Cloud link is not trusted.".into());
    }
    let path = url.path();
    let safe_identifier = |candidate: &str| {
        !candidate.is_empty()
            && candidate.len() <= 180
            && candidate
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    };
    let trusted = if path == "/pricing" {
        !cfg!(feature = "app-store-release")
            && url.query() == Some("source=desktop&placement=capability")
    } else if path == "/account/delete" {
        url.query().is_none()
    } else if let Some(identifier) = path.strip_prefix("/desktop/promotion/") {
        safe_identifier(identifier) && url.query().is_none()
    } else if let Some(identifier) = path.strip_prefix("/projects/") {
        safe_identifier(identifier) && url.query().is_none()
    } else if path == "/inbox" {
        let pairs = url.query_pairs().collect::<Vec<_>>();
        pairs.len() == 1 && pairs[0].0 == "run" && safe_identifier(&pairs[0].1)
    } else {
        false
    };
    trusted
        .then_some(url)
        .ok_or_else(|| "The Codelit Cloud link is not trusted.".into())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .redirect(Policy::none())
        .user_agent(concat!("CodelitMac/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Codelit Cloud connection could not be prepared.".to_string())
}

fn bounded_json<T: for<'de> Deserialize<'de>>(response: Response) -> Result<T, String> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES)
    {
        return Err("Codelit Cloud returned an oversized response.".into());
    }
    let bytes = response
        .bytes()
        .map_err(|_| "Codelit Cloud response could not be read.".to_string())?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("Codelit Cloud returned an oversized response.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Codelit Cloud returned an invalid response.".to_string())
}

fn response_error(response: Response, fallback: &str) -> String {
    bounded_json::<ErrorResponse>(response)
        .ok()
        .and_then(|body| body.error)
        .filter(|message| !message.is_empty() && message.len() <= 240)
        .unwrap_or_else(|| fallback.into())
}

fn random_verifier() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Could not prepare a secure Codelit connection.".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn verifier_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn credential_shaped_key(key: &str) -> bool {
    let compact = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        compact.as_str(),
        "apikey"
            | "authorization"
            | "bearer"
            | "cookie"
            | "credential"
            | "credentials"
            | "password"
            | "privatekey"
            | "refreshtoken"
            | "secret"
            | "sessiontoken"
            | "token"
    ) || compact.ends_with("apikey")
        || compact.ends_with("password")
        || compact.ends_with("privatekey")
        || compact.ends_with("refreshtoken")
        || compact.ends_with("sessiontoken")
}

fn inspect_promotion_value(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 16 {
        return Err("The hosted review is too deeply nested.".into());
    }
    match value {
        Value::String(text) => {
            if text.contains("/Users/")
                || text.contains("/Volumes/")
                || text.contains("/private/")
                || text.contains("/var/folders/")
                || text.contains("~/")
            {
                return Err("Local file paths cannot leave this Mac.".into());
            }
        }
        Value::Array(items) => {
            if items.len() > 500 {
                return Err("The hosted review contains too many items.".into());
            }
            for item in items {
                inspect_promotion_value(item, depth + 1)?;
            }
        }
        Value::Object(fields) => {
            if fields.len() > 500 {
                return Err("The hosted review contains too many fields.".into());
            }
            for (key, nested) in fields {
                if credential_shaped_key(key) {
                    return Err("Credentials cannot leave this Mac.".into());
                }
                inspect_promotion_value(nested, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .ok_or_else(|| "The hosted review is incomplete.".to_string())
}

fn string_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    field(value, key)?
        .as_str()
        .ok_or_else(|| "The hosted review is incomplete.".to_string())
}

fn validate_promotion_source(
    state: &AppState,
    envelope: &Value,
) -> Result<(Vec<u8>, crate::desktop_cloud::LocalPromotionSource), String> {
    let serialized = serde_json::to_vec(envelope)
        .map_err(|_| "The hosted review could not be prepared.".to_string())?;
    if serialized.len() > MAX_PROMOTION_BYTES {
        return Err("The hosted review is too large to continue.".into());
    }
    inspect_promotion_value(envelope, 0)?;
    for key in ["workflowJson", "artifactJson"] {
        let Some(serialized_json) = envelope.as_object().and_then(|object| object.get(key)) else {
            continue;
        };
        let serialized_json = serialized_json
            .as_str()
            .ok_or_else(|| "The hosted artifact is invalid.".to_string())?;
        let parsed: Value = serde_json::from_str(serialized_json)
            .map_err(|_| "The hosted artifact is invalid.".to_string())?;
        inspect_promotion_value(&parsed, 0)?;
    }
    let source = field(envelope, "source")?;
    if field(envelope, "version")?.as_u64() != Some(1) {
        return Err("The hosted review has an unsupported version.".into());
    }
    let source_artifact_id = string_field(source, "artifactId")?;
    let source_artifact_version = string_field(source, "artifactVersion")?;
    let source_kind = string_field(source, "artifactKind")?;
    let source_title = string_field(source, "title")?;
    let mode = string_field(envelope, "mode")?;
    if !matches!(source_kind, "agent-team" | "product-plan" | "architecture")
        || !matches!(mode, "run-24-7" | "sync-only")
    {
        return Err("The hosted review has the wrong artifact boundary.".into());
    }
    let source_object = source
        .as_object()
        .ok_or_else(|| "The hosted review is incomplete.".to_string())?;
    let optional_text = |key: &str| -> Result<Option<&str>, String> {
        source_object
            .get(key)
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| "The hosted review is incomplete.".to_string())
            })
            .transpose()
    };
    let source_thread_id = optional_text("threadId")?;
    let source_schedule_id = optional_text("scheduleId")?;
    let intent = envelope
        .as_object()
        .and_then(|object| object.get("intent"))
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "The hosted review has an invalid intent.".to_string())
        })
        .transpose()?;
    if intent.is_some_and(|value| {
        !matches!(
            value,
            "run-24-7" | "cloud-browser" | "public-trigger" | "collaboration" | "sync"
        )
    }) || (mode == "run-24-7" && intent.is_some_and(|value| value != "run-24-7"))
        || (matches!(intent, Some("cloud-browser" | "public-trigger"))
            && source_kind != "agent-team")
    {
        return Err("The hosted review has an invalid intent.".into());
    }

    let local_source = if let Some(schedule_id) = source_schedule_id {
        let schedule = crate::scheduler::list_local_schedules(state)?
            .into_iter()
            .find(|schedule| schedule.id == schedule_id)
            .ok_or_else(|| "The saved schedule no longer exists.".to_string())?;
        let snapshot_kind = schedule
            .snapshot
            .as_object()
            .and_then(|snapshot| snapshot.get("artifactKind"))
            .and_then(Value::as_str)
            .ok_or_else(|| "The saved schedule is missing its artifact boundary.".to_string())?;
        let snapshot_title = schedule
            .snapshot
            .as_object()
            .and_then(|snapshot| snapshot.get("artifactTitle"))
            .and_then(Value::as_str)
            .ok_or_else(|| "The saved schedule is missing its artifact title.".to_string())?;
        if source_artifact_id != schedule.artifact_id
            || source_artifact_version != schedule.artifact_version
            || source_kind != snapshot_kind
            || source_title != snapshot_title
            || source_thread_id.is_some_and(|thread_id| thread_id != schedule.thread_id)
            || (source_kind == "agent-team" && mode != "run-24-7")
            || (source_kind != "agent-team" && mode != "sync-only")
        {
            return Err("The hosted review no longer matches this saved schedule.".into());
        }
        crate::desktop_cloud::LocalPromotionSource::from_schedule(&schedule, source_title.into())?
    } else {
        if mode != "sync-only" {
            return Err("Run 24/7 requires a saved local schedule.".into());
        }
        let thread_id = source_thread_id
            .ok_or_else(|| "The hosted review is missing its local Thread.".to_string())?;
        let workspace = crate::storage::bootstrap_local_workspace(state)?;
        let artifact = workspace
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == source_artifact_id)
            .ok_or_else(|| "The local artifact no longer exists.".to_string())?;
        if workspace.thread.get("id").and_then(Value::as_str) != Some(thread_id)
            || artifact.version != source_artifact_version
            || artifact.kind != source_kind
            || artifact.title != source_title
        {
            return Err("The hosted review no longer matches the current local artifact.".into());
        }
        crate::desktop_cloud::LocalPromotionSource {
            schedule_id: None,
            thread_id: thread_id.into(),
            artifact_id: artifact.artifact_id.clone(),
            artifact_version: artifact.version.clone(),
            artifact_kind: artifact.kind.clone(),
            title: artifact.title.clone(),
            mode: mode.into(),
        }
    };

    Ok((serialized, local_source))
}

fn save_json(account: &str, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| "Codelit Cloud access could not be saved.".to_string())?;
    crate::macos::store_cloud_credential(account, &bytes)
}

fn load_json<T: for<'de> Deserialize<'de>>(account: &str) -> Result<Option<T>, String> {
    let Some(bytes) = crate::macos::load_cloud_credential(account)? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Saved Codelit Cloud access is invalid. Disconnect and connect again.".into())
}

fn future_expiry(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|expiry| expiry > chrono::Utc::now())
}

pub fn status() -> Result<DesktopCloudStatus, String> {
    if let Some(session) = load_json::<HostedSessionCredential>(SESSION_ACCOUNT)? {
        if future_expiry(&session.expires_at) {
            return Ok(DesktopCloudStatus {
                status: "connected".into(),
                detail:
                    "Codelit Cloud is connected. Local work still stays on this Mac by default."
                        .into(),
                pairing_code: None,
                expires_at: Some(session.expires_at),
            });
        }
        crate::macos::delete_cloud_credential(SESSION_ACCOUNT)?;
    }
    if let Some(pending) = load_json::<PendingPairing>(PENDING_ACCOUNT)? {
        if future_expiry(&pending.expires_at) {
            return Ok(DesktopCloudStatus {
                status: "pending".into(),
                detail: "Approve this Mac in the browser to finish connecting.".into(),
                pairing_code: Some(pending.pairing_code),
                expires_at: Some(pending.expires_at),
            });
        }
        crate::macos::delete_cloud_credential(PENDING_ACCOUNT)?;
    }
    Ok(DesktopCloudStatus {
        status: "disconnected".into(),
        detail: "Optional. Connect only when you want to sync or run work 24/7.".into(),
        pairing_code: None,
        expires_at: None,
    })
}

pub fn start(app_version: &str) -> Result<DesktopPairingStart, String> {
    let verifier = random_verifier()?;
    let challenge = verifier_challenge(&verifier);
    let response = client()?
        .post(endpoint("api/desktop/sessions")?)
        .json(&PairingRequest {
            challenge: &challenge,
            device_name: "This Mac",
            app_version,
            build_channel: build_channel(),
        })
        .send()
        .map_err(|_| {
            "Codelit Cloud could not be reached. Check your connection and try again.".to_string()
        })?;
    if response.status() != StatusCode::CREATED {
        return Err(response_error(
            response,
            "Codelit Cloud pairing could not be started.",
        ));
    }
    let pairing = bounded_json::<PairingResponse>(response)?;
    let pending = PendingPairing {
        pairing_id: pairing.pairing_id,
        pairing_code: pairing.pairing_code,
        verifier,
        verification_url: pairing.verification_url,
        expires_at: pairing.expires_at,
    };
    if !future_expiry(&pending.expires_at) {
        return Err("Codelit Cloud returned an expired connection.".into());
    }
    save_json(PENDING_ACCOUNT, &pending)?;
    if let Err(error) = crate::macos::open_external_https(&pending.verification_url) {
        let _ = crate::macos::delete_cloud_credential(PENDING_ACCOUNT);
        return Err(error);
    }
    Ok(DesktopPairingStart {
        status: "pending".into(),
        detail: "Approve the matching code in your browser. This window will finish automatically."
            .into(),
        pairing_code: pending.pairing_code,
        expires_at: pending.expires_at,
    })
}

pub fn finish() -> Result<DesktopCloudStatus, String> {
    let Some(pending) = load_json::<PendingPairing>(PENDING_ACCOUNT)? else {
        return status();
    };
    if !future_expiry(&pending.expires_at) {
        crate::macos::delete_cloud_credential(PENDING_ACCOUNT)?;
        return Ok(DesktopCloudStatus {
            status: "expired".into(),
            detail: "The connection expired. Start again when you are ready.".into(),
            pairing_code: None,
            expires_at: None,
        });
    }
    let response = client()?
        .post(endpoint(&format!(
            "api/desktop/sessions/{}/exchange",
            pending.pairing_id
        ))?)
        .json(&ExchangeRequest {
            verifier: &pending.verifier,
        })
        .send()
        .map_err(|_| {
            "Codelit Cloud could not be reached. Your pending connection is still saved."
                .to_string()
        })?;
    if response.status() == StatusCode::ACCEPTED {
        return Ok(DesktopCloudStatus {
            status: "pending".into(),
            detail: "Approve this Mac in the browser to finish connecting.".into(),
            pairing_code: Some(pending.pairing_code),
            expires_at: Some(pending.expires_at),
        });
    }
    if response.status() != StatusCode::CREATED {
        return Err(response_error(
            response,
            "Codelit Cloud pairing could not be completed.",
        ));
    }
    let session = bounded_json::<ExchangeResponse>(response)?;
    if !future_expiry(&session.expires_at)
        || session.session_id.len() != 32
        || session.token.len() != 43
        || ["account:read", "promotion:read", "promotion:write"]
            .iter()
            .any(|required| !session.scopes.iter().any(|scope| scope == required))
    {
        return Err("Codelit Cloud returned an invalid desktop session.".into());
    }
    let credential = HostedSessionCredential {
        session_id: session.session_id,
        token: session.token,
        expires_at: session.expires_at,
        scopes: session.scopes,
    };
    save_json(SESSION_ACCOUNT, &credential)?;
    crate::macos::delete_cloud_credential(PENDING_ACCOUNT)?;
    status()
}

pub fn disconnect() -> Result<DesktopCloudStatus, String> {
    crate::macos::delete_cloud_credential(PENDING_ACCOUNT)?;
    crate::macos::delete_cloud_credential(SESSION_ACCOUNT)?;
    status()
}

pub fn publish(state: &AppState, envelope: Value) -> Result<DesktopPromotionStart, String> {
    let (serialized, source) = validate_promotion_source(state, &envelope)?;
    let Some(session) = load_json::<HostedSessionCredential>(SESSION_ACCOUNT)? else {
        return Err("Connect Codelit Cloud before continuing.".into());
    };
    if !future_expiry(&session.expires_at) {
        crate::macos::delete_cloud_credential(SESSION_ACCOUNT)?;
        return Err("The Codelit Cloud connection expired. Connect this Mac again.".into());
    }
    if !session
        .scopes
        .iter()
        .any(|scope| scope == "promotion:write")
    {
        return Err("The Codelit Cloud connection cannot create hosted reviews.".into());
    }
    let response = client()?
        .post(endpoint("api/desktop/promotions")?)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("CodelitDesktop {}.{}", session.session_id, session.token),
        )
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serialized)
        .send()
        .map_err(|_| {
            "Codelit Cloud could not be reached. Nothing was uploaded; try again when online."
                .to_string()
        })?;
    if response.status() != StatusCode::CREATED {
        return Err(response_error(
            response,
            "Codelit Cloud could not prepare the hosted review.",
        ));
    }
    let promotion = bounded_json::<PromotionResponse>(response)?;
    if promotion.promotion_id.len() != 32
        || promotion.payload_hash.len() != 43
        || !future_expiry(&promotion.expires_at)
        || chrono::DateTime::parse_from_rfc3339(&promotion.created_at).is_err()
    {
        return Err("Codelit Cloud returned an invalid hosted review.".into());
    }
    let expected_review_url = endpoint(&format!("desktop/promotion/{}", promotion.promotion_id))?;
    if promotion.review_url != expected_review_url.as_str() {
        return Err("Codelit Cloud returned an untrusted hosted review link.".into());
    }
    crate::desktop_cloud::record_pending_promotion(
        state,
        &source,
        &promotion.promotion_id,
        &promotion.payload_hash,
        expected_review_url.path(),
        &promotion.created_at,
    )?;
    crate::macos::open_external_https(&promotion.review_url)?;
    Ok(DesktopPromotionStart {
        status: "review-opened".into(),
        promotion_id: promotion.promotion_id,
        payload_hash: promotion.payload_hash,
        review_url: promotion.review_url,
        expires_at: promotion.expires_at,
    })
}

pub fn sync(state: &AppState) -> Result<crate::desktop_cloud::DesktopCloudSyncView, String> {
    let Some(session) = load_json::<HostedSessionCredential>(SESSION_ACCOUNT)? else {
        return Err("Connect Codelit Cloud before syncing.".into());
    };
    if !future_expiry(&session.expires_at) {
        crate::macos::delete_cloud_credential(SESSION_ACCOUNT)?;
        return Err("The Codelit Cloud connection expired. Connect this Mac again.".into());
    }
    for scope in ["account:read", "promotion:read"] {
        if !session.scopes.iter().any(|candidate| candidate == scope) {
            return Err("The Codelit Cloud connection cannot read desktop sync state.".into());
        }
    }
    let response = client()?
        .get(endpoint("api/desktop/sync")?)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("CodelitDesktop {}.{}", session.session_id, session.token),
        )
        .send()
        .map_err(|_| {
            "Codelit Cloud could not be reached. Local work is still available on this Mac."
                .to_string()
        })?;
    if response.status() == StatusCode::UNAUTHORIZED {
        crate::macos::delete_cloud_credential(SESSION_ACCOUNT)?;
        return Err("The Codelit Cloud connection expired. Connect this Mac again.".into());
    }
    if response.status() != StatusCode::OK {
        return Err(response_error(
            response,
            "Codelit Cloud could not sync this Mac.",
        ));
    }
    crate::desktop_cloud::reconcile(state, bounded_json(response)?)
}

pub fn open_href(href: &str) -> Result<(), String> {
    crate::macos::open_external_https(cloud_href(href)?.as_str())
}

pub fn delete_all_credentials() -> Result<(), String> {
    delete_all_credentials_with(crate::macos::delete_cloud_credential)
}

fn delete_all_credentials_with(
    mut delete: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    for account in [PENDING_ACCOUNT, SESSION_ACCOUNT] {
        if let Err(error) = delete(account) {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Codelit Cloud credential cleanup was incomplete: {}",
            failures.join(" ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_cleanup_attempts_every_hosted_keychain_item() {
        let mut attempted = Vec::new();
        let error = delete_all_credentials_with(|account| {
            attempted.push(account.to_string());
            Err(format!("{account} failed."))
        })
        .expect_err("both failures are reported");

        assert_eq!(attempted, [PENDING_ACCOUNT, SESSION_ACCOUNT]);
        assert!(error.contains(&format!("{PENDING_ACCOUNT} failed.")));
        assert!(error.contains(&format!("{SESSION_ACCOUNT} failed.")));
    }

    #[test]
    fn identifies_the_compiled_distribution_channel() {
        let expected = if cfg!(feature = "app-store-release") {
            "app-store"
        } else if cfg!(feature = "direct-release") {
            "direct"
        } else {
            "development"
        };
        assert_eq!(build_channel(), expected);
    }

    #[test]
    fn accepts_only_exact_production_or_debug_localhost_origins() {
        assert_eq!(
            validate_server_base_url("https://codelit.io", false)
                .unwrap()
                .as_str(),
            "https://codelit.io/"
        );
        assert!(validate_server_base_url("http://localhost:3108", true).is_ok());
        assert!(validate_server_base_url("http://127.0.0.1:3108", true).is_err());
        assert!(validate_server_base_url("https://codelit.io.evil.example", false).is_err());
        assert!(validate_server_base_url("https://user@codelit.io", false).is_err());
        assert!(validate_server_base_url("https://codelit.io/path", false).is_err());
    }

    #[test]
    fn generates_pkce_sized_verifiers_and_challenges() {
        let verifier = random_verifier().unwrap();
        assert_eq!(verifier.len(), 43);
        assert_eq!(verifier_challenge(&verifier).len(), 43);
        assert_ne!(verifier, verifier_challenge(&verifier));
    }

    #[test]
    fn opens_only_known_cloud_destinations() {
        assert_eq!(
            cloud_href("/pricing?source=desktop&placement=capability").is_ok(),
            !cfg!(feature = "app-store-release")
        );
        assert!(cloud_href("/account/delete").is_ok());
        assert!(cloud_href("/account/delete?next=/pricing").is_err());
        assert!(cloud_href("/desktop/promotion/abcdefghijklmnopqrstuvwxyz123456").is_ok());
        assert!(cloud_href("/projects/project-1").is_ok());
        assert!(cloud_href("/inbox?run=run-1").is_ok());
        assert!(cloud_href("//evil.example/pricing").is_err());
        assert!(cloud_href("/pricing?next=https://evil.example").is_err());
        assert!(cloud_href("/projects/project-1/../../admin").is_err());
        assert!(cloud_href("/inbox?run=run-1&next=evil").is_err());
        assert!(cloud_href("/api/desktop/sync").is_err());
    }

    #[test]
    fn rejects_credentials_and_local_paths_inside_nested_workflow_json() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let base = serde_json::json!({
            "version": 1,
            "source": {
                "scheduleId": "schedule-1",
                "artifactId": "artifact-1",
                "artifactVersion": "version-1",
                "artifactKind": "agent-team"
            },
            "mode": "run-24-7",
            "workflowJson": "{}"
        });
        let mut credential = base.clone();
        credential["workflowJson"] = Value::String("{\"apiKey\":\"secret\"}".into());
        assert!(
            validate_promotion_source(&state, &credential)
                .unwrap_err()
                .contains("Credentials")
        );
        let mut local_path = base;
        local_path["workflowJson"] = Value::String("{\"note\":\"/Users/alice/private\"}".into());
        assert!(
            validate_promotion_source(&state, &local_path)
                .unwrap_err()
                .contains("Local file paths")
        );
    }

    #[test]
    fn accepts_only_the_current_artifact_for_scheduleless_cloud_setup() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let base = serde_json::json!({
            "version": 1,
            "source": {
                "threadId": "local-welcome",
                "artifactId": "artifact-agent-local",
                "artifactVersion": "v1",
                "artifactKind": "agent-team",
                "title": "Local release team"
            },
            "intent": "public-trigger",
            "mode": "sync-only",
            "workflowJson": "{}"
        });
        let (_, source) = validate_promotion_source(&state, &base).expect("artifact source");
        assert_eq!(source.schedule_id, None);
        assert_eq!(source.thread_id, "local-welcome");

        let mut stale = base;
        stale["source"]["artifactVersion"] = Value::String("v0".into());
        assert!(
            validate_promotion_source(&state, &stale)
                .unwrap_err()
                .contains("current local artifact")
        );
    }
}
