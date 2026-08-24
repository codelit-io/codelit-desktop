import {
  agentRunPlanLimits,
  isPaidAgentPlan,
  type AgentPlan,
} from "./agent-run-entitlements";
import type { EntitlementVersion } from "./plan-catalog";

export type AgentRunMode =
  | "sample"
  | "dry"
  | "in-tab-byok"
  | "local-lite"
  | "device-local"
  | "managed-interactive"
  | "hosted";

export type AgentRunModelFunding = "none" | "user" | "codelit";
export type AgentRunFundingSource = "none" | "user-key" | "user-device" | "codelit-free" | "codelit-model" | "codelit-browser";

export interface AgentRunCapability {
  mode: AgentRunMode;
  available: boolean;
  reason?: string;
  modelFunding: AgentRunModelFunding;
  survivesTabClose: boolean;
  allowsConnectorReads: boolean;
  allowsConnectorWrites: boolean;
  allowsManagedBrowser: boolean;
  dailyRunLimit: number | null;
  maxConcurrentRuns: number;
  maxSteps: number;
  maxReadSources: number;
  maxRunReceipts: number;
  maxOpenTabSchedules: number;
  maxHostedWorkflows: number;
}

export interface AgentRunCapabilityInput {
  authenticated: boolean;
  accountLoading: boolean;
  plan: AgentPlan;
  entitlementVersion?: EntitlementVersion;
  hasSteps: boolean;
  hasSampleFixture: boolean;
  sampleModeEnabled: boolean;
  inTabByokEnabled: boolean;
  localLiteEnabled: boolean;
  deviceLocalEnabled: boolean;
  hasByokKey: boolean;
  byokTransportReady: boolean;
  localLiteReady: boolean;
  hasReviewedLocalContext: boolean;
  deviceLocalReady: boolean;
  connectedReadSourceCount: number;
  requiresConnectorWrite: boolean;
  requiresManagedBrowser: boolean;
  /** Null means browser readiness is checked by the existing execution preflight. */
  managedBrowserReady: boolean | null;
  /** Optional visual model policy preflight. Sample and dry modes never need it. */
  modelPolicyReady?: boolean;
  modelPolicyReason?: string;
}

export type AgentRunCapabilities = Record<AgentRunMode, AgentRunCapability>;
export type AgentRunIntent = "interactive" | "background";
export type AgentRunSetupTarget = "flow" | "sign-in" | "keys" | "local-data" | "web-access" | "pricing" | "account" | "runtime";

export type AdaptiveAgentRunDecision =
  | { kind: "run"; mode: AgentRunMode; capability: AgentRunCapability }
  | { kind: "setup"; mode: AgentRunMode; target: AgentRunSetupTarget; reason: string };

function capability(
  mode: AgentRunMode,
  input: AgentRunCapabilityInput,
  options: Pick<
    AgentRunCapability,
    | "modelFunding"
    | "survivesTabClose"
    | "allowsConnectorReads"
    | "allowsConnectorWrites"
    | "allowsManagedBrowser"
  > & { available: boolean; reason?: string; maxReadSources?: number },
): AgentRunCapability {
  const limits = agentRunPlanLimits(input.plan, input.entitlementVersion);
  return {
    mode,
    available: options.available,
    ...(options.reason ? { reason: options.reason } : {}),
    modelFunding: options.modelFunding,
    survivesTabClose: options.survivesTabClose,
    allowsConnectorReads: options.allowsConnectorReads,
    allowsConnectorWrites: options.allowsConnectorWrites,
    allowsManagedBrowser: options.allowsManagedBrowser,
    dailyRunLimit: limits.inTabDailyRuns,
    maxConcurrentRuns: limits.inTabConcurrentRuns,
    maxSteps: limits.inTabMaxSteps,
    maxReadSources: options.maxReadSources ?? limits.connectedReadSources,
    maxRunReceipts: limits.activeRunReceipts,
    maxOpenTabSchedules: limits.openTabSchedules,
    maxHostedWorkflows: limits.hostedWorkflows,
  };
}

function unavailableForWorkflow(mode: AgentRunMode, input: AgentRunCapabilityInput, funding: AgentRunModelFunding): AgentRunCapability {
  return capability(mode, input, {
    available: false,
    reason: "Add at least one workflow step",
    modelFunding: funding,
    survivesTabClose: mode === "hosted",
    allowsConnectorReads: mode === "managed-interactive" || mode === "hosted",
    allowsConnectorWrites: mode === "managed-interactive" || mode === "hosted",
    allowsManagedBrowser: mode === "managed-interactive" || mode === "hosted",
  });
}

function resolveByok(input: AgentRunCapabilityInput): AgentRunCapability {
  let reason: string | undefined;
  if (input.modelPolicyReady === false) reason = input.modelPolicyReason || "The team model policy is not ready";
  else if (!input.inTabByokEnabled) reason = "In-tab BYOK Runs are not enabled yet";
  else if (input.accountLoading) reason = "Checking your account";
  else if (!input.authenticated) reason = "Sign in to run with your API key";
  else if (!input.hasByokKey) reason = "Add an API key for the selected provider";
  else if (!input.byokTransportReady) reason = "The selected provider is not available for in-tab BYOK yet";
  else if (input.requiresManagedBrowser) reason = "Managed web access is available on Pro and Team";
  else if (input.requiresConnectorWrite) reason = "Connected-app writes require managed execution";

  return capability("in-tab-byok", input, {
    available: !reason,
    ...(reason ? { reason } : {}),
    modelFunding: "user",
    survivesTabClose: false,
    allowsConnectorReads: true,
    allowsConnectorWrites: false,
    allowsManagedBrowser: false,
    maxReadSources: 1,
  });
}

function resolveLocalLite(input: AgentRunCapabilityInput): AgentRunCapability {
  let reason: string | undefined;
  if (input.modelPolicyReady === false) reason = input.modelPolicyReason || "The team model policy is not ready";
  else if (!input.localLiteEnabled) reason = "Run locally is not enabled yet";
  else if (input.accountLoading) reason = "Checking your account";
  else if (!input.authenticated) reason = "Sign in to run locally";
  else if (!input.hasByokKey) reason = "Add an API key for the selected provider";
  else if (!input.byokTransportReady) reason = "The selected provider is not available for Run locally yet";
  else if (!input.localLiteReady) reason = "This browser is not ready for Run locally";
  else if (input.requiresManagedBrowser) reason = "Managed browser use is unavailable while running locally";
  else if (input.requiresConnectorWrite) reason = "Connector writes are unavailable while running locally";
  else if (input.connectedReadSourceCount > 0) reason = "Run locally supports reviewed local files only";
  else if (!input.hasReviewedLocalContext) reason = "Choose reviewed local files before running locally";

  return capability("local-lite", input, {
    available: !reason,
    ...(reason ? { reason } : {}),
    modelFunding: "user",
    survivesTabClose: false,
    allowsConnectorReads: false,
    allowsConnectorWrites: false,
    allowsManagedBrowser: false,
    maxReadSources: 0,
  });
}

function resolveDeviceLocal(input: AgentRunCapabilityInput): AgentRunCapability {
  let reason: string | undefined;
  if (input.modelPolicyReady === false) reason = input.modelPolicyReason || "The team model policy is not ready";
  else if (!input.deviceLocalEnabled) reason = "Device-local Runs are not enabled yet";
  else if (input.accountLoading) reason = "Checking your account";
  else if (!input.authenticated) reason = "Sign in to use a device-local model";
  else if (!input.deviceLocalReady) reason = "This device is not ready for a local model";
  else if (input.requiresManagedBrowser || input.requiresConnectorWrite || input.connectedReadSourceCount > 0) {
    reason = "Device-local Runs support local inputs only";
  }

  return capability("device-local", input, {
    available: !reason,
    ...(reason ? { reason } : {}),
    modelFunding: "user",
    survivesTabClose: false,
    allowsConnectorReads: false,
    allowsConnectorWrites: false,
    allowsManagedBrowser: false,
  });
}

function resolveManaged(input: AgentRunCapabilityInput): AgentRunCapability {
  let reason: string | undefined;
  if (input.modelPolicyReady === false) reason = input.modelPolicyReason || "The team model policy is not ready";
  else if (input.accountLoading) reason = "Checking your account";
  else if (!isPaidAgentPlan(input.plan)) reason = "Managed Live Runs are included with Pro and Team";
  else if (!input.authenticated) reason = "Sign in to use managed Live Runs";
  else if (input.requiresManagedBrowser && input.managedBrowserReady === false) reason = "Set up Web access before running this workflow";

  return capability("managed-interactive", input, {
    available: !reason,
    ...(reason ? { reason } : {}),
    modelFunding: "codelit",
    survivesTabClose: false,
    allowsConnectorReads: true,
    allowsConnectorWrites: true,
    allowsManagedBrowser: true,
  });
}

function resolveHosted(input: AgentRunCapabilityInput): AgentRunCapability {
  let reason: string | undefined;
  if (input.modelPolicyReady === false) reason = input.modelPolicyReason || "The team model policy is not ready";
  else if (input.accountLoading) reason = "Checking your account";
  else if (!isPaidAgentPlan(input.plan)) reason = "Hosted Runs are included with Pro and Team";
  else if (!input.authenticated) reason = "Sign in to schedule hosted runs";
  else if (input.requiresManagedBrowser && input.managedBrowserReady === false) reason = "Set up Web access before scheduling this workflow";

  return capability("hosted", input, {
    available: !reason,
    ...(reason ? { reason } : {}),
    modelFunding: "codelit",
    survivesTabClose: true,
    allowsConnectorReads: true,
    allowsConnectorWrites: true,
    allowsManagedBrowser: true,
  });
}

export function resolveAgentRunCapabilities(input: AgentRunCapabilityInput): AgentRunCapabilities {
  if (!input.hasSteps) {
    return {
      sample: unavailableForWorkflow("sample", input, "none"),
      dry: unavailableForWorkflow("dry", input, "none"),
      "in-tab-byok": unavailableForWorkflow("in-tab-byok", input, "user"),
      "local-lite": unavailableForWorkflow("local-lite", input, "user"),
      "device-local": unavailableForWorkflow("device-local", input, "user"),
      "managed-interactive": unavailableForWorkflow("managed-interactive", input, "codelit"),
      hosted: unavailableForWorkflow("hosted", input, "codelit"),
    };
  }

  const sampleReason = !input.sampleModeEnabled
    ? "Sample Runs are not enabled yet"
    : !input.hasSampleFixture
      ? "This workflow does not have sample data yet"
      : undefined;

  return {
    sample: capability("sample", input, {
      available: !sampleReason,
      ...(sampleReason ? { reason: sampleReason } : {}),
      modelFunding: "none",
      survivesTabClose: false,
      allowsConnectorReads: false,
      allowsConnectorWrites: false,
      allowsManagedBrowser: false,
    }),
    dry: capability("dry", input, {
      available: true,
      modelFunding: "none",
      survivesTabClose: false,
      allowsConnectorReads: false,
      allowsConnectorWrites: false,
      allowsManagedBrowser: false,
    }),
    "in-tab-byok": resolveByok(input),
    "local-lite": resolveLocalLite(input),
    "device-local": resolveDeviceLocal(input),
    "managed-interactive": resolveManaged(input),
    hosted: resolveHosted(input),
  };
}

export function preferredInteractiveRunMode(capabilities: AgentRunCapabilities): AgentRunMode {
  const order: AgentRunMode[] = ["managed-interactive", "local-lite", "in-tab-byok", "device-local", "sample", "dry"];
  return order.find((mode) => capabilities[mode].available) || "dry";
}

function setupTarget(reason: string): AgentRunSetupTarget {
  if (reason === "Add at least one workflow step") return "flow";
  if (reason.includes("Checking your account")) return "account";
  if (reason.includes("Sign in")) return "sign-in";
  if (reason.includes("reviewed local files")) return "local-data";
  if (reason.includes("API key") || reason.includes("selected provider")) return "keys";
  if (reason.includes("Web access")) return "web-access";
  if (reason.includes("Pro and Team") || reason.includes("managed execution") || reason.includes("Managed web access")) return "pricing";
  return "runtime";
}

export function resolveAdaptiveAgentRun(
  capabilities: AgentRunCapabilities,
  intent: AgentRunIntent = "interactive",
): AdaptiveAgentRunDecision {
  if (intent === "background") {
    const hosted = capabilities.hosted;
    return hosted.available
      ? { kind: "run", mode: "hosted", capability: hosted }
      : { kind: "setup", mode: "hosted", target: setupTarget(hosted.reason || "Hosted runtime is unavailable"), reason: hosted.reason || "Hosted runtime is unavailable" };
  }

  const mode = preferredInteractiveRunMode(capabilities);
  const selected = capabilities[mode];
  if (selected.available) return { kind: "run", mode, capability: selected };
  return { kind: "setup", mode, target: setupTarget(selected.reason || "Run runtime is unavailable"), reason: selected.reason || "Run runtime is unavailable" };
}
