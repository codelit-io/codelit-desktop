import {
  ArrowLeft,
  ArrowUp,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  FolderOpen,
  Gauge,
  HardDrive,
  Home,
  ListChecks,
  Menu,
  Network,
  PanelLeftClose,
  Pause,
  Play,
  Plus,
  Settings2,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LiveRunApprovalDecision } from "@/lib/agent-live-run";
import type { ThreadBlock, WorkspaceArtifactKind } from "@/lib/workspace-thread";
import "./App.css";
import type {
  ArchitecturePayload,
  AgentTeamPayload,
  BackgroundServiceProbe,
  ClaimedScheduleOccurrence,
  DesktopCloudCapabilityId,
  DesktopCloudLink,
  DesktopCloudStatus,
  DesktopCloudSyncView,
  DesktopCloudTransferIntent,
  IntelligenceSelection,
  LocalArtifactVersion,
  LocalMcpInspection,
  LocalMcpServer,
  LocalMcpServerDraft,
  LocalSchedule,
  LocalNotificationRoute,
  LocalSurface,
  LocalWorkspaceSnapshot,
  ModelManagerAction,
  ProductPlanPayload,
  ProviderModel,
  ProviderProbe,
  ProviderRunEvent,
  ProviderTaskResult,
  SaveLocalScheduleRequest,
} from "./contracts";
import { parseLocalMcpToolReference } from "./contracts";
import type { LocalAgentApprovalRequest } from "./local-agent-team-runtime";
import EnginePicker, { firstRunnableSelection } from "./components/EnginePicker";
import DesktopCloudSettings from "./components/DesktopCloudSettings";
import DesktopUpdateSettings from "./components/DesktopUpdateSettings";
import HostedCapabilityMenu from "./components/HostedCapabilityMenu";
import LocalMcpSettings, { type LocalMcpAction } from "./components/LocalMcpSettings";
import LocalSchedulePanel from "./components/LocalSchedulePanel";
import {
  appendThreadMessage,
  bootstrapWorkspace,
  cancelIntelligenceTask,
  claimDueLocalSchedules,
  consumeLocalNotification,
  chooseWorkspaceFolder,
  chooseLocalMcpExecutable,
  deleteLocalMcpServer,
  deleteLocalWorkspace,
  exportLocalWorkspace,
  importLocalWorkspace,
  inspectLocalMcpServer,
  isNativeRuntime,
  listDesktopCloudLinks,
  listLocalMcpServers,
  listLocalSchedules,
  manageLocalModel,
  openDesktopCloudHref,
  probeBackgroundService,
  probeDesktopCloud,
  probeLocalProviders,
  recordProviderRun,
  runIntelligenceTask,
  runProviderHealthCheck,
  saveArtifact,
  saveLocalMcpServer,
  saveLocalSchedule,
  setBackgroundWorkEnabled,
  setLocalScheduleEnabled,
  showLocalNotification,
  startDesktopCloudPairing,
  finishDesktopCloudPairing,
  disconnectDesktopCloud,
  syncDesktopCloud,
  takeOpenedLocalNotification,
  deleteLocalSchedule,
  openBackgroundWorkSettings,
} from "./runtime";
import ArchitectureWorkbench from "./workbenches/ArchitectureWorkbench";
import ProductPlanWorkbench from "./workbenches/ProductPlanWorkbench";

const AgentTeamWorkbench = lazy(() => import("./workbenches/AgentTeamWorkbench"));

const SURFACES: Array<{
  id: LocalSurface;
  label: string;
  shortLabel: string;
  kind?: WorkspaceArtifactKind;
  icon: typeof Home;
}> = [
  { id: "home", label: "Home", shortLabel: "Home", icon: Home },
  { id: "agent-team", label: "Agent Teams", shortLabel: "Team", kind: "agent-team", icon: Users },
  { id: "product-plan", label: "Product Plan", shortLabel: "Plan", kind: "product-plan", icon: ListChecks },
  { id: "architecture", label: "Architecture", shortLabel: "Arch", kind: "architecture", icon: Network },
];

type BusyState = "idle" | "saving" | "running";
type StorageAction = "exporting" | "importing" | "deleting" | null;
type AgentRunStatus = "idle" | "running" | "awaiting-approval" | "completed" | "halted";

interface AgentRunRecovery {
  runId: string;
  artifactVersion: string;
  resumeFrom: import("@/lib/agent-live-run").LiveRunResume;
}

function surfaceForKind(kind: WorkspaceArtifactKind | "bot" | "activity"): LocalSurface | null {
  if (kind === "agent-team" || kind === "product-plan" || kind === "architecture") return kind;
  return null;
}

function titleForSurface(surface: LocalSurface) {
  return SURFACES.find((candidate) => candidate.id === surface)?.label || "Codelit";
}

function artifactKindForSchedule(schedule: LocalSchedule): LocalNotificationRoute["artifactKind"] {
  if (!schedule.snapshot || typeof schedule.snapshot !== "object" || !("artifactKind" in schedule.snapshot)) {
    return "agent-team";
  }
  const kind = schedule.snapshot.artifactKind;
  return kind === "product-plan" || kind === "architecture" ? kind : "agent-team";
}

function notificationBody(value: string) {
  const body = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return body.slice(0, 500) || "Open Codelit to inspect the local run receipt.";
}

export default function App() {
  const [snapshot, setSnapshot] = useState<LocalWorkspaceSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderProbe[]>([]);
  const [mcpServers, setMcpServers] = useState<LocalMcpServer[]>([]);
  const [mcpAction, setMcpAction] = useState<LocalMcpAction | null>(null);
  const [surface, setSurface] = useState<LocalSurface>("home");
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 820);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [schedulePanelOpen, setSchedulePanelOpen] = useState(false);
  const [scheduleReviewId, setScheduleReviewId] = useState<string | null>(null);
  const [hostedCapabilityIntent, setHostedCapabilityIntent] = useState<DesktopCloudTransferIntent | null>(null);
  const [prompt, setPrompt] = useState("");
  const [selectedEngine, setSelectedEngine] = useState<IntelligenceSelection | null>(null);
  const [runEvents, setRunEvents] = useState<ProviderRunEvent[]>([]);
  const [providerChecks, setProviderChecks] = useState<Record<string, ProviderTaskResult>>({});
  const [providerProgress, setProviderProgress] = useState<Record<string, ProviderRunEvent>>({});
  const [checkingProvider, setCheckingProvider] = useState<string | null>(null);
  const [modelOperation, setModelOperation] = useState<{
    key: string;
    action: ModelManagerAction;
    runId?: string;
    message?: string;
  } | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [storageAction, setStorageAction] = useState<StorageAction>(null);
  const [backgroundService, setBackgroundService] = useState<BackgroundServiceProbe | null>(null);
  const [schedules, setSchedules] = useState<LocalSchedule[]>([]);
  const [cloudStatus, setCloudStatus] = useState<DesktopCloudStatus | null>(null);
  const [cloudSync, setCloudSync] = useState<DesktopCloudSyncView | null>(null);
  const [cloudLinks, setCloudLinks] = useState<DesktopCloudLink[]>([]);
  const [cloudWorking, setCloudWorking] = useState<"connecting" | "syncing" | "disconnecting" | null>(null);
  const [cloudIssue, setCloudIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyState>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentRunStatus, setAgentRunStatus] = useState<AgentRunStatus>("idle");
  const [activeAgentStep, setActiveAgentStep] = useState<number | null>(null);
  const [agentApproval, setAgentApproval] = useState<LocalAgentApprovalRequest | null>(null);
  const activeRunController = useRef<AbortController | null>(null);
  const approvalResolver = useRef<((decision: LiveRunApprovalDecision) => void) | null>(null);
  const snapshotRef = useRef<LocalWorkspaceSnapshot | null>(null);
  const providersRef = useRef<ProviderProbe[]>([]);
  const mcpServersRef = useRef<LocalMcpServer[]>([]);
  const busyRef = useRef<BusyState>("idle");
  const scheduleWorkerActive = useRef(false);
  const cloudSyncActive = useRef(false);
  const lastCloudSyncAt = useRef(0);

  const openNotificationRoute = useCallback((route: LocalNotificationRoute) => {
    const current = snapshotRef.current;
    if (!current || route.threadId !== current.thread.id) return false;
    const nextSurface = surfaceForKind(route.artifactKind);
    if (nextSurface) setSurface(nextSurface);
    setSettingsOpen(false);
    setSchedulePanelOpen(false);
    setNotice("Opened the scheduled run and its local receipt");
    void consumeLocalNotification(route.id);
    return true;
  }, []);

  const applyCloudSync = useCallback(async (view: DesktopCloudSyncView, announce: boolean) => {
    snapshotRef.current = view.workspace;
    setSnapshot(view.workspace);
    setCloudSync(view);
    setCloudLinks(view.promotions);
    setCloudIssue(null);
    lastCloudSyncAt.current = Date.now();
    await Promise.all(view.importedResults.map((result) => showLocalNotification({
      threadId: result.threadId,
      artifactId: result.artifactId,
      artifactKind: result.artifactKind,
      runId: result.runId,
      title: "Codelit Cloud run ready",
      body: "Open Codelit to review the verified local receipt.",
    }).catch(() => undefined)));
    if (view.importedResults.length > 0) {
      setNotice(`${view.importedResults.length} hosted result${view.importedResults.length === 1 ? "" : "s"} returned to this Mac`);
    } else if (announce) {
      setNotice("Codelit Cloud is up to date");
    }
  }, []);

  const refreshCloud = useCallback(async (announce = false) => {
    if (cloudSyncActive.current) return;
    cloudSyncActive.current = true;
    setCloudWorking("syncing");
    try {
      await applyCloudSync(await syncDesktopCloud(), announce);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setCloudIssue(message);
      const nextStatus = await probeDesktopCloud().catch(() => null);
      if (nextStatus) setCloudStatus(nextStatus);
    } finally {
      cloudSyncActive.current = false;
      setCloudWorking(null);
    }
  }, [applyCloudSync]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      bootstrapWorkspace(),
      probeLocalProviders(),
      probeBackgroundService(),
      listLocalMcpServers(),
      listLocalSchedules(),
    ])
      .then(([nextSnapshot, nextProviders, nextBackgroundService, nextMcpServers, nextSchedules]) => {
        if (!active) return;
        snapshotRef.current = nextSnapshot;
        providersRef.current = nextProviders;
        mcpServersRef.current = nextMcpServers;
        setSnapshot(nextSnapshot);
        setProviders(nextProviders);
        setBackgroundService(nextBackgroundService);
        setMcpServers(nextMcpServers);
        setSchedules(nextSchedules);
        setSelectedEngine(firstRunnableSelection(nextProviders));
        const activeRunId = nextSnapshot.thread.activeRunRef;
        if (activeRunId
          && nextSnapshot.runCheckpoints.some((checkpoint) => checkpoint.runId === activeRunId)
          && !nextSnapshot.receipts.some((receipt) => receipt.runId === activeRunId)) {
          setAgentRunStatus("halted");
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    void Promise.all([probeDesktopCloud(), listDesktopCloudLinks()])
      .then(([nextStatus, nextLinks]) => {
        if (!active) return;
        setCloudStatus(nextStatus);
        setCloudLinks(nextLinks);
      })
      .catch((reason: unknown) => {
        if (active) setCloudIssue(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [refreshCloud]);

  useEffect(() => {
    if (cloudStatus?.status !== "pending") return;
    let disposed = false;
    const finish = async () => {
      try {
        const nextStatus = await finishDesktopCloudPairing();
        if (disposed) return;
        setCloudStatus(nextStatus);
        if (nextStatus.status === "connected") {
          setCloudIssue(null);
          void refreshCloud(true);
        }
      } catch (reason) {
        if (!disposed) setCloudIssue(reason instanceof Error ? reason.message : String(reason));
      }
    };
    const timer = window.setInterval(() => void finish(), 5_000);
    void finish();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [cloudStatus?.status, refreshCloud]);

  useEffect(() => {
    if (cloudStatus?.status !== "connected") return;
    const maybeSync = () => {
      if (
        document.visibilityState !== "visible"
        || !navigator.onLine
        || !snapshotRef.current
        || busyRef.current !== "idle"
        || Date.now() - lastCloudSyncAt.current < 60_000
      ) return;
      void refreshCloud();
    };
    const onVisibility = () => maybeSync();
    const timer = window.setInterval(maybeSync, 60_000);
    window.addEventListener("focus", maybeSync);
    window.addEventListener("online", maybeSync);
    document.addEventListener("visibilitychange", onVisibility);
    maybeSync();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", maybeSync);
      window.removeEventListener("online", maybeSync);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [cloudStatus?.status, refreshCloud, snapshot?.thread.id]);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<LocalNotificationRoute>("local-notification-open", (event) => {
      if (!disposed) openNotificationRoute(event.payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openNotificationRoute]);

  useEffect(() => {
    if (!snapshotRef.current) return;
    let disposed = false;
    void takeOpenedLocalNotification().then((route) => {
      if (!disposed && route) openNotificationRoute(route);
    });
    return () => {
      disposed = true;
    };
  }, [openNotificationRoute, snapshot?.thread.id]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    providersRef.current = providers;
  }, [providers]);

  useEffect(() => {
    mcpServersRef.current = mcpServers;
  }, [mcpServers]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (backgroundService?.status !== "enabled") return;
    const owner = `app-${crypto.randomUUID()}`;
    let disposed = false;

    const runClaim = async (claim: ClaimedScheduleOccurrence) => {
      const currentSnapshot = snapshotRef.current;
      if (!currentSnapshot) return;
      const controller = new AbortController();
      activeRunController.current = controller;
      scheduleWorkerActive.current = true;
      busyRef.current = "running";
      setBusy("running");
      setRunEvents([]);
      setError(null);

      const notify = async (title: string, body: string) => {
        await showLocalNotification({
          threadId: claim.schedule.threadId,
          artifactId: claim.schedule.artifactId,
          artifactKind: artifactKindForSchedule(claim.schedule),
          runId: claim.runId,
          title,
          body: notificationBody(body),
        }).catch(() => undefined);
      };

      try {
        const { runClaimedLocalSchedule } = await import("./local-scheduler");
        const completed = await runClaimedLocalSchedule({
          claim,
          snapshot: currentSnapshot,
          providers: providersRef.current,
          mcpServers: mcpServersRef.current,
          controller,
          onSnapshot(nextSnapshot) {
            snapshotRef.current = nextSnapshot;
            setSnapshot(nextSnapshot);
          },
          onEvent(event) {
            setRunEvents((current) => [...current, event].slice(-120));
          },
          onApprovalRequired(title) {
            setNotice(`${title} is waiting for your approval. Open the Agent Team to review it.`);
          },
        });
        snapshotRef.current = completed.snapshot;
        setSnapshot(completed.snapshot);
        const notificationTitle = completed.status === "completed"
          ? `${claim.schedule.title} completed`
          : completed.status === "approval-required"
            ? `${claim.schedule.title} needs approval`
            : `${claim.schedule.title} paused`;
        await notify(notificationTitle, completed.detail);
        setNotice(notificationTitle);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (!controller.signal.aborted) {
          setError(message);
          await notify(`${claim.schedule.title} paused`, message);
        }
      } finally {
        activeRunController.current = null;
        scheduleWorkerActive.current = false;
        busyRef.current = "idle";
        setBusy("idle");
        const [nextSchedules, nextBackground] = await Promise.all([
          listLocalSchedules(),
          probeBackgroundService(),
        ]).catch(() => [null, null] as const);
        if (!disposed && nextSchedules) setSchedules(nextSchedules);
        if (!disposed && nextBackground) setBackgroundService(nextBackground);
      }
    };

    const checkDueSchedules = async () => {
      if (
        disposed
        || scheduleWorkerActive.current
        || activeRunController.current
        || busyRef.current !== "idle"
        || !snapshotRef.current
      ) return;
      try {
        const probe = await probeBackgroundService();
        if (disposed) return;
        setBackgroundService(probe);
        if (probe.status !== "enabled") return;
        const claims = await claimDueLocalSchedules(owner, 1, navigator.onLine);
        if (!disposed && claims[0]) await runClaim(claims[0]);
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };

    const onWake = () => void checkDueSchedules();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void checkDueSchedules();
    };
    const timer = window.setInterval(() => void checkDueSchedules(), 30_000);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onVisibility);
    void checkDueSchedules();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [backgroundService?.status]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (settingsOpen) setSettingsOpen(false);
      else if (schedulePanelOpen) setSchedulePanelOpen(false);
      else if (window.innerWidth < 820 && sidebarOpen) setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [schedulePanelOpen, settingsOpen, sidebarOpen]);

  const currentArtifact = useMemo(() => {
    const kind = SURFACES.find((candidate) => candidate.id === surface)?.kind;
    return kind ? snapshot?.artifacts.find((artifact) => artifact.kind === kind) : undefined;
  }, [snapshot, surface]);

  const recoverableAgentCheckpoint = useMemo(() => {
    const runId = snapshot?.thread.activeRunRef;
    if (!snapshot || !runId || snapshot.receipts.some((receipt) => receipt.runId === runId)) return null;
    return snapshot.runCheckpoints.find((checkpoint) => checkpoint.runId === runId) || null;
  }, [snapshot]);

  const navigate = (next: LocalSurface) => {
    setSurface(next);
    setSettingsOpen(false);
    setSchedulePanelOpen(false);
    setHostedCapabilityIntent(null);
    if (window.innerWidth < 820) setSidebarOpen(false);
  };

  const submitPrompt = async () => {
    if (!snapshot || !prompt.trim() || busy !== "idle") return;
    if (!selectedEngine) {
      setSettingsOpen(true);
      setError("Choose or finish setting up a local intelligence engine first.");
      return;
    }
    const submitted = prompt.trim();
    setBusy("running");
    setError(null);
    setRunEvents([]);
    try {
      const withUserMessage = await appendThreadMessage(snapshot, submitted);
      setSnapshot(withUserMessage);
      setPrompt("");
      const capturedEvents: ProviderRunEvent[] = [];
      const result = await runIntelligenceTask(selectedEngine, submitted, (event) => {
        capturedEvents.push(event);
        setRunEvents((current) => [...current, event].slice(-120));
      }, snapshot.workspaceFolder?.path);
      let completedSnapshot = withUserMessage;
      if (result.status === "completed" && result.structuredOutput) {
        const answer = [
          result.structuredOutput.summary,
          ...result.structuredOutput.items.map((item) => `- ${item}`),
        ].join("\n");
        completedSnapshot = await appendThreadMessage(withUserMessage, answer, "assistant");
      }
      completedSnapshot = await recordProviderRun(
        completedSnapshot,
        "artifact-plan-ship-local",
        result,
        capturedEvents,
      );
      setSnapshot(completedSnapshot);
      if (result.status !== "completed" || !result.structuredOutput) throw new Error(result.text);
      setNotice(`Completed locally with ${providers.find((provider) => provider.id === result.provider)?.label || result.provider}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("idle");
    }
  };

  const persistArtifact = async (artifact: LocalArtifactVersion, title: string, payload: unknown) => {
    if (!snapshot || busy !== "idle") return;
    setBusy("saving");
    setError(null);
    try {
      setSnapshot(await saveArtifact(snapshot, artifact, title, payload));
      setNotice("Version saved locally");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("idle");
    }
  };

  const runArtifact = async (task: string, engine: IntelligenceSelection | null = selectedEngine) => {
    if (!snapshot || !currentArtifact || busy !== "idle") return;
    if (!engine) {
      setSettingsOpen(true);
      setError("Choose or finish setting up a local intelligence engine first.");
      return;
    }
    setBusy("running");
    setError(null);
    setRunEvents([]);
    try {
      const capturedEvents: ProviderRunEvent[] = [];
      const result = await runIntelligenceTask(engine, task, (event) => {
        capturedEvents.push(event);
        setRunEvents((current) => [...current, event].slice(-120));
      }, snapshot.workspaceFolder?.path);
      setSnapshot(await recordProviderRun(snapshot, currentArtifact.artifactId, result, capturedEvents));
      if (result.status !== "completed") throw new Error(result.text);
      setNotice("Local run completed with a receipt");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("idle");
    }
  };

  const runAgentTeam = async (
    title: string,
    team: AgentTeamPayload,
    engine: IntelligenceSelection | null,
    recovery?: AgentRunRecovery,
  ) => {
    if (!snapshot || !currentArtifact || busy !== "idle") return;
    if (!engine) {
      setSettingsOpen(true);
      setError("Choose or finish setting up a local intelligence engine first.");
      return;
    }
    const needsProjectFolder = team.agents.some((agent) => agent.tools.some((tool) => {
      if (tool === "Browser read" || tool === "Browser act") return false;
      const reference = parseLocalMcpToolReference(tool);
      if (!reference) return true;
      return mcpServers.find((server) => server.id === reference.serverId)?.config.projectAccess === true;
    }));
    if (needsProjectFolder && !snapshot.workspaceFolder?.accessValidated) {
      setSettingsOpen(true);
      setError("Choose the project folder once so this Team can use its local tools.");
      return;
    }

    const controller = new AbortController();
    activeRunController.current = controller;
    setBusy("running");
    setError(null);
    setRunEvents([]);
    setAgentApproval(null);
    setAgentRunStatus("running");
    try {
      const saved = recovery
        ? snapshot
        : await saveArtifact(snapshot, currentArtifact, title, team);
      setSnapshot(saved);
      const { runLocalAgentTeam } = await import("./local-agent-team-runtime");
      const runArtifact = recovery
        ? { ...currentArtifact, title, version: recovery.artifactVersion, payload: team }
        : saved.artifacts.find((artifact) => artifact.artifactId === currentArtifact.artifactId) || currentArtifact;
      const output = await runLocalAgentTeam({
        snapshot: saved,
        artifact: runArtifact,
        title,
        team,
        providers,
        fallbackEngine: engine,
        signal: controller.signal,
        ...(recovery ? { runId: recovery.runId, resumeFrom: recovery.resumeFrom } : {}),
        callbacks: {
          onSnapshot: setSnapshot,
          onEvent(event) {
            setRunEvents((current) => [...current, event].slice(-120));
          },
          onStepChange: setActiveAgentStep,
          awaitApproval(request) {
            setAgentApproval(request);
            setAgentRunStatus("awaiting-approval");
            return new Promise((resolve) => {
              approvalResolver.current = resolve;
            });
          },
        },
      });
      setSnapshot(output.snapshot);
      setAgentRunStatus(output.transcript.status === "completed" ? "completed" : "halted");
      setNotice(output.transcript.status === "completed"
        ? "Agent Team completed locally with a receipt"
        : "Agent Team stopped safely; completed work was preserved");
    } catch (reason) {
      setAgentRunStatus("halted");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      approvalResolver.current = null;
      activeRunController.current = null;
      setAgentApproval(null);
      setActiveAgentStep(null);
      setBusy("idle");
    }
  };

  const resumeAgentTeam = async () => {
    if (!snapshot || !currentArtifact || !recoverableAgentCheckpoint || busy !== "idle") return;
    setError(null);
    try {
      const { readLocalAgentTeamCheckpoint } = await import("./local-agent-team-runtime");
      const recovery = readLocalAgentTeamCheckpoint(
        recoverableAgentCheckpoint.runId,
        recoverableAgentCheckpoint.body,
      );
      if (!recovery || recovery.context.artifactId !== currentArtifact.artifactId) {
        throw new Error("This saved run cannot be resumed. Start a fresh Team run instead.");
      }
      const savedEngineReady = providers.some((provider) => (
        provider.id === recovery.context.fallbackEngine.provider
        && provider.canRun
        && provider.models.some((model) => (
          model.id === recovery.context.fallbackEngine.model && model.status === "ready"
        ))
      ));
      const engine = savedEngineReady ? recovery.context.fallbackEngine : selectedEngine;
      if (!engine) {
        setSettingsOpen(true);
        throw new Error("Choose a ready local intelligence engine before resuming this run.");
      }
      if (!savedEngineReady) {
        setNotice(`The saved engine is unavailable. Resuming with ${engine.provider}/${engine.model}.`);
      }
      setSelectedEngine(engine);
      await runAgentTeam(
        recovery.context.title,
        recovery.context.team,
        engine,
        {
          runId: recovery.runId,
          artifactVersion: recovery.context.artifactVersion,
          resumeFrom: recovery.resumeFrom,
        },
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const decideAgentApproval = (decision: LiveRunApprovalDecision) => {
    const resolve = approvalResolver.current;
    if (!resolve) return;
    approvalResolver.current = null;
    setAgentApproval(null);
    setAgentRunStatus("running");
    resolve(decision);
  };

  const testProvider = async (providerId: string) => {
    if (checkingProvider) return;
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    setCheckingProvider(providerId);
    setError(null);
    try {
      const result = await runProviderHealthCheck(provider, (event) => {
        setProviderProgress((current) => ({ ...current, [providerId]: event }));
      });
      setProviderChecks((current) => ({ ...current, [providerId]: result }));
      if (result.status === "completed") {
        setNotice(`${providers.find((provider) => provider.id === providerId)?.label || providerId} is ready`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCheckingProvider(null);
    }
  };

  const manageModel = async (
    providerId: ProviderProbe["id"],
    modelId: string,
    action: ModelManagerAction,
  ) => {
    if (modelOperation) return;
    const key = `${providerId}:${modelId}`;
    setModelOperation({ key, action });
    setError(null);
    try {
      const { model } = await manageLocalModel(providerId, modelId, action, (event) => {
        setModelOperation((current) => current?.key === key
          ? { ...current, runId: event.runId, message: event.message }
          : current);
      });
      const nextProviders = await probeLocalProviders();
      setProviders(nextProviders);
      setSelectedEngine((current) => {
        const stillReady = current && nextProviders.some((provider) => (
          provider.id === current.provider
          && provider.canRun
          && provider.models.some((model) => model.id === current.model && model.status === "ready")
        ));
        return stillReady ? current : firstRunnableSelection(nextProviders);
      });
      setNotice(action === "delete"
        ? "On-device model removed"
        : action === "benchmark" && model.status !== "ready"
          ? "Benchmark finished; this model stays limited to compatible work"
          : action === "benchmark"
            ? "On-device benchmark refreshed"
            : "On-device model is ready");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.toLowerCase().includes("canceled")) setNotice("Model action paused");
      else setError(message);
    } finally {
      setModelOperation(null);
    }
  };

  const cancelActiveRun = async () => {
    activeRunController.current?.abort();
    if (approvalResolver.current) decideAgentApproval("hold");
    const latest = runEvents.at(-1);
    if (latest && !["completed", "failed", "canceled"].includes(latest.eventType)) {
      await cancelIntelligenceTask(latest.runId);
    }
  };

  const pauseModelOperation = async () => {
    if (modelOperation?.runId) await cancelIntelligenceTask(modelOperation.runId);
  };

  const selectWorkspaceFolder = async () => {
    if (choosingFolder) return;
    setChoosingFolder(true);
    setError(null);
    try {
      const next = await chooseWorkspaceFolder();
      if (next) {
        setSnapshot(next);
        setNotice(next.workspaceFolder?.accessValidated
          ? "Read-only folder access saved on this Mac"
          : "Folder selected, but macOS access needs to be restored");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChoosingFolder(false);
    }
  };

  const exportWorkspace = async () => {
    if (storageAction) return;
    setStorageAction("exporting");
    setError(null);
    try {
      const path = await exportLocalWorkspace();
      if (path) setNotice(`Exported ${path.split("/").pop() || "workspace backup"}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStorageAction(null);
    }
  };

  const importWorkspace = async () => {
    if (storageAction) return;
    const confirmed = window.confirm(
      "Restore a Codelit backup? This replaces the current local workspace after the file is validated.",
    );
    if (!confirmed) return;
    setStorageAction("importing");
    setError(null);
    try {
      const imported = await importLocalWorkspace(true);
      if (imported) {
        setSnapshot(imported.snapshot);
        navigate("home");
        setNotice(`Restored ${imported.path.split("/").pop() || "workspace backup"}`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStorageAction(null);
    }
  };

  const deleteWorkspace = async (confirmation: string) => {
    if (storageAction) return;
    setStorageAction("deleting");
    setError(null);
    try {
      const next = await deleteLocalWorkspace(confirmation);
      setSnapshot(next);
      setProviderChecks({});
      setMcpServers([]);
      setCloudStatus({ status: "disconnected", detail: "Optional. Connect only when you want to sync or run work 24/7." });
      setCloudSync(null);
      setCloudLinks([]);
      setCloudIssue(null);
      setPrompt("");
      navigate("home");
      setNotice("Local Codelit data was deleted");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setStorageAction(null);
    }
  };

  const chooseMcpExecutable = async () => {
    if (mcpAction) return null;
    setMcpAction({ kind: "choosing", message: "Choose the server executable" });
    setError(null);
    try {
      return await chooseLocalMcpExecutable();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setMcpAction(null);
    }
  };

  const inspectMcpServer = async (server: LocalMcpServerDraft): Promise<LocalMcpInspection> => {
    if (mcpAction) throw new Error("Finish the current local MCP action first.");
    setMcpAction({ kind: "inspecting", serverId: server.id, message: "Starting the local server" });
    setError(null);
    try {
      return await inspectLocalMcpServer(server, (event) => {
        setMcpAction((current) => current?.serverId === server.id
          ? { ...current, message: event.message }
          : current);
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setMcpAction(null);
    }
  };

  const persistMcpServer = async (server: LocalMcpServerDraft, approvedTools: string[]) => {
    if (mcpAction) throw new Error("Finish the current local MCP action first.");
    setMcpAction({ kind: "saving", serverId: server.id, message: "Rechecking the reviewed tools" });
    setError(null);
    try {
      const saved = await saveLocalMcpServer(server, approvedTools, (event) => {
        setMcpAction((current) => current?.serverId === server.id
          ? { ...current, message: event.message }
          : current);
      });
      setMcpServers((current) => [
        ...current.filter((candidate) => candidate.id !== saved.id),
        saved,
      ].sort((left, right) => left.name.localeCompare(right.name)));
      setNotice(`${saved.name} tools are available to local Agent Teams`);
      return saved;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setMcpAction(null);
    }
  };

  const removeMcpServer = async (id: string) => {
    if (mcpAction) return;
    setMcpAction({ kind: "deleting", serverId: id, message: "Removing local MCP access" });
    setError(null);
    try {
      setMcpServers(await deleteLocalMcpServer(id));
      setNotice("Local MCP access removed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setMcpAction(null);
    }
  };

  const updateBackgroundWork = async (enabled: boolean) => {
    setError(null);
    try {
      const probe = await setBackgroundWorkEnabled(enabled);
      setBackgroundService(probe);
      setNotice(enabled
        ? probe.status === "enabled"
          ? "Local background work enabled"
          : "Approve Codelit in macOS Login Items to finish enabling schedules"
        : "Local background work disabled");
      return probe;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  };

  const connectCloud = async () => {
    if (cloudWorking) return;
    setCloudWorking("connecting");
    setCloudIssue(null);
    try {
      const nextStatus = await startDesktopCloudPairing();
      setCloudStatus(nextStatus);
      setNotice("Approve the matching code in your browser");
    } catch (reason) {
      setCloudIssue(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCloudWorking(null);
    }
  };

  const disconnectCloud = async () => {
    if (cloudWorking) return;
    setCloudWorking("disconnecting");
    setCloudIssue(null);
    try {
      setCloudStatus(await disconnectDesktopCloud());
      setCloudSync(null);
      setNotice("This Mac disconnected from Codelit Cloud");
    } catch (reason) {
      setCloudIssue(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCloudWorking(null);
    }
  };

  const openCloudHref = async (href: string) => {
    try {
      await openDesktopCloudHref(href);
    } catch (reason) {
      setCloudIssue(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const cloudPromotionOpened = async () => {
    setCloudLinks(await listDesktopCloudLinks());
    setNotice("Hosted setup opened for review");
  };

  const reviewLocalCloudCopy = (link: DesktopCloudLink) => {
    const nextSurface = surfaceForKind(link.artifactKind);
    if (!nextSurface) return;
    setSurface(nextSurface);
    setSettingsOpen(false);
    setScheduleReviewId(link.scheduleId || null);
    setHostedCapabilityIntent(link.scheduleId ? null : "sync");
    setSchedulePanelOpen(true);
  };

  const requestHostedCapability = (capabilityId: DesktopCloudCapabilityId) => {
    if (!currentArtifact) return;
    const capability = cloudSync?.capabilities.find((candidate) => candidate.id === capabilityId);
    const compatibleCloudLink = cloudLinks
      .filter((link) => (
        link.artifactId === currentArtifact.artifactId
        && link.sourceArtifactVersion === currentArtifact.version
        && link.status !== "cancelled"
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .find((link) => capabilityId === "run-24-7"
        ? link.mode === "run-24-7" && Boolean(link.scheduleId)
        : Boolean(link.projectHref || link.reviewHref));
    const needsNewReview = Boolean(
      compatibleCloudLink?.localChanged
      || compatibleCloudLink?.conflictState === "diverged",
    );
    const existingHref = compatibleCloudLink?.reviewHref || compatibleCloudLink?.projectHref;

    if (!needsNewReview && existingHref) {
      void openCloudHref(existingHref);
      return;
    }
    if (capability && !capability.available && capability.href) {
      void openCloudHref(capability.href);
      return;
    }
    if (capability && !capability.available && !capability.href) {
      setSchedulePanelOpen(false);
      setSettingsOpen(true);
      setNotice("This App Store build uses your existing Codelit hosted plan");
      return;
    }

    setSettingsOpen(false);
    setHostedCapabilityIntent(capabilityId);
    setScheduleReviewId(capabilityId === "run-24-7" ? compatibleCloudLink?.scheduleId || null : null);
    setSchedulePanelOpen(true);
  };

  const persistSchedule = async (request: SaveLocalScheduleRequest) => {
    setError(null);
    try {
      const saved = await saveLocalSchedule(request);
      setSchedules((current) => [
        ...current.filter((schedule) => schedule.id !== saved.id),
        saved,
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
      setNotice("Local schedule saved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  };

  const toggleSchedule = async (id: string, enabled: boolean) => {
    const saved = await setLocalScheduleEnabled(id, enabled);
    setSchedules((current) => current.map((schedule) => schedule.id === id ? saved : schedule));
    setNotice(enabled ? "Schedule resumed" : "Schedule paused");
  };

  const removeSchedule = async (id: string) => {
    await deleteLocalSchedule(id);
    setSchedules((current) => current.filter((schedule) => schedule.id !== id));
    setNotice("Schedule deleted");
  };

  if (!snapshot && !error) return <AppSkeleton />;

  return (
    <div
      className="desktop-app"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-settings={settingsOpen ? "open" : "closed"}
      data-schedule={schedulePanelOpen ? "open" : "closed"}
    >
      <Sidebar open={sidebarOpen} surface={surface} snapshot={snapshot} onNavigate={navigate} onClose={() => setSidebarOpen(false)} />

      <main className="app-main">
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-menu"
              onClick={() => setSidebarOpen((current) => !current)}
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            >
              <Menu size={18} />
            </button>
            {surface !== "home" && (
              <button className="icon-button back-button" onClick={() => navigate("home")} aria-label="Back to thread" title="Back to thread">
                <ArrowLeft size={18} />
              </button>
            )}
            <div>
              <strong>{surface === "home" ? snapshot?.thread.title : titleForSurface(surface)}</strong>
              <span>{surface === "home" ? "Private workspace" : "Local artifact"}</span>
            </div>
          </div>
          <div className="topbar-actions">
            <span className="local-badge"><HardDrive size={14} /> Local only</span>
            {surface !== "home" && currentArtifact && (
              <HostedCapabilityMenu
                artifactKind={currentArtifact.kind}
                hasBrowser={currentArtifact.kind === "agent-team" && JSON.stringify(currentArtifact.payload).includes("Browser ")}
                cloudStatus={cloudStatus}
                capabilities={cloudSync?.capabilities || []}
                onSelect={requestHostedCapability}
              />
            )}
            {surface !== "home" && currentArtifact && (
              <button
                className="icon-button"
                onClick={() => {
                  setSettingsOpen(false);
                  setHostedCapabilityIntent(null);
                  setSchedulePanelOpen((current) => !current);
                }}
                aria-label={schedulePanelOpen ? "Close schedule panel" : `Schedule ${currentArtifact.title}`}
                aria-expanded={schedulePanelOpen}
                title="Schedule on this Mac"
              >
                <CalendarClock size={18} />
              </button>
            )}
            <button
              className="icon-button"
              onClick={() => {
                setSchedulePanelOpen(false);
                setSettingsOpen((current) => !current);
              }}
              aria-label={settingsOpen ? "Close local settings" : "Open local settings"}
              aria-expanded={settingsOpen}
              title="Local settings"
            >
              <Settings2 size={18} />
            </button>
          </div>
        </header>

        {error && (
          <div className="inline-alert error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error"><X size={15} /></button>
          </div>
        )}
        {notice && (
          <div className="inline-alert success" role="status">
            <CheckCircle2 size={17} />
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss notification"><X size={15} /></button>
          </div>
        )}

        <div className="content-scroll">
          {surface === "home" && snapshot && (
            <ThreadView snapshot={snapshot} onOpenArtifact={(kind) => {
              const next = surfaceForKind(kind);
              if (next) navigate(next);
            }} />
          )}
          {surface === "agent-team" && currentArtifact && (
            <Suspense fallback={<WorkbenchSkeleton />}>
              <AgentTeamWorkbench
                artifact={currentArtifact}
                providers={providers}
                mcpServers={mcpServers}
                engine={selectedEngine}
                busy={busy}
                onSave={(title, payload) => persistArtifact(currentArtifact, title, payload)}
                onEngineChange={setSelectedEngine}
                runStatus={agentRunStatus}
                activeStep={activeAgentStep}
                runEvents={runEvents}
                approval={agentApproval}
                recoverableRun={recoverableAgentCheckpoint ? {
                  runId: recoverableAgentCheckpoint.runId,
                  updatedAt: recoverableAgentCheckpoint.updatedAt,
                  awaitingApproval: snapshot?.approvals.some((approval) => (
                    approval.runId === recoverableAgentCheckpoint.runId && approval.status === "awaiting"
                  )) || false,
                } : null}
                onRun={runAgentTeam}
                onResume={resumeAgentTeam}
                onCancel={cancelActiveRun}
                onApprovalDecision={decideAgentApproval}
                browserObscured={settingsOpen || schedulePanelOpen}
                onRequestCloudBrowser={() => requestHostedCapability("cloud-browser")}
              />
            </Suspense>
          )}
          {surface === "product-plan" && currentArtifact && (
            <ProductPlanWorkbench
              artifact={currentArtifact}
              providers={providers}
              engine={selectedEngine}
              saving={busy === "saving"}
              running={busy === "running"}
              onEngineChange={setSelectedEngine}
              onRun={(task) => runArtifact(task)}
              onSave={(title: string, payload: ProductPlanPayload) => persistArtifact(currentArtifact, title, payload)}
            />
          )}
          {surface === "architecture" && currentArtifact && (
            <ArchitectureWorkbench
              artifact={currentArtifact}
              providers={providers}
              engine={selectedEngine}
              saving={busy === "saving"}
              running={busy === "running"}
              onEngineChange={setSelectedEngine}
              onRun={(task) => runArtifact(task)}
              onSave={(title: string, payload: ArchitecturePayload) => persistArtifact(currentArtifact, title, payload)}
            />
          )}
        </div>

        {surface === "home" && snapshot && (
          <Composer
            value={prompt}
            engine={selectedEngine}
            providers={providers}
            activeEvent={runEvents.at(-1) || null}
            busy={busy !== "idle"}
            onChange={setPrompt}
            onEngineChange={setSelectedEngine}
            onCancel={cancelActiveRun}
            onSubmit={submitPrompt}
          />
        )}
      </main>

      {settingsOpen && snapshot && (
        <LocalSettings
          providers={providers}
          mcpServers={mcpServers}
          mcpAction={mcpAction}
          providerChecks={providerChecks}
          providerProgress={providerProgress}
          checkingProvider={checkingProvider}
          modelOperation={modelOperation}
          databasePath={snapshot.databasePath}
          workspaceFolder={snapshot.workspaceFolder}
          backgroundService={backgroundService}
          schedules={schedules}
          cloudStatus={cloudStatus}
          cloudSync={cloudSync}
          cloudLinks={cloudLinks}
          cloudWorking={cloudWorking}
          cloudIssue={cloudIssue}
          choosingFolder={choosingFolder}
          storageAction={storageAction}
          onClose={() => setSettingsOpen(false)}
          onTestProvider={testProvider}
          onManageModel={manageModel}
          onPauseModel={pauseModelOperation}
          onChooseWorkspaceFolder={selectWorkspaceFolder}
          onExportWorkspace={exportWorkspace}
          onImportWorkspace={importWorkspace}
          onDeleteWorkspace={deleteWorkspace}
          onChooseMcpExecutable={chooseMcpExecutable}
          onInspectMcpServer={inspectMcpServer}
          onSaveMcpServer={persistMcpServer}
          onDeleteMcpServer={removeMcpServer}
          onSetBackground={updateBackgroundWork}
          onOpenBackgroundSettings={openBackgroundWorkSettings}
          onConnectCloud={connectCloud}
          onDisconnectCloud={disconnectCloud}
          onSyncCloud={() => refreshCloud(true)}
          onOpenCloudHref={openCloudHref}
          onReviewLocalCloudCopy={reviewLocalCloudCopy}
        />
      )}

      {schedulePanelOpen && snapshot && currentArtifact && (
        <LocalSchedulePanel
          artifact={currentArtifact}
          threadId={snapshot.thread.id}
          engine={selectedEngine}
          schedules={schedules}
          backgroundService={backgroundService}
          cloudStatus={cloudStatus}
          cloudSync={cloudSync}
          cloudLinks={cloudLinks}
          initialReviewScheduleId={scheduleReviewId}
          hostedCapabilityIntent={hostedCapabilityIntent}
          onClose={() => {
            setSchedulePanelOpen(false);
            setScheduleReviewId(null);
            setHostedCapabilityIntent(null);
          }}
          onSave={persistSchedule}
          onToggle={toggleSchedule}
          onDelete={removeSchedule}
          onSetBackground={updateBackgroundWork}
          onOpenSystemSettings={openBackgroundWorkSettings}
          onCloudStatusChange={setCloudStatus}
          onPromotionOpened={cloudPromotionOpened}
          onOpenCloudHref={openCloudHref}
        />
      )}
    </div>
  );
}

function Sidebar({
  open,
  surface,
  snapshot,
  onNavigate,
  onClose,
}: {
  open: boolean;
  surface: LocalSurface;
  snapshot: LocalWorkspaceSnapshot | null;
  onNavigate: (surface: LocalSurface) => void;
  onClose: () => void;
}) {
  return (
    <aside className="sidebar" aria-hidden={!open} inert={!open}>
      <div className="sidebar-header">
        <button className="brand" onClick={() => onNavigate("home")} aria-label="Open Codelit Home">
          <span className="brand-mark">C</span>
          <span>Codelit</span>
        </button>
        <button className="icon-button collapse-button" onClick={onClose} aria-label="Collapse sidebar" title="Collapse sidebar">
          <PanelLeftClose size={18} />
        </button>
      </div>
      <button className="new-thread-button" onClick={() => onNavigate("home")}>
        <Plus size={17} /> New local thread
      </button>
      <nav className="primary-nav" aria-label="Local workspace">
        {SURFACES.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} className={surface === item.id ? "active" : ""} onClick={() => onNavigate(item.id)}>
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-section">
        <span className="sidebar-label">Recent</span>
        <button className="thread-link active" onClick={() => onNavigate("home")}>
          <span>{snapshot?.thread.title || "Local release workspace"}</span>
          <small>Now</small>
        </button>
      </div>
      <div className="sidebar-footer">
        <Database size={16} />
        <div>
          <strong>On this Mac</strong>
          <span>No Codelit account required</span>
        </div>
      </div>
    </aside>
  );
}

function ThreadView({ snapshot, onOpenArtifact }: {
  snapshot: LocalWorkspaceSnapshot;
  onOpenArtifact: (kind: WorkspaceArtifactKind) => void;
}) {
  return (
    <div className="thread" aria-label="Local Codelit thread">
      <div className="thread-intro">
        <span className="thread-kicker">Local workspace</span>
        <h1>Build the next useful thing.</h1>
        <p>Your plans, systems, and Agent Teams stay together on this Mac.</p>
      </div>
      <div className="thread-blocks">
        {snapshot.blocks.map((block) => (
          <ThreadBlockView key={block.id} block={block} onOpenArtifact={onOpenArtifact} />
        ))}
      </div>
    </div>
  );
}

function ThreadBlockView({ block, onOpenArtifact }: {
  block: ThreadBlock;
  onOpenArtifact: (kind: WorkspaceArtifactKind) => void;
}) {
  if (block.type === "user-message") {
    return <div className="thread-message user">{block.text}</div>;
  }
  if (block.type === "assistant-message") {
    return (
      <div className="thread-message assistant">
        <span className="assistant-mark"><Bot size={16} /></span>
        <p>{block.text}</p>
      </div>
    );
  }
  if (block.type === "artifact") {
    const surface = surfaceForKind(block.artifact.kind);
    if (!surface) return null;
    const Icon = surface === "agent-team" ? Users : surface === "product-plan" ? ListChecks : Network;
    return (
      <article className={`artifact-card ${surface}`}>
        <span className="artifact-icon"><Icon size={18} /></span>
        <div className="artifact-copy">
          <span>{titleForSurface(surface)} · {block.artifact.version}</span>
          <strong>{block.artifact.title}</strong>
          <p>{block.summary}</p>
        </div>
        <button className="button secondary compact" onClick={() => onOpenArtifact(block.artifact.kind)}>
          Open <ChevronRight size={15} />
        </button>
      </article>
    );
  }
  if (block.type === "run") {
    return (
      <div className={`run-block ${block.status}`}>
        <Play size={15} />
        <div><strong>{block.label}</strong><span>{block.detail}</span></div>
      </div>
    );
  }
  if (block.type === "receipt") {
    return (
      <div className="receipt-block">
        <CheckCircle2 size={16} />
        <div><strong>{block.artifact.title}</strong><span>{block.summary}</span></div>
      </div>
    );
  }
  if (block.type === "error") {
    return <div className="thread-message error-message"><strong>{block.title}</strong><p>{block.detail}</p></div>;
  }
  return null;
}

function Composer({
  value,
  engine,
  providers,
  activeEvent,
  busy,
  onChange,
  onEngineChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  engine: IntelligenceSelection | null;
  providers: ProviderProbe[];
  activeEvent: ProviderRunEvent | null;
  busy: boolean;
  onChange: (value: string) => void;
  onEngineChange: (selection: IntelligenceSelection) => void;
  onCancel: () => Promise<void>;
  onSubmit: () => Promise<void>;
}) {
  return (
    <div className="composer-dock">
      <div className="composer">
        {activeEvent && busy && (
          <div className="composer-run-status" role="status">
            <span className="spinner" />
            <span>{activeEvent.message}</span>
            <button onClick={() => void onCancel()} aria-label="Cancel local run" title="Cancel local run">
              <Pause size={14} fill="currentColor" />
            </button>
          </div>
        )}
        <textarea
          rows={2}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void onSubmit();
            }
          }}
          placeholder="Describe a plan, system, or Agent Team..."
          aria-label="Describe what to build"
        />
        <div className="composer-footer">
          <EnginePicker providers={providers} value={engine} onChange={onEngineChange} compact />
          <button className="send-button" onClick={() => void onSubmit()} disabled={!value.trim() || busy} aria-label="Send">
            {busy ? <span className="spinner dark" /> : <ArrowUp size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function LocalSettings({
  providers,
  mcpServers,
  mcpAction,
  providerChecks,
  providerProgress,
  checkingProvider,
  modelOperation,
  databasePath,
  workspaceFolder,
  backgroundService,
  schedules,
  cloudStatus,
  cloudSync,
  cloudLinks,
  cloudWorking,
  cloudIssue,
  choosingFolder,
  storageAction,
  onClose,
  onTestProvider,
  onManageModel,
  onPauseModel,
  onChooseWorkspaceFolder,
  onExportWorkspace,
  onImportWorkspace,
  onDeleteWorkspace,
  onChooseMcpExecutable,
  onInspectMcpServer,
  onSaveMcpServer,
  onDeleteMcpServer,
  onSetBackground,
  onOpenBackgroundSettings,
  onConnectCloud,
  onDisconnectCloud,
  onSyncCloud,
  onOpenCloudHref,
  onReviewLocalCloudCopy,
}: {
  providers: ProviderProbe[];
  mcpServers: LocalMcpServer[];
  mcpAction: LocalMcpAction | null;
  providerChecks: Record<string, ProviderTaskResult>;
  providerProgress: Record<string, ProviderRunEvent>;
  checkingProvider: string | null;
  modelOperation: {
    key: string;
    action: ModelManagerAction;
    runId?: string;
    message?: string;
  } | null;
  databasePath: string;
  workspaceFolder: LocalWorkspaceSnapshot["workspaceFolder"];
  backgroundService: BackgroundServiceProbe | null;
  schedules: LocalSchedule[];
  cloudStatus: DesktopCloudStatus | null;
  cloudSync: DesktopCloudSyncView | null;
  cloudLinks: DesktopCloudLink[];
  cloudWorking: "connecting" | "syncing" | "disconnecting" | null;
  cloudIssue: string | null;
  choosingFolder: boolean;
  storageAction: StorageAction;
  onClose: () => void;
  onTestProvider: (providerId: string) => Promise<void>;
  onManageModel: (
    providerId: ProviderProbe["id"],
    modelId: string,
    action: ModelManagerAction,
  ) => Promise<void>;
  onPauseModel: () => Promise<void>;
  onChooseWorkspaceFolder: () => Promise<void>;
  onExportWorkspace: () => Promise<void>;
  onImportWorkspace: () => Promise<void>;
  onDeleteWorkspace: (confirmation: string) => Promise<void>;
  onChooseMcpExecutable: () => Promise<string | null>;
  onInspectMcpServer: (server: LocalMcpServerDraft) => Promise<LocalMcpInspection>;
  onSaveMcpServer: (server: LocalMcpServerDraft, approvedTools: string[]) => Promise<LocalMcpServer>;
  onDeleteMcpServer: (id: string) => Promise<void>;
  onSetBackground: (enabled: boolean) => Promise<BackgroundServiceProbe>;
  onOpenBackgroundSettings: () => Promise<void>;
  onConnectCloud: () => Promise<void>;
  onDisconnectCloud: () => Promise<void>;
  onSyncCloud: () => Promise<void>;
  onOpenCloudHref: (href: string) => Promise<void>;
  onReviewLocalCloudCopy: (link: DesktopCloudLink) => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [backgroundWorking, setBackgroundWorking] = useState(false);

  const confirmDelete = async () => {
    try {
      await onDeleteWorkspace(deleteConfirmation);
      setDeleteOpen(false);
      setDeleteConfirmation("");
    } catch {
      // The global alert already contains the actionable failure.
    }
  };

  return (
    <aside className="settings-panel" aria-label="Local settings">
      <header>
        <div><span className="eyebrow">This Mac</span><h2>Local runtime</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close local settings"><X size={18} /></button>
      </header>
      <section>
        <h3>Providers</h3>
        <div className="provider-list">
          {providers.map((provider) => (
            <article className="provider-row" key={provider.id}>
              <span className="status-dot" data-status={providerChecks[provider.id]?.status || provider.status} />
              <div>
                <strong>{provider.label}</strong>
                <span>{provider.version || provider.detail}</span>
              </div>
              {provider.canRun ? (
                <button
                  className="provider-test"
                  disabled={Boolean(checkingProvider)}
                  onClick={() => void onTestProvider(provider.id)}
                >
                  {checkingProvider === provider.id ? <span className="spinner" /> : providerChecks[provider.id] ? "Retest" : "Test"}
                </button>
              ) : (
                <small>{provider.status}</small>
              )}
              {providerChecks[provider.id] && (
                <p className="provider-check" data-status={providerChecks[provider.id].status}>
                  <strong>{providerChecks[provider.id].status === "completed" ? "Ready" : providerChecks[provider.id].status.replace(/-/g, " ")}</strong>
                  <span>{providerChecks[provider.id].structuredOutput?.summary || providerChecks[provider.id].text}</span>
                </p>
              )}
              {checkingProvider === provider.id && providerProgress[provider.id] && (
                <p className="provider-progress" role="status">
                  {providerProgress[provider.id].message}
                </p>
              )}
              {provider.id === "mlx" && provider.models.length > 0 && (
                <div className="model-manager-list">
                  {provider.models.map((model) => (
                    <LocalModelRow
                      key={model.id}
                      provider={provider}
                      model={model}
                      operation={modelOperation}
                      onManage={onManageModel}
                      onPause={onPauseModel}
                    />
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      <section>
        <DesktopCloudSettings
          status={cloudStatus}
          sync={cloudSync}
          links={cloudLinks}
          working={cloudWorking}
          issue={cloudIssue}
          onConnect={onConnectCloud}
          onDisconnect={onDisconnectCloud}
          onSync={onSyncCloud}
          onOpenHref={onOpenCloudHref}
          onReviewLocalCopy={onReviewLocalCloudCopy}
        />
      </section>
      <section>
        <h3>Storage</h3>
        <div className="storage-detail storage-row">
          <Database size={16} />
          <div><strong>SQLite</strong><span title={databasePath}>{databasePath}</span></div>
        </div>
        <div className="storage-detail storage-row">
          <FolderOpen size={16} />
          <div>
            <strong>{workspaceFolder ? "Project folder" : "No project folder"}</strong>
            <span title={workspaceFolder?.path}>{workspaceFolder?.path || "Choose a folder when local tools need context"}</span>
          </div>
          <button
            className="provider-test"
            disabled={choosingFolder}
            onClick={() => void onChooseWorkspaceFolder()}
          >
            {choosingFolder ? <span className="spinner" /> : workspaceFolder ? "Change" : "Choose"}
          </button>
        </div>
        {workspaceFolder && (
          <p className="storage-permission" data-ready={workspaceFolder.accessValidated}>
            {workspaceFolder.accessValidated
              ? "Read-only access will restore after relaunch."
              : "Access could not be restored. Choose the folder again."}
          </p>
        )}
        <div className="storage-actions" aria-label="Workspace backup actions">
          <button disabled={Boolean(storageAction)} onClick={() => void onExportWorkspace()}>
            {storageAction === "exporting" ? <span className="spinner" /> : <Download size={14} />}
            Export
          </button>
          <button disabled={Boolean(storageAction)} onClick={() => void onImportWorkspace()}>
            {storageAction === "importing" ? <span className="spinner" /> : <Upload size={14} />}
            Restore
          </button>
          <button
            className="danger"
            disabled={Boolean(storageAction)}
            onClick={() => setDeleteOpen((current) => !current)}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
        {deleteOpen && (
          <div className="delete-confirmation">
            <strong>Delete all local data?</strong>
            <p>This removes Threads, artifacts, receipts, folder access, model files, and the local encryption key.</p>
            <label htmlFor="delete-local-confirmation">Type DELETE to continue</label>
            <input
              id="delete-local-confirmation"
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <div>
              <button onClick={() => { setDeleteOpen(false); setDeleteConfirmation(""); }}>Cancel</button>
              <button
                className="danger"
                disabled={deleteConfirmation !== "DELETE" || storageAction === "deleting"}
                onClick={() => void confirmDelete()}
              >
                {storageAction === "deleting" ? <span className="spinner" /> : <Trash2 size={14} />}
                Delete local data
              </button>
            </div>
          </div>
        )}
      </section>
      <section>
        <LocalMcpSettings
          servers={mcpServers}
          action={mcpAction}
          onChooseExecutable={onChooseMcpExecutable}
          onInspect={onInspectMcpServer}
          onSave={onSaveMcpServer}
          onDelete={onDeleteMcpServer}
        />
      </section>
      <section>
        <DesktopUpdateSettings />
      </section>
      <section>
        <div className="settings-section-heading">
          <div>
            <h3>Local schedules</h3>
            <p>Run pinned workflows on this Mac without hosted execution charges.</p>
          </div>
        </div>
        <div className="storage-detail storage-row">
          <span className="status-dot" data-status={backgroundService?.status || "not-found"} />
          <div>
            <strong>{backgroundService?.status === "enabled"
              ? "Scheduler enabled"
              : backgroundService?.bundled
                ? "Scheduler helper bundled"
                : "Scheduler helper unavailable"}</strong>
            <span>{backgroundService?.detail || "Checking the local background service..."}</span>
          </div>
          {backgroundService?.bundled && (
            <button
              className="provider-test"
              disabled={backgroundWorking}
              onClick={() => {
                setBackgroundWorking(true);
                void onSetBackground(backgroundService.status !== "enabled")
                  .finally(() => setBackgroundWorking(false));
              }}
            >
              {backgroundWorking
                ? <span className="spinner" />
                : backgroundService.status === "enabled" ? "Disable" : "Enable"}
            </button>
          )}
        </div>
        {backgroundService?.status === "requires-approval" && (
          <button className="system-settings-button" onClick={() => void onOpenBackgroundSettings()}>
            Review Login Items <ChevronRight size={14} />
          </button>
        )}
        <p className="storage-permission" data-ready={backgroundService?.status === "enabled"}>
          {schedules.length === 0
            ? "Open an Agent Team, Product Plan, or Architecture and use the schedule button in its toolbar."
            : `${schedules.filter((schedule) => schedule.enabled).length} of ${schedules.length} local schedules enabled.`}
        </p>
      </section>
    </aside>
  );
}

function LocalModelRow({
  provider,
  model,
  operation,
  onManage,
  onPause,
}: {
  provider: ProviderProbe;
  model: ProviderModel;
  operation: {
    key: string;
    action: ModelManagerAction;
    runId?: string;
    message?: string;
  } | null;
  onManage: (
    providerId: ProviderProbe["id"],
    modelId: string,
    action: ModelManagerAction,
  ) => Promise<void>;
  onPause: () => Promise<void>;
}) {
  const key = `${provider.id}:${model.id}`;
  const active = operation?.key === key;
  const nextAction: ModelManagerAction | null = model.status === "partial"
    ? "resume"
    : model.status === "corrupt"
      ? "update"
      : model.status === "benchmark-required" || model.status === "incompatible"
        ? "benchmark"
        : model.status === "download-required"
          ? "download"
          : null;
  const actionLabel = nextAction === "resume"
    ? "Resume"
    : nextAction === "update"
      ? "Repair"
      : nextAction === "benchmark"
        ? "Benchmark"
        : "Download";
  const size = model.downloadBytes
    ? `${Math.ceil(model.downloadBytes / (1024 * 1024))} MB`
    : null;

  return (
    <div className="model-manager-row">
      <div className="model-manager-copy">
        <strong>{model.label}</strong>
        <span>{model.status.replace(/-/g, " ")}{size ? ` · ${size}` : ""}</span>
        <p>{active && operation?.message ? operation.message : model.detail}</p>
      </div>
      <div className="model-manager-actions">
        {active && operation?.action !== "delete" ? (
          <button
            className="provider-test"
            disabled={!operation?.runId}
            onClick={() => void onPause()}
          >
            <Pause size={13} fill="currentColor" /> Pause
          </button>
        ) : active ? (
          <button className="provider-test" disabled><span className="spinner" /> Removing</button>
        ) : (
          <>
            {nextAction ? (
              <button
                className="provider-test"
                disabled={Boolean(operation)}
                onClick={() => void onManage(provider.id, model.id, nextAction)}
              >
                {nextAction === "benchmark" ? <Gauge size={13} /> : <Download size={13} />}
                {actionLabel}
              </button>
            ) : model.status === "ready" ? (
              <button
                className="provider-test"
                disabled={Boolean(operation)}
                onClick={() => void onManage(provider.id, model.id, "benchmark")}
              >
                <Gauge size={13} /> Benchmark
              </button>
            ) : null}
            {model.installedBytes ? (
              <button
                aria-label={`Remove ${model.label}`}
                className="provider-test danger-text icon-only"
                disabled={Boolean(operation)}
                title="Remove model"
                onClick={() => void onManage(provider.id, model.id, "delete")}
              >
                <Trash2 size={13} />
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function AppSkeleton() {
  return (
    <div className="app-skeleton" aria-label="Loading local workspace">
      <div className="skeleton-sidebar" />
      <div className="skeleton-main">
        <div className="skeleton-topbar" />
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </div>
  );
}

function WorkbenchSkeleton() {
  return (
    <div className="workbench-skeleton" aria-label="Loading Agent Team workbench">
      <div className="skeleton-line wide" />
      <div className="skeleton-card" />
      <div className="skeleton-card" />
    </div>
  );
}
