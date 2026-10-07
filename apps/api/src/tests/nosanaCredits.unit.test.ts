import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCreditGate,
  makeCreditBalanceFetcher,
  makeCreditReader,
  microUsdToUsd,
  NosanaCreditsError,
  requiredCreditsMicroUsd,
  toCreditBalance,
  type FetchLike,
} from "../services/nosanaCredits.js";

// services/nosanaCredits.ts: the prepaid-credit balance and the deploy gate.
// Fetchers are injected; nothing here opens a socket.

const NOW = new Date("2026-10-07T12:00:00Z");
const KEY = "nos_unit_test_key_0000000000_wxyz";

function hasCode(code: string) {
  return (err: unknown) => err instanceof NosanaCreditsError && err.code === code;
}

// ============================================
// toCreditBalance
// ============================================

test("toCreditBalance converts USD numbers to micro-USD; available = assigned - reserved - settled", () => {
  const balance = toCreditBalance({ assignedCredits: 25, reservedCredits: 1.5, settledCredits: 3.25 }, NOW);
  assert.equal(balance.assignedMicroUsd, 25_000_000n);
  assert.equal(balance.reservedMicroUsd, 1_500_000n);
  assert.equal(balance.settledMicroUsd, 3_250_000n);
  assert.equal(balance.availableMicroUsd, 20_250_000n);
  assert.equal(balance.fetchedAt, NOW);
});

test("toCreditBalance floors available at zero and survives float noise", () => {
  assert.equal(
    toCreditBalance({ assignedCredits: 1, reservedCredits: 2, settledCredits: 3 }, NOW).availableMicroUsd,
    0n,
  );
  // 0.1 + 0.2 in floats is 0.30000000000000004: still exactly 300000 micro-USD.
  assert.equal(
    toCreditBalance({ assignedCredits: 0.1 + 0.2, reservedCredits: 0, settledCredits: 0 }, NOW).assignedMicroUsd,
    300_000n,
  );
});

test("toCreditBalance refuses NaN, negatives, strings, missing fields and non-objects", () => {
  const good = { assignedCredits: 1, reservedCredits: 0, settledCredits: 0 };
  for (const bad of [
    { ...good, assignedCredits: Number.NaN },
    { ...good, reservedCredits: -1 },
    { ...good, settledCredits: "3" },
    { ...good, assignedCredits: Number.POSITIVE_INFINITY },
    { assignedCredits: 1, reservedCredits: 0 },
    null,
    "Unauthorized",
    [],
  ]) {
    assert.throws(() => toCreditBalance(bad, NOW), hasCode("nosana_credits_unavailable"));
  }
});

// ============================================
// requiredCreditsMicroUsd
// ============================================

test("required credits = estimate + floor: the floor is counted once", () => {
  // 3060 at 14 micro-USD/s, one replica, a 2h timeout: 100800 micro-USD.
  assert.equal(
    requiredCreditsMicroUsd({ costMicroUsdPerSecond: 14n, replicas: 1, reserveSeconds: 7200, floorMicroUsd: 5_000_000n }),
    5_100_800n,
  );
  // A $10 balance with a $5 floor admits it (max(floor, estimate) + floor would need exactly $10
  // and refuse the next one).
  assert.ok(5_100_800n < 10_000_000n);
  assert.equal(
    requiredCreditsMicroUsd({ costMicroUsdPerSecond: 111n, replicas: 3, reserveSeconds: 3600, floorMicroUsd: 0n }),
    1_198_800n,
  );
});

test("requiredCreditsMicroUsd refuses nonsense inputs", () => {
  const ok = { costMicroUsdPerSecond: 1n, replicas: 1, reserveSeconds: 1, floorMicroUsd: 0n };
  assert.throws(() => requiredCreditsMicroUsd({ ...ok, replicas: 0 }), RangeError);
  assert.throws(() => requiredCreditsMicroUsd({ ...ok, replicas: 1.5 }), RangeError);
  assert.throws(() => requiredCreditsMicroUsd({ ...ok, reserveSeconds: 0 }), RangeError);
  assert.throws(() => requiredCreditsMicroUsd({ ...ok, costMicroUsdPerSecond: -1n }), RangeError);
  assert.throws(() => requiredCreditsMicroUsd({ ...ok, floorMicroUsd: -1n }), RangeError);
});

// ============================================
// makeCreditBalanceFetcher
// ============================================

function fakeFetch(answer: { status: number; body?: unknown; throws?: Error; badJson?: boolean }) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (answer.throws) throw answer.throws;
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: async () => {
        if (answer.badJson) throw new SyntaxError("Unexpected token <");
        return answer.body;
      },
    };
  };
  return { fetch, calls };
}

test("the balance fetch is a GET with the Bearer key that follows no redirect", async () => {
  const body = { assignedCredits: 10, reservedCredits: 0, settledCredits: 0 };
  const { fetch, calls } = fakeFetch({ status: 200, body });
  const fetchBalance = makeCreditBalanceFetcher({ backendUrl: "https://nosana.example.test/", apiKey: KEY, fetch });
  assert.deepEqual(await fetchBalance(), body);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://nosana.example.test/api/credits/balance");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(calls[0]!.init?.headers?.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0]!.init?.redirect, "error");
});

test("401 and 403 are nosana_auth_failed; every other failure is nosana_credits_unavailable", async () => {
  for (const status of [401, 403]) {
    const { fetch } = fakeFetch({ status, body: "Unauthorized" });
    await assert.rejects(
      makeCreditBalanceFetcher({ backendUrl: "https://n.example.test", apiKey: KEY, fetch })(),
      hasCode("nosana_auth_failed"),
    );
  }
  for (const answer of [
    { status: 500, body: { error: "boom" } },
    { status: 404, body: {} },
    { status: 429, body: {} },
    { status: 200, badJson: true },
    { status: 0, throws: new Error("getaddrinfo ENOTFOUND") },
  ]) {
    const { fetch } = fakeFetch(answer);
    await assert.rejects(
      makeCreditBalanceFetcher({ backendUrl: "https://n.example.test", apiKey: KEY, fetch })(),
      hasCode("nosana_credits_unavailable"),
    );
  }
});

test("no error message from the balance fetch contains the key", async () => {
  for (const answer of [{ status: 401 }, { status: 500 }, { status: 0, throws: new Error(`refused ${KEY}`) }]) {
    const { fetch } = fakeFetch(answer);
    await assert.rejects(
      makeCreditBalanceFetcher({ backendUrl: "https://n.example.test", apiKey: KEY, fetch })(),
      (err: unknown) => err instanceof NosanaCreditsError && !err.message.includes(KEY),
    );
  }
});

// ============================================
// makeCreditReader
// ============================================

function reader(opts: { cacheMs: number }) {
  const state = {
    now: NOW.getTime(),
    fetches: 0,
    next: { assignedCredits: 10, reservedCredits: 0, settledCredits: 0 } as unknown,
    fail: null as Error | null,
  };
  const r = makeCreditReader({
    fetchBalance: async () => {
      state.fetches += 1;
      if (state.fail) throw state.fail;
      return state.next;
    },
    now: () => new Date(state.now),
    cacheMs: opts.cacheMs,
  });
  return { r, state };
}

test("the reader serves a young value from memory and refetches once it is older than cacheMs", async () => {
  const { r, state } = reader({ cacheMs: 30_000 });
  assert.equal((await r.read()).availableMicroUsd, 10_000_000n);
  state.next = { assignedCredits: 4, reservedCredits: 0, settledCredits: 0 };
  state.now += 29_999;
  assert.equal((await r.read()).availableMicroUsd, 10_000_000n, "still cached");
  assert.equal(state.fetches, 1);
  state.now += 1;
  assert.equal((await r.read()).availableMicroUsd, 4_000_000n);
  assert.equal(state.fetches, 2);
});

test("fresh always goes to Nosana, and a failed read is never answered from the cache", async () => {
  const { r, state } = reader({ cacheMs: 30_000 });
  await r.read();
  state.next = { assignedCredits: 1, reservedCredits: 0, settledCredits: 0 };
  assert.equal((await r.read({ fresh: true })).availableMicroUsd, 1_000_000n);
  assert.equal(state.fetches, 2);

  state.fail = new Error("socket hang up");
  await assert.rejects(r.read({ fresh: true }), hasCode("nosana_credits_unavailable"));
  state.fail = new NosanaCreditsError("nosana_auth_failed", "refused");
  await assert.rejects(r.read({ fresh: true }), hasCode("nosana_auth_failed"));
  state.fail = null;
  state.next = { assignedCredits: "ten" };
  await assert.rejects(r.read({ fresh: true }), hasCode("nosana_credits_unavailable"));
});

// ============================================
// checkCreditGate
// ============================================

const GATE = { costMicroUsdPerSecond: 14n, replicas: 1, reserveSeconds: 7200, floorMicroUsd: 5_000_000n };

test("the gate: below estimate + floor is nosana_credits_low, exactly enough passes", async () => {
  const { r, state } = reader({ cacheMs: 30_000 });
  state.next = { assignedCredits: 5.100799, reservedCredits: 0, settledCredits: 0 };
  const low = await checkCreditGate({ reader: r, ...GATE });
  assert.deepEqual(low, {
    ok: false,
    code: "nosana_credits_low",
    requiredMicroUsd: 5_100_800n,
    availableMicroUsd: 5_100_799n,
  });

  state.next = { assignedCredits: 5.1008, reservedCredits: 0, settledCredits: 0 };
  const ok = await checkCreditGate({ reader: r, ...GATE });
  assert.equal(ok.ok, true);
  assert.equal(ok.requiredMicroUsd, 5_100_800n);
});

test("the gate counts reserved and settled credits against the balance", async () => {
  const { r, state } = reader({ cacheMs: 0 });
  state.next = { assignedCredits: 10, reservedCredits: 3, settledCredits: 2 };
  assert.equal((await checkCreditGate({ reader: r, ...GATE })).ok, false);
});

test("the gate reads fresh: a cached balance that would admit is not used", async () => {
  const { r, state } = reader({ cacheMs: 3_600_000 });
  await r.read(); // $10 cached for an hour
  state.next = { assignedCredits: 1, reservedCredits: 0, settledCredits: 0 };
  const gate = await checkCreditGate({ reader: r, ...GATE });
  assert.equal(gate.ok, false);
  assert.equal(state.fetches, 2);
});

test("the gate fails closed: an unreadable balance refuses, with the reason kept", async () => {
  const { r, state } = reader({ cacheMs: 3_600_000 });
  await r.read(); // a good value is in memory
  state.fail = new Error("timeout");
  assert.deepEqual(await checkCreditGate({ reader: r, ...GATE }), {
    ok: false,
    code: "nosana_credits_unavailable",
    requiredMicroUsd: 5_100_800n,
  });
  state.fail = new NosanaCreditsError("nosana_auth_failed", "refused");
  assert.equal((await checkCreditGate({ reader: r, ...GATE }) as { code: string }).code, "nosana_auth_failed");
});

test("microUsdToUsd is for display only", () => {
  assert.equal(microUsdToUsd(5_100_800n), 5.1008);
  assert.equal(microUsdToUsd(0n), 0);
});
