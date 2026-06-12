/**
 * Prisma-backed loader for the token-trade-indexer outer loop.
 *
 * Returns tokens whose trades need indexing — status BONDING or
 * GRADUATED. FAILED tokens never had a successful curve and don't
 * emit further trades, so polling them would burn cycles on dead
 * mints.
 *
 * Returns the { id, mintAddress, status, tradeIndexCursor } shape the
 * outer-tick deps builder requires: `status` gates the graduation
 * check (only BONDING rows may graduate — re-running graduateToken on
 * a GRADUATED row would reset the creator lockup), and
 * `tradeIndexCursor` is the per-token high-water mark the pagination
 * loop fetches down to (plan D7). Nothing else is over-fetched at the
 * outer loop.
 */

interface PrismaStub {
  agentToken: {
    findMany: (args: {
      where: {
        status: { in: Array<"BONDING" | "GRADUATED"> };
      };
      select: {
        id: true;
        mintAddress: true;
        status: true;
        tradeIndexCursor: true;
      };
    }) => Promise<
      Array<{
        id: string;
        mintAddress: string;
        status: string;
        tradeIndexCursor: Date | null;
      }>
    >;
  };
}

export interface LoadActiveTokensDeps {
  prisma: PrismaStub;
}

export interface ActiveTokenRow {
  id: string;
  mintAddress: string;
  status: string;
  tradeIndexCursor: Date | null;
}

export async function loadActiveTokensByPrisma(
  deps: LoadActiveTokensDeps,
): Promise<ActiveTokenRow[]> {
  const rows = await deps.prisma.agentToken.findMany({
    where: { status: { in: ["BONDING", "GRADUATED"] } },
    select: {
      id: true,
      mintAddress: true,
      status: true,
      tradeIndexCursor: true,
    },
  });
  // Explicit projection — Prisma's select narrows in production, but
  // the loader's contract is the narrow shape regardless of how the
  // upstream client behaves.
  return rows.map((r) => ({
    id: r.id,
    mintAddress: r.mintAddress,
    status: r.status,
    tradeIndexCursor: r.tradeIndexCursor ?? null,
  }));
}
