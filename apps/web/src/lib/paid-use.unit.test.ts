/**
 * What an agent's public page shows someone who pays to use it. Run with:
 *   cd apps/web && npx tsx --test src/lib/paid-use.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PaidUseAccess, PaidUseAccessState, PaidUseRefusal, PaidUseTerms, PublicAgentPaidTerms } from "./api";
import {
  PAID_REFUSAL_RULES,
  PAID_USE_MESSAGES,
  acceptLabel,
  chargeLine,
  dollars,
  expectedTerms,
  lastResultLine,
  lowCreditsLine,
  noticeOfView,
  paidRefusalNotice,
  paidView,
  packTaskDraft,
  priceLine,
  priceOfPage,
  priceOfTerms,
  privacyLine,
  registerHref,
  scheduleLines,
  shortDay,
  signInHref,
  startDialog,
  subscribeDialog,
  taskDraftKey,
  tryFreeHref,
  unpackTaskDraft,
  type PaidActionKind,
} from "./paid-use";

const here = dirname(fileURLToPath(import.meta.url));
const UTC = { timeZone: "UTC" };

const PAGE: PublicAgentPaidTerms = {
  listingId: "l1",
  listingSlug: "support-bot",
  pricingModel: "per_request",
  priceCents: 5,
  unit: "message",
  perMinute: 10,
  perDay: 200,
  transcriptsStored: false,
  sendsRequests: false,
};
const MONTHLY_PAGE: PublicAgentPaidTerms = { ...PAGE, pricingModel: "monthly", priceCents: 900, unit: "month" };

const PER_USE: PaidUseTerms = {
  pricingModel: "per_request",
  pricePerRequestCents: 5,
  monthlyPriceCents: null,
  unit: "message",
  keepsCopy: false,
};
const MONTHLY: PaidUseTerms = {
  pricingModel: "monthly",
  pricePerRequestCents: null,
  monthlyPriceCents: 900,
  unit: "month",
  keepsCopy: false,
};

function state(access: PaidUseAccess, extra: Partial<PaidUseAccessState> = {}): PaidUseAccessState {
  return {
    access,
    listingId: "l1",
    terms: PER_USE,
    accepted: null,
    subscription: null,
    balanceCents: 495,
    canAccept: true,
    startBlocked: null,
    ...extra,
  };
}

const ACTIONS: PaidActionKind[] = ["signin", "start", "accept", "subscribe", "add_credits", "wait", "none"];

// ============================================
// The price
// ============================================

test("prices are dollars with two decimals", () => {
  assert.equal(dollars(5), "$0.05");
  assert.equal(dollars(10), "$0.10");
  assert.equal(dollars(900), "$9.00");
  assert.equal(dollars(495), "$4.95");
  assert.equal(dollars(123456), "$1234.56");
  assert.equal(dollars(Number.NaN), "$0.00");
});

test("the price line names what one payment buys", () => {
  assert.equal(priceLine(priceOfPage(PAGE)), "$0.05 per message");
  assert.equal(priceLine(priceOfPage({ ...PAGE, priceCents: 10, unit: "run" })), "$0.10 per run");
  assert.equal(priceLine(priceOfPage(MONTHLY_PAGE)), "$9.00 a month");
  assert.equal(PAID_USE_MESSAGES.paidFromCredits, "Paid from your WheelsAI credits.");
});

test("the terms the API gives a signed-in caller read as the same price", () => {
  assert.deepEqual(priceOfTerms(PER_USE), { model: "per_request", cents: 5, unit: "message" });
  assert.deepEqual(priceOfTerms({ ...PER_USE, unit: "run" }), { model: "per_request", cents: 5, unit: "run" });
  assert.deepEqual(priceOfTerms(MONTHLY), { model: "monthly", cents: 900, unit: "month" });
  assert.equal(priceOfTerms(null), null);
  assert.equal(priceOfTerms({ ...PER_USE, pricingModel: "token_gated" }), null);
  assert.equal(priceOfTerms({ ...MONTHLY, monthlyPriceCents: null }), null);
});

test("a start sends back exactly the terms that were shown", () => {
  assert.deepEqual(expectedTerms(PER_USE), { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null });
  assert.deepEqual(expectedTerms(MONTHLY), { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900 });
});

test("the start and subscribe dialogs say the plan's words with the real numbers", () => {
  const start = startDialog({ model: "per_request", cents: 5, unit: "message" });
  assert.equal(
    start.body,
    "Each message costs $0.05, paid from your credits. It is charged when you send it and refunded if the agent does not answer. You can stop at any time.",
  );
  assert.match(start.confirmLabel, /\$0\.05 per message/);
  assert.match(startDialog({ model: "per_request", cents: 10, unit: "run" }).body, /^Each run costs \$0\.10,/);

  const subscribe = subscribeDialog({ model: "monthly", cents: 900, unit: "month" }, "chat", 200);
  assert.equal(
    subscribe.body,
    "Charges $9.00 from your credits now and every 30 days. You can use it up to 200 times a day. Cancel at any time and keep access until the month you paid for ends.",
  );
  assert.equal(subscribe.confirmLabel, "Subscribe for $9.00 a month");
  const reads = subscribeDialog({ model: "monthly", cents: 900, unit: "month" }, "scheduled", 200);
  assert.doesNotMatch(reads.body, /times a day/);
  assert.match(reads.body, /^Charges \$9\.00 from your credits now and every 30 days\./);
});

test("the privacy line says which of the two is true", () => {
  assert.equal(privacyLine(false), "WheelsAI does not give the owner of this agent a copy of what you send.");
  assert.equal(privacyLine(true), "The owner of this agent gets a copy of what you send and what it answers.");
  assert.equal(PAID_USE_MESSAGES.sendsRequests, "This agent can send requests to other websites as part of its answers.");
});

// ============================================
// The view
// ============================================

test("signed out: sign in, with the page's price", () => {
  const view = paidView({ authed: false, access: null, page: PAGE, kind: "chat" });
  assert.equal(view.kind, "signed_out");
  assert.equal(view.sentence, "Sign in to use this agent.");
  assert.deepEqual(view.action, { kind: "signin", label: "Sign in" });
  assert.equal(view.usable, false);
  assert.deepEqual(view.price, { model: "per_request", cents: 5, unit: "message" });
  assert.equal(PAID_USE_MESSAGES.createAccount, "Create an account");
  assert.equal(PAID_USE_MESSAGES.tryFree, "Try it free first");
  assert.equal(PAID_USE_MESSAGES.draftKept, "Your answers are kept on this device while you sign in.");
});

test("every access the API can answer has a sentence and an action", () => {
  const all: PaidUseAccess[] = [
    "none",
    "subscribed",
    "listing_pricing",
    "pricing_changed",
    "subscription_lapsed",
    "not_offered",
    "own_agent",
    "unlisted",
    "uninstalled",
  ];
  for (const access of all) {
    for (const terms of [PER_USE, MONTHLY, null]) {
      for (const canAccept of [true, false]) {
        const view = paidView({ authed: true, access: state(access, { terms, canAccept }), page: PAGE, kind: "chat" });
        assert.ok(view.sentence.trim().length > 0, `${access} has a sentence`);
        assert.ok(ACTIONS.includes(view.action.kind), `${access} has an action`);
        if (view.action.kind !== "none" && view.action.kind !== "wait") {
          assert.ok(view.action.label, `${access}: ${view.action.kind} has words on its button`);
        }
        assert.doesNotMatch(view.sentence, /undefined|null|NaN/, access);
      }
    }
  }
});

test("the caller's own agent", () => {
  const view = paidView({ authed: true, access: state("own_agent"), page: PAGE, kind: "chat" });
  assert.equal(view.kind, "own_agent");
  assert.equal(view.sentence, "This is your agent. This is the page people who pay see.");
  assert.equal(view.action.kind, "none");
  assert.equal(view.usable, false);
});

test("not started: start per use, or subscribe, each behind a dialog that names the price", () => {
  const perUse = paidView({ authed: true, access: state("none"), page: PAGE, kind: "chat" });
  assert.equal(perUse.kind, "not_started");
  assert.deepEqual(perUse.action, { kind: "start", label: "Start using" });
  assert.match(perUse.dialog?.body ?? "", /^Each message costs \$0\.05,/);
  assert.equal(perUse.acceptNewPricing, false);

  const monthly = paidView({ authed: true, access: state("none", { terms: MONTHLY }), page: MONTHLY_PAGE, kind: "chat" });
  assert.deepEqual(monthly.action, { kind: "subscribe", label: "Subscribe for $9.00 a month" });
  assert.match(monthly.dialog?.body ?? "", /^Charges \$9\.00 from your credits now and every 30 days\. You can use it up to 200 times a day\./);
});

test("someone who is not an owner or admin is told to ask one, with no button", () => {
  const view = paidView({ authed: true, access: state("none", { canAccept: false }), page: PAGE, kind: "chat" });
  assert.equal(view.kind, "ask_admin");
  assert.equal(view.sentence, "Ask an owner or admin of your organization to start this.");
  assert.equal(view.action.kind, "none");
  assert.equal(view.dialog, null);
});

test("a start held back shows the API's sentence and no start button", () => {
  const message = "You hold a copy of this agent that is paid for until 12 Nov. Remove your copy first.";
  const view = paidView({
    authed: true,
    access: state("none", {
      canAccept: false,
      startBlocked: { code: "copy_subscription_active", message, until: "2026-11-12T00:00:00.000Z" },
    }),
    page: PAGE,
    kind: "chat",
  });
  assert.equal(view.kind, "start_blocked");
  assert.equal(view.sentence, message);
  assert.equal(view.action.kind, "none");
  assert.equal(view.dialog, null);
});

test("a changed price shows both prices and a button that names the new one", () => {
  const view = paidView({
    authed: true,
    access: state("pricing_changed", {
      terms: { ...PER_USE, pricePerRequestCents: 8 },
      accepted: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null },
    }),
    page: { ...PAGE, priceCents: 8 },
    kind: "chat",
  });
  assert.equal(view.kind, "price_changed");
  assert.equal(
    view.sentence,
    "The owner changed the price to $0.08 per message. You agreed to $0.05. Nothing is charged until you accept the new price.",
  );
  assert.deepEqual(view.action, { kind: "accept", label: "Accept $0.08 per message" });
  assert.equal(view.acceptNewPricing, true);
  assert.equal(view.usable, false);
  assert.equal(acceptLabel({ model: "per_request", cents: 8, unit: "message" }), "Accept $0.08 per message");
});

test("a move to monthly asks for a subscription", () => {
  const view = paidView({
    authed: true,
    access: state("pricing_changed", {
      terms: MONTHLY,
      accepted: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null },
    }),
    page: MONTHLY_PAGE,
    kind: "chat",
  });
  assert.equal(view.sentence, "This agent is now sold by the month ($9.00). Nothing is charged until you subscribe.");
  assert.deepEqual(view.action, { kind: "subscribe", label: "Subscribe for $9.00 a month" });
  assert.equal(view.acceptNewPricing, true);
  assert.ok(view.dialog);
});

test("a changed price a member cannot accept has no button", () => {
  const view = paidView({
    authed: true,
    access: state("pricing_changed", {
      canAccept: false,
      terms: { ...PER_USE, pricePerRequestCents: 8 },
      accepted: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null },
    }),
    page: PAGE,
    kind: "chat",
  });
  assert.equal(view.action.kind, "none");
  assert.match(view.sentence, /Ask an owner or admin of your organization to start this\.$/);
});

test("a subscription that ended, and a renewal that failed", () => {
  const ended = paidView({
    authed: true,
    access: state("subscription_lapsed", { terms: MONTHLY }),
    page: MONTHLY_PAGE,
    kind: "chat",
  });
  assert.equal(ended.kind, "lapsed");
  assert.equal(ended.sentence, "Your subscription has ended. Subscribe again to keep using it.");
  assert.deepEqual(ended.action, { kind: "subscribe", label: "Subscribe for $9.00 a month" });
  assert.equal(ended.usable, false);

  const subscription = {
    status: "past_due",
    currentPeriodEnd: "2026-11-12T09:00:00.000Z",
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
  };
  const accepted = { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900 };
  const failed = paidView({
    authed: true,
    access: state("subscribed", { terms: MONTHLY, accepted, subscription }),
    page: MONTHLY_PAGE,
    kind: "chat",
    dates: UTC,
  });
  assert.equal(failed.sentence, "Your renewal of $9.00 did not go through. Add credits to keep access.");
  assert.deepEqual(failed.action, { kind: "add_credits", label: "Add credits" });
  assert.equal(failed.usable, true);

  // The day is said only when the API sends it.
  const withDay = paidView({
    authed: true,
    access: state("subscribed", {
      terms: MONTHLY,
      accepted,
      subscription: { ...subscription, graceEndsAt: "2026-11-15T09:00:00.000Z" },
    }),
    page: MONTHLY_PAGE,
    kind: "chat",
    dates: UTC,
  });
  assert.equal(withDay.sentence, "Your renewal of $9.00 did not go through. Add credits before 15 Nov to keep access.");
});

test("no longer offered, and until when a subscriber keeps access", () => {
  const gone = paidView({ authed: true, access: state("not_offered", { terms: null }), page: PAGE, kind: "chat" });
  assert.equal(gone.kind, "not_offered");
  assert.equal(gone.sentence, "This agent is no longer offered. You will not be charged again.");
  assert.equal(gone.usable, false);
  assert.equal(gone.action.kind, "none");

  const subscriber = paidView({
    authed: true,
    access: state("subscribed", {
      terms: null,
      subscription: { status: "active", currentPeriodEnd: "2026-11-12T09:00:00.000Z", cancelAtPeriodEnd: true, graceEndsAt: null },
    }),
    page: MONTHLY_PAGE,
    kind: "chat",
    dates: UTC,
  });
  assert.equal(subscriber.sentence, "This agent is no longer offered. You keep access until 12 Nov.");
  assert.equal(subscriber.usable, true);

  // Never started, and nothing on sale: nothing about being charged "again".
  const never = paidView({ authed: true, access: state("none", { terms: null }), page: PAGE, kind: "chat" });
  assert.equal(never.sentence, "This agent is no longer offered.");
});

test("in use per use: the price, the credits, and the low line only when it should appear", () => {
  const view = paidView({ authed: true, access: state("listing_pricing"), page: PAGE, kind: "chat" });
  assert.equal(view.kind, "in_use");
  assert.equal(view.sentence, "$0.05 per message. Your credits: $4.95.");
  assert.equal(view.usable, true);
  assert.equal(view.lowCredits, null);
  assert.equal(view.action.kind, "none");

  const low = paidView({ authed: true, access: state("listing_pricing", { balanceCents: 15 }), page: PAGE, kind: "chat" });
  assert.equal(low.lowCredits, "You have credits for about 3 more messages.");
  assert.deepEqual(low.action, { kind: "add_credits", label: "Add credits" });
  assert.equal(low.usable, true);
});

test("the low-credits line appears at three uses or fewer, and never for a month", () => {
  const perMessage = { model: "per_request", cents: 5, unit: "message" } as const;
  assert.equal(lowCreditsLine(20, perMessage), null, "four left");
  assert.equal(lowCreditsLine(19, perMessage), "You have credits for about 3 more messages.");
  assert.equal(lowCreditsLine(15, perMessage), "You have credits for about 3 more messages.");
  assert.equal(lowCreditsLine(10, perMessage), "You have credits for about 2 more messages.");
  assert.equal(lowCreditsLine(5, perMessage), "You have credits for about 1 more message.");
  assert.equal(lowCreditsLine(4, perMessage), "You do not have credits for another message.");
  assert.equal(lowCreditsLine(10, { model: "per_request", cents: 10, unit: "run" }), "You have credits for about 1 more run.");
  assert.equal(lowCreditsLine(0, { model: "monthly", cents: 900, unit: "month" }), null);
  assert.equal(lowCreditsLine(0, { model: "per_request", cents: 0, unit: "message" }), null);
  assert.equal(lowCreditsLine(0, null), null);
});

test("subscribed: what they have and until when", () => {
  const base = {
    terms: MONTHLY,
    accepted: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900 },
  };
  const renews = paidView({
    authed: true,
    access: state("subscribed", {
      ...base,
      subscription: { status: "active", currentPeriodEnd: "2026-11-12T09:00:00.000Z", cancelAtPeriodEnd: false, graceEndsAt: null },
    }),
    page: MONTHLY_PAGE,
    kind: "chat",
    dates: UTC,
  });
  assert.equal(renews.sentence, "You are subscribed. Renews 12 Nov at $9.00 a month.");
  assert.equal(renews.usable, true);
  assert.equal(renews.lowCredits, null);

  const cancelled = paidView({
    authed: true,
    access: state("subscribed", {
      ...base,
      subscription: { status: "active", currentPeriodEnd: "2026-11-12T09:00:00.000Z", cancelAtPeriodEnd: true, graceEndsAt: null },
    }),
    page: MONTHLY_PAGE,
    kind: "scheduled",
    dates: UTC,
  });
  assert.equal(cancelled.sentence, "Cancelled. You keep access until 12 Nov.");
});

test("a view held against a send reads as its own sentence and action", () => {
  const view = paidView({ authed: true, access: state("none"), page: PAGE, kind: "task" });
  const notice = noticeOfView(view);
  assert.equal(notice.message, view.sentence);
  assert.deepEqual(notice.action, view.action);
  assert.equal(notice.refundedCents, null);
});

// ============================================
// Refusals
// ============================================

const USE_CODES = [
  "invalid_request",
  "missing_scope",
  "use_not_started",
  "api_key_use_price_cap_exceeded",
  "api_key_daily_cap_exceeded",
  "api_key_spend_caps_missing",
  "not_a_member",
  "insufficient_credits",
  "subscription_lapsed",
  "agent_not_found",
  "own_agent",
  "not_for_sale",
  "not_offered",
  "results_only",
  "pricing_changed",
  "not_a_task_agent",
  "input_too_large",
  "input_invalid",
  "rate_limited",
  "too_many_refunds",
  "client_closed_request",
  "model_error",
  "answer_withheld",
  "agent_unavailable",
  "agent_paused",
  "rate_limiter_unavailable",
];
const RESULTS_CODES = ["not_a_scheduled_agent"];
const START_CODES = [
  "expected_terms_required",
  "listing_not_found",
  "listing_paused",
  "sells_copies",
  "subscription_claim_lost",
  "copy_subscription_active",
];
/** The codes that can come with a charge taken and given back. */
const REFUNDED_CODES = ["model_error", "answer_withheld", "agent_unavailable", "client_closed_request"];

const refusal = (error: string, extra: Partial<PaidUseRefusal> = {}): PaidUseRefusal => ({ error, message: "", ...extra });

test("every refusal code has a sentence and an action, with and without the API's own sentence", () => {
  for (const code of [...USE_CODES, ...RESULTS_CODES, ...START_CODES, "unauthorized"]) {
    assert.ok(PAID_REFUSAL_RULES[code], `${code} has a rule`);
    assert.ok(PAID_REFUSAL_RULES[code]!.fallback.trim().length > 0, `${code} has a sentence of its own`);
    assert.ok(ACTIONS.includes(PAID_REFUSAL_RULES[code]!.action), `${code} has an action`);
    for (const act of ["chat", "task", "results", "start"] as const) {
      const bare = paidRefusalNotice({ status: 409, refusal: refusal(code), act, unit: "message" });
      assert.ok(bare.message.trim().length > 0, `${code} says something with no API sentence`);
      assert.ok(ACTIONS.includes(bare.action.kind), code);
      assert.doesNotMatch(bare.message, /undefined|NaN/, code);
    }
  }
});

test("the API's own sentence is shown as it comes where this page has no better one", () => {
  for (const code of ["not_a_member", "not_for_sale", "results_only", "rate_limited", "too_many_refunds", "copy_subscription_active", "sells_copies"]) {
    const notice = paidRefusalNotice({
      status: 409,
      refusal: refusal(code, { message: "The API said this." }),
      act: "chat",
      unit: "message",
    });
    assert.equal(notice.message, "The API said this.", code);
  }
  // A code this page has never heard of: the API's sentence, and nothing to press.
  const unknown = paidRefusalNotice({
    status: 418,
    refusal: refusal("brand_new_code", { message: "Something new." }),
    act: "chat",
    unit: "message",
  });
  assert.equal(unknown.message, "Something new.");
  assert.equal(unknown.action.kind, "none");
});

test("each refusal points at the one thing to do", () => {
  const actionOf = (code: string, extra: Partial<PaidUseRefusal> = {}, status = 409) =>
    paidRefusalNotice({ status, refusal: refusal(code, extra), act: "chat", unit: "message" }).action;
  assert.deepEqual(actionOf("use_not_started", { terms: PER_USE }), { kind: "start", label: "Start using" });
  assert.deepEqual(actionOf("use_not_started", { terms: MONTHLY }), { kind: "subscribe", label: "Subscribe for $9.00 a month" });
  assert.deepEqual(actionOf("pricing_changed", { terms: { ...PER_USE, pricePerRequestCents: 8 } }), {
    kind: "accept",
    label: "Accept $0.08 per message",
  });
  assert.deepEqual(actionOf("pricing_changed", { terms: MONTHLY }), { kind: "subscribe", label: "Subscribe for $9.00 a month" });
  assert.deepEqual(actionOf("subscription_lapsed"), { kind: "subscribe", label: "Subscribe again" });
  assert.deepEqual(actionOf("insufficient_credits"), { kind: "add_credits", label: "Add credits" });
  assert.equal(actionOf("rate_limited").kind, "wait");
  assert.equal(actionOf("too_many_refunds").kind, "wait");
  assert.equal(actionOf("agent_unavailable").kind, "wait");
  assert.equal(actionOf("not_offered").kind, "none");
  assert.equal(actionOf("own_agent").kind, "none");
  assert.deepEqual(actionOf("anything", {}, 401), { kind: "signin", label: "Sign in" });
});

test("a 401 asks for sign-in whatever its body says, and with no body at all", () => {
  const withBody = paidRefusalNotice({
    status: 401,
    refusal: refusal("Unauthorized", { message: "No session" }),
    act: "chat",
    unit: "message",
  });
  assert.equal(withBody.message, "Sign in to use this agent.");
  assert.equal(withBody.action.kind, "signin");
  const bare = paidRefusalNotice({ status: 401, refusal: null, act: "task", unit: "run" });
  assert.equal(bare.message, "Sign in to use this agent.");
  assert.equal(bare.action.kind, "signin");
});

test("not enough credits names the price of this use", () => {
  const chat = paidRefusalNotice({
    status: 402,
    refusal: refusal("insufficient_credits", { priceCents: 5, balanceCents: 2 }),
    act: "chat",
    unit: "message",
  });
  assert.equal(chat.message, "You do not have enough credits for this message ($0.05). Nothing was charged. Add credits to continue.");
  const run = paidRefusalNotice({
    status: 402,
    refusal: refusal("insufficient_credits", { priceCents: 10 }),
    act: "task",
    unit: "run",
  });
  assert.equal(run.message, "You do not have enough credits for this run ($0.10). Nothing was charged. Add credits to continue.");
  // A start says what the API said: the amount is the first month's, which only it knows.
  const start = paidRefusalNotice({
    status: 402,
    refusal: refusal("insufficient_credits", { message: "You need $9.00 in credits to subscribe." }),
    act: "start",
    unit: "message",
  });
  assert.equal(start.message, "You need $9.00 in credits to subscribe.");
  assert.equal(start.action.kind, "add_credits");
});

test("a refunded charge is said as refunded, with the amount, and never as nothing charged", () => {
  for (const code of [...USE_CODES, ...RESULTS_CODES, ...START_CODES]) {
    for (const message of ["", "This agent cannot be used right now. Nothing was charged. Try again later."]) {
      const notice = paidRefusalNotice({
        status: 502,
        refusal: refusal(code, { message, refundedCents: 5 }),
        act: "chat",
        unit: "message",
      });
      assert.equal(notice.refundedCents, 5, code);
      assert.match(notice.message, /\$0\.05 was refunded/, code);
      assert.doesNotMatch(notice.message, /nothing (was|is) charged/i, code);
    }
  }
  for (const code of REFUNDED_CODES) {
    assert.doesNotMatch(PAID_REFUSAL_RULES[code]!.fallback, /nothing (was|is) charged/i, code);
  }
  const answer = (code: string) =>
    paidRefusalNotice({ status: 502, refusal: refusal(code, { refundedCents: 5 }), act: "chat", unit: "message" }).message;
  assert.equal(answer("model_error"), "The agent could not answer just now. Your $0.05 was refunded.");
  assert.equal(answer("answer_withheld"), "This answer could not be shown. Your $0.05 was refunded.");
});

test("with no refund, a failed answer says what the API said", () => {
  const notice = paidRefusalNotice({
    status: 502,
    refusal: refusal("model_error", { message: "The agent could not answer just now. Please try again." }),
    act: "chat",
    unit: "message",
  });
  assert.equal(notice.message, "The agent could not answer just now. Please try again.");
  assert.equal(notice.refundedCents, null);
});

test("answers that need another look come back by question", () => {
  const notice = paidRefusalNotice({
    status: 422,
    refusal: {
      error: "input_invalid",
      message: "Some answers need another look.",
      details: [
        { field: "topic", message: "Give a topic." },
        { field: "topic", message: "Keep it short." },
      ] as PaidUseRefusal["details"],
    },
    act: "task",
    unit: "run",
  });
  assert.equal(notice.message, "Some answers need another look.");
  assert.deepEqual(notice.fields, { topic: "Give a topic. Keep it short." });
});

test("a request written for code is said in a person's words", () => {
  const chat = paidRefusalNotice({
    status: 400,
    refusal: refusal("invalid_request", { message: "Send { messages: [...] } with user and assistant text messages." }),
    act: "chat",
    unit: "message",
  });
  assert.doesNotMatch(chat.message, /[{}]/);
  const task = paidRefusalNotice({ status: 413, refusal: refusal("input_too_large"), act: "task", unit: "run" });
  assert.equal(task.message, "Your answers are too long. Shorten them and try again.");
});

test("a wait and a lost connection", () => {
  const limited = paidRefusalNotice({
    status: 429,
    refusal: refusal("rate_limited", { message: "You have used this agent 200 times today. Try again tomorrow.", retryAfterSeconds: 3600.2 }),
    act: "chat",
    unit: "message",
  });
  assert.equal(limited.message, "You have used this agent 200 times today. Try again tomorrow.");
  assert.equal(limited.retryAfterSeconds, 3601);
  const offline = paidRefusalNotice({ status: 0, refusal: null, act: "chat", unit: "message" });
  assert.equal(offline.message, PAID_USE_MESSAGES.offline);
  assert.equal(offline.action.kind, "none");
});

test("a start refused because the price moved carries the price as it is now", () => {
  const notice = paidRefusalNotice({
    status: 409,
    refusal: {
      ...refusal("pricing_changed", { message: "The price changed. Nothing was charged." }),
      pricing: { pricingModel: "per_request", pricePerRequestCents: 8, monthlyPriceCents: null },
    } as PaidUseRefusal,
    act: "start",
    unit: "message",
  });
  // Said with the price as it is now, not with the API's "after you agreed to it".
  assert.equal(notice.message, "The price is now $0.08 per message. Nothing was charged.");
  assert.deepEqual(notice.price, { model: "per_request", cents: 8, unit: "message" });
});

test("a subscription that comes back at the same amount is not called a changed price", () => {
  const accepted = { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900 };
  const same = paidView({
    authed: true,
    access: state("pricing_changed", { terms: MONTHLY, accepted }),
    page: MONTHLY_PAGE,
    kind: "chat",
  });
  assert.equal(same.sentence, "This agent is now sold by the month ($9.00). Nothing is charged until you subscribe.");
  const more = paidView({
    authed: true,
    access: state("pricing_changed", { terms: { ...MONTHLY, monthlyPriceCents: 1200 }, accepted }),
    page: MONTHLY_PAGE,
    kind: "chat",
  });
  assert.equal(more.sentence, "The owner changed the price to $12.00 a month. You agreed to $9.00. Nothing is charged until you subscribe.");
  assert.deepEqual(more.action, { kind: "subscribe", label: "Subscribe for $12.00 a month" });
});

test("a refusal in a panel leaves when the person can use the agent again, not when they stop being able to", () => {
  const gate = readFileSync(join(here, "..", "components", "public-agent", "paid-gate.tsx"), "utf8");
  assert.match(gate, /const noticeKey = String\(usableSince\);/);
  assert.doesNotMatch(gate, /noticeKey = `\$\{view\.kind\}/);
});

// ============================================
// What a use cost, dates, links, drafts
// ============================================

test("what a use cost", () => {
  assert.equal(
    chargeLine({ chargedCents: 5, balanceCents: 490, access: "listing_pricing" }, "message"),
    "This message cost $0.05. Your credits: $4.90.",
  );
  assert.equal(chargeLine({ chargedCents: 10, balanceCents: null, access: "listing_pricing" }, "run"), "This run cost $0.10.");
  assert.equal(chargeLine({ chargedCents: 0, balanceCents: 490, access: "subscribed" }, "message"), "Included in your subscription.");
});

test("dates read as the plan writes them", () => {
  assert.equal(shortDay("2026-11-12T09:00:00.000Z", UTC), "12 Nov");
  assert.equal(shortDay("not a date"), "");
  assert.equal(shortDay(null), "");
  assert.equal(lastResultLine("2026-10-12T09:00:00.000Z", UTC), "Last result: 12 Oct, 09:00.");
  assert.equal(lastResultLine("2026-10-12T09:00:00.000Z", { ...UTC, mark: "UTC" }), "Last result: 12 Oct, 09:00 UTC.");
  assert.equal(lastResultLine(null), null);
  assert.equal(lastResultLine("nope"), null);
});

test("a self-running agent's schedule in words", () => {
  assert.equal(PAID_USE_MESSAGES.runsOnItsOwn, "This agent runs on its own. Subscribers read its results here.");
  assert.deepEqual(scheduleLines({ cronExpression: "0 9 * * *", timezone: "Europe/Berlin" }), [
    "Runs every day at 09:00.",
    "Times are in Europe/Berlin.",
  ]);
  assert.deepEqual(scheduleLines(null), []);
  assert.deepEqual(scheduleLines({ cronExpression: " ", timezone: "UTC" }), []);
});

test("sign-in and sign-up come back to this page, and the free try is the listing's page", () => {
  assert.equal(signInHref("support-bot"), "/login?next=%2Fa%2Fsupport-bot");
  assert.equal(registerHref("support-bot"), "/register?next=%2Fa%2Fsupport-bot");
  assert.equal(tryFreeHref("support-bot-listing"), "/marketplace/support-bot-listing");
});

test("a task's answers come back once, only for the form they were typed into", () => {
  const blank = { topic: "", urgent: false };
  const stored = packTaskDraft("schema-a", { topic: "Refunds", urgent: true });
  assert.equal(taskDraftKey("support-bot"), "wheelsai:paid-task-draft:support-bot");
  assert.deepEqual(unpackTaskDraft(stored, "schema-a", blank), { topic: "Refunds", urgent: true });
  assert.equal(unpackTaskDraft(stored, "schema-b", blank), null, "the form changed");
  assert.equal(unpackTaskDraft(null, "schema-a", blank), null);
  assert.equal(unpackTaskDraft("{not json", "schema-a", blank), null);
  assert.equal(unpackTaskDraft(packTaskDraft("schema-a", blank), "schema-a", blank), null, "nothing was typed");
  // A question the form no longer has, and a value of the wrong kind, are left out.
  const odd = JSON.stringify({ schema: "schema-a", values: { topic: 5, gone: "x", urgent: true } });
  assert.deepEqual(unpackTaskDraft(odd, "schema-a", blank), { topic: "", urgent: true });
});

// ============================================
// Source pins
// ============================================

const PAID_FILES = [
  "paid-gate.tsx",
  "paid-transport.ts",
  "paid-results.tsx",
  "panel-notice.tsx",
  "public-chat-panel.tsx",
  "public-task-panel.tsx",
  "public-results-panel.tsx",
  "local-time.tsx",
];

test("nothing drawn in paid use calls a widget route or the free transport", () => {
  for (const file of PAID_FILES) {
    const source = readFileSync(join(here, "..", "components", "public-agent", file), "utf8");
    assert.doesNotMatch(source, /api\/widget/, file);
    assert.doesNotMatch(source, /publicUseApi/, file);
    assert.doesNotMatch(source, /\bfetch\(/, file);
    assert.doesNotMatch(source, /freeChatTransport|freeTaskTransport/, file);
  }
  const transport = readFileSync(join(here, "..", "components", "public-agent", "paid-transport.ts"), "utf8");
  assert.match(transport, /paidUseApi\.chat\(hooks\.handle/);
  assert.match(transport, /paidUseApi\.run\(hooks\.handle/);
  const results = readFileSync(join(here, "..", "components", "public-agent", "paid-results.tsx"), "utf8");
  assert.match(results, /paidUseApi\s*\.results\(handle\)/);
});

test("paid use goes by the agent's handle with the session, and free use never sends cookies", () => {
  const source = readFileSync(join(here, "api.ts"), "utf8");
  const paidStart = source.indexOf("export const paidUseApi");
  const paid = source.slice(paidStart, source.indexOf("\n};", paidStart));
  assert.ok(paidStart > 0);
  assert.doesNotMatch(paid, /widget/);
  assert.match(paid, /\/api\/a\/\$\{encodeURIComponent\(handle\)\}\/chat/);
  assert.match(paid, /\/api\/a\/\$\{encodeURIComponent\(handle\)\}\/run/);
  assert.match(paid, /stream: false/);

  // publicUseApi reaches the API only through publicFetch, which omits credentials.
  const fetchStart = source.indexOf("function publicFetch");
  const publicFetch = source.slice(fetchStart, source.indexOf("\n}", fetchStart));
  assert.match(publicFetch, /credentials: "omit"/);
  assert.doesNotMatch(publicFetch, /credentials: "include"/);
  const streamStart = source.indexOf("async function* streamPublicUse");
  const stream = source.slice(streamStart, source.indexOf("\n}", streamStart));
  assert.match(stream, /await publicFetch\(/);
  assert.doesNotMatch(stream, /\bapi<|\bapi\(|\bfetch\(/);
  const freeStart = source.indexOf("export const publicUseApi");
  const free = source.slice(freeStart, source.indexOf("\n};", freeStart));
  assert.equal(free.split("streamPublicUse(").length - 1, 2);
  assert.doesNotMatch(free, /\bapi<|\bapi\(|\bfetch\(|credentials/);
});

test("the gate agrees to a price only with the terms it showed, and reads the access after", () => {
  const gate = readFileSync(join(here, "..", "components", "public-agent", "paid-gate.tsx"), "utf8");
  assert.match(gate, /useSession\(\)/);
  assert.match(gate, /marketplaceApi\.startUsing\(agreed\.listingId, \{\s*expected: expectedTerms\(agreed\.terms\)/);
  assert.match(gate, /acceptNewPricing: true/);
  assert.equal(gate.split("marketplaceApi.startUsing(").length - 1, 1, "one place starts, subscribes and accepts");
  const agree = gate.slice(gate.indexOf("const agree = useCallback"), gate.indexOf("const press = useCallback"));
  assert.match(agree, /finally \{\s*await readAccess\(\);/);
  assert.match(gate, /onUsed: \(\) => void live\.current\.readAccess\(\)/);
});
