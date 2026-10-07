/**
 * What Try it says when the server refuses. Run with:
 *   cd apps/web && npx tsx --test src/lib/try-it.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { tryItDisabledMessage, tryItNotice } from "./try-it";

const now = new Date("2026-10-07T22:00:00.000Z");

test("no human check configured: an anonymous visitor is sent to sign in", () => {
  const fromSession = tryItNotice(401, { error: "signin_required", message: "Sign in to try this agent." });
  assert.deepEqual(fromSession, { message: "Sign in to try this agent.", action: "signin", ended: true });
  // The chat core says the same thing in its own shape.
  const fromChat = tryItNotice(401, { error: "trial_session_invalid", reason: "signin_required" });
  assert.equal(fromChat.action, "signin");
});

test("an expired or moved session offers a new one", () => {
  for (const reason of ["expired", "bad_signature", "wrong_listing", "malformed"]) {
    const notice = tryItNotice(401, { error: "trial_session_invalid", reason });
    assert.equal(notice.action, "session");
    assert.equal(notice.ended, false);
  }
  assert.match(tryItNotice(401, { error: "trial_session_invalid", reason: "network_changed" }).message, /network changed/);
});

test("the listing's daily cap says when it starts over and ends the preview", () => {
  const notice = tryItNotice(429, { error: "trial_cap_reached", resetsAt: "2026-10-08T00:00:00.000Z" }, now);
  assert.match(notice.message, /start again in 2 hours/);
  assert.equal(notice.ended, true);
  assert.equal(tryItNotice(429, { error: "trial_cap_reached" }, now).ended, true);
});

test("limits: the session's messages end the preview, a rate limit says how long to wait", () => {
  assert.equal(tryItNotice(429, { error: "rate_limited", scope: "session" }).ended, true);
  const ip = tryItNotice(429, { error: "rate_limited", scope: "ip", retryAfterSeconds: 42 });
  assert.equal(ip.ended, false);
  assert.match(ip.message, /too quickly\. Try again in 42 seconds\./);
  assert.match(tryItNotice(429, { error: "rate_limited", scope: "global", retryAfterSeconds: 90 }).message, /busy.*2 minutes/);
  assert.match(tryItNotice(429, { error: "rate_limited", scope: "ip" }).message, /in a moment/);
});

test("the limiter being down is said calmly, and nothing is offered that cannot work", () => {
  const notice = tryItNotice(503, { error: "rate_limiter_unavailable" });
  assert.equal(notice.message, "Previews are temporarily unavailable. Try again shortly.");
  assert.equal(notice.action, "none");
  assert.match(tryItNotice(503, { error: "agent_unavailable", reason: "restarting" }).message, /not available right now/);
});

test("the human check's three outcomes", () => {
  assert.equal(tryItNotice(400, { error: "turnstile_required" }).action, "none");
  assert.equal(tryItNotice(403, { error: "turnstile_failed" }).action, "signin");
  assert.equal(tryItNotice(503, { error: "turnstile_unavailable" }).action, "signin");
});

test("a bad request shows the server's sentence; anything unknown is generic", () => {
  assert.equal(tryItNotice(400, { error: "invalid_request", message: "The request is not valid" }).message, "The request is not valid");
  assert.equal(tryItNotice(500, null).message, "Something went wrong. Try again.");
  assert.equal(tryItNotice(404, { error: "listing_not_found" }).ended, true);
  assert.equal(tryItNotice(501, { error: "not_supported" }).ended, true);
});

test("why a listing has no preview", () => {
  assert.match(tryItDisabledMessage("graph_agent_preview"), /graph/);
  assert.match(tryItDisabledMessage("no_model_available"), /free model/);
  assert.match(tryItDisabledMessage(null), /cannot be previewed/);
});
