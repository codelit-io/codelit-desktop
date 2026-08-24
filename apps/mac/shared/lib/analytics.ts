import { auth } from "./firebase-auth";
import { gtagEvent, gtagAdsConversion, ADS_CONVERSIONS } from "./gtag";
import {
  sanitizeAnalyticsMetadata,
  sanitizeAnalyticsPath,
  sanitizeAnalyticsReferrer,
  type AnalyticsMetadata,
} from "./analytics-client-contract";
import type { EventType } from "./analytics-contract";
import { currentCampaignAttribution } from "./analytics-campaign";

export type { EventType } from "./analytics-contract";

// Holds the id for the life of the page when storage is unavailable. Without
// this the fallback minted a fresh id on every call, so a visitor whose browser
// blocks `localStorage` counted as a brand-new person on every event: unique
// visitor totals were inflated by however many events those visitors fired, and
// they could never appear in two funnel stages at once, because the id joining
// the stages changed between them.
//
// It cannot survive a reload without storage — nothing can — so such a visitor
// is still counted once per page load rather than once. That is a floor, and an
// honest one; the previous behaviour was neither.
let sessionVisitorId = "";

function mintVisitorId() {
  return `v_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

export function getVisitorId() {
  if (typeof window === "undefined") return "";
  try {
    let visitorId = localStorage.getItem("codelit-visitor-id") || "";
    if (!visitorId) {
      // Reuse the in-memory id if this page already minted one, so a visitor who
      // gains storage mid-session keeps the identity their earlier events used.
      visitorId = sessionVisitorId || mintVisitorId();
      localStorage.setItem("codelit-visitor-id", visitorId);
    }
    sessionVisitorId = visitorId;
    return visitorId;
  } catch {
    if (!sessionVisitorId) sessionVisitorId = mintVisitorId();
    return sessionVisitorId;
  }
}

export function trackEvent(event: EventType, metadata?: AnalyticsMetadata) {
  // Fire and forget, never block the UI
  try {
    // Driven browsers can present a normal Chrome user-agent and valid
    // same-origin Fetch Metadata. Do not let their QA journeys become product
    // usage or advertising conversions.
    if (typeof navigator !== "undefined" && navigator.webdriver === true) return;

    let visitorId = "";
    let referrer = "";
    let url = "";
    if (typeof window !== "undefined") {
      visitorId = getVisitorId();
      referrer = sanitizeAnalyticsReferrer(document.referrer || "");
      url = sanitizeAnalyticsPath(window.location.pathname);
    }

    const safeMetadata = sanitizeAnalyticsMetadata({
      ...currentCampaignAttribution(),
      ...metadata,
    });
    void (async () => {
      const token = await auth.currentUser?.getIdToken().catch(() => "");
      await fetch("/api/analytics", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          event,
          metadata: safeMetadata,
          url,
          visitorId,
          referrer,
          automated: false,
        }),
        cache: "no-store",
        keepalive: true,
      }).catch(() => undefined);
    })();

    // Mirror into GA4 / Google Ads. No-ops unless a Google tag is configured.
    // page_view is owned by <Analytics/>, so skip it here to avoid double counts.
    if (event !== "page_view") gtagEvent(event, safeMetadata);
    // Only genuine account creation carries a method and fires the Ads signup
    // conversion. Pricing and checkout have their own explicit events.
    if (event === "sign_up" && metadata?.method && ADS_CONVERSIONS.sign_up) {
      gtagAdsConversion(ADS_CONVERSIONS.sign_up);
    }
  } catch {
    // Silently fail
  }
}
