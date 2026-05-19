/**
 * Prisma-backed loadAllTrades loader for runTokenTradeIndexerTick.
 *
 * The indexer recomputes the holder snapshot from the FULL trade
 * history each tick (snapshot is bulk-replaced via persistHolderSnapshot,
 * so we always need everything to derive the right distribution).
 *
 * No pagination — this is an internal worker call, not a user-facing
 * read. Volume bound: even a heavily-traded pump.fun token rarely sees
 * more than a few thousand trades pre-graduation, after which the fee
 * router shifts the indexer onto Raydium.
 *
 * Orders ascending by timestamp — the holder-snapshot pure fn is
 * order-agnostic on the math, but ascending is the natural default
 * for debugging and any future order-dependent analytics on the same
 * loader.
 */

import type { IndexerTradeRow } from "./tokenTradeIndexer.js";

interface PrismaStub {
  agentTokenTrade: {
    findMany: (args: {
      where: { tokenId: string };
      orderBy: { timestamp: "asc" };
      select: unknown;
    }) => Promise<
      Array<{
        txSignature: string;
        traderAddress: string;
        side: string;
        tokenAmount: number;
        solAmount: number;
        priceUsd: number;
        timestamp: Date;
      }>
    >;
  };
}

export interface LoadAllAgentTokenTradesDeps {
  prisma: PrismaStub;
}

export async function loadAllAgentTokenTrades(
  tokenId: string,
  deps: LoadAllAgentTokenTradesDeps,
): Promise<IndexerTradeRow[]> {
  const rows = await deps.prisma.agentTokenTrade.findMany({
    where: { tokenId },
    orderBy: { timestamp: "asc" },
    select: {
      txSignature: true,
      traderAddress: true,
      side: true,
      tokenAmount: true,
      solAmount: true,
      priceUsd: true,
      timestamp: true,
    },
  });

  return rows.map((r) => ({
    txSignature: r.txSignature,
    traderAddress: r.traderAddress,
    // Prisma stores side as String; the indexer's contract is the
    // narrow union. Trust the producer (persistAgentTokenTrades only
    // writes "buy" | "sell").
    side: r.side as "buy" | "sell",
    tokenAmount: r.tokenAmount,
    solAmount: r.solAmount,
    priceUsd: r.priceUsd,
    timestamp: r.timestamp,
  }));
}
