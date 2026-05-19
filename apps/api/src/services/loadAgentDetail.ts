/**
 * Prisma-backed loadAgentDetail (companion to routes/agentDetail.ts).
 *
 * Resolves the agent + everything the dashboard's agent page renders:
 *   Agent (slug, orgId)
 *     → AgentDeployment[]
 *     → OpenClawDeployment.channels[]
 *     → AgentListing.agentToken.treasury (AgentTreasury)
 *     → ComputePayment[] (most recent N, ordered by createdAt desc)
 *
 * Two SQL trips: one nested findFirst for the agent + its 1:N branches that
 * Prisma can join, one targeted findMany for ComputePayment (only fired
 * when a treasury exists).
 */

import type { AgentDetail } from "../routes/agentDetail.js";

interface AgentRow {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
  deployments: Array<{
    id: string;
    gpuTier: string;
    replicas: number;
    status: string;
    nosanaJobIds: string[];
  }>;
  openclawDeployment: {
    id: string;
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
  id: string;
  amountLamports: bigint;
  computeSeconds: bigint;
  status: string;
  txSignature: string | null;
  paidAt: Date | null;
  scheduledFor: Date;
  errorMessage: string | null;
}

interface PrismaStub {
  agent: {
    findFirst: (args: {
      where: { slug: string; orgId: string };
      include: unknown;
    }) => Promise<AgentRow | null>;
  };
  computePayment: {
    findMany: (args: {
      where: { treasuryId: string };
      orderBy: { createdAt: "desc" };
      take: number;
    }) => Promise<PaymentRow[]>;
  };
}

export interface LoadAgentDetailInput {
  slug: string;
  orgId: string;
  paymentsLimit: number;
}

export interface LoadAgentDetailDeps {
  prisma: PrismaStub;
}

export async function loadAgentDetailByPrisma(
  input: LoadAgentDetailInput,
  deps: LoadAgentDetailDeps,
): Promise<AgentDetail | null> {
  const agent = await deps.prisma.agent.findFirst({
    where: { slug: input.slug, orgId: input.orgId },
    include: {
      deployments: {
        select: {
          id: true,
          gpuTier: true,
          replicas: true,
          status: true,
          nosanaJobIds: true,
        },
      },
      openclawDeployment: {
        select: {
          id: true,
          channels: {
            select: { platform: true, enabled: true },
          },
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

  const treasury = agent.listing?.agentToken?.treasury ?? null;
  const channels = agent.openclawDeployment?.channels ?? [];

  const recentPayments: AgentDetail["recentPayments"] = treasury
    ? await deps.prisma.computePayment.findMany({
        where: { treasuryId: treasury.id },
        orderBy: { createdAt: "desc" },
        take: input.paymentsLimit,
      })
    : [];

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      framework: agent.framework,
      createdAt: agent.createdAt,
    },
    treasury: treasury
      ? {
          address: treasury.treasuryPdaAddress,
          balanceLamports: treasury.solBalanceLamports,
        }
      : null,
    deployments: agent.deployments,
    channels,
    recentPayments,
  };
}
