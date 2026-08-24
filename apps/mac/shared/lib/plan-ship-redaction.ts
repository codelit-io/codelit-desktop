import type { AgentActionEvidenceType } from "./workflow-actions";
import type { AgentRunFundingSource, AgentRunMode } from "./agent-run-mode";
import type { ManagedRunUsageReceipt } from "./managed-run-usage";
import { createRunReceiptPreview } from "./run-receipt";
import type { AgentHandoffMode, AgentWorkflow } from "../stores/agent-workflow-store";
import type { LiveRunTranscript } from "./agent-live-run";

export interface PlanShipRedactedRunStep {
  id: string;
  title: string;
  actor: string;
  model: string;
  status: "completed" | "held" | "halted";
  output: string;
  outputCharacters: number;
  outputRedacted: true;
  approxUsd: number;
  gated: boolean;
  approved?: boolean;
  liveTools?: string[];
  browserProofs?: Array<{
    mode: "read" | "write";
    evidenceTypes: Array<"dom" | "screenshot">;
    attempts: number;
    events: Array<{ action: string; status: "completed" | "retry" }>;
  }>;
  actionProofs?: Array<{
    connectorId: string;
    operation: string;
    evidenceTypes: AgentActionEvidenceType[];
  }>;
  handoff?: {
    mode: AgentHandoffMode;
    status: "completed" | "skipped" | "held";
    toStepId: string;
    toActor: string;
    condition?: string;
  };
}

export interface PlanShipRedactedRunReceipt {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  activeDurationMs?: number;
  approvalWaitMs?: number;
  executionMode: AgentRunMode;
  fundingSources: AgentRunFundingSource[];
  trigger: string;
  steps: PlanShipRedactedRunStep[];
  totalApproxUsd: number;
  status: "completed" | "halted";
  grounded: boolean;
  failureLab?: ReturnType<typeof createRunReceiptPreview>["receipt"]["failureLab"];
  managedUsage?: Omit<ManagedRunUsageReceipt, "runId">;
  memoryCount?: number;
}

function finiteCost(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Build export-safe evidence through the public receipt scrubber, then retain
 * only bounded facts needed by a generated evaluation fixture. Provider IDs,
 * source URLs, raw grounding labels, run IDs, and model output never leave the
 * private run record.
 */
export function redactPlanShipRunReceipt(
  run: LiveRunTranscript,
  workflow: AgentWorkflow,
): PlanShipRedactedRunReceipt {
  const preview = createRunReceiptPreview(workflow, run, {
    omitStepOutputs: run.steps.map((_, index) => index),
  });
  const receipt = preview.receipt;
  const managedUsage = run.managedUsage
    ? {
        status: run.managedUsage.status,
        model: structuredClone(run.managedUsage.model),
        browser: structuredClone(run.managedUsage.browser),
        ...(run.managedUsage.settledAt ? { settledAt: run.managedUsage.settledAt } : {}),
      }
    : undefined;

  return {
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: Math.max(0, Math.round(run.durationMs)),
    ...(typeof run.activeDurationMs === "number" && Number.isFinite(run.activeDurationMs)
      ? { activeDurationMs: Math.max(0, Math.round(run.activeDurationMs)) }
      : {}),
    ...(typeof run.approvalWaitMs === "number" && Number.isFinite(run.approvalWaitMs)
      ? { approvalWaitMs: Math.max(0, Math.round(run.approvalWaitMs)) }
      : {}),
    executionMode: receipt.run.mode,
    fundingSources: [...receipt.run.fundingSources],
    trigger: receipt.workflow.triggers[0]?.event || "User-approved run",
    steps: receipt.run.steps.map((step, index) => {
      const source = run.steps[index];
      const workflowStep = workflow.steps[index];
      return {
        id: workflowStep?.id || `step-${index + 1}`,
        title: step.title,
        actor: step.actor,
        model: step.model,
        status: step.status,
        output: "[redacted by Codelit]",
        outputCharacters: source?.output.length || 0,
        outputRedacted: true,
        approxUsd: finiteCost(source?.approxUsd),
        gated: step.gated,
        ...(step.approved !== undefined ? { approved: step.approved } : {}),
        ...(step.toolNames.length ? { liveTools: [...step.toolNames] } : {}),
        ...(step.browserProofs?.length ? { browserProofs: structuredClone(step.browserProofs) } : {}),
        ...(step.actionProofs?.length ? { actionProofs: structuredClone(step.actionProofs) } : {}),
        ...(step.handoff ? {
          handoff: {
            mode: step.handoff.mode,
            status: step.handoff.status,
            toStepId: workflow.steps[index + 1]?.id || "complete",
            toActor: step.handoff.toActor,
            ...(step.handoff.condition ? { condition: step.handoff.condition } : {}),
          },
        } : {}),
      } satisfies PlanShipRedactedRunStep;
    }),
    totalApproxUsd: finiteCost(run.totalApproxUsd),
    status: receipt.run.status,
    grounded: Boolean(run.groundedIn),
    ...(receipt.failureLab ? { failureLab: structuredClone(receipt.failureLab) } : {}),
    ...(managedUsage ? { managedUsage: structuredClone(managedUsage) } : {}),
    ...(receipt.context?.memories.count ? { memoryCount: receipt.context.memories.count } : {}),
  };
}
