/**
 * Scan-and-dispatch driver for the poll-confirmation BullMQ worker.
 *
 * Each tick:
 *   1. loadSubmittedBatch(now)     → SUBMITTED rows ready to poll
 *   2. for each, pollOne(row)      → confirmed | failed | unchanged
 *   3. persistTransition(...)      ONLY when changed (skip unchanged)
 *   4. counts {confirmed, failed, unchanged} returned
 *
 * Skip-on-unchanged is the throughput optimization — most polls during
 * normal operation are "still confirming" and don't warrant a DB
 * write.
 *
 * Per-row throw → counts as unchanged. RPC blips on one sig shouldn't
 * poison the whole tick; the next tick will retry naturally because
 * the loader still surfaces SUBMITTED rows.
 *
 * Per-row persistTransition errors are NOT swallowed: if we mark a
 * row CONFIRMED in memory but the DB write fails, the next tick would
 * re-poll the now-confirmed sig and infinitely loop. The tick throws
 * so BullMQ retries — the next retry will find the row still SUBMITTED
 * and re-confirm cleanly.
 */

export interface SubmittedPaymentRow {
  id: string;
  txSignature: string;
}

export type PollOutcome =
  | { type: "confirmed" }
  | { type: "failed"; errorMessage: string }
  | { type: "unchanged" };

export interface PollPaymentsTickInput {
  now: Date;
}

export interface PollPaymentsTickDeps {
  loadSubmittedBatch: (args: {
    now: Date;
  }) => Promise<SubmittedPaymentRow[]>;
  pollOne: (row: SubmittedPaymentRow) => Promise<PollOutcome>;
  persistTransition: (
    id: string,
    outcome: PollOutcome,
  ) => Promise<void>;
}

export interface PollPaymentsTickResult {
  confirmed: number;
  failed: number;
  unchanged: number;
}

export async function runPollPaymentsTick(
  input: PollPaymentsTickInput,
  deps: PollPaymentsTickDeps,
): Promise<PollPaymentsTickResult> {
  const rows = await deps.loadSubmittedBatch({ now: input.now });
  let confirmed = 0;
  let failed = 0;
  let unchanged = 0;

  for (const row of rows) {
    let outcome: PollOutcome;
    try {
      outcome = await deps.pollOne(row);
    } catch {
      outcome = { type: "unchanged" };
    }

    if (outcome.type === "unchanged") {
      unchanged += 1;
      continue;
    }

    await deps.persistTransition(row.id, outcome);

    if (outcome.type === "confirmed") confirmed += 1;
    else failed += 1;
  }

  return { confirmed, failed, unchanged };
}
