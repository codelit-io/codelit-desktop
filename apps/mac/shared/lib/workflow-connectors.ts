import type { AgentToolType, AgentWorkflowTool } from "../stores/agent-workflow-store";

export const SETTINGS_WORKFLOW_CONNECTOR_IDS = [
  "github",
  "jira",
  "notion",
  "linear",
  "figma",
  "slack",
  "gitlab",
  "bitbucket",
  "vercel",
] as const;

export type WorkflowConnectorId = (typeof SETTINGS_WORKFLOW_CONNECTOR_IDS)[number];
export type WorkflowConnectorCapability = "import" | "read" | "notify" | "deploy" | "export" | "write";

export interface WorkflowConnectorDefinition {
  id: WorkflowConnectorId;
  label: string;
  toolType: AgentToolType;
  capabilities: readonly WorkflowConnectorCapability[];
  workflowUse: string;
  runtimeEnv: readonly { name: string; description: string; optional?: boolean }[];
  legacyToolNames: readonly string[];
  localTokenSlots: readonly string[];
  vaultSlots: readonly string[];
}

export const WORKFLOW_CONNECTORS: Record<WorkflowConnectorId, WorkflowConnectorDefinition> = {
  github: {
    id: "github",
    label: "GitHub",
    toolType: "repo",
    capabilities: ["import", "read", "export", "write"],
    workflowUse: "Read a selected repository and perform approved issue, branch, commit, and pull-request operations.",
    runtimeEnv: [
      { name: "GITHUB_TOKEN", description: "GitHub token with repository read access" },
      { name: "GITHUB_REPOSITORY", description: "Repository scope as owner/repo" },
    ],
    legacyToolNames: ["GitHub", "GitHub repo access", "GitHub repository"],
    localTokenSlots: ["github_token"],
    vaultSlots: ["github_token"],
  },
  jira: {
    id: "jira",
    label: "Jira",
    toolType: "ticketing",
    capabilities: ["import", "read", "write"],
    workflowUse: "Read a selected Jira project and perform approved issue, assignment, comment, and status operations.",
    runtimeEnv: [
      { name: "JIRA_TOKEN", description: "Jira OAuth access token" },
      { name: "JIRA_SITE_ID", description: "Atlassian cloud site id" },
      { name: "JIRA_PROJECT_KEY", description: "Jira project key" },
    ],
    legacyToolNames: ["Jira", "Jira project"],
    localTokenSlots: ["jira_token", "jira_site", "jira_name"],
    vaultSlots: ["jira_token", "jira_site", "jira_name"],
  },
  notion: {
    id: "notion",
    label: "Notion",
    toolType: "knowledge",
    capabilities: ["import", "read", "write"],
    workflowUse: "Read a selected Notion page and perform approved child-page or append operations.",
    runtimeEnv: [
      { name: "NOTION_TOKEN", description: "Notion integration or OAuth token" },
      { name: "NOTION_PAGE_ID", description: "Page id to read" },
    ],
    legacyToolNames: ["Notion", "Notion workspace"],
    localTokenSlots: ["notion_token"],
    vaultSlots: ["notion_token"],
  },
  linear: {
    id: "linear",
    label: "Linear",
    toolType: "ticketing",
    capabilities: ["import", "read", "write"],
    workflowUse: "Read a selected Linear team and perform approved issue, assignment, comment, and state operations.",
    runtimeEnv: [
      { name: "LINEAR_TOKEN", description: "Linear OAuth or API token" },
      { name: "LINEAR_TEAM_ID", description: "Linear team id" },
    ],
    legacyToolNames: ["Linear", "Linear workspace"],
    localTokenSlots: ["linear_token"],
    vaultSlots: ["linear_token"],
  },
  figma: {
    id: "figma",
    label: "Figma",
    toolType: "knowledge",
    capabilities: ["import", "read"],
    workflowUse: "Read screens and detected product patterns from a recently imported Figma file.",
    runtimeEnv: [
      { name: "FIGMA_TOKEN", description: "Figma OAuth or personal access token" },
      { name: "FIGMA_FILE_KEY", description: "Figma file key" },
    ],
    legacyToolNames: ["Figma", "Figma design files"],
    localTokenSlots: ["figma_token", "figma_recent_files"],
    vaultSlots: ["figma_token"],
  },
  slack: {
    id: "slack",
    label: "Slack",
    toolType: "communication",
    capabilities: ["read", "notify"],
    workflowUse: "Read a selected channel and send approval-gated workflow messages with delivery evidence.",
    runtimeEnv: [
      { name: "SLACK_TOKEN", description: "Slack token with channel history scopes" },
      { name: "SLACK_CHANNEL_ID", description: "Slack channel id" },
    ],
    legacyToolNames: ["Slack", "Slack workspace"],
    localTokenSlots: ["slack_token", "slack_team", "slack_team_id"],
    vaultSlots: ["slack_token", "slack_team", "slack_team_id"],
  },
  gitlab: {
    id: "gitlab",
    label: "GitLab",
    toolType: "repo",
    capabilities: ["import", "read"],
    workflowUse: "Read a selected repository tree and its currently open merge requests.",
    runtimeEnv: [
      { name: "GITLAB_TOKEN", description: "GitLab token with read_api and read_repository" },
      { name: "GITLAB_PROJECT_ID", description: "Numeric GitLab project id" },
    ],
    legacyToolNames: ["GitLab", "GitLab project access", "GitLab repository"],
    localTokenSlots: ["gitlab_token"],
    vaultSlots: ["gitlab_token"],
  },
  bitbucket: {
    id: "bitbucket",
    label: "Bitbucket",
    toolType: "repo",
    capabilities: ["import", "read"],
    workflowUse: "Read selected repository metadata and its currently open pull requests.",
    runtimeEnv: [
      { name: "BITBUCKET_TOKEN", description: "Bitbucket OAuth access token" },
      { name: "BITBUCKET_REPOSITORY", description: "Repository scope as workspace/repo" },
    ],
    legacyToolNames: ["Bitbucket", "Bitbucket repository", "Bitbucket repo access"],
    localTokenSlots: ["bitbucket_token"],
    vaultSlots: ["bitbucket_token"],
  },
  vercel: {
    id: "vercel",
    label: "Vercel",
    toolType: "runtime",
    capabilities: ["read", "deploy"],
    workflowUse: "Read recent deployments and perform approved preview, promotion, or rollback operations.",
    runtimeEnv: [
      { name: "VERCEL_TOKEN", description: "Vercel access token" },
      { name: "VERCEL_PROJECT_ID", description: "Vercel project id" },
      { name: "VERCEL_TEAM_ID", description: "Vercel team id", optional: true },
    ],
    legacyToolNames: ["Vercel", "Vercel project", "Vercel deployments"],
    localTokenSlots: [],
    vaultSlots: ["vercel_token", "vercel_team_id"],
  },
};

const CONNECTOR_ID_SET = new Set<string>(SETTINGS_WORKFLOW_CONNECTOR_IDS);

function normalizeToolName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const LEGACY_TOOL_NAME_TO_CONNECTOR = new Map<string, WorkflowConnectorId>(
  SETTINGS_WORKFLOW_CONNECTOR_IDS.flatMap((id) =>
    WORKFLOW_CONNECTORS[id].legacyToolNames.map((name) => [normalizeToolName(name), id] as const),
  ),
);

export function isWorkflowConnectorId(value: unknown): value is WorkflowConnectorId {
  return typeof value === "string" && CONNECTOR_ID_SET.has(value);
}

export function connectorForTool(tool: AgentWorkflowTool): WorkflowConnectorDefinition | null {
  if (isWorkflowConnectorId(tool.connectorId)) return WORKFLOW_CONNECTORS[tool.connectorId];
  const legacyId = LEGACY_TOOL_NAME_TO_CONNECTOR.get(normalizeToolName(tool.name));
  return legacyId ? WORKFLOW_CONNECTORS[legacyId] : null;
}

export function connectorHasCapability(id: WorkflowConnectorId, capability: WorkflowConnectorCapability) {
  return WORKFLOW_CONNECTORS[id].capabilities.includes(capability);
}

export function workflowConnectorOAuthHref(id: WorkflowConnectorId, returnTo: string) {
  const path = `/api/${id}/auth`;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || /[\\\u0000-\u001f]/.test(returnTo)) return path;
  try {
    const target = new URL(returnTo, "https://codelit.local");
    if (target.origin !== "https://codelit.local") return path;
    const safeReturnTo = `${target.pathname}${target.search}`;
    return `${path}?${new URLSearchParams({ return_to: safeReturnTo })}`;
  } catch {
    return path;
  }
}

interface WorkflowConnectorScope {
  scopeId?: string;
  scopeLabel?: string;
}

interface WorkflowConnectorScopeDiscovery {
  selected: string;
  options: { id: string; label: string }[];
}

export function resolveWorkflowConnectorScope(
  savedScope: WorkflowConnectorScope | undefined,
  discovered: WorkflowConnectorScopeDiscovery | null,
) {
  const savedId = savedScope?.scopeId?.trim() || "";
  const savedOption = savedId
    ? discovered?.options.find((option) => option.id === savedId) || null
    : null;
  const discoveredOption = !savedId
    ? discovered?.options.find((option) => option.id === discovered.selected)
      || null
    : null;
  const selectedOption = savedOption || discoveredOption;
  const savedUnavailable = savedId && !savedOption
    ? { id: savedId, label: savedScope?.scopeLabel?.trim() || savedId }
    : null;

  return {
    selected: savedId || selectedOption?.id || "",
    selectedOption,
    savedUnavailable,
  };
}

export function workflowConnectorIdsForTools(tools: AgentWorkflowTool[]): WorkflowConnectorId[] {
  return Array.from(new Set(tools.map((tool) => connectorForTool(tool)?.id).filter(isWorkflowConnectorId)));
}
