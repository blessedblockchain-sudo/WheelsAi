import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/persistSubmitTransition.ts — the
// conditional-update Prisma writer for runSubmitPaymentsTick under the
// claim-first protocol (remediation D3/D5).
//
//   submitted         → SUBMITTING → SUBMITTED   (guards on SUBMITTING;
//                       count 0 throws — a claimed row whose bytes are on
//                       the wire must never be silently lost)
//   failed            → PENDING → FAILED          (pre-claim prepare errors)
//   resolution_failed → stays PENDING, attempts++ (transient; retry next tick)
//   parked            → PENDING → PARKED, attempts++ (poison row)
//
// The PENDING-guarded family treats count 0 as a benign lost race (another
// worker claimed the row first; nothing of ours is on-chain pre-claim).

interface UpdateManyArgs {
  where: { id: string; status: string };
  data: any;
}

function makePrismaStub(opts: { matchedCount: number }) {
  const log: any[] = [];
  return {
    log,
    prisma: {
      computePayment: {
        async updateMany(args: UpdateManyArgs) {
          log.push({ type: "updateMany", args });
          return { count: opts.matchedCount };
        },
      },
    },
  };
}

// ============================================
// Submitted transition (SUBMITTING → SUBMITTED)
// ============================================

test("persistSubmitTransition writes SUBMITTED + submittedAt guarded on status=SUBMITTING", async () => {
  setupEnv();
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  const now = new Date("2026-04-26T10:00:00Z");
  await persistSubmitTransition(
    "cp_1",
    { type: "submitted", txSignature: "SIG_1" },
    { prisma: stub.prisma as any, now },
  );
  const call = stub.log[0].args;
  assert.equal(call.where.id, "cp_1");
  // Claim-first: the row was already claimed (PENDING→SUBMITTING with the
  // signature persisted); this write only completes SUBMITTING→SUBMITTED.
  assert.equal(call.where.status, "SUBMITTING");
  assert.equal(call.data.status, "SUBMITTED");
  assert.equal((call.data.submittedAt as Date).toISOString(), now.toISOString());
});

test("persistSubmitTransition does NOT write paidAt and clears errorMessage on a successful submit", async () => {
  // paidAt is set by the poll worker on CONFIRMED. errorMessage is null.
  // Writing them now would either lie about confirmation or carry
  // stale error text from a previous attempt.
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistSubmitTransition(
    "cp_1",
    { type: "submitted", txSignature: "SIG_1" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  const data = stub.log[0].args.data;
  assert.equal("paidAt" in data, false);
  assert.ok(data.errorMessage === null || !("errorMessage" in data));
});

test("persistSubmitTransition does NOT rewrite the txSignature on submitted (the claim already persisted it)", async () => {
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistSubmitTransition(
    "cp_1",
    { type: "submitted", txSignature: "SIG_1" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  assert.equal("txSignature" in stub.log[0].args.data, false);
});

test("persistSubmitTransition throws when the submitted CAS matches no row (claimed row went missing)", async () => {
  // count===0 on SUBMITTING→SUBMITTED is serious: we hold a row whose
  // signed bytes are potentially on the wire and someone moved it from
  // under us. Throwing makes BullMQ retry; the recovery scan settles the
  // row from on-chain evidence.
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 0 });
  await assert.rejects(
    persistSubmitTransition(
      "cp_1",
      { type: "submitted", txSignature: "SIG_1" },
      { prisma: stub.prisma as any, now: new Date() },
    ),
    /not in SUBMITTING/,
  );
});

// ============================================
// Failed transition (PENDING → FAILED, pre-claim)
// ============================================

test("persistSubmitTransition writes FAILED + errorMessage guarded on status=PENDING", async () => {
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistSubmitTransition(
    "cp_1",
    { type: "failed", errorMessage: "blockhash_unavailable" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  const call = stub.log[0].args;
  assert.equal(call.where.status, "PENDING");
  assert.equal(call.data.status, "FAILED");
  assert.equal(call.data.errorMessage, "blockhash_unavailable");
});

test("persistSubmitTransition does NOT write a txSignature on a failed submit", async () => {
  // Failed = prepare threw pre-claim; no signed tx exists, no sig to
  // record. Writing one would make the row indistinguishable from a
  // claimed/submitted row.
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistSubmitTransition(
    "cp_1",
    { type: "failed", errorMessage: "x" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  const data = stub.log[0].args.data;
  assert.ok(data.txSignature === null || data.txSignature === undefined);
});

test("persistSubmitTransition treats count=0 on failed as a benign lost race (no throw)", async () => {
  // Another replica claimed the row between our load and our failure
  // write. Pre-claim there is nothing of ours on-chain, so the right
  // move is to yield silently — throwing would abort the whole tick
  // and punish every other row in the batch.
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 0 });
  await persistSubmitTransition(
    "cp_1",
    { type: "failed", errorMessage: "x" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  assert.equal(stub.log.length, 1); // attempted, swallowed the miss
});

// ============================================
// resolution_failed (stays PENDING; D5)
// ============================================

test("persistSubmitTransition resolution_failed keeps the row PENDING and increments resolutionAttempts", async () => {
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistSubmitTransition(
    "cp_1",
    { type: "resolution_failed", errorMessage: "no host yet" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  const call = stub.log[0].args;
  assert.equal(call.where.status, "PENDING");
  // No status write — the row STAYS PENDING so the next tick retries.
  assert.equal("status" in call.data, false);
  assert.deepEqual(call.data.resolutionAttempts, { increment: 1 });
  assert.equal(call.data.errorMessage, "no host yet");
});

// ============================================
// parked (PENDING → PARKED; D5)
// ============================================

test("persistSubmitTransition parked moves PENDING → PARKED with attempts incremented and the error recorded", async () => {
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistSubmitTransition(
    "cp_1",
    { type: "parked", errorMessage: "Nosana job not found: job_x" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  const call = stub.log[0].args;
  assert.equal(call.where.status, "PENDING");
  assert.equal(call.data.status, "PARKED");
  assert.deepEqual(call.data.resolutionAttempts, { increment: 1 });
  assert.equal(call.data.errorMessage, "Nosana job not found: job_x");
});
