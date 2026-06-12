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

// These tests drive services/treasurySettlement.ts — the pure orchestration
// layer that the BullMQ worker (coming in plan A3) will call on every tick.
//
// The settlement tick is split into pure decision-making (here) and side
// effects (submitTreasuryTx, persistComputePayment) which are dependency-
// injected. This lets us test every branch without Solana or Prisma.

const LAMPORTS_PER_SOL = 1_000_000_000n;

function baseDeployment(overrides: Partial<any> = {}) {
  return {
    id: "dep_1",
    orgId: "org_1",
    gpuTier: "4090",
    nosanaJobIds: ["job_a"],
    replicas: 1,
    agentTokenId: "token_1",
    ...overrides,
  };
}

function baseTreasury(overrides: Partial<any> = {}) {
  return {
    id: "treasury_1",
    tokenId: "token_1",
    treasuryPdaAddress: "PDA1111",
    solBalanceLamports: LAMPORTS_PER_SOL, // 1 SOL starting balance
    lastComputeBillAt: null as Date | null,
    ...overrides,
  };
}

// ============================================
// decideTreasurySettlement — single agent tick
// ============================================

test("decideTreasurySettlement charges for measured compute and schedules a payment", async () => {
  setupEnv();
  const { decideTreasurySettlement } = await import(
    "../services/treasurySettlement.js"
  );

  const deployment = baseDeployment();
  const treasury = baseTreasury();
  const now = new Date("2026-04-24T12:00:00Z");

  const result = await decideTreasurySettlement({
    deployment,
    treasury,
    now,
    intervalMs: 60 * 60 * 1000, // 1h
    getComputeCost: async () => ({
      computeSeconds: 3600,
      costUsd: 3600 * 0.00025, // 4090 tier = 0.9 USD
    }),
    solPriceUsd: 200, // 1 SOL = 200 USD → $0.9 = 0.0045 SOL = 4_500_000 lamports
  });

  assert.equal(result.action, "settle");
  assert.equal(result.computeSeconds, 3600);
  // 0.9 USD / 200 USD-per-SOL = 0.0045 SOL = 4_500_000 lamports
  assert.equal(result.amountLamports, 4_500_000n);
  // Treasury had 1 SOL = 1_000_000_000 lamports; enough to pay.
  assert.equal(result.insufficientFunds, false);
});

test("decideTreasurySettlement skips when interval has not elapsed", async () => {
  const { decideTreasurySettlement } = await import(
    "../services/treasurySettlement.js"
  );

  const deployment = baseDeployment();
  const treasury = baseTreasury({
    lastComputeBillAt: new Date("2026-04-24T11:30:00Z"), // 30min ago
  });
  const now = new Date("2026-04-24T12:00:00Z");

  const result = await decideTreasurySettlement({
    deployment,
    treasury,
    now,
    intervalMs: 60 * 60 * 1000,
    getComputeCost: async () => {
      throw new Error("getComputeCost should not be called when interval is not up");
    },
    solPriceUsd: 200,
  });

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "interval_not_elapsed");
});

test("decideTreasurySettlement flags insufficient funds instead of paying", async () => {
  const { decideTreasurySettlement } = await import(
    "../services/treasurySettlement.js"
  );

  const deployment = baseDeployment();
  const treasury = baseTreasury({
    solBalanceLamports: 1000n, // basically zero
  });
  const now = new Date("2026-04-24T12:00:00Z");

  const result = await decideTreasurySettlement({
    deployment,
    treasury,
    now,
    intervalMs: 60 * 60 * 1000,
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    solPriceUsd: 200,
  });

  assert.equal(result.action, "settle");
  assert.equal(result.insufficientFunds, true);
  assert.equal(result.amountLamports, 4_500_000n);
  assert.equal(result.treasuryBalanceLamports, 1000n);
});

test("decideTreasurySettlement skips when there is no measurable compute", async () => {
  const { decideTreasurySettlement } = await import(
    "../services/treasurySettlement.js"
  );

  const deployment = baseDeployment();
  const treasury = baseTreasury();
  const now = new Date("2026-04-24T12:00:00Z");

  const result = await decideTreasurySettlement({
    deployment,
    treasury,
    now,
    intervalMs: 60 * 60 * 1000,
    getComputeCost: async () => ({ computeSeconds: 0, costUsd: 0 }),
    solPriceUsd: 200,
  });

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "no_measurable_compute");
});

test("decideTreasurySettlement rejects a non-positive sol price", async () => {
  const { decideTreasurySettlement } = await import(
    "../services/treasurySettlement.js"
  );
  const now = new Date("2026-04-24T12:00:00Z");
  await assert.rejects(
    () =>
      decideTreasurySettlement({
        deployment: baseDeployment(),
        treasury: baseTreasury(),
        now,
        intervalMs: 60 * 60 * 1000,
        getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
        solPriceUsd: 0,
      }),
    /solPriceUsd/
  );
});

// ============================================
// decideTreasurySettlement — billing window (D2)
// ============================================

test("decideTreasurySettlement passes the [lastComputeBillAt, now] window to getComputeCost", async () => {
  const { decideTreasurySettlement } = await import(
    "../services/treasurySettlement.js"
  );

  const lastBill = new Date("2026-04-24T10:00:00Z");
  const now = new Date("2026-04-24T12:00:00Z");
  let observedWindow: any = null;
  await decideTreasurySettlement({
    deployment: baseDeployment(),
    treasury: baseTreasury({ lastComputeBillAt: lastBill }),
    now,
    intervalMs: 60 * 60 * 1000,
    getComputeCost: async (_deployment: any, window: any) => {
      observedWindow = window;
      return { computeSeconds: 3600, costUsd: 0.9 };
    },
    solPriceUsd: 200,
  });

  assert.equal(
    (observedWindow.start as Date).toISOString(),
    lastBill.toISOString(),
  );
  assert.equal((observedWindow.end as Date).toISOString(), now.toISOString());
});

test("decideTreasurySettlement uses a null window start for a never-billed treasury", async () => {
  // start: null = "no lower bound": the metering layer clamps to each
  // job's own start time.
  const { decideTreasurySettlement } = await import(
    "../services/treasurySettlement.js"
  );

  let observedWindow: any = null;
  await decideTreasurySettlement({
    deployment: baseDeployment(),
    treasury: baseTreasury({ lastComputeBillAt: null }),
    now: new Date("2026-04-24T12:00:00Z"),
    intervalMs: 60 * 60 * 1000,
    getComputeCost: async (_deployment: any, window: any) => {
      observedWindow = window;
      return { computeSeconds: 3600, costUsd: 0.9 };
    },
    solPriceUsd: 200,
  });

  assert.equal(observedWindow.start, null);
});

test("decideTreasurySettlement pins periodStart to the cursor and periodEnd to now", async () => {
  const { decideTreasurySettlement } = await import(
    "../services/treasurySettlement.js"
  );

  const lastBill = new Date("2026-04-24T10:00:00Z");
  const now = new Date("2026-04-24T12:00:00Z");
  const result = await decideTreasurySettlement({
    deployment: baseDeployment(),
    treasury: baseTreasury({ lastComputeBillAt: lastBill }),
    now,
    intervalMs: 60 * 60 * 1000,
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    solPriceUsd: 200,
  });

  assert.equal(result.action, "settle");
  if (result.action !== "settle") return;
  assert.equal(result.periodStart.toISOString(), lastBill.toISOString());
  assert.equal(result.periodEnd.toISOString(), now.toISOString());
});

test("decideTreasurySettlement pins the first-ever bill's periodStart to the epoch sentinel", async () => {
  // lastComputeBillAt null → the persisted row still needs a
  // deterministic, non-null periodStart so the composite unique key
  // (treasuryId, nosanaJobId, periodStart) dedupes a crash-replayed
  // first window.
  const { decideTreasurySettlement, FIRST_BILL_PERIOD_START } = await import(
    "../services/treasurySettlement.js"
  );

  const result = await decideTreasurySettlement({
    deployment: baseDeployment(),
    treasury: baseTreasury({ lastComputeBillAt: null }),
    now: new Date("2026-04-24T12:00:00Z"),
    intervalMs: 60 * 60 * 1000,
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    solPriceUsd: 200,
  });

  assert.equal(result.action, "settle");
  if (result.action !== "settle") return;
  assert.equal(result.periodStart.getTime(), FIRST_BILL_PERIOD_START.getTime());
  assert.equal(result.periodStart.getTime(), 0);
});

// ============================================
// runSettlementTick — orchestration over many agents
// ============================================

test("runSettlementTick writes a ComputePayment row for each agent that needs to settle", async () => {
  setupEnv();
  const { runSettlementTick } = await import("../services/treasurySettlement.js");

  const recorded: Array<{ treasuryId: string; amountLamports: bigint; status: string }> = [];

  const now = new Date("2026-04-24T12:00:00Z");
  const deployments = [
    { ...baseDeployment({ id: "dep_1", agentTokenId: "tok_1" }) },
    { ...baseDeployment({ id: "dep_2", agentTokenId: "tok_2" }) },
    // dep_3 has a recent bill — should skip
    {
      ...baseDeployment({ id: "dep_3", agentTokenId: "tok_3" }),
    },
  ];
  const treasuries = new Map([
    ["tok_1", baseTreasury({ id: "t_1", tokenId: "tok_1" })],
    ["tok_2", baseTreasury({ id: "t_2", tokenId: "tok_2" })],
    [
      "tok_3",
      baseTreasury({
        id: "t_3",
        tokenId: "tok_3",
        lastComputeBillAt: new Date("2026-04-24T11:30:00Z"),
      }),
    ],
  ]);

  await runSettlementTick({
    deployments,
    treasuries,
    now,
    intervalMs: 60 * 60 * 1000,
    solPriceUsd: 200,
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    recordComputePayment: async (p: any) => {
      recorded.push({
        treasuryId: p.treasuryId,
        amountLamports: p.amountLamports,
        status: p.status,
      });
    },
  });

  // Two due-for-settlement agents got rows; the third was skipped.
  assert.equal(recorded.length, 2);
  assert.deepEqual(
    recorded.map((r) => r.treasuryId).sort(),
    ["t_1", "t_2"]
  );
  assert.ok(recorded.every((r) => r.status === "PENDING"));
  assert.ok(recorded.every((r) => r.amountLamports === 4_500_000n));
});

test("runSettlementTick marks insufficient-funds agents as FAILED instead of PENDING", async () => {
  const { runSettlementTick } = await import("../services/treasurySettlement.js");
  const recorded: any[] = [];
  const now = new Date("2026-04-24T12:00:00Z");

  await runSettlementTick({
    deployments: [baseDeployment({ id: "dep_1", agentTokenId: "tok_1" })],
    treasuries: new Map([
      ["tok_1", baseTreasury({ id: "t_1", tokenId: "tok_1", solBalanceLamports: 1000n })],
    ]),
    now,
    intervalMs: 60 * 60 * 1000,
    solPriceUsd: 200,
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    recordComputePayment: async (p: any) => {
      recorded.push(p);
    },
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, "FAILED");
  assert.equal(recorded[0].errorMessage, "insufficient_funds");
});

test("runSettlementTick stamps the billing window onto every record — FAILED rows included", async () => {
  // D2 invariant: one bill row per window regardless of outcome. The
  // FAILED (insufficient_funds) row carries the same periodStart/
  // periodEnd as a PENDING one, because persistComputePayments advances
  // the treasury cursor off these bounds either way.
  const { runSettlementTick } = await import("../services/treasurySettlement.js");
  const recorded: any[] = [];
  const lastBill = new Date("2026-04-24T10:00:00Z");
  const now = new Date("2026-04-24T12:00:00Z");

  await runSettlementTick({
    deployments: [
      baseDeployment({ id: "dep_ok", agentTokenId: "tok_ok" }),
      baseDeployment({ id: "dep_broke", agentTokenId: "tok_broke" }),
    ],
    treasuries: new Map([
      [
        "tok_ok",
        baseTreasury({ id: "t_ok", tokenId: "tok_ok", lastComputeBillAt: lastBill }),
      ],
      [
        "tok_broke",
        baseTreasury({
          id: "t_broke",
          tokenId: "tok_broke",
          solBalanceLamports: 1000n,
          lastComputeBillAt: lastBill,
        }),
      ],
    ]),
    now,
    intervalMs: 60 * 60 * 1000,
    solPriceUsd: 200,
    getComputeCost: async () => ({ computeSeconds: 3600, costUsd: 0.9 }),
    recordComputePayment: async (p: any) => {
      recorded.push(p);
    },
  });

  assert.equal(recorded.length, 2);
  const statuses = recorded.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["FAILED", "PENDING"]);
  for (const r of recorded) {
    assert.equal((r.periodStart as Date).toISOString(), lastBill.toISOString());
    assert.equal((r.periodEnd as Date).toISOString(), now.toISOString());
  }
});
