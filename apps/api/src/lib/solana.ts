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
 *
 * The endpoint is SOLANA_RPC_URL on every network. Its default lives in
 * config/env.ts, which also refuses mainnet-beta with a devnet URL.
 */

import { Connection } from "@solana/web3.js";

import { env } from "../config/env.js";

export { MEMO_PROGRAM_ID } from "./memoProgram.js";

let instance: Connection | null = null;

export function getSolanaConnection(): Connection {
  if (!instance) {
    instance = new Connection(env.SOLANA_RPC_URL, "confirmed");
  }
  return instance;
}

// ============================================
// Cluster check
// ============================================

// The genesis hash names the chain a node serves. An RPC URL is only a
// setting: it can point at the wrong cluster while SOLANA_NETWORK says
// otherwise, and money would then move (or be believed to have moved) on
// a chain nobody meant.
export const GENESIS_HASHES = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
} as const;

export type ClusterCheckResult =
  | { ok: true }
  | { ok: false; reason: "wrong_cluster" | "unreachable" };

export interface ClusterCheckDeps {
  /** Reads the genesis hash of the node behind the connection. */
  getGenesisHash: () => Promise<string>;
  network: "devnet" | "mainnet-beta";
  nodeEnv: "development" | "staging" | "production";
}

/**
 * Pure core: one read of the node's genesis hash, compared with the hash
 * for the configured network. Any other hash passes only in development
 * on devnet, where the node is a local validator with a genesis of its
 * own, and even there the hash of mainnet-beta is refused: that is a real
 * chain behind a devnet setting. Never throws: a failed read is
 * "unreachable", which says nothing about which cluster the node serves.
 */
export async function checkSolanaCluster(deps: ClusterCheckDeps): Promise<ClusterCheckResult> {
  let genesisHash: string;
  try {
    genesisHash = await deps.getGenesisHash();
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (typeof genesisHash !== "string" || genesisHash.length === 0) {
    return { ok: false, reason: "unreachable" };
  }
  if (genesisHash === GENESIS_HASHES[deps.network]) return { ok: true };
  // The hash of the other named cluster is never a local validator: it
  // is SOLANA_RPC_URL pointing at the wrong chain, in development too.
  if (Object.values<string>(GENESIS_HASHES).includes(genesisHash)) {
    return { ok: false, reason: "wrong_cluster" };
  }
  if (deps.nodeEnv === "development" && deps.network === "devnet") return { ok: true };
  return { ok: false, reason: "wrong_cluster" };
}

/**
 * Wraps a check so a good answer is remembered for the life of the
 * process and a bad or failed one is asked again next time. Calls that
 * arrive while a read is in flight share it.
 */
export function createClusterCheck(deps: ClusterCheckDeps): {
  check: () => Promise<ClusterCheckResult>;
  reset: () => void;
} {
  let confirmed = false;
  let inFlight: Promise<ClusterCheckResult> | null = null;
  // Bumped by reset, so a read that started before it cannot mark the
  // check as confirmed after it.
  let generation = 0;

  return {
    check: () => {
      if (confirmed) return Promise.resolve({ ok: true });
      if (inFlight) return inFlight;
      const startedIn = generation;
      const pending: Promise<ClusterCheckResult> = checkSolanaCluster(deps)
        .then((result) => {
          if (result.ok && startedIn === generation) confirmed = true;
          return result;
        })
        .finally(() => {
          if (inFlight === pending) inFlight = null;
        });
      inFlight = pending;
      return pending;
    },
    reset: () => {
      generation += 1;
      confirmed = false;
      inFlight = null;
    },
  };
}

let boundClusterCheck: ReturnType<typeof createClusterCheck> | null = null;

/**
 * Bound form: is the node behind SOLANA_RPC_URL on the cluster that
 * SOLANA_NETWORK names? Call it before money moves and refuse on anything
 * but `{ ok: true }`.
 */
export function ensureSolanaCluster(): Promise<ClusterCheckResult> {
  if (!boundClusterCheck) {
    boundClusterCheck = createClusterCheck({
      getGenesisHash: () => getSolanaConnection().getGenesisHash(),
      network: env.SOLANA_NETWORK,
      nodeEnv: env.NODE_ENV,
    });
  }
  return boundClusterCheck.check();
}

/** Tests only: forget the remembered answer of the bound check. */
export function resetSolanaClusterCheckForTests(): void {
  boundClusterCheck?.reset();
  boundClusterCheck = null;
}
