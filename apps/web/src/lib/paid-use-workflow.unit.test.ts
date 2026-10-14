/**
 * The words of a workflow's page for the person who pays to run it, and the
 * agent's words, which stay what they were. Pure. Run with:
 *   cd apps/web && npx tsx --test src/lib/paid-use-workflow.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PaidUseAccessState, PaidUseRefusal, PaidWorkflowAccessState, PublicAgentPaidTerms, PublicWorkflowRead } from "./api";
import {
  PAID_REFUSAL_RULES,
  PAID_USE_MESSAGES,
  PAID_WORKFLOW_MESSAGES,
  PAID_WORKFLOW_REFUSAL_RULES,
  STOPPED_REREADS_MS,
  isPublicWorkflowRead,
  pageTermsFor,
  paidRefusalNotice,
  paidView,
  paidWordsOf,
  priceChangedSentence,
  privacyLine,
  refusalRulesOf,
  registerHref,
  runTimeLimit,
  runTimeNote,
  signInHref,
  startDialog,
  taskDraftKey,
  workflowAccessAsAgent,
  workflowDraftKey,
  workflowPagePath,
  workflowPageTerms,
} from "./paid-use";
import { planMoveNotice, planPageView, planStartNotice } from "./use-plans";

const STARTER = { id: "p1", name: "Starter", priceCents: 900, includedUses: 100, extraUsePriceCents: 4 };

/** A workflow on sale as GET /api/w/:slug answers it. */
function read(over: Partial<PublicWorkflowRead> = {}): PublicWorkflowRead {
  return {
    kind: "workflow",
    listingId: "l1",
    slug: "pdf-summary",
    title: "PDF summary",
    description: "Summarizes a PDF in five lines.",
    pricingModel: "per_request",
    unit: "run",
    priceCents: 5,
    plans: [STARTER],
    trial: null,
    keepsCopy: true,
    maxRunMinutes: 10,
    input: { schema: { type: "object", properties: { prompt: { type: "string" } } }, maxInputBytes: 65_536, maxPromptChars: 20_000 },
    ...over,
  };
}

const PAGE = pageTermsFor(workflowPageTerms(read()), "workflow");

/** The access GET /api/w/:slug/access answers. */
function access(over: Partial<PaidWorkflowAccessState> = {}): PaidWorkflowAccessState {
  return {
    access: "none",
    listingId: "l1",
    terms: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null, unit: "run", keepsCopy: true },
    plans: [STARTER],
    plan: null,
    trial: null,
    trialAvailable: false,
    trialNeedsCredits: false,
    trialEnded: false,
    accepted: null,
    subscription: null,
    balanceCents: 1000,
    canAccept: true,
    startBlocked: null,
    paused: false,
    ...over,
  };
}

const asAgent = (over: Partial<PaidWorkflowAccessState> = {}): PaidUseAccessState => workflowAccessAsAgent(access(over));

const workflowView = (state: PaidUseAccessState | null) =>
  paidView({ authed: state !== null, access: state, page: PAGE, kind: "task" });

/** Every sentence a workflow's page can say from this file, for the checks that hold all of them. */
function workflowSentences(): string[] {
  const states = ["none", "listing_pricing", "pricing_changed", "subscribed", "not_offered", "plan_ended", "own_workflow"] as const;
  const views = [workflowView(null), ...states.map((state) => workflowView(asAgent({ access: state })))];
  const notices = Object.keys(PAID_WORKFLOW_REFUSAL_RULES).map(
    (error) => paidRefusalNotice({ status: 409, refusal: { error, message: "" } as PaidUseRefusal, act: "task", unit: "run", subject: "workflow" }).message,
  );
  return [
    ...Object.values(PAID_WORKFLOW_MESSAGES),
    ...Object.values(PAID_WORKFLOW_REFUSAL_RULES).map((rule) => rule.fallback),
    ...views.flatMap((v) => [v.sentence, v.dialog?.title ?? "", v.dialog?.body ?? "", v.action.label ?? ""]),
    ...notices,
    runTimeNote(10),
    privacyLine(true, "workflow"),
    privacyLine(false, "workflow"),
  ];
}

// ============================================
// An agent's words are what they were
// ============================================

test("an agent's sentences are byte for byte what they were, with no subject or with the agent's", () => {
  assert.equal(PAID_USE_MESSAGES.signIn, "Sign in to use this agent.");
  assert.equal(PAID_USE_MESSAGES.ownAgent, "This is your agent. This is the page people who pay see.");
  assert.equal(PAID_USE_MESSAGES.keepsCopy, "The owner of this agent gets a copy of what you send and what it answers.");
  const price = { model: "per_request" as const, cents: 5, unit: "message" as const };
  assert.deepEqual(startDialog(price), startDialog(price, undefined, "agent"));
  assert.equal(startDialog(price).title, "Start using this agent?");
  assert.equal(
    startDialog(price).body,
    "Each message costs $0.05, paid from your credits. It is charged when you send it and refunded if the agent does not answer. You can stop at any time.",
  );
  assert.equal(privacyLine(true), PAID_USE_MESSAGES.keepsCopy);
  assert.equal(privacyLine(false), PAID_USE_MESSAGES.noCopy);
  assert.equal(refusalRulesOf(), PAID_REFUSAL_RULES);
  assert.equal(refusalRulesOf("agent"), PAID_REFUSAL_RULES);
  assert.equal(paidWordsOf().signIn, PAID_USE_MESSAGES.signIn);
  assert.equal(
    priceChangedSentence({ model: "per_request", cents: 8, unit: "message" }, null),
    "This agent is now sold per message ($0.08). Nothing is charged until you accept the new price.",
  );
  // An agent's page terms are handed on as they are: nothing of a subject is added to them.
  const agentTerms = { listingId: "l9" } as PublicAgentPaidTerms;
  assert.equal(pageTermsFor(agentTerms, "agent"), agentTerms);
});

test("sign-in and sign-up come back to an agent's page by its handle, or to the page whose path is given", () => {
  assert.equal(signInHref("support-bot"), "/login?next=%2Fa%2Fsupport-bot");
  assert.equal(registerHref("support-bot"), "/register?next=%2Fa%2Fsupport-bot");
  assert.equal(signInHref({ path: workflowPagePath("pdf-summary") }), "/login?next=%2Fw%2Fpdf-summary");
  assert.equal(registerHref({ path: workflowPagePath("pdf-summary") }), "/register?next=%2Fw%2Fpdf-summary");
  assert.equal(workflowPagePath("a b"), "/w/a%20b");
});

test("a workflow's unsent answers are kept under its page's path, never under a bare slug", () => {
  assert.equal(workflowDraftKey("support-bot"), "wheelsai:paid-task-draft:/w/support-bot");
  // An agent whose handle is the same text keeps its own key.
  assert.notEqual(workflowDraftKey("support-bot"), taskDraftKey("support-bot"));
  assert.equal(taskDraftKey("support-bot"), "wheelsai:paid-task-draft:support-bot");
});

// ============================================
// A workflow's page
// ============================================

test("the two sentences the buyer is told, with the minutes the API sent", () => {
  assert.equal(privacyLine(true, "workflow"), "The owner of this workflow gets a copy of what you send and what it answers.");
  assert.equal(runTimeNote(10), "A run can take up to 10 minutes. Keep this page open: closing it cancels the run.");
  assert.equal(runTimeNote(1), "A run can take up to 1 minute. Keep this page open: closing it cancels the run.");
  assert.equal(runTimeNote(25), "A run can take up to 25 minutes. Keep this page open: closing it cancels the run.");
  // A number the API did not send, or one that is not above zero, is never said as a time.
  for (const none of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(runTimeLimit(none), null, String(none));
    assert.equal(runTimeNote(none), "Keep this page open: closing it cancels the run.", String(none));
  }
  assert.equal(runTimeLimit(undefined), null);
  assert.equal(runTimeLimit("10"), null);
  assert.equal(runTimeLimit(1), "A run can take up to 1 minute.");
  assert.equal(runTimeLimit(10), "A run can take up to 10 minutes.");
});

test("the page's terms are built from the public read: per run, a copy kept, no trial", () => {
  const terms = workflowPageTerms(read());
  assert.equal(terms.listingId, "l1");
  assert.equal(terms.listingSlug, "pdf-summary");
  assert.equal(terms.pricingModel, "per_request");
  assert.equal(terms.unit, "run");
  assert.equal(terms.priceCents, 5);
  assert.equal(terms.transcriptsStored, true);
  assert.equal(terms.sendsRequests, false);
  assert.equal(terms.trial, null);
  assert.deepEqual(terms.plans, [STARTER]);
  assert.deepEqual(workflowPageTerms(read({ plans: null as unknown as [] })).plans, []);
  assert.equal(PAGE.subject, "workflow");
});

test("the owner of a workflow is the owner's case, in the workflow's words; nothing else of the access changes", () => {
  const own = asAgent({ access: "own_workflow" });
  assert.equal(own.access, "own_agent");
  assert.equal(own.listingId, "l1");
  assert.equal(own.paused, false);
  assert.equal(asAgent({ access: "listing_pricing" }).access, "listing_pricing");
  const v = workflowView(own);
  assert.equal(v.kind, "own_agent");
  assert.equal(v.sentence, "This is your workflow. This is the page people who pay see.");
  assert.equal(v.usable, false);
});

test("where a buyer of a workflow stands, one sentence each, in the workflow's words", () => {
  const signedOut = workflowView(null);
  assert.equal(signedOut.sentence, "Sign in to use this workflow.");
  assert.deepEqual(signedOut.price, { model: "per_request", cents: 5, unit: "run" });

  const fresh = workflowView(asAgent());
  assert.equal(fresh.kind, "not_started");
  assert.equal(fresh.sentence, "Start using this workflow to run it.");
  assert.deepEqual(fresh.action, { kind: "start", label: "Start using" });
  assert.deepEqual(fresh.dialog, {
    title: "Start using this workflow?",
    body: "Each run costs $0.05, paid from your credits. It is charged when you send it and refunded if the workflow does not answer. You can stop at any time.",
    confirmLabel: "Start at $0.05 per run",
  });

  const paying = workflowView(asAgent({ access: "listing_pricing", accepted: { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null } }));
  assert.equal(paying.kind, "in_use");
  assert.equal(paying.usable, true);
  assert.equal(paying.sentence, "$0.05 per run. Your credits: $10.00.");

  const changed = workflowView(asAgent({ access: "pricing_changed", accepted: { pricingModel: "per_request", pricePerRequestCents: 4, monthlyPriceCents: null } }));
  assert.equal(changed.sentence, "The owner changed the price to $0.05 per run. You agreed to $0.04. Nothing is charged until you accept the new price.");
  assert.deepEqual(changed.action, { kind: "accept", label: "Accept $0.05 per run" });
  assert.equal(
    priceChangedSentence({ model: "per_request", cents: 5, unit: "run" }, null, "workflow"),
    "This workflow is now sold per run ($0.05). Nothing is charged until you accept the new price.",
  );

  assert.equal(workflowView(asAgent({ access: "not_offered" })).sentence, "This workflow is no longer offered. You will not be charged again.");
  assert.equal(workflowView(asAgent({ terms: null })).sentence, "This workflow is no longer offered.");
  assert.equal(workflowView(asAgent({ canAccept: false })).sentence, PAID_USE_MESSAGES.askAdmin);
});

test("the plans of a workflow come first, then pay as you go per run; a workflow never offers a free trial", () => {
  const gate = planPageView({ authed: true, access: asAgent(), page: PAGE, kind: "task" });
  assert.equal(gate.plans.place, "first");
  assert.deepEqual(gate.plans.cards, [STARTER]);
  assert.equal(gate.plans.canStart, true);
  assert.equal(gate.plans.payAsYouGo, "Or pay as you go: $0.05 a run");
  assert.equal(gate.trial.offer, null);
  assert.equal(gate.view.sentence, "Start using this workflow to run it.");

  // On a plan: the count line is the sentence, and a bigger plan can be moved to.
  const pro = { id: "p2", name: "Pro", priceCents: 2900, includedUses: 500, extraUsePriceCents: null };
  const held = planPageView({
    authed: true,
    access: asAgent({
      access: "subscribed",
      plans: [STARTER, pro],
      plan: {
        id: "p1",
        name: "Starter",
        includedUses: 100,
        usedUses: 40,
        remainingUses: 60,
        extraUsePriceCents: 4,
        resetsAt: "2026-11-12T00:00:00.000Z",
        warning: null,
      },
      accepted: { pricingModel: "per_request", pricePerRequestCents: null, monthlyPriceCents: 900 },
      subscription: { status: "active", currentPeriodEnd: "2026-11-12T00:00:00.000Z", cancelAtPeriodEnd: false, graceEndsAt: null },
    }),
    page: PAGE,
    kind: "task",
  });
  assert.equal(held.view.sentence, "60 of 100 uses left. Renews 12 Nov.");
  assert.deepEqual(held.moveUp?.cards, [pro]);

  // Signed out, the cards are shown with no button, and nothing of a trial.
  const out = planPageView({ authed: false, access: null, page: PAGE, kind: "task" });
  assert.equal(out.plans.place, "first");
  assert.equal(out.plans.canStart, false);
  assert.equal(out.trial.offer, null);
});

// ============================================
// Refusals of a workflow's run, start and plan
// ============================================

const refuse = (status: number, refusal: Partial<PaidUseRefusal> | null) =>
  paidRefusalNotice({ status, refusal: refusal as PaidUseRefusal | null, act: "task", unit: "run", subject: "workflow" });

test("the six codes of a paid run show the API's own sentence, with the action the page needs", () => {
  const said = {
    own_workflow: [409, "This is your workflow. This is the page people who pay see."],
    workflow_not_found: [404, "This workflow was not found."],
    workflow_unavailable: [503, "This workflow cannot be run right now. Nothing was charged. Try again later."],
    workflow_busy: [429, "This workflow is running as many times as it can right now. Nothing was charged. Try again in a minute."],
    run_failed: [502, "The workflow could not finish this run. Please try again."],
    run_timed_out: [504, "The workflow took too long and was stopped. Please try again."],
  } as const;
  for (const [error, [status, message]] of Object.entries(said)) {
    const notice = refuse(status, { error, message });
    assert.equal(notice.code, error);
    assert.equal(notice.message, message, error);
  }
  // Busy and unavailable ask to wait: the form stays and is run again with its own button.
  assert.deepEqual(refuse(429, { error: "workflow_busy", message: "x", retryAfterSeconds: 30 }).action, { kind: "wait", label: null });
  assert.equal(refuse(429, { error: "workflow_busy", message: "x", retryAfterSeconds: 30 }).retryAfterSeconds, 30);
  assert.deepEqual(refuse(503, { error: "workflow_unavailable", message: "x" }).action, { kind: "wait", label: null });
  // The owner reads the owner's words, whatever the API sent: a start answers own_agent for a workflow too.
  assert.equal(refuse(409, { error: "own_workflow", message: "Something else." }).message, PAID_WORKFLOW_MESSAGES.own);
  assert.equal(refuse(409, { error: "own_agent", message: "This is your workflow. You do not pay to use it." }).message, PAID_WORKFLOW_MESSAGES.own);
  // With no sentence from the API, the rule's.
  assert.equal(refuse(502, { error: "run_failed", message: "" }).message, PAID_WORKFLOW_REFUSAL_RULES.run_failed?.fallback);
});

test("a run that was charged and then failed, took too long or found no room says the API's refund", () => {
  const failed = refuse(502, { error: "run_failed", message: "The workflow could not finish this run. Your $0.05 was refunded.", refundedCents: 5 });
  assert.equal(failed.message, "The workflow could not finish this run. Your $0.05 was refunded.");
  assert.equal(failed.refundedCents, 5);
  const late = refuse(504, { error: "run_timed_out", message: "The workflow took too long and was stopped. Your $0.05 was refunded.", refundedCents: 5 });
  assert.equal(late.message, "The workflow took too long and was stopped. Your $0.05 was refunded.");
  const full = refuse(429, {
    error: "workflow_busy",
    message: "This workflow is running as many times as it can right now. Your $0.05 was refunded. Try again in a minute.",
    refundedCents: 5,
  });
  assert.equal(full.message, "This workflow is running as many times as it can right now. Your $0.05 was refunded. Try again in a minute.");
  // A restart in the middle: the API answers a workflow's run with workflow_unavailable and the refund.
  const restarted = refuse(503, {
    error: "workflow_unavailable",
    message: "This workflow is restarting. Your $0.05 was refunded. Try again in a moment.",
    refundedCents: 5,
  });
  assert.equal(restarted.message, "This workflow is restarting. Your $0.05 was refunded. Try again in a moment.");
  assert.equal(restarted.refundedCents, 5);
  // An agent's code on a workflow's page, which the API does not send, still never says an agent's words.
  const agentCode = refuse(503, { error: "agent_unavailable", message: "This workflow is restarting. Your $0.05 was refunded. Try again in a moment.", refundedCents: 5 });
  assert.equal(agentCode.message, "This workflow is restarting. Your $0.05 was refunded. Try again in a moment.");
  // None of them says nothing was charged.
  for (const notice of [failed, late, full, restarted, agentCode]) assert.doesNotMatch(notice.message, /Nothing was charged/);
});

test("a workflow's input that does not fit its form is one list for the whole form, never beside a question", () => {
  const notice = refuse(400, {
    error: "input_invalid",
    message: "Some answers need another look.",
    details: [
      { path: "", field: null, label: null, message: "topic is required" },
      { path: "", field: null, label: null, message: "count must be at least 1." },
      { path: "", field: null, label: null, message: "topic is required" },
    ],
  });
  assert.equal(notice.message, "Some answers need another look: topic is required; count must be at least 1.");
  assert.deepEqual(notice.fields, {});
  // With no list, the sentence alone.
  assert.equal(refuse(400, { error: "input_invalid", message: "x" }).message, "Some answers need another look.");
  assert.equal(refuse(413, { error: "input_too_large", message: "x" }).message, "Your answers are too long. Shorten them and try again.");
  // An agent's is what it was: each answer beside its question.
  const agent = paidRefusalNotice({
    status: 422,
    refusal: { error: "input_invalid", message: "x", details: [{ path: "/topic", field: "topic", label: "Topic", message: "Required." }] } as PaidUseRefusal,
    act: "task",
    unit: "run",
  });
  assert.equal(agent.message, "Some answers need another look.");
  assert.deepEqual(agent.fields, { topic: "Required." });
});

test("a 404 with no sentence, a 401, and no answer at all, in the workflow's words", () => {
  assert.equal(refuse(404, null).message, "This workflow was not found.");
  assert.equal(refuse(404, null).code, "workflow_not_found");
  assert.equal(refuse(401, null).message, "Sign in to use this workflow.");
  assert.deepEqual(refuse(401, { error: "unauthorized", message: "x" }).action, { kind: "signin", label: "Sign in" });
  assert.equal(refuse(0, null).message, "The workflow could not be reached. Check your connection and try again.");
  assert.equal(refuse(500, null).message, PAID_USE_MESSAGES.unknown);
  // An agent's 404 with no sentence is what it was.
  assert.equal(paidRefusalNotice({ status: 404, refusal: null, act: "task", unit: "run" }).message, PAID_USE_MESSAGES.unknown);
  assert.equal(refuse(403, { error: "use_not_started", message: "x" }).message, "You have not started using this workflow.");
  assert.deepEqual(refuse(403, { error: "use_not_started", message: "x" }).action, { kind: "start", label: "Start using" });
  assert.equal(
    refuse(402, { error: "insufficient_credits", message: "x", priceCents: 5 }).message,
    "You do not have enough credits for this run ($0.05). Nothing was charged. Add credits to continue.",
  );
});

test("no sentence of a workflow's page names an agent, a model, tokens, a step or a count with no end", () => {
  const dash = String.fromCharCode(0x2014);
  for (const sentence of workflowSentences()) {
    assert.ok(!/\bagents?\b|\bmodel\b|token|\bsteps?\b|unlimited/i.test(sentence), sentence);
    assert.ok(!sentence.includes(dash), sentence);
    assert.ok(/^[\x20-\x7e]*$/.test(sentence), sentence);
  }
  // Every code a workflow's page can meet has a rule, and the rules of an agent alone are not among them.
  for (const code of ["own_workflow", "workflow_not_found", "workflow_unavailable", "workflow_busy", "run_failed", "run_timed_out"]) {
    assert.ok(PAID_WORKFLOW_REFUSAL_RULES[code], code);
  }
  for (const code of ["agent_not_found", "agent_paused", "results_only", "sells_copies", "trial_already_used", "listing_paused"]) {
    assert.equal(PAID_WORKFLOW_REFUSAL_RULES[code], undefined, code);
  }
  // Stopping a run never says nothing was charged.
  assert.doesNotMatch(PAID_WORKFLOW_MESSAGES.stopped, /Nothing was charged/);
});

test("a body is a workflow's public page only when it is whole", () => {
  assert.equal(isPublicWorkflowRead(read()), true);
  assert.equal(isPublicWorkflowRead(null), false);
  assert.equal(isPublicWorkflowRead([]), false);
  assert.equal(isPublicWorkflowRead({ error: "workflow_not_found" }), false);
  assert.equal(isPublicWorkflowRead({ ...read(), kind: "agent" }), false);
  assert.equal(isPublicWorkflowRead({ ...read(), title: " " }), false);
  assert.equal(isPublicWorkflowRead({ ...read(), priceCents: "5" }), false);
  assert.equal(isPublicWorkflowRead({ ...read(), input: { maxInputBytes: 10 } }), false);
});

test("a refused plan start or move on a workflow's page says the workflow's words; an agent's says what it said", () => {
  const offline = { status: 0, refusal: null, unit: "run" as const };
  const ended = { status: 401, refusal: null, unit: "run" as const };
  for (const notice of [planStartNotice, planMoveNotice]) {
    assert.equal(notice({ ...offline, subject: "workflow" }).message, PAID_WORKFLOW_MESSAGES.offline);
    assert.equal(notice({ ...ended, subject: "workflow" }).message, PAID_WORKFLOW_MESSAGES.signIn);
    assert.equal(notice({ status: 404, refusal: null, unit: "run", subject: "workflow" }).message, PAID_WORKFLOW_MESSAGES.notFound);
    const own = { error: "own_agent", message: "This is your workflow. You do not pay to use it." } as PaidUseRefusal;
    assert.equal(notice({ status: 409, refusal: own, unit: "run", subject: "workflow" }).message, PAID_WORKFLOW_MESSAGES.own);
    // An agent's, with no subject or with the agent's, as before.
    for (const agent of [{}, { subject: "agent" as const }]) {
      assert.equal(notice({ ...offline, unit: "message", ...agent }).message, PAID_USE_MESSAGES.offline);
      assert.equal(notice({ ...ended, unit: "message", ...agent }).message, PAID_USE_MESSAGES.signIn);
    }
  }
});

test("a code whose sentence names nothing that is sold is the agent's own rule, written once", () => {
  const shared = Object.keys(PAID_WORKFLOW_REFUSAL_RULES).filter(
    (code) => PAID_WORKFLOW_REFUSAL_RULES[code] === PAID_REFUSAL_RULES[code],
  );
  assert.equal(shared.length, 14);
  for (const code of ["insufficient_credits", "plan_used_up", "pricing_changed", "input_invalid", "client_closed_request"]) {
    assert.ok(shared.includes(code), code);
  }
  // Every rule a workflow shares with an agent names neither.
  for (const code of shared) assert.doesNotMatch(PAID_WORKFLOW_REFUSAL_RULES[code]?.fallback ?? "", /\bagents?\b|\bworkflows?\b/i, code);
});

test("after a stopped run the access is read again later, when the refund has had time to land", () => {
  assert.ok(STOPPED_REREADS_MS.length > 0);
  for (const [i, ms] of STOPPED_REREADS_MS.entries()) {
    assert.ok(Number.isInteger(ms) && ms > 0, String(ms));
    if (i > 0) assert.ok(ms > (STOPPED_REREADS_MS[i - 1] ?? 0));
  }
});
