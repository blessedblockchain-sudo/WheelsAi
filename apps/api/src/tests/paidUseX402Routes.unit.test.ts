import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import cookie from "@fastify/cookie";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type preHandlerAsyncHookHandler } from "fastify";

import { APP_EXPOSED_HEADERS } from "../lib/corsPolicy.js";
import { requireAuth, requireScope, x402DoorApplies } from "../middleware/auth.js";
import { createOpenAiAuth } from "../middleware/openaiAuth.js";
import { env } from "../config/env.js";
import { createOpenAiV1Routes } from "../routes/openaiV1.js";
import { createPaidUseRoutes, type PaidUseGuards, type PaidUseX402Door } from "../routes/paidUse.js";
import { buildPaidUseGuards } from "../routes/paidUseBindings.js";
import { createPaidWorkflowRoutes } from "../routes/paidWorkflow.js";
import { x402DoorOpenNow } from "../services/buildPaidUseX402Deps.js";
import { PAID_USE_LIMITS } from "../services/paidUse.js";
import { utcDay } from "../services/publicChat.js";
import {
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  x402DoorKeys,
} from "../services/paidUseX402.js";
import { X402_DOOR_MESSAGES, X402_SEND_BY_MS } from "../services/x402DoorRules.js";
import { verifyExactSvmTransaction } from "../services/x402ExactSvm.js";
import { X402_CAIP2_NETWORKS, X402_ERROR_REASONS } from "../services/x402Wire.js";
import { HANDLE as BUYER_HANDLE, KEY_CALLER, paidHarness, type PaidHarness } from "./paidUseHarness.js";
import {
  ANSWER,
  BUCKET,
  call as callDoor,
  FEE_PAYER,
  HANDLE,
  LEAK,
  LISTING_ID,
  MINT,
  PAYER,
  PRICE_ATOMIC,
  SELLER_ORG,
  TREASURY,
  doorWorld,
  pay,
  type DoorWorld,
  type DoorWorldOptions,
} from "./paidUseX402Harness.js";
import { readPaymentRequired, readPaymentResponse } from "./x402DoorStandIns.js";

// The x402 door opened on the three addresses of one use (POST
// /api/a/:handle/chat and /run, and model a/<handle> on /v1), by Fastify
// inject, on the real routes, the real guards and the real core over the
// door's harness: with the door closed every address answers what it did;
// with it open a call with ANY credential takes today's path and a call
// with none to anything the door does not serve gets today's 401, byte for
// byte; workflows and reads keep their guards; a 402 carries the published
// challenge; a paid call is answered 200 with PAYMENT-RESPONSE and the
// charged header, whole and streamed, on both doors; and every refusal
// answers its status on both doors alike.

const PUBLIC_API = "https://api.wheelsai.test";
const GOOD_KEY = "Bearer wheels_good_key";
const DEVNET = X402_CAIP2_NETWORKS.devnet;
const CHAT = { messages: [{ role: "user", content: "Review my essay, please." }], stream: false };

type Mode = "today" | "closed" | "open";

interface Doors {
  app: FastifyInstance;
  world: DoorWorld;
  h: PaidHarness;
  /** Every guard that ran, by name: a call at the door runs none. */
  guardRuns: string[];
  /** Every plan API call counted on /v1. */
  metered: string[];
}

/**
 * The paid routes, the paid workflow run and /v1 as the app mounts them.
 * "today" is the routes with no door at all; "closed" and "open" are the
 * production predicate over a door whose settings are off or on.
 */
async function doors(mode: Mode, options: DoorWorldOptions = {}): Promise<Doors> {
  const world = doorWorld(options);
  const h = paidHarness({ keyCaps: { maxUse: 50n, daily: 100n } });
  const guardRuns: string[] = [];
  const metered: string[] = [];

  const app = Fastify();
  await app.register(sensible);
  await app.register(cookie);
  // The auth plugin's reading: only the good key is someone. A bad key, an
  // expired cookie and an empty header are no one, as for the real hook.
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as { auth: unknown }).auth =
      request.headers.authorization === GOOD_KEY ? { ...KEY_CALLER, scopes: ["agents:use"] } : null;
  });

  const spied =
    (name: string, guard: preHandlerAsyncHookHandler): preHandlerAsyncHookHandler =>
    async function (this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
      guardRuns.push(name);
      return guard.call(this, request, reply);
    };
  const anonymousDoor = (request: FastifyRequest) => x402DoorApplies(request, mode === "open");
  const guards: PaidUseGuards = {
    auth: spied("auth", requireAuth as preHandlerAsyncHookHandler),
    use: spied("use", requireScope("agents:use") as preHandlerAsyncHookHandler),
    ...(mode !== "today" && { anonymousDoor }),
  };
  const door: PaidUseX402Door = {
    use: () => world.deps,
    resourceUrl: (path) => `${PUBLIC_API}${path}`,
    bucketOf: () => BUCKET,
  };

  await app.register(
    createPaidUseRoutes({ guards, paidUse: () => h.deps, ...(mode !== "today" && { x402: () => door }) }),
    { prefix: "/api" },
  );
  await app.register(
    createPaidWorkflowRoutes({
      guards,
      paidWorkflow: () => {
        throw new Error("a workflow is never reached with no credential");
      },
    }),
    { prefix: "/api" },
  );
  const unified = createOpenAiAuth({
    meter: async (orgId) => void metered.push(orgId),
    ...(mode !== "today" && { admitWithoutCredential: anonymousDoor }),
  });
  await app.register(
    createOpenAiV1Routes({
      unifiedAuth: unified,
      auth: unified,
      workflowAuth: unified,
      paidUse: () => h.deps,
      x402: mode === "today" ? () => null : () => door,
      paidWorkflow: () => {
        throw new Error("a workflow is never reached with no credential");
      },
      now: () => 1_760_000_000_000,
      deploymentCompletion: async () => {
        throw new Error("a/<handle> is never routed as a deployment");
      },
      listModels: async () => ({ deployments: [], agents: [], workflows: [] }),
    }),
    { prefix: "/v1" },
  );
  await app.ready();
  return { app, world, h, guardRuns, metered };
}

interface Ask {
  method?: "GET" | "POST";
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

const agentUse = (handle: string = HANDLE, kind: "chat" | "run" = "chat") => `/api/a/${handle}/${kind}`;
const V1 = "/v1/chat/completions";
const v1Body = (handle: string = HANDLE, extra: Record<string, unknown> = {}) => ({
  model: `a/${handle}`,
  messages: CHAT.messages,
  ...extra,
});

function ask(d: Doors, a: Ask) {
  return d.app.inject({
    method: a.method ?? "POST",
    url: a.url,
    ...(a.payload !== undefined && { payload: a.payload as Record<string, unknown> }),
    ...(a.headers && { headers: a.headers }),
  });
}

/** Status, body and every header but the date: what "byte for byte" compares. */
function bytesOf(res: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  const { date: _date, ...headers } = res.headers;
  return { status: res.statusCode, body: res.body, headers };
}

/** Nothing of the door was touched: no row, no count, no chain read, no model. */
async function untouched(world: DoorWorld) {
  assert.equal(world.db.payments.size, 0);
  assert.equal(world.modelRuns, 0);
  assert.deepEqual(
    world.trail.filter((step) => step.startsWith("chain:") || step === "lookup"),
    [],
  );
  assert.equal((await world.store.peek(x402DoorKeys.addressMinute(BUCKET, HANDLE))) ?? 0, 0, "nothing counted");
}

/** Every call a caller with no credential can make to the three addresses, and the reads beside them. */
const NO_CREDENTIAL_CALLS: Array<[string, Ask]> = [
  ["chat", { url: agentUse(), payload: CHAT }],
  ["run", { url: agentUse(HANDLE, "run"), payload: { input: { topic: "Launch" }, stream: false } }],
  ["v1", { url: V1, payload: v1Body() }],
];

// ============================================
// The door closed
// ============================================

test("with the door closed, a call with no credential to each address is today's 401, byte for byte, and the door is never asked", async () => {
  for (const [name, call] of NO_CREDENTIAL_CALLS) {
    const today = await ask(await doors("today"), call);
    const closed = await doors("closed");
    const res = await ask(closed, call);
    assert.equal(res.statusCode, 401, name);
    assert.deepEqual(bytesOf(res), bytesOf(today), name);
    // Even with a payment attached.
    const paid = await ask(closed, { ...call, headers: { "payment-signature": pay(closed.world).header } });
    assert.deepEqual(bytesOf(paid), bytesOf(today), name);
    await untouched(closed.world);
  }
  // The recorded answers of today.
  const d = await doors("closed");
  assert.deepEqual((await ask(d, NO_CREDENTIAL_CALLS[0]![1])).json(), {
    error: "Unauthorized",
    message: "Authentication required",
  });
  assert.equal((await ask(d, NO_CREDENTIAL_CALLS[2]![1])).json().error.code, "invalid_api_key");
});

// ============================================
// The door open: what it never takes
// ============================================

test("with the door open, a call it does not serve is today's 401, byte for byte, with nothing counted", async () => {
  const cases: Array<[string, DoorWorldOptions, Ask]> = [
    ["chat, the switch off", { listing: { x402Enabled: false } }, { url: agentUse(), payload: CHAT }],
    ["chat, the switch off, a malformed body", { listing: { x402Enabled: false } }, { url: agentUse(), payload: { nope: 1 } }],
    ["run, the switch off", { listing: { x402Enabled: false } }, { url: agentUse(HANDLE, "run"), payload: { input: {} } }],
    ["v1, the switch off", { listing: { x402Enabled: false } }, { url: V1, payload: v1Body() }],
    ["v1, the switch off, a malformed body", { listing: { x402Enabled: false } }, { url: V1, payload: { model: `a/${HANDLE}`, messages: "x" } }],
    ["v1, the switch off, a tool", { listing: { x402Enabled: false } }, { url: V1, payload: v1Body(HANDLE, { tools: [{ type: "function", function: { name: "f" } }] }) }],
    ["chat, a monthly listing", { listing: { pricingModel: "monthly", monthlyPriceCents: 900n } }, { url: agentUse(), payload: CHAT }],
    ["chat, a draft", { listing: { status: "draft" } }, { url: agentUse(), payload: CHAT }],
    ["chat, a private agent", { agent: { isPublic: false } }, { url: agentUse(), payload: CHAT }],
    ["chat, an unknown handle", {}, { url: agentUse("nobody-here"), payload: CHAT }],
    ["v1, an unknown handle", {}, { url: V1, payload: v1Body("nobody-here") }],
    ["v1, an empty handle", {}, { url: V1, payload: { model: "a/ ", messages: CHAT.messages } }],
  ];
  for (const [name, world, call] of cases) {
    const today = await ask(await doors("today", world), call);
    const open = await doors("open", world);
    const res = await ask(open, call);
    assert.equal(res.statusCode, 401, name);
    assert.deepEqual(bytesOf(res), bytesOf(today), name);
    await untouched(open.world);
    assert.equal(res.headers["payment-required"], undefined, name);
    assert.equal(res.headers["cache-control"], undefined, name);
  }
});

test("with the door open, any credential takes today's path: a bad key, an expired cookie and an empty Authorization header are today's 401", async () => {
  const credentials: Array<[string, Record<string, string>]> = [
    ["a bad key", { authorization: "Bearer wheels_bad_key" }],
    ["a bad bearer token", { authorization: "Bearer eyJhbGciOi.bad.token" }],
    ["an expired cookie", { cookie: "wheelsai_token=expired.signed.value" }],
    ["an empty Authorization header", { authorization: "" }],
  ];
  for (const [name, headers] of credentials) {
    for (const [address, call] of NO_CREDENTIAL_CALLS) {
      const open = await doors("open");
      const withPayment = { ...headers, "payment-signature": pay(open.world).header };
      const today = await ask(await doors("today"), { ...call, headers: withPayment });
      const res = await ask(open, { ...call, headers: withPayment });
      assert.equal(res.statusCode, 401, `${name} ${address}`);
      assert.deepEqual(bytesOf(res), bytesOf(today), `${name} ${address}`);
      await untouched(open.world);
    }
  }
});

test("with the door open, the reads, a workflow's run and model w/<slug> keep today's 401", async () => {
  const calls: Array<[string, Ask]> = [
    ["access", { method: "GET", url: `/api/a/${HANDLE}/access` }],
    ["results", { method: "GET", url: `/api/a/${HANDLE}/results` }],
    ["a workflow's run", { url: "/api/w/launch-brief/run", payload: { input: {} } }],
    ["model w/<slug>", { url: V1, payload: { model: "w/launch-brief", messages: CHAT.messages } }],
    ["model agent/<slug>", { url: V1, payload: { model: "agent/reviewer", messages: CHAT.messages } }],
    ["a deployment", { url: V1, payload: { model: "llama-prod", messages: CHAT.messages } }],
    ["the models", { method: "GET", url: "/v1/models" }],
  ];
  for (const [name, call] of calls) {
    const today = await ask(await doors("today"), call);
    const open = await doors("open");
    const res = await ask(open, { ...call, headers: { "payment-signature": pay(open.world).header } });
    const todayWithPayment = await ask(await doors("today"), { ...call, headers: { "payment-signature": "x" } });
    assert.equal(res.statusCode, 401, name);
    assert.deepEqual(bytesOf(res), bytesOf(today), name);
    assert.deepEqual(bytesOf(todayWithPayment), bytesOf(today), name);
    await untouched(open.world);
  }
});

test("a call with a key and a PAYMENT-SIGNATURE is charged to the key's credits as today, and carries no PAYMENT-RESPONSE", async () => {
  for (const call of [
    { url: agentUse(BUYER_HANDLE), payload: CHAT },
    { url: V1, payload: v1Body(BUYER_HANDLE) },
  ]) {
    const open = await doors("open");
    const res = await ask(open, { ...call, headers: { authorization: GOOD_KEY, "payment-signature": pay(open.world).header } });
    assert.equal(res.statusCode, 200, call.url);
    assert.equal(open.h.money.balance, 495n);
    assert.equal(open.h.money.keySpent, 5n);
    assert.equal(res.headers["payment-response"], undefined);
    assert.equal(res.headers["payment-required"], undefined);
    assert.equal(res.headers["x-wheelsai-charged-cents"], "5");
    await untouched(open.world);

    // And the same as the routes with no door at all answer it.
    const today = await doors("today");
    const before = await ask(today, { ...call, headers: { authorization: GOOD_KEY, "payment-signature": "anything" } });
    assert.equal(before.statusCode, 200);
    assert.deepEqual(
      Object.keys(res.headers).filter((name) => name !== "date").sort(),
      Object.keys(before.headers).filter((name) => name !== "date").sort(),
    );
  }
});

// ============================================
// The 402
// ============================================

test("a call with no payment is answered 402 with the published challenge, in each door's own body", async () => {
  const cases: Array<[string, Ask, string]> = [
    ["chat", { url: agentUse(), payload: CHAT }, `${PUBLIC_API}/api/a/${HANDLE}/chat`],
    ["v1", { url: V1, payload: v1Body() }, `${PUBLIC_API}/v1/chat/completions`],
  ];
  for (const [name, call, url] of cases) {
    const open = await doors("open");
    const res = await ask(open, call);
    assert.equal(res.statusCode, 402, name);
    assert.equal(res.headers["cache-control"], "no-store", name);
    const challenge = readPaymentRequired(String(res.headers["payment-required"]));
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.error, undefined);
    assert.deepEqual(challenge.resource, { url, description: "Reviews an essay in one answer.", mimeType: "application/json" });
    assert.equal(challenge.accepts.length, 1);
    const [accepts] = challenge.accepts;
    assert.equal(accepts.scheme, "exact");
    assert.equal(accepts.network, DEVNET);
    assert.equal(accepts.amount, PRICE_ATOMIC.toString());
    assert.equal(accepts.asset, MINT.toBase58());
    assert.equal(accepts.payTo, TREASURY.toBase58());
    assert.equal(accepts.maxTimeoutSeconds, 180);
    assert.equal(accepts.extra.feePayer, FEE_PAYER.publicKey.toBase58());
    assert.match(accepts.extra.memo, new RegExp(`^wheelsai-x402:${LISTING_ID}:`));
    // Nothing is written for a challenge.
    assert.equal(open.world.db.payments.size, 0);
    assert.equal(open.world.modelRuns, 0);
    // Not one of anyone's API calls.
    assert.deepEqual(open.guardRuns, []);
    assert.deepEqual(open.metered, []);

    if (name === "chat") {
      assert.deepEqual(res.json(), {
        error: "x402_payment_required",
        message: X402_DOOR_MESSAGES.paymentRequired(10n, "message"),
        priceCents: 10,
        unit: "message",
      });
    } else {
      const error = res.json().error;
      assert.equal(error.code, "x402_payment_required");
      assert.equal(error.message, X402_DOOR_MESSAGES.paymentRequired(10n, "message"));
      assert.equal(error.priceCents, 10);
      assert.equal(error.unit, "message");
    }
  }
});

test("a run's 402 is for one run of a task agent", async () => {
  const open = await doors("open", { agent: { agentKind: "task", kindConfig: { task: { fields: [{ key: "topic", label: "Topic", type: "short_text", required: true }] } } } });
  const res = await ask(open, { url: agentUse(HANDLE, "run"), payload: { input: { topic: "Launch" }, stream: false } });
  assert.equal(res.statusCode, 402);
  assert.equal(res.json().unit, "run");
  assert.equal(readPaymentRequired(String(res.headers["payment-required"])).resource.url, `${PUBLIC_API}/api/a/${HANDLE}/run`);
});

// ============================================
// A paid call
// ============================================

function assertPaid(res: { statusCode: number; headers: Record<string, unknown> }, world: DoorWorld) {
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-wheelsai-charged-cents"], "10");
  assert.equal(res.headers["x-wheelsai-balance-cents"], undefined);
  const row = world.db.only();
  assert.equal(row.status, "verified");
  assert.deepEqual(readPaymentResponse(String(res.headers["payment-response"])), {
    success: true,
    payer: PAYER.publicKey.toBase58(),
    transaction: row.txSignature,
    network: DEVNET,
    amount: PRICE_ATOMIC.toString(),
  });
  assert.equal(world.db.revenues.length, 1);
}

test("a paid call on /api/a is answered 200 with PAYMENT-RESPONSE and the charged header, whole and streamed", async () => {
  // Whole.
  const whole = await doors("open");
  const res = await ask(whole, { url: agentUse(), payload: CHAT, headers: { "payment-signature": pay(whole.world).header } });
  assertPaid(res, whole.world);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(res.json(), {
    message: { role: "assistant", content: ANSWER },
    toolCalls: [],
    billing: { chargedCents: 10, balanceCents: null, access: "listing_pricing" },
  });
  assert.deepEqual(whole.guardRuns, [], "a call at the door is no one's API call");

  // Streamed: the whole answer replayed after the confirmation.
  const streamed = await doors("open");
  const sse = await ask(streamed, {
    url: agentUse(),
    payload: { ...CHAT, stream: true },
    headers: { "payment-signature": pay(streamed.world).header },
  });
  assertPaid(sse, streamed.world);
  assert.match(String(sse.headers["content-type"]), /text\/event-stream/);
  assert.ok(sse.body.includes('"chargedCents":10'));
  const text = sse.body
    .split("\n")
    .filter((line) => line.startsWith("data: {") && line.includes("choices"))
    .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content ?? "")
    .join("");
  assert.equal(text, ANSWER);
});

test("a paid run on /api/a is answered with its output", async () => {
  const open = await doors("open", { agent: { agentKind: "task", kindConfig: { task: { fields: [{ key: "topic", label: "Topic", type: "short_text", required: true }] } } } });
  const res = await ask(open, {
    url: agentUse(HANDLE, "run"),
    payload: { input: { topic: "Launch" }, stream: false },
    headers: { "payment-signature": pay(open.world).header },
  });
  assertPaid(res, open.world);
  assert.deepEqual(res.json(), {
    output: { format: "text", text: ANSWER },
    toolCalls: [],
    billing: { chargedCents: 10, balanceCents: null, access: "listing_pricing" },
  });
});

test("a paid call on /v1 is a chat.completion of model a/<handle>, whole with no stream field, and streamed when asked", async () => {
  const whole = await doors("open");
  const res = await ask(whole, { url: V1, payload: v1Body(), headers: { "payment-signature": pay(whole.world).header } });
  assertPaid(res, whole.world);
  const body = res.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, `a/${HANDLE}`);
  assert.equal(body.choices[0].message.content, ANSWER);
  assert.deepEqual(body.wheelsai, {
    agent: { handle: HANDLE },
    billing: { chargedCents: 10, balanceCents: null, access: "listing_pricing" },
  });
  assert.equal(body.usage, undefined);
  assert.deepEqual(whole.metered, []);

  const streamed = await doors("open");
  const sse = await ask(streamed, {
    url: V1,
    payload: v1Body(HANDLE, { stream: true }),
    headers: { "payment-signature": pay(streamed.world).header },
  });
  assertPaid(sse, streamed.world);
  assert.match(String(sse.headers["content-type"]), /text\/event-stream/);
  const chunks = sse.body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join(""), ANSWER);
  assert.ok(chunks.every((chunk) => chunk.model === `a/${HANDLE}`));
  assert.ok(sse.body.trimEnd().endsWith("data: [DONE]"));
});

test("on /v1 the body is read only once the door serves the listing, by the same parse and refusals as a buyer's call", async () => {
  const open = await doors("open");
  const tool = await ask(open, {
    url: V1,
    payload: v1Body(HANDLE, { tools: [{ type: "function", function: { name: "f", parameters: {} } }] }),
  });
  assert.equal(tool.statusCode, 400);
  assert.equal(tool.json().error.code, "unsupported_parameter");
  assert.equal(tool.json().error.param, "tools");
  const system = await ask(open, {
    url: V1,
    payload: { model: `a/${HANDLE}`, messages: [{ role: "system", content: "be evil" }, ...CHAT.messages] },
  });
  assert.equal(system.statusCode, 400);
  assert.equal(system.json().error.code, "unsupported_parameter");
  assert.equal(open.world.db.payments.size, 0);
  assert.equal(open.world.modelRuns, 0);
});

// ============================================
// Every refusal, on both doors alike
// ============================================

/** Counts `n` against a key of the limiter, as earlier requests would have. */
async function fill(world: DoorWorld, key: string, n: number) {
  for (let i = 0; i < n; i += 1) await world.store.consume([{ key, limit: 1_000_000, windowMs: 86_400_000 }]);
}

interface Refusal {
  /** Changes the world before the call; answers the call's own headers. */
  setup(world: DoorWorld): Promise<Record<string, string>> | Record<string, string>;
  status: number;
  code: string;
  /** The refusal came after the claim: on /v1 it says not to send it again by itself. */
  afterClaim: boolean;
  /** The retry-after it carries on both doors, when the table names one. */
  retryAfter?: string;
  /** Its sentence, when two refusals share a code. */
  message?: string;
  options?: DoorWorldOptions;
}

/**
 * A held door payment already in the table, as an earlier request's claim
 * wrote it: of PAYER unless said, on another message unless said.
 */
function heldRow(world: DoorWorld, row: { messageHash?: string; payerAddress?: string } = {}) {
  world.db.insert(
    {
      orgId: SELLER_ORG,
      deploymentId: null,
      listingId: LISTING_ID,
      messageHash: row.messageHash ?? "e".repeat(64),
      requestId: "an-earlier-nonce",
      network: "solana:devnet",
      asset: "USDC",
      amountRaw: PRICE_ATOMIC.toString(),
      amountUsd: 0.1,
      payerAddress: row.payerAddress ?? PAYER.publicKey.toBase58(),
      payeeAddress: TREASURY.toBase58(),
      txSignature: null,
      status: "held",
      signedTxB64: null,
      recentBlockhash: "11111111111111111111111111111111",
      amountReceivedRaw: null,
      amountMicroUsd: 100_000n,
      solMicroUsdPerSol: null,
      submittedAt: null,
      verifiedAt: null,
    },
    new Date(world.nowMs),
  );
}

const paying = (world: DoorWorld) => ({ "payment-signature": pay(world).header });

const REFUSALS: Record<string, Refusal> = {
  "no payment": { setup: () => ({}), status: 402, code: "x402_payment_required", afterClaim: false },
  "a payment for another amount": {
    setup: (world) => {
      const paid = pay(world);
      const accepted = { ...paid.requirements, amount: (PRICE_ATOMIC - 1n).toString() };
      return { "payment-signature": pay(world, { accepted }).header };
    },
    status: 402,
    code: "x402_payment_invalid",
    afterClaim: false,
  },
  "a payment presented before": {
    setup: async (world) => {
      const paid = pay(world);
      // Served once, at the door's core.
      assert.equal((await callDoor(world, { payment: paid.header })).kind, "answer");
      return { "payment-signature": paid.header };
    },
    status: 402,
    code: "x402_payment_invalid",
    afterClaim: false,
  },
  "a payment that would not go through": {
    setup: (world) => ({ "payment-signature": pay(world, { usdc: 1n }).header }),
    status: 402,
    code: "x402_payment_invalid",
    afterClaim: false,
  },
  paused: {
    setup: (world) => {
      world.paused = true;
      return paying(world);
    },
    status: 503,
    code: "agent_paused",
    afterClaim: false,
  },
  "the address's minute": {
    setup: async (world) => {
      await fill(world, x402DoorKeys.addressMinute(BUCKET, HANDLE), 10);
      return paying(world);
    },
    status: 429,
    code: "rate_limited",
    afterClaim: false,
  },
  "the wallet's day": {
    setup: async (world) => {
      const day = utcDay(new Date(world.nowMs));
      await fill(world, x402DoorKeys.walletDay(PAYER.publicKey.toBase58(), HANDLE, day), PAID_USE_LIMITS.perBuyerPerDay);
      return paying(world);
    },
    status: 429,
    code: "rate_limited",
    afterClaim: false,
    message: X402_DOOR_MESSAGES.walletOrAddressDay,
  },
  "a payment of this wallet still open": {
    setup: (world) => {
      // An earlier payment of the same wallet, held while its answer is made.
      heldRow(world);
      return paying(world);
    },
    status: 429,
    code: "rate_limited",
    // The one 429 after the claim: an SDK must not send the same payment again by itself.
    afterClaim: true,
    retryAfter: String(Math.ceil(X402_SEND_BY_MS / 1000)),
    message: X402_DOOR_MESSAGES.walletStillOpen,
  },
  "a payment presented before, seen only at the claim": {
    setup: (world) => {
      const paid = pay(world);
      const checked = verifyExactSvmTransaction(paid.b64, paid.requirements, { feePayer: FEE_PAYER.publicKey.toBase58() });
      assert.ok(checked.isValid);
      // The same message under the row of another request, which the lookup of
      // step 6 missed (the two raced): the unique of the claim holds it. The row
      // names another wallet, so only the message's unique is met.
      heldRow(world, { messageHash: checked.messageHash, payerAddress: TREASURY.toBase58() });
      world.deps.payments.findByMessageHash = async () => null;
      return { "payment-signature": paid.header };
    },
    status: 402,
    code: "x402_payment_invalid",
    afterClaim: true,
    message: X402_DOOR_MESSAGES.presentedTwice,
  },
  "a limiter that cannot count": {
    setup: (world) => {
      world.limiterDown = true;
      return paying(world);
    },
    status: 503,
    code: "rate_limiter_unavailable",
    afterClaim: false,
  },
  "too many unpaid answers": {
    setup: async (world) => {
      await fill(world, x402DoorKeys.unpaidWalletDay(PAYER.publicKey.toBase58(), utcDay(new Date(world.nowMs))), 3);
      return paying(world);
    },
    status: 429,
    code: "x402_too_many_unpaid",
    afterClaim: false,
  },
  "the fee payer under its floor": {
    setup: (world) => paying(world),
    status: 503,
    code: "x402_unavailable",
    afterClaim: false,
    options: { feePayerLamports: 1_000n },
  },
  "a withheld answer": {
    setup: (world) => {
      world.model.answer = LEAK;
      return paying(world);
    },
    status: 502,
    code: "answer_withheld",
    afterClaim: true,
  },
  "a model that failed": {
    setup: (world) => {
      world.model.throws = new Error("provider down at secret-host.internal");
      return paying(world);
    },
    status: 502,
    code: "model_error",
    afterClaim: true,
  },
  "an answer past 30 seconds": {
    setup: (world) => {
      world.model.takesMs = 31_000;
      return paying(world);
    },
    status: 504,
    code: "answer_timed_out",
    afterClaim: true,
  },
  "a payment that expired while its answer was made": {
    setup: (world) => paying(world),
    status: 402,
    code: "x402_payment_failed",
    afterClaim: true,
    // 2 seconds of the model are 200 blocks: past the blockhash's 150.
    options: { blocksPerSecond: 100 },
  },
  "a payment the chain refused": {
    setup: (world) => {
      world.chain.chain.fate = "landed_failed";
      return paying(world);
    },
    status: 402,
    code: "x402_payment_failed",
    afterClaim: true,
  },
  "no confirmation in time": {
    setup: (world) => {
      world.chain.chain.fate = "never";
      return paying(world);
    },
    status: 504,
    code: "x402_payment_unconfirmed",
    afterClaim: true,
    options: { blocksPerSecond: 0 },
  },
  "a sale that cannot be written": {
    setup: (world) => {
      world.db.profiles.delete(SELLER_ORG);
      return paying(world);
    },
    status: 502,
    code: "x402_payment_unserved",
    afterClaim: true,
  },
};

test("each refusal at the door answers its status on /api/a and /v1 alike, and after the claim /v1 says not to send it again", async () => {
  for (const [name, refusal] of Object.entries(REFUSALS)) {
    // /api/a
    const page = await doors("open", refusal.options);
    const pageHeaders = await refusal.setup(page.world);
    const salesBefore = page.world.db.revenues.length;
    const onPage = await ask(page, { url: agentUse(), payload: CHAT, headers: pageHeaders });
    assert.equal(onPage.statusCode, refusal.status, `${name} on /api/a: ${onPage.body}`);
    assert.equal(onPage.json().error, refusal.code, name);
    assert.equal(onPage.headers["cache-control"], "no-store", name);
    assert.equal(onPage.headers["payment-response"] === undefined || refusal.code === "x402_payment_failed", true, name);
    assert.equal(page.world.db.revenues.length, salesBefore, `${name}: no sale`);
    if (refusal.message !== undefined) assert.equal(onPage.json().message, refusal.message, name);
    if (refusal.retryAfter !== undefined) assert.equal(onPage.headers["retry-after"], refusal.retryAfter, name);

    // /v1
    const api = await doors("open", refusal.options);
    const apiHeaders = await refusal.setup(api.world);
    const onApi = await ask(api, { url: V1, payload: v1Body(), headers: apiHeaders });
    assert.equal(onApi.statusCode, refusal.status, `${name} on /v1: ${onApi.body}`);
    const error = onApi.json().error;
    assert.ok(error.code === refusal.code || error.reason === refusal.code, `${name}: ${JSON.stringify(error)}`);
    assert.equal(error.message, onPage.json().message, name);
    if (refusal.retryAfter !== undefined) assert.equal(onApi.headers["retry-after"], refusal.retryAfter, name);
    if (refusal.afterClaim) assert.equal(onApi.headers["x-should-retry"], "false", name);
    else if ([429, 503].includes(refusal.status)) assert.equal(onApi.headers["x-should-retry"], undefined, name);

    // The same headers of the door on both.
    for (const header of ["payment-required", "payment-response", "retry-after"]) {
      assert.equal(onApi.headers[header] === undefined, onPage.headers[header] === undefined, `${name} ${header}`);
    }
    // A refusal that names its transaction does so on both.
    if (refusal.code === "x402_payment_unconfirmed" || refusal.code === "x402_payment_unserved") {
      assert.ok(onPage.json().transaction);
      assert.equal(error.transaction, api.world.db.only().txSignature);
    }
    // No refusal holds the creator's organization or a node's words.
    for (const body of [onPage.body, onApi.body]) {
      assert.ok(!body.includes(SELLER_ORG), name);
      assert.ok(!body.includes("secret-host"), name);
    }
    assert.deepEqual(page.guardRuns, [], name);
    assert.deepEqual(api.metered, [], name);
  }
});

test("a refused payment's PAYMENT-REQUIRED and a failed payment's PAYMENT-RESPONSE reach the caller on both doors", async () => {
  for (const call of [
    { url: agentUse(), payload: CHAT },
    { url: V1, payload: v1Body() },
  ]) {
    const invalid = await doors("open");
    const headers = await REFUSALS["a payment for another amount"]!.setup(invalid.world);
    const res = await ask(invalid, { ...call, headers });
    assert.equal(res.statusCode, 402);
    // The reason, in the published words, rides in the challenge and nowhere else.
    const reason = readPaymentRequired(String(res.headers["payment-required"])).error;
    assert.ok((Object.values(X402_ERROR_REASONS) as string[]).includes(reason), reason);
    assert.ok(!res.body.includes(reason));

    const failed = await doors("open");
    failed.world.chain.chain.fate = "landed_failed";
    const refused = await ask(failed, { ...call, headers: paying(failed.world) });
    assert.equal(refused.statusCode, 402);
    assert.deepEqual(readPaymentResponse(String(refused.headers["payment-response"])), {
      success: false,
      errorReason: "transaction_failed",
      transaction: "",
      network: DEVNET,
    });
  }
});

// ============================================
// The production wiring
// ============================================

/** Every setting the door reads, on: what an operator sets to open it. */
const OPEN_SETTINGS = {
  X402_ENABLED: true,
  X402_SUBMIT_TRANSACTIONS: true,
  X402_SETTLEMENT_WORKER_ENABLED: true,
  PUBLIC_API_URL: PUBLIC_API,
  WALLET_MASTER_KEY: "a-master-key-for-the-door-of-forty-chars!",
  SOLANA_NETWORK: "devnet",
} as const;

/** Runs `fn` with the process's settings opened for the door, then puts them back. */
async function withDoorSettingsOn<T>(fn: () => Promise<T>): Promise<T> {
  const settings = env as unknown as Record<string, unknown>;
  const before = Object.fromEntries(Object.keys(OPEN_SETTINGS).map((name) => [name, settings[name]]));
  Object.assign(settings, OPEN_SETTINGS);
  try {
    return await fn();
  } finally {
    Object.assign(settings, before);
  }
}

/**
 * The paid routes with the app's own guards (buildPaidUseGuards) and /v1
 * with its default guard (no unifiedAuth handed in): the two predicates
 * production runs, over the door's harness.
 */
async function productionDoors(): Promise<Doors> {
  const world = doorWorld();
  const h = paidHarness({ keyCaps: { maxUse: 50n, daily: 100n } });
  const app = Fastify();
  await app.register(sensible);
  await app.register(cookie);
  app.decorateRequest("auth", null);
  const door: PaidUseX402Door = {
    use: () => world.deps,
    resourceUrl: (path) => `${PUBLIC_API}${path}`,
    bucketOf: () => BUCKET,
  };
  await app.register(createPaidUseRoutes({ guards: buildPaidUseGuards(), paidUse: () => h.deps, x402: () => door }), {
    prefix: "/api",
  });
  await app.register(
    createOpenAiV1Routes({
      paidUse: () => h.deps,
      x402: () => door,
      now: () => 1_760_000_000_000,
      deploymentCompletion: async () => {
        throw new Error("a/<handle> is never routed as a deployment");
      },
      listModels: async () => ({ deployments: [], agents: [], workflows: [] }),
    }),
    { prefix: "/v1" },
  );
  await app.ready();
  return { app, world, h, guardRuns: [], metered: [] };
}

test("the production predicates read the door's settings per request: off by default, a call with no credential is today's 401 byte for byte", async () => {
  const request = { method: "POST", url: `/api/a/${HANDLE}/chat`, body: {}, headers: {}, cookies: {} } as unknown as FastifyRequest;
  const v1Request = { ...request, url: V1, body: v1Body() } as unknown as FastifyRequest;
  const anonymousDoor = buildPaidUseGuards().anonymousDoor!;

  // The unit settings leave the door closed, as a deployment's defaults do.
  assert.equal(x402DoorOpenNow(), false);
  assert.equal(anonymousDoor(request), false);
  // The listing's switch is on: only the settings keep the door shut.
  for (const [name, call] of [NO_CREDENTIAL_CALLS[0]!, NO_CREDENTIAL_CALLS[2]!]) {
    const today = await ask(await doors("today"), call);
    const production = await productionDoors();
    const res = await ask(production, call);
    assert.equal(res.statusCode, 401, name);
    assert.deepEqual(bytesOf(res), bytesOf(today), name);
    const paid = await ask(production, { ...call, headers: { "payment-signature": pay(production.world).header } });
    assert.deepEqual(bytesOf(paid), bytesOf(today), name);
    await untouched(production.world);
  }

  // The same wiring with the settings on admits the call: the test above can fail.
  await withDoorSettingsOn(async () => {
    assert.equal(x402DoorOpenNow(), true);
    assert.equal(anonymousDoor(request), true);
    assert.equal(anonymousDoor(v1Request), true);
    for (const [name, call] of [NO_CREDENTIAL_CALLS[0]!, NO_CREDENTIAL_CALLS[2]!]) {
      const res = await ask(await productionDoors(), call);
      assert.equal(res.statusCode, 402, name);
      assert.ok(res.headers["payment-required"], name);
    }
  });
  assert.equal(x402DoorOpenNow(), false, "the settings are put back");
});

// ============================================
// The browser
// ============================================

test("the web app's own origin may read the door's two headers", () => {
  const exposed = APP_EXPOSED_HEADERS.map((name) => name.toLowerCase());
  assert.ok(exposed.includes(X402_PAYMENT_REQUIRED_HEADER.toLowerCase()));
  assert.ok(exposed.includes(X402_PAYMENT_RESPONSE_HEADER.toLowerCase()));
});

test("/v1 asks whether the door is open of the light settings module, never of the door's binding", () => {
  // The binding reads the database, the chain and the master key once a use
  // comes; registering /v1 must not load it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "../routes/openaiV1.ts"), "utf8");
  assert.match(source, /from "\.\.\/services\/x402DoorSettings\.js"/);
  assert.doesNotMatch(source, /buildPaidUseX402Deps/);
});
