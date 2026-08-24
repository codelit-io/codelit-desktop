export type AIProvider =
  | "openrouter"
  | "opencode-zen"
  | "openai"
  | "anthropic"
  | "gemini"
  | "xai"
  | "mistral"
  | "groq"
  | "perplexity"
  | "together"
  | "deepseek"
  | "cerebras";

export interface AIModel {
  id: string;
  name: string;
  provider: AIProvider;
  description: string;
  isFree: boolean;
  created?: number;
  contextLength?: number;
  source?: "fallback" | "live";
  /** The server has a Codelit-funded credential for this exact provider route. */
  managedAccess?: boolean;
}

export const DEFAULT_MODEL_ID = "openrouter/free";

export type ProviderProtocol = "openai-compatible" | "anthropic" | "gemini" | "openrouter" | "opencode-zen";

export interface AIProviderConfig {
  id: AIProvider;
  label: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  keyUrl: string;
  placeholder: string;
  envKeys: string[];
  description: string;
}

export const AI_PROVIDER_CONFIGS: AIProviderConfig[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-v1-...",
    // Server-side names only. NEXT_PUBLIC_OPENROUTER_API_KEY used to be the
    // last fallback here, which meant the server could quietly depend on an
    // env var whose entire value ships inside the client bundle — the leak
    // found on 2026-07-27 (an sk-or-v1 account key in a public chunk). A
    // NEXT_PUBLIC_ name must never appear in this list.
    envKeys: ["OPENROUTER_API_KEY", "OPENROUTER_PRO_KEY"],
    description: "Router and free/open model fallback",
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    protocol: "opencode-zen",
    baseUrl: "https://opencode.ai/zen/v1",
    keyUrl: "https://opencode.ai/auth",
    placeholder: "OpenCode Zen API key",
    envKeys: ["OPENCODE_ZEN_API_KEY"],
    description: "Free coding models via OpenCode Zen",
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-...",
    envKeys: ["OPENAI_API_KEY", "OPENAI_PRO_KEY"],
    description: "GPT and reasoning models",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-...",
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_PRO_KEY"],
    description: "Claude models",
  },
  {
    id: "gemini",
    label: "Gemini",
    protocol: "gemini",
    keyUrl: "https://aistudio.google.com/app/apikey",
    placeholder: "AIza...",
    envKeys: ["GEMINI_API_KEY", "GEMINI_PRO_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    description: "Google Gemini models",
  },
  {
    id: "xai",
    label: "xAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai/team/api-keys",
    placeholder: "xai-...",
    envKeys: ["XAI_API_KEY", "XAI_PRO_KEY"],
    description: "Grok models",
  },
  {
    id: "mistral",
    label: "Mistral",
    protocol: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    placeholder: "Mistral API key",
    envKeys: ["MISTRAL_API_KEY", "MISTRAL_PRO_KEY"],
    description: "Mistral and Codestral models",
  },
  {
    id: "groq",
    label: "Groq",
    protocol: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    placeholder: "gsk_...",
    envKeys: ["GROQ_API_KEY", "GROQ_PRO_KEY"],
    description: "Fast open-model inference",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    protocol: "openai-compatible",
    baseUrl: "https://api.perplexity.ai",
    keyUrl: "https://www.perplexity.ai/settings/api",
    placeholder: "pplx-...",
    envKeys: ["PERPLEXITY_API_KEY", "PERPLEXITY_PRO_KEY"],
    description: "Sonar search-grounded models",
  },
  {
    id: "together",
    label: "Together",
    protocol: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.xyz/settings/api-keys",
    placeholder: "Together API key",
    envKeys: ["TOGETHER_API_KEY", "TOGETHER_PRO_KEY"],
    description: "Open-weight model hosting",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-...",
    envKeys: ["DEEPSEEK_API_KEY", "DEEPSEEK_PRO_KEY"],
    description: "DeepSeek coding and reasoning models",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    protocol: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    keyUrl: "https://cloud.cerebras.ai/platform",
    placeholder: "csk-...",
    envKeys: ["CEREBRAS_API_KEY", "CEREBRAS_PRO_KEY"],
    description: "High-speed open-model inference",
  },
];

export const AI_PROVIDERS = AI_PROVIDER_CONFIGS.map((provider) => provider.id);
export const PROVIDER_LABELS = Object.fromEntries(
  AI_PROVIDER_CONFIGS.map((provider) => [provider.id, provider.label]),
) as Record<AIProvider, string>;

export function getProviderConfig(provider: AIProvider) {
  return AI_PROVIDER_CONFIGS.find((item) => item.id === provider) || AI_PROVIDER_CONFIGS[0];
}

export function isProvider(value: string | null | undefined): value is AIProvider {
  return AI_PROVIDERS.includes(value as AIProvider);
}

export function isOpenAICompatibleProvider(provider: AIProvider) {
  return getProviderConfig(provider).protocol === "openai-compatible";
}

export function providerLabel(provider: AIProvider) {
  return PROVIDER_LABELS[provider] || "AI provider";
}

export function getProviderModelId(provider: AIProvider, modelId: string) {
  if (provider === "openrouter" || provider === "openai" || provider === "anthropic" || provider === "gemini") {
    return modelId;
  }

  const prefix = `${provider}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

const KNOWN_UNAVAILABLE_MODEL_IDS = new Set([
  // OpenRouter currently exposes StepFun as a paid model without the :free
  // alias. Keeping this old alias in local storage causes "No endpoints found".
  "stepfun/step-3.5-flash:free",
  "deepseek/deepseek-chat-v3-0324:free",
  "deepseek/deepseek-r1:free",
  "meta-llama/llama-4-maverick:free",
  "meta-llama/llama-4-scout:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "google/gemma-3-27b-it:free",
  "google/gemma-3n-e4b-it:free",
  "arcee-ai/trinity-large-preview:free",
]);

export const FALLBACK_MODELS: AIModel[] = [
  // OpenRouter free fallback catalog. Live discovery replaces this at runtime.
  { id: "openrouter/free", name: "OpenRouter Free Router", provider: "openrouter", description: "Auto-routes to available free models", isFree: true, source: "fallback" },
  { id: "deepseek/deepseek-v4-flash:free", name: "DeepSeek V4 Flash", provider: "openrouter", description: "Fast free reasoning · ~10-20s", isFree: true, source: "fallback" },
  { id: "baidu/cobuddy:free", name: "CoBuddy", provider: "openrouter", description: "Code generation · free", isFree: true, source: "fallback" },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron Nano Omni", provider: "openrouter", description: "NVIDIA multimodal reasoning · free", isFree: true, source: "fallback" },
  { id: "poolside/laguna-xs.2:free", name: "Laguna XS.2", provider: "openrouter", description: "Coding agent · free", isFree: true, source: "fallback" },
  { id: "qwen/qwen3-coder:free", name: "Qwen 3 Coder", provider: "openrouter", description: "Code-optimized · ~10-20s", isFree: true, source: "fallback" },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron Super 120B", provider: "openrouter", description: "NVIDIA 120B · ~15-30s", isFree: true, source: "fallback" },
  { id: "openai/gpt-oss-120b:free", name: "GPT-OSS 120B", provider: "openrouter", description: "OpenAI open-weight · ~10-20s", isFree: true, source: "fallback" },
  { id: "openai/gpt-oss-20b:free", name: "GPT-OSS 20B", provider: "openrouter", description: "OpenAI open-weight · fast", isFree: true, source: "fallback" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B", provider: "openrouter", description: "Meta instruct · free", isFree: true, source: "fallback" },
  { id: "z-ai/glm-4.5-air:free", name: "GLM 4.5 Air", provider: "openrouter", description: "Z.ai instruct · free", isFree: true, source: "fallback" },
  { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", provider: "openrouter", description: "Google · free", isFree: true, source: "fallback" },
  { id: "arcee-ai/trinity-large-thinking:free", name: "Trinity Large Thinking", provider: "openrouter", description: "Arcee reasoning · free", isFree: true, source: "fallback" },
  // OpenCode Zen's documented free catalog. These endpoints can rotate, so
  // live discovery keeps the selector current while this fallback keeps it useful.
  { id: "opencode-zen/big-pickle", name: "Big Pickle", provider: "opencode-zen", description: "Free via OpenCode Zen · limited-time model", isFree: true, source: "fallback" },
  { id: "opencode-zen/x-preview-f-free", name: "Ox Alpha Free", provider: "opencode-zen", description: "Free via OpenCode Zen · zero-retention provider", isFree: true, source: "fallback" },
  { id: "opencode-zen/mimo-v2.5-free", name: "MiMo-V2.5 Free", provider: "opencode-zen", description: "Free via OpenCode Zen · limited-time model", isFree: true, source: "fallback" },
  { id: "opencode-zen/hy3-free", name: "Hy3 Free", provider: "opencode-zen", description: "Free via OpenCode Zen · limited-time model", isFree: true, source: "fallback" },
  { id: "opencode-zen/nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", provider: "opencode-zen", description: "Free via OpenCode Zen · trial endpoint", isFree: true, source: "fallback" },
  { id: "opencode-zen/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", provider: "opencode-zen", description: "Free via OpenCode Zen · trial endpoint", isFree: true, source: "fallback" },
  { id: "opencode-zen/muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", provider: "opencode-zen", description: "Free via OpenCode Zen · contributor endpoint", isFree: true, source: "fallback" },
  // OpenAI fallback catalog. Live discovery uses the provider's /v1/models endpoint.
  { id: "gpt-5", name: "GPT-5", provider: "openai", description: "Most powerful · ~8-15s", isFree: false, source: "fallback" },
  { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai", description: "Fast & capable · ~4-8s", isFree: false, source: "fallback" },
  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai", description: "Best value · ~5-10s", isFree: false, source: "fallback" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai", description: "Fast & affordable · ~3-8s", isFree: false, source: "fallback" },
  { id: "o3-mini", name: "o3-mini", provider: "openai", description: "Deep reasoning · ~10-30s", isFree: false, source: "fallback" },
  // Anthropic fallback catalog. Live discovery uses the provider's /v1/models endpoint.
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic", description: "Most capable · ~8-15s", isFree: false, source: "fallback" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", description: "Best balance · ~5-12s", isFree: false, source: "fallback" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic", description: "Fast & cheap · ~3-8s", isFree: false, source: "fallback" },
  // Gemini fallback catalog. Live discovery uses Google's models.list endpoint.
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini", description: "Google Gemini · Pro reasoning", isFree: false, source: "fallback" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini", description: "Google Gemini · Fast multimodal", isFree: false, source: "fallback" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "gemini", description: "Google Gemini · Fast generation", isFree: false, source: "fallback" },
  // Additional BYOK providers. Live discovery replaces these once the user adds a key.
  { id: "xai/grok-4.3", name: "Grok 4.3", provider: "xai", description: "xAI · flagship reasoning and tool use", isFree: false, source: "fallback" },
  { id: "xai/grok-build-0.1", name: "Grok Build 0.1", provider: "xai", description: "xAI · coding-focused agent model", isFree: false, source: "fallback" },
  { id: "mistral/mistral-large-latest", name: "Mistral Large", provider: "mistral", description: "Mistral · flagship model", isFree: false, source: "fallback" },
  { id: "mistral/mistral-small-latest", name: "Mistral Small", provider: "mistral", description: "Mistral · fast general model", isFree: false, source: "fallback" },
  { id: "mistral/codestral-latest", name: "Codestral", provider: "mistral", description: "Mistral · code generation", isFree: false, source: "fallback" },
  { id: "groq/llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile", provider: "groq", description: "Groq · fast open model", isFree: false, source: "fallback" },
  { id: "groq/openai/gpt-oss-120b", name: "GPT OSS 120B", provider: "groq", description: "Groq · OpenAI open-weight model", isFree: false, source: "fallback" },
  { id: "perplexity/sonar-pro", name: "Sonar Pro", provider: "perplexity", description: "Perplexity · search-grounded answers", isFree: false, source: "fallback" },
  { id: "perplexity/sonar", name: "Sonar", provider: "perplexity", description: "Perplexity · fast search-grounded answers", isFree: false, source: "fallback" },
  { id: "perplexity/sonar-reasoning-pro", name: "Sonar Reasoning Pro", provider: "perplexity", description: "Perplexity · search with reasoning", isFree: false, source: "fallback" },
  { id: "together/meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Turbo", provider: "together", description: "Together · open model hosting", isFree: false, source: "fallback" },
  { id: "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", name: "Qwen3 Coder 480B", provider: "together", description: "Together · coding model", isFree: false, source: "fallback" },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek", description: "DeepSeek · fast coding and reasoning", isFree: false, source: "fallback" },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek", description: "DeepSeek · higher capability", isFree: false, source: "fallback" },
  { id: "cerebras/gpt-oss-120b", name: "GPT OSS 120B", provider: "cerebras", description: "Cerebras · high-speed inference", isFree: false, source: "fallback" },
  { id: "cerebras/qwen-3-235b-a22b-instruct-2507", name: "Qwen 3 235B", provider: "cerebras", description: "Cerebras · open reasoning model", isFree: false, source: "fallback" },
];

export const AVAILABLE_MODELS = FALLBACK_MODELS;

const FALLBACK_ORDER = new Map(FALLBACK_MODELS.map((model, index) => [model.id, index]));
const PROVIDER_ORDER = Object.fromEntries(AI_PROVIDERS.map((provider, index) => [provider, index])) as Record<AIProvider, number>;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getDataArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return asArray(asObject(raw)?.data);
}

function compactText(value: string | undefined, maxLength = 84) {
  if (!value) return undefined;
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1).trim()}...` : singleLine;
}

function formatContextWindow(contextLength?: number) {
  if (!contextLength) return undefined;
  if (contextLength >= 1_000_000) return `${Math.round(contextLength / 1_000_000)}M context`;
  if (contextLength >= 1_000) return `${Math.round(contextLength / 1_000)}K context`;
  return `${contextLength} context`;
}

function formatCreated(created?: number) {
  if (!created) return undefined;
  const date = new Date(created * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function normalizeDisplayName(id: string) {
  const raw = id
    .split("/")
    .pop()
    ?.replace(/:free$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/_/g, "-") || id;

  return raw
    .split("-")
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "api") return "API";
      if (lower === "oss") return "OSS";
      if (lower === "ui") return "UI";
      if (lower === "llm") return "LLM";
      if (/^o\d/.test(lower)) return lower;
      if (/^\d/.test(lower)) return part.toUpperCase();
      if (index === 0 && lower === "claude") return "Claude";
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function isTextOutputModel(model: JsonObject) {
  const architecture = asObject(model.architecture);
  const outputs = asArray(architecture?.output_modalities).map((item) => asString(item)).filter(Boolean);
  return outputs.length === 0 || outputs.includes("text");
}

export function isKnownUnavailableModelId(modelId: string) {
  return KNOWN_UNAVAILABLE_MODEL_IDS.has(modelId);
}

function isFreeOpenRouterModel(id: string, model?: JsonObject) {
  if (id.endsWith(":free") || id === "openrouter/free") return true;
  if (!id.startsWith("openrouter/")) return false;

  const pricing = asObject(model?.pricing);
  return pricing?.prompt === "0" && pricing?.completion === "0";
}

function openRouterDescription(model: JsonObject, contextLength?: number) {
  const id = asString(model.id) || "";
  const upstreamProvider = id.includes("/") ? id.split("/")[0] : "";
  const context = formatContextWindow(contextLength);
  const providerLabel = upstreamProvider === "openai"
    ? "OpenAI"
    : upstreamProvider === "anthropic"
      ? "Anthropic"
      : normalizeDisplayName(upstreamProvider);
  const prefix = id.endsWith(":free")
    ? "Free via OpenRouter"
    : upstreamProvider
      ? `${providerLabel} via OpenRouter`
      : "Via OpenRouter";
  return context ? `${prefix} · ${context}` : compactText(asString(model.description)) || prefix;
}

function shouldIncludeOpenRouterModel(id: string, model?: JsonObject) {
  if (isKnownUnavailableModelId(id)) return false;
  if (isFreeOpenRouterModel(id, model)) return true;
  if (id.startsWith("~")) return false;

  const lower = id.toLowerCase();
  if (!/^(openai|anthropic|google)\//.test(lower)) return false;
  if (lower.startsWith("google/") && !lower.startsWith("google/gemini")) return false;
  return ![
    "audio",
    "codex",
    "deep-research",
    "image",
    "realtime",
    "search",
    "sora",
    "transcribe",
    "tts",
    "whisper",
  ].some((blocked) => lower.includes(blocked));
}

export function normalizeOpenRouterModels(raw: unknown): AIModel[] {
  const models = getDataArray(raw)
    .map((entry): AIModel | null => {
      const model = asObject(entry);
      if (!model) return null;

      const id = asString(model.id);
      if (!id || !shouldIncludeOpenRouterModel(id, model) || !isTextOutputModel(model)) return null;

      const topProvider = asObject(model.top_provider);
      const contextLength = asNumber(model.context_length) || asNumber(topProvider?.context_length);
      return {
        id,
        name: asString(model.name) || normalizeDisplayName(id),
        provider: "openrouter" as const,
        description: openRouterDescription(model, contextLength),
        isFree: isFreeOpenRouterModel(id, model),
        created: asNumber(model.created),
        contextLength,
        source: "live" as const,
      };
    })
    .filter((model): model is AIModel => model !== null);

  return sortModelCatalog(dedupeModels(models));
}

const OPENAI_MODEL_EXCLUDES = [
  "audio",
  "babbage",
  "chatgpt",
  "codex",
  "computer-use",
  "dall-e",
  "davinci",
  "deep-research",
  "embedding",
  "image",
  "instruct",
  "moderation",
  "realtime",
  "search",
  "sora",
  "transcribe",
  "tts",
  "whisper",
];

function isLikelyOpenAIChatModel(id: string) {
  const lower = id.toLowerCase();
  if (!/^(gpt-|o\d)/.test(lower)) return false;
  return !OPENAI_MODEL_EXCLUDES.some((blocked) => lower.includes(blocked));
}

export function normalizeOpenAIModels(raw: unknown): AIModel[] {
  const models = getDataArray(raw)
    .map((entry): AIModel | null => {
      const model = asObject(entry);
      const id = asString(model?.id);
      if (!id || !isLikelyOpenAIChatModel(id)) return null;
      const created = asNumber(model?.created);
      const released = formatCreated(created);
      return {
        id,
        name: normalizeDisplayName(id),
        provider: "openai" as const,
        description: released ? `OpenAI · ${released}` : "OpenAI model",
        isFree: false,
        created,
        source: "live" as const,
      };
    })
    .filter((model): model is AIModel => model !== null);

  return sortModelCatalog(dedupeModels(models)).slice(0, 24);
}

const GENERIC_MODEL_EXCLUDES = [
  "audio",
  "babbage",
  "chatgpt",
  "codex-mini",
  "computer-use",
  "dall-e",
  "davinci",
  "embedding",
  "image",
  "moderation",
  "realtime",
  "rerank",
  "search-preview",
  "sora",
  "speech",
  "transcribe",
  "tts",
  "whisper",
];

function isLikelyTextGenerationModel(id: string) {
  const lower = id.toLowerCase();
  return !GENERIC_MODEL_EXCLUDES.some((blocked) => lower.includes(blocked));
}

export function normalizeOpenAICompatibleModels(raw: unknown, provider: AIProvider): AIModel[] {
  const config = getProviderConfig(provider);
  const models = getDataArray(raw)
    .map((entry): AIModel | null => {
      const model = asObject(entry);
      const rawId = asString(model?.id);
      if (!rawId || !isLikelyTextGenerationModel(rawId)) return null;
      const id = provider === "openai" ? rawId : `${provider}/${rawId}`;

      const created = asNumber(model?.created);
      const released = formatCreated(created);
      const contextLength = asNumber(model?.context_length) || asNumber(model?.contextLength) || asNumber(model?.max_context_length);
      const context = formatContextWindow(contextLength);
      const description = context || released
        ? `${config.label} · ${[context, released].filter(Boolean).join(" · ")}`
        : `${config.label} model`;

      return {
        id,
        name: asString(model?.display_name) || asString(model?.name) || normalizeDisplayName(rawId),
        provider,
        description,
        isFree: false,
        created,
        contextLength,
        source: "live" as const,
      };
    })
    .filter((model): model is AIModel => model !== null);

  return sortModelCatalog(dedupeModels(models)).slice(0, 24);
}

export function normalizeOpenCodeZenModels(raw: unknown): AIModel[] {
  const available = new Set(getDataArray(raw).map((entry) => asString(asObject(entry)?.id)).filter(Boolean));
  return FALLBACK_MODELS
    .filter((model) => model.provider === "opencode-zen" && available.has(getProviderModelId("opencode-zen", model.id)))
    .map((model) => ({ ...model, source: "live" as const }));
}

export function normalizeAnthropicModels(raw: unknown): AIModel[] {
  const models = getDataArray(raw)
    .map((entry): AIModel | null => {
      const model = asObject(entry);
      const id = asString(model?.id);
      if (!id || !id.startsWith("claude-")) return null;
      const createdAt = asString(model?.created_at);
      const created = createdAt ? Date.parse(createdAt) / 1000 : undefined;
      const released = formatCreated(created);
      return {
        id,
        name: asString(model?.display_name) || normalizeDisplayName(id),
        provider: "anthropic" as const,
        description: released ? `Anthropic · ${released}` : "Anthropic model",
        isFree: false,
        created: Number.isFinite(created) ? created : undefined,
        source: "live" as const,
      };
    })
    .filter((model): model is AIModel => model !== null);

  return sortModelCatalog(dedupeModels(models)).slice(0, 24);
}

export function normalizeGeminiModels(raw: unknown): AIModel[] {
  const models = getDataArray(raw)
    .map((entry): AIModel | null => {
      const model = asObject(entry);
      if (!model) return null;

      const name = asString(model.name);
      const id = name?.replace(/^models\//, "");
      if (!id || !id.startsWith("gemini-")) return null;

      const methods = asArray(model.supportedGenerationMethods).map((item) => asString(item)).filter(Boolean);
      if (methods.length && !methods.includes("generateContent")) return null;

      const contextLength = asNumber(model.inputTokenLimit);
      const context = formatContextWindow(contextLength);
      return {
        id,
        name: asString(model.displayName) || normalizeDisplayName(id),
        provider: "gemini" as const,
        description: context ? `Google Gemini · ${context}` : compactText(asString(model.description)) || "Google Gemini model",
        isFree: false,
        contextLength,
        source: "live" as const,
      };
    })
    .filter((model): model is AIModel => model !== null);

  return sortModelCatalog(dedupeModels(models)).slice(0, 24);
}

export function dedupeModels(models: AIModel[]) {
  const byId = new Map<string, AIModel>();
  for (const model of models) {
    if (isKnownUnavailableModelId(model.id)) continue;
    const existing = byId.get(model.id);
    if (!existing || existing.source === "fallback") {
      byId.set(model.id, model);
    }
  }
  return Array.from(byId.values());
}

export function sortModelCatalog(models: AIModel[]) {
  return [...models].sort((a, b) => {
    const providerRank = PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider];
    if (providerRank !== 0) return providerRank;

    if (a.created && b.created && a.created !== b.created) return b.created - a.created;
    if (a.created && !b.created) return -1;
    if (!a.created && b.created) return 1;

    const aFallbackOrder = FALLBACK_ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bFallbackOrder = FALLBACK_ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (aFallbackOrder !== bFallbackOrder) return aFallbackOrder - bFallbackOrder;

    return a.name.localeCompare(b.name);
  });
}

export function mergeModelCatalogs(...catalogs: AIModel[][]) {
  return sortModelCatalog(dedupeModels(catalogs.flat()));
}

export function replaceProviderModels(existing: AIModel[], provider: AIProvider, models: AIModel[]) {
  const nextProviderModels = models.length
    ? models
    : FALLBACK_MODELS.filter((model) => model.provider === provider);

  return mergeModelCatalogs(
    existing.filter((model) => model.provider !== provider),
    nextProviderModels,
  );
}

export function getFreeModelIds(models: AIModel[] = FALLBACK_MODELS) {
  const ids = models
    .filter((model) => model.provider === "openrouter" && model.isFree && !isKnownUnavailableModelId(model.id))
    .map((model) => model.id);
  return ids.length ? ids : FALLBACK_MODELS.filter((model) => model.isFree && !isKnownUnavailableModelId(model.id)).map((model) => model.id);
}

export function getModelById(models: AIModel[], id: string) {
  const usableModels = models.filter((model) => !isKnownUnavailableModelId(model.id));
  return usableModels.find((model) => model.id === id)
    || FALLBACK_MODELS.find((model) => model.id === id)
    || usableModels[0]
    || FALLBACK_MODELS[0];
}

export function inferProviderFromModelId(modelId: string): AIProvider {
  const namespace = modelId.split("/")[0];
  if (["opencode-zen", "xai", "mistral", "groq", "perplexity", "together", "deepseek", "cerebras"].includes(namespace)) return namespace as AIProvider;
  if (modelId.startsWith("grok-")) return "xai";
  if (modelId.startsWith("gemini-") || modelId.startsWith("models/gemini-")) return "gemini";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("mistral-") || modelId.startsWith("codestral-") || modelId.startsWith("open-mistral-")) return "mistral";
  if (modelId.startsWith("sonar")) return "perplexity";
  if (modelId.startsWith("deepseek-")) return "deepseek";
  if (modelId.startsWith("llama-") || modelId.startsWith("llama3") || modelId.startsWith("qwen-") || modelId.startsWith("zai-")) return "cerebras";
  if (modelId.includes("/") || modelId.endsWith(":free")) return "openrouter";
  if (isLikelyOpenAIChatModel(modelId)) return "openai";
  return "openrouter";
}
