/**
 * The screens of a workflow on sale, read from their source: its Sell part on
 * the API tab, the run list, the refusals of a change or a delete, and every
 * list a listing, a licence or a usage row shows in. Nobody opens a browser
 * in these tests, so each holds what a screen draws by what its code says.
 * Run with:
 *   cd apps/web && npx tsx --test src/lib/workflow-sell-screens.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, "..", path), "utf8");
/** The source with its comments taken out, so a word in a comment is never taken for a word on screen. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const QUESTION = source("components/dashboard/sell/who-can-use.tsx");
const BLOCK = source("components/dashboard/sell/plans-block.tsx");
const SELL_TAB = source("components/dashboard/agent-tabs/sell-tab.tsx");
const SELL = source("components/dashboard/workflows/workflow-sell.tsx");
const API_TAB = source("components/dashboard/workflows/workflow-api-tab.tsx");
const RUNS = source("components/dashboard/workflows/run-history.tsx");
const WORKFLOW_PAGE = source("app/(dashboard)/dashboard/orchestrations/[id]/page.tsx");
const WORKFLOW_LIST = source("app/(dashboard)/dashboard/orchestrations/page.tsx");
const CARDS = source("app/marketplace/page.tsx");
const LISTING = source("app/marketplace/[slug]/page.tsx");
const MY_LISTINGS = source("app/(dashboard)/dashboard/marketplace/page.tsx");
const WIZARD = source("app/(dashboard)/dashboard/marketplace/publish/page.tsx");
const TOKEN_WIZARD = source("app/(dashboard)/dashboard/marketplace/tokens/create/page.tsx");
const INSTALLED = source("app/(dashboard)/dashboard/marketplace/installs/page.tsx");
const REVIEW_FORM = source("components/marketplace/review-form.tsx");
const USAGE = source("app/(dashboard)/dashboard/usage/page.tsx");
const STOP = source("components/dashboard/stop-deployment-warning.tsx");

// ============================================
// The question, asked of a workflow
// ============================================

test("the question asked of a workflow never draws what a workflow is not sold with", () => {
  assert.match(QUESTION, /subject = "agent",/);
  assert.match(QUESTION, /const workflow = subject === "workflow";/);
  assert.match(QUESTION, /const words = sellWordsOf\(subject\);/);
  // More options and Sell copies instead, the copies banner, the box about tools and keeping a copy.
  assert.match(QUESTION, /\{!workflow && \(moreOptions \|\| form\.sells === "use"\) && \(/);
  assert.match(QUESTION, /\{!workflow && form\.sells === "copies" && \(/);
  assert.match(QUESTION, /\{!workflow && paid && \(\s+<div className="space-y-3 rounded-lg border p-4">/);
  // The capacity line and the line about free use.
  assert.match(QUESTION, /const capacityText = !workflow && form\.sells === "use" \? capacityLine\(capacity\) : null;/);
  assert.match(QUESTION, /\{!workflow && <li>\{words\.priceTurnsOffFree\}<\/li>\}/);
  // The plans, with no free trial.
  assert.match(QUESTION, /offersTrial=\{!workflow\}/);
  // Every word is the pure file's, for the subject: none is written here.
  assert.equal(QUESTION.includes("SELL_WORDS"), false);
});

test("the plans block draws its trial only where the listing may offer one, which is everywhere but a workflow", () => {
  assert.match(BLOCK, /offersTrial = true,/);
  const gate = BLOCK.indexOf("{offersTrial && (");
  assert.ok(gate > 0);
  assert.ok(BLOCK.indexOf("<Switch") > gate, "the trial's switch is inside the gate");
  assert.ok(BLOCK.indexOf("{PLAN_WORDS.noUnlimited}") > BLOCK.indexOf("<Switch"));
});

test("an agent's Sell tab asks the question as it did: no subject, so an agent's", () => {
  assert.match(SELL_TAB, /<WhoCanUse\s+agent=\{agent\}/);
  assert.equal(/subject=/.test(SELL_TAB), false);
  assert.equal(/subject=/.test(WIZARD), false);
});

// ============================================
// The Sell part of a workflow
// ============================================

test("the Sell part is the first card of the workflow's API tab, and the tab says the owner's own address is theirs", () => {
  assert.match(API_TAB, /import \{ WorkflowSell \} from "\.\/workflow-sell";/);
  assert.ok(API_TAB.indexOf("<WorkflowSell workflow={workflow} />") < API_TAB.indexOf("OpenAI-compatible API"));
  assert.match(API_TAB, /<li>\{ownAddressLine\(workflow\.openaiModel\)\}<\/li>/);
});

test("the Sell part finds the workflow's listing by its id and asks the question of a workflow", () => {
  assert.match(SELL, /const listing = listingForWorkflow\(listings, workflow\.id\);/);
  assert.match(SELL, /<WhoCanUse\s+subject="workflow"/);
  // No agent, no copy setting, no More options: nothing of an agent's Sell tab that a workflow does not have.
  assert.equal(/keepCopy=|moreOptions=|onSoldAsCopies=|GuaranteedDelivery|readPageKey|saveKeepCopy/.test(SELL), false);
  assert.match(SELL, /formOfListing\(listing, null, "workflow"\)/);
  assert.match(SELL, /buildSellSave\(form, \{\}, limits, "workflow"\)/);
  // The four sentences, from the pure file, with the longest run from the capabilities.
  assert.match(SELL, /const maxRunMinutes = maxRunMinutesOf\(capabilities\);/);
  assert.match(SELL, /workflowSellLines\(maxRunMinutes\)\.map/);
  assert.equal(/minutes|10 min/.test(code(SELL)), false);
});

test("the Sell part saves the listing first, its plans second, and reads my listings again after", () => {
  const save = SELL.slice(SELL.indexOf("async function save()"), SELL.indexOf("async function stop()"));
  const listing = save.indexOf("marketplaceApi.updateListing(listing.id, workflowListingUpdateOf(built.save, wordsSave.words, listing))");
  const created = save.indexOf("marketplaceApi.createListing(firstWorkflowListingOf(workflow.id, words, built.save))");
  const plans = save.indexOf("marketplaceApi.setListingPlans(savedListing.id, plansSave.plans, plansSave.ended)");
  const reread = save.indexOf("await load(plansProblem !== null);");
  assert.ok(listing > 0 && created > 0 && plans > listing && plans > created && reread > plans);
  // A refused save says the API's sentence on its field, or whole when it is about no field.
  assert.match(save, /const fieldErrors = fields \? sellFieldErrors\(fields\) : \{\};/);
  assert.match(save, /if \(Object\.keys\(fieldErrors\)\.length === 0 && Object\.keys\(wordFieldErrors\)\.length === 0\) \{\s+setError\(getErrorMessage\(err,/);
});

test("the listing's title and one line are fields of the Sell part, before the first save and after it", () => {
  // Drawn in both shapes of the card, before the question; the box shown only for a short description is gone.
  assert.equal(SELL.split("{listingFields}").length, 3, "drawn in both shapes of the card");
  assert.match(SELL, /\{notSellableNotice\}\s+\{listingFields\}\s+\{question\}/);
  assert.equal(/lineDraft|knownLine|WORDS\.describe|sellLineOf/.test(SELL), false);
  // Each has a label, its limit, and the API's sentence or the check's under it.
  assert.match(SELL, /<Label htmlFor=\{`\$\{id\}-title`\}>\{WORKFLOW_LISTING_WORDS\.titleLabel\}<\/Label>/);
  assert.match(SELL, /<Label htmlFor=\{`\$\{id\}-line`\}>\{WORKFLOW_LISTING_WORDS\.lineLabel\}<\/Label>/);
  assert.match(SELL, /maxLength=\{LISTING_TITLE_MAX\}/);
  assert.match(SELL, /maxLength=\{LISTING_LINE_MAX\}/);
  assert.match(SELL, /\{wordErrors\.title \? \(/);
  assert.match(SELL, /\{wordErrors\.line \? \(/);
  // Filled from the workflow before the first save, from the listing as my listings reads it after.
  assert.match(SELL, /useState<ListingWordsForm>\(\(\) => listingWordsFormOf\(workflow, null\)\)/);
  assert.match(SELL, /if \(listing\) setWords\(savedListingWordsOf\(listing\)\);/);
  assert.match(SELL, /const savedWords = listing \? savedListingWordsOf\(listing\) : null;/);
  // A change of either enables Save.
  assert.match(SELL, /sameSellForm\(form, baseline\) && plansUnchanged && \(savedWords === null \|\| sameListingWords\(words, savedWords\)\)/);
});

test("the title and the line are checked before anything is sent, and a refusal of either is said under it", () => {
  const save = SELL.slice(SELL.indexOf("async function save()"), SELL.indexOf("async function stop()"));
  const checked = save.indexOf("const wordsSave = listingWordsSaveOf(words, savedWords);");
  assert.ok(checked > 0 && checked < save.indexOf('setBusy("save");'));
  assert.match(save, /if \(!wordsSave\.ok\) \{\s+setWordErrors\(wordsSave\.errors\);/);
  assert.match(save, /const wordFieldErrors = fields \? listingWordsFieldErrors\(fields\) : \{\};/);
  assert.match(save, /setWordErrors\(wordFieldErrors\);/);
  // The first listing takes the words of the fields, checked first, never the workflow's name or description.
  assert.ok(checked < save.indexOf("firstWorkflowListingOf(workflow.id, words, built.save)"));
  assert.equal(/workflow\.name|workflow\.description/.test(save), false);
});

test("once on sale it shows the buyer's page and model id by the LISTING's slug, never the workflow's own", () => {
  assert.match(SELL, /workflowPageAddress\(siteOrigin\(\), listing\.slug\)/);
  assert.match(SELL, /value=\{workflowModelId\(listing\.slug\)\}/);
  assert.match(SELL, /href=\{workflowPagePath\(listing\.slug\)\}/);
  assert.equal(/workflow\.slug|workflow\.openaiModel|workflow\.apiEndpoint/.test(SELL), false);
  // Stop selling asks first, with the number of people on a plan.
  assert.match(SELL, /description: workflowStopSellingSentence\(listing\),/);
  assert.match(SELL, /await marketplaceApi\.archiveListing\(listing\.id\);/);
});

test("a workflow that cannot be sold as it is says why and cannot be put on sale", () => {
  assert.match(SELL, /const notSellable = workflowSellProblem\(workflow, maxRunMinutes\);/);
  assert.match(SELL, /disabled=\{busy !== null \|\| notSellable !== null\}/);
  assert.equal(SELL.split("{notSellableNotice}").length, 3, "said in both shapes of the card");
});

test("the Sell part writes no sentence of its own that the pure files hold, and never the word unlimited", () => {
  for (const word of ["Steps that ran before", "In a paid run your steps", "Paid runs appear", "per run lose access", "free trial"]) {
    assert.equal(SELL.toLowerCase().includes(word.toLowerCase()), false, word);
  }
  assert.equal(/unlimited/i.test(SELL), false);
});

// ============================================
// The run list, and changes refused while on sale
// ============================================

test("a run started by a buyer's payment is named in the run list", () => {
  assert.match(RUNS, /\[PAID_RUN_TRIGGER\]: PAID_RUN_LABEL,/);
  assert.match(RUNS, /TRIGGER_LABEL\[run\.triggeredBy\] \?\? run\.triggeredBy/);
});

test("disabling or deleting a workflow on sale shows the API's sentence and the way to its Sell part", () => {
  for (const [name, page] of [
    ["workflow page", WORKFLOW_PAGE],
    ["workflow list", WORKFLOW_LIST],
  ] as const) {
    assert.match(page, /const message = getErrorMessage\(error, fallback\);/, name);
    assert.match(page, /if \(refusedForSale\(codeOf\(error\)\)\) \{/, name);
    assert.match(page, /label: WORKFLOW_SELL_WORDS\.openSell/, name);
    assert.equal(page.match(/refused\((workflow, )?error, "Could not (change|delete) the workflow"\)/g)?.length, 2, name);
  }
  assert.match(WORKFLOW_PAGE, /onClick: \(\) => go\(\{ tab: "api", run: null \}\)/);
  assert.match(WORKFLOW_LIST, /const sell = `\/dashboard\/orchestrations\/\$\{workflow\.id\}\?tab=api`;/);
});

// ============================================
// The marketplace's cards and the listing page
// ============================================

test("a card says Workflow in place of a framework, and names no agent and no seller for a workflow", () => {
  const card = CARDS.slice(CARDS.indexOf("function AgentCard("), CARDS.indexOf("function CategorySidebar("));
  assert.match(card, /const parts = listingPageParts\(listing\);/);
  assert.match(card, /\{listingChipText\(listing\)\}/);
  assert.equal(card.includes("listing.agent?.framework"), false);
  assert.match(card, /\{parts\.publisher && <p className="text-sm text-muted-foreground">by \{listing\.publisherName\}<\/p>\}/);
  assert.match(card, /parts\.kind === "workflow" \? \(\s+<Workflow /);
  assert.match(card, /\{parts\.token && hasToken && \(/);
});

test("the listing page of a workflow has no Hire, Try it, tags, token, transparency, framework or publisher", () => {
  assert.match(LISTING, /const parts = listingPageParts\(listing\);/);
  assert.match(LISTING, /\{parts\.hire && \(\s+<button\s+onClick=\{\(\) => setActiveTab\("hire"\)\}/);
  assert.match(LISTING, /\{parts\.tryIt && listing\.trial\?\.enabled && \(/);
  assert.match(LISTING, /\{parts\.tags && listing\.agent\?\.tags/);
  assert.match(LISTING, /\{parts\.token && hasToken && \(\s+<button\s+onClick=\{\(\) => setActiveTab\("token"\)\}/g);
  assert.match(LISTING, /\{parts\.transparency && \(agentHandle \?\? listing\.agent\?\.slug\)/);
  assert.match(LISTING, /\{parts\.framework && \(/);
  assert.match(LISTING, /\{parts\.publisher && \(\s+<div className="rounded-lg border bg-card p-6">\s+<h3 className="font-semibold text-foreground">Publisher<\/h3>/);
  assert.match(LISTING, /description=\{parts\.reviewsEmpty\}/);
  // A #hire, #try or #token link to a workflow shows the overview, and each tab's content asks its part.
  assert.match(LISTING, /\{shownTab === "hire" && parts\.hire && \(/);
  assert.match(LISTING, /\{shownTab === "try" && parts\.tryIt && listing\.trial\?\.enabled && \(/);
  assert.match(LISTING, /\{shownTab === "token" && parts\.token && hasToken && tokenData && \(/);
  // Nothing of an agent is read for a workflow's listing.
  assert.match(LISTING, /if \(agentListing\) void loadOfferings\(listingRes\.listing\.id\);/);
  assert.match(LISTING, /if \(agentListing && listingRes\.listing\.pricingModel === "tokenized"\) \{/);
  // "Use it from code" goes where lib/api-page.ts sends a listing.
  assert.match(LISTING, /const apiPageHref = apiPageHrefOfListing\(listing\);/);
});

test("a workflow listing is drawn nowhere on its page with the words of an agent", () => {
  // From the moment the listing is known: before it, the page cannot know what it sells.
  const known = LISTING.slice(LISTING.indexOf("const parts = listingPageParts(listing);"));
  // The Hire tab is an agent's alone and is not drawn for a workflow.
  const hire = known.indexOf('{shownTab === "hire" && parts.hire && (');
  const drawn = code(known.slice(0, hire) + known.slice(known.indexOf('{shownTab === "try"')))
    // Reads of an agent's fields, gated by their parts, are not words on screen.
    .replace(/\blisting\.agent\b[?.\w]*/g, "")
    .replace(/\bagentHandle\b/g, "")
    .replace(/\bagentListing\b/g, "");
  const words = drawn.match(/[^\n]*\bagents?\b[^\n]*/gi) ?? [];
  assert.deepEqual(words, []);
});

test("before a listing is known its page says a listing, never an agent", () => {
  const skeleton = LISTING.slice(LISTING.indexOf("function ListingDetailSkeleton()"), LISTING.indexOf("export default function"));
  const unknown = LISTING.slice(LISTING.indexOf("if (isLoading) {"), LISTING.indexOf("const parts = listingPageParts(listing);"));
  assert.ok(skeleton.length > 0 && unknown.length > 0);
  for (const [name, part] of [
    ["the placeholder", skeleton],
    ["not found and a failed load", unknown],
  ] as const) {
    assert.deepEqual(code(part).match(/[^\n]*\bagents?\b[^\n]*/gi) ?? [], [], name);
  }
  assert.match(skeleton, /<span className="sr-only">Loading<\/span>/);
  assert.match(unknown, /title="Listing not found"\s+description="This listing does not exist or has been removed\."/);
  assert.match(unknown, /title="Couldn't load this listing"/);
});

// ============================================
// The creator's lists
// ============================================

test("My listings: a workflow's Edit goes to the workflow's API tab, and it has no Try it settings", () => {
  assert.match(MY_LISTINGS, /<Link href=\{ownListingEditHref\(listing\)\}>/);
  assert.equal(MY_LISTINGS.includes("/dashboard/marketplace/publish?edit="), false);
  assert.match(MY_LISTINGS, /\{parts\.tryIt && listing\.status === "published" && \(/);
  assert.match(MY_LISTINGS, /useState<OwnedMarketplaceListing\[\]>/);
});

test("the listing wizard opened on a workflow's listing goes to the workflow's API tab and loads no agent", () => {
  assert.match(WIZARD, /ownListings: listings,/);
  assert.match(WIZARD, /const workflowEdit = ownListing \? workflowEditHref\(ownListing\) : null;/);
  assert.match(WIZARD, /if \(workflowEdit\) router\.replace\(workflowEdit\);/);
  assert.match(WIZARD, /const editMissing = Boolean\(editId\) && data !== null && editing === null && workflowEdit === null;/);
  assert.match(WIZARD, /if \(editId && \(loadError !== null \|\| data === null \|\| editMissing \|\| workflowEdit !== null\)\) \{/);
  // The form is still filled from an agent's listings only.
  assert.match(WIZARD, /listings: listings\.filter\(isAgentListing\)/);
});

test("the token wizard offers only listings of an agent", () => {
  assert.match(TOKEN_WIZARD, /\.filter\(isAgentListing\)/);
});

// ============================================
// What a buyer uses
// ============================================

test("Installed draws every licence, a workflow's with its own icon and no seller, opened by the one rule", () => {
  assert.equal(INSTALLED.includes("isAgentLicence"), false);
  assert.match(INSTALLED, /setInstalls\(installs\);/);
  assert.match(INSTALLED, /const workflow = licenceProductKind\(install\) === "workflow";/);
  assert.match(INSTALLED, /\{workflow \? \(\s+<Workflow /);
  assert.match(INSTALLED, /\{!workflow && <>by \{install\.listing\.publisherName\} &middot; <\/>\}/);
  assert.match(INSTALLED, /description=\{INSTALLED_PAGE_WORDS\.header\}/);
  // Where a row opens is the pure file's: the page never builds an address of an agent or a workflow.
  assert.equal(/`\/a\/|`\/w\/|install\.agent/.test(INSTALLED), false);
});

test("the review dialog on Installed names a workflow as a workflow, and an agent as it did", () => {
  // The row's "Write Review" opens it for a workflow's licence too.
  assert.match(INSTALLED, /const reviewingSubject = reviewing \? licenceProductKind\(reviewing\) : "agent";/);
  assert.match(INSTALLED, /<ReviewForm\s+listingId=\{reviewingListingId\}\s+subject=\{reviewingSubject\}/);
  assert.match(REVIEW_FORM, /subject = "agent"/);
  assert.match(REVIEW_FORM, /placeholder=\{`Share details about your experience with this \$\{subject\}`\}/);
  assert.equal(code(REVIEW_FORM).includes("this agent"), false);
});

test("the usage page draws a workflow's icon and opens each row by the row's own address", () => {
  assert.match(USAGE, /const Icon = row\.productKind === "workflow" \? Workflow : Bot;/);
  assert.match(USAGE, /\{row\.href \? \(\s+<Link href=\{row\.href\}/);
  assert.equal(/`\/a\/|`\/w\//.test(USAGE), false);
});

test("the dialog at Stop draws the workflows' sentence after everything about agents", () => {
  const body = STOP.slice(STOP.indexOf("function StopWarningBody"), STOP.indexOf("export async function confirmStopDeployment"));
  assert.ok(body.indexOf("{warning.workflows}") > body.indexOf("{warning.onSale}"));
  assert.match(body, /\{warning\.workflows && <span className="mt-2 block break-words">\{warning\.workflows\}<\/span>\}/);
});
