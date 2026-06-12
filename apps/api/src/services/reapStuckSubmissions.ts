/**
 * Stuck-row AGE classifier for SUBMITTED ComputePayments (plan A3,
 * remediation D4).
 *
 * The confirmation poller (pollComputePaymentConfirmation) deliberately
 * never invents a transition from RPC silence — that's the right
 * discipline for a poller, but it leaves a SUBMITTED row whose tx never
 * landed (e.g. dropped by the cluster, RPC network drop) hanging
 * forever. The reaper closes that edge.
 *
 * IMPORTANT (D4): wall-clock age is only the TRIGGER for which rows to
 * examine — it is NOT sufficient evidence to fail a payment. The same
 * RPC outage that blinds the poller would otherwise trip this classifier
 * and record FAILED on payments that actually landed (SOL left, books
 * say it didn't). runReapStuckTick therefore gates every `changed: true`
 * result behind on-chain evidence before persisting:
 *   (a) current block height > the row's persisted lastValidBlockHeight
 *       (when present — claim-first rows always carry it), AND
 *   (b) a final getSignatureStatuses(searchTransactionHistory: true)
 *       returning null for the signature.
 * RPC unreachable → nothing is failed this tick.
 *
 * Pure function. The BullMQ worker that wraps it is a thin shell that
 * reads SUBMITTED rows, runs this, applies the chain-evidence gate, and
 * writes the surviving patches.
 *
 * Defensive choice: SUBMITTED rows with `submittedAt: null` are SKIPPED,
 * not reaped. That state is schema-inconsistent (shouldn't happen), and
 * force-FAILing on a hunch would be hostile. Surface via metrics instead.
 */

import {
  markFailed,
  type ComputePaymentState,
} from "./computePaymentLifecycle.js";

export interface ReaperPayment extends ComputePaymentState {
  submittedAt: Date | null;
  /** Expiry bound persisted by the claim-first protocol (D3). Null on
   * legacy pre-migration rows — those skip the height comparison but
   * STILL require the final signature-unseen check before failing. */
  lastValidBlockHeight: bigint | null;
}

export interface ReapInput {
  payments: ReaperPayment[];
  maxAgeSeconds: number;
  now: Date;
}

export interface ReapResult {
  payment: ReaperPayment;
  /** True = age-stale candidate with the proposed FAILED patch applied.
   * The tick persists it ONLY after the chain-evidence gate passes. */
  changed: boolean;
}

export function reapStuckSubmissions(input: ReapInput): ReapResult[] {
  if (input.maxAgeSeconds <= 0) {
    throw new Error(
      `reapStuckSubmissions: maxAgeSeconds must be positive, got ${input.maxAgeSeconds}`,
    );
  }

  const cutoffMs = input.now.getTime() - input.maxAgeSeconds * 1000;

  return input.payments.map((payment): ReapResult => {
    if (payment.status !== "SUBMITTED") return { payment, changed: false };
    if (!payment.submittedAt) return { payment, changed: false };

    // Inclusive cutoff: exactly at maxAge is NOT reaped (the next tick will).
    if (payment.submittedAt.getTime() >= cutoffMs) {
      return { payment, changed: false };
    }

    const transitioned = markFailed(payment, "blockhash_expired");
    return {
      payment: { ...transitioned, submittedAt: payment.submittedAt },
      changed: true,
    };
  });
}
