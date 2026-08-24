export const WORKSPACE_ARTIFACT_KINDS = [
  "product-plan",
  "architecture",
  "agent-team",
  "plan-ship",
  "receipt",
] as const;

export type WorkspaceArtifactKind = typeof WORKSPACE_ARTIFACT_KINDS[number];

export const WORKSPACE_THREAD_STATUSES = [
  "idle",
  "working",
  "needs-input",
  "completed",
  "failed",
  "archived",
] as const;

export type WorkspaceThreadStatus = typeof WORKSPACE_THREAD_STATUSES[number];

export interface WorkspaceArtifactRef {
  kind: WorkspaceArtifactKind;
  id: string;
  version: string;
  projectId: string;
  title: string;
  editorHref: string;
  createdAt: string;
}

export interface WorkspaceThread {
  id: string;
  ownerUid: string;
  workspaceId?: string;
  projectOwnerUid?: string;
  projectId?: string;
  title: string;
  status: WorkspaceThreadStatus;
  latestBlockSequence: number;
  activeArtifactRefs: WorkspaceArtifactRef[];
  activeRunRef?: string;
  forkCount?: number;
  forkedFromThreadId?: string;
  forkedFromSequence?: number;
  projectionSource?: UnifiedThreadProjectionSource;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedWorkspaceThread extends WorkspaceThread {
  revision: number;
}

interface ThreadBlockBase {
  id: string;
  sequence: number;
  createdAt: string;
}

export type ThreadBlock =
  | (ThreadBlockBase & { type: "user-message"; text: string })
  | (ThreadBlockBase & { type: "assistant-message"; text: string })
  | (ThreadBlockBase & {
      type: "progress";
      label: string;
      detail?: string;
      status: "queued" | "working" | "completed" | "stopped";
    })
  | (ThreadBlockBase & { type: "question"; question: string; options: Array<{ id: string; label: string }>; selectedOptionId?: string })
  | (ThreadBlockBase & { type: "artifact"; artifact: WorkspaceArtifactRef; summary: string })
  | (ThreadBlockBase & { type: "run"; runId: string; label: string; detail?: string; status: "queued" | "running" | "completed" | "failed" | "stopped" })
  | (ThreadBlockBase & {
      type: "approval";
      approvalId: string;
      label: string;
      detail?: string;
      approveLabel?: string;
      holdLabel?: string;
      status: "waiting" | "approved" | "held";
    })
  | (ThreadBlockBase & { type: "receipt"; artifact: WorkspaceArtifactRef; summary: string })
  | (ThreadBlockBase & { type: "error"; title: string; detail: string; recoverable: boolean });

export type NewThreadBlock = ThreadBlock extends infer Block
  ? Block extends ThreadBlock
    ? Omit<Block, keyof ThreadBlockBase>
    : never
  : never;

export type WorkspaceIntent = "answer" | "create" | "revise" | "run" | "inspect" | "deliver";

export interface WorkspaceCommand {
  type: WorkspaceIntent;
  artifactKind?: Exclude<WorkspaceArtifactKind, "receipt">;
  targetRef?: string;
}

export interface WorkspaceAgentRunRequest {
  artifactId: string;
  mode: "adaptive" | "live";
  nonce: number;
}

export interface WorkspaceIntentPlan {
  intent: WorkspaceIntent;
  confidence: "high" | "medium" | "low";
  artifactKinds: Array<Exclude<WorkspaceArtifactKind, "receipt">>;
  targetRefs: string[];
  contextRefs: string[];
  requiresClarification: boolean;
  clarification?: {
    question: string;
    options: Array<{ id: string; label: string }>;
  };
  safeActions: WorkspaceCommand[];
}

export type UnifiedThreadProjectionSource =
  | { type: "session"; id: string }
  | { type: "agent-thread"; id: string; projectId: string; teamId: string }
  | { type: "workspace-thread"; id: string }
  | { type: "project-artifact"; projectId: string; artifact: WorkspaceArtifactRef };

export const WORKSPACE_THREAD_STORAGE_VERSION = 1 as const;
export const WORKSPACE_THREAD_MAX_BLOCKS = 500;

export interface WorkspaceThreadContext {
  thread: WorkspaceThread;
  blocks: ThreadBlock[];
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= max
    && (allowEmpty || value.trim().length > 0);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,180}$/.test(value);
}

function isCanonicalTime(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isSafeEditorHref(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1_000 || !value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  try {
    return new URL(value, "https://codelit.local").origin === "https://codelit.local";
  } catch {
    return false;
  }
}

export function isWorkspaceArtifactRef(value: unknown): value is WorkspaceArtifactRef {
  if (!isRecord(value)) return false;
  return WORKSPACE_ARTIFACT_KINDS.includes(value.kind as WorkspaceArtifactKind)
    && isSafeId(value.id)
    && isSafeId(value.version)
    && isSafeId(value.projectId)
    && isBoundedText(value.title, 180)
    && isSafeEditorHref(value.editorHref)
    && isCanonicalTime(value.createdAt);
}

export function isUnifiedThreadProjectionSource(value: unknown): value is UnifiedThreadProjectionSource {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "session" || value.type === "workspace-thread") {
    return isSafeId(value.id);
  }
  if (value.type === "agent-thread") {
    return isSafeId(value.id) && isSafeId(value.projectId) && isSafeId(value.teamId);
  }
  if (value.type === "project-artifact") {
    return isSafeId(value.projectId)
      && isWorkspaceArtifactRef(value.artifact)
      && value.artifact.projectId === value.projectId;
  }
  return false;
}

export function isThreadBlock(value: unknown): value is ThreadBlock {
  if (!isRecord(value)
    || !isSafeId(value.id)
    || !Number.isInteger(value.sequence)
    || Number(value.sequence) < 1
    || !isCanonicalTime(value.createdAt)
    || typeof value.type !== "string") return false;

  if (value.type === "user-message" || value.type === "assistant-message") {
    return isBoundedText(value.text, 12_000, value.type === "assistant-message");
  }
  if (value.type === "progress") {
    return isBoundedText(value.label, 240)
      && (value.detail === undefined || isBoundedText(value.detail, 500, true))
      && ["queued", "working", "completed", "stopped"].includes(String(value.status));
  }
  if (value.type === "question") {
    return isBoundedText(value.question, 1_000)
      && Array.isArray(value.options)
      && value.options.length > 0
      && value.options.length <= 8
      && value.options.every((option) => isRecord(option)
        && isSafeId(option.id)
        && isBoundedText(option.label, 160))
      && (value.selectedOptionId === undefined || isSafeId(value.selectedOptionId));
  }
  if (value.type === "artifact" || value.type === "receipt") {
    return isWorkspaceArtifactRef(value.artifact) && isBoundedText(value.summary, 2_000);
  }
  if (value.type === "run") {
    return isSafeId(value.runId)
      && isBoundedText(value.label, 240)
      && (value.detail === undefined || isBoundedText(value.detail, 2_000, true))
      && ["queued", "running", "completed", "failed", "stopped"].includes(String(value.status));
  }
  if (value.type === "approval") {
    return isSafeId(value.approvalId)
      && isBoundedText(value.label, 240)
      && (value.detail === undefined || isBoundedText(value.detail, 2_000, true))
      && (value.approveLabel === undefined || isBoundedText(value.approveLabel, 120))
      && (value.holdLabel === undefined || isBoundedText(value.holdLabel, 120))
      && ["waiting", "approved", "held"].includes(String(value.status));
  }
  if (value.type === "error") {
    return isBoundedText(value.title, 240)
      && isBoundedText(value.detail, 2_000)
      && typeof value.recoverable === "boolean";
  }
  return false;
}

export function sanitizeThreadBlock(value: unknown): ThreadBlock | null {
  if (!isThreadBlock(value)) return null;
  const base = { id: value.id, sequence: value.sequence, createdAt: value.createdAt };
  if (value.type === "user-message" || value.type === "assistant-message") {
    return { ...base, type: value.type, text: value.text };
  }
  if (value.type === "progress") {
    return {
      ...base,
      type: value.type,
      label: value.label,
      ...(value.detail !== undefined ? { detail: value.detail } : {}),
      status: value.status,
    };
  }
  if (value.type === "question") {
    return {
      ...base,
      type: value.type,
      question: value.question,
      options: value.options.map((option) => ({ id: option.id, label: option.label })),
      ...(value.selectedOptionId ? { selectedOptionId: value.selectedOptionId } : {}),
    };
  }
  if (value.type === "artifact" || value.type === "receipt") {
    return { ...base, type: value.type, artifact: { ...value.artifact }, summary: value.summary };
  }
  if (value.type === "run") {
    return {
      ...base,
      type: value.type,
      runId: value.runId,
      label: value.label,
      ...(value.detail !== undefined ? { detail: value.detail } : {}),
      status: value.status,
    };
  }
  if (value.type === "approval") {
    return {
      ...base,
      type: value.type,
      approvalId: value.approvalId,
      label: value.label,
      ...(value.detail !== undefined ? { detail: value.detail } : {}),
      ...(value.approveLabel !== undefined ? { approveLabel: value.approveLabel } : {}),
      ...(value.holdLabel !== undefined ? { holdLabel: value.holdLabel } : {}),
      status: value.status,
    };
  }
  return {
    ...base,
    type: value.type,
    title: value.title,
    detail: value.detail,
    recoverable: value.recoverable,
  };
}

export function isWorkspaceThread(value: unknown): value is WorkspaceThread {
  if (!isRecord(value)) return false;
  return isSafeId(value.id)
    && isSafeId(value.ownerUid)
    && (value.workspaceId === undefined || isSafeId(value.workspaceId))
    && (value.projectOwnerUid === undefined || isSafeId(value.projectOwnerUid))
    && (value.projectId === undefined || isSafeId(value.projectId))
    && Boolean(value.projectOwnerUid) === Boolean(value.projectId)
    && isBoundedText(value.title, 120)
    && WORKSPACE_THREAD_STATUSES.includes(value.status as WorkspaceThreadStatus)
    && Number.isInteger(value.latestBlockSequence)
    && Number(value.latestBlockSequence) >= 0
    && Array.isArray(value.activeArtifactRefs)
    && value.activeArtifactRefs.length <= 24
    && value.activeArtifactRefs.every(isWorkspaceArtifactRef)
    && (value.activeRunRef === undefined || isSafeId(value.activeRunRef))
    && (value.forkCount === undefined || (Number.isInteger(value.forkCount) && Number(value.forkCount) >= 0))
    && (value.forkedFromThreadId === undefined || isSafeId(value.forkedFromThreadId))
    && (value.forkedFromSequence === undefined
      || (Number.isInteger(value.forkedFromSequence) && Number(value.forkedFromSequence) >= 0))
    && Boolean(value.forkedFromThreadId) === (value.forkedFromSequence !== undefined)
    && (value.projectionSource === undefined || isUnifiedThreadProjectionSource(value.projectionSource))
    && isCanonicalTime(value.createdAt)
    && isCanonicalTime(value.updatedAt);
}

export function workspaceThreadStateFromBlocks(blocks: readonly ThreadBlock[]) {
  const ordered = [...blocks].sort((left, right) => left.sequence - right.sequence);
  const artifacts = new Map<string, WorkspaceArtifactRef>();
  let activeRunRef: string | undefined;
  let waitingSequence = 0;
  let workingSequence = 0;
  let failedSequence = 0;
  let settledSequence = 0;
  let stoppedSequence = 0;
  for (const block of ordered) {
    if (block.type === "artifact" || block.type === "receipt") {
      artifacts.set(`${block.artifact.kind}:${block.artifact.id}`, block.artifact);
      settledSequence = Math.max(settledSequence, block.sequence);
    }
    if (block.type === "progress") {
      if (block.status === "queued" || block.status === "working") workingSequence = Math.max(workingSequence, block.sequence);
      else if (block.status === "completed") settledSequence = Math.max(settledSequence, block.sequence);
      else stoppedSequence = Math.max(stoppedSequence, block.sequence);
    }
    if (block.type === "question") {
      if (!block.selectedOptionId) waitingSequence = Math.max(waitingSequence, block.sequence);
      else settledSequence = Math.max(settledSequence, block.sequence);
    }
    if (block.type === "approval") {
      if (block.status === "waiting") waitingSequence = Math.max(waitingSequence, block.sequence);
      else settledSequence = Math.max(settledSequence, block.sequence);
    }
    if (block.type === "run" && (block.status === "queued" || block.status === "running")) {
      activeRunRef = block.runId;
      workingSequence = Math.max(workingSequence, block.sequence);
    } else if (block.type === "run") {
      if (block.status === "failed") failedSequence = Math.max(failedSequence, block.sequence);
      else if (block.status === "stopped") stoppedSequence = Math.max(stoppedSequence, block.sequence);
      else settledSequence = Math.max(settledSequence, block.sequence);
    }
    if (block.type === "error") failedSequence = Math.max(failedSequence, block.sequence);
  }
  const status: WorkspaceThreadStatus = waitingSequence
    ? "needs-input"
    : workingSequence > Math.max(failedSequence, settledSequence, stoppedSequence)
      ? "working"
      : failedSequence > Math.max(settledSequence, stoppedSequence)
        ? "failed"
        : stoppedSequence > settledSequence
          ? "idle"
          : settledSequence || ordered.some((block) => block.type === "assistant-message" && block.text.trim())
            ? "completed"
            : "idle";
  return {
    status,
    latestBlockSequence: ordered.at(-1)?.sequence || 0,
    activeArtifactRefs: [...artifacts.values()].slice(-24),
    ...(activeRunRef ? { activeRunRef } : {}),
  };
}

export function isWorkspaceIntentPlan(value: unknown): value is WorkspaceIntentPlan {
  if (!isRecord(value)) return false;
  const intents: WorkspaceIntent[] = ["answer", "create", "revise", "run", "inspect", "deliver"];
  const artifactKinds = value.artifactKinds;
  const targetRefs = value.targetRefs;
  const contextRefs = value.contextRefs;
  const safeActions = value.safeActions;
  const confidenceBands = ["high", "medium", "low"];
  return intents.includes(value.intent as WorkspaceIntent)
    && confidenceBands.includes(value.confidence as string)
    && Array.isArray(artifactKinds)
    && artifactKinds.every((kind) => kind !== "receipt" && WORKSPACE_ARTIFACT_KINDS.includes(kind as WorkspaceArtifactKind))
    && Array.isArray(targetRefs)
    && targetRefs.every((ref) => typeof ref === "string")
    && Array.isArray(contextRefs)
    && contextRefs.every((ref) => typeof ref === "string")
    && typeof value.requiresClarification === "boolean"
    && Array.isArray(safeActions)
    && safeActions.every((action) => isRecord(action) && intents.includes(action.type as WorkspaceIntent));
}
