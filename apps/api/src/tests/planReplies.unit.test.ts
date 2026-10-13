import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from "fastify";

import { requireScope } from "../middleware/auth.js";
import { createOpenAiAuth } from "../middleware/openaiAuth.js";
import {
  createOpenAiV1Routes,
  USED_SUBSCRIPTION_COLUMNS,
  usedAgentsOf,
  usedSubscriptionOf,
  type UsedAgentRow,
  type UsedSubscriptionRow,
} from "../routes/openaiV1.js";
import { createPaidUseRoutes } from "../routes/paidUse.js";
import { paidUseOpenAiError, toChatCompletion } from "../services/openaiCompat.js";
import type { PaidCaller, PaidSubscription } from "../services/paidUse.js";
import type { PlanOfferRow } from "../services/planOffers.js";
import { usageHeadersOf } from "../services/usageHeaders.js";
import {
  CREATOR_ORG,
  HANDLE,
  KEY_CALLER,
  LICENCE,
  LISTING,
  MONTHLY_LICENCE,
  MONTHLY_LISTING,
  PAID_MONTH,
  PLAN_LICENCE,
  PLAN_SUB,
  paidHarness,
  SESSION,
  TASK_FORM,
  type PaidHarness,
  type PaidHarnessOptions,
} from "./paidUseHarness.js";

// What a buyer is told about plans: the plans a listing offers and the plan
// they are on (GET /api/a/:handle/access), the count after each use on the
// answers of chat, run and /v1, and the two refusals a plan adds, in the
// page's shape and in OpenAI's. The paid service is the real one on the
// harness's stand-ins. The harness's now is 10 Oct 2026, noon; the plan's
// period ends on 1 Nov.

const RESETS_AT = "2026-11-01T00:00:00.000Z";
const SECONDS_TO_RESET = 21.5 * 24 * 60 * 60;

/** The listing's price per use now ($0.09) is not what a plan's extra use costs ($0.50, as agreed). */
const PLAN_LISTING = { ...LISTING, pricePerRequestCents: 9n };
/** What the listing offers now, as the database holds it, with more on a row than a buyer may see. */
const OFFERED = [
  { id: "plan-1", name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 50n, position: 1, status: "active" },
  { id: "plan-2", name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, position: 2, status: "active" },
] as unknown as PlanOfferRow[];
const OFFERS = [
  { id: "plan-1", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 50 },
  { id: "plan-2", name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: null },
];
const TERMS = { pricingModel: "per_request", pricePerRequestCents: 9, monthlyPriceCents: null, unit: "message", keepsCopy: false };

/** A buyer on the Starter plan: 500 uses, then $0.50 a use, 12 used. */
const planOptions = (sub: Partial<PaidSubscription> = {}, options: PaidHarnessOptions = {}): PaidHarnessOptions => ({
  listing: PLAN_LISTING,
  licence: PLAN_LICENCE,
  balance: 500n,
  ...options,
  sub: { ...PLAN_SUB, extraUsePriceCents: 50n, planName: "Starter", ...sub },
});

/** The harness's deps, reading the listing's plans as production does. */
function offering(h: PaidHarness, plans: PlanOfferRow[] | Error = OFFERED): PaidHarness {
  h.deps.loadPlans = async (listingId) => {
    h.log.push(`loadPlans:${listingId}`);
    if (plans instanceof Error) throw plans;
    return plans;
  };
  return h;
}

const auth: preHandlerAsyncHookHandler = async (request, reply) => {
  const header = request.headers["x-test-auth"];
  if (typeof header !== "string") {
    return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
  }
  (request as { auth: unknown }).auth = JSON.parse(header);
};
const as = (caller: object) => ({ "x-test-auth": JSON.stringify(caller) });

/** The page's routes (/api/a/...) and /v1, over one harness. */
async function servers(options: PaidHarnessOptions, plans?: PlanOfferRow[] | Error) {
  const h = offering(paidHarness(options), plans);
  const page = Fastify();
  await page.register(
    createPaidUseRoutes({
      guards: { auth, use: requireScope("agents:use") as preHandlerAsyncHookHandler },
      paidUse: () => h.deps,
    }),
    { prefix: "/api" },
  );

  const v1 = Fastify();
  await v1.register(sensible);
  v1.decorateRequest("auth", null);
  v1.addHook("onRequest", async (request) => {
    const header = request.headers["x-test-auth"];
    if (typeof header === "string") (request as { auth: unknown }).auth = JSON.parse(header);
  });
  const guard = createOpenAiAuth({ meter: async () => {} });
  await v1.register(
    createOpenAiV1Routes({
      unifiedAuth: guard,
      auth: guard,
      workflowAuth: guard,
      paidUse: () => h.deps,
      now: () => 1_760_000_000_000,
      listModels: async () => ({ deployments: [], agents: [], workflows: [], used: [] }),
    }),
    { prefix: "/v1" },
  );
  await v1.ready();
  return { h, page, v1 };
}

const CHAT = { messages: [{ role: "user", content: "Hi, I am Ada." }], stream: false };
const chatOn = (app: FastifyInstance, caller: PaidCaller = SESSION, body: object = CHAT) =>
  app.inject({ method: "POST", url: `/api/a/${HANDLE}/chat`, headers: as(caller), payload: body });
const completeOn = (app: FastifyInstance, caller: PaidCaller = SESSION, body: object = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: as(caller),
    payload: { model: `a/${HANDLE}`, messages: CHAT.messages, ...body },
  });
const accessOn = async (options: PaidHarnessOptions, plans?: PlanOfferRow[] | Error) => {
  const { h, page } = await servers(options, plans);
  const res = await page.inject({ method: "GET", url: `/api/a/${HANDLE}/access`, headers: as(SESSION) });
  assert.equal(res.statusCode, 200);
  return { view: res.json() as Record<string, any>, body: res.body, h };
};

// ============================================
// GET /api/a/:handle/access
// ============================================

test("access without a plan: the plans on offer field by field, no plan held, and no free trial yet", async () => {
  const { view, body, h } = await accessOn({ listing: PLAN_LISTING, licence: null });
  assert.equal(view.access, "none");
  assert.deepEqual(view.plans, OFFERS);
  assert.equal(view.plan, null);
  assert.equal(view.trialAvailable, false);
  // The price per use stays what it was: the plans are on top of it.
  assert.deepEqual(view.terms, TERMS);
  assert.deepEqual(h.log.filter((entry) => entry.startsWith("loadPlans")), ["loadPlans:lst-1"]);
  // Nothing else of a plan's row, and nothing of who sells it.
  for (const forbidden of ["position", "status\":\"active", CREATOR_ORG, "subscribers"]) {
    assert.ok(!body.includes(forbidden), forbidden);
  }

  // A buyer who pays per use sees the same plans.
  const perUse = await accessOn({ listing: PLAN_LISTING, licence: { ...LICENCE, acceptedPricePerRequestCents: 9n } });
  assert.deepEqual([perUse.view.access, perUse.view.plans, perUse.view.plan], ["listing_pricing", OFFERS, null]);
});

test("access on a plan: its name, the count, what an extra use costs, when it starts again, and the warning", async () => {
  const { view } = await accessOn(planOptions());
  assert.equal(view.access, "subscribed");
  assert.deepEqual(view.plan, {
    id: "plan-1",
    name: "Starter",
    includedUses: 500,
    carriedUses: 0,
    usedUses: 12,
    remainingUses: 488,
    extraUsePriceCents: 50,
    resetsAt: RESETS_AT,
    warning: null,
  });
  // Still shown what is on offer: a bigger plan is among them.
  assert.deepEqual(view.plans, OFFERS);
  assert.equal(view.trialAvailable, false);
  // Starting a plan agreed to no price per use.
  assert.deepEqual(view.accepted, { pricingModel: null, pricePerRequestCents: null, monthlyPriceCents: 900 });

  const planOf = async (sub: Partial<PaidSubscription>, options: PaidHarnessOptions = {}) =>
    (await accessOn(planOptions(sub, options))).view.plan;
  assert.deepEqual(
    [(await planOf({ usedInPeriod: 424 })).warning, (await planOf({ usedInPeriod: 425 })).warning],
    [null, 85],
  );
  // All used, on a plan that stops: nothing left, and nothing below zero.
  assert.deepEqual(await planOf({ usedInPeriod: 500, extraUsePriceCents: null }), {
    id: "plan-1",
    name: "Starter",
    includedUses: 500,
    carriedUses: 0,
    usedUses: 500,
    remainingUses: 0,
    extraUsePriceCents: null,
    resetsAt: RESETS_AT,
    warning: 100,
  });
  // Uses carried in by a move to a bigger plan are part of what is left, and
  // are said, so a page can tell what the period holds without working it out.
  const carried = await planOf({ usedInPeriod: 510, carriedUses: 20 });
  assert.deepEqual([carried.includedUses, carried.carriedUses, carried.usedUses, carried.remainingUses], [500, 20, 510, 10]);
});

test("a plan that will not renew has no time at which its count starts again", async () => {
  const resetsOf = async (sub: Partial<PaidSubscription>, options: PaidHarnessOptions = {}, plans?: PlanOfferRow[]) => {
    const { view } = await accessOn(planOptions(sub, options), plans);
    assert.equal(view.access, "subscribed");
    assert.equal(view.plan.usedUses, 12);
    return "resetsAt" in view.plan ? view.plan.resetsAt : "left out";
  };
  assert.equal(await resetsOf({}), RESETS_AT);
  // The buyer cancelled the renewal.
  assert.equal(await resetsOf({ cancelAtPeriodEnd: true }), "left out");
  // The creator ended the plan: its holder finishes the 30 days they paid for.
  assert.equal(await resetsOf({ planRetired: true }, {}, [OFFERED[1]!]), "left out");
  // The listing is sold by the month now, or was taken down: the plan runs to its end.
  assert.equal(await resetsOf({}, { listing: MONTHLY_LISTING }), "left out");
  assert.equal(await resetsOf({}, { listing: { ...PLAN_LISTING, status: "archived" } }), "left out");
});

test("no plan is offered, or read, on a listing that is not sold per use, and a read that fails shows none", async () => {
  for (const listing of [MONTHLY_LISTING, { ...PLAN_LISTING, status: "archived" }, { ...PLAN_LISTING, sells: "copies" }]) {
    const { view, h } = await accessOn(planOptions({}, { listing }));
    assert.deepEqual(view.plans, [], listing.pricingModel + listing.status + listing.sells);
    assert.ok(!h.log.some((entry) => entry.startsWith("loadPlans")));
  }
  // The view is already decided: a failed read of the offers does not undo it.
  const failed = await accessOn(planOptions(), new Error("the plans could not be read"));
  assert.deepEqual([failed.view.access, failed.view.plans, failed.view.plan.name], ["subscribed", [], "Starter"]);
});

test("a plan that is over is not the plan the buyer is on: the access says to choose, with the plans and the price per use", async () => {
  const over = { status: "expired", currentPeriodEnd: new Date("2026-10-05T00:00:00.000Z") };
  const { view } = await accessOn(planOptions(over));
  assert.equal(view.access, "plan_ended");
  assert.equal(view.plan, null);
  assert.deepEqual(view.plans, OFFERS);
  assert.deepEqual(view.terms, TERMS);

  // Agreed to a price per use themselves before the plan: that is what applies after it.
  const agreed = await accessOn(planOptions(over, { licence: { ...LICENCE, acceptedPricePerRequestCents: 9n } }));
  assert.deepEqual([agreed.view.access, agreed.view.plan], ["listing_pricing", null]);
});

// ============================================
// The answers
// ============================================

/** The usage headers of a reply, and no other header. */
const usageOf = (res: { headers: Record<string, unknown> }): Record<string, unknown> =>
  Object.fromEntries(Object.entries(res.headers).filter(([name]) => name.startsWith("x-wheelsai")));

/** What the headers say of the plan after the 13th of 500 uses. */
const PLAN_HEADERS = {
  "x-wheelsai-plan": "plan-1",
  "x-wheelsai-plan-limit": "500",
  "x-wheelsai-plan-used": "13",
  "x-wheelsai-plan-remaining": "487",
  "x-wheelsai-plan-reset": RESETS_AT,
};

const INCLUDED = {
  id: "plan-1",
  use: "included",
  includedUses: 500,
  carriedUses: 0,
  usedUses: 13,
  remainingUses: 487,
  extraUsePriceCents: 50,
  resetsAt: RESETS_AT,
  warning: null,
};
const EXTRA = { ...INCLUDED, use: "extra", usedUses: 500, remainingUses: 0, warning: 100 };

test("an included use: chat, run and /v1 answer with nothing charged and the count after it", async () => {
  const chat = await servers(planOptions());
  const chatted = await chatOn(chat.page);
  assert.equal(chatted.statusCode, 200);
  assert.deepEqual(chatted.json().billing, { chargedCents: 0, balanceCents: 500, access: "subscribed", plan: INCLUDED });
  assert.equal(chat.h.sub?.usedInPeriod, 13);

  const task = await servers(planOptions({}, { agent: { agentKind: "task", kindConfig: TASK_FORM, name: "Brief Writer" } }));
  const ran = await task.page.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/run`,
    headers: as(SESSION),
    payload: { input: { topic: "Launch plan" }, stream: false },
  });
  assert.equal(ran.statusCode, 200);
  assert.deepEqual(ran.json().billing, { chargedCents: 0, balanceCents: 500, access: "subscribed", plan: INCLUDED });

  // By key, with no credits and caps a priced use would break: an included use asks neither.
  const api = await servers(planOptions({}, { balance: 0n, keyCaps: { maxUse: 1n, daily: 1n } }));
  const completed = await completeOn(api.v1, KEY_CALLER);
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(completed.json().wheelsai, {
    agent: { handle: HANDLE },
    billing: { chargedCents: 0, balanceCents: 0, access: "subscribed", plan: INCLUDED },
  });
  assert.deepEqual(api.h.money.ledger, []);
  assert.equal(api.h.sub?.usedInPeriod, 13);
  // The usage headers say the same count.
  assert.deepEqual(usageOf(completed), { ...PLAN_HEADERS, "x-wheelsai-charged-cents": "0", "x-wheelsai-balance-cents": "0" });

  // Streamed: the same billing rides on the first chunk.
  const streamed = await servers(planOptions());
  const stream = await completeOn(streamed.v1, SESSION, { stream: true });
  assert.equal(stream.statusCode, 200);
  const first = JSON.parse(stream.body.split("\n\n")[0]!.slice(5));
  assert.deepEqual(first.wheelsai.billing, { chargedCents: 0, balanceCents: 500, access: "subscribed", plan: INCLUDED });
});

test("an extra use: chat, run and /v1 answer with the agreed extra price charged and the plan's count unmoved", async () => {
  const used = { usedInPeriod: 500 };
  const chat = await servers(planOptions(used));
  const chatted = await chatOn(chat.page);
  assert.equal(chatted.statusCode, 200);
  // The agreed $0.50, not the listing's $0.09 a use.
  assert.deepEqual(chatted.json().billing, { chargedCents: 50, balanceCents: 450, access: "subscribed", plan: EXTRA });
  assert.equal(chat.h.sub?.usedInPeriod, 500);

  const task = await servers(planOptions(used, { agent: { agentKind: "task", kindConfig: TASK_FORM, name: "Brief Writer" } }));
  const ran = await task.page.inject({
    method: "POST",
    url: `/api/a/${HANDLE}/run`,
    headers: as(SESSION),
    payload: { input: { topic: "Launch plan" }, stream: false },
  });
  assert.deepEqual([ran.statusCode, ran.json().billing], [
    200,
    { chargedCents: 50, balanceCents: 450, access: "subscribed", plan: EXTRA },
  ]);

  const api = await servers(planOptions(used));
  const completed = await completeOn(api.v1);
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(completed.json().wheelsai.billing, {
    chargedCents: 50,
    balanceCents: 450,
    access: "subscribed",
    plan: EXTRA,
  });
  assert.deepEqual(api.h.money.revenue.map((r) => [r.status, r.gross, r.creator, r.platformFee]), [["settled", 50n, 45n, 5n]]);
});

test("an answer on a plan that will not renew carries no time at which the count starts again", async () => {
  const { resetsAt: _resetsAt, ...ending } = INCLUDED;
  const cancelled = await servers(planOptions({ cancelAtPeriodEnd: true }));
  assert.deepEqual((await chatOn(cancelled.page)).json().billing.plan, ending);
  const retired = await servers(planOptions({ planRetired: true }));
  assert.deepEqual((await completeOn(retired.v1)).json().wheelsai.billing.plan, ending);
});

// ============================================
// The usage headers
// ============================================

const ANSWER = "Hello, Ada. How can I help?";
const TOOL_CALLS = [{ name: "web_search", status: "unavailable" }];
const TASK_AGENT = { agentKind: "task", kindConfig: TASK_FORM, name: "Brief Writer" } as const;

interface UsageCase {
  name: string;
  options: PaidHarnessOptions;
  /** The billing object of the answer, in the order its body writes it. */
  billing: Record<string, unknown>;
  headers: Record<string, string>;
}

const USAGE_CASES: UsageCase[] = [
  {
    name: "an included use",
    options: planOptions(),
    billing: { chargedCents: 0, balanceCents: 500, access: "subscribed", plan: INCLUDED },
    headers: { "x-wheelsai-charged-cents": "0", "x-wheelsai-balance-cents": "500", ...PLAN_HEADERS },
  },
  {
    name: "an extra use",
    options: planOptions({ usedInPeriod: 500 }),
    billing: { chargedCents: 50, balanceCents: 450, access: "subscribed", plan: EXTRA },
    headers: {
      "x-wheelsai-charged-cents": "50",
      "x-wheelsai-balance-cents": "450",
      ...PLAN_HEADERS,
      "x-wheelsai-plan-used": "500",
      "x-wheelsai-plan-remaining": "0",
      "x-wheelsai-plan-warning": "100",
    },
  },
  {
    name: "a monthly subscriber",
    options: { listing: MONTHLY_LISTING, licence: MONTHLY_LICENCE, sub: PAID_MONTH, balance: 500n },
    billing: { chargedCents: 0, balanceCents: 500, access: "subscribed" },
    headers: { "x-wheelsai-charged-cents": "0", "x-wheelsai-balance-cents": "500" },
  },
  {
    name: "a buyer who pays per use",
    options: { balance: 500n },
    billing: { chargedCents: 5, balanceCents: 495, access: "listing_pricing" },
    headers: { "x-wheelsai-charged-cents": "5", "x-wheelsai-balance-cents": "495" },
  },
];

for (const c of USAGE_CASES) {
  test(`usage headers: ${c.name}, on chat, run and /v1, whole and streamed, with the body as it was`, async () => {
    // What the headers say is what the body's billing says, written out.
    assert.deepEqual(usageHeadersOf(c.billing as never), c.headers);
    const task: PaidHarnessOptions = { ...c.options, agent: TASK_AGENT };
    const post = (app: FastifyInstance, path: string, payload: object) =>
      app.inject({ method: "POST", url: `/api/a/${HANDLE}/${path}`, headers: as(SESSION), payload });
    const billingEvent = `data: ${JSON.stringify({ wheelsai: { billing: c.billing } })}`;

    // Chat, whole.
    const chatted = await chatOn((await servers(c.options)).page);
    assert.equal(chatted.statusCode, 200);
    assert.deepEqual(usageOf(chatted), c.headers);
    assert.equal(
      chatted.body,
      JSON.stringify({ message: { role: "assistant", content: ANSWER }, toolCalls: TOOL_CALLS, billing: c.billing }),
    );

    // Chat, streamed: the headers are in the head, before the billing event.
    const chatStream = await post((await servers(c.options)).page, "chat", { messages: CHAT.messages, stream: true });
    assert.equal(chatStream.statusCode, 200);
    assert.match(String(chatStream.headers["content-type"]), /text\/event-stream/);
    assert.deepEqual(usageOf(chatStream), c.headers);
    assert.equal(chatStream.body.split("\n\n")[0], billingEvent);

    // Run, whole.
    const ran = await post((await servers(task)).page, "run", { input: { topic: "Launch plan" }, stream: false });
    assert.equal(ran.statusCode, 200);
    assert.deepEqual(usageOf(ran), c.headers);
    assert.equal(
      ran.body,
      JSON.stringify({ output: { format: "text", text: ANSWER }, toolCalls: TOOL_CALLS, billing: c.billing }),
    );

    // Run, streamed.
    const runStream = await post((await servers(task)).page, "run", { input: { topic: "Launch plan" }, stream: true });
    assert.equal(runStream.statusCode, 200);
    assert.match(String(runStream.headers["content-type"]), /text\/event-stream/);
    assert.deepEqual(usageOf(runStream), c.headers);
    assert.equal(runStream.body.split("\n\n")[0], billingEvent);

    // /v1, whole: OpenAI's completion with the `wheelsai` object, and nothing added to it.
    const completed = await completeOn((await servers(c.options)).v1);
    assert.equal(completed.statusCode, 200);
    assert.deepEqual(usageOf(completed), c.headers);
    const extension = { agent: { handle: HANDLE }, billing: c.billing };
    assert.equal(
      completed.body,
      JSON.stringify(
        toChatCompletion({
          id: completed.json().id,
          created: 1_760_000_000,
          model: `a/${HANDLE}`,
          content: ANSWER,
          finishReason: "stop",
          extension,
        }),
      ),
    );

    // /v1, streamed: the same extension on the first chunk.
    const stream = await completeOn((await servers(c.options)).v1, SESSION, { stream: true });
    assert.equal(stream.statusCode, 200);
    assert.match(String(stream.headers["content-type"]), /text\/event-stream/);
    assert.deepEqual(usageOf(stream), c.headers);
    const first = JSON.parse(stream.body.split("\n\n")[0]!.slice(5));
    assert.equal(JSON.stringify(first.wheelsai), JSON.stringify(extension));

    // Never in a header: the model, tokens, or the creator's organization.
    for (const res of [chatted, chatStream, ran, runStream, completed, stream]) {
      const told = JSON.stringify(usageOf(res));
      for (const secret of [CREATOR_ORG, "token", "model", "org"]) assert.ok(!told.includes(secret), secret);
    }
  });
}

test("usage headers: the warning is told from 85% of a plan's uses, and a plan that will not renew has no reset", async () => {
  const below = await chatOn((await servers(planOptions({ usedInPeriod: 423 }))).page);
  assert.deepEqual([below.json().billing.plan.warning, "x-wheelsai-plan-warning" in below.headers], [null, false]);
  const at = await chatOn((await servers(planOptions({ usedInPeriod: 424 }))).page);
  assert.deepEqual([at.json().billing.plan.warning, at.headers["x-wheelsai-plan-warning"]], [85, "85"]);
  assert.deepEqual([at.headers["x-wheelsai-plan-used"], at.headers["x-wheelsai-plan-remaining"]], ["425", "75"]);

  // Uses carried into the period are part of the limit.
  const carried = await completeOn((await servers(planOptions({ carriedUses: 20 }))).v1);
  assert.deepEqual(
    [carried.headers["x-wheelsai-plan-limit"], carried.headers["x-wheelsai-plan-remaining"]],
    ["520", "507"],
  );

  const { "x-wheelsai-plan-reset": _reset, ...ending } = PLAN_HEADERS;
  const cancelled = await chatOn((await servers(planOptions({ cancelAtPeriodEnd: true }))).page);
  assert.deepEqual(usageOf(cancelled), { "x-wheelsai-charged-cents": "0", "x-wheelsai-balance-cents": "500", ...ending });
  const retired = await completeOn((await servers(planOptions({ planRetired: true }))).v1, SESSION, { stream: true });
  assert.deepEqual(usageOf(retired), { "x-wheelsai-charged-cents": "0", "x-wheelsai-balance-cents": "500", ...ending });
});

test("usage headers: a balance that cannot be read leaves its header out, and the answer on a plan goes out as it would have", async () => {
  for (const streamed of [false, true]) {
    const { h, page, v1 } = await servers(planOptions());
    h.deps.readBalance = async () => {
      throw new Error("the balance cannot be read");
    };
    const { "x-wheelsai-balance-cents": _balance, ...rest } = USAGE_CASES[0]!.headers;
    const chatted = await chatOn(page, SESSION, { messages: CHAT.messages, stream: streamed });
    assert.equal(chatted.statusCode, 200);
    assert.deepEqual(usageOf(chatted), rest);
    const completed = await completeOn(v1, SESSION, { stream: streamed });
    assert.equal(completed.statusCode, 200);
    assert.deepEqual(usageOf(completed), { ...rest, "x-wheelsai-plan-used": "14", "x-wheelsai-plan-remaining": "486" });
    if (!streamed) {
      assert.equal(chatted.json().billing.balanceCents, null);
      assert.equal(completed.json().wheelsai.billing.balanceCents, null);
    }
  }
});

// ============================================
// The two refusals
// ============================================

test("plan_used_up: 429 with when it starts again, Retry-After and the plans on offer, in the page's shape and in OpenAI's", async () => {
  const stopped = { usedInPeriod: 500, extraUsePriceCents: null };
  const { h, page, v1 } = await servers(planOptions(stopped));

  const refused = await chatOn(page);
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.headers["retry-after"], String(SECONDS_TO_RESET));
  assert.deepEqual(refused.json(), {
    error: "plan_used_up",
    message: "You have used all 500 uses. It starts again on 1 Nov. Nothing was charged.",
    retryAfterSeconds: SECONDS_TO_RESET,
    plans: OFFERS,
    resetsAt: RESETS_AT,
  });

  const openAi = await completeOn(v1);
  assert.equal(openAi.statusCode, 429);
  assert.equal(openAi.headers["retry-after"], String(SECONDS_TO_RESET));
  // A quota that ran out, under its own code: an OpenAI SDK sends a rate
  // limit again by itself, and no second send of this can be answered.
  assert.equal(openAi.headers["x-should-retry"], "false");
  assert.deepEqual(openAi.json().error, {
    plans: OFFERS,
    resetsAt: RESETS_AT,
    message: "You have used all 500 uses. It starts again on 1 Nov. Nothing was charged.",
    type: "insufficient_quota",
    param: null,
    code: "plan_used_up",
  });
  // Nothing was charged, no use was taken and the model was not called, either time.
  assert.deepEqual([h.money.balance, h.money.ledger.length, h.sub?.usedInPeriod], [500n, 0, 500]);
  assert.ok(!h.log.includes("model") && !h.log.includes("take"));

  // Both carry the plan's headers with nothing remaining, and say no charge and no balance.
  const usedUpHeaders = {
    "x-wheelsai-plan": "plan-1",
    "x-wheelsai-plan-limit": "500",
    "x-wheelsai-plan-used": "500",
    "x-wheelsai-plan-remaining": "0",
    "x-wheelsai-plan-reset": RESETS_AT,
    "x-wheelsai-plan-warning": "100",
  };
  assert.deepEqual(usageOf(refused), usedUpHeaders);
  assert.deepEqual(usageOf(openAi), usedUpHeaders);
  // The bodies are what they were, byte for byte: the count the headers are written from is not in them.
  const sentence = "You have used all 500 uses. It starts again on 1 Nov. Nothing was charged.";
  assert.equal(
    refused.body,
    JSON.stringify({
      error: "plan_used_up",
      message: sentence,
      retryAfterSeconds: SECONDS_TO_RESET,
      plans: OFFERS,
      resetsAt: RESETS_AT,
    }),
  );
  assert.equal(
    openAi.body,
    JSON.stringify({
      error: { plans: OFFERS, resetsAt: RESETS_AT, message: sentence, type: "insufficient_quota", param: null, code: "plan_used_up" },
    }),
  );

  // Found used up only at the take (the last use went to another request): the same headers.
  const raced = await servers(
    planOptions({ usedInPeriod: 499, extraUsePriceCents: null }, { beforeTake: (row) => void (row.usedInPeriod = 500) }),
  );
  const late = await chatOn(raced.page);
  assert.deepEqual([late.statusCode, late.json().error, usageOf(late)], [429, "plan_used_up", usedUpHeaders]);

  // A plan that will not renew: when it ends is in the sentence, and no reset time is told.
  const ending = await servers(planOptions({ ...stopped, cancelAtPeriodEnd: true }));
  const ended = (await chatOn(ending.page)).json();
  assert.equal(ended.message, "You have used all 500 uses. Your plan ends on 1 Nov. Nothing was charged.");
  assert.deepEqual([ended.plans, "resetsAt" in ended], [OFFERS, false]);
  const endedOpenAi = await completeOn(ending.v1);
  assert.equal("resetsAt" in endedOpenAi.json().error, false);
  // And no reset header: no count starts again.
  const { "x-wheelsai-plan-reset": _reset, ...noReset } = usedUpHeaders;
  assert.deepEqual(usageOf(endedOpenAi), noReset);
  assert.deepEqual(usageOf(await chatOn(ending.page)), noReset);
});

test("plan_ended: 402 with the plans and the price per use to choose from, in the page's shape and in OpenAI's", async () => {
  const over = { status: "expired", currentPeriodEnd: new Date("2026-10-05T00:00:00.000Z") };
  const { h, page, v1 } = await servers(planOptions(over));

  const refused = await chatOn(page);
  assert.equal(refused.statusCode, 402);
  assert.deepEqual(refused.json(), {
    error: "plan_ended",
    message: "Your plan ended. Choose a plan or pay per use to keep using it.",
    access: "plan_ended",
    terms: TERMS,
    plans: OFFERS,
  });

  const openAi = await completeOn(v1, KEY_CALLER);
  assert.equal(openAi.statusCode, 402);
  assert.deepEqual(openAi.json().error, {
    access: "plan_ended",
    terms: TERMS,
    plans: OFFERS,
    reason: "plan_ended",
    message: "Your plan ended. Choose a plan or pay per use to keep using it.",
    type: openAi.json().error.type,
    param: null,
    code: "marketplace_payment_required",
  });
  // Only a plan that is used up has usage headers: this refusal has none.
  assert.deepEqual([usageOf(refused), usageOf(openAi)], [{}, {}]);
  // Starting a plan was not an agreement to the price per use: nothing is charged.
  assert.deepEqual([h.money.balance, h.money.ledger.length], [500n, 0]);
  assert.ok(!h.log.includes("model"));
});

test("usage headers: on /v1 no refusal but a used-up plan carries any, with or without a plan behind it", async () => {
  // /v1 sets its headers itself and not through the page's refusal, so the rule is held here too.
  for (const [name, options, status] of [
    ["too few credits to pay per use", { balance: 0n }, 402],
    ["no licence", { licence: null }, 403],
    ["an extra use of a plan with too few credits", planOptions({ usedInPeriod: 500 }, { balance: 0n }), 402],
  ] as const) {
    const { h, v1 } = await servers(options);
    const res = await completeOn(v1);
    assert.equal(res.statusCode, status, `${name}: ${res.body}`);
    assert.deepEqual(usageOf(res), {}, name);
    assert.equal(h.money.ledger.length, 0, name);
  }
});

test("the OpenAI shape carries a refusal's reset time and plans only when it has them", () => {
  const plain = paidUseOpenAiError({ code: "plan_used_up", message: "Used up.", retryAfterSeconds: 30 });
  assert.deepEqual(Object.keys(plain.body.error).sort(), ["code", "message", "param", "type"]);
  assert.deepEqual([plain.body.error.code, plain.headers["x-should-retry"], plain.headers["retry-after"]], ["plan_used_up", "false", "30"]);
  // A pace that was too fast stays a rate limit, which an SDK may send again.
  const paced = paidUseOpenAiError({ code: "rate_limited", message: "Too fast.", retryAfterSeconds: 30 });
  assert.deepEqual([paced.body.error.code, paced.body.error.reason, paced.headers["x-should-retry"]], ["rate_limit_exceeded", "rate_limited", undefined]);
  const full = paidUseOpenAiError({
    code: "plan_used_up",
    message: "Used up.",
    retryAfterSeconds: 30,
    resetsAt: RESETS_AT,
    plans: OFFERS,
  });
  assert.deepEqual([full.status, full.body.error.resetsAt, full.body.error.plans], [429, RESETS_AT, OFFERS]);
});

test("deps that read no plans name none: the refusals are what they were", async () => {
  const stopped = paidHarness(planOptions({ usedInPeriod: 500, extraUsePriceCents: null }));
  const { runPaidChat } = await import("../services/paidUse.js");
  const result = await runPaidChat(
    { caller: SESSION, handle: HANDLE, body: CHAT, signal: new AbortController().signal },
    stopped.deps,
  );
  assert.ok(result.kind === "refused");
  assert.equal("plans" in result.refusal, false);
});

// ============================================
// GET /v1/models
// ============================================

test("the agents an organization uses: a plan holder's agent is listed, and one whose plan ended is not until they choose", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const licence = (handle: string, over: Partial<UsedAgentRow> = {}): UsedAgentRow => ({
    kind: "use",
    status: "active",
    installedAt: new Date("2026-10-05T00:00:00Z"),
    // A plan start agreed to no price per use.
    acceptedPricingModel: null,
    acceptedPricePerRequestCents: null,
    listingId: `lst-${handle}`,
    ...over,
    listing: {
      status: "published",
      sells: "use",
      pricingModel: "per_request",
      pricePerRequestCents: 5n,
      agent: { publicHandle: handle },
    },
  });
  const plan = (handle: string, over: Partial<UsedSubscriptionRow> = {}): UsedSubscriptionRow => ({
    listingId: `lst-${handle}`,
    status: "active",
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    endReason: null,
    includedUses: 500,
    planRetired: false,
    ...over,
  });
  const ended = { status: "expired", currentPeriodEnd: new Date("2026-10-05T00:00:00Z") };
  const pastEnd = { status: "past_due", currentPeriodEnd: new Date("2026-10-09T00:00:00Z") };
  const used = usedAgentsOf(
    [
      licence("on-a-plan"),
      licence("plan-ended"),
      licence("plan-ended-agreed-per-use", { acceptedPricingModel: "per_request", acceptedPricePerRequestCents: 5n }),
      licence("renewal-retried"),
      licence("retired-and-past-its-end"),
      licence("suspended-after-plan", { status: "suspended", acceptedPricingModel: "per_request", acceptedPricePerRequestCents: 5n }),
    ],
    [
      plan("on-a-plan"),
      plan("plan-ended", ended),
      plan("plan-ended-agreed-per-use", ended),
      // Three days of grace while the renewal is retried.
      plan("renewal-retried", pastEnd),
      // A plan its creator ended is not renewed: no grace.
      plan("retired-and-past-its-end", { ...pastEnd, planRetired: true }),
      plan("suspended-after-plan", ended),
    ],
    now,
  );
  assert.deepEqual(
    used.map((agent) => agent.handle),
    ["on-a-plan", "plan-ended-agreed-per-use", "renewal-retried"],
  );
});

test("the read behind that list takes a plan's count and its status, and says when its creator ended it", () => {
  // Without these two a plan row reads as a month with no count.
  assert.equal(USED_SUBSCRIPTION_COLUMNS.includedUses, true);
  assert.equal(USED_SUBSCRIPTION_COLUMNS.plan.select.status, true);

  const row = {
    listingId: "lst-1",
    status: "active",
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    endReason: null,
    includedUses: 500,
  };
  assert.deepEqual(usedSubscriptionOf({ ...row, plan: { status: "retired" } }), { ...row, planRetired: true });
  assert.deepEqual(usedSubscriptionOf({ ...row, plan: { status: "active" } }), { ...row, planRetired: false });
  // A month with no count has no plan.
  assert.deepEqual(usedSubscriptionOf({ ...row, includedUses: null, plan: null }), {
    ...row,
    includedUses: null,
    planRetired: false,
  });
});
