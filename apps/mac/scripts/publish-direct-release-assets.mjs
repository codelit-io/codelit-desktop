import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildImmutablePublicationReceipt,
  directReleaseRepositorySlug,
  draftReleaseIssues,
  immutablePublicationReceiptSchema,
  missingDraftReleaseAssets,
  publicationReceiptFingerprint,
  repositoryPublicationIssues,
} from "./direct-release-publication.mjs";
import {
  closeReceipt,
  downloadAndVerifyRemoteRelease,
  openReceipt,
  parseDirectPublicationArguments,
  publicationFromOptions,
  readPreviousManifest,
  readRemotePublicationState,
  releaseVerificationOptions,
  runCommand,
  verifyRemoteState,
  writeDurableReceipt,
} from "./direct-release-github.mjs";
import { verifyReleaseDirectory } from "./desktop-release-provenance.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function publishDirectReleaseAssets(arguments_, environment = process.env) {
  const options = parseDirectPublicationArguments(arguments_, { action: "publish" });
  const publication = publicationFromOptions(options);
  const verificationOptions = releaseVerificationOptions(options, environment);
  verifyReleaseDirectory(options.directory, verificationOptions);

  const previous = readPreviousManifest(options);
  const previousManifest = previous ? { path: previous.path, sha256: sha256(previous.bytes) } : null;
  let state = readRemotePublicationState(publication.tag, environment);
  const settingsIssues = repositoryPublicationIssues(state.repository, state.immutableSettings);
  if (settingsIssues.length) throw new Error(settingsIssues.join(" "));
  const startedAt = new Date().toISOString();
  const attempt = {
    schemaVersion: immutablePublicationReceiptSchema,
    action: "immutable-assets",
    status: "started",
    startedAt,
    completedAt: null,
    failedAt: null,
    repository: directReleaseRepositorySlug,
    version: publication.version,
    tag: publication.tag,
    sourceCommit: publication.sourceCommit,
    releaseJsonSha256: publication.releaseSha256,
    latestJsonSha256: publication.latestSha256,
  };
  const descriptor = openReceipt(options.outputPath);
  try {
    writeDurableReceipt({ ...attempt, receiptFingerprint: publicationReceiptFingerprint(attempt) }, descriptor);
    if (!state.remoteRelease) {
      const temporary = mkdtempSync(resolve(tmpdir(), `codelit-${publication.tag}-publish-`));
      const notesPath = resolve(temporary, "release-notes.md");
      try {
        writeFileSync(notesPath, `${publication.notes.trim()}\n`, { flag: "wx", mode: 0o600 });
        runCommand("gh", [
          "release",
          "create",
          publication.tag,
          "--repo",
          directReleaseRepositorySlug,
          "--target",
          "main",
          "--title",
          `Codelit for Mac ${publication.version}`,
          "--notes-file",
          notesPath,
          "--draft",
          "--latest=false",
        ], { environment });
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
      state = readRemotePublicationState(publication.tag, environment);
    }
    if (state.remoteRelease?.draft) {
      const draftIssues = draftReleaseIssues(state.remoteRelease, publication);
      if (draftIssues.length) throw new Error(draftIssues.join(" "));
      for (const asset of missingDraftReleaseAssets(state.remoteRelease, publication)) {
        runCommand("gh", [
          "release",
          "upload",
          publication.tag,
          asset.path,
          "--repo",
          directReleaseRepositorySlug,
        ], { environment });
      }
      state = readRemotePublicationState(publication.tag, environment);
      const missing = missingDraftReleaseAssets(state.remoteRelease, publication);
      if (missing.length) throw new Error(`The GitHub draft is still missing ${missing.map((asset) => asset.name).join(", ")}.`);
      runCommand("gh", [
        "release",
        "edit",
        publication.tag,
        "--repo",
        directReleaseRepositorySlug,
        "--draft=false",
        "--latest=false",
      ], { environment });
      state = readRemotePublicationState(publication.tag, environment);
    }
    verifyRemoteState(state, publication);
    downloadAndVerifyRemoteRelease(publication, options, environment);
    const receipt = buildImmutablePublicationReceipt({
      publication,
      ...state,
      verifiedAt: new Date().toISOString(),
      previousManifest,
    });
    writeDurableReceipt(receipt, descriptor);
    return receipt;
  } catch (error) {
    const failed = {
      ...attempt,
      status: "failed",
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    writeDurableReceipt({ ...failed, receiptFingerprint: publicationReceiptFingerprint(failed) }, descriptor);
    throw error;
  } finally {
    closeReceipt(descriptor);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const receipt = await publishDirectReleaseAssets(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
