/**
 * SUBMITTED → CONFIRMED|FAILED orchestrator (plan A3).
 *
 * Composes the existing markConfirmed / markFailed pure transitions on top
 * of an injected RPC getSignatureStatus call. Returns:
 *
 *   { changed: true, payment }   — caller writes the patch via prisma.update
 *   { changed: false, payment }  — caller leaves the row as SUBMITTED and
 *                                  re-polls on the next tick
 *
 * Confirmation policy:
 *   - 'confirmed' or 'finalized' with err=null   → CONFIRMED
 *   - any confirmationStatus with err present     → FAILED (preserved error)
 *   - null result OR 'processed' OR null status   → no transition
 *
 * The stuck-row reaper (force-FAIL after N minutes of silence) is a
 * separate slice; this orchestrator never invents a transition from RPC
 * silence — that's the right discipline for a confirmation poller.
 */

import {
  markConfirmed,
  markFailed,
  type ComputePaymentState,
} from "./computePaymentLifecycle.js";

export type ConfirmationStatus =
  | "processed"
  | "confirmed"
  | "finalized"
  | null;

export interface SignatureStatusResult {
  confirmationStatus: ConfirmationStatus;
  err: unknown | null;
}

export interface PollInput {
  payment: ComputePaymentState;
}

export interface PollDeps {
  getSignatureStatus: (
    sig: string,
  ) => Promise<SignatureStatusResult | null>;
  /** Defaults to wall clock — overridable for deterministic tests. */
  now?: () => Date;
}

export interface PollResult {
  payment: ComputePaymentState;
  changed: boolean;
}

function formatErr(err: unknown): string {
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function pollComputePaymentConfirmation(
  input: PollInput,
  deps: PollDeps,
): Promise<PollResult> {
  if (input.payment.status !== "SUBMITTED") {
    throw new Error(
      `pollComputePaymentConfirmation: payment status is ${input.payment.status}, not SUBMITTED`,
    );
  }
  if (!input.payment.txSignature) {
    throw new Error(
      "pollComputePaymentConfirmation: payment has no txSignature to poll",
    );
  }

  const now = deps.now ?? (() => new Date());

  let status: SignatureStatusResult | null;
  try {
    status = await deps.getSignatureStatus(input.payment.txSignature);
  } catch (err) {
    throw new Error(
      `rpc_status_unavailable: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  if (!status) {
    // RPC has not seen the sig yet — keep polling.
    return { payment: input.payment, changed: false };
  }

  if (status.err !== null && status.err !== undefined) {
    return {
      payment: markFailed(input.payment, formatErr(status.err)),
      changed: true,
    };
  }

  if (
    status.confirmationStatus === "confirmed" ||
    status.confirmationStatus === "finalized"
  ) {
    return {
      payment: markConfirmed(input.payment, now()),
      changed: true,
    };
  }

  // 'processed', null, or any other indeterminate state — wait for the
  // next tick rather than guess.
  return { payment: input.payment, changed: false };
}
