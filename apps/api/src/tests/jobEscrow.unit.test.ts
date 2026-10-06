import assert from "node:assert/strict";
import test from "node:test";

import {
  completeJob,
  endJobWithRefund,
  hireJob,
  JobFundingError,
  JobTransitionError,
  JOB_REVIEW_WINDOW_MS,
  rejectJob,
  startJob,
  submitJob,
  type EscrowTx,
  type OfferingForHire,
} from "../services/jobEscrow.js";

// Job escrow (Offerings and Jobs). What these pin: the price is held, not
// paid, until the buyer accepts or the review window lapses; every failure
// path refunds; and no job's escrow is ever released twice.

const T0 = new Date("2026-10-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

const OFFERING: OfferingForHire = {
  id: "off_1",
  title: "Competitor teardown",
  publisherId: "org_pub",
  listingId: null,
  priceCents: 2_000n,
  slaSeconds: 3_600,
};

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; gt?: Date; lte?: Date };
      if (c.in) return c.in.includes(v);
      if (c.gt) return v instanceof Date && v.getTime() > c.gt.getTime();
      if (c.lte) return v instanceof Date && v.getTime() <= c.lte.getTime();
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

function makeDb(opts: { balance?: bigint } = {}) {
  const state = {
    balances: new Map<string, bigint>([["org_buyer", opts.balance ?? 10_000n]]),
    jobs: new Map<string, Row>(),
    revenue: new Map<string, Row>(),
    ledger: [] as Row[],
    accrued: new Map<string, bigint>(),
  };
  let seq = 0;

  // Each transaction records how to undo its own writes, so a failed
  // transaction rolls back only what it did, like a real database (a
  // whole-state snapshot would also erase a concurrent winner's writes).
  function txFor(undo: Array<() => void>): EscrowTx {
    const restoreFields = (row: Row, data: Row) => {
      const before = Object.fromEntries(Object.keys(data).map((k) => [k, row[k]]));
      undo.push(() => Object.assign(row, before));
    };
    return {
      creditBalance: {
        async updateMany({ where, data }) {
          const bal = state.balances.get(where.orgId) ?? 0n;
          if (bal < where.balanceCents.gte) return { count: 0 };
          state.balances.set(where.orgId, bal - data.balanceCents.decrement);
          undo.push(() => state.balances.set(where.orgId, (state.balances.get(where.orgId) ?? 0n) + data.balanceCents.decrement));
          return { count: 1 };
        },
        async findUnique({ where }) {
          const bal = state.balances.get(where.orgId);
          return bal === undefined ? null : { balanceCents: bal };
        },
        async update({ where, data }) {
          const bal = (state.balances.get(where.orgId) ?? 0n) + data.balanceCents.increment;
          state.balances.set(where.orgId, bal);
          undo.push(() => state.balances.set(where.orgId, (state.balances.get(where.orgId) ?? 0n) - data.balanceCents.increment));
          return { balanceCents: bal };
        },
      },
      creditTransaction: {
        async create({ data }) {
          state.ledger.push(data);
          undo.push(() => state.ledger.splice(state.ledger.indexOf(data), 1));
          return data;
        },
      },
      job: {
        async create({ data }) {
          const row = { id: `job_${++seq}`, ...data } as Row;
          state.jobs.set(row.id as string, row);
          undo.push(() => state.jobs.delete(row.id as string));
          return { id: row.id as string, deadlineAt: (row.deadlineAt as Date) ?? null };
        },
        async updateMany({ where, data }) {
          let count = 0;
          for (const row of state.jobs.values()) {
            if (matches(row, where as Row)) {
              restoreFields(row, data as Row);
              Object.assign(row, data);
              count++;
            }
          }
          return { count };
        },
      },
      marketplaceRevenue: {
        async create({ data }) {
          const row = { id: `rev_${++seq}`, ...data } as Row;
          state.revenue.set(row.jobId as string, row);
          undo.push(() => state.revenue.delete(row.jobId as string));
          return { id: row.id as string };
        },
        async updateMany({ where, data }) {
          const row = state.revenue.get(where.jobId);
          if (!row || row.status !== where.status) return { count: 0 };
          restoreFields(row, data as Row);
          Object.assign(row, data);
          return { count: 1 };
        },
        async findUnique({ where }) {
          const row = state.revenue.get(where.jobId);
          return row
            ? {
                id: row.id as string,
                listingId: (row.listingId as string | null) ?? null,
                buyerId: row.buyerId as string,
                publisherId: row.publisherId as string,
                grossAmountCents: row.grossAmountCents as bigint,
                creatorAmountCents: row.creatorAmountCents as bigint,
              }
            : null;
        },
      },
      publisherProfile: {
        async update({ where, data }) {
          const inc = data.pendingPayoutCents.increment;
          state.accrued.set(where.orgId, (state.accrued.get(where.orgId) ?? 0n) + inc);
          undo.push(() => state.accrued.set(where.orgId, (state.accrued.get(where.orgId) ?? 0n) - inc));
          return {};
        },
      },
    };
  }

  async function inTransaction<T>(fn: (t: EscrowTx) => Promise<T>): Promise<T> {
    const undo: Array<() => void> = [];
    try {
      return await fn(txFor(undo));
    } catch (err) {
      for (const u of undo.reverse()) u();
      throw err;
    }
  }

  const job = (id: string) => state.jobs.get(id)!;
  const escrow = (id: string) => state.revenue.get(id)!;
  return { state, inTransaction, job, escrow };
}

async function hired(opts: { balance?: bigint } = {}) {
  const db = makeDb(opts);
  const { jobId } = await db.inTransaction((tx) =>
    hireJob(tx, { offering: OFFERING, buyerId: "org_buyer", input: { url: "https://example.com" }, now: T0 }),
  );
  return { ...db, jobId };
}

async function submitted(opts: { balance?: bigint } = {}) {
  const db = await hired(opts);
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId, now: at(0.1) }));
  await db.inTransaction((tx) =>
    submitJob(tx, { jobId: db.jobId, output: { report: "..." }, checkResults: [], now: at(0.5) }),
  );
  return db;
}

// ============================================
// Fund
// ============================================

test("hiring holds the price in escrow: buyer debited, creator not yet paid", async () => {
  const { state, job, escrow, jobId } = await hired();
  assert.equal(state.balances.get("org_buyer"), 8_000n);
  assert.equal(job(jobId).status, "funded");
  assert.equal((job(jobId).deadlineAt as Date).getTime(), at(1).getTime());
  assert.deepEqual(
    {
      type: escrow(jobId).type,
      status: escrow(jobId).status,
      gross: escrow(jobId).grossAmountCents,
      fee: escrow(jobId).platformFeeCents,
      creator: escrow(jobId).creatorAmountCents,
    },
    { type: "job", status: "pending", gross: 2_000n, fee: 200n, creator: 1_800n },
  );
  assert.equal(state.accrued.size, 0);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0]!.amountCents, -2_000n);
  assert.equal(state.ledger[0]!.balanceAfter, 8_000n);
});

test("a buyer who cannot pay gets no job, no escrow and no charge", async () => {
  const db = makeDb({ balance: 1_999n });
  await assert.rejects(
    db.inTransaction((tx) => hireJob(tx, { offering: OFFERING, buyerId: "org_buyer", input: {}, now: T0 })),
    (err: unknown) =>
      err instanceof JobFundingError && err.requiredCents === 2_000n && err.balanceCents === 1_999n,
  );
  assert.equal(db.state.balances.get("org_buyer"), 1_999n);
  assert.equal(db.state.jobs.size, 0);
  assert.equal(db.state.revenue.size, 0);
  assert.equal(db.state.ledger.length, 0);
});

test("a publisher cannot hire their own offering", async () => {
  const db = makeDb();
  db.state.balances.set("org_pub", 10_000n);
  await assert.rejects(
    db.inTransaction((tx) => hireJob(tx, { offering: OFFERING, buyerId: "org_pub", input: {}, now: T0 })),
    JobTransitionError,
  );
  assert.equal(db.state.balances.get("org_pub"), 10_000n);
});

// ============================================
// Settle
// ============================================

test("accepting a submitted job pays the creator exactly once", async () => {
  const { state, inTransaction, job, escrow, jobId } = await submitted();
  assert.equal(job(jobId).status, "submitted");
  assert.equal((job(jobId).reviewDeadlineAt as Date).getTime(), at(0.5).getTime() + JOB_REVIEW_WINDOW_MS);

  const { creatorCents } = await inTransaction((tx) =>
    completeJob(tx, { jobId, buyerId: "org_buyer", rating: 9, now: at(2) }),
  );
  assert.equal(creatorCents, 1_800n);
  assert.equal(job(jobId).status, "completed");
  assert.equal(job(jobId).rating, 5); // clamped to 1-5
  assert.equal(escrow(jobId).status, "settled");
  assert.equal(state.accrued.get("org_pub"), 1_800n);

  await assert.rejects(
    inTransaction((tx) => completeJob(tx, { jobId, buyerId: "org_buyer", now: at(3) })),
    JobTransitionError,
  );
  assert.equal(state.accrued.get("org_pub"), 1_800n);
});

test("only the buyer can accept, and only once the job is submitted", async () => {
  const db = await hired();
  await assert.rejects(
    db.inTransaction((tx) => completeJob(tx, { jobId: db.jobId, buyerId: "org_buyer", now: at(0.2) })),
    JobTransitionError,
  );
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId }));
  await db.inTransaction((tx) => submitJob(tx, { jobId: db.jobId, output: {}, checkResults: [], now: at(0.5) }));
  await assert.rejects(
    db.inTransaction((tx) => completeJob(tx, { jobId: db.jobId, buyerId: "org_other", now: at(1) })),
    JobTransitionError,
  );
  assert.equal(db.escrow(db.jobId).status, "pending");
});

test("an unreviewed job auto-completes only after its review window", async () => {
  const { inTransaction, job, escrow, jobId } = await submitted();
  await assert.rejects(
    inTransaction((tx) => completeJob(tx, { jobId, auto: true, now: at(24) })),
    JobTransitionError,
  );
  assert.equal(escrow(jobId).status, "pending");
  await inTransaction((tx) => completeJob(tx, { jobId, auto: true, now: at(0.5 + 72) }));
  assert.equal(job(jobId).status, "completed");
  assert.equal(escrow(jobId).status, "settled");
});

// ============================================
// Refund
// ============================================

test("rejecting inside the review window refunds the buyer in full", async () => {
  const { state, inTransaction, job, escrow, jobId } = await submitted();
  await assert.rejects(
    inTransaction((tx) => rejectJob(tx, { jobId, buyerId: "org_buyer", reason: " ", now: at(1) })),
    /Say why/,
  );
  const { refundedCents } = await inTransaction((tx) =>
    rejectJob(tx, { jobId, buyerId: "org_buyer", reason: "Missed half the competitors", now: at(1) }),
  );
  assert.equal(refundedCents, 2_000n);
  assert.equal(state.balances.get("org_buyer"), 10_000n);
  assert.equal(job(jobId).status, "rejected");
  assert.equal(job(jobId).rejectionReason, "Missed half the competitors");
  assert.equal(escrow(jobId).status, "refunded");
  assert.equal(state.accrued.size, 0);
  const refund = state.ledger.at(-1)!;
  assert.equal(refund.amountCents, 2_000n);
  assert.equal(refund.balanceAfter, 10_000n);
  assert.equal(refund.type, "marketplace_job_refund");
});

test("a rejection after the review window is refused and the creator keeps the right to be paid", async () => {
  const { inTransaction, escrow, jobId } = await submitted();
  await assert.rejects(
    inTransaction((tx) => rejectJob(tx, { jobId, buyerId: "org_buyer", reason: "too late", now: at(0.5 + 73) })),
    JobTransitionError,
  );
  assert.equal(escrow(jobId).status, "pending");
});

test("a run that fails, or misses its SLA, refunds; cancel works only before the run starts", async () => {
  const failed = await hired();
  await failed.inTransaction((tx) => startJob(tx, { jobId: failed.jobId }));
  await assert.rejects(
    failed.inTransaction((tx) =>
      endJobWithRefund(tx, { jobId: failed.jobId, to: "cancelled", reason: "changed my mind", buyerId: "org_buyer" }),
    ),
    /has not started/,
  );
  await failed.inTransaction((tx) =>
    endJobWithRefund(tx, { jobId: failed.jobId, to: "failed", reason: "deliverable check failed" }),
  );
  assert.equal(failed.job(failed.jobId).status, "failed");
  assert.equal(failed.state.balances.get("org_buyer"), 10_000n);

  const expired = await hired();
  await expired.inTransaction((tx) => endJobWithRefund(tx, { jobId: expired.jobId, to: "expired", reason: "SLA passed" }));
  assert.equal(expired.job(expired.jobId).status, "expired");
  assert.equal(expired.escrow(expired.jobId).status, "refunded");

  const cancelled = await hired();
  await assert.rejects(
    cancelled.inTransaction((tx) =>
      endJobWithRefund(tx, { jobId: cancelled.jobId, to: "cancelled", reason: "oops", buyerId: "org_someone_else" }),
    ),
    JobTransitionError,
  );
  await cancelled.inTransaction((tx) =>
    endJobWithRefund(tx, { jobId: cancelled.jobId, to: "cancelled", reason: "oops", buyerId: "org_buyer" }),
  );
  assert.equal(cancelled.state.balances.get("org_buyer"), 10_000n);
});

// ============================================
// Exactly once
// ============================================

test("accept and reject racing on the same job release the escrow once", async () => {
  const { state, inTransaction, escrow, jobId } = await submitted();
  const results = await Promise.allSettled([
    inTransaction((tx) => completeJob(tx, { jobId, buyerId: "org_buyer", now: at(1) })),
    inTransaction((tx) => rejectJob(tx, { jobId, buyerId: "org_buyer", reason: "not what I asked for", now: at(1) })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const settled = escrow(jobId).status === "settled";
  assert.ok(settled || escrow(jobId).status === "refunded");
  // Money moved one way only.
  assert.equal(state.balances.get("org_buyer"), settled ? 8_000n : 10_000n);
  assert.equal(state.accrued.get("org_pub") ?? 0n, settled ? 1_800n : 0n);
});

test("an expiry racing the deliverable cannot both refund and settle", async () => {
  const db = await hired();
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId }));
  const [submittedOk] = await Promise.all([
    db.inTransaction((tx) => submitJob(tx, { jobId: db.jobId, output: {}, checkResults: [], now: at(0.9) })),
    db
      .inTransaction((tx) => endJobWithRefund(tx, { jobId: db.jobId, to: "expired", reason: "SLA passed" }))
      .catch(() => null),
  ]);
  const status = db.job(db.jobId).status;
  if (submittedOk) {
    assert.equal(status, "submitted");
    assert.equal(db.escrow(db.jobId).status, "pending");
  } else {
    assert.equal(status, "expired");
    assert.equal(db.escrow(db.jobId).status, "refunded");
  }
});
