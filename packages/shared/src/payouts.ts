/**
 * What a creator can ask for when taking earnings out, shared by the API
 * and the web so neither writes the numbers a second time.
 *
 * Self-contained on purpose (no imports), like revenue.ts and agentKind.ts:
 * the web app and the API both use it, and it must run in a browser.
 */

/** The smallest payout, in cents, for every method. */
export const MIN_PAYOUT_CENTS = 500;

/** How a payout can be taken. */
export const PAYOUT_METHODS = ["credits", "crypto_usdc", "crypto_sol"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/** The methods that send to a wallet address. They carry the limits. */
export const WALLET_PAYOUT_METHODS = ["crypto_usdc", "crypto_sol"] as const;
export type WalletPayoutMethod = (typeof WALLET_PAYOUT_METHODS)[number];

export function isPayoutMethod(value: unknown): value is PayoutMethod {
  return typeof value === "string" && (PAYOUT_METHODS as readonly string[]).includes(value);
}

export function isWalletPayoutMethod(value: unknown): value is WalletPayoutMethod {
  return typeof value === "string" && (WALLET_PAYOUT_METHODS as readonly string[]).includes(value);
}
