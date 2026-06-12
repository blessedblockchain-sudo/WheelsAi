/**
 * Prisma-backed loader for the recovery phase of the fee-router worker
 * (row-identity routing, remediation D6a).
 *
 * Returns FeeRoutingBatch rows a previous tick (or an overlapping
 * replica) left in flight:
 *
 *   - SUBMITTED — signed artifacts persisted; the broadcast and/or the
 *     same-tick confirmation didn't complete. Recovery settles these
 *     from on-chain evidence (landed → CONFIRMED, expired+unseen →
 *     FAILED + un-stamp, unexpired+unseen → re-broadcast same bytes).
 *     Always loaded — every SUBMITTED batch has a signature to check,
 *     so acting on it is evidence-based and race-free under CAS.
 *
 *   - CLAIMED — the crash window between the claim transaction and the
 *     sign step. No signature exists, so there is no evidence to wait
 *     for; recovery un-stamps + FAILs them. Loaded only when OLDER than
 *     `claimedGraceMs` (default 5 min): a young CLAIMED batch is most
 *     likely an overlapping replica mid-sign, and although the
 *     CLAIMED→SUBMITTED CAS makes killing it merely churn (the owner
 *     aborts without broadcasting), the grace window avoids that churn
 *     in the steady state.
 *
 * Defensive filter: a SUBMITTED row missing txSignature/signedTxB64 is
 * schema-inconsistent (the CAS writes all artifacts atomically). The
 * driver skips those — surfaced via metrics, mirroring the D3 loader's
 * policy on inconsistent SUBMITTING payments.
 *
 * Ordered by createdAt asc (oldest first — fairness under the limit).
 */

import type { StaleFeeBatchRow } from "./runFeeRouterTick.js";

export const DEFAULT_CLAIMED_GRACE_MS = 5 * 60 * 1000; // 5 min

interface PrismaStub {
  feeRoutingBatch: {
    findMany: (args: {
      where: {
        OR: Array<
          | { status: "SUBMITTED" }
          | { status: "CLAIMED"; createdAt: { lt: Date } }
        >;
      };
      orderBy: { createdAt: "asc" };
      take: number;
      select: unknown;
    }) => Promise<
      Array<{
        id: string;
        treasuryId: string;
        status: "CLAIMED" | "SUBMITTED";
        txSignature: string | null;
        lastValidBlockHeight: bigint | null;
        signedTxB64: string | null;
      }>
    >;
  };
}

export interface LoadStaleFeeBatchesInput {
  now: Date;
  limit: number;
  /** Minimum age before a CLAIMED batch is treated as abandoned. */
  claimedGraceMs?: number;
}

export interface LoadStaleFeeBatchesDeps {
  prisma: PrismaStub;
}

export async function loadStaleFeeBatchesByPrisma(
  input: LoadStaleFeeBatchesInput,
  deps: LoadStaleFeeBatchesDeps,
): Promise<StaleFeeBatchRow[]> {
  const graceMs = input.claimedGraceMs ?? DEFAULT_CLAIMED_GRACE_MS;
  const claimedBefore = new Date(input.now.getTime() - graceMs);

  const rows = await deps.prisma.feeRoutingBatch.findMany({
    where: {
      OR: [
        { status: "SUBMITTED" },
        { status: "CLAIMED", createdAt: { lt: claimedBefore } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: input.limit,
    select: {
      id: true,
      treasuryId: true,
      status: true,
      txSignature: true,
      lastValidBlockHeight: true,
      signedTxB64: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    treasuryId: r.treasuryId,
    status: r.status,
    txSignature: r.txSignature,
    lastValidBlockHeight: r.lastValidBlockHeight,
    signedTxB64: r.signedTxB64,
  }));
}
