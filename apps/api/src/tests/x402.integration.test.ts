import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import Fastify from "fastify";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
  // The node these tests talk to is a stand-in on this machine. The route
  // lets a node on localhost through only in a development process that
  // says so (services/nodeUrlAllowlist.ts).
  process.env.ALLOW_LOOPBACK_NODE_URLS = process.env.ALLOW_LOOPBACK_NODE_URLS ?? "true";
}

test("x402 handshake and paid inference flow", async () => {
  setupEnv();

  const [{ createInferenceRoutes }, { env }, { prisma }] = await Promise.all([
    import("../routes/inference.js"),
    import("../config/env.js"),
    import("@wheelsai/db"),
  ]);

  (env as any).X402_ENABLED = true;
  (env as any).X402_INFERENCE_MODE = "required";
  (env as any).X402_DEFAULT_ASSET = "USDC";

  const prismaAny = prisma as any;
  const originalMethods = {
    deploymentFindFirst: prismaAny.deployment.findFirst,
    creditBalanceFindUnique: prismaAny.creditBalance.findUnique,
    usageRecordUpsert: prismaAny.usageRecord.upsert,
  };

  // What becomes of a payment (read, claimed, sent, served or returned) is
  // services/x402Payments.ts, covered with stand-ins in
  // x402Payments.unit.test.ts and x402InferenceRoute.unit.test.ts. Here it
  // is a stand-in itself: this test is the handshake through the route.
  const takenPayments: Array<{ requestId: string; signature: string; hasHealthyNode: boolean }> = [];
  const servedPayments: string[] = [];
  const returnedPayments: string[] = [];

  prismaAny.deployment.findFirst = async () => ({
    id: "dep_1",
    slug: "demo",
    name: "Demo Deployment",
    status: "running",
    // A deployment the GPU billing worker does NOT bill (here: the dev-only
    // mock). Real Nosana deployments are billed per GPU-second and never take
    // an x402 payment on /v1 (see inferenceGpuBilled.unit.test.ts).
    nosanaJobIds: ["mock_deploy_x402test"],
    model: { pricingTier: "small", hfId: "demo/model" },
    nodes: [
      {
        id: "node_1",
        nodeUrl: "http://localhost:9999",
        healthStatus: "healthy",
        latencyMs: 15,
      },
    ],
  });
  prismaAny.creditBalance.findUnique = async () => ({ orgId: "org_1", balanceCents: BigInt(0) });
  prismaAny.usageRecord.upsert = async () => ({ id: "usage_1" });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = {
      userId: "user_1",
      orgId: "org_1",
      type: "jwt",
    };
  });

  const x402 = {
    requirement: async (scope: { deploymentId: string; requestId: string }) => ({
      scheme: "exact" as const,
      network: "solana:devnet" as const,
      asset: "USDC" as const,
      amount: "1000",
      amountUsd: 0.001,
      payTo: "treasury_1",
      payToTokenAccount: "treasury_usdc_1",
      mint: "usdc_mint_1",
      memo: `deployment:${scope.deploymentId};request:${scope.requestId}`,
      validUntil: Math.floor(Date.now() / 1000) + 120,
      quote: null,
    }),
    take: async (input: { requestId: string; header: { signature: string }; hasHealthyNode: boolean }) => {
      takenPayments.push({
        requestId: input.requestId,
        signature: input.header.signature,
        hasHealthyNode: input.hasHealthyNode,
      });
      return { outcome: "taken" as const, paymentId: "pay_1" };
    },
    served: async (paymentId: string) => {
      servedPayments.push(paymentId);
      return true;
    },
    returned: async (paymentId: string) => {
      returnedPayments.push(paymentId);
      return { returned: false as const, reason: "already_ended" as const };
    },
  };

  await app.register(createInferenceRoutes({ x402 }));

  const requestPayload = {
    messages: [{ role: "user", content: "Hello world" }],
  };

  const firstAttempt = await app.inject({
    method: "POST",
    url: "/v1/demo/chat/completions",
    payload: requestPayload,
  });
  assert.equal(firstAttempt.statusCode, 402);
  assert.ok(firstAttempt.headers["x-payment-required"]);

  const paymentRequirement = JSON.parse(
    String(firstAttempt.headers["x-payment-required"])
  );
  const secondAttempt = await app.inject({
    method: "POST",
    url: "/v1/demo/chat/completions",
    payload: requestPayload,
    headers: {
      "x-payment": JSON.stringify({
        signature: Buffer.from("mock_signature").toString("base64"),
        network: paymentRequirement.network,
      }),
      "x-request-id": "req_test_1",
    },
  });

  assert.equal(secondAttempt.statusCode, 200);
  assert.equal(takenPayments.length, 1);
  assert.equal(takenPayments[0]?.requestId, "req_test_1");
  assert.equal(takenPayments[0]?.signature, Buffer.from("mock_signature").toString("base64"));
  assert.equal(takenPayments[0]?.hasHealthyNode, true);
  // An answer was produced: the payment is marked served, never returned.
  // "settled" is reserved for the settlement worker, once it is final.
  assert.deepEqual(servedPayments, ["pay_1"]);
  assert.deepEqual(returnedPayments, []);

  await app.close();
  globalThis.fetch = originalFetch;

  prismaAny.deployment.findFirst = originalMethods.deploymentFindFirst;
  prismaAny.creditBalance.findUnique = originalMethods.creditBalanceFindUnique;
  prismaAny.usageRecord.upsert = originalMethods.usageRecordUpsert;
});

test("x402 settlement tick updates counters and statuses", async () => {
  setupEnv();

  const [{ runX402SettlementTick, getX402SettlementWorkerMetrics }, { env }, { prisma }] =
    await Promise.all([
      import("../services/x402Settlement.js"),
      import("../config/env.js"),
      import("@wheelsai/db"),
    ]);

  (env as any).X402_SUBMIT_TRANSACTIONS = false;
  (env as any).X402_SETTLEMENT_BATCH_SIZE = 25;
  (env as any).X402_METRICS_PRUNE_INTERVAL_MINUTES = 1;
  (env as any).X402_ALERT_WEBHOOK_URL = "https://alerts.example.test/x402";
  (env as any).X402_ALERT_WEBHOOK_SECRET = "test_alert_secret";
  (env as any).X402_ALERT_NOTIFY_COOLDOWN_MINUTES = 30;
  (env as any).X402_ALERT_MAX_RETRIABLE = 1;

  const now = new Date();
  const prismaAny = prisma as any;
  const originalMethods = {
    findMany: prismaAny.x402Payment.findMany,
    updateMany: prismaAny.x402Payment.updateMany,
    groupBy: prismaAny.x402Payment.groupBy,
    x402PaymentCount: prismaAny.x402Payment.count,
    x402PaymentFindFirst: prismaAny.x402Payment.findFirst,
    executeRaw: prismaAny.$executeRaw,
  };

  const updates: Array<{ where: any; data: any }> = [];
  let executeRawCalls = 0;
  let alertWebhookCalls = 0;
  let lastWebhookHeaders: Record<string, string> = {};
  let lastWebhookBody = "";

  prismaAny.x402Payment.findMany = async () => [
    {
      id: "pay_verified",
      orgId: "org_1",
      deploymentId: "dep_1",
      agentDeploymentId: null,
      requestId: "req_1",
      network: "solana:devnet",
      asset: "USDC",
      amountRaw: "1000",
      amountUsd: 0.001,
      payerAddress: "payer_1",
      payeeAddress: "payee_1",
      txSignature: "sig_1",
      status: "verified",
      verifiedAt: now,
      // The request was answered: with broadcasting off it settles at once.
      servedAt: now,
      refundedAt: null,
      submittedAt: null,
      recentBlockhash: null,
      settledAt: null,
      failureReason: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "pay_pending",
      orgId: "org_1",
      deploymentId: "dep_1",
      agentDeploymentId: null,
      requestId: "req_2",
      network: "solana:devnet",
      asset: "USDC",
      amountRaw: "1000",
      amountUsd: 0.001,
      payerAddress: "payer_2",
      payeeAddress: "payee_1",
      txSignature: "sig_2",
      // Sent, and not yet known to have landed: only the chain may say, and
      // with broadcasting off the chain is not asked. Left as it is.
      status: "submitted",
      verifiedAt: null,
      servedAt: null,
      refundedAt: null,
      submittedAt: now,
      recentBlockhash: "blockhash_2",
      settledAt: null,
      failureReason: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  ];
  prismaAny.x402Payment.updateMany = async ({ where, data }: any) => {
    updates.push({ where, data });
    return { count: 1 };
  };
  prismaAny.x402Payment.groupBy = async () => [{ orgId: "org_1" }];
  prismaAny.x402Payment.count = async ({ where }: any) => {
    if (where?.status?.in) return 1;
    if (where?.status === "verified") return 1;
    if (where?.status === "settled") return 0;
    if (where?.status === "failed") return 0;
    return 2;
  };
  prismaAny.x402Payment.findFirst = async ({ where }: any) => {
    if (where?.status?.in) {
      return { createdAt: new Date(Date.now() - 5 * 60 * 1000) };
    }
    return null;
  };
  prismaAny.$executeRaw = async () => {
    executeRawCalls += 1;
    return 1;
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    alertWebhookCalls += 1;
    if (init?.headers) {
      const headers = new Headers(init.headers);
      const timestamp = headers.get("x-wheelsai-alert-timestamp");
      const signature = headers.get("x-wheelsai-alert-signature");
      const algorithm = headers.get("x-wheelsai-alert-signature-alg");
      lastWebhookHeaders = {
        ...(timestamp ? { "x-wheelsai-alert-timestamp": timestamp } : {}),
        ...(signature ? { "x-wheelsai-alert-signature": signature } : {}),
        ...(algorithm ? { "x-wheelsai-alert-signature-alg": algorithm } : {}),
      };
    }
    if (typeof init?.body === "string") {
      lastWebhookBody = init.body;
    }
    return new Response("", { status: 200 });
  };

  const before = getX402SettlementWorkerMetrics();
  await runX402SettlementTick();
  const after = getX402SettlementWorkerMetrics();

  assert.ok(after.ticks >= before.ticks + 1);
  assert.ok(after.processed >= before.processed + 2);
  assert.ok(
    updates.some((update) => update.where?.id === "pay_verified" && update.data?.status === "settled")
  );
  // No count of attempts ends a row: the one the chain has said nothing
  // about is not written to at all.
  assert.ok(!updates.some((update) => update.where?.id === "pay_pending"));
  assert.ok(after.retried >= before.retried + 1);
  assert.ok(executeRawCalls >= 2);
  assert.equal(alertWebhookCalls, 1);
  const webhookTimestamp = lastWebhookHeaders["x-wheelsai-alert-timestamp"];
  assert.ok(webhookTimestamp);
  const webhookSignature = lastWebhookHeaders["x-wheelsai-alert-signature"];
  assert.ok(webhookSignature?.startsWith("v1="));
  assert.equal(
    webhookSignature,
    `v1=${createHmac("sha256", "test_alert_secret")
      .update(`${webhookTimestamp}.${lastWebhookBody}`)
      .digest("hex")}`
  );
  assert.equal(
    lastWebhookHeaders["x-wheelsai-alert-signature-alg"],
    "hmac-sha256"
  );

  prismaAny.x402Payment.findMany = originalMethods.findMany;
  prismaAny.x402Payment.updateMany = originalMethods.updateMany;
  prismaAny.x402Payment.groupBy = originalMethods.groupBy;
  prismaAny.x402Payment.count = originalMethods.x402PaymentCount;
  prismaAny.x402Payment.findFirst = originalMethods.x402PaymentFindFirst;
  prismaAny.$executeRaw = originalMethods.executeRaw;
  globalThis.fetch = originalFetch;
});

test("x402 metrics retention prune deletes rows older than configured days", async () => {
  setupEnv();

  const [{ pruneX402SettlementMetricsHistory }, { env }, { prisma }] =
    await Promise.all([
      import("../services/x402Settlement.js"),
      import("../config/env.js"),
      import("@wheelsai/db"),
    ]);

  (env as any).X402_METRICS_RETENTION_DAYS = 7;

  const prismaAny = prisma as any;
  const originalExecuteRaw = prismaAny.$executeRaw;

  let capturedTemplate = "";
  let capturedRetentionDays: number | null = null;

  prismaAny.$executeRaw = async (strings: TemplateStringsArray, ...values: any[]) => {
    capturedTemplate = strings.join(" ");
    capturedRetentionDays = values[0] ?? null;
    return 42;
  };

  const deletedRows = await pruneX402SettlementMetricsHistory();

  assert.equal(deletedRows, 42);
  assert.equal(capturedRetentionDays, 7);
  assert.ok(capturedTemplate.includes('DELETE FROM "x402_settlement_metrics"'));

  prismaAny.$executeRaw = originalExecuteRaw;
});

test("x402 metrics history endpoint returns trend rows", async () => {
  setupEnv();

  const [{ x402Routes }, { prisma }] = await Promise.all([
    import("../routes/x402.js"),
    import("@wheelsai/db"),
  ]);

  const now = new Date();
  const prismaAny = prisma as any;
  const originalMethods = {
    queryRaw: prismaAny.$queryRaw,
  };

  prismaAny.$queryRaw = async () => [
    {
      timestamp: now,
      total_payments: 20,
      pending_payments: 3,
      verified_payments: 2,
      settled_payments: 14,
      failed_payments: 1,
      retriable_payments: 5,
      failure_rate_percent: 5,
      oldest_pending_minutes: 7,
      alert_count: 1,
      alerts: [{ code: "pending_high", severity: "warning" }],
      worker_ticks: 10,
      worker_processed: 20,
      worker_settled: 15,
      worker_failed: 1,
      worker_retried: 4,
      worker_skipped: 0,
    },
  ];

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = {
      userId: "user_1",
      orgId: "org_1",
      type: "jwt",
    };
  });

  await app.register(x402Routes, { prefix: "/api/x402" });

  const response = await app.inject({
    method: "GET",
    url: "/api/x402/metrics/history?hours=12&limit=10",
  });

  assert.equal(response.statusCode, 200);
  const parsed = response.json();
  assert.equal(parsed.history.length, 1);
  assert.equal(parsed.history[0]?.pendingPayments, 3);
  assert.equal(parsed.history[0]?.worker?.processed, 20);

  await app.close();
  prismaAny.$queryRaw = originalMethods.queryRaw;
});
