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

// Drives apps/api/src/services/tokenTradeIndexer.ts — the orchestration
// layer the BullMQ token-indexer worker calls every N seconds per agent
// token. Pure orchestration; every IO surface is DI'd.
//
// Flow:
//   1. fetchTrades(mintAddress, since)  — pump.fun-style fetcher
//   2. persistTrades(newRows)           — upsert by txSignature, dedup
//   3. loadAllTrades(tokenId)           — for the holder recompute
//   4. computeHolderSnapshot(...)       — pure, already tested
//   5. persistHolderSnapshot(...)       — bulk replace holder rows
//   → { inserted, holderCount, totalBalance }
//
// The caller decides cadence + the `since` cursor; this orchestrator
// stays single-tick.

interface TradeRow {
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  priceUsd: number;
  timestamp: Date;
}

const trade = (
  sig: string,
  trader: string,
  side: "buy" | "sell",
  amount: number,
  hour = 0,
): TradeRow => ({
  txSignature: sig,
  traderAddress: trader,
  side,
  tokenAmount: amount,
  solAmount: amount * 0.000001,
  priceUsd: 0.001,
  timestamp: new Date(`2026-04-26T${String(12 + hour).padStart(2, "0")}:00:00Z`),
});

const NOW = new Date("2026-04-26T18:00:00Z");
const SINCE = new Date("2026-04-26T11:00:00Z");

const baseInput = (overrides: Partial<any> = {}) => ({
  token: { id: "tok_1", mintAddress: "MintAddr1" },
  since: SINCE,
  now: NOW,
  topN: 100,
  ...overrides,
});

interface CapturedCalls {
  fetchTradesCalls: Array<{ mint: string; since: Date }>;
  persistTradesCalls: TradeRow[][];
  loadAllTradesCalls: number;
  persistHolderSnapshotCalls: Array<{
    tokenId: string;
    holders: { walletAddress: string; balance: number; percentage: number }[];
    totalBalance: number;
  }>;
}

function happyDeps(opts: {
  newTrades?: TradeRow[];
  allTrades?: TradeRow[];
  insertedCount?: number;
}): CapturedCalls & { deps: any } {
  // One shared object so the closures' mutations are visible to test
  // assertions. (Spreading `captured` would copy primitive counters by
  // value and decouple them.)
  const harness: CapturedCalls & { deps: any } = {
    fetchTradesCalls: [],
    persistTradesCalls: [],
    loadAllTradesCalls: 0,
    persistHolderSnapshotCalls: [],
    deps: undefined as any,
  };
  harness.deps = {
    fetchTrades: async (mint: string, since: Date) => {
      harness.fetchTradesCalls.push({ mint, since });
      return opts.newTrades ?? [];
    },
    persistTrades: async (rows: TradeRow[]) => {
      harness.persistTradesCalls.push(rows);
      return { inserted: opts.insertedCount ?? rows.length };
    },
    loadAllTrades: async (_tokenId: string) => {
      harness.loadAllTradesCalls += 1;
      return opts.allTrades ?? opts.newTrades ?? [];
    },
    persistHolderSnapshot: async (args: any) => {
      harness.persistHolderSnapshotCalls.push(args);
    },
  };
  return harness;
}

// ============================================
// Empty new trades — short-circuit
// ============================================

test("runTokenTradeIndexerTick short-circuits when there are no new trades since the cursor", async () => {
  setupEnv();
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  const harness = happyDeps({ newTrades: [] });

  const result = await runTokenTradeIndexerTick(baseInput(), harness.deps);

  assert.equal(result.inserted, 0);
  // No persist or recompute calls — saves work on idle tokens.
  assert.equal(harness.persistTradesCalls.length, 0);
  assert.equal(harness.loadAllTradesCalls, 0);
  assert.equal(harness.persistHolderSnapshotCalls.length, 0);
});

// ============================================
// Fetch cursor
// ============================================

test("runTokenTradeIndexerTick passes (mintAddress, since) to fetchTrades", async () => {
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  const harness = happyDeps({ newTrades: [] });
  await runTokenTradeIndexerTick(baseInput(), harness.deps);
  assert.equal(harness.fetchTradesCalls.length, 1);
  assert.equal(harness.fetchTradesCalls[0]!.mint, "MintAddr1");
  assert.equal(
    harness.fetchTradesCalls[0]!.since.toISOString(),
    SINCE.toISOString(),
  );
});

// ============================================
// Happy path — full cycle
// ============================================

test("runTokenTradeIndexerTick persists new trades, recomputes holders, and persists the snapshot", async () => {
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  const newTrades = [
    trade("sig_1", "Alice", "buy", 100, 0),
    trade("sig_2", "Bob", "buy", 200, 1),
    trade("sig_3", "Alice", "sell", 50, 2),
  ];
  const harness = happyDeps({
    newTrades,
    allTrades: newTrades, // first run: all trades = new trades
  });
  const result = await runTokenTradeIndexerTick(baseInput(), harness.deps);

  // 3 new trades → all forwarded to persistTrades.
  assert.equal(harness.persistTradesCalls.length, 1);
  assert.equal(harness.persistTradesCalls[0]!.length, 3);

  // Holder recompute happened.
  assert.equal(harness.loadAllTradesCalls, 1);
  assert.equal(harness.persistHolderSnapshotCalls.length, 1);

  // Snapshot reflects: Alice 50, Bob 200 → Bob first.
  const snap = harness.persistHolderSnapshotCalls[0]!;
  assert.equal(snap.tokenId, "tok_1");
  assert.equal(snap.totalBalance, 250);
  assert.deepEqual(
    snap.holders.map((h) => h.walletAddress),
    ["Bob", "Alice"],
  );

  assert.equal(result.inserted, 3);
  assert.equal(result.holderCount, 2);
  assert.equal(result.totalBalance, 250);
});

// ============================================
// Dedup
// ============================================

test("runTokenTradeIndexerTick dedups duplicate txSignatures BEFORE persisting", async () => {
  // pump.fun's fetcher can return the same trade twice across overlapping
  // pages. The orchestrator should hand persistTrades a deduped list so
  // the DB layer doesn't have to.
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  const harness = happyDeps({
    newTrades: [
      trade("sig_dup", "Alice", "buy", 100, 0),
      trade("sig_dup", "Alice", "buy", 100, 0),
      trade("sig_2", "Bob", "buy", 50, 1),
    ],
  });
  await runTokenTradeIndexerTick(baseInput(), harness.deps);
  const persisted = harness.persistTradesCalls[0]!;
  const sigs = persisted.map((t) => t.txSignature);
  assert.deepEqual(sigs.sort(), ["sig_2", "sig_dup"]);
});

// ============================================
// Holder snapshot reflects FULL history, not just new trades
// ============================================

test("runTokenTradeIndexerTick recomputes holders against the FULL trade history (loadAllTrades)", async () => {
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  const newTrades = [trade("sig_new", "Eve", "buy", 100, 5)];
  const allTrades = [
    trade("sig_old1", "Alice", "buy", 1000, 0),
    trade("sig_old2", "Bob", "buy", 500, 1),
    ...newTrades,
  ];
  const harness = happyDeps({ newTrades, allTrades });
  await runTokenTradeIndexerTick(baseInput(), harness.deps);

  const snap = harness.persistHolderSnapshotCalls[0]!;
  assert.equal(snap.holders.length, 3);
  // Total includes everyone, not just the new buyer.
  assert.equal(snap.totalBalance, 1600);
});

// ============================================
// topN propagation
// ============================================

test("runTokenTradeIndexerTick honors a topN limit when persisting the holder snapshot", async () => {
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  const newTrades = [
    trade("s1", "A", "buy", 1000, 0),
    trade("s2", "B", "buy", 500, 0),
    trade("s3", "C", "buy", 100, 0),
    trade("s4", "D", "buy", 50, 0),
  ];
  const harness = happyDeps({ newTrades });
  await runTokenTradeIndexerTick(
    { ...baseInput(), topN: 2 },
    harness.deps,
  );
  const snap = harness.persistHolderSnapshotCalls[0]!;
  assert.equal(snap.holders.length, 2);
  // totalBalance is FULL float, not just top-2 — preserves true share.
  assert.equal(snap.totalBalance, 1650);
});

// ============================================
// Failure surfaces
// ============================================

test("runTokenTradeIndexerTick surfaces persistTrades failure with a labeled error and skips holder recompute", async () => {
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  let loadAllCalls = 0;
  const deps = {
    fetchTrades: async () => [trade("sig_1", "A", "buy", 100)],
    persistTrades: async () => {
      throw new Error("db down");
    },
    loadAllTrades: async () => {
      loadAllCalls += 1;
      return [];
    },
    persistHolderSnapshot: async () => {},
  };
  await assert.rejects(
    () => runTokenTradeIndexerTick(baseInput(), deps),
    /persist_trades_failed.*db down/,
  );
  // Holder recompute is skipped on persist failure (we'd recompute against
  // a stale view; better to leave the snapshot alone and retry next tick).
  assert.equal(loadAllCalls, 0);
});

test("runTokenTradeIndexerTick surfaces persistHolderSnapshot failure but keeps the trade insertions intact", async () => {
  // The trade insertions already committed on the previous step; the
  // failure is only in the snapshot persist. Surface as a labeled error
  // so the worker can log + retry the snapshot on the next tick, but the
  // trades aren't lost.
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  const deps = {
    fetchTrades: async () => [trade("sig_1", "A", "buy", 100)],
    persistTrades: async () => ({ inserted: 1 }),
    loadAllTrades: async () => [trade("sig_1", "A", "buy", 100)],
    persistHolderSnapshot: async () => {
      throw new Error("snapshot db down");
    },
  };
  await assert.rejects(
    () => runTokenTradeIndexerTick(baseInput(), deps),
    /persist_holder_snapshot_failed.*snapshot db down/,
  );
});

// ============================================
// Counts
// ============================================

test("runTokenTradeIndexerTick returns inserted = the count persistTrades reported (not raw input length)", async () => {
  // persistTrades may report fewer if it dedups against existing rows.
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  const harness = happyDeps({
    newTrades: [
      trade("s1", "A", "buy", 100),
      trade("s2", "B", "buy", 200),
    ],
    insertedCount: 1, // s1 was already in the DB; only s2 new
  });
  const result = await runTokenTradeIndexerTick(baseInput(), harness.deps);
  assert.equal(result.inserted, 1);
});
