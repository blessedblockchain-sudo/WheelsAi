/**
 * Build the SignatureFateDeps for services/signatureFate.ts from a real
 * Connection and the settings.
 *
 * Three RPC details the proof in signatureFate.ts leans on:
 *
 *   1. getEpochInfo("finalized") gives the finalized slot AND block
 *      height from one bank in one call. Two separate calls could come
 *      from two moments (or two nodes behind a load balancer).
 *
 *   2. getSignatureStatuses with searchTransactionHistory: true. Without
 *      it a node only answers from its recent cache (about 150 slots),
 *      and "absent" would mean "old", not "never landed". The context
 *      slot of the answer is the slot of the node that gave it.
 *
 *   3. isBlockhashValid at "finalized", with its context slot.
 *
 * Some providers leave confirmationStatus out. Then `confirmations:
 * null` is the RPC's way of saying the transaction is rooted, which is
 * finalized; anything else with no level is passed on as null and the
 * core treats it as not yet confirmed.
 *
 * The margin is env.CHAIN_EXPIRY_MARGIN_BLOCKS unless one is given.
 */

import type { Connection } from "@solana/web3.js";

import { env } from "../config/env.js";
import { getSolanaConnection } from "../lib/solana.js";
import {
  signatureFate,
  type SignatureConfirmationLevel,
  type SignatureFateAnswer,
  type SignatureFateDeps,
  type SignatureFateInput,
} from "./signatureFate.js";

type ConnectionLike = Pick<
  Connection,
  "getEpochInfo" | "getSignatureStatuses" | "isBlockhashValid"
>;

export interface BuildSignatureFateDepsInput {
  connection: ConnectionLike;
  /** Defaults to env.CHAIN_EXPIRY_MARGIN_BLOCKS. */
  marginBlocks?: number;
}

export function buildSignatureFateDeps(
  input: BuildSignatureFateDepsInput,
): SignatureFateDeps {
  const { connection } = input;
  return {
    marginBlocks: input.marginBlocks ?? env.CHAIN_EXPIRY_MARGIN_BLOCKS,

    getFinalizedPosition: async () => {
      const info = await connection.getEpochInfo("finalized");
      if (typeof info.blockHeight !== "number") {
        // An old node that does not report it. No height, no proof.
        throw new Error("getEpochInfo gave no blockHeight");
      }
      return { slot: info.absoluteSlot, blockHeight: info.blockHeight };
    },

    getSignatureStatus: async (signature: string) => {
      const response = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const contextSlot = response.context.slot;
      // One signature asked, one entry back. null is the node saying it
      // has no record; a missing entry is a broken answer, and a throw
      // here is "unknown" in the core, never "absent".
      if (!Array.isArray(response.value) || response.value.length !== 1) {
        throw new Error("getSignatureStatuses gave no entry for the signature");
      }
      const entry = response.value[0];
      if (entry === undefined) {
        throw new Error("getSignatureStatuses gave no entry for the signature");
      }
      if (entry === null) return { status: null, contextSlot };
      const confirmationStatus: SignatureConfirmationLevel =
        entry.confirmationStatus ??
        (entry.confirmations === null ? "finalized" : null);
      return {
        status: {
          confirmationStatus,
          err: entry.err ?? null,
          slot: entry.slot ?? null,
        },
        contextSlot,
      };
    },

    isBlockhashValid: async (blockhash: string) => {
      const response = await connection.isBlockhashValid(blockhash, {
        commitment: "finalized",
      });
      return { valid: response.value, contextSlot: response.context.slot };
    },
  };
}

/** signatureFate bound to the shared connection and the settings. Like
 * the core, it never throws: a connection that cannot be built is a
 * failed first read, so the answer is "unknown". */
export async function readSignatureFate(
  input: SignatureFateInput,
): Promise<SignatureFateAnswer> {
  let deps: SignatureFateDeps;
  try {
    deps = buildSignatureFateDeps({ connection: getSolanaConnection() });
  } catch (err) {
    deps = {
      marginBlocks: env.CHAIN_EXPIRY_MARGIN_BLOCKS,
      getFinalizedPosition: async () => {
        throw err;
      },
      getSignatureStatus: async () => {
        throw err;
      },
    };
  }
  return signatureFate(input, deps);
}
