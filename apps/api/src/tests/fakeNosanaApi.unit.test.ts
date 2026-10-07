import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  CONTAINER_RUN_ARGS_KEYS,
  FAKE_NODE,
  startFakeNosanaApi,
  unknownJobDefinitionArgs,
} from "./fakeNosanaApi.js";

// The stand-in Nosana API itself: the shapes and the state rules every
// Nosana test relies on, as the live API serves them (OpenAPI spec, redacted
// live responses of 2026-10-07, Deployment Manager source at 127f915).
// Loopback only.

const fake = await startFakeNosanaApi();
after(() => fake.close());

const M3060 = "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq";

function reset() {
  fake.deployments.clear();
  fake.requests.length = 0;
  fake.setInsufficientFunds(false);
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${fake.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${fake.apiKey}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

function definition(args: Record<string, unknown> = { image: "docker.io/ollama/ollama:0.32.6", expose: 11434 }) {
  return { version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [{ type: "container/run", id: "llm", args }] };
}

async function create(name: string, extra: Record<string, unknown> = {}) {
  const res = await call("POST", "/api/deployments/create", {
    name,
    market: M3060,
    replicas: 1,
    timeout: 60,
    strategy: "SIMPLE-EXTEND",
    confidential: true,
    job_definition: definition(),
    ...extra,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test("every route answers with and without the /api prefix", async () => {
  reset();
  const created = await create("wheelsai-paths");
  for (const prefix of ["/api", ""]) {
    assert.equal((await call("GET", `${prefix}/deployments/${created.id}`)).status, 200);
    assert.equal((await call("GET", `${prefix}/deployments`)).status, 200);
    assert.equal((await call("GET", `${prefix}/credits/balance`)).status, 200);
    assert.equal((await fetch(`${fake.url}${prefix}/markets/`)).status, 200, "public");
  }
});

test("a deployment: no jobs or events in its body; endpoints from the exposed ports, offline until a test flips them", async () => {
  reset();
  const created = await create("wheelsai-endpoints");
  const read = (await call("GET", `/api/deployments/${created.id}`)).body;
  assert.equal(Object.hasOwn(read, "jobs"), false);
  assert.equal(Object.hasOwn(read, "events"), false);
  assert.equal(read.active_jobs, 0);
  assert.equal(read.endpoints.length, 1);
  assert.equal(read.endpoints[0].opId, "llm");
  assert.equal(read.endpoints[0].port, 11434);
  assert.equal(read.endpoints[0].online, false);
  assert.match(read.endpoints[0].url, /^https:\/\/[1-9A-HJ-NP-Za-km-z]{44}\.node\.k8s\.prd\.nos\.ci$/);

  fake.setEndpointsOnline(created.id, true);
  assert.equal((await call("GET", `/api/deployments/${created.id}`)).body.endpoints[0].online, true);

  // Two ports: one endpoint each.
  const two = await call("POST", "/api/deployments/create", {
    name: "wheelsai-two-ports",
    market: M3060,
    replicas: 1,
    timeout: 60,
    job_definition: definition({ image: "x", expose: [8000, { port: 8080 }] }),
  });
  assert.deepEqual(two.body.endpoints.map((e: any) => [e.port, e.online]), [[8000, false], [8080, false]]);
  assert.notEqual(two.body.endpoints[0].url, two.body.endpoints[1].url);
});

test("start: RUNNING at once (the answer says STARTING); refused from RUNNING, STARTING, STOPPING and ARCHIVED", async () => {
  reset();
  const created = await create("wheelsai-start");
  const started = await call("POST", `/api/deployments/${created.id}/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.status, "STARTING");
  assert.equal(fake.deployments.get(created.id)!.status, "RUNNING");

  for (const status of ["RUNNING", "STARTING", "STOPPING", "ARCHIVED"] as const) {
    fake.setStatus(created.id, status);
    const refused = await call("POST", `/api/deployments/${created.id}/start`);
    assert.deepEqual([refused.status, refused.body], [500, { error: "Deployment is in the incorrect state." }], status);
  }
  for (const status of ["DRAFT", "STOPPED", "ERROR", "INSUFFICIENT_FUNDS"] as const) {
    fake.setStatus(created.id, status);
    assert.equal((await call("POST", `/api/deployments/${created.id}/start`)).status, 200, status);
  }

  fake.setInsufficientFunds(true);
  fake.setStatus(created.id, "STOPPED");
  await call("POST", `/api/deployments/${created.id}/start`);
  assert.equal(fake.deployments.get(created.id)!.status, "INSUFFICIENT_FUNDS");
  const events = (await call("GET", `/api/deployments/${created.id}/events`)).body.events;
  assert.equal(events[0].type, "JOB_LIST_ERROR");
  assert.match(events[0].message, /Insufficient credits/);
});

test("stop: only from RUNNING, ERROR or INSUFFICIENT_FUNDS; archive and DELETE only from STOPPED", async () => {
  reset();
  const created = await create("wheelsai-stop");
  for (const status of ["DRAFT", "STARTING", "STOPPING", "STOPPED", "ARCHIVED"] as const) {
    fake.setStatus(created.id, status);
    const refused = await call("POST", `/api/deployments/${created.id}/stop`);
    assert.equal(refused.status, 500, status);
    assert.equal(refused.body.error, "Deployment is in the incorrect state.");
  }
  for (const status of ["RUNNING", "ERROR", "INSUFFICIENT_FUNDS"] as const) {
    fake.setStatus(created.id, status);
    const stopped = await call("POST", `/api/deployments/${created.id}/stop`);
    assert.deepEqual([stopped.status, stopped.body.status], [200, "STOPPING"], status);
  }

  fake.setStatus(created.id, "RUNNING");
  assert.equal((await call("POST", `/api/deployments/${created.id}/archive`)).status, 500);
  assert.equal((await call("DELETE", `/api/deployments/${created.id}`)).status, 500);

  // STOPPING -> STOPPED ends the running job and takes the endpoints offline.
  const job = fake.addJob(created.id);
  fake.setEndpointsOnline(created.id, true);
  await call("POST", `/api/deployments/${created.id}/stop`);
  fake.settle(created.id);
  const after = fake.deployments.get(created.id)!;
  assert.equal(after.status, "STOPPED");
  assert.equal(after.jobs.find((j) => j.job === job.job)!.state, "STOPPED");
  assert.equal(after.endpoints.every((e) => !e.online), true);

  assert.equal((await call("PATCH", `/api/deployments/${created.id}/archive`)).status, 200);
  assert.equal(fake.deployments.get(created.id)!.status, "ARCHIVED");
  const other = await create("wheelsai-delete");
  fake.setStatus(other.id, "STOPPED");
  assert.equal((await call("DELETE", `/api/deployments/${other.id}`)).status, 204);
  assert.equal(fake.deployments.has(other.id), false);
});

test("create: unknown job-definition args keys are refused as the strict validator refuses them", async () => {
  reset();
  assert.deepEqual(
    [...CONTAINER_RUN_ARGS_KEYS].sort(),
    ["aliases", "authentication", "cmd", "entrypoint", "env", "expose", "gpu", "image", "private", "resources", "restart_policy", "volumes", "work_dir"],
  );
  const res = await call("POST", "/api/deployments/create", {
    name: "wheelsai-train-strict",
    market: M3060,
    replicas: 1,
    timeout: 60,
    strategy: "SIMPLE",
    job_definition: definition({ image: "trainer", gpu: true, required_vram: 24, env: {} }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "FST_ERR_VALIDATION");
  assert.match(res.body.message, /ops\[0\]\.args\.required_vram: undefined/);
  assert.equal(fake.deployments.size, 0, "nothing was created");
  assert.deepEqual(unknownJobDefinitionArgs(definition({ image: "x", work: "/w", output: "/o" })), [
    "job_definition$input.ops[0].args.work: undefined",
    "job_definition$input.ops[0].args.output: undefined",
  ]);
});

test("create: idempotency_key is stored, filterable, left out of the create answer, and a duplicate is a 409", async () => {
  reset();
  const created = await create("wheelsai-idem", { idempotency_key: "wheelsai-model-abc-r1" });
  assert.equal(Object.hasOwn(created, "idempotency_key"), false);
  const again = await call("POST", "/api/deployments/create", {
    name: "wheelsai-idem",
    market: M3060,
    replicas: 1,
    timeout: 60,
    idempotency_key: "wheelsai-model-abc-r1",
    job_definition: definition(),
  });
  assert.equal(again.status, 409);
  assert.equal(fake.deployments.size, 1);
  const bad = await call("POST", "/api/deployments/create", {
    name: "x",
    market: M3060,
    replicas: 1,
    timeout: 60,
    idempotency_key: "has spaces",
    job_definition: definition(),
  });
  assert.equal(bad.status, 400);

  const listed = (await call("GET", "/api/deployments?idempotency_key=wheelsai-model-abc-r1")).body;
  assert.deepEqual(listed.deployments.map((d: any) => d.id), [created.id]);
  assert.equal(listed.deployments[0].idempotency_key, "wheelsai-model-abc-r1");
  assert.equal((await call("GET", "/api/deployments?idempotency_key=other")).body.pagination.total_items, 0);
});

test("the deployment list is paginated: limit 10, 20, 50 or 100, newest first, cursors, total_items, exact names", async () => {
  reset();
  for (let i = 0; i < 25; i += 1) {
    fake.seedDeployment({ name: i % 5 === 0 ? "Wheelsai-Named" : `wheelsai-${i}`, created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
  }
  const first = (await call("GET", "/api/deployments")).body;
  assert.equal(first.deployments.length, 10, "the default page is 10");
  assert.deepEqual(Object.keys(first.pagination).sort(), ["cursor_next", "cursor_prev", "total_items"]);
  assert.equal(first.pagination.total_items, 25);
  assert.equal(first.pagination.cursor_prev, null);
  assert.equal(first.deployments[0].name, "wheelsai-24", "newest first");

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: any = (await call("GET", `/api/deployments?limit=20${cursor ? `&cursor=${cursor}` : ""}`)).body;
    pages += 1;
    seen.push(...page.deployments.map((d: any) => d.id));
    if (pages > 1) assert.notEqual(page.pagination.cursor_prev, null);
    cursor = page.pagination.cursor_next;
  } while (cursor);
  assert.equal(pages, 2);
  assert.equal(new Set(seen).size, 25);

  for (const limit of ["25", "0", "abc", "1000"]) {
    const refused = await call("GET", `/api/deployments?limit=${limit}`);
    assert.equal(refused.status, 400, limit);
    assert.equal(refused.body.code, "FST_ERR_VALIDATION");
  }

  const named = (await call("GET", "/api/deployments?name=Wheelsai-Named&limit=100")).body;
  assert.equal(named.pagination.total_items, 5);
  assert.equal((await call("GET", "/api/deployments?name=wheelsai-named")).body.pagination.total_items, 0, "exact, case-sensitive");
  const asc = (await call("GET", "/api/deployments?sort_order=asc&limit=10")).body;
  assert.equal(asc.deployments[0].name, "Wheelsai-Named");
  assert.equal(asc.deployments[1].name, "wheelsai-1");
});

test("jobs, events and tasks are paginated lists; a single job reads in the live shape", async () => {
  reset();
  const created = await create("wheelsai-jobs");
  await call("POST", `/api/deployments/${created.id}/start`);
  const older = fake.addJob(created.id, { state: "COMPLETED", time_start: 1_781_000_000, created_at: "2026-10-01T00:00:00.000Z" });
  const newer = fake.addJob(created.id, { time_start: 1_781_459_639 });

  const jobs = (await call("GET", `/api/deployments/${created.id}/jobs`)).body;
  assert.deepEqual(jobs.jobs.map((j: any) => j.job), [newer.job, older.job], "newest first");
  assert.deepEqual(Object.keys(jobs.jobs[0]).sort(), [
    "created_at", "deployment", "job", "market", "node", "revision", "state", "time_start", "tx", "updated_at",
  ]);
  assert.equal(jobs.jobs[0].state, "RUNNING");
  assert.equal(jobs.pagination.total_items, 2);
  assert.deepEqual(
    (await call("GET", `/api/deployments/${created.id}/jobs?state=COMPLETED`)).body.jobs.map((j: any) => j.job),
    [older.job],
  );
  assert.equal((await call("GET", `/api/deployments/${created.id}`)).body.active_jobs, 1);

  const events = (await call("GET", `/api/deployments/${created.id}/events`)).body;
  assert.deepEqual(events.events.map((e: any) => e.type), ["JOB_LIST_CONFIRMED", "JOB_LIST_CONFIRMED"]);
  assert.equal(events.events[0].category, "Deployment");
  assert.equal(events.events[0].deploymentId, created.id);

  assert.deepEqual((await call("GET", `/api/deployments/${created.id}/tasks`)).body, {
    tasks: [],
    pagination: { cursor_next: null, cursor_prev: null, total_items: 0 },
  });

  const one = (await call("GET", `/api/deployments/${created.id}/jobs/${newer.job}`)).body;
  assert.equal(one.state, 1, "a number");
  assert.equal(one.node, FAKE_NODE);
  assert.equal(one.timeStart, 1_781_459_639, "unix seconds");
  assert.equal(one.timeEnd, 0);
  assert.equal(one.jobResult, null);
  fake.setJob(created.id, newer.job, { state: 2, timeStart: 1, timeEnd: 0, jobResult: { endTime: 1_781_481_239_965 } });
  assert.equal((await call("GET", `/api/deployments/${created.id}/jobs/${newer.job}`)).body.state, 2);
  assert.equal((await call("GET", `/api/deployments/${created.id}/jobs/NoSuchJob`)).status, 404);
});
