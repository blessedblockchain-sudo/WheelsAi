/**
 * The rules for requesting a payout, as arithmetic on whole cents.
 *
 *   - The smallest payout is MIN_PAYOUT_CENTS, for every method.
 *   - The amount is the one asked for, or the largest allowed right now.
 *   - Credits: any amount from the minimum up to the balance.
 *   - A wallet method (USDC, SOL): at most `perPayoutCents` a payout and
 *     `perDayCents` a UTC day, and an address that is an ordinary wallet,
 *     is not one of the platform's own, and is not a token account or a
 *     program by the chain's own account.
 *   - One open payout per creator.
 *
 * `planPayoutRequest` answers the amount to reserve, or ONE refusal, checked
 * in the order the API documents. `payoutLimits` is what a screen is told
 * before anyone asks.
 *
 * Pure: every fact is passed in (the balance, the limits, what was used
 * today, what the chain said). Amounts are bigint cents; no float decides
 * anything.
 */

import { PublicKey } from "@solana/web3.js";
import {
  MIN_PAYOUT_CENTS,
  isPayoutMethod,
  isWalletPayoutMethod,
  type PayoutMethod,
} from "@wheelsai/shared/payouts";

import type { PayoutRefusal } from "./payoutSentences.js";

const MIN = BigInt(MIN_PAYOUT_CENTS);

const smallest = (...values: bigint[]): bigint => values.reduce((a, b) => (b < a ? b : a));
const notBelowZero = (value: bigint): bigint => (value < 0n ? 0n : value);

// ============================================
// The UTC day
// ============================================

/** Midnight UTC at the start of the day `now` is in. The day limit counts from here. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ============================================
// Limits
// ============================================

/** The facts the limits are worked out from. */
export interface PayoutLimitFacts {
  /** What the creator is owed now. */
  balanceCents: bigint;
  /** The most one payout to a wallet may be. */
  perPayoutCents: bigint;
  /** The most a creator may take to a wallet in one UTC day. */
  perDayCents: bigint;
  /** This creator's wallet payouts requested today that are pending, processing or completed. */
  usedTodayCents: bigint;
  /** SOL is offered only while it can be priced. */
  solOffered: boolean;
}

/** `payoutLimits` on GET /api/marketplace/revenue. Whole cents, as numbers. */
export interface PayoutLimits {
  minimumCents: number;
  perPayoutCents: number;
  perDayCents: number;
  usedTodayCents: number;
  /**
   * The most that can be requested right now, by kind of method. It can be
   * below `minimumCents` (a balance of $3.10 is $3.10 here): then nothing
   * can be requested that way yet.
   */
  largestNowCents: { credits: number; wallet: number };
  /** The methods offered now. */
  methods: PayoutMethod[];
}

/** What is left of today's wallet limit. Never below zero. */
export function walletLeftTodayCents(facts: Pick<PayoutLimitFacts, "perDayCents" | "usedTodayCents">): bigint {
  return notBelowZero(facts.perDayCents - notBelowZero(facts.usedTodayCents));
}

/** The most a creator can request right now with a method of each kind. */
export function largestPayoutNowCents(facts: PayoutLimitFacts): { credits: bigint; wallet: bigint } {
  const balance = notBelowZero(facts.balanceCents);
  return {
    credits: balance,
    wallet: smallest(balance, notBelowZero(facts.perPayoutCents), walletLeftTodayCents(facts)),
  };
}

export function payoutLimits(facts: PayoutLimitFacts): PayoutLimits {
  const largest = largestPayoutNowCents(facts);
  return {
    minimumCents: MIN_PAYOUT_CENTS,
    perPayoutCents: Number(notBelowZero(facts.perPayoutCents)),
    perDayCents: Number(notBelowZero(facts.perDayCents)),
    usedTodayCents: Number(notBelowZero(facts.usedTodayCents)),
    largestNowCents: { credits: Number(largest.credits), wallet: Number(largest.wallet) },
    methods: facts.solOffered ? ["credits", "crypto_usdc", "crypto_sol"] : ["credits", "crypto_usdc"],
  };
}

/** A limit set in whole dollars (PAYOUT_MAX_PER_PAYOUT_USD), as cents. */
export function usdSettingToCents(usd: number): bigint {
  if (!Number.isSafeInteger(usd) || usd < 0) {
    throw new Error("a payout limit must be a whole, non-negative number of dollars");
  }
  return BigInt(usd) * 100n;
}

// ============================================
// The address
// ============================================

/**
 * The address as an ordinary wallet address, in its canonical base58, or
 * null: it must decode to 32 bytes and be a point on the curve. An address
 * off the curve is a program's own account and has no key that could ever
 * move what is sent to it.
 */
export function readWalletAddress(address: unknown): string | null {
  if (typeof address !== "string") return null;
  const text = address.trim();
  // 32 bytes in base58 is 32 to 44 characters.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return null;
  try {
    const key = new PublicKey(text);
    if (!PublicKey.isOnCurve(key.toBytes())) return null;
    return key.toBase58();
  } catch {
    return null;
  }
}

/**
 * A real 32-byte address that is off the curve: a token account (every
 * associated token account is one) or another account a program owns.
 * Pasting a token account in place of the wallet that owns it is the usual
 * mistake, and it deserves the sentence that says so.
 */
export function isOffCurveAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  const text = address.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
  try {
    return !PublicKey.isOnCurve(new PublicKey(text).toBytes());
  } catch {
    return false;
  }
}

/**
 * What one read of the chain said about the address.
 *   absent        no account there yet: an unused wallet, which is fine
 *   wallet        an account that is neither of the two below
 *   not_a_wallet  owned by the token program (a token account or a mint),
 *                 or executable (a program)
 *   unavailable   the read failed, so nothing is known
 */
export type AddressOnChain = "absent" | "wallet" | "not_a_wallet" | "unavailable";

// ============================================
// The plan
// ============================================

export interface PayoutRequestFacts extends PayoutLimitFacts {
  /** The method asked for, as it arrived. */
  method: unknown;
  /** The amount asked for in cents, or null for the largest allowed now. */
  amountCents: bigint | null;
  /** The address asked for, as it arrived, or null. */
  address: string | null;
  /** The creator has a payout that is pending or processing. */
  hasOpenPayout: boolean;
  /** The paying wallet, the treasury and this organization's deposit address. */
  platformAddresses: readonly string[];
  /** What the chain said about the address, or null when it has not been read. */
  addressOnChain: AddressOnChain | null;
}

export type PayoutPlan =
  | {
      outcome: "reserve";
      method: PayoutMethod;
      amountCents: bigint;
      /** The canonical address for a wallet method; null for credits. */
      address: string | null;
      /** The amount is the most one payout to a wallet may be. */
      atCap: boolean;
    }
  /**
   * Every check that needs no chain passed. Read the chain for `address`
   * once and plan again with the answer.
   */
  | { outcome: "read_address"; address: string }
  | { outcome: "refuse"; refusal: PayoutRefusal };

const refuse = (refusal: PayoutRefusal): PayoutPlan => ({ outcome: "refuse", refusal });

/**
 * One request, checked in the documented order: the method, the open
 * payout, the minimum, the balance, the wallet limits, the address, the
 * chain's word on the address. The first check that does not pass is the
 * answer; nothing may be reserved unless the outcome is "reserve".
 */
export function planPayoutRequest(facts: PayoutRequestFacts): PayoutPlan {
  const { method } = facts;
  if (!isPayoutMethod(method)) return refuse({ code: "invalid_payload" });
  if (
    typeof facts.balanceCents !== "bigint" ||
    typeof facts.perPayoutCents !== "bigint" ||
    typeof facts.perDayCents !== "bigint" ||
    typeof facts.usedTodayCents !== "bigint"
  ) {
    throw new Error("planPayoutRequest: the balance and the limits must be bigint cents");
  }
  const asked = facts.amountCents;
  if (asked !== null && (typeof asked !== "bigint" || asked <= 0n)) return refuse({ code: "invalid_payload" });

  const wallet = isWalletPayoutMethod(method);
  if (method === "crypto_sol" && !facts.solOffered) return refuse({ code: "payout_method_unavailable" });
  if (facts.hasOpenPayout) return refuse({ code: "payout_in_progress" });

  // The minimum, then the balance.
  const balance = notBelowZero(facts.balanceCents);
  if (balance < MIN) return refuse({ code: "payout_below_minimum", balanceCents: balance });
  if (asked !== null && asked < MIN) return refuse({ code: "payout_below_minimum" });
  if (asked !== null && asked > balance) return refuse({ code: "payout_above_balance", balanceCents: balance });

  if (!wallet) {
    return { outcome: "reserve", method, amountCents: asked ?? balance, address: null, atCap: false };
  }

  // The wallet limits: one payout, then the day.
  const perPayout = notBelowZero(facts.perPayoutCents);
  if (asked !== null && asked > perPayout) return refuse({ code: "payout_above_limit", perPayoutCents: perPayout });
  const leftToday = walletLeftTodayCents(facts);
  // With less than the smallest payout left today, nothing more can go to a
  // wallet today, whatever was asked for.
  if (leftToday < MIN || (asked !== null && asked > leftToday)) return refuse({ code: "payout_daily_limit" });
  const amountCents = asked ?? smallest(balance, perPayout, leftToday);
  // Settings that put one payout's limit below the minimum offer nothing.
  if (amountCents < MIN) return refuse({ code: "payout_above_limit", perPayoutCents: perPayout });

  // The address.
  if (typeof facts.address !== "string" || facts.address.trim().length === 0) {
    return refuse({ code: "payout_address_required" });
  }
  const address = readWalletAddress(facts.address);
  if (!address) {
    return refuse({
      code: "invalid_payout_address",
      problem: isOffCurveAddress(facts.address) ? "not_a_wallet" : "not_an_address",
    });
  }
  const own = new Set(facts.platformAddresses.map((a) => readWalletAddress(a) ?? a));
  if (own.has(address)) return refuse({ code: "invalid_payout_address", problem: "platform" });

  // The chain's word on it.
  switch (facts.addressOnChain) {
    case null:
      return { outcome: "read_address", address };
    case "absent":
    case "wallet":
      return { outcome: "reserve", method, amountCents, address, atCap: amountCents === perPayout };
    case "not_a_wallet":
      return refuse({ code: "invalid_payout_address", problem: "not_a_wallet" });
    default:
      // "unavailable", and anything this code does not know: nothing is known.
      return refuse({ code: "payout_check_unavailable" });
  }
}
