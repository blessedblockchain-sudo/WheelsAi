/**
 * Production wiring for POST /api/agents/:agentId/run (routes/agentRun.ts):
 * the agent's kind and form from Prisma, and the chat core on the same
 * dependencies the playground uses (services/buildAgentChatDeps.ts), so a
 * run draws on the same allowance, licence and charge as a chat.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

import { prisma } from "../lib/prisma.js";
import { requireAuth, requireScope } from "../middleware/auth.js";
import { AGENTS_INVOKE_SCOPE } from "../middleware/openaiAuth.js";
import { buildAgentChatDeps } from "../services/buildAgentChatDeps.js";
import { createLogger } from "../utils/logger.js";
import { createAgentRunRoutes, type AgentRunGuards, type AgentRunRouteDeps } from "./agentRun.js";

const logger = createLogger("agent-run");

export function buildAgentRunGuards(): AgentRunGuards {
  return {
    auth: requireAuth as preHandlerAsyncHookHandler,
    invoke: requireScope(AGENTS_INVOKE_SCOPE) as preHandlerAsyncHookHandler,
  };
}

type RunAgentReads = { agent: Pick<typeof prisma.agent, "findFirst"> };

/** The agent as a run first reads it, in the caller's organization. */
export function buildLoadRunAgent(db: RunAgentReads = prisma): AgentRunRouteDeps["loadAgent"] {
  return ({ orgId, agentId }) =>
    db.agent.findFirst({
      where: { id: agentId, orgId },
      select: { id: true, name: true, agentKind: true, kindConfig: true },
    });
}

/** Production-wired plugin, as mounted by index.ts at /api. */
export function createAgentRunRoutesProduction(): FastifyPluginAsync {
  return createAgentRunRoutes({
    guards: buildAgentRunGuards(),
    loadAgent: buildLoadRunAgent(),
    chatDeps: buildAgentChatDeps,
    logger,
  });
}
