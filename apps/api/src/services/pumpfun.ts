import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";

const logger = createLogger("pumpfun-service");

const PUMPFUN_API_BASE = "https://pumpportal.fun/api";

// ============================================
// Types
// ============================================

export interface TokenInfo {
  mintAddress: string;
  name: string;
  symbol: string;
  description: string;
  imageUri?: string;
  priceUsd: number;
  marketCapUsd: number;
  volume24h: number;
  holders: number;
  bondingCurveProgress: number; // 0-100
  isGraduated: boolean;
  raydiumPoolId?: string;
  createdAt: string;
}

export interface TokenTrade {
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  timestamp: string;
}

export interface TokenHolder {
  walletAddress: string;
  balance: number;
  percentage: number;
}

/**
 * Error thrown by PumpFunClient.request when the upstream API answers
 * with a non-OK status, or when all retries for a retryable condition
 * (5xx / 429 / network failure / timeout) are exhausted.
 *
 * `status` is set for HTTP-level failures and undefined for transport
 * failures (DNS, abort/timeout, connection reset).
 */
export class PumpFunApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "PumpFunApiError";
    this.status = status;
  }
}

export interface PumpFunClientOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  /** Per-attempt request timeout (AbortController). Default 10s. */
  timeoutMs?: number;
  /** Retries on 5xx / 429 / network failure. Default 2 (3 attempts total). */
  maxRetries?: number;
  /** Base for the exponential backoff between retries. Default 500ms. */
  retryBaseMs?: number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0, 1). Default Math.random. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse an HTTP Retry-After header into milliseconds. Supports both the
 * delta-seconds form ("120") and the HTTP-date form. Returns null when
 * absent or unparseable (caller falls back to backoff-with-jitter).
 */
function parseRetryAfterMs(header: string | null, now: () => number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

// ============================================
// Pump.fun Client
// ============================================

export class PumpFunClient {
  private apiKey: string | undefined;
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private maxRetries: number;
  private retryBaseMs: number;
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;

  constructor(options: PumpFunClientOptions = {}) {
    this.apiKey = options.apiKey ?? env.PUMPFUN_API_KEY;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** Exponential backoff with jitter: base * 2^attempt + jitter*base. */
  private backoffMs(attempt: number): number {
    return Math.round(
      this.retryBaseMs * 2 ** attempt + this.random() * this.retryBaseMs,
    );
  }

  /**
   * One HTTP request with:
   *   - AbortController timeout per attempt (default 10s)
   *   - retry-with-jitter on 5xx and network/timeout failures
   *   - explicit 429 handling (respects Retry-After when present)
   *   - non-retryable 4xx → immediate throw
   *
   * Always THROWS PumpFunApiError on failure — callers must not be able
   * to confuse an upstream outage with an empty result set.
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${PUMPFUN_API_BASE}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.apiKey ? { "Authorization": `Bearer ${this.apiKey}` } : {}),
      ...(options.headers as Record<string, string> || {}),
    };

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await this.fetchFn(url, {
          ...options,
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        // Transport-level failure: network error or our own timeout abort.
        if (attempt >= this.maxRetries) {
          logger.error({ error, endpoint, attempt }, "Pump.fun API request failed");
          throw new PumpFunApiError(
            `Failed to reach Pump.fun API: ${(error as Error).message}`,
            undefined,
            error,
          );
        }
        await this.sleep(this.backoffMs(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch (error) {
          throw new PumpFunApiError(
            `Pump.fun API returned invalid JSON: ${(error as Error).message}`,
            res.status,
            error,
          );
        }
      }

      const errorBody = await res.text().catch(() => "");

      if (res.status === 429) {
        if (attempt >= this.maxRetries) {
          logger.error({ status: 429, endpoint, attempt }, "Pump.fun API rate limited");
          throw new PumpFunApiError(
            `Pump.fun API rate limited: 429 ${res.statusText}`,
            429,
          );
        }
        const retryAfterMs = parseRetryAfterMs(
          res.headers.get("retry-after"),
          () => Date.now(),
        );
        await this.sleep(retryAfterMs ?? this.backoffMs(attempt));
        continue;
      }

      if (res.status >= 500) {
        if (attempt >= this.maxRetries) {
          logger.error(
            { status: res.status, body: errorBody, endpoint, attempt },
            "Pump.fun API error",
          );
          throw new PumpFunApiError(
            `Pump.fun API error: ${res.status} ${res.statusText}`,
            res.status,
          );
        }
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      // Non-retryable 4xx.
      logger.error(
        { status: res.status, body: errorBody, endpoint },
        "Pump.fun API error",
      );
      throw new PumpFunApiError(
        `Pump.fun API error: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
  }

  /**
   * Get token information from pump.fun.
   * Returns null when the upstream call fails — token info feeds
   * best-effort stats refresh, not money paths, and `null` is
   * distinguishable from data (unlike trades, where [] would be).
   */
  async getTokenInfo(mintAddress: string): Promise<TokenInfo | null> {
    try {
      return await this.request<TokenInfo>(`/token/${mintAddress}`);
    } catch (error) {
      logger.warn({ mintAddress, error }, "Failed to get token info from pump.fun");
      return null;
    }
  }

  /**
   * Get recent trades for a token.
   * THROWS on upstream failure — trades feed fee routing; an outage must
   * never be indistinguishable from "no trades" (plan D7).
   */
  async getTokenTrades(mintAddress: string, limit = 50, offset = 0): Promise<TokenTrade[]> {
    const result = await this.request<{ trades: TokenTrade[] }>(
      `/token/${mintAddress}/trades?limit=${limit}&offset=${offset}`
    );
    return result.trades;
  }

  /**
   * Get token holders.
   * THROWS on upstream failure — holders feed the token-gate access
   * check; an outage must not silently empty the holder set (plan D7).
   */
  async getTokenHolders(mintAddress: string): Promise<TokenHolder[]> {
    const result = await this.request<{ holders: TokenHolder[] }>(
      `/token/${mintAddress}/holders`
    );
    return result.holders;
  }

  /**
   * Check if token has graduated from bonding curve to Raydium
   */
  async checkGraduation(mintAddress: string): Promise<{ graduated: boolean; raydiumPoolId?: string }> {
    try {
      const info = await this.getTokenInfo(mintAddress);
      if (!info) return { graduated: false };
      return {
        graduated: info.isGraduated,
        raydiumPoolId: info.raydiumPoolId,
      };
    } catch (error) {
      logger.warn({ mintAddress, error }, "Failed to check graduation status");
      return { graduated: false };
    }
  }
}

// Singleton
let clientInstance: PumpFunClient | null = null;

export function getPumpFunClient(): PumpFunClient {
  if (!clientInstance) {
    clientInstance = new PumpFunClient();
  }
  return clientInstance;
}
