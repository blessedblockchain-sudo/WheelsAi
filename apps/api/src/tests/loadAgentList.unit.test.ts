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

// Drives apps/api/src/services/loadAgentList.ts — the Prisma-backed impl
// the GET /agents route delegates to in production. Resolves:
//
//   Agent (orgId scoped)
//     → deployments (for activeDeploymentCount = sum of running replicas)
//     → listing.agentToken (for tokenStatus: not_tokenized | bonding | graduated)
//     → listing.agentToken.treasury (for treasuryBalanceLamports)
//
// + a separate prisma.agent.count for totalCount.

const LAMPORTS_PER_SOL = 1_000_000_000n;

interface FakeAgent {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
  deployments: Array<{ status: string; replicas: number }>;
  listing: {
    agentToken: {
      status: string;
      treasury: { solBalanceLamports: bigint } | null;
    } | null;
  } | null;
}

function makePrismaStub(opts: {
  agents: FakeAgent[];
  totalCount?: number;
}) {
  const observed: { findArgs?: any; countArgs?: any } = {};
  return {
    observed,
    prisma: {
      agent: {
        async findMany({ where, include, orderBy, skip, take }: any) {
          observed.findArgs = { where, include, orderBy, skip, take };
          let rows = opts.agents.filter((a) => a.orgId === where.orgId);
          if (orderBy?.createdAt === "desc") {
            rows = [...rows].sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
            );
          } else if (orderBy?.createdAt === "asc") {
            rows = [...rows].sort(
              (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
            );
          } else if (orderBy?.name === "asc") {
            rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
          }
          return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length));
        },
        async count({ where }: any) {
          observed.countArgs = { where };
          return opts.totalCount ?? opts.agents.filter((a) => a.orgId === where.orgId).length;
        },
      },
    },
  };
}

const baseAgent = (overrides: Partial<FakeAgent> = {}): FakeAgent => ({
  id: "agent_1",
  orgId: "org_1",
  name: "Eliza",
  slug: "eliza",
  framework: "elizaos",
  createdAt: new Date("2026-04-25T00:00:00Z"),
  deployments: [{ status: "running", replicas: 2 }],
  listing: {
    agentToken: {
      status: "BONDING",
      treasury: { solBalanceLamports: LAMPORTS_PER_SOL },
    },
  },
  ...overrides,
});

// ============================================
// Scoping + count
// ============================================

test("loadAgentListByPrisma scopes agent.findMany AND agent.count by orgId", async () => {
  setupEnv();
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent()] });
  await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.findArgs.where.orgId, "org_1");
  assert.equal(stub.observed.countArgs.where.orgId, "org_1");
});

test("loadAgentListByPrisma returns empty list + totalCount=0 when org has no agents", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({ agents: [] });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result.agents, []);
  assert.equal(result.totalCount, 0);
});

test("loadAgentListByPrisma totalCount can differ from page length (multi-page)", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  // 3 agents but ask for 2 — totalCount should still be 3.
  const stub = makePrismaStub({
    agents: [
      baseAgent({ id: "a", createdAt: new Date("2026-04-25T03:00:00Z") }),
      baseAgent({ id: "b", createdAt: new Date("2026-04-25T02:00:00Z") }),
      baseAgent({ id: "c", createdAt: new Date("2026-04-25T01:00:00Z") }),
    ],
    totalCount: 3,
  });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 2, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.agents.length, 2);
  assert.equal(result.totalCount, 3);
});

// ============================================
// Shape mapping
// ============================================

test("loadAgentListByPrisma maps agent rows into the AgentListEntry shape", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent()] });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  const e = result.agents[0]!;
  assert.equal(e.id, "agent_1");
  assert.equal(e.name, "Eliza");
  assert.equal(e.slug, "eliza");
  assert.equal(e.framework, "elizaos");
  assert.equal(e.createdAt.toISOString(), "2026-04-25T00:00:00.000Z");
  assert.equal(e.treasuryBalanceLamports, LAMPORTS_PER_SOL);
  assert.equal(e.activeDeploymentCount, 2);
  assert.equal(e.tokenStatus, "bonding");
});

// ============================================
// activeDeploymentCount
// ============================================

test("loadAgentListByPrisma sums replicas only across RUNNING deployments", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({
    agents: [
      baseAgent({
        deployments: [
          { status: "running", replicas: 2 },
          { status: "running", replicas: 3 },
          { status: "stopped", replicas: 5 }, // excluded
          { status: "failed", replicas: 1 }, // excluded
        ],
      }),
    ],
  });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.agents[0]!.activeDeploymentCount, 5);
});

test("loadAgentListByPrisma reports activeDeploymentCount=0 when no running deployments", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({
    agents: [
      baseAgent({
        deployments: [{ status: "stopped", replicas: 5 }],
      }),
    ],
  });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.agents[0]!.activeDeploymentCount, 0);
});

// ============================================
// tokenStatus mapping
// ============================================

test("loadAgentListByPrisma maps tokenStatus = 'not_tokenized' when no listing", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent({ listing: null })],
  });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.agents[0]!.tokenStatus, "not_tokenized");
  assert.equal(result.agents[0]!.treasuryBalanceLamports, null);
});

test("loadAgentListByPrisma maps tokenStatus = 'not_tokenized' when listing has no agentToken", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent({ listing: { agentToken: null } })],
  });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.agents[0]!.tokenStatus, "not_tokenized");
});

test("loadAgentListByPrisma maps token.status='BONDING' → 'bonding' (lowercase)", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({
    agents: [
      baseAgent({
        listing: {
          agentToken: {
            status: "BONDING",
            treasury: { solBalanceLamports: 100n },
          },
        },
      }),
    ],
  });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.agents[0]!.tokenStatus, "bonding");
});

test("loadAgentListByPrisma maps token.status='GRADUATED' → 'graduated'", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({
    agents: [
      baseAgent({
        listing: {
          agentToken: {
            status: "GRADUATED",
            treasury: { solBalanceLamports: 100n },
          },
        },
      }),
    ],
  });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.agents[0]!.tokenStatus, "graduated");
});

test("loadAgentListByPrisma reports treasuryBalanceLamports=null when no treasury", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({
    agents: [
      baseAgent({
        listing: {
          agentToken: { status: "BONDING", treasury: null },
        },
      }),
    ],
  });
  const result = await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.agents[0]!.treasuryBalanceLamports, null);
  // Token still bonding even though treasury isn't set up yet.
  assert.equal(result.agents[0]!.tokenStatus, "bonding");
});

// ============================================
// Sort
// ============================================

test("loadAgentListByPrisma forwards sort='newest' as orderBy { createdAt: 'desc' }", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent()] });
  await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(stub.observed.findArgs.orderBy, { createdAt: "desc" });
});

test("loadAgentListByPrisma forwards sort='oldest' as orderBy { createdAt: 'asc' }", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent()] });
  await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "oldest" },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(stub.observed.findArgs.orderBy, { createdAt: "asc" });
});

test("loadAgentListByPrisma forwards sort='name' as orderBy { name: 'asc' }", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent()] });
  await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "name" },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(stub.observed.findArgs.orderBy, { name: "asc" });
});

test("loadAgentListByPrisma falls back to createdAt desc for sort='treasury_balance_desc' (in-DB ordering on a nested relation isn't expressible in vanilla Prisma yet)", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent()] });
  await loadAgentListByPrisma(
    { orgId: "org_1", limit: 20, offset: 0, sort: "treasury_balance_desc" },
    { prisma: stub.prisma as any },
  );
  // Documented fallback — the route accepts the sort enum so the loader
  // doesn't 500 on it. A future denormalized field on Agent will let us
  // do real treasury_balance_desc ordering.
  assert.deepEqual(stub.observed.findArgs.orderBy, { createdAt: "desc" });
});

// ============================================
// Pagination
// ============================================

test("loadAgentListByPrisma forwards skip = offset and take = limit", async () => {
  const { loadAgentListByPrisma } = await import(
    "../services/loadAgentList.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent()] });
  await loadAgentListByPrisma(
    { orgId: "org_1", limit: 25, offset: 50, sort: "newest" },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.findArgs.skip, 50);
  assert.equal(stub.observed.findArgs.take, 25);
});
