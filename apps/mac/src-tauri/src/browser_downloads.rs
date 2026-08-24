use crate::crypto::DataCipher;
use crate::storage::AppState;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const MAX_BROWSER_DOWNLOAD_BYTES: u64 = 25 * 1024 * 1024;
const MAX_QUARANTINED_DOWNLOADS_PER_BOT: i64 = 8;
const MAX_QUARANTINED_BYTES_PER_BOT: i64 = 100 * 1024 * 1024;
const QUARANTINE_DIRECTORY: &str = "browser-quarantine";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedBrowserDownload {
    pub id: String,
    pub bot_id: String,
    pub session_id: String,
    pub file_name: String,
    pub source_url: String,
    pub byte_size: u64,
    pub sha256: String,
    pub created_at: String,
    pub completed_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserDownloadReservation {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
}

#[derive(Debug)]
pub(crate) struct VerifiedBrowserDownload {
    pub(crate) download: QuarantinedBrowserDownload,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS browser_downloads (
                id TEXT PRIMARY KEY,
                bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL,
                file_name_json TEXT NOT NULL,
                source_url_json TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                byte_size INTEGER,
                sha256 TEXT,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                completed_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_browser_downloads_bot_status
                ON browser_downloads(bot_id, status, created_at DESC);",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (20, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

pub(crate) fn recover_incomplete(state: &AppState) -> Result<(), String> {
    let connection = state.connection()?;
    let stale = {
        let mut statement = connection
            .prepare("SELECT id, bot_id, relative_path FROM browser_downloads WHERE status = 'downloading'")
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    for (id, bot_id, relative_path) in stale {
        if valid_relative_path(&bot_id, &id, &relative_path) {
            let _ = fs::remove_dir_all(quarantine_directory(state, &bot_id, &id));
        }
        connection
            .execute(
                "DELETE FROM browser_downloads WHERE id = ?1 AND bot_id = ?2 AND status = 'downloading'",
                params![id, bot_id],
            )
            .map_err(error_text)?;
    }
    Ok(())
}

pub(crate) fn begin_quarantine(
    state: &AppState,
    id: &str,
    bot_id: &str,
    session_id: &str,
    file_name: &str,
    source_url: &str,
    created_at: &str,
) -> Result<BrowserDownloadReservation, String> {
    validate_identifier(id, "download")?;
    validate_identifier(bot_id, "bot")?;
    validate_identifier(session_id, "browser session")?;
    validate_file_name(file_name)?;
    validate_source_url(source_url)?;
    let created_at = canonical_time(created_at, "download creation time")?;
    let connection = state.connection()?;
    require_bot(&connection, bot_id)?;
    let (count, bytes): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(byte_size), 0)
             FROM browser_downloads
             WHERE bot_id = ?1 AND status IN ('downloading', 'quarantined')",
            params![bot_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(error_text)?;
    if count >= MAX_QUARANTINED_DOWNLOADS_PER_BOT {
        return Err("Release or delete a quarantined download before adding another.".into());
    }
    if bytes >= MAX_QUARANTINED_BYTES_PER_BOT {
        return Err("This bot's browser quarantine has reached its 100 MB limit.".into());
    }
    let relative_path = quarantine_relative_path(bot_id, id);
    let file_name_json = state.cipher().seal(&file_name_context(id), file_name)?;
    let source_url_json = state.cipher().seal(&source_url_context(id), source_url)?;
    let directory = quarantine_directory(state, bot_id, id);
    fs::create_dir_all(&directory)
        .map_err(|_| "Codelit could not create the browser quarantine.".to_string())?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Codelit could not secure the browser quarantine.".to_string())?;
    if let Err(error) = connection.execute(
        "INSERT INTO browser_downloads
            (id, bot_id, session_id, file_name_json, source_url_json, relative_path,
             byte_size, sha256, status, created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 'downloading', ?7, NULL)",
        params![
            id,
            bot_id,
            session_id,
            file_name_json,
            source_url_json,
            relative_path,
            created_at,
        ],
    ) {
        let _ = fs::remove_dir_all(directory);
        return Err(error_text(error));
    }
    Ok(BrowserDownloadReservation {
        id: id.into(),
        path: quarantine_payload_path(state, bot_id, id),
    })
}

pub(crate) fn finish_quarantine(
    state: &AppState,
    bot_id: &str,
    id: &str,
    completed_at: &str,
) -> Result<QuarantinedBrowserDownload, String> {
    validate_identifier(bot_id, "bot")?;
    validate_identifier(id, "download")?;
    let completed_at = canonical_time(completed_at, "download completion time")?;
    let connection = state.connection()?;
    let row = load_stored_download(&connection, id, bot_id, "downloading")?
        .ok_or_else(|| "The quarantined download is no longer pending.".to_string())?;
    let path = checked_payload_path(state, &row)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "The quarantined download did not finish writing.".to_string())?;
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_BROWSER_DOWNLOAD_BYTES
    {
        return Err("The download was empty, unsafe, or larger than 25 MB.".into());
    }
    let file_name = open_field(state.cipher(), &file_name_context(id), &row.file_name_json)?;
    validate_file_name(&file_name)?;
    inspect_file_header(&path)?;
    let sha256 = hash_file(&path)?;
    let other_bytes: i64 = connection
        .query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM browser_downloads
             WHERE bot_id = ?1 AND status = 'quarantined' AND id <> ?2",
            params![bot_id, id],
            |result| result.get(0),
        )
        .map_err(error_text)?;
    if other_bytes.saturating_add(metadata.len() as i64) > MAX_QUARANTINED_BYTES_PER_BOT {
        return Err("This bot's browser quarantine would exceed its 100 MB limit.".into());
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400))
        .map_err(|_| "Codelit could not secure the quarantined download.".to_string())?;
    let changed = connection
        .execute(
            "UPDATE browser_downloads
             SET byte_size = ?3, sha256 = ?4, status = 'quarantined', completed_at = ?5
             WHERE id = ?1 AND bot_id = ?2 AND status = 'downloading'",
            params![id, bot_id, metadata.len() as i64, sha256, completed_at],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("The quarantined download changed before it could be sealed.".into());
    }
    load_public_download(&connection, state.cipher(), id, bot_id)?
        .ok_or_else(|| "The quarantined download could not be reopened.".to_string())
}

pub(crate) fn fail_quarantine(state: &AppState, bot_id: &str, id: &str) {
    if validate_identifier(bot_id, "bot").is_err() || validate_identifier(id, "download").is_err() {
        return;
    }
    if let Ok(connection) = state.connection() {
        let _ = connection.execute(
            "DELETE FROM browser_downloads WHERE id = ?1 AND bot_id = ?2 AND status = 'downloading'",
            params![id, bot_id],
        );
    }
    let _ = fs::remove_dir_all(quarantine_directory(state, bot_id, id));
}

pub fn list_quarantined_downloads(
    state: &AppState,
    bot_id: &str,
) -> Result<Vec<QuarantinedBrowserDownload>, String> {
    validate_identifier(bot_id, "bot")?;
    let connection = state.connection()?;
    require_bot(&connection, bot_id)?;
    let ids = {
        let mut statement = connection
            .prepare(
                "SELECT id FROM browser_downloads
                 WHERE bot_id = ?1 AND status = 'quarantined'
                 ORDER BY completed_at DESC, id ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map(params![bot_id], |row| row.get::<_, String>(0))
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    let mut downloads = Vec::new();
    for id in ids {
        let Some(download) = load_public_download(&connection, state.cipher(), &id, bot_id)? else {
            continue;
        };
        let row = load_stored_download(&connection, &id, bot_id, "quarantined")?
            .ok_or_else(|| "A quarantined download changed while it was loading.".to_string())?;
        let path = checked_payload_path(state, &row)?;
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| "A quarantined download is missing from this Mac.".to_string())?;
        if !metadata.file_type().is_file() || metadata.len() != download.byte_size {
            return Err("A quarantined download failed its local size check.".into());
        }
        downloads.push(download);
    }
    Ok(downloads)
}

pub(crate) fn verify_for_release(
    state: &AppState,
    bot_id: &str,
    id: &str,
) -> Result<VerifiedBrowserDownload, String> {
    validate_identifier(bot_id, "bot")?;
    validate_identifier(id, "download")?;
    let connection = state.connection()?;
    require_bot(&connection, bot_id)?;
    let row = load_stored_download(&connection, id, bot_id, "quarantined")?
        .ok_or_else(|| "That quarantined download is no longer available.".to_string())?;
    let download = load_public_download(&connection, state.cipher(), id, bot_id)?
        .ok_or_else(|| "That quarantined download is no longer available.".to_string())?;
    let path = checked_payload_path(state, &row)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "The quarantined file is missing from this Mac.".to_string())?;
    if !metadata.file_type().is_file()
        || metadata.len() != download.byte_size
        || metadata.len() > MAX_BROWSER_DOWNLOAD_BYTES
    {
        return Err("The quarantined file changed before release.".into());
    }
    inspect_file_header(&path)?;
    let bytes = fs::read(&path)
        .map_err(|_| "Codelit could not read the quarantined file for release.".to_string())?;
    if sha256_hex(&bytes) != download.sha256 {
        return Err("The quarantined file failed its integrity check.".into());
    }
    Ok(VerifiedBrowserDownload { download, bytes })
}

pub(crate) fn mark_released(state: &AppState, bot_id: &str, id: &str) -> Result<(), String> {
    validate_identifier(bot_id, "bot")?;
    validate_identifier(id, "download")?;
    let connection = state.connection()?;
    let row = load_stored_download(&connection, id, bot_id, "quarantined")?
        .ok_or_else(|| "That quarantined download is no longer available.".to_string())?;
    let changed = connection
        .execute(
            "UPDATE browser_downloads SET status = 'released'
             WHERE id = ?1 AND bot_id = ?2 AND status = 'quarantined'",
            params![id, bot_id],
        )
        .map_err(error_text)?;
    if changed != 1 {
        return Err("The quarantined download changed before release.".into());
    }
    let _ = fs::remove_dir_all(
        checked_payload_path(state, &row)?
            .parent()
            .ok_or("The quarantine path is invalid.")?,
    );
    Ok(())
}

pub fn delete_quarantined_download(state: &AppState, bot_id: &str, id: &str) -> Result<(), String> {
    validate_identifier(bot_id, "bot")?;
    validate_identifier(id, "download")?;
    let connection = state.connection()?;
    require_bot(&connection, bot_id)?;
    let row = load_stored_download(&connection, id, bot_id, "quarantined")?
        .ok_or_else(|| "That quarantined download is no longer available.".to_string())?;
    let directory = checked_payload_path(state, &row)?
        .parent()
        .ok_or("The quarantine path is invalid.")?
        .to_path_buf();
    fs::remove_dir_all(directory)
        .map_err(|_| "Codelit could not delete the quarantined file.".to_string())?;
    connection
        .execute(
            "DELETE FROM browser_downloads WHERE id = ?1 AND bot_id = ?2 AND status = 'quarantined'",
            params![id, bot_id],
        )
        .map_err(error_text)?;
    Ok(())
}

pub(crate) fn remove_quarantine_root(state: &AppState) -> Result<(), String> {
    let root = state.app_data_dir().join(QUARANTINE_DIRECTORY);
    if root.exists() {
        fs::remove_dir_all(root)
            .map_err(|_| "Codelit could not remove browser quarantine data.".to_string())?;
    }
    Ok(())
}

pub(crate) fn delete_all_quarantined_downloads(state: &AppState) -> Result<(), String> {
    let connection = state.connection()?;
    connection
        .execute("DELETE FROM browser_downloads", [])
        .map_err(error_text)?;
    remove_quarantine_root(state)
}

#[derive(Debug)]
struct StoredDownload {
    id: String,
    bot_id: String,
    session_id: String,
    file_name_json: String,
    source_url_json: String,
    relative_path: String,
    byte_size: Option<i64>,
    sha256: Option<String>,
    created_at: String,
    completed_at: Option<String>,
}

fn load_stored_download(
    connection: &Connection,
    id: &str,
    bot_id: &str,
    status: &str,
) -> Result<Option<StoredDownload>, String> {
    connection
        .query_row(
            "SELECT id, bot_id, session_id, file_name_json, source_url_json, relative_path,
                    byte_size, sha256, created_at, completed_at
             FROM browser_downloads WHERE id = ?1 AND bot_id = ?2 AND status = ?3",
            params![id, bot_id, status],
            |row| {
                Ok(StoredDownload {
                    id: row.get(0)?,
                    bot_id: row.get(1)?,
                    session_id: row.get(2)?,
                    file_name_json: row.get(3)?,
                    source_url_json: row.get(4)?,
                    relative_path: row.get(5)?,
                    byte_size: row.get(6)?,
                    sha256: row.get(7)?,
                    created_at: row.get(8)?,
                    completed_at: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(error_text)
}

fn load_public_download(
    connection: &Connection,
    cipher: &DataCipher,
    id: &str,
    bot_id: &str,
) -> Result<Option<QuarantinedBrowserDownload>, String> {
    let Some(row) = load_stored_download(connection, id, bot_id, "quarantined")? else {
        return Ok(None);
    };
    validate_identifier(&row.id, "stored download")?;
    validate_identifier(&row.bot_id, "stored bot")?;
    validate_identifier(&row.session_id, "stored browser session")?;
    if row.id != id || row.bot_id != bot_id || !valid_relative_path(bot_id, id, &row.relative_path)
    {
        return Err("A quarantined download has an invalid identity.".into());
    }
    let file_name = open_field(cipher, &file_name_context(id), &row.file_name_json)?;
    let source_url = open_field(cipher, &source_url_context(id), &row.source_url_json)?;
    validate_file_name(&file_name)?;
    validate_source_url(&source_url)?;
    let byte_size = row
        .byte_size
        .filter(|value| *value > 0 && *value <= MAX_BROWSER_DOWNLOAD_BYTES as i64)
        .ok_or_else(|| "A quarantined download has an invalid size.".to_string())?
        as u64;
    let sha256 = row
        .sha256
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "A quarantined download has an invalid integrity proof.".to_string())?;
    Ok(Some(QuarantinedBrowserDownload {
        id: row.id,
        bot_id: row.bot_id,
        session_id: row.session_id,
        file_name,
        source_url,
        byte_size,
        sha256,
        created_at: canonical_time(&row.created_at, "stored download creation time")?,
        completed_at: canonical_time(
            row.completed_at
                .as_deref()
                .ok_or("A quarantined download has no completion time.")?,
            "stored download completion time",
        )?,
    }))
}

fn checked_payload_path(state: &AppState, row: &StoredDownload) -> Result<PathBuf, String> {
    if !valid_relative_path(&row.bot_id, &row.id, &row.relative_path) {
        return Err("The browser quarantine path is invalid.".into());
    }
    Ok(state.app_data_dir().join(&row.relative_path))
}

fn quarantine_relative_path(bot_id: &str, id: &str) -> String {
    format!("{QUARANTINE_DIRECTORY}/{bot_id}/{id}/payload")
}

fn quarantine_directory(state: &AppState, bot_id: &str, id: &str) -> PathBuf {
    state
        .app_data_dir()
        .join(QUARANTINE_DIRECTORY)
        .join(bot_id)
        .join(id)
}

fn quarantine_payload_path(state: &AppState, bot_id: &str, id: &str) -> PathBuf {
    quarantine_directory(state, bot_id, id).join("payload")
}

fn valid_relative_path(bot_id: &str, id: &str, value: &str) -> bool {
    value == quarantine_relative_path(bot_id, id)
}

fn validate_file_name(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 120
        || trimmed != value
        || value.starts_with('.')
        || value.contains(['/', '\\', '\0', '\r', '\n'])
    {
        return Err("The browser download name is invalid.".into());
    }
    let extension = Path::new(value)
        .extension()
        .and_then(|part| part.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if [
        "app",
        "applescript",
        "bat",
        "command",
        "crx",
        "deb",
        "dmg",
        "exe",
        "hta",
        "iso",
        "jar",
        "js",
        "jse",
        "mobileconfig",
        "msi",
        "pkg",
        "pl",
        "ps1",
        "py",
        "rb",
        "rpm",
        "scpt",
        "sh",
        "vbs",
        "workflow",
        "wsf",
        "xpi",
    ]
    .contains(&extension.as_str())
    {
        return Err("Executable, script, and installable downloads are blocked.".into());
    }
    Ok(())
}

fn validate_source_url(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 2_048 || value.contains(['\0', '\r', '\n']) {
        return Err("The browser download source is invalid.".into());
    }
    let parsed = url::Url::parse(value)
        .map_err(|_| "The browser download source is invalid.".to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    let local = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || (parsed.scheme() != "https" && !(parsed.scheme() == "http" && local))
    {
        return Err("The browser download source is invalid.".into());
    }
    Ok(())
}

fn inspect_file_header(path: &Path) -> Result<(), String> {
    let mut file = fs::File::open(path)
        .map_err(|_| "Codelit could not inspect the quarantined file.".to_string())?;
    let mut header = [0_u8; 512];
    let count = file
        .read(&mut header)
        .map_err(|_| "Codelit could not inspect the quarantined file.".to_string())?;
    let bytes = &header[..count];
    let executable_magic = bytes.starts_with(b"MZ")
        || bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(b"#!")
        || bytes.starts_with(&[0xfe, 0xed, 0xfa, 0xce])
        || bytes.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
        || bytes.starts_with(&[0xce, 0xfa, 0xed, 0xfe])
        || bytes.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
        || bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe])
        || bytes.starts_with(b"xar!");
    if executable_magic {
        return Err("Executable and installable downloads are blocked.".into());
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|_| "Codelit could not verify the quarantined file.".to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Codelit could not verify the quarantined file.".to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_name_context(id: &str) -> String {
    format!("browser-downloads:{id}:file-name")
}

fn source_url_context(id: &str) -> String {
    format!("browser-downloads:{id}:source-url")
}

fn open_field(cipher: &DataCipher, context: &str, value: &str) -> Result<String, String> {
    cipher
        .open(context, value)
        .map_err(|_| "A quarantined download has damaged private metadata.".to_string())
}

fn require_bot(connection: &Connection, bot_id: &str) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bots WHERE id = ?1)",
            params![bot_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if !exists {
        return Err("That bot is no longer available on this Mac.".into());
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 180
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
    {
        return Err(format!("The {label} identifier is invalid."));
    }
    Ok(())
}

fn canonical_time(value: &str, label: &str) -> Result<String, String> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| format!("The {label} is invalid."))?
        .with_timezone(&Utc);
    let canonical = parsed.to_rfc3339_opts(SecondsFormat::Millis, true);
    if canonical != value {
        return Err(format!("The {label} is invalid."));
    }
    Ok(canonical)
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
    use crate::storage::{CreateLocalBotRequest, create_local_bot};
    use tempfile::tempdir;

    fn state() -> (tempfile::TempDir, AppState) {
        let directory = tempdir().expect("temporary database");
        let state = AppState::for_test(directory.path()).expect("test state");
        (directory, state)
    }

    #[test]
    fn quarantine_is_private_bounded_verified_and_bot_scoped() {
        let (_directory, state) = state();
        create_local_bot(
            &state,
            CreateLocalBotRequest {
                id: "bot-private".into(),
                name: "Private Bot".into(),
                job: "Keep a separate quarantine.".into(),
                avatar: None,
                created_at: "2026-08-19T14:00:00.000Z".into(),
            },
        )
        .expect("second bot");
        let reservation = begin_quarantine(
            &state,
            "download-report",
            "bot-codelit",
            "browser-run-report",
            "report.pdf",
            "https://codelit.io/report.pdf",
            "2026-08-19T14:01:00.000Z",
        )
        .expect("reservation");
        fs::write(&reservation.path, b"%PDF-1.7\nprivate report").expect("quarantined payload");
        let completed = finish_quarantine(
            &state,
            "bot-codelit",
            &reservation.id,
            "2026-08-19T14:02:00.000Z",
        )
        .expect("completed quarantine");
        assert_eq!(completed.file_name, "report.pdf");
        assert_eq!(completed.byte_size, 23);
        assert_eq!(completed.sha256.len(), 64);
        assert_eq!(
            list_quarantined_downloads(&state, "bot-codelit").expect("owner downloads"),
            vec![completed.clone()]
        );
        assert!(
            list_quarantined_downloads(&state, "bot-private")
                .expect("private downloads")
                .is_empty()
        );
        let connection = state.connection().expect("connection");
        let encrypted_name: String = connection
            .query_row(
                "SELECT file_name_json FROM browser_downloads WHERE id = 'download-report'",
                [],
                |row| row.get(0),
            )
            .expect("stored file name");
        assert!(DataCipher::is_sealed(&encrypted_name));
        assert!(!encrypted_name.contains("report.pdf"));
        let release =
            verify_for_release(&state, "bot-codelit", "download-report").expect("verified release");
        assert_eq!(release.bytes, b"%PDF-1.7\nprivate report");
        fs::set_permissions(&reservation.path, fs::Permissions::from_mode(0o600))
            .expect("make test payload writable");
        fs::write(&reservation.path, b"tampered").expect("tamper payload");
        assert!(verify_for_release(&state, "bot-codelit", "download-report").is_err());
        delete_quarantined_download(&state, "bot-codelit", "download-report")
            .expect("deleted quarantine");
        assert!(
            list_quarantined_downloads(&state, "bot-codelit")
                .expect("downloads after delete")
                .is_empty()
        );
    }

    #[test]
    fn quarantine_rejects_executable_content_and_recovers_partial_downloads() {
        let (_directory, state) = state();
        let executable = begin_quarantine(
            &state,
            "download-script",
            "bot-codelit",
            "browser-run-script",
            "notes.txt",
            "https://codelit.io/notes.txt",
            "2026-08-19T15:00:00.000Z",
        )
        .expect("script reservation");
        fs::write(&executable.path, b"#!/bin/sh\necho unsafe").expect("script payload");
        assert!(
            finish_quarantine(
                &state,
                "bot-codelit",
                &executable.id,
                "2026-08-19T15:01:00.000Z",
            )
            .is_err()
        );
        fail_quarantine(&state, "bot-codelit", &executable.id);

        let partial = begin_quarantine(
            &state,
            "download-partial",
            "bot-codelit",
            "browser-run-partial",
            "partial.csv",
            "https://codelit.io/partial.csv",
            "2026-08-19T15:02:00.000Z",
        )
        .expect("partial reservation");
        fs::write(&partial.path, b"unfinished").expect("partial payload");
        recover_incomplete(&state).expect("recovered partial");
        assert!(!partial.path.exists());
        let count: i64 = state
            .connection()
            .expect("connection")
            .query_row("SELECT COUNT(*) FROM browser_downloads", [], |row| {
                row.get(0)
            })
            .expect("download count");
        assert_eq!(count, 0);
    }
}
