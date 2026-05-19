/**
 * Full dep-wiring for the stuck-submission reaper BullMQ worker.
 *
 * Composes:
 *   loadStuckCandidatesByPrisma → loadStuckCandidates
 *   persistReapTransition       → persistTransition
 *
 * No RPC needed — the reaper is pure-classifier-plus-DB-write.
 *
 * `maxAgeSeconds` is fixed at build time (Solana blockhash window
 * doesn't change). The driver receives the value via input as well
 * for defense-in-depth recomputation in the pure classifier.
 */

import type { PrismaClient } from "@prisma/client";

import { loadStuckCandidatesByPrisma } from "./loadStuckCandidatesByPrisma.js";
import { persistReapTransition } from "./persistReapTransition.js";
import type { ReapStuckTickDeps } from "./runReapStuckTick.js";

type PrismaSurface = Pick<PrismaClient, "computePayment">;

export interface BuildReapStuckTickDepsInput {
  prisma: PrismaSurface;
  batchLimit: number;
  maxAgeSeconds: number;
}

export function buildReapStuckTickDeps(
  input: BuildReapStuckTickDepsInput,
): ReapStuckTickDeps {
  return {
    loadStuckCandidates: ({ now }) =>
      loadStuckCandidatesByPrisma(
        {
          now,
          maxAgeSeconds: input.maxAgeSeconds,
          limit: input.batchLimit,
        },
        { prisma: input.prisma as never },
      ),

    persistTransition: (id: string, transition: { errorMessage: string }) =>
      persistReapTransition(id, transition, {
        prisma: input.prisma as never,
      }),
  };
}
