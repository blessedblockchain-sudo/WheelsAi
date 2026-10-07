/**
 * Production wiring for /api/offerings and /api/jobs.
 *
 * Both are always mounted. Where the runner is switched off
 * (JOB_RUNNER_CONCURRENCY=0) hiring and activating answer 501
 * jobs_not_configured, and nothing is charged; reading, accepting and
 * rejecting existing jobs keep working.
 */

import type { FastifyPluginAsync } from "fastify";

import { buildJobRunnerDeps } from "../services/buildJobRunnerDeps.js";
import { buildJobServiceDeps } from "../services/buildJobServiceDeps.js";
import { buildOfferingServiceDeps } from "../services/buildOfferingServiceDeps.js";
import { tryOffering } from "../services/jobRunner.js";
import { FREE_TIER_LIMIT_MESSAGE } from "../services/sharedAgentChat.js";
import { buildJobRouteGuards } from "./jobGuards.js";
import { createJobRoutes } from "./jobs.js";
import { createOfferingRoutes } from "./offerings.js";

/** A test run happens inside a request; two minutes is the chat core's own limit. */
const TEST_RUN_MAX_MS = 120_000;

export function createOfferingRoutesProduction(): FastifyPluginAsync {
  // Built on first use: the runner's deps open the chat core's bindings.
  let runner: ReturnType<typeof buildJobRunnerDeps> | null = null;
  return createOfferingRoutes({
    offerings: buildOfferingServiceDeps(),
    jobs: buildJobServiceDeps(),
    testRun: {
      tryProduct: (job, signal) => tryOffering((runner ??= buildJobRunnerDeps()), job, signal),
      maxRunMs: TEST_RUN_MAX_MS,
      freeTierLimitMessage: FREE_TIER_LIMIT_MESSAGE,
    },
    guards: buildJobRouteGuards(),
  });
}

export function createJobRoutesProduction(): FastifyPluginAsync {
  return createJobRoutes({ jobs: buildJobServiceDeps(), guards: buildJobRouteGuards() });
}
