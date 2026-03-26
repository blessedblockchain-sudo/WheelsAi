import type { WheelsAIClient } from "../client.js";

export interface CreditBalance {
  available: number;
  pending: number;
  totalSpent: number;
}

export interface CreditTransaction {
  id: string;
  type: "purchase" | "usage" | "refund" | "adjustment" | "bonus";
  amountCents: number;
  description: string;
  reference?: string;
  createdAt: string;
}

export interface UsageRecord {
  deploymentId: string;
  deploymentName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export function billingResource(client: WheelsAIClient) {
  return {
    getBalance: () =>
      client.get<{ balance: CreditBalance }>("/api/billing/balance"),

    getTransactions: (params?: { limit?: number; offset?: number; type?: string }) =>
      client.get<{ transactions: CreditTransaction[]; total: number }>("/api/billing/transactions", params),

    getUsage: (params?: { period?: string }) =>
      client.get<{ usage: { requests: number; inputTokens: number; outputTokens: number; totalCostCents: number }; records: UsageRecord[] }>("/api/billing/usage", params),

    addCredits: (amountCents: number) =>
      client.post<{ transaction: CreditTransaction; balance: CreditBalance }>("/api/billing/credits", { amountCents }),
  };
}
