import type {
  AgentRiskLevel,
  AgentWorkflowTool,
  WorkflowExecutorId,
} from "../stores/agent-workflow-store";
import type { AgentRunMode } from "./agent-run-mode";
import type { AgentPlan } from "./agent-run-entitlements";
import {
  browserAccessScope,
  browserWritePreview,
  validateBrowserToolConfig,
} from "./browser-policy";
import {
  connectorForTool,
  WORKFLOW_CONNECTORS,
  type WorkflowConnectorId,
} from "./workflow-connectors";
import {
  executorForTool,
  githubActionsPreview,
  sanitizeArchitecturePaths,
  sanitizeGitHubActionsConfig,
} from "./workflow-tool-execution";
import {
  CONNECTOR_ACTION_DEFINITIONS,
  connectorActionPreview,
  connectorIdForAction,
  sanitizeConnectorActionConfig,
} from "./connector-actions";
import { customActionPreview, sanitizeCustomActionConfig } from "./custom-integrations";
import { providerOperationPreview, sanitizeProviderOperationConfig } from "./provider-packs";

export type AgentActionMode = "read" | "write" | "notify" | "deploy" | "browser" | "local-code";
export type AgentActionEffect = "read" | "write";
export type AgentActionApproval = "none" | "once" | "every-run" | "every-action";
export type AgentActionIdempotency = "required" | "provider" | "read-only";
export type AgentActionWriteReplay = "not-applicable" | "provider-idempotent" | "single-use-checkpoint";
export type AgentActionRuntimeExecution = "simulated" | "live";

export interface AgentActionInputSchema {
  type: "object";
  required: readonly string[];
  properties: Readonly<Record<string, { type: "string" | "number" | "boolean" | "array" | "object"; bound: string }>>;
}

export interface AgentActionRuntimePolicy {
  mode: AgentRunMode;
  execution: AgentActionRuntimeExecution;
  minimumPlan: AgentPlan;
}

export interface AgentActionDefinition {
  id: string;
  executorId: WorkflowExecutorId;
  operation: string;
  mode: AgentActionMode;
  effect: AgentActionEffect;
  risk: AgentRiskLevel;
  scope: readonly string[];
  inputSchema: AgentActionInputSchema;
  approval: AgentActionApproval;
  idempotency: AgentActionIdempotency;
  writeReplay: AgentActionWriteReplay;
  evidence: readonly string[];
  runtimeCompatibility: readonly AgentActionRuntimePolicy[];
  entitlement: AgentPlan;
  executorLabel: string;
  approvalOwner?: string;
}

export interface ResolvedAgentAction extends Omit<AgentActionDefinition, "scope" | "risk"> {
  toolId: string;
  toolName: string;
  connectorId: WorkflowConnectorId | null;
  risk: AgentRiskLevel;
  scope: string[];
  scopeLabel: string;
  accessLabel: "Read" | "Can act";
  preview: string[];
}

export type WorkflowActionResolutionErrorCode = "design-only" | "no-executor" | "unconfigured" | "unsupported-operation";

export type WorkflowActionResolution =
  | { ok: true; action: ResolvedAgentAction }
  | { ok: false; code: WorkflowActionResolutionErrorCode; reason: string; toolId: string; toolName: string; executorId: WorkflowExecutorId | null; executorLabel: string };

const SIMULATED_RUNTIMES = [
  { mode: "sample", execution: "simulated", minimumPlan: "free" },
  { mode: "dry", execution: "simulated", minimumPlan: "free" },
] as const satisfies readonly AgentActionRuntimePolicy[];

const CONNECTED_READ_RUNTIMES = [
  ...SIMULATED_RUNTIMES,
  { mode: "in-tab-byok", execution: "live", minimumPlan: "free" },
  { mode: "managed-interactive", execution: "live", minimumPlan: "pro" },
  { mode: "hosted", execution: "live", minimumPlan: "pro" },
] as const satisfies readonly AgentActionRuntimePolicy[];

const MANAGED_RUNTIMES = [
  ...SIMULATED_RUNTIMES,
  { mode: "managed-interactive", execution: "live", minimumPlan: "pro" },
  { mode: "hosted", execution: "live", minimumPlan: "pro" },
] as const satisfies readonly AgentActionRuntimePolicy[];

const EMPTY_INPUT = {
  type: "object",
  required: [],
  properties: {},
} as const satisfies AgentActionInputSchema;

const GITHUB_RUN_INPUT = {
  type: "object",
  required: ["runId"],
  properties: { runId: { type: "number", bound: "positive safe integer" } },
} as const satisfies AgentActionInputSchema;

const CONNECTOR_ACTION_RUNTIME_DEFINITIONS: AgentActionDefinition[] = CONNECTOR_ACTION_DEFINITIONS.map((definition) => ({
  id: `connector-action.${definition.operation}`,
  executorId: "connector-action",
  operation: definition.operation,
  mode: definition.connectorId === "slack" ? "notify" : definition.connectorId === "vercel" ? "deploy" : "write",
  effect: "write",
  risk: definition.risk,
  scope: [`one selected ${definition.connectorId} resource`, "one bounded typed operation"],
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: { type: "string", bound: "one registered connected-app operation" },
      config: { type: "object", bound: "operation-specific bounded fields and templates" },
    },
  },
  approval: "every-action",
  idempotency: "required",
  writeReplay: "single-use-checkpoint",
  evidence: ["provider result id", "bounded action audit", "run receipt"],
  runtimeCompatibility: MANAGED_RUNTIMES,
  entitlement: "pro",
  executorLabel: `${WORKFLOW_CONNECTORS[definition.connectorId].label} action`,
  approvalOwner: "Human approval of the rendered action before every connected-app write",
}));

const CUSTOM_ACTION_RUNTIME_DEFINITION: AgentActionDefinition = {
  id: "custom-action.execute",
  executorId: "custom-action",
  operation: "execute",
  mode: "write",
  effect: "write",
  risk: "medium",
  scope: ["one saved HTTPS connection", "one reviewed operation or MCP tool"],
  inputSchema: {
    type: "object",
    required: ["input"],
    properties: { input: { type: "object", bound: "reviewed bounded JSON schema" } },
  },
  approval: "every-action",
  idempotency: "required",
  writeReplay: "single-use-checkpoint",
  evidence: ["bounded remote response", "action audit", "run receipt"],
  runtimeCompatibility: MANAGED_RUNTIMES,
  entitlement: "pro",
  executorLabel: "Custom integration",
  approvalOwner: "Human approval of the exact remote call before execution",
};

const PROVIDER_OPERATION_RUNTIME_DEFINITION: AgentActionDefinition = {
  id: "provider-operation.execute",
  executorId: "provider-operation",
  operation: "execute",
  mode: "read",
  effect: "read",
  risk: "low",
  scope: ["one saved app connection", "one bounded capability"],
  inputSchema: {
    type: "object",
    required: ["input"],
    properties: { input: { type: "object", bound: "provider-specific bounded fields" } },
  },
  approval: "none",
  idempotency: "read-only",
  writeReplay: "not-applicable",
  evidence: ["bounded provider response", "action audit", "run receipt"],
  runtimeCompatibility: MANAGED_RUNTIMES,
  entitlement: "pro",
  executorLabel: "App capability",
};

export const WORKFLOW_ACTION_DEFINITIONS = [
  {
    id: "connector-read.read",
    executorId: "connector-read",
    operation: "read",
    mode: "read",
    effect: "read",
    risk: "low",
    scope: ["selected connected-app resource"],
    inputSchema: EMPTY_INPUT,
    approval: "none",
    idempotency: "read-only",
    writeReplay: "not-applicable",
    evidence: ["bounded source context"],
    runtimeCompatibility: CONNECTED_READ_RUNTIMES,
    entitlement: "free",
    executorLabel: "Connected-app read",
  },
  {
    id: "architecture-docs.read",
    executorId: "architecture-docs",
    operation: "read",
    mode: "read",
    effect: "read",
    risk: "low",
    scope: ["selected repository or page", "up to five safe document paths"],
    inputSchema: {
      type: "object",
      required: [],
      properties: { architecturePaths: { type: "array", bound: "up to five relative safe paths" } },
    },
    approval: "none",
    idempotency: "read-only",
    writeReplay: "not-applicable",
    evidence: ["bounded document excerpts", "source paths"],
    runtimeCompatibility: CONNECTED_READ_RUNTIMES,
    entitlement: "free",
    executorLabel: "Architecture documents",
  },
  ...CONNECTOR_ACTION_RUNTIME_DEFINITIONS,
  CUSTOM_ACTION_RUNTIME_DEFINITION,
  PROVIDER_OPERATION_RUNTIME_DEFINITION,
  {
    id: "github-actions.inspect",
    executorId: "github-actions",
    operation: "inspect",
    mode: "read",
    effect: "read",
    risk: "low",
    scope: ["selected GitHub repository", "recent Actions runs and jobs"],
    inputSchema: EMPTY_INPUT,
    approval: "none",
    idempotency: "read-only",
    writeReplay: "not-applicable",
    evidence: ["Actions run URLs", "bounded run and job status"],
    runtimeCompatibility: CONNECTED_READ_RUNTIMES,
    entitlement: "free",
    executorLabel: "GitHub Actions",
  },
  {
    id: "github-actions.dispatch",
    executorId: "github-actions",
    operation: "dispatch",
    mode: "write",
    effect: "write",
    risk: "medium",
    scope: ["selected GitHub repository", "one workflow id", "one ref"],
    inputSchema: {
      type: "object",
      required: ["workflowId", "ref"],
      properties: {
        workflowId: { type: "string", bound: "160 safe filename characters" },
        ref: { type: "string", bound: "160 safe Git ref characters" },
      },
    },
    approval: "every-action",
    idempotency: "required",
    writeReplay: "single-use-checkpoint",
    evidence: ["provider acceptance status", "Actions URL", "action audit"],
    runtimeCompatibility: MANAGED_RUNTIMES,
    entitlement: "pro",
    executorLabel: "GitHub Actions",
    approvalOwner: "Human approval before dispatch, rerun, or cancel",
  },
  {
    id: "github-actions.rerun-failed",
    executorId: "github-actions",
    operation: "rerun-failed",
    mode: "write",
    effect: "write",
    risk: "medium",
    scope: ["selected GitHub repository", "one Actions run"],
    inputSchema: GITHUB_RUN_INPUT,
    approval: "every-action",
    idempotency: "required",
    writeReplay: "single-use-checkpoint",
    evidence: ["provider acceptance status", "Actions run URL", "action audit"],
    runtimeCompatibility: MANAGED_RUNTIMES,
    entitlement: "pro",
    executorLabel: "GitHub Actions",
    approvalOwner: "Human approval before dispatch, rerun, or cancel",
  },
  {
    id: "github-actions.cancel",
    executorId: "github-actions",
    operation: "cancel",
    mode: "write",
    effect: "write",
    risk: "high",
    scope: ["selected GitHub repository", "one Actions run"],
    inputSchema: GITHUB_RUN_INPUT,
    approval: "every-action",
    idempotency: "required",
    writeReplay: "single-use-checkpoint",
    evidence: ["provider acceptance status", "Actions run URL", "action audit"],
    runtimeCompatibility: MANAGED_RUNTIMES,
    entitlement: "pro",
    executorLabel: "GitHub Actions",
    approvalOwner: "Human approval before dispatch, rerun, or cancel",
  },
  {
    id: "browser.public-read",
    executorId: "browser",
    operation: "public-read",
    mode: "browser",
    effect: "read",
    risk: "low",
    scope: ["approved public HTTPS domains"],
    inputSchema: {
      type: "object",
      required: ["startUrl", "approvedDomains"],
      properties: {
        startUrl: { type: "string", bound: "HTTPS URL inside approved domains" },
        approvedDomains: { type: "array", bound: "one to ten public domains" },
        actions: { type: "array", bound: "up to twenty typed read actions" },
      },
    },
    approval: "none",
    idempotency: "read-only",
    writeReplay: "not-applicable",
    evidence: ["DOM capture", "screenshot", "browser audit"],
    runtimeCompatibility: MANAGED_RUNTIMES,
    entitlement: "pro",
    executorLabel: "Managed browser",
  },
  {
    id: "browser.signed-in-read",
    executorId: "browser",
    operation: "signed-in-read",
    mode: "browser",
    effect: "read",
    risk: "medium",
    scope: ["approved domains", "one user-owned saved browser session"],
    inputSchema: {
      type: "object",
      required: ["startUrl", "approvedDomains", "persistSession"],
      properties: {
        startUrl: { type: "string", bound: "HTTPS URL inside approved domains" },
        approvedDomains: { type: "array", bound: "one to ten public domains" },
        persistSession: { type: "boolean", bound: "must be true" },
        actions: { type: "array", bound: "up to twenty typed read actions" },
      },
    },
    approval: "once",
    idempotency: "read-only",
    writeReplay: "not-applicable",
    evidence: ["DOM capture", "screenshot", "browser audit"],
    runtimeCompatibility: MANAGED_RUNTIMES,
    entitlement: "pro",
    executorLabel: "Managed browser",
    approvalOwner: "User approves the saved website session and domain scope",
  },
  {
    id: "browser.approved-actions",
    executorId: "browser",
    operation: "approved-actions",
    mode: "browser",
    effect: "write",
    risk: "high",
    scope: ["approved domains", "one user-owned saved browser session", "typed non-sensitive actions"],
    inputSchema: {
      type: "object",
      required: ["startUrl", "approvedDomains", "persistSession"],
      properties: {
        startUrl: { type: "string", bound: "HTTPS URL inside approved domains" },
        approvedDomains: { type: "array", bound: "one to ten public domains" },
        persistSession: { type: "boolean", bound: "must be true" },
        goal: { type: "string", bound: "one bounded operator goal, mutually exclusive with actions" },
        actions: { type: "array", bound: "one to twenty typed non-sensitive actions" },
      },
    },
    approval: "every-action",
    idempotency: "required",
    writeReplay: "single-use-checkpoint",
    evidence: ["post-action DOM capture", "post-action screenshot", "browser audit"],
    runtimeCompatibility: MANAGED_RUNTIMES,
    entitlement: "pro",
    executorLabel: "Managed browser",
    approvalOwner: "Human approval before every browser action step",
  },
] as const satisfies readonly AgentActionDefinition[];

const ACTION_BY_ID = new Map<string, AgentActionDefinition>(WORKFLOW_ACTION_DEFINITIONS.map((definition) => [definition.id, definition]));
const RISK_RANK: Record<AgentRiskLevel, number> = { low: 0, medium: 1, high: 2 };
const PLAN_RANK: Record<AgentPlan, number> = { free: 0, pro: 1, max: 2 };

function higherRisk(left: AgentRiskLevel, right: AgentRiskLevel): AgentRiskLevel {
  return RISK_RANK[right] !== undefined && RISK_RANK[right] > RISK_RANK[left] ? right : left;
}

function actionDefinition(id: string) {
  return ACTION_BY_ID.get(id) || null;
}

function cleanLabel(value: string, max = 240) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function resolvedAction(
  definition: AgentActionDefinition,
  tool: AgentWorkflowTool,
  connectorId: WorkflowConnectorId | null,
  scope: string[],
  scopeLabel: string,
  preview: string[],
): ResolvedAgentAction {
  return {
    ...definition,
    toolId: tool.id,
    toolName: tool.name,
    connectorId,
    risk: higherRisk(definition.risk, tool.riskLevel),
    scope,
    scopeLabel,
    accessLabel: definition.effect === "write" ? "Can act" : "Read",
    preview: preview.map((item) => cleanLabel(item, 500)).filter(Boolean).slice(0, 20),
  };
}

function resolutionError(tool: AgentWorkflowTool, code: WorkflowActionResolutionErrorCode, reason: string): WorkflowActionResolution {
  const executor = executorForTool(tool);
  const executorLabel = executor
    ? ({ "connector-read": "Connected app read", "connector-action": "Connected app action", "custom-action": "Custom integration", "provider-operation": "App capability", "github-actions": "GitHub Actions", "architecture-docs": "Architecture documents", browser: "Managed browser" })[executor.id]
    : tool.executionBoundary === "imported-design" ? "Imported design only" : "No Codelit executor";
  return { ok: false, code, reason, toolId: tool.id, toolName: tool.name, executorId: executor?.id || null, executorLabel };
}

export function resolveWorkflowAction(tool: AgentWorkflowTool, options: { scopeLabel?: string } = {}): WorkflowActionResolution {
  const executor = executorForTool(tool);
  if (!executor) {
    return resolutionError(
      tool,
      tool.executionBoundary === "imported-design" ? "design-only" : "no-executor",
      tool.executionBoundary === "imported-design"
        ? "Imported tools remain design-only until a Codelit executor is selected."
        : "No Codelit executor is mapped to this tool.",
    );
  }

  const connector = connectorForTool(tool);
  const connectorId = executor.connectorId || connector?.id || null;
  const targetLabel = cleanLabel(options.scopeLabel || "", 160);

  if (executor.id === "connector-read") {
    const definition = actionDefinition("connector-read.read");
    if (!definition || !connector) return resolutionError(tool, "unconfigured", "Choose a supported connected app.");
    const scopeLabel = targetLabel || connector.workflowUse;
    return { ok: true, action: resolvedAction(definition, tool, connector.id, [connector.id, "selected-resource"], scopeLabel, [`${connector.label}: read the selected approved scope`]) };
  }

  if (executor.id === "architecture-docs") {
    const definition = actionDefinition("architecture-docs.read");
    if (!definition) return resolutionError(tool, "unsupported-operation", "Architecture document reads are unavailable.");
    const rawPaths = tool.executionConfig?.architecturePaths;
    const sanitizedPaths = sanitizeArchitecturePaths(rawPaths);
    if (rawPaths !== undefined && !sanitizedPaths) return resolutionError(tool, "unconfigured", "Choose up to five safe relative architecture document paths.");
    const paths = sanitizedPaths || [];
    const source = connectorId === "notion" ? "selected Notion page" : "selected GitHub repository";
    const scope = [connectorId || "github", ...(paths.length ? paths : ["architecture-documents"] )];
    return { ok: true, action: resolvedAction(definition, tool, connectorId, scope, targetLabel || `${source}${paths.length ? `: ${paths.join(", ")}` : ""}`, [`Read architecture documents from the ${source}`]) };
  }

  if (executor.id === "connector-action") {
    const config = sanitizeConnectorActionConfig(tool.executionConfig?.connectorAction);
    if (!config) return resolutionError(tool, "unconfigured", "Choose one complete bounded connected-app action.");
    const actionConnector = connectorIdForAction(config.operation);
    if (!actionConnector || connectorId !== actionConnector) return resolutionError(tool, "unsupported-operation", "The action does not match this connected app.");
    const definition = actionDefinition(`connector-action.${config.operation}`);
    if (!definition) return resolutionError(tool, "unsupported-operation", "This connected-app action is not registered.");
    const scopeLabel = targetLabel || `selected ${WORKFLOW_CONNECTORS[actionConnector].label} scope`;
    return {
      ok: true,
      action: resolvedAction(
        definition,
        tool,
        actionConnector,
        [actionConnector, scopeLabel, config.operation],
        scopeLabel,
        connectorActionPreview(config, scopeLabel),
      ),
    };
  }

  if (executor.id === "custom-action") {
    const config = sanitizeCustomActionConfig(tool.executionConfig?.customAction);
    if (!config) return resolutionError(tool, "unconfigured", "Choose one saved custom connection and reviewed operation.");
    const definition: AgentActionDefinition = {
      ...CUSTOM_ACTION_RUNTIME_DEFINITION,
      id: `custom-action.${config.kind}.${config.operationId}`,
      operation: config.operationId,
      mode: config.kind === "webhook" ? "notify" : config.effect,
      effect: config.effect,
      risk: config.risk,
      scope: [config.host, config.connectionId, config.operationId],
      approval: config.effect === "read" ? "none" : "every-action",
      idempotency: config.effect === "read" ? "read-only" : "required",
      writeReplay: config.effect === "read" ? "not-applicable" : "single-use-checkpoint",
      approvalOwner: config.effect === "read" ? undefined : "Human approval of the exact remote call before execution",
      executorLabel: config.kind === "mcp" ? "Remote MCP tool" : config.kind === "webhook" ? "Signed webhook" : "Reviewed API operation",
    };
    return {
      ok: true,
      action: resolvedAction(
        definition,
        tool,
        null,
        [config.host, config.connectionId, config.operationId],
        targetLabel || `${config.operationName} on ${config.host}`,
        customActionPreview(config),
      ),
    };
  }

  if (executor.id === "provider-operation") {
    const config = sanitizeProviderOperationConfig(tool.executionConfig?.providerOperation);
    if (!config) return resolutionError(tool, "unconfigured", "Choose one saved provider account and operation.");
    const definition: AgentActionDefinition = {
      ...PROVIDER_OPERATION_RUNTIME_DEFINITION,
      id: `provider-operation.${config.operationId}`,
      operation: config.operationId,
      mode: config.effect,
      effect: config.effect,
      risk: config.risk,
      scope: [config.providerId, config.connectionId, config.operationId],
      approval: config.effect === "write" ? "every-action" : "none",
      idempotency: config.effect === "write" ? "required" : "read-only",
      writeReplay: config.effect === "write" ? "single-use-checkpoint" : "not-applicable",
      approvalOwner: config.effect === "write" ? "Human approval of the exact provider change before execution" : undefined,
      executorLabel: `${config.providerLabel} / ${config.surface}`,
    };
    return {
      ok: true,
      action: resolvedAction(
        definition,
        tool,
        null,
        [config.providerId, config.connectionId, config.operationId],
        targetLabel || `${config.operationLabel} in ${config.connectionLabel}`,
        providerOperationPreview(config),
      ),
    };
  }

  if (executor.id === "github-actions") {
    const rawConfig = tool.executionConfig?.githubActions;
    const config = sanitizeGitHubActionsConfig(rawConfig === undefined ? {} : rawConfig);
    if (!config) return resolutionError(tool, "unconfigured", "Choose a valid bounded GitHub Actions operation.");
    const definition = actionDefinition(`github-actions.${config.operation}`);
    if (!definition) return resolutionError(tool, "unsupported-operation", "This GitHub Actions operation is not registered.");
    const repo = targetLabel || "selected repository";
    const scope: string[] = [
      "github",
      repo,
      config.operation,
      ...(config.operation === "dispatch"
        ? [config.workflowId || "", config.ref || ""]
        : config.operation === "inspect"
          ? []
          : [String(config.runId || "")]),
    ].filter((value): value is string => Boolean(value));
    return { ok: true, action: resolvedAction(definition, tool, "github", scope, repo, [githubActionsPreview(repo, config)]) };
  }

  if (executor.id === "browser") {
    const browser = validateBrowserToolConfig(tool.executionConfig?.browser);
    if (!browser.ok) return resolutionError(tool, "unconfigured", browser.error);
    const operation = browserAccessScope(browser.config);
    const definition = actionDefinition(`browser.${operation}`);
    if (!definition) return resolutionError(tool, "unsupported-operation", "This browser access scope is not registered.");
    const domainLabel = browser.config.approvedDomains.join(", ");
    const preview = browser.config.goal
      ? [`Browser Operator: ${browser.config.goal} on ${domainLabel}`]
      : operation === "approved-actions"
        ? browserWritePreview(browser.config)
        : [`${operation === "signed-in-read" ? "Read the saved signed-in session" : "Read public pages"} on ${domainLabel}`];
    const scopeLabel = targetLabel || `${operation === "approved-actions" ? "Approved actions" : operation === "signed-in-read" ? "Signed-in read" : "Public read"} on ${domainLabel}`;
    return { ok: true, action: resolvedAction(definition, tool, null, browser.config.approvedDomains, scopeLabel, preview) };
  }

  return resolutionError(tool, "unsupported-operation", `Executor ${executor.id} has no registered action.`);
}

export function agentActionForTool(tool: AgentWorkflowTool, options: { scopeLabel?: string } = {}): ResolvedAgentAction | null {
  const resolution = resolveWorkflowAction(tool, options);
  return resolution.ok ? resolution.action : null;
}

export function liveToolExecutionKey(tool: AgentWorkflowTool) {
  const action = agentActionForTool(tool);
  return `${tool.id}:${action?.id || tool.executorId || "design-only"}:${JSON.stringify(tool.executionConfig || {})}`;
}

export function liveWriteExecutionKey(tool: AgentWorkflowTool): string | null {
  return agentActionForTool(tool)?.effect === "write" ? liveToolExecutionKey(tool) : null;
}

export interface AgentActionRuntimeResolution {
  compatible: boolean;
  execution?: AgentActionRuntimeExecution;
  reason?: string;
}

export function resolveAgentActionRuntime(action: ResolvedAgentAction, mode: AgentRunMode, plan: AgentPlan): AgentActionRuntimeResolution {
  const policy = action.runtimeCompatibility.find((candidate) => candidate.mode === mode);
  if (!policy) {
    const reason = mode === "in-tab-byok" && action.effect === "write"
      ? "Run with my keys is read-only; connected-app writes require managed execution."
      : mode === "device-local"
        ? "Device-local Runs cannot access connected apps or managed browser actions."
        : `The ${mode} runtime cannot execute ${action.toolName}.`;
    return { compatible: false, reason };
  }
  if (PLAN_RANK[plan] < PLAN_RANK[policy.minimumPlan]) {
    return { compatible: false, reason: `${action.executorLabel} requires ${policy.minimumPlan === "pro" ? "Pro or Team" : policy.minimumPlan}.` };
  }
  return { compatible: true, execution: policy.execution };
}

export interface WorkflowActionRequirements {
  actionIds: string[];
  requiredConnectorIds: WorkflowConnectorId[];
  requiresConnectorWrite: boolean;
  requiresManagedBrowser: boolean;
  hasIncompatibleTools: boolean;
  incompatibleToolNames: string[];
}

export function workflowActionRequirements(tools: AgentWorkflowTool[]): WorkflowActionRequirements {
  const actions: ResolvedAgentAction[] = [];
  const incompatibleToolNames: string[] = [];
  for (const tool of tools) {
    const resolution = resolveWorkflowAction(tool);
    if (resolution.ok) actions.push(resolution.action);
    else incompatibleToolNames.push(tool.name);
  }
  return {
    actionIds: Array.from(new Set(actions.map((action) => action.id))),
    requiredConnectorIds: Array.from(new Set(actions.map((action) => action.connectorId).filter((id): id is WorkflowConnectorId => Boolean(id)))),
    requiresConnectorWrite: actions.some((action) => action.effect === "write" && action.executorId !== "browser"),
    requiresManagedBrowser: actions.some((action) => action.executorId === "browser"),
    hasIncompatibleTools: incompatibleToolNames.length > 0,
    incompatibleToolNames,
  };
}

export type AgentActionEvidenceType = "provider-url" | "audit" | "dom" | "screenshot" | "receipt";

export interface AgentActionEvidenceReference {
  id: string;
  type: AgentActionEvidenceType;
  label?: string;
  url?: string;
}

export type AgentActionErrorCode =
  | "configuration-invalid"
  | "authentication-required"
  | "authorization-denied"
  | "scope-blocked"
  | "approval-required"
  | "conflict"
  | "capacity-unavailable"
  | "rate-limited"
  | "provider-timeout"
  | "provider-account-unavailable"
  | "provider-failed"
  | "validation-failed"
  | "evidence-missing"
  | "cancelled";

export interface NormalizedAgentActionError {
  code: AgentActionErrorCode;
  message: string;
  retryable: boolean;
  providerStatus?: number;
}

export class AgentActionExecutionError extends Error {
  code: AgentActionErrorCode;
  retryable: boolean;
  providerStatus?: number;

  constructor(code: AgentActionErrorCode, message: string, options: { retryable?: boolean; providerStatus?: number } = {}) {
    super(message);
    this.name = "AgentActionExecutionError";
    this.code = code;
    this.retryable = options.retryable ?? ["capacity-unavailable", "rate-limited", "provider-timeout", "provider-failed"].includes(code);
    this.providerStatus = options.providerStatus;
  }
}

const ACTION_ERROR_CODES = new Set<AgentActionErrorCode>([
  "configuration-invalid", "authentication-required", "authorization-denied", "scope-blocked", "approval-required", "conflict", "capacity-unavailable", "rate-limited", "provider-timeout", "provider-account-unavailable", "provider-failed", "validation-failed", "evidence-missing", "cancelled",
]);

function statusErrorCode(status: number): AgentActionErrorCode {
  if (status === 401) return "authentication-required";
  if (status === 403) return "authorization-denied";
  if (status === 409) return "conflict";
  if (status === 408 || status === 504) return "provider-timeout";
  if (status === 429) return "rate-limited";
  if (status >= 400 && status < 500) return "validation-failed";
  return "provider-failed";
}

export function normalizeAgentActionError(error: unknown, fallbackMessage = "Action execution failed"): NormalizedAgentActionError {
  const fallback = cleanLabel(fallbackMessage, 240) || "Action execution failed";
  if (error instanceof AgentActionExecutionError) {
    return {
      code: error.code,
      message: cleanLabel(error.message, 240) || fallback,
      retryable: error.retryable,
      ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}),
    };
  }
  if (error instanceof Error && error.name === "AbortError") return { code: "provider-timeout", message: fallback, retryable: true };
  const raw = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusCandidate = typeof raw.providerStatus === "number" ? raw.providerStatus : raw.status;
  const status = typeof statusCandidate === "number" && Number.isInteger(statusCandidate) ? statusCandidate : undefined;
  const suppliedCode = typeof raw.code === "string" && ACTION_ERROR_CODES.has(raw.code as AgentActionErrorCode) ? raw.code as AgentActionErrorCode : undefined;
  const code = suppliedCode || (status ? statusErrorCode(status) : "provider-failed");
  return {
    code,
    message: fallback,
    retryable: typeof raw.retryable === "boolean" ? raw.retryable : ["capacity-unavailable", "rate-limited", "provider-timeout", "provider-failed"].includes(code),
    ...(status ? { providerStatus: status } : {}),
  };
}

export function agentActionWriteOutcomeUncertain(code: AgentActionErrorCode) {
  return ![
    "configuration-invalid",
    "authentication-required",
    "authorization-denied",
    "scope-blocked",
    "approval-required",
    "conflict",
    "capacity-unavailable",
    "rate-limited",
    "provider-account-unavailable",
    "cancelled",
  ].includes(code);
}

export interface AgentActionCompletedResult {
  ok: true;
  status: "completed";
  actionId: string;
  executorId: WorkflowExecutorId;
  operation: string;
  effect: AgentActionEffect;
  toolId: string;
  executionKey: string;
  context: string[];
  evidence: AgentActionEvidenceReference[];
  attempts: number;
  completedAt: string;
}

export interface AgentActionFailedResult {
  ok: false;
  status: "failed" | "blocked" | "approval-required";
  actionId: string;
  executorId: WorkflowExecutorId;
  operation: string;
  effect: AgentActionEffect;
  toolId: string;
  executionKey: string;
  context: [];
  evidence: AgentActionEvidenceReference[];
  attempts: number;
  completedAt: string;
  error: NormalizedAgentActionError;
}

export type AgentActionResult = AgentActionCompletedResult | AgentActionFailedResult;

function safeEvidenceUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.includes(":")) return undefined;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function boundedEvidence(value: AgentActionEvidenceReference): AgentActionEvidenceReference | null {
  const id = cleanLabel(value.id, 160);
  if (!id) return null;
  const url = safeEvidenceUrl(value.url);
  return {
    id,
    type: value.type,
    ...(value.label ? { label: cleanLabel(value.label, 160) } : {}),
    ...(url ? { url } : {}),
  };
}

export function completeAgentActionResult(
  action: ResolvedAgentAction,
  input: { executionKey: string; context?: string[]; evidence?: AgentActionEvidenceReference[]; attempts?: number; completedAt?: string },
): AgentActionCompletedResult {
  return {
    ok: true,
    status: "completed",
    actionId: action.id,
    executorId: action.executorId,
    operation: action.operation,
    effect: action.effect,
    toolId: action.toolId,
    executionKey: cleanLabel(input.executionKey, 500),
    context: (input.context || []).map((item) => item.slice(0, 8_000)).filter(Boolean).slice(0, 20),
    evidence: (input.evidence || []).map(boundedEvidence).filter((item): item is AgentActionEvidenceReference => Boolean(item)).slice(0, 20),
    attempts: Math.max(1, Math.min(4, Math.floor(input.attempts || 1))),
    completedAt: input.completedAt || new Date().toISOString(),
  };
}

export function failAgentActionResult(
  action: ResolvedAgentAction,
  input: { executionKey: string; error: unknown; message?: string; status?: AgentActionFailedResult["status"]; evidence?: AgentActionEvidenceReference[]; attempts?: number; completedAt?: string },
): AgentActionFailedResult {
  return {
    ok: false,
    status: input.status || "failed",
    actionId: action.id,
    executorId: action.executorId,
    operation: action.operation,
    effect: action.effect,
    toolId: action.toolId,
    executionKey: cleanLabel(input.executionKey, 500),
    context: [],
    evidence: (input.evidence || []).map(boundedEvidence).filter((item): item is AgentActionEvidenceReference => Boolean(item)).slice(0, 20),
    attempts: Math.max(1, Math.min(4, Math.floor(input.attempts || 1))),
    completedAt: input.completedAt || new Date().toISOString(),
    error: normalizeAgentActionError(input.error, input.message),
  };
}
