import { WheelsAIError, extractErrorInfo } from "./error.js";

export interface ClientConfig {
  /** API base URL, e.g. `https://api.example.com` (no trailing path). */
  baseUrl: string;
  /**
   * An API key (`wheels_live_...`). Sent as `Authorization: Bearer <key>`, which is
   * how the API reads API keys.
   */
  apiKey?: string;
  /** A session token from `auth.login`. Also sent as `Authorization: Bearer`. */
  token?: string;
  /** Custom fetch implementation (tests, proxies). Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Abort a request after this many milliseconds. Defaults to 30000; 0 disables. */
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** Per-call overrides for one request. */
export interface RequestOptions {
  /** Abort this request after this many milliseconds instead of the client's `timeoutMs`; 0 disables. */
  timeoutMs?: number;
  /** Extra request headers, e.g. `Idempotency-Key`. They cannot replace `Authorization`. */
  headers?: Record<string, string>;
}

/**
 * Percent-encode one path segment so ids and slugs can never change the route.
 * An empty segment, `.` and `..` are refused: encoding cannot protect them, because URL
 * parsing collapses dot segments (even written as `%2e`) and an empty one names the parent route.
 */
export function seg(value: string | number): string {
  const text = String(value);
  if (text === "" || text === "." || text === "..") {
    throw new WheelsAIError(0, `Invalid id or slug ${JSON.stringify(text)}: it cannot be used in a request path`);
  }
  return encodeURIComponent(text);
}

/** Visible ASCII only: anything else cannot be sent in an `Authorization` header. */
const SENDABLE_CREDENTIAL = /^[\x21-\x7e]+$/;

export class WheelsAIClient {
  private baseUrl: string;
  private apiKey?: string;
  private token?: string;
  private fetchFn: typeof globalThis.fetch;
  private timeoutMs: number;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey || undefined;
    this.token = config.token || undefined;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  setToken(token: string | undefined): void {
    this.token = token || undefined;
  }

  setApiKey(apiKey: string | undefined): void {
    this.apiKey = apiKey || undefined;
  }

  /** `Authorization` header value for the configured credential, if any. A session token wins over an API key. */
  private authorization(): string | undefined {
    const credential = this.token ?? this.apiKey;
    if (!credential) return undefined;
    // fetch would refuse the header with an error that quotes the whole credential.
    if (!SENDABLE_CREDENTIAL.test(credential)) {
      throw new WheelsAIError(
        0,
        "The API key or token contains whitespace or control characters, so it cannot be sent. Check it for a stray line break.",
      );
    }
    return `Bearer ${credential}`;
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Query;
      headers?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    if (options?.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    const hasBody = options?.body !== undefined;
    if (hasBody) headers["Content-Type"] = "application/json";
    Object.assign(headers, options?.headers);
    // Set last: a caller's header never replaces the configured credential.
    const authorization = this.authorization();
    if (authorization) headers["Authorization"] = authorization;

    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options!.body) : undefined,
        signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new WheelsAIError(0, `Request to ${this.baseUrl} timed out after ${timeoutMs}ms`);
      }
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
      const reason = cause ?? (err instanceof Error ? err.message : String(err));
      throw new WheelsAIError(0, `Could not reach ${this.baseUrl}: ${reason}`);
    }

    const text = res.status === 204 ? "" : await res.text().catch(() => "");

    if (!res.ok) {
      let data: unknown = text || null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON (a proxy's HTML error page, for instance): keep the text.
      }
      const { message, code } = extractErrorInfo(data, res.statusText || `HTTP ${res.status}`);
      throw new WheelsAIError(res.status, message, data, code);
    }

    if (!text) return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WheelsAIError(res.status, "The API returned a response that is not valid JSON", text);
    }
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, { body, timeoutMs: options?.timeoutMs, headers: options?.headers });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
