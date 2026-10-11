// What one x402 request costs, in whole numbers.
//
// Pure: no settings, no network, no clock. The table and the estimate are
// the ones x402 has always charged by (a price per 1,000 tokens by model
// tier, the token estimate raised by a fifth, a minimum charge); what
// changed is that nothing here is a float. A price is a bigint of
// millionths of a dollar ("micro-dollars"), rounded up once.
//
// USDC has six decimals, so its base units ARE micro-dollars. SOL has a
// price only from a rate the caller hands in (solMicroUsdRate on a live
// quote, or the rate a signed quote locked): there is no number for SOL in
// this file.

import { lamportsForMicroUsdAtRate } from "./solPrice.js";
import type { X402Asset, X402Price } from "./x402Types.js";

export type X402ModelTier = "small" | "medium" | "large";

/**
 * Micro-dollars per 1,000 tokens. The same prices as PRICING_TIERS in
 * @wheelsai/shared ($0.00015 is 150 micro-dollars), written as whole
 * numbers.
 */
export const X402_PRICE_MICRO_USD_PER_1K: Readonly<
  Record<X402ModelTier, { readonly input: bigint; readonly output: bigint }>
> = {
  small: { input: 150n, output: 600n },
  medium: { input: 300n, output: 1_200n },
  large: { input: 900n, output: 3_600n },
};

/** The least a request costs: $0.0001. */
export const X402_MIN_CHARGE_MICRO_USD = 100n;

export interface X402PriceInput {
  /** The model's pricing tier. */
  modelTier: X402ModelTier;
  /** The estimate of the prompt's tokens, before the fifth is added. */
  estimatedInputTokens: number;
  /** The estimate of the answer's tokens, before the fifth is added. */
  estimatedOutputTokens: number;
}

function ceilDiv(numerator: bigint, divisor: bigint): bigint {
  return (numerator + divisor - 1n) / divisor;
}

/** A token estimate as a whole number, or a refusal to price at all. */
function wholeTokens(value: number, name: string): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`priceMicroUsd: ${name} is not a usable number of tokens`);
  }
  return BigInt(Math.ceil(value));
}

/** The estimate raised by a fifth, rounded up to a whole token. */
function withBuffer(tokens: bigint): bigint {
  return ceilDiv(tokens * 6n, 5n);
}

/**
 * The request's price in micro-dollars, rounded up, never under the
 * minimum. Throws a RangeError for a tier that has no price or an estimate
 * that is not a number of tokens: a request that cannot be priced is not
 * given a price.
 */
export function priceMicroUsd(input: X402PriceInput): bigint {
  const pricing = Object.prototype.hasOwnProperty.call(X402_PRICE_MICRO_USD_PER_1K, input.modelTier)
    ? X402_PRICE_MICRO_USD_PER_1K[input.modelTier]
    : undefined;
  if (!pricing) throw new RangeError("priceMicroUsd: the model tier has no price");

  const inputTokens = withBuffer(wholeTokens(input.estimatedInputTokens, "estimatedInputTokens"));
  const outputTokens = withBuffer(wholeTokens(input.estimatedOutputTokens, "estimatedOutputTokens"));

  // One division, at the end: (tokens * price per 1,000) / 1,000, rounded up.
  const microUsd = ceilDiv(inputTokens * pricing.input + outputTokens * pricing.output, 1_000n);
  return microUsd > X402_MIN_CHARGE_MICRO_USD ? microUsd : X402_MIN_CHARGE_MICRO_USD;
}

/**
 * A price in micro-dollars as the amount to ask for in an asset.
 *   USDC: the base units are the micro-dollars, exactly.
 *   SOL:  lamports at the rate handed in, rounded up.
 * Throws a RangeError when the price is not above zero, or when SOL is
 * asked for without a rate above zero. There is no rate to fall back on.
 */
export function x402PriceFor(args: {
  microUsd: bigint;
  asset: X402Asset;
  /** Micro-dollars per SOL. Needed for SOL; not looked at for USDC. */
  solRateMicroUsdPerSol?: bigint | null;
}): X402Price {
  const { microUsd, asset } = args;
  if (typeof microUsd !== "bigint" || microUsd <= 0n) {
    throw new RangeError("x402PriceFor: the price is not above zero");
  }
  if (asset === "USDC") {
    return { asset: "USDC", amountMicroUsd: microUsd, amountRaw: microUsd, solMicroUsdPerSol: null };
  }
  if (asset !== "SOL") throw new RangeError("x402PriceFor: the asset has no price");

  const rate = args.solRateMicroUsdPerSol;
  if (typeof rate !== "bigint" || rate <= 0n) {
    throw new RangeError("x402PriceFor: SOL has no rate");
  }
  const lamports = lamportsForMicroUsdAtRate(microUsd, rate);
  if (!lamports.ok) throw new RangeError("x402PriceFor: SOL cannot be priced at this rate");
  return { asset: "SOL", amountMicroUsd: microUsd, amountRaw: lamports.lamports, solMicroUsdPerSol: rate };
}

/**
 * Micro-dollars as dollars, for the `amountUsd` a payer is shown. A float:
 * to show only, never an input to an amount.
 */
export function microUsdToUsd(microUsd: bigint): number {
  return Number(microUsd) / 1_000_000;
}
