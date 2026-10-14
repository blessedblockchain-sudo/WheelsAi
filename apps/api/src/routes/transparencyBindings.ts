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

import { env } from "../config/env.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { checkTokenEligibility } from "../services/agentToken.js";
import type { AgentApiX402Cluster } from "../services/agentApiPage.js";
import { x402DoorUsable, type X402DoorEnv } from "../services/buildPaidUseX402Deps.js";
import { loadAgentDetailByPrisma } from "../services/loadAgentDetail.js";
import { loadAgentListByPrisma } from "../services/loadAgentList.js";
import { loadPublicAgentByPrisma } from "../services/loadPublicAgent.js";
import { x402Caip2Network } from "../services/x402Wire.js";
import { createAgentDetailRoutes } from "./agentDetail.js";
import { createAgentListRoutes } from "./agentList.js";
import { createPublicAgentRoutes } from "./publicAgent.js";

/** Recent settlement signatures surfaced on the public transparency feed. */
const PUBLIC_RECENT_PAYMENTS_LIMIT = 10;

type PublicAgentPrisma = Parameters<typeof loadPublicAgentByPrisma>[1]["prisma"];
type AgentDetailPrisma = Parameters<typeof loadAgentDetailByPrisma>[1]["prisma"];
type AgentListPrisma = Parameters<typeof loadAgentListByPrisma>[1]["prisma"];

/**
 * The cluster the wallet door takes payments on, when it is usable now: the
 * one answer the capabilities read (x402DoorUsable), so the API page offers
 * the door exactly when the Sell tab offers the switch. The network and the
 * mint are named as the door's own 402 names them.
 */
export function x402DoorClusterOf(settings: X402DoorEnv = env): AgentApiX402Cluster | null {
  if (!x402DoorUsable(settings)) return null;
  const network = settings.SOLANA_NETWORK;
  if (network === undefined) return null;
  return { network: x402Caip2Network(network), asset: usdcMintForNetwork(network).toBase58() };
}

export function createPublicAgentRoutesProduction() {
  return createPublicAgentRoutes({
    // Where the API page tells callers to send requests.
    publicApiUrl: env.PUBLIC_API_URL ?? null,
    // Whether a use can be paid from a wallet, read on every request.
    x402Door: () => x402DoorClusterOf(env),
    loadPublicAgent: (handle) =>
      loadPublicAgentByPrisma(
        { handle, paymentsLimit: PUBLIC_RECENT_PAYMENTS_LIMIT },
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
