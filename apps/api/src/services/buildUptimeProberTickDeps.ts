/**
 * Composition root for the uptime-prober tick (Wave 1).
 *
 * Target resolution:
 *   custom_url  → the monitor's own targetUrl
 *   deployment  → the deployment's first HEALTHY node URL (falling back
 *                 to any node with a URL) + /health
 *   agent       → the agent's OpenClaw runtime publicUrl + /health
 *   anything unresolvable → null (the tick records an honest error)
 *
 * The probe classifies:
 *   expected status + expected body present → up
 *   wrong status / missing body            → down
 *   aborted by the monitor's own timeout   → timeout
 *   network failure                        → error
 */

import { prisma } from "../lib/prisma.js";
import { recordUptimeEvent } from "./monitoring.js";
import type {
  ProbeOutcome,
  UptimeProberTickDeps,
} from "./runUptimeProberTick.js";

const DEFAULT_BATCH_LIMIT = 50;

export interface BuildUptimeProberTickDepsInput {
  fetchFn?: typeof fetch;
  batchLimit?: number;
}

export function buildUptimeProberTickDeps(
  input: BuildUptimeProberTickDepsInput = {},
): UptimeProberTickDeps {
  const fetchFn = input.fetchFn ?? fetch;
  const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;

  return {
    loadDueMonitors: async ({ now }) => {
      // Due = never checked, or its own per-monitor interval has elapsed.
      // The filter runs in SQL via a raw interval comparison kept simple:
      // load enabled monitors and filter in memory (bounded by take).
      const rows = await prisma.uptimeMonitor.findMany({
        where: { isEnabled: true },
        orderBy: { lastCheckAt: "asc" },
        take: batchLimit,
        select: {
          id: true,
          targetType: true,
          targetId: true,
          targetUrl: true,
          checkIntervalSeconds: true,
          timeoutSeconds: true,
          httpMethod: true,
          expectedStatus: true,
          expectedBody: true,
          headers: true,
          lastCheckAt: true,
        },
      });
      return rows
        .filter(
          (m) =>
            m.lastCheckAt === null ||
            now.getTime() - m.lastCheckAt.getTime() >=
              m.checkIntervalSeconds * 1000,
        )
        .map((m) => ({
          id: m.id,
          targetType: m.targetType,
          targetId: m.targetId,
          targetUrl: m.targetUrl,
          timeoutSeconds: m.timeoutSeconds,
          httpMethod: m.httpMethod,
          expectedStatus: m.expectedStatus,
          expectedBody: m.expectedBody,
          headers: m.headers,
        }));
    },

    resolveTargetUrl: async (monitor) => {
      if (monitor.targetType === "custom_url") {
        return monitor.targetUrl && /^https?:\/\//.test(monitor.targetUrl)
          ? monitor.targetUrl
          : null;
      }
      if (monitor.targetType === "deployment" && monitor.targetId) {
        const nodes = await prisma.deploymentNode.findMany({
          where: { deploymentId: monitor.targetId },
          select: { nodeUrl: true, healthStatus: true },
        });
        const best =
          nodes.find((n) => n.healthStatus === "healthy" && n.nodeUrl) ??
          nodes.find((n) => n.nodeUrl);
        return best?.nodeUrl ? `${best.nodeUrl.replace(/\/$/, "")}/health` : null;
      }
      if (monitor.targetType === "agent" && monitor.targetId) {
        const openclaw = await prisma.openClawDeployment.findFirst({
          where: { agentId: monitor.targetId },
          select: { publicUrl: true },
        });
        return openclaw?.publicUrl
          ? `${openclaw.publicUrl.replace(/\/$/, "")}/health`
          : null;
      }
      return null;
    },

    probe: async (monitor, url): Promise<ProbeOutcome> => {
      const controller = new AbortController();
      const timeoutMs = Math.max(1, monitor.timeoutSeconds) * 1000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const headers =
          typeof monitor.headers === "object" && monitor.headers !== null
            ? (monitor.headers as Record<string, string>)
            : undefined;
        const res = await fetchFn(url, {
          method: monitor.httpMethod || "GET",
          headers,
          signal: controller.signal,
        });
        const latencyMs = Date.now() - startedAt;

        if (res.status !== monitor.expectedStatus) {
          return {
            status: "down",
            statusCode: res.status,
            latencyMs,
            errorMessage: `expected status ${monitor.expectedStatus}, got ${res.status}`,
          };
        }
        if (monitor.expectedBody) {
          const body = await res.text().catch(() => "");
          if (!body.includes(monitor.expectedBody)) {
            return {
              status: "down",
              statusCode: res.status,
              latencyMs,
              errorMessage: "expected body substring not found",
            };
          }
        }
        return { status: "up", statusCode: res.status, latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const aborted =
          err instanceof Error &&
          (err.name === "AbortError" || /abort/i.test(err.message));
        return aborted
          ? { status: "timeout", latencyMs, errorMessage: `no response within ${timeoutMs}ms` }
          : {
              status: "error",
              latencyMs,
              errorMessage: err instanceof Error ? err.message : String(err),
            };
      } finally {
        clearTimeout(timer);
      }
    },

    recordResult: (monitorId, result) => recordUptimeEvent(monitorId, result),
  };
}
