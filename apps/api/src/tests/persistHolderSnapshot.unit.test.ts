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

// Drives apps/api/src/services/persistHolderSnapshot.ts — the
// production persistHolderSnapshot closure for the token-trade indexer.
//
// The snapshot semantics are BULK REPLACE: the holder distribution
// shifts continuously (someone can sell to zero, leave the set entirely),
// so an upsert is wrong — old rows must be deleted, new ones inserted.
//
// Atomicity: deleteMany + createMany must run inside a single
// $transaction so callers never observe a half-written holder set
// (governance / runway dashboards read this live).

interface PrismaCallLog {
  type: "deleteMany" | "createMany" | "transaction";
  args: any;
}

function makePrismaStub() {
  const log: PrismaCallLog[] = [];
  const stored: Record<
    string,
    Array<{ walletAddress: string; balance: number; percentage: number }>
  > = {};

  const tokenOps = {
    agentTokenHolder: {
      async deleteMany({ where }: any) {
        log.push({ type: "deleteMany", args: where });
        const before = stored[where.tokenId]?.length ?? 0;
        stored[where.tokenId] = [];
        return { count: before };
      },
      async createMany({ data }: any) {
        log.push({ type: "createMany", args: data });
        for (const row of data) {
          stored[row.tokenId] ??= [];
          stored[row.tokenId]!.push({
            walletAddress: row.walletAddress,
            balance: row.balance,
            percentage: row.percentage,
          });
        }
        return { count: data.length };
      },
    },
  };

  return {
    log,
    stored,
    prisma: {
      ...tokenOps,
      async $transaction(work: any) {
        log.push({ type: "transaction", args: null });
        // Real Prisma calls work() with a tx-bound client; the simple
        // model here just runs the callback against the same handle.
        return await work(tokenOps);
      },
    },
  };
}

const sampleHolder = (overrides: Partial<{
  walletAddress: string;
  balance: number;
  percentage: number;
  balanceRaw: bigint;
}> = {}) => ({
  walletAddress: "Alice",
  balance: 1_000,
  percentage: 50,
  balanceRaw: 1_000_000_000n, // 1_000 tokens × 1e6
  ...overrides,
});

// ============================================
// Atomicity
// ============================================

test("persistHolderSnapshot wraps both writes in a single $transaction", async () => {
  setupEnv();
  const { persistHolderSnapshot } = await import(
    "../services/persistHolderSnapshot.js"
  );
  const stub = makePrismaStub();
  await persistHolderSnapshot(
    {
      tokenId: "tok_1",
      holders: [sampleHolder()],
      totalBalance: 1_000,
    },
    { prisma: stub.prisma as any },
  );
  // Order matters: transaction wraps deleteMany + createMany.
  assert.equal(stub.log[0]!.type, "transaction");
  assert.equal(stub.log[1]!.type, "deleteMany");
  assert.equal(stub.log[2]!.type, "createMany");
});

test("persistHolderSnapshot deletes old rows scoped by tokenId before inserting", async () => {
  const { persistHolderSnapshot } = await import(
    "../services/persistHolderSnapshot.js"
  );
  const stub = makePrismaStub();
  // Pre-existing rows for the same token + a different token.
  stub.stored["tok_1"] = [{ walletAddress: "Old", balance: 1, percentage: 1 }];
  stub.stored["tok_other"] = [{ walletAddress: "Keep", balance: 1, percentage: 1 }];

  await persistHolderSnapshot(
    {
      tokenId: "tok_1",
      holders: [sampleHolder({ walletAddress: "New" })],
      totalBalance: 1_000,
    },
    { prisma: stub.prisma as any },
  );
  // Old token row replaced.
  assert.deepEqual(
    stub.stored["tok_1"]!.map((r) => r.walletAddress),
    ["New"],
  );
  // Other token left alone.
  assert.deepEqual(
    stub.stored["tok_other"]!.map((r) => r.walletAddress),
    ["Keep"],
  );
});

// ============================================
// Field mapping
// ============================================

test("persistHolderSnapshot stamps tokenId onto every inserted row", async () => {
  const { persistHolderSnapshot } = await import(
    "../services/persistHolderSnapshot.js"
  );
  const stub = makePrismaStub();
  await persistHolderSnapshot(
    {
      tokenId: "tok_1",
      holders: [
        sampleHolder({ walletAddress: "Alice" }),
        sampleHolder({ walletAddress: "Bob" }),
      ],
      totalBalance: 1_000,
    },
    { prisma: stub.prisma as any },
  );
  const createCall = stub.log.find((c) => c.type === "createMany")!;
  for (const row of createCall.args) {
    assert.equal(row.tokenId, "tok_1");
  }
});

test("persistHolderSnapshot persists wallet/balance/percentage verbatim", async () => {
  const { persistHolderSnapshot } = await import(
    "../services/persistHolderSnapshot.js"
  );
  const stub = makePrismaStub();
  await persistHolderSnapshot(
    {
      tokenId: "tok_1",
      holders: [
        {
          walletAddress: "Whale",
          balance: 999_999.5,
          percentage: 42.42,
          balanceRaw: 999_999_500_000n,
        },
      ],
      totalBalance: 1_000_000,
    },
    { prisma: stub.prisma as any },
  );
  const [row] = stub.log.find((c) => c.type === "createMany")!.args;
  assert.equal(row.walletAddress, "Whale");
  assert.equal(row.balance, 999_999.5);
  assert.equal(row.percentage, 42.42);
  // balanceRaw is the access-decision source of truth — persisted verbatim.
  assert.equal(row.balanceRaw, 999_999_500_000n);
});

test("persistHolderSnapshot does not leak unrelated keys onto the row", async () => {
  // Future HolderRow shapes shouldn't smuggle junk columns onto the
  // schema. Explicit projection.
  const { persistHolderSnapshot } = await import(
    "../services/persistHolderSnapshot.js"
  );
  const stub = makePrismaStub();
  await persistHolderSnapshot(
    {
      tokenId: "tok_1",
      holders: [
        { ...sampleHolder(), nonsense: "drop me" } as any,
      ],
      totalBalance: 1_000,
    },
    { prisma: stub.prisma as any },
  );
  const [row] = stub.log.find((c) => c.type === "createMany")!.args;
  assert.equal("nonsense" in row, false);
});

// ============================================
// Empty snapshot — still must clear
// ============================================

test("persistHolderSnapshot deletes existing rows even when the new holders list is empty", async () => {
  // A token can drop to zero holders if every wallet sells out. The
  // dashboard must reflect that — we cannot leave stale rows behind.
  const { persistHolderSnapshot } = await import(
    "../services/persistHolderSnapshot.js"
  );
  const stub = makePrismaStub();
  stub.stored["tok_1"] = [
    { walletAddress: "Old", balance: 1, percentage: 100 },
  ];

  await persistHolderSnapshot(
    { tokenId: "tok_1", holders: [], totalBalance: 0 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(stub.stored["tok_1"], []);
});

test("persistHolderSnapshot skips createMany when holders list is empty", async () => {
  // Prisma's createMany rejects an empty data array. The transaction
  // still runs the deleteMany — but skip the createMany call.
  const { persistHolderSnapshot } = await import(
    "../services/persistHolderSnapshot.js"
  );
  const stub = makePrismaStub();
  await persistHolderSnapshot(
    { tokenId: "tok_1", holders: [], totalBalance: 0 },
    { prisma: stub.prisma as any },
  );
  const types = stub.log.map((c) => c.type);
  assert.deepEqual(types, ["transaction", "deleteMany"]);
});

// ============================================
// Error semantics
// ============================================

test("persistHolderSnapshot bubbles transaction errors so the indexer can label them", async () => {
  // The indexer wraps with `persist_holder_snapshot_failed`. Any
  // swallow here would leave a stale snapshot served by the dashboard.
  const { persistHolderSnapshot } = await import(
    "../services/persistHolderSnapshot.js"
  );
  const prisma = {
    async $transaction() {
      throw new Error("deadlock detected");
    },
  };
  await assert.rejects(
    persistHolderSnapshot(
      {
        tokenId: "tok_1",
        holders: [sampleHolder()],
        totalBalance: 1_000,
      },
      { prisma: prisma as any },
    ),
    /deadlock detected/,
  );
});
