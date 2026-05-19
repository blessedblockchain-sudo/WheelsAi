/**
 * Prisma-backed loadAgentSnapshot (plan A8).
 *
 * Production impl of the dep the runway route depends on. Resolves:
 *   Agent (by slug + orgId — scoped for multi-tenant isolation)
 *     → AgentDeployment[] (active only, sum replicas, collect model dep ids)
 *     → UsageRecord[] (filtered by deploymentId set + periodEnd >= cutoff)
 *     → AgentTreasury (via Agent → AgentListing → AgentToken → AgentTreasury)
 *
 * Prisma is dependency-injected so this is unit-testable with a stub.
 */

import type { AgentRunwaySnapshot } from "../routes/runway.js";

const DEFAULT_MAX_REPLICAS = 10;

export interface LoadAgentSnapshotInput {
  slug: string;
  orgId: string;
  lookbackSeconds: number;
  now: Date;
}

interface PrismaStub {
  agent: {
    findFirst: (args: {
      where: { slug: string; orgId: string };
      include: unknown;
    }) => Promise<unknown>;
  };
  usageRecord: {
    findMany: (args: {
      where: {
        orgId: string;
        deploymentId: { in: string[] };
        periodEnd: { gte: Date };
      };
      select: unknown;
    }) => Promise<
      Array<{
        periodStart: Date;
        periodEnd: Date;
        computeSeconds: bigint;
        actualCostCents: bigint;
      }>
    >;
  };
}

export interface LoadAgentSnapshotDeps {
  prisma: PrismaStub;
  /** Override the auto-scaling cap. Defaults to 10. */
  maxReplicas?: number;
}

interface AgentRow {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  deployments: Array<{
    id: string;
    status: string;
    replicas: number;
    modelDeploymentId: string | null;
  }>;
  listing: {
    agentToken: {
      treasury: {
        treasuryPdaAddress: string;
        solBalanceLamports: bigint;
      } | null;
    } | null;
  } | null;
}

export async function loadAgentSnapshotByPrisma(
  input: LoadAgentSnapshotInput,
  deps: LoadAgentSnapshotDeps,
): Promise<AgentRunwaySnapshot | null> {
  const agent = (await deps.prisma.agent.findFirst({
    where: { slug: input.slug, orgId: input.orgId },
    include: {
      deployments: {
        select: {
          id: true,
          status: true,
          replicas: true,
          modelDeploymentId: true,
        },
      },
      listing: {
        select: {
          agentToken: {
            select: {
              treasury: {
                select: {
                  treasuryPdaAddress: true,
                  solBalanceLamports: true,
                },
              },
            },
          },
        },
      },
    },
  })) as AgentRow | null;

  if (!agent) return null;

  const activeDeployments = agent.deployments.filter(
    (d) => d.status === "running",
  );
  const modelDeploymentIds = Array.from(
    new Set(
      activeDeployments
        .map((d) => d.modelDeploymentId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  const cutoff = new Date(
    input.now.getTime() - input.lookbackSeconds * 1000,
  );

  const usageRecords =
    modelDeploymentIds.length > 0
      ? await deps.prisma.usageRecord.findMany({
          where: {
            orgId: input.orgId,
            deploymentId: { in: modelDeploymentIds },
            periodEnd: { gte: cutoff },
          },
          select: {
            periodStart: true,
            periodEnd: true,
            computeSeconds: true,
            actualCostCents: true,
          },
        })
      : [];

  const replicaSum = activeDeployments.reduce(
    (sum, d) => sum + (d.replicas ?? 0),
    0,
  );
  const currentReplicas = replicaSum > 0 ? replicaSum : 1;

  const treasury = agent.listing?.agentToken?.treasury ?? null;

  return {
    agent: { id: agent.id, name: agent.name, slug: agent.slug },
    treasuryBalanceLamports: treasury?.solBalanceLamports ?? 0n,
    treasuryAddress: treasury?.treasuryPdaAddress ?? null,
    usageRecords,
    currentReplicas,
    maxReplicas: deps.maxReplicas ?? DEFAULT_MAX_REPLICAS,
  };
}
