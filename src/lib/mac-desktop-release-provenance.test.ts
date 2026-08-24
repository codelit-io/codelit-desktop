import { describe, expect, it } from "vitest";
import {
  assertImmutableArtifactUrl,
  assertIsoTimestamp,
  assertVersionAdvances,
  buildReleaseDocuments,
  canonicalUpdatePayload,
  compareStableVersions,
  directArtifactNames,
  immutableArtifactUrl,
  normalizeReleaseNotes,
  parseStableVersion,
} from "../../apps/mac/scripts/desktop-release-provenance.mjs";
import { prepareDesktopRelease } from "../../apps/mac/scripts/prepare-desktop-release.mjs";

const commit = "a".repeat(40);
const timestamp = "2026-08-12T12:00:00.000Z";
const signedEnvelope = Buffer.from("signed-release-envelope").toString("base64");

function artifact(version: string, name: string) {
  return {
    name,
    url: immutableArtifactUrl(version, name),
    bytes: 42,
    sha256: "b".repeat(64),
  };
}

function qualificationArtifact(version: string, name: string, gate: string) {
  return {
    ...artifact(version, name),
    gate,
    candidateFingerprint: "c".repeat(64),
  };
}

function documents(version = "2.1.0", qualificationOverrides = {}) {
  const names = directArtifactNames(version);
  const archive = {
    ...artifact(version, names.archive),
    signature: artifact(version, names.signature),
  };
  const signature = "signed-updater-manifest-value";
  const qa = {
    ...artifact(version, names.qa),
    candidateFingerprint: "c".repeat(64),
  };
  const qualification = {
    p1Journey: qualificationArtifact(version, names.p1Journey, "p1-one-bot-real-work"),
    computerLifecycle: qualificationArtifact(version, names.computerLifecycle, "p5-computer-lifecycle"),
    localReliability: qualificationArtifact(version, names.localReliability, "p7-local-reliability"),
    ...qualificationOverrides,
  };
  const signedManifest = {
    signedPayload: canonicalUpdatePayload({
      version,
      notes: "A bounded desktop release.",
      timestamp,
      archiveUrl: archive.url,
      archiveSignature: signature,
    }).toString("base64"),
    signature: signedEnvelope,
  };
  return buildReleaseDocuments({
    version,
    notes: "A bounded desktop release.",
    timestamp,
    commit,
    archive,
    signature,
    dmg: artifact(version, names.dmg),
    qa,
    ...qualification,
    sbom: artifact(version, names.sbom),
    provenance: artifact(version, names.provenance),
    provenanceSignature: artifact(version, names.provenanceSignature),
    signedManifest,
    rollback: null,
    tools: { node: "v24", rustc: "rustc", cargo: "cargo", xcode: "Xcode", tauriCli: "2.11.4" },
  });
}

describe("Codelit for Mac release provenance", () => {
  it("requires every focused qualification receipt before release preparation", () => {
    const arguments_ = [
      "--artifact", "archive.tar.gz",
      "--signature", "archive.tar.gz.sig",
      "--dmg", "candidate.dmg",
      "--notes-file", "notes.md",
      "--qa-receipt", "candidate-qa.json",
      "--p1-receipt", "p1.json",
      "--computer-lifecycle-receipt", "computer.json",
      "--reliability-receipt", "reliability.json",
      "--initial-release",
    ];
    for (const option of ["--p1-receipt", "--computer-lifecycle-receipt", "--reliability-receipt"]) {
      const index = arguments_.indexOf(option);
      const withoutReceipt = [...arguments_.slice(0, index), ...arguments_.slice(index + 2)];
      expect(() => prepareDesktopRelease(withoutReceipt)).toThrow(`${option} is required.`);
    }
  });

  it("compares stable versions numerically and requires forward releases", () => {
    expect(compareStableVersions("1.10.0", "1.9.99")).toBe(1);
    expect(compareStableVersions("3.0.0", "3.0.0")).toBe(0);
    expect(compareStableVersions("2.0.9", "2.1.0")).toBe(-1);
    expect(() => assertVersionAdvances("2.0.1", "2.0.0")).not.toThrow();
    expect(() => assertVersionAdvances("2.0.0", "2.0.0")).toThrow(/must be newer/);
    expect(() => parseStableVersion("2.0.0-beta.1")).toThrow(/stable X.Y.Z/);
  });

  it("normalizes human-readable notes and rejects ambiguous timestamps", () => {
    expect(normalizeReleaseNotes("  First line.\r\nSecond line.  ")).toBe("First line.\nSecond line.");
    expect(() => normalizeReleaseNotes("bad\u0000notes")).toThrow(/control/);
    expect(() => normalizeReleaseNotes(" ")).toThrow(/empty/);
    expect(assertIsoTimestamp(timestamp)).toBe(timestamp);
    expect(() => assertIsoTimestamp("2026-08-12")).toThrow(/ISO-8601/);
  });

  it("emits the one exact Apple Silicon updater target and immutable URLs", () => {
    const result = documents();
    const qa = {
      ...artifact("2.1.0", directArtifactNames("2.1.0").qa),
      candidateFingerprint: "c".repeat(64),
    };
    expect(result.latest).toEqual(expect.objectContaining({
      version: "2.1.0",
      pub_date: timestamp,
      platforms: {
        "darwin-aarch64-app": {
          url: immutableArtifactUrl("2.1.0", directArtifactNames("2.1.0").archive),
          signature: "signed-updater-manifest-value",
        },
      },
    }));
    expect(result.release.publication.order).toEqual(["immutable-assets", "latest.json"]);
    expect(result.latest.codelit).toEqual(expect.objectContaining({
      signedPayload: expect.any(String),
      signature: signedEnvelope,
    }));
    expect(result.release.updateManifest).toEqual({
      payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      signatureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.release.artifacts.qa).toEqual(qa);
    expect(result.release.artifacts.qualification).toEqual({
      p1Journey: qualificationArtifact("2.1.0", directArtifactNames("2.1.0").p1Journey, "p1-one-bot-real-work"),
      computerLifecycle: qualificationArtifact(
        "2.1.0",
        directArtifactNames("2.1.0").computerLifecycle,
        "p5-computer-lifecycle",
      ),
      localReliability: qualificationArtifact(
        "2.1.0",
        directArtifactNames("2.1.0").localReliability,
        "p7-local-reliability",
      ),
    });
    expect(result.provenance.predicate.candidateQa).toEqual({
      fingerprint: qa.candidateFingerprint,
      digest: { sha256: qa.sha256 },
      bytes: qa.bytes,
    });
    expect(result.provenance.predicate.focusedQualification).toEqual({
      p1Journey: {
        gate: "p1-one-bot-real-work",
        fingerprint: "c".repeat(64),
        digest: { sha256: "b".repeat(64) },
        bytes: 42,
      },
      computerLifecycle: {
        gate: "p5-computer-lifecycle",
        fingerprint: "c".repeat(64),
        digest: { sha256: "b".repeat(64) },
        bytes: 42,
      },
      localReliability: {
        gate: "p7-local-reliability",
        fingerprint: "c".repeat(64),
        digest: { sha256: "b".repeat(64) },
        bytes: 42,
      },
    });
    expect(result.provenance.subject.map((subject: { name: string }) => subject.name)).toEqual([
      directArtifactNames("2.1.0").archive,
      directArtifactNames("2.1.0").dmg,
      directArtifactNames("2.1.0").qa,
      directArtifactNames("2.1.0").p1Journey,
      directArtifactNames("2.1.0").computerLifecycle,
      directArtifactNames("2.1.0").localReliability,
    ]);
    expect(result.provenance.predicate.source).toEqual(expect.objectContaining({ commit, dirty: false }));
    expect(result.provenance.predicate.signing).toEqual(expect.objectContaining({
      hardenedRuntime: true,
      notarization: "stapled",
      updater: "minisign-verified",
    }));
    expect(result.provenance.predicate.releaseNotesSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses mutable or credential-bearing artifact URLs", () => {
    const name = directArtifactNames("2.1.0").dmg;
    const good = immutableArtifactUrl("2.1.0", name);
    expect(() => assertImmutableArtifactUrl(good, "2.1.0", name)).not.toThrow();
    expect(() => assertImmutableArtifactUrl(good.replace("v2.1.0", "latest"), "2.1.0", name)).toThrow(/immutable/);
    expect(() => assertImmutableArtifactUrl(`${good}?token=secret`, "2.1.0", name)).toThrow(/credential-free/);
  });

  it("refuses missing or cross-candidate focused qualification", () => {
    expect(() => documents("2.1.0", { p1Journey: undefined })).toThrow(/P1 journey artifact/);
    expect(() => documents("2.1.0", {
      localReliability: {
        ...qualificationArtifact(
          "2.1.0",
          directArtifactNames("2.1.0").localReliability,
          "p7-local-reliability",
        ),
        candidateFingerprint: "d".repeat(64),
      },
    })).toThrow(/Local reliability artifact/);
  });

  it("represents rollback only as a newer release restoring an older commit", () => {
    const names = directArtifactNames("2.1.0");
    const archive = { ...artifact("2.1.0", names.archive), signature: artifact("2.1.0", names.signature) };
    const signature = "signed-updater-manifest-value";
    const qa = {
      ...artifact("2.1.0", names.qa),
      candidateFingerprint: "c".repeat(64),
    };
    const qualification = {
      p1Journey: qualificationArtifact("2.1.0", names.p1Journey, "p1-one-bot-real-work"),
      computerLifecycle: qualificationArtifact("2.1.0", names.computerLifecycle, "p5-computer-lifecycle"),
      localReliability: qualificationArtifact("2.1.0", names.localReliability, "p7-local-reliability"),
    };
    const signedManifest = {
      signedPayload: canonicalUpdatePayload({
        version: "2.1.0",
        notes: "Restore the proven 2.0 behavior.",
        timestamp,
        archiveUrl: archive.url,
        archiveSignature: signature,
      }).toString("base64"),
      signature: signedEnvelope,
    };
    const create = (restoresVersion: string) => buildReleaseDocuments({
      version: "2.1.0",
      notes: "Restore the proven 2.0 behavior.",
      timestamp,
      commit,
      archive,
      signature,
      dmg: artifact("2.1.0", names.dmg),
      qa,
      ...qualification,
      sbom: artifact("2.1.0", names.sbom),
      provenance: artifact("2.1.0", names.provenance),
      provenanceSignature: artifact("2.1.0", names.provenanceSignature),
      signedManifest,
      rollback: { restoresVersion, restoresCommit: "c".repeat(40) },
      tools: {},
    });
    expect(create("2.0.0").release.rollback).toEqual({
      strategy: "forward-release",
      restoresVersion: "2.0.0",
      restoresCommit: "c".repeat(40),
    });
    expect(() => create("2.1.0")).toThrow(/older release/);
    expect(() => create("3.0.0")).toThrow(/older release/);
  });
});
