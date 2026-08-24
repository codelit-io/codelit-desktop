import {
  HOSTED_TRIGGER_PROVIDERS,
  HOSTED_TRIGGER_PROVIDER_EVENTS,
  sanitizeHostedTriggerConfig,
  type HostedProviderTrigger,
  type HostedScheduleTrigger,
  type HostedTriggerFilter,
  type HostedTriggerProvider,
} from "./hosted-trigger";

const HOSTED_TRIGGER_MODES = new Set<HostedTriggerDraft["mode"]>(["schedule", "provider", "webhook"]);
const HOSTED_TRIGGER_PROVIDER_SET = new Set<string>(HOSTED_TRIGGER_PROVIDERS);
const SCHEDULE_INTERVALS = new Set<HostedScheduleTrigger["intervalMinutes"]>([60, 360, 1440, 10080]);
const PROVIDER_POLL_INTERVALS = new Set<HostedProviderTrigger["pollMinutes"]>([10, 60]);

export interface HostedTriggerDraft {
  mode: "schedule" | "provider" | "webhook";
  intervalMinutes: HostedScheduleTrigger["intervalMinutes"];
  weekdaysOnly: boolean;
  scheduleTimezone: string;
  provider: HostedTriggerProvider;
  event: HostedProviderTrigger["event"];
  pollMinutes: HostedProviderTrigger["pollMinutes"];
  resourceId: string;
  resourceLabel: string;
  connectionId: string;
  teamId: string;
  channelId: string;
  query: string;
  dailyRunLimit: number;
  dedupeWindowMinutes: number;
  filterEnabled: boolean;
  filterPath: string;
  filterOperator: HostedTriggerFilter["operator"];
  filterValue: string;
  quietEnabled: boolean;
  quietTimezone: string;
  quietStartHour: number;
  quietEndHour: number;
}

export function defaultHostedTriggerDraft(timezone?: string): HostedTriggerDraft {
  let localTimezone = timezone || "UTC";
  if (!timezone) {
    try {
      localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      localTimezone = "UTC";
    }
  }
  return {
    mode: "schedule",
    intervalMinutes: 1440,
    weekdaysOnly: false,
    scheduleTimezone: localTimezone,
    provider: "github",
    event: "github.issue.opened",
    pollMinutes: 10,
    resourceId: "",
    resourceLabel: "",
    connectionId: "",
    teamId: "",
    channelId: "",
    query: "",
    dailyRunLimit: 12,
    dedupeWindowMinutes: 1440,
    filterEnabled: false,
    filterPath: "",
    filterOperator: "equals",
    filterValue: "",
    quietEnabled: false,
    quietTimezone: localTimezone,
    quietStartHour: 22,
    quietEndHour: 8,
  };
}

function draftRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function draftString(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function draftInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function draftTimezone(value: unknown, fallback: string) {
  const timezone = draftString(value, 80);
  if (!timezone) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return fallback;
  }
}

/** Safely restores an editable draft, including incomplete account/resource choices. */
export function sanitizeHostedTriggerDraft(value: unknown, timezone = "UTC"): HostedTriggerDraft | null {
  const input = draftRecord(value);
  if (!input || !HOSTED_TRIGGER_MODES.has(input.mode as HostedTriggerDraft["mode"])) return null;
  if (typeof input.provider !== "string" || !HOSTED_TRIGGER_PROVIDER_SET.has(input.provider)) return null;

  const defaults = defaultHostedTriggerDraft(timezone);
  const mode = input.mode as HostedTriggerDraft["mode"];
  const provider = input.provider as HostedTriggerProvider;
  const providerEvents = HOSTED_TRIGGER_PROVIDER_EVENTS[provider];
  const event = typeof input.event === "string" && providerEvents.includes(input.event as HostedProviderTrigger["event"])
    ? input.event as HostedProviderTrigger["event"]
    : mode === "provider" ? null : providerEvents[0];
  if (!event) return null;

  const intervalMinutes = SCHEDULE_INTERVALS.has(input.intervalMinutes as HostedScheduleTrigger["intervalMinutes"])
    ? input.intervalMinutes as HostedScheduleTrigger["intervalMinutes"]
    : defaults.intervalMinutes;
  const pollMinutes = PROVIDER_POLL_INTERVALS.has(input.pollMinutes as HostedProviderTrigger["pollMinutes"])
    ? input.pollMinutes as HostedProviderTrigger["pollMinutes"]
    : defaults.pollMinutes;
  const filterOperator = input.filterOperator === "equals" || input.filterOperator === "contains" || input.filterOperator === "exists"
    ? input.filterOperator
    : defaults.filterOperator;

  return {
    mode,
    intervalMinutes,
    weekdaysOnly: input.weekdaysOnly === true,
    scheduleTimezone: draftTimezone(input.scheduleTimezone, timezone),
    provider,
    event,
    pollMinutes,
    resourceId: draftString(input.resourceId, 200),
    resourceLabel: draftString(input.resourceLabel, 160),
    connectionId: draftString(input.connectionId, 160),
    teamId: draftString(input.teamId, 200),
    channelId: draftString(input.channelId, 200),
    query: draftString(input.query, 500),
    dailyRunLimit: draftInteger(input.dailyRunLimit, defaults.dailyRunLimit, 1, 24),
    dedupeWindowMinutes: draftInteger(input.dedupeWindowMinutes, defaults.dedupeWindowMinutes, 60, 10_080),
    filterEnabled: input.filterEnabled === true,
    filterPath: draftString(input.filterPath, 320),
    filterOperator,
    filterValue: draftString(input.filterValue, 200),
    quietEnabled: input.quietEnabled === true,
    quietTimezone: draftTimezone(input.quietTimezone, timezone),
    quietStartHour: draftInteger(input.quietStartHour, defaults.quietStartHour, 0, 23),
    quietEndHour: draftInteger(input.quietEndHour, defaults.quietEndHour, 0, 23),
  };
}

export function recommendedHostedTriggerDraft(input: {
  title: string;
  timezone?: string;
  sources: Array<{ kind: string; id: string; label?: string }>;
  connections: Array<{ id: string; providerId: string; label?: string }>;
}) {
  const draft = defaultHostedTriggerDraft(input.timezone);
  const title = input.title.toLowerCase();
  const source = (kind: string) => input.sources.find((candidate) => candidate.kind === kind);
  const connection = (providerId: string) => input.connections.find((candidate) => candidate.providerId === providerId);
  const slack = source("slack");
  const github = source("github");
  const gmail = connection("google-workspace");
  const sentry = connection("sentry");
  const microsoft = connection("microsoft-365");

  if (/\b(refund|return|billing resolution)\b/.test(title)) {
    return { ...draft, mode: "webhook" as const, dailyRunLimit: 24, dedupeWindowMinutes: 10_080 };
  }
  if (/\b(lead qualification|lead research|lead follow-up|lead follow up|prospect)\b/.test(title)) {
    return {
      ...draft,
      mode: "schedule" as const,
      intervalMinutes: 1440 as const,
      dailyRunLimit: 10,
      dedupeWindowMinutes: 10_080,
      quietEnabled: true,
    };
  }
  if (sentry && /\b(incident|error|on-call|oncall|reliability|sentry|outage)\b/.test(title)) {
    return { ...draft, mode: "provider" as const, provider: "sentry" as const, event: "sentry.issue.matched" as const, connectionId: sentry.id, query: "is:unresolved" };
  }
  if (slack && /\b(slack|channel|message|community)\b/.test(title)) {
    return { ...draft, mode: "provider" as const, provider: "slack" as const, event: "slack.message.posted" as const, resourceId: slack.id, resourceLabel: slack.label || slack.id };
  }
  if (microsoft && /\b(teams|microsoft channel)\b/.test(title)) {
    return { ...draft, mode: "provider" as const, provider: "microsoft-teams" as const, event: "microsoft.teams.message.posted" as const, connectionId: microsoft.id };
  }
  if (microsoft && /\b(outlook|microsoft inbox)\b/.test(title)) {
    return { ...draft, mode: "provider" as const, provider: "outlook" as const, event: "microsoft.outlook.message.matched" as const, connectionId: microsoft.id, query: "isRead:false" };
  }
  if (gmail && /\b(inbox|email|refund|support|lead|customer|knowledge)\b/.test(title)) {
    return { ...draft, mode: "provider" as const, provider: "gmail" as const, event: "gmail.message.matched" as const, connectionId: gmail.id, query: "is:unread" };
  }
  if (github && /\b(repository|repo|maintenance|pull request|github)\b/.test(title)) {
    return { ...draft, mode: "provider" as const, provider: "github" as const, event: "github.issue.opened" as const, resourceId: github.id, resourceLabel: github.label || github.id, dedupeWindowMinutes: 10_080 };
  }
  if (github && /\b(release|ci|code)\b/.test(title)) {
    return { ...draft, mode: "provider" as const, provider: "github" as const, event: "github.workflow.failed" as const, resourceId: github.id, resourceLabel: github.label || github.id };
  }
  return draft;
}

export function hostedTriggerConfigFromDraft(draft: HostedTriggerDraft) {
  const policy = {
    version: 1,
    dailyRunLimit: draft.dailyRunLimit,
    dedupeWindowMinutes: draft.dedupeWindowMinutes,
    ...(draft.filterEnabled ? {
      filter: {
        path: draft.filterPath,
        operator: draft.filterOperator,
        ...(draft.filterOperator === "exists" ? {} : { value: draft.filterValue }),
      },
    } : {}),
    ...(draft.quietEnabled ? {
      quietHours: {
        timezone: draft.quietTimezone,
        startHour: draft.quietStartHour,
        endHour: draft.quietEndHour,
      },
    } : {}),
  };
  if (draft.mode === "schedule") {
    return sanitizeHostedTriggerConfig({ ...policy, kind: "schedule", intervalMinutes: draft.intervalMinutes, timezone: draft.scheduleTimezone, ...(draft.weekdaysOnly ? { weekdaysOnly: true } : {}) });
  }
  if (draft.mode === "webhook") {
    return sanitizeHostedTriggerConfig({ ...policy, kind: "webhook", event: "webhook.received", authMode: "hmac" });
  }
  return sanitizeHostedTriggerConfig({
    ...policy,
    kind: "provider",
    provider: draft.provider,
    event: draft.event,
    pollMinutes: draft.pollMinutes,
    ...(draft.resourceId ? { resourceId: draft.resourceId } : {}),
    ...(draft.resourceLabel ? { resourceLabel: draft.resourceLabel } : {}),
    ...(draft.connectionId ? { connectionId: draft.connectionId } : {}),
    ...(draft.teamId ? { teamId: draft.teamId } : {}),
    ...(draft.channelId ? { channelId: draft.channelId } : {}),
    ...(draft.query.trim() ? { query: draft.query.trim() } : {}),
  });
}
