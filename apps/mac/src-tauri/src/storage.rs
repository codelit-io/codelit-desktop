use crate::artifact_store;
use crate::crypto::DataCipher;
use crate::local_browser::normalize_browser_domain_scopes;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const DATABASE_FILENAME: &str = "codelit-local.sqlite3";
const ARCHIVE_FORMAT: &str = "io.codelit.workspace";
const ARCHIVE_VERSION: u32 = 7;
const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_ARCHIVE_ROWS: usize = 100_000;
const BOT_AVATAR_PNG_PREFIX: &str = "data:image/png;base64,";
const MAX_BOT_AVATAR_PNG_BYTES: usize = 262_144;
const MAX_BOT_AVATAR_BASE64_CHARS: usize = MAX_BOT_AVATAR_PNG_BYTES.div_ceil(3) * 4;
const MAX_MEMORIES_PER_SCOPE: i64 = 200;
const MAX_PENDING_MEMORY_PROPOSALS_PER_BOT: i64 = 3;
const MAX_WORKSPACE_SKILLS: i64 = 100;
const MAX_BOT_GROUP_MEMBERS: usize = 2;
const BOT_AVATAR_PRESETS: [&str; 6] = ["spark", "orbit", "mountain", "ember", "prism", "wave"];
const ARTIFACT_KINDS: [&str; 5] = [
    "product-plan",
    "architecture",
    "agent-team",
    "plan-ship",
    "receipt",
];

#[derive(Clone)]
pub struct AppState {
    database_path: PathBuf,
    cipher: DataCipher,
}

impl AppState {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        Self::with_key(app_data_dir, crate::macos::load_or_create_data_key()?)
    }

    fn with_key(app_data_dir: PathBuf, key: [u8; 32]) -> Result<Self, String> {
        fs::create_dir_all(&app_data_dir).map_err(error_text)?;
        let state = Self {
            database_path: app_data_dir.join(DATABASE_FILENAME),
            cipher: DataCipher::new(key),
        };
        let mut connection = state.connection()?;
        seed_workspace(&mut connection, &state.cipher)?;
        seed_bots(&mut connection, &state.cipher)?;
        seed_builtin_skills(&mut connection, &state.cipher)?;
        upgrade_bot_capabilities(&mut connection, &state.cipher)?;
        recover_interrupted_runs(&mut connection, &state.cipher)?;
        drop(connection);
        crate::browser_downloads::recover_incomplete(&state)?;
        Ok(state)
    }

    #[cfg(test)]
    pub(crate) fn for_test(directory: &Path) -> Result<Self, String> {
        Self::with_key(directory.to_path_buf(), [29_u8; 32])
    }

    pub(crate) fn connection(&self) -> Result<Connection, String> {
        open_database(&self.database_path, &self.cipher)
    }

    pub(crate) fn cipher(&self) -> &DataCipher {
        &self.cipher
    }

    pub fn app_data_dir(&self) -> PathBuf {
        self.database_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersionRecord {
    pub artifact_id: String,
    pub kind: String,
    pub version: String,
    pub title: String,
    pub project_id: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventRecord {
    pub run_id: String,
    pub sequence: i64,
    pub event_type: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptRecord {
    pub id: String,
    pub run_id: String,
    pub artifact_id: String,
    pub body: Value,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCheckpointRecord {
    pub run_id: String,
    pub step_index: i64,
    pub body: Value,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub id: String,
    pub run_id: String,
    pub step_index: i64,
    pub status: String,
    pub body: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolderRecord {
    pub path: String,
    pub read_only: bool,
    pub stale: bool,
    pub access_validated: bool,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileRecord {
    pub artifact_id: String,
    pub hash: String,
    pub file_name: String,
    pub mime_type: String,
    pub size: u64,
    pub created_at: String,
}

pub struct StoredWorkspaceBookmark {
    pub path: String,
    pub bookmark: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMcpServer {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub enabled: bool,
    pub fingerprint: String,
    pub config: Value,
    pub catalog: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct SaveMcpServerRecord {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub enabled: bool,
    pub fingerprint: String,
    pub config: Value,
    pub catalog: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub thread: Value,
    pub blocks: Vec<Value>,
    pub artifacts: Vec<ArtifactVersionRecord>,
    pub run_events: Vec<RunEventRecord>,
    pub run_checkpoints: Vec<RunCheckpointRecord>,
    pub approvals: Vec<ApprovalRecord>,
    pub receipts: Vec<ReceiptRecord>,
    pub artifact_files: Vec<ArtifactFileRecord>,
    pub workspace_folder: Option<WorkspaceFolderRecord>,
    pub database_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotRecord {
    pub id: String,
    pub thread_id: String,
    pub current_version: i64,
    pub name: String,
    pub status: String,
    pub latest_status: String,
    pub spec: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotsSnapshot {
    pub bots: Vec<LocalBotRecord>,
    pub active_bot: LocalBotRecord,
    pub workspace: WorkspaceSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotContext {
    pub bot: LocalBotRecord,
    pub workspace: WorkspaceSnapshot,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateLocalBotGroupMembersRequest {
    pub owner_bot_id: String,
    pub member_bot_ids: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotMemoryRecord {
    pub id: String,
    pub bot_id: Option<String>,
    pub scope: String,
    pub kind: String,
    pub body: String,
    pub source: String,
    pub confidence: f64,
    pub sensitivity: String,
    pub approval_state: String,
    pub source_run_id: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveLocalBotMemoryRequest {
    pub id: String,
    pub actor_bot_id: String,
    pub scope: String,
    pub kind: String,
    pub body: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotMemoryProposalRecord {
    pub id: String,
    pub bot_id: String,
    pub scope: String,
    pub kind: String,
    pub body: String,
    pub source: String,
    pub confidence: f64,
    pub sensitivity: String,
    pub approval_state: String,
    pub source_run_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateLocalBotMemoryProposalRequest {
    pub id: String,
    pub actor_bot_id: String,
    pub kind: String,
    pub body: String,
    pub source_run_id: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLocalBotMemoryProposalRequest {
    pub id: String,
    pub actor_bot_id: String,
    pub decision: String,
    pub scope: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    pub reviewed_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteLocalBotMemoryRequest {
    pub id: String,
    pub actor_bot_id: String,
    pub deleted_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearLocalBotMemoriesRequest {
    pub actor_bot_id: String,
    pub include_shared: bool,
    pub deleted_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBotSkillRecord {
    pub id: String,
    pub version: i64,
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub capability_ids: Vec<String>,
    pub input_schema: Vec<Value>,
    pub output_schema: Vec<Value>,
    pub required_permissions: Vec<String>,
    pub effects: Vec<Value>,
    pub examples: Vec<Value>,
    pub checks: Vec<Value>,
    pub source: String,
    pub trust_state: String,
    pub checksum: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveLocalBotSkillRequest {
    pub id: String,
    pub actor_bot_id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub capability_ids: Vec<String>,
    #[serde(default)]
    pub input_schema: Vec<Value>,
    #[serde(default)]
    pub output_schema: Vec<Value>,
    #[serde(default)]
    pub required_permissions: Vec<String>,
    #[serde(default)]
    pub effects: Vec<Value>,
    #[serde(default)]
    pub examples: Vec<Value>,
    #[serde(default)]
    pub checks: Vec<Value>,
    #[serde(default)]
    pub expected_version: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteLocalBotSkillRequest {
    pub id: String,
    pub actor_bot_id: String,
    pub deleted_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewImportedBotSkillRequest {
    pub id: String,
    pub actor_bot_id: String,
    pub expected_version: i64,
    pub decision: String,
    pub reviewed_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackagedBotSkillManifest {
    id: String,
    version: i64,
    name: String,
    description: String,
    instructions: String,
    capability_ids: Vec<String>,
    #[serde(default)]
    input_schema: Vec<Value>,
    #[serde(default)]
    output_schema: Vec<Value>,
    #[serde(default)]
    required_permissions: Vec<String>,
    #[serde(default)]
    effects: Vec<Value>,
    #[serde(default)]
    examples: Vec<Value>,
    #[serde(default)]
    checks: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLocalBotRequest {
    pub id: String,
    pub name: String,
    pub job: String,
    #[serde(default)]
    pub avatar: Option<BotAvatarSpec>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BotAvatarPreset {
    Spark,
    Orbit,
    Mountain,
    Ember,
    Prism,
    Wave,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum BotAvatarSpec {
    #[serde(rename = "preset")]
    Preset { preset: BotAvatarPreset },
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalBotProfileRequest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar: Option<BotAvatarSpec>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalBotGoalRequest {
    pub id: String,
    pub goal: Value,
    pub updated_at: String,
    #[serde(default)]
    pub expected_version: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalBotRoutinesRequest {
    pub id: String,
    pub routine_ids: Vec<String>,
    pub allow_background: bool,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalBotStatusRequest {
    pub id: String,
    pub status: String,
    pub latest_status: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLocalBotApprovalModeRequest {
    pub id: String,
    pub approval_mode: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateLocalBotBrowserDomainsRequest {
    pub id: String,
    pub domains: Vec<String>,
    pub updated_at: String,
    #[serde(default)]
    pub expected_version: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotEngineSelectionRequest {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateLocalBotEnginePolicyRequest {
    pub id: String,
    pub mode: String,
    pub allowed_providers: Vec<String>,
    #[serde(default)]
    pub fixed_engine: Option<BotEngineSelectionRequest>,
    pub allow_metered_fallback: bool,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendMessageRequest {
    pub thread_id: String,
    pub id: String,
    pub sequence: i64,
    pub role: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArtifactRequest {
    pub thread_id: String,
    pub artifact_id: String,
    pub kind: String,
    pub version: String,
    pub title: String,
    pub project_id: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordLocalCheckRequest {
    pub thread_id: String,
    pub artifact_id: String,
    pub run_id: String,
    pub created_at: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub receipt_details: Option<Value>,
    pub selection_mode: String,
    pub metered_fallback_authorized: bool,
    pub metered_provider_invocation_started: bool,
    pub billing_fallback: bool,
    #[serde(default)]
    pub events: Vec<RecordedProviderEvent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedProviderEvent {
    pub sequence: i64,
    pub event_type: String,
    pub message: String,
    pub payload: Option<Value>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginLocalRunRequest {
    pub thread_id: String,
    pub artifact_id: String,
    pub run_id: String,
    pub provider: String,
    pub model: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRunCheckpointRequest {
    pub run_id: String,
    pub step_index: i64,
    pub handoff: String,
    pub prior_steps: Value,
    #[serde(default)]
    pub gate_approved: bool,
    #[serde(default)]
    pub run_context: Option<Value>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRunApprovalRequest {
    pub id: String,
    pub run_id: String,
    pub step_index: i64,
    pub status: String,
    pub body: Value,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreArtifactFileRequest {
    pub artifact_id: String,
    pub file_name: String,
    pub mime_type: String,
    pub data_base64: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceArchive {
    manifest: ArchiveManifest,
    threads: Vec<ArchiveThread>,
    thread_blocks: Vec<ArchiveThreadBlock>,
    artifacts: Vec<ArchiveArtifact>,
    artifact_versions: Vec<ArchiveArtifactVersion>,
    runs: Vec<ArchiveRun>,
    run_events: Vec<ArchiveRunEvent>,
    #[serde(default)]
    run_checkpoints: Vec<ArchiveRunCheckpoint>,
    #[serde(default)]
    approvals: Vec<ArchiveApproval>,
    receipts: Vec<ArchiveReceipt>,
    artifact_files: Vec<ArchiveArtifactFile>,
    #[serde(default)]
    bots: Vec<ArchiveBot>,
    #[serde(default)]
    bot_versions: Vec<ArchiveBotVersion>,
    #[serde(default)]
    bot_thread_members: Vec<ArchiveBotThreadMember>,
    #[serde(default)]
    bot_databases: Vec<crate::bot_data::PortableBotDatabase>,
    #[serde(default)]
    bot_database_rows: Vec<crate::bot_data::PortableBotDatabaseRow>,
    #[serde(default)]
    memories: Vec<ArchiveMemory>,
    #[serde(default)]
    skills: Vec<ArchiveSkill>,
    #[serde(default)]
    skill_versions: Vec<ArchiveSkillVersion>,
    #[serde(default)]
    routines: Vec<ArchiveRoutine>,
    #[serde(default)]
    routine_versions: Vec<ArchiveRoutineVersion>,
    #[serde(default)]
    delegations: Vec<ArchiveDelegation>,
    #[serde(default)]
    delegation_targets: Vec<ArchiveDelegationTarget>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveManifest {
    format: String,
    version: u32,
    exported_at: String,
    contains_credentials: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveThread {
    id: String,
    owner_uid: String,
    title: String,
    status: String,
    latest_block_sequence: i64,
    active_run_ref: Option<String>,
    body: Value,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveThreadBlock {
    thread_id: String,
    sequence: i64,
    id: String,
    kind: String,
    body: Value,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveArtifact {
    id: String,
    kind: String,
    project_id: String,
    title: String,
    current_version: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveArtifactVersion {
    artifact_id: String,
    version: String,
    payload: Value,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveRun {
    id: String,
    thread_id: String,
    artifact_id: String,
    status: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveRunEvent {
    run_id: String,
    sequence: i64,
    event_type: String,
    payload: Value,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveRunCheckpoint {
    run_id: String,
    step_index: i64,
    body: Value,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveApproval {
    id: String,
    run_id: String,
    step_index: i64,
    status: String,
    body: Value,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveReceipt {
    id: String,
    run_id: String,
    artifact_id: String,
    body: Value,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveArtifactFile {
    artifact_id: String,
    hash: String,
    file_name: String,
    mime_type: String,
    size: u64,
    created_at: String,
    data_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveBot {
    id: String,
    thread_id: String,
    current_version: i64,
    name: String,
    status: String,
    latest_status: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveBotVersion {
    bot_id: String,
    version: i64,
    spec: Value,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveBotThreadMember {
    bot_id: String,
    thread_id: String,
    role: String,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveMemory {
    id: String,
    bot_id: Option<String>,
    scope: String,
    body: Value,
    source_run_id: Option<String>,
    expires_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveSkill {
    id: String,
    current_version: i64,
    name: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveSkillVersion {
    skill_id: String,
    version: i64,
    body: Value,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveRoutine {
    id: String,
    bot_id: String,
    current_version: i64,
    title: String,
    trigger_kind: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveRoutineVersion {
    routine_id: String,
    version: i64,
    body: Value,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveDelegation {
    id: String,
    parent_bot_id: String,
    parent_thread_id: String,
    parent_bot_name: String,
    parent_bot_version: i64,
    status: String,
    body: Value,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveDelegationTarget {
    delegation_id: String,
    bot_id: String,
    thread_id: String,
    bot_name: String,
    bot_version: i64,
    status: String,
    max_actions: i64,
    deadline_at: String,
    snapshot: Value,
    run_id: Option<String>,
    result: Option<Value>,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

pub fn bootstrap_local_workspace(state: &AppState) -> Result<WorkspaceSnapshot, String> {
    load_snapshot_for_thread(state, "local-welcome")
        .or_else(|_| load_most_recent_legacy_snapshot(state))
}

pub fn bootstrap_local_bots(state: &AppState) -> Result<LocalBotsSnapshot, String> {
    let bots = load_bots(state)?;
    let active_bot = bots
        .iter()
        .find(|bot| bot_is_active(state, &bot.id).unwrap_or(false))
        .cloned()
        .or_else(|| bots.first().cloned())
        .ok_or_else(|| "Codelit could not create the starter bot.".to_string())?;
    let workspace = load_snapshot_for_thread(state, &active_bot.thread_id)?;
    Ok(LocalBotsSnapshot {
        bots,
        active_bot,
        workspace,
    })
}

pub fn create_local_bot(
    state: &AppState,
    request: CreateLocalBotRequest,
) -> Result<LocalBotsSnapshot, String> {
    validate_identifier(&request.id, "bot")?;
    let name = request.name.trim().to_string();
    let job = request.job.trim().to_string();
    validate_runtime_label(&name, 64, "bot name")?;
    validate_runtime_label(&job, 500, "bot job")?;
    let avatar = request
        .avatar
        .unwrap_or_else(|| deterministic_bot_avatar(&request.id));
    validate_bot_avatar(&avatar)?;
    let thread_id = format!("thread-{}", request.id);
    validate_identifier(&thread_id, "bot Thread")?;

    let spec = starter_bot_spec(&request.id, &name, &job, &avatar, &request.created_at);
    let thread = bot_thread_body(&thread_id, &name, &request.created_at);
    let welcome = bot_welcome_block(&request.id, &name, &job, &request.created_at);
    let thread_body = state
        .cipher
        .seal(&thread_context(&thread_id), &thread.to_string())?;
    let block_body = state
        .cipher
        .seal(&block_context(&thread_id, 1), &welcome.to_string())?;
    let spec_body = state
        .cipher
        .seal(&bot_version_context(&request.id, 1), &spec.to_string())?;

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    transaction
        .execute("UPDATE bots SET active = 0 WHERE active = 1", [])
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO threads
                (id, owner_uid, title, status, latest_block_sequence, body_json, created_at, updated_at)
             VALUES (?1, 'local-device', ?2, 'idle', 1, ?3, ?4, ?4)",
            params![thread_id, name, thread_body, request.created_at],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed") {
                "A bot with that identity already exists.".to_string()
            } else {
                error_text(error)
            }
        })?;
    transaction
        .execute(
            "INSERT INTO thread_blocks (thread_id, sequence, id, kind, body_json, created_at)
             VALUES (?1, 1, ?2, 'assistant-message', ?3, ?4)",
            params![
                thread_id,
                welcome["id"].as_str(),
                block_body,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO bots
                (id, thread_id, current_version, name, status, latest_status, active, created_at, updated_at)
             VALUES (?1, ?2, 1, ?3, 'sleeping', 'Ready for a task', 1, ?4, ?4)",
            params![request.id, thread_id, name, request.created_at],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO bot_versions (bot_id, version, spec_json, created_at)
             VALUES (?1, 1, ?2, ?3)",
            params![request.id, spec_body, request.created_at],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO bot_thread_members (bot_id, thread_id, role, created_at)
             VALUES (?1, ?2, 'owner', ?3)",
            params![request.id, thread_id, request.created_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    bootstrap_local_bots(state)
}

pub fn set_active_local_bot(state: &AppState, id: &str) -> Result<LocalBotsSnapshot, String> {
    validate_identifier(id, "bot")?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bots WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if !exists {
        return Err("That bot is no longer available on this Mac.".into());
    }
    transaction
        .execute("UPDATE bots SET active = 0 WHERE active = 1", [])
        .map_err(error_text)?;
    transaction
        .execute("UPDATE bots SET active = 1 WHERE id = ?1", params![id])
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    bootstrap_local_bots(state)
}

pub fn open_local_bot_context(state: &AppState, id: &str) -> Result<LocalBotContext, String> {
    validate_identifier(id, "bot")?;
    let bot = load_bot(state, id)?
        .ok_or_else(|| "That bot is no longer available on this Mac.".to_string())?;
    let workspace = load_snapshot_for_thread(state, &bot.thread_id)?;
    Ok(LocalBotContext { bot, workspace })
}

pub fn list_local_bot_group_members(
    state: &AppState,
    owner_bot_id: &str,
) -> Result<Vec<LocalBotRecord>, String> {
    validate_identifier(owner_bot_id, "bot")?;
    let owner = load_bot(state, owner_bot_id)?
        .ok_or_else(|| "That bot is no longer available on this Mac.".to_string())?;
    let member_ids = {
        let connection = state.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT bot_id FROM bot_thread_members
                 WHERE thread_id = ?1 AND role = 'member'
                 ORDER BY created_at ASC, bot_id ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map(params![owner.thread_id], |row| row.get::<_, String>(0))
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    if member_ids.len() > MAX_BOT_GROUP_MEMBERS || member_ids.iter().any(|id| id == owner_bot_id) {
        return Err("The saved conversation team is invalid.".into());
    }
    member_ids
        .into_iter()
        .map(|id| {
            load_bot(state, &id)?
                .ok_or_else(|| "A saved teammate is no longer available on this Mac.".to_string())
        })
        .collect()
}

pub fn update_local_bot_group_members(
    state: &AppState,
    request: UpdateLocalBotGroupMembersRequest,
) -> Result<Vec<LocalBotRecord>, String> {
    validate_identifier(&request.owner_bot_id, "bot")?;
    if request.member_bot_ids.len() > MAX_BOT_GROUP_MEMBERS {
        return Err("Keep one or two specialist bots in a conversation.".into());
    }
    let updated_at = canonical_bot_time(&request.updated_at, "teammate update time")?;
    let owner = load_bot(state, &request.owner_bot_id)?
        .ok_or_else(|| "That bot is no longer available on this Mac.".to_string())?;
    let mut unique_ids = HashSet::new();
    for member_id in &request.member_bot_ids {
        validate_identifier(member_id, "teammate")?;
        if member_id == &request.owner_bot_id || !unique_ids.insert(member_id.as_str()) {
            return Err("Choose one or two different specialist bots.".into());
        }
        if load_bot(state, member_id)?.is_none() {
            return Err("One of the selected teammates is no longer available.".into());
        }
    }
    let event_id = format!(
        "event-{}-team-{}",
        request.owner_bot_id,
        Utc::now().timestamp_micros()
    );
    let event = json!({
        "memberBotIds": request.member_bot_ids.clone(),
        "createdAt": updated_at.clone(),
    });
    let event_body = state
        .cipher
        .seal(&bot_event_context(&event_id), &event.to_string())?;

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    transaction
        .execute(
            "UPDATE bot_thread_members SET role = 'delegate'
             WHERE thread_id = ?1 AND role = 'member'
               AND EXISTS (
                 SELECT 1 FROM bot_delegation_targets target
                 JOIN bot_delegations delegation ON delegation.id = target.delegation_id
                 WHERE target.bot_id = bot_thread_members.bot_id
                   AND delegation.parent_thread_id = ?1
               )",
            params![owner.thread_id],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "DELETE FROM bot_thread_members WHERE thread_id = ?1 AND role = 'member'",
            params![owner.thread_id],
        )
        .map_err(error_text)?;
    for member_id in &request.member_bot_ids {
        transaction
            .execute(
                "INSERT INTO bot_thread_members (bot_id, thread_id, role, created_at)
                 VALUES (?1, ?2, 'member', ?3)
                 ON CONFLICT(bot_id, thread_id) DO UPDATE SET role = 'member'",
                params![member_id, owner.thread_id, updated_at],
            )
            .map_err(error_text)?;
    }
    if transaction
        .execute(
            "UPDATE bots SET updated_at = ?2 WHERE id = ?1",
            params![request.owner_bot_id, updated_at],
        )
        .map_err(error_text)?
        != 1
    {
        return Err("That bot is no longer available on this Mac.".into());
    }
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, 'team.changed', ?3, ?4)",
            params![event_id, request.owner_bot_id, event_body, updated_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    list_local_bot_group_members(state, &request.owner_bot_id)
}

pub fn list_local_bot_memories(
    state: &AppState,
    bot_id: &str,
) -> Result<Vec<LocalBotMemoryRecord>, String> {
    validate_identifier(bot_id, "bot")?;
    if load_bot(state, bot_id)?.is_none() {
        return Err("That bot is no longer available on this Mac.".into());
    }
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT id, bot_id, scope, body_json, source_run_id, expires_at, created_at, updated_at
             FROM memories
             WHERE (bot_id = ?1 OR (bot_id IS NULL AND scope = 'workspace'))
             ORDER BY updated_at DESC, id ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![bot_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(error_text)?;
    let mut memories = Vec::new();
    for row in rows {
        let (
            id,
            owner_bot_id,
            scope,
            stored_body,
            source_run_id,
            expires_at,
            created_at,
            updated_at,
        ) = row.map_err(error_text)?;
        if !matches!(
            (scope.as_str(), owner_bot_id.as_deref()),
            ("bot", Some(_)) | ("workspace", None)
        ) {
            return Err("A stored memory has an invalid scope.".into());
        }
        let created_at = canonical_memory_time(&created_at, "creation time")?;
        let updated_at = canonical_memory_time(&updated_at, "update time")?;
        let expires_at = expires_at
            .as_deref()
            .map(|value| canonical_memory_time(value, "expiry time"))
            .transpose()?;
        if expires_at.as_deref().is_some_and(|value| {
            DateTime::parse_from_rfc3339(value)
                .is_ok_and(|expiry| expiry.with_timezone(&Utc) <= Utc::now())
        }) {
            continue;
        }
        let body = open_json_body(&state.cipher, &memory_context(&id), &stored_body)?;
        validate_memory_body(&body)?;
        memories.push(LocalBotMemoryRecord {
            id,
            bot_id: owner_bot_id,
            scope,
            kind: body
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("fact")
                .to_string(),
            body: body
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            source: body
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("user")
                .to_string(),
            confidence: body
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(1.0),
            sensitivity: body
                .get("sensitivity")
                .and_then(Value::as_str)
                .unwrap_or("normal")
                .to_string(),
            approval_state: body
                .get("approvalState")
                .and_then(Value::as_str)
                .unwrap_or("approved")
                .to_string(),
            source_run_id,
            expires_at,
            created_at,
            updated_at,
        });
    }
    Ok(memories)
}

pub fn list_local_bot_memory_proposals(
    state: &AppState,
    bot_id: &str,
) -> Result<Vec<LocalBotMemoryProposalRecord>, String> {
    validate_identifier(bot_id, "bot")?;
    if load_bot(state, bot_id)?.is_none() {
        return Err("That bot is no longer available on this Mac.".into());
    }
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT id, body_json, source_run_id, created_at, updated_at
             FROM memory_proposals
             WHERE bot_id = ?1 AND status = 'pending' AND source_run_id IS NOT NULL
             ORDER BY updated_at DESC, id ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![bot_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(error_text)?;
    let mut proposals = Vec::new();
    for row in rows {
        let (id, stored_body, source_run_id, created_at, updated_at) = row.map_err(error_text)?;
        let body = open_json_body(&state.cipher, &memory_proposal_context(&id), &stored_body)?;
        validate_memory_proposal_body(&body)?;
        proposals.push(memory_proposal_record(
            id,
            bot_id.to_string(),
            body,
            source_run_id,
            canonical_memory_time(&created_at, "proposal creation time")?,
            canonical_memory_time(&updated_at, "proposal update time")?,
        ));
    }
    Ok(proposals)
}

pub fn create_local_bot_memory_proposal(
    state: &AppState,
    request: CreateLocalBotMemoryProposalRequest,
) -> Result<Option<LocalBotMemoryProposalRecord>, String> {
    validate_identifier(&request.id, "memory proposal")?;
    validate_identifier(&request.actor_bot_id, "bot")?;
    validate_identifier(&request.source_run_id, "run")?;
    let created_at = canonical_memory_time(&request.created_at, "proposal creation time")?;
    if !matches!(
        request.kind.as_str(),
        "preference" | "fact" | "procedure" | "decision"
    ) {
        return Err("The memory proposal type is invalid.".into());
    }
    let body = request.body.trim().to_string();
    validate_runtime_label(&body, 280, "memory proposal")?;
    validate_memory_safety(&body)?;
    let proposal_body = json!({
        "scope": "bot",
        "kind": request.kind,
        "body": body,
        "source": "inferred",
        "confidence": 0.86,
        "sensitivity": "normal",
        "approvalState": "pending",
    });
    validate_memory_proposal_body(&proposal_body)?;

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let source_is_valid: bool = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM runs
                JOIN bots ON bots.thread_id = runs.thread_id
                WHERE runs.id = ?1 AND bots.id = ?2 AND runs.status = 'completed'
             )",
            params![request.source_run_id, request.actor_bot_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if !source_is_valid {
        return Err("A memory suggestion needs a completed run from this bot.".into());
    }
    if memory_body_already_known(
        &transaction,
        &state.cipher,
        &request.actor_bot_id,
        &body,
        &created_at,
    )? {
        return Ok(None);
    }
    let pending_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM memory_proposals WHERE bot_id = ?1 AND status = 'pending'",
            params![request.actor_bot_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if pending_count >= MAX_PENDING_MEMORY_PROPOSALS_PER_BOT {
        return Ok(None);
    }
    let sealed = state.cipher.seal(
        &memory_proposal_context(&request.id),
        &proposal_body.to_string(),
    )?;
    transaction
        .execute(
            "INSERT INTO memory_proposals
                (id, bot_id, status, body_json, source_run_id, created_at, updated_at)
             VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?5)",
            params![
                request.id,
                request.actor_bot_id,
                sealed,
                request.source_run_id,
                created_at
            ],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed") {
                "That memory suggestion already exists.".to_string()
            } else {
                error_text(error)
            }
        })?;
    insert_bot_memory_event(
        &transaction,
        &state.cipher,
        &request.actor_bot_id,
        "memory.proposed",
        json!({
            "proposalId": request.id,
            "sourceRunId": request.source_run_id,
            "kind": request.kind,
            "createdAt": created_at,
        }),
        &created_at,
    )?;
    transaction.commit().map_err(error_text)?;
    Ok(Some(memory_proposal_record(
        request.id,
        request.actor_bot_id,
        proposal_body,
        request.source_run_id,
        created_at.clone(),
        created_at,
    )))
}

pub fn review_local_bot_memory_proposal(
    state: &AppState,
    request: ReviewLocalBotMemoryProposalRequest,
) -> Result<Option<LocalBotMemoryRecord>, String> {
    validate_identifier(&request.id, "memory proposal")?;
    validate_identifier(&request.actor_bot_id, "bot")?;
    if !matches!(request.decision.as_str(), "approve" | "dismiss") {
        return Err("Choose whether to remember or dismiss this suggestion.".into());
    }
    if !matches!(request.scope.as_str(), "bot" | "workspace") {
        return Err("The memory scope is invalid.".into());
    }
    let reviewed_at = canonical_memory_time(&request.reviewed_at, "proposal review time")?;
    let expires_at = request
        .expires_at
        .as_deref()
        .map(|value| canonical_memory_time(value, "expiry time"))
        .transpose()?;
    if expires_at
        .as_deref()
        .is_some_and(|expiry| expiry <= reviewed_at.as_str())
    {
        return Err("Choose a memory expiry time in the future.".into());
    }

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let row = transaction
        .query_row(
            "SELECT body_json, source_run_id
             FROM memory_proposals
             WHERE id = ?1 AND bot_id = ?2 AND status = 'pending' AND source_run_id IS NOT NULL",
            params![request.id, request.actor_bot_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(error_text)?
        .ok_or_else(|| "That memory suggestion is no longer waiting for review.".to_string())?;
    let proposal_body =
        open_json_body(&state.cipher, &memory_proposal_context(&request.id), &row.0)?;
    validate_memory_proposal_body(&proposal_body)?;
    let status = if request.decision == "approve" {
        "approved"
    } else {
        "dismissed"
    };
    let memory = if status == "approved" {
        let owner_bot_id = (request.scope == "bot").then(|| request.actor_bot_id.clone());
        let count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM memories
                 WHERE scope = ?1
                   AND ((?2 IS NULL AND bot_id IS NULL) OR bot_id = ?2)
                   AND (expires_at IS NULL OR expires_at > ?3)",
                params![request.scope, owner_bot_id, reviewed_at],
                |row| row.get(0),
            )
            .map_err(error_text)?;
        if count >= MAX_MEMORIES_PER_SCOPE {
            return Err(
                "This memory scope already has 200 items. Forget one before adding another.".into(),
            );
        }
        let memory_hash = format!("{:x}", Sha256::digest(request.id.as_bytes()));
        let memory_id = format!("memory-reviewed-{memory_hash}");
        let stored = json!({
            "kind": proposal_body["kind"],
            "body": proposal_body["body"],
            "source": "inferred",
            "confidence": proposal_body["confidence"],
            "sensitivity": "normal",
            "approvalState": "approved",
        });
        validate_memory_body(&stored)?;
        let sealed = state
            .cipher
            .seal(&memory_context(&memory_id), &stored.to_string())?;
        transaction
            .execute(
                "INSERT INTO memories
                    (id, bot_id, scope, body_json, source_run_id, expires_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    memory_id,
                    owner_bot_id,
                    request.scope,
                    sealed,
                    row.1,
                    expires_at,
                    reviewed_at
                ],
            )
            .map_err(error_text)?;
        Some(LocalBotMemoryRecord {
            id: memory_id,
            bot_id: owner_bot_id,
            scope: request.scope.clone(),
            kind: proposal_body["kind"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            body: proposal_body["body"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            source: "inferred".into(),
            confidence: proposal_body["confidence"].as_f64().unwrap_or(0.86),
            sensitivity: "normal".into(),
            approval_state: "approved".into(),
            source_run_id: Some(row.1.clone()),
            expires_at: expires_at.clone(),
            created_at: reviewed_at.clone(),
            updated_at: reviewed_at.clone(),
        })
    } else {
        None
    };
    if transaction
        .execute(
            "UPDATE memory_proposals SET status = ?3, updated_at = ?4
             WHERE id = ?1 AND bot_id = ?2 AND status = 'pending'",
            params![request.id, request.actor_bot_id, status, reviewed_at],
        )
        .map_err(error_text)?
        != 1
    {
        return Err("That memory suggestion is no longer waiting for review.".into());
    }
    insert_bot_memory_event(
        &transaction,
        &state.cipher,
        &request.actor_bot_id,
        if status == "approved" {
            "memory.proposal-approved"
        } else {
            "memory.proposal-dismissed"
        },
        json!({
            "proposalId": request.id,
            "sourceRunId": row.1,
            "scope": request.scope,
            "expiresAt": expires_at,
            "createdAt": reviewed_at,
        }),
        &reviewed_at,
    )?;
    transaction.commit().map_err(error_text)?;
    Ok(memory)
}

pub fn save_local_bot_memory(
    state: &AppState,
    request: SaveLocalBotMemoryRequest,
) -> Result<LocalBotMemoryRecord, String> {
    validate_identifier(&request.id, "memory")?;
    validate_identifier(&request.actor_bot_id, "bot")?;
    let created_at = canonical_memory_time(&request.created_at, "creation time")?;
    let expires_at = request
        .expires_at
        .as_deref()
        .map(|value| canonical_memory_time(value, "expiry time"))
        .transpose()?;
    if !matches!(request.scope.as_str(), "bot" | "workspace") {
        return Err("The memory scope is invalid.".into());
    }
    if !matches!(
        request.kind.as_str(),
        "preference" | "fact" | "procedure" | "decision"
    ) {
        return Err("The memory type is invalid.".into());
    }
    let body = request.body.trim().to_string();
    validate_runtime_label(&body, 1_000, "memory")?;
    validate_memory_safety(&body)?;
    if load_bot(state, &request.actor_bot_id)?.is_none() {
        return Err("That bot is no longer available on this Mac.".into());
    }

    let owner_bot_id = (request.scope == "bot").then(|| request.actor_bot_id.clone());
    let stored = json!({
        "kind": request.kind,
        "body": body,
        "source": "user",
        "confidence": 1.0,
        "sensitivity": "normal",
        "approvalState": "approved",
    });
    let sealed = state
        .cipher
        .seal(&memory_context(&request.id), &stored.to_string())?;
    let event_id = format!(
        "event-{}-{}",
        request.actor_bot_id,
        Utc::now().timestamp_micros()
    );
    let event = json!({
        "memoryId": request.id,
        "scope": request.scope,
        "kind": request.kind,
        "createdAt": request.created_at,
    });
    let event_body = state
        .cipher
        .seal(&bot_event_context(&event_id), &event.to_string())?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM memories
             WHERE scope = ?1
               AND ((?2 IS NULL AND bot_id IS NULL) OR bot_id = ?2)
               AND (expires_at IS NULL OR expires_at > ?3)",
            params![request.scope, owner_bot_id, canonical_now()],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if count >= MAX_MEMORIES_PER_SCOPE {
        return Err(
            "This memory scope already has 200 items. Forget one before adding another.".into(),
        );
    }
    transaction
        .execute(
            "INSERT INTO memories
                (id, bot_id, scope, body_json, source_run_id, expires_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?6)",
            params![
                request.id,
                owner_bot_id,
                request.scope,
                sealed,
                expires_at,
                created_at
            ],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed") {
                "That memory already exists.".to_string()
            } else {
                error_text(error)
            }
        })?;
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, 'memory.created', ?3, ?4)",
            params![event_id, request.actor_bot_id, event_body, created_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    Ok(LocalBotMemoryRecord {
        id: request.id,
        bot_id: owner_bot_id,
        scope: request.scope,
        kind: request.kind,
        body,
        source: "user".into(),
        confidence: 1.0,
        sensitivity: "normal".into(),
        approval_state: "approved".into(),
        source_run_id: None,
        expires_at,
        created_at: created_at.clone(),
        updated_at: created_at,
    })
}

pub fn delete_local_bot_memory(
    state: &AppState,
    request: DeleteLocalBotMemoryRequest,
) -> Result<LocalBotMemoryRecord, String> {
    validate_identifier(&request.id, "memory")?;
    validate_identifier(&request.actor_bot_id, "bot")?;
    let deleted_at = canonical_memory_time(&request.deleted_at, "deletion time")?;
    let memory = list_local_bot_memories(state, &request.actor_bot_id)?
        .into_iter()
        .find(|memory| memory.id == request.id)
        .ok_or_else(|| "That memory is no longer available to this bot.".to_string())?;
    let event_id = format!(
        "event-{}-{}",
        request.actor_bot_id,
        Utc::now().timestamp_micros()
    );
    let event_body = state.cipher.seal(
        &bot_event_context(&event_id),
        &json!({
            "memoryId": memory.id,
            "scope": memory.scope,
            "kind": memory.kind,
            "createdAt": deleted_at,
        })
        .to_string(),
    )?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    if transaction
        .execute("DELETE FROM memories WHERE id = ?1", params![request.id])
        .map_err(error_text)?
        != 1
    {
        return Err("That memory is no longer available to this bot.".into());
    }
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, 'memory.deleted', ?3, ?4)",
            params![event_id, request.actor_bot_id, event_body, deleted_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    Ok(memory)
}

pub fn clear_local_bot_memories(
    state: &AppState,
    request: ClearLocalBotMemoriesRequest,
) -> Result<usize, String> {
    validate_identifier(&request.actor_bot_id, "bot")?;
    let deleted_at = canonical_memory_time(&request.deleted_at, "deletion time")?;
    if load_bot(state, &request.actor_bot_id)?.is_none() {
        return Err("That bot is no longer available on this Mac.".into());
    }
    let event_id = format!(
        "event-{}-{}",
        request.actor_bot_id,
        Utc::now().timestamp_micros()
    );
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let deleted_count = transaction
        .execute(
            "DELETE FROM memories
             WHERE bot_id = ?1
                OR (?2 = 1 AND bot_id IS NULL AND scope = 'workspace')",
            params![request.actor_bot_id, request.include_shared],
        )
        .map_err(error_text)?;
    let deleted_proposal_count = transaction
        .execute(
            "DELETE FROM memory_proposals WHERE bot_id = ?1 AND status = 'pending'",
            params![request.actor_bot_id],
        )
        .map_err(error_text)?;
    if deleted_count == 0 && deleted_proposal_count == 0 {
        return Ok(0);
    }
    let event = json!({
        "deletedCount": deleted_count,
        "deletedProposalCount": deleted_proposal_count,
        "includedShared": request.include_shared,
        "createdAt": deleted_at,
    });
    let event_body = state
        .cipher
        .seal(&bot_event_context(&event_id), &event.to_string())?;
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, 'memory.cleared', ?3, ?4)",
            params![event_id, request.actor_bot_id, event_body, deleted_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    Ok(deleted_count + deleted_proposal_count)
}

fn memory_proposal_record(
    id: String,
    bot_id: String,
    body: Value,
    source_run_id: String,
    created_at: String,
    updated_at: String,
) -> LocalBotMemoryProposalRecord {
    LocalBotMemoryProposalRecord {
        id,
        bot_id,
        scope: "bot".into(),
        kind: body["kind"].as_str().unwrap_or_default().to_string(),
        body: body["body"].as_str().unwrap_or_default().to_string(),
        source: "inferred".into(),
        confidence: body["confidence"].as_f64().unwrap_or(0.86),
        sensitivity: "normal".into(),
        approval_state: "pending".into(),
        source_run_id,
        created_at,
        updated_at,
    }
}

fn memory_body_already_known(
    transaction: &Transaction<'_>,
    cipher: &DataCipher,
    bot_id: &str,
    body: &str,
    now: &str,
) -> Result<bool, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, body_json, 0 AS proposal
             FROM memories
             WHERE (bot_id = ?1 OR (bot_id IS NULL AND scope = 'workspace'))
               AND (expires_at IS NULL OR expires_at > ?2)
             UNION ALL
             SELECT id, body_json, 1 AS proposal
             FROM memory_proposals
             WHERE bot_id = ?1 AND status = 'pending'",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![bot_id, now], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .map_err(error_text)?;
    for row in rows {
        let (id, stored_body, proposal) = row.map_err(error_text)?;
        let context = if proposal {
            memory_proposal_context(&id)
        } else {
            memory_context(&id)
        };
        let decoded = open_json_body(cipher, &context, &stored_body)?;
        if proposal {
            validate_memory_proposal_body(&decoded)?;
        } else {
            validate_memory_body(&decoded)?;
        }
        if decoded["body"]
            .as_str()
            .is_some_and(|stored| stored.trim().eq_ignore_ascii_case(body.trim()))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn insert_bot_memory_event(
    transaction: &Transaction<'_>,
    cipher: &DataCipher,
    bot_id: &str,
    event_type: &str,
    body: Value,
    created_at: &str,
) -> Result<(), String> {
    let event_id = format!("event-{bot_id}-{}", Utc::now().timestamp_micros());
    let event_body = cipher.seal(&bot_event_context(&event_id), &body.to_string())?;
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![event_id, bot_id, event_type, event_body, created_at],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn list_local_bot_skills(state: &AppState) -> Result<Vec<LocalBotSkillRecord>, String> {
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT skills.id, skills.current_version, skills.name,
                    skill_versions.body_json, skills.created_at, skills.updated_at
             FROM skills
             JOIN skill_versions
               ON skill_versions.skill_id = skills.id
              AND skill_versions.version = skills.current_version
             ORDER BY skills.updated_at DESC, skills.id ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(error_text)?;
    let mut skills = Vec::new();
    for row in rows {
        let (id, version, name, stored_body, created_at, updated_at) = row.map_err(error_text)?;
        let body = open_json_body(
            &state.cipher,
            &skill_version_context(&id, version),
            &stored_body,
        )?;
        validate_skill_body(&name, &body)?;
        skills.push(skill_record_from_body(
            id,
            version,
            name,
            body,
            canonical_skill_time(&created_at, "creation time")?,
            canonical_skill_time(&updated_at, "update time")?,
        )?);
    }
    Ok(skills)
}

pub fn save_local_bot_skill(
    state: &AppState,
    request: SaveLocalBotSkillRequest,
) -> Result<LocalBotSkillRecord, String> {
    validate_identifier(&request.id, "skill")?;
    validate_identifier(&request.actor_bot_id, "bot")?;
    if load_bot(state, &request.actor_bot_id)?.is_none() {
        return Err("That bot is no longer available on this Mac.".into());
    }
    if list_local_bot_skills(state)?
        .into_iter()
        .find(|skill| skill.id == request.id)
        .is_some_and(|skill| skill.source != "taught")
    {
        return Err("Packaged and imported skills cannot be overwritten as taught skills.".into());
    }
    let name = request.name.trim().to_string();
    let description = request.description.trim().to_string();
    let instructions = request.instructions.trim().to_string();
    validate_runtime_label(&name, 64, "skill name")?;
    validate_runtime_label(&description, 280, "skill description")?;
    validate_runtime_label(&instructions, 4_000, "skill instructions")?;
    validate_skill_safety(&instructions)?;
    validate_skill_capabilities(&request.capability_ids)?;
    let updated_at = canonical_skill_time(&request.created_at, "update time")?;

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let existing = transaction
        .query_row(
            "SELECT current_version, created_at FROM skills WHERE id = ?1",
            params![request.id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(error_text)?;
    let duplicate_name = transaction
        .query_row(
            "SELECT id FROM skills WHERE lower(trim(name)) = lower(trim(?1)) AND id <> ?2 LIMIT 1",
            params![name, request.id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error_text)?;
    if duplicate_name.is_some() {
        return Err("A reusable skill with that name already exists.".into());
    }
    let (version, created_at) = match existing {
        Some((current_version, original_created_at)) => {
            if request.expected_version != Some(current_version) {
                return Err(
                    "This skill changed before your update was saved. Review it and try again."
                        .into(),
                );
            }
            (current_version + 1, original_created_at)
        }
        None => {
            if request.expected_version.is_some_and(|version| version != 0) {
                return Err("That skill is no longer available to update.".into());
            }
            let count: i64 = transaction
                .query_row("SELECT COUNT(*) FROM skills", [], |row| row.get(0))
                .map_err(error_text)?;
            if count >= MAX_WORKSPACE_SKILLS {
                return Err("This workspace already has 100 reusable skills. Remove one before teaching another.".into());
            }
            (1, updated_at.clone())
        }
    };
    let body_without_checksum = json!({
        "schemaVersion": 2,
        "description": description,
        "instructions": instructions,
        "capabilityIds": request.capability_ids,
        "inputSchema": request.input_schema,
        "outputSchema": request.output_schema,
        "requiredPermissions": request.required_permissions,
        "effects": request.effects,
        "examples": request.examples,
        "checks": request.checks,
        "source": "taught",
        "trustState": "reviewed",
    });
    let checksum = skill_checksum(&name, &body_without_checksum)?;
    let mut body = body_without_checksum;
    body["checksum"] = Value::String(checksum.clone());
    validate_skill_body(&name, &body)?;
    let sealed = state.cipher.seal(
        &skill_version_context(&request.id, version),
        &body.to_string(),
    )?;
    if version == 1 {
        transaction
            .execute(
                "INSERT INTO skills (id, current_version, name, created_at, updated_at)
                 VALUES (?1, 1, ?2, ?3, ?3)",
                params![request.id, name, created_at],
            )
            .map_err(error_text)?;
    } else {
        transaction
            .execute(
                "UPDATE skills
                 SET current_version = ?2, name = ?3, updated_at = ?4
                 WHERE id = ?1",
                params![request.id, version, name, updated_at],
            )
            .map_err(error_text)?;
    }
    transaction
        .execute(
            "INSERT INTO skill_versions (skill_id, version, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![request.id, version, sealed, updated_at],
        )
        .map_err(error_text)?;
    let event_id = format!(
        "event-{}-{}",
        request.actor_bot_id,
        Utc::now().timestamp_micros()
    );
    let event = json!({
        "skillId": request.id,
        "skillVersion": version,
        "skillName": name,
        "checksum": checksum,
        "createdAt": updated_at,
    });
    let event_body = state
        .cipher
        .seal(&bot_event_context(&event_id), &event.to_string())?;
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                event_id,
                request.actor_bot_id,
                if version == 1 {
                    "skill.taught"
                } else {
                    "skill.updated"
                },
                event_body,
                updated_at
            ],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    skill_record_from_body(request.id, version, name, body, created_at, updated_at)
}

pub fn import_local_bot_skill_package(
    state: &AppState,
    actor_bot_id: &str,
    bytes: &[u8],
    imported_at: &str,
) -> Result<LocalBotSkillRecord, String> {
    validate_identifier(actor_bot_id, "bot")?;
    if load_bot(state, actor_bot_id)?.is_none() {
        return Err("That bot is no longer available on this Mac.".into());
    }
    if bytes.is_empty() || bytes.len() > 256 * 1024 {
        return Err("Choose a skill package smaller than 256 KB.".into());
    }
    let manifest = serde_json::from_slice::<PackagedBotSkillManifest>(bytes)
        .map_err(|_| "The selected file is not a valid Codelit skill package.".to_string())?;
    validate_identifier(&manifest.id, "imported skill package")?;
    if manifest.version < 1 || manifest.version > 10_000 {
        return Err("The imported skill package version is invalid.".into());
    }
    let imported_at = canonical_skill_time(imported_at, "import time")?;
    let body = packaged_skill_body(&manifest, "imported", "unreviewed")?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    let id = format!("skill-imported-{}", &digest[..20]);

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let duplicate_name = transaction
        .query_row(
            "SELECT id FROM skills WHERE lower(trim(name)) = lower(trim(?1)) LIMIT 1",
            params![manifest.name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error_text)?;
    if let Some(existing_id) = duplicate_name {
        if existing_id == id {
            return Err("That exact skill package is already imported.".into());
        }
        return Err("A reusable skill with that name already exists.".into());
    }
    let count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM skills", [], |row| row.get(0))
        .map_err(error_text)?;
    if count >= MAX_WORKSPACE_SKILLS {
        return Err(
            "This workspace already has 100 reusable skills. Remove one before importing another."
                .into(),
        );
    }
    let sealed = state.cipher.seal(
        &skill_version_context(&id, manifest.version),
        &body.to_string(),
    )?;
    transaction
        .execute(
            "INSERT INTO skills (id, current_version, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, manifest.version, manifest.name, imported_at],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO skill_versions (skill_id, version, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, manifest.version, sealed, imported_at],
        )
        .map_err(error_text)?;
    insert_bot_memory_event(
        &transaction,
        &state.cipher,
        actor_bot_id,
        "skill.imported",
        json!({
            "skillId": id,
            "skillVersion": manifest.version,
            "skillName": manifest.name,
            "checksum": body["checksum"],
            "createdAt": imported_at,
        }),
        &imported_at,
    )?;
    transaction.commit().map_err(error_text)?;
    skill_record_from_body(
        id,
        manifest.version,
        manifest.name,
        body,
        imported_at.clone(),
        imported_at,
    )
}

pub fn review_imported_bot_skill(
    state: &AppState,
    request: ReviewImportedBotSkillRequest,
) -> Result<Option<LocalBotSkillRecord>, String> {
    validate_identifier(&request.id, "skill")?;
    validate_identifier(&request.actor_bot_id, "bot")?;
    if !matches!(request.decision.as_str(), "approve" | "discard") {
        return Err("Choose whether to approve or discard this skill package.".into());
    }
    if load_bot(state, &request.actor_bot_id)?.is_none() {
        return Err("That bot is no longer available on this Mac.".into());
    }
    let reviewed_at = canonical_skill_time(&request.reviewed_at, "review time")?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let row = transaction
        .query_row(
            "SELECT skills.current_version, skills.name, skills.created_at,
                    skill_versions.body_json
             FROM skills
             JOIN skill_versions
               ON skill_versions.skill_id = skills.id
              AND skill_versions.version = skills.current_version
             WHERE skills.id = ?1",
            params![request.id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(error_text)?
        .ok_or_else(|| "That imported skill is no longer available.".to_string())?;
    if row.0 != request.expected_version {
        return Err("This imported skill changed before it was reviewed. Inspect it again.".into());
    }
    let body = open_json_body(
        &state.cipher,
        &skill_version_context(&request.id, row.0),
        &row.3,
    )?;
    validate_skill_body(&row.1, &body)?;
    if body.get("source").and_then(Value::as_str) != Some("imported")
        || body.get("trustState").and_then(Value::as_str) != Some("unreviewed")
    {
        return Err("Only an unreviewed imported skill can use this review.".into());
    }
    if request.decision == "discard" {
        transaction
            .execute("DELETE FROM skills WHERE id = ?1", params![request.id])
            .map_err(error_text)?;
        insert_bot_memory_event(
            &transaction,
            &state.cipher,
            &request.actor_bot_id,
            "skill.import-discarded",
            json!({
                "skillId": request.id,
                "skillVersion": row.0,
                "skillName": row.1,
                "createdAt": reviewed_at,
            }),
            &reviewed_at,
        )?;
        transaction.commit().map_err(error_text)?;
        return Ok(None);
    }

    let next_version = row.0 + 1;
    let mut body_without_checksum = body;
    let object = body_without_checksum
        .as_object_mut()
        .ok_or_else(|| "The imported skill body is invalid.".to_string())?;
    object.remove("checksum");
    object.insert("trustState".into(), Value::String("reviewed".into()));
    let checksum = skill_checksum(&row.1, &body_without_checksum)?;
    let mut approved_body = body_without_checksum;
    approved_body["checksum"] = Value::String(checksum.clone());
    validate_skill_body(&row.1, &approved_body)?;
    let sealed = state.cipher.seal(
        &skill_version_context(&request.id, next_version),
        &approved_body.to_string(),
    )?;
    transaction
        .execute(
            "INSERT INTO skill_versions (skill_id, version, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![request.id, next_version, sealed, reviewed_at],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "UPDATE skills SET current_version = ?2, updated_at = ?3 WHERE id = ?1",
            params![request.id, next_version, reviewed_at],
        )
        .map_err(error_text)?;
    insert_bot_memory_event(
        &transaction,
        &state.cipher,
        &request.actor_bot_id,
        "skill.import-approved",
        json!({
            "skillId": request.id,
            "skillVersion": next_version,
            "skillName": row.1,
            "checksum": checksum,
            "createdAt": reviewed_at,
        }),
        &reviewed_at,
    )?;
    transaction.commit().map_err(error_text)?;
    Ok(Some(skill_record_from_body(
        request.id,
        next_version,
        row.1,
        approved_body,
        row.2,
        reviewed_at,
    )?))
}

pub fn delete_local_bot_skill(
    state: &AppState,
    request: DeleteLocalBotSkillRequest,
) -> Result<LocalBotSkillRecord, String> {
    validate_identifier(&request.id, "skill")?;
    validate_identifier(&request.actor_bot_id, "bot")?;
    if load_bot(state, &request.actor_bot_id)?.is_none() {
        return Err("That bot is no longer available on this Mac.".into());
    }
    let deleted_at = canonical_skill_time(&request.deleted_at, "deletion time")?;
    let skill = list_local_bot_skills(state)?
        .into_iter()
        .find(|skill| skill.id == request.id)
        .ok_or_else(|| "That reusable skill is no longer available.".to_string())?;
    if skill.source == "built-in" {
        return Err("Packaged Codelit skills stay available with the app.".into());
    }
    let event_id = format!(
        "event-{}-{}",
        request.actor_bot_id,
        Utc::now().timestamp_micros()
    );
    let event_body = state.cipher.seal(
        &bot_event_context(&event_id),
        &json!({
            "skillId": skill.id,
            "skillVersion": skill.version,
            "skillName": skill.name,
            "checksum": skill.checksum,
            "createdAt": deleted_at,
        })
        .to_string(),
    )?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    if transaction
        .execute("DELETE FROM skills WHERE id = ?1", params![request.id])
        .map_err(error_text)?
        != 1
    {
        return Err("That reusable skill is no longer available.".into());
    }
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, 'skill.deleted', ?3, ?4)",
            params![event_id, request.actor_bot_id, event_body, deleted_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    Ok(skill)
}

fn update_bot_spec_fields(
    state: &AppState,
    id: &str,
    updated_at: &str,
    expected_version: Option<i64>,
    event_type: &str,
    event: Value,
    mutate: impl FnOnce(&mut Value) -> Result<(), String>,
) -> Result<LocalBotRecord, String> {
    validate_identifier(id, "bot")?;
    validate_runtime_label(updated_at, 80, "bot update time")?;
    if expected_version.is_some_and(|version| version < 1) {
        return Err("The expected bot version must be positive.".into());
    }
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let (current_version, stored_spec) = transaction
        .query_row(
            "SELECT b.current_version, v.spec_json
             FROM bots b
             JOIN bot_versions v ON v.bot_id = b.id AND v.version = b.current_version
             WHERE b.id = ?1",
            params![id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(error_text)?
        .ok_or_else(|| "That bot is no longer available on this Mac.".to_string())?;
    if let Some(expected_version) = expected_version
        && current_version != expected_version
    {
        return Err("That bot changed before this update. Review it and try again.".into());
    }
    let mut spec = open_json_body(
        &state.cipher,
        &bot_version_context(id, current_version),
        &stored_spec,
    )?;
    mutate(&mut spec)?;
    let next_version = current_version + 1;
    spec["version"] = json!(next_version);
    spec["updatedAt"] = json!(updated_at);
    let spec_body = state
        .cipher
        .seal(&bot_version_context(id, next_version), &spec.to_string())?;
    let event_id = format!("event-{id}-{}", Utc::now().timestamp_micros());
    let event_body = state
        .cipher
        .seal(&bot_event_context(&event_id), &event.to_string())?;
    transaction
        .execute(
            "INSERT INTO bot_versions (bot_id, version, spec_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, next_version, spec_body, updated_at],
        )
        .map_err(error_text)?;
    if transaction
        .execute(
            "UPDATE bots SET current_version = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, next_version, updated_at],
        )
        .map_err(error_text)?
        != 1
    {
        return Err("That bot is no longer available on this Mac.".into());
    }
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![event_id, id, event_type, event_body, updated_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_bot(state, id)?.ok_or_else(|| "The bot could not be reloaded after it changed.".into())
}

pub fn update_local_bot_goal(
    state: &AppState,
    request: UpdateLocalBotGoalRequest,
) -> Result<LocalBotRecord, String> {
    validate_bot_goal(&request.goal)?;
    let goal = request.goal.clone();
    update_bot_spec_fields(
        state,
        &request.id,
        &request.updated_at,
        request.expected_version,
        "goal.changed",
        json!({ "goal": goal, "createdAt": request.updated_at }),
        move |spec| {
            spec["goal"] = request.goal;
            Ok(())
        },
    )
}

pub fn update_local_bot_browser_domains(
    state: &AppState,
    request: UpdateLocalBotBrowserDomainsRequest,
) -> Result<LocalBotRecord, String> {
    let domains = normalize_browser_domain_scopes(&request.domains)?;
    if domains.len() != request.domains.len() {
        return Err("Bot browser domains must be unique.".into());
    }
    let event_domains = domains.clone();
    update_bot_spec_fields(
        state,
        &request.id,
        &request.updated_at,
        request.expected_version,
        "permissions.browser-domains.changed",
        json!({ "domains": event_domains, "createdAt": request.updated_at }),
        move |spec| {
            let policy = spec
                .get_mut("permissionPolicy")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "The bot permission policy is invalid.".to_string())?;
            policy.insert("browserDomains".into(), json!(domains));
            Ok(())
        },
    )
}

pub fn update_local_bot_routines(
    state: &AppState,
    request: UpdateLocalBotRoutinesRequest,
) -> Result<LocalBotRecord, String> {
    if request.routine_ids.len() > 32 {
        return Err("A bot can own at most 32 local routines.".into());
    }
    let mut unique = HashSet::new();
    for id in &request.routine_ids {
        validate_identifier(id, "routine")?;
        if !unique.insert(id.clone()) {
            return Err("The bot routine list contains a duplicate.".into());
        }
    }
    let routine_ids = request.routine_ids.clone();
    let event_ids = routine_ids.clone();
    let allow_background = request.allow_background && !routine_ids.is_empty();
    update_bot_spec_fields(
        state,
        &request.id,
        &request.updated_at,
        None,
        "routines.changed",
        json!({
            "routineIds": event_ids,
            "allowBackground": allow_background,
            "createdAt": request.updated_at,
        }),
        move |spec| {
            spec["routineIds"] = json!(routine_ids);
            let policy = spec
                .get_mut("autonomyPolicy")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| "The bot autonomy policy is invalid.".to_string())?;
            policy.insert(
                "mode".into(),
                json!(if allow_background {
                    "reviewed-routines"
                } else {
                    "manual"
                }),
            );
            policy.insert("allowBackground".into(), json!(allow_background));
            Ok(())
        },
    )
}

pub fn update_local_bot_status(
    state: &AppState,
    request: UpdateLocalBotStatusRequest,
) -> Result<LocalBotRecord, String> {
    validate_identifier(&request.id, "bot")?;
    if !bot_status_is_valid(&request.status) {
        return Err("The bot status is invalid.".into());
    }
    validate_runtime_label(&request.latest_status, 240, "bot status")?;
    let event_id = format!("event-{}-{}", request.id, Utc::now().timestamp_micros());
    let event = json!({
        "status": request.status,
        "message": request.latest_status,
        "createdAt": request.updated_at,
    });
    let event_body = state
        .cipher
        .seal(&bot_event_context(&event_id), &event.to_string())?;
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let updated = transaction
        .execute(
            "UPDATE bots SET status = ?2, latest_status = ?3, updated_at = ?4 WHERE id = ?1",
            params![
                request.id,
                request.status,
                request.latest_status,
                request.updated_at
            ],
        )
        .map_err(error_text)?;
    if updated == 0 {
        return Err("That bot is no longer available on this Mac.".into());
    }
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, 'status.changed', ?3, ?4)",
            params![event_id, request.id, event_body, request.updated_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_bot(state, &request.id)?
        .ok_or_else(|| "The bot could not be reloaded after its status changed.".into())
}

pub fn update_local_bot_approval_mode(
    state: &AppState,
    request: UpdateLocalBotApprovalModeRequest,
) -> Result<LocalBotRecord, String> {
    validate_identifier(&request.id, "bot")?;
    if !matches!(request.approval_mode.as_str(), "ask" | "safe-auto") {
        return Err("The bot approval mode is invalid.".into());
    }
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let current = transaction
        .query_row(
            "SELECT b.current_version, v.spec_json
             FROM bots b
             JOIN bot_versions v ON v.bot_id = b.id AND v.version = b.current_version
             WHERE b.id = ?1",
            params![request.id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(error_text)?
        .ok_or_else(|| "That bot is no longer available on this Mac.".to_string())?;
    let (current_version, stored_spec) = current;
    let mut spec = open_json_body(
        &state.cipher,
        &bot_version_context(&request.id, current_version),
        &stored_spec,
    )?;
    if spec["permissionPolicy"]["approvalMode"].as_str() == Some(request.approval_mode.as_str()) {
        drop(transaction);
        return load_bot(state, &request.id)?
            .ok_or_else(|| "The bot could not be reloaded after its permissions changed.".into());
    }
    let policy = spec
        .get_mut("permissionPolicy")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "The bot permission policy is invalid.".to_string())?;
    policy.insert(
        "approvalMode".into(),
        Value::String(request.approval_mode.clone()),
    );
    let next_version = current_version + 1;
    spec["version"] = json!(next_version);
    spec["updatedAt"] = json!(request.updated_at.clone());
    let spec_body = state.cipher.seal(
        &bot_version_context(&request.id, next_version),
        &spec.to_string(),
    )?;
    let event_id = format!("event-{}-{}", request.id, Utc::now().timestamp_micros());
    let event = json!({
        "approvalMode": request.approval_mode,
        "createdAt": request.updated_at,
    });
    let event_body = state
        .cipher
        .seal(&bot_event_context(&event_id), &event.to_string())?;
    transaction
        .execute(
            "INSERT INTO bot_versions (bot_id, version, spec_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![request.id, next_version, spec_body, request.updated_at],
        )
        .map_err(error_text)?;
    let updated = transaction
        .execute(
            "UPDATE bots SET current_version = ?2, updated_at = ?3 WHERE id = ?1",
            params![request.id, next_version, request.updated_at],
        )
        .map_err(error_text)?;
    if updated == 0 {
        return Err("That bot is no longer available on this Mac.".into());
    }
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, 'permissions.changed', ?3, ?4)",
            params![event_id, request.id, event_body, request.updated_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_bot(state, &request.id)?
        .ok_or_else(|| "The bot could not be reloaded after its permissions changed.".into())
}

pub fn update_local_bot_engine_policy(
    state: &AppState,
    request: UpdateLocalBotEnginePolicyRequest,
) -> Result<LocalBotRecord, String> {
    validate_identifier(&request.id, "bot")?;
    if !matches!(request.mode.as_str(), "auto" | "fixed") {
        return Err("The bot intelligence mode is invalid.".into());
    }
    if request.allowed_providers.is_empty() || request.allowed_providers.len() > 12 {
        return Err("Choose at least one supported intelligence provider.".into());
    }
    let mut allowed_providers = request.allowed_providers.clone();
    allowed_providers.sort();
    allowed_providers.dedup();
    if allowed_providers.len() != request.allowed_providers.len()
        || allowed_providers
            .iter()
            .any(|provider| !bot_provider_id_is_valid(provider))
    {
        return Err("The bot intelligence provider list is invalid.".into());
    }
    match (request.mode.as_str(), request.fixed_engine.as_ref()) {
        ("fixed", Some(engine)) => {
            if !bot_provider_id_is_valid(&engine.provider)
                || !allowed_providers.contains(&engine.provider)
                || engine.model.trim().is_empty()
                || engine.model.len() > 200
                || engine.model.chars().any(char::is_control)
            {
                return Err("The selected bot intelligence engine is invalid.".into());
            }
        }
        ("auto", None) => {}
        _ => {
            return Err(
                "Fixed intelligence requires one engine, while Auto cannot pin an engine.".into(),
            );
        }
    }

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let (current_version, stored_spec) = transaction
        .query_row(
            "SELECT b.current_version, v.spec_json
             FROM bots b
             JOIN bot_versions v ON v.bot_id = b.id AND v.version = b.current_version
             WHERE b.id = ?1",
            params![request.id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(error_text)?
        .ok_or_else(|| "That bot is no longer available on this Mac.".to_string())?;
    let mut spec = open_json_body(
        &state.cipher,
        &bot_version_context(&request.id, current_version),
        &stored_spec,
    )?;
    let next_policy = json!({
        "mode": request.mode,
        "allowedProviders": allowed_providers,
        "fixedEngine": request.fixed_engine,
        "allowMeteredFallback": request.allow_metered_fallback,
    });
    if spec.get("enginePolicy") == Some(&next_policy) {
        drop(transaction);
        return load_bot(state, &request.id)?
            .ok_or_else(|| "The bot could not be reloaded after its intelligence changed.".into());
    }
    let next_version = current_version + 1;
    spec["enginePolicy"] = next_policy.clone();
    spec["version"] = json!(next_version);
    spec["updatedAt"] = json!(request.updated_at.clone());
    let spec_body = state.cipher.seal(
        &bot_version_context(&request.id, next_version),
        &spec.to_string(),
    )?;
    let event_id = format!("event-{}-{}", request.id, Utc::now().timestamp_micros());
    let event_body = state.cipher.seal(
        &bot_event_context(&event_id),
        &json!({
            "mode": request.mode,
            "fixedEngine": request.fixed_engine,
            "allowMeteredFallback": request.allow_metered_fallback,
            "createdAt": request.updated_at,
        })
        .to_string(),
    )?;
    transaction
        .execute(
            "INSERT INTO bot_versions (bot_id, version, spec_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![request.id, next_version, spec_body, request.updated_at],
        )
        .map_err(error_text)?;
    if transaction
        .execute(
            "UPDATE bots SET current_version = ?2, updated_at = ?3 WHERE id = ?1",
            params![request.id, next_version, request.updated_at],
        )
        .map_err(error_text)?
        == 0
    {
        return Err("That bot is no longer available on this Mac.".into());
    }
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, 'engine.changed', ?3, ?4)",
            params![event_id, request.id, event_body, request.updated_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_bot(state, &request.id)?
        .ok_or_else(|| "The bot could not be reloaded after its intelligence changed.".into())
}

pub fn update_local_bot_profile(
    state: &AppState,
    request: UpdateLocalBotProfileRequest,
) -> Result<LocalBotRecord, String> {
    validate_identifier(&request.id, "bot")?;
    let name = request.name.trim().to_string();
    validate_runtime_label(&name, 64, "bot name")?;
    if let Some(avatar) = request.avatar.as_ref() {
        validate_bot_avatar(avatar)?;
    }

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let current = transaction
        .query_row(
            "SELECT b.current_version, b.thread_id, v.spec_json, t.body_json
             FROM bots b
             JOIN bot_versions v ON v.bot_id = b.id AND v.version = b.current_version
             JOIN threads t ON t.id = b.thread_id
             WHERE b.id = ?1",
            params![request.id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(error_text)?
        .ok_or_else(|| "That bot is no longer available on this Mac.".to_string())?;
    let (current_version, thread_id, stored_spec, stored_thread) = current;
    let mut spec = open_json_body(
        &state.cipher,
        &bot_version_context(&request.id, current_version),
        &stored_spec,
    )?;
    let avatar = request
        .avatar
        .unwrap_or_else(|| bot_avatar_from_spec(&spec, &request.id));
    let next_version = current_version + 1;
    let spec_object = spec
        .as_object_mut()
        .ok_or_else(|| "The bot profile is invalid.".to_string())?;
    spec_object.insert("name".into(), json!(name));
    spec_object.insert("appearance".into(), json!({ "avatar": avatar }));
    spec_object.insert("version".into(), json!(next_version));
    spec_object.insert("updatedAt".into(), json!(request.updated_at));

    let mut thread = open_json_body(&state.cipher, &thread_context(&thread_id), &stored_thread)?;
    let thread_object = thread
        .as_object_mut()
        .ok_or_else(|| "The bot Thread profile is invalid.".to_string())?;
    thread_object.insert("title".into(), json!(name));
    thread_object.insert("updatedAt".into(), json!(request.updated_at));

    let spec_body = state.cipher.seal(
        &bot_version_context(&request.id, next_version),
        &spec.to_string(),
    )?;
    let thread_body = state
        .cipher
        .seal(&thread_context(&thread_id), &thread.to_string())?;
    let event_id = format!("event-{}-{}", request.id, Utc::now().timestamp_micros());
    let event = json!({
        "name": name,
        "avatar": bot_avatar_event(&avatar),
        "version": next_version,
        "createdAt": request.updated_at,
    });
    let event_body = state
        .cipher
        .seal(&bot_event_context(&event_id), &event.to_string())?;

    transaction
        .execute(
            "INSERT INTO bot_versions (bot_id, version, spec_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![request.id, next_version, spec_body, request.updated_at],
        )
        .map_err(error_text)?;
    let updated_bot = transaction
        .execute(
            "UPDATE bots
             SET current_version = ?2, name = ?3, updated_at = ?4
             WHERE id = ?1",
            params![request.id, next_version, name, request.updated_at],
        )
        .map_err(error_text)?;
    let updated_thread = transaction
        .execute(
            "UPDATE threads SET title = ?2, body_json = ?3, updated_at = ?4 WHERE id = ?1",
            params![thread_id, name, thread_body, request.updated_at],
        )
        .map_err(error_text)?;
    if updated_bot != 1 || updated_thread != 1 {
        return Err("The bot profile could not be updated atomically.".into());
    }
    transaction
        .execute(
            "INSERT INTO bot_events (id, bot_id, event_type, body_json, created_at)
             VALUES (?1, ?2, 'identity.changed', ?3, ?4)",
            params![event_id, request.id, event_body, request.updated_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_bot(state, &request.id)?
        .ok_or_else(|| "The bot could not be reloaded after its profile changed.".into())
}

fn load_bots(state: &AppState) -> Result<Vec<LocalBotRecord>, String> {
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT b.id, b.thread_id, b.current_version, b.name, b.status, b.latest_status,
                    v.spec_json, b.created_at, b.updated_at
             FROM bots b
             JOIN bot_versions v ON v.bot_id = b.id AND v.version = b.current_version
             ORDER BY b.updated_at DESC, b.name COLLATE NOCASE ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(error_text)?;
    let mut bots = Vec::new();
    for row in rows {
        let (
            id,
            thread_id,
            current_version,
            name,
            status,
            latest_status,
            spec,
            created_at,
            updated_at,
        ) = row.map_err(error_text)?;
        bots.push(LocalBotRecord {
            spec: open_json_body(
                &state.cipher,
                &bot_version_context(&id, current_version),
                &spec,
            )?,
            id,
            thread_id,
            current_version,
            name,
            status,
            latest_status,
            created_at,
            updated_at,
        });
    }
    Ok(bots)
}

pub(crate) fn load_bot(state: &AppState, id: &str) -> Result<Option<LocalBotRecord>, String> {
    Ok(load_bots(state)?.into_iter().find(|bot| bot.id == id))
}

pub(crate) fn bot_allows_background_routine(
    state: &AppState,
    connection: &Connection,
    bot_id: &str,
    routine_id: &str,
) -> Result<bool, String> {
    let row: Option<(i64, String)> = connection
        .query_row(
            "SELECT b.current_version, v.spec_json
             FROM bots b
             JOIN bot_versions v ON v.bot_id = b.id AND v.version = b.current_version
             WHERE b.id = ?1",
            params![bot_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(error_text)?;
    let Some((version, stored)) = row else {
        return Ok(false);
    };
    let spec = open_json_body(
        &state.cipher,
        &bot_version_context(bot_id, version),
        &stored,
    )?;
    let attached = spec
        .get("routineIds")
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(routine_id)));
    let policy = spec.get("autonomyPolicy").and_then(Value::as_object);
    Ok(attached
        && policy
            .and_then(|value| value.get("allowBackground"))
            .and_then(Value::as_bool)
            == Some(true)
        && policy
            .and_then(|value| value.get("mode"))
            .and_then(Value::as_str)
            == Some("reviewed-routines"))
}

fn bot_is_active(state: &AppState, id: &str) -> Result<bool, String> {
    state
        .connection()?
        .query_row(
            "SELECT active FROM bots WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(error_text)
}

pub fn load_mcp_servers(state: &AppState) -> Result<Vec<StoredMcpServer>, String> {
    let connection = state.connection()?;
    let mut statement = connection
        .prepare(
            "SELECT id, name, transport, enabled, fingerprint, config_json, catalog_json,
                    created_at, updated_at
             FROM local_mcp_servers ORDER BY name COLLATE NOCASE ASC, id ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(error_text)?;
    let mut servers = Vec::new();
    for row in rows {
        let (id, name, transport, enabled, fingerprint, config, catalog, created_at, updated_at) =
            row.map_err(error_text)?;
        servers.push(StoredMcpServer {
            config: open_json_body(&state.cipher, &mcp_config_context(&id), &config)?,
            catalog: open_json_body(&state.cipher, &mcp_catalog_context(&id), &catalog)?,
            id,
            name,
            transport,
            enabled,
            fingerprint,
            created_at,
            updated_at,
        });
    }
    Ok(servers)
}

pub fn load_mcp_server(state: &AppState, id: &str) -> Result<Option<StoredMcpServer>, String> {
    validate_identifier(id, "MCP server")?;
    Ok(load_mcp_servers(state)?
        .into_iter()
        .find(|server| server.id == id))
}

pub fn save_mcp_server(
    state: &AppState,
    record: SaveMcpServerRecord,
) -> Result<StoredMcpServer, String> {
    validate_identifier(&record.id, "MCP server")?;
    validate_runtime_label(&record.name, 100, "MCP server name")?;
    if !matches!(record.transport.as_str(), "stdio" | "localhost") {
        return Err("Choose stdio or localhost for this MCP server.".into());
    }
    if record.fingerprint.len() != 64
        || !record
            .fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("The inspected MCP server fingerprint is invalid.".into());
    }
    let now = canonical_now();
    let config = state
        .cipher
        .seal(&mcp_config_context(&record.id), &record.config.to_string())?;
    let catalog = state.cipher.seal(
        &mcp_catalog_context(&record.id),
        &record.catalog.to_string(),
    )?;
    let connection = state.connection()?;
    connection
        .execute(
            "INSERT INTO local_mcp_servers
                (id, name, transport, enabled, fingerprint, config_json, catalog_json,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                transport = excluded.transport,
                enabled = excluded.enabled,
                fingerprint = excluded.fingerprint,
                config_json = excluded.config_json,
                catalog_json = excluded.catalog_json,
                updated_at = excluded.updated_at",
            params![
                record.id,
                record.name,
                record.transport,
                record.enabled,
                record.fingerprint,
                config,
                catalog,
                now
            ],
        )
        .map_err(error_text)?;
    load_mcp_server(state, &record.id)?
        .ok_or_else(|| "The local MCP server could not be reloaded after saving.".into())
}

pub fn delete_mcp_server(state: &AppState, id: &str) -> Result<(), String> {
    validate_identifier(id, "MCP server")?;
    state
        .connection()?
        .execute("DELETE FROM local_mcp_servers WHERE id = ?1", params![id])
        .map_err(error_text)?;
    Ok(())
}

pub fn export_workspace_archive(state: &AppState) -> Result<Vec<u8>, String> {
    let connection = state.connection()?;
    let (bot_databases, bot_database_rows) =
        crate::bot_data::export_portable(&connection, &state.cipher)?;

    let threads = {
        let mut statement = connection
            .prepare(
                "SELECT id, owner_uid, title, status, latest_block_sequence, active_run_ref,
                        body_json, created_at, updated_at
                 FROM threads ORDER BY created_at ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (
                id,
                owner_uid,
                title,
                status,
                latest_block_sequence,
                active_run_ref,
                body,
                created_at,
                updated_at,
            ) = row.map_err(error_text)?;
            let body = open_json_body(&state.cipher, &thread_context(&id), &body)?;
            values.push(ArchiveThread {
                id,
                owner_uid,
                title,
                status,
                latest_block_sequence,
                active_run_ref,
                body,
                created_at,
                updated_at,
            });
        }
        values
    };

    let thread_blocks = {
        let mut statement = connection
            .prepare(
                "SELECT thread_id, sequence, id, kind, body_json, created_at
                 FROM thread_blocks ORDER BY thread_id ASC, sequence ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (thread_id, sequence, id, kind, body, created_at) = row.map_err(error_text)?;
            let body = open_json_body(&state.cipher, &block_context(&thread_id, sequence), &body)?;
            values.push(ArchiveThreadBlock {
                thread_id,
                sequence,
                id,
                kind,
                body,
                created_at,
            });
        }
        values
    };

    let artifacts = {
        let mut statement = connection
            .prepare(
                "SELECT id, kind, project_id, title, current_version, created_at, updated_at
                 FROM artifacts ORDER BY created_at ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok(ArchiveArtifact {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    project_id: row.get(2)?,
                    title: row.get(3)?,
                    current_version: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };

    let artifact_versions = {
        let mut statement = connection
            .prepare(
                "SELECT artifact_id, version, payload_json, created_at
                 FROM artifact_versions ORDER BY artifact_id ASC, created_at ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (artifact_id, version, payload, created_at) = row.map_err(error_text)?;
            let payload = open_json_body(
                &state.cipher,
                &artifact_context(&artifact_id, &version),
                &payload,
            )?;
            values.push(ArchiveArtifactVersion {
                artifact_id,
                version,
                payload,
                created_at,
            });
        }
        values
    };

    let runs = {
        let mut statement = connection
            .prepare(
                "SELECT id, thread_id, artifact_id, status, created_at, updated_at
                 FROM runs ORDER BY created_at ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok(ArchiveRun {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    artifact_id: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };

    let run_events = {
        let mut statement = connection
            .prepare(
                "SELECT run_id, sequence, event_type, payload_json, created_at
                 FROM run_events ORDER BY run_id ASC, sequence ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (run_id, sequence, event_type, payload, created_at) = row.map_err(error_text)?;
            let payload = open_json_body(
                &state.cipher,
                &run_event_context(&run_id, sequence),
                &payload,
            )?;
            values.push(ArchiveRunEvent {
                run_id,
                sequence,
                event_type,
                payload,
                created_at,
            });
        }
        values
    };

    let run_checkpoints = {
        let mut statement = connection
            .prepare(
                "SELECT run_id, step_index, body_json, created_at, updated_at
                 FROM run_checkpoints ORDER BY updated_at ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (run_id, step_index, body, created_at, updated_at) = row.map_err(error_text)?;
            let body = open_json_body(&state.cipher, &run_checkpoint_context(&run_id), &body)?;
            values.push(ArchiveRunCheckpoint {
                run_id,
                step_index,
                body,
                created_at,
                updated_at,
            });
        }
        values
    };

    let approvals = {
        let mut statement = connection
            .prepare(
                "SELECT id, run_id, step_index, status, body_json, created_at, updated_at
                 FROM approvals ORDER BY created_at ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (id, run_id, step_index, status, body, created_at, updated_at) =
                row.map_err(error_text)?;
            let body = open_json_body(&state.cipher, &approval_context(&id), &body)?;
            values.push(ArchiveApproval {
                id,
                run_id,
                step_index,
                status,
                body,
                created_at,
                updated_at,
            });
        }
        values
    };

    let receipts = {
        let mut statement = connection
            .prepare(
                "SELECT id, run_id, artifact_id, body_json, created_at
                 FROM receipts ORDER BY created_at ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (id, run_id, artifact_id, body, created_at) = row.map_err(error_text)?;
            let body = open_json_body(&state.cipher, &receipt_context(&id), &body)?;
            values.push(ArchiveReceipt {
                id,
                run_id,
                artifact_id,
                body,
                created_at,
            });
        }
        values
    };

    let artifact_files = {
        let mut statement = connection
            .prepare(
                "SELECT artifact_id, hash, file_name, mime_type, size, created_at
                 FROM artifact_files ORDER BY artifact_id ASC, created_at ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, u64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (artifact_id, hash, file_name, mime_type, size, created_at) =
                row.map_err(error_text)?;
            let bytes = artifact_store::read(&state.app_data_dir().join("artifacts"), &hash)?;
            if bytes.len() as u64 != size {
                return Err("An artifact file does not match its stored size.".into());
            }
            values.push(ArchiveArtifactFile {
                artifact_id,
                hash,
                file_name,
                mime_type,
                size,
                created_at,
                data_base64: BASE64_STANDARD.encode(bytes),
            });
        }
        values
    };

    let bots = {
        let mut statement = connection
            .prepare(
                "SELECT id, thread_id, current_version, name, status, latest_status,
                        created_at, updated_at
                 FROM bots ORDER BY created_at ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok(ArchiveBot {
                    id: row.get(0)?,
                    thread_id: row.get(1)?,
                    current_version: row.get(2)?,
                    name: row.get(3)?,
                    status: row.get(4)?,
                    latest_status: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };

    let bot_versions = {
        let mut statement = connection
            .prepare(
                "SELECT bot_id, version, spec_json, created_at
                 FROM bot_versions ORDER BY bot_id ASC, version ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (bot_id, version, spec, created_at) = row.map_err(error_text)?;
            values.push(ArchiveBotVersion {
                spec: open_json_body(&state.cipher, &bot_version_context(&bot_id, version), &spec)?,
                bot_id,
                version,
                created_at,
            });
        }
        values
    };

    let bot_thread_members = {
        let mut statement = connection
            .prepare(
                "SELECT bot_id, thread_id, role, created_at
                 FROM bot_thread_members ORDER BY created_at ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok(ArchiveBotThreadMember {
                    bot_id: row.get(0)?,
                    thread_id: row.get(1)?,
                    role: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };

    let memories = {
        let mut statement = connection
            .prepare(
                "SELECT id, bot_id, scope, body_json, source_run_id, expires_at, created_at, updated_at
                 FROM memories ORDER BY created_at ASC, id ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (id, bot_id, scope, body, source_run_id, expires_at, created_at, updated_at) =
                row.map_err(error_text)?;
            values.push(ArchiveMemory {
                body: open_json_body(&state.cipher, &memory_context(&id), &body)?,
                id,
                bot_id,
                scope,
                source_run_id,
                expires_at,
                created_at,
                updated_at,
            });
        }
        values
    };

    let skills = {
        let mut statement = connection
            .prepare(
                "SELECT id, current_version, name, created_at, updated_at
                 FROM skills ORDER BY created_at ASC, id ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok(ArchiveSkill {
                    id: row.get(0)?,
                    current_version: row.get(1)?,
                    name: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };

    let skill_versions = {
        let mut statement = connection
            .prepare(
                "SELECT skill_id, version, body_json, created_at
                 FROM skill_versions ORDER BY skill_id ASC, version ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (skill_id, version, body, created_at) = row.map_err(error_text)?;
            values.push(ArchiveSkillVersion {
                body: open_json_body(
                    &state.cipher,
                    &skill_version_context(&skill_id, version),
                    &body,
                )?,
                skill_id,
                version,
                created_at,
            });
        }
        values
    };

    let routines = {
        let mut statement = connection
            .prepare(
                "SELECT id, bot_id, current_version, title, trigger_kind, created_at, updated_at
                 FROM routines WHERE trigger_kind = 'project-change'
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok(ArchiveRoutine {
                    id: row.get(0)?,
                    bot_id: row.get(1)?,
                    current_version: row.get(2)?,
                    title: row.get(3)?,
                    trigger_kind: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };

    let routine_versions = {
        let mut statement = connection
            .prepare(
                "SELECT v.routine_id, v.version, v.body_json, v.created_at
                 FROM routine_versions v
                 JOIN routines r ON r.id = v.routine_id
                 WHERE r.trigger_kind = 'project-change'
                 ORDER BY v.routine_id ASC, v.version ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (routine_id, version, body, created_at) = row.map_err(error_text)?;
            values.push(ArchiveRoutineVersion {
                body: open_json_body(
                    &state.cipher,
                    &crate::event_routines::archived_event_routine_context(&routine_id, version),
                    &body,
                )?,
                routine_id,
                version,
                created_at,
            });
        }
        values
    };

    let delegations = {
        let mut statement = connection
            .prepare(
                "SELECT id, parent_bot_id, parent_thread_id, parent_bot_name,
                        parent_bot_version, status, body_json, created_at, updated_at, completed_at
                 FROM bot_delegations ORDER BY created_at ASC, id ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (
                id,
                parent_bot_id,
                parent_thread_id,
                parent_bot_name,
                parent_bot_version,
                status,
                body,
                created_at,
                updated_at,
                completed_at,
            ) = row.map_err(error_text)?;
            values.push(ArchiveDelegation {
                body: open_json_body(
                    &state.cipher,
                    &crate::delegations::delegation_context(&id),
                    &body,
                )?,
                id,
                parent_bot_id,
                parent_thread_id,
                parent_bot_name,
                parent_bot_version,
                status,
                created_at,
                updated_at,
                completed_at,
            });
        }
        values
    };

    let delegation_targets = {
        let mut statement = connection
            .prepare(
                "SELECT delegation_id, bot_id, thread_id, bot_name, bot_version, status,
                        max_actions, deadline_at, snapshot_json, run_id, result_json,
                        created_at, updated_at, completed_at
                 FROM bot_delegation_targets
                 ORDER BY delegation_id ASC, created_at ASC, bot_id ASC",
            )
            .map_err(error_text)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, Option<String>>(13)?,
                ))
            })
            .map_err(error_text)?;
        let mut values = Vec::new();
        for row in rows {
            let (
                delegation_id,
                bot_id,
                thread_id,
                bot_name,
                bot_version,
                status,
                max_actions,
                deadline_at,
                snapshot,
                run_id,
                result,
                created_at,
                updated_at,
                completed_at,
            ) = row.map_err(error_text)?;
            let snapshot = open_json_body(
                &state.cipher,
                &crate::delegations::delegation_target_snapshot_context(&delegation_id, &bot_id),
                &snapshot,
            )?;
            let result = result
                .map(|value| {
                    open_json_body(
                        &state.cipher,
                        &crate::delegations::delegation_target_result_context(
                            &delegation_id,
                            &bot_id,
                        ),
                        &value,
                    )
                })
                .transpose()?;
            values.push(ArchiveDelegationTarget {
                delegation_id,
                bot_id,
                thread_id,
                bot_name,
                bot_version,
                status,
                max_actions,
                deadline_at,
                snapshot,
                run_id,
                result,
                created_at,
                updated_at,
                completed_at,
            });
        }
        values
    };

    let bytes = serde_json::to_vec_pretty(&WorkspaceArchive {
        manifest: ArchiveManifest {
            format: ARCHIVE_FORMAT.into(),
            version: ARCHIVE_VERSION,
            exported_at: canonical_now(),
            contains_credentials: false,
        },
        threads,
        thread_blocks,
        artifacts,
        artifact_versions,
        runs,
        run_events,
        run_checkpoints,
        approvals,
        receipts,
        artifact_files,
        bots,
        bot_versions,
        bot_thread_members,
        bot_databases,
        bot_database_rows,
        memories,
        skills,
        skill_versions,
        routines,
        routine_versions,
        delegations,
        delegation_targets,
    })
    .map_err(error_text)?;
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("This workspace is larger than the 64 MB portable backup limit.".into());
    }
    Ok(bytes)
}

pub fn restore_workspace_archive(
    state: &AppState,
    bytes: &[u8],
    confirm_replace: bool,
) -> Result<WorkspaceSnapshot, String> {
    if !confirm_replace {
        return Err("Confirm that this backup should replace the current local workspace.".into());
    }
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("The selected backup is empty or larger than the 64 MB local limit.".into());
    }
    let archive: WorkspaceArchive = serde_json::from_slice(bytes)
        .map_err(|_| "The selected file is not a valid Codelit workspace backup.".to_string())?;
    validate_archive(&archive)?;
    let routine_ids_by_bot = archive.routines.iter().fold(
        HashMap::<String, HashSet<String>>::new(),
        |mut values, routine| {
            values
                .entry(routine.bot_id.clone())
                .or_default()
                .insert(routine.id.clone());
            values
        },
    );
    let restored_at = canonical_now();

    let mut restored_files = Vec::new();
    for row in &archive.artifact_files {
        let bytes = BASE64_STANDARD
            .decode(&row.data_base64)
            .map_err(|_| "An artifact file in the backup is not valid base64.".to_string())?;
        let stored = artifact_store::store(&state.app_data_dir().join("artifacts"), &bytes)?;
        if stored.hash != row.hash || stored.size != row.size {
            return Err("An artifact file in the backup failed its content hash check.".into());
        }
        restored_files.push((
            row.artifact_id.clone(),
            row.hash.clone(),
            row.file_name.clone(),
            row.mime_type.clone(),
            row.size,
            stored.relative_path,
            row.created_at.clone(),
        ));
    }

    let mut connection = state.connection()?;
    let transaction = connection.transaction().map_err(error_text)?;
    transaction
        .execute_batch(
            "DELETE FROM bot_delegation_targets;
             DELETE FROM bot_delegations;
             DELETE FROM bot_events;
             DELETE FROM memory_proposals;
             DELETE FROM memories;
             DELETE FROM routine_versions;
             DELETE FROM routines;
             DELETE FROM skill_versions;
             DELETE FROM skills;
             DELETE FROM bot_databases;
             DELETE FROM bot_thread_members;
             DELETE FROM bot_versions;
             DELETE FROM bots;
             DELETE FROM receipts;
             DELETE FROM approvals;
             DELETE FROM run_checkpoints;
             DELETE FROM run_events;
             DELETE FROM runs;
             DELETE FROM artifact_files;
             DELETE FROM artifact_versions;
             DELETE FROM thread_blocks;
             DELETE FROM artifacts;
             DELETE FROM threads;",
        )
        .map_err(error_text)?;

    for row in archive.threads {
        let body = state
            .cipher
            .seal(&thread_context(&row.id), &row.body.to_string())?;
        transaction
            .execute(
                "INSERT INTO threads
                    (id, owner_uid, title, status, latest_block_sequence, active_run_ref,
                     body_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    row.id,
                    row.owner_uid,
                    row.title,
                    row.status,
                    row.latest_block_sequence,
                    row.active_run_ref,
                    body,
                    row.created_at,
                    row.updated_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.artifacts {
        transaction
            .execute(
                "INSERT INTO artifacts
                    (id, kind, project_id, title, current_version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    row.id,
                    row.kind,
                    row.project_id,
                    row.title,
                    row.current_version,
                    row.created_at,
                    row.updated_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.artifact_versions {
        let payload = state.cipher.seal(
            &artifact_context(&row.artifact_id, &row.version),
            &row.payload.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO artifact_versions (artifact_id, version, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![row.artifact_id, row.version, payload, row.created_at],
            )
            .map_err(error_text)?;
    }
    for (artifact_id, hash, file_name, mime_type, size, relative_path, created_at) in restored_files
    {
        transaction
            .execute(
                "INSERT INTO artifact_files
                    (artifact_id, hash, file_name, mime_type, size, relative_path, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    artifact_id,
                    hash,
                    file_name,
                    mime_type,
                    size,
                    relative_path,
                    created_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.thread_blocks {
        let body = state.cipher.seal(
            &block_context(&row.thread_id, row.sequence),
            &row.body.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO thread_blocks (thread_id, sequence, id, kind, body_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    row.thread_id,
                    row.sequence,
                    row.id,
                    row.kind,
                    body,
                    row.created_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.runs {
        transaction
            .execute(
                "INSERT INTO runs (id, thread_id, artifact_id, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    row.id,
                    row.thread_id,
                    row.artifact_id,
                    row.status,
                    row.created_at,
                    row.updated_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.run_events {
        let payload = state.cipher.seal(
            &run_event_context(&row.run_id, row.sequence),
            &row.payload.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    row.run_id,
                    row.sequence,
                    row.event_type,
                    payload,
                    row.created_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.run_checkpoints {
        let body = state
            .cipher
            .seal(&run_checkpoint_context(&row.run_id), &row.body.to_string())?;
        transaction
            .execute(
                "INSERT INTO run_checkpoints
                    (run_id, step_index, body_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    row.run_id,
                    row.step_index,
                    body,
                    row.created_at,
                    row.updated_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.approvals {
        let body = state
            .cipher
            .seal(&approval_context(&row.id), &row.body.to_string())?;
        transaction
            .execute(
                "INSERT INTO approvals
                    (id, run_id, step_index, status, body_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    row.id,
                    row.run_id,
                    row.step_index,
                    row.status,
                    body,
                    row.created_at,
                    row.updated_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.receipts {
        let body = state
            .cipher
            .seal(&receipt_context(&row.id), &row.body.to_string())?;
        transaction
            .execute(
                "INSERT INTO receipts (id, run_id, artifact_id, body_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![row.id, row.run_id, row.artifact_id, body, row.created_at],
            )
            .map_err(error_text)?;
    }
    for row in archive.bots {
        transaction
            .execute(
                "INSERT INTO bots
                    (id, thread_id, current_version, name, status, latest_status, active,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
                params![
                    row.id,
                    row.thread_id,
                    row.current_version,
                    row.name,
                    row.status,
                    row.latest_status,
                    row.created_at,
                    row.updated_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.bot_versions {
        let mut restored_spec = row.spec;
        let allowed_routines = routine_ids_by_bot.get(&row.bot_id);
        if let Some(routine_ids) = restored_spec
            .get_mut("routineIds")
            .and_then(Value::as_array_mut)
        {
            routine_ids.retain(|value| {
                value
                    .as_str()
                    .is_some_and(|id| allowed_routines.is_some_and(|allowed| allowed.contains(id)))
            });
        }
        if let Some(policy) = restored_spec
            .get_mut("autonomyPolicy")
            .and_then(Value::as_object_mut)
        {
            policy.insert("mode".into(), json!("manual"));
            policy.insert("allowBackground".into(), json!(false));
        }
        let spec = state.cipher.seal(
            &bot_version_context(&row.bot_id, row.version),
            &restored_spec.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO bot_versions (bot_id, version, spec_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![row.bot_id, row.version, spec, row.created_at],
            )
            .map_err(error_text)?;
    }
    crate::bot_data::restore_portable(
        &transaction,
        &state.cipher,
        &archive.bot_databases,
        &archive.bot_database_rows,
    )?;
    for row in archive.bot_thread_members {
        transaction
            .execute(
                "INSERT INTO bot_thread_members (bot_id, thread_id, role, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![row.bot_id, row.thread_id, row.role, row.created_at],
            )
            .map_err(error_text)?;
    }
    for row in archive.delegations {
        let restored_status = if matches!(
            row.status.as_str(),
            "queued" | "running" | "awaiting-approval"
        ) {
            "canceled"
        } else {
            row.status.as_str()
        };
        let restored_updated_at = if restored_status == row.status {
            row.updated_at.as_str()
        } else {
            restored_at.as_str()
        };
        let restored_completed_at = if restored_status == row.status {
            row.completed_at.as_deref()
        } else {
            Some(restored_at.as_str())
        };
        let body = state.cipher.seal(
            &crate::delegations::delegation_context(&row.id),
            &row.body.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO bot_delegations
                    (id, parent_bot_id, parent_thread_id, parent_bot_name, parent_bot_version,
                     status, body_json, created_at, updated_at, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    row.id,
                    row.parent_bot_id,
                    row.parent_thread_id,
                    row.parent_bot_name,
                    row.parent_bot_version,
                    restored_status,
                    body,
                    row.created_at,
                    restored_updated_at,
                    restored_completed_at,
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.delegation_targets {
        let restored_status = if matches!(
            row.status.as_str(),
            "queued" | "running" | "awaiting-approval"
        ) {
            "canceled"
        } else {
            row.status.as_str()
        };
        let interrupted = restored_status != row.status;
        let restored_result = if interrupted {
            Some(json!({
                "schemaVersion": 1,
                "result": null,
                "detail": "This unfinished handoff was canceled when the portable backup was restored."
            }))
        } else {
            row.result
        };
        let snapshot = state.cipher.seal(
            &crate::delegations::delegation_target_snapshot_context(
                &row.delegation_id,
                &row.bot_id,
            ),
            &row.snapshot.to_string(),
        )?;
        let result = restored_result
            .map(|value| {
                state.cipher.seal(
                    &crate::delegations::delegation_target_result_context(
                        &row.delegation_id,
                        &row.bot_id,
                    ),
                    &value.to_string(),
                )
            })
            .transpose()?;
        transaction
            .execute(
                "INSERT INTO bot_delegation_targets
                    (delegation_id, bot_id, thread_id, bot_name, bot_version, status,
                     max_actions, deadline_at, snapshot_json, run_id, result_json,
                     created_at, updated_at, completed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    row.delegation_id,
                    row.bot_id,
                    row.thread_id,
                    row.bot_name,
                    row.bot_version,
                    restored_status,
                    row.max_actions,
                    row.deadline_at,
                    snapshot,
                    if interrupted { None } else { row.run_id },
                    result,
                    row.created_at,
                    if interrupted {
                        restored_at.as_str()
                    } else {
                        row.updated_at.as_str()
                    },
                    if interrupted {
                        Some(restored_at.as_str())
                    } else {
                        row.completed_at.as_deref()
                    },
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.routines {
        transaction
            .execute(
                "INSERT INTO routines
                    (id, bot_id, current_version, title, enabled, created_at, updated_at,
                     trigger_kind, paused_reason)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8)",
                params![
                    row.id,
                    row.bot_id,
                    row.current_version,
                    row.title,
                    row.created_at,
                    row.updated_at,
                    row.trigger_kind,
                    "Choose a project and start this routine again."
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.routine_versions {
        let body = state.cipher.seal(
            &crate::event_routines::archived_event_routine_context(&row.routine_id, row.version),
            &row.body.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO routine_versions (routine_id, version, body_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![row.routine_id, row.version, body, row.created_at],
            )
            .map_err(error_text)?;
    }
    for row in archive.skills {
        transaction
            .execute(
                "INSERT INTO skills (id, current_version, name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    row.id,
                    row.current_version,
                    row.name,
                    row.created_at,
                    row.updated_at
                ],
            )
            .map_err(error_text)?;
    }
    for row in archive.skill_versions {
        let body = state.cipher.seal(
            &skill_version_context(&row.skill_id, row.version),
            &row.body.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO skill_versions (skill_id, version, body_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![row.skill_id, row.version, body, row.created_at],
            )
            .map_err(error_text)?;
    }
    for row in archive.memories {
        let body = state
            .cipher
            .seal(&memory_context(&row.id), &row.body.to_string())?;
        transaction
            .execute(
                "INSERT INTO memories
                    (id, bot_id, scope, body_json, source_run_id, expires_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    row.id,
                    row.bot_id,
                    row.scope,
                    body,
                    row.source_run_id,
                    row.expires_at,
                    row.created_at,
                    row.updated_at
                ],
            )
            .map_err(error_text)?;
    }
    transaction
        .execute(
            "UPDATE bots SET active = 1 WHERE id = (SELECT id FROM bots ORDER BY updated_at DESC LIMIT 1)",
            [],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    let mut connection = state.connection()?;
    seed_bots(&mut connection, &state.cipher)?;
    seed_builtin_skills(&mut connection, &state.cipher)?;
    upgrade_bot_capabilities(&mut connection, &state.cipher)?;
    drop(connection);
    let retained_hashes = archive
        .artifact_files
        .iter()
        .map(|row| row.hash.clone())
        .collect::<HashSet<_>>();
    artifact_store::prune_except(&state.app_data_dir().join("artifacts"), &retained_hashes)?;
    crate::browser_downloads::remove_quarantine_root(state)?;
    bootstrap_local_workspace(state)
}

pub fn delete_local_data(state: &AppState) -> Result<WorkspaceSnapshot, String> {
    remove_local_data_files(state)?;
    let key = crate::macos::replace_data_key()?;
    initialize_empty_workspace(state, key)
}

fn remove_local_data_files(state: &AppState) -> Result<(), String> {
    for path in [
        state.database_path.clone(),
        PathBuf::from(format!("{}-wal", state.database_path.display())),
        PathBuf::from(format!("{}-shm", state.database_path.display())),
    ] {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
        }
    }
    for directory in [
        "artifacts",
        "browser",
        "browser-quarantine",
        "models",
        "runtime",
    ] {
        let path = state.app_data_dir().join(directory);
        if path.exists() {
            fs::remove_dir_all(&path)
                .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
        }
    }
    Ok(())
}

fn initialize_empty_workspace(
    state: &AppState,
    key: [u8; 32],
) -> Result<WorkspaceSnapshot, String> {
    state.cipher.replace_key(key)?;
    let mut connection = state.connection()?;
    seed_workspace(&mut connection, &state.cipher)?;
    seed_bots(&mut connection, &state.cipher)?;
    seed_builtin_skills(&mut connection, &state.cipher)?;
    drop(connection);
    bootstrap_local_workspace(state)
}

fn validate_archive(archive: &WorkspaceArchive) -> Result<(), String> {
    if archive.manifest.format != ARCHIVE_FORMAT
        || !(1..=ARCHIVE_VERSION).contains(&archive.manifest.version)
        || archive.manifest.contains_credentials
    {
        return Err("This Codelit backup format is unsupported or unsafe to import.".into());
    }
    let row_count = archive.threads.len()
        + archive.thread_blocks.len()
        + archive.artifacts.len()
        + archive.artifact_versions.len()
        + archive.runs.len()
        + archive.run_events.len()
        + archive.run_checkpoints.len()
        + archive.approvals.len()
        + archive.receipts.len()
        + archive.artifact_files.len()
        + archive.bots.len()
        + archive.bot_versions.len()
        + archive.bot_thread_members.len()
        + archive.bot_databases.len()
        + archive.bot_database_rows.len()
        + archive.memories.len()
        + archive.skills.len()
        + archive.skill_versions.len()
        + archive.routines.len()
        + archive.routine_versions.len()
        + archive.delegations.len()
        + archive.delegation_targets.len();
    if archive.threads.is_empty() || row_count > MAX_ARCHIVE_ROWS {
        return Err("The Codelit backup has no Threads or contains too many records.".into());
    }

    let mut thread_ids = HashSet::new();
    for row in &archive.threads {
        validate_identifier(&row.id, "thread")?;
        if !thread_ids.insert(row.id.as_str()) {
            return Err("The Codelit backup contains duplicate Threads.".into());
        }
        if row.body.get("id").and_then(Value::as_str) != Some(row.id.as_str()) {
            return Err("A Thread body does not match its backup identity.".into());
        }
    }

    let mut artifact_ids = HashSet::new();
    for row in &archive.artifacts {
        validate_identifier(&row.id, "artifact")?;
        validate_identifier(&row.current_version, "version")?;
        if !ARTIFACT_KINDS.contains(&row.kind.as_str()) || !artifact_ids.insert(row.id.as_str()) {
            return Err("The Codelit backup contains an invalid or duplicate artifact.".into());
        }
    }
    let versions = archive
        .artifact_versions
        .iter()
        .map(|row| (row.artifact_id.as_str(), row.version.as_str()))
        .collect::<HashSet<_>>();
    for row in &archive.artifacts {
        if !versions.contains(&(row.id.as_str(), row.current_version.as_str())) {
            return Err("An artifact's current version is missing from the backup.".into());
        }
    }
    for row in &archive.artifact_versions {
        validate_identifier(&row.artifact_id, "artifact")?;
        validate_identifier(&row.version, "version")?;
        if !artifact_ids.contains(row.artifact_id.as_str()) {
            return Err("An artifact version references a missing artifact.".into());
        }
    }
    for row in &archive.thread_blocks {
        validate_identifier(&row.id, "block")?;
        if row.sequence < 1 || !thread_ids.contains(row.thread_id.as_str()) {
            return Err("A Thread block has an invalid sequence or missing Thread.".into());
        }
    }
    let mut bot_ids = HashSet::new();
    for row in &archive.bots {
        validate_identifier(&row.id, "bot")?;
        if row.current_version < 1
            || !thread_ids.contains(row.thread_id.as_str())
            || !bot_status_is_valid(&row.status)
            || !bot_ids.insert(row.id.as_str())
        {
            return Err("A bot is invalid, duplicated, or references a missing Thread.".into());
        }
    }
    let bot_versions = archive
        .bot_versions
        .iter()
        .map(|row| (row.bot_id.as_str(), row.version))
        .collect::<HashSet<_>>();
    for row in &archive.bots {
        if !bot_versions.contains(&(row.id.as_str(), row.current_version)) {
            return Err("A bot's current version is missing from the backup.".into());
        }
    }
    for row in &archive.bot_versions {
        if row.version < 1
            || !bot_ids.contains(row.bot_id.as_str())
            || row.spec.get("botId").and_then(Value::as_str) != Some(row.bot_id.as_str())
            || row.spec.get("version").and_then(Value::as_i64) != Some(row.version)
        {
            return Err("A bot version is invalid or references a missing bot.".into());
        }
        validate_bot_spec_appearance(&row.spec)?;
        validate_bot_spec_browser_domains(&row.spec)?;
    }
    for row in &archive.bot_thread_members {
        if !bot_ids.contains(row.bot_id.as_str())
            || !thread_ids.contains(row.thread_id.as_str())
            || !matches!(row.role.as_str(), "owner" | "member" | "delegate")
        {
            return Err("A bot Thread membership is invalid.".into());
        }
    }
    crate::bot_data::validate_portable(
        &archive.bot_databases,
        &archive.bot_database_rows,
        &bot_ids,
    )?;
    let run_ids = archive
        .runs
        .iter()
        .map(|row| row.id.as_str())
        .collect::<HashSet<_>>();
    for row in &archive.runs {
        validate_identifier(&row.id, "run")?;
        if !thread_ids.contains(row.thread_id.as_str())
            || !artifact_ids.contains(row.artifact_id.as_str())
        {
            return Err("A run references a missing Thread or artifact.".into());
        }
    }
    let mut memory_ids = HashSet::new();
    for row in &archive.memories {
        validate_identifier(&row.id, "memory")?;
        let owner_is_valid = match row.scope.as_str() {
            "bot" => row
                .bot_id
                .as_deref()
                .is_some_and(|bot_id| bot_ids.contains(bot_id)),
            "workspace" => row.bot_id.is_none(),
            _ => false,
        };
        if !owner_is_valid
            || !memory_ids.insert(row.id.as_str())
            || row
                .source_run_id
                .as_deref()
                .is_some_and(|run_id| !run_ids.contains(run_id))
        {
            return Err("A memory is invalid, duplicated, or references unavailable work.".into());
        }
        validate_memory_body(&row.body)?;
        canonical_memory_time(&row.created_at, "archive creation time")?;
        canonical_memory_time(&row.updated_at, "archive update time")?;
        if let Some(expires_at) = row.expires_at.as_deref() {
            canonical_memory_time(expires_at, "archive expiry time")?;
        }
    }
    if archive.skills.len() > MAX_WORKSPACE_SKILLS as usize {
        return Err("The Codelit backup contains too many reusable skills.".into());
    }
    let mut skill_ids = HashSet::new();
    let mut skill_names = HashSet::new();
    let mut skill_name_by_id = HashMap::new();
    for row in &archive.skills {
        validate_identifier(&row.id, "skill")?;
        validate_runtime_label(&row.name, 64, "skill name")?;
        canonical_skill_time(&row.created_at, "archive creation time")?;
        canonical_skill_time(&row.updated_at, "archive update time")?;
        if row.current_version < 1
            || !skill_ids.insert(row.id.as_str())
            || !skill_names.insert(row.name.trim().to_lowercase())
        {
            return Err("A reusable skill is invalid or duplicated in the backup.".into());
        }
        skill_name_by_id.insert(row.id.as_str(), row.name.as_str());
    }
    let mut archived_skill_versions = HashSet::new();
    for row in &archive.skill_versions {
        let Some(name) = skill_name_by_id.get(row.skill_id.as_str()) else {
            return Err("A reusable skill version references a missing skill.".into());
        };
        if row.version < 1 || !archived_skill_versions.insert((row.skill_id.as_str(), row.version))
        {
            return Err("A reusable skill version is invalid or duplicated.".into());
        }
        canonical_skill_time(&row.created_at, "archive version time")?;
        validate_skill_body(name, &row.body)?;
    }
    for row in &archive.skills {
        if !archived_skill_versions.contains(&(row.id.as_str(), row.current_version)) {
            return Err("A reusable skill's current version is missing from the backup.".into());
        }
    }
    if archive.routines.len() > 32 {
        return Err("The Codelit backup contains too many project-change routines.".into());
    }
    let mut routine_ids = HashSet::new();
    let mut routine_bot_ids = HashMap::new();
    for row in &archive.routines {
        validate_identifier(&row.id, "event routine")?;
        validate_runtime_label(&row.title, 100, "routine title")?;
        canonical_skill_time(&row.created_at, "archive creation time")?;
        canonical_skill_time(&row.updated_at, "archive update time")?;
        if row.current_version < 1
            || row.trigger_kind != "project-change"
            || !bot_ids.contains(row.bot_id.as_str())
            || !routine_ids.insert(row.id.as_str())
        {
            return Err(
                "A project-change routine is invalid, duplicated, or references a missing bot."
                    .into(),
            );
        }
        routine_bot_ids.insert(row.id.as_str(), row.bot_id.as_str());
    }
    let mut archived_routine_versions = HashSet::new();
    for row in &archive.routine_versions {
        let Some(bot_id) = routine_bot_ids.get(row.routine_id.as_str()) else {
            return Err("A project-change routine version references a missing routine.".into());
        };
        if row.version < 1
            || !archived_routine_versions.insert((row.routine_id.as_str(), row.version))
        {
            return Err("A project-change routine version is invalid or duplicated.".into());
        }
        canonical_skill_time(&row.created_at, "archive version time")?;
        crate::event_routines::validate_archived_event_routine_body(bot_id, &row.body)?;
        if let Some(skill_versions) = row.body.get("skillVersions").and_then(Value::as_object) {
            for (skill_id, version) in skill_versions {
                let version = version.as_i64().ok_or_else(|| {
                    "A project-change routine has an invalid pinned skill version.".to_string()
                })?;
                if !archived_skill_versions.contains(&(skill_id.as_str(), version)) {
                    return Err(
                        "A project-change routine references a missing reusable skill version."
                            .into(),
                    );
                }
            }
        }
    }
    for row in &archive.routines {
        if !archived_routine_versions.contains(&(row.id.as_str(), row.current_version)) {
            return Err(
                "A project-change routine's current version is missing from the backup.".into(),
            );
        }
    }
    if archive.delegations.len() > 500 {
        return Err("The Codelit backup contains too many bot handoffs.".into());
    }
    let delegation_status_is_valid = |status: &str| {
        matches!(
            status,
            "queued" | "running" | "awaiting-approval" | "completed" | "failed" | "canceled"
        )
    };
    let mut delegation_ids = HashSet::new();
    let mut delegation_parents = HashMap::new();
    for row in &archive.delegations {
        validate_identifier(&row.id, "bot handoff")?;
        canonical_skill_time(&row.created_at, "handoff creation time")?;
        canonical_skill_time(&row.updated_at, "handoff update time")?;
        if let Some(completed_at) = row.completed_at.as_deref() {
            canonical_skill_time(completed_at, "handoff completion time")?;
        }
        let parent = archive.bots.iter().find(|bot| bot.id == row.parent_bot_id);
        if row.parent_bot_version < 1
            || parent.is_none_or(|bot| bot.thread_id != row.parent_thread_id)
            || !bot_versions.contains(&(row.parent_bot_id.as_str(), row.parent_bot_version))
            || !delegation_status_is_valid(&row.status)
            || !delegation_ids.insert(row.id.as_str())
        {
            return Err(
                "A bot handoff is invalid, duplicated, or references unavailable work.".into(),
            );
        }
        crate::delegations::validate_archived_delegation_body(&row.body)?;
        delegation_parents.insert(row.id.as_str(), row.parent_bot_id.as_str());
    }
    let memberships = archive
        .bot_thread_members
        .iter()
        .map(|row| {
            (
                row.bot_id.as_str(),
                row.thread_id.as_str(),
                row.role.as_str(),
            )
        })
        .collect::<HashSet<_>>();
    let mut delegation_targets = HashSet::new();
    let mut target_counts = HashMap::<&str, usize>::new();
    for row in &archive.delegation_targets {
        let Some(parent_bot_id) = delegation_parents.get(row.delegation_id.as_str()) else {
            return Err("A specialist handoff references a missing parent handoff.".into());
        };
        let target = archive.bots.iter().find(|bot| bot.id == row.bot_id);
        canonical_skill_time(&row.created_at, "specialist handoff creation time")?;
        canonical_skill_time(&row.updated_at, "specialist handoff update time")?;
        canonical_skill_time(&row.deadline_at, "specialist handoff deadline")?;
        if let Some(completed_at) = row.completed_at.as_deref() {
            canonical_skill_time(completed_at, "specialist handoff completion time")?;
        }
        if row.bot_id == *parent_bot_id
            || target.is_none_or(|bot| bot.thread_id != row.thread_id)
            || !bot_versions.contains(&(row.bot_id.as_str(), row.bot_version))
            || !delegation_status_is_valid(&row.status)
            || !(1..=8).contains(&row.max_actions)
            || !delegation_targets.insert((row.delegation_id.as_str(), row.bot_id.as_str()))
        {
            return Err(
                "A specialist handoff is invalid, duplicated, or references unavailable work."
                    .into(),
            );
        }
        let parent_thread_id = archive
            .delegations
            .iter()
            .find(|delegation| delegation.id == row.delegation_id)
            .map(|delegation| delegation.parent_thread_id.as_str())
            .ok_or_else(|| "A specialist handoff is missing its parent Thread.".to_string())?;
        if !memberships.contains(&(row.bot_id.as_str(), parent_thread_id, "delegate"))
            && !memberships.contains(&(row.bot_id.as_str(), parent_thread_id, "member"))
        {
            return Err("A specialist handoff is missing its reviewed Thread membership.".into());
        }
        crate::delegations::validate_archived_delegation_target_snapshot(
            &row.snapshot,
            &row.bot_id,
            row.bot_version,
        )?;
        if let Some(result) = row.result.as_ref() {
            crate::delegations::validate_archived_delegation_target_result(result)?;
        }
        *target_counts.entry(row.delegation_id.as_str()).or_default() += 1;
    }
    for row in &archive.delegations {
        let count = target_counts
            .get(row.id.as_str())
            .copied()
            .unwrap_or_default();
        let body_targets = row
            .body
            .get("targetBotIds")
            .and_then(Value::as_array)
            .ok_or_else(|| "A bot handoff target list is invalid.".to_string())?;
        if !(1..=2).contains(&count)
            || body_targets.len() != count
            || !body_targets.iter().all(|target| {
                target
                    .as_str()
                    .is_some_and(|bot_id| delegation_targets.contains(&(row.id.as_str(), bot_id)))
            })
        {
            return Err("A bot handoff target list is incomplete or inconsistent.".into());
        }
    }
    for row in &archive.run_events {
        if row.sequence < 1 || !run_ids.contains(row.run_id.as_str()) {
            return Err("A run event has an invalid sequence or missing run.".into());
        }
    }
    for row in &archive.run_checkpoints {
        if row.step_index < 0 || !run_ids.contains(row.run_id.as_str()) {
            return Err("A run checkpoint has an invalid step or missing run.".into());
        }
    }
    let mut approval_ids = HashSet::new();
    for row in &archive.approvals {
        validate_identifier(&row.id, "approval")?;
        if row.step_index < 0
            || !run_ids.contains(row.run_id.as_str())
            || !approval_status_is_valid(&row.status)
            || !approval_ids.insert(row.id.as_str())
        {
            return Err("An approval is invalid, duplicated, or references a missing run.".into());
        }
    }
    for row in &archive.receipts {
        validate_identifier(&row.id, "receipt")?;
        if !run_ids.contains(row.run_id.as_str())
            || !artifact_ids.contains(row.artifact_id.as_str())
        {
            return Err("A receipt references a missing run or artifact.".into());
        }
    }
    let mut file_ids = HashSet::new();
    for row in &archive.artifact_files {
        artifact_store::validate_hash(&row.hash)?;
        validate_artifact_file_name(&row.file_name)?;
        if !artifact_ids.contains(row.artifact_id.as_str())
            || row.size == 0
            || row.size > artifact_store::MAX_ARTIFACT_FILE_BYTES as u64
            || row.mime_type.is_empty()
            || row.mime_type.len() > 120
            || !file_ids.insert((row.artifact_id.as_str(), row.hash.as_str()))
        {
            return Err("The backup contains an invalid or duplicate artifact file.".into());
        }
    }
    Ok(())
}

pub fn save_workspace_folder(
    state: &AppState,
    path: &str,
    bookmark: &[u8],
    stale: bool,
    access_validated: bool,
) -> Result<WorkspaceSnapshot, String> {
    if path.trim().is_empty() || bookmark.is_empty() {
        return Err("A selected folder and its macOS permission are required.".into());
    }
    let connection = state.connection()?;
    let updated_at = canonical_now();
    connection
        .execute(
            "INSERT INTO workspace_bookmarks
                (id, path, bookmark, read_only, stale, access_validated, created_at, updated_at)
             VALUES ('primary', ?1, ?2, 1, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
                path = excluded.path,
                bookmark = excluded.bookmark,
                read_only = 1,
                stale = excluded.stale,
                access_validated = excluded.access_validated,
                updated_at = excluded.updated_at",
            params![path, bookmark, stale, access_validated, updated_at],
        )
        .map_err(error_text)?;
    bootstrap_local_workspace(state)
}

pub fn store_artifact_file(
    state: &AppState,
    request: StoreArtifactFileRequest,
) -> Result<WorkspaceSnapshot, String> {
    validate_identifier(&request.artifact_id, "artifact")?;
    validate_artifact_file_name(&request.file_name)?;
    if request.mime_type.is_empty()
        || request.mime_type.len() > 120
        || !request
            .mime_type
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
    {
        return Err("Artifact file type is invalid.".into());
    }
    if request.data_base64.len() > artifact_store::MAX_ARTIFACT_FILE_BYTES * 2 {
        return Err("Artifact file is larger than the 32 MB local limit.".into());
    }
    let bytes = BASE64_STANDARD
        .decode(&request.data_base64)
        .map_err(|_| "Artifact file data is not valid base64.".to_string())?;
    let connection = state.connection()?;
    let artifact_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE id = ?1)",
            params![request.artifact_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if !artifact_exists {
        return Err("The artifact does not exist in this local workspace.".into());
    }
    let stored = artifact_store::store(&state.app_data_dir().join("artifacts"), &bytes)?;
    connection
        .execute(
            "INSERT INTO artifact_files
                (artifact_id, hash, file_name, mime_type, size, relative_path, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(artifact_id, hash) DO UPDATE SET
                file_name = excluded.file_name,
                mime_type = excluded.mime_type",
            params![
                request.artifact_id,
                stored.hash,
                request.file_name,
                request.mime_type,
                stored.size,
                stored.relative_path,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    bootstrap_local_workspace(state)
}

pub fn load_workspace_bookmark(
    state: &AppState,
) -> Result<Option<StoredWorkspaceBookmark>, String> {
    let connection = state.connection()?;
    connection
        .query_row(
            "SELECT path, bookmark FROM workspace_bookmarks WHERE id = 'primary'",
            [],
            |row| {
                Ok(StoredWorkspaceBookmark {
                    path: row.get(0)?,
                    bookmark: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(error_text)
}

pub fn mark_workspace_folder_unavailable(state: &AppState) -> Result<(), String> {
    let connection = state.connection()?;
    connection
        .execute(
            "UPDATE workspace_bookmarks
             SET access_validated = 0, updated_at = ?1
             WHERE id = 'primary'",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

pub fn append_thread_message(
    state: &AppState,
    request: AppendMessageRequest,
) -> Result<WorkspaceSnapshot, String> {
    let text = request.text.trim();
    if text.is_empty() || text.len() > 12_000 {
        return Err("Message must contain between 1 and 12,000 characters.".into());
    }
    validate_identifier(&request.thread_id, "thread")?;
    validate_identifier(&request.id, "message")?;
    let kind = match request.role.as_str() {
        "user" => "user-message",
        "assistant" => "assistant-message",
        _ => return Err("A Thread message role must be user or assistant.".into()),
    };

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let (thread_json, current_sequence): (String, i64) = transaction
        .query_row(
            "SELECT body_json, latest_block_sequence FROM threads WHERE id = ?1",
            params![request.thread_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(error_text)?;

    if request.sequence != current_sequence + 1 {
        return Err(format!(
            "Thread changed before this message was saved. Expected sequence {}, received {}.",
            current_sequence + 1,
            request.sequence
        ));
    }

    let block = json!({
        "id": request.id,
        "sequence": request.sequence,
        "createdAt": request.created_at,
        "type": kind,
        "text": text,
    });
    let block_body = state.cipher.seal(
        &block_context(&request.thread_id, request.sequence),
        &block.to_string(),
    )?;
    transaction
        .execute(
            "INSERT INTO thread_blocks (thread_id, sequence, id, kind, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                request.thread_id,
                request.sequence,
                request.id,
                kind,
                block_body,
                request.created_at
            ],
        )
        .map_err(error_text)?;

    let mut thread = open_json_body(
        &state.cipher,
        &thread_context(&request.thread_id),
        &thread_json,
    )?;
    thread["latestBlockSequence"] = json!(request.sequence);
    thread["status"] = json!("idle");
    thread["updatedAt"] = json!(request.created_at);
    let thread_body = state
        .cipher
        .seal(&thread_context(&request.thread_id), &thread.to_string())?;
    transaction
        .execute(
            "UPDATE threads
             SET body_json = ?2, status = 'idle', latest_block_sequence = ?3, updated_at = ?4
             WHERE id = ?1",
            params![
                request.thread_id,
                thread_body,
                request.sequence,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_snapshot_for_thread(state, &request.thread_id)
}

pub fn save_artifact_version(
    state: &AppState,
    request: SaveArtifactRequest,
) -> Result<WorkspaceSnapshot, String> {
    validate_identifier(&request.thread_id, "thread")?;
    validate_identifier(&request.artifact_id, "artifact")?;
    validate_identifier(&request.version, "version")?;
    if !ARTIFACT_KINDS.contains(&request.kind.as_str()) {
        return Err("Unknown artifact kind.".into());
    }
    if request.title.trim().is_empty() || request.title.len() > 180 {
        return Err("Artifact title must contain between 1 and 180 characters.".into());
    }

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM artifacts WHERE id = ?1 AND kind = ?2 AND project_id = ?3
             )",
            params![request.artifact_id, request.kind, request.project_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if !exists {
        return Err("The artifact does not exist in this local workspace.".into());
    }

    let payload_body = state.cipher.seal(
        &artifact_context(&request.artifact_id, &request.version),
        &request.payload.to_string(),
    )?;
    transaction
        .execute(
            "INSERT INTO artifact_versions
                (artifact_id, version, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                request.artifact_id,
                request.version,
                payload_body,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "UPDATE artifacts SET title = ?2, current_version = ?3, updated_at = ?4 WHERE id = ?1",
            params![
                request.artifact_id,
                request.title,
                request.version,
                request.created_at
            ],
        )
        .map_err(error_text)?;

    let thread_json: String = transaction
        .query_row(
            "SELECT body_json FROM threads WHERE id = ?1",
            params![request.thread_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    let mut thread = open_json_body(
        &state.cipher,
        &thread_context(&request.thread_id),
        &thread_json,
    )?;
    if let Some(refs) = thread
        .get_mut("activeArtifactRefs")
        .and_then(Value::as_array_mut)
        && let Some(reference) = refs.iter_mut().find(|reference| {
            reference.get("id").and_then(Value::as_str) == Some(request.artifact_id.as_str())
        })
    {
        reference["version"] = json!(request.version);
        reference["title"] = json!(request.title);
    }
    thread["updatedAt"] = json!(request.created_at);
    let thread_body = state
        .cipher
        .seal(&thread_context(&request.thread_id), &thread.to_string())?;
    transaction
        .execute(
            "UPDATE threads SET body_json = ?2, updated_at = ?3 WHERE id = ?1",
            params![request.thread_id, thread_body, request.created_at],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_snapshot_for_thread(state, &request.thread_id)
}

pub fn begin_local_run(
    state: &AppState,
    request: BeginLocalRunRequest,
) -> Result<WorkspaceSnapshot, String> {
    validate_identifier(&request.thread_id, "thread")?;
    validate_identifier(&request.artifact_id, "artifact")?;
    validate_identifier(&request.run_id, "run")?;
    validate_runtime_label(&request.provider, 80, "provider")?;
    validate_runtime_label(&request.model, 180, "model")?;

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let (thread_json, existing_run): (String, Option<(String, String, String)>) = {
        let thread_json = transaction
            .query_row(
                "SELECT body_json FROM threads WHERE id = ?1",
                params![request.thread_id],
                |row| row.get(0),
            )
            .map_err(error_text)?;
        let existing_run = transaction
            .query_row(
                "SELECT thread_id, artifact_id, status FROM runs WHERE id = ?1",
                params![request.run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(error_text)?;
        (thread_json, existing_run)
    };
    let artifact_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifacts WHERE id = ?1)",
            params![request.artifact_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if !artifact_exists {
        return Err("The run artifact does not exist in this local workspace.".into());
    }
    if let Some((thread_id, artifact_id, status)) = &existing_run {
        if thread_id != &request.thread_id || artifact_id != &request.artifact_id {
            return Err("The local run identifier belongs to different work.".into());
        }
        if matches!(status.as_str(), "completed" | "canceled") {
            return Err("This local run is already complete.".into());
        }
    }

    transaction
        .execute(
            "INSERT INTO runs (id, thread_id, artifact_id, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'running', ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET status = 'running', updated_at = excluded.updated_at",
            params![
                request.run_id,
                request.thread_id,
                request.artifact_id,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    append_run_event(
        &transaction,
        &state.cipher,
        &request.run_id,
        if existing_run.is_some() {
            "run.resumed"
        } else {
            "run.queued"
        },
        &json!({
            "status": "running",
            "provider": request.provider,
            "model": request.model,
        }),
        &request.created_at,
    )?;

    let mut thread = open_json_body(
        &state.cipher,
        &thread_context(&request.thread_id),
        &thread_json,
    )?;
    thread["status"] = json!("working");
    thread["activeRunRef"] = json!(request.run_id);
    thread["updatedAt"] = json!(request.created_at);
    let thread_body = state
        .cipher
        .seal(&thread_context(&request.thread_id), &thread.to_string())?;
    transaction
        .execute(
            "UPDATE threads
             SET body_json = ?2, status = 'working', active_run_ref = ?3, updated_at = ?4
             WHERE id = ?1",
            params![
                request.thread_id,
                thread_body,
                request.run_id,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_snapshot_for_thread(state, &request.thread_id)
}

pub fn save_run_checkpoint(
    state: &AppState,
    request: SaveRunCheckpointRequest,
) -> Result<WorkspaceSnapshot, String> {
    validate_identifier(&request.run_id, "run")?;
    if request.step_index < 0
        || request.step_index > 512
        || request.handoff.len() > 1_200
        || !request.prior_steps.is_array()
        || request.prior_steps.to_string().len() > 256_000
        || request
            .run_context
            .as_ref()
            .is_some_and(|context| context.to_string().len() > 256_000)
    {
        return Err("The local run checkpoint is invalid or too large.".into());
    }
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    require_open_run(&transaction, &request.run_id)?;
    let body = json!({
        "stepIndex": request.step_index,
        "handoff": request.handoff,
        "priorSteps": request.prior_steps,
        "gateApproved": request.gate_approved,
        "runContext": request.run_context,
    });
    let sealed = state
        .cipher
        .seal(&run_checkpoint_context(&request.run_id), &body.to_string())?;
    transaction
        .execute(
            "INSERT INTO run_checkpoints
                (run_id, step_index, body_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(run_id) DO UPDATE SET
                step_index = excluded.step_index,
                body_json = excluded.body_json,
                updated_at = excluded.updated_at",
            params![
                request.run_id,
                request.step_index,
                sealed,
                request.updated_at
            ],
        )
        .map_err(error_text)?;
    append_run_event(
        &transaction,
        &state.cipher,
        &request.run_id,
        "run.checkpoint",
        &json!({ "status": "checkpoint", "stepIndex": request.step_index }),
        &request.updated_at,
    )?;
    transaction.commit().map_err(error_text)?;
    load_snapshot_for_run(state, &request.run_id)
}

pub fn record_run_approval(
    state: &AppState,
    request: RecordRunApprovalRequest,
) -> Result<WorkspaceSnapshot, String> {
    validate_identifier(&request.id, "approval")?;
    validate_identifier(&request.run_id, "run")?;
    if request.step_index < 0
        || request.step_index > 512
        || !approval_status_is_valid(&request.status)
        || request.body.to_string().len() > 64_000
    {
        return Err("The local approval record is invalid or too large.".into());
    }
    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    require_open_run(&transaction, &request.run_id)?;
    let (thread_id, thread_json): (String, String) = transaction
        .query_row(
            "SELECT t.id, t.body_json
             FROM runs r JOIN threads t ON t.id = r.thread_id
             WHERE r.id = ?1",
            params![request.run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(error_text)?;
    let sealed = state
        .cipher
        .seal(&approval_context(&request.id), &request.body.to_string())?;
    transaction
        .execute(
            "INSERT INTO approvals
                (id, run_id, step_index, status, body_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                body_json = excluded.body_json,
                updated_at = excluded.updated_at",
            params![
                request.id,
                request.run_id,
                request.step_index,
                request.status,
                sealed,
                request.updated_at
            ],
        )
        .map_err(error_text)?;
    let run_status = if request.status == "awaiting" {
        "waiting-approval"
    } else if request.status == "approved" {
        "running"
    } else {
        "halted"
    };
    transaction
        .execute(
            "UPDATE runs SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![request.run_id, run_status, request.updated_at],
        )
        .map_err(error_text)?;
    let thread_status = if request.status == "awaiting" {
        "needs-input"
    } else if request.status == "approved" {
        "working"
    } else {
        "failed"
    };
    let mut thread = open_json_body(&state.cipher, &thread_context(&thread_id), &thread_json)?;
    thread["status"] = json!(thread_status);
    thread["activeRunRef"] = json!(request.run_id);
    thread["updatedAt"] = json!(request.updated_at);
    let thread_body = state
        .cipher
        .seal(&thread_context(&thread_id), &thread.to_string())?;
    transaction
        .execute(
            "UPDATE threads
             SET status = ?2, active_run_ref = ?3, body_json = ?4, updated_at = ?5
             WHERE id = ?1",
            params![
                thread_id,
                thread_status,
                request.run_id,
                thread_body,
                request.updated_at
            ],
        )
        .map_err(error_text)?;
    append_run_event(
        &transaction,
        &state.cipher,
        &request.run_id,
        if request.status == "awaiting" {
            "run.approval-required"
        } else {
            "run.approval-decided"
        },
        &json!({
            "status": request.status,
            "approvalId": request.id,
            "stepIndex": request.step_index,
        }),
        &request.updated_at,
    )?;
    transaction.commit().map_err(error_text)?;
    load_snapshot_for_thread(state, &thread_id)
}

pub fn record_local_check(
    state: &AppState,
    request: RecordLocalCheckRequest,
) -> Result<WorkspaceSnapshot, String> {
    validate_identifier(&request.thread_id, "thread")?;
    validate_identifier(&request.artifact_id, "artifact")?;
    validate_identifier(&request.run_id, "run")?;
    let provider = request.provider.as_deref().unwrap_or("local-check").trim();
    let model = request.model.as_deref().unwrap_or("deterministic").trim();
    let status = request.status.as_deref().unwrap_or("completed").trim();
    let summary = request
        .summary
        .as_deref()
        .unwrap_or("Local persistence and artifact links passed.")
        .trim();
    if provider.is_empty()
        || provider.len() > 80
        || model.is_empty()
        || model.len() > 180
        || summary.is_empty()
        || summary.len() > 4_000
        || !matches!(request.selection_mode.as_str(), "fixed" | "auto")
        || !matches!(status, "completed" | "failed" | "canceled")
        || request
            .receipt_details
            .as_ref()
            .is_some_and(|details| details.to_string().len() > 512_000)
    {
        return Err("The local run receipt is invalid.".into());
    }
    let metered_provider = matches!(provider, "openai" | "anthropic" | "gemini" | "local-team");
    let expected_billing_fallback = request.selection_mode == "auto"
        && request.metered_fallback_authorized
        && request.metered_provider_invocation_started;
    if (request.metered_fallback_authorized && request.selection_mode != "auto")
        || (request.metered_provider_invocation_started && !metered_provider)
        || (request.metered_provider_invocation_started
            && request.selection_mode == "auto"
            && !request.metered_fallback_authorized)
        || request.billing_fallback != expected_billing_fallback
    {
        return Err("The local run receipt billing provenance is invalid.".into());
    }
    if request.events.len() > 500
        || request.events.iter().enumerate().any(|(index, event)| {
            event.sequence != (index + 1) as i64
                || event.event_type.is_empty()
                || event.event_type.len() > 80
                || event.message.len() > 12_000
        })
    {
        return Err("The local run event stream is invalid.".into());
    }

    let mut connection = state.connection()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let (thread_json, current_sequence): (String, i64) = transaction
        .query_row(
            "SELECT body_json, latest_block_sequence FROM threads WHERE id = ?1",
            params![request.thread_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(error_text)?;

    let existing_run = transaction
        .query_row(
            "SELECT thread_id, artifact_id FROM runs WHERE id = ?1",
            params![request.run_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(error_text)?;
    if let Some((thread_id, artifact_id)) = existing_run
        && (thread_id != request.thread_id || artifact_id != request.artifact_id)
    {
        return Err("The local run identifier belongs to different work.".into());
    }

    transaction
        .execute(
            "INSERT INTO runs (id, thread_id, artifact_id, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
            params![
                request.run_id,
                request.thread_id,
                request.artifact_id,
                status,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "DELETE FROM run_events WHERE run_id = ?1",
            params![request.run_id],
        )
        .map_err(error_text)?;

    let events = if request.events.is_empty() {
        vec![
            (
                1_i64,
                "run.queued".to_string(),
                json!({ "status": "queued", "provider": provider, "model": model }),
                request.created_at.clone(),
            ),
            (
                2_i64,
                "run.completed".to_string(),
                json!({
                    "status": "completed",
                    "provider": provider,
                    "model": model,
                    "checks": ["sqlite-write", "artifact-version", "receipt-link"],
                }),
                request.created_at.clone(),
            ),
        ]
    } else {
        request
            .events
            .iter()
            .map(|event| {
                (
                    event.sequence,
                    if event.event_type.starts_with("run.") {
                        event.event_type.clone()
                    } else {
                        format!("run.{}", event.event_type)
                    },
                    json!({
                        "status": event.event_type,
                        "provider": provider,
                        "model": model,
                        "message": event.message,
                        "payload": event.payload,
                    }),
                    event.created_at.clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    for (sequence, event_type, payload, event_created_at) in events {
        let payload_body = state.cipher.seal(
            &run_event_context(&request.run_id, sequence),
            &payload.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    request.run_id,
                    sequence,
                    event_type,
                    payload_body,
                    event_created_at
                ],
            )
            .map_err(error_text)?;
    }

    let receipt_id = format!("receipt-{}", request.run_id);
    let receipt_body = json!({
        "status": status,
        "summary": summary,
        "runId": request.run_id,
        "artifactId": request.artifact_id,
        "provider": provider,
        "model": model,
        "selectionMode": request.selection_mode,
        "meteredFallbackAuthorized": request.metered_fallback_authorized,
        "meteredProviderInvocationStarted": request.metered_provider_invocation_started,
        "eventCount": if request.events.is_empty() { 2 } else { request.events.len() },
        "billingFallback": request.billing_fallback,
        "details": request.receipt_details,
    });
    let stored_receipt_body = state
        .cipher
        .seal(&receipt_context(&receipt_id), &receipt_body.to_string())?;
    transaction
        .execute(
            "INSERT INTO receipts (id, run_id, artifact_id, body_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                receipt_id,
                request.run_id,
                request.artifact_id,
                stored_receipt_body,
                request.created_at
            ],
        )
        .map_err(error_text)?;

    let receipt_artifact_id = "artifact-receipt-local";
    let receipt_artifact_body = state.cipher.seal(
        &artifact_context(receipt_artifact_id, &request.run_id),
        &receipt_body.to_string(),
    )?;
    transaction
        .execute(
            "INSERT INTO artifact_versions (artifact_id, version, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                receipt_artifact_id,
                request.run_id,
                receipt_artifact_body,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "UPDATE artifacts SET current_version = ?2, updated_at = ?3 WHERE id = ?1",
            params![receipt_artifact_id, request.run_id, request.created_at],
        )
        .map_err(error_text)?;

    let run_block_sequence = current_sequence + 1;
    let receipt_block_sequence = current_sequence + 2;
    let block_status = match status {
        "completed" => "completed",
        "canceled" => "stopped",
        _ => "failed",
    };
    let thread_status = if status == "completed" {
        "completed"
    } else {
        "failed"
    };
    let run_block = json!({
        "id": format!("block-{}", request.run_id),
        "sequence": run_block_sequence,
        "createdAt": request.created_at,
        "type": "run",
        "runId": request.run_id,
        "label": format!("{} local run", provider),
        "detail": summary,
        "status": block_status,
    });
    let receipt_ref = json!({
        "kind": "receipt",
        "id": receipt_artifact_id,
        "version": request.run_id,
        "projectId": "local-project",
        "title": "Local run receipt",
        "editorHref": "/local/receipt/artifact-receipt-local",
        "createdAt": request.created_at,
    });
    let receipt_summary = if request.billing_fallback {
        format!(
            "{} produced a local receipt after an authorized metered fallback was invoked.",
            provider
        )
    } else if request.metered_provider_invocation_started {
        format!(
            "{} produced a local receipt after an explicitly selected metered API was invoked.",
            provider
        )
    } else if request.metered_fallback_authorized {
        format!(
            "{} produced a local receipt with metered fallback authorized but no metered provider invocation started.",
            provider
        )
    } else {
        format!(
            "{} produced a local receipt with no metered provider invocation.",
            provider
        )
    };
    let receipt_block = json!({
        "id": format!("block-receipt-{}", request.run_id),
        "sequence": receipt_block_sequence,
        "createdAt": request.created_at,
        "type": "receipt",
        "artifact": receipt_ref,
        "summary": receipt_summary,
    });
    for (block, kind) in [(&run_block, "run"), (&receipt_block, "receipt")] {
        let sequence = block["sequence"]
            .as_i64()
            .ok_or_else(|| "Run block is missing its sequence.".to_string())?;
        let block_body = state.cipher.seal(
            &block_context(&request.thread_id, sequence),
            &block.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO thread_blocks (thread_id, sequence, id, kind, body_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    request.thread_id,
                    sequence,
                    block["id"].as_str(),
                    kind,
                    block_body,
                    request.created_at
                ],
            )
            .map_err(error_text)?;
    }

    let mut thread = open_json_body(
        &state.cipher,
        &thread_context(&request.thread_id),
        &thread_json,
    )?;
    thread["latestBlockSequence"] = json!(receipt_block_sequence);
    thread["status"] = json!(thread_status);
    thread["activeRunRef"] = json!(request.run_id);
    thread["updatedAt"] = json!(request.created_at);
    if let Some(refs) = thread
        .get_mut("activeArtifactRefs")
        .and_then(Value::as_array_mut)
        && let Some(reference) = refs.iter_mut().find(|reference| {
            reference.get("id").and_then(Value::as_str) == Some(receipt_artifact_id)
        })
    {
        reference["version"] = json!(request.run_id);
        reference["createdAt"] = json!(request.created_at);
    }
    let thread_body = state
        .cipher
        .seal(&thread_context(&request.thread_id), &thread.to_string())?;
    transaction
        .execute(
            "UPDATE threads
             SET body_json = ?2, status = ?3, latest_block_sequence = ?4,
                 active_run_ref = ?5, updated_at = ?6
             WHERE id = ?1",
            params![
                request.thread_id,
                thread_body,
                thread_status,
                receipt_block_sequence,
                request.run_id,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    let bot_status = match status {
        "completed" => "done",
        "canceled" => "paused",
        _ => "blocked",
    };
    let bot_latest_status = if status == "completed" {
        format!("Finished with {provider}")
    } else {
        summary.to_string()
    };
    transaction
        .execute(
            "UPDATE bots
             SET status = ?2, latest_status = ?3, updated_at = ?4
             WHERE thread_id = ?1",
            params![
                request.thread_id,
                bot_status,
                bot_latest_status,
                request.created_at
            ],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)?;
    load_snapshot_for_thread(state, &request.thread_id)
}

fn open_database(path: &Path, cipher: &DataCipher) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(error_text)?;
    }
    let mut connection = Connection::open(path).map_err(error_text)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = FULL;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(error_text)?;
    migrate(&connection)?;
    migrate_plaintext_bodies(&mut connection, cipher)?;
    migrate_artifact_files(&connection)?;
    migrate_run_state(&connection)?;
    migrate_mcp_servers(&connection)?;
    crate::scheduler::migrate(&connection)?;
    crate::autonomy::migrate(&connection)?;
    crate::desktop_cloud::migrate(&connection)?;
    migrate_bots(&connection)?;
    crate::bot_data::migrate(&connection)?;
    crate::browser_downloads::migrate(&connection)?;
    crate::computer_use::migrate(&connection)?;
    crate::event_routines::migrate(&connection)?;
    crate::delegations::migrate(&connection)?;
    crate::pilot_metrics::migrate(&connection)?;
    Ok(connection)
}

fn migrate(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY,
                owner_uid TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                latest_block_sequence INTEGER NOT NULL DEFAULT 0,
                active_run_ref TEXT,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS thread_blocks (
                thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                sequence INTEGER NOT NULL,
                id TEXT NOT NULL,
                kind TEXT NOT NULL,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (thread_id, sequence),
                UNIQUE (thread_id, id)
             );
             CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                current_version TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS artifact_versions (
                artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
                version TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (artifact_id, version)
             );
             CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                artifact_id TEXT NOT NULL REFERENCES artifacts(id),
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS run_events (
                run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                sequence INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (run_id, sequence)
             );
             CREATE TABLE IF NOT EXISTS receipts (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                artifact_id TEXT NOT NULL REFERENCES artifacts(id),
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS workspace_bookmarks (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                bookmark BLOB NOT NULL,
                read_only INTEGER NOT NULL DEFAULT 1,
                stale INTEGER NOT NULL DEFAULT 0,
                access_validated INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_thread_blocks_created
                ON thread_blocks(thread_id, created_at);
             CREATE INDEX IF NOT EXISTS idx_artifact_versions_created
                ON artifact_versions(artifact_id, created_at);
             CREATE INDEX IF NOT EXISTS idx_run_events_created
                ON run_events(run_id, created_at);",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

fn migrate_plaintext_bodies(
    connection: &mut Connection,
    cipher: &DataCipher,
) -> Result<(), String> {
    let already_applied: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 3)",
            [],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    if already_applied {
        return Ok(());
    }

    let transaction = connection.transaction().map_err(error_text)?;

    let rows = {
        let mut statement = transaction
            .prepare("SELECT id, body_json FROM threads")
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    for (id, body) in rows {
        let sealed = seal_stored_body(cipher, &thread_context(&id), &body)?;
        transaction
            .execute(
                "UPDATE threads SET body_json = ?2 WHERE id = ?1",
                params![id, sealed],
            )
            .map_err(error_text)?;
    }

    let rows = {
        let mut statement = transaction
            .prepare("SELECT thread_id, sequence, body_json FROM thread_blocks")
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    for (thread_id, sequence, body) in rows {
        let sealed = seal_stored_body(cipher, &block_context(&thread_id, sequence), &body)?;
        transaction
            .execute(
                "UPDATE thread_blocks SET body_json = ?3 WHERE thread_id = ?1 AND sequence = ?2",
                params![thread_id, sequence, sealed],
            )
            .map_err(error_text)?;
    }

    let rows = {
        let mut statement = transaction
            .prepare("SELECT artifact_id, version, payload_json FROM artifact_versions")
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
    for (artifact_id, version, body) in rows {
        let sealed = seal_stored_body(cipher, &artifact_context(&artifact_id, &version), &body)?;
        transaction
            .execute(
                "UPDATE artifact_versions SET payload_json = ?3 WHERE artifact_id = ?1 AND version = ?2",
                params![artifact_id, version, sealed],
            )
            .map_err(error_text)?;
    }

    let rows = {
        let mut statement = transaction
            .prepare("SELECT run_id, sequence, payload_json FROM run_events")
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    for (run_id, sequence, body) in rows {
        let sealed = seal_stored_body(cipher, &run_event_context(&run_id, sequence), &body)?;
        transaction
            .execute(
                "UPDATE run_events SET payload_json = ?3 WHERE run_id = ?1 AND sequence = ?2",
                params![run_id, sequence, sealed],
            )
            .map_err(error_text)?;
    }

    let rows = {
        let mut statement = transaction
            .prepare("SELECT id, body_json FROM receipts")
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    for (id, body) in rows {
        let sealed = seal_stored_body(cipher, &receipt_context(&id), &body)?;
        transaction
            .execute(
                "UPDATE receipts SET body_json = ?2 WHERE id = ?1",
                params![id, sealed],
            )
            .map_err(error_text)?;
    }

    transaction
        .execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)
}

fn migrate_artifact_files(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS artifact_files (
                artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
                hash TEXT NOT NULL,
                file_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                relative_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (artifact_id, hash)
             );",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

fn migrate_run_state(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS run_checkpoints (
                run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
                step_index INTEGER NOT NULL,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS approvals (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                step_index INTEGER NOT NULL,
                status TEXT NOT NULL,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_approvals_run
                ON approvals(run_id, created_at);",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

fn migrate_mcp_servers(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_mcp_servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                transport TEXT NOT NULL CHECK(transport IN ('stdio', 'localhost')),
                enabled INTEGER NOT NULL DEFAULT 0,
                fingerprint TEXT NOT NULL,
                config_json TEXT NOT NULL,
                catalog_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (6, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

fn migrate_bots(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS bots (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
                current_version INTEGER NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL,
                latest_status TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS bot_versions (
                bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                spec_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (bot_id, version)
             );
             CREATE TABLE IF NOT EXISTS bot_thread_members (
                bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (bot_id, thread_id)
             );
             CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE,
                scope TEXT NOT NULL,
                body_json TEXT NOT NULL,
                source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
                expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS memory_proposals (
                id TEXT PRIMARY KEY,
                bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                body_json TEXT NOT NULL,
                source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS skills (
                id TEXT PRIMARY KEY,
                current_version INTEGER NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS skill_versions (
                skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (skill_id, version)
             );
             CREATE TABLE IF NOT EXISTS routines (
                id TEXT PRIMARY KEY,
                bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                current_version INTEGER NOT NULL,
                title TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS routine_versions (
                routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
                version INTEGER NOT NULL,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (routine_id, version)
             );
             CREATE TABLE IF NOT EXISTS bot_events (
                id TEXT PRIMARY KEY,
                bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                body_json TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS bot_databases (
                id TEXT PRIMARY KEY,
                bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                schema_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_bots_one_active
                ON bots(active) WHERE active = 1;
             CREATE INDEX IF NOT EXISTS idx_bots_updated
                ON bots(updated_at DESC);
             CREATE INDEX IF NOT EXISTS idx_bot_events_created
                ON bot_events(bot_id, created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_memories_scope
                ON memories(bot_id, scope, updated_at DESC);
             CREATE INDEX IF NOT EXISTS idx_memory_proposals_review
                ON memory_proposals(bot_id, status, updated_at DESC);",
        )
        .map_err(error_text)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (11, ?1)",
            params![canonical_now()],
        )
        .map_err(error_text)?;
    Ok(())
}

fn seal_stored_body(cipher: &DataCipher, context: &str, body: &str) -> Result<String, String> {
    if DataCipher::is_sealed(body) {
        Ok(body.to_string())
    } else {
        cipher.seal(context, body)
    }
}

fn open_json_body(cipher: &DataCipher, context: &str, body: &str) -> Result<Value, String> {
    let plaintext = cipher.open(context, body)?;
    serde_json::from_str(&plaintext).map_err(error_text)
}

fn append_run_event(
    transaction: &Transaction<'_>,
    cipher: &DataCipher,
    run_id: &str,
    event_type: &str,
    payload: &Value,
    created_at: &str,
) -> Result<i64, String> {
    let sequence = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_events WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    let sealed = cipher.seal(&run_event_context(run_id, sequence), &payload.to_string())?;
    transaction
        .execute(
            "INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![run_id, sequence, event_type, sealed, created_at],
        )
        .map_err(error_text)?;
    Ok(sequence)
}

fn require_open_run(transaction: &Transaction<'_>, run_id: &str) -> Result<(), String> {
    let status = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error_text)?;
    match status.as_deref() {
        Some("running" | "waiting-approval") => Ok(()),
        Some(_) => Err("Resume this local run before changing its checkpoint.".into()),
        None => Err("The local run no longer exists.".into()),
    }
}

fn recover_interrupted_runs(
    connection: &mut Connection,
    cipher: &DataCipher,
) -> Result<(), String> {
    let running = {
        let mut statement = connection
            .prepare("SELECT id, thread_id FROM runs WHERE status = 'running'")
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    if running.is_empty() {
        return Ok(());
    }
    let recovered_at = canonical_now();
    let transaction = connection.transaction().map_err(error_text)?;
    for (run_id, thread_id) in running {
        transaction
            .execute(
                "UPDATE runs SET status = 'interrupted', updated_at = ?2 WHERE id = ?1",
                params![run_id, recovered_at],
            )
            .map_err(error_text)?;
        append_run_event(
            &transaction,
            cipher,
            &run_id,
            "run.interrupted",
            &json!({
                "status": "interrupted",
                "message": "The app closed before this run finished. Completed work and its checkpoint were preserved.",
            }),
            &recovered_at,
        )?;
        let thread_json: String = transaction
            .query_row(
                "SELECT body_json FROM threads WHERE id = ?1",
                params![thread_id],
                |row| row.get(0),
            )
            .map_err(error_text)?;
        let mut thread = open_json_body(cipher, &thread_context(&thread_id), &thread_json)?;
        thread["status"] = json!("failed");
        thread["activeRunRef"] = json!(run_id);
        thread["updatedAt"] = json!(recovered_at);
        let sealed = cipher.seal(&thread_context(&thread_id), &thread.to_string())?;
        transaction
            .execute(
                "UPDATE threads
                 SET status = 'failed', active_run_ref = ?2, body_json = ?3, updated_at = ?4
                 WHERE id = ?1",
                params![thread_id, run_id, sealed, recovered_at],
            )
            .map_err(error_text)?;
        let bot_id = transaction
            .query_row(
                "SELECT id FROM bots WHERE thread_id = ?1",
                params![thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(error_text)?;
        if let Some(bot_id) = bot_id {
            let latest_status =
                "The previous run was interrupted. Completed evidence was preserved.";
            let updated = transaction
                .execute(
                    "UPDATE bots
                     SET status = 'blocked', latest_status = ?2, updated_at = ?3
                     WHERE id = ?1 AND status IN ('thinking', 'working', 'watching')",
                    params![bot_id, latest_status, recovered_at],
                )
                .map_err(error_text)?;
            if updated > 0 {
                let event_id = format!("event-recovered-{run_id}");
                let event = json!({
                    "status": "blocked",
                    "message": latest_status,
                    "runId": run_id,
                    "createdAt": recovered_at,
                });
                let event_body = cipher.seal(&bot_event_context(&event_id), &event.to_string())?;
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO bot_events
                            (id, bot_id, event_type, body_json, created_at)
                         VALUES (?1, ?2, 'status', ?3, ?4)",
                        params![event_id, bot_id, event_body, recovered_at],
                    )
                    .map_err(error_text)?;
            }
        }
    }
    transaction.commit().map_err(error_text)
}

fn thread_context(id: &str) -> String {
    format!("threads:{id}")
}

fn block_context(thread_id: &str, sequence: i64) -> String {
    format!("thread-blocks:{thread_id}:{sequence}")
}

fn artifact_context(artifact_id: &str, version: &str) -> String {
    format!("artifact-versions:{artifact_id}:{version}")
}

fn run_event_context(run_id: &str, sequence: i64) -> String {
    format!("run-events:{run_id}:{sequence}")
}

fn run_checkpoint_context(run_id: &str) -> String {
    format!("run-checkpoints:{run_id}")
}

fn approval_context(id: &str) -> String {
    format!("approvals:{id}")
}

fn receipt_context(id: &str) -> String {
    format!("receipts:{id}")
}

fn mcp_config_context(id: &str) -> String {
    format!("local-mcp-servers:{id}:config")
}

fn mcp_catalog_context(id: &str) -> String {
    format!("local-mcp-servers:{id}:catalog")
}

fn bot_version_context(id: &str, version: i64) -> String {
    format!("bot-versions:{id}:{version}")
}

fn bot_event_context(id: &str) -> String {
    format!("bot-events:{id}")
}

fn memory_context(id: &str) -> String {
    format!("memory:{id}")
}

fn memory_proposal_context(id: &str) -> String {
    format!("memory-proposal:{id}")
}

fn skill_version_context(id: &str, version: i64) -> String {
    format!("skill-versions:{id}:{version}")
}

fn deterministic_bot_avatar(id: &str) -> BotAvatarSpec {
    let hash = id.chars().fold(0_i32, |hash, character| {
        hash.wrapping_mul(31).wrapping_add(character as i32)
    });
    let magnitude = if hash < 0 {
        -(hash as i64)
    } else {
        hash as i64
    };
    let preset = match BOT_AVATAR_PRESETS[magnitude as usize % BOT_AVATAR_PRESETS.len()] {
        "orbit" => BotAvatarPreset::Orbit,
        "mountain" => BotAvatarPreset::Mountain,
        "ember" => BotAvatarPreset::Ember,
        "prism" => BotAvatarPreset::Prism,
        "wave" => BotAvatarPreset::Wave,
        _ => BotAvatarPreset::Spark,
    };
    BotAvatarSpec::Preset { preset }
}

fn validate_bot_avatar(avatar: &BotAvatarSpec) -> Result<(), String> {
    let BotAvatarSpec::Image { data_url } = avatar else {
        return Ok(());
    };
    let encoded = data_url
        .strip_prefix(BOT_AVATAR_PNG_PREFIX)
        .ok_or_else(|| "Bot avatar images must be PNG files.".to_string())?;
    if encoded.is_empty() || encoded.len() > MAX_BOT_AVATAR_BASE64_CHARS {
        return Err("The bot avatar PNG is invalid or too large.".into());
    }
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "The bot avatar PNG is invalid or too large.".to_string())?;
    if bytes.len() < 33 || bytes.len() > MAX_BOT_AVATAR_PNG_BYTES {
        return Err("The bot avatar PNG is invalid or too large.".into());
    }
    let signature = [137, 80, 78, 71, 13, 10, 26, 10];
    let chunk_length = u32::from_be_bytes(bytes[8..12].try_into().expect("bounded PNG header"));
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("bounded PNG header"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("bounded PNG header"));
    if bytes[..8] != signature
        || chunk_length != 13
        || &bytes[12..16] != b"IHDR"
        || width != 256
        || height != 256
    {
        return Err("Bot avatar images must be 256 by 256 pixel PNG files.".into());
    }
    Ok(())
}

fn bot_avatar_from_spec(spec: &Value, bot_id: &str) -> BotAvatarSpec {
    spec.pointer("/appearance/avatar")
        .cloned()
        .and_then(|avatar| serde_json::from_value::<BotAvatarSpec>(avatar).ok())
        .filter(|avatar| validate_bot_avatar(avatar).is_ok())
        .unwrap_or_else(|| deterministic_bot_avatar(bot_id))
}

fn validate_bot_spec_appearance(spec: &Value) -> Result<(), String> {
    let Some(appearance) = spec.get("appearance") else {
        return Ok(());
    };
    let avatar = appearance
        .get("avatar")
        .cloned()
        .ok_or_else(|| "A bot avatar in the backup is invalid.".to_string())?;
    let avatar = serde_json::from_value::<BotAvatarSpec>(avatar)
        .map_err(|_| "A bot avatar in the backup is invalid.".to_string())?;
    validate_bot_avatar(&avatar).map_err(|_| "A bot avatar in the backup is invalid.".to_string())
}

fn validate_bot_spec_browser_domains(spec: &Value) -> Result<(), String> {
    let Some(value) = spec.pointer("/permissionPolicy/browserDomains") else {
        return Ok(());
    };
    let values = value
        .as_array()
        .ok_or_else(|| "A bot browser domain scope in the backup is invalid.".to_string())?
        .iter()
        .map(|domain| {
            domain
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "A bot browser domain scope in the backup is invalid.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let normalized = normalize_browser_domain_scopes(&values)
        .map_err(|_| "A bot browser domain scope in the backup is invalid.".to_string())?;
    if normalized != values {
        return Err("A bot browser domain scope in the backup is invalid.".into());
    }
    Ok(())
}

fn bot_avatar_event(avatar: &BotAvatarSpec) -> Value {
    match avatar {
        BotAvatarSpec::Preset { preset } => json!({
            "kind": "preset",
            "preset": preset,
        }),
        BotAvatarSpec::Image { .. } => json!({ "kind": "image" }),
    }
}

fn starter_bot_spec(
    id: &str,
    name: &str,
    job: &str,
    avatar: &BotAvatarSpec,
    created_at: &str,
) -> Value {
    let goal = starter_bot_goal(id, job, created_at);
    json!({
        "schemaVersion": 1,
        "botId": id,
        "version": 1,
        "name": name,
        "job": job,
        "instructions": [
            "Start with the smallest useful result.",
            "Use only approved local context and identify uncertainty.",
            "Never claim an action happened unless a receipt confirms it."
        ],
        "enginePolicy": {
            "mode": "auto",
            "allowedProviders": [
                "mlx", "codex", "copilot", "antigravity", "ollama", "lmstudio",
                "openai", "anthropic", "gemini"
            ],
            "allowMeteredFallback": false
        },
        "capabilityIds": ["conversation", "project-read", "browser-read"],
        "permissionPolicy": {
            "approvalMode": "ask",
            "browserDomains": [],
            "projectAccess": "ask",
            "browserAccess": "ask",
            "writeActions": "always-ask",
            "computerUse": "ask"
        },
        "autonomyPolicy": {
            "mode": "manual",
            "maxActionsPerRun": 8,
            "allowBackground": false
        },
        "memoryPolicy": {
            "mode": "proposals",
            "scopes": ["bot"],
            "proposalReview": "required"
        },
        "goal": goal,
        "routineIds": [],
        "appearance": {
            "avatar": avatar
        },
        "createdAt": created_at,
        "updatedAt": created_at
    })
}

fn starter_bot_goal(id: &str, job: &str, created_at: &str) -> Value {
    json!({
        "id": format!("goal-{id}"),
        "outcome": job,
        "successCriteria": [
            "Produce one concrete result backed by inspectable evidence.",
            "Keep external changes and sensitive actions behind approval."
        ],
        "status": "active",
        "nextAction": "Take the smallest useful read-only step with the context available now.",
        "createdAt": created_at,
        "updatedAt": created_at,
    })
}

fn bot_thread_body(thread_id: &str, name: &str, created_at: &str) -> Value {
    json!({
        "id": thread_id,
        "ownerUid": "local-device",
        "workspaceId": "local-workspace",
        "projectId": "local-project",
        "title": name,
        "status": "idle",
        "latestBlockSequence": 1,
        "activeArtifactRefs": [],
        "createdAt": created_at,
        "updatedAt": created_at
    })
}

fn bot_welcome_block(id: &str, name: &str, job: &str, created_at: &str) -> Value {
    json!({
        "id": format!("block-welcome-{id}"),
        "sequence": 1,
        "createdAt": created_at,
        "type": "assistant-message",
        "text": format!("I'm {name}. {job} Give me one outcome and I will start with the safest useful step."),
    })
}

fn seed_builtin_skills(connection: &mut Connection, cipher: &DataCipher) -> Result<(), String> {
    const BUILTIN_SKILLS_JSON: &str = include_str!("../../builtin-skills.json");
    const PACKAGED_AT: &str = "2026-08-19T00:00:00.000Z";
    let manifests = serde_json::from_str::<Vec<PackagedBotSkillManifest>>(BUILTIN_SKILLS_JSON)
        .map_err(|_| "The packaged skill catalog is invalid.".to_string())?;
    if manifests.is_empty() || manifests.len() > 12 {
        return Err("The packaged skill catalog is invalid.".into());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error_text)?;
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for manifest in manifests {
        validate_identifier(&manifest.id, "packaged skill")?;
        if manifest.version < 1
            || manifest.version > 10_000
            || !ids.insert(manifest.id.clone())
            || !names.insert(manifest.name.trim().to_lowercase())
        {
            return Err(
                "The packaged skill catalog contains a duplicate or invalid version.".into(),
            );
        }
        let body = packaged_skill_body(&manifest, "built-in", "packaged")?;
        let existing = transaction
            .query_row(
                "SELECT current_version, name, created_at FROM skills WHERE id = ?1",
                params![manifest.id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(error_text)?;
        if let Some((current_version, name, _)) = &existing {
            if name != &manifest.name {
                return Err("A packaged skill identifier conflicts with local skill data.".into());
            }
            let current_body = transaction
                .query_row(
                    "SELECT body_json FROM skill_versions WHERE skill_id = ?1 AND version = ?2",
                    params![manifest.id, current_version],
                    |row| row.get::<_, String>(0),
                )
                .map_err(error_text)?;
            let opened = open_json_body(
                cipher,
                &skill_version_context(&manifest.id, *current_version),
                &current_body,
            )?;
            validate_skill_body(&manifest.name, &opened)?;
            if opened.get("source").and_then(Value::as_str) != Some("built-in") {
                return Err("A packaged skill conflicts with a user-created skill.".into());
            }
            if *current_version > manifest.version {
                continue;
            }
            if *current_version == manifest.version {
                if opened.get("checksum") != body.get("checksum") {
                    return Err("A packaged skill failed its content checksum.".into());
                }
                continue;
            }
        }
        if existing.is_none() {
            let name_conflict = transaction
                .query_row(
                    "SELECT id FROM skills
                     WHERE lower(trim(name)) = lower(trim(?1)) AND id <> ?2
                     LIMIT 1",
                    params![manifest.name, manifest.id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(error_text)?;
            if name_conflict.is_some() {
                continue;
            }
        }
        let sealed = cipher.seal(
            &skill_version_context(&manifest.id, manifest.version),
            &body.to_string(),
        )?;
        match existing {
            Some((_, _, _)) => {
                transaction
                    .execute(
                        "UPDATE skills SET current_version = ?2, updated_at = ?3 WHERE id = ?1",
                        params![manifest.id, manifest.version, PACKAGED_AT],
                    )
                    .map_err(error_text)?;
            }
            None => {
                transaction
                    .execute(
                        "INSERT INTO skills (id, current_version, name, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?4)",
                        params![manifest.id, manifest.version, manifest.name, PACKAGED_AT],
                    )
                    .map_err(error_text)?;
            }
        }
        transaction
            .execute(
                "INSERT INTO skill_versions (skill_id, version, body_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![manifest.id, manifest.version, sealed, PACKAGED_AT],
            )
            .map_err(error_text)?;
    }
    transaction.commit().map_err(error_text)
}

fn packaged_skill_body(
    manifest: &PackagedBotSkillManifest,
    source: &str,
    trust_state: &str,
) -> Result<Value, String> {
    let body_without_checksum = json!({
        "schemaVersion": 2,
        "description": manifest.description,
        "instructions": manifest.instructions,
        "capabilityIds": manifest.capability_ids,
        "inputSchema": manifest.input_schema,
        "outputSchema": manifest.output_schema,
        "requiredPermissions": manifest.required_permissions,
        "effects": manifest.effects,
        "examples": manifest.examples,
        "checks": manifest.checks,
        "source": source,
        "trustState": trust_state,
    });
    let checksum = skill_checksum(&manifest.name, &body_without_checksum)?;
    let mut body = body_without_checksum;
    body["checksum"] = Value::String(checksum);
    validate_skill_body(&manifest.name, &body)?;
    Ok(body)
}

fn seed_bots(connection: &mut Connection, cipher: &DataCipher) -> Result<(), String> {
    let has_bot: bool = connection
        .query_row("SELECT EXISTS(SELECT 1 FROM bots)", [], |row| row.get(0))
        .map_err(error_text)?;
    if has_bot {
        return Ok(());
    }

    let id = "bot-codelit";
    let thread_id = "thread-bot-codelit";
    let name = "Codelit";
    let job =
        "I investigate your local projects and turn a request into a clear, verifiable next step.";
    let now = canonical_now();
    let thread = bot_thread_body(thread_id, name, &now);
    let welcome = bot_welcome_block(id, name, job, &now);
    let avatar = deterministic_bot_avatar(id);
    let spec = starter_bot_spec(id, name, job, &avatar, &now);
    let thread_body = cipher.seal(&thread_context(thread_id), &thread.to_string())?;
    let block_body = cipher.seal(&block_context(thread_id, 1), &welcome.to_string())?;
    let spec_body = cipher.seal(&bot_version_context(id, 1), &spec.to_string())?;
    let transaction = connection.transaction().map_err(error_text)?;
    transaction
        .execute("UPDATE bots SET active = 0 WHERE active = 1", [])
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO threads
                (id, owner_uid, title, status, latest_block_sequence, body_json, created_at, updated_at)
             VALUES (?1, 'local-device', ?2, 'idle', 1, ?3, ?4, ?4)",
            params![thread_id, name, thread_body, now],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO thread_blocks (thread_id, sequence, id, kind, body_json, created_at)
             VALUES (?1, 1, 'block-welcome-bot-codelit', 'assistant-message', ?2, ?3)",
            params![thread_id, block_body, now],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO bots
                (id, thread_id, current_version, name, status, latest_status, active, created_at, updated_at)
             VALUES (?1, ?2, 1, ?3, 'sleeping', 'Ready for a task', 1, ?4, ?4)",
            params![id, thread_id, name, now],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO bot_versions (bot_id, version, spec_json, created_at)
             VALUES (?1, 1, ?2, ?3)",
            params![id, spec_body, now],
        )
        .map_err(error_text)?;
    transaction
        .execute(
            "INSERT INTO bot_thread_members (bot_id, thread_id, role, created_at)
             VALUES (?1, ?2, 'owner', ?3)",
            params![id, thread_id, now],
        )
        .map_err(error_text)?;
    transaction.commit().map_err(error_text)
}

fn upgrade_bot_capabilities(
    connection: &mut Connection,
    cipher: &DataCipher,
) -> Result<(), String> {
    let candidates = {
        let mut statement = connection
            .prepare(
                "SELECT b.id, b.current_version, v.spec_json
                 FROM bots b
                 JOIN bot_versions v ON v.bot_id = b.id AND v.version = b.current_version",
            )
            .map_err(error_text)?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(error_text)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error_text)?
    };
    let transaction = connection.transaction().map_err(error_text)?;
    for (bot_id, current_version, stored_spec) in candidates {
        let mut spec = open_json_body(
            cipher,
            &bot_version_context(&bot_id, current_version),
            &stored_spec,
        )?;
        let mut changed = false;
        if let Some(capabilities) = spec.get_mut("capabilityIds").and_then(Value::as_array_mut)
            && !capabilities
                .iter()
                .any(|capability| capability.as_str() == Some("browser-read"))
        {
            capabilities.push(json!("browser-read"));
            changed = true;
        }
        if spec["permissionPolicy"]["approvalMode"].as_str().is_none() {
            let Some(policy) = spec
                .get_mut("permissionPolicy")
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            policy.insert("approvalMode".into(), json!("ask"));
            changed = true;
        }
        if spec["permissionPolicy"]["browserDomains"]
            .as_array()
            .is_none()
        {
            let Some(policy) = spec
                .get_mut("permissionPolicy")
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            policy.insert("browserDomains".into(), json!([]));
            changed = true;
        }
        if let Some(engine_policy) = spec.get_mut("enginePolicy").and_then(Value::as_object_mut) {
            if engine_policy
                .get("allowMeteredFallback")
                .and_then(Value::as_bool)
                .is_none()
            {
                engine_policy.insert("allowMeteredFallback".into(), json!(false));
                changed = true;
            }
            let legacy_default = engine_policy.get("mode").and_then(Value::as_str) == Some("auto")
                && engine_policy
                    .get("allowedProviders")
                    .and_then(Value::as_array)
                    .is_some_and(|providers| {
                        let mut providers = providers
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>();
                        providers.sort_unstable();
                        providers == ["codex", "mlx", "ollama"]
                    });
            if legacy_default {
                engine_policy.insert(
                    "allowedProviders".into(),
                    json!([
                        "mlx",
                        "codex",
                        "copilot",
                        "antigravity",
                        "ollama",
                        "lmstudio",
                        "openai",
                        "anthropic",
                        "gemini"
                    ]),
                );
                changed = true;
            }
        }
        if spec.get("goal").is_none() {
            let job = spec
                .get("job")
                .and_then(Value::as_str)
                .unwrap_or("Complete one useful local task.");
            let created_at = spec
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or("1970-01-01T00:00:00.000Z");
            spec["goal"] = starter_bot_goal(&bot_id, job, created_at);
            changed = true;
        }
        if !changed {
            continue;
        }
        let next_version = current_version + 1;
        let updated_at = canonical_now();
        spec["version"] = json!(next_version);
        spec["updatedAt"] = json!(updated_at.clone());
        let body = cipher.seal(
            &bot_version_context(&bot_id, next_version),
            &spec.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO bot_versions (bot_id, version, spec_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![bot_id, next_version, body, updated_at],
            )
            .map_err(error_text)?;
        transaction
            .execute(
                "UPDATE bots SET current_version = ?2, updated_at = ?3 WHERE id = ?1",
                params![bot_id, next_version, updated_at],
            )
            .map_err(error_text)?;
    }
    transaction.commit().map_err(error_text)
}

fn seed_workspace(connection: &mut Connection, cipher: &DataCipher) -> Result<(), String> {
    let has_thread: bool = connection
        .query_row("SELECT EXISTS(SELECT 1 FROM threads)", [], |row| row.get(0))
        .map_err(error_text)?;
    if has_thread {
        return Ok(());
    }

    let now = canonical_now();
    let artifacts = seed_artifacts(&now);
    let references: Vec<Value> = artifacts
        .iter()
        .map(|artifact| {
            json!({
                "kind": artifact.kind,
                "id": artifact.id,
                "version": artifact.version,
                "projectId": artifact.project_id,
                "title": artifact.title,
                "editorHref": format!("/local/{}/{}", artifact.kind, artifact.id),
                "createdAt": artifact.created_at,
            })
        })
        .collect();
    let thread = json!({
        "id": "local-welcome",
        "ownerUid": "local-device",
        "workspaceId": "local-workspace",
        "projectId": "local-project",
        "title": "Local release workspace",
        "status": "idle",
        "latestBlockSequence": 4,
        "activeArtifactRefs": references,
        "createdAt": now,
        "updatedAt": now,
    });
    let blocks = vec![
        json!({
            "id": "block-welcome",
            "sequence": 1,
            "createdAt": now,
            "type": "assistant-message",
            "text": "Your local workspace is ready. Choose an artifact or describe what you want to build.",
        }),
        artifact_block(2, &artifacts[0], "Shape the outcome before implementation."),
        artifact_block(
            3,
            &artifacts[1],
            "Map the system, boundaries, and operational path.",
        ),
        artifact_block(
            4,
            &artifacts[2],
            "Coordinate a local team with explicit handoffs.",
        ),
    ];

    let transaction = connection.transaction().map_err(error_text)?;
    let thread_body = cipher.seal(&thread_context("local-welcome"), &thread.to_string())?;
    transaction
        .execute(
            "INSERT INTO threads
                (id, owner_uid, title, status, latest_block_sequence, body_json, created_at, updated_at)
             VALUES ('local-welcome', 'local-device', 'Local release workspace', 'idle', 4, ?1, ?2, ?2)",
            params![thread_body, now],
        )
        .map_err(error_text)?;
    for block in &blocks {
        let sequence = block["sequence"]
            .as_i64()
            .ok_or_else(|| "Seed block is missing its sequence.".to_string())?;
        let block_body = cipher.seal(
            &block_context("local-welcome", sequence),
            &block.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO thread_blocks (thread_id, sequence, id, kind, body_json, created_at)
                 VALUES ('local-welcome', ?1, ?2, ?3, ?4, ?5)",
                params![
                    sequence,
                    block["id"].as_str(),
                    block["type"].as_str(),
                    block_body,
                    block["createdAt"].as_str()
                ],
            )
            .map_err(error_text)?;
    }
    for artifact in &artifacts {
        let payload = cipher.seal(
            &artifact_context(artifact.id, artifact.version),
            &artifact.payload.to_string(),
        )?;
        transaction
            .execute(
                "INSERT INTO artifacts
                    (id, kind, project_id, title, current_version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    artifact.id,
                    artifact.kind,
                    artifact.project_id,
                    artifact.title,
                    artifact.version,
                    artifact.created_at
                ],
            )
            .map_err(error_text)?;
        transaction
            .execute(
                "INSERT INTO artifact_versions (artifact_id, version, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![artifact.id, artifact.version, payload, artifact.created_at],
            )
            .map_err(error_text)?;
    }
    transaction.commit().map_err(error_text)
}

#[cfg(test)]
fn load_snapshot(state: &AppState) -> Result<WorkspaceSnapshot, String> {
    load_most_recent_snapshot(state)
}

fn load_most_recent_legacy_snapshot(state: &AppState) -> Result<WorkspaceSnapshot, String> {
    let connection = state.connection()?;
    let thread_id: String = connection
        .query_row(
            "SELECT t.id
             FROM threads t
             LEFT JOIN bots b ON b.thread_id = t.id
             WHERE b.id IS NULL
             ORDER BY t.updated_at DESC
             LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    drop(connection);
    load_snapshot_for_thread(state, &thread_id)
}

#[cfg(test)]
fn load_most_recent_snapshot(state: &AppState) -> Result<WorkspaceSnapshot, String> {
    let connection = state.connection()?;
    let thread_id: String = connection
        .query_row(
            "SELECT id FROM threads ORDER BY updated_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    drop(connection);
    load_snapshot_for_thread(state, &thread_id)
}

fn load_snapshot_for_run(state: &AppState, run_id: &str) -> Result<WorkspaceSnapshot, String> {
    validate_identifier(run_id, "run")?;
    let connection = state.connection()?;
    let thread_id: String = connection
        .query_row(
            "SELECT thread_id FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(error_text)?;
    drop(connection);
    load_snapshot_for_thread(state, &thread_id)
}

fn load_snapshot_for_thread(
    state: &AppState,
    requested_thread_id: &str,
) -> Result<WorkspaceSnapshot, String> {
    validate_identifier(requested_thread_id, "thread")?;
    let connection = state.connection()?;
    let (thread_id, thread_json): (String, String) = connection
        .query_row(
            "SELECT id, body_json FROM threads WHERE id = ?1",
            params![requested_thread_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(error_text)?;
    let thread = open_json_body(&state.cipher, &thread_context(&thread_id), &thread_json)?;

    let mut blocks = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT sequence, body_json FROM thread_blocks
             WHERE thread_id = ?1 ORDER BY sequence ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![thread_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(error_text)?;
    for row in rows {
        let (sequence, body) = row.map_err(error_text)?;
        blocks.push(open_json_body(
            &state.cipher,
            &block_context(&thread_id, sequence),
            &body,
        )?);
    }

    let mut artifacts = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT a.id, a.kind, a.current_version, a.title, a.project_id,
                    v.payload_json, v.created_at
             FROM artifacts a
             JOIN artifact_versions v
               ON v.artifact_id = a.id AND v.version = a.current_version
             ORDER BY CASE a.kind
                WHEN 'product-plan' THEN 1
                WHEN 'architecture' THEN 2
                WHEN 'agent-team' THEN 3
                WHEN 'plan-ship' THEN 4
                ELSE 5 END",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(error_text)?;
    for row in rows {
        let (artifact_id, kind, version, title, project_id, payload_json, created_at) =
            row.map_err(error_text)?;
        let payload = open_json_body(
            &state.cipher,
            &artifact_context(&artifact_id, &version),
            &payload_json,
        )?;
        artifacts.push(ArtifactVersionRecord {
            artifact_id,
            kind,
            version,
            title,
            project_id,
            payload,
            created_at,
        });
    }

    let mut run_events = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT e.run_id, e.sequence, e.event_type, e.payload_json, e.created_at
             FROM run_events e
             JOIN runs r ON r.id = e.run_id
             WHERE r.thread_id = ?1
             ORDER BY e.created_at ASC, e.sequence ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(error_text)?;
    for row in rows {
        let (run_id, sequence, event_type, payload_json, created_at) = row.map_err(error_text)?;
        let payload = open_json_body(
            &state.cipher,
            &run_event_context(&run_id, sequence),
            &payload_json,
        )?;
        run_events.push(RunEventRecord {
            run_id,
            sequence,
            event_type,
            payload,
            created_at,
        });
    }

    let mut run_checkpoints = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT c.run_id, c.step_index, c.body_json, c.updated_at
             FROM run_checkpoints c
             JOIN runs r ON r.id = c.run_id
             WHERE r.thread_id = ?1
             ORDER BY c.updated_at ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(error_text)?;
    for row in rows {
        let (run_id, step_index, body_json, updated_at) = row.map_err(error_text)?;
        let body = open_json_body(&state.cipher, &run_checkpoint_context(&run_id), &body_json)?;
        run_checkpoints.push(RunCheckpointRecord {
            run_id,
            step_index,
            body,
            updated_at,
        });
    }

    let mut approvals = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT a.id, a.run_id, a.step_index, a.status, a.body_json, a.created_at, a.updated_at
             FROM approvals a
             JOIN runs r ON r.id = a.run_id
             WHERE r.thread_id = ?1
             ORDER BY a.created_at ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(error_text)?;
    for row in rows {
        let (id, run_id, step_index, status, body_json, created_at, updated_at) =
            row.map_err(error_text)?;
        let body = open_json_body(&state.cipher, &approval_context(&id), &body_json)?;
        approvals.push(ApprovalRecord {
            id,
            run_id,
            step_index,
            status,
            body,
            created_at,
            updated_at,
        });
    }

    let mut receipts = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT x.id, x.run_id, x.artifact_id, x.body_json, x.created_at
             FROM receipts x
             JOIN runs r ON r.id = x.run_id
             WHERE r.thread_id = ?1
             ORDER BY x.created_at ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map(params![thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(error_text)?;
    for row in rows {
        let (id, run_id, artifact_id, body_json, created_at) = row.map_err(error_text)?;
        let body = open_json_body(&state.cipher, &receipt_context(&id), &body_json)?;
        receipts.push(ReceiptRecord {
            id,
            run_id,
            artifact_id,
            body,
            created_at,
        });
    }

    let mut artifact_files = Vec::new();
    let mut statement = connection
        .prepare(
            "SELECT artifact_id, hash, file_name, mime_type, size, created_at
             FROM artifact_files ORDER BY created_at ASC",
        )
        .map_err(error_text)?;
    let rows = statement
        .query_map([], |row| {
            Ok(ArtifactFileRecord {
                artifact_id: row.get(0)?,
                hash: row.get(1)?,
                file_name: row.get(2)?,
                mime_type: row.get(3)?,
                size: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(error_text)?;
    for row in rows {
        artifact_files.push(row.map_err(error_text)?);
    }

    let workspace_folder = connection
        .query_row(
            "SELECT path, read_only, stale, access_validated, updated_at
             FROM workspace_bookmarks WHERE id = 'primary'",
            [],
            |row| {
                Ok(WorkspaceFolderRecord {
                    path: row.get(0)?,
                    read_only: row.get(1)?,
                    stale: row.get(2)?,
                    access_validated: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(error_text)?;

    Ok(WorkspaceSnapshot {
        thread,
        blocks,
        artifacts,
        run_events,
        run_checkpoints,
        approvals,
        receipts,
        artifact_files,
        workspace_folder,
        database_path: state.database_path.to_string_lossy().into_owned(),
    })
}

#[derive(Clone)]
struct SeedArtifact {
    id: &'static str,
    kind: &'static str,
    version: &'static str,
    title: &'static str,
    project_id: &'static str,
    payload: Value,
    created_at: String,
}

fn seed_artifacts(now: &str) -> Vec<SeedArtifact> {
    vec![
        SeedArtifact {
            id: "artifact-product-local",
            kind: "product-plan",
            version: "v1",
            title: "Release outcome plan",
            project_id: "local-project",
            payload: json!({
                "problem": "Turn a release request into one bounded, reviewable outcome.",
                "audience": "Small product and engineering teams",
                "outcomes": ["A scoped release", "Visible acceptance checks", "A clear owner"],
                "milestones": ["Define", "Build", "Verify", "Ship"]
            }),
            created_at: now.to_string(),
        },
        SeedArtifact {
            id: "artifact-architecture-local",
            kind: "architecture",
            version: "v1",
            title: "Local release architecture",
            project_id: "local-project",
            payload: json!({
                "summary": "A local-first workflow with explicit boundaries and recoverable evidence.",
                "components": [
                    { "id": "input", "name": "Thread", "detail": "Intent and artifact context" },
                    { "id": "runtime", "name": "Local runtime", "detail": "Provider and tool adapters" },
                    { "id": "evidence", "name": "Receipt store", "detail": "SQLite event history" }
                ]
            }),
            created_at: now.to_string(),
        },
        SeedArtifact {
            id: "artifact-agent-local",
            kind: "agent-team",
            version: "v1",
            title: "Local release team",
            project_id: "local-project",
            payload: json!({
                "goal": "Inspect, patch, and verify one bounded repository change on this Mac.",
                "agents": [
                    {
                        "id": "inspector",
                        "name": "Repository Inspector",
                        "role": "Starts with FILES: followed by up to eight exact relative paths, then explains the smallest safe change.",
                        "provider": "codex",
                        "model": "default",
                        "tools": ["Selected folder", "Git read"]
                    },
                    {
                        "id": "author",
                        "name": "Patch Author",
                        "role": "Produces one bounded unified Git diff, beginning with diff --git, and no unrelated edits.",
                        "provider": "codex",
                        "model": "default",
                        "tools": ["Selected files"]
                    },
                    {
                        "id": "applier",
                        "name": "Patch Review",
                        "role": "Stages the exact proposed diff, waits for approval, and applies only that reviewed patch.",
                        "provider": "codex",
                        "model": "default",
                        "tools": ["Apply approved patch"]
                    },
                    {
                        "id": "verifier",
                        "name": "Change Verifier",
                        "role": "Checks the applied diff, runs the project's test script in isolated staging, and reports concrete evidence or a safe repair step.",
                        "provider": "claude",
                        "model": "default",
                        "tools": ["Diff read", "Local checks", "Project test"]
                    }
                ],
                "handoffs": [
                    { "from": "inspector", "to": "author", "label": "Smallest change" },
                    { "from": "author", "to": "applier", "label": "Patch ready" },
                    { "from": "applier", "to": "verifier", "label": "Applied for verification" }
                ]
            }),
            created_at: now.to_string(),
        },
        SeedArtifact {
            id: "artifact-plan-ship-local",
            kind: "plan-ship",
            version: "v1",
            title: "Plan and ship checklist",
            project_id: "local-project",
            payload: json!({
                "steps": ["Confirm scope", "Run checks", "Review evidence", "Approve shipment"]
            }),
            created_at: now.to_string(),
        },
        SeedArtifact {
            id: "artifact-receipt-local",
            kind: "receipt",
            version: "v1",
            title: "Local run receipts",
            project_id: "local-project",
            payload: json!({ "status": "empty", "summary": "No local run has completed yet." }),
            created_at: now.to_string(),
        },
    ]
}

fn artifact_block(sequence: i64, artifact: &SeedArtifact, summary: &str) -> Value {
    json!({
        "id": format!("block-artifact-{}", artifact.kind),
        "sequence": sequence,
        "createdAt": artifact.created_at,
        "type": "artifact",
        "artifact": {
            "kind": artifact.kind,
            "id": artifact.id,
            "version": artifact.version,
            "projectId": artifact.project_id,
            "title": artifact.title,
            "editorHref": format!("/local/{}/{}", artifact.kind, artifact.id),
            "createdAt": artifact.created_at,
        },
        "summary": summary,
    })
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

fn validate_runtime_label(value: &str, max_length: usize, label: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_length || value.chars().any(char::is_control) {
        return Err(format!("The local run {label} is invalid."));
    }
    Ok(())
}

fn validate_bot_goal(goal: &Value) -> Result<(), String> {
    let goal = goal
        .as_object()
        .ok_or_else(|| "The bot goal is invalid.".to_string())?;
    validate_identifier(
        goal.get("id").and_then(Value::as_str).unwrap_or_default(),
        "goal",
    )?;
    validate_runtime_label(
        goal.get("outcome")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        500,
        "goal outcome",
    )?;
    validate_runtime_label(
        goal.get("nextAction")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        500,
        "goal next action",
    )?;
    let criteria = goal
        .get("successCriteria")
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty() && values.len() <= 6)
        .ok_or_else(|| "A bot goal needs between one and six success criteria.".to_string())?;
    for criterion in criteria {
        validate_runtime_label(
            criterion.as_str().unwrap_or_default(),
            240,
            "goal success criterion",
        )?;
    }
    if !matches!(
        goal.get("status").and_then(Value::as_str),
        Some("active" | "completed" | "paused")
    ) {
        return Err("The bot goal status is invalid.".into());
    }
    validate_runtime_label(
        goal.get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        80,
        "goal creation time",
    )?;
    validate_runtime_label(
        goal.get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        80,
        "goal update time",
    )
}

fn validate_memory_safety(value: &str) -> Result<(), String> {
    let normalized = value.to_lowercase().replace(['_', '-'], " ");
    let markers = [
        "password",
        "passcode",
        "api key",
        "access token",
        "refresh token",
        "private key",
        "secret key",
        "seed phrase",
        "recovery phrase",
        "one time code",
        "verification code",
        "security code",
        "credit card",
        "card number",
        "social security",
        "-----begin",
    ];
    if markers.iter().any(|marker| normalized.contains(marker)) {
        return Err(
            "Codelit does not store passwords, tokens, payment details, recovery phrases, or one-time codes as memory."
                .into(),
        );
    }
    Ok(())
}

fn canonical_memory_time(value: &str, label: &str) -> Result<String, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| {
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(|_| format!("The memory {label} is invalid."))
}

fn canonical_bot_time(value: &str, label: &str) -> Result<String, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| {
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(|_| format!("The bot {label} is invalid."))
}

fn validate_memory_body(value: &Value) -> Result<(), String> {
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(kind, "preference" | "fact" | "procedure" | "decision") {
        return Err("A memory has an invalid type.".into());
    }
    let body = value
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default();
    validate_runtime_label(body, 1_000, "memory")?;
    validate_memory_safety(body)?;
    if !matches!(
        value.get("source").and_then(Value::as_str),
        Some("user" | "inferred")
    ) || value.get("sensitivity").and_then(Value::as_str) != Some("normal")
        || value.get("approvalState").and_then(Value::as_str) != Some("approved")
        || value
            .get("confidence")
            .and_then(Value::as_f64)
            .is_none_or(|confidence| !(0.0..=1.0).contains(&confidence))
    {
        return Err("A memory has invalid provenance or approval metadata.".into());
    }
    Ok(())
}

fn validate_memory_proposal_body(value: &Value) -> Result<(), String> {
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(kind, "preference" | "fact" | "procedure" | "decision") {
        return Err("A memory suggestion has an invalid type.".into());
    }
    let body = value
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default();
    validate_runtime_label(body, 280, "memory proposal")?;
    validate_memory_safety(body)?;
    if value.get("scope").and_then(Value::as_str) != Some("bot")
        || value.get("source").and_then(Value::as_str) != Some("inferred")
        || value.get("sensitivity").and_then(Value::as_str) != Some("normal")
        || value.get("approvalState").and_then(Value::as_str) != Some("pending")
        || value
            .get("confidence")
            .and_then(Value::as_f64)
            .is_none_or(|confidence| !(0.0..=1.0).contains(&confidence))
    {
        return Err("A memory suggestion has invalid provenance or review metadata.".into());
    }
    Ok(())
}

fn canonical_skill_time(value: &str, label: &str) -> Result<String, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| {
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(|_| format!("The skill {label} is invalid."))
}

fn validate_skill_safety(value: &str) -> Result<(), String> {
    validate_memory_safety(value).map_err(|_| {
        "Codelit does not store passwords, tokens, payment details, recovery phrases, or one-time codes in reusable skills."
            .to_string()
    })
}

fn validate_skill_capabilities(values: &[String]) -> Result<(), String> {
    if values.len() > 16 {
        return Err("A reusable skill can reference at most 16 capabilities.".into());
    }
    let mut unique = HashSet::new();
    for value in values {
        validate_identifier(value, "skill capability")?;
        if !unique.insert(value.as_str()) {
            return Err("A reusable skill contains duplicate capabilities.".into());
        }
    }
    Ok(())
}

fn validate_skill_permissions(values: &[String]) -> Result<(), String> {
    if values.len() > 16 {
        return Err("A reusable skill can require at most 16 permissions.".into());
    }
    let mut unique = HashSet::new();
    for value in values {
        validate_identifier(value, "skill permission")?;
        if !unique.insert(value.as_str()) {
            return Err("A reusable skill contains duplicate permissions.".into());
        }
    }
    Ok(())
}

fn validate_skill_fields(value: &Value, key: &str) -> Result<HashMap<String, String>, String> {
    let fields = value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("A reusable skill has an invalid {key}."))?;
    if fields.len() > 12 {
        return Err(format!("A reusable skill has too many {key} entries."));
    }
    let mut types = HashMap::new();
    for field in fields {
        let object = field
            .as_object()
            .ok_or_else(|| format!("A reusable skill has an invalid {key} entry."))?;
        if object.keys().any(|candidate| {
            !matches!(
                candidate.as_str(),
                "id" | "label" | "type" | "required" | "description" | "options"
            )
        }) {
            return Err(format!("A reusable skill has an unsupported {key} field."));
        }
        let id = object.get("id").and_then(Value::as_str).unwrap_or_default();
        let label = object
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let field_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        validate_identifier(id, "skill field")?;
        validate_runtime_label(label, 80, "skill field label")?;
        if !matches!(
            field_type,
            "text" | "url" | "number" | "boolean" | "date" | "choice"
        ) || !object.get("required").is_some_and(Value::is_boolean)
            || types
                .insert(id.to_string(), field_type.to_string())
                .is_some()
        {
            return Err(format!(
                "A reusable skill has an invalid or duplicate {key} field."
            ));
        }
        if let Some(description) = object.get("description") {
            let description = description
                .as_str()
                .ok_or_else(|| format!("A reusable skill has an invalid {key} description."))?;
            validate_runtime_label(description, 240, "skill field description")?;
            validate_skill_safety(description)?;
        }
        let options = object.get("options").and_then(Value::as_array);
        if field_type == "choice" {
            let options = options
                .ok_or_else(|| "A choice skill field needs a bounded options list.".to_string())?;
            if options.is_empty() || options.len() > 12 {
                return Err("A choice skill field has an invalid options list.".into());
            }
            let mut unique = HashSet::new();
            for option in options {
                let option = option
                    .as_str()
                    .ok_or_else(|| "A choice skill field has an invalid option.".to_string())?;
                validate_runtime_label(option, 80, "skill field option")?;
                if !unique.insert(option.to_lowercase()) {
                    return Err("A choice skill field contains duplicate options.".into());
                }
            }
        } else if options.is_some() {
            return Err("Only choice skill fields can declare options.".into());
        }
    }
    Ok(types)
}

fn validate_skill_effects(value: &Value, capabilities: &[String]) -> Result<(), String> {
    let effects = value
        .get("effects")
        .and_then(Value::as_array)
        .ok_or_else(|| "A reusable skill has invalid declared effects.".to_string())?;
    if effects.len() > 12 {
        return Err("A reusable skill declares too many effects.".into());
    }
    let mut ids = HashSet::new();
    for effect in effects {
        let object = effect
            .as_object()
            .ok_or_else(|| "A reusable skill has an invalid declared effect.".to_string())?;
        if object.keys().any(|candidate| {
            !matches!(
                candidate.as_str(),
                "id" | "label" | "kind" | "target" | "risk"
            )
        }) {
            return Err("A reusable skill has an unsupported effect field.".into());
        }
        let id = object.get("id").and_then(Value::as_str).unwrap_or_default();
        let label = object
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let target = object
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let risk = object
            .get("risk")
            .and_then(Value::as_str)
            .unwrap_or_default();
        validate_identifier(id, "skill effect")?;
        validate_runtime_label(label, 100, "skill effect label")?;
        validate_runtime_label(target, 160, "skill effect target")?;
        if !ids.insert(id)
            || !matches!(
                kind,
                "model-generate"
                    | "browser-read"
                    | "browser-write"
                    | "files-read"
                    | "files-write"
                    | "data-write"
                    | "notification-send"
                    | "computer-act"
            )
            || !matches!(risk, "local" | "read-only" | "write" | "sensitive")
        {
            return Err("A reusable skill has an invalid or duplicate declared effect.".into());
        }
        let risk_matches_effect = match kind {
            "model-generate" => risk == "local",
            "browser-read" | "files-read" => risk == "read-only",
            "browser-write" | "files-write" | "data-write" | "notification-send" => risk == "write",
            "computer-act" => matches!(risk, "write" | "sensitive"),
            _ => false,
        };
        if !risk_matches_effect {
            return Err("A reusable skill effect has an invalid risk classification.".into());
        }
        let required_capability = match kind {
            "model-generate" => "conversation",
            "browser-read" => "browser-read",
            "browser-write" => "browser-act",
            "files-read" => "project-read",
            "files-write" => "project-write",
            "data-write" => "local-data",
            "notification-send" => "notifications",
            "computer-act" => "computer-use",
            _ => unreachable!(),
        };
        if !capabilities
            .iter()
            .any(|capability| capability == required_capability)
        {
            return Err(format!(
                "The {kind} effect requires the {required_capability} capability."
            ));
        }
    }
    Ok(())
}

fn validate_skill_examples(value: &Value) -> Result<(), String> {
    let examples = value
        .get("examples")
        .and_then(Value::as_array)
        .ok_or_else(|| "A reusable skill has invalid examples.".to_string())?;
    if examples.len() > 6 {
        return Err("A reusable skill has too many examples.".into());
    }
    for example in examples {
        let object = example
            .as_object()
            .ok_or_else(|| "A reusable skill has an invalid example.".to_string())?;
        if object.len() != 1 || !object.contains_key("request") {
            return Err("A reusable skill example can contain only one request.".into());
        }
        let request = object
            .get("request")
            .and_then(Value::as_str)
            .unwrap_or_default();
        validate_runtime_label(request, 500, "skill example")?;
        validate_skill_safety(request)?;
    }
    Ok(())
}

fn validate_skill_checks(
    value: &Value,
    input_types: &HashMap<String, String>,
) -> Result<(), String> {
    let checks = value
        .get("checks")
        .and_then(Value::as_array)
        .ok_or_else(|| "A reusable skill has invalid checks.".to_string())?;
    if checks.len() > 12 {
        return Err("A reusable skill has too many checks.".into());
    }
    let mut ids = HashSet::new();
    for check in checks {
        let object = check
            .as_object()
            .ok_or_else(|| "A reusable skill has an invalid check.".to_string())?;
        if object.keys().any(|candidate| {
            !matches!(
                candidate.as_str(),
                "id" | "label" | "phase" | "rule" | "inputId"
            )
        }) {
            return Err("A reusable skill has an unsupported check field.".into());
        }
        let id = object.get("id").and_then(Value::as_str).unwrap_or_default();
        let label = object
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let phase = object
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let rule = object
            .get("rule")
            .and_then(Value::as_str)
            .unwrap_or_default();
        validate_identifier(id, "skill check")?;
        validate_runtime_label(label, 120, "skill check label")?;
        if !ids.insert(id)
            || !matches!(phase, "before" | "after")
            || !matches!(
                rule,
                "required" | "public-https" | "project-approved" | "output-present"
            )
            || (phase == "after" && rule != "output-present")
            || (phase == "before" && rule == "output-present")
        {
            return Err("A reusable skill has an invalid or duplicate check.".into());
        }
        let input_id = object.get("inputId").and_then(Value::as_str);
        if matches!(rule, "required" | "public-https") {
            let input_id = input_id.ok_or_else(|| {
                "An input skill check must reference a declared input.".to_string()
            })?;
            let Some(input_type) = input_types.get(input_id) else {
                return Err("A skill check references an undeclared input.".into());
            };
            if rule == "public-https" && input_type != "url" {
                return Err("A public HTTPS check must reference a URL input.".into());
            }
        } else if input_id.is_some() {
            return Err("That skill check cannot reference an input.".into());
        }
    }
    Ok(())
}

fn skill_checksum(name: &str, body_without_checksum: &Value) -> Result<String, String> {
    let canonical = json!({
        "name": name,
        "body": body_without_checksum,
    });
    let bytes = serde_json::to_vec(&canonical).map_err(error_text)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_skill_body(name: &str, value: &Value) -> Result<(), String> {
    validate_runtime_label(name, 64, "skill name")?;
    let schema_version = value
        .get("schemaVersion")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let source = value
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let trust_state = value
        .get("trustState")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let provenance_is_valid = match schema_version {
        1 => source == "taught" && trust_state == "reviewed",
        2 => {
            matches!(source, "built-in" | "taught" | "user-authored" | "imported")
                && matches!(trust_state, "packaged" | "reviewed" | "unreviewed")
                && (source == "built-in") == (trust_state == "packaged")
                && (trust_state != "unreviewed" || source == "imported")
        }
        _ => false,
    };
    if !provenance_is_valid {
        return Err("A reusable skill has invalid provenance or review metadata.".into());
    }
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let instructions = value
        .get("instructions")
        .and_then(Value::as_str)
        .unwrap_or_default();
    validate_runtime_label(description, 280, "skill description")?;
    validate_runtime_label(instructions, 4_000, "skill instructions")?;
    validate_skill_safety(instructions)?;
    let capabilities = value
        .get("capabilityIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "A reusable skill has invalid capabilities.".to_string())?
        .iter()
        .map(|value| value.as_str().unwrap_or_default().to_string())
        .collect::<Vec<_>>();
    validate_skill_capabilities(&capabilities)?;
    if schema_version == 2 {
        let input_types = validate_skill_fields(value, "inputSchema")?;
        validate_skill_fields(value, "outputSchema")?;
        let permissions = value
            .get("requiredPermissions")
            .and_then(Value::as_array)
            .ok_or_else(|| "A reusable skill has invalid required permissions.".to_string())?
            .iter()
            .map(|permission| permission.as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();
        validate_skill_permissions(&permissions)?;
        validate_skill_effects(value, &capabilities)?;
        validate_skill_examples(value)?;
        validate_skill_checks(value, &input_types)?;
    }
    let checksum = value
        .get("checksum")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("A reusable skill has an invalid checksum.".into());
    }
    let mut body_without_checksum = value.clone();
    body_without_checksum
        .as_object_mut()
        .ok_or_else(|| "A reusable skill body is invalid.".to_string())?
        .remove("checksum");
    if skill_checksum(name, &body_without_checksum)? != checksum {
        return Err("A reusable skill failed its content checksum.".into());
    }
    Ok(())
}

fn skill_record_from_body(
    id: String,
    version: i64,
    name: String,
    body: Value,
    created_at: String,
    updated_at: String,
) -> Result<LocalBotSkillRecord, String> {
    validate_skill_body(&name, &body)?;
    Ok(LocalBotSkillRecord {
        id,
        version,
        name,
        description: body
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        instructions: body
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        capability_ids: body
            .get("capabilityIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        input_schema: body
            .get("inputSchema")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        output_schema: body
            .get("outputSchema")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        required_permissions: body
            .get("requiredPermissions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        effects: body
            .get("effects")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        examples: body
            .get("examples")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        checks: body
            .get("checks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        source: body
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        trust_state: body
            .get("trustState")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        checksum: body
            .get("checksum")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        created_at,
        updated_at,
    })
}

fn approval_status_is_valid(status: &str) -> bool {
    matches!(status, "awaiting" | "approved" | "held" | "edit" | "denied")
}

fn bot_status_is_valid(status: &str) -> bool {
    matches!(
        status,
        "sleeping"
            | "watching"
            | "thinking"
            | "working"
            | "waiting"
            | "done"
            | "blocked"
            | "paused"
    )
}

fn bot_provider_id_is_valid(provider: &str) -> bool {
    matches!(
        provider,
        "codex"
            | "copilot"
            | "claude"
            | "antigravity"
            | "openai"
            | "anthropic"
            | "gemini"
            | "ollama"
            | "lmstudio"
            | "mlx"
    )
}

fn validate_artifact_file_name(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 180
        || path.file_name().and_then(|name| name.to_str()) != Some(value)
        || value == "."
        || value == ".."
    {
        return Err("Artifact file name is invalid.".into());
    }
    Ok(())
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
    use std::collections::BTreeSet;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;
    use tempfile::tempdir;

    fn avatar_png_data_url(width: u32, height: u32) -> String {
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10];
        bytes.extend_from_slice(&13_u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        format!("{BOT_AVATAR_PNG_PREFIX}{}", BASE64_STANDARD.encode(bytes))
    }

    #[test]
    fn seeds_every_artifact_kind_and_round_trips_thread_data() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let snapshot = bootstrap_local_workspace(&state).expect("snapshot");

        let kinds = snapshot
            .artifacts
            .iter()
            .map(|artifact| artifact.kind.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(kinds, ARTIFACT_KINDS.into_iter().collect());
        assert_eq!(snapshot.thread["id"], "local-welcome");
        assert_eq!(snapshot.blocks.len(), 4);

        let saved = append_thread_message(
            &state,
            AppendMessageRequest {
                thread_id: "local-welcome".into(),
                id: "message-round-trip".into(),
                sequence: 5,
                role: "user".into(),
                text: "Keep this entirely local.".into(),
                created_at: canonical_now(),
            },
        )
        .expect("message persisted");
        assert_eq!(
            saved.blocks.last().unwrap()["text"],
            "Keep this entirely local."
        );
        assert_eq!(saved.thread["latestBlockSequence"], 5);
        let assistant = append_thread_message(
            &state,
            AppendMessageRequest {
                thread_id: "local-welcome".into(),
                id: "assistant-round-trip".into(),
                sequence: 6,
                role: "assistant".into(),
                text: "Local provider response.".into(),
                created_at: canonical_now(),
            },
        )
        .expect("assistant message persisted");
        assert_eq!(
            assistant.blocks.last().unwrap()["type"],
            "assistant-message"
        );
    }

    #[test]
    fn bots_are_versioned_encrypted_and_keep_separate_threads() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let seeded = bootstrap_local_bots(&state).expect("starter bot");
        assert_eq!(seeded.bots.len(), 1);
        assert_eq!(seeded.active_bot.id, "bot-codelit");
        assert_eq!(seeded.workspace.thread["id"], "thread-bot-codelit");
        assert_eq!(seeded.active_bot.current_version, 1);
        assert!(
            seeded.active_bot.spec["capabilityIds"]
                .as_array()
                .is_some_and(|capabilities| capabilities.contains(&json!("browser-read")))
        );
        assert_eq!(
            seeded.active_bot.spec["permissionPolicy"]["approvalMode"],
            "ask"
        );
        assert_eq!(
            seeded.active_bot.spec["appearance"]["avatar"],
            json!({ "kind": "preset", "preset": "mountain" })
        );

        let created = create_local_bot(
            &state,
            CreateLocalBotRequest {
                id: "bot-repo-watch".into(),
                name: "Repo Watch Bot".into(),
                job: "Watch the approved repository and report meaningful changes.".into(),
                avatar: None,
                created_at: canonical_now(),
            },
        )
        .expect("second bot");
        assert_eq!(created.bots.len(), 2);
        assert_eq!(created.active_bot.id, "bot-repo-watch");
        assert_eq!(created.workspace.blocks.len(), 1);

        let second = append_thread_message(
            &state,
            AppendMessageRequest {
                thread_id: created.active_bot.thread_id.clone(),
                id: "message-repo-watch".into(),
                sequence: 2,
                role: "user".into(),
                text: "Inspect the repository safely.".into(),
                created_at: canonical_now(),
            },
        )
        .expect("second bot message");
        assert_eq!(second.blocks.len(), 2);

        let starter = set_active_local_bot(&state, "bot-codelit").expect("starter active");
        assert_eq!(starter.active_bot.id, "bot-codelit");
        assert_eq!(starter.workspace.blocks.len(), 1);
        let returned = set_active_local_bot(&state, "bot-repo-watch").expect("second active");
        assert_eq!(returned.workspace.blocks.len(), 2);
        assert_eq!(
            returned.workspace.blocks[1]["text"],
            "Inspect the repository safely."
        );

        let updated = update_local_bot_status(
            &state,
            UpdateLocalBotStatusRequest {
                id: "bot-repo-watch".into(),
                status: "working".into(),
                latest_status: "Inspecting the approved repository".into(),
                updated_at: canonical_now(),
            },
        )
        .expect("status updated");
        assert_eq!(updated.status, "working");

        let approval_updated = update_local_bot_approval_mode(
            &state,
            UpdateLocalBotApprovalModeRequest {
                id: "bot-repo-watch".into(),
                approval_mode: "safe-auto".into(),
                updated_at: canonical_now(),
            },
        )
        .expect("approval mode updated");
        assert_eq!(approval_updated.current_version, 2);
        assert_eq!(
            approval_updated.spec["permissionPolicy"]["approvalMode"],
            "safe-auto"
        );

        let connection = state.connection().expect("connection");
        let spec: String = connection
            .query_row(
                "SELECT spec_json FROM bot_versions WHERE bot_id = 'bot-repo-watch' AND version = 2",
                [],
                |row| row.get(0),
            )
            .expect("stored bot spec");
        let event: String = connection
            .query_row(
                "SELECT body_json FROM bot_events WHERE bot_id = 'bot-repo-watch' AND event_type = 'status.changed' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("stored bot event");
        let permission_event: String = connection
            .query_row(
                "SELECT body_json FROM bot_events WHERE bot_id = 'bot-repo-watch' AND event_type = 'permissions.changed' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("stored permission event");
        assert!(DataCipher::is_sealed(&spec));
        assert!(DataCipher::is_sealed(&event));
        assert!(DataCipher::is_sealed(&permission_event));
        assert!(!spec.contains("Watch the approved repository"));
        assert!(!spec.contains("safe-auto"));
        assert!(!event.contains("Inspecting the approved repository"));
        assert!(!permission_event.contains("safe-auto"));
        drop(connection);

        drop(state);
        let reopened = AppState::for_test(directory.path()).expect("reopened state");
        let persisted = bootstrap_local_bots(&reopened).expect("persisted bots");
        assert_eq!(persisted.bots.len(), 2);
        assert_eq!(persisted.active_bot.id, "bot-repo-watch");
        assert_eq!(persisted.active_bot.current_version, 2);
        assert_eq!(
            persisted.active_bot.spec["permissionPolicy"]["approvalMode"],
            "safe-auto"
        );
        assert_eq!(persisted.workspace.blocks.len(), 2);
    }

    #[test]
    fn selecting_a_bot_does_not_reorder_the_catalog() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        bootstrap_local_bots(&state).expect("starter bot");
        let created = create_local_bot(
            &state,
            CreateLocalBotRequest {
                id: "bot-sidebar-order".into(),
                name: "Sidebar Order Bot".into(),
                job: "Keep the sidebar stable when another bot is selected.".into(),
                avatar: None,
                created_at: "2026-08-20T12:00:00.000Z".into(),
            },
        )
        .expect("second bot");
        let before = created
            .bots
            .iter()
            .map(|bot| bot.id.clone())
            .collect::<Vec<_>>();

        let selected = set_active_local_bot(&state, "bot-codelit").expect("starter selected");
        let after = selected
            .bots
            .iter()
            .map(|bot| bot.id.clone())
            .collect::<Vec<_>>();

        assert_eq!(selected.active_bot.id, "bot-codelit");
        assert_eq!(after, before);
    }

    #[test]
    fn bot_browser_domains_are_versioned_encrypted_persistent_isolated_and_portable() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        for (id, name) in [
            ("bot-domain-alpha", "Domain Alpha"),
            ("bot-domain-beta", "Domain Beta"),
        ] {
            create_local_bot(
                &state,
                CreateLocalBotRequest {
                    id: id.into(),
                    name: name.into(),
                    job: "Inspect one approved website safely.".into(),
                    avatar: None,
                    created_at: canonical_now(),
                },
            )
            .expect("domain bot created");
        }

        let updated = update_local_bot_browser_domains(
            &state,
            UpdateLocalBotBrowserDomainsRequest {
                id: "bot-domain-alpha".into(),
                domains: vec!["Codelit.IO.".into(), "*.docs.example.com".into()],
                updated_at: canonical_now(),
                expected_version: Some(1),
            },
        )
        .expect("browser domains updated");
        assert_eq!(updated.current_version, 2);
        assert_eq!(
            updated.spec["permissionPolicy"]["browserDomains"],
            json!(["codelit.io", "*.docs.example.com"])
        );

        let stale = update_local_bot_browser_domains(
            &state,
            UpdateLocalBotBrowserDomainsRequest {
                id: "bot-domain-alpha".into(),
                domains: vec!["example.com".into()],
                updated_at: canonical_now(),
                expected_version: Some(1),
            },
        )
        .expect_err("stale domain update rejected");
        assert_eq!(
            stale,
            "That bot changed before this update. Review it and try again."
        );

        let bots = load_bots(&state).expect("bots reloaded");
        let peer = bots
            .iter()
            .find(|bot| bot.id == "bot-domain-beta")
            .expect("peer bot retained");
        assert_eq!(peer.spec["permissionPolicy"]["browserDomains"], json!([]));

        let connection = state.connection().expect("connection");
        let spec: String = connection
            .query_row(
                "SELECT spec_json FROM bot_versions WHERE bot_id = 'bot-domain-alpha' AND version = 2",
                [],
                |row| row.get(0),
            )
            .expect("stored bot domain spec");
        let event: String = connection
            .query_row(
                "SELECT body_json FROM bot_events WHERE bot_id = 'bot-domain-alpha' AND event_type = 'permissions.browser-domains.changed' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("stored bot domain event");
        assert!(DataCipher::is_sealed(&spec));
        assert!(DataCipher::is_sealed(&event));
        assert!(!spec.contains("codelit.io"));
        assert!(!event.contains("codelit.io"));
        drop(connection);
        drop(state);

        let reopened = AppState::for_test(directory.path()).expect("reopened state");
        let persisted = load_bots(&reopened)
            .expect("persisted bots")
            .into_iter()
            .find(|bot| bot.id == "bot-domain-alpha")
            .expect("persisted scoped bot");
        assert_eq!(
            persisted.spec["permissionPolicy"]["browserDomains"],
            json!(["codelit.io", "*.docs.example.com"])
        );

        let archive = export_workspace_archive(&reopened).expect("portable domain archive");
        let target_directory = tempdir().expect("restore directory");
        let target = AppState::with_key(target_directory.path().to_path_buf(), [91_u8; 32])
            .expect("restore state");
        restore_workspace_archive(&target, &archive, true).expect("domain archive restored");
        let restored = load_bots(&target)
            .expect("restored bots")
            .into_iter()
            .find(|bot| bot.id == "bot-domain-alpha")
            .expect("restored scoped bot");
        assert_eq!(
            restored.spec["permissionPolicy"]["browserDomains"],
            json!(["codelit.io", "*.docs.example.com"])
        );

        let mut tampered: WorkspaceArchive =
            serde_json::from_slice(&archive).expect("domain archive json");
        let version = tampered
            .bot_versions
            .iter_mut()
            .find(|row| row.bot_id == "bot-domain-alpha" && row.version == 2)
            .expect("scoped bot archive version");
        version.spec["permissionPolicy"]["browserDomains"] = json!(["https://example.com"]);
        assert_eq!(
            validate_archive(&tampered).expect_err("invalid domain backup rejected"),
            "A bot browser domain scope in the backup is invalid."
        );
    }

    #[test]
    fn conversation_teammates_are_bounded_persistent_and_scoped_to_the_owner() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        for (id, name) in [
            ("bot-group-research", "Researcher"),
            ("bot-group-review", "Reviewer"),
        ] {
            create_local_bot(
                &state,
                CreateLocalBotRequest {
                    id: id.into(),
                    name: name.into(),
                    job: format!("{name} handles one bounded specialist task."),
                    avatar: None,
                    created_at: "2026-08-19T18:00:00.000Z".into(),
                },
            )
            .expect("specialist bot");
        }

        let members = update_local_bot_group_members(
            &state,
            UpdateLocalBotGroupMembersRequest {
                owner_bot_id: "bot-codelit".into(),
                member_bot_ids: vec!["bot-group-research".into(), "bot-group-review".into()],
                updated_at: "2026-08-19T18:01:00.000Z".into(),
            },
        )
        .expect("members saved");
        assert_eq!(
            members
                .iter()
                .map(|member| member.id.as_str())
                .collect::<Vec<_>>(),
            vec!["bot-group-research", "bot-group-review"]
        );
        assert!(
            list_local_bot_group_members(&state, "bot-group-research")
                .expect("separate group")
                .is_empty()
        );
        let sealed_event: String = state
            .connection()
            .expect("connection")
            .query_row(
                "SELECT body_json FROM bot_events
                 WHERE bot_id = 'bot-codelit' AND event_type = 'team.changed'",
                [],
                |row| row.get(0),
            )
            .expect("encrypted team event");
        assert!(DataCipher::is_sealed(&sealed_event));
        assert!(!sealed_event.contains("bot-group-research"));

        let removed = update_local_bot_group_members(
            &state,
            UpdateLocalBotGroupMembersRequest {
                owner_bot_id: "bot-codelit".into(),
                member_bot_ids: vec!["bot-group-review".into()],
                updated_at: "2026-08-19T18:02:00.000Z".into(),
            },
        )
        .expect("member removed");
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].id, "bot-group-review");
        drop(state);

        let reopened = AppState::for_test(directory.path()).expect("reopened state");
        assert_eq!(
            list_local_bot_group_members(&reopened, "bot-codelit").expect("persisted group")[0].id,
            "bot-group-review"
        );
        assert!(
            update_local_bot_group_members(
                &reopened,
                UpdateLocalBotGroupMembersRequest {
                    owner_bot_id: "bot-codelit".into(),
                    member_bot_ids: vec![
                        "bot-group-research".into(),
                        "bot-group-review".into(),
                        "bot-extra".into(),
                    ],
                    updated_at: "2026-08-19T18:03:00.000Z".into(),
                },
            )
            .expect_err("group limit")
            .contains("one or two")
        );
    }

    #[test]
    fn bot_memories_are_encrypted_scoped_portable_and_cleared_atomically() {
        let source_directory = tempdir().expect("source directory");
        let state = AppState::with_key(source_directory.path().to_path_buf(), [31_u8; 32])
            .expect("source state");
        bootstrap_local_bots(&state).expect("starter bot");
        create_local_bot(
            &state,
            CreateLocalBotRequest {
                id: "bot-memory-peer".into(),
                name: "Memory Peer".into(),
                job: "Verify memory boundaries.".into(),
                avatar: None,
                created_at: "2026-08-19T16:00:00.000Z".into(),
            },
        )
        .expect("second bot");

        let save = |id: &str, actor_bot_id: &str, scope: &str, body: &str| {
            save_local_bot_memory(
                &state,
                SaveLocalBotMemoryRequest {
                    id: id.into(),
                    actor_bot_id: actor_bot_id.into(),
                    scope: scope.into(),
                    kind: "fact".into(),
                    body: body.into(),
                    expires_at: None,
                    created_at: "2026-08-19T16:01:00.000Z".into(),
                },
            )
            .expect("memory saved")
        };
        save(
            "memory-starter-private",
            "bot-codelit",
            "bot",
            "Staging uses the test workspace.",
        );
        save(
            "memory-workspace-shared",
            "bot-codelit",
            "workspace",
            "Release notes use concise headings.",
        );
        save(
            "memory-peer-private",
            "bot-memory-peer",
            "bot",
            "Peer-only context stays private.",
        );

        let starter = list_local_bot_memories(&state, "bot-codelit").expect("starter memories");
        assert_eq!(starter.len(), 2);
        assert!(
            starter
                .iter()
                .any(|memory| memory.id == "memory-starter-private")
        );
        assert!(
            starter
                .iter()
                .any(|memory| memory.id == "memory-workspace-shared")
        );
        assert!(
            !starter
                .iter()
                .any(|memory| memory.id == "memory-peer-private")
        );
        let peer = list_local_bot_memories(&state, "bot-memory-peer").expect("peer memories");
        assert_eq!(peer.len(), 2);
        assert!(peer.iter().any(|memory| memory.id == "memory-peer-private"));
        assert!(
            peer.iter()
                .any(|memory| memory.id == "memory-workspace-shared")
        );
        assert!(
            !peer
                .iter()
                .any(|memory| memory.id == "memory-starter-private")
        );

        let connection = state.connection().expect("connection");
        let encrypted_memories = connection
            .prepare("SELECT body_json FROM memories ORDER BY id")
            .expect("memory query")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("memory rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("encrypted memories");
        assert_eq!(encrypted_memories.len(), 3);
        assert!(
            encrypted_memories
                .iter()
                .all(|body| DataCipher::is_sealed(body))
        );
        assert!(
            encrypted_memories
                .iter()
                .all(|body| !body.contains("Staging uses the test workspace"))
        );
        let encrypted_events = connection
            .prepare("SELECT body_json FROM bot_events WHERE event_type = 'memory.created'")
            .expect("event query")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("event rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("encrypted events");
        assert_eq!(encrypted_events.len(), 3);
        assert!(
            encrypted_events
                .iter()
                .all(|body| DataCipher::is_sealed(body))
        );
        drop(connection);

        let secret_error = save_local_bot_memory(
            &state,
            SaveLocalBotMemoryRequest {
                id: "memory-secret".into(),
                actor_bot_id: "bot-codelit".into(),
                scope: "bot".into(),
                kind: "fact".into(),
                body: "The API key is hidden here.".into(),
                expires_at: None,
                created_at: "2026-08-19T16:02:00.000Z".into(),
            },
        )
        .expect_err("secret memory rejected");
        assert!(secret_error.contains("does not store"));
        let expiry_error = save_local_bot_memory(
            &state,
            SaveLocalBotMemoryRequest {
                id: "memory-invalid-expiry".into(),
                actor_bot_id: "bot-codelit".into(),
                scope: "bot".into(),
                kind: "fact".into(),
                body: "This value should not be stored.".into(),
                expires_at: Some("next Thursday".into()),
                created_at: "2026-08-19T16:02:00.000Z".into(),
            },
        )
        .expect_err("invalid expiry rejected");
        assert!(expiry_error.contains("expiry time"));
        let cross_bot_error = delete_local_bot_memory(
            &state,
            DeleteLocalBotMemoryRequest {
                id: "memory-starter-private".into(),
                actor_bot_id: "bot-memory-peer".into(),
                deleted_at: "2026-08-19T16:03:00.000Z".into(),
            },
        )
        .expect_err("cross-bot delete rejected");
        assert!(cross_bot_error.contains("available to this bot"));

        let archive = export_workspace_archive(&state).expect("portable archive");
        let decoded: WorkspaceArchive = serde_json::from_slice(&archive).expect("archive json");
        assert_eq!(decoded.memories.len(), 3);
        assert!(
            decoded
                .memories
                .iter()
                .any(|memory| memory.body["body"] == "Release notes use concise headings.")
        );
        let target_directory = tempdir().expect("target directory");
        let target = AppState::with_key(target_directory.path().to_path_buf(), [32_u8; 32])
            .expect("target state");
        restore_workspace_archive(&target, &archive, true).expect("memory archive restored");
        let restored =
            list_local_bot_memories(&target, "bot-memory-peer").expect("restored peer memories");
        assert_eq!(restored.len(), 2);
        assert!(
            restored
                .iter()
                .any(|memory| memory.body == "Peer-only context stays private.")
        );

        let deleted = clear_local_bot_memories(
            &state,
            ClearLocalBotMemoriesRequest {
                actor_bot_id: "bot-codelit".into(),
                include_shared: true,
                deleted_at: "2026-08-19T16:04:00.000Z".into(),
            },
        )
        .expect("memories cleared");
        assert_eq!(deleted, 2);
        assert!(
            list_local_bot_memories(&state, "bot-codelit")
                .expect("cleared starter memories")
                .is_empty()
        );
        let remaining =
            list_local_bot_memories(&state, "bot-memory-peer").expect("remaining peer memory");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "memory-peer-private");
        let connection = state.connection().expect("connection");
        let clear_event: String = connection
            .query_row(
                "SELECT body_json FROM bot_events WHERE event_type = 'memory.cleared'",
                [],
                |row| row.get(0),
            )
            .expect("clear event");
        assert!(DataCipher::is_sealed(&clear_event));
    }

    #[test]
    fn memory_proposals_require_review_and_preserve_run_provenance() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::with_key(directory.path().to_path_buf(), [35_u8; 32]).expect("state");
        let seeded = bootstrap_local_bots(&state).expect("starter bot");
        create_local_bot(
            &state,
            CreateLocalBotRequest {
                id: "bot-memory-reviewer".into(),
                name: "Memory Reviewer".into(),
                job: "Verify explicitly shared memory.".into(),
                avatar: None,
                created_at: "2026-08-19T18:00:00.000Z".into(),
            },
        )
        .expect("reviewer bot");
        state
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO runs (id, thread_id, artifact_id, status, created_at, updated_at)
                 VALUES ('run-memory-source', ?1, 'artifact-plan-ship-local', 'completed', ?2, ?2)",
                params![seeded.active_bot.thread_id, "2026-08-19T18:01:00.000Z"],
            )
            .expect("completed source run");

        let request = CreateLocalBotMemoryProposalRequest {
            id: "memory-proposal-concise".into(),
            actor_bot_id: "bot-codelit".into(),
            kind: "preference".into(),
            body: "I prefer concise release summaries".into(),
            source_run_id: "run-memory-source".into(),
            created_at: "2026-08-19T18:02:00.000Z".into(),
        };
        let proposal = create_local_bot_memory_proposal(&state, request)
            .expect("proposal created")
            .expect("new proposal");
        assert_eq!(proposal.approval_state, "pending");
        assert_eq!(proposal.source, "inferred");
        assert_eq!(proposal.source_run_id, "run-memory-source");
        assert!(
            list_local_bot_memories(&state, "bot-codelit")
                .expect("approved memories")
                .is_empty()
        );
        assert_eq!(
            list_local_bot_memory_proposals(&state, "bot-codelit")
                .expect("pending proposals")
                .len(),
            1
        );
        let encrypted_body: String = state
            .connection()
            .expect("connection")
            .query_row(
                "SELECT body_json FROM memory_proposals WHERE id = 'memory-proposal-concise'",
                [],
                |row| row.get(0),
            )
            .expect("encrypted proposal");
        assert!(DataCipher::is_sealed(&encrypted_body));
        assert!(!encrypted_body.contains("concise release summaries"));

        let duplicate = create_local_bot_memory_proposal(
            &state,
            CreateLocalBotMemoryProposalRequest {
                id: "memory-proposal-duplicate".into(),
                actor_bot_id: "bot-codelit".into(),
                kind: "preference".into(),
                body: "I prefer concise release summaries".into(),
                source_run_id: "run-memory-source".into(),
                created_at: "2026-08-19T18:03:00.000Z".into(),
            },
        )
        .expect("duplicate checked");
        assert!(duplicate.is_none());
        let cross_bot = create_local_bot_memory_proposal(
            &state,
            CreateLocalBotMemoryProposalRequest {
                id: "memory-proposal-cross-bot".into(),
                actor_bot_id: "bot-memory-reviewer".into(),
                kind: "fact".into(),
                body: "The release uses the staged workspace".into(),
                source_run_id: "run-memory-source".into(),
                created_at: "2026-08-19T18:03:00.000Z".into(),
            },
        )
        .expect_err("cross-bot source rejected");
        assert!(cross_bot.contains("completed run from this bot"));

        let invalid_expiry = review_local_bot_memory_proposal(
            &state,
            ReviewLocalBotMemoryProposalRequest {
                id: proposal.id.clone(),
                actor_bot_id: "bot-codelit".into(),
                decision: "approve".into(),
                scope: "workspace".into(),
                expires_at: Some("2026-08-19T18:03:00.000Z".into()),
                reviewed_at: "2026-08-19T18:04:00.000Z".into(),
            },
        )
        .expect_err("past expiry rejected");
        assert!(invalid_expiry.contains("future"));
        assert_eq!(
            list_local_bot_memory_proposals(&state, "bot-codelit")
                .expect("proposal retained")
                .len(),
            1
        );

        let approved = review_local_bot_memory_proposal(
            &state,
            ReviewLocalBotMemoryProposalRequest {
                id: proposal.id.clone(),
                actor_bot_id: "bot-codelit".into(),
                decision: "approve".into(),
                scope: "workspace".into(),
                expires_at: Some("2099-09-18T18:04:00.000Z".into()),
                reviewed_at: "2026-08-19T18:04:00.000Z".into(),
            },
        )
        .expect("proposal reviewed")
        .expect("proposal approved");
        assert_eq!(approved.scope, "workspace");
        assert_eq!(approved.source, "inferred");
        assert_eq!(approved.source_run_id.as_deref(), Some("run-memory-source"));
        assert_eq!(
            approved.expires_at.as_deref(),
            Some("2099-09-18T18:04:00.000Z")
        );
        assert!(
            list_local_bot_memory_proposals(&state, "bot-codelit")
                .expect("review queue")
                .is_empty()
        );
        assert!(
            list_local_bot_memories(&state, "bot-memory-reviewer")
                .expect("shared approved memory")
                .iter()
                .any(|memory| memory.id == approved.id)
        );
        assert!(
            review_local_bot_memory_proposal(
                &state,
                ReviewLocalBotMemoryProposalRequest {
                    id: proposal.id,
                    actor_bot_id: "bot-codelit".into(),
                    decision: "dismiss".into(),
                    scope: "bot".into(),
                    expires_at: None,
                    reviewed_at: "2026-08-19T18:05:00.000Z".into(),
                },
            )
            .expect_err("review cannot repeat")
            .contains("no longer waiting")
        );

        create_local_bot_memory_proposal(
            &state,
            CreateLocalBotMemoryProposalRequest {
                id: "memory-proposal-pending-clear".into(),
                actor_bot_id: "bot-codelit".into(),
                kind: "decision".into(),
                body: "We decided to publish on Tuesdays".into(),
                source_run_id: "run-memory-source".into(),
                created_at: "2026-08-19T18:05:30.000Z".into(),
            },
        )
        .expect("pending proposal created")
        .expect("new pending proposal");

        let cleared = clear_local_bot_memories(
            &state,
            ClearLocalBotMemoriesRequest {
                actor_bot_id: "bot-codelit".into(),
                include_shared: true,
                deleted_at: "2026-08-19T18:06:00.000Z".into(),
            },
        )
        .expect("approved memory erased");
        assert_eq!(cleared, 2);
        assert!(
            list_local_bot_memory_proposals(&state, "bot-codelit")
                .expect("pending proposal erased")
                .is_empty()
        );
        assert!(
            list_local_bot_memories(&state, "bot-memory-reviewer")
                .expect("shared memory erased")
                .is_empty()
        );
    }

    #[test]
    fn bot_skills_are_reviewed_versioned_encrypted_and_portable() {
        let source_directory = tempdir().expect("source directory");
        let state = AppState::with_key(source_directory.path().to_path_buf(), [33_u8; 32])
            .expect("source state");
        bootstrap_local_bots(&state).expect("starter bot");
        let created = save_local_bot_skill(
            &state,
            SaveLocalBotSkillRequest {
                id: "skill-release-check".into(),
                actor_bot_id: "bot-codelit".into(),
                name: "Release Check".into(),
                description: "Review release evidence.".into(),
                instructions: "Summarize the release evidence and name the riskiest gap.".into(),
                capability_ids: vec!["project-read".into()],
                input_schema: vec![],
                output_schema: vec![],
                required_permissions: vec![],
                effects: vec![],
                examples: vec![],
                checks: vec![],
                expected_version: None,
                created_at: "2026-08-19T17:00:00.000Z".into(),
            },
        )
        .expect("skill taught");
        assert_eq!(created.version, 1);
        assert_eq!(created.checksum.len(), 64);

        let updated = save_local_bot_skill(
            &state,
            SaveLocalBotSkillRequest {
                id: "skill-release-check".into(),
                actor_bot_id: "bot-codelit".into(),
                name: "Release Check".into(),
                description: "Review release evidence and rollback readiness.".into(),
                instructions:
                    "Summarize the evidence, name the riskiest gap, and require a rollback note."
                        .into(),
                capability_ids: vec!["project-read".into()],
                input_schema: vec![],
                output_schema: vec![],
                required_permissions: vec![],
                effects: vec![],
                examples: vec![],
                checks: vec![],
                expected_version: Some(1),
                created_at: "2026-08-19T17:01:00.000Z".into(),
            },
        )
        .expect("skill updated");
        assert_eq!(updated.version, 2);
        assert_ne!(updated.checksum, created.checksum);
        let stale_error = save_local_bot_skill(
            &state,
            SaveLocalBotSkillRequest {
                id: "skill-release-check".into(),
                actor_bot_id: "bot-codelit".into(),
                name: "Release Check".into(),
                description: "Stale update.".into(),
                instructions: "This stale update must not overwrite the reviewed version.".into(),
                capability_ids: vec![],
                input_schema: vec![],
                output_schema: vec![],
                required_permissions: vec![],
                effects: vec![],
                examples: vec![],
                checks: vec![],
                expected_version: Some(1),
                created_at: "2026-08-19T17:02:00.000Z".into(),
            },
        )
        .expect_err("stale update rejected");
        assert!(stale_error.contains("changed before"));

        let skills = list_local_bot_skills(&state).expect("listed skills");
        assert_eq!(skills.len(), 3);
        let taught = skills
            .iter()
            .find(|skill| skill.id == "skill-release-check")
            .expect("taught skill listed");
        assert_eq!(taught.version, 2);
        assert!(taught.instructions.contains("rollback note"));
        let connection = state.connection().expect("connection");
        let encrypted_versions = connection
            .prepare("SELECT body_json FROM skill_versions ORDER BY version")
            .expect("skill version query")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("skill version rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("encrypted skill versions");
        assert_eq!(encrypted_versions.len(), 4);
        assert!(
            encrypted_versions
                .iter()
                .all(|body| DataCipher::is_sealed(body))
        );
        assert!(
            encrypted_versions
                .iter()
                .all(|body| !body.contains("rollback note"))
        );
        let encrypted_event: String = connection
            .query_row(
                "SELECT body_json FROM bot_events WHERE event_type = 'skill.updated'",
                [],
                |row| row.get(0),
            )
            .expect("encrypted skill event");
        assert!(DataCipher::is_sealed(&encrypted_event));
        drop(connection);

        let secret_error = save_local_bot_skill(
            &state,
            SaveLocalBotSkillRequest {
                id: "skill-secret".into(),
                actor_bot_id: "bot-codelit".into(),
                name: "Secret Helper".into(),
                description: "Unsafe content.".into(),
                instructions: "Use the API key stored in this instruction.".into(),
                capability_ids: vec![],
                input_schema: vec![],
                output_schema: vec![],
                required_permissions: vec![],
                effects: vec![],
                examples: vec![],
                checks: vec![],
                expected_version: None,
                created_at: "2026-08-19T17:03:00.000Z".into(),
            },
        )
        .expect_err("secret skill rejected");
        assert!(secret_error.contains("reusable skills"));

        let archive = export_workspace_archive(&state).expect("portable skill archive");
        let mut decoded: WorkspaceArchive = serde_json::from_slice(&archive).expect("archive json");
        assert_eq!(decoded.skills.len(), 3);
        assert_eq!(decoded.skill_versions.len(), 4);
        let target_directory = tempdir().expect("target directory");
        let target = AppState::with_key(target_directory.path().to_path_buf(), [34_u8; 32])
            .expect("target state");
        restore_workspace_archive(&target, &archive, true).expect("skill archive restored");
        let restored = list_local_bot_skills(&target).expect("restored skills");
        assert_eq!(restored.len(), 3);
        let restored_taught = restored
            .iter()
            .find(|skill| skill.id == "skill-release-check")
            .expect("restored taught skill");
        assert_eq!(restored_taught.version, 2);
        assert_eq!(restored_taught.checksum, updated.checksum);

        decoded
            .skill_versions
            .iter_mut()
            .find(|version| version.skill_id == "skill-release-check" && version.version == 2)
            .expect("taught version in archive")
            .body["instructions"] = Value::String("Tampered after export.".into());
        let tamper_error = validate_archive(&decoded).expect_err("tampered skill rejected");
        assert!(tamper_error.contains("checksum"));

        let deleted = delete_local_bot_skill(
            &state,
            DeleteLocalBotSkillRequest {
                id: "skill-release-check".into(),
                actor_bot_id: "bot-codelit".into(),
                deleted_at: "2026-08-19T17:04:00.000Z".into(),
            },
        )
        .expect("skill deleted");
        assert_eq!(deleted.version, 2);
        let remaining = list_local_bot_skills(&state).expect("skills after delete");
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().all(|skill| skill.source == "built-in"));
    }

    #[test]
    fn packaged_and_imported_skills_are_typed_inert_and_explicitly_reviewed() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        bootstrap_local_bots(&state).expect("starter bot");
        let builtins = list_local_bot_skills(&state).expect("packaged skills");
        assert_eq!(builtins.len(), 2);
        assert!(builtins.iter().all(|skill| {
            skill.source == "built-in"
                && skill.trust_state == "packaged"
                && !skill.effects.is_empty()
                && !skill.checks.is_empty()
        }));
        let protected_error = delete_local_bot_skill(
            &state,
            DeleteLocalBotSkillRequest {
                id: builtins[0].id.clone(),
                actor_bot_id: "bot-codelit".into(),
                deleted_at: "2026-08-20T08:00:00.000Z".into(),
            },
        )
        .expect_err("packaged skill retained");
        assert!(protected_error.contains("stay available"));

        let package = json!({
            "id": "com-example-issue-brief",
            "version": 1,
            "name": "Issue brief",
            "description": "Turn one bounded issue into a concise local brief.",
            "instructions": "Use only the supplied issue text. Return the finding and one next action.",
            "capabilityIds": ["conversation"],
            "inputSchema": [{
                "id": "issue",
                "label": "Issue",
                "type": "text",
                "required": true,
                "description": "One bounded issue to review."
            }],
            "outputSchema": [{
                "id": "brief",
                "label": "Issue brief",
                "type": "text",
                "required": true
            }],
            "requiredPermissions": [],
            "effects": [{
                "id": "write-brief",
                "label": "Generate a local brief",
                "kind": "model-generate",
                "target": "conversation",
                "risk": "local"
            }],
            "examples": [{"request": "Run Issue brief with issue: Slow first launch"}],
            "checks": [
                {
                    "id": "issue-required",
                    "label": "Issue is present",
                    "phase": "before",
                    "rule": "required",
                    "inputId": "issue"
                },
                {
                    "id": "brief-present",
                    "label": "Issue brief is present",
                    "phase": "after",
                    "rule": "output-present"
                }
            ]
        });
        let package_bytes = serde_json::to_vec(&package).expect("package bytes");
        let imported = import_local_bot_skill_package(
            &state,
            "bot-codelit",
            &package_bytes,
            "2026-08-20T08:01:00.000Z",
        )
        .expect("skill imported");
        assert_eq!(imported.source, "imported");
        assert_eq!(imported.trust_state, "unreviewed");
        assert_eq!(imported.input_schema.len(), 1);
        assert_eq!(imported.effects.len(), 1);
        let encrypted: String = state
            .connection()
            .expect("connection")
            .query_row(
                "SELECT body_json FROM skill_versions WHERE skill_id = ?1",
                params![imported.id],
                |row| row.get(0),
            )
            .expect("encrypted imported package");
        assert!(DataCipher::is_sealed(&encrypted));
        assert!(!encrypted.contains("Slow first launch"));

        let approved = review_imported_bot_skill(
            &state,
            ReviewImportedBotSkillRequest {
                id: imported.id.clone(),
                actor_bot_id: "bot-codelit".into(),
                expected_version: imported.version,
                decision: "approve".into(),
                reviewed_at: "2026-08-20T08:02:00.000Z".into(),
            },
        )
        .expect("review succeeds")
        .expect("approved record");
        assert_eq!(approved.version, imported.version + 1);
        assert_eq!(approved.trust_state, "reviewed");
        assert_ne!(approved.checksum, imported.checksum);
        let second_review = review_imported_bot_skill(
            &state,
            ReviewImportedBotSkillRequest {
                id: imported.id,
                actor_bot_id: "bot-codelit".into(),
                expected_version: approved.version,
                decision: "approve".into(),
                reviewed_at: "2026-08-20T08:03:00.000Z".into(),
            },
        )
        .expect_err("review is one time");
        assert!(second_review.contains("unreviewed"));

        let mut scripted = package;
        scripted["name"] = Value::String("Scripted package".into());
        scripted["script"] = Value::String("arbitrary code".into());
        let scripted_error = import_local_bot_skill_package(
            &state,
            "bot-codelit",
            &serde_json::to_vec(&scripted).expect("scripted bytes"),
            "2026-08-20T08:04:00.000Z",
        )
        .expect_err("arbitrary package field rejected");
        assert!(scripted_error.contains("not a valid Codelit skill package"));
    }

    #[test]
    fn bot_goals_and_routines_are_validated_versioned_and_encrypted() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let seeded = bootstrap_local_bots(&state).expect("starter bot");
        assert_eq!(seeded.active_bot.spec["goal"]["status"], "active");
        assert_eq!(seeded.active_bot.spec["routineIds"], json!([]));

        let updated_at = "2026-08-19T15:00:00.000Z";
        let goal = json!({
            "id": "goal-release-proof",
            "outcome": "Keep the release evidence complete and reviewable.",
            "successCriteria": [
                "Every completed run has an inspectable receipt.",
                "External changes remain behind approval."
            ],
            "status": "active",
            "nextAction": "Inspect the latest local release receipt.",
            "createdAt": updated_at,
            "updatedAt": updated_at
        });
        let goal_updated = update_local_bot_goal(
            &state,
            UpdateLocalBotGoalRequest {
                id: "bot-codelit".into(),
                goal: goal.clone(),
                updated_at: updated_at.into(),
                expected_version: Some(1),
            },
        )
        .expect("goal updated");
        assert_eq!(goal_updated.current_version, 2);
        assert_eq!(goal_updated.spec["goal"], goal);

        let stale_goal = update_local_bot_goal(
            &state,
            UpdateLocalBotGoalRequest {
                id: "bot-codelit".into(),
                goal: goal.clone(),
                updated_at: "2026-08-19T15:00:30.000Z".into(),
                expected_version: Some(1),
            },
        )
        .expect_err("stale goal update rejected");
        assert_eq!(
            stale_goal,
            "That bot changed before this update. Review it and try again."
        );

        let routines_updated = update_local_bot_routines(
            &state,
            UpdateLocalBotRoutinesRequest {
                id: "bot-codelit".into(),
                routine_ids: vec!["routine-release-proof".into()],
                allow_background: true,
                updated_at: "2026-08-19T15:01:00.000Z".into(),
            },
        )
        .expect("routines updated");
        assert_eq!(routines_updated.current_version, 3);
        assert_eq!(
            routines_updated.spec["routineIds"],
            json!(["routine-release-proof"])
        );
        assert_eq!(
            routines_updated.spec["autonomyPolicy"]["mode"],
            "reviewed-routines"
        );
        assert_eq!(
            routines_updated.spec["autonomyPolicy"]["allowBackground"],
            true
        );

        let context = open_local_bot_context(&state, "bot-codelit").expect("bot context");
        assert_eq!(context.bot.current_version, 3);
        assert_eq!(context.workspace.thread["id"], "thread-bot-codelit");

        let invalid = update_local_bot_goal(
            &state,
            UpdateLocalBotGoalRequest {
                id: "bot-codelit".into(),
                goal: json!({ "id": "goal-invalid", "outcome": "" }),
                updated_at: "2026-08-19T15:02:00.000Z".into(),
                expected_version: None,
            },
        )
        .expect_err("invalid goal rejected");
        assert!(invalid.contains("goal outcome"));

        let connection = state.connection().expect("connection");
        let stored_spec: String = connection
            .query_row(
                "SELECT spec_json FROM bot_versions WHERE bot_id = 'bot-codelit' AND version = 3",
                [],
                |row| row.get(0),
            )
            .expect("stored bot spec");
        let goal_event: String = connection
            .query_row(
                "SELECT body_json FROM bot_events WHERE bot_id = 'bot-codelit' AND event_type = 'goal.changed' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("stored goal event");
        let routine_event: String = connection
            .query_row(
                "SELECT body_json FROM bot_events WHERE bot_id = 'bot-codelit' AND event_type = 'routines.changed' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("stored routine event");
        assert!(DataCipher::is_sealed(&stored_spec));
        assert!(DataCipher::is_sealed(&goal_event));
        assert!(DataCipher::is_sealed(&routine_event));
        assert!(!stored_spec.contains("routine-release-proof"));
        assert!(!goal_event.contains("release evidence"));
        assert!(!routine_event.contains("routine-release-proof"));
    }

    #[test]
    fn bot_profile_updates_name_avatar_thread_and_encrypted_identity_version_atomically() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let created = create_local_bot(
            &state,
            CreateLocalBotRequest {
                id: "bot-profile".into(),
                name: "Profile Bot".into(),
                job: "Keep one bounded identity.".into(),
                avatar: Some(BotAvatarSpec::Preset {
                    preset: BotAvatarPreset::Orbit,
                }),
                created_at: "2026-08-14T01:00:00.000Z".into(),
            },
        )
        .expect("profile bot created");
        assert_eq!(
            created.active_bot.spec["appearance"]["avatar"],
            json!({ "kind": "preset", "preset": "orbit" })
        );

        let image = avatar_png_data_url(256, 256);
        let updated = update_local_bot_profile(
            &state,
            UpdateLocalBotProfileRequest {
                id: "bot-profile".into(),
                name: "  Signal Scout  ".into(),
                avatar: Some(BotAvatarSpec::Image {
                    data_url: image.clone(),
                }),
                updated_at: "2026-08-14T01:01:00.000Z".into(),
            },
        )
        .expect("profile updated");
        assert_eq!(updated.current_version, 2);
        assert_eq!(updated.name, "Signal Scout");
        assert_eq!(updated.spec["name"], "Signal Scout");
        assert_eq!(updated.spec["appearance"]["avatar"]["kind"], "image");
        assert_eq!(updated.spec["appearance"]["avatar"]["dataUrl"], image);

        let renamed = update_local_bot_profile(
            &state,
            UpdateLocalBotProfileRequest {
                id: "bot-profile".into(),
                name: "Signal Scout Pro".into(),
                avatar: None,
                updated_at: "2026-08-14T01:02:00.000Z".into(),
            },
        )
        .expect("name-only profile update");
        assert_eq!(renamed.current_version, 3);
        assert_eq!(renamed.spec["appearance"]["avatar"]["dataUrl"], image);

        let snapshot = bootstrap_local_bots(&state).expect("updated bot snapshot");
        assert_eq!(snapshot.workspace.thread["title"], "Signal Scout Pro");
        assert_eq!(snapshot.active_bot.name, "Signal Scout Pro");
        let connection = state.connection().expect("connection");
        let (bot_name, thread_title, thread_body): (String, String, String) = connection
            .query_row(
                "SELECT b.name, t.title, t.body_json
                 FROM bots b JOIN threads t ON t.id = b.thread_id
                 WHERE b.id = 'bot-profile'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("profile rows");
        assert_eq!(bot_name, "Signal Scout Pro");
        assert_eq!(thread_title, "Signal Scout Pro");
        assert_eq!(
            open_json_body(
                &state.cipher,
                &thread_context("thread-bot-profile"),
                &thread_body,
            )
            .expect("decrypted thread")["title"],
            "Signal Scout Pro"
        );
        let original_spec: String = connection
            .query_row(
                "SELECT spec_json FROM bot_versions WHERE bot_id = 'bot-profile' AND version = 1",
                [],
                |row| row.get(0),
            )
            .expect("original spec");
        assert_eq!(
            open_json_body(
                &state.cipher,
                &bot_version_context("bot-profile", 1),
                &original_spec,
            )
            .expect("decrypted original spec")["name"],
            "Profile Bot"
        );
        let (event_id, event_body): (String, String) = connection
            .query_row(
                "SELECT id, body_json FROM bot_events
                 WHERE bot_id = 'bot-profile' AND event_type = 'identity.changed'
                 ORDER BY created_at DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("identity event");
        assert!(DataCipher::is_sealed(&event_body));
        let event = open_json_body(&state.cipher, &bot_event_context(&event_id), &event_body)
            .expect("decrypted identity event");
        assert_eq!(event["name"], "Signal Scout Pro");
        assert_eq!(event["avatar"]["kind"], "image");
        assert!(event["avatar"].get("dataUrl").is_none());
    }

    #[test]
    fn bot_engine_policy_is_versioned_encrypted_and_rejects_invalid_fixed_engines() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let seeded = bootstrap_local_bots(&state).expect("starter bot");
        assert_eq!(seeded.active_bot.current_version, 1);

        let updated = update_local_bot_engine_policy(
            &state,
            UpdateLocalBotEnginePolicyRequest {
                id: seeded.active_bot.id.clone(),
                mode: "fixed".into(),
                allowed_providers: vec!["codex".into(), "openai".into()],
                fixed_engine: Some(BotEngineSelectionRequest {
                    provider: "openai".into(),
                    model: "gpt-5.4-mini".into(),
                }),
                allow_metered_fallback: false,
                updated_at: canonical_now(),
            },
        )
        .expect("engine policy updated");
        assert_eq!(updated.current_version, 2);
        assert_eq!(updated.spec["enginePolicy"]["mode"], "fixed");
        assert_eq!(
            updated.spec["enginePolicy"]["fixedEngine"],
            json!({ "provider": "openai", "model": "gpt-5.4-mini" })
        );
        assert_eq!(updated.spec["enginePolicy"]["allowMeteredFallback"], false);

        let error = update_local_bot_engine_policy(
            &state,
            UpdateLocalBotEnginePolicyRequest {
                id: updated.id.clone(),
                mode: "fixed".into(),
                allowed_providers: vec!["codex".into()],
                fixed_engine: Some(BotEngineSelectionRequest {
                    provider: "openai".into(),
                    model: "gpt-5.4-mini".into(),
                }),
                allow_metered_fallback: false,
                updated_at: canonical_now(),
            },
        )
        .expect_err("fixed provider must be allowed");
        assert!(error.contains("selected bot intelligence engine"));

        let connection = state.connection().expect("connection");
        let encrypted_spec: String = connection
            .query_row(
                "SELECT spec_json FROM bot_versions WHERE bot_id = ?1 AND version = 2",
                params![updated.id],
                |row| row.get(0),
            )
            .expect("stored engine policy");
        let encrypted_event: String = connection
            .query_row(
                "SELECT body_json FROM bot_events WHERE bot_id = ?1 AND event_type = 'engine.changed'",
                params![updated.id],
                |row| row.get(0),
            )
            .expect("stored engine event");
        assert!(DataCipher::is_sealed(&encrypted_spec));
        assert!(DataCipher::is_sealed(&encrypted_event));
        assert!(!encrypted_spec.contains("gpt-5.4-mini"));
        assert!(!encrypted_event.contains("openai"));
        drop(connection);

        let reloaded = load_bot(&state, &updated.id)
            .expect("reload")
            .expect("bot exists");
        assert_eq!(reloaded.current_version, 2);
        assert_eq!(reloaded.spec["enginePolicy"]["mode"], "fixed");
    }

    #[test]
    fn bot_profile_rejects_malformed_or_oversized_pngs_without_advancing_identity() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        create_local_bot(
            &state,
            CreateLocalBotRequest {
                id: "bot-avatar-validation".into(),
                name: "Avatar Validation".into(),
                job: "Validate local avatars.".into(),
                avatar: None,
                created_at: canonical_now(),
            },
        )
        .expect("validation bot created");

        for data_url in [
            "data:image/jpeg;base64,AAAA".to_string(),
            "data:image/png;base64,%%%=".to_string(),
            avatar_png_data_url(255, 256),
            format!(
                "{BOT_AVATAR_PNG_PREFIX}{}",
                BASE64_STANDARD.encode(vec![0_u8; MAX_BOT_AVATAR_PNG_BYTES + 1])
            ),
        ] {
            let error = update_local_bot_profile(
                &state,
                UpdateLocalBotProfileRequest {
                    id: "bot-avatar-validation".into(),
                    name: "Should Not Persist".into(),
                    avatar: Some(BotAvatarSpec::Image { data_url }),
                    updated_at: canonical_now(),
                },
            )
            .expect_err("invalid avatar rejected");
            assert!(error.contains("avatar") || error.contains("Avatar"));
        }

        let bot = load_bot(&state, "bot-avatar-validation")
            .expect("bot reloaded")
            .expect("bot retained");
        assert_eq!(bot.current_version, 1);
        assert_eq!(bot.name, "Avatar Validation");
        let connection = state.connection().expect("connection");
        let event_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM bot_events
                 WHERE bot_id = 'bot-avatar-validation' AND event_type = 'identity.changed'",
                [],
                |row| row.get(0),
            )
            .expect("event count");
        assert_eq!(event_count, 0);
    }

    #[test]
    fn different_bot_profiles_update_concurrently_without_lost_identity_versions() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        for (id, name) in [
            ("bot-profile-alpha", "Profile Alpha"),
            ("bot-profile-beta", "Profile Beta"),
        ] {
            create_local_bot(
                &state,
                CreateLocalBotRequest {
                    id: id.into(),
                    name: name.into(),
                    job: format!("Keep {name} isolated."),
                    avatar: None,
                    created_at: canonical_now(),
                },
            )
            .expect("profile bot created");
        }

        let barrier = Arc::new(Barrier::new(2));
        let workers = [
            ("bot-profile-alpha", "Signal Alpha", BotAvatarPreset::Prism),
            ("bot-profile-beta", "Signal Beta", BotAvatarPreset::Wave),
        ]
        .into_iter()
        .map(|(id, name, preset)| {
            let state = state.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                update_local_bot_profile(
                    &state,
                    UpdateLocalBotProfileRequest {
                        id: id.into(),
                        name: name.into(),
                        avatar: Some(BotAvatarSpec::Preset { preset }),
                        updated_at: canonical_now(),
                    },
                )
            })
        })
        .collect::<Vec<_>>();
        for worker in workers {
            let updated = worker
                .join()
                .expect("profile worker did not panic")
                .expect("profile update committed");
            assert_eq!(updated.current_version, 2);
        }

        let bots = load_bots(&state).expect("profiles reloaded");
        for (id, name, preset) in [
            ("bot-profile-alpha", "Signal Alpha", "prism"),
            ("bot-profile-beta", "Signal Beta", "wave"),
        ] {
            let bot = bots
                .iter()
                .find(|candidate| candidate.id == id)
                .expect("profile retained");
            assert_eq!(bot.name, name);
            assert_eq!(bot.current_version, 2);
            assert_eq!(bot.spec["appearance"]["avatar"]["preset"], preset);
        }
    }

    #[test]
    fn different_bots_persist_runs_concurrently_without_crossing_threads() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        for (id, name) in [
            ("bot-parallel-alpha", "Parallel Alpha"),
            ("bot-parallel-beta", "Parallel Beta"),
        ] {
            create_local_bot(
                &state,
                CreateLocalBotRequest {
                    id: id.into(),
                    name: name.into(),
                    job: format!("Complete {name} work independently."),
                    avatar: None,
                    created_at: canonical_now(),
                },
            )
            .expect("parallel bot created");
        }

        let barrier = Arc::new(Barrier::new(2));
        let workers = [
            (
                "bot-parallel-alpha",
                "thread-bot-parallel-alpha",
                "run-parallel-alpha",
            ),
            (
                "bot-parallel-beta",
                "thread-bot-parallel-beta",
                "run-parallel-beta",
            ),
        ]
        .into_iter()
        .map(|(bot_id, thread_id, run_id)| {
            let state = state.clone();
            let barrier = barrier.clone();
            thread::spawn(move || -> Result<WorkspaceSnapshot, String> {
                barrier.wait();
                append_thread_message(
                    &state,
                    AppendMessageRequest {
                        thread_id: thread_id.into(),
                        id: format!("message-{run_id}"),
                        sequence: 2,
                        role: "user".into(),
                        text: format!("Run {bot_id} now."),
                        created_at: canonical_now(),
                    },
                )?;
                begin_local_run(
                    &state,
                    BeginLocalRunRequest {
                        thread_id: thread_id.into(),
                        artifact_id: "artifact-plan-ship-local".into(),
                        run_id: run_id.into(),
                        provider: "codex".into(),
                        model: "default".into(),
                        created_at: canonical_now(),
                    },
                )?;
                save_run_checkpoint(
                    &state,
                    SaveRunCheckpointRequest {
                        run_id: run_id.into(),
                        step_index: 1,
                        handoff: format!("{bot_id} context is ready"),
                        prior_steps: json!([{ "botId": bot_id }]),
                        gate_approved: true,
                        run_context: Some(json!({ "botId": bot_id })),
                        updated_at: canonical_now(),
                    },
                )?;
                record_run_approval(
                    &state,
                    RecordRunApprovalRequest {
                        id: format!("approval-{run_id}"),
                        run_id: run_id.into(),
                        step_index: 1,
                        status: "approved".into(),
                        body: json!({ "botId": bot_id, "scope": "read-only" }),
                        updated_at: canonical_now(),
                    },
                )?;
                record_local_check(
                    &state,
                    RecordLocalCheckRequest {
                        thread_id: thread_id.into(),
                        artifact_id: "artifact-plan-ship-local".into(),
                        run_id: run_id.into(),
                        created_at: canonical_now(),
                        provider: Some("codex".into()),
                        model: Some("default".into()),
                        status: Some("completed".into()),
                        summary: Some(format!("{bot_id} completed independently.")),
                        receipt_details: Some(json!({ "botId": bot_id })),
                        selection_mode: "fixed".into(),
                        metered_fallback_authorized: false,
                        metered_provider_invocation_started: false,
                        billing_fallback: false,
                        events: Vec::new(),
                    },
                )
            })
        })
        .collect::<Vec<_>>();

        for (worker, (expected_thread, expected_run)) in workers.into_iter().zip([
            ("thread-bot-parallel-alpha", "run-parallel-alpha"),
            ("thread-bot-parallel-beta", "run-parallel-beta"),
        ]) {
            let snapshot = worker
                .join()
                .expect("parallel bot worker did not panic")
                .expect("parallel bot run persisted");
            assert_eq!(snapshot.thread["id"], expected_thread);
            assert_eq!(snapshot.blocks.len(), 4);
            assert_eq!(snapshot.run_checkpoints.len(), 1);
            assert_eq!(snapshot.run_checkpoints[0].run_id, expected_run);
            assert_eq!(snapshot.approvals.len(), 1);
            assert_eq!(snapshot.approvals[0].run_id, expected_run);
            assert_eq!(snapshot.receipts.len(), 1);
            assert_eq!(snapshot.receipts[0].run_id, expected_run);
            assert!(
                snapshot
                    .run_events
                    .iter()
                    .all(|event| event.run_id == expected_run)
            );
        }

        let bots = load_bots(&state).expect("parallel bots reloaded");
        for bot_id in ["bot-parallel-alpha", "bot-parallel-beta"] {
            let bot = bots
                .iter()
                .find(|candidate| candidate.id == bot_id)
                .expect("parallel bot retained");
            assert_eq!(bot.status, "done");
        }
    }

    #[test]
    fn existing_bot_specs_gain_browser_read_as_a_new_encrypted_version() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let connection = state.connection().expect("connection");
        let stored: String = connection
            .query_row(
                "SELECT spec_json FROM bot_versions WHERE bot_id = 'bot-codelit' AND version = 1",
                [],
                |row| row.get(0),
            )
            .expect("starter spec");
        let mut legacy = open_json_body(
            state.cipher(),
            &bot_version_context("bot-codelit", 1),
            &stored,
        )
        .expect("opened spec");
        legacy["capabilityIds"] = json!(["conversation", "project-read"]);
        legacy["permissionPolicy"]
            .as_object_mut()
            .expect("permission policy")
            .remove("approvalMode");
        legacy["permissionPolicy"]
            .as_object_mut()
            .expect("permission policy")
            .remove("browserDomains");
        let sealed = state
            .cipher()
            .seal(&bot_version_context("bot-codelit", 1), &legacy.to_string())
            .expect("legacy spec sealed");
        connection
            .execute(
                "UPDATE bot_versions SET spec_json = ?1 WHERE bot_id = 'bot-codelit' AND version = 1",
                params![sealed],
            )
            .expect("legacy spec stored");
        drop(connection);
        drop(state);

        let reopened = AppState::for_test(directory.path()).expect("reopened state");
        let upgraded = bootstrap_local_bots(&reopened).expect("upgraded bot");
        assert_eq!(upgraded.active_bot.current_version, 2);
        assert!(
            upgraded.active_bot.spec["capabilityIds"]
                .as_array()
                .is_some_and(|capabilities| capabilities.contains(&json!("browser-read")))
        );
        assert_eq!(
            upgraded.active_bot.spec["permissionPolicy"]["approvalMode"],
            "ask"
        );
        assert_eq!(
            upgraded.active_bot.spec["permissionPolicy"]["browserDomains"],
            json!([])
        );
        let connection = reopened.connection().expect("connection");
        let upgraded_body: String = connection
            .query_row(
                "SELECT spec_json FROM bot_versions WHERE bot_id = 'bot-codelit' AND version = 2",
                [],
                |row| row.get(0),
            )
            .expect("upgraded spec");
        assert!(DataCipher::is_sealed(&upgraded_body));
    }

    #[test]
    fn existing_browser_bots_gain_the_default_approval_mode() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let connection = state.connection().expect("connection");
        let stored: String = connection
            .query_row(
                "SELECT spec_json FROM bot_versions WHERE bot_id = 'bot-codelit' AND version = 1",
                [],
                |row| row.get(0),
            )
            .expect("starter spec");
        let mut legacy = open_json_body(
            state.cipher(),
            &bot_version_context("bot-codelit", 1),
            &stored,
        )
        .expect("opened spec");
        legacy["permissionPolicy"]
            .as_object_mut()
            .expect("permission policy")
            .remove("approvalMode");
        let sealed = state
            .cipher()
            .seal(&bot_version_context("bot-codelit", 1), &legacy.to_string())
            .expect("legacy spec sealed");
        connection
            .execute(
                "UPDATE bot_versions SET spec_json = ?1 WHERE bot_id = 'bot-codelit' AND version = 1",
                params![sealed],
            )
            .expect("legacy spec stored");
        drop(connection);
        drop(state);

        let reopened = AppState::for_test(directory.path()).expect("reopened state");
        let upgraded = bootstrap_local_bots(&reopened).expect("upgraded bot");
        assert_eq!(upgraded.active_bot.current_version, 2);
        assert_eq!(
            upgraded.active_bot.spec["permissionPolicy"]["approvalMode"],
            "ask"
        );
        assert!(
            upgraded.active_bot.spec["capabilityIds"]
                .as_array()
                .is_some_and(|capabilities| capabilities.contains(&json!("browser-read")))
        );
    }

    #[test]
    fn portable_archive_restores_bot_specs_and_threads_under_a_new_key() {
        let source_directory = tempdir().expect("source directory");
        let source = AppState::with_key(source_directory.path().to_path_buf(), [17_u8; 32])
            .expect("source state");
        create_local_bot(
            &source,
            CreateLocalBotRequest {
                id: "bot-research".into(),
                name: "Research Bot".into(),
                job: "Maintain a local evidence table for one research question.".into(),
                avatar: Some(BotAvatarSpec::Image {
                    data_url: avatar_png_data_url(256, 256),
                }),
                created_at: canonical_now(),
            },
        )
        .expect("research bot");
        let archive = export_workspace_archive(&source).expect("bot archive");
        let decoded: WorkspaceArchive = serde_json::from_slice(&archive).expect("archive json");
        assert_eq!(decoded.manifest.version, ARCHIVE_VERSION);
        assert_eq!(decoded.bots.len(), 2);
        assert!(decoded.bot_versions.len() >= 2);

        let target_directory = tempdir().expect("target directory");
        let target = AppState::with_key(target_directory.path().to_path_buf(), [71_u8; 32])
            .expect("target state");
        let stale_quarantine = target.app_data_dir().join("browser-quarantine/stale");
        fs::create_dir_all(&stale_quarantine).expect("stale quarantine directory");
        fs::write(stale_quarantine.join("payload"), b"stale bytes")
            .expect("stale quarantine payload");
        restore_workspace_archive(&target, &archive, true).expect("restored workspace");
        assert!(!target.app_data_dir().join("browser-quarantine").exists());
        let restored = bootstrap_local_bots(&target).expect("restored bots");
        assert_eq!(restored.bots.len(), 2);
        let research = restored
            .bots
            .iter()
            .find(|bot| bot.id == "bot-research")
            .expect("research bot restored");
        assert_eq!(
            research.spec["job"],
            "Maintain a local evidence table for one research question."
        );
        assert_eq!(research.spec["appearance"]["avatar"]["kind"], "image");
        validate_bot_spec_appearance(&research.spec).expect("restored avatar remains valid");

        let connection = target.connection().expect("target connection");
        let ciphertext: String = connection
            .query_row(
                "SELECT spec_json FROM bot_versions WHERE bot_id = 'bot-research' AND version = 1",
                [],
                |row| row.get(0),
            )
            .expect("restored ciphertext");
        assert!(DataCipher::is_sealed(&ciphertext));
        assert!(!ciphertext.contains("evidence table"));
    }

    #[test]
    fn portable_archive_round_trips_bot_tables_under_a_new_key_and_erases_them() {
        let source_directory = tempdir().expect("source directory");
        let source = AppState::with_key(source_directory.path().to_path_buf(), [23_u8; 32])
            .expect("source state");
        crate::bot_data::create_local_bot_table(
            &source,
            crate::bot_data::CreateLocalBotTableRequest {
                id: "table-observations".into(),
                bot_id: "bot-codelit".into(),
                name: "Page observations".into(),
                columns: vec![
                    crate::bot_data::BotDataColumn {
                        name: "URL".into(),
                        r#type: "url".into(),
                    },
                    crate::bot_data::BotDataColumn {
                        name: "Summary".into(),
                        r#type: "text".into(),
                    },
                ],
                created_at: "2026-08-19T13:00:00.000Z".into(),
            },
        )
        .expect("local table");
        crate::bot_data::append_local_bot_table_row(
            &source,
            crate::bot_data::AppendLocalBotTableRowRequest {
                id: "row-pricing".into(),
                bot_id: "bot-codelit".into(),
                table_id: "table-observations".into(),
                values: serde_json::from_value(json!({
                    "URL": "https://codelit.io/pricing",
                    "Summary": "Pricing changed"
                }))
                .expect("row values"),
                created_at: "2026-08-19T13:01:00.000Z".into(),
            },
        )
        .expect("local row");

        let bytes = export_workspace_archive(&source).expect("portable archive");
        let decoded: WorkspaceArchive = serde_json::from_slice(&bytes).expect("archive JSON");
        assert_eq!(decoded.manifest.version, ARCHIVE_VERSION);
        assert_eq!(decoded.bot_databases.len(), 1);
        assert_eq!(decoded.bot_database_rows.len(), 1);
        let mut invalid_identity: WorkspaceArchive =
            serde_json::from_slice(&bytes).expect("invalid identity archive");
        invalid_identity.bot_databases[0].id = "bot-database:other-bot".into();
        assert!(validate_archive(&invalid_identity).is_err());
        let mut hidden_payload: WorkspaceArchive =
            serde_json::from_slice(&bytes).expect("hidden payload archive");
        hidden_payload.bot_database_rows[0].body["hidden"] = json!("not declared by the schema");
        assert!(validate_archive(&hidden_payload).is_err());

        let target_directory = tempdir().expect("target directory");
        let target = AppState::with_key(target_directory.path().to_path_buf(), [79_u8; 32])
            .expect("target state");
        restore_workspace_archive(&target, &bytes, true).expect("restored workspace");
        let restored = crate::bot_data::open_local_bot_table(
            &target,
            "bot-codelit",
            "table-observations",
            200,
        )
        .expect("restored table");
        assert_eq!(restored.table.name, "Page observations");
        assert_eq!(restored.rows[0].values["Summary"], "Pricing changed");

        let target_ciphertext: String = target
            .connection()
            .expect("target connection")
            .query_row(
                "SELECT schema_json FROM bot_databases WHERE bot_id = 'bot-codelit'",
                [],
                |row| row.get(0),
            )
            .expect("restored ciphertext");
        assert!(DataCipher::is_sealed(&target_ciphertext));
        assert!(
            source
                .cipher
                .open(
                    "bot-databases:bot-database:bot-codelit:schema",
                    &target_ciphertext,
                )
                .is_err()
        );

        remove_local_data_files(&target).expect("removed local data");
        initialize_empty_workspace(&target, [97_u8; 32]).expect("fresh workspace");
        assert!(
            crate::bot_data::list_local_bot_tables(&target, "bot-codelit")
                .expect("tables after erase")
                .is_empty()
        );
    }

    #[test]
    fn interrupted_bot_run_recovers_without_leaking_history_to_other_bots() {
        let directory = tempdir().expect("temporary directory");
        {
            let state = AppState::for_test(directory.path()).expect("state");
            let created = create_local_bot(
                &state,
                CreateLocalBotRequest {
                    id: "bot-project-review".into(),
                    name: "Project Review Bot".into(),
                    job: "Review one approved project without changing it.".into(),
                    avatar: None,
                    created_at: canonical_now(),
                },
            )
            .expect("review bot");
            update_local_bot_status(
                &state,
                UpdateLocalBotStatusRequest {
                    id: created.active_bot.id.clone(),
                    status: "working".into(),
                    latest_status: "Inspecting the approved project".into(),
                    updated_at: canonical_now(),
                },
            )
            .expect("working status");
            begin_local_run(
                &state,
                BeginLocalRunRequest {
                    thread_id: created.active_bot.thread_id,
                    artifact_id: "artifact-plan-ship-local".into(),
                    run_id: "run-interrupted-bot".into(),
                    provider: "mlx".into(),
                    model: "local".into(),
                    created_at: canonical_now(),
                },
            )
            .expect("run started");

            let starter = set_active_local_bot(&state, "bot-codelit").expect("starter active");
            assert!(starter.workspace.run_events.is_empty());
            set_active_local_bot(&state, "bot-project-review").expect("review bot active");
        }

        let reopened = AppState::for_test(directory.path()).expect("reopened state");
        let recovered = bootstrap_local_bots(&reopened).expect("recovered bot catalog");
        assert_eq!(recovered.active_bot.id, "bot-project-review");
        assert_eq!(recovered.active_bot.status, "blocked");
        assert!(recovered.active_bot.latest_status.contains("interrupted"));
        assert_eq!(recovered.workspace.run_events.len(), 2);
        assert_eq!(
            recovered
                .workspace
                .run_events
                .last()
                .expect("recovery event")
                .event_type,
            "run.interrupted"
        );

        let starter = set_active_local_bot(&reopened, "bot-codelit").expect("starter active");
        assert!(starter.workspace.run_events.is_empty());
        assert!(starter.workspace.receipts.is_empty());
    }

    #[test]
    fn mcp_registry_encrypts_device_specific_configuration() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let saved = save_mcp_server(
            &state,
            SaveMcpServerRecord {
                id: "mcp-local-issues".into(),
                name: "Local issues".into(),
                transport: "stdio".into(),
                enabled: true,
                fingerprint: "a".repeat(64),
                config: json!({ "commandPath": "/usr/local/bin/issues-mcp", "arguments": [] }),
                catalog: json!({ "protocolVersion": "2025-11-25", "tools": [{ "name": "issues.read", "approved": true }] }),
            },
        )
        .expect("MCP server saved");
        assert_eq!(saved.catalog["tools"][0]["name"], "issues.read");

        let connection = state.connection().expect("connection");
        let (config, catalog): (String, String) = connection
            .query_row(
                "SELECT config_json, catalog_json FROM local_mcp_servers WHERE id = ?1",
                params!["mcp-local-issues"],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("encrypted MCP row");
        assert!(DataCipher::is_sealed(&config));
        assert!(DataCipher::is_sealed(&catalog));
        assert!(!config.contains("issues-mcp"));
        drop(connection);

        delete_mcp_server(&state, "mcp-local-issues").expect("MCP server deleted");
        assert!(load_mcp_servers(&state).expect("MCP list").is_empty());
    }

    #[test]
    fn offline_workbench_edits_survive_reopen_and_restore() {
        let directory = tempdir().expect("temporary directory");
        let source =
            AppState::with_key(directory.path().to_path_buf(), [31_u8; 32]).expect("source state");
        let edits = [
            (
                "artifact-product-local",
                "product-plan",
                "Product offline edit",
                json!({ "problem": "offline product" }),
            ),
            (
                "artifact-architecture-local",
                "architecture",
                "Architecture offline edit",
                json!({ "summary": "offline architecture" }),
            ),
            (
                "artifact-agent-local",
                "agent-team",
                "Agent Team offline edit",
                json!({ "goal": "offline agents" }),
            ),
        ];
        for (index, (artifact_id, kind, title, payload)) in edits.iter().enumerate() {
            save_artifact_version(
                &source,
                SaveArtifactRequest {
                    thread_id: "local-welcome".into(),
                    artifact_id: (*artifact_id).into(),
                    kind: (*kind).into(),
                    version: format!("v-offline-{index}"),
                    title: (*title).into(),
                    project_id: "local-project".into(),
                    payload: payload.clone(),
                    created_at: canonical_now(),
                },
            )
            .expect("offline artifact edit");
        }
        drop(source);

        let reopened = AppState::with_key(directory.path().to_path_buf(), [31_u8; 32])
            .expect("reopened state");
        let reopened_snapshot = load_snapshot(&reopened).expect("reopened snapshot");
        for (artifact_id, _, title, payload) in edits {
            let artifact = reopened_snapshot
                .artifacts
                .iter()
                .find(|artifact| artifact.artifact_id == artifact_id)
                .expect("reopened artifact");
            assert_eq!(artifact.title, title);
            assert_eq!(artifact.payload, payload);
        }

        let archive = export_workspace_archive(&reopened).expect("portable archive");
        let restored_directory = tempdir().expect("restored directory");
        let restored = AppState::with_key(restored_directory.path().to_path_buf(), [73_u8; 32])
            .expect("restored state");
        let restored_snapshot =
            restore_workspace_archive(&restored, &archive, true).expect("restored snapshot");
        for title in [
            "Product offline edit",
            "Architecture offline edit",
            "Agent Team offline edit",
        ] {
            assert!(
                restored_snapshot
                    .artifacts
                    .iter()
                    .any(|artifact| artifact.title == title)
            );
        }
    }

    #[test]
    fn writes_run_event_stream_and_receipt_atomically() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let snapshot = record_local_check(
            &state,
            RecordLocalCheckRequest {
                thread_id: "local-welcome".into(),
                artifact_id: "artifact-agent-local".into(),
                run_id: "run-native-test".into(),
                created_at: canonical_now(),
                provider: Some("openai".into()),
                model: Some("gpt-5.6-terra".into()),
                status: Some("completed".into()),
                summary: Some("Provider completed locally.".into()),
                receipt_details: Some(json!({ "transcript": { "status": "completed" } })),
                selection_mode: "auto".into(),
                metered_fallback_authorized: true,
                metered_provider_invocation_started: true,
                billing_fallback: true,
                events: vec![
                    RecordedProviderEvent {
                        sequence: 1,
                        event_type: "queued".into(),
                        message: "Queued".into(),
                        payload: None,
                        created_at: canonical_now(),
                    },
                    RecordedProviderEvent {
                        sequence: 2,
                        event_type: "completed".into(),
                        message: "Done".into(),
                        payload: Some(json!({"summary": "Provider completed locally."})),
                        created_at: canonical_now(),
                    },
                ],
            },
        )
        .expect("run persisted");

        assert_eq!(snapshot.run_events.len(), 2);
        assert_eq!(snapshot.run_events[1].event_type, "run.completed");
        assert_eq!(snapshot.receipts.len(), 1);
        assert_eq!(snapshot.receipts[0].run_id, "run-native-test");
        assert_eq!(snapshot.receipts[0].body["provider"], "openai");
        assert_eq!(snapshot.receipts[0].body["selectionMode"], "auto");
        assert_eq!(snapshot.receipts[0].body["meteredFallbackAuthorized"], true);
        assert_eq!(
            snapshot.receipts[0].body["meteredProviderInvocationStarted"],
            true
        );
        assert_eq!(snapshot.receipts[0].body["billingFallback"], true);
        assert_eq!(
            snapshot.receipts[0].body["details"]["transcript"]["status"],
            "completed"
        );
        assert_eq!(snapshot.thread["latestBlockSequence"], 6);
    }

    #[test]
    fn records_authorized_metered_fallback_without_claiming_an_invocation() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let snapshot = record_local_check(
            &state,
            RecordLocalCheckRequest {
                thread_id: "local-welcome".into(),
                artifact_id: "artifact-agent-local".into(),
                run_id: "run-held-metered".into(),
                created_at: canonical_now(),
                provider: Some("openai".into()),
                model: Some("gpt-5.6-terra".into()),
                status: Some("canceled".into()),
                summary: Some("Website access was held before provider execution.".into()),
                receipt_details: None,
                selection_mode: "auto".into(),
                metered_fallback_authorized: true,
                metered_provider_invocation_started: false,
                billing_fallback: false,
                events: Vec::new(),
            },
        )
        .expect("held run persisted");

        let receipt = &snapshot.receipts[0];
        assert_eq!(receipt.body["meteredFallbackAuthorized"], true);
        assert_eq!(receipt.body["meteredProviderInvocationStarted"], false);
        assert_eq!(receipt.body["billingFallback"], false);
        let receipt_block = snapshot
            .blocks
            .iter()
            .find(|block| block["type"] == "receipt")
            .expect("receipt block");
        assert!(
            receipt_block["summary"]
                .as_str()
                .expect("receipt summary")
                .contains("authorized but no metered provider invocation started")
        );
    }

    #[test]
    fn rejects_missing_or_inconsistent_provider_billing_provenance() {
        let missing = json!({
            "threadId": "local-welcome",
            "artifactId": "artifact-agent-local",
            "runId": "run-missing-provenance",
            "createdAt": canonical_now(),
            "selectionMode": "auto",
            "billingFallback": false
        });
        assert!(serde_json::from_value::<RecordLocalCheckRequest>(missing).is_err());

        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let error = record_local_check(
            &state,
            RecordLocalCheckRequest {
                thread_id: "local-welcome".into(),
                artifact_id: "artifact-agent-local".into(),
                run_id: "run-invalid-provenance".into(),
                created_at: canonical_now(),
                provider: Some("openai".into()),
                model: Some("gpt-5.6-terra".into()),
                status: Some("failed".into()),
                summary: Some("Invalid provenance must not be recorded.".into()),
                receipt_details: None,
                selection_mode: "auto".into(),
                metered_fallback_authorized: true,
                metered_provider_invocation_started: true,
                billing_fallback: false,
                events: Vec::new(),
            },
        )
        .expect_err("inconsistent provenance rejected");
        assert_eq!(
            error,
            "The local run receipt billing provenance is invalid."
        );
    }

    #[test]
    fn checkpoints_and_approvals_are_encrypted_exported_and_restored() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        begin_local_run(
            &state,
            BeginLocalRunRequest {
                thread_id: "local-welcome".into(),
                artifact_id: "artifact-agent-local".into(),
                run_id: "run-durable-team".into(),
                provider: "codex".into(),
                model: "default".into(),
                created_at: canonical_now(),
            },
        )
        .expect("run started");
        let checkpointed = save_run_checkpoint(
            &state,
            SaveRunCheckpointRequest {
                run_id: "run-durable-team".into(),
                step_index: 1,
                handoff: "Repository context ready".into(),
                prior_steps: json!([{"id": "planner", "output": "bounded"}]),
                gate_approved: false,
                run_context: Some(json!({ "artifactVersion": "v-pinned" })),
                updated_at: canonical_now(),
            },
        )
        .expect("checkpoint stored");
        assert_eq!(checkpointed.run_checkpoints.len(), 1);
        assert_eq!(checkpointed.run_checkpoints[0].step_index, 1);
        assert_eq!(
            checkpointed.run_checkpoints[0].body["runContext"]["artifactVersion"],
            "v-pinned"
        );

        let waiting = record_run_approval(
            &state,
            RecordRunApprovalRequest {
                id: "approval-run-durable-team-1".into(),
                run_id: "run-durable-team".into(),
                step_index: 1,
                status: "awaiting".into(),
                body: json!({"summary": "Review the exact local diff"}),
                updated_at: canonical_now(),
            },
        )
        .expect("approval stored");
        assert_eq!(waiting.thread["status"], "needs-input");
        assert_eq!(waiting.approvals[0].status, "awaiting");

        let connection = state.connection().expect("connection");
        let checkpoint_body: String = connection
            .query_row(
                "SELECT body_json FROM run_checkpoints WHERE run_id = 'run-durable-team'",
                [],
                |row| row.get(0),
            )
            .expect("checkpoint body");
        let approval_body: String = connection
            .query_row(
                "SELECT body_json FROM approvals WHERE id = 'approval-run-durable-team-1'",
                [],
                |row| row.get(0),
            )
            .expect("approval body");
        assert!(DataCipher::is_sealed(&checkpoint_body));
        assert!(DataCipher::is_sealed(&approval_body));
        drop(connection);

        let archive = export_workspace_archive(&state).expect("archive");
        let restored_directory = tempdir().expect("restored directory");
        let restored = AppState::with_key(restored_directory.path().to_path_buf(), [83_u8; 32])
            .expect("restored state");
        let snapshot =
            restore_workspace_archive(&restored, &archive, true).expect("restored workspace");
        assert_eq!(snapshot.run_checkpoints.len(), 1);
        assert_eq!(snapshot.approvals.len(), 1);
        assert_eq!(
            snapshot.approvals[0].body["summary"],
            "Review the exact local diff"
        );
    }

    #[test]
    fn relaunch_marks_running_work_interrupted_and_preserves_its_checkpoint() {
        let directory = tempdir().expect("temporary directory");
        {
            let state = AppState::for_test(directory.path()).expect("state");
            begin_local_run(
                &state,
                BeginLocalRunRequest {
                    thread_id: "local-welcome".into(),
                    artifact_id: "artifact-agent-local".into(),
                    run_id: "run-interrupted-team".into(),
                    provider: "mlx".into(),
                    model: "local".into(),
                    created_at: canonical_now(),
                },
            )
            .expect("run started");
            save_run_checkpoint(
                &state,
                SaveRunCheckpointRequest {
                    run_id: "run-interrupted-team".into(),
                    step_index: 2,
                    handoff: "Two steps are safe".into(),
                    prior_steps: json!([{"id": "one"}, {"id": "two"}]),
                    gate_approved: false,
                    run_context: None,
                    updated_at: canonical_now(),
                },
            )
            .expect("checkpoint stored");
        }

        let reopened = AppState::with_key(directory.path().to_path_buf(), [29_u8; 32])
            .expect("reopened state");
        let recovered = load_snapshot(&reopened).expect("recovered snapshot");
        assert_eq!(recovered.thread["status"], "failed");
        assert_eq!(recovered.run_checkpoints[0].step_index, 2);
        assert_eq!(
            recovered.run_events.last().expect("last event").event_type,
            "run.interrupted"
        );

        let resumed = begin_local_run(
            &reopened,
            BeginLocalRunRequest {
                thread_id: "local-welcome".into(),
                artifact_id: "artifact-agent-local".into(),
                run_id: "run-interrupted-team".into(),
                provider: "mlx".into(),
                model: "local".into(),
                created_at: canonical_now(),
            },
        )
        .expect("run resumed");
        assert_eq!(resumed.thread["status"], "working");
        assert_eq!(
            resumed.run_events.last().expect("resume event").event_type,
            "run.resumed"
        );
    }

    #[test]
    fn interrupted_transaction_is_rolled_back_on_reopen() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        {
            let connection = state.connection().expect("connection");
            connection.execute_batch("BEGIN IMMEDIATE").expect("begin");
            connection
                .execute(
                    "INSERT INTO thread_blocks
                        (thread_id, sequence, id, kind, body_json, created_at)
                     VALUES ('local-welcome', 5, 'partial-write', 'user-message', '{}', ?1)",
                    params![canonical_now()],
                )
                .expect("partial insert");
        }

        let connection = state.connection().expect("reopen");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM thread_blocks WHERE id = 'partial-write'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 0);
        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity check");
        assert_eq!(integrity, "ok");
    }

    #[test]
    fn killed_writer_process_recovers_the_last_committed_state() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let before = bootstrap_local_workspace(&state).expect("initial snapshot");

        let mut child = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "storage::tests::crash_worker_holds_uncommitted_transaction",
                "--nocapture",
            ])
            .env("CODELIT_CRASH_TEST_DIRECTORY", directory.path())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn crash writer");
        let stdout = child.stdout.take().expect("crash writer stdout");
        let mut lines = BufReader::new(stdout).lines();
        let mut output = Vec::new();
        let ready = loop {
            let Some(line) = lines.next() else {
                break false;
            };
            let line = line.expect("read crash writer output");
            let is_ready = line == "CRASH_WRITE_READY";
            output.push(line);
            if is_ready {
                break true;
            }
        };
        assert!(
            ready,
            "crash writer exited without becoming ready: {}",
            output.join(" | ")
        );

        child.kill().expect("kill writer during transaction");
        child.wait().expect("reap killed writer");

        let recovered_state = AppState::for_test(directory.path()).expect("reopen state");
        let recovered = bootstrap_local_workspace(&recovered_state).expect("recovered snapshot");
        assert_eq!(recovered.blocks.len(), before.blocks.len());
        assert_eq!(
            recovered
                .blocks
                .iter()
                .filter(|block| block["id"] == "killed-partial-write")
                .count(),
            0
        );
        let connection = recovered_state.connection().expect("reopen database");
        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .expect("integrity check");
        assert_eq!(integrity, "ok");
    }

    #[test]
    fn crash_worker_holds_uncommitted_transaction() {
        let Ok(directory) = std::env::var("CODELIT_CRASH_TEST_DIRECTORY") else {
            return;
        };
        let state = AppState::for_test(Path::new(&directory)).expect("worker state");
        let connection = state.connection().expect("worker connection");
        connection.execute_batch("BEGIN IMMEDIATE").expect("begin");
        connection
            .execute(
                "INSERT INTO thread_blocks
                    (thread_id, sequence, id, kind, body_json, created_at)
                 VALUES ('local-welcome', 5, 'killed-partial-write', 'user-message', '{}', ?1)",
                params![canonical_now()],
            )
            .expect("partial insert");
        println!("CRASH_WRITE_READY");
        std::io::stdout().flush().expect("flush readiness");
        thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn rejects_stale_thread_sequences() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let error = append_thread_message(
            &state,
            AppendMessageRequest {
                thread_id: "local-welcome".into(),
                id: "message-stale".into(),
                sequence: 99,
                role: "user".into(),
                text: "This must not overwrite newer work.".into(),
                created_at: canonical_now(),
            },
        )
        .expect_err("stale sequence rejected");
        assert!(error.contains("Expected sequence 5"));
    }

    #[test]
    fn stores_security_scoped_bookmarks_as_opaque_sqlite_blobs() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let bytes = vec![0_u8, 19, 44, 255, 8];

        let snapshot =
            save_workspace_folder(&state, "/tmp/codelit-selected-folder", &bytes, false, true)
                .expect("bookmark persisted");
        let folder = snapshot.workspace_folder.expect("folder record");
        assert_eq!(folder.path, "/tmp/codelit-selected-folder");
        assert!(folder.read_only);
        assert!(folder.access_validated);

        let stored = load_workspace_bookmark(&state)
            .expect("bookmark read")
            .expect("stored bookmark");
        assert_eq!(stored.bookmark, bytes);
    }

    #[test]
    fn sensitive_bodies_are_encrypted_at_rest() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        append_thread_message(
            &state,
            AppendMessageRequest {
                thread_id: "local-welcome".into(),
                id: "message-encrypted".into(),
                sequence: 5,
                role: "user".into(),
                text: "private release phrase".into(),
                created_at: canonical_now(),
            },
        )
        .expect("message persisted");

        let connection = state.connection().expect("connection");
        let stored: String = connection
            .query_row(
                "SELECT body_json FROM thread_blocks WHERE id = 'message-encrypted'",
                [],
                |row| row.get(0),
            )
            .expect("stored body");
        assert!(DataCipher::is_sealed(&stored));
        assert!(!stored.contains("private release phrase"));

        let payload: String = connection
            .query_row(
                "SELECT payload_json FROM artifact_versions LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("stored artifact payload");
        assert!(DataCipher::is_sealed(&payload));
    }

    #[test]
    fn migrates_plaintext_bodies_from_the_feasibility_schema() {
        let directory = tempdir().expect("temporary directory");
        let database_path = directory.path().join(DATABASE_FILENAME);
        let connection = Connection::open(&database_path).expect("database");
        migrate(&connection).expect("base schema");
        let now = canonical_now();
        let thread = json!({
            "id": "legacy-thread",
            "ownerUid": "local-device",
            "workspaceId": "local-workspace",
            "projectId": "legacy-project",
            "title": "Legacy local Thread",
            "status": "idle",
            "latestBlockSequence": 0,
            "activeArtifactRefs": [],
            "createdAt": now,
            "updatedAt": now,
        });
        connection
            .execute(
                "INSERT INTO threads
                    (id, owner_uid, title, status, latest_block_sequence, body_json, created_at, updated_at)
                 VALUES ('legacy-thread', 'local-device', 'Legacy local Thread', 'idle', 0, ?1, ?2, ?2)",
                params![thread.to_string(), now],
            )
            .expect("legacy thread");
        drop(connection);

        let state = AppState::with_key(directory.path().to_path_buf(), [43_u8; 32])
            .expect("migrated state");
        let snapshot = bootstrap_local_workspace(&state).expect("snapshot");
        assert_eq!(snapshot.thread["id"], "legacy-thread");

        let connection = state.connection().expect("connection");
        let stored: String = connection
            .query_row(
                "SELECT body_json FROM threads WHERE id = 'legacy-thread'",
                [],
                |row| row.get(0),
            )
            .expect("encrypted legacy body");
        assert!(DataCipher::is_sealed(&stored));
        assert!(!stored.contains("Legacy local Thread"));
    }

    #[test]
    fn portable_archive_restores_under_a_different_key_without_permissions() {
        let source_directory = tempdir().expect("source directory");
        let source = AppState::with_key(source_directory.path().to_path_buf(), [3_u8; 32])
            .expect("source state");
        save_artifact_version(
            &source,
            SaveArtifactRequest {
                thread_id: "local-welcome".into(),
                artifact_id: "artifact-product-local".into(),
                kind: "product-plan".into(),
                version: "v-portable".into(),
                title: "Portable plan".into(),
                project_id: "local-project".into(),
                payload: json!({ "problem": "private portable plan", "outcomes": ["restore"] }),
                created_at: canonical_now(),
            },
        )
        .expect("artifact version");
        record_local_check(
            &source,
            RecordLocalCheckRequest {
                thread_id: "local-welcome".into(),
                artifact_id: "artifact-agent-local".into(),
                run_id: "run-portable".into(),
                created_at: canonical_now(),
                provider: None,
                model: None,
                status: None,
                summary: None,
                receipt_details: None,
                selection_mode: "fixed".into(),
                metered_fallback_authorized: false,
                metered_provider_invocation_started: false,
                billing_fallback: false,
                events: Vec::new(),
            },
        )
        .expect("run");
        save_workspace_folder(
            &source,
            "/private/source/folder",
            &[5_u8, 7, 9, 11],
            false,
            true,
        )
        .expect("bookmark");
        store_artifact_file(
            &source,
            StoreArtifactFileRequest {
                artifact_id: "artifact-product-local".into(),
                file_name: "acceptance.txt".into(),
                mime_type: "text/plain".into(),
                data_base64: BASE64_STANDARD.encode(b"portable evidence"),
                created_at: canonical_now(),
            },
        )
        .expect("artifact file");

        let bytes = export_workspace_archive(&source).expect("archive");
        let text = String::from_utf8(bytes.clone()).expect("utf8 archive");
        assert!(text.contains("private portable plan"));
        assert!(!text.contains("/private/source/folder"));
        assert!(!text.contains("workspaceBookmarks"));
        let archive: WorkspaceArchive = serde_json::from_slice(&bytes).expect("archive json");
        assert!(!archive.manifest.contains_credentials);
        assert!(archive.artifact_versions.len() > ARTIFACT_KINDS.len());
        assert_eq!(archive.artifact_files.len(), 1);

        let target_directory = tempdir().expect("target directory");
        let target = AppState::with_key(target_directory.path().to_path_buf(), [91_u8; 32])
            .expect("target state");
        assert!(restore_workspace_archive(&target, &bytes, false).is_err());
        let restored = restore_workspace_archive(&target, &bytes, true).expect("restored");
        assert!(restored.workspace_folder.is_none());
        assert_eq!(restored.run_events.len(), 2);
        assert_eq!(restored.receipts.len(), 1);
        assert_eq!(restored.artifact_files.len(), 1);
        let plan = restored
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == "artifact-product-local")
            .expect("restored plan");
        assert_eq!(plan.title, "Portable plan");
        assert_eq!(plan.payload["problem"], "private portable plan");

        let connection = target.connection().expect("target database");
        let stored: String = connection
            .query_row(
                "SELECT payload_json FROM artifact_versions
                 WHERE artifact_id = 'artifact-product-local' AND version = 'v-portable'",
                [],
                |row| row.get(0),
            )
            .expect("target ciphertext");
        assert!(DataCipher::is_sealed(&stored));
        assert!(!stored.contains("private portable plan"));
        assert_eq!(
            artifact_store::read(
                &target.app_data_dir().join("artifacts"),
                &restored.artifact_files[0].hash,
            )
            .expect("restored artifact file"),
            b"portable evidence"
        );
    }

    #[test]
    fn invalid_archive_does_not_replace_current_workspace() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let before = bootstrap_local_workspace(&state).expect("before");
        let mut archive: Value =
            serde_json::from_slice(&export_workspace_archive(&state).expect("archive"))
                .expect("archive json");
        archive["manifest"]["format"] = json!("not-codelit");
        let bytes = serde_json::to_vec(&archive).expect("invalid archive");
        assert!(restore_workspace_archive(&state, &bytes, true).is_err());
        let after = bootstrap_local_workspace(&state).expect("after");
        assert_eq!(after.thread, before.thread);
        assert_eq!(after.blocks, before.blocks);
    }

    #[test]
    fn archive_rejects_an_invalid_bot_avatar_before_replacing_workspace() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        let before = bootstrap_local_bots(&state).expect("before");
        let mut archive: WorkspaceArchive =
            serde_json::from_slice(&export_workspace_archive(&state).expect("archive"))
                .expect("archive json");
        let current = archive
            .bots
            .iter()
            .find(|bot| bot.id == before.active_bot.id)
            .expect("active bot archive row");
        let version = archive
            .bot_versions
            .iter_mut()
            .find(|version| {
                version.bot_id == current.id && version.version == current.current_version
            })
            .expect("active bot version");
        version.spec["appearance"] = json!({
            "avatar": {
                "kind": "image",
                "dataUrl": avatar_png_data_url(255, 256),
            }
        });
        let bytes = serde_json::to_vec(&archive).expect("tampered archive");
        let error = restore_workspace_archive(&state, &bytes, true)
            .expect_err("invalid avatar archive rejected");
        assert!(error.contains("avatar"));
        let after = bootstrap_local_bots(&state).expect("after");
        assert_eq!(after.active_bot.id, before.active_bot.id);
        assert_eq!(
            after.active_bot.current_version,
            before.active_bot.current_version
        );
        assert_eq!(after.workspace.thread, before.workspace.thread);
    }

    #[test]
    fn complete_local_reset_removes_data_files_and_reseeds() {
        let directory = tempdir().expect("temporary directory");
        let state = AppState::for_test(directory.path()).expect("state");
        append_thread_message(
            &state,
            AppendMessageRequest {
                thread_id: "local-welcome".into(),
                id: "message-delete".into(),
                sequence: 5,
                role: "user".into(),
                text: "remove me".into(),
                created_at: canonical_now(),
            },
        )
        .expect("message");
        save_workspace_folder(&state, "/tmp/remove-me", &[1_u8, 2, 3], false, true)
            .expect("bookmark");
        let model_directory = state.app_data_dir().join("models");
        fs::create_dir_all(&model_directory).expect("models directory");
        fs::write(model_directory.join("cached-model"), b"weights").expect("model cache");
        let quarantine_directory = state.app_data_dir().join("browser-quarantine/stale");
        fs::create_dir_all(&quarantine_directory).expect("quarantine directory");
        fs::write(quarantine_directory.join("payload"), b"download").expect("quarantine payload");

        remove_local_data_files(&state).expect("remove files");
        let reset = initialize_empty_workspace(&state, [99_u8; 32]).expect("reset");
        assert_eq!(reset.blocks.len(), 4);
        assert!(reset.workspace_folder.is_none());
        assert!(reset.receipts.is_empty());
        assert!(!model_directory.exists());
        assert!(!state.app_data_dir().join("browser-quarantine").exists());
        assert!(
            reset
                .blocks
                .iter()
                .all(|block| block["text"] != "remove me")
        );
    }
}
