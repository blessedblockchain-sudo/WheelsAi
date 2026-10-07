import assert from "node:assert/strict";
import test from "node:test";

// Env must be in place BEFORE config/env.ts is imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

// The agent wizard stores "WheelsAI Hosted" models as `wheelsai/<model id>`,
// and nothing resolved that id: such an agent could not chat at all. It now
// resolves to the organization's own running deployment of the model, under
// the same admission rules as a /v1 request to that deployment.

const ORG = "org-1";
const NODE = "https://abc.node.k8s.prd.nos.ci";

function deployment(over: Record<string, unknown> = {}) {
  return {
    id: "dep-1",
    slug: "my-llama",
    engine: "vllm",
    gpuTier: "4090",
    replicas: 1,
    billedThroughAt: new Date(),
    nosanaJobIds: ["DeploymentManagerId1"],
    model: { hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" },
    nodes: [{ id: "n1", nodeUrl: NODE, healthStatus: "healthy", latencyMs: 10 }],
    ...over,
  };
}

function db(row: ReturnType<typeof deployment> | null, balanceCents = 10_000n) {
  const wheres: any[] = [];
  return {
    wheres,
    deployment: {
      findFirst: async (args: any) => {
        wheres.push(args);
        return row;
      },
    },
    creditBalance: { findUnique: async () => ({ balanceCents }) },
  } as any;
}

test("wheelsai/<id> resolves to the organization's own running deployment, through a healthy node", async () => {
  const { resolveHostedModel } = await import("../services/hostedModel.js");
  const fake = db(deployment());
  const res = await resolveHostedModel({ orgId: ORG, modelId: "wheelsai/llama-3.1-8b" }, fake);
  assert.ok(res.ok);
  assert.deepEqual(res.resolved, {
    apiKey: "",
    baseUrl: `${NODE}/v1`,
    modelName: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    refuseRedirects: true,
    streamUsage: true,
  });
  // fineTunedModelId null: a deployment that serves an adapter is not the base model.
  assert.deepEqual(fake.wheres[0].where, {
    orgId: ORG,
    modelId: "llama-3.1-8b",
    status: "running",
    fineTunedModelId: null,
  });

  // Ollama answers to its own tag.
  const ollama = await resolveHostedModel(
    { orgId: ORG, modelId: "wheelsai/llama-3.1-8b" },
    db(deployment({ engine: "ollama" })),
  );
  assert.ok(ollama.ok && ollama.resolved.modelName === "llama3.1:8b");
});

test("no running deployment, no healthy node and a node outside the allowlist are named refusals", async () => {
  const { resolveHostedModel } = await import("../services/hostedModel.js");
  const args = { orgId: ORG, modelId: "wheelsai/llama-3.1-8b" };

  const none = await resolveHostedModel(args, db(null));
  assert.ok(!none.ok);
  assert.match(none.message, /no running deployment/);

  const unhealthy = await resolveHostedModel(args, db(deployment({ nodes: [] })));
  assert.ok(!unhealthy.ok);
  assert.match(unhealthy.message, /no healthy node/);

  const offList = await resolveHostedModel(
    args,
    db(deployment({ nodes: [{ id: "n1", nodeUrl: "http://169.254.169.254", healthStatus: "healthy", latencyMs: 1 }] })),
  );
  assert.ok(!offList.ok, "a stored node URL is not trusted because it is stored");
  assert.ok(!offList.message.includes("169.254"));

  const empty = await resolveHostedModel({ orgId: ORG, modelId: "wheelsai/" }, db(deployment()));
  assert.ok(!empty.ok);
});

test("a deployment whose GPU time is not being paid for is not served to an agent either", async () => {
  const { resolveHostedModel } = await import("../services/hostedModel.js");
  const args = { orgId: ORG, modelId: "wheelsai/llama-3.1-8b" };
  const stale = deployment({ billedThroughAt: new Date(Date.now() - 600_000) });

  const unpaid = await resolveHostedModel(args, db(stale, 0n));
  assert.ok(!unpaid.ok);
  assert.match(unpaid.message, /unpaid/);

  const stalled = await resolveHostedModel(args, db(stale, 10_000n));
  assert.ok(!stalled.ok);
  assert.match(stalled.message, /has not been collected/);

  // Billed per request (the development mock): agent chat has no hold to
  // settle against it, so it is refused rather than served free.
  const mock = await resolveHostedModel(args, db(deployment({ nosanaJobIds: ["mock_deploy_abc"] })));
  assert.ok(!mock.ok);
  assert.match(mock.message, /billed per request/);
});

test("with the GPU billing worker off, a hosted model is refused, never served free", async () => {
  const { resetNosanaDeployConfigForTests } = await import("../config/nosanaDeploy.js");
  const { resolveHostedModel } = await import("../services/hostedModel.js");
  const before = process.env.GPU_BILLING_INTERVAL_MS;
  process.env.GPU_BILLING_INTERVAL_MS = "0";
  resetNosanaDeployConfigForTests();
  try {
    const res = await resolveHostedModel({ orgId: ORG, modelId: "wheelsai/llama-3.1-8b" }, db(deployment()));
    assert.ok(!res.ok);
    assert.equal(res.message, "Dedicated deployments are temporarily unavailable. Nothing was charged. Try again later.");
  } finally {
    if (before === undefined) delete process.env.GPU_BILLING_INTERVAL_MS;
    else process.env.GPU_BILLING_INTERVAL_MS = before;
    resetNosanaDeployConfigForTests();
  }
});

test("selectNode picks only healthy nodes and prefers the faster one", async () => {
  const { selectNode } = await import("../services/hostedModel.js");
  const nodes = [
    { id: "slow", nodeUrl: "a", healthStatus: "healthy", latencyMs: 900 },
    { id: "fast", nodeUrl: "b", healthStatus: "healthy", latencyMs: 10 },
    { id: "down", nodeUrl: "c", healthStatus: "unhealthy", latencyMs: 1 },
  ];
  assert.equal(selectNode([]), null);
  assert.equal(selectNode([nodes[2]!]), null);
  const picks = new Set<string>();
  for (let i = 0; i < 20; i++) picks.add(selectNode(nodes, () => i / 20)!.id);
  assert.ok(!picks.has("down"));
  // slow weighs 100, fast weighs 990: the first ~9% of the range is slow.
  assert.equal(selectNode(nodes, () => 0.05)!.id, "slow");
  assert.equal(selectNode(nodes, () => 0.5)!.id, "fast");
});

// ============================================
// Fine-tuned models
// ============================================

test("wheelsai/ft-<slug> resolves to the deployment that serves that fine-tuned model, asked for its adapter", async () => {
  const { resolveHostedModel } = await import("../services/hostedModel.js");
  const fake = db(deployment({ fineTunedModelId: "ftm-1", fineTunedModel: { slug: "support-tone" } }));
  const res = await resolveHostedModel({ orgId: ORG, modelId: "wheelsai/ft-support-tone" }, fake);
  assert.ok(res.ok);
  assert.equal(res.resolved.modelName, "ft-support-tone");
  assert.equal(res.resolved.baseUrl, `${NODE}/v1`);
  // The caller's organization twice: on the deployment and on the model.
  assert.deepEqual(fake.wheres[0].where, {
    orgId: ORG,
    status: "running",
    fineTunedModel: { orgId: ORG, liveSlug: "support-tone", status: "ready" },
  });
  assert.deepEqual(fake.wheres[0].include.fineTunedModel, { select: { slug: true } });

  const none = await resolveHostedModel({ orgId: ORG, modelId: "wheelsai/ft-support-tone" }, db(null));
  assert.ok(!none.ok);
  assert.match(none.message, /fine-tuned model "support-tone".*no running deployment/);

  // A slug that is not a slug is never looked up.
  for (const modelId of ["wheelsai/ft-", "wheelsai/ft-A B", "wheelsai/ft-a/../b"]) {
    const hostile = db(deployment());
    const refused = await resolveHostedModel({ orgId: ORG, modelId }, hostile);
    assert.ok(!refused.ok, modelId);
    assert.equal(hostile.wheres.length, 0, modelId);
  }
});

test("wheelsai/<base id> is asked for the base model's name, whatever the row carries", async () => {
  const { resolveHostedModel } = await import("../services/hostedModel.js");
  // The query excludes adapter deployments (fineTunedModelId: null, asserted
  // above); even a row that slipped through is asked for the base model.
  const res = await resolveHostedModel(
    { orgId: ORG, modelId: "wheelsai/llama-3.1-8b" },
    db(deployment({ fineTunedModel: { slug: "support-tone" } })),
  );
  assert.ok(res.ok);
  assert.equal(res.resolved.modelName, "meta-llama/Meta-Llama-3.1-8B-Instruct");
});
