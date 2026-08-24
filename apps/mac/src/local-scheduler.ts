import type {
  ClaimedScheduleOccurrence,
  IntelligenceSelection,
  LocalArtifactVersion,
  LocalMcpServer,
  LocalWorkspaceSnapshot,
  ProviderProbe,
  ProviderRunEvent,
} from "./contracts";
import { isProviderId } from "./contracts";
import { isRecord } from "./contracts";
import { readLocalAgentTeamPayload, runLocalAgentTeam } from "./local-agent-team-runtime";
import {
  finishScheduleOccurrence,
  markScheduleOccurrenceRunning,
  recordProviderRun,
  renewScheduleOccurrenceLease,
  runIntelligenceTask,
  scheduleExecutionPermitted,
} from "./runtime";

function pinnedArtifact(claim: ClaimedScheduleOccurrence): LocalArtifactVersion {
  const value = claim.schedule.snapshot;
  if (!isRecord(value)
    || typeof value.artifactKind !== "string"
    || typeof value.artifactTitle !== "string"
    || !("artifactPayload" in value)) {
    throw new Error("This schedule's pinned workflow snapshot is invalid. Edit and save the schedule again.");
  }
  if (!["agent-team", "product-plan", "architecture"].includes(value.artifactKind)) {
    throw new Error("This scheduled artifact type cannot run locally.");
  }
  return {
    artifactId: claim.schedule.artifactId,
    kind: value.artifactKind as LocalArtifactVersion["kind"],
    version: claim.schedule.artifactVersion,
    title: value.artifactTitle,
    projectId: "local-project",
    payload: value.artifactPayload,
    createdAt: claim.scheduledFor,
  };
}

function selectionFor(claim: ClaimedScheduleOccurrence): IntelligenceSelection {
  if (!isProviderId(claim.schedule.provider)) {
    throw new Error("The scheduled model provider is no longer supported.");
  }
  return {
    provider: claim.schedule.provider as IntelligenceSelection["provider"],
    model: claim.schedule.model,
  };
}

function scheduledReviewPrompt(artifact: LocalArtifactVersion) {
  const subject = artifact.kind === "product-plan" ? "Product Plan" : "Architecture";
  const payload = JSON.stringify(artifact.payload).slice(0, 64_000);
  return [
    `Review the pinned ${subject} named ${artifact.title}.`,
    "Return a concise status summary and the most important concrete next checks.",
    "Do not claim that any external action ran. This scheduled review is read-only.",
    payload,
  ].join("\n\n");
}

export interface LocalScheduleExecutionResult {
  snapshot: LocalWorkspaceSnapshot;
  status: "completed" | "approval-required" | "paused" | "failed";
  detail: string;
}

export async function runClaimedLocalSchedule({
  claim,
  snapshot,
  providers,
  mcpServers,
  onSnapshot,
  onEvent,
  onApprovalRequired,
  controller,
}: {
  claim: ClaimedScheduleOccurrence;
  snapshot: LocalWorkspaceSnapshot;
  providers: ProviderProbe[];
  mcpServers: LocalMcpServer[];
  onSnapshot: (snapshot: LocalWorkspaceSnapshot) => void;
  onEvent: (event: ProviderRunEvent) => void;
  onApprovalRequired: (title: string) => void;
  controller: AbortController;
}): Promise<LocalScheduleExecutionResult> {
  const artifact = pinnedArtifact(claim);
  const selection = selectionFor(claim);
  let guardBusy = false;
  let guardFailure: Error | null = null;
  let approvalRequired = false;
  let currentSnapshot = snapshot;

  const guard = async () => {
    if (guardFailure) throw guardFailure;
    const permitted = await scheduleExecutionPermitted(claim.idempotencyKey, claim.claimToken);
    if (!permitted) {
      guardFailure = new Error("This scheduled run stopped because its schedule or background access changed.");
      controller.abort();
      throw guardFailure;
    }
    await renewScheduleOccurrenceLease(claim.idempotencyKey, claim.claimToken);
  };

  await markScheduleOccurrenceRunning(claim.idempotencyKey, claim.claimToken);
  const heartbeat = window.setInterval(() => {
    if (guardBusy || controller.signal.aborted) return;
    guardBusy = true;
    void guard()
      .catch((reason: unknown) => {
        guardFailure = reason instanceof Error ? reason : new Error(String(reason));
        controller.abort();
      })
      .finally(() => {
        guardBusy = false;
      });
  }, 15_000);

  try {
    await guard();
    if (artifact.kind === "agent-team") {
      const team = readLocalAgentTeamPayload(artifact.payload);
      if (!team) {
        throw new Error("This scheduled Agent Team snapshot is invalid. Edit and save the schedule again.");
      }
      const needsProjectFolder = team.agents.some((agent) => agent.tools.some((tool) => {
        if (tool === "Browser read" || tool === "Browser act") return false;
        const server = tool.startsWith("mcp::")
          ? mcpServers.find((candidate) => tool.startsWith(`mcp::${candidate.id}::`))
          : null;
        return server ? server.config.projectAccess : true;
      }));
      if (needsProjectFolder && !currentSnapshot.workspaceFolder?.accessValidated) {
        throw new Error("The scheduled Team is paused until its project folder is selected again.");
      }
      const output = await runLocalAgentTeam({
        snapshot: currentSnapshot,
        artifact,
        title: artifact.title,
        team,
        providers,
        fallbackEngine: selection,
        signal: controller.signal,
        runId: claim.runId,
        executionGuard: guard,
        callbacks: {
          onSnapshot(nextSnapshot) {
            currentSnapshot = nextSnapshot;
            onSnapshot(nextSnapshot);
          },
          onEvent,
          onStepChange() {},
          async awaitApproval(request) {
            approvalRequired = true;
            onApprovalRequired(request.title);
            return "hold";
          },
        },
      });
      currentSnapshot = output.snapshot;
      const status = approvalRequired
        ? "approval-required"
        : output.transcript.status === "completed"
          ? "completed"
          : "failed";
      const detail = approvalRequired
        ? "Approval required before the next local action."
        : output.result.text.slice(0, 500);
      await finishScheduleOccurrence(
        claim.idempotencyKey,
        claim.claimToken,
        status,
        detail,
      );
      return { snapshot: currentSnapshot, status, detail };
    }

    const events: ProviderRunEvent[] = [];
    const result = await runIntelligenceTask(
      selection,
      scheduledReviewPrompt(artifact),
      (event) => {
        events.push(event);
        onEvent(event);
      },
      currentSnapshot.workspaceFolder?.path,
      claim.runId,
    );
    currentSnapshot = await recordProviderRun(
      currentSnapshot,
      artifact.artifactId,
      result,
      events,
      { schemaVersion: 1, scheduledFor: claim.scheduledFor, artifactVersion: artifact.version },
    );
    onSnapshot(currentSnapshot);
    const outcome = result.status === "completed"
      ? "completed"
      : result.status === "quota-hit" || result.status === "signed-out"
        ? "paused"
        : "failed";
    await finishScheduleOccurrence(
      claim.idempotencyKey,
      claim.claimToken,
      outcome,
      result.text.slice(0, 500),
    );
    return {
      snapshot: currentSnapshot,
      status: outcome,
      detail: result.text.slice(0, 500),
    };
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (!guardFailure) {
      await finishScheduleOccurrence(
        claim.idempotencyKey,
        claim.claimToken,
        controller.signal.aborted || /quota|sign.?in|folder|permission/i.test(error.message)
          ? "paused"
          : "failed",
        error.message.slice(0, 500),
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    window.clearInterval(heartbeat);
  }
}
