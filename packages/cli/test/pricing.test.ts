import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import {
  FREE_TRIAL_DAYS,
  describeFreeTrial,
  describeOffers,
  describePlan,
  describePlans,
  describePricing,
  describeSells,
  parseCategory,
  parsePricing,
  pricingNote,
} from "../src/lib/pricing.js";
import { parseWholeNumber } from "../src/lib/numbers.js";

describe("parsePricing", () => {
  it("returns null when no pricing flag is given", () => {
    assert.equal(parsePricing({}), null);
  });

  it("maps each flag to the API's pricing model", () => {
    assert.deepEqual(parsePricing({ free: true }), { pricingModel: "free" });
    assert.deepEqual(parsePricing({ tokenized: true, copies: true }), { pricingModel: "tokenized" });
    assert.deepEqual(parsePricing({ pricePerRequest: "5" }), { pricingModel: "per_request", pricePerRequestCents: 5 });
    assert.deepEqual(parsePricing({ monthly: "900" }), { pricingModel: "monthly", monthlyPriceCents: 900 });
  });

  it("refuses two pricing choices at once", () => {
    assert.throws(() => parsePricing({ free: true, monthly: "900" }), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /Choose one pricing option, not --monthly and --free/);
      return true;
    });
  });

  it("refuses prices that are not whole cents", () => {
    for (const bad of ["abc", "1.5", "-3", ""]) {
      assert.throws(() => parsePricing({ pricePerRequest: bad }), CliError, `--price-per-request ${bad}`);
    }
  });
});

describe("a listing sells use unless --copies says otherwise", () => {
  it("--tokenized needs --copies, and says so plainly", () => {
    assert.throws(() => parsePricing({ tokenized: true }), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.message, "--tokenized needs --copies: a token-gated listing sells copies of the agent, not use of it.");
      assert.match(err.hint ?? "", /Add --copies/);
      return true;
    });
    assert.deepEqual(parsePricing({ tokenized: true, copies: true }), { pricingModel: "tokenized" });
  });

  it("a use listing charges at least 5 cents a use; copies can charge 1", () => {
    assert.throws(() => parsePricing({ pricePerRequest: "4" }), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /--price-per-request must be between 5 and 100000 cents, got 4/);
      assert.match(err.hint ?? "", /at least 5 cents per use/);
      return true;
    });
    assert.deepEqual(parsePricing({ pricePerRequest: "5" }), { pricingModel: "per_request", pricePerRequestCents: 5 });
    assert.deepEqual(parsePricing({ pricePerRequest: "1", copies: true }), { pricingModel: "per_request", pricePerRequestCents: 1 });
  });

  it("--copies alone is not a pricing choice, and the monthly range is the same either way", () => {
    assert.equal(parsePricing({ copies: true }), null);
    assert.deepEqual(parsePricing({ monthly: "100" }), { pricingModel: "monthly", monthlyPriceCents: 100 });
    assert.deepEqual(parsePricing({ monthly: "100", copies: true }), { pricingModel: "monthly", monthlyPriceCents: 100 });
  });
});

describe("describeSells", () => {
  it("says what a listing sells and what one payment buys", () => {
    assert.equal(describeSells({ sells: "use", unit: "message" }), "use, per message");
    assert.equal(describeSells({ sells: "use", unit: "run" }), "use, per run");
    assert.equal(describeSells({ sells: "use", unit: "month" }), "use, per month");
    assert.equal(describeSells({ sells: "use", unit: null }), "use");
    assert.equal(describeSells({ sells: "copies", unit: null }), "copies");
    assert.equal(describeSells({}), "unknown");
  });
});

describe("a listing's plans, in the words buyers read", () => {
  const starter = { id: "p1", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 4 };
  const team = { id: "p2", name: "Team", priceCents: 2900, includedUses: 2000, extraUsePriceCents: null };
  const listing = { sells: "use", pricingModel: "per_request" };

  it("a plan is its price for 30 days, its uses, and what happens after them", () => {
    assert.equal(describePlan(starter), "Starter: $9.00 for 30 days, 500 uses, then $0.04 a use");
    assert.equal(describePlan(team), "Team: $29.00 for 30 days, 2000 uses, then it stops until it renews");
    assert.equal(describePlan({ ...team, name: "  One  ", priceCents: 100, includedUses: 1 }), "One: $1.00 for 30 days, 1 use, then it stops until it renews");
  });

  it("one line for each plan on offer, in the order the API sent them", () => {
    assert.deepEqual(describePlans({ ...listing, plans: [starter, team] }), [
      "Starter: $9.00 for 30 days, 500 uses, then $0.04 a use",
      "Team: $29.00 for 30 days, 2000 uses, then it stops until it renews",
    ]);
  });

  it("your own listing's plans say their status, and only the ones on offer are printed", () => {
    const plans = [
      { ...starter, kind: "paid", status: "active", subscribers: 12 },
      { ...team, kind: "paid", status: "retired", subscribers: 3 },
    ];
    assert.deepEqual(describePlans({ ...listing, plans }), ["Starter: $9.00 for 30 days, 500 uses, then $0.04 a use"]);
    // How many people are on a plan is not part of the line.
    assert.doesNotMatch(describePlans({ ...listing, plans }).join(" "), /12|subscriber/);
  });

  it("a listing that offers no plans has no line", () => {
    assert.deepEqual(describePlans(listing), []);
    assert.deepEqual(describePlans({ ...listing, plans: [] }), []);
    assert.deepEqual(describePlans({ ...listing, plans: null }), []);
    assert.deepEqual(describePlans({ ...listing, plans: "Starter" }), []);
    // Only a listing that sells use per request offers plans, whatever it carries.
    assert.deepEqual(describePlans({ sells: "use", pricingModel: "monthly", plans: [starter] }), []);
    assert.deepEqual(describePlans({ sells: "copies", pricingModel: "per_request", plans: [starter] }), []);
    assert.deepEqual(describePlans({ pricingModel: "per_request", plans: [starter] }), []);
  });

  it("a line is never written from half a plan", () => {
    const broken = [
      null,
      "Starter",
      { ...starter, name: " " },
      { ...starter, priceCents: 0 },
      { ...starter, priceCents: "900" },
      { ...starter, includedUses: 0 },
      { ...starter, includedUses: 1.5 },
      { ...starter, extraUsePriceCents: undefined },
      { ...starter, extraUsePriceCents: 0 },
      { name: "Starter" },
    ];
    assert.deepEqual(describePlans({ ...listing, plans: [...broken, team] }), [describePlan(team)]);
  });

  it("no plan is ever described as having no count", () => {
    for (const line of describePlans({ ...listing, plans: [starter, team] })) {
      assert.match(line, /\d+ uses?,/);
      assert.doesNotMatch(line, /unlimited/i);
    }
  });
});

describe("a listing's free trial, in the words buyers read", () => {
  const listing = { sells: "use", pricingModel: "per_request" };
  const offer = { id: "t1", includedUses: 20, days: 7 };
  /** The trial as your own listing carries it: the first of its plans, with its kind. */
  const owned = { id: "t1", kind: "trial", name: "Free trial", priceCents: 0, includedUses: 20, extraUsePriceCents: null, status: "active", subscribers: 3 };
  const starter = { id: "p1", kind: "paid", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 4, status: "active", subscribers: 12 };

  it("a listing read by its slug says its trial in one line, with the days it was sent", () => {
    assert.equal(describeFreeTrial({ ...listing, freeTrial: offer }), "Free trial: 20 uses for 7 days");
    assert.equal(describeFreeTrial({ ...listing, freeTrial: { ...offer, includedUses: 1, days: 1 } }), "Free trial: 1 use for 1 day");
    // The days are the read's own, not the CLI's number.
    assert.equal(describeFreeTrial({ ...listing, freeTrial: { ...offer, days: 3 } }), "Free trial: 20 uses for 3 days");
  });

  it("your own listing says the trial it has on offer among its plans", () => {
    assert.equal(describeFreeTrial({ ...listing, plans: [owned, starter] }), `Free trial: 20 uses for ${FREE_TRIAL_DAYS} days`);
    // How many people are on it is not part of the line.
    assert.doesNotMatch(describeFreeTrial({ ...listing, plans: [owned] })!, /3 |people|subscriber/);
    // One that is no longer on offer is not printed.
    assert.equal(describeFreeTrial({ ...listing, plans: [{ ...owned, status: "retired" }, starter] }), null);
  });

  it("the days of your own listing's trial are the API's", () => {
    // From the compiled test (.test-build/test), four levels up is the repository.
    const rules = readFileSync(new URL("../../../../apps/api/src/services/listingPlans.ts", import.meta.url), "utf8");
    assert.match(rules, new RegExp(`export const TRIAL_DAYS = ${FREE_TRIAL_DAYS};`));
    // And the kind an entry of a creator's plans says for it.
    assert.match(rules, /kind: "trial",\s+name: TRIAL_PLAN_NAME,\s+priceCents: 0n,/);
  });

  it("the line never names a price", () => {
    for (const read of [{ ...listing, freeTrial: offer }, { ...listing, plans: [owned] }]) {
      assert.doesNotMatch(describeFreeTrial(read)!, /\$|cent|price|free for/i);
    }
  });

  it("a listing that offers no trial has no line", () => {
    assert.equal(describeFreeTrial(listing), null);
    assert.equal(describeFreeTrial({ ...listing, freeTrial: null }), null);
    assert.equal(describeFreeTrial({ ...listing, plans: [starter] }), null);
    // Only a listing that sells use per request offers one, whatever it carries.
    assert.equal(describeFreeTrial({ sells: "use", pricingModel: "monthly", freeTrial: offer }), null);
    assert.equal(describeFreeTrial({ sells: "copies", pricingModel: "per_request", freeTrial: offer }), null);
    assert.equal(describeFreeTrial({ pricingModel: "per_request", freeTrial: offer, plans: [owned] }), null);
    // "Try it" is `trial` on a listing, and is another thing: it is never read as a free trial.
    assert.equal(describeFreeTrial({ ...listing, trial: { enabled: true } } as Parameters<typeof describeFreeTrial>[0]), null);
  });

  it("a line is never written from half a trial", () => {
    for (const broken of [
      "20 uses",
      {},
      { ...offer, id: "" },
      { includedUses: 20, days: 7 },
      { ...offer, includedUses: 0 },
      { ...offer, includedUses: 1.5 },
      { ...offer, includedUses: "20" },
      { ...offer, days: 0 },
      { id: "t1", includedUses: 20 },
    ]) {
      assert.equal(describeFreeTrial({ ...listing, freeTrial: broken }), null, JSON.stringify(broken));
    }
    for (const broken of [
      { ...owned, priceCents: 900 },
      { ...owned, extraUsePriceCents: 5 },
      { ...owned, extraUsePriceCents: undefined },
      { ...owned, includedUses: 0 },
      { ...owned, id: undefined },
      { ...owned, kind: "paid" },
    ]) {
      assert.equal(describeFreeTrial({ ...listing, plans: [broken] }), null, JSON.stringify(broken));
    }
  });

  it("what a listing offers is its trial first, then its plans, and the trial is never printed as a plan", () => {
    assert.deepEqual(describeOffers({ ...listing, plans: [owned, starter] }), [
      "Free trial: 20 uses for 7 days",
      "Starter: $9.00 for 30 days, 500 uses, then $0.04 a use",
    ]);
    assert.deepEqual(describePlans({ ...listing, plans: [owned, starter] }), ["Starter: $9.00 for 30 days, 500 uses, then $0.04 a use"]);
    assert.deepEqual(describeOffers({ ...listing, freeTrial: offer, plans: [] }), ["Free trial: 20 uses for 7 days"]);
    // A listing with plans and no trial prints what it printed before.
    assert.deepEqual(describeOffers({ ...listing, plans: [starter] }), describePlans({ ...listing, plans: [starter] }));
    assert.deepEqual(describeOffers(listing), []);
  });
});

describe("price limits (the API's own, checked before anything is deployed)", () => {
  it("accepts the ends of each range", () => {
    assert.deepEqual(parsePricing({ pricePerRequest: "5" }), { pricingModel: "per_request", pricePerRequestCents: 5 });
    assert.deepEqual(parsePricing({ pricePerRequest: "100000" }), { pricingModel: "per_request", pricePerRequestCents: 100000 });
    assert.deepEqual(parsePricing({ monthly: "100" }), { pricingModel: "monthly", monthlyPriceCents: 100 });
    assert.deepEqual(parsePricing({ monthly: "10000000" }), { pricingModel: "monthly", monthlyPriceCents: 10000000 });
  });

  it("refuses a price the API would reject", () => {
    for (const [flags, message] of [
      [{ pricePerRequest: "0", copies: true }, /--price-per-request must be between 1 and 100000 cents, got 0/],
      [{ pricePerRequest: "0" }, /--price-per-request must be between 5 and 100000 cents, got 0/],
      [{ pricePerRequest: "100001" }, /--price-per-request must be between 5 and 100000 cents/],
      [{ monthly: "50" }, /--monthly must be between 100 and 10000000 cents, got 50/],
      [{ monthly: "10000001" }, /--monthly must be between 100 and 10000000 cents/],
    ] as const) {
      assert.throws(() => parsePricing(flags), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.match(err.message, message);
        return true;
      });
    }
  });
});

describe("pricingNote", () => {
  it("says a tokenized listing is free until a token is launched, and nothing for the other models", () => {
    assert.match(pricingNote("tokenized") ?? "", /Until then anyone can install it for free/);
    for (const model of ["free", "per_request", "monthly"]) assert.equal(pricingNote(model), null);
  });
});

describe("describePricing", () => {
  it("states the price in dollars", () => {
    assert.equal(describePricing({ pricingModel: "free" }), "free");
    assert.equal(describePricing({ pricingModel: "tokenized" }), "token-gated");
    assert.equal(describePricing({ pricingModel: "per_request", pricePerRequestCents: 5 }), "$0.05 per request");
    assert.equal(describePricing({ pricingModel: "monthly", monthlyPriceCents: 900 }), "$9.00 per month");
  });
});

describe("parseCategory", () => {
  it("accepts the API's categories, case-insensitively", () => {
    assert.equal(parseCategory("Coding"), "coding");
    assert.equal(parseCategory(undefined), undefined);
  });

  it("lists the valid ones when given another", () => {
    assert.throws(() => parseCategory("finance"), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.match(err.hint ?? "", /customer-support, coding, research, automation, creative, other/);
      return true;
    });
  });
});

describe("parseWholeNumber", () => {
  it("parses whole numbers and enforces the minimum", () => {
    assert.equal(parseWholeNumber("--replicas", "3"), 3);
    assert.throws(() => parseWholeNumber("--replicas", "0"), CliError);
    assert.throws(() => parseWholeNumber("--replicas", "two"), CliError);
    assert.equal(parseWholeNumber("--lines", "10", 10), 10);
  });
});
