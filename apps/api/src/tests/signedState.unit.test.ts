import assert from "node:assert/strict";
import test from "node:test";

import {
  makeMemoryNonceStore,
  makeRedisNonceStore,
} from "../services/oauthStateStore.js";
import { signState, verifyState } from "../services/signedState.js";

// Drives services/signedState.ts + services/oauthStateStore.ts — the
// replacement for `generateOAuthState`/`parseOAuthState`, which emitted
// UNSIGNED base64url JSON carrying the orgId and checked expiry with the
// timestamp from that same attacker-supplied blob.

const SECRET = "test-state-secret-0123456789abcdef";

test("a signed state round-trips with its payload", () => {
  const token = signState({
    payload: { purpose: "slack-install", orgId: "org-1", deploymentId: "dep-1" },
    secret: SECRET,
  });
  const result = verifyState({ token, secret: SECRET, expectedPurpose: "slack-install" });
  assert.ok(result.ok);
  assert.equal(result.payload.orgId, "org-1");
  assert.equal(result.payload.purpose, "slack-install");
});

test("THE FORGERY: a hand-made base64 payload is rejected", () => {
  // Exactly what the old scheme accepted — JSON, base64url'd, no signature.
  const forged = Buffer.from(
    JSON.stringify({
      purpose: "slack-install",
      orgId: "victim-org",
      iat: 0,
      exp: 9_999_999_999,
    }),
  ).toString("base64url");
  const result = verifyState({ token: forged, secret: SECRET, expectedPurpose: "slack-install" });
  assert.equal(result.ok, false);
  // Three parts required, so a bare payload is malformed.
  assert.equal((result as { reason: string }).reason, "malformed");
});

test("tampering with the payload invalidates the signature", () => {
  const token = signState({
    payload: { purpose: "slack-install", orgId: "org-1" },
    secret: SECRET,
  });
  const [h, , sig] = token.split(".");
  const swapped = Buffer.from(
    JSON.stringify({
      purpose: "slack-install",
      orgId: "attacker-org",
      iat: 1,
      exp: 9_999_999_999,
    }),
  ).toString("base64url");
  const result = verifyState({ token: `${h}.${swapped}.${sig}`, secret: SECRET, expectedPurpose: "slack-install" });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "bad_signature");
});

test("a token signed with a different secret is rejected", () => {
  const token = signState({
    payload: { purpose: "slack-install" },
    secret: "another-secret-0123456789abcdefgh",
  });
  const result = verifyState({ token, secret: SECRET, expectedPurpose: "slack-install" });
  assert.equal((result as { reason: string }).reason, "bad_signature");
});

test("expiry is SERVER-set and enforced after signature verification", () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  const token = signState({
    payload: { purpose: "slack-install" },
    secret: SECRET,
    ttlSeconds: 60,
    now: () => t0,
  });
  // Still valid inside the window.
  assert.ok(
    verifyState({
      token,
      secret: SECRET,
      expectedPurpose: "slack-install",
      now: () => new Date(t0.getTime() + 30_000),
    }).ok,
  );
  // Expired after it.
  const late = verifyState({
    token,
    secret: SECRET,
    expectedPurpose: "slack-install",
    now: () => new Date(t0.getTime() + 61_000),
  });
  assert.equal((late as { reason: string }).reason, "expired");
});

test("a caller cannot extend its own expiry — exp is not read from input", () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  const token = signState({
    // Attempting to inject a far-future exp.
    payload: { purpose: "slack-install", exp: 9_999_999_999 },
    secret: SECRET,
    ttlSeconds: 60,
    now: () => t0,
  });
  const late = verifyState({
    token,
    secret: SECRET,
    expectedPurpose: "slack-install",
    now: () => new Date(t0.getTime() + 61_000),
  });
  assert.equal(
    (late as { reason: string }).reason,
    "expired",
    "the server's exp must win over any exp supplied in the payload",
  );
});

test("a state minted for one flow is refused by another", () => {
  const token = signState({
    payload: { purpose: "github-install" },
    secret: SECRET,
  });
  const result = verifyState({
    token,
    secret: SECRET,
    expectedPurpose: "slack-install",
  });
  assert.equal((result as { reason: string }).reason, "wrong_purpose");
});

test("malformed tokens fail typed, never throw", () => {
  for (const token of ["", "a", "a.b", "....", "a.b.c.d"]) {
    const result = verifyState({ token, secret: SECRET, expectedPurpose: "slack-install" });
    assert.equal(result.ok, false, JSON.stringify(token));
  }
});

test("signing refuses a weak secret and a purposeless payload", () => {
  assert.throws(
    () => signState({ payload: { purpose: "x" }, secret: "short" }),
    /at least 16/,
  );
  assert.throws(
    () => signState({ payload: { purpose: "" }, secret: SECRET }),
    /purpose is required/,
  );
});

// ============================================
// Single-use nonce
// ============================================

test("a nonce is consumable exactly once", async () => {
  const store = makeMemoryNonceStore();
  assert.equal(await store.mint("n1", 600), true);
  assert.equal(await store.consume("n1"), true);
  assert.equal(await store.consume("n1"), false, "replay must fail");
});

test("minting over a live nonce does not overwrite it", async () => {
  const store = makeMemoryNonceStore();
  await store.mint("n1", 600);
  assert.equal(await store.mint("n1", 600), false);
});

test("an expired nonce cannot be consumed", async () => {
  let clock = 1_000_000;
  const store = makeMemoryNonceStore(() => clock);
  await store.mint("n1", 60);
  clock += 61_000;
  assert.equal(await store.consume("n1"), false);
});

test("the Redis store uses SET NX EX and treats DEL=1 as the single winner", async () => {
  const calls: unknown[][] = [];
  let delResult = 1;
  const store = makeRedisNonceStore({
    set: async (...args: unknown[]) => {
      calls.push(args);
      return "OK";
    },
    del: async (...args: unknown[]) => {
      calls.push(args);
      return delResult;
    },
  } as never);

  assert.equal(await store.mint("n1", 600), true);
  assert.deepEqual(calls[0], ["oauth-state:n1", "1", "EX", 600, "NX"]);

  assert.equal(await store.consume("n1"), true);
  delResult = 0; // another replica already deleted it
  assert.equal(await store.consume("n1"), false, "loser of the race gets false");
});

// ============================================
// Hardening from the adversarial verification pass
// ============================================

test("verifyState enforces the SAME secret invariant as signState", () => {
  // Previously the >=16-char rule existed only on the mint path — the one
  // path an attacker never touches — so a caller wiring an empty secret
  // would accept tokens signState refuses to produce.
  const token = signState({
    payload: { purpose: "slack-install", orgId: "org-1" },
    secret: SECRET,
  });
  for (const weak of ["", "short"]) {
    const result = verifyState({
      token,
      secret: weak,
      expectedPurpose: "slack-install",
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, "bad_secret");
  }
});

test("purpose binding is REQUIRED, so a callback cannot forget it", () => {
  // A type-level guarantee: omitting expectedPurpose does not compile.
  // @ts-expect-error expectedPurpose is required
  const bad = () => verifyState({ token: "x.y.z", secret: SECRET });
  assert.equal(typeof bad, "function");
});

test("the nonce is minted by the mechanism, not left to the caller", () => {
  const a = signState({ payload: { purpose: "slack-install" }, secret: SECRET });
  const b = signState({ payload: { purpose: "slack-install" }, secret: SECRET });
  const nonceOf = (t: string) =>
    JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).nonce;
  assert.equal(typeof nonceOf(a), "string");
  assert.equal(nonceOf(a).length, 64, "32 random bytes, hex");
  assert.notEqual(nonceOf(a), nonceOf(b), "each state gets its own nonce");
});

test("a caller cannot override the server-minted nonce or timestamps", () => {
  const token = signState({
    payload: {
      purpose: "slack-install",
      nonce: "attacker-chosen",
      iat: 1,
      exp: 9_999_999_999,
    },
    secret: SECRET,
    ttlSeconds: 60,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString(),
  );
  assert.notEqual(payload.nonce, "attacker-chosen");
  assert.notEqual(payload.exp, 9_999_999_999);
});

test("TTL is bounded — a state token cannot become a long-lived credential", () => {
  assert.throws(
    () =>
      signState({
        payload: { purpose: "slack-install" },
        secret: SECRET,
        ttlSeconds: 60 * 60 * 24 * 365,
      }),
    /ttlSeconds must be between/,
  );
  assert.throws(
    () => signState({ payload: { purpose: "x" }, secret: SECRET, ttlSeconds: 0 }),
    /ttlSeconds must be between/,
  );
});
