/**
 * The docs of plans and of the API of a paid agent, held to the code they
 * describe. Run with:
 *   npx tsx --test src/lib/docs-plans.unit.test.ts
 *
 * The docs are words, and words drift: a header renamed in the API, a limit
 * changed, a call written one way on a listing's API page and another way in
 * the reference. Each test reads the page's source beside the one place the
 * fact lives.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { paidAgentChatSnippets, paidAgentRunSnippets } from "./public-urls";
import { plansFromLine } from "./listing-cta";
import { TRIAL_WORDS as SELL_TRIAL_WORDS, trialNote } from "./sell-plans";
import { planAfterLine, planPriceLine, planUsesLine, TRIAL_WORDS, trialOfferLine, trialTermsOf } from "./use-plans";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, "..", path), "utf8");
const apiSource = (path: string) => readFileSync(join(here, "..", "..", "..", "api", "src", path), "utf8");

const agents = source("app/docs/api/agents/page.tsx");
const market = source("app/docs/api/marketplace/page.tsx");
const guide = source("app/docs/guides/marketplace/page.tsx");

/** A snippet as it is typed inside a template literal of a page: each backslash doubled. */
const typed = (snippet: string) => snippet.split("\\").join("\\\\");

/** The part of the agents reference about an agent you pay for. */
const paidPart = agents.slice(agents.indexOf('<h2 id="paid-use">'), agents.indexOf('<h2 id="playground">'));

/** A page's words however its source wraps its lines: a line's end, and the space JSX writes at one, are a space. */
const flat = (page: string) => page.split('{" "}').join(" ").replace(/\s+/g, " ");

/** The part of the agents reference about a listing's free trial. */
const trialPart = flat(agents.slice(agents.indexOf('<h3 id="paid-trial">'), agents.indexOf('<Endpoint id="paid-chat"')));

test("every usage header the API sets is in the reference, and no other", () => {
  const names = [...new Set(apiSource("services/usageHeaders.ts").match(/"x-wheelsai-[a-z-]+"/g) ?? [])].map((name) =>
    name.slice(1, -1),
  );
  assert.equal(names.length, 8);
  for (const name of names) {
    assert.ok(paidPart.includes(`{ header: <code>${name}</code>`), `${name} has no row in the table of headers`);
  }
  const written = new Set(paidPart.match(/x-wheelsai-[a-z-]+/g) ?? []);
  assert.deepEqual([...written].sort(), [...names].sort());
  // They are for a server or a script: the reference promises them to no page on another website.
  assert.match(paidPart, /reads the same numbers\s+from <code>billing<\/code> in the body/);
});

test("the refusals of a plan are in the reference with the status the API answers", () => {
  const row = (status: number, code: string) =>
    new RegExp(`\\{ status: <code>${status}</code>, code: <code>${code}</code>`).test(paidPart);
  // A use.
  assert.ok(row(429, "plan_used_up"), "plan_used_up");
  assert.ok(row(402, "plan_ended"), "plan_ended");
  // A start and a move.
  for (const code of ["already_on_plan", "not_on_plan", "same_plan", "not_a_bigger_plan", "pricing_changed"]) {
    assert.ok(row(409, code), code);
  }
  assert.ok(row(400, "invalid_plan_move"));
  // The statuses are the code's.
  assert.match(apiSource("services/useAccess.ts"), /status: 402, code: "plan_ended"/);
  const paidUse = apiSource("services/paidUse.ts");
  assert.match(paidUse, /status: 429,\s+code: "plan_used_up"/);
  const startAndMove = apiSource("routes/marketplace.ts");
  assert.match(startAndMove, /status\(400\)\.send\(\{ error: "invalid_plan_move"/);
  // A refused move is one of the refusals that answer 409, however many stand beside it in that list.
  assert.match(startAndMove, /error instanceof PlanMoveError \|\|[\s\S]{0,400}?reply\.status\(409\)/);
});

test("in OpenAI's shape a used-up plan keeps its own code, and a folded code is told as reason", () => {
  const compat = apiSource("services/openaiCompat.ts");
  assert.match(compat, /plan_used_up: \{\s+status: 429,\s+type: "insufficient_quota",\s+retry: false,/);
  assert.match(compat, /plan_ended: "marketplace_payment_required"/);
  const v1 = paidPart.slice(paidPart.indexOf('id="paid-v1"'), paidPart.indexOf('<h3 id="paid-headers">'));
  assert.match(v1, /\{ status: <code>429<\/code>, code: <code>plan_used_up<\/code>/);
  assert.match(v1, /<code>insufficient_quota<\/code> and <code>x-should-retry: false<\/code>/);
  assert.match(v1, /<code>plan_ended<\/code> under\{" "\}\s+<code>marketplace_payment_required<\/code>/);
  assert.match(v1, /A code that is not folded has no <code>reason<\/code>/);
});

test("the limits are the API's: 10 a minute, 200 a day with no plan, the plan's count on a plan", () => {
  const limits = apiSource("services/publicPageState.ts");
  assert.match(limits, /PAID_USE_PER_BUYER_PER_MINUTE = 10\b/);
  assert.match(limits, /PAID_USE_PER_BUYER_PER_DAY = 200\b/);
  // A buyer on a plan is not asked the day's limit.
  // (The one use on a plan's row that is asked: a use past a free trial's count that is paid per use.)
  assert.match(apiSource("services/paidUse.ts"), /if \(billing\.kind !== "plan"[^\n]*\) \{\s+const dayLimit = await consume\(/);
  assert.match(paidPart, /\{ who: "Per use, with no plan", minute: "10 uses", day: "200 uses" \}/);
  assert.match(paidPart, /\{ who: "By the month", minute: "10 uses", day: "200 uses" \}/);
  assert.match(paidPart, /\{ who: "On a plan", minute: "10 uses", day: "No daily limit: the plan's count/);
  assert.match(guide, /up to 10 times a minute\. With no plan, and on a monthly subscription,\s+it can use it up to 200 times a day/);
  // The sentence from before plans, which held everybody to 200 a day, is gone.
  assert.doesNotMatch(agents, /Limits are 10 uses a minute and 200 a day/);
  assert.doesNotMatch(guide, /up to 10 times a minute and 200 times a day/);
});

test("the reference calls a paid agent as its API page does", () => {
  const chat = paidAgentChatSnippets({ baseUrl: "$WHEELSAI_API_URL", model: "a/support-bot" });
  assert.ok(agents.includes(typed(chat.curl)), "the curl of a chat is not the API page's");
  // The clients read the base address from the environment; the call is the same.
  for (const line of [
    'model: "a/support-bot",',
    'messages: [{ role: "user", content: "Hello!" }],',
    "console.log(reply.choices[0].message.content);",
    'model="a/support-bot",',
    'messages=[{"role": "user", "content": "Hello!"}],',
    "print(reply.choices[0].message.content)",
  ]) {
    assert.ok(chat.javascript.includes(line) || chat.python.includes(line), `the API page no longer writes: ${line}`);
    assert.ok(agents.includes(line), `the reference does not write: ${line}`);
  }
  const run = paidAgentRunSnippets({ baseUrl: "$WHEELSAI_API_URL", path: "/api/a/brief-writer/run" });
  assert.ok(agents.includes(typed(run.curl)), "the curl of a run is not the API page's");
});

test("a plan is written in the words of the agent's page", () => {
  const stops = { id: "p1", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: null };
  const extra = { ...stops, extraUsePriceCents: 5 };
  // However the page's source wraps its lines.
  const said = guide.replace(/\s+/g, " ");
  for (const words of [planPriceLine(stops), planUsesLine(stops), planAfterLine(stops), planAfterLine(extra)]) {
    assert.ok(said.includes(`&quot;${words}&quot;`), `the guide does not say "${words}"`);
  }
});

test("the numbers of a plan in the docs are the rules' numbers", () => {
  const rules = apiSource("services/listingPlans.ts");
  assert.match(rules, /MAX_PAID_PLANS = 4;/);
  assert.match(rules, /MAX_PLAN_NAME_CHARS = 40;/);
  assert.match(rules, /MIN_PLAN_PRICE_CENTS = 100n;/);
  assert.match(rules, /MIN_PLAN_CENTS_PER_INCLUDED_USE = 1n;/);
  assert.match(rules, /MAX_INCLUDED_USES = 100_000;/);
  assert.match(apiSource("services/useListing.ts"), /MIN_PRICE_PER_USE_CENTS = 5n;/);
  assert.match(market, /At most 4\./);
  assert.match(market, /description: "1 to 40 characters\."/);
  assert.match(market, /at least 100, and at least 1 cent for each included use, so \$9\.00 includes at most 900 uses/);
  assert.match(market, /description: "1 to 100,000\."/);
  assert.match(market, /costs, at least 5\./);
  assert.match(guide, /A listing can have up to four plans\./);
  assert.match(guide, /rule: "Up to 40 characters\."/);
  assert.match(guide, /rule: "From \$1\.00\."/);
  assert.match(guide, /rule: "An extra use costs from \$0\.05\."/);
});

test("the routes of plans and of usage are named as the API mounts them", () => {
  assert.match(market, /id="plans" method="PUT" path="\/api\/marketplace\/listings\/\{id\}\/plans"/);
  assert.match(apiSource("routes/listingPlans.ts"), /"\/listings\/:id\/plans"/);
  assert.match(market, /id="usage" method="GET" path="\/api\/billing\/marketplace-usage"/);
  assert.match(apiSource("routes/billingLedger.ts"), /"\/marketplace-usage"/);
  for (const code of ["plans_changed", "plans_not_available", "listing_not_found", "validation_failed"]) {
    assert.ok(market.includes(`error: <code>${code}</code>`), code);
  }
  // Ending a plan is said in the body, and the reference says so.
  assert.match(market, /\{ name: "ended", type: "uuid\[\]"/);
  // The pages people are sent to.
  assert.match(guide, /<code>\/dashboard\/usage<\/code>/);
  assert.match(agents, /<code>\/a\/&#123;handle&#125;\/api<\/code>/);
});

test("the warnings by email are told as they are sent: owners and admins with a verified address, once at 85% and at 100%", () => {
  const warnings = apiSource("services/planWarnings.ts");
  assert.match(warnings, /PLAN_WARNING_ROLES = \["owner", "admin"\] as const/);
  assert.match(warnings, /user: \{ emailVerified: true \}/);
  assert.match(apiSource("services/planUse.ts"), /PLAN_WARNING_PERCENT = 85\b/);
  for (const page of [guide, paidPart]) {
    assert.match(page, /85% of its uses/);
    assert.match(page, /owners and admins of your\s+organization who have a verified email address get one email/);
  }
});

test("a charge that was never answered is given back in the time the sweeper keeps", () => {
  assert.match(apiSource("services/runPendingUseSweepTick.ts"), /PENDING_USE_MAX_MS = 15 \* 60_000;/);
  assert.match(apiSource("services/buildPendingUseSweepTickDeps.ts"), /PENDING_COPY_MAX_MS = 75 \* 60_000;/);
  assert.match(paidPart, /given back within about 15 minutes/);
  assert.match(guide, /within about 15 minutes for a use of your agent, and within about 75 minutes for a request\s+of a buyer&apos;s own copy/);
});

test("a plan that is over is told as the access rule decides it, and each plan is shown only where it is", () => {
  // Per use after a plan only under a price per use the buyer agreed to themselves.
  assert.match(apiSource("services/useAccess.ts"), /return agreedPerUse \? "listing_pricing" : "plan_ended";/);
  assert.match(guide, /charged per use only if you agreed to the listing&apos;s price per use\s+yourself; otherwise the next use is refused/);
  assert.doesNotMatch(guide, /never moved to paying per use/);
  // The listing and its card say only the smallest plan price; the agent's page and its API page list each plan.
  assert.doesNotMatch(guide, /on its listing and on its API page/);
  assert.ok(guide.includes(`&quot;${plansFromLine(900)}&quot;`), "the line of the listing page");
});

test("a used-up plan's reset header and retry-after are told as the refusal sets them", () => {
  const paidUse = apiSource("services/paidUse.ts");
  // No time of a reset for a plan that will not renew, so no reset header either.
  assert.match(paidUse, /\.\.\.\(renews && \{ resetsAt: plan\.periodEnd\.toISOString\(\) \}\)/);
  assert.doesNotMatch(paidPart, /six plan headers/);
  assert.match(paidPart, /<code>x-wheelsai-plan-reset<\/code> only when the plan will renew/);
  // The seconds left of the period, or an hour while a renewal is retried.
  assert.match(paidUse, /retryAfterSeconds: left > 0 \? left : RENEWAL_RETRY_SECONDS,/);
  assert.match(paidUse, /RENEWAL_RETRY_SECONDS = 60 \* 60;/);
  assert.doesNotMatch(paidPart, /still says how many seconds are left until the count/);
  assert.match(paidPart, /being retried it says one hour/);
});

test("the pages of plans promise nothing the product does not do", () => {
  for (const [name, page] of [["agents", paidPart], ["marketplace", market], ["guide", guide]] as const) {
    assert.doesNotMatch(page, /unlimited/i, `${name}: no plan is unlimited`);
    assert.ok(!page.includes(String.fromCharCode(0x2014)), `${name}: an em dash`);
  }
  // The give-back is a sweep that runs after a wait, so no page calls it immediate or certain.
  assert.doesNotMatch(guide, /never left waiting/);
  // The three pages are plain ASCII, whole.
  for (const [name, page] of [["agents", agents], ["marketplace", market], ["guide", guide]] as const) {
    assert.ok(/^[\x00-\x7F]*$/.test(page), `${name}: a character outside ASCII is typed in the page`);
  }
  // What a buyer is never told is not in an example either.
  assert.doesNotMatch(paidPart, /"(?:tokens|inputTokens|outputTokens|orgId|publisherId|organization)":/);
});

// ============================================
// The free trial
// ============================================

test("the numbers of a free trial in the docs are the rules' numbers", () => {
  const rules = apiSource("services/listingPlans.ts");
  assert.match(rules, /MAX_TRIAL_USES = 50;/);
  assert.match(rules, /MIN_INCLUDED_USES = 1;/);
  assert.match(rules, /TRIAL_DAYS = 7;/);
  assert.match(rules, /TRIAL_PLAN_NAME = "Free trial";/);
  // The days a buyer is told are the rules' days, not a number of the reads' own.
  assert.match(apiSource("services/planOffers.ts"), /return \{ id: row\.id, includedUses: row\.includedUses, days: TRIAL_DAYS \};/);
  assert.match(trialPart, /description: "The uses it includes, 1 to 50\." \}/);
  assert.match(trialPart, /description: "How many days it lasts from its start: 7\." \}/);
  assert.match(trialPart, /a number of uses, for 7 days, at no price/);
  assert.match(market, /\{ name: "includedUses", type: "integer", required: true, description: "1 to 50\." \}/);
  assert.match(flat(market), /a number of uses a buyer&apos;s organization gets once, for 7 days, at no price/);
  assert.match(flat(market), /it is always called <code>Free trial<\/code>, and a <code>name<\/code> that is sent is not kept/);
  assert.match(flat(guide), /<strong>Uses in the trial<\/strong>: from 1 to 50\. A trial lasts 7 days\./);
  // The same two numbers are told to a client by the capabilities read, under the names the page gives.
  const capabilities = apiSource("routes/capabilities.ts");
  assert.match(capabilities, /maxTrialUses: MAX_TRIAL_USES,\s+trialDays: TRIAL_DAYS,/);
  assert.match(flat(paidPart), /<code>maxTrialUses<\/code>, the most uses one can include, and <code>trialDays<\/code>/);
});

test("a creator sets the free trial as the rules check it: no price, no extra price, one of them, beside the four", () => {
  const rules = apiSource("services/listingPlans.ts");
  assert.match(rules, /if \(plan\.priceCents !== 0n\) wrong\(at\("priceCents"\), PLAN_MESSAGES\.trialPrice\);/);
  assert.match(rules, /if \(\(plan\.extraUsePriceCents \?\? null\) !== null\) wrong\(at\("extraUsePriceCents"\), PLAN_MESSAGES\.trialExtra\);/);
  assert.match(rules, /if \(\+\+trials > 1\) wrong\(at\("kind"\), PLAN_MESSAGES\.trialTwice\);/);
  assert.match(rules, /plans\.filter\(\(plan\) => plan\.kind !== "trial"\)\.length > MAX_PAID_PLANS/);
  assert.match(rules, /activeKinds\.get\(plan\.id\) !== plan\.kind\) \{\s+wrong\(at\("kind"\), PLAN_MESSAGES\.kindChanged\);/);
  // The route takes a trial with no name, and wants the extra price said, as null.
  const route = apiSource("routes/listingPlans.ts");
  assert.match(route, /name: z\.string\(\)\.max\(200\)\.optional\(\),/);
  assert.match(route, /extraUsePriceCents: z\.number\(\)\.int\(\)\.min\(-100_000\)\.max\(100_000\)\.nullable\(\),/);
  const said = flat(market);
  assert.match(said, /\{ name: "kind", type: "string", required: true, description: <><code>trial<\/code>\.<\/> \}/);
  assert.match(said, /\{ name: "priceCents", type: "integer", required: true, description: "0\. A free trial has no price\." \}/);
  assert.match(said, /\{ name: "extraUsePriceCents", type: "null", required: true, description: <><code>null<\/code>, and it must be sent\./);
  assert.ok(market.includes('{ "kind": "trial", "priceCents": 0, "includedUses": 20, "extraUsePriceCents": null },'), "the entry of a trial in the example");
  assert.match(said, /and it is not one of the four/);
  assert.match(said, /two of them in one set, a price other than 0, a price for an extra use, uses outside 1 to 50/);
  assert.match(said, /a plan cannot be turned into a free trial, or a free trial into a plan/);
  // Ended by its id, and a trial on offer that is in neither list refuses the save, as a plan does.
  const store = apiSource("services/listingPlanStore.ts");
  assert.match(store, /const onOffer = \[\.\.\.paidOnOffer, \.\.\.trialOnOffer\];/);
  assert.match(store, /if \(onOffer\.some\(\(plan\) => !sent\.has\(plan\.id\) && !named\.has\(plan\.id\)\)\) \{\s+throw new PlansRefused\(CHANGED_SINCE_PAGE_LOADED\);/);
  assert.match(store, /code: "plans_changed",\s+message: PLAN_STORE_MESSAGES\.changedSincePageLoaded,/);
  assert.match(said, /a trial on offer that is in neither list refuses the whole save with <code>409<\/code> <code>plans_changed<\/code>/);
  // The creator's own read: the trial first, with its kind.
  assert.match(store, /orderBy: \{ position: "asc" \},/);
  assert.match(rules, /TRIAL_PLAN_POSITION = 0;/);
  assert.match(said, /carry the trial first among <code>plans<\/code>, with <code>kind<\/code> <code>trial<\/code>/);
});

test("the free trial is told beside the plans, under the names the reads use", () => {
  const shape = "<code>&#123; id, includedUses, days &#125;</code>";
  // The access answer: the four fields, in the API's words.
  const paidUse = apiSource("services/paidUse.ts");
  assert.match(
    paidUse,
    /trial,\s+trialAvailable,\s+trialNeedsCredits,\s+trialEnded: access === "plan_ended" && mine !== null && onTrialPlan\(sub\),/,
  );
  const access = flat(agents.slice(agents.indexOf('<Endpoint id="paid-access"'), agents.indexOf('<h3 id="paid-plans">')));
  for (const field of ["trial", "trialAvailable", "trialNeedsCredits", "trialEnded"]) {
    assert.ok(access.includes(`<code>${field}</code> is`), `the access answer does not explain ${field}`);
    assert.ok(access.includes(`"${field}": `), `the example of the access answer has no ${field}`);
  }
  assert.ok(access.includes(shape));
  // The sentences this stage corrects: a trial can be available.
  assert.doesNotMatch(flat(agents), /<code>trialAvailable<\/code> is always/);
  // The agent's public read.
  assert.match(apiSource("routes/publicAgent.ts"), /trial: trialOfferOf\(paid\.trial\),/);
  assert.match(flat(agents), /<code>use\.paid<\/code> also carries <code>plans<\/code>[^.]*and <code>trial<\/code>/);
  // One listing: `freeTrial`, because `trial` there is Try it.
  const listings = apiSource("services/marketplace.ts");
  assert.match(listings, /freeTrial: trialOfferOf\(offers\.trial\),/);
  assert.match(listings, /trial: \{ enabled: listing\.status === "published" \},/);
  const listing = flat(market.slice(market.indexOf('<Endpoint id="get-listing"'), market.indexOf('<h2 id="publish">')));
  assert.ok(listing.includes(`It also carries <code>freeTrial</code>`) && listing.includes(shape));
  assert.match(listing, /It is not <code>trial<\/code>, which every listing carries as <code>&#123; enabled &#125;<\/code>/);
  // Each page keeps the free trial and Try it apart, by name.
  for (const [name, page] of [["agents", trialPart], ["marketplace", listing], ["guide", flat(guide)]] as const) {
    assert.match(page, /not <Link href="\/docs\/guides\/web-chat-widget#try-it">Try it<\/Link>|whether <Link href="\/docs\/guides\/web-chat-widget#try-it">Try it<\/Link>/, name);
  }
  // A plan object says whether it is a trial, and a trial has one name.
  assert.match(paidUse, /name: trial \? TRIAL_PLAN_NAME : \(sub\.planName \?\? ""\),\s+trial,/);
  assert.match(paidPart, /\{ name: "trial", type: "boolean", description: <><code>true<\/code> on the listing&apos;s/);
});

test("who can start a free trial is told as the start judges it", () => {
  const start = apiSource("services/trialStart.ts");
  // Credits the organization paid for: one type of ledger row, written for a card, a wallet and a deposit.
  assert.match(start, /CREDITS_ADDED_LEDGER_TYPES = \["purchase"\] as const;/);
  assert.match(start, /a card\s+services\/stripe\/stripeWebhook\.ts\s+\*\s+a wallet payment\s+services\/walletTopup\.ts\s+\*\s+a deposit\s+services\/depositCredit\.ts/);
  assert.match(start, /type: \{ in: \[\.\.\.CREDITS_ADDED_LEDGER_TYPES\] \}, amountCents: \{ gt: 0n \}/);
  assert.match(trialPart, /Credits count when your organization paid for them, by card, from a wallet or by a deposit, however long ago and whatever is left of them/);
  assert.match(trialPart, /Credits given as a bonus, such as the ones for verifying an email address, and earnings taken as credits do not count/);
  assert.match(flat(guide), /by card, from a wallet or by a deposit: bonus credits do not count/);
  // The four facts, and "add credits" only when it is the one thing missing.
  assert.match(
    start,
    /if \(!facts\.offered\) return[^\n]+\n\s+if \(facts\.used\) return[^\n]+\n\s+if \(facts\.running\) return[^\n]+\n\s+if \(!facts\.addedCredits\) return/,
  );
  assert.match(trialPart, /the listing offers a trial now; your organization has never started one on this listing; no plan, paid month or trial of yours is running on it; and your organization has added credits at least once/);
  // Once, ever: the mark is never cleared, and a stop leaves no licence that a start could reuse as "never".
  assert.match(start, /return sub != null && sub\.trialUsedAt !== null;/);
  assert.match(trialPart, /once for each organization and listing, ever: not again after it ended, after you stopped using the agent, or after a paid plan/);
});

test("starting a free trial is written as the route takes it, with each refusal at the API's status", () => {
  // The body is the trial's own terms: what the web app sends for the same offer.
  const terms = trialTermsOf({ id: "T", includedUses: 20, days: 7 });
  assert.deepEqual(terms, { id: "T", priceCents: 0, includedUses: 20, extraUsePriceCents: null });
  const body = `-d '{ "plan": { "id": "'"$TRIAL_ID"'", "priceCents": 0, "includedUses": 20, "extraUsePriceCents": null } }'`;
  assert.ok(agents.includes(body), "the reference does not write the start of a trial");
  assert.ok(market.includes(body), "the marketplace reference does not write the start of a trial");
  // Held to the API: a trial is found by its kind and compared as a plan's terms are.
  const start = apiSource("services/trialStart.ts");
  assert.match(start, /plan\.kind === "trial" &&\s+samePlanTerms\(shown, plan\)/);
  assert.match(apiSource("services/planStart.ts"), /planNow\.kind === "trial"\) \{\s+return startListingTrial\(/);
  // The refusals and their codes.
  assert.match(start, /readonly code = "trial_already_used";/);
  assert.match(start, /readonly code = "trial_needs_credits";/);
  assert.match(apiSource("services/planMove.ts"), /on_trial: \{ code: "trial_cannot_move", message: PLAN_MOVE_MESSAGES\.onTrial \},/);
  const routes = apiSource("routes/marketplace.ts");
  assert.match(
    routes,
    /error instanceof PlanMoveError \|\|[\s\S]{0,200}?error instanceof TrialAlreadyUsedError \|\|\s+error instanceof TrialNeedsCreditsError\s+\) \{\s+return reply\.status\(409\)/,
  );
  // A trial that changed since it was shown: the trial on offer now comes with the refusal.
  assert.match(routes, /\.\.\.\(error\.trial !== undefined && \{ trial: error\.trial \}\),/);
  assert.match(routes, /return reply\.status\(201\)\.send\(state\);/);
  const row = (code: string) => new RegExp(`\\{ status: <code>409</code>, code: <code>${code}</code>`).test(trialPart);
  for (const code of ["trial_already_used", "trial_needs_credits", "already_on_plan", "pricing_changed", "trial_cannot_move"]) {
    assert.ok(row(code), `${code} has no row among the refusals of a trial start`);
  }
  assert.match(trialPart, /With <code>pricing<\/code>, the <code>plans<\/code> on offer now and <code>trial<\/code>, the trial on offer now or <code>null<\/code>/);
  const use = flat(market.slice(market.indexOf('<Endpoint id="use"'), market.indexOf('<Endpoint id="install"')));
  for (const code of ["trial_already_used", "trial_needs_credits", "already_on_plan", "pricing_changed", "trial_cannot_move"]) {
    assert.ok(use.includes(`<code>409</code> <code>${code}</code>`), `the start route does not list ${code}`);
  }
  // They belong to the start route alone: /v1 starts nothing and maps none of them.
  assert.doesNotMatch(apiSource("services/openaiCompat.ts"), /trial_already_used|trial_needs_credits|trial_cannot_move/);
  assert.match(trialPart, /They are not answered on <code>\/v1<\/code>, where nothing is started/);
});

test("a use on a free trial, and what follows its uses, are told as the metering decides them", () => {
  const paidUse = apiSource("services/paidUse.ts");
  const metering = apiSource("services/useMetering.ts");
  // It never renews, so no reset is told: not in the body, not as a header.
  assert.match(paidUse, /if \(onTrialPlan\(sub\)\) return false;/);
  assert.match(trialPart, /<code>x-wheelsai-plan-reset<\/code> is never sent for a trial/);
  assert.match(paidPart, /when: "On a plan that will renew\. Never on a free trial\." \}/);
  // Used up with no price agreed: the 429 of a plan, with no time at which anything starts again.
  assert.match(
    paidUse,
    /if \(trial\) \{\s+const uses = plan\.includedUses \+ plan\.carriedUses;\s+return \{\s+status: 429,\s+code: "plan_used_up",\s+message: PAID_USE_MESSAGES\.trialUsedUp\(uses\),\s+planCount: \{[^}]+\},\s+\};\s+\}/,
  );
  assert.match(trialPart, /the next use answers <code>429<\/code> <code>plan_used_up<\/code>/);
  assert.match(trialPart, /It carries no <code>resetsAt<\/code>, no <code>retryAfterSeconds<\/code> and no <code>retry-after<\/code> header/);
  // Past its uses only a buyer who agreed to a price per use themselves goes on, at the listing's price.
  assert.match(metering, /const agreedPerUse = licence\.status === "active" && licence\.acceptedPricingModel === "per_request";\s+if \(!agreedPerUse\) return planBilling\(sub, null\);/);
  assert.match(metering, /const perUse = resolveUseBilling\(\{ \.\.\.input, sub: null \}, now\);\s+if \(perUse\.kind === "billable"\) return planBilling\(sub, perUse\.install\);/);
  assert.match(metering, /return usedUp && perUse\.kind === "refused" && perUse\.reason === "pricing_changed" \? perUse : trial;/);
  assert.match(trialPart, /If you agreed to the listing&apos;s price per use yourself, each further use is charged that price from your credits/);
  assert.match(trialPart, /the use answers <code>409<\/code> <code>pricing_changed<\/code> and nothing is charged until you accept the new price/);
  // Such a use is held to the day as a use paid per use is; the free ones are not.
  assert.match(paidUse, /if \(billing\.kind !== "plan" \|\| \(onTrial && payable !== null\)\) \{\s+const dayLimit = await consume\(/);
  assert.match(trialPart, /These uses are held to the day&apos;s limit of a buyer who pays per use, 200 a day/);
  assert.match(paidPart, /\{ who: "On a free trial", minute: "10 uses", day: "No daily limit for its free uses: the trial's count takes its place\. A use past them, paid per use, counts toward 200 uses\." \}/);
  // No email for a trial.
  assert.match(paidUse, /if \(onTrial \|\| told\.plan\?\.trial === true\) return;/);
  assert.match(trialPart, /<li>No warning email is sent for a free trial\.<\/li>/);
  assert.match(flat(guide), /The warnings a plan sends at 85% and at 100% are not sent for a free trial/);
  // On /v1 the two refusals of a trial are the plan's, as the API's own table of that shape has them.
  const compat = apiSource("services/openaiCompat.ts");
  assert.match(compat, /plan_used_up: \{\s+status: 429,\s+type: "insufficient_quota",\s+retry: false,/);
  assert.match(compat, /plan_ended: "marketplace_payment_required",/);
  assert.doesNotMatch(compat, /trial_already_used|trial_needs_credits|trial_cannot_move/);
  assert.match(trialPart, /On <code>\/v1<\/code> it is <code>plan_used_up<\/code> too/);
  assert.match(trialPart, /<code>marketplace_payment_required<\/code> with <code>reason<\/code> <code>plan_ended<\/code>/);
});

test("how a free trial ends, and what a buyer agreed to beside it, are told as the access rule decides", () => {
  const access = apiSource("services/useAccess.ts");
  // Over, on a listing still sold per use: per use only under a price the buyer agreed to that still covers it.
  assert.match(access, /licence\.accepted\.pricingModel === "per_request" &&\s+acceptedPricingCovers\(listing, licence\.accepted\);\s+return agreedPerUse \? "listing_pricing" : "plan_ended";/);
  assert.match(trialPart, /If you agreed to the listing&apos;s price per use and it has not gone up since, you go on paying per use and <code>access<\/code> is <code>listing_pricing<\/code>/);
  assert.match(trialPart, /Otherwise <code>access<\/code> is <code>plan_ended<\/code> with <code>trialEnded<\/code> <code>true<\/code>/);
  // Stopped by the buyer: no licence, so not "ended", and the mark of a trial used stays.
  assert.match(access, /if \(licence\.status !== "active" && licence\.status !== "suspended"\) return "none";/);
  assert.match(trialPart, /the trial is over at once, <code>access<\/code> is <code>none<\/code>, and it cannot be started again/);
  // Agreeing to pay per use beside a trial or a plan is written at once: 201 when it wrote, 200 when it did not.
  const listings = apiSource("services/marketplace.ts");
  assert.match(listings, /const agreesBesidePlan = \(besidePlan && !agreedPerUse\) \|\| acceptsNewPriceBesidePlan;/);
  assert.match(listings, /besidePlan &&\s+agreedPerUse &&\s+opts\.acceptNewPricing === true &&/);
  assert.match(listings, /created: written\.count === 1 \};/);
  assert.match(apiSource("routes/marketplace.ts"), /return reply\.status\(created \? 201 : 200\)\.send\(state\);/);
  for (const page of [trialPart, flat(market)]) {
    assert.match(page, /answers <code>201<\/code>/);
    assert.match(page, /without it the request answers <code>200<\/code> and nothing is written/);
    assert.match(page, /<code>acceptNewPricing: true<\/code>/);
  }
  // A paid plan over a running trial is an ordinary start; a move from a trial is refused.
  assert.match(apiSource("services/planStart.ts"), /if \(access === "subscribed" && !onTrialPlan\(existingSub\)\) throw new AlreadyOnPlanError\(\);/);
  assert.match(apiSource("services/marketplaceSubscriptions.ts"), /if \(onTrialPlan\(current\)\) return \{ ok: false, refusal: "on_trial" \};/);
  assert.match(trialPart, /A paid plan can be started while a trial runs, by the ordinary start of a plan/);
  assert.match(trialPart, /nothing of the trial is carried into it/);
  // A trial has no renewal to resume.
  assert.match(listings, /\.\.\.\(cancel \? \{\} : \{ OR: \[\{ includedUses: null \}, \{ priceCents: \{ gt: 0n \} \}\] \}\),/);
  assert.match(flat(market), /cancelling its renewal changes nothing, and resuming it answers <code>404<\/code>/);
});

test("the usage read and my-installs say an ended trial, and what a use costs after the free ones, as the API does", () => {
  const usage = apiSource("services/buyerUsage.ts");
  assert.match(usage, /const trialEnded = access === "plan_ended" && sub !== null && onTrialPlan\(sub\);/);
  assert.match(usage, /const perUseAfterTrial = held && onTrialPlan\(held\) \? perUseAfterTrialOf\(licence, now\) : null;/);
  assert.match(usage, /export interface PerUseAfterTrial \{[^}]*priceCents: number;\s+unit: "message" \| "run";\s+\}/);
  // The listing's own price, never the agreed one.
  assert.match(usage, /const price = listing\.pricePerRequestCents;/);
  const read = flat(market.slice(market.indexOf('<Endpoint id="usage"'), market.indexOf('<Endpoint id="reviews"')));
  assert.ok(read.includes('"trialEnded": false,') && read.includes('"perUseAfterTrial": null,'), "the example of the usage read");
  assert.match(read, /<code>trialEnded<\/code> is always present/);
  assert.match(read, /their <code>access<\/code> is <code>listing_pricing<\/code>/);
  assert.match(read, /<code>perUseAfterTrial<\/code> is always present, as <code>&#123; priceCents, unit &#125;<\/code> or <code>null<\/code>; <code>unit<\/code> is <code>message<\/code> or <code>run<\/code>/);
  assert.match(read, /<code>priceCents<\/code> is the listing&apos;s price per use now, never the price you agreed to/);
  assert.match(read, /It says what a use is charged, not that the agent answers/);
  // my-installs: right after `access`, never for a copy; install-status has no such field.
  const listings = apiSource("services/marketplace.ts");
  assert.match(listings, /access,\s+(?:\/\/[^\n]*\s+)*trialEnded: kind === "use" && access === "plan_ended" && sub != null && onTrialPlan\(sub\),/);
  const status = listings.slice(listings.indexOf("export async function checkInstallStatus"));
  assert.doesNotMatch(status.slice(0, status.indexOf("\nexport ", 10)), /trialEnded/);
  const installs = flat(market.slice(market.indexOf('<Endpoint id="install"'), market.indexOf('<Endpoint id="uninstall"')));
  assert.match(installs, /<code>trialEnded<\/code>, a boolean right after <code>access<\/code>/);
  assert.match(installs, /It is always <code>false<\/code> for a copy/);
  assert.match(installs, /<code>install-status<\/code> carries no <code>trialEnded<\/code>/);
});

test("the guide says a free trial in the words of the Sell tab and of the agent's page", () => {
  const said = flat(guide);
  // The creator's switch and box, and the note under them.
  assert.ok(said.includes(`<strong>${SELL_TRIAL_WORDS.offer}</strong>`), "the switch");
  assert.ok(said.includes(`<strong>${SELL_TRIAL_WORDS.uses}</strong>`), "the box");
  assert.ok(said.includes(trialNote()), "the note of the Sell tab");
  assert.ok(said.includes(`<strong>${SELL_TRIAL_WORDS.name}</strong>`), "its name");
  // What a buyer reads on the agent's page.
  const offer = trialOfferLine({ id: "T", includedUses: 20, days: 7 });
  assert.equal(said.split(`&quot;${offer}&quot;`).length, 3, "the offer, once for a creator and once for a buyer");
  assert.ok(said.includes(`<strong>${TRIAL_WORDS.startButton}</strong>`), "the button");
  // The creator is not paid for the free uses, and nothing is written for them.
  assert.match(apiSource("services/marketplaceSubscriptions.ts"), /NOTHING is charged and no money row is written:\s+\* no revenue, no credit transaction, no earnings\./);
});

test("a free trial's refusals, reads and headers are told where the code decides them, not one step off", () => {
  // A trial that was started before is said first, so a start while a trial (or a plan after one) runs is
  // trial_already_used, never already_on_plan.
  assert.match(
    apiSource("services/trialStart.ts"),
    /if \(facts\.used\) return \{ available: false, reason: "trial_already_used" \};\s+if \(facts\.running\) return \{ available: false, reason: "already_on_plan" \};/,
  );
  assert.match(trialPart, /code: <code>trial_already_used<\/code>, when: "[^"]*whether it ended, was stopped or is still running/);
  assert.match(trialPart, /code: <code>already_on_plan<\/code>, when: "A plan or a paid month is running for this agent, and your organization never started this trial\."/);
  assert.doesNotMatch(trialPart, /or the trial itself is running/);

  // Only a read by slug carries the plans and the free trial: a read by id is formatted with nothing beside it.
  const listings = apiSource("services/marketplace.ts");
  const byId = listings.slice(listings.indexOf("export async function getListingById"));
  assert.match(byId.slice(0, byId.indexOf("\nexport ", 10)), /return listing \? formatListingForPublic\(listing\) : null;/);
  const listing = flat(market.slice(market.indexOf('<Endpoint id="get-listing"'), market.indexOf('<h2 id="publish">')));
  assert.match(listing, /A listing read by its slug also carries <code>plans<\/code>/);
  assert.match(listing, /A listing read by its id carries neither <code>plans<\/code> nor <code>freeTrial<\/code>/);

  // A trial whose days are over is closed with the reason a plan its creator ended has.
  assert.match(
    apiSource("services/marketplaceSubscriptions.ts"),
    /if \(plan && onTrialPlan\(sub\)\) \{[\s\S]{0,400}?data: \{ status: "cancelled", cancelledAt: now, endReason: "plan_ended" \},/,
  );
  const installs = flat(market.slice(market.indexOf('<Endpoint id="install"'), market.indexOf('<Endpoint id="uninstall"')));
  assert.match(installs, /<code>plan_ended<\/code> when its creator ended the plan or when a free trial reached the end of its 7 days \(<code>trialEnded<\/code> on the install tells the two apart\)/);

  // The headers of a count are set from the plan object whatever its kind, the warning among them.
  const headers = apiSource("services/usageHeaders.ts");
  assert.match(headers, /put\(headers, PLAN_WARNING_HEADER, WARNING_LEVELS\.includes\(plan\.warning\) \? String\(plan\.warning\) : null\);/);
  assert.doesNotMatch(headers, /trial/i);
  const headerPart = flat(agents.slice(agents.indexOf('<h3 id="paid-headers">'), agents.indexOf('<h3 id="paid-limits">')));
  assert.match(headerPart, /A free trial sends the same headers as a plan, <code>x-wheelsai-plan-warning<\/code> included, with the uses of its 7 days in place of the 30 days\. It never sends <code>x-wheelsai-plan-reset<\/code>\./);
  assert.match(paidPart, /description: "The uses of the 30 days, as you agreed to them\. On a free trial: the uses of its 7 days\." \}/);

  // The guide: a use on a trial takes one of its uses and never money, so nobody is charged and nobody is
  // paid for it. What it costs to run is carried by whoever pays for the agent's model.
  assert.match(apiSource("services/useMeteringProduction.ts"), /if \(install\) throw new Error\("a paid use was given both a price and a plan"\);\s+return beginPlanUse\(args\.plan\);/);
  assert.match(apiSource("services/listingPlans.ts"), /Nobody is charged for them, so what\s+\* they cost to run is carried by whoever pays for the agent's model\./);
  const said = flat(guide);
  assert.match(said, /Nothing is charged, and you are not paid for these uses\. Your agent answers them as it answers any use: on your own model key or a model you run yourself, each answer costs you what any answer costs there\. A trial includes at most 50 uses\./);
  assert.match(apiSource("services/useMetering.ts"), /return usedUp && perUse\.kind === "refused" && perUse\.reason === "pricing_changed" \? perUse : trial;/);
  assert.equal(said.split("before or during the trial").length, 4, "said to the creator once and to the buyer twice");
  assert.equal(said.split("If the creator raised the price since, you are asked to accept the new price first.").length, 3);
});
