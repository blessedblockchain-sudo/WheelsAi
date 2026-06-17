/**
 * Canonical SOL / token unit conversions for the money path (remediation
 * D9).
 *
 * pumpportal reports trade amounts as human-unit Floats (SOL, whole
 * tokens, USD). They enter the system ONCE here, at the indexer boundary
 * (fetchTokenTradesSince), and are converted to integer raw units that
 * every downstream money computation reads INSTEAD of the Floats:
 *   - SOL → lamports (9 decimals): the fee router sums these
 *   - tokens → raw (6 decimals — every pump.fun mint): holder balances and
 *     the token gate read these
 *
 * Conversion is round-to-nearest (Math.round), matching the migration's
 * ROUND(numeric ...). The inputs are bounded well under 2^53 — a
 * bonding-curve trade is ≤ ~85 SOL (8.5e10 lamports) and a holder is ≤ the
 * 1e9 fixed supply (1e15 raw < 2^53) — so the float multiply is exact
 * before rounding. Keeping the integers downstream is what prevents float
 * error from compounding across the trade stream and precision loss near
 * 2^53 for large holders.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Decimals on every pump.fun SPL mint. */
export const PUMPFUN_TOKEN_DECIMALS = 6;

/** Raw base units per whole token (10 ** PUMPFUN_TOKEN_DECIMALS). */
export const TOKEN_RAW_PER_UNIT = 1_000_000;

/** Basis-points denominator (100% = 10000 bps). */
export const BPS_DENOMINATOR = 10_000;

/** SOL (human Float) → lamports (integer). Round-to-nearest, clamped ≥ 0. */
export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol <= 0) return 0n;
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

/**
 * Whole tokens (human Float) → raw base units (integer). Round-to-nearest,
 * clamped ≥ 0 (a trade's tokenAmount is always positive; the buy/sell sign
 * is applied downstream in the holder snapshot).
 */
export function tokensToRaw(tokens: number): bigint {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0n;
  return BigInt(Math.round(tokens * TOKEN_RAW_PER_UNIT));
}

/** Raw base units → whole tokens (Float — display only, never money math). */
export function rawToTokens(raw: bigint): number {
  return Number(raw) / TOKEN_RAW_PER_UNIT;
}

/** Fraction (0–1 Float) → basis points (integer). Round-to-nearest. */
export function fractionToBps(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.round(fraction * BPS_DENOMINATOR);
}

/** Basis points → fraction (0–1 Float — display mirror only). */
export function bpsToFraction(bps: number): number {
  return bps / BPS_DENOMINATOR;
}
