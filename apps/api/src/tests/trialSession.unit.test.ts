import assert from "node:assert/strict";
import test from "node:test";

import {
  issueTrialSession,
  TRIAL_SESSION_TTL_SECONDS,
  verifyTrialSession,
} from "../services/trialSession.js";
import { signState } from "../services/signedState.js";

// Drives services/trialSession.ts: the token a Try it visitor holds after
// the human check, bound to the listing and to the network it was issued on.

const SECRET = "0123456789abcdef0123456789abcdef";
const T0 = new Date("2026-10-10T12:00:00.000Z");
const at = (seconds: number) => () => new Date(T0.getTime() + seconds * 1000);

const issued = (over: Partial<Parameters<typeof issueTrialSession>[0]> = {}) =>
  issueTrialSession(
    { listingId: "listing-1", orgId: null, ipBucketHash: "bucket-a", ...over },
    { secret: SECRET, now: at(0) },
  );

test("an issued session verifies for its listing and network, and carries who it is for", () => {
  const anonymous = issued();
  assert.equal(anonymous.expiresAt.toISOString(), "2026-10-10T12:15:00.000Z");
  const verified = verifyTrialSession(
    { token: anonymous.token, listingId: "listing-1", ipBucketHash: "bucket-a" },
    { secret: SECRET, now: at(60) },
  );
  assert.deepEqual(verified, {
    ok: true,
    sessionId: anonymous.sessionId,
    orgId: null,
    expiresAt: anonymous.expiresAt,
  });

  const signedIn = issued({ orgId: "org-9" });
  const again = verifyTrialSession(
    { token: signedIn.token, listingId: "listing-1", ipBucketHash: "bucket-a" },
    { secret: SECRET, now: at(1) },
  );
  assert.ok(again.ok);
  assert.equal(again.orgId, "org-9");
  assert.notEqual(signedIn.sessionId, anonymous.sessionId, "every session has its own id to count against");
});

test("expired, tampered, wrong-listing and other-network tokens are refused with their reason", () => {
  const { token } = issued();
  const check = (over: Partial<Parameters<typeof verifyTrialSession>[0]>, seconds = 60, secret = SECRET) =>
    verifyTrialSession(
      { token, listingId: "listing-1", ipBucketHash: "bucket-a", ...over },
      { secret, now: at(seconds) },
    );

  assert.deepEqual(check({}, TRIAL_SESSION_TTL_SECONDS), { ok: false, reason: "expired" });
  assert.deepEqual(check({ listingId: "listing-2" }), { ok: false, reason: "wrong_listing" });
  assert.deepEqual(check({ ipBucketHash: "bucket-b" }), { ok: false, reason: "network_changed" });
  assert.deepEqual(check({}, 60, "another-secret-of-enough-length!!"), { ok: false, reason: "bad_signature" });

  // A payload edited to name another listing no longer matches its signature.
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const forged = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), listingId: "listing-2" }),
  ).toString("base64url");
  assert.deepEqual(check({ token: `${header}.${forged}.${signature}`, listingId: "listing-2" }), {
    ok: false,
    reason: "bad_signature",
  });

  for (const bad of ["", "abc", "a.b", 42, null, undefined, "x".repeat(3000)]) {
    assert.deepEqual(check({ token: bad }), { ok: false, reason: "malformed" }, String(bad).slice(0, 20));
  }
});

test("a token signed for another purpose is not a Try it session", () => {
  const other = signState({
    payload: { purpose: "slack-install", listingId: "listing-1", orgId: null, ipb: "bucket-a", sid: "s" },
    secret: SECRET,
    now: at(0),
  });
  const result = verifyTrialSession(
    { token: other, listingId: "listing-1", ipBucketHash: "bucket-a" },
    { secret: SECRET, now: at(1) },
  );
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("a signed token missing what a session needs is malformed", () => {
  const partial = signState({
    payload: { purpose: "try-it", listingId: "listing-1" },
    secret: SECRET,
    now: at(0),
  });
  const result = verifyTrialSession(
    { token: partial, listingId: "listing-1", ipBucketHash: "bucket-a" },
    { secret: SECRET, now: at(1) },
  );
  assert.deepEqual(result, { ok: false, reason: "malformed" });
});

test("a session never outlives 15 minutes, whatever is asked for", () => {
  const long = issued({ ttlSeconds: 86_400 });
  assert.equal(long.expiresAt.getTime() - T0.getTime(), TRIAL_SESSION_TTL_SECONDS * 1000);
  assert.equal(TRIAL_SESSION_TTL_SECONDS, 900);

  const short = issued({ ttlSeconds: 30 });
  assert.equal(short.expiresAt.getTime() - T0.getTime(), 30_000);
  assert.equal(
    verifyTrialSession(
      { token: short.token, listingId: "listing-1", ipBucketHash: "bucket-a" },
      { secret: SECRET, now: at(31) },
    ).ok,
    false,
  );
  assert.throws(() => issueTrialSession({ listingId: "l", orgId: null, ipBucketHash: "b" }, { secret: "short" }));
});
