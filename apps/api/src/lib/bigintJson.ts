/**
 * Precision-safe BigInt JSON serialization (remediation D9).
 *
 * Prisma surfaces BigInt columns across the API. The previous global
 * `BigInt.prototype.toJSON = () => Number(this)` SILENTLY CORRUPTED any
 * value above 2^53 (IEEE-754's exact-integer ceiling) — raw token units
 * (up to ~1e15) and large lamport sums encode to the wrong integer.
 *
 * The fix keeps backward compatibility for the overwhelming majority of
 * BigInt fields (cents, seconds, counts — all well under 2^53) by encoding
 * them as JSON numbers, and only switches to a string for genuinely large
 * values, where a string is the only lossless JSON representation.
 */

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = -MAX_SAFE_BIGINT;

/**
 * Map a BigInt to its JSON representation: a number when the value is
 * exactly representable as an IEEE-754 double (|v| ≤ 2^53 - 1), otherwise a
 * decimal string so no precision is lost.
 */
export function bigIntToJson(value: bigint): number | string {
  return value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT
    ? Number(value)
    : value.toString();
}

/**
 * Install {@link bigIntToJson} as the global `BigInt.prototype.toJSON` so
 * every `JSON.stringify` (including Fastify's reply serializer) encodes
 * BigInt safely. Idempotent — safe to call more than once.
 */
export function installBigIntJsonSerializer(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (BigInt.prototype as any).toJSON = function (this: bigint) {
    return bigIntToJson(this);
  };
}
