import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { Keypair } from "@solana/web3.js";
import { startFakeNosanaApi, startRequestCounter, FAKE_MARKETS } from "./fakeNosanaApi.js";

// The callers of NosanaClient with API-key access: the model deployment routes
// (create, stop, replicas, restart, logs) and the background submit, driven
// through the REAL NosanaClient and the REAL @nosana/sdk against the fake
// Nosana REST API on loopback, over an in-memory database with real
// transaction semantics (serialised, rolled back on throw).
//
// What is pinned: the pre-flight refuses before a row or a ledger entry exists;
// a refusal inside the lifecycle refunds the hold exactly once; the access
// mode is stored in the statement that stores the Nosana id; and every later
// call on that id goes through the credential that created it, whatever the
// primary mode is by then.

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
process.env.NOSANA_CREDITS_CACHE_MS = "0";
process.env.NOSANA_COST_CACHE_MS = "0";
process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = "5";
for (const name of [
  "NOSANA_WALLET_PRIVATE_KEY",
  "NOSANA_ACCESS_MODE",
  "NOSANA_NETWORK",
  "NOSANA_TIMEOUT_UNIT",
  "NOSANA_MIN_CREDITS_USD",
  "NOSANA_MARKETS_JSON",
  "NOSANA_JOB_TIMEOUT_SECONDS",
  "ALLOW_NOSANA_MOCK",
  "SOLANA_WALLET",
  "ANCHOR_PROVIDER_URL",
  "HF_TOKEN",
]) {
  delete process.env[name];
}

const { NosanaClient } = await import("../services/nosana.js");
const { NosanaLifecycleError } = await import("../services/nosanaDeploymentLifecycle.js");
const { resetNosanaAccessConfigForTests } = await import("../config/nosanaAccess.js");
const { modelDeploymentNosanaName, submitToNosana } = await import(
  "../services/modelDeploymentLifecycle.js"
);
const { estimateDeploymentReservationCents, releaseDeploymentReservation } = await import(
  "../services/deploymentCreditGate.js"
);
const { computeRefusal, runDeployPreflight } = await import("../services/nosanaPreflight.js");

type Client = InstanceType<typeof NosanaClient>;

const KEY = fake.apiKey;
const T_NOW = new Date("2026-10-07T12:00:00.000Z");
// One billing hour of a 3060 replica, as the admission gate computes it
// ($0.0001/s; the gate rounds up).
const HOUR_3060_CENTS = estimateDeploymentReservationCents("3060", 1);
const RICH = { assignedCredits: 100, reservedCredits: 0, settledCredits: 0 };
// Below the $5 floor: every credit gate refuses.
const POOR = { assignedCredits: 1, reservedCredits: 0, settledCredits: 0 };

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

/** An API-key client, built by initialize() from the environment above. */
async function apiClient(): Promise<Client> {
  resetNosanaAccessConfigForTests();
  const client = new NosanaClient();
  await client.initialize();
  return client;
}

/** A wallet SDK that records every call and can do nothing: it must not be reached. */
function untouchedWalletSdk() {
  const ops: string[] = [];
  const refuse = (op: string) => async () => {
    ops.push(op);
    throw new Error(`the wallet client was asked to ${op}`);
  };
  return {
    ops,
    sdk: {
      deployments: { create: refuse("create"), get: refuse("get"), list: refuse("list") },
      jobs: { getMarket: refuse("getMarket") },
    },
  };
}

/**
 * The same process after the operator switched the primary mode to the wallet
 * and kept the API key: both credentials loaded, new deployments on the wallet.
 */
async function walletPrimaryClient() {
  const client = await apiClient();
  const wallet = untouchedWalletSdk();
  (client as any).sdk = wallet.sdk;
  (client as any).wallet = Keypair.generate();
  (client as any).primaryMode = "wallet";
  assert.equal(client.getAccessMode(), "wallet");
  assert.equal(client.hasAccessMode("api_key"), true);
  return { client, wallet };
}

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------

interface Dep {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  modelId: string;
  engine: string;
  gpuTier: string;
  replicas: number;
  config: Record<string, unknown>;
  status: string;
  nosanaJobIds: string[];
  nosanaAccessMode: string | null;
  createdAt: Date;
  updatedAt: Date;
  stoppedAt: Date | null;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
  billedThroughAt: Date | null;
  statusReason: string | null;
  vaultReclaimedAt: Date | null;
  runGeneration: number;
  pendingReplicas: number | null;
  replicaChangeId: string | null;
  replicaChangeAt: Date | null;
  replicaChangeHoldCents: bigint | null;
  gpuStoppedAt: Date | null;
}
interface Ledger {
  orgId: string;
  amountCents: bigint;
  type: string;
  referenceId: string;
  balanceAfter: bigint;
}
interface State {
  deployments: Dep[];
  balances: Record<string, bigint>;
  ledger: Ledger[];
  orphans: Array<Record<string, unknown>>;
}

function makeDb(seed: Array<Partial<Dep> & { id: string }> = []) {
  const state: State = {
    deployments: seed.map((d) => ({
      orgId: "org_1",
      name: "My Model",
      slug: d.id,
      modelId: "model_1",
      engine: "ollama",
      gpuTier: "3060",
      replicas: 1,
      config: { maxTokens: 4096, gpuMemoryUtilization: 0.9 },
      status: "running",
      nosanaJobIds: [],
      nosanaAccessMode: null,
      createdAt: T_NOW,
      updatedAt: T_NOW,
      stoppedAt: null,
      reservationCents: null,
      reservationReleasedAt: null,
      billedThroughAt: null,
      statusReason: null,
      vaultReclaimedAt: null,
      runGeneration: 0,
      pendingReplicas: null,
      replicaChangeId: null,
      replicaChangeAt: null,
      replicaChangeHoldCents: null,
      gpuStoppedAt: null,
      ...d,
    })),
    balances: { org_1: 10_000n },
    ledger: [],
    orphans: [],
  };
  /** Every deployment.updateMany, in order: which columns one statement wrote. */
  const writes: Array<{ where: any; data: any; count: number }> = [];
  let seq = 0;

  const same = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

  const matches = (d: any, where: any): boolean => {
    for (const [key, want] of Object.entries(where as Record<string, any>)) {
      if (key === "OR") {
        if (!(want as any[]).some((alt) => matches(d, alt))) return false;
        continue;
      }
      const have = d[key];
      if (want !== null && typeof want === "object" && !(want instanceof Date)) {
        if ("in" in want && !want.in.includes(have)) return false;
        if ("has" in want && !have.includes(want.has)) return false;
        if ("isEmpty" in want && (have.length === 0) !== want.isEmpty) return false;
        if ("not" in want && same(have, want.not)) return false;
        continue;
      }
      if (!same(have, want)) return false;
    }
    return true;
  };

  const apply = (d: Dep, data: any) => {
    const { runGeneration, reservationCents, ...rest } = data;
    Object.assign(d, rest);
    if (typeof runGeneration === "number") d.runGeneration = runGeneration;
    else if (runGeneration?.increment) d.runGeneration += runGeneration.increment;
    if (reservationCents !== undefined) {
      if (reservationCents === null || typeof reservationCents === "bigint") {
        d.reservationCents = reservationCents;
      } else if (reservationCents.increment !== undefined) {
        d.reservationCents = (d.reservationCents ?? 0n) + reservationCents.increment;
      } else if (reservationCents.decrement !== undefined) {
        d.reservationCents = (d.reservationCents ?? 0n) - reservationCents.decrement;
      }
    }
  };

  const model = { id: "model_1", hfId: "meta-llama/Llama-3.2-1B-Instruct", displayName: "Llama", pricingTier: "small" };

  const tx = {
    model: { findUnique: async ({ where }: any) => (where.id === "model_1" ? model : null) },
    deployment: {
      findFirst: async ({ where, include }: any) => {
        const d = state.deployments.find((x) => matches(x, where));
        return d
          ? structuredClone({
              ...d,
              ...(include?.model ? { model } : {}),
              ...(include?.nodes ? { nodes: [] } : {}),
            })
          : null;
      },
      findUnique: async ({ where }: any) => {
        const d = where.orgId_slug
          ? state.deployments.find(
              (x) => x.orgId === where.orgId_slug.orgId && x.slug === where.orgId_slug.slug,
            )
          : state.deployments.find((x) => x.id === where.id);
        return d ? structuredClone(d) : null;
      },
      count: async ({ where }: any) => state.deployments.filter((d) => matches(d, where)).length,
      create: async ({ data }: any) => {
        const row = {
          ...makeDb([{ id: `dep_new_${++seq}` }]).state.deployments[0]!,
          ...data,
        } as Dep;
        state.deployments.push(row);
        return structuredClone(row);
      },
      update: async ({ where, data }: any) => {
        const d = state.deployments.find((x) => x.id === where.id)!;
        apply(d, data);
        return structuredClone(d);
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const d of state.deployments) {
          if (matches(d, where)) {
            apply(d, data);
            count += 1;
          }
        }
        writes.push({ where, data, count });
        return { count };
      },
    },
    creditBalance: {
      updateMany: async ({ where, data }: any) => {
        const bal = state.balances[where.orgId] ?? 0n;
        if (bal < where.balanceCents.gte) return { count: 0 };
        state.balances[where.orgId] = bal - data.balanceCents.decrement;
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        state.balances[where.orgId] = (state.balances[where.orgId] ?? 0n) + data.balanceCents.increment;
        return { balanceCents: state.balances[where.orgId]! };
      },
      findUnique: async ({ where }: any) => ({ balanceCents: state.balances[where.orgId] ?? 0n }),
    },
    creditTransaction: {
      create: async ({ data }: any) => {
        state.ledger.push({
          orgId: data.orgId,
          amountCents: data.amountCents,
          type: data.type,
          referenceId: data.referenceId,
          balanceAfter: data.balanceAfter,
        });
        return {};
      },
    },
    deploymentNode: { deleteMany: async () => ({}), updateMany: async () => ({ count: 0 }) },
    agentDeployment: { updateMany: async () => ({ count: 0 }) },
    usageRecord: { findMany: async () => [] },
    nosanaOrphanDeployment: {
      createMany: async ({ data }: any) => {
        state.orphans.push(...data);
        return { count: data.length };
      },
    },
  };

  let chain: Promise<unknown> = Promise.resolve();
  const prisma = {
    ...tx,
    $transaction: <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        const snapshot = structuredClone(state);
        try {
          return await fn(tx);
        } catch (err) {
          Object.assign(state, snapshot);
          throw err;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return { prisma, state, writes };
}

type Db = ReturnType<typeof makeDb>;

/** The deployment routes over `db`, with the REAL submit, which the test awaits. */
async function makeApp(db: Db, nosana: unknown) {
  const mod = await import("../routes/deployments.js");
  (await import("../lib/bigintJson.js")).installBigIntJsonSerializer();
  const app = Fastify();
  await app.register((await import("@fastify/sensible")).default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = { userId: "user_1", orgId: "org_1", type: "jwt" } as never;
  });
  const submits: Array<Promise<void>> = [];
  const deps = { prisma: db.prisma as never, getNosana: async () => nosana as never, now: () => T_NOW };
  await app.register(
    mod.createDeploymentRoutes({
      ...deps,
      triggerWebhook: (async () => undefined) as never,
      submit: (id, config, tier, replicas, generation) => {
        const done = submitToNosana(deps, id, config, tier, replicas, generation);
        // The route does not await it; the test does (and reads the outcome
        // from the row, as the dashboard would).
        submits.push(done.catch(() => undefined));
        return done;
      },
    }),
  );
  return { app, settle: () => Promise.all(submits) };
}

const CREATE_BODY = { name: "Llama small", modelId: "model_1", gpuTier: "3060", engine: "ollama", replicas: 1 };

/** A stopped or failed row of a run that API-key access created. */
function endedRow(over: Partial<Dep> = {}): Partial<Dep> & { id: string } {
  return {
    id: "dep_1",
    status: "failed",
    stoppedAt: T_NOW,
    reservationCents: HOUR_3060_CENTS,
    reservationReleasedAt: T_NOW,
    nosanaAccessMode: "api_key",
    ...over,
  };
}

/** Creates a real deployment on the fake through `client`; returns its Nosana id. */
async function nosanaDeployment(client: Client, name: string): Promise<string> {
  const created = await client.createDeployment(
    { version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [] } as never,
    "3060",
    1,
    { name },
  );
  return created.id;
}

// ============================================
// The pre-flight: before a row, before a ledger entry
// ============================================

const REFUSALS: Array<{ reason: string; arrange: () => void }> = [
  { reason: "nosana_credits_low", arrange: () => fake.setBalance(POOR) },
  {
    reason: "nosana_credits_unavailable",
    arrange: () =>
      // The gate reads the balance once, fresh; that one read fails.
      fake.failNext({ method: "GET", path: /^\/api\/credits\/balance$/ }, { status: 500, body: { error: "down" } }),
  },
  { reason: "nosana_auth_failed", arrange: () => fake.rotateApiKey("nos_rotated_key_for_tests_0002") },
  {
    reason: "gpu_price_below_cost",
    // The 3060 market now costs more per hour than its retail price ($0.36).
    arrange: () =>
      fake.setMarkets(
        (FAKE_MARKETS as Array<Record<string, unknown>>).map((m) =>
          m.slug === "nvidia-3060" ? { ...m, usd_reward_per_hour: 5 } : m,
        ),
      ),
  },
  {
    reason: "gpu_cost_unavailable",
    // The market list no longer prices the 3060 and this client never saw a
    // price for it: the cost is unknown, so nothing is admitted on a guess.
    arrange: () =>
      fake.setMarkets(
        (FAKE_MARKETS as Array<Record<string, unknown>>).filter((m) => m.slug !== "nvidia-3060"),
      ),
  },
];

for (const { reason, arrange } of REFUSALS) {
  test(`POST / refused by the platform's funding (${reason}): 503, no row, no ledger entry, nothing created on Nosana`, async () => {
    resetFake();
    const client = await apiClient();
    arrange();
    const db = makeDb();
    const { app, settle } = await makeApp(db, client);

    const res = await app.inject({ method: "POST", url: "/", payload: CREATE_BODY });
    await settle();

    assert.equal(res.statusCode, 503);
    const body = res.json();
    assert.equal(body.error, "compute_capacity_unavailable");
    assert.equal(body.reason, reason);
    assert.match(body.message, /Nothing was reserved/);
    assert.doesNotMatch(body.message, /\$|\d/, "no amount is stated to a customer");
    assert.deepEqual(db.state.deployments, [], "no row");
    assert.deepEqual(db.state.ledger, [], "no ledger entry");
    assert.equal(db.state.balances.org_1, 10_000n, "no credit moved");
    assert.equal(sent("POST", /\/api\/deployments\/create$/).length, 0);
    await app.close();
  });
}

test("the pre-flight helper falls back to assertCanDeploy for a port without preflightDeploy", async () => {
  const calls: string[] = [];
  await runDeployPreflight({ assertCanDeploy: (tier) => void calls.push(`assert:${tier}`) }, "3060", 2);
  await runDeployPreflight(
    {
      assertCanDeploy: () => void calls.push("assert"),
      preflightDeploy: async (tier, replicas, kind) => void calls.push(`preflight:${tier}:${replicas}:${kind}`),
    },
    "4090",
    3,
  );
  assert.deepEqual(calls, ["assert:3060", "preflight:4090:3:service"]);
  assert.equal(computeRefusal(new Error("boom")), null, "an unrelated error is not a funding refusal");
});

// ============================================
// Create: the mode is stored with the id, and the id is acted on through it
// ============================================

test("a deployment created with the API key stores api_key beside its id, and is stopped through the API key after the primary mode moved to the wallet", async () => {
  resetFake();
  const db = makeDb();
  const first = await makeApp(db, await apiClient());

  const created = await first.app.inject({ method: "POST", url: "/", payload: CREATE_BODY });
  assert.equal(created.statusCode, 201);
  await first.settle();
  await first.app.close();

  const row = db.state.deployments[0]!;
  assert.equal(row.status, "provisioning");
  assert.equal(row.nosanaJobIds.length, 1);
  assert.equal(row.nosanaAccessMode, "api_key");
  // One statement wrote both: there is no instant at which the id is on the
  // row without the account it belongs to.
  const storing = db.writes.filter((w) => w.data.nosanaJobIds?.length === 1);
  assert.equal(storing.length, 1);
  assert.equal(storing[0]!.data.nosanaAccessMode, "api_key");
  // The name is derived from the row and its run, so Nosana's own list leads back here.
  const createCall = sent("POST", /\/api\/deployments\/create$/)[0]!;
  assert.equal((createCall.body as any).name, modelDeploymentNosanaName(row.id, 0));
  assert.equal(db.state.balances.org_1, 10_000n - HOUR_3060_CENTS, "one hour held");

  // The operator switches the primary mode to the wallet and keeps the key.
  const { client, wallet } = await walletPrimaryClient();
  const second = await makeApp(db, client);
  fake.requests.length = 0;

  const stopped = await second.app.inject({ method: "DELETE", url: `/${row.id}` });
  assert.equal(stopped.statusCode, 200);
  assert.equal(sent("POST", new RegExp(`/api/deployments/${row.nosanaJobIds[0]}/stop$`)).length, 1);
  assert.deepEqual(wallet.ops, [], "the wallet client was never asked about an API-key deployment");
  assert.equal(fake.vaultCalls(), 0);

  // The fake answers STOPPING: not released yet, under both names.
  const body = stopped.json();
  assert.equal(body.fundsReleased, false);
  assert.equal(body.vaultReclaimed, body.fundsReleased);
  assert.equal(row.status, "stopped");
  assert.equal(row.vaultReclaimedAt, null);

  // The org's hold came back exactly once.
  const releases = db.state.ledger.filter((l) => l.amountCents > 0n);
  assert.equal(releases.length, 1);
  assert.equal(db.state.balances.org_1, 10_000n);
  assert.equal(db.state.ledger.at(-1)!.balanceAfter, 10_000n);
  await second.app.close();
});

test("the stop response says fundsReleased true once Nosana reports the deployment stopped", async () => {
  resetFake();
  const client = await apiClient();
  const id = await nosanaDeployment(client, "wheelsai-model-stop-released");
  fake.setStatus(id, "STOPPED");
  const db = makeDb([{ id: "dep_1", status: "provisioning", nosanaJobIds: [id], nosanaAccessMode: "api_key" }]);
  const { app } = await makeApp(db, client);

  const res = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().fundsReleased, true);
  assert.equal(res.json().vaultReclaimed, true);
  assert.deepEqual(db.state.deployments[0]!.vaultReclaimedAt, T_NOW);
  await app.close();
});

// ============================================
// A refusal inside the lifecycle, after the hold
// ============================================

test("the credit gate refusing INSIDE the lifecycle fails the row and refunds its hold exactly once", async () => {
  resetFake();
  const client = await apiClient();
  // The balance drops between the route's pre-flight and the create.
  const racing = {
    assertCanDeploy: client.assertCanDeploy.bind(client),
    preflightDeploy: client.preflightDeploy.bind(client),
    createDeployment: async (...args: Parameters<Client["createDeployment"]>) => {
      fake.setBalance(POOR);
      return client.createDeployment(...args);
    },
  };
  const db = makeDb();
  const { app, settle } = await makeApp(db, racing);

  const res = await app.inject({ method: "POST", url: "/", payload: CREATE_BODY });
  assert.equal(res.statusCode, 201, "the pre-flight passed; the hold was taken");
  await settle();

  const row = db.state.deployments[0]!;
  assert.equal(row.status, "failed");
  assert.match(row.statusReason ?? "", /^nosana_credits_low/);
  assert.deepEqual(row.nosanaJobIds, [], "nothing was created on Nosana");
  assert.equal(sent("POST", /\/api\/deployments\/create$/).length, 0);

  assert.deepEqual(
    db.state.ledger.map((l) => l.amountCents),
    [-HOUR_3060_CENTS, HOUR_3060_CENTS],
    "one hold, one refund",
  );
  assert.equal(db.state.balances.org_1, 10_000n);
  assert.deepEqual(row.reservationReleasedAt, T_NOW);

  // A second release (the status worker's sweep, a retried request) is a no-op.
  const again = await db.prisma.$transaction((tx) =>
    releaseDeploymentReservation({
      tx: tx as never,
      kind: "model",
      deploymentId: row.id,
      orgId: "org_1",
      reservationCents: HOUR_3060_CENTS,
      reason: "failed",
    }),
  );
  assert.equal(again.released, false);
  assert.equal(db.state.ledger.length, 2);
  assert.equal(db.state.balances.org_1, 10_000n);
  await app.close();
});

test("a create call that throws after Nosana created the deployment: the idempotency key finds it, the row fails holding its id, the hold is refunded", async () => {
  resetFake();
  const client = await apiClient();
  // The SDK parses `owner` as a Solana public key AFTER the POST succeeded,
  // so the create throws and every SDK read of that deployment throws too.
  fake.setOwner("not-a-public-key");
  const db = makeDb();
  const { app, settle } = await makeApp(db, client);

  const res = await app.inject({ method: "POST", url: "/", payload: CREATE_BODY });
  assert.equal(res.statusCode, 201);
  await settle();

  const row = db.state.deployments[0]!;
  const name = modelDeploymentNosanaName(row.id, row.runGeneration);
  assert.equal(row.status, "failed");
  assert.equal(db.state.balances.org_1, 10_000n, "the hold was refunded");

  // The create was sent with the per-run name as its idempotency key, and the
  // lookup by that key found what it made: the row keeps the id, for the sweep.
  const create = sent("POST", /\/deployments\/create$/);
  assert.equal(create.length, 1);
  assert.equal((create[0]!.body as Record<string, unknown>).idempotency_key, name);
  assert.equal(sent("GET", /\/deployments$/).filter((r) => r.query.idempotency_key === name).length, 1);
  const found = await client.findDeploymentByIdempotencyKey(name, "api_key");
  assert.ok(found, "the key leads back to the row and its run");
  assert.equal(found!.status, "draft");
  assert.deepEqual(row.nosanaJobIds, [found!.id], "the id the key found is kept for the sweep");
  assert.equal(row.nosanaAccessMode, "api_key");
  assert.equal(sent("POST", /\/start$/).length, 0, "an unreadable deployment is never started");
  await app.close();
});

test("an orphaned deployment is stopped through, and recorded with, the access mode that created it", async () => {
  const db = makeDb([{ id: "dep_1", status: "pending", reservationCents: HOUR_3060_CENTS }]);
  const stops: unknown[][] = [];
  const port = {
    assertCanDeploy: () => undefined,
    createDeployment: async () => {
      // Stopped AND restarted while the create was in flight: the row is a later run now.
      Object.assign(db.state.deployments[0]!, { status: "pending", runGeneration: 1 });
      return { id: "dm_late", market: "M", replicas: 1, status: "active" as const, endpoints: [], accessMode: "api_key" as const };
    },
    stopDeployment: async (...args: unknown[]) => {
      stops.push(args);
      return { deploymentId: "dm_late", stopped: true, alreadyStopped: false, reclaimed: false, remainingNosBaseUnits: null };
    },
  };
  await submitToNosana(
    { prisma: db.prisma as never, getNosana: async () => port as never, now: () => T_NOW },
    "dep_1",
    { modelId: "model_1", hfModelId: "meta-llama/Llama-3.2-1B-Instruct", engine: "ollama", maxTokens: 4096, gpuMemoryUtilization: 0.9 },
    "3060",
    1,
    0,
  );
  assert.deepEqual(stops, [["dm_late", "api_key"]]);
  assert.equal(db.state.orphans.length, 1);
  assert.equal(db.state.orphans[0]!.nosanaDeploymentId, "dm_late");
  assert.equal(db.state.orphans[0]!.accessMode, "api_key");
  assert.deepEqual(db.state.deployments[0]!.nosanaJobIds, [], "the later run was not handed this id");
});

test("a failure after creation stores the partial id with the mode the failed call used", async () => {
  const db = makeDb([{ id: "dep_1", status: "pending", reservationCents: HOUR_3060_CENTS }]);
  const failure = new NosanaLifecycleError("start refused", "start", {
    deploymentId: "dm_partial",
    cleanup: { stopped: true, reclaimed: false, errors: [] },
  });
  failure.accessMode = "api_key";
  const port = {
    assertCanDeploy: () => undefined,
    createDeployment: async () => {
      throw failure;
    },
  };
  await assert.rejects(
    submitToNosana(
      { prisma: db.prisma as never, getNosana: async () => port as never, now: () => T_NOW },
      "dep_1",
      { modelId: "model_1", hfModelId: "meta-llama/Llama-3.2-1B-Instruct", engine: "ollama", maxTokens: 4096, gpuMemoryUtilization: 0.9 },
      "3060",
      1,
      0,
    ),
    failure,
  );
  const row = db.state.deployments[0]!;
  assert.equal(row.status, "failed");
  assert.deepEqual(row.nosanaJobIds, ["dm_partial"]);
  assert.equal(row.nosanaAccessMode, "api_key");
  const failing = db.writes.find((w) => w.data.status === "failed")!;
  assert.equal(failing.data.nosanaAccessMode, "api_key", "same statement as the id");
});

// ============================================
// Restart
// ============================================

for (const ended of ["INSUFFICIENT_FUNDS", "ERROR"] as const) {
  test(`restart after a credits-mode run ended in ${ended}: held while Nosana refuses the stop, allowed once a stop is accepted and wound down`, async () => {
    resetFake();
    const client = await apiClient();
    const previous = await nosanaDeployment(client, `wheelsai-model-prev-${ended.toLowerCase()}`);
    fake.setStatus(previous, ended);
    const db = makeDb([endedRow({ nosanaJobIds: [previous], statusReason: "nosana_insufficient_funds" })]);
    const { app, settle } = await makeApp(db, client);

    // A halted deployment is not released while Nosana refuses its stop: it
    // could resume on its own after a credit top-up.
    fake.failNext({ method: "POST", path: new RegExp(`/${previous}/stop$`) }, { status: 400, body: { error: "not running" } });
    let res = await app.inject({ method: "POST", url: "/dep_1/restart" });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, "previous_run_winding_down");
    assert.equal(db.state.deployments[0]!.runGeneration, 0);

    // The stop is accepted the next time: winding down, still not released.
    res = await app.inject({ method: "POST", url: "/dep_1/restart" });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(fake.deployments.get(previous)!.status, "STOPPING");

    fake.settle(previous); // STOPPED
    fake.requests.length = 0;
    res = await app.inject({ method: "POST", url: "/dep_1/restart" });
    assert.equal(res.statusCode, 200, res.body);
    await settle();

    const row = db.state.deployments[0]!;
    assert.equal(row.runGeneration, 1);
    assert.equal(row.status, "provisioning");
    assert.equal(row.nosanaJobIds.length, 1);
    assert.notEqual(row.nosanaJobIds[0], previous, "a new Nosana deployment");
    assert.equal(row.nosanaAccessMode, "api_key");
    const createCall = sent("POST", /\/api\/deployments\/create$/)[0]!;
    assert.equal((createCall.body as any).name, modelDeploymentNosanaName("dep_1", 1), "named for the new run");
    await app.close();
  });
}

test("restart while the previous credits-mode run is still running on Nosana waits: previous_run_winding_down", async () => {
  resetFake();
  const client = await apiClient();
  const previous = await nosanaDeployment(client, "wheelsai-model-prev-running");
  fake.settle(previous); // RUNNING; the reclaim asks it to stop -> STOPPING
  const db = makeDb([endedRow({ status: "stopped", nosanaJobIds: [previous] })]);
  const { app } = await makeApp(db, client);

  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "previous_run_winding_down");
  assert.equal(db.state.deployments[0]!.runGeneration, 0);
  await app.close();
});

test("restart is refused with previous_run_other_account when the previous run's access mode has no credential here", async () => {
  resetFake();
  const client = await apiClient(); // API key only
  // A row from before the switch: no stamp means the wallet created it.
  const db = makeDb([endedRow({ status: "stopped", nosanaJobIds: ["dm_wallet_run"], nosanaAccessMode: null })]);
  const before = structuredClone(db.state);
  const { app, settle } = await makeApp(db, client);
  fake.requests.length = 0;

  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });
  await settle();
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "previous_run_other_account");
  assert.doesNotMatch(res.json().message, /[Rr]etry/, "no retry from here can reach it");
  assert.deepEqual(db.state, before, "the row, the balance and the ledger are untouched");
  assert.equal(sent("POST", /./).length, 0, "nothing was asked of Nosana for the other account's deployment");
  await app.close();
});

test("restart refused by the pre-flight: 503, the row and the balance untouched", async () => {
  resetFake();
  const client = await apiClient();
  fake.setBalance(POOR);
  const db = makeDb([endedRow({ status: "stopped", vaultReclaimedAt: T_NOW, nosanaJobIds: ["dm_done"] })]);
  const before = structuredClone(db.state);
  const { app, settle } = await makeApp(db, client);

  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });
  await settle();
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "compute_capacity_unavailable");
  assert.equal(res.json().reason, "nosana_credits_low");
  assert.deepEqual(db.state, before);
  await app.close();
});

// ============================================
// Stop, replicas and logs go through the row's mode
// ============================================

test("an owner can stop a row whose access mode has no credential here: stopped, hold released once, no final charge, the id kept for the sweep", async () => {
  resetFake();
  const client = await apiClient(); // API key only
  const db = makeDb([
    {
      id: "dep_1",
      status: "running",
      nosanaJobIds: ["dm_wallet_run"],
      reservationCents: HOUR_3060_CENTS,
      // An hour behind: a final charge would be 36 cents.
      billedThroughAt: new Date(T_NOW.getTime() - 3_600_000),
    },
  ]);
  const balanceBefore = db.state.balances.org_1!;
  const { app } = await makeApp(db, client);

  const res = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(res.statusCode, 200);
  // Nothing confirmed a release: the response does not claim one.
  assert.equal(res.json().fundsReleased, false);
  assert.equal(res.json().vaultReclaimed, false);

  const row = db.state.deployments[0]!;
  assert.equal(row.status, "stopped");
  assert.equal(row.statusReason, "user_stopped");
  // What the sweep and the operator view need to find it and stop it later.
  assert.deepEqual(row.nosanaJobIds, ["dm_wallet_run"]);
  assert.equal(row.nosanaAccessMode ?? null, null, "unstamped: the wallet's, as before");
  assert.equal(row.vaultReclaimedAt, null, "not released: the reclaim sweep keeps it");
  assert.equal(row.gpuStoppedAt ?? null, null, "nothing confirmed that the GPUs stopped");

  // The hold came back exactly once and nothing was charged for the tail.
  assert.deepEqual(
    db.state.ledger.map((l) => l.amountCents),
    [HOUR_3060_CENTS],
  );
  assert.equal(db.state.balances.org_1, balanceBefore + HOUR_3060_CENTS);
  assert.equal(db.state.ledger[0]!.balanceAfter, db.state.balances.org_1);
  assert.equal(fake.requests.length, 0, "the API-key account was never asked about a wallet deployment");

  // A second stop is idempotent: no second release.
  const again = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(again.statusCode, 200);
  assert.equal(db.state.ledger.length, 1);
  await app.close();
});

test("a stop Nosana does not confirm is still refused when the credential IS here: 502, the row unchanged", async () => {
  resetFake();
  const client = await apiClient();
  const id = await nosanaDeployment(client, "wheelsai-model-stop-502");
  fake.settle(id);
  const db = makeDb([
    { id: "dep_1", status: "running", nosanaJobIds: [id], nosanaAccessMode: "api_key", reservationCents: HOUR_3060_CENTS, billedThroughAt: T_NOW },
  ]);
  const before = structuredClone(db.state);
  const { app } = await makeApp(db, client);
  fake.failNext({ method: "POST", path: new RegExp(`/${id}/stop$`) }, { status: 500, body: { error: "manager down" } });

  const res = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "nosana_stop_failed");
  assert.deepEqual(db.state, before);
  await app.close();
});

test("a replica change and a log read reach an API-key deployment through the API key while the wallet is primary", async () => {
  resetFake();
  const id = await nosanaDeployment(await apiClient(), "wheelsai-model-scale");
  fake.settle(id);
  fake.addJob(id); // listed: Nosana records a JOB_LIST_CONFIRMED event
  const { client, wallet } = await walletPrimaryClient();
  const db = makeDb([
    {
      id: "dep_1",
      status: "running",
      nosanaJobIds: [id],
      nosanaAccessMode: "api_key",
      reservationCents: HOUR_3060_CENTS,
      billedThroughAt: T_NOW,
    },
  ]);
  const { app } = await makeApp(db, client);
  fake.requests.length = 0;

  const scaled = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 2 } });
  assert.equal(scaled.statusCode, 200, scaled.body);
  assert.equal(sent("PATCH", new RegExp(`/${id}/update-replica-count$`)).length, 1);
  assert.equal(fake.deployments.get(id)!.replicas, 2);
  assert.equal(db.state.deployments[0]!.replicas, 2);

  const logs = await app.inject({ method: "GET", url: "/dep_1/logs" });
  assert.equal(logs.statusCode, 200);
  assert.ok(logs.json().logs.length > 0, "Nosana's own events for the deployment");
  assert.deepEqual(wallet.ops, []);
  await app.close();
});

test("a scale-up the platform's credits cannot cover: 503, the claim and its hold are given back, the count stays", async () => {
  resetFake();
  const client = await apiClient();
  const id = await nosanaDeployment(client, "wheelsai-model-scale-refused");
  fake.settle(id);
  fake.setBalance(POOR);
  const db = makeDb([
    {
      id: "dep_1",
      status: "running",
      nosanaJobIds: [id],
      nosanaAccessMode: "api_key",
      reservationCents: HOUR_3060_CENTS,
      billedThroughAt: T_NOW,
    },
  ]);
  const { app } = await makeApp(db, client);
  fake.requests.length = 0;

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 2 } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "compute_capacity_unavailable");
  assert.equal(res.json().reason, "nosana_credits_low");
  assert.doesNotMatch(res.json().message, /\$|\d/);

  const row = db.state.deployments[0]!;
  assert.equal(row.replicas, 1);
  assert.equal(row.replicaChangeId, null, "the claim was cleared");
  assert.equal(row.reservationCents, HOUR_3060_CENTS, "the added replica's hold was returned");
  assert.equal(db.state.balances.org_1, 10_000n);
  assert.equal(sent("PATCH", /update-replica-count$/).length, 0);
  assert.equal(fake.deployments.get(id)!.replicas, 1);
  await app.close();
});

test("the access mode is the platform's record: it is not in what an owner reads back", async () => {
  resetFake();
  const db = makeDb([
    { id: "dep_1", status: "running", nosanaJobIds: ["dm_x"], nosanaAccessMode: "api_key", billedThroughAt: T_NOW },
  ]);
  const { app } = await makeApp(db, await apiClient());

  const detail = await app.inject({ method: "GET", url: "/dep_1" });
  assert.equal(detail.statusCode, 200);
  assert.equal("nosanaAccessMode" in detail.json().deployment, false);

  const patched = await app.inject({ method: "PATCH", url: "/dep_1", payload: { config: { maxTokens: 512 } } });
  assert.equal(patched.statusCode, 200);
  assert.equal("nosanaAccessMode" in patched.json().deployment, false);
  assert.equal(db.state.deployments[0]!.nosanaAccessMode, "api_key", "still on the row");

  const { serializeAgentDeployment } = await import("../services/publicEndpoints.js");
  const agent = serializeAgentDeployment(
    { id: "a1", status: "running", nosanaJobIds: ["dm_y"], nosanaAccessMode: "api_key" },
    "my-agent",
    "https://api.example.test",
  );
  assert.equal("nosanaAccessMode" in agent, false);
  assert.equal(agent.id, "a1");
  await app.close();
});
