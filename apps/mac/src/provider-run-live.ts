import type { ProviderRunEvent, ProviderTaskResult } from "./contracts";

const MAX_LIVE_REASONING_CHARS = 4_000;

export const PROVIDER_FINAL_OUTPUT_LIMITS = {
  summaryBytes: 2_800,
  itemCount: 3,
  itemBytes: 350,
  answerBytes: 4_000,
} as const;

const MAX_LIVE_ANSWER_CHARS = PROVIDER_FINAL_OUTPUT_LIMITS.answerBytes;
const textEncoder = new TextEncoder();

export interface ProviderStructuredOutput {
  summary: string;
  items: string[];
}

export type ProviderLivePhase = "idle" | "thinking" | "answering" | "complete" | "failed";

export interface ProviderLiveState {
  runId: string | null;
  phase: ProviderLivePhase;
  status: string;
  reasoning: string;
  answer: string;
}

export type FinalAnswerReconciliation =
  | { mode: "settled" }
  | { mode: "append"; suffix: string }
  | { mode: "replace"; answer: string };

export function emptyProviderLiveState(runId: string | null = null): ProviderLiveState {
  return {
    runId,
    phase: runId ? "thinking" : "idle",
    status: runId ? "Starting locally" : "",
    reasoning: "",
    answer: "",
  };
}

function appendBounded(current: string, delta: string, limit: number) {
  if (!delta || current.length >= limit) return current;
  return `${current}${delta.slice(0, limit - current.length)}`;
}

export function utf8ByteLength(value: string) {
  return textEncoder.encode(value).length;
}

function utf8Prefix(value: string, maxBytes: number) {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const codePoint of value) {
    const nextBytes = utf8ByteLength(codePoint);
    if (bytes + nextBytes > maxBytes) break;
    result += codePoint;
    bytes += nextBytes;
  }
  return result;
}

export function formatProviderFinalAnswer(output: ProviderStructuredOutput) {
  const summary = utf8Prefix(output.summary.trim(), PROVIDER_FINAL_OUTPUT_LIMITS.summaryBytes).trimEnd();
  if (!summary) return "";
  const lines = [summary];
  for (const rawItem of output.items.slice(0, PROVIDER_FINAL_OUTPUT_LIMITS.itemCount)) {
    const item = utf8Prefix(rawItem.trim(), PROVIDER_FINAL_OUTPUT_LIMITS.itemBytes).trimEnd();
    if (!item) continue;
    const candidate = [...lines, `- ${item}`].join("\n");
    if (utf8ByteLength(candidate) > PROVIDER_FINAL_OUTPUT_LIMITS.answerBytes) break;
    lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

export function resolveAutoStartFinalAnswer(answer: string) {
  const value = answer.trim();
  return /^(?:answer:\s*)?(?:none|n\/a)\.?$/i.test(value)
    ? "What should I work on first?"
    : value;
}

export function providerRunReceiptSummary(
  result: Pick<ProviderTaskResult, "structuredOutput" | "text">,
  summaryOverride?: string,
) {
  if (summaryOverride?.trim()) return summaryOverride;
  return result.structuredOutput?.summary || result.text;
}

export function canContinueProviderReveal(
  runId: string,
  state: ProviderLiveState,
  canceled: boolean,
) {
  return !canceled && state.runId === runId;
}

export function finalAnswerReconciliation(
  visibleAnswer: string,
  finalAnswer: string,
): FinalAnswerReconciliation {
  if (visibleAnswer === finalAnswer) return { mode: "settled" };
  if (finalAnswer.startsWith(visibleAnswer)) {
    return { mode: "append", suffix: finalAnswer.slice(visibleAnswer.length) };
  }
  return { mode: "replace", answer: finalAnswer };
}

function boundedStatus(message: string) {
  const normalized = message.trim();
  if (normalized.startsWith("{") || normalized.startsWith("[") || /^```(?:json)?/i.test(normalized)) {
    return "Building answer";
  }
  return normalized.slice(0, 500);
}

export function reduceProviderLiveState(
  state: ProviderLiveState,
  event: ProviderRunEvent,
): ProviderLiveState {
  if (state.runId && state.runId !== event.runId) return state;
  const current = state.runId ? state : emptyProviderLiveState(event.runId);

  if (event.eventType === "reasoning-delta") {
    return {
      ...current,
      phase: current.answer ? "answering" : "thinking",
      status: current.answer ? current.status : "Thinking",
      reasoning: appendBounded(current.reasoning, event.message, MAX_LIVE_REASONING_CHARS),
    };
  }
  if (event.eventType === "output-delta") {
    return {
      ...current,
      phase: "answering",
      status: "Writing answer",
      answer: appendBounded(current.answer, event.message, MAX_LIVE_ANSWER_CHARS),
    };
  }
  if (event.eventType === "completed") {
    return {
      ...current,
      phase: "complete",
      status: "Finished",
    };
  }
  if (event.eventType === "failed" || event.eventType === "canceled") {
    return {
      ...current,
      phase: "failed",
      status: boundedStatus(event.message),
    };
  }
  return {
    ...current,
    phase: current.answer ? "answering" : "thinking",
    status: boundedStatus(event.message),
  };
}

export function isTransientProviderRunEvent(event: ProviderRunEvent) {
  return event.eventType === "reasoning-delta" || event.eventType === "output-delta";
}

export function recordableProviderRunEvents(events: ProviderRunEvent[]) {
  return events.filter((event) => !isTransientProviderRunEvent(event));
}
