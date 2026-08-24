import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLatestPointerPrecondition,
  buildImmutablePublicationReceipt,
  directReleaseRepositorySlug,
  draftReleaseIssues,
  immutableDirectReleaseNames,
  immutablePublicationReceiptIssues,
  latestPointerUpdate,
  missingDraftReleaseAssets,
  readDirectReleasePublication,
  remoteReleaseIssues,
  repositoryPublicationIssues,
} from "../../apps/mac/scripts/direct-release-publication.mjs";
import { parseDirectPublicationArguments } from "../../apps/mac/scripts/direct-release-github.mjs";

const version = "2.1.0";
const commit = "a".repeat(40);

function publicationFixture() {
  const directory = mkdtempSync(join(tmpdir(), "codelit-direct-publication-"));
  const names = immutableDirectReleaseNames(version);
  for (const name of names) writeFileSync(join(directory, name), `${name}\n`);
  writeFileSync(join(directory, "release.json"), `${JSON.stringify({
    schemaVersion: 1,
    channel: "direct",
    version,
    notes: "A verified release.",
    source: { commit },
    publication: { immutableTag: `v${version}` },
  })}\n`);
  writeFileSync(join(directory, "latest.json"), `${JSON.stringify({ version })}\n`);
  return readDirectReleasePublication(directory);
}

function repository() {
  return {
    id: 42,
    full_name: directReleaseRepositorySlug,
    private: false,
    visibility: "public",
    default_branch: "main",
  };
}

function immutableSettings() {
  return { enabled: true, enforced_by_owner: false };
}

function remoteRelease(publication: ReturnType<typeof publicationFixture>) {
  return {
    id: 84,
    tag_name: publication.tag,
    draft: false,
    prerelease: false,
    immutable: true,
    name: `Codelit for Mac ${publication.version}`,
    body: publication.notes,
    html_url: `https://github.com/${directReleaseRepositorySlug}/releases/tag/${publication.tag}`,
    published_at: "2026-08-12T18:00:00Z",
    assets: publication.assets.map((asset) => ({
      name: asset.name,
      size: asset.bytes,
      digest: `sha256:${asset.sha256}`,
      browser_download_url: asset.url,
    })),
  };
}

describe("Codelit for Mac Direct release publication", () => {
  it("keeps the update pointer out of the immutable asset release", () => {
    const names = immutableDirectReleaseNames(version);
    expect(names).toHaveLength(12);
    expect(names).toEqual(expect.arrayContaining([
      "codelit-2.1.0-p1-journey.json",
      "codelit-2.1.0-computer-lifecycle.json",
      "codelit-2.1.0-local-reliability.json",
    ]));
    expect(names).toContain("release.json");
    expect(names).toContain("SHA256SUMS");
    expect(names).not.toContain("latest.json");
  });

  it("requires a public main-branch repository with immutable releases enabled", () => {
    expect(repositoryPublicationIssues(repository(), immutableSettings())).toEqual([]);
    expect(repositoryPublicationIssues(
      { ...repository(), private: true, visibility: "private", default_branch: "trunk" },
      { enabled: false },
    )).toEqual(expect.arrayContaining([
      "The Direct release repository must be public.",
      "The Direct release repository default branch must be main.",
      "GitHub immutable releases must be enabled before publishing.",
    ]));
  });

  it("binds every immutable GitHub asset by name, bytes, digest, and URL", () => {
    const publication = publicationFixture();
    const remote = remoteRelease(publication);
    expect(remoteReleaseIssues(remote, publication)).toEqual([]);

    remote.assets[0].digest = `sha256:${"0".repeat(64)}`;
    expect(remoteReleaseIssues(remote, publication)).toContain(
      `The GitHub asset ${remote.assets[0].name} does not match the local release.`,
    );
    remote.assets.push({ ...remote.assets[0], name: "latest.json" });
    expect(remoteReleaseIssues(remote, publication)).toContain(
      "The GitHub release has missing or unexpected immutable assets.",
    );
  });

  it("requires the release to be published and server-side immutable", () => {
    const publication = publicationFixture();
    expect(remoteReleaseIssues({ ...remoteRelease(publication), draft: true, immutable: false }, publication)).toEqual(
      expect.arrayContaining([
        "The GitHub release must be published, not a draft.",
        "The published GitHub release must be immutable.",
      ]),
    );
  });

  it("resumes only an exact draft and uploads only missing assets", () => {
    const publication = publicationFixture();
    const draft = {
      ...remoteRelease(publication),
      draft: true,
      immutable: false,
      assets: remoteRelease(publication).assets.slice(0, 3),
    };
    expect(draftReleaseIssues(draft, publication)).toEqual([]);
    expect(missingDraftReleaseAssets(draft, publication).map((asset: { name: string }) => asset.name)).toEqual(
      publication.assets.slice(3).map((asset: { name: string }) => asset.name),
    );

    draft.assets[0].digest = `sha256:${"0".repeat(64)}`;
    expect(draftReleaseIssues(draft, publication)).toContain(
      `The GitHub asset ${draft.assets[0].name} does not match the local release.`,
    );
    expect(() => missingDraftReleaseAssets(draft, publication)).toThrow(/does not match/);
  });

  it("creates an exact remote-verification receipt and rejects tampering", () => {
    const publication = publicationFixture();
    const state = {
      repository: repository(),
      immutableSettings: immutableSettings(),
      remoteRelease: remoteRelease(publication),
    };
    const previousManifest = { path: "/tmp/latest.json", sha256: "b".repeat(64) };
    const receipt = buildImmutablePublicationReceipt({
      publication,
      ...state,
      verifiedAt: "2026-08-12T18:05:00.000Z",
      previousManifest,
    });
    expect(immutablePublicationReceiptIssues(receipt, {
      publication,
      previousManifest,
      ...state,
    })).toEqual([]);

    const tampered = structuredClone(receipt);
    tampered.assets[0].sha256 = "0".repeat(64);
    expect(immutablePublicationReceiptIssues(tampered, {
      publication,
      previousManifest,
      ...state,
    })).toEqual(expect.arrayContaining([
      "The immutable publication receipt does not bind every release asset.",
      "The immutable publication receipt fingerprint is invalid.",
    ]));
    expect(immutablePublicationReceiptIssues(receipt, {
      publication,
      previousManifest: { ...previousManifest, sha256: "0".repeat(64) },
      ...state,
    })).toContain("The immutable publication receipt belongs to a different previous update pointer.");
  });

  it("uses an exact previous pointer and compare-and-swap GitHub blob SHA", () => {
    const publication = publicationFixture();
    const previous = Buffer.from("previous\n");
    expect(assertLatestPointerPrecondition({
      initialRelease: true,
      previousManifestBytes: undefined,
      currentPointerBytes: null,
      nextPointerBytes: publication.latestBytes,
    })).toBe("create");
    expect(assertLatestPointerPrecondition({
      initialRelease: false,
      previousManifestBytes: previous,
      currentPointerBytes: previous,
      nextPointerBytes: publication.latestBytes,
    })).toBe("replace");
    expect(assertLatestPointerPrecondition({
      initialRelease: false,
      previousManifestBytes: previous,
      currentPointerBytes: publication.latestBytes,
      nextPointerBytes: publication.latestBytes,
    })).toBe("already-active");
    expect(() => assertLatestPointerPrecondition({
      initialRelease: true,
      previousManifestBytes: undefined,
      currentPointerBytes: previous,
      nextPointerBytes: publication.latestBytes,
    })).toThrow(/cannot replace/);
    expect(() => assertLatestPointerPrecondition({
      initialRelease: false,
      previousManifestBytes: previous,
      currentPointerBytes: Buffer.from("different\n"),
      nextPointerBytes: publication.latestBytes,
    })).toThrow(/changed after/);

    expect(latestPointerUpdate({ publication, currentPointerSha: "c".repeat(40) })).toEqual({
      endpoint: `repos/${directReleaseRepositorySlug}/contents/latest.json`,
      body: {
        message: `Activate Codelit for Mac ${publication.tag}`,
        content: publication.latestBytes.toString("base64"),
        branch: "main",
        sha: "c".repeat(40),
      },
    });
  });

  it("requires durable output and remote proof before pointer activation", () => {
    const directory = mkdtempSync(join(tmpdir(), "codelit-direct-arguments-"));
    const outputDirectory = join(directory, "receipts");
    mkdirSync(outputDirectory);
    const previous = join(directory, "latest.json");
    writeFileSync(previous, "{}\n");

    expect(() => parseDirectPublicationArguments([
      directory,
      "--previous-manifest", previous,
    ], { action: "publish" })).toThrow(/--output is required/);
    expect(() => parseDirectPublicationArguments([
      directory,
      "--output", join(outputDirectory, "activation.json"),
      "--previous-manifest", previous,
    ], { action: "activate" })).toThrow(/--publication-receipt is required/);
  });

  it("repeats anonymous standalone verification during pointer activation", () => {
    const source = readFileSync(
      new URL("../../apps/mac/scripts/activate-direct-release.mjs", import.meta.url),
      "utf8",
    );
    expect(source.indexOf("downloadAndVerifyRemoteRelease(publication, options, environment)")).toBeGreaterThan(
      source.indexOf("verifyPublicationReceipt("),
    );
    expect(source.indexOf("downloadAndVerifyRemoteRelease(publication, options, environment)")).toBeLessThan(
      source.indexOf("readRemotePointer(environment)"),
    );
    expect(source).toContain("readLatestPointerCommit(environment)");
    expect(source).toContain("/${commitSha}/latest.json");
  });
});
