import { seg, type RequestOptions, type WheelsAIClient } from "../client.js";
import type { TaskInputIssue } from "./agents.js";
import type { PlanOffer, PricingModel, SubscriptionPlan } from "./marketplace.js";

/**
 * Use of an agent you pay for: `/api/a/{handle}/...`. You use a creator's own agent, per use, on a plan
 * with a number of uses, or per month, and never get a copy of it or see its instructions. Start with
 * `marketplace.startUsing` or `marketplace.startPlan` (or on the agent's page), then call `chat` or `run`
 * here. `usage` reads what you have used and spent on everything you pay for.
 *
 * Every call needs sign-in: a session token, or an API key. `chat` and `run` need an API key granted
 * `agents:use`, created with `maxUsePriceCents` and `dailySpendCapCents`.
 *
 * The same agent also answers `inference.chat` with `model: "a/<handle>"`.
 *
 * Limits for one organization and one agent: 10 uses a minute for everybody; 200 a day with no plan and
 * inside a paid month; on a plan, the plan's count takes the place of the daily limit.
 *
 * Every paid answer also says what it cost in its headers (`USAGE_HEADERS`). `chat` and `run` give you the
 * same numbers as `billing`, so nothing has to be read from a header here.
 */

/**
 * The usage headers of a paid answer of `/api/a/{handle}/chat`, `/api/a/{handle}/run` and
 * `/v1/chat/completions` with `model: "a/<handle>"`, for a caller that reads the raw response. The first
 * two are on every paid answer (the balance is left out when it could not be read); the rest only on a
 * plan. The refusal `plan_used_up` carries the plan's headers too, with 0 remaining.
 */
export const USAGE_HEADERS = {
  /** What this use cost, in cents: 0 for a use a plan includes and inside a paid month. */
  chargedCents: "x-wheelsai-charged-cents",
  /** Your credits after the use, in cents. */
  balanceCents: "x-wheelsai-balance-cents",
  /** The id of the plan you are on. */
  plan: "x-wheelsai-plan",
  /** The uses of these 30 days: included plus carried. */
  planLimit: "x-wheelsai-plan-limit",
  planUsed: "x-wheelsai-plan-used",
  planRemaining: "x-wheelsai-plan-remaining",
  /** When the count starts again, an ISO time. Left out when the plan will not renew. */
  planReset: "x-wheelsai-plan-reset",
  /** 85 or 100. Left out below 85. */
  planWarning: "x-wheelsai-plan-warning",
} as const;

/** A use can take up to two minutes, so these calls wait 130 seconds unless `options.timeoutMs` says otherwise. */
const USE_TIMEOUT_MS = 130_000;

/** Where you stand with an agent. */
export type UseAccessKind =
  | "none"
  | "subscribed"
  | "listing_pricing"
  | "pricing_changed"
  | "subscription_lapsed"
  | "plan_ended"
  | "not_offered"
  | "own_agent";

/** What the listing asks for one use. */
export interface UseTerms {
  pricingModel: PricingModel | (string & {});
  pricePerRequestCents: number | null;
  monthlyPriceCents: number | null;
  /** What one payment buys. */
  unit: "message" | "run" | "month";
  /** Whether the agent's owner keeps a copy of what is sent and answered. */
  keepsCopy: boolean;
}

/** `GET /api/a/{handle}/access`. */
export interface UseAccessState {
  access: UseAccessKind;
  listingId: string;
  /** What the listing asks now; null when use of it is not on sale. */
  terms: UseTerms | null;
  /** The plans the listing offers now, in the order they are shown. Empty when it offers none. */
  plans: PlanOffer[];
  /** The plan you are on, while it gives you uses. null otherwise. */
  plan: SubscriptionPlan | null;
  /** Free trials are not offered. */
  trialAvailable: false;
  /**
   * What you agreed to; null when you have not started. Starting a plan agrees to no price per use, so
   * `pricingModel` and `pricePerRequestCents` stay null until you agree to that price yourself.
   */
  accepted: { pricingModel: string | null; pricePerRequestCents: number | null; monthlyPriceCents: number | null } | null;
  /**
   * `graceEndsAt` is set while a renewal that failed is still being retried: the day access ends
   * unless credits are added before it (an ISO date).
   */
  subscription: {
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    graceEndsAt: string | null;
  } | null;
  /** Your credits, in cents. */
  balanceCents: number;
  /** Whether you may agree to a price or start a plan: an owner or admin, or a key granted `marketplace:install` by name. */
  canAccept: boolean;
  /**
   * Set while you hold a copy of this agent with a month paid for: starting to use it waits until
   * `until` (an ISO date), and `canAccept` is false. Null otherwise.
   */
  startBlocked: { code: "copy_subscription_active"; message: string; until: string } | null;
  /**
   * The agent is paused right now: the model it runs on is not running. Nobody can start using it and
   * nobody is charged while it is true, and a month already paid for is made longer by that time. The
   * other fields stay what they are.
   */
  paused: boolean;
}

/** Your plan after one use on it. The same count as `SubscriptionPlan`, without the plan's name. */
export interface UseBillingPlan extends Omit<SubscriptionPlan, "name"> {
  /** `included`: one of the plan's uses. `extra`: past the count, charged the extra price you agreed to. */
  use: "included" | "extra";
}

/** What one use cost. */
export interface UseBilling {
  /** The price per use; 0 inside a paid month and for a use a plan includes; a plan's extra price past its count. */
  chargedCents: number;
  /** Your credits after it; null when they could not be read just now. */
  balanceCents: number | null;
  access: "subscribed" | "listing_pricing";
  /** Only on a plan: the count after this use. */
  plan?: UseBillingPlan;
}

/** Uses and what they cost, in cents. */
export interface UsesAndCents {
  uses: number;
  cents: number;
}

/** One listing you pay to use, in `use.usage`. */
export interface UseUsageRow {
  listingId: string;
  title: string;
  slug: string;
  /** The agent's address, `/a/<handle>`; null when it has no page. */
  handle: string | null;
  /** Where you stand with it, as `access` answers it. */
  access: Exclude<UseAccessKind, "own_agent">;
  /** The plan you are on, while it gives you uses. null otherwise. */
  plan: SubscriptionPlan | null;
  /**
   * On a plan: the end of the 30 days paid for (an ISO time), and the day the plan ends when it will not
   * renew (its `plan` then has no `resetsAt`). null with no plan.
   */
  periodEndsAt: string | null;
  /** On a plan: its renewal did not go through and is being retried. */
  renewalPastDue: boolean;
  /** On a plan: the uses past its count in the current 30 days, and what they cost. null with no plan. */
  extraThisPeriod: UsesAndCents | null;
  /** The uses paid per use in the current UTC month, and what they cost. */
  perUseThisMonth: UsesAndCents;
}

/** `GET /api/billing/marketplace-usage`. */
export interface UseUsage {
  /** Your credits, in cents. One balance pays for every agent you use. */
  balanceCents: number;
  /** One row for each listing you have started using, the newest first. At most 200. */
  listings: UseUsageRow[];
}

export interface UseToolCall {
  name: string;
  status: "ok" | "unavailable" | "error";
}

export interface UseChatResult {
  message: { role: "assistant"; content: string };
  toolCalls: UseToolCall[];
  billing: UseBilling;
}

export interface UseRunResult {
  output: { format: "text"; text: string };
  toolCalls: UseToolCall[];
  billing: UseBilling;
}

/** A self-running agent's results for a subscriber, newest first. At most 30. */
export interface UseResults {
  results: Array<{ finishedAt: string; text: string }>;
  hasMore: boolean;
}

/**
 * The body of a refused use, which is `error.data` of the thrown `WheelsAIError`. Show `message` as it
 * comes. The other fields come only with the refusals they belong to. A refusal is always JSON, also
 * when a stream was asked for.
 *
 * `error` is one of: `invalid_request` (400), `missing_scope`, `use_not_started`,
 * `api_key_use_price_cap_exceeded`, `api_key_daily_cap_exceeded`, `api_key_spend_caps_missing`,
 * `not_a_member` (403: you are no longer a member of the paying organization),
 * `insufficient_credits`, `subscription_lapsed`, `plan_ended` (402: your plan is over and you have not
 * agreed to the price per use; choose a plan or pay per use), `agent_not_found` (404), `own_agent`,
 * `not_for_sale`, `not_offered`, `results_only`, `pricing_changed`, `not_a_task_agent` (409),
 * `input_too_large` (413), `input_invalid` (422), `rate_limited`, `too_many_refunds`, `plan_used_up`
 * (429: every use of your plan is gone and it stops until it renews; nothing was charged),
 * `client_closed_request` (499), `model_error`, `answer_withheld` (502),
 * `agent_unavailable`, `agent_paused` (the agent is paused; nothing was charged),
 * `rate_limiter_unavailable` (503).
 */
export interface UseRefusal {
  error: string;
  message: string;
  /** `copy_subscription_active` (409, on `marketplace.startUsing`): when the copy's paid month ends, an ISO date. */
  until?: string;
  /** `rate_limited`: `org` is your own limit, `agent` the agent's. */
  scope?: "org" | "agent";
  retryAfterSeconds?: number;
  /** `input_invalid`: each answer that needs another look. */
  details?: TaskInputIssue[];
  /** Your access, where the licence decided. */
  access?: UseAccessKind;
  /** `use_not_started`, `pricing_changed` and `plan_ended`: what the listing asks now. */
  terms?: UseTerms;
  /** `plan_used_up` and `plan_ended`: the plans the listing offers now, to choose from. */
  plans?: PlanOffer[];
  /** `plan_used_up`: when the plan's count starts again (an ISO time). Left out when the plan will not renew. */
  resetsAt?: string;
  /** `insufficient_credits`: the price of this use and your credits. */
  priceCents?: number;
  balanceCents?: number;
  /** `model_error` and `answer_withheld`: what was charged and given back. */
  refundedCents?: number;
}

export function useResource(client: WheelsAIClient) {
  return {
    /** `GET /api/a/{handle}/access`: where you stand with the agent and what it asks. 404 `agent_not_found`. */
    access: (handle: string) => client.get<UseAccessState>(`/api/a/${seg(handle)}/access`),

    /**
     * `POST /api/a/{handle}/chat` with `stream: false`: one message with the conversation so far. It is
     * charged when it is sent and refunded if no answer is delivered. The answer arrives whole. You cannot
     * send tools, a model or a system message. Limits: 10 a minute; 200 a day with no plan and inside a paid
     * month; on a plan, the plan's count. `billing.plan` is the count after this use when you are on one.
     */
    chat: (handle: string, body: { messages: Array<{ role: "user" | "assistant"; content: string }>; sessionId?: string }, options?: RequestOptions) =>
      client.post<UseChatResult>(
        `/api/a/${seg(handle)}/chat`,
        { ...body, stream: false },
        { timeoutMs: USE_TIMEOUT_MS, ...options },
      ),

    /**
     * `POST /api/a/{handle}/run` with `stream: false`: one run of a task agent from its form. `input`
     * holds one answer per question. A form that does not fit answers 422 `input_invalid` and nothing is
     * charged.
     */
    run: (handle: string, body: { input: Record<string, unknown> }, options?: RequestOptions) =>
      client.post<UseRunResult>(
        `/api/a/${seg(handle)}/run`,
        { ...body, stream: false },
        { timeoutMs: USE_TIMEOUT_MS, ...options },
      ),

    /** `GET /api/a/{handle}/results`: a self-running agent's latest results, for someone who pays for it. */
    results: (handle: string) => client.get<UseResults>(`/api/a/${seg(handle)}/results`),

    /**
     * `GET /api/billing/marketplace-usage`: what your organization has used and spent on every listing it
     * pays to use. The one balance, then for each listing your access, the plan you are on, the extra uses
     * of its current 30 days and the uses paid per use this UTC month, each with what they cost. Only uses
     * that were delivered are counted. It is a read: it costs nothing and is not counted as an API call.
     */
    usage: () => client.get<UseUsage>("/api/billing/marketplace-usage"),
  };
}
