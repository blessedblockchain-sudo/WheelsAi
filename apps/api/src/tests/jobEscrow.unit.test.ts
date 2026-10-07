import assert from "node:assert/strict";
import test from "node:test";

import {
  completeJob,
  endJobWithRefund,
  hireJob,
  JobFundingError,
  JobSettlementError,
  JobTermsError,
  JobTransitionError,
  JobUnavailableError,
  JOB_RATING_WINDOW_MS,
  JOB_REVIEW_WINDOW_MS,
  rateJob,
  reclaimJob,
  rejectJob,
  releaseJobLease,
  startJob,
  submitJob,
  type OfferingForHire,
} from "../services/jobEscrow.js";
import { makeJobsDb as makeDb } from "./jobsDb.js";

// Job escrow (Offerings and Jobs). What these pin: the price is held, not
// paid, until the buyer accepts or the review window lapses; every failure
// path refunds; no job's escrow is ever released twice; and the SLA is part
// of each transition, so a late deliverable cannot be submitted and a job
// cannot be expired early.

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
  maxConcurrentJobs: 2,
  deliverableChecks: [{ type: "contains", value: "competitor" }],
  outputFormat: "text",
};

async function hired(opts: { balance?: bigint; noProfile?: boolean } = {}) {
  const db = makeDb(opts);
  const { jobId } = await db.inTransaction((tx) =>
    hireJob(tx, { offering: OFFERING, buyerId: "org_buyer", input: { url: "https://example.com" }, now: T0 }),
  );
  return { ...db, jobId };
}

async function submitted(opts: { balance?: bigint; noProfile?: boolean } = {}) {
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
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId, now: at(0.1) }));
  await db.inTransaction((tx) => submitJob(tx, { jobId: db.jobId, output: {}, checkResults: [], now: at(0.5) }));
  await assert.rejects(
    db.inTransaction((tx) => completeJob(tx, { jobId: db.jobId, buyerId: "org_other", now: at(1) })),
    JobTransitionError,
  );
  // An accept that names no buyer must not match "any submitted job".
  await assert.rejects(
    db.inTransaction((tx) => completeJob(tx, { jobId: db.jobId, now: at(1) })),
    /Only the buyer/,
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
  await failed.inTransaction((tx) => startJob(tx, { jobId: failed.jobId, now: at(0.1) }));
  await assert.rejects(
    failed.inTransaction((tx) =>
      endJobWithRefund(tx, {
        jobId: failed.jobId,
        to: "cancelled",
        reason: "changed my mind",
        buyerId: "org_buyer",
        now: at(0.2),
      }),
    ),
    /has not started/,
  );
  await failed.inTransaction((tx) =>
    endJobWithRefund(tx, { jobId: failed.jobId, to: "failed", reason: "deliverable check failed", now: at(0.3) }),
  );
  assert.equal(failed.job(failed.jobId).status, "failed");
  assert.equal(failed.state.balances.get("org_buyer"), 10_000n);

  const expired = await hired();
  await expired.inTransaction((tx) =>
    endJobWithRefund(tx, { jobId: expired.jobId, to: "expired", reason: "SLA passed", now: at(1) }),
  );
  assert.equal(expired.job(expired.jobId).status, "expired");
  assert.equal(expired.escrow(expired.jobId).status, "refunded");

  const cancelled = await hired();
  await assert.rejects(
    cancelled.inTransaction((tx) =>
      endJobWithRefund(tx, {
        jobId: cancelled.jobId,
        to: "cancelled",
        reason: "oops",
        buyerId: "org_someone_else",
        now: at(0.1),
      }),
    ),
    JobTransitionError,
  );
  await cancelled.inTransaction((tx) =>
    endJobWithRefund(tx, { jobId: cancelled.jobId, to: "cancelled", reason: "oops", buyerId: "org_buyer", now: at(0.1) }),
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
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId, now: at(0.1) }));
  // The two clocks disagree by a moment, as a worker's and the sweeper's can.
  const [submittedOk] = await Promise.all([
    db.inTransaction((tx) => submitJob(tx, { jobId: db.jobId, output: {}, checkResults: [], now: at(0.9) })),
    db
      .inTransaction((tx) => endJobWithRefund(tx, { jobId: db.jobId, to: "expired", reason: "SLA passed", now: at(1) }))
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

// ============================================
// The SLA is part of every transition
// ============================================

test("a job cannot be started or submitted after its deadline, and its escrow stays held for the expiry", async () => {
  const late = await hired();
  assert.equal(await late.inTransaction((tx) => startJob(tx, { jobId: late.jobId, now: at(1) })), false);
  assert.equal(late.job(late.jobId).status, "funded");

  const running = await hired();
  await running.inTransaction((tx) => startJob(tx, { jobId: running.jobId, now: at(0.1) }));
  const ok = await running.inTransaction((tx) =>
    submitJob(tx, { jobId: running.jobId, output: { report: "late" }, checkResults: [], now: at(1.01) }),
  );
  assert.equal(ok, false);
  assert.equal(running.job(running.jobId).status, "running");
  assert.equal(running.job(running.jobId).output, undefined);
  assert.equal(running.escrow(running.jobId).status, "pending");

  // The late deliverable is discarded; the buyer is refunded once.
  await running.inTransaction((tx) =>
    endJobWithRefund(tx, { jobId: running.jobId, to: "expired", reason: "SLA passed", now: at(1.01) }),
  );
  assert.equal(running.state.balances.get("org_buyer"), 10_000n);
  assert.equal(running.escrow(running.jobId).status, "refunded");
});

test("a job cannot be expired before its deadline", async () => {
  const db = await hired();
  await assert.rejects(
    db.inTransaction((tx) => endJobWithRefund(tx, { jobId: db.jobId, to: "expired", reason: "SLA passed", now: at(0.99) })),
    /deadline has not passed/,
  );
  assert.equal(db.job(db.jobId).status, "funded");
  assert.equal(db.escrow(db.jobId).status, "pending");
  assert.equal(db.state.balances.get("org_buyer"), 8_000n);
});

test("only the buyer can cancel: a cancel that names no buyer is refused", async () => {
  const db = await hired();
  await assert.rejects(
    db.inTransaction((tx) => endJobWithRefund(tx, { jobId: db.jobId, to: "cancelled", reason: "oops", now: at(0.1) })),
    /Only the buyer can cancel/,
  );
  assert.equal(db.job(db.jobId).status, "funded");
  assert.equal(db.escrow(db.jobId).status, "pending");
});

// ============================================
// Terms
// ============================================

test("a price or delivery time outside the bounds is refused before any debit", async () => {
  const cases: Array<Partial<OfferingForHire>> = [
    { priceCents: 0n },
    { priceCents: -5n },
    { priceCents: 49n },
    { priceCents: 100_001n },
    { slaSeconds: 299 },
    { slaSeconds: 604_801 },
    { slaSeconds: 600.5 },
  ];
  for (const over of cases) {
    const db = makeDb();
    await assert.rejects(
      db.inTransaction((tx) =>
        hireJob(tx, { offering: { ...OFFERING, ...over }, buyerId: "org_buyer", input: {}, now: T0 }),
      ),
      JobTermsError,
      JSON.stringify(over, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
    assert.equal(db.state.balances.get("org_buyer"), 10_000n);
    assert.equal(db.state.jobs.size, 0);
    assert.equal(db.state.ledger.length, 0);
    assert.equal(db.slots(), 0);
  }
  // The bounds themselves are allowed.
  for (const edge of [{ priceCents: 50n, slaSeconds: 300 }, { priceCents: 100_000n, slaSeconds: 604_800 }]) {
    const db = makeDb({ balance: 100_000n });
    await db.inTransaction((tx) =>
      hireJob(tx, { offering: { ...OFFERING, ...edge }, buyerId: "org_buyer", input: {}, now: T0 }),
    );
    assert.equal(db.state.jobs.size, 1);
  }
});

test("the terms the buyer agreed to, and who hired, are stored on the job", async () => {
  const db = makeDb();
  const { jobId, terms } = await db.inTransaction((tx) =>
    hireJob(tx, {
      offering: OFFERING,
      buyerId: "org_buyer",
      input: {},
      now: T0,
      idempotencyKey: "retry-1",
      hiredByApiKeyId: "key_1",
    }),
  );
  const expected = {
    title: "Competitor teardown",
    priceCents: "2000",
    slaSeconds: 3_600,
    reviewWindowMs: JOB_REVIEW_WINDOW_MS,
    deliverableChecks: [{ type: "contains", value: "competitor" }],
    outputFormat: "text",
  };
  assert.deepEqual(terms, expected);
  assert.deepEqual(db.job(jobId).terms, expected);
  assert.equal(db.job(jobId).idempotencyKey, "retry-1");
  assert.equal(db.job(jobId).hiredByApiKeyId, "key_1");
  assert.equal(db.job(jobId).hiredByUserId, undefined);
});

// ============================================
// Capacity
// ============================================

test("an offering takes only as many jobs at once as it allows, and a refused hire charges nothing", async () => {
  const db = makeDb();
  const hire = () =>
    db.inTransaction((tx) => hireJob(tx, { offering: OFFERING, buyerId: "org_buyer", input: {}, now: T0 }));
  const first = await hire();
  await hire();
  assert.equal(db.slots(), 2);
  await assert.rejects(hire(), (err: unknown) => err instanceof JobUnavailableError && err.code === "offering_at_capacity");
  assert.equal(db.state.balances.get("org_buyer"), 6_000n);
  assert.equal(db.state.jobs.size, 2);

  // A job that leaves funded|running gives its slot back, exactly once.
  await db.inTransaction((tx) =>
    endJobWithRefund(tx, { jobId: first.jobId, to: "cancelled", reason: "oops", buyerId: "org_buyer", now: at(0.1) }),
  );
  assert.equal(db.slots(), 1);
  await hire();
  assert.equal(db.slots(), 2);
});

test("submitting frees the slot; a hire that cannot be paid for does not take one", async () => {
  const db = await submitted();
  assert.equal(db.slots(), 0);

  const poor = makeDb({ balance: 10n });
  await assert.rejects(
    poor.inTransaction((tx) => hireJob(tx, { offering: OFFERING, buyerId: "org_buyer", input: {}, now: T0 })),
    JobFundingError,
  );
  assert.equal(poor.slots(), 0);
});

test("an offering paused or archived since it was loaded cannot be hired", async () => {
  const db = makeDb();
  db.state.offerings.get("off_1")!.status = "paused";
  await assert.rejects(
    db.inTransaction((tx) => hireJob(tx, { offering: OFFERING, buyerId: "org_buyer", input: {}, now: T0 })),
    (err: unknown) => err instanceof JobUnavailableError && err.code === "offering_unavailable",
  );
  assert.equal(db.state.balances.get("org_buyer"), 10_000n);
});

// ============================================
// Leases
// ============================================

test("a started job is leased, and only a lapsed lease before the deadline can be reclaimed", async () => {
  const db = await hired();
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId, now: at(0.1), leaseMs: 10 * 60_000 }));
  assert.equal(db.job(db.jobId).attempts, 1);
  assert.equal((db.job(db.jobId).leaseExpiresAt as Date).getTime(), at(0.1).getTime() + 10 * 60_000);

  // Still leased.
  assert.equal(await db.inTransaction((tx) => reclaimJob(tx, { jobId: db.jobId, now: at(0.2) })), false);
  // Lapsed, with time left: one worker takes it over.
  const claims = await Promise.all([
    db.inTransaction((tx) => reclaimJob(tx, { jobId: db.jobId, now: at(0.5), leaseMs: 10 * 60_000 })),
    db.inTransaction((tx) => reclaimJob(tx, { jobId: db.jobId, now: at(0.5), leaseMs: 10 * 60_000 })),
  ]);
  assert.deepEqual(claims.sort(), [false, true]);
  assert.equal(db.job(db.jobId).attempts, 2);
  // Past the deadline it is the sweeper's to expire, not a worker's to run.
  assert.equal(await db.inTransaction((tx) => reclaimJob(tx, { jobId: db.jobId, now: at(1.5) })), false);
});

// ============================================
// Settlement needs somewhere to pay
// ============================================

test("settling for a publisher with no payout profile rolls back whole: the escrow stays held", async () => {
  const db = await submitted({ noProfile: true });
  await assert.rejects(
    db.inTransaction((tx) => completeJob(tx, { jobId: db.jobId, buyerId: "org_buyer", rating: 5, now: at(2) })),
    (err: unknown) => err instanceof JobSettlementError && err.publisherId === "org_pub",
  );
  assert.equal(db.job(db.jobId).status, "submitted");
  assert.equal(db.job(db.jobId).rating, null);
  assert.equal(db.escrow(db.jobId).status, "pending");
  assert.equal(db.state.accrued.size, 0);

  // Once the profile exists the same accept settles, once.
  db.state.profiles.add("org_pub");
  await db.inTransaction((tx) => completeJob(tx, { jobId: db.jobId, buyerId: "org_buyer", now: at(3) }));
  assert.equal(db.escrow(db.jobId).status, "settled");
  assert.equal(db.state.accrued.get("org_pub"), 1_800n);
});

// ============================================
// Rating
// ============================================

test("a completed job is rated once, by its buyer, within 30 days", async () => {
  const db = await submitted();
  // Not before it completes.
  await assert.rejects(
    db.inTransaction((tx) => rateJob(tx, { jobId: db.jobId, buyerId: "org_buyer", rating: 4, now: at(1) })),
    JobTransitionError,
  );
  await db.inTransaction((tx) => completeJob(tx, { jobId: db.jobId, auto: true, now: at(0.5 + 72) }));
  assert.equal(db.job(db.jobId).rating, null, "an auto-completed job has no rating");

  await assert.rejects(
    db.inTransaction((tx) => rateJob(tx, { jobId: db.jobId, buyerId: "org_other", rating: 1, now: at(80) })),
    JobTransitionError,
  );
  await db.inTransaction((tx) =>
    rateJob(tx, { jobId: db.jobId, buyerId: "org_buyer", rating: 7, review: "  Thorough.  ", now: at(80) }),
  );
  assert.equal(db.job(db.jobId).rating, 5);
  assert.equal(db.job(db.jobId).review, "Thorough.");
  assert.equal((db.job(db.jobId).ratedAt as Date).getTime(), at(80).getTime());

  await assert.rejects(
    db.inTransaction((tx) => rateJob(tx, { jobId: db.jobId, buyerId: "org_buyer", rating: 1, now: at(81) })),
    JobTransitionError,
  );
  assert.equal(db.job(db.jobId).rating, 5);
  // Rating moves no money.
  assert.equal(db.state.accrued.get("org_pub"), 1_800n);
  assert.equal(db.state.ledger.length, 1);
});

test("a job cannot be rated after the rating window, and an accept's rating counts as the one rating", async () => {
  const late = await submitted();
  await late.inTransaction((tx) => completeJob(tx, { jobId: late.jobId, auto: true, now: at(0.5 + 72) }));
  const after = new Date(at(0.5 + 72).getTime() + JOB_RATING_WINDOW_MS);
  await assert.rejects(
    late.inTransaction((tx) => rateJob(tx, { jobId: late.jobId, buyerId: "org_buyer", rating: 3, now: after })),
    JobTransitionError,
  );

  const accepted = await submitted();
  await accepted.inTransaction((tx) =>
    completeJob(tx, { jobId: accepted.jobId, buyerId: "org_buyer", rating: 4, review: "Good", now: at(2) }),
  );
  assert.equal(accepted.job(accepted.jobId).review, "Good");
  await assert.rejects(
    accepted.inTransaction((tx) => rateJob(tx, { jobId: accepted.jobId, buyerId: "org_buyer", rating: 1, now: at(3) })),
    JobTransitionError,
  );
  assert.equal(accepted.job(accepted.jobId).rating, 4);
});

// ============================================
// Model usage on the platform's keys
// ============================================

test("model usage recorded with the submit comes out of the creator's share at settlement, and the row still adds up", async () => {
  const db = await hired();
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId, now: at(0.1) }));
  await db.inTransaction((tx) =>
    submitJob(tx, {
      jobId: db.jobId,
      output: { text: "..." },
      checkResults: [],
      now: at(0.5),
      modelUsage: { inputTokens: 40_000, outputTokens: 10_000, costCents: 12n },
    }),
  );
  assert.equal(db.job(db.jobId).platformInputTokens, 40_000n);
  assert.equal(db.job(db.jobId).modelCostCents, 12n);

  const { creatorCents } = await db.inTransaction((tx) =>
    completeJob(tx, { jobId: db.jobId, buyerId: "org_buyer", now: at(1) }),
  );
  const row = db.escrow(db.jobId);
  assert.equal(creatorCents, 1_788n);
  assert.equal(row.creatorAmountCents, 1_788n);
  assert.equal(row.platformFeeCents, 212n);
  assert.equal(row.modelCostCents, 12n);
  assert.equal((row.platformFeeCents as bigint) + (row.creatorAmountCents as bigint), row.grossAmountCents);
  assert.equal(db.state.accrued.get("org_pub"), 1_788n);
});

test("model cost can never take more than the creator's share", async () => {
  const db = await hired();
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId, now: at(0.1) }));
  await db.inTransaction((tx) =>
    submitJob(tx, {
      jobId: db.jobId,
      output: {},
      checkResults: [],
      now: at(0.5),
      modelUsage: { inputTokens: 1, outputTokens: 1, costCents: 999_999n },
    }),
  );
  const { creatorCents } = await db.inTransaction((tx) =>
    completeJob(tx, { jobId: db.jobId, buyerId: "org_buyer", now: at(1) }),
  );
  assert.equal(creatorCents, 0n);
  assert.equal(db.escrow(db.jobId).platformFeeCents, 2_000n);
  assert.equal(db.state.accrued.get("org_pub"), 0n);
});

test("a failed job that used the platform's model still refunds the buyer in full", async () => {
  const db = await hired();
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId, now: at(0.1) }));
  const { refundedCents } = await db.inTransaction((tx) =>
    endJobWithRefund(tx, {
      jobId: db.jobId,
      to: "failed",
      reason: "checks failed",
      now: at(0.5),
      checkResults: [{ type: "contains", label: "x", passed: false, details: "" }],
      modelUsage: { inputTokens: 500, outputTokens: 500, costCents: 1n },
    }),
  );
  assert.equal(refundedCents, 2_000n);
  assert.equal(db.state.balances.get("org_buyer"), 10_000n);
  // Metered on the job even though there was no share to take it from.
  assert.equal(db.job(db.jobId).modelCostCents, 1n);
  assert.equal(db.escrow(db.jobId).status, "refunded");
  assert.equal(db.state.accrued.size, 0);
});

test("a worker that gives up its lease lets another take the job over at once", async () => {
  const db = await hired();
  await db.inTransaction((tx) => startJob(tx, { jobId: db.jobId, now: at(0.1) }));
  // Still leased: nobody else may take it.
  assert.equal(await db.inTransaction((tx) => reclaimJob(tx, { jobId: db.jobId, now: at(0.15) })), false);
  assert.equal(await db.inTransaction((tx) => releaseJobLease(tx, { jobId: db.jobId, now: at(0.2) })), true);
  assert.equal(await db.inTransaction((tx) => reclaimJob(tx, { jobId: db.jobId, now: at(0.2) })), true);
  assert.equal(db.job(db.jobId).attempts, 2);
  // Only a running job has a lease to give up.
  const other = await hired();
  assert.equal(await other.inTransaction((tx) => releaseJobLease(tx, { jobId: other.jobId, now: at(0.2) })), false);
});
