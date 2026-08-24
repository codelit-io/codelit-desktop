import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidateFingerprint } from "../../apps/mac/scripts/desktop-candidate-qa.mjs";
import {
  createDesktopP1JourneyReceipt,
  desktopP1JourneyAttestation,
  desktopP1JourneyEvidence,
  desktopP1JourneyReceiptIssues,
  p1EvidenceFile,
  p1EvidenceFingerprint,
} from "../../apps/mac/scripts/desktop-p1-journey.mjs";

function candidate() {
  return {
    channel: "direct",
    bundleIdentifier: "io.codelit.desktop",
    version: "0.1.0",
    build: "1",
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

function evidence() {
  return desktopP1JourneyEvidence.map((entry, index) => ({
    id: entry.id,
    result: "passed",
    bytes: index + 1,
    sha256: String(index + 1).repeat(64),
  }));
}

function receipt() {
  return createDesktopP1JourneyReceipt({
    candidate: candidate(),
    startedAt: "2026-08-13T14:00:00.000Z",
    completedAt: "2026-08-13T14:04:30.000Z",
    macOSVersion: "26.6.1",
    host: "codelit.io",
    evidence: evidence(),
    signedAt: "2026-08-13T14:05:00.000Z",
  });
}

describe("Codelit Mac P1 candidate journey", () => {
  it("accepts the exact Direct candidate journey under five minutes", () => {
    const value = receipt();
    expect(value).toEqual(expect.objectContaining({
      gate: "p1-one-bot-real-work",
      status: "passed",
      durationMs: 270_000,
      candidateFingerprint: candidateFingerprint(value.candidate),
      evidenceFingerprint: p1EvidenceFingerprint(value.evidence),
    }));
    expect(desktopP1JourneyReceiptIssues(value, { candidate: value.candidate })).toEqual([]);
  });

  it("rejects a journey over five minutes and a non-public host", () => {
    const value = receipt();
    value.completedAt = "2026-08-13T14:05:01.000Z";
    value.durationMs = 301_000;
    value.journey.host = "localhost";

    expect(desktopP1JourneyReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The P1 journey must complete in under five minutes with an exact duration.",
      "The P1 journey must inspect one explicit public host.",
    ]));
  });

  it("fails closed if approval, browser, subscription, receipt, or relaunch proof changes", () => {
    const value = receipt();
    value.journey.approval = "persistent";
    value.journey.browser.mode = "write";
    value.journey.provider.id = "paid-api";
    value.journey.provider.noMeteredFallback = false;
    value.journey.receipt = "missing";
    value.journey.relaunchRestored = false;

    expect(desktopP1JourneyReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The P1 journey is missing its one-time in-window read proof.",
      "The P1 journey must complete with the signed-in Codex subscription and no metered fallback.",
      "The P1 journey must preserve the completed result and receipt after relaunch.",
    ]));
  });

  it("requires distinct evidence for every exact step", () => {
    const value = receipt();
    value.evidence[1].sha256 = value.evidence[0].sha256;
    value.evidence[2].result = "pending";
    value.evidenceFingerprint = p1EvidenceFingerprint(value.evidence);

    expect(desktopP1JourneyReceiptIssues(value)).toEqual(expect.arrayContaining([
      "The P1 journey evidence codex-result is incomplete.",
      "Each P1 journey step needs distinct evidence.",
    ]));
  });

  it("independently matches every supplied proof file digest", () => {
    const value = receipt();
    const exactEvidence = structuredClone(value.evidence);
    exactEvidence[0].sha256 = "f".repeat(64);

    expect(desktopP1JourneyReceiptIssues(value, { evidence: exactEvidence })).toContain(
      "The P1 journey evidence does not match the supplied proof files.",
    );
  });

  it("binds the journey to exact candidate bytes while tolerating artifact renaming", () => {
    const value = receipt();
    const renamed = structuredClone(value.candidate);
    renamed.artifacts[0].name = "codelit-0.1.0.dmg";
    expect(desktopP1JourneyReceiptIssues(value, { candidate: renamed })).toEqual([]);

    renamed.artifacts[0].sha256 = "0".repeat(64);
    expect(desktopP1JourneyReceiptIssues(value, { candidate: renamed })).toContain(
      "The P1 journey belongs to different signed artifacts.",
    );
  });

  it("rejects a self-consistent receipt for an unsigned or dirty candidate", () => {
    const value = receipt();
    value.candidate.source.dirty = true;
    value.candidate.app.authorities = ["-" as string];
    value.candidateFingerprint = candidateFingerprint(value.candidate);

    expect(desktopP1JourneyReceiptIssues(value)).toContain(
      "The P1 journey is missing a valid Developer ID-signed Direct candidate.",
    );
  });

  it("hashes bounded regular evidence without retaining its path", () => {
    const directory = mkdtempSync(join(tmpdir(), "codelit-p1-evidence-"));
    const path = join(directory, "approval.png");
    writeFileSync(path, "approval evidence");
    const value = p1EvidenceFile(path, "allow-once");

    expect(value).toEqual(expect.objectContaining({
      id: "allow-once",
      result: "passed",
      bytes: 17,
    }));
    expect(value.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(value)).not.toContain(directory);
  });

  it("requires an attestation after completion", () => {
    const value = receipt();
    expect(value.attestation.statement).toBe(desktopP1JourneyAttestation);
    value.attestation.signedAt = "2026-08-13T13:59:00.000Z";
    expect(desktopP1JourneyReceiptIssues(value)).toContain(
      "The P1 journey attestation cannot precede completion.",
    );
  });
});
