/**
 * Production wiring for paid use (routes/paidUse.ts): the app's own guards
 * and the one set of paid-use deps of this process
 * (services/buildPaidUseDeps.ts).
 *
 * Always mounted. Building it connects to nothing.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

import { requireAuth, requireScope } from "../middleware/auth.js";
import { productionPaidUseDeps } from "../services/buildPaidUseDeps.js";
import { AGENTS_USE_SCOPE } from "./paidCompletions.js";
import { createPaidUseRoutes, type PaidUseGuards } from "./paidUse.js";

export { AGENTS_USE_SCOPE };

export function buildPaidUseGuards(): PaidUseGuards {
  return {
    auth: requireAuth as preHandlerAsyncHookHandler,
    use: requireScope(AGENTS_USE_SCOPE) as preHandlerAsyncHookHandler,
  };
}

/** Production-wired plugin, as mounted by index.ts at /api. */
export function createPaidUseRoutesProduction(): FastifyPluginAsync {
  return createPaidUseRoutes({ guards: buildPaidUseGuards(), paidUse: productionPaidUseDeps });
}
