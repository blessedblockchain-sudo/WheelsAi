/**
 * Prometheus metrics (remediation H1).
 *
 * Both fly tomls have declared `[metrics] path = "/metrics"` since the first
 * deploy config landed, but no such route existed — Fly has been scraping a
 * 404. Net effect: the tick workers that move real funds ran with no
 * telemetry at all.
 *
 * The queue-depth gauges below are the point of this file. The B5 failure
 * mode (BullMQ connected to a Redis it could not authenticate against) left
 * every financial worker dead while `/health` stayed green, and nothing in
 * the system could have told you. `wheelsai_queue_jobs` makes that visible:
 * a live fleet shows movement, a dead one shows `waiting` climbing and
 * `active` pinned at zero.
 *
 * IO is injected so the collector is unit-testable without Redis; the
 * production wiring lives in buildMetricsDeps.ts.
 */

import {
  Registry,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Counter,
} from "prom-client";

/** Every repeatable-job queue in the fleet, by BullMQ queue name. */
export const QUEUE_NAMES = [
  "x402-settlement",
  "token-indexer",
  "treasury-settlement",
  "payment-submit",
  "payment-poll",
  "payment-reap",
  "fee-router",
  "reputation-attestation",
  "deployment-status",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** The BullMQ job states worth alerting on. `completed` is deliberately
 * omitted — it grows without bound and says nothing about current health. */
export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface MetricsDeps {
  /**
   * Job counts for one queue. Throwing is expected and handled: a scrape
   * must never 500 just because Redis blipped, or the metric that tells you
   * Redis is down would itself be the thing that disappears.
   */
  getQueueCounts: (name: string) => Promise<QueueCounts>;
  /** Injected for tests; defaults to the real queue list. */
  queueNames?: readonly string[];
}

export interface MetricsHandle {
  registry: Registry;
  /** Records one finished HTTP request. */
  observeRequest: (args: {
    method: string;
    route: string;
    statusCode: number;
    durationSeconds: number;
  }) => void;
}

/**
 * Build an isolated registry. Not the prom-client global default registry:
 * a module-level singleton makes tests order-dependent and double-registers
 * on hot reload.
 */
export function createMetrics(deps: MetricsDeps): MetricsHandle {
  const registry = new Registry();
  registry.setDefaultLabels({ service: "wheelsai-api" });

  // Process-level: CPU, RSS, heap, GC pauses, event-loop lag, handles.
  collectDefaultMetrics({ register: registry, prefix: "wheelsai_" });

  const queueNames = deps.queueNames ?? QUEUE_NAMES;

  // Collected at scrape time rather than on a timer, so the numbers are
  // always as fresh as the scrape and there is no background work when
  // nobody is looking.
  new Gauge({
    name: "wheelsai_queue_jobs",
    help: "BullMQ jobs per queue and state",
    labelNames: ["queue", "state"] as const,
    registers: [registry],
    async collect() {
      for (const queue of queueNames) {
        try {
          const counts = await deps.getQueueCounts(queue);
          this.set({ queue, state: "waiting" }, counts.waiting);
          this.set({ queue, state: "active" }, counts.active);
          this.set({ queue, state: "delayed" }, counts.delayed);
          this.set({ queue, state: "failed" }, counts.failed);
        } catch {
          // Report -1 rather than dropping the series. A missing metric is
          // indistinguishable from "queue is idle" on a dashboard; -1 is
          // unambiguously "could not read", which is itself the alert.
          for (const state of ["waiting", "active", "delayed", "failed"]) {
            this.set({ queue, state }, -1);
          }
        }
      }
    },
  });

  const requestDuration = new Histogram({
    name: "wheelsai_http_request_duration_seconds",
    help: "HTTP request duration",
    // Labelled by route PATTERN (/api/agents/:id), never the concrete path,
    // so cardinality stays bounded and no ids land in the metric store.
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const requestTotal = new Counter({
    name: "wheelsai_http_requests_total",
    help: "HTTP requests by method, route and status class",
    labelNames: ["method", "route", "status"] as const,
    registers: [registry],
  });

  return {
    registry,
    observeRequest({ method, route, statusCode, durationSeconds }) {
      const labels = {
        method,
        route,
        status: String(statusCode),
      };
      requestDuration.observe(labels, durationSeconds);
      requestTotal.inc(labels);
    },
  };
}
