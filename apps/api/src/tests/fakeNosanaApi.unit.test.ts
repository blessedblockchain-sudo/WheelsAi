import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  CONTAINER_RUN_ARGS_KEYS,
  creditTimeoutListError,
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

// ============================================
// Credit-paid jobs: the 50-minute minimum and the reservation (live, 2026-10-08)
// ============================================

const M4090 = "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf";

async function createStarted(name: string, timeout: number, market = M4090): Promise<string> {
  const created = await call("POST", "/api/deployments/create", {
    name,
    market,
    replicas: 1,
    timeout,
    strategy: "SIMPLE-EXTEND",
    confidential: true,
    job_definition: definition(),
  });
  assert.equal(created.status, 200);
  const started = await call("POST", `/api/deployments/${created.body.id}/start`);
  assert.equal(started.status, 200);
  return created.body.id as string;
}

const usdSum = (a: number, b: number): number => Number((a + b).toFixed(6));

test("a credit-paid deployment under 50 minutes is accepted and RUNNING, logs the reserve and list-error pair on each attempt, and is never listed or debited", async () => {
  reset();
  fake.setBalance({ assignedCredits: 100, reservedCredits: 0, settledCredits: 0 });
  const rowsBefore = fake.creditRows.length;
  const id = await createStarted("wheelsai-ten-minutes", 10);

  const body = (await call("GET", `/api/deployments/${id}`)).body;
  assert.equal(body.status, "RUNNING");
  assert.equal(body.active_jobs, 0);
  assert.equal(body.endpoints[0].online, false);

  const message = "Error Failed to assign job batch: Credit-paid jobs must have a timeout of at least 3000 seconds; 600 was requested.";
  assert.equal(creditTimeoutListError(10), message);
  let events = (await call("GET", `/api/deployments/${id}/events?limit=10`)).body.events;
  assert.deepEqual(
    events.map((e: { type: string }) => e.type),
    ["JOB_LIST_ERROR", "JOB_RESERVE_CONFIRMED"],
    "newest first",
  );
  assert.equal(events[0].message, message);
  assert.equal(events[1].message, `Reserved 1 node(s) in market(s) ${M4090}`);

  // Nosana tries again every few minutes: the same pair each time.
  assert.equal(fake.attemptList(id), null);
  assert.equal(fake.attemptList(id), null);
  events = (await call("GET", `/api/deployments/${id}/events?limit=10`)).body.events;
  assert.equal(events.length, 6);
  assert.equal(events.filter((e: { type: string }) => e.type === "JOB_LIST_ERROR").length, 3);
  assert.equal(events.some((e: { type: string }) => e.type === "JOB_LIST_CONFIRMED"), false);

  assert.equal((await call("GET", `/api/deployments/${id}`)).body.status, "RUNNING", "it never leaves RUNNING by itself");
  assert.equal((await call("GET", `/api/deployments/${id}/jobs?limit=10`)).body.jobs.length, 0);
  assert.throws(() => fake.addJob(id), /never lists a credit-paid job under 50/);
  assert.deepEqual(fake.balance(), { assignedCredits: 100, reservedCredits: 0, settledCredits: 0 }, "nothing is debited");
  assert.equal(fake.creditRows.length, rowsBefore);

  // The stop is accepted and nothing settles.
  assert.equal((await call("POST", `/api/deployments/${id}/stop`)).status, 200);
  fake.settle(id);
  assert.equal(fake.settleCredits(id), 0);
  assert.deepEqual(fake.balance(), { assignedCredits: 100, reservedCredits: 0, settledCredits: 0 });
});

test("a listed job reserves price x timeout at the host price, and a stop settles the used part later", async () => {
  reset();
  fake.setBalance({ assignedCredits: 100, reservedCredits: 0, settledCredits: 0 });
  const id = await createStarted("wheelsai-fifty-minutes", 50);
  assert.equal((await call("GET", `/api/deployments/${id}/events?limit=10`)).body.events.length, 0, "no refused attempt");

  const job = fake.attemptList(id);
  assert.ok(job);
  const events = (await call("GET", `/api/deployments/${id}/events?limit=10`)).body.events;
  assert.deepEqual(
    events.map((e: { type: string }) => e.type),
    ["JOB_LIST_CONFIRMED", "JOB_RESERVE_CONFIRMED"],
  );
  // 50 minutes at 0.3636 USD an hour, without the 10% fee.
  assert.deepEqual(fake.balance(), { assignedCredits: 100, reservedCredits: 0.303, settledCredits: 0 });
  const rowsBefore = fake.creditRows.length - 1;
  const row = fake.creditRows.at(-1)!;
  assert.deepEqual(
    { type: row.type, amountUsd: row.amountUsd, deployment: row.deployment, job: row.job },
    { type: "job_debit", amountUsd: 0.303, deployment: id, job: job.job },
  );
  // The fields a row of GET /credits/transactions carries live.
  assert.equal(typeof row.id, "string");
  assert.equal(typeof row.method, "string");
  assert.ok(!Number.isNaN(Date.parse(row.createdAt)));

  // Stopped: the reservation is still there until Nosana settles it.
  assert.equal((await call("POST", `/api/deployments/${id}/stop`)).status, 200);
  fake.settle(id);
  assert.equal(fake.balance().reservedCredits, 0.303);
  assert.equal(fake.balance().settledCredits, 0);

  // A few minutes later: 258 seconds were used.
  assert.equal(fake.settleCredits(id, { usedSeconds: 258 }), 0.027);
  assert.deepEqual(fake.balance(), { assignedCredits: 100, reservedCredits: 0, settledCredits: 0.027 });
  // The unused part of the reservation comes back as a job_refund row, as on
  // the first live run (a debit of 0.303, then a refund of 0.277 for a job
  // that cost 0.026).
  assert.deepEqual(
    fake.creditRows.slice(rowsBefore).map((r) => [r.type, r.amountUsd]),
    [["job_debit", 0.303], ["job_refund", 0.276]],
  );
  const refund = fake.creditRows.at(-1)!;
  assert.notEqual(refund.id, row.id);
  assert.equal(usdSum(refund.amountUsd, 0.027), 0.303, "refund + cost = the reservation");
  assert.equal(fake.settleCredits(id, { usedSeconds: 258 }), 0, "settled once");
  assert.equal(fake.creditRows.length, rowsBefore + 2, "and refunded once");
});

test("a job that used its whole reservation gets no refund row", async () => {
  reset();
  fake.setBalance({ assignedCredits: 100, reservedCredits: 0, settledCredits: 0 });
  const id = await createStarted("wheelsai-whole-timeout", 50);
  assert.ok(fake.attemptList(id));
  const rows = fake.creditRows.length;
  assert.equal((await call("POST", `/api/deployments/${id}/stop`)).status, 200);
  fake.settle(id);
  assert.equal(fake.settleCredits(id, { usedSeconds: 3000 }), 0.303);
  assert.deepEqual(fake.balance(), { assignedCredits: 100, reservedCredits: 0, settledCredits: 0.303 });
  assert.equal(fake.creditRows.length, rows, "nothing to return");
});
