/**
 * Production wiring for paid use (routes/paidUse.ts): the app's own guards
 * and the one set of paid-use deps of this process
 * (services/buildPaidUseDeps.ts).
 *
 * The x402 door (services/buildPaidUseX402Deps.ts) is wired here too: the
 * guards let through only a POST to chat or run that carries no credential
 * at all while the door's settings are on (x402DoorApplies), and the door's
 * deps are built on the first such call. With the door closed, every guard
 * is what it was.
 *
 * Always mounted. Building it connects to nothing.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

import { requireAuth, requireScope, x402DoorApplies } from "../middleware/auth.js";
import { productionPaidUseDeps } from "../services/buildPaidUseDeps.js";
import { productionX402Door, x402DoorOpenNow } from "../services/buildPaidUseX402Deps.js";
import { AGENTS_USE_SCOPE } from "./paidCompletions.js";
import { createPaidUseRoutes, type PaidUseGuards } from "./paidUse.js";

export { AGENTS_USE_SCOPE };

export function buildPaidUseGuards(): PaidUseGuards {
  return {
    auth: requireAuth as preHandlerAsyncHookHandler,
    use: requireScope(AGENTS_USE_SCOPE) as preHandlerAsyncHookHandler,
    // Read per request: the settings, then whether this request is the door's.
    anonymousDoor: (request) => x402DoorApplies(request, x402DoorOpenNow()),
  };
}

/** Production-wired plugin, as mounted by index.ts at /api. */
export function createPaidUseRoutesProduction(): FastifyPluginAsync {
  return createPaidUseRoutes({ guards: buildPaidUseGuards(), paidUse: productionPaidUseDeps, x402: productionX402Door });
}
