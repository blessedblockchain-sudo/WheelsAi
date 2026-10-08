import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { startFakeNosanaApi, startRequestCounter, FAKE_MARKETS } from "./fakeNosanaApi.js";

// NosanaClient with API-key access, driven through the REAL @nosana/sdk Client
// against the fake Nosana REST API on loopback. Nothing leaves this machine:
// the backend URL and the Solana RPC URL both point at 127.0.0.1, and the RPC
// stand-in counts every request it gets (it must get none).

const fake = await startFakeNosanaApi();
const rpc = await startRequestCounter();
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
// No cache: every balance and market read in these tests reaches the fake.
process.env.NOSANA_CREDITS_CACHE_MS = "0";
process.env.NOSANA_COST_CACHE_MS = "0";
for (const name of [
  "NOSANA_WALLET_PRIVATE_KEY",
  "NOSANA_ACCESS_MODE",
  "NOSANA_NETWORK",
  "NOSANA_TIMEOUT_UNIT",
  "NOSANA_MIN_CREDITS_USD",
  "NOSANA_MARKETS_JSON",
  "NOSANA_JOB_TIMEOUT_SECONDS",
  "NOSANA_BATCH_JOB_TIMEOUT_SECONDS",
  "ALLOW_NOSANA_MOCK",
  "SOLANA_WALLET",
  "ANCHOR_PROVIDER_URL",
]) {
  delete process.env[name];
}

const { NosanaClient, NosanaNotConfiguredError, NosanaAccessModeUnavailableError, NosanaOneShotUnavailableError, wheelsaiDeploymentName, normalizeDeploymentJob, DEPLOYMENT_ONLY } =
  await import("../services/nosana.js");
const { NosanaLifecycleError } = await import("../services/nosanaDeploymentLifecycle.js");
const { resetNosanaAccessConfigForTests } = await import("../config/nosanaAccess.js");
const { MarketNotConfiguredError } = await import("../services/nosanaMarkets.js");
const { pickFailureDetail } = await import("../services/buildDeploymentStatusTickDeps.js");

const KEY = fake.apiKey;
const M3060 = "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq";
const DEFINITION = { version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [] };
const RICH = { assignedCredits: 100, reservedCredits: 0, settledCredits: 0 };

type Client = InstanceType<typeof NosanaClient>;

/** A client built by initialize() from the environment above. */
async function apiClient(envOverrides: Record<string, string> = {}): Promise<Client> {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(envOverrides)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  resetNosanaAccessConfigForTests();
  try {
    const client = new NosanaClient();
    await client.initialize();
    return client;
  } finally {
    // The parsed config stays cached for this client's calls; the next
    // apiClient() resets it again.
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Puts the fake back to a known state between tests. */
function resetFake() {
  fake.rotateApiKey(KEY);
  fake.setBalance(RICH);
  fake.setMarkets(FAKE_MARKETS);
  fake.setOwner("11111111111111111111111111111111");
  fake.setInsufficientFunds(false);
  // Every create carries its name as the idempotency key, and Nosana keeps
  // keys unique: a name reused by an earlier test would answer 409.
  fake.deployments.clear();
  fake.requests.length = 0;
}

function sent(method: string, path: RegExp) {
  return fake.requests.filter((r) => r.method === method && path.test(r.path));
}

function coded(code: string) {
  return (err: unknown) => (err as { code?: string } | null)?.code === code;
}

async function createOne(client: Client, name: string, replicas = 1) {
  return client.createDeployment(DEFINITION as never, "3060", replicas, { name });
}

// ============================================
// Access mode
// ============================================

test("an API key alone configures the client: api_key on mainnet, no wallet", async () => {
  resetFake();
  const client = await apiClient();
  assert.equal(client.getAccessMode(), "api_key");
  assert.equal(client.isConfigured(), true);
  assert.equal(client.getNetwork(), "mainnet", "not derived from SOLANA_NETWORK=devnet");
  assert.equal(client.hasAccessMode("api_key"), true);
  assert.equal(client.hasAccessMode("wallet"), false);
  client.assertCanDeploy("3060");
});

test("with no credential the 501 message names both ways to configure it", async () => {
  const bare = new NosanaClient();
  assert.equal(bare.getAccessMode(), "none");
  assert.throws(
    () => bare.assertCanDeploy("3060"),
    (err: unknown) =>
      err instanceof NosanaNotConfiguredError &&
      err.code === "nosana_not_configured" &&
      /NOSANA_API_KEY/.test(err.message) &&
      /NOSANA_WALLET_PRIVATE_KEY/.test(err.message),
  );
  await assert.rejects(bare.preflightDeploy("3060", 1), NosanaNotConfiguredError);
  await assert.rejects(bare.getCreditBalance(), NosanaNotConfiguredError);
});

// ============================================
// The whole life of a deployment
// ============================================

test("create -> start -> running -> scale -> stop -> released, with no vault call and no Solana RPC call", async () => {
  resetFake();
  const client = await apiClient();
  const name = wheelsaiDeploymentName("model", "Row_0001");
  assert.equal(name, "wheelsai-model-row-0001");

  await client.preflightDeploy("3060", 1);
  const created = await createOne(client, name);

  assert.equal(created.accessMode, "api_key");
  assert.equal(created.vaultAddress, undefined);
  assert.equal(created.market, M3060);
  assert.equal(created.status, "active");
  assert.deepEqual(created.endpoints, []);

  const createCalls = sent("POST", /^\/api\/deployments\/create$/);
  assert.equal(createCalls.length, 1);
  const body = createCalls[0]!.body as Record<string, unknown>;
  assert.equal(body.name, name);
  assert.equal(body.market, M3060);
  assert.equal(body.replicas, 1);
  assert.equal(body.timeout, 120, "7,200 s, sent in minutes by default");
  assert.equal(body.strategy, "SIMPLE-EXTEND");
  assert.equal(body.confidential, true);
  assert.deepEqual(body.job_definition, DEFINITION);
  assert.equal(body.idempotency_key, name, "the per-run name is the idempotency key");
  assert.equal(body.autostart, undefined, "create and start stay two calls");
  assert.equal(sent("POST", /\/start$/).length, 1);

  // Nosana reports RUNNING as soon as start is called. This definition
  // exposes no port, so there is no endpoint, and none is invented.
  let status = await client.getDeploymentStatus(created.id, "api_key");
  assert.equal(status.status, "running");
  assert.deepEqual(status.endpoints, []);

  fake.setEndpoints(created.id, [{ opId: "vllm-inference", port: 8000, url: "https://abc.node.k8s.prd.nos.ci/", online: false }]);
  status = await client.getDeploymentStatus(created.id, "api_key");
  assert.equal(status.status, "running");
  assert.deepEqual(status.endpoints, [{ url: "https://abc.node.k8s.prd.nos.ci", port: 8000, opId: "vllm-inference", online: false }]);
  fake.setEndpointsOnline(created.id, true);
  status = await client.getDeploymentStatus(created.id, "api_key");
  assert.deepEqual(status.endpoints, [{ url: "https://abc.node.k8s.prd.nos.ci", port: 8000, opId: "vllm-inference", online: true }]);

  // Scale up: balance checked, count changed, nothing funded.
  const scaled = await client.scaleDeployment(created.id, 2, "3060", "api_key");
  assert.deepEqual(scaled, { deploymentId: created.id, previousReplicas: 1, replicas: 2, funded: null });
  assert.equal(fake.deployments.get(created.id)!.replicas, 2);
  assert.deepEqual(sent("PATCH", /update-replica-count$/)[0]!.body, { replicas: 2 });

  // Runway: a measurement against the shared balance, never a top-up.
  const runway = await client.ensureDeploymentRunway(created.id, "3060", 2, "api_key");
  assert.equal(runway.toppedUp, false);
  assert.equal(runway.funded, null);
  assert.equal(runway.reason, "credits");
  assert.equal(runway.runwaySeconds, Math.floor(100_000_000 / 28));

  // Stop: accepted, Nosana still winding down, so not released yet.
  const stopped = await client.stopDeployment(created.id, "api_key");
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.alreadyStopped, false);
  assert.equal(stopped.reclaimed, false);
  assert.equal(stopped.remainingNosBaseUnits, null);
  assert.match(stopped.reclaimError ?? "", /still stopping/);

  // The sweep's retry, once Nosana reports it stopped: released.
  fake.settle(created.id);
  const released = await client.reclaimDeploymentVault(created.id, "api_key");
  assert.deepEqual(released, {
    deploymentId: created.id,
    state: "stopped",
    reclaimed: true,
    remainingNosBaseUnits: 0n,
  });

  assert.equal(fake.vaultCalls(), 0, "no vault route was called");
  assert.equal(rpc.count(), 0, "no Solana RPC request was made");
  for (const request of fake.requests) {
    if (request.path.startsWith("/api/markets")) {
      assert.equal(request.authorization, undefined, "the public market list is read with no credential");
    } else {
      assert.equal(request.authorization, `Bearer ${KEY}`, `${request.method} ${request.path}`);
    }
    assert.ok(request.status < 400, `${request.method} ${request.path} answered ${request.status}`);
  }
});

test("a stop whose deployment settles at once is released in the same call", async () => {
  resetFake();
  const client = await apiClient();
  const created = await createOne(client, "wheelsai-settles");
  fake.setStatus(created.id, "STOPPED");
  const result = await client.stopDeployment(created.id);
  assert.equal(result.alreadyStopped, true);
  assert.equal(result.reclaimed, true);
  assert.equal(result.remainingNosBaseUnits, 0n);
  assert.equal(sent("POST", /\/stop$/).length, 0, "an already stopped deployment is not stopped again");
});

// ============================================
// Credit gate
// ============================================

test("the credit gate refuses below estimate + floor: preflight, and again inside create - nothing is created", async () => {
  resetFake();
  const client = await apiClient();
  // 3060: 14 micro-USD/s x 7200 s = $0.1008, plus the $5 floor = $5.1008.
  fake.setBalance({ assignedCredits: 5.1007, reservedCredits: 0, settledCredits: 0 });

  await assert.rejects(client.preflightDeploy("3060", 1), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.equal(err.code, "nosana_credits_low");
    assert.doesNotMatch(err.message, /\d/, "no amount in the message");
    return true;
  });
  await assert.rejects(createOne(client, "wheelsai-refused"), coded("nosana_credits_low"));
  assert.equal(sent("POST", /\/create$/).length, 0);
  assert.equal([...fake.deployments.values()].some((d) => d.name === "wheelsai-refused"), false);

  // Reserved and settled credits count against it.
  fake.setBalance({ assignedCredits: 50, reservedCredits: 30, settledCredits: 15 });
  await assert.rejects(client.preflightDeploy("3060", 1), coded("nosana_credits_low"));

  // Exactly enough passes; two replicas need twice the estimate.
  fake.setBalance({ assignedCredits: 5.1008, reservedCredits: 0, settledCredits: 0 });
  await client.preflightDeploy("3060", 1);
  await assert.rejects(client.preflightDeploy("3060", 2), coded("nosana_credits_low"));
  // A batch job is estimated over its own timeout (default 6h = $0.3024).
  await assert.rejects(client.preflightDeploy("3060", 1, "batch"), coded("nosana_credits_low"));
  await client.preflightDeploy("3060", 1, "batch", { timeoutSeconds: 3600 });
});

test("the credit gate fails closed on an unreadable balance", async () => {
  resetFake();
  const client = await apiClient();
  await client.getCreditBalance(); // a good read happened earlier

  fake.failNext({ path: /^\/api\/credits\/balance$/ }, { status: 500, body: { error: "boom" } }, 2);
  await assert.rejects(client.preflightDeploy("3060", 1), coded("nosana_credits_unavailable"));
  await assert.rejects(createOne(client, "wheelsai-unreadable"), coded("nosana_credits_unavailable"));
  assert.equal(sent("POST", /\/create$/).length, 0);

  fake.failNext({ path: /^\/api\/credits\/balance$/ }, { status: 200, body: { assignedCredits: "lots" } });
  await assert.rejects(client.preflightDeploy("3060", 1), coded("nosana_credits_unavailable"));
});

test("getCreditBalance reports micro-USD and names its failures", async () => {
  resetFake();
  const client = await apiClient();
  fake.setBalance({ assignedCredits: 25, reservedCredits: 1.5, settledCredits: 3.25 });
  const balance = await client.getCreditBalance({ fresh: true });
  assert.equal(balance.assignedMicroUsd, 25_000_000n);
  assert.equal(balance.availableMicroUsd, 20_250_000n);

  fake.failNext({ path: /credits/ }, { status: 503, body: {} });
  await assert.rejects(client.getCreditBalance({ fresh: true }), (err: unknown) =>
    err instanceof NosanaLifecycleError && err.code === "nosana_credits_unavailable",
  );
});

// ============================================
// Market cost and the below-cost guard
// ============================================

test("getMarketCosts prices the tiers the public list knows and leaves the others null", async () => {
  resetFake();
  const client = await apiClient();
  const costs = await client.getMarketCosts();
  assert.equal(costs["3060"]?.costMicroUsdPerSecond, 14n);
  assert.equal(costs["3060"]?.usdPerHour, 0.0436);
  assert.equal(costs["4090"]?.costMicroUsdPerSecond, 112n);
  assert.equal(costs["h100"], null);
});

test("a tier priced below its Nosana cost is refused in the request path", async () => {
  resetFake();
  const client = await apiClient();
  // Retail for the 3060 is $0.36/h; make Nosana charge $0.50/h for it.
  fake.setMarkets([{ address: M3060, usd_reward_per_hour: 0.5, network_fee_percentage: 10 }]);
  await assert.rejects(client.preflightDeploy("3060", 1), coded("gpu_price_below_cost"));
  await assert.rejects(createOne(client, "wheelsai-below-cost"), coded("gpu_price_below_cost"));
  assert.equal(sent("POST", /\/create$/).length, 0);
});

test("an unknown market cost admits nothing: the list unreadable or the market unpriced is refused by name, never estimated from retail", async () => {
  resetFake();
  // A client that has never seen a cost for anything.
  const client = await apiClient();

  // The list cannot be read. Retail would have passed both the below-cost
  // guard and the credit gate (the balance is rich) - on a guess.
  fake.failNext({ path: /^\/api\/markets/ }, { status: 502, body: {} }, 2);
  await assert.rejects(client.preflightDeploy("3060", 1), coded("gpu_cost_unavailable"));
  await assert.rejects(createOne(client, "wheelsai-cost-unknown"), coded("gpu_cost_unavailable"));

  // The list reads, but carries no price for this market.
  fake.setMarkets([{ address: M3060, usd_reward_per_hour: null, network_fee_percentage: 10 }]);
  await assert.rejects(client.preflightDeploy("3060", 1), coded("gpu_cost_unavailable"));
  await assert.rejects(createOne(client, "wheelsai-cost-unpriced"), coded("gpu_cost_unavailable"));
  // A tier the list never mentions at all.
  await assert.rejects(client.preflightDeploy("4070", 1), coded("gpu_cost_unavailable"));

  assert.equal(sent("POST", /\/create$/).length, 0, "nothing was created on Nosana");
  assert.equal(sent("GET", /credits\/balance/).length, 0, "refused before the balance was even read");
});

test("the last cost seen for a market stands in through an outage, and still refuses a tier that was below cost", async () => {
  resetFake();
  const client = await apiClient();
  await client.preflightDeploy("3060", 1); // seen: $0.0436/h

  // Outage, then a list that lost the row's price: the last value seen admits.
  fake.failNext({ path: /^\/api\/markets/ }, { status: 502, body: {} });
  await client.preflightDeploy("3060", 1);
  fake.setMarkets([{ address: M3060, usd_reward_per_hour: "n/a" }]);
  await client.preflightDeploy("3060", 1);
  // The estimate is the seen cost, not retail: 13.33 micro-USD/s x 7200 s is
  // about $0.10, so $5.20 covers it with the $5 floor where retail ($0.72) would not.
  fake.setBalance({ assignedCredits: 5.2, reservedCredits: 0, settledCredits: 0 });
  await client.preflightDeploy("3060", 1);

  // A market last seen ABOVE retail stays refused while the list is down.
  resetFake();
  fake.setMarkets([{ address: M3060, usd_reward_per_hour: 0.5, network_fee_percentage: 10 }]);
  await assert.rejects(client.preflightDeploy("3060", 1), coded("gpu_price_below_cost"));
  fake.failNext({ path: /^\/api\/markets/ }, { status: 502, body: {} });
  await assert.rejects(client.preflightDeploy("3060", 1), coded("gpu_price_below_cost"));
});

test("a scale-up is refused on an unknown cost, while the runway figure (which admits nothing) still answers", async () => {
  resetFake();
  const fresh = await apiClient();
  const seeded = await apiClient();
  const created = await createOne(seeded, "wheelsai-scale-cost-unknown");
  fake.settle(created.id);
  fake.requests.length = 0;

  fake.setMarkets([]);
  // `fresh` never saw a cost for the market: nothing to stand in.
  await assert.rejects(fresh.scaleDeployment(created.id, 2, "3060", "api_key"), coded("gpu_cost_unavailable"));
  assert.equal(sent("PATCH", /update-replica-count$/).length, 0);
  assert.equal(fake.deployments.get(created.id)!.replicas, 1);

  const runway = await fresh.ensureDeploymentRunway(created.id, "3060", 1, "api_key");
  assert.equal(runway.reason, "credits");
  assert.equal(runway.toppedUp, false);
  assert.ok((runway.runwaySeconds ?? 0) > 0);
});

test("the public minimum and the operator's figures still estimate from retail when a cost is unknown", async () => {
  resetFake();
  const client = await apiClient();
  fake.setMarkets([]);
  // Floor $5 + one 3060 replica at retail (100 micro-USD/s) for 7200 s.
  assert.equal(await client.minimumDeployCreditsMicroUsd(), 5_720_000n);
});

// ============================================
// Authentication
// ============================================

test("an API key Nosana rejects is nosana_auth_failed on every path", async () => {
  resetFake();
  const client = await apiClient();
  const created = await createOne(client, "wheelsai-auth");
  fake.settle(created.id);

  fake.rotateApiKey("nos_a_different_key_entirely_0002");
  fake.requests.length = 0;

  await assert.rejects(client.preflightDeploy("3060", 1), coded("nosana_auth_failed"));
  await assert.rejects(client.getCreditBalance({ fresh: true }), coded("nosana_auth_failed"));
  await assert.rejects(createOne(client, "wheelsai-auth-2"), coded("nosana_auth_failed"));
  await assert.rejects(client.getDeploymentStatus(created.id), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.equal(err.code, "nosana_auth_failed");
    assert.equal(err.stage, "read");
    assert.equal(err.deploymentId, created.id);
    return true;
  });
  await assert.rejects(client.stopDeployment(created.id), coded("nosana_auth_failed"));
  await assert.rejects(client.reclaimDeploymentVault(created.id), coded("nosana_auth_failed"));
  await assert.rejects(client.scaleDeployment(created.id, 2, "3060"), coded("nosana_auth_failed"));
  await assert.rejects(client.ensureDeploymentRunway(created.id, "3060", 1), coded("nosana_auth_failed"));
  await assert.rejects(client.listDeployments(), coded("nosana_auth_failed"));

  assert.equal(fake.deployments.get(created.id)!.status, "RUNNING", "nothing was changed with a rejected key");
  assert.ok(fake.requests.every((r) => r.status === 401 || r.path.startsWith("/api/markets")));
});

test("a failure that is not an authentication failure keeps its own code", async () => {
  resetFake();
  const client = await apiClient();
  await assert.rejects(client.getDeploymentStatus("no-such-deployment"), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.equal(err.code, "nosana_read_failed");
    return true;
  });
  // The key itself is fine: the balance endpoint said so.
  assert.equal(sent("GET", /credits\/balance/).at(-1)?.status, 200);
});

// ============================================
// Release for every Nosana state
// ============================================

test("release through the real SDK, for every Nosana state", async () => {
  resetFake();
  const client = await apiClient();
  const cases: Array<{ status: string; state: string; stopSent: boolean; reclaimed: boolean }> = [
    { status: "DRAFT", state: "draft", stopSent: false, reclaimed: true },
    { status: "STOPPED", state: "stopped", stopSent: false, reclaimed: true },
    { status: "ARCHIVED", state: "archived", stopSent: false, reclaimed: true },
    { status: "STOPPING", state: "stopping", stopSent: false, reclaimed: false },
    // Still up on Nosana: stopped here, and not released until it has wound down.
    { status: "RUNNING", state: "running", stopSent: true, reclaimed: false },
    // Halted, and the fake accepts the stop: stopping, so not yet.
    { status: "INSUFFICIENT_FUNDS", state: "insufficient_funds", stopSent: true, reclaimed: false },
    { status: "ERROR", state: "error", stopSent: true, reclaimed: false },
  ];
  for (const c of cases) {
    const created = await createOne(client, `wheelsai-state-${c.status.toLowerCase()}`);
    fake.setStatus(created.id, c.status as never);
    fake.requests.length = 0;

    const result = await client.reclaimDeploymentVault(created.id, "api_key");
    assert.equal(result.state, c.state, c.status);
    assert.equal(result.reclaimed, c.reclaimed, c.status);
    assert.equal(result.remainingNosBaseUnits, c.reclaimed ? 0n : null, c.status);
    assert.equal(sent("POST", /\/stop$/).length, c.stopSent ? 1 : 0, c.status);

    if (c.stopSent) {
      fake.settle(created.id);
      assert.equal((await client.reclaimDeploymentVault(created.id, "api_key")).reclaimed, true, `${c.status} once stopped`);
    }
  }

  // STARTING: Nosana refuses a stop (HTTP 500 INCORRECT_STATE) until the LIST
  // task has moved it to RUNNING. The refusal is waited out and the stop sent
  // again a few times; one that stays STARTING throughout is a failure the
  // sweep counts and retries - it never releases a deployment that may still run.
  const starting = await createOne(client, "wheelsai-state-starting");
  fake.setStatus(starting.id, "STARTING");
  fake.requests.length = 0;
  const waits: number[] = [];
  (client as any).sleep = async (ms: number) => void waits.push(ms);
  await assert.rejects(client.reclaimDeploymentVault(starting.id, "api_key"), coded("nosana_stop_failed"));
  assert.equal(sent("POST", /\/stop$/).length, 4, "the first stop and three retries");
  assert.ok(sent("POST", /\/stop$/).every((r) => r.status === 500));
  assert.deepEqual(waits, [2_500, 2_500, 2_500]);
  fake.settle(starting.id); // RUNNING
  assert.equal((await client.reclaimDeploymentVault(starting.id, "api_key")).reclaimed, false, "stop accepted, winding down");
  fake.settle(starting.id); // STOPPED
  assert.equal((await client.reclaimDeploymentVault(starting.id, "api_key")).reclaimed, true);
  assert.equal(fake.vaultCalls(), 0);
});

test("a halted deployment that refuses the stop leaves service but is not released until a stop is accepted", async () => {
  resetFake();
  const client = await apiClient();
  for (const status of ["INSUFFICIENT_FUNDS", "ERROR"] as const) {
    const created = await createOne(client, `wheelsai-halted-${status.toLowerCase()}`);
    fake.setStatus(created.id, status);

    // The sweep: refused, so not released - Nosana revives INSUFFICIENT_FUNDS after a top-up.
    fake.failNext({ method: "POST", path: /\/stop$/ }, { status: 500, body: { error: "manager down" } });
    const reclaim = await client.reclaimDeploymentVault(created.id, "api_key");
    assert.equal(reclaim.reclaimed, false, status);
    assert.match(reclaim.reason ?? "", /no stop was accepted/);

    // The user's stop: refused too. Nothing serves, so the stop goes through
    // for the row, and the result says the release is still pending.
    fake.failNext({ method: "POST", path: /\/stop$/ }, { status: 500, body: { error: "manager down" } });
    const stop = await client.stopDeployment(created.id, "api_key");
    assert.equal(stop.stopped, true);
    assert.equal(stop.stopRefused, true);
    assert.equal(stop.reclaimed, false, status);
    assert.equal(fake.deployments.get(created.id)!.status, status);

    // The next sweep: the stop is accepted (Nosana takes one from a halted
    // state), it winds down, and only then is it released.
    assert.equal((await client.reclaimDeploymentVault(created.id, "api_key")).reclaimed, false);
    assert.equal(fake.deployments.get(created.id)!.status, "STOPPING");
    fake.settle(created.id);
    assert.equal((await client.reclaimDeploymentVault(created.id, "api_key")).reclaimed, true, status);
  }
});

test("a stop refused while Nosana reads STARTING is retried after a wait, and accepted once it is RUNNING", async () => {
  resetFake();
  const client = await apiClient();
  const created = await createOne(client, "wheelsai-stop-starting");
  fake.setStatus(created.id, "STARTING");
  const waits: number[] = [];
  // The LIST task is scheduled during the first wait: STARTING -> RUNNING.
  (client as any).sleep = async (ms: number) => {
    waits.push(ms);
    fake.settle(created.id);
  };
  fake.requests.length = 0;

  const result = await client.stopDeployment(created.id, "api_key");

  assert.equal(result.stopped, true);
  assert.equal(result.alreadyStopped, false);
  assert.deepEqual(waits, [2_500]);
  assert.deepEqual(sent("POST", /\/stop$/).map((r) => r.status), [500, 200]);
  assert.equal(fake.deployments.get(created.id)!.status, "STOPPING");
});

test("credits that run out at the start: the deployment reads insufficient_funds", async () => {
  resetFake();
  const client = await apiClient();
  fake.setInsufficientFunds(true);
  const created = await createOne(client, "wheelsai-no-funds");
  assert.equal((await client.getDeploymentStatus(created.id)).status, "insufficient_funds");
});

test("a running deployment whose stop Nosana refuses is an error, never a quiet 'not released'", async () => {
  resetFake();
  const client = await apiClient();
  const created = await createOne(client, "wheelsai-stuck");
  fake.settle(created.id);
  fake.failNext({ method: "POST", path: /\/stop$/ }, { status: 500, body: { error: "manager down" } });
  await assert.rejects(client.stopDeployment(created.id), coded("nosana_stop_failed"));
});

// ============================================
// The create-stage throw
// ============================================

test("an owner that is not a public key: create throws AFTER Nosana created it; the idempotency key finds it, and its id is carried", async () => {
  resetFake();
  const client = await apiClient();
  fake.setOwner("user_01HZX-not-a-base58-key!");
  const name = wheelsaiDeploymentName("model", "owner-case");
  const before = fake.deployments.size;

  let carriedId: string | undefined;
  await assert.rejects(createOne(client, name), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.equal(err.stage, "create");
    assert.equal(err.code, "nosana_create_failed");
    assert.equal(err.deploymentName, name);
    // The key found it; the SDK cannot read it (the same owner parse), so it
    // is neither started nor guessed at - its id goes back for the sweep.
    assert.ok(err.deploymentId);
    assert.equal(err.mayExistOnNosana, false, "the id is known: no lookup is left to do");
    assert.match(err.message, /holds its idempotency key but could not be read/);
    carriedId = err.deploymentId;
    return true;
  });

  assert.equal(fake.deployments.size, before + 1, "the deployment exists on the server");
  assert.equal(sent("POST", /\/start$/).length, 0, "it was never started");
  assert.equal(sent("GET", /\/deployments$/).filter((r) => r.query.idempotency_key === name).length, 1);

  // The list is read without the SDK's owner parse, so it still works.
  const found = await client.findDeploymentByName(name);
  assert.ok(found);
  assert.equal(found.id, carriedId);
  assert.equal(found.status, "draft");
  assert.equal(found.accessMode, "api_key");
  assert.equal(await client.findDeploymentByName("wheelsai-model-nobody"), null);

  // Through the SDK that same deployment cannot be read: named, not hidden.
  await assert.rejects(client.getDeploymentStatus(found.id), coded("nosana_read_failed"));
});

// ============================================
// The idempotent create: a lost answer, a 409, a deadline
// ============================================

test("a create whose answer is lost after Nosana made it: found by its idempotency key, started, one deployment", async () => {
  resetFake();
  const client = await apiClient();
  const name = wheelsaiDeploymentName("model", "lost-answer");
  // Carried out, then answered 502: the response never reached us.
  fake.failNext({ method: "POST", path: /\/deployments\/create$/ }, { status: 502, body: { error: "Bad Gateway" } }, 1, {
    afterAction: true,
  });

  const created = await createOne(client, name);

  const all = [...fake.deployments.values()].filter((d) => d.idempotency_key === name);
  assert.equal(all.length, 1, "exactly one deployment holds the key");
  assert.equal(created.id, all[0]!.id);
  assert.equal(all[0]!.status, "RUNNING", "the DRAFT it made was taken on and started");
  assert.equal(sent("POST", /\/deployments\/create$/).length, 1, "never created twice");
  assert.equal(sent("POST", /\/start$/).length, 1);
  const lookups = sent("GET", /\/deployments$/).filter((r) => r.query.idempotency_key === name);
  assert.equal(lookups.length, 1);
});

test("a create answered 409 (an earlier attempt of this run made it): the DRAFT holding the key is started", async () => {
  resetFake();
  const client = await apiClient();
  const name = wheelsaiDeploymentName("model", "conflict");
  const earlier = fake.seedDeployment({ name, idempotency_key: name, status: "DRAFT" });

  const created = await createOne(client, name);

  assert.equal(created.id, earlier.id);
  assert.equal(sent("POST", /\/deployments\/create$/)[0]!.status, 409);
  assert.equal(fake.deployments.get(earlier.id)!.status, "RUNNING");
  assert.equal([...fake.deployments.values()].filter((d) => d.idempotency_key === name).length, 1);
});

test("a create that threw finds a deployment already past DRAFT under its key: stopped, and the error carries its id", async () => {
  resetFake();
  const client = await apiClient();
  const name = wheelsaiDeploymentName("model", "conflict-running");
  const earlier = fake.seedDeployment({ name, idempotency_key: name, status: "RUNNING" });

  await assert.rejects(createOne(client, name), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.equal(err.stage, "create");
    assert.equal(err.deploymentId, earlier.id);
    assert.equal(err.mayExistOnNosana, false);
    assert.equal(err.cleanup?.stopped, true);
    assert.equal(err.cleanup?.reclaimed, false, "still stopping");
    assert.match(err.message, /already running/);
    return true;
  });
  assert.equal(sent("POST", /\/start$/).length, 0, "never started by this create");
  assert.equal(fake.deployments.get(earlier.id)!.status, "STOPPING");
});

test("a create that failed with nothing under its key: may exist on Nosana, no id, nothing started", async () => {
  resetFake();
  const client = await apiClient();
  const name = wheelsaiDeploymentName("model", "refused");
  fake.failNext({ method: "POST", path: /\/deployments\/create$/ }, { status: 500, body: { error: "manager down" } });

  await assert.rejects(createOne(client, name), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.equal(err.code, "nosana_create_failed");
    assert.equal(err.mayExistOnNosana, true);
    assert.equal(err.deploymentId, undefined);
    assert.match(err.message, /no deployment holds its idempotency key/);
    return true;
  });
  assert.equal(fake.deployments.size, 0);
  assert.equal(sent("POST", /\/start$/).length, 0);

  // The look-up itself failing is said too, and still carries no id.
  fake.failNext({ method: "POST", path: /\/deployments\/create$/ }, { status: 500, body: { error: "manager down" } });
  fake.failNext({ method: "GET", path: /\/deployments$/ }, { status: 500, body: { error: "down" } });
  await assert.rejects(createOne(client, name), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.equal(err.mayExistOnNosana, true);
    assert.match(err.message, /looking it up by its idempotency key failed too/);
    return true;
  });
});

test("a refused create's whole answer is reported, redacted, though the SDK's error keeps only one field", async () => {
  resetFake();
  const client = await apiClient();
  const refusals: unknown[] = [];
  (client as any).reportCreateRefusal = (refusal: unknown) => void refusals.push(refusal);
  const definition = {
    version: "0.1",
    type: "container",
    meta: { trigger: "wheelsai" },
    ops: [
      {
        type: "container/run",
        id: "train",
        args: { image: "docker.io/x/y:1", env: { HF_TOKEN: "hf_secretsecret" }, required_vram: 12 },
      },
    ],
  };

  await assert.rejects(
    client.createDeployment(definition as never, "3060", 1, { name: "wheelsai-refused-create" }),
    (err: unknown) => {
      assert.ok(err instanceof NosanaLifecycleError);
      // What the SDK keeps: "Bad Request". The reason is not in it.
      assert.doesNotMatch(err.message, /required_vram/);
      return true;
    },
  );
  assert.equal(refusals.length, 1);
  const refusal = refusals[0] as { status: number; body: Record<string, unknown> };
  assert.equal(refusal.status, 400);
  assert.equal(refusal.body.code, "FST_ERR_VALIDATION");
  assert.match(String(refusal.body.message), /ops\[0\]\.args\.required_vram/, "the reason reaches the log");
  assert.doesNotMatch(JSON.stringify(refusals), /hf_secretsecret|nos_fake_key/);

  // An accepted create is not reported.
  await createOne(client, "wheelsai-accepted-create");
  assert.equal(refusals.length, 1);
});

test("every SDK call has a deadline: a create that outlives it is looked up by its key and taken on; a read that outlives it fails by name", async () => {
  resetFake();
  const client = await apiClient({ NOSANA_SDK_TIMEOUT_MS: "200" });
  const name = wheelsaiDeploymentName("model", "slow-create");
  // Nosana makes the deployment at once and answers two seconds later.
  fake.delayNext({ method: "POST", path: /\/deployments\/create$/ }, 2_000);

  const startedAt = Date.now();
  const created = await createOne(client, name);
  assert.ok(Date.now() - startedAt < 1_500, "the create did not wait for the late answer");
  const holding = [...fake.deployments.values()].filter((d) => d.idempotency_key === name);
  assert.equal(holding.length, 1);
  assert.equal(created.id, holding[0]!.id);
  assert.equal(holding[0]!.status, "RUNNING");

  // A read that hangs: the deadline names it, and nothing is fabricated.
  fake.delayNext({ method: "GET", path: new RegExp(`/deployments/${created.id}$`) }, 2_000);
  await assert.rejects(client.getDeploymentStatus(created.id, "api_key", DEPLOYMENT_ONLY), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.equal(err.code, "nosana_read_failed");
    assert.equal((err.cause as { code?: string } | undefined)?.code, "nosana_timeout");
    return true;
  });

  // A stop that hangs and was never carried out is a failed stop, never a
  // quiet success: the read after it still says RUNNING.
  fake.failNext({ method: "POST", path: /\/stop$/ }, { status: 500, body: { error: "stuck" } });
  fake.delayNext({ method: "POST", path: /\/stop$/ }, 2_000);
  await assert.rejects(client.stopDeployment(created.id, "api_key"), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.equal(err.code, "nosana_stop_failed");
    assert.equal((err.cause as { code?: string } | undefined)?.code, "nosana_timeout");
    return true;
  });
  assert.equal(fake.deployments.get(created.id)!.status, "RUNNING");

  // One Nosana carried out but answered late: the read after it says
  // STOPPING, and that is what counts.
  fake.delayNext({ method: "POST", path: /\/stop$/ }, 2_000);
  const stopped = await client.stopDeployment(created.id, "api_key");
  assert.equal(stopped.stopped, true);
  assert.equal(fake.deployments.get(created.id)!.status, "STOPPING");
});

// ============================================
// Paginated reads: the list, the lookups, jobs and events
// ============================================

/** n deployments, a minute apart, oldest first. */
function seedMany(n: number, name = (i: number) => `other-${i}`) {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(
      fake.seedDeployment({ name: name(i), created_at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString() }).id,
    );
  }
  return ids;
}

test("listDeployments reads every page of 100, following cursor_next, never the SDK's list()", async () => {
  resetFake();
  fake.deployments.clear();
  const ids = seedMany(230);
  const client = await apiClient();

  const rows = await client.listDeployments("api_key");
  assert.equal(rows.length, 230);
  assert.deepEqual(new Set(rows.map((r) => r.id)), new Set(ids));
  assert.equal(rows[0]!.id, ids[229], "newest first, as Nosana answers");
  const reads = sent("GET", /^\/api\/deployments$/);
  assert.equal(reads.length, 3);
  assert.deepEqual(reads.map((r) => r.query.limit), ["100", "100", "100"]);
  assert.equal(reads[0]!.query.cursor, undefined);
  assert.ok(reads[1]!.query.cursor && reads[2]!.query.cursor);
  assert.equal(reads.every((r) => r.authorization === `Bearer ${KEY}`), true);
});

test("listDeployments: a bare array is still read; a body that is not a list, or a cursor that repeats, throws", async () => {
  resetFake();
  fake.deployments.clear();
  const client = await apiClient();
  const row = { id: "bare1", name: "wheelsai-bare", status: "RUNNING", created_at: "2026-10-01T00:00:00.000Z" };
  fake.failNext({ method: "GET", path: /^\/api\/deployments$/ }, { status: 200, body: [row] });
  assert.deepEqual((await client.listDeployments()).map((r) => r.id), ["bare1"]);

  fake.failNext({ method: "GET", path: /^\/api\/deployments$/ }, { status: 200, body: { items: [] } });
  await assert.rejects(client.listDeployments(), coded("nosana_read_failed"));

  const looping = { deployments: [row], pagination: { cursor_next: "c1", cursor_prev: null, total_items: 99 } };
  fake.failNext({ method: "GET", path: /^\/api\/deployments$/ }, { status: 200, body: looping }, 2);
  await assert.rejects(client.listDeployments(), (err: unknown) => {
    assert.ok(err instanceof NosanaLifecycleError);
    assert.match(err.message, /repeated a page cursor/);
    return true;
  });

  fake.failNext({ method: "GET", path: /^\/api\/deployments$/ }, { status: 400, body: { code: "FST_ERR_VALIDATION" } });
  await assert.rejects(client.listDeployments(), coded("nosana_read_failed"));
});

test("findDeploymentByName asks Nosana's exact name filter, follows its pages and picks the newest", async () => {
  resetFake();
  fake.deployments.clear();
  const name = wheelsaiDeploymentName("model", "paged");
  // 150 rows with the name: the oldest first, so the newest is on page 1 and
  // the oldest on page 2.
  const ids = seedMany(150, () => name);
  seedMany(5, () => name.toUpperCase());
  const client = await apiClient();

  const found = await client.findDeploymentByName(name);
  assert.ok(found);
  assert.equal(found.id, ids[149]);
  assert.equal(found.name, name);
  const reads = sent("GET", /^\/api\/deployments$/);
  assert.equal(reads.length, 2, "both pages");
  assert.deepEqual(reads.map((r) => [r.query.name, r.query.limit]), [[name, "100"], [name, "100"]]);
  assert.equal(await client.findDeploymentByName("wheelsai-model-nobody"), null);

  // A server that ignored the filter: the name is still checked here.
  fake.failNext(
    { method: "GET", path: /^\/api\/deployments$/ },
    {
      status: 200,
      body: {
        deployments: [
          { id: "x1", name: "wheelsai-model-somebody-else", status: "RUNNING", created_at: "2026-10-09T00:00:00.000Z" },
          { id: "x2", name, status: "STOPPED", created_at: "2026-10-01T00:00:00.000Z" },
        ],
        pagination: { cursor_next: null, cursor_prev: null, total_items: 2 },
      },
    },
  );
  assert.equal((await client.findDeploymentByName(name))?.id, "x2");
});

test("findDeploymentByIdempotencyKey uses the server's filter, and two answers for one key throw", async () => {
  resetFake();
  fake.deployments.clear();
  seedMany(120);
  const target = fake.seedDeployment({ name: "wheelsai-model-k", idempotency_key: "wheelsai-model-abc-r2" });
  const client = await apiClient();

  const found = await client.findDeploymentByIdempotencyKey("wheelsai-model-abc-r2");
  assert.equal(found?.id, target.id);
  assert.equal(found?.idempotencyKey, "wheelsai-model-abc-r2");
  assert.equal(sent("GET", /^\/api\/deployments$/)[0]!.query.idempotency_key, "wheelsai-model-abc-r2");
  assert.equal(await client.findDeploymentByIdempotencyKey("wheelsai-model-none-r0"), null);

  // The filter was not applied: rows without a key cannot be told apart.
  fake.failNext(
    { method: "GET", path: /^\/api\/deployments$/ },
    {
      status: 200,
      body: {
        deployments: [
          { id: "y1", name: "a", status: "RUNNING", created_at: "2026-10-09T00:00:00.000Z" },
          { id: "y2", name: "b", status: "RUNNING", created_at: "2026-10-08T00:00:00.000Z" },
        ],
        pagination: { cursor_next: null, cursor_prev: null, total_items: 2 },
      },
    },
  );
  await assert.rejects(client.findDeploymentByIdempotencyKey("wheelsai-model-abc-r2"), coded("nosana_read_failed"));
});

test("getDeploymentStatus carries the newest jobs and events from their own routes; `include` narrows what is read", async () => {
  resetFake();
  const client = await apiClient();
  const created = await createOne(client, "wheelsai-snapshot-lists");
  const first = fake.addJob(created.id, { state: "COMPLETED", created_at: "2026-10-01T00:00:00.000Z" });
  const second = fake.addJob(created.id, { node: null, state: "QUEUED" });
  fake.addEvent(created.id, "JOB_EXTEND_SUCCESSFUL", "extended");
  fake.requests.length = 0;

  const snap = await client.getDeploymentStatus(created.id, "api_key");
  assert.deepEqual(
    snap.jobs.map((j) => [j.job, j.status, j.node]),
    [
      [second.job, "QUEUED", null],
      [first.job, "COMPLETED", "DytPhPyM3GFQLBVwsT9ykQJcWVAGPC8DsMtgqZo23Pio"],
    ],
  );
  assert.equal(snap.events[0]!.type, "JOB_EXTEND_SUCCESSFUL", "newest first");
  assert.equal(snap.events.length, 3);
  const jobs = sent("GET", new RegExp(`/${created.id}/jobs$`));
  const events = sent("GET", new RegExp(`/${created.id}/events$`));
  assert.deepEqual([jobs[0]!.query.limit, jobs[0]!.query.sort_order], ["10", "desc"]);
  assert.deepEqual([events[0]!.query.limit, events[0]!.query.sort_order], ["20", "desc"]);

  fake.requests.length = 0;
  const bare = await client.getDeploymentStatus(created.id, "api_key", DEPLOYMENT_ONLY);
  assert.deepEqual([bare.jobs, bare.events], [[], []]);
  assert.deepEqual(fake.requests.map((r) => r.path), [`/api/deployments/${created.id}`]);

  // "when_halted": the events explain a failure, so only then are they read.
  fake.requests.length = 0;
  await client.getDeploymentStatus(created.id, "api_key", { jobs: false, events: "when_halted" });
  assert.equal(sent("GET", /\/events$/).length, 0);
  fake.setStatus(created.id, "ERROR");
  fake.addEvent(created.id, "JOB_LIST_ERROR", "Error Failed to list job: Insufficient credits. Available: $0.091, Required: $0.524");
  const halted = await client.getDeploymentStatus(created.id, "api_key", { jobs: false, events: "when_halted" });
  assert.equal(halted.status, "error");
  assert.equal(halted.events[0]!.type, "JOB_LIST_ERROR");
  // What the status worker records as the failure reason: Nosana's own words.
  assert.equal(
    pickFailureDetail(halted.events),
    "JOB_LIST_ERROR: Error Failed to list job: Insufficient credits. Available: $0.091, Required: $0.524",
  );
  assert.equal(sent("GET", /\/jobs$/).length, 0);

  // A failed jobs read fails the whole read: nothing is fabricated.
  fake.failNext({ method: "GET", path: /\/jobs$/ }, { status: 500, body: { error: "down" } });
  await assert.rejects(client.getDeploymentStatus(created.id, "api_key"), coded("nosana_read_failed"));
});

test("listDeploymentEvents follows pages for more than 100; listDeploymentJobs reads every page with `all`", async () => {
  resetFake();
  const client = await apiClient();
  const created = await createOne(client, "wheelsai-many-events");
  for (let i = 0; i < 150; i += 1) fake.addEvent(created.id, "JOB_EXTEND_SUCCESSFUL", `extension ${i}`);
  for (let i = 0; i < 120; i += 1) fake.addJob(created.id, { state: "COMPLETED" });
  fake.requests.length = 0;

  const events = await client.listDeploymentEvents(created.id, "api_key", { count: 150 });
  assert.equal(events.length, 150);
  assert.equal(sent("GET", /\/events$/).length, 2);
  assert.equal((await client.listDeploymentEvents(created.id, "api_key", { count: 15 })).length, 15);
  assert.equal(sent("GET", /\/events$/).at(-1)!.query.limit, "20", "the smallest page that holds them");

  const jobs = await client.listDeploymentJobs(created.id, "api_key", { all: true });
  assert.equal(jobs.length, 120);
  assert.equal((await client.listDeploymentJobs(created.id, "api_key", { state: "RUNNING" })).length, 0);
});

test("getDeploymentJob: a stopped job's timeEnd 0 falls back to the result's endTime, in milliseconds", async () => {
  resetFake();
  const client = await apiClient();
  const created = await createOne(client, "wheelsai-job-end");
  fake.setJob(created.id, "JobStopped1", {
    state: 3,
    timeStart: 1_781_459_639,
    timeEnd: 0,
    listedAt: 1_781_459_640,
    jobResult: { status: "success", startTime: 1_781_459_641_319, endTime: 1_781_481_239_965, opStates: [] },
  });
  const job = await client.getDeploymentJob(created.id, "JobStopped1", "api_key");
  assert.equal(job.state, "stopped");
  assert.equal(job.timeStart?.toISOString(), new Date(1_781_459_639_000).toISOString());
  assert.equal(job.timeEnd?.toISOString(), new Date(1_781_481_239_965).toISOString());
  assert.deepEqual(job.raw, {
    timeStart: 1_781_459_639,
    timeEnd: 0,
    listedAt: 1_781_459_640,
    resultEndTime: 1_781_481_239_965,
  });
  // A real timeEnd wins over the result's.
  const ended = normalizeDeploymentJob("d", "j", { timeEnd: 1_781_481_000, jobResult: { endTime: 1_781_481_239_965 } });
  assert.equal(ended.timeEnd?.toISOString(), new Date(1_781_481_000_000).toISOString());
  assert.equal(normalizeDeploymentJob("d", "j", { timeEnd: 0, jobResult: null }).timeEnd, null);
});

test("listDeployments returns Nosana's own list with normalised states", async () => {
  resetFake();
  const client = await apiClient();
  const created = await createOne(client, "wheelsai-listed");
  fake.settle(created.id);
  const rows = await client.listDeployments("api_key");
  const row = rows.find((r) => r.id === created.id);
  assert.ok(row);
  assert.equal(row.status, "running");
  assert.equal(row.rawStatus, "RUNNING");
  assert.equal(row.replicas, 1);
  assert.equal(row.market, M3060);
  assert.ok(row.createdAt instanceof Date);

  fake.setStatus(created.id, "SOMETHING_NEW" as never);
  assert.equal((await client.listDeployments()).find((r) => r.id === created.id)?.status, "unknown");
});

// ============================================
// Timeout unit
// ============================================

test("timeout unit seconds: the create body and updateTimeout carry seconds", async () => {
  resetFake();
  const client = await apiClient({ NOSANA_TIMEOUT_UNIT: "seconds" });
  const created = await createOne(client, "wheelsai-unit-seconds");
  assert.equal(fake.deployments.get(created.id)!.timeout, 7200);

  const updated = await client.updateDeploymentTimeout(created.id, 3600);
  assert.deepEqual(updated, { deploymentId: created.id, timeoutSeconds: 3600, sentTimeout: 3600, unit: "seconds" });
  assert.equal(fake.deployments.get(created.id)!.timeout, 3600);
});

test("timeout unit minutes: converted at the SDK boundary only, rounding up", async () => {
  resetFake();
  const client = await apiClient({ NOSANA_TIMEOUT_UNIT: "minutes" });
  const created = await createOne(client, "wheelsai-unit-minutes");
  assert.equal(fake.deployments.get(created.id)!.timeout, 120, "7200 s is sent as 120 minutes");

  // A per-call timeout that is not a whole number of minutes rounds UP.
  const odd = await client.createDeployment(DEFINITION as never, "3060", 1, {
    name: "wheelsai-unit-minutes-odd",
    kind: "batch",
    timeoutSeconds: 3601,
  });
  const oddRow = fake.deployments.get(odd.id)!;
  assert.equal(oddRow.timeout, 61);
  assert.equal(oddRow.strategy, "SIMPLE");

  const updated = await client.updateDeploymentTimeout(created.id, 7201);
  assert.deepEqual(updated, { deploymentId: created.id, timeoutSeconds: 7201, sentTimeout: 121, unit: "minutes" });
  assert.equal(fake.deployments.get(created.id)!.timeout, 121);

  // 600 s is 10 minutes; the SDK refuses any update below 60 of its unit.
  fake.requests.length = 0;
  await assert.rejects(client.updateDeploymentTimeout(created.id, 600), coded("nosana_timeout_too_short"));
  assert.equal(fake.requests.length, 0, "refused before any request");

  // Our own arithmetic stayed in seconds: the estimate is still 2 hours of cost.
  fake.setBalance({ assignedCredits: 5.1008, reservedCredits: 0, settledCredits: 0 });
  await client.preflightDeploy("3060", 1);
});

test("a per-call timeoutSeconds sizes the credit estimate", async () => {
  resetFake();
  const client = await apiClient();
  // One replica for 10 hours: 14 x 36000 = $0.504, plus the floor = $5.504.
  fake.setBalance({ assignedCredits: 5.5, reservedCredits: 0, settledCredits: 0 });
  await assert.rejects(
    client.createDeployment(DEFINITION as never, "3060", 1, { name: "wheelsai-long", kind: "batch", timeoutSeconds: 36_000 }),
    coded("nosana_credits_low"),
  );
  fake.setBalance({ assignedCredits: 5.504, reservedCredits: 0, settledCredits: 0 });
  const created = await client.createDeployment(DEFINITION as never, "3060", 1, {
    name: "wheelsai-long",
    kind: "batch",
    timeoutSeconds: 36_000,
  });
  assert.equal(fake.deployments.get(created.id)!.timeout, 600, "36,000 s, sent in minutes");

  await assert.rejects(
    client.createDeployment(DEFINITION as never, "3060", 1, { timeoutSeconds: 30 }),
    RangeError,
  );
});

test("a per-call timeout under Nosana's 50-minute minimum for credit-paid jobs is raised to it, in the create and in the estimate", async () => {
  resetFake();
  const client = await apiClient();
  // 30 minutes of training plus set-up would be sent as 31 minutes, which
  // Nosana accepts and then never assigns. It is sent as 50.
  // The estimate is for what is sent: 14 x 3000 = $0.042, plus the floor.
  fake.setBalance({ assignedCredits: 5.041, reservedCredits: 0, settledCredits: 0 });
  await assert.rejects(
    client.preflightDeploy("3060", 1, "batch", { timeoutSeconds: 1_801 }),
    coded("nosana_credits_low"),
  );
  await assert.rejects(
    client.createDeployment(DEFINITION as never, "3060", 1, { name: "wheelsai-short", kind: "batch", timeoutSeconds: 1_801 }),
    coded("nosana_credits_low"),
  );
  assert.equal(sent("POST", /deployments\/create$/).length, 0, "refused before any create");

  fake.setBalance({ assignedCredits: 5.042, reservedCredits: 0, settledCredits: 0 });
  await client.preflightDeploy("3060", 1, "batch", { timeoutSeconds: 1_801 });
  const created = await client.createDeployment(DEFINITION as never, "3060", 1, {
    name: "wheelsai-short",
    kind: "batch",
    timeoutSeconds: 1_801,
  });
  const row = fake.deployments.get(created.id)!;
  assert.equal(row.timeout, 50, "3000 s, in minutes");
  assert.equal(row.events.some((e) => e.type === "JOB_LIST_ERROR"), false, "Nosana can place it");
  // A node takes it: the reservation is 50 minutes at the host price.
  fake.addJob(created.id);
  assert.equal(fake.balance().reservedCredits, 0.037, "0.0436 USD/h x 50 min, rounded up to $0.001");

  // At or above the minimum nothing changes.
  fake.setBalance(RICH);
  const exact = await client.createDeployment(DEFINITION as never, "3060", 1, {
    name: "wheelsai-exact",
    kind: "batch",
    timeoutSeconds: 3_000,
  });
  assert.equal(fake.deployments.get(exact.id)!.timeout, 50);
});

// ============================================
// Jobs
// ============================================

test("getDeploymentJob reads through the SDK and normalises state and times", async () => {
  resetFake();
  const client = await apiClient();
  const created = await createOne(client, "wheelsai-job");
  fake.setJob(created.id, "JobAddr1", {
    confidential: true,
    revision: 1,
    market: M3060,
    node: "NodePubkey1111111111111111111111111111111111",
    state: 1,
    jobStatus: null,
    jobDefinition: {},
    jobResult: null,
    timeStart: 1_780_000_000,
    timeEnd: 0,
    listedAt: 1_779_999_900,
  });
  const job = await client.getDeploymentJob(created.id, "JobAddr1", "api_key");
  assert.equal(job.state, "running");
  assert.equal(job.rawState, 1);
  assert.equal(job.node, "NodePubkey1111111111111111111111111111111111");
  assert.equal(job.timeStart?.toISOString(), new Date(1_780_000_000_000).toISOString());
  assert.equal(job.timeEnd, null, "zero means not ended");
  assert.deepEqual(job.raw, { timeStart: 1_780_000_000, timeEnd: 0, listedAt: 1_779_999_900, resultEndTime: undefined });

  await assert.rejects(client.getDeploymentJob(created.id, "NoSuchJob"), coded("nosana_read_failed"));
});

test("normalizeDeploymentJob accepts numeric, numeric-string and named states, and both time scales", () => {
  const state = (value: unknown) => normalizeDeploymentJob("d", "j", { state: value }).state;
  assert.equal(state(0), "queued");
  assert.equal(state("1"), "running");
  assert.equal(state(2), "completed");
  assert.equal(state("3"), "stopped");
  assert.equal(state("COMPLETED"), "completed");
  assert.equal(state("done"), "completed");
  assert.equal(state("Running"), "running");
  assert.equal(state(9), "unknown");
  assert.equal(state("weird"), "unknown");
  assert.equal(state(undefined), "unknown");

  const times = normalizeDeploymentJob("d", "j", {
    timeStart: 1_780_000_000_000,
    timeEnd: "1780000600",
    listedAt: -1,
    node: "11111111111111111111111111111111",
  });
  assert.equal(times.timeStart?.getTime(), 1_780_000_000_000, "milliseconds are taken as they are");
  assert.equal(times.timeEnd?.getTime(), 1_780_000_600_000);
  assert.equal(times.listedAt, null);
  assert.equal(times.node, null, "the zero key is not a host");
  assert.equal(normalizeDeploymentJob("d", "j", null).state, "unknown");
});

// ============================================
// One-shot jobs
// ============================================

test("submitJob is refused with API-key access, by name and before any request", async () => {
  resetFake();
  const client = await apiClient();
  await assert.rejects(
    client.submitJob(DEFINITION as never, "3060"),
    (err: unknown) => err instanceof NosanaOneShotUnavailableError && err.code === "nosana_one_shot_unavailable",
  );
  assert.equal(fake.requests.length, 0);
  assert.equal(rpc.count(), 0);
});

// ============================================
// Two credentials, and a mode with no credential
// ============================================

/** A stand-in for the wallet SDK client: records what reaches it. */
function fakeWalletSdk() {
  const ops: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const topups: Array<Record<string, unknown>> = [];
  let nos = 0;
  const deployment = {
    id: "dm_wallet",
    status: "RUNNING",
    replicas: 1,
    vault: {
      publicKey: { toBase58: () => "VaultKey111111111111111111111111111111111111" },
      topup: async (o: Record<string, number>) => {
        ops.push("topup");
        topups.push(o);
        nos += o.NOS ?? 0;
      },
      getBalance: async () => ({ SOL: 0, NOS: nos / 1e6 }),
      withdraw: async () => {
        ops.push("withdraw");
        nos = 0;
      },
    },
    start: async () => {
      ops.push("start");
    },
    stop: async () => {
      ops.push("stop");
      deployment.status = "STOPPING";
    },
    updateReplicaCount: async () => {},
  };
  const sdk = {
    deployments: {
      create: async (body: Record<string, unknown>) => {
        ops.push("create");
        bodies.push(body);
        deployment.status = "DRAFT";
        return deployment;
      },
      get: async (id: string) => {
        ops.push(`get:${id}`);
        return deployment;
      },
    },
    jobs: { getMarket: async () => ({ jobPrice: "24" }) },
  };
  return { sdk, ops, bodies, topups };
}

test("with both credentials each row is handled through the account that created it", async () => {
  resetFake();
  const client = await apiClient();
  const wallet = fakeWalletSdk();
  (client as any).sdk = wallet.sdk;
  (client as any).wallet = Keypair.generate();
  assert.equal(client.getAccessMode(), "api_key", "the configured primary mode stays");
  assert.equal(client.hasAccessMode("wallet"), true);

  // A new deployment goes to the primary account.
  const created = await createOne(client, "wheelsai-both");
  assert.equal(created.accessMode, "api_key");
  assert.deepEqual(wallet.ops, []);
  fake.settle(created.id);
  fake.requests.length = 0;

  // A row stamped wallet (or not stamped at all) is stopped through the wallet client.
  const walletStop = await client.stopDeployment("dm_wallet", "wallet");
  assert.deepEqual(wallet.ops, ["get:dm_wallet", "stop", "withdraw"]);
  assert.equal(walletStop.reclaimed, true);
  assert.equal(fake.requests.length, 0, "nothing was asked of the API-key account");

  // A row stamped api_key is stopped through the API-key client.
  wallet.ops.length = 0;
  await client.stopDeployment(created.id, "api_key");
  assert.equal(sent("POST", /\/stop$/).length, 1);
  assert.deepEqual(wallet.ops, []);

  // One-shot jobs stay refused: the primary account cannot run them.
  await assert.rejects(client.submitJob(DEFINITION as never, "3060"), NosanaOneShotUnavailableError);
});

test("wallet as the primary of two credentials: create funds a vault and reports wallet", async () => {
  resetFake();
  const client = await apiClient();
  const wallet = fakeWalletSdk();
  (client as any).sdk = wallet.sdk;
  (client as any).wallet = Keypair.generate();
  (client as any).primaryMode = "wallet";
  // The wallet client keeps its own network (SOLANA_NETWORK is devnet here,
  // where no market is configured); this wallet is a mainnet one.
  (client as any).network = "mainnet";

  // Wallet access adds no outbound call to the preflight.
  await client.preflightDeploy("3060", 1);
  assert.equal(fake.requests.length, 0);

  const created = await client.createDeployment(DEFINITION as never, "3060", 1, {
    kind: "batch",
    timeoutSeconds: 900,
  });
  assert.equal(created.accessMode, "wallet");
  assert.equal(created.vaultAddress, "VaultKey111111111111111111111111111111111111");
  assert.deepEqual(wallet.ops, ["create", "topup", "start"]);
  assert.equal(wallet.bodies[0]!.timeout, 15, "the per-call timeout is the job timeout: 900 s is 15 minutes");
  // 24 x 1.10 = 26.4 base units/s for 900 s: the per-call timeout sized the vault.
  assert.equal(wallet.topups[0]!.NOS, 23_760);

  // A timeout that is not a whole minute is sent rounded up, and the vault
  // is funded for what was sent, not for the shorter figure that was asked.
  await client.createDeployment(DEFINITION as never, "3060", 1, { kind: "batch", timeoutSeconds: 601 });
  assert.equal(wallet.bodies[1]!.timeout, 11);
  assert.equal(wallet.topups[1]!.NOS, Math.ceil(26.4 * 660), "funded for 11 minutes");
  assert.equal(sent("POST", /\/create$/).length, 0);
});

test("a row whose access mode has no credential here fails by name, on every call", async () => {
  resetFake();
  const client = await apiClient(); // API key only
  const unavailable = (err: unknown) =>
    err instanceof NosanaAccessModeUnavailableError &&
    err.code === "nosana_access_mode_unavailable" &&
    err.mode === "wallet";

  await assert.rejects(client.stopDeployment("dm_old", "wallet"), unavailable);
  await assert.rejects(client.reclaimDeploymentVault("dm_old", "wallet"), unavailable);
  await assert.rejects(client.scaleDeployment("dm_old", 2, "3060", "wallet"), unavailable);
  await assert.rejects(client.getDeploymentStatus("dm_old", "wallet"), unavailable);
  await assert.rejects(client.ensureDeploymentRunway("dm_old", "3060", 1, "wallet"), unavailable);
  await assert.rejects(client.listDeployments("wallet"), unavailable);
  await assert.rejects(client.getDeploymentJob("dm_old", "job", "wallet"), unavailable);
  assert.equal(fake.requests.length, 0);

  // A mock id was never on Nosana: its stamp needs no credential.
  const mock = await client.stopDeployment("mock_deploy_abc", "wallet");
  assert.equal(mock.reclaimed, true);
});

// ============================================
// One network per credential
// ============================================

test("making the API key primary leaves the wallet client on its own network: wallet rows are not looked up on the key's", async () => {
  resetFake();
  // SOLANA_NETWORK is devnet in this file; the API key defaults to mainnet.
  const client = await apiClient();
  const wallet = fakeWalletSdk();
  (client as any).sdk = wallet.sdk;
  (client as any).wallet = Keypair.generate();

  assert.equal(client.getNetwork(), "mainnet", "new deployments: the primary credential's network");
  assert.equal((client as any).network, "devnet", "the wallet client's network did not move");
  assert.equal((client as any).apiNetwork, "mainnet");

  // A tier resolves on the network of the account the row belongs to.
  assert.equal(client.resolveMarketAddress("3060"), M3060);
  assert.equal(client.resolveMarketAddress("3060", "api_key"), M3060);
  const onDevnet = (err: unknown) =>
    err instanceof MarketNotConfiguredError && /devnet/.test((err as Error).message);
  assert.throws(() => client.resolveMarketAddress("3060", "wallet"), onDevnet);
  // Scale and runway of a wallet row use the wallet's network, not mainnet's markets.
  await assert.rejects(client.scaleDeployment("dm_wallet", 2, "3060", "wallet"), onDevnet);
  await assert.rejects(client.ensureDeploymentRunway("dm_wallet", "3060", 1, "wallet"), onDevnet);
  // An API-key row on the same client still resolves on the key's network.
  const created = await createOne(client, "wheelsai-two-networks");
  fake.settle(created.id);
  const scaled = await client.scaleDeployment(created.id, 2, "3060", "api_key");
  assert.equal(scaled.replicas, 2);

  // The reverse switch: wallet primary, the key stays on mainnet.
  (client as any).primaryMode = "wallet";
  assert.equal(client.getNetwork(), "devnet");
  assert.equal(client.resolveMarketAddress("3060", "api_key"), M3060);
  assert.throws(() => client.resolveMarketAddress("3060"), onDevnet);
});

test("an explicit NOSANA_NETWORK puts both credentials on that network", async () => {
  resetFake();
  process.env.NOSANA_NETWORK = "mainnet";
  try {
    const client = await apiClient();
    assert.equal((client as any).network, "mainnet");
    assert.equal((client as any).apiNetwork, "mainnet");
  } finally {
    delete process.env.NOSANA_NETWORK;
    resetNosanaAccessConfigForTests();
  }
});
