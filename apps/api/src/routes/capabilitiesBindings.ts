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
 *   paidUse        the free-model allowance is the day's limit times the
 *                  plan's multiple, the two numbers the chat core's own
 *                  check multiplies (middleware/free-tier-limit.ts); a plan
 *                  that cannot be read counts as the Starter multiple there,
 *                  and so it does here
 *
 * buildCapabilitiesDeps takes its collaborators as arguments so the wiring is
 * unit tested without the environment.
 */

import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";

import { env, type Env } from "../config/env.js";
import { getAvailableFreeModels, type FreeModelConfig } from "../config/free-models.js";
import { requireAuth } from "../middleware/auth.js";
import { isEmailConfigured } from "../services/email/emailService.js";
import { getOrgPlan } from "../services/orgPlan.js";
import { payoutsRunning } from "../services/payoutRequests.js";
import { createCapabilitiesRoutes, type CapabilitiesRouteDeps } from "./capabilities.js";

/** The settings the answer reads. */
export type CapabilitiesEnv = Pick<
  Env,
  "PAYOUTS_ENABLED" | "PAYOUT_EXECUTOR_INTERVAL_MS" | "AGENT_GPU_ENABLED" | "JOB_RUNNER_CONCURRENCY"
> &
  Partial<Pick<Env, "FREE_TIER_RPD">>;

export interface BuildCapabilitiesDepsInput {
  /** Read per answer, so a test can change a switch between two requests. */
  env: () => CapabilitiesEnv;
  /** Free models whose provider key is configured, in catalog order. */
  availableFreeModels: () => ReadonlyArray<Pick<FreeModelConfig, "id" | "displayName">>;
  emailConfigured: () => boolean;
  /** The plan's multiple of the free-model limits for an organization. Absent: the allowance reads as unknown. */
  planRateMultiplier?: (orgId: string) => Promise<number>;
  auth: preHandlerAsyncHookHandler;
}

export function buildCapabilitiesDeps(input: BuildCapabilitiesDepsInput): CapabilitiesRouteDeps {
  return {
    guards: { auth: input.auth },
    chatModels: () => input.availableFreeModels().map((model) => ({ id: model.id, label: model.displayName })),
    // The rule POST /api/marketplace/payouts refuses on (services/payoutRequests.ts).
    payouts: () => payoutsRunning(input.env()),
    emailDelivery: () => input.emailConfigured(),
    agentGpu: () => input.env().AGENT_GPU_ENABLED === true,
    paidTasks: () => input.env().JOB_RUNNER_CONCURRENCY > 0,
    freeModelDailyAllowance: async (orgId) => {
      const perDay = input.env().FREE_TIER_RPD;
      if (typeof perDay !== "number" || !input.planRateMultiplier) throw new Error("allowance not readable");
      // As the chat core does: a plan that cannot be read is the Starter multiple.
      const multiplier = await input.planRateMultiplier(orgId).catch(() => 1);
      return perDay * multiplier;
    },
  };
}

/** Production-wired plugin, as mounted by index.ts at /api/capabilities. */
export function createCapabilitiesRoutesProduction(): FastifyPluginAsync {
  return createCapabilitiesRoutes(
    buildCapabilitiesDeps({
      env: () => env,
      availableFreeModels: getAvailableFreeModels,
      emailConfigured: isEmailConfigured,
      planRateMultiplier: (orgId) => getOrgPlan(orgId).then(({ limits }) => limits.modelRateMultiplier),
      auth: requireAuth as preHandlerAsyncHookHandler,
    }),
  );
}
