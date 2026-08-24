import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeCandidateArchiveEntries,
  candidateFingerprint,
  candidateQaAttestation,
  candidateQaPreflightAttestation,
  candidateQaMemoryClasses,
  candidateQaReceiptIssues,
  createCandidateQaDraft,
  requiredCandidateQaChecks,
  signedAppStoreReleaseIdentity,
} from "../../apps/mac/scripts/desktop-candidate-qa.mjs";
import {
  appStoreCandidateQaStage,
  appStoreDeliveryPlan,
  submitAppStoreBuild,
  writeDeliveryReceipt,
} from "../../apps/mac/scripts/submit-app-store-build.mjs";

function candidate(channel: "direct" | "app-store") {
  return {
    channel,
    bundleIdentifier: "io.codelit.desktop",
    version: "0.1.0",
    build: "1",
    minimumSystemVersion: "14.0",
    source: { commit: "a".repeat(40), dirty: false },
    app: {
      cdHash: "b".repeat(40),
      executableSha256: "c".repeat(64),
      teamIdentifier: "AB12CD34EF",
      authorities: channel === "direct"
        ? ["Developer ID Application: Codelit (AB12CD34EF)"]
        : ["3rd Party Mac Developer Application: Codelit (AB12CD34EF)"],
      hardenedRuntime: channel === "direct",
      sandboxed: channel === "app-store",
    },
    ...(channel === "app-store"
      ? { package: { authority: "3rd Party Mac Developer Installer: Codelit (AB12CD34EF)" } }
      : {}),
    artifacts: channel === "direct"
      ? [
        { role: "dmg", name: "Codelit.dmg", bytes: 42, sha256: "d".repeat(64) },
        { role: "updater-archive", name: "Codelit.app.tar.gz", bytes: 43, sha256: "e".repeat(64) },
      ]
      : [{ role: "app-store-package", name: "Codelit.pkg", bytes: 44, sha256: "f".repeat(64) }],
  };
}

function receipt(channel: "direct" | "app-store") {
  const exactCandidate = candidate(channel);
  return {
    schemaVersion: 2,
    status: "passed",
    channel,
    preflightCompletedAt: "2026-08-12T11:00:00.000Z",
    completedAt: "2026-08-12T12:00:00.000Z",
    candidate: exactCandidate,
    candidateFingerprint: candidateFingerprint(exactCandidate),
    environmentCoverage: candidateQaMemoryClasses.map((environment) => ({
      memoryClass: environment.id,
      memoryGiB: environment.memoryGiB,
      architecture: "arm64",
      osClass: environment.osClass,
      macOSVersion: environment.osClass === "minimum" ? "14.7" : environment.osClass === "previous" ? "15.7" : "26.6.1",
      result: "passed",
      localModel: environment.localModel,
      evidence: "1".repeat(64),
    })),
    checks: requiredCandidateQaChecks(channel).map((check) => ({
      ...check,
      result: "passed",
      evidence: "2".repeat(64),
    })),
    attestation: {
      preflight: {
        role: "release-owner",
        statement: candidateQaPreflightAttestation,
        signedAt: "2026-08-12T11:00:00.000Z",
      },
      release: {
        role: "release-owner",
        statement: candidateQaAttestation,
        signedAt: "2026-08-12T12:00:00.000Z",
      },
    },
  };
}

describe("Codelit Mac signed-candidate QA", () => {
  it("creates a pending, exact-candidate receipt without inventing evidence", () => {
    const value = createCandidateQaDraft(candidate("app-store"));
    expect(value).toEqual(expect.objectContaining({
      schemaVersion: 2,
      status: "pending",
      preflightCompletedAt: null,
      completedAt: null,
    }));
    expect(value.environmentCoverage).toHaveLength(5);
    expect(value.environmentCoverage.every((entry) => entry.result === "pending" && entry.evidence === "")).toBe(true);
    expect(value.checks.every((check) => check.result === "pending" && check.evidence === "")).toBe(true);
    expect(value.attestation.preflight.signedAt).toBeNull();
    expect(value.attestation.release.signedAt).toBeNull();
  });

  it.each(["direct", "app-store"] as const)("accepts one complete %s receipt", (channel) => {
    const value = receipt(channel);
    expect(candidateQaReceiptIssues(value, { candidate: value.candidate })).toEqual([]);
  });

  it("binds the receipt to the exact signed artifacts", () => {
    const value = receipt("direct");
    const rebuilt = structuredClone(value.candidate);
    rebuilt.artifacts[0].sha256 = "0".repeat(64);

    expect(candidateQaReceiptIssues(value, { candidate: rebuilt })).toContain(
      "The signed-candidate QA receipt belongs to different release artifacts.",
    );
    value.candidate.artifacts[0].sha256 = "0".repeat(64);
    expect(candidateQaReceiptIssues(value)).toContain("The signed-candidate QA fingerprint is invalid.");
  });

  it("allows immutable packaging names while preserving exact artifact bytes", () => {
    const value = receipt("direct");
    const packaged = structuredClone(value.candidate);
    packaged.artifacts[0].name = "codelit-0.1.0.dmg";
    packaged.artifacts[1].name = "codelit-0.1.0.app.tar.gz";

    expect(candidateQaReceiptIssues(value, { candidate: packaged })).toEqual([]);
  });

  it("rejects unsafe or ambiguous updater archive layouts before extraction", () => {
    expect(() => assertSafeCandidateArchiveEntries(["Codelit.app/Contents/Info.plist"])).not.toThrow();
    expect(() => assertSafeCandidateArchiveEntries(["../Codelit.app/Contents/Info.plist"])).toThrow(/unsafe path/);
    expect(() => assertSafeCandidateArchiveEntries(["Codelit.app/Contents/Info.plist", "extra.txt"])).toThrow(/only one top-level/);
    expect(() => assertSafeCandidateArchiveEntries(["Codelit.app\\Contents\\Info.plist"])).toThrow(/invalid path/);
  });

  it("reads source identity from a regular signed App Store bundle resource", () => {
    const root = mkdtempSync(join(tmpdir(), "codelit-release-identity-"));
    const resources = join(root, "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "codelit-release-identity.json"), JSON.stringify({
      schemaVersion: 1,
      channel: "app-store",
      sourceCommit: "a".repeat(40),
      sourceDirty: false,
    }));

    expect(signedAppStoreReleaseIdentity(root)).toEqual({
      schemaVersion: 1,
      channel: "app-store",
      sourceCommit: "a".repeat(40),
      sourceDirty: false,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed on invalid or symlinked App Store release identity", () => {
    const root = mkdtempSync(join(tmpdir(), "codelit-release-identity-"));
    const resources = join(root, "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    const identity = join(resources, "codelit-release-identity.json");
    writeFileSync(identity, JSON.stringify({ schemaVersion: 1, channel: "direct" }));
    expect(() => signedAppStoreReleaseIdentity(root)).toThrow(/invalid signed release identity/);

    const outside = join(root, "identity.json");
    writeFileSync(outside, JSON.stringify({ schemaVersion: 1, channel: "direct" }));
    rmSync(identity);
    symlinkSync(outside, identity);

    expect(() => signedAppStoreReleaseIdentity(root)).toThrow(/missing its signed release identity/);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed on missing environments, evidence, and attestations", () => {
    const value = receipt("app-store");
    value.environmentCoverage = value.environmentCoverage.filter((entry) => entry.memoryClass !== "16-gb");
    value.checks[0].evidence = "";
    value.attestation.release.signedAt = null as unknown as string;
    const issues = candidateQaReceiptIssues(value);

    expect(issues).toContain("The signed-candidate QA receipt needs exactly one 16-gb environment.");
    expect(issues).toContain(`The signed-candidate QA check ${value.checks[0].id} is incomplete.`);
    expect(issues).toContain("The signed-candidate QA receipt is missing its release attestation.");
  });

  it("rejects renamed checklist items and impossible timestamp ordering", () => {
    const value = receipt("direct");
    value.checks[0].label = "Something easier";
    value.completedAt = "2026-08-12T10:00:00.000Z";

    const issues = candidateQaReceiptIssues(value);
    expect(issues).toContain(`The signed-candidate QA check ${value.checks[0].id} is incomplete.`);
    expect(issues).toContain("Release completion cannot precede candidate preflight.");
  });

  it("permits TestFlight upload only after preflight and still blocks release", () => {
    const value = receipt("app-store");
    value.status = "testflight-ready";
    value.completedAt = null as unknown as string;
    for (const environment of value.environmentCoverage) {
      environment.macOSVersion = "RECORD_EXACT_VERSION";
      environment.result = "pending";
      environment.evidence = "";
    }
    for (const check of value.checks) {
      check.result = "pending";
      check.evidence = "";
    }
    value.attestation.release.signedAt = null as unknown as string;

    expect(candidateQaReceiptIssues(value, { candidate: value.candidate, stage: appStoreCandidateQaStage })).toEqual([]);
    expect(candidateQaReceiptIssues(value, { candidate: value.candidate })).toContain(
      "The signed-candidate QA receipt has not passed the required stage.",
    );
  });

  it("keeps unproven model classes unavailable while requiring the measured 32 GB pass", () => {
    const value = receipt("direct");
    value.environmentCoverage.find((entry) => entry.memoryClass === "16-gb")!.localModel = "passed";
    value.environmentCoverage.find((entry) => entry.memoryClass === "32-gb")!.localModel = "unavailable-as-designed";

    const issues = candidateQaReceiptIssues(value);
    expect(issues).toContain("The signed-candidate QA environment 16-gb is incomplete or inconsistent.");
    expect(issues).toContain("The signed-candidate QA environment 32-gb is incomplete or inconsistent.");
  });

  it("requires channel-specific release proof", () => {
    expect(requiredCandidateQaChecks("direct").map((check) => check.id)).toContain("direct-update-rollback");
    expect(requiredCandidateQaChecks("app-store").map((check) => check.id)).toContain("testflight-install-update");
    expect(requiredCandidateQaChecks("app-store").map((check) => check.id)).not.toContain("direct-scheduler");
  });

  it("validates before and only uploads on an explicit upload action", () => {
    const authentication = ["--api-key", "KEY", "--api-issuer", "ISSUER"];
    expect(appStoreDeliveryPlan({ upload: false, packagePath: "/tmp/Codelit.pkg", authentication })).toEqual([
      ["--validate-app", "/tmp/Codelit.pkg", ...authentication],
    ]);
    expect(appStoreDeliveryPlan({ upload: true, packagePath: "/tmp/Codelit.pkg", authentication })).toEqual([
      ["--validate-app", "/tmp/Codelit.pkg", ...authentication],
      ["--upload-package", "/tmp/Codelit.pkg", "--wait", ...authentication],
    ]);
    expect(() => submitAppStoreBuild(["--upload"], { NODE_ENV: "test" })).toThrow(/--output is required/);
  });

  it("rewrites a delivery receipt from byte zero without sparse padding", () => {
    const root = mkdtempSync(join(tmpdir(), "codelit-app-store-receipt-"));
    const path = join(root, "delivery.json");
    const file = openSync(path, "wx", 0o600);
    try {
      writeDeliveryReceipt(file, { status: "started", detail: "x".repeat(1_000) });
      writeDeliveryReceipt(file, { status: "failed" });
      const contents = readFileSync(path, "utf8");
      expect(contents).toBe(`${JSON.stringify({ status: "failed" }, null, 2)}\n`);
      expect(JSON.parse(contents)).toEqual({ status: "failed" });
    } finally {
      closeSync(file);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
