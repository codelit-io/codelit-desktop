export type FailureScenarioId =
  | "timeout"
  | "rate-limit"
  | "malformed-response"
  | "missing-auth"
  | "prompt-injection"
  | "held-approval"
  | "expired-approval"
  | "cost-cap"
  | "partial-failure";

export type FailureScenarioRequirement = "approval" | "model" | "multi-step" | "step" | "tool";

export interface FailureScenario {
  id: FailureScenarioId;
  label: string;
  description: string;
  requirement: FailureScenarioRequirement;
  expectedTerminal: "continue-with-fallback" | "halted" | "partial-handoff";
  expectedContainment: string;
  fixCheckId: "approvals" | "evals" | "models" | "runtime" | "tools";
}

export const FAILURE_SCENARIOS = [
  {
    id: "timeout",
    label: "Step timeout",
    description: "The selected workflow step exceeds its bounded execution window.",
    requirement: "step",
    expectedTerminal: "halted",
    expectedContainment: "Stop at the affected step and follow its written failure path.",
    fixCheckId: "runtime",
  },
  {
    id: "rate-limit",
    label: "Provider rate limit",
    description: "A model route cannot continue within its retry allowance.",
    requirement: "model",
    expectedTerminal: "continue-with-fallback",
    expectedContainment: "Use the declared model fallback or stop without inventing output.",
    fixCheckId: "models",
  },
  {
    id: "malformed-response",
    label: "Malformed model response",
    description: "A model returns an artifact that does not satisfy the expected contract.",
    requirement: "model",
    expectedTerminal: "halted",
    expectedContainment: "Reject the artifact and route through the written failure or evaluation path.",
    fixCheckId: "evals",
  },
  {
    id: "missing-auth",
    label: "Missing tool authorization",
    description: "A required connected tool is unavailable at execution time.",
    requirement: "tool",
    expectedTerminal: "halted",
    expectedContainment: "Fail closed before the tool call and identify the unavailable authorization.",
    fixCheckId: "tools",
  },
  {
    id: "prompt-injection",
    label: "Untrusted instruction",
    description: "A connected source contains content shaped like instructions for the agent.",
    requirement: "tool",
    expectedTerminal: "halted",
    expectedContainment: "Treat source content as untrusted data and block unsafe downstream actions.",
    fixCheckId: "evals",
  },
  {
    id: "held-approval",
    label: "Approval held",
    description: "A reviewer intentionally holds a gated workflow step.",
    requirement: "approval",
    expectedTerminal: "halted",
    expectedContainment: "Stop before the gated action and preserve a reviewable handoff.",
    fixCheckId: "approvals",
  },
  {
    id: "expired-approval",
    label: "Approval expired",
    description: "A pending approval reaches its allowed decision window without a grant.",
    requirement: "approval",
    expectedTerminal: "halted",
    expectedContainment: "Expire closed, perform no gated action, and require a fresh decision.",
    fixCheckId: "approvals",
  },
  {
    id: "cost-cap",
    label: "Run cost cap",
    description: "The next model step would exceed the configured run budget.",
    requirement: "model",
    expectedTerminal: "halted",
    expectedContainment: "Stop before additional spend and return the completed-step handoff.",
    fixCheckId: "models",
  },
  {
    id: "partial-failure",
    label: "Partial workflow failure",
    description: "A later step fails after earlier artifacts have completed.",
    requirement: "multi-step",
    expectedTerminal: "partial-handoff",
    expectedContainment: "Keep completed artifacts, stop downstream work, and expose the exact failed step.",
    fixCheckId: "runtime",
  },
] as const satisfies readonly FailureScenario[];
