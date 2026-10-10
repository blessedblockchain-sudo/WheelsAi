import assert from "node:assert/strict";
import test from "node:test";

import { ANSWER_WITHHELD, answerTextOf, holdUntilChecked } from "../lib/heldAnswer.js";
import { detectInstructionLeak } from "../services/assertions.js";
import type { ChatStream, StreamOutcome } from "../services/mastra-runtime.js";

// What these pin: nothing of an answer leaves before it has been checked; a
// refused answer releases nothing at all; the text that is checked is the
// stream's own, not the outcome's cut copy; and a failure or an abort of the
// runtime passes through as it is.

const enc = new TextEncoder();
const dec = new TextDecoder();
const delta = (content: string) =>
  `data: ${JSON.stringify({ id: "chatcmpl-1", model: "secret/model-id", choices: [{ delta: { content } }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

const INSTRUCTIONS =
  "You are Support Bot. Always greet the customer by name and never mention the internal escalation code seven four two.";
const accept = (text: string) => !detectInstructionLeak(text, [INSTRUCTIONS]).leaked;

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

/** A stream the test feeds by hand, with an outcome it resolves by hand. */
function manual() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let resolve!: (outcome: StreamOutcome) => void;
  const chat: ChatStream = {
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    }),
    outcome: new Promise<StreamOutcome>((r) => {
      resolve = r;
    }),
  };
  return {
    chat,
    push: (text: string) => controller.enqueue(enc.encode(text)),
    close: () => controller.close(),
    error: (err: Error) => controller.error(err),
    resolve,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("not one byte leaves before the check, and the check waits for the stream to end", async () => {
  const m = manual();
  const checked: string[] = [];
  let settled = false;
  const held = holdUntilChecked(m.chat, (text) => {
    checked.push(text);
    return true;
  }).then((result) => {
    settled = true;
    return result;
  });

  m.push(delta("Hello "));
  m.push(delta("there."));
  await tick();
  assert.deepEqual(checked, [], "nothing is checked while the stream is open");
  assert.equal(settled, false, "nothing is released while the stream is open");

  m.push(DONE);
  m.close();
  await tick();
  // The stream ended, but the runtime has not said how: still held.
  assert.deepEqual(checked, []);
  assert.equal(settled, false);

  m.resolve({ ok: true, usage: { inputTokens: 3, outputTokens: 2 }, toolCalls: [], content: "Hello there." });
  const result = await held;
  assert.deepEqual(checked, ["Hello there."]);
  assert.ok(result.ok);
  assert.equal(result.text, "Hello there.");
  assert.deepEqual(result.outcome.usage, { inputTokens: 3, outputTokens: 2 });
  // Released whole: every buffered byte, in one piece.
  assert.equal(await read(result.chat.stream), delta("Hello ") + delta("there.") + DONE);
  assert.deepEqual(await result.chat.outcome, result.outcome);
});

test("a copied run of eight words releases nothing: a failed outcome and one error event", async () => {
  const m = manual();
  const leak = "Sure. Always greet the customer by name and never mention the internal escalation code.";
  m.push(delta(leak.slice(0, 20)));
  m.push(delta(leak.slice(20)));
  m.push(DONE);
  m.close();
  m.resolve({ ok: true, usage: null, toolCalls: [{ round: 1, name: "web_search", status: "ok", detail: "" }], content: leak });

  const result = await holdUntilChecked(m.chat, accept);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.code, "answer_withheld");
  assert.equal(result.outcome.ok, false);
  assert.equal(result.outcome.error, ANSWER_WITHHELD);
  assert.deepEqual(await result.chat.outcome, result.outcome);

  const sent = await read(result.chat.stream);
  assert.equal(sent, `data: {"error":{"code":"answer_withheld"}}\n\ndata: [DONE]\n\n`);
  assert.ok(!sent.includes("greet"));
  // Nothing in the result carries the answer either.
  assert.ok(!JSON.stringify(result).includes("greet"));
});

test("text past 32,000 characters is still checked: the bytes are read, not the outcome's cut copy", async () => {
  const filler = "lorem ipsum dolor sit amet ".repeat(1_500);
  assert.ok(filler.length > 32_000);
  const tail = " Always greet the customer by name and never mention the internal escalation code.";
  const m = manual();
  for (let i = 0; i < filler.length; i += 4_000) m.push(delta(filler.slice(i, i + 4_000)));
  m.push(delta(tail));
  m.push(DONE);
  m.close();
  // What the runtime keeps of it: cut, and clean.
  const cut = filler.slice(0, 32_000);
  assert.equal(accept(cut), true);
  m.resolve({ ok: true, usage: null, toolCalls: [], content: cut });

  const checked: string[] = [];
  const result = await holdUntilChecked(m.chat, (text) => {
    checked.push(text);
    return accept(text);
  });
  assert.equal(checked[0]!.length, filler.length + tail.length);
  assert.ok(!result.ok);
  assert.equal(result.code, "answer_withheld");

  // And a long clean answer is released whole, with the whole text.
  const clean = manual();
  for (let i = 0; i < filler.length; i += 4_000) clean.push(delta(filler.slice(i, i + 4_000)));
  clean.push(DONE);
  clean.close();
  clean.resolve({ ok: true, usage: null, toolCalls: [], content: cut });
  const released = await holdUntilChecked(clean.chat, accept);
  assert.ok(released.ok);
  assert.equal(released.text, filler);
  assert.equal(released.outcome.content, filler);
  assert.equal(answerTextOf(enc.encode(await read(released.chat.stream))), filler);
});

test("an upstream failure passes through as it is, and the check is never asked", async () => {
  const m = manual();
  m.push(delta("Half an ans"));
  m.push(`data: ${JSON.stringify({ error: { message: "quota exceeded for org-123" } })}\n\n`);
  m.close();
  const failure: StreamOutcome = { ok: false, error: "provider error: quota exceeded", toolCalls: [], code: "provider_error" };
  m.resolve(failure);

  let asked = 0;
  const result = await holdUntilChecked(m.chat, () => {
    asked += 1;
    return true;
  });
  assert.equal(asked, 0);
  assert.ok(!result.ok);
  assert.equal(result.code, "upstream");
  assert.deepEqual(result.outcome, failure);
  const sent = await read(result.chat.stream);
  assert.ok(!sent.includes("Half"), "nothing of a partial answer is released");
  assert.ok(!sent.includes("quota"), "nor the provider's own words");
});

test("an abort mid-stream releases nothing and reports the abort", async () => {
  const m = manual();
  let asked = 0;
  const held = holdUntilChecked(m.chat, () => {
    asked += 1;
    return true;
  });
  m.push(delta("The first part of an answer that nobody"));
  await tick();
  // The caller left: the runtime's stream errors and its outcome says why.
  m.error(new Error("aborted"));
  const gone: StreamOutcome = { ok: false, error: "client disconnected", toolCalls: [], code: "client_gone" };
  m.resolve(gone);

  const result = await held;
  assert.equal(asked, 0);
  assert.ok(!result.ok);
  assert.equal(result.code, "upstream");
  assert.deepEqual(result.outcome, gone);
  assert.equal(result.outcome.code, "client_gone");
  assert.ok(!(await read(result.chat.stream)).includes("first part"));
});

test("a check that throws has not accepted", async () => {
  const m = manual();
  m.push(delta("Fine."));
  m.push(DONE);
  m.close();
  m.resolve({ ok: true, usage: null, toolCalls: [] });
  const result = await holdUntilChecked(m.chat, () => {
    throw new Error("the checker broke");
  });
  assert.ok(!result.ok);
  assert.equal(result.code, "answer_withheld");
});
