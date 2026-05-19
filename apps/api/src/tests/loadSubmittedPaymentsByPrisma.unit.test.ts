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

// Drives apps/api/src/services/loadSubmittedPaymentsByPrisma.ts —
// loader for the poll-confirmation BullMQ worker.
//
// Returns ComputePayment rows with status=SUBMITTED + non-null
// txSignature (the poll cannot proceed without a sig). Ordered by
// submittedAt asc — older sigs polled first since they're closer to
// blockhash expiry.
//
// `limit` controls per-tick batch size. Production likely runs at a
// higher cadence + smaller batch than the submit driver (poll is
// cheap, just an RPC query, and faster confirmation reduces UX
// latency on the dashboard).

type Status = "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";

interface FakePayment {
  id: string;
  status: Status;
  txSignature: string | null;
  submittedAt: Date | null;
}

function makePrismaStub(payments: FakePayment[]) {
  const observed: { findManyArgs?: any } = {};
  return {
    observed,
    prisma: {
      computePayment: {
        async findMany({ where, orderBy, take }: any) {
          observed.findManyArgs = { where, orderBy, take };
          let matched = payments.filter((p) => {
            if (where.status && p.status !== where.status) return false;
            if (where.txSignature?.not === null && p.txSignature === null)
              return false;
            return true;
          });
          if (orderBy?.submittedAt === "asc") {
            matched = [...matched].sort((a, b) => {
              const at = a.submittedAt?.getTime() ?? 0;
              const bt = b.submittedAt?.getTime() ?? 0;
              return at - bt;
            });
          }
          if (take) matched = matched.slice(0, take);
          return matched;
        },
      },
    },
  };
}

const samplePayment = (overrides: Partial<FakePayment> = {}): FakePayment => ({
  id: "cp_1",
  status: "SUBMITTED",
  txSignature: "sig_1",
  submittedAt: new Date("2026-04-26T10:00:00Z"),
  ...overrides,
});

// ============================================
// Status filter
// ============================================

test("loadSubmittedPaymentsByPrisma scopes to status=SUBMITTED", async () => {
  setupEnv();
  const { loadSubmittedPaymentsByPrisma } = await import(
    "../services/loadSubmittedPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({ id: "p", status: "PENDING" }),
    samplePayment({ id: "s", status: "SUBMITTED" }),
    samplePayment({ id: "c", status: "CONFIRMED" }),
    samplePayment({ id: "f", status: "FAILED" }),
  ]);
  const result = await loadSubmittedPaymentsByPrisma(
    { limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.map((r) => r.id),
    ["s"],
  );
  assert.equal(stub.observed.findManyArgs.where.status, "SUBMITTED");
});

// ============================================
// txSignature must be present
// ============================================

test("loadSubmittedPaymentsByPrisma excludes rows with null txSignature", async () => {
  // A SUBMITTED row without a sig is malformed — the lifecycle
  // shouldn't allow it, but defense-in-depth excludes them so the
  // poll doesn't crash on a null arg.
  const { loadSubmittedPaymentsByPrisma } = await import(
    "../services/loadSubmittedPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({ id: "ok", txSignature: "sig_a" }),
    samplePayment({ id: "no_sig", txSignature: null }),
  ]);
  const result = await loadSubmittedPaymentsByPrisma(
    { limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.map((r) => r.id),
    ["ok"],
  );
});

test("loadSubmittedPaymentsByPrisma sets txSignature: { not: null } in the where clause", async () => {
  // Pin the SQL — index on (status, scheduledFor) will trigger and
  // the additional null filter keeps the result set tight.
  const { loadSubmittedPaymentsByPrisma } = await import(
    "../services/loadSubmittedPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([]);
  await loadSubmittedPaymentsByPrisma(
    { limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(stub.observed.findManyArgs.where.txSignature, {
    not: null,
  });
});

// ============================================
// Order — oldest submittedAt first
// ============================================

test("loadSubmittedPaymentsByPrisma orders by submittedAt asc (oldest first)", async () => {
  const { loadSubmittedPaymentsByPrisma } = await import(
    "../services/loadSubmittedPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "newer",
      submittedAt: new Date("2026-04-26T10:30:00Z"),
    }),
    samplePayment({
      id: "older",
      submittedAt: new Date("2026-04-26T09:30:00Z"),
    }),
  ]);
  const result = await loadSubmittedPaymentsByPrisma(
    { limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.map((r) => r.id),
    ["older", "newer"],
  );
});

// ============================================
// Pagination
// ============================================

test("loadSubmittedPaymentsByPrisma respects the limit", async () => {
  const { loadSubmittedPaymentsByPrisma } = await import(
    "../services/loadSubmittedPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "1",
      submittedAt: new Date("2026-04-26T09:00:00Z"),
    }),
    samplePayment({
      id: "2",
      submittedAt: new Date("2026-04-26T09:30:00Z"),
    }),
    samplePayment({
      id: "3",
      submittedAt: new Date("2026-04-26T10:00:00Z"),
    }),
  ]);
  const result = await loadSubmittedPaymentsByPrisma(
    { limit: 2 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => r.id),
    ["1", "2"],
  );
});

// ============================================
// Field projection
// ============================================

test("loadSubmittedPaymentsByPrisma returns the SubmittedPaymentRow shape (id + txSignature)", async () => {
  const { loadSubmittedPaymentsByPrisma } = await import(
    "../services/loadSubmittedPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({ id: "cp_a", txSignature: "sig_a" }),
  ]);
  const result = await loadSubmittedPaymentsByPrisma(
    { limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result[0]!.id, "cp_a");
  assert.equal(result[0]!.txSignature, "sig_a");
});
