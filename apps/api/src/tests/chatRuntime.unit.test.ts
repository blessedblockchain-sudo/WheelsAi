import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

// Drives apps/api/src/services/mastra-runtime.ts - the one chat path every
// caller uses. The provider is a scripted fetch; nothing touches a network.
//
// The regression that started this: with stream:true the raw provider body
// was forwarded, so when the model called a tool the streamed reply was
// EMPTY (the playground always streams for free models). The first test is
// that exact scenario.

const RESOLVED = {
  apiKey: "test-key",
  baseUrl: "https://provider.example/v1",
  modelName: "test-model",
};

const CONFIG = (tools: Array<{ name: string; description: string }>) => ({
  name: "agent",
  tools,
  modelConfig: { externalModel: "free/test", temperature: 0.2, maxTokens: 256 },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toolCallMessage(name: string, args: unknown) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  };
}

function contentMessage(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 6 },
  };
}

interface Scripted {
  fetchImpl: typeof fetch;
  bodies: Array<Record<string, any>>;
}

function scriptedProvider(responders: Array<(body: Record<string, any>) => Response>): Scripted {
  const bodies: Array<Record<string, any>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const responder = responders[bodies.length - 1];
    if (!responder) throw new Error("provider called more often than scripted");
    return responder(body);
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

function sseBody(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
}

function sseResponse(events: string[]): Response {
  return new Response(sseBody(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const finish = (reason = "stop") =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

/** What the web client does with the stream: concatenate delta.content. */
function contentOf(sse: string): string {
  let text = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const parsed = JSON.parse(line.slice(6));
    const c = parsed.choices?.[0]?.delta?.content;
    if (c) text += c;
  }
  return text;
}

async function makeRegistry(overrides: { tavilyApiKey?: string } = {}) {
  const { createSkillRegistry } = await import("../services/skills/registry.js");
  const { loadSkillsConfig } = await import("../config/skills.js");
  const config = loadSkillsConfig({ TAVILY_API_KEY: overrides.tavilyApiKey });
  return createSkillRegistry({
    getConfig: () => ({ config, error: null }),
    getFileStore: () => null,
    getSandbox: () => null,
    knowledge: {
      loadKnowledgeBaseId: async () => null,
      search: async () => ({ results: [], mode: "keyword", fallbackReason: null }),
    },
  });
}

// ============================================
// The regression: streaming + tool call
// ============================================

test("REGRESSION: a STREAMING request whose model calls a tool still yields the answer", async () => {
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const provider = scriptedProvider([
    () => json(toolCallMessage("calculator", { expression: "17*23" })),
    () => json(contentMessage("17 times 23 is 391.")),
  ]);

  const chat = await runChatStream(
    RESOLVED,
    CONFIG([{ name: "calculator", description: "calc" }]),
    [{ role: "user", content: "what is 17*23?" }],
    { registry: await makeRegistry(), fetchImpl: provider.fetchImpl, agentId: "a1", orgId: "o1" },
  );

  const sse = await drain(chat.stream);
  assert.equal(contentOf(sse), "17 times 23 is 391.", "the streamed reply is not empty");
  assert.match(sse, /data: \[DONE\]\s*$/);

  const outcome = await chat.outcome;
  assert.equal(outcome.ok, true);
  assert.deepEqual(
    outcome.toolCalls.map((c) => [c.name, c.status]),
    [["calculator", "ok"]],
  );

  // The tool round really ran: round 2 saw the tool result 391, and both
  // provider calls were non-streaming.
  assert.equal(provider.bodies.length, 2);
  assert.equal(provider.bodies[0]!.stream, false);
  const toolMessage = provider.bodies[1]!.messages.at(-1);
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.content, "391");
});

test("runChat(stream: true) keeps its ReadableStream signature and is non-empty with tools", async () => {
  const { runChat } = await import("../services/mastra-runtime.js");
  const provider = scriptedProvider([
    () => json(toolCallMessage("calculator", { expression: "2+2" })),
    () => json(contentMessage("four")),
  ]);
  const stream = await runChat(
    RESOLVED,
    CONFIG([{ name: "calculator", description: "calc" }]),
    [{ role: "user", content: "2+2?" }],
    true,
    { registry: await makeRegistry(), fetchImpl: provider.fetchImpl },
  );
  assert.equal(contentOf(await drain(stream)), "four");
});

test("a long streamed answer is chunked and reassembles exactly (including emoji)", async () => {
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const answer = "x".repeat(158) + "🚀🚀🚀" + "y".repeat(300);
  const provider = scriptedProvider([
    () => json(toolCallMessage("calculator", { expression: "1" })),
    () => json(contentMessage(answer)),
  ]);
  const chat = await runChatStream(
    RESOLVED,
    CONFIG([{ name: "calculator", description: "" }]),
    [{ role: "user", content: "go" }],
    { registry: await makeRegistry(), fetchImpl: provider.fetchImpl },
  );
  assert.equal(contentOf(await drain(chat.stream)), answer);
});

// ============================================
// Non-streaming
// ============================================

test("non-streaming runChat runs tool rounds and reports the calls", async () => {
  const { runChat } = await import("../services/mastra-runtime.js");
  const provider = scriptedProvider([
    () => json(toolCallMessage("calculator", { expression: "6*7" })),
    () => json(contentMessage("42")),
  ]);
  const result = await runChat(
    RESOLVED,
    CONFIG([{ name: "calculator", description: "" }]),
    [{ role: "user", content: "6*7?" }],
    false,
    { registry: await makeRegistry(), fetchImpl: provider.fetchImpl },
  );
  assert.equal(result.content, "42");
  assert.deepEqual(result.usage, { inputTokens: 31, outputTokens: 9 });
  assert.equal(result.toolCalls![0]!.name, "calculator");
});

test("an enabled tool that is not configured tells the model 'unavailable', never fakes output", async () => {
  const { runChat } = await import("../services/mastra-runtime.js");
  const provider = scriptedProvider([
    () => json(toolCallMessage("web_search", { query: "solana news" })),
    () => json(contentMessage("I cannot search the web right now.")),
  ]);
  const result = await runChat(
    RESOLVED,
    CONFIG([{ name: "web_search", description: "" }]),
    [{ role: "user", content: "news?" }],
    false,
    { registry: await makeRegistry(), fetchImpl: provider.fetchImpl },
  );
  const toolMessage = provider.bodies[1]!.messages.at(-1);
  assert.equal(toolMessage.content, "unavailable: web search is not configured on this server");
  assert.equal(result.toolCalls![0]!.status, "unavailable");
});

test("tools the registry does not know (legacy names) are not offered to the model", async () => {
  const { runChat } = await import("../services/mastra-runtime.js");
  const provider = scriptedProvider([() => json(contentMessage("hi"))]);
  await runChat(
    RESOLVED,
    CONFIG([{ name: "file_browser", description: "legacy" }]),
    [{ role: "user", content: "hi" }],
    false,
    { registry: await makeRegistry(), fetchImpl: provider.fetchImpl },
  );
  assert.equal(provider.bodies[0]!.tools, undefined);
});

test("an agent with no tools sends no tools and is one provider call", async () => {
  const { runChat } = await import("../services/mastra-runtime.js");
  const provider = scriptedProvider([() => json(contentMessage("plain"))]);
  const result = await runChat(
    RESOLVED,
    { ...CONFIG([]), systemPrompt: "Be brief." },
    [{ role: "user", content: "hello" }],
    false,
    { fetchImpl: provider.fetchImpl },
  );
  assert.equal(result.content, "plain");
  assert.equal(provider.bodies.length, 1);
  assert.equal(provider.bodies[0]!.tools, undefined);
  assert.deepEqual(provider.bodies[0]!.messages[0], { role: "system", content: "Be brief." });
});

test("an empty model answer is an error, not a silent empty success", async () => {
  const { runChat } = await import("../services/mastra-runtime.js");
  const provider = scriptedProvider([
    () => json({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
  ]);
  await assert.rejects(
    runChat(RESOLVED, CONFIG([]), [{ role: "user", content: "x" }], false, {
      fetchImpl: provider.fetchImpl,
    }),
    /no answer.*finish_reason: length/,
  );
});

test("a provider HTTP error rejects before any stream exists", async () => {
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const provider = scriptedProvider([() => new Response("bad key", { status: 401 })]);
  await assert.rejects(
    runChatStream(RESOLVED, CONFIG([]), [{ role: "user", content: "x" }], {
      fetchImpl: provider.fetchImpl,
    }),
    /Model API returned 401/,
  );
});

test("a provider error body is logged, never returned to the caller", async () => {
  const { runChat, runChatStream } = await import("../services/mastra-runtime.js");
  const SECRET = "Incorrect API key provided: gsk_live_ABCD1234. Org org-internal-9 billing account acct_77";
  const provider = () => scriptedProvider([() => new Response(SECRET, { status: 401 })]);

  for (const run of [
    () =>
      runChat(RESOLVED, CONFIG([]), [{ role: "user", content: "x" }], false, {
        fetchImpl: provider().fetchImpl,
      }),
    () =>
      runChatStream(RESOLVED, CONFIG([]), [{ role: "user", content: "x" }], {
        fetchImpl: provider().fetchImpl,
      }),
  ]) {
    await assert.rejects(run(), (err: unknown) => {
      const message = (err as Error).message;
      assert.equal(message, "Model API returned 401 (the model provider rejected the credentials)");
      assert.ok(!message.includes("gsk_live") && !message.includes("acct_77"));
      return true;
    });
  }

  const hint = async (status: number) => {
    const p = scriptedProvider([() => new Response("internal detail", { status })]);
    try {
      await runChat(RESOLVED, CONFIG([]), [{ role: "user", content: "x" }], false, { fetchImpl: p.fetchImpl });
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  };
  assert.match(await hint(429), /rate limit was reached/);
  assert.match(await hint(503), /provider had an error/);
  assert.match(await hint(400), /rejected the request/);
  assert.ok(!(await hint(500)).includes("internal detail"));
});

test("an aborted signal rejects the run", async () => {
  const { runChat } = await import("../services/mastra-runtime.js");
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return json(contentMessage("never"));
  }) as unknown as typeof fetch;
  await assert.rejects(
    runChat(RESOLVED, CONFIG([]), [{ role: "user", content: "x" }], false, {
      fetchImpl,
      signal: controller.signal,
    }),
    (err: unknown) => (err as Error).name === "AbortError",
  );
});

// ============================================
// Pass-through streaming (no tools) and its outcome
// ============================================

test("with no tools the provider stream is forwarded byte for byte", async () => {
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const events = [delta("Hel"), delta("lo"), finish(), DONE];
  const provider = scriptedProvider([() => sseResponse(events)]);
  const chat = await runChatStream(RESOLVED, CONFIG([]), [{ role: "user", content: "hi" }], {
    fetchImpl: provider.fetchImpl,
  });
  const out = await drain(chat.stream);
  assert.equal(out, events.join(""));
  assert.equal(provider.bodies[0]!.stream, true);
  const outcome = await chat.outcome;
  assert.equal(outcome.ok, true);
});

test("a provider error event mid-stream is a failed outcome (the buyer is refunded)", async () => {
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const events = [
    delta("Partial"),
    `data: ${JSON.stringify({ error: { message: "upstream overloaded" } })}\n\n`,
  ];
  const provider = scriptedProvider([() => sseResponse(events)]);
  const chat = await runChatStream(RESOLVED, CONFIG([]), [{ role: "user", content: "hi" }], {
    fetchImpl: provider.fetchImpl,
  });
  const out = await drain(chat.stream);
  assert.match(out, /upstream overloaded/, "the error reaches the client");
  const outcome = await chat.outcome;
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && /upstream overloaded/.test(outcome.error));
});

test("a stream with no answer text (reasoning ate the budget) fails and tells the client", async () => {
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const reasoningOnly = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { reasoning: "thinking..." }, finish_reason: null }],
  })}\n\n`;
  const provider = scriptedProvider([() => sseResponse([reasoningOnly, finish("length"), DONE])]);
  const chat = await runChatStream(RESOLVED, CONFIG([]), [{ role: "user", content: "hi" }], {
    fetchImpl: provider.fetchImpl,
  });
  const out = await drain(chat.stream);
  assert.match(out, /"error"/);
  assert.match(out, /finish_reason: length/);
  const outcome = await chat.outcome;
  assert.equal(outcome.ok, false);
});

test("a stream cut off before it finished is not a delivered answer", async () => {
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const provider = scriptedProvider([() => sseResponse([delta("half an ans")])]);
  const chat = await runChatStream(RESOLVED, CONFIG([]), [{ role: "user", content: "hi" }], {
    fetchImpl: provider.fetchImpl,
  });
  const out = await drain(chat.stream);
  assert.match(out, /ended before the answer finished/);
  assert.equal((await chat.outcome).ok, false);
});

test("a transport failure mid-stream ends the stream with an error event, never a throw", async () => {
  const { runChatStream } = await import("../services/mastra-runtime.js");
  const enc = new TextEncoder();
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(delta("par")));
    },
    pull(controller) {
      controller.error(new Error("socket hang up"));
    },
  });
  const provider = scriptedProvider([() => new Response(broken, { status: 200 })]);
  const chat = await runChatStream(RESOLVED, CONFIG([]), [{ role: "user", content: "hi" }], {
    fetchImpl: provider.fetchImpl,
  });
  const out = await drain(chat.stream);
  assert.match(out, /socket hang up/);
  const outcome = await chat.outcome;
  assert.equal(outcome.ok, false);
});

test("a client that goes away mid-stream makes the outcome a failure", async () => {
  const { runChatStream } = await import("../services/mastra-runtime.js");
  // A stream that never ends on its own.
  const enc = new TextEncoder();
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(enc.encode(delta("tick")));
      return new Promise((r) => setTimeout(r, 5));
    },
  });
  const provider = scriptedProvider([() => new Response(endless, { status: 200 })]);
  const chat = await runChatStream(RESOLVED, CONFIG([]), [{ role: "user", content: "hi" }], {
    fetchImpl: provider.fetchImpl,
  });
  const reader = chat.stream.getReader();
  await reader.read();
  await reader.cancel();
  const outcome = await chat.outcome;
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && /client disconnected/.test(outcome.error));
});
