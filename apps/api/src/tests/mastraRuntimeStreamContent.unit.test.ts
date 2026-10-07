import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { loadSkillsConfig } from "../config/skills.js";
import { passthroughStream, runChatStream, STREAM_CONTENT_KEPT_CHARS } from "../services/mastra-runtime.js";
import { createSkillRegistry } from "../services/skills/registry.js";

// A streamed answer used to be counted and never kept: the outcome knew how
// many characters went by, not which. An opted-in widget transcript needs
// the text, so the outcome of a stream now carries it (bounded).

const enc = new TextEncoder();
const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const finish = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

function body(events: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(enc.encode(event));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // forward nothing; the outcome is what is under test
  }
}

const NO_DEADLINE = { signal: undefined, expired: () => false, clear: () => {} };

test("a passed-through stream's outcome carries the answer text, joined from its deltas", async () => {
  const chat = passthroughStream(body([delta("Hel"), delta("lo, "), delta("world."), finish, DONE]), undefined, NO_DEADLINE);
  await drain(chat.stream);
  const outcome = await chat.outcome;
  assert.ok(outcome.ok);
  assert.equal(outcome.content, "Hello, world.");
  assert.equal(chat.progress().contentChars, 13);
});

test("the kept text is capped; the count of what was streamed is not", async () => {
  const piece = "x".repeat(10_000);
  const chat = passthroughStream(
    body([delta(piece), delta(piece), delta(piece), delta(`${piece}tail`), finish, DONE]),
    undefined,
    NO_DEADLINE,
  );
  await drain(chat.stream);
  const outcome = await chat.outcome;
  assert.ok(outcome.ok);
  assert.equal(outcome.content?.length, STREAM_CONTENT_KEPT_CHARS);
  assert.equal(STREAM_CONTENT_KEPT_CHARS, 32_000);
  assert.equal(chat.progress().contentChars, 40_004);
});

test("a stream that failed has no answer text to store", async () => {
  const chat = passthroughStream(
    body([delta("partial"), `data: ${JSON.stringify({ error: { message: "quota exceeded for org-123" } })}\n\n`]),
    undefined,
    NO_DEADLINE,
  );
  await drain(chat.stream);
  const outcome = await chat.outcome;
  assert.equal(outcome.ok, false);
  assert.equal("content" in outcome, false);
});

test("a tool-using chat's streamed outcome carries the finished answer", async () => {
  const config = loadSkillsConfig({});
  const registry = createSkillRegistry({
    getConfig: () => ({ config, error: null }),
    getFileStore: () => null,
    getSandbox: () => null,
    knowledge: {
      loadKnowledgeBaseId: async () => null,
      search: async () => ({ results: [], mode: "keyword", fallbackReason: null }),
    },
  });
  const replies = [
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "calculator", arguments: '{"expression":"17*23"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    { choices: [{ message: { content: "17 times 23 is 391." }, finish_reason: "stop" }] },
  ];
  let call = 0;
  const fetchImpl = (async () =>
    new Response(JSON.stringify(replies[call++]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const chat = await runChatStream(
    { apiKey: "k", baseUrl: "https://provider.example/v1", modelName: "test-model" },
    {
      name: "agent",
      tools: [{ name: "calculator", description: "calc" }],
      modelConfig: { externalModel: "free/test", temperature: 0.2, maxTokens: 256 },
    },
    [{ role: "user", content: "what is 17*23?" }],
    { registry, fetchImpl, agentId: "a1", orgId: "o1", mode: "public" },
  );
  await drain(chat.stream);
  const outcome = await chat.outcome;
  assert.ok(outcome.ok);
  assert.equal(outcome.content, "17 times 23 is 391.");
});
