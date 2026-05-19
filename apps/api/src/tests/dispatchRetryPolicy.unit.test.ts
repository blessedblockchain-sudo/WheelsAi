import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/dispatchRetryPolicy.ts — the pure classifier
// the agent-message worker uses to decide throw-vs-skip after a failed
// platform POST. The worker's job is to MOVE A MESSAGE; broken-channel
// configs (revoked bot tokens, deleted channels) should poison-drop rather
// than spin BullMQ retries forever.
//
// Outcomes:
//   retriable      — 5xx, network errors → throw, BullMQ retries
//   poison         — 4xx auth/permission/not-found → log + skip
//   rate_limited   — 429 with retry-after → throw with explicit delay

// ============================================
// Discord
// ============================================

test("classifyDispatchFailure flags Discord 401 as poison (revoked bot token)", async () => {
  setupEnv();
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "discord",
    status: 401,
    body: '{"code":0,"message":"401: Unauthorized"}',
  });
  assert.equal(r.outcome, "poison");
  assert.equal(r.reason, "auth_failed");
});

test("classifyDispatchFailure flags Discord 403 (Missing Access) as poison", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "discord",
    status: 403,
    body: '{"code":50001,"message":"Missing Access"}',
  });
  assert.equal(r.outcome, "poison");
  assert.equal(r.reason, "missing_access");
});

test("classifyDispatchFailure flags Discord 404 (channel deleted) as poison", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "discord",
    status: 404,
    body: '{"code":10003,"message":"Unknown Channel"}',
  });
  assert.equal(r.outcome, "poison");
  assert.equal(r.reason, "channel_gone");
});

test("classifyDispatchFailure surfaces Discord 429 retry_after seconds", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "discord",
    status: 429,
    body: '{"message":"You are being rate limited.","retry_after":2.5,"global":false}',
  });
  assert.equal(r.outcome, "rate_limited");
  assert.equal(r.retryAfterMs, 2500);
});

test("classifyDispatchFailure treats Discord 500 as retriable", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "discord",
    status: 500,
    body: "internal error",
  });
  assert.equal(r.outcome, "retriable");
});

// ============================================
// Telegram
// ============================================

test("classifyDispatchFailure flags Telegram 'bot was blocked by the user' as poison", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "telegram",
    status: 403,
    body: '{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}',
  });
  assert.equal(r.outcome, "poison");
  assert.equal(r.reason, "user_blocked_bot");
});

test("classifyDispatchFailure flags Telegram 401 (invalid token) as poison", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "telegram",
    status: 401,
    body: '{"ok":false,"error_code":401,"description":"Unauthorized"}',
  });
  assert.equal(r.outcome, "poison");
  assert.equal(r.reason, "auth_failed");
});

test("classifyDispatchFailure honors Telegram parameters.retry_after for rate limits", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "telegram",
    status: 429,
    body: '{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}',
  });
  assert.equal(r.outcome, "rate_limited");
  assert.equal(r.retryAfterMs, 7000);
});

// ============================================
// Slack
// ============================================

test("classifyDispatchFailure flags Slack invalid_auth (HTTP 200, ok:false) as poison", async () => {
  // Slack returns HTTP 200 with {ok:false, error: "..."} for app-level errors.
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "slack",
    status: 200,
    body: '{"ok":false,"error":"invalid_auth"}',
  });
  assert.equal(r.outcome, "poison");
  assert.equal(r.reason, "auth_failed");
});

test("classifyDispatchFailure flags Slack channel_not_found as poison", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "slack",
    status: 200,
    body: '{"ok":false,"error":"channel_not_found"}',
  });
  assert.equal(r.outcome, "poison");
  assert.equal(r.reason, "channel_gone");
});

test("classifyDispatchFailure honors Slack rate-limit Retry-After header", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "slack",
    status: 429,
    body: '{"ok":false,"error":"ratelimited"}',
    headers: { "retry-after": "3" },
  });
  assert.equal(r.outcome, "rate_limited");
  assert.equal(r.retryAfterMs, 3000);
});

test("classifyDispatchFailure treats unknown Slack errors as retriable (conservative default)", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "slack",
    status: 200,
    body: '{"ok":false,"error":"surprise_error"}',
  });
  assert.equal(r.outcome, "retriable");
});

// ============================================
// Defaults
// ============================================

test("classifyDispatchFailure treats a successful HTTP 2xx as 'no_failure'", async () => {
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "discord",
    status: 200,
    body: "{}",
  });
  assert.equal(r.outcome, "no_failure");
});

test("classifyDispatchFailure caps rate_limited retryAfterMs to a sane upper bound", async () => {
  // A misbehaving upstream sending retry_after: 36000 (10h) would otherwise stall the queue.
  const { classifyDispatchFailure } = await import(
    "../services/dispatchRetryPolicy.js"
  );
  const r = classifyDispatchFailure({
    platform: "discord",
    status: 429,
    body: '{"retry_after":36000}',
    maxRetryAfterMs: 5 * 60 * 1000,
  });
  assert.equal(r.outcome, "rate_limited");
  assert.equal(r.retryAfterMs, 5 * 60 * 1000);
});
