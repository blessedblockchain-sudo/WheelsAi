/**
 * What happens to an x402 payment (payments pass, batch 8).
 *
 * A request paid with an on-chain transfer goes through these steps, and
 * the order is the point:
 *
 *   1. BEFORE ANY PAYMENT IS LOOKED AT: the deployment has a healthy node
 *      and the node behind the connection serves the configured chain.
 *      Otherwise nothing is touched.
 *   2. The payment is read and judged against the request's price. A
 *      refusal broadcasts nothing and loses nothing.
 *   3. A signature that already has a row was used: nothing more happens.
 *   4. CLAIM FIRST: the row is written as "submitted" with the signature
 *      and the signed bytes. Only then is the transaction sent. A send
 *      error decides nothing.
 *   5. ONLY THE CHAIN SAYS what became of it. The signature's fate is read
 *      until it has landed or the wait is over:
 *        landed_ok      "submitted" -> "verified"; the request is served
 *        landed_failed  -> "failed"; nothing was taken
 *        not known      the row stays "submitted" for the settlement worker
 *   6. A served request sets `servedAt`; a request that produced no answer
 *      has its payment returned (services/x402Refund.ts). One or the other,
 *      by compare-and-set, never both.
 *   7. The settlement worker finishes every row from the fate and nothing
 *      else (`settleX402Row`): there is no count of attempts that ends one.
 *
 * With broadcasting off (development only) nothing is sent and nothing is
 * read from the chain: a payment that reads right is taken as landed, the
 * row is written "verified" at once, and the rest is the same.
 *
 * Pure: the settings, the clock, the chain, the rows, the price, the quote
 * and the decode are arguments (services/buildX402PaymentsDeps.ts binds
 * them). No sentence here reaches a payer; the reasons are the four in
 * services/x402Types.ts.
 *
 * The x402 door of a listing (one use of an agent, paid from a wallet in
 * the published format) keeps the opposite order and has functions of its
 * own below ("The door"): nothing of takeX402Payment is used for it.
 */

import type { SignatureFate, SignatureConfirmationLevel } from "./signatureFate.js";
import type { PaymentHeader, PaymentRequirement, X402Network } from "./x402.js";
import { X402_DOOR_CONFIRM_MAX_MS, X402_DOOR_DEAD_TRUSTED_AFTER_MS, X402_DOOR_FINISH_AFTER_MS } from "./x402DoorRules.js";
import type { FeePayerSigned } from "./x402FeePayer.js";
import type { X402RefundResult, X402RefundableStatus } from "./x402Refund.js";
import type {
  DecodeX402Result,
  DecodedX402Payment,
  X402Asset,
  X402PaymentWanted,
  X402Price,
  X402RefusalReason,
} from "./x402Types.js";

// ============================================
// Ages the settlement worker waits for
// ============================================

/**
 * A blockhash lives about a minute and a half. A "submitted" row is called
 * dead only once that life has CERTAINLY passed: a blockhash too new to be
 * finalized also reads as "not valid at finalized" (services/signatureFate.ts).
 */
export const X402_DEAD_AFTER_MS = 3 * 60 * 1000;

/**
 * A "verified" row with no `servedAt` this old belongs to a request whose
 * process died before it answered: the payment is returned.
 */
export const X402_UNSERVED_AFTER_MS = 10 * 60 * 1000;

/**
 * The worker leaves a "submitted" row to the request that wrote it for the
 * request's own wait plus this much. Safety does not rest on it (every
 * change is a compare-and-set); it keeps the worker from returning a
 * payment a request is about to serve.
 */
export const X402_REQUEST_GRACE_MS = 15_000;

// ============================================
// Dependencies
// ============================================

export interface X402Settings {
  network: X402Network;
  /** The asset a challenge asks for. SOL falls back to USDC with no price. */
  defaultAsset: X402Asset;
  /** The treasury wallet. */
  payTo: string;
  usdcMint: string;
  /** The treasury wallet's USDC account: where a USDC transfer must go. */
  payToTokenAccount: string;
  quoteTtlSeconds: number;
  confirmWaitMs: number;
  pollIntervalMs: number;
  /** false (development only): nothing is sent, nothing is read from the chain. */
  submitTransactions: boolean;
}

/**
 * The statuses a payment's row is written with. A deployment's payment is
 * "submitted" or "verified"; a payment at a listing's door is "held" first:
 * claimed while its answer is made, with nothing signed and nothing that can
 * land.
 */
export type X402NewPaymentStatus = "submitted" | "verified" | "held";

/**
 * Every status a payment's row can be in. A door payment also ends
 * "unserved": it landed, but its answer was not released, so there is no
 * sale, nobody is credited, and it is never returned as credits.
 */
export type X402PaymentStatus = X402NewPaymentStatus | "pending" | "settled" | "failed" | "refunded" | "unserved";

/** What a new payment's row holds. */
export interface X402NewPayment {
  orgId: string;
  /** The deployment a payment paid a request of. Null on a door payment. */
  deploymentId: string | null;
  /**
   * The listing a door payment paid one use of, whose publisher is orgId.
   * Absent or null on a deployment's payment, and never set with one.
   */
  listingId?: string | null;
  /** Hex sha256 of the transaction's message: a door payment's one key. Set with listingId only. */
  messageHash?: string | null;
  requestId: string;
  network: string;
  asset: X402Asset;
  /** What the request required, in base units. */
  amountRaw: string;
  /** The same in dollars, to show. */
  amountUsd: number;
  payerAddress: string;
  payeeAddress: string;
  /** Null on a held door payment: nothing that can land exists before its answer. */
  txSignature: string | null;
  status: X402NewPaymentStatus;
  signedTxB64: string | null;
  recentBlockhash: string;
  /** What the transfer actually carries, in base units. Null on a held door payment until its sale. */
  amountReceivedRaw: string | null;
  amountMicroUsd: bigint;
  solMicroUsdPerSol: bigint | null;
  submittedAt: Date | null;
  verifiedAt: Date | null;
}

export type X402InsertResult =
  | { ok: true; id: string }
  /** The unique index on the signature: this payment already has a row. */
  | { ok: false; reason: "duplicate_signature"; id: string | null };

export interface X402FateReading {
  fate: SignatureFate;
  confirmationStatus?: SignatureConfirmationLevel;
}

export type X402PaymentEvent =
  | { event: "refused"; requestId: string; reason: X402RefusalReason; detail?: string }
  | { event: "claimed"; paymentId: string; signature: string; asset: X402Asset }
  | { event: "send_error"; paymentId: string; signature: string; error: unknown }
  | { event: "landed"; paymentId: string; signature: string }
  | { event: "failed_on_chain"; paymentId: string; signature: string }
  | { event: "not_confirmed"; paymentId: string; signature: string; lastFate: SignatureFate }
  | { event: "lost_race"; paymentId: string; signature: string };

export interface X402PaymentsDeps {
  /** Read on every call. */
  settings(): X402Settings;
  now(): Date;
  sleep(ms: number): Promise<void>;

  // The price, the rate lock and the decode (services/x402Price.ts,
  // x402Quote.ts, x402Decode.ts).
  priceFor(args: { microUsd: bigint; asset: X402Asset; solRateMicroUsdPerSol?: bigint | null }): X402Price;
  microUsdToUsd(microUsd: bigint): number;
  /** The rate SOL coming in is counted at now, or null: there is no price. Never throws. */
  solRate(): Promise<bigint | null>;
  signQuote(payload: { orgId: string; deploymentId: string; solMicroUsdPerSol: bigint }): string;
  /** The rate a presented token locked, or null for any token that is not good. */
  readQuote(token: string, scope: { orgId: string; deploymentId: string }): bigint | null;
  decode(signedTxBase64: string, want: X402PaymentWanted): DecodeX402Result;

  // The chain.
  /** Whether the node serves the configured chain. Never throws. */
  clusterOk(): Promise<boolean>;
  /** Sends the signed bytes. May throw; a throw decides nothing. */
  broadcast(signedTxB64: string): Promise<void>;
  /** What became of a signature. Never throws: a failed read is "unknown". */
  readFate(input: { signature: string; blockhash: string | null }): Promise<X402FateReading>;

  // The rows.
  findPaymentBySignature(signature: string): Promise<{ id: string } | null>;
  /** Writes the row. A unique violation on the signature is an answer, not a throw. */
  insertPayment(data: X402NewPayment): Promise<X402InsertResult>;
  /** "submitted" -> "verified". false: the row was no longer "submitted". */
  markVerified(paymentId: string, at: Date): Promise<boolean>;
  /** "submitted" -> "failed": the transaction landed and failed. */
  markFailedOnChain(paymentId: string): Promise<boolean>;
  /** Sets servedAt on a "verified" row that is neither served nor returned. */
  markServed(paymentId: string, at: Date): Promise<boolean>;
  refund(input: { paymentId: string; from: X402RefundableStatus[]; now: Date }): Promise<X402RefundResult>;

  log(event: X402PaymentEvent): void;
}

// ============================================
// The challenge
// ============================================

export interface X402RequestScope {
  orgId: string;
  deploymentId: string;
  requestId: string;
  /** The request's price in micro-dollars (services/x402Price.ts). */
  microUsd: bigint;
}

/**
 * The `payment` object of a 402. USDC unless SOL is the configured asset
 * AND it has a price at this moment: USDC always works. A SOL challenge
 * carries the rate lock the paid retry hands back.
 */
export async function x402Requirement(
  scope: X402RequestScope,
  deps: X402PaymentsDeps,
): Promise<PaymentRequirement> {
  const settings = deps.settings();
  const validUntil = Math.floor(deps.now().getTime() / 1000) + settings.quoteTtlSeconds;
  const base = {
    scheme: "exact" as const,
    network: settings.network,
    payTo: settings.payTo,
    memo: `deployment:${scope.deploymentId};request:${scope.requestId}`,
    validUntil,
  };

  if (settings.defaultAsset === "SOL") {
    const rate = await deps.solRate();
    if (rate !== null && rate > 0n) {
      try {
        const price = deps.priceFor({ microUsd: scope.microUsd, asset: "SOL", solRateMicroUsdPerSol: rate });
        const quote = deps.signQuote({
          orgId: scope.orgId,
          deploymentId: scope.deploymentId,
          solMicroUsdPerSol: rate,
        });
        return {
          ...base,
          asset: "SOL",
          amount: price.amountRaw.toString(),
          amountUsd: deps.microUsdToUsd(price.amountMicroUsd),
          payToTokenAccount: null,
          mint: null,
          quote,
        };
      } catch {
        // A rate that cannot price this request, or a lock that cannot be
        // signed: SOL is not offered. USDC is, below.
      }
    }
  }

  const price = deps.priceFor({ microUsd: scope.microUsd, asset: "USDC" });
  return {
    ...base,
    asset: "USDC",
    amount: price.amountRaw.toString(),
    amountUsd: deps.microUsdToUsd(price.amountMicroUsd),
    payToTokenAccount: settings.payToTokenAccount,
    mint: settings.usdcMint,
    quote: null,
  };
}

// ============================================
// Taking a payment (steps 1 to 5)
// ============================================

export interface X402TakeInput extends X402RequestScope {
  /** The parsed `X-Payment` header. */
  header: PaymentHeader;
  /** Whether the deployment has a healthy node at this moment. */
  hasHealthyNode: boolean;
}

export type X402TakeResult =
  /** The payment landed (or, with broadcasting off, reads right). Serve the request. */
  | { outcome: "taken"; paymentId: string }
  /** Not taken. The payer reads a fresh 402 with this reason. */
  | { outcome: "refused"; reason: X402RefusalReason }
  /** The signature already has a row. */
  | { outcome: "already_used"; paymentId: string | null }
  /** Step 1 failed: no payment was looked at. */
  | { outcome: "unavailable"; why: "no_healthy_node" | "chain_unavailable" };

type Judged =
  | { ok: true; price: X402Price; payment: DecodedX402Payment }
  | { ok: false; reason: X402RefusalReason; detail: string };

/** Step 2: read the payment and judge it against the request's price. */
function judge(input: X402TakeInput, settings: X402Settings, deps: X402PaymentsDeps): Judged {
  if (input.header.network !== settings.network) {
    return { ok: false, reason: "payment_invalid", detail: "network" };
  }
  const want = (price: X402Price): X402PaymentWanted => ({
    asset: price.asset,
    payTo: settings.payTo,
    usdcMint: settings.usdcMint,
    minAmountRaw: price.amountRaw,
  });

  // SOL, at the rate the challenge locked. Never at a rate read now: the
  // retry is held to the price it was shown.
  let lockedRate: bigint | null = null;
  if (settings.defaultAsset === "SOL" && input.header.quote) {
    lockedRate = deps.readQuote(input.header.quote, {
      orgId: input.orgId,
      deploymentId: input.deploymentId,
    });
    if (lockedRate !== null) {
      let solPrice: X402Price | null = null;
      try {
        solPrice = deps.priceFor({
          microUsd: input.microUsd,
          asset: "SOL",
          solRateMicroUsdPerSol: lockedRate,
        });
      } catch {
        solPrice = null;
      }
      if (solPrice) {
        const read = deps.decode(input.header.signature, want(solPrice));
        if (read.ok) return { ok: true, price: solPrice, payment: read.payment };
      }
    }
  }

  // USDC always works: it needs no rate and no lock.
  const usdcPrice = deps.priceFor({ microUsd: input.microUsd, asset: "USDC" });
  const read = deps.decode(input.header.signature, want(usdcPrice));
  if (read.ok) return { ok: true, price: usdcPrice, payment: read.payment };

  // A transaction that cannot be read at all is invalid whatever the lock.
  // Otherwise, where SOL was asked for and no good lock came back, the
  // price is what is missing.
  const unreadable =
    read.reason === "not_a_transaction" ||
    read.reason === "bad_signature" ||
    read.reason === "uses_lookup_tables";
  if (settings.defaultAsset === "SOL" && lockedRate === null && !unreadable) {
    return { ok: false, reason: "quote_expired", detail: read.reason };
  }
  return { ok: false, reason: "payment_invalid", detail: read.reason };
}

export async function takeX402Payment(
  input: X402TakeInput,
  deps: X402PaymentsDeps,
): Promise<X402TakeResult> {
  const settings = deps.settings();

  // 1. Before any payment is looked at.
  if (!input.hasHealthyNode) return { outcome: "unavailable", why: "no_healthy_node" };
  if (settings.submitTransactions && !(await deps.clusterOk())) {
    return { outcome: "unavailable", why: "chain_unavailable" };
  }

  // 2. Read and judged. Nothing is broadcast on a refusal.
  const judged = judge(input, settings, deps);
  if (!judged.ok) {
    deps.log({ event: "refused", requestId: input.requestId, reason: judged.reason, detail: judged.detail });
    return { outcome: "refused", reason: judged.reason };
  }
  const { price, payment } = judged;

  // 3. A signature is used once.
  const existing = await deps.findPaymentBySignature(payment.signature);
  if (existing) return { outcome: "already_used", paymentId: existing.id };

  // 4. Claim first.
  const claimedAt = deps.now();
  const inserted = await deps.insertPayment({
    orgId: input.orgId,
    deploymentId: input.deploymentId,
    requestId: input.requestId,
    network: settings.network,
    asset: price.asset,
    amountRaw: price.amountRaw.toString(),
    amountUsd: deps.microUsdToUsd(price.amountMicroUsd),
    payerAddress: payment.payer,
    payeeAddress: settings.payTo,
    txSignature: payment.signature,
    status: settings.submitTransactions ? "submitted" : "verified",
    signedTxB64: payment.signedTxB64,
    recentBlockhash: payment.recentBlockhash,
    amountReceivedRaw: payment.amountRaw.toString(),
    amountMicroUsd: price.amountMicroUsd,
    solMicroUsdPerSol: price.solMicroUsdPerSol,
    submittedAt: settings.submitTransactions ? claimedAt : null,
    verifiedAt: settings.submitTransactions ? null : claimedAt,
  });
  if (!inserted.ok) return { outcome: "already_used", paymentId: inserted.id };
  const paymentId = inserted.id;
  const signature = payment.signature;
  deps.log({ event: "claimed", paymentId, signature, asset: price.asset });

  // Broadcasting off: taken as landed, nothing sent, nothing read.
  if (!settings.submitTransactions) return { outcome: "taken", paymentId };

  try {
    await deps.broadcast(payment.signedTxB64);
  } catch (error) {
    // Decides nothing: the transaction may have been sent all the same.
    deps.log({ event: "send_error", paymentId, signature, error });
  }

  // 5. Only the chain says.
  const deadline = deps.now().getTime() + settings.confirmWaitMs;
  let lastFate: SignatureFate = "unknown";
  for (;;) {
    const reading = await deps.readFate({ signature, blockhash: payment.recentBlockhash });
    lastFate = reading.fate;
    if (lastFate === "landed_ok") {
      if (await deps.markVerified(paymentId, deps.now())) {
        deps.log({ event: "landed", paymentId, signature });
        return { outcome: "taken", paymentId };
      }
      // The row is no longer "submitted": the settlement worker got to it
      // first and is returning it. This request must not serve it too.
      deps.log({ event: "lost_race", paymentId, signature });
      return { outcome: "refused", reason: "payment_not_confirmed" };
    }
    if (lastFate === "landed_failed") {
      await deps.markFailedOnChain(paymentId);
      deps.log({ event: "failed_on_chain", paymentId, signature });
      return { outcome: "refused", reason: "payment_failed_on_chain" };
    }
    // in_flight, unknown, and "dead" too: a blockhash this new can read as
    // expired before it is finalized. The worker decides, later.
    if (deps.now().getTime() + settings.pollIntervalMs > deadline) break;
    await deps.sleep(settings.pollIntervalMs);
  }
  deps.log({ event: "not_confirmed", paymentId, signature, lastFate });
  return { outcome: "refused", reason: "payment_not_confirmed" };
}

// ============================================
// After the request (step 6)
// ============================================

/** An answer was produced. false: the row was not there to be marked. */
export function markX402Served(paymentId: string, deps: X402PaymentsDeps): Promise<boolean> {
  return deps.markServed(paymentId, deps.now());
}

/** No answer was produced: the payment goes back, once. */
export function returnUnservedX402Payment(
  paymentId: string,
  deps: X402PaymentsDeps,
): Promise<X402RefundResult> {
  return deps.refund({ paymentId, from: ["verified"], now: deps.now() });
}

// ============================================
// The settlement worker (step 7)
// ============================================

/** The columns of a payment the worker reads. */
export interface X402SettlementRow {
  id: string;
  /** Set on a payment at a listing's door: the worker's door branches, and only those, take it. */
  listingId: string | null;
  status: string;
  txSignature: string | null;
  recentBlockhash: string | null;
  servedAt: Date | null;
  refundedAt: Date | null;
  submittedAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

export type X402SettleOutcome =
  /** Served and final: "verified" -> "settled". */
  | "settled"
  /** Landed and failed, or can never land, or a door payment never sent: -> "failed". */
  | "failed"
  /** Landed for a request that was never answered: returned as credits. */
  | "returned"
  /**
   * A door payment that landed after its request stopped waiting: no answer
   * was released, so there is no sale and nobody is credited. Never
   * returned as credits: the payer has no account.
   */
  | "unserved"
  /** Nothing can be said yet. Left exactly as it is for the next run. */
  | "waiting"
  /** Not a row for the worker, or another writer got there first. */
  | "skipped";

export interface X402SettlementDeps {
  submitTransactions: boolean;
  /** The request's own wait for its payment (X402_CONFIRM_WAIT_MS). */
  confirmWaitMs: number;
  now(): Date;
  /**
   * Whether the node serves the configured chain. Never throws. Asked
   * before every read of a fate: a node on another chain has no record of
   * any of our signatures, and its "never landed" must not fail a payment
   * that landed.
   */
  clusterOk(): Promise<boolean>;
  readFate(input: { signature: string; blockhash: string | null }): Promise<X402FateReading>;
  /** "verified" with servedAt -> "settled". */
  markSettled(paymentId: string, at: Date): Promise<boolean>;
  /** "submitted" -> "failed". */
  markFailed(paymentId: string, why: "failed_on_chain" | "never_landed"): Promise<boolean>;
  refund(input: { paymentId: string; from: X402RefundableStatus[]; now: Date }): Promise<X402RefundResult>;

  // A door payment's rows only (a listing's id is on them).
  /** "held" -> "failed": its request ended without sending it. */
  markHeldFailed(paymentId: string, reason: X402DoorFailure): Promise<boolean>;
  /** "submitted" -> "unserved". */
  markUnserved(paymentId: string): Promise<boolean>;
  /** What the operator is told about a door payment. */
  logDoor(event: X402DoorWorkerEvent): void;
}

/** What the worker reports of a door payment: each one is the operator's to look at. */
export type X402DoorWorkerEvent =
  /** It landed and its answer was not released: the USDC is in the treasury, nobody was credited. */
  | { event: "unserved"; paymentId: string; signature: string }
  /** Verified with no answer released, which the sale's one transaction never leaves: left, never returned. */
  | { event: "verified_not_served"; paymentId: string };

/**
 * One row, from the fate and nothing else. "unknown" and "in flight"
 * change nothing however often they are read.
 */
export async function settleX402Row(
  row: X402SettlementRow,
  deps: X402SettlementDeps,
): Promise<X402SettleOutcome> {
  // A payment at a listing's door is never returned as credits: its payer
  // has no account, and its row names the seller. It has branches of its own.
  if (isDoorRow(row)) return settleDoorRow(row, deps);

  const now = deps.now();

  if (row.status === "submitted") {
    if (!row.txSignature) return "skipped";
    // Nothing is read from the chain with broadcasting off, and nothing
    // else may decide a row that was sent.
    if (!deps.submitTransactions) return "waiting";
    const ageMs = now.getTime() - (row.submittedAt ?? row.createdAt).getTime();
    // The request that wrote it is still reading its fate.
    if (ageMs < deps.confirmWaitMs + X402_REQUEST_GRACE_MS) return "waiting";
    // A node on the wrong chain decides nothing.
    if (!(await deps.clusterOk())) return "waiting";

    const { fate } = await deps.readFate({ signature: row.txSignature, blockhash: row.recentBlockhash });
    if (fate === "landed_ok") {
      // It landed after its request had given up: never served, returned.
      const result = await deps.refund({ paymentId: row.id, from: ["submitted"], now });
      return result.returned ? "returned" : "skipped";
    }
    if (fate === "landed_failed") {
      return (await deps.markFailed(row.id, "failed_on_chain")) ? "failed" : "skipped";
    }
    if (fate === "dead" && ageMs >= X402_DEAD_AFTER_MS) {
      return (await deps.markFailed(row.id, "never_landed")) ? "failed" : "skipped";
    }
    return "waiting";
  }

  if (row.status === "verified") {
    if (row.refundedAt) return "skipped";
    if (row.servedAt) {
      if (!deps.submitTransactions) {
        return (await deps.markSettled(row.id, now)) ? "settled" : "skipped";
      }
      if (!row.txSignature) return "skipped";
      if (!(await deps.clusterOk())) return "waiting";
      const reading = await deps.readFate({ signature: row.txSignature, blockhash: row.recentBlockhash });
      if (reading.fate === "landed_ok" && reading.confirmationStatus === "finalized") {
        return (await deps.markSettled(row.id, now)) ? "settled" : "skipped";
      }
      return "waiting";
    }
    // Landed, and neither served nor returned: the request is running, or
    // its process died. After ten minutes it died.
    const ageMs = now.getTime() - (row.verifiedAt ?? row.createdAt).getTime();
    if (ageMs < X402_UNSERVED_AFTER_MS) return "waiting";
    const result = await deps.refund({ paymentId: row.id, from: ["verified"], now });
    return result.returned ? "returned" : "skipped";
  }

  return "skipped";
}

// ============================================
// The door: one use of a listing, paid from a wallet
// ============================================
//
// The published order, the reverse of takeX402Payment's: the payment is
// checked, then CLAIMED as "held" (its message hash, never anything that can
// land), then the answer is made and checked, and only then is it signed by
// the fee payer, sent, and waited for. The answer is released, and the sale
// written (services/x402Sale.ts), only once the chain confirms it.
//
//   held       claimed; the answer is being made; nothing signed or sent
//   submitted  signed and sent
//   verified   confirmed, the sale written and the answer released, in one
//              transaction
//   settled    verified and finalized (the worker)
//   failed     nothing taken: never sent, refused by the chain, or expired
//   unserved   confirmed, but the answer was not released: no sale, nobody
//              credited, never returned as credits
//
// These functions are the request's. The worker finishes what a request
// left (settleDoorRow, below), and only once the row is
// X402_DOOR_FINISH_AFTER_MS old, so it never races a request still waiting.

/** Why a held door payment ended unsent. Our own codes, kept on the row. */
export type X402DoorFailure =
  /** The model failed or refused. */
  | "model_error"
  /** The answer was made and could not be released. */
  | "answer_withheld"
  /** The answer, or the moment to send, came too late. */
  | "answer_timed_out"
  /** The caller left before anything was sent. */
  | "client_closed_request"
  /** The payment's blockhash expired before it was signed. */
  | "expired"
  /** The chain could not be read before the send. */
  | "chain_unreadable"
  /** The same message is already on another row. */
  | "presented_twice"
  /** Its request ended without a word: the worker's, or bytes that were not this row's. */
  | "never_sent";

/** Step 8's read of the three accounts a payment touches. */
export interface X402DoorAccounts {
  /** The fee payer's SOL, or null when it has no account at all. */
  feePayerLamports: bigint | null;
  /** The payer's token account. */
  sourceExists: boolean;
  /** The treasury's USDC account: the reference client never creates it. */
  destinationExists: boolean;
}

/**
 * The chain, read only, before a payment is claimed (step 8) and before it is
 * signed (step 13). A read that cannot be made in time throws: the door is
 * not available, and nothing is decided about the payment.
 */
export interface X402DoorChainReads {
  accounts(input: { feePayer: string; source: string; destination: string }): Promise<X402DoorAccounts>;
  /** Whether the payment's blockhash can still land, at "confirmed". */
  blockhashValid(blockhash: string): Promise<boolean>;
  /**
   * The payment as it stands, partially signed, simulated without checking
   * signatures and on its own blockhash. A failure is an answer (the node's
   * words are for the log only), never a throw.
   */
  simulate(transactionB64: string): Promise<{ ok: true } | { ok: false; err: unknown }>;
}

/** A door payment's row as it is claimed. */
export interface X402HeldClaim {
  listingId: string;
  /** The listing's publisher: a door payment's organization is the seller's. */
  orgId: string;
  /** Hex sha256 of the transaction's message (verifyExactSvmTransaction). */
  messageHash: string;
  /** The memo's nonce. */
  requestId: string;
  /** Today's network strings, never CAIP-2: the worker selects by them. */
  network: X402Network;
  /** USDC atomic units, as the requirements ask: the price in cents times 10,000. */
  amountRaw: string;
  /** The wallet that pays: the transfer's authority. */
  payerAddress: string;
  /** The treasury. */
  payeeAddress: string;
  recentBlockhash: string;
}

/** The row a claim writes. */
export type X402HeldRow = X402NewPayment & {
  listingId: string;
  messageHash: string;
  status: "held";
  deploymentId: null;
  txSignature: null;
  signedTxB64: null;
};

export type X402HeldInsert =
  | { ok: true; id: string }
  /**
   * duplicate    the unique message_hash: this payment was presented before
   * wallet_busy  the one-open index: a door payment of this wallet is held or
   *              submitted
   */
  | { ok: false; reason: "duplicate" | "wallet_busy" };

export type X402DoorPaymentEvent =
  | { event: "claimed"; paymentId: string; listingId: string }
  | { event: "claim_refused"; listingId: string; reason: "duplicate" | "wallet_busy" }
  | { event: "held_failed"; paymentId: string; reason: X402DoorFailure; changed: boolean }
  | { event: "not_claimed"; paymentId: string; why: "not_held" | "other_message" }
  | { event: "presented_twice"; paymentId: string }
  | { event: "submitted"; paymentId: string; signature: string }
  | { event: "send_error"; paymentId: string; signature: string; error: unknown }
  | { event: "landed"; paymentId: string; signature: string }
  | { event: "failed_on_chain"; paymentId: string; signature: string }
  | { event: "never_landed"; paymentId: string; signature: string }
  | { event: "unconfirmed"; paymentId: string; signature: string; lastFate: SignatureFate }
  | { event: "unserved"; paymentId: string; changed: boolean };

/** The reads and writes of a door payment. Every write is a compare-and-set by status. */
export interface X402DoorPaymentsDeps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** How often the request asks what became of its payment (X402_FATE_POLL_MS). */
  pollIntervalMs: number;

  /** The row with this message hash, read only. */
  findByMessageHash(messageHash: string): Promise<{ id: string; status: string } | null>;
  /** Writes the held row. A unique violation is an answer, told apart by its index. */
  insertHeld(row: X402HeldRow): Promise<X402HeldInsert>;
  /** "held" -> "failed" with the reason. */
  markHeldFailed(paymentId: string, reason: X402DoorFailure): Promise<boolean>;
  /**
   * "held" -> "submitted" with the signature, the signed bytes and the time
   * sent, only on the row claimed for this message hash (the row's own
   * message_hash is part of the compare-and-set, so signed bytes can never
   * be written to another payment's row). "duplicate_signature": the unique
   * tx_signature, the same message on another row; nothing was written.
   */
  markSubmitted(
    paymentId: string,
    sent: { txSignature: string; signedTxB64: string; submittedAt: Date; messageHash: string },
  ): Promise<"submitted" | "not_held" | "duplicate_signature">;
  /** Sends the signed bytes. May throw; a throw decides nothing. */
  broadcast(signedTxB64: string): Promise<void>;
  /** What became of a signature. Never throws: a failed read is "unknown". */
  readFate(input: { signature: string; blockhash: string | null }): Promise<X402FateReading>;
  /** "submitted" -> "failed" with the words of the chain's answer. */
  markSentFailed(paymentId: string, why: "failed_on_chain" | "never_landed"): Promise<boolean>;
  /** "submitted" -> "unserved". */
  markUnserved(paymentId: string): Promise<boolean>;

  log(event: X402DoorPaymentEvent): void;
}

const WHOLE_ATOMIC_UNITS = /^[1-9][0-9]{0,29}$/;

/** USDC has 6 decimals, so an atomic unit is a micro-dollar. */
function usdcMicroUsd(amountRaw: string): bigint {
  if (!WHOLE_ATOMIC_UNITS.test(amountRaw)) throw new Error("x402 door: an amount is a whole number of atomic units");
  return BigInt(amountRaw);
}

/** Step 6 of the door: the row of a message, if it was presented before. Writes nothing. */
export function findDoorPaymentByHash(
  messageHash: string,
  deps: X402DoorPaymentsDeps,
): Promise<{ id: string; status: string } | null> {
  return deps.findByMessageHash(messageHash);
}

export type X402ClaimResult =
  | { claimed: true; paymentId: string }
  | { claimed: false; reason: "duplicate" | "wallet_busy" };

/**
 * Step 10: the claim, before the answer is made. The row holds the
 * message's hash and nothing that can land: no signature, no bytes. The
 * unique message hash holds a payment to one answer across every process;
 * the one-open index holds a wallet to one payment in flight.
 */
export async function claimHeldPayment(claim: X402HeldClaim, deps: X402DoorPaymentsDeps): Promise<X402ClaimResult> {
  const amountMicroUsd = usdcMicroUsd(claim.amountRaw);
  const inserted = await deps.insertHeld({
    orgId: claim.orgId,
    deploymentId: null,
    listingId: claim.listingId,
    messageHash: claim.messageHash,
    requestId: claim.requestId,
    network: claim.network,
    asset: "USDC",
    amountRaw: claim.amountRaw,
    amountUsd: Number(amountMicroUsd) / 1_000_000,
    payerAddress: claim.payerAddress,
    payeeAddress: claim.payeeAddress,
    txSignature: null,
    status: "held",
    signedTxB64: null,
    recentBlockhash: claim.recentBlockhash,
    // What the transfer carried is written with the sale, once it landed.
    amountReceivedRaw: null,
    amountMicroUsd,
    solMicroUsdPerSol: null,
    submittedAt: null,
    verifiedAt: null,
  });
  if (!inserted.ok) {
    deps.log({ event: "claim_refused", listingId: claim.listingId, reason: inserted.reason });
    return { claimed: false, reason: inserted.reason };
  }
  deps.log({ event: "claimed", paymentId: inserted.id, listingId: claim.listingId });
  return { claimed: true, paymentId: inserted.id };
}

/** Step 12 and 13: a held payment ends with nothing signed and nothing sent. */
export async function failHeldPayment(
  paymentId: string,
  reason: X402DoorFailure,
  deps: X402DoorPaymentsDeps,
): Promise<boolean> {
  const changed = await deps.markHeldFailed(paymentId, reason);
  deps.log({ event: "held_failed", paymentId, reason, changed });
  return changed;
}

export type X402SubmitResult =
  /** Signed, recorded as submitted, and handed to the chain (a send that threw decides nothing). */
  | { outcome: "sent"; txSignature: string; sentAt: Date }
  /** The row was not held for these bytes: nothing was sent. */
  | { outcome: "not_claimed" }
  /** The same message under another row: this row is failed, nothing was sent. */
  | { outcome: "duplicate" };

/**
 * Step 14: the payment signed by the fee payer (services/x402FeePayer.ts
 * signAsFeePayer, on the bytes the request holds) is recorded as submitted
 * by compare-and-set FIRST, and sent only once that has written exactly its
 * row. A row no longer held sends nothing.
 */
export async function submitHeldPayment(
  input: { paymentId: string; messageHash: string; signed: FeePayerSigned },
  deps: X402DoorPaymentsDeps,
): Promise<X402SubmitResult> {
  const { paymentId, signed } = input;
  // Signed bytes stand only for the payment their row was claimed for. This
  // refuses early; the compare-and-set below holds it against the row itself.
  if (signed.messageHash !== input.messageHash) {
    deps.log({ event: "not_claimed", paymentId, why: "other_message" });
    await failHeldPayment(paymentId, "never_sent", deps);
    return { outcome: "not_claimed" };
  }
  const sentAt = deps.now();
  const recorded = await deps.markSubmitted(paymentId, {
    txSignature: signed.txSignature,
    signedTxB64: signed.signedTxB64,
    submittedAt: sentAt,
    messageHash: signed.messageHash,
  });
  if (recorded === "duplicate_signature") {
    deps.log({ event: "presented_twice", paymentId });
    await failHeldPayment(paymentId, "presented_twice", deps);
    return { outcome: "duplicate" };
  }
  if (recorded !== "submitted") {
    deps.log({ event: "not_claimed", paymentId, why: "not_held" });
    return { outcome: "not_claimed" };
  }
  deps.log({ event: "submitted", paymentId, signature: signed.txSignature });
  try {
    await deps.broadcast(signed.signedTxB64);
  } catch (error) {
    // Decides nothing: the transaction may have reached the chain all the same.
    deps.log({ event: "send_error", paymentId, signature: signed.txSignature, error });
  }
  return { outcome: "sent", txSignature: signed.txSignature, sentAt };
}

/**
 * What the wait of step 15 ends with:
 *   landed_ok      confirmed: write the sale and release the answer
 *   landed_failed  it landed and failed: the row is failed
 *   dead           it can never land: the row is failed
 *   unconfirmed    nothing final within X402_DOOR_CONFIRM_MAX_MS: the row
 *                  stays submitted for the worker, and nothing is called
 *                  failed while it can still land
 */
export type X402DoorWait = "landed_ok" | "landed_failed" | "dead" | "unconfirmed";

/**
 * Step 15: read the fate on the clock until the chain says something final
 * or the wait is over. A "dead" read sooner than
 * X402_DOOR_DEAD_TRUSTED_AFTER_MS after the send is not believed: a
 * brand-new blockhash reads not valid at finalized for about 13 seconds.
 */
export async function awaitDoorPayment(
  input: { paymentId: string; signature: string; blockhash: string; sentAt: Date },
  deps: X402DoorPaymentsDeps,
): Promise<X402DoorWait> {
  const { paymentId, signature } = input;
  const sentMs = input.sentAt.getTime();
  const deadline = sentMs + X402_DOOR_CONFIRM_MAX_MS;
  let lastFate: SignatureFate = "unknown";
  for (;;) {
    const reading = await deps.readFate({ signature, blockhash: input.blockhash });
    lastFate = reading.fate;
    if (lastFate === "landed_ok") {
      deps.log({ event: "landed", paymentId, signature });
      return "landed_ok";
    }
    if (lastFate === "landed_failed") {
      await deps.markSentFailed(paymentId, "failed_on_chain");
      deps.log({ event: "failed_on_chain", paymentId, signature });
      return "landed_failed";
    }
    if (lastFate === "dead" && deps.now().getTime() - sentMs >= X402_DOOR_DEAD_TRUSTED_AFTER_MS) {
      await deps.markSentFailed(paymentId, "never_landed");
      deps.log({ event: "never_landed", paymentId, signature });
      return "dead";
    }
    if (deps.now().getTime() + deps.pollIntervalMs > deadline) break;
    await deps.sleep(deps.pollIntervalMs);
  }
  deps.log({ event: "unconfirmed", paymentId, signature, lastFate });
  return "unconfirmed";
}

/**
 * Step 16: confirmed, and the answer is not released (the caller left, or
 * the sale could not be written): "submitted" -> "unserved". No sale, nobody
 * credited, never returned as credits.
 */
export async function markUnserved(paymentId: string, deps: X402DoorPaymentsDeps): Promise<boolean> {
  const changed = await deps.markUnserved(paymentId);
  deps.log({ event: "unserved", paymentId, changed });
  return changed;
}

// ============================================
// The door's rows in the settlement worker
// ============================================

/** A payment at a listing's door. Nothing else chooses the door's branches. */
export function isDoorRow(row: Pick<X402SettlementRow, "listingId">): boolean {
  // != on purpose: a row read without the column is a deployment's, as every
  // row was before the door.
  return row.listingId != null;
}

/**
 * One door payment, from its status, its age and the fate. Nothing here
 * sends, and nothing returns a payment as credits. The worker waits until
 * the row is X402_DOOR_FINISH_AFTER_MS old: by then its request has stopped
 * waiting (it sends within X402_SEND_BY_MS of arriving and waits at most
 * X402_DOOR_CONFIRM_MAX_MS more).
 */
async function settleDoorRow(row: X402SettlementRow, deps: X402SettlementDeps): Promise<X402SettleOutcome> {
  const now = deps.now();
  const old = now.getTime() - row.createdAt.getTime() >= X402_DOOR_FINISH_AFTER_MS;

  if (row.status === "held") {
    // Its request ended without signing: nothing was ever sent, so the chain
    // has nothing to say.
    if (!old) return "waiting";
    return (await deps.markHeldFailed(row.id, "never_sent")) ? "failed" : "skipped";
  }

  if (row.status === "submitted") {
    if (!row.txSignature) return "skipped";
    if (!old) return "waiting";
    if (!deps.submitTransactions) return "waiting";
    if (!(await deps.clusterOk())) return "waiting";
    const { fate } = await deps.readFate({ signature: row.txSignature, blockhash: row.recentBlockhash });
    if (fate === "landed_ok") {
      // Landed after its request stopped waiting: the answer was never
      // released. Kept for the operator, never returned as credits.
      if (!(await deps.markUnserved(row.id))) return "skipped";
      deps.logDoor({ event: "unserved", paymentId: row.id, signature: row.txSignature });
      return "unserved";
    }
    if (fate === "landed_failed") {
      return (await deps.markFailed(row.id, "failed_on_chain")) ? "failed" : "skipped";
    }
    // Five minutes after the send a blockhash's life has certainly passed.
    if (fate === "dead") {
      return (await deps.markFailed(row.id, "never_landed")) ? "failed" : "skipped";
    }
    return "waiting";
  }

  if (row.status === "verified") {
    if (row.refundedAt) return "skipped";
    if (!row.servedAt) {
      // The sale's one transaction sets verified and served together, so
      // this is not a state a door payment is left in. Left as it is.
      deps.logDoor({ event: "verified_not_served", paymentId: row.id });
      return "waiting";
    }
    // Served: settled once finalized, as a deployment's payment is.
    if (!deps.submitTransactions) {
      return (await deps.markSettled(row.id, now)) ? "settled" : "skipped";
    }
    if (!row.txSignature) return "skipped";
    if (!(await deps.clusterOk())) return "waiting";
    const reading = await deps.readFate({ signature: row.txSignature, blockhash: row.recentBlockhash });
    if (reading.fate === "landed_ok" && reading.confirmationStatus === "finalized") {
      return (await deps.markSettled(row.id, now)) ? "settled" : "skipped";
    }
    return "waiting";
  }

  return "skipped";
}

// ============================================
// The bound form a route holds
// ============================================

/** The four things a request does with x402, with the dependencies bound. */
export interface X402PaymentsApi {
  requirement(scope: X402RequestScope): Promise<PaymentRequirement>;
  take(input: X402TakeInput): Promise<X402TakeResult>;
  served(paymentId: string): Promise<boolean>;
  returned(paymentId: string): Promise<X402RefundResult>;
}

export function bindX402Payments(deps: X402PaymentsDeps): X402PaymentsApi {
  return {
    requirement: (scope) => x402Requirement(scope, deps),
    take: (input) => takeX402Payment(input, deps),
    served: (paymentId) => markX402Served(paymentId, deps),
    returned: (paymentId) => returnUnservedX402Payment(paymentId, deps),
  };
}
