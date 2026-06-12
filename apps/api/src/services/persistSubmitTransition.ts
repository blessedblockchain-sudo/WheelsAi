/**
 * Conditional-update Prisma writer for the submit-payment driver
 * (claim-first protocol, remediation D3/D5).
 *
 * Why claim-first: signing is NOT deterministic across ticks — each tick
 * fetches a FRESH blockhash, so two signing passes over the same payment
 * produce two different, independently valid transfers. (An earlier
 * version of this comment claimed determinism made a re-submit harmless;
 * that was false.) The protection is ordering, not determinism: the row
 * is claimed (PENDING → SUBMITTING, persisting txSignature +
 * lastValidBlockHeight + signedTxB64 — see claimPendingPayment.ts)
 * BEFORE any broadcast, so a crash or replica overlap can only ever
 * re-broadcast the SAME stored bytes, never re-sign.
 *
 * Transitions written here:
 *   - submitted         → SUBMITTING → SUBMITTED, submittedAt = now,
 *                         errorMessage cleared. (txSignature was already
 *                         persisted by the claim.) count===0 THROWS: we
 *                         hold a claimed row whose bytes are on the wire —
 *                         losing track of it silently is never OK. The
 *                         tick bubbles, BullMQ retries, and the recovery
 *                         scan settles the row from on-chain evidence.
 *   - failed            → PENDING → FAILED (terminal), errorMessage set.
 *                         Pre-claim failures only (prepare/sign threw) —
 *                         no tx bytes exist, txSignature stays null.
 *   - resolution_failed → row STAYS PENDING, resolutionAttempts += 1,
 *                         errorMessage records the resolution error. The
 *                         next tick retries (D5: transient "no host yet").
 *   - parked            → PENDING → PARKED, resolutionAttempts += 1,
 *                         errorMessage set. Poison row pulled from the
 *                         queue until an operator re-PENDINGs it.
 *
 * count semantics for the three PENDING-guarded transitions: count===0
 * means another worker claimed/moved the row mid-flight — a BENIGN race
 * (nothing of ours is on-chain pre-claim), so we return without
 * throwing; aborting the tick would punish every other row in the batch
 * for a race that resolved correctly.
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
  | { type: "failed"; errorMessage: string }
  | { type: "resolution_failed"; errorMessage: string }
  | { type: "parked"; errorMessage: string };

export interface PersistSubmitTransitionDeps {
  prisma: PrismaStub;
  now: Date;
}

export async function persistSubmitTransition(
  id: string,
  transition: SubmitTransition,
  deps: PersistSubmitTransitionDeps,
): Promise<void> {
  const prisma = deps.prisma as never as {
    computePayment: {
      updateMany: (args: {
        where: { id: string; status: "PENDING" | "SUBMITTING" };
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>;
    };
  };

  if (transition.type === "submitted") {
    const result = await prisma.computePayment.updateMany({
      where: { id, status: "SUBMITTING" },
      data: {
        status: "SUBMITTED",
        submittedAt: deps.now,
        errorMessage: null,
      },
    });
    if (result.count === 0) {
      throw new Error(
        `persistSubmitTransition: payment ${id} is not in SUBMITTING — refusing to write`,
      );
    }
    return;
  }

  const data: Record<string, unknown> =
    transition.type === "failed"
      ? {
          status: "FAILED",
          errorMessage: transition.errorMessage,
          txSignature: null,
        }
      : transition.type === "parked"
        ? {
            status: "PARKED",
            errorMessage: transition.errorMessage,
            resolutionAttempts: { increment: 1 },
          }
        : {
            // resolution_failed: stays PENDING for the next tick.
            errorMessage: transition.errorMessage,
            resolutionAttempts: { increment: 1 },
          };

  await prisma.computePayment.updateMany({
    where: { id, status: "PENDING" },
    data,
  });
}
