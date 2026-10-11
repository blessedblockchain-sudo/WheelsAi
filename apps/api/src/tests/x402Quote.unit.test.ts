/**
 * Drives apps/api/src/services/x402Quote.ts: the SOL rate lock a 402
 * hands out and a paid retry hands back.
 *
 * Pinning: a quote is honoured inside its life, for its own organization
 * and deployment only; one that is missing, expired, forged, tampered
 * with, made for another purpose or signed with another secret reads as
 * "quote_expired", and nothing else is ever answered.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./unitEnv.js";
import { signState } from "../services/signedState.js";
import { X402_QUOTE_PURPOSE, readX402Quote, signX402Quote } from "../services/x402Quote.js";

const SECRET = "x402-quote-test-secret-0123456789";
const OTHER_SECRET = "another-secret-entirely-9876543210";
const T0 = new Date("2026-10-11T12:00:00.000Z");
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
const EXPIRED = { ok: false, reason: "quote_expired" } as const;

const PAYLOAD = {
  orgId: "org_1",
  deploymentId: "dep_1",
  asset: "SOL",
  solMicroUsdPerSol: 143_217_654n,
} as const;

function sign(overrides: Partial<{ orgId: string; deploymentId: string; solMicroUsdPerSol: bigint }> = {}): string {
  return signX402Quote({ ...PAYLOAD, ...overrides }, { secret: SECRET, ttlSeconds: 120, now: T0 });
}

function read(token: unknown, overrides: Partial<{ secret: string; orgId: string; deploymentId: string; now: Date }> = {}) {
  return readX402Quote(token, { secret: SECRET, orgId: "org_1", deploymentId: "dep_1", now: at(1), ...overrides });
}

test("x402Quote: a quote read inside its life answers the rate it locked", () => {
  const token = sign();
  assert.deepEqual(read(token), { ok: true, quote: { asset: "SOL", solMicroUsdPerSol: 143_217_654n } });
  assert.deepEqual(read(token, { now: at(119) }), { ok: true, quote: { asset: "SOL", solMicroUsdPerSol: 143_217_654n } });
  // The clock may be handed in as a function too.
  assert.equal(
    readX402Quote(signX402Quote(PAYLOAD, { secret: SECRET, ttlSeconds: 120, now: () => T0 }), {
      secret: SECRET,
      orgId: "org_1",
      deploymentId: "dep_1",
      now: () => at(60),
    }).ok,
    true
  );
});

test("x402Quote: the token holds strings only, the rate among them", () => {
  const body = JSON.parse(Buffer.from(sign().split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(body.purpose, X402_QUOTE_PURPOSE);
  assert.equal(body.purpose, "x402-quote");
  assert.equal(body.orgId, "org_1");
  assert.equal(body.deploymentId, "dep_1");
  assert.equal(body.asset, "SOL");
  assert.equal(body.rate, "143217654");
  assert.equal(body.exp, Math.floor(T0.getTime() / 1000) + 120);
});

test("x402Quote: a rate larger than a float can hold comes back whole", () => {
  const rate = 9_007_199_254_740_993_123n;
  const result = read(sign({ solMicroUsdPerSol: rate }));
  assert.deepEqual(result, { ok: true, quote: { asset: "SOL", solMicroUsdPerSol: rate } });
});

test("x402Quote: at the end of its life and after, it is quote_expired", () => {
  const token = sign();
  assert.deepEqual(read(token, { now: at(120) }), EXPIRED);
  assert.deepEqual(read(token, { now: at(121) }), EXPIRED);
  assert.deepEqual(read(token, { now: at(86_400) }), EXPIRED);
});

test("x402Quote: a quote for another organization or deployment is quote_expired", () => {
  const token = sign();
  assert.deepEqual(read(token, { orgId: "org_2" }), EXPIRED);
  assert.deepEqual(read(token, { deploymentId: "dep_2" }), EXPIRED);
  assert.deepEqual(read(sign({ orgId: "org_2" })), EXPIRED);
  assert.deepEqual(read(sign({ deploymentId: "dep_2" })), EXPIRED);
  // No organization or deployment to check against honours nothing.
  assert.deepEqual(read(token, { orgId: "" }), EXPIRED);
  assert.deepEqual(read(token, { deploymentId: undefined as unknown as string }), EXPIRED);
});

test("x402Quote: a missing token is quote_expired", () => {
  for (const missing of [undefined, null, "", 0, 42, {}, [], true]) {
    assert.deepEqual(read(missing), EXPIRED);
  }
});

test("x402Quote: a forged or tampered token is quote_expired", () => {
  const token = sign();
  const [header, body, signature] = token.split(".") as [string, string, string];

  // Signed with another secret, or read with one.
  assert.deepEqual(read(signX402Quote(PAYLOAD, { secret: OTHER_SECRET, ttlSeconds: 120, now: T0 })), EXPIRED);
  assert.deepEqual(read(token, { secret: OTHER_SECRET }), EXPIRED);
  assert.deepEqual(read(token, { secret: "" }), EXPIRED);

  // The body rewritten to a kinder rate, the old signature kept.
  const kinder = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), rate: "999999999999" }),
    "utf8"
  ).toString("base64url");
  assert.deepEqual(read(`${header}.${kinder}.${signature}`), EXPIRED);

  // The life stretched, the old signature kept.
  const longer = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), exp: 4_000_000_000 }),
    "utf8"
  ).toString("base64url");
  assert.deepEqual(read(`${header}.${longer}.${signature}`, { now: at(500) }), EXPIRED);

  // Not a token at all.
  for (const junk of ["abc", "a.b", "a.b.c", "a.b.c.d", `${header}.${body}.`, `${header}.${body}`, `${token}x`]) {
    assert.deepEqual(read(junk), EXPIRED);
  }
});

test("x402Quote: a token validly signed for something else is quote_expired", () => {
  const signOther = (payload: Record<string, unknown> & { purpose: string }): string =>
    signState({ payload, secret: SECRET, ttlSeconds: 120, now: () => T0 });
  const good = { purpose: "x402-quote", orgId: "org_1", deploymentId: "dep_1", asset: "SOL", rate: "143217654" };

  assert.equal(read(signOther(good)).ok, true);
  // Another purpose with the same secret (an OAuth state, say).
  assert.deepEqual(read(signOther({ ...good, purpose: "slack-install" })), EXPIRED);
  // USDC needs no quote and has no rate to lock.
  assert.deepEqual(read(signOther({ ...good, asset: "USDC" })), EXPIRED);
  // A rate that is not a whole number above zero, written as a string.
  for (const rate of ["0", "-5", "1.5", "1e9", "0x10", " 12", "012", "", 143217654, null, undefined, "9".repeat(60)]) {
    assert.deepEqual(read(signOther({ ...good, rate })), EXPIRED, `rate ${String(rate)}`);
  }
});

test("x402Quote: only a SOL rate above zero, for a named organization and deployment, is locked", () => {
  const opts = { secret: SECRET, ttlSeconds: 120, now: T0 };
  assert.throws(() => signX402Quote({ ...PAYLOAD, solMicroUsdPerSol: 0n }, opts), RangeError);
  assert.throws(() => signX402Quote({ ...PAYLOAD, solMicroUsdPerSol: -1n }, opts), RangeError);
  assert.throws(() => signX402Quote({ ...PAYLOAD, solMicroUsdPerSol: 150 as unknown as bigint }, opts), RangeError);
  assert.throws(() => signX402Quote({ ...PAYLOAD, asset: "USDC" }, opts), RangeError);
  assert.throws(() => signX402Quote({ ...PAYLOAD, orgId: "" }, opts), RangeError);
  assert.throws(() => signX402Quote({ ...PAYLOAD, deploymentId: "" }, opts), RangeError);
  // The lifetime and the secret are signedState's to refuse.
  assert.throws(() => signX402Quote(PAYLOAD, { ...opts, ttlSeconds: 0 }));
  assert.throws(() => signX402Quote(PAYLOAD, { ...opts, secret: "short" }));
});

test("x402Quote: two quotes for the same rate are different tokens, and both are honoured", () => {
  const a = sign();
  const b = sign();
  assert.notEqual(a, b);
  assert.equal(read(a).ok, true);
  assert.equal(read(b).ok, true);
});

test("x402Quote: the module reads no settings", () => {
  const source = readFileSync(new URL("../services/x402Quote.ts", import.meta.url), "utf8");
  assert.equal(/process\.env|config\/env/.test(source), false);
});
