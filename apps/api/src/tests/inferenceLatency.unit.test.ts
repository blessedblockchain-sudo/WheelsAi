import assert from "node:assert/strict";
import test from "node:test";

// Env must be in place BEFORE the route module (and config/env.ts) is imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
// Short, so a node that never answers times out within the test.
process.env.INFERENCE_TIMEOUT_MS = "60";

import type { LatencySample } from "../services/latencySamples.js";

// A model deployment's chat completions used to record only the node call's
// time, as a sum per hour, and only for answers. Every request that reaches a
// node now leaves one sample - measured from the API receiving the request,
// classified by how it ended - and a request refused before a node leaves
// none. Recording must never change the response or the credit ledger.

const NODE_URL = "https://abc.node.k8s.prd.nos.ci";
const ORG = "11111111-1111-4111-8111-111111111111";
// A UUID, as a real deployment's id is: a sample keeps no other kind.
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";

function deploymentRow(over: Record<string, unknown> = {}) {
  return {
    id: DEPLOYMENT_ID,
    name: "d",
    slug: "my-llama",
    engine: "vllm",
    gpuTier: "4090",
    status: "running",
    // A real Nosana id: billed per GPU-second, nothing per request.
    nosanaJobIds: ["DeploymentManagerId1"],
    model: { pricingTier: "small", hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" },
    nodes: [{ id: "n1", nodeUrl: NODE_URL, healthStatus: "healthy", latencyMs: 12 }],
    ...over,
  };
}

/** The dev-only mock deployment: the one kind that is billed per request. */
const perRequest = (over: Record<string, unknown> = {}) =>
  deploymentRow({ nosanaJobIds: ["mock_deploy_abc"], ...over });

const completion = (usage: unknown = { prompt_tokens: 9, completion_tokens: 21 }) =>
  new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }],
      ...(usage !== null && { usage }),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function sse(frames: unknown[]): Response {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const nodeChunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "cmpl-node-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const usageChunk = (prompt: number, completionTokens: number) => ({
  id: "cmpl-node-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completionTokens, total_tokens: prompt + completionTokens },
});

interface Ledger {
  type: string;
  amountCents: bigint;
}

async function v1App(opts: {
  balance?: bigint;
  deployment: Record<string, unknown> | null;
  nodeResponse: (init: any) => Response | Promise<Response>;
  recordLatency?: (sample: LatencySample | null) => void;
  surface?: "v1" | "deployment_chat";
}) {
  const { prisma } = await import("@wheelsai/db");
  const state = {
    balance: opts.balance ?? 0n,
    ledger: [] as Ledger[],
    samples: [] as LatencySample[],
    nodeCalls: 0,
  };
  const db = {
    creditBalance: {
      updateMany: async ({ where, data }: any) => {
        if (state.balance < where.balanceCents.gte) return { count: 0 };
        state.balance -= data.balanceCents.decrement;
        return { count: 1 };
      },
      update: async ({ data }: any) => {
        state.balance += data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
      findUnique: async () => ({ balanceCents: state.balance }),
    },
    creditTransaction: {
      create: async ({ data }: any) => {
        state.ledger.push({ type: data.type, amountCents: data.amountCents });
        return data;
      },
    },
  };
  const patch: Record<string, unknown> = {
    deployment: { findFirst: async () => opts.deployment },
    orgSubscription: { findUnique: async () => ({ plan: "enterprise", status: "active" }) },
    creditBalance: db.creditBalance,
    creditTransaction: db.creditTransaction,
    deploymentNode: { update: async () => ({}) },
    usageRecord: { upsert: async () => ({}) },
    $transaction: async (fn: any) => fn(db),
  };
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = (prisma as any)[k];
    (prisma as any)[k] = patch[k];
  }

  const Fastify = (await import("fastify")).default;
  const { createDeploymentCompletionHandler } = await import("../routes/inference.js");
  const { openAiErrorHandler } = await import("../middleware/openaiAuth.js");
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "u", orgId: ORG, type: "jwt", role: "owner" };
  });
  app.setErrorHandler(openAiErrorHandler);
  const complete = createDeploymentCompletionHandler({
    heartbeatMs: 0,
    recordLatency:
      opts.recordLatency ??
      ((sample) => {
        if (sample) state.samples.push(sample);
      }),
    ...(opts.surface && { surface: opts.surface }),
  });
  app.post("/v1/:deploymentSlug/chat/completions", async (request, reply) =>
    complete(request, reply, { deploymentSlug: (request.params as { deploymentSlug: string }).deploymentSlug }),
  );

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: any) => {
    state.nodeCalls += 1;
    return opts.nodeResponse(init);
  }) as never;

  return {
    app,
    state,
    restore: async () => {
      globalThis.fetch = realFetch;
      await app.close();
      Object.assign(prisma as any, saved);
    },
  };
}

const post = (app: any, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/my-llama/chat/completions",
    payload: { messages: [{ role: "user", content: "hello" }], ...payload },
  });

// ============================================
// What an answered request records
// ============================================

test("an answered request leaves exactly one sample that names what was measured", async () => {
  const { app, state, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return completion();
    },
  });
  try {
    const res = await post(app);
    assert.equal(res.statusCode, 200);
    assert.equal(state.samples.length, 1);
    const sample = state.samples[0]!;
    assert.equal(sample.orgId, ORG);
    assert.equal(sample.surface, "v1");
    assert.equal(sample.deploymentId, DEPLOYMENT_ID);
    assert.equal(sample.agentId, null);
    assert.equal(sample.provider, "nosana");
    assert.equal(sample.model, "meta-llama/Meta-Llama-3.1-8B-Instruct");
    assert.equal(sample.outcome, "ok");
    assert.equal(sample.statusCode, 200);
    assert.equal(sample.streamed, false);
    assert.equal(sample.outputTokens, 21);
    assert.equal(sample.firstTokenMs, null, "a first token is only measured on a stream");
    // A real measurement: the node took 15 ms, so neither figure can be 0.
    assert.ok(sample.totalMs >= 10, `totalMs ${sample.totalMs}`);
    assert.ok(sample.upstreamMs !== null && sample.upstreamMs >= 10);
    assert.ok(sample.upstreamMs! <= sample.totalMs, "the node call is part of the request");
  } finally {
    await restore();
  }
});

test("the dev mock deployment is sampled as nosana_mock, so it can be kept out of any figure", async () => {
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: perRequest(),
    nodeResponse: () => completion(),
  });
  try {
    assert.equal((await post(app)).statusCode, 200);
    assert.deepEqual(state.samples.map((s) => [s.provider, s.outcome]), [["nosana_mock", "ok"]]);
  } finally {
    await restore();
  }
});

test("tokens the node did not report stay null in the sample", async () => {
  const { app, state, restore } = await v1App({ deployment: deploymentRow(), nodeResponse: () => completion(null) });
  try {
    await post(app);
    assert.equal(state.samples[0]!.outputTokens, null);
  } finally {
    await restore();
  }
});

test("the dashboard's handler records the same request under its own surface", async () => {
  const { app, state, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () => completion(),
    surface: "deployment_chat",
  });
  try {
    await post(app);
    assert.deepEqual(state.samples.map((s) => s.surface), ["deployment_chat"]);
  } finally {
    await restore();
  }
});

// ============================================
// Streams
// ============================================

test("a streamed answer carries the time to its first content", async () => {
  const { app, state, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () =>
      sse([
        nodeChunk({ role: "assistant" }),
        nodeChunk({ content: "Hel" }),
        nodeChunk({ content: "lo" }),
        nodeChunk({}, "stop"),
        usageChunk(9, 2),
      ]),
  });
  try {
    const res = await post(app, { stream: true });
    assert.equal(res.statusCode, 200);
    assert.equal(state.samples.length, 1);
    const sample = state.samples[0]!;
    assert.equal(sample.streamed, true);
    assert.equal(sample.outcome, "ok");
    assert.equal(sample.statusCode, 200);
    assert.equal(sample.outputTokens, 2);
    assert.ok(sample.firstTokenMs !== null, "a stream with text has a first token");
    assert.ok(sample.firstTokenMs! <= sample.totalMs);
  } finally {
    await restore();
  }
});

test("a stream the node failed is an error with no answer's tokens", async () => {
  const { app, state, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () => sse([{ error: { message: "CUDA out of memory" } }]),
  });
  try {
    await post(app, { stream: true });
    assert.equal(state.samples.length, 1);
    assert.equal(state.samples[0]!.outcome, "error");
    assert.equal(state.samples[0]!.firstTokenMs, null);
    assert.equal(state.samples[0]!.outputTokens, null);
  } finally {
    await restore();
  }
});

test("a node that answers a streaming request without a stream is an error", async () => {
  const { app, state, restore } = await v1App({ deployment: deploymentRow(), nodeResponse: () => completion() });
  try {
    const res = await post(app, { stream: true });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(state.samples.map((s) => [s.outcome, s.statusCode, s.streamed]), [["error", 502, true]]);
  } finally {
    await restore();
  }
});

// ============================================
// Failures are samples too, and never answers
// ============================================

test("a node that answers 500 is an error carrying the status the caller got", async () => {
  const { app, state, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const res = await post(app);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(state.samples.map((s) => [s.outcome, s.statusCode]), [["error", 500]]);
  } finally {
    await restore();
  }
});

test("a 200 with an error body instead of a completion is an error, not an answer", async () => {
  const { app, state, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () =>
      new Response(JSON.stringify({ object: "error", message: "model not loaded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const res = await post(app);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(state.samples.map((s) => [s.outcome, s.statusCode]), [["error", 502]]);
  } finally {
    await restore();
  }
});

test("a node that cannot be reached is an error", async () => {
  const { app, state, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () => {
      throw new Error("ECONNREFUSED");
    },
  });
  try {
    const res = await post(app);
    assert.equal(res.statusCode, 502);
    assert.deepEqual(state.samples.map((s) => [s.outcome, s.statusCode]), [["error", 502]]);
  } finally {
    await restore();
  }
});

test("a node that stays silent past the deadline is a timeout, measured at the deadline", async () => {
  const { app, state, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: (init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  });
  try {
    const res = await post(app);
    assert.equal(res.statusCode, 504);
    assert.equal(state.samples.length, 1);
    assert.equal(state.samples[0]!.outcome, "timeout");
    assert.equal(state.samples[0]!.statusCode, 504);
    assert.ok(state.samples[0]!.totalMs >= 50, "the caller waited out the deadline");
  } finally {
    await restore();
  }
});

// ============================================
// Requests that never reached a node
// ============================================

test("an unknown deployment (404) records nothing", async () => {
  const { app, state, restore } = await v1App({ deployment: null, nodeResponse: () => completion() });
  try {
    assert.equal((await post(app)).statusCode, 404);
    assert.deepEqual(state.samples, []);
    assert.equal(state.nodeCalls, 0);
  } finally {
    await restore();
  }
});

test("a request refused for credits (402) records nothing", async () => {
  const { app, state, restore } = await v1App({
    balance: 0n,
    deployment: perRequest(),
    nodeResponse: () => completion(),
  });
  try {
    assert.equal((await post(app)).statusCode, 402);
    assert.deepEqual(state.samples, []);
    assert.equal(state.nodeCalls, 0);
  } finally {
    await restore();
  }
});

test("a deployment with no healthy node (503) records nothing", async () => {
  const { app, state, restore } = await v1App({
    deployment: deploymentRow({ nodes: [] }),
    nodeResponse: () => completion(),
  });
  try {
    assert.equal((await post(app)).statusCode, 503);
    assert.deepEqual(state.samples, []);
  } finally {
    await restore();
  }
});

test("an invalid request (400) records nothing", async () => {
  const { app, state, restore } = await v1App({ deployment: deploymentRow(), nodeResponse: () => completion() });
  try {
    const res = await app.inject({ method: "POST", url: "/v1/my-llama/chat/completions", payload: { messages: [] } });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(state.samples, []);
  } finally {
    await restore();
  }
});

// ============================================
// Recording cannot change the request
// ============================================

test("a recorder that throws changes neither the response nor the credit ledger", async () => {
  const run = async (recordLatency?: (sample: LatencySample | null) => void) => {
    const { app, state, restore } = await v1App({
      balance: 10_000n,
      deployment: perRequest(),
      nodeResponse: () => completion(),
      ...(recordLatency && { recordLatency }),
    });
    try {
      const res = await post(app);
      return { status: res.statusCode, body: res.json(), ledger: state.ledger, balance: state.balance };
    } finally {
      await restore();
    }
  };
  const quiet = await run();
  const noisy = await run(() => {
    throw new Error("sink exploded");
  });
  assert.equal(noisy.status, 200);
  assert.deepEqual(noisy.body, quiet.body);
  assert.deepEqual(noisy.ledger, quiet.ledger);
  assert.equal(noisy.balance, quiet.balance);
  assert.ok(noisy.ledger.length > 0, "the request was really held and settled");
});

test("the sample is taken after the hold is settled, never before", async () => {
  const order: string[] = [];
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: perRequest(),
    nodeResponse: () => completion(),
    recordLatency: () => order.push(`sample:${state.ledger.length}`),
  });
  try {
    await post(app);
    // Both ledger rows (the hold and its settlement) exist when the sample is taken.
    assert.equal(order.length, 1);
    assert.ok(Number(order[0]!.split(":")[1]) >= 1);
    assert.equal(order[0], `sample:${state.ledger.length}`);
  } finally {
    await restore();
  }
});

// ============================================
// The first-content hook of a watched stream
// ============================================

async function drain(frames: unknown[], onFirstContent: () => void) {
  const { passthroughStream } = await import("../services/mastra-runtime.js");
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const watched = passthroughStream(
    body,
    undefined,
    { signal: new AbortController().signal, expired: () => false, clear: () => {} },
    onFirstContent,
  );
  const reader = watched.stream.getReader();
  let forwarded = 0;
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
    forwarded += 1;
  }
  return { outcome: await watched.outcome, forwarded };
}

test("onFirstContent fires once, on the first chunk that carries text", async () => {
  let fired = 0;
  const { outcome } = await drain(
    [nodeChunk({ role: "assistant" }), nodeChunk({ content: "Hel" }), nodeChunk({ content: "lo" }), nodeChunk({}, "stop")],
    () => fired++,
  );
  assert.equal(outcome.ok, true);
  assert.equal(fired, 1);
});

test("onFirstContent does not fire for a role-only or an error-only stream", async () => {
  let fired = 0;
  await drain([nodeChunk({ role: "assistant" }), nodeChunk({}, "stop")], () => fired++);
  await drain([{ error: { message: "CUDA out of memory" } }], () => fired++);
  assert.equal(fired, 0);
});

test("a first-content hook that throws does not break the stream", async () => {
  const { outcome, forwarded } = await drain([nodeChunk({ content: "Hello" }), nodeChunk({}, "stop")], () => {
    throw new Error("hook exploded");
  });
  assert.equal(outcome.ok, true);
  assert.ok(forwarded >= 3, "every chunk was still forwarded");
});
