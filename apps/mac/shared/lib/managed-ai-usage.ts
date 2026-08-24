import crypto from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { priceForModel } from "./agent-cost-estimator";
import type { PlanId } from "./stripe";
import {
  CURRENT_ENTITLEMENT_VERSION,
  V2_ENTITLEMENT_VERSION,
  entitlementVersionFromProfile,
  paidPlanCatalog,
  type EntitlementVersion,
} from "./plan-catalog";
import { normalizeUsageCredits, usageCreditsData } from "./usage-credits";
import type { ManagedAiMeterSource } from "./managed-ai-stream-meter";

export const DEFAULT_MANAGED_AI_MONTHLY_REQUESTS: Record<PlanId, number> = {
  pro: paidPlanCatalog("pro").managedAiRequests,
  max: paidPlanCatalog("max").managedAiRequests,
};

export type ManagedModelUsagePurpose = "interactive" | "hosted";

export interface ManagedModelUsageReservation {
  id: string;
  uid: string;
  monthKey: string;
  plan: PlanId;
  entitlementVersion?: EntitlementVersion;
  purpose: ManagedModelUsagePurpose;
  runId?: string;
  status: "reserved" | "finalized" | "released";
  estimateUsd: number;
  includedReservedUsd: number;
  topupReservedUsd: number;
  priorRecordedUsd: number;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  actualUsd?: number;
  uncoveredUsd?: number;
  meterSource?: ManagedAiMeterSource | "workflow-estimate";
  inputTokens?: number;
  outputTokens?: number;
  releaseReason?: string;
}

export class ManagedAiUsageLimitError extends Error {
  readonly code = "managed-ai-budget-exceeded";
  readonly status = 429;

  constructor(message: string) {
    super(message);
    this.name = "ManagedAiUsageLimitError";
  }
}

function monthKey(nowMs: number) {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function rounded(value: number, digits = 6) {
  return Number(Math.max(0, value).toFixed(digits));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function usageMonth(value: unknown) {
  const current = record(value);
  const usd = finiteNonNegative(current.usd);
  const topupUsd = finiteNonNegative(current.topupUsd);
  return {
    ...current,
    usd,
    includedUsd: typeof current.includedUsd === "number" ? finiteNonNegative(current.includedUsd) : Math.max(0, usd - topupUsd),
    topupUsd,
    includedReservedUsd: finiteNonNegative(current.includedReservedUsd),
    runs: Math.floor(finiteNonNegative(current.runs)),
    interactiveRequests: Math.floor(finiteNonNegative(current.interactiveRequests)),
    interactiveEstimatedUsd: finiteNonNegative(current.interactiveEstimatedUsd),
    hostedActualUsd: finiteNonNegative(current.hostedActualUsd),
    reconciliationDriftUsd: finiteNonNegative(current.reconciliationDriftUsd),
  };
}

export function managedAiRequestLimitForPlan(
  plan: PlanId,
  env: Record<string, string | undefined> = process.env,
  entitlementVersion: EntitlementVersion = CURRENT_ENTITLEMENT_VERSION,
) {
  const key = entitlementVersion === CURRENT_ENTITLEMENT_VERSION
    ? plan === "max" ? "MANAGED_AI_MONTHLY_TEAM_V3_REQUESTS" : "MANAGED_AI_MONTHLY_PRO_V3_REQUESTS"
    : plan === "max" ? "MANAGED_AI_MONTHLY_MAX_REQUESTS" : "MANAGED_AI_MONTHLY_PRO_REQUESTS";
  const includedLimit = paidPlanCatalog(plan, entitlementVersion).managedAiRequests;
  const raw = env[key]?.trim();
  if (!raw) return includedLimit;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100_000) throw new Error(`${key} must be an integer between 0 and 100000`);
  return Math.min(value, includedLimit);
}

export function managedAiRequestEstimateUsd(model: string, inputChars: number, maxOutputTokens: number): number {
  const normalized = model.trim().toLowerCase();
  if (normalized === "openrouter/free" || normalized.endsWith(":free")) return 0;
  const price = priceForModel(model);
  const inputTokens = Math.ceil(Math.max(0, inputChars) / 4);
  const outputTokens = Math.max(0, Math.ceil(maxOutputTokens));
  const estimate = (inputTokens / 1_000_000) * price.inputPerMTok + (outputTokens / 1_000_000) * price.outputPerMTok;
  return Number(Math.min(1, Math.max(0, estimate)).toFixed(6));
}

export async function reserveManagedModelUsage(input: {
  db: Firestore;
  uid: string;
  purpose: ManagedModelUsagePurpose;
  estimateUsd: number;
  priorRecordedUsd?: number;
  nowMs?: number;
  reservationId?: string;
  runId?: string;
}) {
  if (!Number.isFinite(input.estimateUsd) || input.estimateUsd < 0 || input.estimateUsd > 10) {
    throw new Error("Managed-model reservation must be between $0 and $10");
  }
  const nowMs = input.nowMs ?? Date.now();
  const month = monthKey(nowMs);
  const estimateUsd = rounded(input.estimateUsd);
  const reservationId = input.reservationId || crypto.randomUUID();
  if (input.runId && !/^[A-Za-z0-9._:-]{1,160}$/.test(input.runId)) throw new Error("Managed-model run identifier is invalid");
  const userRef = input.db.collection("users").doc(input.uid);
  const usageRef = input.db.collection("hosted-usage").doc(input.uid);
  const creditRef = input.db.collection("usage-credits").doc(input.uid);
  const reservationRef = input.db.collection("managed-usage-reservations").doc(reservationId);

  return input.db.runTransaction(async (transaction) => {
    const [userSnapshot, usageSnapshot, creditSnapshot, existingSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(usageRef),
      transaction.get(creditRef),
      transaction.get(reservationRef),
    ]);
    if (existingSnapshot.exists) {
      const existing = existingSnapshot.data() as ManagedModelUsageReservation;
      if (existing.uid === input.uid && existing.status === "reserved") {
        const entitlementVersion = existing.entitlementVersion || V2_ENTITLEMENT_VERSION;
        const existingUsage = usageSnapshot.exists ? record(usageSnapshot.data()) : {};
        const existingMonth = usageMonth(record(existingUsage.months)[existing.monthKey]);
        return {
          reservation: existing,
          budgetUsd: paidPlanCatalog(existing.plan, entitlementVersion).managedModelBudgetUsd,
          requestLimit: managedAiRequestLimitForPlan(existing.plan, process.env, entitlementVersion),
          requests: existingMonth.interactiveRequests,
        };
      }
      throw new Error("Managed-model usage reservation already exists");
    }

    const profile = userSnapshot.exists ? userSnapshot.data() : null;
    if (profile?.pro !== true) throw new ManagedAiUsageLimitError("An active Pro or Team subscription is required for managed AI.");
    const plan: PlanId = profile.plan === "max" ? "max" : "pro";
    const entitlementVersion = entitlementVersionFromProfile(profile);
    const planCatalog = paidPlanCatalog(plan, entitlementVersion);
    const budgetUsd = planCatalog.managedModelBudgetUsd;
    const usage = usageSnapshot.exists ? record(usageSnapshot.data()) : {};
    const months = record(usage.months);
    const current = usageMonth(months[month]);
    const requestLimit = managedAiRequestLimitForPlan(plan, process.env, entitlementVersion);
    if (input.purpose === "interactive" && current.interactiveRequests >= requestLimit) {
      throw new ManagedAiUsageLimitError(`Monthly managed-AI request allowance reached (${requestLimit} on ${planCatalog.name}). It resets next month.`);
    }

    const credits = normalizeUsageCredits(creditSnapshot.exists ? creditSnapshot.data() : null);
    const includedAvailableUsd = Math.max(0, budgetUsd - current.includedUsd - current.includedReservedUsd);
    const includedReservedUsd = Math.min(estimateUsd, includedAvailableUsd);
    const topupReservedUsd = rounded(estimateUsd - includedReservedUsd);
    if (topupReservedUsd > credits.modelAvailableUsd + 0.000001) {
      throw new ManagedAiUsageLimitError(`Managed-model capacity is exhausted on ${planCatalog.name}. Add an Execution Pack or wait for the monthly allowance to reset.`);
    }

    const createdAt = new Date(nowMs).toISOString();
    const reservation: ManagedModelUsageReservation = {
      id: reservationId,
      uid: input.uid,
      monthKey: month,
      plan,
      entitlementVersion,
      purpose: input.purpose,
      ...(input.runId ? { runId: input.runId } : {}),
      status: "reserved",
      estimateUsd,
      includedReservedUsd: rounded(includedReservedUsd),
      topupReservedUsd,
      priorRecordedUsd: rounded(input.priorRecordedUsd || 0),
      createdAt,
      expiresAt: new Date(nowMs + (input.purpose === "hosted" ? 73 * 60 * 60_000 : 5 * 60_000)).toISOString(),
      updatedAt: createdAt,
    };
    transaction.set(usageRef, {
      ...usage,
      months: {
        ...months,
        [month]: {
          ...current,
          includedReservedUsd: rounded(current.includedReservedUsd + includedReservedUsd),
          interactiveRequests: current.interactiveRequests + (input.purpose === "interactive" ? 1 : 0),
        },
      },
      updatedAt: createdAt,
    });
    if (topupReservedUsd > 0) {
      transaction.set(creditRef, usageCreditsData({
        ...credits,
        modelAvailableUsd: credits.modelAvailableUsd - topupReservedUsd,
        modelReservedUsd: credits.modelReservedUsd + topupReservedUsd,
      }, createdAt));
    }
    transaction.create(reservationRef, reservation);
    return {
      reservation,
      budgetUsd,
      requestLimit,
      requests: current.interactiveRequests + (input.purpose === "interactive" ? 1 : 0),
    };
  });
}

async function settleManagedModelUsage(input: {
  db: Firestore;
  uid: string;
  reservationId: string;
  status: "finalized" | "released";
  actualUsd?: number;
  reason?: string;
  meterSource?: ManagedModelUsageReservation["meterSource"];
  inputTokens?: number;
  outputTokens?: number;
  nowMs?: number;
}) {
  const reservationRef = input.db.collection("managed-usage-reservations").doc(input.reservationId);
  const usageRef = input.db.collection("hosted-usage").doc(input.uid);
  const creditRef = input.db.collection("usage-credits").doc(input.uid);

  return input.db.runTransaction(async (transaction) => {
    const [reservationSnapshot, usageSnapshot, creditSnapshot] = await Promise.all([
      transaction.get(reservationRef),
      transaction.get(usageRef),
      transaction.get(creditRef),
    ]);
    const reservation = reservationSnapshot.exists ? reservationSnapshot.data() as ManagedModelUsageReservation : null;
    if (!reservation || reservation.uid !== input.uid || reservation.status !== "reserved") return { recorded: false, actualUsd: 0 };

    const reportedActualUsd = input.status === "finalized" ? finiteNonNegative(input.actualUsd) : 0;
    const billableActualUsd = reservation.purpose === "hosted"
      ? Math.max(0, reportedActualUsd - reservation.priorRecordedUsd)
      : reportedActualUsd;
    const actualUsd = rounded(Math.min(reservation.estimateUsd, billableActualUsd));
    const uncoveredUsd = rounded(Math.max(0, billableActualUsd - reservation.estimateUsd));
    const includedActualUsd = Math.min(actualUsd, reservation.includedReservedUsd);
    const topupActualUsd = rounded(Math.max(0, actualUsd - includedActualUsd));
    const usage = usageSnapshot.exists ? record(usageSnapshot.data()) : {};
    const months = record(usage.months);
    const current = usageMonth(months[reservation.monthKey]);
    const credits = normalizeUsageCredits(creditSnapshot.exists ? creditSnapshot.data() : null);
    const updatedAt = new Date(input.nowMs ?? Date.now()).toISOString();

    transaction.set(usageRef, {
      ...usage,
      months: {
        ...months,
        [reservation.monthKey]: {
          ...current,
          usd: rounded(current.usd + actualUsd),
          includedUsd: rounded(current.includedUsd + includedActualUsd),
          topupUsd: rounded(current.topupUsd + topupActualUsd),
          includedReservedUsd: rounded(Math.max(0, current.includedReservedUsd - reservation.includedReservedUsd)),
          interactiveRequests: Math.max(0, current.interactiveRequests - (input.status === "released" && reservation.purpose === "interactive" ? 1 : 0)),
          interactiveEstimatedUsd: rounded(current.interactiveEstimatedUsd + (input.status === "finalized" && reservation.purpose === "interactive" ? actualUsd : 0)),
          hostedActualUsd: rounded(current.hostedActualUsd + (input.status === "finalized" && reservation.purpose === "hosted" ? actualUsd : 0)),
          reconciliationDriftUsd: rounded(finiteNonNegative(current.reconciliationDriftUsd) + uncoveredUsd),
        },
      },
      updatedAt,
    });
    if (reservation.topupReservedUsd > 0) {
      transaction.set(creditRef, usageCreditsData({
        ...credits,
        modelAvailableUsd: credits.modelAvailableUsd + Math.max(0, reservation.topupReservedUsd - topupActualUsd),
        modelReservedUsd: Math.max(0, credits.modelReservedUsd - reservation.topupReservedUsd),
        modelSpentUsd: credits.modelSpentUsd + topupActualUsd,
      }, updatedAt));
    }
    transaction.update(reservationRef, {
      status: input.status,
      actualUsd,
      uncoveredUsd,
      ...(input.status === "finalized" && input.meterSource ? { meterSource: input.meterSource } : {}),
      ...(input.status === "finalized" && Number.isFinite(input.inputTokens) ? { inputTokens: Math.max(0, Math.floor(input.inputTokens || 0)) } : {}),
      ...(input.status === "finalized" && Number.isFinite(input.outputTokens) ? { outputTokens: Math.max(0, Math.floor(input.outputTokens || 0)) } : {}),
      ...(input.reason ? { releaseReason: input.reason.slice(0, 160) } : {}),
      updatedAt,
    });
    return { recorded: true, actualUsd, uncoveredUsd };
  });
}

export function finalizeManagedModelUsage(input: {
  db: Firestore;
  uid: string;
  reservationId: string;
  actualUsd: number;
  meterSource?: ManagedModelUsageReservation["meterSource"];
  inputTokens?: number;
  outputTokens?: number;
  nowMs?: number;
}) {
  return settleManagedModelUsage({ ...input, status: "finalized" });
}

export function releaseManagedModelUsage(input: { db: Firestore; uid: string; reservationId: string; reason: string; nowMs?: number }) {
  return settleManagedModelUsage({ ...input, status: "released" });
}

export async function reserveManagedAiUsage(input: {
  db: Firestore;
  uid: string;
  model: string;
  inputChars: number;
  maxOutputTokens: number;
  nowMs?: number;
  reservationId?: string;
  runId?: string;
}) {
  const estimateUsd = managedAiRequestEstimateUsd(input.model, input.inputChars, input.maxOutputTokens);
  const result = await reserveManagedModelUsage({
    db: input.db,
    uid: input.uid,
    purpose: "interactive",
    estimateUsd,
    nowMs: input.nowMs,
    reservationId: input.reservationId,
    runId: input.runId,
  });
  return {
    ...result,
    plan: result.reservation.plan,
    estimateUsd,
  };
}

export async function finalizeHostedManagedModelUsage(db: Firestore, runId: string) {
  const runSnapshot = await db.collection("hosted-runs").doc(runId).get();
  if (!runSnapshot.exists) return false;
  const run = runSnapshot.data() as { uid?: string; managedUsageReservationId?: string; totalApproxUsd?: number; status?: string };
  if (!run.uid || !run.managedUsageReservationId || !["completed", "halted", "failed"].includes(run.status || "")) return false;
  const result = await finalizeManagedModelUsage({
    db,
    uid: run.uid,
    reservationId: run.managedUsageReservationId,
    actualUsd: finiteNonNegative(run.totalApproxUsd),
    meterSource: "workflow-estimate",
  });
  return result.recorded;
}

/** Conservatively settles abandoned reservations once so capacity cannot leak. */
export async function finalizeExpiredManagedModelUsage(input: { db: Firestore; nowMs?: number; limit?: number }) {
  const nowMs = input.nowMs ?? Date.now();
  const snapshot = await input.db.collection("managed-usage-reservations")
    .where("status", "==", "reserved")
    .where("expiresAt", "<=", new Date(nowMs).toISOString())
    .orderBy("expiresAt", "asc")
    .limit(Math.min(Math.max(input.limit || 100, 1), 500))
    .get();
  let finalized = 0;
  for (const document of snapshot.docs) {
    const reservation = document.data() as ManagedModelUsageReservation;
    if (reservation.status !== "reserved") continue;
    const result = await finalizeManagedModelUsage({
      db: input.db,
      uid: reservation.uid,
      reservationId: document.id,
      actualUsd: reservation.purpose === "hosted"
        ? reservation.priorRecordedUsd + reservation.estimateUsd
        : reservation.estimateUsd,
      meterSource: reservation.purpose === "hosted" ? "workflow-estimate" : "estimated-tokens",
      nowMs,
    });
    if (result.recorded) finalized += 1;
  }
  return finalized;
}
