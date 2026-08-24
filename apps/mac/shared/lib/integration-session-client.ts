import type { IntegrationOAuthConnectorId } from "./integration-oauth";

export type ClientIntegrationConnectorId = IntegrationOAuthConnectorId | "vercel";

export const INTEGRATION_SESSION_EXPIRED_EVENT = "codelit-integration-expired";

export interface IntegrationSessionExpiredDetail {
  connectorId: ClientIntegrationConnectorId;
}

export interface IntegrationSessionStatus {
  connected: boolean;
  label: string;
  accountId: string;
  avatar: string;
  expiresAt: number | null;
  scopes: string[];
  writeReady: boolean | null;
}

const markerKey = (connectorId: IntegrationOAuthConnectorId) => `${connectorId}_connected`;
const refreshes = new Map<ClientIntegrationConnectorId, Promise<boolean>>();
const notifiedExpired = new Set<ClientIntegrationConnectorId>();

export function hasRememberedIntegration(connectorId: IntegrationOAuthConnectorId, legacyTokenKey: string) {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(markerKey(connectorId)) === "1" || Boolean(localStorage.getItem(legacyTokenKey));
}

export function rememberIntegration(connectorId: IntegrationOAuthConnectorId) {
  if (typeof window !== "undefined") localStorage.setItem(markerKey(connectorId), "1");
}

export function forgetIntegration(connectorId: IntegrationOAuthConnectorId) {
  if (typeof window !== "undefined") localStorage.removeItem(markerKey(connectorId));
}

export function legacyTokenHeaders(token: string | null, headerName: string) {
  return token ? { [headerName]: token } : {};
}

export async function getIntegrationSessions(signal?: AbortSignal): Promise<Partial<Record<IntegrationOAuthConnectorId, IntegrationSessionStatus>>> {
  try {
    const response = await fetch("/api/integrations/session", { cache: "no-store", signal });
    if (!response.ok) return {};
    const data = await response.json() as { connections?: Partial<Record<IntegrationOAuthConnectorId, IntegrationSessionStatus>> };
    return data.connections || {};
  } catch {
    return {};
  }
}

export async function migrateLegacyIntegration(
  connectorId: IntegrationOAuthConnectorId,
  accessToken: string,
  metadata: { label?: string; accountId?: string; avatar?: string } = {},
) {
  try {
    const response = await fetch("/api/integrations/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectorId, accessToken, ...metadata }),
    });
    if (!response.ok) return false;
    rememberIntegration(connectorId);
    return true;
  } catch {
    return false;
  }
}

export async function syncIntegrationSessionsToVault(idToken: string) {
  try {
    const response = await fetch("/api/integrations/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.status === 409) {
      const data = await response.json().catch(() => ({})) as { code?: string };
      if (data.code === "integration-owner-mismatch") {
        await disconnectAllIntegrationSessions();
        if (typeof window !== "undefined") window.dispatchEvent(new Event("codelit-integrations-reset"));
      }
      return false;
    }
    return response.ok;
  } catch {
    return false;
  }
}

export function refreshIntegrationSession(connectorId: ClientIntegrationConnectorId) {
  const existing = refreshes.get(connectorId);
  if (existing) return existing;
  const refresh = (async () => {
    try {
      const response = await fetch(connectorId === "vercel" ? "/api/vercel/refresh" : "/api/integrations/session", {
        method: connectorId === "vercel" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        ...(connectorId === "vercel" ? {} : { body: JSON.stringify({ connectorId }) }),
      });
      if (!response.ok) return false;
      notifiedExpired.delete(connectorId);
      void import("./firebase-auth").then(async ({ auth }) => {
        if (auth.currentUser) await syncIntegrationSessionsToVault(await auth.currentUser.getIdToken());
      }).catch(() => {});
      return true;
    } catch {
      return false;
    } finally {
      refreshes.delete(connectorId);
    }
  })();
  refreshes.set(connectorId, refresh);
  return refresh;
}

export async function integrationFetch(
  connectorId: ClientIntegrationConnectorId,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  let response = await fetch(input, init);
  if (response.status !== 401) return response;
  if (!await refreshIntegrationSession(connectorId)) {
    if (typeof window !== "undefined" && !notifiedExpired.has(connectorId)) {
      notifiedExpired.add(connectorId);
      window.dispatchEvent(new CustomEvent<IntegrationSessionExpiredDetail>(INTEGRATION_SESSION_EXPIRED_EVENT, {
        detail: { connectorId },
      }));
    }
    return response;
  }
  response = await fetch(input, init);
  return response;
}

export function disconnectIntegrationSession(connectorId: IntegrationOAuthConnectorId) {
  forgetIntegration(connectorId);
  void fetch("/api/integrations/session", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectorId }),
  }).catch(() => {});
  void removeHostedIntegration(connectorId);
}

export async function removeHostedIntegration(connectorId: ClientIntegrationConnectorId) {
  try {
    const { auth } = await import("./firebase-auth");
    if (!auth.currentUser) return false;
    const idToken = await auth.currentUser.getIdToken();
    const response = await fetch("/api/integrations/sync", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ connectorId }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function disconnectAllIntegrationSessions(idToken?: string) {
  for (const connectorId of ["github", "jira", "notion", "linear", "figma", "slack", "gitlab", "bitbucket"] as const) {
    forgetIntegration(connectorId);
  }
  await fetch("/api/integrations/session", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ all: true }),
  }).catch(() => null);
  if (idToken) {
    await fetch("/api/integrations/sync", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => null);
  }
  await fetch("/api/vercel/disconnect", { method: "POST" }).catch(() => null);
}
