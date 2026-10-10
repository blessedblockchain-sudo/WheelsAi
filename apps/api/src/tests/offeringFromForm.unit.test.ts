import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { prisma } from "../lib/prisma.js";
import { createOfferingRoutes } from "../routes/offerings.js";
import { publicTaskForm } from "../services/agentKind.js";
import { TASK_MESSAGES } from "../services/agentTask.js";
import { buildJobRunnerDeps } from "../services/buildJobRunnerDeps.js";
import { buildOfferingStore } from "../services/buildOfferingServiceDeps.js";
import { renderJobBrief } from "../services/jobPrompt.js";
import {
  createOffering,
  FORM_MESSAGES,
  getOwnedOffering,
  getPublicOffering,
  listOwnedOfferings,
  OfferingError,
  offeringTermsVersion,
  searchPublicOfferings,
  setOfferingStatus,
  testRunOffering,
  updateOffering,
} from "../services/offerings.js";
import {
  AGENT,
  BUYER,
  installTestAuth,
  makeMarket,
  owner,
  PUB,
  testGuards,
  VALID_OFFERING,
  WORKFLOW,
  type Market,
} from "./jobsApiFakes.js";

// An offering whose form is the agent's own task form, and forms that keep
// the order of their questions through a database that does not.

const TASK_AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad";

// Keys chosen so that neither the alphabet nor JSONB's order (shorter keys
// first) is the order they are asked in.
const FIELDS = [
  { key: "topic", label: "Topic", type: "short_text", required: true },
  { key: "audience", label: "Who is it for", type: "long_text", required: false },
  { key: "tone", label: "Tone", type: "choice", required: true, options: ["Plain", "Formal"] },
  { key: "aa", label: "Anything else", type: "short_text", required: false },
];
const FORM_ORDER = ["topic", "audience", "tone", "aa"];

const BASE = {
  productKind: "agent" as const,
  agentId: TASK_AGENT,
  title: "A written brief",
  description: "A one-page brief on the topic you name, for the reader you name.",
  priceCents: 2_000,
  slaSeconds: 3_600,
};

// A schema written by hand, its questions in an order no sort gives.
const HAND_SCHEMA = {
  type: "object",
  required: ["url"],
  additionalProperties: false,
  properties: {
    url: { type: "string" },
    depth: { type: "integer" },
    audience: { type: "string" },
    notes: { type: "string" },
    b: { type: "string" },
  },
};
const HAND_ORDER = ["url", "depth", "audience", "notes", "b"];
const HAND_INPUT = { b: "last", notes: "n", audience: "founders", depth: 2, url: "https://example.com" };

/** A value as JSONB gives it back: every object's keys shorter first, then by bytes. */
function jsonb<T>(value: T): T {
  if (Array.isArray(value)) return value.map(jsonb) as T;
  if (typeof value !== "object" || value === null) return value;
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map((key) => [key, jsonb((value as Record<string, unknown>)[key])])) as T;
}

const keysOf = (schema: unknown) => Object.keys((schema as { properties: Record<string, unknown> }).properties);

/** The in-memory market with a task agent, and a store that forgets key order as the database does. */
function market(): Market {
  const m = makeMarket();
  m.agents.set(TASK_AGENT, {
    id: TASK_AGENT,
    orgId: PUB,
    name: "Brief Writer",
    entrypoint: "chat",
    isMarketplaceCopy: false,
    listingId: null,
    agentKind: "task",
    kindConfig: { task: { fields: FIELDS } },
  });
  const { store } = m.offerings;
  const create = store.create;
  const updateOwned = store.updateOwned;
  store.create = (data) => create({ ...data, inputSchema: jsonb(data.inputSchema) });
  store.updateOwned = (orgId, id, patch) =>
    updateOwned(orgId, id, {
      ...patch,
      ...(patch.inputSchema !== undefined && { inputSchema: jsonb(patch.inputSchema) }),
    });
  return m;
}

function setForm(m: Market, fields: unknown[]): void {
  m.agents.set(TASK_AGENT, { ...m.agents.get(TASK_AGENT)!, kindConfig: { task: { fields } } });
}

/** Offerings written through the API (the in-memory database seeds one of its own for the escrow tests). */
const written = (m: Market) => [...m.db.state.offerings.values()].filter((row) => row.slug).length;

const code = (expected: string, message?: string) => (err: unknown) => {
  assert.ok(err instanceof OfferingError, String(err));
  assert.equal(err.code, expected);
  if (message !== undefined) assert.equal(err.message, message);
  return true;
};

async function routes(m: Market = market()) {
  const app = Fastify();
  installTestAuth(app);
  await app.register(
    createOfferingRoutes({
      offerings: m.offerings,
      jobs: m.jobs,
      testRun: {
        tryProduct: async () => ({ passed: true, output: null, checkResults: [] }),
        maxRunMs: 1_000,
        freeTierLimitMessage: "free-model limit reached",
      },
      guards: testGuards(),
    }),
    { prefix: "/api/offerings" },
  );
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/offerings", headers: owner(PUB), payload });
  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/offerings/${id}`, headers: owner(PUB), payload });
  return { app, m, post, patch };
}

// ============================================
// An offering made from the agent's form
// ============================================

test("fromAgentForm stores the agent's own task form, in the order its questions are asked", async () => {
  const m = market();
  const derived = publicTaskForm({ task: { fields: FIELDS } });
  assert.deepEqual(keysOf(derived.schema), FORM_ORDER);

  const offering = await createOffering(m.offerings, PUB, { ...BASE, fromAgentForm: true });
  // The schema the public task run checks an input against, nothing else.
  assert.deepEqual(offering.inputSchema, derived.schema);
  assert.deepEqual(keysOf(offering.inputSchema), FORM_ORDER);
  assert.equal(offering.formInSync, true);

  const row = m.offeringRow(offering.id);
  assert.equal(row.inputFromAgentForm, true);
  assert.deepEqual(row.inputOrder, FORM_ORDER);
  // What the database holds lost the order; every read puts it back.
  assert.notDeepEqual(keysOf(row.inputSchema), FORM_ORDER);
  assert.deepEqual(keysOf((await getOwnedOffering(m.offerings, PUB, offering.id)).inputSchema), FORM_ORDER);
  const [listed] = await listOwnedOfferings(m.offerings, PUB);
  assert.deepEqual(keysOf(listed!.inputSchema), FORM_ORDER);
  assert.equal(listed!.formInSync, true);

  await setOfferingStatus(m.offerings, PUB, offering.id, "activate");
  const page = await getPublicOffering(m.offerings, offering.slug);
  assert.deepEqual(keysOf(page.inputSchema), FORM_ORDER);
  // Whether the form is the agent's is the publisher's to know.
  assert.equal("formInSync" in page, false);
});

test("a task agent that has no form of its own gives the default form", async () => {
  const m = market();
  m.agents.set(TASK_AGENT, { ...m.agents.get(TASK_AGENT)!, kindConfig: null });
  const offering = await createOffering(m.offerings, PUB, { ...BASE, fromAgentForm: true });
  assert.deepEqual(offering.inputSchema, publicTaskForm(null).schema);
  assert.deepEqual(keysOf(offering.inputSchema), ["your_request"]);
  assert.equal(offering.formInSync, true);
});

test("the agent's form goes through the checks a hand-written schema does", async () => {
  const m = market();
  // A sample is checked against the derived schema.
  await assert.rejects(
    createOffering(m.offerings, PUB, { ...BASE, fromAgentForm: true, sampleInputs: [{ audience: "founders" }] }),
    code("invalid_sample_input"),
  );
  const offering = await createOffering(m.offerings, PUB, {
    ...BASE,
    fromAgentForm: true,
    sampleInputs: [{ topic: "Pricing", tone: "Plain" }],
  });
  assert.equal(offering.formInSync, true);

  // On an edit the stored samples are checked against the form it becomes.
  const byHand = await createOffering(m.offerings, PUB, {
    ...BASE,
    title: "By hand first",
    inputSchema: HAND_SCHEMA,
    sampleInputs: [{ url: "https://example.com" }],
  });
  await assert.rejects(
    updateOffering(m.offerings, PUB, byHand.id, { fromAgentForm: true }),
    code("invalid_sample_input"),
  );
  assert.equal(m.offeringRow(byHand.id).inputFromAgentForm, false);
  const taken = await updateOffering(m.offerings, PUB, byHand.id, { fromAgentForm: true, sampleInputs: [] });
  assert.equal(taken.formInSync, true);
  assert.deepEqual(keysOf(taken.inputSchema), FORM_ORDER);
});

test("a schema and the flag together are refused with 400, on create and on update", async () => {
  const { post, patch, m } = await routes();
  const both = await post({ ...BASE, fromAgentForm: true, inputSchema: HAND_SCHEMA });
  assert.equal(both.statusCode, 400);
  assert.deepEqual(both.json(), {
    error: "invalid_request",
    message: "The request is not valid",
    details: [{ path: "/fromAgentForm", message: FORM_MESSAGES.bothForms }],
  });
  // "No form" is a form too.
  assert.equal((await post({ ...BASE, fromAgentForm: true, inputSchema: null })).statusCode, 400);
  assert.equal(written(m), 0);

  const created = await post({ ...BASE, fromAgentForm: true });
  assert.equal(created.statusCode, 201);
  const { id } = created.json().offering as { id: string };
  const edited = await patch(id, { fromAgentForm: true, inputSchema: HAND_SCHEMA });
  assert.equal(edited.statusCode, 400);
  assert.equal(edited.json().details[0].message, FORM_MESSAGES.bothForms);
  assert.equal(m.offeringRow(id).inputFromAgentForm, true);

  // false is "not asked for": a schema beside it is an ordinary save.
  assert.equal((await post({ ...BASE, title: "Second", fromAgentForm: false, inputSchema: HAND_SCHEMA })).statusCode, 201);
  assert.equal((await post({ ...BASE, fromAgentForm: "yes" })).statusCode, 400);
});

test("an agent that is not a task agent is refused with 409 not_a_task_agent, in the task run's words", async () => {
  const { post, patch, m } = await routes();
  // AGENT is a chat agent.
  const chat = await post({ ...BASE, agentId: AGENT, fromAgentForm: true });
  assert.equal(chat.statusCode, 409);
  assert.deepEqual(chat.json(), { error: "not_a_task_agent", message: TASK_MESSAGES.notATaskAgent });
  assert.equal(written(m), 0);

  const byHand = (await post({ ...VALID_OFFERING })).json().offering as { id: string; termsVersion: string };
  const edited = await patch(byHand.id, { fromAgentForm: true });
  assert.equal(edited.statusCode, 409);
  assert.deepEqual(edited.json(), { error: "not_a_task_agent", message: TASK_MESSAGES.notATaskAgent });
  // Nothing was changed by the refused edit.
  const after = await getOwnedOffering(m.offerings, PUB, byHand.id);
  assert.equal(after.termsVersion, byHand.termsVersion);
  assert.equal(after.formInSync, null);

  // A workflow or a model has no agent whose form it could take.
  const workflow = await post({
    ...BASE,
    productKind: "workflow",
    agentId: undefined,
    orchestrationId: WORKFLOW,
    fromAgentForm: true,
  });
  assert.equal(workflow.statusCode, 400);
  assert.deepEqual(workflow.json(), { error: "invalid_request", message: FORM_MESSAGES.notAnAgentOffering });
});

test("an agent that is not the caller's is not found, flag or no flag", async () => {
  const m = market();
  m.agents.set(TASK_AGENT, { ...m.agents.get(TASK_AGENT)!, orgId: "org_someone_else" });
  await assert.rejects(createOffering(m.offerings, PUB, { ...BASE, fromAgentForm: true }), code("product_not_found"));
});

// ============================================
// formInSync
// ============================================

test("drift is seen once the agent's form changes, and a PATCH with the flag takes the new form and new terms", async () => {
  const { app, m, post, patch } = await routes();
  const created = (await post({ ...BASE, fromAgentForm: true })).json().offering as {
    id: string;
    slug: string;
    termsVersion: string;
    formInSync: boolean | null;
  };
  assert.equal(created.formInSync, true);
  await app.inject({ method: "POST", url: `/api/offerings/${created.id}/activate`, headers: owner(PUB) });

  // The owner adds a question to the agent's form.
  const edited = [...FIELDS, { key: "length", label: "How long", type: "number", required: true }];
  setForm(m, edited);

  const mine = await app.inject({ method: "GET", url: `/api/offerings/mine/${created.id}`, headers: owner(PUB) });
  assert.equal(mine.json().offering.formInSync, false);
  const list = await app.inject({ method: "GET", url: "/api/offerings/mine", headers: owner(PUB) });
  assert.equal(list.json().offerings[0].formInSync, false);
  // The offering still sells the form it was saved with, on the terms it had.
  assert.equal(mine.json().offering.termsVersion, created.termsVersion);
  assert.deepEqual(keysOf(mine.json().offering.inputSchema), FORM_ORDER);
  // Never stored: the row says only where the form came from.
  assert.equal("formInSync" in m.offeringRow(created.id), false);

  // An edit of something else leaves the form, and the drift, as they are.
  const other = await patch(created.id, { maxAttempts: 2 });
  assert.equal(other.json().offering.formInSync, false);
  assert.equal(other.json().offering.termsVersion, created.termsVersion);

  const synced = await patch(created.id, { fromAgentForm: true });
  assert.equal(synced.statusCode, 200);
  const now = synced.json().offering as { termsVersion: string; formInSync: boolean | null; inputSchema: unknown };
  assert.equal(now.formInSync, true);
  assert.deepEqual(keysOf(now.inputSchema), [...FORM_ORDER, "length"]);
  assert.deepEqual(now.inputSchema, publicTaskForm({ task: { fields: edited } }).schema);
  assert.notEqual(now.termsVersion, created.termsVersion);
  assert.deepEqual(m.offeringRow(created.id).inputOrder, [...FORM_ORDER, "length"]);

  // A buyer who agreed to the old form is asked again, by the rule every change of the form follows.
  const input = { topic: "Pricing", tone: "Plain", length: 2 };
  const hire = (termsVersion: string) =>
    app.inject({
      method: "POST",
      url: `/api/offerings/${created.id}/hire`,
      headers: owner(BUYER),
      payload: { input, expected: { priceCents: BASE.priceCents, slaSeconds: BASE.slaSeconds, termsVersion } },
    });
  const stale = await hire(created.termsVersion);
  assert.deepEqual([stale.statusCode, stale.json().error], [409, "offering_terms_changed"]);
  assert.equal((await hire(now.termsVersion)).statusCode, 201);
});

test("the same questions in another order are out of sync too; taking them changes the order and not the terms", async () => {
  const m = market();
  const offering = await createOffering(m.offerings, PUB, { ...BASE, fromAgentForm: true });
  // Two optional questions change places.
  const moved = [FIELDS[0]!, FIELDS[3]!, FIELDS[2]!, FIELDS[1]!];
  setForm(m, moved);
  assert.equal((await getOwnedOffering(m.offerings, PUB, offering.id)).formInSync, false);

  const taken = await updateOffering(m.offerings, PUB, offering.id, { fromAgentForm: true });
  assert.equal(taken.formInSync, true);
  assert.deepEqual(keysOf(taken.inputSchema), ["topic", "aa", "tone", "audience"]);
  // The terms version has never followed the order of a schema's keys: the buyer answers the same questions.
  assert.equal(taken.termsVersion, offering.termsVersion);
});

test("an agent that stopped being a task agent, or is gone, reads as out of sync", async () => {
  const m = market();
  const offering = await createOffering(m.offerings, PUB, { ...BASE, fromAgentForm: true });
  m.agents.set(TASK_AGENT, { ...m.agents.get(TASK_AGENT)!, agentKind: "conversation" });
  assert.equal((await getOwnedOffering(m.offerings, PUB, offering.id)).formInSync, false);
  await assert.rejects(
    updateOffering(m.offerings, PUB, offering.id, { fromAgentForm: true }),
    code("not_a_task_agent", TASK_MESSAGES.notATaskAgent),
  );
  m.agents.delete(TASK_AGENT);
  assert.equal((await getOwnedOffering(m.offerings, PUB, offering.id)).formInSync, false);
  await assert.rejects(updateOffering(m.offerings, PUB, offering.id, { fromAgentForm: true }), code("product_not_found"));
});

test("a schema sent by hand stops the form being the agent's; so does fromAgentForm: false, which keeps the form", async () => {
  const m = market();
  const offering = await createOffering(m.offerings, PUB, { ...BASE, fromAgentForm: true });

  const byHand = await updateOffering(m.offerings, PUB, offering.id, { inputSchema: HAND_SCHEMA });
  assert.equal(byHand.formInSync, null);
  assert.equal(m.offeringRow(offering.id).inputFromAgentForm, false);
  assert.deepEqual(keysOf(byHand.inputSchema), HAND_ORDER);
  assert.notEqual(byHand.termsVersion, offering.termsVersion);

  const again = await updateOffering(m.offerings, PUB, offering.id, { fromAgentForm: true });
  assert.equal(again.formInSync, true);
  assert.equal(again.termsVersion, offering.termsVersion);

  const kept = await updateOffering(m.offerings, PUB, offering.id, { fromAgentForm: false });
  assert.equal(kept.formInSync, null);
  assert.deepEqual(kept.inputSchema, again.inputSchema);
  assert.deepEqual(keysOf(kept.inputSchema), FORM_ORDER);
  assert.equal(kept.termsVersion, again.termsVersion);

  // Removing the form removes its order with it.
  const none = await updateOffering(m.offerings, PUB, offering.id, { inputSchema: null });
  assert.equal(none.inputSchema, null);
  assert.equal(none.formInSync, null);
  assert.deepEqual(m.offeringRow(offering.id).inputOrder, []);
});

test("a hand-written form reads formInSync null, whatever the agent's form is", async () => {
  const m = market();
  const offering = await createOffering(m.offerings, PUB, { ...BASE, inputSchema: HAND_SCHEMA });
  assert.equal(offering.formInSync, null);
  assert.equal(m.offeringRow(offering.id).inputFromAgentForm, false);
  // Even a hand-written copy of the agent's form is not followed.
  const copy = await createOffering(m.offerings, PUB, {
    ...BASE,
    title: "A copy by hand",
    inputSchema: publicTaskForm({ task: { fields: FIELDS } }).schema as unknown as Record<string, unknown>,
  });
  assert.equal(copy.formInSync, null);
});

// ============================================
// Form order
// ============================================

test("a hand-written schema keeps its order through the database: the public read, the publisher's and the search", async () => {
  const { app, m, post, patch } = await routes();
  const res = await post({ ...BASE, agentId: AGENT, inputSchema: HAND_SCHEMA });
  assert.equal(res.statusCode, 201);
  const created = res.json().offering as { id: string; slug: string; termsVersion: string; inputSchema: unknown };
  assert.deepEqual(m.offeringRow(created.id).inputOrder, HAND_ORDER);
  // The stand-in for JSONB really does lose the order.
  assert.deepEqual(keysOf(m.offeringRow(created.id).inputSchema), ["b", "url", "depth", "notes", "audience"]);

  assert.deepEqual(keysOf(created.inputSchema), HAND_ORDER);
  // Only the order of the questions is put back: the schema is the one sent.
  assert.deepEqual(created.inputSchema, HAND_SCHEMA);

  await app.inject({ method: "POST", url: `/api/offerings/${created.id}/activate`, headers: owner(PUB) });
  const page = await app.inject({ method: "GET", url: `/api/offerings/${created.slug}` });
  assert.deepEqual(keysOf(page.json().offering.inputSchema), HAND_ORDER);
  const search = await app.inject({ method: "GET", url: "/api/offerings" });
  assert.deepEqual(keysOf(search.json().offerings[0].inputSchema), HAND_ORDER);
  const mine = await app.inject({ method: "GET", url: `/api/offerings/mine/${created.id}`, headers: owner(PUB) });
  assert.deepEqual(keysOf(mine.json().offering.inputSchema), HAND_ORDER);
  const list = await app.inject({ method: "GET", url: "/api/offerings/mine", headers: owner(PUB) });
  assert.deepEqual(keysOf(list.json().offerings[0].inputSchema), HAND_ORDER);
  assert.deepEqual((await searchPublicOfferings(m.offerings, { sort: "newest", page: 1, limit: 20 })).offerings.map((o) => keysOf(o.inputSchema)), [HAND_ORDER]);

  // An update of the form remembers the new order, and the terms follow the form as before.
  const reordered = { ...HAND_SCHEMA, properties: Object.fromEntries(Object.entries(HAND_SCHEMA.properties).reverse()) };
  const edited = await patch(created.id, { inputSchema: reordered });
  assert.deepEqual(keysOf(edited.json().offering.inputSchema), [...HAND_ORDER].reverse());
  assert.equal(edited.json().offering.termsVersion, created.termsVersion);
  // An edit of anything else leaves the order alone.
  const priced = await patch(created.id, { priceCents: 2_500 });
  assert.deepEqual(keysOf(priced.json().offering.inputSchema), [...HAND_ORDER].reverse());
});

/** One Offering row as Prisma gives it, with what the view includes. */
function prismaRow(over: Record<string, unknown> = {}) {
  return {
    id: "0ff00000-0000-4000-8000-000000000001",
    publisherId: PUB,
    productKind: "agent",
    agentId: AGENT,
    orchestrationId: null,
    deploymentId: null,
    listingId: null,
    slug: "a-written-brief",
    title: BASE.title,
    description: BASE.description,
    priceCents: 2_000n,
    slaSeconds: 3_600,
    inputSchema: jsonb(HAND_SCHEMA),
    inputOrder: HAND_ORDER,
    inputFromAgentForm: false,
    sampleInputs: [],
    instructions: null,
    deliverableChecks: [],
    outputFormat: "text",
    allowedTools: [],
    maxAttempts: 1,
    maxConcurrentJobs: 5,
    activeJobs: 0,
    status: "active",
    publishedAt: null,
    createdAt: new Date("2026-10-06T12:00:00Z"),
    updatedAt: new Date("2026-10-06T12:00:00Z"),
    agent: { name: "Research Agent", agentKind: "conversation", kindConfig: null },
    orchestration: null,
    listing: null,
    publisher: { name: "Publisher Org", publisherProfile: null },
    ...over,
  };
}

/** Runs `fn` with prisma.offering replaced; the store under test touches no other model for an agent offering. */
async function withOfferingRows<T>(offering: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const client = prisma as unknown as Record<string, unknown>;
  const saved = client.offering;
  client.offering = offering;
  try {
    return await fn();
  } finally {
    client.offering = saved;
  }
}

test("the Prisma store puts the order back on every read, and carries the agent's form to the owner's view only", async () => {
  const store = buildOfferingStore();
  const queries: Array<Record<string, unknown>> = [];
  const row = prismaRow();
  const taskRow = prismaRow({
    id: "0ff00000-0000-4000-8000-000000000002",
    agentId: TASK_AGENT,
    inputSchema: jsonb(publicTaskForm({ task: { fields: FIELDS } }).schema),
    inputOrder: FORM_ORDER,
    inputFromAgentForm: true,
    agent: { name: "Brief Writer", agentKind: "task", kindConfig: { task: { fields: FIELDS } } },
  });
  await withOfferingRows(
    {
      findUnique: async (query: Record<string, unknown>) => {
        queries.push(query);
        return row;
      },
      findFirst: async () => taskRow,
      findMany: async () => [row, taskRow],
      count: async () => 2,
    },
    async () => {
      // The copy a job is hired with, the public page, the search and the owner's reads.
      const hired = await store.findById(row.id);
      assert.deepEqual(keysOf(hired!.inputSchema), HAND_ORDER);
      assert.deepEqual(hired!.inputSchema, HAND_SCHEMA);
      assert.deepEqual(keysOf((await store.findBySlug(row.slug))!.inputSchema), HAND_ORDER);
      const found = await store.searchActive({ sort: "newest", page: 1, limit: 20 });
      assert.deepEqual(found.rows.map((view) => keysOf(view.inputSchema)), [HAND_ORDER, FORM_ORDER]);
      assert.deepEqual((await store.listOwned(PUB)).map((view) => keysOf(view.inputSchema)), [HAND_ORDER, FORM_ORDER]);

      const owned = await store.findOwned(PUB, taskRow.id);
      assert.deepEqual(keysOf(owned!.inputSchema), FORM_ORDER);
      assert.deepEqual(owned!.agentForm, { agentKind: "task", kindConfig: { task: { fields: FIELDS } } });
      // The row's relations are not on the view.
      assert.equal("agent" in owned!, false);

      // What a test run hands the runner is this view: its brief is in the form's order.
      const brief = renderJobBrief({ title: hired!.title, inputSchema: hired!.inputSchema }, HAND_INPUT);
      assert.deepEqual(Object.keys(JSON.parse(brief.split("<buyer_input>\n")[1]!.split("\n</buyer_input>")[0]!)), HAND_ORDER);
    },
  );
  // The agent's kind and settings are read beside the row, for formInSync.
  const include = queries[0]!.include as { agent: { select: Record<string, boolean> } };
  assert.deepEqual(include.agent.select, { name: true, agentKind: true, kindConfig: true });
});

function runnerDeps(offering: Record<string, unknown>) {
  return buildJobRunnerDeps({
    prisma: {
      job: {
        findUnique: async () => ({
          id: "job_1",
          buyerId: BUYER,
          publisherId: PUB,
          status: "funded",
          input: HAND_INPUT,
          deadlineAt: null,
          leaseExpiresAt: null,
          attempts: 0,
          terms: { title: "A written brief" },
          offering: {
            id: "off_1",
            title: "A written brief",
            productKind: "agent",
            agentId: AGENT,
            orchestrationId: null,
            deploymentId: null,
            instructions: null,
            allowedTools: [],
            maxAttempts: 1,
            ...offering,
          },
        }),
        updateMany: async () => ({ count: 1 }),
      },
      orchestrationExecution: { findUnique: async () => null },
      $transaction: async (fn) => fn({}),
    },
    executor: {
      loadAgent: async () => null,
      runAgentChat: async () => {
        throw new Error("not run in this test");
      },
    },
    notify: async () => {},
    maxRunMs: 60_000,
    platformModelRates: { inputCentsPerMTok: 15, outputCentsPerMTok: 60 },
  });
}

const briefKeys = (brief: string) =>
  Object.keys(JSON.parse(brief.split("<buyer_input>\n")[1]!.split("\n</buyer_input>")[0]!) as Record<string, unknown>);

test("the brief a hired job gives the model lists the answers in the form's order", async () => {
  const job = await runnerDeps({ inputSchema: jsonb(HAND_SCHEMA), inputOrder: HAND_ORDER }).loadJob("job_1");
  assert.deepEqual(keysOf(job!.offering.inputSchema), HAND_ORDER);
  assert.deepEqual(job!.offering.inputSchema, HAND_SCHEMA);
  // The order is used and not handed on.
  assert.equal("inputOrder" in job!.offering, false);

  const brief = renderJobBrief({ title: job!.terms.title ?? "", inputSchema: job!.offering.inputSchema }, job!.input);
  assert.deepEqual(briefKeys(brief), HAND_ORDER);
  // Whatever order the buyer's client sent the answers in.
  const shuffled = Object.fromEntries(Object.entries(HAND_INPUT).reverse());
  assert.equal(renderJobBrief({ title: "A written brief", inputSchema: job!.offering.inputSchema }, shuffled), brief);
});

test("a test run of the offering is briefed in the form's order too", async () => {
  const m = market();
  const offering = await createOffering(m.offerings, PUB, { ...BASE, agentId: AGENT, inputSchema: HAND_SCHEMA });
  // The Prisma store orders the view it returns; the in-memory one is given the same step here.
  const { store } = m.offerings;
  const findOwned = store.findOwned;
  const real = buildOfferingStore();
  let seen: unknown;
  await withOfferingRows(
    { findFirst: async () => prismaRow({ id: offering.id }) },
    async () => {
      store.findOwned = async (orgId, id) => {
        const view = await findOwned(orgId, id);
        const ordered = await real.findOwned(orgId, id);
        return view && { ...view, inputSchema: ordered!.inputSchema };
      };
      await testRunOffering(
        {
          store,
          tryProduct: async (job) => {
            seen = job.offering.inputSchema;
            return { passed: true, output: null, checkResults: [] };
          },
          maxRunMs: 1_000,
          freeTierLimitMessage: "free-model limit reached",
        },
        PUB,
        offering.id,
        HAND_INPUT,
      );
    },
  );
  assert.deepEqual(keysOf(seen), HAND_ORDER);
});

// ============================================
// An offering saved before the order was kept
// ============================================

test("an offering saved before this batch reads exactly as it did", async () => {
  const m = market();
  const created = await createOffering(m.offerings, PUB, { ...BASE, agentId: AGENT, inputSchema: HAND_SCHEMA });
  // As the migration leaves an old row: no order, not from a form.
  const row = m.offeringRow(created.id);
  row.inputOrder = [];
  row.inputFromAgentForm = false;
  const stored = row.inputSchema;

  const mine = await getOwnedOffering(m.offerings, PUB, created.id);
  // The stored schema itself, in the order the database gives it.
  assert.equal(mine.inputSchema, stored);
  assert.deepEqual(keysOf(mine.inputSchema), keysOf(stored));
  assert.equal(mine.formInSync, null);
  assert.equal(mine.termsVersion, created.termsVersion);
  assert.equal(
    mine.termsVersion,
    offeringTermsVersion({
      title: BASE.title,
      description: BASE.description,
      priceCents: 2_000n,
      slaSeconds: 3_600,
      inputSchema: HAND_SCHEMA,
      deliverableChecks: [],
      outputFormat: "text",
      instructions: null,
    }),
  );
  // A row from before the column existed at all (as older fakes build it) reads the same.
  delete row.inputOrder;
  delete row.inputFromAgentForm;
  const older = await getOwnedOffering(m.offerings, PUB, created.id);
  assert.equal(older.inputSchema, stored);
  assert.equal(older.formInSync, null);

  await setOfferingStatus(m.offerings, PUB, created.id, "activate");
  assert.equal((await getPublicOffering(m.offerings, created.slug)).inputSchema, stored);

  // The Prisma store and the runner: an empty order changes nothing.
  const prismaView = await withOfferingRows(
    { findUnique: async () => prismaRow({ inputSchema: stored, inputOrder: [] }) },
    () => buildOfferingStore().findById("any"),
  );
  assert.deepEqual(prismaView!.inputSchema, stored);
  assert.deepEqual(keysOf(prismaView!.inputSchema), keysOf(stored));

  for (const order of [{ inputOrder: [] }, {}]) {
    const job = await runnerDeps({ inputSchema: stored, ...order }).loadJob("job_1");
    assert.deepEqual(keysOf(job!.offering.inputSchema), keysOf(stored));
    const brief = renderJobBrief({ title: "A written brief", inputSchema: job!.offering.inputSchema }, HAND_INPUT);
    assert.equal(brief, renderJobBrief({ title: "A written brief", inputSchema: stored }, HAND_INPUT));
  }
  // An offering with no form at all.
  const none = await runnerDeps({ inputSchema: null, inputOrder: [] }).loadJob("job_1");
  assert.equal(none!.offering.inputSchema, null);
});
