/**
 * ComputePayment lifecycle (plan A3).
 *
 * Pure transition functions over the ComputePaymentStatus enum. The Solana
 * submission worker (the side-effect layer) calls these to compute the
 * patch it writes to Postgres; this module never touches Prisma or RPC.
 *
 *   PENDING ──submit──> SUBMITTED ──confirm──> CONFIRMED  (terminal)
 *      └───────────────────fail─────────────> FAILED      (terminal)
 *                          └────fail────────> FAILED      (terminal)
 *
 * Any illegal transition throws — the caller has a bug if it hits one.
 * markFailed is idempotent on FAILED so a retry loop can update the
 * error message without first checking status.
 */

export type ComputePaymentStatus = "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface ComputePaymentState {
  id: string;
  status: ComputePaymentStatus;
  txSignature: string | null;
  errorMessage: string | null;
  paidAt: Date | null;
  retryCount: number;
}

function illegalTransition(from: ComputePaymentStatus, to: ComputePaymentStatus): never {
  throw new Error(`illegal transition: ${from} → ${to}`);
}

export function markSubmitted<P extends ComputePaymentState>(
  payment: P,
  txSignature: string,
): P {
  if (payment.status !== "PENDING") {
    illegalTransition(payment.status, "SUBMITTED");
  }
  if (!txSignature || txSignature.length === 0) {
    throw new Error("markSubmitted: signature is required");
  }
  return { ...payment, status: "SUBMITTED", txSignature };
}

export function markConfirmed<P extends ComputePaymentState>(
  payment: P,
  paidAt: Date,
): P {
  if (payment.status !== "SUBMITTED") {
    illegalTransition(payment.status, "CONFIRMED");
  }
  return { ...payment, status: "CONFIRMED", paidAt };
}

export function markFailed<P extends ComputePaymentState>(
  payment: P,
  errorMessage: string,
): P {
  if (payment.status === "CONFIRMED") {
    illegalTransition(payment.status, "FAILED");
  }
  return { ...payment, status: "FAILED", errorMessage };
}

export function isTerminal(status: ComputePaymentStatus): boolean {
  return status === "CONFIRMED" || status === "FAILED";
}

/**
 * Whether the settlement loop should attempt this payment again.
 * SUBMITTED rows are owned by the confirm-poller (don't double-submit).
 * CONFIRMED rows are terminal success.
 * PENDING and FAILED can retry up to maxRetries.
 */
export function shouldRetry(payment: ComputePaymentState, maxRetries: number): boolean {
  if (payment.status === "SUBMITTED" || payment.status === "CONFIRMED") return false;
  return payment.retryCount < maxRetries;
}
