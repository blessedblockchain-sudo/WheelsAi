/**
 * Which browsers may read which responses.
 *
 * The API has two CORS policies, chosen per request by its path:
 *
 *   the app     every path but the widget's. One origin (CORS_ORIGIN, the
 *               WheelsAI web app) with credentials, because the dashboard
 *               authenticates with a cookie. Any origin in local development.
 *
 *   the widget  /api/widget/:publicKey/config and /chat. Any origin, WITHOUT
 *               credentials. An owner's customers sit on sites this server
 *               has never heard of, so the header cannot be an allowlist; it
 *               echoes the request's Origin and the route decides (403
 *               origin_not_allowed, from the key's own allowed origins).
 *               Because credentials are never allowed here, a page on any
 *               origin can read only what the key itself would give it: the
 *               session cookie of a signed-in WheelsAI user is neither sent
 *               nor honoured, and the widget routes never read request.auth.
 *
 * The widget policy is matched on the two exact route shapes, not on a path
 * prefix: nothing else can be moved under it by a crafted URL.
 *
 * Pure: the environment is passed in.
 */

import type { FastifyCorsOptions } from "@fastify/cors";

export interface CorsPolicyConfig {
  /** The web app's origin (env.CORS_ORIGIN). */
  corsOrigin: string;
  /** Local development: the app policy reflects any origin. */
  isDev: boolean;
}

/**
 * Without these a browser client can read none of them: the request id to
 * quote in a report, how long to wait after a 429, or whether a /v1 failure
 * is worth retrying.
 */
export const APP_EXPOSED_HEADERS = [
  "X-Request-Id",
  "Retry-After",
  "x-should-retry",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "X-RateLimit-Remaining-RPM",
  "X-RateLimit-Remaining-RPD",
  "X-RateLimit-Reset-RPM",
  "X-RateLimit-Reset-RPD",
] as const;

/** What the widget script needs: how long to wait, and an id to quote. */
export const WIDGET_EXPOSED_HEADERS = ["X-Request-Id", "Retry-After"] as const;

export const WIDGET_PREFLIGHT_MAX_AGE_SECONDS = 600;

const WIDGET_PATH = /^\/api\/widget\/[A-Za-z0-9_-]{1,128}\/(?:config|chat)$/;

/** Whether a request URL is one of the two public widget routes. */
export function isWidgetPath(url: string | undefined): boolean {
  if (typeof url !== "string") return false;
  const query = url.indexOf("?");
  return WIDGET_PATH.test(query === -1 ? url : url.slice(0, query));
}

export function corsOptionsFor(request: { url?: string }, config: CorsPolicyConfig): FastifyCorsOptions {
  if (isWidgetPath(request.url)) {
    return {
      // Echo, not "*": the response then varies by Origin, and a cache
      // between the visitor and the API cannot serve one site's answer to
      // another.
      origin: true,
      credentials: false,
      methods: ["GET", "POST"],
      allowedHeaders: ["content-type"],
      exposedHeaders: [...WIDGET_EXPOSED_HEADERS],
      maxAge: WIDGET_PREFLIGHT_MAX_AGE_SECONDS,
    };
  }
  return {
    // Reflect any origin only in local development.
    origin: config.isDev ? true : config.corsOrigin,
    credentials: true,
    exposedHeaders: [...APP_EXPOSED_HEADERS],
  };
}
