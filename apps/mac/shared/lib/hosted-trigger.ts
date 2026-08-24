export const HOSTED_TRIGGER_PROVIDERS = ["github", "slack", "gmail", "microsoft-teams", "outlook", "sentry"] as const;
export type HostedTriggerProvider = (typeof HOSTED_TRIGGER_PROVIDERS)[number];

export type HostedTriggerFilter = {
  path: string;
  operator: "equals" | "contains" | "exists";
  value?: string;
};

export type HostedTriggerQuietHours = {
  timezone: string;
  startHour: number;
  endHour: number;
};

interface HostedTriggerPolicy {
  version: 1;
  dailyRunLimit: number;
  dedupeWindowMinutes: number;
  quietHours?: HostedTriggerQuietHours;
  filter?: HostedTriggerFilter;
}

export type HostedScheduleTrigger = HostedTriggerPolicy & {
  kind: "schedule";
  intervalMinutes: 60 | 360 | 1440 | 10080;
  timezone?: string;
  weekdaysOnly?: boolean;
};

export type HostedWebhookTrigger = HostedTriggerPolicy & {
  kind: "webhook";
  event: "webhook.received";
  authMode: "hmac" | "token";
};

export type HostedProviderTrigger = HostedTriggerPolicy & {
  kind: "provider";
  provider: HostedTriggerProvider;
  event: "github.issue.opened" | "github.workflow.failed" | "slack.message.posted" | "gmail.message.matched" | "microsoft.teams.message.posted" | "microsoft.outlook.message.matched" | "sentry.issue.matched";
  pollMinutes: 10 | 60;
  resourceId?: string;
  resourceLabel?: string;
  connectionId?: string;
  teamId?: string;
  channelId?: string;
  query?: string;
};

export type HostedTriggerConfig = HostedScheduleTrigger | HostedWebhookTrigger | HostedProviderTrigger;

export type HostedTriggerReview =
  | { ok: true; config: HostedTriggerConfig }
  | { ok: false; error: string };

export type HostedTriggerEvaluation =
  | { status: "accepted" }
  | { status: "filtered"; reason: "filter-mismatch" | "schedule-day" }
  | { status: "deferred"; reason: "quiet-hours"; resumeAt: string }
  | { status: "limited"; reason: "daily-limit" };

const SCHEDULE_INTERVALS = new Set([60, 360, 1440, 10080]);
const PROVIDER_POLL_INTERVALS = new Set([10, 60]);
export const HOSTED_TRIGGER_PROVIDER_EVENTS: Record<HostedTriggerProvider, readonly HostedProviderTrigger["event"][]> = {
  github: ["github.issue.opened", "github.workflow.failed"],
  slack: ["slack.message.posted"],
  gmail: ["gmail.message.matched"],
  "microsoft-teams": ["microsoft.teams.message.posted"],
  outlook: ["microsoft.outlook.message.matched"],
  sentry: ["sentry.issue.matched"],
};
const PROVIDER_SET = new Set<string>(HOSTED_TRIGGER_PROVIDERS);
const CONNECTION_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SLACK_CHANNEL = /^[A-Z0-9]{3,32}$/;
const MICROSOFT_RESOURCE_ID = /^[A-Za-z0-9_.:@-]{1,200}$/;
const FILTER_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const BLOCKED_FILTER_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function integer(value: unknown, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function sanitizeQuietHours(value: unknown): HostedTriggerQuietHours | null | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (!input) return null;
  const timezone = boundedString(input.timezone, 80);
  const startHour = integer(input.startHour, -1, 0, 23);
  const endHour = integer(input.endHour, -1, 0, 23);
  if (!timezone || !validTimezone(timezone) || startHour === null || endHour === null || startHour === endHour) return null;
  return { timezone, startHour, endHour };
}

function sanitizeFilter(value: unknown): HostedTriggerFilter | null | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (!input) return null;
  const path = boundedString(input.path, 320);
  const parts = path.split(".");
  if (!path || parts.length > 5 || parts.some((part) => !FILTER_SEGMENT.test(part) || BLOCKED_FILTER_SEGMENTS.has(part))) return null;
  if (input.operator !== "equals" && input.operator !== "contains" && input.operator !== "exists") return null;
  if (input.operator === "exists") return { path, operator: "exists" };
  const valueText = boundedString(input.value, 200);
  if (!valueText) return null;
  return { path, operator: input.operator, value: valueText };
}

function policy(input: Record<string, unknown>) {
  const dailyRunLimit = integer(input.dailyRunLimit, 12, 1, 24);
  const dedupeWindowMinutes = integer(input.dedupeWindowMinutes, 1440, 60, 10_080);
  const quietHours = sanitizeQuietHours(input.quietHours);
  const filter = sanitizeFilter(input.filter);
  if (dailyRunLimit === null || dedupeWindowMinutes === null || quietHours === null || filter === null) return null;
  return {
    version: 1 as const,
    dailyRunLimit,
    dedupeWindowMinutes,
    ...(quietHours ? { quietHours } : {}),
    ...(filter ? { filter } : {}),
  };
}

export function defaultHostedTriggerConfig(scheduleMinutes = 1440): HostedScheduleTrigger {
  const intervalMinutes = SCHEDULE_INTERVALS.has(scheduleMinutes) ? scheduleMinutes as HostedScheduleTrigger["intervalMinutes"] : 1440;
  return { version: 1, kind: "schedule", intervalMinutes, dailyRunLimit: 12, dedupeWindowMinutes: 1440 };
}

export function sanitizeHostedTriggerConfig(value: unknown): HostedTriggerReview {
  const input = record(value);
  if (!input || (input.version !== undefined && input.version !== 1)) return { ok: false, error: "Trigger configuration is invalid" };
  const shared = policy(input);
  if (!shared) return { ok: false, error: "Trigger policy is invalid" };

  if (input.kind === "schedule") {
    if (typeof input.intervalMinutes !== "number" || !SCHEDULE_INTERVALS.has(input.intervalMinutes)) {
      return { ok: false, error: "Schedule must run hourly, every six hours, daily, or weekly" };
    }
    const timezone = input.timezone === undefined ? undefined : boundedString(input.timezone, 80);
    if (input.timezone !== undefined && (!timezone || !validTimezone(timezone))) return { ok: false, error: "Schedule timezone is invalid" };
    if (input.weekdaysOnly !== undefined && typeof input.weekdaysOnly !== "boolean") return { ok: false, error: "Weekday schedule is invalid" };
    if (input.weekdaysOnly === true && !timezone) return { ok: false, error: "Weekday schedules require a timezone" };
    return { ok: true, config: { ...shared, kind: "schedule", intervalMinutes: input.intervalMinutes as HostedScheduleTrigger["intervalMinutes"], ...(timezone ? { timezone } : {}), ...(input.weekdaysOnly === true ? { weekdaysOnly: true } : {}) } };
  }

  if (input.kind === "webhook") {
    if (input.event !== "webhook.received" || (input.authMode !== "hmac" && input.authMode !== "token")) {
      return { ok: false, error: "Webhook trigger authentication is invalid" };
    }
    return { ok: true, config: { ...shared, kind: "webhook", event: "webhook.received", authMode: input.authMode } };
  }

  if (input.kind !== "provider" || typeof input.provider !== "string" || !PROVIDER_SET.has(input.provider)) {
    return { ok: false, error: "Trigger type is not supported" };
  }
  const provider = input.provider as HostedTriggerProvider;
  if (typeof input.event !== "string" || !HOSTED_TRIGGER_PROVIDER_EVENTS[provider].includes(input.event as HostedProviderTrigger["event"])) {
    return { ok: false, error: "The selected event does not belong to this provider" };
  }
  if (typeof input.pollMinutes !== "number" || !PROVIDER_POLL_INTERVALS.has(input.pollMinutes)) {
    return { ok: false, error: "Provider checks must run every ten minutes or hourly" };
  }
  const resourceId = boundedString(input.resourceId, 200);
  const connectionId = boundedString(input.connectionId, 160);
  if (provider === "github" && !GITHUB_REPOSITORY.test(resourceId)) return { ok: false, error: "Choose one GitHub repository" };
  if (provider === "slack" && !SLACK_CHANNEL.test(resourceId)) return { ok: false, error: "Choose one Slack channel" };
  if (["gmail", "microsoft-teams", "outlook", "sentry"].includes(provider) && !CONNECTION_ID.test(connectionId)) return { ok: false, error: "Choose one connected provider account" };
  const teamId = boundedString(input.teamId, 200);
  const channelId = boundedString(input.channelId, 200);
  if (provider === "microsoft-teams" && (!MICROSOFT_RESOURCE_ID.test(teamId) || !MICROSOFT_RESOURCE_ID.test(channelId))) {
    return { ok: false, error: "Choose one Microsoft Teams channel" };
  }
  const query = boundedString(input.query, 500);
  if ((provider === "gmail" || provider === "outlook" || provider === "sentry") && !query) return { ok: false, error: "This provider event needs a bounded query" };
  const resourceLabel = boundedString(input.resourceLabel, 160);
  return {
    ok: true,
    config: {
      ...shared,
      kind: "provider",
      provider,
      event: input.event as HostedProviderTrigger["event"],
      pollMinutes: input.pollMinutes as HostedProviderTrigger["pollMinutes"],
      ...(resourceId ? { resourceId } : {}),
      ...(resourceLabel ? { resourceLabel } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(query ? { query } : {}),
    },
  };
}

const EVENT_LABELS: Record<HostedProviderTrigger["event"], string> = {
  "github.issue.opened": "New GitHub issue",
  "github.workflow.failed": "Failed GitHub workflow",
  "slack.message.posted": "New Slack message",
  "gmail.message.matched": "New matching Gmail message",
  "microsoft.teams.message.posted": "New Microsoft Teams message",
  "microsoft.outlook.message.matched": "New matching Outlook message",
  "sentry.issue.matched": "New matching Sentry issue",
};

export function hostedTriggerSummary(config: HostedTriggerConfig) {
  if (config.kind === "schedule") {
    if (config.weekdaysOnly) return "Every weekday";
    if (config.intervalMinutes === 60) return "Every hour";
    if (config.intervalMinutes === 360) return "Every 6 hours";
    if (config.intervalMinutes === 1440) return "Once a day";
    return "Once a week";
  }
  if (config.kind === "webhook") return config.authMode === "hmac" ? "Signed webhook" : "Webhook";
  const resource = config.resourceLabel || config.resourceId;
  return `${EVENT_LABELS[config.event]}${resource ? ` in ${resource}` : ""} · checks every ${config.pollMinutes} min`;
}

function valueAtPath(payload: unknown, path: string): unknown {
  let current = payload;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function primitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function matchesFilter(payload: unknown, filter: HostedTriggerFilter) {
  const actual = valueAtPath(payload, filter.path);
  if (filter.operator === "exists") return actual !== undefined;
  if (filter.operator === "equals") return primitive(actual) && String(actual) === filter.value;
  const expected = (filter.value || "").toLowerCase();
  if (primitive(actual)) return String(actual).toLowerCase().includes(expected);
  if (Array.isArray(actual)) return actual.some((item) => primitive(item) && String(item).toLowerCase().includes(expected));
  return false;
}

function localHour(timestamp: number, timezone: string) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(timestamp)
    .find((candidate) => candidate.type === "hour")?.value;
  return Number(part);
}

function localWeekday(timestamp: number, timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(timestamp);
  } catch {
    return "";
  }
}

function isQuietAt(timestamp: number, quietHours: HostedTriggerQuietHours) {
  const hour = localHour(timestamp, quietHours.timezone);
  if (!Number.isInteger(hour)) return false;
  return quietHours.startHour < quietHours.endHour
    ? hour >= quietHours.startHour && hour < quietHours.endHour
    : hour >= quietHours.startHour || hour < quietHours.endHour;
}

function quietHoursEnd(timestamp: number, quietHours: HostedTriggerQuietHours) {
  const nextMinute = Math.floor(timestamp / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset <= 26 * 60; offset += 1) {
    const candidate = nextMinute + offset * 60_000;
    if (!isQuietAt(candidate, quietHours)) return new Date(candidate).toISOString();
  }
  return new Date(timestamp + 24 * 60 * 60_000).toISOString();
}

export function evaluateHostedTrigger(input: {
  config: HostedTriggerConfig;
  payload: unknown;
  runsToday: number;
  now: string;
}): HostedTriggerEvaluation {
  if (input.config.filter && !matchesFilter(input.payload, input.config.filter)) {
    return { status: "filtered", reason: "filter-mismatch" };
  }
  const timestamp = Date.parse(input.now);
  if (input.config.kind === "schedule" && input.config.weekdaysOnly && Number.isFinite(timestamp)) {
    const weekday = localWeekday(timestamp, input.config.timezone || "UTC");
    if (!weekday || weekday === "Sat" || weekday === "Sun") return { status: "filtered", reason: "schedule-day" };
  }
  if (input.runsToday >= input.config.dailyRunLimit) return { status: "limited", reason: "daily-limit" };
  if (input.config.quietHours && Number.isFinite(timestamp) && isQuietAt(timestamp, input.config.quietHours)) {
    return { status: "deferred", reason: "quiet-hours", resumeAt: quietHoursEnd(timestamp, input.config.quietHours) };
  }
  return { status: "accepted" };
}
