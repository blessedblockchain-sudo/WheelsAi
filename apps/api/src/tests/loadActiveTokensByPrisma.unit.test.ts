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

// Drives apps/api/src/services/loadActiveTokensByPrisma.ts —
// loader for the token-trade-indexer outer loop.
//
// Returns tokens whose trades need indexing — status BONDING or
// GRADUATED. FAILED tokens never had a successful curve and don't
// emit further trades.
//
// Indexer-driver iterates this list and runs runTokenTradeIndexerTick
// per token. Returns the minimal { id, mintAddress, status,
// tradeIndexCursor } shape (plan D7): `status` gates the graduation
// check and `tradeIndexCursor` is the per-token high-water mark the
// pagination loop fetches down to. Nothing else is over-fetched.

type Status = "BONDING" | "GRADUATED" | "FAILED";

interface FakeToken {
  id: string;
  mintAddress: string;
  status: Status;
  tradeIndexCursor?: Date | null;
}

function makePrismaStub(tokens: FakeToken[]) {
  const observed: { findManyArgs?: any } = {};
  return {
    observed,
    prisma: {
      agentToken: {
        async findMany({ where, select }: any) {
          observed.findManyArgs = { where, select };
          return tokens.filter((t) => {
            if (where.status?.in) return where.status.in.includes(t.status);
            if (where.status) return t.status === where.status;
            return true;
          });
        },
      },
    },
  };
}

const sample = (overrides: Partial<FakeToken> = {}): FakeToken => ({
  id: "tok_1",
  mintAddress: "MintAddr_1",
  status: "BONDING",
  tradeIndexCursor: null,
  ...overrides,
});

// ============================================
// Status filter
// ============================================

test("loadActiveTokensByPrisma includes BONDING tokens", async () => {
  setupEnv();
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const stub = makePrismaStub([sample({ id: "b", status: "BONDING" })]);
  const result = await loadActiveTokensByPrisma({
    prisma: stub.prisma as any,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "b");
});

test("loadActiveTokensByPrisma includes GRADUATED tokens (post-pumpfun, on Raydium)", async () => {
  // Graduated tokens still emit trades — just on Raydium V4 instead
  // of pump.fun's bonding curve. The fetchTrades closure routes by
  // status; both are indexable.
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const stub = makePrismaStub([sample({ id: "g", status: "GRADUATED" })]);
  const result = await loadActiveTokensByPrisma({
    prisma: stub.prisma as any,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "g");
});

test("loadActiveTokensByPrisma excludes FAILED tokens", async () => {
  // FAILED = curve never completed; no trade history will accrue.
  // Indexing them would burn polls on dead mints.
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const stub = makePrismaStub([
    sample({ id: "alive", status: "BONDING" }),
    sample({ id: "dead", status: "FAILED" }),
  ]);
  const result = await loadActiveTokensByPrisma({
    prisma: stub.prisma as any,
  });
  assert.deepEqual(
    result.map((r) => r.id),
    ["alive"],
  );
});

test("loadActiveTokensByPrisma uses status: { in: [BONDING, GRADUATED] } in the where clause", async () => {
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const stub = makePrismaStub([]);
  await loadActiveTokensByPrisma({ prisma: stub.prisma as any });
  assert.deepEqual(
    [...stub.observed.findManyArgs.where.status.in].sort(),
    ["BONDING", "GRADUATED"],
  );
});

// ============================================
// Field projection
// ============================================

test("loadActiveTokensByPrisma returns the minimal { id, mintAddress, status, tradeIndexCursor } shape", async () => {
  // The outer-tick deps builder needs exactly these four: id +
  // mintAddress for the tick, status for the graduation gate,
  // tradeIndexCursor for the pagination high-water mark. No
  // over-fetching of pumpfunUrl, creatorAddress, etc. for what would
  // be an idle scan.
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const cursor = new Date("2026-06-01T00:00:00Z");
  const stub = makePrismaStub([
    sample({
      id: "t",
      mintAddress: "MintXYZ",
      status: "BONDING",
      tradeIndexCursor: cursor,
    }),
  ]);
  const result = await loadActiveTokensByPrisma({
    prisma: stub.prisma as any,
  });
  assert.deepEqual(Object.keys(result[0]!).sort(), [
    "id",
    "mintAddress",
    "status",
    "tradeIndexCursor",
  ]);
  assert.equal(result[0]!.id, "t");
  assert.equal(result[0]!.mintAddress, "MintXYZ");
  assert.equal(result[0]!.status, "BONDING");
  assert.equal(result[0]!.tradeIndexCursor!.toISOString(), cursor.toISOString());
});

test("loadActiveTokensByPrisma surfaces a null cursor as null (never-indexed token)", async () => {
  // Null = never indexed; the deps builder maps it to epoch so the
  // first tick fetches the token's full history.
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const stub = makePrismaStub([sample({ id: "fresh" })]);
  const result = await loadActiveTokensByPrisma({
    prisma: stub.prisma as any,
  });
  assert.equal(result[0]!.tradeIndexCursor, null);
});

test("loadActiveTokensByPrisma requests select: { id, mintAddress, status, tradeIndexCursor } from Prisma", async () => {
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const stub = makePrismaStub([]);
  await loadActiveTokensByPrisma({ prisma: stub.prisma as any });
  assert.deepEqual(stub.observed.findManyArgs.select, {
    id: true,
    mintAddress: true,
    status: true,
    tradeIndexCursor: true,
  });
});

// ============================================
// Empty
// ============================================

test("loadActiveTokensByPrisma returns [] when no tokens are active", async () => {
  // Bootstrap state — pre-launch the table can be empty. The driver
  // shouldn't crash; it should just sit and run nothing per tick.
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const stub = makePrismaStub([]);
  const result = await loadActiveTokensByPrisma({
    prisma: stub.prisma as any,
  });
  assert.deepEqual(result, []);
});
