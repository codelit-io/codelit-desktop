import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  appStoreSubmissionIssues,
  readAppStoreSubmission,
} from "./app-store-submission.mjs";
import {
  desktopRendererQaReceiptIssues,
  readDesktopRendererQaReceipt,
} from "./desktop-renderer-qa-receipt.mjs";

export const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const appRoot = resolve(scriptsDirectory, "..");
export const repositoryRoot = resolve(appRoot, "../..");
export const tauriRoot = resolve(appRoot, "src-tauri");
export const bundlePath = resolve(tauriRoot, "target/release/bundle/macos/Codelit.app");
export const directDmgPath = (version) => resolve(
  tauriRoot,
  `target/release/bundle/dmg/Codelit_${version}_aarch64.dmg`,
);
export const botsP1BetaPolicy = readJson(resolve(appRoot, "bots-p1-beta-policy.json"));

export function appStoreEntitlementBody({ child = false, applicationIdentifier = "", teamIdentifier = "" }) {
  if (!child && (!applicationIdentifier || !teamIdentifier)) {
    throw new Error("The App Store parent entitlements require application and team identifiers.");
  }
  const capabilities = child
    ? "  <key>com.apple.security.inherit</key><true/>"
    : `  <key>com.apple.security.files.user-selected.read-only</key><true/>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.application-identifier</key><string>${applicationIdentifier}</string>
  <key>com.apple.developer.team-identifier</key><string>${teamIdentifier}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
${capabilities}
</dict></plist>
`;
}

export function appStoreBundlePermissionIssues(root) {
  if (!existsSync(root)) return [`App Store bundle is missing: ${root}`];
  const issues = [];
  const pending = [root];
  while (pending.length) {
    const path = pending.pop();
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      if ((stats.mode & 0o005) !== 0o005) issues.push(`Directory is not readable and searchable by non-root users: ${path}`);
      for (const entry of readdirSync(path)) pending.push(resolve(path, entry));
      continue;
    }
    if (stats.isFile()) {
      const required = (stats.mode & 0o100) !== 0 ? 0o005 : 0o004;
      if ((stats.mode & required) !== required) issues.push(`File is not readable${required === 0o005 ? " and executable" : ""} by non-root users: ${path}`);
    }
  }
  return issues;
}

const directComputerUseSymbols = [
  "AXIsProcessTrusted",
  "CGPreflightScreenCaptureAccess",
  "CGSessionCopyCurrentDictionary",
];

export function computerUseChannelIssues(executable, channel) {
  const symbols = execFileSync("nm", ["-u", executable], { encoding: "utf8" });
  const imported = directComputerUseSymbols.filter((symbol) => symbols.includes(symbol));
  const capabilities = releaseCapabilitiesForAudit(executable, channel);
  const capabilityIssues = releaseCapabilityIssues(capabilities, channel);
  if (channel === "direct") {
    const issues = directComputerUseSymbols
      .filter((symbol) => !imported.includes(symbol))
      .map((symbol) => `The Direct binary is missing computer-use import ${symbol}.`);
    return [...issues, ...capabilityIssues];
  }
  const issues = imported.map((symbol) => `The App Store binary imports Direct-only computer-use API ${symbol}.`);
  return [...issues, ...capabilityIssues];
}

function releaseCapabilitiesForAudit(executable, channel) {
  let probeDirectory;
  let probeExecutable = executable;
  let capabilities;
  try {
    if (channel === "app-store") {
      // macOS terminates a distribution-signed sandbox executable launched outside its app container.
      // Re-sign an isolated copy so the exact packaged code can answer the audit handshake.
      probeDirectory = mkdtempSync(resolve(tmpdir(), "codelit-release-capability-"));
      probeExecutable = resolve(probeDirectory, "codelit-mac");
      copyFileSync(executable, probeExecutable);
      execFileSync("codesign", ["--force", "--sign", "-", probeExecutable], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
    }
    capabilities = JSON.parse(execFileSync(probeExecutable, ["--release-capabilities"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    }));
  } catch {
    capabilities = null;
  } finally {
    if (probeDirectory) rmSync(probeDirectory, { recursive: true, force: true });
  }
  return capabilities;
}

export function releaseCapabilityIssues(capabilities, channel) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return ["The desktop binary did not return its release capability contract."];
  }
  const issues = [];
  const rootKeys = Object.keys(capabilities).sort();
  if (rootKeys.join(",") !== "channel,probes,schemaVersion") {
    issues.push("The desktop release capability contract contains unsupported fields.");
  }
  if (capabilities.schemaVersion !== 1) {
    issues.push("The desktop release capability contract has an unsupported schema.");
  }
  if (capabilities.channel !== channel) {
    issues.push("The desktop binary reports a different release channel.");
  }
  const probes = capabilities.probes;
  if (!probes || typeof probes !== "object" || Array.isArray(probes)) {
    issues.push("The desktop release capability contract is missing its probes.");
    return issues;
  }
  const probeKeys = Object.keys(probes).sort();
  if (probeKeys.join(",") !== "backgroundService,computerUse,resourcePolicy") {
    issues.push("The desktop release capability contract contains unsupported probes.");
  }
  if (probes.backgroundService !== true) {
    issues.push("The desktop binary is missing its background-service qualification probe.");
  }
  if (probes.resourcePolicy !== true) {
    issues.push("The desktop binary is missing its exact-candidate resource-policy probe.");
  }
  if (channel === "direct" && probes.computerUse !== true) {
    issues.push("The Direct binary is missing its computer-use qualification probe.");
  }
  if (channel === "app-store" && probes.computerUse !== false) {
    issues.push("The App Store binary exposes the Direct-only computer-use qualification probe.");
  }
  return issues;
}

export function parseReleaseArguments(arguments_) {
  const valueAfter = (name) => {
    const index = arguments_.indexOf(name);
    return index >= 0 ? arguments_[index + 1] : undefined;
  };
  const channel = valueAfter("--channel") || "all";
  if (!["all", "direct", "app-store"].includes(channel)) {
    throw new Error("Use --channel direct, --channel app-store, or omit it to check both.");
  }
  return {
    channel,
    adhoc: arguments_.includes("--adhoc"),
    json: arguments_.includes("--json"),
  };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function installedIdentities(policy) {
  const arguments_ = ["find-identity", "-v"];
  if (policy) arguments_.push("-p", policy);
  const result = spawnSync("security", arguments_, {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return [...result.stdout.matchAll(/^\s*\d+\)\s+[A-F0-9]+\s+"([^"]+)"/gm)]
    .map((match) => match[1]);
}

export function signingIdentityIssues({ channel, environment, codeIdentities, allIdentities }) {
  const issues = [];
  if (channel === "direct") {
    const identity = environment.APPLE_SIGNING_IDENTITY;
    if (identity) {
      if (!identity.startsWith("Developer ID Application:") || !codeIdentities.includes(identity)) {
        issues.push("APPLE_SIGNING_IDENTITY must name an installed Developer ID Application identity.");
      }
    } else if (codeIdentities.some((candidate) => candidate.startsWith("Developer ID Application:"))) {
      issues.push("Set APPLE_SIGNING_IDENTITY to the exact installed Developer ID Application certificate name.");
    } else {
      issues.push("Install a Developer ID Application signing identity, then set APPLE_SIGNING_IDENTITY to its exact certificate name.");
    }
    return issues;
  }

  const application = environment.APPLE_SIGNING_IDENTITY;
  if (!application) {
    issues.push("Set APPLE_SIGNING_IDENTITY to the exact Mac App Distribution certificate name.");
  } else if (
    !["3rd Party Mac Developer Application:", "Apple Distribution:", "Mac App Distribution:"].some((prefix) => application.startsWith(prefix))
    || !codeIdentities.includes(application)
  ) {
    issues.push("APPLE_SIGNING_IDENTITY must name an installed Mac App Distribution identity.");
  }

  const installer = environment.CODELIT_INSTALLER_SIGNING_IDENTITY;
  if (!installer) {
    issues.push("Set CODELIT_INSTALLER_SIGNING_IDENTITY to the exact Mac Installer Distribution certificate name.");
  } else if (
    !["3rd Party Mac Developer Installer:", "Mac Installer Distribution:"].some((prefix) => installer.startsWith(prefix))
    || !allIdentities.includes(installer)
  ) {
    issues.push("CODELIT_INSTALLER_SIGNING_IDENTITY must name an installed Mac Installer Distribution identity.");
  }
  return issues;
}

export function appStoreProvisioningIdentifiers(entitlements) {
  const applicationIdentifier = entitlements?.["com.apple.application-identifier"]
    || entitlements?.["application-identifier"];
  const teamIdentifier = entitlements?.["com.apple.developer.team-identifier"];
  if (typeof applicationIdentifier !== "string" || !applicationIdentifier) {
    throw new Error("The provisioning profile is missing its application identifier entitlement.");
  }
  if (typeof teamIdentifier !== "string" || !teamIdentifier) {
    throw new Error("The provisioning profile is missing its team identifier entitlement.");
  }
  return { applicationIdentifier, teamIdentifier };
}

function hasNotaryCredentials(environment) {
  const api = environment.APPLE_API_KEY
    && environment.APPLE_API_ISSUER
    && environment.APPLE_API_KEY_PATH
    && existsSync(environment.APPLE_API_KEY_PATH);
  const account = environment.APPLE_ID
    && environment.APPLE_PASSWORD
    && environment.APPLE_TEAM_ID;
  return Boolean(api || account);
}

function updaterKeyReady(environment) {
  const path = environment.TAURI_SIGNING_PRIVATE_KEY_PATH;
  return Boolean(path && existsSync(path) && environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
}

function sourceTreeClean() {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "";
}

function rendererQaIssues(environment, version) {
  const path = environment.CODELIT_DESKTOP_RENDERER_QA_RECEIPT;
  if (!path || !existsSync(path)) {
    return ["Set CODELIT_DESKTOP_RENDERER_QA_RECEIPT to a passing QA receipt generated from this exact clean commit."];
  }
  try {
    const source = releaseSourceState();
    return desktopRendererQaReceiptIssues(readDesktopRendererQaReceipt(path), {
      commit: source.commit,
      version,
      receiptPath: path,
    });
  } catch (error) {
    return [`Could not validate CODELIT_DESKTOP_RENDERER_QA_RECEIPT: ${error instanceof Error ? error.message : String(error)}`];
  }
}

export function releaseSourceState() {
  const commit = run("git", ["rev-parse", "HEAD"], { capture: true });
  const dirty = !sourceTreeClean();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Could not resolve a full release commit.");
  return { commit, dirty };
}

export function botsP1BetaPolicyIssues(
  policy = botsP1BetaPolicy,
  modelManifest = readJson(resolve(appRoot, "native/mlx-helper/model-manifest.json")),
) {
  const issues = [];
  if (policy?.schemaVersion !== 1) issues.push("The Bots P1 beta policy schema must remain version 1.");
  if (policy?.releaseArchitecture !== "arm64" || policy?.releaseTarget !== "aarch64-apple-darwin") {
    issues.push("The Bots P1 beta is qualified only for the Apple Silicon release target.");
  }
  const bundledModel = modelManifest?.models?.find((model) => model.id === policy?.bundledModel?.id);
  if (!bundledModel
    || bundledModel.revision !== policy?.bundledModel?.revision
    || JSON.stringify(bundledModel.releaseValidatedMemoryGiB) !== JSON.stringify(policy?.bundledModel?.releaseValidatedMemoryGiB)) {
    issues.push("The bundled MLX model must match the exact P1 beta model and memory allowlist.");
  }
  if (policy?.browserDataStore !== "isolated-app-owned-per-bot") {
    issues.push("The P1 browser policy must use an isolated app-owned data store per bot.");
  }
  if (policy?.legacyWorkAccess !== "export-only") {
    issues.push("Preserved legacy work must remain export-only in the P1 beta.");
  }
  const tasks = policy?.starterTasks;
  if (!Array.isArray(tasks)
    || tasks.length !== 3
    || new Set(tasks).size !== 3
    || tasks.some((task) => typeof task !== "string" || !task.trim())
    || !tasks.some((task) => task.includes("https://"))) {
    issues.push("The P1 beta must expose exactly three distinct starter tasks, including one HTTPS inspection.");
  }
  return issues;
}

function configIssues() {
  const base = readJson(resolve(tauriRoot, "tauri.conf.json"));
  const direct = readJson(resolve(tauriRoot, "tauri.direct.conf.json"));
  const store = readJson(resolve(tauriRoot, "tauri.app-store.conf.json"));
  const submission = readAppStoreSubmission();
  const issues = [];
  if (base.identifier !== "io.codelit.desktop") issues.push("The desktop bundle identifier changed unexpectedly.");
  if (base.bundle?.macOS?.minimumSystemVersion !== "14.0") issues.push("The locked minimum macOS version must remain 14.0.");
  if (!/^[1-9]\d{0,17}$/.test(base.bundle?.macOS?.bundleVersion || "")) issues.push("The Mac build number must be a positive integer.");
  if (submission.app?.build !== base.bundle?.macOS?.bundleVersion) issues.push("The App Store submission build must match CFBundleVersion.");
  if (!base.bundle?.externalBin?.includes("binaries/codelit-mlx-helper")) issues.push("The base profile must bundle the MLX helper.");
  if (base.bundle?.resources?.["resources/app-store/PrivacyInfo.xcprivacy"] !== "PrivacyInfo.xcprivacy") {
    issues.push("Every Mac profile must bundle PrivacyInfo.xcprivacy at the app resource root.");
  }
  if (base.bundle?.externalBin?.includes("binaries/codelit-scheduler-helper")) issues.push("The scheduler helper belongs only in the Direct profile.");
  if (!direct.bundle?.externalBin?.includes("binaries/codelit-scheduler-helper")) issues.push("The Direct profile must bundle the scheduler helper.");
  if (!direct.bundle?.createUpdaterArtifacts || !direct.plugins?.updater?.pubkey) issues.push("The Direct profile must create signed updater artifacts.");
  if (!direct.plugins?.updater?.endpoints?.every((endpoint) => endpoint.startsWith("https://"))) issues.push("Every Direct update endpoint must use HTTPS.");
  if (store.bundle?.createUpdaterArtifacts !== false || store.plugins?.updater) issues.push("The App Store profile must use App Store updates only.");
  if (store.bundle?.externalBin?.includes("binaries/codelit-scheduler-helper")) issues.push("The App Store profile must not contain the scheduler helper.");
  if (store.bundle?.macOS?.entitlements !== "entitlements/app-store.plist") issues.push("The App Store profile must apply its sandbox entitlements.");
  if (store.bundle?.macOS?.infoPlist !== "Info.app-store.plist") issues.push("The App Store profile must apply its export-compliance Info.plist.");
  issues.push(...botsP1BetaPolicyIssues());
  return issues;
}

export function inspectReleaseReadiness({ channel, adhoc, environment = process.env }) {
  const appPackage = readJson(resolve(appRoot, "package.json"));
  const tauri = readJson(resolve(tauriRoot, "tauri.conf.json"));
  const cargo = readFileSync(resolve(tauriRoot, "Cargo.toml"), "utf8");
  const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
  const channels = channel === "all" ? ["direct", "app-store"] : [channel];
  const codeIdentities = adhoc ? [] : installedIdentities("codesigning");
  const allIdentities = adhoc ? [] : installedIdentities();
  const common = [];
  if (process.platform !== "darwin") common.push("Desktop releases must be built on macOS.");
  if (process.arch !== botsP1BetaPolicy.releaseArchitecture) common.push("The v1 release is locked to Apple Silicon.");
  if (!existsSync("/Applications/Xcode.app/Contents/Developer")) common.push("Full Xcode is required at /Applications/Xcode.app.");
  if (!existsSync("/usr/bin/codesign")) common.push("codesign is unavailable.");
  if (!existsSync("/usr/bin/xcrun")) common.push("xcrun is unavailable.");
  if (appPackage.version !== tauri.version || cargoVersion !== tauri.version) {
    common.push("apps/mac package, Tauri, and Cargo versions must match.");
  }
  common.push(...configIssues());

  const reports = channels.map((releaseChannel) => {
    const missing = [...common];
    if (!adhoc && !sourceTreeClean()) missing.push("Commit every source change before creating a production release.");
    if (!adhoc) missing.push(...rendererQaIssues(environment, tauri.version));
    if (!adhoc && releaseChannel === "direct") {
      missing.push(...signingIdentityIssues({ channel: releaseChannel, environment, codeIdentities, allIdentities }));
      if (!hasNotaryCredentials(environment)) missing.push("Configure Apple notarization credentials with APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_KEY_PATH, or the Apple ID variables supported by Tauri.");
      if (!updaterKeyReady(environment)) missing.push("Set TAURI_SIGNING_PRIVATE_KEY_PATH and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.");
    }
    if (!adhoc && releaseChannel === "app-store") {
      missing.push(...signingIdentityIssues({ channel: releaseChannel, environment, codeIdentities, allIdentities }));
      if (!environment.CODELIT_APP_STORE_PROFILE || !existsSync(environment.CODELIT_APP_STORE_PROFILE)) {
        missing.push("Set CODELIT_APP_STORE_PROFILE to the App Store provisioning profile.");
      }
      if (!environment.CODELIT_APPLE_TEAM_ID) missing.push("Set CODELIT_APPLE_TEAM_ID.");
    }
    if (releaseChannel === "app-store") {
      missing.push(...appStoreSubmissionIssues(readAppStoreSubmission(), {
        requireScreenshots: false,
        environment,
      }));
    }
    return { channel: releaseChannel, mode: adhoc ? "ad-hoc" : "production", ready: missing.length === 0, missing };
  });
  return {
    version: tauri.version,
    platform: `${process.platform}-${process.arch}`,
    target: botsP1BetaPolicy.releaseTarget,
    reports,
    ready: reports.every((report) => report.ready),
  };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repositoryRoot,
    env: options.env || process.env,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: options.capture ? "utf8" : undefined,
  });
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(result.stderr || result.stdout || "");
    throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}.`);
  }
  return options.capture ? `${result.stdout || ""}${result.stderr || ""}`.trim() : "";
}

export function developerIdSignatureIssues(label, details) {
  const issues = [];
  if (!/^Authority=Developer ID Application:/m.test(details)) {
    issues.push(`${label} is not signed by a Developer ID Application certificate.`);
  }
  if (!/^Timestamp=/m.test(details)) {
    issues.push(`${label} is missing a secure signing timestamp.`);
  }
  if (!/flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/im.test(details)) {
    issues.push(`${label} does not have Hardened Runtime enabled.`);
  }
  return issues;
}

export function auditDirectPreNotarizationSignatures() {
  const targets = [
    ["Codelit.app", bundlePath],
    ["codelit-mlx-helper", resolve(bundlePath, "Contents/MacOS/codelit-mlx-helper")],
    ["codelit-scheduler-helper", resolve(bundlePath, "Contents/MacOS/codelit-scheduler-helper")],
  ];
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundlePath]);
  const issues = targets.flatMap(([label, path]) => {
    if (!existsSync(path)) return [`${label} is missing before notarization.`];
    const details = run("codesign", ["-dv", "--verbose=4", path], { capture: true });
    return developerIdSignatureIssues(label, details);
  });
  if (issues.length) throw new Error(issues.join(" "));
}

export function auditBuiltBundle(channel, { production = false } = {}) {
  if (!existsSync(bundlePath)) throw new Error(`Built app was not found at ${bundlePath}.`);
  const macOS = resolve(bundlePath, "Contents/MacOS");
  const scheduler = resolve(macOS, "codelit-scheduler-helper");
  const launchAgent = resolve(bundlePath, "Contents/Library/LaunchAgents/io.codelit.desktop.scheduler.plist");
  const main = resolve(macOS, "codelit-mac");
  const mlx = resolve(macOS, "codelit-mlx-helper");
  const privacyManifest = resolve(bundlePath, "Contents/Resources/PrivacyInfo.xcprivacy");
  for (const executable of [main, mlx]) {
    if (!existsSync(executable)) throw new Error(`Bundle is missing ${executable}.`);
    const architectures = execFileSync("lipo", ["-archs", executable], { encoding: "utf8" }).trim();
    if (architectures !== "arm64") throw new Error(`${executable} must contain exactly arm64, found ${architectures}.`);
  }
  const computerBoundaryIssues = computerUseChannelIssues(main, channel);
  if (computerBoundaryIssues.length) throw new Error(computerBoundaryIssues.join(" "));
  if (channel === "direct" && (!existsSync(scheduler) || !existsSync(launchAgent))) {
    throw new Error("The Direct bundle is missing its scheduler helper or LaunchAgent.");
  }
  if (channel === "app-store" && (existsSync(scheduler) || existsSync(launchAgent))) {
    throw new Error("The App Store bundle contains Direct-only scheduler files.");
  }
  if (channel === "app-store") {
    if (!existsSync(privacyManifest)) throw new Error("The App Store bundle is missing PrivacyInfo.xcprivacy.");
    run("plutil", ["-lint", privacyManifest]);
    const nonExemptEncryption = run("plutil", [
      "-extract", "ITSAppUsesNonExemptEncryption", "raw", "-o", "-",
      resolve(bundlePath, "Contents/Info.plist"),
    ], { capture: true });
    if (nonExemptEncryption !== "false") {
      throw new Error("The App Store bundle must declare ITSAppUsesNonExemptEncryption as false.");
    }
    for (const forbidden of [
      resolve(bundlePath, "Contents/Library/LaunchAgents"),
      resolve(bundlePath, "Contents/Resources/latest.json"),
      resolve(bundlePath, "Contents/Resources/updater.json"),
    ]) {
      if (existsSync(forbidden)) throw new Error(`The App Store bundle contains a Direct-only release path: ${forbidden}.`);
    }
    const permissionIssues = appStoreBundlePermissionIssues(bundlePath);
    if (permissionIssues.length) throw new Error(permissionIssues.join(" "));
  }
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundlePath]);
  const entitlements = run("codesign", ["-d", "--entitlements", ":-", bundlePath], { capture: true });
  if (channel === "app-store") {
    for (const required of [
      "com.apple.security.app-sandbox",
      "com.apple.security.files.user-selected.read-only",
      "com.apple.security.network.client",
    ]) {
      if (!entitlements.includes(required)) throw new Error(`The App Store bundle is missing ${required}.`);
    }
    for (const forbidden of [
      "com.apple.security.get-task-allow",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.temporary-exception",
    ]) {
      if (entitlements.includes(forbidden)) throw new Error(`The App Store bundle contains forbidden entitlement ${forbidden}.`);
    }
    const childEntitlements = run("codesign", ["-d", "--entitlements", ":-", mlx], { capture: true });
    for (const required of ["com.apple.security.app-sandbox", "com.apple.security.inherit"]) {
      if (!childEntitlements.includes(required)) throw new Error(`The App Store MLX helper is missing ${required}.`);
    }
    if (production && !existsSync(resolve(bundlePath, "Contents/embedded.provisionprofile"))) {
      throw new Error("The App Store bundle is missing its embedded provisioning profile.");
    }
  }
  if (channel === "direct" && entitlements.includes("com.apple.security.app-sandbox")) {
    throw new Error("The Direct bundle unexpectedly has App Sandbox enabled.");
  }
  if (production && channel === "direct") {
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", bundlePath]);
    run("xcrun", ["stapler", "validate", bundlePath]);
  }
  return { channel, bundlePath, architecture: "arm64", signed: true };
}
