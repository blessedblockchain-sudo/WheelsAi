/**
 * Production wiring for the inbound channel-webhook route (plan A6).
 *
 * The whole channel stack — signature verification, credential resolution,
 * message normalization, the agent-message queue, outbound dispatch — was
 * built and unit-tested but never mounted: createChannelWebhookRoutes was
 * imported only by tests, so no inbound Discord/Telegram/Slack message
 * could ever reach an agent in production (Wave 0 free win #1).
 *
 * This file is the thin binding: the route's abstract deps get their
 * concrete equivalents (Prisma-backed channel-config resolver with the
 * OpenClaw config decryptor, and the BullMQ agent-message producer).
 *
 * Mounted in src/index.ts under prefix `/api/channels` → the platform
 * webhook URL becomes:
 *   POST /api/channels/webhooks/:deploymentId/:platform
 *
 * buildChannelWebhookDeps is exported for the wiring regression test —
 * unmounting/unwiring this again must fail a test, not a demo.
 */

import { prisma } from "@wheelsai/db";

import { enqueueAgentMessage } from "../queues/agent-message.queue.js";
import { resolveChannelConfig } from "../services/channelConfig.js";
import { decryptConfig } from "../services/openclaw.js";
import {
  createChannelWebhookRoutes,
  type ChannelWebhookDeps,
} from "./channelWebhooks.js";

type ChannelConfigPrisma = Parameters<
  typeof resolveChannelConfig
>[2]["prisma"];

export function buildChannelWebhookDeps(): ChannelWebhookDeps {
  return {
    resolveChannelConfig: async (deploymentId, platform) => {
      try {
        return await resolveChannelConfig(deploymentId, platform, {
          // The service declares a loose structural stub so it stays
          // unit-testable; the real client is structurally compatible.
          prisma: prisma as unknown as ChannelConfigPrisma,
          decryptConfig,
        });
      } catch (err) {
        // deploymentId is a @db.Uuid column; a malformed id (scanner
        // traffic on this public endpoint) makes Prisma throw P2023.
        // That's "no such channel" (404), not a server error. Anything
        // else (real DB outage) still bubbles to 500.
        if ((err as { code?: string }).code === "P2023") return null;
        throw err;
      }
    },
    enqueue: async (payload) => {
      await enqueueAgentMessage(payload);
    },
  };
}

export function createChannelWebhookRoutesProduction() {
  return createChannelWebhookRoutes(buildChannelWebhookDeps());
}
