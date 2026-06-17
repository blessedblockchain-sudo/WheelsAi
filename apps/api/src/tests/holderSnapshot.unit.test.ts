import assert from "node:assert/strict";
import test from "node:test";

import { tokensToRaw } from "../lib/tokenUnits.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/holderSnapshot.ts — pure aggregation that
// turns AgentTokenTrade rows into a current holder distribution. Used by:
//   - the dashboard's holder-distribution chart
//   - the public transparency page (/a/:slug)'s "top holders" panel
//
// The token indexer eventually seeds holders from on-chain account state,
// but the trade-history fallback is what powers the demo today and what
// pins the verifier semantics: anyone with the trade history can
// reconstruct the holder set deterministically.

interface FakeTrade {
  traderAddress: string;
  side: "buy" | "sell";
  // Money-path integer raw units (D9). The `t()` helper takes whole tokens
  // for readability and converts (× 1e6) so the balance/totalBalance
  // assertions below read in human units.
  tokenAmountRaw: bigint;
  timestamp: Date;
}

const t = (
  trader: string,
  side: "buy" | "sell",
  wholeTokens: number,
  hours = 0,
): FakeTrade => ({
  traderAddress: trader,
  side,
  tokenAmountRaw: tokensToRaw(wholeTokens),
  timestamp: new Date(`2026-04-26T${String(12 + hours).padStart(2, "0")}:00:00Z`),
});

// ============================================
// Empty + single-trade
// ============================================

test("computeHolderSnapshot returns an empty distribution for no trades", async () => {
  setupEnv();
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({ trades: [] });
  assert.deepEqual(result.holders, []);
  assert.equal(result.totalBalance, 0);
});

test("computeHolderSnapshot reports a single trader's full balance after one buy", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: [t("Alice", "buy", 1_000_000)],
  });
  assert.equal(result.holders.length, 1);
  assert.equal(result.holders[0]!.walletAddress, "Alice");
  // Integer raw units (1_000_000 tokens × 1e6) is the source of truth; the
  // Float `balance` is derived for display (D9).
  assert.equal(result.holders[0]!.balanceRaw, 1_000_000_000_000n);
  assert.equal(result.holders[0]!.balance, 1_000_000);
  assert.equal(result.holders[0]!.percentage, 100);
});

// ============================================
// Buy/sell math
// ============================================

test("computeHolderSnapshot zeros out a trader who bought-then-sold the same amount", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: [
      t("Bob", "buy", 500_000, 0),
      t("Bob", "sell", 500_000, 1),
      t("Alice", "buy", 1_000_000, 2),
    ],
  });
  // Bob's net is 0 — excluded from the holder list.
  assert.equal(result.holders.length, 1);
  assert.equal(result.holders[0]!.walletAddress, "Alice");
});

test("computeHolderSnapshot tracks net positions across multiple trades per trader", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: [
      t("Carol", "buy", 1_000_000, 0),
      t("Carol", "buy", 500_000, 1),
      t("Carol", "sell", 200_000, 2),
    ],
  });
  // 1_000_000 + 500_000 - 200_000 = 1_300_000
  assert.equal(result.holders.length, 1);
  assert.equal(result.holders[0]!.balance, 1_300_000);
});

test("computeHolderSnapshot ignores trades that would push a balance below zero (data-integrity guard)", async () => {
  // A bare sell-without-prior-buy can happen if the indexer joins late
  // and we miss the seed buy. The right behavior is to clamp to 0 rather
  // than emit a negative balance — a negative balance leaks into
  // percentage math and the dashboard renders nonsense.
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: [t("Dave", "sell", 500_000)], // no prior buy
  });
  assert.deepEqual(result.holders, []);
});

// ============================================
// Sorted + percentage
// ============================================

test("computeHolderSnapshot sorts holders by balance descending", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: [
      t("Alice", "buy", 100, 0),
      t("Bob", "buy", 1000, 0),
      t("Carol", "buy", 50, 0),
    ],
  });
  assert.deepEqual(
    result.holders.map((h) => h.walletAddress),
    ["Bob", "Alice", "Carol"],
  );
});

test("computeHolderSnapshot percentages sum to ~100 (within rounding)", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: [
      t("A", "buy", 333),
      t("B", "buy", 333),
      t("C", "buy", 334),
    ],
  });
  const sum = result.holders.reduce((acc, h) => acc + h.percentage, 0);
  assert.ok(
    Math.abs(sum - 100) < 0.0001,
    `expected percentages to sum to 100, got ${sum}`,
  );
});

test("computeHolderSnapshot rounds percentage to 4 decimal places for display", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: [
      t("A", "buy", 1),
      t("B", "buy", 2),
      t("C", "buy", 3), // 3/6 = 50.0; 1/6 = 16.6667; 2/6 = 33.3333
    ],
  });
  for (const h of result.holders) {
    const rounded = Math.round(h.percentage * 10_000) / 10_000;
    assert.equal(h.percentage, rounded, `percentage ${h.percentage} not 4dp`);
  }
});

// ============================================
// totalBalance
// ============================================

test("computeHolderSnapshot reports totalBalance = sum of net positive holdings", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: [
      t("A", "buy", 100),
      t("B", "buy", 200),
      t("C", "buy", 300),
      t("C", "sell", 50),
    ],
  });
  // 100 + 200 + 250 = 550
  assert.equal(result.totalBalance, 550);
});

// ============================================
// topN
// ============================================

test("computeHolderSnapshot honors topN cap and returns the top holders only", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: [
      t("A", "buy", 1000),
      t("B", "buy", 500),
      t("C", "buy", 100),
      t("D", "buy", 50),
      t("E", "buy", 10),
    ],
    topN: 3,
  });
  assert.deepEqual(
    result.holders.map((h) => h.walletAddress),
    ["A", "B", "C"],
  );
  // totalBalance is across the FULL set, not just the top — so
  // percentages on the truncated list still reflect the holder's true
  // share of the float.
  assert.equal(result.totalBalance, 1660);
  // A holds 1000/1660 ≈ 60.2410%
  assert.ok(
    Math.abs(result.holders[0]!.percentage - 60.2410) < 0.0005,
    `expected A's percentage ~60.241, got ${result.holders[0]!.percentage}`,
  );
});

test("computeHolderSnapshot defaults to no topN limit (return everyone)", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  const result = computeHolderSnapshot({
    trades: Array.from({ length: 50 }, (_, i) => t(`addr_${i}`, "buy", 1)),
  });
  assert.equal(result.holders.length, 50);
});

// ============================================
// Stability
// ============================================

test("computeHolderSnapshot is deterministic regardless of input trade order (sort stability for ties)", async () => {
  const { computeHolderSnapshot } = await import(
    "../services/holderSnapshot.js"
  );
  // Two traders with identical balance — ties broken by walletAddress asc
  // so reorderings of input still produce identical output.
  const a = computeHolderSnapshot({
    trades: [
      t("Alice", "buy", 100),
      t("Bob", "buy", 100),
      t("Carol", "buy", 100),
    ],
  });
  const b = computeHolderSnapshot({
    trades: [
      t("Carol", "buy", 100),
      t("Alice", "buy", 100),
      t("Bob", "buy", 100),
    ],
  });
  assert.deepEqual(
    a.holders.map((h) => h.walletAddress),
    b.holders.map((h) => h.walletAddress),
  );
  // Tie-break is alphabetical.
  assert.deepEqual(
    a.holders.map((h) => h.walletAddress),
    ["Alice", "Bob", "Carol"],
  );
});
