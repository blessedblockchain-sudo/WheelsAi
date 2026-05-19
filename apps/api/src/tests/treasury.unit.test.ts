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

// These tests drive the shape of apps/api/src/services/treasury.ts — a pure
// helper layer consumed by the treasury-settlement worker (plan A3) and the
// runway dashboard card (plan A8). Everything here must be deterministic with
// no Solana, no Prisma, no network.

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ============================================
// calculateRunwaySeconds
// ============================================

test("calculateRunwaySeconds returns balance / per-second burn", async () => {
  setupEnv();
  const { calculateRunwaySeconds } = await import("../services/treasury.js");
  // 1 SOL treasury, burning 0.0001 SOL/second → 10,000 seconds runway
  const runway = calculateRunwaySeconds({
    solBalanceLamports: LAMPORTS_PER_SOL,
    burnRateLamportsPerSecond: LAMPORTS_PER_SOL / 10_000n,
  });
  assert.equal(runway, 10_000);
});

test("calculateRunwaySeconds returns Infinity when burn rate is zero", async () => {
  const { calculateRunwaySeconds } = await import("../services/treasury.js");
  const runway = calculateRunwaySeconds({
    solBalanceLamports: LAMPORTS_PER_SOL,
    burnRateLamportsPerSecond: 0n,
  });
  assert.equal(runway, Number.POSITIVE_INFINITY);
});

test("calculateRunwaySeconds returns 0 when balance is zero", async () => {
  const { calculateRunwaySeconds } = await import("../services/treasury.js");
  const runway = calculateRunwaySeconds({
    solBalanceLamports: 0n,
    burnRateLamportsPerSecond: 1000n,
  });
  assert.equal(runway, 0);
});

test("calculateRunwaySeconds clamps negatives (corrupt on-chain data) to 0", async () => {
  const { calculateRunwaySeconds } = await import("../services/treasury.js");
  const runway = calculateRunwaySeconds({
    solBalanceLamports: -100n,
    burnRateLamportsPerSecond: 1000n,
  });
  assert.equal(runway, 0);
});

// ============================================
// deriveRunwayAlertLevel
// ============================================

test("deriveRunwayAlertLevel classifies into healthy/warning/critical/expired", async () => {
  const { deriveRunwayAlertLevel } = await import("../services/treasury.js");
  const day = 86_400;
  // >14d → healthy
  assert.equal(deriveRunwayAlertLevel(15 * day), "healthy");
  assert.equal(deriveRunwayAlertLevel(14 * day + 1), "healthy");
  // 3d–14d → warning  (14d boundary is the warning side by design: "notify holders at 14d")
  assert.equal(deriveRunwayAlertLevel(14 * day), "warning");
  assert.equal(deriveRunwayAlertLevel(7 * day), "warning");
  assert.equal(deriveRunwayAlertLevel(3 * day + 1), "warning");
  // 0–3d → critical
  assert.equal(deriveRunwayAlertLevel(3 * day), "critical");
  assert.equal(deriveRunwayAlertLevel(day), "critical");
  assert.equal(deriveRunwayAlertLevel(1), "critical");
  // <=0 → expired
  assert.equal(deriveRunwayAlertLevel(0), "expired");
  assert.equal(deriveRunwayAlertLevel(-100), "expired");
});

test("deriveRunwayAlertLevel returns healthy for Infinity (no burn)", async () => {
  const { deriveRunwayAlertLevel } = await import("../services/treasury.js");
  assert.equal(deriveRunwayAlertLevel(Number.POSITIVE_INFINITY), "healthy");
});

// ============================================
// deriveDesiredReplicas
// ============================================

test("deriveDesiredReplicas scales up when runway is plush", async () => {
  const { deriveDesiredReplicas } = await import("../services/treasury.js");
  // Flush: runway > 90d and currentReplicas below cap → triple
  const r = deriveDesiredReplicas({
    runwaySeconds: 120 * 86_400,
    currentReplicas: 1,
    maxReplicas: 10,
  });
  assert.equal(r, 3);
});

test("deriveDesiredReplicas respects the max-replicas cap on scale-up", async () => {
  const { deriveDesiredReplicas } = await import("../services/treasury.js");
  const r = deriveDesiredReplicas({
    runwaySeconds: 120 * 86_400,
    currentReplicas: 5,
    maxReplicas: 6,
  });
  assert.equal(r, 6);
});

test("deriveDesiredReplicas halves when runway is below the warning threshold", async () => {
  const { deriveDesiredReplicas } = await import("../services/treasury.js");
  // <14d → halve (but floor at 1)
  const r = deriveDesiredReplicas({
    runwaySeconds: 10 * 86_400,
    currentReplicas: 4,
    maxReplicas: 10,
  });
  assert.equal(r, 2);
});

test("deriveDesiredReplicas floors at 1 when critically low", async () => {
  const { deriveDesiredReplicas } = await import("../services/treasury.js");
  const r = deriveDesiredReplicas({
    runwaySeconds: 86_400, // 1 day
    currentReplicas: 2,
    maxReplicas: 10,
  });
  assert.equal(r, 1);
});

test("deriveDesiredReplicas holds steady in the healthy middle", async () => {
  const { deriveDesiredReplicas } = await import("../services/treasury.js");
  // 15d–90d: no change
  const r = deriveDesiredReplicas({
    runwaySeconds: 30 * 86_400,
    currentReplicas: 2,
    maxReplicas: 10,
  });
  assert.equal(r, 2);
});

// ============================================
// shouldSettleNow
// ============================================

test("shouldSettleNow returns true when last settlement is older than interval", async () => {
  const { shouldSettleNow } = await import("../services/treasury.js");
  const now = new Date("2026-04-24T12:00:00Z");
  const last = new Date("2026-04-24T10:00:00Z"); // 2h ago
  assert.equal(shouldSettleNow({ lastSettledAt: last, intervalMs: 60 * 60 * 1000, now }), true);
});

test("shouldSettleNow returns false when last settlement is recent", async () => {
  const { shouldSettleNow } = await import("../services/treasury.js");
  const now = new Date("2026-04-24T12:00:00Z");
  const last = new Date("2026-04-24T11:30:00Z"); // 30min ago
  assert.equal(shouldSettleNow({ lastSettledAt: last, intervalMs: 60 * 60 * 1000, now }), false);
});

test("shouldSettleNow returns true when no prior settlement exists", async () => {
  const { shouldSettleNow } = await import("../services/treasury.js");
  const now = new Date("2026-04-24T12:00:00Z");
  assert.equal(shouldSettleNow({ lastSettledAt: null, intervalMs: 60 * 60 * 1000, now }), true);
});

// ============================================
// computeBurnRate
// ============================================

test("computeBurnRate lamports/second from a period of compute cost", async () => {
  const { computeBurnRate } = await import("../services/treasury.js");
  // 86400 seconds at $0.0001/sec → $8.64 day. At 200 USD/SOL → 0.0432 SOL/day.
  // We pass lamports/period and let it normalize.
  const rate = computeBurnRate({
    lamportsSpentInPeriod: LAMPORTS_PER_SOL,
    periodSeconds: 86_400,
  });
  assert.equal(rate, LAMPORTS_PER_SOL / 86_400n);
});

test("computeBurnRate returns 0n when the period is zero", async () => {
  const { computeBurnRate } = await import("../services/treasury.js");
  const rate = computeBurnRate({
    lamportsSpentInPeriod: 1000n,
    periodSeconds: 0,
  });
  assert.equal(rate, 0n);
});
