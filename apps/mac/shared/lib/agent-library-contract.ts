export const AGENT_LIBRARY_ASSET_KINDS = ["teammate", "skill", "memory", "rubric"] as const;
export type AgentLibraryAssetKind = (typeof AGENT_LIBRARY_ASSET_KINDS)[number];

export const AGENT_LIBRARY_ASSET_STATUSES = ["draft", "active", "archived"] as const;
export type AgentLibraryAssetStatus = (typeof AGENT_LIBRARY_ASSET_STATUSES)[number];

export type AgentLibraryScope =
  | { kind: "private"; ownerUid: string }
  | { kind: "project"; projectOwnerUid: string; projectId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "selected-teams"; projectOwnerUid: string; projectId: string; teamIds: readonly string[] };

export interface AgentLibraryAssetRef<
  Kind extends AgentLibraryAssetKind = AgentLibraryAssetKind,
> {
  kind: Kind;
  id: string;
  version: number;
  digest: string;
  scope: AgentLibraryScope;
}

export interface AgentLibraryAssetVersion<
  Body = unknown,
  Kind extends AgentLibraryAssetKind = AgentLibraryAssetKind,
> {
  id: string;
  kind: Kind;
  version: number;
  digest: string;
  scope: AgentLibraryScope;
  status: AgentLibraryAssetStatus;
  body: Body;
}

export interface AgentLibraryScopeContext {
  principalUid: string;
  teamId: string;
  workspaceId?: string;
  projectRef?: {
    projectOwnerUid: string;
    projectId: string;
  };
}

const SAFE_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_VERSION = 1_000_000;
const MAX_SELECTED_TEAMS = 100;

function safeId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return SAFE_ID.test(normalized) ? normalized : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function sanitizeAgentLibraryScope(value: unknown): AgentLibraryScope | null {
  const input = record(value);
  if (input.kind === "private") {
    const ownerUid = safeId(input.ownerUid);
    return ownerUid ? { kind: "private", ownerUid } : null;
  }
  if (input.kind === "workspace") {
    const workspaceId = safeId(input.workspaceId);
    return workspaceId ? { kind: "workspace", workspaceId } : null;
  }
  if (input.kind === "project") {
    const projectOwnerUid = safeId(input.projectOwnerUid);
    const projectId = safeId(input.projectId);
    return projectOwnerUid && projectId ? { kind: "project", projectOwnerUid, projectId } : null;
  }
  if (input.kind === "selected-teams") {
    const projectOwnerUid = safeId(input.projectOwnerUid);
    const projectId = safeId(input.projectId);
    const teamIds = Array.isArray(input.teamIds)
      ? Array.from(new Set(input.teamIds.map(safeId).filter(Boolean))).sort().slice(0, MAX_SELECTED_TEAMS)
      : [];
    return projectOwnerUid && projectId && teamIds.length
      ? { kind: "selected-teams", projectOwnerUid, projectId, teamIds }
      : null;
  }
  return null;
}

export function sanitizeAgentLibraryAssetRef<
  Kind extends AgentLibraryAssetKind = AgentLibraryAssetKind,
>(
  value: unknown,
  expectedKind?: Kind,
): AgentLibraryAssetRef<Kind> | null {
  const input = record(value);
  const kind = AGENT_LIBRARY_ASSET_KINDS.includes(input.kind as AgentLibraryAssetKind)
    ? input.kind as AgentLibraryAssetKind
    : null;
  const id = safeId(input.id);
  const version = Number(input.version);
  const digest = typeof input.digest === "string" ? input.digest.trim() : "";
  const scope = sanitizeAgentLibraryScope(input.scope);
  if (
    !kind
    || (expectedKind && kind !== expectedKind)
    || !id
    || !Number.isInteger(version)
    || version < 1
    || version > MAX_VERSION
    || !SHA256_DIGEST.test(digest)
    || !scope
  ) {
    return null;
  }
  return { kind: kind as Kind, id, version, digest, scope };
}

export function isAgentLibraryAssetRef<
  Kind extends AgentLibraryAssetKind = AgentLibraryAssetKind,
>(
  value: unknown,
  expectedKind?: Kind,
): value is AgentLibraryAssetRef<Kind> {
  return Boolean(sanitizeAgentLibraryAssetRef(value, expectedKind));
}

export function agentLibraryRefKey(
  ref: Pick<AgentLibraryAssetRef, "kind" | "id" | "version">,
): string {
  return `${ref.kind}:${ref.id}:${ref.version}`;
}

export function sameAgentLibraryScope(left: AgentLibraryScope, right: AgentLibraryScope): boolean {
  const normalizedLeft = sanitizeAgentLibraryScope(left);
  const normalizedRight = sanitizeAgentLibraryScope(right);
  return Boolean(normalizedLeft && normalizedRight && JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight));
}

export function canUseAgentLibraryScope(
  scope: AgentLibraryScope,
  context: AgentLibraryScopeContext,
): boolean {
  if (scope.kind === "private") return scope.ownerUid === context.principalUid;
  if (scope.kind === "workspace") return Boolean(context.workspaceId && scope.workspaceId === context.workspaceId);
  if (!context.projectRef
    || scope.projectOwnerUid !== context.projectRef.projectOwnerUid
    || scope.projectId !== context.projectRef.projectId) {
    return false;
  }
  return scope.kind === "project" || scope.teamIds.includes(context.teamId);
}
