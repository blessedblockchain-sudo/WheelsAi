import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import Fastify from "fastify";

import "./unitEnv.js";
import { createFineTunedModelRoutes } from "../routes/fineTunedModels.js";
import {
  ADAPTER_SERVING_STATUSES,
  FINE_TUNED_MODELS_PREFIX,
  adapterDownloadUrl,
  adapterForRun,
  deleteFineTunedModel,
  lockReadyFineTunedModel,
  prepareAdapterServing,
  servingVramGbForParams,
  signAdapterGrant,
  verifyAdapterGrant,
  type AdapterServingDeps,
} from "../services/fineTunedModels.js";
import { ACTIVE_STATUSES } from "../services/modelDeploymentLifecycle.js";
import { LocalObjectStore, type ObjectStore } from "../services/objectStore.js";

// Fine-tuned models: list, detail, delete, what a deployment of one needs,
// and the adapter download with its signed, never-expiring URL.

const SECRET = "unit-test-signing-secret-0123456789";
const ORG = "0b0e3a43-6f4c-4b6e-9a53-000000000001";
const OTHER_ORG = "0b0e3a43-6f4c-4b6e-9a53-000000000002";
const MODEL_ID = "3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6a11";
const OTHER_MODEL_ID = "3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6a22";
const JOB_ID = "7c1f3b0a-2d7e-4c53-8c11-5d5a8d1f0a01";
const DEP_ID = "9a1d6a3e-5a55-4a43-8f0e-6f6c1c9f7b22";
const OTHER_DEP_ID = "9a1d6a3e-5a55-4a43-8f0e-6f6c1c9f7b33";
const SHA = "ee9275b14e49b9cd6249454c034910294034f22b4c59d513c40de4692b1a7dd9";
const T_NOW = new Date("2026-10-07T12:00:00.000Z");
const ADAPTER_KEY = `adapters/${ORG}/${JOB_ID}/adapter.tar.gz`;

interface Ftm {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  liveSlug: string | null;
  baseModelId: string;
  baseModelHfId: string;
  trainingJobId: string;
  method: string;
  loraR: number;
  adapterKey: string;
  adapterBytes: bigint;
  adapterSha256: string;
  metrics: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}
interface Dep {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  status: string;
  runGeneration: number;
  fineTunedModelId: string | null;
  createdAt: Date;
}

function ftm(over: Partial<Ftm> = {}): Ftm {
  return {
    id: MODEL_ID,
    orgId: ORG,
    name: "Support tone",
    slug: "support-tone",
    liveSlug: "support-tone",
    baseModelId: "phi-3-mini",
    baseModelHfId: "microsoft/Phi-3-mini-4k-instruct",
    trainingJobId: JOB_ID,
    method: "lora",
    loraR: 16,
    adapterKey: ADAPTER_KEY,
    adapterBytes: 18_092_371n,
    adapterSha256: SHA,
    metrics: { finalLoss: 0.42 },
    status: "ready",
    createdAt: new Date("2026-10-06T10:00:00.000Z"),
    updatedAt: new Date("2026-10-06T10:00:00.000Z"),
    deletedAt: null,
    ...over,
  };
}
function dep(over: Partial<Dep> = {}): Dep {
  return {
    id: DEP_ID,
    orgId: ORG,
    name: "Tone prod",
    slug: "tone-prod",
    status: "running",
    runGeneration: 2,
    fineTunedModelId: MODEL_ID,
    createdAt: new Date("2026-10-06T11:00:00.000Z"),
    ...over,
  };
}

function makeDb(seed: { models?: Ftm[]; deployments?: Dep[] }) {
  const state = { models: seed.models ?? [ftm()], deployments: seed.deployments ?? [] };
  /** Runs between the delete's claim and its in-use count. */
  const hooks: { afterClaim?: () => void } = {};

  const modelMatches = (m: Ftm, where: any) =>
    (where.id === undefined || m.id === where.id) &&
    (where.orgId === undefined || m.orgId === where.orgId) &&
    (where.status === undefined || m.status === where.status);
  const depMatches = (d: Dep, where: any) =>
    (where.id === undefined || d.id === where.id) &&
    (where.fineTunedModelId === undefined || d.fineTunedModelId === where.fineTunedModelId) &&
    (where.runGeneration === undefined || d.runGeneration === where.runGeneration) &&
    (where.status?.in === undefined || where.status.in.includes(d.status));
  const withRelations = (m: Ftm) => ({
    ...m,
    baseModel: { displayName: "Phi-3 Mini", parameters: 3_800_000_000n, minGpuTier: "3060" },
    trainingJob: { id: m.trainingJobId, name: "tone run", status: "completed", completedAt: T_NOW },
    deployments: state.deployments
      .filter((d) => d.fineTunedModelId === m.id)
      .map((d) => ({ id: d.id, name: d.name, slug: d.slug, status: d.status })),
  });

  const tx = {
    fineTunedModel: {
      findMany: async ({ where }: any) => state.models.filter((m) => modelMatches(m, where)).map(withRelations),
      findFirst: async ({ where }: any) => {
        const m = state.models.find((x) => modelMatches(x, where));
        return m ? withRelations(m) : null;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const m of state.models) {
          if (modelMatches(m, where)) {
            Object.assign(m, data);
            count += 1;
          }
        }
        if (data.status === "deleted") hooks.afterClaim?.();
        return { count };
      },
    },
    deployment: {
      count: async ({ where }: any) => state.deployments.filter((d) => depMatches(d, where)).length,
      findFirst: async ({ where }: any) => {
        const d = state.deployments.find((x) => depMatches(x, where));
        if (!d) return null;
        const m = state.models.find((x) => x.id === d.fineTunedModelId);
        return { orgId: d.orgId, fineTunedModel: m ? { ...m } : null };
      },
    },
  };
  const prisma = {
    ...tx,
    $transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone(state);
      try {
        return await fn(tx);
      } catch (err) {
        state.models = snapshot.models;
        state.deployments = snapshot.deployments;
        throw err;
      }
    },
  };
  return { prisma, state, hooks };
}

/** An object store that presigns, as the s3 driver does. */
function presigningStore(objects: Record<string, Buffer>) {
  const calls: string[] = [];
  const store: ObjectStore = {
    kind: "s3",
    head: async (key) => (objects[key] ? { size: objects[key]!.length } : null),
    getStream: async (key) => Readable.from(objects[key]!),
    put: async (key, body) => {
      objects[key] = Buffer.from(body);
    },
    delete: async (key) => {
      calls.push(`delete ${key}`);
      delete objects[key];
    },
    deletePrefix: async (prefix) => {
      calls.push(`deletePrefix ${prefix}`);
      const keys = Object.keys(objects).filter((key) => key.startsWith(prefix));
      for (const key of keys) delete objects[key];
      return keys.length;
    },
    presignGet: async (key, ttl) => {
      calls.push(`presignGet ${key} ${ttl}`);
      return `https://bucket.s3.example.com/${key}?X-Amz-Expires=${ttl}&X-Amz-Signature=abc`;
    },
    presignPut: async () => null,
  };
  return { store, calls, objects };
}

async function makeApp(opts: {
  db: ReturnType<typeof makeDb>;
  store?: ObjectStore | null;
  orgId?: string | null;
}) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.orgId !== null) {
      (request as any).auth = { userId: "u", orgId: opts.orgId ?? ORG, type: "jwt", role: "owner" };
    }
  });
  await app.register(
    createFineTunedModelRoutes({
      prisma: opts.db.prisma as never,
      getStore: () => (opts.store === undefined ? presigningStore({}).store : opts.store),
      now: () => T_NOW,
      signingSecret: () => SECRET,
    }),
    { prefix: FINE_TUNED_MODELS_PREFIX },
  );
  return app;
}

const SERVING: AdapterServingDeps = {
  publicApiUrl: () => "https://api.example.com",
  signingSecret: () => SECRET,
  tierVramGb: (tier) => ({ "3060": 12, "4090": 24, a100: 40 })[tier] ?? null,
};

// ============================================
// The signature
// ============================================

test("statuses: a run may fetch its adapter exactly while the deployment counts as active", () => {
  assert.deepEqual(ADAPTER_SERVING_STATUSES, ACTIVE_STATUSES);
});

test("signature: it holds for its own (model, deployment, run) and for nothing else", () => {
  const grant = { fineTunedModelId: MODEL_ID, deploymentId: DEP_ID, runGeneration: 2 };
  const sig = signAdapterGrant(grant, SECRET);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(verifyAdapterGrant(grant, sig, SECRET), true);

  assert.equal(verifyAdapterGrant({ ...grant, deploymentId: OTHER_DEP_ID }, sig, SECRET), false, "another deployment");
  assert.equal(verifyAdapterGrant({ ...grant, runGeneration: 1 }, sig, SECRET), false, "an earlier run");
  assert.equal(verifyAdapterGrant({ ...grant, runGeneration: 3 }, sig, SECRET), false, "a later run");
  assert.equal(verifyAdapterGrant({ ...grant, fineTunedModelId: OTHER_MODEL_ID }, sig, SECRET), false, "another model");
  assert.equal(verifyAdapterGrant(grant, sig, `${SECRET}x`), false, "another secret");
  const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  assert.equal(verifyAdapterGrant(grant, flipped, SECRET), false, "forged");
  for (const bad of [undefined, null, 5, "", sig.slice(2), sig.toUpperCase(), `${sig}00`, ["a"]]) {
    assert.equal(verifyAdapterGrant(grant, bad, SECRET), false, String(bad));
  }
  // The fields cannot be shifted into one another.
  assert.notEqual(
    signAdapterGrant({ fineTunedModelId: "a", deploymentId: "b1", runGeneration: 2 }, SECRET),
    signAdapterGrant({ fineTunedModelId: "a", deploymentId: "b", runGeneration: 12 }, SECRET),
  );
});

test("the adapter URL names the route, the deployment and the run, and carries no expiry", () => {
  const grant = { fineTunedModelId: MODEL_ID, deploymentId: DEP_ID, runGeneration: 2 };
  const url = new URL(adapterDownloadUrl("https://api.example.com/", grant, SECRET));
  assert.equal(url.origin, "https://api.example.com");
  assert.equal(url.pathname, `/api/training/fine-tuned-models/${MODEL_ID}/adapter`);
  assert.deepEqual([...url.searchParams.keys()], ["d", "g", "sig"], "no exp");
  assert.equal(url.searchParams.get("d"), DEP_ID);
  assert.equal(url.searchParams.get("g"), "2");
  assert.equal(url.searchParams.get("sig"), signAdapterGrant(grant, SECRET));
});

// ============================================
// What a deployment of a fine-tuned model needs
// ============================================

test("serving figure: bf16 weights plus room, a planning number", () => {
  assert.equal(servingVramGbForParams(3.8), 9);
  assert.equal(servingVramGbForParams(3.2), 8);
  assert.equal(servingVramGbForParams(8), 17);
  assert.equal(servingVramGbForParams(7.6), 17);
});

test("prepareAdapterServing: accepted for the owner on a tier that fits; each refusal in its order", async () => {
  const args = { orgId: ORG, fineTunedModelId: MODEL_ID, engine: "vllm", gpuTier: "3060" };
  const prepare = (
    over: Partial<typeof args> = {},
    serving: Partial<AdapterServingDeps> = {},
    model: Partial<Ftm> = {},
  ) =>
    prepareAdapterServing(
      { prisma: makeDb({ models: [ftm(model)] }).prisma as never, serving: { ...SERVING, ...serving } },
      { ...args, ...over },
    );

  const ok = await prepare();
  assert.ok(ok.ok);
  assert.equal(ok.adapterName, "ft-support-tone");
  assert.deepEqual(ok.fineTunedModel, {
    id: MODEL_ID,
    slug: "support-tone",
    baseModelId: "phi-3-mini",
    baseModelHfId: "microsoft/Phi-3-mini-4k-instruct",
    loraR: 16,
    adapterSha256: SHA,
    adapterBytes: 18_092_371n,
  });

  const refusal = async (promise: ReturnType<typeof prepare>) => {
    const result = await promise;
    assert.ok(!result.ok);
    return [result.status, result.code];
  };
  // Another organization's model does not exist for this caller - even when
  // everything else about the request is wrong too.
  assert.deepEqual(await refusal(prepare({ orgId: OTHER_ORG, engine: "ollama", gpuTier: "nope" })), [
    404,
    "fine_tuned_model_not_found",
  ]);
  assert.deepEqual(await refusal(prepare({ fineTunedModelId: OTHER_MODEL_ID })), [404, "fine_tuned_model_not_found"]);
  assert.deepEqual(await refusal(prepare({ engine: "ollama" }, {}, { status: "deleted" })), [
    409,
    "fine_tuned_model_not_ready",
  ]);
  assert.deepEqual(await refusal(prepare({ engine: "ollama", gpuTier: "nope" })), [
    400,
    "engine_not_supported_for_adapters",
  ]);
  assert.deepEqual(await refusal(prepare({ gpuTier: "nope" }, { publicApiUrl: () => undefined })), [
    400,
    "unknown_gpu_tier",
  ]);

  // An 8B base needs more than a 12 GB card to load unquantised.
  const small = await prepare(
    {},
    { publicApiUrl: () => undefined },
    { baseModelId: "llama-3.1-8b", baseModelHfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" },
  );
  assert.ok(!small.ok);
  assert.deepEqual([small.status, small.code, small.requiredVramGb], [400, "tier_too_small_for_serving", 17]);
  const fits = await prepare(
    { gpuTier: "4090" },
    {},
    { baseModelId: "llama-3.1-8b", baseModelHfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" },
  );
  assert.ok(fits.ok);

  // A slug or a stored value the job definition would refuse (D13).
  assert.deepEqual(await refusal(prepare({}, {}, { slug: "Support Tone; rm -rf" })), [
    409,
    "fine_tuned_model_not_servable",
  ]);
  assert.deepEqual(await refusal(prepare({}, {}, { adapterSha256: "not-a-checksum" })), [
    409,
    "fine_tuned_model_not_servable",
  ]);
  assert.deepEqual(await refusal(prepare({}, {}, { baseModelHfId: "x/y --trust-remote-code" })), [
    409,
    "fine_tuned_model_not_servable",
  ]);

  // No PUBLIC_API_URL: a GPU node has nowhere to fetch the adapter from.
  const noUrl = await prepare({}, { publicApiUrl: () => undefined });
  assert.ok(!noUrl.ok);
  assert.deepEqual([noUrl.status, noUrl.code], [503, "adapter_download_not_configured"]);
  assert.match(noUrl.message, /PUBLIC_API_URL/);
  assert.deepEqual(await refusal(prepare({}, { publicApiUrl: () => "https://user:pw@api.example.com" })), [
    503,
    "adapter_download_not_configured",
  ]);
});

test("adapterForRun: one URL per run, signed for that run only", () => {
  const model = {
    id: MODEL_ID,
    slug: "support-tone",
    baseModelId: "phi-3-mini",
    baseModelHfId: "microsoft/Phi-3-mini-4k-instruct",
    loraR: 32,
    adapterSha256: SHA,
    adapterBytes: 18_092_371n,
  };
  const first = adapterForRun(SERVING, model, { deploymentId: DEP_ID, runGeneration: 0 });
  const second = adapterForRun(SERVING, model, { deploymentId: DEP_ID, runGeneration: 1 });
  assert.deepEqual(
    { ...first, downloadUrl: "" },
    { name: "ft-support-tone", downloadUrl: "", maxRank: 32, sha256: SHA, bytes: 18_092_371 },
  );
  assert.notEqual(first.downloadUrl, second.downloadUrl);
  assert.equal(
    new URL(second.downloadUrl).searchParams.get("sig"),
    signAdapterGrant({ fineTunedModelId: MODEL_ID, deploymentId: DEP_ID, runGeneration: 1 }, SECRET),
  );
  assert.throws(() => adapterForRun({ ...SERVING, publicApiUrl: () => undefined }, model, { deploymentId: DEP_ID, runGeneration: 0 }));
});

test("lockReadyFineTunedModel: true for the owner's ready model, false otherwise", async () => {
  const db = makeDb({});
  assert.equal(await lockReadyFineTunedModel(db.prisma, { id: MODEL_ID, orgId: ORG, now: T_NOW }), true);
  assert.equal(await lockReadyFineTunedModel(db.prisma, { id: MODEL_ID, orgId: OTHER_ORG, now: T_NOW }), false);
  db.state.models[0]!.status = "deleted";
  assert.equal(await lockReadyFineTunedModel(db.prisma, { id: MODEL_ID, orgId: ORG, now: T_NOW }), false);
});

// ============================================
// List and detail
// ============================================

test("list and detail: the organization's own models, with base model, method, rank, size, metrics, job and deployments", async () => {
  const db = makeDb({
    models: [
      ftm(),
      ftm({ id: OTHER_MODEL_ID, orgId: OTHER_ORG, slug: "theirs", liveSlug: "theirs" }),
      ftm({ id: "3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6a33", status: "deleted", liveSlug: null }),
    ],
    deployments: [dep(), dep({ id: OTHER_DEP_ID, slug: "tone-old", status: "stopped" })],
  });
  const app = await makeApp({ db });

  const list = await app.inject({ method: "GET", url: FINE_TUNED_MODELS_PREFIX });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().total, 1, "not the other organization's, not the deleted one");
  const expected = {
    id: MODEL_ID,
    name: "Support tone",
    slug: "support-tone",
    baseModelId: "phi-3-mini",
    baseModelHfId: "microsoft/Phi-3-mini-4k-instruct",
    baseModelName: "Phi-3 Mini",
    method: "lora",
    loraR: 16,
    adapterBytes: 18_092_371,
    adapterSha256: SHA,
    metrics: { finalLoss: 0.42 },
    trainingJobId: JOB_ID,
    trainingJob: { id: JOB_ID, name: "tone run", status: "completed", completedAt: T_NOW.toISOString() },
    deployments: [
      { id: DEP_ID, name: "Tone prod", slug: "tone-prod", status: "running" },
      { id: OTHER_DEP_ID, name: "Tone prod", slug: "tone-old", status: "stopped" },
    ],
    activeDeployments: 1,
    createdAt: "2026-10-06T10:00:00.000Z",
  };
  assert.deepEqual(list.json().fineTunedModels, [expected]);
  assert.ok(!JSON.stringify(list.json()).includes("adapters/"), "the object key is not shown");

  const detail = await app.inject({ method: "GET", url: `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}` });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json().fineTunedModel, expected);
  await app.close();
});

test("cross-organization: another organization's model is a 404 on detail and delete, and absent from its list", async () => {
  const db = makeDb({ deployments: [] });
  const store = presigningStore({ [ADAPTER_KEY]: Buffer.from("x") });
  const app = await makeApp({ db, orgId: OTHER_ORG, store: store.store });

  const list = await app.inject({ method: "GET", url: FINE_TUNED_MODELS_PREFIX });
  assert.deepEqual(list.json(), { fineTunedModels: [], total: 0 });
  const unknown = await app.inject({ method: "GET", url: `${FINE_TUNED_MODELS_PREFIX}/${OTHER_MODEL_ID}` });
  for (const method of ["GET", "DELETE"] as const) {
    const res = await app.inject({ method, url: `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}` });
    assert.equal(res.statusCode, 404, method);
    assert.deepEqual(res.json(), unknown.json(), "the same answer as for a model that does not exist");
  }
  assert.equal(db.state.models[0]!.status, "ready", "nothing was deleted");
  assert.deepEqual(store.calls, []);

  const malformed = await app.inject({ method: "GET", url: `${FINE_TUNED_MODELS_PREFIX}/not-a-uuid` });
  assert.equal(malformed.statusCode, 404);
  await app.close();
});

test("list, detail and delete need a session", async () => {
  const { requireAuth } = await import("../middleware/auth.js");
  assert.equal(typeof requireAuth, "function");
  const app = await makeApp({ db: makeDb({}), orgId: null });
  for (const [method, url] of [
    ["GET", FINE_TUNED_MODELS_PREFIX],
    ["GET", `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}`],
    ["DELETE", `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}`],
  ] as const) {
    const res = await app.inject({ method, url });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  await app.close();
});

// ============================================
// Delete
// ============================================

test("delete: refused while an active deployment serves the model; nothing changes", async () => {
  for (const status of ACTIVE_STATUSES) {
    const db = makeDb({ deployments: [dep({ status }), dep({ id: OTHER_DEP_ID, status: "stopped" })] });
    const store = presigningStore({ [ADAPTER_KEY]: Buffer.from("x") });
    const app = await makeApp({ db, store: store.store });
    const res = await app.inject({ method: "DELETE", url: `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}` });
    assert.equal(res.statusCode, 409, status);
    assert.equal(res.json().error, "model_in_use");
    assert.equal(res.json().deployments, 1);
    assert.equal(db.state.models[0]!.status, "ready", "the claim was rolled back");
    assert.equal(db.state.models[0]!.liveSlug, "support-tone");
    assert.deepEqual(store.calls, [], "no object was touched");
    await app.close();
  }
});

test("delete: the row is marked deleted, its slug freed, and its objects removed; a second delete is a 404", async () => {
  const db = makeDb({ deployments: [dep({ status: "stopped" }), dep({ id: OTHER_DEP_ID, status: "failed" })] });
  const store = presigningStore({
    [ADAPTER_KEY]: Buffer.from("x"),
    [`adapters/${ORG}/${JOB_ID}/metrics.json`]: Buffer.from("{}"),
    [`adapters/${ORG}/another-job/adapter.tar.gz`]: Buffer.from("y"),
  });
  const app = await makeApp({ db, store: store.store });

  const res = await app.inject({ method: "DELETE", url: `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: true });
  const row = db.state.models[0]!;
  assert.equal(row.status, "deleted");
  assert.equal(row.liveSlug, null);
  assert.equal(row.slug, "support-tone", "the row and its slug stay for the deployments that name it");
  assert.deepEqual(row.deletedAt, T_NOW);
  assert.deepEqual(Object.keys(store.objects), [`adapters/${ORG}/another-job/adapter.tar.gz`]);

  const again = await app.inject({ method: "DELETE", url: `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}` });
  assert.equal(again.statusCode, 404);
  const detail = await app.inject({ method: "GET", url: `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}` });
  assert.equal(detail.statusCode, 404);
  await app.close();
});

test("delete: an archive outside a directory of its own job is removed alone", async () => {
  const key = `adapters/shared/adapter-${JOB_ID}.tar.gz`;
  const db = makeDb({ models: [ftm({ adapterKey: key })] });
  const store = presigningStore({ [key]: Buffer.from("x"), "adapters/shared/other.tar.gz": Buffer.from("y") });
  const result = await deleteFineTunedModel(
    { prisma: db.prisma as never, getStore: () => store.store, now: () => T_NOW },
    { orgId: ORG, id: MODEL_ID },
  );
  assert.deepEqual(result, { ok: true, objectsRemoved: true });
  assert.deepEqual(store.calls, [`delete ${key}`]);
  assert.deepEqual(Object.keys(store.objects), ["adapters/shared/other.tar.gz"]);
});

test("delete: a deployment admitted between the read and the claim still refuses it", async () => {
  const db = makeDb({ deployments: [] });
  // The admission committed first: by the time the delete counts, it is there.
  db.hooks.afterClaim = () => db.state.deployments.push(dep({ status: "pending" }));
  const store = presigningStore({ [ADAPTER_KEY]: Buffer.from("x") });
  const result = await deleteFineTunedModel(
    { prisma: db.prisma as never, getStore: () => store.store, now: () => T_NOW },
    { orgId: ORG, id: MODEL_ID },
  );
  assert.ok(!result.ok && result.code === "model_in_use");
  assert.equal(db.state.models[0]!.status, "ready");
  assert.deepEqual(store.calls, []);
});

test("delete: storage that fails or is absent does not undo the delete", async () => {
  for (const getStore of [
    () => null,
    () => ({ ...presigningStore({}).store, deletePrefix: async () => Promise.reject(new Error("storage down")) }),
  ]) {
    const db = makeDb({});
    const result = await deleteFineTunedModel(
      { prisma: db.prisma as never, getStore: getStore as never, now: () => T_NOW },
      { orgId: ORG, id: MODEL_ID },
    );
    assert.deepEqual(result, { ok: true, objectsRemoved: false });
    assert.equal(db.state.models[0]!.status, "deleted");
  }
});

// ============================================
// The adapter download
// ============================================

function adapterPath(grant: { fineTunedModelId: string; deploymentId: string; runGeneration: number }, sig?: string) {
  return (
    `${FINE_TUNED_MODELS_PREFIX}/${grant.fineTunedModelId}/adapter` +
    `?d=${grant.deploymentId}&g=${grant.runGeneration}&sig=${sig ?? signAdapterGrant(grant, SECRET)}`
  );
}
const GRANT = { fineTunedModelId: MODEL_ID, deploymentId: DEP_ID, runGeneration: 2 };

test("adapter download: no session needed; the s3 driver redirects to a fresh five-minute URL", async () => {
  const db = makeDb({ deployments: [dep()] });
  const store = presigningStore({ [ADAPTER_KEY]: Buffer.from("archive") });
  // No session at all: the URL is the credential.
  const app = await makeApp({ db, store: store.store, orgId: null });

  for (const status of ACTIVE_STATUSES) {
    db.state.deployments[0]!.status = status;
    const res = await app.inject({ method: "GET", url: adapterPath(GRANT) });
    assert.equal(res.statusCode, 302, status);
    assert.equal(
      res.headers.location,
      `https://bucket.s3.example.com/${ADAPTER_KEY}?X-Amz-Expires=300&X-Amz-Signature=abc`,
    );
    assert.equal(res.headers["cache-control"], "no-store");
  }
  // The URL built for a job definition is the URL the route accepts.
  const built = new URL(adapterDownloadUrl("https://api.example.com", GRANT, SECRET));
  const viaBuilt = await app.inject({ method: "GET", url: built.pathname + built.search });
  assert.equal(viaBuilt.statusCode, 302);
  await app.close();
});

test("adapter download: the local driver streams the archive", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wheelsai-ftm-test-"));
  try {
    const store = new LocalObjectStore({ driver: "local", dir });
    await store.put(ADAPTER_KEY, Buffer.from("local-archive-bytes"));
    const app = await makeApp({ db: makeDb({ deployments: [dep()] }), store, orgId: null });
    const res = await app.inject({ method: "GET", url: adapterPath(GRANT) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/gzip");
    assert.equal(res.headers["content-length"], "19");
    assert.equal(res.body, "local-archive-bytes");

    await store.delete(ADAPTER_KEY);
    const gone = await app.inject({ method: "GET", url: adapterPath(GRANT) });
    assert.equal(gone.statusCode, 404);
    await app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter download: forged, wrong deployment, old run, stopped deployment, deleted model - one 404 that never says why", async () => {
  const store = presigningStore({ [ADAPTER_KEY]: Buffer.from("archive") });
  const sig = signAdapterGrant(GRANT, SECRET);
  const cases: Array<[string, { deployments?: Dep[]; models?: Ftm[] }, string]> = [
    ["a forged signature", { deployments: [dep()] }, adapterPath(GRANT, "0".repeat(64))],
    ["a signature under another secret", { deployments: [dep()] }, adapterPath(GRANT, signAdapterGrant(GRANT, "another-secret"))],
    [
      "this signature on another deployment",
      { deployments: [dep(), dep({ id: OTHER_DEP_ID })] },
      adapterPath({ ...GRANT, deploymentId: OTHER_DEP_ID }, sig),
    ],
    [
      "this signature on another model",
      { deployments: [dep()], models: [ftm(), ftm({ id: OTHER_MODEL_ID })] },
      adapterPath({ ...GRANT, fineTunedModelId: OTHER_MODEL_ID }, sig),
    ],
    ["this signature with a later run number", { deployments: [dep({ runGeneration: 3 })] }, adapterPath({ ...GRANT, runGeneration: 3 }, sig)],
    // Correctly signed from here on: the row decides.
    ["the previous run's URL after a restart", { deployments: [dep({ runGeneration: 3 })] }, adapterPath(GRANT)],
    ["a stopped deployment", { deployments: [dep({ status: "stopped" })] }, adapterPath(GRANT)],
    ["a failed deployment", { deployments: [dep({ status: "failed" })] }, adapterPath(GRANT)],
    ["a deployment that no longer exists", { deployments: [] }, adapterPath(GRANT)],
    ["a deployment that serves another model", { deployments: [dep({ fineTunedModelId: OTHER_MODEL_ID })] }, adapterPath(GRANT)],
    ["a deployment with no adapter", { deployments: [dep({ fineTunedModelId: null })] }, adapterPath(GRANT)],
    ["a deleted model", { deployments: [dep()], models: [ftm({ status: "deleted" })] }, adapterPath(GRANT)],
    ["a model of another organization than the deployment", { deployments: [dep()], models: [ftm({ orgId: OTHER_ORG })] }, adapterPath(GRANT)],
    ["no signature", { deployments: [dep()] }, `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}/adapter?d=${DEP_ID}&g=2`],
    ["no deployment", { deployments: [dep()] }, `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}/adapter?g=2&sig=${sig}`],
    ["a run number that is not a number", { deployments: [dep()] }, `${FINE_TUNED_MODELS_PREFIX}/${MODEL_ID}/adapter?d=${DEP_ID}&g=2e0&sig=${sig}`],
    ["a model id that is not an id", { deployments: [dep()] }, `${FINE_TUNED_MODELS_PREFIX}/nope/adapter?d=${DEP_ID}&g=2&sig=${sig}`],
  ];
  const answers = new Set<string>();
  for (const [what, seed, url] of cases) {
    // A session of the owning organization changes nothing either.
    for (const orgId of [null, ORG]) {
      const app = await makeApp({ db: makeDb(seed), store: store.store, orgId });
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 404, what);
      assert.equal(res.headers.location, undefined, what);
      answers.add(res.body);
      await app.close();
    }
  }
  assert.deepEqual([...answers], ['{"error":"not_found","message":"Not found"}'], "one answer for all of them");
  assert.deepEqual(store.calls, [], "storage was never asked");

  // And with storage not configured, a valid URL gets the same answer.
  const app = await makeApp({ db: makeDb({ deployments: [dep()] }), store: null, orgId: null });
  const res = await app.inject({ method: "GET", url: adapterPath(GRANT) });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body, [...answers][0]);
  await app.close();
});

test("adapter download: stopping the deployment revokes a URL that worked a moment ago", async () => {
  const db = makeDb({ deployments: [dep()] });
  const app = await makeApp({ db, store: presigningStore({ [ADAPTER_KEY]: Buffer.from("a") }).store, orgId: null });
  assert.equal((await app.inject({ method: "GET", url: adapterPath(GRANT) })).statusCode, 302);
  db.state.deployments[0]!.status = "stopped";
  assert.equal((await app.inject({ method: "GET", url: adapterPath(GRANT) })).statusCode, 404);
  // Restarted: the old URL stays dead, the new run's URL works.
  Object.assign(db.state.deployments[0]!, { status: "provisioning", runGeneration: 3 });
  assert.equal((await app.inject({ method: "GET", url: adapterPath(GRANT) })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: adapterPath({ ...GRANT, runGeneration: 3 }) })).statusCode, 302);
  await app.close();
});
