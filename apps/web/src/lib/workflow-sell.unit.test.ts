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

import { LISTING_TITLE_MIN } from "./listing-draft";
import { LISTING_LINE_MAX, LISTING_LINE_MIN, LISTING_TITLE_MAX, SELL_LINE_TOO_SHORT, buildSellSave, formOfListing } from "./sell-choice";
import {
  PAID_RUN_LABEL,
  PAID_RUN_TRIGGER,
  WORKFLOW_LISTING_WORDS,
  WORKFLOW_NOT_SELLABLE,
  WORKFLOW_SELL_LINES,
  WORKFLOW_SELL_WORDS,
  firstWorkflowListingOf,
  listingForWorkflow,
  listingLineProblem,
  listingTitleProblem,
  listingWordsFieldErrors,
  listingWordsFormOf,
  listingWordsSaveOf,
  maxRunMinutesOf,
  ownAddressLine,
  ownListingEditHref,
  paidRunLimitLine,
  refusedForSale,
  sameListingWords,
  savedListingWordsOf,
  tooLongSentence,
  workflowEditHref,
  workflowListingUpdateOf,
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
    ...Object.values(WORKFLOW_LISTING_WORDS),
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

test("a first listing sends the workflow, the title and the line of its fields and the price, and goes on sale", () => {
  const built = buildSellSave(formOfListing(null, null, "workflow"), {}, LIMITS, "workflow");
  assert.equal(built.ok, false);
  const save = buildSellSave({ ...formOfListing(null, null, "workflow"), perUsePrice: "0.25" }, {}, LIMITS, "workflow");
  assert.ok(save.ok);
  // The fields open on what the first save took before they existed: a title from the name, cut to 100.
  const form = listingWordsFormOf({ name: `  ${"W".repeat(140)}  `, description: "Turns notes into a weekly report." }, null);
  assert.ok(listingWordsSaveOf(form, null).ok);
  const body = firstWorkflowListingOf("wf1", form, save.save);
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
  // What was typed is sent trimmed, as the check read it.
  const typed = firstWorkflowListingOf("wf1", { title: "  Weekly report ", line: " Turns notes into a weekly report. " }, save.save);
  assert.equal(typed.title, "Weekly report");
  assert.equal(typed.shortDescription, "Turns notes into a weekly report.");
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
// Its title and its one line
// ============================================

test("before the first save the fields open on the workflow's name and description, as the first save took them", () => {
  assert.deepEqual(listingWordsFormOf({ name: "  Weekly report  ", description: "  Turns notes into a weekly report.  " }, null), {
    title: "Weekly report",
    line: "Turns notes into a weekly report.",
  });
  // A description too short for a line, or none, leaves the line for the creator to write.
  assert.deepEqual(listingWordsFormOf({ name: "Report", description: "Notes" }, null), { title: "Report", line: "" });
  assert.deepEqual(listingWordsFormOf({ name: "Report", description: null }, null), { title: "Report", line: "" });
  assert.deepEqual(listingWordsFormOf({ name: "Report" }, null), { title: "Report", line: "" });
  // A description longer than a line is cut to the longest line.
  assert.equal(listingWordsFormOf({ name: "Report", description: "x".repeat(400) }, null).line, "x".repeat(280));
  // The fields are one-line inputs, which drop line breaks from what they show: the field, the check and the
  // request hold the same text, with every run of white space made one space.
  assert.equal(
    listingWordsFormOf({ name: "Report", description: "Turns notes\ninto a weekly report." }, null).line,
    "Turns notes into a weekly report.",
  );
  assert.equal(listingWordsFormOf({ name: "Weekly\n  report", description: null }, null).title, "Weekly report");
  // Line breaks never count toward the shortest line: "a", nine breaks and "b" is "a b", too short.
  assert.equal(listingWordsFormOf({ name: "Report", description: `a${"\n".repeat(9)}b` }, null).line, "");
});

test("once the listing exists the fields open on its own title and line, whatever the workflow is called", () => {
  const listing = { title: "Weekly digest", shortDescription: "A digest of your week, every Monday." };
  assert.deepEqual(listingWordsFormOf({ name: "Renamed workflow", description: "Something else entirely." }, listing), {
    title: "Weekly digest",
    line: "A digest of your week, every Monday.",
  });
  assert.deepEqual(savedListingWordsOf(listing), { title: "Weekly digest", line: "A digest of your week, every Monday." });
});

test("a title is checked as the API checks it: 3 to 100 characters, with a letter or a digit", () => {
  assert.equal(listingTitleProblem("Weekly report"), null);
  assert.equal(listingTitleProblem("abc"), null);
  assert.equal(listingTitleProblem("A1!"), null);
  assert.equal(listingTitleProblem("W".repeat(100)), null);
  // Checked on what is sent, the trimmed title.
  assert.equal(listingTitleProblem("  ab  "), "Give the listing a title of at least 3 characters.");
  assert.equal(listingTitleProblem(""), WORKFLOW_LISTING_WORDS.titleTooShort);
  assert.equal(listingTitleProblem("W".repeat(101)), "Keep the title to 100 characters or fewer.");
  // A title that makes an empty slug: the API's own sentence.
  for (const empty of ["!!!", "---", "   ***   ", "\u00e9\u00e9\u00e9"]) {
    assert.equal(listingTitleProblem(empty), "Give the listing a title with letters or numbers.", empty);
  }
  // A letter outside a to z next to one inside still makes a slug.
  assert.equal(listingTitleProblem("Caf\u00e9"), null);
});

test("a line is checked as the API checks it: 10 to 280 characters", () => {
  assert.equal(listingLineProblem("Turns notes into a report."), null);
  assert.equal(listingLineProblem("x".repeat(10)), null);
  assert.equal(listingLineProblem("x".repeat(280)), null);
  assert.equal(listingLineProblem("   short   "), SELL_LINE_TOO_SHORT);
  assert.equal(listingLineProblem(""), "Write at least 10 characters.");
  assert.equal(listingLineProblem("x".repeat(281)), "Keep this line to 280 characters or fewer.");
});

test("the limits and the empty-slug sentence are the API's own", () => {
  const routes = apiSource("routes/marketplace.ts");
  const create = routes.slice(routes.indexOf("const createListingSchema = z.object({"), routes.indexOf("pricingModel: z.enum("));
  // Trimmed before they are checked, as the screen trims them.
  assert.match(create, new RegExp(`title: z\\.string\\(\\)\\.trim\\(\\)\\.min\\(${LISTING_TITLE_MIN}\\)\\.max\\(${LISTING_TITLE_MAX}\\),`));
  assert.match(create, new RegExp(`shortDescription: z\\.string\\(\\)\\.trim\\(\\)\\.min\\(${LISTING_LINE_MIN}\\)\\.max\\(${LISTING_LINE_MAX}\\),`));
  // A change takes the same fields, each optional.
  assert.match(routes, /const updateListingSchema = createListingSchema\.omit\(\{ agentId: true, orchestrationId: true \}\)\.partial\(\);/);
  assert.match(
    apiSource("services/workflowListing.ts"),
    new RegExp(`emptySlug: "${WORKFLOW_LISTING_WORDS.titleNoLetters.replace(/\./g, "\\.")}",`),
  );
  // The slug is the title lowercased, every run of anything but a to z and 0 to 9 made one dash.
  const service = apiSource("services/marketplace.ts");
  assert.match(service, /\.toLowerCase\(\)\s+\.replace\(\/\[\^a-z0-9\]\+\/g, "-"\)\s+\.replace\(\/\^-\|-\$\/g, ""\);/);
});

test("a first listing sends both fields, checked; a change sends only what changed", () => {
  const typed = { title: "  Weekly report ", line: " Turns notes into a weekly report. " };
  assert.deepEqual(listingWordsSaveOf(typed, null), {
    ok: true,
    words: { title: "Weekly report", shortDescription: "Turns notes into a weekly report." },
  });
  assert.deepEqual(listingWordsSaveOf({ title: "ab", line: "short" }, null), {
    ok: false,
    errors: { title: WORKFLOW_LISTING_WORDS.titleTooShort, line: SELL_LINE_TOO_SHORT },
  });
  assert.deepEqual(listingWordsSaveOf({ title: "Weekly report", line: "" }, null), {
    ok: false,
    errors: { line: SELL_LINE_TOO_SHORT },
  });

  const saved = { title: "Weekly report", line: "Turns notes into a weekly report." };
  assert.deepEqual(listingWordsSaveOf(saved, saved), { ok: true, words: {} });
  // Spaces around are not a change.
  assert.deepEqual(listingWordsSaveOf({ title: " Weekly report ", line: saved.line }, saved), { ok: true, words: {} });
  assert.deepEqual(listingWordsSaveOf({ ...saved, title: "Weekly digest" }, saved), { ok: true, words: { title: "Weekly digest" } });
  assert.deepEqual(listingWordsSaveOf({ ...saved, line: "A digest of your week." }, saved), {
    ok: true,
    words: { shortDescription: "A digest of your week." },
  });
  assert.deepEqual(listingWordsSaveOf({ ...saved, title: "!!!" }, saved), {
    ok: false,
    errors: { title: WORKFLOW_LISTING_WORDS.titleNoLetters },
  });
  // A title the listing already has is never held against a change of price, even one the check would refuse now.
  const odd = { title: "!!!", line: saved.line };
  assert.deepEqual(listingWordsSaveOf(odd, odd), { ok: true, words: {} });
});

test("the fields are unchanged when only spaces around them changed", () => {
  const saved = { title: "Weekly report", line: "Turns notes into a weekly report." };
  assert.equal(sameListingWords(saved, { title: " Weekly report", line: "Turns notes into a weekly report.  " }), true);
  assert.equal(sameListingWords(saved, { ...saved, title: "Weekly reports" }), false);
  assert.equal(sameListingWords(saved, { ...saved, line: "Turns notes into a monthly report." }), false);
});

test("a change of a listing sends the answer to the question and the words that changed", () => {
  const save = { sells: "use" as const, pricingModel: "per_request" as const, pricePerRequestCents: 25 };
  assert.deepEqual(workflowListingUpdateOf(save, { title: "Weekly digest" }, { status: "published" }), {
    ...save,
    title: "Weekly digest",
  });
  assert.deepEqual(workflowListingUpdateOf(save, {}, { status: "published" }), save);
  // Not on sale: it goes on sale in the same request, as the question's own save does.
  assert.deepEqual(workflowListingUpdateOf(save, { shortDescription: "A digest of your week." }, { status: "archived" }), {
    ...save,
    publish: true,
    shortDescription: "A digest of your week.",
  });
});

test("the API's refusal of the title or the line is said under that field, and nothing else is", () => {
  assert.deepEqual(
    listingWordsFieldErrors({
      title: "Give the listing a title with letters or numbers.",
      shortDescription: '"shortDescription" must be at least 10 characters.',
      pricePerRequestCents: "The price per run must be at least $0.05.",
    }),
    {
      title: "Give the listing a title with letters or numbers.",
      line: '"shortDescription" must be at least 10 characters.',
    },
  );
  assert.deepEqual(listingWordsFieldErrors({ pricingModel: "x" }), {});
  assert.deepEqual(listingWordsFieldErrors({ toString: "x", constructor: "y" }), {});
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
