import { describe, expect, it } from "vitest";

import {
  developerIdSignatureIssues,
  signingIdentityIssues,
} from "../../apps/mac/scripts/release-support.mjs";

const identity = "Developer ID Application: Codelit (TEAM123456)";

describe("Codelit Direct release signing", () => {
  it("requires the exact installed Developer ID identity in the build environment", () => {
    expect(signingIdentityIssues({
      channel: "direct",
      environment: {},
      codeIdentities: [identity],
      allIdentities: [identity],
    })).toContain("Set APPLE_SIGNING_IDENTITY to the exact installed Developer ID Application certificate name.");
    expect(signingIdentityIssues({
      channel: "direct",
      environment: { APPLE_SIGNING_IDENTITY: identity },
      codeIdentities: [identity],
      allIdentities: [identity],
    })).toEqual([]);
  });

  it("accepts only a timestamped Developer ID signature with Hardened Runtime", () => {
    expect(developerIdSignatureIssues("Codelit.app", [
      "CodeDirectory v=20500 flags=0x10000(runtime)",
      `Authority=${identity}`,
      "Timestamp=Aug 25, 2026 at 12:00:00 PM",
    ].join("\n"))).toEqual([]);
  });

  it("rejects an ad hoc signature before notarization", () => {
    expect(developerIdSignatureIssues("Codelit.app", [
      "CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed)",
      "Signature=adhoc",
    ].join("\n"))).toEqual([
      "Codelit.app is not signed by a Developer ID Application certificate.",
      "Codelit.app is missing a secure signing timestamp.",
      "Codelit.app does not have Hardened Runtime enabled.",
    ]);
  });
});
