/**
 * POST /api/agents/:agentId/run through the real route and the real
 * agent-chat core, with only the effects faked: the order of the checks (a
 * wrong input never reaches the core), who may call it, what each refusal
 * answers, the JSON and the streamed shapes, and the limits a run hands to
 * the core.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from "fastify";

import { globalErrorHandler } from "../lib/errorHandler.js";
import { requireScope } from "../middleware/auth.js";
import { AGENTS_INVOKE_SCOPE } from "../middleware/openaiAuth.js";
import { buildLoadRunAgent } from "../routes/agentRunBindings.js";
import { createAgentRunRoutes, RUN_MESSAGES, type RunAgentRow } from "../routes/agentRun.js";
import type { AgentChatAgent, AgentChatDeps } from "../services/agentChat.js";
import {
  buildTaskBrief,
  TASK_MAX_BODY_BYTES,
  TASK_MAX_INPUT_CHARS,
  TASK_MAX_OUTPUT_TOKENS,
  TASK_MAX_TOOL_ROUNDS,
  TASK_MESSAGES,
  TASK_TIME_LIMIT_MS,
} from "../services/agentTask.js";
import type { AgentPlaygroundConfig, ChatMessage, ChatResult, ChatStream, RunChatOptions } from "../services/mastra-runtime.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const CHAT_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const FORM = {
  task: {
    fields: [
      { key: "topic", label: "Topic", type: "short_text", required: true },
      { key: "tone", label: "Tone", type: "choice", required: false, options: ["Plain", "Formal"] },
    ],
  },
};

const ROWS: Array<RunAgentRow & { orgId: string }> = [
  { id: AGENT_ID, orgId: ORG, name: "Summary Writer", agentKind: "task", kindConfig: FORM },
  { id: CHAT_AGENT_ID, orgId: ORG, name: "Support Bot", agentKind: "conversation", kindConfig: null },
];

const chatAgent = (id: string, over: Partial<AgentChatAgent> = {}): AgentChatAgent => ({
  id,
  orgId: ORG,
  slug: "summary-writer",
  name: "Summary Writer",
  version: "1.0.0",
  systemPrompt: "PRIVATE INSTRUCTIONS",
  tools: [],
  modelConfig: { externalModel: "free/groq/llama-3.3-70b" },
  env: null,
  knowledgeBaseId: null,
  ...over,
});

const RESULT: ChatResult = {
  content: "Here is your summary.",
  usage: { inputTokens: 21, outputTokens: 6 },
  reportedUsage: { inputTokens: 21, outputTokens: 6 },
  finishReason: "stop",
  toolCalls: [{ round: 1, name: "calculator", status: "ok", detail: null }],
  clientToolCalls: [],
  transcript: [],
};

const STREAM_FRAMES = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Here"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":" it is."},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

interface Spy {
  /** Every call into the chat core's effects, in order. */
  core: string[];
  money: string[];
  chat: Array<{
    config: AgentPlaygroundConfig;
    messages: ChatMessage[];
    options: RunChatOptions;
    /** Whether the run's signal had fired when the model was called. */
    stopped: boolean | undefined;
  }>;
  usage: Array<{ source: string; ok: boolean }>;
}

interface CoreOptions {
  over?: Partial<AgentChatDeps>;
  charge?: boolean;
  agent?: Partial<AgentChatAgent>;
}

function chatDeps(options: CoreOptions = {}): { deps: AgentChatDeps; spy: Spy } {
  const spy: Spy = { core: [], money: [], chat: [], usage: [] };
  const handle = {
    charge: { install: { listingTitle: "Summary Pro" }, grossCents: 5n, creatorCents: 4n } as never,
    settle: async () => void spy.money.push("settle"),
    refund: async (reason: string) => void spy.money.push(`refund:${reason}`),
  };
  const deps: AgentChatDeps = {
    loadAgent: async (where) => {
      spy.core.push("loadAgent");
      return where.orgId === ORG && "id" in where ? chatAgent(where.id, options.agent) : null;
    },
    openAgentEnv: () => ({}),
    availableFreeModelIds: () => ["free/groq/llama-3.3-70b"],
    isFreeModel: (id) => id.startsWith("free/"),
    resolveModel: (modelId) => ({ apiKey: "k", baseUrl: "https://provider.example/v1", modelName: modelId }),
    checkFreeTierLimit: async () => {
      spy.core.push("checkFreeTierLimit");
      return {
        allowed: true,
        remaining: { rpm: 19, rpd: 199 },
        resetAt: { rpm: 1_760_000_060, rpd: 1_760_086_400 },
      };
    },
    retrieveContext: async () => null,
    beginMetering: async () => {
      spy.core.push("beginMetering");
      return options.charge ? { ok: true as const, handle } : null;
    },
    resolveToolMode: async ({ base }) => base,
    skillKeys: () => ["calculator"],
    runChat: async (_resolved, config, messages, runOptions) => {
      spy.core.push("runChat");
      spy.chat.push({ config, messages, options: runOptions, stopped: runOptions.signal?.aborted });
      return RESULT;
    },
    runChatStream: async (_resolved, config, messages, runOptions): Promise<ChatStream> => {
      spy.core.push("runChatStream");
      spy.chat.push({ config, messages, options: runOptions, stopped: runOptions.signal?.aborted });
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
    recordUsage: async (record) => void spy.usage.push({ source: record.source, ok: record.ok }),
    deadlineMs: 30_000,
    ...options.over,
  };
  return { deps, spy };
}

async function buildApp(options: CoreOptions & { timeLimitMs?: number } = {}) {
  const { deps, spy } = chatDeps(options);
  let built = 0;
  const loads: Array<{ orgId: string; agentId: string }> = [];
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible);
  app.decorateRequest("auth", null);
  // Stands in for the global auth hook: a test names its caller in headers.
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    if (typeof org !== "string") return;
    const scopes = request.headers["x-test-scopes"];
    (request as { auth: unknown }).auth =
      typeof scopes === "string"
        ? { orgId: org, userId: null, type: "api_key", apiKeyId: "key_1", scopes: scopes ? scopes.split(",") : [] }
        : { orgId: org, userId: "user-1", type: "jwt" };
  });
  const auth: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!request.auth) return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
  };
  await app.register(
    createAgentRunRoutes({
      // The real scope guard.
      guards: { auth, invoke: requireScope(AGENTS_INVOKE_SCOPE) as preHandlerAsyncHookHandler },
      loadAgent: async (where) => {
        loads.push(where);
        return ROWS.find((row) => row.id === where.agentId && row.orgId === where.orgId) ?? null;
      },
      chatDeps: () => {
        built += 1;
        return deps;
      },
      timeLimitMs: options.timeLimitMs,
    }),
    { prefix: "/api" },
  );
  await app.ready();
  return { app, spy, loads, built: () => built };
}

const session = { "x-test-org": ORG };
const run = (
  app: FastifyInstance,
  payload: unknown,
  { headers = session, agentId = AGENT_ID }: { headers?: Record<string, string>; agentId?: string } = {},
) =>
  app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/run`,
    headers: { "content-type": "application/json", ...headers },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const GOOD = { topic: "Quarterly results", tone: "Plain" };

// ============================================
// The answer
// ============================================

test("stream: false answers JSON: the result as text, the tool calls, how long it took and what it cost", async () => {
  const { app, spy } = await buildApp();
  const res = await run(app, { input: GOOD, stream: false });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body), ["output", "toolCalls", "durationMs", "billing"]);
  assert.deepEqual(body.output, { format: "text", text: "Here is your summary." });
  assert.deepEqual(body.toolCalls, [{ round: 1, name: "calculator", status: "ok", detail: null }]);
  assert.equal(typeof body.durationMs, "number");
  assert.ok(body.durationMs >= 0);
  assert.equal(body.billing, null);
  assert.equal(res.headers["x-ratelimit-remaining-rpd"], "199");
  assert.deepEqual(spy.core, ["loadAgent", "checkFreeTierLimit", "beginMetering", "runChat"]);
  await app.close();
});

test("the run is the brief of a job on the chat core, held to a run's limits", async () => {
  const { app, spy } = await buildApp({ agent: { modelConfig: { externalModel: "free/groq/llama-3.3-70b", maxTokens: 8000 } } });
  assert.equal((await run(app, { input: { ...GOOD, tone: "" }, stream: false })).statusCode, 200);

  const [{ config, messages, options, stopped }] = spy.chat as [Spy["chat"][number]];
  // The brief is the user turn; the rules of a job follow the agent's own prompt as a system turn.
  const expected = buildTaskBrief(ROWS[0]!, { topic: "Quarterly results" });
  assert.deepEqual(messages, [
    { role: "system", content: expected.systemAddendum },
    { role: "user", content: expected.brief },
  ]);
  assert.ok(expected.brief.includes("Quarterly results"));
  assert.ok(!JSON.stringify(messages).includes("PRIVATE INSTRUCTIONS"), "the agent's prompt is the runtime's to add");
  assert.equal(config.systemPrompt, "PRIVATE INSTRUCTIONS");

  // Result length, tool rounds, and the time limit as a signal rather than the chat's own deadline.
  assert.equal(config.modelConfig.maxTokens, TASK_MAX_OUTPUT_TOKENS);
  assert.equal(options.maxToolRounds, TASK_MAX_TOOL_ROUNDS);
  assert.equal(options.deadlineMs, undefined);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(stopped, false);
  assert.equal(TASK_TIME_LIMIT_MS, 120_000);

  // A session runs as the playground does; nothing else is asked of the core.
  assert.equal(options.mode, "playground");
  assert.deepEqual(options.clientTools, []);
  assert.equal(options.requestParams, undefined);
  assert.deepEqual(spy.usage, [{ source: "playground", ok: true }]);

  // An agent that asks for less keeps its own number.
  const small = await buildApp({ agent: { modelConfig: { externalModel: "free/groq/llama-3.3-70b", maxTokens: 512 } } });
  await run(small.app, { input: GOOD, stream: false });
  assert.equal(small.spy.chat[0]!.config.modelConfig.maxTokens, 512);
  await small.app.close();
  await app.close();
});

test("it streams by default, as the playground does", async () => {
  const { app, spy } = await buildApp();
  for (const payload of [{ input: GOOD }, { input: GOOD, stream: true }]) {
    const res = await run(app, payload);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.equal(res.headers["x-ratelimit-remaining-rpm"], "19");
    assert.equal(res.body, STREAM_FRAMES.join(""));
  }
  assert.deepEqual(spy.core.filter((call) => call.startsWith("run")), ["runChatStream", "runChatStream"]);
  assert.equal(spy.chat[0]!.options.maxToolRounds, TASK_MAX_TOOL_ROUNDS);
  assert.equal(spy.chat[0]!.config.modelConfig.maxTokens, TASK_MAX_OUTPUT_TOKENS);
  await app.close();
});

test("a buyer's copy on a per-request listing is charged per run through the same core, and told what it cost", async () => {
  const json = await buildApp({ charge: true });
  const res = await run(json.app, { input: GOOD, stream: false });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().billing, { listingTitle: "Summary Pro", chargedCents: 5, creatorCents: 4 });
  assert.deepEqual(json.spy.money, ["settle"]);
  await json.app.close();

  const streamed = await buildApp({ charge: true });
  assert.equal((await run(streamed.app, { input: GOOD })).statusCode, 200);
  assert.deepEqual(streamed.spy.money, ["settle"]);
  await streamed.app.close();
});

// ============================================
// The order of the checks
// ============================================

test("a wrong input, a too-long input and an agent that is not a task agent never reach the chat core", async () => {
  const { app, spy, built, loads } = await buildApp({ charge: true });

  const notTask = await run(app, { input: GOOD, stream: false }, { agentId: CHAT_AGENT_ID });
  assert.equal(notTask.statusCode, 409);
  assert.deepEqual(notTask.json(), { error: "not_a_task_agent", message: TASK_MESSAGES.notATaskAgent });

  const tooLong = await run(app, { input: { topic: "x".repeat(TASK_MAX_INPUT_CHARS + 1) }, stream: false });
  assert.equal(tooLong.statusCode, 413);
  assert.deepEqual(tooLong.json(), { error: "input_too_large", message: TASK_MESSAGES.inputTooLarge });

  const wrong = await run(app, { input: { tone: "Loud", extra: 1 } });
  assert.equal(wrong.statusCode, 422);
  assert.deepEqual(wrong.json(), {
    error: "input_invalid",
    message: TASK_MESSAGES.inputInvalid,
    details: [
      { path: "/topic", field: "topic", label: "Topic", message: TASK_MESSAGES.required },
      { path: "/tone", field: "tone", label: "Tone", message: TASK_MESSAGES.notAChoice },
      { path: "/extra", field: "extra", label: null, message: TASK_MESSAGES.unknownField },
    ],
  });

  for (const payload of [{}, { input: "write something" }, { input: null }, { input: [GOOD] }]) {
    const res = await run(app, payload);
    assert.equal(res.statusCode, 422, JSON.stringify(payload));
    assert.equal(res.json().error, "input_invalid");
    assert.deepEqual(res.json().details, [{ path: "", field: null, label: null, message: TASK_MESSAGES.notAnObject }]);
  }

  assert.equal(loads.length, 7, "each was answered after the agent was found");
  assert.equal(built(), 0, "the chat core was never even built");
  assert.deepEqual(spy.core, []);
  assert.deepEqual(spy.money, []);
  assert.deepEqual(spy.usage, []);
  await app.close();
});

test("another organization's agent is 404, never 403, before its kind or the input is looked at", async () => {
  const { app, spy, built } = await buildApp();
  const theirs = { "x-test-org": OTHER_ORG };
  for (const [agentId, input] of [
    [AGENT_ID, GOOD],
    [AGENT_ID, { nonsense: true }],
    [CHAT_AGENT_ID, GOOD],
  ] as const) {
    const res = await run(app, { input, stream: false }, { headers: theirs, agentId });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().message, "Agent not found");
  }
  const unknown = await run(app, { input: GOOD }, { agentId: "44444444-4444-4444-8444-444444444444" });
  assert.equal(unknown.statusCode, 404);
  assert.equal(built(), 0);
  assert.deepEqual(spy.core, []);
  await app.close();
});

test("a body that is not a run is a 400 by field, and one over the limit is 413 input_too_large", async () => {
  const { app, spy, loads } = await buildApp();
  for (const payload of [{ input: GOOD, stream: "yes" }, { input: GOOD, model: "x" }]) {
    const res = await run(app, payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, "validation_failed");
    assert.equal(typeof res.json().message, "string");
  }
  const badId = await run(app, { input: GOOD }, { agentId: "not-an-id" });
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.json().error, "validation_failed");

  const huge = await run(app, { input: { topic: "x".repeat(TASK_MAX_BODY_BYTES) }, stream: false });
  assert.equal(huge.statusCode, 413);
  assert.deepEqual(huge.json(), { error: "input_too_large", message: TASK_MESSAGES.inputTooLarge });

  // Anything else the parser refuses still goes to the handler the app has.
  const broken = await run(app, "{not json");
  assert.equal(broken.statusCode, 400);
  assert.notEqual(broken.json().error, "input_too_large");

  assert.deepEqual(loads, []);
  assert.deepEqual(spy.core, []);
  await app.close();
});

// ============================================
// Who
// ============================================

test("a session, or an API key granted agents:invoke; a key runs as the API does", async () => {
  const { app, spy } = await buildApp();

  const nobody = await run(app, { input: GOOD, stream: false }, { headers: {} });
  assert.equal(nobody.statusCode, 401);

  const denied = await run(app, { input: GOOD, stream: false }, { headers: { ...session, "x-test-scopes": "jobs:read" } });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.json(), {
    error: "missing_scope",
    message: 'This API key does not have the "agents:invoke" scope.',
    scope: "agents:invoke",
  });
  assert.deepEqual(spy.core, [], "refused before anything ran");

  for (const scopes of ["agents:invoke", "jobs:read,agents:invoke", "*", ""]) {
    const res = await run(app, { input: GOOD, stream: false }, { headers: { ...session, "x-test-scopes": scopes } });
    assert.equal(res.statusCode, 200, `scopes "${scopes}"`);
  }
  assert.equal(spy.chat.length, 4);
  assert.ok(spy.chat.every((call) => call.options.mode === "api"));
  assert.ok(spy.usage.every((record) => record.source === "api"));

  assert.equal((await run(app, { input: GOOD, stream: false })).statusCode, 200);
  assert.equal(spy.chat[4]!.options.mode, "playground");
  await app.close();
});

// ============================================
// Refusals from the core
// ============================================

const LIMIT = { allowed: false, remaining: { rpm: 0, rpd: 12 }, resetAt: { rpm: 1_760_000_060, rpd: 1_760_086_400 } };

test("the core's refusals keep the status and wording a chat gets", async () => {
  const limited = await buildApp({ over: { checkFreeTierLimit: async () => LIMIT } });
  for (const stream of [true, false]) {
    const res = await run(limited.app, { input: GOOD, stream });
    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.json(), {
      error: "RateLimitExceeded",
      message: "Free tier rate limit exceeded. Try again later or use a paid model.",
      remaining: LIMIT.remaining,
      resetAt: LIMIT.resetAt,
    });
    assert.equal(res.headers["x-ratelimit-remaining-rpd"], "12");
  }
  assert.ok(!limited.spy.core.includes("beginMetering"), "refused before anything is charged");
  await limited.app.close();

  const broke = await buildApp({
    over: {
      beginMetering: async () => ({
        ok: false as const,
        reason: "insufficient_credits" as const,
        requiredCents: 5n,
        balanceCents: 2n,
        listingTitle: "Summary Pro",
      }),
    },
  });
  const unpaid = await run(broke.app, { input: GOOD, stream: false });
  assert.equal(unpaid.statusCode, 402);
  assert.deepEqual(unpaid.json(), {
    error: "PaymentRequired",
    message: '"Summary Pro" is billed per request by its publisher. This request costs 0.0500 USD and your balance is 0.02 USD.',
    requiredCents: 5,
    balanceCents: 2,
  });
  assert.ok(!broke.spy.core.includes("runChat"));
  await broke.app.close();

  const revoked = await buildApp({
    over: {
      beginMetering: async () => ({
        ok: false as const,
        reason: "licence_revoked" as const,
        listingTitle: "Summary Pro",
        revocation: "subscription_lapsed" as const,
      }),
    },
  });
  const lapsed = await run(revoked.app, { input: GOOD });
  assert.equal(lapsed.statusCode, 403);
  assert.equal(lapsed.json().error, "LicenceRevoked");
  assert.equal(lapsed.json().reason, "subscription_lapsed");
  assert.match(lapsed.json().message, /"Summary Pro" is a monthly subscription that is not paid up/);
  await revoked.app.close();

  const restarting = await buildApp({ over: { beginRun: () => null } });
  const busy = await run(restarting.app, { input: GOOD, stream: false });
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.json().error, "ServiceUnavailable");
  assert.equal(busy.headers["retry-after"], "5");
  await restarting.app.close();

  const hosted = await buildApp({
    agent: { modelConfig: { externalModel: "wheelsai/llama-3" } },
    over: { isFreeModel: () => false, resolveHostedModel: async () => ({ ok: false as const, message: "This model is not running right now." }) },
  });
  const down = await run(hosted.app, { input: GOOD, stream: false });
  assert.equal(down.statusCode, 503);
  assert.deepEqual(down.json(), { error: "hosted_model_not_running", message: "This model is not running right now." });
  await hosted.app.close();

  const noModel = await buildApp({ agent: { modelConfig: {} }, over: { availableFreeModelIds: () => [] } });
  const none = await run(noModel.app, { input: GOOD, stream: false });
  assert.equal(none.statusCode, 501);
  assert.deepEqual(none.json(), {
    error: "model_provider_not_configured",
    message: "No model is available for this agent right now. Nothing was charged. Try again later.",
  });
  await noModel.app.close();
});

test("a run that fails in the model is 502 run_failed in plain words, and a charge goes back", async () => {
  const providerError = Object.assign(new Error("Model API returned 500 (acct_77 upstream exploded)"), {
    name: "ProviderHttpError",
    status: 500,
  });
  for (const stream of [false, true]) {
    const { app, spy } = await buildApp({
      charge: true,
      over: {
        runChat: async () => Promise.reject(providerError),
        runChatStream: async () => Promise.reject(providerError),
      },
    });
    const res = await run(app, { input: GOOD, stream });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: "run_failed", message: RUN_MESSAGES.failed });
    assert.ok(!res.body.includes("acct_77"));
    assert.equal(spy.money.length, 1);
    assert.match(spy.money[0]!, /^refund:/);
    await app.close();
  }

  // The model's own deadline, were one to fire, reads as the time limit too.
  const slow = await buildApp({
    over: { runChat: async () => Promise.reject(Object.assign(new Error("the model did not answer within 120s"), { name: "ChatDeadlineError" })) },
  });
  const late = await run(slow.app, { input: GOOD, stream: false });
  assert.equal(late.statusCode, 502);
  assert.deepEqual(late.json(), { error: "run_failed", message: RUN_MESSAGES.timedOut });
  await slow.app.close();
});

test("a run past its time limit is stopped through the signal, refunded, and told so", async () => {
  /** A model call that only ends when the run's signal fires. */
  const hang = (signal: AbortSignal | undefined) =>
    new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
    });
  for (const stream of [false, true]) {
    const { app, spy } = await buildApp({
      charge: true,
      timeLimitMs: 25,
      over: {
        runChat: async (_r, _c, _m, options) => hang(options.signal),
        runChatStream: async (_r, _c, _m, options) => hang(options.signal),
      },
    });
    const res = await run(app, { input: GOOD, stream });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json(), { error: "run_failed", message: RUN_MESSAGES.timedOut });
    assert.equal(spy.money.length, 1);
    assert.match(spy.money[0]!, /^refund:/);
    await app.close();
  }
  assert.equal(RUN_MESSAGES.timedOut, "This run took longer than its time limit and was stopped.");
  assert.equal(RUN_MESSAGES.failed, "This run could not be completed.");
});

// ============================================
// The production read
// ============================================

test("buildLoadRunAgent reads the agent in the caller's organization, and only what a run needs", async () => {
  const seen: unknown[] = [];
  const load = buildLoadRunAgent({
    agent: {
      findFirst: (async (args: unknown) => {
        seen.push(args);
        return ROWS[0];
      }) as never,
    },
  });
  assert.equal((await load({ orgId: ORG, agentId: AGENT_ID }))?.id, AGENT_ID);
  assert.deepEqual(seen, [
    { where: { id: AGENT_ID, orgId: ORG }, select: { id: true, name: true, agentKind: true, kindConfig: true } },
  ]);
});
