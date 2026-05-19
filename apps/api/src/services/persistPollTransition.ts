/**
 * Conditional-update Prisma writer for runPollPaymentsTick.
 *
 * Race safety: WHERE id = X AND status = 'SUBMITTED'. If the reaper
 * marked the row FAILED first, the count returns 0 and we throw —
 * BullMQ retries the tick; the next loader pass will skip the
 * now-FAILED row.
 *
 * Field policy:
 *   - confirmed → status CONFIRMED, paidAt = now (dashboard reads
 *                 paidAt to render "settled at <time>"). errorMessage
 *                 cleared. txSignature left alone (already set on submit).
 *   - failed    → status FAILED, errorMessage. paidAt stays null.
 *   - unchanged → no-op. The driver also skips this case; this is
 *                 the defense-in-depth fallback.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import type { PollOutcome } from "./runPollPaymentsTick.js";

type PrismaStub =
  | Pick<PrismaClient, "computePayment">
  | {
      computePayment: {
        updateMany: (
          args: Prisma.ComputePaymentUpdateManyArgs,
        ) => Promise<{ count: number }>;
      };
    };

export interface PersistPollTransitionDeps {
  prisma: PrismaStub;
  now: Date;
}

export async function persistPollTransition(
  id: string,
  outcome: PollOutcome,
  deps: PersistPollTransitionDeps,
): Promise<void> {
  if (outcome.type === "unchanged") return;

  const data: Record<string, unknown> =
    outcome.type === "confirmed"
      ? {
          status: "CONFIRMED",
          paidAt: deps.now,
          errorMessage: null,
        }
      : {
          status: "FAILED",
          errorMessage: outcome.errorMessage,
        };

  const result = await (deps.prisma as never as {
    computePayment: {
      updateMany: (args: {
        where: { id: string; status: "SUBMITTED" };
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };
  }).computePayment.updateMany({
    where: { id, status: "SUBMITTED" },
    data,
  });

  if (result.count === 0) {
    throw new Error(
      `persistPollTransition: payment ${id} is not in SUBMITTED — refusing to write`,
    );
  }
}
