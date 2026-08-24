import type { Firestore } from "firebase-admin/firestore";

export const EXECUTION_PACK = {
  id: "execution-pack-v1",
  name: "Execution Pack",
  priceUsd: 10,
  managedModelCreditUsd: 7,
  managedBrowserMinutes: 300,
} as const;

export interface UsageCreditPurchase {
  id: string;
  packId: typeof EXECUTION_PACK.id;
  priceUsd: number;
  managedModelCreditUsd: number;
  managedBrowserMinutes: number;
  purchasedAt: string;
  paymentIntentId?: string;
  status: "active" | "partially-reversed" | "reversed";
  reversedAmountCents: number;
  reversedModelCreditUsd: number;
  reversedBrowserMinutes: number;
  reversedAt?: string;
  reversalReason?: "refund" | "dispute";
}

export interface UsageCreditGrant {
  id: string;
  type: "creator-referral";
  referralClaimId: string;
  managedModelCreditUsd: number;
  managedBrowserMinutes: number;
  grantedAt: string;
  status: "active" | "reversed";
  reversedAt?: string;
  reversalReason?: "refund" | "dispute" | "abuse";
}

export interface UsageCredits {
  modelAvailableUsd: number;
  modelReservedUsd: number;
  modelPurchasedUsd: number;
  modelSpentUsd: number;
  modelReversedUsd: number;
  modelPurchaseDebtUsd: number;
  modelRewardDebtUsd: number;
  browserAvailableMinutes: number;
  browserReservedMinutes: number;
  browserPurchasedMinutes: number;
  browserSpentMinutes: number;
  browserReversedMinutes: number;
  browserPurchaseDebtMinutes: number;
  browserRewardDebtMinutes: number;
  purchases: UsageCreditPurchase[];
  grants: UsageCreditGrant[];
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function rounded(value: number, digits = 6): number {
  return Number(Math.max(0, value).toFixed(digits));
}

export function normalizeUsageCredits(value: unknown): UsageCredits {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const purchases = Array.isArray(record.purchases)
    ? record.purchases.flatMap((candidate): UsageCreditPurchase[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const purchase = candidate as Partial<UsageCreditPurchase>;
      if (typeof purchase.id !== "string" || typeof purchase.purchasedAt !== "string") return [];
      return [{
        id: purchase.id,
        packId: EXECUTION_PACK.id,
        priceUsd: finiteNonNegative(purchase.priceUsd),
        managedModelCreditUsd: finiteNonNegative(purchase.managedModelCreditUsd),
        managedBrowserMinutes: finiteNonNegative(purchase.managedBrowserMinutes),
        purchasedAt: purchase.purchasedAt,
        ...(typeof purchase.paymentIntentId === "string" ? { paymentIntentId: purchase.paymentIntentId } : {}),
        status: purchase.status === "partially-reversed" || purchase.status === "reversed" ? purchase.status : "active",
        reversedAmountCents: Math.round(finiteNonNegative(purchase.reversedAmountCents)),
        reversedModelCreditUsd: finiteNonNegative(purchase.reversedModelCreditUsd),
        reversedBrowserMinutes: finiteNonNegative(purchase.reversedBrowserMinutes),
        ...(typeof purchase.reversedAt === "string" ? { reversedAt: purchase.reversedAt } : {}),
        ...(purchase.reversalReason === "refund" || purchase.reversalReason === "dispute" ? { reversalReason: purchase.reversalReason } : {}),
      }];
    }).slice(0, 10)
    : [];
  const grants = Array.isArray(record.grants)
    ? record.grants.flatMap((candidate): UsageCreditGrant[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const grant = candidate as Partial<UsageCreditGrant>;
      if (
        typeof grant.id !== "string"
        || typeof grant.referralClaimId !== "string"
        || typeof grant.grantedAt !== "string"
        || grant.type !== "creator-referral"
        || (grant.status !== "active" && grant.status !== "reversed")
      ) return [];
      return [{
        id: grant.id,
        type: "creator-referral",
        referralClaimId: grant.referralClaimId,
        managedModelCreditUsd: finiteNonNegative(grant.managedModelCreditUsd),
        managedBrowserMinutes: finiteNonNegative(grant.managedBrowserMinutes),
        grantedAt: grant.grantedAt,
        status: grant.status,
        ...(typeof grant.reversedAt === "string" ? { reversedAt: grant.reversedAt } : {}),
        ...(grant.reversalReason === "refund" || grant.reversalReason === "dispute" || grant.reversalReason === "abuse" ? { reversalReason: grant.reversalReason } : {}),
      }];
    }).slice(0, 50)
    : [];

  return {
    modelAvailableUsd: finiteNonNegative(record.modelAvailableUsd),
    modelReservedUsd: finiteNonNegative(record.modelReservedUsd),
    modelPurchasedUsd: finiteNonNegative(record.modelPurchasedUsd),
    modelSpentUsd: finiteNonNegative(record.modelSpentUsd),
    modelReversedUsd: finiteNonNegative(record.modelReversedUsd),
    modelPurchaseDebtUsd: finiteNonNegative(record.modelPurchaseDebtUsd),
    modelRewardDebtUsd: finiteNonNegative(record.modelRewardDebtUsd),
    browserAvailableMinutes: finiteNonNegative(record.browserAvailableMinutes),
    browserReservedMinutes: finiteNonNegative(record.browserReservedMinutes),
    browserPurchasedMinutes: finiteNonNegative(record.browserPurchasedMinutes),
    browserSpentMinutes: finiteNonNegative(record.browserSpentMinutes),
    browserReversedMinutes: finiteNonNegative(record.browserReversedMinutes),
    browserPurchaseDebtMinutes: finiteNonNegative(record.browserPurchaseDebtMinutes),
    browserRewardDebtMinutes: finiteNonNegative(record.browserRewardDebtMinutes),
    purchases,
    grants,
  };
}

export function usageCreditsData(credits: UsageCredits, updatedAt: string) {
  return {
    modelAvailableUsd: rounded(credits.modelAvailableUsd),
    modelReservedUsd: rounded(credits.modelReservedUsd),
    modelPurchasedUsd: rounded(credits.modelPurchasedUsd),
    modelSpentUsd: rounded(credits.modelSpentUsd),
    modelReversedUsd: rounded(credits.modelReversedUsd),
    modelPurchaseDebtUsd: rounded(credits.modelPurchaseDebtUsd),
    modelRewardDebtUsd: rounded(credits.modelRewardDebtUsd),
    browserAvailableMinutes: rounded(credits.browserAvailableMinutes, 4),
    browserReservedMinutes: rounded(credits.browserReservedMinutes, 4),
    browserPurchasedMinutes: rounded(credits.browserPurchasedMinutes, 4),
    browserSpentMinutes: rounded(credits.browserSpentMinutes, 4),
    browserReversedMinutes: rounded(credits.browserReversedMinutes, 4),
    browserPurchaseDebtMinutes: rounded(credits.browserPurchaseDebtMinutes, 4),
    browserRewardDebtMinutes: rounded(credits.browserRewardDebtMinutes, 4),
    purchases: credits.purchases.slice(0, 10),
    grants: credits.grants.slice(0, 50),
    updatedAt,
  };
}

export async function grantExecutionPack(input: {
  db: Firestore;
  uid: string;
  purchaseId: string;
  purchasedAt?: string;
  paymentIntentId?: string;
}) {
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(input.purchaseId)) throw new Error("Invalid execution-pack purchase ID");
  const paymentIntentId = input.paymentIntentId?.trim();
  if (paymentIntentId && !/^pi_[A-Za-z0-9_]{4,200}$/.test(paymentIntentId)) throw new Error("Invalid execution-pack payment intent ID");
  const purchasedAt = input.purchasedAt || new Date().toISOString();
  const creditRef = input.db.collection("usage-credits").doc(input.uid);
  const purchaseRef = input.db.collection("usage-credit-purchases").doc(input.purchaseId);

  return input.db.runTransaction(async (transaction) => {
    const [creditSnapshot, purchaseSnapshot] = await Promise.all([
      transaction.get(creditRef),
      transaction.get(purchaseRef),
    ]);
    if (purchaseSnapshot.exists) return { granted: false, credits: normalizeUsageCredits(creditSnapshot.exists ? creditSnapshot.data() : null) };

    const current = normalizeUsageCredits(creditSnapshot.exists ? creditSnapshot.data() : null);
    const modelWithheld = Math.min(current.modelPurchaseDebtUsd, EXECUTION_PACK.managedModelCreditUsd);
    const browserWithheld = Math.min(current.browserPurchaseDebtMinutes, EXECUTION_PACK.managedBrowserMinutes);
    const purchase: UsageCreditPurchase = {
      id: input.purchaseId,
      packId: EXECUTION_PACK.id,
      priceUsd: EXECUTION_PACK.priceUsd,
      managedModelCreditUsd: EXECUTION_PACK.managedModelCreditUsd,
      managedBrowserMinutes: EXECUTION_PACK.managedBrowserMinutes,
      purchasedAt,
      ...(paymentIntentId ? { paymentIntentId } : {}),
      status: "active",
      reversedAmountCents: 0,
      reversedModelCreditUsd: 0,
      reversedBrowserMinutes: 0,
    };
    const credits: UsageCredits = {
      ...current,
      modelAvailableUsd: current.modelAvailableUsd + EXECUTION_PACK.managedModelCreditUsd - modelWithheld,
      modelPurchasedUsd: current.modelPurchasedUsd + EXECUTION_PACK.managedModelCreditUsd,
      modelReversedUsd: current.modelReversedUsd + modelWithheld,
      modelPurchaseDebtUsd: current.modelPurchaseDebtUsd - modelWithheld,
      browserAvailableMinutes: current.browserAvailableMinutes + EXECUTION_PACK.managedBrowserMinutes - browserWithheld,
      browserPurchasedMinutes: current.browserPurchasedMinutes + EXECUTION_PACK.managedBrowserMinutes,
      browserReversedMinutes: current.browserReversedMinutes + browserWithheld,
      browserPurchaseDebtMinutes: current.browserPurchaseDebtMinutes - browserWithheld,
      purchases: [purchase, ...current.purchases.filter((entry) => entry.id !== input.purchaseId)].slice(0, 10),
    };
    transaction.set(creditRef, usageCreditsData(credits, purchasedAt));
    transaction.create(purchaseRef, { uid: input.uid, ...purchase, createdAt: purchasedAt });
    return { granted: true, credits };
  });
}

export async function reverseExecutionPackByPaymentIntent(input: {
  db: Firestore;
  paymentIntentId: string;
  reason: "refund" | "dispute";
  reversedAmountCents: number;
  chargedAmountCents: number;
  reversedAt?: string;
}) {
  if (!/^pi_[A-Za-z0-9_]{4,200}$/.test(input.paymentIntentId)) throw new Error("Invalid execution-pack payment intent ID");
  if (
    !Number.isInteger(input.reversedAmountCents)
    || input.reversedAmountCents <= 0
    || !Number.isInteger(input.chargedAmountCents)
    || input.chargedAmountCents <= 0
  ) throw new Error("Invalid execution-pack reversal amount");

  const matches = await input.db.collection("usage-credit-purchases")
    .where("paymentIntentId", "==", input.paymentIntentId)
    .limit(2)
    .get();
  if (matches.empty) return { reversed: false, complete: false, credits: null };
  if (matches.docs.length !== 1) throw new Error("Ambiguous execution-pack payment intent");

  const purchaseRef = matches.docs[0].ref;
  const candidate = matches.docs[0].data() as Partial<UsageCreditPurchase> & { uid?: unknown };
  const uid = typeof candidate.uid === "string" && /^[A-Za-z0-9_-]{4,200}$/.test(candidate.uid) ? candidate.uid : "";
  if (!uid || candidate.packId !== EXECUTION_PACK.id || candidate.paymentIntentId !== input.paymentIntentId) {
    throw new Error("Invalid execution-pack purchase record");
  }

  const creditRef = input.db.collection("usage-credits").doc(uid);
  const reversedAt = input.reversedAt || new Date().toISOString();
  const fraction = Math.min(1, input.reversedAmountCents / input.chargedAmountCents);
  const targetModelCreditUsd = rounded(EXECUTION_PACK.managedModelCreditUsd * fraction);
  const targetBrowserMinutes = rounded(EXECUTION_PACK.managedBrowserMinutes * fraction, 4);

  return input.db.runTransaction(async (transaction) => {
    const [creditSnapshot, purchaseSnapshot] = await Promise.all([
      transaction.get(creditRef),
      transaction.get(purchaseRef),
    ]);
    if (!purchaseSnapshot.exists) return { reversed: false, complete: false, credits: normalizeUsageCredits(creditSnapshot.exists ? creditSnapshot.data() : null) };
    const stored = purchaseSnapshot.data() as Partial<UsageCreditPurchase> & { uid?: unknown };
    if (stored.uid !== uid || stored.packId !== EXECUTION_PACK.id || stored.paymentIntentId !== input.paymentIntentId) {
      throw new Error("Execution-pack purchase changed during reversal");
    }

    const current = normalizeUsageCredits(creditSnapshot.exists ? creditSnapshot.data() : null);
    const priorModelCreditUsd = finiteNonNegative(stored.reversedModelCreditUsd);
    const priorBrowserMinutes = finiteNonNegative(stored.reversedBrowserMinutes);
    const modelDeltaUsd = rounded(Math.max(0, targetModelCreditUsd - priorModelCreditUsd));
    const browserDeltaMinutes = rounded(Math.max(0, targetBrowserMinutes - priorBrowserMinutes), 4);
    if (modelDeltaUsd === 0 && browserDeltaMinutes === 0) {
      return { reversed: false, complete: fraction === 1, credits: current };
    }

    const modelRemovedUsd = Math.min(current.modelAvailableUsd, modelDeltaUsd);
    const browserRemovedMinutes = Math.min(current.browserAvailableMinutes, browserDeltaMinutes);
    const status = fraction === 1 ? "reversed" as const : "partially-reversed" as const;
    const purchaseUpdate: UsageCreditPurchase = {
      id: typeof stored.id === "string" ? stored.id : purchaseRef.id,
      packId: EXECUTION_PACK.id,
      priceUsd: finiteNonNegative(stored.priceUsd) || EXECUTION_PACK.priceUsd,
      managedModelCreditUsd: finiteNonNegative(stored.managedModelCreditUsd) || EXECUTION_PACK.managedModelCreditUsd,
      managedBrowserMinutes: finiteNonNegative(stored.managedBrowserMinutes) || EXECUTION_PACK.managedBrowserMinutes,
      purchasedAt: typeof stored.purchasedAt === "string" ? stored.purchasedAt : reversedAt,
      paymentIntentId: input.paymentIntentId,
      status,
      reversedAmountCents: Math.max(Math.round(finiteNonNegative(stored.reversedAmountCents)), input.reversedAmountCents),
      reversedModelCreditUsd: targetModelCreditUsd,
      reversedBrowserMinutes: targetBrowserMinutes,
      reversedAt,
      reversalReason: input.reason,
    };
    const credits: UsageCredits = {
      ...current,
      modelAvailableUsd: current.modelAvailableUsd - modelRemovedUsd,
      modelReversedUsd: current.modelReversedUsd + modelRemovedUsd,
      modelPurchaseDebtUsd: current.modelPurchaseDebtUsd + modelDeltaUsd - modelRemovedUsd,
      browserAvailableMinutes: current.browserAvailableMinutes - browserRemovedMinutes,
      browserReversedMinutes: current.browserReversedMinutes + browserRemovedMinutes,
      browserPurchaseDebtMinutes: current.browserPurchaseDebtMinutes + browserDeltaMinutes - browserRemovedMinutes,
      purchases: current.purchases.map((purchase) => purchase.id === purchaseUpdate.id ? purchaseUpdate : purchase),
    };
    transaction.set(creditRef, usageCreditsData(credits, reversedAt));
    transaction.set(purchaseRef, { ...stored, uid, ...purchaseUpdate, updatedAt: reversedAt });
    return { reversed: true, complete: fraction === 1, credits };
  });
}

function validRewardId(value: string) {
  return /^[A-Za-z0-9_-]{8,200}$/.test(value);
}

function storedCreatorReferralGrant(value: unknown, rewardId: string): UsageCreditGrant | null {
  const grant = normalizeUsageCredits({ grants: [value] }).grants[0];
  if (
    !grant
    || grant.id !== rewardId
    || grant.status !== "active"
    || grant.managedModelCreditUsd <= 0
    || grant.managedModelCreditUsd > 10
    || grant.managedBrowserMinutes <= 0
    || grant.managedBrowserMinutes > 1_000
  ) return null;
  return grant;
}

export async function grantCreatorReferralCredits(input: {
  db: Firestore;
  uid: string;
  rewardId: string;
  referralClaimId: string;
  managedModelCreditUsd: number;
  managedBrowserMinutes: number;
  grantedAt?: string;
}) {
  if (!validRewardId(input.rewardId) || !validRewardId(input.referralClaimId)) throw new Error("Invalid creator referral reward ID");
  if (
    !Number.isFinite(input.managedModelCreditUsd)
    || input.managedModelCreditUsd <= 0
    || input.managedModelCreditUsd > 10
    || !Number.isFinite(input.managedBrowserMinutes)
    || input.managedBrowserMinutes <= 0
    || input.managedBrowserMinutes > 1_000
  ) throw new Error("Invalid creator referral reward amount");
  const grantedAt = input.grantedAt || new Date().toISOString();
  const creditRef = input.db.collection("usage-credits").doc(input.uid);
  const grantRef = input.db.collection("usage-credit-grants").doc(input.rewardId);

  return input.db.runTransaction(async (transaction) => {
    const [creditSnapshot, grantSnapshot] = await Promise.all([
      transaction.get(creditRef),
      transaction.get(grantRef),
    ]);
    const current = normalizeUsageCredits(creditSnapshot.exists ? creditSnapshot.data() : null);
    if (grantSnapshot.exists) return { granted: false, credits: current };

    const modelWithheld = Math.min(current.modelRewardDebtUsd, input.managedModelCreditUsd);
    const browserWithheld = Math.min(current.browserRewardDebtMinutes, input.managedBrowserMinutes);
    const grant: UsageCreditGrant = {
      id: input.rewardId,
      type: "creator-referral",
      referralClaimId: input.referralClaimId,
      managedModelCreditUsd: input.managedModelCreditUsd,
      managedBrowserMinutes: input.managedBrowserMinutes,
      grantedAt,
      status: "active",
    };
    const credits: UsageCredits = {
      ...current,
      modelAvailableUsd: current.modelAvailableUsd + input.managedModelCreditUsd - modelWithheld,
      modelPurchasedUsd: current.modelPurchasedUsd + input.managedModelCreditUsd,
      modelReversedUsd: current.modelReversedUsd + modelWithheld,
      modelRewardDebtUsd: current.modelRewardDebtUsd - modelWithheld,
      browserAvailableMinutes: current.browserAvailableMinutes + input.managedBrowserMinutes - browserWithheld,
      browserPurchasedMinutes: current.browserPurchasedMinutes + input.managedBrowserMinutes,
      browserReversedMinutes: current.browserReversedMinutes + browserWithheld,
      browserRewardDebtMinutes: current.browserRewardDebtMinutes - browserWithheld,
      grants: [grant, ...current.grants.filter((entry) => entry.id !== input.rewardId)].slice(0, 50),
    };
    transaction.set(creditRef, usageCreditsData(credits, grantedAt));
    transaction.create(grantRef, { uid: input.uid, ...grant, createdAt: grantedAt });
    return { granted: true, credits };
  });
}

export async function reverseCreatorReferralCredits(input: {
  db: Firestore;
  uid: string;
  rewardId: string;
  reason: "refund" | "dispute" | "abuse";
  reversedAt?: string;
}) {
  if (!validRewardId(input.rewardId)) throw new Error("Invalid creator referral reward ID");
  const reversedAt = input.reversedAt || new Date().toISOString();
  const creditRef = input.db.collection("usage-credits").doc(input.uid);
  const grantRef = input.db.collection("usage-credit-grants").doc(input.rewardId);

  return input.db.runTransaction(async (transaction) => {
    const [creditSnapshot, grantSnapshot] = await Promise.all([
      transaction.get(creditRef),
      transaction.get(grantRef),
    ]);
    const current = normalizeUsageCredits(creditSnapshot.exists ? creditSnapshot.data() : null);
    const stored = grantSnapshot.exists ? grantSnapshot.data() as Record<string, unknown> : null;
    if (!stored || stored.uid !== input.uid || stored.status === "reversed") return { reversed: false, credits: current };
    const grant = current.grants.find((entry) => entry.id === input.rewardId && entry.status === "active")
      || storedCreatorReferralGrant(stored, input.rewardId);
    if (!grant) return { reversed: false, credits: current };

    const modelRemoved = Math.min(current.modelAvailableUsd, grant.managedModelCreditUsd);
    const browserRemoved = Math.min(current.browserAvailableMinutes, grant.managedBrowserMinutes);
    const credits: UsageCredits = {
      ...current,
      modelAvailableUsd: current.modelAvailableUsd - modelRemoved,
      modelReversedUsd: current.modelReversedUsd + modelRemoved,
      modelRewardDebtUsd: current.modelRewardDebtUsd + grant.managedModelCreditUsd - modelRemoved,
      browserAvailableMinutes: current.browserAvailableMinutes - browserRemoved,
      browserReversedMinutes: current.browserReversedMinutes + browserRemoved,
      browserRewardDebtMinutes: current.browserRewardDebtMinutes + grant.managedBrowserMinutes - browserRemoved,
      grants: current.grants.map((entry) => entry.id === input.rewardId ? {
        ...entry,
        status: "reversed" as const,
        reversedAt,
        reversalReason: input.reason,
      } : entry),
    };
    transaction.set(creditRef, usageCreditsData(credits, reversedAt));
    transaction.set(grantRef, { ...stored, status: "reversed", reversalReason: input.reason, reversedAt, updatedAt: reversedAt });
    return { reversed: true, credits };
  });
}

export function usageCreditDrift(credits: UsageCredits) {
  return {
    modelUsd: rounded(Math.abs(credits.modelPurchasedUsd - credits.modelReversedUsd - credits.modelAvailableUsd - credits.modelReservedUsd - credits.modelSpentUsd)),
    browserMinutes: rounded(Math.abs(credits.browserPurchasedMinutes - credits.browserReversedMinutes - credits.browserAvailableMinutes - credits.browserReservedMinutes - credits.browserSpentMinutes), 4),
  };
}
