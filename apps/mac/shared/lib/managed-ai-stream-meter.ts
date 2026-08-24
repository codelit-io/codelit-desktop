import type { AIProvider } from "./ai-models";
import { priceForModel } from "./agent-cost-estimator";

export type ManagedAiMeterSource = "provider-cost" | "provider-tokens" | "estimated-tokens";

export interface ManagedAiMeterResult {
  actualUsd: number;
  inputTokens: number;
  outputTokens: number;
  outputChars: number;
  source: ManagedAiMeterSource;
}

interface ManagedAiStreamMeterOptions {
  provider: AIProvider;
  model: string;
  inputChars: number;
  maxOutputTokens: number;
}

interface ProviderUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cost?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumTokenFields(...values: unknown[]): number | undefined {
  let found = false;
  const total = values.reduce<number>((sum, value) => {
    const parsed = finiteNonNegative(value);
    if (parsed === null) return sum;
    found = true;
    return sum + parsed;
  }, 0);
  return found ? total : undefined;
}

function boundedTokenCount(value: unknown, max: number): number | null {
  const parsed = finiteNonNegative(value);
  return parsed === null ? null : Math.min(max, Math.ceil(parsed));
}

function contentChars(data: Record<string, unknown>, provider: AIProvider): number {
  if (provider === "anthropic") {
    const delta = record(data.delta);
    return typeof delta.text === "string" ? delta.text.length : 0;
  }
  if (provider === "gemini") {
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    return candidates.reduce<number>((total, candidate) => {
      const content = record(record(candidate).content);
      const parts = Array.isArray(content.parts) ? content.parts : [];
      return total + parts.reduce<number>((sum, part) => sum + (typeof record(part).text === "string" ? String(record(part).text).length : 0), 0);
    }, 0);
  }
  const choices = Array.isArray(data.choices) ? data.choices : [];
  return choices.reduce<number>((total, choice) => {
    const content = record(record(choice).delta).content;
    if (typeof content === "string") return total + content.length;
    if (!Array.isArray(content)) return total;
    return total + content.reduce<number>((sum, part) => sum + (typeof record(part).text === "string" ? String(record(part).text).length : 0), 0);
  }, 0);
}

function providerUsage(data: Record<string, unknown>, provider: AIProvider): ProviderUsage {
  if (provider === "anthropic") {
    const message = record(data.message);
    const usage = { ...record(message.usage), ...record(data.usage) } as ProviderUsage;
    return {
      ...usage,
      input_tokens: sumTokenFields(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens),
    };
  }
  if (provider === "gemini") {
    const usage = record(data.usageMetadata);
    return {
      input_tokens: usage.promptTokenCount,
      output_tokens: sumTokenFields(usage.candidatesTokenCount, usage.thoughtsTokenCount),
    };
  }
  return record(data.usage) as ProviderUsage;
}

export function createManagedAiStreamMeter(options: ManagedAiStreamMeterOptions) {
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let outputChars = 0;
  let providerInputTokens: number | null = null;
  let providerOutputTokens: number | null = null;
  let providerCostUsd: number | null = null;

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const data = record(JSON.parse(payload));
      outputChars += contentChars(data, options.provider);
      const usage = providerUsage(data, options.provider);
      const inputTokens = boundedTokenCount(usage.prompt_tokens ?? usage.input_tokens, 10_000_000);
      const outputTokens = boundedTokenCount(usage.completion_tokens ?? usage.output_tokens, options.maxOutputTokens);
      const cost = finiteNonNegative(usage.cost);
      if (inputTokens !== null) providerInputTokens = Math.max(providerInputTokens || 0, inputTokens);
      if (outputTokens !== null) providerOutputTokens = Math.max(providerOutputTokens || 0, outputTokens);
      if (cost !== null && cost <= 10) providerCostUsd = Math.max(providerCostUsd || 0, cost);
    } catch {
      // A malformed provider event is passed through to the caller but cannot affect billing.
    }
  }

  function consumeText(text: string) {
    lineBuffer += text;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
  }

  function consume(chunk: Uint8Array) {
    consumeText(decoder.decode(chunk, { stream: true }));
  }

  function finish(): ManagedAiMeterResult {
    consumeText(decoder.decode());
    if (lineBuffer) consumeLine(lineBuffer);
    lineBuffer = "";
    const fallbackInputTokens = Math.ceil(Math.max(0, options.inputChars) / 4);
    const fallbackOutputTokens = Math.min(options.maxOutputTokens, Math.ceil(outputChars / 4));
    const inputTokens = providerInputTokens ?? fallbackInputTokens;
    const outputTokens = providerOutputTokens ?? fallbackOutputTokens;
    const price = priceForModel(options.model);
    const tokenCostUsd = (inputTokens / 1_000_000) * price.inputPerMTok
      + (outputTokens / 1_000_000) * price.outputPerMTok;
    const freeRoute = options.model.trim().toLowerCase() === "openrouter/free" || options.model.trim().toLowerCase().endsWith(":free");
    const actualUsd = freeRoute ? 0 : providerCostUsd ?? tokenCostUsd;
    return {
      actualUsd: Number(Math.min(10, Math.max(0, actualUsd)).toFixed(6)),
      inputTokens,
      outputTokens,
      outputChars,
      source: providerCostUsd !== null
        ? "provider-cost"
        : providerInputTokens !== null || providerOutputTokens !== null
          ? "provider-tokens"
          : "estimated-tokens",
    };
  }

  return { consume, finish };
}

export function createMeteredManagedAiStream(input: ManagedAiStreamMeterOptions & {
  upstream: ReadableStream<Uint8Array>;
  onSettled: (result: ManagedAiMeterResult, outcome: "completed" | "cancelled" | "failed") => Promise<void> | void;
}) {
  const reader = input.upstream.getReader();
  const meter = createManagedAiStreamMeter(input);
  let settled = false;

  async function settle(outcome: "completed" | "cancelled" | "failed") {
    if (settled) return;
    settled = true;
    await input.onSettled(meter.finish(), outcome);
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await settle("completed");
          controller.close();
          return;
        }
        meter.consume(value);
        controller.enqueue(value);
      } catch (error) {
        await settle("failed").catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await settle("cancelled").catch(() => undefined);
    },
  });
}
