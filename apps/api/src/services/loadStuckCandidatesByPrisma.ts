/**
 * Prisma-backed loader for the stuck-submission reaper BullMQ worker.
 *
 * Returns ReaperPayment[] for SUBMITTED rows whose submittedAt is
 * older than (now - maxAgeSeconds). The pure reapStuckSubmissions
 * classifier re-checks the cutoff (defense-in-depth — DB clock could
 * disagree with worker clock), so the loader's filter is a SQL-side
 * narrowing, not the source of truth.
 *
 * Includes the full ComputePaymentState fields + submittedAt +
 * lastValidBlockHeight so the classifier and the tick's chain-evidence
 * gate (remediation D4) have everything they need.
 */

import type { ReaperPayment } from "./reapStuckSubmissions.js";

interface PrismaStub {
  computePayment: {
    findMany: (args: {
      where: {
        status: "SUBMITTED";
        submittedAt: { lt: Date };
      };
      orderBy: { submittedAt: "asc" };
      take: number;
    }) => Promise<
      Array<{
        id: string;
        status: "SUBMITTED";
        txSignature: string | null;
        errorMessage: string | null;
        paidAt: Date | null;
        retryCount: number;
        submittedAt: Date | null;
        // Optional in the stub for pre-D3 test fixtures; nullable in the
        // schema (legacy rows submitted before the claim-first migration).
        lastValidBlockHeight?: bigint | null;
      }>
    >;
  };
}

export interface LoadStuckCandidatesInput {
  now: Date;
  maxAgeSeconds: number;
  limit: number;
}

export interface LoadStuckCandidatesDeps {
  prisma: PrismaStub;
}

export async function loadStuckCandidatesByPrisma(
  input: LoadStuckCandidatesInput,
  deps: LoadStuckCandidatesDeps,
): Promise<ReaperPayment[]> {
  const cutoff = new Date(input.now.getTime() - input.maxAgeSeconds * 1000);

  const rows = await deps.prisma.computePayment.findMany({
    where: {
      status: "SUBMITTED",
      submittedAt: { lt: cutoff },
    },
    orderBy: { submittedAt: "asc" },
    take: input.limit,
  });

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    txSignature: r.txSignature,
    errorMessage: r.errorMessage,
    paidAt: r.paidAt,
    retryCount: r.retryCount,
    submittedAt: r.submittedAt,
    lastValidBlockHeight: r.lastValidBlockHeight ?? null,
  }));
}
