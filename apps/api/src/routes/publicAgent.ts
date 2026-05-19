/**
 * Public per-agent transparency feed (plan C5).
 *
 * GET /a/:slug — unauthenticated, presents the public-safe slice of an
 * agent's economic state: identity, treasury balance + cumulative compute
 * paid, recent settlement signatures, enabled channels, deployment summary.
 *
 * This is the single most differentiated artifact in the product — it is
 * the visible manifestation of "agents that pay for their own compute"
 * and the first surface a regulator or holder lands on. Privacy
 * guarantees pinned by tests:
 *   - orgId never appears in the response
 *   - payment errorMessage redacted (status only)
 *   - disabled channels filtered out
 *   - deployments expose tier + replicas + status, not internal job IDs
 *
 * The loader signals "not found OR not public" with a single null return,
 * so the route never reveals the existence of a private agent.
 */

import type { FastifyPluginAsync } from "fastify";

const LAMPORTS_PER_SOL = 1_000_000_000;

// ============================================
// Shapes
// ============================================

export interface PublicAgentDetail {
  agent: {
    name: string;
    slug: string;
    framework: string;
    createdAt: Date;
  };
  treasury: {
    address: string;
    balanceLamports: bigint;
    cumulativeComputePaidLamports: bigint;
  } | null;
  deployments: Array<{ gpuTier: string; replicas: number; status: string }>;
  channels: Array<{ platform: string; enabled: boolean }>;
  recentPayments: Array<{
    amountLamports: bigint;
    status: string;
    txSignature: string | null;
    paidAt: Date | null;
  }>;
}

export interface PublicAgentDeps {
  loadPublicAgent: (slug: string) => Promise<PublicAgentDetail | null>;
}

// ============================================
// Serialization
// ============================================

function lamportsToSol4dp(lamports: bigint): number {
  // Convert without losing precision. Round to 4 decimal places for display.
  // Use string math to keep the bigint exact, then parseFloat the result.
  const whole = lamports / BigInt(LAMPORTS_PER_SOL);
  const remainder = lamports % BigInt(LAMPORTS_PER_SOL);
  const fractional = Number(remainder) / LAMPORTS_PER_SOL;
  const exact = Number(whole) + fractional;
  return Math.round(exact * 10_000) / 10_000;
}

function serialize(detail: PublicAgentDetail) {
  return {
    agent: {
      name: detail.agent.name,
      slug: detail.agent.slug,
      framework: detail.agent.framework,
      createdAt: detail.agent.createdAt.toISOString(),
    },
    treasury: detail.treasury
      ? {
          address: detail.treasury.address,
          balanceLamports: detail.treasury.balanceLamports.toString(),
          balanceSol: lamportsToSol4dp(detail.treasury.balanceLamports),
          cumulativeComputePaidLamports:
            detail.treasury.cumulativeComputePaidLamports.toString(),
        }
      : null,
    deployments: detail.deployments.map((d) => ({
      gpuTier: d.gpuTier,
      replicas: d.replicas,
      status: d.status,
    })),
    channels: detail.channels
      .filter((c) => c.enabled)
      .map((c) => ({ platform: c.platform, enabled: c.enabled })),
    recentPayments: detail.recentPayments.map((p) => ({
      amountLamports: p.amountLamports.toString(),
      status: p.status,
      txSignature: p.txSignature,
      paidAt: p.paidAt ? p.paidAt.toISOString() : null,
    })),
  };
}

// ============================================
// Plugin
// ============================================

export function createPublicAgentRoutes(deps: PublicAgentDeps): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { slug: string } }>("/a/:slug", async (request, reply) => {
      const { slug } = request.params;
      const detail = await deps.loadPublicAgent(slug);
      if (!detail) {
        // 404, not 401/403 — never reveal that a private agent with this slug exists.
        return reply.status(404).send({ error: "agent_not_found" });
      }
      return reply.status(200).send(serialize(detail));
    });
  };
}
