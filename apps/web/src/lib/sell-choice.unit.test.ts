/**
 * "Who can use it?": the choices per kind, the earnings line, what a save
 * sends, and what a change does to today's buyers. Run with:
 *   cd apps/web && npx tsx --test src/lib/sell-choice.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { splitCents } from "@wheelsai/shared/revenue";

import {
  DEFAULT_SELL_LIMITS,
  GUARANTEED_PRICE_LABEL,
  SELL_WORDS,
  asksForPayment,
  buildSellSave,
  buyerStats,
  capacityLine,
  checkTaskPrice,
  choicesOf,
  copiesDialog,
  copiesKeptLine,
  copyChoices,
  deliveryOptions,
  earnedOf,
  earningsLine,
  emptySellForm,
  firstListingOf,
  formOfListing,
  guaranteedOfferingBody,
  guaranteedOfferingOf,
  handWrittenOfferings,
  outboundToolsOf,
  sameSellForm,
  saleStanding,
  saleStatus,
  sellChoices,
  sellFieldErrors,
  sellLimitsOf,
  sellLineOf,
  sellProblem,
  sellUpdateOf,
  stopSellingSentence,
  switchToCopiesLine,
  withChoice,
  withCopies,
  withUse,
  sellWordsOf,
  type SellForm,
  type SellListing,
} from "./sell-choice";

const LIMITS = { minPerUseCents: 5, minMonthlyCents: 100, perBuyerPerDay: 200 };

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, `nothing at ${index}`);
  return item;
}

function form(over: Partial<SellForm> = {}): SellForm {
  return { ...emptySellForm(), ...over };
}

function listing(over: Partial<SellListing> = {}): SellListing {
  return {
    sells: "use",
    pricingModel: "per_request",
    pricePerRequestCents: 5,
    monthlyPriceCents: null,
    allowedTools: [],
    status: "published",
    buyers: { copies: 0, using: 0, subscribed: 0 },
    ...over,
  };
}

// --------------------------------------------
// The choices
// --------------------------------------------

test("an agent people talk to: free, pay per use by the message, monthly, then token holders", () => {
  const choices = sellChoices("conversation", LIMITS);
  assert.deepEqual(
    choices.map((choice) => choice.id),
    ["free", "per_use", "monthly", "token_holders"],
  );
  assert.equal(at(choices, 0).sentence, "Anyone with the link can use it. No sign-in. Their use counts toward your plan.");
  assert.equal(at(choices, 1).title, "Pay per use");
  assert.equal(at(choices, 1).sentence, "People pay for each message from their WheelsAI credits.");
  assert.equal(at(choices, 1).priceLabel, "Price per message (minimum $0.05)");
  assert.equal(at(choices, 1).priceHint, "Charged when they send it. Refunded if your agent does not answer.");
  assert.equal(at(choices, 2).sentence, "People pay every 30 days and can use it up to 200 times a day.");
  assert.equal(at(choices, 2).priceLabel, "Price per month (minimum $1.00)");
});

test("an agent people give a task: the same three, by the run", () => {
  const choices = sellChoices("task", LIMITS);
  assert.deepEqual(
    choices.map((choice) => choice.id),
    ["free", "per_use", "monthly", "token_holders"],
  );
  assert.equal(at(choices, 1).sentence, "People pay for each run from their WheelsAI credits.");
  assert.equal(at(choices, 1).priceLabel, "Price per run (minimum $0.05)");
});

test("an agent that runs on its own: free or monthly, never per use", () => {
  const choices = sellChoices("scheduled", LIMITS);
  assert.deepEqual(
    choices.map((choice) => choice.id),
    ["free", "monthly", "token_holders"],
  );
  assert.equal(at(choices, 1).sentence, "People pay every 30 days to read its results on its page and through the API.");
});

test("token holders is always shown and never selectable, for every kind", () => {
  for (const kind of ["conversation", "task", "scheduled"] as const) {
    const choices = sellChoices(kind, LIMITS);
    const token = at(choices, choices.length - 1);
    assert.equal(token.id, "token_holders");
    assert.equal(token.selectable, false);
    assert.equal(token.sentence, "People who hold your agent's token can use it. Available once your agent has a token.");
    // Picking it changes nothing, and a form that holds it cannot be saved.
    const before = form({ choice: "free" });
    assert.equal(withChoice(before, "token_holders", choices), before);
    const built = buildSellSave(form({ choice: "token_holders" }), { agentKind: kind }, LIMITS);
    assert.equal(built.ok, false);
  }
});

test("the minimums and the daily count are the server's own; without them the monthly sentence names no count", () => {
  const limits = sellLimitsOf({ paidUse: { minPricePerUseCents: 8, perBuyerPerDay: 150 } });
  assert.deepEqual(limits, { minPerUseCents: 8, minMonthlyCents: 100, perBuyerPerDay: 150 });
  assert.equal(at(sellChoices("conversation", limits), 1).priceLabel, "Price per message (minimum $0.08)");
  assert.equal(at(sellChoices("conversation", limits), 2).sentence, "People pay every 30 days and can use it up to 150 times a day.");

  assert.deepEqual(sellLimitsOf(null), DEFAULT_SELL_LIMITS);
  assert.equal(at(sellChoices("conversation", sellLimitsOf(null)), 2).sentence, "People pay every 30 days.");
});

test("an unknown kind reads as an agent people talk to", () => {
  assert.deepEqual(
    sellChoices(null).map((choice) => choice.id),
    ["free", "per_use", "monthly", "token_holders"],
  );
});

test("capacity names the plan's own allowance, and nothing when it could not be read", () => {
  assert.equal(
    capacityLine(200),
    "On WheelsAI's models your agent can answer up to 200 times a day on your plan. Add your own model key or upgrade to serve more.",
  );
  assert.match(capacityLine(10_000) ?? "", /up to 10,000 times a day/);
  assert.equal(capacityLine(null), null);
  assert.equal(capacityLine(undefined), null);
  assert.equal(capacityLine(0), null);
});

// --------------------------------------------
// Earnings
// --------------------------------------------

test("the earnings line is the API's integer split, not nine tenths", () => {
  assert.equal(earningsLine(form({ choice: "per_use", perUsePrice: "0.05" }), "conversation"), "At $0.05 a message you earn $0.04.");
  assert.equal(earningsLine(form({ choice: "per_use", perUsePrice: "0.10" }), "task"), "At $0.10 a run you earn $0.09.");
  assert.equal(earningsLine(form({ choice: "monthly", monthlyPrice: "9" }), "conversation"), "At $9.00 a month you earn $8.10.");
  assert.equal(earningsLine(form({ choice: "monthly", monthlyPrice: "9.99" }), "scheduled"), "At $9.99 a month you earn $8.99.");
});

test("the earnings line agrees with splitCents at every price from 1 cent to $100", () => {
  for (let cents = 1; cents <= 10_000; cents += 1) {
    const line = earningsLine(form({ choice: "per_use", perUsePrice: (cents / 100).toFixed(2) }), "conversation");
    const earned = (splitCents(cents).creatorCents / 100).toFixed(2);
    assert.ok(line?.endsWith(`you earn $${earned}.`), `${cents}: ${line}`);
  }
});

test("no earnings line without a price that can be read", () => {
  assert.equal(earningsLine(form({ choice: "free" }), "conversation"), null);
  assert.equal(earningsLine(form({ choice: "per_use", perUsePrice: "" }), "conversation"), null);
  assert.equal(earningsLine(form({ choice: "per_use", perUsePrice: "abc" }), "conversation"), null);
  assert.equal(earningsLine(form({ choice: "per_use", perUsePrice: "0.045" }), "conversation"), null);
  assert.equal(earningsLine(form({ choice: "per_use", perUsePrice: "0" }), "conversation"), null);
  // A price typed under the other choice is not this choice's price.
  assert.equal(earningsLine(form({ choice: "monthly", perUsePrice: "0.05" }), "conversation"), null);
});

test("a copy's request is called a request", () => {
  assert.equal(
    earningsLine(form({ sells: "copies", choice: "per_use", perUsePrice: "0.05" }), "task"),
    "At $0.05 a request you earn $0.04.",
  );
});

// --------------------------------------------
// What a save sends
// --------------------------------------------

const AGENT = {
  agentKind: "conversation" as const,
  tools: [{ name: "http_request" }, { name: "calculator" }, { name: "http_request" }],
};

test("free sends use, free, and no outbound tool unless it was allowed", () => {
  assert.deepEqual(buildSellSave(form(), AGENT, LIMITS), {
    ok: true,
    save: { sells: "use", pricingModel: "free", allowedTools: [] },
  });
});

test("pay per use sends the price in cents and the agent's outbound tools when the switch is on", () => {
  assert.deepEqual(buildSellSave(form({ choice: "per_use", perUsePrice: "0.05", allowOutbound: true }), AGENT, LIMITS), {
    ok: true,
    save: { sells: "use", pricingModel: "per_request", pricePerRequestCents: 5, allowedTools: ["http_request"] },
  });
  assert.deepEqual(buildSellSave(form({ choice: "per_use", perUsePrice: " 1.5 " }), AGENT, LIMITS), {
    ok: true,
    save: { sells: "use", pricingModel: "per_request", pricePerRequestCents: 150, allowedTools: [] },
  });
});

test("monthly sends the monthly price and never the other choice's price", () => {
  const built = buildSellSave(form({ choice: "monthly", monthlyPrice: "9.00", perUsePrice: "0.05" }), AGENT, LIMITS);
  assert.deepEqual(built, {
    ok: true,
    save: { sells: "use", pricingModel: "monthly", monthlyPriceCents: 900, allowedTools: [] },
  });
});

test("only tools that send requests out are ever allowed, and only ones the agent has", () => {
  assert.deepEqual(outboundToolsOf(AGENT.tools), ["http_request"]);
  assert.deepEqual(outboundToolsOf([{ name: "calculator" }]), []);
  assert.deepEqual(outboundToolsOf(null), []);
  assert.deepEqual(outboundToolsOf([null, "http_request", { name: 4 }]), []);
  const built = buildSellSave(form({ allowOutbound: true }), { agentKind: "task", tools: [{ name: "calculator" }] }, LIMITS);
  assert.deepEqual(built, { ok: true, save: { sells: "use", pricingModel: "free", allowedTools: [] } });
});

test("the minimum prices are field errors in plain words", () => {
  assert.deepEqual(buildSellSave(form({ choice: "per_use", perUsePrice: "0.04" }), AGENT, LIMITS), {
    ok: false,
    errors: { perUsePrice: "The price per message must be at least $0.05." },
  });
  assert.deepEqual(buildSellSave(form({ choice: "per_use", perUsePrice: "0.04" }), { agentKind: "task" }, LIMITS), {
    ok: false,
    errors: { perUsePrice: "The price per run must be at least $0.05." },
  });
  assert.deepEqual(buildSellSave(form({ choice: "monthly", monthlyPrice: "0.99" }), AGENT, LIMITS), {
    ok: false,
    errors: { monthlyPrice: "The price per month must be at least $1.00." },
  });
});

test("an empty, unreadable or too large price says so", () => {
  assert.equal(sellProblem(form({ choice: "per_use" }), AGENT, LIMITS), "Enter a price per message.");
  assert.equal(
    sellProblem(form({ choice: "per_use", perUsePrice: "five" }), AGENT, LIMITS),
    "Enter the price per message in dollars and cents, like 0.05.",
  );
  assert.equal(
    sellProblem(form({ choice: "per_use", perUsePrice: "1000.01" }), AGENT, LIMITS),
    "The price per message can be at most $1,000.00.",
  );
  assert.equal(sellProblem(form({ choice: "monthly" }), AGENT, LIMITS), "Enter a price per month.");
  assert.equal(
    sellProblem(form({ choice: "monthly", monthlyPrice: "100000.01" }), AGENT, LIMITS),
    "The price per month can be at most $100,000.00.",
  );
  assert.equal(sellProblem(form(), AGENT, LIMITS), null);
});

test("a self-running agent cannot be saved per use", () => {
  const built = buildSellSave(form({ choice: "per_use", perUsePrice: "0.05" }), { agentKind: "scheduled" }, LIMITS);
  assert.deepEqual(built, { ok: false, errors: { choice: "Choose Free or Monthly." } });
});

test("a listing that is not on sale is published by the save; one that is keeps its state", () => {
  const save = { sells: "use" as const, pricingModel: "free" as const, allowedTools: [] };
  assert.deepEqual(sellUpdateOf(save, { status: "published" }), save);
  assert.deepEqual(sellUpdateOf(save, { status: "draft" }), { ...save, publish: true });
  assert.deepEqual(sellUpdateOf(save, { status: "archived" }), { ...save, publish: true });
});

test("a first sale makes a listing from the agent's name and line, on sale at once", () => {
  const save = { sells: "use" as const, pricingModel: "per_request" as const, pricePerRequestCents: 5, allowedTools: [] };
  assert.deepEqual(firstListingOf({ id: "a1", name: "  Support Bot " }, "Answers questions about orders.", save), {
    agentId: "a1",
    title: "Support Bot",
    shortDescription: "Answers questions about orders.",
    category: "other",
    sells: "use",
    pricingModel: "per_request",
    pricePerRequestCents: 5,
    allowedTools: [],
    publish: true,
  });
  assert.equal(firstListingOf({ id: "a1", name: "x".repeat(140) }, "A line of ten.", save).title.length, 100);
});

test("the listing's line: the first candidate of ten characters or more, cut to 280", () => {
  assert.equal(sellLineOf([null, "short", "  Answers questions.  "]), "Answers questions.");
  assert.equal(sellLineOf([undefined, "", "too short"]), null);
  assert.equal(sellLineOf(["y".repeat(400)])?.length, 280);
});

test("a refused save's sentences go under the input they are about", () => {
  assert.deepEqual(
    sellFieldErrors({
      pricePerRequestCents: "The price per message must be at least $0.05.",
      monthlyPriceCents: "The price per month must be at least $1.00.",
      pricingModel: "An agent that runs on its own can be free or sold by the month, not per use.",
      allowedTools: 'Your agent has no tool named "x".',
    }),
    {
      perUsePrice: "The price per message must be at least $0.05.",
      monthlyPrice: "The price per month must be at least $1.00.",
      choice: "An agent that runs on its own can be free or sold by the month, not per use.",
    },
  );
});

test("nothing is said to be earned at a price below the smallest that can be sold", () => {
  // splitCents(1) keeps nothing for the platform; a 1 cent message cannot be sold, so no line.
  assert.equal(earningsLine(form({ choice: "per_use", perUsePrice: "0.01" }), "conversation", LIMITS), null);
  assert.equal(earningsLine(form({ choice: "per_use", perUsePrice: "0.04" }), "task", LIMITS), null);
  assert.equal(earningsLine(form({ choice: "monthly", monthlyPrice: "0.99" }), "conversation", LIMITS), null);
  assert.equal(
    earningsLine(form({ choice: "per_use", perUsePrice: "0.05" }), "conversation", LIMITS),
    "At $0.05 a message you earn $0.04.",
  );
  // A copy's request may cost 1 cent, as before.
  assert.equal(
    earningsLine(form({ sells: "copies", choice: "per_use", perUsePrice: "0.01" }), "conversation", LIMITS),
    "At $0.01 a request you earn $0.01.",
  );
});

test("a refused field the question does not ask for is not put under a choice", () => {
  // The title, the short description and a tool are not inputs of the question: the screen shows
  // the refusal's own message for them.
  assert.deepEqual(
    sellFieldErrors({
      title: "Title must be at least 3 characters.",
      shortDescription: "Short description must be at least 10 characters.",
      allowedTools: 'Your agent has no tool named "x".',
    }),
    {},
  );
  assert.deepEqual(sellFieldErrors({ title: "Too short.", monthlyPriceCents: "The price per month must be at least $1.00." }), {
    monthlyPrice: "The price per month must be at least $1.00.",
  });
});

// --------------------------------------------
// The current listing as a choice
// --------------------------------------------

test("no listing is the question unanswered: use, free", () => {
  assert.deepEqual(formOfListing(null), emptySellForm());
  assert.deepEqual(emptySellForm(), { sells: "use", choice: "free", perUsePrice: "", monthlyPrice: "", allowOutbound: false });
});

test("a listing reads back as the choice that made it", () => {
  assert.deepEqual(formOfListing(listing({ allowedTools: ["http_request"] }), "conversation"), {
    sells: "use",
    choice: "per_use",
    perUsePrice: "0.05",
    monthlyPrice: "",
    allowOutbound: true,
  });
  assert.deepEqual(
    formOfListing(listing({ pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900 }), "scheduled"),
    { sells: "use", choice: "monthly", perUsePrice: "", monthlyPrice: "9.00", allowOutbound: false },
  );
  assert.equal(formOfListing(listing({ pricingModel: "free", pricePerRequestCents: null }), "task").choice, "free");
});

test("a round trip: what a listing means is what a save of it sends", () => {
  const current = listing({ pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 1250 });
  const built = buildSellSave(formOfListing(current, "task"), { agentKind: "task" }, LIMITS);
  assert.deepEqual(built, { ok: true, save: { sells: "use", pricingModel: "monthly", monthlyPriceCents: 1250, allowedTools: [] } });
});

test("a use listing on terms its kind does not have reads as free", () => {
  assert.equal(formOfListing(listing(), "scheduled").choice, "free");
  assert.equal(formOfListing(listing({ pricingModel: "tokenized" }), "conversation").choice, "free");
});

test("a copies listing keeps every price it could have, token holders included", () => {
  const tokenized = formOfListing(listing({ sells: "copies", pricingModel: "tokenized", pricePerRequestCents: null }), "conversation");
  assert.deepEqual(tokenized, { sells: "copies", choice: "token_holders", perUsePrice: "", monthlyPrice: "", allowOutbound: false });
  assert.deepEqual(buildSellSave(tokenized, AGENT, LIMITS), { ok: true, save: { sells: "copies", pricingModel: "tokenized" } });

  const perRequest = formOfListing(listing({ sells: "copies", pricePerRequestCents: 1 }), "scheduled");
  assert.deepEqual(buildSellSave(perRequest, { agentKind: "scheduled" }, LIMITS), {
    ok: true,
    save: { sells: "copies", pricingModel: "per_request", pricePerRequestCents: 1 },
  });
  assert.equal(copyChoices(LIMITS).every((choice) => choice.selectable), true);
  assert.equal(at(copyChoices(LIMITS), 1).priceLabel, "Price per request (minimum $0.01)");
});

// --------------------------------------------
// Copies only behind the dialog
// --------------------------------------------

test("the question never offers copies as a choice", () => {
  for (const kind of ["conversation", "task", "scheduled"] as const) {
    for (const choice of sellChoices(kind, LIMITS)) {
      assert.doesNotMatch(`${choice.title} ${choice.sentence}`, /cop(y|ies)/i);
    }
    assert.equal(choicesOf(emptySellForm(), kind, LIMITS).length, sellChoices(kind, LIMITS).length);
  }
});

test("copies are sold only after the dialog was confirmed", () => {
  const before = form({ choice: "per_use", perUsePrice: "0.05" });
  assert.equal(withCopies(before, false), before);
  assert.equal(withCopies(before, undefined as unknown as boolean), before);
  assert.equal(withCopies(before, "yes" as unknown as boolean), before);
  const after = withCopies(before, true);
  assert.equal(after.sells, "copies");
  assert.equal(after.choice, "per_use");
  // A new form, and a save from the page, sell use.
  assert.equal(emptySellForm().sells, "use");
  const built = buildSellSave(before, AGENT, LIMITS);
  assert.equal(built.ok && built.save.sells, "use");
});

test("the copies dialog says what a buyer gets, and for a self-running agent what is not shared", () => {
  assert.deepEqual(copiesDialog("conversation"), {
    title: "Sell copies of this agent?",
    description:
      "From now on buyers install their own copy and can read its instructions. People who pay to use it keep access until what they paid for ends.",
    confirmLabel: "Sell copies",
  });
  assert.equal(copiesDialog("task").description, copiesDialog("conversation").description);
  assert.equal(
    copiesDialog("scheduled").description,
    "From now on buyers install their own copy and can read its instructions. People who pay to use it keep access until what they paid for ends. Buyers get the agent and your suggested times. Your results, your schedule and where your results go are not shared.",
  );
});

test("selling use again drops a choice use does not have", () => {
  assert.deepEqual(withUse(form({ sells: "copies", choice: "token_holders" }), "conversation").choice, "free");
  assert.deepEqual(withUse(form({ sells: "copies", choice: "per_use", perUsePrice: "0.05" }), "scheduled").choice, "free");
  const kept = withUse(form({ sells: "copies", choice: "monthly", monthlyPrice: "9.00" }), "scheduled");
  assert.deepEqual(kept, { sells: "use", choice: "monthly", perUsePrice: "", monthlyPrice: "9.00", allowOutbound: false });
  const use = form();
  assert.equal(withUse(use, "task"), use);
});

// --------------------------------------------
// Today's buyers
// --------------------------------------------

test("stopping: who loses access now and who keeps the month they paid for", () => {
  assert.equal(
    stopSellingSentence(listing({ pricingModel: "monthly", monthlyPriceCents: 900, buyers: { copies: 0, using: 5, subscribed: 2 } })),
    "Stop selling. People who pay per use lose access now. 2 subscribers keep access until the month they paid for ends and are not charged again.",
  );
  assert.equal(
    stopSellingSentence(listing({ pricingModel: "monthly", buyers: { copies: 0, using: 1, subscribed: 1 } })),
    "Stop selling. People who pay per use lose access now. 1 subscriber keeps access until the month they paid for ends and is not charged again.",
  );
  assert.equal(
    stopSellingSentence(listing({ buyers: { copies: 0, using: 3, subscribed: 0 } })),
    "Stop selling. People who pay per use lose access now.",
  );
  assert.equal(stopSellingSentence(listing({ pricingModel: "free" })), "Stop selling. Your agent leaves the marketplace.");
});

test("stopping a listing that sells copies takes no copy back", () => {
  assert.equal(
    stopSellingSentence(listing({ sells: "copies", buyers: { copies: 3, using: 0, subscribed: 0 } })),
    "Stop selling. Nobody new can get a copy. 3 people already have a copy. They keep it.",
  );
  assert.equal(stopSellingSentence(listing({ sells: "copies" })), "Stop selling. Nobody new can get a copy.");
});

test("after the switch to use: people who have a copy keep it", () => {
  assert.equal(copiesKeptLine(listing({ buyers: { copies: 3, using: 0, subscribed: 0 } })), "3 people already have a copy. They keep it.");
  assert.equal(copiesKeptLine(listing({ buyers: { copies: 1, using: 0, subscribed: 0 } })), "1 person already has a copy. They keep it.");
  assert.equal(copiesKeptLine(listing()), null);
  assert.equal(copiesKeptLine(listing({ buyers: undefined })), null);
  assert.equal(copiesKeptLine(null), null);
});

test("switching to copies: what it does to the people who pay now, with their numbers", () => {
  assert.equal(
    switchToCopiesLine(listing({ buyers: { copies: 0, using: 4, subscribed: 0 } })),
    "People who pay per use lose access now.",
  );
  assert.equal(
    switchToCopiesLine(listing({ pricingModel: "monthly", buyers: { copies: 0, using: 2, subscribed: 2 } })),
    "2 subscribers keep access until the month they paid for ends and are not charged again.",
  );
  assert.equal(switchToCopiesLine(listing()), null);
  assert.equal(switchToCopiesLine(listing({ status: "draft", buyers: { copies: 0, using: 4, subscribed: 0 } })), null);
  assert.equal(switchToCopiesLine(listing({ sells: "copies" })), null);
  assert.equal(switchToCopiesLine(null), null);
});

test("the counts under the status are the listing's own, each under its label", () => {
  assert.deepEqual(buyerStats(listing({ buyers: { copies: 0, using: 7, subscribed: 0 } })), [{ label: "People using it", value: "7" }]);
  assert.deepEqual(buyerStats(listing({ pricingModel: "monthly", buyers: { copies: 2, using: 7, subscribed: 3 } })), [
    { label: "People using it", value: "7" },
    { label: "Subscribers", value: "3" },
    { label: "Copies", value: "2" },
  ]);
  assert.deepEqual(buyerStats(listing({ sells: "copies", buyers: { copies: 1234, using: 0, subscribed: 0 } })), [
    { label: "Copies", value: "1,234" },
  ]);
  assert.deepEqual(buyerStats(listing({ buyers: undefined })), []);
});

test("what it earned is the API's figure for this listing, or nothing", () => {
  const rows = [
    { listingId: "l1", totalRevenueCents: 1234, totalRequests: 310 },
    { listingId: "l2", totalRevenueCents: 5, totalRequests: 1 },
  ];
  assert.deepEqual(earnedOf(rows, "l1"), { earned: "$12.34", uses: "310" });
  assert.equal(earnedOf(rows, "l3"), null);
  assert.equal(earnedOf(null, "l1"), null);
});

// --------------------------------------------
// Where the sale stands
// --------------------------------------------

test("a listing's state in the words of the Sell tab", () => {
  assert.equal(saleStanding(null), "not_listed");
  assert.equal(saleStanding({ status: "published" }), "on_sale");
  assert.equal(saleStanding({ status: "archived" }), "stopped");
  assert.equal(saleStanding({ status: "pending_review" }), "in_review");
  assert.equal(saleStanding({ status: "draft" }), "draft");

  assert.deepEqual(saleStatus(listing(), "conversation"), {
    standing: "on_sale",
    label: "On sale",
    sentence: "People pay $0.05 per message to use it on its page or through the API.",
  });
  assert.equal(saleStatus(listing(), "task").sentence, "People pay $0.05 per run to use it on its page or through the API.");
  assert.equal(
    saleStatus(listing({ pricingModel: "monthly", monthlyPriceCents: 900 }), "scheduled").sentence,
    "People pay $9.00 a month to use it on its page or through the API.",
  );
  assert.equal(saleStatus(listing({ pricingModel: "free" }), "task").sentence, "Anyone with the link can use it. No sign-in.");
  assert.equal(
    saleStatus(listing({ sells: "copies" }), "task").sentence,
    "This agent sells copies. Buyers get its instructions. Price of a copy: $0.05 per request.",
  );
  assert.equal(saleStatus(listing({ status: "archived" }), "task").label, "Not on sale");
});

test("the lines about paying show only when use is sold at a price", () => {
  assert.equal(asksForPayment(form()), false);
  assert.equal(asksForPayment(form({ choice: "per_use" })), true);
  assert.equal(asksForPayment(form({ choice: "monthly" })), true);
  assert.equal(asksForPayment(form({ sells: "copies", choice: "monthly" })), false);
});

test("two forms are the same when they would send the same thing", () => {
  assert.equal(sameSellForm(form({ perUsePrice: "0.05" }), form()), true);
  assert.equal(sameSellForm(form({ choice: "per_use", perUsePrice: "0.05" }), form({ choice: "per_use", perUsePrice: "0.06" })), false);
  assert.equal(sameSellForm(form({ allowOutbound: true }), form()), false);
  assert.equal(sameSellForm(form({ sells: "copies" }), form()), false);
});

// --------------------------------------------
// Guaranteed delivery
// --------------------------------------------

test("guaranteed delivery: the price label, the three times, and a time kept that is none of them", () => {
  assert.equal(GUARANTEED_PRICE_LABEL, "Price per task (minimum $0.50)");
  assert.deepEqual(
    deliveryOptions().map((option) => option.label),
    ["10 minutes", "1 hour", "1 day"],
  );
  assert.deepEqual(
    deliveryOptions(7_200).map((option) => option.label),
    ["10 minutes", "1 hour", "2 hours", "1 day"],
  );
  assert.equal(deliveryOptions(3_600).length, 3);
  assert.equal(
    SELL_WORDS.guaranteed,
    "Sell with guaranteed delivery. A fixed price per task, held until the result is delivered and checked, and refunded if it is late.",
  );
});

test("the price of a task is 50 cents or more", () => {
  assert.deepEqual(checkTaskPrice("0.50"), { ok: true, cents: 50 });
  assert.deepEqual(checkTaskPrice("0.49"), { ok: false, message: "The price per task must be at least $0.50." });
  assert.deepEqual(checkTaskPrice(""), { ok: false, message: "Enter a price per task." });
  assert.deepEqual(checkTaskPrice("1000.01"), { ok: false, message: "The price per task can be at most $1,000.00." });
});

test("the offering made from the form is found; one written by hand is not it", () => {
  const offerings = [
    { id: "o1", agentId: "a1", status: "active", formInSync: null },
    { id: "o2", agentId: "a1", status: "paused", formInSync: true },
    { id: "o3", agentId: "a1", status: "active", formInSync: false },
    { id: "o4", agentId: "a1", status: "archived", formInSync: true },
    { id: "o5", agentId: "a2", status: "active", formInSync: true },
    { id: "o6", agentId: "a1", status: "draft" },
  ];
  assert.equal(guaranteedOfferingOf(offerings, "a1")?.id, "o3");
  assert.equal(guaranteedOfferingOf(offerings, "a2")?.id, "o5");
  assert.equal(guaranteedOfferingOf(offerings, "a3"), null);
  assert.equal(handWrittenOfferings(offerings, "a1"), 2);
  assert.equal(handWrittenOfferings(offerings, "a2"), 0);
});

test("the offering takes its form from the agent", () => {
  assert.deepEqual(guaranteedOfferingBody({ id: "a1", name: "Summarizer" }, "Summarizes a document.", 500, 3_600), {
    productKind: "agent",
    agentId: "a1",
    title: "Summarizer",
    description: "Summarizes a document.",
    priceCents: 500,
    slaSeconds: 3_600,
    fromAgentForm: true,
  });
});

// ============================================
// A workflow: one choice, pay per run
// ============================================

test("an agent's words are SELL_WORDS exactly; a workflow's have the same keys and never say agent", () => {
  assert.equal(sellWordsOf(), SELL_WORDS);
  assert.equal(sellWordsOf("agent"), SELL_WORDS);
  const words = sellWordsOf("workflow");
  assert.deepEqual(Object.keys(words).sort(), Object.keys(SELL_WORDS).sort());
  for (const [key, sentence] of Object.entries(words)) {
    assert.doesNotMatch(sentence, /\bagent\b/i, key);
    assert.doesNotMatch(sentence, /[\u2013\u2014]|unlimited|token/i, key);
    // A workflow's listing has no Hire offering and no task with guaranteed delivery.
    assert.doesNotMatch(sentence, /\bhire\b|guaranteed delivery|per task/i, key);
  }
  assert.equal(words.paidTasksUnavailable, words.priceTurnsOffFree);
  assert.equal(words.describe, "Add one line that tells people what this workflow does.");
  assert.equal(words.question, SELL_WORDS.question);
});

test("a workflow is offered one choice, pay per run, with its price floor and its own hint", () => {
  const choices = sellChoices("conversation", LIMITS, "workflow");
  assert.deepEqual(choices, [
    {
      id: "per_use",
      title: "Pay per run",
      sentence: "People pay for each run from their WheelsAI credits.",
      selectable: true,
      priceLabel: "Price per run (minimum $0.05)",
      priceHint: "Charged when a run starts. Refunded if the run does not finish.",
    },
  ]);
  // No Free, no Monthly, no Token holders, and no copies whatever the form says.
  assert.deepEqual(choicesOf(form({ sells: "copies" }), null, LIMITS, "workflow"), choices);
  // An agent's choices are what they were.
  assert.deepEqual(sellChoices("conversation", LIMITS, "agent"), sellChoices("conversation", LIMITS));
  assert.deepEqual(choicesOf(form(), "task", LIMITS, "agent"), choicesOf(form(), "task", LIMITS));
});

test("a workflow's form is always pay per run, with its listing's price", () => {
  assert.deepEqual(formOfListing(null, null, "workflow"), {
    sells: "use",
    choice: "per_use",
    perUsePrice: "",
    monthlyPrice: "",
    allowOutbound: false,
  });
  const listing: SellListing = { sells: "use", pricingModel: "per_request", pricePerRequestCents: 25, allowedTools: ["http_request"] };
  assert.deepEqual(formOfListing(listing, null, "workflow"), {
    sells: "use",
    choice: "per_use",
    perUsePrice: "0.25",
    monthlyPrice: "",
    allowOutbound: false,
  });
  // An agent's listing reads as it did.
  assert.deepEqual(formOfListing(listing, "conversation", "agent"), formOfListing(listing, "conversation"));
});

test("a workflow's save sends use per request with its price and no tools", () => {
  const sent = buildSellSave(form({ choice: "per_use", perUsePrice: "0.10", allowOutbound: true }), {}, LIMITS, "workflow");
  assert.deepEqual(sent, { ok: true, save: { sells: "use", pricingModel: "per_request", pricePerRequestCents: 10 } });
  assert.deepEqual(buildSellSave(form({ choice: "per_use", perUsePrice: "0.01" }), {}, LIMITS, "workflow"), {
    ok: false,
    errors: { perUsePrice: "The price per run must be at least $0.05." },
  });
  assert.deepEqual(buildSellSave(form({ choice: "per_use", perUsePrice: "" }), {}, LIMITS, "workflow"), {
    ok: false,
    errors: { perUsePrice: "Enter a price per run." },
  });
  // A choice a workflow does not have is refused, naming the one it has.
  assert.deepEqual(buildSellSave(form({ choice: "monthly", monthlyPrice: "9" }), {}, LIMITS, "workflow"), {
    ok: false,
    errors: { choice: "Choose Pay per run." },
  });
  assert.equal(sellProblem(form({ choice: "per_use", perUsePrice: "0.01" }), {}, LIMITS, "workflow"), "The price per run must be at least $0.05.");
  assert.equal(sellProblem(form({ choice: "per_use", perUsePrice: "1" }), {}, LIMITS, "workflow"), null);
});

test("a workflow's earnings line is per run, from the API's own split", () => {
  const per = form({ choice: "per_use", perUsePrice: "0.10" });
  const { creatorCents } = splitCents(10);
  assert.equal(earningsLine(per, "conversation", LIMITS, "workflow"), `At $0.10 a run you earn $${(creatorCents / 100).toFixed(2)}.`);
  assert.equal(earningsLine(form({ choice: "per_use", perUsePrice: "0.01" }), null, LIMITS, "workflow"), null);
  // An agent that talks still earns by the message.
  assert.match(earningsLine(per, "conversation", LIMITS) ?? "", /a message/);
});
