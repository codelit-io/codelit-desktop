import Stripe from "stripe";
import { paidPlanCatalog, type PaidPlanId } from "./plan-catalog";

let _stripe: Stripe | null = null;

export function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
    _stripe = new Stripe(key, { apiVersion: "2026-02-25.clover" });
  }
  return _stripe;
}

export const PLANS = {
  pro: {
    name: paidPlanCatalog("pro").name,
    price: paidPlanCatalog("pro").monthlyPriceUsd,
  },
  max: {
    name: paidPlanCatalog("max").name,
    price: paidPlanCatalog("max").monthlyPriceUsd,
  },
} as const;

export type PlanId = PaidPlanId;

/** Hosted scheduled-workflow allowance per plan, enforced at /api/deployments. */
export const HOSTED_WORKFLOW_LIMITS: Record<PlanId, number> = {
  pro: paidPlanCatalog("pro").hostedWorkflows,
  max: paidPlanCatalog("max").hostedWorkflows,
};

/** Monthly hosted-run MODEL-SPEND budget per plan (USD, not the plan price).
    Enforced at tick enqueue, the webhook trigger, and executor start; the
    ledger lives in hosted-usage/{uid} and resets by calendar month. */
export const HOSTED_MONTHLY_BUDGET_USD: Record<PlanId, number> = {
  pro: paidPlanCatalog("pro").managedModelBudgetUsd,
  max: paidPlanCatalog("max").managedModelBudgetUsd,
};
