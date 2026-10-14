import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import { bindX402Payments } from "../services/x402Payments.js";
import {
  NODE_TEXT,
  TREASURY,
  TREASURY_USDC_ACCOUNT,
  USDC_MINT_TEST,
  makeWorld,
  solPayment,
  usdcPayment,
  type World,
} from "./x402StandIns.js";

// x402 through the real route (POST /v1/:slug/chat/completions), with the
// chain and the database as stand-ins: what a payer is answered at every
// turn, and that no word of a node, of the database or of a thrown error is
// in any of it.

const PRISMA_TEXT = "PRISMA-SAID: Invalid `prisma.x402Payment.create()` invocation";

interface AppOptions {
  world: World;
  /** The deployment's nodes. Default: one healthy node. */
  nodes?: unknown[];
  /** What the inference node answers. Default: a 200 chat completion. */
  nodeResponse?: () => Response;
  mode?: "required" | "fallback";
  balanceCents?: bigint;
}

async function v1App(opts: AppOptions) {
  const { prisma } = await import("@wheelsai/db");
  const { env } = await import("../config/env.js");
  const state = { nodeCalls: 0, creditWrites: 0 };

  const patch: Record<string, unknown> = {
    deployment: {
      findFirst: async () => ({
        id: "dep-1",
        name: "d",
        slug: "d",
        gpuTier: "4090",
        status: "running",
        engine: "vllm",
        // Not billed per GPU-second: x402 applies.
        nosanaJobIds: ["mock_job_x402"],
        model: { pricingTier: "small", hfId: "x/y" },
        nodes: opts.nodes ?? [
          { id: "n1", nodeUrl: "https://abc.node.k8s.prd.nos.ci", healthStatus: "healthy", latencyMs: 12 },
        ],
      }),
    },
    creditBalance: {
      findUnique: async () => ({ balanceCents: opts.balanceCents ?? 0n }),
      updateMany: async () => {
        state.creditWrites += 1;
        return { count: 0 };
      },
      update: async () => {
        state.creditWrites += 1;
        return { balanceCents: 0n };
      },
    },
    deploymentNode: { update: async () => ({}) },
    usageRecord: { upsert: async () => ({}) },
    // The route must reach payments through the injected x402 only.
    x402Payment: new Proxy(
      {},
      {
        get() {
          throw new Error("the route touched prisma.x402Payment directly");
        },
      },
    ),
  };
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = (prisma as any)[k];
    (prisma as any)[k] = patch[k];
  }
  const envBefore = { enabled: (env as any).X402_ENABLED, mode: (env as any).X402_INFERENCE_MODE };
  (env as any).X402_ENABLED = true;
  (env as any).X402_INFERENCE_MODE = opts.mode ?? "required";

  const Fastify = (await import("fastify")).default;
  const { createInferenceRoutes } = await import("../routes/inference.js");
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "u", orgId: "org-1", type: "jwt", role: "owner" };
  });
  await app.register(
    createInferenceRoutes({
      x402: bindX402Payments(opts.world.deps),
      auth: async () => {},
      recordLatency: () => {},
    }),
  );

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    state.nodeCalls += 1;
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
    payload: { messages: [{ role: "user", content: "hello" }], max_tokens: 256 },
  });

const paid = (signedTx: string, quote?: string | null) => ({
  "x-payment": JSON.stringify({ signature: signedTx, network: "solana:devnet", ...(quote && { quote }) }),
});

/** Nothing a node, the database or a thrown error said is in the answer. */
function assertOurWordsOnly(res: { body: string; headers: Record<string, unknown> }) {
  const everything = res.body + JSON.stringify(res.headers);
  for (const foreign of [NODE_TEXT, "RPC-NODE-SAID", PRISMA_TEXT, "PRISMA-SAID", "prisma", "Error:", "at async"]) {
    assert.ok(!everything.includes(foreign), `the answer carries "${foreign}"`);
  }
}

test("an unpaid request is answered 402 with the USDC payment: wallet, token account, mint, and no reason", async () => {
  const world = makeWorld();
  const { app, state, restore } = await v1App({ world });
  try {
    const res = await chat(app);
    assert.equal(res.statusCode, 402);
    const body = res.json();
    assert.deepEqual(JSON.parse(String(res.headers["x-payment-required"])), body.payment);
    assert.deepEqual(Object.keys(body.payment).sort(), [
      "amount",
      "amountUsd",
      "asset",
      "memo",
      "mint",
      "network",
      "payTo",
      "payToTokenAccount",
      "quote",
      "scheme",
      "validUntil",
    ]);
    assert.equal(body.payment.scheme, "exact");
    assert.equal(body.payment.network, "solana:devnet");
    assert.equal(body.payment.asset, "USDC");
    assert.match(body.payment.amount, /^[1-9][0-9]*$/);
    assert.equal(body.payment.amountUsd, Number(body.payment.amount) / 1_000_000);
    assert.equal(body.payment.payTo, TREASURY);
    assert.equal(body.payment.payToTokenAccount, TREASURY_USDC_ACCOUNT);
    assert.equal(body.payment.mint, USDC_MINT_TEST);
    assert.equal(body.payment.quote, null);
    assert.equal(body.payment.memo, `deployment:dep-1;request:${body.requestId}`);
    assert.equal(body.reason, undefined);
    assert.equal(body.error.code, "x402_payment_required");
    // The deployment's own wire is not the published x402 format, so its sentence does not call it x402.
    assert.equal(
      body.error.message,
      "This request needs a payment from a Solana wallet. The X-Payment-Required header says how much and where to send it.",
    );
    assert.equal(res.headers["x-request-id"], body.requestId);
    assert.equal(state.nodeCalls, 0);
    assert.equal(world.db.payments.size, 0);
  } finally {
    await restore();
  }
});

test("paying what the 402 asked, by checked transfer, is served: the row is 'verified' and marked served", async () => {
  const world = makeWorld();
  const { app, state, restore } = await v1App({ world });
  try {
    const challenge = (await chat(app)).json().payment;
    const res = await chat(app, {
      ...paid(usdcPayment({ amount: BigInt(challenge.amount) })),
      "x-request-id": "req-paid-1",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().choices[0].message.content, "hi there");
    assert.equal(res.headers["x-request-id"], "req-paid-1");
    assert.equal(state.nodeCalls, 1);
    assert.deepEqual(world.trail, ["insert:submitted", "broadcast", "fate"]);
    const row = world.db.only();
    assert.equal(row.status, "verified");
    assert.equal(row.requestId, "req-paid-1");
    assert.equal(row.amountRaw, challenge.amount);
    assert.ok(row.servedAt instanceof Date);
    assert.equal(row.refundedAt, null);
    assert.equal(state.creditWrites, 0, "a request paid by x402 holds and charges no credits");
  } finally {
    await restore();
  }
});

test("SOL: the 402 carries the rate lock, and the retry is priced at it though the live price has moved", async () => {
  const world = makeWorld({ defaultAsset: "SOL" });
  world.solRate = 150_000_000n;
  const { app, restore } = await v1App({ world });
  try {
    const challenge = (await chat(app)).json().payment;
    assert.equal(challenge.asset, "SOL");
    assert.equal(challenge.payTo, TREASURY);
    assert.equal(challenge.payToTokenAccount, null);
    assert.equal(challenge.mint, null);
    assert.equal(typeof challenge.quote, "string");

    world.solRate = 60_000_000n; // SOL falls: the same request now costs more lamports
    const signedTx = solPayment({ lamports: BigInt(challenge.amount) });
    const res = await chat(app, paid(signedTx, challenge.quote));
    assert.equal(res.statusCode, 200);
    const row = world.db.only();
    assert.equal(row.asset, "SOL");
    assert.equal(row.solMicroUsdPerSol, 150_000_000n);

    // The same payment without its lock: a fresh 402, and nothing more is sent.
    const again = await chat(app, paid(solPayment({ lamports: BigInt(challenge.amount) })));
    assert.equal(again.statusCode, 402);
    assert.equal(again.json().reason, "quote_expired");
    assert.equal(
      again.json().error.message,
      "The price for this request has expired. Send the request again to get a new one.",
    );
    assert.equal(again.json().payment.asset, "SOL");
    assert.notEqual(again.json().payment.amount, challenge.amount, "the fresh challenge is at the new rate");
    assert.equal(world.broadcasts.length, 1);
  } finally {
    await restore();
  }
});

test("with no SOL price the 402 offers USDC", async () => {
  const world = makeWorld({ defaultAsset: "SOL" });
  world.solRate = null;
  const { app, restore } = await v1App({ world });
  try {
    const payment = (await chat(app)).json().payment;
    assert.equal(payment.asset, "USDC");
    assert.equal(payment.payToTokenAccount, TREASURY_USDC_ACCOUNT);
    assert.equal(payment.quote, null);
  } finally {
    await restore();
  }
});

test("a payment that does not pay is refused with a fresh 402 and our sentence; nothing is broadcast", async () => {
  const world = makeWorld();
  const { app, state, restore } = await v1App({ world });
  try {
    for (const header of [
      paid(usdcPayment({ amount: 1n })),
      paid(Buffer.from("mock_signature").toString("base64")),
      { "x-payment": "this is not json" },
    ]) {
      const res = await chat(app, header);
      assert.equal(res.statusCode, 402);
      const body = res.json();
      assert.equal(body.reason, "payment_invalid");
      assert.equal(
        body.error.message,
        "That payment does not match this request. Check the address, the asset and the amount, and send the request again.",
      );
      assert.ok(body.payment.amount);
      assertOurWordsOnly(res);
    }
    assert.equal(world.broadcasts.length, 0);
    assert.equal(world.db.payments.size, 0);
    assert.equal(state.nodeCalls, 0);
  } finally {
    await restore();
  }
});

test("the same signature a second time is 409 payment_already_used", async () => {
  const world = makeWorld();
  const { app, state, restore } = await v1App({ world });
  try {
    const signedTx = usdcPayment({ amount: 1_000_000n });
    assert.equal((await chat(app, paid(signedTx))).statusCode, 200);
    const res = await chat(app, paid(signedTx));
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "payment_already_used");
    assert.equal(res.json().error.paymentId, world.db.only().id);
    assert.equal(world.broadcasts.length, 1);
    assert.equal(state.nodeCalls, 1);
  } finally {
    await restore();
  }
});

test("the send fails with a node's words and the chain says nothing: 402 payment_not_confirmed, in our words", async () => {
  const world = makeWorld({ confirmWaitMs: 3_000 });
  world.broadcastThrows = true;
  world.fates = ["unknown"];
  const { app, state, restore } = await v1App({ world });
  try {
    const res = await chat(app, paid(usdcPayment({ amount: 1_000_000n })));
    assert.equal(res.statusCode, 402);
    const body = res.json();
    assert.equal(body.reason, "payment_not_confirmed");
    assert.equal(
      body.error.message,
      "Your payment was not confirmed in time. If it lands, it is returned to your credit balance. Send the request again.",
    );
    assertOurWordsOnly(res);
    assert.equal(world.db.only().status, "submitted");
    assert.equal(state.nodeCalls, 0, "the request is not served on a payment that is not known to have landed");
  } finally {
    await restore();
  }
});

test("a payment that landed and failed: 402 payment_failed_on_chain, and nothing is returned because nothing was taken", async () => {
  const world = makeWorld();
  world.fates = ["landed_failed"];
  const { app, state, restore } = await v1App({ world });
  try {
    const res = await chat(app, paid(usdcPayment({ amount: 1_000_000n })));
    assert.equal(res.statusCode, 402);
    assert.equal(res.json().reason, "payment_failed_on_chain");
    assert.equal(
      res.json().error.message,
      "Your payment failed on the chain and nothing was taken. Send the request again.",
    );
    assert.equal(world.db.only().status, "failed");
    assert.equal(world.db.balances.size, 0);
    assert.equal(state.nodeCalls, 0);
  } finally {
    await restore();
  }
});

test("no healthy node: 503 as before, and the payment is not read, written or sent", async () => {
  const world = makeWorld();
  const { app, state, restore } = await v1App({ world, nodes: [] });
  try {
    const res = await chat(app, paid(usdcPayment({ amount: 1_000_000n })));
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "service_unavailable");
    assert.equal(res.json().error.message, "No healthy nodes available for this deployment");
    assert.equal(res.json().payment, undefined);
    assert.equal(world.decodes, 0);
    assert.equal(world.db.payments.size, 0);
    assert.equal(world.broadcasts.length, 0);
    assert.equal(state.nodeCalls, 0);
  } finally {
    await restore();
  }
});

test("a failed cluster check: 503, and the payment is not read, written or sent", async () => {
  const world = makeWorld();
  world.clusterOk = false;
  const { app, state, restore } = await v1App({ world });
  try {
    const res = await chat(app, paid(usdcPayment({ amount: 1_000_000n })));
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "service_unavailable");
    assert.equal(
      res.json().error.message,
      "Payments cannot be checked right now. Nothing was taken. Try again in a moment.",
    );
    assertOurWordsOnly(res);
    assert.equal(world.decodes, 0);
    assert.equal(world.db.payments.size, 0);
    assert.equal(world.broadcasts.length, 0);
    assert.equal(state.nodeCalls, 0);
  } finally {
    await restore();
  }
});

test("the node fails after the payment landed: the error it would have had, plus the payment returned, once", async () => {
  const world = makeWorld();
  const { app, restore } = await v1App({
    world,
    nodeResponse: () => new Response("upstream exploded: " + NODE_TEXT, { status: 500 }),
  });
  try {
    // 25,000 micro-dollars sent for a request that costs a fraction of that:
    // what comes back is what was sent.
    const res = await chat(app, paid(usdcPayment({ amount: 25_000n })));
    assert.ok(res.statusCode >= 500);
    const body = res.json();
    assert.equal(typeof body.error.code, "string");
    assert.deepEqual(body.payment, {
      status: "returned",
      amountUsd: 0.025,
      message:
        "Your payment for this request was returned to your credit balance. Amounts under a cent add up and appear once they reach a cent.",
    });
    assertOurWordsOnly(res);

    const row = world.db.only();
    assert.equal(row.status, "refunded");
    assert.equal(row.refundMicroUsd, 25_000n);
    assert.equal(row.servedAt, null);
    assert.deepEqual(world.db.balances.get("org-1"), { balanceCents: 2n, x402RefundCarryMicroUsd: 5_000n });
    assert.equal(world.db.ledger.length, 1);
    assert.equal(world.db.ledger[0]!.type, "x402_refund");
    assert.equal(world.db.ledger[0]!.description, "Paid request returned as credits");
    assert.equal(world.db.ledger[0]!.referenceId, row.id);

    // The worker, coming to the row later, finds nothing to return.
    world.nowMs += 60 * 60 * 1000;
    const { settleX402Row } = await import("../services/x402Payments.js");
    assert.equal(await settleX402Row(world.db.only(), world.settlementDeps), "skipped");
    assert.equal(world.db.ledger.length, 1);
  } finally {
    await restore();
  }
});

test("the node cannot be reached, or answers with no completion: the payment is returned each time", async () => {
  const cases: Array<() => Response> = [
    () => {
      throw new TypeError("fetch failed");
    },
    () => new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ nothing: true }), { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ error: { message: NODE_TEXT } }), { status: 400 }),
  ];
  for (const nodeResponse of cases) {
    const world = makeWorld();
    const { app, restore } = await v1App({ world, nodeResponse });
    try {
      const res = await chat(app, paid(usdcPayment({ amount: 30_000n })));
      assert.ok(res.statusCode >= 400);
      assert.equal(res.json().payment?.status, "returned");
      assert.equal(res.json().payment?.amountUsd, 0.03);
      assert.equal(world.db.only().status, "refunded");
      assert.deepEqual(world.db.balances.get("org-1"), { balanceCents: 3n, x402RefundCarryMicroUsd: 0n });
    } finally {
      await restore();
    }
  }
});

test("the return itself fails: the request's own error, no claim that anything was returned, and the row is left for the worker", async () => {
  const world = makeWorld();
  world.deps.refund = async () => {
    throw new Error(PRISMA_TEXT);
  };
  const { app, restore } = await v1App({
    world,
    nodeResponse: () => new Response("boom", { status: 500 }),
  });
  try {
    const res = await chat(app, paid(usdcPayment({ amount: 25_000n })));
    assert.ok(res.statusCode >= 500);
    assert.equal(res.json().payment, undefined);
    assertOurWordsOnly(res);
    const row = world.db.only();
    assert.equal(row.status, "verified");
    assert.equal(row.servedAt, null);
    assert.equal(row.refundedAt, null);
  } finally {
    await restore();
  }
});

test("the database fails while the payment is being claimed: an error in our words, and nothing was sent", async () => {
  const world = makeWorld();
  world.deps.insertPayment = async () => {
    throw new Error(PRISMA_TEXT);
  };
  const { app, state, restore } = await v1App({ world });
  try {
    const res = await chat(app, paid(usdcPayment({ amount: 25_000n })));
    assert.equal(res.statusCode, 500);
    assertOurWordsOnly(res);
    assert.equal(world.broadcasts.length, 0);
    assert.equal(state.nodeCalls, 0);
  } finally {
    await restore();
  }
});

test("fallback mode with no credits and no payment: the challenge, and no payment is touched", async () => {
  const world = makeWorld();
  const { app, restore } = await v1App({ world, mode: "fallback", balanceCents: 0n });
  try {
    assert.equal((await chat(app)).statusCode, 402);
    assert.equal(world.db.payments.size, 0);
    assert.equal(world.decodes, 0);
  } finally {
    await restore();
  }
});

// ============================================
// GET /api/x402/metrics
// ============================================

test("GET /api/x402/metrics reads only: it never inserts, with the worker on or off", async () => {
  const { prisma } = await import("@wheelsai/db");
  const { env } = await import("../config/env.js");
  const { x402Routes } = await import("../routes/x402.js");
  const Fastify = (await import("fastify")).default;

  const prismaAny = prisma as any;
  const saved = {
    x402Payment: prismaAny.x402Payment,
    executeRaw: prismaAny.$executeRaw,
    executeRawUnsafe: prismaAny.$executeRawUnsafe,
    transaction: prismaAny.$transaction,
    workerEnabled: (env as any).X402_SETTLEMENT_WORKER_ENABLED,
  };
  const writes: string[] = [];
  const reads: string[] = [];
  const wrote = (name: string) => async () => {
    writes.push(name);
    return { count: 0 };
  };
  prismaAny.x402Payment = {
    count: async () => {
      reads.push("count");
      return 3;
    },
    findFirst: async () => {
      reads.push("findFirst");
      return { createdAt: new Date(Date.now() - 5 * 60_000) };
    },
    findMany: async () => {
      reads.push("findMany");
      return [];
    },
    create: wrote("create"),
    createMany: wrote("createMany"),
    update: wrote("update"),
    updateMany: wrote("updateMany"),
    upsert: wrote("upsert"),
    delete: wrote("delete"),
    deleteMany: wrote("deleteMany"),
  };
  prismaAny.$executeRaw = wrote("$executeRaw");
  prismaAny.$executeRawUnsafe = wrote("$executeRawUnsafe");
  prismaAny.$transaction = wrote("$transaction");

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "u", orgId: "org-1", type: "jwt", role: "owner" };
  });
  await app.register(x402Routes, { prefix: "/api/x402" });
  try {
    for (const enabled of [false, true]) {
      (env as any).X402_SETTLEMENT_WORKER_ENABLED = enabled;
      const res = await app.inject({ method: "GET", url: "/api/x402/metrics" });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.worker.enabled, enabled);
      assert.equal(body.payments.total, 3);
      assert.equal(body.payments.oldestPendingMinutes, 5);
      assert.ok(Array.isArray(body.alerts));
    }
    assert.deepEqual(writes, []);
    assert.ok(reads.length > 0);
  } finally {
    await app.close();
    prismaAny.x402Payment = saved.x402Payment;
    prismaAny.$executeRaw = saved.executeRaw;
    prismaAny.$executeRawUnsafe = saved.executeRawUnsafe;
    prismaAny.$transaction = saved.transaction;
    (env as any).X402_SETTLEMENT_WORKER_ENABLED = saved.workerEnabled;
  }
});
