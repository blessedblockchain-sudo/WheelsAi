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
import { planAfterLine, planPriceLine, planUsesLine } from "./use-plans";

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
  assert.match(startAndMove, /error instanceof PlanMoveError \|\|[\s\S]{0,120}reply\.status\(409\)/);
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
  assert.match(apiSource("services/paidUse.ts"), /if \(billing\.kind !== "plan"\) \{\s+const dayLimit = await consume\(/);
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
