import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { toBuyerJob, toPublisherJob, type JobRecord } from "../services/jobs.js";
import {
  checkSellable,
  createOffering,
  createOfferingSchema,
  getPublicOffering,
  OfferingError,
  offeringTermsVersion,
  setOfferingStatus,
  testRunOffering,
  toPublicOffering,
  updateOffering,
  updateOfferingSchema,
  validateJobInput,
  validateOfferingContent,
  type OfferingView,
} from "../services/offerings.js";
import {
  AGENT,
  CLONE,
  DEPLOYMENT,
  GRAPH_AGENT,
  makeMarket,
  OTHER,
  PUB,
  VALID_OFFERING,
  WORKFLOW,
} from "./jobsApiFakes.js";

// Offerings: what may be written, what may be sold, and what may be read.

const code = (expected: string) => (err: unknown) => {
  assert.ok(err instanceof OfferingError, String(err));
  assert.equal(err.code, expected);
  return true;
};

const parse = (extra: Record<string, unknown>) => createOfferingSchema.safeParse({ ...VALID_OFFERING, ...extra });

test("price and delivery time are held to the decided bounds", () => {
  assert.equal(parse({}).success, true);
  assert.equal(parse({ priceCents: 49 }).success, false);
  assert.equal(parse({ priceCents: 50 }).success, true);
  assert.equal(parse({ priceCents: 100_000 }).success, true);
  assert.equal(parse({ priceCents: 100_001 }).success, false);
  assert.equal(parse({ priceCents: 99.5 }).success, false);
  assert.equal(parse({ slaSeconds: 299 }).success, false);
  assert.equal(parse({ slaSeconds: 300 }).success, true);
  assert.equal(parse({ slaSeconds: 604_800 }).success, true);
  assert.equal(parse({ slaSeconds: 604_801 }).success, false);
  assert.equal(parse({ maxAttempts: 4 }).success, false);
  assert.equal(parse({ maxConcurrentJobs: 51 }).success, false);
  assert.equal(parse({ outputFormat: "xml" }).success, false);
  assert.equal(parse({ sampleInputs: Array.from({ length: 6 }, () => ({ url: "https://example.com" })) }).success, false);
  // Nothing a client invents is stored.
  assert.equal(parse({ status: "active" }).success, false);
  assert.equal(parse({ publisherId: OTHER }).success, false);
  // An offering is not moved to another product by an edit.
  assert.equal(updateOfferingSchema.safeParse({ agentId: AGENT }).success, false);
  assert.equal(updateOfferingSchema.safeParse({ productKind: "workflow" }).success, false);
  assert.equal(updateOfferingSchema.safeParse({}).success, false);
  // One form per save: a schema written by hand, or the agent's own.
  const { inputSchema: _schema, ...noSchema } = VALID_OFFERING;
  assert.equal(createOfferingSchema.safeParse({ ...noSchema, fromAgentForm: true }).success, true);
  assert.equal(parse({ fromAgentForm: true }).success, false);
  assert.equal(parse({ fromAgentForm: false }).success, true);
  assert.equal(updateOfferingSchema.safeParse({ fromAgentForm: true }).success, true);
  assert.equal(
    updateOfferingSchema.safeParse({ fromAgentForm: true, inputSchema: VALID_OFFERING.inputSchema }).success,
    false,
  );
});

test("an input schema must be an object schema that compiles", () => {
  assert.throws(() => validateOfferingContent({ inputSchema: { type: "string" } }), code("invalid_input_schema"));
  assert.throws(
    () => validateOfferingContent({ inputSchema: { type: "object", properties: { a: { type: "nope" } } } }),
    code("invalid_input_schema"),
  );
  // A pattern the linear-time engine cannot express is refused when saved.
  assert.throws(
    () =>
      validateOfferingContent({
        inputSchema: { type: "object", properties: { a: { type: "string", pattern: "(?<=x)y" } } },
      }),
    code("invalid_input_schema"),
  );
  assert.doesNotThrow(() => validateOfferingContent({ inputSchema: VALID_OFFERING.inputSchema }));
  assert.doesNotThrow(() => validateOfferingContent({}));
});

test("every sample must match the schema it is saved beside", () => {
  assert.throws(
    () =>
      validateOfferingContent({
        inputSchema: VALID_OFFERING.inputSchema,
        sampleInputs: [{ url: "https://example.com" }, { depth: 2 }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof OfferingError);
      assert.equal(err.code, "invalid_sample_input");
      // Points at the second sample's missing field.
      assert.deepEqual(err.details?.[0], { path: "/1/url", message: "is required" });
      return true;
    },
  );
});

test("a deliverable check that cannot compile is refused, with where", () => {
  assert.throws(
    () => validateOfferingContent({ deliverableChecks: [{ type: "contains", value: "ok" }, { type: "regex", pattern: "(a)\\1" }] }),
    (err: unknown) => {
      assert.ok(err instanceof OfferingError);
      assert.equal(err.code, "invalid_deliverable_check");
      assert.equal(err.details?.[0]?.path, "/1/pattern");
      return true;
    },
  );
  assert.throws(() => validateOfferingContent({ deliverableChecks: [{ type: "function", value: "x" }] }), code("invalid_deliverable_check"));
});

test("only the organization's own product can be sold; another organization's is simply not found", async () => {
  const { offerings } = makeMarket();
  const own = await checkSellable(offerings.store, PUB, { productKind: "agent", agentId: AGENT, orchestrationId: null, deploymentId: null });
  assert.equal(own.ok, true);

  const foreign = await checkSellable(offerings.store, OTHER, { productKind: "agent", agentId: AGENT, orchestrationId: null, deploymentId: null });
  assert.deepEqual([foreign.ok, !foreign.ok && foreign.code], [false, "product_not_found"]);
  for (const product of [
    { productKind: "workflow", agentId: null, orchestrationId: WORKFLOW, deploymentId: null },
    { productKind: "model", agentId: null, orchestrationId: null, deploymentId: DEPLOYMENT },
  ]) {
    assert.equal((await checkSellable(offerings.store, PUB, product)).ok, true);
    const other = await checkSellable(offerings.store, OTHER, product);
    assert.equal(!other.ok && other.code, "product_not_found");
  }
});

test("a marketplace copy, or a workflow that uses one, cannot be sold", async () => {
  const market = makeMarket();
  const { store } = market.offerings;
  const clone = await checkSellable(store, PUB, { productKind: "agent", agentId: CLONE, orchestrationId: null, deploymentId: null });
  assert.equal(!clone.ok && clone.code, "product_not_sellable");

  const workflow = { productKind: "workflow", agentId: null, orchestrationId: WORKFLOW, deploymentId: null };
  market.workflows.get(WORKFLOW)!.usesMarketplaceCopy = true;
  const resold = await checkSellable(store, PUB, workflow);
  assert.equal(!resold.ok && resold.code, "product_not_sellable");

  market.workflows.get(WORKFLOW)!.usesMarketplaceCopy = false;
  market.workflows.get(WORKFLOW)!.isEnabled = false;
  assert.equal((await checkSellable(store, PUB, workflow)).ok, false);
  market.workflows.get(WORKFLOW)!.isEnabled = true;
  market.workflows.get(WORKFLOW)!.stepCount = 0;
  assert.equal((await checkSellable(store, PUB, workflow)).ok, false);

  await assert.rejects(
    createOffering(market.offerings, PUB, createOfferingSchema.parse({ ...VALID_OFFERING, agentId: CLONE })),
    code("product_not_sellable"),
  );
});

test("a graph agent's tools are fixed, so an offering cannot limit them", async () => {
  const { offerings } = makeMarket();
  const product = { productKind: "agent", agentId: GRAPH_AGENT, orchestrationId: null, deploymentId: null };
  assert.equal((await checkSellable(offerings.store, PUB, product)).ok, true);
  const limited = await checkSellable(offerings.store, PUB, product, { allowedTools: ["web_search"] });
  assert.equal(!limited.ok && limited.code, "product_not_sellable");
});

test("creating an offering stores a draft with a slug and makes sure the publisher can be paid", async () => {
  const market = makeMarket();
  const offering = await createOffering(market.offerings, PUB, createOfferingSchema.parse(VALID_OFFERING));

  assert.equal(offering.status, "draft");
  assert.equal(offering.slug, "competitor-teardown");
  assert.equal(offering.priceCents, 2_000);
  assert.equal(offering.reviewWindowHours, 72);
  assert.equal(offering.product.name, "Research Agent");
  assert.deepEqual(market.profilesEnsured, [PUB]);

  // The same title again gets its own address instead of failing.
  const second = await createOffering(market.offerings, PUB, createOfferingSchema.parse(VALID_OFFERING));
  assert.match(second.slug, /^competitor-teardown-r\d+$/);

  await assert.rejects(
    createOffering(market.offerings, PUB, createOfferingSchema.parse({ ...VALID_OFFERING, agentId: undefined })),
    code("invalid_request"),
  );
  await assert.rejects(
    createOffering(market.offerings, OTHER, createOfferingSchema.parse(VALID_OFFERING)),
    code("product_not_found"),
  );
});

test("all three product kinds can be offered", async () => {
  const market = makeMarket();
  const { agentId: _agent, ...base } = VALID_OFFERING;
  const workflow = await createOffering(
    market.offerings,
    PUB,
    createOfferingSchema.parse({ ...base, productKind: "workflow", orchestrationId: WORKFLOW }),
  );
  assert.deepEqual([workflow.productKind, workflow.product.name], ["workflow", "Research Flow"]);
  const model = await createOffering(
    market.offerings,
    PUB,
    createOfferingSchema.parse({ ...base, productKind: "model", deploymentId: DEPLOYMENT }),
  );
  assert.deepEqual([model.productKind, model.product.name], ["model", "My Llama"]);

  // A model offering goes on sale only while its deployment is running.
  market.deployments.get(DEPLOYMENT)!.status = "stopped";
  await assert.rejects(setOfferingStatus(market.offerings, PUB, model.id, "activate"), code("product_not_sellable"));
  market.deployments.get(DEPLOYMENT)!.status = "running";
  assert.equal((await setOfferingStatus(market.offerings, PUB, model.id, "activate")).status, "active");
});

test("status moves by compare-and-set: draft or paused to active, active to paused, anything to archived", async () => {
  const market = makeMarket();
  const { id } = await createOffering(market.offerings, PUB, createOfferingSchema.parse(VALID_OFFERING));

  await assert.rejects(setOfferingStatus(market.offerings, PUB, id, "pause"), code("offering_state_conflict"));
  const active = await setOfferingStatus(market.offerings, PUB, id, "activate");
  assert.equal(active.status, "active");
  assert.ok(active.publishedAt);
  await assert.rejects(setOfferingStatus(market.offerings, PUB, id, "activate"), code("offering_state_conflict"));
  assert.equal((await setOfferingStatus(market.offerings, PUB, id, "pause")).status, "paused");
  assert.equal((await setOfferingStatus(market.offerings, PUB, id, "activate")).status, "active");
  assert.equal((await setOfferingStatus(market.offerings, PUB, id, "archive")).status, "archived");
  await assert.rejects(setOfferingStatus(market.offerings, PUB, id, "activate"), code("offering_state_conflict"));
  await assert.rejects(updateOffering(market.offerings, PUB, id, { title: "New title" }), code("offering_state_conflict"));

  // Another organization cannot move it, or even see that it exists.
  await assert.rejects(setOfferingStatus(market.offerings, OTHER, id, "archive"), code("offering_not_found"));
});

test("activating re-checks the product and refuses where nothing would run the jobs", async () => {
  const market = makeMarket();
  const { id } = await createOffering(market.offerings, PUB, createOfferingSchema.parse(VALID_OFFERING));
  // The agent was deleted after the offering was written.
  market.agents.delete(AGENT);
  await assert.rejects(setOfferingStatus(market.offerings, PUB, id, "activate"), code("product_not_found"));
  assert.equal(market.offeringRow(id).status, "draft");

  const off = makeMarket({ runnerEnabled: false });
  const draft = await createOffering(off.offerings, PUB, createOfferingSchema.parse(VALID_OFFERING));
  await assert.rejects(setOfferingStatus(off.offerings, PUB, draft.id, "activate"), (err: unknown) => {
    assert.ok(err instanceof OfferingError);
    assert.deepEqual([err.code, err.status], ["jobs_not_configured", 501]);
    return true;
  });
});

test("an edit re-validates against what is stored, so a new schema cannot orphan the old samples", async () => {
  const market = makeMarket();
  const { id } = await createOffering(market.offerings, PUB, createOfferingSchema.parse(VALID_OFFERING));
  await assert.rejects(
    updateOffering(market.offerings, PUB, id, {
      inputSchema: { type: "object", required: ["company"], properties: { company: { type: "string" } } },
    }),
    code("invalid_sample_input"),
  );
  const updated = await updateOffering(market.offerings, PUB, id, { priceCents: 3_500, instructions: "  " });
  assert.equal(updated.priceCents, 3_500);
  assert.equal(updated.instructions, null);
});

const SECRETS = ["scoring rubric", "sk-live", "You are Atlas", "file_write", AGENT, WORKFLOW];

function view(extra: Partial<OfferingView> = {}): OfferingView {
  return {
    id: "0ff00000-0000-4000-8000-000000000001",
    publisherId: PUB,
    productKind: "agent",
    agentId: AGENT,
    orchestrationId: WORKFLOW,
    deploymentId: null,
    listingId: null,
    slug: "competitor-teardown",
    title: "Competitor teardown",
    description: "A teardown.",
    priceCents: 2_000n,
    slaSeconds: 3_600,
    inputSchema: VALID_OFFERING.inputSchema,
    sampleInputs: [{ url: "https://example.com" }],
    instructions: "Never mention our scoring rubric. Key: sk-live-123.",
    deliverableChecks: [{ type: "contains", value: "competitor" }],
    outputFormat: "text",
    allowedTools: ["file_write"],
    maxAttempts: 2,
    maxConcurrentJobs: 5,
    activeJobs: 1,
    status: "active",
    publishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    productName: "Research Agent",
    publisher: { name: "Publisher Org", slug: "publisher-org", isVerified: true, reputationTier: "gold" },
    listing: null,
    // A column added later, or a careless include, must not ride out either.
    ...({ agent: { systemPrompt: "You are Atlas", tools: ["file_write"], env: { KEY: "sk-live-999" } } } as object),
    ...extra,
  };
}

test("the public offering never carries instructions, product ids, system prompt, tools or env", () => {
  const body = JSON.stringify(toPublicOffering(view()));
  for (const secret of SECRETS) assert.ok(!body.includes(secret), `public offering leaked ${secret}`);
  const dto = toPublicOffering(view()) as Record<string, unknown>;
  for (const field of ["instructions", "agentId", "orchestrationId", "deploymentId", "allowedTools", "maxAttempts", "agent", "status"]) {
    assert.equal(field in dto, false, field);
  }
  // What a buyer needs to decide is there.
  assert.deepEqual(dto.deliverableChecks, [{ type: "contains", value: "competitor" }]);
  assert.equal(dto.priceCents, 2_000);
});

function jobRecord(extra: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1",
    offeringId: "off_1",
    buyerId: "org_buyer",
    publisherId: PUB,
    status: "running",
    input: { url: "https://example.com" },
    output: { format: "text", text: "draft with the scoring rubric" },
    checkResults: [
      { type: "contains", label: 'Contains "competitor"', passed: false, details: "Output does not contain it" },
      { type: "run", label: "The product ran", passed: false, details: "provider key sk-live-123 rejected" },
    ],
    priceCents: 2_000n,
    failureReason: null,
    rejectionReason: null,
    deadlineAt: new Date("2026-10-06T13:00:00Z"),
    reviewDeadlineAt: null,
    fundedAt: new Date("2026-10-06T12:00:00Z"),
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rating: null,
    review: null,
    idempotencyKey: "k1",
    attempts: 1,
    orchestrationExecutionId: null,
    modelCostCents: 3n,
    createdAt: new Date("2026-10-06T12:00:00Z"),
    offering: { id: "off_1", slug: "competitor-teardown", title: "Competitor teardown", productKind: "agent" },
    buyer: { name: "Buyer Org" },
    escrow: { status: "pending", grossAmountCents: 2_000n, platformFeeCents: 200n, creatorAmountCents: 1_800n },
    ...({ offeringFull: { instructions: "Never mention our scoring rubric." } } as object),
    ...extra,
  };
}

test("the buyer's job has no output before it is submitted, and never the publisher's diagnostics", () => {
  for (const status of ["funded", "running", "failed", "expired", "cancelled"]) {
    const dto = toBuyerJob(jobRecord({ status }));
    assert.equal(dto.output, null, status);
    const body = JSON.stringify(dto);
    assert.ok(!body.includes("sk-live"), status);
    assert.ok(!body.includes("scoring rubric"), status);
  }
  for (const status of ["submitted", "completed", "rejected"]) {
    assert.deepEqual(toBuyerJob(jobRecord({ status, output: { format: "text", text: "the report" } })).output, {
      format: "text",
      text: "the report",
    });
  }
  const dto = toBuyerJob(jobRecord());
  // Which checks ran and whether they passed, without details or the run note.
  assert.deepEqual(dto.checks, [{ label: 'Contains "competitor"', type: "contains", passed: false }]);
  assert.deepEqual(dto.escrow, { status: "held", amountCents: 2_000 });
  assert.equal("idempotencyKey" in dto, false);
  assert.equal("modelCostCents" in dto, false);
});

test("the publisher's job shows what their product produced and why it failed, and still no instructions", () => {
  const dto = toPublisherJob(jobRecord({ status: "failed" }));
  assert.deepEqual(dto.output, { format: "text", text: "draft with the scoring rubric" });
  assert.equal(dto.checkResults.length, 2);
  assert.match(dto.checkResults[1]!.details, /sk-live-123/);
  assert.deepEqual([dto.platformFeeCents, dto.creatorAmountCents, dto.modelCostCents], [200, 1_800, 3]);
  assert.deepEqual(dto.buyer, { orgId: "org_buyer", name: "Buyer Org" });
  assert.equal("offeringFull" in dto, false);
  assert.equal(JSON.stringify(dto).includes("Never mention"), false);

  assert.equal(toBuyerJob(jobRecord({ escrow: { ...jobRecord().escrow!, status: "settled" } })).escrow?.status, "released");
  assert.equal(toBuyerJob(jobRecord({ escrow: { ...jobRecord().escrow!, status: "refunded" } })).escrow?.status, "refunded");
});

test("the publisher's view says whether the form is the agent's; a form written by hand answers null", async () => {
  const market = makeMarket();
  const created = await createOffering(market.offerings, PUB, createOfferingSchema.parse(VALID_OFFERING));
  assert.equal(created.formInSync, null);
  // The order the questions were sent in is remembered beside the schema.
  assert.deepEqual(market.offeringRow(created.id).inputOrder, ["url", "depth"]);
  assert.equal(market.offeringRow(created.id).inputFromAgentForm, false);
  assert.deepEqual(Object.keys((created.inputSchema as { properties: object }).properties), ["url", "depth"]);
  // A reader of the public page is told nothing about where the form came from.
  const publicView = toPublicOffering((await market.offerings.store.findById(created.id))!);
  for (const key of ["formInSync", "inputOrder", "inputFromAgentForm", "agentForm"]) {
    assert.equal(key in publicView, false, key);
  }
  for (const key of ["inputOrder", "inputFromAgentForm", "agentForm"]) assert.equal(key in created, false, key);
});

test("only an active offering has a public page", async () => {
  const market = makeMarket();
  const { id, slug } = await createOffering(market.offerings, PUB, createOfferingSchema.parse(VALID_OFFERING));
  await assert.rejects(getPublicOffering(market.offerings, slug), code("offering_not_found"));
  await setOfferingStatus(market.offerings, PUB, id, "activate");
  const page = await getPublicOffering(market.offerings, slug);
  assert.equal(page.trackRecord.completed, 0);
  assert.equal(page.trackRecord.successRate, null);
  assert.equal("instructions" in page, false);
  await setOfferingStatus(market.offerings, PUB, id, "pause");
  await assert.rejects(getPublicOffering(market.offerings, slug), code("offering_not_found"));
});

test("a buyer's input is checked against the offering's schema, with the failing field", () => {
  const offering = { inputSchema: VALID_OFFERING.inputSchema };
  assert.doesNotThrow(() => validateJobInput(offering, { url: "https://example.com", depth: 2 }));
  assert.throws(() => validateJobInput(offering, { depth: 9 }), code("input_invalid"));
  assert.throws(() => validateJobInput(offering, { url: "https://example.com", extra: 1 }), (err: unknown) => {
    assert.ok(err instanceof OfferingError);
    assert.match(err.details![0]!.message, /extra/);
    return true;
  });
  // No schema: any object.
  assert.doesNotThrow(() => validateJobInput({ inputSchema: null }, { anything: true }));
});

test("a test run runs the offering once as a job would, and names why it could not", async () => {
  const market = makeMarket();
  const { id } = await createOffering(market.offerings, PUB, createOfferingSchema.parse(VALID_OFFERING));
  const seen: Array<{ testRun?: boolean; publisherId: string; instructions: string | null }> = [];
  const deps = {
    store: market.offerings.store,
    tryProduct: async (job: { testRun?: boolean; publisherId: string; offering: { instructions: string | null } }) => {
      seen.push({ testRun: job.testRun, publisherId: job.publisherId, instructions: job.offering.instructions });
      return { passed: true, output: { format: "text", text: "competitor report" }, checkResults: [] };
    },
    maxRunMs: 1_000,
    freeTierLimitMessage: "free-model limit reached",
  };
  const result = await testRunOffering(deps, PUB, id, { url: "https://example.com" });
  assert.equal(result.passed, true);
  assert.deepEqual(seen, [{ testRun: true, publisherId: PUB, instructions: VALID_OFFERING.instructions }]);
  // No job, no escrow, no charge.
  assert.equal(market.db.state.jobs.size, 0);
  assert.equal(market.db.state.ledger.length, 0);

  await assert.rejects(testRunOffering(deps, PUB, id, { depth: 1 }), code("input_invalid"));
  await assert.rejects(testRunOffering(deps, OTHER, id, { url: "https://example.com" }), code("offering_not_found"));

  const limited = { ...deps, tryProduct: async () => Promise.reject(new Error("free-model limit reached")) };
  await assert.rejects(testRunOffering(limited, PUB, id, { url: "https://example.com" }), code("free_tier_limited"));
  const broken = { ...deps, tryProduct: async () => Promise.reject(new Error("agent has no model")) };
  await assert.rejects(testRunOffering(broken, PUB, id, { url: "https://example.com" }), (err: unknown) => {
    assert.ok(err instanceof OfferingError);
    assert.equal(err.code, "test_run_failed");
    assert.match(err.message, /agent has no model/);
    return true;
  });
});

test("a sample or an input the schema cannot be checked against inside one validation's budget is refused as such, not as a mismatch", () => {
  const inputSchema = {
    type: "object",
    properties: {
      xs: {
        type: "array",
        items: { type: "string", allOf: Array.from({ length: 5 }, (_, i) => ({ pattern: `[a-z]{${1000 - i}}$` })) },
      },
    },
  };
  const heavy = { xs: Array.from({ length: 4 }, () => "a".repeat(1980)) };
  assert.throws(
    () => validateOfferingContent({ inputSchema, sampleInputs: [{ xs: [] }, heavy] }),
    (err: unknown) => {
      assert.ok(err instanceof OfferingError);
      assert.deepEqual([err.code, err.status], ["validation_too_expensive", 422]);
      assert.match(err.message, /Sample input 2 could not be checked/);
      assert.equal(err.details?.[0]?.path, "/1");
      return true;
    },
  );
  assert.throws(() => validateJobInput({ inputSchema }, heavy), code("validation_too_expensive"));
  assert.doesNotThrow(() => validateJobInput({ inputSchema }, { xs: [] }));

  // A schema whose references multiply is refused when it is written.
  const definitions: Record<string, unknown> = { a30: { type: "object" } };
  for (let i = 0; i < 30; i++) {
    definitions[`a${i}`] = { allOf: [{ $ref: `#/definitions/a${i + 1}` }, { $ref: `#/definitions/a${i + 1}` }] };
  }
  assert.throws(
    () => validateOfferingContent({ inputSchema: { type: "object", allOf: [{ $ref: "#/definitions/a0" }], definitions }, sampleInputs: [{}] }),
    code("invalid_input_schema"),
  );
  assert.throws(
    () => validateOfferingContent({ deliverableChecks: [{ type: "json_schema", schema: { allOf: [{ $ref: "#/definitions/a0" }], definitions } }] }),
    code("invalid_deliverable_check"),
  );
});

test("the terms version follows everything a buyer agrees to, and nothing else", () => {
  const base = {
    title: "Competitor teardown",
    description: "A one-page teardown.",
    priceCents: 2_000n,
    slaSeconds: 3_600,
    inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
    deliverableChecks: [{ type: "contains", value: "competitor" }],
    outputFormat: "text",
    instructions: "Rank by revenue.",
  };
  const version = offeringTermsVersion(base);
  assert.match(version, /^[0-9a-f]{32}$/);
  // Stored JSON comes back with its keys in another order.
  assert.equal(
    offeringTermsVersion({
      ...base,
      inputSchema: { properties: { url: { type: "string" } }, required: ["url"], type: "object" },
      deliverableChecks: [{ value: "competitor", type: "contains" }],
    }),
    version,
  );
  const changes: Array<Partial<typeof base>> = [
    { title: "Competitor teardown, deluxe" },
    { description: "A two-page teardown." },
    { priceCents: 2_001n },
    { slaSeconds: 3_601 },
    { inputSchema: { type: "object", required: ["url"], properties: { url: { type: "number" } } } },
    { deliverableChecks: [] },
    { deliverableChecks: [{ type: "contains", value: "Competitor" }] },
    { outputFormat: "json" },
    { instructions: "Rank by headcount." },
  ];
  const versions = new Set(changes.map((change) => offeringTermsVersion({ ...base, ...change })));
  assert.equal(versions.size, changes.length);
  assert.ok(!versions.has(version));
  // Nothing of the instructions is in it.
  assert.ok(!version.includes("Rank"));
  assert.equal(offeringTermsVersion({ ...base, instructions: null }), offeringTermsVersion({ ...base, instructions: "" }));
});
