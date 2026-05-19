/**
 * Build the TokenTradeIndexerDeps for runTokenTradeIndexerTick.
 *
 * The BullMQ indexer worker iterates active tokens; for each one it
 * calls this builder to produce the deps map, then runs one tick.
 *
 * Composes:
 *   fetchTrades             — injected (pump.fun / pumpportal HTTP)
 *   persistAgentTokenTrades — Prisma createMany w/ skipDuplicates
 *   loadAllAgentTokenTrades — Prisma findMany scoped by runtime tokenId
 *   persistHolderSnapshot   — Prisma deleteMany + createMany in a tx
 *
 * tokenId is provided at build-time so persistTrades can stamp the FK
 * onto each row (the indexer's IndexerTradeRow has no tokenId — pump.fun
 * data is per-mint, not per-token-record). loadAllTrades, by contrast,
 * receives tokenId at call-time so it routes the runtime token through.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  loadAllAgentTokenTrades,
} from "./loadAllAgentTokenTrades.js";
import { persistAgentTokenTrades } from "./persistAgentTokenTrades.js";
import { persistHolderSnapshot } from "./persistHolderSnapshot.js";
import type {
  IndexerHolderSnapshotPayload,
  IndexerTradeRow,
  TokenTradeIndexerDeps,
} from "./tokenTradeIndexer.js";

type IndexerPrismaSurface = Pick<
  PrismaClient,
  "agentTokenTrade" | "agentTokenHolder" | "$transaction"
> | {
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

export interface BuildTokenTradeIndexerTickDepsInput {
  prisma: IndexerPrismaSurface;
  tokenId: string;
  fetchTrades: (
    mintAddress: string,
    since: Date,
  ) => Promise<IndexerTradeRow[]>;
}

export function buildTokenTradeIndexerTickDeps(
  input: BuildTokenTradeIndexerTickDepsInput,
): TokenTradeIndexerDeps {
  return {
    fetchTrades: input.fetchTrades,
    persistTrades: (rows: IndexerTradeRow[]) =>
      persistAgentTokenTrades(
        { tokenId: input.tokenId, rows },
        { prisma: input.prisma as never },
      ),
    loadAllTrades: (tokenId: string) =>
      loadAllAgentTokenTrades(tokenId, {
        prisma: input.prisma as never,
      }),
    persistHolderSnapshot: (payload: IndexerHolderSnapshotPayload) =>
      persistHolderSnapshot(payload, {
        prisma: input.prisma as never,
      }),
  };
}
