import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";

import {
  signPrepareToken,
  verifyPrepareToken,
} from "../services/launchpadPrepareToken.js";

const SECRET = "12345678901234567890123456789012"; // 32 chars

const baseFields = {
  mintAddress: "MintAddr11111111111111111111111111111111111",
  agentListingId: "listing-123",
  orgId: "org-abc",
  creatorPubkey: "CreatorPub11111111111111111111111111111111",
  name: "Test Token",
  symbol: "TST",
  description: "Test token",
  imageUri: "https://example.com/img.png",
  launchpad: "pumpfun",
  context: {} as Record<string, unknown>,
};

test("signPrepareToken + verifyPrepareToken round-trip", () => {
  const now = () => new Date("2026-05-20T12:00:00Z");
  const token = signPrepareToken({
    payload: baseFields,
    secret: SECRET,
    now,
  });
  const result = verifyPrepareToken({ token, secret: SECRET, now });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.mintAddress, baseFields.mintAddress);
    assert.equal(result.payload.agentListingId, baseFields.agentListingId);
    assert.equal(result.payload.orgId, baseFields.orgId);
    assert.equal(result.payload.creatorPubkey, baseFields.creatorPubkey);
    assert.equal(result.payload.launchpad, "pumpfun");
    assert.deepEqual(result.payload.context, {});
    assert.equal(result.payload.exp - result.payload.iat, 300); // default 5 min
  }
});

test("verifyPrepareToken round-trips a non-empty adapter context (e.g. Bags configKey)", () => {
  const now = () => new Date("2026-05-20T12:00:00Z");
  const token = signPrepareToken({
    payload: {
      ...baseFields,
      launchpad: "bags",
      context: { configKey: "CfgKey1111111111111111111111111111111111111" },
    },
    secret: SECRET,
    now,
  });
  const result = verifyPrepareToken({ token, secret: SECRET, now });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.launchpad, "bags");
    assert.deepEqual(result.payload.context, {
      configKey: "CfgKey1111111111111111111111111111111111111",
    });
  }
});

test("verifyPrepareToken rejects a payload missing launchpad/context", () => {
  // Hand-craft a validly-signed token whose payload omits the new fields,
  // simulating an old-format token — must fail payload validation.
  const headerB64 = Buffer.from("wheelsai-pumpfun-prep-v1", "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const legacyPayload = {
    mintAddress: baseFields.mintAddress,
    agentListingId: baseFields.agentListingId,
    orgId: baseFields.orgId,
    creatorPubkey: baseFields.creatorPubkey,
    symbol: baseFields.symbol,
    description: baseFields.description,
    imageUri: baseFields.imageUri,
    iat: 0,
    exp: 9_999_999_999,
  };
  const payloadB64 = Buffer.from(JSON.stringify(legacyPayload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = createHmac("sha256", SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const token = `${headerB64}.${payloadB64}.${sig}`;

  const result = verifyPrepareToken({ token, secret: SECRET });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "payload_invalid");
});

test("verifyPrepareToken rejects an expired token", () => {
  const issuedAt = new Date("2026-05-20T12:00:00Z");
  const sixMinLater = new Date(issuedAt.getTime() + 6 * 60 * 1000);
  const token = signPrepareToken({
    payload: baseFields,
    secret: SECRET,
    now: () => issuedAt,
  });
  const result = verifyPrepareToken({
    token,
    secret: SECRET,
    now: () => sixMinLater,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired");
});

test("verifyPrepareToken rejects a tampered signature", () => {
  const token = signPrepareToken({
    payload: baseFields,
    secret: SECRET,
  });
  // Tamper by flipping a bit in the DECODED signature, then re-encoding.
  //
  // The previous version flipped the last character of the base64url segment,
  // which is flaky at ~6%: a 32-byte digest encodes to 43 base64url chars, so
  // the final char carries 4 significant bits plus 2 padding bits. Sixteen
  // characters are therefore possible in that position, and the one that
  // shares its top 4 bits with "a" (0b011010) is "Y" (0b011000) — whenever the
  // signature happened to end in "Y", flipping it to "a" produced a DIFFERENT
  // STRING that decodes to IDENTICAL BYTES, so verification correctly
  // succeeded and the assertion below blew up. Measured over 4000 signatures:
  // 239/4000 = 6.0% collision rate, every one of them a "Y".
  //
  // (That malleability is a property of base64, not a flaw in the HMAC check —
  // verifyPrepareToken compares decoded bytes, which is right. Only the test's
  // tampering strategy was wrong.)
  const parts = token.split(".");
  const sigBytes = Buffer.from(parts[2]!, "base64url");
  sigBytes[0] = sigBytes[0]! ^ 0xff; // always changes the bytes, never just the encoding
  const tampered = `${parts[0]}.${parts[1]}.${sigBytes.toString("base64url")}`;

  const result = verifyPrepareToken({ token: tampered, secret: SECRET });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_signature");
});

test("verifyPrepareToken rejects a tampered payload (mint swap)", () => {
  const token = signPrepareToken({
    payload: baseFields,
    secret: SECRET,
  });
  // Replace the payload segment with one we built ourselves but didn't
  // resign — the HMAC won't match.
  const parts = token.split(".");
  const evilPayload = Buffer.from(
    JSON.stringify({
      ...baseFields,
      mintAddress: "EvilMint11111111111111111111111111111111111",
      iat: 0,
      exp: 9_999_999_999,
    }),
    "utf8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const tampered = `${parts[0]}.${evilPayload}.${parts[2]}`;

  const result = verifyPrepareToken({ token: tampered, secret: SECRET });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_signature");
});

test("verifyPrepareToken rejects when the secret differs", () => {
  const token = signPrepareToken({ payload: baseFields, secret: SECRET });
  const result = verifyPrepareToken({
    token,
    secret: SECRET.split("").reverse().join(""),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_signature");
});

test("verifyPrepareToken rejects a malformed token", () => {
  assert.equal(
    verifyPrepareToken({ token: "no-dots-here", secret: SECRET }).ok,
    false,
  );
  assert.equal(
    verifyPrepareToken({ token: "one.dot", secret: SECRET }).ok,
    false,
  );
});

test("verifyPrepareToken rejects a foreign header (different version)", () => {
  // Hand-craft a token with a different header string but the right
  // structure + signature for THAT header — exercises the version check.
  const headerB64 = Buffer.from("not-our-header", "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payloadB64 = Buffer.from(
    JSON.stringify({ ...baseFields, iat: 0, exp: 9_999_999_999 }),
    "utf8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = createHmac("sha256", SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const token = `${headerB64}.${payloadB64}.${sig}`;

  const result = verifyPrepareToken({ token, secret: SECRET });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "wrong_header");
});

test("signPrepareToken rejects too-short secrets", () => {
  assert.throws(
    () =>
      signPrepareToken({
        payload: baseFields,
        secret: "short",
      }),
    /≥16 chars/,
  );
});

test("signPrepareToken honors a custom TTL", () => {
  const now = () => new Date("2026-05-20T12:00:00Z");
  const token = signPrepareToken({
    payload: baseFields,
    secret: SECRET,
    ttlSeconds: 30,
    now,
  });
  const result = verifyPrepareToken({ token, secret: SECRET, now });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.exp - result.payload.iat, 30);
  }
});
