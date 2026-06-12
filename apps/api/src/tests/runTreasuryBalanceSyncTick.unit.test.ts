/**
 * Drives apps/api/src/services/runTreasuryBalanceSyncTick.ts — the pure
 * scan-and-mirror driver for the D1 balance-sync step (remediation D1).
 *
 * Shape mirrors runFeeRouterTick:
 *   1. loadTreasuries()              → programInitialized rows (id + PDA)
 *   2. getRentReserveLamports()      → once per tick
 *   3. getBalances(pdas)             → lamports per PDA (null = not found)
 *   4. persistBalances(rows)         → solBalanceLamports + balanceSyncedAt
 *   5. counters {synced, failed}     → returned
 *
 * Per-row failure isolation: a PDA that fails base58 decoding is counted
 * failed without blocking the batch; a thrown getBalances fails the whole
 * batch and persists NOTHING (the settlement loader's staleness guard
 * turns that into "skip", never "pay on garbage data").
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

// Valid base58-encoded 32-byte addresses for PDA fixtures.
const PDA_A = "So11111111111111111111111111111111111111112";
const PDA_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PDA_C = "Vote111111111111111111111111111111111111111";

const NOW = new Date("2026-04-26T12:00:00Z");

interface TreasuryRow {
  treasuryId: string;
  treasuryPdaAddress: string;
}

function makeDeps(opts: {
  treasuries?: TreasuryRow[];
  balances?: (number | null)[];
  balancesThrow?: boolean;
  rentReserve?: bigint;
  persistShouldThrow?: boolean;
}) {
  const log: any[] = [];
  return {
    log,
    deps: {
      loadTreasuries: async () => {
        log.push({ type: "loadTreasuries" });
        return opts.treasuries ?? [];
      },
      getRentReserveLamports: async () => {
        log.push({ type: "getRentReserve" });
        return opts.rentReserve ?? 1_000_000n;
      },
      getBalances: async (pdas: unknown[]) => {
        log.push({ type: "getBalances", count: pdas.length });
        if (opts.balancesThrow) throw new Error("RPC down");
        return opts.balances ?? [];
      },
      persistBalances: async (rows: unknown[]) => {
        log.push({ type: "persistBalances", rows });
        if (opts.persistShouldThrow) throw new Error("persist failed");
      },
    },
  };
}

// ============================================
// Empty batch
// ============================================

test("runTreasuryBalanceSyncTick no-ops with zero counters on an empty batch", async () => {
  setupEnv();
  const { runTreasuryBalanceSyncTick } = await import(
    "../services/runTreasuryBalanceSyncTick.js"
  );
  const { log, deps } = makeDeps({ treasuries: [] });
  const result = await runTreasuryBalanceSyncTick({ now: NOW }, deps);
  assert.deepEqual(result, { synced: 0, failed: 0 });
  // Neither the RPC nor the persist layer is touched.
  assert.equal(log.filter((c) => c.type === "getBalances").length, 0);
  assert.equal(log.filter((c) => c.type === "persistBalances").length, 0);
});

// ============================================
// Spendable balance math
// ============================================

test("runTreasuryBalanceSyncTick persists lamports minus the rent reserve", async () => {
  const { runTreasuryBalanceSyncTick } = await import(
    "../services/runTreasuryBalanceSyncTick.js"
  );
  const { log, deps } = makeDeps({
    treasuries: [{ treasuryId: "t_1", treasuryPdaAddress: PDA_A }],
    balances: [5_000_000],
    rentReserve: 1_000_000n,
  });
  const result = await runTreasuryBalanceSyncTick({ now: NOW }, deps);
  assert.deepEqual(result, { synced: 1, failed: 0 });

  const persist = log.find((c) => c.type === "persistBalances")!;
  assert.equal(persist.rows.length, 1);
  assert.equal(persist.rows[0].treasuryId, "t_1");
  // Spendable = 5_000_000 - 1_000_000 rent reserve.
  assert.equal(persist.rows[0].solBalanceLamports, 4_000_000n);
  assert.equal(
    (persist.rows[0].syncedAt as Date).toISOString(),
    NOW.toISOString(),
  );
});

test("runTreasuryBalanceSyncTick clamps the spendable balance at 0 when lamports < rent reserve", async () => {
  // A PDA holding less than the rent-exempt minimum has NOTHING spendable
  // — draining below the reserve would deallocate the account. The mirror
  // must say 0, never go negative.
  const { runTreasuryBalanceSyncTick } = await import(
    "../services/runTreasuryBalanceSyncTick.js"
  );
  const { log, deps } = makeDeps({
    treasuries: [{ treasuryId: "t_low", treasuryPdaAddress: PDA_A }],
    balances: [400_000],
    rentReserve: 1_000_000n,
  });
  const result = await runTreasuryBalanceSyncTick({ now: NOW }, deps);
  assert.deepEqual(result, { synced: 1, failed: 0 });
  const persist = log.find((c) => c.type === "persistBalances")!;
  assert.equal(persist.rows[0].solBalanceLamports, 0n);
});

test("runTreasuryBalanceSyncTick syncs a null (non-existent) account as a fresh 0n mirror", async () => {
  // Account closed / never funded: the spendable balance is zero but the
  // mirror IS fresh — settlement must see 0n + a fresh balanceSyncedAt,
  // not skip-stale.
  const { runTreasuryBalanceSyncTick } = await import(
    "../services/runTreasuryBalanceSyncTick.js"
  );
  const { log, deps } = makeDeps({
    treasuries: [{ treasuryId: "t_gone", treasuryPdaAddress: PDA_B }],
    balances: [null],
  });
  const result = await runTreasuryBalanceSyncTick({ now: NOW }, deps);
  assert.deepEqual(result, { synced: 1, failed: 0 });
  const persist = log.find((c) => c.type === "persistBalances")!;
  assert.equal(persist.rows[0].solBalanceLamports, 0n);
  assert.equal(
    (persist.rows[0].syncedAt as Date).toISOString(),
    NOW.toISOString(),
  );
});

// ============================================
// Per-row failure isolation
// ============================================

test("runTreasuryBalanceSyncTick isolates a corrupt PDA: that row fails, the rest sync", async () => {
  const { runTreasuryBalanceSyncTick } = await import(
    "../services/runTreasuryBalanceSyncTick.js"
  );
  const { log, deps } = makeDeps({
    treasuries: [
      { treasuryId: "t_ok1", treasuryPdaAddress: PDA_A },
      { treasuryId: "t_bad", treasuryPdaAddress: "not-base58!!" },
      { treasuryId: "t_ok2", treasuryPdaAddress: PDA_C },
    ],
    balances: [3_000_000, 2_000_000],
    rentReserve: 1_000_000n,
  });
  const result = await runTreasuryBalanceSyncTick({ now: NOW }, deps);
  assert.deepEqual(result, { synced: 2, failed: 1 });

  const persist = log.find((c) => c.type === "persistBalances")!;
  assert.deepEqual(
    persist.rows.map((r: any) => r.treasuryId),
    ["t_ok1", "t_ok2"],
  );
  assert.deepEqual(
    persist.rows.map((r: any) => r.solBalanceLamports),
    [2_000_000n, 1_000_000n],
  );
});

test("runTreasuryBalanceSyncTick fails the whole batch and persists nothing when getBalances throws", async () => {
  // RPC down: counters report every parseable row failed and NO mirror
  // write happens — half-fresh timestamps over garbage balances would
  // defeat the staleness guard.
  const { runTreasuryBalanceSyncTick } = await import(
    "../services/runTreasuryBalanceSyncTick.js"
  );
  const { log, deps } = makeDeps({
    treasuries: [
      { treasuryId: "t_1", treasuryPdaAddress: PDA_A },
      { treasuryId: "t_2", treasuryPdaAddress: PDA_B },
    ],
    balancesThrow: true,
  });
  const result = await runTreasuryBalanceSyncTick({ now: NOW }, deps);
  assert.deepEqual(result, { synced: 0, failed: 2 });
  assert.equal(log.filter((c) => c.type === "persistBalances").length, 0);
});

test("runTreasuryBalanceSyncTick counts a short getBalances response as failed tail rows", async () => {
  // getBalances returned fewer entries than PDAs — guessing balances for
  // the missing tail is worse than failing them.
  const { runTreasuryBalanceSyncTick } = await import(
    "../services/runTreasuryBalanceSyncTick.js"
  );
  const { log, deps } = makeDeps({
    treasuries: [
      { treasuryId: "t_1", treasuryPdaAddress: PDA_A },
      { treasuryId: "t_2", treasuryPdaAddress: PDA_B },
    ],
    balances: [2_500_000],
    rentReserve: 500_000n,
  });
  const result = await runTreasuryBalanceSyncTick({ now: NOW }, deps);
  assert.deepEqual(result, { synced: 1, failed: 1 });
  const persist = log.find((c) => c.type === "persistBalances")!;
  assert.equal(persist.rows.length, 1);
  assert.equal(persist.rows[0].treasuryId, "t_1");
});

// ============================================
// Dep-call discipline
// ============================================

test("runTreasuryBalanceSyncTick fetches the rent reserve exactly once per tick", async () => {
  const { runTreasuryBalanceSyncTick } = await import(
    "../services/runTreasuryBalanceSyncTick.js"
  );
  const { log, deps } = makeDeps({
    treasuries: [
      { treasuryId: "t_1", treasuryPdaAddress: PDA_A },
      { treasuryId: "t_2", treasuryPdaAddress: PDA_B },
      { treasuryId: "t_3", treasuryPdaAddress: PDA_C },
    ],
    balances: [2_000_000, 2_000_000, 2_000_000],
  });
  await runTreasuryBalanceSyncTick({ now: NOW }, deps);
  assert.equal(log.filter((c) => c.type === "getRentReserve").length, 1);
});

test("runTreasuryBalanceSyncTick bubbles persistBalances failures", async () => {
  // A half-written mirror must not be reported as success — the worker
  // counts the throw and BullMQ retries.
  const { runTreasuryBalanceSyncTick } = await import(
    "../services/runTreasuryBalanceSyncTick.js"
  );
  const { deps } = makeDeps({
    treasuries: [{ treasuryId: "t_1", treasuryPdaAddress: PDA_A }],
    balances: [2_000_000],
    persistShouldThrow: true,
  });
  await assert.rejects(
    runTreasuryBalanceSyncTick({ now: NOW }, deps),
    /persist failed/,
  );
});
