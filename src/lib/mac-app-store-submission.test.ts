import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appStoreSubmissionIssues,
  readAppStoreSubmission,
} from "../../apps/mac/scripts/app-store-submission.mjs";
import {
  appStoreBundlePermissionIssues,
  appStoreEntitlementBody,
  appStoreProvisioningIdentifiers,
  botsP1BetaPolicy,
  botsP1BetaPolicyIssues,
  signingIdentityIssues,
} from "../../apps/mac/scripts/release-support.mjs";

function submission() {
  return structuredClone(readAppStoreSubmission());
}

describe("Codelit Mac App Store submission", () => {
  it("rejects drift from the frozen Bots P1 beta contract", () => {
    expect(botsP1BetaPolicyIssues()).toEqual([]);
    expect(botsP1BetaPolicyIssues({ ...botsP1BetaPolicy, releaseArchitecture: "x64" })).toContain(
      "The Bots P1 beta is qualified only for the Apple Silicon release target.",
    );
    expect(botsP1BetaPolicyIssues({ ...botsP1BetaPolicy, starterTasks: [] })).toContain(
      "The P1 beta must expose exactly three distinct starter tasks, including one HTTPS inspection.",
    );
  });

  it("keeps listing, commerce, privacy, review, and screenshot structure coherent", () => {
    expect(appStoreSubmissionIssues(submission())).toEqual([]);
  });

  it("enforces App Store text limits and a checkout-free local model", () => {
    const value = submission();
    value.app.subtitle = "x".repeat(31);
    value.localization.keywords = "x".repeat(101);
    value.commerce.externalPurchaseLinks = true;

    expect(appStoreSubmissionIssues(value)).toEqual(expect.arrayContaining([
      "App subtitle exceeds 30 characters.",
      "Keywords exceeds 100 bytes.",
      "The free local App Store declaration must contain no account entitlement, purchase, or external-checkout path.",
    ]));
  });

  it("rejects listing copy from the retired multi-workbench companion", () => {
    const value = submission();
    value.localization.description = "Build an Agent Team, Product Plan, and Architecture with Codelit Cloud.";

    expect(appStoreSubmissionIssues(value)).toContain(
      "The App Store listing must describe Codelit Bots rather than retired workbenches or cloud handoff.",
    );
  });

  it("rejects foreground routines from the App Store listing", () => {
    const value = submission();
    value.localization.description = "Run foreground routines from your bot workspace.";

    expect(appStoreSubmissionIssues(value)).toContain(
      "The App Store listing must not advertise routines that are disabled in this build profile.",
    );
  });

  it("requires an integer App Store build number", () => {
    const value = submission();
    value.app.build = "0.1.0";

    expect(appStoreSubmissionIssues(value)).toContain("The App Store build must be a positive integer.");
  });

  it("keeps the inherited helper free of a standalone application identifier", () => {
    const parent = appStoreEntitlementBody({
      applicationIdentifier: "TEAM123456.io.codelit.desktop",
      teamIdentifier: "TEAM123456",
    });
    const child = appStoreEntitlementBody({ child: true });

    expect(parent).toContain("com.apple.application-identifier");
    expect(parent).toContain("com.apple.developer.team-identifier");
    expect(child).toContain("com.apple.security.inherit");
    expect(child).not.toContain("com.apple.application-identifier");
    expect(child).not.toContain("com.apple.developer.team-identifier");
  });

  it("rejects App Store bundle files that non-root users cannot read", () => {
    const root = mkdtempSync(join(tmpdir(), "codelit-app-store-permissions-"));
    try {
      const contents = join(root, "Contents");
      mkdirSync(contents);
      chmodSync(root, 0o755);
      chmodSync(contents, 0o755);
      const profile = join(contents, "embedded.provisionprofile");
      writeFileSync(profile, "profile");
      chmodSync(profile, 0o600);
      expect(appStoreBundlePermissionIssues(root)).toEqual([
        `File is not readable by non-root users: ${profile}`,
      ]);
      chmodSync(profile, 0o644);
      expect(appStoreBundlePermissionIssues(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds installer identities outside the code-signing policy", () => {
    const application = "3rd Party Mac Developer Application: Codelit (TEAM123456)";
    const installer = "3rd Party Mac Developer Installer: Codelit (TEAM123456)";
    expect(signingIdentityIssues({
      channel: "app-store",
      environment: {
        APPLE_SIGNING_IDENTITY: application,
        CODELIT_INSTALLER_SIGNING_IDENTITY: installer,
      },
      codeIdentities: [application],
      allIdentities: [application, installer],
    })).toEqual([]);
    expect(signingIdentityIssues({
      channel: "app-store",
      environment: {
        APPLE_SIGNING_IDENTITY: application,
        CODELIT_INSTALLER_SIGNING_IDENTITY: installer,
      },
      codeIdentities: [application],
      allIdentities: [application],
    })).toContain("CODELIT_INSTALLER_SIGNING_IDENTITY must name an installed Mac Installer Distribution identity.");
  });

  it("accepts current Mac distribution certificate display names", () => {
    const application = "Mac App Distribution: Codelit (TEAM123456)";
    const installer = "Mac Installer Distribution: Codelit (TEAM123456)";
    expect(signingIdentityIssues({
      channel: "app-store",
      environment: {
        APPLE_SIGNING_IDENTITY: application,
        CODELIT_INSTALLER_SIGNING_IDENTITY: installer,
      },
      codeIdentities: [application],
      allIdentities: [application, installer],
    })).toEqual([]);
  });

  it("reads modern and legacy App Store provisioning identifiers", () => {
    const expected = {
      applicationIdentifier: "TEAM123456.io.codelit.desktop",
      teamIdentifier: "TEAM123456",
    };
    expect(appStoreProvisioningIdentifiers({
      "com.apple.application-identifier": expected.applicationIdentifier,
      "com.apple.developer.team-identifier": expected.teamIdentifier,
    })).toEqual(expected);
    expect(appStoreProvisioningIdentifiers({
      "application-identifier": expected.applicationIdentifier,
      "com.apple.developer.team-identifier": expected.teamIdentifier,
    })).toEqual(expected);
    expect(() => appStoreProvisioningIdentifiers({
      "com.apple.developer.team-identifier": expected.teamIdentifier,
    })).toThrow("missing its application identifier entitlement");
  });

  it("fails closed when privacy labels and the bundled manifest diverge", () => {
    const value = submission();
    value.privacy.dataTypes = value.privacy.dataTypes.filter((item: { type: string }) => item.type !== "OTHER_USER_CONTENT");
    const issues = appStoreSubmissionIssues(value, { privacyManifest: "<plist/>" });

    expect(issues).toContain("App Store privacy labels must declare only linked Other User Content for app functionality.");
    expect(issues).toContain("PrivacyInfo.xcprivacy is missing NSPrivacyCollectedDataTypeOtherUserContent.");
    expect(issues).toContain("PrivacyInfo.xcprivacy is missing E174.1.");
  });

  it("never permits review credentials in committed metadata", () => {
    const value = submission();
    value.review.demoAccountUsername = "reviewer@example.com";

    expect(appStoreSubmissionIssues(value).join("\n")).toMatch(/must not contain a credential field/);
  });

  it("keeps exempt encryption bound to the no-France App Store profile", () => {
    const value = submission();
    value.exportCompliance.franceAvailable = true;

    expect(appStoreSubmissionIssues(value)).toContain(
      "Export compliance must record exempt standard encryption with France unavailable.",
    );
    expect(appStoreSubmissionIssues(submission(), { infoPlist: "<plist><dict/></plist>" })).toContain(
      "The App Store Info.plist must declare ITSAppUsesNonExemptEncryption as false.",
    );
  });

  it("blocks a production submission without screenshots, an App ID, and encryption clearance", () => {
    const directory = mkdtempSync(join(tmpdir(), "codelit-app-store-missing-screenshots-"));
    writeFileSync(join(directory, "APP_REVIEW.md"), "Review notes");
    writeFileSync(join(directory, "TESTFLIGHT.md"), "What to test");
    const issues = appStoreSubmissionIssues(submission(), {
      directory,
      requireScreenshots: true,
      environment: { NODE_ENV: "test" },
    });

    for (const screenshot of [
      "01-local-bot.png",
      "02-bot-team.png",
      "03-memory-and-skills.png",
      "04-run-receipt.png",
    ]) {
      expect(issues).toContain(`Required screenshot is missing: ${screenshot}.`);
    }
    expect(issues).toContain("Set CODELIT_APP_STORE_EXPORT_COMPLIANCE_REFERENCE after completing Apple's encryption questionnaire.");
    expect(issues).toContain("Set CODELIT_APP_STORE_APP_ID to the numeric App Store Connect app ID.");
  });

  it("allows private TestFlight delivery before Store-installed screenshots exist", () => {
    const issues = appStoreSubmissionIssues(submission(), {
      requireDeliveryMetadata: true,
      requireScreenshots: false,
      environment: {
        NODE_ENV: "test",
        CODELIT_APP_STORE_APP_ID: "6801650460",
        CODELIT_APP_STORE_EXPORT_COMPLIANCE_REFERENCE: "ASC-EXEMPT-NO-FRANCE",
      },
    });

    expect(issues.filter((issue) => issue.includes("screenshot is missing"))).toEqual([]);
    expect(issues).toEqual([]);
  });
});
