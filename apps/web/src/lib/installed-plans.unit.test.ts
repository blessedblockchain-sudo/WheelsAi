/**
 * A row of Installed whose buyer is on a plan: its badge, its count, what
 * can be done from it and what each dialog says. Run with:
 *   cd apps/web && npx tsx --test src/lib/installed-plans.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MarketplaceListing, MarketplaceSubscription, PaidUsePlan, PlanOffer } from "./api";
import {
  INSTALLED_PLAN_WORDS,
  biggerPlans,
  carriedIntoMove,
  moveUpChoice,
  moveUpConfirm,
  moveUpRefusal,
  movedLine,
  planBadge,
  planLine,
  planOfInstall,
  planRenewal,
  planStopSentence,
  renewalNotThroughLine,
} from "./installed-plans";
import type { InstalledLicence } from "./installed-rows";
import { planCountLine } from "./use-plans";

const FMT = { timeZone: "UTC", locale: "en-US" };

const STARTER: PlanOffer = { id: "p-starter", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: null };
const PRO: PlanOffer = { id: "p-pro", name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: 4 };
const TEAM: PlanOffer = { id: "p-team", name: "Team plan", priceCents: 9900, includedUses: 10000, extraUsePriceCents: 3 };

function listing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: "l1",
    agentId: "a1",
    title: "Support Bot",
    slug: "support-bot",
    shortDescription: "Answers questions.",
    longDescription: null,
    category: "support",
    iconUrl: null,
    screenshots: [],
    readme: null,
    pricingModel: "per_request",
    pricePerRequestCents: 5,
    monthlyPriceCents: null,
    sells: "use",
    unit: "message",
    plans: [STARTER, PRO, TEAM],
    publisherId: "p1",
    publisherName: "Acme",
    status: "published",
    isFeatured: false,
    totalInstalls: 3,
    activeInstalls: 2,
    avgRating: 4.5,
    reviewCount: 2,
    totalRequests: 100,
    publishedAt: "2026-10-01T12:00:00.000Z",
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    ...over,
  };
}

function plan(over: Partial<PaidUsePlan> = {}): PaidUsePlan {
  return {
    id: "p-starter",
    name: "Starter",
    includedUses: 500,
    carriedUses: 0,
    usedUses: 312,
    remainingUses: 188,
    extraUsePriceCents: null,
    resetsAt: "2026-11-12T12:00:00.000Z",
    warning: null,
    ...over,
  };
}

function sub(over: Partial<MarketplaceSubscription> = {}): MarketplaceSubscription {
  return {
    id: "s1",
    listingId: "l1",
    status: "active",
    currentPeriodStart: "2026-10-13T12:00:00.000Z",
    currentPeriodEnd: "2026-11-12T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    cancelledAt: null,
    hasAccess: true,
    graceEndsAt: null,
    priceCents: 900,
    endReason: null,
    plan: plan(),
    ...over,
  };
}

function onPlan(over: Partial<InstalledLicence> = {}): InstalledLicence {
  return {
    id: "i1",
    listingId: "l1",
    kind: "use",
    clonedAgentId: null,
    agent: { handle: "support-bot", name: "Support Bot", agentKind: "conversation" },
    status: "active",
    totalRequests: 312,
    totalSpentCents: 900,
    installedAt: "2026-10-02T12:00:00.000Z",
    access: "subscribed",
    acceptedPricing: { pricingModel: null, pricePerRequestCents: null, acceptedAt: null },
    listing: listing(),
    subscription: sub(),
    ...over,
  };
}

/** The plan with its renewal dropped, as the API sends one that will not renew. */
function notRenewing(over: Partial<PaidUsePlan> = {}): PaidUsePlan {
  const { resetsAt: _dropped, ...rest } = plan(over);
  return rest;
}

/** Rows that are not on a plan: none of this file's functions speaks for them. */
const NOT_ON_A_PLAN: Array<{ name: string; install: InstalledLicence }> = [
  { name: "a month with no count", install: onPlan({ subscription: sub({ plan: null }) }) },
  { name: "an API that does not say", install: onPlan({ subscription: (({ plan: _p, ...rest }) => rest)(sub()) }) },
  { name: "pays per use", install: onPlan({ access: "listing_pricing", subscription: null }) },
  { name: "a plan that is over", install: onPlan({ access: "plan_ended", subscription: sub({ status: "expired", hasAccess: false, plan: null }) }) },
  { name: "a copy", install: onPlan({ kind: "copy", clonedAgentId: "c1" }) },
  { name: "a count that cannot be read", install: onPlan({ subscription: sub({ plan: { ...plan(), remainingUses: Number.NaN } }) }) },
];

test("only a use row that is subscribed and carries a readable plan is on a plan", () => {
  assert.equal(planOfInstall(onPlan())?.id, "p-starter");
  for (const { name, install } of NOT_ON_A_PLAN) {
    assert.equal(planOfInstall(install), null, name);
    assert.equal(planBadge(install), null, name);
    assert.equal(planLine(install, FMT), null, name);
    assert.equal(planRenewal(install), null, name);
    assert.deepEqual(biggerPlans(install), [], name);
    assert.equal(moveUpChoice(install), null, name);
    assert.equal(moveUpConfirm(install, PRO), null, name);
    assert.equal(planStopSentence(install, FMT), null, name);
  }
});

test("the badge names the plan and the price the buyer agreed to, never a month", () => {
  assert.equal(planBadge(onPlan()), "Starter, $9.00 for 30 days");
  // The plan costs more today: the badge keeps what this buyer pays.
  const dearer = onPlan({ listing: listing({ plans: [{ ...STARTER, priceCents: 1200 }, PRO] }) });
  assert.equal(planBadge(dearer), "Starter, $9.00 for 30 days");
  assert.equal(planBadge(onPlan({ subscription: sub({ plan: plan({ name: "  " }) }) })), "$9.00 for 30 days");
  assert.equal(planBadge(onPlan({ subscription: sub({ priceCents: null }) })), "Starter");
  assert.doesNotMatch(planBadge(onPlan()) ?? "", /a month/);
});

test("the line is the count of the agent's page, word for word", () => {
  const install = onPlan();
  assert.deepEqual(planLine(install, FMT), { text: "188 of 500 uses left. Renews 12 Nov.", tone: "ok" });
  // Whatever the count is, the sentence is planCountLine's and no other.
  const shapes: PaidUsePlan[] = [
    plan(),
    plan({ usedUses: 425, remainingUses: 75, warning: 85 }),
    plan({ usedUses: 500, remainingUses: 0, warning: 100 }),
    plan({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: 4 }),
    plan({ carriedUses: 188, usedUses: 10, remainingUses: 678 }),
    notRenewing(),
  ];
  for (const shape of shapes) {
    const row = onPlan({ subscription: sub({ plan: shape }) });
    assert.equal(
      planLine(row, FMT)?.text,
      // The listing of these rows offers a bigger plan, so the line may point at moving up.
      planCountLine({ plan: shape, endsAt: "2026-11-12T12:00:00.000Z", pastDue: false, moveUp: true, dates: { timeZone: "UTC" } }),
    );
  }
});

test("the line warns at 85%, when all is used, and when the plan will not renew", () => {
  const at85 = planLine(onPlan({ subscription: sub({ plan: plan({ usedUses: 425, remainingUses: 75, warning: 85 }) }) }), FMT);
  assert.deepEqual(at85, { text: "You have used 85% of your plan. 75 uses left until 12 Nov.", tone: "warn" });
  const usedAndStops = sub({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100 }) });
  // A bigger plan is on offer and the row offers Move up: the line points at it, as the agent's page does.
  const stopped = planLine(onPlan({ subscription: usedAndStops }), FMT);
  assert.deepEqual(stopped, { text: "You have used all 500 uses. It starts again on 12 Nov, or move up now.", tone: "warn" });
  // No bigger plan to move to: the line only says when it starts again.
  const nowhereToGo = planLine(onPlan({ subscription: usedAndStops, listing: listing({ plans: [STARTER] }) }), FMT);
  assert.deepEqual(nowhereToGo, { text: "You have used all 500 uses. It starts again on 12 Nov.", tone: "warn" });
  const extra = planLine(
    onPlan({ subscription: sub({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: 4 }) }) }),
    FMT,
  );
  assert.deepEqual(extra, { text: "You have used all 500 uses. Each use is now $0.04 from your credits.", tone: "warn" });
  const cancelled = planLine(onPlan({ subscription: sub({ cancelAtPeriodEnd: true, plan: notRenewing() }) }), FMT);
  assert.deepEqual(cancelled, { text: "188 of 500 uses left. Your plan ends on 12 Nov.", tone: "warn" });
});

test("uses carried in by a move are counted in what the period holds", () => {
  const moved = onPlan({
    subscription: sub({ priceCents: 2900, plan: plan({ id: "p-pro", name: "Pro", includedUses: 2000, carriedUses: 188, usedUses: 0, remainingUses: 2188, extraUsePriceCents: 4 }) }),
  });
  assert.equal(planBadge(moved), "Pro, $29.00 for 30 days");
  assert.equal(planLine(moved, FMT)?.text, "2188 of 2188 uses left. Renews 12 Nov.");
});

test("an agent that is no longer sold for use names no charge past the count", () => {
  const used = sub({ plan: notRenewing({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: 4 }) });
  for (const gone of [listing({ status: "archived" }), listing({ sells: "copies", unit: null })]) {
    const line = planLine(onPlan({ listing: gone, subscription: used }), FMT);
    assert.deepEqual(line, { text: "You have used all 500 uses. Your plan ends on 12 Nov.", tone: "warn" });
    assert.doesNotMatch(line?.text ?? "", /\$/);
  }
});

test("a renewal being retried says how much and by when, then the count with no day in it", () => {
  const install = onPlan({
    subscription: sub({
      status: "past_due",
      currentPeriodEnd: "2026-10-12T12:00:00.000Z",
      graceEndsAt: "2026-10-15T12:00:00.000Z",
      plan: plan({ resetsAt: "2026-10-12T12:00:00.000Z" }),
    }),
  });
  assert.deepEqual(planLine(install, FMT), {
    text: "Your renewal of $9.00 did not go through. Add credits before 15 Oct to keep access. 188 of 500 uses left.",
    tone: "warn",
  });
  // The period's end is behind the buyer: it is never said as the day the count starts again.
  assert.doesNotMatch(planLine(install, FMT)?.text ?? "", /12 Oct|Renews/);
  assert.equal(renewalNotThroughLine(null, "15 Oct"), "Your renewal did not go through. Add credits before 15 Oct to keep access.");
  assert.equal(planStopSentence(install, FMT), "This ends your plan and your access now. You are not charged again.");
});

test("a plan's days are written in UTC when the page names no zone, as on the agent's page", () => {
  // 23:30 UTC on the 12th is already the 13th east of Greenwich.
  const late = sub({ currentPeriodEnd: "2026-11-12T23:30:00.000Z", plan: plan({ resetsAt: "2026-11-12T23:30:00.000Z" }) });
  assert.equal(planLine(onPlan({ subscription: late }))?.text, "188 of 500 uses left. Renews 12 Nov.");
  assert.match(planStopSentence(onPlan({ subscription: late })) ?? "", /until 12 Nov/);
  assert.equal(planLine(onPlan({ subscription: late }), { timeZone: "Asia/Tokyo" })?.text, "188 of 500 uses left. Renews 13 Nov.");
});

test("the renewal: cancel while it will renew, resume only while the plan is still on offer", () => {
  assert.equal(planRenewal(onPlan()), "cancel");
  const cancelled = sub({ cancelAtPeriodEnd: true, plan: notRenewing() });
  assert.equal(planRenewal(onPlan({ subscription: cancelled })), "resume");
  // Its creator ended the plan: it is not on offer and will not renew, whatever the buyer chooses.
  const ended = listing({ plans: [PRO, TEAM] });
  assert.equal(planRenewal(onPlan({ listing: ended, subscription: sub({ plan: notRenewing() }) })), null);
  assert.equal(planRenewal(onPlan({ listing: ended, subscription: cancelled })), null);
  // The agent left the market, or the listing came without its plans.
  assert.equal(planRenewal(onPlan({ listing: listing({ status: "archived" }), subscription: cancelled })), null);
  assert.equal(planRenewal(onPlan({ listing: listing({ plans: undefined }), subscription: cancelled })), null);
});

test("moving up is offered only to plans that cost more than the buyer agreed to", () => {
  assert.deepEqual(biggerPlans(onPlan()).map((offer) => offer.id), ["p-pro", "p-team"]);
  // From the middle plan: the smaller one is never a choice.
  const onPro = onPlan({ subscription: sub({ priceCents: 2900, plan: plan({ id: "p-pro", name: "Pro", includedUses: 2000 }) }) });
  assert.deepEqual(biggerPlans(onPro).map((offer) => offer.id), ["p-team"]);
  // On the biggest: none.
  const onTeam = onPlan({ subscription: sub({ priceCents: 9900, plan: plan({ id: "p-team", name: "Team plan" }) }) });
  assert.deepEqual(biggerPlans(onTeam), []);
  // The price that counts is the one agreed to, not the plan's price today, and the same price is not bigger.
  const agreedMore = onPlan({ subscription: sub({ priceCents: 2900 }) });
  assert.deepEqual(biggerPlans(agreedMore).map((offer) => offer.id), ["p-team"]);
  // The buyer's own plan is never a choice, even if its price went up since.
  const dearer = onPlan({ listing: listing({ plans: [{ ...STARTER, priceCents: 1200 }] }) });
  assert.deepEqual(biggerPlans(dearer), []);
  // No plans with the listing, a listing off the market, or a price never agreed: nothing to move to.
  assert.deepEqual(biggerPlans(onPlan({ listing: listing({ plans: [] }) })), []);
  assert.deepEqual(biggerPlans(onPlan({ listing: listing({ plans: undefined }) })), []);
  assert.deepEqual(biggerPlans(onPlan({ listing: listing({ status: "archived" }) })), []);
  assert.deepEqual(biggerPlans(onPlan({ subscription: sub({ priceCents: null }) })), []);
  // A plan with a term missing is not a card.
  const broken = listing({ plans: [STARTER, { ...PRO, includedUses: 0 }, TEAM] });
  assert.deepEqual(biggerPlans(onPlan({ listing: broken })).map((offer) => offer.id), ["p-team"]);
});

test("what a move carries: the uses left, and at most what the plan being left included", () => {
  assert.equal(carriedIntoMove({ includedUses: 500, remainingUses: 188 }), 188);
  assert.equal(carriedIntoMove({ includedUses: 500, remainingUses: 500 }), 500);
  // Uses carried in by an earlier move are not carried a second time.
  assert.equal(carriedIntoMove({ includedUses: 500, remainingUses: 650 }), 500);
  assert.equal(carriedIntoMove({ includedUses: 500, remainingUses: 0 }), 0);
  assert.equal(carriedIntoMove({ includedUses: 500, remainingUses: -3 }), 0);
  assert.equal(carriedIntoMove({ includedUses: 500, remainingUses: Number.NaN }), 0);
});

test("the choice lists each bigger plan with its price, its uses and what happens after them", () => {
  const choice = moveUpChoice(onPlan());
  assert.equal(choice?.title, "Move up on Support Bot");
  assert.equal(choice?.intro, INSTALLED_PLAN_WORDS.chooseIntro);
  assert.deepEqual(
    choice?.cards.map(({ offer: _offer, ...card }) => card),
    [
      { id: "p-pro", name: "Pro", price: "$29.00 for 30 days", uses: "2000 uses", after: "then $0.04 a use", moveLabel: "Move up to the Pro plan" },
      { id: "p-team", name: "Team plan", price: "$99.00 for 30 days", uses: "10000 uses", after: "then $0.03 a use", moveLabel: "Move up to the Team plan" },
    ],
  );
  const stops = moveUpChoice(onPlan({ listing: listing({ plans: [STARTER, { ...PRO, extraUsePriceCents: null }] }) }));
  assert.equal(stops?.cards[0]?.after, "then it stops until it renews");
  // The plans were read again and none is bigger: the dialog has no card, and a sentence for it.
  assert.deepEqual(moveUpChoice(onPlan({ listing: listing({ plans: [STARTER] }) }))?.cards, []);
  assert.equal(INSTALLED_PLAN_WORDS.noneBigger, "There is no bigger plan to move to now.");
});

test("the confirm of a move is the design's sentence, with the terms of the plan that was chosen", () => {
  const dialog = moveUpConfirm(onPlan(), PRO);
  assert.deepEqual(dialog, {
    title: "Move up to the Pro plan?",
    description: "Starts a new 30 days today and charges $29.00 from your credits. The 188 uses you have left are added to it.",
    confirmLabel: "Move up for $29.00",
    terms: { id: "p-pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: 4 },
  });
  // A plan its creator called "Team plan" is not asked about as "the Team plan plan".
  assert.equal(moveUpConfirm(onPlan(), TEAM)?.title, "Move up to the Team plan?");
  // Nothing left: the second sentence is left out.
  const usedUp = onPlan({ subscription: sub({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100 }) }) });
  assert.equal(moveUpConfirm(usedUp, PRO)?.description, "Starts a new 30 days today and charges $29.00 from your credits.");
  const oneLeft = onPlan({ subscription: sub({ plan: plan({ usedUses: 499, remainingUses: 1, warning: 85 }) }) });
  assert.equal(
    moveUpConfirm(oneLeft, PRO)?.description,
    "Starts a new 30 days today and charges $29.00 from your credits. The 1 use you have left is added to it.",
  );
  // Uses carried in by an earlier move stay behind: the sentence says both numbers, in the words of the agent's page.
  const carriedBefore = onPlan({ subscription: sub({ plan: plan({ carriedUses: 300, usedUses: 100, remainingUses: 700 }) }) });
  assert.equal(
    moveUpConfirm(carriedBefore, PRO)?.description,
    "Starts a new 30 days today and charges $29.00 from your credits. 500 of the 700 uses you have left are added to it.",
  );
  // The terms are the card's own, a stop sent as null and never left out.
  assert.deepEqual(moveUpConfirm(onPlan(), { ...PRO, extraUsePriceCents: null })?.terms, {
    id: "p-pro",
    priceCents: 2900,
    includedUses: 2000,
    extraUsePriceCents: null,
  });
});

test("a refused move shows the API's sentence as it comes, and offers credits only when they are short", () => {
  const notBigger = "To move to a smaller plan, cancel the renewal and choose it when your plan ends.";
  assert.deepEqual(moveUpRefusal(409, notBigger), { message: notBigger, addCredits: false });
  assert.deepEqual(moveUpRefusal(402, "You need $29.00 in credits to start this plan."), {
    message: "You need $29.00 in credits to start this plan.",
    addCredits: true,
  });
  assert.deepEqual(moveUpRefusal(403, "Ask an owner or admin."), { message: "Ask an owner or admin.", addCredits: false });
  // No answer at all: the row is to be looked at before a second try, since nothing is known.
  assert.deepEqual(moveUpRefusal(0, ""), { message: INSTALLED_PLAN_WORDS.moveFailed, addCredits: false });
  assert.deepEqual(moveUpRefusal(500, null), { message: INSTALLED_PLAN_WORDS.moveFailed, addCredits: false });
});

test("after a move the page says which plan the buyer is on", () => {
  assert.equal(movedLine(PRO), "You are now on the Pro plan.");
  assert.equal(movedLine(TEAM), "You are now on the Team plan.");
  assert.equal(movedLine({ name: " " }), "You are now on this plan.");
});

test("stopping a plan says it ends now and that the 30 days are not refunded", () => {
  assert.equal(
    planStopSentence(onPlan(), FMT),
    "This ends your plan now. The 30 days you paid for (until 12 Nov) are not refunded. To keep access until then, cancel renewal instead.",
  );
  // The renewal is already cancelled, or the plan will not renew: there is nothing to cancel instead.
  for (const install of [
    onPlan({ subscription: sub({ cancelAtPeriodEnd: true, plan: notRenewing() }) }),
    onPlan({ listing: listing({ plans: [PRO] }), subscription: sub({ plan: notRenewing() }) }),
  ]) {
    assert.equal(planStopSentence(install, FMT), "This ends your access now. The 30 days you paid for (until 12 Nov) are not refunded.");
  }
});

test("nothing here names a month, a count with no end, a token, or anyone else on the plan", () => {
  const installs = [
    onPlan(),
    onPlan({ subscription: sub({ cancelAtPeriodEnd: true, plan: notRenewing() }) }),
    onPlan({ subscription: sub({ status: "past_due", graceEndsAt: "2026-11-15T12:00:00.000Z" }) }),
    onPlan({ subscription: sub({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: 4 }) }) }),
  ];
  for (const install of installs) {
    const said = JSON.stringify([
      planBadge(install),
      planLine(install, FMT),
      moveUpChoice(install),
      moveUpConfirm(install, PRO),
      planStopSentence(install, FMT),
      INSTALLED_PLAN_WORDS,
    ]);
    assert.doesNotMatch(said, /a month|unlimited|token|subscriber|\u2014|undefined|NaN/i);
  }
});

test("the line points at moving up only for someone who may spend", () => {
  const usedUp = onPlan({ subscription: sub({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100 }) }) });
  const told = "You have used all 500 uses. It starts again on 12 Nov, or move up now.";
  assert.equal(planLine(usedUp, FMT)?.text, told);
  assert.equal(planLine(usedUp, FMT, {})?.text, told);
  assert.equal(planLine(usedUp, FMT, { canSpend: true })?.text, told);
  assert.equal(planLine(usedUp, FMT, { canSpend: false })?.text, "You have used all 500 uses. It starts again on 12 Nov.");
  // With uses left the line never spoke of moving, so it is the same for everyone.
  assert.deepEqual(planLine(onPlan(), FMT, { canSpend: false }), planLine(onPlan(), FMT));
});
