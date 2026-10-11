/**
 * Drives apps/api/src/services/x402Price.ts: what one x402 request costs.
 *
 * Pinning:
 *   - the price is a bigint of micro-dollars from the same table, the same
 *     +20% estimate and the same minimum as before, and it matches the old
 *     float formula to the micro-dollar wherever that formula was exact;
 *   - USDC base units are the micro-dollars; lamports round up at the rate
 *     handed in; SOL has no price without a rate;
 *   - no float decides an amount.
 *
 * No network: the module under test is pure and imports no settings.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./unitEnv.js";
import { PRICING_TIERS } from "@wheelsai/shared";

import {
  X402_MIN_CHARGE_MICRO_USD,
  X402_PRICE_MICRO_USD_PER_1K,
  microUsdToUsd,
  priceMicroUsd,
  x402PriceFor,
  type X402ModelTier,
} from "../services/x402Price.js";

const TIERS: X402ModelTier[] = ["small", "medium", "large"];

/** The formula x402 priced by before this file: floats throughout. */
function oldFloatPriceMicroUsd(inputTokens: number, outputTokens: number, tier: X402ModelTier): bigint {
  const pricing = PRICING_TIERS[tier];
  const input = Math.ceil(inputTokens * 1.2);
  const output = Math.ceil(outputTokens * 1.2);
  const usd = Math.max((input / 1000) * pricing.inputPer1k + (output / 1000) * pricing.outputPer1k, 0.0001);
  return BigInt(Math.ceil(usd * 1_000_000));
}

function price(tier: X402ModelTier, input: number, output: number): bigint {
  return priceMicroUsd({ modelTier: tier, estimatedInputTokens: input, estimatedOutputTokens: output });
}

test("x402Price: the table is the shared pricing table, in whole micro-dollars", () => {
  for (const tier of TIERS) {
    assert.equal(Number(X402_PRICE_MICRO_USD_PER_1K[tier].input), Math.round(PRICING_TIERS[tier].inputPer1k * 1e6));
    assert.equal(Number(X402_PRICE_MICRO_USD_PER_1K[tier].output), Math.round(PRICING_TIERS[tier].outputPer1k * 1e6));
  }
  assert.deepEqual(Object.keys(X402_PRICE_MICRO_USD_PER_1K).sort(), Object.keys(PRICING_TIERS).sort());
  assert.equal(X402_MIN_CHARGE_MICRO_USD, 100n); // $0.0001
});

test("x402Price: known prices, each a bigint", () => {
  // 1,000 and 512 tokens become 1,200 and 615 with the fifth added.
  // small: 1.2 * 150 + 0.615 * 600 = 180 + 369 = 549
  assert.equal(price("small", 1_000, 512), 549n);
  assert.equal(price("medium", 1_000, 512), 1_098n);
  assert.equal(price("large", 1_000, 512), 3_294n);
  // The largest answer the route estimates: 8,192 tokens become 9,831.
  assert.equal(price("large", 10, 8_192), 35_403n);
  assert.equal(price("large", 100_000, 8_192), 143_392n);
  assert.equal(typeof price("small", 1, 1), "bigint");
});

test("x402Price: the minimum charge, and the first price above it", () => {
  assert.equal(price("small", 0, 0), 100n);
  assert.equal(price("small", 0, 64), 100n); // 77 tokens * 0.6 = 46.2
  assert.equal(price("small", 100, 64), 100n); // 18 + 46.2 = 64.2
  // small, no prompt: 139 output tokens become 167, 100.2 micro-dollars, so 101.
  assert.equal(price("small", 0, 138), 100n); // 166 tokens: 99.6
  assert.equal(price("small", 0, 139), 101n);
  // large never sits on the minimum at the route's smallest answer of 64 tokens.
  assert.equal(price("large", 0, 64), 278n); // 77 * 3.6 = 277.2
});

test("x402Price: a part of a micro-dollar rounds up, a whole one stays", () => {
  // medium: 1,000 output tokens become 1,200: exactly 1,440.
  assert.equal(price("medium", 0, 1_000), 1_440n);
  // one token more becomes 1,202 (1,201.2 rounded up): 1,442.4, so 1,443.
  assert.equal(price("medium", 0, 1_001), 1_443n);
  // The fifth is added in whole numbers: 5 tokens are 6, not 7.
  assert.equal(price("large", 5_000, 5), price("large", 5_000, 0) + 22n); // 6 * 3.6 = 21.6
});

test("x402Price: matches the old float formula to the micro-dollar, and is never above it", () => {
  // Where the old formula was exact the two agree. Where a float carried
  // dust above a whole micro-dollar (0.000549000000001), the old formula
  // rounded that dust up to one micro-dollar more; the whole-number price
  // does not. It is never the other way round.
  const points: [number, number][] = [
    [0, 64], [1, 64], [100, 64], [1_000, 512], [2_000, 1_000], [10, 8_192], [100_000, 8_192], [333, 777],
  ];
  for (const tier of TIERS) {
    for (const [input, output] of points) {
      assert.equal(price(tier, input, output), oldFloatPriceMicroUsd(input, output, tier), `${tier} ${input} ${output}`);
    }
  }
  let compared = 0;
  let same = 0;
  for (const tier of TIERS) {
    for (let input = 0; input <= 3_000; input += 7) {
      for (const output of [64, 65, 100, 256, 512, 1_000, 4_096, 8_192]) {
        const now = price(tier, input, output);
        const before = oldFloatPriceMicroUsd(input, output, tier);
        assert.ok(now <= before && before - now <= 1n, `${tier} ${input} ${output}: ${now} against ${before}`);
        compared += 1;
        if (now === before) same += 1;
      }
    }
  }
  assert.ok(same * 100 >= compared * 99, `${same} of ${compared} agree`);
});

test("x402Price: a request that cannot be priced is not given a price", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2 ** 60]) {
    assert.throws(() => price("small", bad, 64), RangeError);
    assert.throws(() => price("small", 64, bad), RangeError);
  }
  assert.throws(() => price("huge" as X402ModelTier, 1, 1), RangeError);
  assert.throws(() => price("toString" as X402ModelTier, 1, 1), RangeError);
  // A part of a token counts as a token.
  assert.equal(price("large", 0, 999.5), price("large", 0, 1_000));
});

test("x402Price: USDC base units are the micro-dollars, exactly", () => {
  assert.deepEqual(x402PriceFor({ microUsd: 549n, asset: "USDC", solRateMicroUsdPerSol: null }), {
    asset: "USDC",
    amountMicroUsd: 549n,
    amountRaw: 549n,
    solMicroUsdPerSol: null,
  });
  // A rate handed in with USDC is not looked at and not recorded.
  assert.deepEqual(x402PriceFor({ microUsd: 100n, asset: "USDC", solRateMicroUsdPerSol: 150_000_000n }), {
    asset: "USDC",
    amountMicroUsd: 100n,
    amountRaw: 100n,
    solMicroUsdPerSol: null,
  });
});

test("x402Price: lamports are the micro-dollars at the rate, rounded up", () => {
  // $0.000549 at $100 a SOL is 5,490 lamports exactly.
  assert.deepEqual(x402PriceFor({ microUsd: 549n, asset: "SOL", solRateMicroUsdPerSol: 100_000_000n }), {
    asset: "SOL",
    amountMicroUsd: 549n,
    amountRaw: 5_490n,
    solMicroUsdPerSol: 100_000_000n,
  });
  // At $99: 5,545.4545... lamports, so 5,546.
  assert.equal(x402PriceFor({ microUsd: 549n, asset: "SOL", solRateMicroUsdPerSol: 99_000_000n }).amountRaw, 5_546n);
  // The minimum at $150: 666.66... lamports, so 667.
  assert.equal(x402PriceFor({ microUsd: 100n, asset: "SOL", solRateMicroUsdPerSol: 150_000_000n }).amountRaw, 667n);
  // The lamports asked for are always worth at least the price at that rate.
  for (const rate of [1n, 7n, 99_000_000n, 143_217_654n, 10n ** 15n]) {
    for (const microUsd of [100n, 101n, 549n, 143_392n]) {
      const lamports = x402PriceFor({ microUsd, asset: "SOL", solRateMicroUsdPerSol: rate }).amountRaw;
      assert.ok(lamports > 0n);
      assert.ok(lamports * rate >= microUsd * 1_000_000_000n);
      assert.ok((lamports - 1n) * rate < microUsd * 1_000_000_000n);
    }
  }
});

test("x402Price: SOL has no price without a rate, and nothing is priced at zero", () => {
  assert.throws(() => x402PriceFor({ microUsd: 549n, asset: "SOL", solRateMicroUsdPerSol: null }), RangeError);
  assert.throws(() => x402PriceFor({ microUsd: 549n, asset: "SOL" }), RangeError);
  assert.throws(() => x402PriceFor({ microUsd: 549n, asset: "SOL", solRateMicroUsdPerSol: 0n }), RangeError);
  assert.throws(() => x402PriceFor({ microUsd: 549n, asset: "SOL", solRateMicroUsdPerSol: -5n }), RangeError);
  assert.throws(
    () => x402PriceFor({ microUsd: 549n, asset: "SOL", solRateMicroUsdPerSol: 150 as unknown as bigint }),
    RangeError
  );
  for (const asset of ["USDC", "SOL"] as const) {
    assert.throws(() => x402PriceFor({ microUsd: 0n, asset, solRateMicroUsdPerSol: 1n }), RangeError);
    assert.throws(() => x402PriceFor({ microUsd: -1n, asset, solRateMicroUsdPerSol: 1n }), RangeError);
    assert.throws(() => x402PriceFor({ microUsd: 549 as unknown as bigint, asset, solRateMicroUsdPerSol: 1n }), RangeError);
  }
  assert.throws(() => x402PriceFor({ microUsd: 549n, asset: "NOS" as "SOL", solRateMicroUsdPerSol: 1n }), RangeError);
});

test("x402Price: the dollars to show", () => {
  assert.equal(microUsdToUsd(549n), 0.000549);
  assert.equal(microUsdToUsd(100n), 0.0001);
});

test("x402Price: no float, no constant price and no settings where an amount is decided", () => {
  const source = readFileSync(new URL("../services/x402Price.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  // The one float is the figure to show.
  const withoutDisplay = code.replace(/export function microUsdToUsd[\s\S]*?\n}\n/, "");
  assert.equal(/\d\.\d/.test(withoutDisplay), false, "a decimal literal");
  assert.equal(/Math\.(round|floor|max|min)|parseFloat|toFixed/.test(withoutDisplay), false, "float arithmetic");
  assert.equal(/Number\(/.test(withoutDisplay), false, "a bigint turned into a number");
  assert.equal(/process\.env|config\/env|priceOracle|lib\/solana/.test(source), false, "settings, a price feed or a connection");
});
