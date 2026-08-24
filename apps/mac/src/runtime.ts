import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ThreadBlock, WorkspaceArtifactRef, WorkspaceThread } from "@/lib/workspace-thread";
import type {
  AgentTeamPayload,
  ArchitecturePayload,
  BackgroundServiceProbe,
  RoutineAutonomyPolicy,
  DesktopCloudStatus,
  DesktopCloudLink,
  DesktopCloudSyncView,
  DesktopUpdateState,
  DesktopPairingStart,
  DesktopPromotionStart,
  BrowserBounds,
  BrowserNavigationPreview,
  ComputerAppScope,
  ComputerActionResult,
  ComputerAppInspection,
  ComputerPermissionKind,
  ComputerSemanticAction,
  ComputerUseReadiness,
  BotAvatarPreset,
  BotAvatarSpec,
  BotEnginePolicy,
  BotEventRoutine,
  BotGoal,
  BotMemory,
  BotMemoryProposal,
  BotSkill,
  AppendLocalBotTableRowRequest,
  CreateLocalBotTableRequest,
  BotPermissionPolicy,
  CreateLocalBotDelegationRequest,
  LocalArtifactVersion,
  LocalBotDelegation,
  LocalBrowserEvent,
  LocalBrowserSession,
  QuarantinedBrowserDownload,
  LocalBrowserTeachingCapture,
  LocalBrowserTeachingDryRun,
  ImportedWorkspace,
  IntelligenceSelection,
  CreateLocalBotRequest,
  CreateLocalBotMemoryProposalRequest,
  LocalBotRecord,
  LocalBotContext,
  LocalBotsSnapshot,
  LocalBotStatus,
  LocalBotTable,
  LocalBotTableRow,
  LocalBotTableView,
  UpdateLocalBotGroupMembersRequest,
  LocalWorkspaceSnapshot,
  LocalToolBatchResult,
  LocalToolApprovalPreview,
  LocalMcpInspection,
  LocalMcpServer,
  LocalMcpServerDraft,
  LocalNotificationRoute,
  LocalProjectFingerprint,
  LocalPilotReport,
  LocalSchedule,
  RoutineActivityItem,
  ModelManagerAction,
  ProductPlanPayload,
  SaveLocalEventRoutineRequest,
  SaveLocalScheduleRequest,
  SaveLocalBotMemoryRequest,
  ReviewLocalBotMemoryProposalRequest,
  ReviewImportedBotSkillRequest,
  SaveLocalBotSkillRequest,
  ScheduleOccurrenceStatus,
  ShowLocalNotificationRequest,
  ClaimedEventRoutineOccurrence,
  ClaimedScheduleOccurrence,
  EventRoutineOccurrenceStatus,
  FinishLocalBotDelegationTargetRequest,
  ProviderModel,
  ProviderCredentialStatus,
  ProviderProbe,
  ProviderRunEvent,
  ProviderTaskResult,
  RunningComputerApp,
  SaveComputerAppScopeRequest,
  SaveProviderApiKeyRequest,
  StartLocalBotDelegationTargetRequest,
  UpdateLocalBotEnginePolicyRequest,
  UpdateLocalBotGoalRequest,
  UpdateLocalBotProfileRequest,
  UpdateLocalBotRoutinesRequest,
  UpdateRoutineAutonomyPolicyRequest,
  UnexpectedActionCategory,
} from "./contracts";
import { normalizeBotBrowserDomains, preferredProviderModel } from "./bot-policy";
import type { ToolRuntimeAdapter } from "@/lib/tool-runtime-adapter";
import { providerRunReceiptSummary, recordableProviderRunEvents } from "./provider-run-live";
import { botMemorySafetyError, createBotGoal } from "./bot-initiative";
import builtinSkillManifests from "../builtin-skills.json";

const FALLBACK_STORAGE_KEY = "codelit.mac.m0.workspace.v1";
const FALLBACK_BOTS_KEY = "codelit.mac.bots.v1";
const FALLBACK_BOT_MEMORIES_KEY = "codelit.mac.bot-memories.v1";
const FALLBACK_BOT_MEMORY_PROPOSALS_KEY = "codelit.mac.bot-memory-proposals.v1";
const FALLBACK_BOT_SKILLS_KEY = "codelit.mac.bot-skills.v1";
const FALLBACK_BOT_DELEGATIONS_KEY = "codelit.mac.bot-delegations.v1";
const FALLBACK_BOT_GROUPS_KEY = "codelit.mac.bot-groups.v1";
const FALLBACK_BOT_DATA_KEY = "codelit.mac.bot-data.v1";
const FALLBACK_AUTONOMY_POLICY_KEY = "codelit.mac.autonomy-policy.v1";
const BOT_AVATAR_PRESETS: readonly BotAvatarPreset[] = [
  "spark",
  "orbit",
  "mountain",
  "ember",
  "prism",
  "wave",
];
const DEFAULT_BOT_PROVIDERS: BotEnginePolicy["allowedProviders"] = [
  "mlx", "codex", "copilot", "antigravity", "ollama", "lmstudio",
  "openai", "anthropic", "gemini",
];
const BOT_AVATAR_PNG_PREFIX = "data:image/png;base64,";
const MAX_BOT_AVATAR_PNG_BYTES = 262_144;
const MAX_BOT_AVATAR_BASE64_CHARS = Math.ceil(MAX_BOT_AVATAR_PNG_BYTES / 3) * 4;
const METERED_API_PROVIDERS = new Set(["openai", "anthropic", "gemini"]);

interface NativeToolStep {
  id: string;
  tools: string[];
}

function defaultBotAvatar(botId: string): BotAvatarSpec {
  let hash = 0;
  for (const character of botId) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  const preset = BOT_AVATAR_PRESETS[Math.abs(hash) % BOT_AVATAR_PRESETS.length] || "spark";
  return { kind: "preset", preset };
}

function validatedBotAvatar(avatar: BotAvatarSpec): BotAvatarSpec {
  if (avatar.kind === "preset") {
    if (!BOT_AVATAR_PRESETS.includes(avatar.preset)) {
      throw new Error("That bot avatar preset is unavailable.");
    }
    return { kind: "preset", preset: avatar.preset };
  }
  if (!avatar.dataUrl.startsWith(BOT_AVATAR_PNG_PREFIX)) {
    throw new Error("Bot avatar images must be PNG files.");
  }
  const payload = avatar.dataUrl.slice(BOT_AVATAR_PNG_PREFIX.length);
  if (
    payload.length === 0
    || payload.length > MAX_BOT_AVATAR_BASE64_CHARS
    || payload.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)
  ) {
    throw new Error("The bot avatar PNG is invalid or too large.");
  }
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    throw new Error("The bot avatar PNG is invalid or too large.");
  }
  if (binary.length > MAX_BOT_AVATAR_PNG_BYTES || binary.length < 33) {
    throw new Error("The bot avatar PNG is invalid or too large.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const chunkLength = ((bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0;
  const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
  const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
  if (
    !signature.every((byte, index) => bytes[index] === byte)
    || chunkLength !== 13
    || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
    || width !== 256
    || height !== 256
  ) {
    throw new Error("Bot avatar images must be 256 by 256 pixel PNG files.");
  }
  return { kind: "image", dataUrl: avatar.dataUrl };
}

function storedBotAvatar(value: unknown, botId: string): BotAvatarSpec {
  try {
    if (value && typeof value === "object") return validatedBotAvatar(value as BotAvatarSpec);
  } catch {
    // Replace malformed preview-only data with the deterministic preset.
  }
  return defaultBotAvatar(botId);
}

function normalizedBotName(value: string) {
  const name = value.trim();
  if (
    name.length === 0
    || new TextEncoder().encode(name).length > 64
    || /[\u0000-\u001f\u007f-\u009f]/.test(name)
  ) {
    throw new Error("The local run bot name is invalid.");
  }
  return name;
}

interface NativeToolContext {
  handoff: string;
}

interface NativeToolResolution {
  context: string[];
  completedTools: LocalToolBatchResult["completedTools"];
  browserProofs: LocalToolBatchResult["browserProofs"];
  failure?: NonNullable<LocalToolBatchResult["failure"]>;
}

interface NativeToolExecutionConfig {
  approvalSha256?: string;
  toolInputs?: Record<string, Record<string, unknown>>;
  browserSessionId?: string;
  browserProjectId?: string;
}

export function isNativeRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function now() {
  return new Date().toISOString();
}

function nextId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createReference(
  kind: WorkspaceArtifactRef["kind"],
  id: string,
  title: string,
  createdAt: string,
): WorkspaceArtifactRef {
  return {
    kind,
    id,
    version: "v1",
    projectId: "local-project",
    title,
    editorHref: `/local/${kind}/${id}`,
    createdAt,
  };
}

function createFallbackSnapshot(): LocalWorkspaceSnapshot {
  const createdAt = now();
  const references = [
    createReference("product-plan", "artifact-product-local", "Release outcome plan", createdAt),
    createReference("architecture", "artifact-architecture-local", "Local release architecture", createdAt),
    createReference("agent-team", "artifact-agent-local", "Local release team", createdAt),
    createReference("plan-ship", "artifact-plan-ship-local", "Plan and ship checklist", createdAt),
    createReference("receipt", "artifact-receipt-local", "Local run receipts", createdAt),
  ];
  const thread: WorkspaceThread = {
    id: "local-welcome",
    ownerUid: "local-device",
    workspaceId: "local-workspace",
    projectId: "local-project",
    title: "Local release workspace",
    status: "idle",
    latestBlockSequence: 4,
    activeArtifactRefs: references,
    createdAt,
    updatedAt: createdAt,
  };
  const blocks: ThreadBlock[] = [
    {
      id: "block-welcome",
      sequence: 1,
      createdAt,
      type: "assistant-message",
      text: "Your local workspace is ready. Choose an artifact or describe what you want to build.",
    },
    ...references.slice(0, 3).map((artifact, index): ThreadBlock => ({
      id: `block-artifact-${artifact.kind}`,
      sequence: index + 2,
      createdAt,
      type: "artifact",
      artifact,
      summary: [
        "Shape the outcome before implementation.",
        "Map the system, boundaries, and operational path.",
        "Coordinate a local team with explicit handoffs.",
      ][index],
    })),
  ];
  const payloads: Record<string, AgentTeamPayload | ProductPlanPayload | ArchitecturePayload | object> = {
    "product-plan": {
      problem: "Turn a release request into one bounded, reviewable outcome.",
      audience: "Small product and engineering teams",
      outcomes: ["A scoped release", "Visible acceptance checks", "A clear owner"],
      milestones: ["Define", "Build", "Verify", "Ship"],
    },
    architecture: {
      summary: "A local-first workflow with explicit boundaries and recoverable evidence.",
      components: [
        { id: "input", name: "Thread", detail: "Intent and artifact context" },
        { id: "runtime", name: "Local runtime", detail: "Provider and tool adapters" },
        { id: "evidence", name: "Receipt store", detail: "SQLite event history" },
      ],
    },
    "agent-team": {
      goal: "Inspect, patch, and verify one bounded repository change on this Mac.",
      agents: [
        {
          id: "inspector",
          name: "Repository Inspector",
          role: "Starts with FILES: followed by up to eight exact relative paths, then explains the smallest safe change.",
          provider: "codex",
          model: "default",
          tools: ["Selected folder", "Git read"],
        },
        {
          id: "author",
          name: "Patch Author",
          role: "Produces one bounded unified Git diff, beginning with diff --git, and no unrelated edits.",
          provider: "codex",
          model: "default",
          tools: ["Selected files"],
        },
        {
          id: "applier",
          name: "Patch Review",
          role: "Stages the exact proposed diff, waits for approval, and applies only that reviewed patch.",
          provider: "codex",
          model: "default",
          tools: ["Apply approved patch"],
        },
        {
          id: "verifier",
          name: "Change Verifier",
          role: "Checks the applied diff and reports concrete evidence or a safe repair step.",
          provider: "claude",
          model: "default",
          tools: ["Diff read", "Local checks"],
        },
      ],
      handoffs: [
        { from: "inspector", to: "author", label: "Smallest change" },
        { from: "author", to: "applier", label: "Patch ready" },
        { from: "applier", to: "verifier", label: "Applied for verification" },
      ],
    },
    "plan-ship": { steps: ["Confirm scope", "Run checks", "Review evidence", "Approve shipment"] },
    receipt: { status: "empty", summary: "No local run has completed yet." },
  };
  return {
    thread,
    blocks,
    artifacts: references.map((reference) => ({
      artifactId: reference.id,
      kind: reference.kind,
      version: reference.version,
      title: reference.title,
      projectId: reference.projectId,
      payload: payloads[reference.kind],
      createdAt,
    })),
    runEvents: [],
    runCheckpoints: [],
    approvals: [],
    receipts: [],
    artifactFiles: [],
    workspaceFolder: null,
    databasePath: "Browser preview storage",
  };
}

function readFallbackSnapshot() {
  const stored = localStorage.getItem(FALLBACK_STORAGE_KEY);
  if (!stored) {
    const snapshot = createFallbackSnapshot();
    localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(snapshot));
    return snapshot;
  }
  try {
    const snapshot = JSON.parse(stored) as LocalWorkspaceSnapshot;
    return {
      ...snapshot,
      runCheckpoints: Array.isArray(snapshot.runCheckpoints) ? snapshot.runCheckpoints : [],
      approvals: Array.isArray(snapshot.approvals) ? snapshot.approvals : [],
    };
  } catch {
    const snapshot = createFallbackSnapshot();
    localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(snapshot));
    return snapshot;
  }
}

function writeFallbackSnapshot(snapshot: LocalWorkspaceSnapshot) {
  const bots = localStorage.getItem(FALLBACK_BOTS_KEY);
  if (bots) {
    try {
      const catalog = JSON.parse(bots) as LocalBotsSnapshot;
      const owner = catalog.bots.find((candidate) => candidate.threadId === snapshot.thread.id);
      if (owner) {
        localStorage.setItem(`${FALLBACK_BOTS_KEY}.${owner.id}`, JSON.stringify(snapshot));
      }
      if (owner?.id === catalog.activeBot.id) {
        localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(snapshot));
        localStorage.setItem(FALLBACK_BOTS_KEY, JSON.stringify({ ...catalog, workspace: snapshot }));
      }
      if (owner) return snapshot;
    } catch {
      // A malformed preview catalog will be replaced on the next bootstrap.
    }
  }
  localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export async function bootstrapWorkspace() {
  if (isNativeRuntime()) {
    return invoke<LocalWorkspaceSnapshot>("bootstrap_local_workspace");
  }
  return readFallbackSnapshot();
}

function fallbackStarterBot(snapshot: LocalWorkspaceSnapshot): LocalBotsSnapshot {
  const createdAt = now();
  const thread: WorkspaceThread = {
    ...snapshot.thread,
    id: "thread-bot-codelit",
    title: "Codelit",
    status: "idle",
    latestBlockSequence: 1,
    activeArtifactRefs: [],
    createdAt,
    updatedAt: createdAt,
  };
  const workspace: LocalWorkspaceSnapshot = {
    ...snapshot,
    thread,
    blocks: [{
      id: "block-welcome-bot-codelit",
      sequence: 1,
      createdAt,
      type: "assistant-message",
      text: "I'm Codelit. I investigate your local projects and turn a request into a clear, verifiable next step. Give me one outcome and I will start with the safest useful step.",
    }],
    runEvents: [],
    runCheckpoints: [],
    approvals: [],
    receipts: [],
  };
  const bot = createFallbackBotRecord({
    id: "bot-codelit",
    name: "Codelit",
    job: "I investigate your local projects and turn a request into a clear, verifiable next step.",
    createdAt,
  }, thread.id);
  return { bots: [bot], activeBot: bot, workspace };
}

function createFallbackBotRecord(request: CreateLocalBotRequest, threadId: string): LocalBotRecord {
  const name = normalizedBotName(request.name);
  const avatar = request.avatar
    ? validatedBotAvatar(request.avatar)
    : defaultBotAvatar(request.id);
  return {
    id: request.id,
    threadId,
    currentVersion: 1,
    name,
    status: "sleeping",
    latestStatus: "Ready for a task",
    spec: {
      schemaVersion: 1,
      botId: request.id,
      version: 1,
      name,
      job: request.job.trim(),
      instructions: [
        "Start with the smallest useful result.",
        "Use only approved local context and identify uncertainty.",
        "Never claim an action happened unless a receipt confirms it.",
      ],
      enginePolicy: {
        mode: "auto",
        allowedProviders: [...DEFAULT_BOT_PROVIDERS],
        allowMeteredFallback: false,
      },
      capabilityIds: ["conversation", "project-read", "browser-read"],
      permissionPolicy: {
        approvalMode: "ask",
        browserDomains: [],
        projectAccess: "ask",
        browserAccess: "ask",
        writeActions: "always-ask",
        computerUse: "ask",
      },
      autonomyPolicy: { mode: "manual", maxActionsPerRun: 8, allowBackground: false },
      memoryPolicy: { mode: "proposals", scopes: ["bot"], proposalReview: "required" },
      goal: createBotGoal(request.job, request.createdAt, `goal-${request.id}`),
      routineIds: [],
      appearance: { avatar },
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    },
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  };
}

function normalizeFallbackBot(bot: LocalBotRecord): LocalBotRecord {
  const approvalMode = bot.spec.permissionPolicy.approvalMode === "safe-auto"
    ? "safe-auto"
    : "ask";
  const rawBrowserDomains = Array.isArray(bot.spec.permissionPolicy.browserDomains)
    ? bot.spec.permissionPolicy.browserDomains
    : [];
  const browserDomains = normalizeBotBrowserDomains(rawBrowserDomains);
  const browserDomainsAreNormalized = browserDomains.length === rawBrowserDomains.length
    && browserDomains.every((domain, index) => domain === rawBrowserDomains[index]);
  const avatar = storedBotAvatar(bot.spec.appearance?.avatar, bot.id);
  const appearanceIsNormalized = bot.spec.appearance?.avatar?.kind === avatar.kind
    && (avatar.kind === "preset"
      ? bot.spec.appearance?.avatar?.kind === "preset"
        && bot.spec.appearance.avatar.preset === avatar.preset
      : bot.spec.appearance?.avatar?.kind === "image"
        && bot.spec.appearance.avatar.dataUrl === avatar.dataUrl);
  const legacyProviders = [...bot.spec.enginePolicy.allowedProviders].sort().join(",")
    === ["codex", "mlx", "ollama"].sort().join(",");
  const enginePolicy: BotEnginePolicy = {
    ...bot.spec.enginePolicy,
    allowedProviders: bot.spec.enginePolicy.mode === "auto" && legacyProviders
      ? DEFAULT_BOT_PROVIDERS
      : bot.spec.enginePolicy.allowedProviders,
    allowMeteredFallback: bot.spec.enginePolicy.allowMeteredFallback === true,
  };
  const engineIsNormalized = enginePolicy.allowedProviders === bot.spec.enginePolicy.allowedProviders
    && enginePolicy.allowMeteredFallback === bot.spec.enginePolicy.allowMeteredFallback;
  const goal = bot.spec.goal || createBotGoal(bot.spec.job, bot.createdAt, `goal-${bot.id}`);
  if (bot.spec.permissionPolicy.approvalMode === approvalMode
    && browserDomainsAreNormalized
    && appearanceIsNormalized
    && engineIsNormalized
    && goal === bot.spec.goal) return bot;
  return {
    ...bot,
    spec: {
      ...bot.spec,
      permissionPolicy: { ...bot.spec.permissionPolicy, approvalMode, browserDomains },
      enginePolicy,
      goal,
      appearance: { avatar },
    },
  };
}

function readFallbackBots(): LocalBotsSnapshot {
  const stored = localStorage.getItem(FALLBACK_BOTS_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as LocalBotsSnapshot;
      const bots = parsed.bots.map(normalizeFallbackBot);
      const activeBot = bots.find((bot) => bot.id === parsed.activeBot.id)
        || normalizeFallbackBot(parsed.activeBot);
      return writeFallbackBots({ ...parsed, bots, activeBot });
    } catch {
      localStorage.removeItem(FALLBACK_BOTS_KEY);
    }
  }
  const snapshot = fallbackStarterBot(readFallbackSnapshot());
  localStorage.setItem(FALLBACK_BOTS_KEY, JSON.stringify(snapshot));
  return snapshot;
}

function writeFallbackBots(snapshot: LocalBotsSnapshot) {
  localStorage.setItem(FALLBACK_BOTS_KEY, JSON.stringify(snapshot));
  return snapshot;
}

export async function bootstrapBots(): Promise<LocalBotsSnapshot> {
  if (isNativeRuntime()) return invoke<LocalBotsSnapshot>("bootstrap_local_bots");
  return readFallbackBots();
}

export async function createLocalBot(request: CreateLocalBotRequest): Promise<LocalBotsSnapshot> {
  if (isNativeRuntime()) return invoke<LocalBotsSnapshot>("create_local_bot", { request });
  const current = readFallbackBots();
  const threadId = `thread-${request.id}`;
  const bot = createFallbackBotRecord(request, threadId);
  localStorage.setItem(`${FALLBACK_BOTS_KEY}.${current.activeBot.id}`, JSON.stringify(current.workspace));
  const workspace: LocalWorkspaceSnapshot = {
    ...current.workspace,
    thread: {
      ...current.workspace.thread,
      id: threadId,
      title: bot.name,
      status: "idle",
      latestBlockSequence: 1,
      activeArtifactRefs: [],
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    },
    blocks: [{
      id: `block-welcome-${request.id}`,
      sequence: 1,
      createdAt: request.createdAt,
      type: "assistant-message",
      text: `I'm ${bot.name}. ${bot.spec.job} Give me one outcome and I will start with the safest useful step.`,
    }],
    runEvents: [],
    runCheckpoints: [],
    approvals: [],
    receipts: [],
  };
  return writeFallbackBots({ bots: [bot, ...current.bots], activeBot: bot, workspace });
}

export async function setActiveLocalBot(id: string): Promise<LocalBotsSnapshot> {
  if (isNativeRuntime()) return invoke<LocalBotsSnapshot>("set_active_local_bot", { id });
  const current = readFallbackBots();
  const bot = current.bots.find((candidate) => candidate.id === id);
  if (!bot) throw new Error("That bot is no longer available on this Mac.");
  const stored = localStorage.getItem(`${FALLBACK_BOTS_KEY}.${id}`);
  const workspace = stored ? JSON.parse(stored) as LocalWorkspaceSnapshot : current.workspace;
  localStorage.setItem(`${FALLBACK_BOTS_KEY}.${current.activeBot.id}`, JSON.stringify(current.workspace));
  return writeFallbackBots({ ...current, activeBot: bot, workspace });
}

export async function openLocalBotContext(id: string): Promise<LocalBotContext> {
  if (isNativeRuntime()) return invoke<LocalBotContext>("open_local_bot_context", { id });
  const current = readFallbackBots();
  const bot = current.bots.find((candidate) => candidate.id === id);
  if (!bot) throw new Error("That bot is no longer available on this Mac.");
  if (current.activeBot.id === id) return { bot, workspace: current.workspace };
  const stored = localStorage.getItem(`${FALLBACK_BOTS_KEY}.${id}`);
  if (!stored) throw new Error("That bot conversation is not available in this preview.");
  return { bot, workspace: JSON.parse(stored) as LocalWorkspaceSnapshot };
}

function readFallbackBotGroups() {
  const stored = localStorage.getItem(FALLBACK_BOT_GROUPS_KEY);
  if (!stored) return {} as Record<string, string[]>;
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([ownerBotId, memberBotIds]) => [
      ownerBotId,
      Array.isArray(memberBotIds)
        ? memberBotIds.filter((id): id is string => typeof id === "string").slice(0, 2)
        : [],
    ]));
  } catch {
    localStorage.removeItem(FALLBACK_BOT_GROUPS_KEY);
    return {} as Record<string, string[]>;
  }
}

export async function listLocalBotGroupMembers(ownerBotId: string): Promise<LocalBotRecord[]> {
  if (isNativeRuntime()) {
    return invoke<LocalBotRecord[]>("list_local_bot_group_members", { ownerBotId });
  }
  const catalog = readFallbackBots();
  if (!catalog.bots.some((bot) => bot.id === ownerBotId)) {
    throw new Error("That bot is no longer available on this Mac.");
  }
  const ids = readFallbackBotGroups()[ownerBotId] || [];
  return ids.flatMap((id) => {
    const bot = catalog.bots.find((candidate) => candidate.id === id && candidate.id !== ownerBotId);
    return bot ? [bot] : [];
  });
}

export async function updateLocalBotGroupMembers(
  request: UpdateLocalBotGroupMembersRequest,
): Promise<LocalBotRecord[]> {
  if (isNativeRuntime()) {
    return invoke<LocalBotRecord[]>("update_local_bot_group_members", { request });
  }
  const catalog = readFallbackBots();
  if (!catalog.bots.some((bot) => bot.id === request.ownerBotId)) {
    throw new Error("That bot is no longer available on this Mac.");
  }
  if (request.memberBotIds.length > 2) {
    throw new Error("Keep one or two specialist bots in a conversation.");
  }
  const uniqueIds = new Set(request.memberBotIds);
  if (uniqueIds.size !== request.memberBotIds.length || uniqueIds.has(request.ownerBotId)) {
    throw new Error("Choose one or two different specialist bots.");
  }
  const members = request.memberBotIds.map((id) => {
    const member = catalog.bots.find((bot) => bot.id === id);
    if (!member) throw new Error("One of the selected teammates is no longer available.");
    return member;
  });
  const groups = readFallbackBotGroups();
  groups[request.ownerBotId] = request.memberBotIds;
  localStorage.setItem(FALLBACK_BOT_GROUPS_KEY, JSON.stringify(groups));
  return members;
}

function readFallbackBotDelegations() {
  const stored = localStorage.getItem(FALLBACK_BOT_DELEGATIONS_KEY);
  if (!stored) return [] as LocalBotDelegation[];
  try {
    const values = JSON.parse(stored) as LocalBotDelegation[];
    return Array.isArray(values) ? values : [];
  } catch {
    localStorage.removeItem(FALLBACK_BOT_DELEGATIONS_KEY);
    return [];
  }
}

function writeFallbackBotDelegations(values: LocalBotDelegation[]) {
  localStorage.setItem(FALLBACK_BOT_DELEGATIONS_KEY, JSON.stringify(values));
  return values;
}

function replaceFallbackBotDelegation(value: LocalBotDelegation) {
  const current = readFallbackBotDelegations();
  writeFallbackBotDelegations([value, ...current.filter((candidate) => candidate.id !== value.id)]);
  return value;
}

function fallbackDelegationStatus(targets: LocalBotDelegation["targets"]): LocalBotDelegation["status"] {
  if (targets.every((target) => target.status === "queued")) return "queued";
  if (targets.some((target) => target.status === "running" || target.status === "queued")) return "running";
  if (targets.some((target) => target.status === "awaiting-approval")) return "awaiting-approval";
  if (targets.some((target) => target.status === "completed")) return "completed";
  if (targets.every((target) => target.status === "canceled")) return "canceled";
  return "failed";
}

const LOCAL_RUN_CAPACITY_PREFIX = "LOCAL_RUN_CAPACITY:";
const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio", "mlx"]);

export function localRunCapacityDetail(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.startsWith(LOCAL_RUN_CAPACITY_PREFIX)
    ? message.slice(LOCAL_RUN_CAPACITY_PREFIX.length).trim()
    : null;
}

function fallbackDelegationCapacityIssue(
  request: StartLocalBotDelegationTargetRequest,
  activeTargets: LocalBotDelegation["targets"],
) {
  if (request.providerQuotaState === "exhausted") {
    return "Waiting for this provider's usage limit to reset.";
  }
  const candidateIsLocal = LOCAL_PROVIDER_IDS.has(request.providerId);
  const activeLocal = activeTargets.some((target) => target.providerId
    && LOCAL_PROVIDER_IDS.has(target.providerId));
  if (activeTargets.length > 0 && (candidateIsLocal || activeLocal)) {
    return "Running one specialist at a time while an on-device engine is active.";
  }
  const activeForProvider = activeTargets.filter((target) => target.providerId === request.providerId).length;
  const providerLimit = candidateIsLocal || request.providerQuotaState === "limited" ? 1 : 2;
  if (activeForProvider >= providerLimit) {
    return request.providerQuotaState === "limited"
      ? "Waiting for the current provider run because its available capacity is limited."
      : "Waiting for an active run on the same provider to finish.";
  }
  if (activeTargets.length >= 2) {
    return "Waiting for one active specialist to finish.";
  }
  return null;
}

export async function listLocalBotDelegations(parentBotId?: string) {
  if (isNativeRuntime()) {
    return invoke<LocalBotDelegation[]>("list_local_bot_delegations", { parentBotId });
  }
  return readFallbackBotDelegations()
    .filter((delegation) => !parentBotId || delegation.parentBotId === parentBotId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function createLocalBotDelegation(request: CreateLocalBotDelegationRequest) {
  if (isNativeRuntime()) {
    return invoke<LocalBotDelegation>("create_local_bot_delegation", { request });
  }
  const catalog = readFallbackBots();
  const parent = catalog.bots.find((bot) => bot.id === request.parentBotId);
  const targets = request.targetBotIds.map((id) => catalog.bots.find((bot) => bot.id === id));
  if (!parent || targets.some((target) => !target)) {
    throw new Error("One of the bots in this handoff is no longer available.");
  }
  if (request.targetBotIds.length < 1
    || request.targetBotIds.length > 2
    || new Set(request.targetBotIds).size !== request.targetBotIds.length
    || request.targetBotIds.includes(request.parentBotId)) {
    throw new Error("Choose one or two different specialist bots for this handoff.");
  }
  if (readFallbackBotDelegations().some((candidate) => candidate.id === request.id)) {
    throw new Error("That bot handoff already exists.");
  }
  const delegation: LocalBotDelegation = {
    id: request.id,
    parentBotId: parent.id,
    parentThreadId: parent.threadId,
    parentBotName: parent.name,
    parentBotVersion: parent.currentVersion,
    task: request.task.trim(),
    expectedOutput: request.expectedOutput.trim(),
    sharedMemorySnapshotHash: request.sharedMemorySnapshotHash,
    status: "queued",
    maxParallel: request.targetBotIds.length,
    targets: targets.map((target) => {
      const bot = target!;
      return {
        botId: bot.id,
        threadId: bot.threadId,
        botName: bot.name,
        botVersion: bot.currentVersion,
        status: "queued",
        maxActions: request.maxActions,
        deadlineAt: request.deadlineAt,
        botSnapshot: structuredClone(bot.spec),
        updatedAt: request.createdAt,
      };
    }),
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  };
  return replaceFallbackBotDelegation(delegation);
}

export async function startLocalBotDelegationTarget(
  request: StartLocalBotDelegationTargetRequest,
) {
  if (isNativeRuntime()) {
    return invoke<LocalBotDelegation>("start_local_bot_delegation_target", { request });
  }
  const delegation = readFallbackBotDelegations().find((candidate) => candidate.id === request.id);
  if (!delegation) throw new Error("That bot handoff is no longer available.");
  const catalog = readFallbackBots();
  const target = delegation.targets.find((candidate) => candidate.botId === request.targetBotId);
  const currentBot = catalog.bots.find((candidate) => candidate.id === request.targetBotId);
  if (!target || target.status !== "queued") throw new Error("That specialist handoff has already started.");
  if (Date.parse(request.startedAt) > Date.parse(target.deadlineAt)) {
    const targets = delegation.targets.map((candidate) => candidate.botId === request.targetBotId
      ? {
          ...candidate,
          status: "failed" as const,
          detail: "This handoff reached its deadline before the specialist could start.",
          completedAt: request.startedAt,
          updatedAt: request.startedAt,
        }
      : candidate);
    replaceFallbackBotDelegation({
      ...delegation,
      targets,
      status: fallbackDelegationStatus(targets),
      updatedAt: request.startedAt,
    });
    throw new Error("This handoff reached its deadline before the specialist could start.");
  }
  if (!currentBot || currentBot.currentVersion !== target.botVersion) {
    throw new Error("This specialist changed after the handoff was reviewed. Ask again so the new bot version is explicit.");
  }
  const active = readFallbackBotDelegations()
    .flatMap((candidate) => candidate.targets)
    .filter((candidate) => candidate.status === "running");
  const capacityIssue = fallbackDelegationCapacityIssue(request, active);
  if (capacityIssue) {
    const targets = delegation.targets.map((candidate) => candidate.botId === request.targetBotId
      ? { ...candidate, detail: capacityIssue }
      : candidate);
    replaceFallbackBotDelegation({ ...delegation, targets });
    throw new Error(`${LOCAL_RUN_CAPACITY_PREFIX}${capacityIssue}`);
  }
  const targets = delegation.targets.map((candidate) => candidate.botId === request.targetBotId
    ? {
        ...candidate,
        status: "running" as const,
        runId: request.runId,
        providerId: request.providerId,
        detail: undefined,
        updatedAt: request.startedAt,
      }
    : candidate);
  return replaceFallbackBotDelegation({
    ...delegation,
    targets,
    status: fallbackDelegationStatus(targets),
    updatedAt: request.startedAt,
  });
}

export async function finishLocalBotDelegationTarget(
  request: FinishLocalBotDelegationTargetRequest,
) {
  if (isNativeRuntime()) {
    return invoke<LocalBotDelegation>("finish_local_bot_delegation_target", { request });
  }
  const delegation = readFallbackBotDelegations().find((candidate) => candidate.id === request.id);
  if (!delegation) throw new Error("That bot handoff is no longer available.");
  const status: LocalBotDelegation["status"] = request.outcome === "approval-required"
    ? "awaiting-approval"
    : request.outcome;
  const targets = delegation.targets.map((candidate) => {
    if (candidate.botId !== request.targetBotId) return candidate;
    if (candidate.runId !== request.runId
      || !["running", "awaiting-approval"].includes(candidate.status)) {
      throw new Error("This delegated run is stale or already finished.");
    }
    return {
      ...candidate,
      status,
      ...(request.result ? { result: request.result } : {}),
      ...(request.detail ? { detail: request.detail } : {}),
      ...(status === "awaiting-approval" ? {} : { completedAt: request.finishedAt }),
      updatedAt: request.finishedAt,
    };
  });
  return replaceFallbackBotDelegation({
    ...delegation,
    targets,
    status: fallbackDelegationStatus(targets),
    updatedAt: request.finishedAt,
  });
}

export async function recoverLocalBotDelegations() {
  if (isNativeRuntime()) {
    return invoke<LocalBotDelegation[]>("recover_local_bot_delegations");
  }
  const recoveredAt = now();
  const recovered = readFallbackBotDelegations().map((delegation) => {
    const targets = delegation.targets.map((target) => target.status === "running"
      ? {
          ...target,
          status: "failed" as const,
          detail: "Codelit closed before this specialist finished. Ask the bot again to retry.",
          completedAt: recoveredAt,
          updatedAt: recoveredAt,
        }
      : target);
    if (targets.every((target, index) => target === delegation.targets[index])) return delegation;
    return {
      ...delegation,
      targets,
      status: fallbackDelegationStatus(targets),
      updatedAt: recoveredAt,
    };
  });
  recovered.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return writeFallbackBotDelegations(recovered);
}

export async function cancelLocalBotDelegation(id: string) {
  if (isNativeRuntime()) {
    return invoke<LocalBotDelegation>("cancel_local_bot_delegation", { id });
  }
  const delegation = readFallbackBotDelegations().find((candidate) => candidate.id === id);
  if (!delegation) throw new Error("That bot handoff is no longer available.");
  const canceledAt = now();
  const targets = delegation.targets.map((target) => ["queued", "running", "awaiting-approval"].includes(target.status)
    ? { ...target, status: "canceled" as const, completedAt: canceledAt, updatedAt: canceledAt }
    : target);
  return replaceFallbackBotDelegation({
    ...delegation,
    targets,
    status: fallbackDelegationStatus(targets),
    updatedAt: canceledAt,
  });
}

function isFallbackBotMemory(value: unknown): value is BotMemory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const memory = value as Partial<BotMemory>;
  const ownerIsValid = memory.scope === "workspace"
    ? memory.botId === undefined
    : memory.scope === "bot" && typeof memory.botId === "string" && memory.botId.length > 0;
  return typeof memory.id === "string"
    && memory.id.length > 0
    && ownerIsValid
    && ["preference", "fact", "procedure", "decision"].includes(String(memory.kind))
    && typeof memory.body === "string"
    && memory.body.length > 0
    && memory.body.length <= 1_000
    && botMemorySafetyError(memory.body) === null
    && ["user", "inferred"].includes(String(memory.source))
    && typeof memory.confidence === "number"
    && Number.isFinite(memory.confidence)
    && memory.confidence >= 0
    && memory.confidence <= 1
    && memory.sensitivity === "normal"
    && memory.approvalState === "approved"
    && typeof memory.createdAt === "string"
    && Number.isFinite(Date.parse(memory.createdAt))
    && typeof memory.updatedAt === "string"
    && Number.isFinite(Date.parse(memory.updatedAt))
    && (memory.expiresAt === undefined
      || (typeof memory.expiresAt === "string" && Number.isFinite(Date.parse(memory.expiresAt))));
}

function readFallbackBotMemories() {
  const stored = localStorage.getItem(FALLBACK_BOT_MEMORIES_KEY);
  if (!stored) return [] as BotMemory[];
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isFallbackBotMemory) : [];
  } catch {
    localStorage.removeItem(FALLBACK_BOT_MEMORIES_KEY);
    return [] as BotMemory[];
  }
}

function writeFallbackBotMemories(memories: BotMemory[]) {
  localStorage.setItem(FALLBACK_BOT_MEMORIES_KEY, JSON.stringify(memories));
}

export async function listLocalBotMemories(botId: string): Promise<BotMemory[]> {
  if (isNativeRuntime()) return invoke<BotMemory[]>("list_local_bot_memories", { botId });
  const nowValue = now();
  return readFallbackBotMemories()
    .filter((memory) => (memory.botId === botId || memory.scope === "workspace")
      && (!memory.expiresAt || memory.expiresAt > nowValue))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveLocalBotMemory(request: SaveLocalBotMemoryRequest): Promise<BotMemory> {
  if (isNativeRuntime()) return invoke<BotMemory>("save_local_bot_memory", { request });
  const current = readFallbackBots();
  if (!current.bots.some((bot) => bot.id === request.actorBotId)) {
    throw new Error("That bot is no longer available on this Mac.");
  }
  const body = request.body.trim();
  if (!body || body.length > 1_000) throw new Error("The local run memory is invalid.");
  const safetyError = botMemorySafetyError(body);
  if (safetyError) throw new Error(safetyError);
  const memories = readFallbackBotMemories();
  if (memories.some((memory) => memory.id === request.id)) throw new Error("That memory already exists.");
  const scoped = memories.filter((memory) => request.scope === "workspace"
    ? memory.scope === "workspace"
    : memory.scope === "bot" && memory.botId === request.actorBotId);
  if (scoped.length >= 200) {
    throw new Error("This memory scope already has 200 items. Forget one before adding another.");
  }
  const memory: BotMemory = {
    id: request.id,
    ...(request.scope === "bot" ? { botId: request.actorBotId } : {}),
    scope: request.scope,
    kind: request.kind,
    body,
    source: "user",
    confidence: 1,
    sensitivity: "normal",
    approvalState: "approved",
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  };
  writeFallbackBotMemories([...memories, memory]);
  return memory;
}

function isFallbackBotMemoryProposal(value: unknown): value is BotMemoryProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proposal = value as Partial<BotMemoryProposal>;
  return typeof proposal.id === "string"
    && proposal.id.length > 0
    && typeof proposal.botId === "string"
    && proposal.botId.length > 0
    && proposal.scope === "bot"
    && ["preference", "fact", "procedure", "decision"].includes(String(proposal.kind))
    && typeof proposal.body === "string"
    && proposal.body.length > 0
    && proposal.body.length <= 280
    && botMemorySafetyError(proposal.body) === null
    && proposal.source === "inferred"
    && typeof proposal.confidence === "number"
    && Number.isFinite(proposal.confidence)
    && proposal.confidence >= 0
    && proposal.confidence <= 1
    && proposal.sensitivity === "normal"
    && proposal.approvalState === "pending"
    && typeof proposal.sourceRunId === "string"
    && proposal.sourceRunId.length > 0
    && typeof proposal.createdAt === "string"
    && Number.isFinite(Date.parse(proposal.createdAt))
    && typeof proposal.updatedAt === "string"
    && Number.isFinite(Date.parse(proposal.updatedAt));
}

function readFallbackBotMemoryProposals() {
  const stored = localStorage.getItem(FALLBACK_BOT_MEMORY_PROPOSALS_KEY);
  if (!stored) return [] as BotMemoryProposal[];
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isFallbackBotMemoryProposal) : [];
  } catch {
    localStorage.removeItem(FALLBACK_BOT_MEMORY_PROPOSALS_KEY);
    return [] as BotMemoryProposal[];
  }
}

function writeFallbackBotMemoryProposals(proposals: BotMemoryProposal[]) {
  localStorage.setItem(FALLBACK_BOT_MEMORY_PROPOSALS_KEY, JSON.stringify(proposals));
}

export async function listLocalBotMemoryProposals(botId: string): Promise<BotMemoryProposal[]> {
  if (isNativeRuntime()) {
    return invoke<BotMemoryProposal[]>("list_local_bot_memory_proposals", { botId });
  }
  const current = readFallbackBots();
  if (!current.bots.some((bot) => bot.id === botId)) {
    throw new Error("That bot is no longer available on this Mac.");
  }
  return readFallbackBotMemoryProposals()
    .filter((proposal) => proposal.botId === botId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function createLocalBotMemoryProposal(
  request: CreateLocalBotMemoryProposalRequest,
): Promise<BotMemoryProposal | null> {
  if (isNativeRuntime()) {
    return invoke<BotMemoryProposal | null>("create_local_bot_memory_proposal", { request });
  }
  const current = readFallbackBots();
  if (!current.bots.some((bot) => bot.id === request.actorBotId)) {
    throw new Error("That bot is no longer available on this Mac.");
  }
  const body = request.body.trim();
  if (!body || body.length > 280) throw new Error("The local run memory proposal is invalid.");
  const safetyError = botMemorySafetyError(body);
  if (safetyError) throw new Error(safetyError);
  const proposals = readFallbackBotMemoryProposals();
  const memories = readFallbackBotMemories();
  const duplicate = proposals.some((proposal) => proposal.botId === request.actorBotId
    && proposal.body.localeCompare(body, undefined, { sensitivity: "accent" }) === 0)
    || memories.some((memory) => (memory.botId === request.actorBotId || memory.scope === "workspace")
      && memory.body.localeCompare(body, undefined, { sensitivity: "accent" }) === 0);
  if (duplicate || proposals.filter((proposal) => proposal.botId === request.actorBotId).length >= 3) {
    return null;
  }
  const proposal: BotMemoryProposal = {
    id: request.id,
    botId: request.actorBotId,
    scope: "bot",
    kind: request.kind,
    body,
    source: "inferred",
    confidence: 0.86,
    sensitivity: "normal",
    approvalState: "pending",
    sourceRunId: request.sourceRunId,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  };
  writeFallbackBotMemoryProposals([proposal, ...proposals]);
  return proposal;
}

export async function reviewLocalBotMemoryProposal(
  request: ReviewLocalBotMemoryProposalRequest,
): Promise<BotMemory | null> {
  if (isNativeRuntime()) {
    return invoke<BotMemory | null>("review_local_bot_memory_proposal", { request });
  }
  const proposals = readFallbackBotMemoryProposals();
  const proposal = proposals.find((candidate) => candidate.id === request.id
    && candidate.botId === request.actorBotId);
  if (!proposal) throw new Error("That memory suggestion is no longer waiting for review.");
  if (!(["bot", "workspace"] as string[]).includes(request.scope)) {
    throw new Error("The memory scope is invalid.");
  }
  if (!(["approve", "dismiss"] as string[]).includes(request.decision)) {
    throw new Error("Choose whether to remember or dismiss this suggestion.");
  }
  if (!Number.isFinite(Date.parse(request.reviewedAt))
    || (request.expiresAt && (!Number.isFinite(Date.parse(request.expiresAt))
      || Date.parse(request.expiresAt) <= Date.parse(request.reviewedAt)))) {
    throw new Error("Choose a memory expiry time in the future.");
  }
  if (request.decision === "dismiss") {
    writeFallbackBotMemoryProposals(proposals.filter((candidate) => candidate.id !== proposal.id));
    return null;
  }
  const memories = readFallbackBotMemories();
  const scopeCount = memories.filter((memory) => request.scope === "workspace"
    ? memory.scope === "workspace"
    : memory.scope === "bot" && memory.botId === request.actorBotId).length;
  if (scopeCount >= 200) {
    throw new Error("This memory scope already has 200 items. Forget one before adding another.");
  }
  const memory: BotMemory = {
    id: `memory-reviewed-${proposal.id.replace(/^memory-proposal-/, "")}`,
    ...(request.scope === "bot" ? { botId: request.actorBotId } : {}),
    scope: request.scope,
    kind: proposal.kind,
    body: proposal.body,
    source: "inferred",
    confidence: proposal.confidence,
    sensitivity: "normal",
    approvalState: "approved",
    sourceRunId: proposal.sourceRunId,
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    createdAt: request.reviewedAt,
    updatedAt: request.reviewedAt,
  };
  writeFallbackBotMemories([...memories, memory]);
  writeFallbackBotMemoryProposals(proposals.filter((candidate) => candidate.id !== proposal.id));
  return memory;
}

export async function deleteLocalBotMemory(id: string, actorBotId: string): Promise<BotMemory> {
  const request = { id, actorBotId, deletedAt: now() };
  if (isNativeRuntime()) return invoke<BotMemory>("delete_local_bot_memory", { request });
  const memories = readFallbackBotMemories();
  const memory = memories.find((candidate) => candidate.id === id
    && (candidate.botId === actorBotId || candidate.scope === "workspace"));
  if (!memory) throw new Error("That memory is no longer available to this bot.");
  writeFallbackBotMemories(memories.filter((candidate) => candidate.id !== id));
  return memory;
}

export async function clearLocalBotMemories(actorBotId: string, includeShared = true): Promise<number> {
  const request = { actorBotId, includeShared, deletedAt: now() };
  if (isNativeRuntime()) return invoke<number>("clear_local_bot_memories", { request });
  const current = readFallbackBots();
  if (!current.bots.some((bot) => bot.id === actorBotId)) {
    throw new Error("That bot is no longer available on this Mac.");
  }
  const memories = readFallbackBotMemories();
  const shouldClear = (memory: BotMemory) => memory.botId === actorBotId
    || (includeShared && memory.scope === "workspace");
  const deletedCount = memories.filter(shouldClear).length;
  writeFallbackBotMemories(memories.filter((memory) => !shouldClear(memory)));
  const proposals = readFallbackBotMemoryProposals();
  const deletedProposalCount = proposals.filter((proposal) => proposal.botId === actorBotId).length;
  writeFallbackBotMemoryProposals(proposals.filter((proposal) => proposal.botId !== actorBotId));
  return deletedCount + deletedProposalCount;
}

function normalizeFallbackBotSkill(value: unknown): BotSkill | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const skill = value as Partial<BotSkill>;
  const valid = typeof skill.id === "string"
    && skill.id.length > 0
    && Number.isInteger(skill.version)
    && Number(skill.version) > 0
    && typeof skill.name === "string"
    && skill.name.trim().length >= 2
    && skill.name.length <= 64
    && typeof skill.description === "string"
    && skill.description.length > 0
    && skill.description.length <= 280
    && typeof skill.instructions === "string"
    && skill.instructions.length > 0
    && skill.instructions.length <= 4_000
    && botMemorySafetyError(skill.instructions) === null
    && Array.isArray(skill.capabilityIds)
    && skill.capabilityIds.length <= 16
    && skill.capabilityIds.every((id) => typeof id === "string" && /^[a-zA-Z0-9:_-]+$/.test(id))
    && ["taught", "user-authored", "imported"].includes(String(skill.source))
    && ["reviewed", "unreviewed"].includes(String(skill.trustState))
    && typeof skill.checksum === "string"
    && /^[a-f0-9]{64}$/.test(skill.checksum)
    && typeof skill.createdAt === "string"
    && Number.isFinite(Date.parse(skill.createdAt))
    && typeof skill.updatedAt === "string"
    && Number.isFinite(Date.parse(skill.updatedAt));
  if (!valid) return null;
  return {
    ...(skill as BotSkill),
    inputSchema: Array.isArray(skill.inputSchema) ? skill.inputSchema : [],
    outputSchema: Array.isArray(skill.outputSchema) ? skill.outputSchema : [],
    requiredPermissions: Array.isArray(skill.requiredPermissions) ? skill.requiredPermissions : [],
    effects: Array.isArray(skill.effects) ? skill.effects : [],
    examples: Array.isArray(skill.examples) ? skill.examples : [],
    checks: Array.isArray(skill.checks) ? skill.checks : [],
  };
}

function readFallbackBotSkills() {
  const stored = localStorage.getItem(FALLBACK_BOT_SKILLS_KEY);
  if (!stored) return [] as BotSkill[];
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((value) => {
          const skill = normalizeFallbackBotSkill(value);
          return skill ? [skill] : [];
        })
      : [];
  } catch {
    localStorage.removeItem(FALLBACK_BOT_SKILLS_KEY);
    return [] as BotSkill[];
  }
}

function writeFallbackBotSkills(skills: BotSkill[]) {
  localStorage.setItem(FALLBACK_BOT_SKILLS_KEY, JSON.stringify(skills));
}

async function fallbackSkillChecksum(
  name: string,
  description: string,
  instructions: string,
  capabilityIds: string[],
  inputSchema: BotSkill["inputSchema"] = [],
  outputSchema: BotSkill["outputSchema"] = [],
  requiredPermissions: string[] = [],
  effects: BotSkill["effects"] = [],
  examples: BotSkill["examples"] = [],
  checks: BotSkill["checks"] = [],
  source: BotSkill["source"] = "taught",
  trustState: BotSkill["trustState"] = "reviewed",
) {
  const body = JSON.stringify({
    name,
    schemaVersion: 2,
    description,
    instructions,
    capabilityIds,
    inputSchema,
    outputSchema,
    requiredPermissions,
    effects,
    examples,
    checks,
    source,
    trustState,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fallbackBuiltInBotSkills(): Promise<BotSkill[]> {
  const manifests = builtinSkillManifests as unknown as Array<Omit<
    BotSkill,
    "source" | "trustState" | "checksum" | "createdAt" | "updatedAt"
  >>;
  return Promise.all(manifests.map(async (manifest) => ({
    ...manifest,
    source: "built-in" as const,
    trustState: "packaged" as const,
    checksum: await fallbackSkillChecksum(
      manifest.name,
      manifest.description,
      manifest.instructions,
      manifest.capabilityIds,
      manifest.inputSchema,
      manifest.outputSchema,
      manifest.requiredPermissions,
      manifest.effects,
      manifest.examples,
      manifest.checks,
      "built-in",
      "packaged",
    ),
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  })));
}

export async function listLocalBotSkills(): Promise<BotSkill[]> {
  if (isNativeRuntime()) return invoke<BotSkill[]>("list_local_bot_skills");
  const local = readFallbackBotSkills();
  const localNames = new Set(local.map((skill) => skill.name.trim().toLowerCase()));
  const packaged = (await fallbackBuiltInBotSkills())
    .filter((skill) => !localNames.has(skill.name.trim().toLowerCase()));
  return [...local, ...packaged]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
}

export async function saveLocalBotSkill(request: SaveLocalBotSkillRequest): Promise<BotSkill> {
  if (isNativeRuntime()) return invoke<BotSkill>("save_local_bot_skill", { request });
  const catalog = readFallbackBots();
  if (!catalog.bots.some((bot) => bot.id === request.actorBotId)) {
    throw new Error("That bot is no longer available on this Mac.");
  }
  const name = request.name.trim();
  const description = request.description.trim();
  const instructions = request.instructions.trim();
  if (name.length < 2 || name.length > 64 || !description || description.length > 280
    || !instructions || instructions.length > 4_000) {
    throw new Error("The reusable skill is invalid.");
  }
  const safetyError = botMemorySafetyError(instructions);
  if (safetyError) throw new Error(safetyError.replace("as memory", "in a reusable skill"));
  const skills = readFallbackBotSkills();
  const localNames = new Set(skills.map((skill) => skill.name.trim().toLowerCase()));
  const packaged = (await fallbackBuiltInBotSkills())
    .filter((skill) => !localNames.has(skill.name.trim().toLowerCase()));
  if (packaged.some((skill) => skill.id === request.id)) {
    throw new Error("Packaged skills cannot be overwritten as taught skills.");
  }
  const existing = skills.find((skill) => skill.id === request.id);
  if ([...skills, ...packaged].some((skill) => skill.id !== request.id
    && skill.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) {
    throw new Error("A reusable skill with that name already exists.");
  }
  if (existing && request.expectedVersion !== existing.version) {
    throw new Error("This skill changed before your update was saved. Review it and try again.");
  }
  if (!existing && request.expectedVersion !== undefined && request.expectedVersion !== 0) {
    throw new Error("That skill is no longer available to update.");
  }
  if (!existing && skills.length >= 100) {
    throw new Error("This workspace already has 100 reusable skills. Remove one before teaching another.");
  }
  const version = existing ? existing.version + 1 : 1;
  const inputSchema = request.inputSchema || [];
  const outputSchema = request.outputSchema || [];
  const requiredPermissions = request.requiredPermissions || [];
  const effects = request.effects || [];
  const examples = request.examples || [];
  const checks = request.checks || [];
  const skill: BotSkill = {
    id: request.id,
    version,
    name,
    description,
    instructions,
    capabilityIds: [...request.capabilityIds],
    inputSchema,
    outputSchema,
    requiredPermissions,
    effects,
    examples,
    checks,
    source: "taught",
    trustState: "reviewed",
    checksum: await fallbackSkillChecksum(
      name,
      description,
      instructions,
      request.capabilityIds,
      inputSchema,
      outputSchema,
      requiredPermissions,
      effects,
      examples,
      checks,
    ),
    createdAt: existing?.createdAt || request.createdAt,
    updatedAt: request.createdAt,
  };
  writeFallbackBotSkills([...skills.filter((candidate) => candidate.id !== skill.id), skill]);
  return skill;
}

export async function deleteLocalBotSkill(id: string, actorBotId: string): Promise<BotSkill> {
  const request = { id, actorBotId, deletedAt: now() };
  if (isNativeRuntime()) return invoke<BotSkill>("delete_local_bot_skill", { request });
  const catalog = readFallbackBots();
  if (!catalog.bots.some((bot) => bot.id === actorBotId)) {
    throw new Error("That bot is no longer available on this Mac.");
  }
  if ((await fallbackBuiltInBotSkills()).some((skill) => skill.id === id)) {
    throw new Error("Packaged Codelit skills stay available with the app.");
  }
  const skills = readFallbackBotSkills();
  const skill = skills.find((candidate) => candidate.id === id);
  if (!skill) throw new Error("That reusable skill is no longer available.");
  writeFallbackBotSkills(skills.filter((candidate) => candidate.id !== id));
  return skill;
}

export async function importLocalBotSkill(actorBotId: string): Promise<BotSkill | null> {
  if (!isNativeRuntime()) {
    throw new Error("Skill package import is available inside Codelit for Mac.");
  }
  return invoke<BotSkill | null>("import_local_bot_skill", { actorBotId });
}

export async function reviewImportedBotSkill(
  request: ReviewImportedBotSkillRequest,
): Promise<BotSkill | null> {
  if (isNativeRuntime()) return invoke<BotSkill | null>("review_imported_bot_skill", { request });
  const skills = readFallbackBotSkills();
  const skill = skills.find((candidate) => candidate.id === request.id);
  if (!skill || skill.source !== "imported" || skill.trustState !== "unreviewed") {
    throw new Error("That imported skill is no longer waiting for review.");
  }
  if (skill.version !== request.expectedVersion) {
    throw new Error("This imported skill changed before it was reviewed. Inspect it again.");
  }
  if (request.decision === "discard") {
    writeFallbackBotSkills(skills.filter((candidate) => candidate.id !== skill.id));
    return null;
  }
  const approved: BotSkill = {
    ...skill,
    version: skill.version + 1,
    trustState: "reviewed",
    checksum: await fallbackSkillChecksum(
      skill.name,
      skill.description,
      skill.instructions,
      skill.capabilityIds,
      skill.inputSchema,
      skill.outputSchema,
      skill.requiredPermissions,
      skill.effects,
      skill.examples,
      skill.checks,
      "imported",
      "reviewed",
    ),
    updatedAt: request.reviewedAt,
  };
  writeFallbackBotSkills([...skills.filter((candidate) => candidate.id !== approved.id), approved]);
  return approved;
}

interface FallbackBotData {
  tables: LocalBotTable[];
  rows: Record<string, LocalBotTableRow[]>;
}

function readFallbackBotData(): FallbackBotData {
  try {
    const parsed = JSON.parse(localStorage.getItem(FALLBACK_BOT_DATA_KEY) || "{}") as Partial<FallbackBotData>;
    return {
      tables: Array.isArray(parsed.tables) ? parsed.tables : [],
      rows: parsed.rows && typeof parsed.rows === "object" ? parsed.rows : {},
    };
  } catch {
    localStorage.removeItem(FALLBACK_BOT_DATA_KEY);
    return { tables: [], rows: {} };
  }
}

function writeFallbackBotData(data: FallbackBotData) {
  localStorage.setItem(FALLBACK_BOT_DATA_KEY, JSON.stringify(data));
}

function fallbackTableView(table: LocalBotTable, data: FallbackBotData, limit: number): LocalBotTableView {
  const allRows = data.rows[table.id] || [];
  const rows = [...allRows]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    .slice(0, limit);
  return {
    table: { ...table, rowCount: allRows.length },
    rows,
    totalRows: allRows.length,
    truncated: allRows.length > limit,
  };
}

export async function listLocalBotTables(botId: string): Promise<LocalBotTable[]> {
  if (isNativeRuntime()) return invoke<LocalBotTable[]>("list_local_bot_tables", { botId });
  return readFallbackBotData().tables
    .filter((table) => table.botId === botId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
}

export async function createLocalBotTable(
  request: CreateLocalBotTableRequest,
): Promise<LocalBotTableView> {
  if (isNativeRuntime()) return invoke<LocalBotTableView>("create_local_bot_table", { request });
  const bots = readFallbackBots();
  if (!bots.bots.some((bot) => bot.id === request.botId)) {
    throw new Error("That bot is no longer available on this Mac.");
  }
  const data = readFallbackBotData();
  const botTables = data.tables.filter((table) => table.botId === request.botId);
  if (botTables.length >= 12) throw new Error("This bot already has 12 local tables.");
  if (botTables.some((table) => table.name.toLowerCase() === request.name.trim().toLowerCase())) {
    throw new Error("This bot already has a table with that name.");
  }
  if (!request.columns.length || request.columns.length > 16) {
    throw new Error("A local table needs between 1 and 16 columns.");
  }
  const names = request.columns.map((column) => column.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) throw new Error("Local table column names must be unique.");
  for (const label of [request.name, ...request.columns.map((column) => column.name)]) {
    const safety = botMemorySafetyError(label);
    if (safety) throw new Error("Local tables cannot be used to store credentials, payment details, or recovery secrets.");
  }
  const table: LocalBotTable = {
    id: request.id,
    databaseId: `bot-database:${request.botId}`,
    botId: request.botId,
    name: request.name.trim(),
    version: 1,
    columns: request.columns.map((column) => ({ ...column, name: column.name.trim() })),
    rowCount: 0,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  };
  const next = { tables: [...data.tables, table], rows: { ...data.rows, [table.id]: [] } };
  writeFallbackBotData(next);
  return fallbackTableView(table, next, 200);
}

export async function appendLocalBotTableRow(
  request: AppendLocalBotTableRowRequest,
): Promise<LocalBotTableView> {
  if (isNativeRuntime()) return invoke<LocalBotTableView>("append_local_bot_table_row", { request });
  const data = readFallbackBotData();
  const table = data.tables.find((candidate) => candidate.id === request.tableId && candidate.botId === request.botId);
  if (!table) throw new Error("That local table is no longer available to this bot.");
  const rows = data.rows[table.id] || [];
  if (rows.length >= 1_000) throw new Error("This local table has reached its 1,000 row limit.");
  if (rows.some((row) => row.id === request.id)) throw new Error("That local table row already exists.");
  const values: LocalBotTableRow["values"] = {};
  for (const column of table.columns) {
    const entry = Object.entries(request.values)
      .find(([name]) => name.toLowerCase() === column.name.toLowerCase());
    const value = entry?.[1] ?? null;
    if (typeof value === "string" && botMemorySafetyError(value)) {
      throw new Error("Local tables cannot be used to store credentials, payment details, or recovery secrets.");
    }
    values[column.name] = value;
  }
  if (Object.keys(request.values).some((name) => !table.columns.some((column) => column.name.toLowerCase() === name.toLowerCase()))) {
    throw new Error("That row contains a column this table does not have.");
  }
  const row = { id: request.id, values, createdAt: request.createdAt, updatedAt: request.createdAt };
  const updatedTable = { ...table, rowCount: rows.length + 1, updatedAt: request.createdAt };
  const next = {
    tables: data.tables.map((candidate) => candidate.id === table.id ? updatedTable : candidate),
    rows: { ...data.rows, [table.id]: [...rows, row] },
  };
  writeFallbackBotData(next);
  return fallbackTableView(updatedTable, next, 200);
}

export async function openLocalBotTable(
  botId: string,
  tableId: string,
  limit = 200,
): Promise<LocalBotTableView> {
  if (isNativeRuntime()) return invoke<LocalBotTableView>("open_local_bot_table", { botId, tableId, limit });
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Local table views support between 1 and 200 rows.");
  }
  const data = readFallbackBotData();
  const table = data.tables.find((candidate) => candidate.id === tableId && candidate.botId === botId);
  if (!table) throw new Error("That local table is no longer available to this bot.");
  return fallbackTableView(table, data, limit);
}

function fallbackCsvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function exportLocalBotTableCsv(botId: string, tableId: string): Promise<string | null> {
  if (isNativeRuntime()) return invoke<string | null>("export_local_bot_table_csv", { botId, tableId });
  const data = readFallbackBotData();
  const table = data.tables.find((candidate) => candidate.id === tableId && candidate.botId === botId);
  if (!table) throw new Error("That local table is no longer available to this bot.");
  const rows = data.rows[table.id] || [];
  const csv = [
    table.columns.map((column) => fallbackCsvCell(column.name)).join(","),
    ...rows.map((row) => table.columns.map((column) => fallbackCsvCell(row.values[column.name])).join(",")),
  ].join("\n");
  const fileName = `${table.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "codelit-table"}.csv`;
  const anchor = document.createElement("a");
  anchor.download = fileName;
  anchor.href = URL.createObjectURL(new Blob([`${csv}\n`], { type: "text/csv;charset=utf-8" }));
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  return fileName;
}

export async function updateLocalBotStatus(
  id: string,
  status: LocalBotStatus,
  latestStatus: string,
): Promise<LocalBotRecord> {
  const request = { id, status, latestStatus, updatedAt: now() };
  if (isNativeRuntime()) return invoke<LocalBotRecord>("update_local_bot_status", { request });
  const current = readFallbackBots();
  const bot = current.bots.find((candidate) => candidate.id === id);
  if (!bot) throw new Error("That bot is no longer available on this Mac.");
  const updated = { ...bot, status, latestStatus, updatedAt: request.updatedAt };
  writeFallbackBots({
    ...current,
    bots: current.bots.map((candidate) => candidate.id === id ? updated : candidate),
    activeBot: current.activeBot.id === id ? updated : current.activeBot,
  });
  return updated;
}

export async function updateLocalBotApprovalMode(
  id: string,
  approvalMode: BotPermissionPolicy["approvalMode"],
): Promise<LocalBotRecord> {
  const request = { id, approvalMode, updatedAt: now() };
  if (isNativeRuntime()) {
    return invoke<LocalBotRecord>("update_local_bot_approval_mode", { request });
  }
  const current = readFallbackBots();
  const bot = current.bots.find((candidate) => candidate.id === id);
  if (!bot) throw new Error("That bot is no longer available on this Mac.");
  const nextVersion = bot.currentVersion + 1;
  const updated: LocalBotRecord = {
    ...bot,
    currentVersion: nextVersion,
    spec: {
      ...bot.spec,
      version: nextVersion,
      permissionPolicy: { ...bot.spec.permissionPolicy, approvalMode },
      updatedAt: request.updatedAt,
    },
    updatedAt: request.updatedAt,
  };
  writeFallbackBots({
    ...current,
    bots: current.bots.map((candidate) => candidate.id === id ? updated : candidate),
    activeBot: current.activeBot.id === id ? updated : current.activeBot,
  });
  return updated;
}

export async function updateLocalBotBrowserDomains(
  id: string,
  domains: string[],
  expectedVersion?: number,
): Promise<LocalBotRecord> {
  const normalized = normalizeBotBrowserDomains(domains);
  if (normalized.length !== domains.length) {
    throw new Error("Use up to 16 valid exact or wildcard browser domains.");
  }
  const request = { id, domains: normalized, expectedVersion, updatedAt: now() };
  if (isNativeRuntime()) {
    return invoke<LocalBotRecord>("update_local_bot_browser_domains", { request });
  }
  const current = readFallbackBots();
  const bot = current.bots.find((candidate) => candidate.id === id);
  if (!bot) throw new Error("That bot is no longer available on this Mac.");
  if (expectedVersion !== undefined && bot.currentVersion !== expectedVersion) {
    throw new Error("That bot changed before this update. Review it and try again.");
  }
  if (bot.spec.permissionPolicy.browserDomains.length === normalized.length
    && bot.spec.permissionPolicy.browserDomains.every((domain, index) => domain === normalized[index])) {
    return bot;
  }
  const nextVersion = bot.currentVersion + 1;
  const updated: LocalBotRecord = {
    ...bot,
    currentVersion: nextVersion,
    spec: {
      ...bot.spec,
      version: nextVersion,
      permissionPolicy: { ...bot.spec.permissionPolicy, browserDomains: normalized },
      updatedAt: request.updatedAt,
    },
    updatedAt: request.updatedAt,
  };
  writeFallbackBots({
    ...current,
    bots: current.bots.map((candidate) => candidate.id === id ? updated : candidate),
    activeBot: current.activeBot.id === id ? updated : current.activeBot,
  });
  return updated;
}

export async function updateLocalBotEnginePolicy(
  id: string,
  policy: BotEnginePolicy,
): Promise<LocalBotRecord> {
  const request: UpdateLocalBotEnginePolicyRequest = {
    id,
    mode: policy.mode,
    allowedProviders: [...new Set(policy.allowedProviders)],
    ...(policy.mode === "fixed" && policy.fixedEngine
      ? { fixedEngine: policy.fixedEngine }
      : {}),
    allowMeteredFallback: policy.allowMeteredFallback,
    updatedAt: now(),
  };
  if (isNativeRuntime()) {
    return invoke<LocalBotRecord>("update_local_bot_engine_policy", { request });
  }
  const current = readFallbackBots();
  const bot = current.bots.find((candidate) => candidate.id === id);
  if (!bot) throw new Error("That bot is no longer available on this Mac.");
  const nextVersion = bot.currentVersion + 1;
  const updated: LocalBotRecord = {
    ...bot,
    currentVersion: nextVersion,
    spec: {
      ...bot.spec,
      version: nextVersion,
      enginePolicy: {
        mode: request.mode,
        allowedProviders: request.allowedProviders,
        ...(request.fixedEngine ? { fixedEngine: request.fixedEngine } : {}),
        allowMeteredFallback: request.allowMeteredFallback,
      },
      updatedAt: request.updatedAt,
    },
    updatedAt: request.updatedAt,
  };
  writeFallbackBots({
    ...current,
    bots: current.bots.map((candidate) => candidate.id === id ? updated : candidate),
    activeBot: current.activeBot.id === id ? updated : current.activeBot,
  });
  return updated;
}

export async function updateLocalBotProfile(
  id: string,
  name: string,
  avatar?: BotAvatarSpec,
): Promise<LocalBotRecord> {
  const request: UpdateLocalBotProfileRequest = {
    id,
    name: normalizedBotName(name),
    ...(avatar ? { avatar: validatedBotAvatar(avatar) } : {}),
    updatedAt: now(),
  };
  if (isNativeRuntime()) {
    return invoke<LocalBotRecord>("update_local_bot_profile", { request });
  }
  const current = readFallbackBots();
  const bot = current.bots.find((candidate) => candidate.id === id);
  if (!bot) throw new Error("That bot is no longer available on this Mac.");
  const nextVersion = bot.currentVersion + 1;
  const nextAvatar = request.avatar
    || storedBotAvatar(bot.spec.appearance?.avatar, bot.id);
  const updated: LocalBotRecord = {
    ...bot,
    currentVersion: nextVersion,
    name: request.name,
    spec: {
      ...bot.spec,
      version: nextVersion,
      name: request.name,
      appearance: { avatar: nextAvatar },
      updatedAt: request.updatedAt,
    },
    updatedAt: request.updatedAt,
  };

  let workspace = current.workspace;
  const updateWorkspaceTitle = (candidate: LocalWorkspaceSnapshot): LocalWorkspaceSnapshot => ({
    ...candidate,
    thread: {
      ...candidate.thread,
      title: request.name,
      updatedAt: request.updatedAt,
    },
  });
  if (current.activeBot.id === id) {
    workspace = updateWorkspaceTitle(current.workspace);
  } else {
    const stored = localStorage.getItem(`${FALLBACK_BOTS_KEY}.${id}`);
    if (stored) {
      try {
        localStorage.setItem(
          `${FALLBACK_BOTS_KEY}.${id}`,
          JSON.stringify(updateWorkspaceTitle(JSON.parse(stored) as LocalWorkspaceSnapshot)),
        );
      } catch {
        // A malformed inactive preview workspace will be rebuilt when selected.
      }
    }
  }
  writeFallbackBots({
    ...current,
    workspace,
    bots: current.bots.map((candidate) => candidate.id === id ? updated : candidate),
    activeBot: current.activeBot.id === id ? updated : current.activeBot,
  });
  return updated;
}

export async function updateLocalBotGoal(
  id: string,
  goal: BotGoal,
  expectedVersion?: number,
): Promise<LocalBotRecord> {
  const request: UpdateLocalBotGoalRequest = {
    id,
    goal,
    updatedAt: now(),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
  if (isNativeRuntime()) return invoke<LocalBotRecord>("update_local_bot_goal", { request });
  const current = readFallbackBots();
  const bot = current.bots.find((candidate) => candidate.id === id);
  if (!bot) throw new Error("That bot is no longer available on this Mac.");
  if (expectedVersion !== undefined && bot.currentVersion !== expectedVersion) {
    throw new Error("That bot changed before this update. Review it and try again.");
  }
  const nextVersion = bot.currentVersion + 1;
  const updated: LocalBotRecord = {
    ...bot,
    currentVersion: nextVersion,
    spec: { ...bot.spec, version: nextVersion, goal, updatedAt: request.updatedAt },
    updatedAt: request.updatedAt,
  };
  writeFallbackBots({
    ...current,
    bots: current.bots.map((candidate) => candidate.id === id ? updated : candidate),
    activeBot: current.activeBot.id === id ? updated : current.activeBot,
  });
  return updated;
}

export async function updateLocalBotRoutines(
  id: string,
  routineIds: string[],
  allowBackground: boolean,
): Promise<LocalBotRecord> {
  const request: UpdateLocalBotRoutinesRequest = {
    id,
    routineIds: [...new Set(routineIds)],
    allowBackground,
    updatedAt: now(),
  };
  if (isNativeRuntime()) return invoke<LocalBotRecord>("update_local_bot_routines", { request });
  const current = readFallbackBots();
  const bot = current.bots.find((candidate) => candidate.id === id);
  if (!bot) throw new Error("That bot is no longer available on this Mac.");
  const nextVersion = bot.currentVersion + 1;
  const enabled = request.allowBackground && request.routineIds.length > 0;
  const updated: LocalBotRecord = {
    ...bot,
    currentVersion: nextVersion,
    spec: {
      ...bot.spec,
      version: nextVersion,
      routineIds: request.routineIds,
      autonomyPolicy: {
        ...bot.spec.autonomyPolicy,
        mode: enabled ? "reviewed-routines" : "manual",
        allowBackground: enabled,
      },
      updatedAt: request.updatedAt,
    },
    updatedAt: request.updatedAt,
  };
  writeFallbackBots({
    ...current,
    bots: current.bots.map((candidate) => candidate.id === id ? updated : candidate),
    activeBot: current.activeBot.id === id ? updated : current.activeBot,
  });
  return updated;
}

export async function chooseWorkspaceFolder(
  purpose: "project" | "desktop" = "project",
): Promise<LocalWorkspaceSnapshot | null> {
  if (!isNativeRuntime()) {
    throw new Error("Folder permissions are available only inside Codelit for Mac.");
  }
  return invoke<LocalWorkspaceSnapshot | null>("choose_workspace_folder", { purpose });
}

export async function exportLocalWorkspace(): Promise<string | null> {
  if (!isNativeRuntime()) {
    throw new Error("Workspace export is available only inside Codelit for Mac.");
  }
  return invoke<string | null>("export_local_workspace");
}

export async function getLocalPilotReport(): Promise<LocalPilotReport> {
  if (!isNativeRuntime()) {
    throw new Error("Private product reports are available only inside Codelit for Mac.");
  }
  return invoke<LocalPilotReport>("get_local_pilot_report");
}

export async function recordLocalUnexpectedAction(category: UnexpectedActionCategory): Promise<LocalPilotReport> {
  if (!isNativeRuntime()) {
    throw new Error("Unexpected-action reports are available only inside Codelit for Mac.");
  }
  return invoke<LocalPilotReport>("record_local_unexpected_action", { category });
}

export async function exportLocalPilotReport(): Promise<string | null> {
  if (!isNativeRuntime()) {
    throw new Error("Private product report export is available only inside Codelit for Mac.");
  }
  return invoke<string | null>("export_local_pilot_report");
}

export async function importLocalWorkspace(confirmReplace: boolean): Promise<ImportedWorkspace | null> {
  if (!isNativeRuntime()) {
    throw new Error("Workspace restore is available only inside Codelit for Mac.");
  }
  return invoke<ImportedWorkspace | null>("import_local_workspace", { confirmReplace });
}

export async function deleteLocalWorkspace(confirmation: string): Promise<LocalWorkspaceSnapshot> {
  if (!isNativeRuntime()) {
    throw new Error("Complete local deletion is available only inside Codelit for Mac.");
  }
  return invoke<LocalWorkspaceSnapshot>("delete_local_workspace", { confirmation });
}

export async function probeBackgroundService(): Promise<BackgroundServiceProbe> {
  if (isNativeRuntime()) {
    return invoke<BackgroundServiceProbe>("probe_background_service");
  }
  return {
    status: "unsupported",
    bundled: false,
    detail: "Local schedules are available only inside Codelit for Mac.",
  };
}

export async function setBackgroundWorkEnabled(enabled: boolean): Promise<BackgroundServiceProbe> {
  if (!isNativeRuntime()) {
    throw new Error("Background work is available only inside Codelit for Mac.");
  }
  return invoke<BackgroundServiceProbe>("set_background_work_enabled", { enabled });
}

export async function openBackgroundWorkSettings(): Promise<void> {
  if (!isNativeRuntime()) return;
  await invoke("open_background_work_settings");
}

export async function getBotAutonomyPolicy(timezone: string): Promise<RoutineAutonomyPolicy> {
  if (!isNativeRuntime()) return fallbackAutonomyPolicy(timezone);
  return invoke<RoutineAutonomyPolicy>("get_bot_autonomy_policy", { timezone });
}

export async function updateBotAutonomyPolicy(
  request: UpdateRoutineAutonomyPolicyRequest,
): Promise<RoutineAutonomyPolicy> {
  if (!isNativeRuntime()) {
    const policy = fallbackAutonomyPolicy(request.timezone, request);
    localStorage.setItem(FALLBACK_AUTONOMY_POLICY_KEY, JSON.stringify(policy));
    return policy;
  }
  return invoke<RoutineAutonomyPolicy>("update_bot_autonomy_policy", { request });
}

export async function deliverDueDailyDigest(): Promise<LocalNotificationRoute | null> {
  if (!isNativeRuntime()) return null;
  return invoke<LocalNotificationRoute | null>("deliver_due_daily_digest");
}

export async function listRecentRoutineActivity(): Promise<RoutineActivityItem[]> {
  if (!isNativeRuntime()) return [];
  return invoke<RoutineActivityItem[]>("list_recent_routine_activity");
}

function fallbackAutonomyPolicy(
  timezone: string,
  update?: UpdateRoutineAutonomyPolicyRequest,
): RoutineAutonomyPolicy {
  let stored: Partial<RoutineAutonomyPolicy> = {};
  try {
    stored = JSON.parse(localStorage.getItem(FALLBACK_AUTONOMY_POLICY_KEY) || "{}");
  } catch {
    stored = {};
  }
  const globallyPaused = update?.globallyPaused ?? stored.globallyPaused === true;
  const quietHoursEnabled = update?.quietHoursEnabled ?? stored.quietHoursEnabled === true;
  const quietStart = update?.quietStart || stored.quietStart || "22:00";
  const quietEnd = update?.quietEnd || stored.quietEnd || "07:00";
  const dailyDigestEnabled = update?.dailyDigestEnabled ?? stored.dailyDigestEnabled === true;
  const dailyDigestTime = update?.dailyDigestTime || stored.dailyDigestTime || "17:00";
  const [startHour, startMinute] = quietStart.split(":").map(Number);
  const [endHour, endMinute] = quietEnd.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const current = new Date().getHours() * 60 + new Date().getMinutes();
  const quiet = quietHoursEnabled && start !== end && (start < end
    ? current >= start && current < end
    : current >= start || current < end);
  const status = globallyPaused ? "paused" : quiet ? "quiet-hours" : "active";
  return {
    globallyPaused,
    quietHoursEnabled,
    quietStart,
    quietEnd,
    dailyDigestEnabled,
    dailyDigestTime,
    timezone,
    status,
    statusDetail: globallyPaused
      ? "All routines are paused"
      : quiet
        ? `Quiet until ${quietEnd}`
        : "Routines are active",
    canStartWork: !globallyPaused && !quiet,
    updatedAt: update ? new Date().toISOString() : stored.updatedAt || new Date().toISOString(),
  };
}

export async function probeDesktopCloud(): Promise<DesktopCloudStatus> {
  if (!isNativeRuntime()) {
    return { status: "disconnected", detail: "Codelit Cloud pairing is available only inside Codelit for Mac." };
  }
  return invoke<DesktopCloudStatus>("probe_desktop_cloud");
}

export async function probeDesktopUpdate(): Promise<DesktopUpdateState> {
  if (!isNativeRuntime()) {
    return {
      channel: "development",
      status: "unavailable",
      currentVersion: "development",
      detail: "Signed updates are checked only by release builds.",
    };
  }
  return invoke<DesktopUpdateState>("probe_desktop_update");
}

export async function checkDesktopUpdate(): Promise<DesktopUpdateState> {
  if (!isNativeRuntime()) return probeDesktopUpdate();
  return invoke<DesktopUpdateState>("check_desktop_update");
}

export async function installDesktopUpdate(): Promise<void> {
  if (!isNativeRuntime()) {
    throw new Error("Signed updates are available only inside Codelit for Mac.");
  }
  await invoke("install_desktop_update");
}

export async function startDesktopCloudPairing(): Promise<DesktopPairingStart> {
  if (!isNativeRuntime()) throw new Error("Codelit Cloud pairing is available only inside Codelit for Mac.");
  return invoke<DesktopPairingStart>("start_desktop_cloud_pairing");
}

export async function finishDesktopCloudPairing(): Promise<DesktopCloudStatus> {
  if (!isNativeRuntime()) throw new Error("Codelit Cloud pairing is available only inside Codelit for Mac.");
  return invoke<DesktopCloudStatus>("finish_desktop_cloud_pairing");
}

export async function disconnectDesktopCloud(): Promise<DesktopCloudStatus> {
  if (!isNativeRuntime()) throw new Error("Codelit Cloud pairing is available only inside Codelit for Mac.");
  return invoke<DesktopCloudStatus>("disconnect_desktop_cloud");
}

export async function publishDesktopHostedPromotion(
  envelope: unknown,
): Promise<DesktopPromotionStart> {
  if (!isNativeRuntime()) throw new Error("Hosted promotion is available only inside Codelit for Mac.");
  return invoke<DesktopPromotionStart>("publish_desktop_hosted_promotion", { envelope });
}

export async function syncDesktopCloud(): Promise<DesktopCloudSyncView> {
  if (!isNativeRuntime()) throw new Error("Codelit Cloud sync is available only inside Codelit for Mac.");
  return invoke<DesktopCloudSyncView>("sync_desktop_cloud");
}

export async function listDesktopCloudLinks(): Promise<DesktopCloudLink[]> {
  if (!isNativeRuntime()) return [];
  return invoke<DesktopCloudLink[]>("list_desktop_cloud_links");
}

export async function openDesktopCloudHref(href: string): Promise<void> {
  if (!isNativeRuntime()) throw new Error("Codelit Cloud links are available only inside Codelit for Mac.");
  await invoke("open_desktop_cloud_href", { href });
}

export async function listLocalSchedules(): Promise<LocalSchedule[]> {
  if (!isNativeRuntime()) return [];
  return invoke<LocalSchedule[]>("list_local_schedules");
}

export async function listLocalEventRoutines(): Promise<BotEventRoutine[]> {
  if (!isNativeRuntime()) return [];
  return invoke<BotEventRoutine[]>("list_local_event_routines");
}

export async function saveLocalEventRoutine(
  request: SaveLocalEventRoutineRequest,
): Promise<BotEventRoutine> {
  if (!isNativeRuntime()) {
    throw new Error("Project change routines are available only inside Codelit for Mac.");
  }
  return invoke<BotEventRoutine>("save_local_event_routine", { request });
}

export async function setLocalEventRoutineEnabled(
  id: string,
  enabled: boolean,
  fingerprint?: LocalProjectFingerprint,
): Promise<BotEventRoutine> {
  if (!isNativeRuntime()) {
    throw new Error("Project change routines are available only inside Codelit for Mac.");
  }
  return invoke<BotEventRoutine>("set_local_event_routine_enabled", {
    request: { id, enabled, fingerprint },
  });
}

export async function deleteLocalEventRoutine(id: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await invoke("delete_local_event_routine", { id });
}

export async function claimChangedEventRoutines(
  owner: string,
  fingerprint: LocalProjectFingerprint,
  limit = 1,
): Promise<ClaimedEventRoutineOccurrence[]> {
  if (!isNativeRuntime()) return [];
  return invoke<ClaimedEventRoutineOccurrence[]>("claim_changed_event_routines", {
    request: { owner, fingerprint, limit },
  });
}

export async function markEventRoutineOccurrenceRunning(
  idempotencyKey: string,
  claimToken: string,
): Promise<EventRoutineOccurrenceStatus> {
  return invoke<EventRoutineOccurrenceStatus>("mark_event_routine_occurrence_running", {
    idempotencyKey,
    claimToken,
  });
}

export async function renewEventRoutineOccurrenceLease(
  idempotencyKey: string,
  claimToken: string,
): Promise<EventRoutineOccurrenceStatus> {
  return invoke<EventRoutineOccurrenceStatus>("renew_event_routine_occurrence_lease", {
    idempotencyKey,
    claimToken,
  });
}

export async function eventRoutineExecutionPermitted(
  idempotencyKey: string,
  claimToken: string,
): Promise<boolean> {
  return invoke<boolean>("event_routine_execution_permitted", { idempotencyKey, claimToken });
}

export async function finishEventRoutineOccurrence(
  idempotencyKey: string,
  claimToken: string,
  outcome: "completed" | "failed" | "paused" | "approval-required",
  detail?: string,
): Promise<EventRoutineOccurrenceStatus> {
  return invoke<EventRoutineOccurrenceStatus>("finish_event_routine_occurrence", {
    request: { idempotencyKey, claimToken, outcome, detail },
  });
}

export async function readLocalProjectFingerprint(): Promise<LocalProjectFingerprint> {
  if (!isNativeRuntime()) {
    throw new Error("Project change detection is available only inside Codelit for Mac.");
  }
  return invoke<LocalProjectFingerprint>("read_local_project_fingerprint");
}

export async function saveLocalSchedule(request: SaveLocalScheduleRequest): Promise<LocalSchedule> {
  if (!isNativeRuntime()) {
    throw new Error("Local schedules are available only inside Codelit for Mac.");
  }
  return invoke<LocalSchedule>("save_local_schedule", { request });
}

export async function setLocalScheduleEnabled(id: string, enabled: boolean): Promise<LocalSchedule> {
  if (!isNativeRuntime()) {
    throw new Error("Local schedules are available only inside Codelit for Mac.");
  }
  return invoke<LocalSchedule>("set_local_schedule_enabled", { request: { id, enabled } });
}

export async function deleteLocalSchedule(id: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await invoke("delete_local_schedule", { id });
}

export async function claimDueLocalSchedules(
  owner: string,
  limit = 4,
  online = navigator.onLine,
): Promise<ClaimedScheduleOccurrence[]> {
  if (!isNativeRuntime()) return [];
  return invoke<ClaimedScheduleOccurrence[]>("claim_due_local_schedules", { owner, limit, online });
}

export async function markScheduleOccurrenceRunning(
  idempotencyKey: string,
  claimToken: string,
): Promise<ScheduleOccurrenceStatus> {
  return invoke<ScheduleOccurrenceStatus>("mark_schedule_occurrence_running", {
    idempotencyKey,
    claimToken,
  });
}

export async function renewScheduleOccurrenceLease(
  idempotencyKey: string,
  claimToken: string,
): Promise<ScheduleOccurrenceStatus> {
  return invoke<ScheduleOccurrenceStatus>("renew_schedule_occurrence_lease", {
    idempotencyKey,
    claimToken,
  });
}

export async function scheduleExecutionPermitted(
  idempotencyKey: string,
  claimToken: string,
): Promise<boolean> {
  return invoke<boolean>("schedule_execution_permitted", { idempotencyKey, claimToken });
}

export async function finishScheduleOccurrence(
  idempotencyKey: string,
  claimToken: string,
  outcome: "completed" | "failed" | "paused" | "approval-required",
  detail?: string,
): Promise<ScheduleOccurrenceStatus> {
  return invoke<ScheduleOccurrenceStatus>("finish_schedule_occurrence", {
    request: { idempotencyKey, claimToken, outcome, detail },
  });
}

export async function listScheduleOccurrences(scheduleId: string): Promise<ScheduleOccurrenceStatus[]> {
  if (!isNativeRuntime()) return [];
  return invoke<ScheduleOccurrenceStatus[]>("list_schedule_occurrences", { scheduleId });
}

export async function showLocalNotification(
  request: ShowLocalNotificationRequest,
): Promise<LocalNotificationRoute> {
  return invoke<LocalNotificationRoute>("show_local_notification", { request });
}

export async function takeOpenedLocalNotification(): Promise<LocalNotificationRoute | null> {
  if (!isNativeRuntime()) return null;
  return invoke<LocalNotificationRoute | null>("take_opened_local_notification");
}

export async function consumeLocalNotification(id: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await invoke("consume_local_notification", { id });
}

export async function listLocalMcpServers(): Promise<LocalMcpServer[]> {
  if (!isNativeRuntime()) return [];
  return invoke<LocalMcpServer[]>("list_local_mcp_servers");
}

export async function chooseLocalMcpExecutable(): Promise<string | null> {
  if (!isNativeRuntime()) {
    throw new Error("Local MCP executable selection is available only inside Codelit for Mac.");
  }
  return invoke<string | null>("choose_local_mcp_executable");
}

export async function inspectLocalMcpServer(
  server: LocalMcpServerDraft,
  onEvent: (event: ProviderRunEvent) => void = () => {},
): Promise<LocalMcpInspection> {
  if (!isNativeRuntime()) {
    throw new Error("Local MCP inspection is available only inside Codelit for Mac.");
  }
  const eventChannel = new Channel<ProviderRunEvent>();
  eventChannel.onmessage = onEvent;
  return invoke<LocalMcpInspection>("inspect_local_mcp_server", {
    request: server,
    onEvent: eventChannel,
  });
}

export async function saveLocalMcpServer(
  server: LocalMcpServerDraft,
  approvedTools: string[],
  onEvent: (event: ProviderRunEvent) => void = () => {},
): Promise<LocalMcpServer> {
  if (!isNativeRuntime()) {
    throw new Error("Local MCP servers can be saved only inside Codelit for Mac.");
  }
  const eventChannel = new Channel<ProviderRunEvent>();
  eventChannel.onmessage = onEvent;
  return invoke<LocalMcpServer>("save_local_mcp_server", {
    request: { server, approvedTools, enabled: true },
    onEvent: eventChannel,
  });
}

export async function deleteLocalMcpServer(id: string): Promise<LocalMcpServer[]> {
  if (!isNativeRuntime()) return [];
  return invoke<LocalMcpServer[]>("delete_local_mcp_server", { id });
}

export async function discardPreparedLocalToolApproval(runId: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await invoke("discard_prepared_local_tool_approval", { runId });
}

export const discardPreparedMcpApproval = discardPreparedLocalToolApproval;

export async function openLocalBrowser(request: {
  sessionId: string;
  projectId: string;
  url: string;
  allowedDomains: string[];
  bounds: BrowserBounds;
}): Promise<LocalBrowserSession> {
  if (!isNativeRuntime()) throw new Error("The local Browser panel is available only inside Codelit for Mac.");
  return invoke<LocalBrowserSession>("open_local_browser", { request });
}

export async function resizeLocalBrowser(
  sessionId: string,
  bounds: BrowserBounds,
): Promise<LocalBrowserSession> {
  if (!isNativeRuntime()) throw new Error("The local Browser panel is unavailable.");
  return invoke<LocalBrowserSession>("resize_local_browser", { request: { sessionId, bounds } });
}

export async function setLocalBrowserVisibility(
  sessionId: string,
  visible: boolean,
): Promise<LocalBrowserSession> {
  if (!isNativeRuntime()) throw new Error("The local Browser panel is unavailable.");
  return invoke<LocalBrowserSession>("set_local_browser_visibility", {
    request: { sessionId, visible },
  });
}

export async function previewLocalBrowserNavigation(
  sessionId: string,
  url: string,
): Promise<BrowserNavigationPreview> {
  if (!isNativeRuntime()) throw new Error("The local Browser panel is unavailable.");
  return invoke<BrowserNavigationPreview>("preview_local_browser_navigation", {
    request: { sessionId, url },
  });
}

export async function updateLocalBrowserDomains(
  sessionId: string,
  allowedDomains: string[],
): Promise<LocalBrowserSession> {
  if (!isNativeRuntime()) throw new Error("The local Browser panel is unavailable.");
  return invoke<LocalBrowserSession>("update_local_browser_domains", {
    request: { sessionId, allowedDomains },
  });
}

export async function navigateLocalBrowser(
  sessionId: string,
  url: string,
): Promise<LocalBrowserSession> {
  if (!isNativeRuntime()) throw new Error("The local Browser panel is unavailable.");
  return invoke<LocalBrowserSession>("navigate_local_browser", { request: { sessionId, url } });
}

export async function localBrowserHistory(
  sessionId: string,
  direction: "back" | "forward" | "reload",
): Promise<LocalBrowserSession> {
  if (!isNativeRuntime()) throw new Error("The local Browser panel is unavailable.");
  return invoke<LocalBrowserSession>("browser_history_action", {
    request: { sessionId, direction },
  });
}

export async function armLocalBrowserDownload(sessionId: string): Promise<LocalBrowserSession> {
  if (!isNativeRuntime()) throw new Error("The local Browser panel is unavailable.");
  return invoke<LocalBrowserSession>("arm_local_browser_download", { request: { sessionId } });
}

export async function listQuarantinedBrowserDownloads(
  botId: string,
): Promise<QuarantinedBrowserDownload[]> {
  if (!isNativeRuntime()) return [];
  return invoke<QuarantinedBrowserDownload[]>("list_quarantined_browser_downloads", { botId });
}

export async function releaseQuarantinedBrowserDownload(
  botId: string,
  downloadId: string,
): Promise<string | null> {
  if (!isNativeRuntime()) {
    throw new Error("Browser download release is available only inside Codelit for Mac.");
  }
  return invoke<string | null>("release_quarantined_browser_download", { botId, downloadId });
}

export async function deleteQuarantinedBrowserDownload(
  botId: string,
  downloadId: string,
): Promise<void> {
  if (!isNativeRuntime()) {
    throw new Error("Browser download deletion is available only inside Codelit for Mac.");
  }
  await invoke("delete_quarantined_browser_download", { botId, downloadId });
}

export async function startLocalBrowserTeaching(
  sessionId: string,
): Promise<LocalBrowserTeachingCapture> {
  if (!isNativeRuntime()) {
    throw new Error("Browser task teaching is available in Codelit's notarized Direct build.");
  }
  return invoke<LocalBrowserTeachingCapture>("start_local_browser_teaching", {
    request: { sessionId },
  });
}

export async function captureLocalBrowserTeaching(
  sessionId: string,
): Promise<LocalBrowserTeachingCapture> {
  if (!isNativeRuntime()) throw new Error("Browser task teaching is unavailable.");
  return invoke<LocalBrowserTeachingCapture>("capture_local_browser_teaching", {
    request: { sessionId },
  });
}

export async function finishLocalBrowserTeaching(
  sessionId: string,
): Promise<LocalBrowserTeachingCapture> {
  if (!isNativeRuntime()) throw new Error("Browser task teaching is unavailable.");
  return invoke<LocalBrowserTeachingCapture>("finish_local_browser_teaching", {
    request: { sessionId },
  });
}

export async function dryRunLocalBrowserTeaching(
  sessionId: string,
): Promise<LocalBrowserTeachingDryRun> {
  if (!isNativeRuntime()) throw new Error("Browser task replay checks are unavailable.");
  return invoke<LocalBrowserTeachingDryRun>("dry_run_local_browser_teaching", {
    request: { sessionId },
  });
}

export async function closeLocalBrowser(sessionId: string): Promise<void> {
  if (!isNativeRuntime()) return;
  await invoke("close_local_browser", { request: { sessionId } });
}

export async function probeComputerUseReadiness(): Promise<ComputerUseReadiness> {
  if (isNativeRuntime()) {
    return invoke<ComputerUseReadiness>("probe_computer_use_readiness");
  }
  return {
    available: false,
    accessibility: "unavailable",
    screenRecording: "unavailable",
    ready: false,
    detail: "Computer use is available in Codelit's notarized Direct build.",
  };
}

export async function requestComputerUsePermission(permission: ComputerPermissionKind) {
  if (!isNativeRuntime()) return probeComputerUseReadiness();
  return invoke<ComputerUseReadiness>("request_computer_use_permission", {
    request: { permission },
  });
}

export async function listRunningComputerApps(): Promise<RunningComputerApp[]> {
  if (!isNativeRuntime()) return [];
  return invoke<RunningComputerApp[]>("list_running_computer_apps");
}

export async function listComputerAppScopes(botId: string): Promise<ComputerAppScope[]> {
  if (!isNativeRuntime()) return [];
  return invoke<ComputerAppScope[]>("list_computer_app_scopes", { botId });
}

export async function saveComputerAppScope(request: SaveComputerAppScopeRequest) {
  if (!isNativeRuntime()) {
    throw new Error("Computer use is available in Codelit for Mac.");
  }
  return invoke<ComputerAppScope>("save_computer_app_scope", { request });
}

export async function deleteComputerAppScope(botId: string, bundleId: string) {
  if (!isNativeRuntime()) return false;
  return invoke<boolean>("delete_computer_app_scope", {
    request: { botId, bundleId },
  });
}

export async function inspectComputerApp(botId: string, bundleId: string) {
  if (!isNativeRuntime()) {
    throw new Error("Computer use is available in Codelit for Mac.");
  }
  return invoke<ComputerAppInspection>("inspect_computer_app", {
    request: { botId, bundleId },
  });
}

export async function runComputerAction(
  request: {
    runId: string;
    botId: string;
    bundleId: string;
    action: ComputerSemanticAction;
  },
  onEvent: (event: ProviderRunEvent) => void,
) {
  if (!isNativeRuntime()) {
    throw new Error("Computer use is available in Codelit for Mac.");
  }
  const eventChannel = new Channel<ProviderRunEvent>();
  eventChannel.onmessage = onEvent;
  return invoke<ComputerActionResult>("run_computer_action", {
    request,
    onEvent: eventChannel,
  });
}

export async function takeOverComputerRun(
  runId: string,
  botId: string,
  bundleId: string,
) {
  if (!isNativeRuntime()) return false;
  return invoke<boolean>("take_over_computer_run", {
    runId,
    request: { botId, bundleId },
  });
}

export async function listenForLocalBrowserEvents(
  onEvent: (event: LocalBrowserEvent) => void,
): Promise<UnlistenFn> {
  if (!isNativeRuntime()) return () => {};
  return listen<LocalBrowserEvent>("local-browser-event", ({ payload }) => onEvent(payload));
}

export async function appendThreadMessage(
  snapshot: LocalWorkspaceSnapshot,
  text: string,
  role: "user" | "assistant" = "user",
) {
  const request = {
    threadId: snapshot.thread.id,
    id: nextId("message"),
    sequence: snapshot.thread.latestBlockSequence + 1,
    role,
    text,
    createdAt: now(),
  };
  if (isNativeRuntime()) {
    return invoke<LocalWorkspaceSnapshot>("append_thread_message", { request });
  }
  const block: ThreadBlock = {
    id: request.id,
    sequence: request.sequence,
    createdAt: request.createdAt,
    type: role === "assistant" ? "assistant-message" : "user-message",
    text: request.text.trim(),
  };
  return writeFallbackSnapshot({
    ...snapshot,
    thread: {
      ...snapshot.thread,
      latestBlockSequence: request.sequence,
      updatedAt: request.createdAt,
    },
    blocks: [...snapshot.blocks, block],
  });
}

export async function saveArtifact(
  snapshot: LocalWorkspaceSnapshot,
  artifact: LocalArtifactVersion,
  title: string,
  payload: unknown,
) {
  const request = {
    threadId: snapshot.thread.id,
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    version: `v-${Date.now()}`,
    title,
    projectId: artifact.projectId,
    payload,
    createdAt: now(),
  };
  if (isNativeRuntime()) {
    return invoke<LocalWorkspaceSnapshot>("save_artifact_version", { request });
  }
  return writeFallbackSnapshot({
    ...snapshot,
    thread: {
      ...snapshot.thread,
      updatedAt: request.createdAt,
      activeArtifactRefs: snapshot.thread.activeArtifactRefs.map((reference) =>
        reference.id === request.artifactId
          ? { ...reference, version: request.version, title }
          : reference,
      ),
    },
    artifacts: snapshot.artifacts.map((candidate) =>
      candidate.artifactId === artifact.artifactId
        ? { ...candidate, title, version: request.version, payload, createdAt: request.createdAt }
        : candidate,
    ),
  });
}

export async function beginLocalRun(
  snapshot: LocalWorkspaceSnapshot,
  artifactId: string,
  runId: string,
  selection: { provider: string; model: string },
) {
  const createdAt = now();
  const request = {
    threadId: snapshot.thread.id,
    artifactId,
    runId,
    provider: selection.provider,
    model: selection.model,
    createdAt,
  };
  if (isNativeRuntime()) {
    return invoke<LocalWorkspaceSnapshot>("begin_local_run", { request });
  }
  return writeFallbackSnapshot({
    ...snapshot,
    thread: {
      ...snapshot.thread,
      status: "working",
      activeRunRef: runId,
      updatedAt: createdAt,
    },
    runEvents: [...snapshot.runEvents, {
      runId,
      sequence: snapshot.runEvents.filter((event) => event.runId === runId).length + 1,
      eventType: snapshot.runEvents.some((event) => event.runId === runId)
        ? "run.resumed"
        : "run.queued",
      payload: { status: "running", provider: selection.provider, model: selection.model },
      createdAt,
    }],
  });
}

export async function saveLocalRunCheckpoint(
  snapshot: LocalWorkspaceSnapshot,
  runId: string,
  checkpoint: {
    stepIndex: number;
    handoff: string;
    priorSteps: unknown[];
    gateApproved?: boolean;
    runContext?: unknown;
  },
) {
  const updatedAt = now();
  const request = { runId, ...checkpoint, gateApproved: checkpoint.gateApproved || false, updatedAt };
  if (isNativeRuntime()) {
    return invoke<LocalWorkspaceSnapshot>("save_run_checkpoint", { request });
  }
  const body = {
    stepIndex: checkpoint.stepIndex,
    handoff: checkpoint.handoff,
    priorSteps: checkpoint.priorSteps,
    gateApproved: checkpoint.gateApproved || false,
    ...(checkpoint.runContext === undefined ? {} : { runContext: checkpoint.runContext }),
  };
  return writeFallbackSnapshot({
    ...snapshot,
    runCheckpoints: [
      ...snapshot.runCheckpoints.filter((candidate) => candidate.runId !== runId),
      { runId, stepIndex: checkpoint.stepIndex, body, updatedAt },
    ],
    runEvents: [...snapshot.runEvents, {
      runId,
      sequence: snapshot.runEvents.filter((event) => event.runId === runId).length + 1,
      eventType: "run.checkpoint",
      payload: { status: "checkpoint", stepIndex: checkpoint.stepIndex },
      createdAt: updatedAt,
    }],
  });
}

export async function recordLocalRunApproval(
  snapshot: LocalWorkspaceSnapshot,
  approval: {
    id: string;
    runId: string;
    stepIndex: number;
    status: "awaiting" | "approved" | "held" | "edit" | "denied";
    body: unknown;
  },
) {
  const updatedAt = now();
  const request = { ...approval, updatedAt };
  if (isNativeRuntime()) {
    return invoke<LocalWorkspaceSnapshot>("record_run_approval", { request });
  }
  const current = snapshot.approvals.find((candidate) => candidate.id === approval.id);
  return writeFallbackSnapshot({
    ...snapshot,
    thread: {
      ...snapshot.thread,
      status: approval.status === "awaiting"
        ? "needs-input"
        : approval.status === "approved"
          ? "working"
          : "failed",
      activeRunRef: approval.runId,
      updatedAt,
    },
    approvals: [
      ...snapshot.approvals.filter((candidate) => candidate.id !== approval.id),
      {
        ...approval,
        createdAt: current?.createdAt || updatedAt,
        updatedAt,
      },
    ],
    runEvents: [...snapshot.runEvents, {
      runId: approval.runId,
      sequence: snapshot.runEvents.filter((event) => event.runId === approval.runId).length + 1,
      eventType: approval.status === "awaiting"
        ? "run.approval-required"
        : "run.approval-decided",
      payload: { status: approval.status, approvalId: approval.id, stepIndex: approval.stepIndex },
      createdAt: updatedAt,
    }],
  });
}

function isMeteredApiProvider(provider: string) {
  return METERED_API_PROVIDERS.has(provider);
}

export function isMeteredProviderInvocationStartedEvent(
  event: Pick<ProviderRunEvent, "eventType" | "provider">,
  selection: Pick<IntelligenceSelection, "provider">,
) {
  return event.eventType === "provider-invocation-started"
    && event.provider === selection.provider
    && isMeteredApiProvider(selection.provider);
}

export function providerRunProvenance(
  selection: { provider: string },
  selectionMode: ProviderTaskResult["selectionMode"],
  meteredFallbackAuthorized: boolean,
  providerInvocationStarted: boolean,
): Pick<
  ProviderTaskResult,
  | "selectionMode"
  | "meteredFallbackAuthorized"
  | "meteredProviderInvocationStarted"
  | "billingFallback"
> {
  const meteredProviderInvocationStarted = providerInvocationStarted
    && isMeteredApiProvider(selection.provider);
  const normalizedAuthorization = selectionMode === "auto" && meteredFallbackAuthorized;
  return {
    selectionMode,
    meteredFallbackAuthorized: normalizedAuthorization,
    meteredProviderInvocationStarted,
    billingFallback: selectionMode === "auto"
      && normalizedAuthorization
      && meteredProviderInvocationStarted,
  };
}

function assertRecordableProviderProvenance(result: ProviderTaskResult) {
  if (!(["fixed", "auto"] as const).includes(result.selectionMode)
    || typeof result.meteredFallbackAuthorized !== "boolean"
    || typeof result.meteredProviderInvocationStarted !== "boolean"
    || typeof result.billingFallback !== "boolean") {
    throw new Error("The provider run is missing required selection and billing provenance.");
  }
  const expected = providerRunProvenance(
    { provider: result.provider },
    result.selectionMode,
    result.meteredFallbackAuthorized,
    result.meteredProviderInvocationStarted,
  );
  if (result.meteredFallbackAuthorized && result.selectionMode !== "auto"
    || result.meteredProviderInvocationStarted
      && !isMeteredApiProvider(result.provider)
      && result.provider !== "local-team"
    || result.meteredProviderInvocationStarted
      && result.selectionMode === "auto"
      && !result.meteredFallbackAuthorized
    || result.billingFallback !== expected.billingFallback) {
    throw new Error("The provider run selection and billing provenance is inconsistent.");
  }
}

function providerRunBillingSummary(result: ProviderTaskResult) {
  if (result.billingFallback) {
    return `${result.provider} produced a local receipt after an authorized metered fallback was invoked.`;
  }
  if (result.meteredProviderInvocationStarted) {
    return `${result.provider} produced a local receipt after an explicitly selected metered API was invoked.`;
  }
  if (result.meteredFallbackAuthorized) {
    return `${result.provider} produced a local receipt with metered fallback authorized but no metered provider invocation started.`;
  }
  return `${result.provider} produced a local receipt with no metered provider invocation.`;
}

export async function recordProviderRun(
  snapshot: LocalWorkspaceSnapshot,
  artifactId: string,
  result: ProviderTaskResult,
  events: ProviderRunEvent[],
  receiptDetails?: unknown,
  summaryOverride?: string,
) {
  assertRecordableProviderProvenance(result);
  const terminalType = result.status === "completed"
    ? "completed"
    : result.status === "canceled"
      ? "canceled"
      : "failed";
  const recordedEvents = recordableProviderRunEvents(events)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
  if (!recordedEvents.length || recordedEvents.at(-1)?.eventType !== terminalType) {
    recordedEvents.push({
      runId: result.runId,
      sequence: (recordedEvents.at(-1)?.sequence || 0) + 1,
      eventType: terminalType,
      provider: result.provider,
      model: result.model,
      message: result.text,
      payload: result.structuredOutput,
      createdAt: now(),
    });
  }
  const request = {
    threadId: snapshot.thread.id,
    artifactId,
    runId: result.runId,
    createdAt: now(),
    provider: result.provider,
    model: result.model,
    status: result.status === "completed" || result.status === "canceled" ? result.status : "failed",
    summary: providerRunReceiptSummary(result, summaryOverride),
    selectionMode: result.selectionMode,
    meteredFallbackAuthorized: result.meteredFallbackAuthorized,
    meteredProviderInvocationStarted: result.meteredProviderInvocationStarted,
    billingFallback: result.billingFallback,
    ...(receiptDetails === undefined ? {} : { receiptDetails }),
    events: recordedEvents.map((event, index) => ({
      sequence: index + 1,
      eventType: event.eventType,
      message: event.message,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
  };
  if (isNativeRuntime()) {
    return invoke<LocalWorkspaceSnapshot>("record_local_check", { request });
  }
  const runSequence = snapshot.thread.latestBlockSequence + 1;
  const receiptSequence = runSequence + 1;
  const receiptReference = createReference(
    "receipt",
    "artifact-receipt-local",
    "Local run receipt",
    request.createdAt,
  );
  receiptReference.version = request.runId;
  const blocks: ThreadBlock[] = [
    {
      id: `block-${request.runId}`,
      sequence: runSequence,
      createdAt: request.createdAt,
      type: "run",
      runId: request.runId,
      label: `${result.provider} local run`,
      detail: request.summary,
      status: result.status === "completed" ? "completed" : result.status === "canceled" ? "stopped" : "failed",
    },
    {
      id: `block-receipt-${request.runId}`,
      sequence: receiptSequence,
      createdAt: request.createdAt,
      type: "receipt",
      artifact: receiptReference,
      summary: providerRunBillingSummary(result),
    },
  ];
  const receipt = {
    id: `receipt-${request.runId}`,
    runId: request.runId,
    artifactId,
    body: {
      status: result.status,
      provider: result.provider,
      model: result.model,
      selectionMode: result.selectionMode,
      meteredFallbackAuthorized: result.meteredFallbackAuthorized,
      meteredProviderInvocationStarted: result.meteredProviderInvocationStarted,
      billingFallback: result.billingFallback,
      ...(receiptDetails === undefined ? {} : { details: receiptDetails }),
    },
    createdAt: request.createdAt,
  };
  return writeFallbackSnapshot({
    ...snapshot,
    thread: {
      ...snapshot.thread,
      status: result.status === "completed" ? "completed" : "failed",
      latestBlockSequence: receiptSequence,
      activeRunRef: request.runId,
      updatedAt: request.createdAt,
    },
    blocks: [...snapshot.blocks, ...blocks],
    runEvents: [...snapshot.runEvents, ...recordedEvents.map((event, index) => ({
      runId: event.runId,
      sequence: index + 1,
      eventType: `run.${event.eventType}`,
      payload: {
        status: event.eventType,
        provider: event.provider,
        model: event.model,
        message: event.message,
        payload: event.payload,
      },
      createdAt: event.createdAt,
    }))],
    receipts: [...snapshot.receipts, receipt],
  });
}

export async function probeLocalProviders(): Promise<ProviderProbe[]> {
  if (isNativeRuntime()) {
    return invoke<ProviderProbe[]>("probe_providers");
  }
  const missingProvider = (
    id: ProviderProbe["id"],
    label: string,
    family: ProviderProbe["family"],
    distribution: ProviderProbe["distribution"],
    detail = "Provider discovery is available in the native app.",
  ): ProviderProbe => ({
    id,
    label,
    family,
    authKind: family === "api" ? "api-key" : family === "local" ? "none" : "provider-owned",
    billingMode: family === "api" ? "metered" : family === "local" ? "local" : "subscription",
    distribution,
    status: family === "api" ? "signed-out" : "not-installed",
    health: family === "api" ? "signed-out" : "missing",
    canRun: false,
    capabilities: family === "local" ? ["local-models"] : [],
    models: [],
    quota: {
      state: family === "local" ? "not-applicable" : "unknown",
      detail: family === "api" ? "Uses your metered provider account." : "Available only in the native app.",
    },
    detail,
  });
  return [
    missingProvider("codex", "Codex", "subscription", "direct-only"),
    missingProvider("copilot", "GitHub Copilot", "subscription", "direct-only"),
    {
      ...missingProvider("claude", "Claude Code", "subscription", "direct-only"),
      status: "blocked-by-policy",
      health: "policy-blocked",
      detail: "Claude subscription execution is not approved for this third-party app.",
    },
    {
      ...missingProvider("antigravity", "Gemini subscription", "subscription", "unsupported"),
      status: "blocked-by-policy",
      health: "policy-blocked",
      detail: "Antigravity cannot yet isolate provider sign-in from ambient CLI configuration.",
    },
    missingProvider("openai", "OpenAI API", "api", "all", "Add an OpenAI API key in Codelit for Mac."),
    missingProvider("anthropic", "Anthropic API", "api", "all", "Add an Anthropic API key in Codelit for Mac."),
    missingProvider("gemini", "Gemini API", "api", "all", "Add a Gemini API key in Codelit for Mac."),
    missingProvider("ollama", "Ollama", "local", "direct-only"),
    missingProvider("lmstudio", "LM Studio", "local", "direct-only"),
    missingProvider(
      "mlx",
      "Built-in MLX",
      "local",
      "all",
      "The built-in model is packaged only in the native Apple Silicon build.",
    ),
  ];
}

export async function probeProviderApiKeys(): Promise<ProviderCredentialStatus[]> {
  if (!isNativeRuntime()) {
    return (["openai", "anthropic", "gemini"] as const).map((provider) => ({
      provider,
      account: "default",
      configured: false,
      available: true,
      detail: "No API key is stored in macOS Keychain.",
    }));
  }
  return invoke<ProviderCredentialStatus[]>("probe_provider_api_keys");
}

export async function saveProviderApiKey(
  request: SaveProviderApiKeyRequest,
): Promise<ProviderCredentialStatus> {
  if (!isNativeRuntime()) {
    throw new Error("API keys can be saved only inside Codelit for Mac.");
  }
  return invoke<ProviderCredentialStatus>("save_provider_api_key", { request });
}

export async function deleteProviderApiKey(
  provider: ProviderCredentialStatus["provider"],
): Promise<ProviderCredentialStatus> {
  if (!isNativeRuntime()) {
    throw new Error("API keys can be removed only inside Codelit for Mac.");
  }
  return invoke<ProviderCredentialStatus>("delete_provider_api_key", {
    request: { provider },
  });
}

export async function openCodexSignIn(): Promise<void> {
  if (!isNativeRuntime()) {
    throw new Error("Codex sign-in setup is available only inside Codelit for Mac.");
  }
  await invoke<void>("open_codex_sign_in");
}

export async function openCopilotSignIn(): Promise<void> {
  if (!isNativeRuntime()) {
    throw new Error("GitHub Copilot sign-in setup is available only inside Codelit for Mac.");
  }
  await invoke<void>("open_copilot_sign_in");
}

export async function openProviderSetup(provider: ProviderProbe["id"]): Promise<void> {
  if (!isNativeRuntime()) {
    throw new Error("Provider setup is available only inside Codelit for Mac.");
  }
  await invoke<void>("open_provider_setup", { provider });
}

export async function runIntelligenceTask(
  selection: IntelligenceSelection,
  prompt: string,
  onEvent: (event: ProviderRunEvent) => void,
  workingDirectory?: string,
  runId = `run-${crypto.randomUUID()}`,
  selectionMode: "fixed" | "auto" = "fixed",
  meteredFallbackAuthorized = false,
  onProviderInvocationStarted: () => void = () => {},
): Promise<ProviderTaskResult> {
  if (!isNativeRuntime()) {
    throw new Error("Local intelligence runs only inside Codelit for Mac.");
  }
  if (selectionMode === "auto"
    && isMeteredApiProvider(selection.provider)
    && !meteredFallbackAuthorized) {
    throw new Error("Auto cannot invoke a metered API unless metered fallback was authorized for this run.");
  }
  const eventChannel = new Channel<ProviderRunEvent>();
  let invocationMarked = false;
  eventChannel.onmessage = (event) => {
    if (!invocationMarked && isMeteredProviderInvocationStartedEvent(event, selection)) {
      invocationMarked = true;
      onProviderInvocationStarted();
    }
    onEvent(event);
  };
  type NativeProviderTaskResult = Omit<
    ProviderTaskResult,
    "meteredFallbackAuthorized" | "meteredProviderInvocationStarted"
  >;
  const result = await invoke<NativeProviderTaskResult>("run_provider_task_stream", {
    request: {
      runId,
      provider: selection.provider,
      model: selection.model,
      prompt,
      workingDirectory,
      selectionMode,
    },
    onEvent: eventChannel,
  });
  const provenance = providerRunProvenance(
    selection,
    selectionMode,
    meteredFallbackAuthorized,
    invocationMarked,
  );
  if (result.selectionMode !== provenance.selectionMode
    || result.billingFallback !== provenance.billingFallback) {
    throw new Error("The provider response did not preserve the captured run billing policy.");
  }
  return { ...result, ...provenance };
}

export async function cancelIntelligenceTask(runId: string): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  return invoke<boolean>("cancel_provider_task", { runId });
}

const PROJECT_OVERVIEW_FILES = [
  "AGENTS.md",
  "README.md",
  "README",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "requirements.txt",
] as const;

function overviewPaths(context: string[]) {
  const visible = new Set(
    context
      .flatMap((section) => section.split("\n"))
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return PROJECT_OVERVIEW_FILES.filter((path) => visible.has(path)).slice(0, 4);
}

export async function readLocalProjectContext(
  runId: string,
  onEvent: (event: ProviderRunEvent) => void,
): Promise<LocalToolBatchResult> {
  if (!isNativeRuntime()) {
    throw new Error("Project inspection is available only inside Codelit for Mac.");
  }
  const runTools = async (tools: string[], handoff = "") => {
    const eventChannel = new Channel<ProviderRunEvent>();
    eventChannel.onmessage = onEvent;
    return invoke<LocalToolBatchResult>("run_local_tool_batch", {
      request: {
        runId,
        tools,
        handoff,
        toolInputs: {},
      },
      onEvent: eventChannel,
    });
  };

  const overview = await runTools(["Selected folder"]);
  const paths = overviewPaths(overview.context);
  if (!paths.length) return overview;
  const selected = await runTools(["Selected files"], `FILES: ${paths.join(", ")}`);
  return {
    ...overview,
    context: [...overview.context, ...selected.context],
    completedTools: [...overview.completedTools, ...selected.completedTools],
    browserProofs: [...overview.browserProofs, ...selected.browserProofs],
    failure: selected.failure || overview.failure,
    status: selected.status === "completed" && overview.status === "completed" ? "completed" : "failed",
  };
}

export async function readLocalFolderListing(
  runId: string,
  onEvent: (event: ProviderRunEvent) => void,
): Promise<LocalToolBatchResult> {
  if (!isNativeRuntime()) {
    throw new Error("Folder inspection is available only inside Codelit for Mac.");
  }
  const eventChannel = new Channel<ProviderRunEvent>();
  eventChannel.onmessage = onEvent;
  return invoke<LocalToolBatchResult>("run_local_tool_batch", {
    request: {
      runId,
      tools: ["Folder listing"],
      handoff: "List the visible top-level folders and files.",
      toolInputs: {},
    },
    onEvent: eventChannel,
  });
}

export async function readLocalBrowserContext(
  runId: string,
  request: {
    sessionId: string;
    projectId: string;
    url: string;
    host: string;
    objective: string;
  },
  onEvent: (event: ProviderRunEvent) => void,
): Promise<LocalToolBatchResult> {
  if (!isNativeRuntime()) {
    throw new Error("Website inspection is available only inside Codelit for Mac.");
  }
  const eventChannel = new Channel<ProviderRunEvent>();
  eventChannel.onmessage = onEvent;
  return invoke<LocalToolBatchResult>("run_local_tool_batch", {
    request: {
      runId,
      tools: ["Browser read"],
      handoff: request.objective,
      toolInputs: {
        "Browser read": {
          url: request.url,
          objective: request.objective,
          allowedDomains: [request.host],
        },
      },
      browserSessionId: request.sessionId,
      browserProjectId: request.projectId,
    },
    onEvent: eventChannel,
  });
}

export function createNativeToolRuntimeAdapter(
  onEvent: (event: ProviderRunEvent) => void,
  resolveConfig: (step: NativeToolStep) => NativeToolExecutionConfig = () => ({}),
  beforeExecute: (step: NativeToolStep) => Promise<void> = async () => {},
): ToolRuntimeAdapter<NativeToolStep, NativeToolContext, NativeToolResolution> {
  return {
    id: "codelit-mac-native",
    async execute({ runId, step, context }, signal) {
      if (!isNativeRuntime()) {
        throw new Error("Local tools run only inside Codelit for Mac.");
      }
      const eventChannel = new Channel<ProviderRunEvent>();
      eventChannel.onmessage = onEvent;
      const cancel = () => { void cancelIntelligenceTask(runId); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await beforeExecute(step);
        const config = resolveConfig(step);
        const result = await invoke<LocalToolBatchResult>("run_local_tool_batch", {
          request: {
            runId,
            tools: step.tools,
            handoff: context.handoff,
            approvalSha256: config.approvalSha256,
            toolInputs: config.toolInputs || {},
            browserSessionId: config.browserSessionId,
            browserProjectId: config.browserProjectId,
          },
          onEvent: eventChannel,
        });
        return {
          context: result.context,
          completedTools: result.completedTools,
          browserProofs: result.browserProofs.map(({ auditId, mode, evidence, attempts, events }) => ({
            auditId,
            mode,
            evidence,
            attempts,
            events,
          })),
          ...(result.failure ? { failure: result.failure } : {}),
        };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    async cancel(runId) {
      await cancelIntelligenceTask(runId);
    },
  };
}

export async function prepareNativeToolApproval(
  runId: string,
  tools: string[],
  source: string,
  toolInputs: Record<string, Record<string, unknown>>,
  onEvent: (event: ProviderRunEvent) => void,
  signal: AbortSignal,
  browser?: { sessionId: string; projectId: string },
): Promise<LocalToolApprovalPreview> {
  if (!isNativeRuntime()) {
    throw new Error("Local approval preparation runs only inside Codelit for Mac.");
  }
  const eventChannel = new Channel<ProviderRunEvent>();
  eventChannel.onmessage = onEvent;
  const cancel = () => { void cancelIntelligenceTask(runId); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await invoke<LocalToolApprovalPreview>("prepare_local_tool_approval", {
      request: {
        runId,
        tools,
        source,
        toolInputs,
        browserSessionId: browser?.sessionId,
        browserProjectId: browser?.projectId,
      },
      onEvent: eventChannel,
    });
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function runApprovedLocalBrowserAction(
  runId: string,
  request: {
    sessionId: string;
    projectId: string;
    objective: string;
    approvalSha256: string;
    toolInputs: Record<string, Record<string, unknown>>;
  },
  onEvent: (event: ProviderRunEvent) => void,
): Promise<LocalToolBatchResult> {
  if (!isNativeRuntime()) {
    throw new Error("Reviewed browser actions run only inside Codelit for Mac.");
  }
  const eventChannel = new Channel<ProviderRunEvent>();
  eventChannel.onmessage = onEvent;
  return invoke<LocalToolBatchResult>("run_local_tool_batch", {
    request: {
      runId,
      tools: ["Browser act"],
      handoff: request.objective,
      approvalSha256: request.approvalSha256,
      toolInputs: request.toolInputs,
      browserSessionId: request.sessionId,
      browserProjectId: request.projectId,
    },
    onEvent: eventChannel,
  });
}

export async function runApprovedLocalMcpCall(
  runId: string,
  request: {
    toolReference: string;
    objective: string;
    approvalSha256: string;
  },
  onEvent: (event: ProviderRunEvent) => void,
): Promise<LocalToolBatchResult> {
  if (!isNativeRuntime()) {
    throw new Error("Reviewed MCP calls run only inside Codelit for Mac.");
  }
  const eventChannel = new Channel<ProviderRunEvent>();
  eventChannel.onmessage = onEvent;
  return invoke<LocalToolBatchResult>("run_local_tool_batch", {
    request: {
      runId,
      tools: [request.toolReference],
      handoff: request.objective,
      approvalSha256: request.approvalSha256,
      toolInputs: {},
    },
    onEvent: eventChannel,
  });
}

export async function runProviderHealthCheck(
  provider: ProviderProbe,
  onEvent: (event: ProviderRunEvent) => void = () => {},
): Promise<ProviderTaskResult> {
  const model = preferredProviderModel(provider);
  if (!model) throw new Error(`${provider.label} has no runnable model.`);
  return runIntelligenceTask(
    { provider: provider.id, model: model.id },
    'Return JSON with summary exactly "provider ready" and items containing exactly "read-only". Do not use tools or modify files.',
    onEvent,
  );
}

export async function manageLocalModel(
  provider: ProviderProbe["id"],
  model: string,
  action: ModelManagerAction,
  onEvent: (event: ProviderRunEvent) => void,
  onStarted: (runId: string) => void = () => {},
): Promise<{ runId: string; model: ProviderModel }> {
  if (!isNativeRuntime()) {
    throw new Error("Local model management is available only inside Codelit for Mac.");
  }
  const runId = `model-${crypto.randomUUID()}`;
  onStarted(runId);
  const eventChannel = new Channel<ProviderRunEvent>();
  eventChannel.onmessage = onEvent;
  const updated = await invoke<ProviderModel>("manage_local_model", {
    request: { runId, provider, model, action },
    onEvent: eventChannel,
  });
  return { runId, model: updated };
}
