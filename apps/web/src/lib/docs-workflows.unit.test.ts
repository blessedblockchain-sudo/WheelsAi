/**
 * The docs of a workflow on sale, held to the code they describe. Run with:
 *   npx tsx --test src/lib/docs-workflows.unit.test.ts
 *
 * Each test reads a page's source beside the one place the fact lives: the
 * API's own line for a route, a status, a number or a sentence, and the web
 * app's own words for what a screen says. Never a copy of the page itself.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PLATFORM_FEE_PERCENT, splitCents } from "@wheelsai/shared/revenue";

import { LISTING_WORKFLOW_WORDS } from "./listing-cta";
import { PAID_WORKFLOW_MESSAGES, runTimeNote } from "./paid-use";
import { paidAgentChatSnippets, paidAgentRunSnippets } from "./public-urls";
import { DEFAULT_SELL_LIMITS, sellChoices, sellWordsOf } from "./sell-choice";
import { payAsYouGoLine } from "./use-plans";
import { PAID_RUN_LABEL, WORKFLOW_LISTING_WORDS, workflowSellLines } from "./workflow-sell";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, "..", path), "utf8");
const apiSource = (path: string) => readFileSync(join(here, "..", "..", "..", "api", "src", path), "utf8");

const workflows = source("app/docs/api/workflows/page.tsx");
const market = source("app/docs/api/marketplace/page.tsx");
const guide = source("app/docs/guides/marketplace/page.tsx");
const deployments = source("app/docs/api/deployments/page.tsx");
const inference = source("app/docs/api/inference/page.tsx");

/** A page's words however its source wraps its lines, with the entities JSX needs read as the characters they stand for. */
const said = (page: string) =>
  page
    .split('{" "}')
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

/** The same words with every tag taken out: what a reader reads. */
const text = (page: string) => said(page).replace(/<[^>]*>/g, "");

/** A snippet as it is typed inside a template literal of a page: each backslash doubled. */
const typed = (snippet: string) => snippet.split("\\").join("\\\\");

/** The parts of the workflows reference about selling a workflow and using one you pay for. */
const sellPart = workflows.slice(workflows.indexOf('<h2 id="sell">'), workflows.indexOf('<h2 id="use-paid">'));
const usePart = workflows.slice(workflows.indexOf('<h2 id="use-paid">'), workflows.indexOf('<h2 id="scheduler">'));
const errorsPart = workflows.slice(workflows.indexOf('<h3 id="w-errors">'), workflows.indexOf('<h2 id="scheduler">'));

/** One string of the API's own sentences by its key, as the source writes it on one or two lines. */
function sentenceOf(file: string, key: string): string {
  const found = new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(apiSource(file));
  assert.ok(found, `${file} has no sentence ${key}`);
  return found[1]!;
}

/** The first number a pattern of the API's source captures. */
function numberIn(file: string, pattern: RegExp): number {
  const found = pattern.exec(apiSource(file));
  assert.ok(found, `${file} does not match ${pattern}`);
  return Number(found[1]!.replace(/_/g, ""));
}

// ============================================
// The table of refusals
// ============================================

interface Row {
  status: number;
  code: string;
  v1Status: number;
  v1Code: string;
}

/** The rows of the reference's table of refusals of a workflow you pay for. */
function docRows(): Row[] {
  const rows: Row[] = [];
  const pattern =
    /\{ status: <code>(\d+)<\/code>, code: <code>(\w+)<\/code>, v1: <><code>(\d+)<\/code> <code>(\w+)<\/code><\/>/g;
  for (const match of errorsPart.matchAll(pattern)) {
    rows.push({ status: Number(match[1]), code: match[2]!, v1Status: Number(match[3]), v1Code: match[4]! });
  }
  return rows;
}

const rowOf = (code: string): Row => {
  const row = docRows().find((candidate) => candidate.code === code);
  assert.ok(row, `the reference has no row for ${code}`);
  return row;
};

/** The codes a refusal of a paid use, or of a paid run of a workflow, can carry: the API's one list. */
function refusalCodes(): Set<string> {
  const paidUse = apiSource("services/paidUse.ts");
  const list = paidUse.slice(paidUse.indexOf("export const PAID_USE_REFUSAL_CODES = ["), paidUse.indexOf("] as const;"));
  return new Set([...list.matchAll(/"(\w+)"/g)].map((match) => match[1]!));
}

/** What /v1 calls a paid refusal, from the API's own map. */
function openAiCodeOf(code: string): string {
  const compat = apiSource("services/openaiCompat.ts");
  const map = compat.slice(compat.indexOf("const PAID_USE_ERROR_CODES"), compat.indexOf("export function paidUseOpenAiError"));
  const found = new RegExp(`\\n\\s+${code}: "(\\w+)",`).exec(map);
  assert.ok(found, `/v1 maps no ${code}`);
  return found[1]!;
}

/** The status of one of /v1's own rows. */
function openAiStatusOf(code: string): number {
  const compat = apiSource("services/openaiCompat.ts");
  const found = new RegExp(`\\n  ${code}: (?:invalid|server)\\((\\d+)|\\n  ${code}: \\{\\s+status: (\\d+)`).exec(compat);
  assert.ok(found, `/v1 has no row ${code}`);
  return Number(found[1] ?? found[2]);
}

test("every refusal a paid run of a workflow can give has a row, at the status the API answers", () => {
  const paidWorkflow = apiSource("services/paidWorkflow.ts");
  const codes = refusalCodes();
  // The codes the run itself writes, and the codes the shared steps it calls write for it.
  const written = new Set([...paidWorkflow.matchAll(/code: "(\w+)"/g)].map((match) => match[1]!).filter((code) => codes.has(code)));
  const useAccess = apiSource("services/useAccess.ts");
  const decisions = useAccess.slice(useAccess.indexOf("runs: false"));
  for (const match of decisions.matchAll(/code: "(\w+)"/g)) written.add(match[1]!);
  for (const code of ["not_for_sale", "rate_limited", "plan_used_up", "client_closed_request", "run_failed", "api_key_use_price_cap_exceeded", "api_key_daily_cap_exceeded"]) {
    written.add(code);
  }
  const rows = new Set(docRows().map((row) => row.code));
  assert.equal(docRows().length, rows.size, "one row for each code");
  assert.ok(written.size >= 20 && rows.size >= 27, "the table and the codes were read");
  for (const code of written) assert.ok(rows.has(code), `the reference has no row for ${code}`);
  // And no row for a code the API does not have, but the scope's own.
  for (const code of rows) assert.ok(codes.has(code) || code === "missing_scope", `${code} is not a code of the API`);

  // Each status, read where the refusal is built.
  const statusAt: Array<[string, string, RegExp]> = [
    ["workflow_not_found", "services/paidWorkflow.ts", /status: (\d+), code: "workflow_not_found"/],
    ["not_a_member", "services/paidWorkflow.ts", /status: (\d+), code: "not_a_member"/],
    ["own_workflow", "services/paidWorkflow.ts", /status: (\d+), code: "own_workflow"/],
    ["workflow_unavailable", "services/paidWorkflow.ts", /status: (\d+), code: "workflow_unavailable"/],
    ["workflow_busy", "services/paidWorkflow.ts", /status: (\d+),\s+code: "workflow_busy"/],
    ["run_timed_out", "services/paidWorkflow.ts", /status: (\d+), code: "run_timed_out"/],
    ["input_too_large", "services/paidWorkflow.ts", /status: (\d+), code: "input_too_large"/],
    ["input_invalid", "services/paidWorkflow.ts", /status: (\d+),\s+code: "input_invalid"/],
    ["invalid_request", "services/paidWorkflow.ts", /status: (\d+), code: "invalid_request"/],
    ["too_many_refunds", "services/paidWorkflow.ts", /status: (\d+),\s+code: "too_many_refunds"/],
    ["insufficient_credits", "services/paidWorkflow.ts", /status: (\d+),\s+code: "insufficient_credits"/],
    ["answer_withheld", "services/paidWorkflow.ts", /status: (\d+),\s+code: "answer_withheld"/],
    ["api_key_spend_caps_missing", "services/paidWorkflow.ts", /return refused\(\{ status: (\d+), code: peek\.code as PaidUseErrorCode/],
    ["api_key_use_price_cap_exceeded", "services/paidWorkflow.ts", /return refused\(\{ status: (\d+), code: peek\.code as PaidUseErrorCode/],
    ["api_key_daily_cap_exceeded", "services/paidWorkflow.ts", /return refused\(\{ status: (\d+), code: peek\.code as PaidUseErrorCode/],
    ["run_failed", "services/paidUse.ts", /if \(workflow\) return \{ status: (\d+), code: "run_failed"/],
    ["rate_limited", "services/paidUse.ts", /status: (\d+),\s+code: "rate_limited",\s+message: rule === "day"/],
    ["rate_limiter_unavailable", "services/paidUse.ts", /status: (\d+),\s+code: "rate_limiter_unavailable"/],
    ["plan_used_up", "services/paidUse.ts", /status: (\d+),\s+code: "plan_used_up",\s+message: renews/],
    ["client_closed_request", "services/paidUse.ts", /status: (\d+),\s+code: "client_closed_request"/],
    ["use_not_started", "services/useAccess.ts", /status: (\d+), code: "use_not_started"/],
    ["pricing_changed", "services/useAccess.ts", /status: (\d+), code: "pricing_changed"/],
    ["subscription_lapsed", "services/useAccess.ts", /status: (\d+), code: "subscription_lapsed"/],
    ["plan_ended", "services/useAccess.ts", /status: (\d+), code: "plan_ended"/],
    ["not_offered", "services/useAccess.ts", /status: (\d+), code: "not_offered"/],
    ["not_for_sale", "services/useMetering.ts", /status: reason === "not_for_sale" \? (\d+)/],
    ["missing_scope", "middleware/auth.ts", /reply\.status\((\d+)\)\.send\(\{\s+error: "missing_scope"/],
  ];
  for (const [code, file, pattern] of statusAt) {
    assert.equal(rowOf(code).status, numberIn(file, pattern), `${code}: the status of ${file}`);
  }
  // A body the parser will not take is the same refusal, at the same status.
  assert.match(apiSource("routes/paidWorkflow.ts"), /reply\.status\(413\)\.send\(\{ error: "input_too_large"/);
});

test("on /v1 each refusal is the code and the status of the row the API maps it to", () => {
  for (const row of docRows()) {
    if (row.code === "missing_scope") {
      // The /v1 branch of a paid workflow asks the scope itself, with OpenAI's code for it.
      assert.match(
        apiSource("routes/openaiV1.ts"),
        /target\.kind === "paid_workflow"\) \{[\s\S]{0,200}?principalHasScope\(request\.auth!, AGENTS_USE_SCOPE\)\) \{\s+return replyOpenAiError\(reply, "insufficient_scope"/,
      );
      assert.equal(row.v1Code, "insufficient_scope");
    } else {
      assert.equal(row.v1Code, openAiCodeOf(row.code), `${row.code} on /v1`);
    }
    assert.equal(row.v1Status, openAiStatusOf(row.v1Code), `${row.code}: the status of /v1's row ${row.v1Code}`);
  }
  // The six codes of a paid workflow answer the same status on both addresses.
  for (const code of ["workflow_not_found", "own_workflow", "workflow_unavailable", "workflow_busy", "run_failed", "run_timed_out"]) {
    const row = rowOf(code);
    assert.equal(row.v1Status, row.status, code);
  }
  // Only the busy found after a charge asks a client not to send it again by itself.
  const paidWorkflow = apiSource("services/paidWorkflow.ts");
  assert.match(paidWorkflow, /function busyAfterCharge[\s\S]{0,400}?noAutomaticRetry: true,/);
  assert.match(apiSource("services/openaiCompat.ts"), /if \(refusal\.noAutomaticRetry === true\) error\.headers\["x-should-retry"\] = "false";/);
  assert.match(text(errorsPart), /When this is found after the charge, the charge was refunded or the use given back, and \/v1 adds x-should-retry: false\./);
});

test("the API page's list of refusals is in the reference at its own statuses, and the reference never calls it complete", () => {
  const page = apiSource("services/workflowPublicPage.ts");
  const runList = page.slice(page.indexOf("const RUN_REFUSALS: AgentApiRefusal[] = ["), page.indexOf("/** The same refusal on /v1"));
  const agentPage = apiSource("services/agentApiPage.ts");
  const listed = new Map<string, number>();
  for (const match of runList.matchAll(/code: "(\w+)",\s*status: (\d+)/g)) listed.set(match[1]!, Number(match[2]));
  for (const match of runList.matchAll(/sharedRefusal\("(\w+)"\)/g)) {
    listed.set(match[1]!, numberIn("services/agentApiPage.ts", new RegExp(`code: "${match[1]}",\\s*status: (\\d+)`)));
    assert.ok(agentPage.includes(`code: "${match[1]}"`));
  }
  assert.ok(listed.size >= 15, "the API page lists its refusals");
  for (const [code, status] of listed) assert.equal(rowOf(code).status, status, `${code} on the API page`);
  // What the page leaves out is in the reference, and the page does leave it out.
  const leftOut = [
    "not_offered",
    "missing_scope",
    "not_a_member",
    "too_many_refunds",
    "rate_limiter_unavailable",
    "invalid_request",
    "workflow_not_found",
    "client_closed_request",
    "not_for_sale",
  ];
  for (const code of leftOut) {
    assert.equal(listed.has(code), false, `the API page now lists ${code}`);
    rowOf(code);
  }
  assert.match(text(usePart), /That list is the one the page explains; the full list is below\./);
  assert.doesNotMatch(text(usePart), /every refusal|all the refusals|complete list/i);
});

// ============================================
// The addresses and the calls
// ============================================

test("the addresses are the ones the API mounts, and a run is called as its API page calls it", () => {
  const routes = apiSource("routes/paidWorkflow.ts");
  for (const path of ['"/w/:slug"', '"/w/:slug/api"', '"/w/:slug/access"', '"/w/:slug/run"']) assert.ok(routes.includes(path), path);
  assert.match(apiSource("index.ts"), /app\.register\(createPaidWorkflowRoutesProduction\(\), \{ prefix: "\/api" \}\)/);
  assert.match(workflows, /id="w-page" method="GET" path="\/api\/w\/\{slug\}" auth="Public"/);
  assert.match(workflows, /id="w-access" method="GET" path="\/api\/w\/\{slug\}\/access" auth="API key or session"/);
  assert.match(workflows, /id="w-run" method="POST" path="\/api\/w\/\{slug\}\/run" auth="Session, or an API key with agents:use"/);
  // To run: the scope a key pays for an agent with. To read where you stand: none.
  assert.match(routes, /"\/w\/:slug\/access",\s+\{ preHandler: \[auth\],/);
  assert.match(routes, /"\/w\/:slug\/run",\s+\{\s+preHandler: \[auth, use\],/);
  assert.match(apiSource("routes/paidUseBindings.ts"), /use: requireScope\(AGENTS_USE_SCOPE\)/);
  assert.match(apiSource("routes/paidCompletions.ts"), /AGENTS_USE_SCOPE = "agents:use"/);
  // The body is the input and nothing else.
  assert.match(apiSource("services/paidWorkflow.ts"), /const runBodySchema = z\.object\(\{ input: z\.record\(z\.unknown\(\)\) \}\)\.strict\(\);/);
  assert.match(text(usePart), /any other field, stream among them, answers 400 invalid_request/);

  const run = paidAgentRunSnippets({ baseUrl: "$WHEELSAI_API_URL", path: "/api/w/weekly-release-notes/run", subject: "workflow" });
  assert.ok(workflows.includes(typed(run.curl)), "the curl of a run is not the API page's");
  const chat = paidAgentChatSnippets({ baseUrl: "$WHEELSAI_API_URL", model: "w/weekly-release-notes" });
  assert.ok(workflows.includes(typed(chat.curl)), "the curl of /v1 is not the API page's");
  // The model is w/ and the listing's slug.
  assert.match(apiSource("routes/paidWorkflowCompletions.ts"), /PAID_WORKFLOW_MODEL_PREFIX = "w\/";/);
  assert.match(apiSource("routes/openaiV1.ts"), /if \(model\.startsWith\(PAID_WORKFLOW_MODEL_PREFIX\)\) \{/);
});

test("the answers are told under the names the API sends", () => {
  // The page anyone reads: each field the API builds is in the example, and no other.
  const page = apiSource("services/workflowPublicPage.ts");
  const read = page.slice(page.indexOf("export function workflowPublicReadOf"), page.indexOf("// GET /api/w/:slug/api"));
  const fields = [...read.matchAll(/\n\s+(\w+):/g)].map((match) => match[1]!);
  for (const field of ["kind", "listingId", "slug", "title", "description", "pricingModel", "unit", "priceCents", "plans", "trial", "keepsCopy", "maxRunMinutes", "input", "schema", "maxInputBytes", "maxPromptChars"]) {
    assert.ok(fields.includes(field), `the API no longer sends ${field}`);
    assert.ok(usePart.includes(`"${field}":`), `the example of the page has no ${field}`);
  }
  // A form with no fields is one text field, prompt, of the longest prompt a run takes.
  assert.match(page, /properties: \{ prompt: \{ type: "string", minLength: 1, maxLength: MAX_WORKFLOW_PROMPT_CHARS \} \},\s+required: \["prompt"\],/);
  assert.ok(usePart.includes('"properties": { "prompt": { "type": "string", "minLength": 1, "maxLength": 20000 } },'));
  assert.match(apiSource("routes/paidWorkflow.ts"), /return reply\.status\(404\)\.send\(\{ error: "workflow_not_found" \}\);/);

  // The access read: the agent's fields, with no trial and no pause, and own_workflow for the owner.
  const access = apiSource("services/paidWorkflow.ts");
  assert.match(access, /trial: null,\s+trialAvailable: false,\s+trialNeedsCredits: false,\s+trialEnded: false,/);
  assert.match(access, /startBlocked: null,[\s\S]{0,80}?paused: false,/);
  assert.match(access, /\? "own_workflow"/);
  const accessPart = usePart.slice(usePart.indexOf('id="w-access"'), usePart.indexOf('id="w-run"'));
  for (const field of ["access", "listingId", "terms", "plans", "plan", "trial", "trialAvailable", "trialNeedsCredits", "trialEnded", "accepted", "subscription", "balanceCents", "canAccept", "startBlocked", "paused"]) {
    assert.ok(accessPart.includes(`"${field}": `), `the example of the access read has no ${field}`);
  }
  assert.ok(accessPart.includes('"unit": "run",') && accessPart.includes('"keepsCopy": true'));

  // A run's answer, and /v1's: the output and the billing, and nothing of the run.
  assert.match(apiSource("routes/paidWorkflow.ts"), /return reply\.status\(200\)\.send\(\{ output, billing: result\.billing \}\);/);
  assert.ok(usePart.includes('"output": { "format": "text", "text": "Release notes: ..." },'));
  const completions = apiSource("routes/paidWorkflowCompletions.ts");
  assert.match(completions, /return \{\s+workflow: \{ slug \},\s+billing: \{/);
  assert.match(completions, /wheelsai: \{ kind: "paid_workflow" \},/);
  assert.match(text(usePart), /The answer is OpenAI's shape plus wheelsai: \{ workflow: \{ slug \}, billing \} and nothing else, and it has no usage\./);
  assert.match(said(usePart), /wheelsai: \{ kind: "paid_workflow" \}/);
  assert.match(text(inference), /paid_agent or paid_workflow/);
});

// ============================================
// The numbers
// ============================================

test("the numbers of a workflow on sale are the API's", () => {
  const maxRunMs = numberIn("services/workflowListing.ts", /PAID_WORKFLOW_MAX_RUN_MS = ([\d_]+);/);
  assert.equal(maxRunMs, 600_000);
  const minutes = maxRunMs / 60_000;
  assert.match(apiSource("services/workflowListing.ts"), /const MAX_RUN_MINUTES = PAID_WORKFLOW_MAX_RUN_MS \/ 60_000;/);
  assert.match(apiSource("services/workflowListing.ts"), /if \(!\(workflow\.timeoutMs <= PAID_WORKFLOW_MAX_RUN_MS\)\) return WORKFLOW_LISTING_MESSAGES\.tooLong;/);
  const tooLong = `A workflow on sale must finish within ${minutes} minutes. Set its time limit to ${minutes} minutes or less.`;
  assert.match(apiSource("services/workflowListing.ts"), /tooLong: `A workflow on sale must finish within \$\{MAX_RUN_MINUTES\} minutes\. Set its time limit to \$\{MAX_RUN_MINUTES\} minutes or less\.`/);
  assert.ok(said(sellPart).includes(tooLong));
  assert.ok(text(sellPart).includes("Have a time limit (timeout) of 600,000 or less."));
  assert.ok(said(sellPart).includes(`A paid run is stopped after ${minutes} minutes at the latest`));
  // The capabilities say the same number, from the same constant.
  assert.match(apiSource("routes/capabilities.ts"), /paidWorkflowMaxRunMs: PAID_WORKFLOW_MAX_RUN_MS,/);
  assert.ok(text(sellPart).includes("GET /api/capabilities says the same number as paidUse.paidWorkflowMaxRunMs, in milliseconds."));
  assert.ok(said(guide).includes(`A paid run is stopped after ${minutes} minutes.`));
  assert.ok(said(usePart).includes(`"maxRunMinutes": ${minutes},`));

  const atOnce = numberIn("services/workflowListing.ts", /PAID_WORKFLOW_MAX_ACTIVE_RUNS = (\d+);/);
  assert.ok(said(sellPart).includes(`At most ${atOnce} paid runs of one workflow go at once`));
  assert.ok(said(errorsPart).includes(`${atOnce} at once, shared by everyone who uses it`));
  assert.ok(said(guide).includes(`At most ${atOnce} paid runs of one workflow go at once`));

  const promptChars = numberIn("services/workflowChat.ts", /MAX_WORKFLOW_PROMPT_CHARS = ([\d_]+);/);
  const inputBytes = numberIn("services/workflowChat.ts", /MAX_WORKFLOW_INPUT_BYTES = ([\d_]+);/);
  assert.match(apiSource("routes/paidWorkflow.ts"), /PAID_WORKFLOW_BODY_LIMIT_BYTES = 2 \* MAX_WORKFLOW_INPUT_BYTES;/);
  const n = (value: number) => value.toLocaleString("en-US");
  assert.ok(
    text(errorsPart).includes(
      `A prompt over ${n(promptChars)} characters or an input over ${n(inputBytes)} bytes; on the run address, also a body over ${n(2 * inputBytes)} bytes.`,
    ),
  );
  // That body limit is the run address's own: /v1 has a larger one of its own, and refuses past it with its own code.
  assert.match(apiSource("routes/paidWorkflow.ts"), /bodyLimit: PAID_WORKFLOW_BODY_LIMIT_BYTES,/);
  assert.match(apiSource("routes/openaiV1.ts"), /bodyLimit: V1_BODY_LIMIT_BYTES,/);
  assert.ok(numberIn("routes/agentCompletions.ts", /V1_BODY_LIMIT_BYTES = (\d+) \* 1024 \* 1024;/) * 1024 * 1024 > 2 * inputBytes);
  assert.ok(usePart.includes(`"maxInputBytes": ${inputBytes},`) && usePart.includes(`"maxPromptChars": ${promptChars}`));

  // The price of a run: the route's bounds and the floor of a price per use.
  assert.match(apiSource("routes/marketplace.ts"), /pricePerRequestCents: z\.number\(\)\.int\(\)\.min\(1\)\.max\(100000\)\.optional\(\),/);
  assert.equal(numberIn("services/useListing.ts", /MIN_PRICE_PER_USE_CENTS = (\d+)n;/), 5);
  assert.ok(sellPart.includes('description: "The price of one run: 5 to 100,000." }'));
  assert.equal(sentenceOf("services/marketplace.ts", "perRunFloor"), "The price per run must be at least $0.05.");
  assert.ok(said(sellPart).includes('"The price per run must be at least $0.05."'));

  // A charge that was cut off waits for the longest run before it is given back.
  assert.equal(numberIn("services/buildPendingUseSweepTickDeps.ts", /PENDING_WORKFLOW_MAX_MS = (\d+) \* 60_000;/), 20);
  assert.ok(said(usePart).includes("given back within about 20 minutes"));

  // The days a plan waits for a workflow that cannot run, wherever they are told.
  assert.equal(numberIn("services/subscriptionAccess.ts", /PAST_DUE_GRACE_DAYS = (\d+);/), 3);
  assert.match(apiSource("services/deploymentDependents.ts"), /renewalGraceDays: PAST_DUE_GRACE_DAYS,/);
  assert.ok(said(sellPart).includes("If it runs again within 3 days after the plan's 30 days ended"));
  assert.ok(said(market).includes("it is charged if the workflow runs again within 3 days after the 30 days ended"));
  assert.ok(said(guide).includes("If the workflow runs again within 3 days, the plan is charged then"));

  // The limits of a buyer are an agent's: no second set.
  const perMinute = numberIn("services/publicPageState.ts", /PAID_USE_PER_BUYER_PER_MINUTE = (\d+);/);
  const perDay = numberIn("services/publicPageState.ts", /PAID_USE_PER_BUYER_PER_DAY = (\d+);/);
  assert.ok(said(usePart).includes(`${perMinute} runs a minute, and ${perDay} a day with no plan`));
  assert.ok(said(guide).includes(`up to ${perMinute} runs a minute, and with no plan up to ${perDay} a day`));

  // Numbers the pages write as words.
  const word = (value: number) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][value]!;
  const plans = numberIn("services/listingPlans.ts", /MAX_PAID_PLANS = (\d+);/);
  assert.ok(said(sellPart).includes(`up to ${word(plans)}, each a price for 30 days`));
  assert.ok(said(guide).includes(`up to ${word(plans)}, each a price for 30 days`));
  const shingle = numberIn("services/assertions.ts", /SHINGLE_WORDS = (\d+);/);
  assert.match(apiSource("services/paidWorkflow.ts"), /detectInstructionLeak\(answer\.text, ended\.confidential\)\.leaked/);
  assert.ok(said(sellPart).includes(`repeats ${word(shingle)} consecutive words`));

  // What a creator keeps of a run: the split of every sale.
  const split = splitCents(25);
  assert.equal(split.creatorCents, 22);
  assert.ok(said(guide).includes(`at $0.25 a run you earn $0.${split.creatorCents}`));
  const fee = PLATFORM_FEE_PERCENT;
  assert.ok(said(sellPart).includes(`credited ${100 - fee}% of the price, and WheelsAI keeps ${fee}%`));
  assert.ok(said(guide).includes(`You keep ${100 - fee}% of the price`));
});

// ============================================
// The sentences
// ============================================

test("every sentence the API says to a seller and a buyer of a workflow is quoted as the API says it", () => {
  const listing = "services/workflowListing.ts";
  const sellerWords = said(sellPart);
  for (const key of ["disabled", "noSteps", "marketplaceCopy", "agentGone", "oneProduct", "listingExists", "emptySlug", "sellsCopies", "notPerRun", "allowedTools", "trialPlan", "onSale", "onPlan", "hasBuyers"]) {
    const sentence = sentenceOf(listing, key);
    assert.ok(sellerWords.includes(sentence), `the reference does not say ${key}: ${sentence}`);
  }
  assert.match(apiSource(listing), /onSaleChange: \(problem: string\) => `This workflow is on sale, so this change cannot be saved\. \$\{problem\}`/);
  assert.ok(sellerWords.includes('"This workflow is on sale, so this change cannot be saved." followed by the sentence of what would be wrong'));
  // The ones the marketplace reference repeats.
  for (const key of ["oneProduct", "trialPlan"]) assert.ok(said(market).includes(sentenceOf(listing, key)), key);
  assert.ok(said(market).includes(sentenceOf("services/workflowListing.ts", "noCopy")));
  assert.ok(said(market).includes(sentenceOf("services/workflowListing.ts", "notOffered")));
  assert.ok(said(market).includes(sentenceOf("services/marketplace.ts", "stopped")));
  assert.ok(said(usePart).includes(sentenceOf("services/workflowListing.ts", "notOffered")));
  // Where each is said.
  assert.match(apiSource("services/marketplace.ts"), /throw new InstallRefusedError\("sells_use", WORKFLOW_START_MESSAGES\.noCopy, null\);/);
  assert.match(apiSource("services/marketplace.ts"), /throw new UseStartError\(409, "not_offered", WORKFLOW_START_MESSAGES\.notOffered\);/);
  assert.match(apiSource("services/listingPlans.ts"), /wrong\(at\("kind"\), PLAN_MESSAGES\.workflowTrial\);/);
  assert.match(apiSource("services/marketplace.ts"), /listingInvalid\("agentId", WORKFLOW_LISTING_MESSAGES\.oneProduct\)/);
});

test("a workflow on sale is held as the API holds it: not disabled, not changed out of sale, not deleted", () => {
  const orchestration = apiSource("services/orchestration.ts");
  // On sale: published, or somebody's plan still runs.
  assert.match(orchestration, /if \(listing\.status === "published"\) return "on_sale";/);
  assert.match(orchestration, /where: \{ listingId: listing\.id, status: "active", currentPeriodEnd: \{ gt: now \} \},/);
  assert.match(orchestration, /if \(patch\.isEnabled === false\) await assertStaysSellable\(/);
  assert.match(orchestration, /hold === "on_plan"\s+\? WORKFLOW_LISTING_MESSAGES\.onPlan\s+: change\.isEnabled === false\s+\? WORKFLOW_LISTING_MESSAGES\.onSale\s+: WORKFLOW_LISTING_MESSAGES\.onSaleChange\(problem\);/);
  // Delete: published, then anybody who ever started, then the listing goes with it.
  assert.match(orchestration, /if \(listing\?\.status === "published"\) \{\s+throw new WorkflowError\("workflow_on_sale", WORKFLOW_LISTING_MESSAGES\.onSale\);/);
  assert.match(orchestration, /if \(listing && listing\._count\.installs \+ listing\._count\.subscriptions > 0\) \{\s+throw new WorkflowError\("workflow_has_buyers"/);
  assert.match(orchestration, /await tx\.listingPlan\.deleteMany\(\{ where: \{ listingId: listing\.id \} \}\);/);
  const errors = apiSource("services/workflowErrors.ts");
  assert.match(errors, /workflow_on_sale: 409,/);
  assert.match(errors, /workflow_has_buyers: 409,/);
  const words = said(sellPart);
  const read = text(sellPart);
  assert.ok(read.includes("Disabling it answers 409 workflow_on_sale"));
  assert.ok(read.includes("Deleting a workflow whose listing is published answers 409 workflow_on_sale and cancels nothing."));
  assert.ok(read.includes("answers 409 workflow_has_buyers"));
  assert.ok(words.includes("A listing nobody started on is deleted with the workflow, plans and all."));

  // A paid run in the creator's runs: its trigger, and nobody named.
  assert.match(apiSource("services/workflowListing.ts"), /PAID_WORKFLOW_TRIGGER = "paid";/);
  assert.match(apiSource("services/buildPaidWorkflowDeps.ts"), /triggeredBy: PAID_WORKFLOW_TRIGGER,[\s\S]{0,80}?triggeredById: null,/);
  assert.ok(text(workflows).includes("has triggeredBy paid and a triggeredById of null"));
  // The organization's own cap leaves paid runs out.
  assert.match(apiSource("services/buildWorkflowRunDeps.ts"), /orchestration: \{ orgId: row\.orgId \},\s+triggeredBy: \{ not: PAID_WORKFLOW_TRIGGER \},/);
  assert.match(read, /Paid runs are not counted toward your organization's own limit of runs \(\s?workflow_run_limit\)/);

  // The sentence at the top of the reference is true of every endpoint on the page.
  assert.doesNotMatch(workflows, /Every endpoint here accepts an API key or a session and is scoped to your organization/);
  assert.match(text(workflows), /A workflow another organization sells is the one exception/);
});

test("the dependents of a deployment, and the listing reads, carry what the API adds for a workflow", () => {
  const dependents = apiSource("services/deploymentDependents.ts");
  assert.match(dependents, /workflows: Array<\{\s+id: string;\s+name: string;[\s\S]{0,200}?onSale: boolean;\s+listing: \{ id: string; title: string; subscribers: number \};[\s\S]{0,200}?renewalGraceDays: number;/);
  assert.ok(said(deployments).includes("{ id, name, onSale, listing: { id, title, subscribers }, renewalGraceDays }"));
  assert.ok(deployments.includes('"workflows": []'));

  // A listing: what it sells, a nullable agent id, the workflow's id for its owner only.
  const marketplace = apiSource("services/marketplace.ts");
  assert.match(marketplace, /productKind,\s+agentId: productKind === "workflow" \? null : listing\.agentId,/);
  assert.match(marketplace, /orchestrationId: listing\.orchestrationId \?\? null,\s+allowedTools:/);
  assert.match(marketplace, /\.\.\.\(productKind === "workflow" && \{ trial: \{ enabled: false \}, agent: undefined \}\),/);
  assert.match(text(market), /productKind is agent, or workflow for a listing that sells runs of a workflow: its agentId is then null, it has no agent, its unit is run, its trial is \{ enabled: false \}/);
  assert.ok(market.includes('{ name: "agentId", type: "uuid", description: <>One of your agents. Send it, or <code>orchestrationId</code>: one of the two.</> },'));
  assert.doesNotMatch(market, /\{ name: "agentId", type: "uuid", required: true/);
  assert.match(apiSource("routes/marketplace.ts"), /agentId: z\.string\(\)\.uuid\(\)\.optional\(\),\s+orchestrationId: z\.string\(\)\.uuid\(\)\.optional\(\),/);
  assert.match(apiSource("routes/marketplace.ts"), /createListingSchema\.omit\(\{ agentId: true, orchestrationId: true \}\)\.partial\(\)/);
  // A licence and the answer of a start: what it sells, the listing's slug, and no agent for a workflow.
  assert.match(marketplace, /productKind,\s+\/\/[^\n]*\n\s+slug: listing\.slug,\s+agent: productKind === "agent" \? licenceAgentOf\(listing\.agent\) : null,/);
  assert.ok(said(market).includes("{ access, acceptedPricing, subscription, productKind, slug, agent: { handle, name, agentKind } }"));
  // A row of the usage read.
  assert.match(apiSource("services/buyerUsage.ts"), /productKind: listing\.productKind,\s+handle: listing\.productKind === "agent" \? listing\.handle : null,/);
  assert.ok(market.includes('"productKind": "agent",'));
});

// ============================================
// The guide, in the words of the screens
// ============================================

test("the guide says selling and running a workflow in the words of the screens", () => {
  const words = said(guide);
  const sell = sellWordsOf("workflow");
  // The Sell card: its question, its one choice, its button, and what it tells the creator.
  const [choice] = sellChoices(null, DEFAULT_SELL_LIMITS, "workflow");
  assert.ok(words.includes(`<strong>${sell.question}</strong> with one answer, <strong>${choice!.title}</strong>: "${choice!.sentence}"`));
  assert.ok(words.includes(`<strong>${sell.putOnSale}</strong>`) && words.includes(`<strong>${sell.stopSelling}</strong>`));
  assert.ok(words.includes(sell.lead), "the lead");
  assert.ok(words.includes(sell.forPayers), "what a paid run cannot do");
  assert.ok(words.includes(sell.keepCopy), "where paid runs are seen");
  assert.ok(said(sellPart).includes(sell.forPayers), "the reference says it in the same words");
  // The two sentences under the form of the buyer's page, and its price line.
  assert.ok(words.includes(`"${runTimeNote(10)}"`), "the time a run can take");
  assert.ok(words.includes(`"${PAID_WORKFLOW_MESSAGES.keepsCopy}"`), "the copy the owner keeps");
  assert.ok(words.includes(`"${payAsYouGoLine({ model: "per_request", cents: 25, unit: "run" })}"`), "the price of one run");
  assert.ok(words.includes(`<strong>${PAID_WORKFLOW_MESSAGES.panelTitle}</strong>`), "the form's heading");
  // The listing's button and its chip.
  assert.ok(words.includes(`<strong>${LISTING_WORKFLOW_WORDS.button}</strong>`), "the button of a listing");
  assert.ok(words.includes(`<strong>${LISTING_WORKFLOW_WORDS.chip}</strong>`), "the chip of a listing");
  // The four sentences of the Sell card, in its order, with the longest run the API gives.
  const minutes = numberIn("services/workflowListing.ts", /PAID_WORKFLOW_MAX_RUN_MS = ([\d_]+);/) / 60_000;
  const lines = workflowSellLines(minutes);
  assert.equal(lines.length, 4);
  const listed = lines.map((line) => `<li>${line}</li>`).join(" ");
  const items = words.replace(/<li> /g, "<li>").replace(/ <\/li>/g, "</li>");
  assert.ok(items.includes(listed), "the guide lists the four sentences of the Sell card");
  assert.ok(said(sellPart).includes(lines[0]!), "the reference says the cost of steps in the same words");
  // The two fields that name the listing, and how a paid run is named in the run list.
  assert.ok(words.includes(`<strong>${WORKFLOW_LISTING_WORDS.titleLabel}</strong> and <strong>${WORKFLOW_LISTING_WORDS.lineLabel}</strong>`));
  assert.ok(words.includes(`<strong>${PAID_RUN_LABEL}</strong>`), "the run list's name of a paid run");
});

test("what the pages say of plans, the model list and a stopped listing is what the API does", () => {
  // A workflow's listing is sold per run, where a plan that is over is plan_ended: subscription_lapsed is an agent's by the month.
  assert.match(apiSource("services/workflowListing.ts"), /notPerRun: "A workflow is sold per run\./);
  const useAccess = apiSource("services/useAccess.ts");
  assert.match(useAccess, /if \(plan && listing\.pricingModel === "per_request"\) \{[\s\S]{0,300}?return agreedPerUse \? "listing_pricing" : "plan_ended";/);
  const install = apiSource("services/subscriptionAccess.ts");
  assert.match(install, /const offMonthly = args\.pricingModel !== "monthly";/);
  assert.match(install, /return args\.sub\?\.endReason \|\| offMonthly \? "pricing_changed" : "subscription_lapsed";/);
  assert.match(install, /if \(!offMonthly\) \{[\s\S]{0,200}?: "subscription_lapsed";/);
  const lapsed = errorsPart.slice(errorsPart.indexOf("code: <code>subscription_lapsed</code>"));
  assert.match(said(lapsed.slice(0, lapsed.indexOf("},"))), /a workflow does not answer it\. A plan whose renewal could not be paid ends once its days of grace are over, and then <code>plan_ended<\/code> applies\./);

  // /v1/models lists a workflow by its licence, as an agent: whether it can run now is not asked.
  const v1 = apiSource("routes/openaiV1.ts");
  const listed = v1.slice(v1.indexOf("export function usedWorkflowsOf"), v1.indexOf("export const USED_SUBSCRIPTION_COLUMNS"));
  assert.match(listed, /if \(access === "subscribed" \|\| access === "listing_pricing"\) used\.push/);
  assert.doesNotMatch(listed, /CanRunNow|canRun/);
  assert.match(apiSource("routes/paidWorkflowCompletions.ts"), /object: "model",\s+created: Math\.floor/);
  for (const page of [text(usePart), text(inference)]) {
    assert.match(page, /that yours has started and pays for, on a plan that is running or at (?:a|the) price/);
    assert.doesNotMatch(page, /organization can run now|can use now/);
  }
  assert.ok(said(usePart).includes('{ id: "w/<slug>", object: "model", created, owned_by: "wheelsai", wheelsai: { kind: "paid_workflow" } }'));
  assert.ok(text(usePart).includes("A workflow that cannot run at the moment, or a plan whose uses are gone, stays listed"));

  // A plan waits for a workflow that cannot run only while its listing is published; otherwise it closes at its end.
  const renewal = apiSource("services/buildSubscriptionRenewalTickDeps.ts");
  assert.match(renewal, /function closesAnyway\([\s\S]{0,400}?row\.listing\.status !== "published" \|\|/);
  assert.match(renewal, /if \(closesAnyway\(r, now\)\) continue;/);
  const closes = "once it is not, every plan on it ends at the end of its 30 days, uncharged, whatever the workflow can do.";
  assert.ok(text(sellPart).includes(`That holds while its listing is published; ${closes}`));
  assert.ok(text(market).includes(`That holds while its listing is published; ${closes}`));
  assert.ok(text(deployments).includes("That holds while its listing is published; once it is not (onSale false), every plan on it ends at the end of its 30 days, uncharged, whatever the workflow can do."));

  // A stopped listing keeps its page and its API page while somebody's plan on it runs, by the one test of that.
  const pageSource = apiSource("services/workflowPublicPage.ts");
  assert.match(pageSource, /if \(listing\.sells !== "use" \|\| listing\.pricingModel !== "per_request"\) return null;/);
  assert.match(pageSource, /if \(listing\.status !== "published"\) \{\s+const hold = await deps\.loadSaleHold\([\s\S]{0,200}?\);\s+if \(hold === null\) return null;/);
  assert.match(apiSource("routes/paidWorkflowBindings.ts"), /\(await import\("\.\.\/services\/orchestration\.js"\)\)\.saleHold\(ref\.workflowId, ref\.orgId, now\)/);
  // A listing that is not published offers no plan: the page of a stopped one has none.
  assert.match(apiSource("services/paidUse.ts"), /if \(!offersPlans\(listing\)\) return \[\];/);
  assert.match(apiSource("services/planOffers.ts"), /return listing\.status === "published" && listing\.sells === "use"/);
  assert.ok(text(sellPart).includes("its page and its API page stay up for them until the last of those plans ends."));
  assert.ok(text(usePart).includes("except a listing taken off sale while somebody's plan on it still runs: it answers as before, with no plans on offer, until the last of those plans ends. The same holds for its API page."));
  assert.ok(text(guide).includes("People on a plan keep it until the 30 days they paid for end, on its page and through the API."));
  for (const page of [text(sellPart), text(usePart), text(guide)]) assert.doesNotMatch(page, /no longer shown/);

  // A busy workflow found after the charge gives the charge back: the guide never says nothing was charged then.
  assert.match(apiSource("services/paidWorkflow.ts"), /function busyAfterCharge/);
  assert.ok(text(guide).includes("when it is that busy, try again in a minute: nothing is charged, or what was charged is given back."));
  assert.doesNotMatch(text(guide), /that busy, try again in a minute, and nothing is charged/);
});

test("the guide names every rule of going on sale, and the SDK's pages name what the SDK has for a workflow", () => {
  // The five rules of workflowSellableProblem, the last of them the agents its steps name.
  const listing = apiSource("services/workflowListing.ts");
  const rules = listing.slice(listing.indexOf("export function workflowSellableProblem"), listing.indexOf("export function workflowNotFound"));
  for (const key of ["disabled", "noSteps", "marketplaceCopy", "tooLong", "agentGone"]) {
    assert.match(rules, new RegExp(`return WORKFLOW_LISTING_MESSAGES\\.${key};`), key);
  }
  assert.match(rules, /if \(!workflow\.everyAgentExists\) return WORKFLOW_LISTING_MESSAGES\.agentGone;/);
  assert.ok(
    text(guide).includes(
      "A workflow can go on sale only when it is enabled, has steps, uses only agents you built, has a time limit of 10 minutes or less, and every agent its steps name still exists.",
    ),
  );

  // The SDK: use.workflow and its four calls, the run's wait, and a listing made with orchestrationId.
  const sdk = (path: string) => readFileSync(join(here, "..", "..", "..", "..", "packages", "sdk", path), "utf8");
  const resource = sdk("src/resources/useWorkflow.ts");
  for (const call of ["page", "apiPage", "access", "run"]) assert.match(resource, new RegExp(`\\n    ${call}: \\(slug: string`), call);
  assert.match(resource, /const PAID_RUN_TIMEOUT_MS = 11 \* 60_000;/);
  assert.match(resource, /timeoutMs: options\?\.timeoutMs \?\? PAID_RUN_TIMEOUT_MS,/);
  assert.match(sdk("src/resources/use.ts"), /workflow: useWorkflowMethods\(client\),/);
  const market = sdk("src/resources/marketplace.ts");
  assert.match(market, /export interface CreateWorkflowListingInput[\s\S]{0,300}?orchestrationId: string;\s+agentId\?: never;\s+pricingModel: "per_request";/);
  const minutes = numberIn("services/workflowListing.ts", /PAID_WORKFLOW_MAX_RUN_MS = ([\d_]+);/) / 60_000;
  assert.equal(minutes, 10);

  const sdkPage = text(source("app/docs/sdk/page.tsx"));
  const readme = said(sdk("README.md"));
  for (const call of ["workflow.page(slug)", "workflow.apiPage(slug)", "workflow.access(slug)", "workflow.run(slug, { input })"]) {
    assert.ok(sdkPage.includes(call), `the SDK page names ${call}`);
  }
  assert.ok(sdkPage.includes(`A run can take up to ${minutes} minutes, so run waits 11 minutes unless you pass timeoutMs`));
  assert.ok(sdkPage.includes("marketplace.createListing takes orchestrationId in place of agentId"));
  for (const call of ["use.workflow.page(", "use.workflow.apiPage(", "use.workflow.access(", "use.workflow.run("]) {
    assert.ok(readme.includes(call), `the README calls ${call}`);
  }
  assert.ok(readme.includes(`A run can take up to ${minutes} minutes, so \`use.workflow.run\` waits 11 minutes unless you pass \`timeoutMs\``));
  assert.ok(readme.includes("`marketplace.createListing` takes `orchestrationId` in place of `agentId`"));
});

test("the pages about a workflow on sale are plain ASCII and promise nothing the product does not do", () => {
  const parts: Array<[string, string]> = [
    ["workflows: sell and use", workflows.slice(workflows.indexOf('<h2 id="sell">'), workflows.indexOf('<h2 id="scheduler">'))],
    ["workflows: the top", workflows.slice(0, workflows.indexOf('<h2 id="workflows">'))],
    ["deployments: the workflows of the dependents", deployments.slice(deployments.indexOf("Each entry of <code>workflows</code>"), deployments.indexOf('<Endpoint id="delete-deployment"'))],
    ["guide", guide],
    ["marketplace", market],
  ];
  for (const [name, part] of parts) {
    assert.ok(part.length > 200, `${name}: the part was found`);
    assert.ok(/^[\x00-\x7F]*$/.test(part), `${name}: a character outside ASCII`);
    assert.doesNotMatch(part, /unlimited/i, name);
  }
  // A buyer is told nothing of the run in an example either.
  assert.doesNotMatch(usePart, /"(?:executionId|steps|tokens|durationMs|orgId|publisherId|publisherName|orchestrationId)":/);
});
