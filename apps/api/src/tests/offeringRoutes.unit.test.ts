import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { createOfferingRoutes } from "../routes/offerings.js";
import { hireJob } from "../services/jobEscrow.js";
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
  testGuards,
  VALID_OFFERING,
  type Market,
} from "./jobsApiFakes.js";

// Drives routes/offerings.ts (createOfferingRoutes) over the in-memory
// market, with the production scope and spend guards.

async function build(market: Market = makeMarket()) {
  const app = Fastify();
  installTestAuth(app);
  const tried: unknown[] = [];
  await app.register(
    createOfferingRoutes({
      offerings: market.offerings,
      jobs: market.jobs,
      testRun: {
        tryProduct: async (job) => {
          tried.push(job.input);
          return { passed: true, output: { format: "text", text: "competitor report" }, checkResults: [] };
        },
        maxRunMs: 1_000,
        freeTierLimitMessage: "free-model limit reached",
      },
      guards: testGuards(),
    }),
    { prefix: "/api/offerings" },
  );
  const create = async (body: Record<string, unknown> = {}, headers = owner(PUB)) =>
    app.inject({ method: "POST", url: "/api/offerings", headers, payload: { ...VALID_OFFERING, ...body } });
  const activated = async (body: Record<string, unknown> = {}) => {
    const { offering } = (await create(body)).json() as { offering: { id: string; slug: string } };
    await app.inject({ method: "POST", url: `/api/offerings/${offering.id}/activate`, headers: owner(PUB) });
    return offering;
  };
  return { app, market, tried, create, activated };
}

test("creating an offering needs a caller, and an API key needs offerings:write", async () => {
  const { app, create } = await build();
  const anonymous = await app.inject({ method: "POST", url: "/api/offerings", payload: VALID_OFFERING });
  assert.equal(anonymous.statusCode, 401);

  const scoped = await create({}, as({ type: "api_key", orgId: PUB, scopes: ["jobs:read"] }));
  assert.equal(scoped.statusCode, 403);
  assert.equal(scoped.json().error, "missing_scope");

  // A key from before scopes keeps working, as does any member's session.
  assert.equal((await create({}, as({ type: "api_key", orgId: PUB, scopes: [] }))).statusCode, 201);
  assert.equal((await create({}, member(PUB))).statusCode, 201);
});

test("create answers 201 with a draft, and names what is wrong otherwise", async () => {
  const { create } = await build();
  const ok = await create();
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().offering.status, "draft");
  assert.equal(ok.json().offering.instructions, VALID_OFFERING.instructions);

  const cases: Array<[Record<string, unknown>, number, string]> = [
    [{ priceCents: 10 }, 400, "invalid_request"],
    [{ slaSeconds: 60 }, 400, "invalid_request"],
    [{ inputSchema: { type: "array" } }, 422, "invalid_input_schema"],
    [{ sampleInputs: [{ nope: true }] }, 422, "invalid_sample_input"],
    [{ deliverableChecks: [{ type: "regex", pattern: "(?=x)" }] }, 422, "invalid_deliverable_check"],
    [{ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab" }, 409, "product_not_sellable"],
    [{ agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, 404, "product_not_found"],
  ];
  for (const [body, status, error] of cases) {
    const res = await create(body);
    assert.deepEqual([res.statusCode, res.json().error], [status, error], JSON.stringify(body));
  }
  // 422s say where.
  const bad = await create({ sampleInputs: [{ nope: true }] });
  assert.ok(Array.isArray(bad.json().details));
});

test("another organization cannot create an offering on this one's agent, nor read, edit or move its offerings", async () => {
  const { app, create } = await build();
  const foreign = await create({ agentId: AGENT }, owner(OTHER));
  assert.deepEqual([foreign.statusCode, foreign.json().error], [404, "product_not_found"]);

  const { offering } = (await create()).json() as { offering: { id: string } };
  const asOther = owner(OTHER);
  for (const [method, url, payload] of [
    ["GET", `/api/offerings/mine/${offering.id}`, undefined],
    ["PATCH", `/api/offerings/${offering.id}`, { title: "Hijacked title" }],
    ["POST", `/api/offerings/${offering.id}/activate`, undefined],
    ["POST", `/api/offerings/${offering.id}/archive`, undefined],
    ["POST", `/api/offerings/${offering.id}/test-run`, { input: { url: "https://example.com" } }],
  ] as const) {
    const res = await app.inject({ method, url, headers: asOther, payload });
    assert.deepEqual([res.statusCode, res.json().error], [404, "offering_not_found"], `${method} ${url}`);
  }
  const mine = await app.inject({ method: "GET", url: "/api/offerings/mine", headers: asOther });
  assert.deepEqual(mine.json().offerings, []);
  const own = await app.inject({ method: "GET", url: "/api/offerings/mine", headers: owner(PUB) });
  assert.equal(own.json().offerings.length, 1);
});

test("activating makes sure the publisher has a payout profile", async () => {
  const { app, market, create } = await build();
  const { offering } = (await create()).json() as { offering: { id: string } };
  market.db.state.profiles.clear();
  market.profilesEnsured.length = 0;

  const res = await app.inject({ method: "POST", url: `/api/offerings/${offering.id}/activate`, headers: owner(PUB) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().offering.status, "active");
  assert.deepEqual(market.profilesEnsured, [PUB]);
  assert.ok(market.db.state.profiles.has(PUB));

  const again = await app.inject({ method: "POST", url: `/api/offerings/${offering.id}/activate`, headers: owner(PUB) });
  assert.deepEqual([again.statusCode, again.json().error], [409, "offering_state_conflict"]);
});

test("the public list and page show active offerings only, to anyone, without the private instructions", async () => {
  const { app, create, activated } = await build();
  const live = await activated();
  await create({ title: "Still a draft" });
  const paused = await activated({ title: "Paused offering" });
  await app.inject({ method: "POST", url: `/api/offerings/${paused.id}/pause`, headers: owner(PUB) });

  const list = await app.inject({ method: "GET", url: "/api/offerings" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().offerings.map((o: { slug: string }) => o.slug),
    [live.slug],
  );
  assert.equal(list.json().pagination.total, 1);
  assert.ok(!list.body.includes("scoring rubric"));
  assert.ok(!list.body.includes(AGENT));

  const page = await app.inject({ method: "GET", url: `/api/offerings/${live.slug}` });
  assert.equal(page.statusCode, 200);
  assert.equal(page.json().offering.trackRecord.completed, 0);
  assert.ok(!page.body.includes("scoring rubric"));
  assert.equal("instructions" in page.json().offering, false);

  for (const slug of ["still-a-draft", paused.slug, "no-such-offering"]) {
    const res = await app.inject({ method: "GET", url: `/api/offerings/${slug}` });
    assert.deepEqual([res.statusCode, res.json().error], [404, "offering_not_found"], slug);
  }
  const filtered = await app.inject({ method: "GET", url: "/api/offerings?productKind=workflow" });
  assert.deepEqual(filtered.json().offerings, []);
  assert.equal((await app.inject({ method: "GET", url: "/api/offerings?limit=500" })).statusCode, 400);
});

test("editing an offering does not change the terms of a job already hired", async () => {
  const { app, market, activated } = await build();
  const offering = await activated();
  const row = market.offeringRow(offering.id);
  const { jobId } = await market.db.inTransaction((tx) =>
    hireJob(tx, {
      offering: {
        id: offering.id,
        title: row.title as string,
        publisherId: PUB,
        listingId: null,
        priceCents: row.priceCents as bigint,
        slaSeconds: row.slaSeconds as number,
        deliverableChecks: row.deliverableChecks,
        outputFormat: row.outputFormat as string,
      },
      buyerId: BUYER,
      input: { url: "https://example.com" },
    }),
  );

  const patch = await app.inject({
    method: "PATCH",
    url: `/api/offerings/${offering.id}`,
    headers: owner(PUB),
    payload: { priceCents: 9_000, title: "Pricier teardown", deliverableChecks: [] },
  });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().offering.priceCents, 9_000);
  assert.deepEqual(patch.json().offering.stats.jobs, { funded: 1 });

  const job = market.db.job(jobId);
  assert.equal(job.priceCents, 2_000n);
  assert.deepEqual(job.terms, {
    title: "Competitor teardown",
    priceCents: "2000",
    slaSeconds: 3_600,
    reviewWindowMs: 72 * 60 * 60 * 1000,
    deliverableChecks: [{ type: "contains", value: "competitor" }],
    outputFormat: "text",
  });
});

test("with the runner switched off, activate and hire answer 501 and nothing is charged", async () => {
  const on = await build();
  const offering = await on.activated();
  // The same market, served by a process whose runner is off.
  on.market.offerings.runnerEnabled = false;
  on.market.jobs.runnerEnabled = false;

  const draft = (await on.create({ title: "Another offering" })).json().offering as { id: string };
  const activate = await on.app.inject({ method: "POST", url: `/api/offerings/${draft.id}/activate`, headers: owner(PUB) });
  assert.deepEqual([activate.statusCode, activate.json().error], [501, "jobs_not_configured"]);

  const hire = await on.app.inject({
    method: "POST",
    url: `/api/offerings/${offering.id}/hire`,
    headers: owner(BUYER),
    payload: { input: { url: "https://example.com" } },
  });
  assert.deepEqual([hire.statusCode, hire.json().error], [501, "jobs_not_configured"]);
  assert.equal(on.market.db.state.balances.get(BUYER), 100_000n);
  assert.equal(on.market.db.state.jobs.size, 0);
});

test("validate checks a schema, samples and checks without saving anything", async () => {
  const { app, market } = await build();
  const ok = await app.inject({
    method: "POST",
    url: "/api/offerings/validate",
    headers: owner(PUB),
    payload: { inputSchema: VALID_OFFERING.inputSchema, sampleInputs: [{ url: "https://example.com" }] },
  });
  assert.deepEqual([ok.statusCode, ok.json()], [200, { ok: true }]);
  const bad = await app.inject({
    method: "POST",
    url: "/api/offerings/validate",
    headers: owner(PUB),
    payload: { deliverableChecks: [{ type: "regex", pattern: "(" }] },
  });
  assert.deepEqual([bad.statusCode, bad.json().error], [422, "invalid_deliverable_check"]);
  assert.equal([...market.db.state.offerings.values()].filter((row) => row.slug).length, 0);
});

test("a test run is the owner's, validates the input and moves no money", async () => {
  const { app, market, tried, create } = await build();
  const { offering } = (await create()).json() as { offering: { id: string } };
  const run = await app.inject({
    method: "POST",
    url: `/api/offerings/${offering.id}/test-run`,
    headers: owner(PUB),
    payload: { input: { url: "https://example.com" } },
  });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().passed, true);
  assert.deepEqual(tried, [{ url: "https://example.com" }]);
  assert.equal(market.db.state.ledger.length, 0);

  const invalid = await app.inject({
    method: "POST",
    url: `/api/offerings/${offering.id}/test-run`,
    headers: owner(PUB),
    payload: { input: {} },
  });
  assert.deepEqual([invalid.statusCode, invalid.json().error], [422, "input_invalid"]);
});

test("validate, create and edit refuse a schema that would stall the server, in milliseconds", async () => {
  const { app, create } = await build();
  // The review's two schemas, at the sizes it measured at ten days and at 83 seconds.
  const definitions: Record<string, unknown> = { a45: { type: "object" } };
  for (let i = 0; i < 45; i++) {
    definitions[`a${i}`] = { allOf: [{ $ref: `#/definitions/a${i + 1}` }, { $ref: `#/definitions/a${i + 1}` }] };
  }
  const fanOut = { type: "object", allOf: [{ $ref: "#/definitions/a0" }], definitions };
  const patterns = (count: number) => ({
    type: "object",
    properties: {
      xs: { type: "array", items: { type: "string", allOf: Array.from({ length: count }, (_, i) => ({ pattern: `[a-z]{${1000 - i}}$` })) } },
    },
  });
  const strings = { xs: Array.from({ length: 30 }, () => "a".repeat(1990)) };
  const validate = (payload: object) =>
    app.inject({ method: "POST", url: "/api/offerings/validate", headers: owner(PUB), payload });

  const start = performance.now();
  const cases: Array<[object, string]> = [
    [{ inputSchema: fanOut, sampleInputs: [{}] }, "invalid_input_schema"],
    [{ inputSchema: patterns(40), sampleInputs: [strings] }, "invalid_input_schema"],
    [{ inputSchema: patterns(5), sampleInputs: [strings] }, "validation_too_expensive"],
    [{ deliverableChecks: [{ type: "json_schema", schema: fanOut }] }, "invalid_deliverable_check"],
  ];
  for (const [payload, error] of cases) {
    const res = await validate(payload);
    assert.deepEqual([res.statusCode, res.json().error], [422, error]);
    assert.ok(Array.isArray(res.json().details));
  }
  const created = await create({ inputSchema: fanOut, sampleInputs: [{}] });
  assert.deepEqual([created.statusCode, created.json().error], [422, "invalid_input_schema"]);
  const draft = (await create()).json().offering as { id: string };
  const edited = await app.inject({
    method: "PATCH",
    url: `/api/offerings/${draft.id}`,
    headers: owner(PUB),
    payload: { inputSchema: patterns(5), sampleInputs: [strings] },
  });
  assert.deepEqual([edited.statusCode, edited.json().error], [422, "validation_too_expensive"]);
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `six requests took ${ms.toFixed(0)}ms`);
});

test("a public offering carries the terms version a hire sends back", async () => {
  const { app, activated } = await build();
  const offering = await activated();
  const page = await app.inject({ method: "GET", url: `/api/offerings/${offering.slug}` });
  assert.match(page.json().offering.termsVersion, /^[0-9a-f]{32}$/);
  const mine = await app.inject({ method: "GET", url: `/api/offerings/mine/${offering.id}`, headers: owner(PUB) });
  assert.equal(page.json().offering.termsVersion, mine.json().offering.termsVersion);
  assert.ok(!page.body.includes("scoring rubric"));
});
