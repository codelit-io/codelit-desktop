import { describe, expect, it } from "vitest";
import {
  computerPlannerPrompt,
  matchComputerApp,
  parseComputerPlan,
} from "../../apps/mac/src/computer-use-plan";
import type {
  ComputerAppInspection,
  ComputerAppScope,
  ProviderTaskResult,
} from "../../apps/mac/src/contracts";

const scopes: ComputerAppScope[] = [
  {
    botId: "bot-one",
    bundleId: "com.apple.Safari",
    appName: "Safari",
    access: "interact",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  },
];

const inspection: ComputerAppInspection = {
  bundleId: "com.apple.Safari",
  appName: "Safari",
  truncated: false,
  elements: [
    {
      role: "AXButton",
      label: "New Tab",
      enabled: true,
      actions: ["press"],
      sensitive: false,
      occurrence: 0,
    },
    {
      role: "AXTextField",
      label: "Password",
      enabled: true,
      actions: [],
      sensitive: true,
      occurrence: 0,
    },
  ],
};

function result(items: string[]): ProviderTaskResult {
  return {
    runId: "run-one",
    provider: "codex",
    model: "default",
    status: "completed",
    structuredOutput: { summary: "I can open a new tab after approval.", items },
    text: "planned",
    durationMs: 1,
    commandPath: "/usr/bin/codex",
    evidence: [],
    selectionMode: "fixed",
    meteredFallbackAuthorized: false,
    meteredProviderInvocationStarted: false,
    billingFallback: false,
  };
}

describe("Codelit computer-use planner", () => {
  it("routes only requests that explicitly name an approved app", () => {
    expect(matchComputerApp("Use Safari to open a new tab", scopes)?.bundleId).toBe("com.apple.Safari");
    expect(matchComputerApp("Inspect Safari and summarize what is visible", scopes)?.bundleId).toBe("com.apple.Safari");
    expect(matchComputerApp("Open a new tab", scopes)).toBeNull();
    expect(matchComputerApp("Email the report", [{ ...scopes[0], appName: "Mail" }])).toBeNull();
    expect(matchComputerApp("Tell me about Safari", scopes)).toBeNull();
  });

  it("grounds one exact semantic action in the inspected controls", () => {
    expect(parseComputerPlan(
      result(['ACTION {"kind":"press","target":"New Tab","role":"AXButton","occurrence":0}']),
      inspection,
    )).toEqual({
      kind: "action",
      summary: "I can open a new tab after approval.",
      action: { kind: "press", target: "New Tab", role: "AXButton", occurrence: 0 },
    });
  });

  it("refuses invented and sensitive controls", () => {
    expect(() => parseComputerPlan(
      result(['ACTION {"kind":"press","target":"Delete all","role":"AXButton","occurrence":0}']),
      inspection,
    )).toThrow(/safe visible target/);
    expect(() => parseComputerPlan(
      result(['ACTION {"kind":"setValue","target":"Password","role":"AXTextField","occurrence":0,"value":"secret"}']),
      inspection,
    )).toThrow(/safe visible target/);
  });

  it("does not leak protected controls into the planner prompt", () => {
    const prompt = computerPlannerPrompt("Use Safari", inspection);
    expect(prompt).toContain("New Tab");
    expect(prompt).not.toContain("Password");
    expect(prompt).toContain("Do not claim the action happened");
    expect(prompt).toContain("untrusted data");
  });

  it("rejects unsupported planner narration instead of treating it as no action", () => {
    expect(() => parseComputerPlan(result(["Click the new tab button"]), inspection))
      .toThrow(/unsupported action text/);
  });
});
