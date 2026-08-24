import type {
  AgentBrowserAction,
  AgentBrowserActionTarget,
  ToolExecutionConfig,
} from "../stores/agent-workflow-store";
import { renderAgentHandoffTemplate } from "./agent-run-input";

export const MAX_BROWSER_DOMAINS = 10;
export const MAX_BROWSER_ACTIONS = 20;
export const MAX_BROWSER_EVIDENCE_ITEMS = 8;
export type BrowserAccessScope = "public-read" | "signed-in-read" | "approved-actions";
const BROWSER_SCOPE_RANK: Record<BrowserAccessScope, number> = { "public-read": 0, "signed-in-read": 1, "approved-actions": 2 };

export const BROWSER_SCOPE_POLICY = {
  "public-read": { mode: "read", persistSession: false, maxDurationSeconds: 45, approval: "No approval required" },
  "signed-in-read": { mode: "read", persistSession: true, maxDurationSeconds: 60, approval: "Uses a private saved session" },
  "approved-actions": { mode: "write", persistSession: true, maxDurationSeconds: 70, approval: "Approval required before every action step" },
} as const satisfies Record<BrowserAccessScope, { mode: "read" | "write"; persistSession: boolean; maxDurationSeconds: number; approval: string }>;

export interface ValidatedBrowserToolConfig {
  startUrl: string;
  startUrlHandoffField?: string;
  approvedDomainHandoffField?: string;
  approvedDomains: string[];
  sessionId?: string;
  mode: "read" | "write";
  persistSession: boolean;
  maxDurationSeconds: number;
  goal?: string;
  goalHandoffField?: string;
  successCriteria?: string;
  successCriteriaHandoffField?: string;
  actions?: AgentBrowserAction[];
}

export type BrowserConfigResult =
  | { ok: true; config: ValidatedBrowserToolConfig }
  | { ok: false; error: string };

type BrowserToolConfig = NonNullable<ToolExecutionConfig["browser"]>;

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HANDOFF_FIELD_PATH = /^[A-Za-z][A-Za-z0-9_.-]{0,159}$/;
const TARGET_KINDS = new Set(["role", "label", "text", "testId"]);
const WRITE_ACTIONS = new Set(["click", "fill", "press", "select"]);
const SENSITIVE_TARGET = /\b(password|passcode|token|secret|api[ -]?key|credit[ -]?card|card[ -]?number|cvc|cvv|billing|payment|purchase|checkout|buy|place[ -]?order|subscribe|delete|remove|destroy|terminate|archive|erase|revoke|wipe|upload|download|attachment)\b/i;

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

function looksLikeIp(hostname: string) {
  if (hostname.includes(":")) return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function normalizeApprovedDomains(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_BROWSER_DOMAINS) return null;
  const domains: string[] = [];
  for (const entry of value) {
    const domain = clean(entry, 253).toLowerCase();
    if (!domain || domain.startsWith("*.") || domain.endsWith(".") || domain.includes(":") || domain.includes("/") || domain.includes("@")) return null;
    if (domain === "localhost" || domain.endsWith(".localhost") || domain.endsWith(".local") || domain.endsWith(".internal") || looksLikeIp(domain)) return null;
    const labels = domain.split(".");
    if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) return null;
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains.length ? domains : null;
}

export function browserWebsiteSetup(value: unknown): { name: string; approvedDomains: string[] } | null {
  const raw = clean(value, 2048);
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = parsedBrowserUrl(candidate);
  if (!url) return null;
  const hostname = url.hostname.toLowerCase();
  const approvedDomains = normalizeApprovedDomains([hostname]);
  if (!approvedDomains) return null;
  return {
    name: hostname.replace(/^www\./, ""),
    approvedDomains,
  };
}

export function browserServiceErrorMessage(message: string, fallback = "Secure browser could not start") {
  const detail = message.replace(/\s+/g, " ").trim();
  if (/server (?:auth|database) is not configured|browser (?:session encryption|worker provider) is not configured/i.test(detail)) {
    return "Codelit's secure browser is temporarily unavailable. Your setup is saved, so retry in a moment.";
  }
  return detail || fallback;
}

function parsedBrowserUrl(value: unknown): URL | null {
  const raw = clean(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (looksLikeIp(url.hostname) || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) return null;
    return url;
  } catch {
    return null;
  }
}

export function isBrowserUrlAllowed(value: unknown, approvedDomains: string[]): boolean {
  const url = parsedBrowserUrl(value);
  if (!url) return false;
  const hostname = url.hostname.toLowerCase();
  return approvedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

export function domainsAreWithinScope(requested: string[], sessionDomains: string[]): boolean {
  return requested.every((domain) => sessionDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`)));
}

export const BROWSER_SESSIONS_CHANGED_EVENT = "codelit-browser-sessions-change";
export const BROWSER_RECIPES_CHANGED_EVENT = "codelit-browser-recipes-change";

export function isBrowserWriteAction(action: AgentBrowserAction) {
  return WRITE_ACTIONS.has(action.type);
}

export function isSensitiveBrowserTarget(value: string) {
  return SENSITIVE_TARGET.test(value);
}

function browserTargetLabel(target: AgentBrowserActionTarget) {
  return `${target.kind} \"${target.value}\"${target.name ? ` named \"${target.name}\"` : ""}`;
}

export function browserWritePreview(config: ValidatedBrowserToolConfig): string[] {
  const domain = new URL(config.startUrl).hostname;
  return (config.actions || []).filter(isBrowserWriteAction).map((action) => {
    if (action.type === "click") return `${domain}: click ${browserTargetLabel(action.target)}`;
    if (action.type === "fill") return `${domain}: fill ${browserTargetLabel(action.target)} with ${action.value.length} characters`;
    if (action.type === "select") return `${domain}: select an option in ${browserTargetLabel(action.target)}`;
    if (action.type === "press") return `${domain}: press ${action.key} on ${browserTargetLabel(action.target)}`;
    return `${domain}: write action`;
  });
}

export function browserExactWritePreview(config: ValidatedBrowserToolConfig): string[] {
  const domain = new URL(config.startUrl).hostname;
  return (config.actions || []).filter(isBrowserWriteAction).map((action) => {
    if (action.type === "click") return `${domain}: click ${browserTargetLabel(action.target)}`;
    if (action.type === "fill") return `${domain}: fill ${browserTargetLabel(action.target)} with ${JSON.stringify(action.value)}`;
    if (action.type === "select") return `${domain}: select ${JSON.stringify(action.value)} in ${browserTargetLabel(action.target)}`;
    if (action.type === "press") return `${domain}: press ${action.key} on ${browserTargetLabel(action.target)}`;
    return `${domain}: write action`;
  });
}

export function mergeBrowserToolConfig(
  current: ToolExecutionConfig["browser"] | undefined,
  updates: Partial<BrowserToolConfig>,
): BrowserToolConfig {
  const merged: BrowserToolConfig = {
    startUrl: "",
    approvedDomains: [],
    mode: "read",
    persistSession: false,
    ...current,
    ...updates,
  };
  const persistSession = merged.mode === "write" ? true : merged.persistSession;
  const scope = merged.mode === "write" ? "approved-actions" : persistSession ? "signed-in-read" : "public-read";
  return {
    ...merged,
    persistSession,
    maxDurationSeconds: BROWSER_SCOPE_POLICY[scope].maxDurationSeconds,
  };
}

export function browserAccessScope(value: ToolExecutionConfig["browser"] | ValidatedBrowserToolConfig | undefined): BrowserAccessScope {
  if (value?.mode === "write") return "approved-actions";
  return value?.persistSession ? "signed-in-read" : "public-read";
}

export function browserScopeExpandsAccess(current: BrowserAccessScope, next: BrowserAccessScope) {
  return BROWSER_SCOPE_RANK[next] > BROWSER_SCOPE_RANK[current];
}

export function browserConfigForScope(
  current: ToolExecutionConfig["browser"] | undefined,
  scope: BrowserAccessScope,
): BrowserToolConfig {
  const policy = BROWSER_SCOPE_POLICY[scope];
  const currentActions = current?.actions || [];
  const actions = scope === "approved-actions"
    ? current?.goal
      ? []
      : currentActions.some(isBrowserWriteAction)
      ? currentActions
      : [...currentActions, { type: "click" as const, target: { kind: "role" as const, value: "button", name: "Continue" } }]
    : currentActions.filter((action) => !isBrowserWriteAction(action));
  return mergeBrowserToolConfig(current, {
    mode: policy.mode,
    persistSession: policy.persistSession,
    maxDurationSeconds: policy.maxDurationSeconds,
    ...(actions.length ? { actions } : { actions: undefined }),
  });
}

export function browserConfigForWebsite(current: ToolExecutionConfig["browser"] | undefined, startUrl: string): BrowserToolConfig {
  const setup = browserWebsiteSetup(startUrl);
  return mergeBrowserToolConfig(current, {
    startUrl,
    ...(setup ? { approvedDomains: setup.approvedDomains } : {}),
  });
}

function parseTarget(value: unknown): AgentBrowserActionTarget | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const kind = clean(raw.kind, 20);
  const targetValue = clean(raw.value, 160);
  const name = clean(raw.name, 160);
  if (!TARGET_KINDS.has(kind) || !targetValue) return null;
  const target: AgentBrowserActionTarget = {
    kind: kind as AgentBrowserActionTarget["kind"],
    value: targetValue,
    ...(name ? { name } : {}),
    ...(typeof raw.exact === "boolean" ? { exact: raw.exact } : {}),
  };
  return target;
}

function parseAction(value: unknown, approvedDomains: string[]): AgentBrowserAction | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const type = clean(raw.type, 20);
  if (type === "navigate") {
    const url = clean(raw.url, 2048);
    return isBrowserUrlAllowed(url, approvedDomains) ? { type, url } : null;
  }
  if (type === "observe" || type === "screenshot") return { type };
  const target = parseTarget(raw.target);
  if (!target) return null;
  if (type === "wait") return { type, target };
  if (isSensitiveBrowserTarget(`${target.value} ${target.name || ""}`)) return null;
  if (type === "click") return { type, target };
  if (type === "fill" || type === "select") {
    const actionValue = clean(raw.value, 500);
    return actionValue ? { type, target, value: actionValue } : null;
  }
  if (type === "press") {
    const key = clean(raw.key, 40);
    return key && /^[A-Za-z0-9+_-]+$/.test(key) ? { type, target, key } : null;
  }
  return null;
}

export function validateBrowserToolConfig(value: unknown): BrowserConfigResult {
  if (!value || typeof value !== "object") return { ok: false, error: "Browser configuration is required" };
  const raw = value as Record<string, unknown>;
  const approvedDomains = normalizeApprovedDomains(raw.approvedDomains);
  if (!approvedDomains) return { ok: false, error: "Provide 1-10 valid approved domains" };
  const startUrl = clean(raw.startUrl, 2048);
  if (!isBrowserUrlAllowed(startUrl, approvedDomains)) return { ok: false, error: "Start URL must be HTTPS and inside the approved domains" };
  const startUrlHandoffField = clean(raw.startUrlHandoffField, 160);
  if (raw.startUrlHandoffField !== undefined && !HANDOFF_FIELD_PATH.test(startUrlHandoffField)) {
    return { ok: false, error: "Run URL field is invalid" };
  }
  const approvedDomainHandoffField = clean(raw.approvedDomainHandoffField, 160);
  if (raw.approvedDomainHandoffField !== undefined && !HANDOFF_FIELD_PATH.test(approvedDomainHandoffField)) {
    return { ok: false, error: "Run approved domain field is invalid" };
  }
  const mode = raw.mode === "write" ? "write" : raw.mode === undefined || raw.mode === "read" ? "read" : null;
  if (!mode) return { ok: false, error: "Browser mode must be read or write" };
  const sessionId = clean(raw.sessionId, 160);
  if (sessionId && !/^[A-Za-z0-9_-]+$/.test(sessionId)) return { ok: false, error: "Browser session is invalid" };
  const goal = clean(raw.goal, 600);
  if (raw.goal !== undefined && !goal) return { ok: false, error: "Browser Operator needs a goal" };
  const goalHandoffField = clean(raw.goalHandoffField, 160);
  if (raw.goalHandoffField !== undefined && !HANDOFF_FIELD_PATH.test(goalHandoffField)) {
    return { ok: false, error: "Run goal field is invalid" };
  }
  const successCriteria = goal
    ? clean(raw.successCriteria, 400) || "The requested outcome is visibly confirmed on the page"
    : "";
  const successCriteriaHandoffField = clean(raw.successCriteriaHandoffField, 160);
  if (raw.successCriteriaHandoffField !== undefined && !HANDOFF_FIELD_PATH.test(successCriteriaHandoffField)) {
    return { ok: false, error: "Run success criteria field is invalid" };
  }
  if (!goal && raw.successCriteria !== undefined) return { ok: false, error: "Success criteria require a Browser Operator goal" };
  if (goal && raw.actions !== undefined) return { ok: false, error: "Choose either an operator goal or a hand-authored action list" };
  let actions: AgentBrowserAction[] | undefined;
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions) || !raw.actions.length || raw.actions.length > MAX_BROWSER_ACTIONS) {
      return { ok: false, error: `Browser actions must contain 1-${MAX_BROWSER_ACTIONS} typed actions` };
    }
    const parsed = raw.actions.map((action) => parseAction(action, approvedDomains));
    if (parsed.some((action) => action === null)) return { ok: false, error: "A browser action is invalid or blocked by policy" };
    actions = parsed as AgentBrowserAction[];
    if (mode === "read" && actions.some(isBrowserWriteAction)) return { ok: false, error: "Write actions require write mode" };
    if (actions.filter((action) => action.type === "observe" || action.type === "screenshot").length > MAX_BROWSER_EVIDENCE_ITEMS) {
      return { ok: false, error: `Browser actions support at most ${MAX_BROWSER_EVIDENCE_ITEMS} evidence captures` };
    }
  }
  if (mode === "write" && !goal && !actions?.some(isBrowserWriteAction)) return { ok: false, error: "Write mode requires at least one typed write action" };
  const persistSession = raw.persistSession === true;
  if (mode === "write" && !persistSession) return { ok: false, error: "Browser writes require a persistent saved session" };
  const scope = mode === "write" ? "approved-actions" : persistSession ? "signed-in-read" : "public-read";
  const expectedDuration = BROWSER_SCOPE_POLICY[scope].maxDurationSeconds;
  const maxDurationSeconds = raw.maxDurationSeconds === undefined
    ? expectedDuration
    : typeof raw.maxDurationSeconds === "number" && Number.isInteger(raw.maxDurationSeconds) && raw.maxDurationSeconds === expectedDuration
      ? raw.maxDurationSeconds
      : null;
  if (!maxDurationSeconds) return { ok: false, error: `Browser time limit must be ${expectedDuration} seconds for ${scope}` };
  const config: ValidatedBrowserToolConfig = {
    startUrl,
    ...(startUrlHandoffField ? { startUrlHandoffField } : {}),
    ...(approvedDomainHandoffField ? { approvedDomainHandoffField } : {}),
    approvedDomains,
    ...(sessionId ? { sessionId } : {}),
    mode,
    persistSession,
    maxDurationSeconds,
    ...(goal ? {
      goal,
      ...(goalHandoffField ? { goalHandoffField } : {}),
      successCriteria,
      ...(successCriteriaHandoffField ? { successCriteriaHandoffField } : {}),
    } : {}),
    ...(actions ? { actions } : {}),
  };
  if (browserActionsForConfig(config).filter((action) => action.type === "observe" || action.type === "screenshot").length > MAX_BROWSER_EVIDENCE_ITEMS) {
    return { ok: false, error: `Browser actions support at most ${MAX_BROWSER_EVIDENCE_ITEMS} evidence captures including final evidence` };
  }
  return { ok: true, config };
}

export function browserActionsForConfig(config: ValidatedBrowserToolConfig): AgentBrowserAction[] {
  if (config.goal) return [];
  if (!config.actions?.length) {
    return [{ type: "navigate", url: config.startUrl }, { type: "observe" }, { type: "screenshot" }];
  }
  const actions: AgentBrowserAction[] = config.actions.some((action) => action.type === "navigate")
    ? config.actions
    : [{ type: "navigate" as const, url: config.startUrl }, ...config.actions];
  let lastWriteIndex = -1;
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (isBrowserWriteAction(actions[index])) {
      lastWriteIndex = index;
      break;
    }
  }
  const evidenceTail = actions.slice(lastWriteIndex + 1);
  return [
    ...actions,
    ...(evidenceTail.some((action) => action.type === "observe") ? [] : [{ type: "observe" as const }]),
    ...(evidenceTail.some((action) => action.type === "screenshot") ? [] : [{ type: "screenshot" as const }]),
  ];
}

export function isBrowserOperatorConfig(config: ValidatedBrowserToolConfig) {
  return Boolean(config.goal);
}

export function browserConfigFromExecutionConfig(value: ToolExecutionConfig | undefined): BrowserConfigResult {
  return validateBrowserToolConfig(value?.browser);
}

export function browserConfigForHandoff(value: unknown, handoff: string): BrowserConfigResult {
  const configured = validateBrowserToolConfig(value);
  if (!configured.ok) return configured;
  const field = configured.config.startUrlHandoffField;
  const startUrl = field
    ? renderAgentHandoffTemplate(`{{handoff.${field}}}`, handoff, 2048)
    : configured.config.startUrl;
  if (field && !startUrl) return { ok: false, error: `Run URL ${field} is required` };
  const approvedDomainField = configured.config.approvedDomainHandoffField;
  const approvedDomain = approvedDomainField
    ? renderAgentHandoffTemplate(`{{handoff.${approvedDomainField}}}`, handoff, 253)
    : "";
  if (approvedDomainField && !approvedDomain) return { ok: false, error: `Run approved domain ${approvedDomainField} is required` };
  const approvedDomains = approvedDomainField
    ? normalizeApprovedDomains([approvedDomain])
    : configured.config.approvedDomains;
  if (!approvedDomains) return { ok: false, error: "Run approved domain is invalid" };
  const goalField = configured.config.goalHandoffField;
  const goal = goalField
    ? renderAgentHandoffTemplate(`{{handoff.${goalField}}}`, handoff, 600)
    : configured.config.goal;
  if (goalField && !goal) return { ok: false, error: `Run goal ${goalField} is required` };
  const successCriteriaField = configured.config.successCriteriaHandoffField;
  const successCriteria = successCriteriaField
    ? renderAgentHandoffTemplate(`{{handoff.${successCriteriaField}}}`, handoff, 400)
    : configured.config.successCriteria;
  if (successCriteriaField && !successCriteria) return { ok: false, error: `Run success criteria ${successCriteriaField} is required` };
  let missingActionInput = false;
  const actions = configured.config.actions?.map((action) => {
    if (action.type !== "fill" && action.type !== "select") return action;
    if (!/\{\{handoff(?:\.[A-Za-z][A-Za-z0-9_.-]{0,159})?\}\}/.test(action.value)) return action;
    const resolvedValue = renderAgentHandoffTemplate(action.value, handoff, 500);
    if (!resolvedValue) missingActionInput = true;
    return { ...action, value: resolvedValue };
  });
  if (missingActionInput) return { ok: false, error: "A required browser run input is missing" };
  const resolved = validateBrowserToolConfig({
    ...configured.config,
    startUrl,
    startUrlHandoffField: undefined,
    approvedDomains,
    approvedDomainHandoffField: undefined,
    goal,
    goalHandoffField: undefined,
    successCriteria,
    successCriteriaHandoffField: undefined,
    ...(actions ? { actions } : {}),
  });
  if (!resolved.ok && field) return { ok: false, error: "Run URL must be HTTPS and inside the approved domains" };
  return resolved;
}
