/**
 * HMAC-signed, TTL-bounded state tokens for OAuth-style redirects.
 *
 * Replaces `generateOAuthState`/`parseOAuthState`, which emitted
 * UNSIGNED base64url JSON containing the orgId and then checked expiry
 * using the `timestamp` field from that same blob. Both properties are
 * fatal for their purpose:
 *
 *   - Unsigned means an attacker mints a state binding an install to any
 *     organization. The callback then plants their workspace token in a
 *     victim's org (or captures a victim's install into theirs).
 *   - Expiry read from attacker-supplied data is not expiry.
 *
 * The mechanism here is the one already proven in
 * services/launchpadPrepareToken.ts — `header.payload.signature`, all
 * base64url, HMAC-SHA256 over `header.payload`, `iat`/`exp` set by the
 * SERVER, and a typed failure union so callers never have to interpret a
 * thrown string.
 *
 * A signature alone is not enough: a signed state is still replayable
 * until it expires. Pair every use with a single-use nonce
 * (services/oauthStateStore.ts). Signed AND one-shot; neither alone.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER = "wheelsai-state-v1";
const DEFAULT_TTL_SECONDS = 600;
const MIN_SECRET_LENGTH = 16;

export interface StatePayload {
  /** What this state authorizes, e.g. "slack-install". Checked on verify. */
  purpose: string;
  /** Server-set issued-at (unix seconds). */
  iat: number;
  /** Server-set expiry (unix seconds). */
  exp: number;
  [key: string]: unknown;
}

export interface SignStateInput {
  payload: Record<string, unknown> & { purpose: string };
  secret: string;
  ttlSeconds?: number;
  now?: () => Date;
}

export type StateVerifyFailure =
  | "malformed"
  | "wrong_header"
  | "bad_signature"
  | "expired"
  | "wrong_purpose";

export type StateVerifyResult =
  | { ok: true; payload: StatePayload }
  | { ok: false; reason: StateVerifyFailure };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signState(input: SignStateInput): string {
  if (!input.secret || input.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`signState: secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (!input.payload.purpose) {
    throw new Error("signState: payload.purpose is required");
  }

  const now = (input.now ?? (() => new Date()))();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: StatePayload = { ...input.payload, iat, exp };

  const headerB64 = b64url(Buffer.from(HEADER, "utf8"));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sigB64 = b64url(hmac(input.secret, `${headerB64}.${payloadB64}`));
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

export interface VerifyStateInput {
  token: string;
  secret: string;
  /** Refuses a token minted for a different flow. */
  expectedPurpose?: string;
  now?: () => Date;
}

export function verifyState(input: VerifyStateInput): StateVerifyResult {
  const parts = input.token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: string;
  try {
    header = Buffer.from(headerB64, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header !== HEADER) return { ok: false, reason: "wrong_header" };

  const expected = hmac(input.secret, `${headerB64}.${payloadB64}`);
  let presented: Buffer;
  try {
    presented = Buffer.from(sigB64, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // timingSafeEqual throws on length mismatch, and the length is
  // attacker-controlled — compare lengths first, then constant-time.
  if (presented.length !== expected.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload?.exp !== "number" || typeof payload?.iat !== "number") {
    return { ok: false, reason: "malformed" };
  }

  // Signature verified BEFORE trusting exp — the old code's mistake was
  // trusting a timestamp it had never authenticated.
  const now = (input.now ?? (() => new Date()))();
  if (Math.floor(now.getTime() / 1000) >= payload.exp) {
    return { ok: false, reason: "expired" };
  }
  if (input.expectedPurpose && payload.purpose !== input.expectedPurpose) {
    return { ok: false, reason: "wrong_purpose" };
  }

  return { ok: true, payload };
}
