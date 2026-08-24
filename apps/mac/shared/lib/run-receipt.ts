import type { LiveRunTranscript } from "./agent-live-run";
import { isLiveRunActionProviderId } from "./agent-live-action-provider";
import type { AgentRunFundingSource, AgentRunMode } from "./agent-run-mode";
import type { AgentWorkflow, AgentHandoffMode, AgentRiskLevel, AgentToolType } from "../stores/agent-workflow-store";
import type { FailureLabStatus } from "./failure-lab";
import type { FailureScenarioId } from "./fixtures/failure-scenarios";
import type { WorkflowConnectorId } from "./workflow-connectors";
import type { ProviderPackId } from "./provider-packs";
import type { AgentActionEvidenceType } from "./workflow-actions";
import { normalizeAgentRunTiming } from "./agent-run-duration";

export const RUN_RECEIPT_VERSION = 1 as const;
export const MAX_RUN_RECEIPT_BYTES = 48_000;
const MAX_PUBLIC_STEPS = 12;
const MAX_STEP_OUTPUT_CHARS = 800;

export type RunReceiptRedactionCategory = "credential" | "link" | "email" | "path" | "source-id" | "high-entropy" | "truncated";

export interface RunReceiptRedactionReport {
  originalBytes: number;
  publicBytes: number;
  removed: Partial<Record<RunReceiptRedactionCategory, number>>;
  omittedStepOutputs: number[];
  /** Outputs containing source identifiers or credentials that should start hidden in the review UI. */
  sensitiveStepOutputs: number[];
}

export interface PublicRunReceiptWorkflow {
  title: string;
  description: string;
  audience: string;
  goal: string;
  triggers: Array<{ name: string; source: string; event: string; description: string }>;
  tools: Array<{ name: string; type: AgentToolType; description: string; authMode: string; riskLevel: AgentRiskLevel }>;
  agents: Array<{
    name: string;
    role: string;
    responsibilities: string[];
    input: string;
    output: string;
    toolNames: string[];
    modelPreference: string;
    escalationPolicy: string;
  }>;
  steps: Array<{ title: string; actorName: string; action: string; onSuccess: string; onFailure: string; handoffMode?: AgentHandoffMode; handoffCondition?: string }>;
  modelRoutes: Array<{ task: string; provider: string; model: string; reason: string; fallback: string }>;
  guardrails: Array<{ title: string; policy: string; severity: AgentRiskLevel }>;
  evaluations: Array<{ title: string; metric: string; threshold: string }>;
  skills: Array<{ name: string; kind: string; description: string; activation: string; instructions: string; riskLevel: AgentRiskLevel }>;
  mcpServers: Array<{ name: string; transport: string; description: string; capabilities: string[]; authMode: string; approvalPolicy: string; riskLevel: AgentRiskLevel }>;
  harnesses: Array<{ name: string; type: string; description: string; runsWhen: string; passCriteria: string }>;
}

export interface PublicRunReceiptStep {
  index: number;
  title: string;
  actor: string;
  model: string;
  status: "completed" | "held" | "halted";
  gated: boolean;
  approved?: boolean;
  toolNames: string[];
  output?: string;
  outputOmitted?: true;
  handoff?: {
    mode: AgentHandoffMode;
    status: "completed" | "skipped" | "held";
    toActor: string;
    condition?: string;
  };
  browserProofs?: Array<{
    mode: "read" | "write";
    evidenceTypes: Array<"dom" | "screenshot">;
    attempts: number;
    events: Array<{ action: string; status: "completed" | "retry" }>;
  }>;
  actionProofs?: Array<{
    connectorId: WorkflowConnectorId | ProviderPackId | "custom";
    operation: string;
    evidenceTypes: AgentActionEvidenceType[];
  }>;
}

export type PublicRunReceiptMemoryCategory = "fact" | "decision" | "preference" | "procedure" | "lesson" | "reference";

export interface PublicRunReceiptContext {
  teammates: number;
  skills: number;
  memories: {
    count: number;
    categories: PublicRunReceiptMemoryCategory[];
  };
  rubrics: number;
  provenance?: {
    source: "compiled-snapshot";
    compatibilityMode: "embedded" | "library-pinned";
    /** Receipt-scoped commitment. Raw private snapshot and asset digests stay private. */
    commitment: string;
  };
}

export interface RunReceiptPublicContextInput {
  teammateCount?: number;
  skillCount?: number;
  memoryCount?: number;
  memoryCategories?: unknown[];
  rubricCount?: number;
  provenance?: unknown;
}

export interface PublicRunReceipt {
  version: typeof RUN_RECEIPT_VERSION;
  title: string;
  summary: string;
  workflow: PublicRunReceiptWorkflow;
  run: {
    mode: AgentRunMode;
    fundingSources: AgentRunFundingSource[];
    status: "completed" | "halted";
    durationMs: number;
    activeDurationMs?: number;
    approvalWaitMs?: number;
    stepCount: number;
    steps: PublicRunReceiptStep[];
    usage?: {
      modelUsd: number;
      browserMinutes: number;
      basis: "provider-reported-cost" | "provider-token-counts" | "estimated-token-counts" | "workflow-estimate" | "mixed" | "unavailable";
      status: "settled" | "pending";
    };
  };
  /** Bounded counts only. Exact private context references stay with the compiled run. */
  context?: PublicRunReceiptContext;
  failureLab?: {
    score: number;
    totals: { passed: number; failed: number; untested: number; notApplicable: number; contained: number };
    scenarios: Array<{ id: FailureScenarioId; label: string; status: FailureLabStatus }>;
  };
}

export interface RunReceiptPreview {
  receipt: PublicRunReceipt;
  report: RunReceiptRedactionReport;
}

export class RunReceiptError extends Error {
  constructor(public code: "invalid-receipt" | "receipt-too-large" | "receipt-limit", message: string) {
    super(message);
    this.name = "RunReceiptError";
  }
}

type RedactionTracker = Partial<Record<RunReceiptRedactionCategory, number>>;

const REDACTION_PATTERNS: Array<{ category: RunReceiptRedactionCategory; pattern: RegExp; replacement: string }> = [
  { category: "credential", pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gi, replacement: "[credential removed]" },
  { category: "credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, replacement: "[credential removed]" },
  { category: "credential", pattern: /\b(?:sk|rk|pk|gh[opusr])[-_][A-Za-z0-9_-]{12,}\b/gi, replacement: "[credential removed]" },
  { category: "credential", pattern: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g, replacement: "[credential removed]" },
  { category: "credential", pattern: /\bglpat-[A-Za-z0-9_-]{12,}\b/gi, replacement: "[credential removed]" },
  { category: "credential", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, replacement: "[credential removed]" },
  { category: "credential", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: "[credential removed]" },
  { category: "credential", pattern: /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret)\s*[:=]\s*[^\s,;]{6,}/gi, replacement: "[credential removed]" },
  { category: "link", pattern: /https?:\/\/[^\s<>"')\]]+/gi, replacement: "[link removed]" },
  { category: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: "[email removed]" },
  { category: "path", pattern: /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/g, replacement: "[path removed]" },
  { category: "path", pattern: /\/(?:Users|home|var|tmp|workspace|app)\/[A-Za-z0-9._~+/-]+/g, replacement: "[path removed]" },
  { category: "path", pattern: /\b(?:src|lib|docs|packages|services|apps|node_modules)\/[A-Za-z0-9._~+/-]+/g, replacement: "[path removed]" },
  { category: "source-id", pattern: /\b(?:customer|account|source|project|deployment|repository|repo|run|approval|ticket|payment(?:[ _-]?intent)?|order(?:[ _-]?g)?|conversation|incident|document|issue|message|channel|team|tenant|workspace|refund|charge|session)[ _-]?id["']?\s*[:=]\s*["']?[A-Za-z0-9._:/-]{2,}/gi, replacement: "[source id removed]" },
  { category: "source-id", pattern: /\b(?:pi|cus|ch|re|pm|seti|src|tok|evt)_[A-Za-z0-9]{6,}\b/g, replacement: "[source id removed]" },
  { category: "source-id", pattern: /\bgid:\/\/shopify\/[A-Za-z][A-Za-z0-9_-]*\/[A-Za-z0-9_-]+\b/gi, replacement: "[source id removed]" },
  { category: "source-id", pattern: /\b(?:ticket|issue|incident|conversation|case)\s*#\s*\d{2,}\b/gi, replacement: "[source id removed]" },
  { category: "source-id", pattern: /\bbranch\s+(?:named\s+)?(?=[A-Za-z0-9._/-]*[/.])[A-Za-z0-9._/-]{4,}/gi, replacement: "[source reference removed]" },
  { category: "high-entropy", pattern: /\b(?=[A-Za-z0-9+/_=-]{32,}\b)(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]+/g, replacement: "[sensitive value removed]" },
];

function increment(tracker: RedactionTracker, category: RunReceiptRedactionCategory, count = 1) {
  tracker[category] = (tracker[category] || 0) + count;
}

function redactText(value: unknown, maxChars: number, tracker: RedactionTracker): string {
  let text = typeof value === "string" ? value : "";
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  for (const rule of REDACTION_PATTERNS) {
    let matches = 0;
    text = text.replace(rule.pattern, () => {
      matches += 1;
      return rule.replacement;
    });
    if (matches) increment(tracker, rule.category, matches);
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > maxChars) {
    increment(tracker, "truncated");
    text = `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }
  return text;
}

function safeList(value: unknown, maxItems: number, maxChars: number, tracker: RedactionTracker): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems) increment(tracker, "truncated");
  return value.slice(0, maxItems).map((item) => redactText(item, maxChars, tracker)).filter(Boolean);
}

function boundedNumber(value: unknown, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0;
}

function publicContextProvenance(value: unknown): PublicRunReceiptContext["provenance"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunReceiptError("invalid-receipt", "Public context provenance is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.source !== "compiled-snapshot"
    || (candidate.compatibilityMode !== "embedded" && candidate.compatibilityMode !== "library-pinned")
    || typeof candidate.commitment !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(candidate.commitment)
  ) {
    throw new RunReceiptError("invalid-receipt", "Public context provenance is invalid");
  }
  return {
    source: candidate.source,
    compatibilityMode: candidate.compatibilityMode,
    commitment: candidate.commitment,
  };
}

function utf8Bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createRunReceiptPreview(
  workflow: AgentWorkflow,
  transcript: LiveRunTranscript,
  options: { omitStepOutputs?: number[]; context?: RunReceiptPublicContextInput } = {},
): RunReceiptPreview {
  if (!workflow || !transcript || !Array.isArray(workflow.steps) || !Array.isArray(transcript.steps)) {
    throw new RunReceiptError("invalid-receipt", "A terminal workflow and transcript are required");
  }
  if (!(["completed", "halted"] as const).includes(transcript.status)) {
    throw new RunReceiptError("invalid-receipt", "Only terminal runs can be published");
  }
  const originalBytes = utf8Bytes({ workflow, transcript });
  if (originalBytes > 250_000) throw new RunReceiptError("receipt-too-large", "Run data is too large to publish");
  const tracker: RedactionTracker = {};
  const omittedStepOutputs = Array.from(new Set(options.omitStepOutputs || []))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < MAX_PUBLIC_STEPS)
    .sort((a, b) => a - b);
  const omittedSet = new Set(omittedStepOutputs);
  const sensitiveStepOutputs: number[] = [];
  const toolNameById = new Map((workflow.tools || []).map((tool) => [tool.id, redactText(tool.name, 100, tracker)]));
  const agentNameById = new Map((workflow.agents || []).map((agent) => [agent.id, redactText(agent.name, 100, tracker)]));

  const publicWorkflow: PublicRunReceiptWorkflow = {
    title: redactText(workflow.title, 140, tracker),
    description: redactText(workflow.description, 500, tracker),
    audience: redactText(workflow.audience, 240, tracker),
    goal: redactText(workflow.goal, 300, tracker),
    triggers: (workflow.triggers || []).slice(0, 4).map((trigger) => ({
      name: redactText(trigger.name, 100, tracker),
      source: redactText(trigger.source, 80, tracker),
      event: redactText(trigger.event, 120, tracker),
      description: redactText(trigger.description, 240, tracker),
    })),
    tools: (workflow.tools || []).slice(0, 12).map((tool) => ({
      name: redactText(tool.name, 100, tracker),
      type: tool.type,
      description: redactText(tool.description, 260, tracker),
      authMode: redactText(tool.authMode, 60, tracker),
      riskLevel: tool.riskLevel,
    })),
    agents: (workflow.agents || []).slice(0, 8).map((agent) => ({
      name: redactText(agent.name, 100, tracker),
      role: redactText(agent.role, 280, tracker),
      responsibilities: safeList(agent.responsibilities, 8, 180, tracker),
      input: redactText(agent.input, 240, tracker),
      output: redactText(agent.output, 240, tracker),
      toolNames: (agent.tools || []).slice(0, 12).map((id) => toolNameById.get(id) || "").filter(Boolean),
      modelPreference: redactText(agent.modelPreference, 120, tracker),
      escalationPolicy: redactText(agent.escalationPolicy, 280, tracker),
    })),
    steps: (workflow.steps || []).slice(0, MAX_PUBLIC_STEPS).map((step) => ({
      title: redactText(step.title, 120, tracker),
      actorName: agentNameById.get(step.actor) || redactText(step.actor, 100, tracker) || "Human operator",
      action: redactText(step.action, 300, tracker),
      onSuccess: redactText(step.onSuccess, 240, tracker),
      onFailure: redactText(step.onFailure, 240, tracker),
      handoffMode: step.handoffMode || "always-next",
      ...(step.handoffCondition ? { handoffCondition: redactText(step.handoffCondition, 240, tracker) } : {}),
    })),
    modelRoutes: (workflow.modelRoutes || []).slice(0, 8).map((route) => ({
      task: redactText(route.task, 120, tracker),
      provider: redactText(route.provider, 80, tracker),
      model: redactText(route.model, 100, tracker),
      reason: redactText(route.reason, 220, tracker),
      fallback: redactText(route.fallback, 100, tracker),
    })),
    guardrails: (workflow.guardrails || []).slice(0, 10).map((guardrail) => ({
      title: redactText(guardrail.title, 120, tracker),
      policy: redactText(guardrail.policy, 320, tracker),
      severity: guardrail.severity,
    })),
    evaluations: (workflow.evaluations || []).slice(0, 10).map((evaluation) => ({
      title: redactText(evaluation.title, 120, tracker),
      metric: redactText(evaluation.metric, 240, tracker),
      threshold: redactText(evaluation.threshold, 160, tracker),
    })),
    skills: (workflow.skills || []).slice(0, 8).map((skill) => ({
      name: redactText(skill.name, 120, tracker),
      kind: redactText(skill.kind, 60, tracker),
      description: redactText(skill.description, 280, tracker),
      activation: redactText(skill.activation, 220, tracker),
      instructions: redactText(skill.instructions, 420, tracker),
      riskLevel: skill.riskLevel,
    })),
    mcpServers: (workflow.mcpServers || []).slice(0, 6).map((server) => ({
      name: redactText(server.name, 120, tracker),
      transport: redactText(server.transport, 40, tracker),
      description: redactText(server.description, 280, tracker),
      capabilities: safeList(server.capabilities, 8, 60, tracker),
      authMode: redactText(server.authMode, 60, tracker),
      approvalPolicy: redactText(server.approvalPolicy, 260, tracker),
      riskLevel: server.riskLevel,
    })),
    harnesses: (workflow.harnesses || []).slice(0, 6).map((harness) => ({
      name: redactText(harness.name, 120, tracker),
      type: redactText(harness.type, 60, tracker),
      description: redactText(harness.description, 280, tracker),
      runsWhen: redactText(harness.runsWhen, 220, tracker),
      passCriteria: redactText(harness.passCriteria, 260, tracker),
    })),
  };

  const runSteps: PublicRunReceiptStep[] = transcript.steps.slice(0, MAX_PUBLIC_STEPS).map((step, index) => {
    const omitted = omittedSet.has(index);
    const sourceIdsBefore = tracker["source-id"] || 0;
    const credentialsBefore = tracker.credential || 0;
    const output = omitted ? "" : redactText(step.output, MAX_STEP_OUTPUT_CHARS, tracker);
    if (!omitted && ((tracker["source-id"] || 0) > sourceIdsBefore || (tracker.credential || 0) > credentialsBefore)) {
      sensitiveStepOutputs.push(index);
    }
    const status: PublicRunReceiptStep["status"] = step.handoff?.status === "held" || (step.gated && step.approved === false)
      ? "held"
      : output ? "completed" : "halted";
    return {
      index: index + 1,
      title: redactText(step.title, 120, tracker),
      actor: redactText(step.actor, 100, tracker),
      model: redactText(step.model, 100, tracker),
      status,
      gated: Boolean(step.gated),
      ...(typeof step.approved === "boolean" ? { approved: step.approved } : {}),
      toolNames: safeList(step.liveTools, 8, 100, tracker),
      ...(step.handoff ? {
        handoff: {
          mode: step.handoff.mode,
          status: step.handoff.status,
          toActor: redactText(step.handoff.toActor, 100, tracker),
          ...(step.handoff.condition ? { condition: redactText(step.handoff.condition, 240, tracker) } : {}),
        },
      } : {}),
      ...(step.browserProofs?.length ? {
        browserProofs: step.browserProofs.slice(0, 4).map((proof) => ({
          mode: proof.mode === "write" ? "write" as const : "read" as const,
          evidenceTypes: Array.from(new Set(proof.evidence.map((item) => item.type))).slice(0, 2),
          attempts: boundedNumber(proof.attempts, 3),
          events: proof.events.slice(0, 40).map((event) => ({
            action: redactText(event.action, 40, tracker),
            status: event.status === "retry" ? "retry" as const : "completed" as const,
          })),
        })),
      } : {}),
      ...(step.actionProofs?.length ? {
        actionProofs: step.actionProofs.slice(0, 6).map((proof) => ({
          connectorId: proof.connectorId,
          operation: redactText(proof.operation, 160, tracker),
          evidenceTypes: Array.from(new Set(proof.evidence.map((item) => item.type))).slice(0, 5),
        })),
      } : {}),
      ...(omitted || !output ? { outputOmitted: true as const } : { output }),
    };
  });
  if (transcript.steps.length > MAX_PUBLIC_STEPS) increment(tracker, "truncated");
  const timing = normalizeAgentRunTiming(transcript);
  const contextProvenance = options.context
    ? publicContextProvenance(options.context.provenance)
    : undefined;
  const publicContext = options.context ? {
    teammates: boundedNumber(options.context.teammateCount, 16),
    skills: boundedNumber(options.context.skillCount, 32),
    memories: {
      count: boundedNumber(options.context.memoryCount, 8),
      categories: Array.from(new Set(
        (Array.isArray(options.context.memoryCategories) ? options.context.memoryCategories : [])
          .filter((category): category is PublicRunReceiptMemoryCategory => PUBLIC_MEMORY_CATEGORIES.has(category as PublicRunReceiptMemoryCategory)),
      )).slice(0, 6),
    },
    rubrics: boundedNumber(options.context.rubricCount, 8),
    ...(contextProvenance ? { provenance: contextProvenance } : {}),
  } satisfies PublicRunReceiptContext : undefined;

  const receipt: PublicRunReceipt = {
    version: RUN_RECEIPT_VERSION,
    title: publicWorkflow.title || "Agent workflow proof",
    summary: publicWorkflow.description || publicWorkflow.goal || "A redacted Codelit agent workflow run.",
    workflow: publicWorkflow,
    run: {
      mode: transcript.executionMode,
      fundingSources: Array.from(new Set(transcript.fundingSources)).slice(0, 3),
      status: transcript.status,
      ...timing,
      stepCount: runSteps.length,
      steps: runSteps,
      ...(transcript.managedUsage?.status === "settled" ? {
        usage: {
          modelUsd: Number(Math.min(10, Math.max(0, transcript.managedUsage.model.settledUsd)).toFixed(6)),
          browserMinutes: Number(Math.min(600, Math.max(0, transcript.managedUsage.browser.settledMinutes)).toFixed(2)),
          basis: transcript.managedUsage.model.basis,
          status: transcript.managedUsage.status,
        },
      } : {}),
    },
    ...(publicContext ? { context: publicContext } : {}),
    ...(transcript.failureLab ? {
      failureLab: {
        score: boundedNumber(transcript.failureLab.score, 100),
        totals: {
          passed: boundedNumber(transcript.failureLab.totals.passed, 9),
          failed: boundedNumber(transcript.failureLab.totals.failed, 9),
          untested: boundedNumber(transcript.failureLab.totals.untested, 9),
          notApplicable: boundedNumber(transcript.failureLab.totals.notApplicable, 9),
          contained: boundedNumber(transcript.failureLab.totals.contained, 9),
        },
        scenarios: transcript.failureLab.results.slice(0, 9).map((result) => ({
          id: result.id,
          label: redactText(result.label, 80, tracker),
          status: result.status,
        })),
      },
    } : {}),
  };
  const validation = validatePublicRunReceipt(receipt);
  if (!validation.ok) throw new RunReceiptError("invalid-receipt", validation.errors.join("; "));
  const publicBytes = utf8Bytes(receipt);
  if (publicBytes > MAX_RUN_RECEIPT_BYTES) throw new RunReceiptError("receipt-too-large", "Redacted receipt exceeds the public document limit");
  return { receipt, report: { originalBytes, publicBytes, removed: tracker, omittedStepOutputs, sensitiveStepOutputs } };
}

const MODES = new Set<AgentRunMode>(["sample", "dry", "in-tab-byok", "local-lite", "device-local", "managed-interactive", "hosted"]);
const FUNDING = new Set<AgentRunFundingSource>(["none", "user-key", "user-device", "codelit-free", "codelit-model", "codelit-browser"]);
const RISK = new Set<AgentRiskLevel>(["low", "medium", "high"]);
const TOOL_TYPES = new Set<AgentToolType>(["communication", "repo", "ticketing", "knowledge", "database", "browser", "runtime", "custom"]);
const FAILURE_IDS = new Set<FailureScenarioId>(["timeout", "rate-limit", "malformed-response", "missing-auth", "prompt-injection", "held-approval", "expired-approval", "cost-cap", "partial-failure"]);
const FAILURE_STATUSES = new Set<FailureLabStatus>(["passed", "failed", "untested", "not-applicable"]);
const HANDOFF_MODES = new Set<AgentHandoffMode>(["always-next", "when-needed", "needs-approval"]);
const HANDOFF_STATUSES = new Set(["completed", "skipped", "held"]);
const BROWSER_EVIDENCE_TYPES = new Set(["dom", "screenshot"]);
const BROWSER_EVENT_STATUSES = new Set(["completed", "retry"]);
const ACTION_EVIDENCE_TYPES = new Set<AgentActionEvidenceType>(["provider-url", "audit", "dom", "screenshot", "receipt"]);
const USAGE_BASES = new Set(["provider-reported-cost", "provider-token-counts", "estimated-token-counts", "workflow-estimate", "mixed", "unavailable"]);
const PUBLIC_MEMORY_CATEGORIES = new Set<PublicRunReceiptMemoryCategory>(["fact", "decision", "preference", "procedure", "lesson", "reference"]);

function validString(value: unknown, max: number, required = true) {
  return typeof value === "string" && value.length <= max && (!required || Boolean(value.trim()));
}

function validStringList(value: unknown, maxItems: number, maxChars: number) {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => validString(item, maxChars));
}

function arrayOrEmpty<T>(value: T[] | undefined) {
  return Array.isArray(value) ? value : [];
}

export function validatePublicRunReceipt(value: unknown): { ok: boolean; errors: string[]; receipt?: PublicRunReceipt } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["Receipt must be an object"] };
  const receipt = value as Partial<PublicRunReceipt>;
  if (receipt.version !== RUN_RECEIPT_VERSION) errors.push("Unsupported receipt version");
  if (!validString(receipt.title, 140)) errors.push("Invalid receipt title");
  if (!validString(receipt.summary, 500)) errors.push("Invalid receipt summary");
  const workflow = receipt.workflow as Partial<PublicRunReceiptWorkflow> | undefined;
  if (!workflow || typeof workflow !== "object") errors.push("Missing public workflow");
  else {
    if (!validString(workflow.title, 140)) errors.push("Invalid workflow title");
    if (!validString(workflow.description, 500, false)) errors.push("Invalid workflow description");
    if (!validString(workflow.audience, 240, false)) errors.push("Invalid workflow audience");
    if (!validString(workflow.goal, 300, false)) errors.push("Invalid workflow goal");
    if (workflow.triggers !== undefined && (!Array.isArray(workflow.triggers) || workflow.triggers.length > 4 || workflow.triggers.some((trigger) => (
      !validString(trigger?.name, 100) || !validString(trigger?.source, 80, false) || !validString(trigger?.event, 120, false) || !validString(trigger?.description, 240, false)
    )))) errors.push("Invalid workflow triggers");
    if (!Array.isArray(workflow.steps) || workflow.steps.length > MAX_PUBLIC_STEPS || workflow.steps.some((step) => (
      !validString(step?.title, 120) || !validString(step?.actorName, 100) || !validString(step?.action, 300, false)
      || !validString(step?.onSuccess, 240, false) || !validString(step?.onFailure, 240, false)
      || (step.handoffMode !== undefined && !HANDOFF_MODES.has(step.handoffMode))
      || (step.handoffCondition !== undefined && !validString(step.handoffCondition, 240, false))
    ))) errors.push("Invalid workflow steps");
    if (!Array.isArray(workflow.tools) || workflow.tools.length > 12 || workflow.tools.some((tool) => (
      !validString(tool?.name, 100) || !TOOL_TYPES.has(tool?.type) || !validString(tool?.description, 260, false)
      || !validString(tool?.authMode, 60, false) || !RISK.has(tool?.riskLevel)
    ))) errors.push("Invalid workflow tools");
    if (!Array.isArray(workflow.agents) || workflow.agents.length > 8 || workflow.agents.some((agent) => (
      !validString(agent?.name, 100) || !validString(agent?.role, 280, false)
      || !validStringList(agent?.responsibilities, 8, 180) || !validString(agent?.input, 240, false)
      || !validString(agent?.output, 240, false) || !validStringList(agent?.toolNames, 12, 100)
      || !validString(agent?.modelPreference, 120, false) || !validString(agent?.escalationPolicy, 280, false)
    ))) errors.push("Invalid workflow agents");
    if (workflow.modelRoutes !== undefined && (!Array.isArray(workflow.modelRoutes) || workflow.modelRoutes.length > 8 || workflow.modelRoutes.some((route) => (
      !validString(route?.task, 120) || !validString(route?.provider, 80, false) || !validString(route?.model, 100, false)
      || !validString(route?.reason, 220, false) || !validString(route?.fallback, 100, false)
    )))) errors.push("Invalid workflow model routes");
    if (workflow.guardrails !== undefined && (!Array.isArray(workflow.guardrails) || workflow.guardrails.length > 10 || workflow.guardrails.some((guardrail) => (
      !validString(guardrail?.title, 120) || !validString(guardrail?.policy, 320, false) || !RISK.has(guardrail?.severity)
    )))) errors.push("Invalid workflow guardrails");
    if (workflow.evaluations !== undefined && (!Array.isArray(workflow.evaluations) || workflow.evaluations.length > 10 || workflow.evaluations.some((evaluation) => (
      !validString(evaluation?.title, 120) || !validString(evaluation?.metric, 240, false) || !validString(evaluation?.threshold, 160, false)
    )))) errors.push("Invalid workflow evaluations");
    if (workflow.skills !== undefined && (!Array.isArray(workflow.skills) || workflow.skills.length > 8 || workflow.skills.some((skill) => (
      !validString(skill?.name, 120) || !validString(skill?.kind, 60, false) || !validString(skill?.description, 280, false)
      || !validString(skill?.activation, 220, false) || !validString(skill?.instructions, 420, false) || !RISK.has(skill?.riskLevel)
    )))) errors.push("Invalid workflow skills");
    if (workflow.mcpServers !== undefined && (!Array.isArray(workflow.mcpServers) || workflow.mcpServers.length > 6 || workflow.mcpServers.some((server) => (
      !validString(server?.name, 120) || !validString(server?.transport, 40, false) || !validString(server?.description, 280, false)
      || !validStringList(server?.capabilities, 8, 60) || !validString(server?.authMode, 60, false)
      || !validString(server?.approvalPolicy, 260, false) || !RISK.has(server?.riskLevel)
    )))) errors.push("Invalid workflow MCP servers");
    if (workflow.harnesses !== undefined && (!Array.isArray(workflow.harnesses) || workflow.harnesses.length > 6 || workflow.harnesses.some((harness) => (
      !validString(harness?.name, 120) || !validString(harness?.type, 60, false) || !validString(harness?.description, 280, false)
      || !validString(harness?.runsWhen, 220, false) || !validString(harness?.passCriteria, 260, false)
    )))) errors.push("Invalid workflow harnesses");
  }
  const run = receipt.run as Partial<PublicRunReceipt["run"]> | undefined;
  if (!run || typeof run !== "object") errors.push("Missing public run");
  else {
    if (!run.mode || !MODES.has(run.mode)) errors.push("Invalid run mode");
    if (!Array.isArray(run.fundingSources) || run.fundingSources.length > 3 || run.fundingSources.some((source) => !FUNDING.has(source))) errors.push("Invalid funding sources");
    if (run.status !== "completed" && run.status !== "halted") errors.push("Invalid run status");
    if (typeof run.durationMs !== "number" || !Number.isInteger(run.durationMs) || run.durationMs < 0 || run.durationMs > 8 * 24 * 60 * 60 * 1000) errors.push("Invalid run duration");
    if (run.activeDurationMs !== undefined && (!Number.isInteger(run.activeDurationMs) || run.activeDurationMs < 0 || run.activeDurationMs > 24 * 60 * 60 * 1000)) errors.push("Invalid active run duration");
    if (run.approvalWaitMs !== undefined && (!Number.isInteger(run.approvalWaitMs) || run.approvalWaitMs < 0 || run.approvalWaitMs > 7 * 24 * 60 * 60 * 1000)) errors.push("Invalid approval wait duration");
    if (run.activeDurationMs !== undefined && run.approvalWaitMs !== undefined && run.activeDurationMs + run.approvalWaitMs !== run.durationMs) errors.push("Inconsistent run duration");
    if (run.usage !== undefined && (
      !run.usage || typeof run.usage !== "object"
      || typeof run.usage.modelUsd !== "number" || !Number.isFinite(run.usage.modelUsd) || run.usage.modelUsd < 0 || run.usage.modelUsd > 10
      || typeof run.usage.browserMinutes !== "number" || !Number.isFinite(run.usage.browserMinutes) || run.usage.browserMinutes < 0 || run.usage.browserMinutes > 600
      || !USAGE_BASES.has(run.usage.basis)
      || (run.usage.status !== "settled" && run.usage.status !== "pending")
    )) errors.push("Invalid run usage");
    if (!Array.isArray(run.steps) || run.steps.length > MAX_PUBLIC_STEPS || run.steps.some((step, index) => (
      !Number.isInteger(step?.index) || step?.index !== index + 1
      || !validString(step?.title, 120) || !validString(step?.actor, 100) || !validString(step?.model, 100)
      || !["completed", "held", "halted"].includes(step?.status) || (step?.output !== undefined && !validString(step.output, MAX_STEP_OUTPUT_CHARS, false))
      || (step?.gated !== undefined && typeof step.gated !== "boolean") || (step?.approved !== undefined && typeof step.approved !== "boolean")
      || (step?.toolNames !== undefined && !validStringList(step.toolNames, 12, 100)) || (step?.outputOmitted !== undefined && step.outputOmitted !== true)
      || (step?.output !== undefined && step?.outputOmitted === true)
      || (step?.handoff !== undefined && (!HANDOFF_MODES.has(step.handoff.mode) || !HANDOFF_STATUSES.has(step.handoff.status) || !validString(step.handoff.toActor, 100) || (step.handoff.condition !== undefined && !validString(step.handoff.condition, 240, false))))
      || (step?.browserProofs !== undefined && (!Array.isArray(step.browserProofs) || step.browserProofs.length > 4 || step.browserProofs.some((proof) => (
        (proof.mode !== "read" && proof.mode !== "write") || !Array.isArray(proof.evidenceTypes) || proof.evidenceTypes.length > 2 || proof.evidenceTypes.some((type) => !BROWSER_EVIDENCE_TYPES.has(type))
        || !Number.isInteger(proof.attempts) || proof.attempts < 0 || proof.attempts > 3 || !Array.isArray(proof.events) || proof.events.length > 40
        || proof.events.some((event) => !validString(event.action, 40) || !BROWSER_EVENT_STATUSES.has(event.status))
      ))))
      || (step?.actionProofs !== undefined && (!Array.isArray(step.actionProofs) || step.actionProofs.length > 6 || step.actionProofs.some((proof) => (
        !isLiveRunActionProviderId(proof.connectorId) || !validString(proof.operation, 160) || !Array.isArray(proof.evidenceTypes)
        || proof.evidenceTypes.length > 5 || proof.evidenceTypes.some((type) => !ACTION_EVIDENCE_TYPES.has(type))
      ))))
    ))) errors.push("Invalid run steps");
    if (run.stepCount !== undefined && (!Number.isInteger(run.stepCount) || Number(run.stepCount) < 0 || Number(run.stepCount) > MAX_PUBLIC_STEPS || (Array.isArray(run.steps) && run.stepCount !== run.steps.length))) {
      errors.push("Invalid run step count");
    }
  }
  const failureLab = receipt.failureLab;
  if (failureLab !== undefined) {
    const totals = failureLab?.totals;
    const validCount = (count: unknown) => Number.isInteger(count) && Number(count) >= 0 && Number(count) <= 9;
    const validTotals = totals && validCount(totals.passed) && validCount(totals.failed) && validCount(totals.untested)
      && validCount(totals.notApplicable) && validCount(totals.contained);
    const validScenarios = Array.isArray(failureLab?.scenarios) && failureLab.scenarios.length <= 9
      && failureLab.scenarios.every((scenario) => FAILURE_IDS.has(scenario?.id) && validString(scenario?.label, 80) && FAILURE_STATUSES.has(scenario?.status));
    if (!Number.isInteger(failureLab?.score) || Number(failureLab?.score) < 0 || Number(failureLab?.score) > 100 || !validTotals || !validScenarios) {
      errors.push("Invalid Failure Lab proof");
    }
  }
  const context = receipt.context;
  if (context !== undefined) {
    const validCount = (value: unknown, max: number) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max;
    if (
      !context
      || typeof context !== "object"
      || !validCount(context.teammates, 16)
      || !validCount(context.skills, 32)
      || !validCount(context.rubrics, 8)
      || !context.memories
      || typeof context.memories !== "object"
      || !validCount(context.memories.count, 8)
      || !Array.isArray(context.memories.categories)
      || context.memories.categories.length > 6
      || context.memories.categories.length > Number(context.memories.count)
      || new Set(context.memories.categories).size !== context.memories.categories.length
      || context.memories.categories.some((category) => !PUBLIC_MEMORY_CATEGORIES.has(category))
      || (context.provenance !== undefined && (
        !context.provenance
        || typeof context.provenance !== "object"
        || context.provenance.source !== "compiled-snapshot"
        || (context.provenance.compatibilityMode !== "embedded" && context.provenance.compatibilityMode !== "library-pinned")
        || !/^sha256:[a-f0-9]{64}$/.test(context.provenance.commitment)
        || (context.provenance.compatibilityMode === "embedded"
          && context.teammates + context.skills + context.memories.count + context.rubrics !== 0)
        || (context.provenance.compatibilityMode === "library-pinned"
          && context.teammates + context.skills + context.memories.count + context.rubrics === 0)
      ))
    ) {
      errors.push("Invalid public context");
    }
  }
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_RUN_RECEIPT_BYTES) errors.push("Receipt exceeds the public document limit");
  if (/https?:\/\//i.test(serialized)
    || /-----BEGIN [A-Z ]+PRIVATE KEY-----/i.test(serialized)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(serialized)
    || /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/.test(serialized)
    || /\bglpat-[A-Za-z0-9_-]{12,}\b/i.test(serialized)
    || /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i.test(serialized)
    || /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|secret)\s*[:=]\s*[^\s,;]{6,}/i.test(serialized)) errors.push("Receipt contains unsafe public text");
  if (errors.length || !workflow || !run || !Array.isArray(run.steps)) return { ok: false, errors };
  const typedWorkflow = workflow as PublicRunReceiptWorkflow;
  const typedRun = run as PublicRunReceipt["run"];
  const normalizedSteps: PublicRunReceiptStep[] = typedRun.steps.map((step) => ({
    index: step.index,
    title: step.title,
    actor: step.actor,
    model: step.model,
    status: step.status,
    gated: typeof step.gated === "boolean" ? step.gated : false,
    ...(typeof step.approved === "boolean" ? { approved: step.approved } : {}),
    toolNames: Array.isArray(step.toolNames) ? [...step.toolNames] : [],
    ...(step.output !== undefined ? { output: step.output } : { outputOmitted: true as const }),
    ...(step.handoff ? {
      handoff: {
        mode: step.handoff.mode,
        status: step.handoff.status,
        toActor: step.handoff.toActor,
        ...(step.handoff.condition !== undefined ? { condition: step.handoff.condition } : {}),
      },
    } : {}),
    ...(step.browserProofs ? {
      browserProofs: step.browserProofs.map((proof) => ({
        mode: proof.mode,
        evidenceTypes: [...proof.evidenceTypes],
        attempts: proof.attempts,
        events: proof.events.map((event) => ({ action: event.action, status: event.status })),
      })),
    } : {}),
    ...(step.actionProofs ? {
      actionProofs: step.actionProofs.map((proof) => ({
        connectorId: proof.connectorId,
        operation: proof.operation,
        evidenceTypes: [...proof.evidenceTypes],
      })),
    } : {}),
  }));
  const normalized: PublicRunReceipt = {
    version: RUN_RECEIPT_VERSION,
    title: receipt.title as string,
    summary: receipt.summary as string,
    workflow: {
      title: typedWorkflow.title,
      description: typedWorkflow.description,
      audience: typedWorkflow.audience,
      goal: typedWorkflow.goal,
      triggers: arrayOrEmpty(workflow.triggers).map((trigger) => ({ name: trigger.name, source: trigger.source, event: trigger.event, description: trigger.description })),
      tools: typedWorkflow.tools.map((tool) => ({ name: tool.name, type: tool.type, description: tool.description, authMode: tool.authMode, riskLevel: tool.riskLevel })),
      agents: typedWorkflow.agents.map((agent) => ({
        name: agent.name,
        role: agent.role,
        responsibilities: [...agent.responsibilities],
        input: agent.input,
        output: agent.output,
        toolNames: [...agent.toolNames],
        modelPreference: agent.modelPreference,
        escalationPolicy: agent.escalationPolicy,
      })),
      steps: typedWorkflow.steps.map((step) => ({
        title: step.title,
        actorName: step.actorName,
        action: step.action,
        onSuccess: step.onSuccess,
        onFailure: step.onFailure,
        ...(step.handoffMode !== undefined ? { handoffMode: step.handoffMode } : {}),
        ...(step.handoffCondition !== undefined ? { handoffCondition: step.handoffCondition } : {}),
      })),
      modelRoutes: arrayOrEmpty(workflow.modelRoutes).map((route) => ({ task: route.task, provider: route.provider, model: route.model, reason: route.reason, fallback: route.fallback })),
      guardrails: arrayOrEmpty(workflow.guardrails).map((guardrail) => ({ title: guardrail.title, policy: guardrail.policy, severity: guardrail.severity })),
      evaluations: arrayOrEmpty(workflow.evaluations).map((evaluation) => ({ title: evaluation.title, metric: evaluation.metric, threshold: evaluation.threshold })),
      skills: arrayOrEmpty(workflow.skills).map((skill) => ({ name: skill.name, kind: skill.kind, description: skill.description, activation: skill.activation, instructions: skill.instructions, riskLevel: skill.riskLevel })),
      mcpServers: arrayOrEmpty(workflow.mcpServers).map((server) => ({
        name: server.name,
        transport: server.transport,
        description: server.description,
        capabilities: [...server.capabilities],
        authMode: server.authMode,
        approvalPolicy: server.approvalPolicy,
        riskLevel: server.riskLevel,
      })),
      harnesses: arrayOrEmpty(workflow.harnesses).map((harness) => ({ name: harness.name, type: harness.type, description: harness.description, runsWhen: harness.runsWhen, passCriteria: harness.passCriteria })),
    },
    run: {
      mode: typedRun.mode,
      fundingSources: [...typedRun.fundingSources],
      status: typedRun.status,
      durationMs: typedRun.durationMs,
      ...(typedRun.activeDurationMs !== undefined ? { activeDurationMs: typedRun.activeDurationMs } : {}),
      ...(typedRun.approvalWaitMs !== undefined ? { approvalWaitMs: typedRun.approvalWaitMs } : {}),
      stepCount: run.stepCount ?? normalizedSteps.length,
      steps: normalizedSteps,
      ...(typedRun.usage ? {
        usage: {
          modelUsd: typedRun.usage.modelUsd,
          browserMinutes: typedRun.usage.browserMinutes,
          basis: typedRun.usage.basis,
          status: typedRun.usage.status,
        },
      } : {}),
    },
    ...(receipt.context ? {
      context: {
        teammates: receipt.context.teammates,
        skills: receipt.context.skills,
        memories: {
          count: receipt.context.memories.count,
          categories: [...receipt.context.memories.categories],
        },
        rubrics: receipt.context.rubrics,
        ...(receipt.context.provenance ? {
          provenance: {
            source: receipt.context.provenance.source,
            compatibilityMode: receipt.context.provenance.compatibilityMode,
            commitment: receipt.context.provenance.commitment,
          },
        } : {}),
      },
    } : {}),
    ...(receipt.failureLab ? {
      failureLab: {
        score: receipt.failureLab.score,
        totals: {
          passed: receipt.failureLab.totals.passed,
          failed: receipt.failureLab.totals.failed,
          untested: receipt.failureLab.totals.untested,
          notApplicable: receipt.failureLab.totals.notApplicable,
          contained: receipt.failureLab.totals.contained,
        },
        scenarios: receipt.failureLab.scenarios.map((scenario) => ({ id: scenario.id, label: scenario.label, status: scenario.status })),
      },
    } : {}),
  };
  return { ok: true, errors: [], receipt: normalized };
}
