import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INCLUDED_USES,
  MAX_PAID_PLANS,
  MAX_PLAN_NAME_CHARS,
  MIN_EXTRA_USE_PRICE_CENTS,
  MIN_INCLUDED_USES,
  MIN_PLAN_CENTS_PER_INCLUDED_USE,
  MIN_PLAN_PRICE_CENTS,
  PLAN_MESSAGES,
  checkPlanSet,
  samePlanTerms,
  type CurrentPlan,
  type PlanInput,
  type PlanListing,
  type PlanSetCheck,
  type PlanTerms,
} from "../services/listingPlans.js";
import { MIN_PRICE_PER_USE_CENTS } from "../services/useListing.js";

// The rules of a plan. What these pin: the numbers; a set of plans is saved
// whole or not at all, with a sentence for each field that is wrong; a
// listing that is not sold per use has no plans; a free trial is refused for
// now; and a buyer's agreement holds only for the exact terms they were shown.

const LISTING: PlanListing = { sells: "use", pricingModel: "per_request", agentKind: "chat" };

const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
  kind: "paid",
  name: "Starter",
  priceCents: 900n,
  includedUses: 500,
  extraUsePriceCents: null,
  ...over,
});

/** The fields a set is refused for, or fails the test. */
function fieldsOf(check: PlanSetCheck): Record<string, string> {
  assert.equal(check.ok, false);
  if (check.ok || check.status !== 400) throw new Error("expected a refusal of fields");
  return check.fields;
}

test("the numbers", () => {
  assert.equal(MAX_PAID_PLANS, 4);
  assert.equal(MAX_PLAN_NAME_CHARS, 40);
  assert.equal(MIN_PLAN_PRICE_CENTS, 100n);
  assert.equal(MIN_PLAN_CENTS_PER_INCLUDED_USE, 1n);
  assert.equal(MIN_INCLUDED_USES, 1);
  assert.equal(MAX_INCLUDED_USES, 6000);
  assert.equal(MIN_EXTRA_USE_PRICE_CENTS, 5n);
  // One floor for a use sold by itself, extra or not.
  assert.equal(MIN_EXTRA_USE_PRICE_CENTS, MIN_PRICE_PER_USE_CENTS);
});

test("a set of plans that is in order comes back trimmed and in the order sent", () => {
  const check = checkPlanSet(LISTING, [
    plan({ name: "  Starter  " }),
    plan({ id: "plan_2", name: "Team", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: 5n }),
  ]);
  assert.deepEqual(check, {
    ok: true,
    plans: [
      { id: null, kind: "paid", name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: null, position: 1 },
      { id: "plan_2", kind: "paid", name: "Team", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: 5n, position: 2 },
    ],
  });
});

test("an empty set is allowed: it ends every plan of the listing", () => {
  assert.deepEqual(checkPlanSet(LISTING, []), { ok: true, plans: [] });
});

test("the edges of each number are allowed", () => {
  const edges: PlanInput[] = [
    plan({ name: "x".repeat(MAX_PLAN_NAME_CHARS) }),
    plan({ priceCents: 100n, includedUses: 100 }),
    plan({ priceCents: 100n, includedUses: 1 }),
    plan({ priceCents: 6000n, includedUses: 6000, extraUsePriceCents: 5n }),
  ];
  assert.equal(edges.length, MAX_PAID_PLANS);
  assert.equal(checkPlanSet(LISTING, edges).ok, true);
});

test("at most four paid plans", () => {
  const five = [1, 2, 3, 4, 5].map((n) => plan({ name: `Plan ${n}` }));
  assert.deepEqual(fieldsOf(checkPlanSet(LISTING, five)), { plans: "A listing can have at most 4 plans." });
  assert.equal(checkPlanSet(LISTING, five.slice(0, 4)).ok, true);
});

test("a free trial is refused for now, and so is a kind that is neither", () => {
  assert.deepEqual(
    fieldsOf(checkPlanSet(LISTING, [plan({ kind: "trial", priceCents: 0n, includedUses: 20 })]))["plans[0].kind"],
    "Free trials are not available yet.",
  );
  assert.equal(fieldsOf(checkPlanSet(LISTING, [plan({ kind: "gift" })]))["plans[0].kind"], PLAN_MESSAGES.kind);
});

test("a name is 1 to 40 characters after trimming", () => {
  for (const name of ["", "   ", "\t\n"]) {
    assert.deepEqual(fieldsOf(checkPlanSet(LISTING, [plan({ name })])), { "plans[0].name": "Give the plan a name." });
  }
  assert.deepEqual(fieldsOf(checkPlanSet(LISTING, [plan({ name: "x".repeat(41) })])), {
    "plans[0].name": "The name of a plan can be at most 40 characters.",
  });
  // Spaces around the name do not count against it.
  assert.equal(checkPlanSet(LISTING, [plan({ name: `  ${"x".repeat(40)}  ` })]).ok, true);
});

test("a paid plan costs at least $1.00, and at least 1 cent for each included use", () => {
  assert.deepEqual(fieldsOf(checkPlanSet(LISTING, [plan({ priceCents: 99n, includedUses: 10 })])), {
    "plans[0].priceCents": "The price for 30 days must be at least $1.00.",
  });
  // $9.00 includes at most 900 uses.
  assert.equal(checkPlanSet(LISTING, [plan({ priceCents: 900n, includedUses: 900 })]).ok, true);
  assert.deepEqual(fieldsOf(checkPlanSet(LISTING, [plan({ priceCents: 900n, includedUses: 901 })])), {
    "plans[0].includedUses": "At $9.00 a plan can include at most 900 uses.",
  });
});

test("included uses are a whole number from 1 to 6,000", () => {
  for (const includedUses of [0, -1, 1.5, 6001, 100_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      fieldsOf(checkPlanSet(LISTING, [plan({ priceCents: 200_000n, includedUses })])),
      { "plans[0].includedUses": "A plan includes between 1 and 6,000 uses." },
      String(includedUses),
    );
  }
});

test("the extra price is none, or at least 5 cents", () => {
  for (const extraUsePriceCents of [0n, 1n, 4n, -5n]) {
    assert.deepEqual(fieldsOf(checkPlanSet(LISTING, [plan({ extraUsePriceCents })])), {
      "plans[0].extraUsePriceCents": "The price for each extra use must be at least $0.05.",
    });
  }
  assert.equal(checkPlanSet(LISTING, [plan({ extraUsePriceCents: 5n })]).ok, true);
  assert.equal(checkPlanSet(LISTING, [plan({ extraUsePriceCents: null })]).ok, true);
});

test("every field that is wrong is told, each under the plan it is in, and nothing is passed", () => {
  const check = checkPlanSet(LISTING, [
    plan(),
    plan({ name: "", priceCents: 50n, includedUses: 0, extraUsePriceCents: 1n }),
  ]);
  const fields = fieldsOf(check);
  assert.deepEqual(Object.keys(fields).sort(), [
    "plans[1].extraUsePriceCents",
    "plans[1].includedUses",
    "plans[1].name",
    "plans[1].priceCents",
  ]);
  if (check.ok || check.status !== 400) throw new Error("unreachable");
  // The shape a refused field of a listing has (lib/validationFailure.ts).
  assert.equal(check.code, "validation_failed");
  assert.equal(check.body.error, "validation_failed");
  assert.equal(check.body.message, check.message);
  assert.deepEqual(check.body.fields, fields);
  assert.equal(check.body.details.fieldErrors.plans?.length, 4);
  for (const sentence of Object.values(fields)) {
    // Product voice: no raw codes, no dashes standing in for punctuation.
    assert.doesNotMatch(sentence, /_|—/);
  }
});

test("a plan's id is in the set once, and is one of the listing's plans on offer", () => {
  assert.deepEqual(fieldsOf(checkPlanSet(LISTING, [plan({ id: "plan_1" }), plan({ id: "plan_1", name: "Again" })])), {
    "plans[1].id": "This plan is in the list twice.",
  });
  const active = new Set(["plan_1"]);
  assert.equal(checkPlanSet(LISTING, [plan({ id: "plan_1" }), plan({ name: "New" })], active).ok, true);
  // Another listing's plan, or one that was ended since the page was loaded.
  assert.deepEqual(fieldsOf(checkPlanSet(LISTING, [plan({ id: "plan_9" })], active)), {
    "plans[0].id": "This plan is no longer on the listing. Reload the page and try again.",
  });
});

test("only a listing that sells use per request, of an agent that does not run on its own, has plans", () => {
  const refused = (listing: PlanListing) => {
    // Refused whatever is sent, an empty set and a wrong one included.
    for (const plans of [[plan()], [], [plan({ priceCents: 1n })]]) {
      const check = checkPlanSet(listing, plans);
      assert.equal(check.ok, false);
      if (check.ok || check.status !== 409) throw new Error("expected a 409");
      assert.equal(check.code, "plans_not_available");
      assert.doesNotMatch(check.message, /_|—/);
    }
    const check = checkPlanSet(listing, [plan()]);
    return check.ok ? "" : check.message;
  };
  assert.equal(refused({ ...LISTING, sells: "copies" }), PLAN_MESSAGES.sellsCopies);
  assert.equal(refused({ ...LISTING, sells: "copies", pricingModel: "monthly" }), PLAN_MESSAGES.sellsCopies);
  for (const pricingModel of ["free", "monthly", "tokenized"]) {
    assert.equal(refused({ ...LISTING, pricingModel }), PLAN_MESSAGES.notPerUse, pricingModel);
  }
  assert.equal(refused({ ...LISTING, agentKind: "scheduled" }), PLAN_MESSAGES.scheduled);
  assert.equal(refused({ ...LISTING, agentKind: "scheduled", pricingModel: "monthly" }), PLAN_MESSAGES.scheduled);
  // A task agent is sold per run, and can have plans.
  assert.equal(checkPlanSet({ ...LISTING, agentKind: "task" }, [plan()]).ok, true);
  assert.equal(checkPlanSet({ sells: "use", pricingModel: "per_request" }, [plan()]).ok, true);
});

// ============================================
// The terms a buyer agreed to
// ============================================

const SHOWN: PlanTerms = { id: "plan_1", priceCents: 900n, includedUses: 500, extraUsePriceCents: 4n };
const NOW_PLAN: CurrentPlan = { ...SHOWN, status: "active" };

test("the terms a buyer was shown are the plan as it is now", () => {
  assert.equal(samePlanTerms(SHOWN, NOW_PLAN), true);
  const stops = { ...SHOWN, extraUsePriceCents: null };
  assert.equal(samePlanTerms(stops, { ...stops, status: "active" }), true);
});

test("any term that differs is not what the buyer agreed to, a cheaper one included", () => {
  const changes: Array<Partial<CurrentPlan>> = [
    { id: "plan_2" },
    { priceCents: 901n },
    { priceCents: 899n },
    { includedUses: 499 },
    { includedUses: 501 },
    { extraUsePriceCents: 5n },
    { extraUsePriceCents: 3n },
    // "It stops" and "each extra use is charged" are different endings.
    { extraUsePriceCents: null },
  ];
  for (const change of changes) {
    assert.equal(samePlanTerms(SHOWN, { ...NOW_PLAN, ...change }), false, JSON.stringify(change, (_k, v) => String(v)));
  }
  assert.equal(samePlanTerms({ ...SHOWN, extraUsePriceCents: null }, NOW_PLAN), false);
});

test("a plan that is gone or was ended matches nothing", () => {
  assert.equal(samePlanTerms(SHOWN, null), false);
  assert.equal(samePlanTerms(SHOWN, undefined), false);
  assert.equal(samePlanTerms(SHOWN, { ...NOW_PLAN, status: "retired" }), false);
});
