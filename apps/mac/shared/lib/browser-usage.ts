import crypto from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { assertAgentRuntimeEnabled } from "./agent-runtime-controls";
import type { PlanId } from "./stripe";
import {
  CURRENT_ENTITLEMENT_VERSION,
  entitlementVersionFromProfile,
  paidPlanCatalog,
  type EntitlementVersion,
} from "./plan-catalog";
import { normalizeUsageCredits, usageCreditsData } from "./usage-credits";
import { BROWSER_CONNECTION_RESERVATION_MS } from "./browser-usage-policy";

export {
  BROWSER_CONNECTION_RESERVATION_MS,
  BROWSER_EXECUTION_RESERVATION_MS,
  BROWSER_OPERATOR_RESERVATION_MS,
} from "./browser-usage-policy";

export type BrowserUsagePurpose = "interactive-run" | "hosted-run" | "saved-login" | "takeover" | "teaching";

const RESERVATION_GRACE_MS = 60_000;
const MAX_BROWSER_RESERVATION_MS = BROWSER_CONNECTION_RESERVATION_MS;
export const DEFAULT_BROWSER_MONTHLY_MINUTES: Record<PlanId, number> = {
  pro: paidPlanCatalog("pro").managedBrowserMinutes,
  max: paidPlanCatalog("max").managedBrowserMinutes,
};
export const DEFAULT_BROWSER_COST_PER_MINUTE_USD = 0.002;

export interface BrowserUsagePurposeTotals {
  durationMs: number;
  sessions: number;
}

export interface BrowserUsageMonth {
  durationMs: number;
  includedDurationMs: number;
  topupDurationMs: number;
  reservedMs: number;
  topupReservedMs: number;
  sessions: number;
  failedSessions: number;
  byPurpose: Partial<Record<BrowserUsagePurpose, BrowserUsagePurposeTotals>>;
}

export interface BrowserUsageDoc {
  months?: Record<string, BrowserUsageMonth>;
}

export interface BrowserUsageReservation {
  id: string;
  uid: string;
  monthKey: string;
  plan: PlanId;
  entitlementVersion?: EntitlementVersion;
  purpose: BrowserUsagePurpose;
  runId?: string;
  reservedMs: number;
  includedReservedMs: number;
  topupReservedMs: number;
  startedAt: string;
  expiresAt: string;
  status: "reserved" | "finalized";
  allocated?: boolean;
  succeeded?: boolean;
  durationMs?: number;
  endedAt?: string;
}

export class BrowserUsageLimitError extends Error {
  readonly code = "browser-budget-exceeded";

  constructor(public plan: PlanId, public budgetMinutes: number) {
    super(`Monthly managed-browser allowance reached (${budgetMinutes} minutes on ${plan === "max" ? "Team" : "Pro"}). It resets next month.`);
    this.name = "BrowserUsageLimitError";
  }
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function emptyMonth(): BrowserUsageMonth {
  return { durationMs: 0, includedDurationMs: 0, topupDurationMs: 0, reservedMs: 0, topupReservedMs: 0, sessions: 0, failedSessions: 0, byPurpose: {} };
}

function normalizedMonth(value: unknown): BrowserUsageMonth {
  const record = value && typeof value === "object" ? value as Partial<BrowserUsageMonth> : {};
  const rawPurpose = record.byPurpose && typeof record.byPurpose === "object" ? record.byPurpose : {};
  const byPurpose: BrowserUsageMonth["byPurpose"] = {};
  for (const purpose of ["interactive-run", "hosted-run", "saved-login", "takeover", "teaching"] as const) {
    const totals = rawPurpose[purpose];
    if (!totals || typeof totals !== "object") continue;
    byPurpose[purpose] = {
      durationMs: finiteNonNegative(totals.durationMs),
      sessions: finiteNonNegative(totals.sessions),
    };
  }
  const durationMs = finiteNonNegative(record.durationMs);
  const topupDurationMs = finiteNonNegative(record.topupDurationMs);
  return {
    durationMs,
    includedDurationMs: typeof record.includedDurationMs === "number"
      ? finiteNonNegative(record.includedDurationMs)
      : Math.max(0, durationMs - topupDurationMs),
    topupDurationMs,
    reservedMs: finiteNonNegative(record.reservedMs),
    topupReservedMs: finiteNonNegative(record.topupReservedMs),
    sessions: finiteNonNegative(record.sessions),
    failedSessions: finiteNonNegative(record.failedSessions),
    byPurpose,
  };
}

function usageMonthKey(nowMs: number) {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function planForProfile(profile: unknown): PlanId {
  return profile && typeof profile === "object" && (profile as { plan?: unknown }).plan === "max" ? "max" : "pro";
}

function parseBudgetMinutes(raw: string | undefined, variable: string): number | null {
  if (!raw?.trim() || ["unlimited", "none", "off"].includes(raw.trim().toLowerCase())) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000) {
    throw new Error(`${variable} must be a non-negative number of minutes or "unlimited"`);
  }
  return parsed;
}

export function browserBudgetMinutesForPlan(
  plan: PlanId,
  env: NodeJS.ProcessEnv = process.env,
  entitlementVersion: EntitlementVersion = CURRENT_ENTITLEMENT_VERSION,
): number | null {
  const variable = entitlementVersion === CURRENT_ENTITLEMENT_VERSION
    ? plan === "max" ? "BROWSER_MONTHLY_TEAM_V3_MINUTES" : "BROWSER_MONTHLY_PRO_V3_MINUTES"
    : plan === "max" ? "BROWSER_MONTHLY_MAX_MINUTES" : "BROWSER_MONTHLY_PRO_MINUTES";
  const includedMinutes = paidPlanCatalog(plan, entitlementVersion).managedBrowserMinutes;
  const configured = parseBudgetMinutes(env[variable], variable);
  if (configured === null && !env[variable]?.trim()) return includedMinutes;
  return configured === null ? null : Math.min(configured, includedMinutes);
}

export function browserCostPerMinuteUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BROWSER_COST_PER_MINUTE_USD?.trim();
  if (!raw) return DEFAULT_BROWSER_COST_PER_MINUTE_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) throw new Error("BROWSER_COST_PER_MINUTE_USD must be between 0 and 10");
  return parsed;
}

function assertReservationMs(reservedMs: number) {
  if (!Number.isFinite(reservedMs) || reservedMs <= 0 || reservedMs > MAX_BROWSER_RESERVATION_MS) {
    throw new Error(`Browser reservation must be between 1 and ${MAX_BROWSER_RESERVATION_MS} milliseconds`);
  }
}

export async function reserveBrowserUsage(input: {
  db: Firestore;
  uid: string;
  purpose: BrowserUsagePurpose;
  reservedMs: number;
  nowMs?: number;
  reservationId?: string;
  runId?: string;
}): Promise<{ reservation: BrowserUsageReservation; budgetMinutes: number | null; remainingMs: number | null }> {
  assertAgentRuntimeEnabled("managed-browser");
  assertReservationMs(input.reservedMs);
  const nowMs = input.nowMs ?? Date.now();
  const monthKey = usageMonthKey(nowMs);
  const id = input.reservationId || crypto.randomUUID();
  if (input.runId && !/^[A-Za-z0-9._:-]{1,160}$/.test(input.runId)) throw new Error("Browser run identifier is invalid");
  const usageRef = input.db.collection("browser-usage").doc(input.uid);
  const userRef = input.db.collection("users").doc(input.uid);
  const creditRef = input.db.collection("usage-credits").doc(input.uid);
  const reservationRef = input.db.collection("browser-usage-reservations").doc(id);

  return input.db.runTransaction(async (transaction) => {
    const [userSnap, usageSnap, creditSnap, existingReservation] = await Promise.all([
      transaction.get(userRef),
      transaction.get(usageRef),
      transaction.get(creditRef),
      transaction.get(reservationRef),
    ]);
    if (existingReservation.exists) throw new Error("Browser usage reservation already exists");
    const profile = userSnap.exists ? userSnap.data() : null;
    const plan = planForProfile(profile);
    if (profile?.pro !== true) throw new BrowserUsageLimitError(plan, 0);
    const entitlementVersion = entitlementVersionFromProfile(profile);
    const budgetMinutes = browserBudgetMinutesForPlan(plan, process.env, entitlementVersion);
    const usage = (usageSnap.exists ? usageSnap.data() : {}) as BrowserUsageDoc;
    const months = usage.months && typeof usage.months === "object" ? usage.months : {};
    const month = normalizedMonth(months[monthKey]);
    const credits = normalizeUsageCredits(creditSnap.exists ? creditSnap.data() : null);
    const budgetMs = budgetMinutes === null ? null : budgetMinutes * 60_000;
    const includedAvailableMs = budgetMs === null
      ? input.reservedMs
      : Math.max(0, budgetMs - month.includedDurationMs - month.reservedMs);
    const includedReservedMs = Math.min(input.reservedMs, includedAvailableMs);
    const topupReservedMs = Math.max(0, input.reservedMs - includedReservedMs);
    if (topupReservedMs > credits.browserAvailableMinutes * 60_000 + 1) {
      throw new BrowserUsageLimitError(plan, budgetMinutes ?? 0);
    }

    const startedAt = new Date(nowMs).toISOString();
    const reservation: BrowserUsageReservation = {
      id,
      uid: input.uid,
      monthKey,
      plan,
      entitlementVersion,
      purpose: input.purpose,
      ...(input.runId ? { runId: input.runId } : {}),
      reservedMs: input.reservedMs,
      includedReservedMs,
      topupReservedMs,
      startedAt,
      expiresAt: new Date(nowMs + input.reservedMs + RESERVATION_GRACE_MS).toISOString(),
      status: "reserved",
    };
    transaction.set(usageRef, {
      months: {
        ...months,
        [monthKey]: {
          ...month,
          reservedMs: month.reservedMs + includedReservedMs,
          topupReservedMs: month.topupReservedMs + topupReservedMs,
        },
      },
      updatedAt: startedAt,
    });
    if (topupReservedMs > 0) {
      const topupReservedMinutes = topupReservedMs / 60_000;
      transaction.set(creditRef, usageCreditsData({
        ...credits,
        browserAvailableMinutes: credits.browserAvailableMinutes - topupReservedMinutes,
        browserReservedMinutes: credits.browserReservedMinutes + topupReservedMinutes,
      }, startedAt));
    }
    transaction.create(reservationRef, reservation);
    return {
      reservation,
      budgetMinutes,
      remainingMs: budgetMs === null
        ? null
        : Math.max(0, budgetMs - month.includedDurationMs - month.reservedMs - includedReservedMs),
    };
  });
}

export async function finalizeBrowserUsage(input: {
  db: Firestore;
  uid: string;
  reservationId: string;
  allocated: boolean;
  succeeded: boolean;
  endedAtMs?: number;
  chargeReservedDuration?: boolean;
}): Promise<{ recorded: boolean; durationMs: number }> {
  const reservationRef = input.db.collection("browser-usage-reservations").doc(input.reservationId);
  const usageRef = input.db.collection("browser-usage").doc(input.uid);
  const creditRef = input.db.collection("usage-credits").doc(input.uid);
  return input.db.runTransaction(async (transaction) => {
    const [reservationSnap, usageSnap, creditSnap] = await Promise.all([
      transaction.get(reservationRef),
      transaction.get(usageRef),
      transaction.get(creditRef),
    ]);
    const reservation = (reservationSnap.exists ? reservationSnap.data() : null) as BrowserUsageReservation | null;
    if (!reservation || reservation.uid !== input.uid || reservation.status !== "reserved") return { recorded: false, durationMs: 0 };

    const endedAtMs = input.endedAtMs ?? Date.now();
    const elapsedMs = Math.max(0, endedAtMs - new Date(reservation.startedAt).getTime());
    const durationMs = input.allocated
      ? Math.min(reservation.reservedMs, input.chargeReservedDuration ? reservation.reservedMs : elapsedMs)
      : 0;
    const includedReservedMs = finiteNonNegative(reservation.includedReservedMs ?? reservation.reservedMs);
    const topupReservedMs = finiteNonNegative(reservation.topupReservedMs);
    const includedDurationMs = Math.min(durationMs, includedReservedMs);
    const topupDurationMs = Math.min(topupReservedMs, Math.max(0, durationMs - includedDurationMs));
    const usage = (usageSnap.exists ? usageSnap.data() : {}) as BrowserUsageDoc;
    const months = usage.months && typeof usage.months === "object" ? usage.months : {};
    const month = normalizedMonth(months[reservation.monthKey]);
    const previousPurpose = month.byPurpose[reservation.purpose] || { durationMs: 0, sessions: 0 };
    const nextMonth: BrowserUsageMonth = {
      ...month,
      durationMs: month.durationMs + durationMs,
      includedDurationMs: month.includedDurationMs + includedDurationMs,
      topupDurationMs: month.topupDurationMs + topupDurationMs,
      reservedMs: Math.max(0, month.reservedMs - includedReservedMs),
      topupReservedMs: Math.max(0, month.topupReservedMs - topupReservedMs),
      sessions: month.sessions + (input.allocated ? 1 : 0),
      failedSessions: month.failedSessions + (input.allocated && !input.succeeded ? 1 : 0),
      byPurpose: {
        ...month.byPurpose,
        [reservation.purpose]: {
          durationMs: previousPurpose.durationMs + durationMs,
          sessions: previousPurpose.sessions + (input.allocated ? 1 : 0),
        },
      },
    };
    const endedAt = new Date(endedAtMs).toISOString();
    transaction.set(usageRef, { months: { ...months, [reservation.monthKey]: nextMonth }, updatedAt: endedAt });
    if (topupReservedMs > 0) {
      const credits = normalizeUsageCredits(creditSnap.exists ? creditSnap.data() : null);
      const reservedMinutes = topupReservedMs / 60_000;
      const spentMinutes = topupDurationMs / 60_000;
      transaction.set(creditRef, usageCreditsData({
        ...credits,
        browserAvailableMinutes: credits.browserAvailableMinutes + Math.max(0, reservedMinutes - spentMinutes),
        browserReservedMinutes: Math.max(0, credits.browserReservedMinutes - reservedMinutes),
        browserSpentMinutes: credits.browserSpentMinutes + spentMinutes,
      }, endedAt));
    }
    transaction.update(reservationRef, {
      status: "finalized",
      allocated: input.allocated,
      succeeded: input.succeeded,
      durationMs,
      endedAt,
    });
    return { recorded: true, durationMs };
  });
}

/** Converts timed-out reservations into bounded worst-case usage exactly once. */
export async function finalizeExpiredBrowserUsage(input: { db: Firestore; nowMs?: number; limit?: number }) {
  const nowMs = input.nowMs ?? Date.now();
  const snapshot = await input.db.collection("browser-usage-reservations")
    .where("status", "==", "reserved")
    .where("expiresAt", "<=", new Date(nowMs).toISOString())
    .orderBy("expiresAt", "asc")
    .limit(Math.min(Math.max(input.limit || 100, 1), 500))
    .get();
  let finalized = 0;
  for (const document of snapshot.docs) {
    const reservation = document.data() as BrowserUsageReservation;
    if (reservation.status !== "reserved") continue;
    const result = await finalizeBrowserUsage({
      db: input.db,
      uid: reservation.uid,
      reservationId: document.id,
      allocated: true,
      succeeded: false,
      endedAtMs: nowMs,
      chargeReservedDuration: true,
    });
    if (result.recorded) finalized += 1;
  }
  return finalized;
}

/** Releases expired human-login sessions and restores their saved Context handles. */
export async function cleanupExpiredBrowserConnections(input: { db: Firestore; nowMs?: number; limit?: number }) {
  const nowMs = input.nowMs ?? Date.now();
  const snapshot = await input.db.collection("browser-connections")
    .where("status", "==", "open")
    .where("expiresAt", "<=", new Date(nowMs).toISOString())
    .orderBy("expiresAt", "asc")
    .limit(Math.min(Math.max(input.limit || 100, 1), 500))
    .get();
  const { releaseBrowserbaseSession } = await import("./browserbase");
  const { decryptSecret } = await import("./vault");
  let closed = 0;
  for (const document of snapshot.docs) {
    const connection = document.data() as {
      uid?: string;
      browserSessionId?: string;
      providerSessionIdEnc?: string;
      usageReservationId?: string;
      createdAt?: string;
      expiresAt?: string;
      status?: string;
    };
    if (connection.status !== "open" || !connection.uid || !connection.providerSessionIdEnc || !connection.expiresAt) continue;
    try {
      await releaseBrowserbaseSession(decryptSecret(connection.providerSessionIdEnc));
    } catch (error) {
      console.error(`Expired browser connection cleanup failed (${document.id}):`, error);
      continue;
    }
    if (connection.usageReservationId) {
      await finalizeBrowserUsage({
        db: input.db,
        uid: connection.uid,
        reservationId: connection.usageReservationId,
        allocated: true,
        succeeded: false,
        endedAtMs: nowMs,
      }).catch((error) => console.error(`Browser usage cleanup failed (${document.id}):`, error));
    }
    const endedAt = new Date(nowMs).toISOString();
    await document.ref.update({ status: "closed", closedAt: endedAt });
    if (connection.browserSessionId) {
      const sessionRef = input.db.collection("browser-sessions").doc(connection.browserSessionId);
      await input.db.runTransaction(async (transaction) => {
        const sessionSnap = await transaction.get(sessionRef);
        const session = sessionSnap.exists ? sessionSnap.data() as { uid?: string; status?: string; lastConnectedAt?: string } : null;
        if (session && session.uid === connection.uid && session.status === "connecting" && session.lastConnectedAt === connection.createdAt) {
          transaction.update(sessionRef, { status: "ready", updatedAt: endedAt });
        }
      }).catch(() => {});
    }
    closed += 1;
  }
  return closed;
}

export function browserUsageForMonth(value: unknown, nowMs = Date.now()): BrowserUsageMonth {
  const usage = value && typeof value === "object" ? value as BrowserUsageDoc : {};
  return normalizedMonth(usage.months?.[usageMonthKey(nowMs)] || emptyMonth());
}
