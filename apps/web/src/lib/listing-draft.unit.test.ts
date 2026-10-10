/**
 * The listing wizard: listed agents, why Next is not ready, what a save
 * sends, and its buttons. Run with:
 *   cd apps/web && npx tsx --test src/lib/listing-draft.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentRows,
  createListingBody,
  detailsOfListing,
  editListingHref,
  emptyDetails,
  newListingHref,
  pickAgent,
  previewSellsLine,
  stepProblem,
  submitButtons,
  updateListingBody,
  type ListingDetails,
  type WizardState,
} from "./listing-draft";
import { buildSellSave, emptySellForm, withCopies, type SellSave } from "./sell-choice";

const LISTINGS = [
  { id: "l1", agentId: "a1", status: "published" },
  { id: "l2", agentId: "a2", status: "archived" },
];

function details(over: Partial<ListingDetails> = {}): ListingDetails {
  return {
    agentId: "a3",
    title: "Support Bot",
    shortDescription: "Answers questions about orders.",
    longDescription: "",
    category: "customer-support",
    ...over,
  };
}

function state(over: Partial<WizardState> = {}): WizardState {
  return { details: details(), sell: emptySellForm(), agent: { agentKind: "conversation", tools: [] }, ...over };
}

const USE_SAVE: SellSave = { sells: "use", pricingModel: "per_request", pricePerRequestCents: 5, allowedTools: [] };

test("agents that already have a listing are marked with it", () => {
  const rows = agentRows([{ id: "a1" }, { id: "a2" }, { id: "a3" }], LISTINGS);
  assert.deepEqual(
    rows.map((row) => [row.agent.id, row.listing?.id ?? null]),
    [
      ["a1", "l1"],
      ["a2", "l2"],
      ["a3", null],
    ],
  );
});

test("choosing an agent that has a listing opens that listing for editing", () => {
  assert.deepEqual(pickAgent("a1", LISTINGS, null), { kind: "go", href: "/dashboard/marketplace/publish?edit=l1" });
  // A listing that was taken down is still the agent's one listing.
  assert.deepEqual(pickAgent("a2", LISTINGS, null), { kind: "go", href: "/dashboard/marketplace/publish?edit=l2" });
  // From one edit to another.
  assert.deepEqual(pickAgent("a2", LISTINGS, "l1"), { kind: "go", href: "/dashboard/marketplace/publish?edit=l2" });
  // The agent of the listing being edited is already the one.
  assert.deepEqual(pickAgent("a1", LISTINGS, "l1"), { kind: "select" });
});

test("choosing an agent without a listing selects it, or leaves an edit for a new listing", () => {
  assert.deepEqual(pickAgent("a3", LISTINGS, null), { kind: "select" });
  assert.deepEqual(pickAgent("a3", LISTINGS, "l1"), { kind: "go", href: "/dashboard/marketplace/publish?agent=a3" });
  assert.equal(editListingHref("a b"), "/dashboard/marketplace/publish?edit=a%20b");
  assert.equal(newListingHref("a3"), "/dashboard/marketplace/publish?agent=a3");
});

test("a disabled Next says why, step by step", () => {
  assert.equal(stepProblem("agent", state({ details: emptyDetails() })), "Choose an agent to go on.");
  assert.equal(stepProblem("agent", state()), null);

  assert.equal(stepProblem("details", state({ details: details({ title: " ab " }) })), "Give the listing a title of at least 3 characters.");
  assert.equal(
    stepProblem("details", state({ details: details({ shortDescription: "too short" }) })),
    "Write a short description of at least 10 characters.",
  );
  assert.equal(stepProblem("details", state()), null);

  assert.equal(stepProblem("pricing", state({ agent: null })), "This agent is still loading.");
  assert.equal(stepProblem("pricing", state()), null);
  assert.equal(
    stepProblem("pricing", state({ sell: { ...emptySellForm(), choice: "per_use", perUsePrice: "0.01" } })),
    "The price per message must be at least $0.05.",
  );
  assert.equal(
    stepProblem("pricing", state({ sell: { ...emptySellForm(), choice: "monthly" } })),
    "Enter a price per month.",
  );
  assert.equal(stepProblem("preview", state()), null);
});

test("a new listing says what it sells: use, unless copies were chosen behind the dialog", () => {
  assert.deepEqual(createListingBody(details({ title: "  Support Bot " }), USE_SAVE, true), {
    agentId: "a3",
    title: "Support Bot",
    shortDescription: "Answers questions about orders.",
    longDescription: "",
    category: "customer-support",
    sells: "use",
    pricingModel: "per_request",
    pricePerRequestCents: 5,
    allowedTools: [],
    publish: true,
  });

  // The wizard's own form, untouched, sells use.
  const untouched = buildSellSave(emptySellForm(), { agentKind: "task" });
  assert.equal(untouched.ok && createListingBody(details(), untouched.save, false).sells, "use");

  const copies = buildSellSave(withCopies(emptySellForm(), true), { agentKind: "task" });
  assert.equal(copies.ok && createListingBody(details(), copies.save, false).sells, "copies");
});

test("a draft is saved without publish, and an edit never sends the agent", () => {
  assert.equal("publish" in createListingBody(details(), USE_SAVE, false), false);
  const body = updateListingBody(details(), USE_SAVE, false);
  assert.equal("agentId" in body, false);
  assert.equal("publish" in body, false);
  assert.equal(updateListingBody(details(), USE_SAVE, true).publish, true);
  assert.equal(body.sells, "use");
});

test("a listing reads back as the details that made it", () => {
  assert.deepEqual(
    detailsOfListing({ agentId: "a1", title: "T", shortDescription: "S", longDescription: null, category: "coding" }),
    { agentId: "a1", title: "T", shortDescription: "S", longDescription: "", category: "coding" },
  );
  assert.equal(detailsOfListing({ agentId: "a1", title: "T", shortDescription: "S", category: "games" }).category, "other");
});

test("an edit's button reads Save changes", () => {
  assert.deepEqual(
    submitButtons(null).map((button) => [button.label, button.publish]),
    [
      ["Save as draft", false],
      ["Publish now", true],
    ],
  );
  assert.deepEqual(
    submitButtons({ status: "published" }).map((button) => [button.label, button.publish, button.primary]),
    [["Save changes", false, true]],
  );
  assert.deepEqual(
    submitButtons({ status: "draft" }).map((button) => [button.label, button.publish]),
    [
      ["Save changes", false],
      ["Save and publish", true],
    ],
  );
});

test("the preview says what a buyer gets", () => {
  assert.equal(previewSellsLine({ sells: "use" }), "People use your agent on its page or through the API. They do not get a copy.");
  assert.equal(previewSellsLine({ sells: "copies" }), "Buyers get their own copy, including its instructions.");
});
