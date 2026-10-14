/**
 * What the landing page says about earning, held to what a creator can do.
 * Run with:
 *   npx tsx --test src/components/landing/features-grid.unit.test.ts
 *
 * The page is read as source: it is a client component, and what matters
 * here is its words.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const grid = readFileSync(join(here, "features-grid.tsx"), "utf8");
const apiSource = (path: string) => readFileSync(join(here, "..", "..", "..", "..", "api", "src", path), "utf8");

/** The part about earning: from its label to the end of the list of pillars. */
const earning = grid.slice(grid.indexOf('label: "MONETIZE"'), grid.indexOf("export function FeaturesGrid"));

interface Card {
  title: string;
  description: string;
}

const cards: Card[] = [...earning.matchAll(/title: "([^"]+)",\s+description:\s+"([^"]+)"/g)].map((match) => ({
  title: match[1]!,
  description: match[2]!,
}));

test("the part about earning leads with plans and the API, and keeps the marketplace and the tokens", () => {
  assert.deepEqual(
    cards.map((card) => card.title),
    ["Plans With Uses Included", "An API Buyers Pay For", "Marketplace for Every Product", "Agent Tokens"],
  );
  const [plans, api, marketplace, tokens] = cards as [Card, Card, Card, Card];
  assert.match(plans.description, /one price for 30 days, a number of uses included/);
  assert.match(plans.description, /a price for each extra use or a stop until the plan renews/);
  assert.match(api.description, /OpenAI-compatible API, with one key and one balance/);
  // Nothing the page said before is cut: every kind of product, every way of pricing one, the receipts.
  assert.match(marketplace.description, /List agents, workflows and models for free\./);
  assert.match(marketplace.description, /free, per request, monthly or tokenized/);
  assert.match(marketplace.description, /every sale is backed by on-chain receipts/);
  assert.match(tokens.description, /bonding-curve token for your agent/);
});

test("its numbers are the product's: four plans, 30 days, and 90% to the creator", () => {
  assert.match(apiSource("services/listingPlans.ts"), /MAX_PAID_PLANS = 4;/);
  assert.match(earning, /Add up to four plans to a listing/);
  assert.match(apiSource("services/subscriptionAccess.ts"), /SUBSCRIPTION_PERIOD_DAYS = 30\b/);
  const shared = readFileSync(join(here, "..", "..", "..", "..", "..", "packages", "shared", "src", "revenue.ts"), "utf8");
  assert.match(shared, /PLATFORM_FEE_PERCENT = 10\b/);
  assert.match(earning, /You keep 90% of every sale/);
});

test("the free trial it names is one a creator can offer, said once and in its place", () => {
  // The product has it: a plan of its own kind in the rules a creator's plans are checked by.
  const rules = apiSource("services/listingPlans.ts");
  assert.match(rules, /kind: "paid" \| "trial";/);
  assert.match(rules, /const trial = plan\.kind === "trial";/);
  const [plans] = cards as [Card];
  assert.match(
    plans.description,
    /a stop until the plan renews\. Offer a free trial so buyers can try it first\. Subscribers keep the terms they agreed to\.$/,
  );
  assert.equal(earning.split("free trial").length, 2, "the free trial is said once");
});

test("it claims no creators, buyers, calls or earnings, and no plan without a count", () => {
  // The only numbers in the part about earning are the rules above.
  const numbers = cards.flatMap((card) => `${card.title} ${card.description}`.match(/\d[\d,.]*%?/g) ?? []);
  assert.deepEqual(numbers.sort(), ["30", "90%"]);
  for (const word of [/unlimited/i, /\bcreators\b/i, /\bcustomers\b/i, /\bearned\b/i, /\brevenue\b/i, /\btrusted by\b/i]) {
    assert.doesNotMatch(earning, word);
  }
});

test("the file is plain ASCII", () => {
  assert.ok(/^[\x00-\x7F]*$/.test(grid), "a character outside ASCII is typed in the landing's features");
});
