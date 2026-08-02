/**
 * Credit packages and bonus tiers — the single source of truth (B2/T1).
 *
 * These numbers were duplicated in routes/billing.ts (the grant math) and
 * apps/web billing page (what the buyer is shown). Two copies of a price
 * is how a user gets told "$100 → +$15" and granted something else, so
 * the API now serves them and the web renders what it is served.
 */

export interface CreditPackage {
  /** Dollars the buyer pays. */
  amount: number;
  /** Bonus dollars granted on top. */
  bonus: number;
  popular?: boolean;
}

/** Minimum top-up, in dollars. */
export const MIN_PURCHASE_DOLLARS = 5;
/** Maximum single top-up, in dollars (server-side ceiling). */
export const MAX_PURCHASE_DOLLARS = 10_000;

export const CREDIT_PACKAGES: CreditPackage[] = [
  { amount: 10, bonus: 0 },
  { amount: 50, bonus: 5, popular: true },
  { amount: 100, bonus: 15 },
  { amount: 500, bonus: 100 },
];

/**
 * Bonus for an arbitrary purchase amount (dollars in, dollars out).
 * Tiered, not table-lookup: free-form amounts between package sizes get
 * the tier they qualify for, and the packages above are just shortcuts
 * onto the same ladder.
 */
export function bonusForAmount(amountDollars: number): number {
  if (amountDollars >= 500) return 100;
  if (amountDollars >= 100) return 15;
  if (amountDollars >= 50) return 5;
  return 0;
}

/** Validate a requested purchase amount. Returns null when acceptable. */
export function validatePurchaseAmount(amountDollars: number): string | null {
  if (!Number.isFinite(amountDollars)) return "Amount must be a number";
  if (amountDollars < MIN_PURCHASE_DOLLARS) {
    return `Minimum purchase amount is $${MIN_PURCHASE_DOLLARS}`;
  }
  if (amountDollars > MAX_PURCHASE_DOLLARS) {
    return `Maximum single purchase is $${MAX_PURCHASE_DOLLARS.toLocaleString()}`;
  }
  return null;
}
