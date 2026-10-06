import type { WheelsAIClient } from "../client.js";

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

    /** Credit packages, purchase limits and which payment rails are live on this server. */
    packages: () =>
      client.get<{
        packages: CreditPackage[];
        minPurchase: number;
        maxPurchase: number;
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
  };
}
