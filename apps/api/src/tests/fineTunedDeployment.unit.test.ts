import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import "./unitEnv.js";
import { signAdapterGrant, verifyAdapterGrant, type AdapterServingDeps } from "../services/fineTunedModels.js";
import { VLLM_ADAPTER_BOOTSTRAP } from "../services/nosana.js";

// POST /api/deployments with fineTunedModelId, and the restart of such a
// deployment: the refusals (all before anything is reserved), the adapter
// URL of each run, and that a deployment without one is exactly what it was.

const SECRET = "unit-test-signing-secret-0123456789";
const ORG = "org_1";
const MODEL_ID = "3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6a11";
const LLAMA_FT_ID = "3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6a22";
const THEIRS_ID = "3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6a33";
const DELETED_ID = "3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6a44";
const SHA = "ee9275b14e49b9cd6249454c034910294034f22b4c59d513c40de4692b1a7dd9";
const T_NOW = new Date("2026-10-07T12:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CATALOG: Record<string, { id: string; hfId: string; displayName: string; pricingTier: string; parameters: bigint; minGpuTier: string }> = {
  "phi-3-mini": {
    id: "phi-3-mini",
    hfId: "microsoft/Phi-3-mini-4k-instruct",
    displayName: "Phi-3 Mini",
    pricingTier: "small",
    parameters: 3_800_000_000n,
    minGpuTier: "3060",
  },
  "llama-3.1-8b": {
    id: "llama-3.1-8b",
    hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    displayName: "Llama 3.1 8B",
    pricingTier: "small",
    parameters: 8_000_000_000n,
    minGpuTier: "3060",
  },
};

function ftm(over: Record<string, unknown> = {}) {
  return {
    id: MODEL_ID,
    orgId: ORG,
    name: "Support tone",
    slug: "support-tone",
    liveSlug: "support-tone",
    baseModelId: "phi-3-mini",
    baseModelHfId: "microsoft/Phi-3-mini-4k-instruct",
    method: "lora",
    loraR: 16,
    adapterKey: "adapters/org_1/job/adapter.tar.gz",
    adapterBytes: 18_092_371n,
    adapterSha256: SHA,
    status: "ready",
    updatedAt: new Date("2026-10-06T10:00:00.000Z"),
    ...over,
  };
}

function makeDb(seed: { deployments?: any[]; models?: any[]; balance?: bigint } = {}) {
  const state = {
    deployments: (seed.deployments ?? []) as any[],
    models:
      seed.models ??
      [
        ftm(),
        ftm({
          id: LLAMA_FT_ID,
          slug: "llama-tone",
          liveSlug: "llama-tone",
          baseModelId: "llama-3.1-8b",
          baseModelHfId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
        }),
        ftm({ id: THEIRS_ID, orgId: "org_2", slug: "theirs", liveSlug: "theirs" }),
        ftm({ id: DELETED_ID, slug: "gone", liveSlug: null, status: "deleted" }),
      ],
    balances: { [ORG]: seed.balance ?? 10_000n } as Record<string, bigint>,
    ledger: [] as Array<{ type: string; amountCents: bigint; referenceId: string }>,
    fineTunedReads: 0,
    creates: [] as any[],
  };
  const hooks: { beforeLock?: () => void } = {};

  const matches = (d: any, where: any): boolean => {
    if (where.id !== undefined && d.id !== where.id) return false;
    if (where.orgId !== undefined && d.orgId !== where.orgId) return false;
    if (typeof where.status === "string" && d.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(d.status)) return false;
    if (where.runGeneration !== undefined && d.runGeneration !== where.runGeneration) return false;
    if (where.nosanaJobIds?.isEmpty === true && d.nosanaJobIds.length !== 0) return false;
    if (where.nosanaJobIds?.has !== undefined && !d.nosanaJobIds.includes(where.nosanaJobIds.has)) return false;
    if ("reservationReleasedAt" in where && d.reservationReleasedAt !== where.reservationReleasedAt) return false;
    return true;
  };
  const apply = (d: any, data: any) => {
    const { runGeneration, ...rest } = data;
    Object.assign(d, rest);
    if (typeof runGeneration === "number") d.runGeneration = runGeneration;
    else if (runGeneration?.increment) d.runGeneration += runGeneration.increment;
  };
  const withRelations = (d: any, include?: any) => {
    const out = { ...d };
    if (include?.model) out.model = CATALOG[d.modelId];
    if (include?.nodes) out.nodes = [];
    if (include?.fineTunedModel) {
      const m = state.models.find((x: any) => x.id === d.fineTunedModelId);
      out.fineTunedModel = m ? { id: m.id, name: m.name, slug: m.slug } : null;
    }
    return out;
  };
  const modelMatches = (m: any, where: any) =>
    (where.id === undefined || m.id === where.id) &&
    (where.orgId === undefined || m.orgId === where.orgId) &&
    (where.status === undefined || m.status === where.status);

  let seq = 0;
  const tx = {
    model: { findUnique: async ({ where }: any) => CATALOG[where.id] ?? null },
    fineTunedModel: {
      findFirst: async ({ where }: any) => {
        state.fineTunedReads += 1;
        const m = state.models.find((x: any) => modelMatches(x, where));
        return m ? { ...m, baseModel: CATALOG[m.baseModelId] } : null;
      },
      updateMany: async ({ where, data }: any) => {
        state.fineTunedReads += 1;
        hooks.beforeLock?.();
        let count = 0;
        for (const m of state.models) {
          if (modelMatches(m, where)) {
            Object.assign(m, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    deployment: {
      findMany: async ({ where, include }: any) =>
        state.deployments.filter((d) => matches(d, where)).map((d) => withRelations(d, include)),
      findFirst: async ({ where, include }: any) => {
        const d = state.deployments.find((x) => matches(x, where));
        return d ? withRelations(d, include) : null;
      },
      findUnique: async ({ where }: any) => {
        const d = where.orgId_slug
          ? state.deployments.find((x) => x.orgId === where.orgId_slug.orgId && x.slug === where.orgId_slug.slug)
          : state.deployments.find((x) => x.id === where.id);
        return d ? { ...d } : null;
      },
      count: async ({ where }: any) => state.deployments.filter((d) => matches(d, where)).length,
      create: async ({ data }: any) => {
        state.creates.push(data);
        const row = {
          id: `dep_new_${++seq}`,
          createdAt: T_NOW,
          updatedAt: T_NOW,
          stoppedAt: null,
          reservationCents: null,
          reservationReleasedAt: null,
          statusReason: null,
          vaultReclaimedAt: null,
          runGeneration: 0,
          fineTunedModelId: null,
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
        state.ledger.push({ type: data.type, amountCents: data.amountCents, referenceId: data.referenceId });
        return {};
      },
    },
    nosanaOrphanDeployment: { createMany: async () => ({ count: 0 }) },
  };
  const prisma = {
    ...tx,
    $transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone({
        deployments: state.deployments,
        models: state.models,
        balances: state.balances,
        ledger: state.ledger,
      });
      try {
        return await fn(tx);
      } catch (err) {
        Object.assign(state, snapshot);
        throw err;
      }
    },
  };
  return { prisma, state, hooks };
}

function makeNosana() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const port = {
    assertCanDeploy: (tier: string) => {
      calls.push({ op: "assertCanDeploy", args: [tier] });
    },
    createDeployment: async (...args: unknown[]) => {
      calls.push({ op: "createDeployment", args });
      return { id: "dm_new", market: "M", replicas: 1, status: "active" as const, endpoints: [] };
    },
    stopDeployment: async (id: string) => ({ deploymentId: id, stopped: true, alreadyStopped: false, reclaimed: true }),
    scaleDeployment: async () => {
      throw new Error("not used");
    },
    getDeploymentStatus: async () => {
      throw new Error("not used");
    },
    reclaimDeploymentVault: async (id: string) => ({ deploymentId: id, state: "stopped" as const, reclaimed: true }),
  };
  return { port, calls };
}

const SERVING: AdapterServingDeps = {
  gpuFacingApiUrl: () => "https://api.example.com",
  gpuNodesAreLocal: () => false,
  // A store whose bytes the download route streams itself: nothing to reach.
  getStore: () => ({ kind: "local" }) as never,
  signingSecret: () => SECRET,
  tierVramGb: (tier) => ({ "3060": 12, "4090": 24, a100: 40 })[tier] ?? null,
};

async function makeApp(opts: {
  db: ReturnType<typeof makeDb>;
  serving?: Partial<AdapterServingDeps>;
  realSubmit?: boolean;
}) {
  const nosana = makeNosana();
  const submitCalls: any[][] = [];
  const mod = await import("../routes/deployments.js");
  (await import("../lib/bigintJson.js")).installBigIntJsonSerializer();
  const app = Fastify();
  await app.register((await import("@fastify/sensible")).default);
  app.setErrorHandler((await import("../lib/errorHandler.js")).globalErrorHandler);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "user_1", orgId: ORG, type: "jwt" };
  });
  await app.register(
    mod.createDeploymentRoutes({
      prisma: opts.db.prisma as never,
      getNosana: async () => nosana.port as never,
      triggerWebhook: (async () => {}) as never,
      now: () => T_NOW,
      adapterServing: { ...SERVING, ...opts.serving },
      ...(opts.realSubmit
        ? {}
        : {
            submit: async (...args: unknown[]) => {
              submitCalls.push(args);
            },
          }),
    }),
  );
  return { app, nosana, submitCalls };
}

const create = (app: any, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/", payload: { name: "Tone prod", gpuTier: "3060", ...payload } });

function stoppedDeployment(over: Record<string, unknown> = {}) {
  return {
    id: "9a1d6a3e-5a55-4a43-8f0e-6f6c1c9f7b22",
    orgId: ORG,
    name: "Tone prod",
    slug: "tone-prod",
    modelId: "phi-3-mini",
    engine: "vllm",
    gpuTier: "3060",
    replicas: 1,
    config: { maxTokens: 2048, gpuMemoryUtilization: 0.8 },
    status: "stopped",
    statusReason: "user_stopped",
    nosanaJobIds: [],
    createdAt: T_NOW,
    updatedAt: T_NOW,
    stoppedAt: T_NOW,
    reservationCents: null,
    reservationReleasedAt: null,
    vaultReclaimedAt: null,
    runGeneration: 0,
    fineTunedModelId: MODEL_ID,
    ...over,
  };
}

// ============================================
// Create
// ============================================

test("create with fineTunedModelId: a vLLM deployment of the base model, holding its reservation, with an adapter signed for its first run", async () => {
  const db = makeDb();
  const { app, submitCalls, nosana } = await makeApp({ db });

  const res = await create(app, { fineTunedModelId: MODEL_ID });
  assert.equal(res.statusCode, 201, res.body);
  const { deployment } = res.json();
  assert.match(deployment.id, UUID);
  assert.equal(deployment.fineTunedModelId, MODEL_ID);
  assert.equal(deployment.status, "pending");

  const row = db.state.deployments[0]!;
  assert.equal(row.id, deployment.id);
  assert.equal(row.modelId, "phi-3-mini", "the base model comes from the fine-tuned model");
  assert.equal(row.fineTunedModelId, MODEL_ID);
  assert.equal(row.engine, "vllm");
  assert.equal(row.runGeneration, 0);
  assert.ok(row.reservationCents > 0n, "the usual hold");
  assert.deepEqual(
    db.state.ledger.map((entry) => [entry.type, entry.referenceId]),
    [["deployment_reservation", deployment.id]],
  );
  assert.deepEqual(nosana.calls.map((call) => call.op), ["assertCanDeploy"], "the usual pre-flight");

  assert.equal(submitCalls.length, 1);
  const [id, config, tier, replicas, runGeneration] = submitCalls[0]!;
  assert.deepEqual([id, tier, replicas, runGeneration], [deployment.id, "3060", 1, 0]);
  const { adapter, ...rest } = config;
  assert.deepEqual(rest, {
    modelId: "phi-3-mini",
    hfModelId: "microsoft/Phi-3-mini-4k-instruct",
    engine: "vllm",
    maxTokens: 4096,
    gpuMemoryUtilization: 0.9,
  });
  assert.deepEqual(
    { ...adapter, downloadUrl: "" },
    { name: "ft-support-tone", downloadUrl: "", maxRank: 16, sha256: SHA, bytes: 18_092_371 },
  );
  const url = new URL(adapter.downloadUrl);
  assert.equal(url.origin + url.pathname, `https://api.example.com/api/training/fine-tuned-models/${MODEL_ID}/adapter`);
  assert.equal(url.searchParams.get("d"), deployment.id);
  assert.equal(url.searchParams.get("g"), "0");
  assert.equal(
    verifyAdapterGrant(
      { fineTunedModelId: MODEL_ID, deploymentId: deployment.id, runGeneration: 0 },
      url.searchParams.get("sig"),
      SECRET,
    ),
    true,
  );
  await app.close();
});

test("create with fineTunedModelId: the base model id may be sent too, but only the right one", async () => {
  const db = makeDb();
  const { app, submitCalls } = await makeApp({ db });
  const same = await create(app, { fineTunedModelId: MODEL_ID, modelId: "phi-3-mini" });
  assert.equal(same.statusCode, 201);

  const other = await create(app, { fineTunedModelId: MODEL_ID, modelId: "llama-3.1-8b", name: "Second" });
  assert.equal(other.statusCode, 400);
  assert.equal(other.json().error, "fine_tuned_model_base_mismatch");
  assert.equal(db.state.deployments.length, 1);
  assert.equal(submitCalls.length, 1);
  await app.close();
});

test("create with fineTunedModelId: the submit sends Nosana the adapter definition under the run's name", async () => {
  const db = makeDb();
  const { app, nosana } = await makeApp({ db, realSubmit: true });
  const res = await create(app, { fineTunedModelId: MODEL_ID });
  assert.equal(res.statusCode, 201);
  await new Promise((resolve) => setTimeout(resolve, 20)); // the submit runs in the background

  const created = nosana.calls.find((call) => call.op === "createDeployment")!;
  const [definition, tier, replicas, options] = created.args as [any, string, number, { name: string }];
  const id = res.json().deployment.id;
  assert.deepEqual([tier, replicas], ["3060", 1]);
  assert.equal(options.name, `wheelsai-model-${id}-r0`);
  const args = definition.ops[0].args;
  assert.deepEqual(args.entrypoint, ["python3", "-c"]);
  assert.equal(args.cmd[0], VLLM_ADAPTER_BOOTSTRAP);
  assert.deepEqual(args.cmd.slice(-5), [
    "--enable-lora",
    "--lora-modules",
    "ft-support-tone=/adapters/ft-support-tone",
    "--max-lora-rank",
    "16",
  ]);
  assert.equal(
    new URL(args.env.WHEELSAI_ADAPTER_URL).searchParams.get("sig"),
    signAdapterGrant({ fineTunedModelId: MODEL_ID, deploymentId: id, runGeneration: 0 }, SECRET),
  );
  assert.deepEqual(db.state.deployments[0]!.nosanaJobIds, ["dm_new"]);
  assert.equal(db.state.deployments[0]!.status, "provisioning");
  await app.close();
});

test("create with fineTunedModelId: every refusal comes before the pre-flight, the row and the reservation", async () => {
  const cases: Array<[string, Record<string, unknown>, Partial<AdapterServingDeps>, number, string]> = [
    ["another organization's model", { fineTunedModelId: THEIRS_ID }, {}, 404, "fine_tuned_model_not_found"],
    ["a model that does not exist", { fineTunedModelId: "3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6aff" }, {}, 404, "fine_tuned_model_not_found"],
    ["a deleted model", { fineTunedModelId: DELETED_ID }, {}, 409, "fine_tuned_model_not_ready"],
    ["the Ollama engine", { fineTunedModelId: MODEL_ID, engine: "ollama" }, {}, 400, "engine_not_supported_for_adapters"],
    ["a tier that does not exist", { fineTunedModelId: MODEL_ID, gpuTier: "nope" }, {}, 400, "unknown_gpu_tier"],
    ["a tier too small for the base model", { fineTunedModelId: LLAMA_FT_ID, gpuTier: "3060" }, {}, 400, "tier_too_small_for_serving"],
    ["no PUBLIC_API_URL", { fineTunedModelId: MODEL_ID }, { gpuFacingApiUrl: () => undefined }, 503, "adapter_download_not_configured"],
    ["no object store", { fineTunedModelId: MODEL_ID }, { getStore: () => null }, 503, "adapter_storage_not_configured"],
  ];
  for (const [what, payload, serving, status, code] of cases) {
    const db = makeDb();
    const { app, submitCalls, nosana } = await makeApp({ db, serving });
    const res = await create(app, payload);
    assert.equal(res.statusCode, status, `${what}: ${res.body}`);
    assert.equal(res.json().error, code, what);
    assert.deepEqual(db.state.deployments, [], what);
    assert.equal(db.state.balances[ORG], 10_000n, what);
    assert.deepEqual(db.state.ledger, [], what);
    assert.deepEqual(nosana.calls, [], `${what}: Nosana was not asked`);
    assert.deepEqual(submitCalls, [], what);
    await app.close();
  }

  // The other organization's model gets the answer of one that does not exist.
  const db = makeDb();
  const { app } = await makeApp({ db });
  const theirs = await create(app, { fineTunedModelId: THEIRS_ID });
  const unknown = await create(app, { fineTunedModelId: "3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6aff" });
  assert.deepEqual(theirs.json(), unknown.json());
  // A malformed id is a validation error, and neither id nor model is a 400 too.
  assert.equal((await create(app, { fineTunedModelId: "not-a-uuid" })).statusCode, 400);
  assert.equal((await create(app, {})).statusCode, 400);
  await app.close();
});

test("create with fineTunedModelId: a tier that fits an 8B base is accepted", async () => {
  const db = makeDb();
  const { app } = await makeApp({ db });
  const res = await create(app, { fineTunedModelId: LLAMA_FT_ID, gpuTier: "4090" });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(db.state.deployments[0]!.modelId, "llama-3.1-8b");
  await app.close();
});

test("create with fineTunedModelId: a model deleted while the deployment is admitted is a 409 and nothing is kept", async () => {
  const db = makeDb();
  // The delete commits after the route read the model and before its lock.
  db.hooks.beforeLock = () => {
    db.state.models[0]!.status = "deleted";
  };
  const { app, submitCalls } = await makeApp({ db });
  const res = await create(app, { fineTunedModelId: MODEL_ID });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "fine_tuned_model_not_ready");
  assert.deepEqual(db.state.deployments, []);
  assert.equal(db.state.balances[ORG], 10_000n);
  assert.deepEqual(db.state.ledger, []);
  assert.deepEqual(submitCalls, []);
  await app.close();
});

test("create with fineTunedModelId: without the credits for the hold it is a 402 and no row is left", async () => {
  const db = makeDb({ balance: 1n });
  const { app, submitCalls } = await makeApp({ db });
  const res = await create(app, { fineTunedModelId: MODEL_ID });
  assert.equal(res.statusCode, 402);
  assert.deepEqual(db.state.deployments, []);
  assert.equal(db.state.balances[ORG], 1n);
  assert.deepEqual(submitCalls, []);
  await app.close();
});

test("create without fineTunedModelId is what it was: same row, same submit, and the fine-tuned table is never read", async () => {
  const db = makeDb();
  const { app, submitCalls } = await makeApp({
    db,
    // Not even consulted for an ordinary deployment.
    serving: {
      gpuFacingApiUrl: () => {
        throw new Error("read for a deployment without an adapter");
      },
    },
  });
  const res = await create(app, { modelId: "llama-3.1-8b", gpuTier: "3060", engine: "ollama" });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(Object.keys(res.json().deployment), ["id", "name", "slug", "status"]);
  assert.equal(db.state.fineTunedReads, 0);
  assert.deepEqual(db.state.creates[0], {
    orgId: ORG,
    name: "Tone prod",
    slug: "tone-prod",
    modelId: "llama-3.1-8b",
    engine: "ollama",
    gpuTier: "3060",
    replicas: 1,
    config: { maxTokens: 4096, gpuMemoryUtilization: 0.9 },
    status: "pending",
    nosanaJobIds: [],
  });
  assert.deepEqual(submitCalls[0]![1], {
    modelId: "llama-3.1-8b",
    hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    engine: "ollama",
    maxTokens: 4096,
    gpuMemoryUtilization: 0.9,
  });
  await app.close();
});

test("create without fineTunedModelId: the definition sent to Nosana has no trace of an adapter", async () => {
  const db = makeDb();
  const { app, nosana } = await makeApp({ db, realSubmit: true });
  const res = await create(app, { modelId: "phi-3-mini" });
  assert.equal(res.statusCode, 201);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [definition] = nosana.calls.find((call) => call.op === "createDeployment")!.args;
  assert.equal(
    JSON.stringify(definition),
    '{"version":"0.1","type":"container","meta":{"trigger":"wheelsai"},"ops":[{"type":"container/run","id":"vllm-inference","args":{"image":"vllm/vllm-openai:v0.6.0","cmd":["--model","microsoft/Phi-3-mini-4k-instruct","--host","0.0.0.0","--port","8000","--max-model-len","4096","--gpu-memory-utilization","0.9"],"gpu":true,"expose":[{"port":8000,"type":"api","health_checks":[{"type":"http","method":"GET","path":"/health","expected_status":200,"continuous":true}]}]}}]}',
  );
  await app.close();
});

// ============================================
// Restart
// ============================================

test("restart: the new run gets a new adapter URL; the previous run's signature is not it", async () => {
  const db = makeDb({ deployments: [stoppedDeployment()] });
  const { app, submitCalls } = await makeApp({ db });
  const id = db.state.deployments[0]!.id;

  const res = await app.inject({ method: "POST", url: `/${id}/restart` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(db.state.deployments[0]!.runGeneration, 1);
  assert.equal(db.state.deployments[0]!.status, "pending");

  const [, config, , , runGeneration] = submitCalls[0]!;
  assert.equal(runGeneration, 1);
  assert.equal(config.maxTokens, 2048, "the row's own config");
  assert.equal(config.adapter.name, "ft-support-tone");
  const url = new URL(config.adapter.downloadUrl);
  assert.equal(url.searchParams.get("g"), "1");
  const sig = url.searchParams.get("sig");
  assert.equal(verifyAdapterGrant({ fineTunedModelId: MODEL_ID, deploymentId: id, runGeneration: 1 }, sig, SECRET), true);
  assert.notEqual(sig, signAdapterGrant({ fineTunedModelId: MODEL_ID, deploymentId: id, runGeneration: 0 }, SECRET));
  await app.close();
});

test("restart: refused with the named reason, and the row untouched, when the model is deleted or the server has no public URL", async () => {
  const cases: Array<[string, Record<string, unknown>, Partial<AdapterServingDeps>, number, string]> = [
    ["a deleted model", { fineTunedModelId: DELETED_ID }, {}, 409, "fine_tuned_model_not_ready"],
    ["no PUBLIC_API_URL", {}, { gpuFacingApiUrl: () => undefined }, 503, "adapter_download_not_configured"],
    ["no object store", {}, { getStore: () => null }, 503, "adapter_storage_not_configured"],
    ["a tier too small", { fineTunedModelId: LLAMA_FT_ID, modelId: "llama-3.1-8b" }, {}, 400, "tier_too_small_for_serving"],
  ];
  for (const [what, over, serving, status, code] of cases) {
    const db = makeDb({ deployments: [stoppedDeployment(over)] });
    const { app, submitCalls, nosana } = await makeApp({ db, serving });
    const res = await app.inject({ method: "POST", url: `/${db.state.deployments[0]!.id}/restart` });
    assert.equal(res.statusCode, status, `${what}: ${res.body}`);
    assert.equal(res.json().error, code, what);
    assert.equal(db.state.deployments[0]!.status, "stopped", what);
    assert.equal(db.state.deployments[0]!.runGeneration, 0, what);
    assert.equal(db.state.balances[ORG], 10_000n, what);
    assert.deepEqual(nosana.calls, [], what);
    assert.deepEqual(submitCalls, [], what);
    await app.close();
  }
});

test("restart: a model deleted while the restart is claimed rolls the claim back", async () => {
  const db = makeDb({ deployments: [stoppedDeployment()] });
  db.hooks.beforeLock = () => {
    db.state.models[0]!.status = "deleted";
  };
  const { app, submitCalls } = await makeApp({ db });
  const res = await app.inject({ method: "POST", url: `/${db.state.deployments[0]!.id}/restart` });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "fine_tuned_model_not_ready");
  assert.equal(db.state.deployments[0]!.status, "stopped");
  assert.equal(db.state.deployments[0]!.runGeneration, 0);
  assert.equal(db.state.balances[ORG], 10_000n);
  assert.deepEqual(submitCalls, []);
  await app.close();
});

test("restart of a deployment without an adapter is what it was", async () => {
  const db = makeDb({ deployments: [stoppedDeployment({ fineTunedModelId: null })] });
  const { app, submitCalls } = await makeApp({ db });
  const res = await app.inject({ method: "POST", url: `/${db.state.deployments[0]!.id}/restart` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(db.state.fineTunedReads, 0);
  assert.deepEqual(submitCalls[0]![1], {
    modelId: "phi-3-mini",
    hfModelId: "microsoft/Phi-3-mini-4k-instruct",
    engine: "vllm",
    maxTokens: 2048,
    gpuMemoryUtilization: 0.8,
  });
  await app.close();
});

// ============================================
// Reads
// ============================================

test("list and detail say which fine-tuned model a deployment serves", async () => {
  const db = makeDb({
    deployments: [
      stoppedDeployment(),
      stoppedDeployment({ id: "9a1d6a3e-5a55-4a43-8f0e-6f6c1c9f7b33", slug: "plain", fineTunedModelId: null }),
    ],
  });
  const { app } = await makeApp({ db });
  const list = (await app.inject({ method: "GET", url: "/" })).json().deployments;
  const expected = { id: MODEL_ID, name: "Support tone", slug: "support-tone" };
  assert.deepEqual(list.map((d: any) => d.fineTunedModel), [expected, null]);
  const detail = (await app.inject({ method: "GET", url: `/${db.state.deployments[0]!.id}` })).json().deployment;
  assert.deepEqual(detail.fineTunedModel, expected);
  assert.equal(detail.fineTunedModelId, MODEL_ID);
  const plain = (await app.inject({ method: "GET", url: `/${db.state.deployments[1]!.id}` })).json().deployment;
  assert.equal(plain.fineTunedModel, null);
  await app.close();
});
