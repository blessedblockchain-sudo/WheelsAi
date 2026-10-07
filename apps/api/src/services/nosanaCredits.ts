/**
 * Nosana prepaid credits (API-key access): the balance read and the gate that
 * decides whether a new deployment may be created.
 *
 * Pure core with injected fetchers; nothing here imports the SDK or config.
 *
 * Why a direct GET and not `sdk.api.credits.balance()`: the SDK throws a bare
 * Error("Failed to fetch balance") for every failure, so an expired key cannot
 * be told from an outage. GET {backend}/api/credits/balance with the same
 * Bearer key exposes the HTTP status: 401/403 is an authentication failure,
 * anything else unreadable is "unavailable".
 *
 * Units: the API reports USD as JSON numbers (assignedCredits, reservedCredits,
 * settledCredits; "Available balance is assignedCredits - reservedCredits -
 * settledCredits" per the SDK schema). USD, NOT cents: Nosana's API document
 * and the @nosana/api types describe these fields as "USD cents", which is
 * wrong. Settled on 2026-10-07 against the account's own history: all 329
 * transactions reconcile in dollars (claims and top-ups = assigned; job
 * debits - refunds = settled), and a 6-hour debit equals the market's hourly
 * USD price x 6. Never divide by 100, whatever a generated type says. They
 * are converted once to integer micro-USD and all arithmetic after that is
 * bigint.
 *
 * What moves them: a job (one per replica) is debited price x its full
 * timeout when it is assigned to a node, and the unused part comes back as a
 * refund about a minute after it ends; every extension debits again. On the
 * account read, the debits sat in settledCredits and reservedCredits was 0.
 *
 * Fail closed: an unreadable balance refuses a deployment, and the gate always
 * reads fresh - a cached value never admits one.
 */

export type NosanaCreditsErrorCode =
  | "nosana_credits_low"
  | "nosana_credits_unavailable"
  | "nosana_auth_failed";

export class NosanaCreditsError extends Error {
  constructor(
    readonly code: NosanaCreditsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "NosanaCreditsError";
  }
}

export interface CreditBalance {
  assignedMicroUsd: bigint;
  reservedMicroUsd: bigint;
  settledMicroUsd: bigint;
  /** assigned - reserved - settled, floored at zero. */
  availableMicroUsd: bigint;
  fetchedAt: Date;
}

const MICRO_USD_PER_USD = 1_000_000;

function usdToMicro(name: string, value: unknown): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new NosanaCreditsError(
      "nosana_credits_unavailable",
      `Nosana credit balance field ${name} is not a non-negative number`,
    );
  }
  const micro = Math.round(value * MICRO_USD_PER_USD);
  if (!Number.isSafeInteger(micro)) {
    throw new NosanaCreditsError(
      "nosana_credits_unavailable",
      `Nosana credit balance field ${name} is out of range`,
    );
  }
  return BigInt(micro);
}

/** Validates and converts the raw balance body. Anything malformed throws. */
export function toCreditBalance(raw: unknown, now: Date): CreditBalance {
  if (typeof raw !== "object" || raw === null) {
    throw new NosanaCreditsError(
      "nosana_credits_unavailable",
      "Nosana credit balance response is not an object",
    );
  }
  const body = raw as Record<string, unknown>;
  const assignedMicroUsd = usdToMicro("assignedCredits", body.assignedCredits);
  const reservedMicroUsd = usdToMicro("reservedCredits", body.reservedCredits);
  const settledMicroUsd = usdToMicro("settledCredits", body.settledCredits);
  const available = assignedMicroUsd - reservedMicroUsd - settledMicroUsd;
  return {
    assignedMicroUsd,
    reservedMicroUsd,
    settledMicroUsd,
    availableMicroUsd: available > 0n ? available : 0n,
    fetchedAt: now,
  };
}

/**
 * What must be available before a deployment is created: its estimate plus the
 * floor. The floor is what must REMAIN after this deployment's first
 * reservation, so it is added once (not max(floor, estimate) + floor).
 */
export function requiredCreditsMicroUsd(a: {
  costMicroUsdPerSecond: bigint;
  replicas: number;
  reserveSeconds: number;
  floorMicroUsd: bigint;
}): bigint {
  if (!Number.isSafeInteger(a.replicas) || a.replicas <= 0) {
    throw new RangeError(`replicas must be a positive integer, got ${a.replicas}`);
  }
  if (!Number.isSafeInteger(a.reserveSeconds) || a.reserveSeconds <= 0) {
    throw new RangeError(`reserveSeconds must be a positive integer, got ${a.reserveSeconds}`);
  }
  if (a.costMicroUsdPerSecond < 0n || a.floorMicroUsd < 0n) {
    throw new RangeError("cost and floor must be >= 0");
  }
  return (
    a.costMicroUsdPerSecond * BigInt(a.replicas) * BigInt(a.reserveSeconds) + a.floorMicroUsd
  );
}

// ============================================
// HTTP read
// ============================================

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "error" | "follow" | "manual";
  },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

/**
 * GET {backendUrl}/api/credits/balance with the Bearer key. Resolves with the
 * raw JSON body; rejects with NosanaCreditsError (nosana_auth_failed on
 * 401/403, nosana_credits_unavailable otherwise). The key never appears in a
 * message.
 */
export function makeCreditBalanceFetcher(deps: {
  backendUrl: string;
  apiKey: string;
  fetch: FetchLike;
  timeoutMs?: number;
}): () => Promise<unknown> {
  const url = `${deps.backendUrl.replace(/\/+$/, "")}/api/credits/balance`;
  return async () => {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await deps.fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
        // Never carry the key to wherever a redirect points.
        redirect: "error",
      });
    } catch (err) {
      throw new NosanaCreditsError(
        "nosana_credits_unavailable",
        "The Nosana credit balance could not be fetched",
        { cause: err },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new NosanaCreditsError(
        "nosana_auth_failed",
        `Nosana refused the API key (HTTP ${response.status})`,
      );
    }
    if (!response.ok) {
      throw new NosanaCreditsError(
        "nosana_credits_unavailable",
        `The Nosana credit balance read answered HTTP ${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch (err) {
      throw new NosanaCreditsError(
        "nosana_credits_unavailable",
        "The Nosana credit balance response was not JSON",
        { cause: err },
      );
    }
  };
}

export interface CreditReader {
  /**
   * `fresh: true` always goes to Nosana. Otherwise a value younger than cacheMs
   * is returned. A failed read throws; it is never answered from the cache.
   */
  read(opts?: { fresh?: boolean }): Promise<CreditBalance>;
}

export function makeCreditReader(deps: {
  fetchBalance(): Promise<unknown>;
  now(): Date;
  cacheMs: number;
}): CreditReader {
  let last: CreditBalance | null = null;
  return {
    async read(opts = {}) {
      const now = deps.now();
      if (
        !opts.fresh &&
        last !== null &&
        now.getTime() - last.fetchedAt.getTime() < deps.cacheMs
      ) {
        return last;
      }
      let raw: unknown;
      try {
        raw = await deps.fetchBalance();
      } catch (err) {
        if (err instanceof NosanaCreditsError) throw err;
        throw new NosanaCreditsError(
          "nosana_credits_unavailable",
          "The Nosana credit balance could not be read",
          { cause: err },
        );
      }
      last = toCreditBalance(raw, now);
      return last;
    },
  };
}

// ============================================
// Gate
// ============================================

export type CreditGate =
  | { ok: true; balance: CreditBalance; requiredMicroUsd: bigint }
  | {
      ok: false;
      code: NosanaCreditsErrorCode;
      requiredMicroUsd?: bigint;
      availableMicroUsd?: bigint;
    };

/**
 * Reads the balance FRESH and compares it with estimate + floor. Never throws
 * for a credit reason: an unreadable balance is `ok: false`.
 */
export async function checkCreditGate(a: {
  reader: CreditReader;
  costMicroUsdPerSecond: bigint;
  replicas: number;
  reserveSeconds: number;
  floorMicroUsd: bigint;
}): Promise<CreditGate> {
  const requiredMicroUsd = requiredCreditsMicroUsd(a);
  let balance: CreditBalance;
  try {
    balance = await a.reader.read({ fresh: true });
  } catch (err) {
    return {
      ok: false,
      code: err instanceof NosanaCreditsError ? err.code : "nosana_credits_unavailable",
      requiredMicroUsd,
    };
  }
  if (balance.availableMicroUsd < requiredMicroUsd) {
    return {
      ok: false,
      code: "nosana_credits_low",
      requiredMicroUsd,
      availableMicroUsd: balance.availableMicroUsd,
    };
  }
  return { ok: true, balance, requiredMicroUsd };
}

/** Micro-USD as a plain number of dollars, for an operator view. */
export function microUsdToUsd(micro: bigint): number {
  return Number(micro) / MICRO_USD_PER_USD;
}
