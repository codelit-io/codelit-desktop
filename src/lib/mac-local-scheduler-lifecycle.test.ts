import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaimedScheduleOccurrence,
  LocalWorkspaceSnapshot,
  ProviderTaskStatus,
} from "../../apps/mac/src/contracts";

const runtime = vi.hoisted(() => ({
  finishScheduleOccurrence: vi.fn(),
  markScheduleOccurrenceRunning: vi.fn(),
  recordProviderRun: vi.fn(),
  renewScheduleOccurrenceLease: vi.fn(),
  runIntelligenceTask: vi.fn(),
  scheduleExecutionPermitted: vi.fn(),
}));
const teamRuntime = vi.hoisted(() => ({
  readLocalAgentTeamPayload: vi.fn(),
  runLocalAgentTeam: vi.fn(),
}));

vi.mock("../../apps/mac/src/runtime", () => runtime);
vi.mock("../../apps/mac/src/local-agent-team-runtime", () => teamRuntime);

import { runClaimedLocalSchedule } from "../../apps/mac/src/local-scheduler";

const createdAt = "2026-08-11T12:00:00.000Z";

function snapshot(folderAccess = true): LocalWorkspaceSnapshot {
  return {
    thread: {
      id: "local-thread",
      ownerUid: "local-device",
      workspaceId: "local-workspace",
      projectId: "local-project",
      title: "Scheduled review",
      status: "idle",
      latestBlockSequence: 0,
      activeArtifactRefs: [],
      createdAt,
      updatedAt: createdAt,
    },
    blocks: [],
    artifacts: [],
    runEvents: [],
    runCheckpoints: [],
    approvals: [],
    receipts: [],
    artifactFiles: [],
    workspaceFolder: {
      path: "/tmp/local-project",
      readOnly: true,
      stale: !folderAccess,
      accessValidated: folderAccess,
      updatedAt: createdAt,
    },
    databasePath: "/tmp/codelit.sqlite3",
  };
}

function claim(kind: "product-plan" | "agent-team" = "product-plan"): ClaimedScheduleOccurrence {
  const payload = kind === "agent-team"
    ? {
        goal: "Inspect one repository.",
        agents: [{ id: "reviewer", name: "Reviewer", role: "Review files", tools: ["Selected folder"] }],
        handoffs: [],
      }
    : { problem: "Review one release", audience: "Product team", outcomes: ["One decision"], milestones: ["Review"] };
  return {
    idempotencyKey: "schedule-1:1:1786460400000",
    claimToken: "claim-token-12345678",
    scheduledFor: "2026-08-11T15:00:00.000Z",
    attempt: 1,
    runId: "scheduled-run-1",
    schedule: {
      id: "schedule-1",
      threadId: "local-thread",
      artifactId: "artifact-1",
      artifactVersion: "version-1",
      title: "Scheduled review",
      enabled: true,
      cadence: "daily",
      localTime: "09:00",
      timezone: "America/Denver",
      weekdays: [],
      missedPolicy: "run-once",
      maxRetries: 2,
      provider: "codex",
      model: "default",
      requiresNetwork: true,
      revision: 1,
      nextDueAt: "2026-08-12T15:00:00.000Z",
      snapshot: {
        artifactKind: kind,
        artifactTitle: "Scheduled review",
        artifactPayload: payload,
      },
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function providerResult(status: ProviderTaskStatus) {
  return {
    runId: "scheduled-run-1",
    provider: "codex",
    model: "default",
    status,
    text: status === "quota-hit" ? "Provider quota is exhausted." : "Provider sign-in is required.",
    durationMs: 10,
    commandPath: "/usr/local/bin/codex",
    evidence: [],
  };
}

describe("Mac local scheduler lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    runtime.markScheduleOccurrenceRunning.mockResolvedValue({});
    runtime.renewScheduleOccurrenceLease.mockResolvedValue({});
    runtime.scheduleExecutionPermitted.mockResolvedValue(true);
    runtime.finishScheduleOccurrence.mockResolvedValue({});
    runtime.recordProviderRun.mockImplementation(async (value: LocalWorkspaceSnapshot) => value);
    teamRuntime.readLocalAgentTeamPayload.mockImplementation((value: unknown) => value);
  });

  it.each(["signed-out", "quota-hit"] as const)(
    "turns a %s provider result into a resumable schedule pause",
    async (status) => {
      runtime.runIntelligenceTask.mockResolvedValue(providerResult(status));
      const result = await runClaimedLocalSchedule({
        claim: claim(),
        snapshot: snapshot(),
        providers: [],
        mcpServers: [],
        onSnapshot() {},
        onEvent() {},
        onApprovalRequired() {},
        controller: new AbortController(),
      });

      expect(result.status).toBe("paused");
      expect(runtime.finishScheduleOccurrence).toHaveBeenCalledWith(
        "schedule-1:1:1786460400000",
        "claim-token-12345678",
        "paused",
        providerResult(status).text,
      );
    },
  );

  it("pauses before Agent Team tools when project folder access was revoked", async () => {
    await expect(runClaimedLocalSchedule({
      claim: claim("agent-team"),
      snapshot: snapshot(false),
      providers: [],
      mcpServers: [],
      onSnapshot() {},
      onEvent() {},
      onApprovalRequired() {},
      controller: new AbortController(),
    })).rejects.toThrow("paused until its project folder is selected again");

    expect(teamRuntime.runLocalAgentTeam).not.toHaveBeenCalled();
    expect(runtime.finishScheduleOccurrence).toHaveBeenCalledWith(
      "schedule-1:1:1786460400000",
      "claim-token-12345678",
      "paused",
      expect.stringContaining("project folder"),
    );
  });

  it("stops when background permission changes after a claim", async () => {
    runtime.scheduleExecutionPermitted.mockResolvedValue(false);
    const controller = new AbortController();
    await expect(runClaimedLocalSchedule({
      claim: claim(),
      snapshot: snapshot(),
      providers: [],
      mcpServers: [],
      onSnapshot() {},
      onEvent() {},
      onApprovalRequired() {},
      controller,
    })).rejects.toThrow("background access changed");
    expect(controller.signal.aborted).toBe(true);
    expect(runtime.runIntelligenceTask).not.toHaveBeenCalled();
  });
});
