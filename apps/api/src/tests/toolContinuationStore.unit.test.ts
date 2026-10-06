import assert from "node:assert/strict";
import test from "node:test";

import {
  continuationRedisKey,
  createMemoryToolContinuationStore,
  createRedisToolContinuationStore,
  type ContinuationRedis,
} from "../services/toolContinuationStore.js";
import type { ModelMessage } from "../services/toolLoop.js";

// services/toolContinuationStore.ts: where the server half of a
// function-calling turn waits for the caller. Its contract is "fail soft":
// nothing here may fail a request.

const TRANSCRIPT: ModelMessage[] = [
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_s", type: "function", function: { name: "calculator", arguments: "{}" } },
      { id: "call_c", type: "function", function: { name: "get_weather", arguments: "{}" } },
    ],
  },
  { role: "tool", tool_call_id: "call_s", content: "4" },
];

const SCOPE = { orgId: "org-1", agentId: "agent-1" };

function fakeRedis() {
  const data = new Map<string, { value: string; ttl: number }>();
  const redis: ContinuationRedis = {
    get: async (key) => data.get(key)?.value ?? null,
    set: async (key, value, _mode, seconds) => {
      data.set(key, { value, ttl: seconds });
      return "OK";
    },
  };
  return { redis, data };
}

test("round-trips a continuation keyed by org, agent and call id", async () => {
  const { redis, data } = fakeRedis();
  const store = createRedisToolContinuationStore({ redis, ttlSeconds: 120 });
  await store.save(SCOPE, ["call_c", "call_c2"], TRANSCRIPT);

  assert.deepEqual(await store.load({ ...SCOPE, callId: "call_c" }), TRANSCRIPT);
  assert.deepEqual(await store.load({ ...SCOPE, callId: "call_c2" }), TRANSCRIPT, "any handed-back id finds it");
  assert.deepEqual([...data.keys()].sort(), [
    "agentchat:cont:org-1:agent-1:call_c",
    "agentchat:cont:org-1:agent-1:call_c2",
  ]);
  assert.ok([...data.values()].every((entry) => entry.ttl === 120));

  // The same call id under another org or another agent is a different key.
  assert.equal(await store.load({ orgId: "org-2", agentId: "agent-1", callId: "call_c" }), null);
  assert.equal(await store.load({ orgId: "org-1", agentId: "agent-2", callId: "call_c" }), null);
  assert.equal(continuationRedisKey({ ...SCOPE, callId: "x" }), "agentchat:cont:org-1:agent-1:x");
});

test("expired or oversized entries are not stored or returned", async () => {
  let now = 1_000_000;
  const memory = createMemoryToolContinuationStore({ ttlSeconds: 60, now: () => now });
  await memory.save(SCOPE, ["call_c"], TRANSCRIPT);
  assert.deepEqual(await memory.load({ ...SCOPE, callId: "call_c" }), TRANSCRIPT);
  now += 60_001;
  assert.equal(await memory.load({ ...SCOPE, callId: "call_c" }), null, "expired");

  const { redis, data } = fakeRedis();
  const capped = createRedisToolContinuationStore({ redis, maxBytes: 64 });
  await capped.save(SCOPE, ["call_c"], TRANSCRIPT);
  assert.equal(data.size, 0, "a transcript over the cap is not written at all");
  assert.equal(await capped.load({ ...SCOPE, callId: "call_c" }), null);

  await createRedisToolContinuationStore({ redis }).save(SCOPE, ["call_c"], []);
  assert.equal(data.size, 0, "an empty transcript is nothing to resume");
});

test("store errors degrade to a miss", async () => {
  const errors: string[] = [];
  const broken: ContinuationRedis = {
    get: async () => {
      throw new Error("ECONNREFUSED");
    },
    set: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  const store = createRedisToolContinuationStore({
    redis: broken,
    onError: (_err, op) => errors.push(op),
  });
  await store.save(SCOPE, ["call_c"], TRANSCRIPT);
  assert.equal(await store.load({ ...SCOPE, callId: "call_c" }), null);
  assert.deepEqual(errors, ["save", "load"]);
});

test("a stored value that is not a transcript reads as a miss", async () => {
  const { redis, data } = fakeRedis();
  const store = createRedisToolContinuationStore({ redis });
  for (const value of ["not json", "{}", "[]", '[{"role":"root","content":"x"}]', '[{"role":"tool","content":5}]']) {
    data.set("agentchat:cont:org-1:agent-1:call_c", { value, ttl: 1 });
    assert.equal(await store.load({ ...SCOPE, callId: "call_c" }), null, value);
  }
});
