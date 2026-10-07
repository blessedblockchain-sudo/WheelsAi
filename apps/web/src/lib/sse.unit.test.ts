/**
 * The shared chat-stream parser. Run with:
 *   cd apps/web && npx tsx --test src/lib/sse.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSseLine, readSseChat, type SseChatEvent } from "./sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseChatEvent[]> {
  const events: SseChatEvent[] = [];
  for await (const event of readSseChat(streamOf(chunks))) events.push(event);
  return events;
}

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

test("content deltas come out in order and the stream ends at [DONE]", async () => {
  const events = await collect([delta("Hel"), delta("lo"), "data: [DONE]\n\n", delta("never read")]);
  assert.deepEqual(events, [
    { type: "delta", content: "Hel" },
    { type: "delta", content: "lo" },
    { type: "done" },
  ]);
});

test("an event split across network chunks is read once it is whole", async () => {
  const whole = delta("split me");
  const events = await collect([whole.slice(0, 11), whole.slice(11, 30), whole.slice(30), "data: [DONE]\n\n"]);
  assert.deepEqual(events[0], { type: "delta", content: "split me" });
  assert.equal(events.length, 2);
});

test("a multi-byte character split across chunks is not corrupted", async () => {
  const bytes = new TextEncoder().encode(delta("café \u{1F600}"));
  const cut = bytes.length - 12;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
  const events: SseChatEvent[] = [];
  for await (const event of readSseChat(stream)) events.push(event);
  assert.deepEqual(events, [{ type: "delta", content: "café \u{1F600}" }]);
});

test("a failure inside a 200 stream is an event with its message and code", () => {
  assert.deepEqual(parseSseLine('data: {"error":{"code":"model_error","message":"The agent could not answer."}}'), [
    { type: "error", message: "The agent could not answer.", code: "model_error" },
  ]);
  assert.deepEqual(parseSseLine('data: {"error":"boom"}'), [{ type: "error", message: "boom", code: null }]);
  assert.deepEqual(parseSseLine('data: {"error":{}}'), [
    { type: "error", message: "The model stream failed", code: null },
  ]);
});

test("tool calls are passed on, and can share a line with content", () => {
  const line = `data: ${JSON.stringify({
    wheelsai: { toolCalls: [{ name: "calculator", status: "ok" }] },
    choices: [{ delta: { content: "42" } }],
  })}`;
  assert.deepEqual(parseSseLine(line), [
    { type: "toolCalls", toolCalls: [{ name: "calculator", status: "ok" }] },
    { type: "delta", content: "42" },
  ]);
});

test("lines that are not events are ignored", () => {
  assert.deepEqual(parseSseLine(": heartbeat"), []);
  assert.deepEqual(parseSseLine("event: ping"), []);
  assert.deepEqual(parseSseLine("data: not json"), []);
  assert.deepEqual(parseSseLine("data: 42"), []);
  assert.deepEqual(parseSseLine('data: {"choices":[{"delta":{}, "finish_reason":"stop"}]}'), []);
  assert.deepEqual(parseSseLine("data:"), []);
});

test("CRLF line endings and a last line without a newline are both read", async () => {
  const body = delta("a").replace(/\n/g, "\r\n") + `data: ${JSON.stringify({ choices: [{ delta: { content: "b" } }] })}`;
  assert.deepEqual(await collect([body]), [
    { type: "delta", content: "a" },
    { type: "delta", content: "b" },
  ]);
});

test("a stream that ends without [DONE] yields no done event", async () => {
  const events = await collect([delta("half")]);
  assert.equal(events.some((event) => event.type === "done"), false);
});
