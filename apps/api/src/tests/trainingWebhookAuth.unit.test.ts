import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  deriveTrainingCallbackSecret,
  isTrainingSubmitNonce,
  signTrainingCallback,
  TRAINING_CALLBACK_TOLERANCE_SECONDS,
  verifyTrainingCallbackSignature,
} from "../services/trainingWebhookAuth.js";

// The training container's callbacks mutate a job's progress and carry its
// own report of how the run ended, so each is signed: an HMAC over the raw
// body with a secret derived per job and per submit attempt, inside a
// timestamp window. (The route-level 401 is in trainingRoutes.unit.test.ts.)

const SERVER_SECRET = "s".repeat(32);
const JOB_ID = "0d4f7b1e-3a52-4b8e-9f60-1c2d3e4f5a6b";
const NONCE = "a1b2c3d4e5f60718";
const NOW_MS = Date.parse("2026-10-12T10:00:00.000Z");
const T = NOW_MS / 1000;
const BODY = '{"v":1,"seq":1,"ts":"2026-10-12T10:00:00.000Z","type":"phase","phase":"train","jobId":"x"}';

const secret = deriveTrainingCallbackSecret(JOB_ID, NONCE, SERVER_SECRET);
const verify = (header: unknown, rawBody: string | Buffer = BODY, nowMs = NOW_MS, callbackSecret = secret) =>
  verifyTrainingCallbackSignature({ callbackSecret, header, rawBody, nowMs });

test("the callback secret is deterministic, and scoped to the job AND the submit attempt", () => {
  assert.equal(secret, deriveTrainingCallbackSecret(JOB_ID, NONCE, SERVER_SECRET));
  assert.match(secret, /^[0-9a-f]{64}$/);
  const others = [
    deriveTrainingCallbackSecret("1d4f7b1e-3a52-4b8e-9f60-1c2d3e4f5a6b", NONCE, SERVER_SECRET),
    deriveTrainingCallbackSecret(JOB_ID, "a1b2c3d4e5f60719", SERVER_SECRET),
    deriveTrainingCallbackSecret(JOB_ID, NONCE, "t".repeat(32)),
  ];
  assert.equal(new Set([secret, ...others]).size, 4);
});

test("a job id or nonce that is not ours is refused, not hashed", () => {
  assert.throws(() => deriveTrainingCallbackSecret("another-job", NONCE, SERVER_SECRET), RangeError);
  assert.throws(() => deriveTrainingCallbackSecret(JOB_ID, "short", SERVER_SECRET), RangeError);
  assert.throws(() => deriveTrainingCallbackSecret(JOB_ID, "UPPERCASE0001", SERVER_SECRET), RangeError);
  assert.equal(isTrainingSubmitNonce(NONCE), true);
  for (const bad of ["", "short", "has space 01", "a".repeat(33), 12345678, null, undefined]) {
    assert.equal(isTrainingSubmitNonce(bad), false);
  }
});

test("the signature is the trainer's: HMAC-SHA256(secret, t + '.' + rawBody), hex", () => {
  // Computed the way infra/training/wheelsai_trainer/callbacks.py does.
  const digest = crypto.createHmac("sha256", secret).update(`${T}.${BODY}`).digest("hex");
  assert.equal(signTrainingCallback(secret, T, BODY), `t=${T},v1=${digest}`);
  assert.deepEqual(verify(`t=${T},v1=${digest}`), { ok: true, timestampSeconds: T });
  // The same bytes as a Buffer verify the same.
  assert.equal(verify(`t=${T},v1=${digest}`, Buffer.from(BODY)).ok, true);
});

test("a wrong secret, an altered body and a re-serialised body are rejected", () => {
  const header = signTrainingCallback(secret, T, BODY);
  assert.deepEqual(verify(header, BODY, NOW_MS, deriveTrainingCallbackSecret(JOB_ID, "a1b2c3d4e5f60719", SERVER_SECRET)), {
    ok: false,
    reason: "bad_signature",
  });
  assert.deepEqual(verify(header, BODY.replace('"seq":1', '"seq":2')), { ok: false, reason: "bad_signature" });
  // The same JSON with other spacing is other bytes.
  assert.deepEqual(verify(header, JSON.stringify(JSON.parse(BODY), null, 1)), { ok: false, reason: "bad_signature" });
  // A signature for one timestamp does not hold for another.
  assert.deepEqual(verify(header.replace(`t=${T}`, `t=${T + 1}`)), { ok: false, reason: "bad_signature" });
});

test("a timestamp more than 300 seconds from this clock is rejected, either way", () => {
  assert.equal(TRAINING_CALLBACK_TOLERANCE_SECONDS, 300);
  for (const [offset, ok] of [[-300, true], [300, true], [-301, false], [301, false], [-86_400, false]] as const) {
    const verdict = verify(signTrainingCallback(secret, T + offset, BODY));
    assert.equal(verdict.ok, ok, `offset ${offset}`);
    if (!verdict.ok) assert.equal(verdict.reason, "stale");
  }
});

test("a missing or malformed header is rejected without computing on it", () => {
  for (const missing of [undefined, null, ""]) {
    assert.deepEqual(verify(missing), { ok: false, reason: "missing" });
  }
  const digest = "a".repeat(64);
  for (const malformed of [
    digest,
    `v1=${digest}`,
    `t=${T}`,
    `t=${T},v1=${digest.slice(1)}`,
    `t=${T},v1=${digest.toUpperCase()}`,
    `t=${T}, v1=${digest}`,
    `t=abc,v1=${digest}`,
    `t=${T},v1=${digest},v1=${digest}`,
    ["t=1", "v1=x"],
    "x".repeat(500),
  ]) {
    assert.deepEqual(verify(malformed), { ok: false, reason: "malformed" });
  }
});
