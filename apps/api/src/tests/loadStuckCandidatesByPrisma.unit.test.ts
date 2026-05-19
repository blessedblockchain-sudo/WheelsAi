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

// Drives apps/api/src/services/loadStuckCandidatesByPrisma.ts —
// loader for the stuck-submission reaper BullMQ worker.
//
// Returns SUBMITTED rows whose submittedAt is older than (now -
// maxAgeSeconds) — these are the candidates for blockhash-expired
// FAILED transitions. The full ReaperPayment shape is returned so
// the pure reapStuckSubmissions classifier can re-validate the age
// (defense-in-depth — DB clock could disagree with worker clock).
//
// Returned rows include null-submittedAt entries because pre-migration
// payments could have null submittedAt; reapStuckSubmissions skips
// those classifying changed=false. The reaper would never persist a
// transition for them, but the driver counts them in `scanned`.

type Status = "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";

interface FakePayment {
  id: string;
  status: Status;
  txSignature: string | null;
  errorMessage: string | null;
  paidAt: Date | null;
  retryCount: number;
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
            if (where.submittedAt?.lt) {
              if (!p.submittedAt) return false;
              if (p.submittedAt >= where.submittedAt.lt) return false;
            }
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
  errorMessage: null,
  paidAt: null,
  retryCount: 0,
  submittedAt: new Date("2026-04-26T09:00:00Z"),
  ...overrides,
});

const NOW = new Date("2026-04-26T10:00:00Z"); // 1h after sample default

// ============================================
// Status filter
// ============================================

test("loadStuckCandidatesByPrisma scopes to status=SUBMITTED", async () => {
  setupEnv();
  const { loadStuckCandidatesByPrisma } = await import(
    "../services/loadStuckCandidatesByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({ id: "p", status: "PENDING" }),
    samplePayment({ id: "s", status: "SUBMITTED" }),
    samplePayment({ id: "c", status: "CONFIRMED" }),
    samplePayment({ id: "f", status: "FAILED" }),
  ]);
  const result = await loadStuckCandidatesByPrisma(
    { now: NOW, maxAgeSeconds: 300, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.map((r) => r.id),
    ["s"],
  );
  assert.equal(stub.observed.findManyArgs.where.status, "SUBMITTED");
});

// ============================================
// Cutoff filter
// ============================================

test("loadStuckCandidatesByPrisma scopes by submittedAt < (now - maxAge)", async () => {
  // The pure reapStuckSubmissions also re-checks; the loader's cutoff
  // is just a SQL-side narrowing so we don't ship every SUBMITTED row
  // to the worker.
  const { loadStuckCandidatesByPrisma } = await import(
    "../services/loadStuckCandidatesByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "stuck",
      submittedAt: new Date("2026-04-26T09:00:00Z"),
    }),
    samplePayment({
      id: "fresh",
      submittedAt: new Date("2026-04-26T09:58:00Z"), // 2 min ago, well within 5 min cutoff
    }),
  ]);
  const result = await loadStuckCandidatesByPrisma(
    { now: NOW, maxAgeSeconds: 300, limit: 100 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.map((r) => r.id),
    ["stuck"],
  );
  // Cutoff = now - 300s = 09:55:00.
  const cutoff = new Date(NOW.getTime() - 300 * 1000);
  assert.equal(
    (stub.observed.findManyArgs.where.submittedAt.lt as Date).toISOString(),
    cutoff.toISOString(),
  );
});

// ============================================
// Order — oldest first
// ============================================

test("loadStuckCandidatesByPrisma orders by submittedAt asc", async () => {
  const { loadStuckCandidatesByPrisma } = await import(
    "../services/loadStuckCandidatesByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "newer",
      submittedAt: new Date("2026-04-26T09:30:00Z"),
    }),
    samplePayment({
      id: "older",
      submittedAt: new Date("2026-04-26T08:30:00Z"),
    }),
  ]);
  const result = await loadStuckCandidatesByPrisma(
    { now: NOW, maxAgeSeconds: 300, limit: 100 },
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

test("loadStuckCandidatesByPrisma respects the limit", async () => {
  const { loadStuckCandidatesByPrisma } = await import(
    "../services/loadStuckCandidatesByPrisma.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "1",
      submittedAt: new Date("2026-04-26T07:00:00Z"),
    }),
    samplePayment({
      id: "2",
      submittedAt: new Date("2026-04-26T07:30:00Z"),
    }),
    samplePayment({
      id: "3",
      submittedAt: new Date("2026-04-26T08:00:00Z"),
    }),
  ]);
  const result = await loadStuckCandidatesByPrisma(
    { now: NOW, maxAgeSeconds: 300, limit: 2 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 2);
});

// ============================================
// Field projection — full ReaperPayment shape
// ============================================

test("loadStuckCandidatesByPrisma returns the full ReaperPayment shape", async () => {
  // The pure reapStuckSubmissions classifier walks every field of
  // ComputePaymentState — id, status, txSignature, errorMessage,
  // paidAt, retryCount — plus submittedAt. Loader returns all.
  const { loadStuckCandidatesByPrisma } = await import(
    "../services/loadStuckCandidatesByPrisma.js"
  );
  const submittedAt = new Date("2026-04-26T08:00:00Z");
  const stub = makePrismaStub([
    samplePayment({
      id: "cp_full",
      status: "SUBMITTED",
      txSignature: "sig_full",
      errorMessage: null,
      paidAt: null,
      retryCount: 2,
      submittedAt,
    }),
  ]);
  const result = await loadStuckCandidatesByPrisma(
    { now: NOW, maxAgeSeconds: 300, limit: 100 },
    { prisma: stub.prisma as any },
  );
  const row = result[0]!;
  assert.equal(row.id, "cp_full");
  assert.equal(row.status, "SUBMITTED");
  assert.equal(row.txSignature, "sig_full");
  assert.equal(row.errorMessage, null);
  assert.equal(row.paidAt, null);
  assert.equal(row.retryCount, 2);
  assert.equal((row.submittedAt as Date).toISOString(), submittedAt.toISOString());
});

// ============================================
// End-to-end: feed loader output into the reaper tick
// ============================================

test("loadStuckCandidatesByPrisma output is consumable by runReapStuckTick", async () => {
  // The whole point of this loader: produce ReaperPayment[] that
  // runReapStuckTick can hand to reapStuckSubmissions verbatim.
  const { loadStuckCandidatesByPrisma } = await import(
    "../services/loadStuckCandidatesByPrisma.js"
  );
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const stub = makePrismaStub([
    samplePayment({
      id: "stuck",
      submittedAt: new Date("2026-04-26T09:00:00Z"),
    }),
  ]);
  const persisted: any[] = [];
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    {
      loadStuckCandidates: ({ now }) =>
        loadStuckCandidatesByPrisma(
          { now, maxAgeSeconds: 300, limit: 100 },
          { prisma: stub.prisma as any },
        ),
      persistTransition: async (id, t) => {
        persisted.push({ id, ...t });
      },
    },
  );
  assert.equal(result.reaped, 1);
  assert.equal(persisted[0].id, "stuck");
});
