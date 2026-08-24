const MAX_ACTIVE_MS = 24 * 60 * 60 * 1000;
const MAX_APPROVAL_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

export interface AgentRunTiming {
  durationMs?: number;
  activeDurationMs?: number;
  approvalWaitMs?: number;
  approvalRequestedAt?: string | null;
}

function bounded(value: unknown, max: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(0, Math.round(value)))
    : 0;
}

export function normalizeAgentRunTiming(timing: AgentRunTiming) {
  const approvalWaitMs = bounded(timing.approvalWaitMs, MAX_APPROVAL_WAIT_MS);
  const durationMs = bounded(timing.durationMs, MAX_ACTIVE_MS + MAX_APPROVAL_WAIT_MS);
  const activeDurationMs = Math.max(
    bounded(timing.activeDurationMs, MAX_ACTIVE_MS),
    bounded(Math.max(0, durationMs - approvalWaitMs), MAX_ACTIVE_MS),
  );
  return {
    activeDurationMs,
    approvalWaitMs,
    durationMs: activeDurationMs + approvalWaitMs,
  };
}

export function addAgentRunActiveTime(timing: AgentRunTiming, elapsedMs: number) {
  const current = normalizeAgentRunTiming(timing);
  return normalizeAgentRunTiming({
    activeDurationMs: current.activeDurationMs + bounded(elapsedMs, MAX_ACTIVE_MS),
    approvalWaitMs: current.approvalWaitMs,
  });
}

export function finishAgentRunApprovalWait(timing: AgentRunTiming, decidedAt: string) {
  const current = normalizeAgentRunTiming(timing);
  const requestedAtMs = Date.parse(timing.approvalRequestedAt || "");
  const decidedAtMs = Date.parse(decidedAt);
  const elapsed = Number.isFinite(requestedAtMs) && Number.isFinite(decidedAtMs)
    ? Math.max(0, decidedAtMs - requestedAtMs)
    : 0;
  return normalizeAgentRunTiming({
    activeDurationMs: current.activeDurationMs,
    approvalWaitMs: current.approvalWaitMs + elapsed,
  });
}
