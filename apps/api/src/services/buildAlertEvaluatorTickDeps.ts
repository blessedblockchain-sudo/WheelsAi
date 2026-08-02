/**
 * Composition root for the alert-evaluator tick (Wave 1).
 *
 * Metric sources, all computed honestly from what actually exists:
 *
 *   error_rate    — Σ errorCount / Σ requestCount × 100 over the window,
 *                   from UsageRecords (no_data when zero requests)
 *   request_count — Σ requestCount over the window
 *   cost          — Σ actualCostCents (falling back to costCents) over
 *                   the window, in CENTS (the threshold's unit)
 *   uptime        — % of `up` UptimeEvents over the window, across the
 *                   org's monitors (or the resource's monitors)
 *   latency_p95   — UNSUPPORTED: only per-window latency aggregates
 *                   exist; approximating a p95 from means would be a
 *                   fabricated number. Skipped and counted until raw
 *                   samples exist.
 *
 * Scoping: resourceType organization → all org usage; deployment →
 * usage of that deploymentId; agent → usage of the agent's model
 * deployments (same join the reputation loader uses).
 */

import { prisma } from "../lib/prisma.js";
import { triggerAlert } from "./monitoring.js";
import { triggerWebhook } from "./webhooks.js";
import { createLogger } from "../utils/logger.js";
import type {
  AlertEvaluatorTickDeps,
  AlertRuleRow,
  MetricComputation,
} from "./runAlertEvaluatorTick.js";

const logger = createLogger("alert-evaluator");

async function usageDeploymentIds(rule: AlertRuleRow): Promise<string[] | null> {
  if (rule.resourceType === "deployment" && rule.resourceId) {
    return [rule.resourceId];
  }
  if (rule.resourceType === "agent" && rule.resourceId) {
    const deployments = await prisma.agentDeployment.findMany({
      where: { agentId: rule.resourceId },
      select: { modelDeploymentId: true },
    });
    const ids = deployments
      .map((d) => d.modelDeploymentId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids.length > 0 ? Array.from(new Set(ids)) : [];
  }
  return null; // organization-wide
}

async function computeUsageMetric(
  rule: AlertRuleRow,
  windowStart: Date,
): Promise<MetricComputation> {
  const deploymentIds = await usageDeploymentIds(rule);
  if (deploymentIds !== null && deploymentIds.length === 0) {
    return { kind: "no_data" };
  }

  const agg = await prisma.usageRecord.aggregate({
    where: {
      orgId: rule.orgId,
      periodEnd: { gte: windowStart },
      ...(deploymentIds ? { deploymentId: { in: deploymentIds } } : {}),
    },
    _sum: {
      requestCount: true,
      errorCount: true,
      costCents: true,
      actualCostCents: true,
    },
  });

  const requests = agg._sum.requestCount ?? 0;
  const errors = agg._sum.errorCount ?? 0;

  if (rule.metric === "request_count") {
    return { kind: "value", value: requests };
  }
  if (rule.metric === "error_rate") {
    if (requests === 0) return { kind: "no_data" };
    return { kind: "value", value: (errors / requests) * 100 };
  }
  if (rule.metric === "cost") {
    const actual = agg._sum.actualCostCents ?? 0n;
    const legacy = agg._sum.costCents ?? 0n;
    return { kind: "value", value: Number(actual > 0n ? actual : legacy) };
  }
  return { kind: "unsupported", reason: `unknown usage metric ${rule.metric}` };
}

async function computeUptimeMetric(
  rule: AlertRuleRow,
  windowStart: Date,
): Promise<MetricComputation> {
  const events = await prisma.uptimeEvent.findMany({
    where: {
      checkedAt: { gte: windowStart },
      monitor: {
        orgId: rule.orgId,
        ...(rule.resourceId ? { targetId: rule.resourceId } : {}),
      },
    },
    select: { status: true },
  });
  if (events.length === 0) return { kind: "no_data" };
  const up = events.filter((e) => e.status === "up").length;
  return { kind: "value", value: (up / events.length) * 100 };
}

export function buildAlertEvaluatorTickDeps(): AlertEvaluatorTickDeps {
  return {
    loadEnabledRules: async () =>
      prisma.alertRule.findMany({
        where: { isEnabled: true },
        select: {
          id: true,
          orgId: true,
          name: true,
          metric: true,
          operator: true,
          threshold: true,
          windowMinutes: true,
          severity: true,
          cooldownMinutes: true,
          lastTriggeredAt: true,
          resourceType: true,
          resourceId: true,
        },
      }),

    computeMetric: async (rule, now) => {
      const windowStart = new Date(
        now.getTime() - rule.windowMinutes * 60_000,
      );
      if (rule.metric === "latency_p95") {
        return {
          kind: "unsupported",
          reason:
            "latency_p95 needs raw latency samples; only per-window aggregates exist",
        };
      }
      if (rule.metric === "uptime") {
        return computeUptimeMetric(rule, windowStart);
      }
      return computeUsageMetric(rule, windowStart);
    },

    fireAlert: async (rule, metricValue) => {
      const alert = await triggerAlert(rule, metricValue);
      return alert ? { id: alert.id, title: alert.title } : null;
    },

    emitAlertTriggered: async (rule, alert, metricValue) => {
      await triggerWebhook(
        rule.orgId,
        "alert.triggered",
        {
          alertId: alert.id,
          title: alert.title,
          metric: rule.metric,
          value: metricValue,
          threshold: rule.threshold,
          severity: rule.severity,
        },
        rule.resourceType,
        rule.resourceId ?? undefined,
      ).catch((err) =>
        logger.error({ err }, "webhook alert.triggered failed"),
      );
    },
  };
}
