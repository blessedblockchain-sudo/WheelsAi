import assert from "node:assert/strict";
import test from "node:test";

import { PUBLIC_MODEL_ERROR, publicToolCalls, toPublicStream } from "../lib/publicSse.js";
import type { ChatStream, StreamOutcome } from "../services/mastra-runtime.js";

// Drives lib/publicSse.ts: what a streamed answer looks like to an anonymous
// visitor. It is an allowlist - content, tool names, the finish reason, a
// generic error and [DONE] - and the provider's own words never pass.

const enc = new TextEncoder();
const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const META = { id: "chatcmpl-secret-id", object: "chat.completion.chunk", created: 1, model: "llama-3.3-70b-versatile" };
const delta = (content: string) =>
  event({ ...META, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });

const OUTCOME: StreamOutcome = { ok: true, usage: null, toolCalls: [] };

function chatOf(chunks: Array<string | Uint8Array>): ChatStream {
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
        controller.close();
      },
    }),
    outcome: Promise.resolve(OUTCOME),
  };
}

async function read(chat: ChatStream): Promise<{ raw: string; events: unknown[] }> {
  const reader = chat.stream.getReader();
  const dec = new TextDecoder();
  let raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
  }
  const events = raw
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      assert.ok(block.startsWith("data: "), block);
      const data = block.slice(6);
      return data === "[DONE]" ? "[DONE]" : JSON.parse(data);
    });
  return { raw, events };
}

test("content deltas pass through, stripped to the content", async () => {
  const { raw, events } = await read(
    toPublicStream(
      chatOf([
        delta("Hel"),
        delta("lo"),
        event({ ...META, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]),
    ),
  );
  assert.deepEqual(events, [
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);
  // Neither the completion id nor the provider's model name crosses.
  assert.ok(!raw.includes("chatcmpl-secret-id"));
  assert.ok(!raw.includes("llama"));
});

test("a provider error event becomes one generic model_error, with none of the provider's text", async () => {
  const providerError = event({
    error: {
      message: "Rate limit reached for model `llama-3.3-70b` in organization `org_01ABC` on tokens per day",
      type: "tokens",
      code: "rate_limit_exceeded",
    },
  });
  const { raw, events } = await read(
    toPublicStream(chatOf([delta("partial"), providerError, event({ error: "again" }), delta("after"), "data: [DONE]\n\n"])),
  );
  assert.deepEqual(events, [
    { choices: [{ delta: { content: "partial" } }] },
    { error: { code: "model_error", message: PUBLIC_MODEL_ERROR.message } },
    "[DONE]",
  ]);
  for (const leak of ["org_01ABC", "llama", "Rate limit", "tokens per day", "rate_limit_exceeded"]) {
    assert.ok(!raw.includes(leak), leak);
  }
});

test("the runtime's own error events (a string message) are replaced too", async () => {
  const { events } = await read(
    toPublicStream(chatOf([event({ error: { message: "model stream failed: connect ECONNREFUSED 10.0.0.5:443" } })])),
  );
  assert.deepEqual(events, [{ error: { code: "model_error", message: PUBLIC_MODEL_ERROR.message } }]);
});

test("tool calls are reduced to a name and whether it worked", async () => {
  const extension = event({
    ...META,
    choices: [],
    wheelsai: {
      toolCalls: [
        { name: "web_search", status: "ok", detail: null },
        { name: "knowledge_search", status: "unavailable", detail: "TAVILY_API_KEY is not configured" },
        { name: "file_read", status: "error", detail: "S3 bucket wheels-prod-files: AccessDenied" },
        { name: "odd", status: "unknown", detail: null },
      ],
    },
  });
  const { raw, events } = await read(toPublicStream(chatOf([extension, delta("done"), "data: [DONE]\n\n"])));
  assert.deepEqual(events[0], {
    wheelsai: {
      toolCalls: [
        { name: "web_search", status: "ok" },
        { name: "knowledge_search", status: "unavailable" },
        { name: "file_read", status: "error" },
        { name: "odd", status: "error" },
      ],
    },
  });
  assert.ok(!raw.includes("TAVILY_API_KEY"));
  assert.ok(!raw.includes("AccessDenied"));

  assert.deepEqual(publicToolCalls(undefined), []);
  assert.deepEqual(publicToolCalls([null, {}, { name: 7 }, { name: "calculator", status: "ok", detail: "x" }]), [
    { name: "calculator", status: "ok" },
  ]);
});

test("usage, function-call deltas, comments and anything unrecognised are dropped", async () => {
  const { events } = await read(
    toPublicStream(
      chatOf([
        ": keep-alive\n\n",
        "event: ping\n\n",
        event({ ...META, choices: [], usage: { prompt_tokens: 812, completion_tokens: 40 } }),
        event({ ...META, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "x" } }] } }] }),
        event({ ...META, choices: [{ index: 0, delta: { content: "" }, finish_reason: null }] }),
        "data: {not json}\n\n",
        'data: "a string"\n\n',
        event({ system_fingerprint: "fp_abc", x_groq: { id: "req_123" } }),
        delta("hi"),
        "data: [DONE]\n\n",
      ]),
    ),
  );
  assert.deepEqual(events, [{ choices: [{ delta: { content: "hi" } }] }, "[DONE]"]);
});

test("events split across chunks, CRLF line ends and a missing final newline are all read", async () => {
  const whole = delta("héllo 🚀").replace(/\n\n$/, "\r\n\r\n");
  const bytes = enc.encode(whole);
  // Cut inside the multi-byte emoji.
  const cut = bytes.length - 12;
  const { events } = await read(toPublicStream(chatOf([bytes.slice(0, cut), bytes.slice(cut), "data: [DONE]"])));
  assert.deepEqual(events, [{ choices: [{ delta: { content: "héllo 🚀" } }] }, "[DONE]"]);
});

test("the outcome is the runtime's own, and cancelling reaches the source", async () => {
  let cancelled = false;
  const source: ChatStream = {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode(delta("x")));
      },
      cancel() {
        cancelled = true;
      },
    }),
    outcome: Promise.resolve(OUTCOME),
  };
  const out = toPublicStream(source);
  assert.equal(out.outcome, source.outcome);
  const reader = out.stream.getReader();
  await reader.read();
  await reader.cancel();
  // The cancel travels back through the pipe; forwardAndSettle waits on the
  // outcome, which the source resolves when it arrives.
  for (let i = 0; i < 20 && !cancelled; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
