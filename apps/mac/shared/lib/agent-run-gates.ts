import type { AgentSimulationStep } from "./agent-workflow-export";

export function isStepGated(step: AgentSimulationStep) {
  return step.gate.toLowerCase().includes("human approval");
}
