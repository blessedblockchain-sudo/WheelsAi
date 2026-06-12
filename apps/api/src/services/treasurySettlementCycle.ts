/**
 * Treasury settlement cycle orchestrator (plan A3).
 *
 * One call = one tick of the BullMQ worker. The worker is a thin shell over
 * this function: every IO surface (load, compute cost, sol price oracle,
 * persist) is dependency-injected so the orchestration logic is unit-
 * testable without a DB, the Nosana SDK, or a price feed.
 *
 * Flow:
 *   0. syncBalances()                     — mirror on-chain PDA balances (D1);
 *                                           failure degrades to "stale → skip",
 *                                           never aborts the cycle
 *   1. loadBatch(now, intervalMs)         — eligible (deployment, treasury) pairs
 *   2. getSolPriceUsd()                   — abort the cycle if the oracle is down
 *   3. runSettlementTick(...)             — pure decision layer; collects records
 *   4. persistPayments(records)           — single batched write
 *
 * Counters returned: loaded / recorded / pending / failed / errors /
 * skippedStale. The worker logs these and the public status page exposes
 * them.
 */

import {
  runSettlementTick,
  type BillingWindow,
  type ComputeCostResult,
  type ComputePaymentRecord,
  type DeploymentForSettlement,
  type TreasuryForSettlement,
} from "./treasurySettlement.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("treasury-cycle");

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface SettlementBatch {
  deployments: DeploymentForSettlement[];
  treasuries: Map<string, TreasuryForSettlement>;
  /** Treasuries excluded by the D1 staleness guard (balance mirror never
   * synced or older than the staleness ceiling). Optional so simple test
   * stubs that predate the guard keep working. */
  skippedStale?: number;
}

export interface SettlementCycleDeps {
  /** D1: mirror on-chain PDA balances into AgentTreasury BEFORE loading
   * the batch, so decisions see fresh solBalanceLamports. Optional at the
   * type level (tests can omit it), but production wiring
   * (buildTreasurySettlementCycleDeps) always provides it. A throw is
   * counted in `errors` and the cycle continues — the loader's staleness
   * guard turns an un-synced mirror into "skip", never "pay". */
  syncBalances?: () => Promise<{ synced: number; failed: number }>;
  loadBatch: (args: {
    now: Date;
    intervalMs: number;
  }) => Promise<SettlementBatch>;
  getComputeCost: (
    deployment: DeploymentForSettlement,
    window: BillingWindow,
  ) => Promise<ComputeCostResult>;
  getSolPriceUsd: () => Promise<number>;
  persistPayments: (records: ComputePaymentRecord[]) => Promise<void>;
  intervalMs?: number;
  now?: Date;
}

export interface SettlementCycleResult {
  loaded: number;
  recorded: number;
  pending: number;
  failed: number;
  errors: number;
  /** Treasuries skipped by the loader's balance-staleness guard (D1). */
  skippedStale: number;
}

export async function runTreasurySettlementCycle(
  deps: SettlementCycleDeps,
): Promise<SettlementCycleResult> {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = deps.now ?? new Date();

  const result: SettlementCycleResult = {
    loaded: 0,
    recorded: 0,
    pending: 0,
    failed: 0,
    errors: 0,
    skippedStale: 0,
  };

  // Step 0 (D1): refresh the on-chain balance mirror FIRST so the
  // batch loaded below sees fresh solBalanceLamports + balanceSyncedAt.
  // A sync failure is logged + counted but never aborts the cycle: the
  // loader's staleness guard degrades un-synced treasuries to "skip".
  if (deps.syncBalances) {
    try {
      const sync = await deps.syncBalances();
      if (sync.failed > 0) {
        logger.warn(sync, "balance sync completed with per-row failures");
      }
    } catch (err) {
      logger.error({ err }, "balance sync threw; relying on staleness guard");
      result.errors += 1;
    }
  }

  const batch = await deps.loadBatch({ now, intervalMs });
  result.loaded = batch.deployments.length;
  result.skippedStale = batch.skippedStale ?? 0;
  if (result.loaded === 0) return result;

  let solPriceUsd: number;
  try {
    solPriceUsd = await deps.getSolPriceUsd();
  } catch (err) {
    logger.error({ err }, "sol price oracle failed; aborting cycle");
    result.errors += 1;
    return result;
  }

  const collected: ComputePaymentRecord[] = [];
  await runSettlementTick({
    deployments: batch.deployments,
    treasuries: batch.treasuries,
    now,
    intervalMs,
    solPriceUsd,
    getComputeCost: deps.getComputeCost,
    recordComputePayment: async (record) => {
      collected.push(record);
    },
  });

  result.recorded = collected.length;
  for (const r of collected) {
    if (r.status === "PENDING") result.pending += 1;
    else if (r.status === "FAILED") result.failed += 1;
  }

  if (collected.length > 0) {
    try {
      await deps.persistPayments(collected);
    } catch (err) {
      logger.error(
        { err, recordCount: collected.length },
        "persistPayments failed; in-memory counts kept for retry",
      );
      result.errors += 1;
    }
  }

  return result;
}
