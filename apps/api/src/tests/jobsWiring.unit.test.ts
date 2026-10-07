import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Wiring pins for Offerings and Jobs. The escrow core sat in the codebase
// with no callers: a state machine nobody could reach. These pin it to the
// places that now call it, so it cannot quietly become dead code again.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");
const source = (relative: string) => readFileSync(path.join(SRC, relative), "utf8");

test("the server mounts /api/offerings and /api/jobs", () => {
  const index = source("index.ts");
  assert.match(index, /register\(createOfferingRoutesProduction\(\), \{ prefix: "\/api\/offerings" \}\)/);
  assert.match(index, /register\(createJobRoutesProduction\(\), \{ prefix: "\/api\/jobs" \}\)/);
});

test("the server starts and stops the job runner and the job sweeper", () => {
  const index = source("index.ts");
  for (const call of ["startJobRunnerQueue()", "startJobSweeperQueue()", "stopJobRunnerQueue()", "stopJobSweeperQueue()"]) {
    assert.ok(index.includes(`await ${call}`), call);
  }
  const queues = source("queues/index.ts");
  assert.match(queues, /startJobRunnerQueue, stopJobRunnerQueue/);
  assert.match(queues, /startJobSweeperQueue, stopJobSweeperQueue/);
});

test("the hire service queues the run only after the hire transaction committed", () => {
  const jobs = source("services/jobs.ts");
  const transaction = jobs.indexOf("deps.store.inTransaction(async (tx) => {");
  const hire = jobs.indexOf("return hireJob(tx,");
  const enqueue = jobs.indexOf("await deps.enqueue(hired.jobId)");
  assert.ok(transaction > 0 && hire > transaction && enqueue > hire);
  // Nothing inside the transaction talks to the queue.
  const body = jobs.slice(transaction, jobs.indexOf("} catch (err) {", transaction));
  assert.ok(!body.includes("enqueue"));
  // And the unique violation of a repeated Idempotency-Key is handled outside it.
  assert.ok(!body.includes("P2002") && !body.includes("isUniqueViolation"));
});

test("every escrow transition has a caller", () => {
  const callers: Record<string, string[]> = {
    hireJob: ["services/jobs.ts"],
    startJob: ["services/jobRunner.ts"],
    reclaimJob: ["services/jobRunner.ts"],
    submitJob: ["services/jobRunner.ts"],
    releaseJobLease: ["services/jobRunner.ts"],
    completeJob: ["services/jobs.ts", "services/runJobSweepTick.ts"],
    rejectJob: ["services/jobs.ts"],
    rateJob: ["services/jobs.ts"],
    endJobWithRefund: ["services/jobs.ts", "services/jobRunner.ts", "services/runJobSweepTick.ts"],
  };
  for (const [fn, files] of Object.entries(callers)) {
    for (const file of files) {
      assert.match(source(file), new RegExp(`\\b${fn}\\(tx,`), `${fn} is not called from ${file}`);
    }
  }
});

test("the runner's production deps use the one inference path and the workflow run entry point", () => {
  const deps = source("services/buildJobRunnerDeps.ts");
  assert.match(deps, /buildProductionExecutorDeps\(\)/);
  assert.match(deps, /await startWorkflowRun\(/);
  assert.match(deps, /triggeredBy: "job" as const/);
  assert.match(deps, /mode: "hired"/);
  assert.match(deps, /chatWithDeployment\(\{/);
});

test("the queue's worker runs runJob on the production deps, and the sweeper re-queues through the same queue", () => {
  const runner = source("queues/job-runner.queue.ts");
  assert.match(runner, /runJob\(\{ jobId, shutdownSignal: controller\.signal \}, deps\)/);
  assert.match(runner, /buildJobRunnerDeps\(\)/);
  assert.match(runner, /env\.JOB_RUNNER_CONCURRENCY <= 0/);
  const sweeper = source("queues/job-sweeper.queue.ts");
  assert.match(sweeper, /enqueueJobRun\(jobId, \{ replaceFinished: true \}\)/);
  assert.match(sweeper, /runJobSweepTick\(deps\)/);
});

test("hiring and every money-moving job route sit behind the spend guard", () => {
  const offerings = source("routes/offerings.ts");
  assert.match(offerings, /"\/:id\/hire", \{ preHandler: \[guards\.auth, guards\.spend\("jobs:hire"\)\] \}/);
  const jobs = source("routes/jobs.ts");
  assert.match(jobs, /"\/:id\/accept", \{ preHandler: \[guards\.auth, guards\.spend\("jobs:review"\)\] \}/);
  assert.match(jobs, /"\/:id\/reject", \{ preHandler: \[guards\.auth, guards\.spend\("jobs:review"\)\] \}/);
  assert.match(jobs, /"\/:id\/cancel", \{ preHandler: \[guards\.auth, guards\.spend\("jobs:hire"\)\] \}/);
  // Installing a listing can charge too.
  assert.match(source("routes/marketplace.ts"), /requireAuth, requireScope\("marketplace:install"\)/);
});

test("the job runner's env knobs exist with the documented defaults", () => {
  const env = source("config/env.ts");
  assert.match(env, /JOB_RUNNER_CONCURRENCY: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(50\)\.default\(2\)/);
  assert.match(env, /JOB_SWEEP_INTERVAL_MS: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.default\(60_000\)/);
  assert.match(env, /JOB_MAX_RUN_MS: .*\.default\(900_000\)/);
});
