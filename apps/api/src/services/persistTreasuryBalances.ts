/**
 * Prisma-backed persistBalances for runTreasuryBalanceSyncTick (D1).
 *
 * One updateMany per row: writes the spendable-balance mirror
 * (solBalanceLamports) together with balanceSyncedAt — the two columns
 * the settlement loader's staleness guard treats as a unit. updateMany
 * (not update) so a treasury deleted between load and persist is a
 * count=0 no-op instead of a P2025 throw.
 *
 * Errors bubble: a partial write must surface to the tick (and from
 * there to the cycle's error counter) — the rows that did land are
 * still individually consistent (balance + timestamp written together).
 */

import type { TreasuryBalanceRow } from "./runTreasuryBalanceSyncTick.js";

interface PrismaStub {
  agentTreasury: {
    updateMany: (args: {
      where: { id: string };
      data: { solBalanceLamports: bigint; balanceSyncedAt: Date };
    }) => Promise<{ count: number }>;
  };
}

export interface PersistTreasuryBalancesDeps {
  prisma: PrismaStub;
}

export async function persistTreasuryBalances(
  rows: TreasuryBalanceRow[],
  deps: PersistTreasuryBalancesDeps,
): Promise<void> {
  for (const row of rows) {
    await deps.prisma.agentTreasury.updateMany({
      where: { id: row.treasuryId },
      data: {
        solBalanceLamports: row.solBalanceLamports,
        balanceSyncedAt: row.syncedAt,
      },
    });
  }
}
