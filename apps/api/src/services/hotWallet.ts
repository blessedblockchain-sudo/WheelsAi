/**
 * The platform's hot wallet: the one wallet the platform pays from.
 *
 * It is the payout wallet (services/payoutKeypair.ts), derived from
 * WALLET_MASTER_KEY and never stored. Creator payouts leave it, and so
 * does the small cost of opening an organization's USDC account
 * ("Prepare address").
 *
 * Two things only: its keypair, and a read of the SOL it holds.
 */

import type { Connection, Keypair } from "@solana/web3.js";

import { env } from "../config/env.js";
import { getSolanaConnection } from "../lib/solana.js";
import { derivePayoutKeypair } from "./payoutKeypair.js";

export interface HotWallet {
  /** Throws when WALLET_MASTER_KEY is missing or too short. */
  keypair: () => Keypair;
  /** Its address, base58. */
  address: () => string;
  /** The SOL it holds, in lamports. May throw: the node is asked. */
  readLamports: () => Promise<bigint>;
}

export function buildHotWallet(input: {
  masterKey: () => string | undefined;
  getConnection: () => Pick<Connection, "getBalance">;
}): HotWallet {
  const keypair = () => derivePayoutKeypair(input.masterKey() ?? "");
  return {
    keypair,
    address: () => keypair().publicKey.toBase58(),
    readLamports: async () => {
      const lamports = await input
        .getConnection()
        .getBalance(keypair().publicKey, "confirmed");
      if (typeof lamports !== "number" || !Number.isSafeInteger(lamports) || lamports < 0) {
        throw new Error("the node did not answer with a balance");
      }
      return BigInt(lamports);
    },
  };
}

/** Bound to WALLET_MASTER_KEY and the shared connection. */
export const hotWallet: HotWallet = buildHotWallet({
  masterKey: () => env.WALLET_MASTER_KEY,
  getConnection: () => getSolanaConnection(),
});

/** SOL as lamports, for a setting written in SOL (HOT_WALLET_MIN_SOL). */
export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol <= 0) return 0n;
  return BigInt(Math.round(sol * 1_000_000_000));
}
