import { prisma } from "@wheelsai/db";

import {
  summarizeAgentUsage,
  type AgentUsageRow,
  type AgentUsageSummary,
} from "./agentUsage.js";
import {
  groupedLatencyLoader,
  scopedLatencyLoader,
  type ScopedLatency,
} from "./buildLatencySampleDeps.js";
import type { LatencyGroup, ScopedWindow } from "./latencyQueries.js";
import { agentSurface, type LatencyOutcome } from "./latencySamples.js";

const defaultDb = prisma;

// ============================================
// Latency
// ============================================

/**
 * Every latency in analytics is read from the per-request samples
 * (request_latency_samples): the end-to-end time of answered requests, with
 * exact percentiles. A period with no sample has no latency - null, never
 * 0 ms and never an average of hourly averages.
 */
export interface AnalyticsLatencyReader {
  loadScopedLatency(window: ScopedWindow): Promise<ScopedLatency>;
  loadGroupedLatency(window: ScopedWindow, groupBy: LatencyGroup): Promise<Map<string, ScopedLatency>>;
}

const sampleLatency: AnalyticsLatencyReader = {
  loadScopedLatency: scopedLatencyLoader(),
  loadGroupedLatency: groupedLatencyLoader(),
};

// An injected database has no sample table behind it: nothing is measured.
const noLatency: AnalyticsLatencyReader = {
  loadScopedLatency: async () => ({ sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null }),
  loadGroupedLatency: async () => new Map(),
};

// Analytics states how fast answers were, so only answered requests count.
const ANSWERED: readonly LatencyOutcome[] = ["ok"];

// ============================================
// Real-time Analytics
// ============================================

export interface UsageMetrics {
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostCents: number;
  /** End-to-end time of answered requests; null when none was measured. */
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /** The answered requests the three figures above are computed over. */
  latencySampleCount: number;
  errorRate: number;
}

export interface TimeSeriesPoint {
  timestamp: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  errors: number;
}

export interface DeploymentMetrics {
  deploymentId: string;
  deploymentName: string;
  modelId: string;
  status: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  /** null when no answered request of this deployment was measured. */
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  errorRate: number;
}

/**
 * Get usage overview for an organization
 */
export async function getUsageOverview(
  orgId: string,
  periodDays: number = 30,
  latencyReader: AnalyticsLatencyReader = sampleLatency,
): Promise<UsageMetrics> {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - periodDays);

  const records = await prisma.usageRecord.findMany({
    where: {
      orgId,
      periodStart: { gte: startDate },
    },
  });

  const totalRequests = records.reduce((sum, r) => sum + r.requestCount, 0);
  const totalTokensIn = records.reduce((sum, r) => sum + Number(r.inputTokens), 0);
  const totalTokensOut = records.reduce((sum, r) => sum + Number(r.outputTokens), 0);
  const totalCostCents = records.reduce((sum, r) => sum + Number(r.costCents), 0);
  const totalErrors = records.reduce((sum, r) => sum + r.errorCount, 0);
  const latency = await latencyReader.loadScopedLatency({
    orgId,
    since: startDate,
    until: now,
    outcomes: ANSWERED,
  });

  return {
    totalRequests,
    totalTokensIn,
    totalTokensOut,
    totalCostCents,
    avgLatencyMs: latency.avgMs,
    p50LatencyMs: latency.p50Ms,
    p95LatencyMs: latency.p95Ms,
    latencySampleCount: latency.sampleCount,
    errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
  };
}

/**
 * Get usage time series for charts
 */
export async function getUsageTimeSeries(
  orgId: string,
  periodDays: number = 30,
  granularity: "hourly" | "daily" = "daily"
): Promise<TimeSeriesPoint[]> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - periodDays);

  const records = await prisma.usageRecord.findMany({
    where: {
      orgId,
      periodStart: { gte: startDate },
    },
    orderBy: { periodStart: "asc" },
  });

  if (granularity === "hourly") {
    return records.map((r) => ({
      timestamp: r.periodStart.toISOString(),
      requests: r.requestCount,
      tokensIn: Number(r.inputTokens),
      tokensOut: Number(r.outputTokens),
      costCents: Number(r.costCents),
      errors: r.errorCount,
    }));
  }

  // Aggregate by day
  const dailyMap = new Map<string, TimeSeriesPoint>();
  for (const record of records) {
    const day = record.periodStart.toISOString().split("T")[0] ?? record.periodStart.toISOString();
    const existing = dailyMap.get(day) || {
      timestamp: day,
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
      errors: 0,
    };

    existing.requests += record.requestCount;
    existing.tokensIn += Number(record.inputTokens);
    existing.tokensOut += Number(record.outputTokens);
    existing.costCents += Number(record.costCents);
    existing.errors += record.errorCount;

    dailyMap.set(day, existing);
  }

  return Array.from(dailyMap.values());
}

/**
 * Get per-deployment metrics
 */
export async function getDeploymentMetrics(
  orgId: string,
  periodDays: number = 30,
  latencyReader: AnalyticsLatencyReader = sampleLatency,
): Promise<DeploymentMetrics[]> {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - periodDays);

  const deployments = await prisma.deployment.findMany({
    where: { orgId },
    include: {
      usageRecords: {
        where: { periodStart: { gte: startDate } },
      },
    },
  });

  const latencyByDeployment = await latencyReader.loadGroupedLatency(
    { orgId, since: startDate, until: now, outcomes: ANSWERED },
    "deployment",
  );

  return deployments.map((d) => {
    const totalRequests = d.usageRecords.reduce((sum, r) => sum + r.requestCount, 0);
    const latency = latencyByDeployment.get(d.id);
    const totalErrors = d.usageRecords.reduce((sum, r) => sum + r.errorCount, 0);

    return {
      deploymentId: d.id,
      deploymentName: d.name,
      modelId: d.modelId,
      status: d.status,
      requests: totalRequests,
      tokensIn: d.usageRecords.reduce((sum, r) => sum + Number(r.inputTokens), 0),
      tokensOut: d.usageRecords.reduce((sum, r) => sum + Number(r.outputTokens), 0),
      costCents: d.usageRecords.reduce((sum, r) => sum + Number(r.costCents), 0),
      avgLatencyMs: latency?.avgMs ?? null,
      p50LatencyMs: latency?.p50Ms ?? null,
      p95LatencyMs: latency?.p95Ms ?? null,
      errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
    };
  });
}

/**
 * Get cost breakdown by model
 */
export async function getCostByModel(
  orgId: string,
  periodDays: number = 30
): Promise<Array<{ modelId: string; costCents: number; requests: number }>> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - periodDays);

  const deployments = await prisma.deployment.findMany({
    where: { orgId },
    include: {
      usageRecords: {
        where: { periodStart: { gte: startDate } },
      },
    },
  });

  const modelMap = new Map<string, { costCents: number; requests: number }>();

  for (const d of deployments) {
    const existing = modelMap.get(d.modelId) || { costCents: 0, requests: 0 };
    existing.costCents += d.usageRecords.reduce(
      (sum, r) => sum + Number(r.costCents),
      0
    );
    existing.requests += d.usageRecords.reduce((sum, r) => sum + r.requestCount, 0);
    modelMap.set(d.modelId, existing);
  }

  return Array.from(modelMap.entries())
    .map(([modelId, data]) => ({ modelId, ...data }))
    .sort((a, b) => b.costCents - a.costCents);
}

/**
 * Get cost breakdown by GPU tier
 */
export async function getCostByGpuTier(
  orgId: string,
  periodDays: number = 30
): Promise<Array<{ gpuTier: string; costCents: number; requests: number }>> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - periodDays);

  const deployments = await prisma.deployment.findMany({
    where: { orgId },
    include: {
      usageRecords: {
        where: { periodStart: { gte: startDate } },
      },
    },
  });

  const tierMap = new Map<string, { costCents: number; requests: number }>();

  for (const d of deployments) {
    const existing = tierMap.get(d.gpuTier) || { costCents: 0, requests: 0 };
    existing.costCents += d.usageRecords.reduce(
      (sum, r) => sum + Number(r.costCents),
      0
    );
    existing.requests += d.usageRecords.reduce((sum, r) => sum + r.requestCount, 0);
    tierMap.set(d.gpuTier, existing);
  }

  return Array.from(tierMap.entries())
    .map(([gpuTier, data]) => ({ gpuTier, ...data }))
    .sort((a, b) => b.costCents - a.costCents);
}

// ============================================
// Analytics Snapshots (Historical)
// ============================================

type SnapshotDb = Pick<
  typeof prisma,
  "usageRecord" | "agentUsageRecord" | "deployment" | "agentDeployment" | "analyticsSnapshot"
>;

/**
 * Create a daily analytics snapshot
 */
export async function createDailySnapshot(
  orgId: string,
  date: Date,
  options: { db?: SnapshotDb; latency?: AnalyticsLatencyReader } = {},
) {
  const prisma = options.db ?? defaultDb;
  const latencyReader = options.latency ?? (options.db ? noLatency : sampleLatency);

  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const records = await prisma.usageRecord.findMany({
    where: {
      orgId,
      periodStart: { gte: startOfDay, lte: endOfDay },
    },
  });

  // Agent chat traffic (playground and /v1). It runs on the platform's chat
  // runtime, not on a model deployment, so none of it is in `records`.
  const agentChatRows = await prisma.agentUsageRecord.findMany({
    where: { orgId, periodStart: { gte: startOfDay, lte: endOfDay } },
  });

  if (records.length === 0 && agentChatRows.length === 0) return null;

  const totalRequests = records.reduce((sum, r) => sum + r.requestCount, 0);
  const totalTokensIn = records.reduce((sum, r) => sum + Number(r.inputTokens), 0);
  const totalTokensOut = records.reduce((sum, r) => sum + Number(r.outputTokens), 0);
  const totalCostCents = records.reduce((sum, r) => sum + Number(r.costCents), 0);
  const totalErrors = records.reduce((sum, r) => sum + r.errorCount, 0);

  // The day's latency, from the requests themselves. These columns used to
  // hold percentiles of each hour's mean, which are not percentiles of
  // anything a caller experienced.
  const day: ScopedWindow = {
    orgId,
    since: startOfDay,
    until: new Date(endOfDay.getTime() + 1),
    outcomes: ANSWERED,
  };
  const dayLatency = await latencyReader.loadScopedLatency(day);
  const latencyByAgent = await latencyReader.loadGroupedLatency(day, "agent");
  const latencyColumns = {
    avgLatencyMs: dayLatency.avgMs,
    p50LatencyMs: dayLatency.p50Ms,
    p95LatencyMs: dayLatency.p95Ms,
    p99LatencyMs: dayLatency.p99Ms,
  };

  // Get deployment stats
  const deploymentStats: Record<string, any> = {};
  const deployments = await prisma.deployment.findMany({
    where: { orgId },
    include: {
      usageRecords: {
        where: { periodStart: { gte: startOfDay, lte: endOfDay } },
      },
    },
  });

  for (const d of deployments) {
    if (d.usageRecords.length > 0) {
      deploymentStats[d.id] = {
        requests: d.usageRecords.reduce((sum, r) => sum + r.requestCount, 0),
        tokensIn: d.usageRecords.reduce((sum, r) => sum + Number(r.inputTokens), 0),
        tokensOut: d.usageRecords.reduce((sum, r) => sum + Number(r.outputTokens), 0),
        costCents: d.usageRecords.reduce((sum, r) => sum + Number(r.costCents), 0),
      };
    }
  }

  // Per-AGENT rollup (Wave 1): the agentStats column existed with no
  // writer, which is why per-agent analytics had to be retitled
  // "Workspace Analytics" (INT-B3). Agents reach usage through their
  // AgentDeployment.modelDeploymentId join.
  const agentStats: Record<string, any> = {};
  const agentDeployments = await prisma.agentDeployment.findMany({
    where: { agent: { orgId }, modelDeploymentId: { not: null } },
    select: { agentId: true, modelDeploymentId: true },
  });
  for (const link of agentDeployments) {
    const stats = link.modelDeploymentId
      ? deploymentStats[link.modelDeploymentId]
      : undefined;
    if (!stats) continue;
    const existing = agentStats[link.agentId] ?? {
      requests: 0,
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    };
    existing.requests += stats.requests;
    existing.tokensIn += stats.tokensIn;
    existing.tokensOut += stats.tokensOut;
    existing.costCents += stats.costCents;
    agentStats[link.agentId] = existing;
  }

  // The agent's own chat traffic sits next to the deployment-derived numbers
  // under `chat`, not added into them: the top-level totals of this snapshot
  // are model-deployment usage (they carry a cost), and an agent that chats
  // on a deployment of its own would otherwise be counted twice.
  const chatRowsByAgent = new Map<string, AgentUsageRow[]>();
  for (const row of agentChatRows) {
    const rows = chatRowsByAgent.get(row.agentId) ?? [];
    rows.push(row);
    chatRowsByAgent.set(row.agentId, rows);
  }
  for (const [agentId, rows] of chatRowsByAgent) {
    agentStats[agentId] = {
      ...(agentStats[agentId] ?? { requests: 0, tokensIn: 0, tokensOut: 0, costCents: 0 }),
      chat: summarizeAgentUsage(rows, latencyByAgent.get(agentId) ?? null),
    };
  }

  return prisma.analyticsSnapshot.upsert({
    where: {
      orgId_snapshotType_periodStart: {
        orgId,
        snapshotType: "daily",
        periodStart: startOfDay,
      },
    },
    create: {
      orgId,
      snapshotType: "daily",
      periodStart: startOfDay,
      periodEnd: endOfDay,
      totalRequests: BigInt(totalRequests),
      totalTokensIn: BigInt(totalTokensIn),
      totalTokensOut: BigInt(totalTokensOut),
      totalCostCents: BigInt(totalCostCents),
      ...latencyColumns,
      errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : null,
      deploymentStats,
      agentStats,
    },
    update: {
      totalRequests: BigInt(totalRequests),
      totalTokensIn: BigInt(totalTokensIn),
      totalTokensOut: BigInt(totalTokensOut),
      totalCostCents: BigInt(totalCostCents),
      ...latencyColumns,
      errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : null,
      deploymentStats,
      agentStats,
    },
  });
}

/**
 * Get historical snapshots
 */
export async function getHistoricalSnapshots(
  orgId: string,
  snapshotType: "daily" | "weekly" | "monthly" = "daily",
  limit: number = 30
) {
  return prisma.analyticsSnapshot.findMany({
    where: { orgId, snapshotType },
    orderBy: { periodStart: "desc" },
    take: limit,
  });
}

// ============================================
// Cost Projections
// ============================================

/**
 * Project costs for the current billing period
 */
export async function projectMonthlyCost(orgId: string): Promise<{
  currentSpend: number;
  projectedSpend: number;
  daysRemaining: number;
  dailyAverage: number;
}> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const daysInMonth = endOfMonth.getDate();
  const daysPassed = now.getDate();
  const daysRemaining = daysInMonth - daysPassed;

  const records = await prisma.usageRecord.findMany({
    where: {
      orgId,
      periodStart: { gte: startOfMonth },
    },
  });

  // Usage records carry the per-token cost of a request. A dedicated (GPU)
  // deployment is billed per GPU-second instead - its requests record a zero
  // cost, and the charge exists only as `gpu_usage` debits in the ledger - so
  // those are added here, or such an org would appear to spend nothing.
  const gpuUsage = await prisma.creditTransaction.aggregate({
    where: { orgId, type: "gpu_usage", createdAt: { gte: startOfMonth } },
    _sum: { amountCents: true },
  });
  const gpuSpend = -Number(gpuUsage._sum.amountCents ?? 0n);

  const currentSpend =
    records.reduce((sum, r) => sum + Number(r.costCents), 0) + gpuSpend;
  const dailyAverage = daysPassed > 0 ? currentSpend / daysPassed : 0;
  const projectedSpend = currentSpend + dailyAverage * daysRemaining;

  return {
    currentSpend,
    projectedSpend: Math.round(projectedSpend),
    daysRemaining,
    dailyAverage: Math.round(dailyAverage),
  };
}

/**
 * Get spending alerts
 */
export async function getSpendingAlerts(
  orgId: string,
  budgetCents: number
): Promise<
  Array<{
    type: "warning" | "critical";
    message: string;
    percentage: number;
  }>
> {
  const alerts: Array<{
    type: "warning" | "critical";
    message: string;
    percentage: number;
  }> = [];

  const projection = await projectMonthlyCost(orgId);
  const currentPercentage = (projection.currentSpend / budgetCents) * 100;
  const projectedPercentage = (projection.projectedSpend / budgetCents) * 100;

  if (currentPercentage >= 100) {
    alerts.push({
      type: "critical",
      message: "You have exceeded your monthly budget",
      percentage: currentPercentage,
    });
  } else if (currentPercentage >= 80) {
    alerts.push({
      type: "warning",
      message: "You have used 80% of your monthly budget",
      percentage: currentPercentage,
    });
  }

  if (projectedPercentage >= 150 && currentPercentage < 100) {
    alerts.push({
      type: "critical",
      message: `At current rate, you'll spend ${Math.round(projectedPercentage)}% of budget`,
      percentage: projectedPercentage,
    });
  } else if (projectedPercentage >= 100 && currentPercentage < 80) {
    alerts.push({
      type: "warning",
      message: `Projected to exceed budget by end of month`,
      percentage: projectedPercentage,
    });
  }

  return alerts;
}

// ============================================
// Agent chat usage
// ============================================

export const AGENT_USAGE_PERIODS = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 } as const;
export type AgentUsagePeriod = keyof typeof AGENT_USAGE_PERIODS;

export interface AgentChatUsage {
  period: AgentUsagePeriod;
  since: string;
  /** Everything in the period. */
  total: AgentUsageSummary;
  /** The same, per entry point ('playground', 'api', ...). */
  bySource: Record<string, AgentUsageSummary>;
  /** One point per UTC hour that had traffic, oldest first. */
  series: Array<{
    periodStart: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

type AgentUsageReader = Pick<typeof prisma, "agentUsageRecord">;

/** "agent_playground" -> "playground": a sample's surface back to its source. */
function sourceOfSurface(surface: string, sources: Iterable<string>): string | null {
  for (const source of sources) if (agentSurface(source) === surface) return source;
  return null;
}

/**
 * An agent's chat traffic over a period, from the hourly rollup the shared
 * agent-chat service writes. Scoped by BOTH ids: a row is only ever read for
 * the organization that owns the agent.
 */
export async function getAgentChatUsage(
  orgId: string,
  agentId: string,
  period: AgentUsagePeriod,
  options: { db?: AgentUsageReader; now?: Date; latency?: AnalyticsLatencyReader } = {},
): Promise<AgentChatUsage> {
  const db = options.db ?? prisma;
  const latencyReader = options.latency ?? (options.db ? noLatency : sampleLatency);
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - AGENT_USAGE_PERIODS[period] * 60 * 60 * 1000);

  const rows = await db.agentUsageRecord.findMany({
    where: { orgId, agentId, periodStart: { gte: since } },
    orderBy: { periodStart: "asc" },
  });

  const bySourceRows = new Map<string, typeof rows>();
  const byHour = new Map<string, typeof rows>();
  for (const row of rows) {
    bySourceRows.set(row.source, [...(bySourceRows.get(row.source) ?? []), row]);
    const hour = row.periodStart.toISOString();
    byHour.set(hour, [...(byHour.get(hour) ?? []), row]);
  }

  // The agent's own chats: bound to the organization AND the agent, like the
  // rows above. Percentiles do not add up, so the total is its own read.
  const window: ScopedWindow = { orgId, agentId, since, until: now, outcomes: ANSWERED };
  const [totalLatency, latencyBySurface] = await Promise.all([
    latencyReader.loadScopedLatency(window),
    latencyReader.loadGroupedLatency(window, "surface"),
  ]);
  const latencyBySource = new Map<string, ScopedLatency>();
  for (const [surface, latency] of latencyBySurface) {
    const source = sourceOfSurface(surface, bySourceRows.keys());
    if (source !== null) latencyBySource.set(source, latency);
  }

  const bySource: Record<string, AgentUsageSummary> = {};
  for (const [source, sourceRows] of bySourceRows) {
    bySource[source] = summarizeAgentUsage(sourceRows, latencyBySource.get(source) ?? null);
  }

  return {
    period,
    since: since.toISOString(),
    total: summarizeAgentUsage(rows, totalLatency),
    bySource,
    series: [...byHour.entries()].map(([periodStart, hourRows]) => {
      const hour = summarizeAgentUsage(hourRows);
      return {
        periodStart,
        requests: hour.requests,
        errors: hour.errors,
        inputTokens: hour.inputTokens,
        outputTokens: hour.outputTokens,
      };
    }),
  };
}
