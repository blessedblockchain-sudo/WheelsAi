/**
 * Deterministic treasury Keypair derivation.
 *
 * Until the agent-treasury Anchor program (plan A2) ships, the platform
 * holds the treasury signing keys — one per `AgentTreasury` row. Two
 * options for "where do we keep that secret":
 *
 *   1. Store an encrypted secret blob per row.
 *   2. Derive the keypair from a single master secret + the row's id.
 *
 * Option 2 wins for now: no extra DB column, no cross-row blast radius
 * if a single row leaks (you'd need the master key), and pure
 * determinism makes the worker process stateless. The cost is rotation
 * — if `WALLET_MASTER_KEY` rotates, every treasury PDA changes. We
 * accept that because A2 is the long-term plan; the master-key signer
 * is explicitly an interim implementation.
 *
 * Derivation: HKDF-SHA512 over the master key, with the treasuryId as
 * the info parameter, expanding to 32 bytes which we use as the
 * Ed25519 seed via `Keypair.fromSeed`. HKDF + a per-row info parameter
 * is the standard pattern (RFC 5869 §3.3) — different treasuryIds
 * collide only if SHA-512 collides.
 */

import { hkdfSync } from "node:crypto";

import { Keypair } from "@solana/web3.js";

const SALT = Buffer.from("wheelsai-treasury-v1", "utf8");
const MIN_MASTER_KEY_LENGTH = 32;

export interface DeriveTreasuryKeypairInput {
  masterKey: string;
  treasuryId: string;
}

export function deriveTreasuryKeypair(
  input: DeriveTreasuryKeypairInput,
): Keypair {
  if (!input.masterKey || input.masterKey.length === 0) {
    throw new Error("WALLET_MASTER_KEY required (empty or missing)");
  }
  if (input.masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `WALLET_MASTER_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters`,
    );
  }
  if (!input.treasuryId || input.treasuryId.length === 0) {
    throw new Error("treasuryId required (empty)");
  }

  const ikm = Buffer.from(input.masterKey, "utf8");
  const info = Buffer.from(input.treasuryId, "utf8");
  // hkdfSync returns ArrayBuffer; wrap in Uint8Array for Keypair.fromSeed.
  const seed = new Uint8Array(hkdfSync("sha512", ikm, SALT, info, 32));
  return Keypair.fromSeed(seed);
}

// ----------------------------------------------------------------------
// makeTreasurySignerProvider
// ----------------------------------------------------------------------

export interface TreasurySignerProviderConfig {
  masterKey: string;
}

/**
 * Returns a sync `treasurySignerFor(treasuryId)` suitable for the
 * payment-submit BullMQ deps. Cached per-process: HKDF + Ed25519
 * derivation is fast but it runs once per payment row and caching
 * keeps the hot path branch-free.
 */
export function makeTreasurySignerProvider(
  config: TreasurySignerProviderConfig,
): (treasuryId: string) => Keypair {
  const cache = new Map<string, Keypair>();
  return function treasurySignerFor(treasuryId: string): Keypair {
    const hit = cache.get(treasuryId);
    if (hit) return hit;
    const kp = deriveTreasuryKeypair({
      masterKey: config.masterKey,
      treasuryId,
    });
    cache.set(treasuryId, kp);
    return kp;
  };
}
