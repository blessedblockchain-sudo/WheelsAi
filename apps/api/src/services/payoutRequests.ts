/**
 * A creator's side of a payout request: whether payouts are running, taking
 * a request back, and what a creator is told about one that did not go
 * through.
 *
 * Requesting a payout RESERVES the creator's earnings into the payout row
 * (services/marketplace.ts requestPayout). Only the payout worker ever
 * moves that row on, so a request made while the worker is off would hold
 * the earnings for ever. Two things stop that:
 *
 *   - payoutAvailability: the one rule for "payouts are running now". GET
 *     /api/capabilities answers `payouts.available` with it and POST
 *     /api/marketplace/payouts refuses on it BEFORE anything is reserved.
 *   - cancelPayout: a payout that is still pending becomes cancelled and
 *     its amount goes back to the earnings it was taken from, in ONE
 *     transaction, by compare-and-set on the status. It is the mirror of
 *     the executor's failAndRestore (buildPayoutExecutorTickDeps.ts): the
 *     same two rows, the same guard. The executor claims by pending →
 *     processing and this cancels by pending → cancelled, so exactly one of
 *     "cancelled and restored" or "claimed and sent" happens; the loser
 *     writes nothing.
 *
 * Pure core: everything it reads or writes is passed in.
 * buildCancelPayoutDeps binds it to a Prisma client handed to it, and puts
 * the amount back through the earnings ledger (services/earningsLedger.ts).
 */

import { moveEarnings, type EarningsLedgerTx } from "./earningsLedger.js";

// ============================================
// Availability
// ============================================

/** The two settings that decide whether the payout worker runs. */
export interface PayoutSettings {
  PAYOUTS_ENABLED: boolean;
  PAYOUT_EXECUTOR_INTERVAL_MS: number;
}

/**
 * Payouts are running: the payout switch is on AND the worker that settles
 * payouts is scheduled (the condition queues/payout-executor.queue.ts
 * starts on). Anything else, a missing or unreadable setting included, is
 * not running.
 */
export function payoutsRunning(settings: PayoutSettings): boolean {
  return (
    settings?.PAYOUTS_ENABLED === true &&
    typeof settings.PAYOUT_EXECUTOR_INTERVAL_MS === "number" &&
    settings.PAYOUT_EXECUTOR_INTERVAL_MS > 0
  );
}

/**
 * Whether payouts are running now, read per call. Fails closed: settings
 * that cannot be read answer not available.
 */
export function payoutAvailability(readSettings: () => PayoutSettings): { available: boolean } {
  try {
    return { available: payoutsRunning(readSettings()) };
  } catch {
    return { available: false };
  }
}

export const PAYOUTS_UNAVAILABLE_CODE = "payouts_unavailable";
export const PAYOUTS_UNAVAILABLE_MESSAGE =
  "Payouts are temporarily unavailable. Nothing was reserved and your earnings are unchanged. Try again later.";

// ============================================
// What a creator sees of a payout
// ============================================

/** A creator_payouts row, as the database holds it. */
export interface PayoutRow {
  id: string;
  publisherId: string;
  amountCents: bigint;
  payoutMethod: string;
  payoutAddress: string | null;
  status: string;
  txSignature: string | null;
  grossRevenueCents: bigint;
  platformFeeCents: bigint;
  periodStart: Date;
  periodEnd: Date;
  requestedAt: Date;
  processedAt: Date | null;
  failureReason: string | null;
}

/** A payout can be taken back only until the worker has claimed it. */
export function isPayoutCancellable(status: string): boolean {
  return status === "pending";
}

const BACK_IN_EARNINGS = "The amount is back in your earnings.";

const GENERAL_FAILURE = `This payout could not be sent. ${BACK_IN_EARNINGS} You can request it again.`;
const TRANSFER_FAILURE = `The transfer did not go through. ${BACK_IN_EARNINGS} You can request it again.`;

/**
 * The reasons the executor records (payoutExecutor.ts,
 * runPayoutExecutorTick.ts, buildPayoutExecutorTickDeps.ts), each with the
 * sentence a creator reads. A failed payout always had its amount restored
 * in the transaction that failed it, so every sentence can say so.
 */
const FAILURE_SENTENCES: ReadonlyArray<{ matches: (reason: string) => boolean; sentence: string }> = [
  {
    matches: (r) => r === "missing payout address",
    sentence: `This payout had no wallet address. ${BACK_IN_EARNINGS} Request it again with a wallet address.`,
  },
  {
    matches: (r) => r === "invalid payout address",
    sentence: `The wallet address on this payout is not valid. ${BACK_IN_EARNINGS} Check the address and request it again.`,
  },
  {
    matches: (r) => r.startsWith("crypto payouts not configured"),
    sentence: `Payouts to a wallet are not available right now. ${BACK_IN_EARNINGS} You can request it as platform credits, or try again later.`,
  },
  {
    matches: (r) => r.startsWith("unsupported payout method"),
    sentence: `This payout method is not supported. ${BACK_IN_EARNINGS} Request it again with another method.`,
  },
  {
    matches: (r) =>
      r.startsWith("payout tx failed on-chain") ||
      r.startsWith("prior payout tx failed on-chain") ||
      r === "payout tx did not sign",
    sentence: TRANSFER_FAILURE,
  },
];

/**
 * Why a payout did not go through, as a plain sentence for the creator.
 * Never the processor's or the database's own words: the recorded reason
 * only picks the sentence, and one that is not recognised (or is missing)
 * gets the general sentence.
 */
export function payoutFailureMessage(reason: string | null | undefined): string {
  if (typeof reason !== "string") return GENERAL_FAILURE;
  const recorded = reason.trim();
  for (const known of FAILURE_SENTENCES) {
    if (known.matches(recorded)) return known.sentence;
  }
  return GENERAL_FAILURE;
}

/** A payout as GET /api/marketplace/payouts lists it. */
export interface PayoutView {
  id: string;
  amountCents: number;
  payoutMethod: string;
  payoutAddress: string | null;
  status: string;
  txSignature: string | null;
  grossRevenueCents: number;
  platformFeeCents: number;
  periodStart: Date;
  periodEnd: Date;
  requestedAt: Date;
  processedAt: Date | null;
  /** A plain sentence when the payout failed; null when it did not. */
  failureReason: string | null;
  /** True only while the payout can still be cancelled. */
  cancellable: boolean;
}

export function payoutView(row: PayoutRow): PayoutView {
  return {
    id: row.id,
    amountCents: Number(row.amountCents),
    payoutMethod: row.payoutMethod,
    payoutAddress: row.payoutAddress,
    status: row.status,
    txSignature: row.txSignature,
    grossRevenueCents: Number(row.grossRevenueCents),
    platformFeeCents: Number(row.platformFeeCents),
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    requestedAt: row.requestedAt,
    processedAt: row.processedAt,
    failureReason: row.status === "failed" ? payoutFailureMessage(row.failureReason) : null,
    cancellable: isPayoutCancellable(row.status),
  };
}

// ============================================
// Cancel
// ============================================

export const PAYOUT_NOT_CANCELLABLE_CODE = "payout_not_cancellable";

/** What a creator is told when a payout can no longer be cancelled. */
export function payoutNotCancellableMessage(status: string): string {
  switch (status) {
    case "processing":
      return "This payout is already being sent and can no longer be cancelled.";
    case "completed":
      return "This payout was already sent and can no longer be cancelled.";
    case "cancelled":
      return "This payout was already cancelled. Its amount is back in your earnings.";
    case "failed":
      return "This payout did not go through and its amount is already back in your earnings. There is nothing to cancel.";
    default:
      return "This payout can no longer be cancelled.";
  }
}

/** The two writes of a cancel, inside one transaction. */
export interface CancelPayoutTx {
  /**
   * Compare-and-set pending → cancelled for this organization's payout.
   * True only when THIS call changed the row.
   */
  cancelIfPending(payoutId: string, orgId: string): Promise<boolean>;
  /**
   * Put the payout's amount back on the earnings it was reserved from, with
   * a ledger row that names the payout. Throws when there is no such balance.
   */
  restoreEarnings(orgId: string, amountCents: bigint, payoutId: string): Promise<void>;
}

export interface CancelPayoutDeps {
  /** The organization's own payout, or null (unknown, or another organization's). */
  findPayout(payoutId: string, orgId: string): Promise<PayoutRow | null>;
  /** Runs `fn` in ONE database transaction: both writes commit or neither. */
  transaction<T>(fn: (tx: CancelPayoutTx) => Promise<T>): Promise<T>;
}

export type CancelPayoutResult =
  | { outcome: "cancelled"; payout: PayoutRow }
  | { outcome: "not_found" }
  | { outcome: "not_cancellable"; status: string };

export async function cancelPayout(
  deps: CancelPayoutDeps,
  input: { payoutId: string; orgId: string },
): Promise<CancelPayoutResult> {
  const { payoutId, orgId } = input;

  const row = await deps.findPayout(payoutId, orgId);
  // Another organization's payout is not found, the same as one that does
  // not exist. Checked again here so a lookup that forgot to scope by
  // organization still cannot hand a payout across.
  if (!row || row.publisherId !== orgId) return { outcome: "not_found" };
  if (!isPayoutCancellable(row.status)) return { outcome: "not_cancellable", status: row.status };

  // Fail closed: an amount that is not a whole positive number of cents is
  // never put on a balance.
  if (typeof row.amountCents !== "bigint" || row.amountCents <= 0n) {
    throw new Error("payout amount is not readable; nothing was changed");
  }

  const cancelled = await deps.transaction(async (tx) => {
    const won = await tx.cancelIfPending(payoutId, orgId);
    // Only restore the reservation if THIS call is the one that cancelled
    // the row: never credit the balance twice, and never credit it for a
    // payout the executor has claimed and is sending.
    if (won) await tx.restoreEarnings(orgId, row.amountCents, payoutId);
    return won;
  });

  if (cancelled) return { outcome: "cancelled", payout: { ...row, status: "cancelled" } };

  // Lost the race (the executor claimed it, or another cancel got there
  // first). Nothing was written; say what the payout is now.
  const now = await deps.findPayout(payoutId, orgId);
  if (!now || now.publisherId !== orgId) return { outcome: "not_found" };
  return { outcome: "not_cancellable", status: now.status };
}

// ============================================
// Prisma binding
// ============================================

/**
 * The part of a Prisma client (or transaction client) a cancel touches: the
 * payout row, and what the earnings ledger needs to put the amount back.
 */
export interface CancelPayoutDbClient extends EarningsLedgerTx {
  creatorPayout: {
    findFirst(args: { where: { id: string; publisherId: string } }): Promise<PayoutRow | null>;
    updateMany(args: {
      where: { id: string; publisherId: string; status: "pending" };
      data: { status: "cancelled" };
    }): Promise<{ count: number }>;
  };
}

export interface CancelPayoutDb extends CancelPayoutDbClient {
  $transaction<T>(fn: (tx: CancelPayoutDbClient) => Promise<T>): Promise<T>;
}

export function buildCancelPayoutDeps(db: CancelPayoutDb): CancelPayoutDeps {
  return {
    findPayout: (payoutId, orgId) =>
      db.creatorPayout.findFirst({ where: { id: payoutId, publisherId: orgId } }),

    transaction: (fn) =>
      db.$transaction((tx) =>
        fn({
          cancelIfPending: async (payoutId, orgId) => {
            const res = await tx.creatorPayout.updateMany({
              where: { id: payoutId, publisherId: orgId, status: "pending" },
              data: { status: "cancelled" },
            });
            return res.count === 1;
          },
          // The balance requestPayout reserved from and failAndRestore
          // gives back to, changed through the earnings ledger. A profile
          // that is gone throws, which rolls the cancel back: the payout
          // stays pending rather than losing its amount.
          restoreEarnings: async (orgId, amountCents, payoutId) => {
            const restored = await moveEarnings(tx, {
              orgId,
              amountCents,
              type: "payout_restored",
              referenceId: payoutId,
              description: "Payout cancelled, amount returned",
            });
            if (!restored.moved) {
              throw new Error(`payout ${payoutId}: earnings could not be restored (${restored.reason})`);
            }
          },
        }),
      ),
  };
}
