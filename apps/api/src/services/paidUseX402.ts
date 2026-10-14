/**
 * One use of an agent paid from a Solana wallet, at a listing's x402 door,
 * by a caller with no account (the published x402 format, version 2).
 *
 *   POST /api/a/:handle/chat and /run, or model `a/<handle>` on /v1, with no
 *   credential at all, while the door is open (middleware/auth.ts,
 *   x402DoorApplies). The routes decide that; this file is the use.
 *
 * The door answers first and is paid second. The order is the point, and no
 * step below may move:
 *
 *    1. listing   the handle, its agent and its listing, judged as the door
 *                 judges them now (x402ListingServed). Not served: the route
 *                 answers today's 401, with nothing counted.
 *    2. paused    the listing is paused right now: 503, no 402.
 *    3. minute    the address's minute on this handle, on a limiter that
 *                 fails closed.
 *    4. body      paid use's body and kind rules (the route may hand in its
 *                 own check first, as /v1 does).
 *    5. payment   no readable PAYMENT-SIGNATURE: 402 with a fresh challenge.
 *    6. checks    the echo against the requirements built now, then every
 *                 check of the scheme on the transaction, then a read of its
 *                 message hash: a payment presented before is refused here.
 *    7. limits    the unpaid answers of the wallet and the address today,
 *                 then the wallet's minute and day and the address's day.
 *    8. chain     read only: the three accounts, the blockhash, and a
 *                 simulation of the payment as it stands.
 *    9. slot      a shutdown slot of the door's own.
 *   10. claim     the row is written "held": the message's hash and nothing
 *                 that can land. NOTHING is written before this step.
 *   11. answer    made as a buyer's paid answer is made, in the creator's
 *                 organization, held whole and checked (lib/heldAnswer.ts,
 *                 detectInstructionLeak), and nothing of it leaves.
 *   12. no answer the row is failed; nothing is signed or sent.
 *   13. before    the caller is still there, the send is in time, and the
 *                 blockhash can still land.
 *   14. send      the fee payer signs (the injected signer, which checks the
 *                 bytes again), the row is set "submitted" by compare-and-set,
 *                 and only then is the transaction sent.
 *   15. wait      for the chain, on the clock.
 *   16. release   confirmed: the sale is written, and only then is the
 *                 answer released, with PAYMENT-RESPONSE.
 *   17. slot      released after the last write.
 *
 * So nothing that can land exists before the answer is made and checked
 * whole, a failed or withheld answer signs and sends nothing, a payment the
 * chain refuses releases no answer, and a released answer always has its
 * sale. A payment from a wallet is never anyone's credits.
 *
 * What a caller is told is X402_DOOR_MESSAGES (services/x402DoorRules.ts),
 * and the reason of a refused payment rides in the PAYMENT-REQUIRED or
 * PAYMENT-RESPONSE header in the published words. A caller is never told the
 * creator's organization, the model, a node's or the database's words, or
 * anything of the fee payer but its address.
 *
 * Pure core: every effect is a dependency (the listing, the pause, the
 * limiter, the settings of the requirements, the chain, the payment rows, the
 * signer, the answer, the sale, the shutdown slot, the clock and the nonce).
 * This file reads no settings and no database, and holds no key.
 */

import type { PublicToolCall } from "../lib/publicSse.js";
import { publicToolCalls, toPublicStream } from "../lib/publicSse.js";
import { holdUntilChecked } from "../lib/heldAnswer.js";
import type { SolanaNetwork } from "../lib/solanaAssets.js";
import type { AgentChatDeps, AgentChatFailure, AgentChatInput, AgentChatRefusal, PrepareAgentChatResult } from "./agentChat.js";
import { buildTaskBrief, checkTaskInput, TASK_REFUSAL_STATUS, type TaskInputCheck } from "./agentTask.js";
import { detectInstructionLeak } from "./assertions.js";
import type { FailClosedLimiter, LimitDecision, LimitRule } from "./failClosedLimiter.js";
import type { InFlightRuns, RunSlot } from "./inFlightRuns.js";
import { CONFIDENTIAL_CHAT_RULES } from "./jobPrompt.js";
import type { ChatStream } from "./mastra-runtime.js";
import {
  handleOf,
  PAID_USE_MESSAGES,
  paidToolAllowlist,
  paidUseKeys,
  withBillingEvent,
  type PaidAgent,
  type PaidUseBilling,
  type PaidUseLimits,
  type PaidUseMetering,
  type PaidUseRefusal,
} from "./paidUse.js";
import { publicChatBodySchema, secondsLeftInUtcDay, utcDay } from "./publicChat.js";
import { publicTaskBodySchema } from "./publicTask.js";
import { useUnitOf, type UseListingRow } from "./useListing.js";
import type { X402Network } from "./x402.js";
import {
  X402_ANSWER_DEADLINE_MS,
  X402_DOOR_MESSAGES,
  X402_FEE_PAYER_MIN_LAMPORTS,
  X402_SEND_BY_MS,
  X402_UNPAID_ANSWERS_PER_DAY,
  x402ListingServed,
  type X402DoorUnit,
} from "./x402DoorRules.js";
import { verifyExactSvmTransaction, type ExactSvmPayment } from "./x402ExactSvm.js";
import type { FeePayerSignature } from "./x402FeePayer.js";
import {
  awaitDoorPayment,
  claimHeldPayment,
  failHeldPayment,
  findDoorPaymentByHash,
  markUnserved,
  submitHeldPayment,
  type X402DoorChainReads,
  type X402DoorFailure,
  type X402DoorPaymentsDeps,
} from "./x402Payments.js";
import type { X402SaleInput, X402SaleResult } from "./x402Sale.js";
import {
  compareAccepted,
  encodePaymentRequired,
  encodePaymentResponse,
  listingRequirements,
  makeX402Memo,
  paymentRequired,
  readPaymentSignature,
  X402_ERROR_REASONS,
  x402Caip2Network,
  type PaymentRequirements,
  type X402ErrorReason,
} from "./x402Wire.js";

// ============================================
// Names
// ============================================

/** The header of a 402: what to pay. */
export const X402_PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
/** The header of an answer, or of a payment that did not go through: what became of it. */
export const X402_PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/**
 * The door's limiter keys, in one place. `handle` is the lower-case handle,
 * `bucket` the hashed address (never a raw address), `wallet` the paying
 * wallet. The agent's own minute is paid use's key, shared with buyers who
 * have an account.
 */
export const x402DoorKeys = {
  addressMinute: (bucket: string, handle: string) => `x4:ip:m:${bucket}:${handle}`,
  walletMinute: (wallet: string, handle: string) => `x4:w:m:${wallet}:${handle}`,
  walletDay: (wallet: string, handle: string, day: string) => `x4:w:d:${day}:${wallet}:${handle}`,
  addressDay: (bucket: string, day: string) => `x4:ip:d:${day}:${bucket}`,
  unpaidWalletDay: (wallet: string, day: string) => `x4:u:w:d:${day}:${wallet}`,
  unpaidAddressDay: (bucket: string, day: string) => `x4:u:ip:d:${day}:${bucket}`,
  // Paid use's own key, not a copy of it: a second key would be a second allowance.
  agentMinute: paidUseKeys.agentMinute,
} as const;

const MINUTE = 60;
/** The unpaid counters only count: their limit is never what refuses. */
const COUNT_ONLY = 1_000_000;
/** How long a caller is asked to wait while the server restarts. */
const RESTART_RETRY_SECONDS = 5;

// ============================================
// Input and dependencies
// ============================================

export type X402UseKind = "chat" | "run";

/**
 * What the route hands in for step 4 of /v1: its own parse of the request,
 * answering paid use's body or its own refusal (sent by the route as it is).
 */
export type X402BodyCheck<R> = { ok: true; body: unknown } | { ok: false; refused: R };

export interface X402UseInput<R = never> {
  kind: X402UseKind;
  /** The handle in the address, as sent. */
  handle: string;
  /** The parsed JSON body, not yet validated. */
  body: unknown;
  /**
   * The route's own check of the body, run only after the listing is
   * judged. When it passes, its body is the one read by paid use's rules.
   */
  checkBody?: () => X402BodyCheck<R>;
  /** The request's headers as Node gives them. Only PAYMENT-SIGNATURE is read. */
  headers: Record<string, string | string[] | undefined>;
  /** The address bucket (services/widgetKeys.ts hashBucket of ipBucket): never a raw address. */
  bucket: string;
  /** When the request arrived: every bound of the door is measured from it. */
  arrivedAt: Date;
  /** The use address as the published format names it: PUBLIC_API_URL and the path. */
  resourceUrl: string;
  /** Fires when the caller goes away. */
  signal: AbortSignal;
  /**
   * Called once, as soon as the door serves the listing and before anything
   * is counted: the route wires what it wires for a caller (a close of the
   * connection) only from here, so a request it does not serve gets today's
   * 401 untouched.
   */
  onServed?: () => void;
}

/** The listing as the door reads it: paid use's columns and the creator's switch. */
export type X402ListingRow = UseListingRow & {
  /** agent_listings.x402_enabled. Read as off when it was not selected. */
  x402Enabled?: boolean;
  /** Set on a listing that sells a workflow, which the door never serves. */
  orchestrationId?: string | null;
  /** The listing's one line, for the 402's resource. Its title when not read. */
  shortDescription?: string;
};

/** The settings the requirements are built from, read by the binding. */
export interface X402DoorWire {
  /** SOLANA_NETWORK: the CAIP-2 network of every 402 is made from it. */
  network: SolanaNetwork;
  /** The network as a payment's row stores it (x402NetworkFor): the worker selects by it. */
  rowNetwork: X402Network;
  /** The USDC mint of the network. */
  usdcMint: string;
  /** TREASURY_WALLET_ADDRESS: payTo. */
  treasury: string;
  /** The fee payer's address. Its key is the signer's, never this file's. */
  feePayer: string;
  /** The secret of the memo's MAC. */
  memoSecret: string;
}

/** What the agent-wide minute, asked inside the chat core, answered. */
export type X402Admission = { ending: "agent_limit"; retryAfterSeconds: number } | { ending: "cannot_count" } | null;

/** One answer to make, as a buyer's paid answer is made. */
export interface X402AnswerAsk {
  agent: PaidAgent;
  listing: X402ListingRow;
  messages: AgentChatInput["messages"];
  systemAddendum: string;
  /** The characters sent to the model, for the model cost. */
  promptChars: number;
  /** The most the answer may take: what is left of X402_ANSWER_DEADLINE_MS. */
  deadlineMs: number;
  /** The caller left, or the server is stopping. */
  signal: AbortSignal;
  /** The agent's minute across everyone, asked after the model is known. */
  admit(): Promise<X402Admission>;
}

/** Why an answer was not made, or not made whole and checked. */
export type X402AnswerEnding =
  /** The model failed, or answered nothing. */
  | "model_error"
  /** Made, and refused by the check: it is not released. */
  | "answer_withheld"
  /** Not ready within the deadline. */
  | "answer_timed_out"
  /** The signal fired: the caller left, or the server is stopping. */
  | "stopped"
  /** The agent's minute across everyone, or its creator's free allowance, is used up. */
  | "agent_limit"
  /** The limiter could not count. */
  | "cannot_count"
  /** The model the agent runs on, one its organization runs itself, is not running. */
  | "paused"
  /** The agent cannot be run now (its setup, or a restart): nothing ran. */
  | "unavailable";

export type X402Answer =
  | {
      ok: true;
      /** The whole answer, as it was checked. */
      text: string;
      toolCalls: PublicToolCall[];
      /** The held answer, every byte in one piece: replayed only once the payment is confirmed. */
      chat: ChatStream;
      /** What the answer cost on the platform's model keys, in millionths of a cent. */
      modelCostMicros: bigint;
    }
  | { ok: false; ending: X402AnswerEnding; retryAfterSeconds?: number };

export interface X402UseDeps {
  limiter: Pick<FailClosedLimiter, "consume" | "peek">;
  /** Paid use's numbers: the door has no second set but its unpaid answers. */
  limits: Pick<PaidUseLimits, "perBuyerPerMinute" | "perBuyerPerDay" | "perAgentPerMinute" | "timeLimitMs">;
  /** The agent that holds this public handle, whoever owns it. */
  loadAgentByHandle(handle: string): Promise<PaidAgent | null>;
  /** The agent's one listing, in any state. */
  loadListing(agentId: string): Promise<X402ListingRow | null>;
  /** Whether the listing is paused at this moment (services/paidUsePause.ts). Throws when it cannot be asked. */
  pausedNow(args: { listing: { status: string; sells: string }; agent: { id: string; orgId: string } }): Promise<boolean>;
  /** The settings of the requirements. Throws when they cannot be read: the door is then not available. */
  wire(): X402DoorWire;
  /** The chain, read only (step 8 and step 13). */
  chain: X402DoorChainReads;
  /** The payment's rows and its send (services/x402Payments.ts, the door's functions). */
  payments: X402DoorPaymentsDeps;
  /**
   * The fee payer's signature on exactly these bytes (services/x402FeePayer.ts
   * signAsFeePayer bound to the key), which checks them again itself.
   */
  signAsFeePayer(transactionB64: string, requirements: PaymentRequirements): FeePayerSignature;
  /** Makes the answer, holds it whole and checks it (createX402AnswerMaker). */
  makeAnswer(ask: X402AnswerAsk): Promise<X402Answer>;
  /** The sale of a confirmed payment, in one database transaction (services/x402Sale.ts). */
  recordSale(input: X402SaleInput): Promise<X402SaleResult>;
  /** The door's own shutdown slots. */
  inFlight: Pick<InFlightRuns, "begin">;
  now(): Date;
  /** 16 bytes for a challenge's memo. */
  nonce(): Uint8Array;
  logger?: {
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
}

// ============================================
// Results
// ============================================

/** The answer, released: the payment is confirmed and its sale is written. */
export interface X402Delivered {
  kind: "answer";
  useKind: X402UseKind;
  text: string;
  toolCalls: PublicToolCall[];
  /** A use paid per request: what was paid, no balance. */
  billing: PaidUseBilling;
  /** The PAYMENT-RESPONSE header's value. */
  paymentResponse: string;
  /** The headers to set before the first byte. */
  headers: Record<string, string>;
  /**
   * Set when the caller asked for a stream: the whole answer replayed in paid
   * use's public encoding, after its billing event. Null for a whole answer.
   */
  stream: ChatStream | null;
}

export type X402UseResult<R = never> =
  /** The door does not serve this handle now: the route answers today's 401. */
  | { kind: "not_served" }
  /** The route's own check refused the body: the route sends its own refusal. */
  | { kind: "body_refused"; refused: R }
  | { kind: "refusal"; refusal: PaidUseRefusal; headers: Record<string, string> }
  | X402Delivered;

const NOT_SERVED = { kind: "not_served" } as const;

// ============================================
// The answer, made as a buyer's paid answer is made
// ============================================

/** The metering of one door use: it charges nothing and notes what the model cost. */
export interface X402UseMetering extends Pick<PaidUseMetering, "beginMetering" | "noteRun" | "notePlatformUsage"> {
  /** What the use cost on the platform's model keys, in millionths of a cent; 0 when nothing ran on them. */
  modelCostMicros(): bigint;
}

export interface X402AnswerMakerDeps {
  /** prepareAgentChat on its production deps, with this use's `beginMetering`. */
  prepareChat(input: AgentChatInput, beginMetering: AgentChatDeps["beginMetering"]): Promise<PrepareAgentChatResult>;
  /** A metering that answers no charge (services/useMeteringProduction.ts, the door's binding). */
  beginMetering(args: { agentId: string }): X402UseMetering;
  /** The names of the tools that send a request to an address the model chooses. */
  outboundToolNames(): readonly string[];
  limits: Pick<PaidUseLimits, "maxToolRounds">;
  now(): Date;
}

/** A refusal of the agent's minute, thrown out of the chat core's `admit`. */
class X402AdmissionRefused extends Error {
  constructor(readonly admission: Exclude<X402Admission, null>) {
    super(admission.ending);
    this.name = "X402AdmissionRefused";
  }
}

function endingOfRefusal(refusal: AgentChatRefusal, now: Date): Exclude<X402Answer, { ok: true }> {
  switch (refusal.kind) {
    case "client_gone":
      return { ok: false, ending: "stopped" };
    case "hosted_model_unavailable":
      return { ok: false, ending: "paused" };
    case "rate_limited": {
      // The creator's free-model allowance: when it resets is all that is told.
      const { remaining, resetAt } = refusal.limit;
      const reset = remaining.rpd <= 0 ? resetAt.rpd : resetAt.rpm;
      return {
        ok: false,
        ending: "agent_limit",
        retryAfterSeconds: Math.max(1, Math.ceil(reset - now.getTime() / 1000)),
      };
    }
    case "shutting_down":
      return { ok: false, ending: "unavailable", retryAfterSeconds: RESTART_RETRY_SECONDS };
    // The core's own words name the model or the listing: none of it is the caller's.
    case "agent_not_found":
    case "invalid_request":
    case "not_configured":
    case "model_invalid":
    case "licence_revoked":
    case "payment_required":
      return { ok: false, ending: "unavailable" };
  }
}

function endingOfFailure(failure: AgentChatFailure): X402AnswerEnding {
  if (failure.code === "client_gone") return "stopped";
  if (failure.code === "upstream_timeout") return "answer_timed_out";
  if (failure.code === "service_unavailable") return "unavailable";
  return "model_error";
}

/**
 * The answer maker of the door: the chat a buyer's paid use runs (in the
 * creator's organization, as a public caller, source paid, the creator's
 * documents untitled, the listing's outbound tools only, at most four tool
 * rounds, the confidential rules or the task's brief), with a metering that
 * charges nothing. The answer is held whole and checked; nothing of it leaves
 * here but the checked whole or the reason there is none.
 */
export function createX402AnswerMaker(deps: X402AnswerMakerDeps): (ask: X402AnswerAsk) => Promise<X402Answer> {
  return async (ask) => {
    const metering = deps.beginMetering({ agentId: ask.agent.id });
    const chatInput: AgentChatInput = {
      caller: "public",
      source: "paid",
      // The creator's own agent, in the creator's organization.
      orgId: ask.agent.orgId,
      agent: { id: ask.agent.id },
      messages: ask.messages,
      systemAddendum: ask.systemAddendum,
      hideSourceTitles: true,
      toolAllowlist: paidToolAllowlist(ask.agent.tools, deps.outboundToolNames(), ask.listing.useAllowedTools),
      signal: ask.signal,
      maxToolRounds: deps.limits.maxToolRounds,
      deadlineMs: ask.deadlineMs,
      admit: async () => {
        const refused = await ask.admit();
        if (refused) throw new X402AdmissionRefused(refused);
      },
    };

    let prepared: PrepareAgentChatResult;
    try {
      prepared = await deps.prepareChat(chatInput, metering.beginMetering);
    } catch (err) {
      if (err instanceof X402AdmissionRefused) {
        return err.admission.ending === "agent_limit"
          ? { ok: false, ending: "agent_limit", retryAfterSeconds: err.admission.retryAfterSeconds }
          : { ok: false, ending: "cannot_count" };
      }
      throw err;
    }
    if (!prepared.ok) return endingOfRefusal(prepared.refusal, deps.now());
    const { session } = prepared;

    // Fail closed: a door use charges nobody's credits, and only the agent's
    // own chat answers. A session with a meter, or of a graph, does not run.
    if (session.runtime !== "platform" || session.meter !== null) {
      await session.meter?.refund("a use at the x402 door carries no charge");
      return { ok: false, ending: "unavailable" };
    }

    // Always the stream, whatever the caller asked for: it is held whole.
    const started = await session.stream();
    if (!started.ok) {
      if (started.refusal) return endingOfRefusal(started.refusal, deps.now());
      return { ok: false, ending: endingOfFailure(started.failure) };
    }
    const instructions = [ask.agent.systemPrompt];
    const held = await holdUntilChecked(started.chat, (text) => !detectInstructionLeak(text, instructions).leaked);
    if (!held.ok) {
      if (held.code === "answer_withheld") return { ok: false, ending: "answer_withheld" };
      if (held.outcome.code === "deadline") return { ok: false, ending: "answer_timed_out" };
      if (held.outcome.code === "client_gone" || ask.signal.aborted) return { ok: false, ending: "stopped" };
      return { ok: false, ending: "model_error" };
    }

    metering.noteRun({
      platformModel: session.platformModel,
      usage: held.outcome.usage,
      content: held.text,
      promptChars: ask.promptChars,
    });
    return {
      ok: true,
      text: held.text,
      toolCalls: publicToolCalls(held.outcome.toolCalls),
      chat: held.chat,
      modelCostMicros: metering.modelCostMicros(),
    };
  };
}

// ============================================
// One use through the door
// ============================================

/**
 * A credential never reaches the door: the route sends any request that
 * carries one down today's path. Asked again here, so a route that got it
 * wrong still serves nothing.
 */
function carriesCredential(headers: Record<string, string | string[] | undefined>): boolean {
  if (headers.authorization !== undefined) return true;
  const cookie = headers.cookie;
  const cookies = Array.isArray(cookie) ? cookie.join(";") : (cookie ?? "");
  // As the cookie parser reads it: a name with spaces around it is still the name.
  return /(?:^|;)\s*wheelsai_token\s*=/.test(cookies);
}

/** The serve test of the door, on what was read. */
function servedNow(listing: X402ListingRow, agent: PaidAgent): boolean {
  return x402ListingServed(
    {
      agentId: listing.agentId,
      orchestrationId: listing.orchestrationId ?? null,
      status: listing.status,
      sells: listing.sells,
      pricingModel: listing.pricingModel,
      pricePerRequestCents: listing.pricePerRequestCents,
      x402Enabled: listing.x402Enabled === true,
    },
    {
      isPublic: agent.isPublic,
      // An unread kind is no kind: the door does not serve it.
      agentKind: agent.agentKind ?? "",
      // Paid use runs any entrypoint but a graph as the chat; so does the test.
      entrypoint: agent.entrypoint ?? "chat",
    },
  );
}

type Refused = { kind: "refusal"; refusal: PaidUseRefusal; headers: Record<string, string> };

const refusalOf = (refusal: PaidUseRefusal, headers: Record<string, string> = {}): Refused => ({
  kind: "refusal",
  refusal,
  headers,
});

const UNAVAILABLE = (retryAfterSeconds?: number): PaidUseRefusal => ({
  status: 503,
  code: "x402_unavailable",
  message: X402_DOOR_MESSAGES.unavailable,
  ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
});

const CANNOT_COUNT: PaidUseRefusal = {
  status: 503,
  code: "rate_limiter_unavailable",
  message: X402_DOOR_MESSAGES.cannotCount,
  retryAfterSeconds: 30,
};

/** Counts one request against every rule, or answers how it refused. */
async function consumeAll(
  limiter: Pick<FailClosedLimiter, "consume">,
  rules: LimitRule[],
): Promise<Exclude<LimitDecision, { status: "ok" }> | null> {
  const decision = await limiter.consume(rules);
  return decision.status === "ok" ? null : decision;
}

/**
 * One use through the door, in the order above. Never throws for a refusal.
 * A read of the agent or its listing that throws answers not served (logged):
 * a caller with no credential gets today's 401, which reads nothing, so an
 * outage changes no answer for a handle the door may not serve. Any other
 * dependency that throws is answered as the door not being available, and a
 * claimed row is always ended or left to the worker.
 */
export async function runX402Use<R = never>(input: X402UseInput<R>, deps: X402UseDeps): Promise<X402UseResult<R>> {
  // 0. Only a caller with no credential is the door's.
  if (carriesCredential(input.headers)) return NOT_SERVED;

  // 1. The listing, judged as the door judges it now. Nothing is counted
  // for a handle the door does not serve: its answer is today's 401.
  const handle = handleOf(input.handle);
  if (!handle) return NOT_SERVED;
  let found: PaidAgent | null;
  try {
    found = await deps.loadAgentByHandle(handle);
  } catch (err) {
    deps.logger?.error({ err }, "x402 door: the agent could not be read; answered as not served");
    return NOT_SERVED;
  }
  if (!found) return NOT_SERVED;
  const agent: PaidAgent = found;
  let row: X402ListingRow | null;
  try {
    row = await deps.loadListing(agent.id);
  } catch (err) {
    deps.logger?.error({ err, agentId: agent.id }, "x402 door: the listing could not be read; answered as not served");
    return NOT_SERVED;
  }
  if (!row || row.agentId !== agent.id || !servedNow(row, agent)) return NOT_SERVED;
  const listing: X402ListingRow = row;
  const priceCents = listing.pricePerRequestCents;
  const unitOf = useUnitOf(agent.agentKind, listing.pricingModel);
  // Served means a price per use: there is always a price, and never a month.
  if (priceCents === null || unitOf === "month") return NOT_SERVED;
  const unit: X402DoorUnit = unitOf;
  const priced = { priceCents: Number(priceCents), unit };
  input.onServed?.();

  // 2. Paused right now.
  let paused: boolean;
  try {
    paused = await deps.pausedNow({ listing, agent: { id: agent.id, orgId: agent.orgId } });
  } catch (err) {
    deps.logger?.error({ err, listingId: listing.id }, "x402 door refused: whether the listing is paused could not be read");
    return refusalOf(UNAVAILABLE());
  }
  if (paused) return refusalOf({ status: 503, code: "agent_paused", message: X402_DOOR_MESSAGES.paused });

  // 3. The address's minute on this handle, on every call that reaches here.
  const minute = await consumeAll(deps.limiter, [
    {
      scope: "ip",
      key: x402DoorKeys.addressMinute(input.bucket, handle),
      limit: deps.limits.perBuyerPerMinute,
      windowSeconds: MINUTE,
    },
  ]);
  if (minute?.status === "limited") {
    return refusalOf({
      status: 429,
      code: "rate_limited",
      message: X402_DOOR_MESSAGES.addressMinute,
      retryAfterSeconds: minute.retryAfterSeconds,
    });
  }
  if (minute) {
    deps.logger?.error({ surface: "x402" }, "x402 door refused: the rate limiter is unavailable");
    return refusalOf(CANNOT_COUNT);
  }

  // 4. The body, by the route's check and then by paid use's rules.
  let raw: unknown = input.body;
  if (input.checkBody) {
    const checked = input.checkBody();
    if (!checked.ok) return { kind: "body_refused", refused: checked.refused };
    raw = checked.body;
  }
  let messages: AgentChatInput["messages"];
  let systemAddendum: string;
  let wantsStream: boolean;
  if (input.kind === "chat") {
    const parsed = publicChatBodySchema.safeParse(raw);
    if (!parsed.success) {
      return refusalOf({ status: 400, code: "invalid_request", message: PAID_USE_MESSAGES.invalidChatBody });
    }
    messages = parsed.data.messages;
    systemAddendum = CONFIDENTIAL_CHAT_RULES;
    wantsStream = parsed.data.stream !== false;
  } else {
    const parsed = publicTaskBodySchema.safeParse(raw);
    if (!parsed.success) {
      return refusalOf({ status: 400, code: "invalid_request", message: PAID_USE_MESSAGES.invalidTaskBody });
    }
    let check: TaskInputCheck;
    try {
      check = checkTaskInput(agent, parsed.data.input);
    } catch (err) {
      // The agent's own form does not compile: its owner's to fix.
      deps.logger?.error({ err, agentId: agent.id }, "x402 door refused: the agent's form cannot be read");
      return refusalOf(UNAVAILABLE());
    }
    if (!check.ok) {
      return refusalOf({
        status: TASK_REFUSAL_STATUS[check.code],
        code: check.code,
        message: check.message,
        ...(check.code === "input_invalid" && { details: check.details }),
      });
    }
    const brief = buildTaskBrief(agent, check.input);
    messages = [{ role: "user", content: brief.brief }];
    systemAddendum = brief.systemAddendum;
    wantsStream = parsed.data.stream !== false;
  }
  const promptChars =
    (agent.systemPrompt?.length ?? 0) +
    systemAddendum.length +
    messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0);

  // The requirements, built by the server alone, every time.
  let wire: X402DoorWire;
  try {
    wire = deps.wire();
  } catch (err) {
    deps.logger?.error({ err }, "x402 door refused: its settings could not be read");
    return refusalOf(UNAVAILABLE());
  }
  const caip2 = x402Caip2Network(wire.network);
  const requirementsNow = (): PaymentRequirements => {
    const base = listingRequirements({
      network: wire.network,
      priceCents,
      asset: wire.usdcMint,
      payTo: wire.treasury,
      feePayer: wire.feePayer,
      memo: "",
    });
    const { memo } = makeX402Memo({
      listingId: listing.id,
      amount: base.amount,
      secret: wire.memoSecret,
      nonceBytes: deps.nonce(),
    });
    return { ...base, extra: { feePayer: base.extra.feePayer, memo } };
  };
  /** A fresh PAYMENT-REQUIRED, with the reason the last payment was refused when there was one. */
  const challenge = (error?: X402ErrorReason): Record<string, string> => ({
    [X402_PAYMENT_REQUIRED_HEADER]: encodePaymentRequired(
      paymentRequired({
        url: input.resourceUrl,
        description: listing.shortDescription ?? listing.title,
        requirements: requirementsNow(),
        ...(error !== undefined && { error }),
      }),
    ),
  });
  const paymentRefused = (reason: X402ErrorReason): Refused =>
    refusalOf(
      {
        status: 402,
        code: "x402_payment_invalid",
        message:
          reason === X402_ERROR_REASONS.duplicateSettlement
            ? X402_DOOR_MESSAGES.presentedTwice
            : reason === X402_ERROR_REASONS.transactionSimulationFailed
              ? X402_DOOR_MESSAGES.wouldNotGoThrough
              : X402_DOOR_MESSAGES.paymentInvalid,
        ...priced,
      },
      challenge(reason),
    );

  // 5. The payment.
  const read = readPaymentSignature(input.headers);
  if (read.kind !== "payment") {
    return refusalOf(
      {
        status: 402,
        code: "x402_payment_required",
        message: X402_DOOR_MESSAGES.paymentRequired(priceCents, unit),
        ...priced,
      },
      challenge(read.kind === "unreadable" ? read.reason : undefined),
    );
  }
  const transactionB64 = read.payment.payload.transaction;

  // 6. The echo against the requirements built now, then the transaction.
  // Nothing is priced or addressed from what the client sent.
  const compared = compareAccepted(read.payment.accepted, requirementsNow(), {
    listingId: listing.id,
    secret: wire.memoSecret,
  });
  if (!compared.ok) return paymentRefused(compared.reason);
  const { requirements, nonce } = compared;
  const verified = verifyExactSvmTransaction(transactionB64, requirements, { feePayer: wire.feePayer });
  if (!verified.isValid) return paymentRefused(verified.invalidReason);
  const checked: ExactSvmPayment = verified;
  // Presented before: refused before any limit is spent or the chain is read.
  let seen: { id: string; status: string } | null;
  try {
    seen = await findDoorPaymentByHash(checked.messageHash, deps.payments);
  } catch (err) {
    deps.logger?.error({ err }, "x402 door refused: a payment's row could not be read");
    return refusalOf(UNAVAILABLE());
  }
  if (seen) return paymentRefused(X402_ERROR_REASONS.duplicateSettlement);

  // 7. The payer's limits: the unpaid answers of today first, then the
  // wallet's minute and day and the address's day, together.
  const now = deps.now();
  const day = utcDay(now);
  const dayLeft = secondsLeftInUtcDay(now);
  const wallet = checked.payer;
  const unpaidKeys = [x402DoorKeys.unpaidWalletDay(wallet, day), x402DoorKeys.unpaidAddressDay(input.bucket, day)];
  for (const key of unpaidKeys) {
    const count = await deps.limiter.peek(key);
    if (count === null) {
      deps.logger?.error({ surface: "x402" }, "x402 door refused: the rate limiter is unavailable");
      return refusalOf(CANNOT_COUNT);
    }
    if (count >= X402_UNPAID_ANSWERS_PER_DAY) {
      return refusalOf({
        status: 429,
        code: "x402_too_many_unpaid",
        message: X402_DOOR_MESSAGES.tooManyUnpaid,
        retryAfterSeconds: dayLeft,
      });
    }
  }
  const payerLimits = await consumeAll(deps.limiter, [
    {
      scope: "ip",
      key: x402DoorKeys.walletMinute(wallet, handle),
      limit: deps.limits.perBuyerPerMinute,
      windowSeconds: MINUTE,
    },
    {
      scope: "ip",
      key: x402DoorKeys.walletDay(wallet, handle, day),
      limit: deps.limits.perBuyerPerDay,
      windowSeconds: dayLeft,
    },
    {
      scope: "ip",
      key: x402DoorKeys.addressDay(input.bucket, day),
      limit: deps.limits.perBuyerPerDay,
      windowSeconds: dayLeft,
    },
  ]);
  if (payerLimits?.status === "limited") {
    return refusalOf({
      status: 429,
      code: "rate_limited",
      message: X402_DOOR_MESSAGES.walletOrAddressDay,
      retryAfterSeconds: payerLimits.retryAfterSeconds,
    });
  }
  if (payerLimits) {
    deps.logger?.error({ surface: "x402" }, "x402 door refused: the rate limiter is unavailable");
    return refusalOf(CANNOT_COUNT);
  }

  // 8. The chain, read only. What a node says goes to the log, never to the caller.
  try {
    const accounts = await deps.chain.accounts({
      feePayer: wire.feePayer,
      source: checked.source,
      destination: checked.destination,
    });
    if (accounts.feePayerLamports === null || accounts.feePayerLamports < X402_FEE_PAYER_MIN_LAMPORTS) {
      deps.logger?.error(
        { feePayer: wire.feePayer, lamports: accounts.feePayerLamports?.toString() ?? null },
        "x402 door not available: the fee payer holds less SOL than its floor",
      );
      return refusalOf(UNAVAILABLE());
    }
    if (!accounts.destinationExists) {
      deps.logger?.error({ destination: checked.destination }, "x402 door not available: the treasury has no USDC account");
      return refusalOf(UNAVAILABLE());
    }
    // The notes give no string of their own for a payer with no token account.
    if (!accounts.sourceExists) return paymentRefused(X402_ERROR_REASONS.transactionSimulationFailed);
    if (!(await deps.chain.blockhashValid(checked.recentBlockhash))) {
      return paymentRefused(X402_ERROR_REASONS.transactionSimulationFailed);
    }
    const simulated = await deps.chain.simulate(transactionB64);
    if (!simulated.ok) {
      deps.logger?.warn({ err: simulated.err, listingId: listing.id }, "x402 door: a payment would not go through");
      return paymentRefused(X402_ERROR_REASONS.transactionSimulationFailed);
    }
  } catch (err) {
    deps.logger?.error({ err }, "x402 door refused: the chain could not be read");
    return refusalOf(UNAVAILABLE());
  }

  // 9. A shutdown slot of the door's own.
  const begun = deps.inFlight.begin();
  if (!begun) return refusalOf(UNAVAILABLE(RESTART_RETRY_SECONDS));
  const slot: RunSlot = begun;
  try {
    return await claimedUse();
  } finally {
    // 17. After the last write.
    slot.done();
  }

  async function claimedUse(): Promise<X402UseResult<R>> {
    // 10. The claim. Nothing that can land is stored: no signature, no bytes.
    let claim: Awaited<ReturnType<typeof claimHeldPayment>>;
    try {
      claim = await claimHeldPayment(
        {
          listingId: listing.id,
          orgId: listing.publisherId,
          messageHash: checked.messageHash,
          requestId: nonce,
          network: wire.rowNetwork,
          amountRaw: requirements.amount,
          payerAddress: wallet,
          payeeAddress: wire.treasury,
          recentBlockhash: checked.recentBlockhash,
        },
        deps.payments,
      );
    } catch (err) {
      deps.logger?.error({ err }, "x402 door refused: a payment could not be claimed");
      return refusalOf(UNAVAILABLE());
    }
    if (!claim.claimed) {
      if (claim.reason === "duplicate") return paymentRefused(X402_ERROR_REASONS.duplicateSettlement);
      return refusalOf({
        status: 429,
        code: "rate_limited",
        message: X402_DOOR_MESSAGES.walletStillOpen,
        retryAfterSeconds: Math.ceil(X402_SEND_BY_MS / 1000),
      });
    }
    const paymentId = claim.paymentId;
    const progress: { signature: string | null } = { signature: null };
    try {
      return await heldUse(paymentId, progress);
    } catch (err) {
      // A dependency threw. A held row is ended unsent; a sent one is left
      // submitted for the settlement worker, which reads the chain.
      deps.logger?.error({ err, paymentId }, "x402 door: a use ended on an error");
      if (progress.signature === null) {
        await failHeldPayment(paymentId, "never_sent", deps.payments).catch(() => false);
        return refusalOf(UNAVAILABLE());
      }
      return refusalOf({
        status: 504,
        code: "x402_payment_unconfirmed",
        message: X402_DOOR_MESSAGES.unconfirmed,
        transaction: progress.signature,
      });
    }
  }

  /** One more answer made for a payment that did not go through, for the wallet and the address. Best effort. */
  async function countUnpaid(): Promise<void> {
    try {
      const counted = await deps.limiter.consume(
        unpaidKeys.map((key) => ({ scope: "ip", key, limit: COUNT_ONLY, windowSeconds: dayLeft })),
      );
      if (counted.status !== "ok") deps.logger?.warn({ surface: "x402" }, "x402 door: an unpaid answer could not be counted");
    } catch (err) {
      deps.logger?.warn({ err }, "x402 door: an unpaid answer could not be counted");
    }
  }

  /** A held payment ends with nothing signed and nothing sent. */
  async function endHeld(
    paymentId: string,
    reason: X402DoorFailure,
    refusal: PaidUseRefusal,
    options: { unpaid?: boolean; headers?: Record<string, string> } = {},
  ): Promise<Refused> {
    await failHeldPayment(paymentId, reason, deps.payments).catch((err) => {
      deps.logger?.error({ err, paymentId }, "x402 door: a held payment could not be marked failed; the worker ends it");
      return false;
    });
    if (options.unpaid) await countUnpaid();
    return refusalOf(refusal, options.headers);
  }

  /** PAYMENT-RESPONSE of a payment that did not go through. */
  function notThrough(): Record<string, string> {
    return {
      [X402_PAYMENT_RESPONSE_HEADER]: encodePaymentResponse({
        success: false,
        errorReason: X402_ERROR_REASONS.transactionFailed,
        transaction: "",
        network: caip2,
      }),
    };
  }

  async function heldUse(paymentId: string, progress: { signature: string | null }): Promise<X402UseResult<R>> {
    const elapsed = () => deps.now().getTime() - input.arrivedAt.getTime();
    const TOO_SLOW: PaidUseRefusal = { status: 504, code: "answer_timed_out", message: X402_DOOR_MESSAGES.tooSlow };
    const CALLER_LEFT: PaidUseRefusal = {
      status: 499,
      code: "client_closed_request",
      message: X402_DOOR_MESSAGES.callerLeft,
    };
    // The shutdown slot is honoured only while the row is held.
    const stop = AbortSignal.any([input.signal, slot.signal]);

    // 11. The answer, made and checked whole. Not one byte leaves.
    const left = X402_ANSWER_DEADLINE_MS - elapsed();
    if (left <= 0) return endHeld(paymentId, "answer_timed_out", TOO_SLOW);
    const answer = await deps.makeAnswer({
      agent,
      listing,
      messages,
      systemAddendum,
      promptChars,
      deadlineMs: Math.min(deps.limits.timeLimitMs, left),
      signal: stop,
      admit: async () => {
        const told = await consumeAll(deps.limiter, [
          {
            scope: "agent",
            key: x402DoorKeys.agentMinute(agent.id),
            limit: deps.limits.perAgentPerMinute,
            windowSeconds: MINUTE,
          },
        ]);
        if (!told) return null;
        if (told.status === "limited") return { ending: "agent_limit", retryAfterSeconds: told.retryAfterSeconds };
        return { ending: "cannot_count" };
      },
    });

    // 12. No answer: the row is failed, nothing is signed.
    if (!answer.ok) {
      switch (answer.ending) {
        case "answer_withheld":
          return endHeld(
            paymentId,
            "answer_withheld",
            { status: 502, code: "answer_withheld", message: X402_DOOR_MESSAGES.withheld },
            { unpaid: true },
          );
        case "answer_timed_out":
          return endHeld(paymentId, "answer_timed_out", TOO_SLOW, { unpaid: true });
        case "stopped":
          if (input.signal.aborted) return endHeld(paymentId, "client_closed_request", CALLER_LEFT, { unpaid: true });
          // The server is stopping, or the signal fired for no caller: not the payer's doing.
          return endHeld(paymentId, "never_sent", UNAVAILABLE(RESTART_RETRY_SECONDS));
        case "model_error":
          return endHeld(paymentId, "model_error", {
            status: 502,
            code: "model_error",
            message: X402_DOOR_MESSAGES.modelFailed,
          });
        case "paused":
          return endHeld(paymentId, "model_error", { status: 503, code: "agent_paused", message: X402_DOOR_MESSAGES.paused });
        case "cannot_count":
          return endHeld(paymentId, "never_sent", CANNOT_COUNT);
        case "agent_limit":
          return endHeld(paymentId, "never_sent", UNAVAILABLE(answer.retryAfterSeconds ?? MINUTE));
        case "unavailable":
          return endHeld(paymentId, "model_error", UNAVAILABLE(answer.retryAfterSeconds));
      }
    }
    if (elapsed() > X402_ANSWER_DEADLINE_MS) {
      return endHeld(paymentId, "answer_timed_out", TOO_SLOW, { unpaid: true });
    }

    // 13. Before anything is signed.
    const stillSendable = (): Promise<Refused> | null => {
      if (input.signal.aborted) return endHeld(paymentId, "client_closed_request", CALLER_LEFT, { unpaid: true });
      if (slot.signal.aborted) return endHeld(paymentId, "never_sent", UNAVAILABLE(RESTART_RETRY_SECONDS));
      if (elapsed() > X402_SEND_BY_MS) return endHeld(paymentId, "answer_timed_out", TOO_SLOW, { unpaid: true });
      return null;
    };
    const before = stillSendable();
    if (before) return before;
    let blockhashValid: boolean;
    try {
      blockhashValid = await deps.chain.blockhashValid(checked.recentBlockhash);
    } catch (err) {
      deps.logger?.error({ err, paymentId }, "x402 door: the chain could not be read before the send; nothing was sent");
      return endHeld(paymentId, "chain_unreadable", UNAVAILABLE());
    }
    if (!blockhashValid) {
      return endHeld(
        paymentId,
        "expired",
        { status: 402, code: "x402_payment_failed", message: X402_DOOR_MESSAGES.expired, ...priced },
        { unpaid: true, headers: notThrough() },
      );
    }
    // The read took its time: asked again on this side of it.
    const afterRead = stillSendable();
    if (afterRead) return afterRead;

    // 14. Signed by the fee payer, on exactly the bytes this request holds,
    // which the signer checks again; recorded as submitted; only then sent.
    const signed = deps.signAsFeePayer(transactionB64, requirements);
    if ("invalidReason" in signed) {
      deps.logger?.error(
        { paymentId, reason: signed.invalidReason },
        "x402 door: the fee payer refused a payment that had passed its checks; nothing was sent",
      );
      return endHeld(paymentId, "never_sent", UNAVAILABLE());
    }
    const submitted = await submitHeldPayment({ paymentId, messageHash: checked.messageHash, signed }, deps.payments);
    if (submitted.outcome === "duplicate") {
      // The same message under another row: this row is failed and nothing was sent.
      await countUnpaid();
      return paymentRefused(X402_ERROR_REASONS.duplicateSettlement);
    }
    if (submitted.outcome === "not_claimed") {
      deps.logger?.error({ paymentId }, "x402 door: a payment was no longer held at its send; nothing was sent");
      return refusalOf(UNAVAILABLE());
    }
    const signature = submitted.txSignature;
    progress.signature = signature;
    // From here the payment may land: the shutdown slot no longer stops it,
    // and nothing is called failed while it can still land.

    // 15. The wait.
    const fate = await awaitDoorPayment(
      { paymentId, signature, blockhash: checked.recentBlockhash, sentAt: submitted.sentAt },
      deps.payments,
    );
    if (fate === "landed_failed") {
      await countUnpaid();
      return refusalOf(
        { status: 402, code: "x402_payment_failed", message: X402_DOOR_MESSAGES.chainRefused, ...priced },
        notThrough(),
      );
    }
    if (fate === "dead") {
      await countUnpaid();
      return refusalOf(
        { status: 402, code: "x402_payment_failed", message: X402_DOOR_MESSAGES.expired, ...priced },
        notThrough(),
      );
    }
    if (fate === "unconfirmed") {
      // Left submitted for the settlement worker, which finishes it from the chain.
      return refusalOf({
        status: 504,
        code: "x402_payment_unconfirmed",
        message: X402_DOOR_MESSAGES.unconfirmed,
        transaction: signature,
      });
    }

    // 16. Confirmed.
    const unserved = async (why: string, err?: unknown): Promise<Refused> => {
      const marked = await markUnserved(paymentId, deps.payments).catch((markErr) => {
        deps.logger?.error({ err: markErr, paymentId }, "x402 door: a payment could not be marked unserved");
        return null;
      });
      if (marked === false) {
        // No longer submitted: a sale that committed and then failed to answer
        // may hold it, so the operator checks this one by hand.
        deps.logger?.error({ paymentId, signature }, "x402 door: a payment was no longer submitted when marked unserved; it may hold a sale");
      }
      deps.logger?.error({ err, paymentId, signature }, `x402 door: a confirmed payment was not served: ${why}`);
      return refusalOf({
        status: 502,
        code: "x402_payment_unserved",
        message: X402_DOOR_MESSAGES.unserved,
        transaction: signature,
      });
    };
    if (input.signal.aborted) return unserved("the caller left before the answer could be released");

    // Everything the release needs is built before the sale is written, so
    // nothing that could throw stands between a written sale and the answer.
    const billing: PaidUseBilling = {
      // The price the payment was checked against: its amount is this times 10,000.
      chargedCents: Number(priceCents),
      balanceCents: null,
      access: "listing_pricing",
    };
    const paymentResponse = encodePaymentResponse({
      success: true,
      payer: wallet,
      transaction: signature,
      network: caip2,
      amount: requirements.amount,
    });
    const stream = wantsStream ? withBillingEvent(toPublicStream(answer.chat), billing) : null;

    let sale: X402SaleResult;
    try {
      // The row's own values: what was claimed is what was paid.
      sale = await deps.recordSale({
        paymentId,
        listingId: listing.id,
        listingTitle: listing.title,
        publisherId: listing.publisherId,
        payerWallet: wallet,
        amountRaw: requirements.amount,
        modelCostMicros: answer.modelCostMicros,
        now: deps.now(),
      });
    } catch (err) {
      return unserved("its sale could not be written", err);
    }
    if (!sale.written) return unserved("its row was no longer submitted");

    // Released: the answer, whole or replayed as a stream, and what was paid.
    return {
      kind: "answer",
      useKind: input.kind,
      text: answer.text,
      toolCalls: answer.toolCalls,
      billing,
      paymentResponse,
      headers: { [X402_PAYMENT_RESPONSE_HEADER]: paymentResponse },
      stream,
    };
  }
}
