/**
 * Stuck-row reaper for SUBMITTED ComputePayments (plan A3).
 *
 * Closes the last edge case in the auto-pay loop. The confirmation poller
 * (pollComputePaymentConfirmation) deliberately never invents a transition
 * from RPC silence — that's the right discipline for a poller, but it
 * leaves a SUBMITTED row whose tx never landed (e.g. blockhash already
 * expired when we submitted, RPC network drop) hanging forever. This
 * reaper is the separate process that force-FAILs those rows after a
 * timeout so the settlement worker can re-issue.
 *
 * Pure function. The BullMQ worker that wraps it is a thin shell that
 * reads SUBMITTED rows, runs this, and writes the patches.
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
}

export interface ReapInput {
  payments: ReaperPayment[];
  maxAgeSeconds: number;
  now: Date;
}

export interface ReapResult {
  payment: ReaperPayment;
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
