/**
 * Selling a workflow: its listing, its words, where it stands and where its
 * buyers use it. Run with:
 *   cd apps/web && npx tsx --test src/lib/workflow-sell.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildSellSave, formOfListing } from "./sell-choice";
import {
  PAID_RUN_LABEL,
  PAID_RUN_TRIGGER,
  WORKFLOW_NOT_SELLABLE,
  WORKFLOW_SELL_LINES,
  WORKFLOW_SELL_WORDS,
  firstWorkflowListingOf,
  listingForWorkflow,
  maxRunMinutesOf,
  ownAddressLine,
  ownListingEditHref,
  paidRunLimitLine,
  refusedForSale,
  tooLongSentence,
  workflowEditHref,
  workflowModelId,
  workflowPageAddress,
  workflowPagePath,
  workflowSaleStatus,
  workflowSellLines,
  workflowSellProblem,
  workflowStopSellingSentence,
} from "./workflow-sell";

const here = dirname(fileURLToPath(import.meta.url));
const apiSource = (path: string) => readFileSync(join(here, "../../../api/src", path), "utf8");

const LIMITS = { minPerUseCents: 5, minMonthlyCents: 100, perBuyerPerDay: 200 };

// ============================================
// The words
// ============================================

test("the four sentences of the Sell part, in their order, with the longest run from the capabilities", () => {
  assert.deepEqual(workflowSellLines(10), [
    "Steps that ran before a run failed or was cancelled are your cost.",
    "A paid run is stopped after 10 minutes.",
    "In a paid run your steps cannot move money, change your saved files or call a web address with the HTTP request tool.",
    "Paid runs appear in this workflow's runs, with what the buyer sent.",
  ]);
  // Not known: the line with a number is left out, never guessed.
  assert.deepEqual(workflowSellLines(null), [
    WORKFLOW_SELL_LINES.stepsCost,
    WORKFLOW_SELL_LINES.hiredMode,
    WORKFLOW_SELL_LINES.runsListed,
  ]);
  assert.equal(paidRunLimitLine(1), "A paid run is stopped after 1 minute.");
  assert.equal(paidRunLimitLine(null), null);
});

test("the longest run is read from paidWorkflowMaxRunMs and nothing else", () => {
  assert.equal(maxRunMinutesOf({ paidUse: { paidWorkflowMaxRunMs: 600_000 } }), 10);
  assert.equal(maxRunMinutesOf({ paidUse: { paidWorkflowMaxRunMs: 60_000 } }), 1);
  for (const unread of [null, undefined, {}, { paidUse: null }, { paidUse: {} }]) assert.equal(maxRunMinutesOf(unread), null);
  for (const odd of [0, -60_000, 90_000, 600_000.5, "600000", Number.NaN]) {
    assert.equal(maxRunMinutesOf({ paidUse: { paidWorkflowMaxRunMs: odd } }), null, String(odd));
  }
});

test("no sentence a creator or a list reads has an em dash, the word unlimited or a token", () => {
  const all = [
    ...Object.values(WORKFLOW_SELL_LINES),
    ...Object.values(WORKFLOW_SELL_WORDS),
    ...Object.values(WORKFLOW_NOT_SELLABLE),
    ...workflowSellLines(10),
    tooLongSentence(10),
    ownAddressLine("workflow/report"),
    workflowStopSellingSentence({ buyers: { copies: 0, using: 1, subscribed: 3 } }),
    PAID_RUN_LABEL,
  ];
  for (const sentence of all) assert.doesNotMatch(sentence, /[\u2013\u2014]|unlimited|token/i, sentence);
});

test("the owner's own address is said to be theirs and counted on their plan", () => {
  assert.equal(
    ownAddressLine("workflow/weekly-report"),
    "workflow/weekly-report is your own address: a call to it runs as you and counts as an API call on your plan. People who pay use the page and the model id shown under Sell.",
  );
});

test("a run a buyer paid for is named in the run list by its trigger", () => {
  assert.equal(PAID_RUN_TRIGGER, "paid");
  assert.equal(PAID_RUN_LABEL, "Paid run by a buyer");
  // The trigger is the API's own word for a paid run.
  assert.match(apiSource("services/workflowListing.ts"), /export const PAID_WORKFLOW_TRIGGER = "paid";/);
});

// ============================================
// Can it go on sale
// ============================================

const workflow = (over: Partial<{ isEnabled: boolean; steps: unknown[] | null; timeout: number }> = {}) => ({
  isEnabled: true,
  steps: [{ id: "s1" }],
  timeout: 300_000,
  ...over,
});

test("a disabled workflow, one with no steps and one that runs too long each read why", () => {
  assert.equal(workflowSellProblem(workflow(), 10), null);
  assert.equal(workflowSellProblem(workflow({ isEnabled: false }), 10), "This workflow is disabled. Enable it before selling it.");
  assert.equal(workflowSellProblem(workflow({ steps: [] }), 10), "This workflow has no steps yet.");
  assert.equal(workflowSellProblem(workflow({ steps: null }), 10), "This workflow has no steps yet.");
  assert.equal(
    workflowSellProblem(workflow({ timeout: 600_001 }), 10),
    "A workflow on sale must finish within 10 minutes. Set its time limit to 10 minutes or less.",
  );
  // Exactly the longest run is allowed, as the API allows it.
  assert.equal(workflowSellProblem(workflow({ timeout: 600_000 }), 10), null);
  // The longest run not known: the time limit is left to the API.
  assert.equal(workflowSellProblem(workflow({ timeout: 3_600_000 }), null), null);
});

test("the sentences are the API's own, word for word", () => {
  const source = apiSource("services/workflowListing.ts");
  assert.ok(source.includes(`disabled: "${WORKFLOW_NOT_SELLABLE.disabled}"`));
  assert.ok(source.includes(`noSteps: "${WORKFLOW_NOT_SELLABLE.noSteps}"`));
  assert.ok(
    source.includes(
      "tooLong: `A workflow on sale must finish within ${MAX_RUN_MINUTES} minutes. Set its time limit to ${MAX_RUN_MINUTES} minutes or less.`",
    ),
  );
  const minutes = Number(/export const PAID_WORKFLOW_MAX_RUN_MS = ([\d_]+);/.exec(source)?.[1]?.replace(/_/g, "")) / 60_000;
  assert.equal(
    tooLongSentence(minutes),
    `A workflow on sale must finish within ${minutes} minutes. Set its time limit to ${minutes} minutes or less.`,
  );
});

test("a refusal for a workflow on sale or with buyers offers the way to its Sell part", () => {
  assert.equal(refusedForSale("workflow_on_sale"), true);
  assert.equal(refusedForSale("workflow_has_buyers"), true);
  for (const other of ["stale_definition", "not_found", "", null, undefined]) assert.equal(refusedForSale(other), false);
  const errors = apiSource("services/workflowErrors.ts");
  assert.match(errors, /workflow_on_sale: 409/);
  assert.match(errors, /workflow_has_buyers: 409/);
});

// ============================================
// Its listing
// ============================================

const own = (over: Record<string, unknown> = {}) => ({
  id: "l1",
  productKind: "workflow" as const,
  agentId: null,
  orchestrationId: "wf1",
  status: "published",
  ...over,
});

test("the listing of a workflow is found by orchestrationId among the organization's own", () => {
  const agentListing = { id: "l0", productKind: "agent" as const, agentId: "a1", orchestrationId: null };
  const listings = [agentListing, own({ id: "l2", orchestrationId: "wf2" }), own()];
  assert.equal(listingForWorkflow(listings, "wf1")?.id, "l1");
  assert.equal(listingForWorkflow(listings, "wf2")?.id, "l2");
  assert.equal(listingForWorkflow(listings, "wf3"), null);
  // An agent's listing is never a workflow's, whatever id it carries.
  assert.equal(listingForWorkflow([{ ...agentListing, orchestrationId: "wf1" }], "wf1"), null);
});

test("a first listing sends the workflow, a title from its name, its line and the price, and goes on sale", () => {
  const built = buildSellSave(formOfListing(null, null, "workflow"), {}, LIMITS, "workflow");
  assert.equal(built.ok, false);
  const save = buildSellSave({ ...formOfListing(null, null, "workflow"), perUsePrice: "0.25" }, {}, LIMITS, "workflow");
  assert.ok(save.ok);
  const body = firstWorkflowListingOf({ id: "wf1", name: `  ${"W".repeat(140)}  ` }, "Turns notes into a weekly report.", save.save);
  assert.deepEqual(body, {
    orchestrationId: "wf1",
    title: "W".repeat(100),
    shortDescription: "Turns notes into a weekly report.",
    category: "other",
    sells: "use",
    pricingModel: "per_request",
    pricePerRequestCents: 25,
    publish: true,
  });
  assert.equal("agentId" in body, false);
  assert.equal("allowedTools" in body, false);
});

test("Edit of a workflow's listing goes to the workflow's API tab; an agent's to the wizard", () => {
  assert.equal(workflowEditHref(own()), "/dashboard/orchestrations/wf1?tab=api");
  assert.equal(ownListingEditHref(own()), "/dashboard/orchestrations/wf1?tab=api");
  const agentListing = { id: "l0", productKind: "agent" as const, agentId: "a1", orchestrationId: null };
  assert.equal(workflowEditHref(agentListing), null);
  assert.equal(ownListingEditHref(agentListing), "/dashboard/marketplace/publish?edit=l0");
  // An older API that says nothing of the product: a listing with an agent is an agent's.
  assert.equal(ownListingEditHref({ id: "l0", agentId: "a1" }), "/dashboard/marketplace/publish?edit=l0");
  // A workflow's listing whose workflow was not said has nowhere else to go.
  assert.equal(workflowEditHref(own({ orchestrationId: undefined })), null);
});

// ============================================
// Where the sale stands
// ============================================

test("the status of a workflow's listing in a workflow's words", () => {
  const listing = { sells: "use", pricingModel: "per_request", pricePerRequestCents: 25 } as const;
  assert.deepEqual(workflowSaleStatus({ ...listing, status: "published" }), {
    standing: "on_sale",
    label: "On sale",
    sentence: "People pay $0.25 per run to use it on its page or through the API.",
  });
  assert.deepEqual(workflowSaleStatus({ ...listing, status: "draft" }), {
    standing: "draft",
    label: "Draft",
    sentence: "This workflow has a listing that is a draft. Nobody else can see it yet.",
  });
  assert.deepEqual(workflowSaleStatus({ ...listing, status: "archived" }), {
    standing: "stopped",
    label: "Not on sale",
    sentence: "You stopped selling this workflow. Nobody new can find it on the marketplace.",
  });
  assert.equal(workflowSaleStatus({ ...listing, status: "pending_review" }).standing, "in_review");
});

test("what stopping does, with the number of people on a plan from the listing", () => {
  assert.equal(workflowStopSellingSentence({}), "Stop selling. People who pay per run lose access now.");
  assert.equal(
    workflowStopSellingSentence({ buyers: { copies: 0, using: 4, subscribed: 1 } }),
    "Stop selling. People who pay per run lose access now. 1 person on a plan keeps it until the 30 days they paid for end and is not charged again.",
  );
  assert.equal(
    workflowStopSellingSentence({ buyers: { copies: 0, using: 4, subscribed: 1200 } }),
    "Stop selling. People who pay per run lose access now. 1,200 people on a plan keep it until the 30 days they paid for end and are not charged again.",
  );
  assert.equal(
    workflowStopSellingSentence({ buyers: { copies: 0, using: 0, subscribed: -2 } }),
    "Stop selling. People who pay per run lose access now.",
  );
});

// ============================================
// Where buyers use it
// ============================================

test("buyers use the listing's slug: the page /w/<slug> and model w/<slug>", () => {
  assert.equal(workflowPagePath("weekly-report"), "/w/weekly-report");
  assert.equal(workflowPageAddress("https://app.example.com/", "weekly-report"), "https://app.example.com/w/weekly-report");
  assert.equal(workflowPageAddress("", "weekly-report"), "/w/weekly-report");
  assert.equal(workflowPageAddress(null, "weekly-report"), "/w/weekly-report");
  assert.equal(workflowModelId("weekly-report"), "w/weekly-report");
  // Never the owner's own model id.
  assert.doesNotMatch(workflowModelId("weekly-report"), /^workflow\//);
});
