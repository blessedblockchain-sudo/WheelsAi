/**
 * Production wiring for /api/widget (routes/widget.ts): the public chat
 * deps the Try it routes share, and the key's configuration on Prisma.
 *
 * Always mounted. Building it connects to nothing; the limiter's Redis
 * opens on the first request.
 *
 * buildWidgetRouteDeps is exported for the wiring test.
 */

import type { FastifyPluginAsync } from "fastify";

import { prisma } from "../lib/prisma.js";
import { productionPublicChatDeps, publicChatLimiter } from "../services/buildPublicChatDeps.js";
import { orgHasWhiteLabel } from "./webChannelBindings.js";
import { createWidgetRoutes, type WidgetKeyConfig, type WidgetRouteDeps } from "./widget.js";

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
  agent: { select: { name: true } },
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
        return { ...key, agentName: agent.name };
      },
      whiteLabel: orgHasWhiteLabel,
    },
  };
}

export function createWidgetRoutesProduction(): FastifyPluginAsync {
  return createWidgetRoutes(buildWidgetRouteDeps());
}
