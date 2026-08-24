export const ACCOUNT_PLAN_IDS = ["free", "pro", "max"] as const;
export type AccountPlanId = (typeof ACCOUNT_PLAN_IDS)[number];
export type PaidPlanId = Exclude<AccountPlanId, "free">;

export const LEGACY_ENTITLEMENT_VERSION = "legacy-2026-07" as const;
export const V2_ENTITLEMENT_VERSION = "2026-07-v2" as const;
export const CURRENT_ENTITLEMENT_VERSION = "2026-07-v3" as const;
export type EntitlementVersion =
  | typeof LEGACY_ENTITLEMENT_VERSION
  | typeof V2_ENTITLEMENT_VERSION
  | typeof CURRENT_ENTITLEMENT_VERSION;

/** Existing subscribers keep their original price and capability contract. */
export const LEGACY_PLAN_PRICES_USD: Record<PaidPlanId, number> = {
  pro: 5,
  max: 15,
};

export const V2_PLAN_PRICES_USD: Record<PaidPlanId, number> = {
  pro: 9,
  max: 29,
};

export interface PlanCatalogEntry {
  id: AccountPlanId;
  name: string;
  monthlyPriceUsd: number;
  workspaceSeats: number;
  anonymousGenerationsPerDay: number | null;
  signedInGenerationsPerDay: number | null;
  savedProjects: number | null;
  inTabDailyRuns: number | null;
  inTabConcurrentRuns: number;
  inTabMaxSteps: number;
  connectedReadSources: number;
  activeRunReceipts: number;
  activeAgentApps: number;
  openTabSchedules: number;
  hostedWorkflows: number;
  hostedRunsPerWorkflowPerDay: number;
  managedModelBudgetUsd: number;
  managedAiRequests: number;
  managedBrowserMinutes: number;
}

export interface PaidPlanPositioning {
  label: string;
  summary: string;
  runAction: string;
}

const GRANDFATHERED_PRO_CAPABILITIES = {
  workspaceSeats: 3,
  anonymousGenerationsPerDay: null,
  signedInGenerationsPerDay: null,
  savedProjects: null,
  inTabDailyRuns: null,
  inTabConcurrentRuns: 2,
  inTabMaxSteps: 12,
  connectedReadSources: 9,
  activeRunReceipts: Number.POSITIVE_INFINITY,
  activeAgentApps: 25,
  openTabSchedules: 5,
  hostedWorkflows: 3,
  hostedRunsPerWorkflowPerDay: 24,
  managedModelBudgetUsd: 3,
  managedAiRequests: 1_000,
  managedBrowserMinutes: 60,
} as const;

const GRANDFATHERED_MAX_CAPABILITIES = {
  workspaceSeats: 10,
  anonymousGenerationsPerDay: null,
  signedInGenerationsPerDay: null,
  savedProjects: null,
  inTabDailyRuns: null,
  inTabConcurrentRuns: 4,
  inTabMaxSteps: 12,
  connectedReadSources: 9,
  activeRunReceipts: Number.POSITIVE_INFINITY,
  activeAgentApps: 100,
  openTabSchedules: 20,
  hostedWorkflows: 15,
  hostedRunsPerWorkflowPerDay: 24,
  managedModelBudgetUsd: 15,
  managedAiRequests: 5_000,
  managedBrowserMinutes: 300,
} as const;

export const LEGACY_PLAN_CATALOG = {
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPriceUsd: LEGACY_PLAN_PRICES_USD.pro,
    ...GRANDFATHERED_PRO_CAPABILITIES,
  },
  max: {
    id: "max",
    name: "Max",
    monthlyPriceUsd: LEGACY_PLAN_PRICES_USD.max,
    ...GRANDFATHERED_MAX_CAPABILITIES,
  },
} as const satisfies Record<PaidPlanId, PlanCatalogEntry>;

export const V2_PLAN_CATALOG = {
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPriceUsd: V2_PLAN_PRICES_USD.pro,
    ...GRANDFATHERED_PRO_CAPABILITIES,
  },
  max: {
    id: "max",
    name: "Max",
    monthlyPriceUsd: V2_PLAN_PRICES_USD.max,
    ...GRANDFATHERED_MAX_CAPABILITIES,
  },
} as const satisfies Record<PaidPlanId, PlanCatalogEntry>;

/**
 * Public packaging and default enforced limits. Server-side environment
 * overrides may lower operational ceilings, and the usage API reports those
 * effective values instead of repeating this catalog blindly.
 */
export const PLAN_CATALOG = {
  free: {
    id: "free",
    name: "Free",
    monthlyPriceUsd: 0,
    workspaceSeats: 0,
    anonymousGenerationsPerDay: 5,
    signedInGenerationsPerDay: 10,
    savedProjects: 5,
    inTabDailyRuns: 10,
    inTabConcurrentRuns: 1,
    inTabMaxSteps: 12,
    connectedReadSources: 1,
    activeRunReceipts: 10,
    activeAgentApps: 3,
    openTabSchedules: 1,
    hostedWorkflows: 0,
    hostedRunsPerWorkflowPerDay: 0,
    managedModelBudgetUsd: 0,
    managedAiRequests: 0,
    managedBrowserMinutes: 0,
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPriceUsd: 5,
    workspaceSeats: 1,
    anonymousGenerationsPerDay: null,
    signedInGenerationsPerDay: null,
    savedProjects: null,
    inTabDailyRuns: null,
    inTabConcurrentRuns: 2,
    inTabMaxSteps: 12,
    connectedReadSources: 9,
    activeRunReceipts: Number.POSITIVE_INFINITY,
    activeAgentApps: 25,
    openTabSchedules: 5,
    hostedWorkflows: 1,
    hostedRunsPerWorkflowPerDay: 12,
    managedModelBudgetUsd: 1,
    managedAiRequests: 300,
    managedBrowserMinutes: 15,
  },
  max: {
    id: "max",
    name: "Team",
    monthlyPriceUsd: 15,
    workspaceSeats: 3,
    anonymousGenerationsPerDay: null,
    signedInGenerationsPerDay: null,
    savedProjects: null,
    inTabDailyRuns: null,
    inTabConcurrentRuns: 2,
    inTabMaxSteps: 12,
    connectedReadSources: 9,
    activeRunReceipts: Number.POSITIVE_INFINITY,
    activeAgentApps: 25,
    openTabSchedules: 5,
    hostedWorkflows: 3,
    hostedRunsPerWorkflowPerDay: 24,
    managedModelBudgetUsd: 3,
    managedAiRequests: 1_000,
    managedBrowserMinutes: 60,
  },
} as const satisfies Record<AccountPlanId, PlanCatalogEntry>;

function hostedAutomationLabel(count: number) {
  return `${count} hosted automation${count === 1 ? "" : "s"}`;
}

/** Shared public language for the current paid offers. Entitlements remain in PLAN_CATALOG. */
export const PAID_PLAN_POSITIONING = {
  pro: {
    label: "Solo managed operator",
    summary: `Managed models, browser work, recovery, and ${hostedAutomationLabel(PLAN_CATALOG.pro.hostedWorkflows)} for one operator.`,
    runAction: "Run solo with Pro",
  },
  max: {
    label: "Shared operations",
    summary: `${PLAN_CATALOG.max.workspaceSeats} teammates share managed runs, approvals, Apps, Activity, and ${hostedAutomationLabel(PLAN_CATALOG.max.hostedWorkflows)}.`,
    runAction: "Run together with Team",
  },
} as const satisfies Record<PaidPlanId, PaidPlanPositioning>;

export function accountPlanFromProfile(profile: unknown): AccountPlanId {
  if (!profile || typeof profile !== "object" || (profile as { pro?: unknown }).pro !== true) return "free";
  return (profile as { plan?: unknown }).plan === "max" ? "max" : "pro";
}

export function entitlementVersionFromProfile(profile: unknown): EntitlementVersion {
  if (!profile || typeof profile !== "object") return CURRENT_ENTITLEMENT_VERSION;
  const value = (profile as { entitlementVersion?: unknown }).entitlementVersion;
  if (value === LEGACY_ENTITLEMENT_VERSION) return LEGACY_ENTITLEMENT_VERSION;
  if (value === V2_ENTITLEMENT_VERSION) return V2_ENTITLEMENT_VERSION;
  if (value === CURRENT_ENTITLEMENT_VERSION) return CURRENT_ENTITLEMENT_VERSION;
  // Paid profiles created before versioned packaging are intentionally legacy.
  return (profile as { pro?: unknown }).pro === true ? LEGACY_ENTITLEMENT_VERSION : CURRENT_ENTITLEMENT_VERSION;
}

export function planCatalogForEntitlement(
  plan: AccountPlanId,
  entitlementVersion: EntitlementVersion,
): PlanCatalogEntry {
  if (plan === "free" || entitlementVersion === CURRENT_ENTITLEMENT_VERSION) return PLAN_CATALOG[plan];
  if (entitlementVersion === V2_ENTITLEMENT_VERSION) return V2_PLAN_CATALOG[plan];
  return LEGACY_PLAN_CATALOG[plan];
}

export function planCatalogFromProfile(profile: unknown): PlanCatalogEntry {
  return planCatalogForEntitlement(
    accountPlanFromProfile(profile),
    entitlementVersionFromProfile(profile),
  );
}

export function isGrandfatheredEntitlement(entitlementVersion: EntitlementVersion): boolean {
  return entitlementVersion !== CURRENT_ENTITLEMENT_VERSION;
}

export function paidPlanCatalog(
  plan: PaidPlanId,
  entitlementVersion: EntitlementVersion = CURRENT_ENTITLEMENT_VERSION,
) {
  return planCatalogForEntitlement(plan, entitlementVersion);
}
