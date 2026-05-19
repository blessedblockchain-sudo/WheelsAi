/**
 * Signature verification for inbound channel webhooks (plan A6).
 *
 * Pure functions: take the raw request pieces, return boolean. The webhook
 * route (routes/channelWebhooks.ts) composes these before enqueueing the
 * message to the agent-message BullMQ queue.
 *
 * Every verifier must:
 *   - never throw on malformed input (return false instead)
 *   - compare hashes in constant time to avoid timing oracles
 *   - reject stale timestamps where the upstream protocol provides one
 */

import crypto from "node:crypto";
import nacl from "tweetnacl";

// ============================================
// Constant-time helpers
// ============================================

function timingSafeEqualHex(a: string, b: string): boolean {
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ============================================
// Discord — Ed25519 over timestamp + body
// ============================================

export interface DiscordVerifyInput {
  publicKeyHex: string;
  timestamp: string;
  body: string;
  signature: string;
}

export function verifyDiscordSignature(input: DiscordVerifyInput): boolean {
  try {
    const pub = Buffer.from(input.publicKeyHex, "hex");
    const sig = Buffer.from(input.signature, "hex");
    if (pub.length !== 32 || sig.length !== 64) return false;
    const message = Buffer.from(input.timestamp + input.body);
    return nacl.sign.detached.verify(message, sig, pub);
  } catch {
    return false;
  }
}

// ============================================
// Telegram — HMAC-SHA256 over body, keyed by SHA256(bot_token)
// ============================================

export interface TelegramVerifyInput {
  botToken: string;
  body: string;
  signature: string;
}

export function verifyTelegramSignature(input: TelegramVerifyInput): boolean {
  try {
    const secret = crypto.createHash("sha256").update(input.botToken).digest();
    const expected = crypto
      .createHmac("sha256", secret)
      .update(input.body)
      .digest("hex");
    return timingSafeEqualHex(expected, input.signature);
  } catch {
    return false;
  }
}

// ============================================
// Slack — v0=HMAC-SHA256 over "v0:" + timestamp + ":" + body
// ============================================

export interface SlackVerifyInput {
  signingSecret: string;
  timestamp: string;
  body: string;
  signature: string;
  /** Defaults to new Date() — injectable for deterministic tests. */
  now?: Date;
  /** Replay-protection window. Slack's recommendation is 5 minutes. */
  maxAgeSeconds?: number;
}

export function verifySlackSignature(input: SlackVerifyInput): boolean {
  try {
    if (!input.signature.startsWith("v0=")) return false;
    const now = input.now ?? new Date();
    const maxAge = input.maxAgeSeconds ?? 5 * 60;
    const tsSeconds = Number.parseInt(input.timestamp, 10);
    if (!Number.isFinite(tsSeconds)) return false;
    const ageSeconds = Math.abs(Math.floor(now.getTime() / 1000) - tsSeconds);
    if (ageSeconds > maxAge) return false;

    const sigBase = `v0:${input.timestamp}:${input.body}`;
    const expected = crypto
      .createHmac("sha256", input.signingSecret)
      .update(sigBase)
      .digest("hex");
    return timingSafeEqualHex(expected, input.signature.slice(3));
  } catch {
    return false;
  }
}
