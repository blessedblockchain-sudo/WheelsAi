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

// Drives apps/api/src/services/loadUsageRecordsForReputation.ts — the
// last data dependency of the A4 publisher worker. Resolves:
//
//   Agent (id + orgId)
//     → agent.deployments (AgentDeployment[].modelDeploymentId)
//   UsageRecord
//     where deploymentId ∈ (model deployment ids)
//       AND orgId = orgId
//       AND record overlaps [periodStart, periodEnd]
//   → returns rows in the UsageRecordForAggregation shape

const PERIOD_START = new Date("2026-04-26T12:00:00Z");
const PERIOD_END = new Date("2026-04-27T12:00:00Z");

interface FakeAgent {
  id: string;
  orgId: string;
  deployments: Array<{
    status: string;
    modelDeploymentId: string | null;
  }>;
}

interface FakeUsageRow {
  deploymentId: string;
  orgId: string;
  periodStart: Date;
  periodEnd: Date;
  requestCount: number;
  errorCount: number;
  computeSeconds: bigint;
}

function makePrismaStub(opts: {
  agents: FakeAgent[];
  rows?: FakeUsageRow[];
}) {
  const observed: { agentArgs?: any; usageArgs?: any } = {};
  return {
    observed,
    prisma: {
      agent: {
        async findFirst({ where, include }: any) {
          observed.agentArgs = { where, include };
          return (
            opts.agents.find(
              (a) => a.id === where.id && a.orgId === where.orgId,
            ) ?? null
          );
        },
      },
      usageRecord: {
        async findMany({ where, select }: any) {
          observed.usageArgs = { where, select };
          const ids = new Set<string>(where.deploymentId?.in ?? []);
          const periodEndGte: Date | undefined = where.periodEnd?.gte;
          const periodStartLt: Date | undefined = where.periodStart?.lt;
          return (opts.rows ?? []).filter((r) => {
            if (!ids.has(r.deploymentId)) return false;
            if (r.orgId !== where.orgId) return false;
            if (periodEndGte && r.periodEnd < periodEndGte) return false;
            if (periodStartLt && r.periodStart >= periodStartLt) return false;
            return true;
          });
        },
      },
    },
  };
}

const baseAgent: FakeAgent = {
  id: "agent_1",
  orgId: "org_1",
  deployments: [
    { status: "running", modelDeploymentId: "model_dep_1" },
  ],
};

// ============================================
// Lookup + scoping
// ============================================

test("loadUsageRecordsForReputation returns [] when agent not found", async () => {
  setupEnv();
  const { loadUsageRecordsForReputation } = await import(
    "../services/loadUsageRecordsForReputation.js"
  );
  const stub = makePrismaStub({ agents: [] });
  const result = await loadUsageRecordsForReputation(
    {
      agentId: "missing",
      orgId: "org_1",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, []);
});

test("loadUsageRecordsForReputation scopes by orgId — wrong org returns []", async () => {
  const { loadUsageRecordsForReputation } = await import(
    "../services/loadUsageRecordsForReputation.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, orgId: "org_other" }],
  });
  const result = await loadUsageRecordsForReputation(
    {
      agentId: "agent_1",
      orgId: "org_1",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, []);
  assert.equal(stub.observed.agentArgs.where.orgId, "org_1");
});

// ============================================
// Empty-set short-circuit
// ============================================

test("loadUsageRecordsForReputation returns [] when the agent has no deployments at all", async () => {
  const { loadUsageRecordsForReputation } = await import(
    "../services/loadUsageRecordsForReputation.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, deployments: [] }],
  });
  const result = await loadUsageRecordsForReputation(
    {
      agentId: "agent_1",
      orgId: "org_1",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, []);
  // Don't issue a deploymentId IN () query.
  assert.equal(stub.observed.usageArgs, undefined);
});

test("loadUsageRecordsForReputation skips deployments whose modelDeploymentId is null", async () => {
  const { loadUsageRecordsForReputation } = await import(
    "../services/loadUsageRecordsForReputation.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        deployments: [
          { status: "running", modelDeploymentId: "model_1" },
          { status: "running", modelDeploymentId: null },
        ],
      },
    ],
  });
  await loadUsageRecordsForReputation(
    {
      agentId: "agent_1",
      orgId: "org_1",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    { prisma: stub.prisma as any },
  );
  const ids = stub.observed.usageArgs.where.deploymentId.in;
  assert.deepEqual(ids, ["model_1"]);
});

// ============================================
// Happy path
// ============================================

test("loadUsageRecordsForReputation returns rows in the UsageRecordForAggregation shape", async () => {
  const { loadUsageRecordsForReputation } = await import(
    "../services/loadUsageRecordsForReputation.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    rows: [
      {
        deploymentId: "model_dep_1",
        orgId: "org_1",
        periodStart: new Date("2026-04-26T13:00:00Z"),
        periodEnd: new Date("2026-04-26T14:00:00Z"),
        requestCount: 100,
        errorCount: 1,
        computeSeconds: 3600n,
      },
    ],
  });
  const result = await loadUsageRecordsForReputation(
    {
      agentId: "agent_1",
      orgId: "org_1",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.requestCount, 100);
  assert.equal(result[0]!.errorCount, 1);
  assert.equal(result[0]!.computeSeconds, 3600n);
});

// ============================================
// Period filtering
// ============================================

test("loadUsageRecordsForReputation filters records BEFORE the window", async () => {
  const { loadUsageRecordsForReputation } = await import(
    "../services/loadUsageRecordsForReputation.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    rows: [
      // Ends BEFORE period starts → excluded
      {
        deploymentId: "model_dep_1",
        orgId: "org_1",
        periodStart: new Date("2026-04-25T10:00:00Z"),
        periodEnd: new Date("2026-04-25T11:00:00Z"),
        requestCount: 9999,
        errorCount: 0,
        computeSeconds: 1n,
      },
    ],
  });
  const result = await loadUsageRecordsForReputation(
    {
      agentId: "agent_1",
      orgId: "org_1",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, []);
});

test("loadUsageRecordsForReputation filters records AFTER the window", async () => {
  const { loadUsageRecordsForReputation } = await import(
    "../services/loadUsageRecordsForReputation.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    rows: [
      // Starts at or after periodEnd → excluded
      {
        deploymentId: "model_dep_1",
        orgId: "org_1",
        periodStart: new Date("2026-04-27T13:00:00Z"),
        periodEnd: new Date("2026-04-27T14:00:00Z"),
        requestCount: 9999,
        errorCount: 0,
        computeSeconds: 1n,
      },
    ],
  });
  const result = await loadUsageRecordsForReputation(
    {
      agentId: "agent_1",
      orgId: "org_1",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, []);
});

test("loadUsageRecordsForReputation passes the right WHERE clauses to the SQL boundary", async () => {
  const { loadUsageRecordsForReputation } = await import(
    "../services/loadUsageRecordsForReputation.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent] });
  await loadUsageRecordsForReputation(
    {
      agentId: "agent_1",
      orgId: "org_1",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    { prisma: stub.prisma as any },
  );
  // periodEnd >= periodStart  AND  periodStart < periodEnd  → strict overlap
  assert.equal(stub.observed.usageArgs.where.orgId, "org_1");
  assert.deepEqual(stub.observed.usageArgs.where.deploymentId, {
    in: ["model_dep_1"],
  });
  assert.equal(
    (stub.observed.usageArgs.where.periodEnd.gte as Date).toISOString(),
    PERIOD_START.toISOString(),
  );
  assert.equal(
    (stub.observed.usageArgs.where.periodStart.lt as Date).toISOString(),
    PERIOD_END.toISOString(),
  );
});

// ============================================
// Multiple deployments dedup
// ============================================

test("loadUsageRecordsForReputation dedupes deployment ids before the SQL query", async () => {
  const { loadUsageRecordsForReputation } = await import(
    "../services/loadUsageRecordsForReputation.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        deployments: [
          { status: "running", modelDeploymentId: "model_1" },
          { status: "running", modelDeploymentId: "model_2" },
          { status: "running", modelDeploymentId: "model_1" }, // dup
        ],
      },
    ],
  });
  await loadUsageRecordsForReputation(
    {
      agentId: "agent_1",
      orgId: "org_1",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    { prisma: stub.prisma as any },
  );
  const ids = stub.observed.usageArgs.where.deploymentId.in;
  assert.deepEqual([...ids].sort(), ["model_1", "model_2"]);
});
