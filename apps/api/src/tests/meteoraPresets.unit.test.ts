import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PRESET_ID,
  PRESET_POINT_COUNT,
  assertPresetCurveIsValid,
  buildPresetCurve,
  describePreset,
  isPresetOffered,
  listPresets,
  presetGraduationLamports,
  presetSupplySplit,
  sampleCurvePoints,
} from "../services/launchpad/meteoraPresets.js";

// Drives services/launchpad/meteoraPresets.ts: the four curves a creator
// can pick from. Pure: the SDK's builder and math run here, no network.
//
// The numbers below are the lead's, fixed in the approved plan. A change to
// a preset must fail here first, so it is a decision somebody made and not
// a slip.

const ALL = ["community", "committed", "long", "rehearsal"] as const;

// ============================================
// The four graduation numbers
// ============================================

const RAISED_AT_GRADUATION: Record<(typeof ALL)[number], { shown: string; threeDecimals: string }> = {
  community: { shown: "64", threeDecimals: "64.000" },
  committed: { shown: "77.395", threeDecimals: "77.395" },
  long: { shown: "173.607", threeDecimals: "173.607" },
  rehearsal: { shown: "0.348", threeDecimals: "0.348" },
};

for (const id of ALL) {
  test(`${id} graduates at ${RAISED_AT_GRADUATION[id].threeDecimals} SOL raised`, () => {
    const lamports = presetGraduationLamports(id);
    assert.equal(
      (Number(lamports) / 1e9).toFixed(3),
      RAISED_AT_GRADUATION[id].threeDecimals,
    );
    assert.equal(describePreset(id).raisedAtGraduationSol, RAISED_AT_GRADUATION[id].shown);
  });
}

// ============================================
// The SDK accepts every preset
// ============================================

for (const id of ALL) {
  test(`${id} passes the SDK's own validation of a config`, () => {
    assert.doesNotThrow(() => assertPresetCurveIsValid(id));
  });
}

test("what all four share is what goes on chain", () => {
  for (const id of ALL) {
    const curve = buildPresetCurve(id);
    assert.equal(curve.tokenType, 0, "an SPL token");
    assert.equal(curve.tokenDecimal, 6);
    assert.equal(curve.tokenUpdateAuthority, 1, "immutable");
    assert.equal(curve.collectFeeMode, 0, "fees are taken in SOL");
    assert.equal(curve.activationType, 1, "by timestamp");
    assert.equal(curve.migrationOption, 1, "graduates into DAMM v2");
    assert.equal(curve.migrationFeeOption, 2, "the fixed 1% pool");
    assert.deepEqual(curve.migrationFee, { feePercentage: 0, creatorFeePercentage: 0 });
    assert.equal(curve.poolCreationFee.toString(), "0");
    assert.equal(curve.enableFirstSwapWithMinFee, false);
    assert.equal(curve.poolFees.baseFee.baseFeeMode, 1, "the fee falls exponentially");
    assert.ok(curve.poolFees.dynamicFee, "the dynamic fee is on");
    // All of the graduated pool's liquidity is locked for good.
    assert.equal(curve.partnerPermanentLockedLiquidityPercentage, 50);
    assert.equal(curve.creatorPermanentLockedLiquidityPercentage, 50);
    assert.equal(curve.partnerLiquidityPercentage, 0);
    assert.equal(curve.creatorLiquidityPercentage, 0);
    // 1,000,000,000 tokens of 6 decimals, before and after graduation.
    assert.equal(curve.tokenSupply?.preMigrationTokenSupply.toString(), "1000000000000000");
    assert.equal(curve.tokenSupply?.postMigrationTokenSupply.toString(), "1000000000000000");
  }
});

test("the creator's share of fees is the preset's", () => {
  assert.equal(buildPresetCurve("community").creatorTradingFeePercentage, 70);
  assert.equal(buildPresetCurve("committed").creatorTradingFeePercentage, 50);
  assert.equal(buildPresetCurve("long").creatorTradingFeePercentage, 50);
  assert.equal(buildPresetCurve("rehearsal").creatorTradingFeePercentage, 50);
});

test("the fee each preset starts at, and the steps it falls in, are what goes on chain", () => {
  // The chain counts a fee in parts of 1,000,000,000: 30% is 300,000,000.
  // firstFactor is the number of steps and secondFactor the seconds in one.
  const expected: Record<(typeof ALL)[number], { start: string; steps: number; secondsEach: number }> = {
    community: { start: "300000000", steps: 30, secondsEach: 10 },
    committed: { start: "300000000", steps: 30, secondsEach: 10 },
    long: { start: "200000000", steps: 60, secondsEach: 10 },
    rehearsal: { start: "50000000", steps: 12, secondsEach: 10 },
  };
  for (const id of ALL) {
    const baseFee = buildPresetCurve(id).poolFees.baseFee;
    assert.equal(baseFee.cliffFeeNumerator.toString(), expected[id].start, `${id} starting fee`);
    assert.equal(Number(baseFee.firstFactor), expected[id].steps, `${id} steps`);
    assert.equal(Number(baseFee.secondFactor.toString()), expected[id].secondsEach, `${id} seconds a step`);
  }
});

test("the creator's locked tokens reach the chain whole: nothing at the end of the wait, then equal parts", () => {
  const expected: Record<string, { raw: bigint; cliff: number; periods: number; every: number; each: bigint } | null> = {
    community: null,
    committed: { raw: 100_000_000n * 1_000_000n, cliff: 30 * 86_400, periods: 10, every: 30 * 86_400, each: 10_000_000n * 1_000_000n },
    long: { raw: 50_000_000n * 1_000_000n, cliff: 30 * 86_400, periods: 20, every: 30 * 86_400, each: 2_500_000n * 1_000_000n },
    rehearsal: { raw: 100_000_000n * 1_000_000n, cliff: 600, periods: 5, every: 600, each: 20_000_000n * 1_000_000n },
  };
  for (const id of ALL) {
    const vesting = buildPresetCurve(id).lockedVesting;
    const perPeriod = BigInt(vesting.amountPerPeriod.toString());
    const periods = BigInt(vesting.numberOfPeriod.toString());
    const atCliff = BigInt(vesting.cliffUnlockAmount.toString());
    // Nothing is released when the wait ends, for any preset: the builder
    // would put what does not divide evenly there, and nothing is left over.
    assert.equal(atCliff, 0n, `${id}: nothing at the end of the wait`);
    const want = expected[id];
    if (!want) {
      assert.equal(perPeriod * periods, 0n, `${id} locks nothing`);
      continue;
    }
    assert.equal(perPeriod, want.each, `${id}: each part`);
    assert.equal(perPeriod * periods, want.raw, `${id} total`);
    assert.equal(Number(periods), want.periods);
    assert.equal(Number(vesting.cliffDurationFromMigrationTime.toString()), want.cliff);
    assert.equal(Number(vesting.frequency.toString()), want.every);
  }
});

test("the supply split of each preset comes from its curve and adds up to the supply", () => {
  // Whole tokens the curve sells before it is full, as the builder's curve
  // gives them (the SDK's getBaseTokenForSwap from the start price to the
  // price at the threshold), and the rest of the 1,000,000,000.
  const expected: Record<(typeof ALL)[number], bigint> = {
    community: 799_999_986n,
    committed: 706_513_339n,
    long: 776_393_195n,
    rehearsal: 621_884_518n,
  };
  for (const id of ALL) {
    const split = presetSupplySplit(id);
    assert.equal(split.curveSupply, expected[id], `${id}: sold on the curve`);
    assert.equal(split.curveSupply + split.reservedSupply, 1_000_000_000n, `${id}: adds up`);
    // The drawing's last point is the same share of the supply.
    const lastPoint = describePreset(id).points[23]!.soldPercent;
    assert.ok(Math.abs(Number(split.curveSupply) / 1e7 - lastPoint) < 0.001, `${id}: agrees with the drawing`);
  }
  assert.throws(() => presetSupplySplit("nope"), /unknown_preset/);
});

// ============================================
// Which presets are offered where
// ============================================

test("rehearsal is offered on devnet only", () => {
  assert.deepEqual(
    listPresets("devnet").map((preset) => preset.id),
    ["community", "committed", "long", "rehearsal"],
  );
  assert.deepEqual(
    listPresets("mainnet-beta").map((preset) => preset.id),
    ["community", "committed", "long"],
  );
  assert.equal(isPresetOffered("rehearsal", "devnet"), true);
  assert.equal(isPresetOffered("rehearsal", "mainnet-beta"), false);
  assert.equal(isPresetOffered("community", "mainnet-beta"), true);
  assert.equal(isPresetOffered("nope", "devnet"), false);
});

test("the default preset is community, and it is offered everywhere", () => {
  assert.equal(DEFAULT_PRESET_ID, "community");
  assert.equal(isPresetOffered(DEFAULT_PRESET_ID, "mainnet-beta"), true);
});

test("an id that is not a preset is refused, not guessed", () => {
  assert.throws(() => buildPresetCurve("nope"), /unknown_preset/);
  assert.throws(() => describePreset("nope"), /unknown_preset/);
});

// ============================================
// What the wizard shows
// ============================================

test("community as the wizard shows it", () => {
  const { points, summary, ...rest } = describePreset("community");
  assert.deepEqual(rest, {
    id: "community",
    name: "Community",
    startValueSol: "20",
    graduationValueSol: "320",
    raisedAtGraduationSol: "64",
    fee: { startPercent: "30", endPercent: "1", seconds: 300 },
    creatorFeeSharePercent: 70,
    creatorLocked: null,
    liquidityLockedPercent: 100,
  });
  assert.ok(summary.length > 0);
  assert.equal(points.length, PRESET_POINT_COUNT);
});

test("the other three: fee, share and what is locked", () => {
  const committed = describePreset("committed");
  assert.equal(committed.name, "Committed creator");
  assert.deepEqual(committed.fee, { startPercent: "30", endPercent: "1", seconds: 300 });
  assert.equal(committed.creatorFeeSharePercent, 50);
  assert.deepEqual(committed.creatorLocked, {
    percentOfSupply: "10",
    cliffSeconds: 2_592_000,
    periods: 10,
    totalSeconds: 25_920_000,
  });

  const long = describePreset("long");
  assert.equal(long.name, "Long runway");
  assert.equal(long.startValueSol, "50");
  assert.equal(long.graduationValueSol, "1000");
  assert.deepEqual(long.fee, { startPercent: "20", endPercent: "0.5", seconds: 600 });
  assert.deepEqual(long.creatorLocked, {
    percentOfSupply: "5",
    cliffSeconds: 2_592_000,
    periods: 20,
    totalSeconds: 51_840_000,
  });

  const rehearsal = describePreset("rehearsal");
  assert.equal(rehearsal.name, "Devnet rehearsal");
  assert.equal(rehearsal.startValueSol, "0.25");
  assert.equal(rehearsal.graduationValueSol, "1.25");
  assert.deepEqual(rehearsal.fee, { startPercent: "5", endPercent: "1", seconds: 120 });
  assert.deepEqual(rehearsal.creatorLocked, {
    percentOfSupply: "10",
    cliffSeconds: 600,
    periods: 5,
    totalSeconds: 3000,
  });
});

test("every summary is one plain sentence", () => {
  for (const id of ALL) {
    const { summary } = describePreset(id);
    assert.ok(summary.endsWith("."), id);
    assert.equal(summary.split(". ").length, 1, `${id}: one sentence`);
    // Code points 0x2014 and 0x2013 are the long and the short dash.
    const dashes = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];
    assert.ok(
      !dashes.some((dash) => summary.includes(dash)) && !summary.includes("!"),
      `${id}: no dashes, no exclamation marks`,
    );
  }
});

test("the points run from the start price to the graduation price, always upward", () => {
  const supply = 1_000_000_000;
  for (const id of ALL) {
    const preset = describePreset(id);
    const { points } = preset;
    assert.equal(points.length, 24, id);

    const first = points[0]!;
    const last = points[points.length - 1]!;
    assert.equal(first.soldPercent, 0, `${id} starts with nothing sold`);
    // The price of one token is the value of the whole supply over the supply.
    const startPrice = Number(preset.startValueSol) / supply;
    const endPrice = Number(preset.graduationValueSol) / supply;
    assert.ok(Math.abs(first.priceSol - startPrice) / startPrice < 1e-6, `${id} start price`);
    assert.ok(Math.abs(last.priceSol - endPrice) / endPrice < 1e-6, `${id} end price`);

    for (let index = 1; index < points.length; index += 1) {
      assert.ok(points[index]!.priceSol > points[index - 1]!.priceSol, `${id} price rises`);
      assert.ok(points[index]!.soldPercent > points[index - 1]!.soldPercent, `${id} sold rises`);
    }
    assert.ok(last.soldPercent > 0 && last.soldPercent < 100, `${id}: a share of the supply`);
  }
});

test("soldPercent is a share of the whole supply, not of what is for sale", () => {
  // From a value of 20 SOL to 320 SOL the price rises 16 times, and a
  // constant-product curve has then sold 80% of the supply when nothing is
  // kept back. With a tenth locked for the creator, less is sold.
  assert.equal(describePreset("community").points[23]!.soldPercent, 80);
  assert.ok(describePreset("committed").points[23]!.soldPercent < 80);
});

test("a description is the same every time it is asked for", () => {
  assert.deepEqual(describePreset("long"), describePreset("long"));
});

// ============================================
// The same drawing for a config read from the chain
// ============================================

test("sampleCurvePoints gives a preset's points, and the same for a curve padded with zeros", () => {
  for (const id of ALL) {
    const built = buildPresetCurve(id);
    const points = describePreset(id).points;
    assert.deepEqual(sampleCurvePoints(built), points, `${id}: from the builder`);

    // The chain keeps a curve in 20 slots and leaves the unused ones at zero.
    const zero = built.sqrtStartPrice.sub(built.sqrtStartPrice);
    const padded = [...built.curve];
    while (padded.length < 20) padded.push({ sqrtPrice: zero, liquidity: zero });
    assert.ok(padded.length > built.curve.length, `${id}: the padding added something`);
    assert.deepEqual(
      sampleCurvePoints({
        sqrtStartPrice: built.sqrtStartPrice,
        migrationQuoteThreshold: built.migrationQuoteThreshold,
        curve: padded,
      }),
      points,
      `${id}: padded as the chain pads it`,
    );
  }
});
