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
  PLANS_RELOAD_WORDS,
  PLAN_WORDS,
  TRIAL_WORDS,
  addPlanRow,
  canAddPlan,
  checkPlanRow,
  checkPlans,
  checkTrial,
  emptyPlansForm,
  endPlanDialog,
  endTrialDialog,
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
  plansReloadOffered,
  plansSaveOf,
  removePlanLabel,
  removePlanRow,
  savedPlansOf,
  savedTrialOf,
  sellsWithPlans,
  trialEndingLine,
  trialFormOf,
  trialNote,
  trialProblemOf,
  trialSaleLine,
  withPlanRow,
  withTrial,
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
/** The listing's free trial as its creator reads it: first in the list, named by the API, with the people on it now. */
const TRIAL = saved({ id: "t1", kind: "trial", name: "Free trial", priceCents: 0, includedUses: 20, extraUsePriceCents: null, subscribers: 3 });

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
  assert.deepEqual(DEFAULT_PLAN_LIMITS, {
    maxPlans: 4,
    maxIncludedUses: 100_000,
    minPlanPriceCents: 100,
    minExtraUsePriceCents: 5,
    maxTrialUses: 50,
    trialDays: 7,
  });
  assert.deepEqual(planLimitsOf(null), DEFAULT_PLAN_LIMITS);
  assert.deepEqual(planLimitsOf({}), DEFAULT_PLAN_LIMITS);
  assert.deepEqual(
    planLimitsOf({
      paidUse: { maxPlans: 3, maxIncludedUses: 100_000, minPlanPriceCents: 200, minExtraUsePriceCents: 7, maxTrialUses: 30, trialDays: 5 },
    }),
    { maxPlans: 3, maxIncludedUses: 100_000, minPlanPriceCents: 200, minExtraUsePriceCents: 7, maxTrialUses: 30, trialDays: 5 },
  );
  // An API that says nothing of a trial yet: its numbers are the API's own.
  assert.deepEqual(
    planLimitsOf({ paidUse: { maxPlans: 3, maxIncludedUses: 100_000, minPlanPriceCents: 200, minExtraUsePriceCents: 7 } }),
    { maxPlans: 3, maxIncludedUses: 100_000, minPlanPriceCents: 200, minExtraUsePriceCents: 7, maxTrialUses: 50, trialDays: 7 },
  );
  assert.deepEqual(planLimitsOf({ paidUse: { maxTrialUses: 0, trialDays: "a week" } }), DEFAULT_PLAN_LIMITS);
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
  assert.deepEqual(errorsOf({ uses: "0" }), { uses: "A plan includes between 1 and 100,000 uses." });
  assert.deepEqual(errorsOf({ uses: "100001" }), { uses: "A plan includes between 1 and 100,000 uses." });
  assert.deepEqual(errorsOf({ uses: "99999999999999" }), { uses: "A plan includes between 1 and 100,000 uses." });
  assert.equal(checkPlanRow(row({ price: "60.00", uses: "6001" })).ok, true);
  assert.equal(checkPlanRow(row({ price: "1000.00", uses: "100000" })).ok, true);

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
  const limits = { ...DEFAULT_PLAN_LIMITS, maxPlans: 2, minPlanPriceCents: 500, minExtraUsePriceCents: 10 };
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
  // An ended plan is not on offer. The free trial is, and it is read with the paid plans, but it is never a row.
  const mixed = { plans: [TRIAL, STARTER, saved({ id: "r", status: "retired" }), saved({ id: "x", kind: "other" })] };
  assert.deepEqual(savedPlansOf(mixed), [TRIAL, STARTER]);
  assert.deepEqual(plansFormOf(mixed).rows.map((one) => one.id), ["p1"]);
});

// ============================================
// The free trial
// ============================================

/** The trial entry of a save, or null when the save carries none. */
function trialSent(save: ReturnType<typeof plansSaveOf>) {
  assert.ok(save.kind === "send");
  const trials = save.plans.filter((plan) => plan.kind === "trial");
  assert.ok(trials.length <= 1);
  return trials[0] ?? null;
}

test("the words of the free trial's part are the design's", () => {
  assert.deepEqual(TRIAL_WORDS, {
    name: "Free trial",
    offer: "Offer a free trial",
    uses: "Uses in the trial",
    endTitle: "Stop offering the free trial?",
    end: "Stop offering it",
    ending: "The free trial stops being offered when you save.",
  });
  assert.equal(trialNote(), "A buyer can try it once, for 7 days. Nothing is charged, and you are not paid for these uses.");
  // The number of days is the capabilities' to say.
  assert.equal(
    trialNote({ ...DEFAULT_PLAN_LIMITS, trialDays: 14 }),
    "A buyer can try it once, for 14 days. Nothing is charged, and you are not paid for these uses.",
  );
  assert.equal(
    trialNote({ ...DEFAULT_PLAN_LIMITS, trialDays: 1 }),
    "A buyer can try it once, for 1 day. Nothing is charged, and you are not paid for these uses.",
  );
});

test("the trial of a form is the listing's own, and a listing with no trial has none in its form", () => {
  // No trial: the form is the one it was, key for key.
  assert.equal("trial" in plansFormOf({ plans: [STARTER] }), false);
  assert.equal("trial" in emptyPlansForm(), false);
  assert.deepEqual(trialFormOf(emptyPlansForm()), { on: false, id: null, uses: "" });
  assert.equal(savedTrialOf([STARTER, PRO]), null);
  assert.equal(savedTrialOf(null), null);

  const form = plansFormOf({ plans: [TRIAL, STARTER, PRO] });
  assert.deepEqual(form.trial, { on: true, id: "t1", uses: "20" });
  assert.deepEqual(form.rows.map((one) => one.id), ["p1", "p2"]);
  assert.equal(savedTrialOf([TRIAL, STARTER]), TRIAL);
  // A trial that is no longer on offer is not the listing's trial.
  assert.equal("trial" in plansFormOf({ plans: [{ ...TRIAL, status: "retired" }, STARTER] }), false);

  // The switch and the box change; the id is the trial's own, and the rows are untouched.
  const off = withTrial(form, { on: false });
  assert.deepEqual(off.trial, { on: false, id: "t1", uses: "20" });
  assert.equal(off.rows, form.rows);
  assert.deepEqual(withTrial(off, { on: true, uses: "30" }).trial, { on: true, id: "t1", uses: "30" });
  assert.deepEqual(withTrial(emptyPlansForm(), { on: true }), { loaded: true, rows: [], trial: { on: true, id: null, uses: "" } });
  // The trial does not count among the four paid plans.
  let full = plansFormOf({ plans: [TRIAL] });
  for (let i = 0; i < 4; i += 1) full = addPlanRow(full);
  assert.equal(full.rows.length, 4);
  assert.equal(canAddPlan(plansFormOf({ plans: [TRIAL, STARTER, PRO] })), true);
});

test("the trial's box is checked only while the switch is on", () => {
  const typed = (uses: string, on = true) => checkTrial({ trial: { on, id: null, uses } });
  assert.deepEqual(typed("20"), { ok: true, plan: { kind: "trial", priceCents: 0, includedUses: 20, extraUsePriceCents: null } });
  assert.deepEqual(typed(" 1 "), { ok: true, plan: { kind: "trial", priceCents: 0, includedUses: 1, extraUsePriceCents: null } });
  assert.deepEqual(typed("50"), { ok: true, plan: { kind: "trial", priceCents: 0, includedUses: 50, extraUsePriceCents: null } });
  assert.deepEqual(typed(""), { ok: false, error: "Enter how many uses the trial includes." });
  assert.deepEqual(typed("   "), { ok: false, error: "Enter how many uses the trial includes." });
  for (const text of ["x", "2.5", "-1", "1e1"]) {
    assert.deepEqual(typed(text), { ok: false, error: "Enter the uses as a whole number, like 20." }, text);
  }
  for (const text of ["0", "51", "99999999999"]) {
    assert.deepEqual(typed(text), { ok: false, error: "A free trial includes between 1 and 50 uses." }, text);
  }
  // The most is the number the capabilities give.
  const limits = { ...DEFAULT_PLAN_LIMITS, maxTrialUses: 30 };
  assert.deepEqual(checkTrial({ trial: { on: true, id: null, uses: "31" } }, limits), {
    ok: false,
    error: "A free trial includes between 1 and 30 uses.",
  });
  assert.equal(checkTrial({ trial: { on: true, id: null, uses: "30" } }, limits).ok, true);
  // Off: nothing is read, whatever sits in the box. No trial in the form: the same.
  assert.deepEqual(typed("x", false), { ok: true, plan: null });
  assert.deepEqual(typed("", false), { ok: true, plan: null });
  assert.deepEqual(checkTrial({}), { ok: true, plan: null });
  // A trial the listing offers keeps its id; a trial never carries a name.
  const kept = checkTrial({ trial: { on: true, id: "t1", uses: "25" } });
  assert.deepEqual(kept, { ok: true, plan: { id: "t1", kind: "trial", priceCents: 0, includedUses: 25, extraUsePriceCents: null } });
  assert.ok(kept.ok && kept.plan && !("name" in kept.plan));
});

test("the trial is sent only while the switch is on, as one more entry after the paid plans", () => {
  const listed = [STARTER, PRO];
  const form = plansFormOf({ plans: listed });
  // Off, or never touched: no entry is a trial, and nothing is sent at all when nothing else changed.
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form, saved: listed }), { kind: "none" });
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: withTrial(form, { on: false, uses: "20" }), saved: listed }), { kind: "none" });
  const offEdited = plansSaveOf({
    sell: PER_USE,
    form: withPlanRow(withTrial(form, { on: false, uses: "20" }), "p1", { price: "10.00" }),
    saved: listed,
  });
  assert.equal(trialSent(offEdited), null);

  // On: the whole set, the four fields of a trial, no id and no name for a new one.
  const on = plansSaveOf({ sell: PER_USE, form: withTrial(form, { on: true, uses: "20" }), saved: listed });
  assert.deepEqual(on, {
    kind: "send",
    plans: [
      { id: "p1", kind: "paid", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: null },
      { id: "p2", kind: "paid", name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: 7 },
      { kind: "trial", priceCents: 0, includedUses: 20, extraUsePriceCents: null },
    ],
    ended: [],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(trialSent(on))), { kind: "trial", priceCents: 0, includedUses: 20, extraUsePriceCents: null });

  // A listing with no paid plan can offer a trial, and a new listing too.
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: withTrial(emptyPlansForm(), { on: true, uses: "5" }), saved: [] }), {
    kind: "send",
    plans: [{ kind: "trial", priceCents: 0, includedUses: 5, extraUsePriceCents: null }],
    ended: [],
  });
  // Off Pay per use, and with plans that were never read: nothing, as for any plan.
  const trialOn = withTrial(form, { on: true, uses: "20" });
  assert.deepEqual(plansSaveOf({ sell: { sells: "use", choice: "monthly" }, form: trialOn, saved: listed }), { kind: "none" });
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: trialOn, saved: null }), { kind: "none" });
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: { ...trialOn, loaded: false }, saved: listed }), { kind: "none" });
});

test("a trial that came from the server keeps its id, and is changed in place", () => {
  const listed = [TRIAL, STARTER, PRO];
  const form = plansFormOf({ plans: listed });
  // Untouched: nothing is sent, so a listing with a trial is not saved again for nothing.
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form, saved: listed }), { kind: "none" });

  const more = plansSaveOf({ sell: PER_USE, form: withTrial(form, { uses: "30" }), saved: listed });
  assert.deepEqual(trialSent(more), { id: "t1", kind: "trial", priceCents: 0, includedUses: 30, extraUsePriceCents: null });
  assert.ok(more.kind === "send");
  assert.deepEqual(more.ended, []);

  // A change of a paid row alone still carries the trial, with its id: every plan on offer is sent or ended.
  const paidOnly = plansSaveOf({ sell: PER_USE, form: withPlanRow(form, "p1", { price: "10.00" }), saved: listed });
  assert.deepEqual(trialSent(paidOnly), { id: "t1", kind: "trial", priceCents: 0, includedUses: 20, extraUsePriceCents: null });
  assert.ok(paidOnly.kind === "send");
  assert.deepEqual(paidOnly.ended, []);

  // Off and on again before the save: the same trial, never a second one.
  const again = withTrial(withTrial(form, { on: false }), { on: true });
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: again, saved: listed }), { kind: "none" });
});

test("switching the trial off ends it by name, and never by leaving it out", () => {
  const listed = [TRIAL, STARTER, PRO];
  const off = withTrial(plansFormOf({ plans: listed }), { on: false });
  const save = plansSaveOf({ sell: PER_USE, form: off, saved: listed });
  assert.deepEqual(save, {
    kind: "send",
    plans: [
      { id: "p1", kind: "paid", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: null },
      { id: "p2", kind: "paid", name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: 7 },
    ],
    ended: ["t1"],
  });
  assert.equal(trialSent(save), null);
  // With a row taken away in the same save: both are named, the paid plan first.
  const both = plansSaveOf({ sell: PER_USE, form: removePlanRow(off, "p1"), saved: listed });
  assert.ok(both.kind === "send");
  assert.deepEqual(both.ended, ["p1", "t1"]);
  // Only a trial: the empty set, and its name.
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: withTrial(plansFormOf({ plans: [TRIAL] }), { on: false }), saved: [TRIAL] }), {
    kind: "send",
    plans: [],
    ended: ["t1"],
  });
  // Whatever was left in the box of a trial that is switched off is not this save's to refuse.
  const junk = plansSaveOf({ sell: PER_USE, form: withTrial(off, { uses: "x" }), saved: listed });
  assert.ok(junk.kind === "send");
  assert.deepEqual(junk.ended, ["t1"]);

  // A trial this form never showed (a later read brought it) is neither sent nor ended by it: the API then
  // answers that the plans changed, and Reload is offered.
  const older = plansFormOf({ plans: [STARTER, PRO] });
  const stale = plansSaveOf({ sell: PER_USE, form: withPlanRow(older, "p1", { price: "10.00" }), saved: listed });
  assert.ok(stale.kind === "send");
  assert.deepEqual(stale.ended, []);
  assert.equal(trialSent(stale), null);
  const staleOn = plansSaveOf({ sell: PER_USE, form: withTrial(older, { on: true, uses: "5" }), saved: listed });
  assert.deepEqual(trialSent(staleOn), { kind: "trial", priceCents: 0, includedUses: 5, extraUsePriceCents: null });
  assert.ok(staleOn.kind === "send");
  assert.deepEqual(staleOn.ended, []);
});

test("the four paid rows are what they were, with a trial beside them or without", () => {
  const paid = [STARTER, PRO];
  const edit = (form: PlansForm) =>
    withPlanRow(addPlanRow(withPlanRow(removePlanRow(form, "p1"), "p2", { price: "39.00" })), "new-1", {
      name: "Team",
      price: "99",
      uses: "5000",
      ending: "extra",
      extraPrice: "0.05",
    });
  const without = plansSaveOf({ sell: PER_USE, form: edit(plansFormOf({ plans: paid })), saved: paid });
  const beside = plansSaveOf({ sell: PER_USE, form: edit(plansFormOf({ plans: [TRIAL, ...paid] })), saved: [TRIAL, ...paid] });
  assert.ok(without.kind === "send" && beside.kind === "send");
  assert.deepEqual(without.plans.map((plan) => plan.kind), ["paid", "paid"]);
  // The same paid entries, in the same places, and the same plan ended.
  assert.deepEqual(beside.plans.filter((plan) => plan.kind === "paid"), without.plans);
  assert.deepEqual(beside.plans.slice(0, without.plans.length), without.plans);
  assert.deepEqual(beside.ended, without.ended);
  assert.deepEqual(without.ended, ["p1"]);
});

test("a trial that cannot be sent stops the save, under its own box", () => {
  const listed = [STARTER];
  const form = withTrial(plansFormOf({ plans: listed }), { on: true, uses: "" });
  const save = plansSaveOf({ sell: PER_USE, form, saved: listed });
  assert.deepEqual(save, { kind: "invalid", errors: { rows: {}, trial: "Enter how many uses the trial includes." } });
  assert.ok(save.kind === "invalid");
  assert.equal(hasPlanErrors(save.errors), true);
  assert.equal(trialProblemOf(form, save.errors), "Enter how many uses the trial includes.");
  assert.equal(plansProblem({ sell: PER_USE, form, saved: listed }), "Free trial: Enter how many uses the trial includes.");
  // A row that is wrong is named first, and both are kept.
  const two = withPlanRow(withTrial(form, { uses: "500" }), "p1", { price: "" });
  const both = plansSaveOf({ sell: PER_USE, form: two, saved: listed });
  assert.deepEqual(both, {
    kind: "invalid",
    errors: { rows: { 0: { price: "Enter a price for 30 days." } }, trial: "A free trial includes between 1 and 50 uses." },
  });
  assert.equal(plansProblem({ sell: PER_USE, form: two, saved: listed }), "Plan 1: Enter a price for 30 days.");
  // A trial exactly as the server gave it is not this save's to refuse, even past a limit that went down.
  const big = [{ ...TRIAL, includedUses: 60 }];
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: plansFormOf({ plans: big }), saved: big }), { kind: "none" });
  assert.equal(plansSaveOf({ sell: PER_USE, form: withTrial(plansFormOf({ plans: big }), { uses: "61" }), saved: big }).kind, "invalid");
});

test("the API's sentence about the trial goes under the trial's box", () => {
  // The trial is the entry after the rows: with two rows it is plans[2].
  const form = withTrial(plansFormOf({ plans: [STARTER, PRO] }), { on: true, uses: "60" });
  const refused = planFieldErrors({ "plans[2].includedUses": "A free trial includes between 1 and 50 uses." });
  assert.equal(hasPlanErrors(refused), true);
  assert.equal(trialProblemOf(form, refused), "A free trial includes between 1 and 50 uses.");
  // Every other field the API can name on a trial is said there too, since a trial has one box.
  for (const [field, sentence] of [
    ["kind", "A listing can have one free trial."],
    ["id", "This plan is no longer on the listing. Reload the page and try again."],
    ["priceCents", "A free trial has no price."],
    ["extraUsePriceCents", "A free trial has no price for an extra use. It stops when its uses are gone."],
  ] as const) {
    assert.equal(trialProblemOf(form, planFieldErrors({ [`plans[2].${field}`]: sentence })), sentence, field);
  }
  // A sentence about a row is the row's, and with no row the trial is plans[0].
  assert.equal(trialProblemOf(form, planFieldErrors({ "plans[1].includedUses": "x" })), null);
  const alone = withTrial(emptyPlansForm(), { on: true, uses: "60" });
  assert.equal(trialProblemOf(alone, planFieldErrors({ "plans[0].includedUses": "x" })), "x");
  // The place is the save's own: wherever a save puts the trial is where its refusal is read from.
  const sendable = withTrial(plansFormOf({ plans: [STARTER, PRO] }), { on: true, uses: "20" });
  const save = plansSaveOf({ sell: PER_USE, form: sendable, saved: [STARTER, PRO] });
  assert.ok(save.kind === "send");
  const at = save.plans.findIndex((plan) => plan.kind === "trial");
  assert.equal(at, 2);
  assert.equal(trialProblemOf(sendable, planFieldErrors({ [`plans[${at}].includedUses`]: "x" })), "x");
  // Nothing wrong, or the switch off: nothing under the box.
  assert.equal(trialProblemOf(form, noPlanErrors()), null);
  assert.equal(trialProblemOf(withTrial(form, { on: false }), { rows: {}, trial: "x" }), null);
  assert.equal(trialProblemOf(emptyPlansForm(), refused), null);
});

test("the on-sale line of a trial, under the lines of the paid plans", () => {
  assert.equal(trialSaleLine(TRIAL), "Free trial. 20 uses for 7 days. 3 people on it now.");
  assert.equal(trialSaleLine({ ...TRIAL, subscribers: 1 }), "Free trial. 20 uses for 7 days. 1 person on it now.");
  assert.equal(trialSaleLine({ ...TRIAL, subscribers: 0 }), "Free trial. 20 uses for 7 days. Nobody on it now.");
  assert.equal(trialSaleLine({ includedUses: 1, subscribers: 1234 }), "Free trial. 1 use for 7 days. 1,234 people on it now.");
  assert.equal(trialSaleLine(TRIAL, { ...DEFAULT_PLAN_LIMITS, trialDays: 14 }), "Free trial. 20 uses for 14 days. 3 people on it now.");

  const listing = { sells: "use", pricingModel: "per_request", plans: [TRIAL, STARTER, PRO] };
  assert.deepEqual(planSaleLines(listing), [
    { id: "p1", line: "Starter. $9.00 for 30 days. 500 uses. No subscribers." },
    { id: "p2", line: "Pro. $29.00 for 30 days. 2,000 uses. 12 subscribers." },
    { id: "t1", line: "Free trial. 20 uses for 7 days. 3 people on it now." },
  ]);
  assert.deepEqual(planSaleLines({ ...listing, plans: [TRIAL] }, { ...DEFAULT_PLAN_LIMITS, trialDays: 3 }), [
    { id: "t1", line: "Free trial. 20 uses for 3 days. 3 people on it now." },
  ]);
  // Another price, copies: no line.
  assert.deepEqual(planSaleLines({ ...listing, pricingModel: "monthly" }), []);
  assert.deepEqual(planSaleLines({ ...listing, sells: "copies" }), []);
});

test("switching the trial off while people are on it asks first; with nobody on it, and for a new one, it does not", () => {
  const form = plansFormOf({ plans: [TRIAL, STARTER] });
  assert.deepEqual(endTrialDialog(form, [TRIAL, STARTER]), {
    title: "Stop offering the free trial?",
    description: "3 people are on the free trial. They keep it until its 7 days end.",
    confirmLabel: "Stop offering it",
  });
  const one = [{ ...TRIAL, subscribers: 1 }];
  assert.equal(endTrialDialog(plansFormOf({ plans: one }), one)?.description, "1 person is on the free trial. They keep it until its 7 days end.");
  assert.equal(
    endTrialDialog(form, [{ ...TRIAL, subscribers: 1200 }], { ...DEFAULT_PLAN_LIMITS, trialDays: 14 })?.description,
    "1,200 people are on the free trial. They keep it until its 14 days end.",
  );
  const nobody = [{ ...TRIAL, subscribers: 0 }];
  assert.equal(endTrialDialog(plansFormOf({ plans: nobody }), nobody), null);
  assert.equal(endTrialDialog(withTrial(emptyPlansForm(), { on: true, uses: "20" }), []), null);
  assert.equal(endTrialDialog(form, null), null);
  // The count is the trial's own: people on a paid plan are not asked about here.
  assert.equal(endTrialDialog(withTrial(plansFormOf({ plans: [PRO] }), { on: true }), [PRO]), null);

  // Until the save it is only switched off, and its box says so. The lines of the paid plans stay theirs.
  const off = withTrial(form, { on: false });
  assert.equal(trialEndingLine(off, [TRIAL, STARTER]), "The free trial stops being offered when you save.");
  assert.deepEqual(endingPlanLines(off, [TRIAL, STARTER]), []);
  assert.equal(trialEndingLine(form, [TRIAL, STARTER]), null);
  assert.deepEqual(endingPlanLines(removePlanRow(off, "p1"), [TRIAL, STARTER]), ["Starter ends when you save."]);
  assert.equal(trialEndingLine(removePlanRow(off, "p1"), [TRIAL, STARTER]), "The free trial stops being offered when you save.");
  // Switched on again before the save: nothing ends.
  assert.equal(trialEndingLine(withTrial(off, { on: true }), [TRIAL, STARTER]), null);
  // A trial that was never saved ends nothing, and neither does one whose listing was not read.
  assert.equal(trialEndingLine(withTrial(withTrial(emptyPlansForm(), { on: true }), { on: false }), []), null);
  assert.equal(trialEndingLine(off, null), null);
  assert.equal(trialEndingLine({ ...off, loaded: false }, [TRIAL, STARTER]), null);
});

test("a trial changes nothing for the people on the paid plans", () => {
  const form = plansFormOf({ plans: [TRIAL, PRO] });
  // The dialog of a paid plan counts its own subscribers, and a change of the trial is no change of a plan.
  assert.match(endPlanDialog({ id: "p2" }, [TRIAL, PRO])?.description ?? "", /^12 subscribers keep this plan/);
  // A row is a paid plan: the trial's id opens no paid plan's dialog, though people are on the trial.
  assert.equal(endPlanDialog({ id: "t1" }, [TRIAL, PRO]), null);
  assert.equal(planChangedNote(withTrial(form, { uses: "30" }).rows[0]!, [TRIAL, PRO]), null);
  // Moving away from Pay per use: what was paid for is said of the paid plans, and the people on the trial
  // are told apart, in the words of the dialog that stops offering it.
  const onSale = { sells: "use", pricingModel: "per_request", status: "published" };
  const free = { sells: "use", choice: "free" } as const;
  assert.equal(
    plansKeptLine({ ...onSale, plans: [TRIAL, PRO] }, free),
    "12 subscribers keep their plan until the 30 days they paid for end and are not charged again. 3 people are on the free trial. They keep it until its 7 days end.",
  );
  assert.equal(plansKeptLine({ ...onSale, plans: [TRIAL] }, free), "3 people are on the free trial. They keep it until its 7 days end.");
  assert.equal(
    plansKeptLine({ ...onSale, plans: [{ ...TRIAL, subscribers: 1 }] }, free, { ...DEFAULT_PLAN_LIMITS, trialDays: 14 }),
    "1 person is on the free trial. They keep it until its 14 days end.",
  );
  // Nobody on the trial: only the paid plans are said, and with nobody on anything, nothing.
  assert.equal(
    plansKeptLine({ ...onSale, plans: [{ ...TRIAL, subscribers: 0 }, PRO] }, free),
    "12 subscribers keep their plan until the 30 days they paid for end and are not charged again.",
  );
  assert.equal(plansKeptLine({ ...onSale, plans: [{ ...TRIAL, subscribers: 0 }] }, free), null);
  // Staying on Pay per use changes nothing for them.
  assert.equal(plansKeptLine({ ...onSale, plans: [TRIAL, PRO] }, PER_USE), null);
});

test("a save sends the whole set: ids kept, the extra price always said, a removed row absent and named as ended", () => {
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
    ended: ["p1"],
  });
  assert.ok(save.kind === "send");
  // The removed plan is absent and named as ended; a new plan carries no id.
  assert.equal(save.plans.some((plan) => plan.id === "p1"), false);
  assert.equal("id" in save.plans[1]!, false);

  // "Stop" is said as null, never left out.
  const stop = plansSaveOf({ sell: PER_USE, form: withPlanRow(form, "p2", { ending: "stop" }), saved: [STARTER, PRO] });
  assert.ok(stop.kind === "send");
  for (const plan of stop.plans) assert.equal(Object.prototype.hasOwnProperty.call(plan, "extraUsePriceCents"), true);
  assert.deepEqual(stop.plans.map((plan) => plan.extraUsePriceCents), [null, null]);
  assert.deepEqual(stop.plans.map((plan) => plan.id), ["p1", "p2"]);
  assert.deepEqual(stop.ended, []);
  assert.deepEqual(JSON.parse(JSON.stringify(stop.plans[0])), {
    id: "p1",
    kind: "paid",
    name: "Starter",
    priceCents: 900,
    includedUses: 500,
    extraUsePriceCents: null,
  });

  // Every plan removed: the empty set is sent, and each plan is named as ended.
  assert.deepEqual(plansSaveOf({ sell: PER_USE, form: { loaded: true, rows: [] }, saved: [STARTER, PRO] }), {
    kind: "send",
    plans: [],
    ended: ["p1", "p2"],
  });
});

test("ended holds exactly the plans whose rows were taken away on this screen, and nothing else", () => {
  const listed = [STARTER, PRO];
  const form = plansFormOf({ plans: listed });
  const endedOf = (rows: typeof form) => {
    const save = plansSaveOf({ sell: PER_USE, form: rows, saved: listed });
    assert.ok(save.kind === "send");
    return save;
  };

  // Only a row changed: nothing is ended, and the list is still there, empty.
  const changed = endedOf(withPlanRow(form, "p1", { price: "19.00" }));
  assert.deepEqual(changed.ended, []);
  assert.equal(Object.prototype.hasOwnProperty.call(changed, "ended"), true);
  // A plan added and none taken away.
  const added = endedOf(withPlanRow(addPlanRow(form), "new-1", { name: "Team", price: "99", uses: "5000" }));
  assert.deepEqual(added.ended, []);
  assert.equal(added.plans.length, 3);

  // One taken away: its id and no other, however the rest was edited.
  assert.deepEqual(endedOf(removePlanRow(form, "p2")).ended, ["p2"]);
  const both = endedOf(withPlanRow(removePlanRow(form, "p1"), "p2", { name: "Pro Plus" }));
  assert.deepEqual(both.ended, ["p1"]);
  assert.deepEqual(both.plans.map((plan) => plan.id), ["p2"]);

  // A saved plan whose row is still there is never in it, and no id is in both lists.
  for (const save of [changed, added, both, endedOf(removePlanRow(form, "p2"))]) {
    const sent = new Set(save.plans.map((plan) => plan.id));
    assert.equal(save.ended.some((id) => sent.has(id)), false);
    assert.equal(save.ended.every((id) => listed.some((plan) => plan.id === id)), true);
  }

  // A new row that was added and taken away again was never a plan: it is not named.
  const undone = removePlanRow(addPlanRow(removePlanRow(form, "p1")), "new-1");
  assert.deepEqual(endedOf(undone).ended, ["p1"]);

  // A plan this screen never showed (one a teammate added, an ended one, a trial) is never named:
  // only the plans that were read here can be.
  const shown = savedPlansOf({ plans: [STARTER, saved({ id: "gone", status: "retired" }), saved({ id: "t", kind: "trial" })] })!;
  const onlyStarter = plansSaveOf({ sell: PER_USE, form: { loaded: true, rows: [] }, saved: shown });
  assert.deepEqual(onlyStarter, { kind: "send", plans: [], ended: ["p1"] });
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
    "plans[3].kind": "A plan is either paid or a free trial.",
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
      3: { row: "A plan is either paid or a free trial." },
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
    ...Object.values(TRIAL_WORDS),
    trialNote(),
    trialSaleLine(TRIAL),
    trialSaleLine({ ...TRIAL, subscribers: 0 }),
    endTrialDialog(plansFormOf({ plans: [TRIAL] }), [TRIAL])?.description ?? "",
    ...["", "x", "99"].map((uses) => {
      const checked = checkTrial({ trial: { on: true, id: null, uses } });
      return checked.ok ? "" : checked.error;
    }),
    plansProblem({ sell: PER_USE, form: withTrial(emptyPlansForm(), { on: true }), saved: [] }) ?? "",
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

test("Reload is offered only for a save refused because the plans changed somewhere else", () => {
  assert.equal(plansReloadOffered("plans_changed"), true);
  // A refusal about what was typed, or about the listing: reading again would throw the rows away for nothing.
  for (const code of ["validation_failed", "plans_not_available", "forbidden", "", null, undefined]) {
    assert.equal(plansReloadOffered(code), false, String(code));
  }
  assert.equal(PLANS_RELOAD_WORDS.button, "Reload");
  assert.equal(PLANS_RELOAD_WORDS.failed, "The plans could not be read again. Try again.");
});
