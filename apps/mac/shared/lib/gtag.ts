// Google Analytics 4 + Google Ads (gtag.js) bridge. Client only.
//
// This is the single place that talks to gtag. Everything is a no-op unless the
// relevant env var is set, so the app runs identically with tracking off (local
// dev, previews) and lights up in production once the IDs are configured.
//
//   NEXT_PUBLIC_GA_MEASUREMENT_ID:  GA4 property,        e.g. "G-XXXXXXXXXX"
//   NEXT_PUBLIC_GOOGLE_ADS_ID:      Google Ads account,  e.g. "AW-XXXXXXXXXX"
//   NEXT_PUBLIC_GADS_SIGNUP_LABEL:  direct Ads sign-up conversion label
//   NEXT_PUBLIC_GADS_TRIAL_LABEL:   direct Ads trial conversion label
//
// The Ads conversion labels come from Google Ads → Goals → Conversions → (your
// action) → "Tag setup" → the value after the slash in `send_to: AW-XXX/LABEL`.

export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || "";
export const GOOGLE_ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID || "";

/** Conversion labels, one per Google Ads conversion action. */
export const ADS_CONVERSIONS = {
  sign_up: process.env.NEXT_PUBLIC_GADS_SIGNUP_LABEL || "",
  start_trial: process.env.NEXT_PUBLIC_GADS_TRIAL_LABEL || "",
} as const;

/** The tag that gtag.js loads with: GA4 if present, otherwise the Ads tag. */
export const GTAG_TAG_ID = GA_MEASUREMENT_ID || GOOGLE_ADS_ID;

/** Whether any Google tag is configured. When false, nothing loads or fires. */
export const GTAG_ENABLED = Boolean(GTAG_TAG_ID);

type GtagParams = Record<string, unknown>;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

/** Send a generic GA4 event. Safe to call before gtag loads (it just no-ops). */
export function gtagEvent(name: string, params?: GtagParams) {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  window.gtag("event", name, params || {});
}

/**
 * Fire a Google Ads conversion. `label` is the per-action label; value/currency
 * are optional (use them for revenue conversions like a purchase).
 */
export function gtagAdsConversion(
  label: string,
  opts?: { value?: number; currency?: string; transactionId?: string },
) {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  if (!GOOGLE_ADS_ID || !label) return;
  window.gtag("event", "conversion", {
    send_to: `${GOOGLE_ADS_ID}/${label}`,
    ...(opts?.value != null ? { value: opts.value, currency: opts.currency || "USD" } : {}),
    ...(opts?.transactionId ? { transaction_id: opts.transactionId } : {}),
  });
}

/** Convenience: the "started a trial" Ads conversion (fired on checkout return). */
export function trackTrialStart(opts?: { value?: number; transactionId?: string }) {
  gtagAdsConversion(ADS_CONVERSIONS.start_trial, opts);
}

/**
 * Read the GA4 client_id so the server (Stripe webhook) can attribute the
 * delayed paid conversion back to the same browser/session that clicked the ad.
 * Resolves "" if GA isn't configured or gtag hasn't answered within 800ms.
 */
export function getGaClientId(): Promise<string> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || typeof window.gtag !== "function" || !GA_MEASUREMENT_ID) {
      return resolve("");
    }
    let done = false;
    const finish = (id: string) => { if (!done) { done = true; resolve(id || ""); } };
    try {
      window.gtag("get", GA_MEASUREMENT_ID, "client_id", (id: string) => finish(id));
    } catch {
      finish("");
    }
    setTimeout(() => finish(""), 800);
  });
}
