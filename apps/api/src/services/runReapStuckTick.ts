/**
 * Scan-and-dispatch driver for the stuck-submission reaper BullMQ
 * worker (remediation D4: final chain check before failing).
 *
 * Each tick:
 *   1. loadStuckCandidates(now)        → SUBMITTED rows past the age cutoff
 *   2. reapStuckSubmissions(...)       (pure; AGE TRIGGER only)
 *   3. for each age-stale result, gate on on-chain evidence:
 *        - row.lastValidBlockHeight != null (claim-first rows):
 *            · getCurrentBlockHeight() ≤ lastValidBlockHeight → the tx can
 *              still land — NOT reaped, regardless of wall-clock age.
 *            · height > lastValidBlockHeight → proceed to the final check.
 *        - row.lastValidBlockHeight == null (legacy, pre-migration):
 *            · no height bound to compare — proceed straight to the final
 *              check (age remains the only trigger, as before D3).
 *        - FINAL CHECK (both shapes): hasSignatureLanded(sig) with
 *          searchTransactionHistory — landed → NOT reaped (the poller will
 *          confirm it); provably unseen → persistTransition FAILED.
 *   4. counts {reaped, scanned} returned
 *
 * RPC discipline (mirrors the poller, runPollPaymentsTick): silence never
 * invents a transition.
 *   - getCurrentBlockHeight throws → the ENTIRE tick reaps nothing (we
 *     cannot prove expiry for any claim-first row, and an RPC outage is
 *     exactly the scenario that used to produce phantom FAILEDs).
 *   - hasSignatureLanded throws → that row is skipped this tick.
 *   - txSignature null on a SUBMITTED row (schema-inconsistent) → skipped;
 *     we never fail a payment we cannot look up.
 *
 * Ordering note: the head height is fetched BEFORE any signature-status
 * query — "unseen at a height past lastValidBlockHeight" is only a proof
 * of death when the status check happens after the expiry bound passed.
 *
 * Per-row persistTransition errors bubble: a half-state where the
 * reaper marks FAILED in memory but the row stays SUBMITTED would
 * be re-reaped every tick. Throwing makes BullMQ retry; the next
 * retry will see the row still SUBMITTED and re-reap cleanly.
 */

import {
  reapStuckSubmissions,
  type ReaperPayment,
} from "./reapStuckSubmissions.js";

export interface ReapStuckTickInput {
  now: Date;
  maxAgeSeconds: number;
}

export interface ReapStuckTickDeps {
  loadStuckCandidates: (args: { now: Date }) => Promise<ReaperPayment[]>;
  /** Chain head height ("confirmed"). Throw = RPC unreachable. */
  getCurrentBlockHeight: () => Promise<bigint>;
  /** getSignatureStatuses([sig], {searchTransactionHistory:true}) —
   * true when the cluster has seen the signature in ANY status. */
  hasSignatureLanded: (txSignature: string) => Promise<boolean>;
  persistTransition: (
    id: string,
    transition: { errorMessage: string },
  ) => Promise<void>;
}

export interface ReapStuckTickResult {
  reaped: number;
  scanned: number;
}

export async function runReapStuckTick(
  input: ReapStuckTickInput,
  deps: ReapStuckTickDeps,
): Promise<ReapStuckTickResult> {
  const candidates = await deps.loadStuckCandidates({ now: input.now });
  const results = reapStuckSubmissions({
    payments: candidates,
    maxAgeSeconds: input.maxAgeSeconds,
    now: input.now,
  });

  const stale = results.filter((r) => r.changed);
  if (stale.length === 0) {
    return { reaped: 0, scanned: candidates.length };
  }

  // Fetch the head height once, BEFORE any signature-status check (see
  // header). RPC unreachable → do nothing this tick.
  let currentBlockHeight: bigint;
  try {
    currentBlockHeight = await deps.getCurrentBlockHeight();
  } catch {
    return { reaped: 0, scanned: candidates.length };
  }

  let reaped = 0;
  for (const r of stale) {
    const payment = r.payment;

    if (
      payment.lastValidBlockHeight !== null &&
      currentBlockHeight <= payment.lastValidBlockHeight
    ) {
      // Still inside the validity window — the tx can land. Old wall-clock
      // age alone is never grounds to fail it.
      continue;
    }

    if (!payment.txSignature) {
      // Schema-inconsistent SUBMITTED row; we can't run the final check,
      // so we never fail it blind. Surface via metrics.
      continue;
    }

    let landed: boolean;
    try {
      landed = await deps.hasSignatureLanded(payment.txSignature);
    } catch {
      continue; // RPC silence — leave the row for the next tick
    }
    if (landed) {
      // The payment actually made it on-chain; the poller owns it.
      continue;
    }

    await deps.persistTransition(payment.id, {
      errorMessage: payment.errorMessage ?? "blockhash_expired",
    });
    reaped += 1;
  }

  return { reaped, scanned: candidates.length };
}
