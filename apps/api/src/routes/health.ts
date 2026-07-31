/**
 * Health endpoints (remediation H5).
 *
 * Three distinct questions, three routes — Fly's load balancer needs the
 * third, and until now was asking the first:
 *
 *   GET /health        liveness. "The process is up and serving HTTP."
 *                      Always 200. Deliberately touches nothing: a liveness
 *                      probe that consults dependencies causes a Redis blip
 *                      to restart every machine at once.
 *   GET /health/live   alias of the above.
 *   GET /health/ready  readiness. "This instance can serve real traffic" —
 *                      Postgres reachable AND Redis reachable. 503 otherwise,
 *                      which is what takes a machine out of rotation.
 *
 * The fly tomls pointed `[[http_service.checks]]` at /health, which returns
 * 200 unconditionally, so an instance whose database was gone stayed in the
 * rotation serving 500s. They now point here.
 *
 * IO is injected so the 503 path is testable without breaking a real
 * database; buildHealthDeps() is the production wiring.
 */

import type { FastifyPluginAsync } from "fastify";
import { Redis } from "ioredis";

import { prisma } from "@wheelsai/db";
import { env } from "../config/env.js";

export interface HealthDeps {
  /** Resolves if Postgres is reachable; throws otherwise. */
  checkDatabase: () => Promise<void>;
  /** Resolves if Redis is reachable; throws otherwise. */
  checkRedis: () => Promise<void>;
  /**
   * Per-check ceiling. Must stay under the fly check's `timeout` (5s) or the
   * probe times out at the load balancer, which reports as a failed check
   * with no body explaining why.
   */
  timeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

async function withTimeout(
  run: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`check exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createHealthRoutes(deps: HealthDeps): FastifyPluginAsync {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  return async (app) => {
    const liveness = async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "wheelsai-api",
      version: "0.1.0",
    });

    app.get("/", liveness);
    app.get("/live", liveness);

    app.get("/ready", async (_request, reply) => {
      const checks: Record<string, string> = {};

      // Run both concurrently: sequential checks would let a slow database
      // eat the entire budget before Redis is even attempted, reporting
      // redis:"ok" during a Redis outage.
      const [database, redis] = await Promise.allSettled([
        withTimeout(deps.checkDatabase, timeoutMs),
        withTimeout(deps.checkRedis, timeoutMs),
      ]);

      checks.database = database.status === "fulfilled" ? "ok" : "failed";
      checks.redis = redis.status === "fulfilled" ? "ok" : "failed";

      const allOk = Object.values(checks).every((v) => v === "ok");

      if (!allOk) {
        reply.status(503);
        return { status: "not_ready", checks };
      }

      return { status: "ready", checks };
    });
  };
}

/**
 * Production wiring.
 *
 * The Redis client is created once and reused. The previous version built a
 * `new Redis(...)` on every request and only called `.quit()` on the success
 * path — so whenever the ping threw, the client was orphaned still trying to
 * reconnect. At a 30s check interval across two machines that leaked a socket
 * every 30 seconds, and only ever during a Redis incident, when the extra
 * connection pressure is least welcome. A single client that ioredis
 * reconnects on its own has neither problem.
 */
export function buildHealthDeps(): HealthDeps {
  let client: Redis | null = null;

  const getClient = (): Redis => {
    if (!client) {
      client = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 3_000,
        // Fail a probe immediately while disconnected instead of buffering
        // it until the socket returns — a queued ping would resolve late and
        // report "ready" for a Redis that is still down.
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      // ioredis emits 'error' on every reconnect attempt; unhandled, those
      // become uncaught exceptions and take the process down during exactly
      // the outage this endpoint exists to report.
      client.on("error", () => {});
    }
    return client;
  };

  return {
    async checkDatabase() {
      await prisma.$queryRaw`SELECT 1`;
    },
    async checkRedis() {
      const redis = getClient();
      if (redis.status === "wait" || redis.status === "end") {
        await redis.connect();
      }
      await redis.ping();
    },
  };
}

/** Production-wired plugin, as mounted by index.ts. */
export const healthRoutes: FastifyPluginAsync = createHealthRoutes(
  buildHealthDeps(),
);
