/**
 * Prisma-backed persistHolderSnapshot loader for the token-trade indexer.
 *
 * Semantics: BULK REPLACE the holder distribution for the token. The
 * holder set evolves continuously (sells to zero remove a wallet from
 * the distribution entirely), so an upsert path is wrong — old rows
 * must be deleted, new ones inserted.
 *
 * Atomicity: deleteMany + createMany run inside a single $transaction
 * so the dashboard / governance reads never observe a half-written
 * holder set.
 *
 * Empty snapshot: an all-sold-to-zero token must still clear the
 * existing rows (running with empty holders is a real state we have
 * to reflect). Prisma's createMany rejects empty data — guard for
 * that case and skip the insert.
 *
 * Errors bubble (the indexer wraps with `persist_holder_snapshot_failed`
 * but keeps trade insertions committed so the next tick can retry
 * the snapshot derivation).
 */

import type { IndexerHolderSnapshotPayload } from "./tokenTradeIndexer.js";

interface HolderRowToWrite {
  tokenId: string;
  walletAddress: string;
  balance: number;
  percentage: number;
}

interface HolderTxStub {
  agentTokenHolder: {
    deleteMany: (args: {
      where: { tokenId: string };
    }) => Promise<{ count: number }>;
    createMany: (args: {
      data: HolderRowToWrite[];
    }) => Promise<{ count: number }>;
  };
}

interface PrismaStub {
  $transaction: <T>(work: (tx: HolderTxStub) => Promise<T>) => Promise<T>;
}

export interface PersistHolderSnapshotDeps {
  prisma: PrismaStub;
}

export async function persistHolderSnapshot(
  payload: IndexerHolderSnapshotPayload,
  deps: PersistHolderSnapshotDeps,
): Promise<void> {
  await deps.prisma.$transaction(async (tx) => {
    await tx.agentTokenHolder.deleteMany({
      where: { tokenId: payload.tokenId },
    });

    if (payload.holders.length === 0) return;

    const data: HolderRowToWrite[] = payload.holders.map((h) => ({
      tokenId: payload.tokenId,
      walletAddress: h.walletAddress,
      balance: h.balance,
      percentage: h.percentage,
    }));

    await tx.agentTokenHolder.createMany({ data });
  });
}
