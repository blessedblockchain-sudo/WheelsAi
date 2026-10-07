import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

// Env must be in place BEFORE the route module (and config/env.ts) is first
// imported; every import of app code below is dynamic for that reason.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
process.env.PUBLIC_API_URL = "https://api.example.test/";
process.env.HF_TOKEN = "hf_test_token";
process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = "2";

// Drives apps/api/src/routes/deployments.ts (createDeploymentRoutes) against an
// in-memory database with real transaction semantics (serialised, rolled back
// on throw) and a fake Nosana port. Covers W2-F (stop / restart / replicas /
// logs), W2-H (the endpoint) and the submit path (W2-B wiring).

const T_NOW = new Date("2026-09-30T12:00:00.000Z");
const T_CURSOR = new Date("2026-09-30T11:58:20.000Z"); // 100 s before T_NOW

// 4090 retail = $0.00025/s -> one billing hour = 90 cents per replica.
const HOUR_4090_CENTS = 90n;

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
interface Orphan {
  nosanaDeploymentId: string;
  sourceKind: string;
  sourceId: string | null;
  reason: string;
}
interface Node {
  id: string;
  deploymentId: string;
  nosanaNodeId: string;
  nodeUrl: string;
  healthStatus: string;
  latencyMs: number | null;
}
interface State {
  deployments: Dep[];
  nodes: Node[];
  balances: Record<string, bigint>;
  ledger: Array<{ orgId: string; amountCents: bigint; type: string; referenceId: string }>;
  orphans: Orphan[];
}

function makeDb(seed: {
  deployments?: Array<Partial<Dep> & { id: string }>;
  nodes?: Node[];
  balances?: Record<string, bigint>;
}) {
  const state: State = {
    deployments: (seed.deployments ?? []).map((d) => ({
      orgId: "org_1",
      name: "My Model",
      slug: "my-model",
      modelId: "model_1",
      engine: "vllm",
      gpuTier: "4090",
      replicas: 1,
      config: { maxTokens: 4096, gpuMemoryUtilization: 0.9 },
      status: "running",
      nosanaJobIds: ["dm_1"],
      createdAt: new Date("2026-09-30T10:00:00.000Z"),
      updatedAt: new Date("2026-09-30T10:00:00.000Z"),
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
    nodes: seed.nodes ?? [],
    balances: { org_1: 10_000n, ...(seed.balances ?? {}) },
    ledger: [],
    orphans: [],
  };
  let seq = 0;

  const sameDate = (a: Date | null, b: Date | null) =>
    a === null || b === null ? a === b : a.getTime() === b.getTime();

  const matches = (d: Dep, where: any): boolean => {
    if (where.id !== undefined && d.id !== where.id) return false;
    if (where.orgId !== undefined && d.orgId !== where.orgId) return false;
    if (typeof where.status === "string" && d.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(d.status)) return false;
    if (where.replicas !== undefined && d.replicas !== where.replicas) return false;
    if ("billedThroughAt" in where && !sameDate(d.billedThroughAt, where.billedThroughAt)) return false;
    if ("reservationReleasedAt" in where && !sameDate(d.reservationReleasedAt, where.reservationReleasedAt)) return false;
    if (where.nosanaJobIds?.isEmpty === true && d.nosanaJobIds.length !== 0) return false;
    if (where.nosanaJobIds?.has !== undefined && !d.nosanaJobIds.includes(where.nosanaJobIds.has)) return false;
    if (where.runGeneration !== undefined && d.runGeneration !== where.runGeneration) return false;
    if ("vaultReclaimedAt" in where && !sameDate(d.vaultReclaimedAt, where.vaultReclaimedAt)) return false;
    if ("replicaChangeId" in where && d.replicaChangeId !== where.replicaChangeId) return false;
    if ("gpuStoppedAt" in where && !sameDate(d.gpuStoppedAt, where.gpuStoppedAt)) return false;
    if ("reservationCents" in where && d.reservationCents !== where.reservationCents) return false;
    return true;
  };

  // Prisma's atomic number operation, as the restart claim uses it.
  const apply = (d: Dep, data: any) => {
    const { runGeneration, ...rest } = data;
    Object.assign(d, rest);
    if (typeof runGeneration === "number") d.runGeneration = runGeneration;
    else if (runGeneration?.increment) d.runGeneration += runGeneration.increment;
  };

  const withRelations = (d: Dep, include?: any) => {
    const out: any = { ...d };
    if (include?.model) out.model = { id: d.modelId, displayName: "Llama", hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct", pricingTier: "small" };
    if (include?.nodes) {
      out.nodes = state.nodes.filter((n) => n.deploymentId === d.id);
    }
    return out;
  };

  const tx = {
    model: {
      findUnique: async ({ where }: any) =>
        where.id === "model_1"
          ? { id: "model_1", hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct", displayName: "Llama", pricingTier: "small" }
          : null,
    },
    deployment: {
      findMany: async ({ where, include }: any) =>
        state.deployments.filter((d) => matches(d, where)).map((d) => withRelations(d, include)),
      findFirst: async ({ where, include }: any) => {
        const d = state.deployments.find((x) => matches(x, where));
        return d ? withRelations(d, include) : null;
      },
      findUnique: async ({ where }: any) => {
        if (where.orgId_slug) {
          const d = state.deployments.find(
            (x) => x.orgId === where.orgId_slug.orgId && x.slug === where.orgId_slug.slug,
          );
          return d ? { ...d } : null;
        }
        const d = state.deployments.find((x) => x.id === where.id);
        return d ? { ...d } : null;
      },
      count: async ({ where }: any) => state.deployments.filter((d) => matches(d, where)).length,
      create: async ({ data }: any) => {
        const row: Dep = {
          id: `dep_new_${++seq}`,
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
          ...data,
        };
        state.deployments.push(row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const d = state.deployments.find((x) => x.id === where.id)!;
        apply(d, data);
        return { ...d };
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const d of state.deployments) {
          if (matches(d, where)) {
            apply(d, data);
            count += 1;
          }
        }
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
        });
        return {};
      },
    },
    deploymentNode: {
      deleteMany: async ({ where }: any) => {
        state.nodes = state.nodes.filter((n) => n.deploymentId !== where.deploymentId);
        return {};
      },
      updateMany: async () => ({ count: 0 }),
    },
    agentDeployment: { updateMany: async () => ({ count: 0 }) },
    usageRecord: { findMany: async () => [] },
    nosanaOrphanDeployment: {
      createMany: async ({ data }: any) => {
        let count = 0;
        for (const o of data) {
          if (state.orphans.some((x) => x.nosanaDeploymentId === o.nosanaDeploymentId)) continue;
          state.orphans.push(o);
          count += 1;
        }
        return { count };
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
          state.deployments = snapshot.deployments;
          state.nodes = snapshot.nodes;
          state.balances = snapshot.balances;
          state.ledger = snapshot.ledger;
          state.orphans = snapshot.orphans;
          throw err;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return { prisma, state };
}

// ---------------------------------------------------------------------------
// Fake Nosana port
// ---------------------------------------------------------------------------

interface NosanaFake {
  calls: Array<{ op: string; args: unknown[] }>;
  stopError?: Error;
  scaleError?: Error;
  assertError?: Error;
  reclaim?: { reclaimed: boolean } | Error;
  stopResult?: { reclaimed: boolean };
  events?: Array<{ type: string; message: string; createdAt: string | null; tx?: string }>;
  statusError?: Error;
  createResult?: { id: string };
  createError?: Error;
  /** The replica count Nosana runs (what getDeploymentStatus reports). */
  replicas?: number;
  /** stopDeployment reports the deployment was already stopped before the call. */
  alreadyStopped?: boolean;
  /** Runs inside scaleDeployment, before it applies / throws (an open Nosana call). */
  onScale?: (replicas: number) => Promise<void> | void;
  /** scaleDeployment throws scaleError AFTER Nosana applied the count (a lost response). */
  scaleAppliesBeforeError?: boolean;
}

function makeNosana(over: Partial<NosanaFake> = {}) {
  const fake: NosanaFake = { calls: [], ...over };
  const rec = (op: string, ...args: unknown[]) => fake.calls.push({ op, args });
  const port = {
    assertCanDeploy: (tier: string) => {
      rec("assertCanDeploy", tier);
      if (fake.assertError) throw fake.assertError;
    },
    createDeployment: async (...args: unknown[]) => {
      rec("createDeployment", ...args);
      if (fake.createError) throw fake.createError;
      return { id: "dm_new", market: "M", replicas: 1, status: "active" as const, endpoints: [] };
    },
    stopDeployment: async (id: string) => {
      rec("stopDeployment", id);
      if (fake.stopError) throw fake.stopError;
      return {
        deploymentId: id,
        stopped: true,
        alreadyStopped: fake.alreadyStopped ?? false,
        reclaimed: fake.stopResult?.reclaimed ?? true,
        remainingNosBaseUnits: 0n,
      };
    },
    scaleDeployment: async (id: string, replicas: number, tier: string) => {
      rec("scaleDeployment", id, replicas, tier);
      await fake.onScale?.(replicas);
      if (fake.scaleError && !fake.scaleAppliesBeforeError) throw fake.scaleError;
      const previousReplicas = fake.replicas ?? 1;
      fake.replicas = replicas;
      if (fake.scaleError) throw fake.scaleError;
      return { deploymentId: id, previousReplicas, replicas, funded: null };
    },
    getDeploymentStatus: async (id: string) => {
      rec("getDeploymentStatus", id);
      if (fake.statusError) throw fake.statusError;
      return {
        id,
        status: "running" as const,
        endpoints: [],
        jobs: [],
        replicas: fake.replicas ?? 1,
        events: fake.events ?? [],
        invalidEndpointCount: 0,
      };
    },
    reclaimDeploymentVault: async (id: string) => {
      rec("reclaimDeploymentVault", id);
      if (fake.reclaim instanceof Error) throw fake.reclaim;
      return {
        deploymentId: id,
        state: "stopped" as const,
        reclaimed: (fake.reclaim ?? { reclaimed: true }).reclaimed,
        remainingNosBaseUnits: 0n,
      };
    },
  };
  return { port, fake };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

async function makeApp(opts: {
  db: ReturnType<typeof makeDb>;
  nosana?: ReturnType<typeof makeNosana>;
  authed?: boolean;
  submitCalls?: unknown[][];
  webhooks?: Array<[string, string]>;
  /** Run the real submitToNosana (against the fake port) instead of recording the call. */
  realSubmit?: boolean;
  /** The deployment's measured latency; omitted = no sample table behind the fake database. */
  loadScopedLatency?: (window: any) => Promise<any>;
}) {
  const nosana = opts.nosana ?? makeNosana();
  const mod = await import("../routes/deployments.js");
  // index.ts installs this globally; Fastify cannot serialise the BigInt
  // reservation columns without it.
  (await import("../lib/bigintJson.js")).installBigIntJsonSerializer();
  const app = Fastify();
  // index.ts registers @fastify/sensible (reply.notFound / badRequest ...).
  await app.register((await import("@fastify/sensible")).default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = { userId: "user_1", orgId: "org_1", type: "jwt" };
    }
  });
  await app.register(
    mod.createDeploymentRoutes({
      prisma: opts.db.prisma as never,
      getNosana: async () => nosana.port as never,
      triggerWebhook: (async (orgId: string, event: string) => {
        opts.webhooks?.push([orgId, event]);
      }) as never,
      now: () => T_NOW,
      ...(opts.loadScopedLatency ? { loadScopedLatency: opts.loadScopedLatency } : {}),
      ...(opts.realSubmit
        ? {}
        : {
            submit: async (...args: unknown[]) => {
              opts.submitCalls?.push(args);
            },
          }),
    }),
  );
  return { app, nosana };
}

const running = (over: Partial<Dep> = {}): Partial<Dep> & { id: string } => ({
  id: "dep_1",
  status: "running",
  reservationCents: HOUR_4090_CENTS,
  billedThroughAt: T_CURSOR,
  ...over,
});

// ============================================
// H: the endpoint
// ============================================

test("GET / returns OUR /v1 endpoint for running deployments, not a fabricated host or a node URL", async () => {
  const db = makeDb({
    deployments: [
      running({ id: "a", slug: "alpha" }),
      { id: "b", slug: "beta", status: "provisioning" },
    ],
    nodes: [
      { id: "n1", deploymentId: "a", nosanaNodeId: "x", nodeUrl: "https://secret.node.nos.ci", healthStatus: "healthy", latencyMs: 5 },
    ],
  });
  const { app } = await makeApp({ db });
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const byId = Object.fromEntries(body.deployments.map((d: any) => [d.id, d]));
  assert.equal(byId.a.endpoint, "https://api.example.test/v1/alpha/chat/completions", "PUBLIC_API_URL + /v1/<slug>/chat/completions, no double slash");
  assert.equal(byId.b.endpoint, null, "not running -> no endpoint");
  assert.ok(!JSON.stringify(body).includes("api.wheelsai.io"), "the fabricated host is gone");
  assert.ok(!JSON.stringify(body).includes("secret.node.nos.ci"), "raw node URLs are never exposed");
  assert.equal(byId.a.healthyNodes, 1);
});

test("GET /:id returns the endpoint and withholds raw node URLs", async () => {
  const db = makeDb({
    deployments: [running()],
    nodes: [
      { id: "n1", deploymentId: "dep_1", nosanaNodeId: "x", nodeUrl: "https://secret.node.nos.ci", healthStatus: "healthy", latencyMs: 5 },
    ],
  });
  const { app } = await makeApp({ db });
  const res = await app.inject({ method: "GET", url: "/dep_1" });
  assert.equal(res.statusCode, 200);
  const { deployment } = res.json();
  assert.equal(deployment.endpoint, "https://api.example.test/v1/my-model/chat/completions");
  assert.equal(deployment.nodes.length, 1);
  assert.equal(deployment.nodes[0].nodeUrl, undefined);
  assert.equal(deployment.nodes[0].healthStatus, "healthy");
});

test("GET /:id answers with a complete config even when the stored row lacks a key", async () => {
  // Rows written before the create route filled these in, or by a script.
  const db = makeDb({ deployments: [running({ config: { maxModelLen: 8192 } })] });
  const { app } = await makeApp({ db });
  const { deployment } = (await app.inject({ method: "GET", url: "/dep_1" })).json();
  assert.deepEqual(deployment.config, { maxTokens: 4096, gpuMemoryUtilization: 0.9, maxModelLen: 8192 });

  const stored = makeDb({ deployments: [running({ config: { maxTokens: 2048, gpuMemoryUtilization: 0.8 } })] });
  const res = await (await makeApp({ db: stored })).app.inject({ method: "GET", url: "/dep_1" });
  assert.deepEqual(res.json().deployment.config, { maxTokens: 2048, gpuMemoryUtilization: 0.8 });
});

test("deployments are tenant-scoped: another org's id is a 404", async () => {
  const db = makeDb({ deployments: [running({ orgId: "org_other" })] });
  const { app } = await makeApp({ db });
  for (const [method, url] of [
    ["GET", "/dep_1"],
    ["DELETE", "/dep_1"],
    ["POST", "/dep_1/restart"],
    ["GET", "/dep_1/logs"],
  ] as const) {
    const res = await app.inject({ method, url });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
  }
});

test("unauthenticated requests are 401", async () => {
  const db = makeDb({ deployments: [running()] });
  const { app } = await makeApp({ db, authed: false });
  assert.equal((await app.inject({ method: "DELETE", url: "/dep_1" })).statusCode, 401);
});

// ============================================
// POST /  - create (pre-flight BEFORE money moves)
// ============================================

const createBody = { name: "My Model", modelId: "model_1", gpuTier: "4090", replicas: 1 };

test("POST / on an unconfigured platform answers 501 and reserves NO credits", async () => {
  const { NosanaNotConfiguredError } = await import("../services/nosana.js");
  const db = makeDb({});
  const nosana = makeNosana({ assertError: new NosanaNotConfiguredError() });
  const { app } = await makeApp({ db, nosana });

  const res = await app.inject({ method: "POST", url: "/", payload: createBody });

  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, "nosana_not_configured");
  assert.equal(db.state.deployments.length, 0, "no row");
  assert.equal(db.state.balances.org_1, 10_000n, "no reservation");
  assert.equal(db.state.ledger.length, 0);
});

test("POST / for a tier with no configured market is an honest 501; an unknown tier is a 400", async () => {
  const { MarketNotConfiguredError } = await import("../services/nosana.js");
  const db = makeDb({});

  const unconfigured = makeNosana({
    assertError: new MarketNotConfiguredError("4090", "devnet", "market_not_configured"),
  });
  const a = await makeApp({ db, nosana: unconfigured });
  const r1 = await a.app.inject({ method: "POST", url: "/", payload: createBody });
  assert.equal(r1.statusCode, 501);
  assert.equal(r1.json().error, "gpu_market_not_configured");
  assert.match(r1.json().message, /market for tier 4090 is not configured/);

  const unknown = makeNosana({
    assertError: new MarketNotConfiguredError("9999", "mainnet", "unknown_tier"),
  });
  const b = await makeApp({ db, nosana: unknown });
  const r2 = await b.app.inject({ method: "POST", url: "/", payload: { ...createBody, gpuTier: "9999" } });
  assert.equal(r2.statusCode, 400);
  assert.equal(db.state.deployments.length, 0);
  assert.equal(db.state.balances.org_1, 10_000n);
});

test("POST / creates the row, takes the reservation, and hands the submit the real tier + config", async () => {
  const db = makeDb({});
  const submitCalls: unknown[][] = [];
  const webhooks: Array<[string, string]> = [];
  const { app } = await makeApp({ db, submitCalls, webhooks });

  const res = await app.inject({ method: "POST", url: "/", payload: { ...createBody, replicas: 2 } });

  assert.equal(res.statusCode, 201);
  const row = db.state.deployments[0]!;
  assert.equal(row.status, "pending");
  assert.deepEqual(row.nosanaJobIds, [], "no Nosana id until the submit really happened");
  assert.equal(row.reservationCents, HOUR_4090_CENTS * 2n);
  assert.equal(db.state.balances.org_1, 10_000n - HOUR_4090_CENTS * 2n);
  assert.deepEqual(db.state.ledger.map((l) => [l.type, l.referenceId]), [["deployment_reservation", row.id]]);
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0]![0], row.id);
  assert.equal((submitCalls[0]![1] as any).hfModelId, "meta-llama/Meta-Llama-3.1-8B-Instruct");
  assert.equal(submitCalls[0]![2], "4090");
  assert.equal(submitCalls[0]![3], 2);
  assert.equal(submitCalls[0]![4], 0, "the first run of a new row");
  assert.deepEqual(webhooks, [["org_1", "deployment.started"]]);
});

test("POST / with too few credits is a 402 and leaves no row behind", async () => {
  const db = makeDb({ balances: { org_1: 10n } });
  const { app } = await makeApp({ db });
  const res = await app.inject({ method: "POST", url: "/", payload: createBody });
  assert.equal(res.statusCode, 402);
  assert.equal(db.state.deployments.length, 0);
  assert.equal(db.state.balances.org_1, 10n);
});

// ============================================
// F: stop releases the reservation exactly once
// ============================================

test("DELETE stops Nosana, marks stopped, releases the reservation once and settles the final GPU window", async () => {
  const db = makeDb({
    deployments: [running()],
    nodes: [{ id: "n1", deploymentId: "dep_1", nosanaNodeId: "x", nodeUrl: "https://a.node.nos.ci", healthStatus: "healthy", latencyMs: 1 }],
    balances: { org_1: 1000n },
  });
  const webhooks: Array<[string, string]> = [];
  const { app, nosana } = await makeApp({ db, webhooks });

  const res = await app.inject({ method: "DELETE", url: "/dep_1" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().message, "Deployment stopped");
  assert.deepEqual(nosana.fake.calls.map((c) => [c.op, c.args[0]]), [["stopDeployment", "dm_1"]]);

  const row = db.state.deployments[0]!;
  assert.equal(row.status, "stopped");
  assert.equal(row.statusReason, "user_stopped");
  assert.deepEqual(row.stoppedAt, T_NOW);
  assert.deepEqual(row.vaultReclaimedAt, T_NOW);
  assert.deepEqual(row.reservationReleasedAt, T_NOW);
  assert.equal(db.state.nodes.length, 0);

  // +90 (hold released) then the final 100 s window: ceil(250 x 100 = 25,000 uUSD = 2.5) = 3 cents.
  assert.deepEqual(
    db.state.ledger.map((l) => [l.type, l.amountCents]),
    [
      ["deployment_reservation_release", 90n],
      ["gpu_usage", -3n],
    ],
  );
  assert.equal(db.state.balances.org_1, 1000n + 90n - 3n);
  assert.deepEqual(webhooks, [["org_1", "deployment.stopped"]]);
});

test("stopping twice (or concurrently) releases the reservation EXACTLY once", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  const { app } = await makeApp({ db });

  const [a, b] = await Promise.all([
    app.inject({ method: "DELETE", url: "/dep_1" }),
    app.inject({ method: "DELETE", url: "/dep_1" }),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  const third = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(third.statusCode, 200);
  assert.equal(third.json().message, "Deployment already stopped");

  const releases = db.state.ledger.filter((l) => l.type === "deployment_reservation_release");
  assert.equal(releases.length, 1, "one refund");
  const charges = db.state.ledger.filter((l) => l.type === "gpu_usage");
  assert.equal(charges.length, 1, "the final window is billed once");
  assert.equal(db.state.balances.org_1, 1000n + 90n - 3n);
});

test("if Nosana will not confirm the stop the row is left running, nothing is released, and the caller gets a 502", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  const nosana = makeNosana({ stopError: new Error("nosana 503") });
  const { app } = await makeApp({ db, nosana });

  const res = await app.inject({ method: "DELETE", url: "/dep_1" });

  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "nosana_stop_failed");
  const row = db.state.deployments[0]!;
  assert.equal(row.status, "running", "a running GPU must not be hidden behind a 'stopped' row");
  assert.equal(row.reservationReleasedAt, null);
  assert.equal(db.state.balances.org_1, 1000n);
  assert.equal(db.state.ledger.length, 0);
});

test("a stop whose vault withdraw is still pending leaves vaultReclaimedAt null for the status worker", async () => {
  const db = makeDb({ deployments: [running()] });
  const nosana = makeNosana({ stopResult: { reclaimed: false } });
  const { app } = await makeApp({ db, nosana });
  const res = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().vaultReclaimed, false);
  assert.equal(db.state.deployments[0]!.vaultReclaimedAt, null);
  assert.equal(db.state.deployments[0]!.status, "stopped");
});

test("stopping a deployment that never reached Nosana skips the stop and still releases the hold", async () => {
  const db = makeDb({
    deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }],
    balances: { org_1: 1000n },
  });
  const { app, nosana } = await makeApp({ db });
  const res = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(nosana.fake.calls, [], "nothing to stop on Nosana");
  assert.equal(db.state.deployments[0]!.status, "stopped");
  assert.equal(db.state.balances.org_1, 1000n + 90n);
});

test("a stopped deployment's status tick release and a later DELETE cannot double-refund", async () => {
  // The status worker (or anyone else) already stopped + released it.
  const db = makeDb({
    deployments: [running({ status: "stopped", reservationReleasedAt: T_NOW })],
    balances: { org_1: 1000n },
  });
  const { app, nosana } = await makeApp({ db });
  const res = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().message, "Deployment already stopped");
  assert.deepEqual(nosana.fake.calls, []);
  assert.equal(db.state.balances.org_1, 1000n);
});

// ============================================
// F: restart guard + fresh reservation
// ============================================

test("restart REFUSES unless the deployment is stopped or failed", async () => {
  for (const status of ["running", "provisioning", "pending", "degraded"]) {
    const db = makeDb({ deployments: [running({ status })], balances: { org_1: 1000n } });
    const submitCalls: unknown[][] = [];
    const { app } = await makeApp({ db, submitCalls });

    const res = await app.inject({ method: "POST", url: "/dep_1/restart" });

    assert.equal(res.statusCode, 409, status);
    assert.equal(res.json().error, "deployment_not_restartable");
    assert.equal(submitCalls.length, 0, `${status}: nothing submitted`);
    const row = db.state.deployments[0]!;
    assert.deepEqual(row.nosanaJobIds, ["dm_1"], `${status}: the running Nosana deployment is NOT orphaned`);
    assert.equal(row.status, status);
    assert.equal(db.state.balances.org_1, 1000n, `${status}: no money moved`);
  }
});

test("restarting a stopped deployment takes a FRESH reservation, resets the run state and submits", async () => {
  const db = makeDb({
    deployments: [
      running({
        status: "stopped",
        stoppedAt: T_NOW,
        statusReason: "user_stopped",
        reservationCents: HOUR_4090_CENTS,
        reservationReleasedAt: new Date("2026-09-30T11:00:00.000Z"), // released when it stopped
        billedThroughAt: T_CURSOR,
        vaultReclaimedAt: T_NOW,
      }),
    ],
    balances: { org_1: 1000n },
  });
  const submitCalls: unknown[][] = [];
  const { app } = await makeApp({ db, submitCalls });

  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });

  assert.equal(res.statusCode, 200);
  const row = db.state.deployments[0]!;
  assert.equal(row.status, "pending");
  assert.deepEqual(row.nosanaJobIds, [], "the new run gets a new Nosana id");
  assert.equal(row.stoppedAt, null);
  assert.equal(row.statusReason, null);
  assert.equal(row.billedThroughAt, null, "billing restarts when the new run is observed");
  assert.equal(row.reservationReleasedAt, null, "the new hold is live");
  assert.equal(row.reservationCents, HOUR_4090_CENTS);
  assert.equal(db.state.balances.org_1, 1000n - HOUR_4090_CENTS, "a fresh hour reserved");
  assert.deepEqual(db.state.ledger.map((l) => l.type), ["deployment_reservation"]);
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0]![0], "dep_1");
  assert.equal(submitCalls[0]![2], "4090");
  assert.equal(row.runGeneration, 1, "a restart is a new run of the row");
  assert.equal(submitCalls[0]![4], 1, "and its submit is tied to that run");
});

test("restart refunds a previous hold that was never released instead of overwriting it", async () => {
  const db = makeDb({
    deployments: [running({ status: "failed", reservationCents: 50n, reservationReleasedAt: null, vaultReclaimedAt: T_NOW })],
    balances: { org_1: 1000n },
  });
  const { app } = await makeApp({ db });
  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    db.state.ledger.map((l) => [l.type, l.amountCents]),
    [
      ["deployment_reservation_release", 50n],
      ["deployment_reservation", -HOUR_4090_CENTS],
    ],
  );
  assert.equal(db.state.balances.org_1, 1000n + 50n - HOUR_4090_CENTS);
});

test("restart with insufficient credits is a 402 and changes NOTHING (the claim rolls back)", async () => {
  const db = makeDb({
    deployments: [running({ status: "stopped", reservationReleasedAt: T_NOW, vaultReclaimedAt: T_NOW })],
    balances: { org_1: 10n },
  });
  const submitCalls: unknown[][] = [];
  const { app } = await makeApp({ db, submitCalls });

  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });

  assert.equal(res.statusCode, 402);
  const row = db.state.deployments[0]!;
  assert.equal(row.status, "stopped", "still restartable later");
  assert.deepEqual(row.nosanaJobIds, ["dm_1"]);
  assert.equal(db.state.balances.org_1, 10n);
  assert.equal(submitCalls.length, 0);
});

test("restart re-checks the per-org quota", async () => {
  const db = makeDb({
    deployments: [
      running({ id: "dep_1", status: "stopped", slug: "s1", vaultReclaimedAt: T_NOW, reservationReleasedAt: T_NOW }),
      { id: "a", slug: "a", status: "running" },
      { id: "b", slug: "b", status: "provisioning" },
    ],
    balances: { org_1: 1000n },
  });
  const { app } = await makeApp({ db });
  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, "deployment_quota_exceeded");
  assert.equal(db.state.deployments[0]!.status, "stopped");
});

test("restart waits for the previous run's vault: unreclaimed + cannot reclaim => 409, nothing forgotten", async () => {
  const db = makeDb({
    deployments: [running({ status: "stopped", vaultReclaimedAt: null, reservationReleasedAt: T_NOW })],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana({ reclaim: { reclaimed: false } });
  const { app } = await makeApp({ db, nosana });

  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "previous_run_winding_down");
  assert.deepEqual(db.state.deployments[0]!.nosanaJobIds, ["dm_1"], "the id holding the funds is kept");
  assert.equal(db.state.deployments[0]!.status, "stopped");
});

test("restart proceeds once the previous vault is reclaimed", async () => {
  const db = makeDb({
    deployments: [running({ status: "stopped", vaultReclaimedAt: null, reservationReleasedAt: T_NOW })],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana({ reclaim: { reclaimed: true } });
  const { app } = await makeApp({ db, nosana });
  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });
  assert.equal(res.statusCode, 200);
  assert.ok(nosana.fake.calls.some((c) => c.op === "reclaimDeploymentVault" && c.args[0] === "dm_1"));
});

test("two concurrent restarts: only one claims the row, one reservation is taken", async () => {
  const db = makeDb({
    deployments: [running({ status: "stopped", vaultReclaimedAt: T_NOW, reservationReleasedAt: T_NOW })],
    balances: { org_1: 1000n },
  });
  const submitCalls: unknown[][] = [];
  const { app } = await makeApp({ db, submitCalls });

  const results = await Promise.all([
    app.inject({ method: "POST", url: "/dep_1/restart" }),
    app.inject({ method: "POST", url: "/dep_1/restart" }),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(submitCalls.length, 1);
  assert.equal(db.state.balances.org_1, 1000n - HOUR_4090_CENTS, "one hold, not two");
});

test("restart on an unconfigured platform is a 501 and changes nothing", async () => {
  const { NosanaNotConfiguredError } = await import("../services/nosana.js");
  const db = makeDb({
    deployments: [running({ status: "stopped", vaultReclaimedAt: T_NOW, reservationReleasedAt: T_NOW })],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana({ assertError: new NosanaNotConfiguredError() });
  const { app } = await makeApp({ db, nosana });
  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });
  assert.equal(res.statusCode, 501);
  assert.equal(db.state.deployments[0]!.status, "stopped");
  assert.equal(db.state.balances.org_1, 1000n);
});

// ============================================
// F: PATCH replicas really scales
// ============================================

test("PATCH replicas is refused (409) unless the deployment is running", async () => {
  for (const status of ["pending", "provisioning", "stopped", "failed", "degraded"]) {
    const db = makeDb({ deployments: [running({ status })] });
    const { app, nosana } = await makeApp({ db });
    const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } });
    assert.equal(res.statusCode, 409, status);
    assert.equal(res.json().error, "deployment_not_running");
    assert.equal(db.state.deployments[0]!.replicas, 1, `${status}: the DB-only lie is gone`);
    assert.deepEqual(nosana.fake.calls, []);
  }
});

test("PATCH scale-up: holds credits for the ADDED replicas, scales Nosana, then persists", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  const { app, nosana } = await makeApp({ db });

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(nosana.fake.calls.map((c) => [c.op, ...c.args]), [["scaleDeployment", "dm_1", 3, "4090"]]);
  const row = db.state.deployments[0]!;
  assert.equal(row.replicas, 3);
  assert.equal(row.reservationCents, HOUR_4090_CENTS * 3n, "the stored hold follows the replica count");
  // The 100 s window at the OLD count (100 s x 250 uUSD = 2.5 cents) is charged
  // in whole cents before Nosana is called (2), only the 2 added replicas are
  // reserved, and the commit closes what is left of the window at the old count
  // (rounded up: 1). Leaving that remainder on the cursor - as this test used to
  // pin - had the next tick bill it at the NEW count.
  assert.equal(db.state.balances.org_1, 1000n - 2n - HOUR_4090_CENTS * 2n - 1n);
  assert.deepEqual(db.state.ledger.map((l) => [l.type, l.amountCents]), [
    ["gpu_usage", -2n],
    ["deployment_reservation", -HOUR_4090_CENTS * 2n],
    ["gpu_usage", -1n],
  ]);
  assert.deepEqual(row.billedThroughAt, T_NOW, "nothing of the old-count window is left for the new count");
  assert.equal(row.replicaChangeId, null, "the claim is resolved");
  assert.equal(row.pendingReplicas, null);
});

test("PATCH scale-up without enough credits is a 402 and never reaches Nosana", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 100n } });
  const { app, nosana } = await makeApp({ db });
  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } });
  assert.equal(res.statusCode, 402);
  assert.deepEqual(nosana.fake.calls, []);
  assert.equal(db.state.deployments[0]!.replicas, 1);
  assert.equal(db.state.deployments[0]!.reservationCents, HOUR_4090_CENTS);
  assert.equal(db.state.balances.org_1, 100n);
});

test("PATCH scale-up that Nosana refuses rolls the replica count AND the hold back", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  const nosana = makeNosana({ scaleError: new Error("vault has no funds") });
  const { app } = await makeApp({ db, nosana });

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } });

  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "nosana_scale_failed");
  const row = db.state.deployments[0]!;
  assert.equal(row.replicas, 1, "unchanged");
  assert.equal(row.reservationCents, HOUR_4090_CENTS, "hold back to what it was");
  // the added hold came back; the 2-cent window at the old count stays billed (it was really used)
  assert.equal(db.state.balances.org_1, 998n, "the org got the added hold back");
});

test("PATCH scale-down scales Nosana first, then returns the proportional hold", async () => {
  const db = makeDb({
    deployments: [running({ replicas: 3, reservationCents: HOUR_4090_CENTS * 3n })],
    balances: { org_1: 1000n },
  });
  const { app, nosana } = await makeApp({ db });

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 1 } });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(nosana.fake.calls.map((c) => [c.op, ...c.args]), [["scaleDeployment", "dm_1", 1, "4090"]]);
  const row = db.state.deployments[0]!;
  assert.equal(row.replicas, 1);
  assert.equal(row.reservationCents, HOUR_4090_CENTS);
  // 100 s at 3 replicas (75,000 uUSD = 7.5 cents) at the OLD count: 7 whole cents
  // before Nosana is called, the remaining half cent rounded up when the change
  // commits (so none of it is billed at the new count), then 2 replicas' hold returned.
  assert.equal(db.state.balances.org_1, 1000n - 7n - 1n + HOUR_4090_CENTS * 2n);
  assert.deepEqual(db.state.ledger.map((l) => [l.type, l.amountCents]), [
    ["gpu_usage", -7n],
    ["gpu_usage", -1n],
    ["deployment_reservation_release", HOUR_4090_CENTS * 2n],
  ]);
  assert.deepEqual(row.billedThroughAt, T_NOW);
});

test("PATCH scale-down that Nosana refuses changes nothing", async () => {
  const db = makeDb({
    deployments: [running({ replicas: 3, reservationCents: HOUR_4090_CENTS * 3n })],
    balances: { org_1: 1000n },
  });
  // Nosana still runs 3: the route asks it what a failed call left behind.
  const nosana = makeNosana({ scaleError: new Error("api down"), replicas: 3 });
  const { app } = await makeApp({ db, nosana });
  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 1 } });
  assert.equal(res.statusCode, 502);
  assert.equal(db.state.deployments[0]!.replicas, 3, "the claim is reverted");
  assert.equal(db.state.deployments[0]!.reservationCents, HOUR_4090_CENTS * 3n, "the hold was never touched");
  assert.equal(db.state.balances.org_1, 1000n - 7n, "only the settled window (really used) was billed");
});

test("PATCH with an unchanged replica count touches neither Nosana nor the ledger", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  const { app, nosana } = await makeApp({ db });
  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 1 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(nosana.fake.calls, []);
  assert.equal(db.state.ledger.length, 0);
});

test("PATCH config is stored for the next restart and says so", async () => {
  const db = makeDb({ deployments: [running()] });
  const { app, nosana } = await makeApp({ db });
  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { config: { maxTokens: 2048 } } });
  assert.equal(res.statusCode, 200);
  assert.equal((db.state.deployments[0]!.config as any).maxTokens, 2048);
  assert.match(res.json().note, /restart/i);
  assert.deepEqual(nosana.fake.calls, []);
});

// ============================================
// F: logs are real events or an honest error
// ============================================

test("GET logs returns the REAL Nosana deployment events, newest last, limited to `lines`", async () => {
  const events = Array.from({ length: 30 }, (_, i) => ({
    type: i === 29 ? "JOB_FAILED" : "JOB_EXTENDED",
    message: `event ${i}`,
    createdAt: new Date(Date.UTC(2026, 8, 30, 10, i)).toISOString(),
  }));
  const db = makeDb({ deployments: [running()] });
  const nosana = makeNosana({ events: [...events].reverse() }); // unordered on purpose
  const { app } = await makeApp({ db, nosana });

  const res = await app.inject({ method: "GET", url: "/dep_1/logs?lines=10" });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.source, "nosana_deployment_events");
  assert.equal(body.logs.length, 10);
  assert.equal(body.logs[9].message, "event 29", "chronological, most recent last");
  assert.equal(body.logs[9].level, "error");
  assert.equal(body.logs[0].level, "info");
  assert.ok(!JSON.stringify(body).includes("Logs will be available when deployment is running"), "the placeholder line is gone");
  assert.deepEqual(nosana.fake.calls.map((c) => c.op), ["getDeploymentStatus"]);
});

test("GET logs with no events is an empty list - never a fake line", async () => {
  const db = makeDb({ deployments: [running()] });
  const { app } = await makeApp({ db, nosana: makeNosana({ events: [] }) });
  const res = await app.inject({ method: "GET", url: "/dep_1/logs" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().logs, []);
});

test("GET logs for a deployment that never reached Nosana is empty, not fabricated", async () => {
  const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [] }] });
  const { app, nosana } = await makeApp({ db });
  const res = await app.inject({ method: "GET", url: "/dep_1/logs" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().logs, []);
  assert.deepEqual(nosana.fake.calls, []);
});

test("GET logs: a Nosana outage is a 502, a mock deployment is a 501 logs_not_available", async () => {
  const db = makeDb({ deployments: [running()] });
  const down = await makeApp({ db, nosana: makeNosana({ statusError: new Error("503") }) });
  assert.equal((await down.app.inject({ method: "GET", url: "/dep_1/logs" })).statusCode, 502);

  const mockDb = makeDb({ deployments: [running({ nosanaJobIds: ["mock_deploy_abc"] })] });
  const mock = await makeApp({ db: mockDb });
  const res = await mock.app.inject({ method: "GET", url: "/dep_1/logs" });
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, "logs_not_available");
});

// ============================================
// submitToNosana (the create/restart background step)
// ============================================

async function runSubmit(
  db: ReturnType<typeof makeDb>,
  nosana: ReturnType<typeof makeNosana>,
  replicas = 1,
  runGeneration = 0,
) {
  const { submitToNosana } = await import("../routes/deployments.js");
  return submitToNosana(
    { prisma: db.prisma as never, getNosana: async () => nosana.port as never, now: () => T_NOW },
    "dep_1",
    {
      modelId: "model_1",
      hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      engine: "vllm",
      maxTokens: 4096,
      gpuMemoryUtilization: 0.9,
    },
    "4090",
    replicas,
    runGeneration,
  );
}

test("submit: stores the Nosana Deployment-Manager id, stays provisioning, creates NO fabricated node", async () => {
  const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }] });
  const nosana = makeNosana();

  await runSubmit(db, nosana);

  const row = db.state.deployments[0]!;
  assert.equal(row.status, "provisioning", "running is only ever OBSERVED by the status worker");
  assert.deepEqual(row.nosanaJobIds, ["dm_new"]);
  assert.equal(db.state.nodes.length, 0, "no node until Nosana reports an endpoint");

  const create = nosana.fake.calls.find((c) => c.op === "createDeployment")!;
  const definition = create.args[0] as any;
  assert.equal(create.args[1], "4090");
  assert.equal(definition.ops[0].args.env.HF_TOKEN, "hf_test_token", "real token, not the literal placeholder");
  assert.notEqual(definition.ops[0].args.env.HF_TOKEN, "${HF_TOKEN}");
});

test("submit failure: the row is failed with the reason, the hold is released, the error is rethrown", async () => {
  const db = makeDb({
    deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana({ createError: new Error("400 invalid job definition") });

  await assert.rejects(() => runSubmit(db, nosana), /invalid job definition/);

  const row = db.state.deployments[0]!;
  assert.equal(row.status, "failed");
  assert.match(row.statusReason ?? "", /invalid job definition/);
  assert.deepEqual(row.stoppedAt, T_NOW);
  assert.deepEqual(row.reservationReleasedAt, T_NOW);
  assert.equal(db.state.balances.org_1, 1000n + HOUR_4090_CENTS);
});

test("submit failure AFTER the Nosana deployment was created persists its id so the vault can be reclaimed", async () => {
  const { NosanaLifecycleError } = await import("../services/nosanaDeploymentLifecycle.js");
  const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }] });

  // cleanup reclaimed => vaultReclaimedAt recorded; not reclaimed => left null for the sweep
  for (const reclaimed of [true, false]) {
    const fresh = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }] });
    const err = new NosanaLifecycleError("start failed", "start", {
      deploymentId: "dm_partial",
      cleanup: { stopped: true, reclaimed, errors: [] },
    });
    await assert.rejects(() => runSubmit(fresh, makeNosana({ createError: err })));
    const row = fresh.state.deployments[0]!;
    assert.equal(row.status, "failed");
    assert.deepEqual(row.nosanaJobIds, ["dm_partial"], "the id holding platform funds is kept");
    assert.deepEqual(row.vaultReclaimedAt, reclaimed ? T_NOW : null);
    assert.match(row.statusReason ?? "", /nosana_start_failed/);
  }
  void db;
});

test("submit does not revive a deployment that was stopped before it started", async () => {
  const db = makeDb({ deployments: [{ id: "dep_1", status: "stopped", nosanaJobIds: [] }] });
  const nosana = makeNosana();
  await runSubmit(db, nosana);
  assert.deepEqual(nosana.fake.calls, [], "never created on Nosana");
  assert.equal(db.state.deployments[0]!.status, "stopped");
});

test("submit: a stop that lands DURING the submit stops the freshly created Nosana deployment", async () => {
  const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }] });
  const nosana = makeNosana();
  // The user stops the row while createDeployment is in flight.
  const realCreate = nosana.port.createDeployment;
  nosana.port.createDeployment = async (...args: unknown[]) => {
    const created = await (realCreate as any)(...args);
    db.state.deployments[0]!.status = "stopped";
    return created;
  };

  await runSubmit(db, nosana);

  assert.ok(nosana.fake.calls.some((c) => c.op === "stopDeployment" && c.args[0] === "dm_new"), "the orphan is stopped");
  const row = db.state.deployments[0]!;
  assert.equal(row.status, "stopped", "not revived");
  assert.deepEqual(row.nosanaJobIds, ["dm_new"], "id recorded so the vault is reclaimed");
  assert.deepEqual(row.vaultReclaimedAt, T_NOW);
});

// ============================================
// Review #4: concurrent replica changes cannot leave Nosana and the row disagreeing
// ============================================


/**
 * Makes the first `n` reads of the deployment row wait for each other, so `n`
 * concurrent requests all observe the SAME starting state before any of them
 * writes - a real race, not two sequential requests.
 */
function readBarrier(db: ReturnType<typeof makeDb>, n: number) {
  const inner = db.prisma.deployment.findFirst;
  let waiting = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  (db.prisma.deployment as any).findFirst = async (args: any) => {
    const row = await inner(args);
    if (waiting < n) {
      waiting += 1;
      if (waiting === n) release();
      await gate;
    }
    return row;
  };
}

test("two concurrent scale-downs (4 -> 2 and 4 -> 3): ONE wins, the other is a 409 and never reaches Nosana (review #4)", async () => {
  // Before: Nosana was scaled first and a lost DB CAS still answered 200, so the
  // loser left Nosana at 3 while the row said 2.
  const db = makeDb({
    deployments: [running({ replicas: 4, reservationCents: HOUR_4090_CENTS * 4n })],
    balances: { org_1: 1000n },
  });
  const { app, nosana } = await makeApp({ db });
  readBarrier(db, 2); // both requests read replicas=4 before either claims

  const [a, b] = await Promise.all([
    app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 2 } }),
    app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } }),
  ]);

  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  const scaled = nosana.fake.calls.filter((c) => c.op === "scaleDeployment");
  assert.equal(scaled.length, 1, "Nosana is scaled exactly once");
  const winner = a.statusCode === 200 ? 2 : 3;
  assert.equal(scaled[0]!.args[1], winner);
  assert.equal(db.state.deployments[0]!.replicas, winner, "the row and Nosana agree");
  assert.equal(
    db.state.deployments[0]!.reservationCents,
    HOUR_4090_CENTS * BigInt(winner),
    "the hold follows the winner only",
  );
});

test("scale-down: a lost claim is a 409 and Nosana is untouched (review #4)", async () => {
  const db = makeDb({
    deployments: [running({ replicas: 4, reservationCents: HOUR_4090_CENTS * 4n })],
    balances: { org_1: 1000n },
  });
  const { app, nosana } = await makeApp({ db });
  // Another PATCH moved the row between this request's read and its claim.
  const inner = db.prisma.deployment.findFirst;
  (db.prisma.deployment as any).findFirst = async (args: any) => {
    const row = await inner(args);
    db.state.deployments[0]!.replicas = 3;
    return row; // the request still sees 4
  };

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 2 } });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "deployment_conflict");
  assert.deepEqual(nosana.fake.calls, []);
  assert.equal(db.state.deployments[0]!.replicas, 3, "untouched by the loser");
});

test("two concurrent scale-ups: one wins, one 409, one hold and one Nosana call", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 5000n } });
  const { app, nosana } = await makeApp({ db });
  readBarrier(db, 2);
  const [a, b] = await Promise.all([
    app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 2 } }),
    app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.equal(nosana.fake.calls.filter((c) => c.op === "scaleDeployment").length, 1);
  const winner = a.statusCode === 200 ? 2 : 3;
  assert.equal(db.state.deployments[0]!.replicas, winner);
  assert.equal(db.state.ledger.filter((l) => l.type === "deployment_reservation").length, 1);
});

// ============================================
// Review #6: a replica change settles the window at the OLD replica count first
// ============================================

test("a replica change settles the GPU window at the OLD count, inside the change, and advances the cursor (review #6)", async () => {
  const db = makeDb({
    deployments: [running({ replicas: 2, reservationCents: HOUR_4090_CENTS * 2n })],
    balances: { org_1: 1000n },
  });
  const { app } = await makeApp({ db });
  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 1 } });
  assert.equal(res.statusCode, 200);
  // 100 s x 2 replicas x 250 uUSD = 50,000 uUSD = 5 cents at the OLD count of 2
  const usage = db.state.ledger.filter((l) => l.type === "gpu_usage");
  assert.deepEqual(usage.map((l) => l.amountCents), [-5n]);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, T_NOW, "5 cents cover exactly the 100 s");
});

test("an org that cannot pay the outstanding GPU time is refused (402) and nothing changes (review #6)", async () => {
  const db = makeDb({ deployments: [running({ replicas: 2, reservationCents: HOUR_4090_CENTS * 2n })], balances: { org_1: 2n } });
  const { app, nosana } = await makeApp({ db });
  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 1 } }); // owes 5 cents, has 2
  assert.equal(res.statusCode, 402);
  assert.match(res.json().message, /GPU time used so far/);
  assert.deepEqual(nosana.fake.calls, []);
  assert.equal(db.state.deployments[0]!.replicas, 2);
  assert.equal(db.state.balances.org_1, 2n, "rolled back");
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, T_CURSOR, "cursor rolled back with it");
});

test("the settle CAS is tied to the replica count: a billing tick holding the old count loses after the change (review #6)", async () => {
  const db = makeDb({ deployments: [running({ replicas: 1 })], balances: { org_1: 5000n } });
  const { app } = await makeApp({ db });
  await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 2 } });
  // a tick that loaded replicas=1 before the PATCH now tries to bill the window
  const { chargeGpuWindow } = await import("../services/gpuBilling.js");
  const row = db.state.deployments[0]!;
  const out = await (db.prisma as any).$transaction((tx: any) =>
    chargeGpuWindow(tx, {
      deploymentId: "dep_1", orgId: "org_1", gpuTier: "4090", replicas: 1,
      billedThroughAt: row.billedThroughAt!, now: new Date(T_NOW.getTime() + 60_000),
      mode: "tick", pricePerSecondUsd: () => 0.00025,
    }),
  );
  assert.deepEqual(out, { kind: "cursor_lost" });
});

// ============================================
// Review #5: stopping from degraded bills nothing for the degraded stretch
// ============================================

test("DELETE from `degraded` does NOT final-bill (the cursor is stale; the degrade edge already settled) (review #5)", async () => {
  const db = makeDb({
    deployments: [running({ status: "degraded", billedThroughAt: new Date(T_NOW.getTime() - 3_600_000) })], // degraded an hour ago
    balances: { org_1: 1000n },
  });
  const { app } = await makeApp({ db });
  const res = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(res.statusCode, 200);
  assert.equal(db.state.deployments[0]!.status, "stopped");
  assert.equal(db.state.ledger.filter((l) => l.type === "gpu_usage").length, 0, "an hour with no endpoint is not billed");
  // the hold is still released
  assert.equal(db.state.balances.org_1, 1000n + HOUR_4090_CENTS);
});

test("DELETE from `running` still final-bills the tail; from provisioning/pending there is no cursor to bill", async () => {
  const running1 = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  await (await makeApp({ db: running1 })).app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(running1.state.ledger.filter((l) => l.type === "gpu_usage").length, 1);

  for (const status of ["provisioning", "pending"]) {
    const db = makeDb({ deployments: [{ id: "dep_1", status, billedThroughAt: null, reservationCents: HOUR_4090_CENTS }], balances: { org_1: 1000n } });
    await (await makeApp({ db })).app.inject({ method: "DELETE", url: "/dep_1" });
    assert.equal(db.state.ledger.filter((l) => l.type === "gpu_usage").length, 0, status);
  }
});

test("DELETE final-bills with the replica count read FRESH (a PATCH after the request read the row)", async () => {
  const db = makeDb({
    deployments: [running({ replicas: 1 })],
    balances: { org_1: 1000n },
  });
  const { app } = await makeApp({ db });
  // the request reads replicas=1, then the row becomes 2 before the stop transaction
  const inner = db.prisma.deployment.findFirst;
  (db.prisma.deployment as any).findFirst = async (args: any) => {
    const row = await inner(args);
    db.state.deployments[0]!.replicas = 2;
    return row;
  };
  await app.inject({ method: "DELETE", url: "/dep_1" });
  // 100 s x 2 replicas x 250 uUSD = 5 cents (the stale snapshot would bill 3)
  assert.deepEqual(db.state.ledger.filter((l) => l.type === "gpu_usage").map((l) => l.amountCents), [-5n]);
});

// ============================================
// Review #3: the stop route stamps vaultReclaimedAt explicitly
// ============================================

test("DELETE writes vaultReclaimedAt explicitly: null when the withdraw is pending, even over a stale stamp (review #3)", async () => {
  const db = makeDb({ deployments: [running({ vaultReclaimedAt: new Date("2026-01-01T00:00:00.000Z") })] });
  const nosana = makeNosana({ stopResult: { reclaimed: false } });
  const { app } = await makeApp({ db, nosana });
  await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(db.state.deployments[0]!.vaultReclaimedAt, null, "the stale stamp is cleared so the sweep retries");
});

// ============================================
// Review #2 (route side): the submit-failure refund is status-guarded
// ============================================

test("a late submit-failure refund cannot claim the live hold of a restarted run (review #2)", async () => {
  // The submit failed and marked the row failed; before its best-effort refund
  // runs, the user restarts: the row is `pending` again with a NEW live hold
  // (restart resets reservationReleasedAt to null for it). Without the terminal
  // status guard the refund's CAS {releasedAt: null} matched and refunded the
  // NEW run's hold.
  const db = makeDb({
    deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }],
    balances: { org_1: 1000n },
  });
  const inner = db.prisma.deployment.findUnique;
  let restarted = false;
  (db.prisma.deployment as any).findUnique = async (args: any) => {
    const row = await inner(args);
    if (!restarted && args.select?.reservationCents) {
      restarted = true; // the refund has just read the row ...
      db.state.deployments[0]!.status = "pending"; // ... and the restart lands
    }
    return row;
  };

  await assert.rejects(() => runSubmitOnly(db, makeNosana({ createError: new Error("boom") })));

  assert.equal(restarted, true);
  assert.equal(db.state.deployments[0]!.reservationReleasedAt, null, "the new run's hold is untouched");
  assert.equal(db.state.balances.org_1, 1000n, "nothing was refunded");
  assert.equal(db.state.ledger.filter((l) => l.type === "deployment_reservation_release").length, 0);
});

test("refundDeploymentReservation's CAS carries the terminal-status guard", async () => {
  const db = makeDb({
    deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }],
    balances: { org_1: 1000n },
  });
  const wheres: any[] = [];
  const inner = db.prisma.deployment.updateMany;
  (db.prisma.deployment as any).updateMany = async (args: any) => {
    wheres.push(args.where);
    return inner(args);
  };
  const { submitToNosana } = await import("../routes/deployments.js");
  await assert.rejects(() =>
    submitToNosana(
      { prisma: db.prisma as never, getNosana: async () => makeNosana({ createError: new Error("x") }).port as never, now: () => T_NOW },
      "dep_1",
      { modelId: "model_1", hfModelId: "x", engine: "vllm", maxTokens: 4096, gpuMemoryUtilization: 0.9 },
      "4090",
      1,
      0,
    ),
  );
  const release = wheres.find((w) => w.reservationReleasedAt === null);
  assert.deepEqual(release.status, { in: ["stopped", "failed"] });
});

// ============================================
// Review #10: the orphan cleanup cannot write into a restarted run
// ============================================

test("submit: a row RESTARTED during a slow createDeployment is not handed the orphan's id (review #10)", async () => {
  // The user stops, then restarts (status pending again, nosanaJobIds reset to
  // []) while createDeployment is still in flight. Its CAS {id, ids isEmpty}
  // alone matched the NEW run; it must also require a terminal row.
  const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }] });
  const nosana = makeNosana();
  const realCreate = nosana.port.createDeployment;
  nosana.port.createDeployment = async (...args: unknown[]) => {
    const created = await (realCreate as any)(...args);
    // stop ...
    db.state.deployments[0]!.status = "stopped";
    // ... and a fast restart that lands before the orphan cleanup runs
    const inner = nosana.port.stopDeployment;
    nosana.port.stopDeployment = async (id: string) => {
      const r = await inner(id);
      db.state.deployments[0]!.status = "pending"; // restarted: ids still []
      return r;
    };
    return created;
  };

  await runSubmitOnly(db, nosana);

  assert.ok(nosana.fake.calls.some((c) => c.op === "stopDeployment" && c.args[0] === "dm_new"), "the orphan IS stopped");
  assert.deepEqual(db.state.deployments[0]!.nosanaJobIds, [], "the restarted run does NOT inherit the orphan's id");
  assert.equal(db.state.deployments[0]!.vaultReclaimedAt, null);
});

async function runSubmitOnly(db: ReturnType<typeof makeDb>, nosana: ReturnType<typeof makeNosana>) {
  const { submitToNosana } = await import("../routes/deployments.js");
  return submitToNosana(
    { prisma: db.prisma as never, getNosana: async () => nosana.port as never, now: () => T_NOW },
    "dep_1",
    { modelId: "model_1", hfModelId: "x", engine: "vllm", maxTokens: 4096, gpuMemoryUtilization: 0.9 },
    "4090",
    1,
    0,
  );
}

// ============================================
// Restarted runs: a row is reused for a new Nosana deployment, so every write
// that can land late names the run (runGeneration) it belongs to
// ============================================

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets fire-and-forget work (the background submit) run to completion. */
const settle = async () => {
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
};

/** What a stop followed by a restart leaves on the row: a new run, pending, no id yet. */
function restartRow(row: Dep, over: Partial<Dep> = {}) {
  Object.assign(row, {
    status: "pending",
    runGeneration: row.runGeneration + 1,
    nosanaJobIds: [],
    vaultReclaimedAt: null,
    stoppedAt: null,
    statusReason: null,
    billedThroughAt: null,
    reservationCents: HOUR_4090_CENTS,
    reservationReleasedAt: null,
    ...over,
  });
}

test("stop + restart during a slow createDeployment: each run keeps its OWN Nosana id, and the old one is stopped and kept for the sweep", async () => {
  // The whole sequence through the real routes and the real submitToNosana.
  const db = makeDb({ balances: { org_1: 1000n } });
  const nosana = makeNosana({ stopResult: { reclaimed: false } }); // withdraw still pending after the stop
  const firstCreate = deferred();
  let creates = 0;
  nosana.port.createDeployment = async (...args: unknown[]) => {
    nosana.fake.calls.push({ op: "createDeployment", args });
    creates += 1;
    if (creates === 1) {
      await firstCreate.promise; // run 1's create is slow ...
      return { id: "dm_run1", market: "M", replicas: 1, status: "active" as const, endpoints: [] };
    }
    return { id: "dm_run2", market: "M", replicas: 1, status: "active" as const, endpoints: [] };
  };
  const { app } = await makeApp({ db, nosana, realSubmit: true });

  const created = await app.inject({
    method: "POST",
    url: "/",
    payload: { name: "My Model", modelId: "model_1", gpuTier: "4090" },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().deployment.id;
  await settle();
  assert.equal(creates, 1, "submit #1 is inside createDeployment");

  // ... long enough for the user to stop the row (no Nosana id yet) and restart it.
  assert.equal((await app.inject({ method: "DELETE", url: `/${id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/${id}/restart` })).statusCode, 200);
  await settle();
  const row = db.state.deployments[0]!;
  assert.deepEqual(row.nosanaJobIds, ["dm_run2"], "run 2 submitted");
  assert.equal(row.runGeneration, 1);

  firstCreate.resolve();
  await settle();

  assert.deepEqual(row.nosanaJobIds, ["dm_run2"], "run 1's id is NOT written onto run 2's row");
  assert.equal(row.status, "provisioning", "run 2 is untouched");
  assert.equal(row.reservationReleasedAt, null, "run 2 keeps its hold");
  assert.equal(db.state.balances.org_1, 1000n - HOUR_4090_CENTS, "exactly one live hold");
  assert.ok(
    nosana.fake.calls.some((c) => c.op === "stopDeployment" && c.args[0] === "dm_run1"),
    "run 1's Nosana deployment is stopped",
  );
  assert.ok(
    !nosana.fake.calls.some((c) => c.op === "stopDeployment" && c.args[0] === "dm_run2"),
    "run 2's is not",
  );
  assert.deepEqual(
    db.state.orphans.map((o) => [o.nosanaDeploymentId, o.sourceKind, o.sourceId]),
    [["dm_run1", "model", id]],
    "its vault still holds funds, so the id is recorded for the vault sweep, not dropped",
  );
});

test("the reverse order: the new run stores its id first, the old submit still cannot overwrite it", async () => {
  const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }] });
  const nosana = makeNosana();
  const realCreate = nosana.port.createDeployment;
  nosana.port.createDeployment = async (...args: unknown[]) => {
    const made = await (realCreate as any)(...args);
    // stop + restart, and run 2 has already stored its id and is live
    restartRow(db.state.deployments[0]!, { status: "running", nosanaJobIds: ["dm_run2"] });
    return made;
  };

  await runSubmit(db, nosana, 1, 0);

  const row = db.state.deployments[0]!;
  assert.deepEqual(row.nosanaJobIds, ["dm_run2"]);
  assert.equal(row.status, "running");
  assert.ok(nosana.fake.calls.some((c) => c.op === "stopDeployment" && c.args[0] === "dm_new"));
  assert.deepEqual(db.state.orphans, [], "stopped and drained (the fake reclaims): nothing left to track");
});

test("a submit only ever claims its own run: a stale generation never reaches Nosana", async () => {
  const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", runGeneration: 3, nosanaJobIds: [] }] });
  const nosana = makeNosana();
  await runSubmit(db, nosana, 1, 2);
  assert.deepEqual(nosana.fake.calls, []);
  assert.equal(db.state.deployments[0]!.status, "pending", "left for run 3's own submit");
});

test("an old submit's FAILURE cannot fail the restarted run, refund its hold, or lose the old Nosana id", async () => {
  const { NosanaLifecycleError } = await import("../services/nosanaDeploymentLifecycle.js");
  const db = makeDb({
    deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana({ stopResult: { reclaimed: false } });
  nosana.port.createDeployment = async () => {
    restartRow(db.state.deployments[0]!, { status: "provisioning" }); // run 2 is submitting
    throw new NosanaLifecycleError("topup failed", "topup", {
      deploymentId: "dm_run1",
      cleanup: { stopped: false, reclaimed: false, errors: ["stop: timeout"] },
    });
  };

  await assert.rejects(() => runSubmit(db, nosana, 1, 0), /topup failed/);

  const row = db.state.deployments[0]!;
  assert.equal(row.status, "provisioning", "run 2 is not marked failed with run 1's reason");
  assert.equal(row.statusReason, null);
  assert.deepEqual(row.nosanaJobIds, [], "nor handed run 1's id");
  assert.equal(row.reservationReleasedAt, null, "run 2's live hold is not refunded");
  assert.equal(db.state.balances.org_1, 1000n);
  assert.deepEqual(db.state.ledger, []);
  assert.ok(
    nosana.fake.calls.some((c) => c.op === "stopDeployment" && c.args[0] === "dm_run1"),
    "the cleanup's stop had failed, so it is stopped now",
  );
  assert.deepEqual(db.state.orphans.map((o) => o.nosanaDeploymentId), ["dm_run1"]);
});

test("the submit-failure refund is tied to the run: a restarted run that has itself gone terminal is not refunded by the old submit", async () => {
  const db = makeDb({
    deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana();
  nosana.port.createDeployment = async () => {
    // Run 2 already failed on its own; its writer owns its release.
    restartRow(db.state.deployments[0]!, { status: "failed" });
    throw new Error("boom");
  };
  await assert.rejects(() => runSubmit(db, nosana, 1, 0));
  assert.equal(db.state.deployments[0]!.reservationReleasedAt, null);
  assert.equal(db.state.balances.org_1, 1000n);
});

test("a stop during a FAILING create: the partial Nosana id is kept on the stopped row so the sweep stops and reclaims it", async () => {
  const { NosanaLifecycleError } = await import("../services/nosanaDeploymentLifecycle.js");
  for (const cleanupStopped of [false, true]) {
    const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }] });
    const nosana = makeNosana({ stopError: new Error("DM unreachable") });
    nosana.port.createDeployment = async () => {
      // The user's DELETE: the row had no id, so nothing was stopped on Nosana.
      Object.assign(db.state.deployments[0]!, { status: "stopped", stoppedAt: T_NOW, reservationReleasedAt: T_NOW });
      throw new NosanaLifecycleError("start failed", "start", {
        deploymentId: "dm_partial",
        cleanup: { stopped: cleanupStopped, reclaimed: false, errors: [] },
      });
    };

    await assert.rejects(() => runSubmit(db, nosana, 1, 0));

    const row = db.state.deployments[0]!;
    assert.equal(row.status, "stopped", "the user's stop stands");
    assert.deepEqual(row.nosanaJobIds, ["dm_partial"], "the id is not lost");
    assert.equal(row.vaultReclaimedAt, null, "so the vault sweep picks the row up");
    assert.equal(
      nosana.fake.calls.filter((c) => c.op === "stopDeployment").length,
      cleanupStopped ? 0 : 1,
      "a stop is attempted only when the cleanup's did not land",
    );
    assert.deepEqual(db.state.orphans, [], "tracked on its own row");
  }
});

test("orphan cleanup whose row was restarted meanwhile: the id goes to the orphan record instead of being dropped", async () => {
  const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }] });
  const nosana = makeNosana({ stopResult: { reclaimed: false } });
  const realCreate = nosana.port.createDeployment;
  const realStop = nosana.port.stopDeployment;
  nosana.port.createDeployment = async (...args: unknown[]) => {
    const made = await (realCreate as any)(...args);
    db.state.deployments[0]!.status = "stopped"; // stopped during the create ...
    return made;
  };
  nosana.port.stopDeployment = async (nosanaId: string) => {
    const stop = await realStop(nosanaId);
    restartRow(db.state.deployments[0]!); // ... and restarted during the orphan's stop
    return stop;
  };

  await runSubmit(db, nosana, 1, 0);

  assert.deepEqual(db.state.deployments[0]!.nosanaJobIds, [], "the new run does not inherit it");
  assert.deepEqual(db.state.orphans.map((o) => [o.nosanaDeploymentId, o.reason]), [["dm_new", "stopped_during_submit"]]);
});

test("orphan cleanup whose stop FAILS records the id for the sweep even on its own stopped row", async () => {
  const db = makeDb({ deployments: [{ id: "dep_1", status: "pending", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }] });
  const nosana = makeNosana({ stopError: new Error("DM unreachable") });
  const realCreate = nosana.port.createDeployment;
  nosana.port.createDeployment = async (...args: unknown[]) => {
    const made = await (realCreate as any)(...args);
    db.state.deployments[0]!.status = "stopped";
    return made;
  };
  await runSubmit(db, nosana, 1, 0);
  const row = db.state.deployments[0]!;
  assert.deepEqual(row.nosanaJobIds, ["dm_new"]);
  assert.equal(row.vaultReclaimedAt, null, "the sweep stops a deployment that is terminal here but running on Nosana");
});

test("DELETE whose Nosana stop outlives a stop + restart does NOT stop, stamp or un-hold the restarted run", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  const nosana = makeNosana();
  const slowStop = deferred();
  const realStop = nosana.port.stopDeployment;
  let stops = 0;
  nosana.port.stopDeployment = async (nosanaId: string) => {
    stops += 1;
    if (stops === 1) await slowStop.promise;
    return realStop(nosanaId);
  };
  const submitCalls: unknown[][] = [];
  const { app } = await makeApp({ db, nosana, submitCalls });

  const slow = app.inject({ method: "DELETE", url: "/dep_1" }); // request A, stuck in Nosana
  await settle();
  assert.equal((await app.inject({ method: "DELETE", url: "/dep_1" })).statusCode, 200); // the retry wins
  assert.equal((await app.inject({ method: "POST", url: "/dep_1/restart" })).statusCode, 200);
  const row = db.state.deployments[0]!;
  // Run 2's submit stored its Nosana id.
  Object.assign(row, { status: "provisioning", nosanaJobIds: ["dm_run2"] });
  const balanceBefore = db.state.balances.org_1;
  const ledgerBefore = db.state.ledger.length;

  slowStop.resolve();
  const res = await slow;

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "deployment_conflict");
  assert.equal(row.status, "provisioning", "run 2 was never stopped on Nosana and must not be marked stopped");
  assert.deepEqual(row.nosanaJobIds, ["dm_run2"]);
  assert.equal(row.vaultReclaimedAt, null, "run 1's vault result is not stamped on run 2 (it would hide it from the sweep)");
  assert.equal(row.statusReason, null);
  assert.equal(row.reservationReleasedAt, null, "run 2 keeps its hold");
  assert.equal(db.state.balances.org_1, balanceBefore);
  assert.equal(db.state.ledger.length, ledgerBefore);
});

test("DELETE that loses to another writer of the SAME run is idempotent and records the vault reclaim it verified", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  const nosana = makeNosana();
  const realStop = nosana.port.stopDeployment;
  nosana.port.stopDeployment = async (nosanaId: string) => {
    const stop = await realStop(nosanaId);
    // The status worker observed the stop first: terminal, vault not yet stamped.
    Object.assign(db.state.deployments[0]!, { status: "stopped", stoppedAt: T_NOW, statusReason: "nosana_stopped", vaultReclaimedAt: null });
    return stop;
  };
  const webhooks: Array<[string, string]> = [];
  const { app } = await makeApp({ db, nosana, webhooks });

  const res = await app.inject({ method: "DELETE", url: "/dep_1" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().message, "Deployment already stopped");
  const row = db.state.deployments[0]!;
  assert.equal(row.statusReason, "nosana_stopped", "the winner's write stands");
  assert.deepEqual(row.vaultReclaimedAt, T_NOW, "stamped by a CAS naming this run and this Nosana id");
  assert.deepEqual(webhooks, [], "the loser announces nothing");
});

test("DELETE of a row that had no Nosana id when read does not mark it stopped once a submit has stored one", async () => {
  const db = makeDb({
    deployments: [{ id: "dep_1", status: "provisioning", nosanaJobIds: [], reservationCents: HOUR_4090_CENTS }],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana();
  const { app } = await makeApp({ db, nosana });
  const inner = db.prisma.deployment.findFirst;
  let raced = false;
  (db.prisma.deployment as any).findFirst = async (args: any) => {
    const row = await inner(args);
    if (!raced) {
      raced = true; // the submit's `stored` write lands right after this read
      db.state.deployments[0]!.nosanaJobIds = ["dm_new"];
    }
    return row;
  };

  const res = await app.inject({ method: "DELETE", url: "/dep_1" });

  assert.equal(res.statusCode, 409, "stopping it now would skip Nosana entirely");
  assert.equal(db.state.deployments[0]!.status, "provisioning");
  assert.equal(db.state.deployments[0]!.reservationReleasedAt, null);

  // The retry reads the id and really stops it.
  const retry = await app.inject({ method: "DELETE", url: "/dep_1" });
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(nosana.fake.calls.map((c) => [c.op, c.args[0]]), [["stopDeployment", "dm_new"]]);
  assert.equal(db.state.deployments[0]!.status, "stopped");
});

test("restart cannot forget a Nosana id that was recorded after it read the row (409, then the retry reclaims it first)", async () => {
  const db = makeDb({
    deployments: [running({ status: "stopped", nosanaJobIds: [], reservationReleasedAt: T_NOW })],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana();
  const submitCalls: unknown[][] = [];
  const { app } = await makeApp({ db, nosana, submitCalls });
  const inner = db.prisma.deployment.findFirst;
  let raced = false;
  (db.prisma.deployment as any).findFirst = async (args: any) => {
    const row = await inner(args);
    if (!raced) {
      raced = true; // the orphan cleanup of the previous submit records its id now
      db.state.deployments[0]!.nosanaJobIds = ["dm_run1"];
    }
    return row;
  };

  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });

  assert.equal(res.statusCode, 409);
  assert.deepEqual(db.state.deployments[0]!.nosanaJobIds, ["dm_run1"], "not reset to []");
  assert.equal(db.state.deployments[0]!.status, "stopped");
  assert.equal(db.state.balances.org_1, 1000n, "the claim rolled back: no hold taken");
  assert.equal(submitCalls.length, 0);
  assert.ok(!nosana.fake.calls.some((c) => c.op === "reclaimDeploymentVault"));

  const retry = await app.inject({ method: "POST", url: "/dep_1/restart" });
  assert.equal(retry.statusCode, 200);
  assert.ok(
    nosana.fake.calls.some((c) => c.op === "reclaimDeploymentVault" && c.args[0] === "dm_run1"),
    "the vault is reclaimed BEFORE its id is forgotten",
  );
});

test("a restart whose vault check outlived another restart cannot discard the newer run's unreclaimed id", async () => {
  const db = makeDb({
    deployments: [running({ status: "stopped", nosanaJobIds: ["dm_X"], vaultReclaimedAt: null, reservationReleasedAt: T_NOW })],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana();
  const realReclaim = nosana.port.reclaimDeploymentVault;
  nosana.port.reclaimDeploymentVault = async (nosanaId: string) => {
    const out = await realReclaim(nosanaId);
    // Meanwhile restart R2 won, created dm_Y, and failed with its vault unreclaimed.
    restartRow(db.state.deployments[0]!, {
      status: "failed",
      nosanaJobIds: ["dm_Y"],
      reservationReleasedAt: T_NOW,
    });
    return out;
  };
  const submitCalls: unknown[][] = [];
  const { app } = await makeApp({ db, nosana, submitCalls });

  const res = await app.inject({ method: "POST", url: "/dep_1/restart" });

  assert.equal(res.statusCode, 409);
  const row = db.state.deployments[0]!;
  assert.deepEqual(row.nosanaJobIds, ["dm_Y"], "dm_Y still holds funds and is still on the row");
  assert.equal(row.status, "failed");
  assert.equal(row.runGeneration, 1);
  assert.equal(submitCalls.length, 0);
});

// ============================================
// A replica change is a claim: `replicas` moves only once Nosana confirmed it
// ============================================

/** Bills one tick-mode window for dep_1 at the given replica count, as the GPU billing worker would. */
async function billTick(db: ReturnType<typeof makeDb>, replicas: number, now: Date) {
  const { chargeGpuWindow } = await import("../services/gpuBilling.js");
  const row = db.state.deployments[0]!;
  return (db.prisma as any).$transaction((tx: any) =>
    chargeGpuWindow(tx, {
      deploymentId: row.id, orgId: row.orgId, gpuTier: row.gpuTier, replicas,
      billedThroughAt: row.billedThroughAt!, now, mode: "tick", pricePerSecondUsd: () => 0.00025,
    }),
  );
}

/** A Nosana fake whose scaleDeployment stays open until `open.resolve()`. */
function slowScale(over: Partial<NosanaFake> = {}) {
  const open = deferred();
  const nosana = makeNosana({ onScale: () => open.promise, ...over });
  return { nosana, open };
}

test("an overlapping PATCH is a 409 while the first one's Nosana call is open, and billing keeps the CONFIRMED count until Nosana confirms", async () => {
  // Before: the claim wrote replicas=4 and released the row. A second PATCH then
  // claimed 4 -> 2, both answered 200, and the row said 2 while Nosana ran 4.
  const db = makeDb({
    deployments: [running({ replicas: 2, reservationCents: HOUR_4090_CENTS * 2n })],
    balances: { org_1: 5000n },
  });
  const { nosana, open } = slowScale({ replicas: 2 });
  const { app } = await makeApp({ db, nosana });
  const row = db.state.deployments[0]!;

  const first = app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 4 } });
  await settle();

  assert.equal(row.replicas, 2, "the confirmed count has not moved: Nosana has confirmed nothing");
  assert.equal(row.pendingReplicas, 4);
  assert.ok(row.replicaChangeId);

  for (const replicas of [3, 2, 4]) {
    const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas } });
    assert.equal(res.statusCode, 409, `PATCH {replicas: ${replicas}} during the open change`);
    assert.equal(res.json().error, "replica_change_in_progress");
  }
  assert.equal(nosana.fake.calls.filter((c) => c.op === "scaleDeployment").length, 1, "only the first reached Nosana");

  // A billing tick during the Nosana call bills what really runs (x2), and a
  // window computed at the unconfirmed count cannot land.
  assert.deepEqual(await billTick(db, 4, new Date(T_NOW.getTime() + 40_000)), { kind: "cursor_lost" });
  const billed = await billTick(db, 2, new Date(T_NOW.getTime() + 40_000));
  assert.equal(billed.kind, "charged");

  open.resolve();
  assert.equal((await first).statusCode, 200);
  assert.equal(row.replicas, 4);
  assert.equal(nosana.fake.replicas, 4, "the row and Nosana agree");
  assert.equal(row.reservationCents, HOUR_4090_CENTS * 4n);
  assert.equal(row.replicaChangeId, null);
  assert.equal(row.pendingReplicas, null);
  assert.equal(row.replicaChangeHoldCents, null);
});

test("a failed change only drops its own claim: it never restores a replica count (two overlapping requests, Nosana down)", async () => {
  // Before: A claimed 4 -> 2, B claimed 2 -> 3, A failed (its revert missed),
  // B failed and "restored" 2 - a count Nosana never ran. Both said "not changed".
  const db = makeDb({
    deployments: [running({ replicas: 4, reservationCents: HOUR_4090_CENTS * 4n })],
    balances: { org_1: 5000n },
  });
  const { nosana, open } = slowScale({ replicas: 4, scaleError: new Error("nosana timeout") });
  const { app } = await makeApp({ db, nosana });
  const row = db.state.deployments[0]!;

  const a = app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 2 } });
  await settle();
  const b = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } });
  assert.equal(b.statusCode, 409);
  assert.equal(b.json().error, "replica_change_in_progress");

  open.resolve();
  const resA = await a;
  assert.equal(resA.statusCode, 502);
  assert.equal(resA.json().error, "nosana_scale_failed");
  assert.equal(row.replicas, 4, "what Nosana runs");
  assert.equal(nosana.fake.replicas, 4);
  assert.equal(row.replicaChangeId, null, "the claim is gone, so the next change can be made");
  assert.equal(row.reservationCents, HOUR_4090_CENTS * 4n, "a scale-down never touched the hold");
  assert.equal(db.state.ledger.filter((l) => l.type !== "gpu_usage").length, 0);
});

test("scale-up that Nosana refuses: a tick during the call billed the OLD count, and exactly the claim's hold comes back", async () => {
  // Before: replicas=10 was committed first, the tick billed x10 for replicas
  // that never ran, and the rollback kept that charge.
  const db = makeDb({ deployments: [running()], balances: { org_1: 5000n } });
  const { nosana, open } = slowScale({ replicas: 1, scaleError: new Error("vault has no funds") });
  const { app } = await makeApp({ db, nosana });
  const row = db.state.deployments[0]!;

  const res = app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 10 } });
  await settle();
  assert.equal(row.replicaChangeHoldCents, HOUR_4090_CENTS * 9n, "the claim remembers the hold it took");
  assert.equal(row.reservationCents, HOUR_4090_CENTS * 10n);

  // T_CURSOR+80s (after the claim's settle) -> +40 s more at x1 = 1 cent, not 10.
  const tick = await billTick(db, 1, new Date(T_NOW.getTime() + 20_000));
  assert.equal(tick.kind, "charged");
  assert.equal(tick.cents, 1n);

  open.resolve();
  assert.equal((await res).statusCode, 502);
  assert.equal(row.replicas, 1);
  assert.equal(row.reservationCents, HOUR_4090_CENTS);
  assert.equal(row.replicaChangeId, null);
  // 2 cents at the claim + 1 cent by the tick, both at x1; the 9-replica hold is back.
  assert.equal(db.state.balances.org_1, 5000n - 2n - 1n);
});

test("a Nosana failure whose outcome cannot be read leaves the claim for the status worker: no guess, further changes refused", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 5000n } });
  const nosana = makeNosana({ scaleError: new Error("socket hang up"), statusError: new Error("api down") });
  const { app } = await makeApp({ db, nosana });
  const row = db.state.deployments[0]!;

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } });

  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "nosana_scale_unconfirmed");
  assert.equal(row.replicas, 1, "the confirmed count is not moved on a guess");
  assert.equal(row.pendingReplicas, 3);
  assert.ok(row.replicaChangeId, "the claim is kept for the reconciler");
  assert.equal(row.reservationCents, HOUR_4090_CENTS * 3n, "the hold stays until the outcome is known");

  const again = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 2 } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, "replica_change_in_progress");
});

test("a lost response: Nosana applied the count but the call threw - the change is committed, not reverted", async () => {
  // Before: any throw was a refusal. A scale-up then gave the hold back while
  // Nosana ran the extra replicas.
  const db = makeDb({ deployments: [running()], balances: { org_1: 5000n } });
  const nosana = makeNosana({ scaleError: new Error("response lost"), scaleAppliesBeforeError: true });
  const { app } = await makeApp({ db, nosana });

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } });

  assert.equal(res.statusCode, 200);
  const row = db.state.deployments[0]!;
  assert.equal(row.replicas, 3);
  assert.equal(nosana.fake.replicas, 3);
  assert.equal(row.reservationCents, HOUR_4090_CENTS * 3n);
  assert.equal(row.replicaChangeId, null);
});

test("when clearing a refused change fails, the row still holds the confirmed count and the claim - not a count Nosana never ran", async () => {
  // Before: replicas=10 was already committed, the rollback's DB error was
  // swallowed, the answer said "replicas were not changed", and every tick
  // billed x10 for a deployment running x1, with nothing to repair it.
  const db = makeDb({ deployments: [running()], balances: { org_1: 5000n } });
  const nosana = makeNosana({ scaleError: new Error("refused"), replicas: 1 });
  const { app } = await makeApp({ db, nosana });
  // The hold refund inside the clearing transaction fails; it rolls back whole.
  const realUpdate = db.prisma.creditBalance.update;
  (db.prisma.creditBalance as any).update = async () => {
    throw new Error("db down");
  };

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 10 } });
  (db.prisma.creditBalance as any).update = realUpdate;

  assert.equal(res.statusCode, 502);
  assert.match(res.json().message, /could not be cleared/);
  const row = db.state.deployments[0]!;
  assert.equal(row.replicas, 1, "billing keeps charging what Nosana runs");
  assert.equal(row.pendingReplicas, 10);
  assert.ok(row.replicaChangeId, "left for the status worker to resolve");
  assert.equal(row.replicaChangeHoldCents, HOUR_4090_CENTS * 9n, "and it knows how much to hand back");
});

test("a change that is refused after the run was stopped and restarted touches nothing of the new run", async () => {
  // Before: the revert matched {id, replicas} only, so it rewrote the new run's
  // count and refunded part of the new run's hold.
  const db = makeDb({ deployments: [running({ vaultReclaimedAt: null })], balances: { org_1: 5000n } });
  const { nosana, open } = slowScale({ replicas: 1, scaleError: new Error("refused") });
  const { app } = await makeApp({ db, nosana, submitCalls: [] });
  const row = db.state.deployments[0]!;

  const slow = app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } });
  await settle();
  assert.equal((await app.inject({ method: "DELETE", url: "/dep_1" })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/dep_1/restart" })).statusCode, 200);
  assert.equal(row.replicaChangeId, null, "the restart voids the previous run's claim");
  Object.assign(row, { status: "running", nosanaJobIds: ["dm_run2"], billedThroughAt: T_NOW });
  const before = { balance: db.state.balances.org_1, hold: row.reservationCents, ledger: db.state.ledger.length };

  open.resolve();
  assert.equal((await slow).statusCode, 502);
  assert.equal(row.replicas, 1);
  assert.equal(row.reservationCents, before.hold, "the new run's hold is its own");
  assert.equal(db.state.balances.org_1, before.balance);
  assert.equal(db.state.ledger.length, before.ledger);
});

test("a change Nosana applied after the run was stopped and restarted is not committed onto the new run (409)", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 5000n } });
  const { nosana, open } = slowScale({ replicas: 1 });
  const { app } = await makeApp({ db, nosana, submitCalls: [] });
  const row = db.state.deployments[0]!;

  const slow = app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 3 } });
  await settle();
  await app.inject({ method: "DELETE", url: "/dep_1" });
  await app.inject({ method: "POST", url: "/dep_1/restart" });
  Object.assign(row, { status: "running", nosanaJobIds: ["dm_run2"], billedThroughAt: T_NOW });
  const before = { balance: db.state.balances.org_1, hold: row.reservationCents };

  open.resolve();
  const res = await slow;
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "deployment_conflict");
  assert.equal(row.replicas, 1, "run 2 was submitted with 1 replica");
  assert.equal(row.reservationCents, before.hold);
  assert.equal(db.state.balances.org_1, before.balance);
});

test("a window worth less than a cent is still closed at the OLD count when the change commits", async () => {
  // Before: 30 s x1 (0.75 cents) floored to nothing, the cursor stayed, and the
  // next tick billed those 30 s at x10.
  const db = makeDb({
    deployments: [running({ billedThroughAt: new Date(T_NOW.getTime() - 30_000) })],
    balances: { org_1: 5000n },
  });
  const { app } = await makeApp({ db });

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 10 } });

  assert.equal(res.statusCode, 200);
  const row = db.state.deployments[0]!;
  assert.deepEqual(db.state.ledger.filter((l) => l.type === "gpu_usage").map((l) => l.amountCents), [-1n]);
  assert.deepEqual(row.billedThroughAt, T_NOW, "the x10 rate starts at the change, not 30 s before it");
});

test("a degraded deployment's pending change commits without billing: it has no open window", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 5000n } });
  const { nosana, open } = slowScale({ replicas: 1 });
  const { app } = await makeApp({ db, nosana });
  const row = db.state.deployments[0]!;

  const slow = app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 2 } });
  await settle();
  const cursor = row.billedThroughAt;
  const usage = db.state.ledger.filter((l) => l.type === "gpu_usage").length;
  row.status = "degraded"; // the status worker saw the endpoints go (and settled the edge)

  open.resolve();
  assert.equal((await slow).statusCode, 200);
  assert.equal(row.replicas, 2);
  assert.equal(db.state.ledger.filter((l) => l.type === "gpu_usage").length, usage);
  assert.deepEqual(row.billedThroughAt, cursor);
});

// ============================================
// Stop: the final window ends when the GPUs stopped
// ============================================

test("DELETE of a row that recovers to `running` inside the stop transaction still final-bills it", async () => {
  // Before: the fallback claim covered every stoppable status, so a row the
  // status worker moved degraded -> running between the two claims was stopped
  // as "was not running" and the time since recovery was never billed.
  const db = makeDb({
    deployments: [running({ status: "degraded", billedThroughAt: new Date(T_NOW.getTime() - 3_600_000) })],
    balances: { org_1: 1000n },
  });
  const { app } = await makeApp({ db });
  const row = db.state.deployments[0]!;
  const realUpdateMany = db.prisma.deployment.updateMany;
  let recovered = false;
  (db.prisma.deployment as any).updateMany = async (args: any) => {
    const out = await realUpdateMany(args);
    if (!recovered && args.where.status === "running" && args.data.status === "stopped" && out.count === 0) {
      recovered = true; // the status tick commits degraded -> running, cursor reset
      Object.assign(row, { status: "running", billedThroughAt: T_CURSOR });
    }
    return out;
  };

  const res = await app.inject({ method: "DELETE", url: "/dep_1" });

  assert.equal(res.statusCode, 200);
  assert.equal(row.status, "stopped");
  // 100 s since recovery x 250 uUSD = 2.5 cents, final (rounded up) = 3.
  assert.deepEqual(db.state.ledger.filter((l) => l.type === "gpu_usage").map((l) => l.amountCents), [-3n]);
});

test("DELETE records when the GPUs stopped; a retry after a failed stop transaction bills up to THAT time, not its own clock", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  const { app, nosana } = await makeApp({ db });
  const row = db.state.deployments[0]!;
  // Attempt 1: Nosana stops, then the stop transaction fails.
  const realTx = db.prisma.$transaction;
  (db.prisma as any).$transaction = async () => {
    throw new Error("pool timeout");
  };
  assert.equal((await app.inject({ method: "DELETE", url: "/dep_1" })).statusCode, 500);
  (db.prisma as any).$transaction = realTx;
  assert.equal(row.status, "running", "the row was left as it was");
  assert.deepEqual(row.gpuStoppedAt, T_NOW, "but the confirmed stop time survived the failed transaction");
  assert.equal(db.state.ledger.length, 0);

  // The retry comes ten minutes later and finds Nosana already stopped.
  nosana.fake.alreadyStopped = true;
  const mod = await import("../routes/deployments.js");
  const later = Fastify();
  await later.register((await import("@fastify/sensible")).default);
  later.decorateRequest("auth", null);
  later.addHook("onRequest", async (request) => {
    request.auth = { userId: "user_1", orgId: "org_1", type: "jwt" };
  });
  await later.register(
    mod.createDeploymentRoutes({
      prisma: db.prisma as never,
      getNosana: async () => nosana.port as never,
      triggerWebhook: (async () => {}) as never,
      now: () => new Date(T_NOW.getTime() + 600_000),
    }),
  );
  assert.equal((await later.inject({ method: "DELETE", url: "/dep_1" })).statusCode, 200);

  assert.equal(row.status, "stopped");
  // 100 s (cursor -> the recorded stop) x 250 uUSD = 2.5 -> 3 cents; ten more
  // minutes would have been 18.
  assert.deepEqual(db.state.ledger.filter((l) => l.type === "gpu_usage").map((l) => l.amountCents), [-3n]);
});

test("DELETE of a deployment Nosana had already stopped at an unknown time bills nothing past the cursor", async () => {
  const db = makeDb({ deployments: [running()], balances: { org_1: 1000n } });
  const nosana = makeNosana({ alreadyStopped: true });
  const { app } = await makeApp({ db, nosana });

  assert.equal((await app.inject({ method: "DELETE", url: "/dep_1" })).statusCode, 200);

  const row = db.state.deployments[0]!;
  assert.equal(row.status, "stopped");
  assert.equal(row.gpuStoppedAt, null, "no stop time is invented");
  assert.equal(db.state.ledger.filter((l) => l.type === "gpu_usage").length, 0);
  assert.equal(db.state.balances.org_1, 1000n + HOUR_4090_CENTS, "the hold is still released");
});

test("restart clears the previous run's recorded GPU stop time", async () => {
  const db = makeDb({
    deployments: [running({ status: "stopped", stoppedAt: T_NOW, gpuStoppedAt: T_NOW, vaultReclaimedAt: T_NOW, reservationReleasedAt: T_NOW })],
    balances: { org_1: 1000n },
  });
  const { app } = await makeApp({ db, submitCalls: [] });
  assert.equal((await app.inject({ method: "POST", url: "/dep_1/restart" })).statusCode, 200);
  assert.equal(db.state.deployments[0]!.gpuStoppedAt, null);
});

test("a commit that fails after Nosana applied the change leaves the claim for the status worker, with nothing half-written", async () => {
  const db = makeDb({
    deployments: [running({ replicas: 3, reservationCents: HOUR_4090_CENTS * 3n })],
    balances: { org_1: 1000n },
  });
  const nosana = makeNosana({ replicas: 3 });
  const { app } = await makeApp({ db, nosana });
  // The scale-down's hold return, inside the commit transaction, fails.
  (db.prisma.creditBalance as any).update = async () => {
    throw new Error("db down");
  };

  const res = await app.inject({ method: "PATCH", url: "/dep_1", payload: { replicas: 1 } });

  assert.equal(res.statusCode, 500, "not a 200, and not 'replicas were not changed'");
  const row = db.state.deployments[0]!;
  assert.equal(nosana.fake.replicas, 1, "Nosana did scale");
  assert.equal(row.replicas, 3, "the commit rolled back whole: count, window and hold together");
  assert.equal(row.pendingReplicas, 1);
  assert.ok(row.replicaChangeId, "the claim marks the row for reconciliation from Nosana's real count");
  assert.equal(row.reservationCents, HOUR_4090_CENTS * 3n);
  // Only the claim's whole-cent settle at the old count (7) stands.
  assert.deepEqual(db.state.ledger.map((l) => [l.type, l.amountCents]), [["gpu_usage", -7n]]);
});

// ============================================
// Metrics: measured latency
// ============================================

test("metrics state no latency for a deployment nobody called: null, not 0 ms", async () => {
  const db = makeDb({ deployments: [running()] });
  const { app } = await makeApp({ db });
  const res = await app.inject({ method: "GET", url: "/dep_1/metrics" });
  assert.equal(res.statusCode, 200);
  const { metrics } = res.json();
  assert.equal(metrics.requests, 0);
  assert.deepEqual(
    [metrics.avgLatencyMs, metrics.p50LatencyMs, metrics.p95LatencyMs, metrics.latencySampleCount],
    [null, null, null, 0],
  );
});

test("metrics take avg, p50 and p95 from the deployment's own samples over the same 24 hours", async () => {
  const db = makeDb({ deployments: [running()] });
  const windows: any[] = [];
  const { app } = await makeApp({
    db,
    loadScopedLatency: async (window) => {
      windows.push(window);
      return { sampleCount: 41, avgMs: 930, p50Ms: 712, p95Ms: 2_480, p99Ms: 3_100 };
    },
  });
  const { metrics } = (await app.inject({ method: "GET", url: "/dep_1/metrics" })).json();
  assert.deepEqual(
    [metrics.avgLatencyMs, metrics.p50LatencyMs, metrics.p95LatencyMs, metrics.latencySampleCount],
    [930, 712, 2_480, 41],
  );
  assert.deepEqual(windows, [
    {
      orgId: "org_1",
      since: new Date(T_NOW.getTime() - 24 * 60 * 60 * 1000),
      until: T_NOW,
      outcomes: ["ok"],
      deploymentIds: ["dep_1"],
    },
  ]);
});

test("metrics of another organization's deployment are a 404 and read no samples", async () => {
  const db = makeDb({ deployments: [running({ orgId: "org_2" })] });
  let reads = 0;
  const { app } = await makeApp({
    db,
    loadScopedLatency: async () => {
      reads += 1;
      return { sampleCount: 9, avgMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1 };
    },
  });
  const res = await app.inject({ method: "GET", url: "/dep_1/metrics" });
  assert.equal(res.statusCode, 404);
  assert.equal(reads, 0);
});
