/**
 * What a Nosana market costs the platform, in USD, from the public REST market
 * list (GET {backend}/api/markets/ - no credential needed).
 *
 * Pure core with an injected fetcher. The response field usd_reward_per_hour is
 * typed `unknown` in the SDK schema, so it is parsed defensively: a market that
 * does not parse has NO cost (null), it is never given a guessed one.
 *
 * Cost per second = usd_reward_per_hour x (1 + network_fee_percentage / 100)
 * / 3600, rounded UP to a whole micro-USD. Whether the network fee is charged
 * on top for credit-paid deployments is unverified; adding it errs high, which
 * is the safe direction for both the credit estimate and the below-cost guard.
 */

import type { FetchLike } from "./nosanaCredits.js";

/** Applied when a market row carries no usable network_fee_percentage. */
export const DEFAULT_NETWORK_FEE_PCT = 10;

export interface MarketCost {
  address: string;
  usdPerHour: number;
  feePct: number;
  /** Fee-inclusive, per replica, rounded up. */
  costMicroUsdPerSecond: bigint;
}

function positiveNumber(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function feePercentage(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_NETWORK_FEE_PCT;
}

/** ceil(usdPerHour x (100 + feePct) / 100 x 1e6 / 3600) in integer arithmetic. */
export function costMicroUsdPerSecond(m: { usdPerHour: number; feePct: number }): bigint {
  if (!Number.isFinite(m.usdPerHour) || m.usdPerHour <= 0) {
    throw new RangeError(`usdPerHour must be a positive number, got ${m.usdPerHour}`);
  }
  if (!Number.isFinite(m.feePct) || m.feePct < 0) {
    throw new RangeError(`feePct must be a non-negative number, got ${m.feePct}`);
  }
  const microPerHour = BigInt(Math.round(m.usdPerHour * 1_000_000));
  const feeBps = BigInt(Math.round(m.feePct * 100));
  const numerator = microPerHour * (10_000n + feeBps);
  const denominator = 10_000n * 3_600n;
  return (numerator + denominator - 1n) / denominator;
}

/** One row of the market list, or null when it has no usable address or price. */
export function parseMarketCost(raw: unknown): MarketCost | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const address = typeof row.address === "string" ? row.address.trim() : "";
  if (address === "") return null;
  const usdPerHour = positiveNumber(row.usd_reward_per_hour);
  if (usdPerHour === null) return null;
  const feePct = feePercentage(row.network_fee_percentage);
  return {
    address,
    usdPerHour,
    feePct,
    costMicroUsdPerSecond: costMicroUsdPerSecond({ usdPerHour, feePct }),
  };
}

/** GET {backendUrl}/api/markets/ - public, sent with no credential. */
export function makeMarketListFetcher(deps: {
  backendUrl: string;
  fetch: FetchLike;
  timeoutMs?: number;
}): () => Promise<unknown[]> {
  const url = `${deps.backendUrl.replace(/\/+$/, "")}/api/markets/`;
  return async () => {
    const response = await deps.fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`The Nosana market list answered HTTP ${response.status}`);
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new Error("The Nosana market list response is not an array");
    }
    return body;
  };
}

/**
 * How long the last cost a market was SEEN with may stand in once the list
 * stops giving one (unreadable, or the row no longer carries a price). Long
 * enough to ride out an outage of a public endpoint, short enough that a
 * price nobody has confirmed for a day admits nothing.
 */
export const MARKET_COST_STALE_MAX_MS = 24 * 60 * 60 * 1000;

export interface MarketCostReader {
  /** Every market that parsed, keyed by address. Throws when the list cannot be read. */
  read(opts?: { fresh?: boolean }): Promise<ReadonlyMap<string, MarketCost>>;
  /**
   * The cost of one market, or null when it is not known: the list does not
   * price it now and no earlier price is younger than `staleMs`. When the list
   * cannot be read, the last price seen within `staleMs` is served; with none,
   * it THROWS. A null or a throw is "unknown" - never a guessed number.
   */
  costFor(marketAddress: string): Promise<MarketCost | null>;
}

export function makeMarketCostReader(deps: {
  fetchMarkets(): Promise<unknown[]>;
  now(): Date;
  cacheMs: number;
  /** Bound for serving a market's last seen cost; 0 (default) serves none. */
  staleMs?: number;
  /** A last-seen cost stood in for a missing one (for the operator's log). */
  onStale?: (info: { marketAddress: string; ageMs: number; reason: "unreadable" | "unpriced" }) => void;
}): MarketCostReader {
  let last: { at: number; costs: ReadonlyMap<string, MarketCost> } | null = null;
  // Per market, because one row can lose its price while the list still reads.
  const lastSeen = new Map<string, { at: number; cost: MarketCost }>();
  const staleMs = deps.staleMs ?? 0;

  const read: MarketCostReader["read"] = async (opts = {}) => {
    const now = deps.now().getTime();
    if (!opts.fresh && last !== null && now - last.at < deps.cacheMs) return last.costs;
    const rows = await deps.fetchMarkets();
    const costs = new Map<string, MarketCost>();
    for (const row of rows) {
      const cost = parseMarketCost(row);
      if (cost) {
        costs.set(cost.address, cost);
        lastSeen.set(cost.address, { at: now, cost });
      }
    }
    last = { at: now, costs };
    return costs;
  };

  const stale = (marketAddress: string, reason: "unreadable" | "unpriced"): MarketCost | null => {
    const seen = lastSeen.get(marketAddress);
    if (!seen) return null;
    const ageMs = deps.now().getTime() - seen.at;
    if (ageMs >= staleMs) return null;
    try {
      deps.onStale?.({ marketAddress, ageMs, reason });
    } catch {
      // Reporting never changes the answer.
    }
    return seen.cost;
  };

  return {
    read,
    costFor: async (marketAddress) => {
      let costs: ReadonlyMap<string, MarketCost>;
      try {
        costs = await read();
      } catch (err) {
        const kept = stale(marketAddress, "unreadable");
        if (kept) return kept;
        throw err;
      }
      return costs.get(marketAddress) ?? stale(marketAddress, "unpriced");
    },
  };
}

/** USD per second (the retail catalog's unit) as whole micro-USD per second. */
export function retailMicroUsdPerSecond(pricePerSecondUsd: number): bigint {
  if (!Number.isFinite(pricePerSecondUsd) || pricePerSecondUsd < 0) {
    throw new RangeError(`pricePerSecond must be a non-negative number, got ${pricePerSecondUsd}`);
  }
  return BigInt(Math.round(pricePerSecondUsd * 1_000_000));
}
