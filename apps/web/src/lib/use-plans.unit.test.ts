/**
 * The plans of an agent as its buyer reads them. Run with:
 *   cd apps/web && npx tsx --test src/lib/use-plans.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  PaidUseAccess,
  PaidUseAccessState,
  PaidUseBilling,
  PaidUsePlan,
  PaidUseRefusal,
  PaidUseTerms,
  PlanOffer,
  PublicAgentPaidTerms,
} from "./api";
import { PAID_REFUSAL_RULES, PAID_USE_MESSAGES, chargeLine, noticeOfView, paidRefusalNotice, paidView } from "./paid-use";
import {
  MOVE_UP_WORDS,
  USE_PLAN_WORDS,
  accessAfterRefusal,
  accessAfterUse,
  biggerPlans,
  carriedOnMove,
  payAsYouGoLine,
  planAfterLine,
  planCountLine,
  planCountOf,
  planGateView,
  planMoveDialog,
  planMoveNow,
  planMoveNotice,
  planPageView,
  planPriceLine,
  planStartDialog,
  planStartNotice,
  planTermsOf,
  planUsesLine,
  plansOf,
} from "./use-plans";

const UTC = { timeZone: "UTC" };
const NOV_12 = "2026-11-12T09:00:00.000Z";

const STARTER: PlanOffer = { id: "p1", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 4 };
const STOPS: PlanOffer = { id: "p2", name: "Basic", priceCents: 500, includedUses: 100, extraUsePriceCents: null };

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
const PAGE_WITH_PLANS: PublicAgentPaidTerms = { ...PAGE, plans: [STARTER, STOPS] };

const PER_USE: PaidUseTerms = {
  pricingModel: "per_request",
  pricePerRequestCents: 5,
  monthlyPriceCents: null,
  unit: "message",
  keepsCopy: false,
};

function state(access: PaidUseAccess, extra: Partial<PaidUseAccessState> = {}): PaidUseAccessState {
  return {
    access,
    listingId: "l1",
    terms: PER_USE,
    plans: [STARTER, STOPS],
    plan: null,
    accepted: null,
    subscription: null,
    balanceCents: 495,
    canAccept: true,
    startBlocked: null,
    ...extra,
  };
}

function onPlan(extra: Partial<PaidUsePlan> = {}): PaidUsePlan {
  return {
    id: "p1",
    name: "Starter",
    includedUses: 500,
    usedUses: 188,
    remainingUses: 312,
    extraUsePriceCents: 4,
    resetsAt: NOV_12,
    warning: null,
    ...extra,
  };
}

const SUB = { status: "active", currentPeriodEnd: NOV_12, cancelAtPeriodEnd: false, graceEndsAt: null };

const gate = (access: PaidUseAccessState | null, page = PAGE_WITH_PLANS, kind: "chat" | "task" = "chat") =>
  planGateView({ authed: access !== null, access, page, kind, dates: UTC });

// ============================================
// A card and its dialog
// ============================================

test("a card says its price for 30 days, its uses, and what happens after them", () => {
  assert.equal(planPriceLine(STARTER), "$9.00 for 30 days");
  assert.equal(planUsesLine(STARTER), "500 uses");
  assert.equal(planAfterLine(STARTER), "then $0.04 a use");
  assert.equal(planAfterLine(STOPS), "then it stops until it renews");
  assert.equal(planUsesLine({ ...STOPS, includedUses: 1 }), "1 use");
  assert.equal(USE_PLAN_WORDS.startButton, "Start this plan");
  assert.equal(USE_PLAN_WORDS.seePlans, "See plans");
  assert.equal(USE_PLAN_WORDS.hidePlans, "Hide plans");
});

test("pay as you go names the listing's price and its unit, and is not said of a month", () => {
  assert.equal(payAsYouGoLine({ model: "per_request", cents: 5, unit: "message" }), "Or pay as you go: $0.05 a message");
  assert.equal(payAsYouGoLine({ model: "per_request", cents: 10, unit: "run" }), "Or pay as you go: $0.10 a run");
  assert.equal(payAsYouGoLine({ model: "monthly", cents: 900, unit: "month" }), null);
  assert.equal(payAsYouGoLine(null), null);
});

test("the start dialog says the plan's words with the card's numbers", () => {
  assert.deepEqual(planStartDialog(STARTER), {
    title: "Start the Starter plan?",
    body: "Charges $9.00 from your credits now and every 30 days. Includes 500 uses. After that each use is $0.04.",
    confirmLabel: "Start for $9.00",
  });
  assert.equal(
    planStartDialog(STOPS).body,
    "Charges $5.00 from your credits now and every 30 days. Includes 100 uses. After that it stops until your plan renews.",
  );
  assert.equal(planStartDialog({ ...STOPS, includedUses: 1 }).body.includes("Includes 1 use."), true);
  // A name that already ends in "plan" is not said twice.
  assert.equal(planStartDialog({ ...STARTER, name: "Pro Plan" }).title, "Start the Pro Plan?");
});

test("a start sends back exactly the terms of the card that was pressed, and never its name", () => {
  assert.deepEqual(planTermsOf(STARTER), { id: "p1", priceCents: 900, includedUses: 500, extraUsePriceCents: 4 });
  assert.deepEqual(planTermsOf(STOPS), { id: "p2", priceCents: 500, includedUses: 100, extraUsePriceCents: null });
  assert.equal("name" in planTermsOf(STARTER), false);
});

test("only a plan whose every term is there becomes a card, and anything else reads as no plans", () => {
  assert.deepEqual(plansOf([STARTER, STOPS]), [STARTER, STOPS]);
  assert.deepEqual(plansOf(undefined), []);
  assert.deepEqual(plansOf(null), []);
  assert.deepEqual(plansOf("plans"), []);
  assert.deepEqual(plansOf({ 0: STARTER }), []);
  const broken = [
    null,
    "p1",
    { ...STARTER, id: "" },
    { ...STARTER, name: " " },
    { ...STARTER, priceCents: 0 },
    { ...STARTER, priceCents: "900" },
    { ...STARTER, includedUses: 0 },
    { ...STARTER, includedUses: 1.5 },
    { ...STARTER, extraUsePriceCents: 0 },
    // A plan that does not say what happens after its uses is not something to agree to.
    { id: "p9", name: "Half", priceCents: 900, includedUses: 500 },
  ];
  assert.deepEqual(plansOf([...broken, STOPS]), [STOPS]);
  // Field by field: whatever else an answer carries stays out of the card.
  assert.deepEqual(plansOf([{ ...STARTER, subscribers: 12, status: "active" }]), [STARTER]);
});

// ============================================
// The count while on a plan
// ============================================

test("on a plan: what is left and when it renews", () => {
  assert.equal(planCountLine({ plan: onPlan(), dates: UTC }), "312 of 500 uses left. Renews 12 Nov.");
});

test("at 85%: said so, with what is left and until when", () => {
  assert.equal(
    planCountLine({ plan: onPlan({ usedUses: 425, remainingUses: 75, warning: 85 }), dates: UTC }),
    "You have used 85% of your plan. 75 uses left until 12 Nov.",
  );
  assert.equal(
    planCountLine({ plan: onPlan({ usedUses: 499, remainingUses: 1, warning: 85 }), dates: UTC }),
    "You have used 85% of your plan. 1 use left until 12 Nov.",
  );
});

test("all used: the extra price from credits, or the day it starts again", () => {
  const gone = { usedUses: 500, remainingUses: 0, warning: 100 as const };
  assert.equal(
    planCountLine({ plan: onPlan(gone), dates: UTC }),
    "You have used all 500 uses. Each use is now $0.04 from your credits.",
  );
  const stops = planCountLine({ plan: onPlan({ ...gone, extraUsePriceCents: null }), dates: UTC });
  assert.equal(stops, "You have used all 500 uses. It starts again on 12 Nov.");
  // Moving up is not built: the line does not offer it.
  assert.doesNotMatch(stops, /move up/i);
  // None left reads as used up whatever the warning says.
  assert.equal(
    planCountLine({ plan: onPlan({ ...gone, warning: null, extraUsePriceCents: null }), dates: UTC }),
    "You have used all 500 uses. It starts again on 12 Nov.",
  );
  assert.equal(
    planCountLine({
      plan: onPlan({ includedUses: 1, usedUses: 1, remainingUses: 0, warning: 100, extraUsePriceCents: null }),
      dates: UTC,
    }),
    "You have used the 1 use in your plan. It starts again on 12 Nov.",
  );
});

test("a plan that will not renew says when it ends in place of when it renews", () => {
  const { resetsAt: _renews, ...ending } = onPlan();
  assert.equal(planCountLine({ plan: ending, endsAt: NOV_12, dates: UTC }), "312 of 500 uses left. Your plan ends on 12 Nov.");
  assert.equal(
    planCountLine({ plan: { ...ending, usedUses: 425, remainingUses: 75, warning: 85 }, endsAt: NOV_12, dates: UTC }),
    "You have used 85% of your plan. 75 uses left. Your plan ends on 12 Nov.",
  );
  const gone = { ...ending, usedUses: 500, remainingUses: 0, warning: 100 as const };
  assert.equal(
    planCountLine({ plan: { ...gone, extraUsePriceCents: null }, endsAt: NOV_12, dates: UTC }),
    "You have used all 500 uses. Your plan ends on 12 Nov.",
  );
  assert.equal(
    planCountLine({ plan: gone, endsAt: NOV_12, dates: UTC }),
    "You have used all 500 uses. Each use is now $0.04 from your credits. Your plan ends on 12 Nov.",
  );
  // No day in the answer: no day is made up, and no renewal is promised.
  assert.equal(planCountLine({ plan: ending, dates: UTC }), "312 of 500 uses left.");
  assert.equal(planCountLine({ plan: { ...gone, extraUsePriceCents: null }, dates: UTC }), "You have used all 500 uses.");
  for (const line of [planCountLine({ plan: ending, endsAt: NOV_12, dates: UTC }), planCountLine({ plan: ending, dates: UTC })]) {
    assert.doesNotMatch(line, /renews|starts again/i);
  }
});

test("while a renewal is being retried the count names no day, because the period's end is behind", () => {
  assert.equal(planCountLine({ plan: onPlan(), endsAt: NOV_12, pastDue: true, dates: UTC }), "312 of 500 uses left.");
  assert.equal(
    planCountLine({ plan: onPlan({ usedUses: 425, remainingUses: 75, warning: 85 }), pastDue: true, dates: UTC }),
    "You have used 85% of your plan. 75 uses left.",
  );
  assert.equal(
    planCountLine({
      plan: onPlan({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: null }),
      pastDue: true,
      dates: UTC,
    }),
    "You have used all 500 uses. It starts again when your plan renews.",
  );
});

test("the page's used-up sentences are the API's, without its closing words about the charge", () => {
  // PAID_USE_MESSAGES.planUsedUp and planUsedUpAndEnding in apps/api/src/services/paidUse.ts.
  const api = {
    usedUp: "You have used all 500 uses. It starts again on 12 Nov. Nothing was charged.",
    usedUpNoDay: "You have used all 500 uses. It starts again when your plan renews. Nothing was charged.",
    ending: "You have used all 500 uses. Your plan ends on 12 Nov. Nothing was charged.",
  };
  const gone = onPlan({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: null });
  const { resetsAt: _renews, ...ending } = gone;
  assert.equal(`${planCountLine({ plan: gone, dates: UTC })} Nothing was charged.`, api.usedUp);
  assert.equal(`${planCountLine({ plan: gone, pastDue: true, dates: UTC })} Nothing was charged.`, api.usedUpNoDay);
  assert.equal(`${planCountLine({ plan: ending, endsAt: NOV_12, dates: UTC })} Nothing was charged.`, api.ending);
});

test("a count is read only from an answer that carries one", () => {
  assert.equal(planCountOf(undefined), null);
  assert.equal(planCountOf(null), null);
  assert.equal(planCountOf("plan"), null);
  assert.equal(planCountOf({ includedUses: 500 }), null);
  assert.equal(planCountOf({ includedUses: 500, usedUses: "1", remainingUses: 499 }), null);
  assert.deepEqual(planCountOf(onPlan()), {
    includedUses: 500,
    usedUses: 188,
    remainingUses: 312,
    extraUsePriceCents: 4,
    resetsAt: NOV_12,
    warning: null,
  });
  // A warning this page does not know, and no time to start again: read as none, never thrown on.
  const odd = planCountOf({ includedUses: 500, usedUses: 1, remainingUses: 499, warning: 50 });
  assert.deepEqual(odd, { includedUses: 500, usedUses: 1, remainingUses: 499, extraUsePriceCents: null, warning: null });
});

// ============================================
// The page with plans
// ============================================

test("a listing with no plans is today's page: the same view, and nothing of plans", () => {
  const accesses: PaidUseAccess[] = [
    "none",
    "subscribed",
    "listing_pricing",
    "pricing_changed",
    "subscription_lapsed",
    "not_offered",
    "own_agent",
    "unlisted",
    "uninstalled",
    "plan_ended",
  ];
  const none = { cards: [], place: "none", canStart: false, askAdmin: null, payAsYouGo: null, countLine: null };
  for (const access of accesses) {
    for (const canAccept of [true, false]) {
      // An API that says nothing of plans, and one that says there are none.
      for (const said of [{ plans: undefined, plan: undefined }, { plans: [], plan: null }]) {
        const input = { authed: true, access: state(access, { canAccept, ...said }), page: PAGE, kind: "chat" as const, dates: UTC };
        const drawn = planGateView(input);
        assert.deepEqual(drawn.view, paidView(input), access);
        assert.deepEqual(drawn.plans, none, access);
      }
    }
  }
  const signedOut = { authed: false, access: null, page: PAGE, kind: "chat" as const };
  assert.deepEqual(planGateView(signedOut).view, paidView(signedOut));
  assert.deepEqual(planGateView(signedOut).plans, none);
});

test("an answer with plans that cannot be read draws today's page and does not throw", () => {
  for (const plans of [null, "x", 7, {}, [null], [{ id: "p1" }]]) {
    for (const plan of [undefined, null, "x", {}, { includedUses: "many" }]) {
      const access = state("subscribed", { plans, plan, subscription: SUB } as unknown as Partial<PaidUseAccessState>);
      const input = { authed: true, access, page: PAGE, kind: "chat" as const, dates: UTC };
      const drawn = planGateView(input);
      assert.deepEqual(drawn.view, paidView(input));
      assert.equal(drawn.plans.place, "none");
      assert.equal(drawn.plans.countLine, null);
    }
  }
});

test("signed out: the page's plans first, pay as you go after, and no start button", () => {
  const { view, plans } = gate(null);
  assert.equal(view.kind, "signed_out");
  assert.deepEqual(view.action, { kind: "signin", label: "Sign in" });
  assert.deepEqual(plans.cards, [STARTER, STOPS]);
  assert.equal(plans.place, "first");
  assert.equal(plans.canStart, false);
  assert.equal(plans.askAdmin, null);
  assert.equal(plans.payAsYouGo, "Or pay as you go: $0.05 a message");
});

test("not started: the plans first, then pay as you go with today's way of starting", () => {
  const { view, plans } = gate(state("none"));
  assert.equal(view.kind, "not_started");
  assert.deepEqual(view.action, { kind: "start", label: "Start using" });
  assert.deepEqual(plans.cards, [STARTER, STOPS]);
  assert.equal(plans.place, "first");
  assert.equal(plans.canStart, true);
  assert.equal(plans.payAsYouGo, "Or pay as you go: $0.05 a message");
  // A task agent's unit is a run.
  const task = gate(state("none", { terms: { ...PER_USE, unit: "run" } }), PAGE_WITH_PLANS, "task");
  assert.equal(task.plans.payAsYouGo, "Or pay as you go: $0.05 a run");
});

test("the plans of the access win over the page's, an empty list included", () => {
  const fresher = { ...STARTER, priceCents: 1200 };
  assert.deepEqual(gate(state("none", { plans: [fresher] })).plans.cards, [fresher]);
  assert.equal(gate(state("none", { plans: [] })).plans.place, "none");
  // An API that does not say: the page's are all there is to draw.
  assert.deepEqual(gate(state("none", { plans: undefined })).plans.cards, [STARTER, STOPS]);
});

test("someone who is not an owner or admin sees the cards with no button and is told to ask one, once", () => {
  const { view, plans } = gate(state("none", { canAccept: false }));
  assert.equal(view.kind, "ask_admin");
  assert.equal(view.sentence, "Ask an owner or admin of your organization to start this.");
  assert.equal(plans.place, "first");
  assert.equal(plans.canStart, false);
  // The page's sentence already says it.
  assert.equal(plans.askAdmin, null);
});

test("the agent's own owner and a start that is held back see the cards and can start none", () => {
  const own = gate(state("own_agent"));
  assert.equal(own.view.sentence, PAID_USE_MESSAGES.ownAgent);
  assert.equal(own.plans.place, "first");
  assert.equal(own.plans.canStart, false);
  assert.equal(own.plans.askAdmin, null);

  const blocked = { code: "copy_subscription_active" as const, message: "You hold a copy that is paid until 12 Nov.", until: NOV_12 };
  for (const access of ["none", "plan_ended"] as const) {
    const held = gate(state(access, { startBlocked: blocked, canAccept: false }));
    assert.equal(held.view.kind, "start_blocked", access);
    assert.equal(held.view.sentence, blocked.message, access);
    assert.equal(held.view.action.kind, "none", access);
    assert.equal(held.plans.canStart, false, access);
    assert.equal(held.plans.askAdmin, null, access);
  }
  // Even an answer that says both: a start that is held back starts no plan.
  assert.equal(gate(state("none", { startBlocked: blocked, canAccept: true })).plans.canStart, false);
});

test("a plan that ended: its sentence, the cards, and pay as you go", () => {
  const { view, plans } = gate(state("plan_ended"));
  assert.equal(view.kind, "plan_ended");
  assert.equal(view.sentence, "Your plan ended. Choose a plan or pay per use to keep using it.");
  assert.equal(view.usable, false);
  assert.deepEqual(view.action, { kind: "start", label: "Start using" });
  assert.equal(view.dialog?.confirmLabel, "Start at $0.05 per message");
  assert.equal(view.acceptNewPricing, false);
  assert.deepEqual(plans.cards, [STARTER, STOPS]);
  assert.equal(plans.place, "first");
  assert.equal(plans.canStart, true);
  assert.equal(plans.payAsYouGo, "Or pay as you go: $0.05 a message");

  const member = gate(state("plan_ended", { canAccept: false }));
  assert.equal(
    member.view.sentence,
    "Your plan ended. Choose a plan or pay per use to keep using it. Ask an owner or admin of your organization to start this.",
  );
  assert.equal(member.view.action.kind, "none");
  assert.equal(member.plans.place, "first");
  assert.equal(member.plans.canStart, false);
  assert.equal(member.plans.askAdmin, null);

  // The listing left the market in between: nothing to choose.
  const gone = gate(state("plan_ended", { terms: null, plans: [] }));
  assert.equal(gone.view.kind, "not_offered");
  assert.equal(gone.plans.place, "none");
  // With no plans left there is still the price per use.
  const perUseOnly = gate(state("plan_ended", { plans: [] }));
  assert.equal(perUseOnly.view.sentence, PAID_USE_MESSAGES.planEnded);
  assert.equal(perUseOnly.plans.payAsYouGo, null);
  assert.deepEqual(perUseOnly.view.action, { kind: "start", label: "Start using" });
});

test("a view of an ended plan held against a send reads as its sentence", () => {
  const notice = noticeOfView(paidView({ authed: true, access: state("plan_ended"), page: PAGE, kind: "chat" }));
  assert.equal(notice.code, "plan_ended");
  assert.equal(notice.message, "Your plan ended. Choose a plan or pay per use to keep using it.");
});

test("someone who already pays per use finds the plans behind See plans", () => {
  const accepted = { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null };
  const { view, plans } = gate(state("listing_pricing", { accepted }));
  assert.equal(view.kind, "in_use");
  assert.equal(view.sentence, "$0.05 per message. Your credits: $4.95.");
  assert.equal(plans.place, "behind");
  assert.deepEqual(plans.cards, [STARTER, STOPS]);
  assert.equal(plans.canStart, true);
  assert.equal(plans.payAsYouGo, null);
  assert.equal(plans.askAdmin, null);

  const member = gate(state("listing_pricing", { accepted, canAccept: false }));
  assert.equal(member.plans.place, "behind");
  assert.equal(member.plans.canStart, false);
  assert.equal(member.plans.askAdmin, "Ask an owner or admin of your organization to start this.");

  // A price per use that moved: the same, beside the price to accept.
  const moved = gate(state("pricing_changed", { accepted, terms: { ...PER_USE, pricePerRequestCents: 8 } }));
  assert.equal(moved.view.kind, "price_changed");
  assert.equal(moved.plans.place, "behind");
  assert.equal(moved.plans.canStart, true);
});

test("on a plan: no cards, and the count is the page's sentence", () => {
  const { view, plans } = gate(state("subscribed", { plan: onPlan(), subscription: SUB, accepted: { pricingModel: null, pricePerRequestCents: null, monthlyPriceCents: 900 } }));
  assert.equal(view.kind, "in_use");
  assert.equal(view.usable, true);
  assert.equal(view.sentence, "312 of 500 uses left. Renews 12 Nov.");
  assert.equal(view.action.kind, "none");
  assert.deepEqual(plans.cards, []);
  assert.equal(plans.place, "none");
  assert.equal(plans.canStart, false);
  assert.equal(plans.payAsYouGo, null);
  assert.equal(plans.countLine, null);
  // Nothing of a month, which a plan is not sold by.
  assert.doesNotMatch(view.sentence, /a month|subscribed/);
});

test("on a plan that will not renew: when it ends, from the subscription's period in the same answer", () => {
  const { resetsAt: _renews, ...ending } = onPlan();
  // The buyer cancelled the renewal.
  const cancelled = gate(state("subscribed", { plan: ending, subscription: { ...SUB, cancelAtPeriodEnd: true } }));
  assert.equal(cancelled.view.sentence, "312 of 500 uses left. Your plan ends on 12 Nov.");
  // The creator ended the plan: nothing in the subscription says so, only the missing time.
  const retired = gate(state("subscribed", { plan: ending, subscription: SUB }));
  assert.equal(retired.view.sentence, "312 of 500 uses left. Your plan ends on 12 Nov.");
  // The listing left the market: the same, and never a renewal.
  const unlisted = gate(state("subscribed", { plan: ending, subscription: SUB, terms: null, plans: [] }));
  assert.equal(unlisted.view.sentence, "312 of 500 uses left. Your plan ends on 12 Nov.");
});

test("a listing that no longer sells use: past the count the plan stops, and no extra price is named", () => {
  // The buyer's row still holds the extra price it agreed to. The API sells no extra use now and refuses
  // the next one: "You have used all 500 uses. Your plan ends on 12 Nov. Nothing was charged."
  const { resetsAt: _renews, ...ending } = onPlan({ usedUses: 500, remainingUses: 0, warning: 100 });
  assert.equal(ending.extraUsePriceCents, 4);
  const unlisted = gate(state("subscribed", { plan: ending, subscription: SUB, terms: null, plans: [] }));
  assert.equal(unlisted.view.sentence, "You have used all 500 uses. Your plan ends on 12 Nov.");
  assert.doesNotMatch(unlisted.view.sentence, /credits|\$/);
  // Still on sale: the extra price is said.
  const listed = gate(state("subscribed", { plan: ending, subscription: SUB }));
  assert.equal(
    listed.view.sentence,
    "You have used all 500 uses. Each use is now $0.04 from your credits. Your plan ends on 12 Nov.",
  );
});

test("a plan's days are the API's days, whatever zone the page is read in", () => {
  // 01:00 UTC on 12 Nov is still 11 Nov in New York. The API's sentence says 12 Nov, and so does the line.
  const early = "2026-11-12T01:00:00.000Z";
  const inNewYork = (access: PaidUseAccessState) =>
    planGateView({ authed: true, access, page: PAGE_WITH_PLANS, kind: "chat", dates: { timeZone: "America/New_York" } });
  const sub = { ...SUB, currentPeriodEnd: early };
  assert.equal(
    inNewYork(state("subscribed", { plan: onPlan({ resetsAt: early }), subscription: sub })).view.sentence,
    "312 of 500 uses left. Renews 12 Nov.",
  );
  assert.equal(
    inNewYork(
      state("subscribed", {
        plan: onPlan({ resetsAt: early, usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: null }),
        subscription: sub,
      }),
    ).view.sentence,
    "You have used all 500 uses. It starts again on 12 Nov.",
  );
  const { resetsAt: _renews, ...ending } = onPlan();
  assert.equal(
    inNewYork(state("subscribed", { plan: ending, subscription: sub })).view.sentence,
    "312 of 500 uses left. Your plan ends on 12 Nov.",
  );
});

test("a renewal that did not go through keeps the page's sentence and action, and the count beside it", () => {
  const { view, plans } = gate(
    state("subscribed", {
      plan: onPlan(),
      subscription: { ...SUB, status: "past_due", graceEndsAt: "2026-11-15T09:00:00.000Z" },
      accepted: { pricingModel: null, pricePerRequestCents: null, monthlyPriceCents: 900 },
    }),
  );
  assert.equal(view.sentence, "Your renewal of $9.00 did not go through. Add credits before 15 Nov to keep access.");
  assert.deepEqual(view.action, { kind: "add_credits", label: "Add credits" });
  assert.equal(view.usable, true);
  assert.equal(plans.countLine, "312 of 500 uses left.");
  assert.equal(plans.place, "none");
});

test("today's monthly subscriber reads exactly as before, whatever plans the answer names", () => {
  const input = {
    authed: true,
    access: state("subscribed", {
      plan: null,
      subscription: SUB,
      accepted: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900 },
    }),
    page: PAGE_WITH_PLANS,
    kind: "chat" as const,
    dates: UTC,
  };
  const { view, plans } = planGateView(input);
  assert.deepEqual(view, paidView(input));
  assert.equal(view.sentence, "You are subscribed. Renews 12 Nov at $9.00 a month.");
  assert.equal(plans.place, "none");
  assert.equal(plans.countLine, null);
});

test("no plan is offered where none can be chosen", () => {
  assert.equal(gate(state("not_offered")).plans.place, "none");
  assert.equal(gate(state("unlisted")).plans.place, "none");
  assert.equal(gate(state("subscription_lapsed")).plans.place, "none");
  assert.equal(gate(state("none", { terms: null })).plans.place, "none");
});

// ============================================
// After a use, and after a refusal
// ============================================

const billed = (plan: PaidUseBilling["plan"], chargedCents = 0): PaidUseBilling => ({
  chargedCents,
  balanceCents: 495,
  access: "subscribed",
  ...(plan && { plan }),
});

test("under an answer on a plan: included, or what the extra use was charged", () => {
  const plan = {
    id: "p1",
    includedUses: 500,
    carriedUses: 0,
    usedUses: 189,
    remainingUses: 311,
    extraUsePriceCents: 4,
    resetsAt: NOV_12,
    warning: null,
  };
  assert.equal(chargeLine(billed({ ...plan, use: "included" }), "message"), "Included in your plan.");
  assert.equal(
    chargeLine(billed({ ...plan, use: "extra", usedUses: 500, remainingUses: 0, warning: 100 }, 4), "message"),
    "Charged $0.04.",
  );
  // What was charged is the answer's own number, not the plan's price read again.
  assert.equal(chargeLine(billed({ ...plan, use: "extra" }, 6), "run"), "Charged $0.06.");
  // Today's lines stay what they are.
  assert.equal(chargeLine(billed(undefined), "message"), "Included in your subscription.");
  assert.equal(
    chargeLine({ chargedCents: 5, balanceCents: 490, access: "listing_pricing" }, "message"),
    "This message cost $0.05. Your credits: $4.90.",
  );
  assert.equal(PAID_USE_MESSAGES.includedInPlan, "Included in your plan.");
});

test("the count is drawn again from the answer's billing, with no read of its own", () => {
  const before = state("subscribed", { plan: onPlan(), subscription: SUB });
  const after = accessAfterUse(
    before,
    billed({
      id: "p1",
      use: "included",
      includedUses: 500,
      carriedUses: 0,
      usedUses: 425,
      remainingUses: 75,
      extraUsePriceCents: 4,
      resetsAt: NOV_12,
      warning: 85,
    }),
  );
  assert.equal(gate(after).view.sentence, "You have used 85% of your plan. 75 uses left until 12 Nov.");
  assert.equal(after?.plan?.name, "Starter");
  assert.equal(after?.balanceCents, before.balanceCents);

  const last = accessAfterUse(
    after,
    billed({ id: "p1", use: "included", includedUses: 500, carriedUses: 0, usedUses: 500, remainingUses: 0, extraUsePriceCents: 4, resetsAt: NOV_12, warning: 100 }),
  );
  assert.equal(gate(last).view.sentence, "You have used all 500 uses. Each use is now $0.04 from your credits.");

  // A plan that will not renew: the billing leaves the time out, and the line says when the plan ends.
  const ending = accessAfterUse(
    before,
    billed({ id: "p1", use: "included", includedUses: 500, carriedUses: 0, usedUses: 189, remainingUses: 311, extraUsePriceCents: 4, warning: null }),
  );
  assert.equal(ending?.plan?.resetsAt, undefined);
  assert.equal(gate(ending).view.sentence, "311 of 500 uses left. Your plan ends on 12 Nov.");

  // An answer with no plan, or one that cannot be read, changes nothing.
  assert.equal(accessAfterUse(before, billed(undefined)), before);
  assert.equal(accessAfterUse(before, null), before);
  assert.equal(accessAfterUse(before, { chargedCents: 0, balanceCents: 1, access: "subscribed", plan: {} } as unknown as PaidUseBilling), before);
  assert.equal(accessAfterUse(null, billed(undefined)), null);
});

const refusal = (error: string, extra: Partial<PaidUseRefusal> = {}): PaidUseRefusal => ({ error, message: "", ...extra });

test("a plan that is used up: the API's sentence as it comes, and the line moves to used up", () => {
  const said = "You have used all 500 uses. It starts again on 12 Nov. Nothing was charged.";
  const notice = paidRefusalNotice({
    status: 429,
    refusal: refusal("plan_used_up", { message: said, resetsAt: NOV_12, retryAfterSeconds: 86_400, plans: [STARTER] }),
    act: "chat",
    unit: "message",
  });
  assert.equal(notice.message, said);
  assert.equal(notice.action.kind, "wait");
  assert.equal(notice.action.label, null);

  const before = state("subscribed", {
    plan: onPlan({ usedUses: 499, remainingUses: 1, warning: 85, extraUsePriceCents: null }),
    subscription: SUB,
  });
  const after = accessAfterRefusal(before, refusal("plan_used_up", { message: said, resetsAt: NOV_12 }));
  assert.equal(gate(after).view.sentence, "You have used all 500 uses. It starts again on 12 Nov.");
  assert.equal(after?.access, "subscribed");
  assert.deepEqual(after?.plan, {
    id: "p1",
    name: "Starter",
    includedUses: 500,
    usedUses: 500,
    remainingUses: 0,
    extraUsePriceCents: null,
    resetsAt: NOV_12,
    warning: 100,
  });

  // The refusal names no time: the plan will not renew, and the line says when it ends.
  const ending = accessAfterRefusal(before, refusal("plan_used_up", { message: "x" }));
  assert.equal(ending?.plan?.resetsAt, undefined);
  assert.equal(gate(ending).view.sentence, "You have used all 500 uses. Your plan ends on 12 Nov.");
  // A plan with an extra price that is refused this way sells no extra use now: the line names no charge.
  const withExtra = state("subscribed", { plan: onPlan({ usedUses: 500, remainingUses: 0, warning: 100 }), subscription: SUB });
  const stopped = accessAfterRefusal(withExtra, refusal("plan_used_up", { message: "x" }));
  assert.equal(stopped?.plan?.extraUsePriceCents, null);
  assert.equal(gate(stopped).view.sentence, "You have used all 500 uses. Your plan ends on 12 Nov.");
  // No plan held to move: nothing is made up.
  const bare = state("subscribed", { plan: null, subscription: SUB });
  assert.equal(accessAfterRefusal(bare, refusal("plan_used_up"))?.plan, null);
});

test("a plan that ended on a use: its sentence, and the page goes back to choosing from the refusal", () => {
  const said = "Your plan ended. Choose a plan or pay per use to keep using it.";
  const notice = paidRefusalNotice({ status: 402, refusal: refusal("plan_ended", { message: said }), act: "chat", unit: "message" });
  assert.equal(notice.message, said);
  assert.equal(notice.action.kind, "none");
  assert.equal(PAID_REFUSAL_RULES.plan_ended?.fallback, said);

  const before = state("subscribed", { plan: onPlan(), subscription: SUB, plans: [STARTER, STOPS] });
  const newer = { ...STARTER, priceCents: 1200 };
  const after = accessAfterRefusal(
    before,
    refusal("plan_ended", { message: said, plans: [newer], terms: { ...PER_USE, pricePerRequestCents: 8 } }),
  );
  const { view, plans } = gate(after);
  assert.equal(view.kind, "plan_ended");
  assert.equal(view.sentence, said);
  assert.deepEqual(plans.cards, [newer]);
  assert.equal(plans.place, "first");
  assert.equal(plans.payAsYouGo, "Or pay as you go: $0.08 a message");
  assert.equal(after?.plan, null);

  // A refusal that names neither keeps what the page held.
  const kept = accessAfterRefusal(before, refusal("plan_ended", { message: said }));
  assert.deepEqual(kept?.plans, [STARTER, STOPS]);
  assert.deepEqual(kept?.terms, PER_USE);
});

test("any other refusal, and no refusal, leave the access as it was", () => {
  const before = state("subscribed", { plan: onPlan(), subscription: SUB });
  for (const code of ["rate_limited", "insufficient_credits", "already_on_plan", "pricing_changed", "model_error"]) {
    assert.equal(accessAfterRefusal(before, refusal(code)), before, code);
  }
  assert.equal(accessAfterRefusal(before, null), before);
  assert.equal(accessAfterRefusal(null, refusal("plan_ended")), null);
});

// ============================================
// A start that was refused
// ============================================

test("plans that changed under a start: the API's sentence, the cards drawn again, and nothing to accept", () => {
  const said = 'The plans of "Support Bot" are not what you were shown. Nothing was charged. Look at them again and choose.';
  const newer = { ...STARTER, priceCents: 1200 };
  const changed = refusal("pricing_changed", {
    message: said,
    plans: [newer],
    pricing: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null },
  });
  const notice = planStartNotice({ status: 409, refusal: changed, unit: "message" });
  assert.equal(notice.code, "pricing_changed");
  assert.equal(notice.message, said);
  assert.deepEqual(notice.action, { kind: "none", label: null });
  assert.equal(notice.price, null);
  // With no sentence from the API the page has its own, and it says nothing was charged.
  assert.equal(
    planStartNotice({ status: 409, refusal: { ...changed, message: "" }, unit: "message" }).message,
    "The plans are not what you were shown. Nothing was charged. Look at them again and choose.",
  );

  const before = state("none");
  const after = accessAfterRefusal(before, changed);
  assert.deepEqual(gate(after).plans.cards, [newer]);
  // The listing no longer has plans: the cards go, and pay as you go is today's page.
  const none = accessAfterRefusal(before, { ...changed, plans: [] });
  assert.equal(gate(none).plans.place, "none");
  assert.deepEqual(gate(none).view.action, { kind: "start", label: "Start using" });
});

test("already on a plan, and not enough credits for one: the API's sentence and the one thing to do", () => {
  const running = "You already have a plan or a subscription for this agent that is still running. Nothing was charged.";
  const already = planStartNotice({ status: 409, refusal: refusal("already_on_plan", { message: running }), unit: "message" });
  assert.equal(already.message, running);
  assert.equal(already.action.kind, "none");
  assert.equal(PAID_REFUSAL_RULES.already_on_plan?.fallback, running);
  assert.equal(planStartNotice({ status: 409, refusal: refusal("already_on_plan"), unit: "message" }).message, running);

  const short = "You do not have enough credits for this plan ($9.00 for 30 days). Nothing was charged. Add credits to continue.";
  const credits = planStartNotice({
    status: 402,
    refusal: refusal("insufficient_credits", { message: short, requiredCents: 900 }),
    unit: "message",
  });
  assert.equal(credits.message, short);
  assert.deepEqual(credits.action, { kind: "add_credits", label: "Add credits" });
});

test("any other refused start of a plan reads as a refused start does today", () => {
  for (const code of ["listing_paused", "own_agent", "copy_subscription_active", "subscription_claim_lost", "listing_not_found", "not_offered"]) {
    const sent = refusal(code, { message: "The API said this." });
    assert.deepEqual(
      planStartNotice({ status: 409, refusal: sent, unit: "message" }),
      paidRefusalNotice({ status: 409, refusal: sent, act: "start", unit: "message" }),
      code,
    );
  }
  assert.equal(planStartNotice({ status: 0, refusal: null, unit: "message" }).message, PAID_USE_MESSAGES.offline);
  assert.deepEqual(planStartNotice({ status: 401, refusal: null, unit: "message" }).action, { kind: "signin", label: "Sign in" });
});

// ============================================
// What is never said
// ============================================

test("no sentence of a plan has an em dash, a raw code, or a word about what the buyer is never told", () => {
  const gone = onPlan({ usedUses: 500, remainingUses: 0, warning: 100 });
  const { resetsAt: _renews, ...ending } = onPlan();
  const said = [
    ...Object.values(USE_PLAN_WORDS),
    PAID_USE_MESSAGES.includedInPlan,
    PAID_USE_MESSAGES.planEnded,
    PAID_REFUSAL_RULES.plan_used_up!.fallback,
    PAID_REFUSAL_RULES.plan_ended!.fallback,
    PAID_REFUSAL_RULES.already_on_plan!.fallback,
    planPriceLine(STARTER),
    planUsesLine(STARTER),
    planAfterLine(STARTER),
    planAfterLine(STOPS),
    payAsYouGoLine({ model: "per_request", cents: 5, unit: "message" })!,
    ...Object.values(planStartDialog(STARTER)),
    ...Object.values(planStartDialog(STOPS)),
    planCountLine({ plan: onPlan(), dates: UTC }),
    planCountLine({ plan: onPlan({ usedUses: 425, remainingUses: 75, warning: 85 }), dates: UTC }),
    planCountLine({ plan: gone, dates: UTC }),
    planCountLine({ plan: { ...gone, extraUsePriceCents: null }, dates: UTC }),
    planCountLine({ plan: ending, endsAt: NOV_12, dates: UTC }),
  ];
  for (const sentence of said) {
    assert.equal(/[\u2013\u2014]/.test(sentence), false, sentence);
    assert.doesNotMatch(sentence, /plan_ended|plan_used_up|already_on_plan|pricing_changed/, sentence);
    assert.doesNotMatch(sentence, /token|model|organization|unlimited|subscriber|trial|move up/i, sentence);
    assert.doesNotMatch(sentence, /undefined|null|NaN/, sentence);
  }
});

// ============================================
// Moving up to a bigger plan
// ============================================

const PRO: PlanOffer = { id: "p3", name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: 3 };
const OFFERED = [STOPS, STARTER, PRO];
/** What the access says of someone on Starter: the price they agreed to is the subscription's own. */
const AGREED_STARTER = { pricingModel: null, pricePerRequestCents: null, monthlyPriceCents: 900 };

const onStarter = (extra: Partial<PaidUseAccessState> = {}, plan: Partial<PaidUsePlan> = {}) =>
  state("subscribed", { plans: OFFERED, plan: onPlan(plan), accepted: AGREED_STARTER, subscription: SUB, ...extra });
const page = (access: PaidUseAccessState | null) =>
  planPageView({ authed: access !== null, access, page: PAGE_WITH_PLANS, kind: "chat", dates: UTC });

test("the words of moving up", () => {
  assert.equal(MOVE_UP_WORDS.seeBigger, "See bigger plans");
  assert.equal(MOVE_UP_WORDS.hideBigger, "Hide bigger plans");
  assert.equal(MOVE_UP_WORDS.button, "Move up");
  // The API's own sentences (PLAN_MOVE_MESSAGES in apps/api/src/services/planMove.ts).
  assert.equal(MOVE_UP_WORDS.notOnPlan, "You are not on a plan. Start one first.");
  assert.equal(MOVE_UP_WORDS.samePlan, "You are already on this plan. Nothing was charged.");
  assert.equal(MOVE_UP_WORDS.notBigger, "To move to a smaller plan, cancel the renewal and choose it when your plan ends.");
});

test("a bigger plan costs more than the price agreed to, and is never the plan the person is on", () => {
  assert.deepEqual(biggerPlans(OFFERED, { id: "p1", agreedCents: 900 }), [PRO]);
  assert.deepEqual(biggerPlans(OFFERED, { id: "p2", agreedCents: 500 }), [STARTER, PRO]);
  assert.deepEqual(biggerPlans(OFFERED, { id: "p3", agreedCents: 2900 }), []);
  // The price agreed to decides, not the plan's price now: Starter was $12.00 when this person started it.
  assert.deepEqual(biggerPlans(OFFERED, { id: "p1", agreedCents: 1200 }), [PRO]);
  // Their own plan at a higher price now is not a move.
  assert.deepEqual(biggerPlans(OFFERED, { id: "p1", agreedCents: 700 }), [PRO]);
  // A plan at the same price is not bigger.
  assert.deepEqual(biggerPlans([{ ...PRO, priceCents: 900 }], { id: "p1", agreedCents: 900 }), []);
  // A plan that was ended since is no longer in the list, and the others still count.
  assert.deepEqual(biggerPlans([STOPS, PRO], { id: "p1", agreedCents: 900 }), [PRO]);
  // With no agreed price known nothing is offered.
  assert.deepEqual(biggerPlans(OFFERED, { id: "p1", agreedCents: null }), []);
  assert.deepEqual(biggerPlans(OFFERED, { id: "p1", agreedCents: undefined }), []);
  assert.deepEqual(biggerPlans([], { id: "p1", agreedCents: 900 }), []);
});

test("a move carries the uses that are left, and at most what the plan being left included", () => {
  assert.equal(carriedOnMove({ includedUses: 500, remainingUses: 188 }), 188);
  assert.equal(carriedOnMove({ includedUses: 500, remainingUses: 500 }), 500);
  // Uses carried by an earlier move are not carried again: 500 included, 120 brought in, 30 used.
  assert.equal(carriedOnMove({ includedUses: 500, remainingUses: 590 }), 500);
  assert.equal(carriedOnMove({ includedUses: 500, remainingUses: 0 }), 0);
  assert.equal(carriedOnMove({ includedUses: 500, remainingUses: -3 }), 0);
  assert.equal(carriedOnMove({ includedUses: 500, remainingUses: Number.NaN }), 0);
});

test("the dialog of a move says the new 30 days, the charge, and the uses that come along", () => {
  assert.deepEqual(planMoveDialog(PRO, 188), {
    title: "Move up to the Pro plan?",
    body: "Starts a new 30 days today and charges $29.00 from your credits. The 188 uses you have left are added to it.",
    confirmLabel: "Move up for $29.00",
  });
  // Nothing left: the second sentence is left out.
  assert.equal(planMoveDialog(PRO, 0).body, "Starts a new 30 days today and charges $29.00 from your credits.");
  assert.equal(
    planMoveDialog(PRO, 1).body,
    "Starts a new 30 days today and charges $29.00 from your credits. The 1 use you have left is added to it.",
  );
  assert.equal(planMoveDialog({ ...PRO, name: "Pro plan" }, 0).title, "Move up to the Pro plan?");
});

test("the dialog of a move says both numbers when fewer uses come along than are left", () => {
  const start = "Starts a new 30 days today and charges $29.00 from your credits.";
  // After an earlier move: the count line reads 590 left, and only the 500 the plan included are carried.
  assert.equal(planMoveDialog(PRO, 500, 590).body, `${start} 500 of the 590 uses you have left are added to it.`);
  assert.equal(planMoveDialog(PRO, 1, 5).body, `${start} 1 of the 5 uses you have left is added to it.`);
  // All that is left comes along: the design's sentence, word for word.
  assert.equal(planMoveDialog(PRO, 188, 188).body, `${start} The 188 uses you have left are added to it.`);
  assert.equal(planMoveDialog(PRO, 188).body, planMoveDialog(PRO, 188, 188).body);
  assert.equal(planMoveDialog(PRO, 1, 1).body, `${start} The 1 use you have left is added to it.`);
  assert.equal(planMoveDialog(PRO, 0, 0).body, start);
  // The page hands the dialog both numbers.
  const after = page(onStarter({}, { carriedUses: 120, usedUses: 30, remainingUses: 590 }));
  assert.equal(after.view.sentence, "590 of 620 uses left. Renews 12 Nov.");
  assert.equal(after.moveUp?.carriedUses, 500);
  assert.equal(after.moveUp?.leftUses, 590);
});

test("a press on a bigger plan is measured against the page as it was read again at that press", () => {
  // A teammate used 12 since the page loaded: the dialog is made from the 300 of the new read.
  const fresh = page(onStarter({}, { usedUses: 200, remainingUses: 300 })).moveUp;
  assert.deepEqual(planMoveNow(fresh, PRO), { card: PRO, carriedUses: 300, leftUses: 300 });
  assert.equal(
    planMoveDialog(PRO, 300, 300).body,
    "Starts a new 30 days today and charges $29.00 from your credits. The 300 uses you have left are added to it.",
  );
  // The card held is the one of the new read, not the object that was pressed.
  assert.equal(planMoveNow(fresh, { ...PRO })?.card, fresh?.cards[0]);
  // Any term that is no longer what was shown opens nothing.
  for (const changed of [
    { ...PRO, priceCents: PRO.priceCents + 100 },
    { ...PRO, includedUses: PRO.includedUses + 1 },
    { ...PRO, extraUsePriceCents: PRO.extraUsePriceCents === null ? 4 : null },
    { ...PRO, id: "another" },
  ]) {
    assert.equal(planMoveNow(fresh, changed), null);
  }
  // Nobody who can no longer move, and nobody the new read offers nothing bigger.
  assert.equal(planMoveNow(page(onStarter({ canAccept: false })).moveUp, PRO), null);
  assert.equal(planMoveNow(page(onStarter({ plans: [STARTER] })).moveUp, PRO), null);
  assert.equal(planMoveNow(null, PRO), null);
});

test("a plan that is used up and stops says 'or move up now' only when asked to", () => {
  const gone = onPlan({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: null });
  assert.equal(
    planCountLine({ plan: gone, moveUp: true, dates: UTC }),
    "You have used all 500 uses. It starts again on 12 Nov, or move up now.",
  );
  assert.equal(planCountLine({ plan: gone, dates: UTC }), "You have used all 500 uses. It starts again on 12 Nov.");
  assert.equal(
    planCountLine({ plan: gone, moveUp: true, pastDue: true, dates: UTC }),
    "You have used all 500 uses. It starts again when your plan renews, or move up now.",
  );
  // Every other line is what it is without it: uses are left, an extra use has a price, or the plan will not renew.
  const { resetsAt: _renews, ...ending } = gone;
  const others = [
    { plan: onPlan() },
    { plan: onPlan({ usedUses: 425, remainingUses: 75, warning: 85 as const }) },
    { plan: onPlan({ usedUses: 500, remainingUses: 0, warning: 100 as const }) },
    { plan: ending, endsAt: NOV_12 },
  ];
  for (const input of others) {
    assert.equal(planCountLine({ ...input, moveUp: true, dates: UTC }), planCountLine({ ...input, dates: UTC }));
  }
});

test("someone on a plan is offered the bigger plans, with what a move would carry", () => {
  const { view, plans, moveUp } = page(onStarter());
  assert.deepEqual(moveUp, { cards: [PRO], canMove: true, askAdmin: null, carriedUses: 312, leftUses: 312 });
  // The rest of the page is planGateView's: the count as its sentence, and no card to start.
  assert.equal(view.sentence, "312 of 500 uses left. Renews 12 Nov.");
  assert.deepEqual({ view, plans }, gate(onStarter()));
  assert.equal(plans.place, "none");
  // After an earlier move: 500 included, 120 brought in, 30 used. At most the 500 are carried.
  assert.equal(page(onStarter({}, { carriedUses: 120, usedUses: 30, remainingUses: 590 })).moveUp?.carriedUses, 500);
});

test("the used-up line of a plan that stops ends with 'or move up now' when a bigger plan is on offer", () => {
  const gone = { usedUses: 500, remainingUses: 0, warning: 100 as const, extraUsePriceCents: null };
  const drawn = page(onStarter({}, gone));
  assert.equal(drawn.view.sentence, "You have used all 500 uses. It starts again on 12 Nov, or move up now.");
  assert.equal(drawn.moveUp?.carriedUses, 0);
  // No bigger plan on offer: the line is what it is today.
  const top = page(onStarter({ plans: [STOPS, STARTER] }, gone));
  assert.equal(top.moveUp, null);
  assert.equal(top.view.sentence, "You have used all 500 uses. It starts again on 12 Nov.");
  // While a renewal is retried the page's sentence stays, and the line beside it says it.
  const pastDue = page(onStarter({ subscription: { ...SUB, status: "past_due", graceEndsAt: "2026-11-15T09:00:00.000Z" } }, gone));
  assert.equal(pastDue.view.sentence, "Your renewal of $9.00 did not go through. Add credits before 15 Nov to keep access.");
  assert.equal(pastDue.plans.countLine, "You have used all 500 uses. It starts again when your plan renews, or move up now.");
  assert.deepEqual(pastDue.moveUp?.cards, [PRO]);
});

test("someone who may not start a plan reads the bigger plans, is told to ask once, and is not told to move up", () => {
  const gone = { usedUses: 500, remainingUses: 0, warning: 100 as const, extraUsePriceCents: null };
  const member = page(onStarter({ canAccept: false }, gone));
  assert.deepEqual(member.moveUp, { cards: [PRO], canMove: false, askAdmin: PAID_USE_MESSAGES.askAdmin, carriedUses: 0, leftUses: 0 });
  assert.equal(member.view.sentence, "You have used all 500 uses. It starts again on 12 Nov.");
  assert.equal(member.plans.askAdmin, null, "said once, with the bigger plans");
});

test("nobody else is offered a move, and their page is planGateView's", () => {
  const others: Array<PaidUseAccessState | null> = [
    null,
    state("none"),
    state("listing_pricing"),
    state("plan_ended"),
    state("pricing_changed"),
    state("own_agent"),
    // A paid month with no count: the listing of such a subscriber has no plans, and no plan is held.
    state("subscribed", { plans: OFFERED, accepted: AGREED_STARTER, subscription: SUB }),
    // On the biggest plan.
    onStarter({ plan: onPlan({ id: "p3", name: "Pro" }), accepted: { ...AGREED_STARTER, monthlyPriceCents: 2900 } }),
    // The listing no longer offers plans.
    onStarter({ plans: [] }),
    // The price agreed to is not known.
    onStarter({ accepted: null }),
  ];
  for (const access of others) {
    const drawn = page(access);
    assert.equal(drawn.moveUp, null, access?.access);
    const { moveUp: _none, ...rest } = drawn;
    assert.deepEqual(rest, gate(access), access?.access);
  }
});

test("a refused move reads as a refused start, and its own refusals say the API's sentence", () => {
  const changed = refusal("pricing_changed", { message: "The plans were changed. Nothing was charged.", plans: [PRO] });
  assert.deepEqual(
    planMoveNotice({ status: 409, refusal: changed, unit: "message" }),
    planStartNotice({ status: 409, refusal: changed, unit: "message" }),
  );
  const short = refusal("insufficient_credits", { message: "You need $29.00 in credits. Nothing was charged.", requiredCents: 2900 });
  const noCredits = planMoveNotice({ status: 402, refusal: short, unit: "message" });
  assert.equal(noCredits.message, "You need $29.00 in credits. Nothing was charged.");
  assert.deepEqual(noCredits.action, { kind: "add_credits", label: "Add credits" });

  const own: Array<[string, string]> = [
    ["not_on_plan", MOVE_UP_WORDS.notOnPlan],
    ["same_plan", MOVE_UP_WORDS.samePlan],
    ["not_a_bigger_plan", MOVE_UP_WORDS.notBigger],
  ];
  for (const [code, words] of own) {
    const bare = planMoveNotice({ status: 409, refusal: refusal(code), unit: "message" });
    assert.equal(bare.message, words, code);
    assert.deepEqual(bare.action, { kind: "none", label: null }, code);
    assert.equal(planMoveNotice({ status: 409, refusal: refusal(code, { message: "As the API said it." }), unit: "message" }).message, "As the API said it.");
  }
  // A move that lost its claim to a renewal, a use or another move.
  const lost = planMoveNotice({ status: 409, refusal: refusal("subscription_claim_lost"), unit: "message" });
  assert.equal(lost.message, PAID_REFUSAL_RULES.subscription_claim_lost!.fallback);
  assert.equal(planMoveNotice({ status: 0, refusal: null, unit: "message" }).message, PAID_USE_MESSAGES.offline);
});

test("no sentence of moving up has an em dash, a raw code, or a word about what the buyer is never told", () => {
  const gone = onPlan({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: null });
  const said = [
    ...Object.values(MOVE_UP_WORDS),
    ...Object.values(planMoveDialog(PRO, 188)),
    ...Object.values(planMoveDialog(PRO, 0)),
    planCountLine({ plan: gone, moveUp: true, dates: UTC }),
  ];
  for (const sentence of said) {
    assert.equal(/[\u2013\u2014]/.test(sentence), false, sentence);
    assert.doesNotMatch(sentence, /not_on_plan|same_plan|not_a_bigger_plan|pricing_changed|switchNow/, sentence);
    assert.doesNotMatch(sentence, /token|model|organization|unlimited|subscriber|trial|refund/i, sentence);
    assert.doesNotMatch(sentence, /undefined|null|NaN/, sentence);
  }
});
