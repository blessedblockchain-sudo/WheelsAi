/**
 * Concrete-binding factories for the public / dashboard transparency routes
 * (remediation E1).
 *
 * The DI route factories — createPublicAgentRoutes, createAgentDetailRoutes,
 * createAgentListRoutes — were complete and unit-tested but never registered
 * in index.ts ("the moat is dark code"): publicAgent is the public per-agent
 * substance feed (treasury balance, cumulative compute paid, recent
 * settlement signatures) that makes "agents that pay for their own compute"
 * visible to a holder or regulator. This file is the thin production wiring —
 * each binding hands the route's abstract loader its load*ByPrisma equivalent
 * on the real Prisma client.
 *
 * The load*ByPrisma services declare loose structural PrismaStub shapes so
 * they stay unit-testable with mocks; the real client is structurally
 * compatible at runtime but its types are stricter, so we cast through each
 * loader's own parameter type (same pattern as tokenLaunchPartialSignBindings).
 *
 * Mount points (see src/index.ts):
 *   publicAgent  → prefix /api       → GET /api/a/:slug             (public)
 *   agentList    → prefix /api/feed  → GET /api/feed/agents         (authed)
 *   agentDetail  → prefix /api/feed  → GET /api/feed/agents/:slug   (authed)
 *
 * The authed feeds use /api/feed, not /api: their factory paths (/agents and
 * /agents/:slug) collide with the legacy id-keyed agentRoutes already mounted
 * at /api/agents. These are the slug-keyed substance feeds; the frontend
 * migrates onto them in later E-work.
 */

import { prisma } from "@wheelsai/db";

import { checkTokenEligibility } from "../services/agentToken.js";
import { loadAgentDetailByPrisma } from "../services/loadAgentDetail.js";
import { loadAgentListByPrisma } from "../services/loadAgentList.js";
import { loadPublicAgentByPrisma } from "../services/loadPublicAgent.js";
import { createAgentDetailRoutes } from "./agentDetail.js";
import { createAgentListRoutes } from "./agentList.js";
import { createPublicAgentRoutes } from "./publicAgent.js";

/** Recent settlement signatures surfaced on the public transparency feed. */
const PUBLIC_RECENT_PAYMENTS_LIMIT = 10;

type PublicAgentPrisma = Parameters<typeof loadPublicAgentByPrisma>[1]["prisma"];
type AgentDetailPrisma = Parameters<typeof loadAgentDetailByPrisma>[1]["prisma"];
type AgentListPrisma = Parameters<typeof loadAgentListByPrisma>[1]["prisma"];

export function createPublicAgentRoutesProduction() {
  return createPublicAgentRoutes({
    loadPublicAgent: (slug) =>
      loadPublicAgentByPrisma(
        { slug, paymentsLimit: PUBLIC_RECENT_PAYMENTS_LIMIT },
        {
          prisma: prisma as unknown as PublicAgentPrisma,
          // The listing's own publisherId, not the caller's — this is
          // "does this listing clear its own substance gate", and only
          // the boolean crosses the public boundary.
          checkEligibility: async (listingId, publisherId) => {
            const result = await checkTokenEligibility(listingId, publisherId);
            return { eligible: result.eligible };
          },
        },
      ),
  });
}

export function createAgentDetailRoutesProduction() {
  return createAgentDetailRoutes({
    loadAgentDetail: ({ slug, orgId, paymentsLimit }) =>
      loadAgentDetailByPrisma(
        { slug, orgId, paymentsLimit },
        { prisma: prisma as unknown as AgentDetailPrisma },
      ),
  });
}

export function createAgentListRoutesProduction() {
  return createAgentListRoutes({
    loadAgentList: ({ orgId, limit, offset, sort }) =>
      loadAgentListByPrisma(
        { orgId, limit, offset, sort },
        { prisma: prisma as unknown as AgentListPrisma },
      ),
  });
}
