/**
 * Atomic cursor-advance + mirror writer for the reputation-attestation
 * worker (plan A4).
 *
 * Wraps two writes in a single Prisma interactive transaction:
 *   1. UPDATE agent_tokens SET last_on_chain_attestation_at = $cursor
 *      WHERE id = $tokenId
 *        AND (last_on_chain_attestation_at IS NULL
 *             OR last_on_chain_attestation_at < $cursor)
 *   2. INSERT INTO on_chain_attestations (...)
 *
 * Both succeed or both rollback — the cursor and the mirror cannot
 * diverge from each other within a tick.
 *
 * Why the stale-cursor guard on (1):
 *   Concurrency is concurrency=1 on the BullMQ worker, but a backlogged
 *   tick getting retried after the next tick already advanced the cursor
 *   would otherwise rewind. count==0 from the UPDATE is acceptable IF the
 *   mirror INSERT also fails (we don't want a mirror row without a cursor
 *   bump). We detect that via the cursor update's count and skip the
 *   insert when it's a no-op.
 *
 * The mirror row's PK is uuid; we leave generation to Prisma's default.
 * txSignature has a UNIQUE constraint that double-inserts can collide
 * on — that's intentional and gives us free idempotency at the DB layer
 * for the "submit succeeded but persist retried" failure mode.
 */

export interface AttestationMirrorInsert {
  tokenId: string;
  txSignature: string;
  attestorAddress: string;
  uptimeSecondsDelta: bigint;
  messageCountDelta: bigint;
  score: number;
  cumulativeUptimeSeconds: bigint;
  cumulativeMessageCount: bigint;
  attestationCount: number;
  attestorUnixTs: bigint;
}

interface PrismaTxStub {
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
  onChainAttestation: {
    create: (args: { data: AttestationMirrorInsert }) => Promise<unknown>;
  };
}

interface PrismaStub {
  $transaction: <T>(fn: (tx: PrismaTxStub) => Promise<T>) => Promise<T>;
}

export interface PersistAttestationCursorDeps {
  prisma: PrismaStub;
}

export async function persistAttestationCursor(
  input: {
    tokenId: string;
    cursor: Date;
    mirror: AttestationMirrorInsert;
  },
  deps: PersistAttestationCursorDeps,
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    const r = await tx.agentToken.updateMany({
      where: {
        id: input.tokenId,
        OR: [
          { lastOnChainAttestationAt: null },
          { lastOnChainAttestationAt: { lt: input.cursor } },
        ],
      },
      data: { lastOnChainAttestationAt: input.cursor },
    });
    if (r.count === 0) {
      // Cursor was already at or beyond the target — a newer tick has
      // already recorded an attestation for this period. Skip the mirror
      // insert to avoid a row without a matching cursor bump.
      return;
    }
    await tx.onChainAttestation.create({ data: input.mirror });
  });
}
