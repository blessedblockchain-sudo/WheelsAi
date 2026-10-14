/**
 * Production wiring for paid runs of a workflow (routes/paidWorkflow.ts):
 * the guards a paid use of an agent has, the one set of paid-run deps of
 * this process (services/buildPaidWorkflowDeps.ts), and the reads of the two
 * pages open to anyone (services/workflowPublicPage.ts).
 *
 * Always mounted. Building it connects to nothing.
 */

import type { FastifyPluginAsync } from "fastify";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { productionPaidWorkflowDeps } from "../services/buildPaidWorkflowDeps.js";
import { loadWorkflowForListing } from "../services/buildWorkflowListingDeps.js";
import { readPlanOffers } from "../services/planOffers.js";
import {
  WORKFLOW_PUBLIC_LISTING_COLUMNS,
  type WorkflowPublicListing,
  type WorkflowPublicPageDeps,
} from "../services/workflowPublicPage.js";
import { createLogger } from "../utils/logger.js";
import { createPaidWorkflowRoutes } from "./paidWorkflow.js";
import { buildPaidUseGuards } from "./paidUseBindings.js";

const logger = createLogger("workflow-public-page");

/** The reads of a workflow's page and its API page. Building them connects to nothing. */
export function buildWorkflowPublicPageDeps(): WorkflowPublicPageDeps {
  return {
    // A listing's slug is unique across the marketplace, whatever it sells.
    loadListingBySlug: (slug): Promise<WorkflowPublicListing | null> =>
      prisma.agentListing.findUnique({ where: { slug }, select: WORKFLOW_PUBLIC_LISTING_COLUMNS }),
    loadPlans: (listingId) => readPlanOffers(prisma, listingId),
    // By its id AND the publisher's organization: never by its id alone.
    loadWorkflowForm: (ref) => loadWorkflowForListing(ref),
    // A listing that is not published keeps its pages while somebody's plan
    // on it runs: the one test of that, read on first use as the paid run
    // reads the workflow service.
    loadSaleHold: async (ref, now) =>
      (await import("../services/orchestration.js")).saleHold(ref.workflowId, ref.orgId, now),
    // Where the API page tells callers to send requests.
    publicApiUrl: env.PUBLIC_API_URL ?? null,
    logger,
  };
}

/** Production-wired plugin, as mounted by index.ts at /api. */
export function createPaidWorkflowRoutesProduction(): FastifyPluginAsync {
  return createPaidWorkflowRoutes({
    guards: buildPaidUseGuards(),
    paidWorkflow: productionPaidWorkflowDeps,
    publicPage: buildWorkflowPublicPageDeps,
  });
}
