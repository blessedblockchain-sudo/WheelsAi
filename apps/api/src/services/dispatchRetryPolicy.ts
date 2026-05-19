/**
 * Outbound dispatch retry classifier (plan A6).
 *
 * The agent-message worker calls this after a failed platform POST to
 * decide what to do next:
 *
 *   no_failure    — 2xx with ok:true (Slack) — nothing to do
 *   retriable     — 5xx, network blips, conservative unknowns → throw,
 *                   BullMQ retries with its own backoff
 *   poison        — 401/403/404 / Slack invalid_auth / channel_not_found
 *                   → log, mark delivery failed, do NOT retry. The channel
 *                   config or token is broken; humans must fix it.
 *   rate_limited  — 429 with retry-after → throw with explicit delay so
 *                   the worker can sleep before re-throwing into BullMQ
 *
 * Pure function. The worker layer applies these decisions; this module
 * never throws on its own.
 */

const DEFAULT_MAX_RETRY_AFTER_MS = 60 * 60 * 1000; // 1 hour

export type DispatchPlatform = "discord" | "telegram" | "slack";

export interface ClassifyInput {
  platform: DispatchPlatform;
  status: number;
  body: string;
  headers?: Record<string, string>;
  /** Cap retry-after to keep a misbehaving upstream from stalling the queue. */
  maxRetryAfterMs?: number;
}

export type ClassifyResult =
  | { outcome: "no_failure" }
  | {
      outcome: "retriable";
      reason?: string;
    }
  | {
      outcome: "poison";
      reason: "auth_failed" | "missing_access" | "channel_gone" | "user_blocked_bot";
    }
  | { outcome: "rate_limited"; retryAfterMs: number };

function safeJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clampRetryAfter(ms: number, maxMs: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, maxMs);
}

// ============================================
// Discord
// ============================================

function classifyDiscord(input: ClassifyInput, maxMs: number): ClassifyResult {
  if (input.status >= 200 && input.status < 300) return { outcome: "no_failure" };
  const json = safeJson(input.body);
  if (input.status === 401) return { outcome: "poison", reason: "auth_failed" };
  if (input.status === 403) return { outcome: "poison", reason: "missing_access" };
  if (input.status === 404) return { outcome: "poison", reason: "channel_gone" };
  if (input.status === 429) {
    const retrySec = typeof json?.retry_after === "number" ? json.retry_after : 1;
    return { outcome: "rate_limited", retryAfterMs: clampRetryAfter(retrySec * 1000, maxMs) };
  }
  if (input.status >= 500) return { outcome: "retriable", reason: "upstream_5xx" };
  // Unknown 4xx — conservative: poison so we don't burn retries on bad input.
  return { outcome: "poison", reason: "auth_failed" };
}

// ============================================
// Telegram
// ============================================

function classifyTelegram(input: ClassifyInput, maxMs: number): ClassifyResult {
  if (input.status >= 200 && input.status < 300) return { outcome: "no_failure" };
  const json = safeJson(input.body);
  const description =
    typeof json?.description === "string" ? json.description.toLowerCase() : "";

  if (input.status === 401) return { outcome: "poison", reason: "auth_failed" };
  if (input.status === 403) {
    if (description.includes("blocked by the user")) {
      return { outcome: "poison", reason: "user_blocked_bot" };
    }
    return { outcome: "poison", reason: "missing_access" };
  }
  if (input.status === 400 && description.includes("chat not found")) {
    return { outcome: "poison", reason: "channel_gone" };
  }
  if (input.status === 429) {
    const params =
      typeof json?.parameters === "object" && json.parameters !== null
        ? (json.parameters as Record<string, unknown>)
        : null;
    const retrySec = typeof params?.retry_after === "number" ? params.retry_after : 1;
    return { outcome: "rate_limited", retryAfterMs: clampRetryAfter(retrySec * 1000, maxMs) };
  }
  if (input.status >= 500) return { outcome: "retriable", reason: "upstream_5xx" };
  return { outcome: "retriable", reason: "telegram_unknown" };
}

// ============================================
// Slack
// ============================================
//
// Slack returns HTTP 200 with {ok:false, error: "..."} for app-level errors.
// Real HTTP errors (rare) are also handled below.

const SLACK_POISON_ERRORS: Record<string, ClassifyResult["outcome"] extends "poison" ? string : never> = {
  invalid_auth: "auth_failed",
  not_authed: "auth_failed",
  account_inactive: "auth_failed",
  token_revoked: "auth_failed",
  channel_not_found: "channel_gone",
  is_archived: "channel_gone",
  not_in_channel: "missing_access",
  missing_scope: "missing_access",
} as any;

function classifySlack(input: ClassifyInput, maxMs: number): ClassifyResult {
  if (input.status === 429) {
    const retryAfterHeader = input.headers?.["retry-after"];
    const retrySec = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : 1;
    return {
      outcome: "rate_limited",
      retryAfterMs: clampRetryAfter((Number.isFinite(retrySec) ? retrySec : 1) * 1000, maxMs),
    };
  }
  if (input.status >= 500) return { outcome: "retriable", reason: "upstream_5xx" };

  const json = safeJson(input.body);
  if (input.status >= 200 && input.status < 300) {
    if (json?.ok === true) return { outcome: "no_failure" };
    const error = typeof json?.error === "string" ? json.error : "";
    const poisonReason = SLACK_POISON_ERRORS[error];
    if (poisonReason) {
      return {
        outcome: "poison",
        reason: poisonReason as "auth_failed" | "missing_access" | "channel_gone" | "user_blocked_bot",
      };
    }
    // Unknown Slack-level error — let BullMQ retry conservatively.
    return { outcome: "retriable", reason: `slack_${error || "unknown"}` };
  }

  if (input.status === 401 || input.status === 403) {
    return { outcome: "poison", reason: "auth_failed" };
  }
  return { outcome: "retriable", reason: "slack_unknown" };
}

// ============================================
// Public API
// ============================================

export function classifyDispatchFailure(input: ClassifyInput): ClassifyResult {
  const maxMs = input.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  switch (input.platform) {
    case "discord":
      return classifyDiscord(input, maxMs);
    case "telegram":
      return classifyTelegram(input, maxMs);
    case "slack":
      return classifySlack(input, maxMs);
  }
}
