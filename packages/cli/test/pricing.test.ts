import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CliError } from "../src/errors.js";
import { describePricing, parseCategory, parsePricing, pricingNote } from "../src/lib/pricing.js";
import { parseWholeNumber } from "../src/lib/numbers.js";

describe("parsePricing", () => {
  it("returns null when no pricing flag is given", () => {
    assert.equal(parsePricing({}), null);
  });

  it("maps each flag to the API's pricing model", () => {
    assert.deepEqual(parsePricing({ free: true }), { pricingModel: "free" });
    assert.deepEqual(parsePricing({ tokenized: true }), { pricingModel: "tokenized" });
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

describe("price limits (the API's own, checked before anything is deployed)", () => {
  it("accepts the ends of each range", () => {
    assert.deepEqual(parsePricing({ pricePerRequest: "1" }), { pricingModel: "per_request", pricePerRequestCents: 1 });
    assert.deepEqual(parsePricing({ pricePerRequest: "100000" }), { pricingModel: "per_request", pricePerRequestCents: 100000 });
    assert.deepEqual(parsePricing({ monthly: "100" }), { pricingModel: "monthly", monthlyPriceCents: 100 });
    assert.deepEqual(parsePricing({ monthly: "10000000" }), { pricingModel: "monthly", monthlyPriceCents: 10000000 });
  });

  it("refuses a price the API would reject", () => {
    for (const [flags, message] of [
      [{ pricePerRequest: "0" }, /--price-per-request must be between 1 and 100000 cents, got 0/],
      [{ pricePerRequest: "100001" }, /--price-per-request must be between 1 and 100000 cents/],
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
