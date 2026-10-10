/**
 * One run of the payout worker. Pure: everything it reads or writes is
 * passed in (services/buildPayoutExecutorTickDeps.ts binds it to Prisma,
 * the connection and the settings).
 *
 * A payout can no longer get stuck or be paid twice, and both follow from
 * two rules:
 *
 *   A NEW SIGNATURE IS MADE ONLY FROM `pending`. The claim is ONE
 *   compare-and-set that moves the payout pending -> processing and stores
 *   the signed transfer with it, BEFORE anything is broadcast. If it loses
 *   (the creator cancelled, another worker claimed) nothing is sent.
 *
 *   CHAIN EVIDENCE ENDS A SEND. Once a signature is stored, only what the
 *   chain says about that signature moves the payout: landed completes it;
 *   still able to land sends the SAME bytes again; failed on the chain or
 *   provably dead returns it to `pending` for a fresh attempt, or, at the
 *   last allowed attempt, fails it and gives the earnings back. A send that
 *   throws proves nothing and changes nothing.
 *
 * So `pending` is reached again only by proof that the old signature can
 * never pay, and a payout whose send was refused (an empty paying wallet is
 * enough) is never left `processing` for ever.
 *
 * Before anything is signed, a pending wallet payout must pass four checks.
 * One that does not pass leaves it `pending`, with a `waiting_reason` code,
 * so its creator can still cancel it and keep the earnings:
 *
 *   chain_unavailable     the node is not on the configured cluster, or a
 *                         read of the chain failed
 *   price_unavailable     SOL only: no live price to work the amount from
 *   daily_limit_reached   the platform's wallet payouts claimed since
 *                         midnight UTC, plus this one, would pass the limit
 *   wallet_low            the paying wallet does not cover it
 *
 * THE PAYING WALLET IS NOT SIGNED AGAINST TWICE. A read of the chain does
 * not yet show what a transfer that is still out will take. So a run looks
 * at the payouts being sent first, and what each one still out sends (and
 * what this run itself claims) is held back from the wallet's balance in
 * every later funds check. Without it a wallet that covers one payout would
 * be signed against for every payout waiting, and each of those transfers
 * would fail and use up one of its payout's attempts.
 *
 * A payout taken as credits needs no chain: claim pending -> processing,
 * then complete and grant in one transaction.
 *
 * Every change is a compare-and-set and a lost race is silent. One payout
 * that throws does not stop the others. Text from the chain, the node or
 * the database goes to the log and to `failure_reason` (operators), never
 * into a code a creator's sentence is chosen from.
 */

import {
  PAYOUT_FEE_LAMPORTS,
  isWalletPayoutMethod,
  readPayoutAddress,
  usdcBaseUnitsForCents,
  type FundsVerdict,
  type PayingWalletHeld,
  type PayoutQuote,
  type PayoutSettleResult,
  type SignedPayoutArtifact,
  type SolPayoutAmount,
  type WalletPayoutMethod,
} from "./payoutExecutor.js";
import type { SignatureFateAnswer, SignatureFateInput } from "./signatureFate.js";

/** Why a pending wallet payout has not been sent yet. */
export type PayoutWaitingReason =
  | "wallet_low"
  | "daily_limit_reached"
  | "price_unavailable"
  | "chain_unavailable";

/** Why a failed payout failed. */
export type PayoutFailureCode =
  | "could_not_send"
  | "invalid_address"
  | "missing_address"
  | "unsupported_method";

/**
 * A payout from before the signed bytes and their last valid block height
 * were stored has a signature and no height, so the chain cannot prove it
 * dead by height. It is given up only when its signature is still absent
 * this long after the worker first saw it.
 */
export const LEGACY_DEAD_AFTER_MS = 30 * 60 * 1000;

export interface ClaimablePayoutRow {
  id: string;
  publisherId: string;
  amountCents: bigint;
  payoutMethod: string; // 'credits' | 'crypto_sol' | 'crypto_usdc'
  payoutAddress: string | null;
  status: string; // 'pending' | 'processing'
  txSignature: string | null;
  signedTxB64: string | null;
  lastValidBlockHeight: bigint | null;
  claimedAt: Date | null;
  attemptCount: number;
  waitingReason: string | null;
  /** What the stored transfer sends, in base units. Null before a claim, and on older rows. */
  amountRaw?: string | null;
}

/** What the claim stores, in one compare-and-set, before anything is sent. */
export interface PayoutClaim extends SignedPayoutArtifact {
  /** What the signed transfer sends, in base units. */
  amountRaw: bigint;
  /** SOL only: the price the amount was worked out from. */
  quote: PayoutQuote | null;
  claimedAt: Date;
}

export type PayoutTickEvent =
  | { event: "waiting"; payoutId: string; reason: PayoutWaitingReason; detail: string }
  | { event: "claimed"; payoutId: string; signature: string; attempt: number }
  | { event: "send_error"; payoutId: string; signature: string; detail: string }
  | { event: "resend_error"; payoutId: string; signature: string; detail: string }
  | { event: "completed"; payoutId: string; signature: string | null }
  | { event: "returned_to_pending"; payoutId: string; signature: string | null; detail: string }
  | { event: "failed"; payoutId: string; code: PayoutFailureCode; detail: string }
  | { event: "fate_unknown"; payoutId: string; signature: string; detail: string }
  | { event: "row_error"; payoutId: string; detail: string };

export interface PayoutExecutorTickDeps {
  now: () => Date;
  /** PAYOUT_MAX_ATTEMPTS: how many transfers may be signed for one payout. */
  maxAttempts: number;
  /** PAYOUT_PLATFORM_MAX_PER_DAY_USD, in cents. */
  platformMaxPerDayCents: bigint;

  /** Open payouts, oldest first: those being sent, and those waiting to be. */
  loadClaimablePayouts: (args: { limit: number }) => Promise<ClaimablePayoutRow[]>;

  // ---- credits ----
  /** Compare-and-set pending -> processing. False: another run, or a cancel, won. */
  claimCredits: (row: ClaimablePayoutRow) => Promise<boolean>;
  /** processing -> completed and the grant, in one transaction. */
  settleCredits: (row: ClaimablePayoutRow) => Promise<PayoutSettleResult>;

  // ---- a wallet payout, before it is signed ----
  /** lib/solana.ts ensureSolanaCluster. Never throws. */
  checkCluster: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The lamports for an amount, from a live price. Never throws. */
  quoteSolAmount: (amountCents: bigint) => Promise<SolPayoutAmount>;
  /**
   * Cents of wallet payouts claimed at or after `since` that are being sent
   * or were sent.
   */
  walletCentsClaimedSince: (since: Date) => Promise<bigint>;
  /**
   * Whether the paying wallet covers the transfer, after what transfers
   * already signed and still able to land will take (`held`). Throws when
   * the chain cannot be read.
   */
  checkFunds: (args: {
    method: WalletPayoutMethod;
    recipient: string;
    amountRaw: bigint;
    held: PayingWalletHeld;
  }) => Promise<FundsVerdict>;
  /** A fresh blockhash, the transfer built and SIGNED. Sends nothing. Throws when it cannot. */
  prepare: (args: {
    method: WalletPayoutMethod;
    recipient: string;
    amountRaw: bigint;
  }) => Promise<SignedPayoutArtifact>;

  // ---- the claim and the send ----
  /**
   * ONE compare-and-set: pending -> processing with the signature, the
   * signed bytes, the last valid block height, the amount, the quote and
   * `claimed_at` stored, the attempt count raised by one and
   * `waiting_reason` cleared. False: the creator cancelled or another
   * worker claimed, and nothing may be sent.
   */
  claimWallet: (row: ClaimablePayoutRow, claim: PayoutClaim) => Promise<boolean>;
  /** Sends stored bytes as they are. A throw proves nothing either way. */
  broadcast: (signedTxB64: string) => Promise<void>;

  // ---- a wallet payout that has a signature ----
  /** services/buildSignatureFateDeps.ts readSignatureFate. Never throws. */
  readFate: (input: SignatureFateInput) => Promise<SignatureFateAnswer>;
  /** Compare-and-set processing -> completed, on that signature. */
  markCompleted: (row: ClaimablePayoutRow) => Promise<boolean>;
  /**
   * Compare-and-set processing -> pending on that signature: the claim is
   * cleared and the signature kept in `expired_signatures`.
   */
  returnToPending: (row: ClaimablePayoutRow) => Promise<boolean>;
  /** A payout first seen with a signature and no height: note when. */
  noteFirstSeen: (row: ClaimablePayoutRow, at: Date) => Promise<boolean>;

  // ---- any payout ----
  /**
   * Compare-and-set to `failed` from the status and signature the row was
   * read with, and the earnings put back through the earnings ledger, in
   * one transaction. False: the row had moved, and nothing was written.
   */
  failAndRestore: (
    row: ClaimablePayoutRow,
    failure: { code: PayoutFailureCode; reason: string },
  ) => Promise<boolean>;
  /** Compare-and-set the `waiting_reason` of a payout that is still pending. */
  setWaiting: (row: ClaimablePayoutRow, reason: PayoutWaitingReason) => Promise<boolean>;

  /** For the log. Carries the chain's own words; never shown to a creator. */
  log?: (event: PayoutTickEvent) => void;
}

/** Counts for the log line. */
export interface PayoutExecutorTickResult {
  /** Open payouts this run looked at. */
  claimable: number;
  /** Payouts that reached `completed` in this run. */
  completed: number;
  /** Wallet payouts claimed (signed and stored) in this run. */
  sent: number;
  /** Stored transfers that were broadcast again, unchanged. */
  resent: number;
  /** Pending wallet payouts left waiting, with a reason. */
  waiting: number;
  /** Payouts returned to `pending` after their transfer failed or died. */
  returned: number;
  /** Payouts failed, with the earnings given back. */
  failed: number;
  /** Payouts being sent that this run left as they are. */
  left: number;
  /** Lost races: another run or a cancel moved the payout first. */
  skipped: number;
  /** Payouts whose pass threw. They are looked at again next run. */
  errors: number;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** Midnight UTC at the start of the day `at` is in. */
export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export async function runPayoutExecutorTick(
  input: { limit: number },
  deps: PayoutExecutorTickDeps,
): Promise<PayoutExecutorTickResult> {
  const rows = await deps.loadClaimablePayouts({ limit: input.limit });

  const result: PayoutExecutorTickResult = {
    claimable: rows.length,
    completed: 0,
    sent: 0,
    resent: 0,
    waiting: 0,
    returned: 0,
    failed: 0,
    left: 0,
    skipped: 0,
    errors: 0,
  };
  const log = (event: PayoutTickEvent) => {
    try {
      deps.log?.(event);
    } catch {
      // A log line that cannot be written never changes what a payout does.
    }
  };

  /** What transfers that are signed and may still land will take from the paying wallet. */
  const held: PayingWalletHeld = { usdcBaseUnits: 0n, lamports: 0n };
  function hold(method: string, amountRaw: bigint | null): void {
    // The fee is taken whether the transfer moves anything or not.
    held.lamports += PAYOUT_FEE_LAMPORTS;
    if (amountRaw === null) return;
    if (method === "crypto_usdc") held.usdcBaseUnits += amountRaw;
    else if (method === "crypto_sol") held.lamports += amountRaw;
  }
  /** A payout this run left being sent: its transfer may still land. */
  function holdStored(row: ClaimablePayoutRow): void {
    let amountRaw: bigint | null = null;
    try {
      if (row.amountRaw) amountRaw = BigInt(row.amountRaw);
      // An older row stored no amount. USDC is exact, so it is known all
      // the same; a SOL amount is not, and only its fee is held.
      else if (row.payoutMethod === "crypto_usdc") amountRaw = usdcBaseUnitsForCents(row.amountCents);
    } catch {
      amountRaw = null;
    }
    hold(row.payoutMethod, amountRaw);
  }

  /** Fail the payout and give the earnings back; count it, or the lost race. */
  async function fail(row: ClaimablePayoutRow, code: PayoutFailureCode, reason: string): Promise<void> {
    const won = await deps.failAndRestore(row, { code, reason });
    if (won) {
      result.failed += 1;
      log({ event: "failed", payoutId: row.id, code, detail: reason });
    } else {
      result.skipped += 1;
    }
  }

  /** Leave a pending payout pending, with the reason it is waiting. */
  async function wait(row: ClaimablePayoutRow, reason: PayoutWaitingReason, detail: string): Promise<void> {
    log({ event: "waiting", payoutId: row.id, reason, detail });
    if (row.waitingReason !== reason) {
      const marked = await deps.setWaiting(row, reason);
      if (!marked) {
        // No longer pending: cancelled, or claimed by another worker.
        result.skipped += 1;
        return;
      }
    }
    result.waiting += 1;
  }

  async function credits(row: ClaimablePayoutRow): Promise<void> {
    if (row.status === "pending") {
      const claimed = await deps.claimCredits(row);
      if (!claimed) {
        result.skipped += 1;
        return;
      }
    }
    const settled = await deps.settleCredits(row);
    if (settled.outcome === "completed") {
      result.completed += 1;
      log({ event: "completed", payoutId: row.id, signature: null });
    } else {
      result.skipped += 1;
    }
  }

  /** A pending wallet payout: the checks, then the claim, then the send. */
  async function send(row: ClaimablePayoutRow, method: WalletPayoutMethod): Promise<void> {
    const address = readPayoutAddress(row.payoutAddress);
    if (!address.ok) {
      await fail(
        row,
        address.code,
        address.code === "missing_address" ? "missing payout address" : "invalid payout address",
      );
      return;
    }
    const recipient = address.recipient.toBase58();

    const cluster = await deps.checkCluster();
    if (!cluster.ok) {
      await wait(row, "chain_unavailable", `cluster check: ${cluster.reason}`);
      return;
    }

    let amountRaw: bigint;
    let quote: PayoutQuote | null = null;
    if (method === "crypto_sol") {
      const priced = await deps.quoteSolAmount(row.amountCents);
      if (!priced.ok) {
        await wait(row, "price_unavailable", priced.detail);
        return;
      }
      amountRaw = priced.lamports;
      quote = priced.quote;
    } else {
      amountRaw = usdcBaseUnitsForCents(row.amountCents);
    }

    const now = deps.now();
    const claimedToday = await deps.walletCentsClaimedSince(utcDayStart(now));
    if (claimedToday + row.amountCents > deps.platformMaxPerDayCents) {
      await wait(
        row,
        "daily_limit_reached",
        `${claimedToday} cents claimed today, ${row.amountCents} more would pass ${deps.platformMaxPerDayCents}`,
      );
      return;
    }

    let funds: FundsVerdict;
    try {
      funds = await deps.checkFunds({ method, recipient, amountRaw, held: { ...held } });
    } catch (err) {
      await wait(row, "chain_unavailable", `funds read: ${errorText(err)}`);
      return;
    }
    if (!funds.covered) {
      await wait(row, "wallet_low", funds.detail);
      return;
    }

    let artifact: SignedPayoutArtifact;
    try {
      artifact = await deps.prepare({ method, recipient, amountRaw });
    } catch (err) {
      // Nothing was stored and nothing was sent: the payout is still
      // pending and can be cancelled.
      await wait(row, "chain_unavailable", `prepare: ${errorText(err)}`);
      return;
    }

    const claimed = await deps.claimWallet(row, { ...artifact, amountRaw, quote, claimedAt: now });
    if (!claimed) {
      // Cancelled, or claimed by another worker. The transfer just signed
      // is dropped unsent: it is stored nowhere and can never be broadcast.
      result.skipped += 1;
      return;
    }
    result.sent += 1;
    // Sent or not, the stored transfer may land: later payouts in this run
    // must not count on what it takes.
    hold(method, amountRaw);
    log({ event: "claimed", payoutId: row.id, signature: artifact.txSignature, attempt: row.attemptCount + 1 });

    try {
      await deps.broadcast(artifact.signedTxB64);
    } catch (err) {
      // The send may have reached the chain all the same, so nothing is
      // inferred from the error. The bytes are on the row; the next run
      // asks the chain what became of the signature.
      log({ event: "send_error", payoutId: row.id, signature: artifact.txSignature, detail: errorText(err) });
    }
  }

  /** The transfer failed on the chain or can never land: try again, or give up. */
  async function retryOrGiveUp(row: ClaimablePayoutRow, detail: string): Promise<void> {
    if (row.attemptCount >= deps.maxAttempts) {
      await fail(row, "could_not_send", detail);
      return;
    }
    const returned = await deps.returnToPending(row);
    if (returned) {
      result.returned += 1;
      log({ event: "returned_to_pending", payoutId: row.id, signature: row.txSignature, detail });
    } else {
      result.skipped += 1;
    }
  }

  /**
   * A wallet payout that is being sent: the chain decides. Whatever this
   * leaves being sent is held back from the paying wallet's balance.
   */
  async function follow(row: ClaimablePayoutRow): Promise<void> {
    const before = result.left + result.resent;
    await decide(row);
    if (result.left + result.resent > before) holdStored(row);
  }

  async function decide(row: ClaimablePayoutRow): Promise<void> {
    const signature = row.txSignature;
    if (!signature) {
      // Claimed without a signature: nothing was ever signed for it, so
      // nothing can be in flight. (The claim stores both together; only a
      // row from before that could look like this.)
      const returned = await deps.returnToPending(row);
      if (returned) {
        result.returned += 1;
        log({ event: "returned_to_pending", payoutId: row.id, signature: null, detail: "claimed with no signature" });
      } else {
        result.skipped += 1;
      }
      return;
    }

    const fate = await deps.readFate({ signature, lastValidBlockHeight: row.lastValidBlockHeight });

    switch (fate.fate) {
      case "landed_ok": {
        const completed = await deps.markCompleted(row);
        if (completed) {
          result.completed += 1;
          log({ event: "completed", payoutId: row.id, signature });
        } else {
          result.skipped += 1;
        }
        return;
      }
      case "landed_failed":
        await retryOrGiveUp(row, `transfer ${signature} failed on the chain: ${fate.error ?? fate.reason}`);
        return;
      case "dead":
        await retryOrGiveUp(row, `transfer ${signature} can no longer land (${fate.reason})`);
        return;
      case "in_flight": {
        if (row.lastValidBlockHeight === null) {
          // From before the height was stored: there are no bytes to send
          // again and no height to prove death by. Only a signature that
          // the chain has no record of, read by a node that is not behind,
          // counts toward giving it up, and only after the wait.
          if (fate.reason !== "absent_no_expiry_proof") {
            result.left += 1;
            return;
          }
          if (row.claimedAt === null) {
            await deps.noteFirstSeen(row, deps.now());
            result.left += 1;
            return;
          }
          if (deps.now().getTime() - row.claimedAt.getTime() >= LEGACY_DEAD_AFTER_MS) {
            await retryOrGiveUp(
              row,
              `transfer ${signature} is still absent from the chain ${LEGACY_DEAD_AFTER_MS / 60_000} minutes after it was first looked for`,
            );
            return;
          }
          result.left += 1;
          return;
        }
        if (!row.signedTxB64) {
          result.left += 1;
          return;
        }
        try {
          // The same bytes, so the same signature: the chain takes it once
          // however often it is sent.
          await deps.broadcast(row.signedTxB64);
          result.resent += 1;
        } catch (err) {
          result.left += 1;
          log({ event: "resend_error", payoutId: row.id, signature, detail: errorText(err) });
        }
        return;
      }
      case "unknown":
      default:
        result.left += 1;
        log({ event: "fate_unknown", payoutId: row.id, signature, detail: fate.error ?? fate.reason });
        return;
    }
  }

  // Payouts being sent first, whatever order they were loaded in: what is
  // still out must be known before a waiting payout is checked for funds.
  const ordered = [
    ...rows.filter((row) => row.status !== "pending"),
    ...rows.filter((row) => row.status === "pending"),
  ];

  for (const row of ordered) {
    try {
      if (row.status !== "pending" && row.status !== "processing") {
        result.skipped += 1;
        continue;
      }
      if (row.payoutMethod === "credits") {
        await credits(row);
      } else if (isWalletPayoutMethod(row.payoutMethod)) {
        if (row.status === "pending") await send(row, row.payoutMethod);
        else await follow(row);
      } else if (row.txSignature) {
        // A signature on a method this worker does not know: the chain
        // still decides what became of it.
        await follow(row);
      } else {
        await fail(row, "unsupported_method", `unsupported payout method: ${row.payoutMethod}`);
      }
    } catch (err) {
      // This payout's pass threw (a database write, most likely). Whatever
      // state it is in is one a later run recovers from: pending, or
      // processing with its signature and bytes stored.
      result.errors += 1;
      log({ event: "row_error", payoutId: row.id, detail: errorText(err) });
    }
  }

  return result;
}
