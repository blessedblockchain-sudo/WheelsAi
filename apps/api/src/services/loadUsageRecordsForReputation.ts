/**
 * Prisma-backed loadUsageRecordsForReputation (plan A4 — publisher worker
 * data dependency).
 *
 * Resolves the UsageRecord rows the reputation aggregation needs:
 *   Agent (id + orgId, scoped)
 *     → AgentDeployment[].modelDeploymentId  (deduped, non-null only)
 *   UsageRecord
 *     where deploymentId ∈ those ids
 *       AND orgId = orgId                     (multi-tenant safety)
 *       AND periodEnd  >= periodStart          (record didn't end before window)
 *       AND periodStart <  periodEnd           (record didn't start after window)
 *
 * That overlap predicate matches what aggregateReputationPeriod expects:
 * any record that touches the window in any way is included.
 *
 * Empty-set short-circuit: if the agent has no model deployments, the
 * UsageRecord query is skipped — Postgres rejects a literal `IN ()` clause
 * and we'd waste the round-trip anyway.
 */

import type { UsageRecordForAggregation } from "./reputationAggregation.js";

interface AgentRow {
  id: string;
  orgId: string;
  deployments: Array<{
    status: string;
    modelDeploymentId: string | null;
  }>;
}

interface UsageRow {
  periodStart: Date;
  periodEnd: Date;
  requestCount: number;
  errorCount: number;
  computeSeconds: bigint;
}

interface PrismaStub {
  agent: {
    findFirst: (args: {
      where: { id: string; orgId: string };
      include: unknown;
    }) => Promise<AgentRow | null>;
  };
  usageRecord: {
    findMany: (args: {
      where: {
        orgId: string;
        deploymentId: { in: string[] };
        periodEnd: { gte: Date };
        periodStart: { lt: Date };
      };
      select: unknown;
    }) => Promise<UsageRow[]>;
  };
}

export interface LoadUsageRecordsInput {
  agentId: string;
  orgId: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface LoadUsageRecordsDeps {
  prisma: PrismaStub;
}

export async function loadUsageRecordsForReputation(
  input: LoadUsageRecordsInput,
  deps: LoadUsageRecordsDeps,
): Promise<UsageRecordForAggregation[]> {
  const agent = await deps.prisma.agent.findFirst({
    where: { id: input.agentId, orgId: input.orgId },
    include: {
      deployments: {
        select: { status: true, modelDeploymentId: true },
      },
    },
  });
  if (!agent) return [];

  const modelIds = Array.from(
    new Set(
      agent.deployments
        .map((d) => d.modelDeploymentId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  if (modelIds.length === 0) return [];

  const rows = await deps.prisma.usageRecord.findMany({
    where: {
      orgId: input.orgId,
      deploymentId: { in: modelIds },
      periodEnd: { gte: input.periodStart },
      periodStart: { lt: input.periodEnd },
    },
    select: {
      periodStart: true,
      periodEnd: true,
      requestCount: true,
      errorCount: true,
      computeSeconds: true,
    },
  });

  return rows.map((r) => ({
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    requestCount: r.requestCount,
    errorCount: r.errorCount,
    computeSeconds: r.computeSeconds,
  }));
}
