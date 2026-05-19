/**
 * Prisma-backed loader for the token-trade-indexer outer loop.
 *
 * Returns tokens whose trades need indexing — status BONDING or
 * GRADUATED. FAILED tokens never had a successful curve and don't
 * emit further trades, so polling them would burn cycles on dead
 * mints.
 *
 * Returns the minimal { id, mintAddress } shape the indexer's per-tick
 * input requires. The dep-builder builds the per-token deps map per
 * iteration; nothing else needs over-fetching at the outer loop.
 */

interface PrismaStub {
  agentToken: {
    findMany: (args: {
      where: {
        status: { in: Array<"BONDING" | "GRADUATED"> };
      };
      select: { id: true; mintAddress: true };
    }) => Promise<Array<{ id: string; mintAddress: string }>>;
  };
}

export interface LoadActiveTokensDeps {
  prisma: PrismaStub;
}

export interface ActiveTokenRow {
  id: string;
  mintAddress: string;
}

export async function loadActiveTokensByPrisma(
  deps: LoadActiveTokensDeps,
): Promise<ActiveTokenRow[]> {
  const rows = await deps.prisma.agentToken.findMany({
    where: { status: { in: ["BONDING", "GRADUATED"] } },
    select: { id: true, mintAddress: true },
  });
  // Explicit projection — Prisma's select narrows in production, but
  // the loader's contract is the narrow shape regardless of how the
  // upstream client behaves.
  return rows.map((r) => ({ id: r.id, mintAddress: r.mintAddress }));
}
