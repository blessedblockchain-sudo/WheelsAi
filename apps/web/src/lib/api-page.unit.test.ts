/**
 * The API page of a listing: its words and its model. Run with:
 *   cd apps/web && npx tsx --test src/lib/api-page.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentApiPage, MarketplaceListing, PublicAgentDetail, WorkflowApiPage } from "./api";
import {
  API_PAGE_HEADINGS,
  API_PAGE_WALLET_WORDS,
  API_PAGE_WORDS,
  WALLET_CALL_MINUTES,
  WORKFLOW_API_PAGE_WORDS,
  apiPageHrefOfAgent,
  apiPageHrefOfListing,
  apiPagePath,
  apiPageSummary,
  apiPageTitle,
  apiPageView,
  apiTrialLine,
  createKeyHref,
  isAgentApiPage,
  isApiPageFor,
  isWorkflowApiPage,
  limitLines,
  walletChallengeLine,
  walletDeadlineLine,
  walletLimitLine,
  workflowApiPagePath,
  workflowLimitLines,
} from "./api-page";
import { SPEND_SCOPES } from "./jobs";
import { PAID_USE_MESSAGES } from "./paid-use";
import { paidAgentChatSnippets, paidAgentRunSnippets } from "./public-urls";
import { planAfterLine, planPriceLine, planUsesLine } from "./use-plans";

const STARTER = { id: "p1", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 4 };
const PRO = { id: "p2", name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: null };

// The names the API sends (apps/api/src/services/usageHeaders.ts).
const ALWAYS = ["x-wheelsai-charged-cents", "x-wheelsai-balance-cents"];
const ON_PLAN = [
  "x-wheelsai-plan",
  "x-wheelsai-plan-limit",
  "x-wheelsai-plan-used",
  "x-wheelsai-plan-remaining",
  "x-wheelsai-plan-reset",
  "x-wheelsai-plan-warning",
];

// The refusals as the API sends them (apps/api/src/services/agentApiPage.ts).
const USED_UP = {
  code: "plan_used_up",
  status: 429,
  message:
    "You have used all the uses in your plan, and it stops until it renews. Nothing was charged. The answer carries the plan's usage headers.",
};
const NO_CREDITS = {
  code: "insufficient_credits",
  status: 402,
  message: "You do not have enough credits for this use. Nothing was charged. Add credits to continue.",
};
const LAPSED = { code: "subscription_lapsed", status: 402, message: "Your subscription has ended. Subscribe again to keep using it." };

/** A conversation sold per message with two plans, as GET /api/a/:handle/api answers. */
function chatPage(over: Partial<AgentApiPage> = {}): AgentApiPage {
  return {
    handle: "translator",
    name: "Translator",
    agentKind: "conversation",
    listingId: "l1",
    listingSlug: "translator",
    baseUrl: "https://api.example.com",
    model: "a/translator",
    endpoints: [
      { use: "openai", method: "POST", path: "/v1/chat/completions" },
      { use: "chat", method: "POST", path: "/api/a/translator/chat" },
      { use: "access", method: "GET", path: "/api/a/translator/access" },
    ],
    pricingModel: "per_request",
    unit: "message",
    priceCents: 5,
    plans: [STARTER, PRO],
    limits: { perMinute: 10, perDayWithoutPlan: 200 },
    usageHeaders: { always: ALWAYS, onPlan: ON_PLAN },
    refusals: [USED_UP, NO_CREDITS],
    ...over,
  };
}

/** A task sold per run with no plans. */
function taskPage(over: Partial<AgentApiPage> = {}): AgentApiPage {
  return chatPage({
    handle: "form-filler",
    name: "Form Filler",
    agentKind: "task",
    model: null,
    endpoints: [
      { use: "run", method: "POST", path: "/api/a/form-filler/run" },
      { use: "access", method: "GET", path: "/api/a/form-filler/access" },
    ],
    unit: "run",
    priceCents: 10,
    plans: [],
    ...over,
  });
}

/** A conversation sold by the month. */
function monthlyPage(over: Partial<AgentApiPage> = {}): AgentApiPage {
  return chatPage({
    pricingModel: "monthly",
    unit: "month",
    priceCents: 900,
    plans: [],
    usageHeaders: { always: ALWAYS, onPlan: [] },
    refusals: [LAPSED],
    ...over,
  });
}

const LOCAL = "http://localhost:4000";

function view(page: AgentApiPage, apiBase = LOCAL) {
  const built = apiPageView(page, apiBase);
  assert.ok(built);
  return built;
}

/** Every sentence a page shows, snippets and addresses left out. */
function sentencesOf(page: AgentApiPage): string[] {
  const v = view(page);
  return [
    v.title,
    v.intro,
    ...v.callNotes,
    v.keyNote,
    ...v.otherEndpoints.map((endpoint) => endpoint.says),
    v.priceLine ?? "",
    v.priceNote,
    ...v.plans.flatMap((plan) => [plan.price, plan.uses, plan.after]),
    v.payAsYouGo ?? "",
    ...v.limits,
    ...[...v.headers.always, ...v.headers.onPlan].map((header) => header.says ?? ""),
    v.oneKey,
    v.keyScope,
    v.startFirst,
    v.createKeyLabel,
    ...(v.wallet?.lines ?? []),
  ];
}

test("the words of the page are the design's", () => {
  assert.equal(API_PAGE_WORDS.oneKey, "One key and one balance work for every listing you use.");
  assert.equal(API_PAGE_WORDS.createKey, "Create a key");
  assert.equal(API_PAGE_WORDS.link, "Use it from code");
  assert.equal(apiPageTitle("Translator"), "Translator API");
  assert.equal(apiPageTitle("  Translator "), "Translator API");
  assert.equal(apiPageSummary("Translator"), "Call Translator from your own code: the address, the price, the plans and the limits.");
});

test("a conversation: the address, the model line and three snippets that call it by a chat completion", () => {
  const v = view(chatPage());
  assert.equal(v.title, "Translator API");
  assert.equal(v.kind, "chat");
  assert.equal(v.address, "https://api.example.com");
  assert.equal(v.modelLine, "model: a/translator");
  assert.equal(v.callLine, "POST https://api.example.com/v1/chat/completions");
  assert.deepEqual(v.callNotes, []);
  assert.deepEqual(v.snippets.map((snippet) => [snippet.id, snippet.label]), [
    ["curl", "curl"],
    ["javascript", "JavaScript"],
    ["python", "Python"],
  ]);
  for (const snippet of v.snippets) {
    assert.ok(snippet.code.includes("a/translator"), snippet.id);
    assert.ok(snippet.code.includes("https://api.example.com/v1"), snippet.id);
    assert.ok(snippet.code.includes("WHEELSAI_API_KEY"), snippet.id);
  }
  assert.equal(v.agentHref, "/a/translator");
});

test("no snippet and no address of the page names the owner's own model id", () => {
  for (const page of [chatPage(), taskPage(), monthlyPage()]) {
    const v = view(page);
    for (const text of [...v.snippets.map((snippet) => snippet.code), v.callLine, v.modelLine ?? "", ...v.otherEndpoints.map((e) => e.line)]) {
      assert.ok(!text.includes("agent/"), text);
    }
  }
});

test("the other addresses of a conversation are its own chat and where the caller stands", () => {
  assert.deepEqual(view(chatPage()).otherEndpoints, [
    { id: "chat", line: "POST https://api.example.com/api/a/translator/chat", says: "The same conversation in WheelsAI's own shape." },
    {
      id: "access",
      line: "GET https://api.example.com/api/a/translator/access",
      says: "Where you stand: your plan and your credits. Reading it costs nothing.",
    },
  ]);
});

test("with no public address in the answer, the address is the one this app reached the API at", () => {
  const v = view(chatPage({ baseUrl: null }), "http://localhost:4000/");
  assert.equal(v.address, "http://localhost:4000");
  assert.equal(v.callLine, "POST http://localhost:4000/v1/chat/completions");
  assert.ok(v.snippets.every((snippet) => snippet.code.includes("http://localhost:4000/v1")));
});

test("a task is called at its run address with its form's answers, and the page says so", () => {
  const v = view(taskPage());
  assert.equal(v.title, "Form Filler API");
  assert.equal(v.kind, "task");
  assert.equal(v.modelLine, null);
  assert.equal(v.callLine, "POST https://api.example.com/api/a/form-filler/run");
  assert.deepEqual(v.callNotes, [
    "This agent does one task from a form. It is called at its own run address with the answers to its form, not by a chat completion.",
    "Send one answer for each question of its form, by the question's name. The questions are on the agent's page.",
  ]);
  for (const snippet of v.snippets) {
    // One whole answer, which is what each snippet reads: a run streams unless told not to.
    assert.match(snippet.code, /"stream": false|stream: false|"stream": False/, snippet.id);
    assert.ok(snippet.code.includes("https://api.example.com/api/a/form-filler/run"), snippet.id);
    assert.ok(!snippet.code.includes("chat/completions"), snippet.id);
  }
  assert.deepEqual(v.otherEndpoints.map((endpoint) => endpoint.id), ["access"]);
  assert.match(v.intro, /^Call Form Filler from your own code\./);
});

test("the plans are worded by the agent's page, then the price per use", () => {
  const v = view(chatPage());
  assert.deepEqual(v.plans, [
    { id: "p1", name: "Starter", price: "$9.00 for 30 days", uses: "500 uses", after: "then $0.04 a use" },
    { id: "p2", name: "Pro", price: "$29.00 for 30 days", uses: "2000 uses", after: "then it stops until it renews" },
  ]);
  assert.equal(v.plans[0]!.price, planPriceLine(STARTER));
  assert.equal(v.plans[0]!.uses, planUsesLine(STARTER));
  assert.equal(v.plans[1]!.after, planAfterLine(PRO));
  assert.equal(v.payAsYouGo, "Or pay as you go: $0.05 a message");
  // Said once: after the plans, not also above them.
  assert.equal(v.priceLine, null);
  assert.equal(v.priceNote, "Paid from your WheelsAI credits. You are charged only for an answer that was delivered.");
  // The first sentence is the gate's own, not a second copy of it.
  assert.ok(v.priceNote.startsWith(PAID_USE_MESSAGES.paidFromCredits));
});

test("with no plans the price per use stands alone", () => {
  const v = view(taskPage());
  assert.deepEqual(v.plans, []);
  assert.equal(v.payAsYouGo, null);
  assert.equal(v.priceLine, "$0.10 per run");
});

test("a plan with a term missing is not drawn", () => {
  const broken = { id: "p3", name: "Broken", priceCents: 0, includedUses: 10, extraUsePriceCents: null };
  assert.deepEqual(view(chatPage({ plans: [broken, STARTER] })).plans.map((plan) => plan.id), ["p1"]);
});

test("a listing sold by the month says its price and no more", () => {
  const v = view(monthlyPage({ plans: [STARTER] }));
  assert.equal(v.priceLine, "$9.00 a month");
  assert.equal(v.priceNote, "Subscribe on the agent's page. Calls inside a month you paid for cost nothing more.");
  // No plan, no price per use and no header of a plan, whatever came with the answer.
  assert.deepEqual(v.plans, []);
  assert.equal(v.payAsYouGo, null);
  assert.deepEqual(view(monthlyPage({ usageHeaders: { always: ALWAYS, onPlan: ON_PLAN } })).headers.onPlan, []);
  assert.deepEqual(v.limits, ["One buyer can send up to 10 requests a minute.", "One buyer can send up to 200 requests a day."]);
  assert.deepEqual(v.refusals, [{ status: 402, code: "subscription_lapsed", message: LAPSED.message }]);
  // It is still called by a chat completion.
  assert.equal(v.modelLine, "model: a/translator");
});

test("the limits for one buyer, a sentence each, with the numbers the API sent", () => {
  assert.deepEqual(limitLines({ perMinute: 10, perDayWithoutPlan: 200 }, true), [
    "One buyer can send up to 10 requests a minute.",
    "A buyer on no plan can send up to 200 requests a day. On a plan, the plan's count of uses takes the place of the daily limit.",
  ]);
  assert.deepEqual(limitLines({ perMinute: 10, perDayWithoutPlan: 200 }, false), [
    "One buyer can send up to 10 requests a minute.",
    "One buyer can send up to 200 requests a day.",
  ]);
  // A limit that was not sent is not said, and no number is made up for it.
  assert.deepEqual(limitLines({ perMinute: 10 }, true), ["One buyer can send up to 10 requests a minute."]);
  assert.deepEqual(limitLines({ perMinute: 0, perDayWithoutPlan: Number.NaN }, true), []);
  assert.deepEqual(limitLines(null, true), []);
});

test("every usage header the API names has one sentence", () => {
  const v = view(chatPage());
  assert.deepEqual(v.headers.always.map((header) => header.name), ALWAYS);
  assert.deepEqual(v.headers.onPlan.map((header) => header.name), ON_PLAN);
  for (const header of [...v.headers.always, ...v.headers.onPlan]) {
    assert.ok(header.says && /^[A-Z0-9].*\.$/.test(header.says), header.name);
  }
  assert.equal(v.headers.always[0]!.says, "What this use cost, in cents. 0 for a use your plan or your subscription includes.");
  assert.equal(v.headers.onPlan[4]!.says, "When the count starts again, as an ISO time. Left out when the plan will not renew.");
});

test("a header this page has no sentence for is shown by its name alone", () => {
  const v = view(chatPage({ usageHeaders: { always: [...ALWAYS, "x-wheelsai-new"], onPlan: [] } }));
  assert.deepEqual(v.headers.always[2], { name: "x-wheelsai-new", says: null });
});

test("each refusal says its status and the API's own sentence", () => {
  const v = view(chatPage());
  assert.deepEqual(v.refusals, [
    { status: 429, code: "plan_used_up", message: USED_UP.message },
    { status: 402, code: "insufficient_credits", message: NO_CREDITS.message },
  ]);
  // The code stands beside the sentence, never inside it.
  for (const refusal of v.refusals) assert.ok(!refusal.message.includes(refusal.code), refusal.code);
});

test("a refusal that is not whole is left out", () => {
  const raw = [USED_UP, { code: "x", status: 400 }, { code: "", status: 400, message: "No." }, null, { code: "y", status: "402", message: "No." }];
  const v = view(chatPage({ refusals: raw as AgentApiPage["refusals"] }));
  assert.deepEqual(v.refusals.map((refusal) => refusal.code), ["plan_used_up"]);
});

test("an answer that names nothing to call draws no page", () => {
  assert.equal(apiPageView(chatPage({ model: null }), LOCAL), null);
  assert.equal(apiPageView(chatPage({ endpoints: [] }), LOCAL), null);
  assert.equal(apiPageView(taskPage({ endpoints: [{ use: "access", method: "GET", path: "/api/a/form-filler/access" }] }), LOCAL), null);
});

test("nothing on the page speaks of tokens, a count with no end, or how many people use it", () => {
  const dash = String.fromCharCode(0x2014);
  for (const page of [chatPage(), taskPage(), monthlyPage()]) {
    for (const sentence of sentencesOf(page)) {
      assert.ok(!/unlimited|token|\busers?\b|people|customers|organi[sz]ation/i.test(sentence), sentence);
      assert.ok(!sentence.includes(dash), sentence);
      assert.ok(/^[\x20-\x7e]*$/.test(sentence), sentence);
    }
  }
  for (const word of [...Object.values(API_PAGE_WORDS), ...Object.values(API_PAGE_HEADINGS)]) {
    assert.ok(!/unlimited|token/i.test(word) && !word.includes(dash), word);
  }
  // The only model the page names is the id to call.
  for (const sentence of sentencesOf(chatPage())) {
    assert.ok(!/\bmodel\b/i.test(sentence) || sentence.includes("model id"), sentence);
  }
});

test("the body of the read is the page's own shape, or it is not drawn", () => {
  assert.equal(isAgentApiPage(chatPage()), true);
  assert.equal(isAgentApiPage(taskPage()), true);
  assert.equal(isAgentApiPage(null), false);
  assert.equal(isAgentApiPage([]), false);
  assert.equal(isAgentApiPage({ error: "not_found" }), false);
  assert.equal(isAgentApiPage({ ...chatPage(), agentKind: "scheduled" }), false);
  assert.equal(isAgentApiPage({ ...chatPage(), name: "" }), false);
  assert.equal(isAgentApiPage({ ...chatPage(), endpoints: null }), false);
  assert.equal(isAgentApiPage({ ...chatPage(), usageHeaders: { always: ALWAYS } }), false);
});

test("the page says what a key needs before it can pay, in the keys page's own name for it", () => {
  const choice = SPEND_SCOPES.find((option) => option.scope === "agents:use");
  assert.ok(choice, "the keys page offers the choice that pays for a paid agent");
  for (const page of [chatPage(), taskPage(), monthlyPage()]) {
    const v = view(page);
    assert.equal(
      v.keyScope,
      `When you create the key, turn on "${choice.label}" and set its two spending caps. A key without it cannot pay for a use.`,
    );
    assert.equal(v.startFirst, "Start using the agent on its page before your first call.");
  }
  assert.equal(choice.label, "Use paid agents");
  // The scope's own name is for code, not for a sentence.
  assert.ok(!API_PAGE_WORDS.keyScope.includes("agents:use"));
});

test("Create a key goes to the keys page, through sign-in for someone signed out", () => {
  assert.equal(createKeyHref(true), "/dashboard/keys");
  assert.equal(createKeyHref(false), "/login?next=%2Fdashboard%2Fkeys");
  // Not known yet: the keys page, which asks a signed-out visitor to sign in itself.
  assert.equal(createKeyHref(null), "/dashboard/keys");
});

test("the page's address is beside the agent's page", () => {
  assert.equal(apiPagePath("translator"), "/a/translator/api");
  assert.equal(apiPagePath("my agent"), "/a/my%20agent/api");
});

type Detail = Pick<PublicAgentDetail, "agent" | "use">;

function detail(kind: string, state: string, paid: unknown = {}): Detail {
  return { agent: { name: "Translator", handle: "translator", agentKind: kind }, use: { state, paid } } as unknown as Detail;
}

test("the agent's page links here only when its use is sold and it is an agent that is called", () => {
  assert.equal(apiPageHrefOfAgent(detail("conversation", "paid")), "/a/translator/api");
  assert.equal(apiPageHrefOfAgent(detail("task", "paid")), "/a/translator/api");
  // A self-running agent answers no call.
  assert.equal(apiPageHrefOfAgent(detail("scheduled", "paid")), null);
  for (const state of ["on", "paused", "view_only"]) assert.equal(apiPageHrefOfAgent(detail("conversation", state, null)), null, state);
  assert.equal(apiPageHrefOfAgent(detail("conversation", "paid", null)), null);
  assert.equal(apiPageHrefOfAgent(null), null);
});

type Listing = Pick<MarketplaceListing, "sells" | "pricingModel" | "agent">;

function listing(over: Record<string, unknown> = {}, agent: Record<string, unknown> | null = {}): Listing {
  return {
    sells: "use",
    pricingModel: "per_request",
    agent: agent && { id: "a1", framework: "x", tags: [], agentKind: "conversation", isPublic: true, handle: "translator", ...agent },
    ...over,
  } as unknown as Listing;
}

test("the listing's page links here only for a listing that sells use of an agent that is called", () => {
  assert.equal(apiPageHrefOfListing(listing()), "/a/translator/api");
  assert.equal(apiPageHrefOfListing(listing({ pricingModel: "monthly" })), "/a/translator/api");
  assert.equal(apiPageHrefOfListing(listing({}, { agentKind: "task" })), "/a/translator/api");
  // Copies are installed, not called at this address.
  assert.equal(apiPageHrefOfListing(listing({ sells: "copies" })), null);
  assert.equal(apiPageHrefOfListing(listing({ pricingModel: "free" })), null);
  assert.equal(apiPageHrefOfListing(listing({ pricingModel: "tokenized" })), null);
  assert.equal(apiPageHrefOfListing(listing({}, { agentKind: "scheduled" })), null);
  assert.equal(apiPageHrefOfListing(listing({}, { handle: null })), null);
  assert.equal(apiPageHrefOfListing(listing({}, { isPublic: false })), null);
  // A row that does not say the agent is public is not linked either.
  assert.equal(apiPageHrefOfListing(listing({}, { isPublic: undefined })), null);
  assert.equal(apiPageHrefOfListing(listing({}, null)), null);
  assert.equal(apiPageHrefOfListing(null), null);
});

// ============================================
// The free trial, in one line
// ============================================

const TRIAL = { id: "t1", includedUses: 20, days: 7 };

test("a listing that offers a free trial says so in one line, and where it is started", () => {
  assert.equal(apiTrialLine(TRIAL), "Try 20 uses free for 7 days, started on the agent's page.");
  assert.equal(apiTrialLine({ id: "t", includedUses: 1, days: 1 }), "Try 1 use free for 1 day, started on the agent's page.");
  assert.equal(apiPageView(chatPage({ trial: TRIAL }), "https://x.test")?.trialLine, apiTrialLine(TRIAL));
  // With no paid plan too: the trial is offered beside the price per use.
  assert.equal(apiPageView(taskPage({ trial: TRIAL }), "https://x.test")?.trialLine, apiTrialLine(TRIAL));
});

test("no line about a trial when the listing offers none, cannot be read, or is sold by the month", () => {
  const none = [
    chatPage(),
    chatPage({ trial: null }),
    chatPage({ trial: { id: "t1", includedUses: 0, days: 7 } }),
    chatPage({ trial: { id: "", includedUses: 20, days: 7 } }),
    monthlyPage({ trial: TRIAL }),
  ];
  for (const page of none) assert.equal(apiPageView(page, "https://x.test")?.trialLine, null);
  // The rest of the page is what it was.
  const { trialLine: _with, ...withTrial } = apiPageView(chatPage({ trial: TRIAL }), "https://x.test")!;
  const { trialLine: _without, ...without } = apiPageView(chatPage(), "https://x.test")!;
  assert.deepEqual(withTrial, without);
});

// ============================================
// A workflow on sale
// ============================================

test("the listing's page links a workflow's listing to its own API page, by the listing's slug", () => {
  const workflow = (over: Record<string, unknown> = {}) =>
    ({ productKind: "workflow", sells: "use", pricingModel: "per_request", slug: "pdf-summary", ...over }) as unknown as Listing;
  assert.equal(apiPageHrefOfListing(workflow()), "/w/pdf-summary/api");
  assert.equal(workflowApiPagePath("a b"), "/w/a%20b/api");
  // A workflow is sold per run only: any other pricing has no API page.
  for (const pricingModel of ["monthly", "free", "tokenized"]) {
    assert.equal(apiPageHrefOfListing(workflow({ pricingModel })), null, pricingModel);
  }
  assert.equal(apiPageHrefOfListing(workflow({ sells: "copies" })), null);
  // With no slug there is no address to link.
  assert.equal(apiPageHrefOfListing(workflow({ slug: "" })), null);
  assert.equal(apiPageHrefOfListing(workflow({ slug: undefined })), null);
  // An agent's listing that says so is linked as it always was.
  assert.equal(apiPageHrefOfListing(listing({ productKind: "agent", slug: "something-else" })), "/a/translator/api");
});

/** A workflow sold per run with one plan, as GET /api/w/:slug/api answers. */
function workflowPage(over: Partial<WorkflowApiPage> = {}): WorkflowApiPage {
  return {
    kind: "workflow",
    name: "PDF summary",
    listingId: "l7",
    listingSlug: "pdf-summary",
    baseUrl: "https://api.example.com",
    model: "w/pdf-summary",
    endpoints: [
      { use: "run", method: "POST", path: "/api/w/pdf-summary/run" },
      { use: "openai", method: "POST", path: "/v1/chat/completions" },
      { use: "access", method: "GET", path: "/api/w/pdf-summary/access" },
    ],
    pricingModel: "per_request",
    unit: "run",
    priceCents: 5,
    plans: [STARTER],
    trial: null,
    limits: { perMinute: 10, perDayWithoutPlan: 200, maxActiveRuns: 3 },
    maxRunMinutes: 10,
    input: { maxInputBytes: 65_536, maxPromptChars: 20_000 },
    usageHeaders: { always: ALWAYS, onPlan: ON_PLAN },
    refusals: [
      {
        code: "workflow_busy",
        status: 429,
        message: "This workflow is running as many times as it can right now: 3 runs at once, shared by everyone who uses it.",
        openai: { code: "rate_limit_exceeded", status: 429 },
      },
    ],
    ...over,
  };
}

function workflowView(page: WorkflowApiPage = workflowPage()) {
  const built = apiPageView(page, LOCAL);
  assert.ok(built);
  return built;
}

test("a workflow's API page: its run address, its model id on OpenAI's chat completions, and its own words", () => {
  const v = workflowView();
  assert.equal(v.title, "PDF summary API");
  assert.equal(v.kind, "task");
  assert.equal(v.agentHref, "/w/pdf-summary");
  assert.equal(v.pageLabel, "The workflow's page");
  assert.equal(v.startPlan, "A plan is started on the workflow's page.");
  assert.equal(v.startFirst, "Start using the workflow on its page before your first call.");
  assert.equal(v.otherAddresses, "Other addresses of this workflow");
  assert.equal(v.callLine, "POST https://api.example.com/api/w/pdf-summary/run");
  assert.equal(v.modelLine, "model: w/pdf-summary");
  assert.deepEqual(v.callNotes, [WORKFLOW_API_PAGE_WORDS.runNote, WORKFLOW_API_PAGE_WORDS.form]);
  assert.deepEqual(v.otherEndpoints, [
    { id: "openai", line: "POST https://api.example.com/v1/chat/completions", says: "OpenAI's chat completions, with the model id above." },
    { id: "access", line: "GET https://api.example.com/api/w/pdf-summary/access", says: "Where you stand: your plan and your credits. Reading it costs nothing." },
  ]);
  assert.equal(v.oneKey, "One key and one balance work for every listing you use.");
  // The price per run after the plans, and never a free trial.
  assert.deepEqual(v.plans.map((plan) => plan.id), ["p1"]);
  assert.equal(v.payAsYouGo, "Or pay as you go: $0.05 a run");
  assert.equal(v.priceLine, null);
  assert.equal(workflowView(workflowPage({ plans: [] })).priceLine, "$0.05 per run");
  assert.equal(workflowView(workflowPage({ trial: { id: "t", includedUses: 5, days: 7 } as unknown as null })).trialLine, null);
  assert.deepEqual(v.refusals.map((refusal) => [refusal.status, refusal.code]), [[429, "workflow_busy"]]);
  assert.deepEqual(v.headers.onPlan.map((header) => header.name), ON_PLAN);
});

test("an agent's API page keeps its own words for the link back, the plans and the other addresses", () => {
  const v = view(chatPage());
  assert.equal(v.pageLabel, API_PAGE_WORDS.agentPage);
  assert.equal(v.startPlan, API_PAGE_WORDS.startPlan);
  assert.equal(v.otherAddresses, API_PAGE_WORDS.otherAddresses);
});

test("a workflow's limits: a buyer's own, how many runs go at once and how long one may take, from the API's numbers", () => {
  assert.deepEqual(workflowView().limits, [
    "One buyer can send up to 10 requests a minute.",
    "A buyer on no plan can send up to 200 requests a day. On a plan, the plan's count of uses takes the place of the daily limit.",
    "Up to 3 runs of this workflow go at once, shared by everyone who uses it.",
    "A run can take up to 10 minutes.",
  ]);
  assert.deepEqual(workflowLimitLines({ maxActiveRuns: 1 }, 1), [
    "One run of this workflow goes at a time, shared by everyone who uses it.",
    "A run can take up to 1 minute.",
  ]);
  assert.deepEqual(workflowLimitLines({ maxActiveRuns: 0 }, Number.NaN), []);
  assert.deepEqual(workflowLimitLines(null, 0), []);
  assert.deepEqual(workflowLimitLines(null, undefined), []);
});

test("no snippet or address of a workflow's API page names the owner's address or an agent's model", () => {
  const v = workflowView();
  const texts = [...v.snippets.map((snippet) => snippet.code), v.callLine, v.modelLine ?? "", ...v.otherEndpoints.map((endpoint) => endpoint.line)];
  for (const text of texts) {
    assert.ok(!text.includes("workflow/"), text);
    assert.ok(!text.includes("a/"), text);
  }
  // The run address takes the input and nothing else.
  for (const snippet of v.snippets) assert.ok(!/stream/i.test(snippet.code), snippet.id);
});

test("nothing on a workflow's API page speaks of an agent, a step, tokens, or who sells it", () => {
  const dash = String.fromCharCode(0x2014);
  const v = workflowView();
  const sentences = [
    v.title,
    v.intro,
    ...v.callNotes,
    v.keyNote,
    ...v.otherEndpoints.map((endpoint) => endpoint.says),
    v.priceNote,
    v.payAsYouGo ?? "",
    ...v.limits,
    v.oneKey,
    v.startFirst,
    v.startPlan,
    v.pageLabel,
    v.otherAddresses,
    ...Object.values(WORKFLOW_API_PAGE_WORDS),
  ];
  for (const sentence of sentences) {
    assert.ok(!/\bagents?\b|\bsteps?\b|token|unlimited|organi[sz]ation/i.test(sentence), sentence);
    assert.ok(!/\bmodel\b/i.test(sentence) || sentence.includes("model id"), sentence);
    assert.ok(!sentence.includes(dash), sentence);
    assert.ok(/^[\x20-\x7e]*$/.test(sentence), sentence);
  }
});

test("a workflow's API page with nothing to call, or not whole, is not drawn", () => {
  assert.equal(apiPageView(workflowPage({ model: "" }), LOCAL), null);
  assert.equal(apiPageView(workflowPage({ endpoints: [{ use: "access", method: "GET", path: "/api/w/pdf-summary/access" }] }), LOCAL), null);
  assert.equal(isWorkflowApiPage(workflowPage()), true);
  assert.equal(isWorkflowApiPage(chatPage()), false);
  assert.equal(isWorkflowApiPage({ ...workflowPage(), unit: "message" }), false);
  assert.equal(isWorkflowApiPage({ ...workflowPage(), name: "" }), false);
  assert.equal(isWorkflowApiPage({ error: "workflow_not_found" }), false);
  // Each reader takes only its own kind of page.
  assert.equal(isAgentApiPage(workflowPage()), false);
  assert.equal(isApiPageFor("workflow", workflowPage()), true);
  assert.equal(isApiPageFor("workflow", chatPage()), false);
  assert.equal(isApiPageFor("agent", chatPage()), true);
  assert.equal(isApiPageFor("agent", workflowPage()), false);
});

// ============================================
// Paying one use from a wallet, with no key
// ============================================

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** The x402 block of a listing the door serves, as GET /api/a/:handle/api answers it (apps/api/src/services/agentApiPage.ts). */
function walletBlock(over: Partial<NonNullable<AgentApiPage["x402"]>> = {}): NonNullable<AgentApiPage["x402"]> {
  return {
    priceCents: 5,
    unit: "message",
    network: DEVNET,
    asset: DEVNET_USDC,
    answerWithinSeconds: 30,
    limits: { walletPerMinute: 10, walletPerDay: 200, addressPerMinute: 10 },
    ...over,
  };
}

/** The JSON a curl sends: what stands between -d ' and the closing '. */
function curlJson(curl: string): unknown {
  const found = /-d '([\s\S]*)'$/.exec(curl);
  assert.ok(found, curl);
  return JSON.parse(found[1] ?? "");
}

test("the heading and the sentences of paying from a wallet are the lead's", () => {
  assert.equal(API_PAGE_HEADINGS.wallet, "Pay from a wallet, with no key");
  assert.equal(API_PAGE_WALLET_WORDS.noKey, "No key is needed: pay each use in USDC from a Solana wallet with an x402 client.");
  assert.equal(
    API_PAGE_WALLET_WORDS.order,
    "The answer is made and checked first. Only then is the payment sent to Solana, and the answer is released once it is confirmed, with PAYMENT-RESPONSE.",
  );
  assert.equal(API_PAGE_WALLET_WORDS.noAnswer, "When there is no answer, the payment is never sent and nothing is charged.");
  assert.equal(
    walletChallengeLine("message", 5),
    "A call with no key is answered 402 with the price of one message, $0.05 in USDC, in its PAYMENT-REQUIRED header. Your client pays and sends the same request again with PAYMENT-SIGNATURE.",
  );
  assert.equal(
    walletChallengeLine("run", 125),
    "A call with no key is answered 402 with the price of one run, $1.25 in USDC, in its PAYMENT-REQUIRED header. Your client pays and sends the same request again with PAYMENT-SIGNATURE.",
  );
  assert.equal(
    walletDeadlineLine(30),
    "An answer paid this way must be ready within 30 seconds. Allow up to 3 minutes for the whole call while the payment is confirmed.",
  );
  assert.equal(
    walletLimitLine({ walletPerMinute: 10, walletPerDay: 200, addressPerMinute: 10 }),
    "Each wallet can pay for 10 uses a minute here and 200 a day. Each address can call 10 times a minute here.",
  );
});

test("the numbers of the wallet's lines are the API's, and one it did not send is not said", () => {
  assert.equal(walletDeadlineLine(45), "An answer paid this way must be ready within 45 seconds. Allow up to 3 minutes for the whole call while the payment is confirmed.");
  assert.equal(walletDeadlineLine(1), "An answer paid this way must be ready within 1 second. Allow up to 3 minutes for the whole call while the payment is confirmed.");
  assert.equal(
    walletLimitLine({ walletPerMinute: 1, walletPerDay: 7, addressPerMinute: 1 }),
    "Each wallet can pay for 1 use a minute here and 7 a day. Each address can call 1 time a minute here.",
  );
  assert.equal(walletLimitLine({ walletPerMinute: 10, walletPerDay: 200 }), "Each wallet can pay for 10 uses a minute here and 200 a day.");
  // Half of the wallet's pair is not said alone.
  assert.equal(walletLimitLine({ walletPerMinute: 10, addressPerMinute: 4 }), "Each address can call 4 times a minute here.");
  assert.equal(walletLimitLine({ walletPerMinute: 0, walletPerDay: Number.NaN, addressPerMinute: "10" }), null);
  assert.equal(walletLimitLine(null), null);
});

test("the whole call is allowed the time the API gives a payment, written once and held to the API's constant", () => {
  const rules = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "api", "src", "services", "x402DoorRules.ts"),
    "utf8",
  );
  const found = /export const X402_MAX_TIMEOUT_SECONDS = (\d+);/.exec(rules);
  assert.ok(found, "the API names how long a payment may wait");
  assert.equal(WALLET_CALL_MINUTES * 60, Number(found[1]));
});

test("a conversation the door serves: the wallet part, its lines in order, the cluster and a first call with no key", () => {
  const v = view(chatPage({ x402: walletBlock() }));
  assert.ok(v.wallet);
  assert.deepEqual(v.wallet.lines, [
    API_PAGE_WALLET_WORDS.noKey,
    walletChallengeLine("message", 5),
    API_PAGE_WALLET_WORDS.order,
    API_PAGE_WALLET_WORDS.noAnswer,
    walletDeadlineLine(30),
    "Each wallet can pay for 10 uses a minute here and 200 a day. Each address can call 10 times a minute here.",
  ]);
  assert.equal(v.wallet.networkLine, `network: ${DEVNET}`);
  assert.equal(v.wallet.assetLine, `asset: ${DEVNET_USDC}`);
  assert.equal(v.wallet.snippet.id, "curl");
  // Its copy button is not named like the key's curl box above it.
  assert.equal(v.wallet.snippet.label, API_PAGE_WALLET_WORDS.snippetLabel);
  assert.ok(v.snippets.every((snippet) => snippet.label !== v.wallet!.snippet.label));
  // The same request the key's curl sends, at the same address, with no key.
  const keyed = paidAgentChatSnippets({ baseUrl: "https://api.example.com", model: "a/translator" });
  assert.ok(v.wallet.snippet.code.startsWith(`curl -i ${keyed.endpointUrl} `));
  assert.deepEqual(curlJson(v.wallet.snippet.code), curlJson(keyed.curl));
  assert.ok(!/Authorization|Bearer|WHEELSAI_API_KEY/.test(v.wallet.snippet.code));
  // The rest of the page is what it was without the block.
  const { wallet: _with, ...withWallet } = v;
  const { wallet: _without, ...without } = view(chatPage());
  assert.deepEqual(withWallet, without);
});

test("every number of the wallet part is the block's own, never the page's price or a number typed in", () => {
  const v = view(
    chatPage({
      x402: walletBlock({
        priceCents: 7,
        answerWithinSeconds: 20,
        limits: { walletPerMinute: 4, walletPerDay: 50, addressPerMinute: 6 },
      }),
    }),
  );
  assert.ok(v.wallet);
  assert.ok(v.wallet.lines[1]!.includes("one message, $0.07 in USDC"), v.wallet.lines[1]);
  assert.ok(v.wallet.lines[4]!.startsWith("An answer paid this way must be ready within 20 seconds."), v.wallet.lines[4]);
  assert.equal(v.wallet.lines[5], "Each wallet can pay for 4 uses a minute here and 50 a day. Each address can call 6 times a minute here.");
  // The block's unit, not the page's: a page that says message with a block that says run reads run.
  const run = view(chatPage({ x402: walletBlock({ unit: "run", priceCents: 12 }) }));
  assert.ok(run.wallet);
  assert.ok(run.wallet.lines[1]!.includes("one run, $0.12 in USDC"), run.wallet.lines[1]);
});

test("a task the door serves: one run, at its run address, with its form's answers and no key", () => {
  const v = view(taskPage({ x402: walletBlock({ unit: "run", priceCents: 10 }) }));
  assert.ok(v.wallet);
  assert.equal(v.wallet.lines[1], walletChallengeLine("run", 10));
  assert.ok(v.wallet.lines[1]!.includes("one run, $0.10 in USDC"));
  const keyed = paidAgentRunSnippets({ baseUrl: "https://api.example.com", path: "/api/a/form-filler/run" });
  assert.ok(v.wallet.snippet.code.startsWith(`curl -i ${keyed.endpointUrl} `));
  assert.deepEqual(curlJson(v.wallet.snippet.code), curlJson(keyed.curl));
  assert.ok(!v.wallet.snippet.code.includes("chat/completions"));
});

test("no wallet part without the block, with one that is not whole, on a listing by the month, or on a workflow's page", () => {
  assert.equal(view(chatPage()).wallet, null);
  assert.equal(view(chatPage({ x402: null })).wallet, null);
  assert.equal(view(chatPage({ x402: undefined })).wallet, null);
  const broken: Array<Partial<NonNullable<AgentApiPage["x402"]>> | Record<string, unknown>> = [
    { priceCents: 0 },
    { priceCents: 4.5 },
    { unit: "month" },
    { network: "" },
    { asset: "  " },
    { answerWithinSeconds: 0 },
    { answerWithinSeconds: undefined },
  ];
  for (const over of broken) {
    const page = chatPage({ x402: { ...walletBlock(), ...over } as NonNullable<AgentApiPage["x402"]> });
    assert.equal(view(page).wallet, null, JSON.stringify(over));
  }
  assert.equal(view(chatPage({ x402: [] as unknown as null })).wallet, null);
  // The door takes a use paid per message or per run, never a month.
  assert.equal(view(monthlyPage({ x402: walletBlock() })).wallet, null);
  // A workflow's page never has it, whatever came with the answer.
  assert.equal(workflowView(workflowPage({ x402: walletBlock() } as Partial<WorkflowApiPage>)).wallet, null);
  assert.equal(workflowView().wallet, null);
});

test("a block with no limits draws its lines without a limit line, never a number made up", () => {
  const v = view(chatPage({ x402: walletBlock({ limits: undefined as unknown as NonNullable<AgentApiPage["x402"]>["limits"] }) }));
  assert.ok(v.wallet);
  assert.equal(v.wallet.lines.length, 5);
  assert.ok(v.wallet.lines.every((line) => !/a minute here/.test(line)));
});

test("nothing the wallet part says speaks of tokens, people, an organization, the model or a count with no end", () => {
  const dash = String.fromCharCode(0x2014);
  const pages = [chatPage({ x402: walletBlock() }), taskPage({ x402: walletBlock({ unit: "run" }) })];
  for (const page of pages) {
    const v = view(page);
    assert.ok(v.wallet);
    for (const sentence of [...sentencesOf(page), API_PAGE_HEADINGS.wallet, ...Object.values(API_PAGE_WALLET_WORDS)]) {
      assert.ok(!/unlimited|token|\busers?\b|people|customers|organi[sz]ation|\bmodel\b|creator/i.test(sentence), sentence);
      assert.ok(!sentence.includes(dash), sentence);
      assert.ok(/^[\x20-\x7e]*$/.test(sentence), sentence);
    }
    for (const literal of [v.wallet.networkLine, v.wallet.assetLine, v.wallet.snippet.code]) {
      assert.ok(/^[\x20-\x7e\n]*$/.test(literal), literal);
    }
  }
});
