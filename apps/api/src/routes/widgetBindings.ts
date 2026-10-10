/**
 * Production wiring for /api/widget (routes/widget.ts): the public chat
 * deps the Try it routes share, which a task run (POST /:publicKey/run)
 * uses too, and the key's configuration on Prisma.
 *
 * Always mounted. Building it connects to nothing; the limiter's Redis
 * opens on the first request.
 *
 * buildWidgetRouteDeps is exported for the wiring test.
 */

import type { FastifyPluginAsync } from "fastify";

import { prisma } from "../lib/prisma.js";
import { pageSoldAtAPrice, productionPublicChatDeps, publicChatLimiter } from "../services/buildPublicChatDeps.js";
import type { UseListingDb } from "../services/useListing.js";
import { createLogger } from "../utils/logger.js";
import { orgHasWhiteLabel } from "./webChannelBindings.js";
import { createWidgetRoutes, type WidgetKeyConfig, type WidgetRouteDeps } from "./widget.js";

const logger = createLogger("widget-config");

/** A page loads its widget's configuration once; a minute of reloads fits. */
export const WIDGET_CONFIG_PER_IP_PER_MINUTE = 60;

const KEY_CONFIG_COLUMNS = {
  orgId: true,
  allowedOrigins: true,
  title: true,
  greeting: true,
  primaryColor: true,
  position: true,
  storeTranscripts: true,
  hideBranding: true,
  enabled: true,
  revokedAt: true,
  // What the page-key rule reads (routes/widget.ts). Neither reaches a visitor.
  pageOfAgentId: true,
  agent: { select: { name: true, isPublic: true } },
} as const;

export function buildWidgetRouteDeps(): WidgetRouteDeps {
  return {
    chat: productionPublicChatDeps(),
    config: {
      limiter: publicChatLimiter,
      perIpPerMinute: WIDGET_CONFIG_PER_IP_PER_MINUTE,
      // The public key is the lookup; there is no caller organization.
      loadKeyConfig: async (publicKey): Promise<WidgetKeyConfig | null> => {
        const row = await prisma.widgetKey.findUnique({ where: { publicKey }, select: KEY_CONFIG_COLUMNS });
        if (!row) return null;
        const { agent, ...key } = row;
        const config = { ...key, agentName: agent.name, agentIsPublic: agent.isPublic };
        // A page key that is on is also held to its agent's listing, read
        // the way the chat side reads it (bindPublicChatDeps). A listing
        // that cannot be read leaves the key not found. A key made for a
        // website, or one that answers nobody anyway, costs no read.
        if (key.pageOfAgentId == null || !key.enabled || key.revokedAt !== null) return config;
        try {
          return { ...config, soldAtAPrice: await pageSoldAtAPrice(prisma as unknown as UseListingDb, key.pageOfAgentId) };
        } catch (err) {
          logger.error({ err }, "a page key's configuration was refused: the listing of its agent could not be read");
          return null;
        }
      },
      whiteLabel: orgHasWhiteLabel,
    },
  };
}

export function createWidgetRoutesProduction(): FastifyPluginAsync {
  return createWidgetRoutes(buildWidgetRouteDeps());
}
