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

// Drives apps/api/src/services/persistReapTransition.ts — the
// conditional-update Prisma writer for runReapStuckTick.
//
// Same SQL shape as persistPollTransition's failed branch (SUBMITTED →
// FAILED with errorMessage), but a dedicated writer keeps the reaper's
// call site readable and gives us a place to pin reap-specific
// invariants (blockhash_expired is the canonical reason).

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
// Reap transition
// ============================================

test("persistReapTransition writes FAILED + blockhash_expired against SUBMITTED", async () => {
  setupEnv();
  const { persistReapTransition } = await import(
    "../services/persistReapTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistReapTransition(
    "cp_1",
    { errorMessage: "blockhash_expired" },
    { prisma: stub.prisma as any },
  );
  const call = stub.log[0].args;
  assert.equal(call.where.id, "cp_1");
  assert.equal(call.where.status, "SUBMITTED");
  assert.equal(call.data.status, "FAILED");
  assert.equal(call.data.errorMessage, "blockhash_expired");
});

test("persistReapTransition does NOT touch paidAt or txSignature", async () => {
  // The reaper is failing a row that has no paidAt (never confirmed)
  // and a txSignature that DID land on-chain but won't ever confirm.
  // Both stay as-is so the operator can debug "submitted, never landed".
  const { persistReapTransition } = await import(
    "../services/persistReapTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistReapTransition(
    "cp_1",
    { errorMessage: "blockhash_expired" },
    { prisma: stub.prisma as any },
  );
  const data = stub.log[0].args.data;
  assert.equal("paidAt" in data, false);
  assert.equal("txSignature" in data, false);
});

// ============================================
// Race safety
// ============================================

test("persistReapTransition guards on status=SUBMITTED in the where clause", async () => {
  const { persistReapTransition } = await import(
    "../services/persistReapTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistReapTransition(
    "cp_1",
    { errorMessage: "blockhash_expired" },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.log[0].args.where.status, "SUBMITTED");
});

test("persistReapTransition throws when no row matched (poll worker confirmed first)", async () => {
  // count===0 means the poll worker just transitioned this row to
  // CONFIRMED — the tx DID land at the last second. Throwing instead
  // of overwriting protects the user from a phantom failure on a
  // payment that actually succeeded.
  const { persistReapTransition } = await import(
    "../services/persistReapTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 0 });
  await assert.rejects(
    persistReapTransition(
      "cp_1",
      { errorMessage: "blockhash_expired" },
      { prisma: stub.prisma as any },
    ),
    /not in SUBMITTED/,
  );
});

// ============================================
// Custom error messages forwarded
// ============================================

test("persistReapTransition forwards a custom errorMessage verbatim", async () => {
  // Future reap reasons (e.g. "rpc_disagreement") would slot in here.
  const { persistReapTransition } = await import(
    "../services/persistReapTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistReapTransition(
    "cp_1",
    { errorMessage: "custom_reason" },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.log[0].args.data.errorMessage, "custom_reason");
});
