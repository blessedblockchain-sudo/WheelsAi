/**
 * GET /api/public/stats: the platform facts the landing page states,
 * read from the same constants the product runs on, so a stat can only
 * change when the product does.
 */
import type { FastifyPluginAsync } from "fastify";

import { AGENT_FRAMEWORKS } from "../config/frameworks.js";
import { MODEL_CATALOG } from "../config/modelCatalog.js";
import { LIVE_CHAT_CHANNELS } from "./channelWebhooks.js";
import { PRICING_MODELS } from "../services/marketplace.js";
import type { PublicLatencyReader } from "../services/publicLatency.js";

export interface PublicStatsDeps {
  countPublishedListings(): Promise<number>;
  /**
   * The measured response time (services/publicLatency.ts). Unlike the
   * constants above it has no fallback value: unread is "unavailable".
   */
  latency: Pick<PublicLatencyReader, "figure" | "unavailableFigure">;
}

export function createPublicStatsRoutes(deps: PublicStatsDeps): FastifyPluginAsync {
  return async (app) => {
    app.get("/public/stats", async (_request, reply) => {
      const [publishedListings, latency] = await Promise.all([
        deps.countPublishedListings().catch(() => null),
        deps.latency.figure().catch(() => deps.latency.unavailableFigure()),
      ]);
      reply.header("cache-control", "public, max-age=300");
      return {
        frameworks: AGENT_FRAMEWORKS.length,
        models: MODEL_CATALOG.length,
        pricingModels: PRICING_MODELS.length,
        channels: LIVE_CHAT_CHANNELS.length,
        channelPlatforms: [...LIVE_CHAT_CHANNELS],
        publishedListings,
        latency,
      };
    });
  };
}
