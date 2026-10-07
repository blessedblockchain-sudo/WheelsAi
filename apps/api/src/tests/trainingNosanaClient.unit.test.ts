import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startFakeNosanaApi, startRequestCounter, FAKE_MARKETS } from "./fakeNosanaApi.js";

// The training job service driven through the REAL NosanaClient and
// @nosana/sdk against the stand-in Nosana REST API on loopback: the submit
// (name, timeout, strategy, confidentiality), the status and job reads, the
// stop, the lost-deployment lookup, and the access mode stored with the id.
// Nothing here reaches Nosana or Solana.

const fake = await startFakeNosanaApi();
const rpc = await startRequestCounter();
after(async () => {
  await fake.close();
  await rpc.close();
});

// Before any app module loads: config/env.ts and config/nosanaAccess.ts read these.
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
process.env.SOLANA_RPC_URL = rpc.url;
process.env.SOLANA_NETWORK = "devnet";
process.env.NOSANA_API_KEY = fake.apiKey;
process.env.NOSANA_API_URL = fake.url;
process.env.NOSANA_CREDITS_CACHE_MS = "0";
process.env.NOSANA_COST_CACHE_MS = "0";
for (const name of [
  "NOSANA_WALLET_PRIVATE_KEY",
  "NOSANA_ACCESS_MODE",
  "NOSANA_NETWORK",
  "NOSANA_TIMEOUT_UNIT",
  "NOSANA_MIN_CREDITS_USD",
  "NOSANA_MARKETS_JSON",
  "NOSANA_JOB_TIMEOUT_SECONDS",
  "NOSANA_BATCH_JOB_TIMEOUT_SECONDS",
  "ALLOW_NOSANA_MOCK",
  "SOLANA_WALLET",
  "ANCHOR_PROVIDER_URL",
]) {
  delete process.env[name];
}

const { NosanaClient } = await import("../services/nosana.js");
const { resetNosanaAccessConfigForTests } = await import("../config/nosanaAccess.js");
const { cancelTrainingJob, createTrainingJob, reconcileTrainingJob } = await import(
  "../services/trainingJobs.js"
);
const { eventLine, JOB_INPUT, jobResult, makeWorld, ORG, trainerEvent } = await import("./trainingFakes.js");

type World = ReturnType<typeof makeWorld>;

function resetFake() {
  fake.rotateApiKey(fake.apiKey);
  fake.setBalance({ assignedCredits: 100, reservedCredits: 0, settledCredits: 0 });
  fake.setMarkets(FAKE_MARKETS);
  fake.setOwner("11111111111111111111111111111111");
  fake.setInsufficientFunds(false);
  fake.requests.length = 0;
  fake.deployments.clear();
}

const sent = (method: string, path: RegExp) =>
  fake.requests.filter((r) => r.method === method && path.test(r.path));

/** The fake world with the real client where its Nosana port was. */
async function realWorld(): Promise<World> {
  resetFake();
  resetNosanaAccessConfigForTests();
  const client = new NosanaClient();
  await client.initialize();
  const w = makeWorld();
  w.deps.getNosana = async () => client as never;
  // The fake job's times are compared with the world's clock.
  w.clock.now = new Date(Math.floor(Date.now() / 1000) * 1000);
  return w;
}

async function submitted(w: World) {
  const created = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(created.ok, true, created.ok ? "" : created.code);
  if (!created.ok) throw new Error("unreachable");
  await w.drain();
  return created.job.id;
}

/** A node took the job: the deployment runs and lists one job that started now. */
function nodeStarts(w: World, deploymentId: string, job = "JobAddr1111111111111111111111111111111111111") {
  fake.settle(deploymentId);
  const deployment = fake.deployments.get(deploymentId)!;
  deployment.jobs.push({
    job,
    status: "RUNNING",
    tx: "tx",
    deployment: deploymentId,
    revision: 1,
    created_at: new Date().toISOString(),
  });
  // State as a number and times as unix seconds, as the chain reports them.
  fake.setJob(deploymentId, job, { state: 1, timeStart: w.clock.now.getTime() / 1000, timeEnd: 0, jobResult: null });
  return job;
}

test("submit: the real client creates a confidential one-shot deployment under the deterministic name with the job's timeout", async () => {
  const w = await realWorld();
  const jobId = await submitted(w);
  const job = w.db.job(jobId);
  assert.equal(job.status, "queued");
  assert.equal(job.nosanaAccessMode, "api_key", "the credential that created it, stored with the id");

  const creates = sent("POST", /\/api\/deployments\/create$/);
  assert.equal(creates.length, 1);
  const body = creates[0]!.body as Record<string, any>;
  assert.equal(body.name, `wheelsai-train-${jobId}-${job.submitNonce}`);
  // The run limit plus the set-up allowance, 4500 s, in the unit the
  // Deployment Manager is sent (NOSANA_TIMEOUT_UNIT, minutes unless set).
  assert.equal(body.timeout, 75);
  assert.equal(body.strategy, "SIMPLE", "finite work: never extended");
  assert.equal(body.replicas, 1);
  assert.equal(body.confidential, true, "the definition holds credentials");
  assert.equal(body.market, "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf");
  const op = body.job_definition.ops[0];
  assert.equal(body.job_definition.type, "container");
  assert.equal(op.args.env.JOB_ID, jobId);
  assert.equal(op.args.env.MAX_RUNTIME_SECONDS, "3600");
  assert.equal(op.args.cmd, undefined);

  assert.equal(fake.deployments.get(job.nosanaJobId!)!.name, body.name);
  assert.equal(sent("POST", new RegExp(`/${job.nosanaJobId}/start$`)).length, 1);
  assert.equal(creates[0]!.authorization, `Bearer ${fake.apiKey}`);
  assert.equal(fake.vaultCalls(), 0, "API-key access never asks for a vault");
  assert.equal(rpc.count(), 0, "nothing was asked of Solana");
});

test("status: queued -> running from the deployment's job, then completed from its result, and the deployment is released", async () => {
  const w = await realWorld();
  const jobId = await submitted(w);
  const deploymentId = w.db.job(jobId).nosanaJobId!;

  // STARTING, no job yet: nothing changes.
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "waiting");

  const job = nodeStarts(w, deploymentId);
  const started = new Date(w.clock.now);
  const running = await reconcileTrainingJob(w.deps, jobId);
  assert.deepEqual([running.from, running.to], ["queued", "running"]);
  assert.deepEqual(w.db.job(jobId).startedAt, started, "billable time starts at the Nosana job's start");
  assert.equal(w.db.job(jobId).nosanaJobAddress, job);

  // Ten minutes later the job ends with exit 0; its log carries the events.
  w.advance(600);
  const uploaded = w.storeAdapter(jobId);
  fake.setJob(deploymentId, job, {
    state: 2,
    timeStart: started.getTime() / 1000,
    timeEnd: w.clock.now.getTime() / 1000,
    jobResult: jobResult(0, [
      eventLine(trainerEvent(1, "started")),
      eventLine(trainerEvent(2, "uploaded", uploaded)),
      eventLine(trainerEvent(3, "completed")),
    ]),
  });
  fake.setStatus(deploymentId, "STOPPED");
  fake.requests.length = 0;

  const done = await reconcileTrainingJob(w.deps, jobId);
  assert.equal(done.to, "completed");
  const row = w.db.job(jobId);
  assert.equal(row.billedSeconds, 600);
  assert.equal(row.actualCostCents, 15n);
  assert.equal(w.db.ledgerOf(jobId).length, 3);
  assert.equal(w.db.fineTuned.length, 1);
  assert.equal(sent("GET", new RegExp(`/${deploymentId}/jobs/${job}$`)).length >= 1, true);
  assert.equal(sent("POST", new RegExp(`/${deploymentId}/stop$`)).length, 0, "already stopped: no second stop");
  assert.deepEqual(w.orphans, [], "stopped and nothing left to release");
});

test("stop: a cancel stops the deployment with the API key; not yet released, it goes to the sweep as api_key", async () => {
  const w = await realWorld();
  const jobId = await submitted(w);
  const deploymentId = w.db.job(jobId).nosanaJobId!;
  nodeStarts(w, deploymentId);
  await reconcileTrainingJob(w.deps, jobId);
  w.advance(300);
  fake.requests.length = 0;

  const result = await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  assert.deepEqual(result, { ok: true, status: "cancelled" });
  const stops = sent("POST", new RegExp(`/${deploymentId}/stop$`));
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.authorization, `Bearer ${fake.apiKey}`);
  assert.equal(fake.deployments.get(deploymentId)!.status, "STOPPING");
  // The fake answers STOPPING: stopped, not yet released.
  assert.deepEqual(w.orphans, [
    { nosanaDeploymentId: deploymentId, sourceKind: "training", sourceId: jobId, reason: "training_cancelled", accessMode: "api_key" },
  ]);
  assert.equal(w.db.job(jobId).billedSeconds, 300);
  assert.equal(w.db.job(jobId).actualCostCents, 8n);
});

test("lost deployment: the SDK throws after Nosana created it - found in Nosana's list by name and stopped before the refund", async () => {
  const w = await realWorld();
  // The server creates the deployment, then the SDK fails to parse the answer.
  fake.setOwner("user_01HZX-not-a-base58-key!");
  const jobId = await submitted(w);

  const job = w.db.job(jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.failureCode, "submit_failed");
  assert.equal(job.nosanaJobId, null, "no id ever came back");
  assert.equal(fake.deployments.size, 1, "but the deployment exists");
  const lost = [...fake.deployments.values()][0]!;
  assert.equal(lost.name, `wheelsai-train-${jobId}-${job.submitNonce}`);
  assert.equal(sent("GET", /\/api\/deployments$/).length >= 1, true, "the list was read");
  assert.notEqual(lost.status, "RUNNING");
  assert.notEqual(lost.status, "STARTING");
  // Stopped or durably recorded for the sweep, with the credential's mode.
  const stopped = sent("POST", new RegExp(`/${lost.id}/stop$`)).length > 0 || ["DRAFT", "STOPPED", "STOPPING"].includes(lost.status);
  assert.equal(stopped, true);
  for (const orphan of w.orphans) {
    assert.deepEqual([orphan.nosanaDeploymentId, orphan.accessMode], [lost.id, "api_key"]);
  }
  assert.deepEqual(w.db.ledgerOf(jobId).map((row) => row.type), ["training_reservation", "training_reservation_release"]);
  assert.equal(w.db.balance(), 10_000n);
});

test("pre-flight: with the platform's credits too low the job is refused before any row or credit moves", async () => {
  const w = await realWorld();
  fake.setBalance({ assignedCredits: 0.01, reservedCredits: 0, settledCredits: 0 });
  const result = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.deepEqual(!result.ok && [result.status, result.code, result.extra], [
    503,
    "compute_capacity_unavailable",
    { reason: "nosana_credits_low" },
  ]);
  assert.equal(w.db.jobs.length, 0);
  assert.equal(w.db.ledger.length, 0);
  assert.equal(sent("POST", /create$/).length, 0);
});

test("a deployment that ran out of platform funds fails the job free and is retired", async () => {
  const w = await realWorld();
  const jobId = await submitted(w);
  const deploymentId = w.db.job(jobId).nosanaJobId!;
  fake.setStatus(deploymentId, "INSUFFICIENT_FUNDS");
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.equal(result.to, "failed");
  assert.equal(w.db.job(jobId).failureCode, "nosana_insufficient_funds");
  assert.equal(w.db.job(jobId).actualCostCents, 0n);
  assert.equal(w.db.balance(), 10_000n);
});
