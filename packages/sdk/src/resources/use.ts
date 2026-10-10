import { seg, type RequestOptions, type WheelsAIClient } from "../client.js";
import type { TaskInputIssue } from "./agents.js";
import type { PricingModel } from "./marketplace.js";

/**
 * Use of an agent you pay for: `/api/a/{handle}/...`. You use a creator's own agent, per use or per
 * month, and never get a copy of it or see its instructions. Start with `marketplace.startUsing`
 * (or on the agent's page), then call `chat` or `run` here.
 *
 * Every call needs sign-in: a session token, or an API key. `chat` and `run` need an API key granted
 * `agents:use`, created with `maxUsePriceCents` and `dailySpendCapCents`.
 *
 * The same agent also answers `inference.chat` with `model: "a/<handle>"`.
 */

/** A use can take up to two minutes, so these calls wait 130 seconds unless `options.timeoutMs` says otherwise. */
const USE_TIMEOUT_MS = 130_000;

/** Where you stand with an agent. */
export type UseAccessKind =
  | "none"
  | "subscribed"
  | "listing_pricing"
  | "pricing_changed"
  | "subscription_lapsed"
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
  /** What you agreed to; null when you have not started. */
  accepted: { pricingModel: string | null; pricePerRequestCents: number | null; monthlyPriceCents: number | null } | null;
  subscription: { status: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean } | null;
  /** Your credits, in cents. */
  balanceCents: number;
  /** Whether you may agree to a price: an owner or admin, or a key granted `marketplace:install` by name. */
  canAccept: boolean;
  /**
   * Set while you hold a copy of this agent with a month paid for: starting to use it waits until
   * `until` (an ISO date), and `canAccept` is false. Null otherwise.
   */
  startBlocked: { code: "copy_subscription_active"; message: string; until: string } | null;
}

/** What one use cost. */
export interface UseBilling {
  /** 0 inside a paid month. */
  chargedCents: number;
  /** Your credits after it; null when they could not be read just now. */
  balanceCents: number | null;
  access: "subscribed" | "listing_pricing";
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
 * `insufficient_credits`, `subscription_lapsed` (402), `agent_not_found` (404), `own_agent`,
 * `not_for_sale`, `not_offered`, `results_only`, `pricing_changed`, `not_a_task_agent` (409),
 * `input_too_large` (413), `input_invalid` (422), `rate_limited`, `too_many_refunds` (429),
 * `client_closed_request` (499), `model_error`, `answer_withheld` (502),
 * `agent_unavailable`, `rate_limiter_unavailable` (503).
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
  /** `use_not_started` and `pricing_changed`: what the listing asks now. */
  terms?: UseTerms;
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
     * send tools, a model or a system message. Limits: 10 a minute and 200 a day per organization and agent.
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
  };
}
