/**
 * Production composition root for the metrics registry (H1).
 *
 * Holds nine read-only BullMQ Queue handles, one per repeatable-job queue,
 * used only for getJobCounts(). Built from the same getQueueConnectionOpts()
 * the workers use, so metrics break exactly when the workers break — which
 * is the point of the gauge.
 *
 * Each Queue dials its own client rather than sharing one injected instance.
 * That is deliberate: bullmq pins ioredis 5.8.2 while this workspace depends
 * on 5.9.1, so npm keeps two copies and an instance from the outer copy is
 * not assignable to bullmq's ConnectionOptions. Forcing them together with an
 * npm override would mean re-pinning a transitive dependency of the library
 * that moves funds, to save a handful of idle connections on the metrics
 * path. Not a trade worth making — so this costs nine mostly-idle
 * connections, on top of the ~18 the queue/worker fleet already opens.
 */

import { Queue } from "bullmq";

import { getQueueConnectionOpts } from "../queues/connection.js";
import {
  createMetrics,
  QUEUE_NAMES,
  type MetricsHandle,
  type QueueCounts,
} from "./metrics.js";

export interface MetricsRuntime extends MetricsHandle {
  /** Closes the shared connection and every queue handle. */
  close: () => Promise<void>;
}

export function buildMetricsRuntime(): MetricsRuntime {
  const { connection } = getQueueConnectionOpts();

  const queues = new Map<string, Queue>(
    QUEUE_NAMES.map((name) => [
      name,
      new Queue(name, {
        connection: {
          ...(connection as Record<string, unknown>),
          // A scrape must not block behind a dead Redis: fail the read fast
          // and let the collector emit -1. Overrides the workers'
          // maxRetriesPerRequest: null, which is correct for a blocking
          // worker and very wrong for a request-scoped read.
          maxRetriesPerRequest: 2,
          enableOfflineQueue: false,
        },
      }),
    ]),
  );

  const handle = createMetrics({
    async getQueueCounts(name): Promise<QueueCounts> {
      const queue = queues.get(name);
      if (!queue) throw new Error(`unknown queue: ${name}`);
      const counts = await queue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
      );
      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    },
  });

  return {
    ...handle,
    async close() {
      await Promise.allSettled([...queues.values()].map((q) => q.close()));
    },
  };
}
