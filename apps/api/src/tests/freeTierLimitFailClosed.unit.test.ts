import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { env } from "../config/env.js";
import { checkFreeTierLimit, type FreeTierCounter } from "../middleware/free-tier-limit.js";

// The free-model limiter fails OPEN for an organization's own chats (a Redis
// blip must not take the playground down) and CLOSED for a public caller: an
// anonymous visitor on somebody's widget is never let through uncounted.

type Slot = [Error | null, unknown];

function counter(script: { exec?: () => Promise<Slot[] | null>; counts?: Record<string, number> } = {}) {
  const counts = script.counts ?? {};
  const expired: string[] = [];
  const fake: FreeTierCounter = {
    pipeline() {
      const ops: Array<() => Slot> = [];
      return {
        incr(key: string) {
          ops.push(() => [null, (counts[key] = (counts[key] ?? 0) + 1)]);
        },
        ttl() {
          ops.push(() => [null, 30]);
        },
        decr(key: string) {
          ops.push(() => [null, (counts[key] = (counts[key] ?? 0) - 1)]);
        },
        exec: script.exec ?? (async () => ops.map((op) => op())),
      };
    },
    expire: async (key) => {
      expired.push(key);
    },
  };
  return { fake, counts, expired };
}

const deps = (fake: FreeTierCounter) => ({ counter: fake, rateMultiplier: async () => 1, now: () => 1_000_000_000 });

test("a counted request is allowed for both kinds of caller, and counted once", async () => {
  for (const failClosed of [false, true]) {
    const { fake, counts } = counter();
    const result = await checkFreeTierLimit("org-1", { failClosed }, deps(fake));
    assert.equal(result.allowed, true);
    assert.deepEqual(counts, { "free:rpm:org-1": 1, "free:rpd:org-1": 1 });
    assert.equal(result.remaining.rpm, env.FREE_TIER_RPM - 1);
  }
});

test("over the limit is refused for both, and the refused request is not counted", async () => {
  for (const failClosed of [false, true]) {
    const { fake, counts } = counter({ counts: { "free:rpm:org-1": env.FREE_TIER_RPM, "free:rpd:org-1": 3 } });
    const result = await checkFreeTierLimit("org-1", { failClosed }, deps(fake));
    assert.equal(result.allowed, false);
    assert.deepEqual(counts, { "free:rpm:org-1": env.FREE_TIER_RPM, "free:rpd:org-1": 3 });
  }
});

test("when Redis throws, an owner's chat goes through and a public caller's is refused", async () => {
  const exec = async () => {
    throw new Error("ECONNREFUSED");
  };
  const open = await checkFreeTierLimit("org-1", {}, deps(counter({ exec }).fake));
  assert.equal(open.allowed, true);

  const closed = await checkFreeTierLimit("org-1", { failClosed: true }, deps(counter({ exec }).fake));
  assert.equal(closed.allowed, false);
  assert.deepEqual(closed.remaining, { rpm: 0, rpd: 0 });
  assert.equal(closed.resetAt.rpm, 1_000_000 + 60, "retry in a minute, not tomorrow");
});

test("a pipeline that returns nothing, or a command that failed inside it, is not a count for a public caller", async () => {
  const outcomes: Array<Slot[] | null> = [
    null,
    [[new Error("READONLY"), null], [null, -1], [null, 5], [null, 30]],
    [[null, 1], [null, 30], [new Error("OOM"), null], [null, -1]],
    [[null, "QUEUED"], [null, 30], [null, 1], [null, 30]],
    [[null, 1], [null, 30]],
  ];
  for (const slots of outcomes) {
    const exec = async () => slots;
    const closed = await checkFreeTierLimit("org-1", { failClosed: true }, deps(counter({ exec }).fake));
    assert.equal(closed.allowed, false, JSON.stringify(slots?.map(([err, value]) => [err?.message ?? null, value])));
  }
  // The owner's path keeps its old reading of the same answers.
  const open = await checkFreeTierLimit("org-1", {}, deps(counter({ exec: async () => null }).fake));
  assert.equal(open.allowed, true);
});
