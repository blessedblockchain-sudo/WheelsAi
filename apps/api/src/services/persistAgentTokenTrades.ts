/**
 * Prisma-backed persistTrades loader for runTokenTradeIndexerTick.
 *
 * Idempotency: the unique key on agent_token_trades is `tx_signature`.
 * createMany({ skipDuplicates: true }) is the load-bearing primitive —
 * pumpportal returns paginated, overlapping pages by design, and the
 * indexer-level dedup only protects within a single tick. Duplicates
 * from a *previous* tick would crash without skipDuplicates.
 *
 * Errors bubble (the indexer wraps them with `persist_trades_failed`
 * and skips the holder-snapshot recompute on top of the stale view).
 *
 * Field projection is explicit — we never spread the indexer row, so
 * if IndexerTradeRow grows fields in the future the schema doesn't
 * silently get junk columns proposed at it.
 */

import type { IndexerTradeRow } from "./tokenTradeIndexer.js";

interface PrismaStub {
  agentTokenTrade: {
    createMany: (args: {
      data: Array<{
        tokenId: string;
        txSignature: string;
        traderAddress: string;
        side: string;
        tokenAmount: number;
        solAmount: number;
        priceUsd: number;
        solLamports: bigint;
        tokenAmountRaw: bigint;
        timestamp: Date;
      }>;
      skipDuplicates: true;
    }) => Promise<{ count: number }>;
  };
}

export interface PersistTokenTradesInput {
  tokenId: string;
  rows: IndexerTradeRow[];
}

export interface PersistTokenTradesDeps {
  prisma: PrismaStub;
}

export async function persistAgentTokenTrades(
  input: PersistTokenTradesInput,
  deps: PersistTokenTradesDeps,
): Promise<{ inserted: number }> {
  if (input.rows.length === 0) return { inserted: 0 };

  const data = input.rows.map((r) => ({
    tokenId: input.tokenId,
    txSignature: r.txSignature,
    traderAddress: r.traderAddress,
    side: r.side,
    tokenAmount: r.tokenAmount,
    solAmount: r.solAmount,
    priceUsd: r.priceUsd,
    // Integer raw units carried straight from the indexer boundary (D9).
    solLamports: r.solLamports,
    tokenAmountRaw: r.tokenAmountRaw,
    timestamp: r.timestamp,
  }));

  const { count } = await deps.prisma.agentTokenTrade.createMany({
    data,
    skipDuplicates: true,
  });

  return { inserted: count };
}
