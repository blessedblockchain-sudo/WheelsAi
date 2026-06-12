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

// Drives apps/api/src/services/fetchTokenTradesSince.ts — the
// cursor-bounded paginated trade fetch (plan D7).
//
// The legacy indexer fetched a fixed last-20 page per tick — any token
// trading more than 20 times per interval silently lost trades. This
// helper pages newest-first until:
//   1. a page's oldest trade is at-or-before the cursor, or
//   2. a short page (upstream exhausted), or
//   3. the maxPages runaway bound.
//
// Rows at-or-before `since` are filtered out of the result.

interface RawTrade {
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  timestamp: string;
}

function trade(sig: string, timestamp: string): RawTrade {
  return {
    txSignature: sig,
    traderAddress: "Trader1",
    side: "buy",
    solAmount: 1,
    tokenAmount: 100,
    priceUsd: 0.01,
    timestamp,
  };
}

function makePagedDeps(pages: RawTrade[][], pageSize: number, maxPages?: number) {
  const calls: Array<{ limit: number; offset: number }> = [];
  return {
    calls,
    deps: {
      getTradesPage: async (_mint: string, limit: number, offset: number) => {
        calls.push({ limit, offset });
        const pageIndex = offset / limit;
        return pages[pageIndex] ?? [];
      },
      pageSize,
      maxPages,
    },
  };
}

const SINCE = new Date("2026-06-01T00:00:00Z");

// ============================================
// Filtering against the cursor
// ============================================

test("fetchTokenTradesSince returns only trades strictly newer than the cursor", async () => {
  setupEnv();
  const { fetchTokenTradesSince } = await import(
    "../services/fetchTokenTradesSince.js"
  );
  const { deps } = makePagedDeps(
    [
      [
        trade("new2", "2026-06-01T00:02:00Z"),
        trade("new1", "2026-06-01T00:01:00Z"),
        trade("at-cursor", "2026-06-01T00:00:00Z"),
        trade("older", "2026-05-31T23:59:00Z"),
      ],
    ],
    100,
  );
  const rows = await fetchTokenTradesSince(
    { mintAddress: "Mint1", since: SINCE },
    deps,
  );
  // At-or-before the cursor is excluded — the cursor row itself was
  // already persisted by the tick that set it.
  assert.deepEqual(
    rows.map((r) => r.txSignature),
    ["new2", "new1"],
  );
  // Raw upstream strings become Date objects for the indexer.
  assert.ok(rows[0]!.timestamp instanceof Date);
});

// ============================================
// Pagination until the cursor is reached
// ============================================

test("fetchTokenTradesSince paginates with growing offsets until a page reaches the cursor", async () => {
  const { fetchTokenTradesSince } = await import(
    "../services/fetchTokenTradesSince.js"
  );
  // Page size 2; newest-first. Page 0 and 1 are entirely newer than the
  // cursor; page 2 crosses it.
  const { deps, calls } = makePagedDeps(
    [
      [trade("t6", "2026-06-01T00:06:00Z"), trade("t5", "2026-06-01T00:05:00Z")],
      [trade("t4", "2026-06-01T00:04:00Z"), trade("t3", "2026-06-01T00:03:00Z")],
      [trade("t2", "2026-06-01T00:02:00Z"), trade("old", "2026-05-31T00:00:00Z")],
      [trade("never", "2026-05-30T00:00:00Z"), trade("never2", "2026-05-29T00:00:00Z")],
    ],
    2,
  );
  const rows = await fetchTokenTradesSince(
    { mintAddress: "Mint1", since: SINCE },
    deps,
  );
  assert.deepEqual(
    rows.map((r) => r.txSignature),
    ["t6", "t5", "t4", "t3", "t2"],
  );
  // Stopped after page 2 (which contained the cursor) — page 3 never fetched.
  assert.deepEqual(calls, [
    { limit: 2, offset: 0 },
    { limit: 2, offset: 2 },
    { limit: 2, offset: 4 },
  ]);
});

test("fetchTokenTradesSince stops on a short page (upstream exhausted)", async () => {
  const { fetchTokenTradesSince } = await import(
    "../services/fetchTokenTradesSince.js"
  );
  const { deps, calls } = makePagedDeps(
    [[trade("only", "2026-06-01T00:01:00Z")]], // 1 row < pageSize 2
    2,
  );
  const rows = await fetchTokenTradesSince(
    { mintAddress: "Mint1", since: SINCE },
    deps,
  );
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1);
});

test("fetchTokenTradesSince stops at the maxPages runaway bound", async () => {
  const { fetchTokenTradesSince } = await import(
    "../services/fetchTokenTradesSince.js"
  );
  // Every page is full and entirely newer than the cursor — without the
  // bound this would page forever on a pathological burst.
  const fullPage = (i: number) => [
    trade(`a${i}`, `2026-06-01T01:0${i}:00Z`),
    trade(`b${i}`, `2026-06-01T01:0${i}:30Z`),
  ];
  const { deps, calls } = makePagedDeps(
    [fullPage(1), fullPage(2), fullPage(3), fullPage(4), fullPage(5)],
    2,
    3, // maxPages
  );
  const rows = await fetchTokenTradesSince(
    { mintAddress: "Mint1", since: SINCE },
    deps,
  );
  assert.equal(calls.length, 3);
  assert.equal(rows.length, 6); // 3 pages × 2 rows
});

test("fetchTokenTradesSince defaults: page size 100, max 10 pages", async () => {
  const mod = await import("../services/fetchTokenTradesSince.js");
  assert.equal(mod.TRADE_FETCH_DEFAULT_PAGE_SIZE, 100);
  assert.equal(mod.TRADE_FETCH_DEFAULT_MAX_PAGES, 10);
});

// ============================================
// Empty + error propagation
// ============================================

test("fetchTokenTradesSince returns [] when the first page is empty", async () => {
  const { fetchTokenTradesSince } = await import(
    "../services/fetchTokenTradesSince.js"
  );
  const { deps } = makePagedDeps([[]], 100);
  const rows = await fetchTokenTradesSince(
    { mintAddress: "Mint1", since: SINCE },
    deps,
  );
  assert.deepEqual(rows, []);
});

test("fetchTokenTradesSince bubbles upstream throws (hardened client, no silent [])", async () => {
  const { fetchTokenTradesSince } = await import(
    "../services/fetchTokenTradesSince.js"
  );
  await assert.rejects(
    fetchTokenTradesSince(
      { mintAddress: "Mint1", since: SINCE },
      {
        getTradesPage: async () => {
          throw new Error("pumpfun 503");
        },
      },
    ),
    /pumpfun 503/,
  );
});
