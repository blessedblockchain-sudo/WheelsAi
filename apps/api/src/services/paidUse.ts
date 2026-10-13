/**
 * Paid use: a buyer uses a creator's own agent, per use or per month, and
 * never gets a copy of it.
 *
 *   POST /api/a/:handle/chat      runPaidChat
 *   POST /api/a/:handle/run       runPaidTask
 *   GET  /api/a/:handle/results   listPaidResults
 *   GET  /api/a/:handle/access    getUseAccess
 *
 * It is not a third chat implementation. The chat is prepareAgentChat
 * (services/agentChat.ts), called in the CREATOR's organization as a
 * `public` caller (no system or tool messages, no caller-chosen model, no
 * caller tools), source `paid`, tool mode `hired`: nothing that spends or
 * writes, and an outbound request only for a tool the listing names. What
 * this file adds is the order of one paid use, and that order is the point:
 *
 *    1. who      a session, or a key granted agents:use by name (the
 *                route's guards; `caller` is what they found). A session's
 *                membership of the organization that pays is read again
 *                here, failing closed: a token outlives a removal.
 *    2. limits   the buyer's own, counted on the handle in the address on a
 *                limiter that fails closed, before anything is looked up.
 *    3. body     the free page's body for the kind, and nothing else.
 *    4. agent    by handle, and its listing: published, sells use. The
 *                caller's own agent is 409 own_agent; free use is 409
 *                not_for_sale (it is free on its page).
 *    5. licence  the buyer's licence and its access (resolveUseBilling).
 *                For a per-use charge the balance and the key's caps are
 *                READ here, so a request that cannot be paid for never
 *                reaches the creator's allowance.
 *    6. answers  task only: against the form (checkTaskInput). A wrong
 *                input spends nothing.
 *    7. core     the model, the agent's per-minute limit (`admit`), the
 *                creator's free-model allowance (one per use, failing
 *                closed), and only then
 *    8. charge   chargeUse, through the metering bound to this one licence
 *                (services/useMeteringProduction.ts).
 *    9. run      the answer is produced whole and checked
 *                (lib/heldAnswer.ts with detectInstructionLeak).
 *   10. settle   when the answer is delivered.
 *   11. refund   in every other ending: a model failure, the time limit,
 *                the caller gone, a withheld answer, a restart.
 *
 * Fail closed: a billable use whose session carries no charge is refused
 * before the model is called.
 *
 * A subscribed use charges and reserves nothing. The creator's plan calls
 * are not used; the buyer's plan counts one call with an API key (the
 * route's auth guard) and none from a session.
 *
 * What a buyer is told is this file's own vocabulary. Unlike a public
 * visitor (publicRefusalOf hides balances on purpose) the caller here is
 * the payer, so the price and the balance are told. What a buyer is NEVER
 * told: the agent's instructions, tool settings, source, secret names, the
 * model id, knowledge-base document titles, the creator's organization id,
 * the creator's allowance or its use, another buyer's use or price. Every
 * reply is built here field by field from values that are the buyer's own.
 *
 * Pure core: every effect is a dependency (services/buildPaidUseDeps.ts
 * binds the real ones), so the unit tests drive this file with fakes.
 */

import { createHash } from "node:crypto";

import type { z } from "zod";

import { holdUntilChecked } from "../lib/heldAnswer.js";
import { publicToolCalls, toPublicStream, type PublicToolCall } from "../lib/publicSse.js";
import type {
  AgentChatDeps,
  AgentChatFailure,
  AgentChatInput,
  AgentChatRefusal,
  PrepareAgentChatResult,
} from "./agentChat.js";
import {
  buildTaskBrief,
  checkTaskInput,
  TASK_REFUSAL_STATUS,
  type TaskInputCheck,
  type TaskInputIssue,
} from "./agentTask.js";
import type { SpendPeek } from "./apiKeySpend.js";
import { detectInstructionLeak } from "./assertions.js";
import { CLIENT_GONE, type SettleableMeter } from "./chatStreamSettlement.js";
import type { FailClosedLimiter, LimitRule } from "./failClosedLimiter.js";
import { CONFIDENTIAL_CHAT_RULES } from "./jobPrompt.js";
import type { MarketplaceCharge, MeteredInstall } from "./marketplaceMetering.js";
import type { ChatStream, StreamOutcome } from "./mastra-runtime.js";
import {
  consumePublicLimit,
  publicChatBodySchema,
  secondsLeftInUtcDay,
  utcDay,
  type PublicChatTranscript,
} from "./publicChat.js";
import {
  PAID_USE_PER_BUYER_PER_DAY,
  PAID_USE_PER_BUYER_PER_MINUTE,
  PUBLIC_RESULT_MAX_CHARS,
  PUBLIC_RESULTS_LIMIT,
} from "./publicPageState.js";
import { publicTaskBodySchema } from "./publicTask.js";
import {
  COPY_MONTH_BLOCKS_USE,
  copyMonthBlockingUse,
  copyMonthBlockingUseMessage,
  useAccess,
  type UseAccess,
  type UseSubscription,
} from "./useAccess.js";
import { PAST_DUE_GRACE_DAYS } from "./subscriptionAccess.js";
import type { UseListingRow } from "./useListing.js";
import {
  resolveUseBilling,
  type UseBilling,
  type UseBillingLicence,
  type UseChargeResult,
  type UseUnit,
} from "./useMetering.js";

// ============================================
// Limits
// ============================================

export interface PaidUseLimits {
  /** Uses a minute, per buyer organization and agent. */
  perBuyerPerMinute: number;
  /** Uses a day, per buyer organization and agent. */
  perBuyerPerDay: number;
  /** Uses a minute of one agent, by everybody who pays. No daily cap. */
  perAgentPerMinute: number;
  /** Refunds a day of answers that were produced and not delivered, per buyer and agent. */
  undeliveredRefundsPerDay: number;
  /** Reads a minute of a self-running agent's results, per buyer and agent. */
  resultsPerMinute: number;
  maxToolRounds: number;
  timeLimitMs: number;
}

export const PAID_USE_LIMITS: PaidUseLimits = {
  // One source with the agent's page and GET /api/capabilities, which show
  // these two numbers (services/publicPageState.ts).
  perBuyerPerMinute: PAID_USE_PER_BUYER_PER_MINUTE,
  perBuyerPerDay: PAID_USE_PER_BUYER_PER_DAY,
  perAgentPerMinute: 60,
  undeliveredRefundsPerDay: 10,
  resultsPerMinute: 60,
  maxToolRounds: 4,
  timeLimitMs: 120_000,
};

/**
 * How many results a subscriber may read, and how long each may be. A free
 * listing's results are its page's: PUBLIC_RESULTS_LIMIT and
 * PUBLIC_RESULT_MAX_CHARS (services/publicPageState.ts).
 */
export const PAID_RESULTS_LIMIT = 30;
export const PAID_RESULT_MAX_CHARS = 20_000;

/** The limiter keys, in one place. `handle` is the lower-case handle of the address. */
export const paidUseKeys = {
  buyerMinute: (orgId: string, handle: string) => `pu:b:m:${orgId}:${handle}`,
  buyerDay: (orgId: string, handle: string, day: string) => `pu:b:d:${day}:${orgId}:${handle}`,
  agentMinute: (agentId: string) => `pu:a:m:${agentId}`,
  undeliveredDay: (orgId: string, handle: string, day: string) => `pu:r:d:${day}:${orgId}:${handle}`,
  resultsMinute: (orgId: string, handle: string) => `pu:res:m:${orgId}:${handle}`,
} as const;

const MINUTE = 60;
/** The refund counter only counts: its limit is never what refuses. */
const COUNT_ONLY = 1_000_000;

/** A public handle: up to 40 lower-case letters, digits and hyphens. */
const HANDLE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// ============================================
// Input
// ============================================

/** Who is asking, as the route's guards found them. The payer. */
export interface PaidCaller {
  orgId: string;
  /** null for an API key: a key belongs to an organization, not a person. */
  userId: string | null;
  type: "jwt" | "api_key";
  apiKeyId?: string | null;
  scopes?: readonly string[];
}

export interface PaidUseInput {
  caller: PaidCaller;
  /** The handle in the address, as sent. */
  handle: string;
  /** The parsed JSON body, not yet validated. */
  body: unknown;
  /** Fires when the client goes away; the run stops and is refunded. */
  signal: AbortSignal;
}

export interface PaidReadInput {
  caller: PaidCaller;
  handle: string;
}

/** The creator's agent, as a paid use reads it. None of it is sent to a buyer but the kind. */
export interface PaidAgent {
  id: string;
  /** The creator's organization. Never sent to a buyer. */
  orgId: string;
  name: string | null;
  agentKind: string | null;
  kindConfig: unknown;
  /** "chat" or "graph". */
  entrypoint: string | null;
  isPublic: boolean;
  /** "Show results" on the agent's page. Decides what a free listing's results route gives. */
  publicResults: boolean | null;
  /** The instructions the answer is checked against. Never sent to a buyer. */
  systemPrompt: string | null;
  /** The agent's configured tools: `[{ name, ... }]`. */
  tools: unknown;
  /** The key of the agent's public page: where "keep a copy" is set. */
  pageKey: { id: string; storeTranscripts: boolean } | null;
}

/** The subscription columns a paid use reads. */
export interface PaidSubscription extends UseSubscription {
  /** The monthly price the buyer agreed to. */
  priceCents?: bigint | null;
}

/**
 * The metering of ONE use, bound to one licence and one decided charge
 * (services/useMeteringProduction.ts, beginUseMetering).
 */
export interface PaidUseMetering {
  /** Handed to the chat core as its `beginMetering`. */
  beginMetering: AgentChatDeps["beginMetering"];
  /** Why the charge was refused, exactly; null when it was not. */
  refusal(): Exclude<UseChargeResult, { ok: true }> | null;
  /** The charge that was taken; null when none was. */
  charge(): MarketplaceCharge | null;
  /** Notes what the run used, for the model cost a settle repays. */
  noteRun(run: { platformModel: boolean; usage: unknown; content: string; promptChars: number }): void;
}

// ============================================
// Dependencies
// ============================================

export interface PaidUseDeps {
  limiter: Pick<FailClosedLimiter, "consume" | "peek">;
  limits: PaidUseLimits;
  /** The agent that holds this public handle, whoever owns it. */
  loadAgentByHandle(handle: string): Promise<PaidAgent | null>;
  /** The agent's one listing, in ANY state: a paid month outlives a listing that stopped selling. */
  loadListing(agentId: string): Promise<UseListingRow | null>;
  /** The caller's licence row for the listing and their subscription to it. */
  loadLicence(args: {
    listingId: string;
    buyerId: string;
  }): Promise<{ licence: UseBillingLicence | null; sub: PaidSubscription | null }>;
  /** The organization's credits, in cents. Throws when they cannot be read. */
  readBalance(orgId: string): Promise<bigint>;
  /** Whether a use of this price would fit the key's caps right now. A read. */
  peekKeySpend(args: { apiKeyId: string; orgId: string; priceCents: bigint }): Promise<SpendPeek>;
  /** The names of the tools that send a request to an address the model chooses. */
  outboundToolNames(): readonly string[];
  /** The metering of one use. `install: null` is a subscribed use: nothing is charged. */
  beginUse(args: {
    agentId: string;
    install: MeteredInstall | null;
    apiKeyId: string | null;
    unit: UseUnit;
  }): PaidUseMetering;
  /** prepareAgentChat on its production deps, with this use's `beginMetering` in place of the copy path's. */
  prepareChat(input: AgentChatInput, beginMetering: AgentChatDeps["beginMetering"]): Promise<PrepareAgentChatResult>;
  /** Best effort: a rejection is logged and never reaches the buyer. */
  writeTranscript?(transcript: PublicChatTranscript): Promise<void>;
  /** services/agentOwnSchedule.ts, latestOwnResults. */
  latestResults(args: {
    orgId: string;
    agentId: string;
    limit: number;
    maxChars: number;
  }): Promise<Array<{ finishedAt: Date; text: string }>>;
  /** The member's role as it is now; null when they are not a member. */
  memberRole(orgId: string, userId: string): Promise<string | null>;
  /**
   * Whether the listing is paused at this moment (services/listingPause.ts),
   * for the access view. services/paidUsePause.ts when omitted.
   */
  listingPaused?(args: {
    listing: { status: string; sells: string };
    agent: { id: string; orgId: string };
  }): Promise<boolean>;
  now?: () => Date;
  logger?: {
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
}

// ============================================
// Results
// ============================================

export type PaidUseErrorCode =
  | "invalid_request"
  | "agent_not_found"
  | "not_a_member"
  | "own_agent"
  | "not_for_sale"
  | "not_offered"
  | "results_only"
  | "use_not_started"
  | "pricing_changed"
  | "subscription_lapsed"
  | "plan_ended"
  | "insufficient_credits"
  | "api_key_use_price_cap_exceeded"
  | "api_key_daily_cap_exceeded"
  | "api_key_spend_caps_missing"
  | "not_a_task_agent"
  | "not_a_scheduled_agent"
  | "input_too_large"
  | "input_invalid"
  | "rate_limited"
  | "too_many_refunds"
  | "client_closed_request"
  | "model_error"
  | "answer_withheld"
  | "agent_unavailable"
  | "agent_paused"
  | "rate_limiter_unavailable";

/** What the listing asks now. Cents, as numbers. */
export interface PaidUseTerms {
  pricingModel: string;
  pricePerRequestCents: number | null;
  monthlyPriceCents: number | null;
  /** What one payment buys. */
  unit: "message" | "run" | "month";
  /** Whether the creator keeps a copy of what is sent and answered. */
  keepsCopy: boolean;
}

/** Everything a buyer is told about a use that was not answered. */
export interface PaidUseRefusal {
  status: 400 | 402 | 403 | 404 | 409 | 413 | 422 | 429 | 499 | 502 | 503;
  code: PaidUseErrorCode;
  /** Plain words for the payer: the price and their balance may be in it. */
  message: string;
  /** rate_limited: `org` is the buyer's own limit, `agent` the agent's. */
  scope?: "org" | "agent";
  /** Also the Retry-After header. */
  retryAfterSeconds?: number;
  /** input_invalid: each answer that needs another look, in the order of the form. */
  details?: TaskInputIssue[];
  /** The buyer's access, where the licence decided. */
  access?: UseAccess;
  /** use_not_started and pricing_changed: what the listing asks now. */
  terms?: PaidUseTerms;
  /** insufficient_credits: what one use costs, and what the buyer has. */
  priceCents?: number;
  balanceCents?: number;
  /** What was charged for this use and given back. */
  refundedCents?: number;
  /** A key cap: the price and the cap it met. */
  caps?: Record<string, number>;
}

export interface PaidUseBilling {
  /** What this use cost: 0 inside a paid month. */
  chargedCents: number;
  /** The buyer's credits after it; null when they could not be read just now. */
  balanceCents: number | null;
  access: "subscribed" | "listing_pricing";
}

export interface PaidStream {
  kind: "stream";
  /**
   * The whole answer in the public encoding (lib/publicSse.ts), after one
   * `{"wheelsai":{"billing":{...}}}` event. Checked before it was built.
   */
  chat: ChatStream;
  /** The charge. The caller MUST forward the stream with streamToReply / forwardAndSettle and this meter. */
  meter: SettleableMeter | null;
  billing: PaidUseBilling;
  /** Call with the outcome forwardAndSettle returned (it knows about delivery). Never throws. */
  finished(outcome: StreamOutcome): Promise<void>;
}

export type PaidChatResult =
  | { kind: "refused"; refusal: PaidUseRefusal }
  | {
      kind: "answer";
      message: { role: "assistant"; content: string };
      toolCalls: PublicToolCall[];
      billing: PaidUseBilling;
    }
  | PaidStream;

export type PaidTaskResult =
  | { kind: "refused"; refusal: PaidUseRefusal }
  | {
      kind: "result";
      output: { format: "text"; text: string };
      toolCalls: PublicToolCall[];
      billing: PaidUseBilling;
    }
  | PaidStream;

export type PaidResultsResult =
  | { kind: "refused"; refusal: PaidUseRefusal }
  | { kind: "results"; results: Array<{ finishedAt: string; text: string }>; hasMore: boolean };

export interface UseAccessView {
  access: UseAccess | "own_agent";
  listingId: string;
  /** What the listing asks now; null when use of it is not on sale. */
  terms: PaidUseTerms | null;
  /** What the caller agreed to; null when they have not started. */
  accepted: { pricingModel: string | null; pricePerRequestCents: number | null; monthlyPriceCents: number | null } | null;
  /**
   * `graceEndsAt` is set while a renewal that failed is still being retried:
   * the day access ends unless credits are added before it.
   */
  subscription: {
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    graceEndsAt: string | null;
  } | null;
  balanceCents: number;
  /**
   * Whether this caller may agree to a price: an owner or admin, or a key
   * granted marketplace:install by name. False for everybody while
   * `startBlocked` is set.
   */
  canAccept: boolean;
  /**
   * Set when a start would be refused because the caller's organization
   * holds a copy of this agent with a month paid for: the code and sentence
   * of that refusal, and the day the copy's month ends. null otherwise.
   */
  startBlocked: { code: typeof COPY_MONTH_BLOCKS_USE; message: string; until: string } | null;
  /**
   * The listing is paused at this moment: the model its agent runs on is
   * not running, so nobody can start and nobody is charged. The other
   * fields stay what they are while it is true.
   */
  paused: boolean;
}

export type UseAccessResult = { kind: "refused"; refusal: PaidUseRefusal } | { kind: "access"; view: UseAccessView };

/** The JSON body of a refusal. */
export function paidRefusalBody(refusal: PaidUseRefusal): Record<string, unknown> {
  return {
    error: refusal.code,
    message: refusal.message,
    ...(refusal.scope !== undefined && { scope: refusal.scope }),
    ...(refusal.retryAfterSeconds !== undefined && { retryAfterSeconds: refusal.retryAfterSeconds }),
    ...(refusal.details !== undefined && { details: refusal.details }),
    ...(refusal.access !== undefined && { access: refusal.access }),
    ...(refusal.terms !== undefined && { terms: refusal.terms }),
    ...(refusal.priceCents !== undefined && { priceCents: refusal.priceCents }),
    ...(refusal.balanceCents !== undefined && { balanceCents: refusal.balanceCents }),
    ...(refusal.refundedCents !== undefined && { refundedCents: refusal.refundedCents }),
    ...refusal.caps,
  };
}

// ============================================
// Words
// ============================================

const dollars = (cents: bigint | number) => `$${(Number(cents) / 100).toFixed(2)}`;

/** What a buyer is told. No em dashes, and never "nothing was charged" after a charge. */
export const PAID_USE_MESSAGES = {
  notFound: "This agent was not found.",
  notAMember: "You are no longer a member of this organization, so you cannot use this agent on its behalf.",
  ownAgent: "This is your agent. This is the page people who pay see.",
  freeOnItsPage: "This agent is free to use on its page, so there is nothing to pay for here.",
  notForSale: "Use of this agent is not for sale.",
  resultsOnly: "This agent runs on its own. Subscribers read its results on its page.",
  notScheduled: "This agent does not run on its own, so it has no results to read. Use it on its page.",
  invalidChatBody: "Send { messages: [...] } with user and assistant text messages. Nothing else is accepted here.",
  invalidTaskBody: "Send your answers as { input: { ... } }. Nothing else is accepted here.",
  notEnoughCredits: (unit: UseUnit, price: bigint) =>
    `You do not have enough credits for this ${unit} (${dollars(price)}). Nothing was charged. Add credits to continue.`,
  buyerMinute: "You are sending requests faster than this agent allows. Try again in a minute.",
  buyerDay: (perDay: number) => `You have used this agent ${perDay} times today. Try again tomorrow.`,
  agentLimit: "This agent has reached its limit for now. Nothing was charged. Try again later.",
  tooManyRefunds: "Several of your answers could not be delivered today. Try again tomorrow.",
  unavailable: "This agent cannot be used right now. Nothing was charged. Try again later.",
  planNotReady: "Your plan cannot be used here yet. Nothing was charged and no use was taken from your plan.",
  // AGENT_PAUSED_MESSAGE of services/listingPause.ts, word for word. Said
  // again here because this file imports nothing that reads the environment
  // or the database; a test holds the two together.
  paused: "This agent is paused right now. Nothing was charged.",
  limiterUnavailable: "This agent is temporarily unavailable. Nothing was charged. Try again shortly.",
  restarting: "This agent is restarting. Nothing was charged. Try again in a moment.",
  cancelled: "The request was cancelled.",
  couldNotAnswer: (refunded: bigint | null) =>
    refunded === null
      ? "The agent could not answer just now. Please try again."
      : `The agent could not answer just now. Your ${dollars(refunded)} was refunded.`,
  withheld: (refunded: bigint | null) =>
    refunded === null
      ? "This answer could not be shown."
      : `This answer could not be shown. Your ${dollars(refunded)} was refunded.`,
  restartedMidway: (refunded: bigint | null) =>
    refunded === null
      ? "This agent is restarting. Try again in a moment."
      : `This agent is restarting. Your ${dollars(refunded)} was refunded. Try again in a moment.`,
} as const;

// ============================================
// Refusals
// ============================================

/** A refusal thrown out of the core's `admit` hook; caught in runPaidUse. */
class PaidAdmissionRefused extends Error {
  constructor(readonly refusal: PaidUseRefusal) {
    super(refusal.code);
    this.name = "PaidAdmissionRefused";
  }
}

type Refused = { kind: "refused"; refusal: PaidUseRefusal };
const refused = (refusal: PaidUseRefusal): Refused => ({ kind: "refused", refusal });

const NOT_FOUND: PaidUseRefusal = { status: 404, code: "agent_not_found", message: PAID_USE_MESSAGES.notFound };
const NOT_A_MEMBER: PaidUseRefusal = { status: 403, code: "not_a_member", message: PAID_USE_MESSAGES.notAMember };
const OWN_AGENT: PaidUseRefusal = { status: 409, code: "own_agent", message: PAID_USE_MESSAGES.ownAgent };
const UNAVAILABLE: PaidUseRefusal = { status: 503, code: "agent_unavailable", message: PAID_USE_MESSAGES.unavailable };
const PLAN_NOT_READY: PaidUseRefusal = {
  status: 503,
  code: "agent_unavailable",
  message: PAID_USE_MESSAGES.planNotReady,
};
const PAUSED: PaidUseRefusal = { status: 503, code: "agent_paused", message: PAID_USE_MESSAGES.paused };
const CLIENT_GONE_REFUSAL: PaidUseRefusal = {
  status: 499,
  code: "client_closed_request",
  message: PAID_USE_MESSAGES.cancelled,
};

function termsOf(listing: UseListingRow, agent: PaidAgent): PaidUseTerms {
  return {
    pricingModel: listing.pricingModel,
    pricePerRequestCents: listing.pricePerRequestCents == null ? null : Number(listing.pricePerRequestCents),
    monthlyPriceCents: listing.monthlyPriceCents == null ? null : Number(listing.monthlyPriceCents),
    unit: listing.pricingModel === "monthly" ? "month" : agent.agentKind === "task" ? "run" : "message",
    keepsCopy: agent.pageKey?.storeTranscripts === true,
  };
}

/**
 * A limiter refusal in a buyer's words. The buyer's own limits are told as
 * what they are; the status, the code and the wait are the limiter's.
 */
function limitRefusal(
  told: { status: number; code: string; scope?: string; retryAfterSeconds?: number },
  limits: PaidUseLimits,
): PaidUseRefusal {
  if (told.code !== "rate_limited") {
    return {
      status: 503,
      code: "rate_limiter_unavailable",
      message: PAID_USE_MESSAGES.limiterUnavailable,
      retryAfterSeconds: told.retryAfterSeconds ?? 30,
    };
  }
  const wait = told.retryAfterSeconds ?? MINUTE;
  if (told.scope === "agent") {
    return { status: 429, code: "rate_limited", message: PAID_USE_MESSAGES.agentLimit, scope: "agent", retryAfterSeconds: wait };
  }
  return {
    status: 429,
    code: "rate_limited",
    // A per-minute counter never asks for a longer wait than a minute.
    message: wait > MINUTE ? PAID_USE_MESSAGES.buyerDay(limits.perBuyerPerDay) : PAID_USE_MESSAGES.buyerMinute,
    scope: "org",
    retryAfterSeconds: wait,
  };
}

/** A refused charge, exactly as chargeUse worded it. Nothing was written. */
function chargeRefusal(refusal: Exclude<UseChargeResult, { ok: true }>): PaidUseRefusal {
  if (refusal.reason === "insufficient_credits") {
    return {
      status: 402,
      code: "insufficient_credits",
      message: refusal.message,
      priceCents: Number(refusal.requiredCents),
      balanceCents: Number(refusal.balanceCents),
    };
  }
  if (refusal.reason === "api_key_cap") {
    return { status: 403, code: refusal.code, message: refusal.message, caps: refusal.extra };
  }
  return OWN_AGENT;
}

/**
 * The core's refusal, as the payer hears it. Nothing was charged on any of
 * these: the charge is the core's last step that can refuse, and its own
 * refusal is read from the metering, not from here.
 */
function coreRefusal(refusal: AgentChatRefusal, nowSeconds: number, onSaleForUse: boolean): PaidUseRefusal {
  switch (refusal.kind) {
    case "agent_not_found":
      return NOT_FOUND;
    case "rate_limited": {
      // The creator's free-model allowance: how much of it is used is theirs to know.
      const { remaining, resetAt } = refusal.limit;
      const reset = remaining.rpd <= 0 ? resetAt.rpd : resetAt.rpm;
      return {
        status: 429,
        code: "rate_limited",
        message: PAID_USE_MESSAGES.agentLimit,
        scope: "agent",
        retryAfterSeconds: Math.max(1, Math.ceil(reset - nowSeconds)),
      };
    }
    case "shutting_down":
      return { status: 503, code: "agent_unavailable", message: PAID_USE_MESSAGES.restarting, retryAfterSeconds: 5 };
    case "client_gone":
      return CLIENT_GONE_REFUSAL;
    // The core's own messages name the model, the provider key that is
    // missing or the listing: none of it is the buyer's to read.
    case "invalid_request":
    case "not_configured":
    case "model_invalid":
    case "licence_revoked":
    case "payment_required":
      return UNAVAILABLE;
    // The model the agent runs on, one its organization runs itself, is not
    // running: the listing is paused (services/listingPause.ts). The core
    // refused before any charge, and nothing more is read to say so. Only a
    // published listing that sells use can be paused: a buyer finishing a
    // month on a listing that was taken down hears the general sentence.
    case "hosted_model_unavailable":
      return onSaleForUse ? PAUSED : UNAVAILABLE;
  }
}

/** A use that was admitted and produced no answer. Its charge, if any, has been refunded. */
function failureRefusal(failure: AgentChatFailure, refunded: bigint | null): PaidUseRefusal {
  const back = refunded === null ? {} : { refundedCents: Number(refunded) };
  if (failure.code === "client_gone") return { ...CLIENT_GONE_REFUSAL, ...back };
  if (failure.code === "service_unavailable") {
    return {
      status: 503,
      code: "agent_unavailable",
      message: PAID_USE_MESSAGES.restartedMidway(refunded),
      retryAfterSeconds: 5,
      ...back,
    };
  }
  // Everything else is the model's or ours, and its text is the provider's.
  return { status: 502, code: "model_error", message: PAID_USE_MESSAGES.couldNotAnswer(refunded), ...back };
}

// ============================================
// Shared steps
// ============================================

function handleOf(raw: string): string | null {
  const handle = typeof raw === "string" ? raw.toLowerCase() : "";
  return HANDLE.test(handle) ? handle : null;
}

type Listed =
  | { ok: false; refusal: PaidUseRefusal }
  | { ok: true; agent: PaidAgent; listing: UseListingRow; own: boolean };

/** Step 4: the agent by handle, and its one listing. */
async function loadListed(deps: PaidUseDeps, caller: PaidCaller, handle: string): Promise<Listed> {
  const agent = await deps.loadAgentByHandle(handle);
  if (!agent) return { ok: false, refusal: NOT_FOUND };
  const own = agent.orgId === caller.orgId;
  const listing = await deps.loadListing(agent.id);
  if (!listing) {
    // An agent that is neither public nor listed is nobody's to learn of.
    if (!own && !agent.isPublic) return { ok: false, refusal: NOT_FOUND };
    return {
      ok: false,
      refusal: own ? OWN_AGENT : { status: 409, code: "not_for_sale", message: PAID_USE_MESSAGES.notForSale },
    };
  }
  return { ok: true, agent, listing, own };
}

/** A conversation id for a kept copy: the buyer's own, apart from every other buyer's. */
function transcriptSessionOf(orgId: string, sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  return `paid-${createHash("sha256").update(orgId).digest("hex").slice(0, 16)}-${sessionId}`;
}

/** The agent's tools, less the outbound ones the listing does not name. */
export function paidToolAllowlist(
  tools: unknown,
  outbound: readonly string[],
  allowed: readonly string[],
): string[] {
  const names = (Array.isArray(tools) ? tools : [])
    .map((tool) => (tool as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return names.filter((name) => !outbound.includes(name) || allowed.includes(name));
}

const encoder = new TextEncoder();

/** The public stream, after one event that says what the use cost. */
function withBillingEvent(chat: ChatStream, billing: PaidUseBilling): ChatStream {
  const first = encoder.encode(`data: ${JSON.stringify({ wheelsai: { billing } })}\n\n`);
  const stream = chat.stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controller.enqueue(first);
      },
    }),
  );
  return { stream, outcome: chat.outcome };
}

// ============================================
// One paid use
// ============================================

interface Answered {
  kind: "answered";
  text: string;
  toolCalls: PublicToolCall[];
  billing: PaidUseBilling;
}

type UseKind = "chat" | "task";

async function runPaidUse(
  kind: UseKind,
  input: PaidUseInput,
  deps: PaidUseDeps,
): Promise<Refused | Answered | PaidStream> {
  const now = (deps.now ?? (() => new Date()))();
  const day = utcDay(now);
  const dayLeft = secondsLeftInUtcDay(now);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const { caller } = input;
  const { limits } = deps;
  const unit: UseUnit = kind === "task" ? "run" : "message";

  const consume = async (rules: LimitRule[]): Promise<PaidUseRefusal | null> => {
    const told = await consumePublicLimit(deps.limiter, rules, "paid", deps.logger);
    return told ? limitRefusal(told, limits) : null;
  };

  // 1. Still a member. The session's token says which organization pays; it
  // is not withdrawn when the person is removed from it, so the membership
  // is read as it is now, before anything is counted or looked up. A read
  // that fails refuses. A key belongs to the organization, not to a person.
  if (caller.type === "jwt") {
    if (!caller.userId) return refused(NOT_A_MEMBER);
    let role: string | null;
    try {
      role = await deps.memberRole(caller.orgId, caller.userId);
    } catch (err) {
      deps.logger?.error({ err }, "paid use refused: the caller's membership could not be read");
      return refused(UNAVAILABLE);
    }
    if (role === null) return refused(NOT_A_MEMBER);
  }

  // 2. The buyer's limits, on the handle in the address. Nothing has been
  // looked up: a handle that cannot exist is not counted and not looked up.
  const handle = handleOf(input.handle);
  if (!handle) return refused(NOT_FOUND);

  const undeliveredKey = paidUseKeys.undeliveredDay(caller.orgId, handle, day);
  const undelivered = await deps.limiter.peek(undeliveredKey);
  if (undelivered === null) {
    deps.logger?.error({ surface: "paid" }, "paid use refused: the rate limiter is unavailable");
    return refused(limitRefusal({ status: 503, code: "rate_limiter_unavailable" }, limits));
  }
  if (undelivered >= limits.undeliveredRefundsPerDay) {
    return refused({
      status: 429,
      code: "too_many_refunds",
      message: PAID_USE_MESSAGES.tooManyRefunds,
      retryAfterSeconds: dayLeft,
    });
  }
  const buyerLimit = await consume([
    {
      scope: "org",
      key: paidUseKeys.buyerMinute(caller.orgId, handle),
      limit: limits.perBuyerPerMinute,
      windowSeconds: MINUTE,
    },
    {
      scope: "org",
      key: paidUseKeys.buyerDay(caller.orgId, handle, day),
      limit: limits.perBuyerPerDay,
      windowSeconds: dayLeft,
    },
  ]);
  if (buyerLimit) return refused(buyerLimit);

  // 3. The body is read here, not trusted: no lookup depends on it yet.
  const parsed =
    kind === "chat" ? publicChatBodySchema.safeParse(input.body) : publicTaskBodySchema.safeParse(input.body);
  if (!parsed.success) {
    return refused({
      status: 400,
      code: "invalid_request",
      message: kind === "chat" ? PAID_USE_MESSAGES.invalidChatBody : PAID_USE_MESSAGES.invalidTaskBody,
    });
  }
  const chatBody = kind === "chat" ? (parsed.data as z.infer<typeof publicChatBodySchema>) : null;
  const taskBody = kind === "task" ? (parsed.data as z.infer<typeof publicTaskBodySchema>) : null;
  const wantsStream = parsed.data.stream !== false;

  // 4. The agent and its listing.
  const listed = await loadListed(deps, caller, handle);
  if (!listed.ok) return refused(listed.refusal);
  const { agent, listing } = listed;
  // The creator never pays to use their own agent, whatever rows exist.
  if (listed.own) return refused(OWN_AGENT);
  const onSaleForUse = listing.status === "published" && listing.sells === "use";
  if (onSaleForUse && listing.pricingModel === "free") {
    return refused({ status: 409, code: "not_for_sale", message: PAID_USE_MESSAGES.freeOnItsPage });
  }

  // A use that would not be the agent's own work is not run: a graph meters
  // itself by looking a copy up, and here there is none. A self-running
  // agent sells its results, not a conversation.
  if (agent.entrypoint === "graph") return refused(UNAVAILABLE);
  if (kind === "chat" && agent.agentKind === "scheduled") {
    return refused({ status: 409, code: "results_only", message: PAID_USE_MESSAGES.resultsOnly });
  }

  // 5. The licence and its access.
  const { licence, sub } = await deps.loadLicence({ listingId: listing.id, buyerId: caller.orgId });
  const billing: UseBilling = resolveUseBilling({ callerOrgId: caller.orgId, listing, licence, sub, unit }, now);
  if (billing.kind === "refused") {
    return refused({
      status: billing.status,
      code: billing.code,
      message: billing.code === "own_agent" ? PAID_USE_MESSAGES.ownAgent : billing.message,
      ...(billing.access !== undefined && { access: billing.access }),
      ...((billing.code === "use_not_started" || billing.code === "pricing_changed") &&
        onSaleForUse && { terms: termsOf(listing, agent) }),
    });
  }
  if (billing.kind === "free") {
    return refused({ status: 409, code: "not_for_sale", message: PAID_USE_MESSAGES.freeOnItsPage });
  }
  // A use on a plan is counted, and the count is not connected here yet.
  // Refused before the balance, the model and any charge, so no use runs
  // uncounted and nothing is taken.
  if (billing.kind === "plan") return refused(PLAN_NOT_READY);

  const apiKeyId = caller.type === "api_key" ? (caller.apiKeyId ?? null) : null;
  if (billing.kind === "billable") {
    // Read, not taken: the charge itself is step 8 and still decides. A
    // request that cannot be paid for stops here, before the creator's
    // allowance is touched.
    let balance: bigint;
    try {
      balance = await deps.readBalance(caller.orgId);
    } catch (err) {
      deps.logger?.error({ err }, "paid use refused: the buyer's balance could not be read");
      return refused(UNAVAILABLE);
    }
    if (balance < billing.priceCents) {
      return refused({
        status: 402,
        code: "insufficient_credits",
        message: PAID_USE_MESSAGES.notEnoughCredits(unit, billing.priceCents),
        priceCents: Number(billing.priceCents),
        balanceCents: Number(balance),
      });
    }
    if (caller.type === "api_key") {
      const peek: SpendPeek = apiKeyId
        ? await deps.peekKeySpend({ apiKeyId, orgId: caller.orgId, priceCents: billing.priceCents })
        : {
            ok: false,
            code: "api_key_spend_caps_missing",
            message: "This API key has no spend caps for paid agents, so it cannot pay to use one. Create a key with agents:use and both caps.",
            extra: {},
          };
      if (!peek.ok) {
        return refused({ status: 403, code: peek.code as PaidUseErrorCode, message: peek.message, caps: peek.extra });
      }
    }
  }

  // 6. Task only: the answers against the form. Nothing has been spent.
  let messages: AgentChatInput["messages"];
  let systemAddendum: string;
  let sentText: string;
  if (taskBody) {
    let check: TaskInputCheck;
    try {
      check = checkTaskInput(agent, taskBody.input);
    } catch (err) {
      // The agent's own form does not compile: its owner's to fix.
      deps.logger?.error({ err, agentId: agent.id }, "paid run refused: the agent's form cannot be read");
      return refused(UNAVAILABLE);
    }
    if (!check.ok) {
      return refused({
        status: TASK_REFUSAL_STATUS[check.code],
        code: check.code,
        message: check.message,
        ...(check.code === "input_invalid" && { details: check.details }),
      });
    }
    const brief = buildTaskBrief(agent, check.input);
    messages = [{ role: "user", content: brief.brief }];
    systemAddendum = brief.systemAddendum;
    sentText = brief.text;
  } else {
    messages = chatBody!.messages;
    systemAddendum = CONFIDENTIAL_CHAT_RULES;
    sentText = chatBody!.messages[chatBody!.messages.length - 1]!.content;
  }
  const promptChars =
    (agent.systemPrompt?.length ?? 0) +
    systemAddendum.length +
    messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);

  // 7-8. In the chat core: the model, the agent's per-minute limit, the
  // creator's free-model allowance, then the charge.
  const metering = deps.beginUse({
    agentId: agent.id,
    install: billing.kind === "billable" ? billing.install : null,
    apiKeyId,
    unit,
  });
  const chatInput: AgentChatInput = {
    caller: "public",
    source: "paid",
    // The creator's own agent, in the creator's organization.
    orgId: agent.orgId,
    agent: { id: agent.id },
    messages,
    systemAddendum,
    // The person asking is not the creator: what the creator's documents
    // are called is not theirs to learn, from the model or from a tool.
    hideSourceTitles: true,
    // Both narrows and allows: in the `hired` mode an outbound tool runs
    // only when this list names it.
    toolAllowlist: paidToolAllowlist(agent.tools, deps.outboundToolNames(), listing.useAllowedTools),
    signal: input.signal,
    // Output length is the agent's own setting.
    maxToolRounds: limits.maxToolRounds,
    deadlineMs: limits.timeLimitMs,
    admit: async () => {
      const agentLimit = await consume([
        {
          scope: "agent",
          key: paidUseKeys.agentMinute(agent.id),
          limit: limits.perAgentPerMinute,
          windowSeconds: MINUTE,
        },
      ]);
      if (agentLimit) throw new PaidAdmissionRefused(agentLimit);
    },
  };

  let prepared: PrepareAgentChatResult;
  try {
    prepared = await deps.prepareChat(chatInput, metering.beginMetering);
  } catch (err) {
    if (err instanceof PaidAdmissionRefused) return refused(err.refusal);
    throw err;
  }
  if (!prepared.ok) {
    const charge = metering.refusal();
    if (charge) return refused(chargeRefusal(charge));
    return refused(coreRefusal(prepared.refusal, nowSeconds, onSaleForUse));
  }
  const { session } = prepared;
  const charge = metering.charge();
  const charged = charge ? charge.grossCents : null;

  // Fail closed: a use that must be paid for and carries no charge does not
  // reach the model. Nor does a session that is not the agent's own chat.
  if (session.runtime !== "platform" || (billing.kind === "billable" && (!session.meter || !charge))) {
    await session.meter?.refund("the use could not be started");
    deps.logger?.error({ agentId: agent.id }, "paid use refused: a billable use reached its run without a charge");
    return refused(
      charge
        ? failureRefusal({ code: "upstream_error", message: "", retryAfterSeconds: null }, charge.grossCents)
        : UNAVAILABLE,
    );
  }

  /** One more answer that was produced, paid for and not delivered. Best effort. */
  const countUndelivered = async (): Promise<void> => {
    if (!charge) return;
    await deps.limiter
      .consume([{ scope: "org", key: undeliveredKey, limit: COUNT_ONLY, windowSeconds: dayLeft }])
      .catch((err) => deps.logger?.warn({ err }, "failed to count an undelivered paid answer"));
  };

  /** Kept only when the creator turned "keep a copy" on. Never throws. */
  const delivered = async (text: string): Promise<void> => {
    const key = agent.pageKey;
    if (!key?.storeTranscripts || !deps.writeTranscript || text.length === 0) return;
    await deps
      .writeTranscript({
        orgId: agent.orgId,
        agentId: agent.id,
        widgetKeyId: key.id,
        sessionId: transcriptSessionOf(caller.orgId, chatBody?.sessionId),
        origin: null,
        userMessage: sentText,
        assistantMessage: text,
      })
      .catch((err) => deps.logger?.warn({ err, agentId: agent.id }, "failed to store a copy of a paid use"));
  };

  const billingNow = async (chargedCents: bigint | null): Promise<PaidUseBilling> => ({
    chargedCents: Number(chargedCents ?? 0n),
    balanceCents: await deps
      .readBalance(caller.orgId)
      .then((cents) => Number(cents))
      .catch(() => null),
    access: billing.access,
  });

  // 9. The run. Always the stream, whatever the caller asked for: the
  // session then leaves the charge open, and it is closed here, after the
  // check and on delivery.
  const started = await session.stream();
  if (!started.ok) {
    // The core has refunded the charge.
    return refused(
      started.refusal ? coreRefusal(started.refusal, nowSeconds, onSaleForUse) : failureRefusal(started.failure, charged),
    );
  }

  const instructions = [agent.systemPrompt];
  const held = await holdUntilChecked(started.chat, (text) => !detectInstructionLeak(text, instructions).leaked);

  // 11. No answer to deliver.
  if (!held.ok) {
    if (held.code === "answer_withheld") {
      await session.meter?.refund("the answer was withheld");
      await countUndelivered();
      return refused({
        status: 502,
        code: "answer_withheld",
        message: PAID_USE_MESSAGES.withheld(charged),
        ...(charged !== null && { refundedCents: Number(charged) }),
      });
    }
    await session.meter?.refund(held.outcome.error);
    const gone = held.outcome.code === "client_gone" || input.signal.aborted;
    return refused(
      failureRefusal(
        { code: gone ? "client_gone" : "upstream_error", message: "", retryAfterSeconds: null },
        charged,
      ),
    );
  }

  metering.noteRun({
    platformModel: session.platformModel,
    usage: held.outcome.usage,
    content: held.text,
    promptChars,
  });
  const toolCalls = publicToolCalls(held.outcome.toolCalls);

  if (!wantsStream) {
    // Produced and checked, but the caller left while it was: not delivered.
    if (input.signal.aborted) {
      await session.meter?.refund(CLIENT_GONE);
      await countUndelivered();
      return refused({ ...CLIENT_GONE_REFUSAL, ...(charged !== null && { refundedCents: Number(charged) }) });
    }
    // 10. Delivered.
    await session.meter?.settle();
    await delivered(held.text);
    return { kind: "answered", text: held.text, toolCalls, billing: await billingNow(charged) };
  }

  const streamBilling = await billingNow(charged);
  return {
    kind: "stream",
    chat: withBillingEvent(toPublicStream(held.chat), streamBilling),
    // 10-11. Only the socket knows whether the answer arrived.
    meter: session.meter,
    billing: streamBilling,
    finished: async (outcome) => {
      if (outcome.ok) await delivered(held.text);
      else await countUndelivered();
    },
  };
}

/** One paid message to a creator's agent. Never throws for a refusal. */
export async function runPaidChat(input: PaidUseInput, deps: PaidUseDeps): Promise<PaidChatResult> {
  const result = await runPaidUse("chat", input, deps);
  if (result.kind !== "answered") return result;
  return {
    kind: "answer",
    message: { role: "assistant", content: result.text },
    toolCalls: result.toolCalls,
    billing: result.billing,
  };
}

/** One paid run of a creator's task agent. Never throws for a refusal. */
export async function runPaidTask(input: PaidUseInput, deps: PaidUseDeps): Promise<PaidTaskResult> {
  const result = await runPaidUse("task", input, deps);
  if (result.kind !== "answered") return result;
  return {
    kind: "result",
    output: { format: "text", text: result.text },
    toolCalls: result.toolCalls,
    billing: result.billing,
  };
}

// ============================================
// A self-running agent's results
// ============================================

/** Whether the caller's own use licence is inside a month that was paid for. */
function paidMonthRunning(
  caller: PaidCaller,
  listing: UseListingRow,
  licence: UseBillingLicence | null,
  sub: PaidSubscription | null,
  now: Date,
): boolean {
  if (!licence || licence.buyerId !== caller.orgId) return false;
  const access = useAccess(
    {
      licence: {
        kind: licence.kind,
        status: licence.status,
        accepted: {
          pricingModel: licence.acceptedPricingModel,
          pricePerRequestCents: licence.acceptedPricePerRequestCents,
        },
      },
      listing,
      sub,
    },
    now,
  );
  return access === "subscribed";
}

/**
 * The last results of a self-running agent's own schedule, for a
 * subscriber inside a paid month or its owner. On a free listing anyone
 * signed in reads what the agent's page shows, and no more: nothing when
 * the owner switched "show results" off, otherwise the page's few results
 * at the page's length. When each finished and its text: never an input,
 * a prompt, a failed run's reason, a delivery place or an id.
 */
export async function listPaidResults(input: PaidReadInput, deps: PaidUseDeps): Promise<PaidResultsResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { caller } = input;
  const handle = handleOf(input.handle);
  if (!handle) return refused(NOT_FOUND);

  const told = await consumePublicLimit(
    deps.limiter,
    [
      {
        scope: "org",
        key: paidUseKeys.resultsMinute(caller.orgId, handle),
        limit: deps.limits.resultsPerMinute,
        windowSeconds: MINUTE,
      },
    ],
    "paid",
    deps.logger,
  );
  if (told) {
    const refusal = limitRefusal(told, deps.limits);
    return refused(refusal.code === "rate_limited" ? { ...refusal, message: PAID_USE_MESSAGES.buyerMinute } : refusal);
  }

  const agent = await deps.loadAgentByHandle(handle);
  if (!agent) return refused(NOT_FOUND);
  const own = agent.orgId === caller.orgId;
  const listing = await deps.loadListing(agent.id);
  if (!listing && !own) {
    return refused(
      agent.isPublic ? { status: 409, code: "not_for_sale", message: PAID_USE_MESSAGES.notForSale } : NOT_FOUND,
    );
  }
  if (agent.agentKind !== "scheduled") {
    return refused({ status: 409, code: "not_a_scheduled_agent", message: PAID_USE_MESSAGES.notScheduled });
  }

  // A free listing's results are the public page's, read while signed in.
  let asThePage = false;
  if (!own && listing) {
    const { licence, sub } = await deps.loadLicence({ listingId: listing.id, buyerId: caller.orgId });
    const billing = resolveUseBilling({ callerOrgId: caller.orgId, listing, licence, sub }, now);
    if (billing.kind === "refused") {
      const onSaleForUse = listing.status === "published" && listing.sells === "use";
      return refused({
        status: billing.status,
        code: billing.code,
        message: billing.message,
        ...(billing.access !== undefined && { access: billing.access }),
        ...((billing.code === "use_not_started" || billing.code === "pricing_changed") &&
          onSaleForUse && { terms: termsOf(listing, agent) }),
      });
    }
    // Results are sold by the month. A price per use on a self-running
    // agent is refused where it is set; it buys nothing here.
    // A plan is uses of an agent that answers, never results: refused the same way.
    if (billing.kind === "billable" || billing.kind === "plan") {
      return refused({
        status: 409,
        code: "not_offered",
        message: "This agent's results are read with a subscription. Nothing was charged.",
      });
    }
    // Free, unless a month paid for before the listing went free is still
    // running: that month keeps what it bought.
    asThePage = billing.kind === "free" && !paidMonthRunning(caller, listing, licence, sub, now);
  }

  // The owner's switch on the page decides for a free listing: off shows
  // nobody a result, here as on the page, and none is read.
  if (asThePage && agent.publicResults !== true) return { kind: "results", results: [], hasMore: false };
  const limit = asThePage ? PUBLIC_RESULTS_LIMIT : PAID_RESULTS_LIMIT;

  const rows = await deps.latestResults({
    orgId: agent.orgId,
    agentId: agent.id,
    limit: limit + 1,
    maxChars: asThePage ? PUBLIC_RESULT_MAX_CHARS : PAID_RESULT_MAX_CHARS,
  });
  return {
    kind: "results",
    // Built field by field: whatever else a row carries stays here.
    results: rows.slice(0, limit).map((row) => ({
      finishedAt: row.finishedAt.toISOString(),
      text: row.text,
    })),
    hasMore: rows.length > limit,
  };
}

// ============================================
// What the caller may do
// ============================================

/** Whether this caller may agree to a price: an owner or admin, or a key granted marketplace:install by name. */
async function canAccept(deps: PaidUseDeps, caller: PaidCaller): Promise<boolean> {
  // A spend scope is held only by a key that lists it by name.
  if (caller.type === "api_key") return (caller.scopes ?? []).includes("marketplace:install");
  if (!caller.userId) return false;
  try {
    const role = await deps.memberRole(caller.orgId, caller.userId);
    return role === "owner" || role === "admin";
  } catch (err) {
    deps.logger?.warn({ err }, "could not read a member's role; treated as not able to accept a price");
    return false;
  }
}

/**
 * Whether the listing is paused at this moment. Nothing is decided by the
 * answer here (a start and a use ask for themselves), so when it cannot be
 * asked the page is told "not paused" and the request goes on.
 */
async function pausedNow(deps: PaidUseDeps, listing: UseListingRow, agent: PaidAgent): Promise<boolean> {
  try {
    const ask = deps.listingPaused ?? (await import("./paidUsePause.js")).paidListingPausedNow;
    return await ask({ listing, agent: { id: agent.id, orgId: agent.orgId } });
  } catch (err) {
    deps.logger?.warn({ err }, "could not ask whether the listing is paused; shown as not paused");
    return false;
  }
}

/** The caller's access to an agent that is, or was, sold for use. Reads only. */
export async function getUseAccess(input: PaidReadInput, deps: PaidUseDeps): Promise<UseAccessResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { caller } = input;
  const handle = handleOf(input.handle);
  if (!handle) return refused(NOT_FOUND);

  const agent = await deps.loadAgentByHandle(handle);
  if (!agent) return refused(NOT_FOUND);
  const listing = await deps.loadListing(agent.id);
  // An agent that was never listed has no terms and no access to describe.
  if (!listing) return refused(NOT_FOUND);

  const own = agent.orgId === caller.orgId;
  const onSaleForUse = listing.status === "published" && listing.sells === "use";
  const { licence, sub } = own
    ? { licence: null, sub: null }
    : await deps.loadLicence({ listingId: listing.id, buyerId: caller.orgId });
  const mine = licence && licence.buyerId === caller.orgId ? licence : null;
  const access: UseAccessView["access"] = own
    ? "own_agent"
    : useAccess(
        {
          licence: mine && {
            kind: mine.kind,
            status: mine.status,
            accepted: {
              pricingModel: mine.acceptedPricingModel,
              pricePerRequestCents: mine.acceptedPricePerRequestCents,
            },
          },
          listing,
          sub: mine ? sub : null,
        },
        now,
      );
  const balance = await deps.readBalance(caller.orgId);
  // A copy with a month paid for: a start would be refused (startUsing,
  // services/marketplace.ts), so the page is told before it offers one.
  const blockedUntil = copyMonthBlockingUse(mine, mine ? sub : null, now);

  return {
    kind: "access",
    view: {
      access,
      listingId: listing.id,
      terms: onSaleForUse ? termsOf(listing, agent) : null,
      accepted:
        mine && mine.kind === "use"
          ? {
              pricingModel: mine.acceptedPricingModel ?? null,
              pricePerRequestCents:
                mine.acceptedPricePerRequestCents == null ? null : Number(mine.acceptedPricePerRequestCents),
              monthlyPriceCents: sub?.priceCents == null ? null : Number(sub.priceCents),
            }
          : null,
      subscription:
        mine && sub
          ? {
              status: sub.status,
              currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
              // The same days of grace subscriptionGrantsAccess gives.
              graceEndsAt:
                sub.status === "past_due" && sub.cancelAtPeriodEnd !== true
                  ? new Date(sub.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString()
                  : null,
            }
          : null,
      balanceCents: Number(balance),
      canAccept: blockedUntil ? false : await canAccept(deps, caller),
      startBlocked: blockedUntil && {
        code: COPY_MONTH_BLOCKS_USE,
        message: copyMonthBlockingUseMessage(blockedUntil, now),
        until: blockedUntil.toISOString(),
      },
      // Only a listing that sells use now can be paused.
      paused: onSaleForUse ? await pausedNow(deps, listing, agent) : false,
    },
  };
}
