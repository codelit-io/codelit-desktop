import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { appRoot, repositoryRoot, tauriRoot } from "./release-support.mjs";

export const candidateQaMemoryClasses = [
  { id: "8-gb", memoryGiB: 8, osClass: "minimum", localModel: "unavailable-as-designed" },
  { id: "16-gb", memoryGiB: 16, osClass: "previous", localModel: "unavailable-as-designed" },
  { id: "24-gb", memoryGiB: 24, osClass: "current", localModel: "unavailable-as-designed" },
  { id: "32-gb", memoryGiB: 32, osClass: "current", localModel: "passed" },
  { id: "64-gb", memoryGiB: 64, osClass: "current", localModel: "unavailable-as-designed" },
];

const commonChecks = [
  ["fresh-install-relaunch", "Fresh install, create a bot and local workspace records, quit, relaunch, and restore"],
  ["two-schema-upgrade", "Upgrade across two schema versions without losing local work"],
  ["downgrade-refusal", "Refuse downgrade without changing local data"],
  ["uninstall-reinstall-delete", "Uninstall, reinstall, and complete local-data deletion"],
  ["provider-lifecycle", "Exercise ready, sign-out, quota, missing, and incompatible provider states"],
  ["offline-network", "Exercise offline, intermittent network, and captive-portal recovery"],
  ["system-lifecycle", "Exercise sleep, wake, logout, login, and restart recovery"],
  ["resource-pressure", "Exercise low battery, Low Power Mode, thermal pressure, and low disk"],
  ["repository-safety", "Exercise revoked folders, moved repos, symlink escape, dirty worktrees, conflicts, and a large repo"],
  ["model-lifecycle", "Exercise model interruption, corruption, disk pressure, license rejection, memory pressure, and cancellation"],
  ["run-recovery", "Exercise canceled runs, killed providers/helpers, corrupted event tails, and stale approvals"],
  ["local-network-capture", "Capture traffic proving on-device work contacts neither Codelit nor a provider"],
  ["assistive-input", "Complete VoiceOver and keyboard-only workflows"],
  ["visual-accessibility", "Verify increased contrast, reduced motion, light mode, and dark mode"],
  ["window-layout", "Verify minimum and release window sizes without clipped controls or nested scrolling"],
];

const channelChecks = {
  direct: [
    ["direct-provider-adapters", "Exercise the supported Codex, Claude Code, and Ollama adapter boundaries"],
    ["direct-agent-browser", "Complete an agent website inspection, approval, evidence capture, and recovery"],
    ["direct-scheduler", "Exercise duplicate wake, disable, deletion, login, restart, and upgrade replacement"],
    ["direct-gatekeeper", "Verify Developer ID signing, Gatekeeper, notarization, and staples"],
    ["direct-update-rollback", "Install a signed update, relaunch, and complete a newer forward rollback"],
  ],
  "app-store": [
    ["app-store-sandbox", "Verify the exact sandbox capability set and blocked Direct-only paths"],
    ["app-store-browser-boundary", "Verify automated website inspection and computer control remain unavailable"],
    ["app-store-commerce", "Verify no price, checkout, purchase prompt, or external purchase link appears"],
    ["app-store-account-deletion", "Complete local-data deletion and verify no Codelit account is required"],
    ["testflight-install-update", "Install and update this exact build through TestFlight"],
  ],
};

export const candidateQaAttestation =
  "I verified every recorded check against this exact signed candidate and attached truthful evidence.";
export const candidateQaPreflightAttestation =
  "I approve this exact signed candidate for private qualification delivery after reviewing its identity and distribution boundary.";

export function requiredCandidateQaChecks(channel) {
  if (!Object.hasOwn(channelChecks, channel)) throw new Error(`Unsupported desktop release channel ${channel}.`);
  return [...commonChecks, ...channelChecks[channel]].map(([id, label]) => ({ id, label }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function canonicalCandidate(candidate) {
  return JSON.stringify(candidate);
}

function comparableCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return candidate;
  return {
    channel: candidate.channel,
    bundleIdentifier: candidate.bundleIdentifier,
    version: candidate.version,
    build: candidate.build,
    minimumSystemVersion: candidate.minimumSystemVersion,
    source: candidate.source,
    app: candidate.app,
    package: candidate.package,
    artifacts: Array.isArray(candidate.artifacts)
      ? candidate.artifacts
        .map(({ role, bytes, sha256: digest }) => ({ role, bytes, sha256: digest }))
        .sort((left, right) => left.role.localeCompare(right.role))
      : candidate.artifacts,
  };
}

export function candidateFingerprint(candidate) {
  return sha256(canonicalCandidate(candidate));
}

function isoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function evidenceIsValid(value) {
  return /^[a-f0-9]{64}$/.test(value || "");
}

export function candidateDescriptorIssues(candidate, channel) {
  const issues = [];
  if (candidate?.channel !== channel) issues.push("The candidate channel does not match the QA receipt.");
  if (candidate?.bundleIdentifier !== "io.codelit.desktop") issues.push("The candidate has the wrong bundle identifier.");
  if (!/^\d+\.\d+\.\d+$/.test(candidate?.version || "")) issues.push("The candidate is missing a stable version.");
  if (!/^[1-9]\d{0,17}$/.test(candidate?.build || "")) issues.push("The candidate is missing a positive build number.");
  if (candidate?.minimumSystemVersion !== "14.0") issues.push("The candidate changed the locked macOS 14 minimum.");
  if (!/^[a-f0-9]{40}$/.test(candidate?.source?.commit || "") || candidate?.source?.dirty !== false) {
    issues.push("The candidate must embed one clean full source commit.");
  }
  const app = candidate?.app || {};
  if (!/^[a-f0-9]{40}$/.test(app.cdHash || "")) issues.push("The candidate is missing its app CDHash.");
  if (!/^[a-f0-9]{64}$/.test(app.executableSha256 || "")) issues.push("The candidate is missing its executable digest.");
  if (!/^[A-Z0-9]{10}$/.test(app.teamIdentifier || "")) issues.push("The candidate is missing its Apple team identifier.");
  if (!Array.isArray(app.authorities) || !app.authorities.length) issues.push("The candidate is missing its signing authority chain.");
  if (channel === "direct") {
    if (!app.authorities?.[0]?.startsWith("Developer ID Application:")) issues.push("The Direct app is not Developer ID signed.");
    if (app.sandboxed !== false || app.hardenedRuntime !== true) issues.push("The Direct app must use hardened runtime without App Sandbox.");
  } else {
    if (!app.authorities?.some((authority) => /^(3rd Party Mac Developer Application|Apple Distribution|Mac App Distribution):/.test(authority))) {
      issues.push("The App Store app is not signed for Mac App Distribution.");
    }
    if (app.sandboxed !== true) issues.push("The App Store app must use App Sandbox.");
    if (!/^(3rd Party Mac Developer Installer|Mac Installer Distribution):/.test(candidate?.package?.authority || "")) {
      issues.push("The App Store package is not signed for Mac Installer Distribution.");
    }
  }
  const expectedRoles = channel === "direct" ? ["dmg", "updater-archive"] : ["app-store-package"];
  const artifacts = Array.isArray(candidate?.artifacts) ? candidate.artifacts : [];
  if (JSON.stringify(artifacts.map((artifact) => artifact?.role).sort()) !== JSON.stringify(expectedRoles.sort())) {
    issues.push("The candidate does not contain the exact distribution artifacts for its channel.");
  }
  for (const artifact of artifacts) {
    if (
      typeof artifact?.name !== "string"
      || artifact.name !== basename(artifact.name)
      || !Number.isSafeInteger(artifact?.bytes)
      || artifact.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(artifact?.sha256 || "")
    ) {
      issues.push(`The ${artifact?.role || "unknown"} artifact metadata is invalid.`);
    }
  }
  return issues;
}

/**
 * @param {any} receipt
 * @param {{ candidate?: any, stage?: "release" | "testflight-upload" }} [options]
 */
export function candidateQaReceiptIssues(receipt, { candidate, stage = "release" } = {}) {
  const issues = [];
  const channel = receipt?.channel;
  const testFlightUpload = stage === "testflight-upload";
  if (!testFlightUpload && stage !== "release") issues.push("The signed-candidate QA stage is unsupported.");
  if (testFlightUpload && channel !== "app-store") issues.push("Only an App Store candidate can use the TestFlight upload stage.");
  if (receipt?.schemaVersion !== 2) issues.push("The signed-candidate QA schema is unsupported.");
  if (!Object.hasOwn(channelChecks, channel || "")) issues.push("The signed-candidate QA channel is unsupported.");
  const acceptedStatuses = testFlightUpload ? ["testflight-ready", "passed"] : ["passed"];
  if (!acceptedStatuses.includes(receipt?.status)) issues.push("The signed-candidate QA receipt has not passed the required stage.");
  if (!isoTimestamp(receipt?.preflightCompletedAt)) {
    issues.push("The signed-candidate QA receipt needs an exact UTC preflight completion time.");
  }
  if (receipt?.status === "passed" && !isoTimestamp(receipt?.completedAt)) {
    issues.push("The signed-candidate QA receipt needs an exact UTC release completion time.");
  }
  if (receipt?.status === "testflight-ready" && receipt?.completedAt !== null) {
    issues.push("A preflight-only receipt cannot claim release completion.");
  }
  if (
    isoTimestamp(receipt?.preflightCompletedAt)
    && isoTimestamp(receipt?.completedAt)
    && receipt.completedAt < receipt.preflightCompletedAt
  ) {
    issues.push("Release completion cannot precede candidate preflight.");
  }
  if (channel) issues.push(...candidateDescriptorIssues(receipt?.candidate, channel));
  const fingerprint = candidateFingerprint(receipt?.candidate || null);
  if (receipt?.candidateFingerprint !== fingerprint) issues.push("The signed-candidate QA fingerprint is invalid.");
  if (candidate && canonicalCandidate(comparableCandidate(receipt?.candidate)) !== canonicalCandidate(comparableCandidate(candidate))) {
    issues.push("The signed-candidate QA receipt belongs to different release artifacts.");
  }

  const coverage = Array.isArray(receipt?.environmentCoverage) ? receipt.environmentCoverage : [];
  for (const expected of candidateQaMemoryClasses) {
    const matches = coverage.filter((entry) => entry?.memoryClass === expected.id);
    if (matches.length !== 1) {
      issues.push(`The signed-candidate QA receipt needs exactly one ${expected.id} environment.`);
      continue;
    }
    const [entry] = matches;
    const staticEnvironmentIsValid = entry.memoryGiB === expected.memoryGiB
      && entry.architecture === "arm64"
      && entry.osClass === expected.osClass
      && entry.localModel === expected.localModel;
    const pendingForTestFlight = testFlightUpload
      && receipt?.status === "testflight-ready"
      && entry.result === "pending"
      && entry.macOSVersion === "RECORD_EXACT_VERSION"
      && entry.evidence === "";
    const completedEnvironmentIsValid = entry.result === "passed"
      && /^\d+(?:\.\d+){1,2}$/.test(entry.macOSVersion || "")
      && evidenceIsValid(entry.evidence);
    const environmentResultIsValid = testFlightUpload && receipt?.status === "testflight-ready"
      ? pendingForTestFlight
      : completedEnvironmentIsValid;
    if (!staticEnvironmentIsValid || !environmentResultIsValid) {
      issues.push(`The signed-candidate QA environment ${expected.id} is incomplete or inconsistent.`);
    }
  }
  if (
    !coverage.some((entry) => entry?.osClass === "current")
    || !coverage.some((entry) => entry?.osClass === "previous")
    || !coverage.some((entry) => entry?.osClass === "minimum")
  ) {
    issues.push("The signed-candidate QA receipt must cover minimum, previous, and current supported macOS releases.");
  }
  if (coverage.some((entry) => !candidateQaMemoryClasses.some((expected) => expected.id === entry?.memoryClass))) {
    issues.push("The signed-candidate QA receipt contains an unexpected hardware class.");
  }

  if (Object.hasOwn(channelChecks, channel || "")) {
    const expectedChecks = requiredCandidateQaChecks(channel);
    const checks = Array.isArray(receipt?.checks) ? receipt.checks : [];
    for (const expected of expectedChecks) {
      const matches = checks.filter((check) => check?.id === expected.id);
      const testFlightPending = testFlightUpload
        && receipt?.status === "testflight-ready"
        && matches.length === 1
        && matches[0]?.label === expected.label
        && matches[0]?.result === "pending"
        && matches[0]?.evidence === "";
      const valid = testFlightUpload && receipt?.status === "testflight-ready"
        ? testFlightPending
        : matches.length === 1
          && matches[0]?.label === expected.label
          && matches[0]?.result === "passed"
          && evidenceIsValid(matches[0]?.evidence);
      if (!valid) {
        issues.push(`The signed-candidate QA check ${expected.id} is incomplete.`);
      }
    }
    if (checks.some((check) => !expectedChecks.some((expected) => expected.id === check?.id))) {
      issues.push("The signed-candidate QA receipt contains an unexpected check.");
    }
  }
  const preflightAttestation = receipt?.attestation?.preflight;
  if (
    preflightAttestation?.role !== "release-owner"
    || preflightAttestation?.statement !== candidateQaPreflightAttestation
    || !isoTimestamp(preflightAttestation?.signedAt)
  ) {
    issues.push("The signed-candidate QA receipt is missing its preflight attestation.");
  } else if (preflightAttestation.signedAt < receipt.preflightCompletedAt) {
    issues.push("The preflight attestation cannot precede candidate preflight.");
  }
  if (!testFlightUpload || receipt?.status === "passed") {
    const releaseAttestation = receipt?.attestation?.release;
    if (
      releaseAttestation?.role !== "release-owner"
      || releaseAttestation?.statement !== candidateQaAttestation
      || !isoTimestamp(releaseAttestation?.signedAt)
    ) {
      issues.push("The signed-candidate QA receipt is missing its release attestation.");
    } else if (releaseAttestation.signedAt < receipt.completedAt) {
      issues.push("The release attestation cannot precede release completion.");
    }
  } else if (receipt?.attestation?.release?.signedAt !== null) {
    issues.push("A TestFlight-ready receipt cannot include a release attestation.");
  }
  return [...new Set(issues)];
}

function commandOutput(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

export function assertSafeCandidateArchiveEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("The updater archive is empty.");
  const roots = new Set();
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry || entry.includes("\\")) {
      throw new Error("The updater archive contains an invalid path.");
    }
    const parts = entry.replace(/\/+$/, "").split("/");
    if (entry.startsWith("/") || parts.includes("..")) {
      throw new Error(`The updater archive contains unsafe path ${entry}.`);
    }
    const meaningful = parts.filter((part) => part && part !== ".");
    if (meaningful.length) roots.add(meaningful[0]);
  }
  if (roots.size !== 1 || !roots.has("Codelit.app")) {
    throw new Error("The updater archive must contain only one top-level Codelit.app bundle.");
  }
}

function assertSafeCandidateArchive(archive) {
  assertSafeCandidateArchiveEntries(commandOutput("tar", ["-tzf", archive]).split("\n").filter(Boolean));
}

function regularArtifact(path, role) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error(`${role} must be a non-symlink regular file.`);
  }
  const stats = statSync(absolute);
  if (!stats.size) throw new Error(`${role} cannot be empty.`);
  return { role, name: basename(absolute), bytes: stats.size, sha256: sha256File(absolute) };
}

function plistValue(path, key) {
  return commandOutput("plutil", ["-extract", key, "raw", "-o", "-", path]);
}

export function signedAppStoreReleaseIdentity(appPath) {
  const resources = resolve(appPath, "Contents/Resources");
  const path = resolve(resources, "codelit-release-identity.json");
  if (
    !existsSync(resources)
    || lstatSync(resources).isSymbolicLink()
    || !statSync(resources).isDirectory()
    || !existsSync(path)
    || lstatSync(path).isSymbolicLink()
    || !statSync(path).isFile()
  ) {
    throw new Error("The App Store candidate is missing its signed release identity.");
  }
  let identity;
  try {
    identity = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("The App Store candidate has an invalid signed release identity.");
  }
  if (
    identity?.schemaVersion !== 1
    || identity?.channel !== "app-store"
    || !/^[a-f0-9]{40}$/.test(identity?.sourceCommit || "")
    || typeof identity?.sourceDirty !== "boolean"
  ) {
    throw new Error("The App Store candidate has an invalid signed release identity.");
  }
  return identity;
}

function inspectApp(appPath, channel) {
  const app = resolve(appPath);
  if (!existsSync(app) || lstatSync(app).isSymbolicLink() || !statSync(app).isDirectory()) {
    throw new Error("The candidate app must be a non-symlink bundle directory.");
  }
  const executable = resolve(app, "Contents/MacOS/codelit-mac");
  const info = resolve(app, "Contents/Info.plist");
  commandOutput("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const details = commandOutput("codesign", ["-d", "--verbose=4", app]);
  const authorities = [...details.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]);
  const cdHash = details.match(/^CDHash=([a-f0-9]{40})$/m)?.[1];
  const teamIdentifier = details.match(/^TeamIdentifier=([A-Z0-9]{10})$/m)?.[1];
  const entitlements = commandOutput("codesign", ["-d", "--entitlements", ":-", app]);
  const identity = channel === "app-store"
    ? signedAppStoreReleaseIdentity(app)
    : JSON.parse(commandOutput(executable, ["--release-identity"]));
  const descriptor = {
    channel,
    bundleIdentifier: plistValue(info, "CFBundleIdentifier"),
    version: plistValue(info, "CFBundleShortVersionString"),
    build: plistValue(info, "CFBundleVersion"),
    minimumSystemVersion: plistValue(info, "LSMinimumSystemVersion"),
    source: { commit: identity.sourceCommit, dirty: identity.sourceDirty },
    app: {
      cdHash,
      executableSha256: sha256File(executable),
      teamIdentifier,
      authorities,
      hardenedRuntime: details.includes("runtime"),
      sandboxed: entitlements.includes("com.apple.security.app-sandbox"),
    },
  };
  const issues = candidateDescriptorIssues({
    ...descriptor,
    artifacts: channel === "direct"
      ? [{ role: "dmg", name: "placeholder", bytes: 1, sha256: "a".repeat(64) }, { role: "updater-archive", name: "placeholder", bytes: 1, sha256: "a".repeat(64) }]
      : [{ role: "app-store-package", name: "placeholder", bytes: 1, sha256: "a".repeat(64) }],
    ...(channel === "app-store" ? { package: { authority: "3rd Party Mac Developer Installer: pending" } } : {}),
  }, channel).filter((issue) => !issue.includes("package"));
  if (issues.length) throw new Error(issues.join(" "));
  return descriptor;
}

function oneExtractedApp(root) {
  const pending = [root];
  const apps = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && entry.name.endsWith(".app")) apps.push(path);
      else if (entry.isDirectory()) pending.push(path);
    }
  }
  if (apps.length !== 1 || basename(apps[0]) !== "Codelit.app") {
    throw new Error("The candidate artifact must contain exactly one Codelit.app.");
  }
  return apps[0];
}

function sameApp(left, right) {
  return left.app.cdHash === right.app.cdHash
    && left.app.executableSha256 === right.app.executableSha256
    && left.source.commit === right.source.commit
    && left.version === right.version
    && left.build === right.build;
}

function currentReleaseIdentity(candidate) {
  const sourceCommit = commandOutput("git", ["rev-parse", "HEAD"]);
  const sourceDirty = commandOutput("git", ["status", "--porcelain", "--untracked-files=normal"]) !== "";
  const config = JSON.parse(readFileSync(resolve(tauriRoot, "tauri.conf.json"), "utf8"));
  const appPackage = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8"));
  if (sourceDirty || candidate.source.commit !== sourceCommit) throw new Error("The signed candidate does not match this clean source commit.");
  if (candidate.version !== appPackage.version || candidate.version !== config.version) throw new Error("The signed candidate version does not match the desktop source.");
  if (candidate.build !== config.bundle?.macOS?.bundleVersion) throw new Error("The signed candidate build does not match CFBundleVersion.");
}

export function inspectDesktopCandidate({
  channel,
  archivePath,
  dmgPath,
  packagePath,
  requireCurrentSource = true,
}) {
  if (!Object.hasOwn(channelChecks, channel || "")) throw new Error("Use channel direct or app-store.");
  const temporary = mkdtempSync(join(tmpdir(), `codelit-${channel}-candidate-`));
  let mounted = false;
  try {
    if (channel === "direct") {
      const archive = regularArtifact(archivePath, "updater-archive");
      const dmg = regularArtifact(dmgPath, "dmg");
      const archiveRoot = resolve(temporary, "archive");
      mkdirSync(archiveRoot);
      assertSafeCandidateArchive(resolve(archivePath));
      commandOutput("tar", ["-xzf", resolve(archivePath), "-C", archiveRoot]);
      const archiveApp = inspectApp(oneExtractedApp(archiveRoot), channel);
      const mount = resolve(temporary, "mount");
      mkdirSync(mount);
      commandOutput("hdiutil", ["attach", resolve(dmgPath), "-nobrowse", "-readonly", "-mountpoint", mount]);
      mounted = true;
      const dmgApp = inspectApp(oneExtractedApp(mount), channel);
      if (!sameApp(archiveApp, dmgApp)) throw new Error("The DMG and updater archive contain different apps.");
      commandOutput("spctl", ["--assess", "--type", "execute", "--verbose=4", oneExtractedApp(archiveRoot)]);
      commandOutput("xcrun", ["stapler", "validate", oneExtractedApp(archiveRoot)]);
      commandOutput("hdiutil", ["verify", resolve(dmgPath)]);
      commandOutput("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", resolve(dmgPath)]);
      commandOutput("xcrun", ["stapler", "validate", resolve(dmgPath)]);
      const candidate = { ...archiveApp, artifacts: [dmg, archive] };
      if (requireCurrentSource) currentReleaseIdentity(candidate);
      return candidate;
    }

    const packageArtifact = regularArtifact(packagePath, "app-store-package");
    const signature = commandOutput("pkgutil", ["--check-signature", resolve(packagePath)]);
    if (!/Status:\s+signed/i.test(signature)) throw new Error("The App Store package signature is not trusted.");
    const authority = signature.match(/^\s*1\.\s+(.+)$/m)?.[1];
    if (!/^(3rd Party Mac Developer Installer|Mac Installer Distribution):/.test(authority || "")) {
      throw new Error("The App Store package is not signed for Mac Installer Distribution.");
    }
    const expanded = resolve(temporary, "package");
    commandOutput("pkgutil", ["--expand-full", resolve(packagePath), expanded]);
    const app = inspectApp(oneExtractedApp(expanded), channel);
    const candidate = { ...app, package: { authority }, artifacts: [packageArtifact] };
    const issues = candidateDescriptorIssues(candidate, channel);
    if (issues.length) throw new Error(issues.join(" "));
    if (requireCurrentSource) currentReleaseIdentity(candidate);
    return candidate;
  } finally {
    if (mounted) spawnSync("hdiutil", ["detach", resolve(temporary, "mount")], { stdio: "ignore" });
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function readCandidateQaReceipt(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
    throw new Error("The signed-candidate QA receipt must be a non-symlink regular file.");
  }
  const bytes = readFileSync(absolute);
  if (!bytes.length || bytes.length > 512 * 1024) throw new Error("The signed-candidate QA receipt is empty or too large.");
  return JSON.parse(bytes.toString("utf8"));
}

export function createCandidateQaDraft(candidate) {
  const checks = requiredCandidateQaChecks(candidate.channel);
  return {
    schemaVersion: 2,
    status: "pending",
    channel: candidate.channel,
    preflightCompletedAt: null,
    completedAt: null,
    candidate,
    candidateFingerprint: candidateFingerprint(candidate),
    environmentCoverage: candidateQaMemoryClasses.map((environment) => ({
      memoryClass: environment.id,
      memoryGiB: environment.memoryGiB,
      architecture: "arm64",
      osClass: environment.osClass,
      macOSVersion: "RECORD_EXACT_VERSION",
      result: "pending",
      localModel: environment.localModel,
      evidence: "",
    })),
    checks: checks.map((check) => ({ ...check, result: "pending", evidence: "" })),
    attestation: {
      preflight: {
        role: "release-owner",
        statement: candidateQaPreflightAttestation,
        signedAt: null,
      },
      release: {
        role: "release-owner",
        statement: candidateQaAttestation,
        signedAt: null,
      },
    },
  };
}
