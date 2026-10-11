import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from "fastify";

import { requireScope } from "../middleware/auth.js";
import { createPaidUseRoutes } from "../routes/paidUse.js";
import {
  CREATOR_ORG,
  FREE_MODEL,
  HANDLE,
  INSTRUCTIONS,
  KEY_CALLER,
  LEAK,
  LICENCE,
  LISTING,
  MONTHLY_LICENCE,
  MONTHLY_LISTING,
  PAID_MONTH,
  paidHarness,
  SESSION,
  TASK_FORM,
  type PaidHarness,
  type PaidHarnessOptions,
} from "./paidUseHarness.js";

// The four paid routes over HTTP: the guards, the shapes of each answer and
// every refusal with its status, code and sentence. The core is the real one
// on the harness's stand-ins; the scope guard is the app's own.

/** Stands in for the app's auth hook and requireAuth: who the header says, or 401. */
const auth: preHandlerAsyncHookHandler = async (request, reply) => {
  const header = request.headers["x-test-auth"];
  if (typeof header !== "string") {
    return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
  }
  (request as { auth: unknown }).auth = JSON.parse(header);
};

async function server(options: PaidHarnessOptions = {}): Promise<{ app: FastifyInstance; h: PaidHarness }> {
  const h = paidHarness(options);
  const app = Fastify();
  await app.register(
    createPaidUseRoutes({
      guards: { auth, use: requireScope("agents:use") as preHandlerAsyncHookHandler },
      paidUse: () => h.deps,
    }),
    { prefix: "/api" },
  );
  return { app, h };
}

const as = (caller: object) => ({ "x-test-auth": JSON.stringify(caller) });
const CHAT = { messages: [{ role: "user", content: "Hi, I am Ada." }], stream: false };
const RUN = { input: { topic: "Launch plan" }, stream: false };
const TASK_AGENT = { agentKind: "task", kindConfig: TASK_FORM, name: "Brief Writer" };

test("all four routes need a caller: 401 without one, and nothing is looked up", async () => {
  const { app, h } = await server();
  for (const [method, path] of [
    ["GET", "access"],
    ["POST", "chat"],
    ["POST", "run"],
    ["GET", "results"],
  ] as const) {
    const res = await app.inject({ method, url: `/api/a/${HANDLE}/${path}`, ...(method === "POST" && { payload: CHAT }) });
    assert.equal(res.statusCode, 401, path);
  }
  assert.deepEqual(h.log, []);
});

test("to pay, a key must have been granted agents:use by name; reading needs no scope", async () => {
  for (const scopes of [[], ["*"], ["agents:invoke", "marketplace:install"]]) {
    const { app, h } = await server({ keyCaps: { maxUse: 50n, daily: 100n } });
    const key = as({ ...KEY_CALLER, scopes });
    for (const [path, payload] of [
      ["chat", CHAT],
      ["run", RUN],
    ] as const) {
      const res = await app.inject({ method: "POST", url: `/api/a/${HANDLE}/${path}`, headers: key, payload });
      assert.equal(res.statusCode, 403, `${path} ${JSON.stringify(scopes)}`);
      assert.equal(res.json().error, "missing_scope");
      assert.equal(res.json().scope, "agents:use");
    }
    assert.deepEqual(h.log, [], "refused before the buyer's limits are counted");

    const access = await app.inject({ method: "GET", url: `/api/a/${HANDLE}/access`, headers: key });
    assert.equal(access.statusCode, 200);
  }

  const { app, h } = await server({ keyCaps: { maxUse: 50n, daily: 100n } });
  const res = await app.inject({ method: "POST", url: `/api/a/${HANDLE}/chat`, headers: as(KEY_CALLER), payload: CHAT });
  assert.equal(res.statusCode, 200);
  assert.equal(h.money.keySpent, 5n);
});

test("POST /a/:handle/chat answers { message, toolCalls, billing } and nothing else", async () => {
  const { app, h } = await server();
  const res = await app.inject({ method: "POST", url: `/api/a/${HANDLE}/chat`, headers: as(SESSION), payload: CHAT });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(res.json(), {
    message: { role: "assistant", content: "Hello, Ada. How can I help?" },
    toolCalls: [{ name: "web_search", status: "unavailable" }],
    billing: { chargedCents: 5, balanceCents: 495, access: "listing_pricing" },
  });
  for (const secret of [INSTRUCTIONS, FREE_MODEL, CREATOR_ORG, "TAVILY"]) assert.ok(!res.body.includes(secret), secret);
  assert.deepEqual(
    h.money.revenue.map((r) => r.status),
    ["settled"],
  );
  // The handle in the address is not case sensitive.
  const upper = await app.inject({ method: "POST", url: `/api/a/Support-Bot/chat`, headers: as(SESSION), payload: CHAT });
  assert.equal(upper.statusCode, 200);
});

/**
 * A streamed answer's charge is closed when the stream has been delivered,
 * which can be a tick after the response itself ends. Waits for it, so the
 * checks that follow do not race the settle on a busy machine.
 */
async function chargeClosed(h: { log: string[] }): Promise<void> {
  for (let i = 0; i < 400 && !h.log.includes("settle") && !h.log.includes("refund"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a stream is the whole answer in the public encoding, after its billing event, and settles once", async () => {
  const { app, h } = await server();
  const res = await app.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/chat`,
    headers: as(SESSION),
    payload: { messages: CHAT.messages },
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/event-stream/);
  const events = res.body.split("\n\n").filter((event) => event.startsWith("data:"));
  assert.deepEqual(JSON.parse(events[0]!.slice(5)), {
    wheelsai: { billing: { chargedCents: 5, balanceCents: 495, access: "listing_pricing" } },
  });
  const text = events
    .slice(1, -1)
    .map((event) => JSON.parse(event.slice(5)).choices?.[0]?.delta?.content ?? "")
    .join("");
  assert.equal(text, "Hello, Ada. How can I help?");
  assert.equal(events[events.length - 1], "data: [DONE]");
  for (const secret of [FREE_MODEL, "chatcmpl", "usage"]) assert.ok(!res.body.includes(secret), secret);
  await chargeClosed(h);
  assert.deepEqual(
    h.money.revenue.map((r) => r.status),
    ["settled"],
  );
  assert.equal(h.log.filter((entry) => entry === "settle").length, 1);
  assert.ok(!h.log.includes("refund"));
});

test("POST /a/:handle/run answers { output, toolCalls, billing }; a wrong input is 422 with each answer to fix", async () => {
  const { app, h } = await server({ agent: TASK_AGENT });
  const res = await app.inject({ method: "POST", url: `/api/a/${HANDLE}/run`, headers: as(SESSION), payload: RUN });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    output: { format: "text", text: "Hello, Ada. How can I help?" },
    toolCalls: [{ name: "web_search", status: "unavailable" }],
    billing: { chargedCents: 5, balanceCents: 495, access: "listing_pricing" },
  });

  const wrong = await app.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/run`,
    headers: as(SESSION),
    payload: { input: { notes: "no topic", extra: 1 }, stream: false },
  });
  assert.equal(wrong.statusCode, 422);
  assert.equal(wrong.json().error, "input_invalid");
  assert.ok(Array.isArray(wrong.json().details) && wrong.json().details.length >= 2);
  assert.equal(wrong.json().details[0].field, "topic");

  const long = await app.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/run`,
    headers: as(SESSION),
    payload: { input: { topic: "x".repeat(9_000) }, stream: false },
  });
  assert.equal(long.statusCode, 413);
  assert.equal(long.json().error, "input_too_large");

  // A body the parser refuses for its size is the same refusal.
  const huge = await app.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/run`,
    headers: as(SESSION),
    payload: { input: { topic: "x".repeat(80_000) }, stream: false },
  });
  assert.equal(huge.statusCode, 413);
  assert.equal(huge.json().error, "input_too_large");

  // One charge in all: only the first request ran.
  assert.equal(h.money.revenue.length, 1);
  assert.equal(h.money.balance, 495n);
});

interface Refusal {
  name: string;
  options?: PaidHarnessOptions;
  path?: "chat" | "run";
  caller?: object;
  payload?: unknown;
  url?: string;
  status: number;
  code: string;
  message: string | RegExp;
  retryAfter?: boolean;
}

const REFUSALS: Refusal[] = [
  { name: "an unknown key in the body", payload: { ...CHAT, model: "x" }, status: 400, code: "invalid_request", message: /Send \{ messages/ },
  { name: "a run body that is not a form", path: "run", options: { agent: TASK_AGENT }, payload: CHAT, status: 400, code: "invalid_request", message: /Send your answers as/ },
  { name: "no licence", options: { licence: null }, status: 403, code: "use_not_started", message: /You have not started using this agent/ },
  {
    name: "a key over its cap",
    options: { keyCaps: { maxUse: 4n, daily: 100n } },
    caller: KEY_CALLER,
    status: 403,
    code: "api_key_use_price_cap_exceeded",
    message: "This use costs more than this API key may spend on one use ($0.04).",
  },
  {
    name: "a key past its day",
    options: { keyCaps: { maxUse: 50n, daily: 100n, spent: 98n } },
    caller: KEY_CALLER,
    status: 403,
    code: "api_key_daily_cap_exceeded",
    message: "This use would take this API key past what it may spend in one day ($1.00).",
  },
  {
    name: "a key without caps",
    options: { keyCaps: { maxUse: null, daily: null } },
    caller: KEY_CALLER,
    status: 403,
    code: "api_key_spend_caps_missing",
    message: /no spend caps for paid agents/,
  },
  {
    name: "too few credits",
    options: { balance: 1n },
    status: 402,
    code: "insufficient_credits",
    message: "You do not have enough credits for this message ($0.05). Nothing was charged. Add credits to continue.",
  },
  {
    name: "a lapsed subscription",
    options: {
      listing: MONTHLY_LISTING,
      licence: MONTHLY_LICENCE,
      sub: { ...PAID_MONTH, status: "expired", currentPeriodEnd: new Date("2026-10-01T00:00:00Z") },
    },
    status: 402,
    code: "subscription_lapsed",
    message: "Your subscription has ended. Subscribe again to keep using it.",
  },
  { name: "an unknown handle", url: "/api/a/nobody-here/chat", status: 404, code: "agent_not_found", message: "This agent was not found." },
  {
    name: "the caller's own agent",
    caller: { ...SESSION, orgId: CREATOR_ORG },
    status: 409,
    code: "own_agent",
    message: "This is your agent. This is the page people who pay see.",
  },
  {
    name: "a free listing",
    options: { listing: { ...LISTING, pricingModel: "free" } },
    status: 409,
    code: "not_for_sale",
    message: "This agent is free to use on its page, so there is nothing to pay for here.",
  },
  {
    name: "a listing that stopped selling use",
    options: { listing: { ...LISTING, sells: "copies" } },
    status: 409,
    code: "not_offered",
    message: "This agent is no longer offered. You will not be charged again.",
  },
  {
    name: "a chat with a self-running agent",
    options: { agent: { agentKind: "scheduled" }, listing: MONTHLY_LISTING, licence: MONTHLY_LICENCE, sub: PAID_MONTH },
    status: 409,
    code: "results_only",
    message: "This agent runs on its own. Subscribers read its results on its page.",
  },
  {
    name: "a higher price",
    options: { listing: { ...LISTING, pricePerRequestCents: 8n } },
    status: 409,
    code: "pricing_changed",
    message: "The owner changed the price to $0.08 per message. You agreed to $0.05. Nothing is charged until you accept the new price.",
  },
  { name: "a run of a chat agent", path: "run", status: 409, code: "not_a_task_agent", message: /./ },
  {
    name: "the buyer's limit for the minute",
    options: { limits: { perBuyerPerMinute: 0 } },
    status: 429,
    code: "rate_limited",
    message: "You are sending requests faster than this agent allows. Try again in a minute.",
    retryAfter: true,
  },
  {
    name: "the buyer's limit for the day",
    options: { limits: { perBuyerPerDay: 0 } },
    status: 429,
    code: "rate_limited",
    message: "You have used this agent 0 times today. Try again tomorrow.",
    retryAfter: true,
  },
  {
    name: "the agent's limit",
    options: { allowanceUsedUp: true },
    status: 429,
    code: "rate_limited",
    message: "This agent has reached its limit for now. Nothing was charged. Try again later.",
    retryAfter: true,
  },
  {
    name: "a model failure",
    options: { outcome: { ok: false, error: "provider said no", toolCalls: [], code: "provider_error" } },
    status: 502,
    code: "model_error",
    message: "The agent could not answer just now. Your $0.05 was refunded.",
  },
  {
    name: "a withheld answer",
    options: { answer: LEAK },
    status: 502,
    code: "answer_withheld",
    message: "This answer could not be shown. Your $0.05 was refunded.",
  },
  {
    name: "an agent that cannot be run",
    options: { agent: { entrypoint: "graph" } },
    status: 503,
    code: "agent_unavailable",
    message: "This agent cannot be used right now. Nothing was charged. Try again later.",
  },
];

for (const c of REFUSALS) {
  test(`refusal over HTTP: ${c.name} is ${c.status} ${c.code}`, async () => {
    const { app, h } = await server(c.options);
    const path = c.path ?? "chat";
    const res = await app.inject({
      method: "POST",
      url: c.url ?? `/api/a/${HANDLE}/${path}`,
      headers: as(c.caller ?? SESSION),
      payload: (c.payload ?? (path === "run" ? RUN : CHAT)) as object,
    });
    assert.equal(res.statusCode, c.status, res.body);
    const body = res.json();
    assert.equal(body.error, c.code);
    if (typeof c.message === "string") assert.equal(body.message, c.message);
    else assert.match(body.message, c.message);
    assert.equal(res.headers["cache-control"], "no-store");
    if (c.retryAfter) {
      assert.ok(Number(res.headers["retry-after"]) >= 1);
      assert.equal(body.retryAfterSeconds, Number(res.headers["retry-after"]));
    }
    // No refusal leaves the buyer out of pocket, and none uses an em dash.
    assert.equal(h.money.balance, c.options?.balance ?? 500n);
    assert.ok(!body.message.includes("—"));
    for (const secret of [INSTRUCTIONS, FREE_MODEL, CREATOR_ORG, "provider said no"]) assert.ok(!res.body.includes(secret), secret);
  });
}

test("refusals carry what the payer needs: the terms, the price and the balance, the refund", async () => {
  const none = await (await server({ licence: null })).app.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/chat`,
    headers: as(SESSION),
    payload: CHAT,
  });
  assert.deepEqual(none.json().terms, {
    pricingModel: "per_request",
    pricePerRequestCents: 5,
    monthlyPriceCents: null,
    unit: "message",
    keepsCopy: false,
  });
  assert.equal(none.json().access, "none");

  const poor = await (await server({ balance: 1n })).app.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/chat`,
    headers: as(SESSION),
    payload: CHAT,
  });
  assert.equal(poor.json().priceCents, 5);
  assert.equal(poor.json().balanceCents, 1);

  const withheld = await (await server({ answer: LEAK })).app.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/chat`,
    headers: as(SESSION),
    payload: CHAT,
  });
  assert.equal(withheld.json().refundedCents, 5);

  const capped = await (await server({ keyCaps: { maxUse: 4n, daily: 100n } })).app.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/chat`,
    headers: as(KEY_CALLER),
    payload: CHAT,
  });
  assert.equal(capped.json().priceCents, 5);
  assert.equal(capped.json().maxUsePriceCents, 4);
});

test("too many undelivered answers: 429 too_many_refunds with the time until tomorrow", async () => {
  const { app } = await server({ answer: LEAK, limits: { perBuyerPerMinute: 1_000, undeliveredRefundsPerDay: 2 } });
  const send = () => app.inject({ method: "POST", url: `/api/a/${HANDLE}/chat`, headers: as(SESSION), payload: CHAT });
  assert.equal((await send()).statusCode, 502);
  assert.equal((await send()).statusCode, 502);
  const res = await send();
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, "too_many_refunds");
  assert.equal(res.json().message, "Several of your answers could not be delivered today. Try again tomorrow.");
  assert.equal(res.headers["retry-after"], String(12 * 3600));
});

test("GET /a/:handle/access answers the caller's access and nothing of the creator's", async () => {
  const { app } = await server({ role: "member" });
  const res = await app.inject({ method: "GET", url: `/api/a/${HANDLE}/access`, headers: as(SESSION) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(res.json(), {
    access: "listing_pricing",
    listingId: "lst-1",
    terms: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null, unit: "message", keepsCopy: false },
    accepted: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null },
    subscription: null,
    balanceCents: 500,
    canAccept: false,
    startBlocked: null,
    paused: false,
  });
  for (const secret of [INSTRUCTIONS, CREATOR_ORG, LICENCE.id]) assert.ok(!res.body.includes(secret), secret);

  const own = await app.inject({ method: "GET", url: `/api/a/${HANDLE}/access`, headers: as({ ...SESSION, orgId: CREATOR_ORG }) });
  assert.equal(own.json().access, "own_agent");

  const missing = await app.inject({ method: "GET", url: "/api/a/nobody-here/access", headers: as(SESSION) });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, "agent_not_found");
});

test("GET /a/:handle/results answers { results: [{ finishedAt, text }], hasMore } to a subscriber", async () => {
  const scheduled: PaidHarnessOptions = {
    agent: { agentKind: "scheduled" },
    listing: MONTHLY_LISTING,
    licence: MONTHLY_LICENCE,
    sub: PAID_MONTH,
    results: [
      { finishedAt: new Date("2026-10-10T09:00:00Z"), text: "Today's briefing." },
      { finishedAt: new Date("2026-10-09T09:00:00Z"), text: "Yesterday's briefing." },
    ],
  };
  const { app } = await server(scheduled);
  const res = await app.inject({ method: "GET", url: `/api/a/${HANDLE}/results`, headers: as(SESSION) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    results: [
      { finishedAt: "2026-10-10T09:00:00.000Z", text: "Today's briefing." },
      { finishedAt: "2026-10-09T09:00:00.000Z", text: "Yesterday's briefing." },
    ],
    hasMore: false,
  });
  // A key that cannot pay may still read what its organization subscribed to.
  const key = await app.inject({ method: "GET", url: `/api/a/${HANDLE}/results`, headers: as({ ...KEY_CALLER, scopes: [] }) });
  assert.equal(key.statusCode, 200);

  const refusals: Array<[PaidHarnessOptions, number, string]> = [
    [{ ...scheduled, licence: null, sub: null }, 403, "use_not_started"],
    [{ ...scheduled, sub: { ...PAID_MONTH, status: "expired", currentPeriodEnd: new Date("2026-10-01T00:00:00Z") } }, 402, "subscription_lapsed"],
    [{ ...scheduled, agent: { agentKind: "conversation" } }, 409, "not_a_scheduled_agent"],
    [{ agent: null }, 404, "agent_not_found"],
  ];
  for (const [options, status, code] of refusals) {
    const refused = await (await server(options)).app.inject({
      method: "GET",
      url: `/api/a/${HANDLE}/results`,
      headers: as(SESSION),
    });
    assert.equal(refused.statusCode, status, code);
    assert.equal(refused.json().error, code);
  }
});

test("a person removed from the buying organization cannot pay with its credits: 403 not_a_member on chat and run", async () => {
  for (const [path, payload, agent] of [
    ["chat", CHAT, {}],
    ["run", RUN, TASK_AGENT],
  ] as const) {
    const { app, h } = await server({ role: null, agent });
    const res = await app.inject({ method: "POST", url: `/api/a/${HANDLE}/${path}`, headers: as(SESSION), payload });
    assert.equal(res.statusCode, 403, path);
    assert.deepEqual(res.json(), {
      error: "not_a_member",
      message: "You are no longer a member of this organization, so you cannot use this agent on its behalf.",
    });
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(h.log, ["memberRole"], "nothing was counted, looked up or charged");
    assert.equal(h.money.balance, 500n);
    assert.deepEqual(h.money.ledger, []);
  }

  // A membership that cannot be read refuses too.
  const down = await server({ roleThrows: new Error("the database is away") });
  const res = await down.app.inject({ method: "POST", url: `/api/a/${HANDLE}/chat`, headers: as(SESSION), payload: CHAT });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "agent_unavailable");
  assert.equal(down.h.money.balance, 500n);

  // A key is the organization's: it pays as before, and no membership is read.
  const key = await server({ role: null, keyCaps: { maxUse: 50n, daily: 100n } });
  const paid = await key.app.inject({ method: "POST", url: `/api/a/${HANDLE}/chat`, headers: as(KEY_CALLER), payload: CHAT });
  assert.equal(paid.statusCode, 200);
  assert.ok(!key.h.log.includes("memberRole"));
});

test("GET /a/:handle/results of a free listing follows the page's switch and gives no more than the page", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    finishedAt: new Date(Date.UTC(2026, 9, 9, 9, 0, 0) - i * 86_400_000),
    text: `Briefing ${i}`,
  }));
  const free = (publicResults: boolean): PaidHarnessOptions => ({
    agent: { agentKind: "scheduled", publicResults },
    listing: { ...LISTING, pricingModel: "free", pricePerRequestCents: null },
    licence: null,
    results: rows,
  });

  for (const caller of [SESSION, { ...KEY_CALLER, scopes: [] }]) {
    const off = await server(free(false));
    const hidden = await off.app.inject({ method: "GET", url: `/api/a/${HANDLE}/results`, headers: as(caller) });
    assert.equal(hidden.statusCode, 200);
    assert.deepEqual(hidden.json(), { results: [], hasMore: false });
    assert.ok(!off.h.log.some((entry) => entry.startsWith("results:")));

    const on = await server(free(true));
    const shown = await on.app.inject({ method: "GET", url: `/api/a/${HANDLE}/results`, headers: as(caller) });
    assert.equal(shown.statusCode, 200);
    assert.deepEqual(
      shown.json().results.map((row: { text: string }) => row.text),
      ["Briefing 0", "Briefing 1", "Briefing 2"],
    );
    assert.equal(shown.json().hasMore, true);
  }
});

test("GET /a/:handle/access sends startBlocked as the service gives it, and canAccept false with it", async () => {
  const { app } = await server({
    listing: MONTHLY_LISTING,
    licence: { ...MONTHLY_LICENCE, kind: "copy" },
    sub: PAID_MONTH,
    role: "owner",
  });
  const res = await app.inject({ method: "GET", url: `/api/a/${HANDLE}/access`, headers: as(SESSION) });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.access, "none");
  assert.equal(body.canAccept, false);
  assert.deepEqual(body.startBlocked, {
    code: "copy_subscription_active",
    message:
      "You hold a copy of this agent that is paid for until 1 Nov. To use the agent on its page instead, remove your copy (the month you paid for is not refunded), or cancel its renewal and start after that date.",
    until: "2026-11-01T00:00:00.000Z",
  });
});
