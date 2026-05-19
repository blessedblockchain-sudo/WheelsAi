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

// Drives apps/api/src/routes/agentDetail.ts — the read-side companion to the
// runway feed. Returns enough state in one fetch for the dashboard agent
// page to render: identity, treasury, active deployments, channels,
// recent compute payments. The runway numbers themselves live on a
// separate endpoint (/agents/:slug/runway) so the dashboard can refresh
// them on a different cadence.

const LAMPORTS_PER_SOL = 1_000_000_000n;

function makeApp(opts: {
  authed?: boolean;
  loadAgentDetail?: (args: {
    slug: string;
    orgId: string;
    paymentsLimit: number;
  }) => Promise<any | null>;
}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = { userId: "u1", orgId: "org_1", type: "jwt" };
    }
  });
  return import("../routes/agentDetail.js").then(async (mod) => {
    await app.register(
      mod.createAgentDetailRoutes({
        loadAgentDetail: opts.loadAgentDetail ?? (async () => null),
      }),
    );
    return app;
  });
}

const okDetail = {
  agent: {
    id: "agent_1",
    name: "Eliza",
    slug: "eliza",
    framework: "elizaos",
    createdAt: new Date("2026-04-20T00:00:00Z"),
  },
  treasury: {
    address: "PDA111",
    balanceLamports: LAMPORTS_PER_SOL,
  },
  deployments: [
    {
      id: "dep_1",
      gpuTier: "4090",
      replicas: 2,
      status: "running",
      nosanaJobIds: ["job_a"],
    },
  ],
  channels: [{ platform: "discord", enabled: true }],
  recentPayments: [
    {
      id: "cp_1",
      amountLamports: 4_500_000n,
      computeSeconds: 3600n,
      status: "CONFIRMED",
      txSignature: "sig_1",
      paidAt: new Date("2026-04-26T11:00:00Z"),
      scheduledFor: new Date("2026-04-26T10:55:00Z"),
      errorMessage: null,
    },
  ],
};

// ============================================
// Auth + isolation
// ============================================

test("GET /agents/:slug returns 401 when unauthenticated", async () => {
  const app = await makeApp({ authed: false });
  const res = await app.inject({ method: "GET", url: "/agents/eliza" });
  assert.equal(res.statusCode, 401);
});

test("GET /agents/:slug returns 404 when agent does not exist for this org", async () => {
  const app = await makeApp({ loadAgentDetail: async () => null });
  const res = await app.inject({ method: "GET", url: "/agents/missing" });
  assert.equal(res.statusCode, 404);
});

test("GET /agents/:slug scopes the lookup by orgId", async () => {
  let observedOrgId = "";
  const app = await makeApp({
    loadAgentDetail: async ({ orgId }) => {
      observedOrgId = orgId;
      return null;
    },
  });
  await app.inject({ method: "GET", url: "/agents/eliza" });
  assert.equal(observedOrgId, "org_1");
});

// ============================================
// Happy path
// ============================================

test("GET /agents/:slug returns the dashboard payload with BigInts serialized as strings", async () => {
  const app = await makeApp({ loadAgentDetail: async () => okDetail });
  const res = await app.inject({ method: "GET", url: "/agents/eliza" });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.agent.id, "agent_1");
  assert.equal(body.agent.name, "Eliza");
  assert.equal(body.agent.slug, "eliza");
  assert.equal(body.agent.framework, "elizaos");

  assert.equal(body.treasury.address, "PDA111");
  // BigInt → string so JSON.stringify doesn't choke.
  assert.equal(typeof body.treasury.balanceLamports, "string");
  assert.equal(body.treasury.balanceLamports, "1000000000");

  assert.equal(body.deployments.length, 1);
  assert.equal(body.deployments[0].gpuTier, "4090");

  assert.deepEqual(
    body.channels.map((c: any) => c.platform),
    ["discord"],
  );

  assert.equal(body.recentPayments.length, 1);
  const p = body.recentPayments[0];
  assert.equal(p.status, "CONFIRMED");
  assert.equal(typeof p.amountLamports, "string");
  assert.equal(p.amountLamports, "4500000");
  assert.equal(typeof p.computeSeconds, "string");
});

test("GET /agents/:slug serializes a null treasury as null (not omitted)", async () => {
  const app = await makeApp({
    loadAgentDetail: async () => ({ ...okDetail, treasury: null }),
  });
  const res = await app.inject({ method: "GET", url: "/agents/eliza" });
  assert.equal(res.statusCode, 200);
  // Explicit null tells the dashboard "no treasury yet" without ambiguity.
  assert.equal(res.json().treasury, null);
});

test("GET /agents/:slug returns minimal shape when there are no deployments / channels / payments", async () => {
  const app = await makeApp({
    loadAgentDetail: async () => ({
      ...okDetail,
      treasury: null,
      deployments: [],
      channels: [],
      recentPayments: [],
    }),
  });
  const res = await app.inject({ method: "GET", url: "/agents/eliza" });
  const body = res.json();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.deployments, []);
  assert.deepEqual(body.channels, []);
  assert.deepEqual(body.recentPayments, []);
});

// ============================================
// paymentsLimit query
// ============================================

test("GET /agents/:slug honors a paymentsLimit query parameter", async () => {
  let observedLimit = -1;
  const app = await makeApp({
    loadAgentDetail: async ({ paymentsLimit }) => {
      observedLimit = paymentsLimit;
      return okDetail;
    },
  });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza?paymentsLimit=25",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(observedLimit, 25);
});

test("GET /agents/:slug defaults paymentsLimit to 10", async () => {
  let observedLimit = -1;
  const app = await makeApp({
    loadAgentDetail: async ({ paymentsLimit }) => {
      observedLimit = paymentsLimit;
      return okDetail;
    },
  });
  await app.inject({ method: "GET", url: "/agents/eliza" });
  assert.equal(observedLimit, 10);
});

test("GET /agents/:slug rejects a paymentsLimit > 100 to bound load", async () => {
  const app = await makeApp({ loadAgentDetail: async () => okDetail });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza?paymentsLimit=10000",
  });
  assert.equal(res.statusCode, 400);
});

test("GET /agents/:slug rejects a non-positive paymentsLimit", async () => {
  const app = await makeApp({ loadAgentDetail: async () => okDetail });
  const res = await app.inject({
    method: "GET",
    url: "/agents/eliza?paymentsLimit=0",
  });
  assert.equal(res.statusCode, 400);
});

// ============================================
// Date serialization
// ============================================

test("GET /agents/:slug serializes Date fields as ISO strings", async () => {
  const app = await makeApp({ loadAgentDetail: async () => okDetail });
  const res = await app.inject({ method: "GET", url: "/agents/eliza" });
  const body = res.json();
  assert.equal(body.agent.createdAt, "2026-04-20T00:00:00.000Z");
  assert.equal(body.recentPayments[0].paidAt, "2026-04-26T11:00:00.000Z");
});
