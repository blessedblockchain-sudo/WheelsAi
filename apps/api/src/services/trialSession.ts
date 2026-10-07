/**
 * A Try it session: the token a visitor holds after the human check (a
 * sign-in or a Turnstile pass), and what every Try it message presents.
 *
 * It exists so the human check is made once per session and not once per
 * message - a Turnstile token is single-use. The token is HMAC-signed state
 * (services/signedState.ts) and is bound to three things:
 *
 *   - the listing: a session opened on one listing does not chat with another
 *   - the organization of a signed-in visitor (null for an anonymous one)
 *   - the visitor's address bucket, keyed (services/widgetKeys.ts): a token
 *     copied to another network is refused, so one solved challenge cannot be
 *     handed to a pool of machines. A visitor whose network really changed
 *     (a phone leaving wifi) is asked to verify again.
 *
 * It is NOT single-use: it is presented with each message until it expires,
 * and the messages it may send are counted against its `sessionId` by the
 * limiter. It lives at most 15 minutes, signedState's own ceiling.
 *
 * Pure: the secret and the clock are injected.
 */

import { randomBytes } from "node:crypto";

import { signState, verifyState } from "./signedState.js";

export const TRIAL_SESSION_PURPOSE = "try-it";
export const TRIAL_SESSION_TTL_SECONDS = 900;

export interface TrialSessionDeps {
  secret: string;
  now?: () => Date;
}

export interface IssueTrialSessionInput {
  listingId: string;
  /** The signed-in visitor's organization; null for an anonymous visitor. */
  orgId: string | null;
  /** hashBucket(ipBucket(ip)): never the address itself. */
  ipBucketHash: string;
  ttlSeconds?: number;
}

export interface IssuedTrialSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export function issueTrialSession(input: IssueTrialSessionInput, deps: TrialSessionDeps): IssuedTrialSession {
  const requested = input.ttlSeconds ?? TRIAL_SESSION_TTL_SECONDS;
  const ttlSeconds = Math.max(1, Math.min(TRIAL_SESSION_TTL_SECONDS, Math.floor(requested)));
  const now = (deps.now ?? (() => new Date()))();
  const sessionId = randomBytes(16).toString("base64url");
  const token = signState({
    payload: {
      purpose: TRIAL_SESSION_PURPOSE,
      listingId: input.listingId,
      orgId: input.orgId,
      ipb: input.ipBucketHash,
      sid: sessionId,
    },
    secret: deps.secret,
    ttlSeconds,
    now: () => now,
  });
  return {
    token,
    sessionId,
    expiresAt: new Date((Math.floor(now.getTime() / 1000) + ttlSeconds) * 1000),
  };
}

export type TrialSessionFailure =
  | "expired"
  | "bad_signature"
  | "wrong_listing"
  | "network_changed"
  | "malformed";

export type TrialSessionResult =
  | { ok: true; sessionId: string; orgId: string | null; expiresAt: Date }
  | { ok: false; reason: TrialSessionFailure };

export interface VerifyTrialSessionInput {
  token: unknown;
  listingId: string;
  ipBucketHash: string;
}

export function verifyTrialSession(input: VerifyTrialSessionInput, deps: TrialSessionDeps): TrialSessionResult {
  if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > 2048) {
    return { ok: false, reason: "malformed" };
  }
  const verified = verifyState({
    token: input.token,
    secret: deps.secret,
    expectedPurpose: TRIAL_SESSION_PURPOSE,
    now: deps.now,
  });
  if (!verified.ok) {
    if (verified.reason === "expired") return { ok: false, reason: "expired" };
    // A token signed for another purpose, or checked with a secret this
    // server would not sign with, is not one of ours.
    if (verified.reason === "malformed" || verified.reason === "wrong_header") {
      return { ok: false, reason: "malformed" };
    }
    return { ok: false, reason: "bad_signature" };
  }

  const { listingId, orgId, ipb, sid, exp } = verified.payload;
  if (
    typeof listingId !== "string" ||
    typeof ipb !== "string" ||
    typeof sid !== "string" ||
    sid.length === 0 ||
    !(orgId === null || typeof orgId === "string")
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (listingId !== input.listingId) return { ok: false, reason: "wrong_listing" };
  if (ipb !== input.ipBucketHash) return { ok: false, reason: "network_changed" };
  return { ok: true, sessionId: sid, orgId, expiresAt: new Date(exp * 1000) };
}
