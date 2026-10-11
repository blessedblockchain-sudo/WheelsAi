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
 */

import type { SignatureFate, SignatureConfirmationLevel } from "./signatureFate.js";
import type { PaymentHeader, PaymentRequirement, X402Network } from "./x402.js";
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

/** What a new payment's row holds. */
export interface X402NewPayment {
  orgId: string;
  deploymentId: string;
  requestId: string;
  network: string;
  asset: X402Asset;
  /** What the request required, in base units. */
  amountRaw: string;
  /** The same in dollars, to show. */
  amountUsd: number;
  payerAddress: string;
  payeeAddress: string;
  txSignature: string;
  status: "submitted" | "verified";
  signedTxB64: string;
  recentBlockhash: string;
  /** What the transfer actually carries, in base units. */
  amountReceivedRaw: string;
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
  /** Landed and failed, or can never land: -> "failed". */
  | "failed"
  /** Landed for a request that was never answered: returned as credits. */
  | "returned"
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
}

/**
 * One row, from the fate and nothing else. "unknown" and "in flight"
 * change nothing however often they are read.
 */
export async function settleX402Row(
  row: X402SettlementRow,
  deps: X402SettlementDeps,
): Promise<X402SettleOutcome> {
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
