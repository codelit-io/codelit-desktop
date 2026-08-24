import type { Message } from "../stores/chat-store";
import {
  getFreeModelIds,
  getProviderConfig,
  getProviderModelId,
  isOpenAICompatibleProvider,
  providerLabel,
  type AIModel,
  type AIProvider,
} from "./ai-models";
import { extractOpenCodeZenStreamText } from "./opencode-zen";

export function buildSystemPrompt(): string {
  return `You are Codelit, an AI system architect. When the user describes a system, product, or asks how something works, you respond with a JSON architecture diagram.

ALWAYS respond with a single JSON object inside a \`\`\`json code block. No other text outside the JSON block.

The JSON must have this exact structure:
{
  "title": "System Name",
  "description": "2-3 sentence overview of the system",
  "nodes": [
    {
      "id": "unique_id",
      "label": "Display Name",
      "type": "frontend|backend|database|queue|cache|external|cdn|service",
      "description": "What this component does and why it exists (2-3 sentences)"
    }
  ],
  "edges": [
    {
      "id": "edge_id",
      "from": "source_node_id",
      "to": "target_node_id",
      "label": "What flows here",
      "protocol": "HTTPS|WebSocket|gRPC|AMQP|TCP|Redis|SQL",
      "dataFlow": "high|medium|low"
    }
  ]
}

Rules:
- Use 6-15 nodes for most systems (enough detail without clutter)
- Every node must have a unique id (use snake_case like "api_gateway", "user_db")
- Every edge must connect valid node ids
- Node types determine visual style: frontend (blue), backend (purple), database (teal), queue (amber), cache (red), external (gray), cdn (green), service (purple)
- dataFlow affects animation speed: high = fast dots, medium = normal, low = slow
- Include realistic protocols on edges
- description on each node should explain what it does, key tech choices, and scaling considerations
- If the user asks a follow-up question about a specific node, respond with JSON containing just that node expanded into its own sub-architecture
- Be opinionated about technology choices`;
}

export function buildChatHistory(messages: Message[]) {
  return messages.map((msg) => ({
    role: msg.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: msg.content }],
  }));
}

type ChatMessage = { role: string; content: string };
type StreamOptions = {
  signal?: AbortSignal;
  managedRun?: { runId: string; maxOutputTokens: number };
};

function buildOpenRouterMessages(prompt: string, history: Message[], skipSystemPrompt = false): ChatMessage[] {
  const messages: { role: string; content: string }[] = [];
  if (!skipSystemPrompt) {
    messages.push({ role: "system", content: buildSystemPrompt() });
  }
  for (const msg of history) {
    messages.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

function getGeminiModelPath(modelId: string) {
  return modelId.startsWith("models/") ? modelId : `models/${modelId}`;
}

function getByokKey(settings: {
  openRouterKey: string;
  openaiKey: string;
  anthropicKey: string;
  geminiKey: string;
  getProviderKey?: (provider: AIProvider) => string;
}, provider: AIProvider) {
  const genericKey = settings.getProviderKey?.(provider);
  if (genericKey) return cleanKey(genericKey);
  if (provider === "openrouter") return cleanKey(settings.openRouterKey);
  if (provider === "openai") return cleanKey(settings.openaiKey);
  if (provider === "anthropic") return cleanKey(settings.anthropicKey);
  if (provider === "gemini") return cleanKey(settings.geminiKey);
  return "";
}

function cleanKey(value: string | undefined) {
  return value?.trim() || "";
}

function getMissingKeyMessage(model: AIModel) {
  const provider = providerLabel(model.provider);
  return `${provider} API key is not configured in BYOK. Add it in Settings > Models and keys > Bring your own API keys before using ${model.name}.`;
}

/** Last-resort free path: Codelit's keyless Kilo Gateway proxy (/api/ai/free).
 * Returns a streaming OpenAI-style SSE response, or null when unavailable. */
async function tryFetchKiloFree(messages: ChatMessage[], skipSystemPrompt?: boolean, options?: StreamOptions): Promise<Response | null> {
  if (typeof window === "undefined") return null;
  try {
    const filteredMessages = skipSystemPrompt ? messages.filter((m) => m.role !== "system") : messages;
    const response = await fetch("/api/ai/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: filteredMessages }),
      signal: options?.signal,
    });
    return response.ok && response.body ? response : null;
  } catch (error) {
    if (isAIAbortError(error)) throw error;
    return null;
  }
}

/** Tell the user we kept them moving on a free model after a failure.
 * Fired from the fallback loops; no-ops server-side. */
function notifyFreeFallback(availableModels: AIModel[], fromName: string, reason: string, fallbackModelId: string) {
  if (typeof window === "undefined") return;
  const fallbackName = availableModels.find((candidate) => candidate.id === fallbackModelId)?.name || fallbackModelId;
  void import("sonner").then(({ toast }) => {
    toast.info(`Switched to ${fallbackName} (free)`, {
      id: "ai-free-fallback",
      description: `${fromName} was unavailable: ${reason.length > 140 ? `${reason.slice(0, 137)}...` : reason}`,
      duration: 7000,
    });
  }).catch(() => {});
}

function extractProviderMessage(raw: string, fallback: string) {
  const text = raw.trim();
  if (!text) return fallback;

  try {
    const parsed = JSON.parse(text) as {
      error?: string | { message?: string };
      message?: string;
      detail?: string;
    };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string" && parsed.error.message.trim()) {
      return parsed.error.message.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
    if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail.trim();
  } catch {
    // Use the raw provider text below.
  }

  return text.length > 280 ? `${text.slice(0, 277).trim()}...` : text;
}

async function formatProviderResponseError(response: Response, provider: AIProvider, modelName: string) {
  const label = providerLabel(provider);
  const raw = await response.text();
  const detail = extractProviderMessage(raw, `${label} API error (${response.status})`);

  if (response.status === 401) {
    return `Invalid ${label} API key. Update it in Settings > Models and keys > Bring your own API keys.`;
  }
  if (response.status === 403) {
    return `${label} API key does not have access to ${modelName}. Check model access or choose another model.`;
  }
  if (response.status === 404) {
    return `${modelName} is not available from ${label}. Refresh models or choose another model. Provider details: ${detail}`;
  }
  if (response.status === 429) {
    return `${label} rate limit reached for ${modelName}. Wait a moment, choose another model, or update your BYOK key.`;
  }

  return `${label} API error (${response.status}) for ${modelName}: ${detail}`;
}

async function formatProxyResponseError(response: Response, provider: AIProvider, modelName: string) {
  const raw = await response.text();
  const detail = extractProviderMessage(raw, `AI proxy error (${response.status})`);
  const label = providerLabel(provider);

  if (/pro subscription required/i.test(detail)) {
    return `Pro subscription required for ${modelName}. Upgrade to Pro or add your ${label} API key in BYOK.`;
  }
  if (/sign in required|session/i.test(detail)) {
    return `${detail}. Sign in again, or add your ${label} API key in BYOK.`;
  }
  if (/server auth|server database/i.test(detail)) {
    return `Codelit Pro routing is temporarily unavailable. Add your ${label} API key in BYOK or choose another model.`;
  }

  return detail;
}

export function isActionableAIErrorMessage(message: string) {
  return /api|key|rate|limit|quota|access|model|provider|routing|credit|billing|payment|insufficient|afford|subscription|401|402|403|404|429/i.test(message);
}

export function getAIErrorMessage(error: unknown, fallback = "AI request failed. Please try again.") {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return fallback;
  if (isActionableAIErrorMessage(message)) return message;
  // Keep the real reason as a breadcrumb instead of hiding it behind the fallback.
  const detail = message.length > 160 ? `${message.slice(0, 157)}...` : message;
  return `${fallback} (${detail})`;
}

export function isAIAbortError(error: unknown) {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && /abort|stopped|cancel/i.test(error.message));
}

function buildGeminiBody(messages: ChatMessage[], skipSystemPrompt?: boolean) {
  const systemMessage = skipSystemPrompt
    ? undefined
    : messages.find((message) => message.role === "system")?.content;

  return {
    ...(systemMessage ? { system_instruction: { parts: [{ text: systemMessage }] } } : {}),
    contents: messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" || message.role === "model" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
    generationConfig: {
      maxOutputTokens: 8192,
    },
  };
}

function extractGeminiText(parsed: unknown) {
  const response = parsed as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  return response.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("") || "";
}

async function* streamSSE(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const content = extractOpenCodeZenStreamText(parsed);
        if (content) yield content;
      } catch { /* skip */ }
    }
  }
}

async function* streamGeminiSSE(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(trimmed.slice(6));
        const content = extractGeminiText(parsed);
        if (content) yield content;
      } catch { /* skip */ }
    }
  }
}

async function tryFetch(model: string, messages: {role: string; content: string}[], key: string, skipSystemPrompt?: boolean, options?: StreamOptions) {
  const filteredMessages = skipSystemPrompt
    ? messages.filter(m => m.role !== "system")
    : messages;

  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "https://codelit.io",
      "X-Title": "Codelit.io",
    },
    body: JSON.stringify({
      model,
      messages: filteredMessages,
      stream: true,
      max_tokens: 8192,
    }),
    signal: options?.signal,
  });
}

async function tryFetchGemini(model: string, messages: ChatMessage[], key: string, skipSystemPrompt?: boolean, options?: StreamOptions) {
  const modelPath = getGeminiModelPath(model);
  return fetch(`https://generativelanguage.googleapis.com/v1beta/${modelPath}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildGeminiBody(messages, skipSystemPrompt)),
    signal: options?.signal,
  });
}

async function tryFetchOpenAICompatible(provider: AIProvider, model: string, messages: ChatMessage[], key: string, skipSystemPrompt?: boolean, options?: StreamOptions) {
  const config = getProviderConfig(provider);
  if (!config.baseUrl) throw new Error(`${config.label} does not support OpenAI-compatible chat completions.`);
  const filteredMessages = skipSystemPrompt
    ? messages.filter(m => m.role !== "system")
    : messages;

  return fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getProviderModelId(provider, model),
      messages: filteredMessages,
      stream: true,
      max_tokens: 8192,
    }),
    signal: options?.signal,
  });
}

function shouldRetryOpenRouterModel(status: number, body: string) {
  if (status === 429 || status === 404 || status === 502 || status === 503 || status === 504) return true;
  return status === 400 && /no endpoints|model.*not.*found|not available/i.test(body);
}

export async function* streamMessage(
  prompt: string,
  history: Message[],
  apiKey?: string,
  skipSystemPrompt?: boolean,
  options?: StreamOptions,
): AsyncGenerator<string> {
  if (options?.signal?.aborted) throw new DOMException("AI request stopped", "AbortError");
  // Import settings store dynamically to avoid circular deps
  const { useSettingsStore } = await import("../stores/settings-store");
  const settings = useSettingsStore.getState();
  const model = settings.getSelectedModel();
  const freeFallbackModels = getFreeModelIds(settings.availableModels);
  const byokKey = getByokKey(settings, model.provider);

  const messages = skipSystemPrompt
    ? buildOpenRouterMessages(prompt, history).filter(m => m.role !== "system")
    : buildOpenRouterMessages(prompt, history);

  // Pro users: route premium models through our server-side proxy
  if (!model.isFree && !apiKey && !byokKey) {
    const { useAuthStore } = await import("../stores/auth-store");
    const user = useAuthStore.getState().user;
    if (user) {
      let proRes: Response | null = null;
      try {
        const idToken = await user.getIdToken();
        proRes = await fetch("/api/ai/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            model: model.id,
            provider: model.provider,
            messages,
            ...(options?.managedRun ? {
              runId: options.managedRun.runId,
              maxOutputTokens: options.managedRun.maxOutputTokens,
            } : {}),
          }),
          signal: options?.signal,
        });
      } catch (error) {
        if (isAIAbortError(error)) throw error;
        // Token refresh or network failure: fall through so BYOK/direct paths can try.
        proRes = null;
      }

      if (proRes && proRes.ok && proRes.body) {
        const reader = proRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") {
              await reader.cancel().catch(() => undefined);
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content
                || parsed.delta?.text // Anthropic format
                || extractGeminiText(parsed)
                || "";
              if (content) yield content;
            } catch { /* skip partial JSON */ }
          }
        }
        return;
      }
      if (proRes) {
        // The proxy answered with an error. Keep the user moving: drop to a
        // free model and say so, instead of dead-ending the generation. The
        // real reason still surfaces (in the switch notice, or thrown when
        // even the free models fail).
        const proxyError = await formatProxyResponseError(proRes, model.provider, model.name);
        const fallbackKey = cleanKey(settings.openRouterKey);
        if (fallbackKey) {
          for (const fallbackModel of freeFallbackModels) {
            try {
              const fallbackRes = await tryFetch(fallbackModel, messages, fallbackKey, skipSystemPrompt, options);
              if (fallbackRes && fallbackRes.ok) {
                console.warn(`[AI] Pro routing failed; fallback succeeded with ${fallbackModel}`);
                notifyFreeFallback(settings.availableModels, model.name, proxyError, fallbackModel);
                yield* streamSSE(fallbackRes);
                return;
              }
            } catch (error) {
              if (isAIAbortError(error)) throw error;
              continue;
            }
          }
        }
        {
          const kiloRes = await tryFetchKiloFree(messages, skipSystemPrompt, options);
          if (kiloRes) {
            console.warn("[AI] Pro routing failed; fallback succeeded via Kilo free gateway");
            notifyFreeFallback(settings.availableModels, model.name, proxyError, "kilo-auto/free");
            yield* streamSSE(kiloRes);
            return;
          }
        }
        throw new Error(proxyError);
      }
    }
  }

  if (model.provider === "opencode-zen") {
    const zenKey = cleanKey(apiKey) || getByokKey(settings, model.provider);
    const response = await fetch("/api/ai/free", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(zenKey ? { "x-codelit-opencode-key": zenKey } : {}),
      },
      body: JSON.stringify({
        model: getProviderModelId(model.provider, model.id),
        messages: skipSystemPrompt ? messages.filter((message) => message.role !== "system") : messages,
      }),
      signal: options?.signal,
    });
    if (!response.ok) throw new Error(await formatProviderResponseError(response, model.provider, model.name));
    yield* streamSSE(response);
    return;
  }

  if (isOpenAICompatibleProvider(model.provider)) {
    // OpenAI-compatible API
    const key = cleanKey(apiKey) || getByokKey(settings, model.provider) || cleanKey(process.env[`NEXT_PUBLIC_${model.provider.toUpperCase()}_API_KEY`]);
    if (!key) throw new Error(getMissingKeyMessage(model));

    const response = await tryFetchOpenAICompatible(model.provider, model.id, messages, key, skipSystemPrompt, options);

    if (!response.ok) {
      const msg = await formatProviderResponseError(response, model.provider, model.name);
      console.warn(`[AI] ${msg}. Falling back to free model.`);
      const fallbackKey = cleanKey(settings.openRouterKey);
      if (fallbackKey) {
        for (const fallbackModel of freeFallbackModels) {
          try {
            const fallbackRes = await tryFetch(fallbackModel, messages, fallbackKey, skipSystemPrompt, options);
            if (fallbackRes && fallbackRes.ok) {
              console.warn(`[AI] Fallback succeeded with ${fallbackModel}`);
              notifyFreeFallback(settings.availableModels, model.name, msg, fallbackModel);
              yield* streamSSE(fallbackRes);
              return;
            }
          } catch (error) {
            if (isAIAbortError(error)) throw error;
            continue;
          }
        }
      }
      {
        const kiloRes = await tryFetchKiloFree(messages, skipSystemPrompt, options);
        if (kiloRes) {
          console.warn("[AI] Fallback succeeded via Kilo free gateway");
          notifyFreeFallback(settings.availableModels, model.name, msg, "kilo-auto/free");
          yield* streamSSE(kiloRes);
          return;
        }
      }
      throw new Error(msg);
    }

    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch { /* skip */ }
      }
    }
    return;
  }

  if (model.provider === "anthropic") {
    const key = cleanKey(apiKey) || cleanKey(settings.anthropicKey) || cleanKey(process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY);
    if (!key) throw new Error(getMissingKeyMessage(model));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 8192,
        system: skipSystemPrompt ? undefined : buildSystemPrompt(),
        messages: messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content })),
        stream: true,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const msg = await formatProviderResponseError(response, "anthropic", model.name);
      console.warn(`[AI] ${msg}. Falling back to free model.`);
      const fallbackKey = cleanKey(settings.openRouterKey);
      if (fallbackKey) {
        for (const fallbackModel of freeFallbackModels) {
          try {
            const fallbackRes = await tryFetch(fallbackModel, messages, fallbackKey, skipSystemPrompt, options);
            if (fallbackRes && fallbackRes.ok) {
              console.warn(`[AI] Fallback succeeded with ${fallbackModel}`);
              notifyFreeFallback(settings.availableModels, model.name, msg, fallbackModel);
              yield* streamSSE(fallbackRes);
              return;
            }
          } catch (error) {
            if (isAIAbortError(error)) throw error;
            continue;
          }
        }
      }
      {
        const kiloRes = await tryFetchKiloFree(messages, skipSystemPrompt, options);
        if (kiloRes) {
          console.warn("[AI] Fallback succeeded via Kilo free gateway");
          notifyFreeFallback(settings.availableModels, model.name, msg, "kilo-auto/free");
          yield* streamSSE(kiloRes);
          return;
        }
      }
      throw new Error(msg);
    }

    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            yield parsed.delta.text;
          }
        } catch { /* skip */ }
      }
    }
    return;
  }

  if (model.provider === "gemini") {
    const key = cleanKey(apiKey) || cleanKey(settings.geminiKey) || cleanKey(process.env.NEXT_PUBLIC_GEMINI_API_KEY) || cleanKey(process.env.NEXT_PUBLIC_GOOGLE_GENERATIVE_AI_API_KEY);
    if (!key) throw new Error(getMissingKeyMessage(model));

    const response = await tryFetchGemini(model.id, messages, key, skipSystemPrompt, options);

    if (!response.ok) {
      const msg = await formatProviderResponseError(response, "gemini", model.name);
      console.warn(`[AI] ${msg}. Falling back to free model.`);
      const fallbackKey = cleanKey(settings.openRouterKey);
      if (fallbackKey) {
        for (const fallbackModel of freeFallbackModels) {
          try {
            const fallbackRes = await tryFetch(fallbackModel, messages, fallbackKey, skipSystemPrompt, options);
            if (fallbackRes && fallbackRes.ok) {
              console.warn(`[AI] Fallback succeeded with ${fallbackModel}`);
              notifyFreeFallback(settings.availableModels, model.name, msg, fallbackModel);
              yield* streamSSE(fallbackRes);
              return;
            }
          } catch (error) {
            if (isAIAbortError(error)) throw error;
            continue;
          }
        }
      }
      {
        const kiloRes = await tryFetchKiloFree(messages, skipSystemPrompt, options);
        if (kiloRes) {
          console.warn("[AI] Fallback succeeded via Kilo free gateway");
          notifyFreeFallback(settings.availableModels, model.name, msg, "kilo-auto/free");
          yield* streamSSE(kiloRes);
          return;
        }
      }
      throw new Error(msg);
    }

    yield* streamGeminiSSE(response);
    return;
  }

  // OpenRouter. Only a key the user supplied themselves is ever used from the
  // browser: a NEXT_PUBLIC_ fallback shipped an sk-or-v1 account key inside
  // the public bundle, extractable by anyone reading the chunk. Keyless
  // visitors on free models go straight to the server-side relay, which is
  // anonymous by design; keyless paid models still require a key.
  const key = cleanKey(apiKey) || cleanKey(settings.openRouterKey);
  if (!key && model.isFree) {
    const kiloRes = await tryFetchKiloFree(messages, skipSystemPrompt, options);
    if (kiloRes) {
      yield* streamSSE(kiloRes);
      return;
    }
    throw new Error(`The free model gateway is unavailable right now. Try again in a moment.`);
  }
  if (!key) throw new Error(getMissingKeyMessage(model));

  let response: Response | null = null;

  if (model.isFree) {
    // Try the selected model first, then fallback to others
    const freeModels = [model.id, ...freeFallbackModels.filter(m => m !== model.id)];
    let lastError = "";
    for (const m of freeModels) {
      response = await tryFetch(m, messages, key, skipSystemPrompt, options);
      if (response.ok) break;
      lastError = await formatProviderResponseError(response, "openrouter", m);
      // A non-retryable failure (e.g. 402 out of credits) hits every free
      // model the same way, so stop looping and let the Kilo fallback take
      // over instead of throwing here.
      if (!shouldRetryOpenRouterModel(response.status, lastError)) break;
    }

    if (response && !response.ok && lastError) {
      // Every OpenRouter free model failed (caps or outage): the keyless Kilo
      // free gateway is the last stop before giving up.
      const kiloRes = await tryFetchKiloFree(messages, skipSystemPrompt, options);
      if (kiloRes) {
        console.warn("[AI] OpenRouter free models exhausted; using Kilo free gateway");
        yield* streamSSE(kiloRes);
        return;
      }
      throw new Error(lastError);
    }
  } else {
    response = await tryFetch(model.id, messages, key, skipSystemPrompt, options);
  }

  if (!response) {
    throw new Error(`OpenRouter did not return a response for ${model.name}. Try again in a moment or choose another model.`);
  }

  if (!response.ok) {
    throw new Error(await formatProviderResponseError(response, "openrouter", model.name));
  }

  if (!response.body) {
    throw new Error(`OpenRouter returned an empty response for ${model.name}. Try again in a moment or choose another model.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch { /* skip */ }
    }
  }
}

/**
 * Stream a prompt and collect the full response. If parsing fails,
 * automatically retry with the next free model (up to maxRetries).
 * Returns the full text response. The caller is responsible for parsing.
 *
 * onChunk is called for each streaming chunk (for UI updates).
 */
export async function streamWithRetry(
  prompt: string,
  onChunk?: (fullText: string) => void,
  maxRetries: number = 3,
  options?: StreamOptions,
): Promise<string> {
  const { useSettingsStore } = await import("../stores/settings-store");
  const settings = useSettingsStore.getState();
  const selectedModel = settings.getSelectedModel();
  const freeFallbackModels = getFreeModelIds(settings.availableModels);

  // Build the retry queue: selected model first, then other free models
  const modelsToTry: string[] = [selectedModel.id];
  if (selectedModel.isFree || selectedModel.provider === "openrouter") {
    for (const m of freeFallbackModels) {
      if (!modelsToTry.includes(m)) modelsToTry.push(m);
      if (modelsToTry.length >= maxRetries + 1) break;
    }
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < Math.min(modelsToTry.length, maxRetries + 1); attempt++) {
    if (options?.signal?.aborted) throw new DOMException("AI request stopped", "AbortError");

    // Temporarily override the selected model for this attempt
    if (attempt > 0) {
      console.warn(`[AI] Retry ${attempt}: switching to ${modelsToTry[attempt]}`);
      settings.setSelectedModelId(modelsToTry[attempt]);
    }

    try {
      let fullResponse = "";
      for await (const chunk of streamMessage(prompt, [], undefined, undefined, options)) {
        fullResponse += chunk;
        onChunk?.(fullResponse);
      }
      if (options?.signal?.aborted) throw new DOMException("AI request stopped", "AbortError");

      // Quick validation: does it look like it contains JSON with nodes?
      if (fullResponse.includes('"nodes"') || fullResponse.includes("'nodes'")) {
        // Restore original model selection
        if (attempt > 0) settings.setSelectedModelId(selectedModel.id);
        return fullResponse;
      }

      // Response doesn't look like valid architecture JSON, retry
      console.warn(`Model ${modelsToTry[attempt]} returned non-JSON response, retrying...`);
      lastError = new Error(`${settings.getSelectedModel().name} did not return a valid architecture response. Try again or choose another model.`);
      continue;
    } catch (err) {
      lastError = err;
      if (isAIAbortError(err)) {
        if (attempt > 0) settings.setSelectedModelId(selectedModel.id);
        throw err;
      }
      console.warn(`Model ${modelsToTry[attempt]} failed:`, err);
      if (attempt === Math.min(modelsToTry.length, maxRetries + 1) - 1) {
        // Last attempt: restore and throw
        if (attempt > 0) settings.setSelectedModelId(selectedModel.id);
        throw err;
      }
      continue;
    }
  }

  // Restore original model
  settings.setSelectedModelId(selectedModel.id);
  // Keep the real reason: a generic "all failed" hides actionable causes (credits, keys, refusals).
  if (lastError instanceof Error && lastError.message) throw lastError;
  throw new Error("All models failed to generate a valid response. Please try again.");
}
