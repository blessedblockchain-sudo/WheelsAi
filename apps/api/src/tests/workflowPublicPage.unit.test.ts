import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from "fastify";

import { createPaidWorkflowRoutes } from "../routes/paidWorkflow.js";
import { createPaidWorkflowRoutesProduction } from "../routes/paidWorkflowBindings.js";
import { paidWorkflowOpenAiModel } from "../routes/paidWorkflowCompletions.js";
import { paidUseOpenAiError } from "../services/openaiCompat.js";
import { saleHold, type SaleHoldDb } from "../services/orchestration.js";
import { PAID_USE_LIMITS, type PaidUseRefusal } from "../services/paidUse.js";
import { runPaidWorkflow, type PaidWorkflowResult } from "../services/paidWorkflow.js";
import { BALANCE_CENTS_HEADER, CHARGED_CENTS_HEADER, PLAN_USAGE_HEADER_NAMES } from "../services/usageHeaders.js";
import { MAX_WORKFLOW_INPUT_BYTES, MAX_WORKFLOW_PROMPT_CHARS } from "../services/workflowChat.js";
import { PAID_WORKFLOW_MAX_ACTIVE_RUNS, PAID_WORKFLOW_MAX_RUN_MS } from "../services/workflowListing.js";
import {
  PROMPT_ONLY_FORM,
  publicFormOf,
  WORKFLOW_API_REFUSALS,
  workflowApiPageOf,
  workflowPublicReadOf,
  readWorkflowPublicSource,
  type WorkflowPublicListing,
  type WorkflowPublicPageDeps,
} from "../services/workflowPublicPage.js";
import { CREATOR_ORG, KEY_CALLER, PLAN_LICENCE, PLAN_SUB, SESSION } from "./paidUseHarness.js";
import {
  paidWorkflowHarness,
  RUN_BODY,
  SLUG,
  STEP_LEAK,
  STEP_NAME,
  WORKFLOW,
  WORKFLOW_ID,
  WORKFLOW_LISTING,
  WORKFLOW_OWN_NAME,
  WORKFLOW_OWN_SLUG,
  type PaidWorkflowHarnessOptions,
} from "./paidWorkflowHarness.js";

// What anyone reads about a workflow on sale: GET /api/w/:slug (its page)
// and GET /api/w/:slug/api (its API page). What these pin: both are built
// from the listing, its plans and the workflow's form, field by field, and
// name nothing of what is inside the workflow or of who sells it; every slug
// that has no page is the same 404; a form with no fields is one text box;
// and every refusal the API page tells is what the two doors really answer.
// A listing taken off sale keeps both while somebody's plan on it runs.

const LISTING_ID = "lst-w1";
const AGENT_LISTING_SLUG = "support-bot";
const AGENT_ID = "agent-step-1";
const STEP_MODEL = "wheelsai/llama-3.1-8b";

const LISTING: WorkflowPublicListing = {
  id: LISTING_ID,
  slug: SLUG,
  title: "Launch brief writer",
  shortDescription: "A one-page launch brief from a topic.",
  publisherId: CREATOR_ORG,
  status: "published",
  sells: "use",
  pricingModel: "per_request",
  pricePerRequestCents: 5n,
  agentId: null,
  orchestrationId: WORKFLOW_ID,
};

const AGENT_LISTING: WorkflowPublicListing = {
  ...LISTING,
  id: "lst-a1",
  slug: AGENT_LISTING_SLUG,
  agentId: AGENT_ID,
  orchestrationId: null,
};

const PLANS = [
  { id: "plan-s", name: "Starter", priceCents: 900n, includedUses: 200, extraUsePriceCents: 4n },
  { id: "plan-l", name: "Large", priceCents: 4_000n, includedUses: 1_000, extraUsePriceCents: null },
];

/** The clock of the test of a running plan. */
const NOW = new Date("2026-10-14T12:00:00.000Z");
const LATER = new Date("2026-11-01T00:00:00.000Z");
const EARLIER = new Date("2026-10-01T00:00:00.000Z");

/** A buyer's subscription to a listing, as the test of a running plan reads it. */
interface Sub {
  listingId: string;
  status: string;
  currentPeriodEnd: Date;
}

/** The two tables saleHold reads, over the world's rows. */
function saleHoldDbOf(listings: WorkflowPublicListing[], subs: Sub[]): SaleHoldDb {
  return {
    agentListing: {
      findFirst: async ({ where }) => {
        const row = listings.find(
          (listing) => listing.orchestrationId === where.orchestrationId && listing.publisherId === where.publisherId,
        );
        return row ? { id: row.id, status: row.status } : null;
      },
    },
    agentSubscription: {
      count: async ({ where }) =>
        subs.filter(
          (sub) =>
            sub.listingId === where.listingId &&
            sub.status === where.status &&
            sub.currentPeriodEnd.getTime() > where.currentPeriodEnd.gt.getTime(),
        ).length,
    },
  };
}

interface World {
  listings?: Array<WorkflowPublicListing & Record<string, unknown>>;
  /** The buyers' subscriptions: none unless a test says. */
  subs?: Sub[];
  plans?: typeof PLANS;
  /** What the form read hands back for the workflow; null when it is not in the publisher's organization. */
  workflow?: Record<string, unknown> | null;
  publicApiUrl?: string | null;
}

/** The reads, as the real ones answer: each row carries more than the answer may say. */
function depsOf(world: World = {}, log: string[] = []): WorkflowPublicPageDeps {
  const listings = world.listings ?? [
    // The row as the database holds it also has the publisher's name and its counts.
    { ...LISTING, publisherName: "Acme Creator Org", activeInstalls: 412, totalInstalls: 977 },
    AGENT_LISTING,
  ];
  const workflow =
    world.workflow === undefined
      ? {
          ...WORKFLOW,
          name: WORKFLOW_OWN_NAME,
          slug: WORKFLOW_OWN_SLUG,
          steps: [{ name: STEP_NAME, agentId: AGENT_ID, modelId: STEP_MODEL, inputTokens: 1200 }],
          inputSchema: {
            $id: `https://example.test/${CREATOR_ORG}/${WORKFLOW_OWN_SLUG}`,
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              topic: { type: "string", title: "Topic", description: "What the brief is about", minLength: 1 },
              tone: { type: "string", enum: ["plain", "bold"], default: "plain" },
            },
            required: ["topic"],
            additionalProperties: false,
          },
        }
      : world.workflow;
  return {
    loadListingBySlug: async (slug) => {
      log.push(`listing:${slug}`);
      return listings.find((row) => row.slug === slug) ?? null;
    },
    loadPlans: async (listingId) => {
      log.push(`plans:${listingId}`);
      return (world.plans ?? []).map((plan) => ({ ...plan, position: 3, listingId, status: "active" }));
    },
    loadWorkflowForm: async (ref) => {
      log.push(`workflow:${ref.workflowId}:${ref.orgId}`);
      if (!workflow) return null;
      return ref.workflowId === workflow.id && ref.orgId === workflow.orgId ? (workflow as { inputSchema: unknown }) : null;
    },
    // The real test of a running plan, over the world's rows, as the binding asks it.
    loadSaleHold: async (ref, now) => {
      log.push(`hold:${ref.workflowId}:${ref.orgId}:${now.toISOString()}`);
      return saleHold(ref.workflowId, ref.orgId, now, saleHoldDbOf(listings, world.subs ?? []));
    },
    now: () => NOW,
    publicApiUrl: world.publicApiUrl === undefined ? "https://api.wheelsai.test/" : world.publicApiUrl,
  };
}

async function server(world: World = {}): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("auth", null);
  const refuse: preHandlerAsyncHookHandler = async (_request, reply) => {
    reply.status(401).send({ error: "Unauthorized" });
  };
  await app.register(
    createPaidWorkflowRoutes({
      // Neither read is guarded: a guard that refuses everyone changes nothing.
      guards: { auth: refuse, use: refuse },
      paidWorkflow: () => {
        throw new Error("the pages open to anyone never build the paid run");
      },
      publicPage: () => depsOf(world),
    }),
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

async function get(world: World, url: string) {
  const app = await server(world);
  try {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json() as Record<string, any>, text: res.body };
  } finally {
    await app.close();
  }
}

async function sourceOf(world: World = {}, slug = SLUG) {
  const source = await readWorkflowPublicSource(slug, depsOf(world));
  assert.ok(source, "the workflow has a page");
  return source;
}

// ============================================
// GET /api/w/:slug
// ============================================

test("the page of a workflow with plans: the listing's words, its price per run, its plans and its form", async () => {
  const read = workflowPublicReadOf(await sourceOf({ plans: PLANS }));
  assert.deepEqual(read, {
    kind: "workflow",
    listingId: LISTING_ID,
    slug: SLUG,
    title: "Launch brief writer",
    description: "A one-page launch brief from a topic.",
    pricingModel: "per_request",
    unit: "run",
    priceCents: 5,
    plans: [
      { id: "plan-s", name: "Starter", priceCents: 900, includedUses: 200, extraUsePriceCents: 4 },
      { id: "plan-l", name: "Large", priceCents: 4000, includedUses: 1000, extraUsePriceCents: null },
    ],
    trial: null,
    keepsCopy: true,
    maxRunMinutes: 10,
    input: {
      schema: {
        type: "object",
        properties: {
          topic: { type: "string", title: "Topic", description: "What the brief is about", minLength: 1 },
          tone: { type: "string", enum: ["plain", "bold"], default: "plain" },
        },
        required: ["topic"],
        additionalProperties: false,
      },
      maxInputBytes: MAX_WORKFLOW_INPUT_BYTES,
      maxPromptChars: MAX_WORKFLOW_PROMPT_CHARS,
    },
  });
  // The longest run is the one constant, in minutes.
  assert.equal(read.maxRunMinutes * 60_000, PAID_WORKFLOW_MAX_RUN_MS);
});

test("the page of a workflow with no plan answers an empty list, and so does one whose plans cannot be read", async () => {
  assert.deepEqual(workflowPublicReadOf(await sourceOf({ plans: [] })).plans, []);
  const deps = depsOf();
  deps.loadPlans = async () => {
    throw new Error("db down");
  };
  const source = await readWorkflowPublicSource(SLUG, deps);
  assert.deepEqual(source && workflowPublicReadOf(source).plans, []);
});

test("the read over HTTP: open to anyone, the listing's id as listingId, and no other id but the plans'", async () => {
  const res = await get({ plans: PLANS }, `/api/w/${SLUG}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.listingId, LISTING_ID);
  assert.equal(res.body.kind, "workflow");
  assert.ok(!("orchestrationId" in res.body));
  assert.ok(!res.text.includes(WORKFLOW_ID), "the workflow's id is never sent");
  // Every value that looks like an id is the listing's or a plan's.
  const ids = [...res.text.matchAll(/"(\w*[iI]d)":"([^"]+)"/g)].map((match) => `${match[1]}=${match[2]}`);
  assert.deepEqual(ids, [`listingId=${LISTING_ID}`, "id=plan-s", "id=plan-l"]);
  // A slug in capitals is the same listing, as a paid run reads it.
  assert.equal((await get({}, `/api/w/${SLUG.toUpperCase()}`)).body.listingId, LISTING_ID);
});

test("an unknown slug, an agent's listing, a draft, a stopped listing and a missing workflow are each the same 404", async () => {
  const cases: Array<[string, World, string]> = [
    ["an unknown slug", {}, "/api/w/no-such-listing"],
    ["a slug no listing can have", {}, "/api/w/Not%20A%20Slug!"],
    ["the slug of an agent's listing", {}, `/api/w/${AGENT_LISTING_SLUG}`],
    ["a draft", { listings: [{ ...LISTING, status: "draft" }] }, `/api/w/${SLUG}`],
    ["a stopped listing", { listings: [{ ...LISTING, status: "archived" }] }, `/api/w/${SLUG}`],
    ["a listing under review", { listings: [{ ...LISTING, status: "pending_review" }] }, `/api/w/${SLUG}`],
    ["a row that sells copies", { listings: [{ ...LISTING, sells: "copies" }] }, `/api/w/${SLUG}`],
    ["a row sold by the month", { listings: [{ ...LISTING, pricingModel: "monthly" }] }, `/api/w/${SLUG}`],
    ["a row with no price", { listings: [{ ...LISTING, pricePerRequestCents: null }] }, `/api/w/${SLUG}`],
    ["a workflow no longer in the publisher's organization", { workflow: null }, `/api/w/${SLUG}`],
  ];
  for (const [name, world, url] of cases) {
    for (const path of [url, `${url}/api`]) {
      const res = await get(world, path);
      assert.equal(res.status, 404, `${name}: ${path}`);
      assert.deepEqual(res.body, { error: "workflow_not_found" }, `${name}: ${path}`);
    }
  }
});

test("a listing taken off sale keeps both pages, word for word, while somebody's plan on it still runs", async () => {
  const running: Sub = { listingId: LISTING_ID, status: "active", currentPeriodEnd: LATER };
  for (const path of [`/api/w/${SLUG}`, `/api/w/${SLUG}/api`]) {
    const onSale = await get({ plans: PLANS }, path);
    assert.equal(onSale.status, 200, path);
    for (const status of ["archived", "draft"]) {
      const stopped = await get({ plans: PLANS, listings: [{ ...LISTING, status }], subs: [running] }, path);
      assert.equal(stopped.status, 200, `${status}: ${path}`);
      // Nothing new in it: the same answer as while it was on sale, but that a
      // listing no longer on sale offers no plan, as an agent's does not.
      assert.deepEqual(stopped.body, { ...onSale.body, plans: [] }, `${status}: ${path}`);
    }
  }
  // The plan is read by the workflow and its publisher, at the injected time, only for a listing not published.
  const log: string[] = [];
  await readWorkflowPublicSource(SLUG, depsOf({ listings: [{ ...LISTING, status: "archived" }], subs: [running] }, log));
  assert.deepEqual(log.slice(0, 3), [
    `listing:${SLUG}`,
    `hold:${WORKFLOW_ID}:${CREATOR_ORG}:${NOW.toISOString()}`,
    `workflow:${WORKFLOW_ID}:${CREATOR_ORG}`,
  ]);
  const published: string[] = [];
  await readWorkflowPublicSource(SLUG, depsOf({ subs: [running] }, published));
  assert.ok(!published.some((line) => line.startsWith("hold:")), "a published listing is not asked about plans");
});

test("a listing taken off sale with no plan still running, or none at all, is the same 404", async () => {
  const stopped = { ...LISTING, status: "archived" };
  const cases: Array<[string, Sub[]]> = [
    ["no plan", []],
    ["a plan whose period ended", [{ listingId: LISTING_ID, status: "active", currentPeriodEnd: EARLIER }]],
    ["a plan whose period ends now", [{ listingId: LISTING_ID, status: "active", currentPeriodEnd: NOW }]],
    ["a plan that was cancelled", [{ listingId: LISTING_ID, status: "cancelled", currentPeriodEnd: LATER }]],
    ["a plan that expired", [{ listingId: LISTING_ID, status: "expired", currentPeriodEnd: LATER }]],
    ["a plan on another listing", [{ listingId: "lst-other", status: "active", currentPeriodEnd: LATER }]],
  ];
  for (const [name, subs] of cases) {
    for (const path of [`/api/w/${SLUG}`, `/api/w/${SLUG}/api`]) {
      const res = await get({ listings: [stopped], subs }, path);
      assert.equal(res.status, 404, `${name}: ${path}`);
      assert.deepEqual(res.body, { error: "workflow_not_found" }, `${name}: ${path}`);
    }
  }
});

test("a running plan opens no page that has none for another reason", async () => {
  const running = (listingId: string): Sub[] => [{ listingId, status: "active", currentPeriodEnd: LATER }];
  const stopped = { ...LISTING, status: "archived" };
  const cases: Array<[string, World, string]> = [
    ["the slug of an agent's listing", { subs: running(AGENT_LISTING.id) }, `/api/w/${AGENT_LISTING_SLUG}`],
    ["a stopped agent's listing", { listings: [{ ...AGENT_LISTING, status: "archived" }], subs: running(AGENT_LISTING.id) }, `/api/w/${AGENT_LISTING_SLUG}`],
    ["a row that sells copies", { listings: [{ ...stopped, sells: "copies" }], subs: running(LISTING_ID) }, `/api/w/${SLUG}`],
    ["a row sold by the month", { listings: [{ ...stopped, pricingModel: "monthly" }], subs: running(LISTING_ID) }, `/api/w/${SLUG}`],
    ["a row with no price", { listings: [{ ...stopped, pricePerRequestCents: null }], subs: running(LISTING_ID) }, `/api/w/${SLUG}`],
    ["a workflow no longer in the publisher's organization", { listings: [stopped], subs: running(LISTING_ID), workflow: null }, `/api/w/${SLUG}`],
  ];
  for (const [name, world, url] of cases) {
    for (const path of [url, `${url}/api`]) {
      const res = await get(world, path);
      assert.equal(res.status, 404, `${name}: ${path}`);
      assert.deepEqual(res.body, { error: "workflow_not_found" }, `${name}: ${path}`);
    }
  }
});

test("a slug no listing can have is not looked up, and the workflow is read in the publisher's organization only", async () => {
  const log: string[] = [];
  assert.equal(await readWorkflowPublicSource("-bad", depsOf({}, log)), null);
  assert.equal(await readWorkflowPublicSource("a".repeat(121), depsOf({}, log)), null);
  assert.deepEqual(log, []);

  await readWorkflowPublicSource(SLUG, depsOf({}, log));
  assert.deepEqual(log.slice(0, 2), [`listing:${SLUG}`, `workflow:${WORKFLOW_ID}:${CREATOR_ORG}`]);
  // The same workflow in another organization is not this listing's.
  const moved = await readWorkflowPublicSource(SLUG, depsOf({ workflow: { ...WORKFLOW, orgId: "org-other" } }));
  assert.equal(moved, null);
});

test("a workflow whose form has no fields gets one text box, the key prompt", () => {
  for (const schema of [null, undefined, {}, { type: "object" }, { type: "object", properties: {} }, "not a schema", []]) {
    assert.deepEqual(publicFormOf(schema), PROMPT_ONLY_FORM, JSON.stringify(schema));
  }
  assert.deepEqual(PROMPT_ONLY_FORM, {
    type: "object",
    properties: { prompt: { type: "string", minLength: 1, maxLength: MAX_WORKFLOW_PROMPT_CHARS } },
    required: ["prompt"],
  });
  // Each answer is its own copy: a reader that changes one changes nothing else.
  const first = publicFormOf({});
  (first.required as string[]).push("x");
  assert.deepEqual(publicFormOf({}).required, ["prompt"]);
});

test("the page of a field-less workflow says that form, over HTTP", async () => {
  const res = await get({ workflow: { ...WORKFLOW, inputSchema: {} } }, `/api/w/${SLUG}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.input.schema, PROMPT_ONLY_FORM);
});

test("a form is copied keyword by keyword, nested ones too: what is not a form's word stays behind", () => {
  const form = publicFormOf({
    $id: "https://creator.example/internal",
    type: "object",
    "x-owner-note": "uses the house model",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string", $comment: "secret" } } },
        maxItems: 3,
      },
    },
    additionalProperties: { type: "string", "x-cost": 3 },
  });
  assert.deepEqual(form, {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object", properties: { label: { type: "string" } } }, maxItems: 3 },
    },
    additionalProperties: { type: "string" },
  });
});

// ============================================
// GET /api/w/:slug/api
// ============================================

test("the API page of a workflow: its two addresses, model w/<slug>, the unit run, the limits and the headers", async () => {
  const model = paidWorkflowOpenAiModel(SLUG);
  const page = workflowApiPageOf(await sourceOf({ plans: PLANS }), { model, publicApiUrl: "https://api.wheelsai.test/" });
  const { refusals, ...rest } = page;
  assert.deepEqual(rest, {
    kind: "workflow",
    name: "Launch brief writer",
    listingId: LISTING_ID,
    listingSlug: SLUG,
    baseUrl: "https://api.wheelsai.test",
    model: `w/${SLUG}`,
    endpoints: [
      { use: "run", method: "POST", path: `/api/w/${SLUG}/run` },
      { use: "openai", method: "POST", path: "/v1/chat/completions" },
      { use: "access", method: "GET", path: `/api/w/${SLUG}/access` },
    ],
    pricingModel: "per_request",
    unit: "run",
    priceCents: 5,
    plans: [
      { id: "plan-s", name: "Starter", priceCents: 900, includedUses: 200, extraUsePriceCents: 4 },
      { id: "plan-l", name: "Large", priceCents: 4000, includedUses: 1000, extraUsePriceCents: null },
    ],
    trial: null,
    limits: {
      perMinute: PAID_USE_LIMITS.perBuyerPerMinute,
      perDayWithoutPlan: PAID_USE_LIMITS.perBuyerPerDay,
      maxActiveRuns: PAID_WORKFLOW_MAX_ACTIVE_RUNS,
    },
    maxRunMinutes: 10,
    input: { maxInputBytes: MAX_WORKFLOW_INPUT_BYTES, maxPromptChars: MAX_WORKFLOW_PROMPT_CHARS },
    usageHeaders: { always: [CHARGED_CENTS_HEADER, BALANCE_CENTS_HEADER], onPlan: [...PLAN_USAGE_HEADER_NAMES] },
  });
  assert.deepEqual(refusals, WORKFLOW_API_REFUSALS);
  // One entry for each code: the page draws them by it.
  assert.equal(new Set(refusals.map((refusal) => refusal.code)).size, refusals.length);
  // No address of the page is the owner's own workflow call or an agent's.
  assert.doesNotMatch(JSON.stringify(rest), /workflow\/|\/a\/|"a\//);

  // The third limit is the one the doors hold a busy workflow to.
  assert.equal(page.limits.maxActiveRuns, 3);
  assert.equal(workflowApiPageOf(await sourceOf(), { model, publicApiUrl: null }).baseUrl, null);
  assert.equal(workflowApiPageOf(await sourceOf(), { model, publicApiUrl: "not an address" }).baseUrl, null);
  assert.deepEqual(workflowApiPageOf(await sourceOf({ plans: [] }), { model }).plans, []);
});

test("the file both answers are built in loads no route, no environment and no database", () => {
  const source = readFileSync(new URL("../services/workflowPublicPage.ts", import.meta.url), "utf8");
  const from = [...source.matchAll(/^import[^;]*?from "([^"]+)";/gms)].map((match) => match[1]!);
  assert.ok(from.length > 0);
  for (const path of from) {
    assert.ok(path.startsWith("./"), `services/workflowPublicPage.ts imports ${path}`);
  }
});

test("the production plugin registers both pages open to anyone", async () => {
  // Registering builds nothing: no request is sent, and nothing connects.
  const app = Fastify();
  app.decorateRequest("auth", null);
  await app.register(createPaidWorkflowRoutesProduction(), { prefix: "/api" });
  await app.ready();
  try {
    for (const url of ["/api/w/:slug", "/api/w/:slug/api"]) {
      assert.ok(app.hasRoute({ method: "GET", url }), url);
    }
  } finally {
    await app.close();
  }
});

test("the API page over HTTP is open to anyone and tells the server's public address", async () => {
  const res = await get({ plans: PLANS }, `/api/w/${SLUG}/api`);
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, "workflow");
  assert.equal(res.body.baseUrl, "https://api.wheelsai.test");
  assert.equal(res.body.model, `w/${SLUG}`);
  assert.equal(res.body.limits.maxActiveRuns, PAID_WORKFLOW_MAX_ACTIVE_RUNS);
  assert.equal(res.body.refusals.length, WORKFLOW_API_REFUSALS.length);
});

test("nothing in either answer names the workflow's own name or slug, a step, an agent, a model, tokens, the creator or its buyers", async () => {
  for (const url of [`/api/w/${SLUG}`, `/api/w/${SLUG}/api`]) {
    const { status, text } = await get({ plans: PLANS }, url);
    assert.equal(status, 200, url);
    for (const secret of [
      WORKFLOW_OWN_NAME,
      WORKFLOW_OWN_SLUG,
      WORKFLOW_ID,
      STEP_NAME,
      AGENT_ID,
      STEP_MODEL,
      CREATOR_ORG,
      "Acme Creator Org",
      "inputTokens",
      "1200",
      "412",
      "977",
      "publisher",
      "Installs",
      "steps",
    ]) {
      assert.ok(!text.includes(secret), `${url} names ${secret}`);
    }
    assert.doesNotMatch(text, /tokens?\b/i, url);
  }
});

// ============================================
// The refusals, held to the two doors
// ============================================

/** A paid run on the real service, and the refusal it answered. */
async function refusalOf(options: PaidWorkflowHarnessOptions, body: unknown = RUN_BODY, caller = SESSION): Promise<PaidUseRefusal> {
  const h = paidWorkflowHarness(options);
  const result: PaidWorkflowResult = await runPaidWorkflow(
    { caller, slug: SLUG, body, signal: new AbortController().signal },
    h.deps,
  );
  assert.equal(result.kind, "refused", Object.keys(options).join(","));
  return (result as Extract<PaidWorkflowResult, { kind: "refused" }>).refusal;
}

test("each refusal the API page tells has the status and the code POST /run answers, and on /v1 what /v1 answers", async () => {
  const told = new Map(WORKFLOW_API_REFUSALS.map((refusal) => [refusal.code, refusal]));
  const real: PaidUseRefusal[] = [
    await refusalOf({}, RUN_BODY, { ...SESSION, orgId: CREATOR_ORG }),
    await refusalOf({ modelStepsServe: false }),
    await refusalOf({ licence: null }),
    await refusalOf({ listing: { ...WORKFLOW_LISTING, pricePerRequestCents: 9n } }),
    await refusalOf({ balance: 4n }),
    await refusalOf({}, { input: { topic: 7 } }),
    await refusalOf({}, { input: { topic: "x".repeat(MAX_WORKFLOW_INPUT_BYTES + 1) } }),
    await refusalOf({ limits: { perBuyerPerMinute: 0 } }),
    await refusalOf({ activeRead: 3 }),
    await refusalOf({ capacity: 0, activeRead: 0 }),
    await refusalOf({ ending: { status: "failed", timedOut: false } }),
    await refusalOf({ ending: { status: "failed", timedOut: true } }),
    await refusalOf({ answer: STEP_LEAK }),
    await refusalOf({
      licence: PLAN_LICENCE,
      sub: { ...PLAN_SUB, status: "expired", currentPeriodEnd: new Date("2026-10-05T00:00:00.000Z") },
    }),
    await refusalOf({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, usedInPeriod: 500, extraUsePriceCents: null } }),
    await refusalOf({}, RUN_BODY, { ...KEY_CALLER, apiKeyId: null }),
    await refusalOf({ keyCaps: { maxUse: null, daily: null } }, RUN_BODY, KEY_CALLER),
    await refusalOf({ keyCaps: { maxUse: 4n, daily: 1_000n } }, RUN_BODY, KEY_CALLER),
    await refusalOf({ keyCaps: { maxUse: 50n, daily: 100n, spent: 98n } }, RUN_BODY, KEY_CALLER),
  ];
  const codes = real.map((refusal) => refusal.code);
  assert.deepEqual(codes, [
    "own_workflow",
    "workflow_unavailable",
    "use_not_started",
    "pricing_changed",
    "insufficient_credits",
    "input_invalid",
    "input_too_large",
    "rate_limited",
    "workflow_busy",
    "workflow_busy",
    "run_failed",
    "run_timed_out",
    "answer_withheld",
    "plan_ended",
    "plan_used_up",
    "api_key_spend_caps_missing",
    "api_key_spend_caps_missing",
    "api_key_use_price_cap_exceeded",
    "api_key_daily_cap_exceeded",
  ]);
  // Both ways: each refusal the page tells is one the door really gives.
  assert.deepEqual(new Set(codes), new Set(WORKFLOW_API_REFUSALS.map((refusal) => refusal.code)));
  for (const refusal of real) {
    const page = told.get(refusal.code);
    assert.ok(page, `the API page does not tell ${refusal.code}`);
    assert.equal(page.status, refusal.status, refusal.code);
    const v1 = paidUseOpenAiError(refusal);
    assert.deepEqual(page.openai, { code: v1.body.error.code, status: v1.status }, refusal.code);
  }
  // Where the run says a refusal in words of its own, the page says those words,
  // by every way the run reaches it: a key that cannot be named and a key with no caps.
  for (const code of ["own_workflow", "api_key_spend_caps_missing"] as const) {
    for (const door of real.filter((refusal) => refusal.code === code)) {
      assert.equal(told.get(code)!.message, door.message, code);
    }
  }
  assert.equal(told.get("own_workflow")!.message, "This is your workflow. This is the page people who pay see.");
  assert.equal(
    told.get("api_key_spend_caps_missing")!.message,
    "This API key has no spend caps, so it cannot pay for a run of a workflow. Create a key with agents:use and both caps.",
  );
  // The input that is too long: 413 on the run address, 400 on /v1.
  assert.deepEqual(
    [told.get("input_too_large")!.status, told.get("input_too_large")!.openai],
    [413, { code: "validation_failed", status: 400 }],
  );
  // Only the busy found after the charge asks a client on /v1 not to send it again by itself.
  const [before, after] = real.filter((refusal) => refusal.code === "workflow_busy");
  assert.equal(paidUseOpenAiError(before!).headers["x-should-retry"], undefined);
  assert.equal(paidUseOpenAiError(after!).headers["x-should-retry"], "false");
  assert.ok(told.get("workflow_busy")!.message.includes("not to send it again by itself"));
  assert.ok(told.get("workflow_busy")!.message.includes(`${PAID_WORKFLOW_MAX_ACTIVE_RUNS} runs at once, shared by everyone`));
  // The form's list of what is wrong rides on the run address only: /v1 sends the sentence alone,
  // so the page does not promise a list there.
  const invalid = real.find((refusal) => refusal.code === "input_invalid")!;
  assert.ok(invalid.details && invalid.details.length > 0);
  assert.ok(!("details" in paidUseOpenAiError(invalid).body.error));
  assert.match(told.get("input_invalid")!.message, /On the run address the answer lists what to change\.$/);
});

test("the refusals a plan and a key meet, which an agent's API page tells in the same words, are its own", () => {
  const told = new Map(WORKFLOW_API_REFUSALS.map((refusal) => [refusal.code, refusal]));
  assert.deepEqual(
    [told.get("plan_ended")!.status, told.get("plan_used_up")!.status],
    [402, 429],
  );
  for (const code of ["api_key_spend_caps_missing", "api_key_use_price_cap_exceeded", "api_key_daily_cap_exceeded"] as const) {
    assert.equal(told.get(code)!.status, 403, code);
  }
  // No sentence of a workflow's page says agent, and none says "Nothing was charged" of a run that was charged.
  for (const refusal of WORKFLOW_API_REFUSALS) {
    assert.doesNotMatch(refusal.message, /\bagent\b/i, refusal.code);
    assert.ok(/^[\x20-\x7e]*$/.test(refusal.message), refusal.code);
  }
  for (const code of ["run_failed", "run_timed_out", "answer_withheld"] as const) {
    assert.doesNotMatch(told.get(code)!.message, /Nothing was charged/, code);
  }
});
