import { env } from "../config/env.js";

/**
 * Returns the Redis connection URL for BullMQ queues and workers.
 * BullMQ creates its own IORedis connections internally — we just provide the URL.
 */
export function getQueueConnectionOpts() {
  return {
    connection: {
      host: new URL(env.REDIS_URL).hostname || "localhost",
      port: parseInt(new URL(env.REDIS_URL).port || "6379", 10),
    },
  };
}
