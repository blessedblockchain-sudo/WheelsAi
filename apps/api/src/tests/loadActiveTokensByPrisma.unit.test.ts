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
// per token. Returns the minimal { id, mintAddress } shape — the per-
// tick context is otherwise built by the dep-builder per token.

type Status = "BONDING" | "GRADUATED" | "FAILED";

interface FakeToken {
  id: string;
  mintAddress: string;
  status: Status;
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

test("loadActiveTokensByPrisma returns the minimal { id, mintAddress } shape", async () => {
  // The indexer's per-tick input only needs id + mintAddress. The
  // loader explicitly selects those — no over-fetching of pumpfunUrl,
  // creatorAddress, etc. for what would be an idle scan.
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const stub = makePrismaStub([
    sample({ id: "t", mintAddress: "MintXYZ", status: "BONDING" }),
  ]);
  const result = await loadActiveTokensByPrisma({
    prisma: stub.prisma as any,
  });
  assert.deepEqual(Object.keys(result[0]!).sort(), ["id", "mintAddress"]);
  assert.equal(result[0]!.id, "t");
  assert.equal(result[0]!.mintAddress, "MintXYZ");
});

test("loadActiveTokensByPrisma requests select: { id, mintAddress } from Prisma", async () => {
  const { loadActiveTokensByPrisma } = await import(
    "../services/loadActiveTokensByPrisma.js"
  );
  const stub = makePrismaStub([]);
  await loadActiveTokensByPrisma({ prisma: stub.prisma as any });
  assert.deepEqual(stub.observed.findManyArgs.select, {
    id: true,
    mintAddress: true,
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
