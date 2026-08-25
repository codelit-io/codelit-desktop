import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  appStoreEntitlementBody,
  appStoreProvisioningIdentifiers,
  auditDirectPreNotarizationSignatures,
  auditBuiltBundle,
  bundlePath,
  directDmgPath,
  inspectReleaseReadiness,
  parseReleaseArguments,
  releaseSourceState,
  repositoryRoot,
  run,
} from "./release-support.mjs";

const options = parseReleaseArguments(process.argv.slice(2));
if (options.channel === "all") throw new Error("A build requires --channel direct or --channel app-store.");
const readiness = inspectReleaseReadiness(options);
if (!readiness.ready) {
  for (const issue of readiness.reports[0].missing) process.stderr.write(`- ${issue}\n`);
  throw new Error(`${options.channel} release preflight failed.`);
}

const rustPath = `/opt/homebrew/opt/rustup/bin:${process.env.PATH || ""}`;
const source = releaseSourceState();
const updaterPrivateKey = options.channel === "direct" && !options.adhoc
  ? readFileSync(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH, "utf8").trim()
  : undefined;
const buildEnvironment = {
  ...process.env,
  PATH: rustPath,
  DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
  CODELIT_BUILD_SOURCE_COMMIT: source.commit,
  CODELIT_BUILD_SOURCE_DIRTY: String(source.dirty),
  ...(updaterPrivateKey ? { TAURI_SIGNING_PRIVATE_KEY: updaterPrivateKey } : {}),
};

run("npm", ["run", "desktop:mlx:build"], { cwd: repositoryRoot, env: buildEnvironment });
run("npm", ["run", "desktop:mlx:stage"], { cwd: repositoryRoot, env: buildEnvironment });
if (options.channel === "direct") {
  run("npm", ["run", "desktop:scheduler:build"], { cwd: repositoryRoot, env: buildEnvironment });
}

const feature = options.channel === "direct" ? "direct-release" : "app-store-release";
const config = options.channel === "direct"
  ? "src-tauri/tauri.direct.conf.json"
  : "src-tauri/tauri.app-store.conf.json";
const tauriArguments = [
  "--prefix", "apps/mac", "run", "tauri", "build", "--",
  "--features", feature,
  "--config", config,
  "--ci",
];
if (options.adhoc) {
  tauriArguments.push("--config", "src-tauri/tauri.adhoc.conf.json", "--bundles", "app", "--no-sign");
} else if (options.channel === "app-store") {
  tauriArguments.push("--bundles", "app", "--no-sign");
}
run("npm", tauriArguments, { cwd: repositoryRoot, env: buildEnvironment });

if (!options.adhoc && options.channel === "direct") {
  auditDirectPreNotarizationSignatures();
  const dmgPath = directDmgPath(readiness.version);
  run("xcrun", [
    "notarytool", "submit", dmgPath,
    "--key", process.env.APPLE_API_KEY_PATH,
    "--key-id", process.env.APPLE_API_KEY,
    "--issuer", process.env.APPLE_API_ISSUER,
    "--wait", "--timeout", "30m",
  ], { cwd: repositoryRoot, env: buildEnvironment });
  run("xcrun", ["stapler", "staple", dmgPath], { cwd: repositoryRoot, env: buildEnvironment });
  run("xcrun", ["stapler", "validate", dmgPath], { cwd: repositoryRoot, env: buildEnvironment });
  run("spctl", [
    "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgPath,
  ], { cwd: repositoryRoot, env: buildEnvironment });
}

if (options.adhoc) {
  run("node", [
    "apps/mac/scripts/sign-desktop-bundle.mjs",
    "--channel", options.channel,
    "--app", bundlePath,
  ], { cwd: repositoryRoot, env: buildEnvironment });
} else if (options.channel === "app-store") {
  const profile = process.env.CODELIT_APP_STORE_PROFILE;
  if (!profile || !existsSync(profile)) throw new Error("The App Store provisioning profile disappeared during the build.");
  const releaseIdentity = resolve(bundlePath, "Contents/Resources/codelit-release-identity.json");
  mkdirSync(dirname(releaseIdentity), { recursive: true });
  writeFileSync(releaseIdentity, `${JSON.stringify({
    schemaVersion: 1,
    channel: options.channel,
    sourceCommit: source.commit,
    sourceDirty: source.dirty,
  }, null, 2)}\n`);
  const profilePlist = resolve(dirname(bundlePath), "codelit-app-store-profile.plist");
  run("security", ["cms", "-D", "-i", profile, "-o", profilePlist]);
  const profileEntitlements = JSON.parse(run("plutil", ["-extract", "Entitlements", "json", "-o", "-", profilePlist], { capture: true }));
  const { applicationIdentifier, teamIdentifier } = appStoreProvisioningIdentifiers(profileEntitlements);
  if (teamIdentifier !== process.env.CODELIT_APPLE_TEAM_ID) throw new Error("The provisioning profile belongs to a different Apple team.");
  if (applicationIdentifier !== `${teamIdentifier}.io.codelit.desktop`) throw new Error("The provisioning profile does not authorize io.codelit.desktop.");
  const entitlements = resolve(dirname(bundlePath), "codelit-app-store-entitlements.plist");
  const childEntitlements = resolve(dirname(bundlePath), "codelit-app-store-child-entitlements.plist");
  writeFileSync(entitlements, appStoreEntitlementBody({ applicationIdentifier, teamIdentifier }));
  writeFileSync(childEntitlements, appStoreEntitlementBody({ child: true }));
  const embeddedProfile = resolve(bundlePath, "Contents/embedded.provisionprofile");
  copyFileSync(profile, embeddedProfile);
  chmodSync(embeddedProfile, 0o644);
  const distributionIdentity = process.env.APPLE_SIGNING_IDENTITY;
  const installerIdentity = process.env.CODELIT_INSTALLER_SIGNING_IDENTITY;
  if (!distributionIdentity || !installerIdentity) throw new Error("Set APPLE_SIGNING_IDENTITY and CODELIT_INSTALLER_SIGNING_IDENTITY to their exact certificate names.");
  run("codesign", ["--force", "--timestamp", "--sign", distributionIdentity, "--entitlements", childEntitlements, resolve(bundlePath, "Contents/MacOS/codelit-mlx-helper")]);
  run("codesign", ["--force", "--timestamp", "--sign", distributionIdentity, "--entitlements", entitlements, bundlePath]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundlePath]);
  const packagePath = resolve(dirname(bundlePath), `Codelit-${readiness.version}-app-store.pkg`);
  mkdirSync(dirname(packagePath), { recursive: true });
  run("productbuild", ["--component", bundlePath, "/Applications", "--sign", installerIdentity, packagePath]);
  run("pkgutil", ["--check-signature", packagePath]);
}

const audit = auditBuiltBundle(options.channel, { production: !options.adhoc });
process.stdout.write(`${JSON.stringify({ ...audit, mode: options.adhoc ? "ad-hoc" : "production" }, null, 2)}\n`);
