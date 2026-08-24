import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateFingerprint } from "../../apps/mac/scripts/desktop-candidate-qa.mjs";
import {
  createDesktopLocalReliabilityObservationDraft,
  createDesktopLocalReliabilityReceipt,
  desktopLocalReliabilityAttestation,
  desktopLocalReliabilityChecks,
  desktopLocalReliabilityReceiptIssues,
  expectedResourcePolicyMatrix,
  localReliabilityEvidenceFile,
  localReliabilityEvidenceFingerprint,
  observationsWithReliabilityEvidence,
  readResourcePolicyProbe,
  resourcePolicyProbeIssues,
} from "../../apps/mac/scripts/desktop-local-reliability.mjs";

function candidate() {
  return {
    channel: "direct",
    bundleIdentifier: "io.codelit.desktop",
    version: "0.1.1",
    build: "21",
    minimumSystemVersion: "14.0",
    source: { commit: "a".repeat(40), dirty: false },
    app: {
      cdHash: "b".repeat(40),
      executableSha256: "c".repeat(64),
      teamIdentifier: "AB12CD34EF",
      authorities: ["Developer ID Application: Codelit (AB12CD34EF)"],
      hardenedRuntime: true,
      sandboxed: false,
    },
    artifacts: [
      { role: "dmg", name: "Codelit.dmg", bytes: 42, sha256: "d".repeat(64) },
      { role: "updater-archive", name: "Codelit.app.tar.gz", bytes: 43, sha256: "e".repeat(64) },
    ],
  };
}

function resourceProbe() {
  const value = candidate();
  return {
    schemaVersion: 1,
    bundleIdentifier: value.bundleIdentifier,
    version: value.version,
    channel: value.channel,
    sourceCommit: value.source.commit,
    sourceDirty: false,
    executableSha256: value.app.executableSha256,
    live: {
      thermalState: "nominal",
      lowPowerMode: false,
      availableMemoryKnown: true,
      availableMemoryBytes: 18 * 1024 ** 3,
      maxParallel: 2,
    },
    matrix: structuredClone(expectedResourcePolicyMatrix),
  };
}

function evidence(id: string, index: number) {
  return { id, result: "passed", bytes: index + 1, sha256: String(index + 1).repeat(64) };
}

interface ReliabilityEvidence {
  id: string;
  result: string;
  bytes: number;
  sha256: string;
}

interface ReliabilityCheck {
  id: string;
  evidence: ReliabilityEvidence;
  resourceProbeEvidence?: ReliabilityEvidence;
  unlabelledControlCount?: number;
  medianCpuPercent?: number;
  idleRunStartCount?: number;
  resourceProbe?: {
    executableSha256: string;
    matrix: Array<{ id: string; maxParallel: number }>;
  };
  artifactCountsAfter?: Record<string, number>;
  secondLaunchAppliedRows?: number;
  completedActionCountAfterRelaunch?: number;
  automaticRetry?: boolean;
  provider?: string;
  providerRequestCount?: number;
}

interface ReliabilityReceipt {
  gate: string;
  status: string;
  durationMs: number;
  candidate: ReturnType<typeof candidate>;
  candidateFingerprint: string;
  checks: ReliabilityCheck[];
  evidenceFingerprint: string;
}

interface DraftCheck {
  id: string;
  durationSeconds?: number;
  peakResidentMiB?: number;
  resourceProbePath?: string;
  fromVersion?: string;
  migrationRowsApplied?: number;
}

function requiredCheck(value: ReliabilityReceipt, id: string) {
  const check = value.checks.find((candidateCheck) => candidateCheck.id === id);
  if (!check) throw new Error(`Missing test check ${id}.`);
  return check;
}

function receiptEvidence(value: ReliabilityReceipt) {
  return value.checks.flatMap((check) => check.id === "thermal-backpressure"
    ? [check.evidence, check.resourceProbeEvidence!]
    : [check.evidence]);
}

function checks() {
  const counts = {
    bots: 2,
    threads: 3,
    runs: 4,
    routines: 1,
    skills: 2,
    memories: 2,
    localTables: 1,
    browserSessions: 1,
  };
  return [
    {
      id: "assistive-access",
      keyboardOnlyCompleted: true,
      voiceOverCompleted: true,
      increasedContrastCompleted: true,
      reducedMotionCompleted: true,
      unlabelledControlCount: 0,
      focusOrderIssueCount: 0,
      blockedControlCount: 0,
      evidence: evidence("assistive-access", 0),
    },
    {
      id: "idle-energy",
      durationSeconds: 600,
      sampleCount: 60,
      medianCpuPercent: 0.4,
      p95CpuPercent: 1.2,
      peakResidentMiB: 340,
      unexpectedNetworkRequestCount: 0,
      idleRunStartCount: 0,
      evidence: evidence("idle-energy", 1),
    },
    {
      id: "thermal-backpressure",
      resourceProbe: resourceProbe(),
      resourceProbeEvidence: evidence("resource-policy-probe", 6),
      evidence: evidence("thermal-backpressure", 2),
    },
    {
      id: "two-version-migration",
      fromVersion: "0.1.0",
      fromBuild: "18",
      schemaVersionBefore: 18,
      schemaVersionAfter: 20,
      artifactCountsBefore: structuredClone(counts),
      artifactCountsAfter: structuredClone(counts),
      logicalExportSha256Before: "8".repeat(64),
      logicalExportSha256After: "8".repeat(64),
      migrationRowsApplied: 2,
      secondLaunchAppliedRows: 0,
      downgradeRefused: true,
      downgradeChangedData: false,
      evidence: evidence("two-version-migration", 3),
    },
    {
      id: "offline-local-run",
      networkBlocked: true,
      provider: "mlx",
      runStatus: "completed",
      automaticFallback: false,
      codelitRequestCount: 0,
      providerRequestCount: 0,
      receiptCount: 1,
      resultSha256: "9".repeat(64),
      evidence: evidence("offline-local-run", 4),
    },
    {
      id: "checkpoint-recovery",
      terminationPoint: "after-checkpoint",
      checkpointStep: 2,
      relaunchStatus: "interrupted",
      completedActionCountBefore: 1,
      completedActionCountAfterRelaunch: 1,
      automaticRetry: false,
      resumeStatus: "completed",
      duplicateActionCount: 0,
      receiptCountAfterResume: 2,
      finalOutputSha256: "a".repeat(64),
      evidence: evidence("checkpoint-recovery", 5),
    },
  ];
}

function receipt() {
  return createDesktopLocalReliabilityReceipt({
    candidate: candidate(),
    startedAt: "2026-08-20T15:00:00.000Z",
    completedAt: "2026-08-20T16:30:00.000Z",
    macOSVersion: "26.6.1",
    hardware: { model: "MacBookPro18,3", memoryGiB: 32, architecture: "arm64" },
    checks: checks(),
    signedAt: "2026-08-20T16:31:00.000Z",
  }) as ReliabilityReceipt;
}

describe("Codelit Mac local reliability qualification", () => {
  it("accepts the exact candidate-bound P7 reliability matrix", () => {
    const value = receipt();
    const proof = receiptEvidence(value);
    expect(value).toEqual(expect.objectContaining({
      gate: "p7-local-reliability",
      status: "passed",
      durationMs: 90 * 60 * 1_000,
      candidateFingerprint: candidateFingerprint(value.candidate),
      evidenceFingerprint: localReliabilityEvidenceFingerprint(proof),
    }));
    expect(desktopLocalReliabilityReceiptIssues(value, { candidate: value.candidate })).toEqual([]);
  });

  it("requires every reliability condition exactly once", () => {
    const value = receipt();
    value.checks = value.checks.filter((check) => check.id !== "offline-local-run");
    value.checks.push({ ...value.checks[0], id: "invented-check" });
    value.evidenceFingerprint = localReliabilityEvidenceFingerprint(receiptEvidence(value));
    expect(desktopLocalReliabilityReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The local reliability check offline-local-run must appear exactly once.",
      "The local reliability receipt contains an unexpected check.",
    ]));
  });

  it("rejects inaccessible controls and an active idle process", () => {
    const value = receipt();
    requiredCheck(value, "assistive-access").unlabelledControlCount = 1;
    const idle = requiredCheck(value, "idle-energy");
    idle.medianCpuPercent = 2;
    idle.idleRunStartCount = 1;
    expect(desktopLocalReliabilityReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The local reliability check assistive-access has invalid assistive journey.",
      "The local reliability check idle-energy has invalid median CPU, idle side effects.",
    ]));
  });

  it("binds the compiled resource policy to the candidate executable", () => {
    const value = receipt();
    const thermal = requiredCheck(value, "thermal-backpressure");
    thermal.resourceProbe!.executableSha256 = "f".repeat(64);
    const serious = thermal.resourceProbe!.matrix.find((entry) => entry.id === "serious");
    if (!serious) throw new Error("Missing serious resource test case.");
    serious.maxParallel = 1;
    expect(desktopLocalReliabilityReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The local reliability check thermal-backpressure has invalid resource probe: The resource-policy probe case serious is invalid., resource probe: The resource-policy probe belongs to different candidate bytes..",
    ]));
  });

  it("requires lossless idempotent migration and no-repeat recovery", () => {
    const value = receipt();
    const migration = requiredCheck(value, "two-version-migration");
    migration.artifactCountsAfter!.runs += 1;
    migration.secondLaunchAppliedRows = 1;
    const recovery = requiredCheck(value, "checkpoint-recovery");
    recovery.completedActionCountAfterRelaunch = 2;
    recovery.automaticRetry = true;
    expect(desktopLocalReliabilityReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The local reliability check two-version-migration has invalid artifact preservation, migration idempotency.",
      "The local reliability check checkpoint-recovery has invalid checkpoint recovery boundary.",
    ]));
  });

  it("rejects metered fallback and reused proof bundles", () => {
    const value = receipt();
    const offline = requiredCheck(value, "offline-local-run");
    offline.provider = "openai";
    offline.providerRequestCount = 1;
    value.checks[1].evidence.sha256 = value.checks[0].evidence.sha256;
    value.evidenceFingerprint = localReliabilityEvidenceFingerprint(receiptEvidence(value));
    expect(desktopLocalReliabilityReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The local reliability check offline-local-run has invalid offline run boundary.",
      "Each local reliability proof must use distinct evidence.",
    ]));
  });

  it("reads a bounded probe and rejects a changed source", () => {
    const directory = mkdtempSync(join(tmpdir(), "codelit-resource-probe-"));
    const path = join(directory, "probe.json");
    writeFileSync(path, JSON.stringify(resourceProbe()));
    const parsed = readResourcePolicyProbe(path, { candidate: candidate() });
    expect(parsed.evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.probe.matrix).toEqual(expectedResourcePolicyMatrix);
    const changed = structuredClone(resourceProbe());
    changed.sourceCommit = "f".repeat(40);
    expect(resourcePolicyProbeIssues(changed, { candidate: candidate() })).toContain(
      "The resource-policy probe belongs to different candidate bytes.",
    );
  });

  it("generates a complete operator draft without claiming measurements", () => {
    const draft = createDesktopLocalReliabilityObservationDraft() as { checks: DraftCheck[] };
    expect(draft.checks).toHaveLength(desktopLocalReliabilityChecks.length);
    expect(draft.checks.find((check) => check.id === "idle-energy")).toEqual(expect.objectContaining({
      durationSeconds: 300,
      peakResidentMiB: 0,
    }));
    expect(draft.checks.find((check) => check.id === "thermal-backpressure")?.resourceProbePath).toContain("resource-policy-probe.json");
    expect(draft.checks.find((check) => check.id === "two-version-migration")).toEqual(expect.objectContaining({
      fromVersion: "RECORD_PREVIOUS_VERSION",
      migrationRowsApplied: 0,
    }));
    expect(desktopLocalReliabilityAttestation).toContain("exact signed candidate");
  });

  it("rejects unknown observation IDs before reading any supplied path", () => {
    const draft = createDesktopLocalReliabilityObservationDraft() as { checks: Array<{ id: string }> };
    draft.checks[0].id = "invented-check";
    expect(() => observationsWithReliabilityEvidence(draft, { candidate: candidate() })).toThrow(
      "The local reliability check assistive-access must appear exactly once. The local reliability observations contain an unexpected check.",
    );
  });

  it("hashes proof bytes without retaining local paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "codelit-local-reliability-"));
    const path = join(directory, "offline.zip");
    writeFileSync(path, "offline evidence");
    const proof = localReliabilityEvidenceFile(path, "offline-local-run");
    expect(proof).toEqual(expect.objectContaining({ id: "offline-local-run", bytes: 16 }));
    expect(proof.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(proof)).not.toContain(directory);
  });
});
