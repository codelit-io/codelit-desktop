import { describe, expect, it } from "vitest";
import {
  botMemorySafetyError,
  botMemorySnapshotHash,
  botSkillSnapshotMatches,
  botSkillVersions,
  classifyBotMemory,
  createBotGoal,
  inferBotMemoryProposal,
  parseBotControlIntent,
  parseBotDelegationIntent,
  previousUserRequest,
  skillsForBotRequest,
} from "../../apps/mac/src/bot-initiative";
import type { LocalBotRecord } from "../../apps/mac/src/contracts";

function delegationBot(id: string, name: string): LocalBotRecord {
  return {
    id,
    threadId: `thread-${id}`,
    currentVersion: 1,
    name,
    status: "sleeping",
    latestStatus: "Ready",
    spec: {
      schemaVersion: 1,
      botId: id,
      version: 1,
      name,
      job: `${name} specialist`,
      instructions: [],
      enginePolicy: { mode: "auto", allowedProviders: ["codex"], allowMeteredFallback: false },
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
      memoryPolicy: { mode: "proposals", scopes: ["bot"], proposalReview: "required" },
      goal: {
        id: `goal-${id}`,
        outcome: `${name} specialist`,
        successCriteria: [],
        status: "active",
        nextAction: "Wait for work.",
        createdAt: "2026-08-19T12:00:00.000Z",
        updatedAt: "2026-08-19T12:00:00.000Z",
      },
      routineIds: [],
      createdAt: "2026-08-19T12:00:00.000Z",
      updatedAt: "2026-08-19T12:00:00.000Z",
    },
    createdAt: "2026-08-19T12:00:00.000Z",
    updatedAt: "2026-08-19T12:00:00.000Z",
  };
}

describe("Codelit bot initiative", () => {
  it("turns plain-language recurring requests into deterministic routine drafts", () => {
    expect(parseBotControlIntent("Check codelit.io every weekday at 8 and report only material changes")).toEqual({
      kind: "schedule",
      cadence: "weekdays",
      localTime: "08:00",
      weekdays: [1, 2, 3, 4, 5],
      prompt: "Check codelit.io and report only material changes",
      triggerLabel: "Every weekday at 8:00 AM",
    });
    expect(parseBotControlIntent("Every Friday at 4:30 pm, summarize the project")).toEqual({
      kind: "schedule",
      cadence: "weekly",
      localTime: "16:30",
      weekdays: [5],
      prompt: "summarize the project",
      triggerLabel: "Every Friday at 4:30 PM",
    });
  });

  it("can repeat the prior task without making the user restate it", () => {
    expect(parseBotControlIntent("Do this daily at 9", "Inspect the release dashboard")).toMatchObject({
      kind: "schedule",
      prompt: "Inspect the release dashboard",
      localTime: "09:00",
    });
  });

  it("turns project change requests into deterministic event routine drafts", () => {
    expect(parseBotControlIntent("When this project changes, summarize what changed")).toEqual({
      kind: "watch-project",
      prompt: "summarize what changed",
      triggerLabel: "When this project changes",
    });
    expect(parseBotControlIntent("Monitor this repo and report only material differences")).toEqual({
      kind: "watch-project",
      prompt: "report only material differences",
      triggerLabel: "When this project changes",
    });
    expect(parseBotControlIntent("Whenever this folder changes")).toEqual({
      kind: "watch-project",
      prompt: "Summarize what changed and report only material differences.",
      triggerLabel: "When this project changes",
    });
  });

  it("turns exact bot mentions and natural language into bounded handoffs", () => {
    const bots = [
      delegationBot("bot-codelit", "Codelit"),
      delegationBot("bot-research", "Researcher"),
      delegationBot("bot-review", "Release Reviewer"),
    ];
    expect(parseBotDelegationIntent(
      "@Researcher compare the launch evidence",
      bots,
      "bot-codelit",
    )).toEqual({
      kind: "delegate",
      targetBotIds: ["bot-research"],
      task: "compare the launch evidence",
      expectedOutput: "One concise evidence-backed result.",
      maxActions: 4,
      deadlineMinutes: 30,
    });
    expect(parseBotDelegationIntent(
      "Ask Researcher and Release Reviewer to challenge the launch plan",
      bots,
      "bot-codelit",
    )).toMatchObject({
      kind: "delegate",
      targetBotIds: ["bot-research", "bot-review"],
      task: "challenge the launch plan",
      maxActions: 4,
    });
  });

  it("routes a team request through the conversation's saved teammates", () => {
    const bots = [
      delegationBot("bot-codelit", "Codelit"),
      delegationBot("bot-research", "Researcher"),
      delegationBot("bot-review", "Release Reviewer"),
    ];
    expect(parseBotDelegationIntent(
      "Ask the team to challenge the launch evidence",
      bots,
      "bot-codelit",
      ["bot-research", "bot-review"],
    )).toMatchObject({
      kind: "delegate",
      targetBotIds: ["bot-research", "bot-review"],
      task: "challenge the launch evidence",
    });
    expect(parseBotDelegationIntent(
      "@team: verify the release receipt",
      bots,
      "bot-codelit",
      ["bot-review"],
    )).toMatchObject({
      kind: "delegate",
      targetBotIds: ["bot-review"],
      task: "verify the release receipt",
    });
    expect(parseBotDelegationIntent(
      "Ask the team to verify the release receipt",
      bots,
      "bot-codelit",
    )).toEqual({
      kind: "delegation-error",
      message: "Add one or two teammates to this conversation first.",
    });
  });

  it("fails clearly for unknown, self, or over-broad delegation language", () => {
    const bots = [
      delegationBot("bot-codelit", "Codelit"),
      delegationBot("bot-research", "Researcher"),
      delegationBot("bot-review", "Reviewer"),
      delegationBot("bot-writer", "Writer"),
    ];
    expect(parseBotDelegationIntent("Ask Missing Bot to review this", bots, "bot-codelit"))
      .toEqual({ kind: "delegation-error", message: "There is no other bot named Missing Bot." });
    expect(parseBotDelegationIntent("@Codelit review this", bots, "bot-codelit"))
      .toEqual({ kind: "delegation-error", message: "Mention an available bot by its exact name." });
    expect(parseBotDelegationIntent(
      "@Researcher @Reviewer @Writer review this",
      bots,
      "bot-codelit",
    )).toEqual({ kind: "delegation-error", message: "Ask one or two specialist bots at a time." });
    expect(parseBotDelegationIntent("Research the launch", bots, "bot-codelit")).toBeNull();
  });

  it("explains that another bot is required for explicit delegation", () => {
    const onlyBot = delegationBot("bot-codelit", "Codelit");
    expect(parseBotDelegationIntent("Ask Researcher to check this", [onlyBot], onlyBot.id))
      .toEqual({ kind: "delegation-error", message: "Create another bot before asking a specialist." });
    expect(parseBotDelegationIntent("Summarize this", [onlyBot], onlyBot.id)).toBeNull();
  });

  it("recognizes goal and routine management commands before invoking a model", () => {
    expect(parseBotControlIntent("Set your goal to keep the release healthy")).toEqual({
      kind: "set-goal",
      outcome: "keep the release healthy",
    });
    expect(parseBotControlIntent("Pause all routines")).toEqual({ kind: "pause-routines" });
    expect(parseBotControlIntent("Show my routines")).toEqual({ kind: "show-routines" });
    expect(parseBotControlIntent("Change my routine to every weekday at 8:30 AM")).toEqual({
      kind: "update-routine-schedule",
      query: null,
      cadence: "weekdays",
      localTime: "08:30",
      weekdays: [1, 2, 3, 4, 5],
      triggerLabel: "Every weekday at 8:30 AM",
    });
    expect(parseBotControlIntent("Reschedule Release Check routine for every Friday at 4 PM")).toEqual({
      kind: "update-routine-schedule",
      query: "Release Check",
      cadence: "weekly",
      localTime: "16:00",
      weekdays: [5],
      triggerLabel: "Every Friday at 4:00 PM",
    });
    expect(parseBotControlIntent("Undo that change")).toEqual({ kind: "undo-change" });
  });

  it("turns plain language teaching into reviewed reusable skill controls", () => {
    expect(parseBotControlIntent(
      "Teach this as a skill called Release Check",
      "Summarize release evidence and name the riskiest gap",
    )).toEqual({
      kind: "teach-skill",
      name: "Release Check",
      instructions: "Summarize release evidence and name the riskiest gap",
      replace: false,
    });
    expect(parseBotControlIntent("Teach a skill called Release Check: Summarize the evidence")).toEqual({
      kind: "teach-skill",
      name: "Release Check",
      instructions: "Summarize the evidence",
      replace: false,
    });
    expect(parseBotControlIntent("Update skill Release Check: Require a rollback note")).toEqual({
      kind: "teach-skill",
      name: "Release Check",
      instructions: "Require a rollback note",
      replace: true,
    });
    expect(parseBotControlIntent("What skills do you know?")).toEqual({ kind: "show-skills" });
    expect(parseBotControlIntent("Forget skill Release Check")).toEqual({
      kind: "forget-skill",
      query: "Release Check",
    });
  });

  it("activates only exact reviewed skill names and pins their versions", () => {
    const skill = {
      id: "skill-release-check",
      version: 2,
      name: "Release Check",
      description: "Review release evidence",
      instructions: "Name the riskiest gap.",
      capabilityIds: [],
      inputSchema: [],
      outputSchema: [],
      requiredPermissions: [],
      effects: [],
      examples: [],
      checks: [],
      source: "taught" as const,
      trustState: "reviewed" as const,
      checksum: "a".repeat(64),
      createdAt: "2026-08-19T12:00:00.000Z",
      updatedAt: "2026-08-19T13:00:00.000Z",
    };
    expect(skillsForBotRequest([skill], "Use Release Check for this launch.")).toEqual([skill]);
    expect(skillsForBotRequest([skill], "Check this launch.")).toEqual([]);
    expect(botSkillVersions([skill])).toEqual({ "skill-release-check": 2 });
    expect(botSkillSnapshotMatches([skill], [skill])).toBe(true);
    expect(botSkillSnapshotMatches([{ ...skill, version: 3 }], [skill])).toBe(false);
  });

  it("turns explicit memory language into private or shared deterministic controls", () => {
    expect(parseBotControlIntent("Remember that staging uses the test workspace")).toEqual({
      kind: "remember",
      body: "staging uses the test workspace",
      scope: "bot",
    });
    expect(parseBotControlIntent("Remember for all bots that releases need QA approval")).toEqual({
      kind: "remember",
      body: "releases need QA approval",
      scope: "workspace",
    });
    expect(parseBotControlIntent("Remember this", "Use a short release summary")).toEqual({
      kind: "remember",
      body: "Use a short release summary",
      scope: "bot",
    });
    expect(parseBotControlIntent("Remember for 30 days that staging uses the test workspace")).toEqual({
      kind: "remember",
      body: "staging uses the test workspace",
      scope: "bot",
      retentionDays: 30,
    });
    expect(parseBotControlIntent("What do you know about this project?")).toEqual({ kind: "show-memory" });
    expect(parseBotControlIntent("Review memory suggestions")).toEqual({
      kind: "review-memory-proposals",
    });
    expect(parseBotControlIntent("Forget staging workspace")).toEqual({
      kind: "forget-memory",
      query: "staging workspace",
      all: false,
    });
    expect(parseBotControlIntent("Forget everything")).toEqual({
      kind: "forget-memory",
      query: null,
      all: true,
    });
  });

  it("classifies memories and rejects likely secrets before storage", () => {
    expect(classifyBotMemory("I prefer short release summaries")).toBe("preference");
    expect(classifyBotMemory("We decided to ship on Tuesdays")).toBe("decision");
    expect(classifyBotMemory("Before release, run the QA suite")).toBe("procedure");
    expect(classifyBotMemory("Staging uses the test workspace")).toBe("fact");
    expect(botMemorySafetyError("The staging password is hunter2")).toContain("will not save");
    expect(botMemorySafetyError("Staging uses the test workspace")).toBeNull();
  });

  it("suggests only explicit stable user context and keeps it pending", () => {
    expect(inferBotMemoryProposal("I prefer concise release summaries. Check this build.")).toEqual({
      body: "I prefer concise release summaries",
      kind: "preference",
      confidence: 0.86,
    });
    expect(inferBotMemoryProposal("We decided to ship on Tuesdays")).toEqual({
      body: "We decided to ship on Tuesdays",
      kind: "decision",
      confidence: 0.86,
    });
    expect(inferBotMemoryProposal("Analyze this folder and summarize the result.")).toBeNull();
    expect(inferBotMemoryProposal("I prefer using https://example.com for the token report")).toBeNull();
    expect(inferBotMemoryProposal("I prefer storing the API key here")).toBeNull();
  });

  it("creates a stable hash for the exact approved memory snapshot", async () => {
    const memory = {
      id: "memory-release",
      botId: "bot-release",
      scope: "bot" as const,
      kind: "fact" as const,
      body: "Staging uses the test workspace",
      source: "user" as const,
      confidence: 1,
      sensitivity: "normal" as const,
      approvalState: "approved" as const,
      createdAt: "2026-08-19T12:00:00.000Z",
      updatedAt: "2026-08-19T12:00:00.000Z",
    };
    const first = await botMemorySnapshotHash([memory]);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await botMemorySnapshotHash([memory])).toBe(first);
    expect(await botMemorySnapshotHash([])).toBe("none");
  });

  it("creates an active, bounded goal for a new bot", () => {
    expect(createBotGoal("Watch release health", "2026-08-19T12:00:00.000Z", "goal-release")).toEqual({
      id: "goal-release",
      outcome: "Watch release health",
      successCriteria: [
        "Produce one concrete result backed by inspectable evidence.",
        "Keep external changes and sensitive actions behind approval.",
      ],
      status: "active",
      nextAction: "Take the smallest useful read-only step with the context available now.",
      createdAt: "2026-08-19T12:00:00.000Z",
      updatedAt: "2026-08-19T12:00:00.000Z",
    });
  });

  it("finds the last user task for conversational follow-up schedules", () => {
    expect(previousUserRequest([
      { type: "assistant-message", text: "Ready" },
      { type: "user-message", text: "Inspect pricing" },
      { type: "assistant-message", text: "Done" },
    ])).toBe("Inspect pricing");
  });
});
