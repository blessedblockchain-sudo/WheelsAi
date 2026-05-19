/**
 * GET /agents/:slug/chart — OHLC price-bar feed for the dashboard chart.
 *
 * Composes:
 *   loadAgentTradesForChart(slug, orgId, from?, to?) → trades[] | null
 *   aggregateOhlcBars(trades, intervalSeconds)        → bars[]
 *
 * intervalSeconds is allowlisted at the route boundary so a hostile
 * client can't pass `intervalSeconds=1` and force the bucket loop to
 * allocate 86,400 buckets per day.
 *
 * The loader is dependency-injected; production wiring is a thin Prisma
 * shell around `prisma.agentTokenTrade.findMany` scoped through the
 * agent → listing → agentToken chain.
 */

import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

import {
  aggregateOhlcBars,
  type OhlcTrade,
} from "../services/ohlcBars.js";

const ALLOWED_INTERVALS = [60, 300, 3600, 86400] as const;
type AllowedInterval = (typeof ALLOWED_INTERVALS)[number];

// ============================================
// Schema
// ============================================

const querySchema = z
  .object({
    intervalSeconds: z.coerce
      .number()
      .int()
      .refine(
        (v): v is AllowedInterval =>
          (ALLOWED_INTERVALS as readonly number[]).includes(v),
        {
          message: `intervalSeconds must be one of ${ALLOWED_INTERVALS.join(", ")}`,
        },
      ),
    from: z
      .string()
      .optional()
      .transform((v) => (v ? new Date(v) : null))
      .refine((v) => v === null || !Number.isNaN(v.getTime()), {
        message: "from must be a valid ISO date",
      }),
    to: z
      .string()
      .optional()
      .transform((v) => (v ? new Date(v) : null))
      .refine((v) => v === null || !Number.isNaN(v.getTime()), {
        message: "to must be a valid ISO date",
      }),
  })
  .refine(
    (q) =>
      q.from === null ||
      q.to === null ||
      q.from.getTime() <= q.to.getTime(),
    { message: "from must be <= to" },
  );

// ============================================
// DI surface
// ============================================

export interface ChartRouteDeps {
  loadAgentTradesForChart: (args: {
    slug: string;
    orgId: string;
    from: Date | null;
    to: Date | null;
  }) => Promise<OhlcTrade[] | null>;
}

// ============================================
// Plugin
// ============================================

function serializeBar(bar: ReturnType<typeof aggregateOhlcBars>[number]) {
  return {
    openTime: bar.openTime.toISOString(),
    closeTime: bar.closeTime.toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volumeSol: bar.volumeSol,
    tradeCount: bar.tradeCount,
  };
}

export function createChartRoutes(deps: ChartRouteDeps): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { slug: string }; Querystring: Record<string, string> }>(
      "/agents/:slug/chart",
      async (request, reply) => {
        if (!request.auth) {
          return reply.status(401).send({ error: "unauthenticated" });
        }
        const { orgId } = request.auth;
        const { slug } = request.params;

        const parsed = querySchema.safeParse(request.query);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ error: "invalid_query", details: parsed.error.flatten() });
        }
        const { intervalSeconds, from, to } = parsed.data;

        const trades = await deps.loadAgentTradesForChart({
          slug,
          orgId,
          from,
          to,
        });
        if (trades === null) {
          return reply.status(404).send({ error: "agent_not_found" });
        }

        const bars = aggregateOhlcBars({
          trades,
          intervalSeconds,
          from: from ?? undefined,
          to: to ?? undefined,
        });

        return reply.status(200).send({
          intervalSeconds,
          from: from ? from.toISOString() : null,
          to: to ? to.toISOString() : null,
          bars: bars.map(serializeBar),
        });
      },
    );
  };
}
