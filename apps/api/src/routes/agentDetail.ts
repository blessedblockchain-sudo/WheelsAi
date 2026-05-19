/**
 * GET /agents/:slug — dashboard agent-detail feed.
 *
 * Returns enough state in a single fetch for the dashboard agent page to
 * render: identity, treasury, active deployments, channels, and recent
 * compute payments. The runway numbers themselves live on the separate
 * /agents/:slug/runway endpoint so the dashboard can refresh them on a
 * different cadence.
 *
 * Persistence is dependency-injected so the route is unit-testable without
 * Prisma; the production wiring (loadAgentDetailByPrisma) is a thin
 * follow-on TDD slice.
 */

import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

const DEFAULT_PAYMENTS_LIMIT = 10;
const MAX_PAYMENTS_LIMIT = 100;

// ============================================
// Shapes
// ============================================

export interface AgentDetail {
  agent: {
    id: string;
    name: string;
    slug: string;
    framework: string;
    createdAt: Date;
  };
  treasury: { address: string; balanceLamports: bigint } | null;
  deployments: Array<{
    id: string;
    gpuTier: string;
    replicas: number;
    status: string;
    nosanaJobIds: string[];
  }>;
  channels: Array<{ platform: string; enabled: boolean }>;
  recentPayments: Array<{
    id: string;
    amountLamports: bigint;
    computeSeconds: bigint;
    status: string;
    txSignature: string | null;
    paidAt: Date | null;
    scheduledFor: Date;
    errorMessage: string | null;
  }>;
}

export interface AgentDetailDeps {
  loadAgentDetail: (args: {
    slug: string;
    orgId: string;
    paymentsLimit: number;
  }) => Promise<AgentDetail | null>;
}

const querySchema = z.object({
  paymentsLimit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_PAYMENTS_LIMIT)
    .optional(),
});

// ============================================
// Serialization
// ============================================

function serialize(detail: AgentDetail) {
  return {
    agent: {
      id: detail.agent.id,
      name: detail.agent.name,
      slug: detail.agent.slug,
      framework: detail.agent.framework,
      createdAt: detail.agent.createdAt.toISOString(),
    },
    treasury: detail.treasury
      ? {
          address: detail.treasury.address,
          balanceLamports: detail.treasury.balanceLamports.toString(),
        }
      : null,
    deployments: detail.deployments,
    channels: detail.channels,
    recentPayments: detail.recentPayments.map((p) => ({
      id: p.id,
      amountLamports: p.amountLamports.toString(),
      computeSeconds: p.computeSeconds.toString(),
      status: p.status,
      txSignature: p.txSignature,
      paidAt: p.paidAt ? p.paidAt.toISOString() : null,
      scheduledFor: p.scheduledFor.toISOString(),
      errorMessage: p.errorMessage,
    })),
  };
}

// ============================================
// Plugin
// ============================================

export function createAgentDetailRoutes(
  deps: AgentDetailDeps,
): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { slug: string }; Querystring: { paymentsLimit?: string } }>(
      "/agents/:slug",
      async (request, reply) => {
        if (!request.auth) {
          return reply.status(401).send({ error: "unauthenticated" });
        }
        const { orgId } = request.auth;
        const { slug } = request.params;

        const queryParsed = querySchema.safeParse(request.query);
        if (!queryParsed.success) {
          return reply.status(400).send({ error: "invalid_query" });
        }
        const paymentsLimit =
          queryParsed.data.paymentsLimit ?? DEFAULT_PAYMENTS_LIMIT;

        const detail = await deps.loadAgentDetail({ slug, orgId, paymentsLimit });
        if (!detail) {
          return reply.status(404).send({ error: "agent_not_found" });
        }

        return reply.status(200).send(serialize(detail));
      },
    );
  };
}
