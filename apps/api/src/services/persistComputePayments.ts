/**
 * Prisma-backed persistPayments loader for runTreasurySettlementCycle.
 *
 * The cycle emits a batch of ComputePaymentRecord rows per tick:
 *   - PENDING → deployment with positive cost; submitTreasuryPayment
 *     picks these up next.
 *   - FAILED  → cost lookup errored; we still record the row so the
 *     dashboard's payment history shows the gap.
 *
 * Type bridging: ComputePaymentRecord.computeSeconds is `number`, but
 * the schema column is BigInt — conversion happens here at the boundary,
 * since Prisma rejects a number on a BigInt column.
 *
 * Errors bubble — swallowing here would silently drop payment records
 * and the cycle counts wouldn't reconcile with the DB.
 */

import type { ComputePaymentRecord } from "./treasurySettlement.js";

interface PrismaStub {
  computePayment: {
    createMany: (args: {
      data: Array<{
        treasuryId: string;
        nosanaJobId: string;
        amountLamports: bigint;
        computeSeconds: bigint;
        status: "PENDING" | "FAILED";
        errorMessage: string | null;
        scheduledFor: Date;
      }>;
    }) => Promise<{ count: number }>;
  };
}

export interface PersistComputePaymentsDeps {
  prisma: PrismaStub;
}

export async function persistComputePayments(
  records: ComputePaymentRecord[],
  deps: PersistComputePaymentsDeps,
): Promise<void> {
  if (records.length === 0) return;

  const data = records.map((r) => ({
    treasuryId: r.treasuryId,
    nosanaJobId: r.nosanaJobId,
    amountLamports: r.amountLamports,
    computeSeconds: BigInt(r.computeSeconds),
    status: r.status,
    errorMessage: r.errorMessage ?? null,
    scheduledFor: r.scheduledFor,
  }));

  await deps.prisma.computePayment.createMany({ data });
}
