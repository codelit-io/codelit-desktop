import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const rendererQaMatrices = [
  { id: "release-light", colorScheme: "light", locale: "en-US", width: 1440, height: 900, exercise: true },
  { id: "release-dark", colorScheme: "dark", locale: "en-US", width: 1440, height: 900 },
  { id: "minimum-light", colorScheme: "light", locale: "de-DE", width: 760, height: 560 },
  { id: "minimum-dark", colorScheme: "dark", locale: "en-US", width: 760, height: 560 },
];

export const rendererQaSurfaces = [
  { label: "Bots", ready: ".bots-thread" },
];

export const rendererQaPanelLabels = ["New bot", "Settings", "Website approval", "Conversation without receipt noise"];
export const rendererQaJourneyCoverage = [
  { label: "Parallel bots", matrices: ["release-light"] },
  { label: "Conversation team", matrices: ["release-light", "minimum-light"] },
  { label: "Bot handoff", matrices: ["release-light", "minimum-light"] },
  { label: "Bot handoff approval", matrices: ["release-light"] },
  { label: "Bot profile", matrices: ["release-light", "minimum-light"] },
  { label: "Bot memory", matrices: ["release-light", "minimum-light"] },
  { label: "Memory proposal review", matrices: ["release-light", "minimum-light"] },
  { label: "Bot skills", matrices: ["release-light", "minimum-light"] },
  { label: "Imported skill review", matrices: ["release-light", "minimum-light"] },
  { label: "Browser teaching", matrices: ["release-light", "minimum-light"] },
  { label: "Browser skill approval", matrices: ["release-light", "minimum-light"] },
  { label: "Browser skill takeover", matrices: ["release-light", "minimum-light"] },
  { label: "Browser skill replay", matrices: ["release-light", "minimum-light"] },
  { label: "Browser action approval", matrices: ["release-light", "minimum-light"] },
  { label: "Browser action completion", matrices: ["release-light", "minimum-light"] },
  { label: "Browser download approval", matrices: ["release-light", "minimum-light"] },
  { label: "Browser download quarantine", matrices: ["release-light", "minimum-light"] },
  { label: "Bot routine", matrices: ["release-light", "minimum-light"] },
  { label: "Chat change undo", matrices: ["release-light", "minimum-light"] },
  { label: "Local bot table", matrices: ["release-light", "minimum-light"] },
  { label: "Markdown response", matrices: ["release-light", "minimum-light"] },
  { label: "Computer approval", matrices: ["release-light", "minimum-light"] },
  { label: "Computer action", matrices: ["release-light", "minimum-light"] },
  { label: "MCP action approval", matrices: ["release-light", "minimum-light"] },
  { label: "MCP action completion", matrices: ["release-light", "minimum-light"] },
  { label: "Private product report", matrices: ["release-light", "minimum-dark"] },
  { label: "Compact drawer", matrices: ["minimum-light"] },
];
export const rendererQaJourneyLabels = rendererQaJourneyCoverage.map(({ label }) => label);
export const rendererQaScreenshots = [
  "bots.png",
  "new-bot.png",
  "settings.png",
  "settings-intelligence.png",
  "settings-delete-confirmation.png",
  "settings-dark.png",
  "settings-compact.png",
  "settings-compact-dark.png",
  "settings-intelligence-compact-dark.png",
  "website-approval.png",
  "bots-compact.png",
  "website-approval-compact.png",
  "clean-conversation.png",
  "clean-conversation-dark.png",
  "clean-conversation-compact.png",
  "parallel-bots.png",
  "parallel-bot-approval.png",
  "conversation-team.png",
  "conversation-team-compact.png",
  "bot-handoff.png",
  "bot-handoff-approval.png",
  "bot-handoff-stopped.png",
  "bot-handoff-compact.png",
  "all-activity.png",
  "all-activity-compact.png",
  "bot-profile.png",
  "bot-profile-compact.png",
  "bot-memory.png",
  "bot-memory-compact.png",
  "bot-memory-proposal.png",
  "bot-memory-proposal-compact.png",
  "bot-skills.png",
  "bot-skills-compact.png",
  "bot-skill-import.png",
  "bot-skill-import-compact.png",
  "browser-teaching.png",
  "browser-teaching-compact.png",
  "browser-skill-approval.png",
  "browser-skill-approval-compact.png",
  "browser-skill-takeover.png",
  "browser-skill-takeover-compact.png",
  "browser-skill-replay.png",
  "browser-skill-replay-compact.png",
  "browser-action-approval.png",
  "browser-action-approval-compact.png",
  "browser-action-complete.png",
  "browser-action-complete-compact.png",
  "browser-download-approval.png",
  "browser-download-approval-compact.png",
  "browser-download-quarantine.png",
  "browser-download-quarantine-compact.png",
  "bot-routine.png",
  "bot-routine-compact.png",
  "chat-change-undo.png",
  "chat-change-undo-compact.png",
  "local-bot-table.png",
  "local-bot-table-compact.png",
  "markdown-response.png",
  "markdown-response-compact.png",
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
  "compact-drawer.png",
];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function matrixMatches(actual, expected) {
  return actual
    && actual.id === expected.id
    && actual.colorScheme === expected.colorScheme
    && actual.locale === expected.locale
    && actual.width === expected.width
    && actual.height === expected.height
    && Boolean(actual.exercise) === Boolean(expected.exercise);
}

export function readDesktopRendererQaReceipt(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * @param {any} receipt
 * @param {{ commit?: string, version?: string, receiptPath?: string, requireClean?: boolean }} [options]
 */
export function desktopRendererQaReceiptIssues(
  receipt,
  { commit, version, receiptPath, requireClean = true } = {},
) {
  const issues = [];
  if (receipt?.schemaVersion !== 1) issues.push("The desktop renderer QA receipt schema is unsupported.");
  if (receipt?.status !== "passed") issues.push("The desktop renderer QA receipt did not pass.");
  if (!Array.isArray(receipt?.failures) || receipt.failures.length) {
    issues.push("The desktop renderer QA receipt contains failures.");
  }
  if (!/^[a-f0-9]{40}$/.test(receipt?.source?.commit || "")) {
    issues.push("The desktop renderer QA receipt is missing a full source commit.");
  }
  if (commit && receipt?.source?.commit !== commit) {
    issues.push("The desktop renderer QA receipt belongs to a different source commit.");
  }
  if (version && receipt?.source?.version !== version) {
    issues.push("The desktop renderer QA receipt belongs to a different app version.");
  }
  if (requireClean && receipt?.source?.dirty !== false) {
    issues.push("The desktop renderer QA receipt was captured from a dirty source tree.");
  }
  if (receipt?.environment?.platform !== "darwin-arm64") {
    issues.push("The desktop renderer QA receipt must come from Apple Silicon macOS.");
  }
  if (!receipt?.environment?.osVersion || !isFiniteNumber(receipt?.environment?.memoryBytes)) {
    issues.push("The desktop renderer QA receipt is missing its bounded environment summary.");
  }

  const matrices = Array.isArray(receipt?.matrices) ? receipt.matrices : [];
  for (const expected of rendererQaMatrices) {
    if (!matrices.some((actual) => matrixMatches(actual, expected))) {
      issues.push(`The desktop renderer QA receipt is missing matrix ${expected.id}.`);
    }
  }

  const records = Array.isArray(receipt?.records) ? receipt.records : [];
  const labels = [...rendererQaSurfaces.map((surface) => surface.label), ...rendererQaPanelLabels];
  for (const matrix of rendererQaMatrices) {
    for (const label of labels) {
      const matches = records.filter((record) => record?.matrix === matrix.id && record?.surface === label);
      if (matches.length !== 1) {
        issues.push(`The desktop renderer QA receipt needs exactly one ${matrix.id}/${label} record.`);
        continue;
      }
      const [record] = matches;
      if (!Array.isArray(record.issues) || record.issues.length) {
        issues.push(`The desktop renderer QA receipt reports an issue for ${matrix.id}/${label}.`);
      }
      if (!Array.isArray(record.accessibility) || record.accessibility.length) {
        issues.push(`The desktop renderer QA receipt reports an accessibility failure for ${matrix.id}/${label}.`);
      }
      const layout = record.layout;
      if (
        !layout
        || !isFiniteNumber(layout.outerHorizontalOverflow)
        || layout.outerHorizontalOverflow > 1
        || !isFiniteNumber(layout.outerVerticalOverflow)
        || layout.outerVerticalOverflow > 1
        || !Array.isArray(layout.unexpectedScrollers)
        || layout.unexpectedScrollers.length
        || layout.skeletons !== 0
        || !isFiniteNumber(layout.domNodes)
        || layout.domNodes > 2_500
      ) {
        issues.push(`The desktop renderer QA receipt has an invalid layout result for ${matrix.id}/${label}.`);
      }
      if (label === "Bots" && (!isFiniteNumber(record.readyMs) || record.readyMs > 5_000)) {
        issues.push(`The desktop renderer QA receipt exceeds the startup budget for ${matrix.id}/${label}.`);
      }
    }
  }
  for (const journey of rendererQaJourneyCoverage) {
    const journeyRecords = records.filter((record) => record?.surface === journey.label);
    if (journeyRecords.length !== journey.matrices.length) {
      issues.push(
        `The desktop renderer QA receipt needs ${journey.matrices.length} matrix-scoped ${journey.label} journey record(s).`,
      );
    }
    for (const matrix of journey.matrices) {
      const matches = journeyRecords.filter((record) => record?.matrix === matrix);
      if (matches.length !== 1) {
        issues.push(`The desktop renderer QA receipt needs exactly one ${matrix}/${journey.label} journey record.`);
        continue;
      }
      const [record] = matches;
      if (!Array.isArray(record.issues) || record.issues.length) {
        issues.push(`The desktop renderer QA receipt reports an issue for ${matrix}/${journey.label}.`);
      }
      if (!Array.isArray(record.accessibility) || record.accessibility.length) {
        issues.push(`The desktop renderer QA receipt reports an accessibility failure for ${matrix}/${journey.label}.`);
      }
      const layout = record.layout;
      if (
        !layout
        || !isFiniteNumber(layout.outerHorizontalOverflow)
        || layout.outerHorizontalOverflow > 1
        || !isFiniteNumber(layout.outerVerticalOverflow)
        || layout.outerVerticalOverflow > 1
        || !Array.isArray(layout.unexpectedScrollers)
        || layout.unexpectedScrollers.length
        || layout.skeletons !== 0
        || !isFiniteNumber(layout.domNodes)
        || layout.domNodes > 2_500
      ) {
        issues.push(`The desktop renderer QA receipt has an invalid layout result for ${matrix}/${journey.label}.`);
      }
    }
  }

  const screenshots = Array.isArray(receipt?.screenshots) ? receipt.screenshots : [];
  for (const screenshot of rendererQaScreenshots) {
    if (!screenshots.includes(screenshot)) {
      issues.push(`The desktop renderer QA receipt is missing screenshot ${screenshot}.`);
    } else if (receiptPath && !existsSync(resolve(dirname(receiptPath), screenshot))) {
      issues.push(`The desktop renderer QA screenshot does not exist: ${screenshot}.`);
    }
  }
  return [...new Set(issues)];
}
