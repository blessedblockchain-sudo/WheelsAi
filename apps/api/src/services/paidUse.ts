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
 *    2. limits   the buyer's own for the minute, counted on the handle in
 *                the address on a limiter that fails closed, before
 *                anything is looked up. Everybody meets it, a buyer on a
 *                plan included.
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
 *   6b. the day  the buyer's own limit for the day, for a buyer who pays
 *                per use and for a month with no count; never for a buyer
 *                on a plan, whose count is what holds them. Taken after
 *                every refusal above, so none of them spends one of the
 *                day's uses, and before anything below takes something.
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
 * A use on a plan (a subscription with a count of uses) takes ONE use from
 * the count at step 8, where a priced use takes its price, and gives it back
 * in every ending of step 11. Past the count the plan stops (429
 * plan_used_up, nothing charged, no model call), or the use is charged the
 * extra price the buyer agreed to, exactly as a priced use is.
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
import type { TokenUsage } from "./jobRunner.js";
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
  onPlan,
  useAccess,
  type UseAccess,
  type UseSubscription,
} from "./useAccess.js";
import { onTrialPlan, TRIAL_PLAN_NAME } from "./listingPlans.js";
import {
  offersPlans,
  planOfferOf,
  trialOfferOf,
  type PlanOffer,
  type PlanOfferRow,
  type TrialOffer,
  type TrialOfferRow,
} from "./planOffers.js";
import { warningLevel } from "./planUse.js";
import type { PlanWarningAsk } from "./planWarnings.js";
import { PAST_DUE_GRACE_DAYS } from "./subscriptionAccess.js";
import { judgeTrial, trialUsed } from "./trialStart.js";
import type { UseListingRow } from "./useListing.js";
import {
  resolveUseBilling,
  type UseBilling,
  type UseBillingLicence,
  type UseChargeResult,
  type UsePlan,
  type UsePlanCount,
  type UsePlanRefusal,
  type UsePlanUse,
  type UseThing,
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
  /** On a plan: what its creator calls it now. */
  planName?: string | null;
  /**
   * When this buyer started the listing's free trial; null = never. A row
   * read without it offers no trial (services/trialStart.ts, trialUsed).
   */
  trialUsedAt?: Date | null;
}

/**
 * The metering of ONE use, bound to one licence and one decided charge
 * (services/useMeteringProduction.ts, beginUseMetering).
 */
export interface PaidUseMetering {
  /** Handed to the chat core as its `beginMetering`. */
  beginMetering: AgentChatDeps["beginMetering"];
  /** Why the charge, or the use of a plan, was refused, exactly; null when it was not. */
  refusal(): Exclude<UseChargeResult, { ok: true }> | UsePlanRefusal | null;
  /** The charge that was taken; null when none was. */
  charge(): MarketplaceCharge | null;
  /** On a plan: whether the use was an included one or an extra one, and the count after it. Null off a plan. */
  planUse(): UsePlanUse | null;
  /** Notes what the run used, for the model cost a settle repays. */
  noteRun(run: { platformModel: boolean; usage: unknown; content: string; promptChars: number }): void;
  /**
   * The same for a run of several model calls (a paid run of a workflow):
   * the sum of what they used on the platform's keys, already added up, or
   * null when none ran on them.
   */
  notePlatformUsage(usage: TokenUsage | null): void;
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
  /**
   * The listing's paid plans on offer, in the order a buyer sees them
   * (services/planOffers.ts). When omitted no reply names a plan to choose.
   */
  loadPlans?(listingId: string): Promise<PlanOfferRow[]>;
  /**
   * The listing's free trial on offer, or null (services/planOffers.ts).
   * When omitted no reply names a trial and none is available.
   */
  loadTrial?(listingId: string): Promise<TrialOfferRow | null>;
  /**
   * Whether the organization has added credits it paid for at least once
   * (services/trialStart.ts, hasAddedCredits): who may take a free trial.
   * Throws when it cannot be read. When omitted the answer is no.
   */
  addedCredits?(orgId: string): Promise<boolean>;
  /** The organization's credits, in cents. Throws when they cannot be read. */
  readBalance(orgId: string): Promise<bigint>;
  /** Whether a use of this price would fit the key's caps right now. A read. */
  peekKeySpend(args: { apiKeyId: string; orgId: string; priceCents: bigint }): Promise<SpendPeek>;
  /** The names of the tools that send a request to an address the model chooses. */
  outboundToolNames(): readonly string[];
  /**
   * The metering of one use. `install: null` is a subscribed use: nothing is
   * charged. `plan` is a use on a plan: the row as it was read, and the
   * charge target of a use past the count (null = the plan stops).
   */
  beginUse(args: {
    agentId: string;
    install: MeteredInstall | null;
    plan?: { read: UsePlan; extraInstall: MeteredInstall | null } | null;
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
   * The email a plan sends at 85% and at 100% of its uses, once for each
   * (services/planWarnings.ts, sendPlanWarning). Asked after an included use
   * was delivered and never waited for: it cannot delay, fail or change an
   * answer. When omitted no warning is sent.
   */
  warnPlan?(ask: PlanWarningAsk): Promise<unknown>;
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

/**
 * Every code a refusal of a paid use, or of a paid run of a workflow, can
 * carry. The one list: PaidUseErrorCode is made from it, so a code that is
 * not here is not a code, and what answers them on /v1
 * (services/openaiCompat.ts) is typed by it, so a code with no answer there
 * does not compile.
 */
export const PAID_USE_REFUSAL_CODES = [
  "invalid_request",
  "agent_not_found",
  "not_a_member",
  "own_agent",
  "not_for_sale",
  "not_offered",
  "results_only",
  "use_not_started",
  "pricing_changed",
  "subscription_lapsed",
  "plan_ended",
  "plan_used_up",
  "insufficient_credits",
  "api_key_use_price_cap_exceeded",
  "api_key_daily_cap_exceeded",
  "api_key_spend_caps_missing",
  "not_a_task_agent",
  "not_a_scheduled_agent",
  "input_too_large",
  "input_invalid",
  "rate_limited",
  "too_many_refunds",
  "client_closed_request",
  "model_error",
  "answer_withheld",
  "agent_unavailable",
  "agent_paused",
  "rate_limiter_unavailable",
  // A paid run of a workflow on sale (services/workflowListing.ts).
  "workflow_not_found",
  "own_workflow",
  "workflow_unavailable",
  "workflow_busy",
  "run_failed",
  "run_timed_out",
] as const;

export type PaidUseErrorCode = (typeof PAID_USE_REFUSAL_CODES)[number];

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
  status: 400 | 402 | 403 | 404 | 409 | 413 | 422 | 429 | 499 | 502 | 503 | 504;
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
  /** use_not_started, pricing_changed and plan_ended: what the listing asks now. */
  terms?: PaidUseTerms;
  /** plan_used_up and plan_ended: the plans the listing offers now, to choose from. */
  plans?: PlanOffer[];
  /** insufficient_credits: what one use costs, and what the buyer has. */
  priceCents?: number;
  balanceCents?: number;
  /** What was charged for this use and given back. */
  refundedCents?: number;
  /** A key cap: the price and the cap it met. */
  caps?: Record<string, number>;
  /** plan_used_up: when the plan's count starts again. An ISO time. Left out when the plan will not renew, and for a free trial. */
  resetsAt?: string;
  /**
   * plan_used_up: the count the refusal was decided on, for the usage headers
   * (services/usageHeaders.ts). Not part of the body: paidRefusalBody and the
   * OpenAI shape name their fields one by one and leave it out.
   */
  planCount?: PaidUsePlanCount;
  /**
   * A refusal that came after a charge was taken and given back (a paid run
   * of a workflow whose start found no room): a client must not send the
   * request again by itself, because each try is another charge and another
   * refund. Not part of the body. On /v1 it is the header an OpenAI SDK
   * obeys (services/openaiCompat.ts, paidUseOpenAiError).
   */
  noAutomaticRetry?: true;
}

/** A plan's count as it stood when a use was refused. Uses, and nothing of another buyer. */
export interface PaidUsePlanCount {
  /** The plan the subscription was started on. */
  id: string | null;
  includedUses: number;
  carriedUses: number;
  usedUses: number;
}

/** The buyer's plan after one use on it. Uses and cents, and nothing of another buyer. */
export interface PaidUsePlanBilling {
  /** The plan the subscription was started on. */
  id: string | null;
  /** `included`: one of the plan's uses. `extra`: past the count, charged the agreed extra price. */
  use: "included" | "extra";
  /**
   * True on the listing's free trial: its own uses are included ones and are
   * never charged. A use past them is `extra` only for a buyer who agreed to
   * the price per use themselves, and is charged that price. False on a paid plan.
   */
  trial: boolean;
  includedUses: number;
  /** Uses brought into this period by a move to a bigger plan. */
  carriedUses: number;
  usedUses: number;
  remainingUses: number;
  /** What each use past the count costs, as agreed. Null = the plan stops until it renews. */
  extraUsePriceCents: number | null;
  /** When the count starts again. An ISO time. Left out when the plan will not renew, and always for a free trial. */
  resetsAt?: string;
  /** 85 when 85% of the uses are gone, 100 when all are. */
  warning: null | 85 | 100;
}

export interface PaidUseBilling {
  /** What this use cost: 0 inside a paid month and for an included use of a plan, the extra price past its count. */
  chargedCents: number;
  /** The buyer's credits after it; null when they could not be read just now. */
  balanceCents: number | null;
  access: "subscribed" | "listing_pricing";
  /** Only on a plan. */
  plan?: PaidUsePlanBilling;
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

/** The plan the caller is on, as the page draws it. Uses and cents, and nothing of another buyer. */
export interface UseAccessPlan {
  /** The plan the subscription was started on. */
  id: string | null;
  /** What its creator calls it now. "Free trial" for the listing's free trial. */
  name: string;
  /** True on the listing's free trial, which costs nothing and never renews. When its uses are gone it stops, unless the buyer agreed to the price per use. False on a paid plan. */
  trial: boolean;
  includedUses: number;
  /** Uses brought into this period by a move to a bigger plan, on top of the included ones. 0 after a renewal. */
  carriedUses: number;
  usedUses: number;
  /** What is left of the period: the included uses and the carried ones, less the ones used. */
  remainingUses: number;
  /** What each use past the count costs, as agreed. Null = the plan stops until it renews. */
  extraUsePriceCents: number | null;
  /** When the count starts again. An ISO time. Left out when the plan will not renew, and always for a free trial. */
  resetsAt?: string;
  /** 85 when 85% of the uses are gone, 100 when all are. */
  warning: null | 85 | 100;
}

export interface UseAccessView {
  access: UseAccess | "own_agent";
  listingId: string;
  /** What the listing asks now; null when use of it is not on sale. */
  terms: PaidUseTerms | null;
  /** The plans the listing offers now, in the order they are shown. Empty when it offers none. */
  plans: PlanOffer[];
  /** The plan the caller is on, while it gives them uses. null otherwise. */
  plan: UseAccessPlan | null;
  /** The free trial the listing offers now, beside its plans: its id, its uses and its days. null when it offers none. */
  trial: TrialOffer | null;
  /**
   * Whether the caller's organization could start that trial now: the
   * listing offers one, the organization never started one on this listing,
   * it has no plan or paid month running on it, and it has added credits at
   * least once (services/trialStart.ts, judgeTrial). `canAccept` says
   * whether this caller is one who may start.
   */
  trialAvailable: boolean;
  /** True when the one thing missing for the trial is that the organization never added credits. */
  trialNeedsCredits: boolean;
  /** True when what ended (`access` is plan_ended) was the caller's free trial, not a paid plan. */
  trialEnded: boolean;
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
    ...(refusal.plans !== undefined && { plans: refusal.plans }),
    ...(refusal.priceCents !== undefined && { priceCents: refusal.priceCents }),
    ...(refusal.balanceCents !== undefined && { balanceCents: refusal.balanceCents }),
    ...(refusal.refundedCents !== undefined && { refundedCents: refusal.refundedCents }),
    ...(refusal.resetsAt !== undefined && { resetsAt: refusal.resetsAt }),
    ...refusal.caps,
  };
}

// ============================================
// Words
// ============================================

const dollars = (cents: bigint | number) => `$${(Number(cents) / 100).toFixed(2)}`;

/** "You have used all 500 uses.", and for a plan of one use, a sentence that reads right. */
const usedAll = (uses: number) => (uses === 1 ? "You have used the 1 use in your plan." : `You have used all ${uses} uses.`);

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
  planUsedUp: (uses: number, startsAgain: string | null) =>
    startsAgain === null
      ? `${usedAll(uses)} It starts again when your plan renews. Nothing was charged.`
      : `${usedAll(uses)} It starts again on ${startsAgain}. Nothing was charged.`,
  // The plan will not renew: no count starts again, so none is promised.
  planUsedUpAndEnding: (uses: number, endsOn: string | null) =>
    endsOn === null
      ? `${usedAll(uses)} Nothing was charged.`
      : `${usedAll(uses)} Your plan ends on ${endsOn}. Nothing was charged.`,
  // A free trial that stops: its count never starts again.
  trialUsedUp: (uses: number) =>
    `${uses === 1 ? "You have used the 1 use of your free trial." : `You have used all ${uses} uses of your free trial.`} Choose a plan or pay per use to keep using it. Nothing was charged.`,
  trialEnded: "Your free trial ended. Choose a plan or pay per use to keep using it.",
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
  /**
   * The sentences of a paid run of a WORKFLOW on sale, beside the agent's
   * above: its own where the words name what is used or what happened to a
   * run, and the agent's where they name neither (a plan's count, credits,
   * a withheld answer, a caller who left).
   */
  workflow: {
    notFound: "This workflow was not found.",
    notAMember: "You are no longer a member of this organization, so you cannot use this workflow on its behalf.",
    ownWorkflow: "This is your workflow. This is the page people who pay see.",
    notForSale: "Use of this workflow is not for sale.",
    buyerMinute: "You are sending requests faster than this workflow allows. Try again in a minute.",
    buyerDay: (perDay: number) => `You have used this workflow ${perDay} times today. Try again tomorrow.`,
    workflowLimit: "This workflow has reached its limit for now. Nothing was charged. Try again later.",
    unavailable: "This workflow cannot be run right now. Nothing was charged. Try again later.",
    limiterUnavailable: "This workflow is temporarily unavailable. Nothing was charged. Try again shortly.",
    // Refused before anything was taken: every paid run it can hold is going.
    busy: "This workflow is running as many times as it can right now. Nothing was charged. Try again in a minute.",
    // The same, found only after the charge: never "Nothing was charged".
    busyAfterCharge: (refunded: bigint | null) =>
      refunded === null
        ? "This workflow is running as many times as it can right now. Try again in a minute."
        : `This workflow is running as many times as it can right now. Your ${dollars(refunded)} was refunded. Try again in a minute.`,
    runFailed: (refunded: bigint | null) =>
      refunded === null
        ? "The workflow could not finish this run. Please try again."
        : `The workflow could not finish this run. Your ${dollars(refunded)} was refunded.`,
    runTimedOut: (refunded: bigint | null) =>
      refunded === null
        ? "The workflow took too long and was stopped. Please try again."
        : `The workflow took too long and was stopped. Your ${dollars(refunded)} was refunded.`,
    restartedMidway: (refunded: bigint | null) =>
      refunded === null
        ? "This workflow is restarting. Try again in a moment."
        : `This workflow is restarting. Your ${dollars(refunded)} was refunded. Try again in a moment.`,
  },
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

// What follows, down to "One paid use", is shared with the paid run of a
// workflow on sale: one set of refusals, sentences and billing shapes for
// both. `thing` chooses the noun where a sentence has one, and is "agent"
// when left out, so every call that names none says what it always said.

export type Refused = { kind: "refused"; refusal: PaidUseRefusal };
export const refused = (refusal: PaidUseRefusal): Refused => ({ kind: "refused", refusal });

const NOT_FOUND: PaidUseRefusal = { status: 404, code: "agent_not_found", message: PAID_USE_MESSAGES.notFound };
export const NOT_A_MEMBER: PaidUseRefusal = { status: 403, code: "not_a_member", message: PAID_USE_MESSAGES.notAMember };
const OWN_AGENT: PaidUseRefusal = { status: 409, code: "own_agent", message: PAID_USE_MESSAGES.ownAgent };
export const UNAVAILABLE: PaidUseRefusal = { status: 503, code: "agent_unavailable", message: PAID_USE_MESSAGES.unavailable };
const PAUSED: PaidUseRefusal = { status: 503, code: "agent_paused", message: PAID_USE_MESSAGES.paused };
export const CLIENT_GONE_REFUSAL: PaidUseRefusal = {
  status: 499,
  code: "client_closed_request",
  message: PAID_USE_MESSAGES.cancelled,
};

/** The caller's own workflow, and a workflow that cannot be run now: what the shared refusals answer for a workflow. */
const OWN_WORKFLOW: PaidUseRefusal = {
  status: 409,
  code: "own_workflow",
  message: PAID_USE_MESSAGES.workflow.ownWorkflow,
};
const WORKFLOW_UNAVAILABLE: PaidUseRefusal = {
  status: 503,
  code: "workflow_unavailable",
  message: PAID_USE_MESSAGES.workflow.unavailable,
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

/** Which of the buyer's own two rules a call to the limiter asked. */
export type BuyerRule = "minute" | "day";

/**
 * A limiter refusal in a buyer's words. The buyer's own limits are told as
 * what they are; the status, the code and the wait are the limiter's.
 * `rule` is the buyer's rule the call asked: each is asked in a call of its
 * own, so the one that refused is known and is not guessed from the wait.
 */
export function limitRefusal(
  told: { status: number; code: string; scope?: string; retryAfterSeconds?: number },
  limits: Pick<PaidUseLimits, "perBuyerPerDay">,
  rule: BuyerRule,
  thing: UseThing = "agent",
): PaidUseRefusal {
  const workflow = thing === "workflow" ? PAID_USE_MESSAGES.workflow : null;
  if (told.code !== "rate_limited") {
    return {
      status: 503,
      code: "rate_limiter_unavailable",
      message: workflow ? workflow.limiterUnavailable : PAID_USE_MESSAGES.limiterUnavailable,
      retryAfterSeconds: told.retryAfterSeconds ?? 30,
    };
  }
  const wait = told.retryAfterSeconds ?? MINUTE;
  if (told.scope === "agent") {
    return {
      status: 429,
      code: "rate_limited",
      message: workflow ? workflow.workflowLimit : PAID_USE_MESSAGES.agentLimit,
      scope: "agent",
      retryAfterSeconds: wait,
    };
  }
  const words = workflow ?? PAID_USE_MESSAGES;
  return {
    status: 429,
    code: "rate_limited",
    message: rule === "day" ? words.buyerDay(limits.perBuyerPerDay) : words.buyerMinute,
    scope: "org",
    retryAfterSeconds: wait,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** How long a buyer whose renewal is being retried is asked to wait: the renewal worker runs every hour. */
const RENEWAL_RETRY_SECONDS = 60 * 60;

/**
 * Every use of the plan's period is gone and the buyer agreed to no extra
 * price. Nothing was charged, no use was taken, and the model is not called.
 *
 * `renews` is whether the row will be charged again at its period's end. It
 * will not when the buyer cancelled the renewal, the creator ended the plan
 * or the listing no longer sells use: the row is closed then, no count
 * starts again, and the buyer is told when the plan ends and given no time
 * at which it resets.
 *
 * `trial` is whether the row is the listing's free trial. A trial never
 * starts again: its own sentence asks the buyer to choose, and no time is
 * told, in the body or as a wait.
 */
export function planUsedUpRefusal(
  plan: { planId: string | null; includedUses: number; carriedUses: number; usedInPeriod?: number; periodEnd: Date },
  now: Date,
  renews: boolean,
  trial: boolean,
): PaidUseRefusal {
  if (trial) {
    const uses = plan.includedUses + plan.carriedUses;
    return {
      status: 429,
      code: "plan_used_up",
      message: PAID_USE_MESSAGES.trialUsedUp(uses),
      planCount: {
        id: plan.planId,
        includedUses: plan.includedUses,
        carriedUses: plan.carriedUses,
        usedUses: plan.usedInPeriod ?? uses,
      },
    };
  }
  const left = Math.ceil((plan.periodEnd.getTime() - now.getTime()) / 1000);
  // Past its end and still open: the renewal is being retried, and the count
  // starts again when it is paid.
  const day = left > 0 ? `${plan.periodEnd.getUTCDate()} ${MONTHS[plan.periodEnd.getUTCMonth()]}` : null;
  const uses = plan.includedUses + plan.carriedUses;
  return {
    status: 429,
    code: "plan_used_up",
    message: renews ? PAID_USE_MESSAGES.planUsedUp(uses, day) : PAID_USE_MESSAGES.planUsedUpAndEnding(uses, day),
    retryAfterSeconds: left > 0 ? left : RENEWAL_RETRY_SECONDS,
    ...(renews && { resetsAt: plan.periodEnd.toISOString() }),
    // The count as the request read it. Where only "used up" is known (the
    // metering found it so on a fresh row), every use of the period is gone.
    planCount: {
      id: plan.planId,
      includedUses: plan.includedUses,
      carriedUses: plan.carriedUses,
      usedUses: plan.usedInPeriod ?? uses,
    },
  };
}

/** A refused charge, exactly as chargeUse worded it, or a plan with no use to take. Nothing was written. */
export function chargeRefusal(
  refusal: Exclude<UseChargeResult, { ok: true }> | UsePlanRefusal,
  now: Date,
  planRenews: boolean,
  planId: string | null,
  trial: boolean,
  thing: UseThing = "agent",
): PaidUseRefusal {
  // The metering refuses this only on the row the request read, so the plan is the one that was read.
  if (refusal.reason === "plan_used_up") return planUsedUpRefusal({ ...refusal, planId }, now, planRenews, trial);
  // The plan's row changed under the request and could not be decided again.
  if (refusal.reason === "plan_changed") return thing === "workflow" ? WORKFLOW_UNAVAILABLE : UNAVAILABLE;
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
  return thing === "workflow" ? OWN_WORKFLOW : OWN_AGENT;
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

/**
 * A use that was admitted and produced no answer. Its charge, if any, has
 * been refunded. For a workflow the same three endings carry the workflow's
 * codes and words: a run that failed is `run_failed`.
 */
export function failureRefusal(
  failure: AgentChatFailure,
  refunded: bigint | null,
  thing: UseThing = "agent",
): PaidUseRefusal {
  const back = refunded === null ? {} : { refundedCents: Number(refunded) };
  const workflow = thing === "workflow" ? PAID_USE_MESSAGES.workflow : null;
  if (failure.code === "client_gone") return { ...CLIENT_GONE_REFUSAL, ...back };
  if (failure.code === "service_unavailable") {
    return {
      status: 503,
      code: workflow ? "workflow_unavailable" : "agent_unavailable",
      message: (workflow ?? PAID_USE_MESSAGES).restartedMidway(refunded),
      retryAfterSeconds: 5,
      ...back,
    };
  }
  if (workflow) return { status: 502, code: "run_failed", message: workflow.runFailed(refunded), ...back };
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

/**
 * Whether a plan's row will be charged again when its period ends. The
 * renewal worker closes it instead when the buyer cancelled the renewal, the
 * creator ended the plan, or the listing no longer sells use per request
 * (services/marketplaceSubscriptions.ts). A free trial is never renewed,
 * whatever its row says. Only words, and whether a time to start again is
 * told, depend on it.
 */
export function planWillRenew(
  listing: Pick<UseListingRow, "status" | "sells" | "pricingModel">,
  sub: Pick<PaidSubscription, "cancelAtPeriodEnd" | "planRetired" | "includedUses" | "priceCents"> | null,
): boolean {
  if (onTrialPlan(sub)) return false;
  return offersPlans(listing) && sub?.cancelAtPeriodEnd !== true && sub?.planRetired !== true;
}

/**
 * The listing's plans on offer, as a buyer is told them. Undefined when this
 * set of deps reads none. A read that fails is answered as no plan: it rides
 * on a refusal or a view that is already decided, and must not undo it.
 */
export async function plansOnOffer(
  deps: Pick<PaidUseDeps, "loadPlans" | "logger">,
  listing: Pick<UseListingRow, "id" | "status" | "sells" | "pricingModel">,
): Promise<PlanOffer[] | undefined> {
  if (!deps.loadPlans) return undefined;
  if (!offersPlans(listing)) return [];
  try {
    return (await deps.loadPlans(listing.id)).map(planOfferOf);
  } catch (err) {
    deps.logger?.warn({ err }, "could not read the plans a listing offers; none were told");
    return [];
  }
}

/**
 * The listing's free trial on offer, as a buyer is told it; null when it
 * offers none, when this set of deps reads none, and when the read fails:
 * like the plans, it rides on an answer that is already decided.
 */
async function trialOnOffer(deps: PaidUseDeps, listing: UseListingRow): Promise<TrialOffer | null> {
  if (!deps.loadTrial || !offersPlans(listing)) return null;
  try {
    return trialOfferOf(await deps.loadTrial(listing.id));
  } catch (err) {
    deps.logger?.warn({ err }, "could not read the free trial a listing offers; none was told");
    return null;
  }
}

/** The plan after one use on it, as the buyer is told it. `trial`: the row the use was counted on is a free trial. */
export function planBillingOf(planUse: UsePlanUse, count: UsePlanCount, renews: boolean, trial: boolean): PaidUsePlanBilling {
  const limit = count.includedUses + count.carriedUses;
  const level = warningLevel(count.usedInPeriod, count.includedUses, count.carriedUses);
  return {
    id: count.planId,
    use: planUse.use,
    trial,
    includedUses: count.includedUses,
    carriedUses: count.carriedUses,
    usedUses: count.usedInPeriod,
    remainingUses: Math.max(0, limit - count.usedInPeriod),
    extraUsePriceCents: count.extraUsePriceCents === null ? null : Number(count.extraUsePriceCents),
    // A plan that will not renew has no count that starts again: as on the refusal.
    ...(renews && { resetsAt: count.periodEnd.toISOString() }),
    warning: level === 0 ? null : level,
  };
}

const encoder = new TextEncoder();

/** The public stream, after one event that says what the use cost. */
export function withBillingEvent(chat: ChatStream, billing: PaidUseBilling): ChatStream {
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

  const consume = async (rules: LimitRule[], rule: BuyerRule = "minute"): Promise<PaidUseRefusal | null> => {
    const told = await consumePublicLimit(deps.limiter, rules, "paid", deps.logger);
    return told ? limitRefusal(told, limits, rule) : null;
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

  // 2. The buyer's limit for the minute, on the handle in the address.
  // Nothing has been looked up: a handle that cannot exist is not counted
  // and not looked up. The limit for the day is not taken here: who it is
  // for is not known before the licence is read (step 6b).
  const handle = handleOf(input.handle);
  if (!handle) return refused(NOT_FOUND);

  const undeliveredKey = paidUseKeys.undeliveredDay(caller.orgId, handle, day);
  const undelivered = await deps.limiter.peek(undeliveredKey);
  if (undelivered === null) {
    deps.logger?.error({ surface: "paid" }, "paid use refused: the rate limiter is unavailable");
    return refused(limitRefusal({ status: 503, code: "rate_limiter_unavailable" }, limits, "minute"));
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
    // A plan that is over: the buyer chooses again, between the plans on
    // offer and the price per use, so both come with the refusal.
    const plans = billing.code === "plan_ended" ? await plansOnOffer(deps, listing) : undefined;
    // What ended was the buyer's free trial: said as that, not as a plan.
    const trialEnded = billing.code === "plan_ended" && licence?.buyerId === caller.orgId && onTrialPlan(sub);
    return refused({
      status: billing.status,
      code: billing.code,
      message:
        billing.code === "own_agent"
          ? PAID_USE_MESSAGES.ownAgent
          : trialEnded
            ? PAID_USE_MESSAGES.trialEnded
            : billing.message,
      ...(billing.access !== undefined && { access: billing.access }),
      ...((billing.code === "use_not_started" || billing.code === "pricing_changed" || billing.code === "plan_ended") &&
        onSaleForUse && { terms: termsOf(listing, agent) }),
      ...(plans !== undefined && { plans }),
    });
  }
  if (billing.kind === "free") {
    return refused({ status: 409, code: "not_for_sale", message: PAID_USE_MESSAGES.freeOnItsPage });
  }

  const apiKeyId = caller.type === "api_key" ? (caller.apiKeyId ?? null) : null;
  const planRenews = planWillRenew(listing, sub);
  // The row this request read is the listing's free trial: its uses are
  // included uses of a plan on the same path, with its own words past them
  // and no warning by email.
  const onTrial = billing.kind === "plan" && onTrialPlan(sub);
  // What a use past the count is charged on, as resolveUseBilling decided
  // it. On a paid plan that is the extra price on the buyer's row. On a
  // trial the row's extra price is never read there: it is the listing's
  // price per use, and only for a buyer who agreed to a price per use that
  // covers it. For everybody else it is null, and past its uses the trial stops.
  const extraInstall = billing.kind === "plan" ? billing.extraInstall : null;
  /** A plan that is used up and stops: told with the plans on offer, a bigger one among them. */
  const usedUp = async (refusal: PaidUseRefusal): Promise<PaidUseRefusal> => {
    if (refusal.code !== "plan_used_up") return refusal;
    const plans = await plansOnOffer(deps, listing);
    return plans === undefined ? refusal : { ...refusal, plans };
  };
  // What this use would cost in credits, as far as the rows say: a price per
  // use, or the extra price of a plan whose count is gone. Null inside a
  // paid month and while a plan has a use left.
  let payable: bigint | null = billing.kind === "billable" ? billing.priceCents : null;
  if (billing.kind === "plan") {
    const { plan } = billing;
    if (plan.usedInPeriod >= plan.includedUses + plan.carriedUses) {
      // Used up, and the buyer agreed to no extra price (or nothing more is
      // sold on this listing): stopped here, before the creator's allowance
      // and the model. Nothing is charged and no use is taken.
      if (!extraInstall) return refused(await usedUp(planUsedUpRefusal(plan, now, planRenews, onTrial)));
      payable = extraInstall.pricePerRequestCents;
    }
  }
  if (payable !== null) {
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
    if (balance < payable) {
      return refused({
        status: 402,
        code: "insufficient_credits",
        message: PAID_USE_MESSAGES.notEnoughCredits(unit, payable),
        priceCents: Number(payable),
        balanceCents: Number(balance),
      });
    }
    if (caller.type === "api_key") {
      const peek: SpendPeek = apiKeyId
        ? await deps.peekKeySpend({ apiKeyId, orgId: caller.orgId, priceCents: payable })
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

  // 6b. The buyer's limit for the day, for a buyer who pays per use and for
  // a month with no count. A buyer on a plan is held by the plan's count,
  // for an included use and an extra one alike, so the day is never asked
  // for them. A trial's count holds its own uses only: past them the buyer
  // pays per use and is held to the day as any buyer who pays per use is.
  // It is taken here, after every refusal that only reads and before the
  // first step that takes something, so a request that was refused above
  // did not spend one of the day's uses.
  if (billing.kind !== "plan" || (onTrial && payable !== null)) {
    const dayLimit = await consume(
      [
        {
          scope: "org",
          key: paidUseKeys.buyerDay(caller.orgId, handle, day),
          limit: limits.perBuyerPerDay,
          windowSeconds: dayLeft,
        },
      ],
      "day",
    );
    if (dayLimit) return refused(dayLimit);
  }

  // 7-8. In the chat core: the model, the agent's per-minute limit, the
  // creator's free-model allowance, then the charge.
  const metering = deps.beginUse({
    agentId: agent.id,
    install: billing.kind === "billable" ? billing.install : null,
    ...(billing.kind === "plan" && {
      plan: {
        read: billing.plan,
        // A key that cannot be named cannot reserve against its caps, so it
        // pays for no extra use: past the count its plan stops.
        extraInstall: caller.type === "api_key" && !apiKeyId ? null : extraInstall,
      },
    }),
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
    if (charge) {
      const planId = billing.kind === "plan" ? billing.plan.planId : null;
      return refused(await usedUp(chargeRefusal(charge, now, planRenews, planId, onTrial)));
    }
    return refused(coreRefusal(prepared.refusal, nowSeconds, onSaleForUse));
  }
  const { session } = prepared;
  const charge = metering.charge();
  const charged = charge ? charge.grossCents : null;
  const planUse = billing.kind === "plan" ? metering.planUse() : null;

  // Fail closed: a use that must be paid for and carries no charge does not
  // reach the model. Nor does a use on a plan that took no use from its
  // count (or, past the count, no charge), nor a session that is not the
  // agent's own chat.
  const unpaid = billing.kind === "billable" && (!session.meter || !charge);
  const uncounted =
    billing.kind === "plan" && (!session.meter || !planUse || (planUse.use === "extra" && !charge));
  if (session.runtime !== "platform" || unpaid || uncounted) {
    await session.meter?.refund("the use could not be started");
    deps.logger?.error(
      { agentId: agent.id },
      "paid use refused: a use reached its run without its charge or its use of a plan",
    );
    return refused(
      charge
        ? failureRefusal({ code: "upstream_error", message: "", retryAfterSeconds: null }, charge.grossCents)
        : UNAVAILABLE,
    );
  }

  /** One more answer that was produced, paid for and not delivered. Best effort. */
  const countUndelivered = async (): Promise<void> => {
    // An included use that is given back is counted as a refund is: an
    // answer was produced and the buyer paid nothing for it.
    if (!charge && !planUse) return;
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

  // The plan's count as the reply told it: read once, and the warning is asked with the same numbers.
  let planCount: UsePlanCount | null = null;
  const billingNow = async (chargedCents: bigint | null): Promise<PaidUseBilling> => {
    const balanceCents = await deps
      .readBalance(caller.orgId)
      .then((cents) => Number(cents))
      .catch(() => null);
    if (planUse) planCount = await planUse.count();
    return {
      chargedCents: Number(chargedCents ?? 0n),
      balanceCents,
      access: billing.access,
      ...(planUse &&
        planCount && {
          // A trial only while the count is still the row that was read: a
          // paid plan started over it in between is told as what it is.
          plan: planBillingOf(
            planUse,
            planCount,
            planRenews,
            onTrial && billing.kind === "plan" && planCount.planId === billing.plan.planId,
          ),
        }),
    };
  };

  /**
   * The email at 85% and at 100% of a plan. Asked only once an included use
   * was delivered, with the count that use left, and only at a level: below
   * 85% nothing is asked. Started and not waited for, after the use is done
   * and outside any transaction. Whatever it does, the answer is what it was.
   *
   * A free trial sends none: nothing is asked for it, so no level is claimed
   * or written on its row.
   */
  const warnOfPlan = (told: PaidUseBilling): void => {
    if (!deps.warnPlan || billing.kind !== "plan" || !planUse || planUse.use !== "included") return;
    if (onTrial || told.plan?.trial === true) return;
    const count = planCount;
    if (!count || !told.plan || told.plan.warning === null) return;
    try {
      void Promise.resolve(
        deps.warnPlan({
          orgId: caller.orgId,
          subscriptionId: planUse.subscriptionId,
          periodStart: planUse.periodStart,
          // The name read with the request is the name of the plan that was read.
          planName: count.planId === billing.plan.planId ? (sub?.planName ?? null) : null,
          agentTitle: listing.title,
          includedUses: count.includedUses,
          carriedUses: count.carriedUses,
          usedUses: count.usedInPeriod,
          // Past the count a use is charged only while the listing still sells use.
          extraUsePriceCents: extraInstall ? count.extraUsePriceCents : null,
          periodEnd: count.periodEnd,
          renews: planRenews,
        }),
      ).catch((err) => deps.logger?.warn({ err }, "a plan's warning failed; the answer went out as it was"));
    } catch (err) {
      deps.logger?.warn({ err }, "a plan's warning failed; the answer went out as it was");
    }
  };

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
    const answerBilling = await billingNow(charged);
    warnOfPlan(answerBilling);
    return { kind: "answered", text: held.text, toolCalls, billing: answerBilling };
  }

  const streamBilling = await billingNow(charged);
  return {
    kind: "stream",
    chat: withBillingEvent(toPublicStream(held.chat), streamBilling),
    // 10-11. Only the socket knows whether the answer arrived.
    meter: session.meter,
    billing: streamBilling,
    finished: async (outcome) => {
      if (outcome.ok) {
        await delivered(held.text);
        warnOfPlan(streamBilling);
      } else await countUndelivered();
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
  if (told) return refused(limitRefusal(told, deps.limits, "minute"));

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
export async function canAccept(deps: Pick<PaidUseDeps, "memberRole" | "logger">, caller: PaidCaller): Promise<boolean> {
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

/**
 * The plan a buyer is on, from their own row. Built field by field. The one
 * place it is built: the agent's page reads it from the access answer and
 * the buyer's Installed page from their installs (services/marketplace.ts),
 * and both must say the same count.
 */
export function accessPlanOf(sub: PaidSubscription, renews: boolean): UseAccessPlan {
  const included = sub.includedUses ?? 0;
  const carried = sub.carriedUses ?? 0;
  const used = sub.usedInPeriod ?? 0;
  const level = warningLevel(used, included, carried);
  const trial = onTrialPlan(sub);
  return {
    id: sub.planId ?? null,
    // A free trial has one name everywhere, whatever its row was read with.
    name: trial ? TRIAL_PLAN_NAME : (sub.planName ?? ""),
    trial,
    includedUses: included,
    carriedUses: carried,
    usedUses: used,
    remainingUses: Math.max(0, included + carried - used),
    extraUsePriceCents: sub.extraUsePriceCents == null ? null : Number(sub.extraUsePriceCents),
    ...(renews && { resetsAt: sub.currentPeriodEnd.toISOString() }),
    warning: level === 0 ? null : level,
  };
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
  // On a plan, while it gives uses. One that is over is told by `access`
  // (plan_ended, or the price per use the buyer agreed to), not here.
  const held = mine && sub && onPlan(sub) && access === "subscribed" ? sub : null;

  // The listing's free trial, and whether this organization could start it
  // now, by the judgement the start itself makes. Whether credits were ever
  // added is read only when it decides, and a read that fails answers no
  // without saying that credits are what is missing.
  const trial = await trialOnOffer(deps, listing);
  let trialAvailable = false;
  let trialNeedsCredits = false;
  if (trial && !own && !blockedUntil) {
    const used = trialUsed(sub);
    const running = access === "subscribed";
    let addedCredits: boolean | null = false;
    if (!used && !running) {
      try {
        addedCredits = deps.addedCredits ? await deps.addedCredits(caller.orgId) : null;
      } catch (err) {
        deps.logger?.warn({ err }, "could not read whether credits were added; no free trial is offered");
        addedCredits = null;
      }
    }
    const standing = judgeTrial({ offered: true, used, running, addedCredits: addedCredits === true });
    trialAvailable = standing.available;
    trialNeedsCredits = !standing.available && standing.reason === "trial_needs_credits" && addedCredits === false;
  }

  return {
    kind: "access",
    view: {
      access,
      listingId: listing.id,
      terms: onSaleForUse ? termsOf(listing, agent) : null,
      plans: (await plansOnOffer(deps, listing)) ?? [],
      plan: held && accessPlanOf(held, planWillRenew(listing, held)),
      trial,
      trialAvailable,
      trialNeedsCredits,
      trialEnded: access === "plan_ended" && mine !== null && onTrialPlan(sub),
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
