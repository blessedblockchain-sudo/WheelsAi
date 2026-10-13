/**
 * What an API key may spend on jobs, and on paid use of other people's agents.
 *
 * A key that can hire carries two caps (config/apiKeyScopes.ts): the most
 * one job may cost, and the most the key may spend in one UTC day. Both are
 * checked inside the hire transaction, so a refused reservation rolls the
 * whole hire back and a hire that fails later (no credits, no capacity)
 * gives its reservation back the same way.
 *
 * A key that can pay to use agents (agents:use) carries the most one use
 * may cost, and the same day's cap: one window a day per key, shared by
 * jobs and uses. Its reservation is made inside the charge transaction
 * (services/useMetering.ts), so a refused reservation rolls the debit back.
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

/** The same refusals for a paid use. A class of its own, so the hire path's errors are as they were. */
export class ApiKeyUseCapError extends Error {
  constructor(
    readonly code: "api_key_use_price_cap_exceeded" | "api_key_daily_cap_exceeded" | "api_key_spend_caps_missing",
    message: string,
    readonly extra: Record<string, number> = {},
  ) {
    super(message);
    this.name = "ApiKeyUseCapError";
  }
}

/** Which of the key's per-item caps a price is held to. The day's cap is the same for both. */
export type SpendCap = "job" | "use";

type KeyCapsSelect =
  | { orgId: true; maxJobPriceCents: true; dailySpendCapCents: true }
  | { orgId: true; maxUsePriceCents: true; dailySpendCapCents: true };

interface KeyCapsRow {
  orgId: string;
  maxJobPriceCents?: bigint | null;
  maxUsePriceCents?: bigint | null;
  dailySpendCapCents: bigint | null;
}

export interface ApiKeySpendTx {
  apiKey: {
    findUnique(args: { where: { id: string }; select: KeyCapsSelect }): Promise<KeyCapsRow | null>;
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

/** What peekApiKeySpend reads. It writes nothing. */
export interface ApiKeySpendReadDb {
  apiKey: ApiKeySpendTx["apiKey"];
  apiKeySpendWindow: {
    findUnique(args: {
      where: { apiKeyId_day: { apiKeyId: string; day: Date } };
      select: { spentCents: true };
    }): Promise<{ spentCents: bigint } | null>;
  };
}

/** Midnight UTC of the day `now` falls in: the spend window's key. */
export function spendDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** What readSpentToday reads. It writes nothing. */
export interface ApiKeySpendDayDb {
  apiKeySpendWindow: {
    findMany(args: {
      where: { apiKeyId: { in: string[] }; day: Date };
      select: { apiKeyId: true; spentCents: true };
    }): Promise<Array<{ apiKeyId: string; spentCents: bigint }>>;
  };
}

/**
 * What each of these keys has spent in the UTC day `now` falls in, in ONE
 * query for all of them: the day's window of each, the total its
 * reservations have raised. A key with no window today has spent nothing
 * and is not in the answer. A refund does not lower the total (see above),
 * so this is what the key has committed today, which is what its daily cap
 * is held against.
 */
export async function readSpentToday(
  db: ApiKeySpendDayDb,
  apiKeyIds: string[],
  now: Date,
): Promise<Map<string, bigint>> {
  const spent = new Map<string, bigint>();
  if (apiKeyIds.length === 0) return spent;
  const windows = await db.apiKeySpendWindow.findMany({
    where: { apiKeyId: { in: apiKeyIds }, day: spendDay(now) },
    select: { apiKeyId: true, spentCents: true },
  });
  for (const window of windows) spent.set(window.apiKeyId, window.spentCents);
  return spent;
}

const dollars = (cents: bigint) => `$${(Number(cents) / 100).toFixed(2)}`;

interface SpendArgs {
  apiKeyId: string;
  orgId: string;
  priceCents: bigint;
  now?: Date;
  /** "job" (the default) holds the price to maxJobPriceCents; "use" to maxUsePriceCents. */
  cap?: SpendCap;
}

type SpendProblem =
  | { kind: "missing" }
  | { kind: "price"; capCents: bigint }
  | { kind: "day"; capCents: bigint };

/** The refusal for a cap, in the words of what was being paid for. */
function spendError(cap: SpendCap, problem: SpendProblem, priceCents: bigint): ApiKeySpendCapError | ApiKeyUseCapError {
  if (cap === "use") {
    if (problem.kind === "missing") {
      return new ApiKeyUseCapError(
        "api_key_spend_caps_missing",
        "This API key has no spend caps for paid agents, so it cannot pay to use one. Create a key with agents:use and both caps.",
      );
    }
    if (problem.kind === "price") {
      return new ApiKeyUseCapError(
        "api_key_use_price_cap_exceeded",
        `This use costs more than this API key may spend on one use (${dollars(problem.capCents)}).`,
        { priceCents: Number(priceCents), maxUsePriceCents: Number(problem.capCents) },
      );
    }
    return new ApiKeyUseCapError(
      "api_key_daily_cap_exceeded",
      `This use would take this API key past what it may spend in one day (${dollars(problem.capCents)}).`,
      { priceCents: Number(priceCents), dailySpendCapCents: Number(problem.capCents) },
    );
  }
  if (problem.kind === "missing") {
    return new ApiKeySpendCapError(
      "api_key_spend_caps_missing",
      "This API key has no spend caps, so it cannot hire. Create a key with jobs:hire and both caps.",
    );
  }
  if (problem.kind === "price") {
    return new ApiKeySpendCapError(
      "api_key_job_price_cap_exceeded",
      `This job costs more than this API key may spend on one job (${dollars(problem.capCents)}).`,
      { priceCents: Number(priceCents), maxJobPriceCents: Number(problem.capCents) },
    );
  }
  return new ApiKeySpendCapError(
    "api_key_daily_cap_exceeded",
    `This job would take this API key past what it may spend in one day (${dollars(problem.capCents)}).`,
    { priceCents: Number(priceCents), dailySpendCapCents: Number(problem.capCents) },
  );
}

/**
 * The key's caps as they are now, read here and not from the request. One
 * read, of the per-item cap that was asked for and the day's.
 */
async function readCaps(
  db: Pick<ApiKeySpendTx, "apiKey">,
  args: SpendArgs,
  cap: SpendCap,
): Promise<{ ok: true; perItem: bigint; perDay: bigint } | { ok: false; problem: SpendProblem }> {
  const key = await db.apiKey.findUnique({
    where: { id: args.apiKeyId },
    select:
      cap === "use"
        ? { orgId: true, maxUsePriceCents: true, dailySpendCapCents: true }
        : { orgId: true, maxJobPriceCents: true, dailySpendCapCents: true },
  });
  const perItem = cap === "use" ? key?.maxUsePriceCents : key?.maxJobPriceCents;
  if (!key || key.orgId !== args.orgId || perItem == null || key.dailySpendCapCents == null) {
    return { ok: false, problem: { kind: "missing" } };
  }
  if (args.priceCents > perItem) return { ok: false, problem: { kind: "price", capCents: perItem } };
  return { ok: true, perItem, perDay: key.dailySpendCapCents };
}

/**
 * Reserve `priceCents` of the key's day, or throw: ApiKeySpendCapError for a
 * job, ApiKeyUseCapError for a use. Run INSIDE the transaction that takes
 * the money, so a refusal rolls it back.
 */
export async function reserveApiKeySpend(tx: ApiKeySpendTx, args: SpendArgs): Promise<void> {
  const cap = args.cap ?? "job";
  const caps = await readCaps(tx, args, cap);
  if (!caps.ok) throw spendError(cap, caps.problem, args.priceCents);

  const day = spendDay(args.now ?? new Date());
  // ON CONFLICT DO NOTHING, so the row exists without a unique violation
  // that would abort this transaction.
  await tx.apiKeySpendWindow.createMany({ data: [{ apiKeyId: args.apiKeyId, day }], skipDuplicates: true });
  const reserved = await tx.apiKeySpendWindow.updateMany({
    where: { apiKeyId: args.apiKeyId, day, spentCents: { lte: caps.perDay - args.priceCents } },
    data: { spentCents: { increment: args.priceCents } },
  });
  if (reserved.count !== 1) {
    throw spendError(cap, { kind: "day", capCents: caps.perDay }, args.priceCents);
  }
}

export type SpendPeek =
  | { ok: true }
  | {
      ok: false;
      code: (ApiKeySpendCapError | ApiKeyUseCapError)["code"];
      message: string;
      extra: Record<string, number>;
    };

/**
 * Whether a price would fit the key's caps right now. A read: it reserves
 * nothing, so it is asked before anything of the creator's is spent, and
 * the reservation inside the charge is still what decides. A key whose caps
 * cannot be read does not fit.
 */
export async function peekApiKeySpend(db: ApiKeySpendReadDb, args: SpendArgs): Promise<SpendPeek> {
  const cap = args.cap ?? "job";
  const refusal = (problem: SpendProblem): SpendPeek => {
    const err = spendError(cap, problem, args.priceCents);
    return { ok: false, code: err.code, message: err.message, extra: err.extra };
  };
  const caps = await readCaps(db, args, cap);
  if (!caps.ok) return refusal(caps.problem);
  const window = await db.apiKeySpendWindow.findUnique({
    where: { apiKeyId_day: { apiKeyId: args.apiKeyId, day: spendDay(args.now ?? new Date()) } },
    select: { spentCents: true },
  });
  const spent = window?.spentCents ?? 0n;
  return spent + args.priceCents > caps.perDay ? refusal({ kind: "day", capCents: caps.perDay }) : { ok: true };
}
