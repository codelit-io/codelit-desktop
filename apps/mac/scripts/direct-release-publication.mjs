import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  directArtifactNames,
  immutableArtifactUrl,
  parseStableVersion,
  releaseRepository,
  sha256File,
} from "./desktop-release-provenance.mjs";

export const directReleaseRepositorySlug = "codelit-io/codelit-mac-releases";
export const directReleaseRepositoryApi = `repos/${directReleaseRepositorySlug}`;
export const directReleaseDefaultBranch = "main";
export const immutablePublicationReceiptSchema = 1;
export const activationReceiptSchema = 1;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function regularFile(path, label) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new Error(`${label} must be a non-symlink regular file.`);
  }
  return path;
}

export function immutableDirectReleaseNames(version) {
  const names = directArtifactNames(version);
  return [
    names.archive,
    names.signature,
    names.dmg,
    names.qa,
    names.p1Journey,
    names.computerLifecycle,
    names.localReliability,
    names.sbom,
    names.provenance,
    names.provenanceSignature,
    "release.json",
    "SHA256SUMS",
  ].sort();
}

export function readDirectReleasePublication(directory) {
  const absolute = resolve(directory);
  const releasePath = regularFile(resolve(absolute, "release.json"), "release.json");
  const latestPath = regularFile(resolve(absolute, "latest.json"), "latest.json");
  const release = readJson(releasePath, "release.json");
  const latest = readJson(latestPath, "latest.json");
  parseStableVersion(release.version);
  if (release.channel !== "direct" || release.publication?.immutableTag !== `v${release.version}`) {
    throw new Error("release.json is not a Direct immutable release.");
  }
  if (latest.version !== release.version) throw new Error("latest.json and release.json disagree on the release version.");
  const assets = immutableDirectReleaseNames(release.version).map((name) => {
    const path = regularFile(resolve(absolute, name), name);
    return {
      name,
      path,
      bytes: statSync(path).size,
      sha256: sha256File(path),
      url: immutableArtifactUrl(release.version, name),
    };
  });
  return {
    directory: absolute,
    version: release.version,
    tag: `v${release.version}`,
    notes: release.notes,
    sourceCommit: release.source?.commit,
    release,
    latest,
    latestPath,
    latestBytes: readFileSync(latestPath),
    latestSha256: sha256File(latestPath),
    releaseSha256: sha256File(releasePath),
    assets,
  };
}

export function repositoryPublicationIssues(repository, immutableSettings) {
  const issues = [];
  if (repository?.full_name !== directReleaseRepositorySlug) issues.push("The GitHub repository identity is incorrect.");
  if (repository?.private !== false || String(repository?.visibility).toLowerCase() !== "public") {
    issues.push("The Direct release repository must be public.");
  }
  if (repository?.default_branch !== directReleaseDefaultBranch) {
    issues.push(`The Direct release repository default branch must be ${directReleaseDefaultBranch}.`);
  }
  if (immutableSettings?.enabled !== true) issues.push("GitHub immutable releases must be enabled before publishing.");
  return issues;
}

function releaseIdentityIssues(remoteRelease, publication) {
  const issues = [];
  if (remoteRelease?.tag_name !== publication.tag) issues.push(`The GitHub release must use tag ${publication.tag}.`);
  if (remoteRelease?.prerelease !== false) issues.push("The Direct release cannot be a prerelease.");
  if (typeof remoteRelease?.id !== "number" || remoteRelease.id <= 0) issues.push("The GitHub release ID is missing.");
  if (remoteRelease?.name !== `Codelit for Mac ${publication.version}`) {
    issues.push("The GitHub release title does not match the signed release version.");
  }
  if (String(remoteRelease?.body || "").trim() !== String(publication.notes || "").trim()) {
    issues.push("The GitHub release notes do not match the signed release notes.");
  }
  return issues;
}

function remoteAssetIssues(remoteAssets, publication, { requireComplete }) {
  const issues = [];
  const expected = new Map(publication.assets.map((asset) => [asset.name, asset]));
  const actualNames = remoteAssets.map((asset) => asset.name).sort();
  if (new Set(actualNames).size !== actualNames.length) {
    issues.push("The GitHub release contains duplicate asset names.");
    return issues;
  }
  if (
    actualNames.some((name) => !expected.has(name))
    || (requireComplete && JSON.stringify(actualNames) !== JSON.stringify([...expected.keys()].sort()))
  ) {
    issues.push("The GitHub release has missing or unexpected immutable assets.");
    return issues;
  }
  for (const asset of remoteAssets) {
    const local = expected.get(asset.name);
    if (
      !local
      || asset.size !== local.bytes
      || asset.digest !== `sha256:${local.sha256}`
      || asset.browser_download_url !== local.url
    ) {
      issues.push(`The GitHub asset ${asset.name} does not match the local release.`);
    }
  }
  return issues;
}

export function draftReleaseIssues(remoteRelease, publication) {
  const issues = releaseIdentityIssues(remoteRelease, publication);
  if (remoteRelease?.draft !== true) issues.push("The recoverable GitHub release must still be a draft.");
  if (remoteRelease?.immutable !== false) issues.push("A draft release cannot already be immutable.");
  const remoteAssets = Array.isArray(remoteRelease?.assets) ? remoteRelease.assets : [];
  issues.push(...remoteAssetIssues(remoteAssets, publication, { requireComplete: false }));
  return issues;
}

export function missingDraftReleaseAssets(remoteRelease, publication) {
  const issues = draftReleaseIssues(remoteRelease, publication);
  if (issues.length) throw new Error(issues.join(" "));
  const existing = new Set(remoteRelease.assets.map((asset) => asset.name));
  return publication.assets.filter((asset) => !existing.has(asset.name));
}

export function remoteReleaseIssues(remoteRelease, publication) {
  const issues = releaseIdentityIssues(remoteRelease, publication);
  if (remoteRelease?.draft !== false) issues.push("The GitHub release must be published, not a draft.");
  if (remoteRelease?.immutable !== true) issues.push("The published GitHub release must be immutable.");
  const remoteAssets = Array.isArray(remoteRelease?.assets) ? remoteRelease.assets : [];
  issues.push(...remoteAssetIssues(remoteAssets, publication, { requireComplete: true }));
  return issues;
}

export function publicationReceiptFingerprint(receipt) {
  const unsigned = { ...receipt };
  delete unsigned.receiptFingerprint;
  return sha256(canonicalJson(unsigned));
}

export function buildImmutablePublicationReceipt({
  publication,
  repository,
  immutableSettings,
  remoteRelease,
  verifiedAt,
  previousManifest,
}) {
  const repositoryIssues = repositoryPublicationIssues(repository, immutableSettings);
  const releaseIssues = remoteReleaseIssues(remoteRelease, publication);
  if (repositoryIssues.length || releaseIssues.length) {
    throw new Error([...repositoryIssues, ...releaseIssues].join(" "));
  }
  const receipt = {
    schemaVersion: immutablePublicationReceiptSchema,
    action: "immutable-assets",
    status: "verified",
    verifiedAt,
    repository: {
      id: repository.id,
      slug: directReleaseRepositorySlug,
      url: releaseRepository,
      visibility: "public",
      defaultBranch: directReleaseDefaultBranch,
      immutableReleases: true,
      immutableReleasesEnforcedByOwner: immutableSettings.enforced_by_owner === true,
    },
    release: {
      id: remoteRelease.id,
      tag: publication.tag,
      url: remoteRelease.html_url,
      immutable: true,
      publishedAt: remoteRelease.published_at,
    },
    version: publication.version,
    sourceCommit: publication.sourceCommit,
    releaseJsonSha256: publication.releaseSha256,
    latestJsonSha256: publication.latestSha256,
    assets: publication.assets.map(({ name, bytes, sha256: digest, url }) => ({
      name,
      bytes,
      sha256: digest,
      githubDigest: `sha256:${digest}`,
      url,
    })),
    verification: {
      githubApiDigests: true,
      anonymousDownloads: true,
      standaloneVerifier: true,
      previousManifest: previousManifest
        ? { name: basename(previousManifest.path), sha256: previousManifest.sha256 }
        : null,
    },
  };
  return { ...receipt, receiptFingerprint: publicationReceiptFingerprint(receipt) };
}

export function immutablePublicationReceiptIssues(receipt, {
  publication,
  repository,
  immutableSettings,
  remoteRelease,
  previousManifest,
}) {
  const issues = [
    ...repositoryPublicationIssues(repository, immutableSettings),
    ...remoteReleaseIssues(remoteRelease, publication),
  ];
  if (
    receipt?.schemaVersion !== immutablePublicationReceiptSchema
    || receipt?.action !== "immutable-assets"
    || receipt?.status !== "verified"
  ) {
    issues.push("The immutable publication receipt has an unsupported contract.");
  }
  if (
    receipt?.repository?.id !== repository?.id
    || receipt?.repository?.slug !== directReleaseRepositorySlug
    || receipt?.repository?.url !== releaseRepository
    || receipt?.repository?.visibility !== "public"
    || receipt?.repository?.defaultBranch !== directReleaseDefaultBranch
    || receipt?.repository?.immutableReleases !== true
    || receipt?.repository?.immutableReleasesEnforcedByOwner !== (immutableSettings?.enforced_by_owner === true)
  ) {
    issues.push("The immutable publication receipt belongs to a different repository state.");
  }
  if (
    receipt?.release?.id !== remoteRelease?.id
    || receipt?.release?.tag !== publication.tag
    || receipt?.release?.url !== remoteRelease?.html_url
    || receipt?.release?.immutable !== true
    || receipt?.release?.publishedAt !== remoteRelease?.published_at
    || receipt?.version !== publication.version
    || receipt?.sourceCommit !== publication.sourceCommit
    || receipt?.releaseJsonSha256 !== publication.releaseSha256
    || receipt?.latestJsonSha256 !== publication.latestSha256
  ) {
    issues.push("The immutable publication receipt belongs to a different release.");
  }
  const expectedAssets = publication.assets.map((asset) => ({
    name: asset.name,
    bytes: asset.bytes,
    sha256: asset.sha256,
    url: asset.url,
    githubDigest: `sha256:${asset.sha256}`,
  }));
  if (canonicalJson(receipt?.assets) !== canonicalJson(expectedAssets)) {
    issues.push("The immutable publication receipt does not bind every release asset.");
  }
  const expectedPreviousManifest = previousManifest
    ? { name: basename(previousManifest.path), sha256: previousManifest.sha256 }
    : null;
  if (canonicalJson(receipt?.verification?.previousManifest) !== canonicalJson(expectedPreviousManifest)) {
    issues.push("The immutable publication receipt belongs to a different previous update pointer.");
  }
  if (
    receipt?.verification?.githubApiDigests !== true
    || receipt?.verification?.anonymousDownloads !== true
    || receipt?.verification?.standaloneVerifier !== true
  ) {
    issues.push("The immutable publication receipt is missing remote verification proof.");
  }
  if (receipt?.receiptFingerprint !== publicationReceiptFingerprint(receipt || {})) {
    issues.push("The immutable publication receipt fingerprint is invalid.");
  }
  return [...new Set(issues)];
}

export function readImmutablePublicationReceipt(path) {
  return readJson(regularFile(resolve(path), "Immutable publication receipt"), "Immutable publication receipt");
}

export function assertLatestPointerPrecondition({
  initialRelease,
  previousManifestBytes,
  currentPointerBytes,
  nextPointerBytes,
}) {
  if (
    currentPointerBytes !== null
    && nextPointerBytes
    && Buffer.from(currentPointerBytes).equals(Buffer.from(nextPointerBytes))
  ) {
    return "already-active";
  }
  if (initialRelease) {
    if (currentPointerBytes !== null) throw new Error("The initial release cannot replace an existing latest.json pointer.");
    return "create";
  }
  if (!previousManifestBytes) throw new Error("A previous manifest is required after the initial release.");
  if (currentPointerBytes === null || !Buffer.from(currentPointerBytes).equals(Buffer.from(previousManifestBytes))) {
    throw new Error("The published latest.json changed after this release was prepared.");
  }
  return "replace";
}

export function latestPointerUpdate({ publication, currentPointerSha }) {
  return {
    endpoint: `${directReleaseRepositoryApi}/contents/latest.json`,
    body: {
      message: `Activate Codelit for Mac ${publication.tag}`,
      content: publication.latestBytes.toString("base64"),
      branch: directReleaseDefaultBranch,
      ...(currentPointerSha ? { sha: currentPointerSha } : {}),
    },
  };
}

export function activationReceiptFingerprint(receipt) {
  const unsigned = { ...receipt };
  delete unsigned.receiptFingerprint;
  return sha256(canonicalJson(unsigned));
}
