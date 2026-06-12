/**
 * Honest, DB-derived indexer health for GET /api/tokens/indexer/metrics
 * (plan D7).
 *
 * The old payload mirrored in-memory counters owned by the deleted
 * setInterval worker (services/tokenIndexer.ts) — fields like
 * enabled/running/startedAt were per-process state the BullMQ worker
 * never wrote, so the endpoint reported a stopped indexer while trades
 * were being indexed (and vice versa across replicas).
 *
 * What CAN be answered truthfully from any replica is cursor freshness:
 * every successful per-token tick advances
 * agent_tokens.trade_index_cursor, so cursor age is a direct, durable
 * measure of indexer liveness.
 *
 *   activeTokens          — BONDING + GRADUATED rows the indexer polls
 *   indexedTokens         — of those, rows with a cursor (≥1 trade seen)
 *   neverIndexedTokens    — cursor still null (no trades fetched yet —
 *                           either a brand-new token or a stalled indexer)
 *   oldestCursorAgeSeconds — staleness of the WORST token (alert on this)
 *   newestCursorAgeSeconds — staleness of the freshest token (a large
 *                           value here means the whole indexer is down,
 *                           not one noisy token)
 *
 * Cursor age conflates "indexer down" with "token simply has no new
 * trades" — that is inherent to a poll-driven indexer and is why the
 * payload reports raw ages instead of a boolean "healthy".
 */

const ACTIVE_STATUSES = ["BONDING", "GRADUATED"] as const;

interface PrismaStub {
  agentToken: {
    count: (args: {
      where: {
        status: { in: ReadonlyArray<"BONDING" | "GRADUATED"> };
        tradeIndexCursor?: null;
      };
    }) => Promise<number>;
    aggregate: (args: {
      where: { status: { in: ReadonlyArray<"BONDING" | "GRADUATED"> } };
      _min: { tradeIndexCursor: true };
      _max: { tradeIndexCursor: true };
    }) => Promise<{
      _min: { tradeIndexCursor: Date | null };
      _max: { tradeIndexCursor: Date | null };
    }>;
  };
}

export interface LoadIndexerHealthDeps {
  prisma: PrismaStub;
  now?: () => Date;
}

export interface IndexerHealth {
  source: "database";
  activeTokens: number;
  indexedTokens: number;
  neverIndexedTokens: number;
  oldestCursorAgeSeconds: number | null;
  newestCursorAgeSeconds: number | null;
  generatedAt: string;
}

function ageSeconds(cursor: Date | null, now: Date): number | null {
  if (!cursor) return null;
  return Math.max(0, Math.floor((now.getTime() - cursor.getTime()) / 1000));
}

export async function loadIndexerHealthByPrisma(
  deps: LoadIndexerHealthDeps,
): Promise<IndexerHealth> {
  const now = deps.now?.() ?? new Date();

  const [activeTokens, neverIndexedTokens, cursors] = await Promise.all([
    deps.prisma.agentToken.count({
      where: { status: { in: ACTIVE_STATUSES } },
    }),
    deps.prisma.agentToken.count({
      where: { status: { in: ACTIVE_STATUSES }, tradeIndexCursor: null },
    }),
    deps.prisma.agentToken.aggregate({
      where: { status: { in: ACTIVE_STATUSES } },
      _min: { tradeIndexCursor: true },
      _max: { tradeIndexCursor: true },
    }),
  ]);

  return {
    source: "database",
    activeTokens,
    indexedTokens: activeTokens - neverIndexedTokens,
    neverIndexedTokens,
    oldestCursorAgeSeconds: ageSeconds(cursors._min.tradeIndexCursor, now),
    newestCursorAgeSeconds: ageSeconds(cursors._max.tradeIndexCursor, now),
    generatedAt: now.toISOString(),
  };
}
