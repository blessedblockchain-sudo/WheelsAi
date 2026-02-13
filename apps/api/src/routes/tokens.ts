import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import {
  checkTokenEligibility,
  createToken,
  getToken,
  getTokenByMint,
  listTokens,
  getTrendingTokens,
  getTokenTrades,
  getTokenHolders,
  getTokenChart,
  getLeaderboard,
} from "../services/agentToken.js";
import { getIndexerMetrics } from "../services/tokenIndexer.js";

const logger = createLogger("routes:tokens");

export const tokenRoutes: FastifyPluginAsync = async (app) => {
  // Public routes

  // GET / - List all tokens
  app.get("/", async (request, reply) => {
    try {
      const querySchema = z.object({
        status: z.string().optional(),
        sortBy: z
          .enum(["market_cap", "volume", "newest", "holders"])
          .optional(),
        page: z.coerce.number().optional(),
        limit: z.coerce.number().optional(),
      });

      const query = querySchema.parse(request.query);
      const result = await listTokens(query);

      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "List tokens error");
      return reply.status(400).send({ error: message });
    }
  });

  // GET /trending - Get trending tokens
  app.get("/trending", async (request, reply) => {
    try {
      const querySchema = z.object({
        limit: z.coerce.number().optional(),
      });

      const query = querySchema.parse(request.query);
      const result = await getTrendingTokens(query.limit);

      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Get trending tokens error");
      return reply.status(400).send({ error: message });
    }
  });

  // GET /leaderboard - Get leaderboard
  app.get("/leaderboard", async (request, reply) => {
    try {
      const querySchema = z.object({
        metric: z
          .enum(["market_cap", "volume", "holders", "newest"])
          .optional(),
        limit: z.coerce.number().optional(),
      });

      const query = querySchema.parse(request.query);
      const result = await getLeaderboard(query.metric, query.limit);

      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Get leaderboard error");
      return reply.status(400).send({ error: message });
    }
  });

  // GET /:id - Get token details
  app.get("/:id", async (request, reply) => {
    try {
      const paramsSchema = z.object({
        id: z.string(),
      });

      const params = paramsSchema.parse(request.params);
      const result = await getToken(params.id);

      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Get token error");
      return reply.status(400).send({ error: message });
    }
  });

  // GET /:id/trades - Get token trades
  app.get("/:id/trades", async (request, reply) => {
    try {
      const paramsSchema = z.object({
        id: z.string(),
      });

      const querySchema = z.object({
        page: z.coerce.number().optional(),
        limit: z.coerce.number().optional(),
      });

      const params = paramsSchema.parse(request.params);
      const query = querySchema.parse(request.query);
      const result = await getTokenTrades(params.id, query.page, query.limit);

      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Get token trades error");
      return reply.status(400).send({ error: message });
    }
  });

  // GET /:id/holders - Get token holders
  app.get("/:id/holders", async (request, reply) => {
    try {
      const paramsSchema = z.object({
        id: z.string(),
      });

      const params = paramsSchema.parse(request.params);
      const result = await getTokenHolders(params.id);

      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Get token holders error");
      return reply.status(400).send({ error: message });
    }
  });

  // GET /:id/chart - Get token chart data
  app.get("/:id/chart", async (request, reply) => {
    try {
      const paramsSchema = z.object({
        id: z.string(),
      });

      const querySchema = z.object({
        period: z.enum(["1h", "24h", "7d", "30d"]).optional(),
      });

      const params = paramsSchema.parse(request.params);
      const query = querySchema.parse(request.query);
      const result = await getTokenChart(params.id, query.period);

      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Get token chart error");
      return reply.status(400).send({ error: message });
    }
  });

  // Authenticated routes

  // POST /create - Create/tokenize an agent
  app.post("/create", { preHandler: [requireAuth] }, async (request, reply) => {
    try {
      const bodySchema = z.object({
        agentListingId: z.string(),
        name: z.string(),
        symbol: z.string().max(10).toUpperCase(),
        creatorAddress: z.string(),
      });

      const body = bodySchema.parse(request.body);
      const result = await createToken({
        ...body,
        orgId: (request as any).orgId,
      });

      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Create token error");
      return reply.status(400).send({ error: message });
    }
  });

  // GET /eligibility/:agentListingId - Check token eligibility
  app.get(
    "/eligibility/:agentListingId",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const paramsSchema = z.object({
          agentListingId: z.string(),
        });

        const params = paramsSchema.parse(request.params);
        const result = await checkTokenEligibility(
          params.agentListingId,
          (request as any).orgId
        );

        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error }, "Check token eligibility error");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // GET /indexer/metrics - Get indexer health metrics
  app.get(
    "/indexer/metrics",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const result = await getIndexerMetrics();

        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error }, "Get indexer metrics error");
        return reply.status(400).send({ error: message });
      }
    }
  );
};
