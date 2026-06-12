/**
 * Short-lived HMAC-signed token that carries the state from the launch
 * "prepare" endpoint to the "submit" endpoint.
 *
 * Launchpad-neutral: it carries the active adapter id plus an opaque
 * adapter `context` (e.g. Bags' configKey), so the submit step can hand
 * the right adapter exactly the state prepare produced — tamper-proof,
 * since the whole payload is HMAC'd.
 *
 * Why a token instead of Redis/DB state: keeping the linkage stateless
 * means no extra moving piece in the launch path, and the only thing
 * worth remembering between requests (the ephemeral mint pubkey plus
 * the listing+org binding) is small enough to round-trip as a header.
 *
 * Threat model (what this token defends against):
 *   - Client swaps in a *different* mint between prepare/submit and
 *     tricks the server into broadcasting an unrelated tx.
 *   - Client replays an old prepare-token after eligibility changed.
 *   - Client forwards a prepare-token from one org to another.
 *
 * What this token does NOT defend against:
 *   - A user signing a tx they don't intend to. That's the wallet
 *     adapter's job (and the wallet shows the tx contents before
 *     signing).
 *   - A leaked HMAC secret. Treat WALLET_PREPARE_TOKEN_SECRET (or the
 *     JWT_SECRET fallback) as a server secret.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER = "wheelsai-pumpfun-prep-v1";
const DEFAULT_TTL_SECONDS = 5 * 60; // 5 min

// ============================================
// Types
// ============================================

export interface PreparePayload {
  /** Ephemeral mint pubkey generated server-side during prepare. */
  mintAddress: string;
  /** AgentListing being tokenized. */
  agentListingId: string;
  /** Org of the authenticated user that ran prepare. */
  orgId: string;
  /** Creator pubkey (user's wallet) that prepared this tx. */
  creatorPubkey: string;
  /**
   * User-submitted fields the wallet committed to when it signed the
   * prepared tx. Carried in the token so the /submit step persists
   * exactly what was signed — the client can't substitute a different
   * name/symbol/description between prepare and submit.
   */
  name: string;
  symbol: string;
  description: string;
  imageUri?: string;
  /** Launchpad adapter id that produced this prepare (e.g. "pumpfun"). */
  launchpad: string;
  /**
   * Opaque adapter-specific state the submit step hands back to the
   * adapter (e.g. Bags' configKey). Empty object for pump.fun. HMAC'd
   * with the rest of the payload, so the client cannot mutate it.
   */
  context: Record<string, unknown>;
  /** Issued-at unix seconds. */
  iat: number;
  /** Expires-at unix seconds. */
  exp: number;
}

export interface SignPrepareTokenInput {
  payload: Omit<PreparePayload, "iat" | "exp">;
  secret: string;
  ttlSeconds?: number;
  now?: () => Date;
}

export interface VerifyPrepareTokenInput {
  token: string;
  secret: string;
  now?: () => Date;
}

// ============================================
// Encoding helpers
// ============================================

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

// ============================================
// signPrepareToken
// ============================================

export function signPrepareToken(input: SignPrepareTokenInput): string {
  if (!input.secret || input.secret.length < 16) {
    throw new Error("signPrepareToken: secret must be ≥16 chars");
  }
  const now = (input.now ?? (() => new Date()))();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: PreparePayload = { ...input.payload, iat, exp };

  const headerB64 = b64url(Buffer.from(HEADER, "utf8"));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sigB64 = b64url(hmac(input.secret, `${headerB64}.${payloadB64}`));
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

// ============================================
// verifyPrepareToken
// ============================================

export type VerifyResult =
  | { ok: true; payload: PreparePayload }
  | { ok: false; reason: VerifyFailure };

export type VerifyFailure =
  | "malformed"
  | "wrong_header"
  | "bad_signature"
  | "expired"
  | "payload_invalid";

export function verifyPrepareToken(
  input: VerifyPrepareTokenInput,
): VerifyResult {
  const parts = input.token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let headerStr: string;
  try {
    headerStr = b64urlDecode(headerB64).toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (headerStr !== HEADER) return { ok: false, reason: "wrong_header" };

  const expectedSig = hmac(input.secret, `${headerB64}.${payloadB64}`);
  let providedSig: Buffer;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // timingSafeEqual requires equal-length buffers; mismatched length is
  // already a fail, but compare anyway against a same-length buffer to
  // keep the path constant-time.
  if (providedSig.length !== expectedSig.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: PreparePayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "payload_invalid" };
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.mintAddress !== "string" ||
    typeof payload.agentListingId !== "string" ||
    typeof payload.orgId !== "string" ||
    typeof payload.creatorPubkey !== "string" ||
    typeof payload.name !== "string" ||
    typeof payload.symbol !== "string" ||
    typeof payload.description !== "string" ||
    (payload.imageUri !== undefined && typeof payload.imageUri !== "string") ||
    typeof payload.launchpad !== "string" ||
    typeof payload.context !== "object" ||
    payload.context === null ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "payload_invalid" };
  }

  const now = (input.now ?? (() => new Date()))();
  const nowSec = Math.floor(now.getTime() / 1000);
  if (nowSec >= payload.exp) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}
