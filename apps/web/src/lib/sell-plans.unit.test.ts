/**
 * Plans on a listing, for their creator: the rows, the checks before a save,
 * the one body a save sends, where the API's sentences go, and every word.
 * Run with:
 *   cd apps/web && npx tsx --test src/lib/sell-plans.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { splitCents } from "@wheelsai/shared/revenue";

import { emptySellForm, type SellForm } from "./sell-choice";
import {
  DEFAULT_PLAN_LIMITS,
  PLAN_NAME_MAX,
  PLAN_WORDS,
  addPlanRow,
  canAddPlan,
  checkPlanRow,
  checkPlans,
  emptyPlansForm,
  endPlanDialog,
  endingPlanLines,
  hasPlanErrors,
  noPlanErrors,
  planCentsOf,
  planChangedNote,
  planEarnLine,
  planFieldErrors,
  planLimitsOf,
  planPerUseLine,
  planSaleLine,
  planSaleLines,
  plansFormOf,
  plansKeptLine,
  plansProblem,
  partSavedLine,
  plansRefusedLine,
  plansSaveOf,
  removePlanLabel,
  removePlanRow,
  savedPlansOf,
  sellsWithPlans,
  withPlanRow,
  type PlanRow,
  type PlansForm,
  type SavedPlan,
} from "./sell-plans";

const PER_USE: SellForm = { ...emptySellForm(), choice: "per_use", perUsePrice: "0.05" };

function saved(over: Partial<SavedPlan> = {}): SavedPlan {
  return {
    id: "p1",
    kind: "paid",
    status: "active",
    name: "Starter",
    priceCents: 900,
    includedUses: 500,
    extraUsePriceCents: null,
    subscribers: 0,
    ...over,
  };
}

function row(over: Partial<PlanRow> = {}): PlanRow {
  return { key: "new-1", id: null, name: "Starter", price: "9.00", uses: "500", ending: "stop", extraPrice: "", ...over };
}

const STARTER = saved();
const PRO = saved({ id: "p2", name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: 7, subscribers: 12 });

test("the words of the block are the design's", () => {
  assert.deepEqual(PLAN_WORDS, {
    title: "Plans",
    name: "Name",
    price: "Price for 30 days",
    uses: "Uses included",
    whenOut: "When they run out",
    stop: "Stop until the next 30 days",
    extra: "Charge for each extra use",
    extraPrice: "Price for each extra use",
    add: "Add a plan",
    remove: "Remove",
    end: "End plan",
    endTitle: "End this plan?",
    noUnlimited: "No plan is unlimited.",
    changed: "People already on this plan keep what they agreed to.",
    notSaved: "Your listing was saved. Its plans were not.",
  });
});

test("the limits come from the capabilities, and are the API's own when they could not be read", () => {
  assert.deepEqual(DEFAULT_PLAN_LIMITS, { maxPlans: 4, maxIncludedUses: 6000, minPlanPriceCents: 100, minExtraUsePriceCents: 5 });
  assert.deepEqual(planLimitsOf(null), DEFAULT_PLAN_LIMITS);
  assert.deepEqual(planLimitsOf({}), DEFAULT_PLAN_LIMITS);
  assert.deepEqual(
    planLimitsOf({ paidUse: { maxPlans: 3, maxIncludedUses: 100_000, minPlanPriceCents: 200, minExtraUsePriceCents: 7 } }),
    { maxPlans: 3, maxIncludedUses: 100_000, minPlanPriceCents: 200, minExtraUsePriceCents: 7 },
  );
  // A number that is not a whole positive one is not believed.
  assert.deepEqual(planLimitsOf({ paidUse: { maxPlans: 0, maxIncludedUses: "many", minPlanPriceCents: 1.5 } }), DEFAULT_PLAN_LIMITS);
  assert.equal(PLAN_NAME_MAX, 40);
});

test("dollars typed become whole cents exactly", () => {
  assert.equal(planCentsOf("9.99"), 999);
  assert.equal(planCentsOf("0.07"), 7);
  assert.equal(planCentsOf("9"), 900);
  assert.equal(planCentsOf(" 9.5 "), 950);
  assert.equal(planCentsOf("19.99"), 1999);
  // Amounts that a multiplication by 100 gets wrong by a hair.
  assert.equal(planCentsOf("1.15"), 115);
  assert.equal(planCentsOf("4.35"), 435);
  assert.equal(planCentsOf("8.20"), 820);
  assert.equal(planCentsOf("1005.01"), 100_501);
  for (const text of ["9.999", "1e3", "-1", "abc", "", "  ", "$9", "9.", ".5", "1,000", "0x10", "9.9.9"]) {
    assert.equal(planCentsOf(text), null, text);
  }
});

test("a row is checked field by field, with a sentence under each", () => {
  assert.deepEqual(checkPlanRow(row()), {
    ok: true,
    plan: { kind: "paid", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: null },
  });
  assert.deepEqual(checkPlanRow(row({ id: "p1", key: "p1", name: "  Pro  ", ending: "extra", extraPrice: "0.07" })), {
    ok: true,
    plan: { id: "p1", kind: "paid", name: "Pro", priceCents: 900, includedUses: 500, extraUsePriceCents: 7 },
  });
  // A price typed for an extra use is not sent once "Stop" is chosen.
  assert.deepEqual(checkPlanRow(row({ ending: "stop", extraPrice: "0.07" })), {
    ok: true,
    plan: { kind: "paid", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: null },
  });

  const errorsOf = (over: Partial<PlanRow>) => {
    const checked = checkPlanRow(row(over));
    assert.equal(checked.ok, false);
    return checked.ok ? {} : checked.errors;
  };
  assert.deepEqual(errorsOf({ name: "   " }), { name: "Give the plan a name." });
  assert.deepEqual(errorsOf({ name: "x".repeat(41) }), { name: "The name of a plan can be at most 40 characters." });
  assert.equal(checkPlanRow(row({ name: "x".repeat(40) })).ok, true);
  assert.equal(checkPlanRow(row({ name: ` ${"x".repeat(40)} ` })).ok, true);

  assert.deepEqual(errorsOf({ price: "" }), { price: "Enter a price for 30 days." });
  for (const price of ["9.999", "1e3", "-1", "abc"]) {
    assert.deepEqual(errorsOf({ price }), { price: "Enter the price for 30 days in dollars and cents, like 1.00." }, price);
  }
  assert.deepEqual(errorsOf({ price: "0.99" }), { price: "The price for 30 days must be at least $1.00." });
  assert.equal(checkPlanRow(row({ price: "1.00", uses: "100" })).ok, true);
  assert.deepEqual(errorsOf({ price: "100000.01" }), { price: "The price for 30 days can be at most $100,000.00." });

  assert.deepEqual(errorsOf({ uses: "" }), { uses: "Enter how many uses the plan includes." });
  for (const uses of ["1.5", "abc", "-3", "1e3"]) {
    assert.deepEqual(errorsOf({ uses }), { uses: "Enter the uses as a whole number, like 500." }, uses);
  }
  assert.deepEqual(errorsOf({ uses: "0" }), { uses: "A plan includes between 1 and 6,000 uses." });
  assert.deepEqual(errorsOf({ uses: "6001" }), { uses: "A plan includes between 1 and 6,000 uses." });
  assert.deepEqual(errorsOf({ uses: "99999999999999" }), { uses: "A plan includes between 1 and 6,000 uses." });
  assert.equal(checkPlanRow(row({ price: "60.00", uses: "6000" })).ok, true);

  assert.deepEqual(errorsOf({ ending: "extra", extraPrice: "" }), { extraPrice: "Enter a price for each extra use." });
  assert.deepEqual(errorsOf({ ending: "extra", extraPrice: "0.049" }), {
    extraPrice: "Enter the price for each extra use in dollars and cents, like 0.05.",
  });
  assert.deepEqual(errorsOf({ ending: "extra", extraPrice: "0.04" }), {
    extraPrice: "The price for each extra use must be at least $0.05.",
  });
  assert.deepEqual(errorsOf({ ending: "extra", extraPrice: "1000.01" }), {
    extraPrice: "The price for each extra use can be at most $1,000.00.",
  });

  // Every problem of a row at once.
  assert.deepEqual(errorsOf({ name: "", price: "", uses: "", ending: "extra", extraPrice: "" }), {
    name: "Give the plan a name.",
    price: "Enter a price for 30 days.",
    uses: "Enter how many uses the plan includes.",
    extraPrice: "Enter a price for each extra use.",
  });
});

test("the checks use the numbers they are given", () => {
  const limits = { maxPlans: 2, maxIncludedUses: 100_000, minPlanPriceCents: 500, minExtraUsePriceCents: 10 };
  const errorsOf = (over: Partial<PlanRow>) => {
    const checked = checkPlanRow(row(over), limits);
    return checked.ok ? {} : checked.errors;
  };
  assert.deepEqual(errorsOf({ price: "4.99" }), { price: "The price for 30 days must be at least $5.00." });
  assert.deepEqual(errorsOf({ price: "x" }), { price: "Enter the price for 30 days in dollars and cents, like 5.00." });
  assert.deepEqual(errorsOf({ uses: "100001" }), { uses: "A plan includes between 1 and 100,000 uses." });
  assert.deepEqual(errorsOf({ ending: "extra", extraPrice: "0.09" }), {
    extraPrice: "The price for each extra use must be at least $0.10.",
  });
  const three = { rows: [row({ key: "new-1" }), row({ key: "new-2" }), row({ key: "new-3" })] };
  const checked = checkPlans(three, limits);
  assert.deepEqual(checked, { ok: false, errors: { set: "A listing can have at most 2 plans.", rows: {} } });
});

test("the rule of a cent for each use is the API's to say, not this file's", () => {
  // $9.00 with 6,000 uses is refused by the API in a sentence; it passes here.
  assert.equal(checkPlanRow(row({ price: "9.00", uses: "6000" })).ok, true);
});

test("rows are added up to the maximum, removed, and changed in place", () => {
  let form = emptyPlansForm();
  assert.deepEqual(form, { loaded: true, rows: [] });
  form = addPlanRow(form);
  assert.deepEqual(form.rows, [{ key: "new-1", id: null, name: "", price: "", uses: "", ending: "stop", extraPrice: "" }]);
  form = addPlanRow(addPlanRow(addPlanRow(form)));
  assert.deepEqual(form.rows.map((r) => r.key), ["new-1", "new-2", "new-3", "new-4"]);
  assert.equal(canAddPlan(form), false);
  assert.equal(addPlanRow(form), form);
  assert.equal(canAddPlan(form, { ...DEFAULT_PLAN_LIMITS, maxPlans: 5 }), true);

  form = removePlanRow(form, "new-2");
  assert.deepEqual(form.rows.map((r) => r.key), ["new-1", "new-3", "new-4"]);
  // A key is never given to two rows at once.
  assert.deepEqual(addPlanRow(form).rows.map((r) => r.key), ["new-1", "new-3", "new-4", "new-5"]);

  const changed = withPlanRow(form, "new-3", { name: "Pro", ending: "extra" });
  assert.equal(changed.rows[1]!.name, "Pro");
  assert.equal(changed.rows[1]!.ending, "extra");
  assert.equal(changed.rows[0], form.rows[0]);
  // The id and the key are the row's own.
  const sneaky = withPlanRow(plansFormOf({ plans: [STARTER] }), "p1", { name: "X", ...({ id: "other", key: "k" } as object) });
  assert.equal(sneaky.rows[0]!.id, "p1");
  assert.equal(sneaky.rows[0]!.key, "p1");

  // Plans that were not read take no rows.
  const unread: PlansForm = { loaded: false, rows: [] };
  assert.equal(canAddPlan(unread), false);
  assert.equal(addPlanRow(unread), unread);
});

test("the rows of a listing are its paid plans on offer, and a listing without its plans is not loaded", () => {
  assert.deepEqual(plansFormOf(null), { loaded: true, rows: [] });
  assert.deepEqual(plansFormOf({}), { loaded: false, rows: [] });
  assert.deepEqual(plansFormOf({ plans: null }), { loaded: false, rows: [] });
  assert.deepEqual(plansFormOf({ plans: [] }), { loaded: true, rows: [] });
  assert.deepEqual(plansFormOf({ plans: [STARTER, PRO] }), {
    loaded: true,
    rows: [
      { key: "p1", id: "p1", name: "Starter", price: "9.00", uses: "500", ending: "stop", extraPrice: "" },
      { key: "p2", id: "p2", name: "Pro", price: "29.00", uses: "2000", ending: "extra", extraPrice: "0.07" },
    ],
  });
  // A plan that came without its ending stops; it is never read as one that charges.
  const bare = { ...STARTER, extraUsePriceCents: undefined as unknown as null };
  assert.deepEqual(plansFormOf({ plans: [bare] }).rows, [
    { key: "p1", id: "p1", name: "Starter", price: "9.00", uses: "500", ending: "stop", extraPrice: "" },
  ]);
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: plansFormOf({ plans: [bare] }), saved: [bare] }), { kind: "none" });
  assert.equal(savedPlansOf(null)?.length, 0);
  assert.equal(savedPlansOf({}), null);
  // A trial and an ended plan are not rows: neither is set here.
  assert.deepEqual(
    savedPlansOf({ plans: [STARTER, saved({ id: "t", kind: "trial" }), saved({ id: "r", status: "retired" })] }),
    [STARTER],
  );
});

test("a save sends the whole set: ids kept, the extra price always said, a removed row absent", () => {
  const form = plansFormOf({ plans: [STARTER, PRO] });
  const edited = addPlanRow(withPlanRow(removePlanRow(form, "p1"), "p2", { price: "39.00" }));
  const filled = withPlanRow(edited, "new-1", { name: "Team", price: "99", uses: "5000", ending: "extra", extraPrice: "0.05" });
  const save = plansSaveOf({ sell: PER_USE, form: filled, saved: [STARTER, PRO] });
  assert.deepEqual(save, {
    kind: "send",
    plans: [
      { id: "p2", kind: "paid", name: "Pro", priceCents: 3900, includedUses: 2000, extraUsePriceCents: 7 },
      { kind: "paid", name: "Team", priceCents: 9900, includedUses: 5000, extraUsePriceCents: 5 },
    ],
  });
  assert.ok(save.kind === "send");
  // The removed plan is absent, which ends it; a new plan carries no id.
  assert.equal(save.plans.some((plan) => plan.id === "p1"), false);
  assert.equal("id" in save.plans[1]!, false);

  // "Stop" is said as null, never left out.
  const stop = plansSaveOf({ sell: PER_USE, form: withPlanRow(form, "p2", { ending: "stop" }), saved: [STARTER, PRO] });
  assert.ok(stop.kind === "send");
  for (const plan of stop.plans) assert.equal(Object.prototype.hasOwnProperty.call(plan, "extraUsePriceCents"), true);
  assert.deepEqual(stop.plans.map((plan) => plan.extraUsePriceCents), [null, null]);
  assert.deepEqual(stop.plans.map((plan) => plan.id), ["p1", "p2"]);
  assert.deepEqual(JSON.parse(JSON.stringify(stop.plans[0])), {
    id: "p1",
    kind: "paid",
    name: "Starter",
    priceCents: 900,
    includedUses: 500,
    extraUsePriceCents: null,
  });

  // Every plan removed: the empty set is sent, and it ends them all.
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: { loaded: true, rows: [] }, saved: [STARTER, PRO] }), {
    kind: "send",
    plans: [],
  });
});

test("nothing is sent when nothing changed, when the plans were never read, or off Pay per use", () => {
  const form = plansFormOf({ plans: [STARTER, PRO] });
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form, saved: [STARTER, PRO] }), { kind: "none" });
  // The same amount typed another way is no change.
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: withPlanRow(form, "p1", { price: "9", name: " Starter " }), saved: [STARTER, PRO] }), {
    kind: "none",
  });
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: emptyPlansForm(), saved: [] }), { kind: "none" });

  // Never read: an empty set would end every plan, so no set is made at all.
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: { loaded: false, rows: [] }, saved: null }), { kind: "none" });
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: emptyPlansForm(), saved: null }), { kind: "none" });
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: { loaded: false, rows: [row()] }, saved: [STARTER] }), { kind: "none" });

  // Another choice, or copies: the plans are not this save's.
  const changed = withPlanRow(form, "p1", { price: "19.00" });
  for (const choice of ["free", "monthly", "token_holders"] as const) {
    assert.deepEqual(plansSaveOf({ sell: { sells: "use", choice }, form: changed, saved: [STARTER, PRO] }), { kind: "none" }, choice);
  }
  assert.deepEqual(plansSaveOf({ sell: { sells: "copies", choice: "per_use" }, form: changed, saved: [STARTER, PRO] }), { kind: "none" });
  assert.equal(sellsWithPlans(PER_USE), true);
  assert.equal(sellsWithPlans({ sells: "copies", choice: "per_use" }), false);
  assert.equal(sellsWithPlans({ sells: "use", choice: "monthly" }), false);

  // Plans as the server gave them are not refused here, whatever the limits are now.
  const strict = { ...DEFAULT_PLAN_LIMITS, minPlanPriceCents: 5000 };
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form, saved: [STARTER, PRO], limits: strict }), { kind: "none" });
});

test("a row that cannot be sent stops the save, and the first problem names its plan", () => {
  const form = addPlanRow(plansFormOf({ plans: [STARTER] }));
  const save = plansSaveOf({ sell: PER_USE, form, saved: [STARTER] });
  assert.deepEqual(save, {
    kind: "invalid",
    errors: {
      rows: {
        1: {
          name: "Give the plan a name.",
          price: "Enter a price for 30 days.",
          uses: "Enter how many uses the plan includes.",
        },
      },
    },
  });
  assert.equal(plansProblem({ sell: PER_USE, form, saved: [STARTER] }), "Plan 2: Give the plan a name.");
  assert.equal(
    plansProblem({ sell: PER_USE, form: withPlanRow(form, "new-1", { name: "Pro", uses: "10" }), saved: [STARTER] }),
    "Plan 2: Enter a price for 30 days.",
  );
  assert.equal(plansProblem({ sell: PER_USE, form: plansFormOf({ plans: [STARTER] }), saved: [STARTER] }), null);
  assert.equal(plansProblem({ sell: { sells: "use", choice: "free" }, form, saved: [STARTER] }), null);
  const five: PlansForm = { loaded: true, rows: [1, 2, 3, 4, 5].map((n) => row({ key: `new-${n}` })) };
  assert.equal(plansProblem({ sell: PER_USE, form: five, saved: [] }), "A listing can have at most 4 plans.");
});

test("the API's sentences go under the field of the row they are about", () => {
  // Every key checkPlanSet (apps/api/src/services/listingPlans.ts) can send.
  const errors = planFieldErrors({
    plans: "A listing can have at most 4 plans.",
    "plans[0].name": "Give the plan a name.",
    "plans[0].priceCents": "The price for 30 days must be at least $1.00.",
    "plans[1].includedUses": "At $9.00 a plan can include at most 900 uses.",
    "plans[1].extraUsePriceCents": "The price for each extra use must be at least $0.05.",
    "plans[2].id": "This plan is no longer on the listing. Reload the page and try again.",
    "plans[3].kind": "Free trials are not available yet.",
  });
  assert.deepEqual(errors, {
    set: "A listing can have at most 4 plans.",
    rows: {
      0: { name: "Give the plan a name.", price: "The price for 30 days must be at least $1.00." },
      1: {
        uses: "At $9.00 a plan can include at most 900 uses.",
        extraPrice: "The price for each extra use must be at least $0.05.",
      },
      2: { row: "This plan is no longer on the listing. Reload the page and try again." },
      3: { row: "Free trials are not available yet." },
    },
  });
  assert.equal(hasPlanErrors(errors), true);

  // The first sentence of a field is the one kept; a field that is not a plan's is left out.
  assert.deepEqual(planFieldErrors({ "plans[0].id": "This plan is in the list twice.", "plans[0].kind": "A plan is either paid or a free trial." }), {
    rows: { 0: { row: "This plan is in the list twice." } },
  });
  const none = planFieldErrors({ body: "Send the request as a JSON object.", title: "x", "plans[0].__proto__": "x", "plans[0].colour": "x" });
  assert.deepEqual(none, noPlanErrors());
  assert.equal(hasPlanErrors(none), false);
});

test("a refusal after the listing was saved says both, plainly", () => {
  assert.equal(plansRefusedLine(), "Your listing was saved. Its plans were not.");
  assert.equal(plansRefusedLine("  "), "Your listing was saved. Its plans were not.");
  assert.equal(
    plansRefusedLine("These plans were changed by another save at the same moment. Reload the page and try again."),
    "Your listing was saved. Its plans were not. These plans were changed by another save at the same moment. Reload the page and try again.",
  );
});

test("a save that went through in part says every part that did not", () => {
  const refused = plansRefusedLine("Reload the page and try again.");
  assert.equal(partSavedLine(null, null), null);
  assert.equal(partSavedLine(refused, null), "Your listing was saved. Its plans were not. Reload the page and try again.");
  // Word for word what the Sell tab said before it had plans.
  assert.equal(partSavedLine(null, "Try again."), "Your choice was saved. The setting to keep a copy was not: Try again.");
  assert.equal(
    partSavedLine(plansRefusedLine(), "Try again."),
    "Your listing was saved. Its plans were not. The setting to keep a copy was not saved: Try again.",
  );
});

test("what a plan earns, from the API's own split", () => {
  assert.equal(planEarnLine(row({ price: "9.00" })), "You earn $8.10 of each $9.00.");
  assert.equal(planEarnLine(row({ price: "9" })), "You earn $8.10 of each $9.00.");
  assert.equal(planEarnLine(row({ price: "29.99" })), `You earn $${(splitCents(2999).creatorCents / 100).toFixed(2)} of each $29.99.`);
  assert.equal(planEarnLine(row({ price: "1.05" })), "You earn $0.94 of each $1.05.");
  // Nothing is said to be earned at a price that cannot be sold or read.
  assert.equal(planEarnLine(row({ price: "0.99" })), null);
  assert.equal(planEarnLine(row({ price: "" })), null);
  assert.equal(planEarnLine(row({ price: "abc" })), null);
  assert.equal(planEarnLine(row({ price: "4.00" }), { ...DEFAULT_PLAN_LIMITS, minPlanPriceCents: 500 }), null);
});

test("what a use of a plan comes to, beside the price per use typed in the same form", () => {
  assert.equal(planPerUseLine(row({ price: "9.00", uses: "500" }), "0.05"), "That is $0.018 a use. Pay per use is $0.05.");
  assert.equal(planPerUseLine(row({ price: "9.00", uses: "900" }), "0.05"), "That is $0.01 a use. Pay per use is $0.05.");
  assert.equal(planPerUseLine(row({ price: "29.00", uses: "2000" }), "0.1"), "That is $0.015 a use. Pay per use is $0.10.");
  assert.equal(planPerUseLine(row({ price: "5000", uses: "2" }), "0.05"), "That is $2,500.00 a use. Pay per use is $0.05.");
  assert.equal(planPerUseLine(row({ price: "2500.25", uses: "2" }), "0.05"), "That is $1,250.125 a use. Pay per use is $0.05.");
  // To a tenth of a cent, a half going up: 900 / 700 is 1.2857 cents, 100 / 800 is 0.125.
  assert.equal(planPerUseLine(row({ price: "9.00", uses: "700" }), "0.05"), "That is $0.013 a use. Pay per use is $0.05.");
  assert.equal(planPerUseLine(row({ price: "1.00", uses: "800" }), "0.05"), "That is $0.001 a use. Pay per use is $0.05.");
  // No price per use typed yet: only the first sentence.
  assert.equal(planPerUseLine(row({ price: "9.00", uses: "500" }), ""), "That is $0.018 a use.");
  assert.equal(planPerUseLine(row({ price: "9.00", uses: "500" }), "abc"), "That is $0.018 a use.");
  // Nothing to divide yet.
  assert.equal(planPerUseLine(row({ price: "", uses: "500" }), "0.05"), null);
  assert.equal(planPerUseLine(row({ price: "9.00", uses: "" }), "0.05"), null);
  assert.equal(planPerUseLine(row({ price: "9.00", uses: "0" }), "0.05"), null);
  assert.equal(planPerUseLine(row({ price: "0", uses: "10" }), "0.05"), null);
  // Less than a tenth of a cent is not shown as $0.000.
  assert.equal(planPerUseLine(row({ price: "1.00", uses: "6000" }), "0.05"), null);
});

test("one line for each plan of a listing on sale per use, with its subscribers in plain words", () => {
  assert.equal(planSaleLine(saved({ subscribers: 12 })), "Starter. $9.00 for 30 days. 500 uses. 12 subscribers.");
  assert.equal(planSaleLine(saved({ subscribers: 1 })), "Starter. $9.00 for 30 days. 500 uses. 1 subscriber.");
  assert.equal(planSaleLine(saved()), "Starter. $9.00 for 30 days. 500 uses. No subscribers.");
  assert.equal(
    planSaleLine(saved({ name: " Team ", priceCents: 129_900, includedUses: 6000, subscribers: 1234 })),
    "Team. $1,299.00 for 30 days. 6,000 uses. 1,234 subscribers.",
  );
  assert.equal(planSaleLine(saved({ includedUses: 1 })), "Starter. $9.00 for 30 days. 1 use. No subscribers.");

  const listing = { sells: "use", pricingModel: "per_request", plans: [STARTER, PRO] };
  assert.deepEqual(planSaleLines(listing), [
    { id: "p1", line: "Starter. $9.00 for 30 days. 500 uses. No subscribers." },
    { id: "p2", line: "Pro. $29.00 for 30 days. 2,000 uses. 12 subscribers." },
  ]);
  // No plan, plans not read, another price, copies, no listing: no line, and the screen is today's.
  assert.deepEqual(planSaleLines({ ...listing, plans: [] }), []);
  assert.deepEqual(planSaleLines({ sells: "use", pricingModel: "per_request" }), []);
  assert.deepEqual(planSaleLines({ ...listing, pricingModel: "monthly" }), []);
  assert.deepEqual(planSaleLines({ ...listing, sells: "copies" }), []);
  assert.deepEqual(planSaleLines(null), []);
});

test("ending a plan that has subscribers asks first; one with none, and a new row, do not", () => {
  assert.deepEqual(endPlanDialog({ id: "p2" }, [STARTER, PRO]), {
    title: "End this plan?",
    description: "12 subscribers keep this plan until the 30 days they paid for end. They are not charged again.",
    confirmLabel: "End plan",
  });
  assert.equal(
    endPlanDialog({ id: "p1" }, [saved({ subscribers: 1 })])?.description,
    "1 subscriber keeps this plan until the 30 days they paid for end. They are not charged again.",
  );
  assert.equal(endPlanDialog({ id: "p1" }, [STARTER, PRO]), null);
  assert.equal(endPlanDialog({ id: null }, [STARTER, PRO]), null);
  assert.equal(endPlanDialog({ id: "p2" }, null), null);

  assert.equal(removePlanLabel({ id: null }), "Remove");
  assert.equal(removePlanLabel({ id: "p1" }), "End plan");

  // A plan is ended by the save, and until then the block says which.
  const form = removePlanRow(plansFormOf({ plans: [STARTER, PRO] }), "p2");
  assert.deepEqual(endingPlanLines(form, [STARTER, PRO]), ["Pro ends when you save."]);
  assert.deepEqual(endingPlanLines(plansFormOf({ plans: [STARTER, PRO] }), [STARTER, PRO]), []);
  assert.deepEqual(endingPlanLines({ loaded: false, rows: [] }, [STARTER]), []);
  assert.deepEqual(endingPlanLines(emptyPlansForm(), null), []);
});

test("changing a plan that has subscribers says they keep what they agreed to", () => {
  const form = plansFormOf({ plans: [STARTER, PRO] });
  const pro = form.rows[1]!;
  assert.equal(planChangedNote(pro, [STARTER, PRO]), null);
  assert.equal(planChangedNote({ ...pro, price: "39.00" }, [STARTER, PRO]), "People already on this plan keep what they agreed to.");
  assert.equal(planChangedNote({ ...pro, ending: "stop" }, [STARTER, PRO]), "People already on this plan keep what they agreed to.");
  // Nobody is on Starter, and nobody can be on a new row.
  assert.equal(planChangedNote({ ...form.rows[0]!, price: "19.00" }, [STARTER, PRO]), null);
  assert.equal(planChangedNote(row({ price: "1.00" }), [STARTER, PRO]), null);
  assert.equal(planChangedNote({ ...pro, price: "39.00" }, null), null);
});

test("moving a listing on sale away from Pay per use says what the people on its plans keep", () => {
  const listing = { sells: "use", pricingModel: "per_request", status: "published", plans: [STARTER, PRO] };
  const monthly = { sells: "use", choice: "monthly" } as const;
  assert.equal(
    plansKeptLine(listing, monthly),
    "12 subscribers keep their plan until the 30 days they paid for end and are not charged again.",
  );
  assert.equal(
    plansKeptLine({ ...listing, plans: [saved({ subscribers: 1 })] }, { sells: "use", choice: "free" }),
    "1 subscriber keeps their plan until the 30 days they paid for end and is not charged again.",
  );
  // Still Pay per use, nobody on a plan, not on sale, or not sold per use: nothing to say.
  assert.equal(plansKeptLine(listing, PER_USE), null);
  assert.equal(plansKeptLine({ ...listing, plans: [STARTER] }, monthly), null);
  assert.equal(plansKeptLine({ ...listing, plans: undefined }, monthly), null);
  assert.equal(plansKeptLine({ ...listing, status: "draft" }, monthly), null);
  assert.equal(plansKeptLine({ ...listing, pricingModel: "monthly" }, monthly), null);
  assert.equal(plansKeptLine({ ...listing, sells: "copies" }, monthly), null);
  assert.equal(plansKeptLine(null, monthly), null);
  // Selling copies instead is told in its own dialog.
  assert.equal(plansKeptLine(listing, { sells: "copies", choice: "per_use" }), null);
});

test("no sentence here has an em dash, a raw error code, or the word unlimited outside its one line", () => {
  const form = addPlanRow(plansFormOf({ plans: [STARTER, PRO] }));
  const bad = checkPlanRow(row({ name: "", price: "x", uses: "x", ending: "extra", extraPrice: "x" }));
  const sentences: string[] = [
    ...Object.values(PLAN_WORDS),
    ...Object.values(bad.ok ? {} : bad.errors),
    plansProblem({ sell: PER_USE, form, saved: [STARTER, PRO] }) ?? "",
    plansRefusedLine("x"),
    partSavedLine(plansRefusedLine(), "x") ?? "",
    partSavedLine(null, "x") ?? "",
    planEarnLine(row()) ?? "",
    planPerUseLine(row(), "0.05") ?? "",
    planSaleLine(PRO),
    endPlanDialog({ id: "p2" }, [PRO])?.description ?? "",
    ...endingPlanLines(emptyPlansForm(), [PRO]),
    plansKeptLine({ sells: "use", pricingModel: "per_request", status: "published", plans: [PRO] }, { sells: "use", choice: "free" }) ?? "",
  ];
  const emDash = String.fromCharCode(0x2014);
  for (const sentence of sentences) {
    assert.ok(sentence.length > 0);
    assert.equal(sentence.includes(emDash), false, sentence);
    assert.equal(/validation_failed|plans_not_available|plans_changed|[a-z]+_[a-z]+/.test(sentence), false, sentence);
    assert.equal(/token|model|organization/i.test(sentence), false, sentence);
    if (sentence !== PLAN_WORDS.noUnlimited) assert.equal(/unlimited/i.test(sentence), false, sentence);
  }
});
