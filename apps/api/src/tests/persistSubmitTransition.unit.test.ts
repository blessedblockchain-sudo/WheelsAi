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
// conditional-update Prisma writer for runSubmitPaymentsTick.
//
// Race safety: the writer uses updateMany WHERE id = X AND status = 'PENDING'.
// If another worker already advanced the row (e.g., manual operator
// submit) the count returns 0 and we throw — preventing a double-submit
// where two on-chain txs both move funds.
//
// Submitted-marker: txSignature is the load-bearing column. Combined
// with the unique index on tx_signature, a duplicate submit attempt
// would also crash on the unique constraint as a defense-in-depth.

interface UpdateManyArgs {
  where: { id: string; status: "PENDING" };
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
// Submitted transition
// ============================================

test("persistSubmitTransition writes SUBMITTED + txSignature + submittedAt for an ok submit", async () => {
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
  assert.equal(call.where.status, "PENDING");
  assert.equal(call.data.status, "SUBMITTED");
  assert.equal(call.data.txSignature, "SIG_1");
  assert.equal((call.data.submittedAt as Date).toISOString(), now.toISOString());
});

test("persistSubmitTransition does NOT write paidAt or errorMessage on a successful submit", async () => {
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
  // errorMessage explicitly cleared (null) since we successfully submitted
  // — the column stays null on success.
  assert.ok(data.errorMessage === null || !("errorMessage" in data));
});

// ============================================
// Failed transition
// ============================================

test("persistSubmitTransition writes FAILED + errorMessage for a failed submit", async () => {
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
  assert.equal(call.data.status, "FAILED");
  assert.equal(call.data.errorMessage, "blockhash_unavailable");
});

test("persistSubmitTransition does NOT write a txSignature on a failed submit", async () => {
  // Failed = nothing landed, no sig to record. Writing one would
  // make the row indistinguishable from a SUBMITTED-but-stuck row.
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

// ============================================
// Race safety
// ============================================

test("persistSubmitTransition guards on status=PENDING in the where clause", async () => {
  // The conditional update is the race-safety primitive — without it,
  // two workers picking up the same row would both submit and we'd
  // pay twice. Pin the where clause.
  const { persistSubmitTransition } = await import(
    "../services/persistSubmitTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistSubmitTransition(
    "cp_1",
    { type: "submitted", txSignature: "SIG_1" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  assert.equal(stub.log[0].args.where.status, "PENDING");
});

test("persistSubmitTransition throws when no row matched (stolen by another worker)", async () => {
  // count===0 means the row has moved out of PENDING since we loaded
  // it — either another worker stole it or the operator manually
  // failed it. Throwing is correct: we cannot leave the in-memory
  // tx unrecorded.
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
    /not in PENDING/,
  );
});
