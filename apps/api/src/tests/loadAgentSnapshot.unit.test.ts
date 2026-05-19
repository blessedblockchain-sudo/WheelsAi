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

// Drives apps/api/src/services/loadAgentSnapshot.ts — the Prisma-backed impl
// that the runway route's loadAgentSnapshot dep delegates to in production.
// Resolves: Agent (by slug + orgId) → AgentDeployment[] (active replicas +
// model deployment ids) → UsageRecord[] (lookback window) → AgentTreasury
// (via Agent → AgentListing → AgentToken → AgentTreasury). Prisma is stubbed
// so this test never touches the DB.

const LAMPORTS_PER_SOL = 1_000_000_000n;

interface FakeAgent {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  deployments: Array<{
    id: string;
    status: string;
    replicas: number;
    modelDeploymentId: string | null;
  }>;
  listing: {
    agentToken: {
      treasury: {
        treasuryPdaAddress: string;
        solBalanceLamports: bigint;
      } | null;
    } | null;
  } | null;
}

function makePrismaStub(opts: {
  agents: FakeAgent[];
  usageRecords?: Array<{
    deploymentId: string;
    orgId: string;
    periodStart: Date;
    periodEnd: Date;
    computeSeconds: bigint;
    actualCostCents: bigint;
  }>;
}) {
  const observed: { agentFindFirst?: any; usageFindMany?: any } = {};
  return {
    observed,
    prisma: {
      agent: {
        async findFirst({ where, include }: any) {
          observed.agentFindFirst = { where, include };
          return (
            opts.agents.find(
              (a) => a.slug === where.slug && a.orgId === where.orgId,
            ) ?? null
          );
        },
      },
      usageRecord: {
        async findMany({ where, select }: any) {
          observed.usageFindMany = { where, select };
          const ids = new Set<string>(where.deploymentId?.in ?? []);
          const cutoff: Date | undefined = where.periodEnd?.gte;
          return (opts.usageRecords ?? []).filter(
            (u) =>
              ids.has(u.deploymentId) &&
              u.orgId === where.orgId &&
              (!cutoff || u.periodEnd >= cutoff),
          );
        },
      },
    },
  };
}

const baseAgent: FakeAgent = {
  id: "agent_1",
  orgId: "org_1",
  name: "Eliza",
  slug: "eliza",
  deployments: [
    {
      id: "depA",
      status: "running",
      replicas: 1,
      modelDeploymentId: "model_dep_1",
    },
  ],
  listing: {
    agentToken: {
      treasury: {
        treasuryPdaAddress: "TPDA111",
        solBalanceLamports: LAMPORTS_PER_SOL,
      },
    },
  },
};

// ============================================
// Lookup + scoping
// ============================================

test("loadAgentSnapshotByPrisma returns null when no agent matches the slug", async () => {
  setupEnv();
  const { loadAgentSnapshotByPrisma } = await import(
    "../services/loadAgentSnapshot.js"
  );
  const stub = makePrismaStub({ agents: [] });
  const snap = await loadAgentSnapshotByPrisma(
    {
      slug: "missing",
      orgId: "org_1",
      lookbackSeconds: 86_400,
      now: new Date("2026-04-26T00:00:00Z"),
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(snap, null);
});

test("loadAgentSnapshotByPrisma scopes by orgId — agent in another org returns null", async () => {
  const { loadAgentSnapshotByPrisma } = await import(
    "../services/loadAgentSnapshot.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, orgId: "org_other" }],
  });
  const snap = await loadAgentSnapshotByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      lookbackSeconds: 86_400,
      now: new Date("2026-04-26T00:00:00Z"),
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(snap, null);
  assert.equal(stub.observed.agentFindFirst.where.orgId, "org_1");
});

// ============================================
// Happy path
// ============================================

test("loadAgentSnapshotByPrisma builds the snapshot with treasury + usage", async () => {
  const { loadAgentSnapshotByPrisma } = await import(
    "../services/loadAgentSnapshot.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    usageRecords: [
      {
        deploymentId: "model_dep_1",
        orgId: "org_1",
        periodStart: new Date("2026-04-25T00:00:00Z"),
        periodEnd: new Date("2026-04-25T01:00:00Z"),
        computeSeconds: 3600n,
        actualCostCents: 100n,
      },
    ],
  });

  const snap = await loadAgentSnapshotByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      lookbackSeconds: 86_400,
      now: new Date("2026-04-26T00:00:00Z"),
    },
    { prisma: stub.prisma as any },
  );

  assert.ok(snap);
  assert.equal(snap.agent.id, "agent_1");
  assert.equal(snap.agent.name, "Eliza");
  assert.equal(snap.agent.slug, "eliza");
  assert.equal(snap.treasuryBalanceLamports, LAMPORTS_PER_SOL);
  assert.equal(snap.treasuryAddress, "TPDA111");
  assert.equal(snap.usageRecords.length, 1);
  assert.equal(snap.usageRecords[0]!.actualCostCents, 100n);
  assert.equal(snap.currentReplicas, 1);
});

test("loadAgentSnapshotByPrisma returns 0 balance + null address when no treasury exists yet", async () => {
  const { loadAgentSnapshotByPrisma } = await import(
    "../services/loadAgentSnapshot.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        listing: { agentToken: { treasury: null } },
      },
    ],
  });

  const snap = await loadAgentSnapshotByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      lookbackSeconds: 86_400,
      now: new Date("2026-04-26T00:00:00Z"),
    },
    { prisma: stub.prisma as any },
  );
  assert.ok(snap);
  assert.equal(snap.treasuryBalanceLamports, 0n);
  assert.equal(snap.treasuryAddress, null);
});

test("loadAgentSnapshotByPrisma returns 0 balance + null address when agent has no listing/token at all", async () => {
  const { loadAgentSnapshotByPrisma } = await import(
    "../services/loadAgentSnapshot.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: null }],
  });
  const snap = await loadAgentSnapshotByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      lookbackSeconds: 86_400,
      now: new Date("2026-04-26T00:00:00Z"),
    },
    { prisma: stub.prisma as any },
  );
  assert.ok(snap);
  assert.equal(snap.treasuryBalanceLamports, 0n);
  assert.equal(snap.treasuryAddress, null);
});

// ============================================
// Replica + deployment aggregation
// ============================================

test("loadAgentSnapshotByPrisma sums replicas across multiple running deployments and dedupes model deployment ids", async () => {
  const { loadAgentSnapshotByPrisma } = await import(
    "../services/loadAgentSnapshot.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        deployments: [
          { id: "depA", status: "running", replicas: 2, modelDeploymentId: "model_1" },
          { id: "depB", status: "running", replicas: 3, modelDeploymentId: "model_2" },
          // Stopped deployments are excluded from the active pool
          { id: "depC", status: "stopped", replicas: 5, modelDeploymentId: "model_3" },
          // Deployments without a model deployment id are skipped (their compute is
          // reported elsewhere — not via UsageRecord)
          { id: "depD", status: "running", replicas: 1, modelDeploymentId: null },
        ],
      },
    ],
  });

  const snap = await loadAgentSnapshotByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      lookbackSeconds: 86_400,
      now: new Date("2026-04-26T00:00:00Z"),
    },
    { prisma: stub.prisma as any },
  );
  assert.ok(snap);
  // Active replicas = 2 + 3 + 1 = 6 (depC stopped, excluded)
  assert.equal(snap.currentReplicas, 6);
  // The usage findMany query was scoped to model_1 + model_2 only.
  const ids = new Set(stub.observed.usageFindMany.where.deploymentId.in);
  assert.deepEqual([...ids].sort(), ["model_1", "model_2"]);
});

test("loadAgentSnapshotByPrisma falls back to currentReplicas=1 when there are no running deployments", async () => {
  const { loadAgentSnapshotByPrisma } = await import(
    "../services/loadAgentSnapshot.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, deployments: [] }],
  });
  const snap = await loadAgentSnapshotByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      lookbackSeconds: 86_400,
      now: new Date("2026-04-26T00:00:00Z"),
    },
    { prisma: stub.prisma as any },
  );
  assert.ok(snap);
  assert.equal(snap.currentReplicas, 1);
});

// ============================================
// Lookback window
// ============================================

test("loadAgentSnapshotByPrisma queries UsageRecord with periodEnd >= now - lookbackSeconds", async () => {
  const { loadAgentSnapshotByPrisma } = await import(
    "../services/loadAgentSnapshot.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent] });
  const now = new Date("2026-04-26T00:00:00Z");
  await loadAgentSnapshotByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      lookbackSeconds: 3 * 86_400,
      now,
    },
    { prisma: stub.prisma as any },
  );
  const cutoff: Date = stub.observed.usageFindMany.where.periodEnd.gte;
  assert.equal(cutoff.getTime(), now.getTime() - 3 * 86_400 * 1000);
});

test("loadAgentSnapshotByPrisma scopes the UsageRecord query by orgId (multi-tenant safety)", async () => {
  const { loadAgentSnapshotByPrisma } = await import(
    "../services/loadAgentSnapshot.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent] });
  await loadAgentSnapshotByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      lookbackSeconds: 86_400,
      now: new Date("2026-04-26T00:00:00Z"),
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.usageFindMany.where.orgId, "org_1");
});
