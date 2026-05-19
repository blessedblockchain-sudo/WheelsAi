/**
 * Aggregated registration for the per-agent treasury read routes:
 *   GET /api/agents/:slug/runway
 *   GET /api/agents/:slug/payments
 *   GET /api/agents/:slug/chart
 *
 * Each underlying route is a factory plugin that takes a deps object;
 * this module builds those deps from the singleton prisma client +
 * placeholder SOL price oracle and registers them in one pass.
 *
 * Production todo: replace getSolPriceUsdPlaceholder with a real
 * Pyth/Switchboard/CoinGecko provider.
 */

import type { FastifyPluginAsync } from "fastify";

import { prisma } from "../lib/prisma.js";
import { createChartRoutes } from "./chart.js";
import { createPaymentsRoutes } from "./payments.js";
import { createRunwayRoutes } from "./runway.js";
import { loadAgentSnapshotByPrisma } from "../services/loadAgentSnapshot.js";
import { loadAgentTradesForChartByPrisma } from "../services/loadAgentTradesForChart.js";
import { loadPaymentsByPrisma } from "../services/loadPaymentsByPrisma.js";
import {
  fetchSolPriceFromCoinGecko,
  makeSolPriceProvider,
} from "../services/priceOracle.js";

// Shared module-level cache keeps the RPC pressure on CoinGecko low even when
// many concurrent runway requests arrive — one fetch per minute per process.
const getSolPriceUsd = makeSolPriceProvider({
  fetchPrice: () => fetchSolPriceFromCoinGecko(),
  cacheTtlMs: 60_000,
  fallbackUsd: 100,
});

// Each Prisma loader has a narrow test-stub shape (include: unknown,
// etc) that doesn't structurally match the real PrismaClient's strict
// generics. Casting at the wire boundary is fine — production runs
// against the real client, and the loaders' actual SQL is tested.
const prismaForLoaders = prisma as never;

export const agentTreasuryRoutes: FastifyPluginAsync = async (app) => {
  await app.register(
    createRunwayRoutes({
      loadAgentSnapshot: (args) =>
        loadAgentSnapshotByPrisma(args, { prisma: prismaForLoaders }),
      getSolPriceUsd,
    }),
  );

  await app.register(
    createPaymentsRoutes({
      loadPayments: (args) =>
        loadPaymentsByPrisma(args, { prisma: prismaForLoaders }),
    }),
  );

  await app.register(
    createChartRoutes({
      loadAgentTradesForChart: (args) =>
        loadAgentTradesForChartByPrisma(args, { prisma: prismaForLoaders }),
    }),
  );
};
