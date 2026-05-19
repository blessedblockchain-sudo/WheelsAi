/**
 * Conditional-update Prisma writer for the submit-payment driver.
 *
 * Race safety: the writer uses updateMany WHERE id = X AND status =
 * 'PENDING'. If another worker already advanced the row (e.g. manual
 * operator submit), the count returns 0 and we throw — preventing a
 * double-submit where two on-chain txs both move funds.
 *
 * Defense-in-depth: the schema's unique tx_signature constraint will
 * also crash a second submit attempt if the conditional update
 * somehow slipped through (different sig from the same id is
 * impossible because submitTreasuryPayment is deterministic given a
 * keypair + blockhash).
 *
 * Field policy:
 *   - submitted → status SUBMITTED, txSignature, submittedAt = now,
 *                 errorMessage cleared to null
 *   - failed    → status FAILED, errorMessage, txSignature stays null
 *                 (no sig landed; writing one would make the row
 *                 indistinguishable from SUBMITTED-but-stuck)
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

export type SubmitTransition =
  | { type: "submitted"; txSignature: string }
  | { type: "failed"; errorMessage: string };

export interface PersistSubmitTransitionDeps {
  prisma: PrismaStub;
  now: Date;
}

export async function persistSubmitTransition(
  id: string,
  transition: SubmitTransition,
  deps: PersistSubmitTransitionDeps,
): Promise<void> {
  const data: Record<string, unknown> =
    transition.type === "submitted"
      ? {
          status: "SUBMITTED",
          txSignature: transition.txSignature,
          submittedAt: deps.now,
          errorMessage: null,
        }
      : {
          status: "FAILED",
          errorMessage: transition.errorMessage,
          txSignature: null,
        };

  const result = await (deps.prisma as never as {
    computePayment: {
      updateMany: (args: {
        where: { id: string; status: "PENDING" };
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };
  }).computePayment.updateMany({
    where: { id, status: "PENDING" },
    data,
  });

  if (result.count === 0) {
    throw new Error(
      `persistSubmitTransition: payment ${id} is not in PENDING — refusing to write`,
    );
  }
}
