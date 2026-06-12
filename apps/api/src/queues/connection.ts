import type { ConnectionOptions } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";

import { env } from "../config/env.js";

/**
 * Redis connection options for BullMQ queues and workers, derived from the
 * FULL REDIS_URL (B5). The previous version extracted only hostname+port,
 * silently dropping credentials, TLS (rediss://), and the db index — so
 * against any managed Redis (Fly/Upstash, Elasticache+auth) every financial
 * worker failed AUTH while /health stayed green.
 *
 * maxRetriesPerRequest must be null for BullMQ blocking workers.
 */
export function getQueueConnectionOpts(
  redisUrl: string = env.REDIS_URL
): { connection: ConnectionOptions } {
  const url = new URL(redisUrl);

  const connection: Record<string, unknown> = {
    host: url.hostname || "localhost",
    port: Number.parseInt(url.port || "6379", 10),
    maxRetriesPerRequest: null,
  };

  if (url.username) connection.username = decodeURIComponent(url.username);
  if (url.password) connection.password = decodeURIComponent(url.password);

  const dbIndex = url.pathname.replace(/^\//, "");
  if (dbIndex) connection.db = Number.parseInt(dbIndex, 10);

  if (url.protocol === "rediss:") connection.tls = {};

  return { connection: connection as ConnectionOptions };
}

/**
 * Boot-time probe: the queue fleet's Redis connection must reach ready
 * within the timeout or the process exits non-zero. Without this, bad
 * credentials/TLS leave every worker silently dead while /health is green.
 */
export async function assertQueueRedisReady(
  log: {
    info: (msg: string) => void;
    error: (obj: unknown, msg?: string) => void;
  },
  timeoutMs = 15_000
): Promise<void> {
  const { connection } = getQueueConnectionOpts();
  const probe = new Redis({
    ...(connection as RedisOptions),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe.connect().then(() => probe.ping()),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`queue Redis not ready within ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    log.info("Queue Redis connection verified");
  } catch (error) {
    log.error(
      { error },
      "Queue Redis connection FAILED — the worker fleet cannot run; exiting"
    );
    process.exit(1);
  } finally {
    if (timer) clearTimeout(timer);
    probe.disconnect();
  }
}
