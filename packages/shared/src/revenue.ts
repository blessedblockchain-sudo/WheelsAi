/**
 * What a creator gets from a sale and what the platform keeps, in whole
 * cents.
 *
 * The same integer rule as the API's splitRevenue
 * (apps/api/src/services/marketplaceMetering.ts): the platform keeps 10
 * percent, rounded half up to a whole cent, and the creator gets the rest,
 * so the two parts always add up to the amount paid. A screen that shows
 * "you get" uses this, never a multiplication by 0.9: at 5 cents the
 * platform keeps 1 cent (0.5 rounds up) and the creator gets 4, not 4.5.
 *
 * Self-contained on purpose (no imports), like agentKind.ts: the web app and
 * the API both use it, and it must run in a browser.
 */

/** The platform's share of a sale, in percent. The creator gets the rest. */
export const PLATFORM_FEE_PERCENT = 10;

export interface CentsSplit {
  /** The amount paid, as it was split (see splitCents for what is tidied). */
  grossCents: number;
  /** What the platform keeps. */
  platformFeeCents: number;
  /** What the creator gets: grossCents - platformFeeCents, exactly. */
  creatorCents: number;
}

/**
 * Split an amount paid, in whole cents, into the platform's fee and the
 * creator's part.
 *
 * Whole cents in, whole cents out. The API only ever splits a whole,
 * non-negative number of cents, so an input that is not one is first made
 * into the nearest amount the API could be given, and the answer's
 * grossCents says which amount that was:
 *   - not a number, or infinite (NaN, Infinity, -Infinity): 0, an amount
 *     nobody can read splits as nothing rather than as a guess;
 *   - negative: 0;
 *   - fractional: the nearest whole cent, a half going up (4.5 is 5);
 *   - above Number.MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER.
 * 0 splits as 0 and 0.
 */
export function splitCents(grossCents: number): CentsSplit {
  let gross = 0;
  if (typeof grossCents === "number" && Number.isFinite(grossCents) && grossCents > 0) {
    gross = Math.min(Math.round(grossCents), Number.MAX_SAFE_INTEGER);
  }
  // floor((gross * 10 + 50) / 100) without leaving the safe integers: the
  // whole tens give a cent each, and a last digit of 5 or more gives one
  // more.
  const platformFeeCents =
    Math.floor(gross / PLATFORM_FEE_PERCENT) + (gross % 10 >= 5 ? 1 : 0);
  return {
    grossCents: gross,
    platformFeeCents,
    creatorCents: gross - platformFeeCents,
  };
}
