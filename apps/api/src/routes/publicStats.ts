/**
 * GET /api/public/stats: the platform facts the landing page states,
 * read from the same constants the product runs on, so a stat can only
 * change when the product does.
 */
import type { FastifyPluginAsync } from "fastify";

import { AGENT_FRAMEWORKS } from "../config/frameworks.js";
import { MODEL_CATALOG } from "../config/modelCatalog.js";
import { LIVE_CHANNEL_PLATFORMS } from "./channelWebhooks.js";
import { PRICING_MODELS } from "../services/marketplace.js";

export interface PublicStatsDeps {
  countPublishedListings(): Promise<number>;
}

export function createPublicStatsRoutes(deps: PublicStatsDeps): FastifyPluginAsync {
  return async (app) => {
    app.get("/public/stats", async (_request, reply) => {
      const publishedListings = await deps.countPublishedListings().catch(() => null);
      reply.header("cache-control", "public, max-age=300");
      return {
        frameworks: AGENT_FRAMEWORKS.length,
        models: MODEL_CATALOG.length,
        pricingModels: PRICING_MODELS.length,
        channels: LIVE_CHANNEL_PLATFORMS.length,
        channelPlatforms: [...LIVE_CHANNEL_PLATFORMS],
        publishedListings,
      };
    });
  };
}
