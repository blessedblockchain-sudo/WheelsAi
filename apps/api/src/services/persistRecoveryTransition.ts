/**
 * Conditional-update Prisma writer for the recovery phase of the
 * submit-payments driver (claim-first protocol, remediation D3).
 *
 * Settles SUBMITTING rows from on-chain evidence gathered by
 * runSubmitPaymentsTick's recovery scan:
 *
 *   - "landed"      → the signature is on-chain (any confirmation
 *                     status) → SUBMITTING → SUBMITTED. The confirmation
 *                     poller owns it from here (CONFIRMED, or FAILED if
 *                     the tx landed with an error).
 *   - "rebroadcast" → the stored bytes were re-sent (blockhash still
 *                     valid) → SUBMITTING → SUBMITTED, same as a normal
 *                     first broadcast.
 *   - "expired"     → provably dead (block height past
 *                     lastValidBlockHeight AND signature unseen with
 *                     searchTransactionHistory) → SUBMITTING → PENDING
 *                     with ALL claim fields cleared (txSignature,
 *                     signedTxB64, lastValidBlockHeight). Clearing is
 *                     what licenses the next tick to re-sign: a fresh
 *                     blockhash is only safe once the old signature can
 *                     never land.
 *
 * Race safety: WHERE id = X AND status = 'SUBMITTING'. count===0 means
 * another replica's recovery scan settled the row in the last few
 * milliseconds — a BENIGN race (both scans derived their verdict from
 * the same on-chain facts); we return without throwing. Unlike the
 * submit path's persistSubmitTransition, there is no in-memory state
 * here that could go unrecorded: the artifacts are already durable on
 * the row.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

type PrismaStub =
  | Pick<PrismaClient, "computePayment">
  | {
      computePayment: {
        updateMany: (
          args: Prisma.ComputePaymentUpdateManyArgs,
        ) => Promise<{ count: number }>;
      };
    };

export type RecoveryTransition =
  | { type: "landed" }
  | { type: "rebroadcast" }
  | { type: "expired" };

export interface PersistRecoveryTransitionDeps {
  prisma: PrismaStub;
  now: Date;
}

export async function persistRecoveryTransition(
  id: string,
  transition: RecoveryTransition,
  deps: PersistRecoveryTransitionDeps,
): Promise<void> {
  const data: Record<string, unknown> =
    transition.type === "expired"
      ? {
          status: "PENDING",
          txSignature: null,
          signedTxB64: null,
          lastValidBlockHeight: null,
        }
      : {
          status: "SUBMITTED",
          submittedAt: deps.now,
          errorMessage: null,
        };

  await (deps.prisma as never as {
    computePayment: {
      updateMany: (args: {
        where: { id: string; status: "SUBMITTING" };
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };
  }).computePayment.updateMany({
    where: { id, status: "SUBMITTING" },
    data,
  });
}
