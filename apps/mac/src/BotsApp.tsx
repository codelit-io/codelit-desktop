import {
  Activity,
  ArrowUp,
  AtSign,
  Bell,
  Bot,
  Brain,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleStop,
  Download,
  FolderOpen,
  FolderSync,
  Globe2,
  Menu,
  Monitor,
  ImagePlus,
  PanelLeftClose,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Table2,
  SlidersHorizontal,
  Target,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ThreadBlock } from "@/lib/workspace-thread";
import type {
  ApiKeyProviderId,
  BackgroundServiceProbe,
  RoutineAutonomyPolicy,
  BotGoal,
  BotEventRoutine,
  BotMemory,
  BotMemoryProposal,
  BotSkill,
  ComputerActionResult,
  ComputerAppScope,
  ComputerSemanticAction,
  ComputerUseReadiness,
  ClaimedEventRoutineOccurrence,
  ClaimedScheduleOccurrence,
  IntelligenceSelection,
  LocalBotDelegation,
  LocalBotDelegationRunContext,
  LocalBotRecord,
  LocalBotTable,
  LocalBotTableView,
  LocalBotsSnapshot,
  LocalBrowserSession,
  LocalNotificationRoute,
  LocalMcpServer,
  LocalPilotReport,
  LocalSchedule,
  ProviderModel,
  ProviderProbe,
  ProviderCredentialStatus,
  ProviderRunEvent,
  ProviderTaskResult,
  QuarantinedBrowserDownload,
  RoutineActivityItem,
  RunningComputerApp,
  SaveLocalScheduleRequest,
  UnexpectedActionCategory,
} from "./contracts";
import { localMcpToolReference } from "./contracts";
import EnginePicker from "./components/EnginePicker";
import BotAvatar, { avatarForBot, BOT_AVATAR_PRESETS, defaultBotAvatar } from "./components/BotAvatar";
import type { BrowserSkillReplayOutcome } from "./components/BotBrowserSkillRunActivity";
import { useModalFocus } from "./components/useModalFocus";
import { avatarFromFile, normalizeBotName } from "./bot-profile";
import type {
  AgenticHarnessCheckpoint,
  AgenticMcpToolDefinition,
  AgenticReadToolDefinition,
  AgenticReadLoopResult,
} from "./agentic-read-loop";
import {
  emptyAgenticHarnessCheckpoint,
  resumeAgenticHarnessCheckpoint,
} from "./agentic-harness-checkpoint";
import { buildBotPrompt } from "./bot-prompt";
import {
  parseBrowserTeachingRequest,
  parseBrowserSkillRunRequest,
  taughtBrowserRecipeForSkill,
  type BrowserSkillRunRequest,
  type BrowserTeachingRequest,
  type TaughtBrowserRecipeDraft,
} from "./browser-teaching";
import {
  coerceBotTableValues,
  findBotTable,
  parseBotDataIntent,
  type BotDataIntent,
} from "./bot-data";
import {
  botSkillChecksPassed,
  completeBotSkillChecks,
  prepareBotSkillRuns,
} from "./bot-skills";
import { computerPlannerPrompt, matchComputerApp, parseComputerPlan } from "./computer-use-plan";
import {
  localConversationReply,
  parseLocalFileIntent,
  selectedFolderMatchesPurpose,
} from "./local-file-intent";
import {
  botMemorySafetyError,
  botMemorySnapshotHash,
  botSkillSnapshotMatches,
  botSkillVersions,
  classifyBotMemory,
  createRoutineSnapshot,
  describeBotSkill,
  inferBotMemoryProposal,
  parseBotDelegationIntent,
  parseBotControlIntent,
  previousUserRequest,
  readBotRoutineSnapshot,
  routinesForBot,
  skillsForBotRequest,
  type BotControlIntent,
} from "./bot-initiative";
import {
  BOT_CAPABILITY_MANIFESTS,
  botBrowserAutoApprovalSource,
  botProvidersForChannel,
  isBotBrowserSessionOpen,
  isBotEngineReady,
  onDeviceModelSetupAction,
  onDeviceSetupAction,
  parseBotBrowserAction,
  parseBotBrowserTarget,
  selectBotEngine,
  shouldAutoApproveBotAction,
  type BotBuildChannel,
} from "./bot-policy";
import {
  applyBotRunEvent,
  botExecutionState,
  canStartBotExecution,
  cancelBotExecution,
  commitBotExecution,
  finishBotExecution,
  pendingComputerRunFromApproval,
  pendingBrowserRunFromApproval,
  pendingMcpRunFromApproval,
  revealBotExecutionAnswer,
  replaceWorkspaceForActiveBot,
  resumeBotExecution,
  setBotExecutionFeedback,
  startBotExecution,
  waitForBotBrowserApproval,
  waitForBotComputerApproval,
  waitForBotMcpApproval,
  type BotExecutionState,
  type BotExecutionStates,
  type PendingBrowserRun,
  type PendingComputerRun,
  type PendingMcpRun,
} from "./bot-run-state";
import {
  canContinueProviderReveal,
  finalAnswerReconciliation,
  formatProviderFinalAnswer,
  isTransientProviderRunEvent,
} from "./provider-run-live";
import {
  appendThreadMessage,
  appendLocalBotTableRow,
  beginLocalRun,
  bootstrapBots,
  cancelIntelligenceTask,
  cancelLocalBotDelegation,
  claimChangedEventRoutines,
  claimDueLocalSchedules,
  clearLocalBotMemories,
  chooseWorkspaceFolder,
  consumeLocalNotification,
  createLocalBot,
  createLocalBotDelegation,
  createLocalBotMemoryProposal,
  createLocalBotTable,
  deleteLocalEventRoutine,
  deleteLocalSchedule,
  deleteLocalBotMemory,
  deleteLocalBotSkill,
  deleteQuarantinedBrowserDownload,
  deleteComputerAppScope,
  deliverDueDailyDigest,
  discardPreparedLocalToolApproval,
  deleteLocalWorkspace,
  exportLocalWorkspace,
  exportLocalPilotReport,
  exportLocalBotTableCsv,
  eventRoutineExecutionPermitted,
  finishEventRoutineOccurrence,
  finishLocalBotDelegationTarget,
  finishScheduleOccurrence,
  getBotAutonomyPolicy,
  getLocalPilotReport,
  isNativeRuntime,
  inspectComputerApp,
  importLocalBotSkill,
  listComputerAppScopes,
  listLocalBotGroupMembers,
  listLocalBotDelegations,
  listLocalEventRoutines,
  listLocalMcpServers,
  listLocalSchedules,
  listLocalBotMemories,
  listLocalBotMemoryProposals,
  listLocalBotSkills,
  listLocalBotTables,
  listQuarantinedBrowserDownloads,
  listRecentRoutineActivity,
  listRunningComputerApps,
  listenForLocalBrowserEvents,
  localRunCapacityDetail,
  manageLocalModel,
  discoverLocalModels,
  markEventRoutineOccurrenceRunning,
  markScheduleOccurrenceRunning,
  openBackgroundWorkSettings,
  openLocalBotContext,
  openLocalModelPage,
  openLocalBotTable,
  deleteProviderApiKey,
  openCodexSignIn,
  openCopilotSignIn,
  openProviderSetup,
  probeDesktopUpdate,
  probeComputerUseReadiness,
  probeBackgroundService,
  probeLocalProviders,
  probeProviderApiKeys,
  prepareNativeToolApproval,
  providerRunProvenance,
  readLocalProjectFingerprint,
  readLocalFolderListing,
  readLocalBrowserContext,
  releaseQuarantinedBrowserDownload,
  recoverLocalBotDelegations,
  recordProviderRun,
  recordLocalUnexpectedAction,
  recordLocalRunApproval,
  reviewLocalBotMemoryProposal,
  reviewImportedBotSkill,
  readLocalProjectContext,
  runIntelligenceTask,
  runApprovedLocalBrowserAction,
  runApprovedLocalMcpCall,
  runComputerAction,
  renewEventRoutineOccurrenceLease,
  renewScheduleOccurrenceLease,
  saveLocalEventRoutine,
  saveLocalSchedule,
  saveLocalBotMemory,
  saveLocalBotSkill,
  saveComputerAppScope,
  saveProviderApiKey,
  setActiveLocalBot,
  setBackgroundWorkEnabled,
  setLocalEventRoutineEnabled,
  setLocalScheduleEnabled,
  saveLocalRunCheckpoint,
  updateLocalBotStatus,
  updateBotAutonomyPolicy,
  updateLocalBotApprovalMode,
  updateLocalBotBrowserDomains,
  updateLocalBotEnginePolicy,
  updateLocalBotGroupMembers,
  updateLocalBotGoal,
  updateLocalBotProfile,
  updateLocalBotRoutines,
  scheduleExecutionPermitted,
  showLocalNotification,
  requestComputerUsePermission,
  startLocalBotDelegationTarget,
  takeOpenedLocalNotification,
  takeOverComputerRun,
} from "./runtime";
import "./BotsApp.css";

const BotBrowserSkillRunActivity = lazy(() => import("./components/BotBrowserSkillRunActivity"));
const BotBrowserTeachingActivity = lazy(() => import("./components/BotBrowserTeachingActivity"));
const BotDataTableArtifact = lazy(() => import("./components/BotDataTableArtifact"));
const BotDownloadArtifacts = lazy(() => import("./components/BotDownloadArtifacts"));
const BotMemoryProposals = lazy(() => import("./components/BotMemoryProposals"));
const BotOutcomeActions = lazy(() => import("./components/BotOutcomeActions"));
const BotSkillReviews = lazy(() => import("./components/BotSkillReviews"));
const BotMarkdown = lazy(() => import("./components/BotMarkdown"));
const LocalBrowserPanel = lazy(() => import("./components/LocalBrowserPanel"));
const ProviderCenter = lazy(() => import("./components/ProviderCenter"));

function DeferredSurface({ label, browser = false }: { label: string; browser?: boolean }) {
  return (
    <div
      className={`bots-deferred-surface${browser ? " local-browser-panel" : ""}`}
      role="status"
      aria-label={label}
    >
      <span aria-hidden="true" />
    </div>
  );
}

function RichBotMarkdown({
  children,
  className,
  streaming = false,
}: {
  children: string;
  className?: string;
  streaming?: boolean;
}) {
  const classes = ["bot-markdown", "bots-markdown-fallback", className].filter(Boolean).join(" ");
  return (
    <Suspense fallback={<div className={classes}>{children}</div>}>
      <BotMarkdown className={className} streaming={streaming}>{children}</BotMarkdown>
    </Suspense>
  );
}

function mcpToolsForChat(request: string, servers: LocalMcpServer[]): AgenticMcpToolDefinition[] {
  const terms = new Set(request.toLowerCase().match(/[a-z0-9_-]{3,}/g) || []);
  return servers
    .filter((server) => server.enabled && server.status === "ready")
    .flatMap((server) => server.tools
      .filter((tool) => tool.approved)
      .map((tool) => {
        const haystack = `${server.name} ${tool.name} ${tool.description}`.toLowerCase();
        const score = [...terms].reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return {
          score,
          tool: {
            reference: localMcpToolReference(server.id, tool.name),
            serverName: server.name,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            effect: tool.effect,
            destructive: tool.destructive,
          },
        };
      }))
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, 6)
    .map(({ tool }) => tool);
}

function agenticReadToolsForWorkspace(
  hasApprovedFolder: boolean,
  folderIsProject: boolean,
): AgenticReadToolDefinition[] {
  return [
    ...(hasApprovedFolder && folderIsProject ? [{
      name: "read_project_overview" as const,
      description: "Read the approved project manifest and a few overview files such as README and package.json.",
    }] : []),
    ...(hasApprovedFolder ? [{
      name: "list_selected_folder" as const,
      description: "List only the visible top-level names in the approved folder.",
    }] : []),
    {
      name: "list_local_tables" as const,
      description: "List this bot's private local table names, columns, and row counts without reading row values.",
    },
    {
      name: "list_local_routines" as const,
      description: "List this bot's local scheduled routines and their current status without running them.",
    },
    {
      name: "list_connected_tools" as const,
      description: "List reviewed local MCP connections and the exact approved tools they provide without invoking them.",
    },
  ];
}

interface BrowserSessionWaiter {
  runId: string;
  botId: string;
  resolve: (session: LocalBrowserSession) => void;
  reject: (reason: Error) => void;
  interval: number;
  remainingVisibleMs: number;
}

interface BrowserLaneWaiter {
  runId: string;
  resolve: () => void;
  reject: (reason: Error) => void;
}

type SettingsSection = "general" | "intelligence" | "privacy";

const UNEXPECTED_ACTION_OPTIONS: Array<{ value: UnexpectedActionCategory; label: string }> = [
  { value: "unexpected-action", label: "Did something I did not ask" },
  { value: "unapproved-write", label: "Changed something without approval" },
  { value: "sensitive-data", label: "Exposed sensitive data" },
  { value: "other", label: "Another unexpected action" },
];

interface BotTaskOutcome {
  status: "completed" | "failed" | "paused" | "approval-required";
  detail: string;
  answer?: string;
  runId?: string;
}

interface BotTaskOptions {
  bot?: LocalBotRecord;
  workspace?: LocalBotsSnapshot["workspace"];
  memories?: BotMemory[];
  skills?: BotSkill[];
  engine?: IntelligenceSelection;
  runId?: string;
  appendUser?: boolean;
  routine?: { id: string; title: string; scheduledFor: string };
  delegation?: LocalBotDelegationRunContext;
}

type BotChangeUndo =
  | {
      kind: "goal";
      botId: string;
      changedVersion: number;
      previousGoal: BotGoal;
      title: string;
      detail: string;
    }
  | {
      kind: "schedule";
      botId: string;
      scheduleId: string;
      changedRevision: number;
      previousSchedule: LocalSchedule;
      title: string;
      detail: string;
    };

function browserSessionId(runId: string) {
  return `browser-${runId}`;
}

function createBotName(job: string) {
  const ignored = new Set(["a", "an", "and", "for", "me", "my", "of", "the", "to"]);
  const words = job
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !ignored.has(word.toLowerCase()))
    .slice(0, 3);
  const title = words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
  return title ? `${title} Bot` : "New Bot";
}

function trailingBotMention(value: string) {
  const match = value.match(/(?:^|\s)@([^@\n]*)$/);
  if (!match || match.index === undefined) return null;
  const atOffset = match[0].indexOf("@");
  return {
    start: match.index + atOffset,
    query: match[1].trim().toLowerCase(),
  };
}

function providerLabel(providers: ProviderProbe[], selection: IntelligenceSelection | null) {
  if (!selection) return "Setup needed";
  return providers.find((provider) => provider.id === selection.provider)?.label || selection.provider;
}

function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function autonomySidebarStatus(policy: RoutineAutonomyPolicy) {
  if (policy.status === "paused") return "Routines paused";
  if (policy.status === "quiet-hours" && policy.resumesAt) {
    const resumes = new Date(policy.resumesAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    return `Quiet until ${resumes}`;
  }
  if (policy.status === "quiet-hours") return `Quiet until ${policy.quietEnd}`;
  return "Routines active";
}

function routineActivityStatus(item: RoutineActivityItem) {
  if (item.status === "completed") return "Completed";
  if (item.status === "attention") return "Needs attention";
  if (item.status === "retrying") return "Retrying safely";
  return "Failed";
}

function routineActivityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type ReviewedBrowserAction = NonNullable<PendingBrowserRun["browserAction"]>;

function browserActionInstruction(action: ReviewedBrowserAction) {
  if (action.action === "type") {
    return `Enter ${action.valueLength} characters in ${action.targetLabel}`;
  }
  if (action.action === "download") return `Download ${action.targetLabel}`;
  return `Click ${action.targetLabel}`;
}

function browserActionCompletedLabel(action: ReviewedBrowserAction) {
  if (action.action === "type") {
    return `Entered ${action.valueLength} characters into ${action.targetLabel}`;
  }
  if (action.action === "download") return `Downloaded ${action.targetLabel}`;
  return `Clicked ${action.targetLabel}`;
}

function browserActionScope(action: ReviewedBrowserAction) {
  return action.action === "download" ? "browser-download" : "typed-browser-action";
}

function BotBrowserActivity({
  pending,
  botName,
  obscured,
  disabled,
  onSessionChange,
  onOpenError,
}: {
  pending: PendingBrowserRun;
  botName: string;
  obscured: boolean;
  disabled: boolean;
  onSessionChange: (runId: string, session: LocalBrowserSession | null) => void;
  onOpenError: (runId: string, message: string) => void;
}) {
  const handleSessionChange = useCallback(
    (session: LocalBrowserSession | null) => onSessionChange(pending.runId, session),
    [onSessionChange, pending.runId],
  );
  const handleOpenError = useCallback(
    (message: string) => onOpenError(pending.runId, message),
    [onOpenError, pending.runId],
  );
  return (
    <article className="bot-browser-activity">
      <header>
        <Globe2 size={13} />
        <strong>{botName}</strong>
        <span>{pending.browserAction ? "Acting on" : "Reading"} {pending.target.host}</span>
      </header>
      <div className="bots-browser-run">
        <Suspense fallback={<DeferredSurface label="Opening local browser" browser />}>
          <LocalBrowserPanel
            sessionId={browserSessionId(pending.runId)}
            projectId={pending.botId}
            initialUrl={pending.target.url}
            allowedDomains={[pending.target.host]}
            obscured={obscured}
            disabled={disabled}
            mode={pending.browserAction ? "bot-action" : "bot-read"}
            onSessionChange={handleSessionChange}
            onOpenError={handleOpenError}
            onRequestCloudBrowser={() => undefined}
          />
        </Suspense>
      </div>
    </article>
  );
}

function BotRosterButton({
  bot,
  active,
  execution,
  onChoose,
}: {
  bot: LocalBotRecord;
  active: boolean;
  execution: BotExecutionState;
  onChoose: (id: string) => Promise<void>;
}) {
  const running = execution.runState !== "idle";
  const status = execution.runState === "awaiting-approval"
    ? "Waiting for approval"
    : execution.runState === "canceling"
      ? "Stopping"
      : running
        ? execution.liveRun.status || bot.latestStatus
        : bot.latestStatus;
  return (
    <button
      className={`${active ? "active" : ""}${running ? " working" : ""}`.trim() || undefined}
      onClick={() => void onChoose(bot.id)}
      aria-current={active ? "page" : undefined}
      aria-label={`${bot.name}. ${status}`}
    >
      <BotAvatar avatar={avatarForBot(bot)} size="small" />
      <span className="bot-row-copy">
        <strong>{bot.name}</strong>
        <small>{status}</small>
      </span>
      <span className={`bot-state-dot ${running ? "working" : bot.status}`} aria-hidden="true" />
    </button>
  );
}

function delegationStatusLabel(status: LocalBotDelegation["status"]) {
  if (status === "awaiting-approval") return "Needs approval";
  if (status === "running") return "Working";
  if (status === "queued") return "Queued";
  if (status === "completed") return "Complete";
  if (status === "canceled") return "Stopped";
  return "Needs attention";
}

function BotDelegationCard({
  delegation,
  showParent = false,
  canceling = false,
  onOpenBot,
  onCancel,
}: {
  delegation: LocalBotDelegation;
  showParent?: boolean;
  canceling?: boolean;
  onOpenBot: (id: string) => Promise<void>;
  onCancel?: (delegation: LocalBotDelegation) => Promise<void>;
}) {
  const unfinished = delegation.targets.some((target) => ["queued", "running"].includes(target.status))
    && !delegation.targets.some((target) => target.status === "awaiting-approval");
  const results = delegation.targets.filter((target) => target.result || target.detail);
  return (
    <article
      className="bot-delegation-card"
      data-status={delegation.status}
      aria-label={`Bot handoff: ${delegation.task}`}
    >
      <header>
        <span className="bot-delegation-icon"><Users size={16} /></span>
        <div>
          <small>{showParent ? `${delegation.parentBotName} asked` : "Bot handoff"}</small>
          <strong>{delegation.targets.map((target) => target.botName).join(" + ")}</strong>
        </div>
        <span className={`bot-delegation-status ${delegation.status}`}>
          {delegationStatusLabel(delegation.status)}
        </span>
      </header>
      <p>{delegation.task}</p>
      <div className="bot-delegation-targets">
        {delegation.targets.map((target) => (
          <div key={target.botId}>
            <span className={`bot-state-dot ${target.status}`} aria-hidden="true" />
            <strong>{target.botName}</strong>
            <small title={target.status === "queued" ? target.detail : undefined}>
              {target.status === "queued" && target.detail
                ? "Waiting for capacity"
                : delegationStatusLabel(target.status)}
            </small>
            {target.status === "awaiting-approval" && (
              <button type="button" onClick={() => void onOpenBot(target.botId)}>Review</button>
            )}
          </div>
        ))}
      </div>
      {results.length > 0 && (
        <details className="bot-delegation-results" open={delegation.status === "completed"}>
          <summary>
            <span>{delegation.status === "completed" ? "Combined result" : "Details"}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <div>
            {results.map((target) => (
              <section key={target.botId}>
                <strong>{target.botName}</strong>
                {target.result
                  ? <RichBotMarkdown>{target.result}</RichBotMarkdown>
                  : <p>{target.detail}</p>}
              </section>
            ))}
          </div>
        </details>
      )}
      {unfinished && onCancel && (
        <footer>
          <button type="button" className="bot-secondary-action" onClick={() => void onCancel(delegation)} disabled={canceling}>
            <CircleStop size={14} /> {canceling ? "Stopping" : "Stop handoff"}
          </button>
        </footer>
      )}
    </article>
  );
}

function browserEvidenceBoundary(
  providers: ProviderProbe[],
  selection: IntelligenceSelection,
) {
  const label = providerLabel(providers, selection);
  return selection.provider === "mlx" || selection.provider === "ollama"
    ? `Visible page content stays on this Mac and is processed by ${label}.`
    : `Visible page content is sent to ${label} for this answer.`;
}

function computerActionLabel(action: ComputerSemanticAction) {
  if (action.kind === "press") return `Press \"${action.target}\"`;
  const value = action.value.length > 180 ? `${action.value.slice(0, 177)}...` : action.value;
  return `Enter \"${value}\" in \"${action.target}\"`;
}

function computerReceiptAction(action: ComputerSemanticAction) {
  return {
    kind: action.kind,
    target: action.target,
    role: action.role || null,
    occurrence: action.occurrence || 0,
    ...(action.kind === "setValue" ? { enteredCharacters: action.value.length } : {}),
  };
}

function computerProviderResult(
  pending: PendingComputerRun,
  status: ProviderTaskResult["status"],
  text: string,
  durationMs: number,
  evidence: string[] = [],
): ProviderTaskResult {
  return {
    runId: pending.runId,
    provider: pending.engine.provider,
    model: pending.engine.model,
    status,
    ...(status === "completed" ? {
      structuredOutput: { summary: text, items: [] },
    } : {}),
    text,
    durationMs,
    commandPath: pending.plannerCommandPath,
    ...(pending.plannerVersion ? { version: pending.plannerVersion } : {}),
    evidence,
    selectionMode: pending.selectionMode,
    meteredFallbackAuthorized: pending.meteredFallbackAuthorized,
    meteredProviderInvocationStarted: pending.meteredProviderInvocationStarted,
    billingFallback: pending.billingFallback,
  };
}

function localFolderProviderResult(
  runId: string,
  text: string,
  durationMs: number,
): ProviderTaskResult {
  const selection = { provider: "codelit", model: "filesystem-v1" };
  return {
    runId,
    ...selection,
    status: "completed",
    structuredOutput: { summary: text, items: [] },
    text,
    durationMs,
    commandPath: "local-filesystem-tool",
    evidence: [
      "Read-only access to the user-selected folder",
      "Visible top-level names only",
      "No model or metered provider invoked",
    ],
    ...providerRunProvenance(selection, "fixed", false, false),
  };
}

function escapeBotMarkdown(value: string) {
  return value.replace(/([\\`*_\[\]<>#+\-!|>])/g, "\\$1");
}

function compactChangeText(value: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > 90 ? `${clean.slice(0, 87).trimEnd()}...` : clean;
}

function localScheduleSaveRequest(schedule: LocalSchedule): SaveLocalScheduleRequest {
  return {
    id: schedule.id,
    threadId: schedule.threadId,
    artifactId: schedule.artifactId,
    artifactVersion: schedule.artifactVersion,
    title: schedule.title,
    enabled: schedule.enabled,
    cadence: schedule.cadence,
    localTime: schedule.localTime,
    timezone: schedule.timezone,
    weekdays: schedule.weekdays,
    missedPolicy: schedule.missedPolicy,
    maxRetries: schedule.maxRetries,
    provider: schedule.provider,
    model: schedule.model,
    requiresNetwork: schedule.requiresNetwork,
    snapshot: schedule.snapshot,
    ...(schedule.oneTimeAt ? { oneTimeAt: schedule.oneTimeAt } : {}),
  };
}

export default function BotsApp() {
  const [catalog, setCatalog] = useState<LocalBotsSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderProbe[]>([]);
  const [apiCredentials, setApiCredentials] = useState<ProviderCredentialStatus[]>([]);
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<ApiKeyProviderId, string>>({
    openai: "",
    anthropic: "",
    gemini: "",
  });
  const [buildChannel, setBuildChannel] = useState<BotBuildChannel>("app-store");
  const [buildChannelReady, setBuildChannelReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 900);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [profileOpen, setProfileOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupMembers, setGroupMembers] = useState<LocalBotRecord[]>([]);
  const [groupOwnerBotId, setGroupOwnerBotId] = useState<string | null>(null);
  const [groupDraftIds, setGroupDraftIds] = useState<string[]>([]);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [botJob, setBotJob] = useState("");
  const [newBotName, setNewBotName] = useState("");
  const [newBotAvatar, setNewBotAvatar] = useState(() => defaultBotAvatar("new-bot"));
  const [profileName, setProfileName] = useState("");
  const [profileAvatar, setProfileAvatar] = useState(() => defaultBotAvatar("bot-codelit"));
  const [profileError, setProfileError] = useState<string | null>(null);
  const [promptsByBotId, setPromptsByBotId] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [executionStates, setExecutionStates] = useState<BotExecutionStates>({});
  const [schedules, setSchedules] = useState<LocalSchedule[]>([]);
  const [eventRoutines, setEventRoutines] = useState<BotEventRoutine[]>([]);
  const [routineActivity, setRoutineActivity] = useState<RoutineActivityItem[]>([]);
  const [memories, setMemories] = useState<BotMemory[]>([]);
  const [memoryProposals, setMemoryProposals] = useState<BotMemoryProposal[]>([]);
  const [memoryProposalActionId, setMemoryProposalActionId] = useState<string | null>(null);
  const [memoryUndo, setMemoryUndo] = useState<{ botId: string; memory: BotMemory } | null>(null);
  const [botChangeUndo, setBotChangeUndo] = useState<BotChangeUndo | null>(null);
  const [skills, setSkills] = useState<BotSkill[]>([]);
  const [skillReviewActionId, setSkillReviewActionId] = useState<string | null>(null);
  const [botTables, setBotTables] = useState<LocalBotTable[]>([]);
  const [tableView, setTableView] = useState<LocalBotTableView | null>(null);
  const [exportingTableId, setExportingTableId] = useState<string | null>(null);
  const [browserDownloads, setBrowserDownloads] = useState<QuarantinedBrowserDownload[]>([]);
  const [downloadActionId, setDownloadActionId] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<LocalMcpServer[]>([]);
  const [delegations, setDelegations] = useState<LocalBotDelegation[]>([]);
  const [computerUseReadiness, setComputerUseReadiness] = useState<ComputerUseReadiness | null>(null);
  const [runningComputerApps, setRunningComputerApps] = useState<RunningComputerApp[]>([]);
  const [computerAppScopes, setComputerAppScopes] = useState<ComputerAppScope[]>([]);
  const [computerAppChoice, setComputerAppChoice] = useState("");
  const [computerUseBusy, setComputerUseBusy] = useState(false);
  const [computerEvidenceByBotId, setComputerEvidenceByBotId] = useState<Record<string, ComputerActionResult | undefined>>({});
  const [activityOpen, setActivityOpen] = useState(false);
  const [cancelingDelegationId, setCancelingDelegationId] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [skillUndo, setSkillUndo] = useState<{
    botId: string;
    skill: BotSkill;
    previous?: BotSkill;
  } | null>(null);
  const [browserTeaching, setBrowserTeaching] = useState<{
    botId: string;
    sessionId: string;
    request: BrowserTeachingRequest;
  } | null>(null);
  const [browserSkillRun, setBrowserSkillRun] = useState<{
    botId: string;
    runId: string;
    sessionId: string;
    request: BrowserSkillRunRequest;
  } | null>(null);
  const [backgroundService, setBackgroundService] = useState<BackgroundServiceProbe | null>(null);
  const [autonomyPolicy, setAutonomyPolicy] = useState<RoutineAutonomyPolicy | null>(null);
  const [savingAutonomyPolicy, setSavingAutonomyPolicy] = useState(false);
  const [routineAction, setRoutineAction] = useState<string | null>(null);
  const [autoStartBotId, setAutoStartBotId] = useState<string | null>(null);
  const [activeBrowserRunId, setActiveBrowserRunId] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalNotice, setGlobalNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleteWorkspaceOpen, setDeleteWorkspaceOpen] = useState(false);
  const [deleteWorkspaceConfirmation, setDeleteWorkspaceConfirmation] = useState("");
  const [deleteWorkspaceError, setDeleteWorkspaceError] = useState<string | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);
  const [pilotReport, setPilotReport] = useState<LocalPilotReport | null>(null);
  const [pilotAction, setPilotAction] = useState<"loading" | "exporting" | "reporting" | null>(null);
  const [unexpectedActionCategory, setUnexpectedActionCategory] = useState<UnexpectedActionCategory>("unexpected-action");
  const [modelSetup, setModelSetup] = useState<{ runId?: string; message: string } | null>(null);
  const [openingProvider, setOpeningProvider] = useState<ProviderProbe["id"] | null>(null);
  const [providerCredentialBusy, setProviderCredentialBusy] = useState<ApiKeyProviderId | null>(null);
  const [savingApprovalMode, setSavingApprovalMode] = useState(false);
  const [savingEngine, setSavingEngine] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingGroup, setSavingGroup] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const deleteWorkspacePanelRef = useRef<HTMLDivElement>(null);
  const deleteWorkspaceInputRef = useRef<HTMLInputElement>(null);
  const avatarFileRef = useRef<HTMLInputElement>(null);
  const creatingRef = useRef(false);
  const savingApprovalModeRef = useRef(false);
  const catalogIntent = useRef(0);
  const catalogMutationQueue = useRef<Promise<void>>(Promise.resolve());
  const executionStatesRef = useRef<BotExecutionStates>({});
  const canceledRunIds = useRef(new Set<string>());
  const approvalDecisionsInFlight = useRef(new Set<string>());
  const browserWaiters = useRef(new Map<string, BrowserSessionWaiter>());
  const browserSessions = useRef(new Map<string, LocalBrowserSession>());
  const browserLaneOwner = useRef<string | null>(null);
  const browserLaneQueue = useRef<BrowserLaneWaiter[]>([]);
  const browserTeachingRelease = useRef<(() => void) | null>(null);
  const browserSkillRelease = useRef<(() => void) | null>(null);
  const providerRefreshInFlight = useRef(false);
  const computerSetupRequested = useRef(false);
  const scheduleWorkerActive = useRef(false);
  const memoryLoadIntent = useRef(0);
  const memoryProposalLoadIntent = useRef(0);
  const skillLoadIntent = useRef(0);
  const tableLoadIntent = useRef(0);
  const downloadLoadIntent = useRef(0);
  const activeBotIdRef = useRef<string | null>(null);
  const groupLoadIntent = useRef(0);
  const autoStartedBots = useRef(new Set<string>());
  const delegationTargetsInFlight = useRef(new Set<string>());
  const canceledDelegationIds = useRef(new Set<string>());
  const delegationsRecovered = useRef(false);
  const submitTaskRef = useRef<((value: string, options?: BotTaskOptions) => Promise<BotTaskOutcome>) | null>(null);
  const runDelegationTargetRef = useRef<((
    delegation: LocalBotDelegation,
    target: LocalBotDelegation["targets"][number],
  ) => Promise<void>) | null>(null);
  const closeNewBot = useCallback(() => setNewBotOpen(false), []);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  const closeGroup = useCallback(() => setGroupOpen(false), []);
  const resetDeleteWorkspace = useCallback(() => {
    setDeleteWorkspaceOpen(false);
    setDeleteWorkspaceConfirmation("");
    setDeleteWorkspaceError(null);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    resetDeleteWorkspace();
  }, [resetDeleteWorkspace]);
  const selectSettingsSection = useCallback((section: SettingsSection) => {
    setSettingsSection(section);
    if (section !== "privacy") resetDeleteWorkspace();
  }, [resetDeleteWorkspace]);
  const openSettings = useCallback((section: SettingsSection = "general") => {
    selectSettingsSection(section);
    setSettingsOpen(true);
  }, [selectSettingsSection]);
  const newBotDialog = useModalFocus(newBotOpen, closeNewBot);
  const profileDialog = useModalFocus(profileOpen, closeProfile);
  const groupDialog = useModalFocus(groupOpen, closeGroup);
  const settingsDialog = useModalFocus(settingsOpen, closeSettings);

  useEffect(() => {
    if (!deleteWorkspaceOpen) return;
    const frame = window.requestAnimationFrame(() => {
      deleteWorkspacePanelRef.current?.scrollIntoView({ block: "nearest" });
      deleteWorkspaceInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [deleteWorkspaceOpen]);

  const workspace = catalog?.workspace || null;
  const bot = catalog?.activeBot || null;
  const catalogReady = catalog !== null;
  const activeBotId = catalog?.activeBot.id || null;
  activeBotIdRef.current = activeBotId;
  const activeGroupMembers = groupOwnerBotId === activeBotId ? groupMembers : [];
  const execution = bot ? botExecutionState(executionStates, bot.id) : null;
  const runState = execution?.runState || "idle";
  const activeRunId = execution?.activeRunId || null;
  const activeEvent = execution?.activeEvent || null;
  const liveRun = execution?.liveRun || null;
  const pendingBrowserRun = execution?.pendingBrowserRun || null;
  const pendingComputerRun = execution?.pendingComputerRun || null;
  const pendingMcpRun = execution?.pendingMcpRun || null;
  const error = execution?.error || globalError;
  const notice = execution?.notice || globalNotice;
  const prompt = bot ? promptsByBotId[bot.id] || "" : "";
  const hasAnyActiveRun = Boolean(browserTeaching || browserSkillRun) || Object.values(executionStates)
    .some((candidate) => candidate.runState !== "idle");
  const overlayOpen = newBotOpen || settingsOpen || profileOpen || groupOpen;
  const hasConversation = Boolean(workspace?.blocks.some((block) => block.type === "user-message"));
  const activeRoutines = bot ? routinesForBot(schedules, bot.id) : [];
  const activeEventRoutines = bot ? eventRoutines.filter((routine) => routine.botId === bot.id) : [];
  const pendingSkillReviews = skills.filter((skill) => (
    skill.source === "imported" && skill.trustState === "unreviewed"
  ));
  const schedulesAvailable = buildChannelReady
    && BOT_CAPABILITY_MANIFESTS[buildChannel].scheduledRoutines;
  const computerUseAvailable = buildChannelReady
    && BOT_CAPABILITY_MANIFESTS[buildChannel].computerUse;
  const unapprovedComputerApps = runningComputerApps.filter((app) => (
    !computerAppScopes.some((scope) => scope.bundleId === app.bundleId)
  ));

  const updateExecutionStates = useCallback((
    update: (current: BotExecutionStates) => BotExecutionStates,
  ) => {
    const next = update(executionStatesRef.current);
    executionStatesRef.current = next;
    setExecutionStates(next);
    return next;
  }, []);

  const grantNextBrowserLane = useCallback(() => {
    const next = browserLaneQueue.current.shift();
    if (!next) {
      browserLaneOwner.current = null;
      setActiveBrowserRunId(null);
      return;
    }
    browserLaneOwner.current = next.runId;
    setActiveBrowserRunId(next.runId);
    next.resolve();
  }, []);

  const releaseBrowserLane = useCallback((runId: string) => {
    if (browserLaneOwner.current !== runId) return;
    grantNextBrowserLane();
  }, [grantNextBrowserLane]);

  const acquireBrowserLane = useCallback(async (runId: string) => {
    if (browserLaneOwner.current === null) {
      browserLaneOwner.current = runId;
      setActiveBrowserRunId(runId);
    } else if (browserLaneOwner.current !== runId) {
      await new Promise<void>((resolve, reject) => {
        browserLaneQueue.current.push({ runId, resolve, reject });
      });
    }
    return () => releaseBrowserLane(runId);
  }, [releaseBrowserLane]);

  const cancelQueuedBrowserLane = useCallback((runId: string) => {
    const index = browserLaneQueue.current.findIndex((candidate) => candidate.runId === runId);
    if (index < 0) return;
    const [queued] = browserLaneQueue.current.splice(index, 1);
    queued.reject(new Error("Run canceled by user."));
  }, []);

  const setPrompt = (value: string) => {
    if (!bot) return;
    setPromptsByBotId((current) => ({ ...current, [bot.id]: value }));
    setMentionIndex(0);
    setMentionDismissed(false);
  };

  const selectBotMention = (name: string) => {
    if (!bot) return;
    const current = promptsByBotId[bot.id] || "";
    const match = trailingBotMention(current);
    if (!match) return;
    setPromptsByBotId((values) => ({
      ...values,
      [bot.id]: `${current.slice(0, match.start)}@${name} `,
    }));
    setMentionIndex(0);
    setMentionDismissed(true);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const openBotMentions = () => {
    if (!bot) return;
    const current = promptsByBotId[bot.id] || "";
    const separator = current && !/\s$/.test(current) ? " " : "";
    setPromptsByBotId((values) => ({ ...values, [bot.id]: `${current}${separator}@` }));
    setMentionIndex(0);
    setMentionDismissed(false);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const setBotFeedback = (
    botId: string,
    feedback: { error?: string | null; notice?: string | null },
  ) => updateExecutionStates((current) => setBotExecutionFeedback(current, botId, feedback));

  const applyWorkspace = (
    botId: string,
    threadId: string,
    nextWorkspace: NonNullable<typeof workspace>,
  ) => setCatalog((current) => replaceWorkspaceForActiveBot(
    current,
    botId,
    threadId,
    nextWorkspace,
  ));

  const openBots = useCallback(async () => {
    setGlobalError(null);
    const nextCatalog = await bootstrapBots();
    setCatalog(nextCatalog);
  }, []);

  const refreshStartupMetadata = useCallback(async () => {
    const [providersResult, credentialsResult, updateResult, mcpResult] = await Promise.allSettled([
      probeLocalProviders(),
      probeProviderApiKeys(),
      probeDesktopUpdate(),
      listLocalMcpServers(),
    ]);
    if (providersResult.status === "fulfilled") setProviders(providersResult.value);
    if (credentialsResult.status === "fulfilled") setApiCredentials(credentialsResult.value);
    if (updateResult.status === "fulfilled") {
      setBuildChannel(updateResult.value.channel);
      setBuildChannelReady(true);
    }
    if (mcpResult.status === "fulfilled") setMcpServers(mcpResult.value);
    if ([providersResult, credentialsResult, updateResult, mcpResult].some((result) => result.status === "rejected")) {
      setGlobalNotice("Your bots are ready. Some intelligence settings need a refresh.");
    }
  }, []);

  const retryOpenBots = useCallback(() => {
    void openBots().catch((reason) => {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [openBots]);

  useEffect(() => {
    retryOpenBots();
    void refreshStartupMetadata();
  }, [refreshStartupMetadata, retryOpenBots]);

  const refreshRoutineState = useCallback(async () => {
    if (!schedulesAvailable) {
      setSchedules([]);
      setEventRoutines([]);
      setRoutineActivity([]);
      setBackgroundService(null);
      setAutonomyPolicy(null);
      return;
    }
    const [nextSchedules, nextEventRoutines, nextActivity, nextBackground, nextAutonomyPolicy] = await Promise.all([
      listLocalSchedules(),
      listLocalEventRoutines(),
      listRecentRoutineActivity(),
      probeBackgroundService(),
      getBotAutonomyPolicy(deviceTimezone()),
    ]);
    setSchedules(nextSchedules);
    setEventRoutines(nextEventRoutines);
    setRoutineActivity(nextActivity);
    setBackgroundService(nextBackground);
    setAutonomyPolicy(nextAutonomyPolicy);
  }, [schedulesAvailable]);

  const refreshDelegations = useCallback(async () => {
    const next = await listLocalBotDelegations();
    setDelegations(next);
  }, []);

  useEffect(() => {
    void refreshRoutineState().catch((reason) => {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [refreshRoutineState]);

  useEffect(() => {
    if (!schedulesAvailable) {
      setAutonomyPolicy(null);
      return;
    }
    let disposed = false;
    let stopPolicy: (() => void) | undefined;
    let stopSettings: (() => void) | undefined;
    const refresh = () => void getBotAutonomyPolicy(deviceTimezone()).then((policy) => {
      if (!disposed) setAutonomyPolicy(policy);
    }).catch((reason) => {
      if (!disposed) setGlobalError(reason instanceof Error ? reason.message : String(reason));
    });
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    if (isNativeRuntime()) {
      void listen<RoutineAutonomyPolicy>("bot-autonomy-policy-changed", (event) => {
        if (!disposed) setAutonomyPolicy(event.payload);
      }).then((stop) => {
        if (disposed) stop();
        else stopPolicy = stop;
      });
      void listen<string>("open-bot-settings", () => {
        if (!disposed) openSettings("general");
      }).then((stop) => {
        if (disposed) stop();
        else stopSettings = stop;
      });
    }
    return () => {
      disposed = true;
      window.clearInterval(timer);
      stopPolicy?.();
      stopSettings?.();
    };
  }, [openSettings, schedulesAvailable]);

  const changeAutonomyPolicy = async (changes: Partial<RoutineAutonomyPolicy>) => {
    if (!autonomyPolicy || savingAutonomyPolicy) return;
    setSavingAutonomyPolicy(true);
    setGlobalError(null);
    try {
      const saved = await updateBotAutonomyPolicy({
        globallyPaused: changes.globallyPaused ?? autonomyPolicy.globallyPaused,
        quietHoursEnabled: changes.quietHoursEnabled ?? autonomyPolicy.quietHoursEnabled,
        quietStart: changes.quietStart ?? autonomyPolicy.quietStart,
        quietEnd: changes.quietEnd ?? autonomyPolicy.quietEnd,
        dailyDigestEnabled: changes.dailyDigestEnabled ?? autonomyPolicy.dailyDigestEnabled,
        dailyDigestTime: changes.dailyDigestTime ?? autonomyPolicy.dailyDigestTime,
        timezone: deviceTimezone(),
      });
      setAutonomyPolicy(saved);
      setGlobalNotice(saved.globallyPaused ? "All routines paused" : "Autonomy settings saved");
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingAutonomyPolicy(false);
    }
  };

  useEffect(() => {
    if (!catalogReady) return;
    const recoverOnce = async () => {
      if (delegationsRecovered.current) return;
      delegationsRecovered.current = true;
      try {
        const next = await recoverLocalBotDelegations();
        setDelegations(next);
        for (const delegation of next) {
          for (const target of delegation.targets) {
            if (target.status === "queued") {
              void runDelegationTargetRef.current?.(delegation, target);
            }
          }
        }
      } catch (reason) {
        delegationsRecovered.current = false;
        setGlobalError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void recoverOnce();
    const onFocus = () => {
      if (!delegationsRecovered.current) void recoverOnce();
      else void refreshDelegations().catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [catalogReady, refreshDelegations]);

  useEffect(() => {
    const intent = ++memoryLoadIntent.current;
    setMemoryUndo(null);
    if (!activeBotId) {
      setMemories([]);
      return;
    }
    void listLocalBotMemories(activeBotId).then((next) => {
      if (intent === memoryLoadIntent.current) setMemories(next);
    }).catch((reason) => {
      if (intent === memoryLoadIntent.current) {
        setMemories([]);
        setGlobalError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }, [activeBotId]);

  useEffect(() => {
    const intent = ++memoryProposalLoadIntent.current;
    setMemoryProposalActionId(null);
    if (!activeBotId) {
      setMemoryProposals([]);
      return;
    }
    void listLocalBotMemoryProposals(activeBotId).then((next) => {
      if (intent === memoryProposalLoadIntent.current) setMemoryProposals(next);
    }).catch((reason) => {
      if (intent === memoryProposalLoadIntent.current) {
        setMemoryProposals([]);
        setGlobalError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }, [activeBotId]);

  const refreshBrowserDownloads = useCallback(async (botId: string) => {
    const intent = ++downloadLoadIntent.current;
    const next = await listQuarantinedBrowserDownloads(botId);
    if (intent === downloadLoadIntent.current && activeBotIdRef.current === botId) {
      setBrowserDownloads(next);
    }
    return next;
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};
    void listenForLocalBrowserEvents((event) => {
      if (!["download-quarantined", "download-failed"].includes(event.eventType)) return;
      const botId = activeBotIdRef.current;
      if (!botId) return;
      void refreshBrowserDownloads(botId).catch((reason) => {
        if (activeBotIdRef.current === botId) {
          setGlobalError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((reason) => {
      if (!disposed) setGlobalError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [refreshBrowserDownloads]);

  useEffect(() => {
    const intent = ++downloadLoadIntent.current;
    if (!activeBotId) {
      setBrowserDownloads([]);
      return;
    }
    void listQuarantinedBrowserDownloads(activeBotId).then((next) => {
      if (intent === downloadLoadIntent.current && activeBotIdRef.current === activeBotId) {
        setBrowserDownloads(next);
      }
    }).catch((reason) => {
      if (intent === downloadLoadIntent.current && activeBotIdRef.current === activeBotId) {
        setBrowserDownloads([]);
        setGlobalError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }, [activeBotId]);

  useEffect(() => {
    const intent = ++groupLoadIntent.current;
    setGroupOpen(false);
    setGroupError(null);
    if (!activeBotId) {
      setGroupOwnerBotId(null);
      setGroupMembers([]);
      setGroupDraftIds([]);
      return;
    }
    void listLocalBotGroupMembers(activeBotId).then((next) => {
      if (intent !== groupLoadIntent.current) return;
      setGroupOwnerBotId(activeBotId);
      setGroupMembers(next);
      setGroupDraftIds(next.map((member) => member.id));
    }).catch((reason) => {
      if (intent !== groupLoadIntent.current) return;
      setGroupOwnerBotId(null);
      setGroupMembers([]);
      setGroupDraftIds([]);
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [activeBotId]);

  useEffect(() => {
    const intent = ++skillLoadIntent.current;
    setSkillUndo(null);
    if (!catalogReady) {
      setSkills([]);
      return;
    }
    void listLocalBotSkills().then((next) => {
      if (intent === skillLoadIntent.current) setSkills(next);
    }).catch((reason) => {
      if (intent === skillLoadIntent.current) {
        setSkills([]);
        setGlobalError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }, [catalogReady]);

  useEffect(() => {
    const intent = ++tableLoadIntent.current;
    setTableView(null);
    if (!activeBotId) {
      setBotTables([]);
      return;
    }
    void listLocalBotTables(activeBotId).then((next) => {
      if (intent === tableLoadIntent.current) setBotTables(next);
    }).catch((reason) => {
      if (intent === tableLoadIntent.current) {
        setBotTables([]);
        setGlobalError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }, [activeBotId]);

  const openBotNotificationRoute = useCallback(async (route: LocalNotificationRoute) => {
    if (route.artifactKind === "activity") {
      try {
        setActivityOpen(true);
        setGroupOpen(false);
        setNewBotOpen(false);
        setSettingsOpen(false);
        setProfileOpen(false);
        if (window.innerWidth < 900) setSidebarOpen(false);
        await consumeLocalNotification(route.id);
        window.focus();
      } catch (reason) {
        setGlobalError(reason instanceof Error ? reason.message : String(reason));
      }
      return;
    }
    if (route.artifactKind !== "bot") return;
    setActivityOpen(false);
    setGroupOpen(false);
    setNewBotOpen(false);
    setSettingsOpen(false);
    setProfileOpen(false);
    const intent = ++catalogIntent.current;
    const selection = catalogMutationQueue.current
      .catch(() => undefined)
      .then(() => setActiveLocalBot(route.artifactId));
    catalogMutationQueue.current = selection.then(() => undefined, () => undefined);
    try {
      const next = await selection;
      if (intent === catalogIntent.current) setCatalog(next);
      await consumeLocalNotification(route.id);
      window.focus();
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<LocalNotificationRoute>("local-notification-open", (event) => {
      if (!disposed) void openBotNotificationRoute(event.payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openBotNotificationRoute]);

  useEffect(() => {
    if (!catalogReady || !isNativeRuntime()) return;
    let disposed = false;
    void takeOpenedLocalNotification().then((route) => {
      if (!disposed && route) void openBotNotificationRoute(route);
    });
    return () => {
      disposed = true;
    };
  }, [activeBotId, catalogReady, openBotNotificationRoute]);

  const refreshProviderReadiness = useCallback(async () => {
    if (providerRefreshInFlight.current) return;
    providerRefreshInFlight.current = true;
    try {
      const [nextProviders, nextCredentials] = await Promise.all([
        probeLocalProviders(),
        probeProviderApiKeys(),
      ]);
      setProviders(nextProviders);
      setApiCredentials(nextCredentials);
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      providerRefreshInFlight.current = false;
    }
  }, []);

  const refreshComputerUse = useCallback(async () => {
    if (!computerUseAvailable || !activeBotId) {
      setComputerUseReadiness(null);
      setRunningComputerApps([]);
      setComputerAppScopes([]);
      setComputerAppChoice("");
      return null;
    }
    const [readiness, apps, scopes] = await Promise.all([
      probeComputerUseReadiness(),
      listRunningComputerApps(),
      listComputerAppScopes(activeBotId),
    ]);
    setComputerUseReadiness(readiness);
    setRunningComputerApps(apps);
    setComputerAppScopes(scopes);
    const available = apps.filter((app) => !scopes.some((scope) => scope.bundleId === app.bundleId));
    setComputerAppChoice((current) => (
      available.some((app) => app.bundleId === current) ? current : available[0]?.bundleId || ""
    ));
    return readiness;
  }, [activeBotId, computerUseAvailable]);

  useEffect(() => {
    void refreshComputerUse().catch((reason) => {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [refreshComputerUse]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onFocus = () => {
      void refreshProviderReadiness();
      if (settingsSection === "privacy") {
        void refreshComputerUse().then(async (readiness) => {
          if (!computerSetupRequested.current
            || readiness?.accessibility !== "granted"
            || readiness.screenRecording !== "required") return;
          computerSetupRequested.current = false;
          setComputerUseBusy(true);
          try {
            const updated = await requestComputerUsePermission("screen-recording");
            setComputerUseReadiness(updated);
            if (updated.ready) setGlobalNotice("Computer use is ready");
            else setGlobalNotice("Allow Screen Recording in macOS Settings, then return to Codelit.");
            await refreshComputerUse();
          } catch (reason) {
            setGlobalError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setComputerUseBusy(false);
          }
        }).catch(() => undefined);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshComputerUse, refreshProviderReadiness, settingsOpen, settingsSection]);

  useEffect(() => {
    if (!bot || runState !== "idle") return;
    const browserPending = workspace?.approvals
      .map(pendingBrowserRunFromApproval)
      .find((candidate): candidate is PendingBrowserRun => (
        Boolean(candidate) && candidate?.botId === bot.id
      )) || null;
    if (browserPending) {
      updateExecutionStates((current) => waitForBotBrowserApproval(current, browserPending));
      return;
    }
    const computerPending = workspace?.approvals
      .map(pendingComputerRunFromApproval)
      .find((candidate): candidate is PendingComputerRun => (
        Boolean(candidate) && candidate?.botId === bot.id
      )) || null;
    if (computerPending) {
      updateExecutionStates((current) => waitForBotComputerApproval(current, computerPending));
      return;
    }
    const mcpPending = workspace?.approvals
      .map(pendingMcpRunFromApproval)
      .find((candidate): candidate is PendingMcpRun => (
        Boolean(candidate) && candidate?.botId === bot.id
      )) || null;
    if (mcpPending) {
      updateExecutionStates((current) => waitForBotMcpApproval(current, mcpPending));
    }
  }, [bot, runState, updateExecutionStates, workspace?.approvals]);

  useEffect(() => () => {
    for (const waiter of browserWaiters.current.values()) {
      window.clearInterval(waiter.interval);
      waiter.reject(new Error("Website inspection stopped before the browser was ready."));
    }
    browserWaiters.current.clear();
    for (const queued of browserLaneQueue.current.splice(0)) {
      queued.reject(new Error("Website inspection stopped before its browser lane was available."));
    }
    browserTeachingRelease.current?.();
    browserTeachingRelease.current = null;
    browserSkillRelease.current?.();
    browserSkillRelease.current = null;
    browserLaneOwner.current = null;
  }, []);

  useEffect(() => {
    if (!hasConversation && runState === "idle") return;
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeEvent, activityOpen, browserDownloads.length, browserSkillRun?.runId, catalog?.workspace.blocks.length, delegations.length, hasConversation, memoryProposals.length, pendingBrowserRun?.runId, pendingComputerRun?.runId, pendingMcpRun?.runId, pendingSkillReviews.length, runState]);

  useEffect(() => {
    const onResize = () => setSidebarOpen(window.innerWidth >= 900);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!activeBrowserRunId
      || (!newBotOpen && !settingsOpen && !profileOpen && !groupOpen)
      || window.innerWidth >= 1000) return;
    setSidebarOpen(false);
  }, [activeBrowserRunId, groupOpen, newBotOpen, profileOpen, settingsOpen]);

  const hasProject = Boolean(workspace?.workspaceFolder?.accessValidated);
  const browserReadAvailable = buildChannelReady
    && BOT_CAPABILITY_MANIFESTS[buildChannel].managedBrowserRead;
  const connectedToolCount = useMemo(() => mcpServers.reduce((total, server) => (
    total + (server.enabled ? server.tools.filter((tool) => tool.approved).length : 0)
  ), 0), [mcpServers]);
  const outcomeCapabilities = useMemo(() => ({
    ...(computerUseAvailable && computerAppScopes[0]?.appName
      ? { approvedComputerAppName: computerAppScopes[0].appName }
      : {}),
    browserReadAvailable,
    connectedToolCount,
    hasProject,
    schedulesAvailable,
    teammateCount: activeGroupMembers.length,
  }), [activeGroupMembers.length, browserReadAvailable, computerAppScopes, computerUseAvailable, connectedToolCount, hasProject, schedulesAvailable]);
  const safeAutoApprove = bot?.spec.permissionPolicy.approvalMode === "safe-auto";
  const browserDomains = bot?.spec.permissionPolicy.browserDomains || [];
  const pendingSafeReadEligible = Boolean(
    bot
    && pendingBrowserRun
    && !pendingBrowserRun.browserAction
    && shouldAutoApproveBotAction(
      { ...bot.spec.permissionPolicy, approvalMode: "safe-auto" },
      "browser-read",
      pendingBrowserRun.target,
    ),
  );
  const eligibleProviders = useMemo(
    () => buildChannelReady ? botProvidersForChannel(providers, buildChannel) : [],
    [providers, buildChannel, buildChannelReady],
  );
  const engine = useMemo(
    () => bot && buildChannelReady
      ? selectBotEngine(providers, buildChannel, bot.spec.enginePolicy)
      : null,
    [bot, buildChannel, buildChannelReady, providers],
  );
  const setupAction = useMemo(
    () => buildChannelReady ? onDeviceSetupAction(providers, buildChannel) : null,
    [providers, buildChannel, buildChannelReady],
  );
  const filteredBots = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!catalog || !query) return catalog?.bots || [];
    return catalog.bots.filter((candidate) => (
      candidate.name.toLowerCase().includes(query)
      || candidate.latestStatus.toLowerCase().includes(query)
      || candidate.spec.job.toLowerCase().includes(query)
    ));
  }, [catalog, search]);
  const activeDelegations = useMemo(
    () => delegations.filter((delegation) => delegation.parentBotId === bot?.id),
    [bot?.id, delegations],
  );
  const threadTimeline = useMemo(() => [
    ...(workspace?.blocks || []).map((block) => ({
      kind: "block" as const,
      id: block.id,
      createdAt: block.createdAt,
      block,
    })),
    ...activeDelegations.map((delegation) => ({
      kind: "delegation" as const,
      id: delegation.id,
      createdAt: delegation.createdAt,
      delegation,
    })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)), [activeDelegations, workspace?.blocks]);
  const mention = trailingBotMention(prompt);
  const mentionCandidates = useMemo(() => {
    if (!catalog || !mention || mentionDismissed) return [];
    return catalog.bots
      .filter((candidate) => candidate.id !== bot?.id
        && (!mention.query || candidate.name.toLowerCase().includes(mention.query)))
      .slice(0, 5);
  }, [bot?.id, catalog, mention, mentionDismissed]);
  const promptDelegationIntent = bot && catalog && prompt.trim()
    ? parseBotDelegationIntent(prompt, catalog.bots, bot.id, activeGroupMembers.map((member) => member.id))
    : null;
  const promptTeachingIntent = prompt.trim() ? parseBrowserTeachingRequest(prompt) : null;
  const promptBrowserSkillRun = prompt.trim() ? parseBrowserSkillRunRequest(prompt, skills) : null;
  const promptDataIntent = prompt.trim() ? parseBotDataIntent(prompt) : null;
  const promptControlIntent = prompt.trim()
    ? parseBotControlIntent(prompt, previousUserRequest(workspace?.blocks || []))
    : null;
  const promptConversationReply = bot && prompt.trim()
    ? localConversationReply(prompt, escapeBotMarkdown(bot.name))
    : null;
  const composerCanRun = Boolean(
    engine
    || promptDelegationIntent
    || promptDataIntent
    || promptControlIntent
    || promptConversationReply
    || (browserReadAvailable && (promptTeachingIntent || promptBrowserSkillRun)),
  );
  const activeDelegationCount = delegations.filter((delegation) => (
    ["queued", "running", "awaiting-approval"].includes(delegation.status)
  )).length;
  const browserActivities = useMemo(() => Object.values(executionStates).flatMap((state) => {
    if (!state.pendingBrowserRun
      || state.pendingBrowserRun.runId !== activeBrowserRunId
      || !["running", "canceling"].includes(state.runState)) return [];
    const owner = catalog?.bots.find((candidate) => candidate.id === state.botId);
    return [{
      pending: state.pendingBrowserRun,
      botName: owner?.name || "Bot",
      disabled: state.runState === "canceling",
    }];
  }), [activeBrowserRunId, catalog?.bots, executionStates]);

  const replaceBot = (updated: LocalBotRecord) => {
    setCatalog((current) => current ? {
      ...current,
      bots: current.bots.map((candidate) => candidate.id === updated.id ? updated : candidate),
      activeBot: current.activeBot.id === updated.id ? updated : current.activeBot,
      workspace: current.activeBot.id === updated.id
        ? { ...current.workspace, thread: { ...current.workspace.thread, title: updated.name } }
        : current.workspace,
    } : current);
  };

  const replaceDelegation = (updated: LocalBotDelegation) => {
    setDelegations((current) => [
      updated,
      ...current.filter((candidate) => candidate.id !== updated.id),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  };

  const consumeRunEvent = (
    botId: string,
    event: ProviderRunEvent,
    events: ProviderRunEvent[],
  ) => {
    if (!isTransientProviderRunEvent(event)) events.push(event);
    updateExecutionStates((current) => applyBotRunEvent(current, botId, event));
  };

  const revealValidatedAnswer = async (botId: string, runId: string, answer: string) => {
    const ensureActive = () => {
      const current = botExecutionState(executionStatesRef.current, botId);
      if (!canContinueProviderReveal(
        runId,
        current.liveRun,
        canceledRunIds.current.has(runId),
      )) {
        throw new Error("Run canceled before the answer was saved.");
      }
    };
    ensureActive();
    const bounded = answer;
    const live = botExecutionState(executionStatesRef.current, botId).liveRun;
    const current = live.runId === runId ? live.answer : "";
    const reconciliation = finalAnswerReconciliation(current, bounded);
    if (reconciliation.mode === "settled") return;
    if (reconciliation.mode === "replace") {
      ensureActive();
      updateExecutionStates((states) => revealBotExecutionAnswer(states, botId, runId, reconciliation.answer));
      return;
    }
    const prefixLength = current.length;
    const remaining = bounded.length - prefixLength;
    if (remaining <= 0) return;
    const step = Math.max(1, Math.ceil(remaining / 24));
    for (let length = prefixLength + step; length < bounded.length + step; length += step) {
      ensureActive();
      const visible = bounded.slice(0, Math.min(length, bounded.length));
      updateExecutionStates((states) => revealBotExecutionAnswer(states, botId, runId, visible));
      if (visible.length === bounded.length) break;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 18));
      ensureActive();
    }
  };

  const waitForBrowserReady = (botId: string, runId: string) => {
    const current = browserSessions.current.get(runId) || null;
    if (isBotBrowserSessionOpen(current, browserSessionId(runId))) {
      return Promise.resolve(current);
    }
    return new Promise<LocalBrowserSession>((resolve, reject) => {
      const replaced = browserWaiters.current.get(runId);
      if (replaced) {
        window.clearInterval(replaced.interval);
        replaced.reject(new Error("The previous website inspection was replaced."));
      }
      const waiter: BrowserSessionWaiter = {
        runId,
        botId,
        resolve,
        reject,
        interval: 0,
        remainingVisibleMs: 25_000,
      };
      waiter.interval = window.setInterval(() => {
        waiter.remainingVisibleMs -= 250;
        if (waiter.remainingVisibleMs > 0) return;
        window.clearInterval(waiter.interval);
        browserWaiters.current.delete(runId);
        reject(new Error("The approved website did not finish opening inside Codelit."));
      }, 250);
      browserWaiters.current.set(runId, waiter);
    });
  };

  const onBrowserSessionChange = useCallback((runId: string, session: LocalBrowserSession | null) => {
    if (session) browserSessions.current.set(runId, session);
    else browserSessions.current.delete(runId);
    const waiter = browserWaiters.current.get(runId);
    if (!session || !waiter || !isBotBrowserSessionOpen(session, browserSessionId(waiter.runId))) return;
    window.clearInterval(waiter.interval);
    browserWaiters.current.delete(runId);
    waiter.resolve(session);
  }, []);

  const onBrowserOpenError = useCallback((runId: string, message: string) => {
    const waiter = browserWaiters.current.get(runId);
    if (!waiter) return;
    window.clearInterval(waiter.interval);
    browserWaiters.current.delete(runId);
    waiter.reject(new Error(message));
  }, []);

  const changeBotStatus = async (
    botId: string,
    status: LocalBotRecord["status"],
    latestStatus: string,
  ) => {
    replaceBot(await updateLocalBotStatus(botId, status, latestStatus));
  };

  const changeApprovalMode = async (enabled: boolean) => {
    if (!bot || savingApprovalModeRef.current || runState !== "idle") return;
    const botId = bot.id;
    savingApprovalModeRef.current = true;
    setSavingApprovalMode(true);
    setBotFeedback(botId, { error: null, notice: null });
    try {
      replaceBot(await updateLocalBotApprovalMode(botId, enabled ? "safe-auto" : "ask"));
      setBotFeedback(botId, { notice: enabled
        ? "Safe read approvals enabled"
        : "Safe read approvals now ask first" });
    } catch (reason) {
      setBotFeedback(botId, { error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      savingApprovalModeRef.current = false;
      setSavingApprovalMode(false);
    }
  };

  const removeBrowserDomain = async (domain: string) => {
    if (!bot || savingApprovalModeRef.current || runState !== "idle") return;
    const botId = bot.id;
    savingApprovalModeRef.current = true;
    setSavingApprovalMode(true);
    setBotFeedback(botId, { error: null, notice: null });
    try {
      const updated = await updateLocalBotBrowserDomains(
        botId,
        bot.spec.permissionPolicy.browserDomains.filter((candidate) => candidate !== domain),
        bot.currentVersion,
      );
      replaceBot(updated);
      setBotFeedback(botId, { notice: `${domain} will ask before the next website read` });
    } catch (reason) {
      setBotFeedback(botId, { error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      savingApprovalModeRef.current = false;
      setSavingApprovalMode(false);
    }
  };

  const setupComputerUse = async () => {
    if (!computerUseReadiness?.available || computerUseBusy) return;
    const permission = computerUseReadiness.accessibility !== "granted"
      ? "accessibility"
      : "screen-recording";
    setComputerUseBusy(true);
    setGlobalError(null);
    try {
      computerSetupRequested.current = permission === "accessibility";
      let readiness = await requestComputerUsePermission(permission);
      if (permission === "accessibility"
        && readiness.accessibility === "granted"
        && readiness.screenRecording === "required") {
        computerSetupRequested.current = false;
        readiness = await requestComputerUsePermission("screen-recording");
      }
      setComputerUseReadiness(readiness);
      if (permission === "accessibility" && readiness.accessibility !== "granted") {
        setGlobalNotice("Allow Codelit in Accessibility, then return here. Setup will continue automatically.");
      } else if (!readiness.ready) {
        computerSetupRequested.current = false;
        setGlobalNotice("Allow Screen Recording in macOS Settings, then return to Codelit.");
      } else {
        computerSetupRequested.current = false;
      }
      await refreshComputerUse();
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setComputerUseBusy(false);
    }
  };

  const allowComputerApp = async () => {
    if (!bot || !computerAppChoice || computerUseBusy) return;
    setComputerUseBusy(true);
    setGlobalError(null);
    try {
      await saveComputerAppScope({
        botId: bot.id,
        bundleId: computerAppChoice,
        access: "interact",
      });
      await refreshComputerUse();
      const app = runningComputerApps.find((candidate) => candidate.bundleId === computerAppChoice);
      setBotFeedback(bot.id, { notice: `${app?.name || "App"} is available to ${bot.name}. Each action will still ask.` });
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setComputerUseBusy(false);
    }
  };

  const removeComputerApp = async (scope: ComputerAppScope) => {
    if (computerUseBusy) return;
    setComputerUseBusy(true);
    setGlobalError(null);
    try {
      await deleteComputerAppScope(scope.botId, scope.bundleId);
      await refreshComputerUse();
      setBotFeedback(scope.botId, { notice: `${scope.appName} access removed` });
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setComputerUseBusy(false);
    }
  };

  const chooseBot = async (id: string) => {
    setActivityOpen(false);
    if (browserTeaching && id !== browserTeaching.botId) {
      setGlobalError("Finish or cancel the browser demonstration before switching bots.");
      return;
    }
    if (browserSkillRun && id !== browserSkillRun.botId) {
      setGlobalError("Finish or stop the browser skill before switching bots.");
      return;
    }
    if (id === bot?.id) {
      if (window.innerWidth < 900) setSidebarOpen(false);
      return;
    }
    const intent = ++catalogIntent.current;
    setGlobalError(null);
    const selection = catalogMutationQueue.current
      .catch(() => undefined)
      .then(() => setActiveLocalBot(id));
    catalogMutationQueue.current = selection.then(() => undefined, () => undefined);
    try {
      const next = await selection;
      if (intent !== catalogIntent.current) return;
      setCatalog(next);
      if (window.innerWidth < 900) setSidebarOpen(false);
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const addBot = async () => {
    const job = botJob.trim();
    if (!job || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setGlobalError(null);
    const intent = ++catalogIntent.current;
    const id = `bot-${crypto.randomUUID()}`;
    const name = normalizeBotName(newBotName) || createBotName(job);
    const creation = catalogMutationQueue.current
      .catch(() => undefined)
      .then(() => createLocalBot({ id, name, job, avatar: newBotAvatar, createdAt: new Date().toISOString() }));
    catalogMutationQueue.current = creation.then(() => undefined, () => undefined);
    try {
      const next = await creation;
      if (intent === catalogIntent.current) {
        setCatalog(next);
        setAutoStartBotId(next.activeBot.id);
      }
      setBotJob("");
      setNewBotName("");
      setNewBotAvatar(defaultBotAvatar(`new-bot-${Date.now()}`));
      setNewBotOpen(false);
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const openGroupEditor = () => {
    setGroupDraftIds(activeGroupMembers.map((member) => member.id));
    setGroupError(null);
    setGroupOpen(true);
  };

  const toggleGroupMember = (id: string) => {
    setGroupError(null);
    setGroupDraftIds((current) => current.includes(id)
      ? current.filter((candidate) => candidate !== id)
      : current.length < 2
        ? [...current, id]
        : current);
  };

  const saveGroupMembers = async () => {
    if (!bot || savingGroup) return;
    const ownerBotId = bot.id;
    setSavingGroup(true);
    setGroupError(null);
    try {
      const next = await updateLocalBotGroupMembers({
        ownerBotId,
        memberBotIds: groupDraftIds,
        updatedAt: new Date().toISOString(),
      });
      if (activeBotId === ownerBotId) {
        setGroupOwnerBotId(ownerBotId);
        setGroupMembers(next);
        setGroupDraftIds(next.map((member) => member.id));
      }
      setGroupOpen(false);
      setBotFeedback(ownerBotId, {
        notice: next.length ? "Conversation team updated" : "Conversation team cleared",
      });
    } catch (reason) {
      setGroupError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingGroup(false);
    }
  };

  const createBotFromGroup = () => {
    setGroupOpen(false);
    setNewBotName("");
    setNewBotAvatar(defaultBotAvatar(`new-bot-${Date.now()}`));
    setNewBotOpen(true);
  };

  const openProfileEditor = () => {
    if (!bot) return;
    setProfileName(bot.name);
    setProfileAvatar(avatarForBot(bot));
    setProfileError(null);
    setProfileOpen(true);
  };

  const chooseProfileImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setProfileError(null);
    try {
      setProfileAvatar(await avatarFromFile(file));
    } catch (reason) {
      setProfileError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const saveProfile = async () => {
    if (!bot || savingProfile) return;
    const name = normalizeBotName(profileName);
    if (!name) {
      setProfileError("Give this bot a name.");
      return;
    }
    setSavingProfile(true);
    setProfileError(null);
    try {
      replaceBot(await updateLocalBotProfile(bot.id, name, profileAvatar));
      setProfileOpen(false);
      setBotFeedback(bot.id, { notice: "Bot profile updated" });
    } catch (reason) {
      setProfileError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingProfile(false);
    }
  };

  const connectProject = async () => {
    if (!catalog || choosingFolder || hasAnyActiveRun) return;
    setChoosingFolder(true);
    setGlobalError(null);
    try {
      const next = await chooseWorkspaceFolder();
      if (next) {
        const refreshed = await bootstrapBots();
        setCatalog(refreshed);
        setGlobalNotice("Project connected read-only");
      }
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChoosingFolder(false);
    }
  };

  const setupOnDevice = async (selectedModel?: ProviderModel) => {
    const action = selectedModel ? onDeviceModelSetupAction(selectedModel) : setupAction;
    if (!action || modelSetup) {
      if (!action) openSettings("intelligence");
      return;
    }
    setGlobalError(null);
    setGlobalNotice(null);
    setModelSetup({ message: `${action.label}...` });
    try {
      const { model } = await manageLocalModel(
        action.provider,
        action.model.id,
        action.action,
        (event) => setModelSetup((current) => ({
          runId: current?.runId,
          message: event.message,
        })),
        (runId) => setModelSetup((current) => ({
          runId,
          message: current?.message || `${action.label}...`,
        })),
      );
      const nextProviders = await probeLocalProviders();
      setProviders(nextProviders);
      if (model.status === "ready") {
        setGlobalNotice("On-device intelligence is ready");
      } else {
        setGlobalError(model.detail);
        openSettings("intelligence");
      }
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
      openSettings("intelligence");
    } finally {
      setModelSetup(null);
    }
  };

  const cancelModelSetup = async () => {
    if (!modelSetup?.runId) return;
    try {
      await cancelIntelligenceTask(modelSetup.runId);
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const changeEngine = async (selection: IntelligenceSelection | null) => {
    if (!bot || savingEngine || runState !== "idle") return;
    setSavingEngine(true);
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      const allowedProviders = selection
        ? [...new Set([...bot.spec.enginePolicy.allowedProviders, selection.provider])]
        : bot.spec.enginePolicy.allowedProviders;
      replaceBot(await updateLocalBotEnginePolicy(bot.id, {
        mode: selection ? "fixed" : "auto",
        allowedProviders,
        ...(selection ? { fixedEngine: selection } : {}),
        allowMeteredFallback: bot.spec.enginePolicy.allowMeteredFallback,
      }));
      setBotFeedback(bot.id, {
        notice: selection
          ? `${providerLabel(providers, selection)} is now fixed for ${bot.name}`
          : `${bot.name} will choose the best ready non-metered engine`,
      });
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setSavingEngine(false);
    }
  };

  const changeMeteredFallback = async (allowMeteredFallback: boolean) => {
    if (!bot || savingEngine || runState !== "idle") return;
    setSavingEngine(true);
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      replaceBot(await updateLocalBotEnginePolicy(bot.id, {
        mode: bot.spec.enginePolicy.mode,
        allowedProviders: bot.spec.enginePolicy.allowedProviders,
        ...(bot.spec.enginePolicy.fixedEngine
          ? { fixedEngine: bot.spec.enginePolicy.fixedEngine }
          : {}),
        allowMeteredFallback,
      }));
      setBotFeedback(bot.id, {
        notice: allowMeteredFallback
          ? `Auto will prefer a configured AI provider for better answers from ${bot.name}`
          : `Auto will not use metered APIs for ${bot.name}`,
      });
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setSavingEngine(false);
    }
  };

  const startProviderSignIn = async (providerId: ProviderProbe["id"]) => {
    if (openingProvider) return;
    setOpeningProvider(providerId);
    setGlobalError(null);
    setGlobalNotice(null);
    try {
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (provider?.status === "not-installed") {
        await openProviderSetup(providerId);
        setGlobalNotice(`Follow the official ${provider.label} setup guide, then return to Codelit`);
      } else if (providerId === "codex") {
        await openCodexSignIn();
        setGlobalNotice("Finish signing in to Codex in your browser, then return to Codelit");
      } else if (providerId === "copilot") {
        await openCopilotSignIn();
        setGlobalNotice("Finish signing in to GitHub Copilot in your browser, then return to Codelit");
      } else {
        throw new Error("This subscription provider does not have an approved sign-in path yet.");
      }
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpeningProvider(null);
    }
  };

  const startProviderSetup = async (providerId: ProviderProbe["id"]) => {
    if (openingProvider) return;
    setOpeningProvider(providerId);
    setGlobalError(null);
    setGlobalNotice(null);
    try {
      await openProviderSetup(providerId);
      const label = providers.find((candidate) => candidate.id === providerId)?.label || "provider";
      setGlobalNotice(`Follow the official ${label} setup guide, then return to Codelit`);
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpeningProvider(null);
    }
  };

  const saveApiKey = async (provider: ApiKeyProviderId) => {
    if (providerCredentialBusy) return;
    const apiKey = apiKeyDrafts[provider];
    if (!apiKey.trim()) {
      setGlobalError("Paste an API key before saving it to Keychain.");
      return;
    }
    setProviderCredentialBusy(provider);
    setGlobalError(null);
    setGlobalNotice(null);
    try {
      const status = await saveProviderApiKey({ provider, apiKey });
      setApiCredentials((current) => [
        ...current.filter((candidate) => candidate.provider !== provider),
        status,
      ]);
      setApiKeyDrafts((current) => ({ ...current, [provider]: "" }));
      const nextProviders = await probeLocalProviders();
      setProviders(nextProviders);
      setGlobalNotice(`${providerLabel(nextProviders, { provider, model: "" })} key saved in Keychain`);
    } catch (reason) {
      setApiKeyDrafts((current) => ({ ...current, [provider]: "" }));
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProviderCredentialBusy(null);
    }
  };

  const removeApiKey = async (provider: ApiKeyProviderId) => {
    if (providerCredentialBusy) return;
    setProviderCredentialBusy(provider);
    setGlobalError(null);
    setGlobalNotice(null);
    try {
      const status = await deleteProviderApiKey(provider);
      setApiCredentials((current) => [
        ...current.filter((candidate) => candidate.provider !== provider),
        status,
      ]);
      setApiKeyDrafts((current) => ({ ...current, [provider]: "" }));
      const nextProviders = await probeLocalProviders();
      setProviders(nextProviders);
      setGlobalNotice("API key removed from Keychain");
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProviderCredentialBusy(null);
    }
  };

  const exportWorkspace = async () => {
    if (exporting || !isNativeRuntime()) return;
    setExporting(true);
    setGlobalError(null);
    setGlobalNotice(null);
    try {
      const path = await exportLocalWorkspace();
      if (path) {
        setSettingsOpen(false);
        setGlobalNotice(`Exported ${path.split("/").pop() || "Codelit backup"}`);
      }
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(false);
    }
  };

  const deleteWorkspace = async () => {
    if (
      deletingWorkspace
      || deleteWorkspaceConfirmation !== "DELETE"
      || !isNativeRuntime()
    ) return;
    setDeletingWorkspace(true);
    setDeleteWorkspaceError(null);
    setGlobalError(null);
    setGlobalNotice(null);
    try {
      await deleteLocalWorkspace(deleteWorkspaceConfirmation);
      window.location.reload();
    } catch (reason) {
      setDeleteWorkspaceError(reason instanceof Error ? reason.message : String(reason));
      setDeletingWorkspace(false);
    }
  };

  const togglePilotReport = async () => {
    if (pilotAction) return;
    if (pilotReport) {
      setPilotReport(null);
      return;
    }
    if (!isNativeRuntime()) return;
    setPilotAction("loading");
    setGlobalError(null);
    try {
      setPilotReport(await getLocalPilotReport());
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPilotAction(null);
    }
  };

  const exportPilotReport = async () => {
    if (pilotAction || !isNativeRuntime()) return;
    setPilotAction("exporting");
    setGlobalError(null);
    try {
      const path = await exportLocalPilotReport();
      if (path) setGlobalNotice(`Exported ${path.split("/").pop() || "private product report"}`);
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPilotAction(null);
    }
  };

  const reportUnexpectedAction = async () => {
    if (pilotAction || !isNativeRuntime()) return;
    setPilotAction("reporting");
    setGlobalError(null);
    try {
      setPilotReport(await recordLocalUnexpectedAction(unexpectedActionCategory));
      setGlobalNotice("Unexpected action recorded locally");
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPilotAction(null);
    }
  };

  const runBotHarness = async (input: {
    runBot: LocalBotRecord;
    runSnapshot: NonNullable<typeof workspace>;
    runId: string;
    request: string;
    basePrompt: string;
    engine: IntelligenceSelection;
    selectionMode: "fixed" | "auto";
    meteredFallbackAuthorized: boolean;
    connectedMcpServers: LocalMcpServer[];
    events: ProviderRunEvent[];
    providerInvocation: { started: boolean };
    checkpoint?: AgenticHarnessCheckpoint;
  }): Promise<AgenticReadLoopResult> => {
    const {
      runBot,
      runSnapshot,
      runId,
      request,
      basePrompt,
      engine,
      selectionMode,
      meteredFallbackAuthorized,
      connectedMcpServers,
      events,
      providerInvocation,
      checkpoint,
    } = input;
    const hasApprovedFolder = Boolean(runSnapshot.workspaceFolder?.accessValidated);
    const folderIsProject = selectedFolderMatchesPurpose(runSnapshot.workspaceFolder?.path, "project");
    const availableTools = agenticReadToolsForWorkspace(hasApprovedFolder, folderIsProject);
    const chatMcpTools = mcpToolsForChat(request, connectedMcpServers);
    const onRunEvent = (event: ProviderRunEvent) => consumeRunEvent(runBot.id, event, events);
    const { runAgenticReadLoop } = await import("./agentic-read-loop");
    return runAgenticReadLoop({
      basePrompt,
      request,
      tools: availableTools,
      maxToolCalls: runBot.spec.autonomyPolicy.maxActionsPerRun,
      mcpTools: chatMcpTools,
      ...(checkpoint ? { checkpoint } : {}),
      invoke: async (turnPrompt, turn) => {
        if (canceledRunIds.current.has(runId)) throw new Error("Run canceled by user.");
        await changeBotStatus(
          runBot.id,
          "thinking",
          turn === 0 && !checkpoint ? "Choosing the next step" : "Reviewing completed work",
        );
        return runIntelligenceTask(
          engine,
          turnPrompt,
          (event) => {
            if (event.eventType === "output-delta") return;
            onRunEvent(event);
          },
          undefined,
          runId,
          selectionMode,
          meteredFallbackAuthorized,
          () => { providerInvocation.started = true; },
        );
      },
      execute: async (tool) => {
        if (canceledRunIds.current.has(runId)) throw new Error("Run canceled by user.");
        const toolStatus = {
          read_project_overview: "Reading the approved project",
          list_selected_folder: "Reading the approved folder",
          list_local_tables: "Checking local tables",
          list_local_routines: "Checking local routines",
          list_connected_tools: "Checking reviewed connections",
        }[tool];
        await changeBotStatus(runBot.id, "working", toolStatus);
        if (tool === "list_local_tables") {
          const tables = await listLocalBotTables(runBot.id);
          return {
            context: [tables.length
              ? [
                  "Local tables available to this bot:",
                  ...tables.map((table) => (
                    `- ${table.name}: ${table.rowCount} rows; columns ${table.columns.map((column) => `${column.name} (${column.type})`).join(", ")}`
                  )),
                ].join("\n")
              : "This bot has no local tables."],
            completedTools: [{ toolId: "local-tables", toolName: "Local tables" }],
          };
        }
        if (tool === "list_local_routines") {
          const currentRoutines = routinesForBot(await listLocalSchedules(), runBot.id);
          return {
            context: [currentRoutines.length
              ? [
                  "Local routines configured for this bot:",
                  ...currentRoutines.map((routine) => (
                    `- ${routine.title}: ${routine.enabled ? "enabled" : "paused"}; ${readBotRoutineSnapshot(routine)?.triggerLabel || `${routine.cadence} at ${routine.localTime}`}; next ${routine.nextDueAt || "not scheduled"}`
                  )),
                ].join("\n")
              : "This bot has no local routines."],
            completedTools: [{ toolId: "local-routines", toolName: "Local routines" }],
          };
        }
        if (tool === "list_connected_tools") {
          return {
            context: [connectedMcpServers.length
              ? [
                  "Reviewed local tool connections:",
                  ...connectedMcpServers.map((server) => {
                    const approved = server.tools.filter((candidate) => candidate.approved);
                    return `- ${server.name}: ${approved.length ? approved.map((candidate) => `${candidate.name} (${candidate.effect})`).join(", ") : "no approved tools"}`;
                  }),
                ].join("\n")
              : "No reviewed local tool connections are ready."],
            completedTools: [{ toolId: "local-connections", toolName: "Local connections" }],
          };
        }
        const toolResult = tool === "read_project_overview"
          ? await readLocalProjectContext(runId, onRunEvent)
          : await readLocalFolderListing(runId, onRunEvent);
        if (toolResult.status !== "completed") {
          throw new Error(events.at(-1)?.message || "Codelit could not read the approved folder.");
        }
        return { context: toolResult.context, completedTools: toolResult.completedTools };
      },
    });
  };

  const stageMcpHarnessApproval = async (input: {
    loop: AgenticReadLoopResult;
    runBot: LocalBotRecord;
    runSnapshot: NonNullable<typeof workspace>;
    runId: string;
    request: string;
    engine: IntelligenceSelection;
    selectionMode: "fixed" | "auto";
    meteredFallbackAuthorized: boolean;
    memories: BotMemory[];
    memorySnapshotHash: string;
    skills: BotSkill[];
    skillVersions: Record<string, number>;
    events: ProviderRunEvent[];
    priorPending?: PendingMcpRun;
  }) => {
    const proposal = input.loop.mcpProposal;
    if (!proposal) throw new Error("The agent did not propose an external action.");
    if (proposal.tool.effect !== "read" && input.runBot.spec.permissionPolicy.writeActions === "disabled") {
      throw new Error("External actions are disabled for this bot. Enable reviewed writes, then ask again.");
    }
    await changeBotStatus(input.runBot.id, "thinking", `Preparing ${proposal.tool.serverName}`);
    const onRunEvent = (event: ProviderRunEvent) => consumeRunEvent(input.runBot.id, event, input.events);
    const prepared = await prepareNativeToolApproval(
      input.runId,
      [proposal.tool.reference],
      input.request,
      { [proposal.tool.reference]: proposal.arguments },
      onRunEvent,
      new AbortController().signal,
    );
    if (!prepared.approvalSha256) {
      throw new Error("The exact MCP call could not be bound for approval.");
    }
    const invocationStarted = Boolean(
      input.priorPending?.meteredProviderInvocationStarted
      || input.loop.result.meteredProviderInvocationStarted,
    );
    const plannerEvidence = Array.from(new Set([
      ...(input.priorPending?.plannerEvidence || []),
      ...input.loop.result.evidence,
    ])).slice(0, 16);
    const pending: PendingMcpRun = {
      approvalId: input.loop.checkpoint.mcpCalls.length
        ? `approval-${input.runId}-mcp-${input.loop.checkpoint.mcpCalls.length + 1}`
        : `approval-${input.runId}`,
      runId: input.runId,
      botId: input.runBot.id,
      botVersion: input.runBot.currentVersion,
      request: input.request,
      toolReference: proposal.tool.reference,
      serverName: proposal.tool.serverName,
      toolName: proposal.tool.name,
      description: proposal.tool.description,
      effect: proposal.tool.effect,
      destructive: proposal.tool.destructive,
      arguments: proposal.arguments,
      approvalSha256: prepared.approvalSha256,
      preview: prepared.evidence,
      engine: input.engine,
      selectionMode: input.selectionMode,
      meteredFallbackAuthorized: input.meteredFallbackAuthorized,
      meteredProviderInvocationStarted: invocationStarted,
      billingFallback: input.selectionMode === "auto"
        && input.meteredFallbackAuthorized
        && invocationStarted,
      plannerDurationMs: (input.priorPending?.plannerDurationMs || 0) + input.loop.result.durationMs,
      plannerCommandPath: input.loop.result.commandPath || input.priorPending?.plannerCommandPath || "agentic-harness",
      ...(input.loop.result.version || input.priorPending?.plannerVersion
        ? { plannerVersion: input.loop.result.version || input.priorPending?.plannerVersion }
        : {}),
      plannerEvidence,
      memories: input.memories,
      memorySnapshotHash: input.memorySnapshotHash,
      skills: input.skills,
      skillVersions: input.skillVersions,
      harnessCheckpoint: input.loop.checkpoint,
    };
    const priorSteps = input.loop.checkpoint.completedTools.map((tool) => ({
      id: tool.toolId,
      status: "completed" as const,
      toolName: tool.toolName,
    }));
    let snapshot = await saveLocalRunCheckpoint(input.runSnapshot, input.runId, {
      stepIndex: input.loop.checkpoint.actionCount,
      handoff: input.request,
      priorSteps,
      runContext: { kind: "mcp-action", ...pending },
    });
    snapshot = await recordLocalRunApproval(snapshot, {
      id: pending.approvalId,
      runId: input.runId,
      stepIndex: input.loop.checkpoint.actionCount,
      status: "awaiting",
      body: {
        kind: "mcp-action",
        ...pending,
        decisionSource: "pending-user",
        safetyClass: "typed-mcp-action",
      },
    });
    applyWorkspace(input.runBot.id, input.runBot.threadId, snapshot);
    await changeBotStatus(input.runBot.id, "waiting", `Waiting to use ${pending.serverName}`);
    updateExecutionStates((current) => waitForBotMcpApproval(current, pending));
    return { pending, snapshot };
  };

  const finishBrowserRun = async (
    pending: PendingBrowserRun,
    runBot: LocalBotRecord,
    runSnapshot: NonNullable<typeof workspace>,
    events: ProviderRunEvent[],
    invocation: { started: boolean },
    decisionSource: "user" | "bot-safe-mode" | "bot-domain-scope" = pending.approvalSource === "pending-user"
      ? "user"
      : pending.approvalSource,
  ) => {
    if (runBot.id !== pending.botId
      || runBot.currentVersion !== pending.botVersion
      || runSnapshot.thread.id !== runBot.threadId) {
      throw new Error("The website run no longer matches its bot conversation.");
    }
    const currentMemories = await listLocalBotMemories(pending.botId);
    const currentMemoryHash = await botMemorySnapshotHash(currentMemories);
    if (currentMemoryHash !== pending.memorySnapshotHash) {
      throw new Error("This bot's memory changed while website access was waiting. Start the request again so the new memory is explicit in its receipt.");
    }
    const currentSkills = await listLocalBotSkills();
    if (!botSkillSnapshotMatches(currentSkills, pending.skills)) {
      throw new Error("A selected skill changed while website access was waiting. Start the request again so the reviewed skill version is explicit in its receipt.");
    }
    const skillPreparation = prepareBotSkillRuns(pending.skills, pending.request, {
      projectApproved: Boolean(runSnapshot.workspaceFolder?.accessValidated),
    });
    if (skillPreparation.status === "invalid") throw new Error(skillPreparation.message);
    let skillRunReceipts = skillPreparation.receipts;
    const onRunEvent = (event: ProviderRunEvent) => {
      consumeRunEvent(pending.botId, event, events);
    };
    if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
    if (browserLaneOwner.current !== null && browserLaneOwner.current !== pending.runId) {
      await changeBotStatus(pending.botId, "waiting", "Waiting for the visible browser lane");
    }
    if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
    const browserResult = await (async () => {
      const releaseLane = await acquireBrowserLane(pending.runId);
      try {
        if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
        await changeBotStatus(pending.botId, "watching", `Opening ${pending.target.host}`);
        await waitForBrowserReady(pending.botId, pending.runId);
        if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
        await changeBotStatus(pending.botId, "working", `Reading ${pending.target.host}`);
        return await readLocalBrowserContext(
          pending.runId,
          {
            sessionId: browserSessionId(pending.runId),
            projectId: pending.botId,
            url: pending.target.url,
            host: pending.target.host,
            objective: pending.request,
          },
          onRunEvent,
        );
      } finally {
        browserSessions.current.delete(pending.runId);
        releaseLane();
      }
    })();
    if (browserResult.status !== "completed") {
      throw new Error(events.at(-1)?.message || "Codelit could not read the approved website.");
    }
    if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
    const result = await runIntelligenceTask(
      pending.engine,
      buildBotPrompt(
        runBot,
        pending.request,
        browserResult.context,
        pending.memories,
        pending.skills,
        pending.delegation,
        skillPreparation.promptContext,
      ),
      onRunEvent,
      undefined,
      pending.runId,
      pending.selectionMode,
      pending.meteredFallbackAuthorized,
      () => { invocation.started = true; },
    );
    let completed = runSnapshot;
    let finalAnswer: string | undefined;
    if (result.status === "completed" && result.structuredOutput) {
      finalAnswer = formatProviderFinalAnswer(result.structuredOutput);
      skillRunReceipts = completeBotSkillChecks(pending.skills, skillRunReceipts, finalAnswer);
      if (!botSkillChecksPassed(skillRunReceipts)) {
        throw new Error("A selected skill did not produce its required output. Review the run receipt before retrying.");
      }
      await revealValidatedAnswer(pending.botId, pending.runId, finalAnswer);
      updateExecutionStates((current) => commitBotExecution(
        current,
        pending.botId,
        pending.runId,
      ));
      completed = await appendThreadMessage(runSnapshot, finalAnswer, "assistant");
    }
    completed = await recordProviderRun(
      completed,
      "artifact-plan-ship-local",
      result,
      events,
      {
        botId: pending.botId,
        botVersion: pending.botVersion,
        engine: pending.engine,
        permissionSnapshot: runBot.spec.permissionPolicy,
        memorySnapshotHash: pending.memorySnapshotHash,
        memoryIds: pending.memories.map((memory) => memory.id),
        skillVersions: pending.skillVersions,
        skillContracts: skillRunReceipts,
        ...(pending.delegation ? { delegation: pending.delegation } : {}),
        approval: {
          mode: pending.approvalMode,
          decisionSource,
          scope: "read-only-browser",
        },
        browser: {
          host: pending.target.host,
          mode: "read",
          proofs: browserResult.browserProofs,
        },
        completedTools: browserResult.completedTools,
      },
      finalAnswer,
    );
    applyWorkspace(pending.botId, runBot.threadId, completed);
    return { completed, result, finalAnswer };
  };

  const finishBrowserActionRun = async (
    pending: PendingBrowserRun,
    runBot: LocalBotRecord,
    runSnapshot: NonNullable<typeof workspace>,
    events: ProviderRunEvent[],
    invocation: { started: boolean },
  ) => {
    const action = pending.browserAction;
    if (!action) throw new Error("The reviewed browser action is missing.");
    if (runBot.id !== pending.botId
      || runBot.currentVersion !== pending.botVersion
      || runSnapshot.thread.id !== runBot.threadId) {
      throw new Error("The browser action no longer matches its bot conversation.");
    }
    const currentMemories = await listLocalBotMemories(pending.botId);
    if (await botMemorySnapshotHash(currentMemories) !== pending.memorySnapshotHash) {
      throw new Error("This bot's memory changed while the browser action was waiting. Ask again so the new memory is explicit in its receipt.");
    }
    const currentSkills = await listLocalBotSkills();
    if (!botSkillSnapshotMatches(currentSkills, pending.skills)) {
      throw new Error("A selected skill changed while the browser action was waiting. Ask again so the reviewed skill version is explicit in its receipt.");
    }
    const skillPreparation = prepareBotSkillRuns(pending.skills, pending.request, {
      projectApproved: Boolean(runSnapshot.workspaceFolder?.accessValidated),
    });
    if (skillPreparation.status === "invalid") throw new Error(skillPreparation.message);
    let skillRunReceipts = skillPreparation.receipts;
    const onRunEvent = (event: ProviderRunEvent) => {
      consumeRunEvent(pending.botId, event, events);
    };
    if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
    if (browserLaneOwner.current !== null && browserLaneOwner.current !== pending.runId) {
      await changeBotStatus(pending.botId, "waiting", "Waiting for the visible browser lane");
    }
    const browserResult = await (async () => {
      const releaseLane = await acquireBrowserLane(pending.runId);
      try {
        if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
        await changeBotStatus(pending.botId, "watching", `Opening ${pending.target.host}`);
        await waitForBrowserReady(pending.botId, pending.runId);
        if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
        await changeBotStatus(pending.botId, "working", `Running approved action on ${pending.target.host}`);
        return await runApprovedLocalBrowserAction(
          pending.runId,
          {
            sessionId: browserSessionId(pending.runId),
            projectId: pending.botId,
            objective: pending.request,
            approvalSha256: action.approvalSha256,
            toolInputs: {},
          },
          onRunEvent,
        );
      } finally {
        browserSessions.current.delete(pending.runId);
        releaseLane();
      }
    })();
    const actionLabel = browserActionCompletedLabel(action);
    const receiptDetails = {
      botId: pending.botId,
      botVersion: pending.botVersion,
      engine: pending.engine,
      permissionSnapshot: runBot.spec.permissionPolicy,
      memorySnapshotHash: pending.memorySnapshotHash,
      memoryIds: pending.memories.map((memory) => memory.id),
      skillVersions: pending.skillVersions,
      skillContracts: skillRunReceipts,
      approval: {
        mode: "ask",
        decisionSource: "user",
        scope: browserActionScope(action),
        approvalSha256: action.approvalSha256,
      },
      browser: {
        host: pending.target.host,
        mode: "write",
        action: action.action,
        target: action.targetLabel,
        valueLength: action.valueLength,
        proofs: browserResult.browserProofs,
      },
      completedTools: browserResult.completedTools,
    };
    if (browserResult.status !== "completed" || browserResult.failure) {
      const uncertain = browserResult.failure?.uncertainWrite === true;
      const message = uncertain
        ? `Codelit sent the approved ${pending.target.host} action but could not verify its result. It will not retry automatically; inspect the page before trying again.`
        : events.at(-1)?.message || `Codelit could not run the approved ${pending.target.host} action.`;
      const failedResult: ProviderTaskResult = {
        runId: pending.runId,
        provider: pending.engine.provider,
        model: pending.engine.model,
        status: "failed",
        text: message,
        durationMs: 0,
        commandPath: "local-browser-action",
        evidence: browserResult.browserProofs.flatMap((proof) => proof.evidence.map((item) => item.id)),
        ...providerRunProvenance(
          pending.engine,
          pending.selectionMode,
          pending.meteredFallbackAuthorized,
          false,
        ),
      };
      let completed = await appendThreadMessage(runSnapshot, message, "assistant");
      completed = await recordProviderRun(
        completed,
        "artifact-plan-ship-local",
        failedResult,
        events,
        receiptDetails,
        message,
      );
      applyWorkspace(pending.botId, runBot.threadId, completed);
      return { completed, result: failedResult, finalAnswer: message };
    }
    if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
    let completed = await saveLocalRunCheckpoint(runSnapshot, pending.runId, {
      stepIndex: 2,
      handoff: `${actionLabel} on ${pending.target.host}`,
      priorSteps: [{
        id: "browser-action",
        status: "completed",
        action: action.action,
        target: action.targetLabel,
        proofIds: browserResult.browserProofs.flatMap((proof) => proof.evidence.map((item) => item.id)),
      }],
      gateApproved: true,
      runContext: {
        kind: "browser-action-completed",
        runId: pending.runId,
        botId: pending.botId,
        action: action.action,
        target: action.targetLabel,
        host: pending.target.host,
        approvalSha256: action.approvalSha256,
      },
    });
    applyWorkspace(pending.botId, runBot.threadId, completed);
    const quarantinedDownload = action.action === "download"
      ? (await refreshBrowserDownloads(pending.botId))
          .find((download) => download.sessionId === browserSessionId(pending.runId))
      : undefined;
    if (action.action === "download" && !quarantinedDownload) {
      throw new Error("The browser reported a download, but its quarantined file could not be verified.");
    }
    const result: ProviderTaskResult = quarantinedDownload
      ? {
          runId: pending.runId,
          provider: pending.engine.provider,
          model: pending.engine.model,
          status: "completed",
          structuredOutput: {
            summary: `${quarantinedDownload.fileName} is quarantined and waiting for you.`,
            items: [
              `${quarantinedDownload.byteSize} bytes · SHA-256 ${quarantinedDownload.sha256.slice(0, 12)}`,
              "Choose Release… to save it outside Codelit, or Delete to remove it.",
            ],
          },
          text: `${quarantinedDownload.fileName} is quarantined and waiting for release.`,
          durationMs: 0,
          commandPath: "local-browser-download",
          evidence: browserResult.browserProofs.flatMap((proof) => proof.evidence.map((item) => item.id)),
          ...providerRunProvenance(
            pending.engine,
            pending.selectionMode,
            pending.meteredFallbackAuthorized,
            false,
          ),
        }
      : await runIntelligenceTask(
          pending.engine,
          buildBotPrompt(
            runBot,
            `${pending.request}\n\nThe exact approved browser action completed. Report only the observed post-action evidence.`,
            browserResult.context,
            pending.memories,
            pending.skills,
            undefined,
            skillPreparation.promptContext,
          ),
          onRunEvent,
          undefined,
          pending.runId,
          pending.selectionMode,
          pending.meteredFallbackAuthorized,
          () => { invocation.started = true; },
        );
    let finalAnswer: string;
    let receiptResult = result;
    if (result.status === "completed" && result.structuredOutput) {
      finalAnswer = formatProviderFinalAnswer(result.structuredOutput);
      await revealValidatedAnswer(pending.botId, pending.runId, finalAnswer);
      updateExecutionStates((current) => commitBotExecution(
        current,
        pending.botId,
        pending.runId,
      ));
    } else {
      finalAnswer = `${actionLabel} on ${pending.target.host}. Browser proof was saved, but the follow-up summary did not finish.`;
      receiptResult = {
        ...result,
        status: "completed",
        structuredOutput: {
          summary: finalAnswer,
          items: [actionLabel, "Browser proof saved locally"],
        },
        text: finalAnswer,
        commandPath: "local-browser-action",
        evidence: Array.from(new Set([
          ...result.evidence,
          ...browserResult.browserProofs.flatMap((proof) => proof.evidence.map((item) => item.id)),
        ])),
      };
      updateExecutionStates((current) => commitBotExecution(
        current,
        pending.botId,
        pending.runId,
      ));
    }
    skillRunReceipts = completeBotSkillChecks(pending.skills, skillRunReceipts, finalAnswer);
    if (!botSkillChecksPassed(skillRunReceipts)) {
      throw new Error("A selected skill did not produce its required output. Review the run receipt before retrying.");
    }
    completed = await appendThreadMessage(completed, finalAnswer, "assistant");
    completed = await recordProviderRun(
      completed,
      "artifact-plan-ship-local",
      receiptResult,
      events,
      {
        ...receiptDetails,
        skillContracts: skillRunReceipts,
        ...(quarantinedDownload ? {
          download: {
            id: quarantinedDownload.id,
            fileName: quarantinedDownload.fileName,
            byteSize: quarantinedDownload.byteSize,
            sha256: quarantinedDownload.sha256,
            status: "quarantined",
          },
        } : {}),
        summary: {
          status: result.status,
          provider: result.provider,
          model: result.model,
        },
      },
      finalAnswer,
    );
    applyWorkspace(pending.botId, runBot.threadId, completed);
    return { completed, result: receiptResult, finalAnswer };
  };

  const finishMcpRun = async (
    pending: PendingMcpRun,
    runBot: LocalBotRecord,
    runSnapshot: NonNullable<typeof workspace>,
    events: ProviderRunEvent[],
    invocation: { started: boolean },
  ) => {
    if (runBot.id !== pending.botId
      || runBot.currentVersion !== pending.botVersion
      || runSnapshot.thread.id !== runBot.threadId) {
      throw new Error("The MCP call no longer matches its bot conversation.");
    }
    const currentMemories = await listLocalBotMemories(pending.botId);
    if (await botMemorySnapshotHash(currentMemories) !== pending.memorySnapshotHash) {
      throw new Error("This bot's memory changed while the MCP call was waiting. Ask again so the new memory is explicit in its receipt.");
    }
    const currentSkills = await listLocalBotSkills();
    if (!botSkillSnapshotMatches(currentSkills, pending.skills)) {
      throw new Error("A selected skill changed while the MCP call was waiting. Ask again so the reviewed skill version is explicit in its receipt.");
    }
    const skillPreparation = prepareBotSkillRuns(pending.skills, pending.request, {
      projectApproved: Boolean(runSnapshot.workspaceFolder?.accessValidated),
    });
    if (skillPreparation.status === "invalid") throw new Error(skillPreparation.message);
    let skillRunReceipts = skillPreparation.receipts;
    const onRunEvent = (event: ProviderRunEvent) => consumeRunEvent(pending.botId, event, events);
    await changeBotStatus(pending.botId, "working", `Using ${pending.serverName}`);
    const toolResult = await runApprovedLocalMcpCall(
      pending.runId,
      {
        toolReference: pending.toolReference,
        objective: pending.request,
        approvalSha256: pending.approvalSha256,
      },
      onRunEvent,
    );
    const receiptDetails = {
      botId: pending.botId,
      botVersion: pending.botVersion,
      engine: pending.engine,
      permissionSnapshot: runBot.spec.permissionPolicy,
      memorySnapshotHash: pending.memorySnapshotHash,
      memoryIds: pending.memories.map((memory) => memory.id),
      skillVersions: pending.skillVersions,
      approval: {
        mode: "ask",
        decisionSource: "user",
        scope: "typed-mcp-action",
        approvalSha256: pending.approvalSha256,
      },
      mcp: {
        serverName: pending.serverName,
        toolName: pending.toolName,
        toolReference: pending.toolReference,
        effect: pending.effect,
        destructive: pending.destructive,
        arguments: pending.arguments,
      },
      completedTools: toolResult.completedTools,
    };
    if (toolResult.status !== "completed" || toolResult.failure) {
      const uncertain = toolResult.failure?.uncertainWrite === true;
      const message = uncertain
        ? `${pending.serverName} received the approved call, but Codelit could not verify the result. It will not retry automatically.`
        : `The approved ${pending.serverName} call did not complete.`;
      const failedResult: ProviderTaskResult = {
        runId: pending.runId,
        provider: pending.engine.provider,
        model: pending.engine.model,
        status: "failed",
        text: message,
        durationMs: pending.plannerDurationMs,
        commandPath: pending.plannerCommandPath,
        ...(pending.plannerVersion ? { version: pending.plannerVersion } : {}),
        evidence: pending.plannerEvidence,
        ...providerRunProvenance(
          pending.engine,
          pending.selectionMode,
          pending.meteredFallbackAuthorized,
          pending.meteredProviderInvocationStarted,
        ),
      };
      let completed = await appendThreadMessage(runSnapshot, message, "assistant");
      completed = await recordProviderRun(completed, "artifact-plan-ship-local", failedResult, events, receiptDetails, message);
      applyWorkspace(pending.botId, runBot.threadId, completed);
      return { completed, result: failedResult, finalAnswer: message };
    }
    if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
    const resumedCheckpoint = resumeAgenticHarnessCheckpoint(
      pending.harnessCheckpoint || emptyAgenticHarnessCheckpoint(),
      {
        mcpReference: pending.toolReference,
        context: toolResult.context,
        completedTools: toolResult.completedTools,
      },
    );
    let completed = await saveLocalRunCheckpoint(runSnapshot, pending.runId, {
      stepIndex: resumedCheckpoint.actionCount,
      handoff: `${pending.serverName} / ${pending.toolName} completed`,
      priorSteps: resumedCheckpoint.completedTools.map((tool) => ({
        id: tool.toolId,
        status: "completed",
        toolName: tool.toolName,
      })),
      gateApproved: true,
      runContext: {
        kind: "mcp-action-completed",
        runId: pending.runId,
        botId: pending.botId,
        toolReference: pending.toolReference,
        approvalSha256: pending.approvalSha256,
      },
    });
    applyWorkspace(pending.botId, runBot.threadId, completed);
    const connectedMcpServers = await listLocalMcpServers();
    const loop = await runBotHarness({
      runBot,
      runSnapshot: completed,
      runId: pending.runId,
      request: pending.request,
      basePrompt: buildBotPrompt(
        runBot,
        pending.request,
        [],
        pending.memories,
        pending.skills,
        undefined,
        skillPreparation.promptContext,
      ),
      engine: pending.engine,
      selectionMode: pending.selectionMode,
      meteredFallbackAuthorized: pending.meteredFallbackAuthorized,
      connectedMcpServers,
      events,
      providerInvocation: invocation,
      checkpoint: resumedCheckpoint,
    });
    if (loop.mcpProposal) {
      const staged = await stageMcpHarnessApproval({
        loop,
        runBot,
        runSnapshot: completed,
        runId: pending.runId,
        request: pending.request,
        engine: pending.engine,
        selectionMode: pending.selectionMode,
        meteredFallbackAuthorized: pending.meteredFallbackAuthorized,
        memories: pending.memories,
        memorySnapshotHash: pending.memorySnapshotHash,
        skills: pending.skills,
        skillVersions: pending.skillVersions,
        events,
        priorPending: pending,
      });
      return { completed: staged.snapshot, nextPending: staged.pending };
    }
    const followUpResult = loop.result;
    const invocationStarted = pending.meteredProviderInvocationStarted
      || followUpResult.meteredProviderInvocationStarted;
    const result: ProviderTaskResult = {
      ...followUpResult,
      durationMs: pending.plannerDurationMs + followUpResult.durationMs,
      evidence: Array.from(new Set([...pending.plannerEvidence, ...followUpResult.evidence])).slice(0, 16),
      ...providerRunProvenance(
        pending.engine,
        pending.selectionMode,
        pending.meteredFallbackAuthorized,
        invocationStarted,
      ),
    };
    let receiptResult = result;
    let finalAnswer: string;
    if (result.status === "completed" && result.structuredOutput) {
      finalAnswer = formatProviderFinalAnswer(result.structuredOutput);
      await revealValidatedAnswer(pending.botId, pending.runId, finalAnswer);
    } else {
      finalAnswer = `${pending.serverName} / ${pending.toolName} completed. Its result was saved in this run receipt, but the follow-up summary did not finish.`;
      receiptResult = {
        ...result,
        status: "completed",
        structuredOutput: { summary: finalAnswer, items: [] },
        text: finalAnswer,
        commandPath: "local-mcp",
      };
    }
    updateExecutionStates((current) => commitBotExecution(current, pending.botId, pending.runId));
    skillRunReceipts = completeBotSkillChecks(pending.skills, skillRunReceipts, finalAnswer);
    if (!botSkillChecksPassed(skillRunReceipts)) {
      throw new Error("A selected skill did not produce its required output. Review the run receipt before retrying.");
    }
    completed = await appendThreadMessage(completed, finalAnswer, "assistant");
    completed = await recordProviderRun(
      completed,
      "artifact-plan-ship-local",
      receiptResult,
      events,
      {
        ...receiptDetails,
        completedTools: loop.completedTools,
        agentLoop: {
          modelTurns: loop.modelTurns,
          toolCalls: loop.toolCalls,
          externalCalls: loop.checkpoint.mcpCalls,
        },
        skillContracts: skillRunReceipts,
      },
      finalAnswer,
    );
    applyWorkspace(pending.botId, runBot.threadId, completed);
    return { completed, result: receiptResult, finalAnswer };
  };

  const decideMcpRun = async (approved: boolean) => {
    if (!pendingMcpRun || !workspace || !bot || runState !== "awaiting-approval") return;
    const pending = pendingMcpRun;
    const runBot = bot;
    const botId = runBot.id;
    const executionAtDecision = botExecutionState(executionStatesRef.current, botId);
    if (executionAtDecision.runState !== "awaiting-approval"
      || executionAtDecision.activeRunId !== pending.runId
      || approvalDecisionsInFlight.current.has(pending.runId)) return;
    if (approved && !isBotEngineReady(eligibleProviders, pending.engine)) {
      setBotFeedback(botId, { error: "The engine that planned this call is no longer ready. Set it up, then ask again." });
      openSettings("intelligence");
      return;
    }
    approvalDecisionsInFlight.current.add(pending.runId);
    updateExecutionStates((current) => resumeBotExecution(current, botId, pending.runId));
    canceledRunIds.current.delete(pending.runId);
    setBotFeedback(botId, { error: null, notice: null });
    let snapshot = workspace;
    let receiptRecorded = false;
    let handedOffForApproval = false;
    const providerInvocation = { started: false };
    const createdAt = new Date().toISOString();
    const events: ProviderRunEvent[] = [{
      runId: pending.runId,
      sequence: 1,
      eventType: "approval-required",
      provider: pending.engine.provider,
      model: pending.engine.model,
      message: `Waiting to use ${pending.serverName} / ${pending.toolName}`,
      createdAt,
    }, {
      runId: pending.runId,
      sequence: 2,
      eventType: "message",
      provider: pending.engine.provider,
      model: pending.engine.model,
      message: approved ? "Exact MCP call approved once" : "MCP call held by the user",
      createdAt,
    }];
    try {
      snapshot = await recordLocalRunApproval(snapshot, {
        id: pending.approvalId,
        runId: pending.runId,
        stepIndex: pending.harnessCheckpoint?.actionCount || 0,
        status: approved ? "approved" : "held",
        body: {
          kind: "mcp-action",
          ...pending,
          decisionSource: "user",
          safetyClass: "typed-mcp-action",
        },
      });
      applyWorkspace(botId, runBot.threadId, snapshot);
      if (!approved) {
        await discardPreparedLocalToolApproval(pending.runId).catch(() => undefined);
        const answer = pending.harnessCheckpoint?.mcpCalls.length
          ? `Held ${pending.serverName} / ${pending.toolName}. This action did not run; earlier approved steps remain completed.`
          : `Held ${pending.serverName} / ${pending.toolName}. No external action ran.`;
        const result: ProviderTaskResult = {
          runId: pending.runId,
          provider: pending.engine.provider,
          model: pending.engine.model,
          status: "canceled",
          text: answer,
          durationMs: pending.plannerDurationMs,
          commandPath: pending.plannerCommandPath,
          ...(pending.plannerVersion ? { version: pending.plannerVersion } : {}),
          evidence: pending.plannerEvidence,
          ...providerRunProvenance(
            pending.engine,
            pending.selectionMode,
            pending.meteredFallbackAuthorized,
            pending.meteredProviderInvocationStarted,
          ),
        };
        snapshot = await appendThreadMessage(snapshot, answer, "assistant");
        snapshot = await recordProviderRun(snapshot, "artifact-plan-ship-local", result, events, {
          botId,
          botVersion: pending.botVersion,
          approval: { mode: "ask", decisionSource: "user", scope: "typed-mcp-action" },
          mcp: { serverName: pending.serverName, toolName: pending.toolName, status: "held-before-call" },
        }, answer);
        receiptRecorded = true;
        applyWorkspace(botId, runBot.threadId, snapshot);
        await changeBotStatus(botId, "sleeping", `${pending.serverName} action held`);
        return;
      }
      snapshot = await saveLocalRunCheckpoint(snapshot, pending.runId, {
        stepIndex: pending.harnessCheckpoint?.actionCount || 0,
        handoff: pending.request,
        priorSteps: (pending.harnessCheckpoint?.completedTools || []).map((tool) => ({
          id: tool.toolId,
          status: "completed",
          toolName: tool.toolName,
        })),
        gateApproved: true,
        runContext: { kind: "mcp-action", ...pending },
      });
      applyWorkspace(botId, runBot.threadId, snapshot);
      const finished = await finishMcpRun(pending, runBot, snapshot, events, providerInvocation);
      snapshot = finished.completed;
      if ("nextPending" in finished) {
        handedOffForApproval = true;
        return;
      }
      receiptRecorded = true;
      if (finished.result.status !== "completed") throw new Error(finished.result.text);
      await changeBotStatus(botId, "done", `Finished with ${pending.serverName}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      await discardPreparedLocalToolApproval(pending.runId).catch(() => undefined);
      if (!receiptRecorded) {
        const failedResult: ProviderTaskResult = {
          runId: pending.runId,
          provider: pending.engine.provider,
          model: pending.engine.model,
          status: /cancel|stop/i.test(message) ? "canceled" : "failed",
          text: message,
          durationMs: pending.plannerDurationMs,
          commandPath: pending.plannerCommandPath,
          ...(pending.plannerVersion ? { version: pending.plannerVersion } : {}),
          evidence: pending.plannerEvidence,
          ...providerRunProvenance(
            pending.engine,
            pending.selectionMode,
            pending.meteredFallbackAuthorized,
            pending.meteredProviderInvocationStarted || providerInvocation.started,
          ),
        };
        try {
          snapshot = await recordProviderRun(snapshot, "artifact-plan-ship-local", failedResult, events, {
            botId,
            botVersion: pending.botVersion,
            mcp: { serverName: pending.serverName, toolName: pending.toolName, status: "failed" },
          });
          applyWorkspace(botId, runBot.threadId, snapshot);
        } catch {
          // Preserve the original MCP failure.
        }
      }
      setBotFeedback(botId, { error: message, notice: null });
      await changeBotStatus(botId, "blocked", message).catch(() => undefined);
    } finally {
      if (!handedOffForApproval) {
        updateExecutionStates((current) => finishBotExecution(current, botId, pending.runId));
      }
      canceledRunIds.current.delete(pending.runId);
      approvalDecisionsInFlight.current.delete(pending.runId);
    }
  };

  const decideBrowserRun = async (approved: boolean) => {
    if (!pendingBrowserRun || !workspace || !bot || runState !== "awaiting-approval") return;
    const pending = pendingBrowserRun;
    const runBot = bot;
    const botId = runBot.id;
    const threadId = runBot.threadId;
    const browserAction = pending.browserAction;
    const reviewedActionLabel = browserAction ? browserActionInstruction(browserAction) : null;
    const executionAtDecision = botExecutionState(executionStatesRef.current, botId);
    if (executionAtDecision.runState !== "awaiting-approval"
      || executionAtDecision.activeRunId !== pending.runId
      || approvalDecisionsInFlight.current.has(pending.runId)) return;
    if (approved && !isBotEngineReady(eligibleProviders, pending.engine)) {
      setBotFeedback(botId, {
        error: `The engine pinned to this browser ${browserAction ? "action" : "run"} is no longer ready. Set it up, then review it again.`,
      });
      openSettings("intelligence");
      return;
    }
    approvalDecisionsInFlight.current.add(pending.runId);
    updateExecutionStates((current) => resumeBotExecution(current, botId, pending.runId));
    canceledRunIds.current.delete(pending.runId);
    setBotFeedback(botId, { error: null, notice: null });
    let snapshot = workspace;
    const eventTime = new Date().toISOString();
    const events: ProviderRunEvent[] = [
      {
        runId: pending.runId,
        sequence: 1,
        eventType: "queued",
        provider: pending.engine.provider,
        model: pending.engine.model,
        message: browserAction ? "Browser action queued locally" : "Website run queued locally",
        createdAt: eventTime,
      },
      {
        runId: pending.runId,
        sequence: 2,
        eventType: "approval-required",
        provider: pending.engine.provider,
        model: pending.engine.model,
        message: browserAction
          ? `Waiting to ${reviewedActionLabel!.toLowerCase()} on ${pending.target.host}`
          : `Waiting for read-only access to ${pending.target.host}`,
        createdAt: eventTime,
      },
      {
        runId: pending.runId,
        sequence: 3,
        eventType: "message",
        provider: pending.engine.provider,
        model: pending.engine.model,
        message: approved
          ? browserAction
            ? `${reviewedActionLabel} approved once`
            : "Read-only website access approved once"
          : browserAction
            ? "Browser action held by the user"
            : "Website access held by the user",
        createdAt: eventTime,
      },
    ];
    let receiptRecorded = false;
    const providerInvocation = { started: false };
    let delegationFinish: {
      outcome: "completed" | "failed" | "canceled";
      result?: string;
      detail?: string;
    } | null = null;
    try {
      snapshot = await recordLocalRunApproval(snapshot, {
        id: pending.approvalId,
        runId: pending.runId,
        stepIndex: 0,
        status: approved ? "approved" : "held",
        body: {
          kind: browserAction ? "browser-action" : "browser-read",
          request: pending.request,
          target: pending.target,
          botId: pending.botId,
          botVersion: pending.botVersion,
          engine: pending.engine,
          selectionMode: pending.selectionMode,
          meteredFallbackAuthorized: pending.meteredFallbackAuthorized,
          approvalMode: pending.approvalMode,
          memories: pending.memories,
          memorySnapshotHash: pending.memorySnapshotHash,
          skills: pending.skills,
          skillVersions: pending.skillVersions,
          ...(browserAction ? { browserAction } : {}),
          ...(pending.delegation ? { delegation: pending.delegation } : {}),
          decisionSource: "user",
          safetyClass: browserAction ? browserActionScope(browserAction) : "read-only-browser",
        },
      });
      applyWorkspace(botId, threadId, snapshot);
      if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
      if (!approved) {
        if (browserAction) {
          await discardPreparedLocalToolApproval(pending.runId).catch(() => undefined);
        }
        const heldMessage = browserAction
          ? `The ${pending.target.host} action was held before anything changed.`
          : `Website access to ${pending.target.host} was not approved.`;
        const result: ProviderTaskResult = {
          runId: pending.runId,
          provider: pending.engine.provider,
          model: pending.engine.model,
          status: "canceled",
          text: heldMessage,
          durationMs: 0,
          commandPath: "local-browser-policy",
          evidence: [],
          ...providerRunProvenance(
            pending.engine,
            pending.selectionMode,
            pending.meteredFallbackAuthorized,
            false,
          ),
        };
        snapshot = await recordProviderRun(snapshot, "artifact-plan-ship-local", result, events, {
          botId: pending.botId,
          botVersion: pending.botVersion,
          engine: pending.engine,
          memorySnapshotHash: pending.memorySnapshotHash,
          memoryIds: pending.memories.map((memory) => memory.id),
          skillVersions: pending.skillVersions,
          ...(pending.delegation ? { delegation: pending.delegation } : {}),
          approval: {
            mode: pending.approvalMode,
            decisionSource: "user",
            scope: browserAction ? browserActionScope(browserAction) : "read-only-browser",
          },
          browser: {
            host: pending.target.host,
            mode: "held",
            ...(browserAction ? {
              action: browserAction.action,
              target: browserAction.targetLabel,
              valueLength: browserAction.valueLength,
            } : {}),
          },
        });
        receiptRecorded = true;
        applyWorkspace(botId, threadId, snapshot);
        await changeBotStatus(botId, "sleeping", `${browserAction ? "Browser action" : "Website request"} for ${pending.target.host} was held`);
        delegationFinish = {
          outcome: "canceled",
          detail: heldMessage,
        };
        return;
      }
      events.push({
        runId: pending.runId,
        sequence: events.length + 1,
        eventType: "checkpoint",
        provider: pending.engine.provider,
        model: pending.engine.model,
        message: browserAction
          ? "Exact browser action and approval hash pinned to this run"
          : "Read-only browser scope pinned to this run",
        createdAt: new Date().toISOString(),
      });
      snapshot = await saveLocalRunCheckpoint(snapshot, pending.runId, {
        stepIndex: 1,
        handoff: pending.request,
        priorSteps: [],
        gateApproved: true,
        runContext: { kind: browserAction ? "browser-action" : "browser-read", ...pending },
      });
      applyWorkspace(botId, threadId, snapshot);
      if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
      const finished = browserAction
        ? await finishBrowserActionRun(
            pending,
            runBot,
            snapshot,
            events,
            providerInvocation,
          )
        : await finishBrowserRun(
            pending,
            runBot,
            snapshot,
            events,
            providerInvocation,
            "user",
          );
      snapshot = finished.completed;
      receiptRecorded = true;
      if (finished.result.status !== "completed" || !finished.result.structuredOutput) {
        throw new Error(finished.result.text);
      }
      delegationFinish = pending.delegation ? {
        outcome: "completed",
        result: finished.finalAnswer || finished.result.text,
        detail: `Finished with ${providerLabel(providers, pending.engine)}.`,
      } : null;
      await changeBotStatus(
        botId,
        "done",
        browserAction
          ? `Finished on ${pending.target.host}`
          : `Finished with ${providerLabel(providers, pending.engine)}`,
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const canceled = /cancel|stop/i.test(message);
      if (browserAction) {
        await discardPreparedLocalToolApproval(pending.runId).catch(() => undefined);
      }
      delegationFinish = pending.delegation ? {
        outcome: canceled ? "canceled" : "failed",
        detail: message.slice(0, 1_000),
      } : null;
      if (!receiptRecorded) {
        const failedResult: ProviderTaskResult = {
          runId: pending.runId,
          provider: pending.engine.provider,
          model: pending.engine.model,
          status: canceled ? "canceled" : "failed",
          text: message,
          durationMs: 0,
          commandPath: "local-browser-runtime",
          evidence: [],
          ...providerRunProvenance(
            pending.engine,
            pending.selectionMode,
            pending.meteredFallbackAuthorized,
            providerInvocation.started,
          ),
        };
        try {
          snapshot = await recordProviderRun(snapshot, "artifact-plan-ship-local", failedResult, events, {
            botId: pending.botId,
            botVersion: pending.botVersion,
            engine: pending.engine,
            memorySnapshotHash: pending.memorySnapshotHash,
            memoryIds: pending.memories.map((memory) => memory.id),
            skillVersions: pending.skillVersions,
            ...(pending.delegation ? { delegation: pending.delegation } : {}),
            approval: {
              mode: pending.approvalMode,
              decisionSource: "user",
              scope: browserAction ? browserActionScope(browserAction) : "read-only-browser",
            },
            browser: {
              host: pending.target.host,
              mode: browserAction ? "write" : "read",
              status: failedResult.status,
              ...(browserAction ? {
                action: browserAction.action,
                target: browserAction.targetLabel,
                valueLength: browserAction.valueLength,
              } : {}),
            },
          });
          applyWorkspace(botId, threadId, snapshot);
        } catch {
          // The original browser failure remains the actionable message.
        }
      }
      setBotFeedback(botId, { error: message, notice: null });
      await changeBotStatus(botId, canceled ? "paused" : "blocked", message).catch(() => undefined);
    } finally {
      if (pending.delegation && delegationFinish) {
        try {
          replaceDelegation(await finishLocalBotDelegationTarget({
            id: pending.delegation.delegationId,
            targetBotId: pending.delegation.targetBotId,
            runId: pending.runId,
            ...delegationFinish,
            finishedAt: new Date().toISOString(),
          }));
        } catch (reason) {
          setGlobalError(reason instanceof Error ? reason.message : String(reason));
        }
      }
      const waiter = browserWaiters.current.get(pending.runId);
      if (waiter) {
        window.clearInterval(waiter.interval);
        browserWaiters.current.delete(pending.runId);
      }
      browserSessions.current.delete(pending.runId);
      updateExecutionStates((current) => finishBotExecution(current, botId, pending.runId));
      canceledRunIds.current.delete(pending.runId);
      approvalDecisionsInFlight.current.delete(pending.runId);
    }
  };

  const allowBrowserDomainAndApproveRun = async () => {
    if (!bot
      || !pendingBrowserRun
      || pendingBrowserRun.browserAction
      || savingApprovalModeRef.current
      || runState !== "awaiting-approval"
      || !browserReadAvailable) return;
    const botId = bot.id;
    const domain = pendingBrowserRun.target.host;
    savingApprovalModeRef.current = true;
    setSavingApprovalMode(true);
    setBotFeedback(botId, { error: null, notice: null });
    try {
      const updated = await updateLocalBotBrowserDomains(
        botId,
        [...bot.spec.permissionPolicy.browserDomains, domain],
        bot.currentVersion,
      );
      replaceBot(updated);
    } catch (reason) {
      setBotFeedback(botId, { error: reason instanceof Error ? reason.message : String(reason) });
      return;
    } finally {
      savingApprovalModeRef.current = false;
      setSavingApprovalMode(false);
    }
    await decideBrowserRun(true);
  };

  const decideComputerRun = async (approved: boolean) => {
    if (!pendingComputerRun || !workspace || !bot || runState !== "awaiting-approval") return;
    const pending = pendingComputerRun;
    const runBot = bot;
    const botId = runBot.id;
    const threadId = runBot.threadId;
    const executionAtDecision = botExecutionState(executionStatesRef.current, botId);
    if (executionAtDecision.runState !== "awaiting-approval"
      || executionAtDecision.activeRunId !== pending.runId
      || approvalDecisionsInFlight.current.has(pending.runId)) return;
    if (approved && !isBotEngineReady(eligibleProviders, pending.engine)) {
      setBotFeedback(botId, {
        error: "The engine that planned this action is no longer ready. Set it up, then ask again.",
      });
      openSettings("intelligence");
      return;
    }
    approvalDecisionsInFlight.current.add(pending.runId);
    updateExecutionStates((current) => resumeBotExecution(current, botId, pending.runId));
    canceledRunIds.current.delete(pending.runId);
    setBotFeedback(botId, { error: null, notice: null });
    let snapshot = workspace;
    let receiptRecorded = false;
    let actionDispatched = false;
    const actionStartedAt = Date.now();
    const eventTime = new Date().toISOString();
    const safeActionLabel = pending.action.kind === "press"
      ? `Press ${pending.action.target}`
      : `Enter text in ${pending.action.target}`;
    const events: ProviderRunEvent[] = [
      {
        runId: pending.runId,
        sequence: 1,
        eventType: "queued",
        provider: pending.engine.provider,
        model: pending.engine.model,
        message: "Computer action queued locally",
        createdAt: eventTime,
      },
      {
        runId: pending.runId,
        sequence: 2,
        eventType: "approval-required",
        provider: pending.engine.provider,
        model: pending.engine.model,
        message: `Waiting to use ${pending.app.appName}`,
        createdAt: eventTime,
      },
      {
        runId: pending.runId,
        sequence: 3,
        eventType: "message",
        provider: pending.engine.provider,
        model: pending.engine.model,
        message: approved ? `${safeActionLabel} approved once` : `${safeActionLabel} held by the user`,
        createdAt: eventTime,
      },
    ];
    try {
      snapshot = await recordLocalRunApproval(snapshot, {
        id: pending.approvalId,
        runId: pending.runId,
        stepIndex: 0,
        status: approved ? "approved" : "held",
        body: {
          kind: "computer-action",
          ...pending,
          decisionSource: "user",
          safetyClass: "semantic-computer-action",
        },
      });
      applyWorkspace(botId, threadId, snapshot);
      if (!approved) {
        const answer = `Held the proposed action in ${pending.app.appName}. Nothing changed.`;
        const result = computerProviderResult(
          pending,
          "canceled",
          answer,
          pending.plannerDurationMs,
        );
        snapshot = await appendThreadMessage(snapshot, answer, "assistant");
        snapshot = await recordProviderRun(snapshot, "artifact-plan-ship-local", result, events, {
          botId,
          botVersion: pending.botVersion,
          engine: pending.engine,
          permissionSnapshot: runBot.spec.permissionPolicy,
          memorySnapshotHash: pending.memorySnapshotHash,
          memoryIds: pending.memoryIds,
          skillVersions: pending.skillVersions,
          approval: {
            mode: "ask",
            decisionSource: "user",
            scope: "semantic-computer-action",
          },
          computer: {
            appName: pending.app.appName,
            bundleId: pending.app.bundleId,
            action: computerReceiptAction(pending.action),
            status: "held-before-action",
            evidence: [],
          },
        }, answer);
        receiptRecorded = true;
        applyWorkspace(botId, threadId, snapshot);
        await changeBotStatus(botId, "sleeping", `${pending.app.appName} action held`);
        return;
      }

      const latestContext = await openLocalBotContext(botId);
      if (latestContext.bot.currentVersion !== pending.botVersion) {
        throw new Error("This bot changed while the action was waiting. Ask again so the new bot version is explicit in its receipt.");
      }
      const [currentMemories, currentSkills] = await Promise.all([
        listLocalBotMemories(botId),
        listLocalBotSkills(),
      ]);
      if (await botMemorySnapshotHash(currentMemories) !== pending.memorySnapshotHash) {
        throw new Error("This bot's memory changed while the action was waiting. Ask again so the new memory is explicit in its receipt.");
      }
      const reviewedSkills = currentSkills.filter((skill) => pending.skillVersions[skill.id] !== undefined);
      if (reviewedSkills.length !== Object.keys(pending.skillVersions).length
        || reviewedSkills.some((skill) => (
          !["packaged", "reviewed"].includes(skill.trustState)
          || pending.skillVersions[skill.id] !== skill.version
        ))) {
        throw new Error("A selected skill changed while the action was waiting. Ask again so the trusted skill version is explicit in its receipt.");
      }
      if (canceledRunIds.current.has(pending.runId)) throw new Error("Run canceled by user.");
      events.push({
        runId: pending.runId,
        sequence: events.length + 1,
        eventType: "checkpoint",
        provider: pending.engine.provider,
        model: pending.engine.model,
        message: "Exact app and semantic control pinned to this run",
        createdAt: new Date().toISOString(),
      });
      snapshot = await saveLocalRunCheckpoint(snapshot, pending.runId, {
        stepIndex: 1,
        handoff: pending.request,
        priorSteps: [],
        gateApproved: true,
        runContext: { kind: "computer-action", ...pending },
      });
      applyWorkspace(botId, threadId, snapshot);
      await changeBotStatus(botId, "working", `Using ${pending.app.appName}`);
      const actionResult = await runComputerAction(
        {
          runId: pending.runId,
          botId,
          bundleId: pending.app.bundleId,
          action: pending.action,
        },
        (event) => {
          if (event.eventType === "progress") actionDispatched = true;
          consumeRunEvent(botId, event, events);
        },
      );
      setComputerEvidenceByBotId((current) => ({ ...current, [botId]: actionResult }));
      const resultStatus: ProviderTaskResult["status"] = actionResult.status === "completed"
        ? "completed"
        : actionResult.status === "canceled"
          ? "canceled"
          : "failed";
      if (resultStatus === "completed") {
        updateExecutionStates((current) => commitBotExecution(
          revealBotExecutionAnswer(current, botId, pending.runId, actionResult.summary),
          botId,
          pending.runId,
        ));
      }
      snapshot = await appendThreadMessage(snapshot, actionResult.summary, "assistant");
      const evidenceHashes = actionResult.evidence.map((frame) => frame.sha256);
      const result = computerProviderResult(
        pending,
        resultStatus,
        actionResult.summary,
        pending.plannerDurationMs + Math.max(0, Date.now() - actionStartedAt),
        evidenceHashes,
      );
      snapshot = await recordProviderRun(snapshot, "artifact-plan-ship-local", result, events, {
        botId,
        botVersion: pending.botVersion,
        engine: pending.engine,
        permissionSnapshot: runBot.spec.permissionPolicy,
        memorySnapshotHash: pending.memorySnapshotHash,
        memoryIds: pending.memoryIds,
        skillVersions: pending.skillVersions,
        approval: {
          mode: "ask",
          decisionSource: "user",
          scope: "semantic-computer-action",
        },
        computer: {
          appName: pending.app.appName,
          bundleId: pending.app.bundleId,
          action: computerReceiptAction(pending.action),
          status: actionResult.status,
          evidence: actionResult.evidence.map((frame) => ({
            phase: frame.phase,
            sha256: frame.sha256,
            windowId: frame.windowId,
            width: frame.width,
            height: frame.height,
          })),
          environment: actionResult.environment,
          beforeElementCount: actionResult.before.elements.length,
          afterElementCount: actionResult.after.elements.length,
          inspectionTruncated: actionResult.before.truncated || actionResult.after.truncated,
        },
      }, actionResult.summary);
      receiptRecorded = true;
      applyWorkspace(botId, threadId, snapshot);
      if (resultStatus === "completed") {
        await changeBotStatus(botId, "done", `Finished in ${pending.app.appName}`);
      } else if (resultStatus === "canceled") {
        await changeBotStatus(botId, "paused", actionResult.summary);
      } else {
        setBotFeedback(botId, { error: actionResult.summary, notice: null });
        await changeBotStatus(botId, "blocked", actionResult.summary);
      }
    } catch (reason) {
      const original = reason instanceof Error ? reason.message : String(reason);
      const canceled = /cancel|stop/i.test(original);
      const message = actionDispatched && !canceled
        ? `${original} The app may have changed; inspect it before retrying.`
        : original;
      const failureReadiness = await probeComputerUseReadiness().catch(() => null);
      if (!receiptRecorded) {
        const failedResult = computerProviderResult(
          pending,
          canceled ? "canceled" : "failed",
          message,
          pending.plannerDurationMs + Math.max(0, Date.now() - actionStartedAt),
        );
        try {
          if (actionDispatched) {
            snapshot = await appendThreadMessage(snapshot, message, "assistant");
          }
          snapshot = await recordProviderRun(snapshot, "artifact-plan-ship-local", failedResult, events, {
            botId,
            botVersion: pending.botVersion,
            engine: pending.engine,
            permissionSnapshot: runBot.spec.permissionPolicy,
            memorySnapshotHash: pending.memorySnapshotHash,
            memoryIds: pending.memoryIds,
            skillVersions: pending.skillVersions,
            approval: {
              mode: "ask",
              decisionSource: "user",
              scope: "semantic-computer-action",
            },
            computer: {
              appName: pending.app.appName,
              bundleId: pending.app.bundleId,
              action: computerReceiptAction(pending.action),
              status: actionDispatched ? "unverified-after-dispatch" : "failed-before-action",
              evidence: [],
              readiness: failureReadiness?.environment,
            },
          }, message);
          applyWorkspace(botId, threadId, snapshot);
        } catch {
          // Keep the original action failure visible when receipt persistence also fails.
        }
      }
      setBotFeedback(botId, { error: message, notice: null });
      await changeBotStatus(botId, canceled ? "paused" : "blocked", message).catch(() => undefined);
    } finally {
      updateExecutionStates((current) => finishBotExecution(current, botId, pending.runId));
      canceledRunIds.current.delete(pending.runId);
      approvalDecisionsInFlight.current.delete(pending.runId);
    }
  };

  const takeOverPendingComputerRun = async () => {
    if (!pendingComputerRun || !bot) return;
    const pending = pendingComputerRun;
    const awaitingApproval = runState === "awaiting-approval";
    let focusError: string | null = null;
    try {
      const canceled = await takeOverComputerRun(
        pending.runId,
        pending.botId,
        pending.app.bundleId,
      );
      if (canceled) {
        canceledRunIds.current.add(pending.runId);
        updateExecutionStates((current) => cancelBotExecution(
          current,
          pending.botId,
          pending.runId,
        ));
      }
    } catch (reason) {
      focusError = reason instanceof Error ? reason.message : String(reason);
    }
    if (awaitingApproval) await decideComputerRun(false);
    if (focusError) setBotFeedback(bot.id, { error: focusError, notice: null });
  };

  const appendControlExchange = async (
    runBot: LocalBotRecord,
    runWorkspace: LocalBotsSnapshot["workspace"],
    request: string,
    response: string,
  ) => {
    const withUser = await appendThreadMessage(runWorkspace, request);
    const completed = await appendThreadMessage(withUser, response, "assistant");
    applyWorkspace(runBot.id, runBot.threadId, completed);
    return completed;
  };

  const revealBotTable = (view: LocalBotTableView) => {
    setBotTables((current) => [
      view.table,
      ...current.filter((table) => table.id !== view.table.id),
    ]);
    setTableView(view);
  };

  const resolveBotTable = async (runBot: LocalBotRecord, query: string) => {
    const tables = await listLocalBotTables(runBot.id);
    setBotTables(tables);
    const match = findBotTable(tables, query);
    if (match.ambiguous) {
      throw new Error(`More than one local table matches ${query}. Say Show tables, then use the exact name.`);
    }
    if (!match.table) {
      throw new Error(tables.length
        ? `I could not find a local table named ${query}. Say Show tables to see the exact names.`
        : "This bot has no local tables yet. Say: Create a table called Leads with columns Name, Company, Status.");
    }
    return match.table;
  };

  const handleBotDataIntent = async (
    intent: BotDataIntent,
    submitted: string,
    runBot: LocalBotRecord,
    runWorkspace: LocalBotsSnapshot["workspace"],
  ) => {
    if (intent.kind === "data-error") {
      await appendControlExchange(runBot, runWorkspace, submitted, intent.message);
      return;
    }
    if (intent.kind === "list-tables") {
      const tables = await listLocalBotTables(runBot.id);
      setBotTables(tables);
      setTableView(null);
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        tables.length
          ? [
              `**${tables.length} local ${tables.length === 1 ? "table" : "tables"}**`,
              ...tables.map((table) => `- **${escapeBotMarkdown(table.name)}** · ${table.rowCount} ${table.rowCount === 1 ? "row" : "rows"}`),
              "Say `Show table NAME` to inspect one here.",
            ].join("\n")
          : "This bot has no local tables yet. Say `Create a table called Leads with columns Name, Company, Status`.",
      );
      return;
    }
    if (intent.kind === "create-table") {
      const view = await createLocalBotTable({
        id: `table-${crypto.randomUUID()}`,
        botId: runBot.id,
        name: intent.name,
        columns: intent.columns,
        createdAt: new Date().toISOString(),
      });
      revealBotTable(view);
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        `Created **${escapeBotMarkdown(view.table.name)}** with ${view.table.columns.length} columns. It is private to this bot and stored only on this Mac.`,
      );
      return;
    }
    const table = await resolveBotTable(runBot, intent.tableName);
    if (intent.kind === "show-table") {
      const view = await openLocalBotTable(runBot.id, table.id);
      revealBotTable(view);
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        `Opened **${escapeBotMarkdown(table.name)}**. Filter it here or export the complete table as CSV.`,
      );
      return;
    }
    if (intent.kind === "add-row") {
      const view = await appendLocalBotTableRow({
        id: `row-${crypto.randomUUID()}`,
        botId: runBot.id,
        tableId: table.id,
        values: coerceBotTableValues(table, intent.values),
        createdAt: new Date().toISOString(),
      });
      revealBotTable(view);
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        `Added one row to **${escapeBotMarkdown(table.name)}**. It now has ${view.totalRows} ${view.totalRows === 1 ? "row" : "rows"}.`,
      );
      return;
    }
    setExportingTableId(table.id);
    try {
      const path = await exportLocalBotTableCsv(runBot.id, table.id);
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        path
          ? `Exported **${escapeBotMarkdown(table.name)}** as CSV.`
          : `Canceled the **${escapeBotMarkdown(table.name)}** export. The local table was not changed.`,
      );
    } finally {
      setExportingTableId(null);
    }
  };

  const exportVisibleBotTable = async () => {
    if (!bot || !tableView || exportingTableId) return;
    setExportingTableId(tableView.table.id);
    try {
      const path = await exportLocalBotTableCsv(bot.id, tableView.table.id);
      if (path) setBotFeedback(bot.id, { notice: `${tableView.table.name} exported as CSV`, error: null });
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason), notice: null });
    } finally {
      setExportingTableId(null);
    }
  };

  const openRecentBotTable = async () => {
    if (!bot || !botTables.length) return;
    try {
      revealBotTable(await openLocalBotTable(bot.id, botTables[0].id));
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason), notice: null });
    }
  };

  const releaseBrowserDownload = async (download: QuarantinedBrowserDownload) => {
    if (!bot || bot.id !== download.botId || downloadActionId) return;
    setDownloadActionId(download.id);
    try {
      const path = await releaseQuarantinedBrowserDownload(bot.id, download.id);
      await refreshBrowserDownloads(bot.id);
      if (path) {
        setBotFeedback(bot.id, { notice: `${download.fileName} released`, error: null });
      }
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason), notice: null });
    } finally {
      setDownloadActionId(null);
    }
  };

  const deleteBrowserDownload = async (download: QuarantinedBrowserDownload) => {
    if (!bot || bot.id !== download.botId || downloadActionId) return;
    setDownloadActionId(download.id);
    try {
      await deleteQuarantinedBrowserDownload(bot.id, download.id);
      await refreshBrowserDownloads(bot.id);
      setBotFeedback(bot.id, { notice: `${download.fileName} deleted`, error: null });
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason), notice: null });
    } finally {
      setDownloadActionId(null);
    }
  };

  const changeGoal = async (
    runBot: LocalBotRecord,
    runWorkspace: LocalBotsSnapshot["workspace"],
    request: string,
    goal: BotGoal,
    title: string,
    detail: string,
    response: string,
  ) => {
    const updated = await updateLocalBotGoal(runBot.id, goal, runBot.currentVersion);
    replaceBot(updated);
    setBotChangeUndo({
      kind: "goal",
      botId: runBot.id,
      changedVersion: updated.currentVersion,
      previousGoal: runBot.spec.goal,
      title,
      detail,
    });
    await appendControlExchange(updated, runWorkspace, request, response);
  };

  const restoreBotChange = async (undo: BotChangeUndo) => {
    const currentBot = catalog?.bots.find((candidate) => candidate.id === undo.botId);
    if (!currentBot) throw new Error("That bot is no longer available on this Mac.");
    if (undo.kind === "goal") {
      if (currentBot.currentVersion !== undo.changedVersion) {
        throw new Error("This bot changed again, so the earlier change can no longer be undone safely.");
      }
      const restored = await updateLocalBotGoal(undo.botId, {
        ...undo.previousGoal,
        updatedAt: new Date().toISOString(),
      }, currentBot.currentVersion);
      replaceBot(restored);
      setBotChangeUndo(null);
      return { bot: restored, message: "Undid the goal change." };
    }
    const currentSchedule = schedules.find((schedule) => schedule.id === undo.scheduleId);
    if (!currentSchedule || currentSchedule.revision !== undo.changedRevision) {
      throw new Error("This routine changed again, so the earlier change can no longer be undone safely.");
    }
    const restored = await saveLocalSchedule({
      ...localScheduleSaveRequest(undo.previousSchedule),
      expectedRevision: currentSchedule.revision,
    });
    setSchedules((current) => current.map((schedule) => schedule.id === restored.id ? restored : schedule));
    setBotChangeUndo(null);
    return { bot: currentBot, message: `Restored **${escapeBotMarkdown(restored.title)}**.` };
  };

  const undoRecentBotChange = async () => {
    if (!botChangeUndo || botChangeUndo.botId !== activeBotId) return;
    try {
      const restored = await restoreBotChange(botChangeUndo);
      setBotFeedback(restored.bot.id, { notice: restored.message.replace(/\*\*/g, ""), error: null });
    } catch (reason) {
      setBotFeedback(botChangeUndo.botId, {
        error: reason instanceof Error ? reason.message : String(reason),
        notice: null,
      });
    }
  };

  const handleBotControlIntent = async (
    intent: BotControlIntent,
    submitted: string,
    runBot: LocalBotRecord,
    runWorkspace: LocalBotsSnapshot["workspace"],
  ) => {
    setPromptsByBotId((current) => ({ ...current, [runBot.id]: "" }));
    setBotFeedback(runBot.id, { error: null, notice: null });
    if (intent.kind === "undo-change") {
      if (!botChangeUndo || botChangeUndo.botId !== runBot.id) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          "There is no recent goal or routine change to undo.",
        );
        return true;
      }
      try {
        const restored = await restoreBotChange(botChangeUndo);
        await appendControlExchange(restored.bot, runWorkspace, submitted, restored.message);
      } catch (reason) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          reason instanceof Error ? reason.message : String(reason),
        );
      }
      return true;
    }
    if (intent.kind === "set-goal") {
      const updatedAt = new Date().toISOString();
      await changeGoal(
        runBot,
        runWorkspace,
        submitted,
        {
          ...runBot.spec.goal,
          outcome: intent.outcome,
          status: "active",
          nextAction: "Take the smallest useful read-only step with the context available now.",
          updatedAt,
        },
        "Goal updated",
        `Before: ${compactChangeText(runBot.spec.goal.outcome)}. Now: ${compactChangeText(intent.outcome)}.`,
        `Changed the goal to **${escapeBotMarkdown(intent.outcome)}**. I will use it to choose the next useful step.`,
      );
      return true;
    }
    if (intent.kind === "complete-goal") {
      const updatedAt = new Date().toISOString();
      await changeGoal(
        runBot,
        runWorkspace,
        submitted,
        { ...runBot.spec.goal, status: "completed", nextAction: "Waiting for a new goal.", updatedAt },
        "Goal completed",
        `Before: ${runBot.spec.goal.status}. Now: completed.`,
        "Goal completed. I will stay quiet until you give me another outcome or resume this one.",
      );
      return true;
    }

    if (intent.kind === "import-skill") {
      const imported = await importLocalBotSkill(runBot.id);
      if (!imported) {
        await appendControlExchange(runBot, runWorkspace, submitted, "No skill package was selected.");
        return true;
      }
      const currentSkills = await listLocalBotSkills();
      setSkills(currentSkills);
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        `Imported **${escapeBotMarkdown(imported.name)}** v${imported.version}. Review its inputs, effects, and checks below before it can run.`,
      );
      return true;
    }

    if (intent.kind === "teach-skill") {
      const safetyError = botMemorySafetyError(intent.instructions);
      if (safetyError) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          safetyError.replace("as memory", "in a reusable skill"),
        );
        return true;
      }
      const currentSkills = await listLocalBotSkills();
      const existing = currentSkills.find((skill) => (
        skill.name.localeCompare(intent.name, undefined, { sensitivity: "accent" }) === 0
      ));
      if (existing && !intent.replace) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          `**${escapeBotMarkdown(existing.name)}** already exists at v${existing.version}. `
            + `Say \`Update skill ${escapeBotMarkdown(existing.name)}: ...\` to replace its instructions explicitly.`,
        );
        return true;
      }
      if (!existing && intent.replace) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          `I could not find **${escapeBotMarkdown(intent.name)}**. Say \`Show skills\` to see the exact names.`,
        );
        return true;
      }
      const createdAt = new Date().toISOString();
      const saved = await saveLocalBotSkill({
        id: existing?.id || `skill-${crypto.randomUUID()}`,
        actorBotId: runBot.id,
        name: existing?.name || intent.name,
        description: describeBotSkill(intent.instructions),
        instructions: intent.instructions,
        capabilityIds: existing?.capabilityIds || [],
        inputSchema: existing?.inputSchema || [],
        outputSchema: existing?.outputSchema || [],
        requiredPermissions: existing?.requiredPermissions || [],
        effects: existing?.effects || [],
        examples: existing?.examples || [],
        checks: existing?.checks || [],
        ...(existing ? { expectedVersion: existing.version } : {}),
        createdAt,
      });
      const nextSkills = [saved, ...currentSkills.filter((skill) => skill.id !== saved.id)];
      setSkills(nextSkills);
      setSkillUndo({ botId: runBot.id, skill: saved, ...(existing ? { previous: existing } : {}) });
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        `${existing ? "Updated" : "Learned"} **${escapeBotMarkdown(saved.name)}** v${saved.version}. `
          + `Mention its exact name in a request when you want any local bot to use it.`,
      );
      return true;
    }

    if (intent.kind === "show-skills") {
      const currentSkills = await listLocalBotSkills();
      const visible = currentSkills.slice(0, 20);
      const response = visible.length
        ? [
            `This workspace has ${currentSkills.length} ${currentSkills.length === 1 ? "skill" : "skills"}:`,
            ...visible.map((skill) => {
              const browserRecipe = taughtBrowserRecipeForSkill(skill);
              const state = skill.trustState === "unreviewed"
                ? "waiting for review"
                : skill.source === "built-in" ? "packaged" : skill.source;
              return `- **${escapeBotMarkdown(skill.name)}** v${skill.version} · ${state}: ${escapeBotMarkdown(skill.description)}`
                + (browserRecipe || skill.inputSchema.length
                  ? ` Run it with \`${escapeBotMarkdown(skill.examples[0]?.request || `Run ${skill.name}`)}\`.`
                  : "");
            }),
            ...(currentSkills.length > visible.length
              ? [`- ${currentSkills.length - visible.length} more. Ask me to forget one by its exact name.`]
              : []),
          ].join("\n")
        : "This workspace has no reusable skills yet. Try: `Teach this as a skill called Release Check`.";
      await appendControlExchange(runBot, runWorkspace, submitted, response);
      return true;
    }

    if (intent.kind === "forget-skill") {
      const currentSkills = await listLocalBotSkills();
      const exact = currentSkills.find((skill) => (
        skill.name.localeCompare(intent.query, undefined, { sensitivity: "accent" }) === 0
      ));
      const matches = exact
        ? [exact]
        : currentSkills.filter((skill) => skill.name.toLowerCase().includes(intent.query.toLowerCase()));
      if (!matches.length) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          `I could not find a skill matching **${escapeBotMarkdown(intent.query)}**. Say \`Show skills\` to see the exact names.`,
        );
        return true;
      }
      if (matches.length > 1) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          ["That matches more than one skill. Tell me the exact name:",
            ...matches.slice(0, 5).map((skill) => `- ${escapeBotMarkdown(skill.name)}`)].join("\n"),
        );
        return true;
      }
      const [removed] = matches;
      await deleteLocalBotSkill(removed.id, runBot.id);
      setSkills(currentSkills.filter((skill) => skill.id !== removed.id));
      setSkillUndo(null);
      await appendControlExchange(runBot, runWorkspace, submitted, `Forgot skill **${escapeBotMarkdown(removed.name)}**.`);
      return true;
    }

    if (intent.kind === "remember") {
      const safetyError = botMemorySafetyError(intent.body);
      if (safetyError) {
        await appendControlExchange(runBot, runWorkspace, submitted, safetyError);
        return true;
      }
      const currentMemories = await listLocalBotMemories(runBot.id);
      const duplicate = currentMemories.find((memory) => memory.scope === intent.scope
        && memory.body.localeCompare(intent.body, undefined, { sensitivity: "accent" }) === 0);
      if (duplicate) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          `I already remember that ${duplicate.scope === "workspace" ? "for all bots" : "for this bot"}.`,
        );
        return true;
      }
      const createdAt = new Date().toISOString();
      const expiresAt = intent.retentionDays
        ? new Date(Date.parse(createdAt) + intent.retentionDays * 24 * 60 * 60 * 1_000).toISOString()
        : undefined;
      const memory = await saveLocalBotMemory({
        id: `memory-${crypto.randomUUID()}`,
        actorBotId: runBot.id,
        scope: intent.scope,
        kind: classifyBotMemory(intent.body),
        body: intent.body,
        ...(expiresAt ? { expiresAt } : {}),
        createdAt,
      });
      const nextMemories = [memory, ...currentMemories];
      if (activeBotId === runBot.id) {
        setMemories(nextMemories);
        setMemoryUndo({ botId: runBot.id, memory });
      }
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        `Remembered ${intent.scope === "workspace" ? "for all local bots" : "for this bot"}`
          + `${intent.retentionDays ? ` for ${intent.retentionDays} days` : ""}: ${escapeBotMarkdown(memory.body)}`,
      );
      return true;
    }

    if (intent.kind === "review-memory-proposals") {
      const currentProposals = await listLocalBotMemoryProposals(runBot.id);
      if (activeBotId === runBot.id) setMemoryProposals(currentProposals);
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        currentProposals.length
          ? `${currentProposals.length} memory ${currentProposals.length === 1 ? "suggestion is" : "suggestions are"} waiting below. Nothing is remembered until you approve it.`
          : "There are no memory suggestions waiting for review.",
      );
      return true;
    }

    if (intent.kind === "show-memory") {
      const currentMemories = await listLocalBotMemories(runBot.id);
      const visible = currentMemories.slice(0, 20);
      const response = visible.length
        ? [
            `I have ${currentMemories.length} approved ${currentMemories.length === 1 ? "memory" : "memories"}:`,
            ...visible.map((memory) => {
              const provenance = memory.source === "inferred" ? " · approved suggestion" : "";
              const expiry = memory.expiresAt
                ? ` · expires ${new Date(memory.expiresAt).toLocaleDateString()}`
                : "";
              return `- ${memory.scope === "workspace" ? "All bots" : "This bot"}${provenance}${expiry}: ${escapeBotMarkdown(memory.body)}`;
            }),
            ...(currentMemories.length > visible.length
              ? [`- ${currentMemories.length - visible.length} more. Ask me to forget a specific phrase to narrow this list.`]
              : []),
          ].join("\n")
        : "I do not have any durable memory yet. Say `Remember that...` to add one for this bot.";
      await appendControlExchange(runBot, runWorkspace, submitted, response);
      return true;
    }

    if (intent.kind === "forget-memory") {
      const currentMemories = await listLocalBotMemories(runBot.id);
      const currentProposals = intent.all
        ? await listLocalBotMemoryProposals(runBot.id)
        : [];
      if (!currentMemories.length && !currentProposals.length) {
        await appendControlExchange(runBot, runWorkspace, submitted, "There is no durable memory to forget.");
        return true;
      }
      if (intent.all) {
        const deletedCount = await clearLocalBotMemories(runBot.id, true);
        if (activeBotId === runBot.id) {
          setMemories([]);
          setMemoryProposals([]);
          setMemoryUndo(null);
        }
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          `Forgot ${deletedCount} ${deletedCount === 1 ? "memory item" : "memory items"}, including pending suggestions and shared memory visible to this bot.`,
        );
        return true;
      }
      const normalizedQuery = intent.query?.toLowerCase();
      const matches = normalizedQuery
        ? currentMemories.filter((memory) => memory.body.toLowerCase().includes(normalizedQuery))
        : currentMemories.slice(0, 1);
      if (!matches.length) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          `I could not find a memory matching ${escapeBotMarkdown(intent.query || "that")}. Ask `
            + "`What do you know?` to see the exact wording.",
        );
        return true;
      }
      if (matches.length > 1) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          ["That matches more than one memory. Tell me the exact phrase to forget:",
            ...matches.slice(0, 5).map((memory) => `- ${escapeBotMarkdown(memory.body)}`)].join("\n"),
        );
        return true;
      }
      const [removed] = matches;
      await deleteLocalBotMemory(removed.id, runBot.id);
      if (activeBotId === runBot.id) {
        setMemories(currentMemories.filter((memory) => memory.id !== removed.id));
        setMemoryUndo(null);
      }
      await appendControlExchange(runBot, runWorkspace, submitted, `Forgot: ${escapeBotMarkdown(removed.body)}`);
      return true;
    }

    const botSchedules = routinesForBot(schedules, runBot.id);
    const botEventRoutines = eventRoutines.filter((routine) => routine.botId === runBot.id);
    const routineCount = botSchedules.length + botEventRoutines.length;
    if (intent.kind === "show-routines") {
      const response = routineCount
        ? `You have ${routineCount} ${routineCount === 1 ? "routine" : "routines"}. They are shown below with their status and pause controls.`
        : "You do not have any routines yet. Try: `When this project changes, summarize what changed`.";
      await appendControlExchange(runBot, runWorkspace, submitted, response);
      return true;
    }
    if (intent.kind === "pause-routines") {
      await Promise.all([
        ...botSchedules.filter((schedule) => schedule.enabled)
          .map((schedule) => setLocalScheduleEnabled(schedule.id, false)),
        ...botEventRoutines.filter((routine) => routine.enabled)
          .map((routine) => setLocalEventRoutineEnabled(routine.id, false)),
      ]);
      const updated = await updateLocalBotRoutines(runBot.id, runBot.spec.routineIds, false);
      replaceBot(updated);
      await refreshRoutineState();
      await appendControlExchange(
        updated,
        runWorkspace,
        submitted,
        routineCount ? "All routines are paused." : "There were no routines to pause.",
      );
      return true;
    }

    if (intent.kind === "update-routine-schedule") {
      if (!schedulesAvailable) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          "Clock-based routines can be changed in the notarized Direct build.",
        );
        return true;
      }
      const query = intent.query?.toLowerCase();
      const exact = query
        ? botSchedules.find((schedule) => schedule.title.toLowerCase() === query)
        : null;
      const matches = exact
        ? [exact]
        : query
          ? botSchedules.filter((schedule) => {
              const snapshot = readBotRoutineSnapshot(schedule);
              return [schedule.title, snapshot?.prompt || "", snapshot?.triggerLabel || ""]
                .some((value) => value.toLowerCase().includes(query));
            })
          : botSchedules;
      if (!matches.length) {
        const projectChange = query
          ? botEventRoutines.find((routine) => routine.title.toLowerCase().includes(query))
          : null;
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          projectChange
            ? `**${escapeBotMarkdown(projectChange.title)}** runs when the project changes, so it has no clock time to move.`
            : "This bot has no matching clock-based routine to reschedule. Say `Show my routines` to see what is available.",
        );
        return true;
      }
      if (matches.length > 1) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          [
            "More than one routine matches. Name one exactly:",
            ...matches.slice(0, 6).map((schedule) => (
              `- **${escapeBotMarkdown(schedule.title)}**: ${escapeBotMarkdown(routineTiming(schedule))}`
            )),
          ].join("\n"),
        );
        return true;
      }
      const [schedule] = matches;
      const snapshot = readBotRoutineSnapshot(schedule);
      if (!snapshot) {
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          "That routine's reviewed snapshot is invalid. Remove it and create the routine again.",
        );
        return true;
      }
      const previousTiming = routineTiming(schedule);
      const request = localScheduleSaveRequest(schedule);
      delete request.oneTimeAt;
      setRoutineAction(schedule.id);
      try {
        const saved = await saveLocalSchedule({
          ...request,
          expectedRevision: schedule.revision,
          cadence: intent.cadence,
          localTime: intent.localTime,
          weekdays: intent.weekdays,
          snapshot: { ...snapshot, triggerLabel: intent.triggerLabel },
        });
        setSchedules((current) => current.map((candidate) => candidate.id === saved.id ? saved : candidate));
        setBotChangeUndo({
          kind: "schedule",
          botId: runBot.id,
          scheduleId: saved.id,
          changedRevision: saved.revision,
          previousSchedule: schedule,
          title: "Routine rescheduled",
          detail: `Before: ${previousTiming}. Now: ${intent.triggerLabel}.`,
        });
        await appendControlExchange(
          runBot,
          runWorkspace,
          submitted,
          `Changed **${escapeBotMarkdown(saved.title)}** from ${escapeBotMarkdown(previousTiming)} to ${escapeBotMarkdown(intent.triggerLabel)}.`,
        );
      } finally {
        setRoutineAction(null);
      }
      return true;
    }

    if (!schedulesAvailable) {
      await appendControlExchange(
        runBot,
        runWorkspace,
        submitted,
        "Background routines aren't available in this App Store build. Keep Codelit open to run the task now.",
      );
      return true;
    }
    const runEngine = selectBotEngine(providers, buildChannel, runBot.spec.enginePolicy);
    if (!runEngine) {
      setBotFeedback(runBot.id, { error: "Set up one local intelligence engine before creating a routine." });
      return true;
    }
    const createdAt = new Date().toISOString();
    const routineId = `routine-${crypto.randomUUID()}`;
    const title = intent.prompt.length > 72 ? `${intent.prompt.slice(0, 69).trim()}...` : intent.prompt;
    setRoutineAction(routineId);
    try {
      if (intent.kind === "watch-project") {
        let approvedWorkspace = runWorkspace;
        if (!approvedWorkspace.workspaceFolder?.accessValidated) {
          const selected = await chooseWorkspaceFolder();
          if (!selected) {
            await appendControlExchange(
              runBot,
              runWorkspace,
              submitted,
              "I did not start the routine because no project folder was chosen.",
            );
            return true;
          }
          const refreshed = await bootstrapBots();
          setCatalog(refreshed);
          approvedWorkspace = refreshed.activeBot.id === runBot.id
            ? refreshed.workspace
            : (await openLocalBotContext(runBot.id)).workspace;
          if (!approvedWorkspace.workspaceFolder?.accessValidated) {
            throw new Error("Codelit could not confirm read-only access to that project folder.");
          }
        }
        const [currentMemories, currentSkills] = await Promise.all([
          listLocalBotMemories(runBot.id),
          listLocalBotSkills(),
        ]);
        const selectedSkills = skillsForBotRequest(currentSkills, intent.prompt);
        const saved = await saveLocalEventRoutine({
          id: routineId,
          botId: runBot.id,
          title,
          prompt: intent.prompt,
          trigger: {
            kind: "project-change",
            label: intent.triggerLabel,
            debounceSeconds: 30,
            cooldownMinutes: 5,
          },
          budget: {
            maxActions: Math.max(1, Math.min(8, runBot.spec.autonomyPolicy.maxActionsPerRun)),
            maxRetries: 2,
          },
          provider: runEngine.provider,
          model: runEngine.model,
          requiresNetwork: !["mlx", "ollama", "lmstudio"].includes(runEngine.provider)
            || parseBotBrowserTarget(intent.prompt).kind === "target",
          botSnapshot: runBot.spec,
          memorySnapshotHash: await botMemorySnapshotHash(currentMemories),
          skillVersions: botSkillVersions(selectedSkills),
          createdAt,
        });
        let updated: LocalBotRecord;
        try {
          updated = await updateLocalBotRoutines(
            runBot.id,
            [...new Set([...runBot.spec.routineIds, routineId])],
            false,
          );
        } catch (reason) {
          await deleteLocalEventRoutine(saved.id).catch(() => undefined);
          throw reason;
        }
        replaceBot(updated);
        setEventRoutines((current) => [...current.filter((routine) => routine.id !== saved.id), saved]);
        await appendControlExchange(
          updated,
          approvedWorkspace,
          submitted,
          `I prepared **${intent.triggerLabel}**. Review the routine below, then start it with one click.`,
        );
        return true;
      }
      const artifact = runWorkspace.artifacts.find(
        (candidate) => candidate.artifactId === "artifact-plan-ship-local",
      );
      if (!artifact) {
        setBotFeedback(runBot.id, { error: "The local routine boundary is unavailable. Reopen Codelit and try again." });
        return true;
      }
      const saved = await saveLocalSchedule({
        id: routineId,
        threadId: runBot.threadId,
        artifactId: artifact.artifactId,
        artifactVersion: artifact.version,
        title,
        enabled: false,
        cadence: intent.cadence,
        localTime: intent.localTime,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        weekdays: intent.weekdays,
        missedPolicy: "run-once",
        maxRetries: 2,
        provider: runEngine.provider,
        model: runEngine.model,
        requiresNetwork: !["mlx", "ollama", "lmstudio"].includes(runEngine.provider)
          || parseBotBrowserTarget(intent.prompt).kind === "target",
        snapshot: createRoutineSnapshot(runBot, routineId, intent.prompt, intent.triggerLabel, createdAt),
      });
      let updated: LocalBotRecord;
      try {
        updated = await updateLocalBotRoutines(
          runBot.id,
          [...new Set([...runBot.spec.routineIds, routineId])],
          false,
        );
      } catch (reason) {
        await deleteLocalSchedule(saved.id).catch(() => undefined);
        throw reason;
      }
      replaceBot(updated);
      setSchedules((current) => [...current.filter((schedule) => schedule.id !== saved.id), saved]);
      await appendControlExchange(
        updated,
        runWorkspace,
        submitted,
        `I prepared **${intent.triggerLabel}**. Review the routine below, then start it with one click.`,
      );
    } finally {
      setRoutineAction(null);
    }
    return true;
  };

  const reviewMemoryProposal = async (
    proposal: BotMemoryProposal,
    decision: "approve" | "dismiss",
    scope: BotMemory["scope"],
    expiresAt?: string,
  ) => {
    if (memoryProposalActionId) return;
    setMemoryProposalActionId(proposal.id);
    setBotFeedback(proposal.botId, { error: null, notice: null });
    try {
      const memory = await reviewLocalBotMemoryProposal({
        id: proposal.id,
        actorBotId: proposal.botId,
        decision,
        scope,
        ...(expiresAt ? { expiresAt } : {}),
        reviewedAt: new Date().toISOString(),
      });
      if (activeBotIdRef.current === proposal.botId) {
        setMemoryProposals((current) => current.filter((candidate) => candidate.id !== proposal.id));
        if (memory) {
          setMemories((current) => [memory, ...current.filter((candidate) => candidate.id !== memory.id)]);
          setMemoryUndo({ botId: proposal.botId, memory });
        }
      }
      setBotFeedback(proposal.botId, {
        error: null,
        notice: memory ? "Memory approved" : "Suggestion dismissed",
      });
    } catch (reason) {
      setBotFeedback(proposal.botId, {
        error: reason instanceof Error ? reason.message : String(reason),
        notice: null,
      });
    } finally {
      setMemoryProposalActionId(null);
    }
  };

  const reviewSkillPackage = async (skill: BotSkill, decision: "approve" | "discard") => {
    if (!bot || skillReviewActionId) return;
    setSkillReviewActionId(skill.id);
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      const reviewed = await reviewImportedBotSkill({
        id: skill.id,
        actorBotId: bot.id,
        expectedVersion: skill.version,
        decision,
        reviewedAt: new Date().toISOString(),
      });
      setSkills((current) => reviewed
        ? [reviewed, ...current.filter((candidate) => candidate.id !== skill.id)]
        : current.filter((candidate) => candidate.id !== skill.id));
      setBotFeedback(bot.id, {
        error: null,
        notice: reviewed ? `${reviewed.name} is ready` : "Skill package discarded",
      });
    } catch (reason) {
      setBotFeedback(bot.id, {
        error: reason instanceof Error ? reason.message : String(reason),
        notice: null,
      });
    } finally {
      setSkillReviewActionId(null);
    }
  };

  const undoRememberedMemory = async () => {
    if (!memoryUndo || memoryUndo.botId !== activeBotId) return;
    const undo = memoryUndo;
    setMemoryUndo(null);
    try {
      await deleteLocalBotMemory(undo.memory.id, undo.botId);
      setMemories((current) => current.filter((memory) => memory.id !== undo.memory.id));
      setBotFeedback(undo.botId, { notice: "Memory removed", error: null });
    } catch (reason) {
      setBotFeedback(undo.botId, {
        error: reason instanceof Error ? reason.message : String(reason),
        notice: null,
      });
    }
  };

  const undoTaughtSkill = async () => {
    if (!skillUndo || skillUndo.botId !== activeBotId) return;
    const undo = skillUndo;
    setSkillUndo(null);
    try {
      if (undo.previous) {
        const restored = await saveLocalBotSkill({
          id: undo.skill.id,
          actorBotId: undo.botId,
          name: undo.previous.name,
          description: undo.previous.description,
          instructions: undo.previous.instructions,
          capabilityIds: undo.previous.capabilityIds,
          inputSchema: undo.previous.inputSchema,
          outputSchema: undo.previous.outputSchema,
          requiredPermissions: undo.previous.requiredPermissions,
          effects: undo.previous.effects,
          examples: undo.previous.examples,
          checks: undo.previous.checks,
          expectedVersion: undo.skill.version,
          createdAt: new Date().toISOString(),
        });
        setSkills((current) => [restored, ...current.filter((skill) => skill.id !== restored.id)]);
        setBotFeedback(undo.botId, { notice: `${restored.name} restored`, error: null });
      } else {
        await deleteLocalBotSkill(undo.skill.id, undo.botId);
        setSkills((current) => current.filter((skill) => skill.id !== undo.skill.id));
        setBotFeedback(undo.botId, { notice: "Skill removed", error: null });
      }
    } catch (reason) {
      setBotFeedback(undo.botId, {
        error: reason instanceof Error ? reason.message : String(reason),
        notice: null,
      });
    }
  };

  const closeBrowserTeaching = (notice?: string) => {
    const teaching = browserTeaching;
    setBrowserTeaching(null);
    browserTeachingRelease.current?.();
    browserTeachingRelease.current = null;
    if (teaching && notice) {
      setBotFeedback(teaching.botId, { notice, error: null });
    }
  };

  const saveBrowserTeaching = async (draft: TaughtBrowserRecipeDraft) => {
    if (!browserTeaching) throw new Error("This browser demonstration is no longer active.");
    const currentSkills = await listLocalBotSkills();
    const existing = currentSkills.find((skill) => (
      skill.name.localeCompare(draft.name, undefined, { sensitivity: "accent" }) === 0
    ));
    const saved = await saveLocalBotSkill({
      id: existing?.id || `skill-${crypto.randomUUID()}`,
      actorBotId: browserTeaching.botId,
      name: existing?.name || draft.name,
      description: draft.description,
      instructions: draft.instructions,
      capabilityIds: draft.capabilityIds,
      inputSchema: draft.recipe.inputs.map((input) => ({
        id: input.id,
        label: input.label,
        type: input.type === "number" ? "number" as const : "text" as const,
        required: true,
        ...(input.type === "email" ? { description: "An email value supplied only for this run." } : {}),
      })),
      outputSchema: [{
        id: "browser-proof",
        label: "Browser proof",
        type: "text",
        required: true,
        description: "Inspectable evidence from the deterministic replay.",
      }],
      requiredPermissions: ["browser-read", "browser-act"],
      effects: [
        {
          id: "read-browser",
          label: "Read the reviewed browser task",
          kind: "browser-read",
          target: "recipe:start-url",
          risk: "read-only",
        },
        {
          id: "replay-browser",
          label: "Replay each reviewed browser action",
          kind: "browser-write",
          target: "recipe:steps",
          risk: "write",
        },
      ],
      examples: [{ request: `Run ${draft.name}` }],
      checks: [
        ...draft.recipe.inputs.map((input) => ({
          id: `required-${input.id}`,
          label: `${input.label} is present`,
          phase: "before" as const,
          rule: "required" as const,
          inputId: input.id,
        })),
        {
          id: "browser-proof-present",
          label: "Browser proof is present",
          phase: "after",
          rule: "output-present",
        },
      ],
      ...(existing ? { expectedVersion: existing.version } : {}),
      createdAt: new Date().toISOString(),
    });
    setSkills([saved, ...currentSkills.filter((skill) => skill.id !== saved.id)]);
    setSkillUndo({
      botId: browserTeaching.botId,
      skill: saved,
      ...(existing ? { previous: existing } : {}),
    });
    closeBrowserTeaching(`${saved.name} is ready to reuse`);
  };

  const assertCurrentBrowserSkill = async (run: NonNullable<typeof browserSkillRun>) => {
    const current = (await listLocalBotSkills()).find((skill) => skill.id === run.request.skill.id);
    if (!current
      || current.version !== run.request.skill.version
      || current.checksum !== run.request.skill.checksum) {
      throw new Error("This browser skill changed during the run. Start it again to use the reviewed version.");
    }
  };

  const recordBrowserSkillApproval = async (
    update: {
      id: string;
      stepIndex: number;
      status: "awaiting" | "approved" | "held";
      body: unknown;
    },
  ) => {
    const run = browserSkillRun;
    if (!run) throw new Error("This browser skill run is no longer active.");
    await assertCurrentBrowserSkill(run);
    const context = await openLocalBotContext(run.botId);
    const next = await recordLocalRunApproval(context.workspace, {
      ...update,
      runId: run.runId,
    });
    applyWorkspace(run.botId, context.bot.threadId, next);
  };

  const checkpointBrowserSkill = async (checkpoint: {
    stepIndex: number;
    handoff: string;
    priorSteps: unknown[];
    gateApproved: boolean;
    runContext: unknown;
  }) => {
    const run = browserSkillRun;
    if (!run) throw new Error("This browser skill run is no longer active.");
    await assertCurrentBrowserSkill(run);
    const context = await openLocalBotContext(run.botId);
    const next = await saveLocalRunCheckpoint(context.workspace, run.runId, checkpoint);
    applyWorkspace(run.botId, context.bot.threadId, next);
  };

  const finishBrowserSkillRun = async (outcome: BrowserSkillReplayOutcome) => {
    const run = browserSkillRun;
    if (!run) return;
    setBrowserSkillRun(null);
    cancelQueuedBrowserLane(run.runId);
    browserSkillRelease.current?.();
    browserSkillRelease.current = null;
    const status = outcome.status === "completed"
      ? "completed"
      : outcome.status === "canceled"
        ? "canceled"
        : "failed";
    try {
      const context = await openLocalBotContext(run.botId);
      let next = await appendThreadMessage(context.workspace, outcome.summary, "assistant");
      const provenance = providerRunProvenance({ provider: "codelit" }, "fixed", false, false);
      const result: ProviderTaskResult = {
        runId: run.runId,
        provider: "codelit",
        model: "browser-replay-v1",
        status,
        ...(status === "completed" ? {
          structuredOutput: { summary: outcome.summary, items: [] },
        } : {}),
        text: outcome.summary,
        durationMs: outcome.durationMs,
        commandPath: "codelit-browser-replay",
        evidence: outcome.proofs.flatMap((proof) => proof.evidence.map((item) => item.id)),
        ...provenance,
      };
      next = await recordProviderRun(
        next,
        "artifact-plan-ship-local",
        result,
        outcome.events,
        {
          botId: run.botId,
          botVersion: context.bot.currentVersion,
          skill: {
            id: run.request.skill.id,
            version: run.request.skill.version,
            checksum: run.request.skill.checksum,
          },
          approval: {
            mode: "ask-every-action",
            decisionSource: "user",
            scope: "browser-skill-replay",
          },
          browser: {
            host: new URL(run.request.recipe.startUrl).hostname,
            mode: "replay",
            proofs: outcome.proofs,
          },
          completedTools: outcome.completedTools,
          execution: {
            completedStepIds: outcome.completedStepIds,
            automatedSteps: outcome.automatedSteps,
            takeoverSteps: outcome.takeoverSteps,
          },
        },
        outcome.summary,
      );
      applyWorkspace(run.botId, context.bot.threadId, next);
      replaceBot(await updateLocalBotStatus(
        run.botId,
        status === "completed" ? "sleeping" : status === "canceled" ? "paused" : "blocked",
        status === "completed" ? `${run.request.skill.name} finished` : `${run.request.skill.name} stopped`,
      ));
      setBotFeedback(run.botId, {
        error: status === "failed" ? outcome.summary : null,
        notice: null,
      });
    } catch (reason) {
      setBotFeedback(run.botId, {
        error: reason instanceof Error ? reason.message : String(reason),
        notice: null,
      });
    }
  };

  const runDelegationTarget = async (
    delegation: LocalBotDelegation,
    target: LocalBotDelegation["targets"][number],
  ) => {
    const inFlightKey = `${delegation.id}:${target.botId}`;
    if (delegationTargetsInFlight.current.has(inFlightKey)) return;
    delegationTargetsInFlight.current.add(inFlightKey);
    const runId = `run-${crypto.randomUUID()}`;
    let started = false;
    try {
      const deadline = new Date(target.deadlineAt).getTime();
      while (!canStartBotExecution(executionStatesRef.current, target.botId)
        && Date.now() < deadline) {
        if (canceledDelegationIds.current.has(delegation.id)) {
          throw new Error("Handoff stopped by user.");
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      }
      const context = await openLocalBotContext(target.botId);
      const runBot: LocalBotRecord = {
        ...context.bot,
        name: target.botName,
        currentVersion: target.botVersion,
        spec: target.botSnapshot,
      };
      const selectedEngine = selectBotEngine(providers, buildChannel, runBot.spec.enginePolicy);
      const capacityProviderId = selectedEngine?.provider
        || runBot.spec.enginePolicy.fixedEngine?.provider
        || runBot.spec.enginePolicy.allowedProviders[0]
        || "codex";
      const capacityProvider = providers.find((provider) => provider.id === capacityProviderId);
      let startedDelegation: LocalBotDelegation | null = null;
      while (!startedDelegation) {
        if (canceledDelegationIds.current.has(delegation.id)) {
          throw new Error("Handoff stopped by user.");
        }
        try {
          startedDelegation = await startLocalBotDelegationTarget({
            id: delegation.id,
            targetBotId: target.botId,
            runId,
            providerId: capacityProviderId,
            providerQuotaState: capacityProvider?.status === "quota-hit"
              ? "exhausted"
              : capacityProvider?.quota.state || "unknown",
            startedAt: new Date().toISOString(),
          });
        } catch (reason) {
          const capacityDetail = localRunCapacityDetail(reason);
          if (!capacityDetail || Date.now() >= new Date(target.deadlineAt).getTime()) throw reason;
          await refreshDelegations().catch(() => undefined);
          await new Promise<void>((resolve) => window.setTimeout(resolve, 2_000));
        }
      }
      started = true;
      replaceDelegation(startedDelegation);

      const runMemories = await listLocalBotMemories(target.botId);
      const sharedMemoryHash = await botMemorySnapshotHash(
        runMemories.filter((memory) => memory.scope === "workspace"),
      );
      if (sharedMemoryHash !== delegation.sharedMemorySnapshotHash) {
        throw new Error("Shared memory changed after this handoff was reviewed. Ask the specialists again so the new context is explicit.");
      }
      const delegationContext: LocalBotDelegationRunContext = {
        delegationId: delegation.id,
        parentBotId: delegation.parentBotId,
        parentThreadId: delegation.parentThreadId,
        parentBotName: delegation.parentBotName,
        targetBotId: target.botId,
        expectedOutput: delegation.expectedOutput,
        maxActions: target.maxActions,
      };
      const outcome = await submitTaskRef.current?.(delegation.task, {
        bot: runBot,
        workspace: context.workspace,
        memories: runMemories,
        runId,
        appendUser: false,
        ...(selectedEngine ? { engine: selectedEngine } : {}),
        delegation: delegationContext,
      });
      if (!outcome) throw new Error("The specialist runner was not ready.");
      if (outcome.status === "approval-required") {
        replaceDelegation(await finishLocalBotDelegationTarget({
          id: delegation.id,
          targetBotId: target.botId,
          runId,
          outcome: "approval-required",
          detail: outcome.detail,
          finishedAt: new Date().toISOString(),
        }));
        return;
      }
      const completed = outcome.status === "completed";
      replaceDelegation(await finishLocalBotDelegationTarget({
        id: delegation.id,
        targetBotId: target.botId,
        runId,
        outcome: completed ? "completed" : /cancel|stop/i.test(outcome.detail) ? "canceled" : "failed",
        ...(completed ? {
          result: outcome.answer || outcome.detail || "The specialist completed the delegated task.",
        } : {}),
        detail: outcome.detail,
        finishedAt: new Date().toISOString(),
      }));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (started) {
        try {
          replaceDelegation(await finishLocalBotDelegationTarget({
            id: delegation.id,
            targetBotId: target.botId,
            runId,
            outcome: /cancel|stop/i.test(message) ? "canceled" : "failed",
            detail: message.slice(0, 1_000),
            finishedAt: new Date().toISOString(),
          }));
        } catch {
          await refreshDelegations().catch(() => undefined);
        }
      } else {
        await refreshDelegations().catch(() => undefined);
        if (!canceledDelegationIds.current.has(delegation.id)) setGlobalError(message);
      }
    } finally {
      delegationTargetsInFlight.current.delete(inFlightKey);
    }
  };
  runDelegationTargetRef.current = runDelegationTarget;

  const startDelegation = async (
    submitted: string,
    parentBot: LocalBotRecord,
    parentWorkspace: NonNullable<typeof workspace>,
    intent: Extract<ReturnType<typeof parseBotDelegationIntent>, { kind: "delegate" }>,
  ): Promise<BotTaskOutcome> => {
    try {
      const sharedMemories = (await listLocalBotMemories(parentBot.id))
        .filter((memory) => memory.scope === "workspace");
      const sharedMemorySnapshotHash = await botMemorySnapshotHash(sharedMemories);
      const withRequest = await appendThreadMessage(parentWorkspace, submitted, "user");
      applyWorkspace(parentBot.id, parentBot.threadId, withRequest);
      setPromptsByBotId((current) => ({ ...current, [parentBot.id]: "" }));
      const createdAt = new Date().toISOString();
      const delegation = await createLocalBotDelegation({
        id: `delegation-${crypto.randomUUID()}`,
        parentBotId: parentBot.id,
        targetBotIds: intent.targetBotIds,
        task: intent.task,
        expectedOutput: intent.expectedOutput,
        maxActions: intent.maxActions,
        deadlineAt: new Date(Date.now() + intent.deadlineMinutes * 60_000).toISOString(),
        sharedMemorySnapshotHash,
        createdAt,
      });
      replaceDelegation(delegation);
      void Promise.all(delegation.targets.map((target) => runDelegationTarget(delegation, target)));
      return {
        status: "completed",
        detail: `Asked ${delegation.targets.map((target) => target.botName).join(" and ")}.`,
      };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setBotFeedback(parentBot.id, { error: message, notice: null });
      return { status: "failed", detail: message };
    }
  };

  const offerMemoryFromCompletedRun = async (
    runBot: LocalBotRecord,
    request: string,
    runId: string,
  ) => {
    const suggestion = inferBotMemoryProposal(request);
    if (!suggestion) return;
    const proposal = await createLocalBotMemoryProposal({
      id: `memory-proposal-${crypto.randomUUID()}`,
      actorBotId: runBot.id,
      kind: suggestion.kind,
      body: suggestion.body,
      sourceRunId: runId,
      createdAt: new Date().toISOString(),
    });
    if (proposal && activeBotIdRef.current === runBot.id) {
      setMemoryProposals((current) => [
        proposal,
        ...current.filter((candidate) => candidate.id !== proposal.id),
      ]);
    }
  };

  const submit = async (value = prompt, options: BotTaskOptions = {}): Promise<BotTaskOutcome> => {
    const submitted = value.trim();
    const runBot = options.bot || bot;
    let runWorkspace = options.workspace || workspace;
    if (!catalog || !runBot || !runWorkspace || !submitted) {
      return { status: "failed", detail: "The bot conversation is not ready." };
    }
    const botId = runBot.id;
    const threadId = runBot.threadId;
    if (options.appendUser !== false && autoStartBotId === botId) {
      autoStartedBots.current.add(botId);
      setAutoStartBotId(null);
    }
    const currentPendingBrowserRun = botExecutionState(executionStatesRef.current, botId).pendingBrowserRun;
    if (currentPendingBrowserRun) {
      setBotFeedback(botId, {
        error: `Allow or hold the pending ${currentPendingBrowserRun.target.host} read before starting another task.`,
      });
      return { status: "approval-required", detail: `Review access to ${currentPendingBrowserRun.target.host}.` };
    }
    const currentPendingComputerRun = botExecutionState(executionStatesRef.current, botId).pendingComputerRun;
    if (currentPendingComputerRun) {
      setBotFeedback(botId, {
        error: `Allow or hold the pending ${currentPendingComputerRun.app.appName} action before starting another task.`,
      });
      return { status: "approval-required", detail: `Review the ${currentPendingComputerRun.app.appName} action.` };
    }
    const currentPendingMcpRun = botExecutionState(executionStatesRef.current, botId).pendingMcpRun;
    if (currentPendingMcpRun) {
      setBotFeedback(botId, {
        error: `Allow or hold the pending ${currentPendingMcpRun.serverName} action before starting another task.`,
      });
      return { status: "approval-required", detail: `Review the ${currentPendingMcpRun.serverName} action.` };
    }
    if (!canStartBotExecution(executionStatesRef.current, botId)) {
      setBotFeedback(botId, { error: "This bot already has an active run." });
      return { status: "paused", detail: "This bot already has an active run." };
    }
    let localFileIntent = null as ReturnType<typeof parseLocalFileIntent>;
    if (!options.routine && !options.delegation) {
      const teachingRequest = parseBrowserTeachingRequest(submitted);
      if (teachingRequest) {
        if (!browserReadAvailable) {
          const message = "Browser task teaching is available in Codelit's notarized Direct build.";
          setBotFeedback(botId, { error: message, notice: null });
          return { status: "paused", detail: message };
        }
        if (browserTeaching) {
          const message = "Finish or cancel the current browser demonstration first.";
          setBotFeedback(botId, { error: message, notice: null });
          return { status: "paused", detail: message };
        }
        const sessionId = `teaching-${crypto.randomUUID()}`;
        try {
          browserTeachingRelease.current = await acquireBrowserLane(sessionId);
          setPromptsByBotId((current) => ({ ...current, [botId]: "" }));
          setBotFeedback(botId, { error: null, notice: null });
          await appendControlExchange(
            runBot,
            runWorkspace,
            submitted,
            `The private teaching browser is opening for **${escapeBotMarkdown(teachingRequest.name)}**. `
              + "Do the task once, then review the recorded steps. Typed values are never retained.",
          );
          setBrowserTeaching({ botId, sessionId, request: teachingRequest });
          return { status: "completed", detail: `Teaching ${teachingRequest.name}.` };
        } catch (reason) {
          browserTeachingRelease.current?.();
          browserTeachingRelease.current = null;
          const message = reason instanceof Error ? reason.message : String(reason);
          setBotFeedback(botId, { error: message, notice: null });
          return { status: "failed", detail: message };
        }
      }
      const browserSkillCandidate = /^(?:run|replay|start|use)\b/i.test(submitted)
        ? parseBrowserSkillRunRequest(submitted, await listLocalBotSkills())
        : null;
      if (browserSkillCandidate) {
        if (!browserReadAvailable) {
          const message = "Browser skill replay is available in Codelit's notarized Direct build.";
          setBotFeedback(botId, { error: message, notice: null });
          return { status: "paused", detail: message };
        }
        if (browserTeaching || browserSkillRun) {
          const message = "Finish or stop the current browser task first.";
          setBotFeedback(botId, { error: message, notice: null });
          return { status: "paused", detail: message };
        }
        const runId = `run-browser-skill-${crypto.randomUUID()}`;
        const sessionId = browserSessionId(runId);
        try {
          setPromptsByBotId((current) => ({ ...current, [botId]: "" }));
          setBotFeedback(botId, { error: null, notice: null });
          const withUser = await appendThreadMessage(runWorkspace, submitted);
          const started = await beginLocalRun(
            withUser,
            "artifact-plan-ship-local",
            runId,
            { provider: "codelit", model: "browser-replay-v1" },
          );
          applyWorkspace(botId, threadId, started);
          setBrowserSkillRun({
            botId,
            runId,
            sessionId,
            request: browserSkillCandidate,
          });
          await changeBotStatus(botId, "working", `Running ${browserSkillCandidate.skill.name}`)
            .catch(() => undefined);
          return { status: "completed", detail: `Started ${browserSkillCandidate.skill.name}.`, runId };
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          setBotFeedback(botId, { error: message, notice: null });
          return { status: "failed", detail: message };
        }
      }
      const dataIntent = parseBotDataIntent(submitted);
      if (dataIntent) {
        try {
          setPromptsByBotId((current) => ({ ...current, [botId]: "" }));
          setBotFeedback(botId, { error: null, notice: null });
          await handleBotDataIntent(dataIntent, submitted, runBot, runWorkspace);
          return { status: "completed", detail: "Local table updated." };
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          setBotFeedback(botId, { error: message, notice: null });
          return { status: "failed", detail: message };
        }
      }
      const delegation = parseBotDelegationIntent(
        submitted,
        catalog.bots,
        runBot.id,
        runBot.id === activeBotId ? activeGroupMembers.map((member) => member.id) : [],
      );
      if (delegation?.kind === "delegation-error") {
        setBotFeedback(botId, { error: delegation.message, notice: null });
        return { status: "failed", detail: delegation.message };
      }
      if (delegation?.kind === "delegate") {
        return startDelegation(submitted, runBot, runWorkspace, delegation);
      }
      const control = parseBotControlIntent(submitted, previousUserRequest(runWorkspace.blocks));
      if (control) {
        try {
          await handleBotControlIntent(control, submitted, runBot, runWorkspace);
          return { status: "completed", detail: "Bot control updated." };
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          setBotFeedback(botId, { error: message });
          return { status: "failed", detail: message };
        }
      }
      const conversationReply = localConversationReply(submitted, escapeBotMarkdown(runBot.name));
      if (conversationReply) {
        setPromptsByBotId((current) => ({ ...current, [botId]: "" }));
        setBotFeedback(botId, { error: null, notice: null });
        await appendControlExchange(runBot, runWorkspace, submitted, conversationReply);
        return { status: "completed", detail: conversationReply, answer: conversationReply };
      }
      localFileIntent = parseLocalFileIntent(submitted);
      if (localFileIntent) {
        const purpose = localFileIntent.kind === "list-folder"
          ? localFileIntent.purpose
          : "project";
        const folderReady = runWorkspace.workspaceFolder?.accessValidated
          && selectedFolderMatchesPurpose(runWorkspace.workspaceFolder.path, purpose);
        if (!folderReady) {
          setChoosingFolder(true);
          setPromptsByBotId((current) => ({ ...current, [botId]: "" }));
          setBotFeedback(botId, { error: null, notice: null });
          try {
            const selected = await chooseWorkspaceFolder(purpose);
            if (!selected) {
              const message = purpose === "desktop"
                ? "I need read-only access to your Desktop before I can list it. Ask again when you are ready to choose Desktop."
                : "I need read-only access to the codebase folder before I can inspect it. Ask again when you are ready to choose the project.";
              await appendControlExchange(runBot, runWorkspace, submitted, message);
              return { status: "paused", detail: message };
            }
            const refreshed = await bootstrapBots();
            setCatalog(refreshed);
            runWorkspace = refreshed.activeBot.id === runBot.id
              ? refreshed.workspace
              : (await openLocalBotContext(runBot.id)).workspace;
            if (!runWorkspace.workspaceFolder?.accessValidated
              || !selectedFolderMatchesPurpose(runWorkspace.workspaceFolder.path, purpose)) {
              throw new Error(purpose === "desktop"
                ? "Choose the Desktop folder itself so Codelit can list it read-only."
                : "Choose the codebase folder itself so Codelit can inspect it read-only.");
            }
            setGlobalNotice(purpose === "desktop"
              ? "Desktop access connected read-only"
              : "Project connected read-only");
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            setBotFeedback(botId, { error: message, notice: null });
            return { status: "failed", detail: message };
          } finally {
            setChoosingFolder(false);
          }
        }
      }
    }
    const selectedEngine: IntelligenceSelection | null = localFileIntent?.kind === "list-folder"
      ? { provider: "codelit", model: "filesystem-v1" }
      : options.engine || selectBotEngine(providers, buildChannel, runBot.spec.enginePolicy);
    if (!selectedEngine) {
      openSettings("intelligence");
      setBotFeedback(botId, { error: "Set up one local intelligence engine to start." });
      return { status: "paused", detail: "Set up one local intelligence engine to start." };
    }
    let runMemories: BotMemory[];
    let memorySnapshotHash: string;
    try {
      runMemories = options.memories || await listLocalBotMemories(runBot.id);
      memorySnapshotHash = await botMemorySnapshotHash(runMemories);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setBotFeedback(botId, { error: message });
      return { status: "paused", detail: message };
    }
    const runEngine = selectedEngine;
    const runSelectionMode = runBot.spec.enginePolicy.mode;
    const runMeteredFallbackAuthorized = runSelectionMode === "auto"
      && runBot.spec.enginePolicy.allowMeteredFallback;
    const taskRequest = options.delegation
      ? [
          `A reviewed handoff from ${options.delegation.parentBotName} assigned this bounded task.`,
          `Complete this task now: ${submitted}`,
          `Return ${options.delegation.expectedOutput}`,
        ].join("\n")
      : options.routine
      ? [
          `A reviewed local routine named "${options.routine.title}" triggered at ${options.routine.scheduledFor}.`,
          `Complete this bounded task now: ${submitted}`,
          "Report the concrete result, evidence used, and any single next action that still needs the user.",
        ].join("\n")
      : submitted;
    let runSkills: BotSkill[];
    try {
      const availableSkills = options.skills || await listLocalBotSkills();
      runSkills = localFileIntent?.kind === "list-folder"
        ? []
        : options.skills || skillsForBotRequest(availableSkills, submitted);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setBotFeedback(botId, { error: message });
      return { status: "paused", detail: message };
    }
    const runHasProject = Boolean(runWorkspace.workspaceFolder?.accessValidated);
    const skillPreparation = prepareBotSkillRuns(runSkills, submitted, {
      projectApproved: runHasProject,
    });
    if (skillPreparation.status === "invalid") {
      setBotFeedback(botId, { error: skillPreparation.message });
      return { status: "paused", detail: skillPreparation.message };
    }
    let skillRunReceipts = skillPreparation.receipts;
    const skillVersions = botSkillVersions(runSkills);
    const browserAction = parseBotBrowserAction(submitted);
    if (browserAction.kind === "invalid") {
      setBotFeedback(botId, { error: browserAction.message });
      return { status: "failed", detail: browserAction.message };
    }
    const browserTarget = browserAction.kind === "action"
      ? { kind: "target" as const, url: browserAction.request.url, host: browserAction.request.host }
      : parseBotBrowserTarget(submitted);
    if (browserTarget.kind === "invalid") {
      setBotFeedback(botId, { error: browserTarget.message });
      return { status: "failed", detail: browserTarget.message };
    }
    if (browserTarget.kind === "target" && !browserReadAvailable) {
      setBotFeedback(botId, {
        error: "Agent website inspection isn't included in this App Store build.",
      });
      return { status: "paused", detail: "Website inspection is unavailable in this build." };
    }
    if (browserAction.kind === "action" && runBot.spec.permissionPolicy.writeActions === "disabled") {
      const message = "Browser actions are disabled for this bot. Enable reviewed writes, then ask again.";
      setBotFeedback(botId, { error: message });
      return { status: "paused", detail: message };
    }
    if (browserAction.kind === "action" && (options.routine || options.delegation)) {
      const message = "Browser actions start only from this bot's conversation so every exact action can be reviewed.";
      setBotFeedback(botId, { error: message });
      return { status: "paused", detail: message };
    }
    let computerTarget: ComputerAppScope | null = null;
    if (!localFileIntent && !options.routine && !options.delegation && computerUseAvailable) {
      try {
        computerTarget = matchComputerApp(submitted, await listComputerAppScopes(runBot.id));
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setBotFeedback(botId, { error: message });
        return { status: "paused", detail: message };
      }
    }
    const unboundEffect = skillRunReceipts
      .flatMap((receipt) => receipt.effects)
      .find((effect) => {
        if (effect.kind === "model-generate") return false;
        if (effect.kind === "browser-read") return browserTarget.kind !== "target";
        if (effect.kind === "browser-write") return browserAction.kind !== "action";
        if (effect.kind === "files-read") return !runHasProject;
        if (effect.kind === "computer-act") return !computerTarget;
        return true;
      });
    if (unboundEffect) {
      const message = `${runSkills.find((skill) => skill.effects.some((effect) => effect.id === unboundEffect.id))?.name || "This skill"} needs ${unboundEffect.label.toLowerCase()}, but this request did not select that exact capability.`;
      setBotFeedback(botId, { error: message });
      return { status: "paused", detail: message };
    }

    const runId = options.runId || `run-${crypto.randomUUID()}`;
    try {
      updateExecutionStates((current) => startBotExecution(current, botId, runId, runEngine));
    } catch (reason) {
      setBotFeedback(botId, { error: reason instanceof Error ? reason.message : String(reason) });
      const message = reason instanceof Error ? reason.message : String(reason);
      return { status: "paused", detail: message };
    }
    canceledRunIds.current.delete(runId);
    setPromptsByBotId((current) => ({ ...current, [botId]: "" }));
    const startedAt = Date.now();
    const events: ProviderRunEvent[] = [{
      runId,
      sequence: 1,
      eventType: "queued",
      provider: runEngine.provider,
      model: runEngine.model,
      message: "Run queued locally",
      createdAt: new Date().toISOString(),
    }];
    let runSnapshot: NonNullable<typeof workspace> | null = null;
    let receiptRecorded = false;
    let browserAutoApprovalSource: "bot-safe-mode" | "bot-domain-scope" | null = null;
    let handedOffForApproval = false;
    let completedTools: Array<{ toolId: string; toolName: string }> = [];
    const providerInvocation = { started: false };
    try {
      await changeBotStatus(botId, "thinking", "Understanding your request");
      const withTrigger = options.appendUser === false
        ? runWorkspace
        : await appendThreadMessage(runWorkspace, submitted);
      if (options.appendUser !== false) applyWorkspace(botId, threadId, withTrigger);
      runSnapshot = await beginLocalRun(withTrigger, "artifact-plan-ship-local", runId, runEngine);
      applyWorkspace(botId, threadId, runSnapshot);
      if (canceledRunIds.current.has(runId)) throw new Error("Run canceled by user.");
      if (localFileIntent?.kind === "list-folder") {
        await changeBotStatus(botId, "working", localFileIntent.purpose === "desktop"
          ? "Reading your Desktop"
          : "Reading the selected folder");
        const onRunEvent = (event: ProviderRunEvent) => {
          consumeRunEvent(botId, event, events);
        };
        const listing = await readLocalFolderListing(runId, onRunEvent);
        if (listing.status !== "completed" || !listing.context[0]) {
          throw new Error(events.at(-1)?.message || "Codelit could not list the selected folder.");
        }
        completedTools = listing.completedTools;
        const finalAnswer = listing.context[0];
        await revealValidatedAnswer(botId, runId, finalAnswer);
        updateExecutionStates((current) => commitBotExecution(current, botId, runId));
        let completed = await appendThreadMessage(runSnapshot, finalAnswer, "assistant");
        const result = localFolderProviderResult(runId, finalAnswer, Date.now() - startedAt);
        completed = await recordProviderRun(
          completed,
          "artifact-plan-ship-local",
          result,
          events,
          {
            botId,
            botVersion: runBot.currentVersion,
            permissionSnapshot: runBot.spec.permissionPolicy,
            folderName: runWorkspace.workspaceFolder?.path.split("/").pop() || null,
            scope: "visible-top-level-names",
            completedTools,
          },
          `Listed ${runWorkspace.workspaceFolder?.path.split("/").pop() || "the selected folder"} locally`,
        );
        receiptRecorded = true;
        applyWorkspace(botId, threadId, completed);
        await changeBotStatus(botId, "done", "Folder checked locally");
        return {
          status: "completed",
          detail: "Visible top-level names were listed locally.",
          answer: finalAnswer,
          runId,
        };
      }
      if (browserTarget.kind === "target") {
        if (browserAction.kind === "action") {
          const requestedAction = browserAction.request;
          const safeObjective = requestedAction.action === "type"
            ? `Type ${requestedAction.valueLength} characters into ${requestedAction.targetLabel} on ${requestedAction.host}`
            : requestedAction.action === "download"
              ? `Download ${requestedAction.targetLabel} from ${requestedAction.host}`
            : `Click ${requestedAction.targetLabel} on ${requestedAction.host}`;
          await changeBotStatus(botId, "thinking", `Preparing ${requestedAction.host} action`);
          const onRunEvent = (event: ProviderRunEvent) => {
            consumeRunEvent(botId, event, events);
          };
          const prepared = await prepareNativeToolApproval(
            runId,
            ["Browser act"],
            safeObjective,
            {
              "Browser act": {
                url: requestedAction.url,
                objective: safeObjective,
                allowedDomains: [requestedAction.host],
                action: requestedAction.action,
                target: requestedAction.target,
                ...(requestedAction.value === undefined ? {} : { value: requestedAction.value }),
              },
            },
            onRunEvent,
            new AbortController().signal,
            { sessionId: browserSessionId(runId), projectId: botId },
          );
          if (!prepared.approvalSha256) {
            throw new Error("The exact browser action could not be bound for approval.");
          }
          const pending: PendingBrowserRun = {
            approvalId: `approval-${runId}`,
            runId,
            botId,
            botVersion: runBot.currentVersion,
            request: safeObjective,
            target: browserTarget,
            engine: runEngine,
            selectionMode: runSelectionMode,
            meteredFallbackAuthorized: runMeteredFallbackAuthorized,
            approvalMode: "ask",
            approvalSource: "pending-user",
            memories: runMemories,
            memorySnapshotHash,
            skills: runSkills,
            skillVersions,
            browserAction: {
              action: requestedAction.action,
              target: requestedAction.target,
              targetLabel: requestedAction.targetLabel,
              valueLength: requestedAction.valueLength,
              approvalSha256: prepared.approvalSha256,
              preview: prepared.evidence,
            },
          };
          runSnapshot = await saveLocalRunCheckpoint(runSnapshot, runId, {
            stepIndex: 0,
            handoff: safeObjective,
            priorSteps: [],
            runContext: { kind: "browser-action", ...pending },
          });
          runSnapshot = await recordLocalRunApproval(runSnapshot, {
            id: pending.approvalId,
            runId,
            stepIndex: 0,
            status: "awaiting",
            body: {
              kind: "browser-action",
              ...pending,
              decisionSource: "pending-user",
              safetyClass: browserActionScope(pending.browserAction!),
            },
          });
          applyWorkspace(botId, threadId, runSnapshot);
          await changeBotStatus(botId, "waiting", `Waiting to act on ${requestedAction.host}`);
          updateExecutionStates((current) => waitForBotBrowserApproval(current, pending));
          handedOffForApproval = true;
          return {
            status: "approval-required",
            detail: `Approval is required for the exact ${requestedAction.host} action.`,
            runId,
          };
        }
        const autoApprovalSource = botBrowserAutoApprovalSource(
          runBot.spec.permissionPolicy,
          "browser-read",
          browserTarget,
        );
        const autoApprove = autoApprovalSource !== null;
        browserAutoApprovalSource = autoApprovalSource;
        const pending: PendingBrowserRun = {
          approvalId: `approval-${runId}`,
          runId,
          botId,
          botVersion: runBot.currentVersion,
          request: submitted,
          target: browserTarget,
          engine: runEngine,
          selectionMode: runSelectionMode,
          meteredFallbackAuthorized: runMeteredFallbackAuthorized,
          approvalMode: runBot.spec.permissionPolicy.approvalMode,
          approvalSource: autoApprovalSource || "pending-user",
          memories: runMemories,
          memorySnapshotHash,
          skills: runSkills,
          skillVersions,
          ...(options.delegation ? { delegation: options.delegation } : {}),
        };
        runSnapshot = await saveLocalRunCheckpoint(runSnapshot, runId, {
          stepIndex: 0,
          handoff: submitted,
          priorSteps: [],
          runContext: { kind: "browser-read", ...pending },
        });
        runSnapshot = await recordLocalRunApproval(runSnapshot, {
          id: pending.approvalId,
          runId,
          stepIndex: 0,
          status: autoApprove ? "approved" : "awaiting",
          body: {
            kind: "browser-read",
            request: submitted,
            target: browserTarget,
            botId,
            botVersion: runBot.currentVersion,
            engine: runEngine,
            selectionMode: pending.selectionMode,
            meteredFallbackAuthorized: pending.meteredFallbackAuthorized,
            approvalMode: pending.approvalMode,
            memories: pending.memories,
            memorySnapshotHash: pending.memorySnapshotHash,
            skills: pending.skills,
            skillVersions: pending.skillVersions,
            ...(pending.delegation ? { delegation: pending.delegation } : {}),
            decisionSource: pending.approvalSource,
            safetyClass: "read-only-browser",
          },
        });
        applyWorkspace(botId, threadId, runSnapshot);
        if (canceledRunIds.current.has(runId)) throw new Error("Run canceled by user.");
        if (!autoApprove) {
          await changeBotStatus(botId, "waiting", `Waiting to read ${browserTarget.host}`);
          updateExecutionStates((current) => waitForBotBrowserApproval(current, pending));
          handedOffForApproval = true;
          return {
            status: "approval-required",
            detail: `Approval is required to read ${browserTarget.host}.`,
            runId,
          };
        }
        events.push({
          runId,
          sequence: events.length + 1,
          eventType: "message",
          provider: runEngine.provider,
          model: runEngine.model,
          message: autoApprovalSource === "bot-domain-scope"
            ? `Read-only access to ${browserTarget.host} approved by this bot's saved domain scope`
            : `Read-only access to ${browserTarget.host} auto-approved by bot safe mode`,
          createdAt: new Date().toISOString(),
        });
        runSnapshot = await saveLocalRunCheckpoint(runSnapshot, runId, {
          stepIndex: 1,
          handoff: submitted,
          priorSteps: [],
          gateApproved: true,
          runContext: { kind: "browser-read", ...pending },
        });
        applyWorkspace(botId, threadId, runSnapshot);
        if (canceledRunIds.current.has(runId)) throw new Error("Run canceled by user.");
        updateExecutionStates((current) => resumeBotExecution(
          waitForBotBrowserApproval(current, pending),
          botId,
          runId,
        ));
        const finished = await finishBrowserRun(
          pending,
          runBot,
          runSnapshot,
          events,
          providerInvocation,
        );
        runSnapshot = finished.completed;
        receiptRecorded = true;
        if (finished.result.status !== "completed" || !finished.result.structuredOutput) {
          throw new Error(finished.result.text);
        }
        await changeBotStatus(botId, "done", `Finished with ${providerLabel(providers, runEngine)}`);
        return {
          status: "completed",
          detail: finished.result.text.slice(0, 500),
          answer: finished.finalAnswer,
          runId,
        };
      }
      if (computerTarget) {
        await changeBotStatus(botId, "working", `Inspecting ${computerTarget.appName}`);
        const inspection = await inspectComputerApp(botId, computerTarget.bundleId);
        if (canceledRunIds.current.has(runId)) throw new Error("Run canceled by user.");
        const onRunEvent = (event: ProviderRunEvent) => {
          consumeRunEvent(botId, event, events);
        };
        const plannerResult = await runIntelligenceTask(
          runEngine,
          computerPlannerPrompt(submitted, inspection),
          onRunEvent,
          undefined,
          runId,
          runSelectionMode,
          runMeteredFallbackAuthorized,
          () => { providerInvocation.started = true; },
        );
        if (plannerResult.status !== "completed" || !plannerResult.structuredOutput) {
          throw new Error(plannerResult.text);
        }
        const plan = parseComputerPlan(plannerResult, inspection);
        if (plan.kind === "none") {
          await revealValidatedAnswer(botId, runId, plan.summary);
          updateExecutionStates((current) => commitBotExecution(current, botId, runId));
          let completed = await appendThreadMessage(runSnapshot, plan.summary, "assistant");
          completed = await recordProviderRun(
            completed,
            "artifact-plan-ship-local",
            plannerResult,
            events,
            {
              botId,
              botVersion: runBot.currentVersion,
              engine: runEngine,
              permissionSnapshot: runBot.spec.permissionPolicy,
              memorySnapshotHash,
              memoryIds: runMemories.map((memory) => memory.id),
              skillVersions,
              computer: {
                appName: computerTarget.appName,
                bundleId: computerTarget.bundleId,
                action: "none",
                status: "blocked-before-action",
              },
            },
            plan.summary,
          );
          receiptRecorded = true;
          applyWorkspace(botId, threadId, completed);
          await changeBotStatus(botId, "done", `Reviewed ${computerTarget.appName}`);
          return {
            status: "completed",
            detail: plan.summary.slice(0, 500),
            answer: plan.summary,
            runId,
          };
        }
        const pending: PendingComputerRun = {
          approvalId: `approval-${runId}`,
          runId,
          botId,
          botVersion: runBot.currentVersion,
          request: submitted,
          app: {
            bundleId: computerTarget.bundleId,
            appName: computerTarget.appName,
          },
          action: plan.action,
          proposedSummary: plan.summary,
          engine: runEngine,
          selectionMode: plannerResult.selectionMode,
          meteredFallbackAuthorized: plannerResult.meteredFallbackAuthorized,
          meteredProviderInvocationStarted: plannerResult.meteredProviderInvocationStarted,
          billingFallback: plannerResult.billingFallback,
          plannerDurationMs: plannerResult.durationMs,
          plannerCommandPath: plannerResult.commandPath,
          ...(plannerResult.version ? { plannerVersion: plannerResult.version } : {}),
          memorySnapshotHash,
          memoryIds: runMemories.map((memory) => memory.id),
          skillVersions,
        };
        runSnapshot = await saveLocalRunCheckpoint(runSnapshot, runId, {
          stepIndex: 0,
          handoff: submitted,
          priorSteps: [],
          runContext: { kind: "computer-action", ...pending },
        });
        runSnapshot = await recordLocalRunApproval(runSnapshot, {
          id: pending.approvalId,
          runId,
          stepIndex: 0,
          status: "awaiting",
          body: {
            kind: "computer-action",
            ...pending,
            decisionSource: "pending-user",
            safetyClass: "semantic-computer-action",
          },
        });
        applyWorkspace(botId, threadId, runSnapshot);
        await changeBotStatus(botId, "waiting", `Waiting to use ${computerTarget.appName}`);
        updateExecutionStates((current) => waitForBotComputerApproval(current, pending));
        handedOffForApproval = true;
        return {
          status: "approval-required",
          detail: `Approval is required for the ${computerTarget.appName} action.`,
          runId,
        };
      }
      await changeBotStatus(botId, "working", runHasProject ? "Planning with approved folder access" : "Working locally");
      if (canceledRunIds.current.has(runId)) throw new Error("Run canceled by user.");
      const basePrompt = buildBotPrompt(
        runBot,
        taskRequest,
        [],
        runMemories,
        runSkills,
        options.delegation,
        skillPreparation.promptContext,
      );
      let result: ProviderTaskResult;
      let agentLoop: { modelTurns: number; toolCalls: string[] } | undefined;
      {
        const connectedMcpServers = !options.routine && !options.delegation
          ? await listLocalMcpServers()
          : [];
        const loop = await runBotHarness({
          runBot,
          runSnapshot,
          runId,
          request: taskRequest,
          basePrompt,
          engine: runEngine,
          selectionMode: runSelectionMode,
          meteredFallbackAuthorized: runMeteredFallbackAuthorized,
          connectedMcpServers,
          events,
          providerInvocation,
        });
        result = loop.result;
        completedTools = loop.completedTools;
        agentLoop = { modelTurns: loop.modelTurns, toolCalls: loop.toolCalls };
        if (loop.mcpProposal) {
          const staged = await stageMcpHarnessApproval({
            loop,
            runBot,
            runSnapshot,
            runId,
            request: submitted,
            engine: runEngine,
            selectionMode: runSelectionMode,
            meteredFallbackAuthorized: runMeteredFallbackAuthorized,
            memories: runMemories,
            memorySnapshotHash,
            skills: runSkills,
            skillVersions,
            events,
          });
          runSnapshot = staged.snapshot;
          handedOffForApproval = true;
          return {
            status: "approval-required",
            detail: `Approval is required for the exact ${staged.pending.serverName} call.`,
            runId,
          };
        }
      }
      const recordedResult = result.status !== "completed"
        && completedTools.length > 0
        && runEngine.provider === "mlx"
        && localFileIntent?.kind === "describe-project"
        ? {
            ...result,
            text: `The project was read successfully and stayed on this Mac. ${result.text}`,
          }
        : result;
      let completed = runSnapshot;
      let finalAnswer: string | undefined;
      if (recordedResult.status === "completed" && recordedResult.structuredOutput) {
        finalAnswer = formatProviderFinalAnswer(recordedResult.structuredOutput);
        skillRunReceipts = completeBotSkillChecks(runSkills, skillRunReceipts, finalAnswer);
        if (!botSkillChecksPassed(skillRunReceipts)) {
          throw new Error("A selected skill did not produce its required output. Review the run receipt before retrying.");
        }
        await revealValidatedAnswer(botId, runId, finalAnswer);
        updateExecutionStates((current) => commitBotExecution(current, botId, runId));
        completed = await appendThreadMessage(runSnapshot, finalAnswer, "assistant");
      }
      completed = await recordProviderRun(
        completed,
        "artifact-plan-ship-local",
        recordedResult,
        events,
        {
          botId,
          botVersion: runBot.currentVersion,
          engine: runEngine,
          permissionSnapshot: runBot.spec.permissionPolicy,
          memorySnapshotHash,
          memoryIds: runMemories.map((memory) => memory.id),
          skillVersions,
          skillContracts: skillRunReceipts,
          projectName: runWorkspace.workspaceFolder?.path.split("/").pop() || null,
          completedTools,
          ...(agentLoop ? { agentLoop } : {}),
          ...(options.routine ? { routine: options.routine } : {}),
          ...(options.delegation ? { delegation: options.delegation } : {}),
        },
        finalAnswer,
      );
      receiptRecorded = true;
      applyWorkspace(botId, threadId, completed);
      if (recordedResult.status !== "completed" || !recordedResult.structuredOutput) {
        throw new Error(recordedResult.text);
      }
      if (!options.routine && !options.delegation) {
        await offerMemoryFromCompletedRun(runBot, submitted, runId).catch(() => undefined);
      }
      await changeBotStatus(botId, "done", `Finished with ${providerLabel(providers, runEngine)}`);
      return {
        status: "completed",
        detail: recordedResult.text.slice(0, 500),
        answer: finalAnswer,
        runId,
      };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const canceled = /cancel|stop/i.test(message);
      if (browserAction.kind === "action") {
        await discardPreparedLocalToolApproval(runId).catch(() => undefined);
      }
      if (runSnapshot && !receiptRecorded) {
        const failedResult: ProviderTaskResult = {
          runId,
          provider: runEngine.provider,
          model: runEngine.model,
          status: canceled ? "canceled" : "failed",
          text: message,
          durationMs: Date.now() - startedAt,
          commandPath: "local-policy-runtime",
          evidence: [],
          ...providerRunProvenance(
            runEngine,
            runSelectionMode,
            runMeteredFallbackAuthorized,
            providerInvocation.started,
          ),
        };
        try {
          const failed = await recordProviderRun(
            runSnapshot,
            "artifact-plan-ship-local",
            failedResult,
            events,
            {
              botId,
              botVersion: runBot.currentVersion,
              engine: runEngine,
              permissionSnapshot: runBot.spec.permissionPolicy,
              memorySnapshotHash,
              memoryIds: runMemories.map((memory) => memory.id),
              skillVersions,
              skillContracts: skillRunReceipts,
              ...(browserTarget.kind === "target" ? {
                approval: {
                  mode: browserAction.kind === "action" ? "ask" : runBot.spec.permissionPolicy.approvalMode,
                  decisionSource: browserAction.kind === "action" ? "user" : browserAutoApprovalSource || "user",
                  scope: browserAction.kind === "action"
                    ? browserAction.request.action === "download" ? "browser-download" : "typed-browser-action"
                    : "read-only-browser",
                },
                browser: {
                  host: browserTarget.host,
                  mode: browserAction.kind === "action" ? "write" : "read",
                  status: failedResult.status,
                  ...(browserAction.kind === "action" ? {
                    action: browserAction.request.action,
                    target: browserAction.request.targetLabel,
                    valueLength: browserAction.request.valueLength,
                  } : {}),
                },
              } : {
                projectName: runWorkspace.workspaceFolder?.path.split("/").pop() || null,
              }),
              completedTools,
              ...(options.routine ? { routine: options.routine } : {}),
              ...(options.delegation ? { delegation: options.delegation } : {}),
            },
          );
          applyWorkspace(botId, threadId, failed);
        } catch {
          // The original run failure remains the actionable message.
        }
      }
      setBotFeedback(botId, { error: message, notice: null });
      await changeBotStatus(botId, canceled ? "paused" : "blocked", message)
        .catch(() => undefined);
      return {
        status: canceled ? "paused" : "failed",
        detail: message.slice(0, 500),
        runId,
      };
    } finally {
      if (!handedOffForApproval) {
        if (browserAutoApprovalSource) {
          const waiter = browserWaiters.current.get(runId);
          if (waiter) {
            window.clearInterval(waiter.interval);
            browserWaiters.current.delete(runId);
          }
          browserSessions.current.delete(runId);
        }
        updateExecutionStates((current) => finishBotExecution(current, botId, runId));
        canceledRunIds.current.delete(runId);
      }
    }
  };

  submitTaskRef.current = submit;

  const completeActiveGoal = async () => {
    if (!bot || bot.spec.goal.status === "completed") return;
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      const updatedAt = new Date().toISOString();
      const updated = await updateLocalBotGoal(bot.id, {
        ...bot.spec.goal,
        status: "completed",
        nextAction: "Waiting for a new goal.",
        updatedAt,
      }, bot.currentVersion);
      replaceBot(updated);
      setBotFeedback(bot.id, { notice: "Goal completed" });
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const enableRoutine = async (schedule: LocalSchedule) => {
    if (!bot || routineAction) return;
    const priorRoutineState = routineStateForBot(schedules, eventRoutines, bot.id);
    let backgroundAuthorized = false;
    let scheduleEnabled = false;
    setRoutineAction(schedule.id);
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      const service = backgroundService?.status === "enabled"
        ? backgroundService
        : await setBackgroundWorkEnabled(true);
      setBackgroundService(service);
      if (service.status === "requires-approval") {
        await openBackgroundWorkSettings();
        setBotFeedback(bot.id, { notice: "Allow Codelit in Login Items, then start this routine again." });
        return;
      }
      if (service.status !== "enabled") throw new Error(service.detail);
      const updated = await updateLocalBotRoutines(bot.id, priorRoutineState.ids, true);
      backgroundAuthorized = true;
      const saved = await setLocalScheduleEnabled(schedule.id, true);
      scheduleEnabled = true;
      const nextSchedules = schedules.map((candidate) => candidate.id === saved.id ? saved : candidate);
      replaceBot(await updateLocalBotStatus(
        updated.id,
        "watching",
        `${schedule.title} ${routineTiming(saved)}`,
      ));
      setSchedules(nextSchedules);
      setBotFeedback(bot.id, { notice: `${schedule.title} will run ${routineTiming(saved)}.` });
    } catch (reason) {
      if (scheduleEnabled) await setLocalScheduleEnabled(schedule.id, false).catch(() => undefined);
      if (backgroundAuthorized) {
        await updateLocalBotRoutines(
          bot.id,
          priorRoutineState.ids,
          priorRoutineState.enabled,
        ).then(replaceBot).catch(() => undefined);
      }
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason) });
      await refreshRoutineState().catch(() => undefined);
    } finally {
      setRoutineAction(null);
    }
  };

  const pauseRoutine = async (schedule: LocalSchedule) => {
    if (!bot || routineAction) return;
    setRoutineAction(schedule.id);
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      const saved = await setLocalScheduleEnabled(schedule.id, false);
      const nextSchedules = schedules.map((candidate) => candidate.id === saved.id ? saved : candidate);
      const nextRoutineState = routineStateForBot(nextSchedules, eventRoutines, bot.id);
      const updated = await updateLocalBotRoutines(
        bot.id,
        nextRoutineState.ids,
        nextRoutineState.enabled,
      );
      replaceBot(await updateLocalBotStatus(
        updated.id,
        nextRoutineState.enabled ? "watching" : "sleeping",
        nextRoutineState.latestStatus,
      ));
      setSchedules(nextSchedules);
      setBotFeedback(bot.id, { notice: `${schedule.title} paused` });
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason) });
      await refreshRoutineState().catch(() => undefined);
    } finally {
      setRoutineAction(null);
    }
  };

  const removeRoutine = async (schedule: LocalSchedule) => {
    if (!bot || routineAction) return;
    setRoutineAction(schedule.id);
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      await deleteLocalSchedule(schedule.id);
      const nextSchedules = schedules.filter((candidate) => candidate.id !== schedule.id);
      const nextRoutineState = routineStateForBot(nextSchedules, eventRoutines, bot.id);
      const updated = await updateLocalBotRoutines(
        bot.id,
        nextRoutineState.ids,
        nextRoutineState.enabled,
      );
      replaceBot(await updateLocalBotStatus(
        updated.id,
        nextRoutineState.enabled ? "watching" : "sleeping",
        nextRoutineState.latestStatus,
      ));
      setSchedules(nextSchedules);
      setBotFeedback(bot.id, { notice: `${schedule.title} removed` });
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason) });
      await refreshRoutineState().catch(() => undefined);
    } finally {
      setRoutineAction(null);
    }
  };

  const enableEventRoutine = async (routine: BotEventRoutine) => {
    if (!bot || !workspace || routineAction) return;
    const priorRoutineState = routineStateForBot(schedules, eventRoutines, bot.id);
    let backgroundAuthorized = false;
    let routineEnabled = false;
    setRoutineAction(routine.id);
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      if (!workspace.workspaceFolder?.accessValidated) {
        throw new Error("Choose a project folder before starting this routine.");
      }
      const service = backgroundService?.status === "enabled"
        ? backgroundService
        : await setBackgroundWorkEnabled(true);
      setBackgroundService(service);
      if (service.status === "requires-approval") {
        await openBackgroundWorkSettings();
        setBotFeedback(bot.id, { notice: "Allow Codelit in Login Items, then start this routine again." });
        return;
      }
      if (service.status !== "enabled") throw new Error(service.detail);
      const fingerprint = await readLocalProjectFingerprint();
      const updated = await updateLocalBotRoutines(bot.id, priorRoutineState.ids, true);
      backgroundAuthorized = true;
      const saved = await setLocalEventRoutineEnabled(routine.id, true, fingerprint);
      routineEnabled = true;
      const nextEventRoutines = eventRoutines.map((candidate) => candidate.id === saved.id ? saved : candidate);
      replaceBot(await updateLocalBotStatus(updated.id, "watching", `Watching ${routine.title}`));
      setEventRoutines(nextEventRoutines);
      const fileCount = `${fingerprint.fileCount}${fingerprint.truncated ? "+" : ""}`;
      setBotFeedback(bot.id, { notice: `Watching ${fileCount} project files for a stable change.` });
    } catch (reason) {
      if (routineEnabled) await setLocalEventRoutineEnabled(routine.id, false).catch(() => undefined);
      if (backgroundAuthorized) {
        await updateLocalBotRoutines(
          bot.id,
          priorRoutineState.ids,
          priorRoutineState.enabled,
        ).then(replaceBot).catch(() => undefined);
      }
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason) });
      await refreshRoutineState().catch(() => undefined);
    } finally {
      setRoutineAction(null);
    }
  };

  const pauseEventRoutine = async (routine: BotEventRoutine) => {
    if (!bot || routineAction) return;
    setRoutineAction(routine.id);
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      const saved = await setLocalEventRoutineEnabled(routine.id, false);
      const nextEventRoutines = eventRoutines.map((candidate) => candidate.id === saved.id ? saved : candidate);
      const nextRoutineState = routineStateForBot(schedules, nextEventRoutines, bot.id);
      const updated = await updateLocalBotRoutines(
        bot.id,
        nextRoutineState.ids,
        nextRoutineState.enabled,
      );
      replaceBot(await updateLocalBotStatus(
        updated.id,
        nextRoutineState.enabled ? "watching" : "sleeping",
        nextRoutineState.latestStatus,
      ));
      setEventRoutines(nextEventRoutines);
      setBotFeedback(bot.id, { notice: `${routine.title} paused` });
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason) });
      await refreshRoutineState().catch(() => undefined);
    } finally {
      setRoutineAction(null);
    }
  };

  const removeEventRoutine = async (routine: BotEventRoutine) => {
    if (!bot || routineAction) return;
    setRoutineAction(routine.id);
    setBotFeedback(bot.id, { error: null, notice: null });
    try {
      await deleteLocalEventRoutine(routine.id);
      const nextEventRoutines = eventRoutines.filter((candidate) => candidate.id !== routine.id);
      const nextRoutineState = routineStateForBot(schedules, nextEventRoutines, bot.id);
      const updated = await updateLocalBotRoutines(
        bot.id,
        nextRoutineState.ids,
        nextRoutineState.enabled,
      );
      replaceBot(await updateLocalBotStatus(
        updated.id,
        nextRoutineState.enabled ? "watching" : "sleeping",
        nextRoutineState.latestStatus,
      ));
      setEventRoutines(nextEventRoutines);
      setBotFeedback(bot.id, { notice: `${routine.title} removed` });
    } catch (reason) {
      setBotFeedback(bot.id, { error: reason instanceof Error ? reason.message : String(reason) });
      await refreshRoutineState().catch(() => undefined);
    } finally {
      setRoutineAction(null);
    }
  };

  useEffect(() => {
    if (!autoStartBotId
      || !bot
      || !workspace
      || bot.id !== autoStartBotId
      || !engine
      || runState !== "idle"
      || hasAnyActiveRun
      || autoStartedBots.current.has(bot.id)) return;
    const runBot = bot;
    const runWorkspace = workspace;
    autoStartedBots.current.add(runBot.id);
    setAutoStartBotId(null);
    const firstMove = [
      `Begin your goal now: ${runBot.spec.goal.outcome}`,
      "Take the smallest useful read-only step with the approved context available.",
      "If one required input is missing, ask for exactly that one thing.",
    ].join("\n");
    void submitTaskRef.current?.(firstMove, {
      bot: runBot,
      workspace: runWorkspace,
      engine,
      appendUser: false,
    });
  }, [autoStartBotId, bot, engine, hasAnyActiveRun, runState, workspace]);

  useEffect(() => {
    if (!catalogReady || !schedulesAvailable || backgroundService?.status !== "enabled") return;
    const owner = `bots-${crypto.randomUUID()}`;
    let disposed = false;

    const notify = async (
      claim: ClaimedScheduleOccurrence,
      botId: string,
      outcome: BotTaskOutcome,
    ) => {
      const state = outcome.status === "completed"
        ? "completed"
        : outcome.status === "approval-required"
          ? "needs approval"
          : "paused";
      await showLocalNotification({
        threadId: claim.schedule.threadId,
        artifactId: botId,
        artifactKind: "bot",
        runId: claim.runId,
        title: `${claim.schedule.title} ${state}`,
        body: outcome.detail.slice(0, 220),
      }).catch(() => undefined);
    };

    const notifyEventRoutine = async (
      claim: ClaimedEventRoutineOccurrence,
      outcome: BotTaskOutcome,
    ) => {
      const state = outcome.status === "completed"
        ? "completed"
        : outcome.status === "approval-required"
          ? "needs approval"
          : "paused";
      await showLocalNotification({
        threadId: claim.routine.threadId,
        artifactId: claim.routine.botId,
        artifactKind: "bot",
        runId: claim.runId,
        title: `${claim.routine.title} ${state}`,
        body: outcome.detail.slice(0, 220),
      }).catch(() => undefined);
    };

    const runClaim = async (claim: ClaimedScheduleOccurrence) => {
      scheduleWorkerActive.current = true;
      let botId: string | null = null;
      let heartbeat = 0;
      let occurrenceStarted = false;
      let occurrenceFinished = false;
      let leaseFailure: Error | null = null;
      try {
        await markScheduleOccurrenceRunning(claim.idempotencyKey, claim.claimToken);
        occurrenceStarted = true;
        const routine = readBotRoutineSnapshot(claim.schedule);
        if (!routine) throw new Error("This routine snapshot is invalid. Remove it and create the routine again.");
        botId = routine.botId;
        const context = await openLocalBotContext(routine.botId);
        if (!context.bot.spec.routineIds.includes(claim.schedule.id)) {
          throw new Error("This routine is no longer attached to its bot.");
        }
        const pinnedProvider = providers.find((candidate) => candidate.id === claim.schedule.provider);
        if (!pinnedProvider) throw new Error("The routine's intelligence provider is no longer available.");
        const pinnedModel = pinnedProvider.models.find((candidate) => candidate.id === claim.schedule.model);
        if (!pinnedProvider.canRun || pinnedModel?.status !== "ready") {
          throw new Error("The routine's intelligence provider needs setup or sign-in.");
        }

        const guard = async () => {
          const permitted = await scheduleExecutionPermitted(claim.idempotencyKey, claim.claimToken);
          if (!permitted) throw new Error("This routine stopped because its schedule or background access changed.");
          await renewScheduleOccurrenceLease(claim.idempotencyKey, claim.claimToken);
        };
        await guard();
        heartbeat = window.setInterval(() => {
          if (leaseFailure) return;
          void guard().catch((reason) => {
            leaseFailure = reason instanceof Error ? reason : new Error(String(reason));
            void cancelIntelligenceTask(claim.runId).catch(() => undefined);
          });
        }, 15_000);

        const attempted = await submitTaskRef.current?.(routine.prompt, {
          bot: context.bot,
          workspace: context.workspace,
          engine: { provider: pinnedProvider.id, model: claim.schedule.model },
          runId: claim.runId,
          appendUser: false,
          routine: {
            id: claim.schedule.id,
            title: claim.schedule.title,
            scheduledFor: claim.scheduledFor,
          },
        }) || { status: "paused", detail: "The bot runner is not ready." };
        const outcome: BotTaskOutcome = attempted.status === "failed"
          && /quota|sign.?in|provider|engine|setup|permission/i.test(attempted.detail)
          ? { ...attempted, status: "paused" }
          : attempted;
        if (leaseFailure) throw leaseFailure;
        await finishScheduleOccurrence(
          claim.idempotencyKey,
          claim.claimToken,
          outcome.status,
          outcome.detail,
        );
        occurrenceFinished = true;
        await notify(claim, routine.botId, outcome);
        if (outcome.status === "completed") {
          const nextSchedule = (await listLocalSchedules())
            .find((candidate) => candidate.id === claim.schedule.id && candidate.enabled && candidate.nextDueAt);
          if (nextSchedule) {
            replaceBot(await updateLocalBotStatus(
              routine.botId,
              "watching",
              `${nextSchedule.title} ${routineTiming(nextSchedule)}`,
            ));
          }
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        const outcome: BotTaskOutcome = {
          status: /permission|background|provider|engine|sign.?in|quota|attached/i.test(message)
            ? "paused"
            : "failed",
          detail: message.slice(0, 500),
        };
        if (occurrenceStarted && !occurrenceFinished && !leaseFailure) {
          await finishScheduleOccurrence(
            claim.idempotencyKey,
            claim.claimToken,
            outcome.status,
            outcome.detail,
          ).catch(() => undefined);
        }
        if (botId) {
          await updateLocalBotStatus(botId, "blocked", outcome.detail).then(replaceBot).catch(() => undefined);
          await notify(claim, botId, outcome);
        }
      } finally {
        if (heartbeat) window.clearInterval(heartbeat);
        scheduleWorkerActive.current = false;
        if (!disposed) await refreshRoutineState().catch(() => undefined);
      }
    };

    const runEventClaim = async (claim: ClaimedEventRoutineOccurrence) => {
      scheduleWorkerActive.current = true;
      let heartbeat = 0;
      let occurrenceStarted = false;
      let occurrenceFinished = false;
      let leaseFailure: Error | null = null;
      try {
        await markEventRoutineOccurrenceRunning(claim.idempotencyKey, claim.claimToken);
        occurrenceStarted = true;
        const context = await openLocalBotContext(claim.routine.botId);
        if (!context.bot.spec.routineIds.includes(claim.routine.id)) {
          throw new Error("This routine is no longer attached to its bot.");
        }
        const pinnedProvider = providers.find((candidate) => candidate.id === claim.routine.provider);
        if (!pinnedProvider) throw new Error("The routine's intelligence provider is no longer available.");
        const pinnedModel = pinnedProvider.models.find((candidate) => candidate.id === claim.routine.model);
        if (!pinnedProvider.canRun || pinnedModel?.status !== "ready") {
          throw new Error("The routine's intelligence provider needs setup or sign-in.");
        }
        const [currentMemories, currentSkills] = await Promise.all([
          listLocalBotMemories(claim.routine.botId),
          listLocalBotSkills(),
        ]);
        if (await botMemorySnapshotHash(currentMemories) !== claim.routine.memorySnapshotHash) {
          throw new Error("Approved memory changed. Review and start this routine again.");
        }
        const selectedSkills = Object.entries(claim.routine.skillVersions).map(([skillId, version]) => (
          currentSkills.find((skill) => skill.id === skillId
            && skill.version === version
            && ["packaged", "reviewed"].includes(skill.trustState))
        ));
        if (selectedSkills.some((skill) => !skill)) {
          throw new Error("A trusted skill changed. Review and start this routine again.");
        }
        const guard = async () => {
          const permitted = await eventRoutineExecutionPermitted(claim.idempotencyKey, claim.claimToken);
          if (!permitted) throw new Error("This routine stopped because its trigger or background access changed.");
          await renewEventRoutineOccurrenceLease(claim.idempotencyKey, claim.claimToken);
        };
        await guard();
        heartbeat = window.setInterval(() => {
          if (leaseFailure) return;
          void guard().catch((reason) => {
            leaseFailure = reason instanceof Error ? reason : new Error(String(reason));
            void cancelIntelligenceTask(claim.runId).catch(() => undefined);
          });
        }, 15_000);
        const reviewedBot: LocalBotRecord = {
          ...context.bot,
          currentVersion: claim.routine.botSnapshot.version,
          name: claim.routine.botSnapshot.name,
          spec: {
            ...claim.routine.botSnapshot,
            autonomyPolicy: {
              ...claim.routine.botSnapshot.autonomyPolicy,
              maxActionsPerRun: Math.min(
                claim.routine.botSnapshot.autonomyPolicy.maxActionsPerRun,
                claim.routine.budget.maxActions,
              ),
            },
          },
        };
        const attempted = await submitTaskRef.current?.(claim.routine.prompt, {
          bot: reviewedBot,
          workspace: context.workspace,
          memories: currentMemories,
          skills: selectedSkills as BotSkill[],
          engine: { provider: pinnedProvider.id, model: claim.routine.model },
          runId: claim.runId,
          appendUser: false,
          routine: {
            id: claim.routine.id,
            title: claim.routine.title,
            scheduledFor: claim.observedAt,
          },
        }) || { status: "paused", detail: "The bot runner is not ready." };
        const outcome: BotTaskOutcome = attempted.status === "failed"
          && /quota|sign.?in|provider|engine|setup|permission/i.test(attempted.detail)
          ? { ...attempted, status: "paused" }
          : attempted;
        if (leaseFailure) throw leaseFailure;
        await finishEventRoutineOccurrence(
          claim.idempotencyKey,
          claim.claimToken,
          outcome.status,
          outcome.detail,
        );
        occurrenceFinished = true;
        await notifyEventRoutine(claim, outcome);
        if (outcome.status === "completed") {
          replaceBot(await updateLocalBotStatus(
            claim.routine.botId,
            "watching",
            `Watching ${claim.routine.title}`,
          ));
        }
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        const outcome: BotTaskOutcome = {
          status: /permission|background|provider|engine|sign.?in|quota|attached|memory|skill/i.test(message)
            ? "paused"
            : "failed",
          detail: message.slice(0, 500),
        };
        if (occurrenceStarted && !occurrenceFinished && !leaseFailure) {
          await finishEventRoutineOccurrence(
            claim.idempotencyKey,
            claim.claimToken,
            outcome.status,
            outcome.detail,
          ).catch(() => undefined);
        }
        await updateLocalBotStatus(
          claim.routine.botId,
          "blocked",
          outcome.detail,
        ).then(replaceBot).catch(() => undefined);
        await notifyEventRoutine(claim, outcome);
      } finally {
        if (heartbeat) window.clearInterval(heartbeat);
        scheduleWorkerActive.current = false;
        if (!disposed) await refreshRoutineState().catch(() => undefined);
      }
    };

    const checkDueRoutines = async () => {
      if (disposed
        || scheduleWorkerActive.current
        || Object.values(executionStatesRef.current).some((state) => state.runState !== "idle")) return;
      try {
        const probe = await probeBackgroundService();
        if (disposed) return;
        setBackgroundService(probe);
        if (probe.status !== "enabled") return;
        await deliverDueDailyDigest().catch((reason) => {
          if (!disposed) setGlobalError(reason instanceof Error ? reason.message : String(reason));
        });
        const claims = await claimDueLocalSchedules(owner, 1, navigator.onLine);
        if (!disposed && claims[0]) {
          await runClaim(claims[0]);
          return;
        }
        if (!eventRoutines.some((routine) => routine.enabled)) return;
        const fingerprint = await readLocalProjectFingerprint();
        const eventClaims = await claimChangedEventRoutines(owner, fingerprint, 1);
        if (!disposed && eventClaims[0]) await runEventClaim(eventClaims[0]);
      } catch (reason) {
        if (!disposed) setGlobalError(reason instanceof Error ? reason.message : String(reason));
      }
    };

    const onWake = () => void checkDueRoutines();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void checkDueRoutines();
    };
    const timer = window.setInterval(() => void checkDueRoutines(), 30_000);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onVisibility);
    void checkDueRoutines();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [backgroundService?.status, catalogReady, eventRoutines, providers, refreshRoutineState, schedulesAvailable]);

  const cancel = async () => {
    if (!bot) return;
    const botId = bot.id;
    const current = botExecutionState(executionStatesRef.current, botId);
    const runId = current.activeRunId;
    if (!runId || current.runState !== "running") return;
    canceledRunIds.current.add(runId);
    updateExecutionStates((current) => cancelBotExecution(current, botId, runId));
    cancelQueuedBrowserLane(runId);
    const waiter = browserWaiters.current.get(runId);
    if (waiter) {
      window.clearInterval(waiter.interval);
      browserWaiters.current.delete(runId);
      waiter.reject(new Error("Run canceled by user."));
    }
    try {
      await cancelIntelligenceTask(runId);
    } catch (reason) {
      setBotFeedback(botId, { error: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const cancelDelegation = async (delegation: LocalBotDelegation) => {
    if (cancelingDelegationId) return;
    setCancelingDelegationId(delegation.id);
    canceledDelegationIds.current.add(delegation.id);
    try {
      replaceDelegation(await cancelLocalBotDelegation(delegation.id));
      await Promise.allSettled(delegation.targets.flatMap((target) => {
        if (!target.runId || target.status !== "running") return [];
        canceledRunIds.current.add(target.runId);
        cancelQueuedBrowserLane(target.runId);
        updateExecutionStates((current) => cancelBotExecution(
          current,
          target.botId,
          target.runId!,
        ));
        return [cancelIntelligenceTask(target.runId)];
      }));
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason));
      await refreshDelegations().catch(() => undefined);
    } finally {
      setCancelingDelegationId(null);
    }
  };

  if (!catalog || !bot || !workspace) {
    const startupFailed = Boolean(globalError);
    return (
      <main className="bots-loading" aria-busy={!startupFailed}>
        <section
          className="bots-startup-state"
          data-state={startupFailed ? "error" : "loading"}
          role={startupFailed ? "alert" : "status"}
        >
          <span className="bots-mark"><Bot size={19} /></span>
          <strong>{startupFailed ? "Codelit couldn't open your bots" : "Opening your bots..."}</strong>
          {startupFailed ? <p>{globalError}</p> : null}
          {startupFailed ? (
            <button type="button" className="bots-primary-button" onClick={retryOpenBots}>
              Try again
            </button>
          ) : null}
        </section>
      </main>
    );
  }

  const activeAvatar = avatarForBot(bot);

  return (
    <div
      className="bots-app"
      data-browser-active={activeBrowserRunId ? "true" : "false"}
      data-sidebar={sidebarOpen ? "open" : "closed"}
    >
      <aside
        className="bots-sidebar"
        aria-label="Bots"
        aria-hidden={!sidebarOpen || overlayOpen}
        inert={!sidebarOpen || overlayOpen}
      >
        <header>
          <div className="bots-brand" aria-label="Codelit Bots">
            <span className="bots-mark"><Bot size={16} /></span>
            <span>Codelit</span>
          </div>
          <button className="bots-icon-button" onClick={() => setSidebarOpen(false)} aria-label="Collapse sidebar" title="Collapse sidebar">
            <PanelLeftClose size={17} />
          </button>
        </header>

        <button className="bots-new-button" onClick={() => {
          setNewBotName("");
          setNewBotAvatar(defaultBotAvatar(`new-bot-${Date.now()}`));
          setNewBotOpen(true);
        }} disabled={creating}>
          <Plus size={16} /> New bot
        </button>

        <button
          type="button"
          className={`bots-activity-button${activityOpen ? " active" : ""}`}
          onClick={() => {
            setActivityOpen(true);
            if (window.innerWidth < 900) setSidebarOpen(false);
          }}
          aria-current={activityOpen ? "page" : undefined}
        >
          <Activity size={16} />
          <span>All activity</span>
          {activeDelegationCount > 0 && <small>{activeDelegationCount}</small>}
        </button>

        <label className="bots-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Search bots</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" />
        </label>

        <section className="bots-roster">
          <span className="bots-section-label">Bots</span>
          {filteredBots.map((candidate) => (
            <BotRosterButton
              key={candidate.id}
              bot={candidate}
              active={candidate.id === bot.id}
              execution={botExecutionState(executionStates, candidate.id)}
              onChoose={chooseBot}
            />
          ))}
          {!filteredBots.length && <p className="bots-empty-search">No bots found.</p>}
        </section>

        <button className="bots-profile" onClick={() => openSettings("general")}>
          <span className="bots-profile-mark">M</span>
          <span><strong>Local workspace</strong><small>{autonomyPolicy ? autonomySidebarStatus(autonomyPolicy) : "Private on this Mac"}</small></span>
          <Settings2 size={15} />
        </button>
      </aside>

      {sidebarOpen && (
        <button
          className="bots-sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
          aria-hidden={overlayOpen || undefined}
          inert={overlayOpen}
        />
      )}

      <main
        className={`bots-main${activeBrowserRunId ? " browser-active" : ""}${activityOpen ? " activity-open" : ""}${newBotOpen ? " new-bot-open" : ""}${settingsOpen ? " settings-open" : ""}${profileOpen ? " profile-open" : ""}`}
        aria-hidden={overlayOpen || undefined}
        inert={overlayOpen}
      >
        <header className="bots-topbar">
          <div>
            {!sidebarOpen && (
              <button className="bots-icon-button" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar" title="Open sidebar">
                <Menu size={18} />
              </button>
            )}
            {activityOpen ? (
              <div className="bots-activity-title">
                <span className="bots-mark"><Activity size={15} /></span>
                <span className="bots-title"><strong>All activity</strong><small>Routines and handoffs</small></span>
              </div>
            ) : (
              <button
                type="button"
                className="bot-identity-button"
                onClick={openProfileEditor}
                aria-haspopup="dialog"
                aria-expanded={profileOpen}
                aria-label={`Customize ${bot.name}`}
              >
                <BotAvatar avatar={activeAvatar} size="medium" />
                <span className="bots-title"><strong>{bot.name}</strong><small>{bot.status}</small></span>
                <Pencil size={13} aria-hidden="true" />
              </button>
            )}
            {!activityOpen && (
              <button
                type="button"
                className={`bot-team-button${activeGroupMembers.length ? " active" : ""}`}
                onClick={openGroupEditor}
                disabled={groupOwnerBotId !== activeBotId}
                aria-haspopup="dialog"
                aria-expanded={groupOpen}
                aria-label={activeGroupMembers.length
                  ? `Manage ${activeGroupMembers.length} conversation ${activeGroupMembers.length === 1 ? "teammate" : "teammates"}`
                  : "Add conversation teammates"}
                title={activeGroupMembers.length ? "Conversation teammates" : "Add teammates"}
              >
                <span className="bot-team-avatars" aria-hidden="true">
                  {activeGroupMembers.length ? activeGroupMembers.map((member) => (
                    <BotAvatar key={member.id} avatar={avatarForBot(member)} size="small" />
                  )) : <Users size={15} />}
                </span>
                <span className="bot-team-label">
                  {activeGroupMembers.length
                    ? `${activeGroupMembers.length} ${activeGroupMembers.length === 1 ? "teammate" : "teammates"}`
                    : "Add teammates"}
                </span>
              </button>
            )}
          </div>
          <div>
            {!activityOpen && <button
              type="button"
              className={`bot-scope bot-safe-read-mode${safeAutoApprove ? " enabled" : ""}`}
              onClick={() => openSettings("privacy")}
              aria-label={browserReadAvailable
                ? safeAutoApprove
                  ? "Safe reads: Auto. Open approval settings"
                  : browserDomains.length > 0
                    ? `Website access: ${browserDomains.length} saved ${browserDomains.length === 1 ? "domain" : "domains"}. Open approval settings`
                    : "Safe reads: Ask first. Open approval settings"
                : "Agent website inspection unavailable. Open privacy settings"}
            >
              <ShieldCheck size={14} /> {browserReadAvailable
                ? safeAutoApprove
                  ? "Safe reads · Auto"
                  : browserDomains.length > 0
                    ? `Website access · ${browserDomains.length} ${browserDomains.length === 1 ? "domain" : "domains"}`
                    : "Website access · Ask first"
                : "Website reads · Unavailable"}
            </button>}
            {!activityOpen && ["running", "canceling"].includes(runState) && (
              <button className="bots-stop-button" onClick={() => void cancel()} disabled={runState === "canceling"}>
                <CircleStop size={15} /> {runState === "canceling" ? "Stopping" : "Stop"}
              </button>
            )}
            <button className="bots-icon-button" onClick={() => openSettings("general")} aria-label="Open settings" title="Settings">
              <SlidersHorizontal size={17} />
            </button>
          </div>
        </header>

        {(browserActivities.length > 0 || browserTeaching || browserSkillRun) && (
          <section
            className={`bots-browser-activities${browserTeaching ? " teaching" : ""}${browserSkillRun ? " replay" : ""}`}
            aria-label={browserTeaching
              ? "Teach a browser task"
              : browserSkillRun
                ? "Run a browser skill"
                : "Active website reads"}
          >
            {browserTeaching && (
              <Suspense fallback={<DeferredSurface label="Opening browser teaching" browser />}>
                <BotBrowserTeachingActivity
                  key={browserTeaching.sessionId}
                  request={browserTeaching.request}
                  sessionId={browserTeaching.sessionId}
                  botId={browserTeaching.botId}
                  obscured={sidebarOpen && window.innerWidth < 900}
                  onSave={saveBrowserTeaching}
                  onCancel={() => closeBrowserTeaching("Teaching canceled")}
                  onError={(message) => setBotFeedback(browserTeaching.botId, { error: message, notice: null })}
                />
              </Suspense>
            )}
            {browserSkillRun && (
              <Suspense fallback={<DeferredSurface label="Opening browser skill" browser />}>
                <BotBrowserSkillRunActivity
                  key={browserSkillRun.runId}
                  skill={browserSkillRun.request.skill}
                  recipe={browserSkillRun.request.recipe}
                  runId={browserSkillRun.runId}
                  sessionId={browserSkillRun.sessionId}
                  botId={browserSkillRun.botId}
                  obscured={sidebarOpen && window.innerWidth < 900}
                  onAcquireBrowser={async () => {
                    if (!browserSkillRelease.current) {
                      browserSkillRelease.current = await acquireBrowserLane(browserSkillRun.runId);
                    }
                  }}
                  onApproval={recordBrowserSkillApproval}
                  onCheckpoint={checkpointBrowserSkill}
                  onFinish={finishBrowserSkillRun}
                  onError={(message) => setBotFeedback(browserSkillRun.botId, { error: message, notice: null })}
                />
              </Suspense>
            )}
            {browserActivities.map((activity) => (
              <BotBrowserActivity
                key={activity.pending.runId}
                pending={activity.pending}
                botName={activity.botName}
                obscured={sidebarOpen && window.innerWidth < 900}
                disabled={activity.disabled}
                onSessionChange={onBrowserSessionChange}
                onOpenError={onBrowserOpenError}
              />
            ))}
          </section>
        )}

        <div className="bots-thread-scroll" ref={scrollRef} tabIndex={0} aria-label="Bot conversation">
          <section className="bots-thread" aria-live="polite">
            {activityOpen ? (
              <div className="bots-activity-view">
                <header>
                  <span className="bot-delegation-icon"><Activity size={17} /></span>
                  <div>
                    <h1>All activity</h1>
                    <p>Review routine outcomes and specialist handoffs in one quiet place.</p>
                  </div>
                </header>
                {catalog.bots.some((candidate) => botExecutionState(executionStates, candidate.id).runState !== "idle") && (
                  <section className="bots-active-workers" aria-label="Bots working now">
                    <h2>Working now</h2>
                    {catalog.bots.filter((candidate) => (
                      botExecutionState(executionStates, candidate.id).runState !== "idle"
                    )).map((candidate) => {
                      const candidateExecution = botExecutionState(executionStates, candidate.id);
                      return (
                        <button key={candidate.id} type="button" onClick={() => void chooseBot(candidate.id)}>
                          <BotAvatar avatar={avatarForBot(candidate)} size="small" />
                          <span>
                            <strong>{candidate.name}</strong>
                            <small>{candidateExecution.runState === "awaiting-approval"
                              ? "Needs approval"
                              : candidateExecution.liveRun.status || candidate.latestStatus}</small>
                          </span>
                          <span className="bot-state-dot working" aria-hidden="true" />
                        </button>
                      );
                    })}
                  </section>
                )}
                {routineActivity.length > 0 && (
                  <section className="bots-routine-activity" aria-label="Routine activity">
                    <h2>Routines</h2>
                    {routineActivity.map((item) => {
                      const owner = catalog.bots.find((candidate) => candidate.id === item.botId);
                      const title = item.triggerKind === "schedule"
                        ? schedules.find((schedule) => schedule.id === item.routineId)?.title || item.title
                        : item.title;
                      const state = item.status === "completed"
                        ? "done"
                        : item.status === "retrying"
                          ? "working"
                          : "blocked";
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => void chooseBot(item.botId)}
                          aria-label={`Open ${title} in ${item.botName}`}
                        >
                          {owner
                            ? <BotAvatar avatar={avatarForBot(owner)} size="small" />
                            : <span className="bot-delegation-icon"><CalendarClock size={14} /></span>}
                          <span>
                            <strong>{title}</strong>
                            <small>{item.botName} · {routineActivityStatus(item)} · {routineActivityTime(item.occurredAt)}</small>
                          </span>
                          <span className={`bot-state-dot ${state}`} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </section>
                )}
                {delegations.length > 0 && (
                  <section className="bots-activity-history" aria-label="Bot handoffs">
                    <h2>Handoffs</h2>
                    {delegations.map((delegation) => (
                      <BotDelegationCard
                        key={delegation.id}
                        delegation={delegation}
                        showParent
                        canceling={cancelingDelegationId === delegation.id}
                        onOpenBot={chooseBot}
                        onCancel={cancelDelegation}
                      />
                    ))}
                  </section>
                )}
                {!routineActivity.length && !delegations.length && (
                  <div className="bots-activity-empty">
                    <Users size={18} />
                    <strong>No activity yet</strong>
                    <span>Run a routine or type @ to ask another bot for focused help.</span>
                  </div>
                )}
              </div>
            ) : <>
            {!hasConversation && <header className="bot-intro">
              <BotAvatar avatar={activeAvatar} size="hero" />
              <h1>{bot.name}</h1>
              <p>{bot.spec.job}</p>
              <div className="bot-scope-row">
                {hasProject ? (
                  <button className="bot-scope connected" onClick={() => void connectProject()} disabled={hasAnyActiveRun}>
                    <Check size={14} /> {workspace.workspaceFolder?.path.split("/").pop() || "Project"}
                  </button>
                ) : (
                  <button className="bot-scope" onClick={() => void connectProject()} disabled={choosingFolder || hasAnyActiveRun}>
                    <FolderOpen size={14} /> {choosingFolder ? "Opening..." : "Connect a project"}
                  </button>
                )}
                {engine ? (
                  <span className="bot-scope"><Bot size={14} /> Engine · {providerLabel(providers, engine)}</span>
                ) : setupAction ? (
                  <button className="bot-scope setup" onClick={() => void setupOnDevice()} disabled={Boolean(modelSetup)}>
                    <Download size={14} /> {modelSetup?.message || setupAction.label}
                  </button>
                ) : (
                  <button className="bot-scope setup" onClick={() => openSettings("intelligence")}>
                    <Settings2 size={14} /> Set up intelligence
                  </button>
                )}
              </div>
            </header>}

            {hasConversation && (
              <BotGoalCard
                goal={bot.spec.goal}
                disabled={hasAnyActiveRun}
                onComplete={() => void completeActiveGoal()}
              />
            )}

            <div className="bots-blocks">
              {threadTimeline.filter((item) => !(
                !hasConversation
                && item.kind === "block"
                && item.block.type === "assistant-message"
                && item.block.sequence === 1
              )).map((item) => item.kind === "block" ? (
                <BotThreadBlock key={item.id} block={item.block} bot={bot} />
              ) : (
                <BotDelegationCard
                  key={item.id}
                  delegation={item.delegation}
                  canceling={cancelingDelegationId === item.delegation.id}
                  onOpenBot={chooseBot}
                  onCancel={cancelDelegation}
                />
              ))}
              {tableView?.table.botId === bot.id && (
                <Suspense fallback={<DeferredSurface label="Opening local table" />}>
                  <BotDataTableArtifact
                    key={tableView.table.id}
                    view={tableView}
                    exporting={exportingTableId === tableView.table.id}
                    onExport={() => void exportVisibleBotTable()}
                    onClose={() => setTableView(null)}
                  />
                </Suspense>
              )}
              {pendingSkillReviews.length > 0 && (
                <Suspense fallback={<DeferredSurface label="Opening skill review" />}>
                  <BotSkillReviews
                    skills={pendingSkillReviews}
                    workingId={skillReviewActionId}
                    onReview={(skill, decision) => void reviewSkillPackage(skill, decision)}
                  />
                </Suspense>
              )}
              {memoryProposals.length > 0 && (
                <Suspense fallback={<DeferredSurface label="Opening memory review" />}>
                  <BotMemoryProposals
                    proposals={memoryProposals}
                    workingId={memoryProposalActionId}
                    onReview={(proposal, decision, scope, expiresAt) => {
                      void reviewMemoryProposal(proposal, decision, scope, expiresAt);
                    }}
                  />
                </Suspense>
              )}
              {browserDownloads.length > 0 && (
                <Suspense fallback={<DeferredSurface label="Opening downloads" />}>
                  <BotDownloadArtifacts
                    downloads={browserDownloads}
                    workingId={downloadActionId}
                    onRelease={(download) => void releaseBrowserDownload(download)}
                    onDelete={(download) => void deleteBrowserDownload(download)}
                  />
                </Suspense>
              )}
              {(activeRoutines.length > 0 || activeEventRoutines.length > 0) && (
                <section className="bot-routines" aria-label="Bot routines">
                  <header><CalendarClock size={15} /><span>Routines</span></header>
                  {activeRoutines.map((schedule) => (
                    <BotRoutineCard
                      key={schedule.id}
                      schedule={schedule}
                      busy={routineAction === schedule.id}
                      onStart={() => void enableRoutine(schedule)}
                      onPause={() => void pauseRoutine(schedule)}
                      onRemove={() => void removeRoutine(schedule)}
                    />
                  ))}
                  {activeEventRoutines.map((routine) => (
                    <BotEventRoutineCard
                      key={routine.id}
                      routine={routine}
                      busy={routineAction === routine.id}
                      onStart={() => void enableEventRoutine(routine)}
                      onPause={() => void pauseEventRoutine(routine)}
                      onRemove={() => void removeEventRoutine(routine)}
                    />
                  ))}
                </section>
              )}
              {botChangeUndo && botChangeUndo.botId === bot.id && (
                <section className="bot-change-undo" aria-label="Recent bot or routine change">
                  <span className="bot-initiative-icon"><Pencil size={16} /></span>
                  <div>
                    <small>Chat change</small>
                    <strong>{botChangeUndo.title}</strong>
                    <span>{botChangeUndo.detail}</span>
                  </div>
                  <button
                    className="bot-secondary-action"
                    onClick={() => void undoRecentBotChange()}
                    disabled={botChangeUndo.kind === "schedule" && routineAction === botChangeUndo.scheduleId}
                  >
                    Undo
                  </button>
                </section>
              )}
              {memoryUndo && memoryUndo.botId === bot.id && (
                <section className="bot-memory-undo" aria-label="New bot memory">
                  <span className="bot-initiative-icon"><Brain size={16} /></span>
                  <div>
                    <small>{memoryUndo.memory.scope === "workspace" ? "Shared memory" : "Bot memory"}</small>
                    <strong>Remembered</strong>
                    <span>{memoryUndo.memory.body}</span>
                  </div>
                  <button className="bot-secondary-action" onClick={() => void undoRememberedMemory()}>
                    Undo
                  </button>
                </section>
              )}
              {skillUndo && skillUndo.botId === bot.id && (
                <section className="bot-skill-undo" aria-label="New reusable skill">
                  <span className="bot-initiative-icon"><Sparkles size={16} /></span>
                  <div>
                    <small>Workspace skill · v{skillUndo.skill.version}</small>
                    <strong>{skillUndo.previous ? "Updated" : "Learned"} {skillUndo.skill.name}</strong>
                    <span>{skillUndo.skill.description}</span>
                  </div>
                  <button className="bot-secondary-action" onClick={() => void undoTaughtSkill()}>
                    Undo
                  </button>
                </section>
              )}
              {pendingMcpRun && runState === "awaiting-approval" && (
                <section className="bot-mcp-approval" aria-labelledby={`mcp-approval-${pendingMcpRun.runId}`}>
                  <span className="bot-approval-icon"><ShieldCheck size={17} /></span>
                  <div>
                    <strong id={`mcp-approval-${pendingMcpRun.runId}`}>Allow this external action?</strong>
                    <span>{pendingMcpRun.serverName} / {pendingMcpRun.toolName}</span>
                    <small>{pendingMcpRun.description}</small>
                    <code>{JSON.stringify(pendingMcpRun.arguments, null, 2)}</code>
                    <small>
                      Effect: {pendingMcpRun.effect}{pendingMcpRun.destructive ? " · destructive" : ""}. Codelit will send exactly these arguments once. Any later call asks again.
                    </small>
                  </div>
                  <footer>
                    <button className="bot-secondary-action" onClick={() => void decideMcpRun(false)}>Hold</button>
                    <button className="bot-primary-action" onClick={() => void decideMcpRun(true)}>Allow once</button>
                  </footer>
                </section>
              )}
              {pendingBrowserRun && runState === "awaiting-approval" && (
                <section className="bot-browser-approval" aria-labelledby={`browser-approval-${pendingBrowserRun.runId}`}>
                  <span className="bot-approval-icon"><ShieldCheck size={17} /></span>
                  <div>
                    <strong id={`browser-approval-${pendingBrowserRun.runId}`}>
                      {pendingBrowserRun.browserAction?.action === "download"
                        ? "Download this file?"
                        : pendingBrowserRun.browserAction
                          ? "Run this browser action?"
                          : `Read ${pendingBrowserRun.target.host}?`}
                    </strong>
                    {pendingBrowserRun.browserAction ? (
                      <>
                        <span>{pendingBrowserRun.browserAction.action === "download"
                          ? `Codelit will open ${pendingBrowserRun.target.host}, activate this exact control once, and hold the result in a private 25 MB quarantine.`
                          : `Codelit will open ${pendingBrowserRun.target.host}, recheck this exact visible control, and perform it once. Every later action asks again.`}</span>
                        <code>{pendingBrowserRun.browserAction.action === "type"
                          ? `Type ${pendingBrowserRun.browserAction.valueLength} characters into "${pendingBrowserRun.browserAction.targetLabel}"`
                          : pendingBrowserRun.browserAction.action === "download"
                            ? `Download "${pendingBrowserRun.browserAction.targetLabel}"`
                          : `Click "${pendingBrowserRun.browserAction.targetLabel}"`}</code>
                        <small>{pendingBrowserRun.browserAction.action === "download"
                          ? "The bot cannot read or open the file. You must release or delete it after its hash and file type are checked. Executables and installers remain blocked."
                          : `${browserEvidenceBoundary(providers, pendingBrowserRun.engine)} Password, payment, sign-in, destructive, ambiguous, and prompt-injected targets remain blocked.`}</small>
                      </>
                    ) : (
                      <span>Codelit will open this domain inside the app and read visible page content only. {browserEvidenceBoundary(providers, pendingBrowserRun.engine)} It will not click, type, or download. Allow once grants no future access.</span>
                    )}
                    {pendingSafeReadEligible && (
                      <small>Save this exact domain for future public, read-only checks by {bot.name}. Sensitive pages and every action still ask.</small>
                    )}
                  </div>
                  <footer>
                    <button className="bot-secondary-action" onClick={() => void decideBrowserRun(false)} disabled={savingApprovalMode}>Hold</button>
                    <button className="bot-secondary-action" onClick={() => void decideBrowserRun(true)} disabled={savingApprovalMode}>Allow once</button>
                    {browserReadAvailable && pendingSafeReadEligible && (
                      <button
                        className="bot-safe-auto-action"
                        onClick={() => void allowBrowserDomainAndApproveRun()}
                        disabled={savingApprovalMode}
                      >
                        {savingApprovalMode ? "Saving..." : `Always allow ${pendingBrowserRun.target.host}`}
                      </button>
                    )}
                  </footer>
                </section>
              )}
              {pendingComputerRun && runState === "awaiting-approval" && (
                <section className="bot-computer-approval" aria-labelledby={`computer-approval-${pendingComputerRun.runId}`}>
                  <span className="bot-approval-icon"><Monitor size={17} /></span>
                  <div>
                    <strong id={`computer-approval-${pendingComputerRun.runId}`}>Use {pendingComputerRun.app.appName}?</strong>
                    <span>{pendingComputerRun.proposedSummary}</span>
                    <code>{computerActionLabel(pendingComputerRun.action)}</code>
                    <small>Codelit will target this exact visible control once, capture only this app&apos;s window before and after, and ask again for every later action.</small>
                  </div>
                  <footer>
                    <button className="bot-secondary-action" onClick={() => void takeOverPendingComputerRun()}>
                      <Monitor size={13} /> Take over
                    </button>
                    <button className="bot-secondary-action" onClick={() => void decideComputerRun(false)}>Hold</button>
                    <button className="bot-primary-action" onClick={() => void decideComputerRun(true)}>Allow once</button>
                  </footer>
                </section>
              )}
              {pendingComputerRun && ["running", "canceling"].includes(runState) && (
                <section className="bot-computer-active" aria-label={`Using ${pendingComputerRun.app.appName}`}>
                  <span><Monitor size={15} /> Using {pendingComputerRun.app.appName}</span>
                  <button
                    className="bot-secondary-action"
                    onClick={() => void takeOverPendingComputerRun()}
                    disabled={runState === "canceling"}
                  >
                    {runState === "canceling" ? "Handing over..." : "Take over"}
                  </button>
                </section>
              )}
              {computerEvidenceByBotId[bot.id] && (
                <section className="bot-computer-evidence" aria-label="Computer action evidence">
                  <header>
                    <span><ShieldCheck size={15} /> Computer evidence</span>
                    <button
                      type="button"
                      className="bots-icon-button"
                      onClick={() => setComputerEvidenceByBotId((current) => ({ ...current, [bot.id]: undefined }))}
                      aria-label="Dismiss computer evidence"
                    >
                      <X size={14} />
                    </button>
                  </header>
                  <div>
                    {computerEvidenceByBotId[bot.id]!.evidence.map((frame) => (
                      <figure key={`${frame.phase}-${frame.sha256}`}>
                        {/* Native evidence is a transient data URL inside the Vite desktop app. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={frame.dataUrl} alt={`${frame.phase === "before" ? "Before" : "After"} ${computerEvidenceByBotId[bot.id]!.before.appName} action`} />
                        <figcaption>{frame.phase === "before" ? "Before" : "After"}</figcaption>
                      </figure>
                    ))}
                  </div>
                  <p>{computerEvidenceByBotId[bot.id]!.summary}</p>
                </section>
              )}
              {liveRun && liveRun.runId === activeRunId && !["idle", "awaiting-approval"].includes(runState) && (
                <div className={`bot-live-response ${liveRun.phase}`} role="status" aria-live="polite" aria-atomic="false">
                  <BotAvatar avatar={activeAvatar} size="small" />
                  <div className="bot-live-response-copy">
                    <div className="bot-live-response-status">
                      <span className="bot-working-indicator" />
                      <strong>{liveRun.status || "Thinking"}</strong>
                      <small>{providerLabel(providers, execution?.engine || pendingBrowserRun?.engine || pendingComputerRun?.engine || engine)} · controlled on this Mac</small>
                    </div>
                    {liveRun.reasoning && (
                      <details className="bot-live-thinking" open={!liveRun.answer}>
                        <summary>Thinking</summary>
                        <p>{liveRun.reasoning}</p>
                      </details>
                    )}
                    {liveRun.answer && (
                      <RichBotMarkdown className="bot-live-answer" streaming>{liveRun.answer}</RichBotMarkdown>
                    )}
                  </div>
                </div>
              )}
            </div>

            {workspace.blocks.length <= 1 && !prompt.trim() && (
              <Suspense fallback={null}>
                <BotOutcomeActions
                  capabilities={outcomeCapabilities}
                  disabled={!canStartBotExecution(executionStates, bot.id)}
                  mode="starter"
                  onSubmit={(task) => void submit(task)}
                />
              </Suspense>
            )}
            {workspace.blocks.length > 1 && runState === "idle" && !prompt.trim() && (
              <Suspense fallback={null}>
                <BotOutcomeActions
                  blocks={workspace.blocks}
                  capabilities={outcomeCapabilities}
                  disabled={!canStartBotExecution(executionStates, bot.id)}
                  mode="next"
                  onSubmit={(task) => void submit(task)}
                />
              </Suspense>
            )}
            </>}
          </section>
        </div>

        {(error || notice) && (
          <div className={`bots-toast ${error ? "error" : "success"}`} role="status">
            {error ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
            <span>{error || notice}</span>
            <button onClick={() => {
              if (bot) setBotFeedback(bot.id, { error: null, notice: null });
              setGlobalError(null);
              setGlobalNotice(null);
            }} aria-label="Dismiss"><X size={14} /></button>
          </div>
        )}

        {!activityOpen && <div className="bots-composer-dock">
          <div className="bots-composer">
            {mentionCandidates.length > 0 && (
              <div className="bot-mention-picker" role="listbox" aria-label="Choose a bot">
                <header><AtSign size={14} /><span>Ask a specialist</span></header>
                {mentionCandidates.map((candidate, index) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="option"
                    aria-selected={index === Math.min(mentionIndex, mentionCandidates.length - 1)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectBotMention(candidate.name)}
                  >
                    <BotAvatar avatar={avatarForBot(candidate)} size="small" />
                    <span><strong>{candidate.name}</strong><small>{candidate.spec.job}</small></span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={composerRef}
              rows={2}
              maxLength={2_000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (mentionCandidates.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setMentionIndex((current) => (current + 1) % mentionCandidates.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setMentionIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setMentionDismissed(true);
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    selectBotMention(mentionCandidates[Math.min(mentionIndex, mentionCandidates.length - 1)].name);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={browserTeaching
                ? `Finish teaching ${browserTeaching.request.name} above...`
                : browserSkillRun
                  ? `Finish or stop ${browserSkillRun.request.skill.name} above...`
                : pendingMcpRun
                  ? `Review the ${pendingMcpRun.serverName} action above to continue...`
                : pendingBrowserRun
                ? `Review ${pendingBrowserRun.target.host} above to continue...`
                : pendingComputerRun
                  ? `Review the ${pendingComputerRun.app.appName} action above to continue...`
                : engine
                  ? activeGroupMembers.length
                    ? `Ask ${bot.name} or the team...`
                    : `Ask ${bot.name} to do something...`
                  : catalog.bots.length > 1
                    ? "Ask another bot with @, or set up intelligence..."
                    : "Set up intelligence to start..."}
              aria-label={`Message ${bot.name}`}
              disabled={Boolean(browserTeaching || browserSkillRun) || !canStartBotExecution(executionStates, bot.id)}
            />
            <footer>
              <button className="composer-context-button" onClick={() => void connectProject()} title="Choose project" aria-label="Choose project" disabled={hasAnyActiveRun}>
                <FolderOpen size={16} />
              </button>
              {catalog.bots.length > 1 && (
                <button
                  type="button"
                  className="composer-capability composer-capability-button"
                  onClick={openBotMentions}
                  title="Ask one or two specialist bots"
                  aria-label="Ask another bot"
                >
                  <AtSign size={14} /> Bots
                </button>
              )}
              {browserReadAvailable && (
                <span className="composer-capability" title={'Paste an HTTPS address to inspect it, or ask: Click "Pricing" on https://example.com'}>
                  <Globe2 size={14} /> Browser
                </span>
              )}
              {computerUseAvailable && computerAppScopes.length > 0 && (
                <span className="composer-capability" title="Name an approved app and ask for one visible action">
                  <Monitor size={14} /> {computerAppScopes.length === 1
                    ? computerAppScopes[0].appName
                    : `${computerAppScopes.length} apps`}
                </span>
              )}
              <span className="composer-capability" title="Say Remember that..., review suggestions, or ask What do you know?">
                <Brain size={14} /> {memoryProposals.length
                  ? `${memoryProposals.length} to review`
                  : memories.length ? `${memories.length} remembered` : "Memory"}
              </span>
              <span className="composer-capability" title="Teach this as a skill, then mention its name to reuse it">
                <Sparkles size={14} /> {skills.length
                  ? `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`
                  : "Skills"}
              </span>
              {botTables.length > 0 && (
                <button
                  type="button"
                  className="composer-capability composer-capability-button"
                  onClick={() => void openRecentBotTable()}
                  title="Open this bot's newest local table"
                  aria-label="Open local tables"
                >
                  <Table2 size={14} /> {botTables.length === 1 ? botTables[0].name : `${botTables.length} tables`}
                </button>
              )}
              <button className="composer-engine-button" onClick={() => openSettings("intelligence")}>
                {bot.spec.enginePolicy.mode === "auto" ? "Auto" : "Fixed"} · {providerLabel(providers, engine)}
              </button>
              <button
                className="bots-send-button"
                onClick={() => void submit()}
                disabled={Boolean(browserTeaching || browserSkillRun) || !prompt.trim() || !canStartBotExecution(executionStates, bot.id) || !composerCanRun}
                aria-label="Send"
              >
                <ArrowUp size={17} />
              </button>
            </footer>
          </div>
        </div>}
      </main>

      {newBotOpen && (
        <div className="bots-modal-layer bots-new-bot-layer" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeNewBot();
        }}>
          <section
            ref={newBotDialog.dialogRef}
            className="bots-new-sheet bots-new-bot-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-bot-title"
            onKeyDown={newBotDialog.onKeyDown}
          >
            <header><span className="bots-mark"><Bot size={17} /></span><button className="bots-icon-button" onClick={closeNewBot} aria-label="Close"><X size={17} /></button></header>
            <h2 id="new-bot-title">Create a bot</h2>
            <label className="bot-field">
              <span>What should this bot take care of?</span>
              <textarea
                data-autofocus
                rows={5}
                maxLength={500}
                value={botJob}
                onChange={(event) => setBotJob(event.target.value)}
                placeholder="Keep this repository healthy and prepare fixes for review."
                aria-label="Bot job"
              />
            </label>
            {botJob.trim() && (
              <div className="bot-create-preview">
                <strong>{normalizeBotName(newBotName) || createBotName(botJob)}</strong>
                <span>Can do: answer, reason, and use approved tools</span>
                <span>Asks first: project access and any external change</span>
              </div>
            )}
            <details className="bot-create-customize">
              <summary>
                <span><SlidersHorizontal size={14} /> Customize</span>
                <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <div className="bot-create-customize-fields">
                <label className="bot-field">
                  <span>Name</span>
                  <input
                    maxLength={64}
                    value={newBotName}
                    onChange={(event) => setNewBotName(event.target.value)}
                    placeholder={createBotName(botJob)}
                  />
                </label>
                <fieldset className="bot-avatar-picker">
                  <legend>Avatar</legend>
                  <div role="radiogroup" aria-label="Bot avatar">
                    {BOT_AVATAR_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        role="radio"
                        aria-checked={newBotAvatar.kind === "preset" && newBotAvatar.preset === preset.id}
                        className={newBotAvatar.kind === "preset" && newBotAvatar.preset === preset.id ? "selected" : undefined}
                        onClick={() => setNewBotAvatar({ kind: "preset", preset: preset.id })}
                        aria-label={preset.label}
                      >
                        <BotAvatar avatar={{ kind: "preset", preset: preset.id }} size="large" />
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
            </details>
            <button className="bots-primary-button" onClick={() => void addBot()} disabled={!botJob.trim() || creating}>
              <Plus size={16} /> {creating ? "Creating..." : "Create bot"}
            </button>
          </section>
        </div>
      )}

      {groupOpen && (
        <div className="bots-modal-layer" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeGroup();
        }}>
          <section
            ref={groupDialog.dialogRef}
            className="bots-new-sheet bot-team-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bot-team-title"
            onKeyDown={groupDialog.onKeyDown}
          >
            <header>
              <span className="bots-mark"><Users size={17} /></span>
              <button className="bots-icon-button" onClick={closeGroup} aria-label="Close teammates"><X size={17} /></button>
            </header>
            <div className="bot-team-heading">
              <div>
                <h2 id="bot-team-title">Conversation team</h2>
                <span>{groupDraftIds.length}/2 teammates</span>
              </div>
            </div>
            {catalog.bots.length > 1 ? (
              <div className="bot-team-options" role="group" aria-label="Available teammates">
                {catalog.bots.filter((candidate) => candidate.id !== bot.id).map((candidate) => {
                  const selected = groupDraftIds.includes(candidate.id);
                  return (
                    <label key={candidate.id} className={selected ? "selected" : undefined}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!selected && groupDraftIds.length >= 2}
                        onChange={() => toggleGroupMember(candidate.id)}
                        aria-label={`${selected ? "Remove" : "Add"} ${candidate.name}`}
                      />
                      <BotAvatar avatar={avatarForBot(candidate)} size="medium" />
                      <span className="bot-team-option-copy"><strong>{candidate.name}</strong><small>{candidate.spec.job}</small></span>
                      <span className={`bot-state-dot ${candidate.status}`} aria-hidden="true" />
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="bot-team-empty">
                <Users size={18} />
                <strong>No other bots yet</strong>
                <button type="button" className="bots-primary-button" onClick={createBotFromGroup}>
                  <Plus size={15} /> New bot
                </button>
              </div>
            )}
            {groupError && <p className="bot-field-error" role="alert">{groupError}</p>}
            {catalog.bots.length > 1 && (
              <footer className="bot-team-actions">
                <button type="button" className="bot-secondary-action" onClick={closeGroup}>Cancel</button>
                <button
                  type="button"
                  className="bots-primary-button"
                  onClick={() => void saveGroupMembers()}
                  disabled={savingGroup}
                >
                  {savingGroup ? "Saving..." : "Save team"}
                </button>
              </footer>
            )}
          </section>
        </div>
      )}

      {profileOpen && (
        <div className="bots-profile-layer" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeProfile();
        }}>
          <aside
            ref={profileDialog.dialogRef}
            className="bots-profile-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bot-profile-title"
            onKeyDown={profileDialog.onKeyDown}
          >
            <header>
              <div><span>Bot profile</span><h2 id="bot-profile-title">Customize {bot.name}</h2></div>
              <button className="bots-icon-button" onClick={closeProfile} aria-label="Close profile"><X size={17} /></button>
            </header>
            <section className="bot-profile-preview">
              <BotAvatar avatar={profileAvatar} size="hero" label={`${profileName || bot.name} avatar`} />
              <div><strong>{normalizeBotName(profileName) || bot.name}</strong><span>Private to this Mac</span></div>
            </section>
            <section>
              <label className="bot-field" htmlFor="bot-profile-name">
                <span>Name</span>
                <input
                  id="bot-profile-name"
                  data-autofocus
                  maxLength={64}
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                  aria-describedby="bot-profile-name-count"
                />
                <small id="bot-profile-name-count">{profileName.length}/64</small>
              </label>
            </section>
            <section>
              <fieldset className="bot-avatar-picker">
                <legend>Avatar</legend>
                <div role="radiogroup" aria-label="Choose an avatar">
                  {BOT_AVATAR_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={profileAvatar.kind === "preset" && profileAvatar.preset === preset.id}
                      className={profileAvatar.kind === "preset" && profileAvatar.preset === preset.id ? "selected" : undefined}
                      onClick={() => setProfileAvatar({ kind: "preset", preset: preset.id })}
                      aria-label={preset.label}
                    >
                      <BotAvatar avatar={{ kind: "preset", preset: preset.id }} size="large" />
                    </button>
                  ))}
                </div>
              </fieldset>
              <input
                ref={avatarFileRef}
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => void chooseProfileImage(event)}
                tabIndex={-1}
                aria-hidden="true"
              />
              <button className="bot-upload-button" type="button" onClick={() => avatarFileRef.current?.click()}>
                <ImagePlus size={16} /> Choose image
              </button>
              <p className="bot-profile-privacy">Images are cropped to a square, stripped of file metadata, and stored with this bot locally.</p>
            </section>
            {profileError && <p className="bot-profile-error" role="alert">{profileError}</p>}
            <footer>
              <button className="bot-secondary-action" onClick={closeProfile} disabled={savingProfile}>Cancel</button>
              <button className="bots-primary-button" onClick={() => void saveProfile()} disabled={savingProfile}>
                {savingProfile ? "Saving..." : "Save profile"}
              </button>
            </footer>
          </aside>
        </div>
      )}

      {settingsOpen && (
        <div className="bots-settings-layer" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeSettings();
        }}>
          <aside
            ref={settingsDialog.dialogRef}
            className="bots-settings"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bots-settings-title"
            onKeyDown={settingsDialog.onKeyDown}
          >
            <header className="bots-settings-header">
              <div><span>Codelit</span><h2 id="bots-settings-title">Settings</h2></div>
              <button className="bots-icon-button" onClick={closeSettings} aria-label="Close settings"><X size={17} /></button>
            </header>
            <div className="bots-settings-layout">
              <nav className="bots-settings-nav" aria-label="Settings categories">
                <button
                  type="button"
                  className={settingsSection === "general" ? "selected" : undefined}
                  aria-current={settingsSection === "general" ? "page" : undefined}
                  onClick={() => selectSettingsSection("general")}
                >
                  <Settings2 size={16} aria-hidden="true" />
                  <span>General</span>
                </button>
                <button
                  type="button"
                  className={settingsSection === "intelligence" ? "selected" : undefined}
                  aria-current={settingsSection === "intelligence" ? "page" : undefined}
                  onClick={() => selectSettingsSection("intelligence")}
                >
                  <Bot size={16} aria-hidden="true" />
                  <span>Intelligence</span>
                </button>
                <button
                  type="button"
                  className={settingsSection === "privacy" ? "selected" : undefined}
                  aria-current={settingsSection === "privacy" ? "page" : undefined}
                  onClick={() => selectSettingsSection("privacy")}
                >
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>Privacy</span>
                </button>
              </nav>

              <div className="bots-settings-content" data-section={settingsSection}>
                {settingsSection === "general" && (
                  <div className="bots-settings-page" aria-labelledby="bots-settings-general-title">
                    <header className="bots-settings-page-header">
                      <span>Workspace</span>
                      <h3 id="bots-settings-general-title">General</h3>
                      <p>Choose how bots think, work, and access this Mac.</p>
                    </header>

                    <section className="bots-settings-group" aria-labelledby="bots-settings-engine-title">
                      <header>
                        <h4 id="bots-settings-engine-title">Engine</h4>
                        <p>Auto keeps setup simple and avoids metered APIs by default.</p>
                      </header>
                      <div className="bot-engine-policy-controls">
                        <button
                          type="button"
                          className={bot.spec.enginePolicy.mode === "auto" ? "selected" : undefined}
                          onClick={() => void changeEngine(null)}
                          disabled={savingEngine || runState !== "idle"}
                          aria-pressed={bot.spec.enginePolicy.mode === "auto"}
                        >
                          Auto
                        </button>
                        <EnginePicker
                          providers={eligibleProviders}
                          value={engine}
                          onChange={(selection) => void changeEngine(selection)}
                          disabled={savingEngine || runState !== "idle"}
                        />
                      </div>
                      <p>{bot.spec.enginePolicy.mode === "auto"
                        ? "Codelit chooses the best ready local or subscription engine."
                        : "This bot stays on the selected engine until you switch it back to Auto."}</p>
                      {bot.spec.enginePolicy.mode === "auto" && (
                        <button
                          type="button"
                          className="bots-setting-row bot-auto-approve"
                          role="switch"
                          aria-checked={bot.spec.enginePolicy.allowMeteredFallback}
                          onClick={() => void changeMeteredFallback(!bot.spec.enginePolicy.allowMeteredFallback)}
                          disabled={savingEngine || runState !== "idle"}
                        >
                          <SlidersHorizontal size={17} />
                          <span>
                            <strong>Use connected AI for better answers</strong>
                            <small>Prefer a saved API provider in Auto. Provider usage may be billed.</small>
                          </span>
                          <span className="bot-toggle" aria-hidden="true"><span /></span>
                        </button>
                      )}
                      {setupAction && (
                        <div className="local-model-setup-actions">
                          <button className="bots-primary-button settings-setup" onClick={() => void setupOnDevice()} disabled={Boolean(modelSetup)}>
                            <Download size={16} /> {modelSetup?.message || setupAction.label}
                          </button>
                          {modelSetup?.runId && (
                            <button className="bot-secondary-action" onClick={() => void cancelModelSetup()}>
                              Cancel
                            </button>
                          )}
                        </div>
                      )}
                    </section>

                    {schedulesAvailable && (
                      <section className="bots-settings-group" aria-labelledby="bots-settings-autonomy-title">
                        <header>
                          <h4 id="bots-settings-autonomy-title">Autonomy</h4>
                          <p>Choose when routines may start. Manual chats and approvals remain available.</p>
                        </header>
                        {autonomyPolicy ? (
                          <>
                            <button
                              type="button"
                              className="bots-setting-row bot-auto-approve"
                              role="switch"
                              aria-checked={autonomyPolicy.globallyPaused}
                              onClick={() => void changeAutonomyPolicy({ globallyPaused: !autonomyPolicy.globallyPaused })}
                              disabled={savingAutonomyPolicy}
                            >
                              <Pause size={17} />
                              <span>
                                <strong>Pause all routines</strong>
                                <small>{autonomyPolicy.statusDetail}. In-progress routine work stops safely.</small>
                              </span>
                              <span className="bot-toggle" aria-hidden="true"><span /></span>
                            </button>
                            <button
                              type="button"
                              className="bots-setting-row bot-auto-approve"
                              role="switch"
                              aria-checked={autonomyPolicy.quietHoursEnabled}
                              onClick={() => void changeAutonomyPolicy({ quietHoursEnabled: !autonomyPolicy.quietHoursEnabled })}
                              disabled={savingAutonomyPolicy}
                            >
                              <CalendarClock size={17} />
                              <span>
                                <strong>Quiet hours</strong>
                                <small>Hold new routine work and notifications during your local quiet window.</small>
                              </span>
                              <span className="bot-toggle" aria-hidden="true"><span /></span>
                            </button>
                            {autonomyPolicy.quietHoursEnabled && (
                              <div className="bot-quiet-hours" aria-label="Quiet hours window">
                                <label>
                                  <span>From</span>
                                  <input
                                    type="time"
                                    value={autonomyPolicy.quietStart}
                                    onChange={(event) => void changeAutonomyPolicy({ quietStart: event.target.value })}
                                    disabled={savingAutonomyPolicy}
                                  />
                                </label>
                                <label>
                                  <span>Until</span>
                                  <input
                                    type="time"
                                    value={autonomyPolicy.quietEnd}
                                    onChange={(event) => void changeAutonomyPolicy({ quietEnd: event.target.value })}
                                    disabled={savingAutonomyPolicy}
                                  />
                                </label>
                                <small>{autonomyPolicy.timezone.replace(/_/g, " ")}</small>
                              </div>
                            )}
                            <button
                              type="button"
                              className="bots-setting-row bot-auto-approve"
                              role="switch"
                              aria-checked={autonomyPolicy.dailyDigestEnabled}
                              onClick={() => void changeAutonomyPolicy({ dailyDigestEnabled: !autonomyPolicy.dailyDigestEnabled })}
                              disabled={savingAutonomyPolicy}
                            >
                              <Bell size={17} />
                              <span>
                                <strong>Daily digest</strong>
                                <small>One local summary when routines finish or need attention. Uses no model.</small>
                              </span>
                              <span className="bot-toggle" aria-hidden="true"><span /></span>
                            </button>
                            {autonomyPolicy.dailyDigestEnabled && (
                              <div className="bot-quiet-hours bot-digest-time" aria-label="Daily digest time">
                                <label>
                                  <span>At</span>
                                  <input
                                    type="time"
                                    value={autonomyPolicy.dailyDigestTime}
                                    onChange={(event) => void changeAutonomyPolicy({ dailyDigestTime: event.target.value })}
                                    disabled={savingAutonomyPolicy}
                                  />
                                </label>
                                <small>{autonomyPolicy.timezone.replace(/_/g, " ")}</small>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="bots-setting-row bots-setting-status" aria-busy="true">
                            <CalendarClock size={17} />
                            <span><strong>Checking autonomy</strong><small>Reading this Mac&apos;s routine policy...</small></span>
                          </div>
                        )}
                      </section>
                    )}

                    <section className="bots-settings-group" aria-labelledby="bots-settings-project-title">
                      <header>
                        <h4 id="bots-settings-project-title">Project access</h4>
                        <p>Codelit asks only when a task needs local files.</p>
                      </header>
                      <button className="bots-setting-row" onClick={() => void connectProject()} disabled={hasAnyActiveRun}>
                        <FolderOpen size={17} />
                        <span><strong>{hasProject ? workspace.workspaceFolder?.path : "Choose a project"}</strong><small>{hasProject ? "Read-only access" : "No project connected"}</small></span>
                      </button>
                    </section>
                    {!isNativeRuntime() && <p className="settings-preview-note">Browser preview mode. Native providers and folder permissions are available in Codelit for Mac.</p>}
                  </div>
                )}

                {settingsSection === "intelligence" && (
                  <div className="bots-settings-page">
                    <Suspense fallback={<DeferredSurface label="Opening intelligence settings" />}>
                      <ProviderCenter
                        providers={providers}
                        credentials={apiCredentials}
                        busyProviderId={providerCredentialBusy || openingProvider}
                        apiKeyDrafts={apiKeyDrafts}
                        onApiKeyDraftChange={(provider, value) => setApiKeyDrafts((current) => ({
                          ...current,
                          [provider]: value,
                        }))}
                        onSaveApiKey={saveApiKey}
                        onDeleteApiKey={removeApiKey}
                        onSignIn={startProviderSignIn}
                        onOpenSetup={startProviderSetup}
                        onSetupLocalModel={setupOnDevice}
                        onDiscoverLocalModels={discoverLocalModels}
                        onOpenLocalModelPage={openLocalModelPage}
                        onCancelLocalModelSetup={cancelModelSetup}
                        setupState={modelSetup}
                      />
                    </Suspense>
                  </div>
                )}

                {settingsSection === "privacy" && (
                  <div className="bots-settings-page" aria-labelledby="bots-settings-privacy-title">
                    <header className="bots-settings-page-header">
                      <span>Control</span>
                      <h3 id="bots-settings-privacy-title">Privacy</h3>
                      <p>Manage website permissions and the data stored on this Mac.</p>
                    </header>

                    <section className="bots-settings-group" aria-labelledby="bots-settings-web-title">
                      <header>
                        <h4 id="bots-settings-web-title">Website access</h4>
                        <p>Read-only website inspection is available only in supported builds and follows your approval policy.</p>
                      </header>
                      {browserReadAvailable ? (
                        <button
                          type="button"
                          className="bots-setting-row bot-auto-approve"
                          role="switch"
                          aria-checked={safeAutoApprove}
                          onClick={() => void changeApprovalMode(!safeAutoApprove)}
                          disabled={savingApprovalMode || runState !== "idle"}
                        >
                          <ShieldCheck size={17} />
                          <span>
                            <strong>{savingApprovalMode ? "Saving approval mode..." : "Auto approve safe reads"}</strong>
                            <small>Skip prompts for public, read-only checks. Sensitive access and every action still ask.</small>
                          </span>
                          <span className="bot-toggle" aria-hidden="true"><span /></span>
                        </button>
                      ) : (
                        <div className="bots-setting-row bots-setting-status">
                          <ShieldCheck size={17} />
                          <span>
                            <strong>Agent website inspection</strong>
                            <small>Not included in this App Store build.</small>
                          </span>
                          <span className="settings-status-badge">App Store</span>
                        </div>
                      )}
                      {browserReadAvailable && browserDomains.length > 0 && (
                        <div className="bot-domain-scopes" aria-label={`Saved website domains for ${bot?.name || "this bot"}`}>
                          <span>Saved for {bot?.name}</span>
                          <div>
                            {browserDomains.map((domain) => (
                              <span className="bot-domain-scope" key={domain}>
                                {domain}
                                <button
                                  type="button"
                                  onClick={() => void removeBrowserDomain(domain)}
                                  disabled={savingApprovalMode || runState !== "idle"}
                                  aria-label={`Remove ${domain} from ${bot?.name || "this bot"}`}
                                >
                                  <X size={12} />
                                </button>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>

                    {computerUseAvailable && (
                      <section className="bots-settings-group" aria-labelledby="bots-settings-computer-title">
                        <header>
                          <h4 id="bots-settings-computer-title">Computer use</h4>
                          <p>When you name an approved app, its visible control labels go to the selected engine to plan one action. Every action still asks first.</p>
                        </header>
                        <div className="bots-setting-row bots-setting-status">
                          <Monitor size={17} />
                          <span>
                            <strong>{computerUseReadiness?.ready ? "Ready on this Mac" : "macOS permission needed"}</strong>
                            <small>{computerUseReadiness?.detail || "Checking Screen Recording and Accessibility..."}</small>
                          </span>
                          <span className="settings-status-badge">
                            {computerUseReadiness?.ready ? "Ready" : "Direct"}
                          </span>
                        </div>
                        {computerUseReadiness?.available && !computerUseReadiness.ready && (
                          <button
                            type="button"
                            className="bots-primary-button settings-setup"
                            onClick={() => void setupComputerUse()}
                            disabled={computerUseBusy}
                          >
                            <ShieldCheck size={16} />
                            {computerUseBusy
                              ? "Checking..."
                              : computerUseReadiness.accessibility !== "granted"
                                ? "Allow Accessibility"
                                : "Allow Screen Recording"}
                          </button>
                        )}
                        {computerUseReadiness?.ready && (
                          <>
                            {computerAppScopes.length > 0 && (
                              <div className="computer-app-scope-list" aria-label={`Apps available to ${bot.name}`}>
                                {computerAppScopes.map((scope) => (
                                  <div className="bots-setting-row computer-app-scope" key={scope.bundleId}>
                                    <Monitor size={16} />
                                    <span>
                                      <strong>{scope.appName}</strong>
                                      <small>Inspect visible controls and interact after approval</small>
                                    </span>
                                    <button
                                      type="button"
                                      className="bots-icon-button"
                                      onClick={() => void removeComputerApp(scope)}
                                      disabled={computerUseBusy}
                                      aria-label={`Remove ${scope.appName} access`}
                                      title="Remove app access"
                                    >
                                      <Trash2 size={15} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                            {unapprovedComputerApps.length > 0 ? (
                              <div className="computer-app-picker">
                                <label htmlFor="computer-app-choice">Add an open app</label>
                                <div>
                                  <select
                                    id="computer-app-choice"
                                    value={computerAppChoice}
                                    onChange={(event) => setComputerAppChoice(event.target.value)}
                                    disabled={computerUseBusy}
                                  >
                                    {unapprovedComputerApps.map((app) => (
                                      <option value={app.bundleId} key={app.bundleId}>
                                        {app.name}{app.active ? " (active)" : ""}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    className="bot-secondary-action"
                                    onClick={() => void allowComputerApp()}
                                    disabled={!computerAppChoice || computerUseBusy}
                                  >
                                    Allow
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <p>Open another app and return to Codelit to make it available to this bot.</p>
                            )}
                          </>
                        )}
                      </section>
                    )}

                    <section className="bots-settings-group" aria-labelledby="bots-settings-data-title">
                      <header>
                        <h4 id="bots-settings-data-title">Local data</h4>
                        <p>Your bots, conversations, and receipts stay on this Mac.</p>
                      </header>
                      <button
                        className="bots-setting-row"
                        onClick={() => void exportWorkspace()}
                        disabled={exporting || !isNativeRuntime()}
                      >
                        <Download size={17} />
                        <span>
                          <strong>{exporting ? "Exporting..." : "Export all local data"}</strong>
                          <small>Sign-ins and folder permissions are never included in the export.</small>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="bots-setting-row bot-pilot-toggle"
                        onClick={() => void togglePilotReport()}
                        disabled={Boolean(pilotAction) || !isNativeRuntime()}
                        aria-expanded={Boolean(pilotReport)}
                      >
                        <Activity size={17} />
                        <span>
                          <strong>{pilotAction === "loading" ? "Building private report..." : "Private product report"}</strong>
                          <small>Preview aggregate outcomes before choosing whether to export them.</small>
                        </span>
                        <ChevronDown size={15} aria-hidden="true" />
                      </button>
                      {pilotReport && (
                        <div className="bot-pilot-report">
                          <div className="bot-pilot-metrics" aria-label="Private product report summary">
                            <span>
                              <strong>{pilotReport.activation.firstRunCompleted ? "Passed" : pilotReport.activation.firstRunAttempted ? "Needs retry" : "Not run"}</strong>
                              <small>first run</small>
                            </span>
                            <span>
                              <strong>{pilotReport.runs.completed}</strong>
                              <small>completed runs</small>
                            </span>
                            <span>
                              <strong>{pilotReport.runs.repeatTaskWithinSevenDays ? "Yes" : "Not yet"}</strong>
                              <small>repeat use</small>
                            </span>
                            <span>
                              <strong>{pilotReport.routines.reused ? "Yes" : "Not yet"}</strong>
                              <small>routine reused</small>
                            </span>
                            <span>
                              <strong>{pilotReport.delegations.completed}</strong>
                              <small>handoffs completed</small>
                            </span>
                            <span>
                              <strong>{pilotReport.approvals.resolved}/{pilotReport.approvals.requested}</strong>
                              <small>approvals resolved</small>
                            </span>
                          </div>
                          <p className="bot-pilot-privacy">
                            This stays on your Mac until you export it. Prompts, URLs, files, screenshots, memories, credentials, and model output are excluded.
                          </p>
                          <div className="bot-pilot-actions">
                            <button
                              type="button"
                              className="bot-secondary-action"
                              onClick={() => void exportPilotReport()}
                              disabled={Boolean(pilotAction)}
                            >
                              <Download size={14} /> {pilotAction === "exporting" ? "Exporting..." : "Export JSON"}
                            </button>
                          </div>
                          <details className="bot-pilot-safety">
                            <summary><CircleAlert size={14} /> Report an unexpected action</summary>
                            <p>Only the category and time are stored locally. No description or work content is collected.</p>
                            <div>
                              <select
                                aria-label="Unexpected action category"
                                value={unexpectedActionCategory}
                                onChange={(event) => setUnexpectedActionCategory(event.target.value as UnexpectedActionCategory)}
                                disabled={Boolean(pilotAction)}
                              >
                                {UNEXPECTED_ACTION_OPTIONS.map((option) => (
                                  <option value={option.value} key={option.value}>{option.label}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="bot-secondary-action"
                                onClick={() => void reportUnexpectedAction()}
                                disabled={Boolean(pilotAction)}
                              >
                                {pilotAction === "reporting" ? "Recording..." : "Record locally"}
                              </button>
                            </div>
                            {pilotReport.unexpectedActions.total > 0 && (
                              <small>{pilotReport.unexpectedActions.total} unexpected {pilotReport.unexpectedActions.total === 1 ? "action" : "actions"} recorded.</small>
                            )}
                          </details>
                        </div>
                      )}
                      <button
                        type="button"
                        className="bots-setting-row bots-danger-row"
                        onClick={() => {
                          setDeleteWorkspaceOpen((current) => !current);
                          setDeleteWorkspaceConfirmation("");
                          setDeleteWorkspaceError(null);
                        }}
                        disabled={deletingWorkspace}
                        aria-expanded={deleteWorkspaceOpen}
                      >
                        <Trash2 size={17} />
                        <span>
                          <strong>Delete local workspace</strong>
                          <small>Remove every Codelit-owned record from this Mac without changing your project files.</small>
                        </span>
                        <ChevronDown size={15} aria-hidden="true" />
                      </button>
                      {deleteWorkspaceOpen && (
                        <div
                          ref={deleteWorkspacePanelRef}
                          className="bots-delete-confirmation"
                          role="region"
                          aria-labelledby="bots-delete-title"
                        >
                          <strong id="bots-delete-title">Delete all local Codelit data?</strong>
                          <p>
                            This removes bots, conversations, memories, skills, routines, tables, receipts,
                            downloaded models, saved credentials, and Codelit folder permissions. Files inside
                            selected project folders remain untouched.
                          </p>
                          <label htmlFor="bots-delete-confirmation">Type DELETE to continue</label>
                          <input
                            ref={deleteWorkspaceInputRef}
                            id="bots-delete-confirmation"
                            value={deleteWorkspaceConfirmation}
                            onChange={(event) => {
                              setDeleteWorkspaceConfirmation(event.target.value);
                              setDeleteWorkspaceError(null);
                            }}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={deletingWorkspace}
                          />
                          {deleteWorkspaceError && <p className="bots-delete-error" role="alert">{deleteWorkspaceError}</p>}
                          <footer>
                            <button
                              type="button"
                              className="bot-secondary-action"
                              onClick={resetDeleteWorkspace}
                              disabled={deletingWorkspace}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="bots-danger-button"
                              onClick={() => void deleteWorkspace()}
                              disabled={deleteWorkspaceConfirmation !== "DELETE" || deletingWorkspace || !isNativeRuntime()}
                            >
                              <Trash2 size={14} />
                              {deletingWorkspace ? "Deleting..." : "Delete local data"}
                            </button>
                          </footer>
                        </div>
                      )}
                    </section>
                    {!isNativeRuntime() && <p className="settings-preview-note">Browser preview mode. Export is available in Codelit for Mac.</p>}
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function routineTiming(schedule: LocalSchedule) {
  if (schedule.enabled && schedule.nextDueAt) {
    return `next ${new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(schedule.nextDueAt))}`;
  }
  return readBotRoutineSnapshot(schedule)?.triggerLabel || `${schedule.cadence} at ${schedule.localTime}`;
}

function routineStateForBot(
  schedules: LocalSchedule[],
  eventRoutines: BotEventRoutine[],
  botId: string,
) {
  const botSchedules = routinesForBot(schedules, botId);
  const botEvents = eventRoutines.filter((routine) => routine.botId === botId);
  const nextSchedule = botSchedules.find((routine) => routine.enabled);
  const nextEvent = botEvents.find((routine) => routine.enabled);
  return {
    ids: [...botSchedules.map((routine) => routine.id), ...botEvents.map((routine) => routine.id)],
    enabled: Boolean(nextSchedule || nextEvent),
    latestStatus: nextSchedule
      ? `${nextSchedule.title} ${routineTiming(nextSchedule)}`
      : nextEvent
        ? `Watching ${nextEvent.title}`
        : "Routines paused · Ready for a task",
  };
}

function BotGoalCard({
  goal,
  disabled,
  onComplete,
}: {
  goal: BotGoal;
  disabled: boolean;
  onComplete: () => void;
}) {
  return (
    <section className="bot-goal-card" data-status={goal.status} aria-label="Bot goal">
      <span className="bot-initiative-icon"><Target size={16} /></span>
      <div>
        <small>{goal.status === "completed" ? "Goal completed" : "Current goal"}</small>
        <strong>{goal.outcome}</strong>
        <span>{goal.nextAction}</span>
      </div>
      {goal.status !== "completed" && (
        <button
          type="button"
          className="bots-icon-button"
          onClick={onComplete}
          disabled={disabled}
          aria-label="Mark goal complete"
          title="Mark goal complete"
        >
          <Check size={16} />
        </button>
      )}
    </section>
  );
}

function BotRoutineCard({
  schedule,
  busy,
  onStart,
  onPause,
  onRemove,
}: {
  schedule: LocalSchedule;
  busy: boolean;
  onStart: () => void;
  onPause: () => void;
  onRemove: () => void;
}) {
  const snapshot = readBotRoutineSnapshot(schedule);
  const state = schedule.pausedReason
    ? schedule.pausedReason
    : schedule.enabled
      ? routineTiming(schedule)
      : "Ready to start";
  return (
    <article className="bot-routine-card" data-enabled={schedule.enabled}>
      <span className="bot-initiative-icon"><CalendarClock size={16} /></span>
      <div className="bot-routine-copy">
        <small>{snapshot?.triggerLabel || "Reviewed routine"}</small>
        <strong>{schedule.title}</strong>
        <span title={state}>{state}</span>
      </div>
      <div className="bot-routine-actions">
        <button
          type="button"
          className="bot-routine-toggle"
          onClick={schedule.enabled ? onPause : onStart}
          disabled={busy}
        >
          {schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
          {busy ? "Saving" : schedule.enabled ? "Pause" : "Start"}
        </button>
        <button
          type="button"
          className="bots-icon-button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove ${schedule.title}`}
          title="Remove routine"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}

function BotEventRoutineCard({
  routine,
  busy,
  onStart,
  onPause,
  onRemove,
}: {
  routine: BotEventRoutine;
  busy: boolean;
  onStart: () => void;
  onPause: () => void;
  onRemove: () => void;
}) {
  const state = routine.pausedReason
    ? routine.pausedReason
    : routine.enabled
      ? routine.lastTruncated
        ? "Watching the first 10,000 project files"
        : `Watching ${routine.lastFileCount ?? "bounded"} project files`
      : "Ready to start";
  return (
    <article className="bot-routine-card" data-enabled={routine.enabled}>
      <span className="bot-initiative-icon"><FolderSync size={16} /></span>
      <div className="bot-routine-copy">
        <small>{routine.trigger.label}</small>
        <strong>{routine.title}</strong>
        <span title={state}>{state}</span>
      </div>
      <div className="bot-routine-actions">
        <button
          type="button"
          className="bot-routine-toggle"
          onClick={routine.enabled ? onPause : onStart}
          disabled={busy}
        >
          {routine.enabled ? <Pause size={14} /> : <Play size={14} />}
          {busy ? "Saving" : routine.enabled ? "Pause" : "Start"}
        </button>
        <button
          type="button"
          className="bots-icon-button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove ${routine.title}`}
          title="Remove routine"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}

function BotThreadBlock({
  block,
  bot,
}: {
  block: ThreadBlock;
  bot: LocalBotRecord;
}) {
  if (block.type === "user-message") {
    return <div className="bot-message user"><p>{block.text}</p></div>;
  }
  if (block.type === "assistant-message") {
    return (
      <div className="bot-message assistant">
        <BotAvatar avatar={avatarForBot(bot)} size="small" />
        <RichBotMarkdown>{block.text}</RichBotMarkdown>
      </div>
    );
  }
  if (block.type === "run") {
    if (block.status === "completed") return null;
    const detail = block.detail || block.label;
    return (
      <div className={`bot-run-card ${block.status}`}>
        <CircleAlert size={16} />
        <div><strong>Run stopped</strong><span>{detail}</span></div>
      </div>
    );
  }
  if (block.type === "receipt") {
    return null;
  }
  if (block.type === "error") {
    return <div className="bot-run-card failed"><CircleAlert size={16} /><div><strong>{block.title}</strong><span>{block.detail}</span></div></div>;
  }
  return null;
}
