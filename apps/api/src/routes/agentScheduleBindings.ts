/**
 * Production wiring for /api/agents/:agentId/schedule and /runs
 * (routes/agentSchedule.ts): the schedule on Prisma, the Scheduler's own
 * "run now" and the result senders (services/buildAgentScheduleDeps.ts).
 * Any member or API key reads and changes a schedule; a key needs
 * agents:invoke to start a run.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

import { requireAuth, requireScope } from "../middleware/auth.js";
import { AGENTS_INVOKE_SCOPE } from "../middleware/openaiAuth.js";
import { buildAgentScheduleDeps } from "../services/buildAgentScheduleDeps.js";
import { createAgentScheduleRoutes, type AgentScheduleGuards } from "./agentSchedule.js";

export function buildAgentScheduleGuards(): AgentScheduleGuards {
  return {
    auth: requireAuth as preHandlerAsyncHookHandler,
    invoke: requireScope(AGENTS_INVOKE_SCOPE) as preHandlerAsyncHookHandler,
  };
}

/** Production-wired plugin, as mounted by index.ts at /api/agents. */
export function createAgentScheduleRoutesProduction(): FastifyPluginAsync {
  return createAgentScheduleRoutes({ schedule: buildAgentScheduleDeps(), guards: buildAgentScheduleGuards() });
}
