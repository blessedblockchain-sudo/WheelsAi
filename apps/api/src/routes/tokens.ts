import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import {
  checkTokenEligibility,
  getToken,
  listTokens,
  getTrendingTokens,
  getTokenTrades,
  getTokenHolders,
  getTokenChart,
  getLeaderboard,
} from "../services/agentToken.js";
import { prisma } from "../lib/prisma.js";
import { loadIndexerHealthByPrisma } from "../services/loadIndexerHealthByPrisma.js";
import {
  CREATOR_LOCKUP_DAYS,
  launchGateThresholds,
  type LaunchGateThresholds,
} from "../services/tokenEligibility.js";

const logger = createLogger("routes:tokens");

export interface TokenRoutesOptions {
  /**
   * The launch gate's two numbers. Left out (as index.ts mounts it), they
   * are the server's settings; a test passes its own.
   */
  launchGate?: LaunchGateThresholds;
}

export const tokenRoutes: FastifyPluginAsync<TokenRoutesOptions> = async (app, opts) => {
  // Public routes

  // GET / - List all tokens
  app.get("/", { schema: { tags: ["Tokens"], description: "List agent tokens" } }, async (request, reply) => {
    try {
      const querySchema = z.object({
        status: z.string().optional(),
        sortBy: z
          .enum(["market_cap", "volume", "newest", "holders"])
          .optional(),
        search: z.string().optional(),
        page: z.coerce.number().optional(),
        offset: z.coerce.number().optional(),
        limit: z.coerce.number().optional(),
      });

      const query = querySchema.parse(request.query);
      const page =
        query.page ??
        (query.offset !== undefined
          ? Math.floor(query.offset / (query.limit ?? 20)) + 1
          : undefined);
      const result = await listTokens({
        status: query.status,
        sortBy: query.sortBy,
        search: query.search,
        page,
        limit: query.limit,
      });

      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "List tokens error");
      return reply.status(400).send({ error: message });
    }
  });

  // GET /trending - Get trending tokens
  app.get("/trending", { schema: { tags: ["Tokens"], description: "Get trending tokens" } }, async (request, reply) => {
    try {
      const querySchema = z.object({
        limit: z.coerce.number().optional(),
      });

      const query = querySchema.parse(request.query);
      const result = await getTrendingTokens(query.limit);

      return reply.send({ tokens: result });
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

      return reply.send({ tokens: result });
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

      return reply.send({ token: result });
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

      return reply.send({ holders: result });
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

      return reply.send({ snapshots: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Get token chart error");
      return reply.status(400).send({ error: message });
    }
  });

  // Authenticated routes

  // POST /create - retired custodial mint path.
  // The service behind this route is @deprecated and produces broken
  // on-chain metadata (raw iconUrl as the metadata uri); the supported
  // path is the browser-partial-sign flow at /api/tokens/launch/prepare
  // + /submit, where the user's wallet is the on-chain creator. Kept
  // mounted as 410 so old clients get an actionable error instead of a
  // broken mint.
  app.post(
    "/create",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["Tokens"],
        description: "Retired — use /api/tokens/launch/prepare + /submit",
        deprecated: true,
      },
    },
    async (_request, reply) => {
      return reply.status(410).send({
        error: "custodial_create_retired",
        message:
          "This endpoint has been retired. Use POST /api/tokens/launch/prepare and /api/tokens/launch/submit (browser partial-sign flow).",
      });
    }
  );

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
        // Read once per request, so the preview's sentences and the
        // requirements below can never name different numbers.
        const gate = opts.launchGate ?? launchGateThresholds();
        const result = await checkTokenEligibility(
          params.agentListingId,
          request.auth!.orgId,
          gate
        );

        // Surface the live thresholds so the UI renders the real
        // requirements instead of hardcoded copy that can drift.
        return reply.send({
          ...result,
          requirements: {
            minReputation: gate.minReputation,
            minDeploymentAgeDays: gate.minDeploymentAgeDays,
            creatorLockupDays: CREATOR_LOCKUP_DAYS,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error }, "Check token eligibility error");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // GET /indexer/metrics - Indexer health derived from the per-token
  // trade_index_cursor columns (plan D7). The previous payload mirrored
  // in-memory counters of a deleted setInterval worker that the BullMQ
  // indexer never wrote — it reported a stopped indexer regardless of
  // reality. Cursor freshness is durable and replica-independent.
  app.get(
    "/indexer/metrics",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        // `as never`: repo convention for the load*ByPrisma stubs — the
        // loader types the narrow Prisma surface it needs; the real
        // client satisfies it structurally but not generically.
        const result = await loadIndexerHealthByPrisma({ prisma: prisma as never });

        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error }, "Get indexer metrics error");
        return reply.status(400).send({ error: message });
      }
    }
  );
};
