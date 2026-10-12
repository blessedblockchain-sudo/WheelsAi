/**
 * Composition root for the token-indexer outer tick (plan D7).
 *
 * Wires the production deps for runTokenIndexerOuterTick:
 *
 *   loadActiveTokensByPrisma     → loadActiveTokens (BONDING + GRADUATED
 *                                  rows with their trade_index_cursor),
 *                                  then only the pump.fun ones are kept
 *   fetchTokenTradesSince        → cursor-bounded, paginated trade fetch
 *                                  over the hardened PumpFunClient
 *   buildTokenTradeIndexerTickDeps
 *     + runTokenTradeIndexerTick → per-token trade persist (createMany
 *                                  skipDuplicates) + holder snapshot
 *   agentToken.updateMany        → per-token Postgres cursor persist
 *   stats ops (injected)         → the legacy per-token behaviors the
 *                                  cursor rewrite doesn't cover: stats
 *                                  refresh, graduation check, price-chart
 *                                  snapshot (preserved from the deleted
 *                                  services/tokenIndexer.ts setInterval
 *                                  tick so no behavior is lost)
 *
 * Cursor protocol: the per-token high-water mark is the timestamp of the
 * newest trade fetched this tick. It is advanced ONLY after
 * runTokenTradeIndexerTick returns (which throws on persist failure), so
 * a crash between fetch and persist re-fetches the same window — the
 * tx_signature unique + skipDuplicates makes the overlap harmless,
 * whereas advancing the cursor first would lose trades permanently.
 *
 * Failure isolation: every dep here is allowed to throw; the outer tick
 * counts the token as failed and proceeds to the next token.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { buildTokenTradeIndexerTickDeps } from "./buildTokenTradeIndexerTickDeps.js";
import {
  fetchTokenTradesSince,
  TRADE_FETCH_DEFAULT_MAX_PAGES,
} from "./fetchTokenTradesSince.js";
import { loadActiveTokensByPrisma } from "./loadActiveTokensByPrisma.js";
import type { TokenInfo, TokenTrade } from "./pumpfun.js";
import type { TokenIndexerOuterTickDeps } from "./runTokenIndexerOuterTick.js";
import { runTokenTradeIndexerTick } from "./tokenTradeIndexer.js";

type OuterTickPrismaSurface =
  | Pick<
      PrismaClient,
      "agentToken" | "agentTokenTrade" | "agentTokenHolder" | "$transaction"
    >
  | {
      agentToken: {
        findMany: (
          args: Prisma.AgentTokenFindManyArgs,
        ) => Promise<unknown[]>;
        updateMany: (
          args: Prisma.AgentTokenUpdateManyArgs,
        ) => Promise<{ count: number }>;
      };
      agentTokenTrade: {
        createMany: (
          args: Prisma.AgentTokenTradeCreateManyArgs,
        ) => Promise<{ count: number }>;
        findMany: (
          args: Prisma.AgentTokenTradeFindManyArgs,
        ) => Promise<unknown[]>;
      };
      agentTokenHolder: {
        deleteMany: (
          args: Prisma.AgentTokenHolderDeleteManyArgs,
        ) => Promise<{ count: number }>;
        createMany: (
          args: Prisma.AgentTokenHolderCreateManyArgs,
        ) => Promise<{ count: number }>;
      };
      $transaction: <T>(work: (tx: unknown) => Promise<T>) => Promise<T>;
    };

/**
 * Per-token operations preserved from the legacy indexer tick. Injected
 * (rather than imported) because the agentToken.ts implementations close
 * over the global Prisma client — the queue passes the real ones, tests
 * pass recorders.
 */
export interface TokenIndexerStatsOps {
  /** PumpFunClient.getTokenInfo — returns null on upstream failure. */
  getTokenInfo: (mintAddress: string) => Promise<TokenInfo | null>;
  updateTokenStats: (
    tokenId: string,
    stats: {
      priceUsd: number;
      marketCapUsd: number;
      volume24h: number;
      holders: number;
    },
  ) => Promise<unknown>;
  graduateToken: (
    tokenId: string,
    raydiumPoolId: string,
  ) => Promise<unknown>;
  createSnapshot: (tokenId: string) => Promise<unknown>;
}

export interface BuildTokenIndexerOuterTickDepsInput {
  prisma: OuterTickPrismaSurface;
  /** One upstream trades page — PumpFunClient.getTokenTrades (throws on failure). */
  getTradesPage: (
    mintAddress: string,
    limit: number,
    offset: number,
  ) => Promise<TokenTrade[]>;
  stats: TokenIndexerStatsOps;
  /** Pagination runaway guard per token per tick. Default 10 pages. */
  maxPagesPerToken?: number;
  now?: () => Date;
}

export function buildTokenIndexerOuterTickDeps(
  input: BuildTokenIndexerOuterTickDepsInput,
): TokenIndexerOuterTickDeps {
  const maxPages = input.maxPagesPerToken ?? TRADE_FETCH_DEFAULT_MAX_PAGES;
  const now = input.now ?? (() => new Date());

  // Populated by loadActiveTokens each tick; sinceFor and the graduation
  // gate read from it. The outer tick always calls loadActiveTokens
  // before sinceFor/tickToken, so the map is never stale within a tick.
  const tokenMeta = new Map<string, { since: Date; status: string }>();

  return {
    loadActiveTokens: async () => {
      const rows = await loadActiveTokensByPrisma({
        prisma: input.prisma as never,
      });
      tokenMeta.clear();
      if (rows.length === 0) return [];

      // This indexer reads pump.fun's API. A token launched anywhere else
      // (a Meteora curve) is not there: asking would fail the token every
      // tick, and a pump.fun answer must never set its price or graduate
      // it. Only the tokens the second read names as pump.fun's are kept.
      const pumpfunRows = (await input.prisma.agentToken.findMany({
        where: { id: { in: rows.map((r) => r.id) }, launchpad: "pumpfun" },
        select: { id: true },
      })) as Array<{ id: string }>;
      const pumpfunIds = new Set(pumpfunRows.map((r) => r.id));
      const kept = rows.filter((r) => pumpfunIds.has(r.id));

      for (const row of kept) {
        tokenMeta.set(row.id, {
          since: row.tradeIndexCursor ?? new Date(0),
          status: row.status,
        });
      }
      return kept.map((r) => ({ id: r.id, mintAddress: r.mintAddress }));
    },

    sinceFor: (tokenId) => tokenMeta.get(tokenId)?.since ?? new Date(0),

    tickToken: async (token, since) => {
      // ---- 1. Cursor-paginated trade indexing + holder snapshot ------
      // Capture the newest fetched trade timestamp so the cursor can be
      // advanced after the rows have committed.
      let newestFetchedMs: number | null = null;

      const tickDeps = buildTokenTradeIndexerTickDeps({
        prisma: input.prisma as never,
        tokenId: token.id,
        fetchTrades: async (mintAddress, sinceArg) => {
          const rows = await fetchTokenTradesSince(
            { mintAddress, since: sinceArg },
            { getTradesPage: input.getTradesPage, maxPages },
          );
          for (const row of rows) {
            const ts = row.timestamp.getTime();
            if (newestFetchedMs === null || ts > newestFetchedMs) {
              newestFetchedMs = ts;
            }
          }
          return rows;
        },
      });

      const result = await runTokenTradeIndexerTick(
        { token, since, now: now() },
        tickDeps,
      );

      // ---- 2. Advance the per-token cursor ---------------------------
      // Only reached when runTokenTradeIndexerTick returned without
      // throwing, i.e. the fetched trades are committed. updateMany (not
      // update) so a token deleted mid-tick is a no-op, not a throw.
      if (newestFetchedMs !== null) {
        await input.prisma.agentToken.updateMany({
          where: { id: token.id },
          data: { tradeIndexCursor: new Date(newestFetchedMs) },
        });
      }

      // ---- 3. Legacy per-token behaviors ------------------------------
      // Stats refresh, graduation check, price-chart snapshot — the
      // pieces the cursor rewrite doesn't cover. getTokenInfo returns
      // null on upstream failure (it feeds best-effort stats, not money
      // paths) — skip the trio rather than failing the token; the trade
      // indexing above already succeeded.
      const info = await input.stats.getTokenInfo(token.mintAddress);
      if (info) {
        await input.stats.updateTokenStats(token.id, {
          priceUsd: info.priceUsd,
          marketCapUsd: info.marketCapUsd,
          volume24h: info.volume24h,
          holders: info.holders,
        });

        // Only BONDING tokens may graduate — re-running graduateToken on
        // an already-GRADUATED row would reset the creator lockup.
        const status = tokenMeta.get(token.id)?.status;
        if (status === "BONDING" && info.isGraduated && info.raydiumPoolId) {
          await input.stats.graduateToken(token.id, info.raydiumPoolId);
        }

        await input.stats.createSnapshot(token.id);
      }

      return result;
    },
  };
}
