/**
 * How a credit pack can be paid for on this server, from the rails GET /api/billing/packages
 * reports. Pure: the Billing page draws a button only for a rail that is live.
 */
import type { BillingRails } from "./api";

export interface PackPayment {
  /** "Purchase": a card checkout exists (Stripe, or the test checkout of a development server). */
  card: boolean;
  /** "Pay with Wallet": the wallet top-up is on and names at least one asset. */
  wallet: boolean;
  /** Said under the packs when neither is live; null otherwise. */
  notice: string | null;
}

export const NO_WAY_TO_PAY = "Adding credits is temporarily unavailable. Try again later.";
/** Said under the packs when the server could not be asked which rails are live. */
export const RAILS_NOT_READ = "Could not check how you can pay right now. Reload the page to try again.";

/**
 * `rails` is null until the server has said which rails are live: until then nothing is offered.
 * `readFailed` is true when that read failed: still no button, and the page says why.
 */
export function packPayment(rails: BillingRails | null | undefined, readFailed = false): PackPayment {
  const card = rails?.stripeCheckout === true || rails?.mockCheckout === true;
  const wallet =
    rails?.wallet === true && Array.isArray(rails.walletAssets) && rails.walletAssets.length > 0;
  return {
    card,
    wallet,
    notice: rails ? (!card && !wallet ? NO_WAY_TO_PAY : null) : readFailed ? RAILS_NOT_READ : null,
  };
}
