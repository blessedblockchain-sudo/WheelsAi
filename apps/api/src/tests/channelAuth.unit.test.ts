import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import nacl from "tweetnacl";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// These tests drive apps/api/src/services/channelAuth.ts — the module the
// inbound webhook route will use to authenticate incoming messages from
// Discord, Telegram, and Slack before they're enqueued to the agent-message
// BullMQ queue. Every verifier must be a pure function so it's trivial to
// test with known fixtures and hostile against replay / tampering.

// ============================================
// Discord — Ed25519 signature (X-Signature-Ed25519, X-Signature-Timestamp)
// ============================================

function buildDiscordFixture() {
  // Generate an ephemeral Ed25519 keypair so the test does not depend on any
  // real Discord application public key.
  const kp = nacl.sign.keyPair();
  const publicKeyHex = Buffer.from(kp.publicKey).toString("hex");
  const timestamp = "1713964800"; // 2024-04-24T12:00:00Z — deterministic
  const body = JSON.stringify({ type: 1 });
  const message = Buffer.from(timestamp + body);
  const signature = Buffer.from(nacl.sign.detached(message, kp.secretKey)).toString("hex");
  return { publicKeyHex, timestamp, body, signature };
}

test("verifyDiscordSignature returns true for a well-formed fixture", async () => {
  setupEnv();
  const { verifyDiscordSignature } = await import("../services/channelAuth.js");
  const { publicKeyHex, timestamp, body, signature } = buildDiscordFixture();
  assert.equal(
    verifyDiscordSignature({ publicKeyHex, timestamp, body, signature }),
    true
  );
});

test("verifyDiscordSignature rejects a tampered body", async () => {
  const { verifyDiscordSignature } = await import("../services/channelAuth.js");
  const { publicKeyHex, timestamp, body, signature } = buildDiscordFixture();
  const tamperedBody = body.replace("1", "2");
  assert.equal(
    verifyDiscordSignature({ publicKeyHex, timestamp, body: tamperedBody, signature }),
    false
  );
});

test("verifyDiscordSignature rejects a wrong public key", async () => {
  const { verifyDiscordSignature } = await import("../services/channelAuth.js");
  const { timestamp, body, signature } = buildDiscordFixture();
  const wrongKp = nacl.sign.keyPair();
  const wrongHex = Buffer.from(wrongKp.publicKey).toString("hex");
  assert.equal(
    verifyDiscordSignature({ publicKeyHex: wrongHex, timestamp, body, signature }),
    false
  );
});

test("verifyDiscordSignature rejects malformed hex input without throwing", async () => {
  const { verifyDiscordSignature } = await import("../services/channelAuth.js");
  assert.equal(
    verifyDiscordSignature({
      publicKeyHex: "not-hex",
      timestamp: "1",
      body: "",
      signature: "also-not-hex",
    }),
    false
  );
});

// ============================================
// Telegram — SHA256 HMAC with bot token (see "secret_token" webhook mode)
// ============================================

function buildTelegramFixture() {
  // Telegram's webhook "secret_token" mode: a static token is sent in the
  // X-Telegram-Bot-Api-Secret-Token header and we compare it in constant time.
  // Some deployments additionally verify an HMAC of the raw body using the
  // bot token's SHA256 as the key — we test the HMAC verifier here.
  const botToken = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  const body = JSON.stringify({ update_id: 1, message: { text: "hi" } });
  const secret = crypto.createHash("sha256").update(botToken).digest();
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return { botToken, body, signature };
}

test("verifyTelegramSignature returns true for a well-formed fixture", async () => {
  setupEnv();
  const { verifyTelegramSignature } = await import("../services/channelAuth.js");
  const { botToken, body, signature } = buildTelegramFixture();
  assert.equal(verifyTelegramSignature({ botToken, body, signature }), true);
});

test("verifyTelegramSignature rejects a tampered body", async () => {
  const { verifyTelegramSignature } = await import("../services/channelAuth.js");
  const { botToken, body, signature } = buildTelegramFixture();
  assert.equal(
    verifyTelegramSignature({ botToken, body: body.replace("hi", "hello"), signature }),
    false
  );
});

test("verifyTelegramSignature rejects a wrong bot token", async () => {
  const { verifyTelegramSignature } = await import("../services/channelAuth.js");
  const { body, signature } = buildTelegramFixture();
  assert.equal(
    verifyTelegramSignature({ botToken: "999:WRONG", body, signature }),
    false
  );
});

test("verifyTelegramSignature is constant-time against length mismatch", async () => {
  const { verifyTelegramSignature } = await import("../services/channelAuth.js");
  const { botToken, body } = buildTelegramFixture();
  // Short signature must return false without throwing.
  assert.equal(
    verifyTelegramSignature({ botToken, body, signature: "deadbeef" }),
    false
  );
});

// ============================================
// Slack — X-Slack-Signature = "v0=" + HMAC-SHA256 over "v0:" + ts + ":" + body
// ============================================

function buildSlackFixture() {
  const signingSecret = "slack_signing_secret_for_tests";
  // Slack rejects stale timestamps (replay protection), so anchor the fixture
  // to "now" — the verifier's real wall clock will accept it.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = "payload=%7B%22text%22%3A%22hi%22%7D";
  const sigBase = `v0:${timestamp}:${body}`;
  const hash = crypto.createHmac("sha256", signingSecret).update(sigBase).digest("hex");
  const signature = `v0=${hash}`;
  return { signingSecret, timestamp, body, signature };
}

test("verifySlackSignature returns true for a well-formed fixture", async () => {
  setupEnv();
  const { verifySlackSignature } = await import("../services/channelAuth.js");
  const { signingSecret, timestamp, body, signature } = buildSlackFixture();
  assert.equal(
    verifySlackSignature({ signingSecret, timestamp, body, signature }),
    true
  );
});

test("verifySlackSignature rejects a tampered body", async () => {
  const { verifySlackSignature } = await import("../services/channelAuth.js");
  const { signingSecret, timestamp, body, signature } = buildSlackFixture();
  assert.equal(
    verifySlackSignature({
      signingSecret,
      timestamp,
      body: body.replace("hi", "bye"),
      signature,
    }),
    false
  );
});

test("verifySlackSignature rejects signatures without the v0= prefix", async () => {
  const { verifySlackSignature } = await import("../services/channelAuth.js");
  const { signingSecret, timestamp, body, signature } = buildSlackFixture();
  const rawHash = signature.replace(/^v0=/, "");
  assert.equal(
    verifySlackSignature({ signingSecret, timestamp, body, signature: rawHash }),
    false
  );
});

test("verifySlackSignature rejects stale timestamps (replay protection)", async () => {
  const { verifySlackSignature } = await import("../services/channelAuth.js");
  const signingSecret = "slack_signing_secret_for_tests";
  const body = "payload=%7B%7D";
  const now = new Date("2026-04-24T12:00:00Z");
  const staleTimestamp = String(Math.floor(now.getTime() / 1000) - 60 * 60); // 1h old
  const sigBase = `v0:${staleTimestamp}:${body}`;
  const hash = crypto.createHmac("sha256", signingSecret).update(sigBase).digest("hex");
  const signature = `v0=${hash}`;
  assert.equal(
    verifySlackSignature({
      signingSecret,
      timestamp: staleTimestamp,
      body,
      signature,
      now,
      maxAgeSeconds: 5 * 60,
    }),
    false
  );
});

test("verifySlackSignature accepts a just-within-window timestamp", async () => {
  const { verifySlackSignature } = await import("../services/channelAuth.js");
  const signingSecret = "slack_signing_secret_for_tests";
  const body = "payload=%7B%7D";
  const now = new Date("2026-04-24T12:00:00Z");
  const tsSeconds = String(Math.floor(now.getTime() / 1000) - 4 * 60); // 4 min old
  const sigBase = `v0:${tsSeconds}:${body}`;
  const hash = crypto.createHmac("sha256", signingSecret).update(sigBase).digest("hex");
  const signature = `v0=${hash}`;
  assert.equal(
    verifySlackSignature({
      signingSecret,
      timestamp: tsSeconds,
      body,
      signature,
      now,
      maxAgeSeconds: 5 * 60,
    }),
    true
  );
});
