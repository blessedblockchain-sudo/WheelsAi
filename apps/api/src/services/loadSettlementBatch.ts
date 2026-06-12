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
 *   - treasury.balanceSyncedAt is non-null AND
 *     within maxBalanceStalenessMs of now          (balance mirror fresh, D1)
 *
 * Staleness guard (remediation D1): solBalanceLamports is a MIRROR of the
 * on-chain PDA balance written by runTreasuryBalanceSyncTick. A treasury
 * that was never synced (balanceSyncedAt null — the column default) or
 * whose sync is older than maxBalanceStalenessMs is SKIPPED, never settled
 * — settling on a stale mirror would mark payments FAILED
 * ('insufficient_funds') off garbage data, or worse, schedule a payment a
 * drained treasury can't cover. Skipped rows surface in the returned
 * skippedStale counter so the cycle can report them.
 *
 * The cooldown + staleness filters are applied in code rather than in the
 * SQL where-clause so the same loader works against test stubs (which don't
 * translate Prisma query operators) without diverging from production
 * behavior.
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
          balanceSyncedAt: Date | null;
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

/** Default ceiling on balance-mirror age before a treasury is skipped.
 * 5 minutes: the balance-sync tick runs at the top of every settlement
 * cycle, so anything older means the sync has been failing repeatedly. */
export const DEFAULT_MAX_BALANCE_STALENESS_MS = 5 * 60 * 1000;

export interface LoadSettlementBatchInput {
  now: Date;
  intervalMs: number;
  /** Override for tests / config; defaults to DEFAULT_MAX_BALANCE_STALENESS_MS. */
  maxBalanceStalenessMs?: number;
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
  /** Treasuries excluded because their balance mirror was never synced or
   * is older than maxBalanceStalenessMs (D1 staleness guard). */
  skippedStale: number;
}> {
  const cutoff = new Date(input.now.getTime() - input.intervalMs);
  const maxBalanceStalenessMs =
    input.maxBalanceStalenessMs ?? DEFAULT_MAX_BALANCE_STALENESS_MS;
  const staleCutoff = new Date(input.now.getTime() - maxBalanceStalenessMs);

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
                      balanceSyncedAt: true,
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
  let skippedStale = 0;

  for (const row of rows) {
    const token = row.agent.listing?.agentToken;
    if (!token) continue;
    const treasury = token.treasury;
    if (!treasury) continue;

    const dueByCooldown =
      treasury.lastComputeBillAt === null ||
      treasury.lastComputeBillAt < cutoff;
    if (!dueByCooldown) continue;

    // D1 staleness guard: a never-synced or stale balance mirror means
    // SKIP — never "assume 0" (which would record a phantom
    // insufficient_funds failure) and never trust a number the chain
    // may have moved past.
    const mirrorFresh =
      treasury.balanceSyncedAt !== null &&
      treasury.balanceSyncedAt >= staleCutoff;
    if (!mirrorFresh) {
      skippedStale += 1;
      continue;
    }

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

  return { deployments, treasuries, skippedStale };
}
