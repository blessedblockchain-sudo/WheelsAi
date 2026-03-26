import { WheelsAIError } from "./error.js";

export interface ClientConfig {
  baseUrl: string;
  apiKey?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class WheelsAIClient {
  private baseUrl: string;
  private apiKey?: string;
  private token?: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.token = config.token;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  setToken(token: string): void {
    this.token = token;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      headers?: Record<string, string>;
    }
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

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...options?.headers,
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    } else if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
    }

    const res = await this.fetchFn(url, {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        data = await res.text().catch(() => null);
      }
      const message =
        (data as any)?.message || (data as any)?.error || res.statusText;
      throw new WheelsAIError(res.status, message, data);
    }

    if (res.status === 204) return undefined as T;

    return (await res.json()) as T;
  }

  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
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
