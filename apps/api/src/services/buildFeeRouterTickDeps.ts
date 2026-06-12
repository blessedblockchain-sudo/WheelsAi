/**
 * Full dep-wiring for the fee-router BullMQ worker — row-identity
 * routing + confirmation discipline (remediation D6a).
 *
 * Composes:
 *   recovery (phase 0):
 *     loadStaleFeeBatchesByPrisma     → loadStaleBatches
 *     connection.getBlockHeight       → getCurrentBlockHeight
 *     connection.getSignatureStatuses → getSignatureStatus
 *     persistFeeBatchTransition       → persistBatchConfirmed/Failed
 *
 *   route (phase 1):
 *     loadUnroutedFeesByPrisma        → loadUnrouted (row identity)
 *     claimFeeRoutingBatch            → claimBatch
 *     prepareFeeReceive               → sign (sign-only, NO broadcast)
 *     persistFeeBatchTransition       → markSubmitted (CAS + artifacts)
 *     connection.sendRawTransaction   → broadcast (shared with recovery)
 *     awaitSignatureConfirmation      → confirmSignature (best-effort
 *                                       same-tick poll, short timeout)
 *     persistFeeRouterCursor          → persistCursor (display only)
 *
 * The router keypair is the platform-held wallet that funds fee
 * deposits to each agent's treasury. Production wiring loads this
 * from FEE_ROUTER_WALLET_PRIVATE_KEY (see queues/fee-router.queue.ts).
 *
 * Confirmation budget: confirmTimeoutMs (default 8s, poll every 1s) is
 * deliberately short — the tick interval is the real retry loop, and
 * anything unconfirmed stays SUBMITTED for the next recovery scan.
 */

import type { PrismaClient } from "@prisma/client";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";

import { awaitSignatureConfirmation } from "./awaitSignatureConfirmation.js";
import { claimFeeRoutingBatch } from "./claimFeeRoutingBatch.js";
import { loadStaleFeeBatchesByPrisma } from "./loadStaleFeeBatchesByPrisma.js";
import { loadUnroutedFeesByPrisma } from "./loadUnroutedFeesByPrisma.js";
import { persistFeeBatchTransition } from "./persistFeeBatchTransition.js";
import { persistFeeRouterCursor } from "./persistFeeRouterCursor.js";
import { prepareFeeReceive } from "./prepareFeeReceive.js";
import type { FeeRouterTickDeps } from "./runFeeRouterTick.js";

type PrismaSurface = Pick<
  PrismaClient,
  "agentTreasury" | "agentTokenTrade" | "feeRoutingBatch" | "$transaction"
>;

const DEFAULT_CONFIRM_TIMEOUT_MS = 8_000;
const DEFAULT_CONFIRM_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STALE_BATCH_LIMIT = 100;

export interface BuildFeeRouterTickDepsInput {
  prisma: PrismaSurface;
  connection: Pick<
    Connection,
    | "getLatestBlockhash"
    | "sendRawTransaction"
    | "getSignatureStatuses"
    | "getBlockHeight"
  >;
  /** Platform fee-router keypair; signs every fee_receive deposit. */
  routerKeypair: Keypair;
  /** Max trades claimed per treasury per tick (default 500). */
  tradeBatchLimit?: number;
  /** Same-tick confirmation budget (default 8s; <=0 = single check). */
  confirmTimeoutMs?: number;
  confirmPollIntervalMs?: number;
  /** Age before an artifact-less CLAIMED batch is reaped (default 5m). */
  claimedGraceMs?: number;
}

export function buildFeeRouterTickDeps(
  input: BuildFeeRouterTickDepsInput,
): FeeRouterTickDeps {
  const getSignatureStatus = async (txSignature: string) => {
    const response = await input.connection.getSignatureStatuses(
      [txSignature],
      { searchTransactionHistory: true },
    );
    const value = response.value[0];
    if (!value) return null;
    return {
      confirmationStatus: value.confirmationStatus ?? null,
      err: value.err,
    };
  };

  return {
    // ---------- phase 0: recovery ----------

    loadStaleBatches: ({ now }) =>
      loadStaleFeeBatchesByPrisma(
        {
          now,
          limit: DEFAULT_STALE_BATCH_LIMIT,
          claimedGraceMs: input.claimedGraceMs,
        },
        { prisma: input.prisma as never },
      ),

    getCurrentBlockHeight: async () =>
      BigInt(await input.connection.getBlockHeight("confirmed")),

    getSignatureStatus,

    broadcast: async (signedTxB64: string) => {
      const raw = new Uint8Array(Buffer.from(signedTxB64, "base64"));
      await input.connection.sendRawTransaction(raw);
    },

    persistBatchConfirmed: async (batchId: string) => {
      await persistFeeBatchTransition(
        batchId,
        { type: "confirmed" },
        { prisma: input.prisma as never },
      );
    },

    persistBatchFailed: async (batchId: string) => {
      await persistFeeBatchTransition(
        batchId,
        { type: "failed" },
        { prisma: input.prisma as never },
      );
    },

    // ---------- phase 1: route ----------

    loadUnrouted: ({ now }) =>
      loadUnroutedFeesByPrisma(
        { now, limit: input.tradeBatchLimit },
        { prisma: input.prisma as never },
      ),

    claimBatch: (row) =>
      claimFeeRoutingBatch(
        {
          treasuryId: row.treasuryId,
          tradeIds: row.tradeIds,
          feeAmountLamports: row.feeAmountLamports,
        },
        { prisma: input.prisma as never },
      ),

    sign: (row) =>
      prepareFeeReceive(
        {
          mint: new PublicKey(row.mintAddress),
          from: input.routerKeypair.publicKey,
          amountLamports: row.feeAmountLamports,
        },
        {
          fromKeypair: input.routerKeypair,
          fetchLatestBlockhash: async () => {
            const r = await input.connection.getLatestBlockhash("confirmed");
            return {
              blockhash: r.blockhash,
              lastValidBlockHeight: r.lastValidBlockHeight,
            };
          },
        },
      ),

    markSubmitted: (batchId, artifact) =>
      persistFeeBatchTransition(
        batchId,
        { type: "submitted", artifact },
        { prisma: input.prisma as never },
      ),

    confirmSignature: (txSignature) =>
      awaitSignatureConfirmation(txSignature, {
        getSignatureStatus,
        timeoutMs: input.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
        pollIntervalMs:
          input.confirmPollIntervalMs ?? DEFAULT_CONFIRM_POLL_INTERVAL_MS,
      }),

    persistCursor: (treasuryId, cursor) =>
      persistFeeRouterCursor(treasuryId, cursor, {
        prisma: input.prisma as never,
      }),
  };
}
