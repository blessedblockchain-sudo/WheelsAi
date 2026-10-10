/**
 * What Try it says when the server refuses. Run with:
 *   cd apps/web && npx tsx --test src/lib/try-it.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_RUN_LINE, inputAsText, taskFieldsOf, taskInputSchema, type TaskField } from "@wheelsai/shared/agent-kind";

import {
  TRY_IT_WORDS,
  tryItDisabledMessage,
  tryItFormMessage,
  tryItFormProblem,
  tryItMode,
  tryItNotice,
  tryItSampleMessage,
  tryItUseSentence,
  previewUsedUpLine,
} from "./try-it";

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

test("an answer that was withheld says so and lets the visitor ask again", () => {
  const notice = tryItNotice(502, { error: "answer_withheld", message: "This answer could not be shown. Try asking in another way." });
  assert.equal(notice.message, "This answer could not be shown. Try asking in another way.");
  assert.equal(notice.action, "none");
  assert.equal(notice.ended, false);
  assert.equal(tryItNotice(502, { error: "answer_withheld" }).message, "This answer could not be shown. Try asking in another way.");
  // Any other 502 is still the generic sentence.
  assert.equal(tryItNotice(502, { error: "model_error" }).message, "The agent could not answer just now. Try again.");
});

// ============================================
// What the panel draws, and what it sends
// ============================================

const FIELDS: TaskField[] = [
  { key: "topic", label: "Topic", type: "short_text", required: true },
  { key: "keywords", label: "Keywords", type: "list", required: false },
  { key: "length", label: "How many words?", type: "number", required: false },
  { key: "sources", label: "Cite sources", type: "yes_no", required: false },
];

test("the panel draws a form for a task agent, one button for a self-running one, a chat otherwise", () => {
  assert.equal(tryItMode("task", taskInputSchema(FIELDS)), "form");
  assert.equal(tryItMode("scheduled", null), "sample");
  assert.equal(tryItMode("conversation", null), "chat");
  // An older answer with no kind, or a kind this build does not know, is a chat as before.
  assert.equal(tryItMode(undefined, null), "chat");
  assert.equal(tryItMode(null, undefined), "chat");
  assert.equal(tryItMode("something_new", null), "chat");
});

test("a task agent whose form cannot be drawn is tried as a chat", () => {
  assert.equal(tryItMode("task", null), "chat");
  assert.equal(tryItMode("task", { type: "object", properties: {} }), "chat");
});

test("a form's answers go out as one message, worded as a run words them", () => {
  const schema = taskInputSchema(FIELDS);
  const input = { topic: "Solar panels", keywords: ["rooftop", "payback"], length: 300, sources: true };
  const message = tryItFormMessage(schema, input);
  assert.equal(message, "Topic: Solar panels\n\nKeywords:\n- rooftop\n- payback\n\nHow many words?: 300\n\nCite sources: Yes");
  // The same text the agent's own run gives the model.
  assert.equal(message, inputAsText(FIELDS, input));
});

test("unanswered questions are left out, and so is anything the form does not ask for", () => {
  const schema = taskInputSchema(FIELDS);
  assert.equal(tryItFormMessage(schema, { topic: "Solar panels", extra: "ignored" }), "Topic: Solar panels");
  assert.equal(tryItFormMessage(schema, {}), "");
  assert.equal(tryItFormMessage(schema, null), "");
});

test("a form with one question is just its answer", () => {
  const fields = taskFieldsOf(null);
  assert.equal(fields.length, 1);
  const schema = taskInputSchema(fields);
  assert.equal(tryItFormMessage(schema, { [fields[0]!.key]: "  Summarize this page  " }), "Summarize this page");
});

test("a question with no title in its schema is named from its key, as the form names it", () => {
  const schema = { type: "object", properties: { company_name: { type: "string" }, city: { type: "string" } } };
  assert.equal(tryItFormMessage(schema, { company_name: "Acme", city: "Lagos" }), "Company name: Acme\n\nCity: Lagos");
});

test("Run a sample sends the line a self-running agent is told at each run", () => {
  assert.equal(tryItSampleMessage(), DEFAULT_RUN_LINE);
  assert.equal(TRY_IT_WORDS.runSample, "Run a sample");
});

test("a listing that sells use says the sample runs on another model; one that sells copies says nothing more", () => {
  assert.equal(
    tryItUseSentence("use"),
    "This sample runs on a free model that WheelsAI provides. The agent itself may use a different model, so its answers can differ.",
  );
  assert.equal(tryItUseSentence("copies"), null);
  assert.equal(tryItUseSentence(undefined), null);
  assert.equal(tryItUseSentence(null), null);
});

test("answers that are empty or over the limit for one message are stopped before they are sent", () => {
  assert.equal(tryItFormProblem("", 100), TRY_IT_WORDS.answersEmpty);
  assert.equal(tryItFormProblem("   ", 100), TRY_IT_WORDS.answersEmpty);
  assert.equal(tryItFormProblem("x".repeat(101), 100), TRY_IT_WORDS.answersTooLong);
  assert.equal(tryItFormProblem("x".repeat(100), 100), null);
});

test("a preview that is used up says what to do next for what the listing sells", () => {
  assert.equal(
    previewUsedUpLine("use"),
    "You have used every message in this preview. Use the agent on its page to keep going.",
  );
  assert.equal(
    previewUsedUpLine("copies"),
    "You have used every message in this preview. Install or hire the agent to keep going.",
  );
  assert.equal(previewUsedUpLine(undefined), previewUsedUpLine("copies"));
  const now = new Date("2026-10-07T23:00:00.000Z");
  assert.equal(tryItNotice(429, { error: "rate_limited", scope: "session" }, now, "use").message, previewUsedUpLine("use"));
  assert.match(tryItNotice(429, { error: "trial_cap_reached" }, now, "use").message, /You can still use it on its page\.$/);
  assert.match(tryItNotice(429, { error: "trial_cap_reached" }, now).message, /You can still install or hire it\.$/);
});
