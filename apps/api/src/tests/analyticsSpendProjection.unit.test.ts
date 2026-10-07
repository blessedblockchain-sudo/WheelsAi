import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

// projectMonthlyCost (services/analytics.ts): month-to-date spend must include
// the per-second GPU charges of dedicated deployments. Their /v1 requests record
// a ZERO per-token cost (the GPU is what is billed), so usage records alone
// showed an org paying $0.90/hour for a 4090 as spending nothing.

async function withDb(
  usageCostCents: bigint[],
  gpuUsageSumCents: bigint | null,
  run: (seen: { aggregateArgs: any[] }) => Promise<void>,
) {
  const { prisma } = await import("@wheelsai/db");
  const seen = { aggregateArgs: [] as any[] };
  const saved = { usageRecord: (prisma as any).usageRecord, creditTransaction: (prisma as any).creditTransaction };
  (prisma as any).usageRecord = {
    findMany: async () => usageCostCents.map((costCents) => ({ costCents })),
  };
  (prisma as any).creditTransaction = {
    aggregate: async (args: any) => {
      seen.aggregateArgs.push(args);
      return { _sum: { amountCents: gpuUsageSumCents } };
    },
  };
  try {
    await run(seen);
  } finally {
    Object.assign(prisma as any, saved);
  }
}

test("an org whose traffic all goes to a dedicated deployment shows its GPU spend, not $0", async () => {
  const { projectMonthlyCost } = await import("../services/analytics.js");
  // Every request recorded costCents 0; the worker debited 21.60 this month.
  await withDb([0n, 0n, 0n], -2160n, async (seen) => {
    const projection = await projectMonthlyCost("org_1");
    assert.equal(projection.currentSpend, 2160);
    assert.ok(projection.projectedSpend >= 2160);
    assert.ok(projection.dailyAverage > 0);

    const where = seen.aggregateArgs[0].where;
    assert.equal(where.orgId, "org_1", "tenant-scoped");
    assert.deepEqual(
      where.type,
      { in: ["gpu_usage", "training_usage"] },
      "GPU-time debits only (deployments and fine-tuning runs): per-token charges are already in the usage records",
    );
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    assert.deepEqual(where.createdAt, { gte: startOfMonth }, "the same period as the usage records");
  });
});

test("per-token spend and GPU spend add up; no GPU rows means the per-token total alone", async () => {
  const { projectMonthlyCost } = await import("../services/analytics.js");
  await withDb([120n, 30n], -500n, async () => {
    assert.equal((await projectMonthlyCost("org_1")).currentSpend, 650);
  });
  await withDb([120n, 30n], null, async () => {
    assert.equal((await projectMonthlyCost("org_1")).currentSpend, 150);
  });
});
