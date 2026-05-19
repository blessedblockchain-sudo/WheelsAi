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

// Drives apps/api/src/services/persistComputePayments.ts — the
// production persistPayments closure for runTreasurySettlementCycle.
//
// Each tick emits a batch of ComputePaymentRecord rows (PENDING for
// deployments with positive cost; FAILED for ones whose cost lookup
// errored). The loader stamps them into computePayment with the
// schema-correct types (BigInt computeSeconds, default-now createdAt
// from the DB).

interface ComputePaymentRecord {
  treasuryId: string;
  nosanaJobId: string;
  amountLamports: bigint;
  computeSeconds: number;
  status: "PENDING" | "FAILED";
  errorMessage?: string;
  scheduledFor: Date;
}

function makePrismaStub() {
  const log: any[] = [];
  return {
    log,
    prisma: {
      computePayment: {
        async createMany({ data }: any) {
          log.push({ type: "createMany", data });
          return { count: data.length };
        },
      },
    },
  };
}

const sampleRecord = (overrides: Partial<ComputePaymentRecord> = {}): ComputePaymentRecord => ({
  treasuryId: "treas_1",
  nosanaJobId: "job_1",
  amountLamports: 1_000_000n,
  computeSeconds: 3600,
  status: "PENDING",
  scheduledFor: new Date("2026-04-26T10:00:00Z"),
  ...overrides,
});

// ============================================
// No-op
// ============================================

test("persistComputePayments returns 0 and skips the DB call when records is empty", async () => {
  setupEnv();
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  const result = await persistComputePayments([], {
    prisma: stub.prisma as any,
  });
  assert.equal(result, undefined);
  assert.equal(stub.log.length, 0);
});

// ============================================
// Batch insert
// ============================================

test("persistComputePayments writes one createMany row per record", async () => {
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments(
    [
      sampleRecord({ nosanaJobId: "job_1" }),
      sampleRecord({ nosanaJobId: "job_2" }),
      sampleRecord({ nosanaJobId: "job_3" }),
    ],
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.log[0].type, "createMany");
  assert.equal(stub.log[0].data.length, 3);
});

test("persistComputePayments converts computeSeconds (number) → BigInt for the schema", async () => {
  // ComputePaymentRecord.computeSeconds is `number`; schema column is
  // BigInt. The writer must convert at this boundary or Prisma rejects.
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments(
    [sampleRecord({ computeSeconds: 7200 })],
    { prisma: stub.prisma as any },
  );
  const [row] = stub.log[0].data;
  assert.equal(typeof row.computeSeconds, "bigint");
  assert.equal(row.computeSeconds, 7200n);
});

test("persistComputePayments preserves amountLamports as BigInt verbatim", async () => {
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments(
    [sampleRecord({ amountLamports: 999_999_999n })],
    { prisma: stub.prisma as any },
  );
  const [row] = stub.log[0].data;
  assert.equal(typeof row.amountLamports, "bigint");
  assert.equal(row.amountLamports, 999_999_999n);
});

// ============================================
// Status + error fields
// ============================================

test("persistComputePayments writes a PENDING row with no errorMessage", async () => {
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments(
    [sampleRecord({ status: "PENDING" })],
    { prisma: stub.prisma as any },
  );
  const [row] = stub.log[0].data;
  assert.equal(row.status, "PENDING");
  // errorMessage was undefined on the record; the writer must not
  // smuggle a stringified `"undefined"` onto the column.
  assert.ok(row.errorMessage === null || row.errorMessage === undefined);
});

test("persistComputePayments writes a FAILED row with the errorMessage", async () => {
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments(
    [
      sampleRecord({
        status: "FAILED",
        errorMessage: "nosana_unreachable",
      }),
    ],
    { prisma: stub.prisma as any },
  );
  const [row] = stub.log[0].data;
  assert.equal(row.status, "FAILED");
  assert.equal(row.errorMessage, "nosana_unreachable");
});

// ============================================
// Field projection
// ============================================

test("persistComputePayments stamps treasuryId, nosanaJobId, scheduledFor verbatim", async () => {
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  const scheduledFor = new Date("2026-04-26T10:00:00Z");
  await persistComputePayments(
    [
      sampleRecord({
        treasuryId: "treas_xyz",
        nosanaJobId: "job_xyz",
        scheduledFor,
      }),
    ],
    { prisma: stub.prisma as any },
  );
  const [row] = stub.log[0].data;
  assert.equal(row.treasuryId, "treas_xyz");
  assert.equal(row.nosanaJobId, "job_xyz");
  assert.equal((row.scheduledFor as Date).toISOString(), scheduledFor.toISOString());
});

test("persistComputePayments does not leak unrelated keys onto the row", async () => {
  // Future ComputePaymentRecord shapes could grow fields the schema
  // rejects. Explicit projection.
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments(
    [{ ...sampleRecord(), nonsense: "drop me" } as any],
    { prisma: stub.prisma as any },
  );
  const [row] = stub.log[0].data;
  assert.equal("nonsense" in row, false);
});

// ============================================
// Error handling
// ============================================

test("persistComputePayments bubbles Prisma errors to the cycle", async () => {
  // The cycle catches+counts errors per-deployment but the persist
  // step is the final boundary. Swallowing here would silently drop
  // payment records.
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const prisma = {
    computePayment: {
      async createMany() {
        throw new Error("FK constraint violation");
      },
    },
  };
  await assert.rejects(
    persistComputePayments([sampleRecord()], { prisma: prisma as any }),
    /FK constraint violation/,
  );
});
