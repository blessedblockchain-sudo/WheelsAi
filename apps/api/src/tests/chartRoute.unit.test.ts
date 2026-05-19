import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/routes/chart.ts — the GET /agents/:slug/chart feed
// the dashboard price chart subscribes to. Composes:
//   loadAgentTradesForChart(slug, orgId, from?, to?) → trades[]
//   aggregateOhlcBars(trades, intervalSeconds)        → bars[]
//
// Persistence is DI'd. The interval list is allowlisted at the route
// boundary so a hostile client can't ask for `intervalSeconds=1` and DOS
// the bucket loop.

interface FakeTrade {
  timestamp: Date;
  priceUsd: number;
  solAmount: number;
}

const trade = (iso: string, priceUsd: number, solAmount = 0.1): FakeTrade => ({
  timestamp: new Date(iso),
  priceUsd,
  solAmount,
});

function makeApp(opts: {
  authed?: boolean;
  loadAgentTradesForChart?: (args: {
    slug: string;
    orgId: string;
    from: Date | null;
    to: Date | null;
  }) => Promise<FakeTrade[] | null>;
}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = { userId: "u1", orgId: "org_1", type: "jwt" };
    }
  });
  return import("../routes/chart.js").then(async (mod) => {
    await app.register(
      mod.createChartRoutes({
        loadAgentTradesForChart:
          opts.loadAgentTradesForChart ?? (async () => null),
      }),
    );
    return app;
  });
}

const sampleTrades: FakeTrade[] = [
  trade("2026-04-26T13:00:00Z", 0.001, 0.5),
  trade("2026-04-26T13:30:00Z", 0.005, 0.3),
  trade("2026-04-26T14:15:00Z", 0.003, 0.2),
];

// ============================================
// Auth + isolation
// ============================================

test("GET /agents/:slug/chart returns 401 when unauthenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/chart?intervalSeconds=3600",
  });
  assert.equal(res.statusCode, 401);
});

test("GET /agents/:slug/chart returns 404 when agent does not exist for this org", async () => {
  const app = await makeApp({ loadAgentTradesForChart: async () => null });
  const res = await app.inject({
    method: "GET",
    url: "/agents/missing/chart?intervalSeconds=3600",
  });
  assert.equal(res.statusCode, 404);
});

test("GET /agents/:slug/chart scopes the lookup by orgId", async () => {
  let observedOrgId = "";
  const app = await makeApp({
    loadAgentTradesForChart: async ({ orgId }) => {
      observedOrgId = orgId;
      return null;
    },
  });
  await app.inject({
    method: "GET",
    url: "/agents/eliza/chart?intervalSeconds=3600",
  });
  assert.equal(observedOrgId, "org_1");
});

// ============================================
// Happy path
// ============================================

test("GET /agents/:slug/chart returns OHLC bars with ISO timestamps", async () => {
  const app = await makeApp({
    loadAgentTradesForChart: async () => sampleTrades,
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/chart?intervalSeconds=3600",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.intervalSeconds, 3600);
  assert.ok(Array.isArray(body.bars));
  assert.equal(body.bars.length, 2); // 13:00 + 14:00 hourly bars

  const first = body.bars[0];
  assert.equal(typeof first.openTime, "string");
  assert.equal(first.openTime, "2026-04-26T13:00:00.000Z");
  assert.equal(first.closeTime, "2026-04-26T14:00:00.000Z");
  assert.equal(first.open, 0.001);
  assert.equal(first.high, 0.005);
  assert.equal(first.low, 0.001);
  assert.equal(first.close, 0.005);
  assert.equal(first.tradeCount, 2);
});

test("GET /agents/:slug/chart returns an empty bars array when the agent has no trades yet", async () => {
  const app = await makeApp({ loadAgentTradesForChart: async () => [] });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/chart?intervalSeconds=3600",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().bars, []);
});

// ============================================
// from/to window
// ============================================

test("GET /agents/:slug/chart forwards from/to query params to the loader as Dates", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadAgentTradesForChart: async (args) => {
      observed = args;
      return [];
    },
  });
  const fromIso = "2026-04-26T00:00:00.000Z";
  const toIso = "2026-04-26T23:59:59.000Z";
  await app.inject({
    method: "GET",
    url: `/agents/eliza/chart?intervalSeconds=3600&from=${fromIso}&to=${toIso}`,
  });
  assert.ok(observed.from instanceof Date);
  assert.ok(observed.to instanceof Date);
  assert.equal(observed.from.toISOString(), fromIso);
  assert.equal(observed.to.toISOString(), toIso);
});

test("GET /agents/:slug/chart forwards from=null/to=null when not supplied", async () => {
  let observed: any = null;
  const app = await makeApp({
    loadAgentTradesForChart: async (args) => {
      observed = args;
      return [];
    },
  });
  await app.inject({
    method: "GET",
    url: "/agents/eliza/chart?intervalSeconds=3600",
  });
  assert.equal(observed.from, null);
  assert.equal(observed.to, null);
});

// ============================================
// Validation
// ============================================

test("GET /agents/:slug/chart returns 400 when intervalSeconds is missing", async () => {
  const app = await makeApp({});
  const res = await app.inject({ method: "GET", url: "/agents/eliza/chart" });
  assert.equal(res.statusCode, 400);
});

test("GET /agents/:slug/chart enforces an allowlist of intervalSeconds (60, 300, 3600, 86400)", async () => {
  // Hostile values like intervalSeconds=1 would create 86,400 buckets per
  // day — DoS via bucket loop. The route accepts only known intervals.
  const app = await makeApp({ loadAgentTradesForChart: async () => [] });
  for (const ok of [60, 300, 3600, 86400]) {
    const res = await app.inject({
      method: "GET",
      url: `/agents/eliza/chart?intervalSeconds=${ok}`,
    });
    assert.equal(res.statusCode, 200, `should accept ${ok}`);
  }
  for (const bad of [1, 17, 999999]) {
    const res = await app.inject({
      method: "GET",
      url: `/agents/eliza/chart?intervalSeconds=${bad}`,
    });
    assert.equal(res.statusCode, 400, `should reject ${bad}`);
  }
});

test("GET /agents/:slug/chart returns 400 when from > to (caller bug)", async () => {
  const app = await makeApp({ loadAgentTradesForChart: async () => [] });
  const res = await app.inject({
    method: "GET",
    url:
      "/agents/eliza/chart?intervalSeconds=3600" +
      "&from=2026-04-27T00:00:00Z&to=2026-04-26T00:00:00Z",
  });
  assert.equal(res.statusCode, 400);
});

test("GET /agents/:slug/chart returns 400 on invalid date strings", async () => {
  const app = await makeApp({ loadAgentTradesForChart: async () => [] });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/chart?intervalSeconds=3600&from=not-a-date",
  });
  assert.equal(res.statusCode, 400);
});
