import assert from "node:assert/strict";
import test from "node:test";

import {
  DeploymentChatError,
  runDeploymentChat,
  type DeploymentChatDeps,
  type DeploymentChatRequest,
  type DeploymentForChat,
} from "../services/deploymentChat.js";
import type { GpuBillingBlock } from "../services/hostedModel.js";
import {
  holdInferenceCredits,
  releaseInferenceHold,
  settleInferenceHold,
  type InferenceHoldPrisma,
} from "../services/inferenceCreditHold.js";

// Drives services/deploymentChat.ts - the call a workflow's model step makes
// to one of the organization's model deployments - with a fake node and the
// REAL hold / settle / release functions over an in-memory balance and ledger.
// What is under test is the money: a GPU-billed deployment charges nothing
// here and is refused when its GPU time is not being collected; a per-request
// one holds before the node is called and then settles or releases, once.

const ORG = "org-1";

const DEPLOYMENT: DeploymentForChat = {
  id: "dep-1",
  name: "Llama",
  slug: "llama-prod",
  modelId: "llama-3.1-8b",
  engine: "vllm",
  gpuTier: "rtx-4090",
  replicas: 1,
  billedThroughAt: new Date(),
  nosanaJobIds: ["dm_real"],
  nodes: [{ id: "node-1", nodeUrl: "https://abc.node.k8s.prd.nos.ci", healthStatus: "healthy", latencyMs: 40 }],
  model: { hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct", pricingTier: "small" },
};
/** The development mock: never GPU-billed, so billed per request. */
const PER_REQUEST: DeploymentForChat = { ...DEPLOYMENT, nosanaJobIds: ["mock_deploy_1"] };

const completion = (content: string | null, usage: unknown = { prompt_tokens: 9, completion_tokens: 21 }) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: content ? "stop" : "length" }],
      // null = the node reports no usage at all.
      ...(usage !== null && { usage }),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

interface World {
  balance: bigint;
  ledger: Array<{ amountCents: bigint; type: string; description: string; referenceId: string; balanceAfter: bigint }>;
  events: string[];
  nodeCalls: Array<{ nodeUrl: string; body: Record<string, any>; signal: AbortSignal }>;
  usage: Array<Parameters<DeploymentChatDeps["recordUsage"]>[0]>;
  unhealthy: string[];
}

function harness(
  over: Partial<DeploymentChatDeps> & {
    deployment?: DeploymentForChat | null;
    balance?: bigint;
    block?: GpuBillingBlock | null;
    node?: () => Promise<Response>;
  } = {},
): { deps: DeploymentChatDeps; world: World } {
  const { deployment, balance, block, node, ...depOverrides } = over;
  const world: World = { balance: balance ?? 1_000n, ledger: [], events: [], nodeCalls: [], usage: [], unhealthy: [] };
  const db: InferenceHoldPrisma = {
    creditBalance: {
      updateMany: async ({ where, data }) => {
        if (world.balance < where.balanceCents.gte) return { count: 0 };
        world.balance -= data.balanceCents.decrement;
        return { count: 1 };
      },
      update: async ({ data }) => {
        world.balance += data.balanceCents.increment;
        return { balanceCents: world.balance };
      },
      findUnique: async () => ({ balanceCents: world.balance }),
    },
    creditTransaction: {
      create: async ({ data }) => {
        world.ledger.push(data);
        return data;
      },
    },
  };
  const row = deployment === undefined ? DEPLOYMENT : deployment;
  const deps: DeploymentChatDeps = {
    // Org-scoped and running-only, as the production query is.
    findRunningDeployment: async ({ orgId, deploymentId }) =>
      row && orgId === ORG && deploymentId === row.id ? row : null,
    isGpuBilled: (d) => !(d.nosanaJobIds?.[0] ?? "mock_").startsWith("mock_"),
    gpuBillingBlock: async () => {
      world.events.push("gpuBillingBlock");
      return block ?? null;
    },
    x402Required: () => false,
    balanceCents: async () => world.balance,
    hold: async (args) => {
      world.events.push("hold");
      return holdInferenceCredits(db, args);
    },
    settle: async (args) => {
      world.events.push("settle");
      return settleInferenceHold(db, args);
    },
    release: async (args) => {
      world.events.push("release");
      return releaseInferenceHold(db, args);
    },
    selectNode: (nodes) => nodes[0] ?? null,
    servedModelName: (_engine, hfId) => hfId,
    callNode: async (nodeUrl, body, signal) => {
      world.events.push("node");
      world.nodeCalls.push({ nodeUrl, body, signal });
      return node ? node() : completion("Hello from the node.");
    },
    markNodeUnhealthy: async (nodeId) => {
      world.unhealthy.push(nodeId);
    },
    recordUsage: async (args) => {
      world.usage.push(args);
    },
    idleTimeoutMs: 30_000,
    newRequestId: () => "req-1",
    ...depOverrides,
  };
  return { deps, world };
}

function request(over: Partial<DeploymentChatRequest> = {}): DeploymentChatRequest {
  return {
    orgId: ORG,
    deploymentId: "dep-1",
    messages: [{ role: "user", content: "Say hello." }],
    ...over,
  };
}

async function refusal(promise: Promise<unknown>): Promise<DeploymentChatError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof DeploymentChatError, `expected a DeploymentChatError, got ${String(err)}`);
    return err;
  }
  return assert.fail("expected the chat to be refused");
}

/** recordUsage is fire-and-forget: let the microtasks run. */
const settled = () => new Promise((resolve) => setImmediate(resolve));
const net = (world: World) => world.ledger.reduce((sum, row) => sum + row.amountCents, 0n);

// ============================================
// Scope
// ============================================

test("another organization's deployment is not found; nothing is held or called", async () => {
  const { deps, world } = harness();
  const err = await refusal(runDeploymentChat(request({ orgId: "org-2" }), deps));
  assert.equal(err.code, "deployment_not_running");
  assert.match(err.message, /does not exist in this organization or is not running/);
  assert.deepEqual(world.events, []);
});

test("a deployment that is not running is refused by name", async () => {
  const { deps, world } = harness({ deployment: null });
  assert.equal((await refusal(runDeploymentChat(request(), deps))).code, "deployment_not_running");
  assert.deepEqual(world.events, []);
});

test("a step that names a model the deployment does not serve is refused before anything is held", async () => {
  const { deps, world } = harness({ deployment: PER_REQUEST });
  const err = await refusal(runDeploymentChat(request({ modelId: "mistral-7b" }), deps));
  assert.equal(err.code, "model_mismatch");
  assert.match(err.message, /names the model "mistral-7b".*serves "llama-3\.1-8b"/);
  assert.deepEqual(world.events, []);

  // Any of the deployment's own names is accepted.
  for (const name of ["llama-3.1-8b", "meta-llama/Meta-Llama-3.1-8B-Instruct", "llama-prod"]) {
    const ok = harness();
    assert.equal((await runDeploymentChat(request({ modelId: name }), ok.deps)).content, "Hello from the node.");
  }
});

// ============================================
// GPU-billed deployments: included in their GPU time
// ============================================

test("a GPU-billed deployment answers with no hold, no charge and no ledger row", async () => {
  const { deps, world } = harness();
  const result = await runDeploymentChat(request(), deps);
  await settled();
  assert.equal(result.content, "Hello from the node.");
  assert.deepEqual(result.billing, { mode: "gpu_included", chargedCents: 0 });
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 21 });
  assert.deepEqual(world.events, ["gpuBillingBlock", "node"]);
  assert.equal(world.balance, 1_000n);
  assert.deepEqual(world.ledger, []);
  // Still counted in the deployment's usage, at zero cost.
  assert.equal(world.usage.length, 1);
  assert.deepEqual(
    { ...world.usage[0]!, latencyMs: 0 },
    {
      orgId: ORG,
      deploymentId: "dep-1",
      usage: { prompt_tokens: 9, completion_tokens: 21 },
      latencyMs: 0,
      costCents: 0,
      gpuTier: "rtx-4090",
      failed: false,
    },
  );
});

test("a GPU-billed deployment whose GPU time is not being collected is not served", async () => {
  const cases: Array<[GpuBillingBlock, string]> = [
    [
      { code: "service_unavailable", message: "Per-second GPU billing is not running on this server.", extra: { reason: "gpu_billing_disabled" } },
      "gpu_billing_unavailable",
    ],
    [
      { code: "service_unavailable", message: "Per-second GPU billing has not been collected.", extra: { reason: "gpu_billing_stalled" } },
      "gpu_billing_unavailable",
    ],
    [
      { code: "insufficient_credits", message: "The GPU time this deployment has used is unpaid.", extra: { requiredCents: 420 } },
      "insufficient_credits",
    ],
  ];
  for (const [block, code] of cases) {
    const { deps, world } = harness({ block });
    const err = await refusal(runDeploymentChat(request(), deps));
    assert.equal(err.code, code);
    assert.equal(err.message, block.message);
    assert.deepEqual(err.extra, block.extra);
    assert.deepEqual(world.events, ["gpuBillingBlock"], "the node is never called");
  }
});

test("a GPU-billed deployment is admitted without a credit balance check of its own", async () => {
  const { deps } = harness({ balance: 0n });
  assert.equal((await runDeploymentChat(request(), deps)).content, "Hello from the node.");
});

// ============================================
// Per-request deployments: hold, then settle or release, once
// ============================================

test("a per-request deployment holds the worst case before the node is called and settles to the node's count", async () => {
  const { deps, world } = harness({ deployment: PER_REQUEST });
  const result = await runDeploymentChat(request({ maxTokens: 4096 }), deps);
  await settled();
  assert.deepEqual(world.events, ["hold", "node", "settle"]);
  assert.equal(result.billing.mode, "credits");
  assert.equal(result.requestId, "req-1");

  // Every balance change has a ledger row whose balanceAfter is the balance.
  let running = 1_000n;
  for (const row of world.ledger) {
    running += row.amountCents;
    assert.equal(row.balanceAfter, running);
    assert.equal(row.referenceId, "req-1");
  }
  assert.equal(world.balance, running);
  assert.equal(net(world), -BigInt(result.billing.chargedCents), "the ledger nets to what was charged");
  assert.ok(world.ledger[0]!.amountCents < 0n, "the hold is the first row");
  assert.match(world.ledger[0]!.description, /^Inference: Llama \(hold\)$/);
  assert.equal(world.usage[0]!.costCents, result.billing.chargedCents);
});

test("a per-request deployment never consults the GPU-billing check", async () => {
  const { deps, world } = harness({ deployment: PER_REQUEST });
  await runDeploymentChat(request(), deps);
  assert.ok(!world.events.includes("gpuBillingBlock"));
});

test("an organization below the minimum balance is refused before any hold", async () => {
  for (const balance of [0n, 9n]) {
    const { deps, world } = harness({ deployment: PER_REQUEST, balance });
    const err = await refusal(runDeploymentChat(request(), deps));
    assert.equal(err.code, "insufficient_credits");
    assert.deepEqual(world.events, []);
    assert.equal(world.balance, balance);
  }
  const none = harness({ deployment: PER_REQUEST, balanceCents: async () => null });
  assert.equal((await refusal(runDeploymentChat(request(), none.deps))).code, "insufficient_credits");
});

test("a hold the balance cannot cover is refused: no debit, no ledger row, no node call", async () => {
  // Enough to be admitted (>= 10 cents), not enough for the worst case.
  const { deps, world } = harness({
    deployment: PER_REQUEST,
    balance: 10n,
    hold: async () => ({ ok: false, reason: "insufficient_credits", requiredCents: 37n }),
  });
  const err = await refusal(runDeploymentChat(request(), deps));
  assert.equal(err.code, "insufficient_credits");
  assert.deepEqual(err.extra, { requiredCents: 37 });
  assert.equal(world.balance, 10n);
  assert.deepEqual(world.ledger, []);
  assert.deepEqual(world.nodeCalls, []);
});

test("where x402 is required, a per-request deployment is refused by name, unpaid work never runs", async () => {
  const { deps, world } = harness({ deployment: PER_REQUEST, x402Required: () => true });
  const err = await refusal(runDeploymentChat(request(), deps));
  assert.equal(err.code, "x402_required");
  assert.match(err.message, /X402_INFERENCE_MODE=required/);
  assert.deepEqual(world.events, []);

  // A GPU-billed deployment is not per-request: x402 does not apply to it.
  const gpu = harness({ x402Required: () => true });
  assert.equal((await runDeploymentChat(request(), gpu.deps)).billing.mode, "gpu_included");
});

const FAILURES: Array<{
  name: string;
  node: () => Promise<Response>;
  code: string;
  message: RegExp;
  unhealthy: boolean;
}> = [
  {
    name: "a node that cannot be reached",
    node: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    code: "node_unreachable",
    message: /Failed to reach inference node/,
    unhealthy: true,
  },
  {
    name: "a node that redirects (refused, never followed)",
    node: async () => {
      throw new Error("Node answered with a redirect (307); refusing to follow it");
    },
    code: "node_unreachable",
    message: /Failed to reach inference node/,
    unhealthy: true,
  },
  {
    name: "a node that answers 500",
    node: async () => new Response("boom", { status: 500 }),
    code: "node_error",
    message: /The inference node answered 500\./,
    unhealthy: false,
  },
  {
    name: "a model server that rejects the request",
    node: async () => new Response(JSON.stringify({ object: "error", message: "context length exceeded" }), { status: 400 }),
    code: "node_error",
    message: /The model server rejected the request: context length exceeded/,
    unhealthy: false,
  },
  {
    name: "a 200 that is not JSON",
    node: async () => new Response("<html>", { status: 200 }),
    code: "invalid_answer",
    message: /not a completion/,
    unhealthy: false,
  },
  {
    name: "a 200 without choices",
    node: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    code: "invalid_answer",
    message: /not a completion/,
    unhealthy: false,
  },
];

for (const failure of FAILURES) {
  test(`${failure.name}: the whole hold is released, once, and the failure is named`, async () => {
    const { deps, world } = harness({ deployment: PER_REQUEST, node: failure.node });
    const err = await refusal(runDeploymentChat(request(), deps));
    await settled();
    assert.equal(err.code, failure.code);
    assert.match(err.message, failure.message);
    assert.deepEqual(world.events, ["hold", "node", "release"]);
    assert.equal(world.balance, 1_000n, "nothing was charged");
    assert.equal(net(world), 0n);
    assert.deepEqual(world.ledger.map((row) => row.type), ["usage", "usage_release"]);
    assert.deepEqual(world.unhealthy, failure.unhealthy ? ["node-1"] : []);
    // Counted as a failed request against the deployment.
    assert.equal(world.usage.length, 1);
    assert.equal(world.usage[0]!.failed, true);
    assert.equal(world.usage[0]!.costCents, 0);
  });
}

test("no healthy node: the hold is released and the node is never called", async () => {
  const { deps, world } = harness({ deployment: { ...PER_REQUEST, nodes: [] } });
  const err = await refusal(runDeploymentChat(request(), deps));
  assert.equal(err.code, "no_healthy_node");
  assert.deepEqual(world.events, ["hold", "release"]);
  assert.equal(world.balance, 1_000n);
});

test("a node that goes silent times out: released, and marked unhealthy", async () => {
  const { deps, world } = harness({
    deployment: PER_REQUEST,
    idleTimeoutMs: 20,
    callNode: (_url, _body, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  });
  const err = await refusal(runDeploymentChat(request(), deps));
  assert.equal(err.code, "node_timeout");
  assert.equal(world.balance, 1_000n);
  assert.deepEqual(world.unhealthy, ["node-1"]);
});

test("a node that reports no usage is charged on an estimate, never for free", async () => {
  const { deps, world } = harness({
    deployment: { ...PER_REQUEST, model: { ...PER_REQUEST.model, pricingTier: "large" } },
    node: async () => completion("x".repeat(40_000), null),
  });
  const result = await runDeploymentChat(request(), deps);
  await settled();
  assert.equal(result.usage, null, "an estimate is a billing basis, not a measurement");
  assert.ok(result.billing.chargedCents > 0);
  assert.equal(net(world), -BigInt(result.billing.chargedCents));
  assert.equal(world.usage[0]!.usage, null);
});

test("an empty answer is billed as generated and then fails by name", async () => {
  const { deps, world } = harness({ deployment: PER_REQUEST, node: async () => completion(null) });
  const err = await refusal(runDeploymentChat(request(), deps));
  assert.equal(err.code, "empty_answer");
  assert.match(err.message, /answered with no text \(finish reason: length\)/);
  // Settled, not released, and not released afterwards either.
  assert.deepEqual(world.events, ["hold", "node", "settle"]);
});

test("a settle that throws does not also release: the hold is closed exactly once", async () => {
  const { deps, world } = harness({
    deployment: PER_REQUEST,
    settle: async () => {
      world.events.push("settle");
      throw new Error("db blip");
    },
  });
  await assert.rejects(runDeploymentChat(request(), deps), /db blip/);
  assert.deepEqual(world.events, ["hold", "node", "settle"]);
});

// ============================================
// Abort
// ============================================

test("a run that is already cancelled holds nothing and calls nothing", async () => {
  const controller = new AbortController();
  const cancelled = new Error("run cancelled");
  controller.abort(cancelled);
  const { deps, world } = harness({ deployment: PER_REQUEST });
  await assert.rejects(runDeploymentChat(request({ signal: controller.signal }), deps), (err) => err === cancelled);
  assert.deepEqual(world.events, []);
});

test("an abort during the node call stops it, releases the hold and surfaces as the abort", async () => {
  const controller = new AbortController();
  const cancelled = new Error("run cancelled");
  const { deps, world } = harness({
    deployment: PER_REQUEST,
    callNode: (_url, _body, signal) =>
      new Promise((_resolve, reject) => {
        world.events.push("node");
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        setImmediate(() => controller.abort(cancelled));
      }),
  });
  await assert.rejects(runDeploymentChat(request({ signal: controller.signal }), deps), (err) => err === cancelled);
  await settled();
  assert.deepEqual(world.events, ["hold", "node", "release"]);
  assert.equal(world.balance, 1_000n);
  // The caller left; the node did nothing wrong.
  assert.deepEqual(world.unhealthy, []);
  assert.deepEqual(world.usage, []);
});

// ============================================
// The request the node receives
// ============================================

test("the node is asked for the engine's own model name, a bounded completion and no stream", async () => {
  const { deps, world } = harness();
  await runDeploymentChat(request({ temperature: 0.2 }), deps);
  const call = world.nodeCalls[0]!;
  assert.equal(call.nodeUrl, "https://abc.node.k8s.prd.nos.ci");
  assert.deepEqual(call.body, {
    temperature: 0.2,
    max_tokens: 4096,
    model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    messages: [{ role: "user", content: "Say hello." }],
    stream: false,
  });
});

test("a completion cap above the deployment limit is refused before the deployment is read", async () => {
  const { deps, world } = harness();
  for (const maxTokens of [0, 8193, 1.5]) {
    assert.equal((await refusal(runDeploymentChat(request({ maxTokens }), deps))).code, "invalid_request");
  }
  assert.deepEqual(world.events, []);
});
