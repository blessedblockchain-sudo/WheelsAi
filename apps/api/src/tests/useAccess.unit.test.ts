import assert from "node:assert/strict";
import test from "node:test";

import { installAccess } from "../services/subscriptionAccess.js";
import {
  useAccess,
  useDecision,
  type UseAccess,
  type UseAccessInput,
  type UseLicence,
  type UseListing,
  type UseSubscription,
} from "../services/useAccess.js";

// What a buyer may do with a creator's agent, from the rows. What these pin:
// a paid month is honoured whatever the listing says now, nothing else
// outlives the listing, a buyer is never moved onto a price they did not
// accept, and a lapsed month is a 402 and never free use.

const NOW = new Date("2026-10-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);

const PER_USE: UseListing = { status: "published", sells: "use", pricingModel: "per_request", pricePerRequestCents: 5n };
const MONTHLY: UseListing = { status: "published", sells: "use", pricingModel: "monthly", pricePerRequestCents: null };
const FREE: UseListing = { status: "published", sells: "use", pricingModel: "free", pricePerRequestCents: null };

const perUseLicence = (price = 5n, over: Partial<UseLicence> = {}): UseLicence => ({
  kind: "use",
  status: "active",
  accepted: { pricingModel: "per_request", pricePerRequestCents: price },
  ...over,
});
const monthlyLicence = (over: Partial<UseLicence> = {}): UseLicence => ({
  kind: "use",
  status: "active",
  accepted: { pricingModel: "monthly", pricePerRequestCents: null },
  ...over,
});
const paidMonth = (over: Partial<UseSubscription> = {}): UseSubscription => ({
  status: "active",
  currentPeriodEnd: inDays(10),
  cancelAtPeriodEnd: false,
  endReason: null,
  ...over,
});

const access = (input: UseAccessInput): UseAccess => useAccess(input, NOW);

test("none: no licence, an ended one, or a copy licence that never accepted use", () => {
  assert.equal(access({ licence: null, listing: PER_USE, sub: null }), "none");
  for (const status of ["uninstalled", "stopped"]) {
    assert.equal(access({ licence: perUseLicence(5n, { status }), listing: PER_USE, sub: null }), "none", status);
  }
  // Somebody who stopped is not let back in by a subscription row that still reads paid.
  assert.equal(
    access({ licence: monthlyLicence({ status: "uninstalled" }), listing: MONTHLY, sub: paidMonth() }),
    "none",
  );
  assert.deepEqual(useDecision("none", PER_USE), {
    runs: false,
    charged: false,
    status: 403,
    code: "use_not_started",
  });
});

test("a copy licence is none until it accepts use, even with the same price agreed", () => {
  const copy: UseLicence = { ...perUseLicence(), kind: "copy" };
  assert.equal(access({ licence: copy, listing: PER_USE, sub: null }), "none");
  // Not even a paid month on the copy buys use of the creator's agent.
  assert.equal(access({ licence: { ...monthlyLicence(), kind: "copy" }, listing: MONTHLY, sub: paidMonth() }), "none");
  // The same row, once it is a use licence.
  assert.equal(access({ licence: { ...copy, kind: "use" }, listing: PER_USE, sub: null }), "listing_pricing");
});

test("subscribed: inside a paid month, whatever the listing says now", () => {
  const listings: UseListing[] = [
    MONTHLY,
    PER_USE,
    FREE,
    { ...MONTHLY, status: "archived" },
    { ...MONTHLY, status: "draft" },
    { ...MONTHLY, sells: "copies" },
    { ...MONTHLY, pricingModel: "tokenized" },
  ];
  for (const listing of listings) {
    assert.equal(
      access({ licence: monthlyLicence(), listing, sub: paidMonth() }),
      "subscribed",
      `${listing.status} ${listing.sells} ${listing.pricingModel}`,
    );
  }
  // A cancelled renewal keeps the month that was paid for.
  assert.equal(
    access({ licence: monthlyLicence(), listing: MONTHLY, sub: paidMonth({ cancelAtPeriodEnd: true }) }),
    "subscribed",
  );
  assert.deepEqual(useDecision("subscribed", MONTHLY), { runs: true, charged: false });
  // A subscriber is not charged per use even when the listing now has a per-use price.
  assert.deepEqual(useDecision("subscribed", PER_USE), { runs: true, charged: false });
});

test("a paid month beats an archived listing, which is the one difference from a copy", () => {
  const archived = { ...MONTHLY, status: "archived" };
  const input = { licence: monthlyLicence(), listing: archived, sub: paidMonth() };
  assert.equal(access(input), "subscribed");
  // installAccess looks at the listing first and says "unlisted": for a copy, it keeps running at no charge.
  assert.equal(
    installAccess(
      {
        installStatus: "active",
        listingStatus: "archived",
        pricingModel: "monthly",
        accepted: input.licence.accepted,
        sub: input.sub,
      },
      NOW,
    ),
    "unlisted",
  );
  // When the month ends, so does the use: it does not become free use for ever.
  assert.equal(access({ ...input, sub: paidMonth({ currentPeriodEnd: inDays(-1), cancelAtPeriodEnd: true }) }), "not_offered");
  assert.equal(access({ ...input, sub: paidMonth({ status: "expired", currentPeriodEnd: inDays(-5) }) }), "not_offered");
});

test("listing_pricing: the listing sells use at or below the accepted price; charged only if per use", () => {
  assert.equal(access({ licence: perUseLicence(5n), listing: PER_USE, sub: null }), "listing_pricing");
  assert.deepEqual(useDecision("listing_pricing", PER_USE), { runs: true, charged: true });
  // A move to free applies at once, and is not charged.
  assert.equal(access({ licence: perUseLicence(5n), listing: FREE, sub: null }), "listing_pricing");
  assert.deepEqual(useDecision("listing_pricing", FREE), { runs: true, charged: false });
  assert.deepEqual(useDecision("listing_pricing", { pricingModel: "per_request", pricePerRequestCents: 0n }), {
    runs: true,
    charged: false,
  });
});

test("a higher per-use price pauses, a lower one applies", () => {
  const licence = perUseLicence(10n);
  assert.equal(access({ licence, listing: { ...PER_USE, pricePerRequestCents: 8n }, sub: null }), "listing_pricing");
  assert.equal(access({ licence, listing: { ...PER_USE, pricePerRequestCents: 10n }, sub: null }), "listing_pricing");
  assert.equal(access({ licence, listing: { ...PER_USE, pricePerRequestCents: 11n }, sub: null }), "pricing_changed");
  assert.deepEqual(useDecision("pricing_changed", { ...PER_USE, pricePerRequestCents: 11n }), {
    runs: false,
    charged: false,
    status: 409,
    code: "pricing_changed",
  });
});

test("pricing_changed: another pricing model than the one accepted", () => {
  // Agreed per use; the listing is now monthly.
  assert.equal(access({ licence: perUseLicence(5n), listing: MONTHLY, sub: null }), "pricing_changed");
  // Agreed monthly and the month is over; the listing is now per use.
  assert.equal(
    access({
      licence: monthlyLicence(),
      listing: PER_USE,
      sub: paidMonth({ status: "expired", currentPeriodEnd: inDays(-2) }),
    }),
    "pricing_changed",
  );
  // The same before the renewal worker has closed the row.
  assert.equal(
    access({
      licence: monthlyLicence(),
      listing: PER_USE,
      sub: paidMonth({ currentPeriodEnd: inDays(-4) }),
    }),
    "pricing_changed",
  );
  // A licence with no recorded acceptance agreed to no price at all.
  assert.equal(
    access({
      licence: { kind: "use", status: "active", accepted: { pricingModel: null, pricePerRequestCents: null } },
      listing: PER_USE,
      sub: null,
    }),
    "pricing_changed",
  );
});

test("subscription_lapsed: monthly and not paid up is a 402, and never free", () => {
  const lapsed = [
    { licence: monthlyLicence(), sub: null },
    { licence: monthlyLicence(), sub: paidMonth({ status: "expired", currentPeriodEnd: inDays(-1) }) },
    // Past the grace a failed renewal gets.
    { licence: monthlyLicence(), sub: paidMonth({ status: "past_due", currentPeriodEnd: inDays(-4) }) },
    { licence: monthlyLicence({ status: "suspended" }), sub: paidMonth({ status: "expired", currentPeriodEnd: inDays(-9) }) },
  ];
  for (const row of lapsed) {
    const result = access({ ...row, listing: MONTHLY });
    assert.equal(result, "subscription_lapsed", JSON.stringify(row.sub?.status ?? null));
    const decision = useDecision(result, MONTHLY);
    assert.deepEqual(decision, { runs: false, charged: false, status: 402, code: "subscription_lapsed" });
  }
  // A failed renewal inside its grace still has access.
  assert.equal(
    access({ licence: monthlyLicence(), listing: MONTHLY, sub: paidMonth({ status: "past_due", currentPeriodEnd: inDays(-1) }) }),
    "subscribed",
  );
});

test("a per-use licence on an archived listing is not offered", () => {
  for (const listing of [
    { ...PER_USE, status: "archived" },
    { ...PER_USE, status: "draft" },
    // Still published, but it sells copies now.
    { ...PER_USE, sells: "copies" },
    // Token-gated use is not sold.
    { ...PER_USE, pricingModel: "tokenized" },
    // Not even when it was made free on the way out.
    { ...FREE, status: "archived" },
  ]) {
    const result = access({ licence: perUseLicence(5n), listing, sub: null });
    assert.equal(result, "not_offered", `${listing.status} ${listing.sells} ${listing.pricingModel}`);
  }
  assert.deepEqual(useDecision("not_offered", PER_USE), {
    runs: false,
    charged: false,
    status: 409,
    code: "not_offered",
  });
});

test("no refusal runs or charges, and only per use is ever charged", () => {
  const all: UseAccess[] = [
    "none",
    "subscribed",
    "listing_pricing",
    "pricing_changed",
    "subscription_lapsed",
    "plan_ended",
    "not_offered",
  ];
  for (const result of all) {
    for (const listing of [PER_USE, MONTHLY, FREE]) {
      const decision = useDecision(result, listing);
      if (!decision.runs) assert.equal(decision.charged, false);
      if (decision.charged) {
        assert.equal(result, "listing_pricing");
        assert.equal(listing.pricingModel, "per_request");
      }
    }
  }
});

// ============================================
// Plans: a subscription row with a count of included uses
// ============================================

// What these pin: a plan gives access for the period that was paid for, like
// a month; when it is over the buyer chooses, and is charged per use only
// under a per-use price they accepted themselves; and a row with no count is
// read exactly as it was before plans existed.

/** A licence started on a plan: no per-use price was ever agreed to. */
const planLicence = (over: Partial<UseLicence> = {}): UseLicence => ({
  kind: "use",
  status: "active",
  accepted: { pricingModel: null, pricePerRequestCents: null },
  ...over,
});
const planMonth = (over: Partial<UseSubscription> = {}): UseSubscription => ({
  id: "sub_1",
  planId: "plan_1",
  status: "active",
  currentPeriodStart: inDays(-20),
  currentPeriodEnd: inDays(10),
  cancelAtPeriodEnd: false,
  endReason: null,
  includedUses: 500,
  usedInPeriod: 12,
  carriedUses: 0,
  extraUsePriceCents: 4n,
  ...over,
});

test("a plan gives access for the period paid for, whatever the listing says now", () => {
  for (const listing of [PER_USE, { ...PER_USE, pricePerRequestCents: 50n }, { ...PER_USE, status: "archived" }, MONTHLY]) {
    assert.equal(access({ licence: planLicence(), listing, sub: planMonth() }), "subscribed");
  }
  // Used up is still inside the plan: what happens to the next use is the count's to decide.
  assert.equal(access({ licence: planLicence(), listing: PER_USE, sub: planMonth({ usedInPeriod: 500 }) }), "subscribed");
  // A renewal that is being retried keeps the days of grace a month has.
  assert.equal(
    access({ licence: planLicence(), listing: PER_USE, sub: planMonth({ status: "past_due", currentPeriodEnd: inDays(-2) }) }),
    "subscribed",
  );
});

test("plan_ended: a plan that is over and will not renew is a choice, never a charge per use", () => {
  const ended: Array<[string, UseSubscription, Partial<UseLicence>?]> = [
    ["renewal cancelled, period over", planMonth({ cancelAtPeriodEnd: true, currentPeriodEnd: inDays(-1) })],
    ["the renewal worker has not closed it yet", planMonth({ currentPeriodEnd: inDays(-4) })],
    ["expired unpaid", planMonth({ status: "expired", currentPeriodEnd: inDays(-4) }), { status: "suspended" }],
    ["the creator ended the plan", planMonth({ status: "cancelled", endReason: "plan_ended", currentPeriodEnd: inDays(-1) })],
    ["cancelled by the buyer", planMonth({ status: "cancelled", currentPeriodEnd: inDays(5) })],
  ];
  for (const [what, sub, licence] of ended) {
    assert.equal(access({ licence: planLicence(licence), listing: PER_USE, sub }), "plan_ended", what);
  }
  assert.deepEqual(useDecision("plan_ended", PER_USE), { runs: false, charged: false, status: 402, code: "plan_ended" });
});

test("a plan the creator ended has no days of grace after the period it paid for", () => {
  const retired = (over: Partial<UseSubscription>) => planMonth({ planRetired: true, ...over });
  // The 30 days that were paid for are finished.
  assert.equal(access({ licence: planLicence(), listing: PER_USE, sub: retired({ currentPeriodEnd: inDays(1) }) }), "subscribed");
  // One day later the row is still open (the worker runs hourly, or not at all): it is over all the same.
  assert.equal(access({ licence: planLicence(), listing: PER_USE, sub: retired({ currentPeriodEnd: inDays(-1) }) }), "plan_ended");
  // The same row on a plan that is still offered is inside its grace.
  assert.equal(
    access({ licence: planLicence(), listing: PER_USE, sub: planMonth({ currentPeriodEnd: inDays(-1) }) }),
    "subscribed",
  );
});

test("after a plan, a per-use price is charged only if the buyer accepted it themselves", () => {
  const over = planMonth({ status: "cancelled", currentPeriodEnd: inDays(-1) });
  // Agreed to 5 cents a use, at some point, in their own name.
  assert.equal(access({ licence: perUseLicence(5n), listing: PER_USE, sub: over }), "listing_pricing");
  // Also for a row the worker has not closed yet: the agreement is the buyer's own.
  assert.equal(
    access({ licence: perUseLicence(5n), listing: PER_USE, sub: planMonth({ currentPeriodEnd: inDays(-4) }) }),
    "listing_pricing",
  );
  // A price above the one they agreed to is not theirs.
  assert.equal(
    access({ licence: perUseLicence(5n), listing: { ...PER_USE, pricePerRequestCents: 6n }, sub: over }),
    "plan_ended",
  );
  // Starting the plan was no agreement to a price per use, and neither is a monthly one.
  assert.equal(access({ licence: planLicence(), listing: PER_USE, sub: over }), "plan_ended");
  assert.equal(access({ licence: monthlyLicence(), listing: PER_USE, sub: over }), "plan_ended");
  // A licence that non-payment suspended is not charged per use on an old agreement.
  assert.equal(access({ licence: perUseLicence(5n, { status: "suspended" }), listing: PER_USE, sub: over }), "plan_ended");
});

test("a plan that is over on a listing that is not sold per use is not a choice of plans", () => {
  const over = planMonth({ status: "cancelled", currentPeriodEnd: inDays(-1) });
  assert.equal(access({ licence: planLicence(), listing: { ...PER_USE, status: "archived" }, sub: over }), "not_offered");
  assert.equal(access({ licence: planLicence(), listing: { ...PER_USE, sells: "copies" }, sub: over }), "not_offered");
  // Plans sit on a per-use listing only. On any other the older rules answer.
  assert.equal(access({ licence: planLicence(), listing: MONTHLY, sub: over }), "subscription_lapsed");
  // Somebody who stopped has no licence, plan or not.
  assert.equal(access({ licence: planLicence({ status: "uninstalled" }), listing: PER_USE, sub: planMonth() }), "none");
});

test("a row with no count is read exactly as before plans existed", () => {
  const listings = [PER_USE, { ...PER_USE, pricePerRequestCents: 6n }, MONTHLY, FREE, { ...MONTHLY, status: "archived" }];
  const licences = [perUseLicence(), monthlyLicence(), monthlyLicence({ status: "suspended" })];
  const subs: UseSubscription[] = [
    paidMonth(),
    paidMonth({ currentPeriodEnd: inDays(-1) }),
    paidMonth({ currentPeriodEnd: inDays(-4) }),
    paidMonth({ cancelAtPeriodEnd: true, currentPeriodEnd: inDays(-1) }),
    paidMonth({ status: "past_due", currentPeriodEnd: inDays(-2) }),
    paidMonth({ status: "expired", currentPeriodEnd: inDays(-4) }),
    paidMonth({ status: "cancelled", endReason: "pricing_changed" }),
  ];
  for (const listing of listings) {
    for (const licence of licences) {
      for (const sub of subs) {
        const before = access({ licence, listing, sub });
        assert.notEqual(before, "plan_ended");
        // The fields a plan adds change nothing while the marker is null, and
        // a row cannot be marked "plan ended by its creator" without a plan.
        const withNulls = { ...sub, includedUses: null, planId: null, usedInPeriod: 0, carriedUses: 0, planRetired: true };
        assert.equal(access({ licence, listing, sub: withNulls }), before);
      }
    }
  }
});
