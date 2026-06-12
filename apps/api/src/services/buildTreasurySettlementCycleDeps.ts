/**
 * Build the SettlementCycleDeps for the BullMQ treasury-settlement
 * worker.
 *
 * This is the seam where production loaders (loadSettlementBatchByPrisma,
 * persistComputePayments) get bound to the cycle. The BullMQ shell that
 * registers a repeatable job is then a thin pass-through:
 *
 *   const deps = buildTreasurySettlementCycleDeps({...});
 *   new Worker("treasury-settlement", () => runTreasurySettlementCycle(deps), ...);
 *
 * When a Solana `connection` is provided, the builder also composes the
 * cycle's syncBalances first-step (remediation D1) from
 * runTreasuryBalanceSyncTick + buildTreasuryBalanceSyncTickDeps, so the
 * on-chain PDA balances are mirrored into AgentTreasury before each
 * batch is loaded. Without it the loader's staleness guard will skip
 * every treasury once the mirror ages past the ceiling — so production
 * callers must pass one.
 *
 * Side-effecting pieces (Nosana cost lookup, SOL price oracle) are
 * passed in by the caller — they have their own service modules and
 * shouldn't be hard-wired here.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  buildTreasuryBalanceSyncTickDeps,
  type BalanceSyncConnection,
} from "./buildTreasuryBalanceSyncTickDeps.js";
import {
  loadSettlementBatchByPrisma,
} from "./loadSettlementBatch.js";
import { persistComputePayments } from "./persistComputePayments.js";
import { runTreasuryBalanceSyncTick } from "./runTreasuryBalanceSyncTick.js";
import type {
  BillingWindow,
  ComputeCostResult,
  ComputePaymentRecord,
  DeploymentForSettlement,
} from "./treasurySettlement.js";
import type { SettlementCycleDeps } from "./treasurySettlementCycle.js";

// Narrow the prisma surface to the methods the loaders actually call,
// so the tests can stub a tiny shape and so production callers know
// exactly which Prisma operations are exercised. The agentTreasury
// surface is exercised on two paths: the persistComputePayments cursor
// CAS (inside $transaction) and — when `connection` is provided — the
// balance-sync first-step's findMany/updateMany.
type SettlementPrismaSurface = Pick<
  PrismaClient,
  "agentDeployment" | "computePayment" | "agentTreasury" | "$transaction"
> | {
  agentDeployment: {
    findMany: (
      args: Prisma.AgentDeploymentFindManyArgs,
    ) => Promise<unknown[]>;
  };
  $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
};

export interface BuildTreasurySettlementCycleDepsInput {
  prisma: SettlementPrismaSurface;
  getComputeCost: (
    deployment: DeploymentForSettlement,
    window: BillingWindow,
  ) => Promise<ComputeCostResult>;
  getSolPriceUsd: () => Promise<number>;
  intervalMs: number;
  /** RPC surface for the D1 balance-sync first-step. Optional so cycle
   * tests can omit it; production (the BullMQ shell) always passes the
   * shared Connection. */
  connection?: BalanceSyncConnection;
  /** Staleness ceiling forwarded to loadSettlementBatch (defaults there
   * to DEFAULT_MAX_BALANCE_STALENESS_MS). */
  maxBalanceStalenessMs?: number;
}

export function buildTreasurySettlementCycleDeps(
  input: BuildTreasurySettlementCycleDepsInput,
): SettlementCycleDeps {
  const connection = input.connection;
  const syncBalances = connection
    ? (() => {
        const syncDeps = buildTreasuryBalanceSyncTickDeps({
          prisma: input.prisma as never,
          connection,
        });
        return () =>
          runTreasuryBalanceSyncTick({ now: new Date() }, syncDeps);
      })()
    : undefined;

  return {
    syncBalances,
    loadBatch: (args) =>
      loadSettlementBatchByPrisma(
        { ...args, maxBalanceStalenessMs: input.maxBalanceStalenessMs },
        {
          // The Prisma stub on tests + the real client both satisfy the
          // narrow surface loadSettlementBatchByPrisma uses internally.
          prisma: input.prisma as never,
        },
      ),
    persistPayments: (records: ComputePaymentRecord[]) =>
      persistComputePayments(records, {
        prisma: input.prisma as never,
      }),
    getComputeCost: input.getComputeCost,
    getSolPriceUsd: input.getSolPriceUsd,
    intervalMs: input.intervalMs,
  };
}
