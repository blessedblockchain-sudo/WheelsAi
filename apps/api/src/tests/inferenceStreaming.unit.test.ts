import assert from "node:assert/strict";
import test from "node:test";

// Env must be in place BEFORE the route module (and config/env.ts) is imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

// Model deployments on /v1 speak the same wire format as agents: OpenAI's
// request (tools and tool_choice included), response, SSE stream and errors.
// Before this, `stream: true` called response.json() on an SSE body, answered
// 502 and marked the node unhealthy; tools were stripped by the schema; and
// every node error was a 502 whatever the node had said.

const NODE_URL = "https://abc.node.k8s.prd.nos.ci";

interface Ledger {
  type: string;
  amountCents: bigint;
}

function deploymentRow(over: Record<string, unknown> = {}) {
  return {
    id: "dep-1",
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

function sse(frames: unknown[], options: { done?: boolean } = {}): Response {
  const text =
    frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("") +
    (options.done === false ? "" : "data: [DONE]\n\n");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const nodeChunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: "cmpl-node-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const usageChunkFromNode = (prompt: number, completion: number) => ({
  id: "cmpl-node-1",
  object: "chat.completion.chunk",
  created: 1,
  model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
});

async function v1App(opts: {
  balance?: bigint;
  deployment: Record<string, unknown> | null;
  nodeResponse: (init: any) => Response | Promise<Response>;
}) {
  const { prisma } = await import("@wheelsai/db");
  const state = {
    balance: opts.balance ?? 0n,
    ledger: [] as Ledger[],
    usage: [] as Array<{ costCents: bigint; errorCount: number; inputTokens: bigint }>,
    nodeUpdates: [] as any[],
    findFirstArgs: [] as any[],
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
    deployment: {
      findFirst: async (args: any) => {
        state.findFirstArgs.push(args);
        return opts.deployment;
      },
    },
    orgSubscription: { findUnique: async () => ({ plan: "enterprise", status: "active" }) },
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
    $transaction: async (fn: any) => fn(db),
  };
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = (prisma as any)[k];
    (prisma as any)[k] = patch[k];
  }

  const Fastify = (await import("fastify")).default;
  const { createInferenceRoutes } = await import("../routes/inference.js");
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "u", orgId: "org-1", type: "jwt", role: "owner" };
  });
  // Latency samples go to a stub: a unit test opens no database.
  await app.register(createInferenceRoutes({ heartbeatMs: 0, recordLatency: () => {} }));

  const realFetch = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = (async (_url: string, init?: any) => {
    sent.push(JSON.parse(init.body));
    return opts.nodeResponse(init);
  }) as never;

  return {
    app,
    state,
    sent,
    restore: async () => {
      globalThis.fetch = realFetch;
      await app.close();
      Object.assign(prisma as any, saved);
    },
  };
}

const post = (app: any, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/my-llama/chat/completions", payload });

const hello = [{ role: "user", content: "hello" }];

function frames(body: string): any[] {
  return body
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice(5).trim())
    .map((d) => (d === "[DONE]" ? d : JSON.parse(d)));
}

// The usage rollup is written fire-and-forget.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// ============================================
// Streaming
// ============================================

test("stream:true is piped as SSE in OpenAI's shape and the node is NOT marked unhealthy", async () => {
  const { app, state, sent, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () =>
      sse([
        nodeChunk({ role: "assistant", content: "Hel" }),
        nodeChunk({ content: "lo" }),
        nodeChunk({}, "stop"),
        usageChunkFromNode(9, 2),
      ]),
  });
  try {
    const res = await post(app, { messages: hello, stream: true });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    assert.ok(res.headers["x-request-id"], "headers set before the stream survive it");

    const out = frames(res.body);
    assert.equal(out.at(-1), "[DONE]", "ends with exactly one [DONE]");
    assert.equal(out.filter((f) => f === "[DONE]").length, 1);
    const chunks = out.slice(0, -1);
    assert.equal(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join(""), "Hello");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
    for (const chunk of chunks) {
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.match(chunk.id, /^chatcmpl-/, "our id, not the node's");
      assert.equal(chunk.model, "my-llama", "the name /v1/models lists, not the engine's");
    }
    assert.ok(!res.body.includes("cmpl-node-1"));
    assert.ok(
      chunks.every((c) => c.usage === undefined),
      "the caller did not ask for usage, so the node's usage chunk is not forwarded",
    );

    assert.equal(sent[0].stream, true);
    assert.deepEqual(sent[0].stream_options, { include_usage: true }, "usage is always asked of the node");
    assert.deepEqual(state.nodeUpdates, [], "a stream is not a node failure");
    await settle();
    assert.deepEqual(state.usage.map((u) => [u.errorCount, u.inputTokens]), [[0, 9n]]);
  } finally {
    await restore();
  }
});

test("stream_options.include_usage adds one final usage chunk with choices: []", async () => {
  const { app, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () =>
      sse([nodeChunk({ role: "assistant", content: "ok" }), nodeChunk({}, "stop"), usageChunkFromNode(9, 2)]),
  });
  try {
    const res = await post(app, { messages: hello, stream: true, stream_options: { include_usage: true } });
    const out = frames(res.body);
    const usage = out.filter((f) => f !== "[DONE]" && f.usage);
    assert.equal(usage.length, 1);
    assert.deepEqual(usage[0].choices, []);
    assert.deepEqual(usage[0].usage, { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
    assert.equal(out.at(-1), "[DONE]");
  } finally {
    await restore();
  }
});

test("a GPU-billed deployment's streamed request moves no credits", async () => {
  const { app, state, restore } = await v1App({
    balance: 0n,
    deployment: deploymentRow(),
    nodeResponse: () => sse([nodeChunk({ content: "ok" }), nodeChunk({}, "stop"), usageChunkFromNode(9, 2)]),
  });
  try {
    const res = await post(app, { messages: hello, stream: true });
    assert.equal(res.statusCode, 200, "served on zero credits: the GPU time is what is billed");
    assert.deepEqual(state.ledger, []);
    assert.equal(state.balance, 0n);
  } finally {
    await restore();
  }
});

test("a per-request-billed stream holds first and settles on the node's own token count", async () => {
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: perRequest(),
    nodeResponse: () =>
      sse([nodeChunk({ content: "ok" }), nodeChunk({}, "stop"), usageChunkFromNode(200_000, 100_000)]),
  });
  try {
    const res = await post(app, { messages: hello, stream: true, max_tokens: 8192 });
    assert.equal(res.statusCode, 200);
    assert.equal(state.ledger[0]!.type, "usage", "the hold is taken before the node is called");
    assert.ok(state.balance < 10_000n, "the request was charged");
    // Hold, then at most one adjusting row: never settled twice.
    assert.ok(state.ledger.length <= 2);
    await settle();
    assert.equal(state.usage.length, 1);
    assert.ok(state.usage[0]!.costCents > 0n);
  } finally {
    await restore();
  }
});

test("a per-request-billed stream whose node reports no usage is charged on an estimate, not served free", async () => {
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: perRequest({ model: { pricingTier: "large", hfId: "x/y" } }),
    nodeResponse: () => sse([nodeChunk({ content: "y".repeat(400_000) }), nodeChunk({}, "stop")]),
  });
  try {
    const res = await post(app, { messages: hello, stream: true, max_tokens: 8192 });
    assert.equal(res.statusCode, 200);
    assert.ok(state.balance < 10_000n, "zero-filled usage would have made this free");
    await settle();
    assert.equal(state.usage[0]!.inputTokens, 0n, "an estimate is a billing basis, not a recorded measurement");
  } finally {
    await restore();
  }
});

test("an error event inside the node's stream ends it with a sanitised error and no [DONE]; the hold is released", async () => {
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: perRequest(),
    nodeResponse: () =>
      sse([{ error: { message: "CUDA out of memory at /opt/vllm/engine.py:412" } }], { done: false }),
  });
  try {
    const res = await post(app, { messages: hello, stream: true });
    assert.equal(res.statusCode, 200, "the headers were already sent");
    const out = frames(res.body);
    assert.ok(!out.includes("[DONE]"), "a client that stops at [DONE] must not read a failure as an answer");
    assert.equal(out.at(-1).error.code, "upstream_error");
    assert.ok(!res.body.includes("CUDA"), "the node's own words are not forwarded");
    assert.equal(state.balance, 10_000n);
    assert.deepEqual(state.ledger.map((l) => l.type), ["usage", "usage_release"]);
    assert.deepEqual(state.nodeUpdates, [], "health is the status worker's call");
    await settle();
    assert.deepEqual(state.usage.map((u) => [u.errorCount, u.costCents]), [[1, 0n]]);
  } finally {
    await restore();
  }
});

test("a node that answers a streaming request with JSON is a 502, not a broken stream", async () => {
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: perRequest(),
    nodeResponse: () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  try {
    const res = await post(app, { messages: hello, stream: true });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, "upstream_error");
    assert.equal(state.balance, 10_000n);
  } finally {
    await restore();
  }
});

// ============================================
// Request: what reaches the node
// ============================================

test("tools, tool_choice, response_format and sampling parameters reach the node; the model is the served name", async () => {
  const tools = [
    {
      type: "function",
      function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: {} } },
    },
  ];
  const { app, sent, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () =>
      new Response(
        JSON.stringify({
          id: "cmpl-node-1",
          object: "chat.completion",
          model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  try {
    const res = await post(app, {
      model: "whatever-the-client-calls-it",
      messages: [
        { role: "developer", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "Weather in Lagos?" }] },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "get_weather" } },
      parallel_tool_calls: false,
      response_format: { type: "json_object" },
      top_p: 0.9,
      seed: 7,
      stop: ["END"],
      max_completion_tokens: 256,
      vendor_extension: "dropped",
    });
    assert.equal(res.statusCode, 200);
    const body = sent[0];
    assert.equal(body.model, "meta-llama/Meta-Llama-3.1-8B-Instruct");
    assert.deepEqual(body.tools, tools);
    assert.deepEqual(body.tool_choice, { type: "function", function: { name: "get_weather" } });
    assert.equal(body.parallel_tool_calls, false);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.top_p, 0.9);
    assert.equal(body.seed, 7);
    assert.deepEqual(body.stop, ["END"]);
    assert.equal(body.max_tokens, 256, "max_completion_tokens is sent under the name every engine knows");
    assert.equal(body.max_completion_tokens, undefined);
    assert.equal(body.vendor_extension, undefined);
    assert.deepEqual(body.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Weather in Lagos?" },
    ]);
    assert.equal(body.stream_options, undefined, "stream_options belongs to streams only");

    const json = res.json();
    assert.equal(json.model, "my-llama");
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "get_weather");
  } finally {
    await restore();
  }
});

test("a request with no tools sends none, and no parallel_tool_calls", async () => {
  const { app, sent, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: () =>
      new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    await post(app, { messages: hello, parallel_tool_calls: true });
    assert.equal(sent[0].tools, undefined);
    assert.equal(sent[0].tool_choice, undefined);
    assert.equal(sent[0].parallel_tool_calls, undefined);
    assert.equal(sent[0].max_tokens, 4096, "every request carries an explicit completion cap");
  } finally {
    await restore();
  }
});

test("a completion cap above the hold's ceiling is refused, naming the parameter", async () => {
  const { app, sent, restore } = await v1App({ deployment: deploymentRow(), nodeResponse: () => sse([]) });
  try {
    const res = await post(app, { messages: hello, max_tokens: 20_000 });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.param, "max_tokens");
    assert.equal(sent.length, 0);
  } finally {
    await restore();
  }
});

test("unsupported parameters are refused by name before any lookup", async () => {
  const { app, state, restore } = await v1App({ deployment: deploymentRow(), nodeResponse: () => sse([]) });
  try {
    const res = await post(app, { messages: hello, n: 3 });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(
      [res.json().error.type, res.json().error.param, res.json().error.code],
      ["invalid_request_error", "n", "unsupported_parameter"],
    );
    assert.equal(state.findFirstArgs.length, 0);
  } finally {
    await restore();
  }
});

// ============================================
// Errors: the node's status, in OpenAI's shape
// ============================================

test("an upstream 400 is returned as 400 with the model server's message; the hold is released and the node stays healthy", async () => {
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: perRequest(),
    nodeResponse: () =>
      new Response(
        JSON.stringify({
          object: "error",
          message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
          type: "BadRequestError",
          code: 400,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  });
  try {
    const res = await post(app, { messages: hello });
    assert.equal(res.statusCode, 400);
    const { error } = res.json();
    assert.equal(error.type, "invalid_request_error");
    assert.equal(error.code, "provider_rejected_request");
    assert.match(error.message, /--enable-auto-tool-choice/);
    assert.equal(state.balance, 10_000n);
    assert.deepEqual(state.ledger.map((l) => l.type), ["usage", "usage_release"]);
    assert.deepEqual(state.nodeUpdates, [], "one caller's bad request does not take the node from everyone");
  } finally {
    await restore();
  }
});

test("nodeStatusError passes a status through, except the three an OpenAI SDK would misread", async () => {
  const { nodeStatusError, nodeErrorMessage } = await import("../routes/inference.js");

  for (const status of [400, 409, 413, 422]) {
    const e = nodeStatusError(status, null, null);
    assert.equal(e.status, status);
    assert.equal(e.body.error.type, "invalid_request_error");
  }
  for (const status of [500, 502, 503]) {
    const e = nodeStatusError(status, "secret detail", null);
    assert.equal(e.status, status);
    assert.equal(e.body.error.type, "server_error");
    assert.ok(!e.body.error.message.includes("secret detail"), "a 5xx body is not relayed");
  }
  // "Your WheelsAI key is wrong" / "no such deployment" would both be false.
  for (const status of [401, 403, 404]) {
    const e = nodeStatusError(status, null, null);
    assert.equal(e.status, 502, `${status}`);
    assert.equal(e.headers["x-should-retry"], "false");
  }
  assert.equal(nodeStatusError(504, null, null).status, 504);
  assert.equal(nodeStatusError(504, null, null).body.error.code, "upstream_timeout");

  const limited = nodeStatusError(429, null, 7);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "7");
  assert.equal(limited.body.error.code, "provider_rate_limited");

  // A redirect or other oddity that got this far is a gateway fault.
  assert.equal(nodeStatusError(204, null, null).status, 502);

  assert.equal(nodeErrorMessage('{"object":"error","message":"bad"}'), "bad");
  assert.equal(nodeErrorMessage('{"error":{"message":"worse"}}'), "worse");
  assert.equal(nodeErrorMessage('{"error":"model not loaded"}'), "model not loaded");
  assert.equal(nodeErrorMessage("<html>502</html>"), null);
  assert.equal(nodeErrorMessage(JSON.stringify({ message: "x".repeat(2_000) }))!.length, 501);
});

test("a node that goes silent while sending its body is a 504, and the hold is released", async () => {
  const { env } = await import("../config/env.js");
  const before = (env as any).INFERENCE_TIMEOUT_MS;
  (env as any).INFERENCE_TIMEOUT_MS = 40;
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: perRequest(),
    // Headers at once, then a body that never arrives. The timer used to be
    // cleared when the headers came, so this read had no limit.
    nodeResponse: (init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal.addEventListener("abort", () => controller.error(init.signal.reason));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  try {
    const res = await post(app, { messages: hello });
    assert.equal(res.statusCode, 504);
    assert.equal(res.json().error.code, "upstream_timeout");
    assert.equal(state.balance, 10_000n);
    assert.deepEqual(state.ledger.map((l) => l.type), ["usage", "usage_release"]);
  } finally {
    (env as any).INFERENCE_TIMEOUT_MS = before;
    await restore();
  }
});

test("an unknown deployment is 404 model_not_found in OpenAI's shape, scoped to the caller's organization", async () => {
  const { app, state, restore } = await v1App({ deployment: null, nodeResponse: () => sse([]) });
  try {
    const res = await post(app, { messages: hello });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, "model_not_found");
    assert.equal(res.headers["x-should-retry"], "false");
    assert.deepEqual(state.findFirstArgs[0].where, { slug: "my-llama", orgId: "org-1", status: "running" });
  } finally {
    await restore();
  }
});

test("a malformed body is a 400 in OpenAI's shape, not Fastify's", async () => {
  const { app, restore } = await v1App({ deployment: deploymentRow(), nodeResponse: () => sse([]) });
  try {
    const res = await post(app, { messages: "hello" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.type, "invalid_request_error");
    assert.equal(res.json().error.param, "messages");
  } finally {
    await restore();
  }
});

// ============================================
// vLLM is started so tool_choice "auto" works
// ============================================

test("tool-capable model families start vLLM with --enable-auto-tool-choice and their parser; others are unchanged", async () => {
  const { generateVllmJobDefinition, vllmToolCalling } = await import("../services/nosana.js");
  const job = (hfModelId: string) =>
    generateVllmJobDefinition({
      modelId: "m",
      hfModelId,
      engine: "vllm",
      maxTokens: 8192,
      gpuMemoryUtilization: 0.9,
    }).ops[0]!.args as { image: string; cmd: string[] };

  const llama = job("meta-llama/Meta-Llama-3.1-8B-Instruct");
  const at = llama.cmd.indexOf("--tool-call-parser");
  assert.ok(llama.cmd.includes("--enable-auto-tool-choice"));
  assert.equal(llama.cmd[at + 1], "llama3_json");
  assert.equal(llama.image, "vllm/vllm-openai:v0.6.3", "the parser needs a server that has it");

  assert.equal(vllmToolCalling("Qwen/Qwen2.5-Coder-7B-Instruct")?.parser, "hermes");
  assert.equal(vllmToolCalling("mistralai/Mistral-7B-Instruct-v0.3")?.parser, "mistral");

  // A model whose template has no tool section gets no parser: a parser
  // pointed at it would produce malformed calls.
  for (const hfId of ["mistralai/Mistral-7B-Instruct-v0.2", "google/gemma-2-9b-it", "codellama/CodeLlama-7b-Instruct-hf"]) {
    assert.equal(vllmToolCalling(hfId), null, hfId);
    const plain = job(hfId);
    assert.ok(!plain.cmd.includes("--enable-auto-tool-choice"));
    assert.equal(plain.image, "vllm/vllm-openai:v0.6.0", "and stays on the image it has always run on");
  }
});

// ============================================
// The official OpenAI client, over a real socket
// ============================================
//
// No GPU node exists on a development machine, so the model server here is
// scripted (it speaks vLLM's wire format). Everything else is real: the
// route, the /v1 guard, the proxy, the stream adapter, an HTTP listener and
// the `openai` package reading the bytes.

test("the official OpenAI client streams, calls tools and reads errors from a model deployment", async () => {
  const { default: OpenAI } = await import("openai");
  const realFetch = globalThis.fetch;
  const calls: any[] = [];
  const { app, restore } = await v1App({
    deployment: deploymentRow(),
    nodeResponse: (init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.messages.at(-1).content === "break") {
        return new Response(JSON.stringify({ object: "error", message: "max_tokens is too large for this model", code: 400 }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.stream) {
        return sse([
          nodeChunk({ role: "assistant", content: "" }),
          nodeChunk({ content: "Hello" }),
          nodeChunk({ content: " there" }),
          nodeChunk({}, "stop"),
          usageChunkFromNode(11, 3),
        ]);
      }
      return new Response(
        JSON.stringify({
          id: "cmpl-node-9",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "chatcmpl-tool-1", type: "function", function: { name: "get_weather", arguments: '{"city":"Lagos"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    // The client talks to the real listener; only the node is scripted.
    const client = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1/my-llama`,
      apiKey: "wheels_test",
      fetch: realFetch,
      maxRetries: 0,
    });

    const stream = await client.chat.completions.create({
      model: "my-llama",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let usage: unknown = null;
    let finish: string | null = null;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
      finish = chunk.choices[0]?.finish_reason ?? finish;
      if (chunk.usage) usage = chunk.usage;
      assert.equal(chunk.model, "my-llama");
    }
    assert.equal(text, "Hello there");
    assert.equal(finish, "stop");
    assert.deepEqual(usage, { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });

    const completion = await client.chat.completions.create({
      model: "my-llama",
      messages: [{ role: "user", content: "Weather in Lagos?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: {} } } }],
      tool_choice: "auto",
    });
    const call = completion.choices[0]!.message.tool_calls![0]!;
    assert.equal(call.type, "function");
    assert.equal(call.type === "function" && call.function.name, "get_weather");
    assert.equal(completion.choices[0]!.finish_reason, "tool_calls");
    assert.equal(completion.usage?.total_tokens, 52);
    assert.equal(calls[1].tool_choice, "auto");
    assert.equal(calls[1].model, "meta-llama/Meta-Llama-3.1-8B-Instruct");

    // The tool result goes back the way OpenAI's protocol says.
    await client.chat.completions.create({
      model: "my-llama",
      messages: [
        { role: "user", content: "Weather in Lagos?" },
        completion.choices[0]!.message,
        { role: "tool", tool_call_id: call.id, content: '{"tempC":31}' },
      ],
    });
    assert.deepEqual(
      calls[2].messages.map((m: any) => m.role),
      ["user", "assistant", "tool"],
    );
    assert.equal(calls[2].messages[2].tool_call_id, "chatcmpl-tool-1");

    await assert.rejects(
      client.chat.completions.create({ model: "my-llama", messages: [{ role: "user", content: "break" }] }),
      (err: any) => {
        assert.equal(err.status, 400, "the model server's status, as the SDK's typed BadRequestError");
        assert.equal(err.code, "provider_rejected_request");
        assert.match(err.message, /max_tokens is too large for this model/);
        return true;
      },
    );
  } finally {
    await restore();
  }
});

// ============================================
// A caller that hangs up mid-stream
// ============================================

test("a per-request-billed stream the caller hangs up on is charged for the part generated, not refunded", async () => {
  const http = await import("node:http");
  const node: { sendMore: (() => void) | null } = { sendMore: null };
  let upstreamCancelled = false;
  const { app, state, restore } = await v1App({
    balance: 10_000n,
    deployment: perRequest({ model: { pricingTier: "large", hfId: "x/y" } }),
    nodeResponse: (init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            // A long first part, then the node keeps "generating" until told.
            controller.enqueue(enc.encode(`data: ${JSON.stringify(nodeChunk({ content: "y".repeat(400_000) }))}\n\n`));
            node.sendMore = () => controller.enqueue(enc.encode(`data: ${JSON.stringify(nodeChunk({ content: "z" }))}\n\n`));
            // What fetch does to a response body when its signal aborts.
            init.signal.addEventListener("abort", () => {
              upstreamCancelled = true;
              controller.error(init.signal.reason);
            });
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/v1/my-llama/chat/completions", method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.once("data", () => {
            // The first bytes arrived: hang up.
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", () => {});
      req.once("close", () => resolve());
      req.on("socket", (socket) => socket.on("error", () => {}));
      req.end(JSON.stringify({ messages: hello, stream: true, max_tokens: 8192 }));
      setTimeout(() => reject(new Error("no bytes arrived")), 2_000).unref();
    });

    // Give the server its close event, then let the node try to send more.
    for (let i = 0; i < 100 && state.ledger.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        node.sendMore?.();
      } catch {
        // The node stream was aborted: exactly what should happen.
      }
    }
    assert.equal(upstreamCancelled, true, "the node call stops when the caller leaves");
    assert.ok(state.balance < 10_000n, "the generated part is paid for");
    assert.ok(
      !state.ledger.some((l) => l.type === "usage_release" && l.amountCents >= state.ledger[0]!.amountCents),
      "the hold is not handed back in full",
    );
    assert.deepEqual(state.nodeUpdates, []);
  } finally {
    await restore();
  }
});
