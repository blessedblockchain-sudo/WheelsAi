import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type preHandlerAsyncHookHandler } from "fastify";

import { createPaidUseRoutes } from "../routes/paidUse.js";
import { AGENT_PAUSED_MESSAGE } from "../services/listingPause.js";
import { getUseAccess, PAID_USE_MESSAGES, runPaidChat, runPaidTask } from "../services/paidUse.js";
import { paidListingPausedNow } from "../services/paidUsePause.js";
import {
  AGENT,
  CREATOR_ORG,
  HANDLE,
  LISTING,
  MONTHLY_LICENCE,
  MONTHLY_LISTING,
  PAID_MONTH,
  paidHarness,
  SESSION,
  TASK_FORM,
  type PaidHarnessOptions,
} from "./paidUseHarness.js";

// A paid use of an agent whose listing is paused: the model the agent runs
// on, one its organization runs itself, is not running. What these pin:
// nothing is charged, the buyer reads the pause in its own sentence and
// never the core's, the access view says `paused` from a question asked at
// the moment, and a listing on a free model is never asked about.

const HOSTED = "wheelsai/llama-3.1-8b";
const CHAT = { messages: [{ role: "user", content: "Hi, I am Ada." }], stream: false };
const signal = () => new AbortController().signal;

test("the buyer's sentence for a pause is the one the listing rules give, word for word", () => {
  assert.equal(PAID_USE_MESSAGES.paused, AGENT_PAUSED_MESSAGE);
  assert.equal(AGENT_PAUSED_MESSAGE, "This agent is paused right now. Nothing was charged.");
});

test("a paid message to an agent whose own model is not running: 503 agent_paused, and nothing is charged", async () => {
  const h = paidHarness({ model: HOSTED, hostedModelDown: true });
  const result = await runPaidChat({ caller: SESSION, handle: HANDLE, body: CHAT, signal: signal() }, h.deps);

  assert.ok(result.kind === "refused");
  assert.deepEqual(result.refusal, {
    status: 503,
    code: "agent_paused",
    message: "This agent is paused right now. Nothing was charged.",
  });
  // The model was asked for and refused; no charge, no model call, no row.
  assert.ok(h.log.includes("core:hostedModel"));
  assert.ok(!h.log.includes("charge"));
  assert.ok(!h.log.includes("model"));
  assert.equal(h.money.balance, 500n);
  assert.deepEqual(h.money.ledger, []);
  assert.deepEqual(h.money.revenue, []);
  // The core's own words name the model and what its owner can do.
  assert.doesNotMatch(JSON.stringify(result.refusal), /deploy|llama|running deployment/i);
});

test("a paid run and a subscriber's message are refused the same way, with no charge", async () => {
  const task = paidHarness({
    model: HOSTED,
    hostedModelDown: true,
    agent: { agentKind: "task", kindConfig: TASK_FORM },
  });
  const run = await runPaidTask(
    { caller: SESSION, handle: HANDLE, body: { input: { topic: "Launch plan" }, stream: false }, signal: signal() },
    task.deps,
  );
  assert.ok(run.kind === "refused");
  assert.deepEqual([run.refusal.status, run.refusal.code], [503, "agent_paused"]);
  assert.equal(task.money.balance, 500n);

  const monthly = paidHarness({
    model: HOSTED,
    hostedModelDown: true,
    listing: MONTHLY_LISTING,
    licence: MONTHLY_LICENCE,
    sub: PAID_MONTH,
  });
  const message = await runPaidChat({ caller: SESSION, handle: HANDLE, body: CHAT, signal: signal() }, monthly.deps);
  assert.ok(message.kind === "refused");
  assert.equal(message.refusal.message, "This agent is paused right now. Nothing was charged.");
  assert.deepEqual(monthly.money.ledger, []);
});

test("a month still running on a listing that was taken down is not a pause: the general refusal, and nothing is charged", async () => {
  // Only a published listing that sells use can be paused. The buyer's month
  // outlives the listing; the model not running is then just "unavailable".
  for (const listing of [
    { ...MONTHLY_LISTING, status: "archived" },
    { ...MONTHLY_LISTING, sells: "copies" },
  ]) {
    const h = paidHarness({ model: HOSTED, hostedModelDown: true, listing, licence: MONTHLY_LICENCE, sub: PAID_MONTH });
    const result = await runPaidChat({ caller: SESSION, handle: HANDLE, body: CHAT, signal: signal() }, h.deps);
    assert.ok(result.kind === "refused");
    // The refusal is the model's, not an earlier one: the model was asked for.
    assert.ok(h.log.includes("core:hostedModel"), JSON.stringify(result.refusal));
    assert.deepEqual(result.refusal, {
      status: 503,
      code: "agent_unavailable",
      message: "This agent cannot be used right now. Nothing was charged. Try again later.",
    });
    assert.deepEqual(h.money.ledger, []);
  }
});

test("the general refusal stays what it was: only a model that is not running reads as a pause", async () => {
  // An agent that answers through its graph cannot answer a paid use.
  const h = paidHarness({ agent: { entrypoint: "graph" } });
  const result = await runPaidChat({ caller: SESSION, handle: HANDLE, body: CHAT, signal: signal() }, h.deps);
  assert.ok(result.kind === "refused");
  assert.deepEqual([result.refusal.status, result.refusal.code], [503, "agent_unavailable"]);
  assert.equal(result.refusal.message, "This agent cannot be used right now. Nothing was charged. Try again later.");
});

// ============================================
// The access view
// ============================================

async function viewOf(options: PaidHarnessOptions) {
  const h = paidHarness(options);
  const asked: unknown[] = [];
  const answer = h.deps.listingPaused!;
  h.deps.listingPaused = async (args) => {
    asked.push(args);
    return answer(args);
  };
  const result = await getUseAccess({ caller: SESSION, handle: HANDLE }, h.deps);
  assert.ok(result.kind === "access");
  return { view: result.view, asked };
}

test("the access view says paused when the listing is, and its other fields stay what they are", async () => {
  const running = await viewOf({ paused: false });
  const paused = await viewOf({ paused: true });
  assert.equal(running.view.paused, false);
  assert.equal(paused.view.paused, true);
  assert.deepEqual({ ...paused.view, paused: false }, running.view);

  // Asked about this listing and this agent, by its organization.
  assert.deepEqual(paused.asked, [{ listing: LISTING, agent: { id: AGENT.id, orgId: CREATOR_ORG } }]);
});

test("a listing that does not sell use now is not asked about and is never paused", async () => {
  for (const listing of [
    { ...LISTING, status: "archived" },
    { ...LISTING, sells: "copies" },
  ]) {
    const { view, asked } = await viewOf({ listing, paused: true });
    assert.equal(view.paused, false);
    assert.deepEqual(asked, []);
  }
});

test("when the pause cannot be asked about the view still answers, as not paused", async () => {
  const { view } = await viewOf({ paused: new Error("database is down") });
  assert.equal(view.paused, false);
  assert.equal(view.access, "listing_pricing");
});

test("GET /a/:handle/access carries paused", async () => {
  const h = paidHarness({ paused: true });
  const app = Fastify();
  const auth: preHandlerAsyncHookHandler = async (request) => {
    (request as { auth: unknown }).auth = SESSION;
  };
  await app.register(createPaidUseRoutes({ guards: { auth, use: auth }, paidUse: () => h.deps }), { prefix: "/api" });
  try {
    const res = await app.inject({ method: "GET", url: `/api/a/${HANDLE}/access` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().paused, true);
  } finally {
    await app.close();
  }
});

test("POST /a/:handle/chat on a paused agent answers 503 agent_paused with its sentence", async () => {
  const h = paidHarness({ model: HOSTED, hostedModelDown: true });
  const app = Fastify();
  const auth: preHandlerAsyncHookHandler = async (request) => {
    (request as { auth: unknown }).auth = SESSION;
  };
  await app.register(createPaidUseRoutes({ guards: { auth, use: auth }, paidUse: () => h.deps }), { prefix: "/api" });
  try {
    const res = await app.inject({ method: "POST", url: `/api/a/${HANDLE}/chat`, payload: CHAT });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), {
      error: "agent_paused",
      message: "This agent is paused right now. Nothing was charged.",
    });
    assert.equal(h.money.balance, 500n);
  } finally {
    await app.close();
  }
});

// ============================================
// The production reading (services/paidUsePause.ts)
// ============================================

const ON_SALE = { status: "published", sells: "use" };
const CREATOR_AGENT = { id: "agent-1", orgId: CREATOR_ORG };

function reading(modelConfig: unknown, hosted: { ok: boolean } | Error = { ok: false }) {
  const reads: string[] = [];
  const resolved: Array<{ orgId: string; modelId: string }> = [];
  return {
    reads,
    resolved,
    deps: {
      loadModelConfig: async (agentId: string) => {
        reads.push(agentId);
        return modelConfig;
      },
      resolveHostedModel: async (args: { orgId: string; modelId: string }) => {
        resolved.push(args);
        if (hosted instanceof Error) throw hosted;
        return hosted;
      },
    },
  };
}

test("paused is asked of the model the agent is set to, in its own organization, at the moment", async () => {
  const down = reading({ externalModel: HOSTED });
  assert.equal(await paidListingPausedNow({ listing: ON_SALE, agent: CREATOR_AGENT }, down.deps), true);
  assert.deepEqual(down.reads, ["agent-1"]);
  assert.deepEqual(down.resolved, [{ orgId: CREATOR_ORG, modelId: HOSTED }]);

  const up = reading({ externalModel: HOSTED }, { ok: true });
  assert.equal(await paidListingPausedNow({ listing: ON_SALE, agent: CREATOR_AGENT }, up.deps), false);
});

test("an agent on a free model or its own key is never asked about", async () => {
  for (const modelConfig of [
    { externalModel: "free/groq/llama-3.3-70b" },
    { externalModel: "openai/gpt-4o-mini" },
    { model: "openai/gpt-4o-mini" },
    {},
    null,
  ]) {
    const r = reading(modelConfig);
    assert.equal(await paidListingPausedNow({ listing: ON_SALE, agent: CREATOR_AGENT }, r.deps), false);
    assert.deepEqual(r.resolved, [], JSON.stringify(modelConfig));
  }
});

test("a listing that is not on sale for use costs no read at all", async () => {
  for (const listing of [
    { status: "draft", sells: "use" },
    { status: "archived", sells: "use" },
    { status: "published", sells: "copies" },
  ]) {
    const r = reading({ externalModel: HOSTED });
    assert.equal(await paidListingPausedNow({ listing, agent: CREATOR_AGENT }, r.deps), false);
    assert.deepEqual([r.reads, r.resolved], [[], []]);
  }
});

test("a question that cannot be answered throws: the caller decides what an unknown means", async () => {
  const r = reading({ externalModel: HOSTED }, new Error("database is down"));
  await assert.rejects(paidListingPausedNow({ listing: ON_SALE, agent: CREATOR_AGENT }, r.deps), /database is down/);
});
