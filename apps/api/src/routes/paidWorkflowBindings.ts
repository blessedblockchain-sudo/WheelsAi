/**
 * Production wiring for paid runs of a workflow (routes/paidWorkflow.ts):
 * the guards a paid use of an agent has, and the one set of paid-run deps of
 * this process (services/buildPaidWorkflowDeps.ts).
 *
 * Always mounted. Building it connects to nothing.
 */

import type { FastifyPluginAsync } from "fastify";

import { productionPaidWorkflowDeps } from "../services/buildPaidWorkflowDeps.js";
import { createPaidWorkflowRoutes } from "./paidWorkflow.js";
import { buildPaidUseGuards } from "./paidUseBindings.js";

/** Production-wired plugin, as mounted by index.ts at /api. */
export function createPaidWorkflowRoutesProduction(): FastifyPluginAsync {
  return createPaidWorkflowRoutes({ guards: buildPaidUseGuards(), paidWorkflow: productionPaidWorkflowDeps });
}
