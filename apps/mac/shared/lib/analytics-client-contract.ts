export type AnalyticsMetadata = Record<string, string | number | boolean>;

export const ALLOWED_ANALYTICS_METADATA_KEYS = [
  "added",
  "access",
  "attempts",
  "article",
  "artifactCount",
  "blockedSourceCount",
  "browserShortfallMinutes",
  "builder",
  "category",
  "capability",
  "cadence",
  "changed",
  "choice",
  "clarification",
  "confidence",
  "contained",
  "connectOwnSource",
  "correction",
  "durationMs",
  "effect",
  "embedded",
  "excludedLocalInputs",
  "excludedSecretCount",
  "failed",
  "feedback",
  "fileCount",
  "files",
  "format",
  "funding",
  "inputRefCount",
  "intervalMinutes",
  "legacyCount",
  "liveReads",
  "method",
  "mode",
  "model",
  "modelMode",
  "modelShortfallUsd",
  "networkCalls",
  "nodes",
  "omittedOutputs",
  "operation",
  "page",
  "pack",
  "plan",
  "patterns",
  "placement",
  "priceBand",
  "priceUsd",
  "projectRef",
  "pro",
  "provider",
  "readiness",
  "referencedCount",
  "repository",
  "reason",
  "removed",
  "runnable",
  "retryable",
  "scenarios",
  "score",
  "scope",
  "source",
  "sourceCount",
  "sourceVersion",
  "status",
  "stage",
  "stepCount",
  "steps",
  "template",
  "threadRef",
  "timeSeconds",
  "tools",
  "trafficCampaign",
  "trafficContent",
  "trafficMedium",
  "trafficSource",
  "trafficTerm",
  "type",
  "variant",
  "version",
  "vitals_name",
  "vitals_rating",
  "vitals_value",
  "warnings",
  "watermark",
  "paidClick",
  "adNetwork",
] as const;

const ALLOWED_METADATA_KEYS = new Set<string>(ALLOWED_ANALYTICS_METADATA_KEYS);
const DYNAMIC_PATH_ROOTS = new Set([
  "agent-templates",
  "agents",
  "apps",
  "arch",
  "blog",
  "board",
  "delivery",
  "embed",
  "projects",
  "runs",
  "s",
  "specs",
  "templates",
]);

export function analyticsInternalRef(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  let hash = 2166136261;
  const scoped = `codelit-workspace-v1:${normalized}`;
  for (let index = 0; index < scoped.length; index += 1) {
    hash ^= scoped.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ref_${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

export function sanitizeAnalyticsMetadata(metadata?: AnalyticsMetadata): AnalyticsMetadata {
  if (!metadata) return {};

  const safe: AnalyticsMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(safe).length >= 25 || !ALLOWED_METADATA_KEYS.has(key)) continue;
    if (typeof value === "string") safe[key] = value.slice(0, 128);
    else if (typeof value === "boolean") safe[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return safe;
}

const VISUAL_BUILDER_ENUMS = {
  agent_visual_object_changed: {
    type: ["update-workflow", "update-agent", "update-trigger", "update-step", "update-tool", "toggle-capability", "change-handoff", "direct-mutation", "palette-add-agent", "palette-add-step", "palette-attach-capability", "palette-connect-steps", "palette-insert-approval", "palette-set-step-retry", "palette-set-model-policy"],
  },
  agent_visual_capability_attached: { status: ["attached", "removed"] },
  agent_visual_inspector_opened: { type: ["workflow", "trigger", "agent", "decision", "approval", "output", "connection", "capability", "model-policy"] },
  agent_visual_depth_changed: { mode: ["team", "execution"] },
  agent_visual_ai_change_reviewed: {
    mode: ["preview", "reject", "accept-selected", "accept-all"],
    status: ["shown", "rejected", "accepted"],
    type: ["agent", "capability", "handoff", "approval", "retry", "model-policy", "mixed"],
    variant: ["local", "ai"],
  },
  agent_visual_history_action: { mode: ["undo", "redo"], status: ["applied"] },
  agent_visual_details_opened: { mode: ["details"], source: ["toolbar"] },
  agent_visual_recovery_opened: { mode: ["settings", "pricing"], type: ["provider-key", "live-run", "integration", "web-access", "executor"] },
  agent_visual_mobile_completed: { mode: ["click", "keyboard", "touch"], status: ["completed"] },
} as const;

export type VisualBuilderAnalyticsEvent = keyof typeof VISUAL_BUILDER_ENUMS;

export function visualBuilderAnalyticsMetadata(
  event: VisualBuilderAnalyticsEvent,
  metadata: Record<string, unknown>,
): AnalyticsMetadata {
  const enums = VISUAL_BUILDER_ENUMS[event] as Partial<Record<string, readonly string[]>>;
  const safe: AnalyticsMetadata = {};
  for (const [key, allowed] of Object.entries(enums)) {
    const value = metadata[key];
    if (allowed && typeof value === "string" && allowed.includes(value)) safe[key] = value;
  }
  if (event === "agent_visual_ai_change_reviewed" && typeof metadata.changed === "number" && Number.isInteger(metadata.changed)) {
    safe.changed = Math.max(0, Math.min(12, metadata.changed));
  }
  return safe;
}

export function sanitizeAnalyticsPath(pathname: string): string {
  const clean = pathname.split(/[?#]/, 1)[0] || "/";
  const segments = clean.split("/").filter(Boolean);
  if (segments.length > 1 && DYNAMIC_PATH_ROOTS.has(segments[0])) {
    return `/${segments[0]}/[id]`;
  }
  return clean.slice(0, 500);
}

export function sanitizeAnalyticsReferrer(referrer: string): string {
  if (!referrer) return "";
  try {
    return new URL(referrer).origin.slice(0, 2000);
  } catch {
    return "";
  }
}
