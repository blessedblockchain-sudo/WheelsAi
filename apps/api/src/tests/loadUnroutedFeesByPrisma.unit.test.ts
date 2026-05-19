/**
 * Drives apps/api/src/services/loadUnroutedFeesByPrisma.ts —
 * Prisma-backed loader for the fee-router BullMQ worker.
 *
 * Returns one row per treasury that has unrouted volume since
 * `treasury.lastFeeRoutedAt` (or since creation if null).
 *
 * Eligibility:
 *   - treasury.programInitialized === true (legacy treasuries skipped;
 *     no on-chain target to route fees to)
 *   - at least one AgentTokenTrade with timestamp > lastFeeRoutedAt
 *
 * Aggregate per row:
 *   - sum(trade.solAmount) over the unrouted window
 *   - feeAmountLamports = floor(sumSolAmount * 0.01 * LAMPORTS_PER_SOL)
 *   - latestTradeTimestamp = max(trade.timestamp) (cursor advance target)
 *
 * Rounding: floor — never overpay the treasury. Sub-lamport residue
 * accumulates in the next window since the cursor advances to the
 * `latestTradeTimestamp` (which means newer trades after that point
 * are not included in this round but the residue is naturally
 * absorbed in subsequent rounds).
 */

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

interface FakeTrade {
  id: string;
  tokenId: string;
  solAmount: number; // SOL units (Prisma Float)
  timestamp: Date;
}

interface FakeTreasury {
  id: string;
  programInitialized: boolean;
  lastFeeRoutedAt: Date | null;
  token: {
    id: string;
    mintAddress: string;
  };
}

function makePrismaStub(opts: {
  treasuries?: FakeTreasury[];
  trades?: FakeTrade[];
}) {
  const observed: { findManyArgs?: any; tradeQueryArgs?: any[] } = {
    tradeQueryArgs: [],
  };
  return {
    observed,
    prisma: {
      agentTreasury: {
        async findMany(args: any) {
          observed.findManyArgs = args;
          let matched = (opts.treasuries ?? []).filter((t) => {
            if (
              args.where?.programInitialized !== undefined &&
              t.programInitialized !== args.where.programInitialized
            ) {
              return false;
            }
            return true;
          });
          return matched;
        },
      },
      agentTokenTrade: {
        async findMany(args: any) {
          observed.tradeQueryArgs!.push(args);
          let matched = (opts.trades ?? []).filter((tr) => {
            if (args.where?.tokenId && tr.tokenId !== args.where.tokenId) return false;
            if (args.where?.timestamp?.gt && tr.timestamp <= args.where.timestamp.gt)
              return false;
            return true;
          });
          if (args.orderBy?.timestamp === "asc") {
            matched = [...matched].sort(
              (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
            );
          }
          return matched;
        },
      },
    },
  };
}

const NOW = new Date("2026-04-26T12:00:00Z");

// ============================================
// Filter: programInitialized=true only
// ============================================

test("loadUnroutedFeesByPrisma scopes treasury query to programInitialized=true", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const stub = makePrismaStub({});
  await loadUnroutedFeesByPrisma(
    { now: NOW },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.findManyArgs.where.programInitialized, true);
});

// ============================================
// Aggregation
// ============================================

test("loadUnroutedFeesByPrisma aggregates sum(solAmount) * 0.01 → floor lamports", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        lastFeeRoutedAt: null,
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades: [
      // 1.5 SOL + 0.5 SOL = 2.0 SOL total volume; 1% = 0.02 SOL = 20_000_000 lamports
      {
        id: "t1",
        tokenId: "tok_a",
        solAmount: 1.5,
        timestamp: new Date("2026-04-26T11:30:00Z"),
      },
      {
        id: "t2",
        tokenId: "tok_a",
        solAmount: 0.5,
        timestamp: new Date("2026-04-26T11:45:00Z"),
      },
    ],
  });
  const result = await loadUnroutedFeesByPrisma(
    { now: NOW },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.treasuryId, "treas_a");
  assert.equal(result[0]!.mintAddress, "MintA");
  // 2.0 SOL * 0.01 = 0.02 SOL = 20_000_000 lamports
  assert.equal(result[0]!.feeAmountLamports, 20_000_000n);
});

test("loadUnroutedFeesByPrisma uses floor rounding (never overpays)", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        lastFeeRoutedAt: null,
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades: [
      // 1.234567899 SOL × 0.01 = 0.01234567899 SOL = 12_345_678.99 lamports
      // Floor → 12_345_678
      {
        id: "t1",
        tokenId: "tok_a",
        solAmount: 1.234567899,
        timestamp: new Date("2026-04-26T11:30:00Z"),
      },
    ],
  });
  const result = await loadUnroutedFeesByPrisma(
    { now: NOW },
    { prisma: stub.prisma as any },
  );
  assert.equal(result[0]!.feeAmountLamports, 12_345_678n);
});

// ============================================
// Cursor: trades > lastFeeRoutedAt
// ============================================

test("loadUnroutedFeesByPrisma uses lastFeeRoutedAt as the trade-window lower bound", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const cursor = new Date("2026-04-26T11:00:00Z");
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        lastFeeRoutedAt: cursor,
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades: [
      // Before cursor → excluded
      {
        id: "old",
        tokenId: "tok_a",
        solAmount: 100,
        timestamp: new Date("2026-04-26T10:00:00Z"),
      },
      // After cursor → included
      {
        id: "new",
        tokenId: "tok_a",
        solAmount: 1,
        timestamp: new Date("2026-04-26T11:30:00Z"),
      },
    ],
  });
  const result = await loadUnroutedFeesByPrisma(
    { now: NOW },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 1);
  // Just 1 SOL × 0.01 = 0.01 SOL = 10_000_000 lamports
  assert.equal(result[0]!.feeAmountLamports, 10_000_000n);
});

// ============================================
// Empty cases — no row emitted
// ============================================

test("loadUnroutedFeesByPrisma omits treasuries with zero unrouted trades", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        lastFeeRoutedAt: new Date("2026-04-26T11:00:00Z"),
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades: [], // none
  });
  const result = await loadUnroutedFeesByPrisma(
    { now: NOW },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, []);
});

test("loadUnroutedFeesByPrisma omits treasuries whose volume rounds to 0 lamports", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        lastFeeRoutedAt: null,
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades: [
      // 0.0000005 SOL × 0.01 = 5e-9 SOL = 5 lamports... actually 5 * 0.01 = 0.05 lamports → floor → 0
      // Let me recalculate: 5e-9 SOL = 5 lamports total, × 0.01 = 0.05 lamports → floor → 0.
      {
        id: "tiny",
        tokenId: "tok_a",
        solAmount: 5e-9,
        timestamp: new Date("2026-04-26T11:30:00Z"),
      },
    ],
  });
  const result = await loadUnroutedFeesByPrisma(
    { now: NOW },
    { prisma: stub.prisma as any },
  );
  // Sub-lamport fee → no point routing; row omitted.
  assert.deepEqual(result, []);
});

// ============================================
// Cursor advance target
// ============================================

test("loadUnroutedFeesByPrisma sets latestTradeTimestamp to the max of the included trades", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        lastFeeRoutedAt: null,
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades: [
      {
        id: "t1",
        tokenId: "tok_a",
        solAmount: 1,
        timestamp: new Date("2026-04-26T10:00:00Z"),
      },
      {
        id: "t2",
        tokenId: "tok_a",
        solAmount: 1,
        timestamp: new Date("2026-04-26T11:45:00Z"), // latest
      },
      {
        id: "t3",
        tokenId: "tok_a",
        solAmount: 1,
        timestamp: new Date("2026-04-26T11:00:00Z"),
      },
    ],
  });
  const result = await loadUnroutedFeesByPrisma(
    { now: NOW },
    { prisma: stub.prisma as any },
  );
  assert.equal(result[0]!.latestTradeTimestamp.toISOString(), "2026-04-26T11:45:00.000Z");
});
