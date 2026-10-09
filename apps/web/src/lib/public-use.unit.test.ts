/**
 * What an agent's public page says when the server refuses, and the request
 * its free panels send. Run with:
 *   cd apps/web && npx tsx --test src/lib/public-use.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError, publicAgentApi, publicUseApi } from "./api";
import {
  PUBLIC_USE_MESSAGES,
  answersTooLong,
  chatWindow,
  publicOfflineNotice,
  publicStreamNotice,
  publicUseNotice,
  resultDate,
  waitInWords,
} from "./public-use";

const here = dirname(fileURLToPath(import.meta.url));

// ============================================
// Refusals
// ============================================

test("a wait is said in words, rounded up", () => {
  assert.equal(waitInWords(1), "1 second");
  assert.equal(waitInWords(45), "45 seconds");
  assert.equal(waitInWords(60), "1 minute");
  assert.equal(waitInWords(181), "4 minutes");
  assert.equal(waitInWords(3600), "1 hour");
  assert.equal(waitInWords(7300), "3 hours");
  assert.equal(waitInWords(0), "1 second");
});

test("a visitor over their own limit is told how long to wait", () => {
  const notice = publicUseNotice(429, { error: "rate_limited", scope: "ip", retryAfterSeconds: 240 }, "chat");
  assert.equal(notice.message, "You have reached the limit for now. Try again in 4 minutes.");
  assert.equal(notice.retryAfterSeconds, 240);
  assert.equal(notice.paused, false);
  // With no wait given, still a sentence.
  assert.equal(
    publicUseNotice(429, { error: "rate_limited", scope: "ip" }, "task").message,
    "You have reached the limit for now. Try again in a moment.",
  );
  // A 429 from a proxy carries no scope at all.
  assert.match(publicUseNotice(429, null, "chat").message, /^You have reached the limit for now\./);
});

test("the page's daily limit says tomorrow; its minute limit says when", () => {
  const day = publicUseNotice(429, { error: "rate_limited", scope: "key", retryAfterSeconds: 5 * 3600 }, "task");
  assert.equal(day.message, "This agent has reached its limit for today. Try again tomorrow.");
  const minute = publicUseNotice(429, { error: "rate_limited", scope: "key", retryAfterSeconds: 30 }, "chat");
  assert.equal(minute.message, "This agent is getting a lot of use right now. Try again in 30 seconds.");
});

test("answers that are too long, and a message that is", () => {
  assert.equal(
    publicUseNotice(413, { error: "input_too_large" }, "task").message,
    "Your answers are too long. Shorten them and try again.",
  );
  assert.equal(publicUseNotice(413, { error: "invalid_request" }, "chat").message, PUBLIC_USE_MESSAGES.messageTooLong);
});

test("a 422 puts each sentence under its question", () => {
  const notice = publicUseNotice(
    422,
    {
      error: "input_invalid",
      message: "Some answers need another look.",
      details: [
        { path: "/topic", field: "topic", label: "Topic", message: "This question needs an answer." },
        { path: "/link", field: "link", label: "Link", message: "Enter a full link, such as https://example.com." },
        { path: "/link", field: "link", label: "Link", message: "Keep this answer to 2,048 characters or fewer." },
        { path: "", field: null, label: null, message: "Send your answers as an object, with one entry for each question." },
        "not an issue",
      ],
    },
    "task",
  );
  assert.equal(notice.message, "Some answers need another look.");
  assert.deepEqual(notice.fields, {
    topic: "This question needs an answer.",
    link: "Enter a full link, such as https://example.com. Keep this answer to 2,048 characters or fewer.",
    "": "Send your answers as an object, with one entry for each question.",
  });
  // No details: the sentence alone.
  assert.deepEqual(publicUseNotice(422, { error: "input_invalid" }, "task").fields, {});
});

test("a key that stopped working reads as the paused page", () => {
  const notice = publicUseNotice(404, { error: "widget_key_not_found", message: "Not found." }, "chat");
  assert.equal(notice.message, "This agent is paused. Its owner has turned off public use for now.");
  assert.equal(notice.paused, true);
});

test("the owner's plan limit, and a model that failed, keep their sentences", () => {
  assert.equal(
    publicUseNotice(503, { error: "agent_unavailable", reason: "quota_exhausted" }, "chat").message,
    "This agent has reached its usage limit for now. Please try again later.",
  );
  assert.equal(
    publicUseNotice(502, { error: "model_error" }, "task").message,
    "The agent could not answer just now. Please try again.",
  );
  assert.equal(publicStreamNotice({ message: "upstream 500 from provider", code: "model_error" }).message, PUBLIC_USE_MESSAGES.couldNotAnswer);
  assert.equal(publicUseNotice(503, { error: "agent_unavailable", reason: "restarting" }, "chat").message, PUBLIC_USE_MESSAGES.restarting);
  assert.equal(publicUseNotice(503, { error: "rate_limiter_unavailable" }, "chat").message, PUBLIC_USE_MESSAGES.pageUnavailable);
  assert.equal(publicUseNotice(503, { error: "agent_unavailable", reason: "payment_required" }, "chat").message, PUBLIC_USE_MESSAGES.unavailable);
});

test("every refusal the public routes can send has a sentence of ours, never the server's wording", () => {
  const serverWords = "This site is not allowed to use this chat widget.";
  const cases: Array<[number, string]> = [
    [400, "invalid_request"],
    [403, "origin_not_allowed"],
    [404, "widget_key_not_found"],
    [409, "not_a_task_agent"],
    [413, "input_too_large"],
    [422, "input_invalid"],
    [429, "rate_limited"],
    [500, "internal_error"],
    [502, "model_error"],
    [503, "agent_unavailable"],
    [503, "rate_limiter_unavailable"],
  ];
  const ours = new Set<string>(Object.values(PUBLIC_USE_MESSAGES));
  for (const kind of ["chat", "task"] as const) {
    for (const [status, error] of cases) {
      const { message } = publicUseNotice(status, { error, message: serverWords, scope: "ip" }, kind);
      assert.ok(message.length > 0, `${status} ${error}`);
      assert.notEqual(message, serverWords);
      assert.doesNotMatch(message, /widget|key|cap\b|\bid\b/i, `${status} ${error}: ${message}`);
      assert.doesNotMatch(message, /—/, "no em dash");
      // Ours, or ours with the wait after it.
      assert.ok(ours.has(message) || [...ours].some((sentence) => message.startsWith(`${sentence} Try again`)), message);
    }
  }
  assert.doesNotMatch(publicOfflineNotice().message, /widget/i);
});

test("a body that is not an object still gets a sentence", () => {
  assert.equal(publicUseNotice(500, null, "chat").message, PUBLIC_USE_MESSAGES.unknown);
  assert.equal(
    publicUseNotice(429, { scope: 7, retryAfterSeconds: "soon" } as never, "chat").message,
    "You have reached the limit for now. Try again in a moment.",
  );
});

// ============================================
// What a chat sends
// ============================================

const limits = { maxMessages: 4, maxMessageChars: 100, maxTotalChars: 20 };

test("a chat within the limits is sent whole", () => {
  const turns = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "hello" },
    { role: "user" as const, content: "more" },
  ];
  assert.deepEqual(chatWindow(turns, limits), turns);
});

test("a long chat drops its oldest turns and always keeps the new message", () => {
  const turns = Array.from({ length: 7 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `m${i}`,
  }));
  const sent = chatWindow(turns, limits);
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map((turn) => turn.content), ["m3", "m4", "m5", "m6"]);
  assert.equal(sent[sent.length - 1]!.role, "user");

  const long = [
    { role: "user" as const, content: "a".repeat(15) },
    { role: "assistant" as const, content: "b".repeat(10) },
    { role: "user" as const, content: "c".repeat(8) },
  ];
  assert.deepEqual(chatWindow(long, limits).map((turn) => turn.content[0]), ["b", "c"]);
  // The new message goes even when it alone is over the total: the server answers that.
  assert.equal(chatWindow([{ role: "user", content: "x".repeat(50) }], limits).length, 1);
  // An answer that never arrived is not sent back.
  assert.deepEqual(
    chatWindow(
      [
        { role: "user", content: "one" },
        { role: "assistant", content: "" },
        { role: "user", content: "two" },
      ],
      limits,
    ).map((turn) => turn.content),
    ["one", "two"],
  );
});

test("answers over the page's limit are caught before they are sent", () => {
  assert.equal(answersTooLong({ topic: "abc", tags: ["de", "f"], count: 12, ok: true }, 12), false);
  assert.equal(answersTooLong({ topic: "abc", tags: ["de", "f"], count: 12, ok: true }, 11), true);
  assert.equal(answersTooLong({}, 0), false);
});

test("a result's date reads as a date, and a bad one as nothing", () => {
  assert.equal(resultDate("2026-10-12T09:00:00.000Z", "en-GB", "UTC"), "12 Oct 2026, 09:00");
  assert.equal(resultDate("not a date"), "");
});

// ============================================
// The free fetch
// ============================================

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Sent {
  url: string;
  init: RequestInit;
}

function stubFetch(response: () => Response): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    return response();
  }) as typeof fetch;
  return sent;
}

const stream = () =>
  new Response('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

test("publicUseApi never sends cookies, and reads the answer as a stream", async () => {
  const sent = stubFetch(stream);
  const signal = new AbortController().signal;

  let chat = "";
  for await (const event of publicUseApi.chat("wk_live_abc", { messages: [{ role: "user", content: "hi" }] }, signal)) {
    if (event.type === "delta") chat += event.content;
  }
  let run = "";
  for await (const event of publicUseApi.run("wk_live_abc", { input: { topic: "tea" } }, signal)) {
    if (event.type === "delta") run += event.content;
  }
  assert.equal(chat, "Hello");
  assert.equal(run, "Hello");

  assert.equal(sent.length, 2);
  assert.match(sent[0]!.url, /\/api\/widget\/wk_live_abc\/chat$/);
  assert.match(sent[1]!.url, /\/api\/widget\/wk_live_abc\/run$/);
  for (const request of sent) {
    assert.equal(request.init.credentials, "omit", request.url);
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.signal, signal);
    assert.equal(JSON.parse(String(request.init.body)).stream, true);
    const headers = Object.keys((request.init.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
    assert.deepEqual(headers, ["content-type"], "no cookie or authorization header");
  }
  assert.deepEqual(JSON.parse(String(sent[1]!.init.body)).input, { topic: "tea" });
});

test("a refusal throws before anything is yielded, with the body the notice reads", async () => {
  stubFetch(
    () =>
      new Response(JSON.stringify({ error: "rate_limited", message: "Too many messages.", scope: "ip", retryAfterSeconds: 61 }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
  );
  await assert.rejects(
    async () => {
      for await (const _event of publicUseApi.run("wk_live_abc", { input: {} })) assert.fail("nothing is yielded");
    },
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(
        publicUseNotice(error.status, error.data as Record<string, unknown>, "task").message,
        "You have reached the limit for now. Try again in 2 minutes.",
      );
      return true;
    },
  );
});

test("the browser's read of a public page never sends cookies either", async () => {
  const sent = stubFetch(
    () =>
      new Response(JSON.stringify({ agent: { name: "Helper" }, use: { state: "on" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const detail = await publicAgentApi.get("helper");
  assert.equal(detail.agent.name, "Helper");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.url, /\/api\/a\/helper$/);
  assert.equal(sent[0]!.init.credentials, "omit");
  assert.equal(sent[0]!.init.method, "GET");
  const headers = Object.keys((sent[0]!.init.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
  assert.deepEqual(headers, ["accept"], "no cookie or authorization header");

  stubFetch(() => new Response(JSON.stringify({ error: "agent_not_found" }), { status: 404 }));
  await assert.rejects(
    () => publicAgentApi.get("gone"),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
});

test("the visitor's fetch is the only place in api.ts that omits credentials, and nothing a visitor sends goes through api()", () => {
  const source = readFileSync(join(here, "api.ts"), "utf8");
  const start = source.indexOf("function publicFetch");
  const end = source.indexOf("export const tryItApi");
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, source.indexOf("\n};", source.indexOf("export const publicUseApi")));
  assert.match(block, /export const publicAgentApi/, "the public page's own read is inside the block");
  assert.match(block, /credentials: "omit"/);
  assert.doesNotMatch(block, /credentials: "include"/);
  assert.doesNotMatch(block, /\bapi<|\bapi\(/, "never the shared helper, which always sends cookies");
  assert.equal(source.split('credentials: "omit"').length - 1, 1);
});

test("the free panels reach the agent only through publicUseApi", () => {
  const transport = readFileSync(join(here, "..", "components", "public-agent", "transport.ts"), "utf8");
  assert.match(transport, /publicUseApi\.chat/);
  assert.match(transport, /publicUseApi\.run/);
  for (const file of ["public-chat-panel.tsx", "public-task-panel.tsx", "public-results-panel.tsx"]) {
    const panel = readFileSync(join(here, "..", "components", "public-agent", file), "utf8");
    assert.doesNotMatch(panel, /\bfetch\(/, file);
    assert.doesNotMatch(panel, /api\/widget/, file);
    assert.doesNotMatch(panel, /publicUseApi|agentsApi/, file);
  }
});
