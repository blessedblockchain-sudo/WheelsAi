/**
 * Prisma-backed persistPayments loader for runTreasurySettlementCycle.
 *
 * The cycle emits a batch of ComputePaymentRecord rows per tick:
 *   - PENDING → deployment with positive cost; the submit-payments worker
 *     picks these up next.
 *   - FAILED  → insufficient funds at decision time; we still record the
 *     row so the dashboard's payment history shows the gap.
 *
 * Delta-billing idempotency (remediation D2) — ONE $transaction doing:
 *   (a) createMany with skipDuplicates: true. Every row carries
 *       periodStart/periodEnd; the schema's
 *       @@unique([treasuryId, nosanaJobId, periodStart]) makes a
 *       crash-replayed or concurrently-double-run tick a DB no-op
 *       (same pattern as persistAgentTokenTrades).
 *   (b) compare-and-set of the treasury billing cursor:
 *       updateMany WHERE id AND (lastComputeBillAt IS NULL OR
 *       < windowEnd) SET lastComputeBillAt = windowEnd. count 0 means a
 *       concurrent tick already advanced the cursor — benign no-op.
 *
 * The cursor advances for FAILED (insufficient_funds) rows too: the bill
 * for that window EXISTS (one bill row per window regardless of outcome);
 * re-metering the same window once funds arrive would double-charge.
 *
 * Sharing one transaction means a crash can never persist payment rows
 * without the cursor advance (which would re-bill the window as a dupe
 * no-op forever) or advance the cursor without rows (which would skip the
 * window's revenue entirely).
 *
 * Type bridging: ComputePaymentRecord.computeSeconds is `number`, but
 * the schema column is BigInt — conversion happens here at the boundary,
 * since Prisma rejects a number on a BigInt column.
 *
 * Errors bubble — swallowing here would silently drop payment records
 * and the cycle counts wouldn't reconcile with the DB.
 */

import type { ComputePaymentRecord } from "./treasurySettlement.js";

interface ComputePaymentCreateRow {
  treasuryId: string;
  nosanaJobId: string;
  amountLamports: bigint;
  computeSeconds: bigint;
  status: "PENDING" | "FAILED";
  errorMessage: string | null;
  scheduledFor: Date;
  periodStart: Date;
  periodEnd: Date;
}

/** The slice of the Prisma transaction client this writer touches. */
export interface ComputePaymentTxClient {
  computePayment: {
    createMany: (args: {
      data: ComputePaymentCreateRow[];
      skipDuplicates: boolean;
    }) => Promise<{ count: number }>;
  };
  agentTreasury: {
    updateMany: (args: {
      where: {
        id: string;
        OR: Array<
          | { lastComputeBillAt: null }
          | { lastComputeBillAt: { lt: Date } }
        >;
      };
      data: { lastComputeBillAt: Date };
    }) => Promise<{ count: number }>;
  };
}

interface PrismaStub {
  $transaction: <T>(
    fn: (tx: ComputePaymentTxClient) => Promise<T>,
  ) => Promise<T>;
}

export interface PersistComputePaymentsDeps {
  prisma: PrismaStub;
}

export async function persistComputePayments(
  records: ComputePaymentRecord[],
  deps: PersistComputePaymentsDeps,
): Promise<void> {
  if (records.length === 0) return;

  const data: ComputePaymentCreateRow[] = records.map((r) => ({
    treasuryId: r.treasuryId,
    nosanaJobId: r.nosanaJobId,
    amountLamports: r.amountLamports,
    computeSeconds: BigInt(r.computeSeconds),
    status: r.status,
    errorMessage: r.errorMessage ?? null,
    scheduledFor: r.scheduledFor,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
  }));

  // New cursor per treasury = the latest periodEnd among its rows this
  // tick (defensively maxed; a tick emits one window per treasury today).
  const cursorTargets = new Map<string, Date>();
  for (const r of records) {
    const prev = cursorTargets.get(r.treasuryId);
    if (!prev || r.periodEnd > prev) {
      cursorTargets.set(r.treasuryId, r.periodEnd);
    }
  }

  await deps.prisma.$transaction(async (tx) => {
    await tx.computePayment.createMany({ data, skipDuplicates: true });

    for (const [treasuryId, windowEnd] of cursorTargets) {
      // Compare-and-set: only move the cursor FORWARD. count 0 means a
      // concurrent tick already advanced past windowEnd — benign no-op.
      await tx.agentTreasury.updateMany({
        where: {
          id: treasuryId,
          OR: [
            { lastComputeBillAt: null },
            { lastComputeBillAt: { lt: windowEnd } },
          ],
        },
        data: { lastComputeBillAt: windowEnd },
      });
    }
  });
}
