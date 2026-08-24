const SAFE_SEGMENT = /^[A-Za-z0-9_@.+ -]+$/;
const EXCLUDED_DIRECTORIES = new Set([".git", ".next", "build", "coverage", "dist", "node_modules", "vendor"]);
const SENSITIVE_FILENAMES = new Set([".netrc", ".npmrc", ".pypirc"]);
const BINARY_OR_SECRET_EXTENSION = /\.(?:7z|avi|bin|bmp|bz2|class|dmg|docx?|eot|exe|gif|gz|ico|jar|jks|jpe?g|key|keystore|mov|mp3|mp4|otf|p12|pdf|pem|pfx|png|pptx?|rar|so|tar|tiff?|ttf|wav|webm|webp|woff2?|xlsx?|zip)$/i;

function isSensitiveFilename(segment: string) {
  const lower = segment.toLowerCase();
  return SENSITIVE_FILENAMES.has(lower)
    || lower === ".env"
    || lower.startsWith(".env.")
    || /^(?:credentials?|secrets?)(?:\..*)?$/.test(lower)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/.test(lower)
    || /(?:private[-_.]?key|service[-_.]?account)/.test(lower)
    || BINARY_OR_SECRET_EXTENSION.test(lower);
}

export function isSafeRepositoryRelativeTextPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 240 || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => (
    Boolean(segment)
    && segment !== "."
    && segment !== ".."
    && SAFE_SEGMENT.test(segment)
    && !EXCLUDED_DIRECTORIES.has(segment.toLowerCase())
    && !isSensitiveFilename(segment)
  ));
}
