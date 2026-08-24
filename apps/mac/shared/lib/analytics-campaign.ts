import type { AnalyticsMetadata } from "./analytics-contract";

export const GOOGLE_CAMPAIGN_QUERY_KEYS = [
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

const ATTRIBUTION_STORAGE_KEY = "codelit-campaign-attribution";
const CAMPAIGN_VALUE = /^[A-Za-z0-9 ._:/+-]{1,128}$/;

export type CampaignAttribution = Partial<Pick<
  AnalyticsMetadata,
  "trafficSource" | "trafficMedium" | "trafficCampaign" | "trafficContent" | "trafficTerm" | "paidClick" | "adNetwork"
>>;

function cleanCampaignValue(value: string | null) {
  const clean = (value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128);
  return CAMPAIGN_VALUE.test(clean) ? clean : "";
}

export function safeGooglePageLocation(value: string): string {
  try {
    const source = new URL(value);
    const safe = new URL(`${source.origin}${source.pathname}`);
    for (const key of GOOGLE_CAMPAIGN_QUERY_KEYS) {
      const campaignValue = source.searchParams.get(key);
      if (campaignValue) safe.searchParams.set(key, campaignValue.slice(0, 256));
    }
    return safe.toString();
  } catch {
    return "";
  }
}

export function campaignAttributionFromSearch(search: string): CampaignAttribution {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const attribution: CampaignAttribution = {};
  const mapping = [
    ["utm_source", "trafficSource"],
    ["utm_medium", "trafficMedium"],
    ["utm_campaign", "trafficCampaign"],
    ["utm_content", "trafficContent"],
    ["utm_term", "trafficTerm"],
  ] as const;
  for (const [queryKey, metadataKey] of mapping) {
    const value = cleanCampaignValue(params.get(queryKey));
    if (value) attribution[metadataKey] = value;
  }
  if (params.has("gclid") || params.has("gbraid") || params.has("wbraid")) {
    attribution.paidClick = true;
    attribution.adNetwork = "google";
  }
  return attribution;
}

export function captureCampaignAttribution(search: string): CampaignAttribution {
  if (typeof window === "undefined") return {};
  const current = campaignAttributionFromSearch(search);
  try {
    if (Object.keys(current).length) {
      sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(current));
      return current;
    }
    const stored = JSON.parse(sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY) || "{}") as unknown;
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? campaignAttributionFromStored(stored as Record<string, unknown>)
      : {};
  } catch {
    return current;
  }
}

function campaignAttributionFromStored(value: Record<string, unknown>): CampaignAttribution {
  const safe: CampaignAttribution = {};
  for (const key of ["trafficSource", "trafficMedium", "trafficCampaign", "trafficContent", "trafficTerm"] as const) {
    const candidate = typeof value[key] === "string" ? cleanCampaignValue(value[key]) : "";
    if (candidate) safe[key] = candidate;
  }
  if (value.paidClick === true) safe.paidClick = true;
  if (value.adNetwork === "google") safe.adNetwork = "google";
  return safe;
}

export function currentCampaignAttribution(): CampaignAttribution {
  return typeof window === "undefined"
    ? {}
    : captureCampaignAttribution(typeof window.location.search === "string" ? window.location.search : "");
}
