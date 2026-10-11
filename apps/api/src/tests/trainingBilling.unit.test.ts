import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTE_USAGE_LEDGER_TYPES,
  reserveTrainingCredits,
  settleTrainingJob,
  trainingBillableMs,
  trainingChargeCents,
  trainingCostSoFarCents,
  trainingHoldCents,
  trainingPriceMicroUsdPerSecond,
  type TrainingReservePrisma,
  type TrainingSettlePrisma,
} from "../services/trainingBilling.js";

// Retail prices of the deployment price table (services/nosanaMarkets.ts).
const PRICE_4070 = trainingPriceMicroUsdPerSecond(0.00015); // 150 uUSD/s
const PRICE_4090 = trainingPriceMicroUsdPerSecond(0.00025); // 250 uUSD/s = $0.90/h
const PRICE_A100 = trainingPriceMicroUsdPerSecond(0.0008); // 800 uUSD/s

const ORG = "org-1";
const JOB = "5b0b0e5e-2c1c-4a43-9d4e-3a1e0d7f1a11";
const T0 = new Date("2026-10-12T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

// ============================================
// Arithmetic
// ============================================

test("price: USD per second to whole micro-dollars", () => {
  assert.equal(PRICE_4090, 250n);
  assert.equal(trainingPriceMicroUsdPerSecond(0.0001), 100n);
  assert.equal(trainingPriceMicroUsdPerSecond(0), 0n);
  assert.throws(() => trainingPriceMicroUsdPerSecond(-0.1), RangeError);
  assert.throws(() => trainingPriceMicroUsdPerSecond(Number.NaN), RangeError);
});

test("hold: price x run limit, in whole cents, rounded up", () => {
  assert.equal(trainingHoldCents(PRICE_4090, 3600), 90n, "one hour on a 4090 is $0.90");
  assert.equal(trainingHoldCents(PRICE_A100, 6 * 3600), 1728n, "six hours on an A100 is $17.28");
  assert.equal(trainingHoldCents(PRICE_4090, 900), 23n, "22.5 cents rounds up");
  assert.equal(trainingHoldCents(PRICE_4070, 301), 5n, "4.515 cents rounds up");
  assert.equal(trainingHoldCents(PRICE_4090, 40), 1n, "exactly one cent");
  assert.equal(trainingHoldCents(PRICE_4090, 41), 2n);
  assert.equal(trainingHoldCents(PRICE_4090, 1), 1n, "any time at all holds a cent");
  assert.equal(trainingHoldCents(PRICE_4090, 0), 0n);
  assert.equal(trainingHoldCents(0n, 3600), 0n, "a free tier holds nothing");
});

test("hold: integer arithmetic, where floating point would add a cent", () => {
  // 0.0001 x 3600 x 100 is 36.00000000000001 in floating point.
  assert.equal(Math.ceil(0.0001 * 3600 * 100), 37);
  assert.equal(trainingHoldCents(trainingPriceMicroUsdPerSecond(0.0001), 3600), 36n);
});

test("hold: refuses a run limit that is not a whole number of seconds", () => {
  assert.throws(() => trainingHoldCents(PRICE_4090, 1.5), RangeError);
  assert.throws(() => trainingHoldCents(PRICE_4090, -1), RangeError);
  assert.throws(() => trainingHoldCents(PRICE_4090, Number.NaN), RangeError);
  assert.throws(() => trainingHoldCents(-1n, 60), RangeError);
});

test("billable time: from the start of the Nosana job to its end", () => {
  assert.equal(trainingBillableMs({ startedAt: at(0), endedAt: at(600) }), 600_000);
  assert.equal(trainingBillableMs({ startedAt: at(0), endedAt: new Date(T0.getTime() + 1500) }), 1500);
  assert.equal(trainingBillableMs({ startedAt: null, endedAt: at(600) }), 0, "never started: queue time is free");
  assert.equal(trainingBillableMs({ startedAt: at(10), endedAt: at(5) }), 0, "never negative");
  assert.equal(trainingBillableMs({ startedAt: new Date(Number.NaN), endedAt: at(5) }), 0);
});

test("billable time: a cancelled run is billed to the request, not to the stop", () => {
  // Cancel requested at 300 s; the stop took until 420 s to land.
  assert.equal(
    trainingBillableMs({ startedAt: at(0), endedAt: at(420), cancelRequestedAt: at(300) }),
    300_000,
  );
  // The job had already ended when the cancel arrived.
  assert.equal(
    trainingBillableMs({ startedAt: at(0), endedAt: at(200), cancelRequestedAt: at(300) }),
    200_000,
  );
  // Cancelled while queued, before a node started it.
  assert.equal(
    trainingBillableMs({ startedAt: at(100), endedAt: at(400), cancelRequestedAt: at(50) }),
    0,
  );
  assert.equal(trainingBillableMs({ startedAt: null, endedAt: at(400), cancelRequestedAt: at(50) }), 0);
});

test("charge: price x seconds, rounded up to a cent", () => {
  const hold = trainingHoldCents(PRICE_4090, 3600);
  const charge = (billableMs: number) =>
    trainingChargeCents({ priceMicroUsdPerSecond: PRICE_4090, billableMs, holdCents: hold });
  assert.equal(charge(600_000), 15n, "ten minutes on a 4090 is 15 cents");
  assert.equal(charge(40_000), 1n);
  assert.equal(charge(40_001), 2n, "a millisecond into the next cent");
  assert.equal(charge(1), 1n, "any billable time costs a cent");
  assert.equal(charge(0), 0n);
  assert.equal(charge(-5), 0n);
});

test("charge: never more than the hold", () => {
  const hold = trainingHoldCents(PRICE_4090, 900); // 23
  const charge = (billableMs: number) =>
    trainingChargeCents({ priceMicroUsdPerSecond: PRICE_4090, billableMs, holdCents: hold });
  assert.equal(charge(900_000), 23n, "the whole run limit is the whole hold");
  assert.equal(charge(899_000), 23n, "22.475 rounds up to the hold, not past it");
  assert.equal(charge(880_000), 22n);
  // The set-up allowance: Nosana ran 900 s + 900 s; the user pays for 900 s.
  assert.equal(charge(1_800_000), 23n);
  assert.equal(charge(7 * 86_400_000), 23n);
  assert.equal(
    trainingChargeCents({ priceMicroUsdPerSecond: PRICE_4090, billableMs: 600_000, holdCents: 0n }),
    0n,
    "nothing held, nothing charged",
  );
});

test("cost so far: the charge up to now, capped, and 0 before the job starts", () => {
  const hold = trainingHoldCents(PRICE_4090, 3600);
  const soFar = (startedAt: Date | null, now: Date) =>
    trainingCostSoFarCents({ priceMicroUsdPerSecond: PRICE_4090, holdCents: hold, startedAt, now });
  assert.equal(soFar(null, at(500)), 0n, "queued");
  assert.equal(soFar(at(0), at(600)), 15n);
  assert.equal(soFar(at(0), at(7200)), 90n, "capped by the hold");
  assert.equal(
    trainingCostSoFarCents({ priceMicroUsdPerSecond: null, holdCents: null, startedAt: at(0), now: at(600) }),
    0n,
    "a row from before billing has no price",
  );
});

test("training usage is compute spend, beside deployment GPU usage", () => {
  assert.deepEqual([...COMPUTE_USAGE_LEDGER_TYPES], ["gpu_usage", "training_usage"]);
});

// ============================================
// A fake transaction that behaves like the ledger
// ============================================

interface LedgerRow {
  orgId: string;
  amountCents: bigint;
  type: string;
  description: string;
  referenceId: string;
  balanceAfter: bigint;
  gpuSeconds?: bigint;
}

interface JobRow {
  id: string;
  orgId: string;
  status: string;
  settledAt: Date | null;
  completedAt: Date | null;
  reservationCents: bigint | null;
  priceMicroUsdPerSecond: bigint | null;
  maxRuntimeSeconds: number | null;
  gpuTier: string;
  billedSeconds: number | null;
  actualCostCents: bigint | null;
  [extra: string]: unknown;
}

function makeDb(opts: { balance: bigint | null; job?: Partial<JobRow> }) {
  const state = {
    balance: opts.balance,
    ledger: [] as LedgerRow[],
    job: {
      id: JOB,
      orgId: ORG,
      status: "running",
      settledAt: null,
      completedAt: null,
      reservationCents: null,
      priceMicroUsdPerSecond: null,
      maxRuntimeSeconds: null,
      gpuTier: "4090",
      billedSeconds: null,
      actualCostCents: null,
      ...opts.job,
    } as JobRow,
    failOn: null as string | null,
  };
  const maybeFail = (op: string) => {
    if (state.failOn === op) throw new Error(`injected failure: ${op}`);
  };

  const tx: TrainingReservePrisma & TrainingSettlePrisma = {
    creditBalance: {
      // WHERE org_id = ? AND balance_cents >= ?
      async updateMany({ where, data }) {
        if (where.orgId !== ORG || state.balance === null) return { count: 0 };
        if (state.balance < where.balanceCents.gte) return { count: 0 };
        state.balance -= data.balanceCents.decrement;
        return { count: 1 };
      },
      async findUnique({ where }) {
        if (where.orgId !== ORG || state.balance === null) return null;
        return { balanceCents: state.balance };
      },
      async update({ where, data }) {
        maybeFail("creditBalance.update");
        if (where.orgId !== ORG || state.balance === null) throw new Error("P2025: no balance row");
        state.balance += data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
    },
    creditTransaction: {
      async create({ data }) {
        maybeFail("creditTransaction.create");
        state.ledger.push({ ...data });
        return {};
      },
    },
    trainingJob: {
      async updateMany({ where, data }) {
        const job = state.job;
        if (
          job.id !== where.id ||
          job.orgId !== where.orgId ||
          !where.status.in.includes(job.status) ||
          job.settledAt !== null
        ) {
          return { count: 0 };
        }
        Object.assign(job, data);
        return { count: 1 };
      },
      async findUnique({ where }) {
        if (state.job.id !== where.id) return null;
        const { reservationCents, priceMicroUsdPerSecond, maxRuntimeSeconds, gpuTier } = state.job;
        return { reservationCents, priceMicroUsdPerSecond, maxRuntimeSeconds, gpuTier };
      },
      async update({ where, data }) {
        if (state.job.id !== where.id) throw new Error("P2025: no job row");
        Object.assign(state.job, data);
        return {};
      },
    },
  };

  /** Runs fn like prisma.$transaction: everything it did is undone if it throws. */
  async function transaction<T>(fn: (client: typeof tx) => Promise<T>): Promise<T> {
    const snapshot = { balance: state.balance, ledger: [...state.ledger], job: { ...state.job } };
    try {
      return await fn(tx);
    } catch (error) {
      state.balance = snapshot.balance;
      state.ledger = snapshot.ledger;
      state.job = snapshot.job;
      throw error;
    }
  }

  return { state, tx, transaction };
}

/** The ledger's own invariant: each row's balanceAfter follows from the one before. */
function assertLedgerChain(ledger: LedgerRow[], openingBalance: bigint, closingBalance: bigint | null) {
  let running = openingBalance;
  for (const row of ledger) {
    running += row.amountCents;
    assert.equal(row.balanceAfter, running, `${row.type}: balanceAfter follows the row before`);
  }
  assert.equal(running, closingBalance, "the ledger adds up to the balance");
}

// ============================================
// Reserve
// ============================================

test("reserve: takes the hold and writes one training_reservation row", async () => {
  const db = makeDb({ balance: 1000n });
  const holdCents = trainingHoldCents(PRICE_4090, 3600);
  const result = await reserveTrainingCredits({
    tx: db.tx,
    orgId: ORG,
    jobId: JOB,
    holdCents,
    gpuTier: "4090",
    maxRuntimeSeconds: 3600,
  });
  assert.deepEqual(result, { ok: true, reservedCents: 90n });
  assert.equal(db.state.balance, 910n);
  assert.deepEqual(db.state.ledger, [
    {
      orgId: ORG,
      amountCents: -90n,
      type: "training_reservation",
      description: "Fine-tuning hold (4090, run limit 3600s)",
      referenceId: JOB,
      balanceAfter: 910n,
    },
  ]);
});

test("reserve: a balance that does not cover the hold moves nothing", async () => {
  const db = makeDb({ balance: 89n });
  const result = await reserveTrainingCredits({
    tx: db.tx,
    orgId: ORG,
    jobId: JOB,
    holdCents: 90n,
    gpuTier: "4090",
    maxRuntimeSeconds: 3600,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "insufficient_credits");
    assert.equal(result.requiredCents, 90n);
  }
  assert.equal(db.state.balance, 89n);
  assert.deepEqual(db.state.ledger, []);
});

test("reserve: the exact balance passes; an organization with no balance row does not", async () => {
  const exact = makeDb({ balance: 90n });
  const ok = await reserveTrainingCredits({
    tx: exact.tx, orgId: ORG, jobId: JOB, holdCents: 90n, gpuTier: "4090", maxRuntimeSeconds: 3600,
  });
  assert.equal(ok.ok, true);
  assert.equal(exact.state.balance, 0n);
  assert.equal(exact.state.ledger[0]?.balanceAfter, 0n);

  const none = makeDb({ balance: null });
  const refused = await reserveTrainingCredits({
    tx: none.tx, orgId: ORG, jobId: JOB, holdCents: 90n, gpuTier: "4090", maxRuntimeSeconds: 3600,
  });
  assert.equal(refused.ok, false);
  assert.deepEqual(none.state.ledger, []);
});

test("reserve: two jobs against a balance that covers one cannot both pass", async () => {
  const db = makeDb({ balance: 100n });
  const args = { tx: db.tx, orgId: ORG, holdCents: 90n, gpuTier: "4090", maxRuntimeSeconds: 3600 };
  const results = await Promise.all([
    reserveTrainingCredits({ ...args, jobId: "job-a" }),
    reserveTrainingCredits({ ...args, jobId: "job-b" }),
  ]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal(db.state.balance, 10n);
  assert.equal(db.state.ledger.length, 1);
});

test("reserve: a free tier holds nothing and writes no row", async () => {
  const db = makeDb({ balance: 5n });
  const result = await reserveTrainingCredits({
    tx: db.tx, orgId: ORG, jobId: JOB, holdCents: 0n, gpuTier: "free", maxRuntimeSeconds: 3600,
  });
  assert.deepEqual(result, { ok: true, reservedCents: 0n });
  assert.equal(db.state.balance, 5n);
  assert.deepEqual(db.state.ledger, []);
});

// ============================================
// Settle
// ============================================

/** A job admitted on a 4090 with a one-hour run limit, its hold already taken from 1000. */
async function admitted(job: Partial<JobRow> = {}) {
  const db = makeDb({
    balance: 1000n,
    job: { reservationCents: 90n, priceMicroUsdPerSecond: PRICE_4090, maxRuntimeSeconds: 3600, ...job },
  });
  await reserveTrainingCredits({
    tx: db.tx, orgId: ORG, jobId: JOB, holdCents: 90n, gpuTier: "4090", maxRuntimeSeconds: 3600,
  });
  return db;
}

test("settle: a completed run returns the whole hold and charges the seconds run", async () => {
  const db = await admitted({ status: "finalizing" });
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["finalizing"],
    toStatus: "completed",
    charge: { kind: "seconds_run", billableMs: 600_000 },
    fields: { outputModelId: "ft-model-1", progress: 100 },
    now: at(700),
  });
  assert.deepEqual(result, {
    settled: true,
    holdCents: 90n,
    chargeCents: 15n,
    refundCents: 75n,
    billedSeconds: 600,
  });
  assert.equal(db.state.balance, 985n, "1000 - 15");
  assert.deepEqual(
    db.state.ledger.map((row) => [row.type, row.amountCents, row.referenceId, row.balanceAfter]),
    [
      ["training_reservation", -90n, JOB, 910n],
      ["training_reservation_release", 90n, JOB, 1000n],
      ["training_usage", -15n, JOB, 985n],
    ],
  );
  assertLedgerChain(db.state.ledger, 1000n, db.state.balance);

  const job = db.state.job;
  assert.equal(job.status, "completed");
  assert.deepEqual(job.settledAt, at(700));
  assert.deepEqual(job.completedAt, at(700));
  assert.equal(job.billedSeconds, 600);
  assert.equal(job.actualCostCents, 15n);
  assert.equal(job.outputModelId, "ft-model-1");
  assert.equal(job.progress, 100);
});

test("settle: charged nothing returns the whole hold and writes no usage row", async () => {
  const db = await admitted({ status: "queued" });
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["queued"],
    toStatus: "failed",
    charge: { kind: "none" },
    fields: { failureCode: "no_capacity", lastError: "No GPU node took the job within the queue time" },
    now: at(1800),
  });
  assert.deepEqual(result, { settled: true, holdCents: 90n, chargeCents: 0n, refundCents: 90n, billedSeconds: 0 });
  assert.equal(db.state.balance, 1000n);
  assert.deepEqual(
    db.state.ledger.map((row) => [row.type, row.amountCents, row.balanceAfter]),
    [
      ["training_reservation", -90n, 910n],
      ["training_reservation_release", 90n, 1000n],
    ],
  );
  assertLedgerChain(db.state.ledger, 1000n, 1000n);
  assert.equal(db.state.job.status, "failed");
  assert.equal(db.state.job.failureCode, "no_capacity");
  assert.equal(db.state.job.actualCostCents, 0n);
  assert.equal(db.state.job.billedSeconds, 0);
});

test("settle: a run that used its whole limit is charged the hold and the balance does not move", async () => {
  const db = await admitted({ status: "finalizing" });
  // Nosana ran the job for the run limit plus the 900 s set-up allowance.
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["finalizing"],
    toStatus: "completed",
    charge: { kind: "seconds_run", billableMs: 4_500_000 },
    now: at(4600),
  });
  assert.deepEqual(result, { settled: true, holdCents: 90n, chargeCents: 90n, refundCents: 0n, billedSeconds: 3600 });
  assert.equal(db.state.balance, 910n, "exactly the hold, never more");
  assert.deepEqual(
    db.state.ledger.map((row) => [row.type, row.amountCents, row.balanceAfter]),
    [
      ["training_reservation", -90n, 910n],
      ["training_reservation_release", 90n, 1000n],
      ["training_usage", -90n, 910n],
    ],
  );
  assertLedgerChain(db.state.ledger, 1000n, 910n);
  assert.equal(db.state.job.billedSeconds, 3600, "the allowance is not billed");
});

test("settle: a cancelled run is charged to the cancel request", async () => {
  const db = await admitted({ status: "cancelling" });
  const billableMs = trainingBillableMs({ startedAt: at(0), endedAt: at(420), cancelRequestedAt: at(300) });
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["cancelling"],
    toStatus: "cancelled",
    charge: { kind: "seconds_run", billableMs },
    fields: { gpuStoppedAt: at(420) },
    now: at(425),
  });
  assert.ok(result.settled);
  assert.equal(result.chargeCents, 8n, "300 s x 250 uUSD = 7.5 cents, rounded up");
  assert.equal(result.billedSeconds, 300);
  assert.equal(db.state.balance, 992n);
  assertLedgerChain(db.state.ledger, 1000n, 992n);
  assert.equal(db.state.job.status, "cancelled");
});

test("settle: a job cancelled before it ran gets everything back", async () => {
  const db = await admitted({ status: "pending" });
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["pending", "cancelling"],
    toStatus: "cancelled",
    charge: { kind: "seconds_run", billableMs: trainingBillableMs({ startedAt: null, endedAt: at(30) }) },
    now: at(30),
  });
  assert.ok(result.settled);
  assert.equal(result.chargeCents, 0n);
  assert.equal(db.state.balance, 1000n);
  assert.deepEqual(db.state.ledger.map((row) => row.type), ["training_reservation", "training_reservation_release"]);
});

test("settle: exactly once - the second writer changes nothing", async () => {
  const db = await admitted({ status: "running" });
  const args = {
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["running" as const],
    toStatus: "failed" as const,
    charge: { kind: "seconds_run" as const, billableMs: 600_000 },
    fields: { failureCode: "loss_not_finite" },
    now: at(700),
  };
  // A callback's reconcile and the poller's see the same end at the same time.
  const results = await Promise.all([settleTrainingJob(args), settleTrainingJob(args)]);
  assert.deepEqual(results.map((r) => r.settled).sort(), [false, true]);
  assert.deepEqual(results.find((r) => !r.settled), { settled: false, reason: "lost" });
  assert.equal(db.state.balance, 985n);
  assert.equal(db.state.ledger.length, 3);

  // And again later, with a different verdict: still nothing.
  const late = await settleTrainingJob({ ...args, charge: { kind: "none" }, now: at(900) });
  assert.deepEqual(late, { settled: false, reason: "lost" });
  assert.equal(db.state.balance, 985n);
  assert.equal(db.state.ledger.length, 3);
  assert.deepEqual(db.state.job.settledAt, at(700));
  assertLedgerChain(db.state.ledger, 1000n, 985n);
});

test("settle: loses when the row is not in a status the caller read", async () => {
  // The user cancelled while the reconcile was deciding the run had failed.
  const db = await admitted({ status: "cancelling" });
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["running"],
    toStatus: "failed",
    charge: { kind: "none" },
    now: at(100),
  });
  assert.deepEqual(result, { settled: false, reason: "lost" });
  assert.equal(db.state.job.status, "cancelling");
  assert.equal(db.state.balance, 910n, "the hold is still held");
  assert.equal(db.state.ledger.length, 1);
});

test("settle: loses for another organization's job", async () => {
  const db = await admitted({ status: "running" });
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: "org-2",
    fromStatuses: ["running"],
    toStatus: "failed",
    charge: { kind: "none" },
    now: at(100),
  });
  assert.deepEqual(result, { settled: false, reason: "lost" });
  assert.equal(db.state.balance, 910n);
});

test("settle: refuses a transition the state machine does not have, before touching the row", async () => {
  const db = await admitted({ status: "running" });
  const untouched = { ...db.state.job };
  for (const [fromStatuses, toStatus] of [
    [["running"], "completed"], // completion goes through finalizing
    [["running", "pending"], "failed"], // one bad source spoils the list
    [["completed"], "failed"], // nothing leaves a terminal state
    [[], "failed"],
    [["running"], "cancelling"], // not terminal: not a settlement
  ] as const) {
    const result = await settleTrainingJob({
      tx: db.tx,
      jobId: JOB,
      orgId: ORG,
      fromStatuses: [...fromStatuses],
      toStatus: toStatus as "failed",
      charge: { kind: "none" },
      now: at(100),
    });
    assert.deepEqual(result, { settled: false, reason: "invalid_transition" }, `${fromStatuses} -> ${toStatus}`);
  }
  assert.deepEqual(db.state.job, untouched);
  assert.equal(db.state.ledger.length, 1);
});

test("settle: a row from before billing (no hold) ends with no money and no ledger rows", async () => {
  const db = makeDb({ balance: 500n, job: { status: "running" } });
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["running"],
    toStatus: "failed",
    charge: { kind: "seconds_run", billableMs: 600_000 },
    fields: { failureCode: "no_exit_code" },
    now: at(100),
  });
  assert.deepEqual(result, { settled: true, holdCents: 0n, chargeCents: 0n, refundCents: 0n, billedSeconds: 0 });
  assert.equal(db.state.balance, 500n);
  assert.deepEqual(db.state.ledger, []);
  assert.equal(db.state.job.status, "failed");
  assert.equal(db.state.job.actualCostCents, 0n);
});

test("settle: the charge uses the price stored on the job, not today's table", async () => {
  // Admitted at 250 uUSD/s; the table has since moved. The row decides.
  const db = await admitted({ status: "finalizing", priceMicroUsdPerSecond: 250n });
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["finalizing"],
    toStatus: "completed",
    charge: { kind: "seconds_run", billableMs: 1_000_000 },
    now: at(1100),
  });
  assert.ok(result.settled);
  assert.equal(result.chargeCents, 25n);
});

test("settle: a failure part-way rolls the whole terminal transition back", async () => {
  for (const failOn of ["creditBalance.update", "creditTransaction.create"]) {
    const db = await admitted({ status: "finalizing" });
    db.state.failOn = failOn;
    await assert.rejects(
      db.transaction((tx) =>
        settleTrainingJob({
          tx,
          jobId: JOB,
          orgId: ORG,
          fromStatuses: ["finalizing"],
          toStatus: "completed",
          charge: { kind: "seconds_run", billableMs: 600_000 },
          now: at(700),
        }),
      ),
      /injected failure/,
    );
    assert.equal(db.state.job.status, "finalizing", `${failOn}: the job is where it was`);
    assert.equal(db.state.job.settledAt, null);
    assert.equal(db.state.balance, 910n);
    assert.equal(db.state.ledger.length, 1);

    // The next reconcile settles it, once.
    db.state.failOn = null;
    const retry = await db.transaction((tx) =>
      settleTrainingJob({
        tx,
        jobId: JOB,
        orgId: ORG,
        fromStatuses: ["finalizing"],
        toStatus: "completed",
        charge: { kind: "seconds_run", billableMs: 600_000 },
        now: at(720),
      }),
    );
    assert.ok(retry.settled);
    assert.equal(db.state.balance, 985n);
    assertLedgerChain(db.state.ledger, 1000n, 985n);
  }
});

test("settle: a hold with no balance row to return it to throws, and nothing is half-done", async () => {
  const db = makeDb({
    balance: null,
    job: { status: "running", reservationCents: 90n, priceMicroUsdPerSecond: PRICE_4090, maxRuntimeSeconds: 3600 },
  });
  for (const billableMs of [600_000, 3_600_000]) {
    await assert.rejects(
      db.transaction((tx) =>
        settleTrainingJob({
          tx,
          jobId: JOB,
          orgId: ORG,
          fromStatuses: ["running"],
          toStatus: "failed",
          charge: { kind: "seconds_run", billableMs },
          now: at(100),
        }),
      ),
    );
    assert.equal(db.state.job.status, "running");
    assert.deepEqual(db.state.ledger, []);
  }
});

test("settle: over every outcome the organization pays the charge and nothing else", async () => {
  const cases: Array<{ ms: number; kind: "none" | "seconds_run"; expected: bigint }> = [
    { ms: 0, kind: "seconds_run", expected: 0n },
    { ms: 1, kind: "seconds_run", expected: 1n },
    { ms: 39_999, kind: "seconds_run", expected: 1n },
    { ms: 40_000, kind: "seconds_run", expected: 1n },
    { ms: 40_001, kind: "seconds_run", expected: 2n },
    { ms: 3_599_999, kind: "seconds_run", expected: 90n },
    { ms: 3_600_000, kind: "seconds_run", expected: 90n },
    { ms: 99_999_999, kind: "seconds_run", expected: 90n },
    { ms: 3_600_000, kind: "none", expected: 0n },
  ];
  for (const { ms, kind, expected } of cases) {
    const db = await admitted({ status: "running" });
    const result = await settleTrainingJob({
      tx: db.tx,
      jobId: JOB,
      orgId: ORG,
      fromStatuses: ["running"],
      toStatus: "failed",
      charge: kind === "none" ? { kind } : { kind, billableMs: ms },
      now: at(1),
    });
    assert.ok(result.settled);
    assert.equal(result.chargeCents, expected, `${kind} ${ms} ms`);
    assert.equal(result.holdCents - result.chargeCents, result.refundCents);
    assert.equal(db.state.balance, 1000n - expected);
    assertLedgerChain(db.state.ledger, 1000n, 1000n - expected);
    const usage = db.state.ledger.filter((row) => row.type === "training_usage");
    assert.equal(usage.length, expected > 0n ? 1 : 0, "a usage row only for a charge above zero");
    assert.equal(db.state.ledger.filter((row) => row.type === "training_reservation_release").length, 1);
    assert.equal(db.state.ledger.every((row) => row.referenceId === JOB), true);
  }
});

test("settle: the training_usage row carries gpuSeconds, the seconds billed; the hold rows carry none", async () => {
  const db = await admitted({ status: "finalizing" });
  const result = await settleTrainingJob({
    tx: db.tx,
    jobId: JOB,
    orgId: ORG,
    fromStatuses: ["finalizing"],
    toStatus: "completed",
    charge: { kind: "seconds_run", billableMs: 600_000 },
    now: at(700),
  });
  assert.ok(result.settled);
  assert.equal(result.billedSeconds, 600);
  assert.deepEqual(
    db.state.ledger.map((row) => [row.type, row.gpuSeconds]),
    [
      ["training_reservation", undefined],
      ["training_reservation_release", undefined],
      ["training_usage", 600n],
    ],
  );
});
