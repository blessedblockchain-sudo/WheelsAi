/**
 * Prisma-backed loader for the recovery phase of the submit-payments
 * BullMQ worker (claim-first protocol, remediation D3).
 *
 * Returns ComputePayment rows stuck in SUBMITTING — claimed (signed
 * artifacts persisted) by a tick that crashed or hit an RPC error
 * before completing the broadcast → SUBMITTED transition. The recovery
 * phase settles each from on-chain evidence: landed → SUBMITTED,
 * unexpired+unseen → re-broadcast the stored bytes, expired+unseen →
 * back to PENDING.
 *
 * Ordered by scheduledFor asc (fairness, mirrors the PENDING loader).
 *
 * Defensive filter: a SUBMITTING row with a null txSignature or null
 * signedTxB64 is schema-inconsistent (the claim writes all three claim
 * fields atomically). Recovery can neither check nor re-broadcast such
 * a row, and inventing a transition for it would be hostile — it is
 * EXCLUDED here and should surface via metrics, exactly like the
 * reaper's null-submittedAt policy.
 */

import type { SubmittingPaymentRow } from "./runSubmitPaymentsTick.js";

interface PrismaStub {
  computePayment: {
    findMany: (args: {
      where: {
        status: "SUBMITTING";
      };
      orderBy: { scheduledFor: "asc" };
      take: number;
    }) => Promise<
      Array<{
        id: string;
        txSignature: string | null;
        lastValidBlockHeight: bigint | null;
        signedTxB64: string | null;
      }>
    >;
  };
}

export interface LoadSubmittingPaymentsInput {
  limit: number;
}

export interface LoadSubmittingPaymentsDeps {
  prisma: PrismaStub;
}

export async function loadSubmittingPaymentsByPrisma(
  input: LoadSubmittingPaymentsInput,
  deps: LoadSubmittingPaymentsDeps,
): Promise<SubmittingPaymentRow[]> {
  const rows = await deps.prisma.computePayment.findMany({
    where: {
      status: "SUBMITTING",
    },
    orderBy: { scheduledFor: "asc" },
    take: input.limit,
  });

  return rows.flatMap((r) =>
    r.txSignature && r.signedTxB64
      ? [
          {
            id: r.id,
            txSignature: r.txSignature,
            lastValidBlockHeight: r.lastValidBlockHeight,
            signedTxB64: r.signedTxB64,
          },
        ]
      : [],
  );
}
