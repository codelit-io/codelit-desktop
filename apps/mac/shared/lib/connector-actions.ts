import type {
  ConnectorActionConfig,
  ConnectorActionOperation,
} from "../stores/agent-workflow-store";
import type { AgentRiskLevel } from "../stores/agent-workflow-store";
import { renderAgentHandoffTemplate } from "./agent-run-input";
import type { WorkflowConnectorId } from "./workflow-connectors";
import type { ConnectorActionOptionSource } from "./connector-action-options";

export type WritableConnectorId = "slack" | "vercel" | "github" | "jira" | "linear" | "notion";
export type ConnectorActionFieldType = "text" | "textarea" | "number" | "select" | "files";

export interface ConnectorActionFieldDefinition {
  key: keyof ConnectorActionConfig;
  label: string;
  type: ConnectorActionFieldType;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
  options?: readonly { value: string; label: string }[];
  optionSource?: ConnectorActionOptionSource;
}

export interface ConnectorActionDefinition {
  operation: ConnectorActionOperation;
  connectorId: WritableConnectorId;
  label: string;
  description: string;
  risk: AgentRiskLevel;
  fields: readonly ConnectorActionFieldDefinition[];
}

const HANDOFF_TOKEN = "{{handoff}}";
const EXACT_HANDOFF_TOKEN = /^\{\{handoff\.[A-Za-z][A-Za-z0-9_.-]{0,159}\}\}$/;
const MAX_BODY_CHARS = 8_000;
const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_FILE_CHARS = 32_000;

export const CONNECTOR_ACTION_DEFINITIONS = [
  { operation: "slack.send-message", connectorId: "slack", label: "Send message", description: "Post an approved result to the selected channel.", risk: "medium", fields: [{ key: "messageTemplate", label: "Message", type: "textarea", placeholder: HANDOFF_TOKEN, hint: "Use {{handoff}} for the previous Agent's output." }] },
  { operation: "vercel.create-preview", connectorId: "vercel", label: "Create preview", description: "Create a preview from an optional reviewed Git branch, or rebuild the latest source.", risk: "medium", fields: [{ key: "gitRef", label: "Git branch", type: "text", placeholder: "main", hint: "Optional. The selected Vercel project must be linked to GitHub.", optional: true }] },
  { operation: "vercel.promote", connectorId: "vercel", label: "Promote deployment", description: "Point production traffic at one verified deployment.", risk: "high", fields: [{ key: "deploymentId", label: "Deployment", type: "text", optionSource: "vercel-deployments" }] },
  { operation: "vercel.rollback", connectorId: "vercel", label: "Roll back", description: "Restore one previously production deployment for this project.", risk: "high", fields: [{ key: "deploymentId", label: "Deployment", type: "text", optionSource: "vercel-deployments" }, { key: "rollbackReason", label: "Reason", type: "text", placeholder: "Restore last known good release", optional: true }] },
  { operation: "github.issue-comment", connectorId: "github", label: "Comment on issue", description: "Add an approved comment to one issue in the selected repository.", risk: "medium", fields: [{ key: "issueNumber", label: "Issue", type: "number", optionSource: "github-issues" }, { key: "bodyTemplate", label: "Comment", type: "textarea", placeholder: HANDOFF_TOKEN }] },
  { operation: "github.create-branch", connectorId: "github", label: "Create branch", description: "Create one branch from a reviewed Git ref.", risk: "medium", fields: [{ key: "branch", label: "New branch", type: "text", placeholder: "codex/fix" }, { key: "fromRef", label: "Start from", type: "text", optionSource: "github-branches" }] },
  { operation: "github.commit-files", connectorId: "github", label: "Commit files", description: "Create one atomic commit containing up to five bounded files.", risk: "high", fields: [{ key: "branch", label: "Branch", type: "text", optionSource: "github-branches" }, { key: "commitMessageTemplate", label: "Commit message", type: "text", placeholder: "fix: apply reviewed change" }, { key: "files", label: "Files", type: "files", hint: "Each file has a safe relative path and bounded content; {{handoff}} is supported." }] },
  { operation: "github.open-pr", connectorId: "github", label: "Open pull request", description: "Open a pull request between two reviewed branches.", risk: "medium", fields: [{ key: "head", label: "Head branch", type: "text", optionSource: "github-branches" }, { key: "base", label: "Base branch", type: "text", optionSource: "github-branches" }, { key: "titleTemplate", label: "Title", type: "text", placeholder: "Reviewed agent change" }, { key: "bodyTemplate", label: "Description", type: "textarea", placeholder: HANDOFF_TOKEN, optional: true }] },
  { operation: "jira.create-issue", connectorId: "jira", label: "Create issue", description: "Create one issue in the selected Jira project.", risk: "medium", fields: [{ key: "titleTemplate", label: "Summary", type: "text", placeholder: "{{handoff}}" }, { key: "bodyTemplate", label: "Description", type: "textarea", placeholder: HANDOFF_TOKEN }, { key: "issueType", label: "Issue type", type: "select", optionSource: "jira-issue-types" }] },
  { operation: "jira.assign-issue", connectorId: "jira", label: "Assign issue", description: "Assign one issue inside the selected project.", risk: "medium", fields: [{ key: "issueKey", label: "Issue", type: "text", optionSource: "jira-issues" }, { key: "assigneeId", label: "Assignee", type: "text", optionSource: "jira-assignees" }] },
  { operation: "jira.comment", connectorId: "jira", label: "Comment on issue", description: "Add an approved comment to one issue in the selected project.", risk: "medium", fields: [{ key: "issueKey", label: "Issue", type: "text", optionSource: "jira-issues" }, { key: "bodyTemplate", label: "Comment", type: "textarea", placeholder: HANDOFF_TOKEN }] },
  { operation: "jira.transition", connectorId: "jira", label: "Change status", description: "Apply one explicit Jira transition to an issue in scope.", risk: "high", fields: [{ key: "issueKey", label: "Issue", type: "text", optionSource: "jira-issues" }, { key: "transitionId", label: "New status", type: "text", optionSource: "jira-transitions" }] },
  { operation: "linear.create-issue", connectorId: "linear", label: "Create issue", description: "Create one issue in the selected Linear team.", risk: "medium", fields: [{ key: "titleTemplate", label: "Title", type: "text", placeholder: "{{handoff}}" }, { key: "bodyTemplate", label: "Description", type: "textarea", placeholder: HANDOFF_TOKEN, optional: true }] },
  { operation: "linear.assign-issue", connectorId: "linear", label: "Assign issue", description: "Assign one verified issue in the selected team.", risk: "medium", fields: [{ key: "issueId", label: "Issue", type: "text", optionSource: "linear-issues" }, { key: "assigneeId", label: "Assignee", type: "text", optionSource: "linear-assignees" }] },
  { operation: "linear.comment", connectorId: "linear", label: "Comment on issue", description: "Add an approved comment to one verified team issue.", risk: "medium", fields: [{ key: "issueId", label: "Issue", type: "text", optionSource: "linear-issues" }, { key: "bodyTemplate", label: "Comment", type: "textarea", placeholder: HANDOFF_TOKEN }] },
  { operation: "linear.change-state", connectorId: "linear", label: "Change status", description: "Move one verified team issue to an explicit workflow state.", risk: "high", fields: [{ key: "issueId", label: "Issue", type: "text", optionSource: "linear-issues" }, { key: "stateId", label: "New status", type: "text", optionSource: "linear-states" }] },
  { operation: "notion.create-page", connectorId: "notion", label: "Create child page", description: "Create one bounded child page under the selected page.", risk: "medium", fields: [{ key: "titleTemplate", label: "Page title", type: "text", placeholder: "Agent result" }, { key: "bodyTemplate", label: "Page content", type: "textarea", placeholder: HANDOFF_TOKEN }] },
  { operation: "notion.append-page", connectorId: "notion", label: "Append to page", description: "Append bounded paragraphs to the selected page.", risk: "medium", fields: [{ key: "bodyTemplate", label: "Content", type: "textarea", placeholder: HANDOFF_TOKEN }] },
] as const satisfies readonly ConnectorActionDefinition[];

export type SanitizedConnectorActionConfig =
  | { operation: "slack.send-message"; messageTemplate: string }
  | { operation: "vercel.create-preview"; gitRef?: string }
  | { operation: "vercel.promote"; deploymentId: string }
  | { operation: "vercel.rollback"; deploymentId: string; rollbackReason?: string }
  | { operation: "github.issue-comment"; issueNumber: number | string; bodyTemplate: string }
  | { operation: "github.create-branch"; branch: string; fromRef: string }
  | { operation: "github.commit-files"; branch: string; commitMessageTemplate: string; files: Array<{ path: string; contentTemplate: string }> }
  | { operation: "github.open-pr"; head: string; base: string; titleTemplate: string; bodyTemplate?: string }
  | { operation: "jira.create-issue"; titleTemplate: string; bodyTemplate: string; issueType: string }
  | { operation: "jira.assign-issue"; issueKey: string; assigneeId: string }
  | { operation: "jira.comment"; issueKey: string; bodyTemplate: string }
  | { operation: "jira.transition"; issueKey: string; transitionId: string }
  | { operation: "linear.create-issue"; titleTemplate: string; bodyTemplate?: string }
  | { operation: "linear.assign-issue"; issueId: string; assigneeId: string }
  | { operation: "linear.comment"; issueId: string; bodyTemplate: string }
  | { operation: "linear.change-state"; issueId: string; stateId: string }
  | { operation: "notion.create-page"; titleTemplate: string; bodyTemplate: string }
  | { operation: "notion.append-page"; bodyTemplate: string };

const DEFINITION_BY_OPERATION = new Map<ConnectorActionOperation, ConnectorActionDefinition>(
  CONNECTOR_ACTION_DEFINITIONS.map((definition) => [definition.operation, definition]),
);

function string(value: unknown, max: number, options: { multiline?: boolean; optional?: boolean } = {}) {
  if (typeof value !== "string") return options.optional ? undefined : "";
  const controlPattern = options.multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  const cleaned = value.replace(controlPattern, options.multiline ? " " : " ").trim().slice(0, max);
  return cleaned || (options.optional ? undefined : "");
}

function template(value: unknown, max: number, optional = false) {
  return string(value, max, { multiline: true, optional });
}

function id(value: unknown, max = 200) {
  const candidate = string(value, max);
  return candidate && /^[A-Za-z0-9_.:@-]+$/.test(candidate) ? candidate : "";
}

function gitRef(value: unknown) {
  const candidate = string(value, 160) || "";
  if (EXACT_HANDOFF_TOKEN.test(candidate)) return candidate;
  if (!candidate || candidate.startsWith("/") || candidate.endsWith("/") || candidate.includes("..") || candidate.includes("//")) return "";
  return /^[A-Za-z0-9_./-]+$/.test(candidate) ? candidate : "";
}

function safeRepoPath(value: unknown) {
  const candidate = string(value, 240);
  if (candidate && EXACT_HANDOFF_TOKEN.test(candidate)) return candidate;
  if (!candidate || candidate.startsWith("/") || candidate.endsWith("/") || candidate.includes("\\") || candidate.includes("\0")) return "";
  const segments = candidate.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".env"))) return "";
  return segments.every((segment) => /^[A-Za-z0-9_. -]+$/.test(segment)) ? candidate : "";
}

function issueKey(value: unknown) {
  const candidate = (string(value, 40) || "").toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/.test(candidate) ? candidate : "";
}

function deploymentId(value: unknown) {
  const candidate = string(value, 80) || "";
  return /^dpl_[A-Za-z0-9]+$/.test(candidate) || EXACT_HANDOFF_TOKEN.test(candidate) ? candidate : "";
}

function rawObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function connectorActionDefinition(operation: ConnectorActionOperation | undefined | null) {
  return operation ? DEFINITION_BY_OPERATION.get(operation) || null : null;
}

export function connectorActionOperations(connectorId: WorkflowConnectorId) {
  return CONNECTOR_ACTION_DEFINITIONS.filter((definition) => definition.connectorId === connectorId);
}

export function connectorIdForAction(operation: ConnectorActionOperation | undefined | null): WritableConnectorId | null {
  return connectorActionDefinition(operation)?.connectorId || null;
}

export function sanitizeConnectorActionConfig(value: unknown): SanitizedConnectorActionConfig | undefined {
  const raw = rawObject(value);
  if (!raw || typeof raw.operation !== "string" || !DEFINITION_BY_OPERATION.has(raw.operation as ConnectorActionOperation)) return undefined;
  switch (raw.operation as ConnectorActionOperation) {
    case "slack.send-message": {
      const messageTemplate = template(raw.messageTemplate, 4_000);
      return messageTemplate ? { operation: "slack.send-message", messageTemplate } : undefined;
    }
    case "vercel.create-preview": {
      const gitRefValue = raw.gitRef === undefined ? "" : gitRef(raw.gitRef);
      return raw.gitRef === undefined || gitRefValue ? { operation: "vercel.create-preview", ...(gitRefValue ? { gitRef: gitRefValue } : {}) } : undefined;
    }
    case "vercel.promote": {
      const value = deploymentId(raw.deploymentId);
      return value ? { operation: "vercel.promote", deploymentId: value } : undefined;
    }
    case "vercel.rollback": {
      const value = deploymentId(raw.deploymentId);
      const rollbackReason = string(raw.rollbackReason, 240, { optional: true });
      return value ? { operation: "vercel.rollback", deploymentId: value, ...(rollbackReason ? { rollbackReason } : {}) } : undefined;
    }
    case "github.issue-comment": {
      const issueNumber = typeof raw.issueNumber === "number" && Number.isSafeInteger(raw.issueNumber) && raw.issueNumber > 0 && raw.issueNumber <= 1_000_000_000
        ? raw.issueNumber
        : typeof raw.issueNumber === "string" && EXACT_HANDOFF_TOKEN.test(raw.issueNumber.trim()) ? raw.issueNumber.trim() : 0;
      const bodyTemplate = template(raw.bodyTemplate, MAX_BODY_CHARS);
      return issueNumber && bodyTemplate ? { operation: "github.issue-comment", issueNumber, bodyTemplate } : undefined;
    }
    case "github.create-branch": {
      const branch = gitRef(raw.branch);
      const fromRef = gitRef(raw.fromRef);
      return branch && fromRef && branch !== fromRef ? { operation: "github.create-branch", branch, fromRef } : undefined;
    }
    case "github.commit-files": {
      const branch = gitRef(raw.branch);
      const commitMessageTemplate = template(raw.commitMessageTemplate, 240);
      const rawFiles = Array.isArray(raw.files) ? raw.files.slice(0, 5) : [];
      let total = 0;
      const files = rawFiles.flatMap((file) => {
        const item = rawObject(file);
        const path = safeRepoPath(item?.path);
        const contentTemplate = template(item?.contentTemplate, MAX_FILE_CHARS);
        if (!path || !contentTemplate) return [];
        total += contentTemplate.length;
        return [{ path, contentTemplate }];
      });
      if (!branch || !commitMessageTemplate || !files.length || files.length !== rawFiles.length || total > MAX_TOTAL_FILE_CHARS || new Set(files.map((file) => file.path)).size !== files.length) return undefined;
      return { operation: "github.commit-files", branch, commitMessageTemplate, files };
    }
    case "github.open-pr": {
      const head = gitRef(raw.head);
      const base = gitRef(raw.base);
      const titleTemplate = template(raw.titleTemplate, 240);
      const bodyTemplate = template(raw.bodyTemplate, MAX_BODY_CHARS, true);
      return head && base && head !== base && titleTemplate ? { operation: "github.open-pr", head, base, titleTemplate, ...(bodyTemplate ? { bodyTemplate } : {}) } : undefined;
    }
    case "jira.create-issue": {
      const titleTemplate = template(raw.titleTemplate, 240);
      const bodyTemplate = template(raw.bodyTemplate, MAX_BODY_CHARS);
      const issueType = string(raw.issueType, 80);
      return titleTemplate && bodyTemplate && issueType ? { operation: "jira.create-issue", titleTemplate, bodyTemplate, issueType } : undefined;
    }
    case "jira.assign-issue": {
      const key = issueKey(raw.issueKey);
      const assigneeId = id(raw.assigneeId);
      return key && assigneeId ? { operation: "jira.assign-issue", issueKey: key, assigneeId } : undefined;
    }
    case "jira.comment": {
      const key = issueKey(raw.issueKey);
      const bodyTemplate = template(raw.bodyTemplate, MAX_BODY_CHARS);
      return key && bodyTemplate ? { operation: "jira.comment", issueKey: key, bodyTemplate } : undefined;
    }
    case "jira.transition": {
      const key = issueKey(raw.issueKey);
      const transitionId = id(raw.transitionId, 80);
      return key && transitionId ? { operation: "jira.transition", issueKey: key, transitionId } : undefined;
    }
    case "linear.create-issue": {
      const titleTemplate = template(raw.titleTemplate, 240);
      const bodyTemplate = template(raw.bodyTemplate, MAX_BODY_CHARS, true);
      return titleTemplate ? { operation: "linear.create-issue", titleTemplate, ...(bodyTemplate ? { bodyTemplate } : {}) } : undefined;
    }
    case "linear.assign-issue": {
      const issueId = id(raw.issueId);
      const assigneeId = id(raw.assigneeId);
      return issueId && assigneeId ? { operation: "linear.assign-issue", issueId, assigneeId } : undefined;
    }
    case "linear.comment": {
      const issueId = id(raw.issueId);
      const bodyTemplate = template(raw.bodyTemplate, MAX_BODY_CHARS);
      return issueId && bodyTemplate ? { operation: "linear.comment", issueId, bodyTemplate } : undefined;
    }
    case "linear.change-state": {
      const issueId = id(raw.issueId);
      const stateId = id(raw.stateId);
      return issueId && stateId ? { operation: "linear.change-state", issueId, stateId } : undefined;
    }
    case "notion.create-page": {
      const titleTemplate = template(raw.titleTemplate, 240);
      const bodyTemplate = template(raw.bodyTemplate, MAX_BODY_CHARS);
      return titleTemplate && bodyTemplate ? { operation: "notion.create-page", titleTemplate, bodyTemplate } : undefined;
    }
    case "notion.append-page": {
      const bodyTemplate = template(raw.bodyTemplate, MAX_BODY_CHARS);
      return bodyTemplate ? { operation: "notion.append-page", bodyTemplate } : undefined;
    }
  }
}

function render(value: string, handoff: string, max: number) {
  return renderAgentHandoffTemplate(value, handoff || "No prior Agent output was available.", max);
}

export function renderConnectorActionConfig(config: SanitizedConnectorActionConfig, handoff: string): SanitizedConnectorActionConfig | undefined {
  const rendered: SanitizedConnectorActionConfig = (() => {
    switch (config.operation) {
    case "slack.send-message": return { ...config, messageTemplate: render(config.messageTemplate, handoff, 4_000) };
    case "vercel.create-preview": return { ...config, ...(config.gitRef ? { gitRef: render(config.gitRef, handoff, 160) } : {}) };
    case "vercel.promote": return { ...config, deploymentId: render(config.deploymentId, handoff, 80) };
    case "vercel.rollback": return { ...config, deploymentId: render(config.deploymentId, handoff, 80), ...(config.rollbackReason ? { rollbackReason: render(config.rollbackReason, handoff, 240) } : {}) };
    case "github.issue-comment": {
      const issueNumber = typeof config.issueNumber === "string" ? Number(render(config.issueNumber, handoff, 20)) : config.issueNumber;
      return { ...config, issueNumber, bodyTemplate: render(config.bodyTemplate, handoff, MAX_BODY_CHARS) };
    }
    case "github.create-branch": return { ...config, branch: render(config.branch, handoff, 160), fromRef: render(config.fromRef, handoff, 160) };
    case "github.commit-files": return { ...config, branch: render(config.branch, handoff, 160), commitMessageTemplate: render(config.commitMessageTemplate, handoff, 240), files: config.files.map((file) => ({ path: render(file.path, handoff, 240), contentTemplate: render(file.contentTemplate, handoff, MAX_FILE_CHARS) })) };
    case "github.open-pr": return { ...config, head: render(config.head, handoff, 160), base: render(config.base, handoff, 160), titleTemplate: render(config.titleTemplate, handoff, 240), ...(config.bodyTemplate ? { bodyTemplate: render(config.bodyTemplate, handoff, MAX_BODY_CHARS) } : {}) };
    case "jira.create-issue": return { ...config, titleTemplate: render(config.titleTemplate, handoff, 240), bodyTemplate: render(config.bodyTemplate, handoff, MAX_BODY_CHARS) };
    case "jira.comment": return { ...config, bodyTemplate: render(config.bodyTemplate, handoff, MAX_BODY_CHARS) };
    case "linear.create-issue": return { ...config, titleTemplate: render(config.titleTemplate, handoff, 240), ...(config.bodyTemplate ? { bodyTemplate: render(config.bodyTemplate, handoff, MAX_BODY_CHARS) } : {}) };
    case "linear.comment": return { ...config, bodyTemplate: render(config.bodyTemplate, handoff, MAX_BODY_CHARS) };
    case "notion.create-page": return { ...config, titleTemplate: render(config.titleTemplate, handoff, 240), bodyTemplate: render(config.bodyTemplate, handoff, MAX_BODY_CHARS) };
    case "notion.append-page": return { ...config, bodyTemplate: render(config.bodyTemplate, handoff, MAX_BODY_CHARS) };
    default: return config;
    }
  })();
  return sanitizeConnectorActionConfig(rendered);
}

function oneLine(value: string, max = 180) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const suffix = `... (${normalized.length} chars total)`;
  return `${normalized.slice(0, Math.max(0, max - suffix.length)).trimEnd()}${suffix}`;
}

export function connectorActionPreview(config: SanitizedConnectorActionConfig, scopeLabel: string): string[] {
  const scope = oneLine(scopeLabel, 160) || "selected scope";
  switch (config.operation) {
    case "slack.send-message": return [`Send to ${scope}: ${oneLine(config.messageTemplate)}`];
    case "vercel.create-preview": return [`Create a preview deployment for ${scope} from ${config.gitRef ? `Git branch ${config.gitRef}` : "its latest source"}`];
    case "vercel.promote": return [`Promote ${config.deploymentId} to production for ${scope}`];
    case "vercel.rollback": return [`Roll back ${scope} to ${config.deploymentId}${config.rollbackReason ? `: ${oneLine(config.rollbackReason, 120)}` : ""}`];
    case "github.issue-comment": return [`Comment on ${scope}#${config.issueNumber}: ${oneLine(config.bodyTemplate)}`];
    case "github.create-branch": return [`Create ${config.branch} from ${config.fromRef} in ${scope}`];
    case "github.commit-files": return [
      `Commit ${config.files.length} ${config.files.length === 1 ? "file" : "files"} to ${scope}:${config.branch}: ${oneLine(config.commitMessageTemplate, 120)}`,
      ...config.files.map((file) => `Write ${file.path} (${file.contentTemplate.length} characters): ${oneLine(file.contentTemplate, 160)}`),
    ];
    case "github.open-pr": return [
      `Open PR ${config.head} -> ${config.base} in ${scope}: ${oneLine(config.titleTemplate)}`,
      ...(config.bodyTemplate ? [`PR description (${config.bodyTemplate.length} characters): ${oneLine(config.bodyTemplate)}`] : []),
    ];
    case "jira.create-issue": return [`Create ${config.issueType} in ${scope}: ${oneLine(config.titleTemplate)}`];
    case "jira.assign-issue": return [`Assign ${config.issueKey} in ${scope} to ${config.assigneeId}`];
    case "jira.comment": return [`Comment on ${config.issueKey} in ${scope}: ${oneLine(config.bodyTemplate)}`];
    case "jira.transition": return [`Apply transition ${config.transitionId} to ${config.issueKey} in ${scope}`];
    case "linear.create-issue": return [`Create issue in ${scope}: ${oneLine(config.titleTemplate)}`];
    case "linear.assign-issue": return [`Assign Linear issue ${config.issueId} in ${scope} to ${config.assigneeId}`];
    case "linear.comment": return [`Comment on Linear issue ${config.issueId} in ${scope}: ${oneLine(config.bodyTemplate)}`];
    case "linear.change-state": return [`Move Linear issue ${config.issueId} in ${scope} to state ${config.stateId}`];
    case "notion.create-page": return [`Create child page under ${scope}: ${oneLine(config.titleTemplate)}`];
    case "notion.append-page": return [`Append to ${scope}: ${oneLine(config.bodyTemplate)}`];
  }
}

export function isConnectorActionScope(connectorId: WritableConnectorId, scope: unknown): scope is string {
  if (typeof scope !== "string" || !scope || scope.length > 200 || scope.includes("://")) return false;
  if (connectorId === "github") return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope);
  if (connectorId === "slack") return /^[A-Z0-9]{5,32}$/.test(scope);
  if (connectorId === "vercel") return /^prj_[A-Za-z0-9]+$/.test(scope);
  if (connectorId === "jira") return /^[A-Z][A-Z0-9_]{1,19}$/.test(scope);
  if (connectorId === "linear") return /^[A-Za-z0-9_-]{8,200}$/.test(scope);
  return /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(scope);
}

export function defaultConnectorActionConfig(operation: ConnectorActionOperation): SanitizedConnectorActionConfig {
  switch (operation) {
    case "slack.send-message": return { operation, messageTemplate: HANDOFF_TOKEN };
    case "vercel.create-preview": return { operation };
    case "vercel.promote": return { operation, deploymentId: "dpl_deployment" };
    case "vercel.rollback": return { operation, deploymentId: "dpl_deployment", rollbackReason: "Restore the reviewed previous production deployment" };
    case "github.issue-comment": return { operation, issueNumber: 1, bodyTemplate: HANDOFF_TOKEN };
    case "github.create-branch": return { operation, branch: "codex/reviewed-change", fromRef: "main" };
    case "github.commit-files": return { operation, branch: "codex/reviewed-change", commitMessageTemplate: "chore: apply reviewed agent change", files: [{ path: "agent-output.md", contentTemplate: HANDOFF_TOKEN }] };
    case "github.open-pr": return { operation, head: "codex/reviewed-change", base: "main", titleTemplate: "Reviewed agent change", bodyTemplate: HANDOFF_TOKEN };
    case "jira.create-issue": return { operation, titleTemplate: "Agent follow-up", bodyTemplate: HANDOFF_TOKEN, issueType: "Task" };
    case "jira.assign-issue": return { operation, issueKey: "OPS-1", assigneeId: "account-id" };
    case "jira.comment": return { operation, issueKey: "OPS-1", bodyTemplate: HANDOFF_TOKEN };
    case "jira.transition": return { operation, issueKey: "OPS-1", transitionId: "1" };
    case "linear.create-issue": return { operation, titleTemplate: "Agent follow-up", bodyTemplate: HANDOFF_TOKEN };
    case "linear.assign-issue": return { operation, issueId: "issue-id", assigneeId: "assignee-id" };
    case "linear.comment": return { operation, issueId: "issue-id", bodyTemplate: HANDOFF_TOKEN };
    case "linear.change-state": return { operation, issueId: "issue-id", stateId: "state-id" };
    case "notion.create-page": return { operation, titleTemplate: "Agent result", bodyTemplate: HANDOFF_TOKEN };
    case "notion.append-page": return { operation, bodyTemplate: HANDOFF_TOKEN };
  }
}
