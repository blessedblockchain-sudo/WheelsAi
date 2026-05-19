/**
 * Scan-and-dispatch driver for the stuck-submission reaper BullMQ
 * worker.
 *
 * Each tick:
 *   1. loadStuckCandidates(now)        → SUBMITTED rows w/ submittedAt
 *   2. reapStuckSubmissions(...)       (pure; classifies stuck vs OK)
 *   3. for each changed result, persistTransition(id, "blockhash_expired")
 *   4. counts {reaped, scanned} returned
 *
 * Reaping rule (mirrored in reapStuckSubmissions):
 *   - status === "SUBMITTED"
 *   - submittedAt IS NOT NULL
 *   - submittedAt < (now - maxAgeSeconds * 1000)
 *
 * The poll worker would have transitioned the row to CONFIRMED long
 * before this if the tx had landed; if it didn't, the blockhash has
 * expired and the tx will never land. We mark FAILED with the reason
 * "blockhash_expired" — actionable for the operator's dashboard.
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

  let reaped = 0;
  for (const r of results) {
    if (!r.changed) continue;
    await deps.persistTransition(r.payment.id, {
      errorMessage: r.payment.errorMessage ?? "blockhash_expired",
    });
    reaped += 1;
  }

  return { reaped, scanned: candidates.length };
}
