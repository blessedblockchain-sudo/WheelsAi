import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  chargeRefusal,
  CLIENT_GONE_REFUSAL,
  failureRefusal,
  limitRefusal,
  NOT_A_MEMBER,
  PAID_USE_LIMITS,
  PAID_USE_MESSAGES,
  PAID_USE_REFUSAL_CODES,
  refused,
  UNAVAILABLE,
  type PaidUseErrorCode,
} from "../services/paidUse.js";
import { resolveUseBilling, type UseBillingInput } from "../services/useMetering.js";
import { platformUsageOf, watchWorkflowExecutor, type WorkflowStepExecutor } from "../services/watchedWorkflowExecutor.js";
import { AGENT, BUYER_ORG, CREATOR_ORG, LICENCE, LISTING, NOW, paidMoneyTables } from "./paidUseHarness.js";

// What a paid run of a workflow shares with a paid use of an agent. What
// these pin: every sentence with `thing` left out is the agent's sentence it
// always was, and a workflow has its own beside it; the list of codes holds
// the six of a workflow; the metering takes the same model cost from a ready
// sum as it does from one noted call; and the watcher of a workflow's agent
// steps collects and sums what a hired job's did.

const FAILURE = { message: "", retryAfterSeconds: null };
const NOTHING_CHARGED = /Nothing was charged/;

// ============================================
// Sentences with a noun
// ============================================

test("a limiter refusal with no thing named is the agent's sentence, and a workflow has its own", () => {
  const limited = { status: 429, code: "rate_limited", scope: "org", retryAfterSeconds: 12 };
  assert.deepEqual(limitRefusal(limited, PAID_USE_LIMITS, "minute"), {
    status: 429,
    code: "rate_limited",
    message: "You are sending requests faster than this agent allows. Try again in a minute.",
    scope: "org",
    retryAfterSeconds: 12,
  });
  assert.equal(limitRefusal(limited, PAID_USE_LIMITS, "day").message, "You have used this agent 200 times today. Try again tomorrow.");
  assert.equal(
    limitRefusal({ ...limited, scope: "agent" }, PAID_USE_LIMITS, "minute").message,
    "This agent has reached its limit for now. Nothing was charged. Try again later.",
  );
  assert.deepEqual(limitRefusal({ status: 503, code: "rate_limiter_unavailable" }, PAID_USE_LIMITS, "minute"), {
    status: 503,
    code: "rate_limiter_unavailable",
    message: "This agent is temporarily unavailable. Nothing was charged. Try again shortly.",
    retryAfterSeconds: 30,
  });
  // Naming the agent says the same as naming nothing.
  for (const rule of ["minute", "day"] as const) {
    assert.deepEqual(limitRefusal(limited, PAID_USE_LIMITS, rule, "agent"), limitRefusal(limited, PAID_USE_LIMITS, rule));
  }

  // A workflow: the same statuses, codes and waits, in its own words.
  assert.deepEqual(limitRefusal(limited, PAID_USE_LIMITS, "minute", "workflow"), {
    status: 429,
    code: "rate_limited",
    message: "You are sending requests faster than this workflow allows. Try again in a minute.",
    scope: "org",
    retryAfterSeconds: 12,
  });
  assert.equal(
    limitRefusal(limited, PAID_USE_LIMITS, "day", "workflow").message,
    "You have used this workflow 200 times today. Try again tomorrow.",
  );
  assert.equal(
    limitRefusal({ status: 503, code: "rate_limiter_unavailable" }, PAID_USE_LIMITS, "minute", "workflow").message,
    "This workflow is temporarily unavailable. Nothing was charged. Try again shortly.",
  );
});

test("a use that produced no answer, with no thing named, is the agent's refusal; a workflow's is a run that failed", () => {
  assert.deepEqual(failureRefusal({ code: "upstream_error", ...FAILURE }, 5n), {
    status: 502,
    code: "model_error",
    message: "The agent could not answer just now. Your $0.05 was refunded.",
    refundedCents: 5,
  });
  assert.equal(failureRefusal({ code: "upstream_error", ...FAILURE }, null).message, "The agent could not answer just now. Please try again.");
  assert.deepEqual(failureRefusal({ code: "service_unavailable", ...FAILURE }, 5n), {
    status: 503,
    code: "agent_unavailable",
    message: "This agent is restarting. Your $0.05 was refunded. Try again in a moment.",
    retryAfterSeconds: 5,
    refundedCents: 5,
  });
  assert.deepEqual(failureRefusal({ code: "client_gone", ...FAILURE }, 5n), { ...CLIENT_GONE_REFUSAL, refundedCents: 5 });
  assert.deepEqual(
    failureRefusal({ code: "upstream_error", ...FAILURE }, 5n, "agent"),
    failureRefusal({ code: "upstream_error", ...FAILURE }, 5n),
  );

  assert.deepEqual(failureRefusal({ code: "upstream_error", ...FAILURE }, 5n, "workflow"), {
    status: 502,
    code: "run_failed",
    message: "The workflow could not finish this run. Your $0.05 was refunded.",
    refundedCents: 5,
  });
  // On a plan, or with nothing to refund.
  assert.deepEqual(failureRefusal({ code: "upstream_error", ...FAILURE }, null, "workflow"), {
    status: 502,
    code: "run_failed",
    message: "The workflow could not finish this run. Please try again.",
  });
  assert.deepEqual(failureRefusal({ code: "service_unavailable", ...FAILURE }, 5n, "workflow"), {
    status: 503,
    code: "workflow_unavailable",
    message: "This workflow is restarting. Your $0.05 was refunded. Try again in a moment.",
    retryAfterSeconds: 5,
    refundedCents: 5,
  });
  assert.deepEqual(failureRefusal({ code: "client_gone", ...FAILURE }, 5n, "workflow"), { ...CLIENT_GONE_REFUSAL, refundedCents: 5 });
});

test("a refused charge with no thing named is the agent's refusal, and a workflow's carries the workflow's codes", () => {
  const own = { ok: false as const, reason: "own_agent" as const, status: 409 as const, code: "own_agent" as const, message: "x" };
  assert.deepEqual(chargeRefusal(own, NOW, true, null, false), {
    status: 409,
    code: "own_agent",
    message: "This is your agent. This is the page people who pay see.",
  });
  assert.deepEqual(chargeRefusal({ ok: false, reason: "plan_changed" }, NOW, true, "plan-1", false), UNAVAILABLE);
  assert.deepEqual(UNAVAILABLE, {
    status: 503,
    code: "agent_unavailable",
    message: "This agent cannot be used right now. Nothing was charged. Try again later.",
  });

  assert.deepEqual(chargeRefusal(own, NOW, true, null, false, "workflow"), {
    status: 409,
    code: "own_workflow",
    message: "This is your workflow. This is the page people who pay see.",
  });
  assert.deepEqual(chargeRefusal({ ok: false, reason: "plan_changed" }, NOW, true, "plan-1", false, "workflow"), {
    status: 503,
    code: "workflow_unavailable",
    message: "This workflow cannot be run right now. Nothing was charged. Try again later.",
  });

  // What names nothing is the same for both: a plan that is used up, credits, a key's cap.
  const usedUp = { ok: false as const, reason: "plan_used_up" as const, periodEnd: new Date("2026-11-01T00:00:00Z"), includedUses: 500, carriedUses: 0 };
  assert.deepEqual(chargeRefusal(usedUp, NOW, true, "plan-1", false, "workflow"), chargeRefusal(usedUp, NOW, true, "plan-1", false));
  assert.equal(chargeRefusal(usedUp, NOW, true, "plan-1", false).code, "plan_used_up");
  const short = {
    ok: false as const,
    reason: "insufficient_credits" as const,
    status: 402 as const,
    code: "insufficient_credits" as const,
    message: "You do not have enough credits for this run ($0.05). Nothing was charged. Add credits to continue.",
    requiredCents: 5n,
    balanceCents: 1n,
  };
  assert.deepEqual(chargeRefusal(short, NOW, true, null, false, "workflow"), chargeRefusal(short, NOW, true, null, false));
});

test("the refusals of a licence with no thing named are the agent's sentences, and a workflow's say workflow", () => {
  const base: UseBillingInput = { callerOrgId: BUYER_ORG, listing: LISTING, licence: null, sub: null, unit: "run" };
  const messageOf = (input: UseBillingInput) => {
    const billing = resolveUseBilling(input, NOW);
    assert.equal(billing.kind, "refused");
    return billing.kind === "refused" ? [billing.status, billing.code, billing.message] : [];
  };
  const raised = { ...LISTING, pricePerRequestCents: 9n };
  const cases: Array<{ input: UseBillingInput; agent: unknown[]; workflow: unknown[] }> = [
    {
      input: base,
      agent: [403, "use_not_started", "You have not started using this agent. Start on its page, or ask an owner or admin of your organization to start."],
      workflow: [403, "use_not_started", "You have not started using this workflow. Start on its page, or ask an owner or admin of your organization to start."],
    },
    {
      input: { ...base, callerOrgId: CREATOR_ORG },
      agent: [409, "own_agent", "This is your own agent, so there is nothing to pay for. Use it from your dashboard."],
      workflow: [409, "own_agent", "This is your own workflow, so there is nothing to pay for. Use it from your dashboard."],
    },
    {
      input: { ...base, listing: { ...LISTING, status: "archived" } },
      agent: [409, "not_for_sale", "Use of this agent is not for sale."],
      workflow: [409, "not_for_sale", "Use of this workflow is not for sale."],
    },
    {
      input: { ...base, listing: { ...LISTING, status: "archived" }, licence: LICENCE },
      agent: [409, "not_offered", "This agent is no longer offered. You will not be charged again."],
      workflow: [409, "not_offered", "This workflow is no longer offered. You will not be charged again."],
    },
    {
      // The price went up after the buyer agreed: the sentence names no thing.
      input: { ...base, listing: raised, licence: LICENCE },
      agent: [409, "pricing_changed", "The owner changed the price to $0.09 per run. You agreed to $0.05. Nothing is charged until you accept the new price."],
      workflow: [409, "pricing_changed", "The owner changed the price to $0.09 per run. You agreed to $0.05. Nothing is charged until you accept the new price."],
    },
    {
      // Sold per use now, to a buyer who agreed to a month.
      input: { ...base, licence: { ...LICENCE, acceptedPricingModel: "monthly", acceptedPricePerRequestCents: null } },
      agent: [409, "pricing_changed", "This agent is now sold per run ($0.05). Nothing is charged until you accept the new price."],
      workflow: [409, "pricing_changed", "This workflow is now sold per run ($0.05). Nothing is charged until you accept the new price."],
    },
  ];
  for (const c of cases) {
    assert.deepEqual(messageOf(c.input), c.agent);
    assert.deepEqual(messageOf({ ...c.input, thing: "agent" }), c.agent);
    assert.deepEqual(messageOf({ ...c.input, thing: "workflow" }), c.workflow);
  }
  // What is charged is decided the same way for both.
  const paying = { ...base, licence: LICENCE };
  assert.deepEqual(resolveUseBilling({ ...paying, thing: "workflow" }, NOW), resolveUseBilling(paying, NOW));
  assert.equal(resolveUseBilling(paying, NOW).kind, "billable");
});

test("the sentences of a workflow's paid run are the ones its buyer is promised, and none says nothing was charged after a charge", () => {
  const words = PAID_USE_MESSAGES.workflow;
  assert.equal(words.notFound, "This workflow was not found.");
  assert.equal(words.ownWorkflow, "This is your workflow. This is the page people who pay see.");
  assert.equal(words.unavailable, "This workflow cannot be run right now. Nothing was charged. Try again later.");
  assert.equal(words.busy, "This workflow is running as many times as it can right now. Nothing was charged. Try again in a minute.");
  assert.equal(
    words.busyAfterCharge(5n),
    "This workflow is running as many times as it can right now. Your $0.05 was refunded. Try again in a minute.",
  );
  assert.equal(words.busyAfterCharge(null), "This workflow is running as many times as it can right now. Try again in a minute.");
  assert.equal(words.runFailed(5n), "The workflow could not finish this run. Your $0.05 was refunded.");
  assert.equal(words.runFailed(null), "The workflow could not finish this run. Please try again.");
  assert.equal(words.runTimedOut(5n), "The workflow took too long and was stopped. Your $0.05 was refunded.");
  assert.equal(words.runTimedOut(null), "The workflow took too long and was stopped. Please try again.");
  for (const said of [words.busyAfterCharge(5n), words.busyAfterCharge(null), words.runFailed(5n), words.runFailed(null), words.runTimedOut(5n), words.runTimedOut(null), words.restartedMidway(5n)]) {
    assert.doesNotMatch(said, NOTHING_CHARGED);
    assert.doesNotMatch(said, /agent/i);
    assert.ok(!said.includes(String.fromCharCode(0x2014)));
  }
  // The agent's own sentences are where they were.
  assert.equal(PAID_USE_MESSAGES.notFound, "This agent was not found.");
  assert.equal(PAID_USE_MESSAGES.ownAgent, "This is your agent. This is the page people who pay see.");
  assert.equal(NOT_A_MEMBER.message, "You are no longer a member of this organization, so you cannot use this agent on its behalf.");
  assert.deepEqual(refused(NOT_A_MEMBER), { kind: "refused", refusal: NOT_A_MEMBER });
});

test("the list of codes holds the six of a paid run of a workflow, each once", () => {
  const added: PaidUseErrorCode[] = ["workflow_not_found", "own_workflow", "workflow_unavailable", "workflow_busy", "run_failed", "run_timed_out"];
  for (const code of added) assert.ok(PAID_USE_REFUSAL_CODES.includes(code), code);
  assert.equal(new Set(PAID_USE_REFUSAL_CODES).size, PAID_USE_REFUSAL_CODES.length);
  // The codes an agent's use always had are all still there.
  for (const code of ["agent_not_found", "own_agent", "agent_unavailable", "model_error", "plan_used_up", "rate_limited"] as const) {
    assert.ok(PAID_USE_REFUSAL_CODES.includes(code), code);
  }
});

// ============================================
// The model cost of a run of several calls
// ============================================

const INSTALL = {
  installId: "ins-1",
  listingId: "lst-1",
  listingTitle: "Support Bot",
  publisherId: CREATOR_ORG,
  buyerId: BUYER_ORG,
  pricePerRequestCents: 5n,
  kind: "use" as const,
};

/** One use charged, noted by `note`, and settled: what the tables hold after it. */
async function settledAfter(note: (binding: ReturnType<ReturnType<typeof paidMoneyTables>["beginUse"]>) => void) {
  const tables = paidMoneyTables();
  const binding = tables.beginUse({ agentId: AGENT.id, install: INSTALL, apiKeyId: null, unit: "run" });
  const begun = await binding.beginMetering({ agentId: AGENT.id, orgId: CREATOR_ORG });
  assert.ok(begun && begun.ok);
  note(binding);
  await begun.handle.settle();
  assert.deepEqual(tables.money.revenue.map((row) => row.status), ["settled"]);
  return {
    modelCostMicros: tables.money.useModelCostMicros,
    publisherPending: tables.money.publisherPending,
    creator: tables.money.revenue[0]!.creator,
    platformFee: tables.money.revenue[0]!.platformFee,
    balance: tables.money.balance,
  };
}

test("a settle after a ready sum takes the same model cost as a noted call does for the same usage, and nothing for none", async () => {
  const usage = { inputTokens: 100_000, outputTokens: 50_000 };
  const noted = await settledAfter((binding) => binding.noteRun({ platformModel: true, usage, content: "x", promptChars: 10 }));
  const summed = await settledAfter((binding) => binding.notePlatformUsage(usage));
  assert.deepEqual(summed, noted);
  // 100,000 at 15 and 50,000 at 60 cents a million: four whole cents leave the creator's amount.
  assert.equal(summed.modelCostMicros, 4_500_000n);
  assert.equal(summed.publisherPending, 0n);
  assert.equal(summed.balance, 495n);

  // No step ran on the platform's keys: nothing is taken, as for a call on the creator's own key.
  const none = await settledAfter((binding) => binding.notePlatformUsage(null));
  const ownKey = await settledAfter((binding) => binding.noteRun({ platformModel: false, usage, content: "x", promptChars: 10 }));
  assert.deepEqual(none, ownKey);
  assert.deepEqual([none.modelCostMicros, none.publisherPending, none.creator], [0n, 4n, 4n]);

  // The last note wins: a sum told after a call replaces it.
  const replaced = await settledAfter((binding) => {
    binding.noteRun({ platformModel: true, usage, content: "x", promptChars: 10 });
    binding.notePlatformUsage(null);
  });
  assert.deepEqual(replaced, none);
});

// ============================================
// The watched executor of a workflow's agent steps
// ============================================

test("the watcher passes every call through, collects the step agents' system prompts and sums what ran on the platform's keys", async () => {
  const calls: string[] = [];
  const executor = {
    loadAgent: async (agentId: string, orgId: string) => {
      calls.push(`load:${agentId}:${orgId}`);
      return agentId === "gone" ? null : { id: agentId, orgId, systemPrompt: agentId === "a2" ? null : `prompt of ${agentId}` };
    },
    runAgentChat: async (chat: { prompt: string; systemAddendum?: string }) => {
      calls.push(`chat:${chat.prompt}`);
      if (chat.prompt === "own key") return { content: "ok", usage: { inputTokens: 9, outputTokens: 9 }, platformModel: false };
      if (chat.prompt === "no count") return { content: "a".repeat(80), platformModel: true };
      return { content: "ok", usage: { inputTokens: 120, outputTokens: 30 }, platformModel: true };
    },
  } as unknown as WorkflowStepExecutor;

  const watched = watchWorkflowExecutor(executor);
  assert.equal(watched.platformUsage(), null);
  assert.deepEqual(watched.confidential(), []);

  assert.equal((await watched.executor.loadAgent("a1", "org-pub"))!.id, "a1");
  await watched.executor.loadAgent("a2", "org-pub");
  assert.equal(await watched.executor.loadAgent("gone", "org-pub"), null);
  // An agent that was not found adds nothing; one with no system prompt adds its null.
  assert.deepEqual(watched.confidential(), ["prompt of a1", null]);

  const chat = (prompt: string, systemAddendum?: string) =>
    watched.executor.runAgentChat({ prompt, ...(systemAddendum !== undefined && { systemAddendum }) } as never);
  await chat("own key");
  assert.equal(watched.platformUsage(), null);
  assert.equal((await chat("first")).content, "ok");
  await chat("second");
  assert.deepEqual(watched.platformUsage(), { inputTokens: 240, outputTokens: 60 });
  // A provider that reports no count is estimated from the prompt and the rules sent with it.
  await chat("no count", "x".repeat(32));
  assert.deepEqual(watched.platformUsage(), { inputTokens: 240 + 10, outputTokens: 60 + 20 });
  assert.deepEqual(platformUsageOf({ content: "a".repeat(80), platformModel: true }, 40), { inputTokens: 10, outputTokens: 20 });

  assert.deepEqual(calls, [
    "load:a1:org-pub",
    "load:a2:org-pub",
    "load:gone:org-pub",
    "chat:own key",
    "chat:first",
    "chat:second",
    "chat:no count",
  ]);

  // One watcher for one run: a second one starts from nothing.
  assert.equal(watchWorkflowExecutor(executor).platformUsage(), null);
});
