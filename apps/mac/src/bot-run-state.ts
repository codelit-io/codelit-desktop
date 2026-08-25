import type { LocalWorkspaceSnapshot } from "@/lib/local-desktop-workspace";
import {
  isProviderId,
  type BotMemory,
  type BotSkill,
  type ComputerSemanticAction,
  type IntelligenceSelection,
  type LocalBotDelegationRunContext,
  type LocalBotsSnapshot,
  type LocalRunApproval,
  type ProviderRunEvent,
} from "./contracts";
import {
  emptyProviderLiveState,
  reduceProviderLiveState,
  type ProviderLiveState,
} from "./provider-run-live";
import {
  normalizeAgenticHarnessCheckpoint,
  type AgenticHarnessCheckpoint,
} from "./agentic-harness-checkpoint";

export type BotRunState = "idle" | "running" | "awaiting-approval" | "canceling" | "saving";

export interface PendingBrowserRun {
  approvalId: string;
  runId: string;
  botId: string;
  botVersion: number;
  request: string;
  target: { url: string; host: string };
  engine: IntelligenceSelection;
  selectionMode: "fixed" | "auto";
  meteredFallbackAuthorized: boolean;
  approvalMode: "ask" | "safe-auto";
  approvalSource: "pending-user" | "bot-safe-mode" | "bot-domain-scope";
  memories: BotMemory[];
  memorySnapshotHash: string;
  skills: BotSkill[];
  skillVersions: Record<string, number>;
  browserAction?: {
    action: "click" | "type" | "download";
    target: string;
    targetLabel: string;
    valueLength: number;
    approvalSha256: string;
    preview: string[];
  };
  delegation?: LocalBotDelegationRunContext;
}

export interface PendingComputerRun {
  approvalId: string;
  runId: string;
  botId: string;
  botVersion: number;
  request: string;
  app: { bundleId: string; appName: string };
  action: ComputerSemanticAction;
  proposedSummary: string;
  engine: IntelligenceSelection;
  selectionMode: "fixed" | "auto";
  meteredFallbackAuthorized: boolean;
  meteredProviderInvocationStarted: boolean;
  billingFallback: boolean;
  plannerDurationMs: number;
  plannerCommandPath: string;
  plannerVersion?: string;
  memorySnapshotHash: string;
  memoryIds: string[];
  skillVersions: Record<string, number>;
}

export interface PendingMcpRun {
  approvalId: string;
  runId: string;
  botId: string;
  botVersion: number;
  request: string;
  toolReference: string;
  serverName: string;
  toolName: string;
  description: string;
  effect: string;
  destructive: boolean;
  arguments: Record<string, unknown>;
  approvalSha256: string;
  preview: string[];
  engine: IntelligenceSelection;
  selectionMode: "fixed" | "auto";
  meteredFallbackAuthorized: boolean;
  meteredProviderInvocationStarted: boolean;
  billingFallback: boolean;
  plannerDurationMs: number;
  plannerCommandPath: string;
  plannerVersion?: string;
  plannerEvidence: string[];
  memories: BotMemory[];
  memorySnapshotHash: string;
  skills: BotSkill[];
  skillVersions: Record<string, number>;
  harnessCheckpoint?: AgenticHarnessCheckpoint;
}

export interface BotExecutionState {
  botId: string;
  runState: BotRunState;
  activeRunId: string | null;
  engine: IntelligenceSelection | null;
  activeEvent: ProviderRunEvent | null;
  liveRun: ProviderLiveState;
  pendingBrowserRun: PendingBrowserRun | null;
  pendingComputerRun: PendingComputerRun | null;
  pendingMcpRun: PendingMcpRun | null;
  error: string | null;
  notice: string | null;
}

export type BotExecutionStates = Readonly<Record<string, BotExecutionState>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeArgumentValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => isSafeArgumentValue(item, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 100 && entries.every(([key, item]) => (
    key.length > 0
    && key.length <= 120
    && !["__proto__", "constructor", "prototype"].includes(key)
    && isSafeArgumentValue(item, depth + 1)
  ));
}

export function pendingMcpRunFromApproval(approval: LocalRunApproval): PendingMcpRun | null {
  if (approval.status !== "awaiting" || !isRecord(approval.body) || approval.body.kind !== "mcp-action") {
    return null;
  }
  const engine = approval.body.engine;
  const memories = Array.isArray(approval.body.memories)
    ? approval.body.memories.filter((memory): memory is BotMemory => isRecord(memory)
      && typeof memory.id === "string"
      && typeof memory.body === "string"
      && ["bot", "workspace"].includes(String(memory.scope))
      && ["preference", "fact", "procedure", "decision"].includes(String(memory.kind))
      && ["user", "inferred"].includes(String(memory.source))
      && memory.approvalState === "approved")
    : [];
  const rawSkills = Array.isArray(approval.body.skills) ? approval.body.skills : [];
  const skills = rawSkills.filter((skill): skill is BotSkill => isRecord(skill)
    && typeof skill.id === "string"
    && Number.isInteger(skill.version)
    && Number(skill.version) > 0
    && typeof skill.name === "string"
    && typeof skill.description === "string"
    && typeof skill.instructions === "string"
    && Array.isArray(skill.capabilityIds)
    && ["built-in", "taught", "user-authored", "imported"].includes(String(skill.source))
    && ["packaged", "reviewed"].includes(String(skill.trustState))
    && typeof skill.checksum === "string");
  const skillVersions = isRecord(approval.body.skillVersions)
    ? Object.fromEntries(Object.entries(approval.body.skillVersions)
      .filter(([id, version]) => id.length > 0 && Number.isInteger(version) && Number(version) > 0)
      .map(([id, version]) => [id, Number(version)]))
    : {};
  const preview = Array.isArray(approval.body.preview)
    ? approval.body.preview.filter((line): line is string => typeof line === "string")
    : [];
  const harnessCheckpoint = approval.body.harnessCheckpoint === undefined
    ? undefined
    : normalizeAgenticHarnessCheckpoint(approval.body.harnessCheckpoint);
  if (!isRecord(engine)
    || !isProviderId(engine.provider)
    || typeof engine.model !== "string"
    || engine.model.length === 0
    || engine.model.length > 240
    || typeof approval.body.botId !== "string"
    || !Number.isInteger(approval.body.botVersion)
    || typeof approval.body.request !== "string"
    || typeof approval.body.toolReference !== "string"
    || !/^mcp::[^:]+::[^:]+$/.test(approval.body.toolReference)
    || typeof approval.body.serverName !== "string"
    || typeof approval.body.toolName !== "string"
    || typeof approval.body.description !== "string"
    || typeof approval.body.effect !== "string"
    || !["read", "write"].includes(approval.body.effect)
    || typeof approval.body.destructive !== "boolean"
    || !isRecord(approval.body.arguments)
    || !isSafeArgumentValue(approval.body.arguments)
    || JSON.stringify(approval.body.arguments).length > 32_000
    || typeof approval.body.approvalSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(approval.body.approvalSha256)
    || preview.length === 0
    || preview.length > 12
    || preview.some((line) => line.length === 0 || line.length > 10_000)
    || !["fixed", "auto"].includes(String(approval.body.selectionMode))
    || typeof approval.body.meteredFallbackAuthorized !== "boolean"
    || typeof approval.body.meteredProviderInvocationStarted !== "boolean"
    || typeof approval.body.billingFallback !== "boolean"
    || typeof approval.body.plannerDurationMs !== "number"
    || !Number.isFinite(approval.body.plannerDurationMs)
    || Number(approval.body.plannerDurationMs) < 0
    || typeof approval.body.plannerCommandPath !== "string"
    || approval.body.plannerCommandPath.length === 0
    || approval.body.plannerCommandPath.length > 2_048
    || (approval.body.plannerVersion !== undefined && (
      typeof approval.body.plannerVersion !== "string"
      || approval.body.plannerVersion.length === 0
      || approval.body.plannerVersion.length > 256
    ))
    || !Array.isArray(approval.body.plannerEvidence)
    || approval.body.plannerEvidence.length > 16
    || approval.body.plannerEvidence.some((item) => typeof item !== "string" || item.length > 2_000)
    || typeof approval.body.memorySnapshotHash !== "string"
    || !(approval.body.memorySnapshotHash === "none" || /^[a-f0-9]{64}$/.test(approval.body.memorySnapshotHash))
    || (approval.body.selectionMode === "fixed" && approval.body.meteredFallbackAuthorized)
    || approval.body.billingFallback !== (
      approval.body.selectionMode === "auto"
      && approval.body.meteredFallbackAuthorized
      && approval.body.meteredProviderInvocationStarted
    )
    || memories.length !== (Array.isArray(approval.body.memories) ? approval.body.memories.length : 0)
    || skills.length !== rawSkills.length
    || Object.keys(skillVersions).length !== skills.length
    || !skills.every((skill) => skillVersions[skill.id] === skill.version)) return null;
  if (approval.body.harnessCheckpoint !== undefined && !harnessCheckpoint) return null;
  return {
    approvalId: approval.id,
    runId: approval.runId,
    botId: approval.body.botId,
    botVersion: Number(approval.body.botVersion),
    request: approval.body.request,
    toolReference: approval.body.toolReference,
    serverName: approval.body.serverName,
    toolName: approval.body.toolName,
    description: approval.body.description,
    effect: approval.body.effect,
    destructive: approval.body.destructive,
    arguments: approval.body.arguments,
    approvalSha256: approval.body.approvalSha256,
    preview,
    engine: { provider: engine.provider, model: engine.model },
    selectionMode: approval.body.selectionMode as PendingMcpRun["selectionMode"],
    meteredFallbackAuthorized: approval.body.meteredFallbackAuthorized,
    meteredProviderInvocationStarted: approval.body.meteredProviderInvocationStarted,
    billingFallback: approval.body.billingFallback,
    plannerDurationMs: Number(approval.body.plannerDurationMs),
    plannerCommandPath: approval.body.plannerCommandPath,
    ...(approval.body.plannerVersion ? { plannerVersion: approval.body.plannerVersion } : {}),
    plannerEvidence: approval.body.plannerEvidence as string[],
    memories,
    memorySnapshotHash: approval.body.memorySnapshotHash,
    skills,
    skillVersions,
    ...(harnessCheckpoint ? { harnessCheckpoint } : {}),
  };
}

export function pendingBrowserRunFromApproval(approval: LocalRunApproval): PendingBrowserRun | null {
  if (approval.status !== "awaiting"
    || !isRecord(approval.body)
    || !["browser-read", "browser-action"].includes(String(approval.body.kind))) {
    return null;
  }
  const isBrowserAction = approval.body.kind === "browser-action";
  const target = approval.body.target;
  const engine = approval.body.engine;
  const rawBrowserAction = approval.body.browserAction;
  const rawPreview = isRecord(rawBrowserAction) && Array.isArray(rawBrowserAction.preview)
    ? rawBrowserAction.preview
    : [];
  const browserAction = isBrowserAction
    && isRecord(rawBrowserAction)
    && ["click", "type", "download"].includes(String(rawBrowserAction.action))
    && typeof rawBrowserAction.target === "string"
    && rawBrowserAction.target.length > 0
    && rawBrowserAction.target.length <= 180
    && typeof rawBrowserAction.targetLabel === "string"
    && rawBrowserAction.targetLabel.trim().length > 0
    && rawBrowserAction.targetLabel.length <= 100
    && rawBrowserAction.targetLabel === rawBrowserAction.targetLabel.trim()
    && !/[\r\n]/.test(rawBrowserAction.targetLabel)
    && rawBrowserAction.target === `label:${rawBrowserAction.targetLabel}`
    && Number.isInteger(rawBrowserAction.valueLength)
    && Number(rawBrowserAction.valueLength) >= 0
    && Number(rawBrowserAction.valueLength) <= 2_000
    && (rawBrowserAction.action === "type" || Number(rawBrowserAction.valueLength) === 0)
    && typeof rawBrowserAction.approvalSha256 === "string"
    && /^[a-f0-9]{64}$/.test(rawBrowserAction.approvalSha256)
    && rawPreview.length > 0
    && rawPreview.length <= 8
    && rawPreview.every((line) => typeof line === "string" && line.length > 0 && line.length <= 1_000)
    && Object.keys(rawBrowserAction).every((key) => [
      "action",
      "target",
      "targetLabel",
      "valueLength",
      "approvalSha256",
      "preview",
    ].includes(key))
    ? {
        action: rawBrowserAction.action as "click" | "type" | "download",
        target: rawBrowserAction.target,
        targetLabel: rawBrowserAction.targetLabel,
        valueLength: Number(rawBrowserAction.valueLength),
        approvalSha256: rawBrowserAction.approvalSha256,
        preview: rawPreview as string[],
      }
    : undefined;
  const memories = Array.isArray(approval.body.memories)
    ? approval.body.memories.filter((memory): memory is BotMemory => isRecord(memory)
      && typeof memory.id === "string"
      && typeof memory.body === "string"
      && ["bot", "workspace"].includes(String(memory.scope))
      && ["preference", "fact", "procedure", "decision"].includes(String(memory.kind))
      && ["user", "inferred"].includes(String(memory.source))
      && memory.approvalState === "approved")
    : [];
  const rawSkills = Array.isArray(approval.body.skills) ? approval.body.skills : [];
  const skills = rawSkills.flatMap((skill): BotSkill[] => {
    if (!(isRecord(skill)
      && typeof skill.id === "string"
      && Number.isInteger(skill.version)
      && Number(skill.version) > 0
      && typeof skill.name === "string"
      && typeof skill.description === "string"
      && typeof skill.instructions === "string"
      && Array.isArray(skill.capabilityIds)
      && skill.capabilityIds.every((id) => typeof id === "string")
      && ["built-in", "taught", "user-authored", "imported"].includes(String(skill.source))
      && ["packaged", "reviewed"].includes(String(skill.trustState))
      && typeof skill.checksum === "string"
      && /^[a-f0-9]{64}$/.test(skill.checksum))) return [];
    return [{
      ...(skill as unknown as BotSkill),
      inputSchema: Array.isArray(skill.inputSchema) ? skill.inputSchema as BotSkill["inputSchema"] : [],
      outputSchema: Array.isArray(skill.outputSchema) ? skill.outputSchema as BotSkill["outputSchema"] : [],
      requiredPermissions: Array.isArray(skill.requiredPermissions)
        ? skill.requiredPermissions.filter((value): value is string => typeof value === "string")
        : [],
      effects: Array.isArray(skill.effects) ? skill.effects as BotSkill["effects"] : [],
      examples: Array.isArray(skill.examples) ? skill.examples as BotSkill["examples"] : [],
      checks: Array.isArray(skill.checks) ? skill.checks as BotSkill["checks"] : [],
    }];
  });
  const skillVersions = isRecord(approval.body.skillVersions)
    ? Object.fromEntries(Object.entries(approval.body.skillVersions)
      .filter(([id, version]) => id.length > 0 && Number.isInteger(version) && Number(version) > 0)
      .map(([id, version]) => [id, Number(version)]))
    : {};
  const rawDelegation = approval.body.delegation;
  const delegation = isRecord(rawDelegation)
    && typeof rawDelegation.delegationId === "string"
    && typeof rawDelegation.parentBotId === "string"
    && typeof rawDelegation.parentThreadId === "string"
    && typeof rawDelegation.parentBotName === "string"
    && typeof rawDelegation.targetBotId === "string"
    && typeof rawDelegation.expectedOutput === "string"
    && Number.isInteger(rawDelegation.maxActions)
    && Number(rawDelegation.maxActions) >= 1
    && Number(rawDelegation.maxActions) <= 8
    ? {
        delegationId: rawDelegation.delegationId,
        parentBotId: rawDelegation.parentBotId,
        parentThreadId: rawDelegation.parentThreadId,
        parentBotName: rawDelegation.parentBotName,
        targetBotId: rawDelegation.targetBotId,
        expectedOutput: rawDelegation.expectedOutput,
        maxActions: Number(rawDelegation.maxActions),
      }
    : undefined;
  if (rawDelegation !== undefined && !delegation) return null;
  if ((isBrowserAction && !browserAction)
    || (!isBrowserAction && rawBrowserAction !== undefined)
    || !isRecord(target)
    || typeof target.url !== "string"
    || typeof target.host !== "string"
    || !isRecord(engine)
    || !isProviderId(engine.provider)
    || typeof engine.model !== "string"
    || typeof approval.body.request !== "string"
    || typeof approval.body.botId !== "string"
    || !Number.isInteger(approval.body.botVersion)
    || !["fixed", "auto"].includes(String(approval.body.selectionMode))
    || typeof approval.body.meteredFallbackAuthorized !== "boolean"
    || (approval.body.selectionMode === "fixed" && approval.body.meteredFallbackAuthorized)) return null;
  if (skills.length !== rawSkills.length
    || Object.keys(skillVersions).length !== skills.length
    || !skills.every((skill) => skillVersions[skill.id] === skill.version)) return null;
  return {
    approvalId: approval.id,
    runId: approval.runId,
    botId: approval.body.botId,
    botVersion: Number(approval.body.botVersion),
    request: approval.body.request,
    target: { url: target.url, host: target.host },
    engine: {
      provider: engine.provider as IntelligenceSelection["provider"],
      model: engine.model,
    },
    selectionMode: approval.body.selectionMode as PendingBrowserRun["selectionMode"],
    meteredFallbackAuthorized: approval.body.meteredFallbackAuthorized,
    approvalMode: approval.body.approvalMode === "safe-auto" ? "safe-auto" : "ask",
    approvalSource: ["bot-safe-mode", "bot-domain-scope"].includes(String(approval.body.decisionSource))
      ? approval.body.decisionSource as PendingBrowserRun["approvalSource"]
      : "pending-user",
    memories,
    memorySnapshotHash: typeof approval.body.memorySnapshotHash === "string"
      ? approval.body.memorySnapshotHash
      : "none",
    skills,
    skillVersions,
    ...(browserAction ? { browserAction } : {}),
    ...(delegation ? { delegation } : {}),
  };
}

export function pendingComputerRunFromApproval(approval: LocalRunApproval): PendingComputerRun | null {
  if (approval.status !== "awaiting" || !isRecord(approval.body) || approval.body.kind !== "computer-action") {
    return null;
  }
  const app = approval.body.app;
  const action = approval.body.action;
  const engine = approval.body.engine;
  const rawMemoryIds = Array.isArray(approval.body.memoryIds) ? approval.body.memoryIds : [];
  const memoryIds = rawMemoryIds
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 120);
  const rawSkillVersions = isRecord(approval.body.skillVersions)
    ? Object.entries(approval.body.skillVersions)
    : [];
  const skillVersions = Object.fromEntries(rawSkillVersions
      .filter(([id, version]) => id.length > 0 && Number.isInteger(version) && Number(version) > 0)
      .map(([id, version]) => [id, Number(version)]));
  const actionKeys = isRecord(action) ? Object.keys(action) : [];
  const actionKind = isRecord(action) ? action.kind : undefined;
  const setValue = actionKind === "setValue" && isRecord(action) ? action.value : undefined;
  const meteredProvider = isRecord(engine)
    && ["openai", "anthropic", "gemini"].includes(String(engine.provider));
  const expectedBillingFallback = approval.body.selectionMode === "auto"
    && approval.body.meteredFallbackAuthorized === true
    && approval.body.meteredProviderInvocationStarted === true;
  if (!isRecord(app)
    || typeof app.bundleId !== "string"
    || app.bundleId.length < 3
    || app.bundleId.length > 255
    || !app.bundleId.includes(".")
    || typeof app.appName !== "string"
    || app.appName.trim().length === 0
    || app.appName.length > 120
    || !isRecord(action)
    || !["press", "setValue"].includes(String(actionKind))
    || typeof action.target !== "string"
    || action.target.trim().length === 0
    || action.target.length > 160
    || action.target.split("").some((character) => /[\u0000-\u001f\u007f]/.test(character))
    || (action.role !== undefined && typeof action.role !== "string")
    || (typeof action.role === "string" && (
      action.role.length === 0
      || action.role.length > 80
      || !/^[A-Za-z0-9]+$/.test(action.role)
    ))
    || (action.occurrence !== undefined && (
      !Number.isInteger(action.occurrence)
      || Number(action.occurrence) < 0
      || Number(action.occurrence) > 99
    ))
    || (actionKind === "press" && (
      action.value !== undefined
      || actionKeys.some((key) => !["kind", "target", "role", "occurrence"].includes(key))
    ))
    || (actionKind === "setValue" && (
      typeof setValue !== "string"
      || setValue.length === 0
      || setValue.length > 2_000
      || setValue.split("").some((character) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(character))
      || actionKeys.some((key) => !["kind", "target", "role", "occurrence", "value"].includes(key))
    ))
    || !isRecord(engine)
    || !isProviderId(engine.provider)
    || typeof engine.model !== "string"
    || engine.model.length === 0
    || engine.model.length > 240
    || typeof approval.body.request !== "string"
    || approval.body.request.length === 0
    || approval.body.request.length > 2_000
    || typeof approval.body.proposedSummary !== "string"
    || approval.body.proposedSummary.trim().length === 0
    || approval.body.proposedSummary.length > 4_000
    || typeof approval.body.botId !== "string"
    || !Number.isInteger(approval.body.botVersion)
    || !["fixed", "auto"].includes(String(approval.body.selectionMode))
    || typeof approval.body.meteredFallbackAuthorized !== "boolean"
    || typeof approval.body.meteredProviderInvocationStarted !== "boolean"
    || typeof approval.body.billingFallback !== "boolean"
    || (approval.body.meteredProviderInvocationStarted && !meteredProvider)
    || approval.body.billingFallback !== expectedBillingFallback
    || typeof approval.body.plannerDurationMs !== "number"
    || !Number.isFinite(approval.body.plannerDurationMs)
    || Number(approval.body.plannerDurationMs) < 0
    || typeof approval.body.plannerCommandPath !== "string"
    || approval.body.plannerCommandPath.trim().length === 0
    || approval.body.plannerCommandPath.length > 2_048
    || (approval.body.plannerVersion !== undefined && (
      typeof approval.body.plannerVersion !== "string"
      || approval.body.plannerVersion.length === 0
      || approval.body.plannerVersion.length > 256
      || approval.body.plannerVersion.split("").some((character) => /[\u0000-\u001f\u007f]/.test(character))
    ))
    || (approval.body.selectionMode === "fixed" && approval.body.meteredFallbackAuthorized)
    || typeof approval.body.memorySnapshotHash !== "string"
    || !(approval.body.memorySnapshotHash === "none" || /^[a-f0-9]{64}$/.test(approval.body.memorySnapshotHash))
    || memoryIds.length !== rawMemoryIds.length
    || new Set(memoryIds).size !== memoryIds.length
    || Object.keys(skillVersions).length !== rawSkillVersions.length) {
    return null;
  }
  return {
    approvalId: approval.id,
    runId: approval.runId,
    botId: approval.body.botId,
    botVersion: Number(approval.body.botVersion),
    request: approval.body.request,
    app: { bundleId: app.bundleId, appName: app.appName },
    action: {
      kind: action.kind as ComputerSemanticAction["kind"],
      target: action.target,
      ...(action.role ? { role: action.role } : {}),
      ...(action.occurrence !== undefined ? { occurrence: Number(action.occurrence) } : {}),
      ...(action.kind === "setValue" ? { value: action.value as string } : {}),
    } as ComputerSemanticAction,
    proposedSummary: approval.body.proposedSummary,
    engine: {
      provider: engine.provider as IntelligenceSelection["provider"],
      model: engine.model,
    },
    selectionMode: approval.body.selectionMode as PendingComputerRun["selectionMode"],
    meteredFallbackAuthorized: approval.body.meteredFallbackAuthorized,
    meteredProviderInvocationStarted: approval.body.meteredProviderInvocationStarted,
    billingFallback: approval.body.billingFallback,
    plannerDurationMs: Number(approval.body.plannerDurationMs),
    plannerCommandPath: approval.body.plannerCommandPath,
    ...(approval.body.plannerVersion ? { plannerVersion: approval.body.plannerVersion } : {}),
    memorySnapshotHash: approval.body.memorySnapshotHash,
    memoryIds,
    skillVersions,
  };
}

export function emptyBotExecutionState(botId: string): BotExecutionState {
  return {
    botId,
    runState: "idle",
    activeRunId: null,
    engine: null,
    activeEvent: null,
    liveRun: emptyProviderLiveState(),
    pendingBrowserRun: null,
    pendingComputerRun: null,
    pendingMcpRun: null,
    error: null,
    notice: null,
  };
}

export function botExecutionState(
  states: BotExecutionStates,
  botId: string,
): BotExecutionState {
  return states[botId] || emptyBotExecutionState(botId);
}

function replaceBotExecutionState(
  states: BotExecutionStates,
  botId: string,
  update: (current: BotExecutionState) => BotExecutionState,
): BotExecutionStates {
  const current = botExecutionState(states, botId);
  const next = update(current);
  if (next === current) return states;
  return { ...states, [botId]: next };
}

export function canStartBotExecution(states: BotExecutionStates, botId: string) {
  const current = botExecutionState(states, botId);
  return current.runState === "idle"
    && current.activeRunId === null
    && current.pendingBrowserRun === null
    && current.pendingComputerRun === null
    && current.pendingMcpRun === null;
}

export function startBotExecution(
  states: BotExecutionStates,
  botId: string,
  runId: string,
  engine: IntelligenceSelection | null = null,
): BotExecutionStates {
  if (!canStartBotExecution(states, botId)) {
    throw new Error("This bot already has an active run.");
  }
  return replaceBotExecutionState(states, botId, (current) => ({
    ...current,
    runState: "running",
    activeRunId: runId,
    engine,
    activeEvent: null,
    liveRun: emptyProviderLiveState(runId),
    pendingBrowserRun: null,
    pendingComputerRun: null,
    pendingMcpRun: null,
    error: null,
    notice: null,
  }));
}

export function applyBotRunEvent(
  states: BotExecutionStates,
  botId: string,
  event: ProviderRunEvent,
): BotExecutionStates {
  return replaceBotExecutionState(states, botId, (current) => {
    if (current.activeRunId !== event.runId) return current;
    return {
      ...current,
      activeEvent: event,
      liveRun: reduceProviderLiveState(current.liveRun, event),
    };
  });
}

export function revealBotExecutionAnswer(
  states: BotExecutionStates,
  botId: string,
  runId: string,
  answer: string,
): BotExecutionStates {
  return replaceBotExecutionState(states, botId, (current) => {
    if (current.activeRunId !== runId || current.liveRun.runId !== runId) return current;
    return {
      ...current,
      liveRun: {
        ...current.liveRun,
        phase: "answering",
        status: "Writing answer",
        answer,
      },
    };
  });
}

export function waitForBotBrowserApproval(
  states: BotExecutionStates,
  pending: PendingBrowserRun,
): BotExecutionStates {
  return replaceBotExecutionState(states, pending.botId, (current) => {
    if (current.activeRunId !== null && current.activeRunId !== pending.runId) {
      throw new Error("This bot already has an active run.");
    }
    return {
      ...current,
      runState: "awaiting-approval",
      activeRunId: pending.runId,
      engine: pending.engine,
      liveRun: current.activeRunId === pending.runId
        ? current.liveRun
        : emptyProviderLiveState(pending.runId),
      pendingBrowserRun: pending,
      pendingComputerRun: null,
      pendingMcpRun: null,
      error: null,
      notice: null,
    };
  });
}

export function waitForBotComputerApproval(
  states: BotExecutionStates,
  pending: PendingComputerRun,
): BotExecutionStates {
  return replaceBotExecutionState(states, pending.botId, (current) => {
    if (current.activeRunId !== null && current.activeRunId !== pending.runId) {
      throw new Error("This bot already has an active run.");
    }
    return {
      ...current,
      runState: "awaiting-approval",
      activeRunId: pending.runId,
      engine: pending.engine,
      liveRun: current.activeRunId === pending.runId
        ? current.liveRun
        : emptyProviderLiveState(pending.runId),
      pendingComputerRun: pending,
      pendingBrowserRun: null,
      pendingMcpRun: null,
      error: null,
      notice: null,
    };
  });
}

export function waitForBotMcpApproval(
  states: BotExecutionStates,
  pending: PendingMcpRun,
): BotExecutionStates {
  return replaceBotExecutionState(states, pending.botId, (current) => {
    if (current.activeRunId !== null && current.activeRunId !== pending.runId) {
      throw new Error("This bot already has an active run.");
    }
    return {
      ...current,
      runState: "awaiting-approval",
      activeRunId: pending.runId,
      engine: pending.engine,
      liveRun: current.activeRunId === pending.runId
        ? current.liveRun
        : emptyProviderLiveState(pending.runId),
      pendingMcpRun: pending,
      pendingBrowserRun: null,
      pendingComputerRun: null,
      error: null,
      notice: null,
    };
  });
}

export function resumeBotExecution(
  states: BotExecutionStates,
  botId: string,
  runId: string,
): BotExecutionStates {
  return replaceBotExecutionState(states, botId, (current) => {
    if (current.activeRunId !== runId) return current;
    return { ...current, runState: "running" };
  });
}

export function cancelBotExecution(
  states: BotExecutionStates,
  botId: string,
  runId: string,
): BotExecutionStates {
  return replaceBotExecutionState(states, botId, (current) => {
    if (current.activeRunId !== runId || current.runState !== "running") return current;
    return { ...current, runState: "canceling" };
  });
}

export function commitBotExecution(
  states: BotExecutionStates,
  botId: string,
  runId: string,
): BotExecutionStates {
  return replaceBotExecutionState(states, botId, (current) => {
    if (current.activeRunId !== runId || current.runState !== "running") return current;
    return {
      ...current,
      runState: "saving",
      liveRun: {
        ...current.liveRun,
        phase: "complete",
        status: "Saving answer",
      },
    };
  });
}

export function finishBotExecution(
  states: BotExecutionStates,
  botId: string,
  runId: string,
  feedback: { error?: string | null; notice?: string | null } = {},
): BotExecutionStates {
  return replaceBotExecutionState(states, botId, (current) => {
    if (current.activeRunId !== runId) return current;
    return {
      ...current,
      runState: "idle",
      activeRunId: null,
      engine: null,
      activeEvent: null,
      liveRun: emptyProviderLiveState(),
      pendingBrowserRun: null,
      pendingComputerRun: null,
      pendingMcpRun: null,
      error: feedback.error === undefined ? current.error : feedback.error,
      notice: feedback.notice === undefined ? current.notice : feedback.notice,
    };
  });
}

export function setBotExecutionFeedback(
  states: BotExecutionStates,
  botId: string,
  feedback: { error?: string | null; notice?: string | null },
): BotExecutionStates {
  return replaceBotExecutionState(states, botId, (current) => ({
    ...current,
    error: feedback.error === undefined ? current.error : feedback.error,
    notice: feedback.notice === undefined ? current.notice : feedback.notice,
  }));
}

export function replaceWorkspaceForActiveBot(
  catalog: LocalBotsSnapshot | null,
  botId: string,
  threadId: string,
  workspace: LocalWorkspaceSnapshot,
): LocalBotsSnapshot | null {
  if (!catalog
    || catalog.activeBot.id !== botId
    || catalog.activeBot.threadId !== threadId
    || catalog.workspace.thread.id !== threadId
    || workspace.thread.id !== threadId) return catalog;
  return { ...catalog, workspace };
}
