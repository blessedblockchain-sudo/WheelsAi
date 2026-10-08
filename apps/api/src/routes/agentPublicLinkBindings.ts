/**
 * Production wiring for /api/agents/:agentId/public-link
 * (routes/agentPublicLink.ts): the link on Prisma and the public chat's
 * counters (services/buildAgentPublicLinkDeps.ts), read by any member and
 * changed by an owner or admin.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

import { requireAuth, requireRole } from "../middleware/auth.js";
import { buildAgentPublicLinkDeps } from "../services/buildAgentPublicLinkDeps.js";
import { createAgentPublicLinkRoutes, type AgentPublicLinkGuards } from "./agentPublicLink.js";

export function buildAgentPublicLinkGuards(): AgentPublicLinkGuards {
  return {
    auth: requireAuth as preHandlerAsyncHookHandler,
    manage: requireRole("owner", "admin") as preHandlerAsyncHookHandler,
  };
}

/** Production-wired plugin, as mounted by index.ts at /api/agents. */
export function createAgentPublicLinkRoutesProduction(): FastifyPluginAsync {
  return createAgentPublicLinkRoutes({ link: buildAgentPublicLinkDeps(), guards: buildAgentPublicLinkGuards() });
}
