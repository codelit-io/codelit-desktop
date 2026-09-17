import { describe, expect, it } from "vitest";
import { buildBotPrompt } from "../../apps/mac/src/bot-prompt";
import type { BotMemory, LocalBotRecord } from "../../apps/mac/src/contracts";

const bot = {
  id: "bot-helper",
  threadId: "thread-helper",
  currentVersion: 1,
  name: "Helper",
  status: "sleeping",
  latestStatus: "Ready",
  spec: {
    job: "Help with everyday work.",
    instructions: [],
  },
} as unknown as LocalBotRecord;

describe("Mac bot prompt", () => {
  it("treats ordinary chat as useful work without negative setup boilerplate", () => {
    const prompt = buildBotPrompt(bot, "Can you connect to my Gmail?", [], [], []);

    expect(prompt).toContain("ordinary conversation");
    expect(prompt).toContain("what access is missing");
    expect(prompt).not.toContain("No durable memory");
    expect(prompt).not.toContain("No reusable skill");
    expect(prompt).not.toContain("No project folder");
    expect(prompt).not.toContain("There is no evidence provided");
  });

  it("excludes expired approved preferences from future prompts", () => {
    const memory: BotMemory = {
      id: "report-format",
      botId: bot.id,
      scope: "bot",
      kind: "preference",
      body: "Use the obsolete report format.",
      source: "user",
      confidence: 1,
      sensitivity: "normal",
      approvalState: "approved",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2000-01-02T00:00:00.000Z",
    };
    expect(buildBotPrompt(bot, "Prepare my report", [], [memory], []))
      .not.toContain(memory.body);
    const { expiresAt, ...retained } = memory;
    expect(buildBotPrompt(bot, "Prepare my report", [], [retained], []))
      .toContain(memory.body);
  });

  it("adds approved context only when it exists", () => {
    const prompt = buildBotPrompt(bot, "Summarize this page", ["Page title: Codelit"], [], []);

    expect(prompt).toContain("Approved context:\nPage title: Codelit");
    expect(prompt).toContain("use it only for claims about what was inspected");
  });
});
