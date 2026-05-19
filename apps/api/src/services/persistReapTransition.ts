/**
 * Conditional-update Prisma writer for runReapStuckTick.
 *
 * Same SQL shape as persistPollTransition's failed branch (SUBMITTED →
 * FAILED with errorMessage), but a dedicated module keeps the reaper
 * call-site readable and gives us a place to document the reap
 * invariants distinctly from the poll ones.
 *
 * Race safety: WHERE id = X AND status = 'SUBMITTED'. If the poll
 * worker confirmed the row in the last few milliseconds, count
 * returns 0 and we throw — preventing a phantom failure on a payment
 * that actually succeeded.
 *
 * Field policy: status FAILED + errorMessage. paidAt and txSignature
 * stay as-is — the row HAD a sig that landed on-chain but won't ever
 * confirm, and the operator dashboard reads (paidAt === null && status
 * === FAILED && txSignature !== null) as the "submitted-never-landed"
 * pattern for debugging.
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

export interface PersistReapTransitionDeps {
  prisma: PrismaStub;
}

export async function persistReapTransition(
  id: string,
  transition: { errorMessage: string },
  deps: PersistReapTransitionDeps,
): Promise<void> {
  const result = await (deps.prisma as never as {
    computePayment: {
      updateMany: (args: {
        where: { id: string; status: "SUBMITTED" };
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };
  }).computePayment.updateMany({
    where: { id, status: "SUBMITTED" },
    data: {
      status: "FAILED",
      errorMessage: transition.errorMessage,
    },
  });

  if (result.count === 0) {
    throw new Error(
      `persistReapTransition: payment ${id} is not in SUBMITTED — refusing to write`,
    );
  }
}
