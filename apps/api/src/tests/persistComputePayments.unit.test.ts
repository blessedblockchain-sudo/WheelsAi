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
// deployments with positive cost; FAILED for insufficient funds). The
// writer stamps them into computePayment with the schema-correct types
// (BigInt computeSeconds) AND — remediation D2 — does it inside ONE
// $transaction together with the compare-and-set advance of each
// treasury's lastComputeBillAt billing cursor:
//   (a) createMany({skipDuplicates: true}) — the composite unique
//       (treasuryId, nosanaJobId, periodStart) makes a replayed window
//       a DB no-op
//   (b) updateMany WHERE id AND (lastComputeBillAt IS NULL OR
//       < windowEnd) SET lastComputeBillAt = windowEnd — count 0 when a
//       concurrent tick already advanced is benign

interface ComputePaymentRecord {
  treasuryId: string;
  nosanaJobId: string;
  amountLamports: bigint;
  computeSeconds: number;
  status: "PENDING" | "FAILED";
  errorMessage?: string;
  scheduledFor: Date;
  periodStart: Date;
  periodEnd: Date;
}

function makePrismaStub(opts: { cursorUpdateCount?: number } = {}) {
  const log: any[] = [];
  // The tx client handed to the $transaction callback. Logged calls
  // carry the client identity so tests can prove createMany and the
  // cursor CAS share one transaction.
  const tx = {
    computePayment: {
      async createMany({ data, skipDuplicates }: any) {
        log.push({ type: "createMany", data, skipDuplicates, client: tx });
        return { count: data.length };
      },
    },
    agentTreasury: {
      async updateMany({ where, data }: any) {
        log.push({ type: "updateMany", where, data, client: tx });
        return { count: opts.cursorUpdateCount ?? 1 };
      },
    },
  };
  return {
    log,
    tx,
    prisma: {
      async $transaction(fn: (tx: any) => Promise<unknown>) {
        log.push({ type: "$transaction" });
        return fn(tx);
      },
    },
  };
}

const PERIOD_START = new Date("2026-04-26T09:00:00Z");
const PERIOD_END = new Date("2026-04-26T10:00:00Z");

const sampleRecord = (overrides: Partial<ComputePaymentRecord> = {}): ComputePaymentRecord => ({
  treasuryId: "treas_1",
  nosanaJobId: "job_1",
  amountLamports: 1_000_000n,
  computeSeconds: 3600,
  status: "PENDING",
  scheduledFor: new Date("2026-04-26T10:00:00Z"),
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
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
  const create = stub.log.find((c) => c.type === "createMany");
  assert.ok(create, "expected a createMany call");
  assert.equal(create.data.length, 3);
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
  const [row] = stub.log.find((c) => c.type === "createMany")!.data;
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
  const [row] = stub.log.find((c) => c.type === "createMany")!.data;
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
  const [row] = stub.log.find((c) => c.type === "createMany")!.data;
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
        errorMessage: "insufficient_funds",
      }),
    ],
    { prisma: stub.prisma as any },
  );
  const [row] = stub.log.find((c) => c.type === "createMany")!.data;
  assert.equal(row.status, "FAILED");
  assert.equal(row.errorMessage, "insufficient_funds");
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
  const [row] = stub.log.find((c) => c.type === "createMany")!.data;
  assert.equal(row.treasuryId, "treas_xyz");
  assert.equal(row.nosanaJobId, "job_xyz");
  assert.equal((row.scheduledFor as Date).toISOString(), scheduledFor.toISOString());
});

test("persistComputePayments stamps the billing window (periodStart/periodEnd) onto every row", async () => {
  // D2: the composite unique (treasuryId, nosanaJobId, periodStart) only
  // protects rows that actually carry the window bounds.
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments([sampleRecord()], { prisma: stub.prisma as any });
  const [row] = stub.log.find((c) => c.type === "createMany")!.data;
  assert.equal((row.periodStart as Date).toISOString(), PERIOD_START.toISOString());
  assert.equal((row.periodEnd as Date).toISOString(), PERIOD_END.toISOString());
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
  const [row] = stub.log.find((c) => c.type === "createMany")!.data;
  assert.equal("nonsense" in row, false);
});

// ============================================
// D2: window idempotency (skipDuplicates)
// ============================================

test("persistComputePayments passes skipDuplicates:true so a re-persisted window is a DB no-op", async () => {
  // The DB-level guarantee: (treasuryId, nosanaJobId, periodStart) is
  // unique; skipDuplicates makes a crash-replayed tick (same window)
  // silently insert nothing instead of throwing P2002.
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments([sampleRecord()], { prisma: stub.prisma as any });
  const create = stub.log.find((c) => c.type === "createMany")!;
  assert.equal(create.skipDuplicates, true);

  // Re-persist of the exact same window: same createMany shape again —
  // the unique key + skipDuplicates make it a no-op server-side, and no
  // error surfaces to the cycle.
  await persistComputePayments([sampleRecord()], { prisma: stub.prisma as any });
  const creates = stub.log.filter((c) => c.type === "createMany");
  assert.equal(creates.length, 2);
  assert.equal(creates[1]!.skipDuplicates, true);
  assert.deepEqual(creates[1]!.data, creates[0]!.data);
});

// ============================================
// D2: cursor compare-and-set
// ============================================

test("persistComputePayments advances the treasury cursor to the window end with a CAS where-clause", async () => {
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments([sampleRecord()], { prisma: stub.prisma as any });

  const cas = stub.log.find((c) => c.type === "updateMany");
  assert.ok(cas, "expected a cursor updateMany");
  assert.equal(cas.where.id, "treas_1");
  // Guard: only move FORWARD — null cursor or one strictly before
  // windowEnd. A concurrent tick that already advanced makes count 0.
  assert.deepEqual(cas.where.OR, [
    { lastComputeBillAt: null },
    { lastComputeBillAt: { lt: PERIOD_END } },
  ]);
  assert.equal(
    (cas.data.lastComputeBillAt as Date).toISOString(),
    PERIOD_END.toISOString(),
  );
});

test("persistComputePayments cursor CAS no-ops benignly when already advanced (count 0)", async () => {
  // updateMany returning count 0 (concurrent tick won the race) must NOT
  // throw — the payment rows were deduped by skipDuplicates and the
  // cursor is already at/past windowEnd.
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub({ cursorUpdateCount: 0 });
  await persistComputePayments([sampleRecord()], { prisma: stub.prisma as any });
  assert.equal(stub.log.filter((c) => c.type === "updateMany").length, 1);
});

test("persistComputePayments advances the cursor for FAILED (insufficient_funds) rows too", async () => {
  // One bill row per window regardless of outcome: the FAILED row IS the
  // bill for that window. Re-metering it once funds arrive would
  // double-charge, so the cursor moves the same way as for PENDING.
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments(
    [sampleRecord({ status: "FAILED", errorMessage: "insufficient_funds" })],
    { prisma: stub.prisma as any },
  );
  const cas = stub.log.find((c) => c.type === "updateMany");
  assert.ok(cas, "FAILED row must still advance the billing cursor");
  assert.equal(
    (cas.data.lastComputeBillAt as Date).toISOString(),
    PERIOD_END.toISOString(),
  );
});

test("persistComputePayments issues one cursor CAS per treasury using its latest periodEnd", async () => {
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  const later = new Date("2026-04-26T11:00:00Z");
  await persistComputePayments(
    [
      sampleRecord({ treasuryId: "treas_a", nosanaJobId: "job_1" }),
      sampleRecord({ treasuryId: "treas_a", nosanaJobId: "job_2", periodEnd: later }),
      sampleRecord({ treasuryId: "treas_b", nosanaJobId: "job_3" }),
    ],
    { prisma: stub.prisma as any },
  );
  const casCalls = stub.log.filter((c) => c.type === "updateMany");
  assert.equal(casCalls.length, 2);
  const byId = new Map(casCalls.map((c) => [c.where.id, c.data.lastComputeBillAt]));
  // treas_a takes the LATEST periodEnd among its rows.
  assert.equal((byId.get("treas_a") as Date).toISOString(), later.toISOString());
  assert.equal((byId.get("treas_b") as Date).toISOString(), PERIOD_END.toISOString());
});

// ============================================
// D2: single transaction
// ============================================

test("persistComputePayments runs createMany and the cursor CAS on the same transaction client", async () => {
  // The whole point of the $transaction: rows-without-cursor or
  // cursor-without-rows must be impossible on crash.
  const { persistComputePayments } = await import(
    "../services/persistComputePayments.js"
  );
  const stub = makePrismaStub();
  await persistComputePayments([sampleRecord()], { prisma: stub.prisma as any });

  assert.equal(stub.log.filter((c) => c.type === "$transaction").length, 1);
  const create = stub.log.find((c) => c.type === "createMany")!;
  const cas = stub.log.find((c) => c.type === "updateMany")!;
  assert.equal(create.client, stub.tx);
  assert.equal(cas.client, stub.tx);
  assert.equal(create.client, cas.client);
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
    async $transaction(fn: (tx: any) => Promise<unknown>) {
      return fn({
        computePayment: {
          async createMany() {
            throw new Error("FK constraint violation");
          },
        },
        agentTreasury: {
          async updateMany() {
            return { count: 1 };
          },
        },
      });
    },
  };
  await assert.rejects(
    persistComputePayments([sampleRecord()], { prisma: prisma as any }),
    /FK constraint violation/,
  );
});
