import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  desktopRendererQaReceiptIssues,
  rendererQaJourneyCoverage,
  rendererQaJourneyLabels,
  rendererQaMatrices,
  rendererQaPanelLabels,
  rendererQaScreenshots,
  rendererQaSurfaces,
} from "../../apps/mac/scripts/desktop-renderer-qa-receipt.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const script = read("../../apps/mac/scripts/qa-desktop-renderer.mjs");
const receiptContract = read("../../apps/mac/scripts/desktop-renderer-qa-receipt.mjs");
const app = read("../../apps/mac/src/BotsApp.tsx");
const botRunState = read("../../apps/mac/src/bot-run-state.ts");
const appCss = read("../../apps/mac/src/BotsApp.css");
const entry = read("../../apps/mac/src/main.tsx");
const releaseSupport = read("../../apps/mac/scripts/release-support.mjs");
const packageJson = JSON.parse(read("../../package.json"));

function passingReceipt(directory: string) {
  for (const screenshot of rendererQaScreenshots) writeFileSync(join(directory, screenshot), "image");
  return {
    schemaVersion: 1,
    status: "passed",
    source: { commit: "a".repeat(40), dirty: false, version: "0.1.0" },
    environment: { platform: "darwin-arm64", osVersion: "26.6.1", memoryBytes: 32_000_000_000 },
    matrices: rendererQaMatrices,
    records: [
      ...rendererQaMatrices.flatMap((matrix) => [
        ...rendererQaSurfaces.map((surface) => surface.label),
        ...rendererQaPanelLabels,
      ].map((surface) => ({
        matrix: matrix.id,
        surface,
        accessibility: [],
        issues: [],
        readyMs: surface === "Bots" ? 600 : undefined,
        layout: {
          outerHorizontalOverflow: 0,
          outerVerticalOverflow: 0,
          unexpectedScrollers: [],
          skeletons: 0,
          domNodes: 300,
        },
      }))),
      ...rendererQaJourneyCoverage.flatMap(({ label, matrices }) => matrices.map((matrix) => ({
        matrix,
        surface: label,
        accessibility: [],
        issues: [],
        layout: {
          outerHorizontalOverflow: 0,
          outerVerticalOverflow: 0,
          unexpectedScrollers: [],
          skeletons: 0,
          domNodes: 350,
        },
      }))),
    ],
    screenshots: rendererQaScreenshots,
    failures: [],
  };
}

describe("Codelit for Mac renderer QA", () => {
  it("audits every product surface in both themes and supported window sizes", () => {
    expect(receiptContract).toContain('label: "Bots"');
    expect(receiptContract).toContain('id: "release-light"');
    expect(receiptContract).toContain('id: "release-dark"');
    expect(receiptContract).toContain('id: "minimum-light"');
    expect(receiptContract).toContain('id: "minimum-dark"');
    expect(script).toContain("globalThis.axe.run");
    expect(script).toContain("outerHorizontalOverflow");
    expect(script).toContain("unexpected nested scrollers");
  });

  it("exercises edits and creates a source-bound machine-readable receipt", () => {
    expect(script).toContain('getByRole("button", { name: "New bot", exact: true })');
    expect(script).toContain('getByLabel("Bot job")');
    expect(app).toContain('className="bots-new-sheet bots-new-bot-dialog"');
    expect(app).toContain('<details className="bot-create-customize">');
    expect(app.indexOf('aria-label="Bot job"')).toBeLessThan(app.indexOf('<details className="bot-create-customize">'));
    expect(script).toContain('getByRole("button", { name: "Create bot", exact: true })');
    expect(script).toContain('getByRole("region", { name: "Read codelit.io?" })');
    expect(script).toContain('getByRole("button", { name: "Always allow codelit.io", exact: true })');
    expect(script).toContain('receipt?.body?.details?.approval?.decisionSource !== "bot-domain-scope"');
    expect(script).toContain('isolatedBot?.spec.permissionPolicy.browserDomains.length !== 0');
    expect(script).toContain('getByRole("button", { name: "Hold", exact: true })');
    expect(script).toContain("Internal run receipts leaked into the bot conversation.");
    expect(script).toContain("The private run receipt was not retained after its conversation card was hidden.");
    expect(script).toContain("probe_provider_api_keys");
    expect(script).toContain("Sign in to or switch GitHub Copilot account");
    expect(script).toContain('selectionMode: "auto"');
    expect(script).toContain('getByRole("heading", { name: "Models & providers", exact: true })');
    expect(script).toContain('getByRole("button", { name: "Intelligence", exact: true })');
    expect(script).toContain('getByRole("button", { name: "Privacy", exact: true })');
    expect(script).toContain('getByRole("heading", { name: "Autonomy", exact: true })');
    expect(script).toContain('getByRole("switch", { name: /Pause all routines/ })');
    expect(script).toContain('getByRole("switch", { name: /Quiet hours/ })');
    expect(script).toContain('getByLabel("From", { exact: true })');
    expect(script).toContain('getByLabel("Until", { exact: true })');
    expect(script).toContain('getByRole("tab", { name: "Subscriptions", exact: true })');
    expect(script).toContain('getByRole("tab", { name: "API keys", exact: true })');
    expect(script).toContain('.provider-center-key-form input[type="password"]');
    expect(script).toContain("Provider Center did not show the metered Auto boundary");
    expect(rendererQaScreenshots).toContain("clean-conversation-dark.png");
    expect(script).toContain('commit: commandOutput("git", ["rev-parse", "HEAD"])');
    expect(script).toContain('writeFileSync(receiptPath');
    expect(packageJson.scripts["desktop:qa:renderer"]).toContain("qa-desktop-renderer.mjs");
  });

  it("holds two native provider runs behind independent renderer barriers", () => {
    expect(rendererQaJourneyLabels).toEqual([
      "Parallel bots",
      "Conversation team",
      "Bot handoff",
      "Bot handoff approval",
      "Bot profile",
      "Bot memory",
      "Memory proposal review",
      "Bot skills",
      "Imported skill review",
      "Browser teaching",
      "Browser skill approval",
      "Browser skill takeover",
      "Browser skill replay",
      "Browser action approval",
      "Browser action completion",
      "Browser download approval",
      "Browser download quarantine",
      "Bot routine",
      "Chat change undo",
      "Local bot table",
      "Markdown response",
      "Computer approval",
      "Computer action",
      "MCP action approval",
      "MCP action completion",
      "Private product report",
      "Compact drawer",
    ]);
    expect(script).toContain("installParallelBotTauriFixture");
    expect(script).toContain("run_provider_task_stream");
    expect(script).toContain("New bot was disabled while Alpha was working.");
    expect(script).toContain("Alpha hidden update.");
    expect(script).toContain("Beta only thought.");
    expect(script).toContain("Stopping Alpha canceled the wrong runs");
    expect(script).toContain("Alpha's pending approval disabled Beta's composer.");
    expect(script).toContain('window.__CODELIT_PARALLEL_QA__.complete(runId, "Beta final answer.")');
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "parallel-bots.png",
      "parallel-bot-approval.png",
      "settings-dark.png",
      "settings-intelligence.png",
      "settings-compact.png",
      "settings-compact-dark.png",
      "settings-intelligence-compact-dark.png",
      "computer-approval.png",
      "computer-action.png",
      "computer-approval-compact.png",
      "computer-action-compact.png",
      "mcp-action-approval.png",
      "mcp-action-approval-compact.png",
      "mcp-action-complete.png",
      "mcp-action-complete-compact.png",
      "settings-private-report.png",
      "settings-private-report-compact-dark.png",
    ]));
    expect(script).toContain("Holding the MCP proposal invoked or retained the external action.");
    expect(script).toContain("Allow once did not execute exactly the sealed typed MCP call once.");
  });

  it("reviews one bounded computer action and renders transient evidence at both supported sizes", () => {
    expect(rendererQaJourneyCoverage).toEqual(expect.arrayContaining([
      { label: "Computer approval", matrices: ["release-light", "minimum-light"] },
      { label: "Computer action", matrices: ["release-light", "minimum-light"] },
    ]));
    expect(script).toContain("probe_computer_use_readiness");
    expect(script).toContain("inspect_computer_app");
    expect(script).toContain("run_computer_action");
    expect(script).toContain('getByRole("region", { name: "Use Safari?", exact: true })');
    expect(script).toContain("Computer action did not remain scoped and redacted in its receipt");
  });

  it("delegates through the composer and renders one responsive group result", () => {
    expect(rendererQaJourneyCoverage).toContainEqual({
      label: "Bot handoff",
      matrices: ["release-light", "minimum-light"],
    });
    expect(rendererQaJourneyCoverage).toContainEqual({
      label: "Bot handoff approval",
      matrices: ["release-light"],
    });
    expect(script).toContain("create_local_bot_delegation");
    expect(script).toContain("recover_local_bot_delegations");
    expect(script).toContain('getByRole("button", { name: "Ask another bot", exact: true })');
    expect(script).toContain("The reviewed bot handoff did not persist its bounded target snapshot.");
    expect(script).toContain("The delegated provider prompt lost its bounded collaboration policy.");
    expect(script).toContain("The delegated website request did not pause in the reviewed handoff ledger.");
    expect(script).toContain("Stopping a handoff did not cancel its owned provider run.");
    expect(script).toContain('getByRole("heading", { name: "All activity", exact: true })');
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "bot-handoff.png",
      "bot-handoff-approval.png",
      "bot-handoff-stopped.png",
      "bot-handoff-compact.png",
      "all-activity.png",
      "all-activity-compact.png",
    ]));
  });

  it("persists bot identity while another provider lane runs at desktop and compact sizes", () => {
    expect(rendererQaJourneyCoverage).toEqual(expect.arrayContaining([
      { label: "Bot profile", matrices: ["release-light", "minimum-light"] },
      { label: "Compact drawer", matrices: ["minimum-light"] },
    ]));
    expect(script).toContain("update_local_bot_profile");
    expect(script).toContain("profileUpdates.push(clone(request))");
    expect(script).toContain("Saving Beta's profile stopped Alpha's provider lane.");
    expect(script).toContain("Shift+Tab escaped the bot profile");
    expect(script).toContain('document.activeElement?.getAttribute("aria-label") === "Customize Beta"');
    expect(script).toContain("The 760px bot drawer geometry is invalid");
    expect(script).toContain('getByRole("radio", { name: "Wave", exact: true })');
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "bot-profile.png",
      "bot-profile-compact.png",
      "compact-drawer.png",
    ]));
  });

  it("creates and activates a reviewed routine through the bot conversation", () => {
    expect(rendererQaJourneyCoverage).toContainEqual({
      label: "Bot routine",
      matrices: ["release-light", "minimum-light"],
    });
    expect(rendererQaJourneyCoverage).toContainEqual({
      label: "Chat change undo",
      matrices: ["release-light", "minimum-light"],
    });
    expect(script).toContain('fill("Check release health every weekday at 8 AM")');
    expect(script).toContain('fill("Change my routine to every Friday at 4:30 PM")');
    expect(script).toContain("Undo did not restore the exact prior cadence");
    expect(script).toContain('fill("When this project changes, summarize what changed")');
    expect(script).toContain('getByRole("region", { name: "Bot routines", exact: true })');
    expect(script).toContain('getByRole("button", { name: "Start", exact: true })');
    expect(script).toContain("read_local_project_fingerprint");
    expect(script).toContain("eventRoutineSnapshot.eventRoutines[0].lastFileCount !== 148");
    expect(script).toContain("spec.autonomyPolicy.allowBackground !== true");
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "bot-routine.png",
      "bot-routine-compact.png",
      "chat-change-undo.png",
      "chat-change-undo-compact.png",
    ]));
  });

  it("teaches, grounds, reviews, and forgets bot memory through the conversation", () => {
    expect(rendererQaJourneyCoverage).toContainEqual({
      label: "Bot memory",
      matrices: ["release-light", "minimum-light"],
    });
    expect(script).toContain('fill("Remember that staging uses the test workspace")');
    expect(script).toContain('getByRole("region", { name: "New bot memory", exact: true })');
    expect(script).toContain('fill("What do you know?")');
    expect(script).toContain("Bot memory (fact): staging uses the test workspace");
    expect(script).toContain("Undo did not remove the newly taught bot memory.");
    expect(script).toContain('getByRole("region", { name: "Memory suggestions", exact: true })');
    expect(script).toContain('getByLabel("Memory scope", { exact: true }).selectOption("workspace")');
    expect(script).toContain("Memory proposal review did not preserve provenance and expiry");
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "bot-memory.png",
      "bot-memory-compact.png",
      "bot-memory-proposal.png",
      "bot-memory-proposal-compact.png",
    ]));
  });

  it("teaches, grounds, and removes a reviewed reusable skill through chat", () => {
    expect(rendererQaJourneyCoverage).toContainEqual({
      label: "Bot skills",
      matrices: ["release-light", "minimum-light"],
    });
    expect(script).toContain('fill("Teach a skill called Release Check: Summarize release evidence and name the single riskiest gap")');
    expect(script).toContain('getByRole("region", { name: "New reusable skill", exact: true })');
    expect(script).toContain('Reusable skill "Release Check" v1');
    expect(script).toContain("Undo did not remove the newly taught reusable skill.");
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "bot-skills.png",
      "bot-skills-compact.png",
    ]));
  });

  it("keeps imported typed skills inert until one-click conversation review", () => {
    expect(rendererQaJourneyCoverage).toContainEqual({
      label: "Imported skill review",
      matrices: ["release-light", "minimum-light"],
    });
    expect(script).toContain('fill("Import a skill package")');
    expect(script).toContain('name: "Imported skills waiting for review"');
    expect(script).toContain("Imported skill did not remain inert before review");
    expect(script).toContain('Skill contract for "Issue brief" v2');
    expect(script).toContain("Imported skill receipt was incomplete or retained raw inputs");
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "bot-skill-import.png",
      "bot-skill-import-compact.png",
    ]));
  });

  it("records, reviews, dry-runs, and saves browser tasks without retaining values", () => {
    expect(rendererQaJourneyCoverage).toContainEqual({
      label: "Browser teaching",
      matrices: ["release-light", "minimum-light"],
    });
    expect(script).toContain("start_local_browser_teaching");
    expect(script).toContain("capture_local_browser_teaching");
    expect(script).toContain("finish_local_browser_teaching");
    expect(script).toContain("dry_run_local_browser_teaching");
    expect(script).toContain('fill("Teach a browser task called Customer lookup at https://app.example.com/customers")');
    expect(script).toContain('getByLabel("Recorded browser steps", { exact: true })');
    expect(script).toContain("retainedBrowserValue");
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "browser-teaching.png",
      "browser-teaching-compact.png",
    ]));
  });

  it("replays a taught browser task through exact approvals without persisting run-time values", () => {
    expect(rendererQaJourneyCoverage).toEqual(expect.arrayContaining([
      { label: "Browser skill approval", matrices: ["release-light", "minimum-light"] },
      { label: "Browser skill takeover", matrices: ["release-light", "minimum-light"] },
      { label: "Browser skill replay", matrices: ["release-light", "minimum-light"] },
    ]));
    expect(script).toContain('fill("Run Customer lookup")');
    expect(script).toContain('fill("customer@example.com")');
    expect(script).toContain("prepare_local_tool_approval");
    expect(script).toContain("usedBrowserValue");
    expect(script).toContain("persistedBeforeBrowserAction.includes");
    expect(script).toContain("persistedAfterBrowserAction.includes");
    expect(script).toContain('receipt.body?.provider === "codelit" && receipt.body?.model === "browser-replay-v1"');
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "browser-skill-approval.png",
      "browser-skill-approval-compact.png",
      "browser-skill-takeover.png",
      "browser-skill-takeover-compact.png",
      "browser-skill-replay.png",
      "browser-skill-replay-compact.png",
    ]));
  });

  it("runs one typed browser action from chat through an exact single-use approval", () => {
    expect(rendererQaJourneyCoverage).toEqual(expect.arrayContaining([
      { label: "Browser action approval", matrices: ["release-light", "minimum-light"] },
      { label: "Browser action completion", matrices: ["release-light", "minimum-light"] },
    ]));
    expect(script).toContain('fill(\'Type "release candidate 7" into "Search" on https://codelit.io/docs\')');
    expect(script).toContain('getByRole("region", { name: "Run this browser action?", exact: true })');
    expect(script).toContain("preparedBrowserRunIds");
    expect(script).toContain("The optional browser summary stopped after the action completed.");
    expect(script).toContain("The consumed browser approval replayed a completed action");
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "browser-action-approval.png",
      "browser-action-approval-compact.png",
      "browser-action-complete.png",
      "browser-action-complete-compact.png",
    ]));
  });

  it("quarantines one approved browser download and requires explicit release", () => {
    expect(rendererQaJourneyCoverage).toEqual(expect.arrayContaining([
      { label: "Browser download approval", matrices: ["release-light", "minimum-light"] },
      { label: "Browser download quarantine", matrices: ["release-light", "minimum-light"] },
    ]));
    expect(script).toContain('fill(\'Download "Release report" from https://codelit.io/releases\')');
    expect(script).toContain('getByRole("region", { name: "Download this file?", exact: true })');
    expect(script).toContain('getByRole("region", { name: "Downloads waiting for you", exact: true })');
    expect(script).toContain("The quarantined download lost its model-free receipt boundary");
    expect(script).toContain("Explicit release did not consume the quarantined copy");
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "browser-download-approval.png",
      "browser-download-approval-compact.png",
      "browser-download-quarantine.png",
      "browser-download-quarantine-compact.png",
    ]));
  });

  it("renders semantic technical Markdown without allowing outer-window overflow", () => {
    expect(rendererQaJourneyCoverage).toContainEqual({
      label: "Markdown response",
      matrices: ["release-light", "minimum-light"],
    });
    expect(script).toContain('getByRole("heading", { name: "Secure rollout", level: 2 })');
    expect(script).toContain('getByRole("table")');
    expect(script).toContain('getByRole("columnheader", { name: "Layer", exact: true })');
    expect(script).toContain('locator("pre code")');
    expect(script).toContain('markdownLayout.text.includes("| Layer |")');
    expect(rendererQaScreenshots).toEqual(expect.arrayContaining([
      "markdown-response.png",
      "markdown-response-compact.png",
    ]));
  });

  it("removes collapsed sidebar controls from keyboard navigation", () => {
    expect(app).toContain('aria-hidden={!sidebarOpen || overlayOpen}');
    expect(app).toContain('inert={!sidebarOpen || overlayOpen}');
    expect(app).toContain('inert={overlayOpen}');
  });

  it("ships the focused bot shell without importing the retired workbench shell", () => {
    expect(entry).toContain('import BotsApp from "./BotsApp"');
    expect(entry).not.toContain('from "./App"');
  });

  it("opens bot data independently and renders bootstrap failures instead of an endless spinner", () => {
    const bootstrapStart = app.indexOf("const openBots = useCallback");
    const catalogReady = app.indexOf("setCatalog(nextCatalog)", bootstrapStart);
    const optionalChecks = app.indexOf("const refreshStartupMetadata = useCallback", catalogReady);

    expect(bootstrapStart).toBeGreaterThan(-1);
    expect(catalogReady).toBeGreaterThan(bootstrapStart);
    expect(optionalChecks).toBeGreaterThan(catalogReady);
    expect(app).toContain("Promise.allSettled([");
    expect(app).toContain('aria-busy={!startupFailed}');
    expect(app).toContain("Codelit couldn't open your bots");
    expect(app).toContain("Try again");
    expect(appCss).toContain('.bots-startup-state[data-state="error"]');
  });

  it("gives the approved website browser a measurable grid viewport", () => {
    expect(appCss).toMatch(/\.bots-browser-run \.local-browser-panel\s*\{[^}]*display:\s*grid;/);
    expect(appCss).toMatch(/\.bots-browser-run \.local-browser-viewport\s*\{[^}]*grid-area:\s*viewport;/);
  });

  it("persists one bot domain before approving and locks broad policy during a pending read", () => {
    expect(app).toContain('Website access: ${browserDomains.length} saved ${browserDomains.length === 1 ? "domain" : "domains"}. Open approval settings');
    expect(script).toContain('Broad safe-read mode remained editable while an older bot version awaited approval.');
    expect(app).toContain('disabled={savingApprovalMode || runState !== "idle"}');
    expect(app).toContain("Agent website inspection isn't included in this App Store build.");
    expect(app).toContain("Not included in this App Store build.");
    expect(app).not.toContain("browse pages manually inside Codelit");
    expect(app).not.toContain("Website inspection is available in Codelit's notarized Direct build.");

    const handlerStart = app.indexOf("const allowBrowserDomainAndApproveRun");
    const handlerEnd = app.indexOf("const decideComputerRun", handlerStart);
    const handler = app.slice(handlerStart, handlerEnd);
    const persistence = handler.indexOf("await updateLocalBotBrowserDomains(");
    const approval = handler.indexOf("await decideBrowserRun(true)");
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handler).toContain("catch (reason)");
    expect(handler).toMatch(/catch \(reason\) \{[\s\S]*?return;[\s\S]*?\} finally/);
    expect(persistence).toBeGreaterThan(-1);
    expect(approval).toBeGreaterThan(persistence);
  });

  it("renders provider thinking and typed prose without exposing raw event fragments", () => {
    expect(app).toContain("applyBotRunEvent(current, botId, event)");
    expect(botRunState).toContain("reduceProviderLiveState(current.liveRun, event)");
    expect(app).toContain('className={`bot-live-response ${liveRun.phase}`}');
    expect(app).toContain('className="bot-live-thinking"');
    expect(app).toContain('<summary>Thinking</summary>');
    expect(app).toContain('const BotMarkdown = lazy(() => import("./components/BotMarkdown"))');
    expect(app).toContain('<RichBotMarkdown className="bot-live-answer" streaming>');
    expect(app).not.toContain("<strong>{activeEvent.message}</strong>");
    expect(appCss).toContain(".bot-markdown.streaming > :last-child::after");
  });

  it("accepts only a complete receipt bound to the exact clean release source", () => {
    const directory = mkdtempSync(join(tmpdir(), "codelit-renderer-receipt-"));
    const receiptPath = join(directory, "renderer-qa.json");
    const receipt = passingReceipt(directory);
    expect(desktopRendererQaReceiptIssues(receipt, {
      commit: "a".repeat(40),
      version: "0.1.0",
      receiptPath,
    })).toEqual([]);

    const failingReceipt = {
      ...receipt,
      source: { ...receipt.source, dirty: true },
      records: receipt.records.map((record, index) => index === 0
        ? { ...record, accessibility: [{ id: "color-contrast" }] }
        : record),
    };
    expect(desktopRendererQaReceiptIssues(failingReceipt, {
      commit: "b".repeat(40),
      version: "0.1.0",
      receiptPath,
    })).toEqual(expect.arrayContaining([
      "The desktop renderer QA receipt was captured from a dirty source tree.",
      "The desktop renderer QA receipt belongs to a different source commit.",
      "The desktop renderer QA receipt reports an accessibility failure for release-light/Bots.",
    ]));
  });

  it("requires the source-bound receipt only for production release profiles", () => {
    expect(releaseSupport).toContain("CODELIT_DESKTOP_RENDERER_QA_RECEIPT");
    expect(releaseSupport).toContain("if (!adhoc) missing.push(...rendererQaIssues");
  });
});
