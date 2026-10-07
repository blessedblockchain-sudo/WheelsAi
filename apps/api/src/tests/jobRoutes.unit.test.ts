import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { createJobRoutes } from "../routes/jobs.js";
import { createOfferingRoutes } from "../routes/offerings.js";
import { startJob, submitJob } from "../services/jobEscrow.js";
import { MAX_MATCH_STEPS } from "../services/safeRegex.js";
import {
  createOffering,
  createOfferingSchema,
  offeringTerms,
  setOfferingStatus,
  updateOffering,
} from "../services/offerings.js";
import {
  AGENT,
  as,
  BUYER,
  installTestAuth,
  makeMarket,
  member,
  OTHER,
  owner,
  PUB,
  T0,
  testGuards,
  VALID_OFFERING,
  WORKFLOW,
  type Market,
} from "./jobsApiFakes.js";

// Drives hiring (routes/offerings.ts) and routes/jobs.ts over the in-memory
// market: the real services, the real escrow core, the production guards.

const HOUR = 60 * 60 * 1000;
const INPUT = { input: { url: "https://example.com" } };
const KEY = "key_hire";

async function build(market: Market = makeMarket()) {
  market.db.state.apiKeys.set(KEY, { orgId: BUYER, maxJobPriceCents: 5_000n, dailySpendCapCents: 5_000n });
  const app = Fastify();
  installTestAuth(app);
  const guards = testGuards();
  await app.register(
    createOfferingRoutes({
      offerings: market.offerings,
      jobs: market.jobs,
      testRun: { tryProduct: async () => ({ passed: true, output: null, checkResults: [] }), maxRunMs: 1, freeTierLimitMessage: "" },
      guards,
    }),
    { prefix: "/api/offerings" },
  );
  await app.register(createJobRoutes({ jobs: market.jobs, guards }), { prefix: "/api/jobs" });

  const publish = async (body: Record<string, unknown> = {}) => {
    const offering = await createOffering(market.offerings, PUB, createOfferingSchema.parse({ ...VALID_OFFERING, ...body }));
    await setOfferingStatus(market.offerings, PUB, offering.id, "activate");
    return offering;
  };
  const offering = await publish();
  /**
   * Hires with the terms the offering has at that moment, as the hire panel
   * does. A payload that names `expected` itself (even as undefined, which
   * sends none) is sent as written.
   */
  const hire = async (headers = owner(BUYER), payload: unknown = INPUT, extra: Record<string, string> = {}, id = offering.id) => {
    const current = await market.offerings.store.findById(id);
    const body =
      current && typeof payload === "object" && payload !== null && !("expected" in payload)
        ? { ...payload, expected: offeringTerms(current) }
        : payload;
    return app.inject({ method: "POST", url: `/api/offerings/${id}/hire`, headers: { ...headers, ...extra }, payload: body as object });
  };
  const post = (jobId: string, action: string, headers: Record<string, string>, payload?: object) =>
    app.inject({ method: "POST", url: `/api/jobs/${jobId}/${action}`, headers, payload });
  /** Hires a job and takes it to `submitted`, as the runner would. */
  const delivered = async () => {
    const jobId = (await hire()).json().job.id as string;
    await market.db.inTransaction((tx) => startJob(tx, { jobId, now: new Date(T0.getTime() + 60_000) }));
    await market.db.inTransaction((tx) =>
      submitJob(tx, {
        jobId,
        output: { format: "text", text: "the competitor report" },
        checkResults: [{ type: "contains", label: 'Contains "competitor"', passed: true, details: "found" }],
        now: new Date(T0.getTime() + 120_000),
      }),
    );
    return jobId;
  };
  return { app, market, offering, publish, hire, post, delivered };
}

const balance = (market: Market) => market.db.state.balances.get(BUYER);

// ============================================
// Hire
// ============================================

test("hiring answers 201 with a funded job, the price held in escrow, and queues the run after the commit", async () => {
  const { market, hire, offering } = await build();
  const res = await hire();

  assert.equal(res.statusCode, 201);
  const { job } = res.json();
  assert.equal(job.status, "funded");
  assert.equal(job.priceCents, 2_000);
  assert.deepEqual(job.escrow, { status: "held", amountCents: 2_000 });
  assert.equal(job.output, null);
  assert.equal(job.offering.id, offering.id);
  assert.equal(job.deadlineAt, new Date(T0.getTime() + HOUR).toISOString());
  assert.equal(balance(market), 98_000n);
  assert.equal(market.db.state.ledger.length, 1);
  // The run was queued, and the publisher told, for the job that committed.
  assert.deepEqual(market.queued, [job.id]);
  assert.deepEqual(market.events, [["job.funded", job.id]]);
  assert.equal(market.db.job(job.id).hiredByUserId, "user_owner");
  assert.ok(!res.body.includes("scoring rubric"));
});

test("a queue that is down does not fail the hire: the job is funded and the sweeper will queue it", async () => {
  const { market, hire } = await build();
  const failed: string[] = [];
  market.jobs.enqueue = async () => {
    throw new Error("ECONNREFUSED");
  };
  market.jobs.onEnqueueError = (jobId) => failed.push(jobId);
  const res = await hire();
  assert.equal(res.statusCode, 201);
  assert.deepEqual(failed, [res.json().job.id]);
  assert.equal(market.db.job(res.json().job.id).status, "funded");
});

test("a repeated Idempotency-Key returns the same job with 200 and charges nothing more", async () => {
  const { market, hire, publish } = await build();
  const first = await hire(owner(BUYER), INPUT, { "idempotency-key": "order-42" });
  const second = await hire(owner(BUYER), INPUT, { "idempotency-key": "order-42" });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().job.id, first.json().job.id);
  assert.equal(market.db.state.jobs.size, 1);
  assert.equal(balance(market), 98_000n);
  assert.deepEqual(market.queued, [first.json().job.id]);

  // The same key on a different offering is a client bug, not a replay.
  const other = await publish({ title: "A different task" });
  const reused = await hire(owner(BUYER), INPUT, { "idempotency-key": "order-42" }, other.id);
  assert.deepEqual([reused.statusCode, reused.json().error], [409, "idempotency_key_reused"]);
  // Another buyer's use of the same key is their own.
  market.db.state.balances.set(OTHER, 50_000n);
  assert.equal((await hire(owner(OTHER), INPUT, { "idempotency-key": "order-42" })).statusCode, 201);

  const long = await hire(owner(BUYER), INPUT, { "idempotency-key": "k".repeat(101) });
  assert.equal(long.statusCode, 400);
});

test("two hires racing on one Idempotency-Key make one job and one charge", async () => {
  const { market, hire } = await build();
  // Both pass the lookup before either inserts; the unique key decides.
  const real = market.jobs.store.findByIdempotencyKey;
  let lookups = 0;
  market.jobs.store.findByIdempotencyKey = async (buyerId, key) => (++lookups <= 2 ? null : real(buyerId, key));

  const [a, b] = await Promise.all([
    hire(owner(BUYER), INPUT, { "idempotency-key": "race" }),
    hire(owner(BUYER), INPUT, { "idempotency-key": "race" }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 201]);
  assert.equal(a.json().job.id, b.json().job.id);
  assert.equal(market.db.state.jobs.size, 1);
  assert.equal(balance(market), 98_000n);
  assert.equal(market.db.state.ledger.length, 1);
});

test("a buyer who cannot pay gets 402 with what is needed, and no job", async () => {
  const { market, hire } = await build(makeMarket({ balance: 1_500n }));
  const res = await hire();
  assert.equal(res.statusCode, 402);
  assert.deepEqual(
    [res.json().error, res.json().requiredCents, res.json().balanceCents],
    ["insufficient_credits", 2_000, 1_500],
  );
  assert.equal(market.db.state.jobs.size, 0);
  assert.equal(balance(market), 1_500n);
  assert.deepEqual(market.queued, []);
});

test("input that does not match the offering's schema is a 422 naming the field, and nothing is charged", async () => {
  const { market, hire } = await build();
  const missing = await hire(owner(BUYER), { input: { depth: 2 } });
  assert.deepEqual([missing.statusCode, missing.json().error], [422, "input_invalid"]);
  assert.deepEqual(missing.json().errors[0], { path: "/url", message: "is required" });

  const extra = await hire(owner(BUYER), { input: { url: "https://example.com", note: "x" } });
  assert.equal(extra.statusCode, 422);
  const notObject = await hire(owner(BUYER), { input: "do the thing" });
  assert.equal(notObject.statusCode, 400);
  assert.equal(balance(market), 100_000n);
  assert.equal(market.db.state.jobs.size, 0);
});

test("a workflow offering also checks the input against the workflow's own schema at hire", async () => {
  const { market, hire, publish } = await build();
  market.workflows.get(WORKFLOW)!.inputSchema = {
    type: "object",
    required: ["url", "prompt"],
    properties: { url: { type: "string" }, prompt: { type: "string" }, depth: { type: "integer", maximum: 1 } },
  };
  const { agentId: _agent, ...base } = VALID_OFFERING;
  const offering = await publish({ ...base, productKind: "workflow", orchestrationId: WORKFLOW, title: "Workflow task" });

  // The rendered brief supplies `prompt`, so this matches.
  assert.equal((await hire(owner(BUYER), INPUT, {}, offering.id)).statusCode, 201);
  const refused = await hire(owner(BUYER), { input: { url: "https://example.com", depth: 3 } }, {}, offering.id);
  assert.deepEqual([refused.statusCode, refused.json().error], [422, "input_invalid"]);
  assert.equal(market.db.state.jobs.size, 1);
});

test("an offering that is not active, or does not exist, is a 404; one's own is a 409", async () => {
  const { app, market, hire, offering } = await build();
  const own = await hire(owner(PUB));
  assert.deepEqual([own.statusCode, own.json().error], [409, "own_offering"]);

  await app.inject({ method: "POST", url: `/api/offerings/${offering.id}/pause`, headers: owner(PUB) });
  const paused = await hire();
  assert.deepEqual([paused.statusCode, paused.json().error], [404, "offering_not_found"]);
  const missing = await hire(owner(BUYER), INPUT, {}, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.equal(missing.statusCode, 404);
  assert.equal(market.db.state.jobs.size, 0);
});

test("an offering whose product is gone cannot be hired, and stops being offered", async () => {
  const { market, hire, offering } = await build();
  market.agents.delete(AGENT);
  const res = await hire();
  assert.deepEqual([res.statusCode, res.json().error], [409, "offering_unavailable"]);
  assert.equal(market.offeringRow(offering.id).status, "paused");
  assert.equal(balance(market), 100_000n);
});

test("an offering at its capacity refuses the next hire without charging", async () => {
  const { market, hire, publish } = await build();
  const single = await publish({ title: "One at a time", maxConcurrentJobs: 1 });
  assert.equal((await hire(owner(BUYER), INPUT, {}, single.id)).statusCode, 201);
  const full = await hire(owner(BUYER), INPUT, {}, single.id);
  assert.deepEqual([full.statusCode, full.json().error], [409, "offering_at_capacity"]);
  assert.equal(balance(market), 98_000n);
});

test("from the dashboard only an owner or admin may hire", async () => {
  const { market, hire } = await build();
  const refused = await hire(member(BUYER));
  assert.deepEqual([refused.statusCode, refused.json().error], [403, "insufficient_role"]);
  assert.equal((await hire(as({ type: "jwt", orgId: BUYER, userId: "user_admin" }))).statusCode, 201);
  assert.equal((await hire(as({ type: "jwt", orgId: BUYER, userId: "user_removed" }))).statusCode, 403);
  assert.equal(market.db.state.jobs.size, 1);
  assert.equal((await hire({})).statusCode, 401);
});

test("an API key hires only with jobs:hire granted by name, and within its caps", async () => {
  const { market, hire, publish } = await build();
  for (const scopes of [[], ["*"], ["jobs:read", "jobs:review"]]) {
    const res = await hire(as({ type: "api_key", orgId: BUYER, scopes, apiKeyId: KEY }));
    assert.deepEqual([res.statusCode, res.json().error], [403, "missing_scope"], JSON.stringify(scopes));
  }
  assert.equal(market.db.state.jobs.size, 0);

  const key = as({ type: "api_key", orgId: BUYER, scopes: ["jobs:hire"], apiKeyId: KEY });
  const first = await hire(key);
  assert.equal(first.statusCode, 201);
  assert.equal(market.db.job(first.json().job.id).hiredByApiKeyId, KEY);
  assert.equal(market.db.job(first.json().job.id).hiredByUserId, undefined);
  assert.equal((await hire(key)).statusCode, 201);

  // 4,000 of the day's 5,000 are spent: a third 2,000 job would pass it.
  const capped = await hire(key);
  assert.deepEqual([capped.statusCode, capped.json().error], [403, "api_key_daily_cap_exceeded"]);
  assert.equal(balance(market), 96_000n);

  const pricey = await publish({ title: "Deep research", priceCents: 6_000 });
  const tooMuch = await hire(key, INPUT, {}, pricey.id);
  assert.deepEqual([tooMuch.statusCode, tooMuch.json().error], [403, "api_key_job_price_cap_exceeded"]);

  // A key with the scope but no caps on record cannot spend at all.
  const uncapped = await hire(as({ type: "api_key", orgId: BUYER, scopes: ["jobs:hire"], apiKeyId: "key_unknown" }));
  assert.deepEqual([uncapped.statusCode, uncapped.json().error], [403, "api_key_spend_caps_missing"]);
  assert.equal(market.db.state.jobs.size, 2);
});

// ============================================
// The terms the buyer saw
// ============================================

test("a hire is held to the terms the buyer saw: a changed price, delivery time or checks is a 409 with the current terms, before any money moves", async () => {
  const { app, market, offering } = await build();
  const send = (expected: unknown, headers = owner(BUYER)) =>
    app.inject({ method: "POST", url: `/api/offerings/${offering.id}/hire`, headers, payload: { ...INPUT, expected } });
  const termsNow = async () => offeringTerms((await market.offerings.store.findById(offering.id))!);

  // The buyer opens the page: $20.00, one hour, one check.
  const seen = await termsNow();
  assert.deepEqual([seen.priceCents, seen.slaSeconds], [2_000, 3_600]);

  // The review's sequence: the offering stays active while its publisher
  // raises the price fifty-fold and removes the checks.
  await updateOffering(market.offerings, PUB, offering.id, { priceCents: 100_000, deliverableChecks: [] });
  const raised = await send(seen);
  assert.equal(raised.statusCode, 409);
  assert.equal(raised.json().error, "offering_terms_changed");
  assert.deepEqual(raised.json().changed, ["priceCents", "termsVersion"]);
  assert.deepEqual(raised.json().current, await termsNow());
  assert.equal(raised.json().current.priceCents, 100_000);
  // The buyer could have paid it, and did not.
  assert.equal(balance(market), 100_000n);
  assert.equal(market.db.state.jobs.size, 0);
  assert.equal(market.db.state.ledger.length, 0);
  assert.deepEqual(market.queued, []);

  // Each of the other things a buyer agrees to, changed alone.
  const alone: Array<[Parameters<typeof updateOffering>[3], string[]]> = [
    [{ priceCents: 2_000, deliverableChecks: [{ type: "contains", value: "competitor" }] }, []],
    [{ slaSeconds: 7_200 }, ["slaSeconds", "termsVersion"]],
    [{ slaSeconds: 3_600, deliverableChecks: [] }, ["termsVersion"]],
    [{ deliverableChecks: [{ type: "contains", value: "competitor" }], instructions: "Do it quickly." }, ["termsVersion"]],
    [{ instructions: VALID_OFFERING.instructions, outputFormat: "json" }, ["termsVersion"]],
    [{ outputFormat: "text", description: "A different promise entirely, in the same place." }, ["termsVersion"]],
    [{ description: VALID_OFFERING.description, inputSchema: { type: "object" } }, ["termsVersion"]],
  ];
  for (const [patch, changed] of alone) {
    await updateOffering(market.offerings, PUB, offering.id, patch);
    if (changed.length === 0) {
      // Put back exactly as it was: the same terms, so the same version.
      assert.deepEqual(await termsNow(), seen);
      continue;
    }
    const res = await send(seen);
    assert.deepEqual([res.statusCode, res.json().error, res.json().changed], [409, "offering_terms_changed", changed], JSON.stringify(patch));
  }
  assert.equal(market.db.state.jobs.size, 0);
  assert.equal(balance(market), 100_000n);

  // Something a buyer does not agree to (how many jobs run at once) moves nothing.
  await updateOffering(market.offerings, PUB, offering.id, { inputSchema: VALID_OFFERING.inputSchema, maxConcurrentJobs: 2 });
  assert.deepEqual(await termsNow(), seen);

  // Shown the current terms, the buyer hires at exactly those.
  await updateOffering(market.offerings, PUB, offering.id, { priceCents: 2_500 });
  const current = await termsNow();
  const hired = await send(current);
  assert.equal(hired.statusCode, 201);
  assert.equal(hired.json().job.priceCents, 2_500);
  assert.equal(balance(market), 97_500n);
});

test("a dashboard hire must say which terms were agreed to; an API key may leave them out and is bounded by its cap", async () => {
  const { app, market, offering, hire } = await build();
  const terms = offeringTerms((await market.offerings.store.findById(offering.id))!);

  // A person: all three, or nothing is hired.
  for (const expected of [undefined, { priceCents: terms.priceCents }, { priceCents: terms.priceCents, slaSeconds: terms.slaSeconds }]) {
    const res = await hire(owner(BUYER), { ...INPUT, expected });
    assert.deepEqual([res.statusCode, res.json().error], [400, "expected_terms_required"], JSON.stringify(expected));
    assert.deepEqual(res.json().current, terms);
  }
  const malformed = await hire(owner(BUYER), { ...INPUT, expected: { priceCents: "2000" } });
  assert.equal(malformed.statusCode, 400);
  assert.equal(market.db.state.jobs.size, 0);
  assert.equal(balance(market), 100_000n);

  // A key with no `expected` hires at the terms as they are...
  const key = as({ type: "api_key", orgId: BUYER, scopes: ["jobs:hire"], apiKeyId: KEY });
  const bare = await hire(key, { ...INPUT, expected: undefined });
  assert.equal(bare.statusCode, 201);
  assert.equal(bare.json().job.priceCents, 2_000);
  // ...and what a raised price can cost it is what its cap allows: nothing.
  await updateOffering(market.offerings, PUB, offering.id, { priceCents: 100_000 });
  const capped = await hire(key, { ...INPUT, expected: undefined });
  assert.deepEqual([capped.statusCode, capped.json().error], [403, "api_key_job_price_cap_exceeded"]);
  // Whatever a key does send is held to, each part by itself.
  const held = await hire(key, { ...INPUT, expected: { priceCents: 2_000 } });
  assert.deepEqual([held.statusCode, held.json().error, held.json().changed], [409, "offering_terms_changed", ["priceCents"]]);
  await updateOffering(market.offerings, PUB, offering.id, { priceCents: 2_000, slaSeconds: 7_200 });
  assert.equal((await hire(key, { ...INPUT, expected: { priceCents: 2_000 } })).statusCode, 201);
  const sla = await hire(key, { ...INPUT, expected: { priceCents: 2_000, slaSeconds: 3_600 } });
  assert.deepEqual([sla.statusCode, sla.json().changed], [409, ["slaSeconds"]]);
  assert.equal(market.db.state.jobs.size, 2);
  assert.equal(balance(market), 96_000n);
  void app;
});

test("a repeated Idempotency-Key is answered with the first job even after the offering changed", async () => {
  const { market, offering, hire } = await build();
  const first = await hire(owner(BUYER), INPUT, { "idempotency-key": "order-7" });
  assert.equal(first.statusCode, 201);
  const seen = first.json().job.priceCents;
  await updateOffering(market.offerings, PUB, offering.id, { priceCents: 9_000 });
  // The retry still carries the terms of the first attempt: it is that job.
  const retry = await hire(
    owner(BUYER),
    { ...INPUT, expected: { priceCents: seen, slaSeconds: 3_600, termsVersion: "the-version-it-saw" } },
    { "idempotency-key": "order-7" },
  );
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().job.id, first.json().job.id);
  assert.equal(balance(market), 98_000n);
});

test("input that would cost more than one validation may is a 422 of its own, and nothing is charged", async () => {
  const { market, hire, publish } = await build();
  // Each pattern is inside the per-match limit on each of these strings;
  // together they ran for over a second before a validation had a budget.
  const patterns = Array.from({ length: 5 }, (_, i) => ({ pattern: `[a-z]{${1000 - i}}$` }));
  const offering = await publish({
    title: "Pattern heavy",
    inputSchema: { type: "object", properties: { xs: { type: "array", items: { type: "string", allOf: patterns } } } },
    sampleInputs: [],
  });
  const length = Math.floor(MAX_MATCH_STEPS / 1010);
  const start = performance.now();
  const res = await hire(owner(BUYER), { input: { xs: Array.from({ length: 4 }, () => "a".repeat(length)) } }, {}, offering.id);
  const ms = performance.now() - start;
  assert.deepEqual([res.statusCode, res.json().error], [422, "validation_too_expensive"]);
  assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
  assert.equal(balance(market), 100_000n);
  assert.equal(market.db.state.jobs.size, 0);
  // Input the same schema can be checked against is hired.
  assert.equal((await hire(owner(BUYER), { input: { xs: [] } }, {}, offering.id)).statusCode, 201);
});

// ============================================
// Read
// ============================================

test("a job is its buyer's and its publisher's, each with their own view; to anyone else it does not exist", async () => {
  const { app, delivered } = await build();
  const jobId = await delivered();
  const get = (headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers });

  const buyer = (await get(owner(BUYER))).json().job;
  assert.equal(buyer.role, "buyer");
  assert.deepEqual(buyer.output, { format: "text", text: "the competitor report" });
  assert.deepEqual(buyer.checks, [{ label: 'Contains "competitor"', type: "contains", passed: true }]);
  assert.equal("checkResults" in buyer, false);
  assert.equal("creatorAmountCents" in buyer, false);

  const publisher = (await get(member(PUB))).json().job;
  assert.equal(publisher.role, "publisher");
  assert.equal(publisher.creatorAmountCents, 1_800);
  assert.equal(publisher.checkResults[0].details, "found");
  assert.equal(publisher.buyer.orgId, BUYER);

  const stranger = await get(owner(OTHER));
  assert.deepEqual([stranger.statusCode, stranger.json().error], [404, "job_not_found"]);
  const missing = await app.inject({ method: "GET", url: "/api/jobs/dddddddd-dddd-4ddd-8ddd-dddddddddddd", headers: owner(BUYER) });
  assert.equal(missing.statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/jobs/${jobId}` })).statusCode, 401);
  for (const res of [await get(owner(BUYER)), await get(member(PUB))]) {
    assert.ok(!res.body.includes("scoring rubric"));
  }
});

test("the buyer sees no output until the job is submitted", async () => {
  const { app, market, hire } = await build();
  const jobId = (await hire()).json().job.id as string;
  await market.db.inTransaction((tx) => startJob(tx, { jobId, now: new Date(T0.getTime() + 60_000) }));
  // A draft the runner recorded on a failed attempt.
  market.db.job(jobId).output = { format: "text", text: "half a draft" };

  const buyer = await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: owner(BUYER) });
  assert.equal(buyer.json().job.status, "running");
  assert.equal(buyer.json().job.output, null);
  const publisher = await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: owner(PUB) });
  assert.deepEqual(publisher.json().job.output, { format: "text", text: "half a draft" });
});

test("the list is the caller's own jobs by role, and the summary counts what is waiting", async () => {
  const { app, hire, delivered } = await build();
  await delivered();
  await hire();
  const list = (query: string, headers: Record<string, string>) =>
    app.inject({ method: "GET", url: `/api/jobs?${query}`, headers });

  assert.equal((await list("role=buyer", owner(BUYER))).json().jobs.length, 2);
  assert.equal((await list("role=buyer&status=submitted", owner(BUYER))).json().jobs.length, 1);
  assert.equal((await list("role=publisher", owner(BUYER))).json().jobs.length, 0);
  const received = (await list("role=publisher", member(PUB))).json();
  assert.equal(received.jobs.length, 2);
  assert.equal(received.jobs[0].role, "publisher");
  assert.equal((await list("role=buyer", owner(OTHER))).json().pagination.total, 0);
  assert.equal((await list("limit=500", owner(BUYER))).statusCode, 400);

  const summary = await app.inject({ method: "GET", url: "/api/jobs/summary", headers: owner(BUYER) });
  assert.deepEqual(summary.json(), { awaitingReview: 1, inProgress: 1, toDeliver: 0 });
  const publisher = await app.inject({ method: "GET", url: "/api/jobs/summary", headers: owner(PUB) });
  assert.deepEqual(publisher.json(), { awaitingReview: 0, inProgress: 0, toDeliver: 1 });

  // A key cut down to something else cannot read jobs; an unscoped one can.
  const scoped = await list("role=buyer", as({ type: "api_key", orgId: BUYER, scopes: ["agents:invoke"] }));
  assert.equal(scoped.statusCode, 403);
  assert.equal((await list("role=buyer", as({ type: "api_key", orgId: BUYER, scopes: [] }))).statusCode, 200);
});

// ============================================
// Accept / reject / cancel / rate
// ============================================

test("accepting releases the escrow to the publisher once, with the rating", async () => {
  const { market, post, delivered } = await build();
  const jobId = await delivered();
  const res = await post(jobId, "accept", owner(BUYER), { rating: 5, review: "Exactly what we needed." });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().job.status, "completed");
  assert.deepEqual(res.json().job.escrow, { status: "released", amountCents: 2_000 });
  assert.equal(res.json().job.rating, 5);
  assert.equal(market.db.state.accrued.get(PUB), 1_800n);
  assert.deepEqual(market.recalculated, [PUB]);
  assert.deepEqual(market.events.at(-1), ["job.completed", jobId]);

  const again = await post(jobId, "accept", owner(BUYER), {});
  assert.deepEqual([again.statusCode, again.json().error], [409, "job_state_conflict"]);
  assert.equal(market.db.state.accrued.get(PUB), 1_800n);
  assert.equal(balance(market), 98_000n);
});

test("an accept that finds no payout profile creates one and settles; the escrow is never released into nothing", async () => {
  const { market, post, delivered } = await build();
  const jobId = await delivered();
  market.db.state.profiles.clear();
  market.profilesEnsured.length = 0;

  const res = await post(jobId, "accept", owner(BUYER), {});
  assert.equal(res.statusCode, 200);
  assert.deepEqual(market.profilesEnsured, [PUB]);
  assert.equal(market.db.state.accrued.get(PUB), 1_800n);

  // And when a profile cannot be made, the answer is honest and the money stays held.
  const stuck = await build();
  const heldJob = await stuck.delivered();
  stuck.market.db.state.profiles.clear();
  stuck.market.jobs.ensurePublisherProfile = async () => {};
  const failed = await stuck.post(heldJob, "accept", owner(BUYER), {});
  assert.deepEqual([failed.statusCode, failed.json().error], [503, "settlement_unavailable"]);
  assert.equal(stuck.market.db.job(heldJob).status, "submitted");
  assert.equal(stuck.market.db.escrow(heldJob).status, "pending");
});

test("rejecting inside the review window refunds the buyer and counts as a dispute", async () => {
  const { market, post, delivered } = await build();
  const jobId = await delivered();
  const short = await post(jobId, "reject", owner(BUYER), { reason: "no" });
  assert.equal(short.statusCode, 400);

  const res = await post(jobId, "reject", owner(BUYER), { reason: "It covers the wrong company." });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().refundedCents, 2_000);
  assert.equal(res.json().job.status, "rejected");
  assert.equal(res.json().job.rejectionReason, "It covers the wrong company.");
  assert.equal(balance(market), 100_000n);
  assert.equal(market.db.state.accrued.size, 0);
  assert.deepEqual(market.disputes, [PUB]);
  assert.deepEqual(market.recalculated, [PUB]);
  assert.equal(market.refunds().length, 1);

  const again = await post(jobId, "reject", owner(BUYER), { reason: "Again, wrong." });
  assert.deepEqual([again.statusCode, again.json().error], [409, "job_state_conflict"]);
  assert.equal(market.refunds().length, 1);
});

test("after 72 hours the deliverable can no longer be rejected", async () => {
  const { market, post, delivered } = await build();
  const jobId = await delivered();
  market.clock.now = new Date(T0.getTime() + 73 * HOUR);
  const res = await post(jobId, "reject", owner(BUYER), { reason: "Too late to notice." });
  assert.deepEqual([res.statusCode, res.json().error], [409, "review_window_closed"]);
  assert.equal(market.db.escrow(jobId).status, "pending");
  assert.deepEqual(market.disputes, []);
});

test("a job can be cancelled for a full refund only before it starts", async () => {
  const { market, hire, post } = await build();
  const jobId = (await hire()).json().job.id as string;
  const res = await post(jobId, "cancel", owner(BUYER), { reason: "Changed my mind" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.json().job.status, res.json().refundedCents], ["cancelled", 2_000]);
  assert.equal(balance(market), 100_000n);
  assert.deepEqual(market.events.at(-1), ["job.cancelled", jobId]);

  const started = (await hire()).json().job.id as string;
  await market.db.inTransaction((tx) => startJob(tx, { jobId: started, now: new Date(T0.getTime() + 60_000) }));
  const late = await post(started, "cancel", owner(BUYER), {});
  assert.deepEqual([late.statusCode, late.json().error], [409, "job_already_started"]);
  assert.equal(balance(market), 98_000n);
});

test("accept, reject and cancel are the buyer's alone", async () => {
  const { market, hire, post, delivered } = await build();
  const jobId = await delivered();
  const funded = (await hire()).json().job.id as string;

  for (const [id, action, payload] of [
    [jobId, "accept", {}],
    [jobId, "reject", { reason: "Not what I asked for" }],
    [funded, "cancel", {}],
    [jobId, "rate", { rating: 5 }],
  ] as const) {
    // The publisher knows the job exists but is not its buyer.
    const publisher = await post(id, action, owner(PUB), payload);
    assert.deepEqual([publisher.statusCode, publisher.json().error], [403, "not_the_buyer"], action);
    const stranger = await post(id, action, owner(OTHER), payload);
    assert.deepEqual([stranger.statusCode, stranger.json().error], [404, "job_not_found"], action);
    assert.equal((await post(id, action, {}, payload)).statusCode, 401, action);
  }
  // A member of the buyer's organization cannot move its money either.
  for (const [id, action, payload] of [
    [jobId, "accept", {}],
    [jobId, "reject", { reason: "Not what I asked for" }],
    [funded, "cancel", {}],
  ] as const) {
    const res = await post(id, action, member(BUYER), payload);
    assert.deepEqual([res.statusCode, res.json().error], [403, "insufficient_role"], action);
  }
  // Nor can a key without the scope by name.
  const key = await post(jobId, "accept", as({ type: "api_key", orgId: BUYER, scopes: ["*"] }), {});
  assert.deepEqual([key.statusCode, key.json().error], [403, "missing_scope"]);

  assert.equal(market.db.job(jobId).status, "submitted");
  assert.equal(market.db.job(funded).status, "funded");
  assert.equal(market.db.state.accrued.size, 0);

  const granted = await post(jobId, "accept", as({ type: "api_key", orgId: BUYER, scopes: ["jobs:review"] }), {});
  assert.equal(granted.statusCode, 200);
});

test("a completed job is rated once, by any member of the buyer's organization", async () => {
  const { market, post, delivered } = await build();
  const jobId = await delivered();
  const early = await post(jobId, "rate", member(BUYER), { rating: 4 });
  assert.deepEqual([early.statusCode, early.json().error], [409, "job_state_conflict"]);

  await post(jobId, "accept", owner(BUYER), {});
  market.recalculated.length = 0;
  const rated = await post(jobId, "rate", member(BUYER), { rating: 4, review: "Solid." });
  assert.equal(rated.statusCode, 200);
  assert.deepEqual([rated.json().job.rating, rated.json().job.review], [4, "Solid."]);
  assert.deepEqual(market.recalculated, [PUB]);

  const twice = await post(jobId, "rate", member(BUYER), { rating: 1 });
  assert.equal(twice.statusCode, 409);
  assert.equal(market.db.job(jobId).rating, 4);
  assert.equal((await post(jobId, "rate", member(BUYER), { rating: 6 })).statusCode, 400);
});
