/**
 * Sentry error tracking (B7) — errors only, no tracing.
 *
 * SENTRY_DSN unset ⇒ everything here is a no-op; the API runs exactly as
 * before. With a DSN:
 *   - initSentry() boots the SDK (tracesSampleRate 0 — this is error
 *     tracking "at minimum", not performance monitoring), which also
 *     installs Sentry's default uncaught-exception / unhandled-rejection
 *     handlers for worker crashes.
 *   - registerSentryErrorCapture() adds an `onError` hook that reports
 *     5xx-class route errors. Deliberately a HOOK, not
 *     setupFastifyErrorHandler / setErrorHandler: it composes with the
 *     app's globalErrorHandler regardless of registration order, and 4xx
 *     business refusals (validation, auth, honest 501 gates) never reach
 *     Sentry — they're the API working as designed, not defects.
 *
 * Both functions take their Sentry surface as an injectable parameter so
 * the wiring is unit-testable without the SDK's global state.
 */

import * as Sentry from "@sentry/node";
import type { FastifyInstance } from "fastify";

export interface SentryInitConfig {
  dsn?: string;
  environment: string;
}

export function initSentry(
  config: SentryInitConfig,
  initFn: (options: {
    dsn: string;
    environment: string;
    tracesSampleRate: number;
  }) => unknown = Sentry.init,
): boolean {
  if (!config.dsn) return false;
  initFn({
    dsn: config.dsn,
    environment: config.environment,
    tracesSampleRate: 0,
  });
  return true;
}

export function registerSentryErrorCapture(
  app: Pick<FastifyInstance, "addHook">,
  capture: (error: unknown) => unknown = Sentry.captureException,
): void {
  app.addHook("onError", async (_request, _reply, error) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      capture(error);
    }
  });
}
