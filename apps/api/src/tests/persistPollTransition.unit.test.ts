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

// Drives apps/api/src/services/persistPollTransition.ts — the
// conditional-update Prisma writer for runPollPaymentsTick.
//
// Race safety: WHERE id = X AND status = 'SUBMITTED'. If the reaper
// already marked the row FAILED first, our update finds 0 rows and
// we throw → BullMQ retries → next tick's loader skips the row.
//
// Confirmed: status CONFIRMED, paidAt = now (the dashboard reads
// paidAt to show "settled at <time>"). errorMessage cleared.
//
// Failed: status FAILED, errorMessage. paidAt stays null.

interface UpdateManyArgs {
  where: { id: string; status: "SUBMITTED" };
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
// Confirmed transition
// ============================================

test("persistPollTransition writes CONFIRMED + paidAt for a confirmed outcome", async () => {
  setupEnv();
  const { persistPollTransition } = await import(
    "../services/persistPollTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  const now = new Date("2026-04-26T11:00:00Z");
  await persistPollTransition(
    "cp_1",
    { type: "confirmed" },
    { prisma: stub.prisma as any, now },
  );
  const call = stub.log[0].args;
  assert.equal(call.where.status, "SUBMITTED");
  assert.equal(call.data.status, "CONFIRMED");
  assert.equal((call.data.paidAt as Date).toISOString(), now.toISOString());
});

test("persistPollTransition does NOT write txSignature on confirmed (already set on submit)", async () => {
  // The submit writer set txSignature on transition into SUBMITTED;
  // re-writing it on CONFIRMED is a no-op at best, a bug at worst.
  const { persistPollTransition } = await import(
    "../services/persistPollTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistPollTransition(
    "cp_1",
    { type: "confirmed" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  const data = stub.log[0].args.data;
  assert.equal("txSignature" in data, false);
});

// ============================================
// Failed transition
// ============================================

test("persistPollTransition writes FAILED + errorMessage for a failed outcome", async () => {
  const { persistPollTransition } = await import(
    "../services/persistPollTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistPollTransition(
    "cp_1",
    { type: "failed", errorMessage: "InstructionError [0, Custom]" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  const call = stub.log[0].args;
  assert.equal(call.data.status, "FAILED");
  assert.equal(call.data.errorMessage, "InstructionError [0, Custom]");
});

test("persistPollTransition does NOT write paidAt on failed", async () => {
  const { persistPollTransition } = await import(
    "../services/persistPollTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistPollTransition(
    "cp_1",
    { type: "failed", errorMessage: "x" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  const data = stub.log[0].args.data;
  assert.ok(data.paidAt === null || data.paidAt === undefined || !("paidAt" in data));
});

// ============================================
// Unchanged → no DB write
// ============================================

test("persistPollTransition is a no-op for type=unchanged", async () => {
  // The driver also skips persist on unchanged (the optimization).
  // The writer is defensive: if the driver ever calls it, do nothing.
  const { persistPollTransition } = await import(
    "../services/persistPollTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 0 });
  await persistPollTransition(
    "cp_1",
    { type: "unchanged" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  assert.equal(stub.log.length, 0);
});

// ============================================
// Race safety
// ============================================

test("persistPollTransition guards on status=SUBMITTED in the where clause", async () => {
  const { persistPollTransition } = await import(
    "../services/persistPollTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistPollTransition(
    "cp_1",
    { type: "confirmed" },
    { prisma: stub.prisma as any, now: new Date() },
  );
  assert.equal(stub.log[0].args.where.status, "SUBMITTED");
});

test("persistPollTransition throws when no row matched (reaper got it first)", async () => {
  // count===0 means the reaper already marked it FAILED. The poll's
  // CONFIRMED outcome would be a contradiction — we can't overwrite.
  // Throwing makes BullMQ retry; the next tick's loadSubmittedBatch
  // will skip the now-FAILED row.
  const { persistPollTransition } = await import(
    "../services/persistPollTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 0 });
  await assert.rejects(
    persistPollTransition(
      "cp_1",
      { type: "confirmed" },
      { prisma: stub.prisma as any, now: new Date() },
    ),
    /not in SUBMITTED/,
  );
});
