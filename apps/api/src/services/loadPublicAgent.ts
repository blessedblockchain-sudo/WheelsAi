/**
 * Prisma-backed loadPublicAgent (companion to routes/publicAgent.ts).
 *
 * Resolves the public-safe slice of an agent's state for the /a/:slug
 * transparency page. Differences from loadAgentDetailByPrisma:
 *
 *   - filter: where { slug, isPublic: true }   (no orgId scope)
 *   - returns null on miss OR private          (no existence reveal)
 *   - aggregates cumulativeComputePaidLamports across status='CONFIRMED'
 *     payments only — failed/pending compute does not count toward the
 *     publicly displayed "paid to date" figure
 *
 * Two SQL trips when a treasury exists: agent + nested includes, then
 * computePayment.aggregate + findMany run in parallel.
 */

import type { PublicAgentDetail } from "../routes/publicAgent.js";

interface AgentRow {
  id: string;
  isPublic: boolean;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
  deployments: Array<{
    gpuTier: string;
    replicas: number;
    status: string;
  }>;
  openclawDeployment: {
    channels: Array<{ platform: string; enabled: boolean }>;
  } | null;
  listing: {
    agentToken: {
      treasury: {
        id: string;
        treasuryPdaAddress: string;
        solBalanceLamports: bigint;
      } | null;
    } | null;
  } | null;
}

interface PaymentRow {
  amountLamports: bigint;
  status: string;
  txSignature: string | null;
  paidAt: Date | null;
}

interface PrismaStub {
  agent: {
    findFirst: (args: {
      where: { slug: string; isPublic: boolean };
      include: unknown;
    }) => Promise<AgentRow | null>;
  };
  computePayment: {
    aggregate: (args: {
      where: { treasuryId: string; status: string };
      _sum: { amountLamports: true };
    }) => Promise<{ _sum: { amountLamports: bigint | null } }>;
    findMany: (args: {
      where: { treasuryId: string };
      orderBy: { createdAt: "desc" };
      take: number;
    }) => Promise<PaymentRow[]>;
  };
}

export interface LoadPublicAgentInput {
  slug: string;
  paymentsLimit: number;
}

export interface LoadPublicAgentDeps {
  prisma: PrismaStub;
}

export async function loadPublicAgentByPrisma(
  input: LoadPublicAgentInput,
  deps: LoadPublicAgentDeps,
): Promise<PublicAgentDetail | null> {
  const agent = await deps.prisma.agent.findFirst({
    where: { slug: input.slug, isPublic: true },
    include: {
      deployments: {
        select: { gpuTier: true, replicas: true, status: true },
      },
      openclawDeployment: {
        select: {
          channels: { select: { platform: true, enabled: true } },
        },
      },
      listing: {
        select: {
          agentToken: {
            select: {
              treasury: {
                select: {
                  id: true,
                  treasuryPdaAddress: true,
                  solBalanceLamports: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!agent) return null;

  const treasuryRow = agent.listing?.agentToken?.treasury ?? null;
  const channels = agent.openclawDeployment?.channels ?? [];

  let treasury: PublicAgentDetail["treasury"] = null;
  let recentPayments: PublicAgentDetail["recentPayments"] = [];

  if (treasuryRow) {
    const [agg, payments] = await Promise.all([
      deps.prisma.computePayment.aggregate({
        where: { treasuryId: treasuryRow.id, status: "CONFIRMED" },
        _sum: { amountLamports: true },
      }),
      deps.prisma.computePayment.findMany({
        where: { treasuryId: treasuryRow.id },
        orderBy: { createdAt: "desc" },
        take: input.paymentsLimit,
      }),
    ]);

    treasury = {
      address: treasuryRow.treasuryPdaAddress,
      balanceLamports: treasuryRow.solBalanceLamports,
      cumulativeComputePaidLamports: agg._sum.amountLamports ?? 0n,
    };

    recentPayments = payments.map((p) => ({
      amountLamports: p.amountLamports,
      status: p.status,
      txSignature: p.txSignature,
      paidAt: p.paidAt,
    }));
  }

  return {
    agent: {
      name: agent.name,
      slug: agent.slug,
      framework: agent.framework,
      createdAt: agent.createdAt,
    },
    treasury,
    deployments: agent.deployments.map((d) => ({
      gpuTier: d.gpuTier,
      replicas: d.replicas,
      status: d.status,
    })),
    channels: channels.map((c) => ({
      platform: c.platform,
      enabled: c.enabled,
    })),
    recentPayments,
  };
}
