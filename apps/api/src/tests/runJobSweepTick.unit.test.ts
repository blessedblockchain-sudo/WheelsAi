import assert from "node:assert/strict";
import test from "node:test";

import { hireJob, startJob, submitJob, type OfferingForHire } from "../services/jobEscrow.js";
import { runJobSweepTick, type JobSweepDeps, type SweepKind } from "../services/runJobSweepTick.js";
import { sweepQuery } from "../services/buildJobSweepTickDeps.js";
import { makeJobsDb, type Row } from "./jobsDb.js";

// The sweeper's tick over the in-memory jobs database. The loads are the
// production queries (sweepQuery) evaluated against the fake's rows, so the
// conditions tested here are the ones that run.

const T0 = new Date("2026-10-01T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(T0.getTime() + ms);

const OFFERING: OfferingForHire = {
  id: "off_1",
  title: "Competitor teardown",
  publisherId: "org_pub",
  listingId: null,
  priceCents: 2_000n,
  slaSeconds: 3_600,
  maxConcurrentJobs: 50,
};

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (typeof cond === "string") return value === cond;
    const c = cond as { in?: string[]; lte?: Date; gt?: Date };
    if (c.in) return c.in.includes(value as string);
    if (!(value instanceof Date)) return false;
    if (c.lte) return value.getTime() <= c.lte.getTime();
    if (c.gt) return value.getTime() > c.gt.getTime();
    return false;
  });
}

function setup(opts: { noProfile?: boolean } = {}) {
  const db = makeJobsDb({ balance: 1_000_000n, noProfile: opts.noProfile });
  const queued: string[] = [];
  const events: Array<[string, string]> = [];
  const settled: string[] = [];
  const profilesMade: string[] = [];
  const loads: Array<{ kind: SweepKind; excludeIds: string[] }> = [];
  const clock = { now: T0 };

  const deps: JobSweepDeps = {
    load: async ({ kind, now, fundedBefore, limit, excludeIds }) => {
      loads.push({ kind, excludeIds: [...excludeIds] });
      const { where } = sweepQuery(kind, now, fundedBefore);
      return [...db.state.jobs.values()]
        .filter((row) => matchesWhere(row, where as unknown as Record<string, unknown>) && !excludeIds.includes(row.id as string))
        .slice(0, limit)
        .map((row) => ({ id: row.id as string, publisherId: row.publisherId as string }));
    },
    inTransaction: db.inTransaction,
    enqueue: async (jobId) => {
      queued.push(jobId);
    },
    ensurePublisherProfile: async (publisherId) => {
      profilesMade.push(publisherId);
      db.state.profiles.add(publisherId);
    },
    afterSettle: async (row) => {
      settled.push(row.publisherId);
    },
    notify: async (event, jobId) => {
      events.push([event, jobId]);
    },
    now: () => clock.now,
  };

  const hire = async (when = T0) =>
    (
      await db.inTransaction((tx) =>
        hireJob(tx, { offering: OFFERING, buyerId: "org_buyer", input: {}, now: when }),
      )
    ).jobId;
  const start = (jobId: string, when: Date, leaseMs?: number) =>
    db.inTransaction((tx) => startJob(tx, { jobId, now: when, leaseMs }));
  const submit = (jobId: string, when: Date) =>
    db.inTransaction((tx) => submitJob(tx, { jobId, output: { text: "x" }, checkResults: [], now: when }));
  const refunds = () => db.state.ledger.filter((row) => row.type === "marketplace_job_refund");
  return { db, deps, queued, events, settled, profilesMade, loads, clock, hire, start, submit, refunds };
}

test("funded and running jobs past their deadline expire and refund, once", async () => {
  const s = await setup();
  const funded = await s.hire();
  const running = await s.hire();
  await s.start(running, at(MIN));
  s.clock.now = at(HOUR + MIN);

  const first = await runJobSweepTick(s.deps);
  assert.equal(first.expired, 2);
  assert.equal(first.errors, 0);
  for (const id of [funded, running]) {
    assert.equal(s.db.job(id).status, "expired");
    assert.equal(s.db.escrow(id).status, "refunded");
  }
  assert.equal(s.refunds().length, 2);
  assert.equal(s.db.state.balances.get("org_buyer"), 1_000_000n);
  assert.deepEqual(s.events.map(([event]) => event), ["job.expired", "job.expired"]);
  // Nothing past its deadline is re-queued or taken over.
  assert.deepEqual(s.queued, []);

  // A second tick finds nothing left to do.
  const second = await runJobSweepTick(s.deps);
  assert.equal(second.scanned, 0);
  assert.equal(s.refunds().length, 2);
});

test("a submitted job whose review window closed completes by itself and settles once", async () => {
  const s = await setup();
  const jobId = await s.hire();
  await s.start(jobId, at(MIN));
  await s.submit(jobId, at(2 * MIN));

  // Inside the window: untouched.
  s.clock.now = at(71 * HOUR);
  assert.equal((await runJobSweepTick(s.deps)).scanned, 0);
  assert.equal(s.db.job(jobId).status, "submitted");

  s.clock.now = at(72 * HOUR + 3 * MIN);
  const result = await runJobSweepTick(s.deps);
  assert.equal(result.completed, 1);
  assert.equal(s.db.job(jobId).status, "completed");
  assert.equal(s.db.escrow(jobId).status, "settled");
  assert.equal(s.db.state.accrued.get("org_pub"), 1_800n);
  assert.deepEqual(s.settled, ["org_pub"]);
  assert.deepEqual(s.events, [["job.completed", jobId]]);

  await runJobSweepTick(s.deps);
  assert.equal(s.db.state.accrued.get("org_pub"), 1_800n);
});

test("a settle that finds no payout profile creates one and settles, instead of failing every tick", async () => {
  const s = await setup({ noProfile: true });
  const jobId = await s.hire();
  await s.start(jobId, at(MIN));
  await s.submit(jobId, at(2 * MIN));
  s.clock.now = at(73 * HOUR);

  const result = await runJobSweepTick(s.deps);
  assert.equal(result.completed, 1);
  assert.equal(result.errors, 0);
  assert.deepEqual(s.profilesMade, ["org_pub"]);
  assert.equal(s.db.escrow(jobId).status, "settled");
  assert.equal(s.db.state.accrued.get("org_pub"), 1_800n);
});

test("a funded job nobody started is put back on the queue; a fresh one is left alone", async () => {
  const s = await setup();
  const stale = await s.hire(T0);
  const fresh = await s.hire(at(4 * MIN));
  s.clock.now = at(5 * MIN);

  const result = await runJobSweepTick(s.deps);
  assert.equal(result.requeued, 1);
  assert.deepEqual(s.queued, [stale]);
  assert.equal(s.db.job(stale).status, "funded");
  assert.equal(s.db.job(fresh).status, "funded");
});

test("a running job whose lease lapsed before its deadline is handed to a worker; a leased one is not", async () => {
  const s = await setup();
  const dead = await s.hire();
  const alive = await s.hire();
  await s.start(dead, at(MIN), 2 * MIN);
  await s.start(alive, at(MIN), 30 * MIN);
  s.clock.now = at(10 * MIN);

  const result = await runJobSweepTick(s.deps);
  assert.equal(result.reclaimed, 1);
  assert.deepEqual(s.queued, [dead]);
  // The sweeper only hands it over; the worker makes the claim.
  assert.equal(s.db.job(dead).attempts, 1);
});

test("one job that fails does not stop the others, and a job lost to a race is not an error", async () => {
  const s = await setup();
  const a = await s.hire();
  const b = await s.hire();
  const c = await s.hire();
  s.clock.now = at(HOUR + MIN);

  const realTx = s.deps.inTransaction;
  s.deps.inTransaction = async (fn) => {
    return realTx(async (tx) => {
      const wrapped = {
        ...tx,
        job: {
          ...tx.job,
          updateMany: async (args: Parameters<typeof tx.job.updateMany>[0]) => {
            if (args.where.id === a) throw new Error("connection reset");
            // b was expired by a worker between the load and this transaction.
            if (args.where.id === b) return { count: 0 };
            return tx.job.updateMany(args);
          },
        },
      };
      return fn(wrapped);
    });
  };

  const result = await runJobSweepTick(s.deps);
  assert.equal(result.errors, 1);
  assert.equal(result.superseded, 1);
  assert.equal(result.expired, 1);
  assert.equal(s.db.job(c).status, "expired");
  assert.equal(s.refunds().length, 1);
});

test("a tick works through the backlog in batches and never loads a row twice", async () => {
  const s = await setup();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push(await s.hire());
  s.clock.now = at(5 * MIN);
  // Stale funded rows stay funded after being queued, so only excludeIds
  // keeps them out of the next batch.
  const result = await runJobSweepTick(s.deps, { batchSize: 2 });

  assert.equal(result.requeued, 5);
  assert.deepEqual([...s.queued].sort(), [...ids].sort());
  const stale = s.loads.filter((load) => load.kind === "staleFunded");
  assert.deepEqual(
    stale.map((load) => load.excludeIds.length),
    [0, 2, 4, 5],
  );
});

test("a queue that is down counts as an error for that job and the tick goes on", async () => {
  const s = await setup();
  await s.hire();
  s.clock.now = at(5 * MIN);
  s.deps.enqueue = async () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await runJobSweepTick(s.deps);
  assert.equal(result.errors, 1);
  assert.equal(result.requeued, 0);
});
