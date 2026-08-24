export type SafeRemoteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

export function sanitizeRemoteHeaderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) return null;
  return name;
}
