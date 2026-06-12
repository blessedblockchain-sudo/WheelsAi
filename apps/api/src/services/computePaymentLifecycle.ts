/**
 * ComputePayment lifecycle (plan A3, claim-first protocol D3/D5).
 *
 * Pure transition functions over the ComputePaymentStatus enum. The Solana
 * submission worker (the side-effect layer) calls these to compute the
 * patch it writes to Postgres; this module never touches Prisma or RPC.
 *
 *   PENDING ──claim──> SUBMITTING ──broadcast──> SUBMITTED ──confirm──> CONFIRMED (terminal)
 *      │                   │                         └────fail────────> FAILED    (terminal)
 *      │                   └──safe-expiry recovery──> PENDING
 *      ├───────fail──────────────────────────────────> FAILED   (terminal)
 *      └───────park (resolution attempts exhausted)──> PARKED   (terminal until operator)
 *
 * The claim (PENDING → SUBMITTING) happens BEFORE any broadcast and stores
 * the signed tx bytes + signature + lastValidBlockHeight, so a crash or
 * replica overlap can only ever re-broadcast the SAME signature — never
 * re-sign. SUBMITTING → PENDING is legal only after the recovery scan has
 * proven the blockhash expired AND the signature never landed.
 *
 * Any illegal transition throws — the caller has a bug if it hits one.
 * markFailed is idempotent on FAILED so a retry loop can update the
 * error message without first checking status.
 */

export type ComputePaymentStatus =
  | "PENDING"
  | "SUBMITTING"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "PARKED";

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

/**
 * PENDING → SUBMITTING: the claim step. Records the signature of the
 * already-signed (but NOT yet broadcast) transaction. The DB writer
 * additionally persists the signed bytes + lastValidBlockHeight in the
 * same compare-and-set write.
 */
export function markClaimed<P extends ComputePaymentState>(
  payment: P,
  txSignature: string,
): P {
  if (payment.status !== "PENDING") {
    illegalTransition(payment.status, "SUBMITTING");
  }
  if (!txSignature || txSignature.length === 0) {
    throw new Error("markClaimed: signature is required");
  }
  return { ...payment, status: "SUBMITTING", txSignature };
}

/** SUBMITTING → SUBMITTED: the broadcast was accepted by the RPC. */
export function markSubmitted<P extends ComputePaymentState>(
  payment: P,
  txSignature: string,
): P {
  if (payment.status !== "SUBMITTING") {
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
  // CONFIRMED is terminal success. SUBMITTING rows must never be FAILED —
  // their signed bytes may already be on-chain; only the recovery scan can
  // settle them (→ SUBMITTED if landed, → PENDING if provably expired).
  // PARKED is terminal until an operator re-PENDINGs the row.
  if (
    payment.status === "CONFIRMED" ||
    payment.status === "SUBMITTING" ||
    payment.status === "PARKED"
  ) {
    illegalTransition(payment.status, "FAILED");
  }
  return { ...payment, status: "FAILED", errorMessage };
}

/**
 * PENDING → PARKED: recipient resolution failed too many times; pull the
 * row out of the submit queue so it can't block or churn forever.
 */
export function markParked<P extends ComputePaymentState>(
  payment: P,
  errorMessage: string,
): P {
  if (payment.status !== "PENDING") {
    illegalTransition(payment.status, "PARKED");
  }
  return { ...payment, status: "PARKED", errorMessage };
}

export function isTerminal(status: ComputePaymentStatus): boolean {
  return status === "CONFIRMED" || status === "FAILED" || status === "PARKED";
}

/**
 * Whether the settlement loop should attempt this payment again.
 * SUBMITTING rows are owned by the submit worker's recovery scan.
 * SUBMITTED rows are owned by the confirm-poller (don't double-submit).
 * CONFIRMED rows are terminal success; PARKED needs operator action.
 * PENDING and FAILED can retry up to maxRetries.
 */
export function shouldRetry(payment: ComputePaymentState, maxRetries: number): boolean {
  if (
    payment.status === "SUBMITTING" ||
    payment.status === "SUBMITTED" ||
    payment.status === "CONFIRMED" ||
    payment.status === "PARKED"
  ) {
    return false;
  }
  return payment.retryCount < maxRetries;
}
