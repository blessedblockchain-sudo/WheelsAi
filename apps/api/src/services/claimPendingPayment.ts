/**
 * Compare-and-set claim writer — the heart of the claim-first protocol
 * (remediation D3).
 *
 * Atomically moves a payment PENDING → SUBMITTING WHILE persisting the
 * signed-transaction artifacts:
 *
 *   UPDATE compute_payments
 *      SET status = 'SUBMITTING',
 *          tx_signature = $sig,
 *          last_valid_block_height = $lvbh,
 *          signed_tx_b64 = $bytes
 *    WHERE id = $id AND status = 'PENDING'
 *
 * This write happens BEFORE the broadcast. Whatever crashes or overlaps
 * afterwards, the durable record of "these exact bytes may be in flight"
 * already exists — recovery re-broadcasts the SAME signature instead of
 * re-signing, which is what makes a double-spend impossible.
 *
 * count semantics: count===1 → we own the row (return true). count===0 →
 * another worker (overlapping replica, manual operator action) claimed or
 * moved the row first — a BENIGN race under CAS; the caller skips the row
 * without broadcasting anything (return false). Never throws on a lost
 * race: with two replicas this is an expected steady-state occurrence,
 * not an anomaly.
 *
 * Defense-in-depth: the schema's unique tx_signature constraint would
 * reject a second claim that somehow tried to record the same signature.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import type { SignedPaymentArtifact } from "./runSubmitPaymentsTick.js";

type PrismaStub =
  | Pick<PrismaClient, "computePayment">
  | {
      computePayment: {
        updateMany: (
          args: Prisma.ComputePaymentUpdateManyArgs,
        ) => Promise<{ count: number }>;
      };
    };

export interface ClaimPendingPaymentDeps {
  prisma: PrismaStub;
}

export async function claimPendingPayment(
  id: string,
  artifact: SignedPaymentArtifact,
  deps: ClaimPendingPaymentDeps,
): Promise<boolean> {
  const result = await (deps.prisma as never as {
    computePayment: {
      updateMany: (args: {
        where: { id: string; status: "PENDING" };
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };
  }).computePayment.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: "SUBMITTING",
      txSignature: artifact.txSignature,
      lastValidBlockHeight: artifact.lastValidBlockHeight,
      signedTxB64: artifact.signedTxB64,
    },
  });

  return result.count === 1;
}
