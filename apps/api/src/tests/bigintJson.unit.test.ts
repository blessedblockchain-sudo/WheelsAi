import assert from "node:assert/strict";
import test from "node:test";

// Drives apps/api/src/lib/bigintJson.ts — the precision-safe BigInt JSON
// serializer (remediation D9). The bug it replaces: a global
// `BigInt.prototype.toJSON = () => Number(this)` that silently rounds any
// value above 2^53 to the wrong integer when a route serializes it.

test("bigIntToJson encodes safe-range values as JSON numbers (backward compatible)", async () => {
  const { bigIntToJson } = await import("../lib/bigintJson.js");
  assert.strictEqual(bigIntToJson(0n), 0);
  assert.strictEqual(bigIntToJson(1_000n), 1_000);
  assert.strictEqual(bigIntToJson(-42n), -42);
  // The exact IEEE-754 integer ceiling (2^53 - 1) is still a number.
  assert.strictEqual(bigIntToJson(9_007_199_254_740_991n), 9_007_199_254_740_991);
  assert.strictEqual(bigIntToJson(-9_007_199_254_740_991n), -9_007_199_254_740_991);
  // Typical raw token amount (1e15 < 2^53) — exact as a number.
  assert.strictEqual(bigIntToJson(1_000_000_000_000_000n), 1_000_000_000_000_000);
});

test("bigIntToJson encodes values beyond 2^53 as lossless strings", async () => {
  const { bigIntToJson } = await import("../lib/bigintJson.js");
  // 2^53 and above can no longer be represented exactly as a double.
  assert.strictEqual(bigIntToJson(9_007_199_254_740_992n), "9007199254740992");
  assert.strictEqual(bigIntToJson(9_007_199_254_740_993n), "9007199254740993");
  assert.strictEqual(
    bigIntToJson(123_456_789_012_345_678_901n),
    "123456789012345678901",
  );
  assert.strictEqual(
    bigIntToJson(-123_456_789_012_345_678_901n),
    "-123456789012345678901",
  );
});

test("installed serializer round-trips a value above 2^53 through JSON without precision loss", async () => {
  const { installBigIntJsonSerializer } = await import("../lib/bigintJson.js");
  installBigIntJsonSerializer();

  // 2^53 + 1: the canonical value Number() cannot hold — it rounds to the
  // even neighbour 9007199254740992. The serializer must preserve it.
  const original = 9_007_199_254_740_993n;
  const json = JSON.stringify({ amountLamports: original });
  assert.strictEqual(json, '{"amountLamports":"9007199254740993"}');

  // Recovering via BigInt(string) reconstructs the exact value — proving
  // the old Number() path would have corrupted it.
  const parsed = JSON.parse(json) as { amountLamports: string };
  assert.strictEqual(BigInt(parsed.amountLamports), original);
  assert.notStrictEqual(Number(original).toString(), original.toString());
});

test("installed serializer keeps small BigInt fields as JSON numbers", async () => {
  const { installBigIntJsonSerializer } = await import("../lib/bigintJson.js");
  installBigIntJsonSerializer();

  const json = JSON.stringify({ balanceCents: 12_345n, computeSeconds: 0n });
  assert.strictEqual(json, '{"balanceCents":12345,"computeSeconds":0}');
});
