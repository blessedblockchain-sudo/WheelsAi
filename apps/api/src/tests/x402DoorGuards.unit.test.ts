import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { APP_EXPOSED_HEADERS, corsOptionsFor, WIDGET_PREFLIGHT_MAX_AGE_SECONDS } from "../lib/corsPolicy.js";
import {
  countsAsApiCall,
  isPaidUseRequest,
  presentsNoCredential,
  replyAuthenticationRequired,
  requireAuth,
  requireScope,
  x402DoorApplies,
} from "../middleware/auth.js";
import { createOpenAiAuth, MISSING_API_KEY_MESSAGE, replyMissingApiKey } from "../middleware/openaiAuth.js";
import { openAiError, paidUseOpenAiError } from "../services/openaiCompat.js";
import { PAID_USE_REFUSAL_CODES, paidRefusalBody, type PaidUseErrorCode, type PaidUseRefusal } from "../services/paidUse.js";

// The x402 door's codes, words and guards, before any door uses them: who
// counts as presenting no credential, which requests the door would take,
// the one 401 every guard answers, the /v1 guard that can let the door's
// requests through and nothing else, the door's codes on /v1, the two
// optional fields of a refusal, and the two headers a browser on the web
// app's origin may read. With the door closed nothing anyone sees changes,
// except that one list of exposed headers.

// ============================================
// Who presents no credential, and what the door takes
// ============================================

interface Ask {
  method?: string;
  url: string;
  body?: unknown;
  authorization?: string;
  cookie?: string;
}

function requestOf(ask: Ask) {
  return {
    method: ask.method ?? "POST",
    url: ask.url,
    body: ask.body,
    headers: ask.authorization === undefined ? {} : { authorization: ask.authorization },
    cookies: ask.cookie === undefined ? {} : { wheelsai_token: ask.cookie },
  };
}

test("no credential means no Authorization header at all and no session cookie", () => {
  assert.equal(presentsNoCredential({ headers: {}, cookies: {} }), true);
  assert.equal(presentsNoCredential({ headers: {} }), true);
  // An empty header was sent: it is a credential that fails, and gets today's 401.
  assert.equal(presentsNoCredential({ headers: { authorization: "" }, cookies: {} }), false);
  assert.equal(presentsNoCredential({ headers: { authorization: "Bearer wheels_bad" }, cookies: {} }), false);
  assert.equal(presentsNoCredential({ headers: {}, cookies: { wheelsai_token: "expired.signed.value" } }), false);
  assert.equal(presentsNoCredential({ headers: {}, cookies: { wheelsai_token: "" } }), false);
  // Another cookie is not a credential.
  assert.equal(presentsNoCredential({ headers: {}, cookies: { theme: "dark" } }), true);
});

test("the door takes one use of an agent with no credential while it is open, and nothing else", () => {
  const cases: Array<[string, Ask, boolean, boolean?]> = [
    ["chat", { url: "/api/a/reviewer/chat" }, true],
    ["run", { url: "/api/a/reviewer/run" }, true],
    ["chat with a query", { url: "/api/a/reviewer/chat?stream=false" }, true],
    ["a/<handle> on /v1", { url: "/v1/chat/completions", body: { model: "a/reviewer" } }, true],
    ["an empty Authorization header", { url: "/api/a/reviewer/chat", authorization: "" }, false],
    ["a bad key", { url: "/api/a/reviewer/chat", authorization: "Bearer wheels_not_a_key" }, false],
    ["a bad key on /v1", { url: "/v1/chat/completions", body: { model: "a/reviewer" }, authorization: "Bearer x" }, false],
    ["a session cookie", { url: "/api/a/reviewer/chat", cookie: "expired" }, false],
    ["a read", { method: "GET", url: "/api/a/reviewer/chat" }, false],
    ["the access read", { method: "GET", url: "/api/a/reviewer/access" }, false],
    ["the results read", { method: "GET", url: "/api/a/reviewer/results" }, false],
    ["a workflow's run", { url: "/api/w/digest/run" }, false],
    ["w/<slug> on /v1", { url: "/v1/chat/completions", body: { model: "w/digest" } }, false],
    ["agent/<slug> on /v1", { url: "/v1/chat/completions", body: { model: "agent/reviewer" } }, false],
    ["a deployment on /v1", { url: "/v1/chat/completions", body: { model: "llama-small" } }, false],
    ["no model on /v1", { url: "/v1/chat/completions", body: {} }, false],
    ["a body that is not an object", { url: "/v1/chat/completions", body: "a/reviewer" }, false],
    // The handler trims the model, the guard does not: an untrimmed one gets today's 401.
    ["an untrimmed model", { url: "/v1/chat/completions", body: { model: " a/reviewer" } }, false],
    ["the agent's own /v1 path", { url: "/v1/agents/reviewer/chat/completions", body: { model: "a/reviewer" } }, false],
    ["a path under the handle", { url: "/api/a/reviewer/chat/more" }, false],
    ["the widget", { url: "/api/widget/wpk_x/chat" }, false],
    ["chat, door closed", { url: "/api/a/reviewer/chat" }, false, false],
    ["a/<handle> on /v1, door closed", { url: "/v1/chat/completions", body: { model: "a/reviewer" } }, false, false],
  ];
  for (const [name, ask, expected, open = true] of cases) {
    assert.equal(x402DoorApplies(requestOf(ask), open), expected, name);
  }
});

test("the request predicate, under its new name, is what it was, and still decides what a call counts", () => {
  const paid: Ask[] = [
    { url: "/api/a/reviewer/chat" },
    { url: "/api/a/reviewer/run" },
    { url: "/api/w/digest/run" },
    { url: "/v1/chat/completions", body: { model: "a/reviewer" } },
    { url: "/v1/chat/completions", body: { model: "w/digest" } },
  ];
  const notPaid: Ask[] = [
    { method: "GET", url: "/api/a/reviewer/chat" },
    { url: "/api/a/reviewer/access" },
    { url: "/v1/chat/completions", body: { model: "agent/reviewer" } },
    { url: "/v1/chat/completions", body: { model: "workflow/digest" } },
    { url: "/v1/chat/completions", body: null },
    { url: "/v1/chat/completions", body: ["a/x"] },
    { url: "/v1/chat/completions" },
  ];
  for (const ask of paid) {
    assert.equal(isPaidUseRequest(requestOf(ask)), true, ask.url);
    assert.equal(countsAsApiCall({ authType: "api_key", ...requestOf(ask) }), false, ask.url);
  }
  for (const ask of notPaid) {
    assert.equal(isPaidUseRequest(requestOf(ask)), false, `${ask.method ?? "POST"} ${ask.url}`);
  }
  assert.equal(countsAsApiCall({ authType: "api_key", ...requestOf(notPaid[2]!) }), true);
});

// ============================================
// The one 401
// ============================================

/** Today's 401, written as it was written in requireAuth and requireScope: the recorded answer. */
function recorded401(_request: FastifyRequest, reply: FastifyReply) {
  return reply.status(401).send({
    error: "Unauthorized",
    message: "Authentication required",
  });
}

async function guarded() {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.post("/recorded", { preHandler: [recorded401] }, async () => ({ ok: true }));
  app.post("/auth", { preHandler: [requireAuth] }, async () => ({ ok: true }));
  app.post("/scope", { preHandler: [requireScope("agents:use")] }, async () => ({ ok: true }));
  app.post("/both", { preHandler: [requireAuth, requireScope("agents:use")] }, async () => ({ ok: true }));
  app.post("/helper", async (_request, reply) => replyAuthenticationRequired(reply));
  await app.ready();
  return app;
}

function headersWithoutDate(headers: Record<string, unknown>): Record<string, unknown> {
  const { date: _date, ...rest } = headers;
  return rest;
}

test("requireAuth and requireScope answer the same 401 as before: status, body and headers", async () => {
  const app = await guarded();
  try {
    const recorded = await app.inject({ method: "POST", url: "/recorded", payload: { a: 1 } });
    assert.equal(recorded.statusCode, 401);
    assert.equal(recorded.body, '{"error":"Unauthorized","message":"Authentication required"}');
    for (const url of ["/auth", "/scope", "/both", "/helper"]) {
      const res = await app.inject({ method: "POST", url, payload: { a: 1 } });
      assert.equal(res.statusCode, recorded.statusCode, url);
      assert.equal(res.body, recorded.body, url);
      assert.deepEqual(headersWithoutDate(res.headers), headersWithoutDate(recorded.headers), url);
    }
  } finally {
    await app.close();
  }
});

// ============================================
// The /v1 guard
// ============================================

async function openAiGuarded(admit?: (request: FastifyRequest) => boolean) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  const plain = createOpenAiAuth({ meter: async () => undefined });
  const withDoor = createOpenAiAuth({
    meter: async () => undefined,
    ...(admit !== undefined && { admitWithoutCredential: admit }),
  });
  app.post("/plain", { preHandler: [plain] }, async (request) => ({ through: true, auth: request.auth }));
  app.post("/door", { preHandler: [withDoor] }, async (request) => ({ through: true, auth: request.auth }));
  app.post("/recorded", async (_request, reply) => replyMissingApiKey(reply));
  await app.ready();
  return app;
}

test("the /v1 guard with no option answers what it did, word for word", async () => {
  const app = await openAiGuarded();
  try {
    const res = await app.inject({ method: "POST", url: "/plain", payload: {} });
    assert.equal(res.statusCode, 401);
    const expected = openAiError("invalid_api_key", {
      message:
        "Missing or invalid API key. Send it as 'Authorization: Bearer <key>'; keys are created in the dashboard under API Keys.",
    });
    assert.deepEqual(res.json(), expected.body);
    assert.equal(MISSING_API_KEY_MESSAGE, expected.body.error.message);
    // No x-should-retry on this 401, as before.
    assert.equal(res.headers["x-should-retry"], undefined);
    const recorded = await app.inject({ method: "POST", url: "/recorded", payload: {} });
    assert.equal(res.body, recorded.body);
    assert.deepEqual(headersWithoutDate(res.headers), headersWithoutDate(recorded.headers));
  } finally {
    await app.close();
  }
});

test("with the option, only a request the predicate admits goes through, with no auth; any other gets the 401", async () => {
  const asked: string[] = [];
  const app = await openAiGuarded((request) => {
    asked.push(String(request.headers["x-door"]));
    return request.headers["x-door"] === "yes";
  });
  try {
    const through = await app.inject({ method: "POST", url: "/door", headers: { "x-door": "yes" }, payload: {} });
    assert.equal(through.statusCode, 200);
    assert.deepEqual(through.json(), { through: true, auth: null });

    const plain = await app.inject({ method: "POST", url: "/plain", payload: {} });
    for (const door of ["no", "true", ""]) {
      const refused = await app.inject({ method: "POST", url: "/door", headers: { "x-door": door }, payload: {} });
      assert.equal(refused.statusCode, 401, door);
      assert.equal(refused.body, plain.body, door);
      assert.deepEqual(headersWithoutDate(refused.headers), headersWithoutDate(plain.headers), door);
    }
    // The guard without the option never asks.
    assert.deepEqual(asked, ["yes", "no", "true", ""]);
  } finally {
    await app.close();
  }
});

test("a predicate that answers anything but true does not admit", async () => {
  const app = await openAiGuarded(() => 1 as unknown as boolean);
  try {
    const res = await app.inject({ method: "POST", url: "/door", payload: {} });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
  }
});

// ============================================
// The door's codes on /v1
// ============================================

const DOOR_CODES: Array<[PaidUseErrorCode, number, string, boolean]> = [
  // code, status on /v1, OpenAI code, told not to retry
  ["x402_payment_required", 402, "x402_payment_required", true],
  ["x402_payment_invalid", 402, "x402_payment_required", true],
  ["x402_payment_failed", 402, "x402_payment_required", true],
  ["x402_unavailable", 503, "service_unavailable", false],
  ["x402_too_many_unpaid", 429, "rate_limit_exceeded", false],
  ["answer_timed_out", 504, "upstream_timeout", false],
  ["x402_payment_unconfirmed", 504, "x402_payment_unconfirmed", true],
  ["x402_payment_unserved", 502, "x402_payment_unserved", true],
];

test("every code of the paid list has a row on /v1, and none answers 500", () => {
  for (const code of PAID_USE_REFUSAL_CODES) {
    const mapped = paidUseOpenAiError({ code, message: "A plain sentence." });
    assert.notEqual(mapped.status, 500, code);
    assert.notEqual(mapped.body.error.code, "internal_error", code);
  }
  for (const [code] of DOOR_CODES) assert.ok(PAID_USE_REFUSAL_CODES.includes(code), code);
  assert.equal(new Set(PAID_USE_REFUSAL_CODES).size, PAID_USE_REFUSAL_CODES.length);
});

test("each code of the door answers the status of the rules on /v1, and says which it was where /v1 folds it", () => {
  for (const [code, status, openAiCode, noRetry] of DOOR_CODES) {
    const mapped = paidUseOpenAiError({ code, message: "A plain sentence." });
    assert.equal(mapped.status, status, code);
    assert.equal(mapped.body.error.code, openAiCode, code);
    assert.equal(mapped.body.error.message, "A plain sentence.", code);
    assert.equal(mapped.headers["x-should-retry"], noRetry ? "false" : undefined, code);
    const reason = (mapped.body.error as Record<string, unknown>).reason;
    assert.equal(reason, openAiCode === code ? undefined : code, code);
  }
  // The two new rows of /v1's own.
  assert.equal(openAiError("x402_payment_unconfirmed").status, 504);
  assert.equal(openAiError("x402_payment_unserved").status, 502);
});

// ============================================
// The two optional fields of a refusal
// ============================================

test("a refusal without the two fields gives the same body as before, on /api/a and on /v1", () => {
  const credits: PaidUseRefusal = {
    status: 402,
    code: "insufficient_credits",
    message: "You do not have enough credits for this message ($0.05). Nothing was charged. Add credits to continue.",
    priceCents: 5,
    balanceCents: 2,
  };
  // Recorded before the fields existed: the bytes, key order included.
  assert.equal(
    JSON.stringify(paidRefusalBody(credits)),
    '{"error":"insufficient_credits","message":"You do not have enough credits for this message ($0.05). Nothing was charged. Add credits to continue.","priceCents":5,"balanceCents":2}',
  );
  assert.equal(
    JSON.stringify(paidUseOpenAiError(credits).body),
    '{"error":{"priceCents":5,"balanceCents":2,"reason":"insufficient_credits","message":"You do not have enough credits for this message ($0.05). Nothing was charged. Add credits to continue.","type":"payment_required","param":null,"code":"marketplace_payment_required"}}',
  );
  const withheld: PaidUseRefusal = {
    status: 502,
    code: "answer_withheld",
    message: "This answer could not be shown. Your $0.05 was refunded.",
    refundedCents: 5,
  };
  assert.equal(
    JSON.stringify(paidRefusalBody(withheld)),
    '{"error":"answer_withheld","message":"This answer could not be shown. Your $0.05 was refunded.","refundedCents":5}',
  );
  assert.equal(
    JSON.stringify(paidUseOpenAiError(withheld).body),
    '{"error":{"refundedCents":5,"message":"This answer could not be shown. Your $0.05 was refunded.","type":"server_error","param":null,"code":"answer_withheld"}}',
  );
  for (const body of [paidRefusalBody(credits), paidUseOpenAiError(credits).body.error]) {
    assert.equal("unit" in body, false);
    assert.equal("transaction" in body, false);
  }
});

test("a refusal with either field carries it, in the body and on OpenAI's error object", () => {
  const required: PaidUseRefusal = {
    status: 402,
    code: "x402_payment_required",
    message: "Pay $0.05 in USDC.",
    priceCents: 5,
    unit: "run",
  };
  assert.equal(
    JSON.stringify(paidRefusalBody(required)),
    '{"error":"x402_payment_required","message":"Pay $0.05 in USDC.","priceCents":5,"unit":"run"}',
  );
  const onV1 = paidUseOpenAiError(required).body.error as Record<string, unknown>;
  assert.equal(onV1.unit, "run");
  assert.equal(onV1.priceCents, 5);
  assert.equal("transaction" in onV1, false);

  const unconfirmed: PaidUseRefusal = {
    status: 504,
    code: "x402_payment_unconfirmed",
    message: "Not confirmed in time.",
    transaction: "5j7sZ1",
  };
  assert.deepEqual(paidRefusalBody(unconfirmed), {
    error: "x402_payment_unconfirmed",
    message: "Not confirmed in time.",
    transaction: "5j7sZ1",
  });
  const unconfirmedV1 = paidUseOpenAiError(unconfirmed);
  assert.equal(unconfirmedV1.status, 504);
  assert.equal((unconfirmedV1.body.error as Record<string, unknown>).transaction, "5j7sZ1");
  assert.equal("unit" in unconfirmedV1.body.error, false);
});

// ============================================
// What a browser may read
// ============================================

test("the web app's origin may read PAYMENT-REQUIRED and PAYMENT-RESPONSE; the widget's policy is what it was", () => {
  const PROD = { corsOrigin: "https://app.wheelsai.test", isDev: false };
  for (const url of ["/api/a/reviewer/chat", "/v1/chat/completions", "/api/agents"]) {
    const app = corsOptionsFor({ url }, PROD);
    assert.ok((app.exposedHeaders as string[]).includes("PAYMENT-REQUIRED"), url);
    assert.ok((app.exposedHeaders as string[]).includes("PAYMENT-RESPONSE"), url);
    // Still one origin with credentials: no policy of its own for a foreign origin.
    assert.equal(app.origin, "https://app.wheelsai.test", url);
    assert.equal(app.credentials, true, url);
  }
  assert.deepEqual(APP_EXPOSED_HEADERS.slice(-2), ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"]);
  assert.deepEqual(corsOptionsFor({ url: `/api/widget/wpk_${"a".repeat(32)}/chat` }, PROD), {
    origin: true,
    credentials: false,
    methods: ["GET", "POST"],
    allowedHeaders: ["content-type"],
    exposedHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: WIDGET_PREFLIGHT_MAX_AGE_SECONDS,
  });
});
