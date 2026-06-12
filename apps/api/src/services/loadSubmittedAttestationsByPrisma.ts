/**
 * Prisma-backed loader for the recovery phase of the
 * reputation-attestation worker (confirmation discipline, D6b).
 *
 * Returns OnChainAttestation mirror rows stuck in SUBMITTED — the
 * intent was persisted (signed artifacts on the row) by a tick that
 * crashed or hit an RPC error before the broadcast → CONFIRMED/FAILED
 * settlement completed. The recovery phase settles each from on-chain
 * evidence: landed → CONFIRMED (+ cumulative readback + cursor),
 * landed-with-err or expired+unseen → FAILED (window retries),
 * unexpired+unseen → re-broadcast the stored bytes.
 *
 * Joins token.mintAddress (needed for the AgentReputation PDA readback
 * on confirmation).
 *
 * Defensive filter: a SUBMITTED row with null signedTxB64 is
 * schema-inconsistent (persistAttestationIntent writes all artifacts in
 * the insert). Recovery can neither verify nor re-broadcast it —
 * EXCLUDED here, surfaced via metrics (same policy as the D3 loader).
 *
 * Ordered by createdAt asc (oldest first — fairness under the limit).
 */

import type { SubmittedAttestationRow } from "./runAttestationTick.js";

interface PrismaStub {
  onChainAttestation: {
    findMany: (args: {
      where: { status: "SUBMITTED" };
      orderBy: { createdAt: "asc" };
      take: number;
      select: unknown;
    }) => Promise<
      Array<{
        id: string;
        tokenId: string;
        txSignature: string;
        lastValidBlockHeight: bigint | null;
        signedTxB64: string | null;
        attestorUnixTs: bigint;
        token: { mintAddress: string };
      }>
    >;
  };
}

export interface LoadSubmittedAttestationsInput {
  now: Date;
  limit: number;
}

export interface LoadSubmittedAttestationsDeps {
  prisma: PrismaStub;
}

export async function loadSubmittedAttestationsByPrisma(
  input: LoadSubmittedAttestationsInput,
  deps: LoadSubmittedAttestationsDeps,
): Promise<SubmittedAttestationRow[]> {
  const rows = await deps.prisma.onChainAttestation.findMany({
    where: { status: "SUBMITTED" },
    orderBy: { createdAt: "asc" },
    take: input.limit,
    select: {
      id: true,
      tokenId: true,
      txSignature: true,
      lastValidBlockHeight: true,
      signedTxB64: true,
      attestorUnixTs: true,
      token: { select: { mintAddress: true } },
    },
  });

  return rows.flatMap((r) =>
    r.signedTxB64
      ? [
          {
            id: r.id,
            tokenId: r.tokenId,
            mintAddress: r.token.mintAddress,
            txSignature: r.txSignature,
            lastValidBlockHeight: r.lastValidBlockHeight,
            signedTxB64: r.signedTxB64,
            attestorUnixTs: r.attestorUnixTs,
          },
        ]
      : [],
  );
}
