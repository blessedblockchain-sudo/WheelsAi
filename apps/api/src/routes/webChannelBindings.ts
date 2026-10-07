/**
 * Production wiring for /api/channels/web (routes/webChannel.ts): the
 * owner's web chat keys on Prisma, today's usage from the public chat
 * limiter, and the snippet's two addresses from this server's own
 * configuration.
 *
 * buildWebChannelDeps is exported for the wiring test.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { publicChatLimiter } from "../services/buildPublicChatDeps.js";
import { getOrgPlan } from "../services/orgPlan.js";
import type { WebChannelDb, WebChannelDeps } from "../services/webChannel.js";
import { createWebChannelRoutes, type WebChannelGuards } from "./webChannel.js";

/** Whether an organization's plan includes white-labelling (services/plans.ts). */
export async function orgHasWhiteLabel(orgId: string): Promise<boolean> {
  return (await getOrgPlan(orgId)).limits.whiteLabel;
}

/**
 * Where the snippet points. Outside development both come from the
 * environment or not at all: a snippet with a guessed address would be
 * pasted into a customer's site and fail there.
 */
export function snippetAddresses(): WebChannelDeps["snippet"] {
  const dev = env.NODE_ENV === "development";
  return {
    webUrl: env.PUBLIC_WEB_URL ?? (dev ? env.CORS_ORIGIN : null),
    apiUrl: env.PUBLIC_API_URL ?? (dev ? `http://localhost:${env.API_PORT}` : null),
  };
}

export function buildWebChannelGuards(): WebChannelGuards {
  return {
    auth: requireAuth as preHandlerAsyncHookHandler,
    manage: requireRole("owner", "admin") as preHandlerAsyncHookHandler,
  };
}

export function buildWebChannelDeps(): WebChannelDeps {
  return {
    db: prisma as unknown as WebChannelDb,
    limiter: publicChatLimiter,
    whiteLabel: orgHasWhiteLabel,
    snippet: snippetAddresses(),
    defaultDailyCap: env.WIDGET_DEFAULT_DAILY_CAP,
  };
}

export function createWebChannelRoutesProduction(): FastifyPluginAsync {
  return createWebChannelRoutes({ channel: buildWebChannelDeps(), guards: buildWebChannelGuards() });
}
