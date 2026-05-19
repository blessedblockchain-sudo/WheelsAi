/**
 * Prisma-backed loadAgentTradesForChart (companion to routes/chart.ts).
 *
 * Resolves the trades that feed the OHLC bar aggregator for an agent's
 * price chart. Two SQL trips:
 *
 *   prisma.agent.findFirst — slug + orgId scoped, includes the listing →
 *                            agentToken.id chain so we can scope trades.
 *   prisma.agentTokenTrade.findMany — tokenId scoped, optional [from, to]
 *                                     window, ordered by timestamp asc.
 *
 * Return contract (the route distinguishes these states):
 *   null → agent not found OR not tokenized yet (renders 404 "no chart")
 *   []   → tokenized agent with no trades yet (renders 200 empty chart)
 *
 * The trade query is skipped entirely when the agent isn't tokenized —
 * the route shows 404 rather than burning a round-trip on an empty result.
 */

import type { OhlcTrade } from "./ohlcBars.js";

interface AgentRow {
  id: string;
  orgId: string;
  slug: string;
  listing: { agentToken: { id: string } | null } | null;
}

interface TradeRow {
  timestamp: Date;
  priceUsd: number;
  solAmount: number;
}

interface PrismaStub {
  agent: {
    findFirst: (args: {
      where: { slug: string; orgId: string };
      include: unknown;
    }) => Promise<AgentRow | null>;
  };
  agentTokenTrade: {
    findMany: (args: {
      where: {
        tokenId: string;
        timestamp?: { gte?: Date; lte?: Date };
      };
      orderBy: { timestamp: "asc" };
      select: unknown;
    }) => Promise<TradeRow[]>;
  };
}

export interface LoadChartTradesInput {
  slug: string;
  orgId: string;
  from: Date | null;
  to: Date | null;
}

export interface LoadChartTradesDeps {
  prisma: PrismaStub;
}

function buildTimestampFilter(
  from: Date | null,
  to: Date | null,
): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  const filter: { gte?: Date; lte?: Date } = {};
  if (from) filter.gte = from;
  if (to) filter.lte = to;
  return filter;
}

export async function loadAgentTradesForChartByPrisma(
  input: LoadChartTradesInput,
  deps: LoadChartTradesDeps,
): Promise<OhlcTrade[] | null> {
  const agent = await deps.prisma.agent.findFirst({
    where: { slug: input.slug, orgId: input.orgId },
    include: {
      listing: {
        select: { agentToken: { select: { id: true } } },
      },
    },
  });
  if (!agent) return null;

  const tokenId = agent.listing?.agentToken?.id;
  if (!tokenId) return null;

  const timestamp = buildTimestampFilter(input.from, input.to);
  const where: PrismaStub["agentTokenTrade"]["findMany"] extends (
    args: infer A,
  ) => unknown
    ? A extends { where: infer W }
      ? W
      : never
    : never = {
    tokenId,
  } as any;
  if (timestamp) (where as any).timestamp = timestamp;

  const rows = await deps.prisma.agentTokenTrade.findMany({
    where,
    orderBy: { timestamp: "asc" },
    select: {
      timestamp: true,
      priceUsd: true,
      solAmount: true,
    },
  });

  return rows.map((r) => ({
    timestamp: r.timestamp,
    priceUsd: r.priceUsd,
    solAmount: r.solAmount,
  }));
}
