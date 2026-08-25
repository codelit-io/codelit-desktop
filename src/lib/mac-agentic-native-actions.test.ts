import { describe, expect, it } from "vitest";

import {
  buildAgenticNativeActions,
  nativeRoutineTriggerLabel,
  validateAgenticNativeArguments,
} from "../../apps/mac/src/agentic-native-actions";

describe("Mac typed native agent actions", () => {
  it("exposes only actions backed by currently available capabilities", () => {
    expect(buildAgenticNativeActions({
      hasProject: false,
      schedulesAvailable: false,
      teammateNames: [],
    }).map((action) => action.name)).toEqual([
      "set_goal",
      "create_table",
      "add_table_row",
    ]);
    expect(buildAgenticNativeActions({
      hasProject: true,
      schedulesAvailable: true,
      teammateNames: ["Reviewer", "Writer"],
    }).map((action) => action.name)).toEqual([
      "set_goal",
      "create_table",
      "add_table_row",
      "create_routine",
      "watch_project",
      "delegate",
    ]);
  });

  it("normalizes bounded local goal, table, and routine payloads", () => {
    expect(validateAgenticNativeArguments("set_goal", {
      outcome: "  Prepare a verifiable release  ",
    })).toEqual({ outcome: "Prepare a verifiable release" });
    expect(validateAgenticNativeArguments("create_table", {
      name: " Leads ",
      columns: [
        { name: "Company", type: "text" },
        { name: "Score", type: "number" },
      ],
    })).toEqual({
      name: "Leads",
      columns: [
        { name: "Company", type: "text" },
        { name: "Score", type: "number" },
      ],
    });
    expect(validateAgenticNativeArguments("create_routine", {
      prompt: "Inspect the release dashboard",
      cadence: "weekdays",
      localTime: "09:00",
    })).toEqual({
      prompt: "Inspect the release dashboard",
      cadence: "weekdays",
      localTime: "09:00",
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  it("rejects extra fields, duplicate columns, nested row values, and incomplete weekly timing", () => {
    expect(validateAgenticNativeArguments("set_goal", {
      outcome: "Ship safely",
      silently: true,
    })).toBeNull();
    expect(validateAgenticNativeArguments("create_table", {
      name: "Leads",
      columns: [
        { name: "Company", type: "text" },
        { name: "company", type: "text" },
      ],
    })).toBeNull();
    expect(validateAgenticNativeArguments("add_table_row", {
      tableName: "Leads",
      values: { Company: { hidden: "value" } },
    })).toBeNull();
    expect(validateAgenticNativeArguments("create_routine", {
      prompt: "Review releases",
      cadence: "weekly",
      localTime: "09:00",
    })).toBeNull();
  });

  it("pins delegation to exact teammates supplied by the current conversation", () => {
    const definition = buildAgenticNativeActions({
      hasProject: false,
      schedulesAvailable: false,
      teammateNames: ["Reviewer"],
    }).find((action) => action.name === "delegate");
    expect(definition).toBeTruthy();
    expect(validateAgenticNativeArguments("delegate", {
      targetBotNames: ["Reviewer"],
      task: "Challenge the release evidence",
    }, definition)).toEqual({
      targetBotNames: ["Reviewer"],
      task: "Challenge the release evidence",
      expectedOutput: "One concise evidence-backed result.",
    });
    expect(validateAgenticNativeArguments("delegate", {
      targetBotNames: ["Unknown"],
      task: "Challenge the release evidence",
    }, definition)).toBeNull();
  });

  it("renders deterministic local schedule labels", () => {
    expect(nativeRoutineTriggerLabel({
      cadence: "weekdays",
      localTime: "09:05",
      weekdays: [1, 2, 3, 4, 5],
    })).toBe("Every weekday at 9:05 AM");
    expect(nativeRoutineTriggerLabel({
      cadence: "weekly",
      localTime: "16:30",
      weekdays: [5],
    })).toBe("Every Friday at 4:30 PM");
  });
});
