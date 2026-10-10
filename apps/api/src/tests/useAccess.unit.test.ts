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
  const all: UseAccess[] = ["none", "subscribed", "listing_pricing", "pricing_changed", "subscription_lapsed", "not_offered"];
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
