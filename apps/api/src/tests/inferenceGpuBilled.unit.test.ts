import assert from "node:assert/strict";
import test from "node:test";

// Env must be in place BEFORE the route module (and config/env.ts) is imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

// Dedicated model deployments are billed per GPU-SECOND by the GPU billing
// worker (services/gpuBilling.ts): "billed per second at live market pricing".
// /v1/:deploymentSlug only serves the caller's own deployments, so for such a
// deployment the route must not ALSO take a per-token hold/charge or an x402
// payment - that would bill the same GPU twice. It keeps the admission checks
// that remain: the deployment is running, a healthy node exists, and the plan's
// API-call metering (the /v1 guard -> meterApiCall, untouched). A deployment the
// worker does NOT bill (the dev-only mock) keeps today's per-request billing.

interface Ledger {
  type: string;
  amountCents: bigint;
}

function makeDb(balance: bigint) {
  const state = {
    balance,
    ledger: [] as Ledger[],
    balanceReads: 0,
    x402Creates: 0,
    usage: [] as Array<{ costCents: bigint; errorCount: number; inputTokens: bigint }>,
    findFirstArgs: [] as any[],
    planLookups: 0,
    listingLookups: 0,
    nodeUpdates: [] as any[],
  };
  const creditBalance = {
    updateMany: async ({ where, data }: any) => {
      if (state.balance < where.balanceCents.gte) return { count: 0 };
      state.balance -= data.balanceCents.decrement;
      return { count: 1 };
    },
    update: async ({ data }: any) => {
      state.balance += data.balanceCents.increment;
      return { balanceCents: state.balance };
    },
    findUnique: async () => {
      state.balanceReads += 1;
      return { balanceCents: state.balance };
    },
  };
  const creditTransaction = {
    create: async ({ data }: any) => {
      state.ledger.push({ type: data.type, amountCents: data.amountCents });
      return data;
    },
  };
  const db = { creditBalance, creditTransaction };
  return { state, db };
}

function deploymentRow(over: Record<string, unknown> = {}) {
  return {
    id: "dep-1",
    name: "d",
    slug: "d",
    gpuTier: "4090",
    status: "running",
    nosanaJobIds: ["DeploymentManagerId1"],
    model: { pricingTier: "small", hfId: "x/y" },
    nodes: [
      { id: "n1", nodeUrl: "https://abc.node.k8s.prd.nos.ci", healthStatus: "healthy", latencyMs: 12 },
    ],
    ...over,
  };
}

async function v1App(opts: {
  balance: bigint;
  deployment: Record<string, unknown> | null;
  x402?: boolean;
  authed?: boolean;
  /** The caller's credential kind (request.auth.type). */
  authType?: "jwt" | "api_key";
  /** What the inference node answers. Default: a 200 chat completion. */
  nodeResponse?: () => Response;
}) {
  const { prisma } = await import("@wheelsai/db");
  const { env } = await import("../config/env.js");
  const { state, db } = makeDb(opts.balance);

  const patch: Record<string, unknown> = {
    deployment: {
      findFirst: async (args: any) => {
        state.findFirstArgs.push(args);
        return opts.deployment;
      },
    },
    // The removed token gate resolved a marketplace listing through this table.
    agentDeployment: {
      findFirst: async () => {
        state.listingLookups += 1;
        return {
          agent: {
            listing: {
              id: "listing_1",
              pricingModel: "tokenized",
              agentToken: { id: "tok_1", symbol: "TOK", mintAddress: "Mint1111111111111111111111111111111111111111" },
            },
          },
        };
      },
    },
    // The /v1 guard -> meterApiCall -> getOrgPlan. An enterprise plan has no call
    // cap, so the test needs no Redis; the lookup count proves the metering ran.
    orgSubscription: {
      findUnique: async () => {
        state.planLookups += 1;
        return { plan: "enterprise", status: "active" };
      },
    },
    creditBalance: db.creditBalance,
    creditTransaction: db.creditTransaction,
    deploymentNode: {
      update: async (args: any) => {
        state.nodeUpdates.push(args);
        return {};
      },
    },
    usageRecord: {
      upsert: async ({ create }: any) => {
        state.usage.push({
          costCents: create.costCents,
          errorCount: create.errorCount,
          inputTokens: create.inputTokens,
        });
        return {};
      },
    },
    x402Payment: {
      findUnique: async () => null,
      create: async () => {
        state.x402Creates += 1;
        return { id: "pay_1" };
      },
      update: async () => ({}),
    },
    $transaction: async (fn: any) => fn(db),
  };
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = (prisma as any)[k];
    (prisma as any)[k] = patch[k];
  }
  const envBefore = { enabled: (env as any).X402_ENABLED, mode: (env as any).X402_INFERENCE_MODE };
  if (opts.x402) {
    (env as any).X402_ENABLED = true;
    (env as any).X402_INFERENCE_MODE = "required";
    (env as any).X402_DEFAULT_ASSET = "USDC";
  }

  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { createInferenceRoutes } = await import("../routes/inference.js");
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      (request as any).auth =
        opts.authType === "api_key"
          ? { userId: null, orgId: "org-1", type: "api_key", apiKeyId: "key_1", scopes: ["*"] }
          : { userId: "u", orgId: "org-1", type: "jwt", role: "owner" };
    }
  });
  await app.register(createInferenceRoutes());

  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  const fetchInits: any[] = [];
  globalThis.fetch = (async (url: string, init?: any) => {
    fetched.push(String(url));
    fetchInits.push(init);
    if (opts.nodeResponse) return opts.nodeResponse();
    return new Response(
      JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        model: "x/y",
        choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as never;

  return {
    app,
    state,
    fetched,
    fetchInits,
    restore: async () => {
      globalThis.fetch = realFetch;
      await app.close();
      Object.assign(prisma as any, saved);
      (env as any).X402_ENABLED = envBefore.enabled;
      (env as any).X402_INFERENCE_MODE = envBefore.mode;
    },
  };
}

const chat = (app: any, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/d/chat/completions",
    headers,
    payload: { messages: [{ role: "user", content: "hello" }] },
  });

// ============================================
// GPU-billed deployments: no per-request charge
// ============================================

test("a GPU-billed deployment serves an org with ZERO credits: no hold, no per-token charge, no ledger row", async () => {
  const { app, state, fetched, restore } = await v1App({ balance: 0n, deployment: deploymentRow() });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 200, "not a 402: the GPU is paid per second by the worker, not per request");
    assert.equal(res.json().usage.completion_tokens, 80);
    assert.equal(fetched.length, 1, "the request reached the node");
    assert.ok(res.headers["x-request-id"], "request id still issued");

    assert.equal(state.balance, 0n);
    assert.deepEqual(state.ledger, [], "no `usage` hold, no settlement, no release");
    assert.equal(state.balanceReads, 0, "the credit balance is not even consulted for admission");
  } finally {
    await restore();
  }
});

test("a GPU-billed deployment with credits is not charged per token either", async () => {
  const { app, state, restore } = await v1App({ balance: 10_000n, deployment: deploymentRow() });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 200);
    assert.equal(state.balance, 10_000n, "the balance is untouched by the request");
    assert.deepEqual(state.ledger, []);
  } finally {
    await restore();
  }
});

test("the usage record shows a ZERO per-token charge for a GPU-billed request (metrics still recorded)", async () => {
  const { app, state, restore } = await v1App({ balance: 0n, deployment: deploymentRow() });
  try {
    await chat(app);
    await new Promise((resolve) => setTimeout(resolve, 20)); // recordUsage is fire-and-forget
    assert.equal(state.usage.length, 1, "request/token metrics are still recorded");
    assert.equal(state.usage[0]!.costCents, 0n, "costCents = what the ORG was charged for this request");
  } finally {
    await restore();
  }
});

test("x402 'required' mode does not demand a payment for a GPU-billed deployment", async () => {
  const { app, state, restore } = await v1App({ balance: 0n, deployment: deploymentRow(), x402: true });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 200, "no 402 x402 challenge: the GPU seconds are already billed");
    assert.ok(!res.headers["x-payment-required"]);
    assert.equal(state.x402Creates, 0, "no x402 payment row");
  } finally {
    await restore();
  }
});

test("a GPU-billed deployment still requires a HEALTHY node (503, nothing billed)", async () => {
  const { app, state, restore } = await v1App({ balance: 0n, deployment: deploymentRow({ nodes: [] }) });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(state.ledger, []);
  } finally {
    await restore();
  }
});

test("a GPU-billed deployment is still only served while it is RUNNING (the lookup filters status)", async () => {
  const { app, state, restore } = await v1App({ balance: 0n, deployment: null });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 404);
    const lookup = state.findFirstArgs.find((a: any) => a.where?.status !== undefined);
    assert.equal(lookup.where.status, "running", "stopped/degraded deployments are not served");
    assert.equal(lookup.where.orgId, "org-1", "only the caller's own deployments");
  } finally {
    await restore();
  }
});

test("the plan's API-call metering still runs for a GPU-billed request (the /v1 guard -> meterApiCall)", async () => {
  const { app, state, restore } = await v1App({ balance: 0n, deployment: deploymentRow() });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 200);
    assert.equal(state.planLookups, 1, "the org's plan was resolved to meter the call");
  } finally {
    await restore();
  }
});

test("authentication still gates /v1: an unauthenticated call never reaches a node or the plan meter", async () => {
  const { app, state, fetched, restore } = await v1App({ balance: 0n, deployment: deploymentRow(), authed: false });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 401);
    assert.equal(fetched.length, 0);
    assert.equal(state.planLookups, 0);
  } finally {
    await restore();
  }
});

// ============================================
// Deployments the worker does NOT bill keep per-request billing
// ============================================

test("a dev-MOCK deployment (never GPU-billed) keeps the credits hold: 402 without credits", async () => {
  const mock = deploymentRow({ nosanaJobIds: ["mock_deploy_abc"] });
  const { app, state, fetched, restore } = await v1App({ balance: 0n, deployment: mock });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 402);
    assert.equal(fetched.length, 0, "no GPU work without credit");
    assert.deepEqual(state.ledger, []);
  } finally {
    await restore();
  }
});

test("a dev-mock deployment with credits: hold -> settle to the actual per-token cost", async () => {
  const mock = deploymentRow({ nosanaJobIds: ["mock_deploy_abc"] });
  const { app, state, restore } = await v1App({ balance: 10_000n, deployment: mock });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 200);
    assert.ok(state.ledger.some((l) => l.type === "usage"), "a per-token hold was taken");
    assert.ok(state.balance < 10_000n, "and a per-token cost was charged");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(state.usage[0]!.costCents > 0n);
  } finally {
    await restore();
  }
});

test("a deployment with no Nosana id at all is not GPU-billed: per-request billing applies", async () => {
  const { app, restore } = await v1App({ balance: 0n, deployment: deploymentRow({ nosanaJobIds: [] }) });
  try {
    assert.equal((await chat(app)).statusCode, 402);
  } finally {
    await restore();
  }
});

test("x402 'required' still applies to a deployment that is not GPU-billed", async () => {
  const mock = deploymentRow({ nosanaJobIds: ["mock_job_abc"] });
  const { app, restore } = await v1App({ balance: 0n, deployment: mock, x402: true });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 402);
    assert.ok(res.headers["x-payment-required"], "the x402 challenge is unchanged for non-GPU-billed deployments");
  } finally {
    await restore();
  }
});

// ============================================
// The predicate
// ============================================

test("isGpuBilledDeployment: a real Nosana id, and only that", async () => {
  const { isGpuBilledDeployment } = await import("../services/nosanaIds.js");
  assert.equal(isGpuBilledDeployment({ nosanaJobIds: ["8kGjraXnXirSQcgjxTbFBK7QTBVz9fm9ufSRVr3DqBTV"] }), true);
  assert.equal(isGpuBilledDeployment({ nosanaJobIds: ["dm_1", "dm_2"] }), true);
  assert.equal(isGpuBilledDeployment({ nosanaJobIds: ["mock_deploy_x"] }), false);
  assert.equal(isGpuBilledDeployment({ nosanaJobIds: ["mock_job_x"] }), false);
  assert.equal(isGpuBilledDeployment({ nosanaJobIds: [] }), false);
  assert.equal(isGpuBilledDeployment({ nosanaJobIds: [""] }), false);
  assert.equal(isGpuBilledDeployment({ nosanaJobIds: null }), false);
  assert.equal(isGpuBilledDeployment({}), false);
});

test("the predicate matches exactly the rows the billing worker loads (real, non-mock id)", async () => {
  // buildGpuBillingTickDeps skips mock ids and rows with no id; /v1 must agree,
  // or a deployment could be billed by neither path (or by both).
  const { isGpuBilledDeployment, isMockNosanaId } = await import("../services/nosanaIds.js");
  for (const ids of [["real"], ["mock_deploy_1"], ["mock_job_1"], []]) {
    const workerBills = ids.length > 0 && !isMockNosanaId(ids[0]!);
    assert.equal(isGpuBilledDeployment({ nosanaJobIds: ids }), workerBills, JSON.stringify(ids));
  }
});

// ============================================
// No token gate on /v1: it only ever serves the caller's own deployments
// ============================================

test("the owner's API key reaches the handler even when a tokenized listing exists for the slug", async () => {
  // requireTokenHolding used to sit in front of this route. It resolved the
  // listing by slug with NO org (so another org's tokenized listing under the
  // same slug answered 403 here), and an API key carries no wallet, so it could
  // never pass. The only caller /v1 serves is the deployment's owner.
  const { app, state, fetched, restore } = await v1App({
    balance: 0n,
    deployment: deploymentRow(),
    authType: "api_key",
  });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 200, "not a 403 from a token gate");
    assert.equal(res.json().usage.completion_tokens, 80);
    assert.equal(fetched.length, 1, "the request reached the node");
    assert.equal(state.listingLookups, 0, "no marketplace-listing lookup happens on this route");
    assert.ok(
      state.findFirstArgs.every((a: any) => a.where?.orgId === "org-1"),
      "every deployment lookup is scoped to the caller's org - never by slug alone",
    );
  } finally {
    await restore();
  }
});

test("a JWT caller is not token-gated either", async () => {
  const { app, state, restore } = await v1App({ balance: 0n, deployment: deploymentRow() });
  try {
    assert.equal((await chat(app)).statusCode, 200);
    assert.equal(state.listingLookups, 0);
  } finally {
    await restore();
  }
});

// ============================================
// The node proxy never follows a redirect
// ============================================

test("/v1 never follows a node's redirect: one outbound request, 502, node demoted", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { app, state, fetched, fetchInits, restore } = await v1App({
      balance: 0n,
      deployment: deploymentRow(),
      nodeResponse: () =>
        new Response(null, { status, headers: { location: "http://127.0.0.1:4000/internal/admin" } }),
    });
    try {
      const res = await chat(app);
      assert.equal(res.statusCode, 502, `${status}`);
      assert.deepEqual(fetched, ["https://abc.node.k8s.prd.nos.ci/v1/chat/completions"], "the loopback target is never requested");
      assert.equal(fetchInits[0].redirect, "manual", "fetch is told not to follow");
      assert.ok(!JSON.stringify(res.json()).includes("127.0.0.1"), "the redirect target is not echoed to the caller");
      assert.equal(state.nodeUpdates[0]?.data.healthStatus, "unhealthy", "a node that redirects is taken out of rotation");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
        state.usage.map((u) => [u.errorCount, u.costCents]),
        [[1, 0n]],
        "recorded as a failed request, never as a served one",
      );
    } finally {
      await restore();
    }
  }
});

test("a redirecting node on a per-request-billed deployment gives the whole hold back", async () => {
  const mock = deploymentRow({ nosanaJobIds: ["mock_deploy_abc"] });
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: mock,
    nodeResponse: () => new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
  });
  try {
    assert.equal((await chat(app)).statusCode, 502);
    assert.equal(state.balance, 10_000n);
    assert.deepEqual(state.ledger.map((l) => l.type), ["usage", "usage_release"]);
  } finally {
    await restore();
  }
});

test("a node error keeps its status, is not relayed as a 200, and nothing is charged for it", async () => {
  const mock = deploymentRow({ nosanaJobIds: ["mock_deploy_abc"] });
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: mock,
    nodeResponse: () =>
      new Response(JSON.stringify({ detail: "internal stack trace" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 500, "the node's own status, not a blanket 502");
    assert.deepEqual(res.json().error, {
      message: "The inference node answered 500.",
      type: "server_error",
      param: null,
      code: "upstream_error",
    });
    assert.ok(!res.body.includes("stack trace"));
    assert.equal(state.balance, 10_000n, "the hold is released in full");
    assert.deepEqual(state.ledger.map((l) => l.type), ["usage", "usage_release"]);
  } finally {
    await restore();
  }
});

// ============================================
// "Included in the GPU bill" needs the GPU to be billed
// ============================================

test("with the per-second GPU billing worker disabled, a dedicated deployment is refused (503), never served free", async () => {
  const { resetNosanaDeployConfigForTests } = await import("../config/nosanaDeploy.js");
  const before = process.env.GPU_BILLING_INTERVAL_MS;
  process.env.GPU_BILLING_INTERVAL_MS = "0"; // the documented way to switch the worker off
  resetNosanaDeployConfigForTests();
  const { app, state, fetched, restore } = await v1App({ balance: 0n, deployment: deploymentRow() });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.reason, "gpu_billing_disabled", "a named reason");
    assert.equal(res.json().error.code, "service_unavailable");
    assert.equal(fetched.length, 0, "no GPU work");
    assert.deepEqual(state.ledger, [], "and no per-token billing as a fallback (the stop edge still bills the GPU seconds)");
    assert.equal(state.x402Creates, 0);
  } finally {
    await restore();
    if (before === undefined) delete process.env.GPU_BILLING_INTERVAL_MS;
    else process.env.GPU_BILLING_INTERVAL_MS = before;
    resetNosanaDeployConfigForTests();
  }
});

test("with the worker disabled, a deployment it would never bill anyway keeps per-request billing", async () => {
  const { resetNosanaDeployConfigForTests } = await import("../config/nosanaDeploy.js");
  const before = process.env.GPU_BILLING_INTERVAL_MS;
  process.env.GPU_BILLING_INTERVAL_MS = "0";
  resetNosanaDeployConfigForTests();
  const mock = deploymentRow({ nosanaJobIds: ["mock_deploy_abc"] });
  const { app, state, restore } = await v1App({ balance: 10_000n, deployment: mock });
  try {
    assert.equal((await chat(app)).statusCode, 200);
    assert.ok(state.ledger.some((l) => l.type === "usage"));
  } finally {
    await restore();
    if (before === undefined) delete process.env.GPU_BILLING_INTERVAL_MS;
    else process.env.GPU_BILLING_INTERVAL_MS = before;
    resetNosanaDeployConfigForTests();
  }
});

// ============================================
// GPU-billed admission is conditional on the GPU bill actually being collected
// ============================================

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

test("a deployment whose GPU time has gone uncollected is refused: 402 when the org cannot pay it, never served free", async () => {
  // The billing tick could not charge (zero balance) and could not stop the
  // deployment on Nosana either, so the row is still `running` and its cursor
  // has not moved for ten minutes. Before: every /v1 call was a 200.
  const { app, state, fetched, restore } = await v1App({
    balance: 0n,
    deployment: deploymentRow({ replicas: 1, billedThroughAt: secondsAgo(600) }),
  });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 402);
    // 600 s x 250 uUSD = 15 cents owed.
    assert.equal(res.json().error.requiredCents, 15);
    assert.equal(res.json().error.code, "insufficient_credits");
    assert.equal(res.headers["x-should-retry"], "false", "an SDK does not retry an unpaid bill");
    assert.deepEqual(fetched, [], "no node was contacted");
    assert.deepEqual(state.ledger, [], "an admission check: no hold, no ledger row");
    assert.equal(state.balance, 0n);
  } finally {
    await restore();
  }
});

test("uncollected GPU time the org COULD pay is a 503 gpu_billing_stalled, not a charge and not free service", async () => {
  const { app, state, fetched, restore } = await v1App({
    balance: 10_000n,
    deployment: deploymentRow({ replicas: 2, billedThroughAt: secondsAgo(600) }),
  });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.reason, "gpu_billing_stalled");
    assert.deepEqual(fetched, []);
    assert.equal(state.balance, 10_000n, "the route never bills GPU time itself");
    assert.deepEqual(state.ledger, []);
  } finally {
    await restore();
  }
});

test("a deployment whose billing is current is served on a ZERO balance without the balance being read", async () => {
  // One tick late plus a sub-cent remainder: ordinary, not arrears.
  const { app, state, restore } = await v1App({
    balance: 0n,
    deployment: deploymentRow({ replicas: 1, billedThroughAt: secondsAgo(100) }),
  });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 200);
    assert.equal(state.balanceReads, 0);
  } finally {
    await restore();
  }
});

test("gpuBillingArrears: a cent must have been due for three whole intervals; sub-cent time is never arrears", async () => {
  const { gpuBillingArrears } = await import("../services/gpuBilling.js");
  const now = new Date("2026-10-06T12:00:00.000Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  const check = (billedThroughAt: Date | null, over: Record<string, unknown> = {}) =>
    gpuBillingArrears({
      gpuTier: "4090", replicas: 1, billedThroughAt, now, billingIntervalMs: 60_000,
      pricePerSecondUsd: () => 0.00025, // 1 cent per 40 s
      ...over,
    });

  assert.equal(check(null), null, "no cursor yet");
  assert.equal(check(ago(100)), null, "a late tick");
  assert.equal(check(ago(219)), null, "39 s of it older than three intervals: under a cent");
  assert.deepEqual(check(ago(220)), { owedCents: 5n }, "a cent has been due for three intervals; 220 s = 5.5 cents owed");
  assert.deepEqual(check(ago(600), { replicas: 2 }), { owedCents: 30n });
  // A tier so cheap that a cent takes longer than the grace period is not in
  // arrears just because its cursor is old.
  assert.equal(check(ago(600), { pricePerSecondUsd: () => 0.00001 }), null);
  assert.equal(check(ago(600), { pricePerSecondUsd: () => 0 }), null, "a free tier owes nothing");
  assert.equal(check(ago(600), { billingIntervalMs: 0 }), null, "worker disabled: refused elsewhere (503 gpu_billing_disabled)");
});

// ============================================
// The model name the node is asked for
// ============================================

test("the node is asked for the model it serves, whatever name the caller sent", async () => {
  // vLLM answers only to the HF id it was started with; Ollama only to the
  // pulled tag. Callers name the deployment by its slug (as /v1/models lists
  // it) or leave `model` out.
  const cases: Array<[Record<string, unknown>, string | undefined, string]> = [
    [{ engine: "vllm", model: { pricingTier: "small", hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" } }, "d", "meta-llama/Meta-Llama-3.1-8B-Instruct"],
    [{ engine: "vllm", model: { pricingTier: "small", hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" } }, undefined, "meta-llama/Meta-Llama-3.1-8B-Instruct"],
    [{ engine: "ollama", model: { pricingTier: "small", hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" } }, "gpt-4o", "llama3.1:8b"],
  ];
  for (const [over, sent, served] of cases) {
    const { app, fetchInits, restore } = await v1App({ balance: 0n, deployment: deploymentRow(over) });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/d/chat/completions",
        payload: { ...(sent !== undefined && { model: sent }), messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(fetchInits[0].body).model, served);
    } finally {
      await restore();
    }
  }
});
