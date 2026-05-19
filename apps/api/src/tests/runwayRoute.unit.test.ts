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

// Drives apps/api/src/routes/runway.ts — the public-facing GET that the
// runway dashboard card (plan A8) calls. Loads:
//   - deployment by slug, scoped by orgId (multi-tenant isolation)
//   - the agent's treasury (if any)
//   - recent UsageRecord rows in the lookback window
// Then composes computeDeploymentRunway(...) and returns the same numbers
// the dashboard card renders.

const LAMPORTS_PER_SOL = 1_000_000_000n;

function makeApp(opts: {
  authed?: boolean;
  loadAgentSnapshot?: (
    args: { slug: string; orgId: string; lookbackSeconds: number; now: Date },
  ) => Promise<
    | {
        agent: { id: string; name: string; slug: string };
        treasuryBalanceLamports: bigint;
        treasuryAddress: string | null;
        usageRecords: Array<{
          periodStart: Date;
          periodEnd: Date;
          computeSeconds: bigint;
          actualCostCents: bigint;
        }>;
        currentReplicas: number;
        maxReplicas: number;
      }
    | null
  >;
  getSolPriceUsd?: () => Promise<number>;
}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = { userId: "u_1", orgId: "org_1", type: "jwt" };
    }
  });
  return import("../routes/runway.js").then(async (mod) => {
    await app.register(
      mod.createRunwayRoutes({
        loadAgentSnapshot: opts.loadAgentSnapshot ?? (async () => null),
        getSolPriceUsd: opts.getSolPriceUsd ?? (async () => 200),
      }),
    );
    return app;
  });
}

// Dates are computed at call time (not module load) so the records always
// fall inside the route's default 7-day lookback window, regardless of when
// the test is executed.
function makeOkSnapshot() {
  const periodEnd = new Date(); // "now"
  const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000); // 1h ago
  return {
    agent: { id: "agent_1", name: "Eliza", slug: "eliza" },
    treasuryBalanceLamports: LAMPORTS_PER_SOL,
    treasuryAddress: "TPDA111",
    usageRecords: [
      {
        periodStart,
        periodEnd,
        computeSeconds: 3600n,
        actualCostCents: 100n, // $1
      },
    ],
    currentReplicas: 1,
    maxReplicas: 10,
  };
}
const okSnapshot = makeOkSnapshot();

// ============================================
// Auth + isolation
// ============================================

test("GET /agents/:slug/runway returns 401 when unauthenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({ method: "GET", url: "/agents/eliza/runway" });
  assert.equal(res.statusCode, 401);
});

test("GET /agents/:slug/runway returns 404 when agent does not exist for this org", async () => {
  const app = await makeApp({ loadAgentSnapshot: async () => null });
  const res = await app.inject({ method: "GET", url: "/agents/missing/runway" });
  assert.equal(res.statusCode, 404);
});

test("GET /agents/:slug/runway scopes the lookup by orgId (multi-tenant isolation)", async () => {
  let observedOrgId = "";
  const app = await makeApp({
    loadAgentSnapshot: async ({ orgId }) => {
      observedOrgId = orgId;
      return null;
    },
  });
  await app.inject({ method: "GET", url: "/agents/eliza/runway" });
  assert.equal(observedOrgId, "org_1");
});

// ============================================
// Happy path
// ============================================

test("GET /agents/:slug/runway returns the runway numbers the dashboard card renders", async () => {
  const app = await makeApp({
    loadAgentSnapshot: async () => okSnapshot,
    getSolPriceUsd: async () => 200,
  });
  const res = await app.inject({ method: "GET", url: "/agents/eliza/runway" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.agent.slug, "eliza");
  assert.equal(body.agent.name, "Eliza");
  assert.equal(body.treasuryAddress, "TPDA111");
  assert.equal(body.solPriceUsd, 200);
  assert.equal(typeof body.runway.runwaySeconds, "number");
  assert.ok(["healthy", "warning", "critical", "expired"].includes(body.runway.alertLevel));
  assert.ok(body.runway.totalCostCents >= 0);
  // BigInt fields must be serialized as strings to survive JSON.
  assert.equal(typeof body.runway.burnRateLamportsPerSecond, "string");
  assert.equal(typeof body.runway.burnLamportsPerDay, "string");
  assert.equal(typeof body.treasuryBalanceLamports, "string");
});

test("GET /agents/:slug/runway returns expired + 0 runway when no treasury exists yet", async () => {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000);
  const app = await makeApp({
    loadAgentSnapshot: async () => ({
      ...okSnapshot,
      treasuryBalanceLamports: 0n,
      treasuryAddress: null,
      // Burn $100 in the lookback so the runway calc has a non-zero rate
      usageRecords: [
        {
          periodStart,
          periodEnd,
          computeSeconds: 3600n,
          actualCostCents: 10000n,
        },
      ],
    }),
  });
  const res = await app.inject({ method: "GET", url: "/agents/eliza/runway" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.runway.runwaySeconds, 0);
  assert.equal(body.runway.alertLevel, "expired");
  assert.equal(body.treasuryAddress, null);
});

test("GET /agents/:slug/runway returns Infinity runway as the JSON sentinel 'infinity'", async () => {
  const app = await makeApp({
    loadAgentSnapshot: async () => ({
      ...okSnapshot,
      usageRecords: [],
    }),
  });
  const res = await app.inject({ method: "GET", url: "/agents/eliza/runway" });
  assert.equal(res.statusCode, 200);
  // JSON has no Infinity literal; serialize as a string sentinel the UI can branch on.
  assert.equal(res.json().runway.runwaySeconds, "infinity");
  assert.equal(res.json().runway.alertLevel, "healthy");
});

// ============================================
// Lookback knob
// ============================================

test("GET /agents/:slug/runway honors the lookbackSeconds query parameter", async () => {
  let observedLookback = -1;
  const app = await makeApp({
    loadAgentSnapshot: async ({ lookbackSeconds }) => {
      observedLookback = lookbackSeconds;
      return okSnapshot;
    },
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/runway?lookbackSeconds=86400",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(observedLookback, 86_400);
});

test("GET /agents/:slug/runway rejects a non-positive lookbackSeconds with 400", async () => {
  const app = await makeApp({
    loadAgentSnapshot: async () => okSnapshot,
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza/runway?lookbackSeconds=0",
  });
  assert.equal(res.statusCode, 400);
});

test("GET /agents/:slug/runway returns 502 when the sol-price oracle fails", async () => {
  const app = await makeApp({
    loadAgentSnapshot: async () => okSnapshot,
    getSolPriceUsd: async () => {
      throw new Error("oracle down");
    },
  });
  const res = await app.inject({ method: "GET", url: "/agents/eliza/runway" });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "sol_price_unavailable");
});
