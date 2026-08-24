import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export const INTEGRATION_OAUTH_CONNECTOR_IDS = [
  "github",
  "jira",
  "notion",
  "linear",
  "figma",
  "slack",
  "gitlab",
  "bitbucket",
] as const;

export type IntegrationOAuthConnectorId = (typeof INTEGRATION_OAUTH_CONNECTOR_IDS)[number];
export type IntegrationOAuthProviderId = IntegrationOAuthConnectorId | "vercel" | "google-workspace" | "microsoft-365";

const CONNECTION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const STATE_MAX_AGE_SECONDS = 10 * 60;
const RETURN_TO_MAX_CHARS = 2_000;
const METADATA_MAX_CHARS = 320;
export const INTEGRATION_OWNER_COOKIE = "codelit_integration_owner";

export function isIntegrationOAuthConnectorId(value: unknown): value is IntegrationOAuthConnectorId {
  return typeof value === "string" && (INTEGRATION_OAUTH_CONNECTOR_IDS as readonly string[]).includes(value);
}

export function integrationCookieNames(connectorId: IntegrationOAuthConnectorId) {
  const prefix = `codelit_${connectorId}`;
  return {
    state: `${prefix}_oauth_state`,
    accessToken: `${prefix}_access_token`,
    refreshToken: `${prefix}_refresh_token`,
    expiresAt: `${prefix}_expires_at`,
    label: `${prefix}_label`,
    accountId: `${prefix}_account_id`,
    avatar: `${prefix}_avatar`,
    scopes: `${prefix}_scopes`,
  } as const;
}

export function integrationOAuthReturnCookieName(providerId: IntegrationOAuthProviderId) {
  return `codelit_${providerId}_oauth_return`;
}

function setHttpOnlyCookie(response: NextResponse, name: string, value: string, maxAge: number, secure: boolean) {
  response.cookies.set(name, value, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge,
  });
}

function clearCookie(response: NextResponse, name: string) {
  response.cookies.set(name, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

function sanitizeOAuthReturnTo(value: string | null | undefined, appUrl: string) {
  if (!value || value.length > RETURN_TO_MAX_CHARS || /[\\\u0000-\u001f]/.test(value)) return "";
  try {
    const app = new URL(appUrl);
    const target = new URL(value, app.origin);
    let decodedPathname = target.pathname;
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decodedPathname);
      if (next === decodedPathname) break;
      decodedPathname = next;
    }
    const restrictedPathname = decodedPathname.toLowerCase();
    if (
      target.origin !== app.origin
      || !target.pathname.startsWith("/")
      || restrictedPathname.startsWith("//")
      || restrictedPathname.includes("\\")
      || restrictedPathname === "/api"
      || restrictedPathname.startsWith("/api/")
      || restrictedPathname === "/_next"
      || restrictedPathname.startsWith("/_next/")
    ) return "";
    for (const key of ["integration_connected", "vercel_connected", "integration_error", "github_auth", "github_error", "error"]) target.searchParams.delete(key);
    return `${target.pathname}${target.search}`;
  } catch {
    return "";
  }
}

export function resolveIntegrationOAuthReturnTo(request: NextRequest, appUrl: string) {
  const explicit = sanitizeOAuthReturnTo(request.nextUrl.searchParams.get("return_to"), appUrl);
  if (explicit) return explicit;
  return sanitizeOAuthReturnTo(request.headers.get("referer"), appUrl) || "/";
}

export function setIntegrationOAuthReturnTo(
  response: NextResponse,
  request: NextRequest,
  providerId: IntegrationOAuthProviderId,
  appUrl: string,
  secure: boolean,
) {
  setHttpOnlyCookie(response, integrationOAuthReturnCookieName(providerId), resolveIntegrationOAuthReturnTo(request, appUrl), STATE_MAX_AGE_SECONDS, secure);
}

export function clearIntegrationOAuthReturnTo(response: NextResponse, providerId: IntegrationOAuthProviderId) {
  clearCookie(response, integrationOAuthReturnCookieName(providerId));
}

export function integrationOAuthResultUrl(
  request: NextRequest,
  providerId: IntegrationOAuthProviderId,
  appUrl: string,
  params: Record<string, string>,
) {
  const stored = request.cookies.get(integrationOAuthReturnCookieName(providerId))?.value;
  const returnTo = sanitizeOAuthReturnTo(stored, appUrl) || resolveIntegrationOAuthReturnTo(request, appUrl);
  const url = new URL(returnTo, appUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

export function createIntegrationOAuthCallbackResponse(
  request: NextRequest,
  providerId: IntegrationOAuthProviderId,
  appUrl: string,
  params: Record<string, string>,
) {
  const response = NextResponse.redirect(integrationOAuthResultUrl(request, providerId, appUrl, params));
  clearIntegrationOAuthReturnTo(response, providerId);
  return response;
}

function encodeMetadata(value: unknown) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/\u0000/g, "").trim().slice(0, METADATA_MAX_CHARS);
  return clean ? Buffer.from(clean, "utf8").toString("base64url") : "";
}

function decodeMetadata(value: string | undefined) {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64url").toString("utf8").slice(0, METADATA_MAX_CHARS);
  } catch {
    return "";
  }
}

function timingSafeEqual(value: string | null | undefined, expected: string | null | undefined) {
  if (!value || !expected) return false;
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return valueBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}

export function generateIntegrationOAuthState() {
  return crypto.randomBytes(32).toString("base64url");
}

export function setIntegrationOAuthState(
  response: NextResponse,
  connectorId: IntegrationOAuthConnectorId,
  state: string,
  secure: boolean,
) {
  setHttpOnlyCookie(response, integrationCookieNames(connectorId).state, state, STATE_MAX_AGE_SECONDS, secure);
}

export function validateIntegrationOAuthState(
  request: NextRequest,
  connectorId: IntegrationOAuthConnectorId,
  state: string | null,
) {
  return timingSafeEqual(state, request.cookies.get(integrationCookieNames(connectorId).state)?.value);
}

export function clearIntegrationOAuthState(response: NextResponse, connectorId: IntegrationOAuthConnectorId) {
  clearCookie(response, integrationCookieNames(connectorId).state);
}

export interface IntegrationConnectionInput {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  expiresAt?: number;
  label?: string;
  accountId?: string;
  avatar?: string;
  scopes?: string | string[];
}

export function normalizeIntegrationScopes(value: unknown) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return Array.from(new Set(raw.flatMap((scope) => typeof scope === "string" ? [scope.trim().slice(0, 80)] : []).filter(Boolean))).slice(0, 24);
}

export function setIntegrationConnectionScopes(
  response: NextResponse,
  connectorId: IntegrationOAuthConnectorId,
  scopes: string | string[],
  secure: boolean,
) {
  const normalized = normalizeIntegrationScopes(scopes);
  const value = encodeMetadata(normalized.join(" "));
  if (value) setHttpOnlyCookie(response, integrationCookieNames(connectorId).scopes, value, CONNECTION_MAX_AGE_SECONDS, secure);
  else clearCookie(response, integrationCookieNames(connectorId).scopes);
  return normalized;
}

export function setIntegrationConnection(
  response: NextResponse,
  connectorId: IntegrationOAuthConnectorId,
  connection: IntegrationConnectionInput,
  secure: boolean,
) {
  const names = integrationCookieNames(connectorId);
  const expiresAt = connection.expiresAt || (
    typeof connection.expiresIn === "number" && connection.expiresIn > 0
      ? Date.now() + connection.expiresIn * 1000
      : 0
  );

  setHttpOnlyCookie(response, names.accessToken, connection.accessToken, CONNECTION_MAX_AGE_SECONDS, secure);
  if (connection.refreshToken) setHttpOnlyCookie(response, names.refreshToken, connection.refreshToken, CONNECTION_MAX_AGE_SECONDS, secure);
  else clearCookie(response, names.refreshToken);
  if (expiresAt > 0) setHttpOnlyCookie(response, names.expiresAt, String(Math.floor(expiresAt)), CONNECTION_MAX_AGE_SECONDS, secure);
  else clearCookie(response, names.expiresAt);

  for (const [name, value] of [
    [names.label, encodeMetadata(connection.label)],
    [names.accountId, encodeMetadata(connection.accountId)],
    [names.avatar, encodeMetadata(connection.avatar)],
    [names.scopes, encodeMetadata(normalizeIntegrationScopes(connection.scopes).join(" "))],
  ] as const) {
    if (value) setHttpOnlyCookie(response, name, value, CONNECTION_MAX_AGE_SECONDS, secure);
    else clearCookie(response, name);
  }
}

export function clearIntegrationConnection(response: NextResponse, connectorId: IntegrationOAuthConnectorId) {
  const names = integrationCookieNames(connectorId);
  clearCookie(response, names.accessToken);
  clearCookie(response, names.refreshToken);
  clearCookie(response, names.expiresAt);
  clearCookie(response, names.label);
  clearCookie(response, names.accountId);
  clearCookie(response, names.avatar);
  clearCookie(response, names.scopes);
}

export function clearAllIntegrationConnections(response: NextResponse) {
  for (const connectorId of INTEGRATION_OAUTH_CONNECTOR_IDS) clearIntegrationConnection(response, connectorId);
}

export function getIntegrationOwnerUid(request: NextRequest) {
  return request.cookies.get(INTEGRATION_OWNER_COOKIE)?.value?.trim() || "";
}

export function setIntegrationOwnerUid(response: NextResponse, uid: string, secure: boolean) {
  setHttpOnlyCookie(response, INTEGRATION_OWNER_COOKIE, uid, CONNECTION_MAX_AGE_SECONDS, secure);
}

export function clearIntegrationOwnerUid(response: NextResponse) {
  clearCookie(response, INTEGRATION_OWNER_COOKIE);
}

export function getIntegrationAccessToken(
  request: NextRequest,
  connectorId: IntegrationOAuthConnectorId,
  legacyHeader?: string,
) {
  const cookieToken = request.cookies.get(integrationCookieNames(connectorId).accessToken)?.value?.trim();
  if (cookieToken) return cookieToken;
  return legacyHeader ? request.headers.get(legacyHeader)?.trim() || "" : "";
}

export function getIntegrationConnectionStatus(request: NextRequest, connectorId: IntegrationOAuthConnectorId) {
  const names = integrationCookieNames(connectorId);
  const accessToken = request.cookies.get(names.accessToken)?.value;
  const refreshToken = request.cookies.get(names.refreshToken)?.value;
  const rawExpiresAt = Number(request.cookies.get(names.expiresAt)?.value || 0);
  const scopes = normalizeIntegrationScopes(decodeMetadata(request.cookies.get(names.scopes)?.value));
  const connected = Boolean(accessToken || refreshToken);
  const requiredWriteScope = connectorId === "jira"
    ? "write:jira-work"
    : connectorId === "linear"
      ? "write"
      : connectorId === "slack"
        ? "chat:write"
        : null;
  return {
    connected,
    label: decodeMetadata(request.cookies.get(names.label)?.value),
    accountId: decodeMetadata(request.cookies.get(names.accountId)?.value),
    avatar: decodeMetadata(request.cookies.get(names.avatar)?.value),
    expiresAt: Number.isFinite(rawExpiresAt) && rawExpiresAt > 0 ? rawExpiresAt : null,
    scopes,
    writeReady: requiredWriteScope ? connected && scopes.includes(requiredWriteScope) : null,
  };
}

export function getIntegrationConnectionSecrets(request: NextRequest, connectorId: IntegrationOAuthConnectorId) {
  const names = integrationCookieNames(connectorId);
  const status = getIntegrationConnectionStatus(request, connectorId);
  return {
    ...status,
    accessToken: request.cookies.get(names.accessToken)?.value?.trim() || "",
    refreshToken: request.cookies.get(names.refreshToken)?.value?.trim() || "",
  };
}

export function isSecureIntegrationRequest(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
  return appUrl.startsWith("https://");
}
