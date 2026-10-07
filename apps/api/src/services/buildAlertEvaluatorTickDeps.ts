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
 *   latency_p95   — the 95th percentile, and
 *   latency_avg   — the mean, in MILLISECONDS, of the end-to-end time of
 *                   the requests recorded in [now − window, now)
 *                   (request_latency_samples, services/latencyQueries.ts).
 *                   Answered, failed and timed-out requests count: the
 *                   alert is on what callers experienced. A request the
 *                   caller abandoned does not. no_data when the window
 *                   holds no request - never a 0 ms that an `lt` rule
 *                   would fire on.
 *
 * Scoping: resourceType organization → all org usage; deployment →
 * usage of that deploymentId; agent → usage of the agent's model
 * deployments (same join the reputation loader uses), and for latency
 * also the agent's own chats. Every read is bound to the rule's
 * organization, so a rule naming another organization's resource reads
 * nothing.
 */

import { prisma as defaultPrisma } from "../lib/prisma.js";
import { scopedLatencyLoader, type ScopedLatency } from "./buildLatencySampleDeps.js";
import type { ScopedWindow } from "./latencyQueries.js";
import type { LatencyOutcome } from "./latencySamples.js";
import { triggerAlert as defaultTriggerAlert } from "./monitoring.js";
import { triggerWebhook as defaultTriggerWebhook } from "./webhooks.js";
import { createLogger } from "../utils/logger.js";
import type {
  AlertEvaluatorTickDeps,
  AlertRuleRow,
  MetricComputation,
} from "./runAlertEvaluatorTick.js";

const logger = createLogger("alert-evaluator");

/** The part of Prisma the evaluator reads; a test passes a fake of this shape. */
export interface AlertEvaluatorDb {
  alertRule: { findMany(args: unknown): Promise<AlertRuleRow[]> };
  agentDeployment: {
    findMany(args: unknown): Promise<Array<{ modelDeploymentId: string | null }>>;
  };
  usageRecord: {
    aggregate(args: unknown): Promise<{
      _sum: {
        requestCount: number | null;
        errorCount: number | null;
        costCents: bigint | null;
        actualCostCents: bigint | null;
      };
    }>;
  };
  uptimeEvent: { findMany(args: unknown): Promise<Array<{ status: string }>> };
}

export interface BuildAlertEvaluatorTickDepsInput {
  prisma?: AlertEvaluatorDb;
  triggerAlert?: (
    rule: AlertRuleRow,
    metricValue: number,
    resourceId?: string,
    detail?: string,
  ) => Promise<{ id: string; title: string } | null>;
  triggerWebhook?: typeof defaultTriggerWebhook;
  /** One organization's measured latency over a window. */
  loadScopedLatency?: (window: ScopedWindow) => Promise<ScopedLatency>;
}

// What a latency alert counts. "cancelled" is left out: how long a caller
// waited before hanging up measures the caller.
const ALERT_LATENCY_OUTCOMES: readonly LatencyOutcome[] = ["ok", "error", "timeout"];

async function usageDeploymentIds(
  prisma: AlertEvaluatorDb,
  rule: AlertRuleRow,
): Promise<string[] | null> {
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
  prisma: AlertEvaluatorDb,
  rule: AlertRuleRow,
  windowStart: Date,
): Promise<MetricComputation> {
  const deploymentIds = await usageDeploymentIds(prisma, rule);
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
  prisma: AlertEvaluatorDb,
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

async function computeLatencyMetric(
  prisma: AlertEvaluatorDb,
  loadScopedLatency: (window: ScopedWindow) => Promise<ScopedLatency>,
  rule: AlertRuleRow,
  windowStart: Date,
  now: Date,
): Promise<MetricComputation> {
  const window: ScopedWindow = {
    orgId: rule.orgId,
    since: windowStart,
    until: now,
    outcomes: ALERT_LATENCY_OUTCOMES,
  };
  if (rule.resourceType === "deployment" && rule.resourceId) {
    window.deploymentIds = [rule.resourceId];
  } else if (rule.resourceType === "agent" && rule.resourceId) {
    window.agentId = rule.resourceId;
    window.deploymentIds = (await usageDeploymentIds(prisma, rule)) ?? [];
  }

  // A failed read is thrown: the tick counts the rule as failed. It is never
  // an evaluation against zero.
  const latency = await loadScopedLatency(window);
  const value = rule.metric === "latency_p95" ? latency.p95Ms : latency.avgMs;
  if (latency.sampleCount === 0 || value === null) return { kind: "no_data" };
  return {
    kind: "value",
    value,
    detail: `ms over ${latency.sampleCount} ${latency.sampleCount === 1 ? "request" : "requests"}`,
  };
}

export function buildAlertEvaluatorTickDeps(
  input: BuildAlertEvaluatorTickDepsInput = {},
): AlertEvaluatorTickDeps {
  const prisma = input.prisma ?? (defaultPrisma as unknown as AlertEvaluatorDb);
  const triggerAlert = input.triggerAlert ?? defaultTriggerAlert;
  const triggerWebhook = input.triggerWebhook ?? defaultTriggerWebhook;
  const loadScopedLatency = input.loadScopedLatency ?? scopedLatencyLoader();

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
      if (rule.metric === "latency_p95" || rule.metric === "latency_avg") {
        return computeLatencyMetric(prisma, loadScopedLatency, rule, windowStart, now);
      }
      if (rule.metric === "uptime") {
        return computeUptimeMetric(prisma, rule, windowStart);
      }
      return computeUsageMetric(prisma, rule, windowStart);
    },

    fireAlert: async (rule, metricValue, detail) => {
      const alert = await triggerAlert(rule, metricValue, undefined, detail);
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
