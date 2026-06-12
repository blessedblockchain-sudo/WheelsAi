/**
 * Compare-and-set transition writer for FeeRoutingBatch rows
 * (row-identity fee routing, remediation D6a).
 *
 *   - "submitted" — CAS CLAIMED→SUBMITTED persisting the signed-tx
 *     artifacts {txSignature, lastValidBlockHeight, signedTxB64}. This
 *     write happens BEFORE the broadcast (claim-first): whatever crashes
 *     afterwards, the durable record of "these exact bytes may be in
 *     flight" exists, so recovery re-broadcasts the SAME signature
 *     instead of re-signing. Returns true only on count===1 — false
 *     means a recovery scan FAILED the batch first and the caller must
 *     NOT broadcast its (now orphaned) artifact.
 *
 *   - "confirmed" — CAS SUBMITTED→CONFIRMED. count===0 is benign (an
 *     overlapping recovery scan settled it from the same on-chain
 *     evidence). Idempotent by construction: a second confirm attempt
 *     matches zero rows and changes nothing.
 *
 *   - "failed" — ONE $transaction: CAS {CLAIMED,SUBMITTED}→FAILED, and
 *     ONLY when that CAS won (count===1) un-stamp the batch's trades
 *     (feeRoutingBatchId back to NULL) so they rejoin the next batch.
 *     Gating the un-stamp on the CAS means a batch that raced to
 *     CONFIRMED elsewhere can never have its trades re-released — that
 *     would be the double-pay.
 *
 * Status is the guard column everywhere; the unique tx_signature
 * constraint is defense-in-depth against two batches recording the same
 * signature.
 */

import type { SignedFeeBatchArtifact } from "./runFeeRouterTick.js";

export type FeeBatchTransition =
  | { type: "submitted"; artifact: SignedFeeBatchArtifact }
  | { type: "confirmed" }
  | { type: "failed" };

interface BatchUpdateManyArgs {
  where: {
    id: string;
    status?: "CLAIMED" | "SUBMITTED" | { in: Array<"CLAIMED" | "SUBMITTED"> };
  };
  data: Record<string, unknown>;
}

interface PrismaTxStub {
  feeRoutingBatch: {
    updateMany: (args: BatchUpdateManyArgs) => Promise<{ count: number }>;
  };
  agentTokenTrade: {
    updateMany: (args: {
      where: { feeRoutingBatchId: string };
      data: { feeRoutingBatchId: null };
    }) => Promise<{ count: number }>;
  };
}

interface PrismaStub {
  feeRoutingBatch: {
    updateMany: (args: BatchUpdateManyArgs) => Promise<{ count: number }>;
  };
  $transaction: <T>(fn: (tx: PrismaTxStub) => Promise<T>) => Promise<T>;
}

export interface PersistFeeBatchTransitionDeps {
  prisma: PrismaStub;
}

export async function persistFeeBatchTransition(
  batchId: string,
  transition: FeeBatchTransition,
  deps: PersistFeeBatchTransitionDeps,
): Promise<boolean> {
  if (transition.type === "submitted") {
    const r = await deps.prisma.feeRoutingBatch.updateMany({
      where: { id: batchId, status: "CLAIMED" },
      data: {
        status: "SUBMITTED",
        txSignature: transition.artifact.txSignature,
        lastValidBlockHeight: transition.artifact.lastValidBlockHeight,
        signedTxB64: transition.artifact.signedTxB64,
      },
    });
    return r.count === 1;
  }

  if (transition.type === "confirmed") {
    const r = await deps.prisma.feeRoutingBatch.updateMany({
      where: { id: batchId, status: "SUBMITTED" },
      data: { status: "CONFIRMED" },
    });
    return r.count === 1; // 0 = already settled elsewhere — benign
  }

  // "failed": batch CAS first; un-stamp only if we won it.
  return deps.prisma.$transaction(async (tx) => {
    const r = await tx.feeRoutingBatch.updateMany({
      where: { id: batchId, status: { in: ["CLAIMED", "SUBMITTED"] } },
      data: { status: "FAILED" },
    });
    if (r.count !== 1) {
      // Already CONFIRMED or FAILED elsewhere. NEVER un-stamp here — if
      // it confirmed, releasing the trades would re-route a paid fee.
      return false;
    }
    await tx.agentTokenTrade.updateMany({
      where: { feeRoutingBatchId: batchId },
      data: { feeRoutingBatchId: null },
    });
    return true;
  });
}
