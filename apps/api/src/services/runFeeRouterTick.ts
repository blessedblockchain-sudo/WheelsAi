/**
 * Scan-and-dispatch driver for the fee-router BullMQ worker.
 *
 * Each tick:
 *   1. loadUnrouted(now)               → per-treasury aggregate (mint,
 *                                        feeAmountLamports, latestTimestamp)
 *   2. for each row, submit(row)       → ok+sig OR err payload
 *   3. on success: persistCursor(treasuryId, latestTimestamp)
 *   4. counts {routed, failed} returned
 *
 * Cursor advance is the critical-section: if we sent the fee_receive
 * but failed to advance the per-treasury `lastFeeRoutedAt`, the next
 * tick would re-route the same trades — a double-pay. Therefore:
 *   - submit failures: NOT thrown, just counted; cursor NOT advanced;
 *     next tick retries
 *   - persist failures (after a successful submit): THROWN; BullMQ
 *     retries the whole tick; the next loader pass sees the cursor
 *     unchanged and the fee_receive sig will conflict (already paid)
 *     OR the loader's window will see the same trades again and
 *     attempt re-pay (less ideal — operator alert)
 *
 * Concurrency: BullMQ worker runs concurrency=1; the scan-then-dispatch
 * shape plus the per-treasury cursor are sufficient (no row lock needed).
 */

export interface UnroutedFeeRow {
  treasuryId: string;
  mintAddress: string;
  feeAmountLamports: bigint;
  /** Timestamp of the latest trade included in this row's aggregate.
   * Used as the cursor advance target on success. */
  latestTradeTimestamp: Date;
}

export type FeeReceiveOutcome =
  | { ok: true; txSignature: string }
  | { ok: false; error: string };

export interface FeeRouterTickInput {
  now: Date;
}

export interface FeeRouterTickDeps {
  loadUnrouted: (args: { now: Date }) => Promise<UnroutedFeeRow[]>;
  submit: (row: UnroutedFeeRow) => Promise<FeeReceiveOutcome>;
  persistCursor: (treasuryId: string, cursor: Date) => Promise<void>;
}

export interface FeeRouterTickResult {
  routed: number;
  failed: number;
}

export async function runFeeRouterTick(
  input: FeeRouterTickInput,
  deps: FeeRouterTickDeps,
): Promise<FeeRouterTickResult> {
  const rows = await deps.loadUnrouted({ now: input.now });
  let routed = 0;
  let failed = 0;

  for (const row of rows) {
    let outcome: FeeReceiveOutcome;
    try {
      outcome = await deps.submit(row);
    } catch (err) {
      outcome = { ok: false, error: (err as Error).message ?? String(err) };
    }

    if (!outcome.ok) {
      failed += 1;
      continue;
    }

    // submit succeeded → MUST advance cursor or the next tick double-pays.
    // A throw here propagates and BullMQ retries the whole tick.
    await deps.persistCursor(row.treasuryId, row.latestTradeTimestamp);
    routed += 1;
  }

  return { routed, failed };
}
