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

// Drives apps/api/src/services/loadPublicAgent.ts — Prisma-backed loader
// for GET /a/:slug. Differences from loadAgentDetailByPrisma:
//
//   - filter: where { slug, isPublic: true } — null on miss OR private
//   - no orgId scoping (public surface)
//   - includes a SUM aggregate for cumulativeComputePaidLamports across
//     status='CONFIRMED' only — failed/pending compute does not count
//     toward the publicly displayed "amount paid to date"

const LAMPORTS_PER_SOL = 1_000_000_000n;

interface FakeAgent {
  id: string;
  isPublic: boolean;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
  deployments: Array<{
    gpuTier: string;
    replicas: number;
    status: string;
  }>;
  openclawDeployment: {
    channels: Array<{ platform: string; enabled: boolean }>;
  } | null;
  listing: {
    agentToken: {
      treasury: {
        id: string;
        treasuryPdaAddress: string;
        solBalanceLamports: bigint;
      } | null;
    } | null;
  } | null;
}

interface FakePayment {
  treasuryId: string;
  amountLamports: bigint;
  status: string;
  txSignature: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

function makePrismaStub(opts: {
  agents: FakeAgent[];
  payments?: FakePayment[];
}) {
  const observed: { agentArgs?: any; aggArgs?: any; manyArgs?: any } = {};
  return {
    observed,
    prisma: {
      agent: {
        async findFirst({ where, include }: any) {
          observed.agentArgs = { where, include };
          return (
            opts.agents.find(
              (a) =>
                a.slug === where.slug &&
                (where.isPublic === undefined || a.isPublic === where.isPublic),
            ) ?? null
          );
        },
      },
      computePayment: {
        async aggregate({ where, _sum }: any) {
          observed.aggArgs = { where, _sum };
          const total = (opts.payments ?? [])
            .filter(
              (p) => p.treasuryId === where.treasuryId && p.status === where.status,
            )
            .reduce((acc, p) => acc + p.amountLamports, 0n);
          return { _sum: { amountLamports: total === 0n ? null : total } };
        },
        async findMany({ where, orderBy, take }: any) {
          observed.manyArgs = { where, orderBy, take };
          return (opts.payments ?? [])
            .filter((p) => p.treasuryId === where.treasuryId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take);
        },
      },
    },
  };
}

const baseAgent: FakeAgent = {
  id: "agent_1",
  isPublic: true,
  name: "Eliza",
  slug: "eliza",
  framework: "elizaos",
  createdAt: new Date("2026-04-20T00:00:00Z"),
  deployments: [
    { gpuTier: "4090", replicas: 2, status: "running" },
  ],
  openclawDeployment: {
    channels: [{ platform: "discord", enabled: true }],
  },
  listing: {
    agentToken: {
      treasury: {
        id: "treasury_1",
        treasuryPdaAddress: "PDA111",
        solBalanceLamports: LAMPORTS_PER_SOL,
      },
    },
  },
};

// ============================================
// Visibility
// ============================================

test("loadPublicAgentByPrisma returns null when slug does not exist", async () => {
  setupEnv();
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({ agents: [] });
  const result = await loadPublicAgentByPrisma(
    { slug: "missing", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
});

test("loadPublicAgentByPrisma returns null for a private agent (isPublic=false)", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, isPublic: false }],
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
  // Confirm the SQL filter was applied (not just filtered in code).
  assert.equal(stub.observed.agentArgs.where.isPublic, true);
});

// ============================================
// Happy path
// ============================================

test("loadPublicAgentByPrisma returns the full public-safe shape", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    payments: [
      {
        treasuryId: "treasury_1",
        amountLamports: 4_500_000n,
        status: "CONFIRMED",
        txSignature: "sig_1",
        paidAt: new Date("2026-04-26T11:00:00Z"),
        createdAt: new Date("2026-04-26T11:00:00Z"),
      },
    ],
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );

  assert.ok(result);
  assert.equal(result.agent.name, "Eliza");
  assert.equal(result.agent.slug, "eliza");
  assert.equal(result.agent.framework, "elizaos");
  assert.equal(result.treasury?.address, "PDA111");
  assert.equal(result.treasury?.balanceLamports, LAMPORTS_PER_SOL);
  assert.equal(result.treasury?.cumulativeComputePaidLamports, 4_500_000n);
  assert.equal(result.recentPayments.length, 1);
  assert.deepEqual(
    result.channels.map((c) => c.platform),
    ["discord"],
  );
});

// ============================================
// cumulativeComputePaidLamports — CONFIRMED only
// ============================================

test("loadPublicAgentByPrisma sums cumulativeComputePaid across CONFIRMED payments only", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    payments: [
      {
        treasuryId: "treasury_1",
        amountLamports: 1_000_000n,
        status: "CONFIRMED",
        txSignature: "s1",
        paidAt: new Date(),
        createdAt: new Date("2026-04-25T00:00:00Z"),
      },
      {
        treasuryId: "treasury_1",
        amountLamports: 2_000_000n,
        status: "CONFIRMED",
        txSignature: "s2",
        paidAt: new Date(),
        createdAt: new Date("2026-04-26T00:00:00Z"),
      },
      // Following should NOT be counted in the public cumulative figure.
      {
        treasuryId: "treasury_1",
        amountLamports: 5_000_000n,
        status: "PENDING",
        txSignature: null,
        paidAt: null,
        createdAt: new Date("2026-04-26T01:00:00Z"),
      },
      {
        treasuryId: "treasury_1",
        amountLamports: 9_999_999n,
        status: "FAILED",
        txSignature: null,
        paidAt: null,
        createdAt: new Date("2026-04-26T02:00:00Z"),
      },
      {
        treasuryId: "treasury_1",
        amountLamports: 3_000_000n,
        status: "SUBMITTED",
        txSignature: "s3",
        paidAt: null,
        createdAt: new Date("2026-04-26T03:00:00Z"),
      },
    ],
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );

  assert.ok(result);
  assert.equal(result.treasury?.cumulativeComputePaidLamports, 3_000_000n);
  // Confirm the aggregate query filtered on status="CONFIRMED" (not in code).
  assert.equal(stub.observed.aggArgs.where.status, "CONFIRMED");
});

test("loadPublicAgentByPrisma returns 0n cumulative when no CONFIRMED payments exist yet", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    payments: [
      {
        treasuryId: "treasury_1",
        amountLamports: 1_000_000n,
        status: "PENDING",
        txSignature: null,
        paidAt: null,
        createdAt: new Date(),
      },
    ],
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  assert.equal(result.treasury?.cumulativeComputePaidLamports, 0n);
});

// ============================================
// No treasury / no payments
// ============================================

test("loadPublicAgentByPrisma returns treasury=null when token+treasury missing", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: null }],
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  assert.equal(result.treasury, null);
  assert.deepEqual(result.recentPayments, []);
});

// ============================================
// Payments query
// ============================================

test("loadPublicAgentByPrisma orders payments desc by createdAt and respects the limit", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    payments: [
      {
        treasuryId: "treasury_1",
        amountLamports: 1n,
        status: "CONFIRMED",
        txSignature: "old",
        paidAt: new Date(),
        createdAt: new Date("2026-04-25T00:00:00Z"),
      },
      {
        treasuryId: "treasury_1",
        amountLamports: 1n,
        status: "CONFIRMED",
        txSignature: "new",
        paidAt: new Date(),
        createdAt: new Date("2026-04-26T00:00:00Z"),
      },
    ],
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 1 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  assert.equal(result.recentPayments.length, 1);
  assert.equal(result.recentPayments[0]!.txSignature, "new");
  assert.equal(stub.observed.manyArgs.take, 1);
  assert.deepEqual(stub.observed.manyArgs.orderBy, { createdAt: "desc" });
});

test("loadPublicAgentByPrisma scopes the payments query to this agent's treasury (no leak)", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    payments: [
      {
        treasuryId: "another_treasury",
        amountLamports: 99n,
        status: "CONFIRMED",
        txSignature: "leak",
        paidAt: new Date(),
        createdAt: new Date(),
      },
    ],
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  assert.deepEqual(result.recentPayments, []);
  assert.equal(stub.observed.manyArgs.where.treasuryId, "treasury_1");
});

// ============================================
// Channels (no orgId, no internal-only fields)
// ============================================

test("loadPublicAgentByPrisma exposes channels but not orgId or internal IDs", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent] });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  // The shape's TypeScript type already excludes orgId. Sanity check no
  // accidental fields leaked into the return.
  for (const d of result.deployments) {
    assert.deepEqual(Object.keys(d).sort(), ["gpuTier", "replicas", "status"]);
  }
  for (const c of result.channels) {
    assert.deepEqual(Object.keys(c).sort(), ["enabled", "platform"]);
  }
});
