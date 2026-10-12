import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import Fastify from "fastify";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives the launch gate's two numbers through the two places a person
// sees them before launching: the eligibility preview
// (services/agentToken.ts checkTokenEligibility) and the route the wizard
// calls (GET /api/tokens/eligibility/:agentListingId).
//
// The numbers are TOKEN_LAUNCH_MIN_REPUTATION and
// TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS, read through launchGateThresholds().
// Unset they are 50 and 7 days. Every test passes a source object or the
// thresholds themselves: none changes the process environment.
//
// Prisma is the @wheelsai/db singleton (no DI on the preview); tests
// monkey-patch its delegates and restore them, the same pattern as
// eligibilityGateWiring.unit.test.ts.

const MS_PER_DAY = 86_400 * 1000;

async function getPrisma(): Promise<any> {
  setupEnv();
  const { prisma } = await import("@wheelsai/db");
  return prisma;
}

function snapshot(p: any) {
  return {
    agentListing: { ...p.agentListing },
    agentToken: { ...p.agentToken },
    publisherProfile: { ...p.publisherProfile },
    agentDeployment: { ...p.agentDeployment },
    x402Payment: { ...p.x402Payment },
  };
}

function restore(p: any, orig: ReturnType<typeof snapshot>) {
  Object.assign(p.agentListing, orig.agentListing);
  Object.assign(p.agentToken, orig.agentToken);
  Object.assign(p.publisherProfile, orig.publisherProfile);
  Object.assign(p.agentDeployment, orig.agentDeployment);
  Object.assign(p.x402Payment, orig.x402Payment);
}

// A published listing of org_1 whose agent has run for `ageDays` and whose
// publisher has `reputationScore`, with `settled` paid requests.
function stubAgent(
  p: any,
  opts: { reputationScore: number; ageDays: number; settled?: number },
) {
  p.agentListing.findUnique = async () => ({
    id: "lst_1",
    publisherId: "org_1",
    status: "published",
    agent: {
      id: "agent_1",
      // Half a day over, so the whole-day arithmetic cannot land on an edge.
      deployments: [{ createdAt: new Date(Date.now() - (opts.ageDays + 0.5) * MS_PER_DAY) }],
    },
  });
  p.agentToken.findUnique = async () => null;
  p.publisherProfile.findUnique = async () => ({
    orgId: "org_1",
    reputationScore: opts.reputationScore,
  });
  p.agentDeployment.findMany = async () => [{ id: "dep_1", modelDeploymentId: null }];
  p.x402Payment.count = async () => opts.settled ?? 0;
}

async function makeApp(launchGate?: { minReputation: number; minDeploymentAgeDays: number }) {
  setupEnv();
  const { tokenRoutes } = await import("../routes/tokens.js");
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = {
      userId: "user_1",
      orgId: "org_1",
      type: "jwt",
    };
  });
  await app.register(tokenRoutes, { prefix: "/api/tokens", launchGate });
  return app;
}

// ============================================
// The preview
// ============================================

test("the preview with the settings unset refuses under 50 and under 7 days, and names both numbers", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  try {
    stubAgent(p, { reputationScore: 12, ageDays: 1 });
    const { checkTokenEligibility } = await import("../services/agentToken.js");
    const { launchGateThresholds } = await import("../services/tokenEligibility.js");

    const result = await checkTokenEligibility("lst_1", "org_1", launchGateThresholds({}));
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, [
      "Publisher reputation score (12) must be at least 50",
      "Agent must be deployed for at least 7 days (current: 1 days)",
    ]);
  } finally {
    restore(p, orig);
  }
});

test("the preview called with no thresholds reads the server's settings", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  try {
    stubAgent(p, { reputationScore: 12, ageDays: 1 });
    const { checkTokenEligibility } = await import("../services/agentToken.js");
    const { launchGateThresholds } = await import("../services/tokenEligibility.js");

    // Whatever this process is configured with, the two-argument call (the
    // public agent page makes it) must answer as the configured gate does.
    const configured = launchGateThresholds();
    assert.deepEqual(
      await checkTokenEligibility("lst_1", "org_1"),
      await checkTokenEligibility("lst_1", "org_1", configured),
    );
  } finally {
    restore(p, orig);
  }
});

test("the preview with lowered settings lets the same agent through", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  try {
    stubAgent(p, { reputationScore: 12, ageDays: 1 });
    const { checkTokenEligibility } = await import("../services/agentToken.js");
    const { launchGateThresholds } = await import("../services/tokenEligibility.js");

    const lowered = launchGateThresholds({
      TOKEN_LAUNCH_MIN_REPUTATION: 10,
      TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS: 1,
    });
    assert.deepEqual(await checkTokenEligibility("lst_1", "org_1", lowered), {
      eligible: true,
      reasons: [],
    });
  } finally {
    restore(p, orig);
  }
});

test("the preview's sentences name the lowered numbers, not 50 and 7", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  try {
    stubAgent(p, { reputationScore: 5, ageDays: 1 });
    const { checkTokenEligibility } = await import("../services/agentToken.js");

    const result = await checkTokenEligibility("lst_1", "org_1", {
      minReputation: 10,
      minDeploymentAgeDays: 3,
    });
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, [
      "Publisher reputation score (5) must be at least 10",
      "Agent must be deployed for at least 3 days (current: 1 days)",
    ]);
  } finally {
    restore(p, orig);
  }
});

test("the paid-usage sentence starts from the number in force", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  try {
    stubAgent(p, { reputationScore: 20, ageDays: 30, settled: 4 });
    const { checkTokenEligibility } = await import("../services/agentToken.js");

    const result = await checkTokenEligibility("lst_1", "org_1", {
      minReputation: 40,
      minDeploymentAgeDays: 7,
    });
    assert.deepEqual(result.reasons, [
      "Publisher reputation score (20) must be at least 36 (40 minus 4 for on-chain-paid usage)",
    ]);
  } finally {
    restore(p, orig);
  }
});

// ============================================
// The route
// ============================================

test("GET /api/tokens/eligibility answers 50 and 7 days when the settings are unset", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  const { launchGateThresholds, CREATOR_LOCKUP_DAYS } = await import(
    "../services/tokenEligibility.js"
  );
  const app = await makeApp(launchGateThresholds({}));
  try {
    stubAgent(p, { reputationScore: 12, ageDays: 1 });
    const res = await app.inject({ method: "GET", url: "/api/tokens/eligibility/lst_1" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.eligible, false);
    assert.deepEqual(body.requirements, {
      minReputation: 50,
      minDeploymentAgeDays: 7,
      creatorLockupDays: CREATOR_LOCKUP_DAYS,
    });
    assert.deepEqual(body.reasons, [
      "Publisher reputation score (12) must be at least 50",
      "Agent must be deployed for at least 7 days (current: 1 days)",
    ]);
  } finally {
    restore(p, orig);
    await app.close();
  }
});

test("GET /api/tokens/eligibility answers the lowered numbers and lets the agent through", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  const { launchGateThresholds, CREATOR_LOCKUP_DAYS } = await import(
    "../services/tokenEligibility.js"
  );
  const app = await makeApp(
    launchGateThresholds({
      TOKEN_LAUNCH_MIN_REPUTATION: 10,
      TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS: 1,
    }),
  );
  try {
    stubAgent(p, { reputationScore: 12, ageDays: 1 });
    const res = await app.inject({ method: "GET", url: "/api/tokens/eligibility/lst_1" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      eligible: true,
      reasons: [],
      requirements: {
        minReputation: 10,
        minDeploymentAgeDays: 1,
        creatorLockupDays: CREATOR_LOCKUP_DAYS,
      },
    });
  } finally {
    restore(p, orig);
    await app.close();
  }
});

test("GET /api/tokens/eligibility, mounted as index.ts mounts it, answers the server's settings", async () => {
  const p = await getPrisma();
  const orig = snapshot(p);
  const { launchGateThresholds } = await import("../services/tokenEligibility.js");
  const app = await makeApp();
  try {
    stubAgent(p, { reputationScore: 12, ageDays: 1 });
    const res = await app.inject({ method: "GET", url: "/api/tokens/eligibility/lst_1" });
    assert.equal(res.statusCode, 200);
    const configured = launchGateThresholds();
    const { requirements } = res.json();
    assert.equal(requirements.minReputation, configured.minReputation);
    assert.equal(requirements.minDeploymentAgeDays, configured.minDeploymentAgeDays);
  } finally {
    restore(p, orig);
    await app.close();
  }
});

test("GET /api/tokens/eligibility refuses a request with no login", async () => {
  setupEnv();
  const { tokenRoutes } = await import("../routes/tokens.js");
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  await app.register(tokenRoutes, { prefix: "/api/tokens" });
  try {
    const res = await app.inject({ method: "GET", url: "/api/tokens/eligibility/lst_1" });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

// ============================================
// The paths that take no thresholds from the caller
// ============================================
//
// The launch route calls the pure check with one argument, the public agent
// page calls the preview with two, and index.ts mounts the route with no
// option: all three then read the server's settings themselves. The tests
// above hand the numbers in, so they would still pass if one of those
// defaults went back to the constant. This one runs the three calls in a
// process of its own, started with the two settings in ITS environment;
// this process's environment is not changed.

const run = promisify(execFile);

test("with the settings in the server's environment, the calls that pass no thresholds use them", async () => {
  const at = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  // An async function in a plain script, not a module: the flag that makes
  // an inline script a module is refused by the logger's worker thread.
  const script = `(async () => {
    const { launchGateThresholds, checkTokenEligibility: pureCheck } = await import(${at("../services/tokenEligibility.ts")});
    const { prisma: p } = await import("@wheelsai/db");
    p.agentListing.findUnique = async () => ({
      id: "lst_1",
      publisherId: "org_1",
      status: "published",
      agent: { id: "agent_1", deployments: [{ createdAt: new Date(Date.now() - 1.5 * 86400000) }] },
    });
    p.agentToken.findUnique = async () => null;
    p.publisherProfile.findUnique = async () => ({ orgId: "org_1", reputationScore: 12 });
    p.agentDeployment.findMany = async () => [{ id: "dep_1", modelDeploymentId: null }];
    p.x402Payment.count = async () => 0;

    const { checkTokenEligibility: preview } = await import(${at("../services/agentToken.ts")});
    const { tokenRoutes } = await import(${at("../routes/tokens.ts")});
    const { default: Fastify } = await import("fastify");
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request) => {
      request.auth = { userId: "user_1", orgId: "org_1", type: "jwt" };
    });
    await app.register(tokenRoutes, { prefix: "/api/tokens" });
    const res = await app.inject({ method: "GET", url: "/api/tokens/eligibility/lst_1" });
    await app.close();

    const young = {
      reputationScore: 12,
      deploymentAgeDays: 1,
      hasPublishedListing: true,
      alreadyTokenized: false,
      creatorAddress: "11111111111111111111111111111111",
    };
    console.log("RESULT " + JSON.stringify({
      thresholds: launchGateThresholds(),
      pure: pureCheck(young),
      pureUnder: pureCheck({ ...young, reputationScore: 9, deploymentAgeDays: 0 }),
      preview: await preview("lst_1", "org_1"),
      route: res.json(),
    }));
    process.exit(0);
  })().catch((err) => { console.error(err); process.exit(1); });`;
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", "-e", script],
    {
      cwd: new URL("../..", import.meta.url),
      // The whole environment of the child, written out: nothing is set on
      // this process.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "development",
        LOG_LEVEL: "error",
        DATABASE_URL: "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai",
        JWT_SECRET: "12345678901234567890123456789012",
        TOKEN_LAUNCH_MIN_REPUTATION: "10",
        TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS: "1",
      },
      timeout: 60_000,
    },
  );
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `the child printed no result: ${stdout}`);
  const got = JSON.parse(line.slice("RESULT ".length));

  assert.deepEqual(got.thresholds, { minReputation: 10, minDeploymentAgeDays: 1 });
  // The launch route's call: an agent the production rule refuses passes,
  // and one point or one day under the lowered rule is still refused.
  assert.deepEqual(got.pure, { eligible: true });
  assert.deepEqual(got.pureUnder, {
    eligible: false,
    reasons: ["reputation_too_low", "uptime_insufficient"],
  });
  // The public agent page's call.
  assert.deepEqual(got.preview, { eligible: true, reasons: [] });
  // The route as index.ts mounts it.
  assert.equal(got.route.eligible, true);
  assert.equal(got.route.requirements.minReputation, 10);
  assert.equal(got.route.requirements.minDeploymentAgeDays, 1);
});
