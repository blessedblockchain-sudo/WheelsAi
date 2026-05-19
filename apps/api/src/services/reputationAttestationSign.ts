/**
 * Reputation attestation signing + verification (plan A4 second piece).
 *
 * Pure ed25519 wrappers around the canonical messageBytes that
 * reputationAttestation.ts produces. Together with that module, this gives
 * us the full off-chain attestation lifecycle:
 *
 *   compute → buildReputationAttestation → signAttestation → on-chain
 *                                                              ↓
 *   read on-chain payload + sig → verifyAttestationSignature → boolean
 *
 * The verifier MUST NOT throw on hostile input — return false. A verifier
 * that throws on malformed signatures becomes a DoS vector if a public
 * page calls it.
 */

import type { Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import type { ReputationAttestationPayload } from "./reputationAttestation.js";

const SIGNATURE_LENGTH = 64;

// ============================================
// signAttestation
// ============================================

export interface SignAttestationInput {
  messageBytes: Uint8Array;
  signerKeypair: Keypair;
}

export interface SignAttestationResult {
  signatureBytes: Uint8Array;
  signatureBase58: string;
}

export function signAttestation(
  input: SignAttestationInput,
): SignAttestationResult {
  const sig = nacl.sign.detached(input.messageBytes, input.signerKeypair.secretKey);
  return {
    signatureBytes: sig,
    signatureBase58: bs58.encode(sig),
  };
}

// ============================================
// verifyAttestationSignature
// ============================================

export interface VerifyAttestationInput {
  messageBytes: Uint8Array;
  signatureBase58: string;
  attesterPubkey: string;
}

export function verifyAttestationSignature(
  input: VerifyAttestationInput,
): boolean {
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = bs58.decode(input.signatureBase58);
  } catch {
    return false;
  }
  if (signatureBytes.length !== SIGNATURE_LENGTH) return false;

  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = new PublicKey(input.attesterPubkey).toBytes();
  } catch {
    return false;
  }

  try {
    return nacl.sign.detached.verify(
      input.messageBytes,
      signatureBytes,
      pubkeyBytes,
    );
  } catch {
    return false;
  }
}

// ============================================
// payloadToCanonicalBytes
// ============================================

/**
 * Re-derives the canonical bytes that the issuer signed, given a payload
 * read from chain. Mirrors the canonicalization in reputationAttestation.ts
 * (alphabetically sorted top-level keys, no whitespace, UTF-8) — must stay
 * byte-identical or verification breaks.
 *
 * No validation here: the issuer-side validation is the authoritative
 * gate. A malformed payload produces malformed bytes, verification then
 * fails — which is the right behavior.
 */
export function payloadToCanonicalBytes(
  payload: ReputationAttestationPayload,
): Uint8Array {
  const indexable = payload as unknown as Record<string, unknown>;
  const sortedKeys = Object.keys(indexable).sort();
  const canonical = `{${sortedKeys
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(indexable[k])}`)
    .join(",")}}`;
  return new TextEncoder().encode(canonical);
}
