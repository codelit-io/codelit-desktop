import type { LocalWorkspaceSnapshot } from "@/lib/local-desktop-workspace";

export const PROVIDER_IDS = [
  "codelit",
  "codex",
  "copilot",
  "claude",
  "antigravity",
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "lmstudio",
  "mlx",
] as const;

export type ProviderId = typeof PROVIDER_IDS[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_IDS.some((provider) => provider === value);
}

export type {
  LocalArtifactFile,
  LocalArtifactVersion,
  LocalReceipt,
  LocalRunApproval,
  LocalRunCheckpoint,
  LocalRunEvent,
  LocalWorkspaceFolder,
  LocalWorkspaceSnapshot,
  WorkspaceApprovalBlock,
  WorkspaceReceiptBlock,
} from "@/lib/local-desktop-workspace";

export type LocalSurface = "home" | "agent-team" | "product-plan" | "architecture";

export type LocalBotStatus =
  | "sleeping"
  | "watching"
  | "thinking"
  | "working"
  | "waiting"
  | "done"
  | "blocked"
  | "paused";

export interface BotEnginePolicy {
  mode: "auto" | "fixed";
  allowedProviders: ProviderProbe["id"][];
  fixedEngine?: IntelligenceSelection;
  allowMeteredFallback: boolean;
}

export interface BotPermissionPolicy {
  approvalMode: "ask" | "safe-auto";
  browserDomains: string[];
  projectAccess: "ask" | "read-only";
  browserAccess: "ask" | "disabled";
  writeActions: "always-ask" | "disabled";
  computerUse: "ask" | "disabled";
}

export interface BotAutonomyPolicy {
  mode: "manual" | "reviewed-routines";
  maxActionsPerRun: number;
  allowBackground: boolean;
}

export interface BotMemoryPolicy {
  mode: "off" | "proposals";
  scopes: Array<"bot" | "workspace">;
  proposalReview: "required";
}

export interface BotGoal {
  id: string;
  outcome: string;
  successCriteria: string[];
  status: "active" | "completed" | "paused";
  nextAction: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalPilotReport {
  schemaVersion: 2;
  kind: "codelit-local-pilot-report";
  reportId: string;
  participantId: string;
  generatedAt: string;
  app: {
    version: string;
    buildChannel: "development" | "direct" | "app-store";
    sourceCommit: string;
    sourceDirty: boolean;
  };
  measurementWindow: {
    startedAt: string;
    endedAt: string;
  };
  privacy: {
    localOnly: true;
    automaticUpload: false;
    excluded: string[];
  };
  activation: {
    customBotCreated: boolean;
    firstRunAttempted: boolean;
    firstRunCompleted: boolean;
    firstUsefulResultCompleted: boolean;
    secondsToFirstUsefulResult: number | null;
  };
  runs: {
    started: number;
    completed: number;
    failed: number;
    canceled: number;
    activeDays: number;
    repeatTaskWithinSevenDays: boolean;
  };
  delegations: {
    started: number;
    completed: number;
    repeated: boolean;
  };
  routines: {
    created: number;
    enabled: number;
    occurrences: number;
    completedOccurrences: number;
    reused: boolean;
  };
  approvals: {
    requested: number;
    awaiting: number;
    resolved: number;
    approved: number;
    heldOrDenied: number;
  };
  unexpectedActions: {
    total: number;
    categories: Array<{
      category: "unexpected-action" | "unapproved-write" | "sensitive-data" | "other";
      count: number;
    }>;
  };
}

export type UnexpectedActionCategory = LocalPilotReport["unexpectedActions"]["categories"][number]["category"];

export type BotAvatarPreset = "spark" | "orbit" | "mountain" | "ember" | "prism" | "wave";

export type BotAvatarSpec =
  | { kind: "preset"; preset: BotAvatarPreset }
  | { kind: "image"; dataUrl: string };

export interface BotSpec {
  schemaVersion: 1;
  botId: string;
  version: number;
  name: string;
  job: string;
  instructions: string[];
  enginePolicy: BotEnginePolicy;
  capabilityIds: string[];
  permissionPolicy: BotPermissionPolicy;
  autonomyPolicy: BotAutonomyPolicy;
  memoryPolicy: BotMemoryPolicy;
  goal: BotGoal;
  routineIds: string[];
  appearance?: { avatar: BotAvatarSpec };
  createdAt: string;
  updatedAt: string;
}

export interface BotRunSnapshot {
  botId: string;
  botVersion: number;
  skillVersions: Record<string, number>;
  memorySnapshotHash: string;
  engine: IntelligenceSelection;
  permissionSnapshot: BotPermissionPolicy;
  routineVersion?: number;
  createdAt: string;
}

export interface BotMemory {
  id: string;
  botId?: string;
  scope: "bot" | "workspace";
  kind: "preference" | "fact" | "procedure" | "decision";
  body: string;
  source: "user" | "inferred";
  confidence: number;
  sensitivity: "normal";
  approvalState: "approved";
  sourceRunId?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveLocalBotMemoryRequest {
  id: string;
  actorBotId: string;
  scope: BotMemory["scope"];
  kind: BotMemory["kind"];
  body: string;
  expiresAt?: string;
  createdAt: string;
}

export interface BotMemoryProposal {
  id: string;
  botId: string;
  scope: "bot";
  kind: BotMemory["kind"];
  body: string;
  source: "inferred";
  confidence: number;
  sensitivity: "normal";
  approvalState: "pending";
  sourceRunId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalBotMemoryProposalRequest {
  id: string;
  actorBotId: string;
  kind: BotMemory["kind"];
  body: string;
  sourceRunId: string;
  createdAt: string;
}

export interface ReviewLocalBotMemoryProposalRequest {
  id: string;
  actorBotId: string;
  decision: "approve" | "dismiss";
  scope: BotMemory["scope"];
  expiresAt?: string;
  reviewedAt: string;
}

export interface DeleteLocalBotMemoryRequest {
  id: string;
  actorBotId: string;
  deletedAt: string;
}

export interface ClearLocalBotMemoriesRequest {
  actorBotId: string;
  includeShared: boolean;
  deletedAt: string;
}

export type BotSkillFieldType = "text" | "url" | "number" | "boolean" | "date" | "choice";

export interface BotSkillField {
  id: string;
  label: string;
  type: BotSkillFieldType;
  required: boolean;
  description?: string;
  options?: string[];
}

export type BotSkillEffectKind =
  | "model-generate"
  | "browser-read"
  | "browser-write"
  | "files-read"
  | "files-write"
  | "data-write"
  | "notification-send"
  | "computer-act";

export interface BotSkillEffect {
  id: string;
  label: string;
  kind: BotSkillEffectKind;
  target: string;
  risk: "local" | "read-only" | "write" | "sensitive";
}

export interface BotSkillExample {
  request: string;
}

export interface BotSkillCheck {
  id: string;
  label: string;
  phase: "before" | "after";
  rule: "required" | "public-https" | "project-approved" | "output-present";
  inputId?: string;
}

export interface BotSkill {
  id: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  capabilityIds: string[];
  inputSchema: BotSkillField[];
  outputSchema: BotSkillField[];
  requiredPermissions: string[];
  effects: BotSkillEffect[];
  examples: BotSkillExample[];
  checks: BotSkillCheck[];
  source: "built-in" | "taught" | "user-authored" | "imported";
  trustState: "packaged" | "reviewed" | "unreviewed";
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveLocalBotSkillRequest {
  id: string;
  actorBotId: string;
  name: string;
  description: string;
  instructions: string;
  capabilityIds: string[];
  inputSchema?: BotSkillField[];
  outputSchema?: BotSkillField[];
  requiredPermissions?: string[];
  effects?: BotSkillEffect[];
  examples?: BotSkillExample[];
  checks?: BotSkillCheck[];
  expectedVersion?: number;
  createdAt: string;
}

export interface ReviewImportedBotSkillRequest {
  id: string;
  actorBotId: string;
  expectedVersion: number;
  decision: "approve" | "discard";
  reviewedAt: string;
}

export interface DeleteLocalBotSkillRequest {
  id: string;
  actorBotId: string;
  deletedAt: string;
}

export type BotDataColumnType = "text" | "number" | "boolean" | "date" | "url";

export interface BotDataColumn {
  name: string;
  type: BotDataColumnType;
}

export interface LocalBotTable {
  id: string;
  databaseId: string;
  botId: string;
  name: string;
  version: number;
  columns: BotDataColumn[];
  rowCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocalBotTableRow {
  id: string;
  values: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
}

export interface LocalBotTableView {
  table: LocalBotTable;
  rows: LocalBotTableRow[];
  totalRows: number;
  truncated: boolean;
}

export interface CreateLocalBotTableRequest {
  id: string;
  botId: string;
  name: string;
  columns: BotDataColumn[];
  createdAt: string;
}

export interface AppendLocalBotTableRowRequest {
  id: string;
  botId: string;
  tableId: string;
  values: LocalBotTableRow["values"];
  createdAt: string;
}

export interface BotRoutine {
  id: string;
  version: number;
  botId: string;
  title: string;
  enabled: boolean;
  prompt: string;
  trigger: {
    cadence: LocalScheduleCadence;
    localTime: string;
    timezone: string;
    weekdays: number[];
    label: string;
  };
  budget: {
    maxActions: number;
    maxRetries: number;
  };
  scheduleId: string;
  nextDueAt?: string;
  lastOutcome?: ScheduleOccurrenceStatus["status"];
  createdAt: string;
}

export interface BotRoutineSnapshot {
  schemaVersion: 1;
  kind: "bot-routine";
  routineId: string;
  botId: string;
  botVersion: number;
  goalId: string;
  prompt: string;
  triggerLabel: string;
  permissionSnapshot: BotPermissionPolicy;
  createdAt: string;
}

export interface BotEventRoutine {
  id: string;
  version: number;
  botId: string;
  threadId: string;
  title: string;
  enabled: boolean;
  prompt: string;
  trigger: {
    kind: "project-change";
    label: string;
    debounceSeconds: number;
    cooldownMinutes: number;
  };
  budget: {
    maxActions: number;
    maxRetries: number;
  };
  provider: string;
  model: string;
  requiresNetwork: boolean;
  botSnapshot: BotSpec;
  memorySnapshotHash: string;
  skillVersions: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  pausedReason?: string;
  lastCheckedAt?: string;
  lastTriggeredAt?: string;
  lastOutcome?: EventRoutineOccurrenceStatus["status"];
  lastFileCount?: number;
  lastTruncated?: boolean;
}

export interface SaveLocalEventRoutineRequest {
  id: string;
  botId: string;
  title: string;
  prompt: string;
  trigger: BotEventRoutine["trigger"];
  budget: BotEventRoutine["budget"];
  provider: string;
  model: string;
  requiresNetwork: boolean;
  botSnapshot: BotSpec;
  memorySnapshotHash: string;
  skillVersions: Record<string, number>;
  createdAt: string;
}

export interface EventRoutineOccurrenceStatus {
  idempotencyKey: string;
  routineId: string;
  status: "claimed" | "running" | "retry" | "paused" | "completed" | "failed" | "canceled";
  attempt: number;
  observedAt: string;
  nextAttemptAt?: string;
  pauseReason?: string;
  runId: string;
  updatedAt: string;
}

export interface ClaimedEventRoutineOccurrence {
  idempotencyKey: string;
  claimToken: string;
  observedAt: string;
  attempt: number;
  runId: string;
  previousFingerprint: string;
  fingerprint: string;
  routine: BotEventRoutine;
}

export type LocalBotDelegationStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "canceled";

export interface LocalBotDelegationTarget {
  botId: string;
  threadId: string;
  botName: string;
  botVersion: number;
  status: LocalBotDelegationStatus;
  maxActions: number;
  deadlineAt: string;
  botSnapshot: BotSpec;
  runId?: string;
  providerId?: ProviderProbe["id"];
  result?: string;
  detail?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface LocalBotDelegation {
  id: string;
  parentBotId: string;
  parentThreadId: string;
  parentBotName: string;
  parentBotVersion: number;
  task: string;
  expectedOutput: string;
  sharedMemorySnapshotHash: string;
  status: LocalBotDelegationStatus;
  maxParallel: number;
  targets: LocalBotDelegationTarget[];
  createdAt: string;
  updatedAt: string;
}

export interface LocalBotDelegationRunContext {
  delegationId: string;
  parentBotId: string;
  parentThreadId: string;
  parentBotName: string;
  targetBotId: string;
  expectedOutput: string;
  maxActions: number;
}

export interface CreateLocalBotDelegationRequest {
  id: string;
  parentBotId: string;
  targetBotIds: string[];
  task: string;
  expectedOutput: string;
  maxActions: number;
  deadlineAt: string;
  sharedMemorySnapshotHash: string;
  createdAt: string;
}

export interface StartLocalBotDelegationTargetRequest {
  id: string;
  targetBotId: string;
  runId: string;
  providerId: ProviderProbe["id"];
  providerQuotaState: ProviderQuota["state"];
  startedAt: string;
}

export interface FinishLocalBotDelegationTargetRequest {
  id: string;
  targetBotId: string;
  runId: string;
  outcome: "completed" | "failed" | "canceled" | "approval-required";
  result?: string;
  detail?: string;
  finishedAt: string;
}

export interface BotEvent {
  id: string;
  botId: string;
  eventType: string;
  body: unknown;
  createdAt: string;
}

export interface LocalBotRecord {
  id: string;
  threadId: string;
  currentVersion: number;
  name: string;
  status: LocalBotStatus;
  latestStatus: string;
  spec: BotSpec;
  createdAt: string;
  updatedAt: string;
}

export interface LocalBotsSnapshot {
  bots: LocalBotRecord[];
  activeBot: LocalBotRecord;
  workspace: LocalWorkspaceSnapshot;
}

export interface CreateLocalBotRequest {
  id: string;
  name: string;
  job: string;
  avatar?: BotAvatarSpec;
  createdAt: string;
}

export interface UpdateLocalBotProfileRequest {
  id: string;
  name: string;
  avatar?: BotAvatarSpec;
  updatedAt: string;
}

export interface UpdateLocalBotGoalRequest {
  id: string;
  goal: BotGoal;
  updatedAt: string;
  expectedVersion?: number;
}

export interface UpdateLocalBotBrowserDomainsRequest {
  id: string;
  domains: string[];
  updatedAt: string;
  expectedVersion?: number;
}

export interface UpdateLocalBotRoutinesRequest {
  id: string;
  routineIds: string[];
  allowBackground: boolean;
  updatedAt: string;
}

export interface LocalBotContext {
  bot: LocalBotRecord;
  workspace: LocalWorkspaceSnapshot;
}

export interface UpdateLocalBotGroupMembersRequest {
  ownerBotId: string;
  memberBotIds: string[];
  updatedAt: string;
}

export interface UpdateLocalBotEnginePolicyRequest {
  id: string;
  mode: BotEnginePolicy["mode"];
  allowedProviders: ProviderProbe["id"][];
  fixedEngine?: IntelligenceSelection;
  allowMeteredFallback: boolean;
  updatedAt: string;
}

export interface UpdateLocalBotStatusRequest {
  id: string;
  status: LocalBotStatus;
  latestStatus: string;
  updatedAt: string;
}

export interface BackgroundServiceProbe {
  status: "enabled" | "requires-approval" | "not-registered" | "not-found" | "unsupported";
  bundled: boolean;
  detail: string;
}

export interface RoutineAutonomyPolicy {
  globallyPaused: boolean;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  dailyDigestEnabled: boolean;
  dailyDigestTime: string;
  timezone: string;
  status: "active" | "paused" | "quiet-hours";
  statusDetail: string;
  resumesAt?: string;
  canStartWork: boolean;
  updatedAt: string;
}

export interface UpdateRoutineAutonomyPolicyRequest {
  globallyPaused: boolean;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  dailyDigestEnabled: boolean;
  dailyDigestTime: string;
  timezone: string;
}

export interface DesktopUpdateState {
  channel: "direct" | "app-store" | "development";
  status: "idle" | "current" | "available" | "managed" | "unavailable";
  currentVersion: string;
  availableVersion?: string;
  publishedAt?: string;
  notes?: string;
  detail: string;
}

export interface DesktopCloudStatus {
  status: "disconnected" | "pending" | "connected" | "expired";
  detail: string;
  pairingCode?: string;
  expiresAt?: string;
}

export interface DesktopPairingStart {
  status: "pending";
  detail: string;
  pairingCode: string;
  expiresAt: string;
}

export interface DesktopPromotionStart {
  status: "review-opened";
  promotionId: string;
  payloadHash: string;
  reviewUrl: string;
  expiresAt: string;
}

export type DesktopCloudCapabilityId = "run-24-7" | "cloud-browser" | "public-trigger" | "collaboration";
export type DesktopCloudTransferIntent = DesktopCloudCapabilityId | "sync";
export type DesktopCloudConflictState =
  | "in-sync"
  | "local-changed"
  | "cloud-changed"
  | "diverged"
  | "attention"
  | "pending-review";

export interface DesktopCloudAccount {
  plan: "free" | "pro" | "max";
  planName: string;
  entitlementVersion: string;
  status: "free" | "active" | "trialing" | "attention";
  source: "stripe" | "app-store" | "account";
  buildChannel: "direct" | "app-store" | "development";
  commerce: "direct" | "app-store";
  limits: {
    hostedWorkflows: number;
    managedBrowserMinutes: number;
    workspaceSeats: number;
  };
}

export interface DesktopCloudCapability {
  id: DesktopCloudCapabilityId;
  available: boolean;
  requiredPlan: "pro" | "max";
  title: string;
  detail: string;
  href?: string;
}

export interface DesktopCloudResultSummary {
  runId: string;
  status: "completed" | "halted" | "failed";
  summary: string;
  completedAt: string;
  receiptHref: string;
}

export interface DesktopCloudLink {
  promotionId: string;
  scheduleId?: string;
  threadId: string;
  artifactId: string;
  sourceArtifactVersion: string;
  artifactKind: "agent-team" | "product-plan" | "architecture";
  title: string;
  payloadHash: string;
  mode: "run-24-7" | "sync-only";
  status: "review" | "imported" | "completed" | "cancelled";
  cloudState: "review" | "setup-required" | "active" | "paused" | "synced" | "changed" | "attention";
  conflictState: DesktopCloudConflictState;
  localChanged: boolean;
  cloudChanged: boolean;
  cloudRevision?: string;
  projectHref?: string;
  reviewHref?: string;
  latestResult?: DesktopCloudResultSummary;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopCloudImportedResult {
  threadId: string;
  artifactId: string;
  artifactKind: DesktopCloudLink["artifactKind"];
  runId: string;
  title: string;
  body: string;
}

export interface DesktopCloudSyncView {
  version: 1;
  checkedAt: string;
  account: DesktopCloudAccount;
  capabilities: DesktopCloudCapability[];
  promotions: DesktopCloudLink[];
  importedResults: DesktopCloudImportedResult[];
  workspace: LocalWorkspaceSnapshot;
}

export type LocalScheduleCadence = "once" | "daily" | "weekdays" | "weekly";
export type LocalScheduleMissedPolicy = "skip" | "run-once" | "run-every";

export interface LocalSchedule {
  id: string;
  threadId: string;
  artifactId: string;
  artifactVersion: string;
  title: string;
  enabled: boolean;
  cadence: LocalScheduleCadence;
  localTime: string;
  timezone: string;
  weekdays: number[];
  missedPolicy: LocalScheduleMissedPolicy;
  maxRetries: number;
  provider: string;
  model: string;
  requiresNetwork: boolean;
  revision: number;
  nextDueAt?: string;
  pausedReason?: string;
  snapshot: unknown;
  oneTimeAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveLocalScheduleRequest {
  id: string;
  expectedRevision?: number;
  threadId: string;
  artifactId: string;
  artifactVersion: string;
  title: string;
  enabled: boolean;
  cadence: LocalScheduleCadence;
  localTime: string;
  timezone: string;
  weekdays: number[];
  missedPolicy: LocalScheduleMissedPolicy;
  maxRetries: number;
  provider: string;
  model: string;
  requiresNetwork: boolean;
  snapshot: unknown;
  oneTimeAt?: string;
}

export interface ScheduleOccurrenceStatus {
  idempotencyKey: string;
  scheduleId: string;
  status: "waking" | "claimed" | "running" | "retry" | "paused" | "completed" | "failed" | "skipped" | "canceled";
  attempt: number;
  scheduledFor: string;
  nextAttemptAt?: string;
  pauseReason?: string;
  runId: string;
  updatedAt: string;
}

export interface RoutineActivityItem {
  id: string;
  botId: string;
  botName: string;
  routineId: string;
  title: string;
  triggerKind: "schedule" | "project-change";
  status: "completed" | "failed" | "attention" | "retrying";
  runId: string;
  occurredAt: string;
}

export interface ClaimedScheduleOccurrence {
  idempotencyKey: string;
  claimToken: string;
  scheduledFor: string;
  attempt: number;
  runId: string;
  schedule: LocalSchedule;
}

export interface LocalProjectFingerprint {
  sha256: string;
  fileCount: number;
  truncated: boolean;
  capturedAt: string;
}

export interface LocalNotificationRoute {
  id: string;
  threadId: string;
  artifactId: string;
  artifactKind: "agent-team" | "product-plan" | "architecture" | "bot" | "activity";
  runId: string;
}

export interface ShowLocalNotificationRequest {
  threadId: string;
  artifactId: string;
  artifactKind: LocalNotificationRoute["artifactKind"];
  runId: string;
  title: string;
  body: string;
}

export interface ImportedWorkspace {
  path: string;
  snapshot: LocalWorkspaceSnapshot;
}

export type LocalMcpTransport = "stdio" | "localhost";

export interface LocalMcpServerDraft {
  id: string;
  name: string;
  transport: LocalMcpTransport;
  commandPath: string;
  arguments: string[];
  endpoint: string;
  networkAccess: boolean;
  projectAccess: boolean;
}

export interface LocalMcpConfig {
  transport: LocalMcpTransport;
  commandPath?: string;
  arguments: string[];
  endpoint?: string;
  networkAccess: boolean;
  projectAccess: boolean;
}

export interface ReviewedLocalMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schemaSha256: string;
  effect: "read" | "write";
  destructive: boolean;
  idempotent: boolean;
  approved: boolean;
}

export interface LocalMcpInspection {
  id: string;
  name: string;
  transport: LocalMcpTransport;
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  fingerprint: string;
  config: LocalMcpConfig;
  tools: ReviewedLocalMcpTool[];
  detail: string;
}

export interface LocalMcpServer extends LocalMcpInspection {
  enabled: boolean;
  status: "ready" | "disabled";
  updatedAt: string;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocalBrowserEvent {
  sessionId: string;
  eventType: string;
  message: string;
  url?: string;
  createdAt: string;
}

export interface LocalBrowserSession {
  sessionId: string;
  projectId: string;
  status: string;
  visible: boolean;
  currentUrl: string;
  allowedDomains: string[];
  downloadArmed: boolean;
  events: LocalBrowserEvent[];
}

export interface QuarantinedBrowserDownload {
  id: string;
  botId: string;
  sessionId: string;
  fileName: string;
  sourceUrl: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
  completedAt: string;
}

export type BrowserTeachingRisk =
  | "none"
  | "cross-domain"
  | "private-data"
  | "login"
  | "payment"
  | "destructive"
  | "upload"
  | "download"
  | "unsupported";

export interface BrowserTeachingTarget {
  expression: string;
  label: string;
  tag: string;
  inputType: string;
}

export interface BrowserTeachingEvent {
  type: "navigate" | "click" | "fill" | "select";
  url: string;
  target?: BrowserTeachingTarget;
  risk: BrowserTeachingRisk;
}

export interface LocalBrowserTeachingCapture {
  sessionId: string;
  status: "recording" | "review";
  startUrl: string;
  currentUrl: string;
  approvedDomains: string[];
  events: BrowserTeachingEvent[];
  startedAt: string;
}

export interface BrowserTeachingDryRunCheck {
  id: "boundary" | "values" | "targets";
  label: string;
  passed: boolean;
  detail: string;
}

export interface LocalBrowserTeachingDryRun {
  passed: boolean;
  checks: BrowserTeachingDryRunCheck[];
  executableSteps: number;
  protectedSteps: number;
}

export interface BrowserNavigationPreview {
  url: string;
  displayUrl: string;
  host: string;
  allowed: boolean;
  reason: string;
}

export interface LocalBrowserProof {
  toolId?: string;
  auditId: string;
  mode: "read" | "write";
  evidence: Array<{ id: string; type: "dom" | "screenshot" }>;
  attempts: number;
  events: Array<{ action: string; attempt: number; status: "completed" | "retry" }>;
}

export type ComputerPermissionKind = "accessibility" | "screen-recording";

export interface ComputerUseReadiness {
  available: boolean;
  accessibility: "granted" | "required" | "unavailable";
  screenRecording: "granted" | "required" | "unavailable";
  ready: boolean;
  detail: string;
  environment?: ComputerEnvironmentSnapshot;
}

export interface RunningComputerApp {
  bundleId: string;
  name: string;
  active: boolean;
}

export interface ComputerAppScope {
  botId: string;
  bundleId: string;
  appName: string;
  access: "observe" | "interact";
  createdAt: string;
  updatedAt: string;
}

export interface SaveComputerAppScopeRequest {
  botId: string;
  bundleId: string;
  access: ComputerAppScope["access"];
}

export interface ComputerSemanticElement {
  role: string;
  label: string;
  enabled: boolean;
  actions: Array<"press" | "confirm" | "cancel" | "increment" | "decrement" | "set-value">;
  sensitive: boolean;
  occurrence: number;
}

export interface ComputerAppInspection {
  bundleId: string;
  appName: string;
  elements: ComputerSemanticElement[];
  truncated: boolean;
}

export type ComputerSemanticAction =
  | {
      kind: "press";
      target: string;
      role?: string;
      occurrence?: number;
    }
  | {
      kind: "setValue";
      target: string;
      role?: string;
      occurrence?: number;
      value: string;
    };

export interface ComputerEvidenceFrame {
  phase: "before" | "after";
  mimeType: "image/png";
  dataUrl: string;
  sha256: string;
  windowId: number;
  width: number;
  height: number;
}

export interface ComputerEnvironmentSnapshot {
  status:
    | "ready"
    | "accessibility-required"
    | "screen-recording-required"
    | "locked"
    | "session-unavailable"
    | "no-active-display"
    | "display-asleep";
  session: "unlocked" | "locked" | "unavailable";
  accessibility: boolean;
  screenRecording: boolean;
  activeDisplayCount: number;
  awakeDisplayCount: number;
  topologySha256: string;
}

export interface ComputerActionEnvironment {
  before: ComputerEnvironmentSnapshot;
  after: ComputerEnvironmentSnapshot;
  continuity: "continuous" | "canceled-before-action" | "blocked-before-action" | "interrupted-after-dispatch";
}

export interface ComputerActionResult {
  runId: string;
  status: "completed" | "canceled" | "evidence-failed" | "blocked-before-action" | "continuity-lost";
  summary: string;
  before: ComputerAppInspection;
  after: ComputerAppInspection;
  evidence: ComputerEvidenceFrame[];
  environment: ComputerActionEnvironment;
}

export function localMcpToolReference(serverId: string, toolName: string) {
  return `mcp::${serverId}::${toolName}`;
}

export function parseLocalMcpToolReference(value: string) {
  if (!value.startsWith("mcp::")) return null;
  const separator = value.indexOf("::", 5);
  if (separator < 0) return null;
  const serverId = value.slice(5, separator);
  const toolName = value.slice(separator + 2);
  return serverId && toolName ? { serverId, toolName } : null;
}

export interface ProviderProbe {
  id: ProviderId;
  label: string;
  family: "subscription" | "api" | "local";
  authKind?: "provider-owned" | "api-key" | "none";
  billingMode?: "subscription" | "metered" | "local";
  distribution: "all" | "direct-only" | "unsupported";
  status: ProviderStatus;
  health:
    | "ready"
    | "unchecked-auth"
    | "signed-out"
    | "missing"
    | "policy-blocked"
    | "version-check-failed"
    | "manifest-invalid"
    | "service-stopped"
    | "model-setup-required";
  canRun: boolean;
  commandPath?: string;
  version?: string;
  capabilities: string[];
  models: ProviderModel[];
  quota: ProviderQuota;
  detail: string;
}

export type ProviderStatus =
  | "not-installed"
  | "signed-out"
  | "ready"
  | "quota-hit"
  | "version-unsupported"
  | "blocked-by-policy";

export interface ProviderModel {
  id: string;
  label: string;
  status:
    | "ready"
    | "download-required"
    | "partial"
    | "corrupt"
    | "benchmark-required"
    | "incompatible";
  capabilities: string[];
  local: boolean;
  downloadBytes?: number;
  installedBytes?: number;
  license?: string;
  recommended: boolean;
  detail: string;
  benchmark?: ModelBenchmark;
}

export interface LocalModelCandidate {
  id: string;
  label: string;
  revision: string;
  lastModified: string;
  downloads: number;
  likes: number;
  downloadBytes: number;
  requiredMemoryBytes: number;
  license: string;
  modelType: string;
  fit: "fits" | "memory" | "disk";
  detail: string;
}

export interface LocalModelDiscovery {
  fetchedAt: string;
  source: string;
  memoryBytes: number;
  freeDiskBytes: number;
  candidates: LocalModelCandidate[];
}

export interface ModelBenchmark {
  schemaVersion: number;
  model: string;
  revision: string;
  schemaAdherence: boolean;
  toolCalling: boolean;
  contextTokens: number;
  tokensPerSecond: number;
  benchmarkedAt: string;
}

export interface ProviderQuota {
  state: "unknown" | "available" | "limited" | "exhausted" | "not-applicable";
  detail: string;
  resetsAt?: string;
}

export type ApiKeyProviderId = "openai" | "anthropic" | "gemini";

export interface ProviderCredentialStatus {
  provider: ApiKeyProviderId;
  account: string;
  configured: boolean;
  available: boolean;
  detail: string;
}

export interface SaveProviderApiKeyRequest {
  provider: ApiKeyProviderId;
  apiKey: string;
}

export type ProviderTaskStatus =
  | "completed"
  | "signed-out"
  | "blocked-by-policy"
  | "quota-hit"
  | "canceled"
  | "failed";

export interface ProviderTaskResult {
  runId: string;
  provider: string;
  model: string;
  status: ProviderTaskStatus;
  structuredOutput?: {
    summary: string;
    items: string[];
  };
  text: string;
  durationMs: number;
  commandPath: string;
  version?: string;
  evidence: string[];
  selectionMode: "fixed" | "auto";
  meteredFallbackAuthorized: boolean;
  meteredProviderInvocationStarted: boolean;
  billingFallback: boolean;
}

export type ProviderRunEventType =
  | "queued"
  | "started"
  | "progress"
  | "message"
  | "reasoning-delta"
  | "output-delta"
  | "provider-invocation-started"
  | "tool-request"
  | "approval-required"
  | "tool-result"
  | "checkpoint"
  | "completed"
  | "failed"
  | "canceled";

export interface ProviderRunEvent {
  runId: string;
  sequence: number;
  eventType: ProviderRunEventType;
  provider: string;
  model: string;
  message: string;
  payload?: unknown;
  createdAt: string;
}

export interface IntelligenceSelection {
  provider: ProviderProbe["id"];
  model: string;
}

export interface LocalToolBatchResult {
  runId: string;
  status: "completed" | "failed" | "canceled";
  context: string[];
  completedTools: Array<{ toolId: string; toolName: string }>;
  browserProofs: LocalBrowserProof[];
  failure?: {
    toolId: string;
    toolName: string;
    code:
      | "configuration-invalid"
      | "authorization-denied"
      | "scope-blocked"
      | "provider-timeout"
      | "provider-failed"
      | "validation-failed"
      | "conflict"
      | "evidence-missing"
      | "cancelled";
    retryable: boolean;
    uncertainWrite: boolean;
  };
}

export interface LocalToolApprovalPreview {
  runId: string;
  status: "ready";
  summary: string;
  evidence: string[];
  patchSha256?: string;
  approvalSha256?: string;
}

export type ModelManagerAction = "download" | "resume" | "update" | "benchmark" | "delete";

export interface AgentTeamPayload {
  goal: string;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    provider: string;
    model: string;
    tools: string[];
    toolInputs?: Record<string, Record<string, unknown>>;
  }>;
  handoffs: Array<{ from: string; to: string; label: string }>;
}

export interface ProductPlanPayload {
  problem: string;
  audience: string;
  outcomes: string[];
  milestones: string[];
}

export interface ArchitecturePayload {
  summary: string;
  components: Array<{ id: string; name: string; detail: string }>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
