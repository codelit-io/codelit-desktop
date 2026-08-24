import { describe, expect, it } from "vitest";
import type { BotSkill, LocalBrowserTeachingCapture, LocalBrowserTeachingDryRun } from "../../apps/mac/src/contracts";
import {
  browserProtectedStepLabel,
  browserReplayToolInputs,
  buildTaughtBrowserRecipeDraft,
  parseBrowserSkillRunRequest,
  parseBrowserTeachingRequest,
  parseTaughtBrowserRecipe,
} from "../../apps/mac/src/browser-teaching";

const capture: LocalBrowserTeachingCapture = {
  sessionId: "teaching-1",
  status: "review",
  startUrl: "https://app.example.com/customers",
  currentUrl: "https://app.example.com/customers",
  approvedDomains: ["app.example.com"],
  startedAt: "2026-08-19T18:00:00.000Z",
  events: [
    { type: "navigate", url: "https://app.example.com/customers", risk: "none" },
    {
      type: "fill",
      url: "https://app.example.com/customers",
      target: { expression: "[aria-label=\"Customer email\"]", label: "Customer email", tag: "input", inputType: "email" },
      risk: "none",
    },
    {
      type: "click",
      url: "https://app.example.com/customers",
      target: { expression: "text:Search", label: "Search", tag: "button", inputType: "submit" },
      risk: "none",
    },
    {
      type: "fill",
      url: "https://app.example.com/sign-in",
      target: { expression: "", label: "Identity control", tag: "input", inputType: "password" },
      risk: "login",
    },
  ],
};

const passedDryRun: LocalBrowserTeachingDryRun = {
  passed: true,
  executableSteps: 2,
  protectedSteps: 1,
  checks: [
    { id: "boundary", label: "Approved website boundary", passed: true, detail: "Inside boundary" },
    { id: "values", label: "No typed values retained", passed: true, detail: "No values" },
    { id: "targets", label: "Visible replay targets", passed: true, detail: "Targets visible" },
  ],
};

function browserSkill(): BotSkill {
  const draft = buildTaughtBrowserRecipeDraft("Customer lookup", capture, passedDryRun);
  return {
    id: "skill-customer-lookup",
    version: 1,
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    capabilityIds: draft.capabilityIds,
    inputSchema: [],
    outputSchema: [],
    requiredPermissions: [],
    effects: [],
    examples: [],
    checks: [],
    source: "taught",
    trustState: "reviewed",
    checksum: "browser-skill-checksum",
    createdAt: "2026-08-19T18:00:00.000Z",
    updatedAt: "2026-08-19T18:00:00.000Z",
  };
}

describe("local browser teaching", () => {
  it("parses a one-line teaching request with a safe website boundary", () => {
    expect(parseBrowserTeachingRequest("Teach a browser task called Customer lookup at https://app.example.com/customers"))
      .toEqual({
        name: "Customer lookup",
        url: "https://app.example.com/customers",
        host: "app.example.com",
      });
    expect(parseBrowserTeachingRequest("Inspect https://app.example.com")).toBeNull();
  });

  it("compiles runtime fields and takeover steps without captured values", () => {
    const draft = buildTaughtBrowserRecipeDraft("Customer lookup", capture, passedDryRun);

    expect(draft.capabilityIds).toEqual(["browser-read", "browser-act"]);
    expect(draft.recipe.inputs).toEqual([{ id: "customer_email", label: "Customer email", type: "email" }]);
    expect(draft.recipe.steps.at(-1)).toMatchObject({ risk: "login" });
    expect(browserProtectedStepLabel("login")).toBe("Take over for identity or consent");
    expect(draft.instructions).not.toContain("private@example.com");
    expect(parseTaughtBrowserRecipe(draft.instructions)).toEqual(draft.recipe);
  });

  it("refuses to save before a passing dry run", () => {
    expect(() => buildTaughtBrowserRecipeDraft("Customer lookup", capture, { ...passedDryRun, passed: false }))
      .toThrow("Check the browser replay");
  });

  it("fails closed when a persisted recipe is tampered", () => {
    const draft = buildTaughtBrowserRecipeDraft("Customer lookup", capture, passedDryRun);
    const tampered = draft.instructions.replace('"risk":"none"', '"risk":"unknown"');
    expect(parseTaughtBrowserRecipe(tampered)).toBeNull();
  });

  it("runs only an exact reviewed browser skill command", () => {
    const skill = browserSkill();
    expect(parseBrowserSkillRunRequest("Run Customer lookup", [skill]))
      .toMatchObject({ skill: { id: skill.id }, recipe: { schemaVersion: 1 } });
    expect(parseBrowserSkillRunRequest("Replay the browser task Customer lookup again", [skill]))
      .toMatchObject({ skill: { id: skill.id } });
    expect(parseBrowserSkillRunRequest("Can Customer lookup help here?", [skill])).toBeNull();
    expect(parseBrowserSkillRunRequest("Run Customer", [skill])).toBeNull();
  });

  it("compiles one exact safe action without mutating or persisting run-time values", () => {
    const skill = browserSkill();
    const request = parseBrowserSkillRunRequest("Run Customer lookup", [skill]);
    expect(request).not.toBeNull();
    const recipeBefore = JSON.stringify(request!.recipe);
    const fill = request!.recipe.steps.find((step) => step.type === "fill")!;
    const inputs = browserReplayToolInputs(skill, request!.recipe, fill, {
      customer_email: "customer@example.com",
    });
    expect(inputs).toEqual({
      "Browser act": {
        url: "https://app.example.com/customers",
        objective: "Run Customer lookup: Customer email",
        allowedDomains: ["app.example.com"],
        action: "type",
        target: "[aria-label=\"Customer email\"]",
        value: "customer@example.com",
      },
    });
    expect(JSON.stringify(request!.recipe)).toBe(recipeBefore);
    expect(request!.skill.instructions).not.toContain("customer@example.com");
  });

  it("requires declared values and refuses to automate protected steps", () => {
    const skill = browserSkill();
    const recipe = parseTaughtBrowserRecipe(skill.instructions)!;
    const fill = recipe.steps.find((step) => step.type === "fill" && step.risk === "none")!;
    const protectedStep = recipe.steps.find((step) => step.risk !== "none")!;
    expect(() => browserReplayToolInputs(skill, recipe, fill, {})).toThrow("Customer email is required");
    expect(() => browserReplayToolInputs(skill, recipe, protectedStep, {})).toThrow("manual takeover");
  });
});
