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
 *
 * meteora works on devnet and mainnet and needs no key at all: only the
 * address of the platform's fee wallet (METEORA_FEE_CLAIMER_ADDRESS), which
 * config/env.ts already refuses to start without.
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { BagsSDK } from "@bagsfm/bags-sdk";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";

import { env } from "../../config/env.js";
import { getSolanaConnection } from "../../lib/solana.js";
import { createPumpfunAdapter } from "./pumpfunAdapter.js";
import { createBagsAdapter } from "./bagsAdapter.js";
import {
  createMeteoraAdapter,
  createMeteoraMetadataUploader,
} from "./meteoraAdapter.js";
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
    case "meteora": {
      if (!env.METEORA_FEE_CLAIMER_ADDRESS) {
        throw new Error(
          "LAUNCHPAD=meteora requires METEORA_FEE_CLAIMER_ADDRESS, the address " +
            "of the wallet that claims the platform's share of trading fees.",
        );
      }
      const feeClaimer = new PublicKey(env.METEORA_FEE_CLAIMER_ADDRESS);
      return createMeteoraAdapter({
        client: new DynamicBondingCurveClient(connection, "confirmed"),
        network: env.SOLANA_NETWORK,
        feeClaimer,
        // Unsold tokens go to the fee wallet unless another address is named.
        leftoverReceiver: env.METEORA_LEFTOVER_RECEIVER_ADDRESS
          ? new PublicKey(env.METEORA_LEFTOVER_RECEIVER_ADDRESS)
          : feeClaimer,
        uploadMetadata: createMeteoraMetadataUploader(fetch),
        getLatestBlockhash: () => connection.getLatestBlockhash("confirmed"),
        sendRawTransaction,
        confirmTransaction: async (signature, sentWith) => {
          const result = await connection.confirmTransaction(
            { signature, ...sentWith },
            "confirmed",
          );
          // Confirmed and failed is still failed: the pool does not exist.
          if (result.value.err) {
            throw new Error(
              `the transaction failed on chain: ${JSON.stringify(result.value.err)}`,
            );
          }
        },
      });
    }
    case "pumpfun":
    default:
      return createPumpfunAdapter({ fetchFn: fetch, sendRawTransaction });
  }
}
