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

// Drives apps/api/src/routes/publicAgent.ts — the GET /a/:slug feed for the
// public per-agent transparency page (plan C5).
//
// This is the visible manifestation of the thesis: any holder or prospective
// buyer can land on /a/elizabot and see the agent's actual economics —
// treasury balance, compute paid to date, recent settlement signatures —
// without an account. No competitor has this. It is also the first place a
// regulator looks if questions arise, so the surface must:
//
//   - never leak orgId or internal-only fields
//   - redact operational error messages on payments (status only)
//   - 404 (don't reveal existence) when the agent is private
//   - format lamports + SOL together so non-crypto readers can parse it

const LAMPORTS_PER_SOL = 1_000_000_000n;

function makeApp(opts: {
  loadPublicAgent?: (slug: string) => Promise<any | null>;
}) {
  setupEnv();
  const app = Fastify();
  return import("../routes/publicAgent.js").then(async (mod) => {
    await app.register(
      mod.createPublicAgentRoutes({
        loadPublicAgent: opts.loadPublicAgent ?? (async () => null),
      }),
    );
    return app;
  });
}

const fullPublicAgent = {
  agent: {
    name: "Eliza",
    slug: "eliza",
    framework: "elizaos",
    createdAt: new Date("2026-04-20T00:00:00Z"),
    isPublic: true,
  },
  treasury: {
    address: "PDA111",
    balanceLamports: LAMPORTS_PER_SOL, // 1 SOL
    cumulativeComputePaidLamports: 4_500_000n,
  },
  uptime: {
    totalComputeSeconds: 5_400n, // 1.5 hours
    totalRequests: 15,
  },
  eligibility: { eligible: true },
  deployments: [
    { gpuTier: "4090", replicas: 2, status: "running" },
  ],
  channels: [
    { platform: "discord", enabled: true, live: true },
    { platform: "telegram", enabled: false, live: false },
    { platform: "slack", enabled: true, live: true },
  ],
  recentPayments: [
    {
      amountLamports: 4_500_000n,
      status: "CONFIRMED",
      txSignature: "sig_1",
      paidAt: new Date("2026-04-26T11:00:00Z"),
      // Internal error message that must NOT appear in public output.
      errorMessage: "internal_db_blip_redact_me",
    },
  ],
};

// ============================================
// Visibility / 404
// ============================================

test("GET /a/:slug returns 404 when the agent does not exist", async () => {
  const app = await makeApp({ loadPublicAgent: async () => null });
  const res = await app.inject({ method: "GET", url: "/a/missing" });
  assert.equal(res.statusCode, 404);
});

test("GET /a/:slug does NOT require authentication (public page)", async () => {
  const app = await makeApp({ loadPublicAgent: async () => fullPublicAgent });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  // No auth header on the request — should still 200.
  assert.equal(res.statusCode, 200);
});

// ============================================
// Happy path
// ============================================

test("GET /a/:slug returns the public-safe agent shape", async () => {
  const app = await makeApp({ loadPublicAgent: async () => fullPublicAgent });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // Identity
  assert.equal(body.agent.name, "Eliza");
  assert.equal(body.agent.slug, "eliza");
  assert.equal(body.agent.framework, "elizaos");
  assert.equal(body.agent.createdAt, "2026-04-20T00:00:00.000Z");
  // No internal flags surfaced.
  assert.ok(!("isPublic" in body.agent));

  // Treasury, with both lamports (string) and SOL (number rounded for display).
  assert.equal(body.treasury.address, "PDA111");
  assert.equal(body.treasury.balanceLamports, "1000000000");
  assert.equal(body.treasury.balanceSol, 1);
  assert.equal(body.treasury.cumulativeComputePaidLamports, "4500000");
});

// ============================================
// Privacy guarantees
// ============================================

test("GET /a/:slug never leaks orgId anywhere in the response", async () => {
  const app = await makeApp({
    loadPublicAgent: async () => ({
      ...fullPublicAgent,
      // Even if the loader accidentally hands us orgId on agent, the route must drop it.
      agent: { ...fullPublicAgent.agent, orgId: "org_LEAK_ME" },
    }),
  });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = JSON.stringify(res.json());
  assert.ok(!body.includes("org_LEAK_ME"), "orgId must not appear in response");
  assert.ok(!body.includes("orgId"), "field name must not appear");
});

test("GET /a/:slug redacts payment error messages (status only)", async () => {
  const app = await makeApp({ loadPublicAgent: async () => fullPublicAgent });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = res.json();
  const p = body.recentPayments[0];
  assert.equal(p.status, "CONFIRMED");
  assert.ok(!("errorMessage" in p), "errorMessage must not appear on public payments");
});

test("GET /a/:slug filters channels down to the enabled ones", async () => {
  const app = await makeApp({ loadPublicAgent: async () => fullPublicAgent });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = res.json();
  // Disabled channels are dev/configuration noise; public page only shows what
  // the agent currently listens to.
  assert.deepEqual(body.channels.map((c: any) => c.platform).sort(), [
    "discord",
    "slack",
  ]);
});

test("GET /a/:slug says which enabled channels are live: a configured platform with no working path is not shown as active", async () => {
  const app = await makeApp({
    loadPublicAgent: async () => ({
      ...fullPublicAgent,
      channels: [
        { platform: "discord", enabled: true, live: true },
        { platform: "twitter", enabled: true, live: false },
        { platform: "web", enabled: true, live: true },
      ],
    }),
  });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  assert.deepEqual(res.json().channels, [
    { platform: "discord", enabled: true, live: true },
    { platform: "twitter", enabled: true, live: false },
    { platform: "web", enabled: true, live: true },
  ]);
  assert.ok(!res.body.includes("orgId"));
});

test("GET /a/:slug serializes recentPayments with public-safe fields only", async () => {
  const app = await makeApp({ loadPublicAgent: async () => fullPublicAgent });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = res.json();
  const p = body.recentPayments[0];
  // What's in:
  assert.equal(p.amountLamports, "4500000");
  assert.equal(p.status, "CONFIRMED");
  assert.equal(p.txSignature, "sig_1");
  assert.equal(p.paidAt, "2026-04-26T11:00:00.000Z");
  // What's out:
  assert.ok(!("errorMessage" in p));
  assert.ok(!("scheduledFor" in p)); // implementation detail; public doesn't need it
  assert.ok(!("computeSeconds" in p)); // could be inferred from on-chain data, internal for now
});

// ============================================
// Treasury formatting
// ============================================

test("GET /a/:slug returns treasury=null when the agent has no treasury yet (not_yet_tokenized signal)", async () => {
  const app = await makeApp({
    loadPublicAgent: async () => ({ ...fullPublicAgent, treasury: null, recentPayments: [] }),
  });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = res.json();
  assert.equal(body.treasury, null);
  assert.deepEqual(body.recentPayments, []);
});

test("GET /a/:slug rounds treasury.balanceSol to 4 decimal places for clean display", async () => {
  const app = await makeApp({
    loadPublicAgent: async () => ({
      ...fullPublicAgent,
      treasury: {
        ...fullPublicAgent.treasury,
        balanceLamports: 1_234_567_891n, // 1.234567891 SOL
      },
    }),
  });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = res.json();
  // 4 decimals: 1.2346 (rounded)
  assert.equal(body.treasury.balanceSol, 1.2346);
});

// ============================================
// Deployments — only public summary
// ============================================

test("GET /a/:slug exposes deployment count + tier but not internal job IDs", async () => {
  const app = await makeApp({
    loadPublicAgent: async () => ({
      ...fullPublicAgent,
      deployments: [
        { gpuTier: "4090", replicas: 2, status: "running" },
        { gpuTier: "h100", replicas: 1, status: "running" },
      ],
    }),
  });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = res.json();
  assert.equal(body.deployments.length, 2);
  // Public shape: gpuTier + replicas + status only — no nosanaJobIds
  for (const d of body.deployments) {
    assert.ok(!("nosanaJobIds" in d));
    assert.ok(!("id" in d));
  }
});

// ============================================
// Uptime + eligibility (plan A5)
// ============================================

test("GET /a/:slug serializes uptime as exact seconds string + rounded hours", async () => {
  const app = await makeApp({ loadPublicAgent: async () => fullPublicAgent });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = res.json();
  assert.deepEqual(body.uptime, {
    totalComputeSeconds: "5400",
    totalComputeHours: 1.5,
    totalRequests: 15,
  });
});

test("GET /a/:slug exposes eligibility as a bare boolean — the gate's reasons stay private", async () => {
  const app = await makeApp({
    loadPublicAgent: async () => ({
      ...fullPublicAgent,
      eligibility: { eligible: false },
    }),
  });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = res.json();
  assert.deepEqual(body.eligibility, { eligible: false });
});

test("GET /a/:slug serializes uptime=null and eligibility=null for a fresh unlisted agent", async () => {
  const app = await makeApp({
    loadPublicAgent: async () => ({
      ...fullPublicAgent,
      treasury: null,
      recentPayments: [],
      uptime: null,
      eligibility: null,
    }),
  });
  const res = await app.inject({ method: "GET", url: "/a/eliza" });
  const body = res.json();
  assert.equal(body.uptime, null);
  assert.equal(body.eligibility, null);
});
