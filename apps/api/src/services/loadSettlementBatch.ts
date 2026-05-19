/**
 * Prisma-backed loadSettlementBatch (plan A3).
 *
 * The BullMQ treasury-settlement worker calls this each tick to find every
 * tokenized agent whose treasury is due for an auto-pay run. Returns the
 * same {deployments, treasuries} shape the orchestrator
 * (treasurySettlementCycle) consumes.
 *
 * Eligibility rules (mirrored in tests):
 *   - AgentDeployment.status === "running"
 *   - Agent has a listing
 *   - listing.agentToken exists                    (tokenized agent)
 *   - agentToken.treasury exists                   (treasury PDA initialized)
 *   - treasury.lastComputeBillAt is null OR
 *     before (now - intervalMs)                    (cooldown elapsed)
 *
 * The cooldown filter is applied in code rather than in the SQL where-clause
 * so the same loader works against test stubs (which don't translate Prisma
 * query operators) without diverging from production behavior.
 */

import type {
  DeploymentForSettlement,
  TreasuryForSettlement,
} from "./treasurySettlement.js";

interface PrismaAgentDeploymentRow {
  id: string;
  status: string;
  gpuTier: string;
  nosanaJobIds: string[];
  replicas: number;
  agent: {
    id: string;
    orgId: string;
    listing: {
      agentToken: {
        id: string;
        treasury: {
          id: string;
          tokenId: string;
          treasuryPdaAddress: string;
          solBalanceLamports: bigint;
          lastComputeBillAt: Date | null;
        } | null;
      } | null;
    } | null;
  };
}

interface PrismaStub {
  agentDeployment: {
    findMany: (args: {
      where: { status: string };
      include: unknown;
    }) => Promise<PrismaAgentDeploymentRow[]>;
  };
}

export interface LoadSettlementBatchInput {
  now: Date;
  intervalMs: number;
}

export interface LoadSettlementBatchDeps {
  prisma: PrismaStub;
}

export async function loadSettlementBatchByPrisma(
  input: LoadSettlementBatchInput,
  deps: LoadSettlementBatchDeps,
): Promise<{
  deployments: DeploymentForSettlement[];
  treasuries: Map<string, TreasuryForSettlement>;
}> {
  const cutoff = new Date(input.now.getTime() - input.intervalMs);

  const rows = await deps.prisma.agentDeployment.findMany({
    where: { status: "running" },
    include: {
      agent: {
        select: {
          id: true,
          orgId: true,
          listing: {
            select: {
              agentToken: {
                select: {
                  id: true,
                  treasury: {
                    select: {
                      id: true,
                      tokenId: true,
                      treasuryPdaAddress: true,
                      solBalanceLamports: true,
                      lastComputeBillAt: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const deployments: DeploymentForSettlement[] = [];
  const treasuries = new Map<string, TreasuryForSettlement>();

  for (const row of rows) {
    const token = row.agent.listing?.agentToken;
    if (!token) continue;
    const treasury = token.treasury;
    if (!treasury) continue;

    const dueByCooldown =
      treasury.lastComputeBillAt === null ||
      treasury.lastComputeBillAt < cutoff;
    if (!dueByCooldown) continue;

    deployments.push({
      id: row.id,
      orgId: row.agent.orgId,
      gpuTier: row.gpuTier,
      nosanaJobIds: row.nosanaJobIds,
      replicas: row.replicas,
      agentTokenId: token.id,
    });

    treasuries.set(token.id, {
      id: treasury.id,
      tokenId: treasury.tokenId,
      treasuryPdaAddress: treasury.treasuryPdaAddress,
      solBalanceLamports: treasury.solBalanceLamports,
      lastComputeBillAt: treasury.lastComputeBillAt,
    });
  }

  return { deployments, treasuries };
}
