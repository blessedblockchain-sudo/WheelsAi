/**
 * SOL/USD price oracle for the treasury settlement pipeline.
 *
 * Two pieces:
 *   1. fetchSolPriceFromCoinGecko — production fetcher; throws on
 *      non-OK responses or unexpected payload shapes.
 *   2. makeSolPriceProvider       — wraps any fetcher with TTL caching
 *      and a triple fallback chain (fresh → stale → constant).
 *
 * The provider is what runway/settlement actually call. Caching keeps
 * us under CoinGecko's free-tier rate limit (~10/min) when many ticks
 * fire in quick succession, and the stale-cache fallback means a brief
 * upstream outage doesn't make every runway card render zero.
 *
 * TODO(plan A8): swap fetchSolPriceFromCoinGecko for a Pyth on-chain
 * read once the Anchor pipeline lands — same provider contract, no
 * code outside this file changes.
 */

import { createLogger } from "../utils/logger.js";

const logger = createLogger("price-oracle");

// ----------------------------------------------------------------------
// Cached provider
// ----------------------------------------------------------------------

export interface SolPriceProviderConfig {
  fetchPrice: () => Promise<number>;
  cacheTtlMs: number;
  /** Final fallback when there is no fresh fetch and no cache. */
  fallbackUsd: number;
  /** Defaults to Date.now; tests inject for time travel. */
  nowMs?: () => number;
}

interface CacheEntry {
  price: number;
  fetchedAtMs: number;
}

export function makeSolPriceProvider(
  config: SolPriceProviderConfig,
): () => Promise<number> {
  const now = config.nowMs ?? (() => Date.now());
  let cache: CacheEntry | null = null;

  return async function getSolPriceUsd(): Promise<number> {
    const t = now();

    // Fresh cache hit: short-circuit with no fetch.
    if (cache && t - cache.fetchedAtMs < config.cacheTtlMs) {
      return cache.price;
    }

    try {
      const fetched = await config.fetchPrice();
      if (!Number.isFinite(fetched) || fetched <= 0) {
        // Treat NaN / Infinity / 0 / negative as "no usable price".
        // Falling through to the catch-shaped path keeps the stale-vs-
        // fallback chain in one place.
        throw new Error(`Unusable SOL price returned: ${fetched}`);
      }
      cache = { price: fetched, fetchedAtMs: t };
      return fetched;
    } catch (err) {
      if (cache) {
        // Stale cache is preferable to a constant fallback — the price
        // we have is closer to truth than 100 USD pinned.
        logger.warn(
          { err, stalePrice: cache.price, ageMs: t - cache.fetchedAtMs },
          "SOL price fetch failed; serving stale cache",
        );
        return cache.price;
      }
      logger.warn(
        { err, fallback: config.fallbackUsd },
        "SOL price fetch failed; no cache; serving fallback",
      );
      return config.fallbackUsd;
    }
  };
}

// ----------------------------------------------------------------------
// CoinGecko fetcher
// ----------------------------------------------------------------------

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

export interface FetchSolPriceConfig {
  /** Defaults to globalThis.fetch; tests inject. */
  fetchImpl?: typeof fetch;
  /** Optional API key; sent as x-cg-demo-api-key header for free tier. */
  apiKey?: string;
}

export async function fetchSolPriceFromCoinGecko(
  config: FetchSolPriceConfig = {},
): Promise<number> {
  const fetchImpl = config.fetchImpl ?? fetch;

  const headers: Record<string, string> = { accept: "application/json" };
  if (config.apiKey) headers["x-cg-demo-api-key"] = config.apiKey;

  const res = await fetchImpl(COINGECKO_URL, { headers });
  if (!res.ok) {
    throw new Error(
      `CoinGecko price fetch failed: ${res.status} ${res.statusText}`,
    );
  }

  const body = (await res.json()) as { solana?: { usd?: unknown } };
  const usd = body.solana?.usd;
  if (typeof usd !== "number") {
    throw new Error(
      `CoinGecko payload unexpected: usd field missing or not number (got ${typeof usd})`,
    );
  }
  return usd;
}
