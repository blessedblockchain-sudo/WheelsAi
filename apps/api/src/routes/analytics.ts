import { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.js";
import {
  getUsageOverview,
  getUsageTimeSeries,
  getDeploymentMetrics,
  getCostByModel,
  getCostByGpuTier,
  getHistoricalSnapshots,
  projectMonthlyCost,
  getSpendingAlerts,
} from "../services/analytics.js";
import { assertFeature } from "../services/orgPlan.js";
import {
  clampExportDays,
  DAILY_COLUMNS,
  DEPLOYMENT_COLUMNS,
  toCsv,
} from "../services/analyticsExport.js";

export async function analyticsRoutes(app: FastifyInstance) {
  // All analytics routes require authentication
  app.addHook("preHandler", authenticate);

  // Get usage overview
  app.get("/overview", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { days } = request.query as { days?: string };

    const periodDays = days ? parseInt(days) : 30;
    const metrics = await getUsageOverview(orgId, periodDays);

    return reply.send({
      success: true,
      data: metrics,
      period: { days: periodDays },
    });
  });

  // Get usage time series for charts
  app.get("/timeseries", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { days, granularity } = request.query as {
      days?: string;
      granularity?: "hourly" | "daily";
    };

    const periodDays = days ? parseInt(days) : 30;
    const data = await getUsageTimeSeries(
      orgId,
      periodDays,
      granularity || "daily"
    );

    return reply.send({
      success: true,
      data,
      period: { days: periodDays, granularity: granularity || "daily" },
    });
  });

  // Get per-deployment metrics
  app.get("/deployments", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { days } = request.query as { days?: string };

    const periodDays = days ? parseInt(days) : 30;
    const deployments = await getDeploymentMetrics(orgId, periodDays);

    return reply.send({
      success: true,
      data: deployments,
      period: { days: periodDays },
    });
  });

  // Get cost breakdown by model
  app.get("/costs/by-model", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { days } = request.query as { days?: string };

    const periodDays = days ? parseInt(days) : 30;
    const costs = await getCostByModel(orgId, periodDays);

    return reply.send({
      success: true,
      data: costs,
      period: { days: periodDays },
    });
  });

  // Get cost breakdown by GPU tier
  app.get("/costs/by-gpu", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { days } = request.query as { days?: string };

    const periodDays = days ? parseInt(days) : 30;
    const costs = await getCostByGpuTier(orgId, periodDays);

    return reply.send({
      success: true,
      data: costs,
      period: { days: periodDays },
    });
  });

  // Get historical snapshots
  app.get("/history", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { type, limit } = request.query as {
      type?: "daily" | "weekly" | "monthly";
      limit?: string;
    };

    const snapshots = await getHistoricalSnapshots(
      orgId,
      type || "daily",
      limit ? parseInt(limit) : 30
    );

    return reply.send({
      success: true,
      data: snapshots.map((s) => ({
        ...s,
        totalRequests: Number(s.totalRequests),
        totalTokensIn: Number(s.totalTokensIn),
        totalTokensOut: Number(s.totalTokensOut),
        totalCostCents: Number(s.totalCostCents),
      })),
    });
  });

  // Get cost projection for current month
  app.get("/projection", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };

    const projection = await projectMonthlyCost(orgId);

    return reply.send({
      success: true,
      data: projection,
    });
  });

  // Get spending alerts
  app.get("/alerts", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { budget } = request.query as { budget?: string };

    // Default budget of $100 if not specified
    const budgetCents = budget ? parseInt(budget) * 100 : 10000;
    const alerts = await getSpendingAlerts(orgId, budgetCents);

    return reply.send({
      success: true,
      data: alerts,
    });
  });

  // Export usage as CSV or JSON (Pro and above)
  app.get("/export", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const query = request.query as { days?: string; format?: string; dataset?: string };
    const days = clampExportDays(query.days);
    const format = query.format === "json" ? "json" : "csv";
    const dataset = query.dataset === "deployments" ? "deployments" : "daily";

    await assertFeature(orgId, "advancedAnalytics", "Analytics export");

    const rows =
      dataset === "deployments"
        ? await getDeploymentMetrics(orgId, days)
        : await getUsageTimeSeries(orgId, days, "daily");
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `wheelsai-${dataset}-${days}d-${stamp}.${format}`;

    reply.header("content-disposition", `attachment; filename="${filename}"`);
    if (format === "json") {
      return reply.type("application/json").send({ dataset, period: { days }, rows });
    }
    const csv =
      dataset === "deployments"
        ? toCsv(rows as unknown as Record<string, unknown>[], DEPLOYMENT_COLUMNS as never)
        : toCsv(rows as unknown as Record<string, unknown>[], DAILY_COLUMNS as never);
    return reply.type("text/csv; charset=utf-8").send(csv);
  });

  // Get comprehensive dashboard data in one call
  app.get("/dashboard", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { days } = request.query as { days?: string };

    const periodDays = days ? parseInt(days) : 30;

    const [overview, timeseries, deployments, costByModel, costByGpu, projection] =
      await Promise.all([
        getUsageOverview(orgId, periodDays),
        getUsageTimeSeries(orgId, periodDays, "daily"),
        getDeploymentMetrics(orgId, periodDays),
        getCostByModel(orgId, periodDays),
        getCostByGpuTier(orgId, periodDays),
        projectMonthlyCost(orgId),
      ]);

    return reply.send({
      success: true,
      data: {
        overview,
        timeseries,
        deployments,
        costBreakdown: {
          byModel: costByModel,
          byGpu: costByGpu,
        },
        projection,
      },
      period: { days: periodDays },
    });
  });
}
