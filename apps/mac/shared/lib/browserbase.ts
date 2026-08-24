const BROWSERBASE_API = "https://api.browserbase.com/v1";
const BROWSERBASE_TIMEOUT_MS = 15_000;
const BROWSERBASE_SESSION_CREATE_ATTEMPTS = 5;
const BROWSERBASE_SESSION_RETRY_BASE_MS = 250;
const BROWSERBASE_SESSION_RETRY_MAX_MS = 2_000;
const BROWSERBASE_CONTEXT_DELETE_ATTEMPTS = 6;
const BROWSERBASE_CONTEXT_DELETE_RETRY_BASE_MS = 250;
const BROWSERBASE_CONTEXT_DELETE_RETRY_MAX_MS = 2_000;

export interface BrowserbaseSession {
  id: string;
  connectUrl: string;
}

export class BrowserbaseRequestError extends Error {
  constructor(
    public status: number,
    public retryAfterMs: number | null = null,
  ) {
    super(`Browser provider request failed (${status})`);
    this.name = "BrowserbaseRequestError";
  }
}

export function isBrowserbaseCapacityError(error: unknown) {
  return error instanceof BrowserbaseRequestError && error.status === 429;
}

export function isBrowserbaseAccountUnavailableError(error: unknown) {
  return error instanceof BrowserbaseRequestError && error.status === 402;
}

function isSessionAlreadyGone(error: unknown) {
  return error instanceof BrowserbaseRequestError && [400, 404, 410].includes(error.status);
}

function isContextAlreadyGone(error: unknown) {
  return error instanceof BrowserbaseRequestError && [404, 410].includes(error.status);
}

function credentials() {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  if (!apiKey || !projectId) throw new Error("Browser Worker is not configured");
  return { apiKey, projectId };
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function isBrowserbaseConfigured() {
  return Boolean(process.env.BROWSERBASE_API_KEY?.trim() && process.env.BROWSERBASE_PROJECT_ID?.trim());
}

async function browserbaseRequest<T>(path: string, init: RequestInit): Promise<T> {
  const { apiKey } = credentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROWSERBASE_TIMEOUT_MS);
  try {
    const response = await fetch(`${BROWSERBASE_API}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey, ...(init.headers || {}) },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new BrowserbaseRequestError(
        response.status,
        parseRetryAfterMs(response.headers.get("Retry-After")),
      );
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function createBrowserbaseContext(): Promise<string> {
  const { projectId } = credentials();
  const result = await browserbaseRequest<{ id?: string }>("/contexts", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
  if (!result.id) throw new Error("Browser provider did not create a Context");
  return result.id;
}

export async function deleteBrowserbaseContext(contextId: string): Promise<void> {
  for (let attempt = 0; attempt < BROWSERBASE_CONTEXT_DELETE_ATTEMPTS; attempt += 1) {
    const result = await tryDeleteBrowserbaseContext(contextId);
    if (result === "deleted") return;
    if (attempt === BROWSERBASE_CONTEXT_DELETE_ATTEMPTS - 1) throw new BrowserbaseRequestError(400);
    const fallbackMs = BROWSERBASE_CONTEXT_DELETE_RETRY_BASE_MS * (2 ** attempt);
    await wait(Math.min(fallbackMs, BROWSERBASE_CONTEXT_DELETE_RETRY_MAX_MS));
  }
}

export async function tryDeleteBrowserbaseContext(contextId: string): Promise<"deleted" | "pending"> {
  try {
    await browserbaseRequest(`/contexts/${encodeURIComponent(contextId)}`, { method: "DELETE" });
    return "deleted";
  } catch (error) {
    if (isContextAlreadyGone(error)) return "deleted";
    if (error instanceof BrowserbaseRequestError && error.status === 400) return "pending";
    throw error;
  }
}

export async function createBrowserbaseSession(contextId?: string, options: { keepAlive?: boolean; timeoutSeconds?: number; recordSession?: boolean } = {}): Promise<BrowserbaseSession> {
  const { projectId } = credentials();
  const timeout = options.timeoutSeconds ?? (options.keepAlive ? 600 : 180);
  if (!Number.isInteger(timeout) || timeout < 60 || timeout > 600) throw new Error("Browser provider timeout must be between 60 and 600 seconds");
  const body = JSON.stringify({
    projectId,
    timeout,
    ...(options.keepAlive ? { keepAlive: true } : {}),
    browserSettings: {
      viewport: { width: 1440, height: 900 },
      ...(options.recordSession === false ? { recordSession: false } : {}),
      ...(contextId ? { context: { id: contextId, persist: true } } : {}),
    },
  });

  for (let attempt = 0; attempt < BROWSERBASE_SESSION_CREATE_ATTEMPTS; attempt += 1) {
    try {
      const result = await browserbaseRequest<{ id?: string; connectUrl?: string }>("/sessions", {
        method: "POST",
        body,
      });
      if (!result.id || !result.connectUrl?.startsWith("wss://")) throw new Error("Browser provider returned an invalid session");
      return { id: result.id, connectUrl: result.connectUrl };
    } catch (error) {
      const retryable = error instanceof BrowserbaseRequestError && error.status === 429;
      if (!retryable || attempt === BROWSERBASE_SESSION_CREATE_ATTEMPTS - 1) throw error;
      const fallbackMs = BROWSERBASE_SESSION_RETRY_BASE_MS * (2 ** attempt);
      const retryMs = error.retryAfterMs ?? Math.min(fallbackMs, BROWSERBASE_SESSION_RETRY_MAX_MS);
      // Longer provider windows are returned to the browser so the live run can
      // wait once without occupying a serverless request or hammering the API.
      if (retryMs > BROWSERBASE_SESSION_RETRY_MAX_MS) throw error;
      await wait(retryMs);
    }
  }

  throw new Error("Browser provider did not create a session");
}

export async function releaseBrowserbaseSession(sessionId: string): Promise<void> {
  const { projectId } = credentials();
  try {
    await browserbaseRequest(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      body: JSON.stringify({ projectId, status: "REQUEST_RELEASE" }),
    });
  } catch (error) {
    if (!isSessionAlreadyGone(error)) throw error;
  }
}

export async function getBrowserbaseLiveUrl(sessionId: string): Promise<string> {
  const result = await browserbaseRequest<{ debuggerFullscreenUrl?: string }>(`/sessions/${encodeURIComponent(sessionId)}/debug`, { method: "GET" });
  if (!result.debuggerFullscreenUrl?.startsWith("https://")) throw new Error("Browser provider did not return a live view");
  return result.debuggerFullscreenUrl;
}
