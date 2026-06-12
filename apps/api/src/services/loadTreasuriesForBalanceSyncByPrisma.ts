/**
 * Prisma-backed loadTreasuries for runTreasuryBalanceSyncTick (D1).
 *
 * Scope: only treasuries whose Anchor program account exists on chain
 * (programInitialized=true) — those are the PDAs the pay_nosana path
 * spends from, so they're the only balances worth mirroring. Rows that
 * haven't been bootstrapped keep balanceSyncedAt=null and are excluded
 * from settlement by the staleness guard in loadSettlementBatch.
 */

import type { TreasuryForBalanceSync } from "./runTreasuryBalanceSyncTick.js";

interface PrismaStub {
  agentTreasury: {
    findMany: (args: {
      where: { programInitialized: boolean };
      select: { id: true; treasuryPdaAddress: true };
    }) => Promise<Array<{ id: string; treasuryPdaAddress: string }>>;
  };
}

export interface LoadTreasuriesForBalanceSyncDeps {
  prisma: PrismaStub;
}

export async function loadTreasuriesForBalanceSyncByPrisma(
  deps: LoadTreasuriesForBalanceSyncDeps,
): Promise<TreasuryForBalanceSync[]> {
  const rows = await deps.prisma.agentTreasury.findMany({
    where: { programInitialized: true },
    select: { id: true, treasuryPdaAddress: true },
  });

  return rows.map((r) => ({
    treasuryId: r.id,
    treasuryPdaAddress: r.treasuryPdaAddress,
  }));
}
