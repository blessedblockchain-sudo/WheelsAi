import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { buildTrainingPollerTickDeps } from "../services/buildTrainingPollerTickDeps.js";
import { runTrainingPollerTick, TRAINING_POLLER_BATCH } from "../services/runTrainingPollerTick.js";
import { createTrainingJob, cancelTrainingJob } from "../services/trainingJobs.js";
import { eventLine, JOB_INPUT, jobResult, makeWorld, ORG, trainerEvent, type World } from "./trainingFakes.js";

// The poller tick: every job that is not over is reconciled; one that throws
// does not stop the others; a tick with nothing to do touches nothing.

function tickDeps(w: World) {
  const errors: Array<{ jobId: string; error: unknown }> = [];
  const deps = buildTrainingPollerTickDeps({ prisma: w.db.prisma as never, training: w.deps });
  return { errors, deps: { ...deps, onError: (jobId: string, error: unknown) => void errors.push({ jobId, error }) } };
}

test("a tick with no active job makes no Nosana call and reads no configuration", async () => {
  const w = makeWorld();
  w.db.insertJob({ id: "cccccccc-0000-4000-8000-000000000001", status: "completed", reservationCents: 5n });
  w.deps.getRuntime = async () => {
    throw new Error("configuration must not be read");
  };
  const { deps, errors } = tickDeps(w);
  const result = await runTrainingPollerTick(deps);
  assert.deepEqual(result, { examined: 0, transitions: 0, failed: 0, completed: 0, ended: 0 });
  assert.deepEqual(w.nosana.calls, []);
  assert.deepEqual(errors, []);
});

test("one tick carries a job from queued to completed and settles it", async () => {
  const w = makeWorld();
  w.world.runtime.maxActiveJobsPerOrg = 5;
  const created = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  await w.drain();
  const jobId = created.job.id;

  const deployment = w.nosana.only();
  const start = new Date(w.clock.now);
  w.advance(600);
  const uploaded = w.storeAdapter(jobId);
  deployment.status = "stopped";
  deployment.jobs = [{ job: "job-1", status: "COMPLETED" }];
  deployment.job = {
    state: "completed",
    timeStart: start,
    timeEnd: new Date(w.clock.now),
    jobResult: jobResult(0, [eventLine(trainerEvent(1, "uploaded", uploaded)), eventLine(trainerEvent(2, "completed"))]),
  };

  const { deps } = tickDeps(w);
  const result = await runTrainingPollerTick(deps);
  // It went through running and finalizing on the way, one compare-and-set at a time.
  assert.deepEqual(result, { examined: 1, transitions: 1, failed: 0, completed: 1, ended: 1 });
  assert.equal(w.db.job(jobId).status, "completed");
  assert.equal(w.db.job(jobId).actualCostCents, 15n);
  assert.equal(w.db.ledgerOf(jobId).length, 3);

  // Nothing is left for the next tick.
  assert.equal((await runTrainingPollerTick(deps)).examined, 0);
});

test("one job that throws does not stop the others", async () => {
  const w = makeWorld();
  w.world.runtime.maxActiveJobsPerOrg = 5;
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const created = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
    assert.equal(created.ok, true);
    if (created.ok) ids.push(created.job.id);
    w.advance(1);
  }
  w.deferred.length = 0; // every submitter died
  w.advance(120);

  const real = tickDeps(w);
  const reconcile = real.deps.reconcile;
  real.deps.reconcile = async (jobId) => {
    if (jobId === ids[1]) throw new Error("database hiccup");
    return reconcile(jobId);
  };
  const result = await runTrainingPollerTick(real.deps);
  assert.deepEqual(result, { examined: 3, transitions: 2, failed: 1, completed: 0, ended: 0 });
  assert.deepEqual(real.errors.map((entry) => entry.jobId), [ids[1]]);
  assert.deepEqual(ids.map((id) => w.db.job(id).status), ["queued", "pending", "queued"]);

  // The next tick picks the one that failed up again.
  real.deps.reconcile = reconcile;
  await runTrainingPollerTick(real.deps);
  assert.equal(w.db.job(ids[1]!).status, "queued");
});

test("stuck rows are recovered: pending is submitted, a cancel is confirmed, a finalizing job is finalised", async () => {
  const w = makeWorld();
  w.world.runtime.maxActiveJobsPerOrg = 5;
  const make = async () => {
    const created = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
    if (!created.ok) throw new Error(created.code);
    return created.job.id;
  };
  // A cancel whose stop did not land.
  const cancelling = await make();
  await w.drain();
  w.nosana.state.stopError = new Error("stop timed out");
  w.world.orphanRecordFails = true;
  await cancelTrainingJob(w.deps, { orgId: ORG, jobId: cancelling });
  assert.equal(w.db.job(cancelling).status, "cancelling");
  w.nosana.state.stopError = null;
  w.world.orphanRecordFails = false;

  // A job left finalizing by a process that died.
  const finalizing = await make();
  await w.drain();
  const row = w.db.job(finalizing);
  row.status = "finalizing";
  row.startedAt = new Date(w.clock.now);
  w.advance(600);
  row.gpuStoppedAt = new Date(w.clock.now);
  row.metrics = { uploaded: w.storeAdapter(finalizing) };

  // A job left pending.
  const pending = await make();
  w.deferred.length = 0;
  w.advance(61);

  const { deps, errors } = tickDeps(w);
  const result = await runTrainingPollerTick(deps);
  assert.deepEqual(errors, []);
  assert.equal(result.examined, 3);
  assert.equal(w.db.job(cancelling).status, "cancelled");
  assert.equal(w.db.job(finalizing).status, "completed");
  assert.equal(w.db.job(finalizing).actualCostCents, 15n);
  assert.equal(w.db.job(pending).status, "queued");
});

test("jobs are taken least recently examined first, a bounded number per tick, and stamped as taken", async () => {
  const asked: unknown[] = [];
  const at = new Date("2026-10-12T10:00:00.000Z");
  const deps = buildTrainingPollerTickDeps({
    prisma: {
      trainingJob: {
        findMany: async (args: unknown) => {
          asked.push(args);
          return [{ id: "a" }, { id: "b" }];
        },
        updateMany: async (args: unknown) => {
          asked.push(args);
          return { count: 2 };
        },
      },
    } as never,
    training: {} as never,
    now: () => at,
  });
  assert.deepEqual(await deps.listActiveJobIds(TRAINING_POLLER_BATCH), ["a", "b"]);
  assert.deepEqual(asked, [
    {
      where: { status: { in: ["pending", "submitting", "queued", "running", "finalizing", "cancelling"] } },
      select: { id: true },
      orderBy: [{ lastReconciledAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: 200,
    },
    { where: { id: { in: ["a", "b"] } }, data: { lastReconciledAt: at } },
  ]);
});

test("more active jobs than one tick takes: every job is reached, none starves (R5)", async () => {
  // Found by review: ordered by updatedAt, a reconcile that only waits writes
  // nothing, so the same oldest rows were taken every tick.
  const w = makeWorld();
  const ids = Array.from({ length: 7 }, (_, n) => `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`);
  for (const id of ids) w.db.insertJob({ id, status: "queued", reservationCents: 90n });
  const deps = buildTrainingPollerTickDeps({
    prisma: w.db.prisma as never,
    training: w.deps,
    now: () => new Date(w.clock.now),
  });
  const seen = new Set<string>();
  for (let tick = 0; tick < 3; tick += 1) {
    w.advance(15);
    for (const id of await deps.listActiveJobIds(3)) seen.add(id);
  }
  assert.equal(seen.size, 7, "7 jobs, 3 per tick: all within ceil(7 / 3) = 3 ticks");
  // Ticks were [0 1 2], [3 4 5], [6 0 1]; the next takes the ones examined longest ago.
  w.advance(15);
  assert.deepEqual(await deps.listActiveJobIds(3), ids.slice(2, 5));
});
