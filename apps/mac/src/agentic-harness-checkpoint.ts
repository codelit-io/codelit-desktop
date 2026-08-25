export const AGENTIC_READ_TOOLS = [
  "read_project_overview",
  "list_selected_folder",
  "list_local_tables",
  "list_local_routines",
  "list_connected_tools",
] as const;

export type AgenticReadTool = typeof AGENTIC_READ_TOOLS[number];

export interface AgenticReadToolResult {
  context: string[];
  completedTools: Array<{ toolId: string; toolName: string }>;
}

export interface AgenticHarnessCheckpoint {
  schemaVersion: 1;
  observations: string[];
  completedTools: AgenticReadToolResult["completedTools"];
  toolCalls: AgenticReadTool[];
  nativeCalls: string[];
  mcpCalls: string[];
  actionCount: number;
  modelTurns: number;
  recoveryAttempts: number;
}

export const MAX_HARNESS_ACTIONS = 8;
export const MAX_HARNESS_MODEL_TURNS = 24;
export const MAX_RECOVERY_ATTEMPTS = 2;
export const MAX_HARNESS_OBSERVATION_CHARS = 3_600;
const MAX_COMPLETED_TOOLS = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReadTool(value: unknown): value is AgenticReadTool {
  return typeof value === "string" && AGENTIC_READ_TOOLS.some((tool) => tool === value);
}

export function boundedHarnessObservations(observations: string[]) {
  let remaining = MAX_HARNESS_OBSERVATION_CHARS;
  return observations.flatMap((observation) => {
    if (remaining <= 0) return [];
    const bounded = observation.slice(0, remaining);
    remaining -= bounded.length;
    return bounded ? [bounded] : [];
  });
}

export function boundedHarnessCompletedTools(
  tools: AgenticReadToolResult["completedTools"],
): AgenticReadToolResult["completedTools"] {
  const seen = new Set<string>();
  return tools.flatMap((tool) => {
    const toolId = tool.toolId.trim().slice(0, 160);
    const toolName = tool.toolName.trim().slice(0, 160);
    if (!toolId || !toolName || seen.has(toolId)) return [];
    seen.add(toolId);
    return [{ toolId, toolName }];
  }).slice(0, MAX_COMPLETED_TOOLS);
}

export function emptyAgenticHarnessCheckpoint(): AgenticHarnessCheckpoint {
  return {
    schemaVersion: 1,
    observations: [],
    completedTools: [],
    toolCalls: [],
    nativeCalls: [],
    mcpCalls: [],
    actionCount: 0,
    modelTurns: 0,
    recoveryAttempts: 0,
  };
}

export function normalizeAgenticHarnessCheckpoint(value: unknown): AgenticHarnessCheckpoint | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.observations)
    || !Array.isArray(value.completedTools)
    || !Array.isArray(value.toolCalls)
    || (value.nativeCalls !== undefined && !Array.isArray(value.nativeCalls))
    || !Array.isArray(value.mcpCalls)
    || !Number.isInteger(value.actionCount)
    || Number(value.actionCount) < 0
    || Number(value.actionCount) > MAX_HARNESS_ACTIONS
    || !Number.isInteger(value.modelTurns)
    || Number(value.modelTurns) < 0
    || Number(value.modelTurns) > MAX_HARNESS_MODEL_TURNS
    || !Number.isInteger(value.recoveryAttempts)
    || Number(value.recoveryAttempts) < 0
    || Number(value.recoveryAttempts) > MAX_RECOVERY_ATTEMPTS) return null;

  const observations = value.observations.filter((item): item is string => (
    typeof item === "string" && item.length > 0 && item.length <= MAX_HARNESS_OBSERVATION_CHARS
  ));
  const completedTools = value.completedTools.flatMap((item): AgenticReadToolResult["completedTools"] => (
    isRecord(item)
      && typeof item.toolId === "string"
      && item.toolId.length > 0
      && item.toolId.length <= 160
      && typeof item.toolName === "string"
      && item.toolName.length > 0
      && item.toolName.length <= 160
      ? [{ toolId: item.toolId, toolName: item.toolName }]
      : []
  ));
  const toolCalls = value.toolCalls.filter(isReadTool);
  const nativeCalls = (value.nativeCalls || []).filter((name): name is string => (
    typeof name === "string"
    && name.length > 0
    && name.length <= 80
    && /^[a-z][a-z0-9_]*$/.test(name)
  ));
  const mcpCalls = value.mcpCalls.filter((reference): reference is string => (
    typeof reference === "string"
    && reference.length <= 300
    && /^mcp::[^:]+::[^:]+$/.test(reference)
  ));
  if (observations.length !== value.observations.length
    || observations.join("").length > MAX_HARNESS_OBSERVATION_CHARS
    || completedTools.length !== value.completedTools.length
    || completedTools.length > MAX_COMPLETED_TOOLS
    || toolCalls.length !== value.toolCalls.length
    || nativeCalls.length !== (value.nativeCalls || []).length
    || mcpCalls.length !== value.mcpCalls.length
    || new Set(toolCalls).size !== toolCalls.length
    || new Set(nativeCalls).size !== nativeCalls.length
    || new Set(mcpCalls).size !== mcpCalls.length
    || Number(value.actionCount) !== toolCalls.length + nativeCalls.length + mcpCalls.length) return null;

  return {
    schemaVersion: 1,
    observations,
    completedTools,
    toolCalls,
    nativeCalls,
    mcpCalls,
    actionCount: Number(value.actionCount),
    modelTurns: Number(value.modelTurns),
    recoveryAttempts: Number(value.recoveryAttempts),
  };
}

export function resumeAgenticHarnessCheckpoint(
  value: AgenticHarnessCheckpoint,
  completedAction: {
    mcpReference: string;
    context: string[];
    completedTools: AgenticReadToolResult["completedTools"];
  },
): AgenticHarnessCheckpoint {
  const checkpoint = normalizeAgenticHarnessCheckpoint(value);
  if (!checkpoint) throw new Error("The saved agent checkpoint is invalid.");
  if (!/^mcp::[^:]+::[^:]+$/.test(completedAction.mcpReference)
    || checkpoint.mcpCalls.includes(completedAction.mcpReference)) {
    throw new Error("The approved external action does not match the saved agent checkpoint.");
  }
  if (checkpoint.actionCount >= MAX_HARNESS_ACTIONS) {
    throw new Error("This run reached its bounded action limit.");
  }
  return {
    ...checkpoint,
    observations: boundedHarnessObservations([...checkpoint.observations, ...completedAction.context]),
    completedTools: boundedHarnessCompletedTools([...checkpoint.completedTools, ...completedAction.completedTools]),
    mcpCalls: [...checkpoint.mcpCalls, completedAction.mcpReference],
    actionCount: checkpoint.actionCount + 1,
    recoveryAttempts: 0,
  };
}
