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

// Drives apps/api/src/services/buildTreasurySettlementCycleDeps.ts —
// the dep-wiring closure for the BullMQ treasury-settlement worker.
//
// Combines:
//   loadSettlementBatchByPrisma(args, {prisma})  → loadBatch
//   persistComputePayments(records, {prisma})    → persistPayments
//   runTreasuryBalanceSyncTick + its deps        → syncBalances (when a
//                                                  connection is given, D1)
//   injected getComputeCost / getSolPriceUsd    (forwarded)
//   intervalMs from config                      (forwarded)
//
// The BullMQ shell is a thin pass-through; this builder is the
// testable surface where the production loaders are bound to the cycle.

function makePrismaStub() {
  const log: any[] = [];
  // persistComputePayments runs createMany + the cursor CAS inside one
  // $transaction; the stub hands the same client surface back so the
  // production writer works unchanged.
  const tx = {
    computePayment: {
      async createMany(args: any) {
        log.push({ type: "payment.createMany", args });
        return { count: args.data.length };
      },
    },
    agentTreasury: {
      async updateMany(args: any) {
        log.push({ type: "treasury.updateMany", args });
        return { count: 1 };
      },
    },
  };
  return {
    log,
    prisma: {
      agentDeployment: {
        async findMany(args: any) {
          log.push({ type: "deployment.findMany", args });
          return [];
        },
      },
      agentTreasury: {
        async findMany(args: any): Promise<any[]> {
          log.push({ type: "treasury.findMany", args });
          return [];
        },
        async updateMany(args: any) {
          log.push({ type: "treasury.updateMany", args });
          return { count: 1 };
        },
      },
      async $transaction(fn: (tx: any) => Promise<unknown>) {
        log.push({ type: "$transaction" });
        return fn(tx);
      },
    },
  };
}

// ============================================
// Build shape
// ============================================

test("buildTreasurySettlementCycleDeps returns a deps object with all required keys", async () => {
  setupEnv();
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: async () => ({
      computeSeconds: 0,
      costUsd: 0,
    }),
    getSolPriceUsd: async () => 100,
    intervalMs: 60_000,
  });
  // The cycle's contract: SettlementCycleDeps requires these keys.
  for (const key of [
    "loadBatch",
    "persistPayments",
    "getComputeCost",
    "getSolPriceUsd",
    "intervalMs",
  ]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
});

test("buildTreasurySettlementCycleDeps forwards intervalMs verbatim", async () => {
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 100,
    intervalMs: 12_345,
  });
  assert.equal(deps.intervalMs, 12_345);
});

// ============================================
// loadBatch wires through to loadSettlementBatchByPrisma
// ============================================

test("buildTreasurySettlementCycleDeps wires loadBatch to call prisma.agentDeployment.findMany", async () => {
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 100,
    intervalMs: 60_000,
  });
  await deps.loadBatch({ now: new Date(), intervalMs: 60_000 });
  // Exactly one findMany hit, scoped to running deployments.
  const calls = stub.log.filter((c) => c.type === "deployment.findMany");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args.where.status, "running");
});

test("buildTreasurySettlementCycleDeps loadBatch returns the cycle-shaped {deployments, treasuries}", async () => {
  // The cycle expects { deployments: [], treasuries: Map }. Validate
  // the structural contract — even when prisma returns no rows.
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 100,
    intervalMs: 60_000,
  });
  const batch = await deps.loadBatch({ now: new Date(), intervalMs: 60_000 });
  assert.ok(Array.isArray(batch.deployments));
  assert.ok(batch.treasuries instanceof Map);
});

// ============================================
// persistPayments wires through to persistComputePayments
// ============================================

test("buildTreasurySettlementCycleDeps wires persistPayments to prisma.computePayment.createMany", async () => {
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 100,
    intervalMs: 60_000,
  });
  await deps.persistPayments([
    {
      treasuryId: "treas_1",
      nosanaJobId: "job_1",
      amountLamports: 1_000_000n,
      computeSeconds: 3600,
      status: "PENDING",
      scheduledFor: new Date("2026-04-26T10:00:00Z"),
      periodStart: new Date("2026-04-26T09:00:00Z"),
      periodEnd: new Date("2026-04-26T10:00:00Z"),
    },
  ]);
  const calls = stub.log.filter((c) => c.type === "payment.createMany");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args.data.length, 1);
  // BigInt conversion of computeSeconds — the on-the-boundary detail
  // persistComputePayments handles for us.
  assert.equal(typeof calls[0]!.args.data[0].computeSeconds, "bigint");
  // D2: the write happens inside one $transaction together with the
  // billing-cursor CAS.
  assert.equal(stub.log.filter((c) => c.type === "$transaction").length, 1);
  const cas = stub.log.find((c) => c.type === "treasury.updateMany");
  assert.ok(cas, "expected the lastComputeBillAt cursor CAS");
  assert.equal(cas.args.where.id, "treas_1");
});

test("buildTreasurySettlementCycleDeps persistPayments is a no-op for an empty record list", async () => {
  // The cycle may emit a tick with no deployments to persist; the
  // wiring must not blow up on createMany with empty data.
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 100,
    intervalMs: 60_000,
  });
  await deps.persistPayments([]);
  assert.equal(
    stub.log.filter((c) => c.type === "payment.createMany").length,
    0,
  );
});

// ============================================
// Compute cost + SOL price are forwarded references
// ============================================

test("buildTreasurySettlementCycleDeps forwards getComputeCost as a callable reference", async () => {
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  let called = 0;
  let observedWindow: any = null;
  const myCost = async (_deployment: any, window: any) => {
    called += 1;
    observedWindow = window;
    return { computeSeconds: 99, costUsd: 7.5 };
  };
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: myCost,
    getSolPriceUsd: async () => 100,
    intervalMs: 60_000,
  });
  const window = { start: null, end: new Date("2026-04-26T12:00:00Z") };
  const result = await deps.getComputeCost({} as any, window);
  assert.equal(called, 1);
  // The billing window (D2) flows through untouched.
  assert.equal(observedWindow, window);
  assert.equal(result.computeSeconds, 99);
  assert.equal(result.costUsd, 7.5);
});

test("buildTreasurySettlementCycleDeps forwards getSolPriceUsd as a callable reference", async () => {
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  let called = 0;
  const myPrice = async () => {
    called += 1;
    return 142.5;
  };
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: myPrice,
    intervalMs: 60_000,
  });
  const price = await deps.getSolPriceUsd();
  assert.equal(called, 1);
  assert.equal(price, 142.5);
});

// ============================================
// D1: syncBalances composition
// ============================================

test("buildTreasurySettlementCycleDeps omits syncBalances when no connection is given", async () => {
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 100,
    intervalMs: 60_000,
  });
  assert.equal(deps.syncBalances, undefined);
});

test("buildTreasurySettlementCycleDeps composes syncBalances from the connection (D1 first-step)", async () => {
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const stub = makePrismaStub();
  // One program-initialized treasury with a valid PDA on chain.
  stub.prisma.agentTreasury.findMany = async (args: any) => {
    stub.log.push({ type: "treasury.findMany", args });
    return [
      {
        id: "treas_1",
        treasuryPdaAddress: "So11111111111111111111111111111111111111112",
      },
    ];
  };
  const connection = {
    async getMultipleAccountsInfo(pdas: unknown[]) {
      stub.log.push({ type: "rpc.getMultipleAccountsInfo", count: pdas.length });
      return pdas.map(() => ({ lamports: 5_000_000 }));
    },
    async getMinimumBalanceForRentExemption(space: number) {
      stub.log.push({ type: "rpc.getMinimumBalanceForRentExemption", space });
      return 1_000_000;
    },
  };

  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    connection: connection as any,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 100,
    intervalMs: 60_000,
  });

  assert.ok(deps.syncBalances, "expected syncBalances to be composed");
  const result = await deps.syncBalances!();
  assert.deepEqual(result, { synced: 1, failed: 0 });

  // The full D1 chain ran: load → rent reserve → RPC balances → mirror write.
  assert.equal(stub.log.filter((c) => c.type === "treasury.findMany").length, 1);
  assert.equal(
    stub.log.filter((c) => c.type === "rpc.getMultipleAccountsInfo").length,
    1,
  );
  const write = stub.log.find((c) => c.type === "treasury.updateMany");
  assert.ok(write, "expected the balance mirror write");
  assert.equal(write.args.where.id, "treas_1");
  // 5_000_000 lamports - 1_000_000 rent reserve.
  assert.equal(write.args.data.solBalanceLamports, 4_000_000n);
  assert.ok(write.args.data.balanceSyncedAt instanceof Date);
});

// ============================================
// End-to-end: feed built deps into the actual cycle
// ============================================

test("buildTreasurySettlementCycleDeps result drives runTreasurySettlementCycle without error on an empty batch", async () => {
  // The bootstrap's actual job: produce a deps object that the cycle
  // consumes cleanly. Run the cycle with the built deps; assert the
  // empty-batch result shape.
  const { buildTreasurySettlementCycleDeps } = await import(
    "../services/buildTreasurySettlementCycleDeps.js"
  );
  const { runTreasurySettlementCycle } = await import(
    "../services/treasurySettlementCycle.js"
  );
  const stub = makePrismaStub();
  const deps = buildTreasurySettlementCycleDeps({
    prisma: stub.prisma as any,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    getSolPriceUsd: async () => 100,
    intervalMs: 60_000,
  });
  const result = await runTreasurySettlementCycle(deps);
  assert.equal(result.loaded, 0);
  assert.equal(result.recorded, 0);
  assert.equal(result.errors, 0);
});
