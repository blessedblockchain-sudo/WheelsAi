import assert from "node:assert/strict";
import test from "node:test";

import type { PaidUseBilling, PaidUsePlanBilling } from "../services/paidUse.js";
import {
  BALANCE_CENTS_HEADER,
  CHARGED_CENTS_HEADER,
  PLAN_HEADER,
  PLAN_LIMIT_HEADER,
  PLAN_REMAINING_HEADER,
  PLAN_RESET_HEADER,
  PLAN_USAGE_HEADER_NAMES,
  PLAN_USED_HEADER,
  PLAN_WARNING_HEADER,
  USAGE_HEADER_NAMES,
  clearUsageHeaders,
  refusalUsageHeadersOf,
  setUsageHeaders,
  usageHeadersOf,
  type UsageRefusal,
} from "../services/usageHeaders.js";

// The usage headers of a paid answer. What these pin: the headers say the
// numbers of the billing object and no others; a header that cannot be
// worked out is left out and nothing throws; only the refusal that a plan is
// used up has any; and no header tells what a buyer is never told.

const RESETS_AT = "2026-11-01T00:00:00.000Z";

/** A buyer on a plan of 500 uses, then $0.04 a use, after their 13th use. */
const PLAN: PaidUsePlanBilling = {
  id: "plan-1",
  use: "included",
  includedUses: 500,
  carriedUses: 0,
  usedUses: 13,
  remainingUses: 487,
  extraUsePriceCents: 4,
  resetsAt: RESETS_AT,
  warning: null,
};
const onPlan = (plan: Partial<PaidUsePlanBilling> = {}, billing: Partial<PaidUseBilling> = {}): PaidUseBilling => ({
  chargedCents: 0,
  balanceCents: 500,
  access: "subscribed",
  ...billing,
  plan: { ...PLAN, ...plan },
});

test("the names are the eight of the rules, lower case, and the plan's six are told only of a plan", () => {
  assert.deepEqual(
    [...USAGE_HEADER_NAMES],
    [
      "x-wheelsai-charged-cents",
      "x-wheelsai-balance-cents",
      "x-wheelsai-plan",
      "x-wheelsai-plan-limit",
      "x-wheelsai-plan-used",
      "x-wheelsai-plan-remaining",
      "x-wheelsai-plan-reset",
      "x-wheelsai-plan-warning",
    ],
  );
  assert.deepEqual(
    [CHARGED_CENTS_HEADER, BALANCE_CENTS_HEADER, ...PLAN_USAGE_HEADER_NAMES],
    [...USAGE_HEADER_NAMES],
  );
  assert.deepEqual(
    [...PLAN_USAGE_HEADER_NAMES],
    [PLAN_HEADER, PLAN_LIMIT_HEADER, PLAN_USED_HEADER, PLAN_REMAINING_HEADER, PLAN_RESET_HEADER, PLAN_WARNING_HEADER],
  );
});

test("an included use: nothing charged, the balance, and the plan's count after it", () => {
  assert.deepEqual(usageHeadersOf(onPlan()), {
    "x-wheelsai-charged-cents": "0",
    "x-wheelsai-balance-cents": "500",
    "x-wheelsai-plan": "plan-1",
    "x-wheelsai-plan-limit": "500",
    "x-wheelsai-plan-used": "13",
    "x-wheelsai-plan-remaining": "487",
    "x-wheelsai-plan-reset": RESETS_AT,
  });
});

test("an extra use: the agreed extra price charged, nothing remaining and the warning at 100", () => {
  const extra = onPlan({ use: "extra", usedUses: 500, remainingUses: 0, warning: 100 }, { chargedCents: 4, balanceCents: 496 });
  assert.deepEqual(usageHeadersOf(extra), {
    "x-wheelsai-charged-cents": "4",
    "x-wheelsai-balance-cents": "496",
    "x-wheelsai-plan": "plan-1",
    "x-wheelsai-plan-limit": "500",
    "x-wheelsai-plan-used": "500",
    "x-wheelsai-plan-remaining": "0",
    "x-wheelsai-plan-reset": RESETS_AT,
    "x-wheelsai-plan-warning": "100",
  });
});

test("a use inside a paid month and a use paid per use: the charge and the balance, and no plan header", () => {
  assert.deepEqual(usageHeadersOf({ chargedCents: 0, balanceCents: 500, access: "subscribed" }), {
    "x-wheelsai-charged-cents": "0",
    "x-wheelsai-balance-cents": "500",
  });
  assert.deepEqual(usageHeadersOf({ chargedCents: 5, balanceCents: 495, access: "listing_pricing" }), {
    "x-wheelsai-charged-cents": "5",
    "x-wheelsai-balance-cents": "495",
  });
});

test("a balance that could not be read leaves its header out, and the rest stands", () => {
  assert.deepEqual(usageHeadersOf({ chargedCents: 5, balanceCents: null, access: "listing_pricing" }), {
    "x-wheelsai-charged-cents": "5",
  });
  const plan = usageHeadersOf(onPlan({}, { balanceCents: null }));
  assert.equal(BALANCE_CENTS_HEADER in plan, false);
  assert.equal(plan[PLAN_REMAINING_HEADER], "487");
  // A balance of nothing is a balance: it is told.
  assert.equal(usageHeadersOf({ chargedCents: 0, balanceCents: 0, access: "subscribed" })[BALANCE_CENTS_HEADER], "0");
});

test("a plan that will not renew has no reset header", () => {
  const { resetsAt: _resetsAt, ...ending } = PLAN;
  const headers = usageHeadersOf({ chargedCents: 0, balanceCents: 500, access: "subscribed", plan: ending });
  assert.equal(PLAN_RESET_HEADER in headers, false);
  assert.equal(headers[PLAN_USED_HEADER], "13");
});

test("the warning header is 85 or 100, and is left out below 85", () => {
  assert.equal(PLAN_WARNING_HEADER in usageHeadersOf(onPlan({ usedUses: 424, remainingUses: 76, warning: null })), false);
  assert.equal(usageHeadersOf(onPlan({ usedUses: 425, remainingUses: 75, warning: 85 }))[PLAN_WARNING_HEADER], "85");
  assert.equal(usageHeadersOf(onPlan({ usedUses: 500, remainingUses: 0, warning: 100 }))[PLAN_WARNING_HEADER], "100");
});

test("the limit is the included uses plus the carried ones", () => {
  const moved = usageHeadersOf(onPlan({ includedUses: 2000, carriedUses: 487, usedUses: 1, remainingUses: 2486 }));
  assert.equal(moved[PLAN_LIMIT_HEADER], "2487");
  assert.equal(moved[PLAN_REMAINING_HEADER], "2486");
});

test("a subscription that names no plan has no plan id header, and still its count", () => {
  const headers = usageHeadersOf(onPlan({ id: null }));
  assert.equal(PLAN_HEADER in headers, false);
  assert.equal(headers[PLAN_LIMIT_HEADER], "500");
});

/** Every answer and refusal the cases above build, for the checks on what a header may hold. */
const EVERY = [
  usageHeadersOf(onPlan()),
  usageHeadersOf(onPlan({ use: "extra", usedUses: 500, remainingUses: 0, warning: 100 }, { chargedCents: 4, balanceCents: 496 })),
  usageHeadersOf(onPlan({ includedUses: 2000, carriedUses: 487, usedUses: 1700, remainingUses: 787, warning: null })),
  usageHeadersOf({ chargedCents: 0, balanceCents: 500, access: "subscribed" }),
  usageHeadersOf({ chargedCents: 5, balanceCents: 495, access: "listing_pricing" }),
  refusalUsageHeadersOf({
    code: "plan_used_up",
    resetsAt: RESETS_AT,
    planCount: { id: "plan-1", includedUses: 500, carriedUses: 0, usedUses: 500 },
  }),
];

test("every value is a string of whole digits or an ISO time, and the plan's id is the one name", () => {
  for (const headers of EVERY) {
    for (const [name, value] of Object.entries(headers)) {
      assert.ok((USAGE_HEADER_NAMES as readonly string[]).includes(name), name);
      assert.equal(typeof value, "string");
      if (name === PLAN_HEADER) assert.equal(value, "plan-1");
      else if (name === PLAN_RESET_HEADER) assert.equal(new Date(value).toISOString(), value);
      else assert.match(value, /^\d+$/, name);
    }
  }
});

test("nothing in any header names tokens, a model or an organization", () => {
  for (const name of USAGE_HEADER_NAMES) assert.doesNotMatch(name, /token|model|org|creator|publisher|buyer|user/i);
  // A billing object that was handed more than a buyer may know: none of it reaches a header.
  const leaking = {
    ...onPlan(),
    model: "openai/gpt-4o",
    tokens: 1234,
    usage: { total_tokens: 1234 },
    orgId: "org-creator",
    publisherId: "org-creator",
    plan: { ...PLAN, name: "Starter", subscribers: 41, subscriptionId: "sub-1", buyerId: "org-buyer" },
  } as unknown as PaidUseBilling;
  const headers = usageHeadersOf(leaking);
  assert.deepEqual(headers, usageHeadersOf(onPlan()));
  const told = JSON.stringify(headers);
  for (const secret of ["gpt-4o", "1234", "org-creator", "org-buyer", "Starter", "41", "sub-1"]) {
    assert.ok(!told.includes(secret), secret);
  }
});

test("a value that cannot be worked out is left out one by one, and nothing throws", () => {
  const broken = {
    chargedCents: 0.5,
    balanceCents: Number.NaN,
    access: "subscribed",
    plan: {
      id: "plan-1\r\nset-cookie: a=b",
      use: "included",
      includedUses: 500,
      carriedUses: -1,
      usedUses: "13",
      remainingUses: 487,
      extraUsePriceCents: 4,
      resetsAt: "1 Nov",
      warning: 90,
    },
  } as unknown as PaidUseBilling;
  // Only what is a whole count is told: here, what remains.
  assert.deepEqual(usageHeadersOf(broken), { "x-wheelsai-plan-remaining": "487" });

  for (const nothing of [null, undefined, "billing", 7, {}, { plan: 7 }, { plan: [] }]) {
    assert.deepEqual(usageHeadersOf(nothing as unknown as PaidUseBilling), {}, JSON.stringify(nothing));
    assert.deepEqual(refusalUsageHeadersOf(nothing as unknown as UsageRefusal), {});
  }
  // A getter that throws does not reach the caller.
  const throwing = Object.defineProperty({ chargedCents: 5, balanceCents: 495 }, "plan", {
    get() {
      throw new Error("no plan to read");
    },
  }) as unknown as PaidUseBilling;
  assert.deepEqual(usageHeadersOf(throwing), { "x-wheelsai-charged-cents": "5", "x-wheelsai-balance-cents": "495" });
});

test("a refusal that a plan is used up has the plan's headers with 0 remaining, and no charge or balance", () => {
  const usedUp: UsageRefusal = {
    code: "plan_used_up",
    resetsAt: RESETS_AT,
    planCount: { id: "plan-1", includedUses: 500, carriedUses: 20, usedUses: 520 },
  };
  assert.deepEqual(refusalUsageHeadersOf(usedUp), {
    "x-wheelsai-plan": "plan-1",
    "x-wheelsai-plan-limit": "520",
    "x-wheelsai-plan-used": "520",
    "x-wheelsai-plan-remaining": "0",
    "x-wheelsai-plan-reset": RESETS_AT,
    "x-wheelsai-plan-warning": "100",
  });
  // A plan that will not renew: no time at which the count starts again.
  const { resetsAt: _resetsAt, ...ending } = usedUp;
  assert.equal(PLAN_RESET_HEADER in refusalUsageHeadersOf(ending), false);
  // A refusal that was not given its count says nothing rather than guess.
  assert.deepEqual(refusalUsageHeadersOf({ code: "plan_used_up", resetsAt: RESETS_AT }), {});
});

test("every other refusal has no usage header, whatever it carries", () => {
  const count = { id: "plan-1", includedUses: 500, carriedUses: 0, usedUses: 500 };
  for (const code of [
    "plan_ended",
    "insufficient_credits",
    "rate_limited",
    "too_many_refunds",
    "pricing_changed",
    "subscription_lapsed",
    "use_not_started",
    "agent_paused",
    "model_error",
    "client_closed_request",
  ]) {
    assert.deepEqual(refusalUsageHeadersOf({ code, resetsAt: RESETS_AT, planCount: count }), {}, code);
  }
});

test("the headers are put on a reply one by one, and taken off all at once", () => {
  const held = new Map<string, string>([["cache-control", "no-store"]]);
  const reply = {
    header: (name: string, value: string) => held.set(name, value),
    removeHeader: (name: string) => held.delete(name),
  };
  setUsageHeaders(reply, usageHeadersOf(onPlan()));
  assert.deepEqual(Object.fromEntries(held), { "cache-control": "no-store", ...usageHeadersOf(onPlan()) });
  setUsageHeaders(reply, {});
  assert.equal(held.size, 8);
  clearUsageHeaders(reply);
  assert.deepEqual(Object.fromEntries(held), { "cache-control": "no-store" });
});
