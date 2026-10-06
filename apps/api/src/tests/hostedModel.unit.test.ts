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
  assert.deepEqual(fake.wheres[0].where, { orgId: ORG, modelId: "llama-3.1-8b", status: "running" });

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
    assert.match(res.message, /GPU billing is not running/);
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
