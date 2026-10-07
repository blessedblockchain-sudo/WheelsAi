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
import type { ChatResult, ChatStream, RunChatOptions } from "../services/mastra-runtime.js";

// POST /api/agents/:agentId/playground/chat through the real route and the
// real agent-chat core, with only the effects faked. The dashboard depends on
// this request and response shape; moving the logic into the shared service
// must not have changed a byte of it.

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "http://localhost:3000";

const AGENT: AgentChatAgent = {
  id: AGENT_ID,
  orgId: ORG,
  slug: "support-bot",
  name: "Support Bot",
  version: "1.0.0",
  systemPrompt: null,
  tools: [],
  modelConfig: { externalModel: "free/groq/llama-3.3-70b" },
  env: null,
  knowledgeBaseId: "kb-1",
};

const RESULT: ChatResult = {
  content: "Refunds take 5 days.",
  usage: { inputTokens: 21, outputTokens: 6 },
  reportedUsage: { inputTokens: 21, outputTokens: 6 },
  finishReason: "stop",
  toolCalls: [{ round: 1, name: "web_search", status: "unavailable", detail: "web search is temporarily unavailable" }],
  clientToolCalls: [],
  transcript: [],
};

const STREAM_FRAMES = [
  'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"wheelsai":{"toolCalls":[{"name":"calculator","status":"ok","detail":null}]}}\n\n',
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

interface Spy {
  money: string[];
  chat: Array<{ messages: unknown; options: RunChatOptions; model: string }>;
}

function chatDeps(over: Partial<AgentChatDeps> = {}, charge = false): { deps: AgentChatDeps; spy: Spy } {
  const spy: Spy = { money: [], chat: [] };
  const handle = {
    charge: { install: { listingTitle: "Support Pro" }, grossCents: 5n, creatorCents: 4n } as never,
    settle: async () => void spy.money.push("settle"),
    refund: async (reason: string) => void spy.money.push(`refund:${reason}`),
  };
  const deps: AgentChatDeps = {
    loadAgent: async (where) =>
      where.orgId === AGENT.orgId && "id" in where && where.id === AGENT.id ? AGENT : null,
    openAgentEnv: () => ({}),
    availableFreeModelIds: () => ["free/groq/llama-3.3-70b"],
    isFreeModel: (id) => id.startsWith("free/"),
    resolveModel: (modelId) => ({ apiKey: "k", baseUrl: "https://provider.example/v1", modelName: modelId }),
    checkFreeTierLimit: async () => ({
      allowed: true,
      remaining: { rpm: 19, rpd: 199 },
      resetAt: { rpm: 1_760_000_060, rpd: 1_760_086_400 },
    }),
    retrieveContext: async () => ({
      contextBlock: "CONTEXT",
      mode: "keyword",
      fallbackReason: "embedding provider error: embeddings request failed: 429 account acct_77 over quota",
      sources: [{ chunkId: "c1", documentId: "d1", documentTitle: "Refund policy", score: 0.9, content: "private text" }],
    }) as never,
    beginMetering: async () => (charge ? { ok: true as const, handle } : null),
    resolveToolMode: async ({ base }) => base,
    skillKeys: () => ["calculator"],
    runChat: async (resolved, _config, messages, options) => {
      spy.chat.push({ messages, options, model: resolved.modelName });
      return RESULT;
    },
    runChatStream: async (resolved, _config, messages, options): Promise<ChatStream> => {
      spy.chat.push({ messages, options, model: resolved.modelName });
      const enc = new TextEncoder();
      return {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of STREAM_FRAMES) controller.enqueue(enc.encode(frame));
            controller.close();
          },
        }),
        outcome: Promise.resolve({ ok: true as const, usage: null, toolCalls: [] }),
      };
    },
    recordUsage: async () => {},
    deadlineMs: 120_000,
    ...over,
  };
  return { deps, spy };
}

async function buildApp(deps: AgentChatDeps, orgId = ORG): Promise<FastifyInstance> {
  const { createPlaygroundRoutes } = await import("../routes/playground.js");
  const app = Fastify();
  await app.register(cors, { origin: ORIGIN, credentials: true });
  await app.register(sensible);
  await app.register(
    createPlaygroundRoutes({
      chatDeps: () => deps,
      requireAuth: async (request) => {
        (request as { auth?: unknown }).auth = { orgId, userId: "user-1" };
      },
    }),
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

const chat = (app: FastifyInstance, payload: Record<string, unknown>, agentId = AGENT_ID) =>
  app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/playground/chat`,
    headers: { origin: ORIGIN },
    payload,
  });

const MESSAGES = [{ role: "user", content: "how long do refunds take?" }];

test("the playground response and SSE contract is unchanged on the shared service", async () => {
  const { deps, spy } = chatDeps({}, true);
  const app = await buildApp(deps);

  // --- JSON ---
  const res = await chat(app, { messages: MESSAGES });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    content: "Refunds take 5 days.",
    model: "free/groq/llama-3.3-70b",
    usage: { inputTokens: 21, outputTokens: 6 },
    toolCalls: [
      { round: 1, name: "web_search", status: "unavailable", detail: "web search is temporarily unavailable" },
    ],
    billing: { listingTitle: "Support Pro", chargedCents: 5, creatorCents: 4 },
    retrieval: {
      mode: "keyword",
      // The provider's own words never reach the tenant.
      fallbackReason: res.json().retrieval.fallbackReason,
      sources: [{ chunkId: "c1", documentId: "d1", documentTitle: "Refund policy", score: 0.9 }],
    },
  });
  assert.ok(!JSON.stringify(res.json()).includes("acct_77"));
  assert.equal(res.headers["x-ratelimit-remaining-rpm"], "19");
  assert.equal(res.headers["x-ratelimit-remaining-rpd"], "199");
  assert.equal(res.headers["x-ratelimit-reset-rpm"], "1760000060");
  assert.equal(res.headers["x-ratelimit-reset-rpd"], "1760086400");
  assert.deepEqual(spy.money, ["settle"]);
  // Grounding rides ahead of the conversation; the run is a playground run.
  assert.deepEqual(spy.chat[0]!.messages, [{ role: "system", content: "CONTEXT" }, ...MESSAGES]);
  assert.equal(spy.chat[0]!.options.mode, "playground");
  assert.equal(spy.chat[0]!.options.agentId, AGENT_ID);
  assert.ok(spy.chat[0]!.options.signal instanceof AbortSignal);

  // --- The model picker still overrides the agent's model ---
  await chat(app, { messages: MESSAGES, model: "openai/gpt-4" });
  assert.equal(spy.chat[1]!.model, "openai/gpt-4");

  // --- SSE: the runtime's bytes, untouched, with the headers a browser needs ---
  spy.money.length = 0;
  const stream = await chat(app, { messages: MESSAGES, stream: true });
  assert.equal(stream.statusCode, 200);
  assert.match(String(stream.headers["content-type"]), /^text\/event-stream/);
  assert.equal(stream.body, STREAM_FRAMES.join(""), "byte for byte");
  assert.equal(stream.headers["access-control-allow-origin"], ORIGIN, "readable from the dashboard's origin");
  assert.equal(stream.headers["x-ratelimit-remaining-rpm"], "19", "rate-limit headers survive streaming");
  assert.deepEqual(spy.money, ["settle"], "a delivered stream settles, once");
  // What the web client does with it (apps/web/src/lib/api.ts) still works.
  let text = "";
  let toolCalls: unknown = null;
  for (const line of stream.body.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const frame = JSON.parse(line.slice(6));
    if (frame.wheelsai?.toolCalls) toolCalls = frame.wheelsai.toolCalls;
    text += frame.choices?.[0]?.delta?.content ?? "";
  }
  assert.equal(text, "Hello");
  assert.deepEqual(toolCalls, [{ name: "calculator", status: "ok", detail: null }]);
  await app.close();
});

// The model string is the caller's. It goes on to the provider lookup, the
// logs and the latency record, so a control character (a NUL above all, which
// a Postgres text column refuses) is turned away at the door.
test("a model id with a control character, or an absurd length, is refused before any chat runs", async () => {
  const { deps, spy } = chatDeps({}, true);
  const app = await buildApp(deps);
  // index.ts answers a ZodError as 400; this bare app has no such handler,
  // so what is pinned here is that the request is refused and nothing ran.
  for (const model of ["openai/gpt-4\u0000", "openai/\ngpt-4", "\u007f", "", "m".repeat(201)]) {
    const res = await chat(app, { messages: MESSAGES, model });
    assert.ok(res.statusCode >= 400, `${JSON.stringify(model)} -> ${res.statusCode}`);
    assert.match(res.body, /model/);
  }
  assert.equal(spy.chat.length, 0, "no model was called");
  assert.deepEqual(spy.money, []);

  const ok = await chat(app, { messages: MESSAGES, model: "free/groq/llama-3.3-70b" });
  assert.equal(ok.statusCode, 200);
  await app.close();
});

test("a platform-unconfigured model answers 501", async () => {
  // No model on the agent and no free-model key on the platform.
  const none = chatDeps({
    loadAgent: async () => ({ ...AGENT, modelConfig: {} }),
    availableFreeModelIds: () => [],
  });
  let app = await buildApp(none.deps);
  let res = await chat(app, { messages: MESSAGES });
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, "model_provider_not_configured");
  assert.match(res.json().message, /no free models are available/i);
  assert.deepEqual(none.spy.chat, []);
  await app.close();

  // The agent names a free model whose provider key the platform lacks.
  const missingKey = chatDeps({
    resolveModel: (modelId) => {
      throw Object.assign(
        new Error(`Free model "${modelId}" is temporarily unavailable. Choose another model or try again later.`),
        { code: "model_provider_not_configured" },
      );
    },
  });
  app = await buildApp(missingKey.deps);
  res = await chat(app, { messages: MESSAGES, stream: true });
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, "model_provider_not_configured");
  await app.close();

  // The AGENT's own key is missing: still the owner's 400 to fix.
  const agentKey = chatDeps({
    resolveModel: () => {
      throw Object.assign(new Error('Model "openai/gpt-4" requires an API key. Set OPENAI_API_KEY in your agent\'s environment variables.'), {
        code: "agent_model_key_missing",
      });
    },
  });
  app = await buildApp(agentKey.deps);
  res = await chat(app, { messages: MESSAGES });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /Set OPENAI_API_KEY/);
  await app.close();
});

test("refusals keep their status and body: 404, 429, 402, 403", async () => {
  // Another organization's agent does not exist for this caller.
  const scoped = chatDeps({}, true);
  let app = await buildApp(scoped.deps, "99999999-9999-4999-8999-999999999999");
  let res = await chat(app, { messages: MESSAGES });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().message, "Agent not found");
  assert.deepEqual(scoped.spy.money, []);
  assert.deepEqual(scoped.spy.chat, []);
  await app.close();

  const limited = chatDeps({
    checkFreeTierLimit: async () => ({
      allowed: false,
      remaining: { rpm: 0, rpd: 7 },
      resetAt: { rpm: 111, rpd: 222 },
    }),
  });
  app = await buildApp(limited.deps);
  res = await chat(app, { messages: MESSAGES });
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json(), {
    error: "RateLimitExceeded",
    message: "Free tier rate limit exceeded. Try again later or use a paid model.",
    remaining: { rpm: 0, rpd: 7 },
    resetAt: { rpm: 111, rpd: 222 },
  });
  assert.equal(res.headers["x-ratelimit-remaining-rpm"], "0");
  assert.equal(res.headers["x-ratelimit-reset-rpd"], "222");
  await app.close();

  const broke = chatDeps({
    beginMetering: async () => ({
      ok: false as const,
      reason: "insufficient_credits" as const,
      requiredCents: 5n,
      balanceCents: 120n,
      listingTitle: "Support Pro",
    }),
  });
  app = await buildApp(broke.deps);
  res = await chat(app, { messages: MESSAGES, stream: true });
  assert.equal(res.statusCode, 402, "answered before any stream byte");
  assert.deepEqual(res.json(), {
    error: "PaymentRequired",
    message:
      '"Support Pro" is billed per request by its publisher. This request costs 0.0500 USD and your balance is 1.20 USD.',
    requiredCents: 5,
    balanceCents: 120,
  });
  assert.deepEqual(broke.spy.chat, []);
  await app.close();

  const revoked = chatDeps({
    beginMetering: async () => ({
      ok: false as const,
      reason: "licence_revoked" as const,
      listingTitle: "Support Pro",
      revocation: "uninstalled" as never,
    }),
  });
  app = await buildApp(revoked.deps);
  res = await chat(app, { messages: MESSAGES });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "LicenceRevoked");
  assert.equal(res.json().reason, "uninstalled");
  assert.match(res.json().message, /Support Pro/);
  await app.close();
});

test("a model failure is 502 ModelError with the charge refunded, streaming or not", async () => {
  const failing = () =>
    Object.assign(new Error("Model API returned 401 (the model provider rejected the credentials)"), {
      name: "ProviderHttpError",
      status: 401,
    });
  for (const stream of [false, true]) {
    const { deps, spy } = chatDeps(
      {
        runChat: async () => {
          throw failing();
        },
        runChatStream: async () => {
          throw failing();
        },
      },
      true,
    );
    const app = await buildApp(deps);
    const res = await chat(app, { messages: MESSAGES, stream });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), {
      error: "ModelError",
      message: "Model API returned 401 (the model provider rejected the credentials)",
    });
    assert.deepEqual(spy.money, ["refund:Model API returned 401 (the model provider rejected the credentials)"]);
    await app.close();
  }
});

test("a stream that ends without an answer is refunded, not settled", async () => {
  const { deps, spy } = chatDeps(
    {
      runChatStream: async () => ({
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"error":{"message":"the model returned no answer"}}\n\n'));
            controller.close();
          },
        }),
        outcome: Promise.resolve({
          ok: false as const,
          error: "the model returned no answer",
          toolCalls: [],
          code: "empty_answer" as const,
        }),
      }),
    },
    true,
  );
  const app = await buildApp(deps);
  const res = await chat(app, { messages: MESSAGES, stream: true });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /the model returned no answer/);
  assert.deepEqual(spy.money, ["refund:the model returned no answer"]);
  await app.close();
});

test("an agent whose entrypoint is its graph answers the playground through the graph", async () => {
  const { answerToStream } = await import("../services/mastra-runtime.js");
  const run = { executionId: "exec-1", durationMs: 12, steps: [] };
  const inputs: string[] = [];
  const { deps, spy } = chatDeps({
    loadAgent: async (where) =>
      where.orgId === ORG && "id" in where && where.id === AGENT_ID
        ? ({ ...AGENT, entrypoint: "graph" } as never)
        : null,
    runGraph: async ({ input }) => {
      inputs.push(input);
      return { kind: "completed", output: "From the graph.", run };
    },
    answerStream: (result, modelName) => answerToStream(result, modelName, false),
  });
  const app = await buildApp(deps);
  try {
    const res = await chat(app, { messages: MESSAGES });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().content, "From the graph.");
    assert.deepEqual(res.json().graph, run);
    assert.deepEqual(inputs, ["how long do refunds take?"]);
    assert.equal(spy.chat.length, 0, "the chat runtime was not called");

    // The dashboard always streams.
    const streamed = await chat(app, { messages: MESSAGES, stream: true });
    assert.equal(streamed.statusCode, 200);
    assert.match(streamed.body, /From the graph\./);
    assert.match(streamed.body, /data: \[DONE\]/);
  } finally {
    await app.close();
  }

  // A graph that is gone is said by name, not as a model error.
  const missing = chatDeps({
    loadAgent: async () => ({ ...AGENT, entrypoint: "graph" }) as never,
    runGraph: async () => ({ kind: "no_graph" }),
    answerStream: (result, modelName) => answerToStream(result, modelName, false),
  });
  const app2 = await buildApp(missing.deps);
  try {
    const res = await chat(app2, { messages: MESSAGES });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /no saved graph/);
  } finally {
    await app2.close();
  }
});
