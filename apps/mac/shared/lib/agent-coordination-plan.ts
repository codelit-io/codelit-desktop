import type { AgentWorkflowAgent, AgentWorkflowStep } from "../stores/agent-workflow-store";

interface CoordinationPlanInput {
  agents: AgentWorkflowAgent[];
  goal: string;
  steps: AgentWorkflowStep[];
}

export function ensureInitialCoordinationPlan({ agents, goal, steps }: CoordinationPlanInput): AgentWorkflowStep[] {
  if (steps.length > 0 || agents.length === 0) return steps;

  const drafts: Omit<AgentWorkflowStep, "next">[] = [
    {
      id: "coordination-intake",
      title: "Understand and route the request",
      actor: agents[0].name,
      action: `Confirm the requested outcome, constraints, and evidence needed${goal ? ` for: ${goal}` : "."}`,
      onSuccess: "Route the scoped work to the first specialist.",
      onFailure: "Ask the user for the missing decision instead of guessing.",
    },
    ...agents.map((agent, index) => ({
      id: `coordination-agent-${index + 1}`,
      title: `${agent.name} completes its assignment`,
      actor: agent.name,
      action: agent.role || agent.responsibilities[0] || "Complete the assigned part of the workflow.",
      onSuccess: agent.output ? `Produce ${agent.output} and hand it to the next owner.` : "Record the result and hand it to the next owner.",
      onFailure: agent.escalationPolicy || "Stop and escalate with the evidence collected so far.",
    })),
    {
      id: "coordination-verify",
      title: "Verify and hand off the result",
      actor: agents.at(-1)?.name || agents[0].name,
      action: "Check the combined result against the goal, approval rules, and required evidence.",
      onSuccess: "Publish the final result with a complete evidence trail.",
      onFailure: "Return the failed check to the responsible specialist without repeating completed work.",
    },
  ];

  return drafts.map((step, index) => ({
    ...step,
    next: drafts[index + 1] ? [drafts[index + 1].id] : [],
    handoffMode: "always-next",
  }));
}
