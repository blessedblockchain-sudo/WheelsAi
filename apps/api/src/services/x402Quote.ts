// The SOL rate lock of an x402 challenge.
//
// A 402 that asks for SOL is priced at the rate of that moment. The paid
// retry arrives seconds later, when the live rate has moved, so the
// challenge hands out a signed token holding the rate and the retry hands
// it back: the retry's price is worked out again from its own body, in
// micro-dollars, and turned into lamports at the TOKEN's rate.
//
// The token is services/signedState.ts (HMAC, server-set expiry). It names
// the organization and the deployment it was made for and is honoured for
// those two only. It is not single-use and does not need to be: it carries
// a rate, not a payment, and a payment's own signature is what can be used
// once.
//
// Pure: the secret, the lifetime and the clock are handed in. Every way a
// token can be wrong reads the same to the caller: "quote_expired".

import { signState, verifyState } from "./signedState.js";
import type { X402Asset, X402QuoteReading } from "./x402Types.js";

export const X402_QUOTE_PURPOSE = "x402-quote";

/** A clock as signedState takes it, or the moment itself. */
export type X402QuoteClock = Date | (() => Date);

export interface X402QuotePayload {
  orgId: string;
  deploymentId: string;
  asset: X402Asset;
  /** Micro-dollars per SOL, as the challenge priced it. Above zero. */
  solMicroUsdPerSol: bigint;
}

export type ReadX402QuoteResult =
  | { ok: true; quote: X402QuoteReading }
  | { ok: false; reason: "quote_expired" };

const EXPIRED: ReadX402QuoteResult = { ok: false, reason: "quote_expired" };
/** Digits only, no sign, no leading zero: a whole number above zero. */
const POSITIVE_WHOLE = /^[1-9][0-9]{0,38}$/;

function clockOf(now: X402QuoteClock | undefined): (() => Date) | undefined {
  if (now === undefined) return undefined;
  return typeof now === "function" ? now : () => now;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The token a SOL challenge carries. Everything in it is a string. Throws
 * when asked to lock something that is not a rate (a rate not above zero,
 * an asset other than SOL, no organization or deployment), or when the
 * secret or the lifetime is one signState refuses.
 */
export function signX402Quote(
  payload: X402QuotePayload,
  opts: { secret: string; ttlSeconds: number; now?: X402QuoteClock }
): string {
  if (payload.asset !== "SOL") throw new RangeError("signX402Quote: only a SOL price is locked");
  if (typeof payload.solMicroUsdPerSol !== "bigint" || payload.solMicroUsdPerSol <= 0n) {
    throw new RangeError("signX402Quote: the rate is not above zero");
  }
  if (!isNonEmptyString(payload.orgId) || !isNonEmptyString(payload.deploymentId)) {
    throw new RangeError("signX402Quote: the organization and the deployment are required");
  }
  const rate = payload.solMicroUsdPerSol.toString();
  if (!POSITIVE_WHOLE.test(rate)) throw new RangeError("signX402Quote: the rate is not a usable number");

  const now = clockOf(opts.now);
  return signState({
    payload: {
      purpose: X402_QUOTE_PURPOSE,
      orgId: payload.orgId,
      deploymentId: payload.deploymentId,
      asset: payload.asset,
      rate,
    },
    secret: opts.secret,
    ttlSeconds: opts.ttlSeconds,
    ...(now ? { now } : {}),
  });
}

/**
 * Read a token a paid retry presented. The rate, or "quote_expired" for a
 * token that is missing, expired, forged, made for another purpose, or made
 * for another organization or deployment. Never throws.
 */
export function readX402Quote(
  token: unknown,
  opts: { secret: string; orgId: string; deploymentId: string; now?: X402QuoteClock }
): ReadX402QuoteResult {
  try {
    if (!isNonEmptyString(token)) return EXPIRED;
    if (!isNonEmptyString(opts.orgId) || !isNonEmptyString(opts.deploymentId)) return EXPIRED;

    const now = clockOf(opts.now);
    const verified = verifyState({
      token,
      secret: opts.secret,
      expectedPurpose: X402_QUOTE_PURPOSE,
      ...(now ? { now } : {}),
    });
    if (!verified.ok) return EXPIRED;

    const { orgId, deploymentId, asset, rate } = verified.payload;
    if (orgId !== opts.orgId || deploymentId !== opts.deploymentId) return EXPIRED;
    if (asset !== "SOL") return EXPIRED;
    if (typeof rate !== "string" || !POSITIVE_WHOLE.test(rate)) return EXPIRED;

    return { ok: true, quote: { asset: "SOL", solMicroUsdPerSol: BigInt(rate) } };
  } catch {
    return EXPIRED;
  }
}
