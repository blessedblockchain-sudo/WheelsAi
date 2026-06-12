/**
 * Launchpad adapter selection.
 *
 * getLaunchpadAdapter() returns the adapter named by env.LAUNCHPAD,
 * wired with its concrete transport (RPC, fetch, API key). This is the
 * single place adapter construction lives — routes depend on the
 * LaunchpadAdapter interface, never on a concrete launchpad.
 *
 * pump.fun (default) works everywhere. bags is mainnet-only and gated by
 * BAGS_ADAPTER_IMPLEMENTED (the boot guard in src/index.ts refuses
 * LAUNCHPAD=bags until the spike validates it), so this branch only runs
 * post-spike. It requires BAGS_API_KEY + FEE_ROUTER_WALLET_PRIVATE_KEY
 * (the platform fee wallet that signs the config + receives the fee share).
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { BagsSDK } from "@bagsfm/bags-sdk";

import { env } from "../../config/env.js";
import { getSolanaConnection } from "../../lib/solana.js";
import { createPumpfunAdapter } from "./pumpfunAdapter.js";
import { createBagsAdapter } from "./bagsAdapter.js";
import type { LaunchpadAdapter } from "./types.js";

export type { LaunchpadAdapter } from "./types.js";

function loadFeeRouterKeypair(): Keypair {
  const raw = env.FEE_ROUTER_WALLET_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      "LAUNCHPAD=bags requires FEE_ROUTER_WALLET_PRIVATE_KEY — the platform " +
        "wallet that signs the fee-share config and receives the fee share " +
        "(swept into the treasury PDA).",
    );
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch (err) {
    throw new Error(
      `FEE_ROUTER_WALLET_PRIVATE_KEY is set but invalid JSON (${(err as Error).message})`,
    );
  }
}

export function getLaunchpadAdapter(): LaunchpadAdapter {
  const connection = getSolanaConnection();
  const sendRawTransaction = (raw: Uint8Array) =>
    connection.sendRawTransaction(raw, { skipPreflight: false });

  switch (env.LAUNCHPAD) {
    case "bags": {
      if (!env.BAGS_API_KEY) {
        throw new Error(
          "LAUNCHPAD=bags requires BAGS_API_KEY (get one at bags.fm).",
        );
      }
      // The fee claimer + config payer is the fee-router wallet (the sweep
      // holds its key to claim Meteora fees). BAGS_FEE_RECIPIENT is an
      // optional override for the claimer only — never falls back to
      // TREASURY_WALLET_ADDRESS (its all-ones default would make fees
      // permanently unclaimable).
      const configPayer = loadFeeRouterKeypair();
      const feeClaimerPubkey = env.BAGS_FEE_RECIPIENT
        ? new PublicKey(env.BAGS_FEE_RECIPIENT)
        : configPayer.publicKey;
      return createBagsAdapter({
        sdk: new BagsSDK(env.BAGS_API_KEY, connection, "confirmed"),
        configPayer,
        feeClaimerPubkey,
        sendRawTransaction,
        confirmTransaction: async (signature: string) => {
          await connection.confirmTransaction(signature, "confirmed");
        },
      });
    }
    case "pumpfun":
    default:
      return createPumpfunAdapter({ fetchFn: fetch, sendRawTransaction });
  }
}
