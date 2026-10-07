import assert from "node:assert/strict";
import test from "node:test";

import {
  createFailClosedLimiter,
  createMemoryLimiterStore,
  createRedisLimiterStore,
  LIMITER_KEY_PREFIX,
  LIMITER_LUA,
  type LimitRule,
  type LimiterStore,
} from "../services/failClosedLimiter.js";

// Drives services/failClosedLimiter.ts. The property under test is in the
// name: when it cannot count, it never answers "ok".

const rule = (over: Partial<LimitRule> = {}): LimitRule => ({
  scope: "ip",
  key: "ip:a",
  limit: 2,
  windowSeconds: 60,
  ...over,
});

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("requests under every rule are allowed, and each is counted against every rule", async () => {
  const store = createMemoryLimiterStore();
  const limiter = createFailClosedLimiter(store);
  const rules = [rule(), rule({ scope: "key", key: "key:k", limit: 5 })];
  assert.deepEqual(await limiter.consume(rules), { status: "ok" });
  assert.deepEqual(await limiter.consume(rules), { status: "ok" });
  assert.equal(await limiter.peek("ip:a"), 2);
  assert.equal(await limiter.peek("key:k"), 2);
  assert.equal(await limiter.peek("never-used"), 0);
});

test("at the limit the request is refused, naming the rule, its scope and when to retry", async () => {
  const time = clock();
  const limiter = createFailClosedLimiter(createMemoryLimiterStore(time.now));
  const perIp = rule();
  const perKey = rule({ scope: "key", key: "key:k", limit: 5 });
  await limiter.consume([perIp, perKey]);
  await limiter.consume([perIp, perKey]);
  time.advance(20_000);

  const decision = await limiter.consume([perIp, perKey]);
  assert.equal(decision.status, "limited");
  assert.ok(decision.status === "limited");
  assert.equal(decision.scope, "ip");
  assert.equal(decision.rule, perIp);
  assert.equal(decision.retryAfterSeconds, 40, "what is left of the window that started at the first hit");
});

test("a refusal counts against no rule: consume is all-or-nothing", async () => {
  const limiter = createFailClosedLimiter(createMemoryLimiterStore());
  const perMinute = rule({ scope: "ip", key: "ip:minute", limit: 1 });
  const dailyCap = rule({ scope: "key", key: "key:day", limit: 100, windowSeconds: 86_400 });

  assert.equal((await limiter.consume([dailyCap, perMinute])).status, "ok");
  for (let i = 0; i < 5; i++) {
    const refused = await limiter.consume([dailyCap, perMinute]);
    assert.ok(refused.status === "limited" && refused.scope === "ip");
  }
  assert.equal(await limiter.peek("key:day"), 1, "five refused requests used none of the daily cap");
  assert.equal(await limiter.peek("ip:minute"), 1);
});

test("a window expires, and the count starts over", async () => {
  const time = clock();
  const limiter = createFailClosedLimiter(createMemoryLimiterStore(time.now));
  await limiter.consume([rule({ limit: 1 })]);
  assert.equal((await limiter.consume([rule({ limit: 1 })])).status, "limited");
  time.advance(60_000);
  assert.equal((await limiter.consume([rule({ limit: 1 })])).status, "ok");
  assert.equal(await limiter.peek("ip:a"), 1);
});

test("a limit of zero refuses every request", async () => {
  const limiter = createFailClosedLimiter(createMemoryLimiterStore());
  const decision = await limiter.consume([rule({ limit: 0 })]);
  assert.ok(decision.status === "limited");
  assert.equal(decision.retryAfterSeconds, 60);
});

test("a store that throws is 'unavailable', never ok", async () => {
  const errors: unknown[] = [];
  const broken: LimiterStore = {
    consume: async () => {
      throw new Error("ECONNREFUSED");
    },
    peek: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  const limiter = createFailClosedLimiter(broken, { onUnavailable: (err) => errors.push(err) });
  assert.deepEqual(await limiter.consume([rule()]), { status: "unavailable" });
  assert.equal(await limiter.peek("ip:a"), null, "an unreadable count is unknown, not zero");
  assert.equal(errors.length, 2);
});

test("a store that does not answer in time is 'unavailable', never ok", async () => {
  const hung: LimiterStore = {
    consume: () => new Promise(() => {}),
    peek: () => new Promise(() => {}),
  };
  const limiter = createFailClosedLimiter(hung, { timeoutMs: 20 });
  const started = Date.now();
  assert.deepEqual(await limiter.consume([rule()]), { status: "unavailable" });
  assert.equal(await limiter.peek("ip:a"), null);
  assert.ok(Date.now() - started < 2_000);
});

test("an answer the limiter cannot read is 'unavailable', never ok", async () => {
  const answers: unknown[] = [undefined, null, {}, { allowed: "yes" }, { allowed: false, index: 7, retryAfterMs: 1 }];
  for (const answer of answers) {
    const odd: LimiterStore = { consume: async () => answer as never, peek: async () => Number.NaN };
    const limiter = createFailClosedLimiter(odd);
    assert.deepEqual(await limiter.consume([rule()]), { status: "unavailable" }, JSON.stringify(answer));
    assert.equal(await limiter.peek("ip:a"), null);
  }
});

test("no rules, or a malformed rule, is 'unavailable': nothing was counted", async () => {
  const limiter = createFailClosedLimiter(createMemoryLimiterStore());
  assert.deepEqual(await limiter.consume([]), { status: "unavailable" });
  assert.deepEqual(await limiter.consume([rule({ key: "" })]), { status: "unavailable" });
  assert.deepEqual(await limiter.consume([rule({ limit: Number.NaN })]), { status: "unavailable" });
  assert.deepEqual(await limiter.consume([rule({ windowSeconds: 0 })]), { status: "unavailable" });
});

test("the Redis store sends hash-tagged keys and limit/window pairs to the script, and reads its two answers", async () => {
  const calls: unknown[][] = [];
  let reply: unknown = [1, 0, 0];
  const redis = {
    publicChatConsume: async (...args: Array<string | number>) => {
      calls.push(args);
      return reply;
    },
    get: async (key: string) => (key === `${LIMITER_KEY_PREFIX}key:day` ? "17" : null),
  };
  const store = createRedisLimiterStore(redis);
  const rules = [
    { key: "ip:a", limit: 10, windowMs: 60_000 },
    { key: "key:day", limit: 1000, windowMs: 86_400_000 },
  ];

  assert.deepEqual(await store.consume(rules), { allowed: true });
  assert.deepEqual(calls[0], [
    2,
    `${LIMITER_KEY_PREFIX}ip:a`,
    `${LIMITER_KEY_PREFIX}key:day`,
    10,
    60_000,
    1000,
    86_400_000,
  ]);
  // One hash tag for every key: a cluster runs the multi-key script in one slot.
  assert.match(LIMITER_KEY_PREFIX, /\{[^}]+\}/);

  reply = [0, 2, 4_500];
  assert.deepEqual(await store.consume(rules), { allowed: false, index: 1, retryAfterMs: 4_500 });

  for (const bad of [null, "OK", [], [1], [0, 9, 0], [2, 0, 0]]) {
    reply = bad;
    await assert.rejects(store.consume(rules), /unexpected reply/, JSON.stringify(bad));
  }

  assert.equal(await store.peek("key:day"), 17);
  assert.equal(await store.peek("unused"), 0);
});

test("the script checks every key before it increments any", () => {
  const firstIncr = LIMITER_LUA.indexOf("INCR");
  const lastGet = LIMITER_LUA.lastIndexOf("'GET'");
  assert.ok(lastGet > 0 && firstIncr > lastGet, "all GETs precede the first INCR");
  assert.match(LIMITER_LUA, /PEXPIRE/);
});
