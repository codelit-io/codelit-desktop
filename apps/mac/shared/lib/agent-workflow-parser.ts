import type {
  AgentHarnessType,
  AgentMcpCapability,
  AgentRiskLevel,
  AgentSkillKind,
  AgentToolType,
  AgentWorkflow,
  AgentWorkflowAgent,
  AgentWorkflowEvaluation,
  AgentWorkflowGuardrail,
  AgentWorkflowHarness,
  AgentHandoffMode,
  AgentWorkflowMcpServer,
  AgentWorkflowModelRoute,
  AgentWorkflowModelPolicy,
  AgentWorkflowSkill,
  AgentWorkflowStep,
  AgentWorkflowTool,
  AgentWorkflowTrigger,
  AgentWorkflowVisualGroup,
} from "../stores/agent-workflow-store";
import { connectorForTool, isWorkflowConnectorId } from "./workflow-connectors";
import { isWorkflowExecutorId, sanitizeToolExecutionConfig } from "./workflow-tool-execution";
import { ensureInitialCoordinationPlan } from "./agent-coordination-plan";
import { sanitizeAgentRunInput } from "./agent-run-input";
import { sanitizeHostedTriggerDraft } from "./hosted-trigger-draft";
import { sanitizeAgentLibraryAssetRef } from "./agent-library-contract";

const VALID_TOOL_TYPES = new Set<AgentToolType>(["communication", "repo", "ticketing", "knowledge", "database", "browser", "runtime", "custom"]);
const VALID_AUTH_MODES = new Set(["oauth", "api-key", "service-account", "user-session", "none"]);
const VALID_RISK_LEVELS = new Set<AgentRiskLevel>(["low", "medium", "high"]);
const VALID_SKILL_KINDS = new Set<AgentSkillKind>(["domain", "tool", "workflow", "policy", "document", "eval"]);
const VALID_MCP_CAPABILITIES = new Set<AgentMcpCapability>(["tools", "resources", "prompts", "sampling", "roots"]);
const VALID_MCP_TRANSPORTS = new Set(["stdio", "http", "sse", "remote"]);
const VALID_HARNESS_TYPES = new Set<AgentHarnessType>(["eval", "sandbox", "replay", "observability", "approval", "prompt-regression"]);
const VALID_HANDOFF_MODES = new Set<AgentHandoffMode>(["always-next", "when-needed", "needs-approval"]);
const VALID_MODEL_POLICIES = new Set<AgentWorkflowModelPolicy["preset"]>(["auto", "fast", "balanced", "quality", "private"]);

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function extractJson(raw: string): string {
  const jsonBlock = raw.match(/```json\s*\n?([\s\S]*?)```/);
  if (jsonBlock) return jsonBlock[1].trim();
  const rawJson = raw.match(/\{[\s\S]*"agents"[\s\S]*"steps"[\s\S]*\}/);
  return rawJson ? rawJson[0] : raw;
}

export function parseAgentWorkflow(raw: string): AgentWorkflow | null {
  try {
    const parsed = JSON.parse(extractJson(raw));
    if (!parsed?.title || !Array.isArray(parsed.agents) || !Array.isArray(parsed.steps)) return null;

    const triggers: AgentWorkflowTrigger[] = (Array.isArray(parsed.triggers) ? parsed.triggers : [])
      .map(asRecord)
      .filter((trigger: Record<string, unknown>) => trigger.id && trigger.name)
      .map((trigger: Record<string, unknown>) => {
        const automation = sanitizeHostedTriggerDraft(trigger.automation, "UTC");
        return {
          id: String(trigger.id),
          name: String(trigger.name),
          source: String(trigger.source || "App Event"),
          event: String(trigger.event || ""),
          description: String(trigger.description || ""),
          ...(automation ? { automation } : {}),
        };
      });

    const tools: AgentWorkflowTool[] = (Array.isArray(parsed.tools) ? parsed.tools : [])
      .map(asRecord)
      .filter((tool: Record<string, unknown>) => tool.id && tool.name)
      .map((tool: Record<string, unknown>) => {
        const type = String(tool.type || "custom") as AgentToolType;
        const authMode = String(tool.authMode || "none") as AgentWorkflowTool["authMode"];
        const riskLevel = String(tool.riskLevel || "medium") as AgentRiskLevel;
        const explicitConnectorId = isWorkflowConnectorId(tool.connectorId) ? tool.connectorId : undefined;
        const executorId = isWorkflowExecutorId(tool.executorId) ? tool.executorId : undefined;
        const executionConfig = sanitizeToolExecutionConfig(tool.executionConfig);
        const executionBoundary = tool.executionBoundary === "imported-design" ? "imported-design" as const : undefined;
        const normalized: AgentWorkflowTool = {
          id: String(tool.id),
          name: String(tool.name),
          type: VALID_TOOL_TYPES.has(type) ? type : "custom",
          ...(explicitConnectorId ? { connectorId: explicitConnectorId } : {}),
          ...(executorId ? { executorId } : {}),
          ...(executionConfig ? { executionConfig } : {}),
          ...(executionBoundary ? { executionBoundary } : {}),
          description: String(tool.description || ""),
          authMode: VALID_AUTH_MODES.has(authMode) ? authMode : "none",
          riskLevel: VALID_RISK_LEVELS.has(riskLevel) ? riskLevel : "medium",
        };
        const inferredConnectorId = executionBoundary ? undefined : explicitConnectorId || connectorForTool(normalized)?.id;
        return inferredConnectorId ? { ...normalized, connectorId: inferredConnectorId } : normalized;
      });

    const agents: AgentWorkflowAgent[] = parsed.agents
      .map(asRecord)
      .filter((agent: Record<string, unknown>) => agent.id && agent.name)
      .map((agent: Record<string, unknown>) => {
        const libraryRef = sanitizeAgentLibraryAssetRef(agent.libraryRef, "teammate");
        return {
          id: String(agent.id),
          name: String(agent.name),
          role: String(agent.role || ""),
          responsibilities: asStringArray(agent.responsibilities),
          input: String(agent.input || ""),
          output: String(agent.output || ""),
          tools: asStringArray(agent.tools),
          modelPreference: String(agent.modelPreference || "Best available reasoning model"),
          escalationPolicy: String(agent.escalationPolicy || "Ask a human before irreversible actions."),
          ...(libraryRef ? { libraryRef } : {}),
        };
      });

    const parsedSteps: AgentWorkflowStep[] = parsed.steps
      .map(asRecord)
      .filter((step: Record<string, unknown>) => step.id && step.title)
      .map((step: Record<string, unknown>) => {
        const handoffMode = String(step.handoffMode || "always-next") as AgentHandoffMode;
        return {
          id: String(step.id),
          title: String(step.title),
          actor: String(step.actor || "human"),
          action: String(step.action || ""),
          onSuccess: String(step.onSuccess || ""),
          onFailure: String(step.onFailure || ""),
          next: asStringArray(step.next),
          handoffMode: VALID_HANDOFF_MODES.has(handoffMode) ? handoffMode : "always-next",
          ...(step.handoffCondition ? { handoffCondition: String(step.handoffCondition) } : {}),
          ...(Number.isInteger(step.retryPolicy && asRecord(step.retryPolicy).maxAttempts)
            ? { retryPolicy: { maxAttempts: Math.max(1, Math.min(4, Number(asRecord(step.retryPolicy).maxAttempts))) } }
            : {}),
        };
      });
    const steps = ensureInitialCoordinationPlan({ agents, goal: String(parsed.goal || ""), steps: parsedSteps });

    const skills: AgentWorkflowSkill[] = (Array.isArray(parsed.skills) ? parsed.skills : [])
      .map(asRecord)
      .filter((skill: Record<string, unknown>) => skill.id && skill.name)
      .map((skill: Record<string, unknown>) => {
        const kind = String(skill.kind || "workflow") as AgentSkillKind;
        const riskLevel = String(skill.riskLevel || "medium") as AgentRiskLevel;
        const libraryRef = sanitizeAgentLibraryAssetRef(skill.libraryRef, "skill");
        return {
          id: String(skill.id),
          name: String(skill.name),
          kind: VALID_SKILL_KINDS.has(kind) ? kind : "workflow",
          description: String(skill.description || ""),
          activation: String(skill.activation || "Load when the task matches this skill."),
          instructions: String(skill.instructions || ""),
          resources: asStringArray(skill.resources),
          scripts: asStringArray(skill.scripts),
          riskLevel: VALID_RISK_LEVELS.has(riskLevel) ? riskLevel : "medium",
          ...(libraryRef ? { libraryRef } : {}),
        };
      });

    const mcpServers: AgentWorkflowMcpServer[] = (Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [])
      .map(asRecord)
      .filter((server: Record<string, unknown>) => server.id && server.name)
      .map((server: Record<string, unknown>) => {
        const transport = String(server.transport || "remote") as AgentWorkflowMcpServer["transport"];
        const authMode = String(server.authMode || "none") as AgentWorkflowMcpServer["authMode"];
        const riskLevel = String(server.riskLevel || "medium") as AgentRiskLevel;
        return {
          id: String(server.id),
          name: String(server.name),
          transport: VALID_MCP_TRANSPORTS.has(transport) ? transport : "remote",
          description: String(server.description || ""),
          capabilities: asStringArray(server.capabilities).filter((cap): cap is AgentMcpCapability => VALID_MCP_CAPABILITIES.has(cap as AgentMcpCapability)),
          exposes: asStringArray(server.exposes),
          authMode: VALID_AUTH_MODES.has(authMode) ? authMode : "none",
          approvalPolicy: String(server.approvalPolicy || "Ask the user before high-risk tool calls."),
          riskLevel: VALID_RISK_LEVELS.has(riskLevel) ? riskLevel : "medium",
        };
      });

    const modelRoutes: AgentWorkflowModelRoute[] = (Array.isArray(parsed.modelRoutes) ? parsed.modelRoutes : [])
      .map(asRecord)
      .filter((route: Record<string, unknown>) => route.id && route.task)
      .map((route: Record<string, unknown>) => ({
        id: String(route.id),
        task: String(route.task),
        provider: String(route.provider || "OpenRouter"),
        model: String(route.model || "Best available model"),
        reason: String(route.reason || ""),
        fallback: String(route.fallback || "Retry with the next configured BYOK model"),
      }));

    const guardrails: AgentWorkflowGuardrail[] = (Array.isArray(parsed.guardrails) ? parsed.guardrails : [])
      .map(asRecord)
      .filter((guardrail: Record<string, unknown>) => guardrail.id && guardrail.title)
      .map((guardrail: Record<string, unknown>) => {
        const severity = String(guardrail.severity || "medium") as AgentRiskLevel;
        return {
          id: String(guardrail.id),
          title: String(guardrail.title),
          policy: String(guardrail.policy || ""),
          severity: VALID_RISK_LEVELS.has(severity) ? severity : "medium",
        };
      });

    const evaluations: AgentWorkflowEvaluation[] = (Array.isArray(parsed.evaluations) ? parsed.evaluations : [])
      .map(asRecord)
      .filter((evaluation: Record<string, unknown>) => evaluation.id && evaluation.title)
      .map((evaluation: Record<string, unknown>) => ({
        id: String(evaluation.id),
        title: String(evaluation.title),
        metric: String(evaluation.metric || ""),
        threshold: String(evaluation.threshold || ""),
      }));

    const harnesses: AgentWorkflowHarness[] = (Array.isArray(parsed.harnesses) ? parsed.harnesses : [])
      .map(asRecord)
      .filter((harness: Record<string, unknown>) => harness.id && harness.name)
      .map((harness: Record<string, unknown>) => {
        const type = String(harness.type || "eval") as AgentHarnessType;
        return {
          id: String(harness.id),
          name: String(harness.name),
          type: VALID_HARNESS_TYPES.has(type) ? type : "eval",
          description: String(harness.description || ""),
          runsWhen: String(harness.runsWhen || "Before production rollout"),
          passCriteria: String(harness.passCriteria || "All critical checks pass"),
        };
      });

    const parsedModelPolicy = asRecord(parsed.modelPolicy);
    const modelPreset = String(parsedModelPolicy.preset || "") as AgentWorkflowModelPolicy["preset"];
    const modelPolicy = VALID_MODEL_POLICIES.has(modelPreset) ? { preset: modelPreset } : undefined;
    const runInput = sanitizeAgentRunInput(parsed.runInput);

    const visualGroups: AgentWorkflowVisualGroup[] = (Array.isArray(parsed.visualGroups) ? parsed.visualGroups : [])
      .map(asRecord)
      .filter((group: Record<string, unknown>) => group.id && group.label)
      .map((group: Record<string, unknown>) => ({
        id: String(group.id),
        label: String(group.label),
        agentIds: asStringArray(group.agentIds).filter((agentId) => agents.some((agent) => agent.id === agentId)),
      }))
      .filter((group: AgentWorkflowVisualGroup) => group.agentIds.length > 1);

    return {
      title: String(parsed.title),
      description: String(parsed.description || ""),
      audience: String(parsed.audience || ""),
      goal: String(parsed.goal || ""),
      ...(runInput ? { runInput } : {}),
      triggers,
      tools,
      agents,
      ...(modelPolicy ? { modelPolicy } : {}),
      visualGroups,
      steps,
      skills,
      mcpServers,
      modelRoutes,
      guardrails,
      evaluations,
      harnesses,
      deployTargets: asStringArray(parsed.deployTargets),
    };
  } catch {
    return null;
  }
}
