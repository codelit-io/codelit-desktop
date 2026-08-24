import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WorkflowConnectorId } from "../lib/workflow-connectors";
import type { CustomActionConfig, ImportedOpenApiReview } from "../lib/custom-integrations";
import type { ProviderOperationConfig } from "../lib/provider-packs";
import type { HostedTriggerDraft } from "../lib/hosted-trigger-draft";
import type { AgentLibraryAssetRef } from "../lib/agent-library-contract";

export type AgentToolType =
  | "communication"
  | "repo"
  | "ticketing"
  | "knowledge"
  | "database"
  | "browser"
  | "runtime"
  | "custom";

export type AgentRiskLevel = "low" | "medium" | "high";
export type WorkflowExecutorId = "connector-read" | "connector-action" | "custom-action" | "provider-operation" | "github-actions" | "architecture-docs" | "browser";
export type GitHubActionsOperation = "inspect" | "dispatch" | "rerun-failed" | "cancel";
export type ConnectorActionOperation =
  | "slack.send-message"
  | "vercel.create-preview"
  | "vercel.promote"
  | "vercel.rollback"
  | "github.issue-comment"
  | "github.create-branch"
  | "github.commit-files"
  | "github.open-pr"
  | "jira.create-issue"
  | "jira.assign-issue"
  | "jira.comment"
  | "jira.transition"
  | "linear.create-issue"
  | "linear.assign-issue"
  | "linear.comment"
  | "linear.change-state"
  | "notion.create-page"
  | "notion.append-page";

export interface ConnectorActionFile {
  path?: string;
  contentTemplate?: string;
}

/** Persisted input is intentionally loose; the runtime accepts only the discriminated sanitized union. */
export interface ConnectorActionConfig {
  operation?: ConnectorActionOperation;
  messageTemplate?: string;
  titleTemplate?: string;
  bodyTemplate?: string;
  issueNumber?: number | string;
  issueKey?: string;
  issueId?: string;
  issueType?: string;
  assigneeId?: string;
  transitionId?: string;
  stateId?: string;
  deploymentId?: string;
  gitRef?: string;
  rollbackReason?: string;
  branch?: string;
  fromRef?: string;
  head?: string;
  base?: string;
  commitMessageTemplate?: string;
  files?: ConnectorActionFile[];
}
export type BrowserActionTargetKind = "role" | "label" | "text" | "testId";

export interface AgentBrowserActionTarget {
  kind: BrowserActionTargetKind;
  value: string;
  name?: string;
  exact?: boolean;
}

export type AgentBrowserAction =
  | { type: "navigate"; url: string }
  | { type: "observe" }
  | { type: "wait"; target: AgentBrowserActionTarget }
  | { type: "screenshot" }
  | { type: "click"; target: AgentBrowserActionTarget }
  | { type: "fill"; target: AgentBrowserActionTarget; value: string }
  | { type: "press"; target: AgentBrowserActionTarget; key: string }
  | { type: "select"; target: AgentBrowserActionTarget; value: string };

export interface ToolExecutionConfig {
  /** Resource chosen from connected-app discovery; never accept a pasted URL or credential. */
  connectorScope?: {
    scopeId: string;
    scopeLabel: string;
  };
  architecturePaths?: string[];
  /** Optional structured handoff path containing comma or newline separated repository paths. */
  architecturePathsHandoffField?: string;
  /** Bounded GitHub issue and repository-manifest context for issue-first engineering runs. */
  githubIssueContext?: {
    issueNumberHandoffField: string;
    includeRepositoryPaths?: boolean;
  };
  connectorAction?: ConnectorActionConfig;
  customAction?: CustomActionConfig;
  providerOperation?: ProviderOperationConfig;
  importedOpenApi?: ImportedOpenApiReview;
  githubActions?: {
    operation?: GitHubActionsOperation;
    workflowId?: string;
    ref?: string;
    runId?: number;
  };
  browser?: {
    startUrl?: string;
    /** Optional structured handoff path used to choose a page inside approvedDomains at run time. */
    startUrlHandoffField?: string;
    /** Optional structured handoff path used to approve one validated run-time domain. */
    approvedDomainHandoffField?: string;
    approvedDomains?: string[];
    sessionId?: string;
    mode?: "read" | "write";
    persistSession?: boolean;
    maxDurationSeconds?: number;
    goal?: string;
    /** Optional structured handoff path used as the Browser Operator goal. */
    goalHandoffField?: string;
    successCriteria?: string;
    /** Optional structured handoff path used as visible completion criteria. */
    successCriteriaHandoffField?: string;
    actions?: AgentBrowserAction[];
  };
}
export type AgentSkillKind = "domain" | "tool" | "workflow" | "policy" | "document" | "eval";
export type AgentMcpCapability = "tools" | "resources" | "prompts" | "sampling" | "roots";
export type AgentHarnessType = "eval" | "sandbox" | "replay" | "observability" | "approval" | "prompt-regression";

export interface AgentWorkflowTrigger {
  id: string;
  name: string;
  source: string;
  event: string;
  description: string;
  /** Reviewed design-time setup used to prefill a hosted automation. */
  automation?: HostedTriggerDraft;
}

export interface AgentWorkflowTool {
  id: string;
  name: string;
  type: AgentToolType;
  /** Stable connected-app identity. Optional for legacy/custom workflow JSON. */
  connectorId?: WorkflowConnectorId;
  /** Stable runtime behavior. Optional for legacy workflow JSON. */
  executorId?: WorkflowExecutorId;
  /** Executor-specific, boundary-validated configuration. */
  executionConfig?: ToolExecutionConfig;
  /** Imported source metadata stays inert until the user maps a Codelit executor. */
  executionBoundary?: "imported-design";
  description: string;
  authMode: "oauth" | "api-key" | "service-account" | "user-session" | "none";
  riskLevel: AgentRiskLevel;
}

export interface AgentWorkflowSkill {
  id: string;
  name: string;
  kind: AgentSkillKind;
  description: string;
  activation: string;
  instructions: string;
  resources: string[];
  scripts: string[];
  riskLevel: AgentRiskLevel;
  /** Exact reusable definition used to create this embedded compatibility snapshot. */
  libraryRef?: AgentLibraryAssetRef<"skill">;
}

export interface AgentWorkflowMcpServer {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse" | "remote";
  description: string;
  capabilities: AgentMcpCapability[];
  exposes: string[];
  authMode: "oauth" | "api-key" | "service-account" | "user-session" | "none";
  approvalPolicy: string;
  riskLevel: AgentRiskLevel;
}

export interface AgentWorkflowHarness {
  id: string;
  name: string;
  type: AgentHarnessType;
  description: string;
  runsWhen: string;
  passCriteria: string;
}

export interface AgentWorkflowAgent {
  id: string;
  name: string;
  role: string;
  responsibilities: string[];
  input: string;
  output: string;
  tools: string[];
  modelPreference: string;
  escalationPolicy: string;
  /** Exact reusable definition used to create this embedded compatibility snapshot. */
  libraryRef?: AgentLibraryAssetRef<"teammate">;
}

export interface AgentWorkflowVisualGroup {
  id: string;
  label: string;
  agentIds: string[];
}

export type AgentModelPolicyPreset = "auto" | "fast" | "balanced" | "quality" | "private";

export interface AgentWorkflowModelPolicy {
  preset: AgentModelPolicyPreset;
}

export type AgentHandoffMode = "always-next" | "when-needed" | "needs-approval";

export interface AgentStepRetryPolicy {
  /** Total model-call attempts, including the first attempt. */
  maxAttempts: number;
}

export interface AgentWorkflowStep {
  id: string;
  title: string;
  actor: string;
  action: string;
  onSuccess: string;
  onFailure: string;
  next: string[];
  /** Defaults to always-next for legacy workflows. */
  handoffMode?: AgentHandoffMode;
  /** Plain-language rule the current agent uses for conditional handoffs. */
  handoffCondition?: string;
  /** Bounded model-call retry policy. Tool calls are never replayed. */
  retryPolicy?: AgentStepRetryPolicy;
}

export interface AgentWorkflowModelRoute {
  id: string;
  task: string;
  provider: string;
  model: string;
  reason: string;
  fallback: string;
}

export interface AgentWorkflowGuardrail {
  id: string;
  title: string;
  policy: string;
  severity: AgentRiskLevel;
}

export interface AgentWorkflowEvaluation {
  id: string;
  title: string;
  metric: string;
  threshold: string;
}

export type AgentRunInputFieldType = "text" | "textarea" | "email" | "url" | "integer" | "currency" | "select";

export interface AgentRunInputOption {
  value: string;
  label: string;
}

export interface AgentRunInputField {
  id: string;
  label: string;
  type?: AgentRunInputFieldType;
  placeholder?: string;
  required?: boolean;
  options?: AgentRunInputOption[];
  /** Integer bounds, or minor currency units when type is currency. */
  min?: number;
  max?: number;
}

export interface AgentRunInputDefinition {
  title: string;
  description?: string;
  submitLabel?: string;
  /** Optional source-aware launch UI backed by the same bounded field contract. */
  preset?: "github-issue";
  fields: AgentRunInputField[];
}

export interface AgentWorkflow {
  title: string;
  description: string;
  audience: string;
  goal: string;
  /** Compact case details requested immediately before an interactive run. */
  runInput?: AgentRunInputDefinition;
  triggers: AgentWorkflowTrigger[];
  tools: AgentWorkflowTool[];
  agents: AgentWorkflowAgent[];
  /** Team default only; exact Agent and task routes remain authoritative overrides. */
  modelPolicy?: AgentWorkflowModelPolicy;
  /** Optional visual organization only; never changes execution order. */
  visualGroups?: AgentWorkflowVisualGroup[];
  steps: AgentWorkflowStep[];
  skills?: AgentWorkflowSkill[];
  mcpServers?: AgentWorkflowMcpServer[];
  modelRoutes: AgentWorkflowModelRoute[];
  guardrails: AgentWorkflowGuardrail[];
  evaluations: AgentWorkflowEvaluation[];
  harnesses?: AgentWorkflowHarness[];
  deployTargets: string[];
}

export type AgentWorkflowImprovementKind = "approval-gate" | "outcome-check";

export interface AgentWorkflowImprovementAttribution {
  version: 1;
  kind: AgentWorkflowImprovementKind;
  label: string;
  /** Sanitized local snapshot used only for immediate one-step rollback. */
  baselineWorkflow: AgentWorkflow;
  baselineWorkflowVersion: string;
  candidateWorkflowVersion: string;
}

export interface AgentWorkflowRemixAttribution {
  receiptId?: string;
  title: string;
  url?: string;
  improvement?: AgentWorkflowImprovementAttribution;
  marketplace?: {
    source: "marketplace";
    category?: string;
    placement?: string;
    readiness?: "evidence-building" | "strong" | "mixed" | "needs-review";
  };
}

interface AgentWorkflowStore {
  workflow: AgentWorkflow | null;
  /** Slug context the current draft belongs to. Lets /agents/[slug] trust a
   * restored draft only when it was edited under that same slug. */
  draftSlug: string | null;
  remixAttribution: AgentWorkflowRemixAttribution | null;
  selectedAgent: AgentWorkflowAgent | null;

  setWorkflow: (workflow: AgentWorkflow, options?: { preserveRemixAttribution?: boolean }) => void;
  setDraftSlug: (slug: string | null) => void;
  setRemixAttribution: (attribution: AgentWorkflowRemixAttribution | null) => void;
  clearWorkflow: () => void;
  setSelectedAgent: (agent: AgentWorkflowAgent | null) => void;
  updateAgent: (id: string, updates: Partial<AgentWorkflowAgent>) => void;

  toArchitecturePrompt: () => string;
  toProductBoardPrompt: () => string;
  toHandoffMarkdown: () => string;
}

// Improvement rollback survives reload without retaining its public receipt identifier.
function persistedRemixAttribution(attribution: AgentWorkflowRemixAttribution | null) {
  if (!attribution?.improvement) return attribution;
  return {
    title: attribution.title,
    improvement: attribution.improvement,
    ...(attribution.marketplace ? { marketplace: attribution.marketplace } : {}),
  } satisfies AgentWorkflowRemixAttribution;
}

export function sanitizePersistedAgentWorkflowState(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const state = value as { remixAttribution?: AgentWorkflowRemixAttribution | null };
  return {
    ...state,
    remixAttribution: persistedRemixAttribution(state.remixAttribution || null),
  };
}

export const useAgentWorkflowStore = create<AgentWorkflowStore>()(persist((set, get) => ({
  workflow: null,
  draftSlug: null,
  remixAttribution: null,
  selectedAgent: null,

  setWorkflow: (workflow, options) => set((state) => ({
    workflow,
    remixAttribution: options?.preserveRemixAttribution ? state.remixAttribution : null,
    selectedAgent: null,
  })),
  setDraftSlug: (slug) => set({ draftSlug: slug }),
  setRemixAttribution: (remixAttribution) => set({ remixAttribution }),
  clearWorkflow: () => set({ workflow: null, draftSlug: null, remixAttribution: null, selectedAgent: null }),
  setSelectedAgent: (agent) => set({ selectedAgent: agent }),

  updateAgent: (id, updates) => {
    const { workflow, selectedAgent } = get();
    if (!workflow) return;
    const agents = workflow.agents.map((agent) => agent.id === id ? { ...agent, ...updates } : agent);
    set({
      workflow: { ...workflow, agents },
      selectedAgent: selectedAgent?.id === id ? { ...selectedAgent, ...updates } : selectedAgent,
    });
  },

  toArchitecturePrompt: () => {
    const { workflow } = get();
    if (!workflow) return "";
    const toolList = workflow.tools.map((tool) => `${tool.name} (${tool.type}, ${tool.authMode})`).join(", ");
    const skillList = (workflow.skills || []).map((skill) => `${skill.name}: ${skill.activation}`).join("\n");
    const mcpList = (workflow.mcpServers || []).map((server) => `${server.name}: ${server.capabilities.join(", ")} exposed as ${server.exposes.join(", ")}`).join("\n");
    const harnessList = (workflow.harnesses || []).map((harness) => `${harness.name}: ${harness.type}, ${harness.passCriteria}`).join("\n");
    const triggerList = workflow.triggers.map((trigger) => `${trigger.name}: ${trigger.source} -> ${trigger.event}. ${trigger.description}`).join("\n");
    const guardrailList = workflow.guardrails.map((guardrail) => `${guardrail.title} (${guardrail.severity}): ${guardrail.policy}`).join("\n");
    const evaluationList = workflow.evaluations.map((evaluation) => `${evaluation.title}: ${evaluation.metric} - ${evaluation.threshold}`).join("\n");
    const agentList = workflow.agents.map((agent) => `${agent.name}: ${agent.role}`).join("\n");
    const stepList = workflow.steps.map((step) => `${step.title}: ${step.actor} ${step.action}`).join("\n");

    return [
      `Generate the production architecture for this agentic workflow: ${workflow.title}.`,
      workflow.description,
      `Goal: ${workflow.goal}`,
      `Audience: ${workflow.audience}`,
      triggerList ? `Triggers:\n${triggerList}` : "",
      `Agents:\n${agentList}`,
      `Connected tools: ${toolList}`,
      skillList ? `Skills:\n${skillList}` : "",
      mcpList ? `MCP servers:\n${mcpList}` : "",
      `Workflow:\n${stepList}`,
      guardrailList ? `Guardrails:\n${guardrailList}` : "",
      evaluationList ? `Evaluations:\n${evaluationList}` : "",
      harnessList ? `Harnesses:\n${harnessList}` : "",
      `Deploy targets: ${workflow.deployTargets.join(", ")}`,
      "Include the agent runtime, trigger receivers, streaming response path, skill registry, MCP client/server layer, orchestration layer, model routing, connector auth, credential vault, job queue, memory/session store, source ledger, audit log, trace/replay store, eval harness, observability, approval UI, and deployment path.",
    ].filter(Boolean).join("\n\n");
  },

  toProductBoardPrompt: () => {
    const { workflow } = get();
    if (!workflow) return "";
    const behaviorList = workflow.steps.map((step) => `${step.actor}: ${step.action} (success: ${step.onSuccess}; failure: ${step.onFailure})`).join("\n");
    const outcomeList = workflow.agents.flatMap((agent) => agent.responsibilities).join("; ");
    const qualityList = [
      ...workflow.evaluations.map((evaluation) => `${evaluation.title}: ${evaluation.metric} ${evaluation.threshold}`),
      ...workflow.guardrails.map((guardrail) => `${guardrail.title}: ${guardrail.policy}`),
    ].join("\n");
    return [
      `Create the Product Plan for shipping ${workflow.title}.`,
      workflow.description,
      `Primary user: ${workflow.audience}`,
      `Goal: ${workflow.goal}`,
      `Triggers: ${workflow.triggers.map((trigger) => `${trigger.source}:${trigger.event}`).join(", ") || "Define trigger modes"}`,
      `Agents: ${workflow.agents.map((agent) => agent.name).join(", ")}`,
      `Skills: ${(workflow.skills || []).map((skill) => skill.name).join(", ") || "Define task-specific skills"}`,
      `Tools: ${workflow.tools.map((tool) => tool.name).join(", ")}`,
      `MCP: ${(workflow.mcpServers || []).map((server) => server.name).join(", ") || "Define MCP servers where tool/resource access belongs"}`,
      `Runtime and cloud: ${workflow.deployTargets.join(", ") || "Define webhook, worker, queue, storage, credential, and observability services"}`,
      `Guardrails: ${workflow.guardrails.map((guardrail) => guardrail.title).join(", ") || "Define approval and data access rules"}`,
      `Evaluations: ${workflow.evaluations.map((evaluation) => evaluation.title).join(", ") || "Define pre-deploy and regression evals"}`,
      behaviorList ? `Required behavior:\n${behaviorList}` : "Required behavior: Define the smallest complete end-to-end workflow.",
      `Expected outcomes: ${outcomeList || workflow.goal}`,
      qualityList ? `Quality checks:\n${qualityList}` : "Quality checks: Define measurable acceptance, safety, and regression criteria.",
      "Break this into prioritized MVP features, user stories, screens, engineering requirements, quality checks, and sequenced milestones. Every must-have outcome must map to observable behavior and a verification criterion.",
    ].join("\n\n");
  },

  toHandoffMarkdown: () => {
    const { workflow } = get();
    if (!workflow) return "";

    const lines: string[] = [
      `# ${workflow.title}`,
      "",
      `> ${workflow.description}`,
      "",
      `**Audience:** ${workflow.audience}`,
      `**Goal:** ${workflow.goal}`,
      "",
      "## Triggers",
      "",
    ];

    for (const trigger of workflow.triggers) {
      lines.push(`- **${trigger.name}** (${trigger.source}): ${trigger.event}`);
      lines.push(`  ${trigger.description}`);
    }

    lines.push(
      "",
      "## Agents",
      "",
    );

    for (const agent of workflow.agents) {
      lines.push(`### ${agent.name}`);
      lines.push(`- Role: ${agent.role}`);
      lines.push(`- Input: ${agent.input}`);
      lines.push(`- Output: ${agent.output}`);
      lines.push(`- Model: ${agent.modelPreference}`);
      lines.push(`- Escalation: ${agent.escalationPolicy}`);
      lines.push(`- Tools: ${agent.tools.join(", ") || "None"}`);
      lines.push("- Responsibilities:");
      for (const responsibility of agent.responsibilities) lines.push(`  - ${responsibility}`);
      lines.push("");
    }

    if (workflow.skills?.length) {
      lines.push("## Skills");
      lines.push("");
      for (const skill of workflow.skills) {
        lines.push(`### ${skill.name}`);
        lines.push(`- Kind: ${skill.kind}`);
        lines.push(`- Activation: ${skill.activation}`);
        lines.push(`- Instructions: ${skill.instructions}`);
        lines.push(`- Resources: ${skill.resources.join(", ") || "None"}`);
        lines.push(`- Scripts: ${skill.scripts.join(", ") || "None"}`);
        lines.push(`- Risk: ${skill.riskLevel}`);
        lines.push("");
      }
    }

    if (workflow.mcpServers?.length) {
      lines.push("## MCP Servers");
      lines.push("");
      for (const server of workflow.mcpServers) {
        lines.push(`### ${server.name}`);
        lines.push(`- Transport: ${server.transport}`);
        lines.push(`- Capabilities: ${server.capabilities.join(", ")}`);
        lines.push(`- Exposes: ${server.exposes.join(", ")}`);
        lines.push(`- Auth: ${server.authMode}`);
        lines.push(`- Approval: ${server.approvalPolicy}`);
        lines.push(`- Risk: ${server.riskLevel}`);
        lines.push("");
      }
    }

    lines.push("## Workflow");
    lines.push("");
    for (const step of workflow.steps) {
      lines.push(`- **${step.title}**, ${step.actor}: ${step.action}`);
      lines.push(`  Success: ${step.onSuccess}`);
      lines.push(`  Failure: ${step.onFailure}`);
    }

    lines.push("");
    lines.push("## Guardrails");
    lines.push("");
    for (const guardrail of workflow.guardrails) {
      lines.push(`- **${guardrail.title}** (${guardrail.severity}): ${guardrail.policy}`);
    }

    lines.push("");
    lines.push("## Evaluations");
    lines.push("");
    for (const evaluation of workflow.evaluations) {
      lines.push(`- **${evaluation.title}:** ${evaluation.metric}, ${evaluation.threshold}`);
    }

    if (workflow.harnesses?.length) {
      lines.push("");
      lines.push("## Harnesses");
      lines.push("");
      for (const harness of workflow.harnesses) {
        lines.push(`- **${harness.name}** (${harness.type}): ${harness.description}`);
        lines.push(`  Runs when: ${harness.runsWhen}`);
        lines.push(`  Pass criteria: ${harness.passCriteria}`);
      }
    }

    lines.push("");
    lines.push("## Runtime and Deploy Targets");
    lines.push("");
    for (const target of workflow.deployTargets) lines.push(`- ${target}`);

    lines.push("");
    lines.push("*Generated with Codelit.io*");
    return lines.join("\n");
  },
}), {
  name: "codelit-agent-draft",
  version: 1,
  migrate: sanitizePersistedAgentWorkflowState,
  partialize: (state) => ({
    workflow: state.workflow,
    draftSlug: state.draftSlug,
    remixAttribution: persistedRemixAttribution(state.remixAttribution),
  }),
}));
