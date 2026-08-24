import type { ConnectorActionConfig } from "../stores/agent-workflow-store";
import { integrationFetch, legacyTokenHeaders } from "./integration-session-client";
import type { WorkflowConnectorId } from "./workflow-connectors";

export type ConnectorActionOptionSource =
  | "github-issues"
  | "github-branches"
  | "jira-issues"
  | "jira-issue-types"
  | "jira-assignees"
  | "jira-transitions"
  | "linear-issues"
  | "linear-assignees"
  | "linear-states"
  | "vercel-deployments";

export interface ConnectorActionOption {
  value: string;
  label: string;
}

export type ConnectorActionOptionMap = Partial<Record<ConnectorActionOptionSource, ConnectorActionOption[]>>;

function local(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function option(value: unknown, label: unknown): ConnectorActionOption | null {
  const safeValue = clean(typeof value === "number" ? String(value) : value, 200);
  const safeLabel = clean(label, 180);
  return safeValue && safeLabel ? { value: safeValue, label: safeLabel } : null;
}

function compact(values: Array<ConnectorActionOption | null>) {
  const seen = new Set<string>();
  return values.filter((candidate): candidate is ConnectorActionOption => {
    if (!candidate || seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  }).slice(0, 100);
}

async function json<T>(connectorId: WorkflowConnectorId, url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const response = await integrationFetch(connectorId, url, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

export async function discoverConnectorActionOptions(input: {
  connectorId: WorkflowConnectorId;
  scopeId: string;
  config?: ConnectorActionConfig;
}): Promise<ConnectorActionOptionMap> {
  if (!input.scopeId) return {};
  if (input.connectorId === "github") {
    const headers = legacyTokenHeaders(local("github_token"), "x-github-token");
    const [issueData, branchData] = await Promise.all([
      json<{ issues?: Array<{ number?: number; title?: string }> }>("github", `/api/github/issues?repo=${encodeURIComponent(input.scopeId)}`, headers),
      json<{ branches?: Array<{ name?: string }> }>("github", `/api/github/repos?repo=${encodeURIComponent(input.scopeId)}`, headers),
    ]);
    return {
      "github-issues": compact((issueData?.issues || []).map((issue) => option(issue.number, `#${Number(issue.number) || 0} ${clean(issue.title, 140)}`))),
      "github-branches": compact((branchData?.branches || []).map((branch) => option(branch.name, branch.name))),
    };
  }

  if (input.connectorId === "jira") {
    const siteId = local("jira_site");
    if (!siteId) return {};
    const headers = legacyTokenHeaders(local("jira_token"), "x-jira-token");
    const issueKey = clean(input.config?.issueKey, 40);
    const query = new URLSearchParams({ siteId, project: input.scopeId, includeOptions: "1" });
    if (issueKey) query.set("issueKey", issueKey);
    const data = await json<{
      issues?: Array<{ key?: string; fields?: { summary?: string } }>;
      issueTypes?: Array<{ id?: string; name?: string }>;
      assignees?: Array<{ id?: string; name?: string }>;
      transitions?: Array<{ id?: string; name?: string }>;
    }>("jira", `/api/jira/issues?${query}`, headers);
    return {
      "jira-issues": compact((data?.issues || []).map((issue) => option(issue.key, `${clean(issue.key, 40)} ${clean(issue.fields?.summary, 140)}`))),
      "jira-issue-types": compact((data?.issueTypes || []).map((issueType) => option(issueType.name, issueType.name))),
      "jira-assignees": compact((data?.assignees || []).map((assignee) => option(assignee.id, assignee.name))),
      "jira-transitions": compact((data?.transitions || []).map((transition) => option(transition.id, transition.name))),
    };
  }

  if (input.connectorId === "linear") {
    const headers = legacyTokenHeaders(local("linear_token"), "x-linear-token");
    const data = await json<{
      issues?: Array<{ id?: string; identifier?: string; title?: string }>;
      members?: Array<{ id?: string; name?: string }>;
      states?: Array<{ id?: string; name?: string }>;
    }>("linear", `/api/linear/issues?teamId=${encodeURIComponent(input.scopeId)}&includeOptions=1`, headers);
    return {
      "linear-issues": compact((data?.issues || []).map((issue) => option(issue.id, `${clean(issue.identifier, 40)} ${clean(issue.title, 140)}`))),
      "linear-assignees": compact((data?.members || []).map((member) => option(member.id, member.name))),
      "linear-states": compact((data?.states || []).map((state) => option(state.id, state.name))),
    };
  }

  if (input.connectorId === "vercel") {
    const data = await json<{
      deployments?: Array<{ uid?: string; url?: string; state?: string; target?: string | null }>;
    }>("vercel", `/api/vercel/projects?projectId=${encodeURIComponent(input.scopeId)}`);
    return {
      "vercel-deployments": compact((data?.deployments || []).map((deployment) => option(
        deployment.uid,
        `${clean(deployment.url, 140) || clean(deployment.uid, 80)}${deployment.target ? ` · ${clean(deployment.target, 40)}` : ""}${deployment.state ? ` · ${clean(deployment.state, 40)}` : ""}`,
      ))),
    };
  }

  return {};
}
