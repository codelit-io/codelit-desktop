import type { AgentWorkflowTool, ToolExecutionConfig, WorkflowExecutorId } from "../stores/agent-workflow-store";
import { connectorForTool, type WorkflowConnectorId } from "./workflow-connectors";
import { validateBrowserToolConfig } from "./browser-policy";
import { connectorIdForAction, sanitizeConnectorActionConfig } from "./connector-actions";
import { sanitizeCustomActionConfig, sanitizeImportedOpenApiReview } from "./custom-integrations";
import { sanitizeProviderOperationConfig } from "./provider-packs";
import { renderAgentHandoffTemplate } from "./agent-run-input";
import { isSafeRepositoryRelativeTextPath } from "./repository-path-policy";

export const WORKFLOW_EXECUTOR_IDS = [
  "connector-read",
  "connector-action",
  "custom-action",
  "provider-operation",
  "github-actions",
  "architecture-docs",
  "browser",
] as const satisfies readonly WorkflowExecutorId[];

export interface ResolvedWorkflowExecutor {
  id: WorkflowExecutorId;
  connectorId: WorkflowConnectorId | null;
  supportedModes: readonly ("read" | "write")[];
}

const EXECUTOR_ID_SET = new Set<string>(WORKFLOW_EXECUTOR_IDS);
const HANDOFF_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/;
const EXACT_HANDOFF_TOKEN = /^\{\{handoff\.[A-Za-z][A-Za-z0-9_.-]{0,159}\}\}$/;
const CONNECTOR_SCOPE_ID = /^[A-Za-z0-9_./:@-]{1,200}$/;

const LEGACY_EXECUTORS = new Map<string, { id: WorkflowExecutorId; connectorId: WorkflowConnectorId | null }>([
  ["ci provider", { id: "github-actions", connectorId: "github" }],
  ["ci runner", { id: "github-actions", connectorId: "github" }],
  ["architecture docs", { id: "architecture-docs", connectorId: "github" }],
  ["browser worker", { id: "browser", connectorId: null }],
  ["browser search", { id: "browser", connectorId: null }],
  ["web research", { id: "browser", connectorId: null }],
]);

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isWorkflowExecutorId(value: unknown): value is WorkflowExecutorId {
  return typeof value === "string" && EXECUTOR_ID_SET.has(value);
}

export function isSafeArchitecturePath(value: unknown): value is string {
  return isSafeRepositoryRelativeTextPath(value);
}

export function sanitizeArchitecturePaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = Array.from(new Set(value.filter(isSafeArchitecturePath))).slice(0, 5);
  return paths.length ? paths : undefined;
}

export function sanitizeToolExecutionConfig(value: unknown): ToolExecutionConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const architecturePaths = sanitizeArchitecturePaths(raw.architecturePaths);
  const architecturePathsHandoffField = typeof raw.architecturePathsHandoffField === "string" && HANDOFF_FIELD.test(raw.architecturePathsHandoffField.trim())
    ? raw.architecturePathsHandoffField.trim()
    : undefined;
  const browser = validateBrowserToolConfig(raw.browser);
  const githubActions = sanitizeGitHubActionsConfig(raw.githubActions);
  const connectorAction = sanitizeConnectorActionConfig(raw.connectorAction);
  const customAction = sanitizeCustomActionConfig(raw.customAction);
  const providerOperation = sanitizeProviderOperationConfig(raw.providerOperation);
  const importedOpenApi = sanitizeImportedOpenApiReview(raw.importedOpenApi);
  const rawConnectorScope = raw.connectorScope;
  const connectorScope = rawConnectorScope && typeof rawConnectorScope === "object" && !Array.isArray(rawConnectorScope)
    ? (() => {
      const candidate = rawConnectorScope as Record<string, unknown>;
      const scopeId = typeof candidate.scopeId === "string" ? candidate.scopeId.trim() : "";
      const scopeLabel = typeof candidate.scopeLabel === "string"
        ? candidate.scopeLabel.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)
        : "";
      return CONNECTOR_SCOPE_ID.test(scopeId) && !scopeId.includes("://") && scopeLabel
        ? { scopeId, scopeLabel }
        : undefined;
    })()
    : undefined;
  const rawGitHubIssueContext = raw.githubIssueContext;
  const githubIssueContext = rawGitHubIssueContext && typeof rawGitHubIssueContext === "object" && !Array.isArray(rawGitHubIssueContext)
    ? (() => {
      const candidate = rawGitHubIssueContext as Record<string, unknown>;
      const issueNumberHandoffField = typeof candidate.issueNumberHandoffField === "string"
        ? candidate.issueNumberHandoffField.trim()
        : "";
      return HANDOFF_FIELD.test(issueNumberHandoffField)
        ? {
          issueNumberHandoffField,
          ...(candidate.includeRepositoryPaths === true ? { includeRepositoryPaths: true } : {}),
        }
        : undefined;
    })()
    : undefined;
  if (rawGitHubIssueContext !== undefined && !githubIssueContext) return undefined;
  if (rawConnectorScope !== undefined && !connectorScope) return undefined;
  const config: ToolExecutionConfig = {
    ...(connectorScope ? { connectorScope } : {}),
    ...(architecturePaths ? { architecturePaths } : {}),
    ...(architecturePathsHandoffField ? { architecturePathsHandoffField } : {}),
    ...(browser.ok ? { browser: browser.config } : {}),
    ...(githubActions ? { githubActions } : {}),
    ...(connectorAction ? { connectorAction } : {}),
    ...(customAction ? { customAction } : {}),
    ...(providerOperation ? { providerOperation } : {}),
    ...(importedOpenApi ? { importedOpenApi } : {}),
    ...(githubIssueContext ? { githubIssueContext } : {}),
  };
  return Object.keys(config).length ? config : undefined;
}

export function sanitizeGitHubActionsConfig(value: unknown): NonNullable<ToolExecutionConfig["githubActions"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const operation = raw.operation === undefined ? "inspect" : raw.operation;
  const safeRef = (candidate: unknown) => {
    const ref = typeof candidate === "string" ? candidate.trim().slice(0, 160) : "";
    if (EXACT_HANDOFF_TOKEN.test(ref)) return ref;
    return ref && !ref.startsWith("/") && !ref.endsWith("/") && !ref.includes("..") && !ref.includes("//") && /^[A-Za-z0-9_./-]+$/.test(ref) ? ref : "";
  };
  if (operation === "inspect") {
    const ref = raw.ref === undefined ? "" : safeRef(raw.ref);
    return raw.ref === undefined || ref ? { operation, ...(ref ? { ref } : {}) } : undefined;
  }
  if (operation === "dispatch") {
    const workflowId = typeof raw.workflowId === "string" ? raw.workflowId.trim().slice(0, 160) : "";
    const ref = safeRef(raw.ref);
    if (!/^[A-Za-z0-9_.-]+$/.test(workflowId) || !ref) return undefined;
    return { operation, workflowId, ref };
  }
  if (operation === "rerun-failed" || operation === "cancel") {
    const runId = typeof raw.runId === "number" && Number.isSafeInteger(raw.runId) && raw.runId > 0 ? raw.runId : 0;
    return runId ? { operation, runId } : undefined;
  }
  return undefined;
}

export function renderGitHubActionsConfig(
  config: NonNullable<ToolExecutionConfig["githubActions"]>,
  handoff: string,
) {
  const reviewed = sanitizeGitHubActionsConfig(config);
  if (!reviewed) return undefined;
  const rendered = reviewed.ref
    ? { ...reviewed, ref: renderAgentHandoffTemplate(reviewed.ref, handoff, 160) }
    : reviewed;
  return sanitizeGitHubActionsConfig(rendered);
}

export function architecturePathsForHandoff(tools: AgentWorkflowTool[], handoff: string) {
  const paths: string[] = [];
  for (const tool of tools) {
    const config = sanitizeToolExecutionConfig(tool.executionConfig);
    paths.push(...(config?.architecturePaths || []));
    if (config?.architecturePathsHandoffField) {
      const rendered = renderAgentHandoffTemplate(`{{handoff.${config.architecturePathsHandoffField}}}`, handoff, 1_500);
      paths.push(...rendered.split(/[\n,]/).map((path) => path.trim()).filter(Boolean));
    }
  }
  return Array.from(new Set(paths.filter(isSafeArchitecturePath))).slice(0, 5);
}

export function githubActionsPreview(repo: string, config: NonNullable<ToolExecutionConfig["githubActions"]>) {
  if (config.operation === "dispatch") return `${repo}: dispatch workflow ${config.workflowId} on ${config.ref}`;
  if (config.operation === "rerun-failed") return `${repo}: rerun failed jobs for Actions run ${config.runId}`;
  if (config.operation === "cancel") return `${repo}: cancel Actions run ${config.runId}`;
  return `${repo}: inspect recent Actions runs${config.ref ? ` on ${config.ref}` : ""}`;
}

export function executorConnectorIdsForTools(tools: AgentWorkflowTool[]): WorkflowConnectorId[] {
  const ids = new Set<WorkflowConnectorId>();
  for (const tool of tools) {
    const connectorId = executorForTool(tool)?.connectorId;
    if (connectorId) ids.add(connectorId);
  }
  return Array.from(ids);
}

export function workflowToolsForNames(toolNames: string[], tools: AgentWorkflowTool[]): AgentWorkflowTool[] {
  const names = new Set(toolNames.map((name) => normalize(name)));
  return tools.filter((tool) => names.has(normalize(tool.name)));
}

export function executorForTool(tool: AgentWorkflowTool): ResolvedWorkflowExecutor | null {
  if (tool.executionBoundary === "imported-design") return null;
  const connector = connectorForTool(tool)?.id ?? null;
  const explicit = isWorkflowExecutorId(tool.executorId) ? tool.executorId : null;

  if (explicit) {
    if (explicit === "browser") return { id: explicit, connectorId: null, supportedModes: ["read", "write"] };
    if (explicit === "custom-action") {
      const config = sanitizeCustomActionConfig(tool.executionConfig?.customAction);
      return config ? { id: explicit, connectorId: null, supportedModes: [config.effect] } : null;
    }
    if (explicit === "provider-operation") {
      const config = sanitizeProviderOperationConfig(tool.executionConfig?.providerOperation);
      return config ? { id: explicit, connectorId: null, supportedModes: [config.effect] } : null;
    }
    if (explicit === "connector-action") {
      const config = sanitizeConnectorActionConfig(tool.executionConfig?.connectorAction);
      const actionConnector = connectorIdForAction(config?.operation);
      if (!config || !actionConnector || (connector && connector !== actionConnector)) return null;
      return { id: explicit, connectorId: actionConnector, supportedModes: ["write"] };
    }
    if (explicit === "github-actions") return { id: explicit, connectorId: connector || "github", supportedModes: ["read", "write"] };
    if (explicit === "architecture-docs") {
      return { id: explicit, connectorId: connector === "notion" ? "notion" : "github", supportedModes: ["read"] };
    }
    return connector ? { id: explicit, connectorId: connector, supportedModes: ["read"] } : null;
  }

  const legacy = LEGACY_EXECUTORS.get(normalize(tool.name));
  if (legacy) {
    return {
      ...legacy,
      supportedModes: legacy.id === "browser" || legacy.id === "github-actions" ? ["read", "write"] : ["read"],
    };
  }

  return connector ? { id: "connector-read", connectorId: connector, supportedModes: ["read"] } : null;
}
