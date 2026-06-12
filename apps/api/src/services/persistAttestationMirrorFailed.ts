/**
 * FAILED transition writer for the reputation-attestation mirror
 * (confirmation discipline, remediation D6b).
 *
 * CAS SUBMITTED→FAILED for a mirror row whose transaction either landed
 * with an on-chain error or provably expired unseen (head past
 * lastValidBlockHeight + searchTransactionHistory miss). The per-token
 * cursor is deliberately NOT touched — a failed attestation leaves the
 * usage window open, and the next tick re-aggregates and re-attests it
 * with a fresh signature.
 *
 * count==0 is benign: an overlapping recovery scan settled the row
 * first (either way the verdict came from the same on-chain facts).
 * Never throws on a lost race.
 */

interface PrismaStub {
  onChainAttestation: {
    updateMany: (args: {
      where: { id: string; status: "SUBMITTED" };
      data: { status: "FAILED" };
    }) => Promise<{ count: number }>;
  };
}

export interface PersistAttestationMirrorFailedDeps {
  prisma: PrismaStub;
}

export async function persistAttestationMirrorFailed(
  mirrorId: string,
  deps: PersistAttestationMirrorFailedDeps,
): Promise<void> {
  await deps.prisma.onChainAttestation.updateMany({
    where: { id: mirrorId, status: "SUBMITTED" },
    data: { status: "FAILED" },
  });
}
