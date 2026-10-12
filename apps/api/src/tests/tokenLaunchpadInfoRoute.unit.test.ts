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

// Drives routes/tokenLaunchpadInfo.ts: GET /launchpad (mounted under
// /api/tokens), what the wizard reads before anyone connects a wallet.
// The route is built from explicit deps, so no setting of this machine
// decides what these tests see.

type Deps = import("../routes/tokenLaunchpadInfo.js").TokenLaunchpadInfoDeps;

async function makeApp(deps: Partial<Deps> = {}) {
  setupEnv();
  const { createTokenLaunchpadInfoRoutes } = await import(
    "../routes/tokenLaunchpadInfo.js"
  );
  const app = Fastify();
  // No auth hook at all: the route must answer without a login.
  await app.register(
    createTokenLaunchpadInfoRoutes({
      launchpad: "meteora",
      network: "devnet",
      gate: () => ({ minReputation: 50, minDeploymentAgeDays: 7 }),
      ...deps,
    }),
  );
  return app;
}

async function getInfo(deps: Partial<Deps> = {}) {
  const app = await makeApp(deps);
  const res = await app.inject({ method: "GET", url: "/launchpad" });
  return { res, body: JSON.parse(res.body) };
}

test("GET /launchpad answers without a login", async () => {
  const { res } = await getInfo();
  assert.equal(res.statusCode, 200);
});

test("GET /launchpad on meteora and devnet: the four presets, the default and the gate", async () => {
  const { body } = await getInfo();
  assert.deepEqual(Object.keys(body).sort(), [
    "defaultPreset",
    "gate",
    "launchpad",
    "network",
    "presets",
    "quote",
  ]);
  assert.equal(body.launchpad, "meteora");
  assert.equal(body.network, "devnet");
  assert.equal(body.quote, "SOL");
  assert.equal(body.defaultPreset, "community");
  assert.deepEqual(
    body.presets.map((preset: any) => preset.id),
    ["community", "committed", "long", "rehearsal"],
  );
  assert.deepEqual(body.gate, {
    minReputation: 50,
    minDeploymentAgeDays: 7,
    creatorLockupDays: 30,
  });
});

test("GET /launchpad: a preset arrives as the wizard's PresetDescription", async () => {
  const { body } = await getInfo();
  const community = body.presets[0];
  assert.deepEqual(Object.keys(community).sort(), [
    "creatorFeeSharePercent",
    "creatorLocked",
    "fee",
    "graduationValueSol",
    "id",
    "liquidityLockedPercent",
    "name",
    "points",
    "raisedAtGraduationSol",
    "startValueSol",
    "summary",
  ]);
  assert.equal(community.name, "Community");
  assert.equal(community.startValueSol, "20");
  assert.equal(community.graduationValueSol, "320");
  assert.equal(community.raisedAtGraduationSol, "64");
  assert.deepEqual(community.fee, { startPercent: "30", endPercent: "1", seconds: 300 });
  assert.equal(community.creatorFeeSharePercent, 70);
  assert.equal(community.creatorLocked, null);
  assert.equal(community.liquidityLockedPercent, 100);
  assert.equal(community.points.length, 24);
  for (const point of community.points) {
    assert.deepEqual(Object.keys(point).sort(), ["priceSol", "soldPercent"]);
    assert.equal(typeof point.soldPercent, "number");
    assert.equal(typeof point.priceSol, "number");
  }
  assert.deepEqual(body.presets[1].creatorLocked, {
    percentOfSupply: "10",
    cliffSeconds: 2_592_000,
    periods: 12,
    totalSeconds: 31_104_000,
  });
});

test("GET /launchpad on mainnet does not offer the rehearsal preset", async () => {
  const { body } = await getInfo({ network: "mainnet-beta" });
  assert.equal(body.network, "mainnet-beta");
  assert.deepEqual(
    body.presets.map((preset: any) => preset.id),
    ["community", "committed", "long"],
  );
});

test("GET /launchpad for another launchpad has no presets", async () => {
  for (const launchpad of ["pumpfun", "bags"] as const) {
    const { res, body } = await getInfo({ launchpad });
    assert.equal(res.statusCode, 200);
    assert.equal(body.launchpad, launchpad);
    assert.deepEqual(body.presets, []);
    assert.equal(body.quote, "SOL");
    assert.equal(body.gate.creatorLockupDays, 30);
  }
});

test("GET /launchpad shows the gate's numbers in force, read at each request", async () => {
  let gate = { minReputation: 10, minDeploymentAgeDays: 0 };
  const app = await makeApp({ gate: () => gate });
  const first = JSON.parse((await app.inject({ method: "GET", url: "/launchpad" })).body);
  assert.deepEqual(first.gate, {
    minReputation: 10,
    minDeploymentAgeDays: 0,
    creatorLockupDays: 30,
  });
  gate = { minReputation: 50, minDeploymentAgeDays: 7 };
  const second = JSON.parse((await app.inject({ method: "GET", url: "/launchpad" })).body);
  assert.equal(second.gate.minReputation, 50);
  assert.equal(second.gate.minDeploymentAgeDays, 7);
});

test("the mounted route is the one built from this server's settings", async () => {
  setupEnv();
  const { tokenLaunchpadInfoRoutes } = await import("../routes/tokenLaunchpadInfo.js");
  const { env } = await import("../config/env.js");
  const { launchGateThresholds, CREATOR_LOCKUP_DAYS } = await import(
    "../services/tokenEligibility.js"
  );
  const app = Fastify();
  await app.register(tokenLaunchpadInfoRoutes, { prefix: "/api/tokens" });
  const res = await app.inject({ method: "GET", url: "/api/tokens/launchpad" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.launchpad, env.LAUNCHPAD);
  assert.equal(body.network, env.SOLANA_NETWORK);
  assert.deepEqual(body.gate, {
    ...launchGateThresholds(),
    creatorLockupDays: CREATOR_LOCKUP_DAYS,
  });
});
