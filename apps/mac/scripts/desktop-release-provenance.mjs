import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appRoot, repositoryRoot, run, tauriRoot } from "./release-support.mjs";
import {
  assertSafeCandidateArchiveEntries,
  candidateQaReceiptIssues,
  inspectDesktopCandidate,
  readCandidateQaReceipt,
} from "./desktop-candidate-qa.mjs";
import {
  desktopP1JourneyGate,
  desktopP1JourneyReceiptIssues,
  readDesktopP1JourneyReceipt,
} from "./desktop-p1-journey.mjs";
import {
  desktopComputerLifecycleGate,
  desktopComputerLifecycleReceiptIssues,
  readDesktopComputerLifecycleReceipt,
} from "./desktop-computer-lifecycle.mjs";
import {
  desktopLocalReliabilityGate,
  desktopLocalReliabilityReceiptIssues,
  readDesktopLocalReliabilityReceipt,
} from "./desktop-local-reliability.mjs";

export const releasePlatform = "darwin-aarch64-app";
export const releaseRepository = "https://github.com/codelit-io/codelit-mac-releases";
export const releaseDownloadRoot = `${releaseRepository}/releases/download`;
export const updaterPublicKeyPath = resolve(appRoot, "release/updater.pub");

const directQualificationReceipts = [
  {
    key: "p1Journey",
    nameKey: "p1Journey",
    gate: desktopP1JourneyGate,
    label: "P1 journey",
    read: readDesktopP1JourneyReceipt,
    issues: desktopP1JourneyReceiptIssues,
  },
  {
    key: "computerLifecycle",
    nameKey: "computerLifecycle",
    gate: desktopComputerLifecycleGate,
    label: "Computer lifecycle",
    read: readDesktopComputerLifecycleReceipt,
    issues: desktopComputerLifecycleReceiptIssues,
  },
  {
    key: "localReliability",
    nameKey: "localReliability",
    gate: desktopLocalReliabilityGate,
    label: "Local reliability",
    read: readDesktopLocalReliabilityReceipt,
    issues: desktopLocalReliabilityReceiptIssues,
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeCanonicalBase64(value, label, maximumLength) {
  if (typeof value !== "string" || !value || value.length > maximumLength) {
    throw new Error(`${label} is missing or too large.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`${label} is not canonical base64.`);
  return decoded;
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function parseStableVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`Release version must be stable X.Y.Z semver, received ${value}.`);
  return match.slice(1).map((part) => BigInt(part));
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function assertVersionAdvances(version, previousVersion) {
  if (compareStableVersions(version, previousVersion) <= 0) {
    throw new Error(`Release ${version} must be newer than published release ${previousVersion}.`);
  }
}

export function normalizeReleaseNotes(value) {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error("Release notes cannot be empty.");
  if (normalized.length > 4_000) throw new Error("Release notes cannot exceed 4,000 characters.");
  if (/[^\P{Cc}\n\t]/u.test(normalized)) throw new Error("Release notes contain unsupported control characters.");
  return normalized;
}

export function assertIsoTimestamp(value) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("Published time must be an ISO-8601 UTC timestamp.");
  }
  return value;
}

export function directArtifactNames(version) {
  parseStableVersion(version);
  const stem = `Codelit-${version}-aarch64`;
  return {
    archive: `${stem}.app.tar.gz`,
    signature: `${stem}.app.tar.gz.sig`,
    dmg: `${stem}.dmg`,
    qa: `codelit-${version}-candidate-qa.json`,
    p1Journey: `codelit-${version}-p1-journey.json`,
    computerLifecycle: `codelit-${version}-computer-lifecycle.json`,
    localReliability: `codelit-${version}-local-reliability.json`,
    sbom: `codelit-${version}-sbom.cdx.json`,
    provenance: `codelit-${version}-provenance.json`,
    provenanceSignature: `codelit-${version}-provenance.json.sig`,
  };
}

export function immutableArtifactUrl(version, filename) {
  const names = directArtifactNames(version);
  if (!Object.values(names).includes(filename) && !["release.json", "SHA256SUMS"].includes(filename)) {
    throw new Error(`Unexpected release filename ${filename}.`);
  }
  return `${releaseDownloadRoot}/v${version}/${encodeURIComponent(filename)}`;
}

export function assertImmutableArtifactUrl(value, version, filename) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`Release URL for ${filename} must be credential-free HTTPS without query or fragment.`);
  }
  if (url.href !== immutableArtifactUrl(version, filename)) {
    throw new Error(`Release URL for ${filename} must use the immutable v${version} release.`);
  }
}

export function readReleaseVersion() {
  const packageVersion = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")).version;
  const tauriVersion = JSON.parse(readFileSync(resolve(tauriRoot, "tauri.conf.json"), "utf8")).version;
  const cargoVersion = readFileSync(resolve(tauriRoot, "Cargo.toml"), "utf8")
    .match(/^version = "([^"]+)"/m)?.[1];
  const lockVersion = JSON.parse(readFileSync(resolve(appRoot, "package-lock.json"), "utf8"))
    .packages?.[""]?.version;
  const versions = [packageVersion, tauriVersion, cargoVersion, lockVersion];
  if (versions.some((version) => version !== packageVersion)) {
    throw new Error(`Desktop versions disagree: ${versions.join(", ")}.`);
  }
  parseStableVersion(packageVersion);
  return packageVersion;
}

function commandOutput(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd || repositoryRoot,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result.stdout.trim();
}

export function currentSourceState() {
  const commit = commandOutput("git", ["rev-parse", "HEAD"]);
  const dirty = commandOutput("git", ["status", "--porcelain", "--untracked-files=normal"]) !== "";
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Could not resolve a full source commit.");
  return { commit, dirty };
}

function integrityHash(integrity) {
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(integrity || "");
  if (!match) return [];
  return [{ alg: match[1].toUpperCase().replace("SHA", "SHA-"), content: Buffer.from(match[2], "base64").toString("hex") }];
}

function npmPurl(name, version) {
  if (name.startsWith("@")) {
    const [scope, packageName] = name.split("/");
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${version}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

function packageNameFromLockPath(path) {
  const name = path.split("node_modules/").at(-1);
  return name && !name.includes("node_modules") ? name : null;
}

function matchesPlatform(values, platform) {
  if (!values?.length) return true;
  if (values.includes(`!${platform}`)) return false;
  const allowed = values.filter((value) => !value.startsWith("!"));
  return allowed.length === 0 || allowed.includes(platform);
}

function npmComponents() {
  const lock = JSON.parse(readFileSync(resolve(appRoot, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages || {}).flatMap(([path, entry]) => {
    const packageName = packageNameFromLockPath(path);
    if (!packageName || !entry.version || entry.dev) return [];
    if (!matchesPlatform(entry.os, "darwin") || !matchesPlatform(entry.cpu, "arm64")) return [];
    const scoped = packageName.startsWith("@") ? packageName.split("/") : [];
    const component = {
      type: "library",
      ...(scoped.length ? { group: scoped[0] } : {}),
      name: scoped.length ? scoped[1] : packageName,
      version: entry.version,
      purl: npmPurl(packageName, entry.version),
      properties: [
        { name: "codelit:ecosystem", value: "npm" },
      ],
    };
    const hashes = integrityHash(entry.integrity);
    if (hashes.length) component.hashes = hashes;
    if (entry.license) component.licenses = [{ expression: entry.license }];
    return [component];
  });
}

function cargoComponents(environment) {
  const metadata = JSON.parse(commandOutput("cargo", [
    "metadata",
    "--manifest-path", resolve(tauriRoot, "Cargo.toml"),
    "--format-version", "1",
    "--locked",
    "--features", "direct-release",
    "--filter-platform", "aarch64-apple-darwin",
  ], { env: environment }));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const included = new Set();
  const pending = [metadata.resolve.root];
  while (pending.length) {
    const id = pending.pop();
    if (!id || included.has(id)) continue;
    included.add(id);
    const node = nodes.get(id);
    for (const dependency of node?.deps || []) {
      if (dependency.dep_kinds.some((kind) => kind.kind !== "dev")) pending.push(dependency.pkg);
    }
  }
  return metadata.packages.flatMap((entry) => {
    if (!included.has(entry.id)) return [];
    if (!entry.source) return [];
    const component = {
      type: "library",
      name: entry.name,
      version: entry.version,
      purl: `pkg:cargo/${encodeURIComponent(entry.name)}@${entry.version}`,
      properties: [{ name: "codelit:ecosystem", value: "cargo" }],
    };
    if (entry.license) component.licenses = [{ expression: entry.license }];
    return [component];
  });
}

function swiftComponents() {
  const resolved = JSON.parse(readFileSync(resolve(appRoot, "native/mlx-helper/Package.resolved"), "utf8"));
  return resolved.pins.map((pin) => ({
    type: "library",
    name: pin.identity,
    version: pin.state.version || pin.state.revision,
    purl: `pkg:swift/${encodeURIComponent(pin.identity)}@${pin.state.version || pin.state.revision}`,
    externalReferences: [{ type: "vcs", url: pin.location }],
    properties: [
      { name: "codelit:ecosystem", value: "swift" },
      { name: "codelit:revision", value: pin.state.revision },
    ],
  }));
}

export function buildCycloneDxSbom({ version, commit, timestamp, environment = process.env }) {
  parseStableVersion(version);
  assertIsoTimestamp(timestamp);
  const byPurl = new Map();
  for (const component of [...npmComponents(), ...cargoComponents(environment), ...swiftComponents()]) {
    if (!byPurl.has(component.purl)) byPurl.set(component.purl, component);
  }
  const components = [...byPurl.values()].sort((left, right) => left.purl.localeCompare(right.purl));
  const uuidHex = sha256(`${version}:${commit}:${timestamp}`).slice(0, 32);
  const serial = `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-4${uuidHex.slice(13, 16)}-a${uuidHex.slice(17, 20)}-${uuidHex.slice(20)}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      timestamp,
      component: {
        type: "application",
        name: "Codelit for Mac",
        version,
        purl: `pkg:generic/codelit-mac@${version}`,
      },
      properties: [
        { name: "codelit:source-commit", value: commit },
        { name: "codelit:target", value: "aarch64-apple-darwin" },
      ],
    },
    components,
  };
}

function artifactMetadata(path, name, version) {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size === 0) throw new Error(`${path} must be a non-empty regular file.`);
  return {
    name,
    url: immutableArtifactUrl(version, name),
    bytes: stats.size,
    sha256: sha256File(path),
  };
}

function qualificationArtifactMetadata(path, name, version, receipt) {
  return {
    ...artifactMetadata(path, name, version),
    gate: receipt.gate,
    candidateFingerprint: receipt.candidateFingerprint,
  };
}

function qualificationBinding(artifact) {
  return {
    gate: artifact.gate,
    fingerprint: artifact.candidateFingerprint,
    digest: { sha256: artifact.sha256 },
    bytes: artifact.bytes,
  };
}

function validateQualificationReceipt(definition, path, candidate) {
  const receipt = definition.read(path);
  const issues = definition.issues(receipt, { candidate });
  if (issues.length) throw new Error(`${definition.label} receipt is invalid: ${issues.join(" ")}`);
  return receipt;
}

export function buildReleaseDocuments({
  version,
  notes,
  timestamp,
  commit,
  archive,
  signature,
  dmg,
  qa,
  p1Journey,
  computerLifecycle,
  localReliability,
  sbom,
  provenance,
  provenanceSignature,
  signedManifest,
  rollback = /** @type {{ restoresVersion: string; restoresCommit: string } | null} */ (null),
  tools,
}) {
  parseStableVersion(version);
  const normalizedNotes = normalizeReleaseNotes(notes);
  assertIsoTimestamp(timestamp);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Provenance requires a full source commit.");
  const signedPayloadBytes = decodeCanonicalBase64(signedManifest?.signedPayload, "Signed update payload", 24_000);
  decodeCanonicalBase64(signedManifest?.signature, "Signed update manifest signature", 2_000);
  if (rollback) {
    parseStableVersion(rollback.restoresVersion);
    if (compareStableVersions(rollback.restoresVersion, version) >= 0) {
      throw new Error("A forward rollback must restore behavior from an older release.");
    }
    if (!/^[a-f0-9]{40}$/.test(rollback.restoresCommit)) {
      throw new Error("A forward rollback requires the full restored commit.");
    }
  }
  const qualification = { p1Journey, computerLifecycle, localReliability };
  const names = directArtifactNames(version);
  for (const definition of directQualificationReceipts) {
    const artifact = qualification[definition.key];
    if (
      artifact?.name !== names[definition.nameKey]
      || artifact?.gate !== definition.gate
      || artifact?.candidateFingerprint !== qa?.candidateFingerprint
      || !/^[a-f0-9]{64}$/.test(artifact?.sha256 || "")
      || !Number.isSafeInteger(artifact?.bytes)
      || artifact.bytes <= 0
    ) {
      throw new Error(`${definition.label} artifact does not match the qualified candidate contract.`);
    }
    assertImmutableArtifactUrl(artifact.url, version, artifact.name);
  }
  const platform = { url: archive.url, signature };
  const latest = {
    version,
    notes: normalizedNotes,
    pub_date: timestamp,
    platforms: { [releasePlatform]: platform },
    codelit: signedManifest,
  };
  const release = {
    schemaVersion: 1,
    version,
    channel: "direct",
    target: "aarch64-apple-darwin",
    minimumSystemVersion: "14.0",
    bundleIdentifier: "io.codelit.desktop",
    publishedAt: timestamp,
    notes: normalizedNotes,
    source: { repository: "https://github.com/codelit-io/codelit-gatsby", commit },
    artifacts: {
      archive,
      dmg,
      qa,
      qualification,
      sbom,
      provenance: { ...provenance, signature: provenanceSignature },
    },
    rollback: rollback ? { strategy: "forward-release", ...rollback } : null,
    publication: {
      immutableTag: `v${version}`,
      latestPointer: "latest.json",
      order: ["immutable-assets", "latest.json"],
    },
    updateManifest: {
      payloadSha256: sha256(signedPayloadBytes),
      signatureSha256: sha256(signedManifest.signature),
    },
  };
  const provenanceDocument = {
    schemaVersion: 1,
    predicateType: "https://codelit.io/provenance/desktop-release/v1",
    subject: [archive, dmg, qa, ...Object.values(qualification)].map((artifact) => ({
      name: artifact.name,
      digest: { sha256: artifact.sha256 },
      bytes: artifact.bytes,
    })),
    predicate: {
      version,
      channel: "direct",
      target: "aarch64-apple-darwin",
      minimumSystemVersion: "14.0",
      source: { repository: "https://github.com/codelit-io/codelit-gatsby", commit, dirty: false },
      build: { timestamp, tools },
      signing: {
        application: "Developer ID Application",
        hardenedRuntime: true,
        notarization: "stapled",
        updater: "minisign-verified",
        publicKeySha256: sha256(readFileSync(updaterPublicKeyPath)),
      },
      releaseNotesSha256: sha256(normalizedNotes),
      candidateQa: {
        fingerprint: qa.candidateFingerprint,
        digest: { sha256: qa.sha256 },
        bytes: qa.bytes,
      },
      focusedQualification: Object.fromEntries(
        Object.entries(qualification).map(([key, artifact]) => [key, qualificationBinding(artifact)]),
      ),
      updateManifest: release.updateManifest,
      sbom: { name: sbom.name, digest: { sha256: sbom.sha256 }, bytes: sbom.bytes },
      rollback: release.rollback,
    },
  };
  return { latest, release, provenance: provenanceDocument };
}

export function canonicalUpdatePayload({ version, notes, timestamp, archiveUrl, archiveSignature }) {
  parseStableVersion(version);
  const payload = {
    schemaVersion: 1,
    version,
    notes: normalizeReleaseNotes(notes),
    pubDate: assertIsoTimestamp(timestamp),
    platform: releasePlatform,
    url: archiveUrl,
    archiveSignature,
  };
  assertImmutableArtifactUrl(archiveUrl, version, directArtifactNames(version).archive);
  if (!archiveSignature || archiveSignature.length > 2_000) {
    throw new Error("Updater archive signature is missing or too large.");
  }
  return Buffer.from(JSON.stringify(payload));
}

function verifySignedManifest(latest, environment) {
  const envelope = latest.codelit;
  if (
    !envelope
    || typeof envelope.signedPayload !== "string"
    || typeof envelope.signature !== "string"
    || envelope.signedPayload.length > 24_000
    || envelope.signature.length > 2_000
  ) {
    throw new Error("latest.json is missing its bounded signed payload.");
  }
  const payloadBytes = decodeCanonicalBase64(envelope.signedPayload, "Signed update payload", 24_000);
  decodeCanonicalBase64(envelope.signature, "Signed update manifest signature", 2_000);
  const temporary = mkdtempSync(join(tmpdir(), "codelit-update-manifest-"));
  try {
    const payloadPath = resolve(temporary, "payload.json");
    const signaturePath = resolve(temporary, "payload.json.sig");
    writeFileSync(payloadPath, payloadBytes);
    writeFileSync(signaturePath, `${envelope.signature}\n`);
    verifyUpdaterSignature(payloadPath, signaturePath, environment);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("latest.json has an invalid signed payload.");
  }
  const platform = latest.platforms?.[releasePlatform];
  const expected = canonicalUpdatePayload({
    version: latest.version,
    notes: latest.notes,
    timestamp: latest.pub_date,
    archiveUrl: platform?.url,
    archiveSignature: platform?.signature,
  });
  if (!payloadBytes.equals(expected) || JSON.stringify(payload) !== expected.toString("utf8")) {
    throw new Error("latest.json does not match its signed payload.");
  }
  return {
    payloadSha256: sha256(payloadBytes),
    signatureSha256: sha256(envelope.signature),
  };
}

export function verifyAppleDirectArtifacts(archive, dmg, version, commit) {
  parseStableVersion(version);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Artifact verification requires a full source commit.");
  assertSafeCandidateArchiveEntries(commandOutput("tar", ["-tzf", archive]).split("\n").filter(Boolean));
  const extractionRoot = mkdtempSync(join(tmpdir(), "codelit-release-"));
  try {
    run("tar", ["-xzf", archive, "-C", extractionRoot]);
    const apps = readdirSync(extractionRoot).filter((entry) => entry.endsWith(".app"));
    if (apps.length !== 1 || apps[0] !== "Codelit.app") {
      throw new Error("Updater archive must contain exactly Codelit.app.");
    }
    const app = resolve(extractionRoot, "Codelit.app");
    if (lstatSync(app).isSymbolicLink()) throw new Error("Updater app bundle cannot be a symbolic link.");
    const infoPlist = resolve(app, "Contents/Info.plist");
    const bundleIdentifier = commandOutput("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist]);
    const bundleVersion = commandOutput("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlist]);
    const minimumSystemVersion = commandOutput("plutil", ["-extract", "LSMinimumSystemVersion", "raw", "-o", "-", infoPlist]);
    if (bundleIdentifier !== "io.codelit.desktop") throw new Error("Updater app has the wrong bundle identifier.");
    if (bundleVersion !== version) throw new Error(`Updater app version ${bundleVersion} does not match release ${version}.`);
    if (minimumSystemVersion !== "14.0") throw new Error("Updater app changed the locked macOS 14 minimum.");
    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
    run("xcrun", ["stapler", "validate", app]);
    const identity = JSON.parse(commandOutput(resolve(app, "Contents/MacOS/codelit-mac"), ["--release-identity"]));
    if (
      identity.bundleIdentifier !== "io.codelit.desktop"
      || identity.version !== version
      || identity.sourceCommit !== commit
      || identity.sourceDirty !== false
    ) {
      throw new Error("Updater app identity does not match the clean release source.");
    }
    run("hdiutil", ["verify", dmg]);
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

export function verifyUpdaterSignature(artifact, signature, environment = process.env) {
  run("cargo", [
    "run", "--quiet",
    "--manifest-path", resolve(tauriRoot, "Cargo.toml"),
    "--features", "release-tools",
    "--bin", "verify-update-signature",
    "--", updaterPublicKeyPath, artifact, signature,
  ], { env: environment });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertArtifact(directory, expected) {
  const path = resolve(directory, expected.name);
  if (!existsSync(path)) throw new Error(`Release is missing ${expected.name}.`);
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${expected.name} cannot be a symbolic link.`);
  const actual = artifactMetadata(path, expected.name, expected.url.match(/\/v([^/]+)\//)?.[1] || "");
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 || actual.url !== expected.url) {
    throw new Error(`${expected.name} does not match its release metadata.`);
  }
  return path;
}

export function verifyReleaseDirectory(directory, {
  previousManifestPath,
  initialRelease = false,
  verifyAppleArtifacts = true,
  environment = process.env,
} = {}) {
  if (Boolean(previousManifestPath) === Boolean(initialRelease)) {
    throw new Error("Choose exactly one of previousManifestPath or initialRelease.");
  }
  const latest = readJson(resolve(directory, "latest.json"));
  const release = readJson(resolve(directory, "release.json"));
  const version = release.version;
  const names = directArtifactNames(version);
  const expectedFiles = [
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
    "latest.json",
    "SHA256SUMS",
  ].sort();
  const actualFiles = readdirSync(directory).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Release directory contains missing or unexpected files.");
  }
  for (const name of actualFiles) {
    const path = resolve(directory, name);
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
      throw new Error(`Release entry ${name} must be a regular file.`);
    }
  }
  parseStableVersion(version);
  if (
    JSON.stringify(Object.keys(latest).sort()) !== JSON.stringify(["codelit", "notes", "platforms", "pub_date", "version"])
    || JSON.stringify(Object.keys(latest.platforms || {})) !== JSON.stringify([releasePlatform])
    || JSON.stringify(Object.keys(latest.platforms?.[releasePlatform] || {}).sort()) !== JSON.stringify(["signature", "url"])
  ) {
    throw new Error("latest.json contains unexpected update fields.");
  }
  if (
    release.schemaVersion !== 1
    || release.channel !== "direct"
    || release.target !== "aarch64-apple-darwin"
    || release.minimumSystemVersion !== "14.0"
    || release.bundleIdentifier !== "io.codelit.desktop"
    || release.source?.repository !== "https://github.com/codelit-io/codelit-gatsby"
    || !/^[a-f0-9]{40}$/.test(release.source?.commit || "")
    || release.artifacts?.archive?.name !== names.archive
    || release.artifacts?.archive?.signature?.name !== names.signature
    || release.artifacts?.dmg?.name !== names.dmg
    || release.artifacts?.qa?.name !== names.qa
    || release.artifacts?.qualification?.p1Journey?.name !== names.p1Journey
    || release.artifacts?.qualification?.computerLifecycle?.name !== names.computerLifecycle
    || release.artifacts?.qualification?.localReliability?.name !== names.localReliability
    || release.artifacts?.sbom?.name !== names.sbom
    || release.artifacts?.provenance?.name !== names.provenance
    || release.artifacts?.provenance?.signature?.name !== names.provenanceSignature
    || release.publication?.immutableTag !== `v${version}`
    || release.publication?.latestPointer !== "latest.json"
    || JSON.stringify(release.publication?.order) !== JSON.stringify(["immutable-assets", "latest.json"])
  ) {
    throw new Error("Immutable release metadata does not match the Direct channel contract.");
  }
  const provenance = readJson(resolve(directory, names.provenance));
  if (latest.version !== version || latest.notes !== release.notes || latest.pub_date !== release.publishedAt) {
    throw new Error("latest.json disagrees with immutable release metadata.");
  }
  if (Object.keys(latest.platforms || {}).join(",") !== releasePlatform) {
    throw new Error(`latest.json must contain exactly ${releasePlatform}.`);
  }
  if (latest.platforms[releasePlatform].url !== release.artifacts.archive.url) {
    throw new Error("latest.json points at the wrong updater archive.");
  }
  const signedManifest = verifySignedManifest(latest, environment);
  if (
    signedManifest.payloadSha256 !== release.updateManifest?.payloadSha256
    || signedManifest.signatureSha256 !== release.updateManifest?.signatureSha256
  ) {
    throw new Error("Release metadata does not bind the signed update manifest.");
  }
  assertImmutableArtifactUrl(release.artifacts.archive.url, version, release.artifacts.archive.name);
  assertImmutableArtifactUrl(release.artifacts.archive.signature.url, version, release.artifacts.archive.signature.name);
  assertImmutableArtifactUrl(release.artifacts.dmg.url, version, release.artifacts.dmg.name);
  assertImmutableArtifactUrl(release.artifacts.qa.url, version, release.artifacts.qa.name);
  for (const definition of directQualificationReceipts) {
    const artifact = release.artifacts.qualification[definition.key];
    assertImmutableArtifactUrl(artifact.url, version, artifact.name);
  }
  assertImmutableArtifactUrl(release.artifacts.sbom.url, version, release.artifacts.sbom.name);
  assertImmutableArtifactUrl(release.artifacts.provenance.url, version, release.artifacts.provenance.name);
  assertImmutableArtifactUrl(release.artifacts.provenance.signature.url, version, release.artifacts.provenance.signature.name);
  normalizeReleaseNotes(release.notes);
  assertIsoTimestamp(release.publishedAt);

  if (previousManifestPath) {
    const previous = readJson(previousManifestPath);
    assertVersionAdvances(version, previous.version);
  }
  if (release.rollback) {
    if (release.rollback.strategy !== "forward-release") throw new Error("Rollback strategy must remain forward-release.");
    if (compareStableVersions(release.rollback.restoresVersion, version) >= 0) {
      throw new Error("Rollback metadata must restore an older release through a newer version.");
    }
    if (!/^[a-f0-9]{40}$/.test(release.rollback.restoresCommit)) throw new Error("Rollback commit must be complete.");
  }

  const archivePath = assertArtifact(directory, release.artifacts.archive);
  const dmgPath = assertArtifact(directory, release.artifacts.dmg);
  const qaPath = assertArtifact(directory, release.artifacts.qa);
  const qualificationPaths = Object.fromEntries(directQualificationReceipts.map((definition) => [
    definition.key,
    assertArtifact(directory, release.artifacts.qualification[definition.key]),
  ]));
  const sbomPath = assertArtifact(directory, release.artifacts.sbom);
  const provenancePath = assertArtifact(directory, release.artifacts.provenance);
  const archiveSignaturePath = assertArtifact(directory, release.artifacts.archive.signature);
  const provenanceSignaturePath = assertArtifact(directory, release.artifacts.provenance.signature);
  const signaturePath = archiveSignaturePath;
  const updaterSignature = readFileSync(signaturePath, "utf8").trim();
  if (updaterSignature !== latest.platforms[releasePlatform].signature) {
    throw new Error("latest.json contains a different updater signature.");
  }
  verifyUpdaterSignature(archivePath, signaturePath, environment);
  verifyUpdaterSignature(provenancePath, provenanceSignaturePath, environment);
  const qaReceipt = readCandidateQaReceipt(qaPath);
  const qaIssues = candidateQaReceiptIssues(qaReceipt);
  if (qaIssues.length) throw new Error(`Published candidate QA is invalid: ${qaIssues.join(" ")}`);
  if (qaReceipt.candidate.source.commit !== release.source.commit || qaReceipt.candidate.version !== version) {
    throw new Error("Published candidate QA disagrees with the immutable release identity.");
  }
  const qualificationReceipts = Object.fromEntries(directQualificationReceipts.map((definition) => {
    const artifact = release.artifacts.qualification[definition.key];
    const receipt = validateQualificationReceipt(
      definition,
      qualificationPaths[definition.key],
      qaReceipt.candidate,
    );
    if (
      artifact.gate !== definition.gate
      || artifact.gate !== receipt.gate
      || artifact.candidateFingerprint !== receipt.candidateFingerprint
      || receipt.candidateFingerprint !== qaReceipt.candidateFingerprint
    ) {
      throw new Error(`Published ${definition.label} receipt disagrees with the signed candidate identity.`);
    }
    return [definition.key, receipt];
  }));
  for (const artifact of [release.artifacts.archive, release.artifacts.dmg]) {
    const receiptArtifact = qaReceipt.candidate.artifacts.find((candidate) => candidate.role === (artifact.name === names.dmg ? "dmg" : "updater-archive"));
    if (receiptArtifact?.sha256 !== artifact.sha256 || receiptArtifact?.bytes !== artifact.bytes) {
      throw new Error(`Published candidate QA does not bind ${artifact.name}.`);
    }
  }
  if (verifyAppleArtifacts) {
    verifyAppleDirectArtifacts(archivePath, dmgPath, version, release.source.commit);
    const candidate = inspectDesktopCandidate({
      channel: "direct",
      archivePath,
      dmgPath,
      requireCurrentSource: false,
    });
    const exactQaIssues = candidateQaReceiptIssues(qaReceipt, { candidate });
    if (exactQaIssues.length) throw new Error(`Published candidate QA does not match the signed app: ${exactQaIssues.join(" ")}`);
    for (const definition of directQualificationReceipts) {
      const exactIssues = definition.issues(qualificationReceipts[definition.key], { candidate });
      if (exactIssues.length) {
        throw new Error(`Published ${definition.label} receipt does not match the signed app: ${exactIssues.join(" ")}`);
      }
    }
  }

  const sbom = readJson(sbomPath);
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.metadata?.component?.version !== version) {
    throw new Error("CycloneDX SBOM metadata is incomplete.");
  }
  if (
    provenance.schemaVersion !== 1
    || provenance.predicateType !== "https://codelit.io/provenance/desktop-release/v1"
    || provenance.predicate?.version !== version
    || provenance.predicate?.channel !== release.channel
    || provenance.predicate?.target !== release.target
    || provenance.predicate?.minimumSystemVersion !== release.minimumSystemVersion
    || provenance.predicate?.source?.repository !== release.source.repository
    || provenance.predicate?.source?.commit !== release.source.commit
    || provenance.predicate?.source?.dirty !== false
  ) {
    throw new Error("Provenance source does not match the immutable release.");
  }
  if (JSON.stringify(provenance.predicate?.updateManifest) !== JSON.stringify(release.updateManifest)) {
    throw new Error("Provenance does not bind the signed update manifest.");
  }
  if (provenance.predicate?.releaseNotesSha256 !== sha256(release.notes)) {
    throw new Error("Provenance does not bind the published release notes.");
  }
  if (
    provenance.predicate?.candidateQa?.fingerprint !== qaReceipt.candidateFingerprint
    || provenance.predicate?.candidateQa?.digest?.sha256 !== release.artifacts.qa.sha256
    || provenance.predicate?.candidateQa?.bytes !== release.artifacts.qa.bytes
  ) {
    throw new Error("Provenance does not bind the signed-candidate QA receipt.");
  }
  for (const definition of directQualificationReceipts) {
    const artifact = release.artifacts.qualification[definition.key];
    const binding = provenance.predicate?.focusedQualification?.[definition.key];
    if (
      binding?.gate !== definition.gate
      || binding?.fingerprint !== artifact.candidateFingerprint
      || binding?.digest?.sha256 !== artifact.sha256
      || binding?.bytes !== artifact.bytes
    ) {
      throw new Error(`Provenance does not bind the ${definition.label} receipt.`);
    }
  }
  if (JSON.stringify(provenance.predicate?.rollback) !== JSON.stringify(release.rollback)) {
    throw new Error("Provenance does not bind the forward rollback declaration.");
  }
  if (provenance.predicate?.sbom?.digest?.sha256 !== release.artifacts.sbom.sha256) {
    throw new Error("Provenance does not bind the published SBOM.");
  }
  if (provenance.predicate?.signing?.publicKeySha256 !== sha256(readFileSync(updaterPublicKeyPath))) {
    throw new Error("Provenance does not bind the configured updater public key.");
  }
  const subjectArtifacts = [
    release.artifacts.archive,
    release.artifacts.dmg,
    release.artifacts.qa,
    ...directQualificationReceipts.map((definition) => release.artifacts.qualification[definition.key]),
  ];
  const subjects = new Map((provenance.subject || []).map((subject) => [subject.name, subject]));
  if (subjects.size !== subjectArtifacts.length || provenance.subject?.length !== subjectArtifacts.length) {
    throw new Error("Provenance must contain exactly one subject for every qualified release artifact.");
  }
  for (const artifact of subjectArtifacts) {
    const subject = subjects.get(artifact.name);
    if (subject?.digest?.sha256 !== artifact.sha256 || subject?.bytes !== artifact.bytes) {
      throw new Error(`Provenance does not bind ${artifact.name}.`);
    }
  }

  const expectedChecksumFiles = readdirSync(directory).filter((name) => name !== "SHA256SUMS").sort();
  const checksums = readFileSync(resolve(directory, "SHA256SUMS"), "utf8").trim().split("\n");
  const checksumNames = [];
  for (const line of checksums) {
    const match = /^([a-f0-9]{64})  ([^/]+)$/.exec(line);
    if (!match || sha256File(resolve(directory, match[2])) !== match[1]) {
      throw new Error(`Invalid checksum entry: ${line}.`);
    }
    checksumNames.push(match[2]);
  }
  if (JSON.stringify(checksumNames) !== JSON.stringify(expectedChecksumFiles)) {
    throw new Error("SHA256SUMS must cover every release file exactly once in sorted order.");
  }
  return { version, channel: "direct", target: releasePlatform, verified: true };
}

export function releaseToolVersions(environment = process.env) {
  const tauriCli = JSON.parse(readFileSync(resolve(appRoot, "package-lock.json"), "utf8"))
    .packages?.["node_modules/@tauri-apps/cli"]?.version;
  return {
    node: process.version,
    rustc: commandOutput("rustc", ["--version"], { env: environment }),
    cargo: commandOutput("cargo", ["--version"], { env: environment }),
    xcode: commandOutput("xcodebuild", ["-version"], { env: environment }).replace(/\n/g, "; "),
    tauriCli,
  };
}

export function createReleaseDirectory({
  output,
  archivePath,
  signaturePath,
  dmgPath,
  qaReceiptPath,
  p1ReceiptPath,
  computerLifecycleReceiptPath,
  reliabilityReceiptPath,
  notes,
  timestamp,
  commit,
  previousManifestPath,
  initialRelease,
  rollback,
  environment = process.env,
}) {
  const version = readReleaseVersion();
  const names = directArtifactNames(version);
  if (existsSync(output)) throw new Error(`Release output already exists at ${output}.`);
  const staging = `${output}.staging-${process.pid}`;
  if (existsSync(staging)) throw new Error(`Release staging path already exists at ${staging}.`);
  mkdirSync(staging, { recursive: true });
  try {
    const copiedArchive = resolve(staging, names.archive);
    const copiedSignature = resolve(staging, names.signature);
    const copiedDmg = resolve(staging, names.dmg);
    const copiedQa = resolve(staging, names.qa);
    const qualificationSourcePaths = {
      p1Journey: p1ReceiptPath,
      computerLifecycle: computerLifecycleReceiptPath,
      localReliability: reliabilityReceiptPath,
    };
    const copiedQualificationPaths = Object.fromEntries(directQualificationReceipts.map((definition) => [
      definition.key,
      resolve(staging, names[definition.nameKey]),
    ]));
    copyFileSync(archivePath, copiedArchive);
    copyFileSync(signaturePath, copiedSignature);
    copyFileSync(dmgPath, copiedDmg);
    copyFileSync(qaReceiptPath, copiedQa);
    for (const definition of directQualificationReceipts) {
      copyFileSync(qualificationSourcePaths[definition.key], copiedQualificationPaths[definition.key]);
    }
    const signature = readFileSync(copiedSignature, "utf8").trim();
    verifyUpdaterSignature(copiedArchive, copiedSignature, environment);

    const archiveSignature = artifactMetadata(copiedSignature, names.signature, version);
    const archive = { ...artifactMetadata(copiedArchive, names.archive, version), signature: archiveSignature };
    const dmg = artifactMetadata(copiedDmg, names.dmg, version);
    const qaReceipt = readCandidateQaReceipt(copiedQa);
    const qaIssues = candidateQaReceiptIssues(qaReceipt);
    if (qaIssues.length) throw new Error(`Signed-candidate QA is invalid: ${qaIssues.join(" ")}`);
    const qa = {
      ...artifactMetadata(copiedQa, names.qa, version),
      candidateFingerprint: qaReceipt.candidateFingerprint,
    };
    const qualification = Object.fromEntries(directQualificationReceipts.map((definition) => {
      const path = copiedQualificationPaths[definition.key];
      const receipt = validateQualificationReceipt(definition, path, qaReceipt.candidate);
      if (receipt.candidateFingerprint !== qaReceipt.candidateFingerprint) {
        throw new Error(`${definition.label} receipt belongs to a different signed candidate.`);
      }
      return [
        definition.key,
        qualificationArtifactMetadata(path, names[definition.nameKey], version, receipt),
      ];
    }));
    const sbomDocument = buildCycloneDxSbom({ version, commit, timestamp, environment });
    const sbomPath = resolve(staging, names.sbom);
    writeFileSync(sbomPath, `${JSON.stringify(sbomDocument, null, 2)}\n`);
    const sbom = artifactMetadata(sbomPath, names.sbom, version);

    const signedPayloadBytes = canonicalUpdatePayload({
      version,
      notes,
      timestamp,
      archiveUrl: archive.url,
      archiveSignature: signature,
    });
    const payloadPath = resolve(staging, ".update-manifest-payload.json");
    writeFileSync(payloadPath, signedPayloadBytes);
    run("npm", ["--prefix", "apps/mac", "run", "tauri", "--", "signer", "sign", payloadPath], {
      cwd: repositoryRoot,
      env: environment,
    });
    const payloadSignaturePath = `${payloadPath}.sig`;
    verifyUpdaterSignature(payloadPath, payloadSignaturePath, environment);
    const signedManifest = {
      signedPayload: signedPayloadBytes.toString("base64"),
      signature: readFileSync(payloadSignaturePath, "utf8").trim(),
    };
    rmSync(payloadPath);
    rmSync(payloadSignaturePath);

    const placeholder = { name: names.provenance, url: immutableArtifactUrl(version, names.provenance), bytes: 0, sha256: "" };
    const placeholderSignature = { name: names.provenanceSignature, sha256: "" };
    const draft = buildReleaseDocuments({
      version, notes, timestamp, commit, archive, signature, dmg, qa, ...qualification, sbom,
      provenance: placeholder,
      provenanceSignature: placeholderSignature,
      signedManifest,
      rollback,
      tools: releaseToolVersions(environment),
    });
    const provenancePath = resolve(staging, names.provenance);
    writeFileSync(provenancePath, `${JSON.stringify(draft.provenance, null, 2)}\n`);
    run("npm", ["--prefix", "apps/mac", "run", "tauri", "--", "signer", "sign", provenancePath], {
      cwd: repositoryRoot,
      env: environment,
    });
    const provenanceSignaturePath = `${provenancePath}.sig`;
    verifyUpdaterSignature(provenancePath, provenanceSignaturePath, environment);
    const provenance = artifactMetadata(provenancePath, names.provenance, version);
    const provenanceSignature = artifactMetadata(provenanceSignaturePath, names.provenanceSignature, version);
    const documents = buildReleaseDocuments({
      version, notes, timestamp, commit, archive, signature, dmg, qa, ...qualification, sbom,
      provenance,
      provenanceSignature,
      signedManifest,
      rollback,
      tools: releaseToolVersions(environment),
    });
    writeFileSync(resolve(staging, "release.json"), `${JSON.stringify(documents.release, null, 2)}\n`);
    writeFileSync(resolve(staging, "latest.json"), `${JSON.stringify(documents.latest, null, 2)}\n`);

    const checksumFiles = readdirSync(staging).filter((name) => name !== "SHA256SUMS").sort();
    const checksums = checksumFiles.map((name) => `${sha256File(resolve(staging, name))}  ${name}`).join("\n");
    writeFileSync(resolve(staging, "SHA256SUMS"), `${checksums}\n`);
    verifyReleaseDirectory(staging, {
      previousManifestPath,
      initialRelease,
      verifyAppleArtifacts: false,
      environment,
    });
    mkdirSync(dirname(output), { recursive: true });
    renameSync(staging, output);
    return { version, output, files: readdirSync(output).sort() };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
