import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { releaseCapabilityIssues } from "../../apps/mac/scripts/release-support.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const packageJson = JSON.parse(read("../../package.json"));
const app = read("../../apps/mac/src/App.tsx");
const updates = read("../../apps/mac/src/components/DesktopUpdateSettings.tsx");
const runtime = read("../../apps/mac/src/runtime.ts");
const directConfig = JSON.parse(read("../../apps/mac/src-tauri/tauri.direct.conf.json"));
const storeConfig = JSON.parse(read("../../apps/mac/src-tauri/tauri.app-store.conf.json"));
const baseConfig = JSON.parse(read("../../apps/mac/src-tauri/tauri.conf.json"));
const releaseScript = read("../../apps/mac/scripts/build-desktop-release.mjs");
const releaseSupport = read("../../apps/mac/scripts/release-support.mjs");
const updaterPublicKey = read("../../apps/mac/release/updater.pub");
const updaterRuntime = read("../../apps/mac/src-tauri/src/updater.rs");
const desktopBootstrap = read("../../apps/mac/src-tauri/src/lib.rs");
const desktopMain = read("../../apps/mac/src-tauri/src/main.rs");
const desktopBuild = read("../../apps/mac/src-tauri/build.rs");
const releaseProvenance = read("../../apps/mac/scripts/desktop-release-provenance.mjs");
const directReleaseRunbook = read("../../apps/mac/DIRECT_RELEASE_RUNBOOK.md");
const appStoreReleaseRunbook = read("../../apps/mac/APP_STORE_RELEASE_RUNBOOK.md");
const localReliabilityRunbook = read("../../apps/mac/LOCAL_RELIABILITY_QA.md");
const appStoreDelivery = read("../../apps/mac/scripts/submit-app-store-build.mjs");

describe("Codelit for Mac release channels", () => {
  it("keeps every documented desktop release and qualification command callable", () => {
    expect(packageJson.scripts).toMatchObject({
      "desktop:release:direct": "node apps/mac/scripts/build-desktop-release.mjs --channel direct",
      "desktop:release:app-store": "node apps/mac/scripts/build-desktop-release.mjs --channel app-store",
      "desktop:qa:candidate:draft": "node apps/mac/scripts/create-desktop-candidate-qa.mjs",
      "desktop:qa:candidate:check": "node apps/mac/scripts/check-desktop-candidate-qa.mjs",
      "desktop:qa:p1:record": "node apps/mac/scripts/record-desktop-p1-journey.mjs",
      "desktop:qa:p1:check": "node apps/mac/scripts/check-desktop-p1-journey.mjs",
      "desktop:qa:computer:draft": "node apps/mac/scripts/create-desktop-computer-lifecycle-observations.mjs",
      "desktop:qa:computer:record": "node apps/mac/scripts/record-desktop-computer-lifecycle.mjs",
      "desktop:qa:computer:check": "node apps/mac/scripts/check-desktop-computer-lifecycle.mjs",
      "desktop:qa:reliability:draft": "node apps/mac/scripts/create-desktop-local-reliability-observations.mjs",
      "desktop:qa:reliability:record": "node apps/mac/scripts/record-desktop-local-reliability.mjs",
      "desktop:qa:reliability:check": "node apps/mac/scripts/check-desktop-local-reliability.mjs",
      "desktop:app-store:validate": "node apps/mac/scripts/submit-app-store-build.mjs",
      "desktop:app-store:upload": "node apps/mac/scripts/submit-app-store-build.mjs --upload",
    });
  });

  it("keeps Direct updates signed and App Store updates Apple-managed", () => {
    expect(directConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(directConfig.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(directConfig.plugins.updater.pubkey, "base64").toString("utf8")).toBe(updaterPublicKey);
    expect(directConfig.plugins.updater.endpoints).toEqual([
      "https://raw.githubusercontent.com/codelit-io/codelit-mac-releases/main/latest.json",
    ]);
    expect(storeConfig.bundle.createUpdaterArtifacts).toBe(false);
    expect(storeConfig.plugins?.updater).toBeUndefined();
    expect(desktopBootstrap).toContain("tauri_plugin_updater::Builder::new().build()");
    expect(updaterRuntime).not.toContain("version_comparator");
    expect(desktopBootstrap).not.toContain("version_comparator");
    expect(updaterRuntime).toContain("verify_signed_manifest(&update)?");
    expect(updaterRuntime).toContain("signed_manifest_binds_version_and_archive_location");
  });

  it("keeps Direct-only scheduling files out of the App Store profile", () => {
    expect(baseConfig.bundle.externalBin).toEqual(["binaries/codelit-mlx-helper"]);
    expect(baseConfig.bundle.resources["resources/app-store/PrivacyInfo.xcprivacy"]).toBe("PrivacyInfo.xcprivacy");
    expect(directConfig.bundle.externalBin).toContain("binaries/codelit-scheduler-helper");
    expect(storeConfig.bundle.externalBin).not.toContain("binaries/codelit-scheduler-helper");
    expect(storeConfig.bundle.macOS.entitlements).toBe("entitlements/app-store.plist");
  });

  it("surfaces the owning update channel without renderer network access", () => {
    expect(app).toContain("<DesktopUpdateSettings />");
    expect(updates).toContain("Updates are verified by the channel that installed this app.");
    expect(updates).toContain("Install and relaunch");
    expect(runtime).toContain('invoke<DesktopUpdateState>("check_desktop_update")');
    expect(updates).not.toContain("fetch(");
  });

  it("requires explicit Apple assets for production release commands", () => {
    expect(releaseSupport).toContain("Install a Developer ID Application signing identity, then set APPLE_SIGNING_IDENTITY");
    expect(releaseSupport).toContain("Mac App Distribution certificate name");
    expect(releaseSupport).toContain("Mac Installer Distribution certificate name");
    expect(releaseSupport).toContain("installed Mac Installer Distribution identity");
    expect(releaseSupport).toContain("Set APPLE_SIGNING_IDENTITY");
    expect(releaseSupport).toContain("Set CODELIT_INSTALLER_SIGNING_IDENTITY");
    expect(releaseSupport).toContain("Set CODELIT_APP_STORE_PROFILE");
    expect(releaseSupport).toContain("appStoreSubmissionIssues");
    expect(releaseSupport).toContain("The App Store bundle is missing PrivacyInfo.xcprivacy.");
    expect(releaseSupport).toContain("ITSAppUsesNonExemptEncryption");
    expect(releaseSupport).toContain("TAURI_SIGNING_PRIVATE_KEY_PATH");
    expect(releaseScript).toContain('options.channel === "direct" && !options.adhoc');
    expect(releaseScript).toContain("readFileSync(process.env.TAURI_SIGNING_PRIVATE_KEY_PATH");
    expect(releaseScript).toContain("TAURI_SIGNING_PRIVATE_KEY: updaterPrivateKey");
    expect(releaseScript).toContain("auditDirectPreNotarizationSignatures();");
    expect(releaseScript.indexOf("auditDirectPreNotarizationSignatures();")).toBeLessThan(
      releaseScript.indexOf('"notarytool", "submit", dmgPath'),
    );
    expect(releaseScript).toContain("directDmgPath(readiness.version)");
    expect(releaseScript).toContain('"notarytool", "submit", dmgPath');
    expect(releaseScript).toContain('"stapler", "staple", dmgPath');
    expect(releaseScript).toContain('"stapler", "validate", dmgPath');
    expect(releaseScript).toContain('"--type", "open", "--context", "context:primary-signature"');
    expect(releaseSupport).toContain("Commit every source change before creating a production release.");
    expect(releaseScript).toContain('"--features", feature');
    expect(releaseScript).toContain('"--no-sign"');
    expect(desktopBuild).toContain("CODELIT_SOURCE_COMMIT");
    expect(desktopBuild).toContain("CODELIT_SOURCE_DIRTY");
    expect(desktopBuild).toContain("CODELIT_BUILD_SOURCE_COMMIT");
    expect(releaseScript).toContain("CODELIT_BUILD_SOURCE_COMMIT: source.commit");
    expect(releaseScript).toContain("codelit-release-identity.json");
    expect(releaseScript).toContain("sourceCommit: source.commit");
    expect(releaseScript).toContain("chmodSync(embeddedProfile, 0o644)");
    expect(releaseSupport).toContain("appStoreBundlePermissionIssues(bundlePath)");
    expect(releaseSupport).toContain("computerUseChannelIssues(main, channel)");
    expect(releaseSupport).toContain('mkdtempSync(resolve(tmpdir(), "codelit-release-capability-")');
    expect(releaseSupport).toContain('execFileSync("codesign", ["--force", "--sign", "-", probeExecutable]');
    expect(releaseSupport).toContain("rmSync(probeDirectory, { recursive: true, force: true })");
    expect(releaseSupport).toContain("CGSessionCopyCurrentDictionary");
    expect(releaseSupport).toContain("The App Store binary exposes the Direct-only computer-use qualification probe.");
    expect(releaseSupport).toContain("The desktop binary is missing its exact-candidate resource-policy probe.");
    expect(desktopMain).toContain('Some("--release-identity")');
    expect(desktopMain).toContain('Some("--release-capabilities")');
    expect(desktopMain).toContain('Some("--probe-resource-policy")');
    expect(desktopMain).toContain('env!("CODELIT_SOURCE_COMMIT")');
  });

  it("audits optimized release binaries through an exact capability contract", () => {
    const direct = {
      schemaVersion: 1,
      channel: "direct",
      probes: { backgroundService: true, computerUse: true, resourcePolicy: true },
    };
    const appStore = {
      schemaVersion: 1,
      channel: "app-store",
      probes: { backgroundService: true, computerUse: false, resourcePolicy: true },
    };

    expect(releaseCapabilityIssues(direct, "direct")).toEqual([]);
    expect(releaseCapabilityIssues(appStore, "app-store")).toEqual([]);
    expect(releaseCapabilityIssues({ ...direct, probes: { ...direct.probes, computerUse: false } }, "direct"))
      .toContain("The Direct binary is missing its computer-use qualification probe.");
    expect(releaseCapabilityIssues({ ...appStore, probes: { ...appStore.probes, computerUse: true } }, "app-store"))
      .toContain("The App Store binary exposes the Direct-only computer-use qualification probe.");
    expect(releaseCapabilityIssues({ ...direct, probes: { ...direct.probes, resourcePolicy: false } }, "direct"))
      .toContain("The desktop binary is missing its exact-candidate resource-policy probe.");
    expect(releaseCapabilityIssues(null, "direct"))
      .toEqual(["The desktop binary did not return its release capability contract."]);
  });

  it("keeps release provenance signed, immutable, and forward-only", () => {
    expect(releaseProvenance).toContain('releasePlatform = "darwin-aarch64-app"');
    expect(releaseProvenance).toContain('strategy: "forward-release"');
    expect(releaseProvenance).toContain("assertVersionAdvances(version, previous.version)");
    expect(releaseProvenance).toContain("verifyUpdaterSignature(archivePath, signaturePath");
    expect(releaseProvenance).toContain("canonicalUpdatePayload");
    expect(releaseProvenance).toContain('order: ["immutable-assets", "latest.json"]');
    expect(releaseProvenance).not.toContain("allowDowngrades");
  });

  it("requires exact candidate QA before Direct packaging and explicit App Store upload", () => {
    expect(directReleaseRunbook).toContain("--qa-receipt /absolute/path/direct-candidate-qa.json");
    expect(directReleaseRunbook).toContain("--p1-receipt /absolute/path/direct-p1-journey.json");
    expect(directReleaseRunbook).toContain(
      "--computer-lifecycle-receipt /absolute/path/direct-computer-lifecycle.json",
    );
    expect(directReleaseRunbook).toContain("--reliability-receipt /absolute/path/direct-local-reliability.json");
    expect(releaseProvenance).toContain("candidateQaReceiptIssues");
    expect(releaseProvenance).toContain("artifacts.qa");
    expect(releaseProvenance).toContain("focusedQualification");
    expect(releaseProvenance).toContain("directQualificationReceipts");
    expect(appStoreReleaseRunbook).toContain("--stage testflight-upload");
    expect(appStoreReleaseRunbook).toContain("screenshots intentionally remain pending");
    expect(appStoreReleaseRunbook).toContain("does not submit it for App Review");
    expect(directReleaseRunbook).toContain("LOCAL_RELIABILITY_QA.md");
    expect(appStoreReleaseRunbook).toContain("LOCAL_RELIABILITY_QA.md");
    expect(localReliabilityRunbook).toContain("desktop:qa:reliability:check");
    expect(localReliabilityRunbook).toContain("Do not create thermal pressure on purpose.");
    expect(localReliabilityRunbook).toContain("open -n -W -g");
    expect(localReliabilityRunbook).toContain("--args --probe-resource-policy");
    expect(appStoreDelivery).toContain('arguments_.includes("--upload")');
    expect(appStoreDelivery).toContain("requireDeliveryMetadata: true");
    expect(appStoreDelivery).toContain("requireScreenshots: false");
    expect(appStoreDelivery).toContain("candidateQa: {");
    expect(appStoreDelivery).toContain('status = "failed"');
  });
});
