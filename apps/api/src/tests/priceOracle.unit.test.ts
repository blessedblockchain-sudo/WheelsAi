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

// ----------------------------------------------------------------------
// makeSolPriceProvider — builder factory under test
//
// Contract: returns a () => Promise<number> that:
//   - calls fetchPrice() and caches the result for cacheTtlMs
//   - on cache hit (within TTL), returns cached value without calling fetch
//   - on fetch error WITH a stale cached value, returns the stale value
//   - on fetch error WITHOUT a cache, returns fallbackUsd
//   - injectable nowMs() lets tests advance time without sleeps
// ----------------------------------------------------------------------

test("makeSolPriceProvider: first call fetches", async () => {
  setupEnv();
  const { makeSolPriceProvider } = await import("../services/priceOracle.js");

  let fetchCalls = 0;
  const getSolPriceUsd = makeSolPriceProvider({
    fetchPrice: async () => {
      fetchCalls++;
      return 150.42;
    },
    cacheTtlMs: 60_000,
    fallbackUsd: 100,
    nowMs: () => 1_000,
  });

  const price = await getSolPriceUsd();
  assert.equal(price, 150.42);
  assert.equal(fetchCalls, 1);
});

test("makeSolPriceProvider: cache hit within TTL skips fetch", async () => {
  setupEnv();
  const { makeSolPriceProvider } = await import("../services/priceOracle.js");

  let fetchCalls = 0;
  let now = 1_000;
  const getSolPriceUsd = makeSolPriceProvider({
    fetchPrice: async () => {
      fetchCalls++;
      return 150;
    },
    cacheTtlMs: 60_000,
    fallbackUsd: 100,
    nowMs: () => now,
  });

  await getSolPriceUsd();           // populates cache at t=1000
  now = 1_000 + 30_000;             // 30s later — still in TTL
  const price = await getSolPriceUsd();

  assert.equal(price, 150);
  assert.equal(fetchCalls, 1, "second call should NOT fetch");
});

test("makeSolPriceProvider: cache miss after TTL refetches", async () => {
  setupEnv();
  const { makeSolPriceProvider } = await import("../services/priceOracle.js");

  let fetchCalls = 0;
  let now = 1_000;
  const getSolPriceUsd = makeSolPriceProvider({
    fetchPrice: async () => {
      fetchCalls++;
      return 150 + fetchCalls;
    },
    cacheTtlMs: 60_000,
    fallbackUsd: 100,
    nowMs: () => now,
  });

  await getSolPriceUsd();           // t=1000, fetch=1, price=151
  now = 1_000 + 60_001;             // just past TTL
  const price = await getSolPriceUsd();

  assert.equal(price, 152);
  assert.equal(fetchCalls, 2);
});

test("makeSolPriceProvider: fetch error with stale cache returns stale value", async () => {
  setupEnv();
  const { makeSolPriceProvider } = await import("../services/priceOracle.js");

  let mode: "ok" | "fail" = "ok";
  let now = 1_000;
  const getSolPriceUsd = makeSolPriceProvider({
    fetchPrice: async () => {
      if (mode === "fail") throw new Error("network down");
      return 150;
    },
    cacheTtlMs: 60_000,
    fallbackUsd: 100,
    nowMs: () => now,
  });

  await getSolPriceUsd();           // OK; cache=150 at t=1000
  mode = "fail";
  now = 1_000 + 120_000;            // past TTL → forces refetch attempt
  const price = await getSolPriceUsd();

  assert.equal(price, 150, "should return stale cached value");
});

test("makeSolPriceProvider: fetch error with no cache returns fallback", async () => {
  setupEnv();
  const { makeSolPriceProvider } = await import("../services/priceOracle.js");

  const getSolPriceUsd = makeSolPriceProvider({
    fetchPrice: async () => {
      throw new Error("network down");
    },
    cacheTtlMs: 60_000,
    fallbackUsd: 100,
    nowMs: () => 1_000,
  });

  const price = await getSolPriceUsd();
  assert.equal(price, 100);
});

test("makeSolPriceProvider: rejects non-finite prices", async () => {
  setupEnv();
  const { makeSolPriceProvider } = await import("../services/priceOracle.js");

  const getSolPriceUsd = makeSolPriceProvider({
    fetchPrice: async () => Number.NaN,
    cacheTtlMs: 60_000,
    fallbackUsd: 100,
    nowMs: () => 1_000,
  });

  // NaN/Infinity coming back from a price feed is "no usable data"; treat it
  // exactly like a fetch error so the runway card never renders nonsense.
  const price = await getSolPriceUsd();
  assert.equal(price, 100);
});

test("makeSolPriceProvider: rejects zero or negative prices", async () => {
  setupEnv();
  const { makeSolPriceProvider } = await import("../services/priceOracle.js");

  const getSolPriceUsd = makeSolPriceProvider({
    fetchPrice: async () => 0,
    cacheTtlMs: 60_000,
    fallbackUsd: 100,
    nowMs: () => 1_000,
  });

  const price = await getSolPriceUsd();
  assert.equal(price, 100, "0 USD/SOL is never real; use fallback");
});

// ----------------------------------------------------------------------
// fetchSolPriceFromCoinGecko — production fetcher, integration-shaped
// ----------------------------------------------------------------------

test("fetchSolPriceFromCoinGecko: parses the standard simple/price response", async () => {
  setupEnv();
  const { fetchSolPriceFromCoinGecko } = await import(
    "../services/priceOracle.js"
  );

  const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    assert.match(url, /api\.coingecko\.com\/api\/v3\/simple\/price/);
    assert.match(url, /ids=solana/);
    assert.match(url, /vs_currencies=usd/);
    return new Response(JSON.stringify({ solana: { usd: 173.27 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const price = await fetchSolPriceFromCoinGecko({ fetchImpl: fakeFetch });
  assert.equal(price, 173.27);
});

test("fetchSolPriceFromCoinGecko: throws on non-OK HTTP", async () => {
  setupEnv();
  const { fetchSolPriceFromCoinGecko } = await import(
    "../services/priceOracle.js"
  );

  const fakeFetch: typeof fetch = async () =>
    new Response("rate limited", { status: 429 });

  await assert.rejects(
    () => fetchSolPriceFromCoinGecko({ fetchImpl: fakeFetch }),
    /429/,
  );
});

test("fetchSolPriceFromCoinGecko: throws when payload shape is unexpected", async () => {
  setupEnv();
  const { fetchSolPriceFromCoinGecko } = await import(
    "../services/priceOracle.js"
  );

  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ solana: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    () => fetchSolPriceFromCoinGecko({ fetchImpl: fakeFetch }),
    /usd.*not.*number|invalid.*payload|unexpected/i,
  );
});
