/**
 * The request the dashboard's API client actually sends. Run with:
 *   cd apps/web && npx tsx --test src/lib/api.unit.test.ts
 *
 * The API (Fastify) answers `Content-Type: application/json` with an empty
 * body with a 400 while it parses the request, before authentication and
 * before the route. The client used to set that header on every request,
 * so every action without a body ("Run now", cancel a run, cancel an
 * execution) failed from the dashboard and only showed an error toast.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  isAgentLicence,
  isAgentListing,
  orchestrationApi,
  paidUseRefusalOf,
  paidWorkflowApi,
  productKindOf,
  schedulerApi,
} from "./api";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
  signal?: AbortSignal | null;
}

const realFetch = globalThis.fetch;
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
      credentials: init.credentials,
      signal: init.signal,
    });
    return new Response(JSON.stringify({ execution: { id: "e1", status: "queued" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const contentType = (request: Sent) =>
  Object.entries(request.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1];

test("an action without a body sends no body and no JSON content type", async () => {
  await schedulerApi.trigger("task-1");
  await schedulerApi.cancelExecution("task-1", "exec-1");
  await orchestrationApi.cancelExecution("wf-1", "run-1");

  assert.equal(sent.length, 3);
  for (const request of sent) {
    assert.equal(request.method, "POST", request.url);
    assert.equal(request.body, undefined, request.url);
    assert.equal(contentType(request), undefined, request.url);
  }
  assert.match(sent[0]!.url, /\/api\/scheduler\/task-1\/trigger$/);
  assert.match(sent[1]!.url, /\/api\/scheduler\/task-1\/executions\/exec-1\/cancel$/);
  assert.match(sent[2]!.url, /\/api\/orchestrations\/wf-1\/executions\/run-1\/cancel$/);
});

test("a request with a body is JSON and says so", async () => {
  await orchestrationApi.execute("wf-1", { prompt: "go", input: { a: 1 } });
  await orchestrationApi.execute("wf-1", {});

  for (const request of sent) {
    assert.equal(contentType(request), "application/json");
    assert.equal(typeof request.body, "string");
  }
  assert.deepEqual(JSON.parse(sent[0]!.body as string), { prompt: "go", input: { a: 1 } });
  assert.deepEqual(JSON.parse(sent[1]!.body as string), {});
});

test("a read sends neither", async () => {
  await schedulerApi.taskTypes();
  assert.equal(sent[0]!.method, "GET");
  assert.equal(sent[0]!.body, undefined);
  assert.equal(contentType(sent[0]!), undefined);
});

// ---------------------------------------------------------------------------
// A workflow on sale: by its listing's slug, and refused as an agent's paid use is
// ---------------------------------------------------------------------------

test("the two reads of a workflow on sale anyone may make send no cookie", async () => {
  await paidWorkflowApi.get("weekly-digest");
  await paidWorkflowApi.getApiPage("weekly-digest");

  assert.equal(sent.length, 2);
  assert.match(sent[0]!.url, /\/api\/w\/weekly-digest$/);
  assert.match(sent[1]!.url, /\/api\/w\/weekly-digest\/api$/);
  for (const request of sent) {
    assert.equal(request.method, "GET");
    assert.equal(request.credentials, "omit");
    assert.equal(request.body, undefined);
  }
});

test("the access and the run of a workflow are the signed-in buyer's", async () => {
  await paidWorkflowApi.access("weekly-digest");
  await paidWorkflowApi.run("weekly-digest", { input: { topic: "rain" } });

  assert.match(sent[0]!.url, /\/api\/w\/weekly-digest\/access$/);
  assert.equal(sent[0]!.method, "GET");
  assert.match(sent[1]!.url, /\/api\/w\/weekly-digest\/run$/);
  assert.equal(sent[1]!.method, "POST");
  for (const request of sent) assert.equal(request.credentials, "include");
});

test("a run sends its input and nothing else: the API refuses any other field", async () => {
  const body = { input: { topic: "rain" }, stream: false } as unknown as { input: Record<string, unknown> };
  await paidWorkflowApi.run("weekly-digest", body);

  assert.equal(contentType(sent[0]!), "application/json");
  assert.deepEqual(JSON.parse(sent[0]!.body as string), { input: { topic: "rain" } });
});

test("a run can be cancelled, and a call without a signal sends none", async () => {
  const stop = new AbortController();
  await paidWorkflowApi.run("weekly-digest", { input: {} }, stop.signal);
  await paidWorkflowApi.run("weekly-digest", { input: {} });

  assert.equal(sent[0]!.signal, stop.signal);
  assert.equal(sent[1]!.signal, undefined);
});

test("a slug is sent as one part of the address", async () => {
  await paidWorkflowApi.get("a/b?c");
  await paidWorkflowApi.access("a/b?c");
  await paidWorkflowApi.run("a/b?c", { input: {} });

  assert.match(sent[0]!.url, /\/api\/w\/a%2Fb%3Fc$/);
  assert.match(sent[1]!.url, /\/api\/w\/a%2Fb%3Fc\/access$/);
  assert.match(sent[2]!.url, /\/api\/w\/a%2Fb%3Fc\/run$/);
});

test("a refused run throws the body a paid use of an agent throws, with what to change", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: "input_invalid",
        message: "The input does not fit this workflow's form. Nothing was charged.",
        details: [{ path: "", field: null, label: null, message: "topic is required" }],
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const thrown = await paidWorkflowApi.run("weekly-digest", { input: {} }).then(
    () => null,
    (error: unknown) => error,
  );
  const refusal = paidUseRefusalOf(thrown);
  assert.ok(refusal);
  assert.equal(refusal.error, "input_invalid");
  assert.deepEqual(refusal.details, [{ path: "", field: null, label: null, message: "topic is required" }]);
});

test("a workflow's run that was refunded is read like any other refusal", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: "run_failed",
        message: "The workflow could not finish this run. Your $0.05 was refunded.",
        refundedCents: 5,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const thrown = await paidWorkflowApi.run("weekly-digest", { input: {} }).catch((error: unknown) => error);
  assert.equal(paidUseRefusalOf(thrown)?.error, "run_failed");
  assert.equal(paidUseRefusalOf(thrown)?.refundedCents, 5);
});

test("a page that is not there throws, and no cookie went with it", async () => {
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    sent.push({ url: "", method: "GET", headers: {}, body: undefined, credentials: init.credentials });
    return new Response(JSON.stringify({ error: "workflow_not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await assert.rejects(paidWorkflowApi.get("gone"), (error: unknown) => (error as { status?: number }).status === 404);
  assert.equal(sent[0]!.credentials, "omit");
});

// ---------------------------------------------------------------------------
// What a listing, a licence or a usage row is for
// ---------------------------------------------------------------------------

test("a row is an agent's only when it plainly is one", () => {
  assert.equal(productKindOf({ productKind: "agent", agentId: "a1" }), "agent");
  assert.equal(productKindOf({ productKind: "workflow", agentId: null }), "workflow");
  // An API that does not say sold agents only.
  assert.equal(productKindOf({ agentId: "a1" }), "agent");
  assert.equal(productKindOf({}), "agent");
  // A listing with no agent is never read as an agent's, whatever else it says.
  assert.equal(productKindOf({ productKind: "agent", agentId: null }), "workflow");
  assert.equal(productKindOf({ agentId: null }), "workflow");
  assert.equal(productKindOf({ productKind: "workflow" }), "workflow");
});

test("a screen made for agents keeps agents' listings and licences and leaves a workflow's out", () => {
  const listings = [
    { id: "l1", productKind: "agent" as const, agentId: "a1" },
    { id: "l2", productKind: "workflow" as const, agentId: null },
    { id: "l3", agentId: "a3" },
    { id: "l4", productKind: "workflow" as const, agentId: "a4" },
  ];
  assert.deepEqual(
    listings.filter(isAgentListing).map((listing) => listing.id),
    ["l1", "l3"],
  );

  const agent = { handle: "helper", name: "Helper", agentKind: "conversation" as const };
  const licences = [
    { id: "i1", productKind: "agent" as const, slug: "helper", agent },
    { id: "i2", productKind: "workflow" as const, slug: "digest", agent: null },
    { id: "i3", agent },
    { id: "i4", agent: null },
    { id: "i5", productKind: "workflow" as const, agent },
  ];
  assert.deepEqual(
    licences.filter(isAgentLicence).map((licence) => licence.id),
    ["i1", "i3"],
  );
});
