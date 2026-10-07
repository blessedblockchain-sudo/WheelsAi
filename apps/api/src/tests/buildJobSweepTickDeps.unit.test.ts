import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { buildJobSweepTickDeps, sweepQuery } from "../services/buildJobSweepTickDeps.js";

// The sweeper's queries, pinned against the indexes they are written for
// (jobs(status, deadline_at), (status, review_deadline_at),
// (status, lease_expires_at)).

const NOW = new Date("2026-10-06T12:00:00Z");
const CUTOFF = new Date("2026-10-06T11:58:00Z");

test("each sweep is one status-led range scan, oldest first", () => {
  assert.deepEqual(sweepQuery("expired", NOW, CUTOFF), {
    where: { status: { in: ["funded", "running"] }, deadlineAt: { lte: NOW } },
    orderBy: { deadlineAt: "asc" },
  });
  assert.deepEqual(sweepQuery("reviewLapsed", NOW, CUTOFF), {
    where: { status: "submitted", reviewDeadlineAt: { lte: NOW } },
    orderBy: { reviewDeadlineAt: "asc" },
  });
  // Re-queue and takeover never touch a job that is already past its deadline.
  assert.deepEqual(sweepQuery("staleFunded", NOW, CUTOFF), {
    where: { status: "funded", fundedAt: { lte: CUTOFF }, deadlineAt: { gt: NOW } },
    orderBy: { deadlineAt: "asc" },
  });
  assert.deepEqual(sweepQuery("lapsedLease", NOW, CUTOFF), {
    where: { status: "running", leaseExpiresAt: { lte: NOW }, deadlineAt: { gt: NOW } },
    orderBy: { leaseExpiresAt: "asc" },
  });
});

test("a load carries the limit and the rows already handled, and money moves inside $transaction", async () => {
  const seen: unknown[] = [];
  let transactions = 0;
  const deps = buildJobSweepTickDeps({
    prisma: {
      job: {
        findMany: async (args) => {
          seen.push(args);
          return [{ id: "job_1", publisherId: "org_pub" }];
        },
      },
      $transaction: async (fn) => {
        transactions++;
        return fn({ marker: "tx" });
      },
    },
    enqueue: async () => {},
    ensurePublisherProfile: async () => {},
    afterSettle: async () => {},
    notify: async () => {},
  });

  const rows = await deps.load({ kind: "expired", now: NOW, fundedBefore: CUTOFF, limit: 25, excludeIds: [] });
  assert.deepEqual(rows, [{ id: "job_1", publisherId: "org_pub" }]);
  await deps.load({ kind: "expired", now: NOW, fundedBefore: CUTOFF, limit: 25, excludeIds: ["job_1"] });

  assert.deepEqual(seen[0], {
    where: { status: { in: ["funded", "running"] }, deadlineAt: { lte: NOW } },
    orderBy: { deadlineAt: "asc" },
    take: 25,
    select: { id: true, publisherId: true },
  });
  assert.deepEqual((seen[1] as { where: { id: unknown } }).where.id, { notIn: ["job_1"] });

  const got = await deps.inTransaction(async (tx) => (tx as unknown as { marker: string }).marker);
  assert.equal(got, "tx");
  assert.equal(transactions, 1);
});
