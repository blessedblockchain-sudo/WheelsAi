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

// Drives apps/api/src/services/buildReapStuckTickDeps.ts —
// the full dep-wiring closure for the stuck-submission reaper.
//
// Composes:
//   loadStuckCandidatesByPrisma   → loadStuckCandidates
//   persistReapTransition         → persistTransition
//
// No RPC needed — the reaper is pure-classifier-plus-DB-write.

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

const NOW = new Date("2026-04-26T10:00:00Z");

// ============================================
// Build shape
// ============================================

test("buildReapStuckTickDeps returns the two driver-shape keys", async () => {
  setupEnv();
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildReapStuckTickDeps({
    prisma: stub.prisma as any,
    batchLimit: 100,
    maxAgeSeconds: 300,
  });
  for (const key of ["loadStuckCandidates", "persistTransition"]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
});

// ============================================
// loadStuckCandidates
// ============================================

test("buildReapStuckTickDeps loadStuckCandidates hits Prisma findMany with status=SUBMITTED + cutoff", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildReapStuckTickDeps({
    prisma: stub.prisma as any,
    batchLimit: 100,
    maxAgeSeconds: 300,
  });
  await deps.loadStuckCandidates({ now: NOW });
  const findMany = stub.log.find((c) => c.type === "findMany");
  assert.equal(findMany.args.where.status, "SUBMITTED");
  // cutoff = NOW - 300s = 09:55:00.
  const cutoff = new Date(NOW.getTime() - 300 * 1000);
  assert.equal(
    (findMany.args.where.submittedAt.lt as Date).toISOString(),
    cutoff.toISOString(),
  );
  assert.equal(findMany.args.take, 100);
});

test("buildReapStuckTickDeps loadStuckCandidates uses the batchLimit verbatim", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildReapStuckTickDeps({
    prisma: stub.prisma as any,
    batchLimit: 25,
    maxAgeSeconds: 300,
  });
  await deps.loadStuckCandidates({ now: NOW });
  assert.equal(
    stub.log.find((c) => c.type === "findMany").args.take,
    25,
  );
});

// ============================================
// persistTransition
// ============================================

test("buildReapStuckTickDeps persistTransition wires to updateMany WHERE status=SUBMITTED with FAILED + errorMessage", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  const deps = buildReapStuckTickDeps({
    prisma: stub.prisma as any,
    batchLimit: 100,
    maxAgeSeconds: 300,
  });
  await deps.persistTransition("cp_1", { errorMessage: "blockhash_expired" });
  const update = stub.log.find((c) => c.type === "updateMany");
  assert.equal(update.args.where.id, "cp_1");
  assert.equal(update.args.where.status, "SUBMITTED");
  assert.equal(update.args.data.status, "FAILED");
  assert.equal(update.args.data.errorMessage, "blockhash_expired");
});

test("buildReapStuckTickDeps persistTransition throws when count=0 (poll worker confirmed first)", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub({ matchedCount: 0 });
  const deps = buildReapStuckTickDeps({
    prisma: stub.prisma as any,
    batchLimit: 100,
    maxAgeSeconds: 300,
  });
  await assert.rejects(
    deps.persistTransition("cp_1", { errorMessage: "blockhash_expired" }),
    /not in SUBMITTED/,
  );
});

// ============================================
// End-to-end smoke
// ============================================

test("buildReapStuckTickDeps result drives runReapStuckTick on an empty batch", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const stub = makePrismaStub();
  const deps = buildReapStuckTickDeps({
    prisma: stub.prisma as any,
    batchLimit: 100,
    maxAgeSeconds: 300,
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps,
  );
  assert.deepEqual(result, { reaped: 0, scanned: 0 });
});
