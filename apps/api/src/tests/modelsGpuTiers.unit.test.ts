import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

// Env must be in place BEFORE the route module (and config/env.ts /
// services/nosanaMarkets.ts) is first imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
// devnet (the default) with ONE configured market: the Nosana devnet test market.
process.env.SOLANA_NETWORK = "devnet";
process.env.NOSANA_MARKETS_JSON = JSON.stringify({
  "4090": "J2mYPCyZkFzhg2oi1EqA8UAYZHhYVmktV4ExB5itFJYW",
});

// Drives routes/models.ts: the GPU tier list must reflect which Nosana markets
// are actually configured - the wizard must not offer a tier that deploy would
// refuse with "market for tier X is not configured".

async function makeApp() {
  const { modelRoutes } = await import("../routes/models.js");
  const app = Fastify();
  await app.register((await import("@fastify/sensible")).default);
  await app.register(modelRoutes, { prefix: "/api/models" });
  return app;
}

test("GET /api/models?tier=gpu lists ONLY tiers with a configured market on this network", async () => {
  const app = await makeApp();
  const res = await app.inject({ method: "GET", url: "/api/models?tier=gpu" });
  assert.equal(res.statusCode, 200);
  const { gpuTiers } = res.json();
  assert.deepEqual(
    gpuTiers.map((t: { id: string }) => t.id),
    ["4090"],
    "devnet: only the tier the operator supplied a market for",
  );
  assert.equal(gpuTiers[0].vram, 24);
  assert.equal(gpuTiers[0].pricePerHour, 0.9, "retail USD/hour from the same table billing uses");
});

test("the default model list carries the same tier list", async () => {
  const app = await makeApp();
  const res = await app.inject({ method: "GET", url: "/api/models" });
  assert.deepEqual(
    res.json().gpuTiers.map((t: { id: string }) => t.id),
    ["4090"],
  );
});

test("cost estimates are refused for a tier that is not deployable here", async () => {
  const app = await makeApp();
  const unconfigured = await app.inject({
    method: "POST",
    url: "/api/models/llama-3.1-8b/estimate",
    payload: { gpuTier: "h100" },
  });
  assert.equal(unconfigured.statusCode, 400);
});

test("cost estimates work for a configured tier, priced from the billing table", async () => {
  const app = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/models/llama-3.1-8b/estimate",
    payload: { gpuTier: "4090", hoursPerMonth: 10 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().estimate.breakdown.gpuHourlyRate, 0.9);
});
