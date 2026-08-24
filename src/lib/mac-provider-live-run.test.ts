import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProviderRunEvent, ProviderRunEventType } from "../../apps/mac/src/contracts";
import {
  canContinueProviderReveal,
  emptyProviderLiveState,
  finalAnswerReconciliation,
  formatProviderFinalAnswer,
  providerRunReceiptSummary,
  PROVIDER_FINAL_OUTPUT_LIMITS,
  recordableProviderRunEvents,
  reduceProviderLiveState,
  utf8ByteLength,
} from "../../apps/mac/src/provider-run-live";
import {
  isMeteredProviderInvocationStartedEvent,
  providerRunProvenance,
} from "../../apps/mac/src/runtime";

function event(
  eventType: ProviderRunEventType,
  message: string,
  overrides: Partial<ProviderRunEvent> = {},
): ProviderRunEvent {
  return {
    runId: "run-1",
    sequence: 1,
    eventType,
    provider: "codex",
    model: "default",
    message,
    createdAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("Mac provider live response state", () => {
  it("keeps the Rust structured-output bounds aligned with the shared UI contract", () => {
    const rust = readFileSync(new URL("../../apps/mac/src-tauri/src/provider_runtime.rs", import.meta.url), "utf8");
    const rustLimit = (name: string) => Number(
      rust.match(new RegExp(`const ${name}: usize = ([0-9_]+);`))?.[1].replaceAll("_", ""),
    );
    expect(rustLimit("MAX_STRUCTURED_SUMMARY_BYTES")).toBe(PROVIDER_FINAL_OUTPUT_LIMITS.summaryBytes);
    expect(rustLimit("MAX_STRUCTURED_ITEMS")).toBe(PROVIDER_FINAL_OUTPUT_LIMITS.itemCount);
    expect(rustLimit("MAX_STRUCTURED_ITEM_BYTES")).toBe(PROVIDER_FINAL_OUTPUT_LIMITS.itemBytes);
    expect(rustLimit("MAX_FORMATTED_ANSWER_BYTES")).toBe(PROVIDER_FINAL_OUTPUT_LIMITS.answerBytes);
  });

  it("stops synthetic answer reveal after cancellation or run replacement", () => {
    const active = emptyProviderLiveState("run-1");
    expect(canContinueProviderReveal("run-1", active, false)).toBe(true);
    expect(canContinueProviderReveal("run-1", active, true)).toBe(false);
    expect(canContinueProviderReveal("run-1", emptyProviderLiveState("run-2"), false)).toBe(false);
    expect(canContinueProviderReveal("run-1", emptyProviderLiveState(), false)).toBe(false);

    const app = readFileSync(new URL("../../apps/mac/src/BotsApp.tsx", import.meta.url), "utf8");
    expect(app).toContain("const current = botExecutionState(executionStatesRef.current, botId);");
    expect(app).toContain("canceledRunIds.current.has(runId)");
    expect(app).toContain('throw new Error("Run canceled before the answer was saved.")');
  });

  it("keeps concise thinking separate while typing the natural answer", () => {
    let state = emptyProviderLiveState("run-1");
    state = reduceProviderLiveState(state, event("progress", "Codex is thinking"));
    state = reduceProviderLiveState(state, event("reasoning-delta", "Checking approved "));
    state = reduceProviderLiveState(state, event("reasoning-delta", "evidence"));
    state = reduceProviderLiveState(state, event("output-delta", "This product helps "));
    state = reduceProviderLiveState(state, event("output-delta", "developers ship software."));

    expect(state).toMatchObject({
      phase: "answering",
      reasoning: "Checking approved evidence",
      answer: "This product helps developers ship software.",
    });

    state = reduceProviderLiveState(state, event("progress", "Codex is reconnecting"));
    expect(state.answer).toBe("This product helps developers ship software.");
    expect(state.status).toBe("Codex is reconnecting");

    state = reduceProviderLiveState(state, event("completed", "This product helps developers ship software.", {
      payload: { summary: "A revised final answer.", items: ["Grounded"] },
    }));
    expect(state).toMatchObject({
      phase: "complete",
      status: "Finished",
      answer: "This product helps developers ship software.",
    });
  });

  it("reconciles compatible final answers by appending only the unseen suffix", () => {
    expect(finalAnswerReconciliation(
      "This product helps ",
      "This product helps developers ship software.",
    )).toEqual({
      mode: "append",
      suffix: "developers ship software.",
    });
    expect(finalAnswerReconciliation("Complete answer", "Complete answer")).toEqual({
      mode: "settled",
    });
  });

  it("replaces a divergent streamed answer once instead of erasing and retyping it", () => {
    const visible = "The first draft says the rollout is blocked.";
    const final = "The verified rollout can proceed with the migration guard.";
    const reconciliation = finalAnswerReconciliation(visible, final);

    expect(reconciliation).toEqual({ mode: "replace", answer: final });
    const displayedStates = [
      visible,
      reconciliation.mode === "replace" ? reconciliation.answer : visible,
    ];
    expect(displayedStates).toEqual([visible, final]);
    expect(displayedStates).not.toContain(final.slice(0, 8));
  });

  it("never treats legacy raw structured chunks as user-visible answer text", () => {
    const state = reduceProviderLiveState(
      emptyProviderLiveState("run-1"),
      event("message", "{\"summary\":\"private structured chunk"),
    );
    expect(state.answer).toBe("");
    expect(state.status).toBe("Building answer");
  });

  it("ignores events from another run and bounds transient text", () => {
    let state = reduceProviderLiveState(
      emptyProviderLiveState("run-1"),
      event("output-delta", "x".repeat(20_000)),
    );
    state = reduceProviderLiveState(state, event("reasoning-delta", "y".repeat(8_000)));
    const unchanged = reduceProviderLiveState(state, event("output-delta", "wrong run", { runId: "run-2" }));
    expect(unchanged).toBe(state);
    expect(state.answer).toHaveLength(PROVIDER_FINAL_OUTPUT_LIMITS.answerBytes);
    expect(state.reasoning).toHaveLength(4_000);
  });

  it("formats one exact ASCII answer within every native persistence boundary", () => {
    const structuredOutput = {
      summary: "s".repeat(PROVIDER_FINAL_OUTPUT_LIMITS.summaryBytes),
      items: Array.from(
        { length: PROVIDER_FINAL_OUTPUT_LIMITS.itemCount },
        () => "i".repeat(PROVIDER_FINAL_OUTPUT_LIMITS.itemBytes),
      ),
    };
    const answer = formatProviderFinalAnswer(structuredOutput);
    expect(utf8ByteLength(answer)).toBeLessThanOrEqual(PROVIDER_FINAL_OUTPUT_LIMITS.answerBytes);
    expect(answer.match(/^- /gm)).toHaveLength(PROVIDER_FINAL_OUTPUT_LIMITS.itemCount);
    expect(providerRunReceiptSummary({ structuredOutput, text: structuredOutput.summary }, answer)).toBe(answer);
    expect(structuredOutput.items).toHaveLength(PROVIDER_FINAL_OUTPUT_LIMITS.itemCount);
  });

  it("bounds multibyte text by UTF-8 bytes without splitting a code point", () => {
    const answer = formatProviderFinalAnswer({
      summary: "🚀".repeat(1_000),
      items: ["é".repeat(500), "✅".repeat(500), "done"],
    });
    expect(utf8ByteLength(answer)).toBeLessThanOrEqual(PROVIDER_FINAL_OUTPUT_LIMITS.answerBytes);
    expect(utf8ByteLength(answer.split("\n")[0])).toBe(PROVIDER_FINAL_OUTPUT_LIMITS.summaryBytes);
    expect(answer).not.toContain("�");
  });

  it("keeps token deltas out of the durable run event stream", () => {
    const events = [
      event("queued", "Queued"),
      ...Array.from({ length: 600 }, (_, index) => event(
        index % 2 ? "reasoning-delta" : "output-delta",
        `delta-${index}`,
        { sequence: index + 2 },
      )),
      event("completed", "Natural answer", {
        sequence: 602,
        payload: { summary: "Natural answer", items: [] },
      }),
    ];
    expect(recordableProviderRunEvents(events).map((candidate) => candidate.eventType)).toEqual([
      "queued",
      "completed",
    ]);
  });

  it("distinguishes metered fallback authorization from provider invocation", () => {
    expect(providerRunProvenance(
      { provider: "openai" },
      "auto",
      true,
      false,
    )).toEqual({
      selectionMode: "auto",
      meteredFallbackAuthorized: true,
      meteredProviderInvocationStarted: false,
      billingFallback: false,
    });
    expect(providerRunProvenance(
      { provider: "openai" },
      "auto",
      true,
      true,
    )).toEqual({
      selectionMode: "auto",
      meteredFallbackAuthorized: true,
      meteredProviderInvocationStarted: true,
      billingFallback: true,
    });
    expect(providerRunProvenance(
      { provider: "codex" },
      "auto",
      true,
      true,
    )).toEqual({
      selectionMode: "auto",
      meteredFallbackAuthorized: true,
      meteredProviderInvocationStarted: false,
      billingFallback: false,
    });
  });

  it("does not treat generic startup or a missing-key failure as metered invocation", () => {
    const selection = { provider: "openai" } as const;
    const beforeSend = [
      event("queued", "Queued", { provider: "openai" }),
      event("started", "Local intelligence started", { provider: "openai" }),
      event("failed", "OpenAI API key is not configured", { provider: "openai" }),
    ];
    const invoked = beforeSend.some((candidate) => (
      isMeteredProviderInvocationStartedEvent(candidate, selection)
    ));

    expect(invoked).toBe(false);
    expect(providerRunProvenance(selection, "auto", true, invoked)).toEqual({
      selectionMode: "auto",
      meteredFallbackAuthorized: true,
      meteredProviderInvocationStarted: false,
      billingFallback: false,
    });
  });

  it("marks a metered invocation only after the dedicated HTTP send event", () => {
    const selection = { provider: "openai" } as const;
    const invoked = [
      event("started", "Local intelligence started", { provider: "openai" }),
      event("provider-invocation-started", "Metered provider request started", {
        provider: "openai",
      }),
    ].some((candidate) => isMeteredProviderInvocationStartedEvent(candidate, selection));

    expect(invoked).toBe(true);
    expect(providerRunProvenance(selection, "auto", true, invoked)).toMatchObject({
      meteredFallbackAuthorized: true,
      meteredProviderInvocationStarted: true,
      billingFallback: true,
    });
  });

  it("records an Auto API choice as an explicitly authorized metered fallback", () => {
    const runtime = readFileSync(new URL("../../apps/mac/src/runtime.ts", import.meta.url), "utf8");
    const native = readFileSync(new URL("../../apps/mac/src-tauri/src/provider_runtime.rs", import.meta.url), "utf8");
    expect(runtime).toContain("assertRecordableProviderProvenance(result)");
    expect(runtime).toContain("meteredProviderInvocationStarted");
    expect(runtime).toContain("meteredFallbackAuthorized");
    expect(native).toContain("Auto selected this API provider after the user enabled metered fallback");
    expect(native).toContain("no ready local or subscription engine was available");
  });
});
