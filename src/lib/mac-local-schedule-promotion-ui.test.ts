import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  new URL("../../apps/mac/src/components/LocalSchedulePanel.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../../apps/mac/src/App.tsx", import.meta.url), "utf8");
const cloudSettings = readFileSync(
  new URL("../../apps/mac/src/components/DesktopCloudSettings.tsx", import.meta.url),
  "utf8",
);
const capabilityMenu = readFileSync(
  new URL("../../apps/mac/src/components/HostedCapabilityMenu.tsx", import.meta.url),
  "utf8",
);
const browserPanel = readFileSync(
  new URL("../../apps/mac/src/components/LocalBrowserPanel.tsx", import.meta.url),
  "utf8",
);

describe("Mac schedule hosted promotion", () => {
  it("keeps promotion code deferred and exposes one reviewed action per schedule", () => {
    expect(panel).toContain('await import("@/lib/local-desktop-hosted-promotion")');
    expect(panel).toContain('artifactKind === "agent-team" ? "Run 24/7" : "Sync to cloud"');
    expect(panel).toContain("reviewHostedPromotion(schedule)");
  });

  it("shows every transfer boundary before upload and waits for explicit continuation", () => {
    expect(panel).toContain("Nothing uploads until you continue.");
    expect(panel).toContain('title="Moves to Codelit Cloud"');
    expect(panel).toContain('title="Stays on this Mac"');
    expect(panel).toContain('title="Needs cloud setup"');
    expect(panel).toContain('title="Schedule differences"');
    expect(panel).toContain("Continue to final setup");
  });

  it("owns pairing and sync polling once at the app boundary", () => {
    expect(app).toContain("setInterval(() => void finish(), 5_000)");
    expect(app).toContain("window.setInterval(maybeSync, 60_000)");
    expect(panel).not.toContain("setInterval(() => void poll(), 5_000)");
    expect(panel).toContain("This local work is unchanged.");
  });

  it("does not register native event listeners in the browser preview", () => {
    expect(app).toContain("if (!isNativeRuntime()) return;");
    expect(app).toContain('listen<LocalNotificationRoute>("local-notification-open"');
  });

  it("requires an explicit review before replacing a hosted copy with a newer local version", () => {
    expect(panel).toContain("schedule.artifactVersion !== artifact.version");
    expect(panel).toContain("await onSave({");
    expect(panel).toContain('return "Review new copy"');
  });

  it("shows reconciled capabilities without synthesizing an App Store checkout", () => {
    expect(cloudSettings).toContain('sync.account.commerce === "app-store"');
    expect(cloudSettings).toContain("This App Store build does not open external checkout.");
    expect(cloudSettings).toContain("capability.href ?");
    expect(cloudSettings).toContain("Delete Codelit account &amp; cloud data");
    expect(cloudSettings).toContain('onOpenHref("/account/delete")');
    expect(cloudSettings).not.toContain("/checkout");
  });

  it("keeps imported-result notifications generic and offers both conflict copies", () => {
    expect(app).toContain('body: "Open Codelit to review the verified local receipt."');
    expect(app).not.toContain("body: result.");
    expect(cloudSettings).toContain("Open cloud copy");
    expect(cloudSettings).toContain("Review this Mac");
  });

  it("offers each hosted capability at the artifact or browser moment of need", () => {
    expect(capabilityMenu).toContain('title: "Run 24/7"');
    expect(capabilityMenu).toContain('title: "Cloud browser"');
    expect(capabilityMenu).toContain('title: "Public trigger"');
    expect(capabilityMenu).toContain('title: "Share workspace"');
    expect(capabilityMenu).toContain("Local work stays here until you review a copy.");
    expect(browserPanel).toContain("onRequestCloudBrowser");
    expect(browserPanel).toContain("Cloud browser");
  });

  it("routes contextual cloud actions through artifact-aware reviewed transfers", () => {
    expect(app).toContain("requestHostedCapability");
    expect(app).toContain('link.mode === "run-24-7" && Boolean(link.scheduleId)');
    expect(app).toContain('setScheduleReviewId(capabilityId === "run-24-7" ? compatibleCloudLink?.scheduleId || null : null)');
    expect(app).toContain("setHostedCapabilityIntent(capabilityId)");
    expect(panel).toContain("Nothing uploads before the transfer review.");
    expect(panel).toContain("Local cookies stay on this Mac");
    expect(panel).toContain("reviewArtifactPromotion(hostedCapabilityIntent)");
  });
});
