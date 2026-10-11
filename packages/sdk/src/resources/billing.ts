import { seg, type Query, type RequestOptions, type WheelsAIClient } from "../client.js";
import { WheelsAIError } from "../error.js";

/**
 * Opening the USDC account at a deposit address can take the API up to 45 seconds
 * to see, which is longer than an ordinary call waits.
 */
const PREPARE_USDC_TIMEOUT_MS = 90_000;

/** Amounts on the billing endpoints are in dollars, not cents. */
export interface CreditBalance {
  /** What you can spend now. */
  available: number;
  /** What is set aside for things that are running or awaited: the total of `getHolds()`. */
  held: number;
  /** `available` plus `held`. */
  total: number;
  /** The same figure as `held`, kept for older callers. */
  pending: number;
}

/** What a hold is for. */
export type CreditHoldKind =
  | "deployment"
  | "agent_deployment"
  | "fine_tuning"
  | "job"
  | "try_it"
  | (string & {});

/** Credits set aside for one thing that is running or awaited. */
export interface CreditHold {
  kind: CreditHoldKind;
  /** The id of the thing that holds the credits; `"try_it"` for the one entry of that kind. */
  id: string;
  /** What you called it: the deployment, the agent, the job or the offering. */
  name: string;
  /** Dollars. */
  amount: number;
  /** When the credits were set aside (ISO). */
  since: string;
  /** A sentence that says why it is held and when it comes back. */
  note: string;
}

/**
 * How a ledger row reads: credits arriving (`added`), used (`spent`), a charge
 * or its unused part coming back (`returned`), set aside (`held`), a hold coming
 * back (`released`), removed again after a card refund (`taken_back`), or `other`.
 */
export type CreditTransactionKind =
  | "added"
  | "spent"
  | "returned"
  | "held"
  | "released"
  | "taken_back"
  | "other"
  | (string & {});

export interface CreditTransaction {
  id: string;
  /** Dollars, by its own sign: above zero for credits arriving, below zero for credits leaving. */
  amount: number;
  /** The stored type, in lower case, e.g. `purchase`, `gpu_usage`, `training_reservation`. */
  type: string;
  kind: CreditTransactionKind;
  /** What the row is called, ready to show. */
  label: string;
  /** The row's own text, or the label when it has none. */
  description: string;
  /** Your balance in dollars after this row. */
  balanceAfter: number;
  createdAt: string;
}

/** Which rows `getTransactions` lists: credits added, spending, or holds and their releases. */
export type CreditTransactionFilter = "added" | "spent" | "held";

export interface ListCreditTransactionsInput {
  /** 1 to 200. The API answers 50 when this is left out. */
  limit?: number;
  /** The `nextCursor` of the answer before, to read the page after it. */
  cursor?: string;
  /** Leave out for every row. */
  filter?: CreditTransactionFilter;
}

export interface CreditTransactionPage {
  /** Newest first. */
  transactions: CreditTransaction[];
  /** Pass as `cursor` to read the next page. `null` when there are no more rows. */
  nextCursor: string | null;
}

export interface ExportCreditTransactionsInput {
  /** The first UTC day, `YYYY-MM-DD`. Give both dates or neither. */
  from?: string;
  /** The last UTC day, `YYYY-MM-DD`, included. */
  to?: string;
}

/** A heading of the month's spending. */
export type SpendGroup =
  | "gpu"
  | "inference"
  | "fine_tuning"
  | "paid_use"
  | "subscriptions"
  | "jobs"
  | "try_it"
  | (string & {});

export interface SpendLine {
  group: SpendGroup;
  /** The heading, ready to show. */
  label: string;
  /**
   * Dollars spent under this heading this month, less what came back. Below zero
   * when more came back this month than was charged.
   */
  amount: number;
}

/** This UTC calendar month. */
export interface UsageSummary {
  /** The month, `YYYY-MM` (UTC). */
  month: string;
  /** Dollars spent this month: the sum of `spend`. */
  currentMonth: number;
  /** One line per heading, always in the same order, zero included. */
  spend: SpendLine[];
  /** GPU hours charged for this month. */
  gpuHours: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
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

/**
 * Read an answer that is text, not JSON. The client reads every answer as JSON
 * and, when one is not, raises an error that carries the text: that text is the
 * file. A refusal (a status that is not 2xx) is raised as it is.
 */
async function getText(client: WheelsAIClient, path: string, query?: Query): Promise<string> {
  try {
    const parsed = await client.request<unknown>("GET", path, { query, headers: { Accept: "text/csv" } });
    if (parsed === undefined) return "";
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch (err) {
    if (err instanceof WheelsAIError && err.status >= 200 && err.status < 300 && typeof err.data === "string") {
      return err.data;
    }
    throw err;
  }
}

export function billingResource(client: WheelsAIClient) {
  return {
    getBalance: () =>
      client.get<{ balance: CreditBalance }>("/api/billing/balance"),

    /** Everything that holds credits now, newest first, with the total in dollars. */
    getHolds: () =>
      client.get<{ holds: CreditHold[]; total: number }>("/api/billing/holds"),

    /**
     * Ledger rows, newest first: 50 unless `limit` (1 to 200) says otherwise. Pass
     * the answer's `nextCursor` as `cursor` to read the next page; it is `null`
     * when there are no more rows.
     */
    getTransactions: (input?: ListCreditTransactionsInput) =>
      client.get<CreditTransactionPage>("/api/billing/transactions", input as Query | undefined),

    /**
     * The ledger as a CSV file's text, oldest first (`GET /api/billing/transactions/export`).
     * `from` and `to` are UTC days (`YYYY-MM-DD`), `to` included; with neither, the
     * current UTC month up to today.
     */
    exportTransactions: (input?: ExportCreditTransactionsInput) =>
      getText(client, "/api/billing/transactions/export", input as Query | undefined),

    /** This UTC calendar month: what was spent under each heading, GPU hours and request counts. */
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
