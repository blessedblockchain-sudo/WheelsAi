import assert from "node:assert/strict";
import test from "node:test";

// Env must be in place BEFORE the route module (and config/env.ts) is imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance } from "fastify";

import type { AgentChatAgent, AgentChatDeps } from "../services/agentChat.js";
import type { ChatMessage, ChatResult, ChatStream, RunChatOptions } from "../services/mastra-runtime.js";
import { createMemoryToolContinuationStore } from "../services/toolContinuationStore.js";

// POST /v1/agents/:slug/chat/completions and GET /v1/agents/:slug/models
// through the real routes, the real /v1 guard and the real agent-chat core,
// with only the effects faked. What an OpenAI SDK sees - status, headers,
// body, stream - is asserted as that SDK reads it.

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "http://localhost:3000";

const AGENT: AgentChatAgent = {
  id: AGENT_ID,
  orgId: ORG,
  slug: "support-bot",
  name: "Support Bot",
  version: "1.2.0",
  systemPrompt: "Be brief.",
  tools: [],
  modelConfig: { externalModel: "free/groq/llama-3.3-70b" },
  env: null,
  knowledgeBaseId: null,
};

const RESULT: ChatResult = {
  content: "Refunds take 5 days.",
  usage: { inputTokens: 21, outputTokens: 6 },
  reportedUsage: { inputTokens: 21, outputTokens: 6 },
  finishReason: "stop",
  toolCalls: [{ round: 1, name: "calculator", status: "ok", detail: null }],
  clientToolCalls: [],
  transcript: [],
};

// What a provider streams, vendor fields and all.
const PROVIDER_FRAMES = [
  'data: {"id":"chatcmpl-PROVIDER","model":"llama-3.3-70b-versatile","x_groq":{"id":"req_1"},"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-PROVIDER","model":"llama-3.3-70b-versatile","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-PROVIDER","model":"llama-3.3-70b-versatile","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"chatcmpl-PROVIDER","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}\n\n',
  "data: [DONE]\n\n",
];

interface Spy {
  money: string[];
  chat: Array<{ messages: ChatMessage[]; options: RunChatOptions; model: string }>;
  loads: Array<Record<string, unknown>>;
  metered: string[];
  usage: Array<Record<string, unknown>>;
}

function streamOf(frames: string[], outcome: Awaited<ChatStream["outcome"]>): ChatStream {
  const enc = new TextEncoder();
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(enc.encode(frame));
        controller.close();
      },
    }),
    outcome: Promise.resolve(outcome),
  };
}

function chatDeps(over: Partial<AgentChatDeps> = {}, charge = false): { deps: AgentChatDeps; spy: Spy } {
  const spy: Spy = { money: [], chat: [], loads: [], metered: [], usage: [] };
  const handle = {
    charge: { install: { listingTitle: "Support Pro" }, grossCents: 5n, creatorCents: 4n } as never,
    settle: async () => void spy.money.push("settle"),
    refund: async (reason: string) => void spy.money.push(`refund:${reason}`),
  };
  const deps: AgentChatDeps = {
    loadAgent: async (where) => {
      spy.loads.push(where);
      return where.orgId === AGENT.orgId && "slug" in where && where.slug === AGENT.slug ? AGENT : null;
    },
    openAgentEnv: () => ({}),
    availableFreeModelIds: () => ["free/groq/llama-3.3-70b"],
    isFreeModel: (id) => id.startsWith("free/"),
    resolveModel: (modelId) => ({ apiKey: "k", baseUrl: "https://provider.example/v1", modelName: modelId }),
    checkFreeTierLimit: async () => ({
      allowed: true,
      remaining: { rpm: 19, rpd: 199 },
      resetAt: { rpm: 1_760_000_030, rpd: 1_760_086_400 },
    }),
    retrieveContext: async () => null,
    beginMetering: async () => (charge ? { ok: true as const, handle } : null),
    resolveToolMode: async ({ base }) => base,
    skillKeys: () => ["calculator", "web_search"],
    runChat: async (resolved, _config, messages, options) => {
      spy.chat.push({ messages, options, model: resolved.modelName });
      return RESULT;
    },
    runChatStream: async (resolved, _config, messages, options) => {
      spy.chat.push({ messages, options, model: resolved.modelName });
      return streamOf(PROVIDER_FRAMES, {
        ok: true,
        usage: { inputTokens: 9, outputTokens: 2 },
        toolCalls: [],
        finishReason: "stop",
      });
    },
    recordUsage: async (record) => void spy.usage.push(record as never),
    deadlineMs: 120_000,
    now: () => 1_760_000_000_000,
    ...over,
  };
  return { deps, spy };
}

type Principal = Record<string, unknown> | null;
const SESSION: Principal = { userId: "user-1", orgId: ORG, type: "jwt" };
const KEY: Principal = { userId: null, orgId: ORG, type: "api_key", scopes: [] };

async function buildApp(
  deps: AgentChatDeps,
  spy: Spy,
  opts: { principal?: Principal; meter?: (orgId: string) => Promise<unknown> } = {},
): Promise<FastifyInstance> {
  const { createOpenAiV1Routes } = await import("../routes/openaiV1.js");
  const { createOpenAiAuth, AGENTS_INVOKE_SCOPE } = await import("../middleware/openaiAuth.js");
  const meter =
    opts.meter ??
    (async (orgId: string) => {
      spy.metered.push(orgId);
    });
  const app = Fastify();
  await app.register(cors, { origin: ORIGIN, credentials: true });
  await app.register(sensible);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as { auth: unknown }).auth = opts.principal === undefined ? KEY : opts.principal;
  });
  await app.register(
    createOpenAiV1Routes({
      chatDeps: () => deps,
      auth: createOpenAiAuth({ scope: AGENTS_INVOKE_SCOPE, meter }),
      unifiedAuth: createOpenAiAuth({ meter }),
      findAgent: async (orgId, slug) =>
        orgId === ORG && slug === AGENT.slug
          ? { slug, createdAt: new Date("2026-10-01T00:00:00Z") }
          : null,
      listModels: async () => ({ deployments: [], agents: [], workflows: [] }),
      now: () => 1_760_000_000_000,
      heartbeatMs: 0,
    }),
    { prefix: "/v1" },
  );
  await app.ready();
  return app;
}

const URL = "/v1/agents/support-bot/chat/completions";
const HELLO = { messages: [{ role: "user", content: "How long do refunds take?" }] };

const post = (app: FastifyInstance, payload: unknown, url = URL, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers: { origin: ORIGIN, ...headers }, payload: payload as never });

function sseData(body: string): any[] {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data:") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(5)));
}

// ============================================
// Authentication, scope and metering
// ============================================

test("no credentials: 401 in OpenAI's shape, and nothing is metered or looked up", async () => {
  const { deps, spy } = chatDeps();
  const app = await buildApp(deps, spy, { principal: null });
  try {
    for (const res of [
      await post(app, HELLO),
      await app.inject({ method: "GET", url: "/v1/agents/support-bot/models" }),
      await post(app, { model: "agent/support-bot", ...HELLO }, "/v1/chat/completions"),
      await app.inject({ method: "GET", url: "/v1/models" }),
    ]) {
      assert.equal(res.statusCode, 401);
      const { error } = res.json();
      assert.equal(error.type, "invalid_request_error");
      assert.equal(error.code, "invalid_api_key");
      assert.equal(error.param, null);
      assert.match(error.message, /Authorization: Bearer/);
    }
    assert.deepEqual(spy.metered, []);
    assert.deepEqual(spy.loads, []);
  } finally {
    await app.close();
  }
});

test("a completion is one plan API call for a key and for a session; listing models is free", async () => {
  for (const principal of [KEY, SESSION]) {
    const { deps, spy } = chatDeps();
    const app = await buildApp(deps, spy, { principal });
    try {
      assert.equal((await post(app, HELLO)).statusCode, 200);
      assert.deepEqual(spy.metered, [ORG]);
      assert.equal((await app.inject({ method: "GET", url: "/v1/agents/support-bot/models" })).statusCode, 200);
      assert.equal((await app.inject({ method: "GET", url: "/v1/models" })).statusCode, 200);
      assert.deepEqual(spy.metered, [ORG], "the reads spent nothing");
    } finally {
      await app.close();
    }
  }
});

test("an exhausted plan is 429 insufficient_quota with x-should-retry: false, before the agent is touched", async () => {
  const { PlanLimitError } = await import("../services/plans.js");
  const { deps, spy } = chatDeps();
  const app = await buildApp(deps, spy, {
    meter: async () => {
      throw new PlanLimitError("The Starter plan includes 1,000 API calls per month, and this month's are used up. Upgrade for more.", "starter" as never, "monthlyApiCalls");
    },
  });
  try {
    const res = await post(app, HELLO);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["x-should-retry"], "false", "an SDK must not retry a quota: each retry is the same refusal");
    const { error } = res.json();
    assert.equal(error.type, "insufficient_quota");
    assert.equal(error.code, "plan_limit_reached");
    assert.match(error.message, /1,000 API calls/);
    assert.equal(error.plan, "starter");
    assert.deepEqual(spy.loads, []);
    assert.deepEqual(spy.chat, []);
  } finally {
    await app.close();
  }
});

test("a scoped key needs agents:invoke (or *); a key with no scopes keeps full access", async () => {
  const run = async (scopes: string[]) => {
    const { deps, spy } = chatDeps();
    const app = await buildApp(deps, spy, { principal: { ...KEY, scopes } });
    try {
      return {
        path: await post(app, HELLO),
        unified: await post(app, { model: "agent/support-bot", ...HELLO }, "/v1/chat/completions"),
        spy,
      };
    } finally {
      await app.close();
    }
  };

  const denied = await run(["deployments:read"]);
  for (const res of [denied.path, denied.unified]) {
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.type, "permission_error");
    assert.equal(res.json().error.code, "insufficient_scope");
    assert.equal(res.headers["x-should-retry"], "false");
  }
  assert.deepEqual(denied.spy.chat, []);

  for (const scopes of [[], ["*"], ["agents:invoke"], ["deployments:read", "agents:invoke"]]) {
    const ok = await run(scopes);
    assert.equal(ok.path.statusCode, 200, JSON.stringify(scopes));
    assert.equal(ok.unified.statusCode, 200, JSON.stringify(scopes));
  }
});

// ============================================
// Resolution
// ============================================

test("another organization's slug is 404 agent_not_found: no model call, no charge", async () => {
  const { deps, spy } = chatDeps({}, true);
  const app = await buildApp(deps, spy, { principal: { ...KEY, orgId: OTHER_ORG } });
  try {
    const res = await post(app, HELLO);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, "agent_not_found");
    assert.equal(res.headers["x-should-retry"], "false");
    assert.deepEqual(spy.loads, [{ orgId: OTHER_ORG, slug: "support-bot" }], "looked up in the CALLER's organization");
    assert.deepEqual(spy.chat, []);
    assert.deepEqual(spy.money, []);

    const models = await app.inject({ method: "GET", url: "/v1/agents/support-bot/models" });
    assert.equal(models.statusCode, 404);
    assert.equal(models.json().error.code, "agent_not_found");
  } finally {
    await app.close();
  }
});

// ============================================
// Non-streamed
// ============================================

test("a completion is a chat.completion named agent/<slug>; the body's model is accepted and ignored", async () => {
  const { deps, spy } = chatDeps({}, true);
  const app = await buildApp(deps, spy);
  try {
    const res = await post(
      app,
      {
        model: "gpt-4o",
        ...HELLO,
        temperature: 0.2,
        max_completion_tokens: 300,
        seed: 7,
        some_vendor_flag: true,
      },
      URL,
      { "x-request-id": "req-from-client" },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-request-id"], "req-from-client");
    const body = res.json();
    assert.match(body.id, /^chatcmpl-[0-9a-f-]{36}$/);
    assert.equal(body.object, "chat.completion");
    assert.equal(body.created, 1_760_000_000);
    assert.equal(body.model, "agent/support-bot");
    assert.deepEqual(body.choices, [
      {
        index: 0,
        message: { role: "assistant", content: "Refunds take 5 days.", refusal: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ]);
    assert.deepEqual(body.usage, { prompt_tokens: 21, completion_tokens: 6, total_tokens: 27 });
    assert.deepEqual(body.wheelsai, {
      agent: { slug: "support-bot", version: "1.2.0" },
      model: "free/groq/llama-3.3-70b",
      runtime: "platform",
      billing: { listingTitle: "Support Pro", chargedCents: 5, creatorCents: 4 },
      retrieval: null,
      tool_calls: [{ round: 1, name: "calculator", status: "ok", detail: null }],
    });

    // The agent's own model ran, with the caller's sampling parameters and
    // nothing else from the body.
    assert.equal(spy.chat.length, 1);
    assert.equal(spy.chat[0]!.model, "free/groq/llama-3.3-70b");
    assert.deepEqual(spy.chat[0]!.options.requestParams, { temperature: 0.2, max_tokens: 300, seed: 7 });
    assert.equal(spy.chat[0]!.options.mode, "api");
    assert.deepEqual(spy.money, ["settle"]);
    assert.equal(spy.usage[0]!.source, "api");

    // The free-model limiter's verdict, in OpenAI's header names and ours.
    assert.equal(res.headers["x-ratelimit-remaining-requests"], "19");
    assert.equal(res.headers["x-ratelimit-reset-requests"], "30s");
    assert.equal(res.headers["x-ratelimit-remaining-rpd"], "199");
  } finally {
    await app.close();
  }
});

test("usage the provider did not report is omitted, never zero", async () => {
  const { deps, spy } = chatDeps({
    runChat: async () => ({ ...RESULT, usage: { inputTokens: 0, outputTokens: 0 }, reportedUsage: null }),
  });
  const app = await buildApp(deps, spy);
  try {
    const body = (await post(app, HELLO)).json();
    assert.ok(!("usage" in body));
  } finally {
    await app.close();
  }
});

test("request validation answers 400 naming the parameter, before the agent is loaded", async () => {
  const { deps, spy } = chatDeps();
  const app = await buildApp(deps, spy);
  try {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ ...HELLO, n: 3 }, "unsupported_parameter", "n"],
      [{ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] }, "unsupported_content", "messages[0].content"],
      [{ messages: [] }, "validation_failed", "messages"],
      [{ ...HELLO, functions: [{ name: "f" }] }, "unsupported_parameter", "functions"],
    ];
    for (const [payload, code, param] of cases) {
      const res = await post(app, payload);
      assert.equal(res.statusCode, 400, code);
      assert.equal(res.json().error.type, "invalid_request_error");
      assert.equal(res.json().error.code, code);
      assert.equal(res.json().error.param, param);
    }
    assert.deepEqual(spy.loads, []);
  } finally {
    await app.close();
  }
});

// ============================================
// Streamed
// ============================================

test("stream: OpenAI chunks under our id and model, one [DONE], and the headers set before it survive", async () => {
  const { deps, spy } = chatDeps({}, true);
  const app = await buildApp(deps, spy);
  try {
    const res = await post(app, { ...HELLO, stream: true }, URL, { "x-request-id": "req-7" });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /^text\/event-stream/);
    assert.equal(res.headers["x-accel-buffering"], "no");
    assert.equal(res.headers["access-control-allow-origin"], ORIGIN, "CORS survives the raw write");
    assert.equal(res.headers["x-request-id"], "req-7");
    assert.equal(res.headers["x-ratelimit-remaining-requests"], "19");

    assert.ok(!/PROVIDER|x_groq|llama-3.3-70b-versatile/.test(res.body), "no provider id, model or vendor field");
    assert.equal(res.body.match(/data: \[DONE\]/g)?.length, 1);
    assert.ok(res.body.endsWith("data: [DONE]\n\n"));

    const chunks = sseData(res.body);
    for (const chunk of chunks) {
      assert.match(chunk.id, /^chatcmpl-/);
      assert.equal(chunk.id, chunks[0].id);
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.equal(chunk.model, "agent/support-bot");
      // The loop every OpenAI quickstart writes must not throw on any chunk.
      assert.equal(chunk.choices.length, 1);
      void chunk.choices[0].delta.content;
    }
    assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
    assert.equal(chunks[0].wheelsai.agent.slug, "support-bot");
    assert.equal(chunks[0].wheelsai.model, "free/groq/llama-3.3-70b");
    assert.deepEqual(chunks[0].wheelsai.billing, { listingTitle: "Support Pro", chargedCents: 5, creatorCents: 4 });
    assert.equal(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), "Hello");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
    assert.ok(!res.body.includes('"usage"'), "usage was not asked for");

    assert.deepEqual(spy.money, ["settle"], "delivered, so settled - once");
  } finally {
    await app.close();
  }
});

test("stream_options.include_usage adds exactly one usage chunk before [DONE]", async () => {
  const { deps, spy } = chatDeps();
  const app = await buildApp(deps, spy);
  try {
    const res = await post(app, { ...HELLO, stream: true, stream_options: { include_usage: true } });
    const usage = sseData(res.body).filter((c) => c.usage);
    assert.equal(usage.length, 1);
    assert.deepEqual(usage[0].usage, { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
    assert.deepEqual(usage[0].choices, []);
    assert.ok(res.body.endsWith(`data: ${JSON.stringify(usage[0])}\n\ndata: [DONE]\n\n`));
  } finally {
    await app.close();
  }
});

test("a stream that fails after the headers ends with one error event, no [DONE], and a refund", async () => {
  const { deps, spy } = chatDeps(
    {
      runChatStream: async () =>
        streamOf(
          [
            PROVIDER_FRAMES[0]!,
            'data: {"error":{"message":"upstream account acct_9 over quota at /srv/provider/app.py"}}\n\n',
            "data: [DONE]\n\n",
          ],
          { ok: false, error: "provider error: upstream account acct_9 over quota", toolCalls: [], code: "provider_error" },
        ),
    },
    true,
  );
  const app = await buildApp(deps, spy);
  try {
    const res = await post(app, { ...HELLO, stream: true });
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes("[DONE]"));
    assert.ok(!/acct_9|app\.py/.test(res.body), "the provider's own words never reach the client");
    const last = sseData(res.body).at(-1);
    assert.equal(last.error.type, "server_error");
    assert.equal(last.error.code, "upstream_error");
    assert.equal(spy.money.length, 1);
    assert.match(spy.money[0]!, /^refund:/);
  } finally {
    await app.close();
  }
});

test("a failure before the first byte is a plain HTTP error in OpenAI's shape, refunded", async () => {
  const providerDown = Object.assign(new Error("Model API returned 429 (rate limited by the provider)"), {
    name: "ProviderHttpError",
    status: 429,
    retryAfterSeconds: 12,
  });
  for (const stream of [false, true]) {
    const { deps, spy } = chatDeps(
      {
        runChat: async () => {
          throw providerDown;
        },
        runChatStream: async () => {
          throw providerDown;
        },
      },
      true,
    );
    const app = await buildApp(deps, spy);
    try {
      const res = await post(app, { ...HELLO, stream });
      assert.equal(res.statusCode, 429);
      assert.match(String(res.headers["content-type"]), /application\/json/);
      assert.equal(res.headers["retry-after"], "12", "the provider's own retry-after is passed on");
      assert.equal(res.json().error.code, "provider_rate_limited");
      assert.equal(spy.money.length, 1);
      assert.match(spy.money[0]!, /^refund:/);
    } finally {
      await app.close();
    }
  }
});

test("provider failures map to statuses an SDK handles: a provider 401 is never OUR 401", async () => {
  const cases: Array<[Record<string, unknown>, number, string, string | undefined]> = [
    [{ name: "ProviderHttpError", status: 401 }, 502, "provider_auth_failed", "false"],
    [{ name: "ProviderHttpError", status: 404 }, 502, "provider_model_not_found", "false"],
    [{ name: "ProviderHttpError", status: 400 }, 400, "provider_rejected_request", undefined],
    [{ name: "ProviderHttpError", status: 500 }, 502, "upstream_error", undefined],
    [{ name: "ChatDeadlineError" }, 504, "upstream_timeout", undefined],
    [{ name: "EmptyModelAnswerError" }, 502, "empty_answer", undefined],
    [{ name: "ToolLoopExhaustedError" }, 502, "tool_loop_exhausted", undefined],
    [{ name: "TypeError", message: "connect ECONNREFUSED 10.0.0.4:5432 at /app/dist/x.js" }, 502, "upstream_error", undefined],
  ];
  for (const [thrown, status, code, shouldRetry] of cases) {
    const { deps, spy } = chatDeps({
      runChat: async () => {
        throw Object.assign(new Error((thrown.message as string) ?? "Model API returned an error"), thrown);
      },
    });
    const app = await buildApp(deps, spy);
    try {
      const res = await post(app, HELLO);
      assert.equal(res.statusCode, status, code);
      assert.equal(res.json().error.code, code);
      assert.equal(res.headers["x-should-retry"], shouldRetry, code);
      assert.ok(!/ECONNREFUSED|10\.0\.0\.4|dist/.test(res.body));
    } finally {
      await app.close();
    }
  }
});

// ============================================
// Function calling
// ============================================

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Current weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

test("function calling round trip: tool_calls out, tool results in, answer out, server rounds spliced back", async () => {
  const continuations = createMemoryToolContinuationStore();
  // What the tool loop appended server-side on the first request: the model
  // asked for the agent's own calculator AND the caller's get_weather.
  const serverTranscript = [
    {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        { id: "call_srv", type: "function" as const, function: { name: "calculator", arguments: '{"expression":"2+2"}' } },
        { id: "call_abc", type: "function" as const, function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
      ],
    },
    { role: "tool" as const, content: "4", tool_call_id: "call_srv" },
  ];
  let turn = 0;
  const { deps, spy } = chatDeps({
    continuations,
    runChat: async (resolved, _config, messages, options) => {
      spy.chat.push({ messages, options, model: resolved.modelName });
      turn += 1;
      if (turn === 1) {
        return {
          content: "",
          usage: { inputTokens: 30, outputTokens: 12 },
          reportedUsage: { inputTokens: 30, outputTokens: 12 },
          finishReason: "tool_calls",
          toolCalls: [{ round: 1, name: "calculator", status: "ok", detail: null }],
          clientToolCalls: [{ id: "call_abc", name: "get_weather", arguments: '{"city":"Oslo"}' }],
          transcript: serverTranscript,
        };
      }
      return { ...RESULT, content: "It is 4 degrees in Oslo.", toolCalls: [] };
    },
  }, true);
  const app = await buildApp(deps, spy);
  try {
    const first = await post(app, {
      messages: [{ role: "user", content: "Weather in Oslo, and 2+2?" }],
      tools: [WEATHER_TOOL],
      tool_choice: "auto",
    });
    assert.equal(first.statusCode, 200);
    const choice = first.json().choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.content, null);
    assert.deepEqual(choice.message.tool_calls, [
      { id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
    ]);
    assert.ok(!JSON.stringify(choice).includes("calculator"), "the agent's own call is not handed to the caller");
    assert.deepEqual(first.json().wheelsai.tool_calls, [{ round: 1, name: "calculator", status: "ok", detail: null }]);
    // The caller's function was offered to the model next to the agent's.
    assert.deepEqual(spy.chat[0]!.options.clientTools, [WEATHER_TOOL]);
    assert.equal(spy.chat[0]!.options.toolChoice, "auto");
    assert.deepEqual(spy.money, ["settle"], "a hand-back is a delivered response");

    // The caller replays what it was shown, plus its result.
    const second = await post(app, {
      messages: [
        { role: "user", content: "Weather in Oslo, and 2+2?" },
        choice.message,
        { role: "tool", tool_call_id: "call_abc", content: '{"temp_c":4}' },
      ],
      tools: [WEATHER_TOOL],
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().choices[0].message.content, "It is 4 degrees in Oslo.");
    assert.equal(second.json().choices[0].finish_reason, "stop");

    // The model sees the full turn: its own two calls, the server result the
    // caller never had, then the caller's result.
    assert.deepEqual(spy.chat[1]!.messages, [
      { role: "user", content: "Weather in Oslo, and 2+2?" },
      serverTranscript[0],
      { role: "tool", content: "4", tool_call_id: "call_srv" },
      { role: "tool", content: '{"temp_c":4}', tool_call_id: "call_abc" },
    ]);
    assert.deepEqual(spy.money, ["settle", "settle"], "each round trip is one request");
    assert.deepEqual(spy.metered, [ORG, ORG]);
  } finally {
    await app.close();
  }
});

test("a streamed hand-back arrives as delta.tool_calls with finish_reason tool_calls and settles", async () => {
  const { deps, spy } = chatDeps(
    {
      runChatStream: async () =>
        streamOf(
          [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Oslo\\"}"}}]},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
            "data: [DONE]\n\n",
          ],
          {
            ok: true,
            usage: null,
            toolCalls: [],
            finishReason: "tool_calls",
            clientToolCalls: [{ id: "call_abc", name: "get_weather", arguments: '{"city":"Oslo"}' }],
            transcript: [],
          },
        ),
    },
    true,
  );
  const app = await buildApp(deps, spy);
  try {
    const res = await post(app, { ...HELLO, stream: true, tools: [WEATHER_TOOL] });
    const chunks = sseData(res.body);
    const calls = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    assert.deepEqual(calls, [
      { index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
    ]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    assert.ok(res.body.endsWith("data: [DONE]\n\n"));
    assert.deepEqual(spy.money, ["settle"]);
  } finally {
    await app.close();
  }
});

test("a caller tool named like a platform skill is 400 tool_name_conflict; tool_choice must name a listed tool", async () => {
  const { deps, spy } = chatDeps({}, true);
  const app = await buildApp(deps, spy);
  try {
    const conflict = await post(app, {
      ...HELLO,
      tools: [{ type: "function", function: { name: "web_search" } }],
    });
    assert.equal(conflict.statusCode, 400);
    assert.equal(conflict.json().error.code, "tool_name_conflict");
    assert.equal(conflict.json().error.param, "tools");

    const unknown = await post(app, {
      ...HELLO,
      tools: [WEATHER_TOOL],
      tool_choice: { type: "function", function: { name: "calculator" } },
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().error.code, "unknown_tool_choice");
    assert.deepEqual(spy.chat, []);
    assert.deepEqual(spy.money, [], "refused before any charge");
  } finally {
    await app.close();
  }
});

// ============================================
// Refusals
// ============================================

test("402 and 403 carry the listing and token details and tell the SDK not to retry", async () => {
  const pay = chatDeps({
    beginMetering: async () => ({
      ok: false as const,
      reason: "insufficient_credits" as never,
      listingTitle: "Support Pro",
      requiredCents: 5n,
      balanceCents: 2n,
    }) as never,
  });
  let app = await buildApp(pay.deps, pay.spy);
  try {
    const res = await post(app, HELLO);
    assert.equal(res.statusCode, 402);
    assert.equal(res.headers["x-should-retry"], "false");
    const { error } = res.json();
    assert.equal(error.type, "payment_required");
    assert.equal(error.code, "marketplace_payment_required");
    assert.equal(error.requiredCents, 5);
    assert.equal(error.balanceCents, 2);
    assert.equal(error.listingTitle, "Support Pro");
    assert.match(error.message, /0\.0500 USD/);
    assert.deepEqual(pay.spy.chat, []);
  } finally {
    await app.close();
  }

  const revoked = chatDeps({
    beginMetering: async () => ({
      ok: false as const,
      reason: "licence_revoked" as const,
      listingTitle: "Support Pro",
      revocation: "token_required" as const,
      token: { symbol: "SUP", mintAddress: "Mint1111111111111111111111111111111111111111" },
    }) as never,
  });
  app = await buildApp(revoked.deps, revoked.spy);
  try {
    const res = await post(app, HELLO);
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers["x-should-retry"], "false");
    const { error } = res.json();
    assert.equal(error.type, "permission_error");
    assert.equal(error.code, "licence_revoked");
    assert.equal(error.reason, "token_required");
    assert.equal(error.tokenSymbol, "SUP");
    assert.equal(error.mintAddress, "Mint1111111111111111111111111111111111111111");
    assert.deepEqual(revoked.spy.chat, []);
  } finally {
    await app.close();
  }
});

test("the free-model limit is 429 with retry-after and the rate-limit headers; the daily one is not retried", async () => {
  const minute = chatDeps({
    checkFreeTierLimit: async () => ({
      allowed: false,
      remaining: { rpm: 0, rpd: 150 },
      resetAt: { rpm: 1_760_000_042, rpd: 1_760_086_400 },
    }),
  }, true);
  let app = await buildApp(minute.deps, minute.spy);
  try {
    const res = await post(app, HELLO);
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error.type, "requests");
    assert.equal(res.json().error.code, "rate_limit_exceeded");
    assert.equal(res.headers["retry-after"], "42");
    assert.equal(res.headers["x-should-retry"], undefined, "the SDK's own backoff is right for a per-minute limit");
    assert.equal(res.headers["x-ratelimit-remaining-requests"], "0");
    assert.equal(res.headers["x-ratelimit-reset-requests"], "42s");
    assert.deepEqual(minute.spy.chat, []);
    assert.deepEqual(minute.spy.money, [], "limited before any charge");
  } finally {
    await app.close();
  }

  const day = chatDeps({
    checkFreeTierLimit: async () => ({
      allowed: false,
      remaining: { rpm: 12, rpd: 0 },
      resetAt: { rpm: 1_760_000_042, rpd: 1_760_003_600 },
    }),
  });
  app = await buildApp(day.deps, day.spy);
  try {
    const res = await post(app, HELLO);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["retry-after"], "3600");
    assert.equal(res.headers["x-should-retry"], "false");
  } finally {
    await app.close();
  }
});

test("a platform with no provider for the agent's model answers an honest 501, not retried", async () => {
  const { deps, spy } = chatDeps({
    availableFreeModelIds: () => [],
    loadAgent: async () => ({ ...AGENT, modelConfig: {} }),
  });
  const app = await buildApp(deps, spy);
  try {
    const res = await post(app, HELLO);
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error.type, "server_error");
    assert.equal(res.json().error.code, "model_provider_not_configured");
    assert.equal(res.headers["x-should-retry"], "false");
  } finally {
    await app.close();
  }
});

// ============================================
// The /v1 error surface
// ============================================

test("Fastify's own failures under /v1 keep their status and take OpenAI's shape", async () => {
  const { deps, spy } = chatDeps();
  const app = await buildApp(deps, spy);
  try {
    const big = await post(app, { messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024 + 10) }] });
    assert.equal(big.statusCode, 413);
    assert.equal(big.json().error.code, "request_too_large");
    assert.equal(big.json().error.type, "invalid_request_error");

    const badJson = await app.inject({
      method: "POST",
      url: URL,
      headers: { "content-type": "application/json" },
      payload: '{"messages": [',
    });
    assert.equal(badJson.statusCode, 400);
    assert.equal(badJson.json().error.code, "validation_failed");

    const media = await app.inject({
      method: "POST",
      url: URL,
      headers: { "content-type": "application/xml" },
      payload: "<a/>",
    });
    assert.equal(media.statusCode, 415);
    assert.equal(media.json().error.code, "unsupported_media_type");

    assert.deepEqual(spy.chat, []);
  } finally {
    await app.close();
  }
});

test("a /v1 path this API does not have is a named OpenAI-shaped 404", async () => {
  const { deps, spy } = chatDeps();
  const app = await buildApp(deps, spy);
  try {
    for (const [method, url] of [
      ["POST", "/v1/responses"],
      ["POST", "/v1/embeddings"],
      ["GET", "/v1/agents/support-bot"],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      assert.equal(res.statusCode, 404, url);
      const { error } = res.json();
      assert.equal(error.code, "not_found");
      assert.equal(error.type, "invalid_request_error");
      assert.ok(error.message.includes(url));
      assert.equal(res.headers["x-should-retry"], "false");
    }
  } finally {
    await app.close();
  }
});

// ============================================
// Models
// ============================================

test("GET /v1/agents/:slug/models lists exactly agent/<slug>", async () => {
  const { deps, spy } = chatDeps();
  const app = await buildApp(deps, spy);
  try {
    const res = await app.inject({ method: "GET", url: "/v1/agents/support-bot/models" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      object: "list",
      data: [
        {
          id: "agent/support-bot",
          object: "model",
          created: Math.floor(Date.parse("2026-10-01T00:00:00Z") / 1000),
          owned_by: "wheelsai",
          wheelsai: { kind: "agent" },
        },
      ],
    });
  } finally {
    await app.close();
  }
});

// ============================================
// Graph agents
// ============================================

const GRAPH_RUN = {
  executionId: "44444444-4444-4444-8444-444444444444",
  durationMs: 310,
  steps: [
    { nodeId: "n1", nodeType: "memory", label: "Look up policy", status: "success", durationMs: 40 },
    { nodeId: "n2", nodeType: "llm", label: "Answer", status: "success", durationMs: 260 },
  ],
};

async function graphDeps(outcome: Awaited<ReturnType<NonNullable<AgentChatDeps["runGraph"]>>>) {
  const { answerToStream } = await import("../services/mastra-runtime.js");
  const inputs: string[] = [];
  const made = chatDeps({
    loadAgent: async (where) =>
      where.orgId === ORG && "slug" in where && where.slug === AGENT.slug
        ? { ...AGENT, entrypoint: "graph" }
        : null,
    runGraph: async ({ input }) => {
      inputs.push(input);
      return outcome;
    },
    answerStream: (result, modelName) => answerToStream(result, modelName, false),
  });
  return { ...made, inputs };
}

test("a graph agent answers /v1 through its graph: a chat.completion with no usage and the run in wheelsai.graph", async () => {
  const { deps, spy, inputs } = await graphDeps({ kind: "completed", output: "Refunds take 5 days.", run: GRAPH_RUN });
  const app = await buildApp(deps, spy);
  try {
    const res = await post(app, HELLO);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "agent/support-bot");
    assert.equal(body.choices[0].message.content, "Refunds take 5 days.");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(body.usage, undefined, "no provider reports usage for a whole run; it is omitted, not zero");
    assert.equal(body.wheelsai.runtime, "graph");
    assert.deepEqual(body.wheelsai.graph, GRAPH_RUN);
    assert.deepEqual(inputs, ["How long do refunds take?"]);
    assert.equal(spy.chat.length, 0, "the chat runtime was not called");
  } finally {
    await app.close();
  }
});

test("a graph agent streams: OpenAI chunks, the run in the opening chunk, one [DONE]", async () => {
  const { deps, spy } = await graphDeps({ kind: "completed", output: "Refunds take 5 days.", run: GRAPH_RUN });
  const app = await buildApp(deps, spy);
  try {
    const res = await post(app, { ...HELLO, stream: true, stream_options: { include_usage: true } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    const chunks = sseData(res.body);
    assert.equal(chunks[0].wheelsai.runtime, "graph");
    assert.deepEqual(chunks[0].wheelsai.graph, GRAPH_RUN);
    assert.equal(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join(""), "Refunds take 5 days.");
    assert.ok(chunks.every((c) => c.model === "agent/support-bot"));
    assert.ok(chunks.every((c) => c.usage === undefined), "asked for, but unknown: no usage chunk is invented");
    assert.equal(res.body.match(/data: \[DONE\]/g)?.length, 1);
  } finally {
    await app.close();
  }
});

test("a graph agent's refusals and failures are OpenAI-shaped: 400 tools, 400 no graph, 402, 502 with the stored run", async () => {
  const cases: Array<{
    outcome: Awaited<ReturnType<NonNullable<AgentChatDeps["runGraph"]>>>;
    payload?: Record<string, unknown>;
    status: number;
    code: string;
    check?: (error: any, headers: Record<string, unknown>) => void;
  }> = [
    {
      outcome: { kind: "completed", output: "x", run: GRAPH_RUN },
      payload: { tools: [{ type: "function", function: { name: "lookup" } }] },
      status: 400,
      code: "unsupported_parameter",
      check: (error) => assert.equal(error.param, "tools"),
    },
    {
      outcome: { kind: "no_graph" },
      status: 400,
      code: "agent_graph_missing",
      check: (_error, headers) => assert.equal(headers["x-should-retry"], "false"),
    },
    {
      outcome: { kind: "payment_required", listingTitle: "Support Pro", requiredCents: 5n, balanceCents: 1n },
      status: 402,
      code: "marketplace_payment_required",
      check: (error) => assert.equal(error.requiredCents, 5),
    },
    {
      outcome: { kind: "failed", run: GRAPH_RUN, failedStep: "Look up policy" },
      status: 502,
      code: "graph_run_failed",
      check: (error) => {
        assert.equal(error.executionId, GRAPH_RUN.executionId);
        assert.equal(error.failedStep, "Look up policy");
      },
    },
    {
      outcome: { kind: "shutting_down" },
      status: 503,
      code: "service_unavailable",
      check: (_error, headers) => assert.equal(headers["retry-after"], "5"),
    },
  ];
  for (const c of cases) {
    const { deps, spy } = await graphDeps(c.outcome);
    const app = await buildApp(deps, spy);
    try {
      // Streamed and not: a refusal learned from the run is still a plain
      // HTTP error, because nothing has been flushed.
      for (const stream of [false, true]) {
        const res = await post(app, { ...HELLO, ...c.payload, stream });
        assert.equal(res.statusCode, c.status, `${c.code} stream=${stream}`);
        assert.equal(res.json().error.code, c.code);
        c.check?.(res.json().error, res.headers);
      }
    } finally {
      await app.close();
    }
  }
});
