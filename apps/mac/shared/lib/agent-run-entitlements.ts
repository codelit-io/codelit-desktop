import {
  CURRENT_ENTITLEMENT_VERSION,
  PLAN_CATALOG,
  planCatalogForEntitlement,
  type EntitlementVersion,
} from "./plan-catalog";

export type AgentPlan = "free" | "pro" | "max";

/** Future modes stay dark until their implementation phase is verified. */
export const AGENT_RUN_ROLLOUT = {
  sample: true,
  inTabByok: true,
  localLite: true,
  deviceLocal: false,
} as const;

export interface AgentRunPlanLimits {
  inTabDailyRuns: number | null;
  inTabConcurrentRuns: number;
  inTabMaxSteps: number;
  connectedReadSources: number;
  activeRunReceipts: number;
  openTabSchedules: number;
  hostedWorkflows: number;
}

export const AGENT_RUN_PLAN_LIMITS: Record<AgentPlan, AgentRunPlanLimits> = {
  free: {
    inTabDailyRuns: PLAN_CATALOG.free.inTabDailyRuns,
    inTabConcurrentRuns: PLAN_CATALOG.free.inTabConcurrentRuns,
    inTabMaxSteps: PLAN_CATALOG.free.inTabMaxSteps,
    connectedReadSources: PLAN_CATALOG.free.connectedReadSources,
    activeRunReceipts: PLAN_CATALOG.free.activeRunReceipts,
    openTabSchedules: PLAN_CATALOG.free.openTabSchedules,
    hostedWorkflows: PLAN_CATALOG.free.hostedWorkflows,
  },
  pro: {
    inTabDailyRuns: PLAN_CATALOG.pro.inTabDailyRuns,
    inTabConcurrentRuns: PLAN_CATALOG.pro.inTabConcurrentRuns,
    inTabMaxSteps: PLAN_CATALOG.pro.inTabMaxSteps,
    connectedReadSources: PLAN_CATALOG.pro.connectedReadSources,
    activeRunReceipts: PLAN_CATALOG.pro.activeRunReceipts,
    openTabSchedules: PLAN_CATALOG.pro.openTabSchedules,
    hostedWorkflows: PLAN_CATALOG.pro.hostedWorkflows,
  },
  max: {
    inTabDailyRuns: PLAN_CATALOG.max.inTabDailyRuns,
    inTabConcurrentRuns: PLAN_CATALOG.max.inTabConcurrentRuns,
    inTabMaxSteps: PLAN_CATALOG.max.inTabMaxSteps,
    connectedReadSources: PLAN_CATALOG.max.connectedReadSources,
    activeRunReceipts: PLAN_CATALOG.max.activeRunReceipts,
    openTabSchedules: PLAN_CATALOG.max.openTabSchedules,
    hostedWorkflows: PLAN_CATALOG.max.hostedWorkflows,
  },
};

export function agentRunPlanLimits(
  plan: AgentPlan,
  entitlementVersion: EntitlementVersion = CURRENT_ENTITLEMENT_VERSION,
): AgentRunPlanLimits {
  if (entitlementVersion === CURRENT_ENTITLEMENT_VERSION) return AGENT_RUN_PLAN_LIMITS[plan];
  const catalog = planCatalogForEntitlement(plan, entitlementVersion);
  return {
    inTabDailyRuns: catalog.inTabDailyRuns,
    inTabConcurrentRuns: catalog.inTabConcurrentRuns,
    inTabMaxSteps: catalog.inTabMaxSteps,
    connectedReadSources: catalog.connectedReadSources,
    activeRunReceipts: catalog.activeRunReceipts,
    openTabSchedules: catalog.openTabSchedules,
    hostedWorkflows: catalog.hostedWorkflows,
  };
}

export function isPaidAgentPlan(plan: AgentPlan): plan is "pro" | "max" {
  return plan === "pro" || plan === "max";
}
