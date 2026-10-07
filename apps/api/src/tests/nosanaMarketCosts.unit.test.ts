import assert from "node:assert/strict";
import test from "node:test";
import type { FetchLike } from "../services/nosanaCredits.js";
import {
  costMicroUsdPerSecond,
  DEFAULT_NETWORK_FEE_PCT,
  MARKET_COST_STALE_MAX_MS,
  makeMarketCostReader,
  makeMarketListFetcher,
  parseMarketCost,
  retailMicroUsdPerSecond,
} from "../services/nosanaMarketCosts.js";

// services/nosanaMarketCosts.ts: the platform's USD cost per market, from the
// public market list. The fetcher is injected; nothing here opens a socket.

const M3060 = "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq";
const M4090 = "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf";

test("cost per second rounds UP: the 3060 at $0.0436/h plus 10% is 14 micro-USD/s", () => {
  // 0.0436 x 1.10 / 3600 = 13.32 micro-USD/s
  assert.equal(costMicroUsdPerSecond({ usdPerHour: 0.0436, feePct: 10 }), 14n);
  // 0.3636 x 1.10 / 3600 = 111.1
  assert.equal(costMicroUsdPerSecond({ usdPerHour: 0.3636, feePct: 10 }), 112n);
  // An exact division is not rounded further: $3.60/h, no fee = 1000 micro-USD/s.
  assert.equal(costMicroUsdPerSecond({ usdPerHour: 3.6, feePct: 0 }), 1000n);
  assert.equal(costMicroUsdPerSecond({ usdPerHour: 0.000001, feePct: 0 }), 1n);
  assert.throws(() => costMicroUsdPerSecond({ usdPerHour: 0, feePct: 10 }), RangeError);
  assert.throws(() => costMicroUsdPerSecond({ usdPerHour: 1, feePct: -1 }), RangeError);
});

test("parseMarketCost accepts the price as a number or a numeric string", () => {
  assert.deepEqual(parseMarketCost({ address: M3060, usd_reward_per_hour: 0.0436, network_fee_percentage: 10 }), {
    address: M3060,
    usdPerHour: 0.0436,
    feePct: 10,
    costMicroUsdPerSecond: 14n,
  });
  assert.equal(
    parseMarketCost({ address: M3060, usd_reward_per_hour: "0.0436", network_fee_percentage: "10" })
      ?.costMicroUsdPerSecond,
    14n,
  );
});

test("parseMarketCost gives no cost rather than a guessed one", () => {
  for (const usd of [0, -1, null, undefined, "", "abc", Number.NaN, {}, true]) {
    assert.equal(parseMarketCost({ address: M3060, usd_reward_per_hour: usd }), null);
  }
  assert.equal(parseMarketCost({ usd_reward_per_hour: 1 }), null, "no address");
  assert.equal(parseMarketCost({ address: "", usd_reward_per_hour: 1 }), null);
  assert.equal(parseMarketCost(null), null);
  assert.equal(parseMarketCost("market"), null);
});

test("a missing or unusable fee falls back to the default, which errs high", () => {
  assert.equal(DEFAULT_NETWORK_FEE_PCT, 10);
  for (const fee of [undefined, null, "x", -5, 250]) {
    assert.equal(
      parseMarketCost({ address: M3060, usd_reward_per_hour: 0.0436, network_fee_percentage: fee })?.feePct,
      10,
    );
  }
  assert.equal(
    parseMarketCost({ address: M3060, usd_reward_per_hour: 0.0436, network_fee_percentage: 0 })?.feePct,
    0,
  );
});

function costReader(cacheMs: number) {
  const state = {
    now: 1_000_000,
    fetches: 0,
    rows: [
      { address: M3060, usd_reward_per_hour: 0.0436, network_fee_percentage: 10 },
      { address: M4090, usd_reward_per_hour: 0.3636, network_fee_percentage: 10 },
      { address: "BrokenMarket", usd_reward_per_hour: null },
    ] as unknown[],
    fail: null as Error | null,
  };
  const reader = makeMarketCostReader({
    fetchMarkets: async () => {
      state.fetches += 1;
      if (state.fail) throw state.fail;
      return state.rows;
    },
    now: () => new Date(state.now),
    cacheMs,
  });
  return { reader, state };
}

test("the reader prices known markets, yields null for an unknown or unparsable one", async () => {
  const { reader } = costReader(600_000);
  assert.equal((await reader.costFor(M3060))?.costMicroUsdPerSecond, 14n);
  assert.equal((await reader.costFor(M4090))?.costMicroUsdPerSecond, 112n);
  assert.equal(await reader.costFor("BrokenMarket"), null);
  assert.equal(await reader.costFor("NotListed"), null);
  assert.equal((await reader.read()).size, 2);
});

test("the reader honours cacheMs and `fresh`", async () => {
  const { reader, state } = costReader(600_000);
  await reader.costFor(M3060);
  await reader.costFor(M4090);
  assert.equal(state.fetches, 1);
  state.now += 599_999;
  await reader.read();
  assert.equal(state.fetches, 1);
  state.now += 1;
  await reader.read();
  assert.equal(state.fetches, 2);
  await reader.read({ fresh: true });
  assert.equal(state.fetches, 3);
});

test("an unreadable list throws: the caller decides what stands in", async () => {
  const { reader, state } = costReader(600_000);
  state.fail = new Error("ECONNRESET");
  await assert.rejects(reader.costFor(M3060), /ECONNRESET/);
});

test("the market list fetch is a public GET: no Authorization header is sent", async () => {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, ok: true, json: async () => [{ address: M3060 }] };
  };
  const rows = await makeMarketListFetcher({ backendUrl: "https://nosana.example.test/", fetch })();
  assert.equal(rows.length, 1);
  assert.equal(calls[0]!.url, "https://nosana.example.test/api/markets/");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(Object.keys(calls[0]!.init?.headers ?? {}).some((h) => h.toLowerCase() === "authorization"), false);
});

test("the market list fetch refuses a non-2xx answer and a body that is not an array", async () => {
  const answering = (status: number, body: unknown): FetchLike => async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  await assert.rejects(
    makeMarketListFetcher({ backendUrl: "https://n.example.test", fetch: answering(503, []) })(),
    /HTTP 503/,
  );
  await assert.rejects(
    makeMarketListFetcher({ backendUrl: "https://n.example.test", fetch: answering(200, { data: [] }) })(),
    /not an array/,
  );
});

test("retail USD per second becomes whole micro-USD per second", () => {
  assert.equal(retailMicroUsdPerSecond(0.0001), 100n);
  assert.equal(retailMicroUsdPerSecond(0.00015), 150n);
  assert.equal(retailMicroUsdPerSecond(0.0015), 1500n);
  assert.throws(() => retailMicroUsdPerSecond(-1), RangeError);
});

// ---------------------------------------------------------------------------
// The last cost seen for a market, bounded: what an admitting decision may use
// when the list stops giving one.
// ---------------------------------------------------------------------------

function staleReader(staleMs: number | undefined) {
  let now = 0;
  let rows: unknown[] | Error = [];
  const stale: Array<{ marketAddress: string; ageMs: number; reason: string }> = [];
  const reader = makeMarketCostReader({
    fetchMarkets: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
    now: () => new Date(now),
    cacheMs: 0,
    ...(staleMs === undefined ? {} : { staleMs }),
    onStale: (info) => void stale.push(info),
  });
  return {
    reader,
    stale,
    at: (ms: number) => void (now = ms),
    answer: (next: unknown[] | Error) => void (rows = next),
  };
}

const PRICED = [{ address: M3060, usd_reward_per_hour: 0.0436, network_fee_percentage: 10 }];

test("an unreadable list serves a market's last seen cost up to the stale bound, then throws", async () => {
  const t = staleReader(1_000);
  t.answer(PRICED);
  assert.equal((await t.reader.costFor(M3060))?.costMicroUsdPerSecond, 14n);

  t.answer(new Error("list is down"));
  t.at(999);
  assert.equal((await t.reader.costFor(M3060))?.costMicroUsdPerSecond, 14n);
  assert.deepEqual(t.stale, [{ marketAddress: M3060, ageMs: 999, reason: "unreadable" }]);
  // A market never seen has nothing to stand in: the read failure surfaces.
  await assert.rejects(t.reader.costFor(M4090), /list is down/);
  // read() itself never serves stale: the operator view must say "unreadable".
  await assert.rejects(t.reader.read(), /list is down/);

  t.at(1_000);
  await assert.rejects(t.reader.costFor(M3060), /list is down/);
});

test("a row that loses its price keeps its last seen cost up to the bound, then has none", async () => {
  const t = staleReader(1_000);
  t.answer(PRICED);
  await t.reader.costFor(M3060);

  t.answer([{ address: M3060, usd_reward_per_hour: null }]);
  t.at(500);
  assert.equal((await t.reader.costFor(M3060))?.usdPerHour, 0.0436);
  assert.equal(t.stale.at(-1)?.reason, "unpriced");
  assert.equal(await t.reader.costFor(M4090), null, "never priced: no cost, not a guess");

  t.at(1_000);
  assert.equal(await t.reader.costFor(M3060), null);

  // A fresh price replaces the remembered one and restarts its age.
  t.answer([{ address: M3060, usd_reward_per_hour: 0.5, network_fee_percentage: 0 }]);
  t.at(5_000);
  assert.equal((await t.reader.costFor(M3060))?.usdPerHour, 0.5);
  t.answer(new Error("down again"));
  t.at(5_999);
  assert.equal((await t.reader.costFor(M3060))?.usdPerHour, 0.5);
});

test("with no stale bound nothing is remembered past the list: unreadable throws, unpriced is null", async () => {
  const t = staleReader(undefined);
  t.answer(PRICED);
  await t.reader.costFor(M3060);
  t.answer([]);
  assert.equal(await t.reader.costFor(M3060), null);
  t.answer(new Error("down"));
  await assert.rejects(t.reader.costFor(M3060), /down/);
  assert.deepEqual(t.stale, []);
});

test("a throwing stale reporter does not change the answer", async () => {
  let rows: unknown[] | null = PRICED;
  const reader = makeMarketCostReader({
    fetchMarkets: async () => {
      if (!rows) throw new Error("down");
      return rows;
    },
    now: () => new Date(0),
    cacheMs: 0,
    staleMs: MARKET_COST_STALE_MAX_MS,
    onStale: () => {
      throw new Error("logger broke");
    },
  });
  await reader.costFor(M3060);
  rows = null;
  assert.equal((await reader.costFor(M3060))?.costMicroUsdPerSecond, 14n);
  assert.equal(MARKET_COST_STALE_MAX_MS, 86_400_000);
});
