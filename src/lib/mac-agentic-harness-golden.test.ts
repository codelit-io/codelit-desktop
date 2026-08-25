import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { requiredGroundingTool } from "../../apps/mac/src/agentic-read-loop";
import type { LocalBotRecord } from "../../apps/mac/src/contracts";
import { parseBotDataIntent } from "../../apps/mac/src/bot-data";
import { parseBotControlIntent, parseBotDelegationIntent } from "../../apps/mac/src/bot-initiative";
import { parseBotBrowserAction, parseBotBrowserTarget } from "../../apps/mac/src/bot-policy";
import { matchComputerApp } from "../../apps/mac/src/computer-use-plan";
import { localConversationReply, parseLocalFileIntent } from "../../apps/mac/src/local-file-intent";

interface GoldenTask {
  id: string;
  lane: "browser-action" | "browser-read" | "computer-read" | "control" | "conversation" | "data" | "delegation" | "grounded-harness" | "project-read";
  request: string;
  expectedTool?: string;
}

const fixture = JSON.parse(readFileSync(
  new URL("../../apps/mac/harness-golden-tasks.json", import.meta.url),
  "utf8",
)) as { schemaVersion: number; tasks: GoldenTask[] };

const groundedTools = [
  "read_project_overview",
  "list_selected_folder",
  "list_local_tables",
  "list_local_routines",
  "list_connected_tools",
] as const;

describe("Mac harness golden tasks", () => {
  it("keeps a compact, unique release gate across every user-facing execution lane", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.tasks.length).toBeGreaterThanOrEqual(12);
    expect(new Set(fixture.tasks.map((task) => task.id)).size).toBe(fixture.tasks.length);
    expect(new Set(fixture.tasks.map((task) => task.lane))).toEqual(new Set([
      "browser-action",
      "browser-read",
      "computer-read",
      "control",
      "conversation",
      "data",
      "delegation",
      "grounded-harness",
      "project-read",
    ]));
  });

  for (const task of fixture.tasks) {
    it(`routes ${task.id} through ${task.lane}`, () => {
      if (task.lane === "conversation") {
        expect(localConversationReply(task.request, "Codelit")).toBeTruthy();
      } else if (task.lane === "project-read") {
        expect(parseLocalFileIntent(task.request)).toMatchObject({ kind: "describe-project" });
      } else if (task.lane === "browser-read") {
        expect(parseBotBrowserTarget(task.request)).toMatchObject({ kind: "target", host: "codelit.io" });
      } else if (task.lane === "browser-action") {
        expect(parseBotBrowserAction(task.request)).toMatchObject({ kind: "action" });
      } else if (task.lane === "computer-read") {
        expect(matchComputerApp(task.request, [{
          botId: "bot-release",
          bundleId: "com.apple.Notes",
          appName: "Notes",
          access: "observe",
          createdAt: "2026-08-25T00:00:00.000Z",
          updatedAt: "2026-08-25T00:00:00.000Z",
        }])).toMatchObject({ appName: "Notes" });
      } else if (task.lane === "delegation") {
        expect(parseBotDelegationIntent(task.request, [
          { id: "bot-lead", name: "Lead" },
          { id: "bot-reviewer", name: "Reviewer" },
        ] as LocalBotRecord[], "bot-lead", ["bot-reviewer"])).toMatchObject({
          kind: "delegate",
          targetBotIds: ["bot-reviewer"],
        });
      } else if (task.lane === "grounded-harness") {
        expect(requiredGroundingTool(task.request, [...groundedTools])).toBe(task.expectedTool);
      } else if (task.lane === "data") {
        expect(parseBotDataIntent(task.request)).toMatchObject({ kind: "create-table" });
      } else {
        expect(parseBotControlIntent(task.request)).not.toBeNull();
      }
    });
  }
});
