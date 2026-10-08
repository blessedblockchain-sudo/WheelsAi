/**
 * Production wiring for GET /api/capabilities (routes/capabilities.ts).
 *
 * Each answer is read from the thing that decides it, per request:
 *
 *   chat           the free-model catalog, kept to the models whose provider
 *                  the platform holds a key for (config/free-models.ts)
 *   payouts        the payout switch, with the worker that settles payouts
 *                  scheduled (the condition queues/payout-executor.queue.ts
 *                  starts on)
 *   emailDelivery  the email service's own provider check
 *   agentGpu       the dedicated GPU switch for agents
 *   paidTasks      the job runner being on (the condition hiring answers
 *                  jobs_not_configured on)
 *
 * buildCapabilitiesDeps takes its collaborators as arguments so the wiring is
 * unit tested without the environment.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

import { env, type Env } from "../config/env.js";
import { getAvailableFreeModels, type FreeModelConfig } from "../config/free-models.js";
import { requireAuth } from "../middleware/auth.js";
import { isEmailConfigured } from "../services/email/emailService.js";
import { createCapabilitiesRoutes, type CapabilitiesRouteDeps } from "./capabilities.js";

/** The settings the answer reads. */
export type CapabilitiesEnv = Pick<
  Env,
  "PAYOUTS_ENABLED" | "PAYOUT_EXECUTOR_INTERVAL_MS" | "AGENT_GPU_ENABLED" | "JOB_RUNNER_CONCURRENCY"
>;

export interface BuildCapabilitiesDepsInput {
  /** Read per answer, so a test can change a switch between two requests. */
  env: () => CapabilitiesEnv;
  /** Free models whose provider key is configured, in catalog order. */
  availableFreeModels: () => ReadonlyArray<Pick<FreeModelConfig, "id" | "displayName">>;
  emailConfigured: () => boolean;
  auth: preHandlerAsyncHookHandler;
}

export function buildCapabilitiesDeps(input: BuildCapabilitiesDepsInput): CapabilitiesRouteDeps {
  return {
    guards: { auth: input.auth },
    chatModels: () => input.availableFreeModels().map((model) => ({ id: model.id, label: model.displayName })),
    payouts: () => {
      const e = input.env();
      return e.PAYOUTS_ENABLED === true && e.PAYOUT_EXECUTOR_INTERVAL_MS > 0;
    },
    emailDelivery: () => input.emailConfigured(),
    agentGpu: () => input.env().AGENT_GPU_ENABLED === true,
    paidTasks: () => input.env().JOB_RUNNER_CONCURRENCY > 0,
  };
}

/** Production-wired plugin, as mounted by index.ts at /api/capabilities. */
export function createCapabilitiesRoutesProduction(): FastifyPluginAsync {
  return createCapabilitiesRoutes(
    buildCapabilitiesDeps({
      env: () => env,
      availableFreeModels: getAvailableFreeModels,
      emailConfigured: isEmailConfigured,
      auth: requireAuth as preHandlerAsyncHookHandler,
    }),
  );
}
