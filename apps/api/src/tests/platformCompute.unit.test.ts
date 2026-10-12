import assert from "node:assert/strict";
import { after, test } from "node:test";

import Fastify from "fastify";

import { startFakeNosanaApi, startRequestCounter, FAKE_MARKETS } from "./fakeNosanaApi.js";

// The operator view of the GPU compute account (GET /api/platform/compute) and
// the "GPU compute" component of the public status page.
//
// Three layers: the pure computation (hand-written deps), the route's admin
// gate, and the production wiring through the REAL NosanaClient against the
// fake Nosana REST API on loopback, over an in-memory stand-in for our tables.
// Nothing here leaves the machine.

const fake = await startFakeNosanaApi();
const rpc = await startRequestCounter();
/** The key the client is configured with; tests that rotate the fake's key restore this one. */
const API_KEY = fake.apiKey;
after(async () => {
  await fake.close();
  await rpc.close();
});

// Before any app module loads: config/env.ts and config/nosanaAccess.ts read these.
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
process.env.SOLANA_RPC_URL = rpc.url;
process.env.SOLANA_NETWORK = "devnet";
process.env.NOSANA_API_KEY = fake.apiKey;
process.env.NOSANA_API_URL = fake.url;
process.env.NOSANA_CREDITS_CACHE_MS = "0";
process.env.NOSANA_COST_CACHE_MS = "0";
for (const name of [
  "NOSANA_WALLET_PRIVATE_KEY",
  "NOSANA_ACCESS_MODE",
  "NOSANA_NETWORK",
  "NOSANA_TIMEOUT_UNIT",
  "NOSANA_MIN_CREDITS_USD",
  "NOSANA_CREDITS_WARN_USD",
  "NOSANA_MARKETS_JSON",
  "NOSANA_JOB_TIMEOUT_SECONDS",
  "ALLOW_NOSANA_MOCK",
  "SOLANA_WALLET",
  "ANCHOR_PROVIDER_URL",
]) {
  delete process.env[name];
}

const {
  adminKeyMatches,
  classifyCredits,
  computePlatformCompute,
  createPlatformComputeRoutes,
  findUntracked,
  gpuComputeStatus,
  parseWheelsaiName,
  tierEconomics,
  MAX_LISTED,
} = await import("../routes/platformCompute.js");
const { buildGpuComputeProbe, buildPlatformComputeDeps } = await import(
  "../routes/platformComputeBindings.js"
);
const { createStatusRoutes } = await import("../routes/status.js");
const { adapterServingOperatorBlockers } = await import("../services/fineTunedModels.js");
const { NosanaClient } = await import("../services/nosana.js");
const { getNosanaAccessConfig, resetNosanaAccessConfigForTests } = await import(
  "../config/nosanaAccess.js"
);
const { summarizePublicLatencyDetail } = await import("../services/publicLatency.js");

import type {
  ListedNosanaDeployment,
  OpenNosanaRow,
  PlatformComputeAccess,
  PlatformComputeDeps,
} from "../routes/platformCompute.js";
import type { PlatformComputePrisma } from "../routes/platformComputeBindings.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ADMIN_KEY = "operator-key-for-tests-0001";
const USD = (n: number) => BigInt(Math.round(n * 1_000_000));
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const COST_3060 = {
  address: "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq",
  usdPerHour: 0.0436,
  feePct: 10,
  costMicroUsdPerSecond: 14n,
};

function access(over: Partial<PlatformComputeAccess> = {}): PlatformComputeAccess {
  return {
    mode: "api_key",
    network: "mainnet",
    hasWallet: false,
    hasApiKey: true,
    apiKeySuffix: "0001",
    minCreditsMicroUsd: USD(5),
    warnCreditsMicroUsd: USD(20),
    timeoutUnit: "seconds",
    timeoutUnitExplicit: false,
    warnings: [],
    ...over,
  };
}

function balance(availableUsd: number) {
  return {
    assignedMicroUsd: USD(availableUsd + 3),
    reservedMicroUsd: USD(2),
    settledMicroUsd: USD(1),
    availableMicroUsd: USD(availableUsd),
    fetchedAt: NOW,
  };
}

function listed(over: Partial<ListedNosanaDeployment> = {}): ListedNosanaDeployment {
  return {
    id: "dm1",
    name: "wheelsai-model-3f0c2f0e-6a57-4b53-9f43-0d1b2c3d4e5f-r0",
    status: "running",
    replicas: 1,
    createdAt: minutesAgo(60),
    accessMode: "api_key",
    ...over,
  };
}

function deps(over: Partial<PlatformComputeDeps> = {}): PlatformComputeDeps {
  return {
    adminKey: () => ADMIN_KEY,
    access: async () => access(),
    readCredits: async () => balance(50),
    minimumDeployCredits: async () => USD(5.1008),
    readWallet: async () => {
      throw new Error("no wallet in this test");
    },
    tiers: async () => [
      {
        tier: "3060",
        name: "RTX 3060",
        marketAddress: COST_3060.address,
        retailPricePerSecond: 0.0001,
        deployable: true,
      },
      { tier: "a100", name: "A100 40GB", marketAddress: null, retailPricePerSecond: 0.0008, deployable: false },
    ],
    readMarketCosts: async () => ({ "3060": COST_3060, a100: null }),
    listNosanaDeployments: async () => [],
    findTrackedIds: async () => new Set(),
    loadOpenRows: async () => [],
    loadRunning: async () => [],
    now: () => NOW,
    timeoutMs: 200,
    ...over,
  };
}

// ============================================
// Pure helpers
// ============================================

test("classifyCredits: blocked below what the cheapest deployment needs, low below the warning, else ok", () => {
  const base = { minimumDeployMicroUsd: USD(5.1008), floorMicroUsd: USD(5), warnMicroUsd: USD(20) };
  assert.equal(classifyCredits({ ...base, availableMicroUsd: USD(5.05) }), "blocked");
  assert.equal(classifyCredits({ ...base, availableMicroUsd: USD(5.1008) }), "low");
  assert.equal(classifyCredits({ ...base, availableMicroUsd: USD(19.99) }), "low");
  assert.equal(classifyCredits({ ...base, availableMicroUsd: USD(20) }), "ok");
  // No estimate known: the floor alone decides.
  const noEstimate = { ...base, minimumDeployMicroUsd: null };
  assert.equal(classifyCredits({ ...noEstimate, availableMicroUsd: USD(4.99) }), "blocked");
  assert.equal(classifyCredits({ ...noEstimate, availableMicroUsd: USD(5) }), "low");
});

test("parseWheelsaiName reads the row out of the names the platform gives its deployments", () => {
  const id = "3f0c2f0e-6a57-4b53-9f43-0d1b2c3d4e5f";
  assert.deepEqual(parseWheelsaiName(`wheelsai-model-${id}-r3`), { scope: "model", rowId: id, run: 3 });
  assert.deepEqual(parseWheelsaiName(`wheelsai-agent-${id}`), { scope: "agent", rowId: id, run: null });
  assert.equal(parseWheelsaiName("wheelsai-1759838400000"), null);
  assert.equal(parseWheelsaiName(`other-model-${id}-r0`), null);
});

test("findUntracked: our prefix, starting or running, in no row, past the grace period", () => {
  const rows = [
    listed({ id: "old-running" }),
    listed({ id: "old-starting", status: "starting" }),
    listed({ id: "tracked" }),
    listed({ id: "young", createdAt: minutesAgo(14) }),
    listed({ id: "just-past", createdAt: minutesAgo(16) }),
    listed({ id: "stopped", status: "stopped" }),
    listed({ id: "halted", status: "insufficient_funds" }),
    listed({ id: "someone-elses", name: "another-project-api" }),
    listed({ id: "no-age", createdAt: null }),
  ];
  assert.deepEqual(
    findUntracked(rows, new Set(["tracked"]), NOW).map((d) => d.id),
    ["old-running", "old-starting", "just-past", "no-age"],
  );
});

test("tierEconomics: fee-inclusive cost, margin, and no verdict without a cost", () => {
  const tier = {
    tier: "3060",
    name: "RTX 3060",
    marketAddress: COST_3060.address,
    retailPricePerSecond: 0.0001,
    deployable: true,
  };
  const priced = tierEconomics(tier, COST_3060);
  assert.equal(priced.retailUsdPerHour, 0.36);
  assert.equal(priced.costUsdPerHour, 0.0504); // 14 micro-USD x 3600
  assert.equal(priced.marginPct, 86);
  assert.equal(priced.belowCost, false);

  const underwater = tierEconomics(tier, { ...COST_3060, costMicroUsdPerSecond: 101n });
  assert.equal(underwater.belowCost, true);
  assert.ok(underwater.marginPct! < 0);

  const unknown = tierEconomics(tier, null);
  assert.deepEqual(
    [unknown.costUsdPerHour, unknown.marginPct, unknown.belowCost],
    [null, null, null],
    "an unpriced tier gets no cost, never a guessed one",
  );
});

test("adminKeyMatches compares whole keys and tolerates a missing or non-string header", () => {
  assert.equal(adminKeyMatches(ADMIN_KEY, ADMIN_KEY), true);
  assert.equal(adminKeyMatches(`${ADMIN_KEY}x`, ADMIN_KEY), false);
  assert.equal(adminKeyMatches(undefined, ADMIN_KEY), false);
  assert.equal(adminKeyMatches([ADMIN_KEY], ADMIN_KEY), false);
});

// ============================================
// The computation
// ============================================

test("API-key access, healthy: credits, tiers and what is running", async () => {
  const body = await computePlatformCompute(
    deps({
      loadRunning: async () => [
        { gpuTier: "3060", replicas: 2 },
        { gpuTier: "3060", replicas: 1 },
      ],
    }),
  );
  assert.equal(body.mode, "api_key");
  assert.equal(body.configured, true);
  assert.deepEqual(body.credentials, { wallet: false, apiKey: true, apiKeySuffix: "0001" });
  assert.deepEqual(body.credits, {
    state: "ok",
    reason: null,
    assignedUsd: 53,
    reservedUsd: 2,
    settledUsd: 1,
    availableUsd: 50,
    minRequiredUsd: 5,
    minimumDeployUsd: 5.1008,
    warnUsd: 20,
    checkedAt: NOW.toISOString(),
  });
  assert.equal(body.wallet, null, "no wallet is loaded, so no wallet section");
  assert.equal(body.marketCosts.state, "ok");
  assert.deepEqual(body.tiers.map((t) => [t.tier, t.deployable, t.costUsdPerHour, t.belowCost]), [
    ["3060", true, 0.0504, false],
    ["a100", false, null, null],
  ]);
  assert.deepEqual(body.running, {
    deployments: 2,
    replicas: 3,
    retailUsdPerHour: 1.08,
    estimatedCostUsdPerHour: 0.1512,
  });
  assert.deepEqual(body.nosana.untracked, []);
  assert.deepEqual(body.unreachable, { rows: [], truncated: false });
  assert.equal(body.rows.state, "ok");
});

test("credit states: low, blocked, and an unreadable balance carries its code and no amounts", async () => {
  const low = await computePlatformCompute(deps({ readCredits: async () => balance(10) }));
  assert.equal(low.credits.state, "low");

  const blocked = await computePlatformCompute(deps({ readCredits: async () => balance(5.05) }));
  assert.equal(blocked.credits.state, "blocked");
  assert.equal(blocked.credits.availableUsd, 5.05);

  const rejected = await computePlatformCompute(
    deps({
      readCredits: async () => {
        throw Object.assign(new Error("Nosana rejected the platform API key"), {
          code: "nosana_auth_failed",
        });
      },
    }),
  );
  assert.equal(rejected.credits.state, "unreadable");
  assert.equal(rejected.credits.reason, "nosana_auth_failed");
  assert.equal(rejected.credits.availableUsd, null);
  assert.equal(rejected.credits.checkedAt, null);

  const hung = await computePlatformCompute(
    deps({ readCredits: () => new Promise(() => {}), timeoutMs: 20 }),
  );
  assert.equal(hung.credits.state, "unreadable");
  assert.equal(hung.credits.reason, "read_failed");
});

test("wallet access: credits do not apply and are never read; the wallet section carries its balances", async () => {
  let creditReads = 0;
  const body = await computePlatformCompute(
    deps({
      access: async () => access({ mode: "wallet", hasWallet: true, hasApiKey: false, apiKeySuffix: null }),
      readCredits: async () => {
        creditReads += 1;
        return balance(1);
      },
      minimumDeployCredits: async () => {
        creditReads += 1;
        return 0n;
      },
      readWallet: async () => ({ publicKey: "Wa11etPubKey", sol: 0.5, nos: 120 }),
    }),
  );
  assert.equal(creditReads, 0);
  assert.equal(body.credits.state, "not_applicable");
  assert.equal(body.credits.availableUsd, null);
  assert.deepEqual(body.wallet, { state: "ok", publicKey: "Wa11etPubKey", sol: 0.5, nos: 120 });

  const unreadable = await computePlatformCompute(
    deps({
      access: async () => access({ mode: "wallet", hasWallet: true, hasApiKey: false, apiKeySuffix: null }),
      readWallet: async () => {
        throw new Error("rpc down");
      },
    }),
  );
  assert.deepEqual(unreadable.wallet, { state: "unreadable", publicKey: null, sol: null, nos: null });
});

test("nothing configured: says so, asks Nosana for nothing but the public market list", async () => {
  const asked: string[] = [];
  const body = await computePlatformCompute(
    deps({
      access: async () => access({ mode: "none", hasWallet: false, hasApiKey: false, apiKeySuffix: null }),
      readCredits: async () => (asked.push("credits"), balance(1)),
      readWallet: async () => (asked.push("wallet"), { publicKey: "x", sol: 0, nos: 0 }),
      listNosanaDeployments: async () => (asked.push("list"), []),
    }),
  );
  assert.deepEqual(asked, []);
  assert.equal(body.configured, false);
  assert.equal(body.mode, "none");
  assert.equal(body.credits.state, "not_applicable");
  assert.equal(body.wallet, null);
  assert.equal(body.nosana.state, "not_applicable");
  assert.equal(body.tiers[0]!.costUsdPerHour, 0.0504, "market costs are public and still shown");
});

test("a tier priced below its cost is flagged and reported (the wallet path refuses nothing in a request)", async () => {
  const reported: string[][] = [];
  const body = await computePlatformCompute(
    deps({
      access: async () => access({ mode: "wallet", hasWallet: true, hasApiKey: false }),
      readWallet: async () => ({ publicKey: "x", sol: 1, nos: 1 }),
      readMarketCosts: async () => ({ "3060": { ...COST_3060, costMicroUsdPerSecond: 150n }, a100: null }),
      reportBelowCost: (tiers) => reported.push(tiers),
    }),
  );
  assert.equal(body.tiers[0]!.belowCost, true);
  assert.deepEqual(reported, [["3060"]]);

  const quiet: string[][] = [];
  await computePlatformCompute(deps({ reportBelowCost: (tiers) => quiet.push(tiers) }));
  assert.deepEqual(quiet, [], "nothing is reported when every priced tier covers its cost");
});

test("an unreadable market list leaves every cost unknown instead of failing the view", async () => {
  const body = await computePlatformCompute(
    deps({
      readMarketCosts: async () => {
        throw new Error("The Nosana market list answered HTTP 502");
      },
      loadRunning: async () => [{ gpuTier: "3060", replicas: 1 }],
    }),
  );
  assert.equal(body.marketCosts.state, "unreadable");
  assert.ok(body.tiers.every((t) => t.costUsdPerHour === null && t.belowCost === null));
  assert.equal(body.running.estimatedCostUsdPerHour, null, "no estimate from an unknown cost");
  assert.equal(body.running.retailUsdPerHour, 0.36);
  assert.equal(body.credits.state, "ok", "the other sections are still answered");
});

test("untracked deployments are reported with the row their name points at, and only ids that could be ours are looked up", async () => {
  const id = "3f0c2f0e-6a57-4b53-9f43-0d1b2c3d4e5f";
  const lookedUp: string[][] = [];
  const body = await computePlatformCompute(
    deps({
      listNosanaDeployments: async () => [
        listed({ id: "ghost", name: `wheelsai-model-${id}-r2`, replicas: 2 }),
        listed({ id: "known" }),
        listed({ id: "fresh", createdAt: minutesAgo(2) }),
        listed({ id: "foreign", name: "someone-elses-deployment" }),
        listed({ id: "ended", status: "stopped" }),
        listed({ id: "left-draft", name: `wheelsai-agent-${id}`, status: "draft" }),
        listed({ id: "new-draft", status: "draft", createdAt: minutesAgo(1) }),
      ],
      findTrackedIds: async (ids) => {
        lookedUp.push(ids);
        return new Set(["known"]);
      },
    }),
  );
  assert.deepEqual(lookedUp, [["ghost", "known", "left-draft"]]);
  assert.equal(body.nosana.state, "ok");
  assert.equal(body.nosana.listed, 7);
  assert.equal(body.nosana.running, 4);
  assert.equal(body.nosana.graceMinutes, 15);
  assert.deepEqual(body.nosana.untracked, [
    {
      id: "ghost",
      name: `wheelsai-model-${id}-r2`,
      status: "running",
      replicas: 2,
      createdAt: minutesAgo(60).toISOString(),
      accessMode: "api_key",
      row: { scope: "model", rowId: id, run: 2 },
    },
  ]);
  // What a create call that threw leaves behind: a draft, named after its row.
  assert.deepEqual(
    body.nosana.untrackedDrafts.map((d) => [d.id, d.status, d.row]),
    [["left-draft", "draft", { scope: "agent", rowId: id, run: null }]],
  );
});

test("both credentials: each account is listed on its own, and one failing does not hide the other", async () => {
  const body = await computePlatformCompute(
    deps({
      access: async () => access({ hasWallet: true }),
      readWallet: async () => ({ publicKey: "x", sol: 1, nos: 1 }),
      listNosanaDeployments: async (mode) => {
        if (mode === "wallet") throw Object.assign(new Error("boom"), { code: "nosana_read_failed" });
        return [listed({ id: "ghost" })];
      },
    }),
  );
  assert.deepEqual(body.nosana.accounts, [
    { mode: "api_key", state: "ok", listed: 1, running: 1, error: null },
    { mode: "wallet", state: "unreadable", listed: null, running: null, error: "nosana_read_failed" },
  ]);
  assert.equal(body.nosana.state, "unreadable");
  assert.deepEqual(body.nosana.untracked.map((d) => d.id), ["ghost"]);
});

test("when our own tables cannot be read, nothing is called untracked", async () => {
  const body = await computePlatformCompute(
    deps({
      listNosanaDeployments: async () => [listed({ id: "ghost" })],
      findTrackedIds: async () => {
        throw new Error("database down");
      },
      loadOpenRows: async () => {
        throw new Error("database down");
      },
    }),
  );
  assert.deepEqual(body.nosana.untracked, []);
  assert.equal(body.nosana.state, "unreadable");
  assert.equal(body.rows.state, "unreadable");
});

test("training: what keeps fine-tuning from starting is listed for the operator, by code, with what to set", async () => {
  const missing = [
    { code: "training_image_not_configured", message: "The training image is not configured (TRAINING_IMAGE not set)." },
    { code: "training_poller_disabled", message: "The training poller is switched off (TRAINING_POLL_INTERVAL_MS is 0)." },
  ];
  const blocked = await computePlatformCompute(deps({ trainingBlockers: async () => missing }));
  assert.deepEqual(blocked.training, {
    state: "ok",
    canStart: false,
    blockers: missing,
    canDeployFineTuned: null,
    deployBlockers: [],
  });

  const ready = await computePlatformCompute(deps({ trainingBlockers: async () => [] }));
  assert.deepEqual(ready.training, {
    state: "ok",
    canStart: true,
    blockers: [],
    canDeployFineTuned: null,
    deployBlockers: [],
  });

  const unreadable = await computePlatformCompute(
    deps({
      trainingBlockers: async () => {
        throw new Error("config unreadable");
      },
    }),
  );
  assert.deepEqual(unreadable.training, {
    state: "unreadable",
    canStart: null,
    blockers: [],
    canDeployFineTuned: null,
    deployBlockers: [],
  });
  assert.equal(unreadable.rows.state, "ok", "one unreadable section does not fail the view");

  const unreported = await computePlatformCompute(deps());
  assert.deepEqual(unreported.training, {
    state: "not_applicable",
    canStart: null,
    blockers: [],
    canDeployFineTuned: null,
    deployBlockers: [],
  });
});

test("training: whether a fine-tuned model can be deployed is said beside it, with what a GPU node cannot reach", async () => {
  const unreachable = [
    {
      code: "adapter_download_not_reachable",
      message:
        "A GPU node cannot reach http://localhost:4000, where a deployment fetches its adapter: it is this machine or a private network. Set GPU_FACING_API_URL (or PUBLIC_API_URL) to a public address.",
    },
  ];
  const blocked = await computePlatformCompute(
    deps({ trainingBlockers: async () => [], deployBlockers: async () => unreachable }),
  );
  assert.deepEqual(blocked.training, {
    state: "ok",
    canStart: true,
    blockers: [],
    canDeployFineTuned: false,
    deployBlockers: unreachable,
  });

  const ready = await computePlatformCompute(deps({ trainingBlockers: async () => [], deployBlockers: async () => [] }));
  assert.equal(ready.training.canDeployFineTuned, true);
  assert.deepEqual(ready.training.deployBlockers, []);

  // A read that fails costs its own two fields and nothing else.
  const unreadable = await computePlatformCompute(
    deps({
      trainingBlockers: async () => [],
      deployBlockers: async () => {
        throw new Error("config unreadable");
      },
    }),
  );
  assert.deepEqual(unreadable.training, {
    state: "ok",
    canStart: true,
    blockers: [],
    canDeployFineTuned: null,
    deployBlockers: [],
  });

  // No object store: the operator reads which settings to set, from the serving code's own list.
  const noStore = await computePlatformCompute(
    deps({
      trainingBlockers: async () => [],
      deployBlockers: async () =>
        adapterServingOperatorBlockers({
          gpuFacingApiUrl: () => "https://api.example.com",
          gpuNodesAreLocal: () => false,
          getStore: () => null,
        }),
    }),
  );
  assert.equal(noStore.training.canDeployFineTuned, false);
  assert.deepEqual(noStore.training.deployBlockers, [
    {
      code: "adapter_storage_not_configured",
      message:
        "Object storage is not configured, so a deployment has nowhere to fetch a fine-tuned model's adapter from. Set STORAGE_DRIVER, or AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and DATASETS_BUCKET.",
    },
  ]);

  // Reported on its own too, when the training blockers are not.
  const alone = await computePlatformCompute(deps({ deployBlockers: async () => unreachable }));
  assert.deepEqual(alone.training, {
    state: "not_applicable",
    canStart: null,
    blockers: [],
    canDeployFineTuned: false,
    deployBlockers: unreachable,
  });
});

test("training: the operator sentences come from the training service, under the codes customers receive", async () => {
  const { trainingOperatorBlockers, TRAINING_UNAVAILABLE_MESSAGE, trainingBlockers } = await import(
    "../services/trainingJobs.js"
  );
  const runtime = {
    image: { configured: false as const, reason: "TRAINING_IMAGE not set" },
    hfToken: undefined,
    pollIntervalMs: 0,
    queueTimeoutSeconds: 1_800,
    setupAllowanceSeconds: 900,
    maxActiveJobsPerOrg: 2,
    freeFailuresPerDay: 3,
    orphanSweepEnabled: true,
    adapterMaxBytes: 1024 ** 3,
    datasetMaxBytes: 200 * 1024 ** 2,
    datasetMaxRows: 200_000,
    batchJobTimeoutSeconds: 21_600,
    gpuFacingApiUrl: "https://api.example.com",
    gpuNodesAreLocal: false,
    storageLinkOrigin: null,
    nosanaMock: false,
    nosanaConfigured: true,
    tiers: { "4090": { name: "RTX 4090", vram: 24, pricePerSecond: 0.0003 } },
    allTiers: { "4090": { name: "RTX 4090", vram: 24, pricePerSecond: 0.0003 } },
  };
  const operator = trainingOperatorBlockers(runtime, null, "AWS_ACCESS_KEY_ID, DATASETS_BUCKET not set");
  const body = await computePlatformCompute(deps({ trainingBlockers: async () => operator }));
  assert.deepEqual(
    body.training.blockers.map((b) => b.code),
    ["dataset_storage_not_configured", "training_image_not_configured", "training_poller_disabled"],
  );
  assert.match(body.training.blockers[0]!.message, /AWS_ACCESS_KEY_ID, DATASETS_BUCKET not set/);
  assert.match(body.training.blockers[1]!.message, /TRAINING_IMAGE not set/);
  assert.match(body.training.blockers[2]!.message, /TRAINING_POLL_INTERVAL_MS/);
  // The customer's view of the same state: the same codes, one calm sentence, no settings.
  const customer = trainingBlockers(runtime, null);
  assert.deepEqual(customer.map((b) => b.code), body.training.blockers.map((b) => b.code));
  for (const blocker of customer) assert.equal(blocker.message, TRAINING_UNAVAILABLE_MESSAGE);
});

test("rows whose access mode has no credential here are listed; mock ids and reachable rows are not", async () => {
  const open: OpenNosanaRow[] = [
    { source: "model", rowId: "m1", nosanaDeploymentId: "dmWallet", accessMode: "wallet", status: "running" },
    { source: "model", rowId: "m2", nosanaDeploymentId: "dmKey", accessMode: "api_key", status: "running" },
    { source: "agent", rowId: "a1", nosanaDeploymentId: "mock_deploy_1", accessMode: "wallet", status: "running" },
    { source: "orphan", rowId: "o1", nosanaDeploymentId: "dmOrphan", accessMode: "wallet", status: "unreleased" },
  ];
  const body = await computePlatformCompute(deps({ loadOpenRows: async () => open }));
  assert.deepEqual(body.unreachable.rows.map((r) => r.rowId), ["m1", "o1"]);
  assert.equal(body.unreachable.truncated, false);

  const withWallet = await computePlatformCompute(
    deps({
      access: async () => access({ hasWallet: true }),
      readWallet: async () => ({ publicKey: "x", sol: 1, nos: 1 }),
      loadOpenRows: async () => open,
    }),
  );
  assert.deepEqual(withWallet.unreachable.rows, [], "with both credentials loaded every row is reachable");

  const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => ({ ...open[0]!, rowId: `m${i}` }));
  const capped = await computePlatformCompute(deps({ loadOpenRows: async () => many }));
  assert.equal(capped.unreachable.rows.length, MAX_LISTED);
  assert.equal(capped.unreachable.truncated, true);
});

// ============================================
// The route's gate
// ============================================

async function request(routeDeps: PlatformComputeDeps, headers: Record<string, string> = {}) {
  const app = Fastify({ logger: false });
  await app.register(createPlatformComputeRoutes(routeDeps), { prefix: "/api/platform" });
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/platform/compute", headers });
  await app.close();
  return res;
}

test("GET /api/platform/compute: 503 by name when PLATFORM_ADMIN_KEY is unset, and nothing is read", async () => {
  let reads = 0;
  const res = await request(
    deps({
      adminKey: () => undefined,
      access: async () => {
        reads += 1;
        return access();
      },
    }),
    { "x-admin-key": ADMIN_KEY },
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "platform_admin_not_configured");
  assert.equal(reads, 0);
});

test("GET /api/platform/compute: 401 without the key or with a wrong one, and nothing is read", async () => {
  let reads = 0;
  const gated = deps({
    access: async () => {
      reads += 1;
      return access();
    },
  });
  for (const headers of [{}, { "x-admin-key": "not-the-key" }, { authorization: `Bearer ${ADMIN_KEY}` }]) {
    const res = await request(gated, headers as Record<string, string>);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "invalid_admin_key" });
  }
  assert.equal(reads, 0);
});

test("GET /api/platform/compute: 200 with the key, never cached, and the admin key is read per request", async () => {
  let current: string | undefined = ADMIN_KEY;
  const rotating = deps({ adminKey: () => current });
  const ok = await request(rotating, { "x-admin-key": ADMIN_KEY });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(ok.json().credits.state, "ok");

  current = "rotated-operator-key-0002";
  assert.equal((await request(rotating, { "x-admin-key": ADMIN_KEY })).statusCode, 401);
  assert.equal((await request(rotating, { "x-admin-key": current })).statusCode, 200);
});

// ============================================
// Production wiring, through the real NosanaClient against the fake API
// ============================================

type Row = Record<string, any>;

/** Enough of Prisma's `where` for the view's queries. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (typeof cond !== "object") return value === cond;
    if ("hasSome" in cond) return (value ?? []).some((v: string) => cond.hasSome.includes(v));
    if ("isEmpty" in cond) return ((value ?? []).length === 0) === cond.isEmpty;
    if ("in" in cond) return cond.in.includes(value);
    if ("not" in cond) return cond.not === null ? value !== null && value !== undefined : value !== cond.not;
    throw new Error(`unsupported where clause on ${key}`);
  });
}

function fakeDb(tables: {
  deployment?: Row[];
  agentDeployment?: Row[];
  trainingJob?: Row[];
  openClawDeployment?: Row[];
  nosanaOrphanDeployment?: Row[];
}): PlatformComputePrisma {
  const table = (rows: Row[] = []) => ({
    findMany: async (args: { where?: Row; take?: number }) =>
      rows.filter((r) => matches(r, args.where)).slice(0, args.take ?? rows.length),
  });
  return {
    deployment: table(tables.deployment),
    agentDeployment: table(tables.agentDeployment),
    trainingJob: table(tables.trainingJob),
    openClawDeployment: table(tables.openClawDeployment),
    nosanaOrphanDeployment: table(tables.nosanaOrphanDeployment),
  };
}

function resetFake(availableUsd = 100) {
  fake.rotateApiKey(API_KEY);
  fake.setBalance({ assignedCredits: availableUsd, reservedCredits: 0, settledCredits: 0 });
  fake.setMarkets(FAKE_MARKETS);
  fake.setOwner("11111111111111111111111111111111");
  fake.setInsufficientFunds(false);
  fake.deployments.clear();
  fake.requests.length = 0;
}

async function apiClient() {
  resetNosanaAccessConfigForTests();
  const client = new NosanaClient();
  await client.initialize();
  return client;
}

async function nosanaDeployment(client: InstanceType<typeof NosanaClient>, name: string) {
  const created = await client.createDeployment(
    { version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [] } as never,
    "3060",
    1,
    { name },
  );
  return created.id;
}

test("wired to the real client: balance, costs, untracked and unreachable rows, with GET requests only and no key in the body", async () => {
  resetFake(100);
  const client = await apiClient();
  const rowId = "3f0c2f0e-6a57-4b53-9f43-0d1b2c3d4e5f";
  const ghostRow = "9a1b2c3d-0000-4000-8000-000000000001";
  const trackedId = await nosanaDeployment(client, `wheelsai-model-${rowId}-r0`);
  const ghostId = await nosanaDeployment(client, `wheelsai-model-${ghostRow}-r1`);
  const orphanId = await nosanaDeployment(client, "wheelsai-agent-9a1b2c3d-0000-4000-8000-000000000002");
  fake.settle(trackedId);
  fake.requests.length = 0;
  const rpcBefore = rpc.count();

  const db = fakeDb({
    deployment: [
      // Created with the API key and running: tracked, reachable, counted as running.
      {
        id: rowId,
        status: "running",
        gpuTier: "3060",
        replicas: 2,
        nosanaJobIds: [trackedId],
        nosanaAccessMode: "api_key",
        vaultReclaimedAt: null,
      },
      // From before API-key access (null = wallet): no credential for it here.
      {
        id: "wallet-row",
        status: "running",
        gpuTier: "4090",
        replicas: 1,
        nosanaJobIds: ["walletEraDeployment"],
        nosanaAccessMode: null,
        vaultReclaimedAt: null,
      },
      // Ended and confirmed released: not open, whatever created it.
      {
        id: "done-row",
        status: "stopped",
        gpuTier: "3060",
        replicas: 1,
        nosanaJobIds: ["oldWalletDeployment"],
        nosanaAccessMode: null,
        vaultReclaimedAt: NOW,
      },
      // The row the ghost was created for: its create call threw, so it holds no id.
      { id: ghostRow, status: "failed", gpuTier: "3060", replicas: 1, nosanaJobIds: [], nosanaAccessMode: null, vaultReclaimedAt: null },
    ],
    nosanaOrphanDeployment: [
      { id: "orphan-1", nosanaDeploymentId: orphanId, accessMode: "api_key", reclaimedAt: null },
    ],
  });

  const body = await computePlatformCompute(
    buildPlatformComputeDeps({
      getClient: async () => client,
      prisma: db,
      getAccessConfig: getNosanaAccessConfig,
      adminKey: () => ADMIN_KEY,
      // Past the grace period for the deployments created a moment ago.
      now: () => new Date(Date.now() + 16 * 60_000),
    }),
  );

  assert.equal(body.mode, "api_key");
  assert.equal(body.network, "mainnet", "API-key access is mainnet although SOLANA_NETWORK is devnet");
  assert.deepEqual(body.credentials, { wallet: false, apiKey: true, apiKeySuffix: API_KEY.slice(-4) });
  assert.equal(body.wallet, null);
  assert.equal(body.credits.state, "ok");
  assert.equal(body.credits.availableUsd, 100);
  // Floor $5 + one 3060 replica for the 7200 s service estimate at 14 micro-USD/s.
  assert.equal(body.credits.minimumDeployUsd, 5.1008);

  const tier = (id: string) => body.tiers.find((t) => t.tier === id)!;
  assert.equal(tier("3060").deployable, true);
  assert.equal(tier("3060").costUsdPerHour, 0.0504);
  assert.equal(tier("4090").belowCost, false);
  assert.equal(tier("a100").costUsdPerHour, null, "the fake prices two markets; the rest are unknown");

  assert.deepEqual(body.nosana.accounts, [
    { mode: "api_key", state: "ok", listed: 3, running: 3, error: null },
  ]);
  assert.deepEqual(
    body.nosana.untracked.map((d) => [d.id, d.status, d.row]),
    [[ghostId, "running", { scope: "model", rowId: ghostRow, run: 1 }]],
    "the row-tracked and the orphan-recorded deployments are not untracked",
  );

  assert.deepEqual(body.unreachable.rows, [
    {
      source: "model",
      rowId: "wallet-row",
      nosanaDeploymentId: "walletEraDeployment",
      accessMode: "wallet",
      status: "running",
    },
  ]);
  assert.deepEqual(body.running, {
    deployments: 2,
    replicas: 3,
    retailUsdPerHour: 1.62,
    // Two 3060 replicas at 14 and one 4090 at 112 micro-USD per second.
    estimatedCostUsdPerHour: 0.504,
  });

  assert.ok(fake.requests.length > 0);
  assert.deepEqual(
    [...new Set(fake.requests.map((r) => r.method))],
    ["GET"],
    "the view reads; it never changes anything on Nosana",
  );
  assert.equal(fake.vaultCalls(), 0);
  assert.equal(rpc.count(), rpcBefore, "no Solana RPC request with API-key access");
  assert.ok(!JSON.stringify(body).includes(API_KEY), "the key never appears in the view");
  assert.equal(fake.deployments.get(ghostId)!.status, "RUNNING", "report-only: the untracked deployment is not stopped");
});

test("wired to the real client: a rejected key and a low balance read as unreadable and blocked", async () => {
  resetFake(5.05);
  const client = await apiClient();
  const viewDeps = buildPlatformComputeDeps({
    getClient: async () => client,
    prisma: fakeDb({}),
    getAccessConfig: getNosanaAccessConfig,
    adminKey: () => ADMIN_KEY,
  });

  const blocked = await computePlatformCompute(viewDeps);
  assert.equal(blocked.credits.state, "blocked");
  assert.equal(blocked.credits.availableUsd, 5.05);

  fake.rotateApiKey("nos_fake_key_rotated_away_0002");
  const rejected = await computePlatformCompute(viewDeps);
  assert.equal(rejected.credits.state, "unreadable");
  assert.equal(rejected.credits.reason, "nosana_auth_failed");
  assert.equal(rejected.nosana.accounts[0]!.error, "nosana_auth_failed");
  assert.equal(rejected.marketCosts.state, "ok", "the market list needs no key");
});

// ============================================
// Public status: the GPU compute component
// ============================================

test("gpuComputeStatus: absent when nothing is configured, operational with a wallet without reading anything", async () => {
  let reads = 0;
  const probe = (mode: "none" | "wallet" | "api_key") =>
    gpuComputeStatus({
      mode: () => mode,
      readCredits: async () => {
        reads += 1;
        return { availableMicroUsd: 0n };
      },
      minimumDeployCredits: async () => {
        reads += 1;
        return USD(5.1);
      },
      floorMicroUsd: () => USD(5),
    });
  assert.equal(await probe("none"), null);
  assert.equal(await probe("wallet"), "operational");
  assert.equal(reads, 0);
  assert.equal(await probe("api_key"), "paused");
  assert.equal(reads, 2);
});

test("gpuComputeStatus with an API key: paused below what a deployment needs, or when the balance cannot be read", async () => {
  const probe = (availableUsd: number | Error, minimum: bigint | null = USD(5.1008)) =>
    gpuComputeStatus({
      mode: () => "api_key",
      readCredits: async () => {
        if (availableUsd instanceof Error) throw availableUsd;
        return { availableMicroUsd: USD(availableUsd) };
      },
      minimumDeployCredits: async () => minimum,
      floorMicroUsd: () => USD(5),
    });
  assert.equal(await probe(50), "operational");
  assert.equal(await probe(5.1008), "operational");
  assert.equal(await probe(5.05), "paused");
  assert.equal(await probe(5.05, null), "operational", "no estimate known: the floor alone decides");
  assert.equal(await probe(4.99, null), "paused");
  assert.equal(await probe(new Error("credits unreadable")), "paused");
});

test("the status probe wired to the real client follows the balance on the fake API", async () => {
  resetFake(100);
  const client = await apiClient();
  const probe = buildGpuComputeProbe(async () => client, getNosanaAccessConfig);
  assert.equal(await probe(), "operational");
  fake.setBalance({ assignedCredits: 5.05, reservedCredits: 0, settledCredits: 0 });
  assert.equal(await probe(), "paused");
  fake.rotateApiKey("nos_fake_key_rotated_away_0003");
  assert.equal(await probe(), "paused");
  assert.deepEqual([...new Set(fake.requests.map((r) => r.method))], ["GET"]);

  const unconfigured = buildGpuComputeProbe(
    async () => {
      throw new Error("must not be asked");
    },
    () => ({ primary: "none", minCreditsMicroUsd: USD(5) }),
  );
  assert.equal(await unconfigured(), null);

  const broken = buildGpuComputeProbe(
    async () => {
      throw new Error("client could not start");
    },
    () => ({ primary: "api_key", minCreditsMicroUsd: USD(5) }),
  );
  assert.equal(await broken(), "paused");
});

type StatusDeps = Parameters<typeof createStatusRoutes>[0];

async function publicStatus(over: Partial<StatusDeps>) {
  const latencyThresholds = { windowHours: 24, minSamples: 50, minOrgs: 3 };
  const app = Fastify({ logger: false });
  await app.register(
    createStatusRoutes({
      checkDatabase: async () => {},
      checkRedis: async () => {},
      workers: [],
      readWorkerRuns: async () => ({}),
      loadPublicMonitors: null,
      loadMonitorDays: async () => [],
      latency: {
        detail: async () => summarizePublicLatencyDetail(null, latencyThresholds),
        unavailableDetail: () => summarizePublicLatencyDetail(null, latencyThresholds),
      },
      now: () => NOW,
      timeoutMs: 50,
      cacheTtlMs: 0,
      ...over,
    }),
    { prefix: "/api/status" },
  );
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/status" });
  await app.close();
  return res.json();
}

test("GET /api/status: the GPU compute component is left out when compute is not configured", async () => {
  const noProbe = await publicStatus({});
  assert.deepEqual(noProbe.components.map((c: { id: string }) => c.id), ["database", "redis"]);
  const unconfigured = await publicStatus({ gpuCompute: async () => null });
  assert.deepEqual(unconfigured.components.map((c: { id: string }) => c.id), ["database", "redis"]);
  assert.equal(unconfigured.status, "operational");
});

test("GET /api/status: GPU compute is operational or paused, with no amount and no reason", async () => {
  const fine = await publicStatus({ gpuCompute: async () => "operational" });
  assert.deepEqual(fine.components[2], {
    id: "gpu_compute",
    name: "GPU compute",
    status: "operational",
    latencyMs: null,
  });
  assert.equal(fine.status, "operational");

  const paused = await publicStatus({ gpuCompute: async () => "paused" });
  assert.deepEqual(paused.components[2], {
    id: "gpu_compute",
    name: "GPU compute",
    status: "paused",
    latencyMs: null,
  });
  assert.equal(paused.status, "degraded");
  const text = JSON.stringify(paused.components).toLowerCase();
  for (const word of ["credit", "nosana", "balance", "usd", "$"]) {
    assert.ok(!text.includes(word), `"${word}" must not be in the public components`);
  }
});

test("GET /api/status: a GPU compute probe that throws or hangs reads paused, and the page still answers", async () => {
  const thrown = await publicStatus({
    gpuCompute: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(thrown.components[2].status, "paused");
  const hung = await publicStatus({ gpuCompute: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(hung.components[2].status, "paused");
  assert.equal(hung.components[0].status, "operational");
});
