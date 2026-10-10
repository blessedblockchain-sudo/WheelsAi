import { seg, type WheelsAIClient } from "../client.js";

/** Amounts on the billing endpoints are in dollars, not cents. */
export interface CreditBalance {
  available: number;
  pending: number;
  total: number;
}

export interface CreditTransaction {
  id: string;
  /** Dollars. */
  amount: number;
  type: "purchase" | "bonus" | "usage" | "refund" | (string & {});
  description: string;
  createdAt: string;
}

export interface UsageSummary {
  currentMonth: number;
  gpuHours: number;
  avgCostPerHour: number;
  computeCost: number;
  requests: number;
  requestsCost: number;
  inputTokens: number;
  outputTokens: number;
  tokensCost: number;
  metered: { computeSeconds: number; actualComputeCost: number };
}

export interface CreditPackage {
  [field: string]: unknown;
}

export interface BillingPlan {
  plan: string;
  limits: Record<string, unknown>;
  status: string;
  trialEndsAt: string | null;
  trialAvailable: boolean;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasBillingAccount: boolean;
  usage: { agents: number; apiCallsThisMonth: number };
  plans: unknown;
  proSubscriptionAvailable: boolean;
}

/** What a wallet top-up can be paid in. `rails.walletAssets` of `packages()` lists the ones open now. */
export type TopupAsset = "USDC" | "SOL";

/**
 * Where a top-up stands. `submitting` and `submitted` mean the transfer is being
 * confirmed; `credited`, `failed` and `expired` are final.
 */
export type TopupStatus =
  | "prepared"
  | "submitting"
  | "submitted"
  | "credited"
  | "failed"
  | "expired"
  | (string & {});

export interface PrepareTopupInput {
  /** Dollars, within `minPurchase` and `maxPurchase` of `packages()`. */
  amountUsd: number;
  asset: TopupAsset;
  /**
   * The Solana wallet that will sign and pay. Needed with an API key; a session
   * signed in with a wallet pays from that wallet when this is left out.
   */
  payerAddress?: string;
}

export interface PreparedTopup {
  topupId: string;
  /** The whole transfer, ready for the paying wallet to sign. */
  unsignedTxBase64: string;
  /** Your organization's deposit address, which the transfer pays. */
  depositAddress: string;
  payerAddress: string;
  asset: TopupAsset;
  /** Dollars. */
  amountUsd: number;
  /** Dollars. */
  bonusUsd: number;
  /** The amount the wallet sends, in the asset's base units (a string: it can exceed a safe integer). */
  amountRaw: string;
  /** SOL only: the dollars-per-SOL price this top-up was prepared at. */
  quotedSolPriceUsd?: number;
  /** SOL only: the price and the time it holds until. `null` for USDC. */
  quote: { solPriceUsd: number; validUntil: string } | null;
  /** True when this payment also opens your organization's USDC account. */
  opensUsdcAccount: boolean;
  /** After this the top-up can no longer be sent: 60 seconds for SOL, 120 for USDC. */
  expiresAt: string;
  /** A sentence to show the person paying. */
  message: string;
}

/**
 * The answer to `submit` and `reconcile`. `status` says where the top-up stands and
 * `message` is a sentence to show; the other fields are present when they apply.
 */
export interface TopupResult {
  status: TopupStatus;
  message: string;
  txSignature?: string;
  /** Dollars added to your credits, with any bonus. Present once credited. */
  grantedUsd?: number;
  /** Your credit balance in dollars. Present once credited. */
  balanceUsd?: number;
  /** True when the credits had already been added by an earlier call. */
  alreadyCredited?: boolean;
  /** True while the transfer is still being confirmed: ask again with `reconcile`. */
  pendingConfirmation?: boolean;
  pendingSignature?: boolean;
}

export interface Topup {
  id: string;
  status: TopupStatus;
  /** A sentence that says where this top-up stands. */
  message: string;
  asset: TopupAsset;
  /** Dollars. */
  amountUsd: number;
  /** Dollars. */
  bonusUsd: number;
  txSignature?: string;
  depositAddress: string;
  payerAddress: string;
  createdAt: string;
  expiresAt: string;
}

/** True when a top-up has ended (`credited`, `failed` or `expired`) and will not change again. */
export function isTopupFinal(status: TopupStatus): boolean {
  return status === "credited" || status === "failed" || status === "expired";
}

export function billingResource(client: WheelsAIClient) {
  return {
    getBalance: () =>
      client.get<{ balance: CreditBalance }>("/api/billing/balance"),

    /** The latest 50 transactions; the API takes no paging parameters. */
    getTransactions: () =>
      client.get<{ transactions: CreditTransaction[] }>("/api/billing/transactions"),

    /** This calendar month's usage. */
    getUsage: () =>
      client.get<{ usage: UsageSummary }>("/api/billing/usage"),

    plan: () =>
      client.get<BillingPlan>("/api/billing/plan"),

    /** Credit packages, purchase limits and the payment rails open to you. */
    packages: () =>
      client.get<{
        packages: CreditPackage[];
        minPurchase: number;
        maxPurchase: number;
        /** `wallet` and `walletAssets` say whether `topups` is open and in which assets. */
        rails: Record<string, unknown>;
      }>("/api/billing/packages"),

    /**
     * Start a credit purchase (`POST /api/billing/checkout`). `amountDollars` is in
     * dollars. Session credentials of an owner or admin only. Returns a URL to
     * complete the payment; credits are granted after payment, never by this call.
     */
    checkout: (amountDollars: number) =>
      client.post<{ checkoutUrl: string; message?: string }>("/api/billing/checkout", { amount: amountDollars }),

    /** Pro plan checkout (session credentials, owner or admin). */
    subscriptionCheckout: () =>
      client.post<{ checkoutUrl: string; trialDays: number }>("/api/billing/subscription/checkout", { plan: "pro" }),

    /** Stripe billing portal (session credentials, owner or admin). */
    portal: () =>
      client.post<{ url: string }>("/api/billing/portal"),

    /**
     * Add credits from a Solana wallet, in USDC or SOL. The API prepares the
     * transfer, the wallet signs it, and the credits are added once the network
     * confirms it, exactly once. Works with an API key or a session.
     */
    topups: {
      /**
       * Prepare the transfer (`POST /api/billing/topups/prepare`). Nothing is paid
       * until the wallet signs `unsignedTxBase64` and you pass the result to `submit`.
       */
      prepare: (input: PrepareTopupInput) =>
        client.post<PreparedTopup>("/api/billing/topups/prepare", input),

      /**
       * Send the signed transfer. `status` is `credited` when it was confirmed during
       * the call; otherwise `pendingConfirmation` is true and the credits are added as
       * soon as it is, whether or not you call `reconcile`. Sending the same signed
       * transfer again is safe: it answers where the top-up stands.
       */
      submit: (topupId: string, signedTxBase64: string) =>
        client.post<TopupResult>(`/api/billing/topups/${seg(topupId)}/submit`, { signedTxBase64 }),

      /** Check the network for this top-up now. Safe to repeat; credits are never added twice. */
      reconcile: (topupId: string) =>
        client.post<TopupResult>(`/api/billing/topups/${seg(topupId)}/reconcile`, {}),

      get: (topupId: string) =>
        client.get<Topup>(`/api/billing/topups/${seg(topupId)}`),

      /** Your organization's last 20 top-ups, newest first. */
      list: () =>
        client.get<{ topups: Topup[] }>("/api/billing/topups"),
    },
  };
}
