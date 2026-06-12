/**
 * Intent writer for the reputation-attestation worker — the claim-first
 * INSERT (confirmation discipline, remediation D6b).
 *
 * Inserts the OnChainAttestation mirror row at SUBMIT time, BEFORE the
 * broadcast, with:
 *   - status SUBMITTED
 *   - the attested deltas + score + attestorUnixTs (what we signed)
 *   - the signed-tx artifacts {txSignature, signedTxB64,
 *     lastValidBlockHeight} so recovery can re-broadcast the SAME bytes
 *     or prove expiry
 *   - cumulatives + observedAt explicitly NULL — those are written at
 *     CONFIRMATION time only (cumulatives from the AgentReputation PDA
 *     readback; observedAt = when we saw the landing). A SUBMITTED row
 *     never counts as an attestation.
 *
 * The unique tx_signature constraint gives DB-level idempotency: a
 * crash-replayed tick re-signs with a fresh blockhash (new signature)
 * so it can never collide with its orphaned predecessor — the orphan is
 * settled by recovery instead.
 *
 * Returns the inserted row id (the driver threads it through the
 * confirm/fail transitions).
 */

import type { SignedAttestationArtifact } from "./prepareOnChainAttestation.js";

export interface AttestationIntentInsert {
  tokenId: string;
  attestorAddress: string;
  uptimeSecondsDelta: bigint;
  messageCountDelta: bigint;
  score: number;
  attestorUnixTs: bigint;
  artifact: SignedAttestationArtifact;
}

interface PrismaStub {
  onChainAttestation: {
    create: (args: {
      data: Record<string, unknown>;
      select: { id: true };
    }) => Promise<{ id: string }>;
  };
}

export interface PersistAttestationIntentDeps {
  prisma: PrismaStub;
}

export async function persistAttestationIntent(
  input: AttestationIntentInsert,
  deps: PersistAttestationIntentDeps,
): Promise<string> {
  const created = await deps.prisma.onChainAttestation.create({
    data: {
      tokenId: input.tokenId,
      txSignature: input.artifact.txSignature,
      attestorAddress: input.attestorAddress,
      uptimeSecondsDelta: input.uptimeSecondsDelta,
      messageCountDelta: input.messageCountDelta,
      score: input.score,
      attestorUnixTs: input.attestorUnixTs,
      status: "SUBMITTED",
      signedTxB64: input.artifact.signedTxB64,
      lastValidBlockHeight: input.artifact.lastValidBlockHeight,
      // Confirmation-time fields — explicitly unknown until then.
      cumulativeUptimeSeconds: null,
      cumulativeMessageCount: null,
      attestationCount: null,
      observedAt: null,
    },
    select: { id: true },
  });

  return created.id;
}
