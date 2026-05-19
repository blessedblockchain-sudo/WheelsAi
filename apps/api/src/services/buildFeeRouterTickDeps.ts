/**
 * Full dep-wiring for the fee-router BullMQ worker.
 *
 * Composes:
 *   loadUnroutedFeesByPrisma       → loadUnrouted
 *   submitFeeReceive + RPC         → submit
 *   persistFeeRouterCursor         → persistCursor
 *
 * The router keypair is the platform-held wallet that funds fee
 * deposits to each agent's treasury. Production wiring loads this
 * from the same `WALLET_MASTER_KEY` derivation already used for
 * treasury signers, with a fixed seed (e.g. "fee-router") so the
 * keypair is deterministic across restarts.
 */

import type { PrismaClient } from "@prisma/client";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";

import { loadUnroutedFeesByPrisma } from "./loadUnroutedFeesByPrisma.js";
import { persistFeeRouterCursor } from "./persistFeeRouterCursor.js";
import {
  submitFeeReceive,
  type SubmitFeeReceiveDeps,
} from "./submitFeeReceive.js";
import type {
  FeeReceiveOutcome,
  FeeRouterTickDeps,
} from "./runFeeRouterTick.js";

type PrismaSurface = Pick<
  PrismaClient,
  "agentTreasury" | "agentTokenTrade"
>;

export interface BuildFeeRouterTickDepsInput {
  prisma: PrismaSurface;
  connection: Pick<
    Connection,
    "getLatestBlockhash" | "sendRawTransaction"
  >;
  /** Platform fee-router keypair; signs every fee_receive deposit. */
  routerKeypair: Keypair;
}

function buildSubmitDeps(
  input: BuildFeeRouterTickDepsInput,
): SubmitFeeReceiveDeps {
  return {
    fromKeypair: input.routerKeypair,
    fetchLatestBlockhash: async () => {
      const r = await input.connection.getLatestBlockhash("confirmed");
      return {
        blockhash: r.blockhash,
        lastValidBlockHeight: r.lastValidBlockHeight,
      };
    },
    sendRawTransaction: (raw: Uint8Array) =>
      input.connection.sendRawTransaction(raw),
  };
}

export function buildFeeRouterTickDeps(
  input: BuildFeeRouterTickDepsInput,
): FeeRouterTickDeps {
  return {
    loadUnrouted: ({ now }) =>
      loadUnroutedFeesByPrisma(
        { now },
        { prisma: input.prisma as never },
      ),

    submit: async (row): Promise<FeeReceiveOutcome> => {
      try {
        const result = await submitFeeReceive(
          {
            mint: new PublicKey(row.mintAddress),
            from: input.routerKeypair.publicKey,
            amountLamports: row.feeAmountLamports,
          },
          buildSubmitDeps(input),
        );
        return { ok: true, txSignature: result.txSignature };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err) };
      }
    },

    persistCursor: (treasuryId, cursor) =>
      persistFeeRouterCursor(treasuryId, cursor, {
        prisma: input.prisma as never,
      }),
  };
}
