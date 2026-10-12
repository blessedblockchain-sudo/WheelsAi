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

// ============================================
// The preview and the launch gate agree at every setting
// ============================================
//
// The launch route (routes/tokenLaunchPartialSign.ts) decides with the
// facts loadEligibilityStateByPrisma reads and the pure check of
// services/tokenEligibility.ts. The wizard trusts the preview, so the
// preview must give the same yes or no: a preview that refuses what the
// route accepts blocks a creator for nothing, and one that accepts what
// the route refuses lets them fill the whole wizard in vain.
//
// A `World` is one agent as the database has it. Each test below hands the
// same world to both sides. Here the route's side is its loader and its
// pure check with the thresholds passed in; the last test of this file
// runs the route itself.

interface World {
  listingStatus: string;
  hasToken: boolean;
  // null: the organization has no publisher profile.
  reputationScore: number | null;
  // null: the agent has no running deployment.
  runningDays: number | null;
  settled?: number;
}

const WALLET = "EeYpfM4mEYHRJV6w3WAyKVMv47o6sNFM4nXjN3JoEHbW";

// Half a day over, so the whole-day arithmetic cannot land on an edge.
function startedAt(days: number): Date {
  return new Date(Date.now() - (days + 0.5) * MS_PER_DAY);
}

// The world as the preview's queries see it.
function stubWorld(p: any, world: World) {
  p.agentListing.findUnique = async () => ({
    id: "lst_1",
    publisherId: "org_1",
    status: world.listingStatus,
    agent: {
      id: "agent_1",
      deployments:
        world.runningDays === null ? [] : [{ createdAt: startedAt(world.runningDays) }],
    },
  });
  p.agentToken.findUnique = async () =>
    world.hasToken ? { id: "tok_1", agentListingId: "lst_1" } : null;
  p.publisherProfile.findUnique = async () =>
    world.reputationScore === null
      ? null
      : { orgId: "org_1", reputationScore: world.reputationScore };
  p.agentDeployment.findMany = async () =>
    world.runningDays === null ? [] : [{ id: "dep_1", modelDeploymentId: null }];
  p.x402Payment.count = async () => world.settled ?? 0;
}

// The same world as the launch route's loader sees it.
function loaderPrisma(world: World) {
  return {
    agent: {
      findFirst: async () => ({
        id: "agent_1",
        orgId: "org_1",
        name: "Agent",
        deployments:
          world.runningDays === null
            ? []
            : [
                {
                  id: "dep_1",
                  status: "running",
                  createdAt: startedAt(world.runningDays),
                  modelDeploymentId: null,
                },
              ],
        listing: {
          status: world.listingStatus,
          agentToken: world.hasToken ? { id: "tok_1", mintAddress: "mint_1" } : null,
        },
      }),
    },
    publisherProfile: {
      findUnique: async () =>
        world.reputationScore === null
          ? null
          : { orgId: "org_1", reputationScore: world.reputationScore },
    },
    x402Payment: { count: async () => world.settled ?? 0 },
  };
}

async function decideBoth(
  world: World,
  gate: { minReputation: number; minDeploymentAgeDays: number },
) {
  const p = await getPrisma();
  const orig = snapshot(p);
  try {
    stubWorld(p, world);
    const { checkTokenEligibility: preview } = await import("../services/agentToken.js");
    const { checkTokenEligibility: pureCheck } = await import(
      "../services/tokenEligibility.js"
    );
    const { loadEligibilityStateByPrisma } = await import(
      "../services/loadEligibilityState.js"
    );

    const state = await loadEligibilityStateByPrisma(
      { agentId: "agent_1", orgId: "org_1" },
      { prisma: loaderPrisma(world), getCreatorAddress: async () => "ignored" },
    );
    assert.ok(state);
    // The call the launch route makes, with the thresholds handed in.
    const route = pureCheck(
      {
        reputationScore: state.reputationScore,
        deploymentAgeDays: state.deploymentAgeDays,
        hasPublishedListing: state.hasPublishedListing,
        alreadyTokenized: state.alreadyTokenized,
        creatorAddress: WALLET,
        settledPaidRequests: state.settledPaidRequests,
      },
      gate,
    );
    return { route, preview: await preview("lst_1", "org_1", gate) };
  } finally {
    restore(p, orig);
  }
}

const DEFAULTS = { minReputation: 50, minDeploymentAgeDays: 7 };
const healthy: World = {
  listingStatus: "published",
  hasToken: false,
  reputationScore: 60,
  runningDays: 10,
};

test("case 1: at the defaults, reputation 60 and 10 days running pass both", async () => {
  const { route, preview } = await decideBoth(healthy, DEFAULTS);
  assert.deepEqual(route, { eligible: true });
  assert.deepEqual(preview, { eligible: true, reasons: [] });
});

test("case 2: with the age at 0 days, an agent with no deployment passes both", async () => {
  const { route, preview } = await decideBoth(
    { ...healthy, runningDays: null },
    { minReputation: 50, minDeploymentAgeDays: 0 },
  );
  assert.deepEqual(route, { eligible: true });
  assert.deepEqual(preview, { eligible: true, reasons: [] });
});

test("case 3: at 0 and 0, an organization with no publisher profile and no deployment passes both", async () => {
  const { route, preview } = await decideBoth(
    { ...healthy, reputationScore: null, runningDays: null },
    { minReputation: 0, minDeploymentAgeDays: 0 },
  );
  assert.deepEqual(route, { eligible: true });
  assert.deepEqual(preview, { eligible: true, reasons: [] });
});

test("case 4: at the defaults, no publisher profile is refused by both, in the old words", async () => {
  const { route, preview } = await decideBoth({ ...healthy, reputationScore: null }, DEFAULTS);
  assert.deepEqual(route, { eligible: false, reasons: ["reputation_too_low"] });
  assert.deepEqual(preview, { eligible: false, reasons: ["Publisher profile not found"] });
});

test("case 5: at the defaults, 3 days running is refused by both, in the old words", async () => {
  const { route, preview } = await decideBoth({ ...healthy, runningDays: 3 }, DEFAULTS);
  assert.deepEqual(route, { eligible: false, reasons: ["uptime_insufficient"] });
  assert.deepEqual(preview, {
    eligible: false,
    reasons: ["Agent must be deployed for at least 7 days (current: 3 days)"],
  });
});

test("case 6: a listing that is not published is refused by both, at the defaults and at 0 and 0", async () => {
  for (const gate of [DEFAULTS, { minReputation: 0, minDeploymentAgeDays: 0 }]) {
    const { route, preview } = await decideBoth({ ...healthy, listingStatus: "draft" }, gate);
    assert.deepEqual(route, { eligible: false, reasons: ["listing_not_published"] });
    assert.deepEqual(preview, {
      eligible: false,
      reasons: ["Agent listing must be published before creating a token"],
    });
  }
});

test("case 7: a listing that already has a token is refused by both, at the defaults and at 0 and 0", async () => {
  for (const gate of [DEFAULTS, { minReputation: 0, minDeploymentAgeDays: 0 }]) {
    const { route, preview } = await decideBoth({ ...healthy, hasToken: true }, gate);
    assert.deepEqual(route, { eligible: false, reasons: ["already_tokenized"] });
    assert.deepEqual(preview, {
      eligible: false,
      reasons: ["Token already exists for this agent listing"],
    });
  }
});

test("at the defaults, an agent with no running deployment is refused by both, in the old words", async () => {
  const { route, preview } = await decideBoth({ ...healthy, runningDays: null }, DEFAULTS);
  assert.deepEqual(route, { eligible: false, reasons: ["uptime_insufficient"] });
  assert.deepEqual(preview, {
    eligible: false,
    reasons: ["Agent must have at least one running deployment"],
  });
});

test("each number at 0 lifts its own refusal only", async () => {
  const bare: World = { ...healthy, reputationScore: null, runningDays: null };

  const ageOnly = await decideBoth(bare, { minReputation: 50, minDeploymentAgeDays: 0 });
  assert.deepEqual(ageOnly.route, { eligible: false, reasons: ["reputation_too_low"] });
  assert.deepEqual(ageOnly.preview, {
    eligible: false,
    reasons: ["Publisher profile not found"],
  });

  const reputationOnly = await decideBoth(bare, { minReputation: 0, minDeploymentAgeDays: 7 });
  assert.deepEqual(reputationOnly.route, { eligible: false, reasons: ["uptime_insufficient"] });
  assert.deepEqual(reputationOnly.preview, {
    eligible: false,
    reasons: ["Agent must have at least one running deployment"],
  });
});

test("paid usage that brings the reputation bar to 0 lets a missing profile through both", async () => {
  // 20 minus 25 for paid usage: the bar is below 0, and a missing profile
  // counts as a reputation of 0.
  const { route, preview } = await decideBoth(
    { ...healthy, reputationScore: null, settled: 25 },
    { minReputation: 20, minDeploymentAgeDays: 7 },
  );
  assert.deepEqual(route, { eligible: true });
  assert.deepEqual(preview, { eligible: true, reasons: [] });
});

test("the preview and the gate give the same yes or no across settings and agents", async () => {
  const gates = [
    DEFAULTS,
    { minReputation: 0, minDeploymentAgeDays: 0 },
    { minReputation: 0, minDeploymentAgeDays: 7 },
    { minReputation: 50, minDeploymentAgeDays: 0 },
    { minReputation: 10, minDeploymentAgeDays: 1 },
  ];
  const worlds: World[] = [];
  for (const listingStatus of ["published", "draft"]) {
    for (const hasToken of [false, true]) {
      for (const reputationScore of [null, 0, 9, 10, 49, 50, 60]) {
        for (const runningDays of [null, 0, 1, 3, 7, 10]) {
          for (const settled of [0, 30]) {
            worlds.push({ listingStatus, hasToken, reputationScore, runningDays, settled });
          }
        }
      }
    }
  }
  for (const gate of gates) {
    for (const world of worlds) {
      const { route, preview } = await decideBoth(world, gate);
      const at = JSON.stringify({ gate, world });
      assert.equal(preview.eligible, route.eligible, at);
      // One sentence for each of the gate's reasons, none of its own.
      assert.equal(preview.reasons.length, route.eligible ? 0 : route.reasons.length, at);
    }
  }
});

// The tests above hand the thresholds to the pure check. The launch route
// reads them from the server's settings itself, so this one runs the route
// (POST /launch/prepare, with a launchpad that builds nothing) and the
// preview side by side in a process of its own, once with both settings at
// 0 and once with them written out as 50 and 7. This process's environment
// is not changed.

async function runRouteAndPreview<Name extends string>(
  settings: { reputation: string; days: string },
  worlds: Record<Name, World>,
): Promise<Record<Name, { status: number; body: any; preview: any }>> {
  const at = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `(async () => {
    const worlds = ${JSON.stringify(worlds)};
    const started = (days) => new Date(Date.now() - (days + 0.5) * 86400000);
    const { prisma: p } = await import("@wheelsai/db");
    const { checkTokenEligibility: preview } = await import(${at("../services/agentToken.ts")});
    const { loadEligibilityStateByPrisma } = await import(${at("../services/loadEligibilityState.ts")});
    const { createPartialSignTokenRoutes } = await import(${at("../routes/tokenLaunchPartialSign.ts")});
    const { default: Fastify } = await import("fastify");

    const out = {};
    for (const [name, world] of Object.entries(worlds)) {
      const profile = world.reputationScore === null
        ? null
        : { orgId: "org_1", reputationScore: world.reputationScore };
      const token = world.hasToken ? { id: "tok_1", mintAddress: "mint_1" } : null;

      p.agentListing.findUnique = async () => ({
        id: "lst_1",
        publisherId: "org_1",
        status: world.listingStatus,
        agent: {
          id: "agent_1",
          deployments: world.runningDays === null ? [] : [{ createdAt: started(world.runningDays) }],
        },
      });
      p.agentToken.findUnique = async () => token;
      p.publisherProfile.findUnique = async () => profile;
      p.agentDeployment.findMany = async () =>
        world.runningDays === null ? [] : [{ id: "dep_1", modelDeploymentId: null }];
      p.x402Payment.count = async () => 0;

      const loader = {
        agent: {
          findFirst: async () => ({
            id: "agent_1",
            orgId: "org_1",
            name: "Agent",
            deployments: world.runningDays === null ? [] : [{
              id: "dep_1",
              status: "running",
              createdAt: started(world.runningDays),
              modelDeploymentId: null,
            }],
            listing: { status: world.listingStatus, agentToken: token },
          }),
        },
        publisherProfile: { findUnique: async () => profile },
        x402Payment: { count: async () => 0 },
      };

      const app = Fastify({ logger: false });
      app.addHook("onRequest", async (request) => {
        request.auth = { userId: "user_1", orgId: "org_1", type: "jwt", walletAddress: ${JSON.stringify(WALLET)} };
      });
      await app.register(createPartialSignTokenRoutes({
        loadEligibilityState: ({ agentId, orgId }) =>
          loadEligibilityStateByPrisma(
            { agentId, orgId },
            { prisma: loader, getCreatorAddress: async () => "ignored" },
          ),
        resolveAgentListingId: async () => "lst_1",
        launchpad: {
          id: "pumpfun",
          prepareLaunch: async () => ({
            partialSignedTxBase64: "NOT_A_TRANSACTION",
            mintAddress: "11111111111111111111111111111111",
            creatorPubkey: ${JSON.stringify(WALLET)},
            context: {},
          }),
          broadcastLaunch: async () => { throw new Error("never sent in this test"); },
        },
        persistAgentTokenWithTreasury: async () => { throw new Error("never saved in this test"); },
        reconcileLaunch: async () => { throw new Error("never saved in this test"); },
        prepareTokenSecret: "test-prepare-secret-1234567890ab",
      }));
      const res = await app.inject({
        method: "POST",
        url: "/launch/prepare",
        payload: { agentId: "agent_1", name: "Agent", symbol: "AGT", description: "An agent" },
      });
      await app.close();
      out[name] = { status: res.statusCode, body: res.json(), preview: await preview("lst_1", "org_1") };
    }
    console.log("RESULT " + JSON.stringify(out));
    process.exit(0);
  })().catch((err) => { console.error(err); process.exit(1); });`;
  const { stdout } = await run(process.execPath, ["--import", "tsx", "-e", script], {
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
      TOKEN_LAUNCH_MIN_REPUTATION: settings.reputation,
      TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS: settings.days,
    },
    timeout: 60_000,
  });
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `the child printed no result: ${stdout}`);
  return JSON.parse(line.slice("RESULT ".length));
}

test("the launch route itself and the preview agree with both settings at 0", async () => {
  const got = await runRouteAndPreview(
    { reputation: "0", days: "0" },
    {
      noDeployment: { ...healthy, runningDays: null },
      noProfileNoDeployment: { ...healthy, reputationScore: null, runningDays: null },
      notPublished: { ...healthy, listingStatus: "draft" },
      hasToken: { ...healthy, hasToken: true },
    },
  );

  for (const name of ["noDeployment", "noProfileNoDeployment"] as const) {
    assert.equal(got[name].status, 200, name);
    assert.ok(got[name].body.prepareToken, name);
    assert.deepEqual(got[name].preview, { eligible: true, reasons: [] }, name);
  }

  assert.equal(got.notPublished.status, 400);
  assert.deepEqual(got.notPublished.body, {
    error: "not_eligible",
    reasons: ["listing_not_published"],
  });
  assert.deepEqual(got.notPublished.preview, {
    eligible: false,
    reasons: ["Agent listing must be published before creating a token"],
  });

  assert.equal(got.hasToken.status, 400);
  assert.deepEqual(got.hasToken.body, { error: "not_eligible", reasons: ["already_tokenized"] });
  assert.deepEqual(got.hasToken.preview, {
    eligible: false,
    reasons: ["Token already exists for this agent listing"],
  });
});

test("the launch route itself and the preview agree at 50 and 7 days", async () => {
  const got = await runRouteAndPreview(
    { reputation: "50", days: "7" },
    {
      healthy,
      noProfile: { ...healthy, reputationScore: null },
      threeDays: { ...healthy, runningDays: 3 },
      noDeployment: { ...healthy, runningDays: null },
    },
  );

  assert.equal(got.healthy.status, 200);
  assert.deepEqual(got.healthy.preview, { eligible: true, reasons: [] });

  assert.equal(got.noProfile.status, 400);
  assert.deepEqual(got.noProfile.body, { error: "not_eligible", reasons: ["reputation_too_low"] });
  assert.deepEqual(got.noProfile.preview, {
    eligible: false,
    reasons: ["Publisher profile not found"],
  });

  assert.equal(got.threeDays.status, 400);
  assert.deepEqual(got.threeDays.body, { error: "not_eligible", reasons: ["uptime_insufficient"] });
  assert.deepEqual(got.threeDays.preview, {
    eligible: false,
    reasons: ["Agent must be deployed for at least 7 days (current: 3 days)"],
  });

  assert.equal(got.noDeployment.status, 400);
  assert.deepEqual(got.noDeployment.body, {
    error: "not_eligible",
    reasons: ["uptime_insufficient"],
  });
  assert.deepEqual(got.noDeployment.preview, {
    eligible: false,
    reasons: ["Agent must have at least one running deployment"],
  });
});
