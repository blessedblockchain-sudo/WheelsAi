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
