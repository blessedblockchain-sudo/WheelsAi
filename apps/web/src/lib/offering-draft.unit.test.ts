/**
 * What the offering editor sends. Run with:
 *   cd apps/web && npx tsx --test src/lib/offering-draft.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PublisherOffering } from "./api";
import {
  buildOffering,
  checkIssues,
  draftFromOffering,
  emptyDraft,
  outboundToolsAllowed,
  serverIssueField,
  toCreateInput,
} from "./offering-draft";

const AGENT = "11111111-1111-4111-8111-111111111111";

function draft(overrides: Partial<ReturnType<typeof emptyDraft>> = {}) {
  return {
    ...emptyDraft(),
    productId: AGENT,
    title: "Market brief",
    description: "One paragraph on a topic you send.",
    ...overrides,
  };
}

test("the starting draft is sendable once it has a product, a title and a description", () => {
  const built = buildOffering(draft());
  assert.deepEqual(built.errors, {});
  assert.equal(built.content.priceCents, 500);
  assert.equal(built.content.slaSeconds, 3600);
  assert.equal(built.content.outputFormat, "text");
  assert.equal(built.content.instructions, null);
  assert.deepEqual(built.content.deliverableChecks, []);
  assert.equal((built.content.inputSchema as { type: string }).type, "object");
});

test("price and delivery time are held to the limits the API enforces", () => {
  for (const price of ["0.49", "1000.01", "abc", "1.999", ""]) {
    assert.match(buildOffering(draft({ price })).errors.price ?? "", /between \$0\.50 and \$1,000\.00/, price);
  }
  assert.equal(buildOffering(draft({ price: "0.50" })).content.priceCents, 50);
  assert.equal(buildOffering(draft({ price: "1000" })).content.priceCents, 100_000);

  assert.match(buildOffering(draft({ slaAmount: "4", slaUnit: "minutes" })).errors.slaAmount ?? "", /5 minutes and 7 days/);
  assert.match(buildOffering(draft({ slaAmount: "8", slaUnit: "days" })).errors.slaAmount ?? "", /5 minutes and 7 days/);
  assert.match(buildOffering(draft({ slaAmount: "soon" })).errors.slaAmount ?? "", /between/);
  assert.equal(buildOffering(draft({ slaAmount: "5", slaUnit: "minutes" })).content.slaSeconds, 300);
  assert.equal(buildOffering(draft({ slaAmount: "7", slaUnit: "days" })).content.slaSeconds, 604_800);
  assert.equal(buildOffering(draft({ slaAmount: "1.5", slaUnit: "hours" })).content.slaSeconds, 5400);
});

test("JSON that does not parse is caught before it is sent", () => {
  assert.match(buildOffering(draft({ inputSchema: "{nope" })).errors.inputSchema ?? "", /JSON object/);
  assert.match(buildOffering(draft({ inputSchema: "[]" })).errors.inputSchema ?? "", /JSON object/);
  assert.equal(buildOffering(draft({ inputSchema: "  " })).content.inputSchema, null);

  assert.match(buildOffering(draft({ sampleInputs: "[1]" })).errors.sampleInputs ?? "", /array of objects/);
  assert.match(
    buildOffering(draft({ sampleInputs: JSON.stringify([{}, {}, {}, {}, {}, {}]) })).errors.sampleInputs ?? "",
    /At most 5/,
  );
  // One object is taken as one sample.
  assert.deepEqual(buildOffering(draft({ sampleInputs: '{"topic":"gpu"}' })).content.sampleInputs, [{ topic: "gpu" }]);
});

test("each check row becomes the check the API validates", () => {
  const built = buildOffering(
    draft({
      checks: [
        { type: "contains", value: " Bottom line ", label: "Has a bottom line" },
        { type: "min_length", value: "200", label: "" },
        { type: "json_schema", value: '{"type":"object","required":["score"]}', label: "" },
        { type: "regex", value: "^Summary:", label: "" },
        { type: "exact", value: " yes ", label: "" },
      ],
    }),
  );
  assert.deepEqual(built.errors, {});
  assert.deepEqual(built.content.deliverableChecks, [
    { type: "contains", value: "Bottom line", label: "Has a bottom line" },
    { type: "min_length", value: 200 },
    { type: "json_schema", schema: { type: "object", required: ["score"] } },
    { type: "regex", pattern: "^Summary:" },
    { type: "exact", value: " yes " },
  ]);
});

test("a check with no value, a length that is not a number or a schema that is not JSON names its row", () => {
  const { errors } = buildOffering(
    draft({
      checks: [
        { type: "contains", value: "  ", label: "" },
        { type: "max_length", value: "long", label: "" },
        { type: "json_schema", value: "{", label: "" },
        { type: "min_length", value: "10", label: "" },
      ],
    }),
  );
  assert.equal(errors["checks.0"], "This check needs a value");
  assert.equal(errors["checks.1"], "Enter a number of characters");
  assert.equal(errors["checks.2"], "The schema must be a JSON object");
  assert.equal(errors["checks.3"], undefined);
});

test("allowed tools are sent for an agent only", () => {
  assert.deepEqual(buildOffering(draft({ allowedTools: " web_search, ,calculator " })).content.allowedTools, [
    "web_search",
    "calculator",
  ]);
  assert.deepEqual(
    buildOffering(draft({ productKind: "workflow", allowedTools: "web_search" })).content.allowedTools,
    [],
  );
});

test("naming a tool that can call any address is what allows it, and the editor says so", () => {
  // Empty means the agent's own tools - and never an outbound one.
  assert.deepEqual(outboundToolsAllowed(draft({ allowedTools: "" })), []);
  assert.deepEqual(outboundToolsAllowed(draft({ allowedTools: "web_search, calculator" })), []);
  assert.deepEqual(outboundToolsAllowed(draft({ allowedTools: " calculator ,http_request" })), ["http_request"]);
  // Not sent for a workflow, so not allowed by this form either.
  assert.deepEqual(outboundToolsAllowed(draft({ productKind: "workflow", allowedTools: "http_request" })), []);
  assert.deepEqual(buildOffering(draft({ allowedTools: "calculator, http_request" })).content.allowedTools, [
    "calculator",
    "http_request",
  ]);
});

test("the create body names the one product its kind points at", () => {
  const content = buildOffering(draft()).content;
  assert.equal(toCreateInput(draft(), content).agentId, AGENT);
  const workflow = toCreateInput(draft({ productKind: "workflow" }), content);
  assert.equal(workflow.orchestrationId, AGENT);
  assert.equal("agentId" in workflow, false);
  const model = toCreateInput(draft({ productKind: "model" }), content);
  assert.equal(model.deploymentId, AGENT);
  assert.equal("orchestrationId" in model, false);
});

test("an offering loads into the editor and saves back unchanged", () => {
  const offering = {
    id: "o1",
    slug: "market-brief",
    title: "Market brief",
    description: "One paragraph on a topic you send.",
    productKind: "agent",
    priceCents: 250,
    slaSeconds: 7200,
    termsVersion: "0123456789abcdef0123456789abcdef",
    reviewWindowHours: 72,
    inputSchema: { type: "object", properties: { topic: { type: "string" } } },
    sampleInputs: [{ topic: "gpu" }],
    deliverableChecks: [
      { type: "min_length", value: 200, label: "Long enough" },
      { type: "json_schema", schema: { type: "object" } },
      { type: "regex", pattern: "^\\{" },
    ],
    outputFormat: "json",
    product: { name: "Brief Bot" },
    publisher: { name: "Kestrel", slug: "kestrel", isVerified: false, reputationTier: null },
    listing: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    status: "draft",
    instructions: "Be brief.",
    agentId: AGENT,
    orchestrationId: null,
    deploymentId: null,
    listingId: null,
    allowedTools: ["web_search"],
    maxAttempts: 3,
    maxConcurrentJobs: 7,
    activeJobs: 0,
    productAvailable: true,
    publishedAt: null,
    updatedAt: "2026-10-06T00:00:00.000Z",
    stats: { jobs: {} },
  } satisfies PublisherOffering;

  const loaded = draftFromOffering(offering);
  assert.equal(loaded.productId, AGENT);
  assert.equal(loaded.price, "2.50");
  assert.equal(loaded.slaAmount, "2");
  assert.equal(loaded.slaUnit, "hours");

  const { content, errors } = buildOffering(loaded);
  assert.deepEqual(errors, {});
  assert.deepEqual(content, {
    title: offering.title,
    description: offering.description,
    priceCents: 250,
    slaSeconds: 7200,
    inputSchema: offering.inputSchema,
    sampleInputs: offering.sampleInputs,
    instructions: "Be brief.",
    deliverableChecks: offering.deliverableChecks,
    outputFormat: "json",
    allowedTools: ["web_search"],
    maxAttempts: 3,
    maxConcurrentJobs: 7,
  });
});

test("a delivery time that is not a whole number of hours or days stays in minutes", () => {
  const base = { ...({} as PublisherOffering) };
  const at = (slaSeconds: number) =>
    draftFromOffering({
      ...base,
      productKind: "agent",
      agentId: AGENT,
      orchestrationId: null,
      deploymentId: null,
      title: "t",
      description: "d",
      priceCents: 100,
      slaSeconds,
      inputSchema: null,
      sampleInputs: [],
      instructions: null,
      deliverableChecks: [],
      outputFormat: "text",
      allowedTools: [],
      maxAttempts: 1,
      maxConcurrentJobs: 1,
    } as PublisherOffering);
  assert.deepEqual([at(300).slaAmount, at(300).slaUnit], ["5", "minutes"]);
  assert.deepEqual([at(5400).slaAmount, at(5400).slaUnit], ["90", "minutes"]);
  assert.deepEqual([at(172_800).slaAmount, at(172_800).slaUnit], ["2", "days"]);
});

test("a server refusal is shown on the part of the editor it is about", () => {
  assert.equal(serverIssueField("invalid_input_schema"), "inputSchema");
  assert.equal(serverIssueField("invalid_sample_input"), "sampleInputs");
  assert.equal(serverIssueField("product_not_sellable"), "productId");
  assert.equal(serverIssueField("invalid_deliverable_check"), null);
  assert.equal(serverIssueField(null), null);
});

test("the server's check problems land on the row they are about", () => {
  assert.deepEqual(
    checkIssues([
      { path: "/1/pattern", message: "backreferences are not supported" },
      { path: "/1", message: "too slow" },
      { path: "/3/schema/properties/a/type", message: "must be a known type" },
      { path: "", message: "at most 10 deliverable checks are allowed" },
    ]),
    {
      "checks.1": "backreferences are not supported; too slow",
      "checks.3": "must be a known type",
    },
  );
});
