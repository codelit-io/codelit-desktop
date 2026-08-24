import type { AgentWorkflow } from "../stores/agent-workflow-store";
import type { AgentSimulationPlan } from "./agent-workflow-export";

// Design-time $/run estimates for agent workflows, the agent-side analog of the
// arch board's COST_MAP. Pure derived computation: ranges with stated assumptions,
// never point estimates. No persistence, no AI calls.

export interface ModelPrice {
  match: RegExp;
  inputPerMTok: number;
  outputPerMTok: number;
  label: string;
}

// Verified June 2026 list prices (per 1M tokens). Free-tier OpenRouter models are $0.
export const PRICE_MAP: ModelPrice[] = [
  { match: /opus/i, inputPerMTok: 5, outputPerMTok: 25, label: "Claude Opus" },
  { match: /sonnet/i, inputPerMTok: 3, outputPerMTok: 15, label: "Claude Sonnet" },
  { match: /haiku/i, inputPerMTok: 1, outputPerMTok: 5, label: "Claude Haiku" },
  { match: /gpt-4o-mini|4o-mini/i, inputPerMTok: 0.15, outputPerMTok: 0.6, label: "GPT-4o mini" },
  { match: /gpt-4o/i, inputPerMTok: 2.5, outputPerMTok: 10, label: "GPT-4o" },
  { match: /\bo[134](-|\b)|gpt-5/i, inputPerMTok: 4, outputPerMTok: 16, label: "OpenAI frontier" },
  { match: /flash|mini|nano|:free|deepseek|qwen|nemotron/i, inputPerMTok: 0.1, outputPerMTok: 0.4, label: "Economy" },
];

const TIER_PRICES = {
  premium: { inputPerMTok: 5, outputPerMTok: 25, label: "Premium tier" },
  balanced: { inputPerMTok: 3, outputPerMTok: 15, label: "Balanced tier" },
  economy: { inputPerMTok: 1, outputPerMTok: 5, label: "Economy tier" },
} as const;

export type CostTier = keyof typeof TIER_PRICES;

// Mirrors the runtime cap in the generated orchestrator (max_tokens: 1024).
export const AGENT_STEP_MAX_TOKENS = 1024;
const BASE_PROMPT_TOKENS = 400;
const CONTEXT_HANDOFF_TOKENS = 600;
const MIN_OUTPUT_TOKENS = 256;
const TOOL_RETRY_FACTOR = 1.5;

function looksLikeModelId(value: string) {
  return value.includes("-") && /^[a-z0-9][a-z0-9.:/_-]*$/i.test(value.trim());
}

/** Resolve a model string (real id or builder label like "Deep reasoning model") to pricing. */
export function priceForModel(model: string): { inputPerMTok: number; outputPerMTok: number; label: string } {
  const value = model.trim();
  if (looksLikeModelId(value)) {
    for (const row of PRICE_MAP) if (row.match.test(value)) return row;
  }
  if (/deep|reason|premium|opus|frontier|advanced/i.test(value)) return TIER_PRICES.premium;
  if (/fast|low-cost|cheap|economy|haiku|mini|flash|light|small/i.test(value)) return TIER_PRICES.economy;
  for (const row of PRICE_MAP) if (row.match.test(value)) return row;
  return TIER_PRICES.balanced;
}

export interface StepCostEstimate {
  stepId: string;
  title: string;
  model: string;
  priceLabel: string;
  low: number;
  high: number;
}

export interface RunCostEstimate {
  steps: StepCostEstimate[];
  low: number;
  high: number;
  assumptions: string[];
}

function stepRange(price: { inputPerMTok: number; outputPerMTok: number }, hasTools: boolean) {
  const tokensIn = BASE_PROMPT_TOKENS + CONTEXT_HANDOFF_TOKENS;
  const inCost = (tokensIn / 1_000_000) * price.inputPerMTok;
  const low = inCost + (MIN_OUTPUT_TOKENS / 1_000_000) * price.outputPerMTok;
  const high = (inCost + (AGENT_STEP_MAX_TOKENS / 1_000_000) * price.outputPerMTok) * (hasTools ? TOOL_RETRY_FACTOR : 1);
  return { low, high };
}

export function estimateRunCost(workflow: AgentWorkflow, simulation: AgentSimulationPlan): RunCostEstimate {
  void workflow; // reserved for route-level overrides (Pro optimizer phase 2)
  const steps: StepCostEstimate[] = simulation.steps.map((step) => {
    const price = priceForModel(step.model);
    const { low, high } = stepRange(price, step.tools.length > 0);
    return { stepId: step.id, title: step.title, model: step.model, priceLabel: price.label, low, high };
  });
  return {
    steps,
    low: steps.reduce((sum, step) => sum + step.low, 0),
    high: steps.reduce((sum, step) => sum + step.high, 0),
    assumptions: [
      `~${BASE_PROMPT_TOKENS + CONTEXT_HANDOFF_TOKENS} input tokens per step (prompt + artifact handoff)`,
      `${MIN_OUTPUT_TOKENS}–${AGENT_STEP_MAX_TOKENS} output tokens per step (runtime cap)`,
      `${TOOL_RETRY_FACTOR}x retry factor on steps that call tools`,
      "June 2026 list prices; free-tier routes priced as economy",
    ],
  };
}

/** What-if: every route swapped to a tier, the optimizer's one-click preset. */
export function estimateAtTier(_workflow: AgentWorkflow, simulation: AgentSimulationPlan, tier: CostTier): RunCostEstimate {
  const price = TIER_PRICES[tier];
  const steps: StepCostEstimate[] = simulation.steps.map((step) => {
    const { low, high } = stepRange(price, step.tools.length > 0);
    return { stepId: step.id, title: step.title, model: tier, priceLabel: price.label, low, high };
  });
  return {
    steps,
    low: steps.reduce((sum, step) => sum + step.low, 0),
    high: steps.reduce((sum, step) => sum + step.high, 0),
    assumptions: [],
  };
}

export function formatUsd(value: number) {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

export function formatRunRange(estimate: RunCostEstimate) {
  return `${formatUsd(estimate.low)}–${formatUsd(estimate.high)}`;
}

export function projectMonthly(estimate: RunCostEstimate, runsPerDay: number) {
  const mid = ((estimate.low + estimate.high) / 2) * runsPerDay * 30;
  return mid < 1 ? `~$${mid.toFixed(2)}/mo` : `~$${Math.round(mid)}/mo`;
}
