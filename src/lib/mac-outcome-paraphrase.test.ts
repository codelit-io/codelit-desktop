import { describe, expect, it } from "vitest";

import {
  buildBotNextActions,
  latestCompletedBotRequest,
  latestBotOutcome,
} from "../../apps/mac/src/bot-outcomes";

describe("Outcome signals for natural phrasing", () => {
  const chatOnly = (text: string) => latestBotOutcome([
    { type: "user-message", text },
    { type: "assistant-message", text: "Hi! I'm Atlas. I can inspect folders, review websites, and track work." },
  ]);

  it.each([
    "hi what can you do",
    "hello there!",
    "thanks, that helped",
    "hey, how do I export this?",
  ])("keeps conversational phrasing answered without actions: %s", (text) => {
    expect(chatOnly(text)?.status).toBe("answered");
    expect(latestCompletedBotRequest([
      { type: "user-message", text },
      { type: "assistant-message", text: "Here is everything you asked for." },
    ])).toBeNull();
    expect(buildBotNextActions(text, { hasProject: false, schedulesAvailable: true })).toEqual([]);
  });

  it.each([
    "Hey, read acceptance.txt from the connected project and quote its lines",
    "Can you read acceptance.txt from the connected folder?",
    "Hello, can you compare the selected files?",
    "Thanks, now summarize this project",
    "Thanks, that helped. Read the other file too",
    "Hi there, inspect this folder",
    "Can you help me compare the selected documents?",
    "What can you tell me about this project's risks?",
  ])("retains actions for actionable phrasing: %s", (request) => {
    const actions = buildBotNextActions(request, { hasProject: true, schedulesAvailable: true });
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.length).toBeLessThanOrEqual(2);
    expect(actions.some((action) => action.prompt.includes(request))).toBe(true);
  });

  it("bounds long input before classifying without nested repetition", () => {
    expect(buildBotNextActions(`hello ${"! ".repeat(10_000)}`, { hasProject: true, schedulesAvailable: true })).toEqual([]);
  });
});
