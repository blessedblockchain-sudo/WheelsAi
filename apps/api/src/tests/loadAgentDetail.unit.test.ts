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

// Drives apps/api/src/services/loadAgentDetail.ts — Prisma-backed loader
// for the GET /agents/:slug dashboard endpoint. Composes:
//   Agent (slug+orgId)
//     → agent.deployments (AgentDeployment[])
//     → agent.openclawDeployment.channels (OpenClawChannel[])
//     → agent.listing.agentToken.treasury (AgentTreasury) → recent payments

const LAMPORTS_PER_SOL = 1_000_000_000n;

interface FakeAgent {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
  deployments: Array<{
    id: string;
    gpuTier: string;
    replicas: number;
    status: string;
    nosanaJobIds: string[];
  }>;
  openclawDeployment: {
    id: string;
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
  id: string;
  treasuryId: string;
  amountLamports: bigint;
  computeSeconds: bigint;
  status: string;
  txSignature: string | null;
  paidAt: Date | null;
  scheduledFor: Date;
  errorMessage: string | null;
  createdAt: Date;
}

function makePrismaStub(opts: {
  agents: FakeAgent[];
  payments?: FakePayment[];
}) {
  const observed: { agentArgs?: any; paymentArgs?: any } = {};
  return {
    observed,
    prisma: {
      agent: {
        async findFirst({ where, include }: any) {
          observed.agentArgs = { where, include };
          return (
            opts.agents.find(
              (a) => a.slug === where.slug && a.orgId === where.orgId,
            ) ?? null
          );
        },
      },
      computePayment: {
        async findMany({ where, orderBy, take }: any) {
          observed.paymentArgs = { where, orderBy, take };
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
  orgId: "org_1",
  name: "Eliza",
  slug: "eliza",
  framework: "elizaos",
  createdAt: new Date("2026-04-20T00:00:00Z"),
  deployments: [
    {
      id: "dep_1",
      gpuTier: "4090",
      replicas: 2,
      status: "running",
      nosanaJobIds: ["job_a"],
    },
  ],
  openclawDeployment: {
    id: "openclaw_1",
    channels: [
      { platform: "discord", enabled: true },
      { platform: "telegram", enabled: false },
    ],
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
// Lookup + scoping
// ============================================

test("loadAgentDetailByPrisma returns null when slug doesn't match", async () => {
  setupEnv();
  const { loadAgentDetailByPrisma } = await import(
    "../services/loadAgentDetail.js"
  );
  const stub = makePrismaStub({ agents: [] });
  const result = await loadAgentDetailByPrisma(
    { slug: "missing", orgId: "org_1", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
});

test("loadAgentDetailByPrisma scopes by orgId — wrong org returns null", async () => {
  const { loadAgentDetailByPrisma } = await import(
    "../services/loadAgentDetail.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, orgId: "org_other" }],
  });
  const result = await loadAgentDetailByPrisma(
    { slug: "eliza", orgId: "org_1", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
  assert.equal(stub.observed.agentArgs.where.orgId, "org_1");
});

// ============================================
// Happy path
// ============================================

test("loadAgentDetailByPrisma returns the full dashboard shape", async () => {
  const { loadAgentDetailByPrisma } = await import(
    "../services/loadAgentDetail.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    payments: [
      {
        id: "cp_1",
        treasuryId: "treasury_1",
        amountLamports: 4_500_000n,
        computeSeconds: 3600n,
        status: "CONFIRMED",
        txSignature: "sig_1",
        paidAt: new Date("2026-04-26T11:00:00Z"),
        scheduledFor: new Date("2026-04-26T10:55:00Z"),
        errorMessage: null,
        createdAt: new Date("2026-04-26T10:55:00Z"),
      },
    ],
  });
  const result = await loadAgentDetailByPrisma(
    { slug: "eliza", orgId: "org_1", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );

  assert.ok(result);
  assert.equal(result.agent.id, "agent_1");
  assert.equal(result.agent.name, "Eliza");
  assert.equal(result.agent.framework, "elizaos");
  assert.equal(result.treasury?.address, "PDA111");
  assert.equal(result.treasury?.balanceLamports, LAMPORTS_PER_SOL);
  assert.equal(result.deployments.length, 1);
  assert.equal(result.deployments[0]!.gpuTier, "4090");
  assert.equal(result.channels.length, 2);
  assert.equal(result.recentPayments.length, 1);
  assert.equal(result.recentPayments[0]!.id, "cp_1");
});

// ============================================
// Treasury / channels absence
// ============================================

test("loadAgentDetailByPrisma returns treasury=null when no token+treasury yet", async () => {
  const { loadAgentDetailByPrisma } = await import(
    "../services/loadAgentDetail.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: null }],
  });
  const result = await loadAgentDetailByPrisma(
    { slug: "eliza", orgId: "org_1", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  assert.equal(result.treasury, null);
  // Without a treasury there are no payments to fetch.
  assert.equal(result.recentPayments.length, 0);
});

test("loadAgentDetailByPrisma returns treasury=null when listing has no agentToken", async () => {
  const { loadAgentDetailByPrisma } = await import(
    "../services/loadAgentDetail.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: { agentToken: null } }],
  });
  const result = await loadAgentDetailByPrisma(
    { slug: "eliza", orgId: "org_1", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  assert.equal(result.treasury, null);
});

test("loadAgentDetailByPrisma returns treasury=null when token has no treasury", async () => {
  const { loadAgentDetailByPrisma } = await import(
    "../services/loadAgentDetail.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: { agentToken: { treasury: null } } }],
  });
  const result = await loadAgentDetailByPrisma(
    { slug: "eliza", orgId: "org_1", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  assert.equal(result.treasury, null);
});

test("loadAgentDetailByPrisma returns channels=[] when no openclawDeployment is wired up", async () => {
  const { loadAgentDetailByPrisma } = await import(
    "../services/loadAgentDetail.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, openclawDeployment: null }],
  });
  const result = await loadAgentDetailByPrisma(
    { slug: "eliza", orgId: "org_1", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  assert.deepEqual(result.channels, []);
});

// ============================================
// Payments query
// ============================================

test("loadAgentDetailByPrisma orders payments by createdAt desc and respects the limit", async () => {
  const { loadAgentDetailByPrisma } = await import(
    "../services/loadAgentDetail.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    payments: [
      {
        id: "cp_old",
        treasuryId: "treasury_1",
        amountLamports: 1n,
        computeSeconds: 1n,
        status: "CONFIRMED",
        txSignature: null,
        paidAt: null,
        scheduledFor: new Date("2026-04-25T00:00:00Z"),
        errorMessage: null,
        createdAt: new Date("2026-04-25T00:00:00Z"),
      },
      {
        id: "cp_new",
        treasuryId: "treasury_1",
        amountLamports: 1n,
        computeSeconds: 1n,
        status: "PENDING",
        txSignature: null,
        paidAt: null,
        scheduledFor: new Date("2026-04-26T00:00:00Z"),
        errorMessage: null,
        createdAt: new Date("2026-04-26T00:00:00Z"),
      },
    ],
  });
  const result = await loadAgentDetailByPrisma(
    { slug: "eliza", orgId: "org_1", paymentsLimit: 1 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  // Limit honored
  assert.equal(result.recentPayments.length, 1);
  // Newest first
  assert.equal(result.recentPayments[0]!.id, "cp_new");
  // Query carried the right take + order
  assert.equal(stub.observed.paymentArgs.take, 1);
  assert.deepEqual(stub.observed.paymentArgs.orderBy, { createdAt: "desc" });
});

test("loadAgentDetailByPrisma scopes the payments query to this agent's treasury", async () => {
  const { loadAgentDetailByPrisma } = await import(
    "../services/loadAgentDetail.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    payments: [
      {
        id: "other_treasury",
        treasuryId: "treasury_DIFFERENT",
        amountLamports: 1n,
        computeSeconds: 1n,
        status: "CONFIRMED",
        txSignature: null,
        paidAt: null,
        scheduledFor: new Date(),
        errorMessage: null,
        createdAt: new Date(),
      },
    ],
  });
  const result = await loadAgentDetailByPrisma(
    { slug: "eliza", orgId: "org_1", paymentsLimit: 10 },
    { prisma: stub.prisma as any },
  );
  assert.ok(result);
  // No leak from another agent's treasury.
  assert.deepEqual(result.recentPayments, []);
  assert.equal(stub.observed.paymentArgs.where.treasuryId, "treasury_1");
});
