/**
 * The Usage page as it is drawn: the balance, each row's bar, its count in
 * the words of the agent's page, and what was paid past a plan and per use.
 * Run with:
 *   cd apps/web && npx tsx --test src/lib/usage-view.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MarketplaceUsage, MarketplaceUsageRow, PaidUsePlan } from "./api";
import { INSTALLED_WORDS } from "./installed-rows";
import { planCountLine, trialCountLine, planCountOf } from "./use-plans";
import {
  ADD_CREDITS_HREF,
  USAGE_BAR_MARKS,
  USAGE_HREF,
  USAGE_WORDS,
  extraUsesLine,
  perUseLine,
  usageBar,
  usageRow,
  usageView,
} from "./usage-view";

const RESET = "2026-11-12T12:00:00.000Z";

function plan(over: Partial<PaidUsePlan> = {}): PaidUsePlan {
  return {
    id: "p-starter",
    name: "Starter",
    includedUses: 500,
    usedUses: 188,
    remainingUses: 312,
    extraUsePriceCents: 4,
    resetsAt: RESET,
    warning: null,
    ...over,
  };
}

function row(over: Partial<MarketplaceUsageRow> = {}): MarketplaceUsageRow {
  return {
    listingId: "l1",
    title: "Support Bot",
    slug: "support-bot",
    handle: "support-bot",
    access: "subscribed",
    plan: plan(),
    periodEndsAt: RESET,
    renewalPastDue: false,
    extraThisPeriod: { uses: 0, cents: 0 },
    perUseThisMonth: { uses: 0, cents: 0 },
    ...over,
  };
}

const perUseRow = (over: Partial<MarketplaceUsageRow> = {}) =>
  row({ access: "listing_pricing", plan: null, periodEndsAt: null, extraThisPeriod: null, ...over });

test("the page's address is the one the warning emails link to", () => {
  assert.equal(USAGE_HREF, "/dashboard/usage");
  assert.equal(ADD_CREDITS_HREF, "/dashboard/billing#add-credits");
  assert.equal(USAGE_WORDS.linkLabel, "Usage of what you pay for");
  assert.equal(USAGE_WORDS.addCredits, "Add credits");
});

test("the balance is the API's cents as dollars, and is not drawn as $0.00 when it was not sent", () => {
  assert.equal(usageView({ balanceCents: 1240, listings: [] }).balance, "$12.40");
  assert.equal(usageView({ balanceCents: 0, listings: [] }).balance, "$0.00");
  assert.equal(usageView(null).balance, null);
  assert.equal(usageView({ listings: [] } as unknown as MarketplaceUsage).balance, null);
  assert.equal(usageView({ balanceCents: Number.NaN, listings: [] }).balance, null);
});

test("an organization that uses nothing reads one sentence", () => {
  const view = usageView({ balanceCents: 500, listings: [] });
  assert.deepEqual(view.rows, []);
  assert.equal(view.empty, "You do not pay to use anything yet.");
  assert.equal(usageView(null).empty, USAGE_WORDS.empty);
  assert.equal(usageView({ balanceCents: 1, listings: "no" } as unknown as MarketplaceUsage).empty, USAGE_WORDS.empty);
  assert.equal(usageView({ balanceCents: 500, listings: [row()] }).empty, null);
});

test("a row on a plan: its name, its bar, and the count in the words of the agent's page", () => {
  const view = usageRow(row());
  assert.equal(view.title, "Support Bot");
  assert.equal(view.href, "/a/support-bot");
  assert.equal(view.planName, "Starter");
  assert.equal(view.countLine, "312 of 500 uses left. Renews 12 Nov.");
  assert.equal(view.countTone, "ok");
  assert.equal(view.renewalLine, null);
  assert.deepEqual(view.bar, {
    totalUses: 500,
    usedUses: 188,
    percent: 37,
    level: null,
    levelLabel: null,
    usedText: "188 of 500 uses used",
    label: "Starter: 188 of 500 uses used.",
  });
  // Nothing past the plan and nothing per use: neither is said, and no line stands in for them.
  assert.equal(view.extraLine, null);
  assert.equal(view.perUseLine, null);
  assert.equal(view.statusLine, null);
});

test("the count line is planCountLine's, with the day written in UTC", () => {
  const cases: MarketplaceUsageRow[] = [
    row(),
    row({ plan: plan({ usedUses: 425, remainingUses: 75, warning: 85 }) }),
    row({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100 }) }),
    row({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: null }) }),
    row({ plan: plan({ resetsAt: undefined }) }),
    row({ renewalPastDue: true }),
    // A day that is the 13th in a zone east of UTC is still said as the API says it.
    row({ plan: plan({ resetsAt: "2026-11-12T23:30:00.000Z" }), periodEndsAt: "2026-11-12T23:30:00.000Z" }),
  ];
  for (const item of cases) {
    assert.equal(
      usageRow(item).countLine,
      planCountLine({
        plan: item.plan!,
        endsAt: item.periodEndsAt,
        pastDue: item.renewalPastDue,
        dates: { timeZone: "UTC" },
      }),
    );
  }
  assert.equal(usageRow(cases[6]!).countLine, "312 of 500 uses left. Renews 12 Nov.");
});

test("at 85% the bar and the line both say so in words", () => {
  const view = usageRow(row({ plan: plan({ usedUses: 425, remainingUses: 75, warning: 85 }) }));
  assert.equal(view.bar?.percent, 85);
  assert.equal(view.bar?.level, 85);
  assert.equal(view.bar?.levelLabel, "85% or more used");
  assert.equal(view.bar?.usedText, "425 of 500 uses used");
  assert.equal(view.bar?.label, "Starter: 425 of 500 uses used. 85% or more used.");
  assert.equal(view.countLine, "You have used 85% of your plan. 75 uses left until 12 Nov.");
  assert.equal(view.countTone, "warn");
});

test("at 100% the bar is full, and the line says what happens next", () => {
  const priced = usageRow(row({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100 }) }));
  assert.equal(priced.bar?.percent, 100);
  assert.equal(priced.bar?.level, 100);
  assert.equal(priced.bar?.levelLabel, "All used");
  assert.equal(priced.bar?.label, "Starter: 500 of 500 uses used. All used.");
  assert.equal(priced.countLine, "You have used all 500 uses. Each use is now $0.04 from your credits.");
  assert.equal(priced.countTone, "warn");

  const stops = usageRow(row({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100, extraUsePriceCents: null }) }));
  assert.equal(stops.countLine, "You have used all 500 uses. It starts again on 12 Nov.");
  // The usage page offers no move, so it never tells anyone to move up.
  assert.equal(/move up/i.test(JSON.stringify(stops)), false);

  // No use left is the full bar even when the answer carried no warning.
  const unwarned = usageBar({ includedUses: 10, usedUses: 10, remainingUses: 0, extraUsePriceCents: null, warning: null }, "Starter");
  assert.equal(unwarned.level, 100);
  assert.equal(unwarned.percent, 100);
});

test("uses brought in by a move are part of the bar, as they are part of the line", () => {
  const moved = plan({ id: "p-pro", name: "Pro", includedUses: 2000, carriedUses: 188, usedUses: 100, remainingUses: 2088 });
  const view = usageRow(row({ plan: moved }));
  assert.equal(view.bar?.totalUses, 2188);
  assert.equal(view.bar?.usedText, "100 of 2188 uses used");
  assert.equal(view.bar?.percent, 4);
  assert.equal(view.countLine, "2088 of 2188 uses left. Renews 12 Nov.");
});

test("the bar never leaves 0 to 100 and reads right for a plan of one use", () => {
  const one = usageBar({ includedUses: 1, usedUses: 0, remainingUses: 1, extraUsePriceCents: null, warning: null }, "Tiny");
  assert.equal(one.usedText, "0 of 1 use used");
  assert.equal(one.percent, 0);
  const odd = usageBar({ includedUses: 0, usedUses: 0, remainingUses: 5, extraUsePriceCents: null, warning: null }, "Odd");
  assert.equal(odd.percent, 0);
  assert.equal(odd.totalUses, 5);
  // 99.9% is not drawn as full: only the API's 100, or no use left, fills the bar.
  const nearly = usageBar({ includedUses: 1000, usedUses: 999, remainingUses: 1, extraUsePriceCents: null, warning: 85 }, "Big");
  assert.equal(nearly.percent, 99);
  // The first warning holds up to one use short of all, so its words are true there too.
  assert.equal(nearly.levelLabel, "85% or more used");
  assert.equal(nearly.label, "Big: 999 of 1000 uses used. 85% or more used.");
  assert.deepEqual(USAGE_BAR_MARKS.map((mark) => [mark.at, mark.label]), [[85, "85%"], [100, "100%"]]);
});

test("a plan that will not renew says the day it ends, and is not quiet", () => {
  const view = usageRow(row({ plan: plan({ resetsAt: undefined }) }));
  assert.equal(view.countLine, "312 of 500 uses left. Your plan ends on 12 Nov.");
  assert.equal(view.countTone, "warn");
});

test("a renewal being retried is said first, and the count names no day", () => {
  const view = usageRow(row({ renewalPastDue: true }));
  assert.equal(view.renewalLine, "Your renewal did not go through. Add credits to keep access.");
  assert.equal(view.countLine, "312 of 500 uses left.");
  assert.equal(view.countTone, "warn");
});

test("extra uses of the period and uses paid per use this month, each with what they cost", () => {
  const view = usageRow(row({ extraThisPeriod: { uses: 12, cents: 48 }, perUseThisMonth: { uses: 37, cents: 185 } }));
  assert.equal(view.extraLine, "12 extra uses this period: $0.48.");
  assert.equal(view.perUseLine, "37 uses paid per use this month: $1.85.");
  assert.equal(extraUsesLine({ uses: 1, cents: 4 }), "1 extra use this period: $0.04.");
  assert.equal(perUseLine({ uses: 1, cents: 5 }), "1 use paid per use this month: $0.05.");
});

test("a row with no plan shows only what it has", () => {
  const paid = usageRow(perUseRow({ perUseThisMonth: { uses: 37, cents: 185 } }));
  assert.equal(paid.planName, null);
  assert.equal(paid.bar, null);
  assert.equal(paid.countLine, null);
  assert.equal(paid.renewalLine, null);
  assert.equal(paid.extraLine, null);
  assert.equal(paid.perUseLine, "37 uses paid per use this month: $1.85.");
  assert.equal(paid.statusLine, null);

  const quiet = usageRow(perUseRow());
  assert.equal(quiet.perUseLine, null);
  assert.equal(quiet.statusLine, "No uses paid per use this month.");

  // A month with no count (today's monthly subscriber) has no plan here: no bar is made up for it.
  const monthly = usageRow(row({ plan: null, extraThisPeriod: null, periodEndsAt: null }));
  // It is said as paid by the month, never as nothing paid.
  assert.equal(monthly.bar, null);
  assert.equal(monthly.statusLine, "You pay for this agent by the month. Its renewal is on the Installed page.");
  const monthlyToo = usageRow(row({ plan: null, extraThisPeriod: null, periodEndsAt: null, perUseThisMonth: { uses: 2, cents: 10 } }));
  assert.equal(monthlyToo.statusLine, USAGE_WORDS.paidMonthly);
  assert.equal(monthlyToo.perUseLine, "2 uses paid per use this month: $0.10.");
  // The other rows with no plan keep their sentence.
  for (const access of ["subscription_lapsed", "pricing_changed", "not_offered"] as const) {
    assert.equal(usageRow(perUseRow({ access })).statusLine, USAGE_WORDS.nothingPerUse, access);
  }
});

test("a plan that is over is said as Installed says it", () => {
  const view = usageRow(perUseRow({ access: "plan_ended" }));
  assert.equal(view.statusLine, INSTALLED_WORDS.planEnded);
  assert.equal(view.bar, null);
  // What was paid per use since is still shown beside it.
  const since = usageRow(perUseRow({ access: "plan_ended", perUseThisMonth: { uses: 2, cents: 10 } }));
  assert.equal(since.statusLine, INSTALLED_WORDS.planEnded);
  assert.equal(since.perUseLine, "2 uses paid per use this month: $0.10.");
});

test("a free trial that is over is said as one, from the API's word and nothing else", () => {
  const view = usageRow(perUseRow({ access: "plan_ended", trialEnded: true }));
  assert.equal(view.statusLine, "Your free trial ended. Choose a plan or pay per use to keep using it.");
  assert.equal(view.statusLine, INSTALLED_WORDS.trialEnded);
  assert.equal(view.bar, null);
  assert.equal(view.planName, null);
  // The API says it was no trial: a plan that ended.
  assert.equal(usageRow(perUseRow({ access: "plan_ended", trialEnded: false })).statusLine, INSTALLED_WORDS.planEnded);
  // Only the API's own true counts. Anything else that merely reads as true is a plan that ended.
  for (const word of ["true", 1, {}]) {
    const said = perUseRow({ access: "plan_ended", trialEnded: word as unknown as boolean });
    assert.equal(usageRow(said).statusLine, INSTALLED_WORDS.planEnded, String(word));
  }
  // The word counts only beside a plan that is over: every other row is what it was.
  for (const access of ["listing_pricing", "subscription_lapsed", "pricing_changed", "not_offered"] as const) {
    assert.deepEqual(usageRow(perUseRow({ access, trialEnded: true })), usageRow(perUseRow({ access })), access);
  }
  assert.deepEqual(usageRow(row({ trialEnded: true })), usageRow(row()));
});

test("a plan is drawn only while it gives uses, and only when its count can be read", () => {
  // The API names a plan only while the access is subscribed; anything else is not drawn as one.
  assert.equal(usageRow(row({ access: "pricing_changed" })).bar, null);
  const broken = { ...plan(), remainingUses: undefined } as unknown as PaidUsePlan;
  const view = usageRow(row({ plan: broken, extraThisPeriod: { uses: 3, cents: 12 } }));
  assert.equal(view.bar, null);
  assert.equal(view.countLine, null);
  assert.equal(view.extraLine, null);
  // A subscriber whose count could not be read is not told that nothing was paid.
  assert.equal(view.statusLine, null);
});

test("a sum that is not a count and an amount is not said", () => {
  const bad = [
    { uses: 0, cents: 100 },
    { uses: -1, cents: 4 },
    { uses: 1.5, cents: 4 },
    { uses: 2, cents: Number.NaN },
    { uses: 2, cents: -4 },
    null,
  ];
  for (const sum of bad) {
    const view = usageRow(row({ extraThisPeriod: sum, perUseThisMonth: sum as never }));
    assert.equal(view.extraLine, null, JSON.stringify(sum));
    assert.equal(view.perUseLine, null, JSON.stringify(sum));
  }
});

test("an agent with no page has a plain title, and a plan with no name is still a plan", () => {
  assert.equal(usageRow(row({ handle: null })).href, null);
  const unnamed = usageRow(row({ plan: plan({ name: "  " }) }));
  assert.equal(unnamed.planName, "Plan");
  assert.equal(unnamed.bar?.label, "Plan: 188 of 500 uses used.");
});

test("rows keep the API's order and each is its own listing's", () => {
  const view = usageView({
    balanceCents: 1240,
    listings: [row(), perUseRow({ listingId: "l2", title: "Lead Finder", handle: "lead-finder", perUseThisMonth: { uses: 3, cents: 30 } })],
  });
  assert.deepEqual(view.rows.map((item) => [item.listingId, item.title, item.href]), [
    ["l1", "Support Bot", "/a/support-bot"],
    ["l2", "Lead Finder", "/a/lead-finder"],
  ]);
});

test("nothing a buyer must not read is in any word or any row", () => {
  const drawn = JSON.stringify([
    USAGE_WORDS,
    usageView({
      balanceCents: 1240,
      listings: [
        row({ extraThisPeriod: { uses: 12, cents: 48 }, perUseThisMonth: { uses: 37, cents: 185 } }),
        row({ plan: plan({ usedUses: 500, remainingUses: 0, warning: 100 }), renewalPastDue: true }),
        perUseRow({ access: "plan_ended" }),
        perUseRow(),
        row({ plan: null, extraThisPeriod: null, periodEndsAt: null }),
      ],
    }),
  ]);
  assert.equal(/unlimited|token|model|organi[sz]ation|subscribers?\b|\u2014/i.test(drawn), false);
  // No raw code of the API inside a sentence.
  assert.equal(/plan_ended|listing_pricing|past_due|plan_used_up/.test(drawn.replace(/"access":"[a-z_]+"/g, "")), false);
});

// ---------------------------------------------------------------------------
// A row on a listing's free trial
// ---------------------------------------------------------------------------

const TRIAL_ENDS = "2026-10-20T12:00:00.000Z";

/** A trial's plan as the API sends it: no extra price, never a day the count starts again. */
function trialPlan(over: Partial<PaidUsePlan> = {}): PaidUsePlan {
  return {
    id: "p-trial",
    name: "Free trial",
    trial: true,
    includedUses: 20,
    carriedUses: 0,
    usedUses: 8,
    remainingUses: 12,
    extraUsePriceCents: null,
    warning: null,
    ...over,
  };
}

const trialRow = (over: Partial<MarketplaceUsageRow> = {}, planOver: Partial<PaidUsePlan> = {}) =>
  row({ plan: trialPlan(planOver), periodEndsAt: TRIAL_ENDS, ...over });

test("a trial's row is named Free trial and its line is the trial's count, with no extra uses", () => {
  const view = usageRow(trialRow());
  assert.equal(view.planName, "Free trial");
  assert.equal(view.countLine, "12 of 20 trial uses left. Your free trial ends on 20 Oct.");
  assert.equal(view.countLine, trialCountLine({ plan: planCountOf(trialPlan())!, endsAt: TRIAL_ENDS, dates: { timeZone: "UTC" } }));
  assert.equal(view.countTone, "ok");
  assert.equal(view.extraLine, null);
  assert.equal(view.renewalLine, null);
  assert.equal(view.statusLine, null);
  assert.equal(view.bar?.usedText, "8 of 20 uses used");
  assert.equal(view.bar?.label, "Free trial: 8 of 20 uses used.");
  // Whatever name came with the row, and whatever it says of a renewal: a trial has neither.
  assert.equal(usageRow(trialRow({ renewalPastDue: true }, { name: "Starter" })).planName, "Free trial");
  assert.equal(usageRow(trialRow({ renewalPastDue: true })).renewalLine, null);
  assert.doesNotMatch(view.countLine!, /Renews|starts again|move up|your plan/i);
  // From 85% used the bar says so, and the line beside it takes the same tone with its words unchanged.
  const low = usageRow(trialRow({}, { usedUses: 17, remainingUses: 3, warning: 85 as const }));
  assert.equal(low.bar?.levelLabel, USAGE_WORDS.level85);
  assert.equal(low.countTone, "warn");
  assert.equal(low.countLine, "3 of 20 trial uses left. Your free trial ends on 20 Oct.");
});

test("a trial whose uses are gone says so; what was charged past it is never left out", () => {
  const gone = { usedUses: 20, remainingUses: 0, warning: 100 as const };
  const view = usageRow(trialRow({}, gone));
  // An API that does not say what a use costs next: the line does not guess what comes next.
  assert.equal(view.countLine, "You have used all 20 uses of your free trial.");
  assert.equal(view.countTone, "warn");
  assert.equal(view.bar?.levelLabel, USAGE_WORDS.level100);
  assert.equal(view.extraLine, null);
  // A buyer who agreed to pay per use was charged for the uses past the trial: their cost is shown.
  const paid = usageRow(trialRow({ extraThisPeriod: { uses: 3, cents: 15 } }, gone));
  assert.equal(paid.extraLine, "3 extra uses this period: $0.15.");
  assert.equal(paid.countLine, "You have used all 20 uses of your free trial.");
});

test("a trial whose uses are gone says what comes next, from what the API said a use now costs", () => {
  const gone = { usedUses: 20, remainingUses: 0, warning: 100 as const };
  const line = (perUseAfterTrial: unknown) =>
    usageRow(trialRow({ perUseAfterTrial } as Partial<MarketplaceUsageRow>, gone)).countLine;
  const USED = "You have used all 20 uses of your free trial.";

  // A buyer who agreed to the price per use: each use is now charged, and the line says the price.
  assert.equal(line({ priceCents: 5, unit: "message" }), `${USED} Each message is now $0.05 from your credits.`);
  assert.equal(line({ priceCents: 250, unit: "run" }), `${USED} Each run is now $2.50 from your credits.`);
  // The API says no use is charged: the buyer chooses.
  assert.equal(line(null), `${USED} Choose a plan or pay per use to keep using it.`);
  // Anything that is not a whole price above nothing for a message or a run is not repeated, and is
  // not read as "choose" either: the line says only that the uses are gone.
  for (const odd of [
    { priceCents: 0, unit: "message" },
    { priceCents: -5, unit: "message" },
    { priceCents: 2.5, unit: "message" },
    { priceCents: "5", unit: "message" },
    { priceCents: 5, unit: "month" },
    { priceCents: 5 },
    { unit: "run" },
    "5",
    5,
    true,
  ]) {
    assert.equal(line(odd), USED, JSON.stringify(odd));
  }

  // With uses left the line is the count, whatever a use costs afterwards.
  const left = "12 of 20 trial uses left. Your free trial ends on 20 Oct.";
  assert.equal(usageRow(trialRow({ perUseAfterTrial: { priceCents: 5, unit: "message" } })).countLine, left);
  assert.equal(usageRow(trialRow({ perUseAfterTrial: null })).countLine, left);
  // Nothing else of the row moves with it.
  const { countLine: _a, ...withPrice } = usageRow(trialRow({ perUseAfterTrial: { priceCents: 5, unit: "message" } }, gone));
  const { countLine: _b, ...without } = usageRow(trialRow({}, gone));
  assert.deepEqual(withPrice, without);
  // A paid plan never reads it.
  assert.deepEqual(
    usageRow(row({ perUseAfterTrial: { priceCents: 5, unit: "message" } })),
    usageRow(row()),
  );
});

test("a paid plan's row is what it was, whether or not the API says it is not a trial", () => {
  assert.deepEqual(usageRow(row({ plan: plan({ trial: false }) })), usageRow(row()));
  assert.equal(usageRow(row()).planName, "Starter");
  assert.equal(usageRow(row()).countLine, planCountLine({ plan: plan(), endsAt: RESET, dates: { timeZone: "UTC" } }));
});

// ============================================
// A workflow's row
// ============================================

const workflowRow = (over: Partial<MarketplaceUsageRow> = {}) =>
  row({ productKind: "workflow", listingId: "l9", title: "Weekly report", slug: "weekly-report", handle: null, ...over });

test("a workflow's row opens the workflow's page by the listing's slug, as Installed does", () => {
  const onPlan = usageRow(workflowRow());
  assert.equal(onPlan.href, "/w/weekly-report");
  assert.equal(onPlan.productKind, "workflow");
  // Per run, with nothing on a plan: the same address.
  assert.equal(usageRow(perUseRow({ productKind: "workflow", slug: "weekly-report", handle: null })).href, "/w/weekly-report");
  // A handle a row should not carry is never where a workflow's row goes.
  assert.equal(usageRow(workflowRow({ handle: "support-bot" })).href, "/w/weekly-report");
  // An agent's row is what it was; an older API that says nothing of the product sold agents.
  assert.equal(usageRow(row()).href, "/a/support-bot");
  assert.equal(usageRow(row()).productKind, "agent");
  assert.equal(usageRow(row({ productKind: "agent" })).href, "/a/support-bot");
});

test("a workflow's row counts its plan in the same words as an agent's", () => {
  const workflow = usageRow(workflowRow());
  const agent = usageRow(row());
  assert.equal(workflow.countLine, agent.countLine);
  assert.deepEqual(workflow.bar, agent.bar);
  assert.equal(workflow.planName, "Starter");
});

test("the page's words cover agents and workflows both", () => {
  assert.equal(USAGE_WORDS.description, "What you have used and spent on the agents and workflows you pay for.");
  assert.equal(USAGE_WORDS.balanceNote, "One balance pays for everything you use.");
  assert.equal(USAGE_WORDS.empty, "You do not pay to use anything yet.");
  assert.equal(USAGE_WORDS.listTitle, "What you pay for");
  // The month with no count is an agent's alone: a workflow is never sold by the month.
  for (const key of ["title", "description", "balanceNote", "listTitle", "empty", "linkLabel"] as const) {
    assert.doesNotMatch(USAGE_WORDS[key], /\bagent\b/i, key);
  }
});
