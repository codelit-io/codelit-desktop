import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLocalPilotCohortReceipt,
  localPilotCohortPolicy,
  localPilotManifestIssues,
  localPilotReportIssues,
  parseLocalPilotCohortArguments,
  readLocalPilotReports,
} from "../../apps/mac/scripts/local-pilot-cohort.mjs";

const sourceCommit = "a".repeat(40);

function identifier(prefix: "participant" | "report", index: number) {
  return `${prefix}-${index.toString(16).padStart(32, "0")}`;
}

function pilotReport(index: number, overrides: Record<string, unknown> = {}) {
  const generatedAt = new Date(Date.UTC(2026, 7, 1 + index, 12)).toISOString();
  const base = {
    schemaVersion: 2,
    kind: "codelit-local-pilot-report",
    reportId: identifier("report", index + 1),
    participantId: identifier("participant", index + 1),
    generatedAt,
    app: {
      version: "0.1.1",
      buildChannel: "direct",
      sourceCommit,
      sourceDirty: false,
    },
    measurementWindow: {
      startedAt: "2026-08-01T10:00:00.000Z",
      endedAt: generatedAt,
    },
    privacy: {
      localOnly: true,
      automaticUpload: false,
      excluded: [
        "prompt text",
        "browser content and URLs",
        "file names and contents",
        "screenshots",
        "memories",
        "credentials",
        "provider responses and model output",
        "local database rows",
      ],
    },
    activation: {
      customBotCreated: true,
      firstRunAttempted: true,
      firstRunCompleted: true,
      firstUsefulResultCompleted: true,
      secondsToFirstUsefulResult: 120,
    },
    runs: {
      started: 2,
      completed: 2,
      failed: 0,
      canceled: 0,
      activeDays: 2,
      repeatTaskWithinSevenDays: true,
    },
    delegations: { started: 2, completed: 2, repeated: true },
    routines: { created: 1, enabled: 1, occurrences: 2, completedOccurrences: 2, reused: true },
    approvals: { requested: 1, awaiting: 0, resolved: 1, approved: 1, heldOrDenied: 0 },
    unexpectedActions: { total: 0, categories: [] },
  };
  return { ...base, ...overrides };
}

function pilotManifest(count = 25) {
  return {
    schemaVersion: 1,
    kind: "codelit-local-pilot-cohort-manifest",
    cohortId: "pilot-local-bots-001",
    expectedApp: { version: "0.1.1", buildChannel: "direct", sourceCommit },
    participants: Array.from({ length: count }, (_, index) => ({
      participantId: identifier("participant", index + 1),
      consentConfirmed: true,
      jobCategories: [["website"], ["repository"], ["research"], ["file-management"]][index % 4],
    })),
  };
}

describe("Codelit Mac local pilot cohort", () => {
  it("rejects unknown content fields and weakened privacy boundaries", () => {
    const withPrompt = { ...pilotReport(0), prompt: "private customer request" };
    expect(localPilotReportIssues(withPrompt)).toContain(
      "The local pilot report contains missing or unsupported fields.",
    );
    const weakened = pilotReport(0, {
      privacy: {
        ...(pilotReport(0).privacy as Record<string, unknown>),
        automaticUpload: true,
      },
    });
    expect(localPilotReportIssues(weakened)).toContain(
      "The local pilot privacy boundary permits non-local collection.",
    );
  });

  it("deduplicates latest participant exports and emits only aggregate evidence", () => {
    const reports = Array.from({ length: 25 }, (_, index) => pilotReport(index));
    const olderDuplicate = pilotReport(0, {
      reportId: identifier("report", 100),
      generatedAt: "2026-08-01T11:00:00.000Z",
      measurementWindow: {
        startedAt: "2026-08-01T10:00:00.000Z",
        endedAt: "2026-08-01T11:00:00.000Z",
      },
    });
    const receipt = buildLocalPilotCohortReceipt({
      manifest: pilotManifest(),
      reports: [...reports, olderDuplicate],
    });

    expect(receipt.status).toBe("measurement-ready");
    expect(receipt.publicationDecision).toBe("not-made");
    expect(receipt.inputs.uniqueParticipants).toBe(localPilotCohortPolicy.minimumParticipants);
    expect(receipt.inputs.duplicateExports).toBe(1);
    expect(receipt.metrics.activation.firstRunCompletionRate).toBe(1);
    expect(receipt.metrics.runs.repeatTaskWithinSevenDaysRate).toBe(1);
    expect(receipt.metrics.routines.routineCreationRate).toBe(1);
    expect(receipt.gates.every((gate) => gate.status === "passed")).toBe(true);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(identifier("participant", 1));
    expect(serialized).not.toContain(identifier("report", 1));
  });

  it("blocks dirty or mixed candidates, missing consent, and unexpected actions", () => {
    const reports = Array.from({ length: 25 }, (_, index) => pilotReport(index));
    reports[0] = pilotReport(0, {
      app: { ...pilotReport(0).app, sourceDirty: true },
      unexpectedActions: {
        total: 1,
        categories: [{ category: "unapproved-write", count: 1 }],
      },
    });
    const manifest = pilotManifest();
    manifest.participants[1].consentConfirmed = false;
    const receipt = buildLocalPilotCohortReceipt({ manifest, reports });

    expect(receipt.status).toBe("blocked");
    expect(receipt.gates.find((gate) => gate.id === "exact-clean-candidate")?.status).toBe("blocked");
    expect(receipt.gates.find((gate) => gate.id === "explicit-consent")?.status).toBe("blocked");
    expect(receipt.gates.find((gate) => gate.id === "unapproved-write-safety")?.status).toBe("blocked");
  });

  it("requires pseudonymous assignments spanning every pilot job category", () => {
    const manifest = pilotManifest(4);
    expect(localPilotManifestIssues(manifest)).toEqual([]);
    manifest.participants[0].jobCategories = [];
    manifest.participants[1].participantId = manifest.participants[2].participantId;
    expect(localPilotManifestIssues(manifest)).toEqual(expect.arrayContaining([
      "A local pilot participant is missing a job category.",
      "The local pilot cohort contains a duplicate participant identifier.",
    ]));
  });

  it("does not echo report filenames or unexpected JSON content in validation output", () => {
    const directory = mkdtempSync(join(tmpdir(), "codelit-local-pilot-"));
    writeFileSync(join(directory, "customer-name-private.json"), JSON.stringify({ prompt: "secret" }));
    const source = join(directory, "source.txt");
    writeFileSync(source, "not a report");
    symlinkSync(source, join(directory, "linked-report.json"));

    const result = readLocalPilotReports(directory);
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(2);
    expect(JSON.stringify(result.issues)).not.toContain("customer-name-private");
    expect(JSON.stringify(result.issues)).not.toContain("secret");
    expect(result.issues.join(" ")).toContain("input-001");
    expect(result.issues.join(" ")).toContain("input-002");
  });

  it("accepts only explicit bounded CLI inputs", () => {
    expect(parseLocalPilotCohortArguments([
      "--reports", "/tmp/reports",
      "--manifest", "/tmp/manifest.json",
      "--output", "/tmp/cohort.json",
    ])).toEqual({
      reports: "/tmp/reports",
      manifest: "/tmp/manifest.json",
      output: "/tmp/cohort.json",
    });
    expect(() => parseLocalPilotCohortArguments(["--reports", "/tmp/reports"])).toThrow("--manifest is required");
    expect(() => parseLocalPilotCohortArguments(["--upload", "yes"])).toThrow("Unknown or incomplete");
  });

  it("runs the offline CLI end to end and writes a private aggregate receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "codelit-local-pilot-cli-"));
    const reports = join(root, "reports");
    const manifest = join(root, "manifest.json");
    const output = join(root, "cohort-receipt.json");
    mkdirSync(reports);
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(join(reports, `report-${index}.json`), JSON.stringify(pilotReport(index)));
    }
    writeFileSync(manifest, JSON.stringify(pilotManifest()));

    const result = spawnSync(process.execPath, [
      "apps/mac/scripts/check-local-pilot-cohort.mjs",
      "--reports", reports,
      "--manifest", manifest,
      "--output", output,
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("measurement-ready");
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    expect(receipt.inputs.uniqueParticipants).toBe(25);
    expect(receipt.privacy.containsParticipantIdentity).toBe(false);
    expect(statSync(output).mode & 0o777).toBe(0o600);
  });
});
