/**
 * What an API key may spend on jobs.
 *
 * A key that can hire carries two caps (config/apiKeyScopes.ts): the most
 * one job may cost, and the most the key may spend in one UTC day. Both are
 * checked inside the hire transaction, so a refused reservation rolls the
 * whole hire back and a hire that fails later (no credits, no capacity)
 * gives its reservation back the same way.
 *
 * The day's total is raised by compare-and-set: the update matches only
 * while the total would stay within the cap, so however many hires one key
 * makes at once, the total never passes it.
 *
 * A refund does not give the day's allowance back: the cap bounds what a
 * key can commit in a day, and a leaked key should not be able to churn
 * through hire-and-cancel indefinitely.
 *
 * Pure over the injected transaction.
 */

export class ApiKeySpendCapError extends Error {
  constructor(
    readonly code: "api_key_job_price_cap_exceeded" | "api_key_daily_cap_exceeded" | "api_key_spend_caps_missing",
    message: string,
    readonly extra: Record<string, number> = {},
  ) {
    super(message);
    this.name = "ApiKeySpendCapError";
  }
}

export interface ApiKeySpendTx {
  apiKey: {
    findUnique(args: {
      where: { id: string };
      select: { orgId: true; maxJobPriceCents: true; dailySpendCapCents: true };
    }): Promise<{ orgId: string; maxJobPriceCents: bigint | null; dailySpendCapCents: bigint | null } | null>;
  };
  apiKeySpendWindow: {
    createMany(args: {
      data: Array<{ apiKeyId: string; day: Date }>;
      skipDuplicates: true;
    }): Promise<unknown>;
    updateMany(args: {
      where: { apiKeyId: string; day: Date; spentCents: { lte: bigint } };
      data: { spentCents: { increment: bigint } };
    }): Promise<{ count: number }>;
  };
}

/** Midnight UTC of the day `now` falls in: the spend window's key. */
export function spendDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function reserveApiKeySpend(
  tx: ApiKeySpendTx,
  args: { apiKeyId: string; orgId: string; priceCents: bigint; now?: Date },
): Promise<void> {
  const key = await tx.apiKey.findUnique({
    where: { id: args.apiKeyId },
    select: { orgId: true, maxJobPriceCents: true, dailySpendCapCents: true },
  });
  // Read here, not from the request: the caps are the key's as they are now.
  if (!key || key.orgId !== args.orgId || key.maxJobPriceCents === null || key.dailySpendCapCents === null) {
    throw new ApiKeySpendCapError(
      "api_key_spend_caps_missing",
      "This API key has no spend caps, so it cannot hire. Create a key with jobs:hire and both caps.",
    );
  }
  if (args.priceCents > key.maxJobPriceCents) {
    throw new ApiKeySpendCapError(
      "api_key_job_price_cap_exceeded",
      `This job costs more than this API key may spend on one job ($${(Number(key.maxJobPriceCents) / 100).toFixed(2)}).`,
      { priceCents: Number(args.priceCents), maxJobPriceCents: Number(key.maxJobPriceCents) },
    );
  }

  const day = spendDay(args.now ?? new Date());
  // ON CONFLICT DO NOTHING, so the row exists without a unique violation
  // that would abort this transaction.
  await tx.apiKeySpendWindow.createMany({ data: [{ apiKeyId: args.apiKeyId, day }], skipDuplicates: true });
  const reserved = await tx.apiKeySpendWindow.updateMany({
    where: { apiKeyId: args.apiKeyId, day, spentCents: { lte: key.dailySpendCapCents - args.priceCents } },
    data: { spentCents: { increment: args.priceCents } },
  });
  if (reserved.count !== 1) {
    throw new ApiKeySpendCapError(
      "api_key_daily_cap_exceeded",
      `This job would take this API key past what it may spend in one day ($${(Number(key.dailySpendCapCents) / 100).toFixed(2)}).`,
      { priceCents: Number(args.priceCents), dailySpendCapCents: Number(key.dailySpendCapCents) },
    );
  }
}
