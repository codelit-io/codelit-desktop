import { calculateAgentReadiness } from "./agent-workflow-export";
import { FAILURE_SCENARIOS, type FailureScenario, type FailureScenarioId } from "./fixtures/failure-scenarios";
import type { LiveRunTranscript } from "./agent-live-run";
import type { AgentWorkflow, AgentWorkflowStep, AgentWorkflowTool } from "../stores/agent-workflow-store";

export type FailureLabStatus = "passed" | "failed" | "untested" | "not-applicable";

export interface FailureLabResult {
  id: FailureScenarioId;
  label: string;
  status: FailureLabStatus;
  expectedTerminal: FailureScenario["expectedTerminal"];
  expectedContainment: string;
  observedContainment: string;
  stepIds: string[];
  toolIds: string[];
  fixCheckId?: FailureScenario["fixCheckId"];
}

export interface FailureLabScorecard {
  version: 1;
  results: FailureLabResult[];
  score: number;
  totals: {
    passed: number;
    failed: number;
    untested: number;
    notApplicable: number;
    contained: number;
  };
  networkCalls: 0;
  providerCalls: 0;
  connectorCalls: 0;
  browserCalls: 0;
}

interface FailureTarget {
  steps: AgentWorkflowStep[];
  tools: AgentWorkflowTool[];
}

function toolsForStep(workflow: AgentWorkflow, step: AgentWorkflowStep) {
  const actor = workflow.agents.find((agent) => agent.id === step.actor || agent.name.toLowerCase() === step.actor.toLowerCase());
  const ids = new Set(actor?.tools || []);
  return workflow.tools.filter((tool) => ids.has(tool.id));
}

function targetForScenario(workflow: AgentWorkflow, scenario: FailureScenario): FailureTarget {
  const steps = workflow.steps;
  if (!steps.length) return { steps: [], tools: [] };
  if (scenario.requirement === "tool") {
    if (scenario.id === "missing-auth") {
      const tool = workflow.tools.find((candidate) => candidate.authMode !== "none");
      if (!tool) return { steps: [steps[0]], tools: [] };
      const step = steps.find((candidate) => toolsForStep(workflow, candidate).some((candidateTool) => candidateTool.id === tool.id)) || steps[0];
      return { steps: [step], tools: [tool] };
    }
    const step = steps.find((candidate) => toolsForStep(workflow, candidate).length > 0) || steps[0];
    return { steps: [step], tools: toolsForStep(workflow, step).length ? toolsForStep(workflow, step) : workflow.tools.slice(0, 1) };
  }
  if (scenario.requirement === "approval") {
    const step = steps.find((candidate) => toolsForStep(workflow, candidate).some((tool) => tool.riskLevel === "high"))
      || steps.find((candidate) => candidate.actor.toLowerCase().includes("human"));
    const contextualStep = step || steps[0];
    return { steps: [contextualStep], tools: step ? toolsForStep(workflow, step).filter((tool) => tool.riskLevel === "high") : [] };
  }
  if (scenario.requirement === "multi-step") {
    return { steps: steps.length > 1 ? [steps[steps.length - 1]] : [], tools: [] };
  }
  const step = scenario.id === "malformed-response" || scenario.id === "cost-cap" ? steps[steps.length - 1] : steps[0];
  return { steps: [step], tools: toolsForStep(workflow, step) };
}

function hasFailurePath(target: FailureTarget) {
  return target.steps.length > 0 && target.steps.every((step) => Boolean(step.onFailure.trim()));
}

function controlText(workflow: AgentWorkflow) {
  return [
    ...workflow.guardrails.flatMap((guardrail) => [guardrail.title, guardrail.policy]),
    ...workflow.evaluations.flatMap((evaluation) => [evaluation.title, evaluation.metric, evaluation.threshold]),
    ...(workflow.harnesses || []).flatMap((harness) => [harness.name, harness.description, harness.passCriteria]),
  ].join(" ").toLowerCase();
}

function statusForScenario(workflow: AgentWorkflow, scenario: FailureScenario, target: FailureTarget): Pick<FailureLabResult, "status" | "observedContainment"> {
  if (!workflow.steps.length) {
    if (["tool", "approval", "model", "multi-step"].includes(scenario.requirement)) {
      const domainExists = scenario.requirement === "tool"
        ? workflow.tools.length > 0
        : scenario.requirement === "model"
          ? workflow.modelRoutes.length > 0
          : scenario.requirement === "multi-step"
            ? workflow.steps.length > 1
            : target.steps.length > 0;
      if (!domainExists) return { status: "not-applicable", observedContainment: "This workflow has no applicable execution surface." };
    }
    return { status: "untested", observedContainment: "Add an executable step before this scenario can be tested." };
  }

  if (scenario.requirement === "tool" && !workflow.tools.length) {
    return { status: "not-applicable", observedContainment: "This workflow has no connected-tool step." };
  }
  if (scenario.id === "missing-auth" && !target.tools.length) {
    return { status: "not-applicable", observedContainment: "This workflow has no tool that requires authorization." };
  }
  const hasApprovalSurface = workflow.tools.some((tool) => tool.riskLevel === "high")
    || workflow.steps.some((step) => step.actor.toLowerCase().includes("human"));
  if (scenario.requirement === "approval" && !hasApprovalSurface) {
    return { status: "not-applicable", observedContainment: "This workflow has no approval-gated step." };
  }
  if (scenario.requirement === "model" && !workflow.modelRoutes.length) {
    return { status: "not-applicable", observedContainment: "This workflow has no model route." };
  }
  if (scenario.requirement === "multi-step" && workflow.steps.length < 2) {
    return { status: "not-applicable", observedContainment: "This workflow does not have a later step to fail." };
  }

  const readiness = calculateAgentReadiness(workflow);
  const readinessPassed = (id: string) => Boolean(readiness.checks.find((check) => check.id === id)?.passed);
  const text = controlText(workflow);
  let passed = hasFailurePath(target);

  if (scenario.id === "rate-limit" || scenario.id === "cost-cap") {
    passed = passed && readinessPassed("models");
  } else if (scenario.id === "malformed-response") {
    passed = passed && readinessPassed("evals");
  } else if (scenario.id === "missing-auth") {
    passed = passed && target.tools.every((tool) => tool.authMode !== "none");
  } else if (scenario.id === "prompt-injection") {
    passed = passed && readinessPassed("evals") && /prompt|injection|untrusted|source content/.test(text);
  } else if (scenario.id === "held-approval" || scenario.id === "expired-approval") {
    passed = passed && readinessPassed("approvals");
  } else if (scenario.id === "partial-failure") {
    passed = passed && workflow.steps.slice(0, -1).every((step) => Boolean(step.onSuccess.trim()));
  }

  return passed
    ? { status: "passed", observedContainment: "Required workflow controls are present; runtime containment has not been executed." }
    : { status: "failed", observedContainment: "Required containment controls are incomplete for the selected target." };
}

export function runFailureLab(workflow: AgentWorkflow): FailureLabScorecard {
  const results = FAILURE_SCENARIOS.map<FailureLabResult>((scenario) => {
    const target = targetForScenario(workflow, scenario);
    const outcome = statusForScenario(workflow, scenario, target);
    return {
      id: scenario.id,
      label: scenario.label,
      status: outcome.status,
      expectedTerminal: scenario.expectedTerminal,
      expectedContainment: scenario.expectedContainment,
      observedContainment: outcome.observedContainment,
      stepIds: target.steps.map((step) => step.id).slice(0, 2),
      toolIds: target.tools.map((tool) => tool.id).slice(0, 2),
      ...(outcome.status === "failed" ? { fixCheckId: scenario.fixCheckId } : {}),
    };
  });
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const untested = results.filter((result) => result.status === "untested").length;
  const notApplicable = results.filter((result) => result.status === "not-applicable").length;
  return {
    version: 1,
    results,
    score: passed + failed ? Math.round((passed / (passed + failed)) * 100) : 0,
    totals: { passed, failed, untested, notApplicable, contained: passed },
    networkCalls: 0,
    providerCalls: 0,
    connectorCalls: 0,
    browserCalls: 0,
  };
}

export function validateFailureLabCorpus(workflow: AgentWorkflow) {
  const errors: string[] = [];
  const scorecard = runFailureLab(workflow);
  for (const result of scorecard.results) {
    if (result.stepIds.length + result.toolIds.length === 0) errors.push(`${result.id}: no workflow target`);
    if (result.status === "untested") errors.push(`${result.id}: scenario is untested`);
  }
  return errors;
}

export function createFailureLabTranscript(workflow: AgentWorkflow, scorecard = runFailureLab(workflow)): LiveRunTranscript {
  const timestamp = new Date(0).toISOString();
  return {
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    executionMode: "sample",
    fundingSources: ["none"],
    trigger: "Failure Lab deterministic static readiness analysis",
    steps: scorecard.results.map((result) => ({
      id: `failure-lab-${result.id}`,
      title: result.label,
      actor: "Failure Lab",
      model: "Deterministic static check",
      output: `${result.status}. ${result.expectedTerminal}.`,
      approxUsd: 0,
      gated: result.id === "held-approval" || result.id === "expired-approval",
    })),
    totalApproxUsd: 0,
    status: "completed",
    failureLab: scorecard,
  };
}
