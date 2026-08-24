import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseDirectory } from "./desktop-release-provenance.mjs";
import {
  activationReceiptFingerprint,
  activationReceiptSchema,
  assertLatestPointerPrecondition,
  directReleaseRepositorySlug,
  latestPointerUpdate,
} from "./direct-release-publication.mjs";
import {
  closeReceipt,
  downloadAndVerifyRemoteRelease,
  githubApi,
  openReceipt,
  parseDirectPublicationArguments,
  publicationFromOptions,
  readLatestPointerCommit,
  readPreviousManifest,
  readRemotePointer,
  readRemotePublicationState,
  releaseVerificationOptions,
  runCommand,
  verifyPublicationReceipt,
  verifyRemoteState,
  writeDurableReceipt,
} from "./direct-release-github.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function anonymousPointer(publication, commitSha, environment) {
  const directory = mkdtempSync(resolve(tmpdir(), `codelit-${publication.tag}-pointer-`));
  const path = resolve(directory, "latest.json");
  try {
    runCommand("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--tlsv1.2",
      "--header",
      "Cache-Control: no-cache",
      "--output",
      path,
      `https://raw.githubusercontent.com/${directReleaseRepositorySlug}/${commitSha}/latest.json`,
    ], { environment });
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function activateDirectRelease(arguments_, environment = process.env) {
  const options = parseDirectPublicationArguments(arguments_, { action: "activate" });
  const publication = publicationFromOptions(options);
  verifyReleaseDirectory(options.directory, releaseVerificationOptions(options, environment));
  const state = readRemotePublicationState(publication.tag, environment);
  verifyRemoteState(state, publication);
  const previous = readPreviousManifest(options);
  const previousManifest = previous ? { path: previous.path, sha256: sha256(previous.bytes) } : null;
  const immutableReceipt = verifyPublicationReceipt(
    options.publicationReceiptPath,
    publication,
    state,
    previousManifest,
  );
  downloadAndVerifyRemoteRelease(publication, options, environment);
  const currentPointer = readRemotePointer(environment);
  const disposition = assertLatestPointerPrecondition({
    initialRelease: options.initialRelease,
    previousManifestBytes: previous?.bytes,
    currentPointerBytes: currentPointer?.bytes ?? null,
    nextPointerBytes: publication.latestBytes,
  });

  const startedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: activationReceiptSchema,
    action: "activate-latest-pointer",
    status: "started",
    startedAt,
    completedAt: null,
    failedAt: null,
    repository: directReleaseRepositorySlug,
    version: publication.version,
    tag: publication.tag,
    sourceCommit: publication.sourceCommit,
    immutablePublicationReceipt: {
      name: options.publicationReceiptPath.split("/").at(-1),
      sha256: sha256(readFileSync(options.publicationReceiptPath)),
      receiptFingerprint: immutableReceipt.receiptFingerprint,
    },
    pointer: {
      path: "latest.json",
      previousGitBlobSha: currentPointer?.sha ?? null,
      previousSha256: currentPointer ? sha256(currentPointer.bytes) : null,
      nextSha256: publication.latestSha256,
      disposition,
      commitSha: null,
      rawDownloadSha256: null,
    },
  };
  const descriptor = openReceipt(options.outputPath);
  let temporary = null;
  try {
    writeDurableReceipt({
      ...receipt,
      receiptFingerprint: activationReceiptFingerprint(receipt),
    }, descriptor);
    temporary = mkdtempSync(resolve(tmpdir(), `codelit-${publication.tag}-activation-`));
    let commitSha = null;
    if (disposition !== "already-active") {
      const update = latestPointerUpdate({ publication, currentPointerSha: currentPointer?.sha });
      const inputPath = resolve(temporary, "request.json");
      writeFileSync(inputPath, `${JSON.stringify(update.body)}\n`, { mode: 0o600 });
      const result = githubApi(update.endpoint, { method: "PUT", input: inputPath, environment });
      if (!/^[a-f0-9]{40}$/.test(result?.commit?.sha || "")) {
        throw new Error("GitHub did not return the activation commit SHA.");
      }
      commitSha = result.commit.sha;
    }
    const remote = readRemotePointer(environment);
    if (!remote || !remote.bytes.equals(publication.latestBytes)) {
      throw new Error("The GitHub contents API did not return the exact activated latest.json.");
    }
    const pointerCommitSha = commitSha || readLatestPointerCommit(environment);
    const anonymous = anonymousPointer(publication, pointerCommitSha, environment);
    if (!anonymous.equals(publication.latestBytes)) {
      throw new Error("The anonymous raw latest.json does not match the activated release.");
    }
    receipt.status = "completed";
    receipt.completedAt = new Date().toISOString();
    receipt.pointer.commitSha = pointerCommitSha;
    receipt.pointer.rawDownloadSha256 = sha256(anonymous);
    const completed = { ...receipt, receiptFingerprint: activationReceiptFingerprint(receipt) };
    writeDurableReceipt(completed, descriptor);
    return completed;
  } catch (error) {
    receipt.status = "failed";
    receipt.failedAt = new Date().toISOString();
    const failed = { ...receipt, receiptFingerprint: activationReceiptFingerprint(receipt) };
    writeDurableReceipt(failed, descriptor);
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    closeReceipt(descriptor);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(activateDirectRelease(process.argv.slice(2)), null, 2)}\n`);
}
