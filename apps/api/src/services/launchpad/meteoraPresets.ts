/**
 * The curve presets a creator picks from when an agent's token launches on
 * Meteora's Dynamic Bonding Curve (the `meteora` launchpad adapter).
 *
 * Pure: no network, no clock, no setting. A preset is a handful of numbers
 * a person can read (where the token's value starts, where it graduates,
 * the fee, what the creator earns and what is locked). Everything else is
 * the same for all four and is fixed below. The SDK's builder turns a
 * preset into the config parameters that go on chain, and the same builder
 * output is what the wizard's description and drawing are made from, so a
 * creator is never shown a curve other than the one that is created.
 *
 * The numbers are the founder's and are pinned by
 * tests/meteoraPresets.unit.test.ts: a change here shows up there.
 */

import { PublicKey } from "@solana/web3.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  Rounding,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
  getDeltaAmountBaseUnsigned,
  getMigrationThresholdPrice,
  getPriceFromSqrtPrice,
  validateConfigParameters,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

// ============================================
// What every preset shares
// ============================================

/** The curve is priced in SOL: the quote mint is wrapped SOL, 9 decimals. */
export const METEORA_QUOTE_MINT = "So11111111111111111111111111111111111111112";
export const METEORA_TOKEN_DECIMALS = 6;
/** Whole tokens. Every token on our curve has this supply, for good. */
export const METEORA_TOKEN_SUPPLY = 1_000_000_000;

export const DEFAULT_PRESET_ID = "community";

/** How many points `points` holds. They are for a drawing only. */
export const PRESET_POINT_COUNT = 24;

const SECONDS_PER_DAY = 86_400;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const SUPPLY_RAW = BigInt(METEORA_TOKEN_SUPPLY) * 10n ** BigInt(METEORA_TOKEN_DECIMALS);

export type SolanaNetwork = "devnet" | "mainnet-beta";

// ============================================
// The four presets
// ============================================

interface PresetDefinition {
  id: string;
  name: string;
  /** One plain sentence for the wizard's card. */
  summary: string;
  /** The value of the whole supply, in SOL, when the curve opens. */
  startValueSol: number;
  /** The value of the whole supply, in SOL, at which the curve is full. */
  graduationValueSol: number;
  /** The trading fee falls from startBps to endBps over `seconds`, in `steps` steps. */
  fee: { startBps: number; endBps: number; seconds: number; steps: number };
  creatorFeeSharePercent: number;
  /** Whole tokens kept for the creator and released after graduation. */
  creatorLocked: null | {
    tokens: number;
    cliffSeconds: number;
    periods: number;
    totalSeconds: number;
  };
  /** A preset for practice is never offered where the money is real. */
  devnetOnly: boolean;
}

const PRESETS: readonly PresetDefinition[] = [
  {
    id: "community",
    name: "Community",
    summary:
      "A low starting price and the largest share of trading fees for the creator, with no tokens set aside for them.",
    startValueSol: 20,
    graduationValueSol: 320,
    fee: { startBps: 3000, endBps: 100, seconds: 300, steps: 30 },
    creatorFeeSharePercent: 70,
    creatorLocked: null,
    devnetOnly: false,
  },
  {
    id: "committed",
    name: "Committed creator",
    summary:
      "The creator keeps a tenth of the supply, locked and released a little at a time after graduation, so buyers can see they are staying.",
    startValueSol: 30,
    graduationValueSol: 400,
    fee: { startBps: 3000, endBps: 100, seconds: 300, steps: 30 },
    creatorFeeSharePercent: 50,
    creatorLocked: {
      tokens: 100_000_000,
      cliffSeconds: 30 * SECONDS_PER_DAY,
      periods: 12,
      totalSeconds: 360 * SECONDS_PER_DAY,
    },
    devnetOnly: false,
  },
  {
    id: "long",
    name: "Long runway",
    summary:
      "A higher starting price and a much later graduation, for an agent that expects to grow over a long time.",
    startValueSol: 50,
    graduationValueSol: 1000,
    fee: { startBps: 2000, endBps: 50, seconds: 600, steps: 60 },
    creatorFeeSharePercent: 50,
    creatorLocked: {
      tokens: 50_000_000,
      cliffSeconds: 30 * SECONDS_PER_DAY,
      periods: 24,
      totalSeconds: 720 * SECONDS_PER_DAY,
    },
    devnetOnly: false,
  },
  {
    id: "rehearsal",
    name: "Devnet rehearsal",
    summary:
      "A very small curve that fills quickly, for practising a whole launch on devnet.",
    startValueSol: 1,
    graduationValueSol: 5,
    fee: { startBps: 500, endBps: 100, seconds: 120, steps: 12 },
    creatorFeeSharePercent: 50,
    creatorLocked: {
      tokens: 100_000_000,
      cliffSeconds: 600,
      periods: 6,
      totalSeconds: 3600,
    },
    devnetOnly: true,
  },
];

function findPreset(id: string): PresetDefinition {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error(`unknown_preset: there is no curve preset called "${id}"`);
  }
  return preset;
}

/** Is this preset one a creator may pick on this network? */
export function isPresetOffered(id: string, network: SolanaNetwork): boolean {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (!preset) return false;
  return !preset.devnetOnly || network === "devnet";
}

// ============================================
// A preset as the SDK's config parameters
// ============================================

/**
 * The config parameters that go on chain for this preset, from the SDK's
 * own builder. A fresh object every call: the caller may hand it to the SDK,
 * which is free to change what it is given.
 */
export function buildPresetCurve(id: string): ConfigParameters {
  const preset = findPreset(id);
  const curve = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: METEORA_TOKEN_SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: preset.fee.startBps,
          endingFeeBps: preset.fee.endBps,
          numberOfPeriod: preset.fee.steps,
          totalDuration: preset.fee.seconds,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: preset.creatorFeeSharePercent,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      // Read only when the fee option is the customizable one. Given as the
      // devnet probe gives it, so the call is the one the chain accepted.
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Enabled,
        poolFeeBps: 100,
      },
    },
    // All of the graduated pool's liquidity is locked for good: half is the
    // platform's and half the creator's, and neither can take it out.
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: preset.creatorLocked?.tokens ?? 0,
      numberOfVestingPeriod: preset.creatorLocked?.periods ?? 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: preset.creatorLocked?.totalSeconds ?? 0,
      cliffDurationFromMigrationTime: preset.creatorLocked?.cliffSeconds ?? 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: preset.startValueSol,
    migrationMarketCap: preset.graduationValueSol,
  });
  return curve;
}

/**
 * The SDK's own check of a config, the one it runs before it builds the
 * transaction. Throws the SDK's sentence when a preset would be refused.
 * The check wants a leftover receiver beside the curve and refuses the
 * all-zero address. Nothing else about the address matters to it, so the
 * quote mint stands in when the caller has no receiver to name.
 */
export function assertPresetCurveIsValid(
  id: string,
  leftoverReceiver: PublicKey = new PublicKey(METEORA_QUOTE_MINT),
): void {
  validateConfigParameters({ ...buildPresetCurve(id), leftoverReceiver });
}

/** The SOL the curve has taken in when it is full, in lamports. */
export function presetGraduationLamports(id: string): bigint {
  return BigInt(buildPresetCurve(id).migrationQuoteThreshold.toString());
}

// ============================================
// A preset as the wizard shows it
// ============================================

export interface PresetDescription {
  id: string;
  name: string;
  summary: string;
  startValueSol: string;
  graduationValueSol: string;
  raisedAtGraduationSol: string;
  fee: { startPercent: string; endPercent: string; seconds: number };
  creatorFeeSharePercent: number;
  creatorLocked: null | {
    percentOfSupply: string;
    cliffSeconds: number;
    periods: number;
    totalSeconds: number;
  };
  liquidityLockedPercent: 100;
  points: Array<{ soldPercent: number; priceSol: number }>;
}

/** `numerator / denominator` as a decimal string, rounded to `places`, no trailing zeros. */
function decimalString(numerator: bigint, denominator: bigint, places: number): string {
  const scale = 10n ** BigInt(places);
  const scaled = (numerator * scale + denominator / 2n) / denominator;
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Raw token units sold when the price has climbed from the curve's start to
 * `sqrtPrice`, summed over the curve's segments with the SDK's own math.
 */
function soldRawAt(curve: ConfigParameters, sqrtPrice: ConfigParameters["sqrtStartPrice"]): bigint {
  let sold = 0n;
  let lower = curve.sqrtStartPrice;
  for (const segment of curve.curve) {
    if (!sqrtPrice.gt(lower)) break;
    const upper = sqrtPrice.lt(segment.sqrtPrice) ? sqrtPrice : segment.sqrtPrice;
    if (upper.gt(lower)) {
      sold += BigInt(
        getDeltaAmountBaseUnsigned(lower, upper, segment.liquidity, Rounding.Down).toString(),
      );
    }
    if (segment.sqrtPrice.gt(lower)) lower = segment.sqrtPrice;
  }
  return sold;
}

/**
 * The curve as a line to draw: PRESET_POINT_COUNT points from the start
 * price to the graduation price, in equal steps of the square root of the
 * price (the unit the curve itself is stored in). At each point: the share
 * of the whole supply sold by then, and the price of one token in SOL.
 * These are the only floats in this file, and nothing is decided on them.
 */
function samplePoints(curve: ConfigParameters): PresetDescription["points"] {
  const start = curve.sqrtStartPrice;
  const end = getMigrationThresholdPrice(curve.migrationQuoteThreshold, start, curve.curve);
  const span = end.sub(start);
  const last = PRESET_POINT_COUNT - 1;
  const points: PresetDescription["points"] = [];
  for (let index = 0; index <= last; index += 1) {
    const at = index === last ? end : start.add(span.muln(index).divn(last));
    const soldRaw = soldRawAt(curve, at);
    points.push({
      soldPercent: Number(((Number(soldRaw) / Number(SUPPLY_RAW)) * 100).toFixed(4)),
      priceSol: getPriceFromSqrtPrice(at, TokenDecimal.SIX, TokenDecimal.NINE).toNumber(),
    });
  }
  return points;
}

/** What the wizard shows for a preset. Throws on an id that is not a preset. */
export function describePreset(id: string): PresetDescription {
  const preset = findPreset(id);
  const curve = buildPresetCurve(id);
  const graduationLamports = BigInt(curve.migrationQuoteThreshold.toString());
  return {
    id: preset.id,
    name: preset.name,
    summary: preset.summary,
    startValueSol: preset.startValueSol.toString(),
    graduationValueSol: preset.graduationValueSol.toString(),
    raisedAtGraduationSol: decimalString(graduationLamports, LAMPORTS_PER_SOL, 3),
    fee: {
      startPercent: decimalString(BigInt(preset.fee.startBps), 100n, 2),
      endPercent: decimalString(BigInt(preset.fee.endBps), 100n, 2),
      seconds: preset.fee.seconds,
    },
    creatorFeeSharePercent: preset.creatorFeeSharePercent,
    creatorLocked: preset.creatorLocked
      ? {
          percentOfSupply: decimalString(
            BigInt(preset.creatorLocked.tokens) * 100n,
            BigInt(METEORA_TOKEN_SUPPLY),
            2,
          ),
          cliffSeconds: preset.creatorLocked.cliffSeconds,
          periods: preset.creatorLocked.periods,
          totalSeconds: preset.creatorLocked.totalSeconds,
        }
      : null,
    liquidityLockedPercent: 100,
    points: samplePoints(curve),
  };
}

/** The presets a creator may pick on this network, as the wizard shows them. */
export function listPresets(network: SolanaNetwork): PresetDescription[] {
  return PRESETS.filter((preset) => isPresetOffered(preset.id, network)).map((preset) =>
    describePreset(preset.id),
  );
}
