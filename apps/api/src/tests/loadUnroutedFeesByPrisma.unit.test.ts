/**
 * Drives apps/api/src/services/loadUnroutedFeesByPrisma.ts —
 * Prisma-backed loader for the fee-router BullMQ worker
 * (row identity, remediation D6a).
 *
 * Returns one row per treasury that has unrouted trades, where unrouted
 * means `feeRoutingBatchId IS NULL` — NOT a timestamp window.
 *
 * Eligibility:
 *   - treasury.programInitialized === true (legacy treasuries skipped;
 *     no on-chain target to route fees to)
 *   - at least one AgentTokenTrade with feeRoutingBatchId NULL
 *
 * Aggregate per row:
 *   - sum(trade.solAmount) over the unstamped trades (bounded by limit)
 *   - feeAmountLamports = floor(sumSolAmount * 0.01 * LAMPORTS_PER_SOL)
 *     (math UNCHANGED from the watermark-era loader — pinned below)
 *   - tradeIds = the claimed identities (the batch stamps exactly these)
 *   - latestTradeTimestamp = max(trade.timestamp) (display cursor target)
 *
 * Rounding: floor — never overpay the treasury. A sub-lamport batch is
 * NOT emitted, leaving its trades unstamped to accumulate with later
 * volume.
 *
 * REGRESSION (the D6a bug): a late-arriving trade — older timestamp,
 * inserted AFTER previous batches routed — is still NULL-stamped and
 * must be picked up by the next batch. The old `timestamp >
 * lastFeeRoutedAt` window silently excluded it forever.
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
  feeRoutingBatchId?: string | null;
}

interface FakeTreasury {
  id: string;
  programInitialized: boolean;
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
          const matched = (opts.treasuries ?? []).filter((t) => {
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
            // Row-identity predicate: only unstamped trades qualify.
            if (
              "feeRoutingBatchId" in (args.where ?? {}) &&
              args.where.feeRoutingBatchId === null &&
              (tr.feeRoutingBatchId ?? null) !== null
            )
              return false;
            return true;
          });
          if (args.orderBy?.timestamp === "asc") {
            matched = [...matched].sort(
              (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
            );
          }
          if (typeof args.take === "number") {
            matched = matched.slice(0, args.take);
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

test("loadUnroutedFeesByPrisma selects trades by feeRoutingBatchId IS NULL — never by timestamp", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades: [
      {
        id: "t1",
        tokenId: "tok_a",
        solAmount: 1,
        timestamp: new Date("2026-04-26T11:30:00Z"),
      },
    ],
  });
  await loadUnroutedFeesByPrisma({ now: NOW }, { prisma: stub.prisma as any });
  const tradeArgs = stub.observed.tradeQueryArgs![0];
  assert.equal(tradeArgs.where.feeRoutingBatchId, null);
  assert.equal(
    "timestamp" in tradeArgs.where,
    false,
    "the timestamp-watermark predicate must be gone (D6a)",
  );
});

// ============================================
// Aggregation — 1% lamports math pinned UNCHANGED (D9 owns Float fixes)
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
  // Row identity: the batch claims exactly these trades.
  assert.deepEqual(result[0]!.tradeIds, ["t1", "t2"]);
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
// REGRESSION: late-arriving trade joins the next batch (the D6a bug)
// ============================================

test("loadUnroutedFeesByPrisma picks up a late-arriving trade with an OLDER timestamp than already-routed ones", async () => {
  // Timeline: t_new (11:30) was routed by a previous batch. THEN the
  // at-least-once indexer delivered t_late with an OLDER timestamp
  // (10:00). Under the old `timestamp > lastFeeRoutedAt` watermark
  // (which sat at 11:30) t_late was permanently excluded — silent fee
  // leakage. Under row identity it is simply still unstamped.
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades: [
      {
        id: "t_routed",
        tokenId: "tok_a",
        solAmount: 100,
        timestamp: new Date("2026-04-26T11:30:00Z"),
        feeRoutingBatchId: "batch_prev", // already claimed+routed
      },
      {
        id: "t_late",
        tokenId: "tok_a",
        solAmount: 1,
        timestamp: new Date("2026-04-26T10:00:00Z"), // OLDER than t_routed
        feeRoutingBatchId: null,
      },
    ],
  });
  const result = await loadUnroutedFeesByPrisma(
    { now: NOW },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]!.tradeIds, ["t_late"]);
  // Only the late trade's volume: 1 SOL × 0.01 = 10_000_000 lamports.
  assert.equal(result[0]!.feeAmountLamports, 10_000_000n);
});

// ============================================
// Batch bound
// ============================================

test("loadUnroutedFeesByPrisma bounds the per-treasury batch via take=limit (oldest first)", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma, DEFAULT_FEE_BATCH_TRADE_LIMIT } =
    await import("../services/loadUnroutedFeesByPrisma.js");
  const trades: FakeTrade[] = [];
  for (let i = 0; i < 5; i += 1) {
    trades.push({
      id: `t${i}`,
      tokenId: "tok_a",
      solAmount: 1,
      timestamp: new Date(Date.UTC(2026, 3, 26, 11, i)),
    });
  }
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades,
  });
  const result = await loadUnroutedFeesByPrisma(
    { now: NOW, limit: 2 },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.tradeQueryArgs![0].take, 2);
  assert.deepEqual(result[0]!.tradeIds, ["t0", "t1"]); // oldest first
  // Default is the bounded 500 (D6a "keep batch size bounded").
  assert.equal(DEFAULT_FEE_BATCH_TRADE_LIMIT, 500);
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

test("loadUnroutedFeesByPrisma omits treasuries whose volume rounds to 0 lamports (trades stay unclaimed)", async () => {
  setupEnv();
  const { loadUnroutedFeesByPrisma } = await import(
    "../services/loadUnroutedFeesByPrisma.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        token: { id: "tok_a", mintAddress: "MintA" },
      },
    ],
    trades: [
      // 5e-9 SOL = 5 lamports total, × 0.01 = 0.05 lamports → floor → 0.
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
  // Sub-lamport fee → no batch; the trade stays NULL and accumulates
  // with later volume instead of being burned.
  assert.deepEqual(result, []);
});

// ============================================
// Display-cursor target
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
