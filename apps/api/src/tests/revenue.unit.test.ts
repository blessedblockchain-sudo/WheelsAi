/**
 * What a creator gets, as the web works it out (packages/shared/src/revenue.ts).
 *
 * What is pinned here: splitCents gives the same three numbers as the API's
 * splitRevenue (services/marketplaceMetering.ts) at every whole amount from
 * 1 to 10,000 cents, so a screen never shows a creator an amount the ledger
 * will not pay; and the inputs the API would never be given are tidied the
 * way the doc comment says.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PLATFORM_FEE_PERCENT, splitCents } from "@wheelsai/shared/revenue";

import { PLATFORM_FEE_BPS, splitRevenue } from "../services/marketplaceMetering.js";

describe("splitCents", () => {
  it("equals splitRevenue for every whole amount from 1 to 10,000 cents", () => {
    for (let cents = 1; cents <= 10_000; cents++) {
      const api = splitRevenue(BigInt(cents), 1);
      const shared = splitCents(cents);
      assert.equal(BigInt(shared.grossCents), api.grossCents, `gross at ${cents}`);
      assert.equal(BigInt(shared.platformFeeCents), api.platformFeeCents, `fee at ${cents}`);
      assert.equal(BigInt(shared.creatorCents), api.creatorCents, `creator at ${cents}`);
      assert.equal(shared.platformFeeCents + shared.creatorCents, cents);
    }
  });

  it("states the same percentage the API charges", () => {
    assert.equal(BigInt(PLATFORM_FEE_PERCENT) * 100n, PLATFORM_FEE_BPS);
  });

  it("rounds the platform's part half up, and the creator gets the rest", () => {
    assert.deepEqual(splitCents(4), { grossCents: 4, platformFeeCents: 0, creatorCents: 4 });
    // The smallest price per use: 0.5 of a cent rounds up, so 4, not 4.5.
    assert.deepEqual(splitCents(5), { grossCents: 5, platformFeeCents: 1, creatorCents: 4 });
    assert.deepEqual(splitCents(14), { grossCents: 14, platformFeeCents: 1, creatorCents: 13 });
    assert.deepEqual(splitCents(15), { grossCents: 15, platformFeeCents: 2, creatorCents: 13 });
    assert.deepEqual(splitCents(100), { grossCents: 100, platformFeeCents: 10, creatorCents: 90 });
    assert.deepEqual(splitCents(999), { grossCents: 999, platformFeeCents: 100, creatorCents: 899 });
  });

  it("splits nothing as nothing", () => {
    assert.deepEqual(splitCents(0), { grossCents: 0, platformFeeCents: 0, creatorCents: 0 });
    const minusZero = splitCents(-0);
    assert.equal(Object.is(minusZero.grossCents, 0), true);
    assert.equal(Object.is(minusZero.platformFeeCents, 0), true);
    assert.equal(Object.is(minusZero.creatorCents, 0), true);
  });

  it("treats an amount that is not a number, or is infinite, as nothing", () => {
    const nothing = { grossCents: 0, platformFeeCents: 0, creatorCents: 0 };
    assert.deepEqual(splitCents(Number.NaN), nothing);
    assert.deepEqual(splitCents(Number.POSITIVE_INFINITY), nothing);
    assert.deepEqual(splitCents(Number.NEGATIVE_INFINITY), nothing);
    // What a caller without types might pass.
    assert.deepEqual(splitCents(undefined as unknown as number), nothing);
    assert.deepEqual(splitCents(null as unknown as number), nothing);
    assert.deepEqual(splitCents("500" as unknown as number), nothing);
  });

  it("treats a negative amount as nothing", () => {
    const nothing = { grossCents: 0, platformFeeCents: 0, creatorCents: 0 };
    assert.deepEqual(splitCents(-1), nothing);
    assert.deepEqual(splitCents(-0.4), nothing);
    assert.deepEqual(splitCents(-10_000), nothing);
  });

  it("splits a fractional amount as the nearest whole cent, a half going up", () => {
    for (const [given, whole] of [
      [4.4, 4],
      [4.5, 5],
      [4.6, 5],
      [0.4, 0],
      [0.5, 1],
      [99.999, 100],
      [1234.49, 1234],
    ] as const) {
      const api = splitRevenue(BigInt(whole), 1);
      assert.deepEqual(
        splitCents(given),
        {
          grossCents: whole,
          platformFeeCents: Number(api.platformFeeCents),
          creatorCents: Number(api.creatorCents),
        },
        `at ${given}`,
      );
    }
  });

  it("stays exact at large amounts, and stops at the largest safe whole number", () => {
    for (const cents of [
      10_001,
      123_456_789,
      99_999_999_995,
      9_007_199_254_740_985,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const api = splitRevenue(BigInt(cents), 1);
      const shared = splitCents(cents);
      assert.equal(BigInt(shared.platformFeeCents), api.platformFeeCents, `fee at ${cents}`);
      assert.equal(BigInt(shared.creatorCents), api.creatorCents, `creator at ${cents}`);
      assert.equal(Number.isSafeInteger(shared.platformFeeCents), true);
      assert.equal(Number.isSafeInteger(shared.creatorCents), true);
    }
    assert.deepEqual(splitCents(1e300), splitCents(Number.MAX_SAFE_INTEGER));
    assert.equal(splitCents(1e300).grossCents, Number.MAX_SAFE_INTEGER);
  });

  it("always gives whole cents that add up", () => {
    for (const given of [1, 5, 7.5, 333, 1e6 + 0.5, 2 ** 40 + 5]) {
      const { grossCents, platformFeeCents, creatorCents } = splitCents(given);
      assert.equal(Number.isInteger(grossCents), true);
      assert.equal(Number.isInteger(platformFeeCents), true);
      assert.equal(Number.isInteger(creatorCents), true);
      assert.equal(platformFeeCents + creatorCents, grossCents);
    }
  });
});
