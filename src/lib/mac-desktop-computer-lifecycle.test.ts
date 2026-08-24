import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateFingerprint } from "../../apps/mac/scripts/desktop-candidate-qa.mjs";
import {
  computerLifecycleEvidenceFile,
  computerLifecycleEvidenceFingerprint,
  createDesktopComputerLifecycleObservationDraft,
  createDesktopComputerLifecycleReceipt,
  desktopComputerLifecycleAttestation,
  desktopComputerLifecycleChecks,
  desktopComputerLifecycleReceiptIssues,
} from "../../apps/mac/scripts/desktop-computer-lifecycle.mjs";

function candidate() {
  return {
    channel: "direct",
    bundleIdentifier: "io.codelit.desktop",
    version: "0.1.1",
    build: "6",
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

interface LifecycleEvidence {
  id: string;
  result: string;
  bytes: number;
  sha256: string;
}

interface LifecycleCheck {
  id: string;
  actionDispatched: boolean;
  runStatus: string;
  environmentStatus: string;
  continuity: string;
  topology: string;
  actionOutcome: string;
  proofCount: number;
  activeDisplayCount: number;
  recoveredStatus: string;
  automaticRetry: boolean;
  evidence: LifecycleEvidence;
}

interface LifecycleExpectation {
  id: string;
  actionDispatched: boolean;
  runStatus: string;
  environmentStatus: string;
  continuity: string;
  topology: string;
  actionOutcome: string;
  proofCount: number;
  minimumDisplayCount: number;
}

interface LifecycleReceipt {
  gate: string;
  status: string;
  durationMs: number;
  candidate: ReturnType<typeof candidate>;
  candidateFingerprint: string;
  checks: LifecycleCheck[];
  evidenceFingerprint: string;
}

function checks(): LifecycleCheck[] {
  return desktopComputerLifecycleChecks.map((check: LifecycleExpectation, index: number) => ({
    id: check.id,
    actionDispatched: check.actionDispatched,
    runStatus: check.runStatus,
    environmentStatus: check.environmentStatus,
    continuity: check.continuity,
    topology: check.topology,
    actionOutcome: check.actionOutcome,
    proofCount: check.proofCount,
    activeDisplayCount: check.minimumDisplayCount,
    recoveredStatus: "ready",
    automaticRetry: false,
    evidence: {
      id: check.id,
      result: "passed",
      bytes: index + 1,
      sha256: (index + 1).toString(16).repeat(64),
    },
  }));
}

function receipt() {
  return createDesktopComputerLifecycleReceipt({
    candidate: candidate(),
    startedAt: "2026-08-20T14:00:00.000Z",
    completedAt: "2026-08-20T14:45:00.000Z",
    macOSVersion: "26.6.1",
    targetApp: { name: "TextEdit", bundleId: "com.apple.TextEdit" },
    checks: checks(),
    signedAt: "2026-08-20T14:46:00.000Z",
  }) as LifecycleReceipt;
}

describe("Codelit Mac computer lifecycle qualification", () => {
  it("accepts the exact candidate-bound lifecycle matrix", () => {
    const value = receipt();
    expect(value).toEqual(expect.objectContaining({
      gate: "p5-computer-lifecycle",
      status: "passed",
      durationMs: 45 * 60 * 1_000,
      candidateFingerprint: candidateFingerprint(value.candidate),
      evidenceFingerprint: computerLifecycleEvidenceFingerprint(value.checks.map((check) => check.evidence)),
    }));
    expect(desktopComputerLifecycleReceiptIssues(value, { candidate: value.candidate })).toEqual([]);
  });

  it("requires every lifecycle condition exactly once", () => {
    const value = receipt();
    value.checks = value.checks.filter((check) => check.id !== "locked-session");
    value.checks.push({ ...value.checks[0], id: "invented-check" });
    value.evidenceFingerprint = computerLifecycleEvidenceFingerprint(value.checks.map((check) => check.evidence));

    expect(desktopComputerLifecycleReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The computer lifecycle check locked-session must appear exactly once.",
      "The computer lifecycle receipt contains an unexpected check.",
    ]));
  });

  it("rejects a dispatched lock check and an automatic sleep retry", () => {
    const value = receipt();
    const locked = value.checks.find((check) => check.id === "locked-session")!;
    locked.actionDispatched = true;
    const sleep = value.checks.find((check) => check.id === "sleep-wake")!;
    sleep.automaticRetry = true;

    expect(desktopComputerLifecycleReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The computer lifecycle check locked-session has invalid dispatch state.",
      "The computer lifecycle check sleep-wake has invalid automatic retry state.",
    ]));
  });

  it("requires two active displays and truthful interrupted outcomes", () => {
    const value = receipt();
    const multi = value.checks.find((check) => check.id === "stable-multi-display")!;
    multi.activeDisplayCount = 1;
    const topology = value.checks.find((check) => check.id === "display-topology-change")!;
    topology.actionOutcome = "completed";
    topology.proofCount = 2;

    expect(desktopComputerLifecycleReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The computer lifecycle check stable-multi-display has invalid active display count.",
      "The computer lifecycle check display-topology-change has invalid action outcome, proof count.",
    ]));
  });

  it("rejects reused evidence and independently matches every proof file", () => {
    const value = receipt();
    value.checks[1].evidence.sha256 = value.checks[0].evidence.sha256;
    value.evidenceFingerprint = computerLifecycleEvidenceFingerprint(value.checks.map((check) => check.evidence));
    const exactEvidence = structuredClone(value.checks.map((check) => check.evidence));
    exactEvidence[2].sha256 = "f".repeat(64);

    expect(desktopComputerLifecycleReceiptIssues(value, { evidence: exactEvidence })).toEqual(expect.arrayContaining([
      "Each computer lifecycle check needs distinct evidence.",
      "The computer lifecycle receipt does not match the supplied proof files.",
    ]));
  });

  it("binds observations and candidate bytes independently", () => {
    const value = receipt();
    const exactChecks = structuredClone(value.checks);
    exactChecks[0].runStatus = "failed-before-action";
    const changedCandidate = structuredClone(value.candidate);
    changedCandidate.artifacts[0].sha256 = "0".repeat(64);

    expect(desktopComputerLifecycleReceiptIssues(value, {
      candidate: changedCandidate,
      checks: exactChecks,
    })).toEqual(expect.arrayContaining([
      "The computer lifecycle receipt belongs to different signed artifacts.",
      "The computer lifecycle receipt does not match the supplied observations.",
    ]));
  });

  it("hashes bounded regular proof bundles without retaining local paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "codelit-computer-lifecycle-"));
    const path = join(directory, "sleep-wake.zip");
    writeFileSync(path, "sleep wake evidence");
    const evidence = computerLifecycleEvidenceFile(path, "sleep-wake");

    expect(evidence).toEqual(expect.objectContaining({
      id: "sleep-wake",
      result: "passed",
      bytes: 19,
    }));
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain(directory);
  });

  it("generates a complete operator draft with fixed safe expectations", () => {
    const draft = createDesktopComputerLifecycleObservationDraft() as {
      checks: Array<Omit<LifecycleCheck, "evidence"> & { evidencePath: string }>;
    };
    expect(draft.checks).toHaveLength(desktopComputerLifecycleChecks.length);
    expect(draft.checks.find((check) => check.id === "stable-multi-display")).toEqual(expect.objectContaining({
      activeDisplayCount: 2,
      runStatus: "completed",
      automaticRetry: false,
    }));
    expect(draft.checks.find((check) => check.id === "accessibility-revoked")).toEqual(expect.objectContaining({
      actionDispatched: false,
      environmentStatus: "accessibility-required",
      actionOutcome: "unchanged",
    }));
    expect(draft.checks.find((check) => check.id === "locked-session")).toEqual(expect.objectContaining({
      activeDisplayCount: 0,
      environmentStatus: "locked",
    }));
    expect(desktopComputerLifecycleAttestation).toContain("exact signed Direct candidate");
  });
});
