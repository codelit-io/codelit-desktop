import { describe, expect, it } from "vitest";

import {
  buildBotNextActions,
  buildBotStarterOutcomes,
  latestCompletedBotRequest,
} from "../../apps/mac/src/bot-outcomes";

describe("Mac bot outcome actions", () => {
  it("shows only three starters selected from capabilities that are actually ready", () => {
    expect(buildBotStarterOutcomes({
      browserReadAvailable: true,
      connectedToolCount: 4,
      hasProject: true,
      schedulesAvailable: true,
    })).toEqual([
      expect.objectContaining({ id: "project-gap" }),
      expect.objectContaining({ id: "website-audit" }),
      expect.objectContaining({ id: "connected-tools", label: "Review 4 connected tools" }),
    ]);
  });

  it("keeps three useful local starters when gated capabilities are unavailable", () => {
    const actions = buildBotStarterOutcomes({
      browserReadAvailable: false,
      connectedToolCount: 0,
      hasProject: false,
      schedulesAvailable: false,
    });
    expect(actions.map((action) => action.id)).toEqual(["goal-plan", "local-tracker", "review-memory"]);
    expect(actions).toHaveLength(3);
  });

  it("surfaces configured teammates and approved Mac apps without generic setup copy", () => {
    const actions = buildBotStarterOutcomes({
      approvedComputerAppName: "Notes",
      browserReadAvailable: true,
      connectedToolCount: 0,
      hasProject: true,
      schedulesAvailable: true,
      teammateCount: 2,
    });
    expect(actions.map((action) => action.id)).toEqual(["project-gap", "team-review", "computer-review"]);
    expect(actions[2]).toMatchObject({
      label: "Review Notes",
      prompt: "Inspect Notes and summarize what is visible without changing anything.",
    });
  });

  it("offers proactive follow-through only after a completed result", () => {
    const incomplete = latestCompletedBotRequest([
      { type: "user-message", text: "Inspect https://example.com for broken links" },
      { type: "run", status: "failed" },
    ]);
    const complete = latestCompletedBotRequest([
      { type: "user-message", text: "Inspect https://example.com for broken links" },
      { type: "run", status: "completed" },
      { type: "assistant-message", text: "The inspection completed." },
    ]);
    expect(incomplete).toBeNull();
    expect(complete).toBe("Inspect https://example.com for broken links");
    expect(buildBotNextActions(complete, { hasProject: false, schedulesAvailable: true })).toEqual([
      expect.objectContaining({
        id: "monitor-weekdays",
        prompt: "Every weekday at 9 AM, Inspect https://example.com for broken links",
      }),
      expect.objectContaining({ id: "save-skill" }),
    ]);
  });

  it("does not add follow-ups to built-in controls or local data actions", () => {
    expect(buildBotNextActions("What do you know?", { hasProject: false, schedulesAvailable: true })).toEqual([]);
    expect(buildBotNextActions(
      "Create a table called Work Tracker with columns Task, Owner, Status",
      { hasProject: false, schedulesAvailable: true },
    )).toEqual([]);
    expect(buildBotNextActions(
      "Show which connected tools are ready and what each one can do.",
      { hasProject: false, schedulesAvailable: true },
    )).toEqual([]);
  });

  it("turns a completed project review into a watch without recursive control suggestions", () => {
    const actions = buildBotNextActions(
      "Inspect this project and identify the highest-risk release gap.",
      { hasProject: true, schedulesAvailable: true },
    );
    expect(actions.map((action) => action.id)).toEqual(["watch-project", "make-goal"]);
    expect(buildBotNextActions(actions[0].prompt, { hasProject: true, schedulesAvailable: true })).toEqual([]);
  });

  it("bounds generated prompts and derives a reusable skill name", () => {
    const request = `Explain ${"release risk ".repeat(200)}`;
    const actions = buildBotNextActions(request, { hasProject: false, schedulesAvailable: false });
    expect(actions.map((action) => action.id)).toEqual(["make-goal", "save-skill"]);
    expect(actions.every((action) => action.prompt.length <= 2_000)).toBe(true);
    expect(actions[1].prompt).toBe("Teach this as a skill called Explain Release Risk Release");
  });
});
