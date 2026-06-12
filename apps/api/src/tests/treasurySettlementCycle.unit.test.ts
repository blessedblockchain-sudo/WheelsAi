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

// Drives apps/api/src/services/treasurySettlementCycle.ts — the orchestrator
// the BullMQ worker calls each tick. Loads the batch of (deployment, treasury)
// pairs that are due for settlement, fetches the SOL/USD price, runs the
// pure decision layer (treasurySettlement.runSettlementTick), and persists
// the resulting ComputePayment records in one batched write.
//
// Every IO surface is dependency-injected so this test never touches the
// DB, the Nosana SDK, or a price oracle.

const LAMPORTS_PER_SOL = 1_000_000_000n;

const baseDeployment = (overrides: Partial<any> = {}) => ({
  id: "dep_1",
  orgId: "org_1",
  gpuTier: "4090",
  nosanaJobIds: ["job_a"],
  replicas: 1,
  agentTokenId: "tok_1",
  ...overrides,
});

const baseTreasury = (overrides: Partial<any> = {}) => ({
  id: "treasury_1",
  tokenId: "tok_1",
  treasuryPdaAddress: "PDA",
  solBalanceLamports: LAMPORTS_PER_SOL,
  lastComputeBillAt: null as Date | null,
  ...overrides,
});

// ============================================
// Empty batch — no-op
// ============================================

test("runTreasurySettlementCycle returns zeros and persists nothing on an empty batch", async () => {
  setupEnv();
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  let persistCalls = 0;
  const result = await runTreasurySettlementCycle({
    loadBatch: async () => ({ deployments: [], treasuries: new Map() }),
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {
      persistCalls += 1;
    },
    now: new Date("2026-04-26T12:00:00Z"),
  });

  assert.equal(result.loaded, 0);
  assert.equal(result.recorded, 0);
  assert.equal(result.pending, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.errors, 0);
  // No persist call when there's nothing to write.
  assert.equal(persistCalls, 0);
});

// ============================================
// Load + tick + persist happy path
// ============================================

test("runTreasurySettlementCycle wires the tick output into a single batched persistPayments call", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  const persisted: any[][] = [];
  const result = await runTreasurySettlementCycle({
    loadBatch: async () => ({
      deployments: [
        baseDeployment({ id: "dep_1", agentTokenId: "tok_1" }),
        baseDeployment({ id: "dep_2", agentTokenId: "tok_2" }),
      ],
      treasuries: new Map([
        ["tok_1", baseTreasury({ id: "t_1", tokenId: "tok_1" })],
        ["tok_2", baseTreasury({ id: "t_2", tokenId: "tok_2" })],
      ]),
    }),
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async (records) => {
      persisted.push(records);
    },
    intervalMs: 60 * 60 * 1000,
    now: new Date("2026-04-26T12:00:00Z"),
  });

  assert.equal(result.loaded, 2);
  assert.equal(result.recorded, 2);
  assert.equal(result.pending, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.errors, 0);
  // Exactly one bulk write — not N writes.
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.length, 2);
});

test("runTreasurySettlementCycle counts pending vs failed (insufficient_funds) separately", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  const result = await runTreasurySettlementCycle({
    loadBatch: async () => ({
      deployments: [
        baseDeployment({ id: "dep_ok", agentTokenId: "tok_ok" }),
        baseDeployment({ id: "dep_broke", agentTokenId: "tok_broke" }),
      ],
      treasuries: new Map([
        ["tok_ok", baseTreasury({ id: "t_ok", tokenId: "tok_ok" })],
        // Treasury too small to cover $0.9 → 4_500_000 lamports
        [
          "tok_broke",
          baseTreasury({
            id: "t_broke",
            tokenId: "tok_broke",
            solBalanceLamports: 1_000n,
          }),
        ],
      ]),
    }),
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {},
    now: new Date("2026-04-26T12:00:00Z"),
  });

  assert.equal(result.loaded, 2);
  assert.equal(result.recorded, 2);
  assert.equal(result.pending, 1);
  assert.equal(result.failed, 1);
});

test("runTreasurySettlementCycle skips deployments whose interval has not elapsed and does not persist them", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  let persistedRecords: any[] = [];
  const result = await runTreasurySettlementCycle({
    loadBatch: async () => ({
      deployments: [baseDeployment({ id: "dep_recent", agentTokenId: "tok_r" })],
      treasuries: new Map([
        [
          "tok_r",
          baseTreasury({
            id: "t_r",
            tokenId: "tok_r",
            // Settled 30 minutes ago, interval is 60 min → still in cooldown
            lastComputeBillAt: new Date("2026-04-26T11:30:00Z"),
          }),
        ],
      ]),
    }),
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async (records) => {
      persistedRecords = records;
    },
    intervalMs: 60 * 60 * 1000,
    now: new Date("2026-04-26T12:00:00Z"),
  });

  assert.equal(result.loaded, 1);
  assert.equal(result.recorded, 0);
  assert.equal(persistedRecords.length, 0);
});

// ============================================
// Loader cutoff
// ============================================

test("runTreasurySettlementCycle calls loadBatch with the configured intervalMs and current time", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  let observed: any = null;
  await runTreasurySettlementCycle({
    loadBatch: async (args) => {
      observed = args;
      return { deployments: [], treasuries: new Map() };
    },
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {},
    intervalMs: 30 * 60 * 1000,
    now: new Date("2026-04-26T12:00:00Z"),
  });

  assert.equal(observed.intervalMs, 30 * 60 * 1000);
  assert.equal(
    (observed.now as Date).toISOString(),
    "2026-04-26T12:00:00.000Z",
  );
});

// ============================================
// Failure surfaces
// ============================================

test("runTreasurySettlementCycle short-circuits when the sol-price oracle throws", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  let computeCalls = 0;
  let persistCalls = 0;
  const result = await runTreasurySettlementCycle({
    loadBatch: async () => ({
      deployments: [baseDeployment()],
      treasuries: new Map([["tok_1", baseTreasury()]]),
    }),
    getComputeCost: async () => {
      computeCalls += 1;
      return { computeSeconds: 3600, costUsd: 0.9 };
    },
    getSolPriceUsd: async () => {
      throw new Error("oracle down");
    },
    persistPayments: async () => {
      persistCalls += 1;
    },
    now: new Date("2026-04-26T12:00:00Z"),
  });

  assert.equal(result.errors, 1);
  assert.equal(result.recorded, 0);
  // Cycle aborts before computing or persisting anything.
  assert.equal(computeCalls, 0);
  assert.equal(persistCalls, 0);
});

test("runTreasurySettlementCycle reports errors when persistPayments throws but still returns the in-memory tick counts", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  const result = await runTreasurySettlementCycle({
    loadBatch: async () => ({
      deployments: [baseDeployment()],
      treasuries: new Map([["tok_1", baseTreasury()]]),
    }),
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {
      throw new Error("db down");
    },
    now: new Date("2026-04-26T12:00:00Z"),
  });

  // The decision was made even though writing it failed.
  assert.equal(result.recorded, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.errors, 1);
});

// ============================================
// D1: balance sync first-step
// ============================================

test("runTreasurySettlementCycle runs syncBalances BEFORE loading the batch", async () => {
  // Ordering is the whole point: the loader's staleness guard reads
  // balanceSyncedAt, so the mirror refresh must happen first or every
  // treasury would be one tick stale.
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  const calls: string[] = [];
  await runTreasurySettlementCycle({
    syncBalances: async () => {
      calls.push("syncBalances");
      return { synced: 3, failed: 0 };
    },
    loadBatch: async () => {
      calls.push("loadBatch");
      return { deployments: [], treasuries: new Map() };
    },
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {},
    now: new Date("2026-04-26T12:00:00Z"),
  });

  assert.deepEqual(calls, ["syncBalances", "loadBatch"]);
});

test("runTreasurySettlementCycle counts a syncBalances throw as an error but still runs the cycle", async () => {
  // Sync failure degrades to "stale → skip" via the loader guard; it
  // must never abort settlement for treasuries whose mirror is still
  // fresh from a previous tick.
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  let persisted: any[] = [];
  const result = await runTreasurySettlementCycle({
    syncBalances: async () => {
      throw new Error("RPC down");
    },
    loadBatch: async () => ({
      deployments: [baseDeployment()],
      treasuries: new Map([["tok_1", baseTreasury()]]),
    }),
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async (records) => {
      persisted = records;
    },
    now: new Date("2026-04-26T12:00:00Z"),
  });

  assert.equal(result.errors, 1);
  // The cycle still settled the (fresh-mirrored) batch the loader returned.
  assert.equal(result.recorded, 1);
  assert.equal(persisted.length, 1);
});

test("runTreasurySettlementCycle works without syncBalances (injectable, optional for tests)", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );
  const result = await runTreasurySettlementCycle({
    loadBatch: async () => ({ deployments: [], treasuries: new Map() }),
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {},
    now: new Date("2026-04-26T12:00:00Z"),
  });
  assert.equal(result.errors, 0);
});

test("runTreasurySettlementCycle surfaces the loader's skippedStale counter", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );
  const result = await runTreasurySettlementCycle({
    loadBatch: async () => ({
      deployments: [],
      treasuries: new Map(),
      skippedStale: 4,
    }),
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {},
    now: new Date("2026-04-26T12:00:00Z"),
  });
  assert.equal(result.skippedStale, 4);
  // Batches from stubs that predate the guard default to 0.
  const legacy = await runTreasurySettlementCycle({
    loadBatch: async () => ({ deployments: [], treasuries: new Map() }),
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {},
    now: new Date("2026-04-26T12:00:00Z"),
  });
  assert.equal(legacy.skippedStale, 0);
});

// ============================================
// D2: billing window plumbed into getComputeCost
// ============================================

test("runTreasurySettlementCycle passes the treasury's billing window to getComputeCost", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  const lastBill = new Date("2026-04-26T10:00:00Z");
  const now = new Date("2026-04-26T12:00:00Z");
  const windows: any[] = [];
  await runTreasurySettlementCycle({
    loadBatch: async () => ({
      deployments: [baseDeployment()],
      treasuries: new Map([
        ["tok_1", baseTreasury({ lastComputeBillAt: lastBill })],
      ]),
    }),
    getComputeCost: async (_deployment, window) => {
      windows.push(window);
      return { computeSeconds: 3600, costUsd: 0.9 };
    },
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {},
    intervalMs: 60 * 60 * 1000,
    now,
  });

  assert.equal(windows.length, 1);
  // Delta billing: window = [lastComputeBillAt, now].
  assert.equal(
    (windows[0].start as Date).toISOString(),
    lastBill.toISOString(),
  );
  assert.equal((windows[0].end as Date).toISOString(), now.toISOString());
});

test("runTreasurySettlementCycle persists records carrying the billing window bounds", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  const now = new Date("2026-04-26T12:00:00Z");
  let persisted: any[] = [];
  await runTreasurySettlementCycle({
    loadBatch: async () => ({
      deployments: [baseDeployment()],
      treasuries: new Map([["tok_1", baseTreasury()]]),
    }),
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async (records) => {
      persisted = records;
    },
    intervalMs: 60 * 60 * 1000,
    now,
  });

  assert.equal(persisted.length, 1);
  // Never-billed treasury: periodStart pins to the epoch sentinel so the
  // composite unique key dedupes a replayed first window.
  assert.equal((persisted[0].periodStart as Date).getTime(), 0);
  assert.equal(
    (persisted[0].periodEnd as Date).toISOString(),
    now.toISOString(),
  );
});

// ============================================
// Defaults
// ============================================

test("runTreasurySettlementCycle defaults intervalMs to 1 hour and now to wall clock", async () => {
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );

  let observed: any = null;
  await runTreasurySettlementCycle({
    loadBatch: async (args) => {
      observed = args;
      return { deployments: [], treasuries: new Map() };
    },
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 200,
    persistPayments: async () => {},
  });

  assert.equal(observed.intervalMs, 60 * 60 * 1000);
  assert.ok(observed.now instanceof Date);
});
