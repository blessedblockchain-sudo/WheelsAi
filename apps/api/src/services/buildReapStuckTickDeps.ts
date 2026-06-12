/**
 * Full dep-wiring for the stuck-submission reaper BullMQ worker
 * (remediation D4: final chain check before failing).
 *
 * Composes:
 *   loadStuckCandidatesByPrisma     → loadStuckCandidates
 *   connection.getBlockHeight       → getCurrentBlockHeight
 *   connection.getSignatureStatuses → hasSignatureLanded
 *   persistReapTransition           → persistTransition
 *
 * The reaper now needs RPC: wall-clock age only selects WHICH rows to
 * examine; the FAIL decision requires (a) the chain head being past the
 * row's persisted lastValidBlockHeight and (b) a final signature-status
 * lookup (searchTransactionHistory) returning null. See runReapStuckTick.
 *
 * `maxAgeSeconds` is fixed at build time (Solana blockhash window
 * doesn't change). The driver receives the value via input as well
 * for defense-in-depth recomputation in the pure classifier.
 */

import type { PrismaClient } from "@prisma/client";
import type { Connection } from "@solana/web3.js";

import { loadStuckCandidatesByPrisma } from "./loadStuckCandidatesByPrisma.js";
import { persistReapTransition } from "./persistReapTransition.js";
import type { ReapStuckTickDeps } from "./runReapStuckTick.js";

type PrismaSurface = Pick<PrismaClient, "computePayment">;

export interface BuildReapStuckTickDepsInput {
  prisma: PrismaSurface;
  connection: Pick<Connection, "getBlockHeight" | "getSignatureStatuses">;
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

    getCurrentBlockHeight: async () =>
      BigInt(await input.connection.getBlockHeight("confirmed")),

    hasSignatureLanded: async (txSignature: string) => {
      const response = await input.connection.getSignatureStatuses(
        [txSignature],
        { searchTransactionHistory: true },
      );
      return response.value[0] != null;
    },

    persistTransition: (id: string, transition: { errorMessage: string }) =>
      persistReapTransition(id, transition, {
        prisma: input.prisma as never,
      }),
  };
}
