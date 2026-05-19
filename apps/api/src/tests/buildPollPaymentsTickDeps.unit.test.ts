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

// Drives apps/api/src/services/buildPollPaymentsTickDeps.ts —
// the full dep-wiring closure for the poll-confirmation BullMQ worker.
//
// Composes:
//   loadSubmittedPaymentsByPrisma       → loadSubmittedBatch
//   pollComputePaymentConfirmation + RPC → pollOne (translate state →
//                                          driver outcome)
//   persistPollTransition               → persistTransition
//
// The orchestrator returns { payment, changed }; the driver's outcome
// is { type: 'confirmed' | 'failed' | 'unchanged' } so the bridge
// translates: confirmed status → confirmed, errorMessage set + status
// FAILED → failed, otherwise → unchanged.

function makePrismaStub(opts: { matchedCount?: number } = {}) {
  const log: any[] = [];
  return {
    log,
    prisma: {
      computePayment: {
        async findMany(args: any) {
          log.push({ type: "findMany", args });
          return [];
        },
        async updateMany(args: any) {
          log.push({ type: "updateMany", args });
          return { count: opts.matchedCount ?? 1 };
        },
      },
    },
  };
}

function makeConnectionStub(
  responses: Array<{
    confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
    err?: unknown;
  } | null>,
) {
  const log: any[] = [];
  let i = 0;
  const connection = {
    async getSignatureStatuses(sigs: string[], cfg?: any) {
      log.push({ type: "getSignatureStatuses", sigs, cfg });
      const r = responses[i++] ?? null;
      return {
        value: [
          r
            ? {
                confirmationStatus: r.confirmationStatus ?? null,
                err: r.err ?? null,
              }
            : null,
        ],
      };
    },
  };
  return { log, connection };
}

// ============================================
// Build shape
// ============================================

test("buildPollPaymentsTickDeps returns the three driver-shape keys", async () => {
  setupEnv();
  const { buildPollPaymentsTickDeps } = await import(
    "../services/buildPollPaymentsTickDeps.js"
  );
  const stub = makePrismaStub();
  const { connection } = makeConnectionStub([]);
  const deps = buildPollPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    batchLimit: 50,
    now: () => new Date(),
  });
  for (const key of ["loadSubmittedBatch", "pollOne", "persistTransition"]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
});

// ============================================
// loadSubmittedBatch
// ============================================

test("buildPollPaymentsTickDeps loadSubmittedBatch hits Prisma findMany with status=SUBMITTED", async () => {
  const { buildPollPaymentsTickDeps } = await import(
    "../services/buildPollPaymentsTickDeps.js"
  );
  const stub = makePrismaStub();
  const { connection } = makeConnectionStub([]);
  const deps = buildPollPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    batchLimit: 50,
    now: () => new Date(),
  });
  await deps.loadSubmittedBatch({ now: new Date() });
  const findMany = stub.log.find((c) => c.type === "findMany");
  assert.equal(findMany.args.where.status, "SUBMITTED");
  assert.equal(findMany.args.take, 50);
});

// ============================================
// pollOne — outcome translation
// ============================================

test("buildPollPaymentsTickDeps pollOne returns type=confirmed when RPC reports confirmed", async () => {
  const { buildPollPaymentsTickDeps } = await import(
    "../services/buildPollPaymentsTickDeps.js"
  );
  const stub = makePrismaStub();
  const { connection } = makeConnectionStub([
    { confirmationStatus: "confirmed", err: null },
  ]);
  const deps = buildPollPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.pollOne({ id: "cp_1", txSignature: "SIG_1" });
  assert.equal(outcome.type, "confirmed");
});

test("buildPollPaymentsTickDeps pollOne returns type=confirmed when RPC reports finalized", async () => {
  const { buildPollPaymentsTickDeps } = await import(
    "../services/buildPollPaymentsTickDeps.js"
  );
  const stub = makePrismaStub();
  const { connection } = makeConnectionStub([
    { confirmationStatus: "finalized", err: null },
  ]);
  const deps = buildPollPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.pollOne({ id: "cp_1", txSignature: "SIG_1" });
  assert.equal(outcome.type, "confirmed");
});

test("buildPollPaymentsTickDeps pollOne returns type=failed when err is non-null", async () => {
  const { buildPollPaymentsTickDeps } = await import(
    "../services/buildPollPaymentsTickDeps.js"
  );
  const stub = makePrismaStub();
  const { connection } = makeConnectionStub([
    {
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, "Custom"] },
    },
  ]);
  const deps = buildPollPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.pollOne({ id: "cp_1", txSignature: "SIG_F" });
  assert.equal(outcome.type, "failed");
  if (outcome.type === "failed") {
    assert.match(outcome.errorMessage, /InstructionError/);
  }
});

test("buildPollPaymentsTickDeps pollOne returns type=unchanged when sig not found yet", async () => {
  // RPC returns null for sigs that haven't propagated. The orchestrator
  // leaves the payment SUBMITTED. The driver-level outcome is unchanged.
  const { buildPollPaymentsTickDeps } = await import(
    "../services/buildPollPaymentsTickDeps.js"
  );
  const stub = makePrismaStub();
  const { connection } = makeConnectionStub([null]);
  const deps = buildPollPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.pollOne({ id: "cp_1", txSignature: "SIG_X" });
  assert.equal(outcome.type, "unchanged");
});

test("buildPollPaymentsTickDeps pollOne returns type=unchanged when status is processed (not yet confirmed)", async () => {
  const { buildPollPaymentsTickDeps } = await import(
    "../services/buildPollPaymentsTickDeps.js"
  );
  const stub = makePrismaStub();
  const { connection } = makeConnectionStub([
    { confirmationStatus: "processed", err: null },
  ]);
  const deps = buildPollPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.pollOne({ id: "cp_1", txSignature: "SIG_P" });
  assert.equal(outcome.type, "unchanged");
});

// ============================================
// persistTransition
// ============================================

test("buildPollPaymentsTickDeps persistTransition wires to updateMany WHERE status=SUBMITTED", async () => {
  const { buildPollPaymentsTickDeps } = await import(
    "../services/buildPollPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  const { connection } = makeConnectionStub([]);
  const now = new Date("2026-04-26T11:00:00Z");
  const deps = buildPollPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    batchLimit: 50,
    now: () => now,
  });
  await deps.persistTransition("cp_1", { type: "confirmed" });
  const update = stub.log.find((c) => c.type === "updateMany");
  assert.equal(update.args.where.id, "cp_1");
  assert.equal(update.args.where.status, "SUBMITTED");
  assert.equal(update.args.data.status, "CONFIRMED");
  assert.equal((update.args.data.paidAt as Date).toISOString(), now.toISOString());
});

// ============================================
// End-to-end smoke
// ============================================

test("buildPollPaymentsTickDeps result drives runPollPaymentsTick on an empty batch", async () => {
  const { buildPollPaymentsTickDeps } = await import(
    "../services/buildPollPaymentsTickDeps.js"
  );
  const { runPollPaymentsTick } = await import(
    "../services/runPollPaymentsTick.js"
  );
  const stub = makePrismaStub();
  const { connection } = makeConnectionStub([]);
  const deps = buildPollPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    batchLimit: 50,
    now: () => new Date(),
  });
  const result = await runPollPaymentsTick({ now: new Date() }, deps);
  assert.deepEqual(result, { confirmed: 0, failed: 0, unchanged: 0 });
});
