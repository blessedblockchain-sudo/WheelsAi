import { seg, type RequestOptions, type WheelsAIClient } from "../client.js";

/**
 * Opening the USDC account at a deposit address can take the API up to 45 seconds
 * to see, which is longer than an ordinary call waits.
 */
const PREPARE_USDC_TIMEOUT_MS = 90_000;

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

/** What a transfer to your organization's deposit address can be in. */
export type DepositAsset = "USDC" | "SOL";

/** What the address can receive: USDC always, and SOL while it is offered. */
export type DepositAddressAsset =
  | {
      asset: "USDC";
      /**
       * Whether the USDC account at the address exists. Some senders need it to
       * exist before they send USDC: `depositAddress.prepareUsdc()` opens it.
       */
      accountOpen: boolean;
    }
  | {
      asset: "SOL";
      /** False while SOL is not offered: a SOL transfer is then not credited. */
      offered: boolean;
    };

/**
 * Your organization's own address for USDC and SOL on Solana. Anything sent to
 * it, from an exchange or from any wallet, is added to your credits once.
 */
export interface DepositAddress {
  /** `null` until the address is issued with `depositAddress.issue()`. */
  address: string | null;
  /** The Solana network the address is on. Send on this network only. */
  network: "mainnet-beta" | "devnet";
  assets: DepositAddressAsset[];
  /** A sentence to show beside the address. */
  message: string;
}

/** The answer to `depositAddress.prepareUsdc()`. */
export interface PreparedDepositAddress {
  accountOpen: true;
  /** A sentence to show. */
  message: string;
}

/** A transfer the check added to your credits. */
export interface CreditedDeposit {
  asset: DepositAsset;
  /**
   * The transfer in whole units, as a string: USDC with two decimals ("50.00"),
   * or up to six when it is not whole cents; SOL with trailing zeros dropped ("0.5").
   */
  amount: string;
  /** Dollars added for the transfer itself. */
  creditedUsd: number;
  /** Dollars of bonus added with it. */
  bonusUsd: number;
  txSignature: string;
}

/** A transfer that was seen and is not credited yet: SOL waiting for a current price. */
export interface WaitingDeposit {
  asset: DepositAsset;
  /** The transfer in whole units, as a string (see `CreditedDeposit.amount`). */
  amount: string;
  txSignature: string;
}

/** The answer to `depositAddress.check()`. */
export interface DepositCheck {
  /** What this call added to your credits. Empty when it found nothing new. */
  credited: CreditedDeposit[];
  /** Every transfer of your organization that is still waiting. */
  waiting: WaitingDeposit[];
  /** A sentence that says what the check found. */
  message: string;
}

/** Where a transfer to the address stands. `credited` and `ignored` are final. */
export type DepositStatus = "credited" | "waiting" | "ignored" | (string & {});

/** One transfer sent straight to your organization's deposit address. */
export interface Deposit {
  id: string;
  asset: DepositAsset;
  /** The transfer in whole units, as a string (see `CreditedDeposit.amount`). */
  amount: string;
  status: DepositStatus;
  /** Dollars added for the transfer itself. `null` until it is credited. */
  creditedUsd: number | null;
  /** Dollars of bonus added with it. 0 or `null` until it is credited. */
  bonusUsd: number | null;
  txSignature: string;
  /** When the transfer was seen. */
  createdAt: string;
  /** When it was credited. `null` until then. */
  creditedAt: string | null;
  /** A sentence that says where this transfer stands. */
  message: string;
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
        /**
         * `wallet` and `walletAssets` say whether `topups` is open and in which assets;
         * `deposits` says whether `depositAddress` is.
         */
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

    /**
     * Your organization's own address for USDC and SOL on Solana. Send to it from
     * an exchange or from any wallet, with nothing to sign here: each transfer is
     * added to your credits once, usually within a few minutes. Works with an API
     * key or a session. `rails.deposits` of `packages()` says whether it is open.
     */
    depositAddress: {
      /**
       * Read the address (`GET /api/billing/deposit-address`). `address` is `null`
       * until it is issued. Reading never creates or changes anything.
       */
      get: () =>
        client.get<DepositAddress>("/api/billing/deposit-address"),

      /**
       * Issue the address (`POST /api/billing/deposit-address`). Safe to repeat: an
       * organization has one address and this always answers with it.
       */
      issue: () =>
        client.post<DepositAddress>("/api/billing/deposit-address"),

      /**
       * Open the USDC account at the address, for a sender that says the address
       * cannot receive USDC yet. Answers `accountOpen: true` when it is open,
       * also when it already was. At most 3 calls a minute. The call can take up
       * to a minute, so it waits 90 seconds unless `options.timeoutMs` says otherwise.
       */
      prepareUsdc: (options?: RequestOptions) =>
        client.post<PreparedDepositAddress>("/api/billing/deposit-address/usdc-account", undefined, {
          ...options,
          // Named last: options without a timeout (headers only, or `timeoutMs: undefined`)
          // must not fall back to the client's shorter one.
          timeoutMs: options?.timeoutMs ?? PREPARE_USDC_TIMEOUT_MS,
        }),

      /**
       * Look for new transfers now instead of waiting. Answers what this call
       * credited and what is still waiting. Safe to repeat; a transfer is never
       * credited twice. At most 6 calls a minute.
       */
      check: () =>
        client.post<DepositCheck>("/api/billing/deposit-address/check"),
    },

    deposits: {
      /** The last 20 transfers sent straight to your organization's address, newest first. */
      list: () =>
        client.get<{ deposits: Deposit[] }>("/api/billing/deposits"),
    },
  };
}
