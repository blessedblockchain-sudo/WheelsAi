/**
 * Atomic CONFIRM writer for the reputation-attestation worker
 * (plan A4; confirmation discipline, remediation D6b).
 *
 * Wraps two writes in a single Prisma interactive transaction:
 *   1. UPDATE on_chain_attestations
 *         SET status = 'CONFIRMED',
 *             observed_at = $observedAt,        -- confirmation time
 *             cumulative_* = $readback values   -- from the PDA, may be null
 *       WHERE id = $mirrorId AND status = 'SUBMITTED'
 *   2. (only if (1) matched) UPDATE agent_tokens
 *         SET last_on_chain_attestation_at = $cursor
 *       WHERE id = $tokenId
 *         AND (last_on_chain_attestation_at IS NULL
 *              OR last_on_chain_attestation_at < $cursor)
 *
 * Both succeed or both rollback — a CONFIRMED mirror and the cursor can
 * never diverge within a tick. The cursor advances ONLY here: a mirror
 * row that stays SUBMITTED or goes FAILED leaves the usage window open
 * for the next tick to re-attest.
 *
 * Guard ordering (vs the pre-D6b version, which guarded on the cursor):
 * the mirror CAS comes FIRST because it is the ownership claim — under
 * replica overlap exactly one worker flips SUBMITTED→CONFIRMED, and only
 * that worker proceeds to the cursor. count==0 on the mirror CAS means
 * the row was already settled from the same on-chain evidence — a benign
 * no-op, mirror untouched, cursor already advanced by the winner.
 *
 * The cursor write keeps its own progression guard (IS NULL OR < cursor)
 * so an older window confirming late (recovery settling a backlog) can
 * never rewind a newer cursor. count==0 there is also benign.
 *
 * `observedAt` records when WE saw the confirmation (getSignatureStatuses
 * returned confirmed/finalized) — landing-observation time, not broadcast
 * time. The cumulative columns are the AgentReputation PDA readback taken
 * after confirmation; null = readback unavailable (truthful unknown — we
 * never substitute delta-derived values).
 */

import type { CumulativeReputationReadback } from "./runAttestationTick.js";

export interface PersistAttestationConfirmInput {
  /** OnChainAttestation row id (the SUBMITTED intent). */
  mirrorId: string;
  tokenId: string;
  /** Cursor advance target (the attested window's periodEnd). */
  cursor: Date;
  /** Confirmation-observation time → mirror.observedAt. */
  observedAt: Date;
  /** AgentReputation PDA readback; null = unavailable. */
  cumulatives: CumulativeReputationReadback | null;
}

interface PrismaTxStub {
  onChainAttestation: {
    updateMany: (args: {
      where: { id: string; status: "SUBMITTED" };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  agentToken: {
    updateMany: (args: {
      where: {
        id: string;
        OR: Array<
          | { lastOnChainAttestationAt: null }
          | { lastOnChainAttestationAt: { lt: Date } }
        >;
      };
      data: { lastOnChainAttestationAt: Date };
    }) => Promise<{ count: number }>;
  };
}

interface PrismaStub {
  $transaction: <T>(fn: (tx: PrismaTxStub) => Promise<T>) => Promise<T>;
}

export interface PersistAttestationCursorDeps {
  prisma: PrismaStub;
}

export async function persistAttestationCursor(
  input: PersistAttestationConfirmInput,
  deps: PersistAttestationCursorDeps,
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    const r = await tx.onChainAttestation.updateMany({
      where: { id: input.mirrorId, status: "SUBMITTED" },
      data: {
        status: "CONFIRMED",
        observedAt: input.observedAt,
        cumulativeUptimeSeconds:
          input.cumulatives?.cumulativeUptimeSeconds ?? null,
        cumulativeMessageCount:
          input.cumulatives?.cumulativeMessageCount ?? null,
        attestationCount: input.cumulatives?.attestationCount ?? null,
      },
    });
    if (r.count === 0) {
      // Another worker already settled this row from the same on-chain
      // evidence (and advanced the cursor). Skip the cursor write so a
      // lost race never touches anything.
      return;
    }
    await tx.agentToken.updateMany({
      where: {
        id: input.tokenId,
        OR: [
          { lastOnChainAttestationAt: null },
          { lastOnChainAttestationAt: { lt: input.cursor } },
        ],
      },
      data: { lastOnChainAttestationAt: input.cursor },
    });
    // count==0 on the cursor is benign: a NEWER window already advanced
    // it (recovery settling an old backlog row). The mirror is still
    // correctly CONFIRMED.
  });
}
