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
 * Side-effecting pieces (Nosana cost lookup, SOL price oracle) are
 * passed in by the caller — they have their own service modules and
 * shouldn't be hard-wired here.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  loadSettlementBatchByPrisma,
} from "./loadSettlementBatch.js";
import { persistComputePayments } from "./persistComputePayments.js";
import type {
  ComputeCostResult,
  ComputePaymentRecord,
  DeploymentForSettlement,
} from "./treasurySettlement.js";
import type { SettlementCycleDeps } from "./treasurySettlementCycle.js";

// Narrow the prisma surface to the methods the loaders actually call,
// so the tests can stub a tiny shape and so production callers know
// exactly which Prisma operations are exercised.
type SettlementPrismaSurface = Pick<
  PrismaClient,
  "agentDeployment" | "computePayment"
> | {
  agentDeployment: {
    findMany: (
      args: Prisma.AgentDeploymentFindManyArgs,
    ) => Promise<unknown[]>;
  };
  computePayment: {
    createMany: (
      args: Prisma.ComputePaymentCreateManyArgs,
    ) => Promise<{ count: number }>;
  };
};

export interface BuildTreasurySettlementCycleDepsInput {
  prisma: SettlementPrismaSurface;
  getComputeCost: (
    deployment: DeploymentForSettlement,
  ) => Promise<ComputeCostResult>;
  getSolPriceUsd: () => Promise<number>;
  intervalMs: number;
}

export function buildTreasurySettlementCycleDeps(
  input: BuildTreasurySettlementCycleDepsInput,
): SettlementCycleDeps {
  return {
    loadBatch: (args) =>
      loadSettlementBatchByPrisma(args, {
        // The Prisma stub on tests + the real client both satisfy the
        // narrow surface loadSettlementBatchByPrisma uses internally.
        prisma: input.prisma as never,
      }),
    persistPayments: (records: ComputePaymentRecord[]) =>
      persistComputePayments(records, {
        prisma: input.prisma as never,
      }),
    getComputeCost: input.getComputeCost,
    getSolPriceUsd: input.getSolPriceUsd,
    intervalMs: input.intervalMs,
  };
}
