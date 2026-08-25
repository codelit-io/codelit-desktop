import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LocalWorkspaceSnapshot } from "../../apps/mac/shared/lib/local-desktop-workspace";
import type {
  LocalBotRecord,
  LocalBotsSnapshot,
  ProviderRunEvent,
} from "../../apps/mac/src/contracts";
import {
  applyBotRunEvent,
  botExecutionState,
  canStartBotExecution,
  cancelBotExecution,
  commitBotExecution,
  finishBotExecution,
  pendingComputerRunFromApproval,
  pendingBrowserRunFromApproval,
  pendingMcpRunFromApproval,
  replaceWorkspaceForActiveBot,
  setBotExecutionFeedback,
  startBotExecution,
  waitForBotBrowserApproval,
  waitForBotComputerApproval,
  waitForBotMcpApproval,
  type BotExecutionStates,
  type PendingBrowserRun,
  type PendingComputerRun,
  type PendingMcpRun,
} from "../../apps/mac/src/bot-run-state";

const CREATED_AT = "2026-08-14T00:00:00.000Z";

function event(runId: string, eventType: ProviderRunEvent["eventType"], message: string): ProviderRunEvent {
  return {
    runId,
    sequence: 1,
    eventType,
    provider: "codex",
    model: "default",
    message,
    createdAt: CREATED_AT,
  };
}

function bot(id: string): LocalBotRecord {
  return {
    id,
    threadId: `thread-${id}`,
    currentVersion: 1,
    name: id,
    status: "sleeping",
    latestStatus: "Ready",
    spec: {
      schemaVersion: 1,
      botId: id,
      version: 1,
      name: id,
      job: "Test parallel bot execution.",
      instructions: [],
      goal: {
        id: `goal-${id}`,
        outcome: "Test parallel bot execution.",
        successCriteria: [],
        status: "active",
        nextAction: "Start the next bounded test run.",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      enginePolicy: {
        mode: "auto",
        allowedProviders: ["codex"],
        allowMeteredFallback: false,
      },
      capabilityIds: ["conversation"],
      permissionPolicy: {
        approvalMode: "ask",
        browserDomains: [],
        projectAccess: "ask",
        browserAccess: "ask",
        writeActions: "always-ask",
        computerUse: "ask",
      },
      autonomyPolicy: { mode: "manual", maxActionsPerRun: 8, allowBackground: false },
      memoryPolicy: { mode: "off", scopes: ["bot"], proposalReview: "required" },
      routineIds: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function workspace(threadId: string, text: string): LocalWorkspaceSnapshot {
  return {
    thread: {
      id: threadId,
      ownerUid: "local-device",
      title: threadId,
      status: "idle",
      latestBlockSequence: 1,
      activeArtifactRefs: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    blocks: [{
      id: `message-${threadId}`,
      sequence: 1,
      createdAt: CREATED_AT,
      type: "assistant-message",
      text,
    }],
    artifacts: [],
    runEvents: [],
    runCheckpoints: [],
    approvals: [],
    receipts: [],
    artifactFiles: [],
    workspaceFolder: null,
    databasePath: "test.sqlite",
  };
}

function browserPending(botId: string, runId: string): PendingBrowserRun {
  return {
    approvalId: `approval-${runId}`,
    runId,
    botId,
    botVersion: 1,
    request: "Read https://example.com",
    target: { url: "https://example.com/", host: "example.com" },
    engine: { provider: "codex", model: "default" },
    selectionMode: "auto",
    meteredFallbackAuthorized: false,
    approvalMode: "ask",
    approvalSource: "pending-user",
    memories: [],
    memorySnapshotHash: "none",
    skills: [],
    skillVersions: {},
  };
}

function computerPending(botId: string, runId: string): PendingComputerRun {
  return {
    approvalId: `approval-${runId}`,
    runId,
    botId,
    botVersion: 1,
    request: "Use Safari to press New Tab",
    app: { bundleId: "com.apple.Safari", appName: "Safari" },
    action: { kind: "press", target: "New Tab", role: "AXButton", occurrence: 0 },
    proposedSummary: "I can open one new tab after approval.",
    engine: { provider: "codex", model: "default" },
    selectionMode: "fixed",
    meteredFallbackAuthorized: false,
    meteredProviderInvocationStarted: false,
    billingFallback: false,
    plannerDurationMs: 24,
    plannerCommandPath: "/usr/bin/codex",
    memorySnapshotHash: "none",
    memoryIds: [],
    skillVersions: {},
  };
}

function mcpPending(botId: string, runId: string): PendingMcpRun {
  return {
    approvalId: `approval-${runId}`,
    runId,
    botId,
    botVersion: 1,
    request: "Send the release update",
    toolReference: "mcp::slack::send_message",
    serverName: "Slack",
    toolName: "send_message",
    description: "Send one Slack message.",
    effect: "write",
    destructive: false,
    arguments: { channel: "release", text: "Ready" },
    approvalSha256: "a".repeat(64),
    preview: ["Slack / send_message", "Exact input: release / Ready"],
    engine: { provider: "codex", model: "default" },
    selectionMode: "fixed",
    meteredFallbackAuthorized: false,
    meteredProviderInvocationStarted: false,
    billingFallback: false,
    plannerDurationMs: 42,
    plannerCommandPath: "/usr/bin/codex",
    plannerEvidence: [],
    memories: [],
    memorySnapshotHash: "none",
    skills: [],
    skillVersions: {},
  };
}

describe("Mac bot parallel execution state", () => {
  it("restores only an exact typed MCP approval", () => {
    const pending = {
      ...mcpPending("bot-mcp", "run-mcp"),
      harnessCheckpoint: {
        schemaVersion: 1 as const,
        observations: ["Reviewed connection registry"],
        completedTools: [{ toolId: "local-connections", toolName: "Local connections" }],
        toolCalls: ["list_connected_tools" as const],
        mcpCalls: [],
        actionCount: 1,
        modelTurns: 2,
        recoveryAttempts: 0,
      },
    };
    const approval = {
      id: pending.approvalId,
      runId: pending.runId,
      stepIndex: 0,
      status: "awaiting" as const,
      body: { kind: "mcp-action", ...pending },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    expect(pendingMcpRunFromApproval(approval)).toEqual(pending);
    expect(pendingMcpRunFromApproval({
      ...approval,
      body: { ...approval.body, approvalSha256: "changed" },
    })).toBeNull();
    expect(pendingMcpRunFromApproval({
      ...approval,
      body: { ...approval.body, arguments: { constructor: { prototype: { polluted: true } } } },
    })).toBeNull();
    expect(pendingMcpRunFromApproval({
      ...approval,
      body: { ...approval.body, memorySnapshotHash: "missing" },
    })).toBeNull();
    const withoutMemoryHash: Record<string, unknown> = { ...approval.body };
    delete withoutMemoryHash.memorySnapshotHash;
    expect(pendingMcpRunFromApproval({ ...approval, body: withoutMemoryHash })).toBeNull();
    expect(pendingMcpRunFromApproval({
      ...approval,
      body: {
        ...approval.body,
        harnessCheckpoint: { ...pending.harnessCheckpoint, actionCount: 0 },
      },
    })).toBeNull();
  });

  it("isolates a pending MCP approval from another bot's run", () => {
    let states = waitForBotMcpApproval({}, mcpPending("bot-a", "run-a"));
    states = startBotExecution(states, "bot-b", "run-b");
    expect(states["bot-a"]).toMatchObject({
      runState: "awaiting-approval",
      pendingMcpRun: { toolName: "send_message" },
      pendingBrowserRun: null,
      pendingComputerRun: null,
    });
    expect(states["bot-b"].runState).toBe("running");
    expect(canStartBotExecution(states, "bot-a")).toBe(false);
  });

  it("restores only a bounded computer action with exact planner provenance", () => {
    const pending = computerPending("bot-computer", "run-computer");
    const approval = {
      id: pending.approvalId,
      runId: pending.runId,
      stepIndex: 0,
      status: "awaiting" as const,
      body: { kind: "computer-action", ...pending },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    expect(pendingComputerRunFromApproval(approval)).toEqual(pending);
    expect(pendingComputerRunFromApproval({
      ...approval,
      body: { ...approval.body, billingFallback: true },
    })).toBeNull();
    expect(pendingComputerRunFromApproval({
      ...approval,
      body: {
        ...approval.body,
        action: { kind: "setValue", target: "Message", role: "AXTextArea", value: "x".repeat(2_001) },
      },
    })).toBeNull();
    expect(pendingComputerRunFromApproval({
      ...approval,
      body: { ...approval.body, plannerCommandPath: "" },
    })).toBeNull();
    expect(pendingComputerRunFromApproval({
      ...approval,
      body: { ...approval.body, plannerVersion: "v\n2" },
    })).toBeNull();
  });

  it("isolates a pending computer approval from another bot's run", () => {
    let states = waitForBotComputerApproval({}, computerPending("bot-a", "run-a"));
    states = startBotExecution(states, "bot-b", "run-b");

    expect(states["bot-a"]).toMatchObject({
      runState: "awaiting-approval",
      activeRunId: "run-a",
      pendingBrowserRun: null,
    });
    expect(states["bot-b"].runState).toBe("running");
    expect(canStartBotExecution(states, "bot-a")).toBe(false);
  });

  it("restores the captured engine billing policy with a pending browser approval", () => {
    const restored = pendingBrowserRunFromApproval({
      id: "approval-run-metered",
      runId: "run-metered",
      stepIndex: 0,
      status: "awaiting",
      body: {
        kind: "browser-read",
        request: "Read https://example.com",
        target: { url: "https://example.com/", host: "example.com" },
        botId: "bot-metered",
        botVersion: 3,
        engine: { provider: "openai", model: "gpt-5.6-terra" },
        selectionMode: "auto",
        meteredFallbackAuthorized: true,
        approvalMode: "ask",
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });

    expect(restored).toMatchObject({
      engine: { provider: "openai", model: "gpt-5.6-terra" },
      selectionMode: "auto",
      meteredFallbackAuthorized: true,
    });
  });

  it("restores only an exact redacted browser action approval", () => {
    const pending = browserPending("bot-browser-action", "run-browser-action");
    const browserAction = {
      action: "type" as const,
      target: "label:Search",
      targetLabel: "Search",
      valueLength: 13,
      approvalSha256: "a".repeat(64),
      preview: ["Browser act · write", "Typed value: 13 characters; content is omitted"],
    };
    const approval = {
      id: pending.approvalId,
      runId: pending.runId,
      stepIndex: 0,
      status: "awaiting" as const,
      body: { kind: "browser-action", ...pending, browserAction },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    expect(pendingBrowserRunFromApproval(approval)).toEqual({ ...pending, browserAction });
    expect(pendingBrowserRunFromApproval({
      ...approval,
      body: { ...approval.body, browserAction: { ...browserAction, approvalSha256: "changed" } },
    })).toBeNull();
    expect(pendingBrowserRunFromApproval({
      ...approval,
      body: { ...approval.body, browserAction: { ...browserAction, value: "release ready" } },
    })).toBeNull();

    const downloadAction = {
      action: "download" as const,
      target: "label:Release report",
      targetLabel: "Release report",
      valueLength: 0,
      approvalSha256: "b".repeat(64),
      preview: ["Browser act · write", "Target: label:Release report"],
    };
    expect(pendingBrowserRunFromApproval({
      ...approval,
      body: { ...approval.body, browserAction: downloadAction },
    })).toEqual({ ...pending, browserAction: downloadAction });
    expect(pendingBrowserRunFromApproval({
      ...approval,
      body: { ...approval.body, browserAction: { ...downloadAction, valueLength: 1 } },
    })).toBeNull();
  });

  it("fails closed when a pending browser approval lacks billing provenance", () => {
    expect(pendingBrowserRunFromApproval({
      id: "approval-run-legacy",
      runId: "run-legacy",
      stepIndex: 0,
      status: "awaiting",
      body: {
        kind: "browser-read",
        request: "Read https://example.com",
        target: { url: "https://example.com/", host: "example.com" },
        botId: "bot-legacy",
        botVersion: 1,
        engine: { provider: "openai", model: "gpt-5.6-terra" },
        approvalMode: "ask",
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })).toBeNull();
  });

  it("restores only an exact reviewed skill snapshot for a browser approval", () => {
    const skill = {
      id: "skill-release-check",
      version: 2,
      name: "Release Check",
      description: "Review release evidence.",
      instructions: "Name the riskiest gap.",
      capabilityIds: [],
      source: "taught",
      trustState: "reviewed",
      checksum: "a".repeat(64),
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    const approval = {
      id: "approval-run-skilled",
      runId: "run-skilled",
      stepIndex: 0,
      status: "awaiting" as const,
      body: {
        kind: "browser-read",
        request: "Use Release Check on https://example.com",
        target: { url: "https://example.com/", host: "example.com" },
        botId: "bot-skilled",
        botVersion: 1,
        engine: { provider: "codex", model: "default" },
        selectionMode: "fixed",
        meteredFallbackAuthorized: false,
        approvalMode: "ask",
        skills: [skill],
        skillVersions: { "skill-release-check": 2 },
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    expect(pendingBrowserRunFromApproval(approval)).toMatchObject({
      skills: [skill],
      skillVersions: { "skill-release-check": 2 },
    });
    expect(pendingBrowserRunFromApproval({
      ...approval,
      body: { ...approval.body, skillVersions: { "skill-release-check": 1 } },
    })).toBeNull();
  });

  it("restores bounded delegation identity with a pending browser approval", () => {
    const approval = {
      id: "approval-run-delegated",
      runId: "run-delegated",
      stepIndex: 0,
      status: "awaiting" as const,
      body: {
        kind: "browser-read",
        request: "Inspect https://example.com",
        target: { url: "https://example.com/", host: "example.com" },
        botId: "bot-research",
        botVersion: 2,
        engine: { provider: "codex", model: "default" },
        selectionMode: "auto",
        meteredFallbackAuthorized: false,
        approvalMode: "ask",
        delegation: {
          delegationId: "delegation-release",
          parentBotId: "bot-codelit",
          parentThreadId: "thread-codelit",
          parentBotName: "Codelit",
          targetBotId: "bot-research",
          expectedOutput: "One evidence-backed result.",
          maxActions: 4,
        },
      },
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    expect(pendingBrowserRunFromApproval(approval)).toMatchObject({
      delegation: approval.body.delegation,
    });
    expect(pendingBrowserRunFromApproval({
      ...approval,
      body: {
        ...approval.body,
        delegation: { ...approval.body.delegation, maxActions: 99 },
      },
    })).toBeNull();
  });

  it("allows one run per bot while keeping many bots active", () => {
    let states: BotExecutionStates = {};
    states = startBotExecution(states, "bot-a", "run-a", { provider: "codex", model: "default" });
    const botA = states["bot-a"];
    states = startBotExecution(states, "bot-b", "run-b", { provider: "mlx", model: "mlx-community/Qwen3-4B-4bit" });

    expect(states["bot-a"]).toBe(botA);
    expect(states["bot-a"]).toMatchObject({
      runState: "running",
      activeRunId: "run-a",
      engine: { provider: "codex", model: "default" },
    });
    expect(states["bot-b"]).toMatchObject({
      runState: "running",
      activeRunId: "run-b",
      engine: { provider: "mlx", model: "mlx-community/Qwen3-4B-4bit" },
    });
    expect(canStartBotExecution(states, "bot-a")).toBe(false);
    expect(canStartBotExecution(states, "bot-b")).toBe(false);
    expect(canStartBotExecution(states, "bot-c")).toBe(true);
    expect(() => startBotExecution(states, "bot-a", "run-a-2"))
      .toThrow("This bot already has an active run.");
  });

  it("isolates live events, cancellation, and completion by bot and run ID", () => {
    let states: BotExecutionStates = startBotExecution({}, "bot-a", "run-a");
    states = startBotExecution(states, "bot-b", "run-b");
    states = applyBotRunEvent(states, "bot-a", event("run-a", "output-delta", "Answer A"));
    const botAWithAnswer = states["bot-a"];

    states = applyBotRunEvent(states, "bot-b", event("run-b", "reasoning-delta", "Thinking B"));
    expect(states["bot-a"]).toBe(botAWithAnswer);
    expect(states["bot-a"].liveRun.answer).toBe("Answer A");
    expect(states["bot-b"].liveRun.reasoning).toBe("Thinking B");

    const beforeStaleEvent = states;
    states = applyBotRunEvent(states, "bot-a", event("run-b", "output-delta", "Wrong bot"));
    expect(states).toBe(beforeStaleEvent);

    states = cancelBotExecution(states, "bot-a", "run-a");
    expect(states["bot-a"].runState).toBe("canceling");
    expect(states["bot-b"].runState).toBe("running");

    const botBBeforeFinish = states["bot-b"];
    states = finishBotExecution(states, "bot-a", "run-a", { notice: "A finished" });
    expect(states["bot-a"]).toMatchObject({
      runState: "idle",
      activeRunId: null,
      notice: "A finished",
    });
    expect(states["bot-b"]).toBe(botBBeforeFinish);
  });

  it("makes validated answer persistence a non-cancelable point of no return", () => {
    let states: BotExecutionStates = startBotExecution({}, "bot-a", "run-a");
    states = commitBotExecution(states, "bot-a", "run-a");

    expect(states["bot-a"]).toMatchObject({
      runState: "saving",
      activeRunId: "run-a",
      liveRun: { phase: "complete", status: "Saving answer" },
    });
    expect(canStartBotExecution(states, "bot-a")).toBe(false);
    expect(cancelBotExecution(states, "bot-a", "run-a")["bot-a"].runState).toBe("saving");
  });

  it("does not let stale work from a finished run mutate the bot's replacement run", () => {
    let states: BotExecutionStates = startBotExecution({}, "bot-a", "run-a-1");
    states = finishBotExecution(states, "bot-a", "run-a-1");
    states = startBotExecution(states, "bot-a", "run-a-2");
    const replacement = states;

    states = applyBotRunEvent(states, "bot-a", event("run-a-1", "output-delta", "Stale answer"));
    states = cancelBotExecution(states, "bot-a", "run-a-1");
    states = finishBotExecution(states, "bot-a", "run-a-1", { error: "Stale failure" });

    expect(states).toBe(replacement);
    expect(states["bot-a"]).toMatchObject({
      runState: "running",
      activeRunId: "run-a-2",
      error: null,
    });
    expect(states["bot-a"].liveRun.answer).toBe("");
  });

  it("keeps pending browser approval and feedback scoped to the requesting bot", () => {
    let states: BotExecutionStates = startBotExecution({}, "bot-a", "run-a");
    states = startBotExecution(states, "bot-b", "run-b");
    states = waitForBotBrowserApproval(states, browserPending("bot-a", "run-a"));
    states = setBotExecutionFeedback(states, "bot-a", { error: "Approval needed", notice: null });

    expect(botExecutionState(states, "bot-a")).toMatchObject({
      runState: "awaiting-approval",
      activeRunId: "run-a",
      error: "Approval needed",
      notice: null,
      pendingBrowserRun: { botId: "bot-a", runId: "run-a" },
    });
    expect(botExecutionState(states, "bot-b")).toMatchObject({
      runState: "running",
      activeRunId: "run-b",
      error: null,
      pendingBrowserRun: null,
    });
  });

  it("does not let a stale bot A completion replace active bot B's workspace", () => {
    const botA = bot("bot-a");
    const botB = bot("bot-b");
    const botBWorkspace = workspace(botB.threadId, "B is selected");
    const catalog: LocalBotsSnapshot = {
      bots: [botA, botB],
      activeBot: botB,
      workspace: botBWorkspace,
    };
    const completedA = workspace(botA.threadId, "A finished in the background");

    const unchanged = replaceWorkspaceForActiveBot(
      catalog,
      botA.id,
      botA.threadId,
      completedA,
    );
    expect(unchanged).toBe(catalog);
    expect(unchanged?.workspace).toBe(botBWorkspace);

    const completedB = workspace(botB.threadId, "B finished while selected");
    const updated = replaceWorkspaceForActiveBot(
      catalog,
      botB.id,
      botB.threadId,
      completedB,
    );
    expect(updated).not.toBe(catalog);
    expect(updated?.workspace).toBe(completedB);

    const mismatchedThread = replaceWorkspaceForActiveBot(
      catalog,
      botB.id,
      botB.threadId,
      completedA,
    );
    expect(mismatchedThread).toBe(catalog);
  });

  it("rechecks cancellation before either browser approval handoff can start work", () => {
    const app = readFileSync(new URL("../../apps/mac/src/BotsApp.tsx", import.meta.url), "utf8");
    const approvalWrite = app.indexOf("runSnapshot = await recordLocalRunApproval");
    const askHandoff = app.indexOf("if (!autoApprove)", approvalWrite);
    const canceledAfterApproval = app.indexOf("canceledRunIds.current.has(runId)", approvalWrite);
    const approvedCheckpoint = app.indexOf("gateApproved: true", askHandoff);
    const autoHandoff = app.indexOf("updateExecutionStates((current) => resumeBotExecution", approvedCheckpoint);
    const canceledAfterCheckpoint = app.indexOf("canceledRunIds.current.has(runId)", approvedCheckpoint);

    expect(approvalWrite).toBeGreaterThan(-1);
    expect(canceledAfterApproval).toBeGreaterThan(approvalWrite);
    expect(canceledAfterApproval).toBeLessThan(askHandoff);
    expect(approvedCheckpoint).toBeGreaterThan(askHandoff);
    expect(canceledAfterCheckpoint).toBeGreaterThan(approvedCheckpoint);
    expect(canceledAfterCheckpoint).toBeLessThan(autoHandoff);
  });

  it("keeps one visible native browser lane without collapsing parallel bot runs", () => {
    const app = readFileSync(new URL("../../apps/mac/src/BotsApp.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../apps/mac/src/BotsApp.css", import.meta.url), "utf8");
    const panel = readFileSync(
      new URL("../../apps/mac/src/components/LocalBrowserPanel.tsx", import.meta.url),
      "utf8",
    );
    const waitingStatus = app.indexOf("Waiting for the visible browser lane");
    const canceledBeforeAcquire = app.indexOf(
      "canceledRunIds.current.has(pending.runId)",
      waitingStatus,
    );
    const acquire = app.indexOf("const releaseLane = await acquireBrowserLane(pending.runId)");

    expect(app).toContain("state.pendingBrowserRun.runId !== activeBrowserRunId");
    expect(canceledBeforeAcquire).toBeGreaterThan(waitingStatus);
    expect(canceledBeforeAcquire).toBeLessThan(acquire);
    expect(app).toContain("cancelQueuedBrowserLane(runId)");
    expect(app).toContain("releaseLane();");
    expect(styles).toContain("grid-auto-columns: minmax(246px, 1fr)");
    expect(styles).toContain("calc(100vw - 260px)");
    expect(styles).toContain("calc(100vw - 274px)");
    expect(panel.match(/\.bots-browser-activities/g)).toHaveLength(2);
  });
});
