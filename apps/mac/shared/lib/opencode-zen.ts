export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";

export type OpenCodeZenProtocol = "chat-completions" | "responses";

export const OPENCODE_ZEN_FREE_MODELS = [
  { id: "big-pickle", name: "Big Pickle", protocol: "chat-completions" },
  { id: "x-preview-f-free", name: "Ox Alpha Free", protocol: "chat-completions" },
  { id: "mimo-v2.5-free", name: "MiMo-V2.5 Free", protocol: "chat-completions" },
  { id: "hy3-free", name: "Hy3 Free", protocol: "chat-completions" },
  { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", protocol: "chat-completions" },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", protocol: "chat-completions" },
  { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", protocol: "responses" },
] as const satisfies ReadonlyArray<{ id: string; name: string; protocol: OpenCodeZenProtocol }>;

const MODEL_BY_ID = new Map<string, (typeof OPENCODE_ZEN_FREE_MODELS)[number]>(
  OPENCODE_ZEN_FREE_MODELS.map((model) => [model.id, model]),
);

export function openCodeZenModelId(modelId: string) {
  return modelId.startsWith("opencode-zen/") ? modelId.slice("opencode-zen/".length) : modelId;
}

export function getOpenCodeZenFreeModel(modelId: string) {
  return MODEL_BY_ID.get(openCodeZenModelId(modelId));
}

export function isOpenCodeZenFreeModel(modelId: string) {
  return Boolean(getOpenCodeZenFreeModel(modelId));
}

export function openCodeZenEndpoint(modelId: string) {
  const model = getOpenCodeZenFreeModel(modelId);
  if (!model) return null;
  return `${OPENCODE_ZEN_BASE_URL}/${model.protocol === "responses" ? "responses" : "chat/completions"}`;
}

export type OpenCodeZenMessage = { role: string; content: string };

export function buildOpenCodeZenBody(
  modelId: string,
  messages: OpenCodeZenMessage[],
  options: { maxTokens: number; stream: boolean; temperature?: number },
) {
  const model = getOpenCodeZenFreeModel(modelId);
  if (!model) return null;

  if (model.protocol === "responses") {
    return {
      model: model.id,
      input: messages,
      max_output_tokens: options.maxTokens,
      stream: options.stream,
    };
  }

  return {
    model: model.id,
    messages,
    max_tokens: options.maxTokens,
    stream: options.stream,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
}

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

export function extractOpenCodeZenStreamText(value: unknown) {
  const root = object(value);
  if (!root) return "";
  if (root.type === "response.output_text.delta" && typeof root.delta === "string") return root.delta;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = object(choices[0]);
  const delta = object(choice?.delta);
  return typeof delta?.content === "string" ? delta.content : "";
}

export function extractOpenCodeZenText(value: unknown) {
  const root = object(value);
  if (!root) return "";
  if (typeof root.output_text === "string") return root.output_text;

  const choices = Array.isArray(root.choices) ? root.choices : [];
  const message = object(object(choices[0])?.message);
  if (typeof message?.content === "string") return message.content;

  const output = Array.isArray(root.output) ? root.output : [];
  return output.flatMap((item) => {
    const content = object(item)?.content;
    return Array.isArray(content) ? content : [];
  }).map((item) => {
    const content = object(item);
    return typeof content?.text === "string" ? content.text : "";
  }).join("");
}
