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

// Drives apps/api/src/services/loadIndexerHealthByPrisma.ts — the
// honest, DB-derived payload behind GET /api/tokens/indexer/metrics
// (plan D7).
//
// The old endpoint mirrored in-memory counters of the deleted
// setInterval worker — enabled/running/startedAt were per-process
// fields the BullMQ worker never wrote, so the endpoint reported a
// stopped indexer regardless of reality. The replacement derives
// everything from agent_tokens.trade_index_cursor: durable,
// replica-independent, and advanced only by successful ticks.

interface FakeToken {
  status: "BONDING" | "GRADUATED" | "FAILED";
  tradeIndexCursor: Date | null;
}

function makePrismaStub(tokens: FakeToken[]) {
  const isActive = (t: FakeToken, statuses: readonly string[]) =>
    statuses.includes(t.status);

  return {
    agentToken: {
      count: async (args: {
        where: {
          status: { in: readonly string[] };
          tradeIndexCursor?: null;
        };
      }) => {
        let rows = tokens.filter((t) => isActive(t, args.where.status.in));
        if ("tradeIndexCursor" in args.where) {
          rows = rows.filter((t) => t.tradeIndexCursor === null);
        }
        return rows.length;
      },
      aggregate: async (args: {
        where: { status: { in: readonly string[] } };
      }) => {
        const cursors = tokens
          .filter((t) => isActive(t, args.where.status.in))
          .map((t) => t.tradeIndexCursor)
          .filter((c): c is Date => c !== null);
        const min =
          cursors.length > 0
            ? new Date(Math.min(...cursors.map((c) => c.getTime())))
            : null;
        const max =
          cursors.length > 0
            ? new Date(Math.max(...cursors.map((c) => c.getTime())))
            : null;
        return {
          _min: { tradeIndexCursor: min },
          _max: { tradeIndexCursor: max },
        };
      },
    },
  };
}

const NOW = new Date("2026-06-12T12:00:00Z");

test("loadIndexerHealthByPrisma reports counts and cursor ages from the DB", async () => {
  setupEnv();
  const { loadIndexerHealthByPrisma } = await import(
    "../services/loadIndexerHealthByPrisma.js"
  );
  const prisma = makePrismaStub([
    // Freshest cursor: 30s old.
    { status: "BONDING", tradeIndexCursor: new Date("2026-06-12T11:59:30Z") },
    // Stalest cursor: 600s old.
    { status: "GRADUATED", tradeIndexCursor: new Date("2026-06-12T11:50:00Z") },
    // Never indexed.
    { status: "BONDING", tradeIndexCursor: null },
    // FAILED is not part of the active set at all.
    { status: "FAILED", tradeIndexCursor: null },
  ]);

  const health = await loadIndexerHealthByPrisma({
    prisma: prisma as never,
    now: () => NOW,
  });

  assert.deepEqual(health, {
    source: "database",
    activeTokens: 3,
    indexedTokens: 2,
    neverIndexedTokens: 1,
    oldestCursorAgeSeconds: 600,
    newestCursorAgeSeconds: 30,
    generatedAt: "2026-06-12T12:00:00.000Z",
  });
});

test("loadIndexerHealthByPrisma: no active tokens → zero counts and null ages", async () => {
  const { loadIndexerHealthByPrisma } = await import(
    "../services/loadIndexerHealthByPrisma.js"
  );
  const health = await loadIndexerHealthByPrisma({
    prisma: makePrismaStub([]) as never,
    now: () => NOW,
  });
  assert.equal(health.activeTokens, 0);
  assert.equal(health.indexedTokens, 0);
  assert.equal(health.neverIndexedTokens, 0);
  assert.equal(health.oldestCursorAgeSeconds, null);
  assert.equal(health.newestCursorAgeSeconds, null);
});

test("loadIndexerHealthByPrisma: all tokens never indexed → null ages, honest neverIndexed count", async () => {
  const { loadIndexerHealthByPrisma } = await import(
    "../services/loadIndexerHealthByPrisma.js"
  );
  const health = await loadIndexerHealthByPrisma({
    prisma: makePrismaStub([
      { status: "BONDING", tradeIndexCursor: null },
      { status: "BONDING", tradeIndexCursor: null },
    ]) as never,
    now: () => NOW,
  });
  assert.equal(health.activeTokens, 2);
  assert.equal(health.neverIndexedTokens, 2);
  assert.equal(health.indexedTokens, 0);
  assert.equal(health.oldestCursorAgeSeconds, null);
});

test("loadIndexerHealthByPrisma clamps a future cursor to age 0 (clock skew)", async () => {
  const { loadIndexerHealthByPrisma } = await import(
    "../services/loadIndexerHealthByPrisma.js"
  );
  const health = await loadIndexerHealthByPrisma({
    prisma: makePrismaStub([
      { status: "BONDING", tradeIndexCursor: new Date("2026-06-12T12:00:05Z") },
    ]) as never,
    now: () => NOW,
  });
  assert.equal(health.newestCursorAgeSeconds, 0);
  assert.equal(health.oldestCursorAgeSeconds, 0);
});

test("loadIndexerHealthByPrisma payload contains no in-memory worker fields", async () => {
  // The lie being removed: enabled/running/startedAt described a
  // process-local setInterval that no longer exists. The honest payload
  // must not resurrect them.
  const { loadIndexerHealthByPrisma } = await import(
    "../services/loadIndexerHealthByPrisma.js"
  );
  const health = await loadIndexerHealthByPrisma({
    prisma: makePrismaStub([]) as never,
    now: () => NOW,
  });
  for (const liedField of ["enabled", "running", "startedAt", "ticks"]) {
    assert.equal(liedField in health, false, `${liedField} must not exist`);
  }
  assert.equal(health.source, "database");
});
