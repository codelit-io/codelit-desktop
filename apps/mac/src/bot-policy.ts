import type {
  BotEnginePolicy,
  BotPermissionPolicy,
  DesktopUpdateState,
  IntelligenceSelection,
  LocalBrowserSession,
  ModelManagerAction,
  ProviderModel,
  ProviderProbe,
} from "./contracts";
import botsP1BetaPolicy from "../bots-p1-beta-policy.json";

export type BotBuildChannel = DesktopUpdateState["channel"];

export type BotApprovalAction =
  | "browser-read"
  | "browser-interact"
  | "computer-use"
  | "download"
  | "external-write"
  | "project-write";

interface BotBrowserApprovalTarget {
  url: string;
  host: string;
}

export type BotBrowserAutoApprovalSource = "bot-safe-mode" | "bot-domain-scope";

const MAX_BOT_BROWSER_DOMAINS = 16;

function normalizedBrowserDomain(value: string) {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  const bare = domain.startsWith("*.") ? domain.slice(2) : domain;
  if (!bare
    || bare.length > 253
    || bare.includes("/")
    || bare.includes(":")
    || (domain.startsWith("*.") && bare.split(".").length < 2)
    || bare.split(".").some((label) => (
      !label
      || label.length > 63
      || !/^[a-z0-9-]+$/.test(label)
    ))) return null;
  return domain;
}

export function normalizeBotBrowserDomains(values: readonly string[]) {
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const value of values.slice(0, MAX_BOT_BROWSER_DOMAINS)) {
    const domain = typeof value === "string" ? normalizedBrowserDomain(value) : null;
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      domains.push(domain);
    }
  }
  return domains;
}

export function botBrowserDomainMatches(hostValue: string, patternValue: string) {
  const host = normalizedBrowserDomain(hostValue);
  const pattern = normalizedBrowserDomain(patternValue);
  if (!host || host.startsWith("*.") || !pattern) return false;
  if (!pattern.startsWith("*.")) return host === pattern;
  const suffix = pattern.slice(2);
  return host !== suffix && host.endsWith(`.${suffix}`);
}

function isLowRiskBrowserReadTarget(target: BotBrowserApprovalTarget) {
  try {
    const url = new URL(target.url);
    if (url.protocol !== "https:" || url.search) return false;
    if (url.hostname.toLowerCase().replace(/\.$/, "") !== target.host.toLowerCase().replace(/\.$/, "")) {
      return false;
    }
    const boundary = `${target.host}${url.pathname}`.toLowerCase();
    return !/(^|[./_-])(accounts?|admin|auth|billing|checkout|log-?in|oauth|payments?|settings|sign-?in|wallet)([./_-]|$)/.test(boundary);
  } catch {
    return false;
  }
}

export function botBrowserAutoApprovalSource(
  policy: BotPermissionPolicy,
  action: BotApprovalAction,
  browserTarget?: BotBrowserApprovalTarget,
): BotBrowserAutoApprovalSource | null {
  if (policy.browserAccess === "disabled"
    || action !== "browser-read"
    || !browserTarget
    || !isLowRiskBrowserReadTarget(browserTarget)) return null;
  if (policy.approvalMode === "safe-auto") return "bot-safe-mode";
  return normalizeBotBrowserDomains(policy.browserDomains || [])
    .some((domain) => botBrowserDomainMatches(browserTarget.host, domain))
    ? "bot-domain-scope"
    : null;
}

export function shouldAutoApproveBotAction(
  policy: BotPermissionPolicy,
  action: BotApprovalAction,
  browserTarget?: BotBrowserApprovalTarget,
) {
  return botBrowserAutoApprovalSource(policy, action, browserTarget) !== null;
}

export function isBotBrowserSessionOpen(
  session: Pick<LocalBrowserSession, "sessionId" | "status" | "visible"> | null,
  expectedSessionId: string,
) {
  return Boolean(
    session
    && session.sessionId === expectedSessionId
    && session.visible
    && session.status === "ready",
  );
}

export interface BotsP1BetaPolicy {
  schemaVersion: number;
  releaseArchitecture: string;
  releaseTarget: string;
  bundledModel: {
    id: string;
    revision: string;
    releaseValidatedMemoryGiB: number[];
  };
  browserDataStore: string;
  legacyWorkAccess: string;
  starterTasks: string[];
}

export const BOTS_P1_BETA_POLICY: BotsP1BetaPolicy = botsP1BetaPolicy;

export interface BotCapabilityManifest {
  providerIds: readonly ProviderProbe["id"][];
  projectRead: boolean;
  managedBrowserRead: boolean;
  scheduledRoutines: boolean;
  computerUse: boolean;
}

export const BOT_CAPABILITY_MANIFESTS: Record<BotBuildChannel, BotCapabilityManifest> = {
  direct: {
    providerIds: [
      "mlx", "codex", "copilot", "antigravity", "ollama", "lmstudio",
      "openai", "anthropic", "gemini",
    ],
    projectRead: true,
    managedBrowserRead: true,
    scheduledRoutines: true,
    computerUse: true,
  },
  "app-store": {
    providerIds: ["mlx", "openai", "anthropic", "gemini"],
    projectRead: true,
    managedBrowserRead: false,
    scheduledRoutines: false,
    computerUse: false,
  },
  development: {
    providerIds: [
      "mlx", "codex", "copilot", "antigravity", "ollama", "lmstudio",
      "openai", "anthropic", "gemini",
    ],
    projectRead: true,
    managedBrowserRead: true,
    scheduledRoutines: true,
    computerUse: true,
  },
};

const AUTO_ENGINE_ORDER: readonly ProviderProbe["id"][] = [
  "codex",
  "copilot",
  "antigravity",
  "ollama",
  "lmstudio",
  "mlx",
  "openai",
  "anthropic",
  "gemini",
];

const CONNECTED_AI_ENGINE_ORDER: readonly ProviderProbe["id"][] = [
  "codex",
  "copilot",
  "antigravity",
  "ollama",
  "lmstudio",
  "openai",
  "anthropic",
  "gemini",
  "mlx",
];

export function botProvidersForChannel(
  providers: ProviderProbe[],
  channel: BotBuildChannel,
) {
  const allowed = new Set(BOT_CAPABILITY_MANIFESTS[channel].providerIds);
  return providers.filter((provider) => allowed.has(provider.id));
}

export function preferredProviderModel(provider: ProviderProbe) {
  const groups = [
    provider.models.filter((model) => model.status === "ready" && model.recommended),
    provider.models.filter((model) => model.status === "ready"),
    provider.models.filter((model) => model.recommended),
    provider.models,
  ];
  for (const models of groups) {
    if (!models.length) continue;
    if (provider.id !== "mlx") return models[0];
    return models.reduce((best, model) => (
      (model.downloadBytes || 0) > (best.downloadBytes || 0) ? model : best
    ));
  }
  return undefined;
}

export function preferredOnDeviceSetupModel(provider: ProviderProbe) {
  const preferred = preferredProviderModel(provider);
  const preferredBytes = preferred?.status === "ready" ? preferred.downloadBytes || 0 : 0;
  const upgrade = provider.models
    .filter((model) => (
      model.recommended
      && model.status !== "ready"
      && model.status !== "incompatible"
      && (model.downloadBytes || 0) > preferredBytes
    ))
    .reduce<ProviderModel | undefined>((best, model) => (
      !best || (model.downloadBytes || 0) > (best.downloadBytes || 0) ? model : best
    ), undefined);
  if (upgrade) return upgrade;
  return preferred?.status === "ready" ? undefined : preferred;
}

export function isBotEngineReady(
  providers: ProviderProbe[],
  selection: IntelligenceSelection | null,
) {
  if (!selection) return false;
  return providers.some((provider) => (
    provider.id === selection.provider
    && provider.canRun
    && provider.models.some((model) => model.id === selection.model && model.status === "ready")
  ));
}

export function selectBotEngine(
  providers: ProviderProbe[],
  channel: BotBuildChannel,
  policy?: BotEnginePolicy,
): IntelligenceSelection | null {
  const allowed = new Set(policy?.allowedProviders || BOT_CAPABILITY_MANIFESTS[channel].providerIds);
  const eligible = botProvidersForChannel(providers, channel)
    .filter((provider) => allowed.has(provider.id));
  if (policy?.mode === "fixed") {
    return isBotEngineReady(eligible, policy.fixedEngine || null)
      ? policy.fixedEngine || null
      : null;
  }
  const engineOrder = policy?.allowMeteredFallback
    ? CONNECTED_AI_ENGINE_ORDER
    : AUTO_ENGINE_ORDER;
  for (const id of engineOrder) {
    const provider = eligible.find((candidate) => candidate.id === id && candidate.canRun);
    if (provider?.family === "api" && !policy?.allowMeteredFallback) continue;
    const model = provider ? preferredProviderModel(provider) : undefined;
    if (provider && model) return { provider: provider.id, model: model.id };
  }
  return null;
}

export interface OnDeviceSetupAction {
  provider: "mlx";
  model: ProviderModel;
  action: ModelManagerAction;
  label: string;
}

export type BotBrowserTargetResult =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "target"; url: string; host: string };

export interface BotBrowserActionRequest {
  url: string;
  host: string;
  action: "click" | "type" | "download";
  target: string;
  targetLabel: string;
  value?: string;
  valueLength: number;
}

export type BotBrowserActionResult =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "action"; request: BotBrowserActionRequest };

const WEB_TARGET = /(?:https?:\/\/[^\s<>"'`]+|(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"'`]*)?|localhost(?::\d+)?(?:\/[^\s<>"'`]*)?)/i;

export function parseBotBrowserTarget(prompt: string): BotBrowserTargetResult {
  const match = prompt.match(WEB_TARGET)?.[0];
  if (!match) return { kind: "none" };
  const candidate = match.replace(/[),.;!?\]}]+$/g, "");
  const value = /^[a-z]+:\/\//i.test(candidate)
    ? candidate
    : `${candidate.startsWith("localhost") ? "http" : "https"}://${candidate}`;
  if (value.length > 2_048) {
    return { kind: "invalid", message: "That website address is too long to inspect safely." };
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (url.username || url.password) {
      return { kind: "invalid", message: "Website addresses cannot contain a username or password." };
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return { kind: "invalid", message: "Use an https:// website. Plain HTTP is allowed only for localhost." };
    }
    if (!host || (!local && (/^\d+(?:\.\d+){3}$/.test(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")))) {
      return { kind: "invalid", message: "Use a public HTTPS domain or an explicit localhost page." };
    }
    url.hash = "";
    return { kind: "target", url: url.toString(), host };
  } catch {
    return { kind: "invalid", message: "Enter a complete website address to inspect." };
  }
}

export function parseBotBrowserAction(prompt: string): BotBrowserActionResult {
  const normalized = prompt
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  if (!/\b(click|press|type|enter|fill|download)\b/i.test(normalized)) return { kind: "none" };
  const page = parseBotBrowserTarget(normalized);
  if (page.kind === "none") return { kind: "none" };
  if (page.kind === "invalid") return page;

  const download = normalized.match(/\bdownload\s+(?:the\s+)?"([^"\n]{1,100})"\s+(?:from|on)\s+/i);
  if (download) {
    const targetLabel = download[1].trim();
    if (!targetLabel) {
      return { kind: "invalid", message: "Name one visible download link or button in quotes." };
    }
    return {
      kind: "action",
      request: {
        url: page.url,
        host: page.host,
        action: "download",
        target: `label:${targetLabel}`,
        targetLabel,
        valueLength: 0,
      },
    };
  }

  const type = normalized.match(/\b(?:type|enter|fill)\s+"([^"\n]{1,2000})"\s+(?:in|into)\s+(?:the\s+)?"([^"\n]{1,100})"/i);
  if (type) {
    const value = type[1];
    const targetLabel = type[2].trim();
    if (!targetLabel) {
      return { kind: "invalid", message: "Name one visible field in quotes." };
    }
    return {
      kind: "action",
      request: {
        url: page.url,
        host: page.host,
        action: "type",
        target: `label:${targetLabel}`,
        targetLabel,
        value,
        valueLength: Array.from(value).length,
      },
    };
  }

  const click = normalized.match(/\b(?:click|press)\s+(?:the\s+)?"([^"\n]{1,100})"/i);
  if (click) {
    const targetLabel = click[1].trim();
    if (!targetLabel) {
      return { kind: "invalid", message: "Name one visible control in quotes." };
    }
    return {
      kind: "action",
      request: {
        url: page.url,
        host: page.host,
        action: "click",
        target: `label:${targetLabel}`,
        targetLabel,
        valueLength: 0,
      },
    };
  }

  return {
    kind: "invalid",
    message: 'Use an exact action such as Click "Pricing" on https://example.com, Type "hello" into "Search" on https://example.com, or Download "Report" from https://example.com.',
  };
}

export function onDeviceSetupAction(
  providers: ProviderProbe[],
  channel: BotBuildChannel,
): OnDeviceSetupAction | null {
  const mlx = botProvidersForChannel(providers, channel).find((provider) => provider.id === "mlx");
  const model = mlx ? preferredOnDeviceSetupModel(mlx) : undefined;
  if (!model) return null;
  if (model.status === "partial") return { provider: "mlx", model, action: "resume", label: "Resume setup" };
  if (model.status === "corrupt") return { provider: "mlx", model, action: "update", label: "Repair on-device" };
  if (model.status === "benchmark-required" || model.status === "incompatible") {
    return { provider: "mlx", model, action: "benchmark", label: "Check this Mac" };
  }
  return { provider: "mlx", model, action: "download", label: "Set up on-device" };
}
