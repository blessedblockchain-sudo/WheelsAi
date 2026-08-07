/**
 * The single platform payout wallet (W2 money keystone).
 *
 * Creator payouts flow OUT from the platform to publisher wallets, so —
 * unlike treasury/deposit keys, which are per-row — there is ONE payout
 * wallet, derived deterministically from WALLET_MASTER_KEY under its own
 * salt. Deriving (rather than storing a raw secret) keeps the worker
 * stateless and means the wallet is always re-derivable to sweep or
 * re-fund; the distinct salt guarantees it can never collide with the
 * treasury/creator/deposit key families even though the info string is
 * fixed.
 *
 * This wallet must be funded by the operator (SOL for fees + payout
 * amounts, or a USDC ATA) — its address is logged at boot when payouts
 * are enabled so the operator knows where to send funds.
 */

import { hkdfSync } from "node:crypto";

import { Keypair } from "@solana/web3.js";

const SALT = Buffer.from("wheelsai-payout-v1", "utf8");
const INFO = Buffer.from("platform-payout", "utf8");
const MIN_MASTER_KEY_LENGTH = 32;

export function derivePayoutKeypair(masterKey: string): Keypair {
  if (!masterKey || masterKey.length === 0) {
    throw new Error("WALLET_MASTER_KEY required (empty or missing)");
  }
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `WALLET_MASTER_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters`,
    );
  }
  const ikm = Buffer.from(masterKey, "utf8");
  const seed = new Uint8Array(hkdfSync("sha512", ikm, SALT, INFO, 32));
  return Keypair.fromSeed(seed);
}
