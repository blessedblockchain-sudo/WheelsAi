import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

/**
 * P6: the public /status page reads GET /api/status. The page's one rule is
 * that it never shows a number the API did not return, so these pin the
 * API's side of that contract: every figure is measured or read, absence of
 * data stays null / "no_data" (never 100% or "operational"), an outage is
 * reported with a 200 body, and customer monitors are never consulted when
 * no public status org is configured. No network, database or Redis.
 */

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

const {
  createStatusRoutes,
  classifyWorker,
  configuredWorkers,
  readRunsFromRedis,
  utcDayRange,
  workerGraceMs,
} = await import("../routes/status.js");
type StatusDeps = Parameters<typeof createStatusRoutes>[0];

const NOW = new Date("2026-10-01T12:00:00.000Z");
const ok = async () => {};
const boom = async () => {
  throw new Error("connection refused");
};
const hang = () => new Promise<void>(() => {});

function baseDeps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    checkDatabase: ok,
    checkRedis: ok,
    workers: [],
    readWorkerRuns: async () => ({}),
    loadPublicMonitors: null,
    loadMonitorDays: async () => [],
    now: () => NOW,
    timeoutMs: 50,
    cacheTtlMs: 0,
    historyDays: 3,
    ...overrides,
  };
}

async function get(deps: StatusDeps) {
  const app = Fastify({ logger: false });
  await app.register(createStatusRoutes(deps), { prefix: "/api/status" });
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/status" });
  await app.close();
  return res;
}

test("healthy: both probes pass, no workers, no monitors configured", async () => {
  const res = await get(baseDeps());
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "operational");
  assert.equal(body.generatedAt, NOW.toISOString());
  assert.deepEqual(
    body.components.map((c: { id: string; status: string }) => [c.id, c.status]),
    [
      ["database", "operational"],
      ["redis", "operational"],
    ],
  );
  for (const c of body.components) {
    assert.equal(typeof c.latencyMs, "number", "a passing probe reports its measured latency");
  }
  assert.deepEqual(body.monitors, { configured: false, available: true, historyDays: 3, items: [] });
  assert.deepEqual(body.workers, { available: true, items: [] });
});

test("database down: 200 with a major_outage body, and monitors are not read", async () => {
  let monitorReads = 0;
  const res = await get(
    baseDeps({
      checkDatabase: boom,
      loadPublicMonitors: async () => {
        monitorReads += 1;
        return [];
      },
    }),
  );
  assert.equal(res.statusCode, 200, "a status page must still answer mid-outage");
  const body = res.json();
  assert.equal(body.status, "major_outage");
  const db = body.components.find((c: { id: string }) => c.id === "database");
  assert.deepEqual(db, { id: "database", name: "Database", status: "outage", latencyMs: null });
  assert.equal(monitorReads, 0);
  assert.equal(body.monitors.configured, true);
  assert.equal(body.monitors.available, false);
});

test("a hung probe is an outage within the timeout, not a hung request", async () => {
  const started = Date.now();
  const res = await get(baseDeps({ checkRedis: hang, timeoutMs: 30 }));
  assert.ok(Date.now() - started < 2_000);
  const body = res.json();
  const redis = body.components.find((c: { id: string }) => c.id === "redis");
  assert.equal(redis.status, "outage");
  assert.equal(redis.latencyMs, null);
  assert.equal(body.status, "degraded");
});

test("redis down: worker history is unknown, never guessed", async () => {
  let reads = 0;
  const res = await get(
    baseDeps({
      checkRedis: boom,
      workers: [{ queue: "scheduler", name: "Scheduled tasks", description: "d", intervalMs: 30_000 }],
      readWorkerRuns: async () => {
        reads += 1;
        return {};
      },
    }),
  );
  const body = res.json();
  assert.equal(reads, 0);
  assert.deepEqual(body.workers, { available: false, items: [] });
  assert.equal(body.status, "degraded");
});

test("workers: each run history is classified and reported verbatim", async () => {
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
  const res = await get(
    baseDeps({
      workers: [
        { queue: "a", name: "A", description: "fresh", intervalMs: 30_000 },
        { queue: "b", name: "B", description: "stale", intervalMs: 30_000 },
        { queue: "c", name: "C", description: "last run failed", intervalMs: 30_000 },
        { queue: "d", name: "D", description: "never ran", intervalMs: 3_600_000 },
      ],
      readWorkerRuns: async (queues) => {
        assert.deepEqual(queues, ["a", "b", "c", "d"]);
        return {
          a: { lastCompletedAt: minutesAgo(0.5), lastFailedAt: minutesAgo(30) },
          b: { lastCompletedAt: minutesAgo(10), lastFailedAt: null },
          c: { lastCompletedAt: minutesAgo(2), lastFailedAt: minutesAgo(1) },
        };
      },
    }),
  );
  const body = res.json();
  const byId = Object.fromEntries(
    body.workers.items.map((w: { id: string }) => [w.id, w]),
  );
  assert.equal(byId.a.status, "operational");
  assert.equal(byId.a.lastCompletedAt, minutesAgo(0.5).toISOString());
  assert.equal(byId.a.intervalSeconds, 30);
  assert.equal(byId.b.status, "delayed");
  assert.equal(byId.c.status, "failing");
  assert.equal(byId.d.status, "no_data");
  assert.equal(byId.d.lastCompletedAt, null);
  assert.equal(byId.d.lastFailedAt, null);
  assert.equal(body.status, "degraded");
});

test("a worker read that throws marks worker data unavailable, not operational", async () => {
  const res = await get(
    baseDeps({
      workers: [{ queue: "a", name: "A", description: "d", intervalMs: 30_000 }],
      readWorkerRuns: async () => {
        throw new Error("NOSCRIPT");
      },
    }),
  );
  const body = res.json();
  assert.deepEqual(body.workers, { available: false, items: [] });
  assert.equal(body.status, "operational", "missing history is not evidence of an outage");
});

test("public monitors: stored figures are passed through, empty days stay null", async () => {
  let daysArgs: { ids: string[]; since: Date } | null = null;
  const res = await get(
    baseDeps({
      loadPublicMonitors: async () => [
        {
          id: "m1",
          name: "Public API",
          currentStatus: "up",
          lastCheckAt: new Date("2026-10-01T11:59:00.000Z"),
          uptimePercent24h: 99.30555555,
          uptimePercent7d: 99.9,
          uptimePercent30d: null,
          avgLatencyMs: 123.6,
        },
        {
          id: "m2",
          name: "Never checked",
          currentStatus: "unknown",
          lastCheckAt: null,
          uptimePercent24h: null,
          uptimePercent7d: null,
          uptimePercent30d: null,
          avgLatencyMs: null,
        },
      ],
      loadMonitorDays: async (ids, since) => {
        daysArgs = { ids, since };
        return [
          { monitorId: "m1", day: "2026-09-30", checks: 4, up: 3 },
          { monitorId: "m1", day: "2026-10-01", checks: 2, up: 2 },
        ];
      },
    }),
  );
  const body = res.json();
  assert.deepEqual(daysArgs, {
    ids: ["m1", "m2"],
    since: new Date("2026-09-29T00:00:00.000Z"),
  });
  assert.equal(body.monitors.configured, true);
  assert.equal(body.monitors.available, true);
  const [api, never] = body.monitors.items;
  assert.equal(api.name, "Public API");
  assert.equal(api.status, "operational");
  assert.deepEqual(api.uptimePercent, { "24h": 99.31, "7d": 99.9, "30d": null });
  assert.equal(api.avgLatencyMs, 124);
  assert.deepEqual(api.days, [
    { date: "2026-09-29", checks: 0, uptimePercent: null },
    { date: "2026-09-30", checks: 4, uptimePercent: 75 },
    { date: "2026-10-01", checks: 2, uptimePercent: 100 },
  ]);
  assert.equal(never.status, "no_data");
  assert.deepEqual(never.uptimePercent, { "24h": null, "7d": null, "30d": null });
  assert.ok(never.days.every((d: { uptimePercent: unknown }) => d.uptimePercent === null));
  assert.equal(api.id, undefined, "internal monitor ids are not published");
  assert.equal(body.status, "operational");
});

test("a public monitor that is down degrades the overall status", async () => {
  const res = await get(
    baseDeps({
      loadPublicMonitors: async () => [
        {
          id: "m1",
          name: "Public API",
          currentStatus: "timeout",
          lastCheckAt: NOW,
          uptimePercent24h: 50,
          uptimePercent7d: 90,
          uptimePercent30d: 97,
          avgLatencyMs: null,
        },
      ],
    }),
  );
  const body = res.json();
  assert.equal(body.monitors.items[0].status, "outage");
  assert.equal(body.status, "degraded");
});

test("cache: repeated requests within the TTL reuse one computation", async () => {
  let probes = 0;
  const app = Fastify({ logger: false });
  await app.register(
    createStatusRoutes(
      baseDeps({
        cacheTtlMs: 10_000,
        checkDatabase: async () => {
          probes += 1;
        },
      }),
    ),
    { prefix: "/api/status" },
  );
  await app.ready();
  const [r1, r2] = await Promise.all([
    app.inject({ method: "GET", url: "/api/status" }),
    app.inject({ method: "GET", url: "/api/status" }),
  ]);
  const r3 = await app.inject({ method: "GET", url: "/api/status" });
  await app.close();
  assert.equal(probes, 1);
  assert.equal(r1.statusCode, 200);
  assert.deepEqual(r1.json(), r3.json());
  assert.deepEqual(r2.json(), r3.json());
  assert.match(String(r3.headers["cache-control"]), /max-age=10/);
});

test("classifyWorker: grace is three intervals, never under interval + 60s", () => {
  assert.equal(workerGraceMs(30_000), 90_000);
  assert.equal(workerGraceMs(10_000), 70_000);
  const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);
  assert.equal(classifyWorker({ lastCompletedAt: at(89_000), lastFailedAt: null }, 30_000, NOW), "operational");
  assert.equal(classifyWorker({ lastCompletedAt: at(91_000), lastFailedAt: null }, 30_000, NOW), "delayed");
  assert.equal(classifyWorker(undefined, 30_000, NOW), "no_data");
  assert.equal(classifyWorker({ lastCompletedAt: null, lastFailedAt: at(1) }, 30_000, NOW), "failing");
});

test("utcDayRange: oldest first, ends on today's UTC date", () => {
  assert.deepEqual(utcDayRange(new Date("2026-10-01T00:30:00.000Z"), 2), ["2026-09-30", "2026-10-01"]);
});

test("configuredWorkers: only enabled workers, feature flags respected", () => {
  const env = {
    DEPLOYMENT_STATUS_INTERVAL_MS: 30_000,
    SCHEDULER_INTERVAL_MS: 0,
    UPTIME_PROBER_INTERVAL_MS: 30_000,
    ALERT_EVALUATOR_INTERVAL_MS: 60_000,
    ANALYTICS_SNAPSHOT_INTERVAL_MS: 3_600_000,
    X402_SETTLEMENT_WORKER_ENABLED: false,
    X402_SETTLEMENT_INTERVAL_MS: 15_000,
    TOKEN_INDEXER_INTERVAL_MS: 0,
    TREASURY_SETTLEMENT_INTERVAL_MS: 0,
    PAYMENT_SUBMIT_INTERVAL_MS: 30_000,
    WALLET_MASTER_KEY: undefined,
    PAYMENT_POLL_INTERVAL_MS: 0,
    PAYMENT_REAP_INTERVAL_MS: 0,
    FEE_ROUTER_INTERVAL_MS: 0,
    REPUTATION_ATTESTATION_INTERVAL_MS: 0,
    PAYOUTS_ENABLED: false,
    PAYOUT_EXECUTOR_INTERVAL_MS: 60_000,
    EMBEDDING_BACKFILL_INTERVAL_MS: 0,
    SUBSCRIPTION_RENEWAL_INTERVAL_MS: 3_600_000,
  } as unknown as Parameters<typeof configuredWorkers>[0];
  assert.deepEqual(
    configuredWorkers(env).map((w) => w.queue),
    ["deployment-status", "uptime-prober", "alert-evaluator", "analytics-snapshot", "subscription-renewal"],
  );
});

test("readRunsFromRedis: top score of each finished set, one pipeline", async () => {
  const commands: string[] = [];
  const replies: Record<string, string[]> = {
    "bull:a:completed": ["job-9", "1790000000000"],
    "bull:a:failed": [],
    "bull:b:completed": [],
    "bull:b:failed": ["job-2", "1790000001000"],
  };
  const fakeRedis = {
    pipeline() {
      const queued: string[] = [];
      const p = {
        zrevrange(key: string) {
          queued.push(key);
          commands.push(key);
          return p;
        },
        async exec() {
          return queued.map((k) => [null, replies[k] ?? []] as [null, string[]]);
        },
      };
      return p;
    },
  };
  const runs = await readRunsFromRedis(fakeRedis as never, ["a", "b"]);
  assert.deepEqual(commands, ["bull:a:completed", "bull:a:failed", "bull:b:completed", "bull:b:failed"]);
  assert.deepEqual(runs, {
    a: { lastCompletedAt: new Date(1790000000000), lastFailedAt: null },
    b: { lastCompletedAt: null, lastFailedAt: new Date(1790000001000) },
  });
});
