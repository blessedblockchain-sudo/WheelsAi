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

// Drives apps/api/src/services/ohlcBars.ts — pure aggregation that turns
// AgentTokenTrade rows into OHLC price bars for the per-agent chart.
//
// Convention:
//   - Bars are right-aligned to the interval grid in UTC (an hourly bar
//     starts at HH:00:00.000Z; a 5-minute bar starts at :00, :05, :10).
//   - Sparse output: empty intervals are not emitted (no forward-fill).
//     The frontend can interpolate if it wants a continuous chart.
//   - A trade exactly on the boundary belongs to the bar that STARTS at
//     that timestamp (closed-open: [start, start+interval)).

interface Trade {
  timestamp: Date;
  priceUsd: number;
  solAmount: number;
}

const t = (iso: string, priceUsd: number, solAmount = 0.1): Trade => ({
  timestamp: new Date(iso),
  priceUsd,
  solAmount,
});

const ONE_HOUR = 3600;
const FIVE_MIN = 300;

// ============================================
// Empty + single
// ============================================

test("aggregateOhlcBars returns [] for no trades", async () => {
  setupEnv();
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  const bars = aggregateOhlcBars({ trades: [], intervalSeconds: ONE_HOUR });
  assert.deepEqual(bars, []);
});

test("aggregateOhlcBars produces a single bar for a single trade with open=high=low=close=price", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  const bars = aggregateOhlcBars({
    trades: [t("2026-04-26T13:42:00Z", 0.005)],
    intervalSeconds: ONE_HOUR,
  });
  assert.equal(bars.length, 1);
  const b = bars[0]!;
  assert.equal(b.open, 0.005);
  assert.equal(b.high, 0.005);
  assert.equal(b.low, 0.005);
  assert.equal(b.close, 0.005);
  assert.equal(b.tradeCount, 1);
  // Bar boundary aligned to the hour (UTC).
  assert.equal(b.openTime.toISOString(), "2026-04-26T13:00:00.000Z");
  assert.equal(b.closeTime.toISOString(), "2026-04-26T14:00:00.000Z");
});

// ============================================
// Same-bar OHLC
// ============================================

test("aggregateOhlcBars computes OHLC correctly for multiple trades in the same bar", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  // Order: 0.001 (open) → 0.005 (high) → 0.0008 (low) → 0.003 (close)
  const bars = aggregateOhlcBars({
    trades: [
      t("2026-04-26T13:00:00Z", 0.001),
      t("2026-04-26T13:15:00Z", 0.005),
      t("2026-04-26T13:30:00Z", 0.0008),
      t("2026-04-26T13:45:00Z", 0.003),
    ],
    intervalSeconds: ONE_HOUR,
  });
  assert.equal(bars.length, 1);
  const b = bars[0]!;
  assert.equal(b.open, 0.001);
  assert.equal(b.high, 0.005);
  assert.equal(b.low, 0.0008);
  assert.equal(b.close, 0.003);
  assert.equal(b.tradeCount, 4);
});

// ============================================
// Multiple bars
// ============================================

test("aggregateOhlcBars emits one bar per non-empty interval, in chronological order", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  const bars = aggregateOhlcBars({
    trades: [
      t("2026-04-26T13:30:00Z", 1),
      t("2026-04-26T14:30:00Z", 2),
      t("2026-04-26T16:30:00Z", 3), // skip the 15:00 bar — sparse output
    ],
    intervalSeconds: ONE_HOUR,
  });
  assert.equal(bars.length, 3);
  assert.deepEqual(
    bars.map((b) => b.openTime.toISOString()),
    [
      "2026-04-26T13:00:00.000Z",
      "2026-04-26T14:00:00.000Z",
      "2026-04-26T16:00:00.000Z",
    ],
  );
});

// ============================================
// Volume + tradeCount
// ============================================

test("aggregateOhlcBars sums volumeSol across trades in the bar", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  const bars = aggregateOhlcBars({
    trades: [
      t("2026-04-26T13:00:00Z", 1, 0.5),
      t("2026-04-26T13:30:00Z", 2, 0.25),
      t("2026-04-26T13:45:00Z", 3, 0.1),
    ],
    intervalSeconds: ONE_HOUR,
  });
  assert.equal(bars[0]!.volumeSol, 0.85);
  assert.equal(bars[0]!.tradeCount, 3);
});

// ============================================
// Sort independence (determinism)
// ============================================

test("aggregateOhlcBars output is independent of input trade order", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  const trades = [
    t("2026-04-26T13:00:00Z", 0.001, 0.1),
    t("2026-04-26T13:15:00Z", 0.005, 0.2),
    t("2026-04-26T13:30:00Z", 0.0008, 0.05),
    t("2026-04-26T13:45:00Z", 0.003, 0.15),
  ];
  const ascending = aggregateOhlcBars({ trades, intervalSeconds: ONE_HOUR });
  const descending = aggregateOhlcBars({
    trades: [...trades].reverse(),
    intervalSeconds: ONE_HOUR,
  });
  const shuffled = aggregateOhlcBars({
    trades: [trades[2]!, trades[0]!, trades[3]!, trades[1]!],
    intervalSeconds: ONE_HOUR,
  });
  // Same OHLC + volume regardless of input order.
  assert.deepEqual(ascending, descending);
  assert.deepEqual(ascending, shuffled);
});

// ============================================
// Bar boundaries — different intervals
// ============================================

test("aggregateOhlcBars aligns 5-minute bars to :00, :05, :10, :15 (UTC)", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  const bars = aggregateOhlcBars({
    trades: [
      t("2026-04-26T13:02:00Z", 1), // bar 13:00–13:05
      t("2026-04-26T13:07:00Z", 2), // bar 13:05–13:10
      t("2026-04-26T13:09:00Z", 3), // bar 13:05–13:10
    ],
    intervalSeconds: FIVE_MIN,
  });
  assert.equal(bars.length, 2);
  assert.equal(bars[0]!.openTime.toISOString(), "2026-04-26T13:00:00.000Z");
  assert.equal(bars[0]!.closeTime.toISOString(), "2026-04-26T13:05:00.000Z");
  assert.equal(bars[1]!.openTime.toISOString(), "2026-04-26T13:05:00.000Z");
  assert.equal(bars[1]!.closeTime.toISOString(), "2026-04-26T13:10:00.000Z");
  assert.equal(bars[1]!.tradeCount, 2);
});

test("aggregateOhlcBars aligns 1-day bars to UTC midnight", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  const bars = aggregateOhlcBars({
    trades: [
      t("2026-04-26T15:00:00Z", 1),
      t("2026-04-26T23:30:00Z", 2),
      t("2026-04-27T01:00:00Z", 3),
    ],
    intervalSeconds: 86400,
  });
  assert.equal(bars.length, 2);
  assert.equal(bars[0]!.openTime.toISOString(), "2026-04-26T00:00:00.000Z");
  assert.equal(bars[1]!.openTime.toISOString(), "2026-04-27T00:00:00.000Z");
});

// ============================================
// Edge: trade exactly on boundary
// ============================================

test("aggregateOhlcBars assigns a trade exactly on the boundary to the bar STARTING at that timestamp (closed-open)", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  const bars = aggregateOhlcBars({
    trades: [
      t("2026-04-26T13:00:00.000Z", 1), // exactly on 13:00 boundary
      t("2026-04-26T13:30:00Z", 2),
    ],
    intervalSeconds: ONE_HOUR,
  });
  // Both belong to the 13:00–14:00 bar.
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.openTime.toISOString(), "2026-04-26T13:00:00.000Z");
  assert.equal(bars[0]!.tradeCount, 2);
  assert.equal(bars[0]!.open, 1);
  assert.equal(bars[0]!.close, 2);
});

// ============================================
// Validation
// ============================================

test("aggregateOhlcBars throws on non-positive intervalSeconds (caller bug)", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  for (const v of [0, -60, NaN]) {
    assert.throws(
      () => aggregateOhlcBars({ trades: [], intervalSeconds: v }),
      /intervalSeconds/i,
    );
  }
});

// ============================================
// Window filter (optional)
// ============================================

test("aggregateOhlcBars optionally filters trades to a [from, to] window", async () => {
  const { aggregateOhlcBars } = await import("../services/ohlcBars.js");
  const bars = aggregateOhlcBars({
    trades: [
      t("2026-04-25T13:00:00Z", 1), // before
      t("2026-04-26T13:00:00Z", 2), // inside
      t("2026-04-26T14:00:00Z", 3), // inside
      t("2026-04-27T13:00:00Z", 4), // after
    ],
    intervalSeconds: ONE_HOUR,
    from: new Date("2026-04-26T00:00:00Z"),
    to: new Date("2026-04-26T23:59:59Z"),
  });
  // Only the 2026-04-26 13:00 + 14:00 bars.
  assert.equal(bars.length, 2);
  assert.equal(bars[0]!.open, 2);
  assert.equal(bars[1]!.open, 3);
});
