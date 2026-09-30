/**
 * Payout executor tick (W2 money keystone) — one call = one pass of the
 * BullMQ payout worker. Pure orchestration; every IO surface is DI'd.
 *
 * Per claimable payout:
 *   1. If `pending`, claim it (CAS pending → processing). A lost claim
 *      means another replica owns it — skip. Claiming BEFORE settlement
 *      means a crash loses no money: the row is recoverable in
 *      `processing`.
 *   2. Settle by method:
 *        credits → grant + complete in one tx (exactly-once)
 *        crypto  → send/confirm/complete, recovery-safe (exactly-once)
 *      Already-`processing` rows (recovered from a crash) skip the claim
 *      and go straight to settle, which re-confirms rather than re-sends.
 *   3. On `failed`, release the reservation: mark the row failed AND
 *      restore the amount to the publisher's pendingPayoutCents in one
 *      transaction, so the creator can request again.
 *
 * Per-payout isolation: one row throwing fails THAT row's pass; the rest
 * still process.
 */

import type { PayoutSettleResult } from "./payoutExecutor.js";

export interface ClaimablePayoutRow {
  id: string;
  publisherId: string;
  amountCents: bigint;
  payoutMethod: string; // 'credits' | 'crypto_sol' | 'crypto_usdc'
  payoutAddress: string | null;
  txSignature: string | null;
  status: string; // 'pending' | 'processing'
}

export interface PayoutExecutorTickDeps {
  loadClaimablePayouts: (args: { limit: number }) => Promise<ClaimablePayoutRow[]>;
  /** CAS pending → processing; false = another replica won the claim. */
  claim: (payoutId: string) => Promise<boolean>;
  settleCredits: (row: ClaimablePayoutRow) => Promise<PayoutSettleResult>;
  settleCrypto: (row: ClaimablePayoutRow) => Promise<PayoutSettleResult>;
  /** Mark failed AND restore pendingPayoutCents in one transaction. */
  failAndRestore: (row: ClaimablePayoutRow, reason: string) => Promise<void>;
}

export interface PayoutExecutorTickResult {
  claimable: number;
  completed: number;
  pending: number;
  failed: number;
  skipped: number;
}

const CRYPTO_METHODS = new Set(["crypto_sol", "crypto_usdc"]);

export async function runPayoutExecutorTick(
  input: { limit: number },
  deps: PayoutExecutorTickDeps,
): Promise<PayoutExecutorTickResult> {
  const rows = await deps.loadClaimablePayouts({ limit: input.limit });

  const result: PayoutExecutorTickResult = {
    claimable: rows.length,
    completed: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of rows) {
    // Claim pending rows; already-processing rows are recoveries — proceed
    // straight to settlement (which re-confirms, never re-sends).
    if (row.status === "pending") {
      let claimed: boolean;
      try {
        claimed = await deps.claim(row.id);
      } catch {
        result.failed += 1;
        continue;
      }
      if (!claimed) {
        result.skipped += 1;
        continue;
      }
    }

    let settlement: PayoutSettleResult;
    try {
      if (row.payoutMethod === "credits") {
        settlement = await deps.settleCredits(row);
      } else if (CRYPTO_METHODS.has(row.payoutMethod)) {
        settlement = await deps.settleCrypto(row);
      } else {
        settlement = {
          outcome: "failed",
          reason: `unsupported payout method: ${row.payoutMethod}`,
        };
      }
    } catch {
      // An unexpected throw during settlement leaves the row in
      // `processing`; a later tick retries. Count it, don't restore
      // (a crypto send may have landed).
      result.pending += 1;
      continue;
    }

    switch (settlement.outcome) {
      case "completed":
        result.completed += 1;
        break;
      case "already_settled":
        result.skipped += 1;
        break;
      case "pending_confirmation":
        result.pending += 1;
        break;
      case "failed":
        try {
          await deps.failAndRestore(row, settlement.reason);
        } catch {
          // Row stays `processing`; a later tick retries. Better than
          // leaving it falsely completed.
        }
        result.failed += 1;
        break;
    }
  }

  return result;
}
