/**
 * Paying from a wallet, as the creator meets it on the Sell tab: the switch
 * that lets people with no account pay one use of an agent from their own
 * Solana wallet (the x402 door), its words, when it is drawn, and what a
 * save sends for it.
 *
 * Pure, so the screens only lay it out. The switch lives here and not in
 * SellForm: the form's shape is pinned by many tests, and the switch is only
 * ever about one choice, pay per use of an agent.
 *
 * The API refuses the switch on for anything but an agent's listing sold per
 * use, and turns it off by itself in the same write when the pricing or what
 * is sold moves away from pay per use. An edit that moves away while carrying
 * it on is refused whole, so a save sends it only when the switch itself
 * changes (x402SaveOf).
 */
import { PLATFORM_FEE_PERCENT } from "@wheelsai/shared/revenue";

import { formatCents } from "./jobs";
import {
  MAX_PRICE_PER_USE_CENTS,
  priceCentsOf,
  type SellChoiceId,
  type SellForm,
  type SellLimits,
  type SellSubject,
  type SellWhat,
} from "./sell-choice";

/**
 * How long an answer paid from a wallet may take to be ready, in seconds.
 * The API's X402_ANSWER_DEADLINE_MS (services/x402DoorRules.ts) is the rule;
 * the capabilities do not send it, so it is written here once and a test
 * holds it to the API's constant.
 */
export const WALLET_ANSWER_WITHIN_SECONDS = 30;

/** The creator's share of a sale, in percent, from the one rule the API pays by. */
const CREATOR_PERCENT = 100 - PLATFORM_FEE_PERCENT;

export const WALLET_PAYMENT_WORDS = {
  /** The switch's label. */
  label: "Let people with no account pay from a Solana wallet",
  /** The first sentence under it, with the price of one use. */
  price: (price: string) =>
    `Each use costs ${price} in USDC, paid from their own wallet with an x402 client: no account and no key.`,
  order:
    "The request is answered first; the payment is sent only then, and the answer is released when Solana confirms it.",
  noAnswer: "When there is no answer, nothing is sent and nothing is charged.",
  earn: `You earn ${CREATOR_PERCENT}% of each use, as with any sale.`,
  deadline: (seconds: number) =>
    `An answer paid this way must be ready within ${seconds} seconds, or it is stopped and nothing is charged.`,
  /** On the Sell tab of a listing on sale with the switch on. */
  on: "Paying from a wallet is on.",
} as const;

/**
 * Whether the switch is drawn: only for an agent, selling use, with pay per
 * use chosen, and only when the capabilities say paying from a wallet is
 * available. Everything else draws nothing.
 */
export function walletPaymentsShown(input: {
  subject?: SellSubject;
  sells: SellWhat;
  choice: SellChoiceId;
  available: boolean;
}): boolean {
  return (input.subject ?? "agent") === "agent" && input.sells === "use" && input.choice === "per_use" && input.available === true;
}

/**
 * The price of one use the lines name: the typed price, when it is whole
 * cents the listing can be sold at. null while it is not, so no line names
 * a price that cannot be saved.
 */
export function walletPaymentPriceCents(form: SellForm, limits: Pick<SellLimits, "minPerUseCents">): number | null {
  if (form.sells !== "use" || form.choice !== "per_use") return null;
  const cents = priceCentsOf(form);
  if (cents === null || cents < limits.minPerUseCents || cents > MAX_PRICE_PER_USE_CENTS) return null;
  return cents;
}

/**
 * The lines under the switch: what a payment from a wallet is and what the
 * creator earns, then how long the answer may take. While no price can be
 * read, the sentence that names it is left out and the rest stays.
 */
export function walletPaymentLines(
  priceCents: number | null,
  answerWithinSeconds: number = WALLET_ANSWER_WITHIN_SECONDS,
): [about: string, deadline: string] {
  const about = [
    ...(priceCents !== null ? [WALLET_PAYMENT_WORDS.price(formatCents(priceCents))] : []),
    WALLET_PAYMENT_WORDS.order,
    WALLET_PAYMENT_WORDS.noAnswer,
    WALLET_PAYMENT_WORDS.earn,
  ];
  return [about.join(" "), WALLET_PAYMENT_WORDS.deadline(answerWithinSeconds)];
}

/** The listing as saved, as far as the switch is concerned. */
export interface WalletListing {
  x402Enabled?: boolean | null;
  sells?: string | null;
  pricingModel?: string;
}

/**
 * What a save sends for the switch, to be spread into the listing's create
 * or update body:
 * - `{ x402Enabled }` when pay per use stays chosen, paying from a wallet is
 *   available, and the switch differs from the saved value;
 * - `{ x402Enabled: false }` when the choice left pay per use while the
 *   saved switch was on (turning it off is always allowed; the API would
 *   turn it off by itself too);
 * - `{}` otherwise, so an edit that moves away from pay per use never
 *   carries it on.
 */
export function x402SaveOf(input: {
  form: Pick<SellForm, "sells" | "choice">;
  walletPay: boolean;
  listing: Pick<WalletListing, "x402Enabled"> | null | undefined;
  available: boolean;
}): { x402Enabled?: boolean } {
  const saved = input.listing?.x402Enabled === true;
  const perUse = input.form.sells === "use" && input.form.choice === "per_use";
  if (!perUse) return saved ? { x402Enabled: false } : {};
  if (input.available !== true) return {};
  const wanted = input.walletPay === true;
  return wanted === saved ? {} : { x402Enabled: wanted };
}

/**
 * "Paying from a wallet is on.", for a listing on sale whose switch is on,
 * sold per use, while paying from a wallet is available; null otherwise.
 */
export function walletPaymentsOnLine(input: {
  listing: WalletListing | null | undefined;
  available: boolean;
}): string | null {
  const listing = input.listing;
  if (!listing || input.available !== true || listing.x402Enabled !== true) return null;
  if (listing.sells === "copies" || listing.pricingModel !== "per_request") return null;
  return WALLET_PAYMENT_WORDS.on;
}
