/**
 * Platform plans, exactly as the pricing page states them.
 *
 *   Starter  free        up to 3 agents, 1,000 API calls/month
 *   Pro      $49/month   unlimited agents, 100,000 API calls/month, priority
 *                        model access, custom domains, advanced analytics,
 *                        priority marketplace placement, 14-day trial
 *   Enterprise custom    everything in Pro, no call cap, custom model
 *                        hosting, white-label marketplace, SSO & audit
 *                        logging, dedicated support & SLA
 *
 * Pure: the effective plan is derived from the stored subscription row.
 */

export type PlanId = "starter" | "pro" | "enterprise";

export interface PlanLimits {
  id: PlanId;
  name: string;
  priceMonthlyUsd: number | null; // null = custom
  maxAgents: number | null; // null = unlimited
  monthlyApiCalls: number | null; // null = unlimited
  customDomains: boolean;
  advancedAnalytics: boolean;
  priorityPlacement: boolean;
  /** Multiplier on the free-model per-minute/per-day limits. */
  modelRateMultiplier: number;
  sso: boolean;
  whiteLabel: boolean;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  starter: {
    id: "starter",
    name: "Starter",
    priceMonthlyUsd: 0,
    maxAgents: 3,
    monthlyApiCalls: 1_000,
    customDomains: false,
    advancedAnalytics: false,
    priorityPlacement: false,
    modelRateMultiplier: 1,
    sso: false,
    whiteLabel: false,
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthlyUsd: 49,
    maxAgents: null,
    monthlyApiCalls: 100_000,
    customDomains: true,
    advancedAnalytics: true,
    priorityPlacement: true,
    modelRateMultiplier: 10,
    sso: false,
    whiteLabel: false,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceMonthlyUsd: null,
    maxAgents: null,
    monthlyApiCalls: null,
    customDomains: true,
    advancedAnalytics: true,
    priorityPlacement: true,
    modelRateMultiplier: 50,
    sso: true,
    whiteLabel: true,
  },
};

export const PRO_TRIAL_DAYS = 14;

/** Stripe statuses under which a paid plan's features are on. */
const ENTITLED_STATUSES = new Set(["trialing", "active", "past_due", "manual"]);

export interface SubscriptionLike {
  plan: string;
  status: string;
}

export function effectivePlan(sub: SubscriptionLike | null | undefined): PlanId {
  if (!sub) return "starter";
  if (sub.plan !== "pro" && sub.plan !== "enterprise") return "starter";
  return ENTITLED_STATUSES.has(sub.status) ? (sub.plan as PlanId) : "starter";
}

export function limitsFor(plan: PlanId): PlanLimits {
  return PLANS[plan];
}

export class PlanLimitError extends Error {
  readonly code = "plan_limit_reached";
  constructor(
    message: string,
    readonly plan: PlanId,
    readonly limit: string,
  ) {
    super(message);
    this.name = "PlanLimitError";
  }
}

/** Calendar-month bucket for API-call counting, in UTC: "2026-10". */
export function usageMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}
