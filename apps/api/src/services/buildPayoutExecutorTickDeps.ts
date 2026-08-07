/**
 * Composition root for the payout executor (W2 money keystone): binds the
 * pure runPayoutExecutorTick to real Prisma + Solana.
 *
 * Money invariants live in the settle functions (payoutExecutor.ts); this
 * file only wires them:
 *   - claim: CAS pending → processing (single-flight).
 *   - settleCredits / settleCrypto: the exactly-once settlers.
 *   - failAndRestore: mark failed AND restore pendingPayoutCents in one
 *     transaction — releasing the reservation requestPayout took.
 */

import type { PrismaClient } from "@prisma/client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  makeSettleCreditsPayout,
  settleCryptoPayout,
  type PayoutCreditsDb,
  type PayoutSettleResult,
} from "./payoutExecutor.js";
import type {
  ClaimablePayoutRow,
  PayoutExecutorTickDeps,
} from "./runPayoutExecutorTick.js";

export interface BuildPayoutExecutorDepsInput {
  prisma: PrismaClient;
  connection: Connection;
  /** Present only when crypto payouts are configured (WALLET_MASTER_KEY). */
  payoutWallet?: Keypair;
  solPriceUsd?: number;
  usdcMint: PublicKey;
}

export function buildPayoutExecutorTickDeps(
  input: BuildPayoutExecutorDepsInput,
): PayoutExecutorTickDeps {
  const { prisma } = input;
  const settleCreditsPayout = makeSettleCreditsPayout(
    prisma as unknown as PayoutCreditsDb,
  );

  return {
    loadClaimablePayouts: async ({ limit }) => {
      const rows = await prisma.creatorPayout.findMany({
        where: { status: { in: ["pending", "processing"] } },
        orderBy: { requestedAt: "asc" },
        take: limit,
      });
      return rows.map(
        (r): ClaimablePayoutRow => ({
          id: r.id,
          publisherId: r.publisherId,
          amountCents: r.amountCents,
          payoutMethod: r.payoutMethod,
          payoutAddress: r.payoutAddress,
          txSignature: r.txSignature,
          status: r.status,
        }),
      );
    },

    claim: async (payoutId) => {
      const res = await prisma.creatorPayout.updateMany({
        where: { id: payoutId, status: "pending" },
        data: { status: "processing" },
      });
      return res.count === 1;
    },

    settleCredits: (row) =>
      settleCreditsPayout({
        payoutId: row.id,
        publisherId: row.publisherId,
        amountCents: row.amountCents,
      }),

    settleCrypto: (row): Promise<PayoutSettleResult> => {
      if (!input.payoutWallet) {
        return Promise.resolve({
          outcome: "failed",
          reason: "crypto payouts not configured (no payout wallet)",
        });
      }
      return settleCryptoPayout(
        {
          id: row.id,
          publisherId: row.publisherId,
          amountCents: row.amountCents,
          payoutMethod: row.payoutMethod,
          payoutAddress: row.payoutAddress,
          txSignature: row.txSignature,
        },
        {
          connection: input.connection,
          payoutWallet: input.payoutWallet,
          solPriceUsd: input.solPriceUsd,
          usdcMint: input.usdcMint,
          recordSignature: async (payoutId, signature) => {
            try {
              const res = await prisma.creatorPayout.updateMany({
                // Only stamp a signature on a row that doesn't have one —
                // the guard against a second tick overwriting it.
                where: { id: payoutId, txSignature: null },
                data: { txSignature: signature },
              });
              return res.count === 1 ? "recorded" : "duplicate";
            } catch (err) {
              // The @unique on tx_signature fired: this signature already
              // belongs to another row. Treat as duplicate.
              if ((err as { code?: string }).code === "P2002") {
                return "duplicate";
              }
              throw err;
            }
          },
          markCompleted: async (payoutId) => {
            const res = await prisma.creatorPayout.updateMany({
              where: { id: payoutId, status: "processing" },
              data: { status: "completed", processedAt: new Date() },
            });
            return res.count === 1;
          },
        },
      );
    },

    failAndRestore: async (row, reason) => {
      await prisma.$transaction(async (tx) => {
        const failed = await tx.creatorPayout.updateMany({
          where: { id: row.id, status: { in: ["pending", "processing"] } },
          data: { status: "failed", failureReason: reason },
        });
        // Only restore the reservation if THIS call is the one that failed
        // the row — never double-credit pendingPayoutCents on a retry.
        if (failed.count === 1) {
          await tx.publisherProfile.update({
            where: { orgId: row.publisherId },
            data: { pendingPayoutCents: { increment: row.amountCents } },
          });
        }
      });
    },
  };
}
