/**
 * Reputation attestation builder (plan A4 first piece).
 *
 * Pure construction of an on-chain attestation payload + the canonical
 * UTF-8 bytes that the attester signs and the verifier reproduces from
 * the on-chain row. Once the Solana program ships, the same builder is
 * used by both: the publisher signs `messageBytes`, posts the payload
 * on-chain; downstream readers (token launchpad, public transparency
 * page) recompute `messageBytes` from the on-chain payload and verify
 * the signature.
 *
 * Canonicalization: alphabetically sorted top-level JSON keys, no
 * whitespace, UTF-8. This guarantees a verifier's bytes are byte-
 * identical to the signer's regardless of upstream object-literal order.
 */

import { PublicKey } from "@solana/web3.js";

const SCHEMA_ID = "wheelsai.attestation.v1";

export interface ReputationAttestationInput {
  agentId: string;
  agentSlug: string;
  periodStart: Date;
  periodEnd: Date;
  uptimeSeconds: number;
  totalRequestCount: number;
  errorCount: number;
  reputationScore: number;
  attesterPubkey: string;
  issuedAt: Date;
}

export interface ReputationAttestationPayload {
  agentId: string;
  agentSlug: string;
  attester: string;
  errorCount: number;
  issuedAt: string;
  periodEnd: string;
  periodStart: string;
  reputationScore: number;
  schema: typeof SCHEMA_ID;
  totalRequestCount: number;
  uptimeSeconds: number;
}

export interface ReputationAttestationResult {
  payload: ReputationAttestationPayload;
  messageBytes: Uint8Array;
}

function validateNonNegative(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number, got ${value}`);
  }
}

export function buildReputationAttestation(
  input: ReputationAttestationInput,
): ReputationAttestationResult {
  if (!input.agentId || input.agentId.length === 0) {
    throw new Error("buildReputationAttestation: agentId is required");
  }
  if (!input.agentSlug || input.agentSlug.length === 0) {
    throw new Error("buildReputationAttestation: agentSlug is required");
  }
  if (input.periodEnd.getTime() <= input.periodStart.getTime()) {
    throw new Error(
      "buildReputationAttestation: periodEnd must be strictly after periodStart",
    );
  }
  validateNonNegative("uptimeSeconds", input.uptimeSeconds);
  validateNonNegative("totalRequestCount", input.totalRequestCount);
  validateNonNegative("errorCount", input.errorCount);
  if (
    !Number.isFinite(input.reputationScore) ||
    input.reputationScore < 0 ||
    input.reputationScore > 100
  ) {
    throw new Error(
      `buildReputationAttestation: reputationScore must be in [0, 100], got ${input.reputationScore}`,
    );
  }
  try {
    new PublicKey(input.attesterPubkey);
  } catch {
    throw new Error(
      "buildReputationAttestation: attesterPubkey is not a valid Solana pubkey",
    );
  }

  // Build payload with explicit alphabetical key order — this matches the
  // canonical JSON we emit below, so a reader of either form gets the
  // same shape.
  const payload: ReputationAttestationPayload = {
    agentId: input.agentId,
    agentSlug: input.agentSlug,
    attester: input.attesterPubkey,
    errorCount: input.errorCount,
    issuedAt: input.issuedAt.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    periodStart: input.periodStart.toISOString(),
    reputationScore: input.reputationScore,
    schema: SCHEMA_ID,
    totalRequestCount: input.totalRequestCount,
    uptimeSeconds: input.uptimeSeconds,
  };

  // Canonical JSON: sorted keys, no whitespace.
  const indexable = payload as unknown as Record<string, unknown>;
  const sortedKeys = Object.keys(indexable).sort();
  const canonical = `{${sortedKeys
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(indexable[k])}`)
    .join(",")}}`;
  const messageBytes = new TextEncoder().encode(canonical);

  return { payload, messageBytes };
}
