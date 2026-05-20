/**
 * Deterministic per-org creator Keypair derivation (plan A1 MVP).
 *
 * The pump.fun create flow needs a creator Keypair that signs the
 * `/api/trade-local` unsigned transaction. Two ways to source it:
 *
 *   1. Browser-side partial-sign (user holds the key in their wallet).
 *      This is the long-term direction — the user's wallet is the
 *      creator of record on-chain, matches their identity, no platform
 *      custody risk.
 *   2. Backend-derived deterministic keypair (this file).
 *
 * Phase 1C ships option 2 as the MVP: it unblocks the devnet smoke test
 * end-to-end without requiring frontend wallet-adapter plumbing for tx
 * signing. The "creator of record" on-chain is a platform-derived
 * pubkey per org; the user's identity is enforced at the DB layer via
 * the org owning the AgentListing → AgentToken row.
 *
 * Derivation: HKDF-SHA512 over WALLET_MASTER_KEY with the orgId as the
 * info parameter, expanding to 32 bytes used as the Ed25519 seed. This
 * mirrors services/treasuryKeypairs.ts so a single master-key rotation
 * moves both surfaces in lockstep (treasury + creator).
 *
 * Phase 1.5 (browser-partial-sign): add a parallel path that returns
 * an unsigned tx + ephemeral mint pubkey to the frontend, accepts the
 * creator-signed bytes back, adds the mint signature, and submits.
 */

import { hkdfSync } from "node:crypto";

import { Keypair } from "@solana/web3.js";

const SALT = Buffer.from("wheelsai-creator-v1", "utf8");
const MIN_MASTER_KEY_LENGTH = 32;

export interface DeriveCreatorKeypairInput {
  masterKey: string;
  orgId: string;
}

export function deriveCreatorKeypair(
  input: DeriveCreatorKeypairInput,
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

export interface CreatorSignerProviderConfig {
  masterKey: string;
}

export function makeCreatorSignerProvider(
  config: CreatorSignerProviderConfig,
): (orgId: string) => Keypair {
  const cache = new Map<string, Keypair>();
  return function creatorSignerFor(orgId: string): Keypair {
    const hit = cache.get(orgId);
    if (hit) return hit;
    const kp = deriveCreatorKeypair({
      masterKey: config.masterKey,
      orgId,
    });
    cache.set(orgId, kp);
    return kp;
  };
}
