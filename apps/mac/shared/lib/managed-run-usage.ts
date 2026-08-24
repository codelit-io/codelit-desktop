import type { BrowserUsageReservation } from "./browser-usage";
import type { ManagedModelUsageReservation } from "./managed-ai-usage";

export type ManagedRunUsageBasis = "provider-reported-cost" | "provider-token-counts" | "estimated-token-counts" | "workflow-estimate" | "mixed" | "unavailable";

export interface ManagedRunUsageReceipt {
  runId: string;
  status: "settled" | "pending";
  model: {
    estimatedUsd: number;
    settledUsd: number;
    coveredUsd: number;
    requests: number;
    settledRequests: number;
    releasedRequests: number;
    pendingRequests: number;
    inputTokens: number;
    outputTokens: number;
    basis: ManagedRunUsageBasis;
  };
  browser: {
    reservedMinutes: number;
    settledMinutes: number;
    sessions: number;
    successfulSessions: number;
    pendingSessions: number;
  };
  settledAt?: string;
}

const BASES = new Set<ManagedRunUsageBasis>(["provider-reported-cost", "provider-token-counts", "estimated-token-counts", "workflow-estimate", "mixed", "unavailable"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function rounded(value: number, digits = 6): number {
  return Number(Math.max(0, value).toFixed(digits));
}

function basisFor(reservations: ManagedModelUsageReservation[]): ManagedRunUsageBasis {
  const values = new Set(reservations.flatMap((reservation) => {
    if (reservation.status !== "finalized") return [];
    if (reservation.meterSource === "provider-cost") return ["provider-reported-cost" as const];
    if (reservation.meterSource === "provider-tokens") return ["provider-token-counts" as const];
    if (reservation.meterSource === "estimated-tokens") return ["estimated-token-counts" as const];
    if (reservation.meterSource === "workflow-estimate") return ["workflow-estimate" as const];
    return ["unavailable" as const];
  }));
  return values.size === 0 ? "unavailable" : values.size === 1 ? [...values][0] : "mixed";
}

function latestTimestamp(values: string[]) {
  return values.filter((value) => Number.isFinite(Date.parse(value))).sort().at(-1);
}

export function sanitizeManagedRunUsageReceipt(value: unknown): ManagedRunUsageReceipt | null {
  const input = record(value);
  const runId = typeof input.runId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(input.runId) ? input.runId : "";
  if (!runId || (input.status !== "settled" && input.status !== "pending")) return null;
  const model = record(input.model);
  const browser = record(input.browser);
  const basis = BASES.has(model.basis as ManagedRunUsageBasis) ? model.basis as ManagedRunUsageBasis : "unavailable";
  const settledAt = typeof input.settledAt === "string" && Number.isFinite(Date.parse(input.settledAt)) ? input.settledAt.slice(0, 40) : "";
  return {
    runId,
    status: input.status,
    model: {
      estimatedUsd: rounded(finiteNonNegative(model.estimatedUsd)),
      settledUsd: rounded(finiteNonNegative(model.settledUsd)),
      coveredUsd: rounded(finiteNonNegative(model.coveredUsd)),
      requests: Math.min(100, Math.floor(finiteNonNegative(model.requests))),
      settledRequests: Math.min(100, Math.floor(finiteNonNegative(model.settledRequests))),
      releasedRequests: Math.min(100, Math.floor(finiteNonNegative(model.releasedRequests))),
      pendingRequests: Math.min(100, Math.floor(finiteNonNegative(model.pendingRequests))),
      inputTokens: Math.min(100_000_000, Math.floor(finiteNonNegative(model.inputTokens))),
      outputTokens: Math.min(10_000_000, Math.floor(finiteNonNegative(model.outputTokens))),
      basis,
    },
    browser: {
      reservedMinutes: rounded(finiteNonNegative(browser.reservedMinutes), 2),
      settledMinutes: rounded(finiteNonNegative(browser.settledMinutes), 2),
      sessions: Math.min(100, Math.floor(finiteNonNegative(browser.sessions))),
      successfulSessions: Math.min(100, Math.floor(finiteNonNegative(browser.successfulSessions))),
      pendingSessions: Math.min(100, Math.floor(finiteNonNegative(browser.pendingSessions))),
    },
    ...(settledAt ? { settledAt } : {}),
  };
}

export function buildManagedRunUsageReceipt(input: {
  uid: string;
  runId: string;
  modelReservations: ManagedModelUsageReservation[];
  browserReservations: BrowserUsageReservation[];
}): ManagedRunUsageReceipt | null {
  const model = input.modelReservations.filter((reservation) => reservation.uid === input.uid && reservation.runId === input.runId);
  const browser = input.browserReservations.filter((reservation) => reservation.uid === input.uid && reservation.runId === input.runId);
  if (!model.length && !browser.length) return null;

  const pendingRequests = model.filter((reservation) => reservation.status === "reserved").length;
  const settledRequests = model.filter((reservation) => reservation.status === "finalized").length;
  const releasedRequests = model.filter((reservation) => reservation.status === "released").length;
  const pendingSessions = browser.filter((reservation) => reservation.status === "reserved").length;
  const finalizedBrowser = browser.filter((reservation) => reservation.status === "finalized");
  const settledAt = latestTimestamp([
    ...model.map((reservation) => reservation.updatedAt),
    ...finalizedBrowser.map((reservation) => reservation.endedAt || ""),
  ]);

  return {
    runId: input.runId,
    status: pendingRequests || pendingSessions ? "pending" : "settled",
    model: {
      estimatedUsd: rounded(model.reduce((sum, reservation) => sum + finiteNonNegative(reservation.estimateUsd), 0)),
      settledUsd: rounded(model.reduce((sum, reservation) => sum + (reservation.status === "finalized" ? finiteNonNegative(reservation.actualUsd) : 0), 0)),
      coveredUsd: rounded(model.reduce((sum, reservation) => sum + (reservation.status === "finalized" ? finiteNonNegative(reservation.uncoveredUsd) : 0), 0)),
      requests: model.length,
      settledRequests,
      releasedRequests,
      pendingRequests,
      inputTokens: Math.floor(model.reduce((sum, reservation) => sum + (reservation.status === "finalized" ? finiteNonNegative(reservation.inputTokens) : 0), 0)),
      outputTokens: Math.floor(model.reduce((sum, reservation) => sum + (reservation.status === "finalized" ? finiteNonNegative(reservation.outputTokens) : 0), 0)),
      basis: basisFor(model),
    },
    browser: {
      reservedMinutes: rounded(browser.reduce((sum, reservation) => sum + finiteNonNegative(reservation.reservedMs) / 60_000, 0), 2),
      settledMinutes: rounded(finalizedBrowser.reduce((sum, reservation) => sum + finiteNonNegative(reservation.durationMs) / 60_000, 0), 2),
      sessions: finalizedBrowser.filter((reservation) => reservation.allocated).length,
      successfulSessions: finalizedBrowser.filter((reservation) => reservation.allocated && reservation.succeeded).length,
      pendingSessions,
    },
    ...(settledAt ? { settledAt } : {}),
  };
}
