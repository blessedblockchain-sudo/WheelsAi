/**
 * Singleton Solana RPC connection for the BullMQ workers.
 *
 * The treasury-payment + token-indexer workers all need a Connection;
 * sharing one instance keeps RPC quotas predictable and avoids the
 * per-worker construction cost.
 *
 * Commitment: "confirmed" — the same level used by prepareTreasuryPayment
 * for blockhash fetches and the poll worker for sig status. processed
 * is too racy; finalized adds latency without buying us anything.
 */

import { Connection } from "@solana/web3.js";

import { env } from "../config/env.js";

let instance: Connection | null = null;

export function getSolanaConnection(): Connection {
  if (!instance) {
    const endpoint =
      env.SOLANA_NETWORK === "mainnet-beta"
        ? env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
        : "https://api.devnet.solana.com";
    instance = new Connection(endpoint, "confirmed");
  }
  return instance;
}
