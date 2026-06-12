/**
 * Scan-and-sweep driver for the Bags fee-claim worker.
 *
 * Unlike the synthetic fee-router (runFeeRouterTick: routes 1% of indexed
 * trade VOLUME from the platform wallet), this sweeps REAL Meteora trading
 * fees that accrue to the platform fee wallet from Bags fee-share, then
 * deposits them into each token's agent-treasury PDA via fee_receive.
 *
 * Each tick:
 *   1. loadBagsTokens()        → bags-launched tokens with a treasury PDA
 *   2. for each, sweepToken()  → claim Meteora fees + deposit to the PDA,
 *                                returning the lamports actually swept (0n
 *                                when nothing was claimable)
 *   3. on a positive sweep: persistSwept() advances the per-token cursor
 *
 * Failure handling mirrors runFeeRouterTick:
 *   - sweepToken throws (claim or deposit failed): counted as failed, NOT
 *     persisted; the next tick retries. Bags claims are idempotent at the
 *     source (a claimed position returns 0 next time), so the only retry
 *     hazard is claim-succeeded-but-deposit-failed, which the binding's
 *     sweepToken handles by re-measuring the fee wallet balance delta.
 *   - persistSwept throws AFTER a successful sweep: propagated so BullMQ
 *     retries the whole tick.
 *
 * Concurrency: the worker runs concurrency=1 (scan-then-dispatch), so no
 * row lock is needed.
 */

export interface BagsSweepRow {
  tokenId: string;
  mintAddress: string;
  treasuryPdaAddress: string;
}

export interface BagsFeeSweepTickInput {
  now: Date;
}

export interface BagsSweepResult {
  /** Lamports moved into the treasury PDA this sweep (0n = nothing claimable). */
  lamports: bigint;
  /** The fee_receive tx signature, or null when nothing was swept. */
  txSignature: string | null;
}

export interface BagsFeeSweepTickDeps {
  loadBagsTokens: (args: { now: Date }) => Promise<BagsSweepRow[]>;
  sweepToken: (row: BagsSweepRow) => Promise<BagsSweepResult>;
  persistSwept: (args: {
    tokenId: string;
    lamports: bigint;
    at: Date;
  }) => Promise<void>;
}

export interface BagsFeeSweepTickResult {
  swept: number;
  skipped: number;
  failed: number;
}

export async function runBagsFeeSweepTick(
  input: BagsFeeSweepTickInput,
  deps: BagsFeeSweepTickDeps,
): Promise<BagsFeeSweepTickResult> {
  const rows = await deps.loadBagsTokens({ now: input.now });
  let swept = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    let result: BagsSweepResult;
    try {
      result = await deps.sweepToken(row);
    } catch {
      failed += 1;
      continue;
    }

    if (result.lamports <= 0n) {
      skipped += 1;
      continue;
    }

    // Sweep landed → advance the cursor. A throw here propagates so BullMQ
    // retries the whole tick (the claim is already idempotent at source).
    await deps.persistSwept({
      tokenId: row.tokenId,
      lamports: result.lamports,
      at: input.now,
    });
    swept += 1;
  }

  return { swept, skipped, failed };
}
