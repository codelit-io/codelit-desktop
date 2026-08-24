import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const appStoreDirectory = resolve(scriptsDirectory, "../app-store");
export const appStoreSubmissionPath = resolve(appStoreDirectory, "submission.json");
export const appStorePrivacyManifestPath = resolve(
  scriptsDirectory,
  "../src-tauri/resources/app-store/PrivacyInfo.xcprivacy",
);
export const appStoreInfoPlistPath = resolve(scriptsDirectory, "../src-tauri/Info.app-store.plist");

const EXPECTED_DATA_TYPES = new Set(["OTHER_USER_CONTENT"]);
const ACCEPTED_SCREENSHOT_SIZES = new Set([
  "1280x800",
  "1440x900",
  "2560x1600",
  "2880x1800",
]);

function byteLength(value) {
  return Buffer.byteLength(value || "", "utf8");
}

function textIssue(value, label, maximum, { bytes = false } = {}) {
  if (typeof value !== "string" || !value.trim()) return `${label} is required.`;
  const length = bytes ? byteLength(value) : [...value].length;
  return length > maximum ? `${label} exceeds ${maximum}${bytes ? " bytes" : " characters"}.` : null;
}

function containsSensitiveSubmissionKey(value, path = "submission") {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (/password|credential|api.?key|secret|demo.?account.?(user|email)/i.test(key)) return nextPath;
    const found = containsSensitiveSubmissionKey(nested, nextPath);
    if (found) return found;
  }
  return null;
}

export function pngDimensions(path) {
  const bytes = readFileSync(path);
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`${path} is not a PNG screenshot.`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function readAppStoreSubmission(path = appStoreSubmissionPath) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function appStoreSubmissionIssues(
  submission,
  {
    directory = appStoreDirectory,
    privacyManifest = existsSync(appStorePrivacyManifestPath)
      ? readFileSync(appStorePrivacyManifestPath, "utf8")
      : "",
    infoPlist = existsSync(appStoreInfoPlistPath)
      ? readFileSync(appStoreInfoPlistPath, "utf8")
      : "",
    requireScreenshots = false,
    requireDeliveryMetadata = requireScreenshots,
    environment = process.env,
  } = {},
) {
  const issues = [];
  const push = (issue) => { if (issue) issues.push(issue); };
  if (submission?.schemaVersion !== 1) issues.push("The App Store submission schema is unsupported.");
  const app = submission?.app || {};
  if (app.bundleId !== "io.codelit.desktop") issues.push("The App Store bundle ID must be io.codelit.desktop.");
  if (!/^[1-9]\d{0,17}$/.test(app.build || "")) issues.push("The App Store build must be a positive integer.");
  if (app.platform !== "macOS" || app.minimumSystemVersion !== "14.0" || app.architecture !== "arm64") {
    issues.push("The first App Store release must remain Apple Silicon on macOS 14 or newer.");
  }
  if (app.primaryCategory !== "DEVELOPER_TOOLS") issues.push("The App Store category must remain Developer Tools.");
  if (app.price !== "free" || app.inAppPurchases !== false) {
    issues.push("The App Store profile must remain a free local app without in-app purchases.");
  }
  push(textIssue(app.name, "App name", 30));
  push(textIssue(app.subtitle, "App subtitle", 30));

  const localized = submission?.localization || {};
  if (localized.locale !== "en-US") issues.push("The first submission must include the en-US localization.");
  push(textIssue(localized.promotionalText, "Promotional text", 170));
  push(textIssue(localized.description, "Description", 4_000));
  push(textIssue(localized.keywords, "Keywords", 100, { bytes: true }));
  push(textIssue(localized.releaseNotes, "Release notes", 4_000));
  if (typeof localized.keywords === "string" && /\s,|,\s/.test(localized.keywords)) {
    issues.push("App Store keywords must be comma-separated without spaces.");
  }
  const listingText = [app.subtitle, localized.promotionalText, localized.description, localized.releaseNotes]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (/\bAgent Teams?\b|\bProduct Plans?\b|\bArchitecture\b|\bCodelit Cloud\b/i.test(listingText)) {
    issues.push("The App Store listing must describe Codelit Bots rather than retired workbenches or cloud handoff.");
  }
  if (/\bforeground routines?\b/i.test(listingText)) {
    issues.push("The App Store listing must not advertise routines that are disabled in this build profile.");
  }

  const expectedUrls = {
    marketing: "https://codelit.io",
    support: "https://codelit.io/docs/codelit-for-mac",
    privacyPolicy: "https://codelit.io/privacy",
    privacyChoices: "https://codelit.io/account/delete",
  };
  for (const [key, expected] of Object.entries(expectedUrls)) {
    if (submission?.urls?.[key] !== expected) issues.push(`The ${key} URL must be ${expected}.`);
  }

  const commerce = submission?.commerce || {};
  if (
    commerce.strategy !== "free-local"
    || commerce.externalPurchaseCallsToAction !== false
    || commerce.externalPurchaseLinks !== false
    || commerce.existingAccountEntitlementsOnly !== false
    || !Array.isArray(commerce.storeKitProducts)
    || commerce.storeKitProducts.length !== 0
  ) {
    issues.push("The free local App Store declaration must contain no account entitlement, purchase, or external-checkout path.");
  }

  const privacy = submission?.privacy || {};
  if (privacy.tracking !== false || !Array.isArray(privacy.trackingDomains) || privacy.trackingDomains.length) {
    issues.push("The App Store privacy declaration must not claim tracking or tracking domains.");
  }
  const dataTypes = Array.isArray(privacy.dataTypes) ? privacy.dataTypes : [];
  const declaredTypes = new Set(dataTypes.map((item) => item?.type));
  if (
    dataTypes.length !== EXPECTED_DATA_TYPES.size
    || [...EXPECTED_DATA_TYPES].some((type) => !declaredTypes.has(type))
    || dataTypes.some((item) => item?.linked !== true || item?.tracking !== false || item?.purposes?.join() !== "APP_FUNCTIONALITY")
  ) {
    issues.push("App Store privacy labels must declare only linked Other User Content for app functionality.");
  }
  for (const marker of [
    "<key>NSPrivacyTracking</key>",
    "<false/>",
    "NSPrivacyCollectedDataTypeOtherUserContent",
    "NSPrivacyAccessedAPICategoryFileTimestamp",
    "C617.1",
    "3B52.1",
    "NSPrivacyAccessedAPICategoryDiskSpace",
    "E174.1",
  ]) {
    if (!privacyManifest.includes(marker)) issues.push(`PrivacyInfo.xcprivacy is missing ${marker}.`);
  }

  if (submission?.ageRating?.unrestrictedWebAccess !== false) {
    issues.push("The App Store Bots profile must not claim an unavailable browser surface.");
  }
  const exportCompliance = submission?.exportCompliance || {};
  if (
    exportCompliance.status !== "exempt-no-france"
    || exportCompliance.usesEncryption !== true
    || exportCompliance.usesNonExemptEncryption !== false
    || exportCompliance.franceAvailable !== false
  ) {
    issues.push("Export compliance must record exempt standard encryption with France unavailable.");
  }
  if (!/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\s*\/>/.test(infoPlist)) {
    issues.push("The App Store Info.plist must declare ITSAppUsesNonExemptEncryption as false.");
  }
  if (submission?.review?.accountRequired !== false || submission?.review?.demoAccountRequired !== false) {
    issues.push("Review must be possible without a Codelit account or committed demo credentials.");
  }
  const sensitivePath = containsSensitiveSubmissionKey(submission);
  if (sensitivePath) issues.push(`Submission metadata must not contain a credential field (${sensitivePath}).`);

  for (const file of [submission?.review?.notesFile, submission?.testFlight?.whatToTestFile]) {
    if (typeof file !== "string" || !existsSync(resolve(directory, file))) {
      issues.push(`The App Store package is missing ${file || "a referenced review file"}.`);
    }
  }

  const screenshots = submission?.screenshots || {};
  if (!ACCEPTED_SCREENSHOT_SIZES.has(`${screenshots.width}x${screenshots.height}`)) {
    issues.push("Mac screenshots must use an accepted 16:10 App Store size.");
  }
  const slots = Array.isArray(screenshots.slots) ? screenshots.slots : [];
  if (slots.length < 4 || slots.some((slot) => !/^\d{2}-[a-z0-9-]+\.png$/.test(slot?.file || "") || !slot?.caption)) {
    issues.push("The screenshot manifest must define four ordered PNG slots with captions.");
  }
  for (const slot of slots) {
    const path = resolve(directory, "screenshots", slot.file);
    if (!existsSync(path)) {
      if (requireScreenshots) issues.push(`Required screenshot is missing: ${slot.file}.`);
      continue;
    }
    try {
      const dimensions = pngDimensions(path);
      if (dimensions.width !== screenshots.width || dimensions.height !== screenshots.height) {
        issues.push(`${slot.file} is ${dimensions.width}x${dimensions.height}, expected ${screenshots.width}x${screenshots.height}.`);
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `${slot.file} is invalid.`);
    }
  }

  if (requireDeliveryMetadata && !environment.CODELIT_APP_STORE_EXPORT_COMPLIANCE_REFERENCE) {
    issues.push("Set CODELIT_APP_STORE_EXPORT_COMPLIANCE_REFERENCE after completing Apple's encryption questionnaire.");
  }
  if (requireDeliveryMetadata && !/^\d+$/.test(environment.CODELIT_APP_STORE_APP_ID || "")) {
    issues.push("Set CODELIT_APP_STORE_APP_ID to the numeric App Store Connect app ID.");
  }
  return [...new Set(issues)];
}
