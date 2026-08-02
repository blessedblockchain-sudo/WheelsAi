import { prisma } from "@wheelsai/db";

// ============================================
// Real-time Analytics
// ============================================

export interface UsageMetrics {
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostCents: number;
  avgLatencyMs: number;
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
  avgLatencyMs: number;
  errorRate: number;
}

/**
 * Get usage overview for an organization
 */
export async function getUsageOverview(
  orgId: string,
  periodDays: number = 30
): Promise<UsageMetrics> {
  const startDate = new Date();
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
  const totalLatency = records.reduce((sum, r) => sum + Number(r.totalLatencyMs), 0);
  const totalErrors = records.reduce((sum, r) => sum + r.errorCount, 0);

  return {
    totalRequests,
    totalTokensIn,
    totalTokensOut,
    totalCostCents,
    avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
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
  periodDays: number = 30
): Promise<DeploymentMetrics[]> {
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

  return deployments.map((d) => {
    const totalRequests = d.usageRecords.reduce((sum, r) => sum + r.requestCount, 0);
    const totalLatency = d.usageRecords.reduce(
      (sum, r) => sum + Number(r.totalLatencyMs),
      0
    );
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
      avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
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

/**
 * Create a daily analytics snapshot
 */
export async function createDailySnapshot(orgId: string, date: Date) {
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

  if (records.length === 0) return null;

  const totalRequests = records.reduce((sum, r) => sum + r.requestCount, 0);
  const totalTokensIn = records.reduce((sum, r) => sum + Number(r.inputTokens), 0);
  const totalTokensOut = records.reduce((sum, r) => sum + Number(r.outputTokens), 0);
  const totalCostCents = records.reduce((sum, r) => sum + Number(r.costCents), 0);
  const totalLatency = records.reduce((sum, r) => sum + Number(r.totalLatencyMs), 0);
  const totalErrors = records.reduce((sum, r) => sum + r.errorCount, 0);

  // Calculate latency percentiles (simplified)
  const latencies = records
    .filter((r) => r.requestCount > 0)
    .map((r) => Number(r.totalLatencyMs) / r.requestCount);
  latencies.sort((a, b) => a - b);

  const p50Index = Math.floor(latencies.length * 0.5);
  const p95Index = Math.floor(latencies.length * 0.95);
  const p99Index = Math.floor(latencies.length * 0.99);

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
      avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : null,
      p50LatencyMs: latencies[p50Index] || null,
      p95LatencyMs: latencies[p95Index] || null,
      p99LatencyMs: latencies[p99Index] || null,
      errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : null,
      deploymentStats,
      agentStats,
    },
    update: {
      totalRequests: BigInt(totalRequests),
      totalTokensIn: BigInt(totalTokensIn),
      totalTokensOut: BigInt(totalTokensOut),
      totalCostCents: BigInt(totalCostCents),
      avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : null,
      p50LatencyMs: latencies[p50Index] || null,
      p95LatencyMs: latencies[p95Index] || null,
      p99LatencyMs: latencies[p99Index] || null,
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

  const currentSpend = records.reduce((sum, r) => sum + Number(r.costCents), 0);
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
