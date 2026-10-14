import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { PAID_USE_LIMITS, paidRefusalBody, type PaidCaller } from "../services/paidUse.js";
import {
  getWorkflowAccess,
  paidWorkflowKeys,
  runPaidWorkflow,
  type PaidWorkflowInput,
  type PaidWorkflowResult,
} from "../services/paidWorkflow.js";
import { usageHeadersOf, refusalUsageHeadersOf } from "../services/usageHeaders.js";
import {
  PAID_WORKFLOW_DELIVER_GRACE_MS,
  PAID_WORKFLOW_MAX_ACTIVE_RUNS,
  PAID_WORKFLOW_MAX_RUN_MS,
} from "../services/workflowListing.js";
import {
  brokenStore,
  DAY,
  KEY_CALLER,
  LICENCE,
  MONTHLY_LICENCE,
  NOW,
  PAID_MONTH,
  PLAN_LICENCE,
  PLAN_SUB,
  SESSION,
} from "./paidUseHarness.js";
import {
  BUYER_ORG,
  CREATOR_ORG,
  ENGINE_ERROR,
  paidWorkflowHarness,
  RUN_BODY,
  RUN_ID_PREFIX,
  SLUG,
  STEP_LEAK,
  STEP_NAME,
  WORKFLOW,
  WORKFLOW_ID,
  WORKFLOW_LISTING,
  WORKFLOW_OWN_NAME,
  WORKFLOW_OWN_SLUG,
  type PaidWorkflowHarness,
  type PaidWorkflowHarnessOptions,
} from "./paidWorkflowHarness.js";

// Drives services/paidWorkflow.ts on the real metering of one use and the
// real fail-closed limiter, with the rows, the money tables and the run in
// memory. What is under test is the ORDER of one paid run (each refusal
// happens before the steps after it are touched), the money rule (one charge
// before the run, settled once on delivery or refunded once in every other
// ending) and what a buyer is never told.

const run = (h: PaidWorkflowHarness, extra: Partial<PaidWorkflowInput> = {}) =>
  runPaidWorkflow(
    { caller: SESSION, slug: SLUG, body: RUN_BODY, signal: new AbortController().signal, ...extra },
    h.deps,
  );

const text = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v));

function refusalOf(result: PaidWorkflowResult) {
  assert.equal(result.kind, "refused", text(result));
  assert.ok(result.kind === "refused");
  return result.refusal;
}

function resultOf(result: PaidWorkflowResult) {
  assert.equal(result.kind, "result", text(result));
  assert.ok(result.kind === "result");
  return result;
}

/** Nothing moved: no debit, no row, no ledger line, no use of a plan, no run. */
function assertNothingTaken(h: PaidWorkflowHarness, balance = 500n) {
  assert.equal(h.money.balance, balance);
  assert.deepEqual(h.money.ledger, []);
  assert.deepEqual(h.money.revenue, []);
  for (const effect of ["charge", "take", "start", "run", "register"]) {
    assert.ok(!h.log.includes(effect), `${effect} happened: ${h.log.join(" ")}`);
  }
  assert.equal(h.runs.length, 0);
}

/** The whole charge came back: the buyer has what they had, the row is refunded and the creator was credited nothing. */
function assertRefunded(h: PaidWorkflowHarness, balance = 500n) {
  assert.equal(h.money.balance, balance);
  assert.deepEqual(
    h.money.revenue.map((row) => row.status),
    ["refunded"],
  );
  assert.equal(h.money.publisherPending, 0n);
  assert.equal(h.log.filter((effect) => effect === "refund").length, 1);
  assert.ok(!h.log.includes("settle"));
}

/** A buyer on a plan: 500 uses, 12 used, sold per run. */
const ON_PLAN: PaidWorkflowHarnessOptions = { licence: PLAN_LICENCE, sub: PLAN_SUB };

// ============================================
// Delivered
// ============================================

test("a delivered run is charged before it starts, runs in the creator's organization and is settled 90 and 10", async () => {
  const h = paidWorkflowHarness({
    listing: { ...WORKFLOW_LISTING, pricePerRequestCents: 100n },
    licence: { ...LICENCE, acceptedPricePerRequestCents: 100n },
    balance: 500n,
  });
  const result = resultOf(await run(h));

  assert.deepEqual(result.output, { format: "text", text: "Brief: launch on Tuesday." });
  assert.deepEqual(result.billing, { chargedCents: 100, balanceCents: 400, access: "listing_pricing" });
  // Only the output and the billing: nothing else is an answer's.
  assert.deepEqual(Object.keys(result).sort(), ["billing", "kind", "output"]);

  // The order: nothing is taken before the room is read, the charge is before the start, the settle after the answer.
  const order = ["countRuns:" + WORKFLOW_ID, "register", "charge", "start", "run", "readAnswer", "settle", "release"];
  assert.deepEqual(
    h.log.filter((effect) => order.includes(effect)),
    order,
  );
  assert.deepEqual(h.money.revenue, [
    { id: "rev-1", type: "per_request", status: "settled", gross: 100n, creator: 90n, platformFee: 10n },
  ]);
  assert.equal(h.money.balance, 400n);
  assert.equal(h.money.publisherPending, 90n);

  // The run is the creator's: the workflow's own organization, never the caller's.
  assert.deepEqual(h.starts, [{ workflowId: WORKFLOW_ID, orgId: CREATOR_ORG, input: { topic: "Launch plan" } }]);
  // The workflow was read by its id AND the listing's publisher.
  assert.ok(h.log.includes(`loadWorkflow:${WORKFLOW_ID}:${CREATOR_ORG}`));
  // The metering is asked for the workflow, by the run.
  assert.ok(h.log.includes(`beginUse:${WORKFLOW_ID}:run`));
  // Registered for shutdown while the charge was open, and let go after.
  assert.equal(h.registered(), 0);
});

test("what the steps used on the platform's keys is taken from the creator's amount at the settle, and nothing when none ran on them", async () => {
  const used = paidWorkflowHarness({ platformUsage: { inputTokens: 100_000, outputTokens: 50_000 } });
  resultOf(await run(used));
  // 100,000 at 15 and 50,000 at 60 cents a million: the creator's four cents repay it.
  assert.equal(used.money.useModelCostMicros, 4_500_000n);
  assert.equal(used.money.publisherPending, 0n);
  assert.equal(used.money.balance, 495n);

  const none = paidWorkflowHarness();
  resultOf(await run(none));
  assert.equal(none.money.useModelCostMicros, 0n);
  assert.equal(none.money.publisherPending, 4n);
});

test("a run on a plan takes one use, charges nothing and counts it in the billing object", async () => {
  const h = paidWorkflowHarness(ON_PLAN);
  const result = resultOf(await run(h));

  assert.equal(result.billing.chargedCents, 0);
  assert.equal(result.billing.access, "subscribed");
  assert.deepEqual(result.billing.plan, {
    id: "plan-1",
    use: "included",
    trial: false,
    includedUses: 500,
    carriedUses: 0,
    usedUses: 13,
    remainingUses: 487,
    extraUsePriceCents: 4,
    resetsAt: PLAN_SUB.currentPeriodEnd.toISOString(),
    warning: null,
  });
  assert.equal(h.sub!.usedInPeriod, 13);
  assert.equal(h.money.balance, 500n);
  assert.deepEqual(h.money.revenue, []);
  // The use is taken before the start, and a buyer on a plan is never held to the day's limit.
  assert.ok(h.log.indexOf("take") < h.log.indexOf("start"));
  assert.ok(!h.log.includes("limit:pw:b:d"));
  // The same headers as an agent's paid run.
  assert.deepEqual(usageHeadersOf(result.billing), {
    "x-wheelsai-charged-cents": "0",
    "x-wheelsai-balance-cents": "500",
    "x-wheelsai-plan": "plan-1",
    "x-wheelsai-plan-limit": "500",
    "x-wheelsai-plan-used": "13",
    "x-wheelsai-plan-remaining": "487",
    "x-wheelsai-plan-reset": PLAN_SUB.currentPeriodEnd.toISOString(),
  });
});

test("past a plan's count a run is charged the extra price the buyer agreed to, and a plan with none stops with the plans on offer", async () => {
  const extra = paidWorkflowHarness({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, usedInPeriod: 500 } });
  const paid = resultOf(await run(extra));
  assert.equal(paid.billing.chargedCents, 4);
  assert.equal(paid.billing.plan?.use, "extra");
  assert.equal(extra.money.balance, 496n);

  const plans = [{ id: "plan-2", name: "Studio", priceCents: 2_900n, includedUses: 2_000, extraUsePriceCents: null }];
  const stopped = paidWorkflowHarness({
    licence: PLAN_LICENCE,
    sub: { ...PLAN_SUB, usedInPeriod: 500, extraUsePriceCents: null },
    plans,
  });
  const refusal = refusalOf(await run(stopped));
  assert.equal(refusal.status, 429);
  assert.equal(refusal.code, "plan_used_up");
  assert.deepEqual(refusal.plans, [
    { id: "plan-2", name: "Studio", priceCents: 2_900, includedUses: 2_000, extraUsePriceCents: null },
  ]);
  assert.equal(refusal.resetsAt, PLAN_SUB.currentPeriodEnd.toISOString());
  // The plan's headers ride on the refusal, with nothing remaining.
  assert.equal(refusalUsageHeadersOf(refusal)["x-wheelsai-plan-remaining"], "0");
  assert.equal(refusalUsageHeadersOf(refusal)["x-wheelsai-plan-used"], "500");
  assertNothingTaken(stopped);
  assert.equal(stopped.sub!.usedInPeriod, 500);
});

// ============================================
// Every other ending refunds
// ============================================

interface Ending {
  name: string;
  options: PaidWorkflowHarnessOptions;
  status: number;
  code: string;
  /** With a charge of $0.05 given back, and with a use of a plan given back. */
  charged: string;
  onPlan: string;
  cancelled?: boolean;
  /** Whether it counts as an answer that was paid for and not delivered. */
  undelivered?: boolean;
}

const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const ENDINGS: Ending[] = [
  {
    name: "a failed run",
    options: { ending: { status: "failed", timedOut: false } },
    status: 502,
    code: "run_failed",
    charged: "The workflow could not finish this run. Your $0.05 was refunded.",
    onPlan: "The workflow could not finish this run. Please try again.",
  },
  {
    name: "a run past its time",
    options: { ending: { status: "failed", timedOut: true } },
    status: 504,
    code: "run_timed_out",
    charged: "The workflow took too long and was stopped. Your $0.05 was refunded.",
    onPlan: "The workflow took too long and was stopped. Please try again.",
  },
  {
    name: "a completed run with nothing to say",
    options: { answer: null },
    status: 502,
    code: "run_failed",
    charged: "The workflow could not finish this run. Your $0.05 was refunded.",
    onPlan: "The workflow could not finish this run. Please try again.",
  },
  {
    name: "a completed run with an empty text",
    options: { answer: "" },
    status: 502,
    code: "run_failed",
    charged: "The workflow could not finish this run. Your $0.05 was refunded.",
    onPlan: "The workflow could not finish this run. Please try again.",
  },
  {
    name: "a run that answers completed 13 minutes after the charge",
    options: {
      duringRun: (h) => {
        h.clock.at = minutes(13);
      },
    },
    status: 504,
    code: "run_timed_out",
    charged: "The workflow took too long and was stopped. Your $0.05 was refunded.",
    onPlan: "The workflow took too long and was stopped. Please try again.",
    cancelled: true,
  },
  {
    name: "a start that finds no room after the charge",
    options: { capacity: 0, activeRead: 0 },
    status: 429,
    code: "workflow_busy",
    charged: "This workflow is running as many times as it can right now. Your $0.05 was refunded. Try again in a minute.",
    onPlan: "This workflow is running as many times as it can right now. Try again in a minute.",
  },
  {
    name: "an answer that repeats a step agent's instructions",
    options: { answer: STEP_LEAK },
    status: 502,
    code: "answer_withheld",
    charged: "This answer could not be shown. Your $0.05 was refunded.",
    onPlan: "This answer could not be shown.",
    undelivered: true,
  },
  {
    name: "a start that throws after the charge",
    options: { startThrows: new Error(ENGINE_ERROR) },
    status: 502,
    code: "run_failed",
    charged: "The workflow could not finish this run. Your $0.05 was refunded.",
    onPlan: "The workflow could not finish this run. Please try again.",
  },
  {
    name: "an answer that cannot be read",
    options: { readThrows: new Error(ENGINE_ERROR) },
    status: 502,
    code: "run_failed",
    charged: "The workflow could not finish this run. Your $0.05 was refunded.",
    onPlan: "The workflow could not finish this run. Please try again.",
    cancelled: true,
  },
];

for (const ending of ENDINGS) {
  test(`${ending.name} refunds the whole charge`, async () => {
    const h = paidWorkflowHarness(ending.options);
    const refusal = refusalOf(await run(h));

    assert.equal(refusal.status, ending.status);
    assert.equal(refusal.code, ending.code);
    assert.equal(refusal.message, ending.charged);
    assert.equal(refusal.refundedCents, 5);
    assert.ok(!/nothing was charged/i.test(refusal.message));
    // Charged first, then given back in full, once.
    assert.ok(h.log.includes("charge"));
    assertRefunded(h);
    assert.equal(h.cancelled.length, ending.cancelled ? 1 : 0);
    assert.equal(await h.deps.limiter.peek(paidWorkflowKeys.undeliveredDay(BUYER_ORG, SLUG, DAY)), ending.undelivered ? 1 : 0);
    assert.equal(h.registered(), 0);
  });

  test(`${ending.name} gives a plan's use back`, async () => {
    const h = paidWorkflowHarness({ ...ON_PLAN, ...ending.options });
    const refusal = refusalOf(await run(h));

    assert.equal(refusal.status, ending.status);
    assert.equal(refusal.code, ending.code);
    assert.equal(refusal.message, ending.onPlan);
    assert.equal(refusal.refundedCents, undefined);
    assert.ok(!/nothing was charged/i.test(refusal.message));
    // One use was taken and the same one came back.
    assert.deepEqual(
      h.log.filter((effect) => effect === "take" || effect === "giveBack"),
      ["take", "giveBack"],
    );
    assert.equal(h.sub!.usedInPeriod, 12);
    assert.equal(h.money.balance, 500n);
    assert.equal(await h.deps.limiter.peek(paidWorkflowKeys.undeliveredDay(BUYER_ORG, SLUG, DAY)), ending.undelivered ? 1 : 0);
  });
}

test("an answer 11 minutes after the charge is delivered and settled; the line is the longest run plus its grace", async () => {
  const h = paidWorkflowHarness({
    duringRun: (harness) => {
      harness.clock.at = minutes(11);
    },
  });
  resultOf(await run(h));
  assert.deepEqual(h.money.revenue.map((row) => row.status), ["settled"]);
  assert.deepEqual(h.cancelled, []);

  // Exactly on the line is still delivered, one millisecond past it is not.
  const line = PAID_WORKFLOW_MAX_RUN_MS + PAID_WORKFLOW_DELIVER_GRACE_MS;
  const onIt = paidWorkflowHarness({
    duringRun: (harness) => {
      harness.clock.at = new Date(NOW.getTime() + line);
    },
  });
  resultOf(await run(onIt));
  const pastIt = paidWorkflowHarness({
    duringRun: (harness) => {
      harness.clock.at = new Date(NOW.getTime() + line + 1);
    },
  });
  assert.equal(refusalOf(await run(pastIt)).code, "run_timed_out");
  assertRefunded(pastIt);
});

test("the late line also holds for a caller who asked for a stream: nothing is handed over", async () => {
  const h = paidWorkflowHarness({
    duringRun: (harness) => {
      harness.clock.at = minutes(13);
    },
  });
  const result = await run(h, { body: undefined, messages: [{ role: "user", content: '{"topic":"Launch plan"}' }], stream: true });
  assert.equal(refusalOf(result).code, "run_timed_out");
  assertRefunded(h);
});

// ============================================
// The buyer leaves
// ============================================

test("a buyer who leaves cancels the run by the cancel call, is refunded, and counts as an undelivered answer", async () => {
  const gone = new AbortController();
  const h = paidWorkflowHarness({ duringRun: () => gone.abort() });
  const refusal = refusalOf(await run(h, { signal: gone.signal }));

  assert.equal(refusal.status, 499);
  assert.equal(refusal.code, "client_closed_request");
  assert.equal(refusal.refundedCents, 5);
  assert.deepEqual(h.cancelled, [`${RUN_ID_PREFIX}1`]);
  assertRefunded(h);
  // The engine's shutdown signal is the process's own, never the buyer's.
  assert.equal(h.shutdownSignals.length, 1);
  assert.equal(h.shutdownSignals[0], h.shutdown.signal);
  assert.notEqual(h.shutdownSignals[0], gone.signal);
  assert.equal(h.shutdownSignals[0]!.aborted, false);
  assert.equal(await h.deps.limiter.peek(paidWorkflowKeys.undeliveredDay(BUYER_ORG, SLUG, DAY)), 1);
});

test("a failed run does not count as an undelivered answer", async () => {
  const h = paidWorkflowHarness({ ending: { status: "failed", timedOut: false } });
  refusalOf(await run(h));
  assert.equal(await h.deps.limiter.peek(paidWorkflowKeys.undeliveredDay(BUYER_ORG, SLUG, DAY)), 0);
  assert.deepEqual(h.cancelled, []);
});

test("a caller who already left is answered before anything is charged or started", async () => {
  const gone = new AbortController();
  gone.abort();
  const h = paidWorkflowHarness();
  const refusal = refusalOf(await run(h, { signal: gone.signal }));
  assert.equal(refusal.code, "client_closed_request");
  assert.equal(refusal.refundedCents, undefined);
  assertNothingTaken(h);
});

test("a buyer with ten undelivered answers today is refused before anything is looked up", async () => {
  const h = paidWorkflowHarness();
  for (let i = 0; i < PAID_USE_LIMITS.undeliveredRefundsPerDay; i += 1) {
    await h.deps.limiter.consume([
      { scope: "org", key: paidWorkflowKeys.undeliveredDay(BUYER_ORG, SLUG, DAY), limit: 1_000_000, windowSeconds: 3_600 },
    ]);
  }
  const refusal = refusalOf(await run(h));
  assert.equal(refusal.code, "too_many_refunds");
  assert.ok(!h.log.some((effect) => effect.startsWith("loadListing")));
  assertNothingTaken(h);
});

test("a shutdown of the process while a run is going refunds and says the workflow is restarting", async () => {
  const h = paidWorkflowHarness({
    ending: { status: "failed", timedOut: false },
    duringRun: (harness) => harness.shutdown.abort(),
  });
  const refusal = refusalOf(await run(h));
  assert.equal(refusal.status, 503);
  assert.equal(refusal.code, "workflow_unavailable");
  assert.equal(refusal.message, "This workflow is restarting. Your $0.05 was refunded. Try again in a moment.");
  assertRefunded(h);

  // A process that is already stopping takes no new run and charges nothing.
  const stopping = paidWorkflowHarness({ shuttingDown: true });
  const refused = refusalOf(await run(stopping));
  assert.equal(refused.status, 503);
  assert.equal(refused.message, "This workflow is restarting. Try again in a moment.");
  assertNothingTaken(stopping);
});

// ============================================
// Refused with nothing taken
// ============================================

test("a slug that cannot exist is 404 with nothing counted and nothing looked up", async () => {
  for (const slug of ["", "Has Space", "-leading", "a".repeat(121), "../etc"]) {
    const h = paidWorkflowHarness();
    const refusal = refusalOf(await run(h, { slug }));
    assert.equal(refusal.status, 404);
    assert.equal(refusal.code, "workflow_not_found");
    assert.equal(refusal.message, "This workflow was not found.");
    // The membership was read, and nothing else happened at all.
    assert.deepEqual(h.log, ["memberRole"]);
  }
});

test("the slug of an agent's listing, and a slug nobody holds, answer 404", async () => {
  const agents = paidWorkflowHarness({ listing: { ...WORKFLOW_LISTING, agentId: "agent-1", orchestrationId: null } });
  const refusal = refusalOf(await run(agents));
  assert.equal(refusal.status, 404);
  assert.equal(refusal.code, "workflow_not_found");
  assert.ok(!agents.log.some((effect) => effect.startsWith("loadWorkflow")));
  assert.ok(!agents.log.includes("loadLicence"));
  assertNothingTaken(agents);

  const nobody = paidWorkflowHarness({ listing: null });
  assert.equal(refusalOf(await run(nobody)).code, "workflow_not_found");
  assertNothingTaken(nobody);
});

test("the owner is refused before the licence is read", async () => {
  const h = paidWorkflowHarness();
  const refusal = refusalOf(await run(h, { caller: { ...SESSION, orgId: CREATOR_ORG } }));
  assert.equal(refusal.status, 409);
  assert.equal(refusal.code, "own_workflow");
  assert.equal(refusal.message, "This is your workflow. This is the page people who pay see.");
  assert.ok(!h.log.includes("loadLicence"));
  assertNothingTaken(h);
});

const NOT_SELLABLE: Array<[string, PaidWorkflowHarnessOptions]> = [
  ["a disabled workflow", { workflow: { isEnabled: false } }],
  ["a workflow with no steps", { workflow: { stepCount: 0 } }],
  ["a workflow that uses a marketplace copy", { workflow: { usesMarketplaceCopy: true } }],
  ["a workflow with a step whose agent is gone", { workflow: { everyAgentExists: false } }],
  ["a workflow whose time limit is over ten minutes", { workflow: { timeoutMs: 600_001 } }],
  ["a workflow that left the publisher's organization", { workflow: { orgId: "org-elsewhere" } }],
  ["a workflow that is gone", { workflow: null }],
  ["a workflow that cannot be read", { workflowThrows: new Error(ENGINE_ERROR) }],
  // Sellable, but it cannot run now: refused before the charge, not refunded after it.
  ["a workflow whose model step's deployment is stopped", { modelStepsServe: false }],
  ["a workflow whose step agent's model has no deployment that can serve", { agentModelsServe: false }],
];

for (const [name, options] of NOT_SELLABLE) {
  test(`${name} is 503 with nothing taken and no run started, even for a buyer on a plan`, async () => {
    for (const buyer of [{}, ON_PLAN]) {
      const h = paidWorkflowHarness({ ...buyer, ...options });
      const refusal = refusalOf(await run(h));
      assert.equal(refusal.status, 503);
      assert.equal(refusal.code, "workflow_unavailable");
      assert.equal(refusal.message, "This workflow cannot be run right now. Nothing was charged. Try again later.");
      assertNothingTaken(h);
      assert.ok(!h.log.includes("take"));
    }
  });
}

test("a wrong input is refused with the form's own list, and an input that is too large with 413, before anything is taken", async () => {
  const missing = paidWorkflowHarness();
  const refusal = refusalOf(await run(missing, { body: { input: { subject: "x" } } }));
  assert.equal(refusal.status, 400);
  assert.equal(refusal.code, "input_invalid");
  assert.equal(refusal.message, "Some answers need another look.");
  assert.deepEqual(
    refusal.details?.map((issue) => issue.message),
    ["topic is required", "subject is not allowed"],
  );
  assertNothingTaken(missing);
  // A refused input did not spend one of the day's runs.
  assert.ok(!missing.log.includes("limit:pw:b:d"));

  const large = paidWorkflowHarness({ workflow: { inputSchema: {} } });
  const tooLarge = refusalOf(await run(large, { body: { input: { topic: "x".repeat(70_000) } } }));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.code, "input_too_large");
  assertNothingTaken(large);

  const prompt = paidWorkflowHarness({ workflow: { inputSchema: {} } });
  assert.equal(refusalOf(await run(prompt, { body: { input: { prompt: "x".repeat(20_001) } } })).code, "input_too_large");
  assertNothingTaken(prompt);
});

test("a body that is not { input: { ... } } and nothing else is refused", async () => {
  for (const body of [null, {}, { input: "text" }, { input: {}, stream: true }, { input: {}, sessionId: "s" }, []]) {
    const h = paidWorkflowHarness({ workflow: { inputSchema: {} } });
    const refusal = refusalOf(await run(h, { body }));
    assert.equal(refusal.status, 400, text(body));
    assert.equal(refusal.code, "invalid_request");
    assert.ok(!h.log.some((effect) => effect.startsWith("loadListing")));
    assertNothingTaken(h);
  }
  // A body and messages together are neither.
  const both = paidWorkflowHarness();
  assert.equal(refusalOf(await run(both, { messages: [{ role: "user", content: "hi" }] })).code, "invalid_request");
});

test("a workflow that is running as many times as it can refuses early, with nothing taken and no retry forbidden", async () => {
  const h = paidWorkflowHarness({ activeRead: PAID_WORKFLOW_MAX_ACTIVE_RUNS });
  const refusal = refusalOf(await run(h));
  assert.equal(refusal.status, 429);
  assert.equal(refusal.code, "workflow_busy");
  assert.equal(
    refusal.message,
    "This workflow is running as many times as it can right now. Nothing was charged. Try again in a minute.",
  );
  assert.equal(refusal.retryAfterSeconds, 60);
  assert.equal(refusal.noAutomaticRetry, undefined);
  assertNothingTaken(h);

  // Under the number it goes on; a count that cannot be read refuses.
  const room = paidWorkflowHarness({ activeRead: PAID_WORKFLOW_MAX_ACTIVE_RUNS - 1 });
  resultOf(await run(room));
  const unread = paidWorkflowHarness({ activeRead: new Error("db down") });
  assert.equal(refusalOf(await run(unread)).code, "workflow_unavailable");
  assertNothingTaken(unread);
});

test("the busy found after the charge tells a client not to send the request again by itself", async () => {
  const h = paidWorkflowHarness({ capacity: 0, activeRead: 0 });
  const refusal = refusalOf(await run(h));
  assert.equal(refusal.noAutomaticRetry, true);
  // The flag is for the door, never part of the body.
  assert.ok(!("noAutomaticRetry" in paidRefusalBody(refusal)));
  assert.equal(h.runs.length, 0);
});

test("five starts at once on a workflow with room for three: three run, two are refunded as busy", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const h = paidWorkflowHarness({ balance: 500n, duringRun: () => gate });
  const all = Promise.all([1, 2, 3, 4, 5].map(() => run(h)));
  // Every one of them read the count before any run existed: the early read holds nobody back here.
  while (h.log.filter((effect) => effect === "start" || effect === "start:no_room").length < 5) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(h.inFlight(), PAID_WORKFLOW_MAX_ACTIVE_RUNS);
  open();
  const results = await all;

  const delivered = results.filter((result) => result.kind === "result");
  const busy = results.filter((result) => result.kind === "refused").map((result) => refusalOf(result));
  assert.equal(delivered.length, 3);
  assert.equal(busy.length, 2);
  for (const refusal of busy) {
    assert.equal(refusal.code, "workflow_busy");
    assert.equal(refusal.refundedCents, 5);
    assert.equal(refusal.noAutomaticRetry, true);
    assert.ok(/Your \$0\.05 was refunded/.test(refusal.message));
  }
  // Five charges, three settled and two given back: fifteen cents left the buyer.
  assert.deepEqual(h.money.revenue.map((row) => row.status).sort(), ["refunded", "refunded", "settled", "settled", "settled"]);
  assert.equal(h.money.balance, 485n);
  assert.equal(h.runs.length, 3);
});

test("a listing met as a month with no count, as free or as a free trial is 503: nothing is taken and no run starts", async () => {
  const month = paidWorkflowHarness({
    listing: { ...WORKFLOW_LISTING, pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n },
    licence: MONTHLY_LICENCE,
    sub: PAID_MONTH,
  });
  const free = paidWorkflowHarness({ listing: { ...WORKFLOW_LISTING, pricingModel: "free", pricePerRequestCents: null } });
  const trial = paidWorkflowHarness({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, priceCents: 0n, includedUses: 5, usedInPeriod: 0 } });
  for (const h of [month, free, trial]) {
    const refusal = refusalOf(await run(h));
    assert.equal(refusal.status, 503);
    assert.equal(refusal.code, "workflow_unavailable");
    assertNothingTaken(h);
    assert.ok(!h.log.includes("take"));
  }
});

test("the metering handing back neither a charge nor a use starts no run", async () => {
  for (const buyer of [{}, ON_PLAN]) {
    const h = paidWorkflowHarness({ ...buyer, meteringTakesNothing: true });
    const refusal = refusalOf(await run(h));
    assert.equal(refusal.code, "workflow_unavailable");
    assert.equal(h.runs.length, 0);
    assert.ok(!h.log.includes("start"));
    assert.equal(h.registered(), 0);
  }
});

// ============================================
// The licence, the limits and the keys
// ============================================

test("a buyer who never started, one whose price was raised and one who is short of credits are refused in a workflow's words", async () => {
  const stranger = paidWorkflowHarness({ licence: null });
  const notStarted = refusalOf(await run(stranger));
  assert.equal(notStarted.status, 403);
  assert.equal(notStarted.code, "use_not_started");
  assert.equal(
    notStarted.message,
    "You have not started using this workflow. Start on its page, or ask an owner or admin of your organization to start.",
  );
  assert.deepEqual(notStarted.terms, {
    pricingModel: "per_request",
    pricePerRequestCents: 5,
    monthlyPriceCents: null,
    unit: "run",
    keepsCopy: true,
  });
  assertNothingTaken(stranger);

  const raised = paidWorkflowHarness({ listing: { ...WORKFLOW_LISTING, pricePerRequestCents: 9n } });
  const changed = refusalOf(await run(raised));
  assert.equal(changed.code, "pricing_changed");
  assert.ok(changed.message.includes("$0.09 per run"));
  assertNothingTaken(raised);

  const poor = paidWorkflowHarness({ balance: 4n });
  const short = refusalOf(await run(poor));
  assert.equal(short.status, 402);
  assert.equal(short.code, "insufficient_credits");
  assert.equal(short.message, "You do not have enough credits for this run ($0.05). Nothing was charged. Add credits to continue.");
  assertNothingTaken(poor, 4n);

  const unpublished = paidWorkflowHarness({ listing: { ...WORKFLOW_LISTING, status: "draft" }, licence: null });
  const notForSale = refusalOf(await run(unpublished));
  assert.equal(notForSale.code, "not_for_sale");
  assert.equal(notForSale.message, "Use of this workflow is not for sale.");
});

test("a session whose member was removed, and one whose membership cannot be read, are refused before anything is counted", async () => {
  const removed = paidWorkflowHarness({ role: null });
  const refusal = refusalOf(await run(removed));
  assert.equal(refusal.status, 403);
  assert.equal(refusal.code, "not_a_member");
  assert.equal(refusal.message, "You are no longer a member of this organization, so you cannot use this workflow on its behalf.");
  assert.deepEqual(removed.log, ["memberRole"]);

  const unread = paidWorkflowHarness({ roleThrows: new Error("db down") });
  assert.equal(refusalOf(await run(unread)).code, "workflow_unavailable");
  assert.deepEqual(unread.log, ["memberRole"]);
});

test("the limits are counted under the run's own keys, and the minute and the day refuse in a workflow's words", async () => {
  const h = paidWorkflowHarness();
  resultOf(await run(h));
  assert.deepEqual(
    h.log.filter((effect) => effect.startsWith("limit:") || effect.startsWith("peek:")),
    ["peek:pw:r:d", "limit:pw:b:m", "limit:pw:b:d"],
  );
  // Nothing is counted under a paid use of an agent's keys.
  assert.ok(!h.log.some((effect) => effect.includes(":pu:")));
  assert.equal(paidWorkflowKeys.buyerMinute("o", "s"), "pw:b:m:o:s");
  assert.equal(paidWorkflowKeys.buyerDay("o", "s", "d"), "pw:b:d:d:o:s");
  assert.equal(paidWorkflowKeys.undeliveredDay("o", "s", "d"), "pw:r:d:d:o:s");

  const minute = paidWorkflowHarness({ limits: { perBuyerPerMinute: 1 } });
  resultOf(await run(minute));
  const fast = refusalOf(await run(minute));
  assert.equal(fast.status, 429);
  assert.equal(fast.code, "rate_limited");
  assert.equal(fast.message, "You are sending requests faster than this workflow allows. Try again in a minute.");
  assert.equal(minute.money.revenue.length, 1);

  const day = paidWorkflowHarness({ limits: { perBuyerPerDay: 1 } });
  resultOf(await run(day));
  const second = refusalOf(await run(day));
  assert.equal(second.message, "You have used this workflow 1 times today. Try again tomorrow.");
  assert.equal(day.money.revenue.length, 1);

  const down = paidWorkflowHarness({ store: brokenStore });
  const closed = refusalOf(await run(down));
  assert.equal(closed.status, 503);
  assert.equal(closed.code, "rate_limiter_unavailable");
  assertNothingTaken(down);
});

test("a key pays within its caps, and a key over its cap or with none is refused before anything is taken", async () => {
  const key = paidWorkflowHarness({ keyCaps: { maxUse: 10n, daily: 100n } });
  resultOf(await run(key, { caller: KEY_CALLER }));
  assert.equal(key.money.keySpent, 5n);
  // A key's membership is not read: it belongs to the organization.
  assert.ok(!key.log.includes("memberRole"));

  const capped = paidWorkflowHarness({ keyCaps: { maxUse: 4n, daily: 100n } });
  const over = refusalOf(await run(capped, { caller: KEY_CALLER }));
  assert.equal(over.status, 403);
  assert.equal(over.code, "api_key_use_price_cap_exceeded");
  assertNothingTaken(capped);

  const nameless = paidWorkflowHarness();
  const caller: PaidCaller = { ...KEY_CALLER, apiKeyId: null };
  const refusal = refusalOf(await run(nameless, { caller }));
  assert.equal(refusal.code, "api_key_spend_caps_missing");
  assertNothingTaken(nameless);
});

// ============================================
// Messages, and a stream
// ============================================

test("messages run the workflow as its owner's own call does: a JSON object is the input, plain text the prompt", async () => {
  const structured = paidWorkflowHarness();
  const result = await run(structured, {
    body: undefined,
    messages: [{ role: "user", content: '{"topic":"Launch plan"}' }],
    stream: false,
  });
  resultOf(result);
  assert.deepEqual(structured.starts[0]!.input, { topic: "Launch plan" });
  assert.equal(structured.starts[0]!.prompt, undefined);

  const plain = paidWorkflowHarness({ workflow: { inputSchema: {} } });
  const messages = [
    { role: "user" as const, content: "First" },
    { role: "assistant" as const, content: "Yes?" },
    { role: "user" as const, content: "Write the brief" },
  ];
  resultOf(await run(plain, { body: undefined, messages }));
  assert.equal(plain.starts[0]!.prompt, "Write the brief");
  assert.deepEqual(plain.starts[0]!.input, { messages });

  const empty = paidWorkflowHarness({ workflow: { inputSchema: {} } });
  const refusal = refusalOf(await run(empty, { body: undefined, messages: [{ role: "user", content: "  " }] }));
  assert.equal(refusal.status, 400);
  assert.equal(refusal.code, "invalid_request");
  assertNothingTaken(empty);

  const long = paidWorkflowHarness({ workflow: { inputSchema: {} } });
  const tooLong = refusalOf(await run(long, { body: undefined, messages: [{ role: "user", content: "x".repeat(20_001) }] }));
  assert.equal(tooLong.status, 413);
  assert.equal(tooLong.code, "input_too_large");
  assertNothingTaken(long);
});

test("a stream is handed over whole, checked and NOT settled: the code that writes the bytes settles or refunds", async () => {
  const messages = [{ role: "user" as const, content: '{"topic":"Launch plan"}' }];

  const sent = paidWorkflowHarness();
  const result = await run(sent, { body: undefined, messages, stream: true });
  assert.ok(result.kind === "stream", text(result));
  assert.equal(result.text, "Brief: launch on Tuesday.");
  assert.deepEqual(result.billing, { chargedCents: 5, balanceCents: 495, access: "listing_pricing" });
  // Charged, and still open: neither settled nor refunded, and the process still waits for it.
  assert.deepEqual(sent.money.revenue.map((row) => row.status), ["pending"]);
  assert.equal(sent.registered(), 1);
  await result.meter.settle();
  await result.finished({ ok: true });
  assert.deepEqual(sent.money.revenue.map((row) => row.status), ["settled"]);
  assert.equal(sent.registered(), 0);
  // Settled once: a refund after it changes nothing.
  await result.meter.refund("late");
  assert.equal(sent.money.balance, 495n);

  const lost = paidWorkflowHarness();
  const undelivered = await run(lost, { body: undefined, messages, stream: true });
  assert.ok(undelivered.kind === "stream");
  await undelivered.meter.refund("client disconnected");
  await undelivered.finished({ ok: false });
  assertRefunded(lost);
  assert.equal(await lost.deps.limiter.peek(paidWorkflowKeys.undeliveredDay(BUYER_ORG, SLUG, DAY)), 1);
  assert.equal(lost.registered(), 0);

  // A body is always answered whole, whatever else is asked.
  const whole = paidWorkflowHarness();
  assert.equal((await run(whole, { stream: true })).kind, "result");
});

test("a plan's warning is asked once an included use that crosses 85% was delivered, with the listing's title", async () => {
  const h = paidWorkflowHarness({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, includedUses: 20, usedInPeriod: 16 } });
  const result = resultOf(await run(h));
  assert.equal(result.billing.plan?.warning, 85);
  await h.warnings.settled();
  assert.equal(h.warnings.asked.length, 1);
  assert.equal(h.warnings.asked[0]!.agentTitle, WORKFLOW_LISTING.title);
  assert.equal(h.warnings.asked[0]!.usedUses, 17);

  // A run that failed asks for none.
  const failed = paidWorkflowHarness({
    licence: PLAN_LICENCE,
    sub: { ...PLAN_SUB, includedUses: 20, usedInPeriod: 16 },
    ending: { status: "failed", timedOut: false },
  });
  refusalOf(await run(failed));
  assert.equal(failed.warnings.asked.length, 0);
});

// ============================================
// What a buyer is never told
// ============================================

test("no answer, refusal or header holds a step's name, the run's id, the workflow's own slug or name, tokens or the creator's organization", async () => {
  const secrets = [STEP_NAME, RUN_ID_PREFIX, WORKFLOW_ID, WORKFLOW_OWN_SLUG, WORKFLOW_OWN_NAME, CREATOR_ORG, "inputTokens", "outputTokens", "tokens"];
  const cases: PaidWorkflowHarnessOptions[] = [
    {},
    ON_PLAN,
    { platformUsage: { inputTokens: 1_200, outputTokens: 300 } },
    // A failing step whose error names all of them.
    { ending: { status: "failed", timedOut: false } },
    { ending: { status: "failed", timedOut: true } },
    { startThrows: new Error(ENGINE_ERROR) },
    { readThrows: new Error(ENGINE_ERROR) },
    { workflowThrows: new Error(ENGINE_ERROR) },
    { answer: STEP_LEAK },
    { capacity: 0, activeRead: 0 },
    { workflow: { isEnabled: false } },
    { licence: null },
  ];
  let failures = 0;
  for (const options of cases) {
    const h = paidWorkflowHarness(options);
    for (const result of [
      await run(h),
      await run(h, { body: undefined, messages: [{ role: "user", content: '{"topic":"Launch plan"}' }], stream: true }),
    ]) {
      const told =
        result.kind === "refused"
          ? text([result.refusal, paidRefusalBody(result.refusal), refusalUsageHeadersOf(result.refusal)])
          : text([{ ...result, meter: undefined }, usageHeadersOf(result.billing)]);
      for (const secret of secrets) assert.ok(!told.includes(secret), `${secret} in ${told}`);
      if (result.kind === "refused") failures += 1;
      if (result.kind === "stream") await result.meter.refund("test over");
    }
  }
  assert.ok(failures >= 16);
  // The engine's words did reach the core's own log, so the check above could have failed.
  const h = paidWorkflowHarness({ startThrows: new Error(ENGINE_ERROR) });
  await run(h);
  assert.ok(h.logged.some((line) => line.includes(STEP_NAME)));
});

// ============================================
// The access view
// ============================================

const access = async (h: PaidWorkflowHarness, caller: PaidCaller = SESSION, slug = SLUG) => {
  const result = await getWorkflowAccess({ caller, slug }, h.deps);
  assert.ok(result.kind === "access", text(result));
  return result.view;
};

test("the access view for a stranger, a buyer per run, a buyer on a plan and the owner", async () => {
  const plans = [{ id: "plan-2", name: "Studio", priceCents: 2_900n, includedUses: 2_000, extraUsePriceCents: null }];
  const terms = { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null, unit: "run", keepsCopy: true };
  const never = { trial: null, trialAvailable: false, trialNeedsCredits: false, trialEnded: false, startBlocked: null, paused: false };

  assert.deepEqual(await access(paidWorkflowHarness({ licence: null, plans })), {
    access: "none",
    listingId: "lst-w1",
    terms,
    plans: [{ id: "plan-2", name: "Studio", priceCents: 2_900, includedUses: 2_000, extraUsePriceCents: null }],
    plan: null,
    ...never,
    accepted: null,
    subscription: null,
    balanceCents: 500,
    canAccept: true,
  });

  const perRun = await access(paidWorkflowHarness());
  assert.equal(perRun.access, "listing_pricing");
  assert.deepEqual(perRun.accepted, { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null });
  assert.equal(perRun.plan, null);

  const onPlan = await access(paidWorkflowHarness(ON_PLAN));
  assert.equal(onPlan.access, "subscribed");
  assert.deepEqual(onPlan.plan, {
    id: "plan-1",
    name: "",
    trial: false,
    includedUses: 500,
    carriedUses: 0,
    usedUses: 12,
    remainingUses: 488,
    extraUsePriceCents: 4,
    resetsAt: PLAN_SUB.currentPeriodEnd.toISOString(),
    warning: null,
  });
  assert.deepEqual(onPlan.subscription, {
    status: "active",
    currentPeriodEnd: PLAN_SUB.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
  });

  const owner = paidWorkflowHarness();
  const own = await access(owner, { ...SESSION, orgId: CREATOR_ORG });
  assert.equal(own.access, "own_workflow");
  assert.deepEqual(own.terms, terms);
  assert.equal(own.accepted, null);
  // The owner has no licence to read.
  assert.ok(!owner.log.includes("loadLicence"));

  // A member who is not an owner or admin, and a key without the scope, cannot agree to a price.
  assert.equal((await access(paidWorkflowHarness({ role: "member" }))).canAccept, false);
  assert.equal((await access(paidWorkflowHarness(), KEY_CALLER)).canAccept, false);
  assert.equal((await access(paidWorkflowHarness(), { ...KEY_CALLER, scopes: ["marketplace:install"] })).canAccept, true);

  // A listing that is not on sale has no terms; nothing of the workflow is read for the view.
  const draft = paidWorkflowHarness({ listing: { ...WORKFLOW_LISTING, status: "draft" } });
  assert.equal((await access(draft)).terms, null);
  assert.ok(!draft.log.some((effect) => effect.startsWith("loadWorkflow")));
});

test("the access view answers 404 for a slug that cannot exist, an unknown slug and an agent's listing", async () => {
  const cannot = paidWorkflowHarness();
  const first = await getWorkflowAccess({ caller: SESSION, slug: "Not A Slug" }, cannot.deps);
  assert.ok(first.kind === "refused");
  assert.equal(first.refusal.status, 404);
  assert.equal(first.refusal.code, "workflow_not_found");
  assert.deepEqual(cannot.log, []);

  for (const listing of [null, { ...WORKFLOW_LISTING, agentId: "agent-1", orchestrationId: null }]) {
    const result = await getWorkflowAccess({ caller: SESSION, slug: SLUG }, paidWorkflowHarness({ listing }).deps);
    assert.ok(result.kind === "refused");
    assert.equal(result.refusal.code, "workflow_not_found");
  }
});

test("the sample workflow of these tests is sellable, so every refusal above is its own", () => {
  assert.equal(WORKFLOW.isEnabled && WORKFLOW.stepCount > 0 && WORKFLOW.timeoutMs <= PAID_WORKFLOW_MAX_RUN_MS, true);
});
