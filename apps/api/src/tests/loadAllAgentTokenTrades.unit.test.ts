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

// Drives apps/api/src/services/loadAllAgentTokenTrades.ts — the
// production loadAllTrades closure for runTokenTradeIndexerTick.
//
// The indexer recomputes the holder snapshot from the FULL trade
// history on each tick (the snapshot is bulk-replaced in
// persistHolderSnapshot, so we need every trade to derive the
// distribution). No pagination — the indexer expects everything.
//
// Returns IndexerTradeRow[] (same shape as persistAgentTokenTrades
// writes), so the indexer's existing toHolderTrade() projector works.

interface FakeTrade {
  tokenId: string;
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  priceUsd: number;
  solLamports: bigint;
  tokenAmountRaw: bigint;
  timestamp: Date;
  // Schema-side columns the loader should drop:
  id: string;
  createdAt: Date;
}

function makePrismaStub(trades: FakeTrade[]) {
  const observed: { findManyArgs?: any } = {};
  return {
    observed,
    prisma: {
      agentTokenTrade: {
        async findMany({ where, orderBy }: any) {
          observed.findManyArgs = { where, orderBy };
          const matched = trades.filter((t) => t.tokenId === where.tokenId);
          if (orderBy?.timestamp === "asc") {
            return [...matched].sort(
              (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
            );
          }
          return matched;
        },
      },
    },
  };
}

const sampleTrade = (overrides: Partial<FakeTrade> = {}): FakeTrade => ({
  id: "row_1",
  tokenId: "tok_1",
  txSignature: "sig_a",
  traderAddress: "Alice",
  side: "buy",
  tokenAmount: 1_000,
  solAmount: 0.5,
  priceUsd: 0.001,
  solLamports: 500_000_000n,
  tokenAmountRaw: 1_000_000_000n,
  timestamp: new Date("2026-04-26T12:00:00Z"),
  createdAt: new Date("2026-04-26T12:01:00Z"),
  ...overrides,
});

// ============================================
// Scoping
// ============================================

test("loadAllAgentTokenTrades scopes the query by tokenId", async () => {
  setupEnv();
  const { loadAllAgentTokenTrades } = await import(
    "../services/loadAllAgentTokenTrades.js"
  );
  const stub = makePrismaStub([
    sampleTrade({ tokenId: "tok_1", txSignature: "a" }),
    sampleTrade({ tokenId: "tok_other", txSignature: "b" }),
  ]);
  const result = await loadAllAgentTokenTrades("tok_1", {
    prisma: stub.prisma as any,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.txSignature, "a");
  assert.equal(stub.observed.findManyArgs.where.tokenId, "tok_1");
});

test("loadAllAgentTokenTrades returns an empty array for a token with no trades", async () => {
  const { loadAllAgentTokenTrades } = await import(
    "../services/loadAllAgentTokenTrades.js"
  );
  const stub = makePrismaStub([]);
  const result = await loadAllAgentTokenTrades("tok_1", {
    prisma: stub.prisma as any,
  });
  assert.deepEqual(result, []);
});

// ============================================
// Order
// ============================================

test("loadAllAgentTokenTrades orders trades ascending by timestamp", async () => {
  // The pure holder-snapshot is order-agnostic, but ascending timestamp
  // is the natural default for debugging and any future order-dependent
  // analytics that read this same loader.
  const { loadAllAgentTokenTrades } = await import(
    "../services/loadAllAgentTokenTrades.js"
  );
  const stub = makePrismaStub([
    sampleTrade({ txSignature: "later", timestamp: new Date("2026-04-26T14:00:00Z") }),
    sampleTrade({ txSignature: "earlier", timestamp: new Date("2026-04-26T10:00:00Z") }),
  ]);
  const result = await loadAllAgentTokenTrades("tok_1", {
    prisma: stub.prisma as any,
  });
  assert.equal(stub.observed.findManyArgs.orderBy.timestamp, "asc");
  assert.deepEqual(
    result.map((r) => r.txSignature),
    ["earlier", "later"],
  );
});

// ============================================
// Field projection
// ============================================

test("loadAllAgentTokenTrades projects only the IndexerTradeRow contract (drops id, createdAt)", async () => {
  // toHolderTrade() in the indexer reads only traderAddress / side /
  // tokenAmountRaw / timestamp. The loader still needs txSignature,
  // solAmount/solLamports, tokenAmount/tokenAmountRaw, priceUsd because
  // that's the IndexerTradeRow shape (D9 added the integer raw columns) —
  // but `id` and `createdAt` are schema artifacts the indexer never sees
  // and shouldn't depend on.
  const { loadAllAgentTokenTrades } = await import(
    "../services/loadAllAgentTokenTrades.js"
  );
  const stub = makePrismaStub([sampleTrade()]);
  const result = await loadAllAgentTokenTrades("tok_1", {
    prisma: stub.prisma as any,
  });
  const [row] = result;
  assert.deepEqual(Object.keys(row!).sort(), [
    "priceUsd",
    "side",
    "solAmount",
    "solLamports",
    "timestamp",
    "tokenAmount",
    "tokenAmountRaw",
    "traderAddress",
    "txSignature",
  ]);
});

test("loadAllAgentTokenTrades narrows side to the buy|sell union", async () => {
  // Prisma stores side as String. The IndexerTradeRow type is
  // 'buy' | 'sell'. The loader must cast at the boundary; junk values
  // in the DB are an indexer bug, not a query-time concern.
  const { loadAllAgentTokenTrades } = await import(
    "../services/loadAllAgentTokenTrades.js"
  );
  const stub = makePrismaStub([
    sampleTrade({ side: "buy" }),
    sampleTrade({ side: "sell", txSignature: "sig_b" }),
  ]);
  const result = await loadAllAgentTokenTrades("tok_1", {
    prisma: stub.prisma as any,
  });
  assert.deepEqual(
    result.map((r) => r.side).sort(),
    ["buy", "sell"],
  );
});
