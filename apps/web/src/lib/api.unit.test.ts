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

import { orchestrationApi, schedulerApi } from "./api";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
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
