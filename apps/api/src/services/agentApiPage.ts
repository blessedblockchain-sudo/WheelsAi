/**
 * What the API page of a listing draws (GET /api/a/:handle/api).
 *
 * A listing that sells use of an agent that answers has a public page for
 * people who call it from code: where to send a request, the model id, what
 * a use costs, the plans on offer, the limits for one buyer, the usage
 * headers an answer carries and the refusals a caller can meet.
 *
 * Built from what the agent's public page already reads, field by field, so
 * the two pages can never say different prices, plans or limits, and nothing
 * the public page does not show can cross here. Never the creator's model,
 * tokens, organization, or how many people use it.
 *
 * It also says how to pay one use from a Solana wallet with no key (the
 * x402 door, services/paidUseX402.ts), and only when the door would take
 * that payment: it is usable now (handed in by the route) and it serves this
 * listing (x402ListingServed, the door's own test), so the page never offers
 * a door that answers 401, nor one whose settings are closed. A paused
 * listing still shows it: the door then answers 503 agent_paused, as the
 * per-use refusals already list. It can also answer 503 x402_unavailable at
 * the moment of a call (its fee payer under the floor, a chain read that
 * fails), which no page can know ahead. The creator's switch itself is
 * never told.
 *
 * Only an agent that is called has an API page. A self-running agent sells
 * its results, which subscribers read on its page: it answers no call, so it
 * has none, like an agent whose use is not sold.
 *
 * Pure: no IO.
 */

import { PAID_USE_LIMITS, PAID_USE_MESSAGES, type PaidUseErrorCode } from "./paidUse.js";
import { trialOfferOf } from "./planOffers.js";
import { BALANCE_CENTS_HEADER, CHARGED_CENTS_HEADER, PLAN_USAGE_HEADER_NAMES } from "./usageHeaders.js";
import {
  X402_ANSWER_DEADLINE_MS,
  x402ListingServed,
  type X402DoorAgent,
  type X402DoorListing,
} from "./x402DoorRules.js";

/** What this needs of the agent's public page (PublicAgentDetail, routes/publicAgent.ts). */
export interface AgentApiPageSource {
  agent: { name: string; handle: string; agentKind: string };
  use: {
    state: string;
    paid?: {
      listingId: string;
      listingSlug: string;
      pricingModel: string;
      priceCents: bigint;
      unit: "message" | "run" | "month";
      perMinute: number;
      perDay: number;
      plans?: Array<{
        id: string;
        name: string;
        priceCents: bigint;
        includedUses: number;
        extraUsePriceCents: bigint | null;
      }>;
      trial?: { id: string; includedUses: number } | null;
      /**
       * What the x402 door reads of this listing and its agent, as they were
       * read. Absent when it was not read: no door is offered then.
       */
      x402Door?: { listing: X402DoorListing; agent: X402DoorAgent };
    } | null;
  };
}

/**
 * The cluster the x402 door takes payments on, when the door is usable
 * right now: its CAIP-2 network id and the USDC mint of that cluster.
 */
export interface AgentApiX402Cluster {
  network: string;
  asset: string;
}

/** How to pay one use from a Solana wallet, with no key (the x402 door). */
export interface AgentApiX402 {
  /** The price of one use, paid in USDC: the listing's price per use. */
  priceCents: number;
  /** What one payment buys: a chat answer or a task's run. */
  unit: "message" | "run";
  /** The network as the published format names it (CAIP-2). */
  network: string;
  /** The USDC mint the payment is made in. */
  asset: string;
  /** The longest an answer paid this way may take to be made; past it nothing is sent. */
  answerWithinSeconds: number;
  /**
   * What one wallet may pay for here, in a minute and in a day, and how many
   * calls one address may make here in a minute.
   */
  limits: { walletPerMinute: number; walletPerDay: number; addressPerMinute: number };
}

/** One way to reach the agent. `path` is under the base address. */
export interface AgentApiEndpoint {
  /**
   * `openai`: OpenAI's chat completions, with the model id. `chat`: the same
   * conversation in WheelsAI's own shape. `run`: one run of a task, from its
   * form's answers. `access`: where the caller stands (their plan, their
   * balance), a read that costs nothing.
   */
  use: "openai" | "chat" | "run" | "access";
  method: "GET" | "POST";
  path: string;
}

/** A refusal a caller can meet: its code and status, and what it means in plain words. */
export interface AgentApiRefusal {
  code: PaidUseErrorCode;
  status: number;
  message: string;
}

export interface AgentApiPage {
  handle: string;
  /** The agent's public name. */
  name: string;
  agentKind: "conversation" | "task";
  listingId: string;
  listingSlug: string;
  /**
   * The base address requests are sent to, with no slash at its end. null
   * when this server was given no public address: the page then uses the
   * address it reached the API at.
   */
  baseUrl: string | null;
  /** The model id for OpenAI's chat completions. null for a task, which is run from its form's answers. */
  model: string | null;
  endpoints: AgentApiEndpoint[];
  /** per_request or monthly. */
  pricingModel: string;
  /**
   * What `priceCents` buys. `message` or `run`: one use. `month`: 30 days of
   * access, started on the agent's page; each call inside them costs nothing
   * more.
   */
  unit: "message" | "run" | "month";
  priceCents: number;
  /** The plans on offer, in the order they are shown. Empty when the listing offers none. */
  plans: Array<{
    id: string;
    name: string;
    priceCents: number;
    includedUses: number;
    extraUsePriceCents: number | null;
  }>;
  /**
   * The free trial on offer beside the plans: some uses for `days` days at no
   * price, started once by a buyer's organization on the agent's page or
   * with a key. null when the listing offers none.
   */
  trial: { id: string; includedUses: number; days: number } | null;
  /**
   * What one buyer may send. `perDayWithoutPlan` holds a buyer who is on no
   * plan: a plan's holder is held to the plan's count in its place.
   */
  limits: { perMinute: number; perDayWithoutPlan: number };
  /** The names of the usage headers: on every paid answer, and the ones an answer on a plan adds. */
  usageHeaders: { always: string[]; onPlan: string[] };
  refusals: AgentApiRefusal[];
  /**
   * How to pay one use from a Solana wallet with no key. null unless the
   * door is usable now and serves this listing. Its refusals are the page's
   * own words, not in `refusals`.
   */
  x402: AgentApiX402 | null;
}

// ============================================
// The refusals, in plain words
// ============================================

const START_FIRST: AgentApiRefusal = {
  code: "use_not_started",
  status: 403,
  message:
    "You have not started using this agent. Start on its page, or ask an owner or admin of your organization to start.",
};
const PRICING_CHANGED: AgentApiRefusal = {
  code: "pricing_changed",
  status: 409,
  message: "The owner changed how this agent is sold. Nothing is charged until you accept the new terms.",
};
const RATE_LIMITED: AgentApiRefusal = {
  code: "rate_limited",
  status: 429,
  message:
    "More requests were sent than this agent allows for now. Nothing was charged. The retry-after header says how many seconds to wait.",
};
const PAUSED: AgentApiRefusal = { code: "agent_paused", status: 503, message: PAID_USE_MESSAGES.paused };

/** What a caller of a listing sold per use can meet, in the order a request meets them. */
const PER_USE_REFUSALS: AgentApiRefusal[] = [
  START_FIRST,
  PRICING_CHANGED,
  {
    code: "plan_ended",
    status: 402,
    message: "Your plan ended. Choose a plan or pay per use to keep using it.",
  },
  {
    code: "plan_used_up",
    status: 429,
    message:
      "You have used all the uses in your plan, and it stops until it renews. Nothing was charged. The answer carries the plan's usage headers.",
  },
  {
    code: "insufficient_credits",
    status: 402,
    message: "You do not have enough credits for this use. Nothing was charged. Add credits to continue.",
  },
  {
    code: "api_key_use_price_cap_exceeded",
    status: 403,
    message: "This use costs more than this API key may spend on one use.",
  },
  {
    code: "api_key_daily_cap_exceeded",
    status: 403,
    message: "This use would take this API key past what it may spend in one day.",
  },
  RATE_LIMITED,
  PAUSED,
];

/**
 * The same for a listing sold by the month. It has no plans and no charge
 * per use, so no refusal about a plan, credits for one use or a key's caps.
 */
const MONTHLY_REFUSALS: AgentApiRefusal[] = [
  START_FIRST,
  PRICING_CHANGED,
  {
    code: "subscription_lapsed",
    status: 402,
    message: "Your subscription has ended. Subscribe again to keep using it.",
  },
  RATE_LIMITED,
  PAUSED,
];

/** Every refusal this page can tell, for a test that holds them to the code. */
export const AGENT_API_REFUSALS: readonly AgentApiRefusal[] = [...PER_USE_REFUSALS, MONTHLY_REFUSALS[2]!];

// ============================================
// The page
// ============================================

/**
 * The base address as it is told: no slash at its end, and nothing that is
 * not an address. The API page of a workflow on sale tells it the same way.
 */
export function baseUrlOf(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/.test(trimmed) ? trimmed : null;
}

/**
 * Paying one use from a wallet, told only when the door would take the
 * payment: it is usable now (`cluster`) and its own serve test passes on the
 * listing and the agent as they were read. Anything not read is no door.
 */
function x402Of(
  paid: NonNullable<AgentApiPageSource["use"]["paid"]>,
  cluster: AgentApiX402Cluster | null,
): AgentApiX402 | null {
  if (!cluster || !paid.x402Door) return null;
  const { listing, agent } = paid.x402Door;
  if (!x402ListingServed(listing, agent)) return null;
  // The door asks the listing's price per use, for one message or one run.
  const priceCents = listing.pricePerRequestCents;
  if (priceCents === null || paid.unit === "month") return null;
  return {
    priceCents: Number(priceCents),
    unit: paid.unit,
    network: cluster.network,
    asset: cluster.asset,
    answerWithinSeconds: X402_ANSWER_DEADLINE_MS / 1000,
    // The door holds a wallet to a buyer's numbers, and an address to a
    // buyer's minute (services/paidUseX402.ts): no second set.
    limits: {
      walletPerMinute: PAID_USE_LIMITS.perBuyerPerMinute,
      walletPerDay: PAID_USE_LIMITS.perBuyerPerDay,
      addressPerMinute: PAID_USE_LIMITS.perBuyerPerMinute,
    },
  };
}

/**
 * The API page of an agent, from its public page. null when it has none:
 * its use is not sold at a price, or it is not an agent that is called.
 * `x402` is the cluster of the wallet door when it is usable now, null when
 * it is not.
 */
export function agentApiPageOf(
  detail: AgentApiPageSource,
  options: { publicApiUrl?: string | null; x402?: AgentApiX402Cluster | null } = {},
): AgentApiPage | null {
  const paid = detail.use.state === "paid" ? (detail.use.paid ?? null) : null;
  if (!paid) return null;
  const { handle, agentKind } = detail.agent;
  if (agentKind !== "conversation" && agentKind !== "task") return null;

  const monthly = paid.pricingModel === "monthly";
  const at = `/api/a/${encodeURIComponent(handle)}`;
  const access: AgentApiEndpoint = { use: "access", method: "GET", path: `${at}/access` };
  // Only a conversation answers OpenAI's chat completions. A task is run
  // from its form's answers, at its own address.
  const endpoints: AgentApiEndpoint[] =
    agentKind === "conversation"
      ? [
          { use: "openai", method: "POST", path: "/v1/chat/completions" },
          { use: "chat", method: "POST", path: `${at}/chat` },
          access,
        ]
      : [{ use: "run", method: "POST", path: `${at}/run` }, access];

  return {
    handle,
    name: detail.agent.name,
    agentKind,
    listingId: paid.listingId,
    listingSlug: paid.listingSlug,
    baseUrl: baseUrlOf(options.publicApiUrl),
    model: agentKind === "conversation" ? `a/${handle}` : null,
    endpoints,
    pricingModel: paid.pricingModel,
    unit: paid.unit,
    priceCents: Number(paid.priceCents),
    // A listing sold by the month offers no plan, whatever was read with it.
    plans: (monthly ? [] : (paid.plans ?? [])).map((plan) => ({
      id: plan.id,
      name: plan.name,
      priceCents: Number(plan.priceCents),
      includedUses: plan.includedUses,
      extraUsePriceCents: plan.extraUsePriceCents === null ? null : Number(plan.extraUsePriceCents),
    })),
    // Nor a free trial: that is offered beside plans only.
    trial: monthly ? null : trialOfferOf(paid.trial),
    limits: { perMinute: paid.perMinute, perDayWithoutPlan: paid.perDay },
    usageHeaders: {
      always: [CHARGED_CENTS_HEADER, BALANCE_CENTS_HEADER],
      onPlan: monthly ? [] : [...PLAN_USAGE_HEADER_NAMES],
    },
    refusals: (monthly ? MONTHLY_REFUSALS : PER_USE_REFUSALS).map((refusal) => ({ ...refusal })),
    x402: x402Of(paid, options.x402 ?? null),
  };
}
