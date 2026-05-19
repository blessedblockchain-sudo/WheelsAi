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

// Drives apps/api/src/services/loadPendingPaymentsByPrisma.ts —
// Prisma-backed loader for the submit-payments BullMQ worker.
//
// Returns ComputePayment rows in PENDING status with scheduledFor <=
// now, joined to AgentTreasury for treasuryPdaAddress (the source of
// funds). Ordered by scheduledFor asc so older payments don't get
// starved by newer ones.
//
// Pagination: `limit` controls per-tick batch size (production default
// ~50). The driver iterates the batch sequentially.

type Status = "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";

interface FakePayment {
  id: string;
  treasuryId: string;
  status: Status;
  scheduledFor: Date;
  amountLamports: bigint;
  nosanaJobId: string;
  treasury: {
    id: string;
    treasuryPdaAddress: string;
    programInitialized?: boolean;
    token?: { mintAddress: string };
  };
}

function makePrismaStub(payments: FakePayment[]) {
  const observed: { findManyArgs?: any } = {};
  return {
    observed,
    prisma: {
      computePayment: {
        async findMany({ where, orderBy, take, include }: any) {
          observed.findManyArgs = { where, orderBy, take, include };
          let matched = payments.filter((p) => {
            if (where.status && p.status !== where.status) return false;
            if (where.scheduledFor?.lte && p.scheduledFor > where.scheduledFor.lte) return false;
            return true;
          });
          if (orderBy?.scheduledFor === "asc") {
            matched = [...matched].sort(
              (a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime(),
            );
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
  treasuryId: "treas_1",
  status: "PENDING",
  scheduledFor: new Date("2026-04-26T10:00:00Z"),
  amountLamports: 1_000_000n,
  nosanaJobId: "job_1",
  treasury: { id: "treas_1", treasuryPdaAddress: "TreasuryPDA" },
  ...overrides,
});

const NOW = new Date("2026-04-26T11:00:00Z");

// ============================================
// Status filter
// ============================================

test("loadPendingPaymentsByPrisma scopes to status=PENDING", async () => {
  setupEnv();
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({ id: "p", status: "PENDING" }),
    samplePayment({ id: "s", status: "SUBMITTED" }),
    samplePayment({ id: "c", status: "CONFIRMED" }),
    samplePayment({ id: "f", status: "FAILED" }),
  ]);
  const result = await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "p");
  assert.equal(stub.observed.findManyArgs.where.status, "PENDING");
});

// ============================================
// scheduledFor filter
// ============================================

test("loadPendingPaymentsByPrisma excludes rows scheduled in the future", async () => {
  // The scheduledFor column is `default(now())` — usually present, but
  // a record could be intentionally future-scheduled (rate-limiting
  // or operator delay). We must not pre-pay those.
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "due",
      scheduledFor: new Date("2026-04-26T10:00:00Z"),
    }),
    samplePayment({
      id: "future",
      scheduledFor: new Date("2026-04-26T12:00:00Z"),
    }),
  ]);
  const result = await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.map((r) => r.id),
    ["due"],
  );
});

// ============================================
// Order
// ============================================

test("loadPendingPaymentsByPrisma orders by scheduledFor asc (oldest first)", async () => {
  // Fairness: a token whose treasury keeps emitting new PENDING rows
  // must not starve an older payment. asc = older payments first.
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "newer",
      scheduledFor: new Date("2026-04-26T10:30:00Z"),
    }),
    samplePayment({
      id: "older",
      scheduledFor: new Date("2026-04-26T09:30:00Z"),
    }),
  ]);
  const result = await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.map((r) => r.id),
    ["older", "newer"],
  );
  assert.equal(stub.observed.findManyArgs.orderBy.scheduledFor, "asc");
});

// ============================================
// Pagination via limit
// ============================================

test("loadPendingPaymentsByPrisma respects the limit (per-tick batch size)", async () => {
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "1",
      scheduledFor: new Date("2026-04-26T09:00:00Z"),
    }),
    samplePayment({
      id: "2",
      scheduledFor: new Date("2026-04-26T09:30:00Z"),
    }),
    samplePayment({
      id: "3",
      scheduledFor: new Date("2026-04-26T10:00:00Z"),
    }),
  ]);
  const result = await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 2 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => r.id),
    ["1", "2"],
  );
  assert.equal(stub.observed.findManyArgs.take, 2);
});

// ============================================
// Field projection — joined treasury
// ============================================

test("loadPendingPaymentsByPrisma flattens treasury.treasuryPdaAddress into the row", async () => {
  // The driver wants a flat row (no nested .treasury); the loader
  // does the flattening so callers don't pluck through the include.
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      treasury: { id: "treas_z", treasuryPdaAddress: "TreasuryPDA_Z" },
    }),
  ]);
  const result = await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result[0]!.treasuryAddress, "TreasuryPDA_Z");
  // No `treasury` nested object on the result.
  assert.equal("treasury" in result[0]!, false);
});

test("loadPendingPaymentsByPrisma preserves amountLamports as BigInt + nosanaJobId", async () => {
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "a",
      amountLamports: 999_999_999n,
      nosanaJobId: "job_xyz",
    }),
  ]);
  const result = await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.equal(typeof result[0]!.amountLamports, "bigint");
  assert.equal(result[0]!.amountLamports, 999_999_999n);
  assert.equal(result[0]!.nosanaJobId, "job_xyz");
});

// ============================================
// Dual-mode discriminator (programInitialized + mintAddress)
// ============================================

test("loadPendingPaymentsByPrisma defaults programInitialized to false when missing", async () => {
  setupEnv();
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([samplePayment()]); // no programInitialized
  const result = await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.equal(
    result[0]!.programInitialized,
    false,
    "rows from the legacy schema must default to legacy mode",
  );
});

test("loadPendingPaymentsByPrisma surfaces programInitialized=true through to the result", async () => {
  setupEnv();
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      treasury: {
        id: "treas_x",
        treasuryPdaAddress: "TreasuryPDA_X",
        programInitialized: true,
        token: { mintAddress: "MintXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      },
    }),
  ]);
  const result = await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result[0]!.programInitialized, true);
  assert.equal(
    result[0]!.mintAddress,
    "MintXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  );
});

test("loadPendingPaymentsByPrisma flattens mintAddress to null when token relation is missing", async () => {
  setupEnv();
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([samplePayment()]); // no .token nested
  const result = await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result[0]!.mintAddress, null);
});

test("loadPendingPaymentsByPrisma include includes the token mintAddress join", async () => {
  setupEnv();
  const { loadPendingPaymentsByPrisma } = await import(
    "../services/loadPendingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([samplePayment()]);
  await loadPendingPaymentsByPrisma(
    { now: NOW, limit: 100 },
    { prisma: stub.prisma as any },
  );
  // Pin the include shape so a refactor that drops the mint join breaks
  // this test rather than silently routing to legacy mode at runtime.
  const include = stub.observed.findManyArgs.include;
  assert.equal(include.treasury.select.programInitialized, true);
  assert.deepEqual(include.treasury.select.token, {
    select: { mintAddress: true },
  });
});
