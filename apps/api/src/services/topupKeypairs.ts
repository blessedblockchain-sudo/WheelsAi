/**
 * Deterministic per-org deposit Keypair derivation for the wallet
 * top-up rail (B2/T5).
 *
 * Every org gets its own deposit address, derived from
 * WALLET_MASTER_KEY with the orgId as the HKDF info parameter — the
 * same construction as treasuryKeypairs.ts / creatorKeypairs.ts, under
 * a distinct salt so the three key families can never collide even for
 * equal info strings.
 *
 * Why per-org addresses instead of one platform inbox:
 *   - On-chain attribution by address alone: any transfer landing on
 *     the address belongs to that org, even one made outside the
 *     prepared-tx flow (reconciliation stays unambiguous).
 *   - No cross-org blast radius if a single address is doxxed.
 *   - Funds are never stranded: the private key is re-derivable from
 *     the master key, so sweeping deposits to the platform treasury is
 *     an ops job, not a schema change.
 */

import { hkdfSync } from "node:crypto";

import { Keypair } from "@solana/web3.js";

const SALT = Buffer.from("wheelsai-topup-v1", "utf8");
const MIN_MASTER_KEY_LENGTH = 32;

export interface DeriveTopupKeypairInput {
  masterKey: string;
  orgId: string;
}

export function deriveTopupDepositKeypair(
  input: DeriveTopupKeypairInput,
): Keypair {
  if (!input.masterKey || input.masterKey.length === 0) {
    throw new Error("WALLET_MASTER_KEY required (empty or missing)");
  }
  if (input.masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `WALLET_MASTER_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters`,
    );
  }
  if (!input.orgId || input.orgId.length === 0) {
    throw new Error("orgId required (empty)");
  }

  const ikm = Buffer.from(input.masterKey, "utf8");
  const info = Buffer.from(input.orgId, "utf8");
  const seed = new Uint8Array(hkdfSync("sha512", ikm, SALT, info, 32));
  return Keypair.fromSeed(seed);
}
