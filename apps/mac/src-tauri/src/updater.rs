#[cfg(feature = "direct-release")]
use base64::{Engine as _, engine::general_purpose::STANDARD};
#[cfg(feature = "direct-release")]
use minisign_verify::{PublicKey, Signature};
#[cfg(feature = "direct-release")]
use serde::Deserialize;
use serde::Serialize;
#[cfg(feature = "direct-release")]
use std::sync::Mutex;
#[cfg(feature = "direct-release")]
use tauri::AppHandle;
#[cfg(feature = "direct-release")]
use tauri_plugin_updater::{Update, UpdaterExt};

#[cfg(feature = "direct-release")]
const UPDATE_PLATFORM: &str = "darwin-aarch64-app";
#[cfg(feature = "direct-release")]
const UPDATER_PUBLIC_KEY: &str = include_str!("../../release/updater.pub");

#[cfg(feature = "direct-release")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedUpdateEnvelope {
    signed_payload: String,
    signature: String,
}

#[cfg(feature = "direct-release")]
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedUpdatePayload {
    schema_version: u8,
    version: String,
    notes: String,
    pub_date: String,
    platform: String,
    url: String,
    archive_signature: String,
}

#[cfg(feature = "direct-release")]
fn verify_signed_manifest_fields(
    raw: &serde_json::Value,
    version: &str,
    notes: Option<&str>,
    download_url: &str,
    archive_signature: &str,
) -> Result<(), String> {
    let raw_object = raw
        .as_object()
        .ok_or("The update manifest must be an object.")?;
    let expected_keys = ["codelit", "notes", "platforms", "pub_date", "version"];
    if raw_object.len() != expected_keys.len()
        || expected_keys
            .iter()
            .any(|key| !raw_object.contains_key(*key))
    {
        return Err("The update manifest has unexpected fields.".into());
    }
    let platforms = raw
        .get("platforms")
        .and_then(serde_json::Value::as_object)
        .ok_or("The update manifest has invalid platforms.")?;
    let platform = platforms
        .get(UPDATE_PLATFORM)
        .and_then(serde_json::Value::as_object)
        .ok_or("The update manifest is missing the Apple Silicon app platform.")?;
    if platforms.len() != 1
        || platform.len() != 2
        || !platform.contains_key("url")
        || !platform.contains_key("signature")
    {
        return Err("The update manifest has unexpected platform fields.".into());
    }
    let envelope: SignedUpdateEnvelope = serde_json::from_value(
        raw.get("codelit")
            .cloned()
            .ok_or("The update manifest is missing Codelit's signed payload.")?,
    )
    .map_err(|_| "The update manifest has an invalid signed payload envelope.".to_string())?;
    if envelope.signed_payload.len() > 24_000 || envelope.signature.len() > 2_000 {
        return Err("The update manifest's signed payload is too large.".into());
    }

    let payload_bytes = STANDARD
        .decode(&envelope.signed_payload)
        .map_err(|_| "The update manifest's signed payload is not valid base64.".to_string())?;
    let signature_bytes = STANDARD
        .decode(&envelope.signature)
        .map_err(|_| "The update manifest signature is not valid base64.".to_string())?;
    if STANDARD.encode(&payload_bytes) != envelope.signed_payload
        || STANDARD.encode(&signature_bytes) != envelope.signature
    {
        return Err("The update manifest uses a non-canonical encoding.".into());
    }
    let signature_text = std::str::from_utf8(&signature_bytes)
        .map_err(|_| "The decoded update manifest signature is invalid.".to_string())?;
    let public_key = PublicKey::decode(UPDATER_PUBLIC_KEY.trim())
        .map_err(|_| "Codelit's updater verification key is invalid.".to_string())?;
    let signature = Signature::decode(signature_text.trim())
        .map_err(|_| "The decoded update manifest signature is invalid.".to_string())?;
    public_key
        .verify(&payload_bytes, &signature, false)
        .map_err(|_| "The update manifest signature could not be verified.".to_string())?;

    let payload: SignedUpdatePayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| "The signed update payload is invalid.".to_string())?;
    let raw_platform = raw
        .get("platforms")
        .and_then(|platforms| platforms.get(UPDATE_PLATFORM));
    let raw_version = raw.get("version").and_then(serde_json::Value::as_str);
    let raw_notes = raw.get("notes").and_then(serde_json::Value::as_str);
    let raw_date = raw.get("pub_date").and_then(serde_json::Value::as_str);
    let raw_url = raw_platform
        .and_then(|platform| platform.get("url"))
        .and_then(serde_json::Value::as_str);
    let raw_archive_signature = raw_platform
        .and_then(|platform| platform.get("signature"))
        .and_then(serde_json::Value::as_str);
    if payload.schema_version != 1
        || payload.platform != UPDATE_PLATFORM
        || Some(payload.version.as_str()) != raw_version
        || Some(payload.notes.as_str()) != raw_notes
        || Some(payload.pub_date.as_str()) != raw_date
        || Some(payload.url.as_str()) != raw_url
        || Some(payload.archive_signature.as_str()) != raw_archive_signature
        || payload.version != version
        || notes != Some(payload.notes.as_str())
        || download_url != payload.url
        || archive_signature != payload.archive_signature
    {
        return Err("The update manifest does not match its signed payload.".into());
    }

    let expected_name = format!("Codelit-{}-aarch64.app.tar.gz", payload.version);
    let expected_path = format!(
        "/codelit-io/codelit-mac-releases/releases/download/v{}/{}",
        payload.version, expected_name
    );
    let url = url::Url::parse(&payload.url)
        .map_err(|_| "The signed update URL is invalid.".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.path() != expected_path
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("The signed update URL is not an immutable Codelit release.".into());
    }
    Ok(())
}

#[cfg(feature = "direct-release")]
fn verify_signed_manifest(update: &Update) -> Result<(), String> {
    verify_signed_manifest_fields(
        &update.raw_json,
        &update.version,
        update.body.as_deref(),
        update.download_url.as_str(),
        &update.signature,
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateState {
    channel: &'static str,
    status: &'static str,
    current_version: String,
    available_version: Option<String>,
    published_at: Option<String>,
    notes: Option<String>,
    detail: String,
}

impl DesktopUpdateState {
    #[cfg(any(feature = "app-store-release", test))]
    pub fn managed_by_app_store() -> Self {
        Self {
            channel: "app-store",
            status: "managed",
            current_version: env!("CARGO_PKG_VERSION").into(),
            available_version: None,
            published_at: None,
            notes: None,
            detail: "The Mac App Store checks and installs Codelit updates.".into(),
        }
    }

    #[cfg(any(
        not(any(feature = "direct-release", feature = "app-store-release")),
        test
    ))]
    pub fn development() -> Self {
        Self {
            channel: "development",
            status: "unavailable",
            current_version: env!("CARGO_PKG_VERSION").into(),
            available_version: None,
            published_at: None,
            notes: None,
            detail: "Signed updates are checked only by release builds.".into(),
        }
    }
}

#[cfg(feature = "direct-release")]
#[derive(Default)]
pub struct UpdateRegistry(Mutex<Option<Update>>);

#[cfg(feature = "direct-release")]
pub fn probe() -> DesktopUpdateState {
    DesktopUpdateState {
        channel: "direct",
        status: "idle",
        current_version: env!("CARGO_PKG_VERSION").into(),
        available_version: None,
        published_at: None,
        notes: None,
        detail: "Codelit verifies every Direct update before installation.".into(),
    }
}

#[cfg(feature = "direct-release")]
pub async fn check(
    app: &AppHandle,
    registry: &UpdateRegistry,
) -> Result<DesktopUpdateState, String> {
    let update = app
        .updater()
        .map_err(|_| "Codelit could not initialize its signed update channel.".to_string())?
        .check()
        .await
        .map_err(|_| {
            "Codelit could not check the signed update channel. Try again when this Mac is online."
                .to_string()
        })?;
    let Some(update) = update else {
        *registry
            .0
            .lock()
            .map_err(|_| "The update state is unavailable.".to_string())? = None;
        return Ok(DesktopUpdateState {
            status: "current",
            detail: "Codelit is up to date.".into(),
            ..probe()
        });
    };
    verify_signed_manifest(&update)?;
    let state = DesktopUpdateState {
        channel: "direct",
        status: "available",
        current_version: update.current_version.clone(),
        available_version: Some(update.version.clone()),
        published_at: update.date.map(|date| date.to_string()),
        notes: update
            .body
            .clone()
            .map(|body| body.chars().take(2_000).collect()),
        detail: format!("Codelit {} is ready to install.", update.version),
    };
    *registry
        .0
        .lock()
        .map_err(|_| "The update state is unavailable.".to_string())? = Some(update);
    Ok(state)
}

#[cfg(feature = "direct-release")]
pub async fn install(app: &AppHandle, registry: &UpdateRegistry) -> Result<(), String> {
    let update = registry
        .0
        .lock()
        .map_err(|_| "The update state is unavailable.".to_string())?
        .take()
        .ok_or("Check for an update before installing it.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| {
            "The signed update could not be installed. Your current Codelit app is unchanged."
                .to_string()
        })?;
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_store_state_never_offers_a_direct_update() {
        let state = DesktopUpdateState::managed_by_app_store();
        assert_eq!(state.channel, "app-store");
        assert_eq!(state.status, "managed");
        assert!(state.available_version.is_none());
    }

    #[cfg(feature = "direct-release")]
    #[test]
    fn direct_probe_explains_signature_verification() {
        let state = probe();
        assert_eq!(state.channel, "direct");
        assert_eq!(state.status, "idle");
        assert!(state.detail.contains("verifies every Direct update"));
    }

    #[test]
    fn development_state_does_not_claim_an_update_channel() {
        let state = DesktopUpdateState::development();
        assert_eq!(state.channel, "development");
        assert_eq!(state.status, "unavailable");
        assert!(state.available_version.is_none());
    }

    #[cfg(feature = "direct-release")]
    fn signed_manifest_fixture() -> serde_json::Value {
        serde_json::json!({
            "version": "0.0.0",
            "notes": "Runtime verifier fixture.",
            "pub_date": "2026-08-12T12:00:00.000Z",
            "platforms": {
                "darwin-aarch64-app": {
                    "url": "https://github.com/codelit-io/codelit-mac-releases/releases/download/v0.0.0/Codelit-0.0.0-aarch64.app.tar.gz",
                    "signature": "fixture-archive-signature"
                }
            },
            "codelit": {
                "signedPayload": "eyJzY2hlbWFWZXJzaW9uIjoxLCJ2ZXJzaW9uIjoiMC4wLjAiLCJub3RlcyI6IlJ1bnRpbWUgdmVyaWZpZXIgZml4dHVyZS4iLCJwdWJEYXRlIjoiMjAyNi0wOC0xMlQxMjowMDowMC4wMDBaIiwicGxhdGZvcm0iOiJkYXJ3aW4tYWFyY2g2NC1hcHAiLCJ1cmwiOiJodHRwczovL2dpdGh1Yi5jb20vY29kZWxpdC1pby9jb2RlbGl0LW1hYy1yZWxlYXNlcy9yZWxlYXNlcy9kb3dubG9hZC92MC4wLjAvQ29kZWxpdC0wLjAuMC1hYXJjaDY0LmFwcC50YXIuZ3oiLCJhcmNoaXZlU2lnbmF0dXJlIjoiZml4dHVyZS1hcmNoaXZlLXNpZ25hdHVyZSJ9",
                "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUdHlpN0VPSEkwV2JWSXNzYTZ4SmVMd3BqZUtQOGRtSFhTaEM2NkY5R3BIdFBpVTJHU28rQzZCZ25rYmRNZWR5Y0FTcVI5ZnNqYXZTNFBBOFVMSEVTTzNwQktGdForWlFnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg2NTE3MDExCWZpbGU6cGF5bG9hZC5qc29uCnhFejdQeUEwSWY2Z3hqZGkrSFdVWURpeit0d1lKSnd1Ykhtamh5d1Jtb0d1a3ZzRXZBem43ekFhbWw2TmpuMnhuSEJ6aGE2VVd1bUY3d1RnYlo1YkNnPT0K"
            }
        })
    }

    #[cfg(feature = "direct-release")]
    #[test]
    fn signed_manifest_binds_version_and_archive_location() {
        let raw = signed_manifest_fixture();
        let url = raw["platforms"][UPDATE_PLATFORM]["url"]
            .as_str()
            .expect("fixture URL");
        assert!(
            verify_signed_manifest_fields(
                &raw,
                "0.0.0",
                Some("Runtime verifier fixture."),
                url,
                "fixture-archive-signature",
            )
            .is_ok()
        );

        let mut relabeled = raw.clone();
        relabeled["version"] = serde_json::json!("0.0.1");
        assert!(
            verify_signed_manifest_fields(
                &relabeled,
                "0.0.1",
                Some("Runtime verifier fixture."),
                url,
                "fixture-archive-signature",
            )
            .unwrap_err()
            .contains("does not match")
        );

        let mut tampered = raw.clone();
        tampered["codelit"]["signedPayload"] = serde_json::json!("AAAA");
        assert!(
            verify_signed_manifest_fields(
                &tampered,
                "0.0.0",
                Some("Runtime verifier fixture."),
                url,
                "fixture-archive-signature",
            )
            .unwrap_err()
            .contains("signature")
        );
    }
}
