import { describe, expect, it } from "vitest";
import type { BotSkill } from "../../apps/mac/src/contracts";
import {
  botSkillChecksPassed,
  completeBotSkillChecks,
  prepareBotSkillRuns,
} from "../../apps/mac/src/bot-skills";
import { parseBotControlIntent, skillsForBotRequest } from "../../apps/mac/src/bot-initiative";

function skill(overrides: Partial<BotSkill> = {}): BotSkill {
  return {
    id: "skill-built-in-website-inspection",
    version: 1,
    name: "Website inspection",
    description: "Inspect one public HTTPS page.",
    instructions: "Read one page and return grounded evidence.",
    capabilityIds: ["conversation", "browser-read"],
    inputSchema: [
      { id: "url", label: "Website URL", type: "url", required: true },
      { id: "focus", label: "What to inspect", type: "text", required: false },
    ],
    outputSchema: [{ id: "brief", label: "Grounded brief", type: "text", required: true }],
    requiredPermissions: ["browser-read", "network"],
    effects: [
      { id: "inspect", label: "Read the requested page", kind: "browser-read", target: "input:url", risk: "read-only" },
      { id: "answer", label: "Generate a local response", kind: "model-generate", target: "conversation", risk: "local" },
    ],
    examples: [{ request: "Run Website inspection on https://example.com." }],
    checks: [
      { id: "url-required", label: "Website URL is present", phase: "before", rule: "required", inputId: "url" },
      { id: "url-https", label: "Website URL is public HTTPS", phase: "before", rule: "public-https", inputId: "url" },
      { id: "brief-present", label: "Grounded brief is present", phase: "after", rule: "output-present" },
    ],
    source: "built-in",
    trustState: "packaged",
    checksum: "a".repeat(64),
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("Mac packaged bot skills", () => {
  it("selects packaged and reviewed skills by exact name while keeping imports inert", () => {
    const packaged = skill();
    const imported = skill({
      id: "skill-imported-review",
      name: "Issue brief",
      source: "imported",
      trustState: "unreviewed",
    });
    expect(skillsForBotRequest([packaged, imported], "Run Website inspection on example.com"))
      .toEqual([packaged]);
    expect(skillsForBotRequest([packaged, imported], "Run Issue brief with issue: lag"))
      .toEqual([]);
  });

  it("validates typed inputs and records only bounded input metadata", () => {
    const packaged = skill();
    const prepared = prepareBotSkillRuns(
      [packaged],
      "Run Website inspection on https://example.com/pricing and focus on annual plans",
      { projectApproved: false },
    );
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.promptContext[0]).toContain("annual plans");
    expect(prepared.receipts[0].inputs).toEqual([
      expect.objectContaining({ id: "url", present: true, host: "example.com" }),
      expect.objectContaining({ id: "focus", present: true, valueLength: 12 }),
    ]);
    expect(JSON.stringify(prepared.receipts)).not.toContain("annual plans");
    const completed = completeBotSkillChecks([packaged], prepared.receipts, "A grounded brief");
    expect(botSkillChecksPassed(completed)).toBe(true);
  });

  it("fails closed on missing, local, and unapproved contextual inputs", () => {
    expect(prepareBotSkillRuns([skill()], "Run Website inspection", { projectApproved: false }))
      .toEqual(expect.objectContaining({ status: "invalid", message: expect.stringContaining("Website URL") }));
    expect(prepareBotSkillRuns(
      [skill()],
      "Run Website inspection on http://localhost:3108",
      { projectApproved: false },
    )).toEqual(expect.objectContaining({ status: "invalid", message: expect.stringContaining("public HTTPS") }));

    const release = skill({
      id: "skill-built-in-release-readiness",
      name: "Release readiness",
      inputSchema: [{ id: "focus", label: "Release focus", type: "text", required: true }],
      effects: [
        { id: "read", label: "Read approved project context", kind: "files-read", target: "approved-project", risk: "read-only" },
      ],
      checks: [
        { id: "focus", label: "Release focus is present", phase: "before", rule: "required", inputId: "focus" },
        { id: "project", label: "Project folder is approved", phase: "before", rule: "project-approved" },
      ],
    });
    expect(prepareBotSkillRuns(
      [release],
      "Run Release readiness for the login rollout",
      { projectApproved: false },
    )).toEqual(expect.objectContaining({ status: "invalid", message: expect.stringContaining("Project folder") }));
    expect(prepareBotSkillRuns(
      [release],
      "Run Release readiness for the login rollout",
      { projectApproved: true },
    )).toEqual(expect.objectContaining({ status: "ready" }));
  });

  it("recognizes the chat-native import command", () => {
    expect(parseBotControlIntent("Import a skill package")).toEqual({ kind: "import-skill" });
    expect(parseBotControlIntent("Add skill")).toEqual({ kind: "import-skill" });
  });
});
