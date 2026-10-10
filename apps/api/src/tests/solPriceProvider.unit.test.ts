/**
 * Drives apps/api/src/services/buildSolPriceDeps.ts: getSolQuote bound to
 * settings and a connection, against stand-ins. No network.
 *
 * Pinning:
 *   - off refuses; static quotes the setting or refuses when it is not set;
 *     neither touches the RPC;
 *   - pyth makes ONE getMultipleAccountsInfo call for [price account, clock]
 *     at "confirmed" per read;
 *   - an RPC error is the refusal rpc_unavailable, never an earlier price,
 *     and the next call asks again;
 *   - a quote is remembered for up to 5 seconds, aged by the time that has
 *     passed, and never served past the maximum age.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./unitEnv.js";
import { PublicKey } from "@solana/web3.js";

import {
  bindSolPriceReads,
  createSolPriceProvider,
  getSolQuote,
  resetSolQuoteForTests,
  solPriceSettingsFromEnv,
  type SolPriceAccountRead,
  type SolPriceConnection,
  type SolPriceSettings,
} from "../services/buildSolPriceDeps.js";
import {
  CLOCK_SYSVAR_ADDRESS,
  PYTH_RECEIVER_PROGRAM_ID_DEFAULT,
  PYTH_SOL_USD_ACCOUNT_DEFAULT,
  PYTH_SOL_USD_FEED_ID_DEFAULT,
} from "../services/solPrice.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/pyth-sol-usd-2026-10-10.json", import.meta.url), "utf8")
) as { clusters: Record<string, { owner: string; priceAccountDataBase64: string; clockDataBase64: string }> };

const mainnet = fixture.clusters["mainnet-beta"]!;
const PRICE_DATA = new Uint8Array(Buffer.from(mainnet.priceAccountDataBase64, "base64"));
// publish_time 1791664915, chain clock 1791664959: 44 seconds old.
const CLOCK_AT_READ = 1791664959n;
const AGE_AT_READ = 44;

function clockBytes(unixTimestamp: bigint): Uint8Array {
  const buf = Buffer.alloc(40);
  buf.writeBigInt64LE(unixTimestamp, 32);
  return new Uint8Array(buf);
}

function settings(overrides: Partial<SolPriceSettings> = {}): SolPriceSettings {
  return {
    source: "pyth",
    staticUsd: null,
    account: PYTH_SOL_USD_ACCOUNT_DEFAULT,
    feedIdHex: PYTH_SOL_USD_FEED_ID_DEFAULT,
    programIds: [PYTH_RECEIVER_PROGRAM_ID_DEFAULT],
    maxAgeSeconds: 120,
    maxConfBps: 100,
    maxEmaDeviationBps: 1000,
    minUsd: null,
    maxUsd: null,
    ...overrides,
  };
}

/**
 * A stand-in chain. Its clock moves with the harness's wall clock, the way
 * the real one does, so a second read of the same price is older.
 */
function makeHarness(initial: Partial<SolPriceSettings> = {}) {
  const state = {
    nowMs: 1_000_000,
    settings: settings(initial),
    fail: false as boolean | "garbage",
    reads: [] as Array<readonly string[]>,
    priceData: PRICE_DATA as Uint8Array | null,
  };
  const startMs = state.nowMs;
  const provider = createSolPriceProvider({
    settings: () => state.settings,
    nowMs: () => state.nowMs,
    readAccounts: async (addresses) => {
      state.reads.push(addresses);
      if (state.fail === true) throw new Error("fetch failed");
      if (state.fail === "garbage") return [] as Array<SolPriceAccountRead | null>;
      const chainNow = CLOCK_AT_READ + BigInt(Math.floor((state.nowMs - startMs) / 1000));
      return [
        state.priceData ? { owner: mainnet.owner, data: state.priceData } : null,
        { owner: "Sysvar1111111111111111111111111111111111111", data: clockBytes(chainNow) },
      ];
    },
  });
  return { state, provider };
}

test("getSolQuote: off refuses with source_off and reads nothing", async () => {
  const { state, provider } = makeHarness({ source: "off", staticUsd: 150 });
  assert.deepEqual(await provider.getSolQuote(), { ok: false, code: "source_off" });
  assert.equal(state.reads.length, 0);
});

test("getSolQuote: static quotes the setting with no uncertainty and reads nothing", async () => {
  const { state, provider } = makeHarness({ source: "static", staticUsd: 142.5 });
  const result = await provider.getSolQuote();
  assert.deepEqual(result, {
    ok: true,
    quote: {
      source: "static",
      midMicroUsdPerSol: 142_500_000n,
      confMicroUsdPerSol: 0n,
      publishTime: 1_000,
      ageSeconds: 0,
      account: null,
    },
  });
  assert.equal(state.reads.length, 0);
});

test("getSolQuote: static with no price set refuses with static_not_set", async () => {
  const { state, provider } = makeHarness({ source: "static", staticUsd: null });
  const result = await provider.getSolQuote();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "static_not_set");
  assert.equal(state.reads.length, 0);
});

test("getSolQuote: pyth reads the price account and the clock in one call and judges them", async () => {
  const { state, provider } = makeHarness();
  const result = await provider.getSolQuote();
  assert.deepEqual(result, {
    ok: true,
    quote: {
      source: "pyth",
      midMicroUsdPerSol: 110_341_044n,
      confMicroUsdPerSol: 30_938n,
      publishTime: 1791664915,
      ageSeconds: AGE_AT_READ,
      account: PYTH_SOL_USD_ACCOUNT_DEFAULT,
    },
  });
  assert.deepEqual(state.reads, [[PYTH_SOL_USD_ACCOUNT_DEFAULT, CLOCK_SYSVAR_ADDRESS]]);
});

test("getSolQuote: a refusal from the judge is passed on with its code", async () => {
  const missing = makeHarness();
  missing.state.priceData = null;
  const a = await missing.provider.getSolQuote();
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.code, "account_missing");

  const owner = makeHarness({ programIds: ["11111111111111111111111111111111"] });
  const b = await owner.provider.getSolQuote();
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.code, "wrong_owner");

  // The band is given in dollars and applied in micro-dollars.
  const band = makeHarness({ minUsd: 200 });
  const c = await band.provider.getSolQuote();
  assert.equal(c.ok, false);
  if (!c.ok) assert.equal(c.code, "out_of_band");
  assert.equal((await makeHarness({ minUsd: 100, maxUsd: 120 }).provider.getSolQuote()).ok, true);
});

test("getSolQuote: a refusal is not remembered, the next call reads again", async () => {
  const { state, provider } = makeHarness();
  state.priceData = null;
  assert.equal((await provider.getSolQuote()).ok, false);
  state.priceData = PRICE_DATA;
  assert.equal((await provider.getSolQuote()).ok, true);
  assert.equal(state.reads.length, 2);
});

test("getSolQuote: an RPC error is rpc_unavailable, it does not throw, and the next call asks again", async () => {
  const { state, provider } = makeHarness();
  state.fail = true;
  const failed = await provider.getSolQuote();
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.code, "rpc_unavailable");
    assert.equal(failed.detail, "fetch failed");
  }
  assert.equal(state.reads.length, 1);

  const again = await provider.getSolQuote();
  assert.equal(again.ok, false);
  assert.equal(state.reads.length, 2, "a failed read is asked again, not remembered");

  state.fail = false;
  assert.equal((await provider.getSolQuote()).ok, true);
  assert.equal(state.reads.length, 3);
});

test("getSolQuote: an answer that is not two accounts is rpc_unavailable", async () => {
  const { state, provider } = makeHarness();
  state.fail = "garbage";
  const result = await provider.getSolQuote();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "rpc_unavailable");
});

test("getSolQuote: a failed read is never replaced by the price read before it", async () => {
  const { state, provider } = makeHarness();
  assert.equal((await provider.getSolQuote()).ok, true);

  // Past the 5 seconds, the RPC is down: a refusal, not the old quote.
  state.nowMs += 5_001;
  state.fail = true;
  const result = await provider.getSolQuote();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "rpc_unavailable");
  assert.equal(state.reads.length, 2);

  // And the failure dropped the memory: still within reach of the first
  // read's 5 seconds had the clock been wound back, it asks again.
  state.nowMs -= 5_001;
  const after = await provider.getSolQuote();
  assert.equal(after.ok, false);
  assert.equal(state.reads.length, 3);
});

test("getSolQuote: a quote is remembered for 5 seconds and aged by the time that has passed", async () => {
  const { state, provider } = makeHarness();
  const first = await provider.getSolQuote();
  assert.equal(first.ok && first.quote.ageSeconds, AGE_AT_READ);

  state.nowMs += 1;
  const soon = await provider.getSolQuote();
  // Part of a second counts as a whole one.
  assert.equal(soon.ok && soon.quote.ageSeconds, AGE_AT_READ + 1);

  state.nowMs += 2_999;
  const later = await provider.getSolQuote();
  assert.equal(later.ok && later.quote.ageSeconds, AGE_AT_READ + 3);
  assert.equal(later.ok && later.quote.midMicroUsdPerSol, 110_341_044n);

  state.nowMs += 2_000; // exactly 5 seconds after the read
  const atEdge = await provider.getSolQuote();
  assert.equal(atEdge.ok && atEdge.quote.ageSeconds, AGE_AT_READ + 5);
  assert.equal(state.reads.length, 1, "one RPC call served all four");

  state.nowMs += 1; // past 5 seconds
  const fresh = await provider.getSolQuote();
  assert.equal(fresh.ok, true);
  assert.equal(state.reads.length, 2);
  // The harness's chain clock moved with the wall clock.
  assert.equal(fresh.ok && fresh.quote.ageSeconds, AGE_AT_READ + 5);
});

test("getSolQuote: the memory never serves a quote past the maximum age", async () => {
  // 44 seconds old at the read, 46 allowed.
  const { state, provider } = makeHarness({ maxAgeSeconds: 46 });
  const first = await provider.getSolQuote();
  assert.equal(first.ok && first.quote.ageSeconds, 44);

  state.nowMs += 2_000;
  const atLimit = await provider.getSolQuote();
  assert.equal(atLimit.ok && atLimit.quote.ageSeconds, 46);
  assert.equal(state.reads.length, 1);

  // 47 seconds old and still inside the 5-second memory: not served. The
  // provider reads again, and the chain says the same price is now stale.
  state.nowMs += 1_000;
  const tooOld = await provider.getSolQuote();
  assert.equal(tooOld.ok, false);
  if (!tooOld.ok) assert.equal(tooOld.code, "stale");
  assert.equal(state.reads.length, 2);
});

test("getSolQuote: a remembered quote past the maximum age with the RPC down is a refusal", async () => {
  const { state, provider } = makeHarness({ maxAgeSeconds: 45 });
  assert.equal((await provider.getSolQuote()).ok, true);
  state.nowMs += 1_500; // 46 seconds old
  state.fail = true;
  const result = await provider.getSolQuote();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "rpc_unavailable");
});

test("getSolQuote: a tighter setting is applied to the remembered quote at once", async () => {
  const { state, provider } = makeHarness();
  assert.equal((await provider.getSolQuote()).ok, true);

  // Same instant, the maximum age drops below the quote's age.
  state.settings = settings({ maxAgeSeconds: 30 });
  const stale = await provider.getSolQuote();
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "stale");
  assert.equal(state.reads.length, 2);

  // Turned off, it refuses without reading.
  state.settings = settings({ source: "off" });
  assert.deepEqual(await provider.getSolQuote(), { ok: false, code: "source_off" });
  assert.equal(state.reads.length, 2);
});

test("getSolQuote: a wall clock that went backwards drops the memory", async () => {
  const { state, provider } = makeHarness();
  assert.equal((await provider.getSolQuote()).ok, true);
  state.nowMs -= 10_000;
  await provider.getSolQuote();
  assert.equal(state.reads.length, 2);
});

test("getSolQuote: reset forgets the remembered quote", async () => {
  const { state, provider } = makeHarness();
  await provider.getSolQuote();
  provider.reset();
  await provider.getSolQuote();
  assert.equal(state.reads.length, 2);
});

test("getSolQuote: a throwing settings reader is a refusal, not an exception", async () => {
  const provider = createSolPriceProvider({
    settings: () => {
      throw new Error("no settings");
    },
    nowMs: () => 0,
    readAccounts: async () => [],
  });
  const result = await provider.getSolQuote();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "rpc_unavailable");
});

test("bindSolPriceReads: one getMultipleAccountsInfo call at confirmed, answers mapped in order", async () => {
  const calls: Array<{ keys: string[]; commitment: string }> = [];
  const connection: SolPriceConnection = {
    getMultipleAccountsInfo: async (publicKeys, commitment) => {
      calls.push({ keys: publicKeys.map((k) => k.toBase58()), commitment });
      return [{ owner: new PublicKey(mainnet.owner), data: Buffer.from(PRICE_DATA) }, null];
    },
  };
  const read = bindSolPriceReads(() => connection);
  const answer = await read([PYTH_SOL_USD_ACCOUNT_DEFAULT, CLOCK_SYSVAR_ADDRESS]);

  assert.deepEqual(calls, [
    { keys: [PYTH_SOL_USD_ACCOUNT_DEFAULT, CLOCK_SYSVAR_ADDRESS], commitment: "confirmed" },
  ]);
  assert.equal(answer.length, 2);
  assert.equal(answer[0]?.owner, mainnet.owner);
  assert.deepEqual(Buffer.from(answer[0]!.data), Buffer.from(PRICE_DATA));
  assert.equal(answer[1], null);
});

test("bindSolPriceReads + provider: a connection that throws is rpc_unavailable, one call per read", async () => {
  let calls = 0;
  const connection: SolPriceConnection = {
    getMultipleAccountsInfo: async () => {
      calls += 1;
      throw new Error("503 Service Unavailable");
    },
  };
  const provider = createSolPriceProvider({
    settings: () => settings(),
    nowMs: () => 0,
    readAccounts: bindSolPriceReads(() => connection),
  });
  const a = await provider.getSolQuote();
  const b = await provider.getSolQuote();
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.code, "rpc_unavailable");
  assert.equal(b.ok, false);
  assert.equal(calls, 2);
});

test("bindSolPriceReads + provider: an address that is not a public key refuses and sends nothing", async () => {
  let calls = 0;
  const connection: SolPriceConnection = {
    getMultipleAccountsInfo: async () => {
      calls += 1;
      return [null, null];
    },
  };
  const provider = createSolPriceProvider({
    settings: () => settings({ account: "not-a-key" }),
    nowMs: () => 0,
    readAccounts: bindSolPriceReads(() => connection),
  });
  const result = await provider.getSolQuote();
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test("solPriceSettingsFromEnv: names map across and the program list is split", () => {
  const mapped = solPriceSettingsFromEnv({
    SOL_PRICE_SOURCE: "pyth",
    SOL_PRICE_STATIC_USD: undefined,
    PYTH_SOL_USD_ACCOUNT: ` ${PYTH_SOL_USD_ACCOUNT_DEFAULT} `,
    PYTH_SOL_USD_FEED_ID: PYTH_SOL_USD_FEED_ID_DEFAULT,
    PYTH_PROGRAM_IDS: `${PYTH_RECEIVER_PROGRAM_ID_DEFAULT}, 11111111111111111111111111111111,`,
    SOL_PRICE_MAX_AGE_SECONDS: 90,
    SOL_PRICE_MAX_CONF_BPS: 50,
    SOL_PRICE_MAX_EMA_DEVIATION_BPS: 500,
    SOL_PRICE_MIN_USD: 20,
    SOL_PRICE_MAX_USD: undefined,
  });
  assert.deepEqual(mapped, {
    source: "pyth",
    staticUsd: null,
    account: PYTH_SOL_USD_ACCOUNT_DEFAULT,
    feedIdHex: PYTH_SOL_USD_FEED_ID_DEFAULT,
    programIds: [PYTH_RECEIVER_PROGRAM_ID_DEFAULT, "11111111111111111111111111111111"],
    maxAgeSeconds: 90,
    maxConfBps: 50,
    maxEmaDeviationBps: 500,
    minUsd: 20,
    maxUsd: null,
  });
});

test("getSolQuote: a source that is not a known one is off and reads nothing", async () => {
  const { state, provider } = makeHarness({ source: "coingecko" as unknown as SolPriceSettings["source"] });
  assert.deepEqual(await provider.getSolQuote(), { ok: false, code: "source_off" });
  assert.equal(state.reads.length, 0);
});

test("getSolQuote: a band that is set but not a usable number refuses, it does not switch the band off", async () => {
  for (const band of [
    { minUsd: Number.NaN },
    { minUsd: 1e300 },
    { maxUsd: Number.POSITIVE_INFINITY },
    { maxUsd: 0 },
    { minUsd: -5 },
  ]) {
    const { state, provider } = makeHarness(band);
    const result = await provider.getSolQuote();
    assert.equal(result.ok, false, JSON.stringify(band));
    if (!result.ok) assert.equal(result.code, "out_of_band");
    assert.equal(state.reads.length, 0);
  }
});

test("getSolQuote: a band that turns unusable is not answered from memory", async () => {
  const { state, provider } = makeHarness();
  assert.equal((await provider.getSolQuote()).ok, true);
  state.settings = settings({ minUsd: Number.NaN });
  assert.equal((await provider.getSolQuote()).ok, false);
});

test("getSolQuote: the bound form refuses with source_off under the default settings and never throws", async () => {
  // unitEnv leaves SOL_PRICE_SOURCE at its default, off: nothing is read.
  resetSolQuoteForTests();
  assert.deepEqual(await getSolQuote(), { ok: false, code: "source_off" });
  resetSolQuoteForTests();
});

test("getSolQuote: a failed read's detail never carries the RPC address or a key in it", async () => {
  const provider = createSolPriceProvider({
    settings: () => settings(),
    nowMs: () => 1_000_000,
    readAccounts: async () => {
      throw new Error("failed to get accounts: POST https://rpc.example.test/v1/?api-key=SECRET123 timed out");
    },
  });
  const result = await provider.getSolQuote();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "rpc_unavailable");
    assert.ok(result.detail, "a detail for the log");
    assert.doesNotMatch(result.detail!, /SECRET123|rpc\.example\.test|https?:/);
    assert.match(result.detail!, /timed out/);
  }
});
