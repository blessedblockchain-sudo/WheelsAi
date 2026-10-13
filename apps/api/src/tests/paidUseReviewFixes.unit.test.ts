import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { PUBLIC_RESULT_MAX_CHARS, PUBLIC_RESULTS_LIMIT } from "../routes/publicAgent.js";
import { PAID_AGENT_COLUMNS, USE_SUBSCRIPTION_COLUMNS, useSubscriptionOf } from "../services/buildPaidUseDeps.js";
import { paidUseOpenAiError } from "../services/openaiCompat.js";
import {
  getUseAccess,
  listPaidResults,
  paidRefusalBody,
  runPaidChat,
  runPaidTask,
  type PaidCaller,
} from "../services/paidUse.js";
import * as publicPageState from "../services/publicPageState.js";
import {
  CREATOR_ORG,
  HANDLE,
  KEY_CALLER,
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

// What the review of batch 5 found in paid use, each pinned on the real
// core (services/paidUse.ts) over the harness's stand-ins:
//   - a free listing's results follow the public page's switch and limits;
//   - a person removed from the buying organization cannot spend its credits;
//   - the access view says when a copy's paid month stands in the way of a start;
//   - a paid use keeps the titles of the creator's documents from the model.

const CHAT = { messages: [{ role: "user", content: "Hi, I am Ada." }], stream: false };
const RUN = { input: { topic: "Launch plan" }, stream: false };
const TASK_AGENT = { agentKind: "task", kindConfig: TASK_FORM, name: "Brief Writer" };

const chat = (h: PaidHarness, caller: PaidCaller = SESSION) =>
  runPaidChat({ caller, handle: HANDLE, body: CHAT, signal: new AbortController().signal }, h.deps);
const results = (h: PaidHarness, caller: PaidCaller = SESSION) => listPaidResults({ caller, handle: HANDLE }, h.deps);

// ============================================
// Results of a free listing
// ============================================

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  finishedAt: new Date(Date.UTC(2026, 9, 9, 9, 0, 0) - i * 86_400_000),
  text: `Briefing ${i}`,
}));
const FREE_LISTING = { ...LISTING, pricingModel: "free", pricePerRequestCents: null };
const FREE_SCHEDULED: PaidHarnessOptions = {
  agent: { agentKind: "scheduled", publicResults: true },
  listing: FREE_LISTING,
  licence: null,
  results: ROWS,
};

test("a free listing whose owner switched results off gives no result to anyone signed in, and reads none", async () => {
  for (const publicResults of [false, null, undefined]) {
    for (const caller of [SESSION, KEY_CALLER, { ...KEY_CALLER, scopes: [] }]) {
      const h = paidHarness({ ...FREE_SCHEDULED, agent: { agentKind: "scheduled", publicResults: publicResults as never } });
      const result = await results(h, caller);
      assert.deepEqual(result, { kind: "results", results: [], hasMore: false }, String(publicResults));
      assert.ok(!h.log.some((entry) => entry.startsWith("results:")), "no result was read");
    }
  }
});

test("a free listing with results on gives what its page gives: 3 results of up to 8,000 characters", async () => {
  const h = paidHarness(FREE_SCHEDULED);
  const calls: Array<{ limit: number; maxChars: number }> = [];
  const latest = h.deps.latestResults;
  h.deps.latestResults = async (args) => {
    calls.push({ limit: args.limit, maxChars: args.maxChars });
    return latest(args);
  };
  const result = await results(h);
  assert.ok(result.kind === "results");
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results[0], { finishedAt: "2026-10-09T09:00:00.000Z", text: "Briefing 0" });
  assert.equal(result.hasMore, true);
  // One more than is shown, cut where the page cuts.
  assert.deepEqual(calls, [{ limit: 4, maxChars: 8_000 }]);

  const few = await results(paidHarness({ ...FREE_SCHEDULED, results: ROWS.slice(0, 2) }));
  assert.ok(few.kind === "results");
  assert.equal(few.results.length, 2);
  assert.equal(few.hasMore, false);
});

test("a subscriber inside a paid month and the owner keep 30 results of up to 20,000 characters", async () => {
  const subscribed: PaidHarnessOptions = {
    // The switch is the public page's: it takes nothing from a subscriber.
    agent: { agentKind: "scheduled", publicResults: false },
    listing: MONTHLY_LISTING,
    licence: MONTHLY_LICENCE,
    sub: PAID_MONTH,
    results: ROWS,
  };
  const cases: Array<[string, PaidHarnessOptions, PaidCaller]> = [
    ["a subscriber", subscribed, SESSION],
    ["the owner of a monthly listing", { ...subscribed, licence: null, sub: null }, { ...SESSION, orgId: CREATOR_ORG }],
    [
      "the owner of a free listing with results off",
      { ...FREE_SCHEDULED, agent: { agentKind: "scheduled", publicResults: false } },
      { ...SESSION, orgId: CREATOR_ORG },
    ],
    // The month was paid for before the listing went free: it still buys what it bought.
    [
      "a subscriber whose listing has since gone free",
      { ...subscribed, listing: FREE_LISTING },
      SESSION,
    ],
  ];
  for (const [name, options, caller] of cases) {
    const h = paidHarness(options);
    const calls: Array<{ limit: number; maxChars: number }> = [];
    const latest = h.deps.latestResults;
    h.deps.latestResults = async (args) => {
      calls.push({ limit: args.limit, maxChars: args.maxChars });
      return latest(args);
    };
    const result = await results(h, caller);
    assert.ok(result.kind === "results", name);
    assert.equal(result.results.length, 30, name);
    assert.equal(result.hasMore, true, name);
    assert.deepEqual(calls, [{ limit: 31, maxChars: 20_000 }], name);
  }
});

test("the page's two result limits live in the page-state service, and the route still exports them", () => {
  assert.equal(publicPageState.PUBLIC_RESULTS_LIMIT, 3);
  assert.equal(publicPageState.PUBLIC_RESULT_MAX_CHARS, 8_000);
  assert.equal(PUBLIC_RESULTS_LIMIT, publicPageState.PUBLIC_RESULTS_LIMIT);
  assert.equal(PUBLIC_RESULT_MAX_CHARS, publicPageState.PUBLIC_RESULT_MAX_CHARS);
  // The switch is among the columns the paid service reads of the agent.
  assert.equal((PAID_AGENT_COLUMNS as Record<string, unknown>).publicResults, true);
});

test("a paid use reads the count of a plan and its plan's status with the subscription row", () => {
  // Without `includedUses` a plan row reads as a month with no count; without
  // the plan's status a plan its creator ended gets days of grace.
  assert.deepEqual(USE_SUBSCRIPTION_COLUMNS, {
    status: true,
    currentPeriodEnd: true,
    cancelAtPeriodEnd: true,
    endReason: true,
    priceCents: true,
    id: true,
    planId: true,
    currentPeriodStart: true,
    includedUses: true,
    usedInPeriod: true,
    carriedUses: true,
    extraUsePriceCents: true,
    plan: { select: { status: true } },
  });
  const row = { id: "sub-1", includedUses: 500 };
  assert.deepEqual(
    [{ status: "retired" }, { status: "active" }, null].map((plan) => useSubscriptionOf({ ...row, plan })),
    [
      { ...row, planRetired: true },
      { ...row, planRetired: false },
      { ...row, planRetired: false },
    ],
  );
});

// ============================================
// A removed member
// ============================================

const NOT_A_MEMBER =
  "You are no longer a member of this organization, so you cannot use this agent on its behalf.";

function assertNothingSpent(h: PaidHarness) {
  assert.equal(h.money.balance, 500n);
  assert.deepEqual(h.money.ledger, []);
  assert.deepEqual(h.money.revenue, []);
  assert.equal(h.allowanceCounted(), 0);
}

test("a person removed from the buying organization is refused before anything is counted, looked up or charged", async () => {
  for (const task of [false, true]) {
    const h = paidHarness({ role: null, ...(task && { agent: TASK_AGENT }) });
    const input = { caller: SESSION, handle: HANDLE, body: task ? RUN : CHAT, signal: new AbortController().signal };
    const result = task ? await runPaidTask(input, h.deps) : await runPaidChat(input, h.deps);
    assert.ok(result.kind === "refused");
    assert.deepEqual(paidRefusalBody(result.refusal), { error: "not_a_member", message: NOT_A_MEMBER });
    assert.equal(result.refusal.status, 403);
    // The membership is all that was read.
    assert.deepEqual(h.log, ["memberRole"]);
    assertNothingSpent(h);
  }
});

test("a session with no person behind it is not a member", async () => {
  const h = paidHarness();
  const result = await chat(h, { ...SESSION, userId: null });
  assert.ok(result.kind === "refused");
  assert.equal(result.refusal.status, 403);
  assert.equal(result.refusal.code, "not_a_member");
  assert.deepEqual(h.log, []);
  assertNothingSpent(h);
});

test("a membership that cannot be read refuses the use: 503, nothing charged", async () => {
  const h = paidHarness({ roleThrows: new Error("the database is away") });
  const result = await chat(h);
  assert.ok(result.kind === "refused");
  assert.deepEqual(paidRefusalBody(result.refusal), {
    error: "agent_unavailable",
    message: "This agent cannot be used right now. Nothing was charged. Try again later.",
  });
  assert.equal(result.refusal.status, 503);
  assert.deepEqual(h.log, ["memberRole"]);
  assertNothingSpent(h);
});

test("every member may use what an owner or admin started, and the membership is read first", async () => {
  for (const role of ["owner", "admin", "member"]) {
    const h = paidHarness({ role });
    const result = await chat(h);
    assert.equal(result.kind, "answer", role);
    assert.deepEqual(h.log.slice(0, 3), ["memberRole", "peek:pu:r:d", "limit:pu:b:m,pu:b:d"], role);
    assert.equal(h.log.filter((entry) => entry === "memberRole").length, 1, role);
    assert.equal(h.money.balance, 495n, role);
  }
});

test("an API key belongs to the organization, not a person: no membership is read for it", async () => {
  for (const options of [{ role: null }, { roleThrows: new Error("the database is away") }] as PaidHarnessOptions[]) {
    const h = paidHarness({ ...options, keyCaps: { maxUse: 50n, daily: 100n } });
    const result = await chat(h, KEY_CALLER);
    assert.equal(result.kind, "answer");
    assert.ok(!h.log.includes("memberRole"));
    assert.equal(h.money.balance, 495n);
  }
});

test("/v1 tells a removed member so: a 403 permission error with its own code, not to be retried", () => {
  const mapped = paidUseOpenAiError({ code: "not_a_member", message: NOT_A_MEMBER });
  assert.equal(mapped.status, 403);
  assert.deepEqual(mapped.body, {
    error: { message: NOT_A_MEMBER, type: "permission_error", param: null, code: "not_a_member" },
  });
  assert.equal(mapped.headers["x-should-retry"], "false");
});

// ============================================
// A copy with a month paid for
// ============================================

const COPY = { ...MONTHLY_LICENCE, kind: "copy" };

async function accessView(options: PaidHarnessOptions, caller: PaidCaller = SESSION) {
  const result = await getUseAccess({ caller, handle: HANDLE }, paidHarness(options).deps);
  assert.ok(result.kind === "access");
  return result.view;
}

test("the access view says when a copy's paid month stands in the way of a start, and nobody may accept then", async () => {
  for (const listing of [MONTHLY_LISTING, LISTING]) {
    // An owner, who could otherwise agree to the price.
    const view = await accessView({ listing, licence: COPY, sub: PAID_MONTH, role: "owner" });
    assert.equal(view.access, "none");
    assert.deepEqual(view.startBlocked, {
      code: "copy_subscription_active",
      message:
        "You hold a copy of this agent that is paid for until 1 Nov. To use the agent on its page instead, remove your copy (the month you paid for is not refunded), or cancel its renewal and start after that date.",
      until: "2026-11-01T00:00:00.000Z",
    });
    assert.equal(view.canAccept, false);
    // The terms are still told: they are what a start would ask after that date.
    assert.ok(view.terms);
  }

  // A key granted marketplace:install by name is held to it too.
  const key = await accessView(
    { listing: MONTHLY_LISTING, licence: COPY, sub: PAID_MONTH },
    { ...KEY_CALLER, scopes: ["marketplace:install"] },
  );
  assert.equal(key.startBlocked?.code, "copy_subscription_active");
  assert.equal(key.canAccept, false);

  // Past its date and still open (the renewal is being retried): another sentence, the same refusal.
  const retried = await accessView({
    listing: MONTHLY_LISTING,
    licence: COPY,
    sub: { ...PAID_MONTH, currentPeriodEnd: new Date("2026-10-09T00:00:00.000Z") },
  });
  assert.equal(retried.startBlocked?.until, "2026-10-09T00:00:00.000Z");
  assert.equal(
    retried.startBlocked?.message,
    "You hold a copy of this agent whose subscription is still open. To use the agent on its page instead, remove your copy first.",
  );
  assert.equal(retried.canAccept, false);
});

test("nothing stands in the way without a copy's paid month: startBlocked is null and canAccept is the caller's own", async () => {
  const ended = { ...PAID_MONTH, status: "expired", currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") };
  const cases: Array<[string, PaidHarnessOptions, PaidCaller]> = [
    ["no licence", { licence: null }, SESSION],
    ["a use licence", {}, SESSION],
    ["a use licence inside its paid month", { listing: MONTHLY_LISTING, licence: MONTHLY_LICENCE, sub: PAID_MONTH }, SESSION],
    ["a copy with no subscription", { licence: { ...LICENCE, kind: "copy" } }, SESSION],
    ["a copy whose subscription ended", { listing: MONTHLY_LISTING, licence: COPY, sub: ended }, SESSION],
    ["a removed copy", { listing: MONTHLY_LISTING, licence: { ...COPY, status: "uninstalled" }, sub: PAID_MONTH }, SESSION],
    ["the owner", { listing: MONTHLY_LISTING, licence: COPY, sub: PAID_MONTH }, { ...SESSION, orgId: CREATOR_ORG }],
  ];
  for (const [name, options, caller] of cases) {
    const view = await accessView(options, caller);
    assert.equal(view.startBlocked, null, name);
    assert.equal(view.canAccept, true, name);
  }
  assert.equal((await accessView({ licence: null, role: "member" })).canAccept, false);
});

// ============================================
// Document titles
// ============================================

test("a paid use asks the chat core to keep the titles of the creator's documents from the model", async () => {
  const message = paidHarness();
  assert.equal((await chat(message)).kind, "answer");
  assert.equal(message.chatInputs.length, 1);
  assert.equal(message.chatInputs[0]!.hideSourceTitles, true);

  const task = paidHarness({ agent: TASK_AGENT });
  const ran = await runPaidTask(
    { caller: SESSION, handle: HANDLE, body: RUN, signal: new AbortController().signal },
    task.deps,
  );
  assert.equal(ran.kind, "result");
  assert.equal(task.chatInputs[0]!.hideSourceTitles, true);

  // A subscribed use too: it is the person asking who must not learn them, whatever they pay.
  const subscribed = paidHarness({ listing: MONTHLY_LISTING, licence: MONTHLY_LICENCE, sub: PAID_MONTH });
  assert.equal((await chat(subscribed)).kind, "answer");
  assert.equal(subscribed.chatInputs[0]!.hideSourceTitles, true);
});
