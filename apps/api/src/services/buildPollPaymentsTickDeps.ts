/**
 * Full dep-wiring for the poll-confirmation BullMQ worker.
 *
 * Composes:
 *   loadSubmittedPaymentsByPrisma        → loadSubmittedBatch
 *   pollComputePaymentConfirmation + RPC → pollOne (with outcome
 *                                          translation)
 *   persistPollTransition                → persistTransition
 *
 * Outcome translation: the orchestrator returns `{ payment, changed }`
 * where `payment` is the post-transition state. We translate to the
 * driver-level shape:
 *   - changed && status === CONFIRMED → { type: 'confirmed' }
 *   - changed && status === FAILED    → { type: 'failed', errorMessage }
 *   - !changed                        → { type: 'unchanged' }
 *
 * The errorMessage on FAILED carries the RPC `err` payload stringified
 * by the orchestrator (formatErr inside pollComputePaymentConfirmation).
 */

import type { PrismaClient } from "@prisma/client";
import type { Connection } from "@solana/web3.js";

import { buildPollComputePaymentConfirmationDeps } from "./buildPollComputePaymentConfirmationDeps.js";
import { loadSubmittedPaymentsByPrisma } from "./loadSubmittedPaymentsByPrisma.js";
import { persistPollTransition } from "./persistPollTransition.js";
import { pollComputePaymentConfirmation } from "./pollComputePaymentConfirmation.js";
import type {
  PollOutcome,
  PollPaymentsTickDeps,
  SubmittedPaymentRow,
} from "./runPollPaymentsTick.js";

type PrismaSurface = Pick<PrismaClient, "computePayment">;

export interface BuildPollPaymentsTickDepsInput {
  prisma: PrismaSurface;
  connection: Pick<Connection, "getSignatureStatuses">;
  batchLimit: number;
  now: () => Date;
}

export function buildPollPaymentsTickDeps(
  input: BuildPollPaymentsTickDepsInput,
): PollPaymentsTickDeps {
  const orchestratorDeps = buildPollComputePaymentConfirmationDeps({
    connection: input.connection,
  });

  return {
    loadSubmittedBatch: async () =>
      loadSubmittedPaymentsByPrisma(
        { limit: input.batchLimit },
        { prisma: input.prisma as never },
      ),

    pollOne: async (row: SubmittedPaymentRow): Promise<PollOutcome> => {
      const { payment, changed } = await pollComputePaymentConfirmation(
        {
          payment: {
            id: row.id,
            status: "SUBMITTED",
            txSignature: row.txSignature,
            errorMessage: null,
            paidAt: null,
            retryCount: 0,
          },
        },
        orchestratorDeps,
      );

      if (!changed) return { type: "unchanged" };
      if (payment.status === "CONFIRMED") return { type: "confirmed" };
      // FAILED is the only other state changed can transition to.
      return {
        type: "failed",
        errorMessage: payment.errorMessage ?? "unknown",
      };
    },

    persistTransition: async (id: string, outcome: PollOutcome) =>
      persistPollTransition(id, outcome, {
        prisma: input.prisma as never,
        now: input.now(),
      }),
  };
}
