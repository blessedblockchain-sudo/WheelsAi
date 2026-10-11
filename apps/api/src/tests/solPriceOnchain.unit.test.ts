/**
 * Drives apps/api/src/services/solPrice.ts: the decoder for Pyth's
 * PriceUpdateV2 account and the clock sysvar, the judge, and the
 * whole-number money helpers.
 *
 * Pinning:
 *   - the real bytes read from mainnet and devnet on 2026-10-10
 *     (fixtures/pyth-sol-usd-2026-10-10.json) decode to the known values
 *     and are accepted under the default rules;
 *   - every refusal code is tripped one at a time by an account built here,
 *     the Partial verification tag included;
 *   - money in rounds against the customer, money out rounds against the
 *     customer, a margin moves both further, and no helper answers with
 *     zero or a negative amount.
 *
 * No network: the module under test is pure and imports no settings.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./unitEnv.js";
import {
  DEFAULT_SOL_PRICE_RULES,
  PRICE_UPDATE_V2_DISCRIMINATOR_HEX,
  PYTH_RECEIVER_PROGRAM_ID_DEFAULT,
  PYTH_SOL_USD_ACCOUNT_DEFAULT,
  PYTH_SOL_USD_FEED_ID_DEFAULT,
  centsToCreditForLamports,
  decodeClockUnixTimestamp,
  decodePriceUpdateV2,
  judgeSolPrice,
  lamportsForMicroUsdAtRate,
  lamportsToCollectForCents,
  lamportsToSendForCents,
  solUsdRate,
  staticSolQuote,
  type SolPriceRefusalCode,
  type SolPriceRules,
  type SolQuote,
} from "../services/solPrice.js";

interface ClusterFixture {
  owner: string;
  priceAccountDataBase64: string;
  clockDataBase64: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/pyth-sol-usd-2026-10-10.json", import.meta.url), "utf8")
) as { clusters: Record<"mainnet-beta" | "devnet", ClusterFixture> };

function bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

// ---------------------------------------------------------------------------
// An encoder, so each refusal can be tripped on its own
// ---------------------------------------------------------------------------

interface AccountFields {
  discriminatorHex: string;
  tag: number;
  numSignatures: number;
  feedIdHex: string;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  prevPublishTime: bigint;
  emaPrice: bigint;
  emaConf: bigint;
  postedSlot: bigint;
}

const NOW = 1_800_000_000n;

const GOOD: AccountFields = {
  discriminatorHex: PRICE_UPDATE_V2_DISCRIMINATOR_HEX,
  tag: 1,
  numSignatures: 5,
  feedIdHex: PYTH_SOL_USD_FEED_ID_DEFAULT,
  price: 10_000_000_000n, // $100.00 at exponent -8
  conf: 5_000_000n, // $0.05
  exponent: -8,
  publishTime: NOW - 10n,
  prevPublishTime: NOW - 11n,
  emaPrice: 10_000_000_000n,
  emaConf: 5_000_000n,
  postedSlot: 123_456_789n,
};

function encodeAccount(overrides: Partial<AccountFields> = {}): Uint8Array {
  const f = { ...GOOD, ...overrides };
  const partial = f.tag === 0;
  const buf = Buffer.alloc(134);
  Buffer.from(f.discriminatorHex, "hex").copy(buf, 0);
  buf.fill(7, 8, 40); // write authority
  buf.writeUInt8(f.tag, 40);
  let at = 41;
  if (partial) {
    buf.writeUInt8(f.numSignatures, at);
    at += 1;
  }
  Buffer.from(f.feedIdHex, "hex").copy(buf, at);
  buf.writeBigInt64LE(f.price, at + 32);
  buf.writeBigUInt64LE(f.conf, at + 40);
  buf.writeInt32LE(f.exponent, at + 48);
  buf.writeBigInt64LE(f.publishTime, at + 52);
  buf.writeBigInt64LE(f.prevPublishTime, at + 60);
  buf.writeBigInt64LE(f.emaPrice, at + 68);
  buf.writeBigUInt64LE(f.emaConf, at + 76);
  buf.writeBigUInt64LE(f.postedSlot, at + 84);
  return new Uint8Array(buf);
}

function encodeClock(unixTimestamp: bigint): Uint8Array {
  const buf = Buffer.alloc(40);
  buf.writeBigUInt64LE(1_000n, 0);
  buf.writeBigInt64LE(unixTimestamp - 1_000n, 8);
  buf.writeBigUInt64LE(1_054n, 16);
  buf.writeBigUInt64LE(1_055n, 24);
  buf.writeBigInt64LE(unixTimestamp, 32);
  return new Uint8Array(buf);
}

function judgeBuilt(
  overrides: Partial<AccountFields> = {},
  opts: {
    owner?: string;
    clock?: Uint8Array | null;
    rules?: Partial<SolPriceRules>;
    source?: "off" | "pyth";
    missing?: boolean;
  } = {}
) {
  return judgeSolPrice({
    source: opts.source ?? "pyth",
    account: opts.missing
      ? null
      : { owner: opts.owner ?? PYTH_RECEIVER_PROGRAM_ID_DEFAULT, data: encodeAccount(overrides) },
    clockData: opts.clock === undefined ? encodeClock(NOW) : opts.clock,
    rules: { ...DEFAULT_SOL_PRICE_RULES, ...opts.rules },
  });
}

function expectRefusal(result: ReturnType<typeof judgeSolPrice>, code: SolPriceRefusalCode) {
  assert.equal(result.ok, false, `expected the refusal ${code}`);
  if (!result.ok) assert.equal(result.code, code);
}

// ---------------------------------------------------------------------------
// Real bytes
// ---------------------------------------------------------------------------

const EXPECTED = {
  "mainnet-beta": {
    price: 11034104464n,
    conf: 3093758n,
    publishTime: 1791664915n,
    prevPublishTime: 1791664914n,
    emaPrice: 11025838350n,
    emaConf: 3024349n,
    postedSlot: 455390819n,
    clock: 1791664959n,
    age: 44,
    midMicro: 110_341_044n,
    confMicro: 30_938n,
  },
  devnet: {
    price: 11031440705n,
    conf: 2715854n,
    publishTime: 1791664957n,
    prevPublishTime: 1791664956n,
    emaPrice: 11025924110n,
    emaConf: 3021235n,
    postedSlot: 509664440n,
    clock: 1791664961n,
    age: 4,
    midMicro: 110_314_407n,
    confMicro: 27_159n,
  },
} as const;

for (const cluster of ["mainnet-beta", "devnet"] as const) {
  test(`solPrice: the real ${cluster} bytes decode to the known values`, () => {
    const f = fixture.clusters[cluster];
    const want = EXPECTED[cluster];
    const data = bytes(f.priceAccountDataBase64);
    assert.equal(data.byteLength, 134);

    const decoded = decodePriceUpdateV2(data);
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;
    const u = decoded.update;
    assert.equal(u.verification, "full");
    assert.equal(u.numSignatures, null);
    assert.equal(u.feedIdHex, PYTH_SOL_USD_FEED_ID_DEFAULT);
    assert.equal(u.price, want.price);
    assert.equal(u.conf, want.conf);
    assert.equal(u.exponent, -8);
    assert.equal(u.publishTime, want.publishTime);
    assert.equal(u.prevPublishTime, want.prevPublishTime);
    assert.equal(u.emaPrice, want.emaPrice);
    assert.equal(u.emaConf, want.emaConf);
    assert.equal(u.postedSlot, want.postedSlot);
    assert.equal(decodeClockUnixTimestamp(bytes(f.clockDataBase64)), want.clock);
  });

  test(`solPrice: the real ${cluster} bytes are accepted under the default rules`, () => {
    const f = fixture.clusters[cluster];
    const want = EXPECTED[cluster];
    const result = judgeSolPrice({
      source: "pyth",
      account: { owner: f.owner, data: bytes(f.priceAccountDataBase64) },
      clockData: bytes(f.clockDataBase64),
      rules: DEFAULT_SOL_PRICE_RULES,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.quote, {
      source: "pyth",
      midMicroUsdPerSol: want.midMicro,
      confMicroUsdPerSol: want.confMicro,
      publishTime: Number(want.publishTime),
      ageSeconds: want.age,
      account: PYTH_SOL_USD_ACCOUNT_DEFAULT,
    });
  });
}

test("solPrice: the decoder reads a view that does not start at byte 0 of its buffer", () => {
  const data = bytes(fixture.clusters["mainnet-beta"].priceAccountDataBase64);
  const padded = new Uint8Array(data.byteLength + 16);
  padded.set(data, 16);
  const decoded = decodePriceUpdateV2(padded.subarray(16));
  assert.equal(decoded.ok, true);
  if (decoded.ok) assert.equal(decoded.update.price, EXPECTED["mainnet-beta"].price);
});

// ---------------------------------------------------------------------------
// Each refusal, one at a time
// ---------------------------------------------------------------------------

test("solPrice: the account built by this test's encoder is accepted", () => {
  const result = judgeBuilt();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.quote.midMicroUsdPerSol, 100_000_000n);
  assert.equal(result.quote.confMicroUsdPerSol, 50_000n);
  assert.equal(result.quote.ageSeconds, 10);
  assert.equal(result.quote.publishTime, Number(NOW - 10n));
});

test("solPrice: source off refuses before anything is looked at", () => {
  expectRefusal(judgeBuilt({}, { source: "off" }), "source_off");
  expectRefusal(judgeBuilt({}, { source: "off", missing: true, clock: null }), "source_off");
});

test("solPrice: a missing account refuses", () => {
  expectRefusal(judgeBuilt({}, { missing: true }), "account_missing");
});

test("solPrice: an owner that is not an allowed program refuses", () => {
  expectRefusal(judgeBuilt({}, { owner: "11111111111111111111111111111111" }), "wrong_owner");
  expectRefusal(judgeBuilt({}, { rules: { allowedOwners: [] } }), "wrong_owner");
  // A second allowed program is accepted.
  const other = "11111111111111111111111111111111";
  assert.equal(
    judgeBuilt({}, { owner: other, rules: { allowedOwners: [PYTH_RECEIVER_PROGRAM_ID_DEFAULT, other] } }).ok,
    true
  );
});

test("solPrice: another discriminator, or too few bytes, is the wrong account type", () => {
  expectRefusal(judgeBuilt({ discriminatorHex: "0000000000000000" }), "wrong_account_type");
  for (const length of [0, 7, 40, 132]) {
    const result = judgeSolPrice({
      source: "pyth",
      account: { owner: PYTH_RECEIVER_PROGRAM_ID_DEFAULT, data: encodeAccount().subarray(0, length) },
      clockData: encodeClock(NOW),
      rules: DEFAULT_SOL_PRICE_RULES,
    });
    expectRefusal(result, "wrong_account_type");
  }
});

test("solPrice: the Partial tag decodes one byte later and is refused", () => {
  const data = encodeAccount({ tag: 0, numSignatures: 3 });
  const decoded = decodePriceUpdateV2(data);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.update.verification, "partial");
    assert.equal(decoded.update.numSignatures, 3);
    // The shift was applied: every field still reads as written.
    assert.equal(decoded.update.feedIdHex, PYTH_SOL_USD_FEED_ID_DEFAULT);
    assert.equal(decoded.update.price, GOOD.price);
    assert.equal(decoded.update.conf, GOOD.conf);
    assert.equal(decoded.update.exponent, -8);
    assert.equal(decoded.update.publishTime, GOOD.publishTime);
    assert.equal(decoded.update.emaPrice, GOOD.emaPrice);
    assert.equal(decoded.update.postedSlot, GOOD.postedSlot);
  }
  expectRefusal(judgeBuilt({ tag: 0, numSignatures: 3 }), "not_fully_verified");
  // A tag that is neither level cannot be laid out and is refused the same way.
  expectRefusal(judgeBuilt({ tag: 2 }), "not_fully_verified");
});

test("solPrice: another feed id refuses", () => {
  expectRefusal(judgeBuilt({ feedIdHex: "ab".repeat(32) }), "wrong_feed");
  // The setting may be written in capitals or with 0x.
  assert.equal(judgeBuilt({}, { rules: { feedIdHex: `0x${PYTH_SOL_USD_FEED_ID_DEFAULT.toUpperCase()}` } }).ok, true);
  expectRefusal(judgeBuilt({}, { rules: { feedIdHex: "" } }), "wrong_feed");
});

test("solPrice: a price of zero or below refuses", () => {
  expectRefusal(judgeBuilt({ price: 0n }), "bad_price");
  expectRefusal(judgeBuilt({ price: -10_000_000_000n }), "bad_price");
  // Positive on chain but below one micro-dollar.
  expectRefusal(
    judgeBuilt({ price: 999_999n, conf: 0n, emaPrice: 999_999n, exponent: -12 }),
    "bad_price"
  );
});

test("solPrice: an exponent outside -12..0 refuses, the two ends are accepted", () => {
  expectRefusal(judgeBuilt({ exponent: 1 }), "bad_exponent");
  expectRefusal(judgeBuilt({ exponent: -13 }), "bad_exponent");

  const whole = judgeBuilt({ price: 100n, conf: 1n, emaPrice: 100n, exponent: 0 });
  assert.equal(whole.ok, true);
  if (whole.ok) {
    assert.equal(whole.quote.midMicroUsdPerSol, 100_000_000n);
    assert.equal(whole.quote.confMicroUsdPerSol, 1_000_000n);
  }
  const fine = judgeBuilt({
    price: 100_000_000_000_001n,
    conf: 1n,
    emaPrice: 100_000_000_000_000n,
    exponent: -12,
  });
  assert.equal(fine.ok, true);
  if (fine.ok) {
    // The price rounds down, the uncertainty rounds up.
    assert.equal(fine.quote.midMicroUsdPerSol, 100_000_000n);
    assert.equal(fine.quote.confMicroUsdPerSol, 1n);
  }
});

test("solPrice: age is by the chain's clock, refused above the maximum", () => {
  assert.equal(judgeBuilt({ publishTime: NOW - 120n }).ok, true);
  expectRefusal(judgeBuilt({ publishTime: NOW - 121n }), "stale");
  expectRefusal(judgeBuilt({ publishTime: NOW - 31n }, { rules: { maxAgeSeconds: 30 } }), "stale");
  // The same account against a later clock.
  expectRefusal(judgeBuilt({}, { clock: encodeClock(NOW + 200n) }), "stale");
});

test("solPrice: a publish time ahead of the chain's clock by more than 5 seconds refuses", () => {
  const ahead = judgeBuilt({ publishTime: NOW + 5n });
  assert.equal(ahead.ok, true);
  if (ahead.ok) assert.equal(ahead.quote.ageSeconds, 0);
  expectRefusal(judgeBuilt({ publishTime: NOW + 6n }), "clock_skew");
});

test("solPrice: a missing or short clock refuses", () => {
  expectRefusal(judgeBuilt({}, { clock: null }), "clock_missing");
  expectRefusal(judgeBuilt({}, { clock: encodeClock(NOW).subarray(0, 39) }), "clock_missing");
});

test("solPrice: uncertainty above the maximum share of the price refuses", () => {
  // 1% of 10_000_000_000 is 100_000_000.
  assert.equal(judgeBuilt({ conf: 100_000_000n }).ok, true);
  expectRefusal(judgeBuilt({ conf: 100_000_001n }), "too_uncertain");
  expectRefusal(judgeBuilt({ conf: 5_000_001n }, { rules: { maxConfBps: 5 } }), "too_uncertain");
});

test("solPrice: a price too far from its moving average refuses, either side", () => {
  assert.equal(judgeBuilt({ price: 11_000_000_000n }).ok, true);
  expectRefusal(judgeBuilt({ price: 11_000_000_001n }), "off_average");
  assert.equal(judgeBuilt({ price: 9_000_000_000n }).ok, true);
  expectRefusal(judgeBuilt({ price: 8_999_999_999n }), "off_average");
  // An average that is not positive cannot be compared against.
  expectRefusal(judgeBuilt({ emaPrice: 0n }), "off_average");
  expectRefusal(judgeBuilt({ emaPrice: -1n }), "off_average");
});

test("solPrice: a price outside the optional band refuses", () => {
  assert.equal(judgeBuilt({}, { rules: { minMicroUsdPerSol: 100_000_000n, maxMicroUsdPerSol: 100_000_000n } }).ok, true);
  expectRefusal(judgeBuilt({}, { rules: { minMicroUsdPerSol: 100_000_001n } }), "out_of_band");
  expectRefusal(judgeBuilt({}, { rules: { maxMicroUsdPerSol: 99_999_999n } }), "out_of_band");
});

test("solPrice: the judge never throws on bytes that are not an account", () => {
  for (const data of [new Uint8Array(0), new Uint8Array(134), new Uint8Array(1000).fill(255)]) {
    const result = judgeSolPrice({
      source: "pyth",
      account: { owner: PYTH_RECEIVER_PROGRAM_ID_DEFAULT, data },
      clockData: encodeClock(NOW),
      rules: DEFAULT_SOL_PRICE_RULES,
    });
    assert.equal(result.ok, false);
  }
});

test("solPrice: a static quote has no uncertainty, and refuses when not set", () => {
  const quoted = staticSolQuote(150.25, 1_800_000_000.9);
  assert.equal(quoted.ok, true);
  if (quoted.ok) {
    assert.deepEqual(quoted.quote, {
      source: "static",
      midMicroUsdPerSol: 150_250_000n,
      confMicroUsdPerSol: 0n,
      publishTime: 1_800_000_000,
      ageSeconds: 0,
      account: null,
    });
  }
  for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.0000001]) {
    expectRefusal(staticSolQuote(bad, 1_800_000_000), "static_not_set");
  }
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

function quoteOf(mid: bigint, conf: bigint): SolQuote {
  return {
    source: "pyth",
    midMicroUsdPerSol: mid,
    confMicroUsdPerSol: conf,
    publishTime: 1_800_000_000,
    ageSeconds: 1,
    account: PYTH_SOL_USD_ACCOUNT_DEFAULT,
  };
}

function lamports(result: ReturnType<typeof lamportsToCollectForCents>): bigint {
  assert.equal(result.ok, true);
  return result.ok ? result.lamports : -1n;
}

function cents(result: ReturnType<typeof centsToCreditForLamports>): bigint {
  assert.equal(result.ok, true);
  return result.ok ? result.cents : -1n;
}

test("solPrice money: exact amounts at a round price with no uncertainty", () => {
  const q = quoteOf(100_000_000n, 0n); // $100
  assert.equal(lamports(lamportsToCollectForCents(q, 1_000n, 0)), 100_000_000n); // $10 is 0.1 SOL
  assert.equal(lamports(lamportsToSendForCents(q, 1_000n, 0)), 100_000_000n);
  assert.equal(cents(centsToCreditForLamports(q, 100_000_000n, 0)), 1_000n);
});

test("solPrice money: money in values SOL at mid less conf and rounds the lamports up", () => {
  const q = quoteOf(100_000_000n, 1_000_000n); // $100 give or take $1
  // $10 at $99 is 0.10101010... SOL
  assert.equal(lamports(lamportsToCollectForCents(q, 1_000n, 0)), 101_010_102n);
  // One cent at $99 is 101010.10... lamports
  assert.equal(lamports(lamportsToCollectForCents(q, 1n, 0)), 101_011n);
});

test("solPrice money: lamports that arrived are valued at mid less conf and the cents round down", () => {
  const q = quoteOf(100_000_000n, 1_000_000n);
  // 0.1 SOL at $99 is $9.90 exactly
  assert.equal(cents(centsToCreditForLamports(q, 100_000_000n, 0)), 990n);
  // One lamport short of a further cent stays at the lower cent.
  assert.equal(cents(centsToCreditForLamports(q, 101_010_101n, 0)), 999n);
  assert.equal(cents(centsToCreditForLamports(q, 101_010_102n, 0)), 1_000n);
});

test("solPrice money: money out values SOL at mid plus conf and rounds the lamports down", () => {
  const q = quoteOf(100_000_000n, 1_000_000n);
  // $10 at $101 is 0.0990099009... SOL
  assert.equal(lamports(lamportsToSendForCents(q, 1_000n, 0)), 99_009_900n);
});

test("solPrice money: for the same cents, money in asks for at least what money out sends", () => {
  const quotes = [
    quoteOf(100_000_000n, 0n),
    quoteOf(100_000_000n, 1_000_000n),
    quoteOf(110_341_044n, 30_938n),
    quoteOf(3n, 1n),
    quoteOf(987_654_321_987n, 123_456n),
  ];
  for (const q of quotes) {
    for (const amount of [1n, 2n, 99n, 500n, 12_345n, 99_999_999n]) {
      for (const margin of [0, 1, 50, 1000]) {
        const moneyIn = lamportsToCollectForCents(q, amount, margin);
        const moneyOut = lamportsToSendForCents(q, amount, margin);
        if (!moneyIn.ok || !moneyOut.ok) continue;
        assert.ok(
          moneyIn.lamports >= moneyOut.lamports,
          `in ${moneyIn.lamports} is below out ${moneyOut.lamports} for ${amount} cents`
        );
      }
    }
  }
});

test("solPrice money: paying the quoted lamports credits at least the cents asked for, and never a cent more than one over", () => {
  const q = quoteOf(110_341_044n, 30_938n);
  for (const amount of [1n, 7n, 500n, 12_345n, 99_999_999n]) {
    for (const margin of [0, 25, 1000]) {
      const asked = lamports(lamportsToCollectForCents(q, amount, margin));
      const credited = cents(centsToCreditForLamports(q, asked, margin));
      assert.ok(credited >= amount, `${asked} lamports credit ${credited}, below ${amount}`);
      assert.ok(credited <= amount + 1n);
      // One lamport fewer never credits more than was asked for.
      const short = centsToCreditForLamports(q, asked - 1n, margin);
      if (short.ok) assert.ok(short.cents <= amount);
    }
  }
});

test("solPrice money: a margin moves both directions against the customer", () => {
  const q = quoteOf(100_000_000n, 1_000_000n);
  const inPlain = lamports(lamportsToCollectForCents(q, 1_000n, 0));
  const inMargin = lamports(lamportsToCollectForCents(q, 1_000n, 100));
  assert.ok(inMargin > inPlain, "with a margin the customer sends more");
  // $10 at $99 less 1% ($98.01) is 0.1020304050... SOL
  assert.equal(inMargin, 102_030_406n);

  const creditPlain = cents(centsToCreditForLamports(q, 100_000_000n, 0));
  const creditMargin = cents(centsToCreditForLamports(q, 100_000_000n, 100));
  assert.ok(creditMargin < creditPlain, "with a margin a transfer credits less");
  assert.equal(creditMargin, 980n);

  const outPlain = lamports(lamportsToSendForCents(q, 1_000n, 0));
  const outMargin = lamports(lamportsToSendForCents(q, 1_000n, 100));
  assert.ok(outMargin < outPlain, "with a margin we send less");
  // $10 at $101 plus 1% ($102.01) is 0.0980296049... SOL
  assert.equal(outMargin, 98_029_604n);
});

test("solPrice money: the figure to show leans the same way as the amounts", () => {
  const q = quoteOf(100_000_000n, 1_000_000n);
  assert.deepEqual(solUsdRate(q, "in", 0), { ok: true, usdPerSol: 99 });
  assert.deepEqual(solUsdRate(q, "out", 0), { ok: true, usdPerSol: 101 });
  assert.deepEqual(solUsdRate(q, "in", 100), { ok: true, usdPerSol: 98.01 });
  assert.deepEqual(solUsdRate(q, "out", 100), { ok: true, usdPerSol: 102.01 });
});

test("solPrice money: nothing answers with zero or a negative amount", () => {
  const q = quoteOf(100_000_000n, 1_000_000n);

  // Amounts that are not above zero.
  for (const amount of [0n, -1n, -1_000n]) {
    assert.deepEqual(lamportsToCollectForCents(q, amount, 0), { ok: false, code: "bad_amount" });
    assert.deepEqual(centsToCreditForLamports(q, amount, 0), { ok: false, code: "bad_amount" });
    assert.deepEqual(lamportsToSendForCents(q, amount, 0), { ok: false, code: "bad_amount" });
  }
  // A number where a bigint belongs is refused, not coerced.
  assert.deepEqual(lamportsToCollectForCents(q, 100 as unknown as bigint, 0), { ok: false, code: "bad_amount" });

  // Margins that are not whole basis points in 0..9999.
  for (const margin of [-1, 0.5, 10_000, 20_000, Number.NaN]) {
    assert.deepEqual(lamportsToCollectForCents(q, 100n, margin), { ok: false, code: "bad_margin" });
    assert.deepEqual(centsToCreditForLamports(q, 100n, margin), { ok: false, code: "bad_margin" });
    assert.deepEqual(lamportsToSendForCents(q, 100n, margin), { ok: false, code: "bad_margin" });
    assert.deepEqual(solUsdRate(q, "in", margin), { ok: false, code: "bad_margin" });
  }

  // A quote whose uncertainty swallows the price is worth nothing coming in:
  // no division by zero, no negative lamports.
  for (const worthless of [quoteOf(100n, 100n), quoteOf(100n, 250n), quoteOf(0n, 0n), quoteOf(-5n, 0n)]) {
    assert.deepEqual(lamportsToCollectForCents(worthless, 100n, 0), { ok: false, code: "no_value" });
    assert.deepEqual(centsToCreditForLamports(worthless, 100n, 0), { ok: false, code: "no_value" });
    assert.deepEqual(solUsdRate(worthless, "in", 0), { ok: false, code: "no_value" });
  }
  assert.deepEqual(lamportsToSendForCents(quoteOf(0n, 0n), 100n, 0), { ok: false, code: "no_value" });
  assert.deepEqual(lamportsToSendForCents(quoteOf(100n, -200n), 100n, 0), { ok: false, code: "no_value" });

  // Answers that would round to zero refuse instead.
  assert.deepEqual(centsToCreditForLamports(q, 1n, 0), { ok: false, code: "rounds_to_zero" });
  assert.deepEqual(centsToCreditForLamports(q, 101_010n, 0), { ok: false, code: "rounds_to_zero" });
  assert.equal(cents(centsToCreditForLamports(q, 101_011n, 0)), 1n);
  const dear = quoteOf(100_000_000_000_000_000n, 0n); // one cent is under a lamport
  assert.deepEqual(lamportsToSendForCents(dear, 1n, 0), { ok: false, code: "rounds_to_zero" });
  // Money in at the same price still asks for one whole lamport.
  assert.equal(lamports(lamportsToCollectForCents(dear, 1n, 0)), 1n);

  // Every answer that is given is above zero.
  for (const amount of [1n, 3n, 1_000_000n]) {
    for (const margin of [0, 999, 9_999]) {
      for (const result of [lamportsToCollectForCents(q, amount, margin), lamportsToSendForCents(q, amount, margin)]) {
        if (result.ok) assert.ok(result.lamports > 0n);
      }
      const credit = centsToCreditForLamports(q, amount, margin);
      if (credit.ok) assert.ok(credit.cents > 0n);
    }
  }
});

test("solPrice money: lamports for micro-dollars at a fixed rate round up, and refuse what is not above zero", () => {
  // $0.000549 at $100 a SOL is 5,490 lamports exactly; at $99 it is 5,545.45..., so 5,546.
  assert.deepEqual(lamportsForMicroUsdAtRate(549n, 100_000_000n), { ok: true, lamports: 5_490n });
  assert.deepEqual(lamportsForMicroUsdAtRate(549n, 99_000_000n), { ok: true, lamports: 5_546n });
  // One micro-dollar at a very dear SOL still asks for one whole lamport.
  assert.deepEqual(lamportsForMicroUsdAtRate(1n, 10n ** 18n), { ok: true, lamports: 1n });
  // The same answer as the cents helper at the rate solMicroUsdRate gives (no margin: the rate is exact).
  const q = quoteOf(100_000_000n, 1_000_000n);
  assert.equal(lamports(lamportsForMicroUsdAtRate(10_000n, 99_000_000n)), lamports(lamportsToCollectForCents(q, 1n, 0)));

  for (const bad of [0n, -1n, 100 as unknown as bigint]) {
    assert.deepEqual(lamportsForMicroUsdAtRate(bad, 100_000_000n), { ok: false, code: "bad_amount" });
    assert.deepEqual(lamportsForMicroUsdAtRate(549n, bad), { ok: false, code: "no_value" });
  }
});

test("solPrice: the pure core imports nothing, so neither settings nor a connection", () => {
  const source = readFileSync(new URL("../services/solPrice.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false, "solPrice.ts has an import");
  assert.equal(/\brequire\(|\bimport\(/.test(source), false, "solPrice.ts loads a module");
  assert.equal(/process\.env/.test(source), false, "solPrice.ts reads the environment");
});

test("solPrice: refusals come in the listed order when several rules are broken at once", () => {
  // A bad price that is also stale, uncertain and off its average.
  expectRefusal(
    judgeBuilt({ price: 0n, publishTime: NOW - 500n, conf: 9_000_000_000n, emaPrice: 1n }),
    "bad_price"
  );
  // Stale comes before the uncertainty and the average.
  expectRefusal(judgeBuilt({ publishTime: NOW - 500n, conf: 9_000_000_000n, emaPrice: 1n }), "stale");
  expectRefusal(judgeBuilt({ conf: 9_000_000_000n, emaPrice: 1n }), "too_uncertain");
  // The wrong owner is refused before its bytes are looked at.
  expectRefusal(
    judgeBuilt({ discriminatorHex: "0000000000000000" }, { owner: "11111111111111111111111111111111" }),
    "wrong_owner"
  );
});
