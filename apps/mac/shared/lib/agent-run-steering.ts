export const AGENT_RUN_STEERING_MAX_CHARS = 600;
export const AGENT_RUN_STEERING_MAX_PENDING = 4;

export type AgentRunSteeringScope = "next-checkpoint";

export interface AgentRunSteeringInstruction {
  id: string;
  instruction: string;
  scope: AgentRunSteeringScope;
  queuedAt: string;
}

export interface AgentRunSteeringQueueResult {
  accepted: boolean;
  instruction?: AgentRunSteeringInstruction;
  reason?: "empty" | "full";
}

export type AgentRunSteeringSubmissionReason =
  | "empty"
  | "full"
  | "inactive"
  | "unsupported"
  | "no-checkpoint";

export interface AgentRunSteeringSubmissionResult {
  accepted: boolean;
  instruction?: AgentRunSteeringInstruction;
  reason?: AgentRunSteeringSubmissionReason;
}

interface AgentRunSteeringRoute {
  mode: "dry" | "sample" | "byok" | "local" | "live";
  status: string;
  stepIndex: number;
}

type AgentRunSteeringSubmitter = (
  instruction: string,
) => AgentRunSteeringSubmissionResult;

function cleanSteeringText(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, AGENT_RUN_STEERING_MAX_CHARS);
}

export function sanitizeAgentRunSteeringInstructions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const instructions: string[] = [];
  for (const candidate of value) {
    const instruction = cleanSteeringText(candidate);
    if (!instruction || seen.has(instruction)) continue;
    seen.add(instruction);
    instructions.push(instruction);
    if (instructions.length >= AGENT_RUN_STEERING_MAX_PENDING) break;
  }
  return instructions;
}

function steeringId() {
  return `steer-${typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
}

export function createAgentRunSteeringInstruction(
  value: unknown,
  now = new Date(),
): AgentRunSteeringInstruction | null {
  const instruction = cleanSteeringText(value);
  if (!instruction) return null;
  return {
    id: steeringId(),
    instruction,
    scope: "next-checkpoint",
    queuedAt: now.toISOString(),
  };
}

export function queueAgentRunSteering(
  queue: AgentRunSteeringInstruction[],
  value: unknown,
  now = new Date(),
): AgentRunSteeringQueueResult {
  const instruction = createAgentRunSteeringInstruction(value, now);
  if (!instruction) return { accepted: false, reason: "empty" };
  if (queue.length >= AGENT_RUN_STEERING_MAX_PENDING) {
    return { accepted: false, reason: "full" };
  }
  queue.push(instruction);
  return { accepted: true, instruction };
}

export function routeAgentRunSteering(input: {
  instruction: string;
  run: AgentRunSteeringRoute | null;
  stepCount: number;
  currentCheckpoint?: boolean;
  routes: {
    byok: AgentRunSteeringSubmitter;
    local: AgentRunSteeringSubmitter;
    managed: AgentRunSteeringSubmitter;
  };
}): AgentRunSteeringSubmissionResult {
  const { instruction, run, stepCount, routes } = input;
  if (!run || run.status === "done" || run.status === "halted") {
    return { accepted: false, reason: "inactive" };
  }
  if (run.mode === "dry" || run.mode === "sample") {
    return { accepted: false, reason: "unsupported" };
  }
  if (run.stepIndex >= stepCount - 1 && !input.currentCheckpoint) {
    return { accepted: false, reason: "no-checkpoint" };
  }
  if (run.mode === "byok") return routes.byok(instruction);
  if (run.mode === "local") return routes.local(instruction);
  return routes.managed(instruction);
}

export function drainAgentRunSteering(
  queue: AgentRunSteeringInstruction[],
): AgentRunSteeringInstruction[] {
  return queue.splice(0, AGENT_RUN_STEERING_MAX_PENDING);
}

export function isAgentRunStatusQuestion(value: string) {
  const text = cleanSteeringText(value).toLowerCase();
  if (!text) return false;
  const asksForChange = /^(?:can|could|would|will) you\b.*\b(?:add|change|check|focus|ignore|limit|only|prioritize|remove|retry|skip|stop|use)\b/.test(text);
  if (asksForChange) return false;
  if (text.endsWith("?")) return true;
  if (/^(?:what|why|how|when|where|which|who|is|are|can|could|did|does|do|has|have)\b/.test(text)) return true;
  if (/^(?:status|progress)\b/.test(text)) return true;
  return /^(?:show|tell|explain)\b/.test(text)
    && /\b(?:active|completed|current|done|finished|happening|next|progress|status|step|waiting)\b/.test(text);
}

export function isAgentRunReviewQuestion(value: string) {
  const text = cleanSteeringText(value).toLowerCase();
  if (!isAgentRunStatusQuestion(text)) return false;
  return /\b(?:run|attempt|happened|preserved|completed|done|finished|fail|failed|failure|stopped|blocked|cost|charged|receipt|evidence|changed|next|retry)\b/.test(text);
}

export function agentRunSteeringPrompt(
  instructions: readonly AgentRunSteeringInstruction[],
) {
  const values = instructions
    .slice(0, AGENT_RUN_STEERING_MAX_PENDING)
    .map((item) => cleanSteeringText(item.instruction))
    .filter(Boolean);
  if (!values.length) return "";
  return [
    "The user added bounded steering at the latest safe checkpoint.",
    "Apply it to this step only where it stays within the Team's existing tools, permissions, approvals, and goal:",
    ...values.map((instruction) => `- ${instruction}`),
    "Do not broaden access, skip an approval, or repeat an external write.",
  ].join("\n");
}
