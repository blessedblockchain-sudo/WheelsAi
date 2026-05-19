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

// Drives apps/api/src/services/loadAgentTradesForChart.ts — Prisma-backed
// loader for GET /agents/:slug/chart. Resolves:
//
//   Agent (slug + orgId, scoped)
//     → agent.listing.agentToken.id          (chart's tokenId)
//   AgentTokenTrade
//     where tokenId = above
//       AND optional [from, to] window
//
// Return contract (the route distinguishes these states):
//   null  → agent not found, or agent not tokenized yet (404)
//   []    → tokenized agent with no trades yet (200 empty chart)

interface FakeAgent {
  id: string;
  orgId: string;
  slug: string;
  listing: { agentToken: { id: string } | null } | null;
}

interface FakeTrade {
  tokenId: string;
  timestamp: Date;
  priceUsd: number;
  solAmount: number;
  // Other fields the loader should drop:
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
}

function makePrismaStub(opts: {
  agents: FakeAgent[];
  trades?: FakeTrade[];
}) {
  const observed: { agentArgs?: any; tradeArgs?: any } = {};
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
      agentTokenTrade: {
        async findMany({ where, orderBy, select }: any) {
          observed.tradeArgs = { where, orderBy, select };
          return (opts.trades ?? []).filter((t) => {
            if (t.tokenId !== where.tokenId) return false;
            if (where.timestamp?.gte && t.timestamp < where.timestamp.gte)
              return false;
            if (where.timestamp?.lte && t.timestamp > where.timestamp.lte)
              return false;
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
  slug: "eliza",
  listing: { agentToken: { id: "tok_1" } },
};

// ============================================
// Lookup + scoping
// ============================================

test("loadAgentTradesForChartByPrisma returns null when agent does not exist", async () => {
  setupEnv();
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({ agents: [] });
  const result = await loadAgentTradesForChartByPrisma(
    { slug: "missing", orgId: "org_1", from: null, to: null },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
});

test("loadAgentTradesForChartByPrisma returns null on cross-org access", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, orgId: "org_other" }],
  });
  const result = await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from: null, to: null },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
  assert.equal(stub.observed.agentArgs.where.orgId, "org_1");
});

// ============================================
// Tokenization gates (null = "no chart")
// ============================================

test("loadAgentTradesForChartByPrisma returns null when agent has no listing", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: null }],
  });
  const result = await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from: null, to: null },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
  // No trade query issued — agent isn't tokenized.
  assert.equal(stub.observed.tradeArgs, undefined);
});

test("loadAgentTradesForChartByPrisma returns null when listing has no agentToken (not tokenized yet)", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: { agentToken: null } }],
  });
  const result = await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from: null, to: null },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
});

// ============================================
// Tokenized agent
// ============================================

test("loadAgentTradesForChartByPrisma returns [] for a tokenized agent with no trades yet", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], trades: [] });
  const result = await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from: null, to: null },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, []);
});

test("loadAgentTradesForChartByPrisma maps DB rows into the OhlcTrade shape (drops side/trader/sig)", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    trades: [
      {
        tokenId: "tok_1",
        timestamp: new Date("2026-04-26T13:00:00Z"),
        priceUsd: 0.001,
        solAmount: 0.5,
        txSignature: "sig_a",
        traderAddress: "Alice",
        side: "buy",
      },
    ],
  });
  const result = await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from: null, to: null },
    { prisma: stub.prisma as any },
  );
  assert.equal(result?.length, 1);
  // Only timestamp / priceUsd / solAmount survive — chart doesn't need
  // tx-level metadata.
  assert.deepEqual(Object.keys(result![0]!).sort(), [
    "priceUsd",
    "solAmount",
    "timestamp",
  ]);
  assert.equal(result![0]!.priceUsd, 0.001);
  assert.equal(result![0]!.solAmount, 0.5);
});

test("loadAgentTradesForChartByPrisma scopes trade lookup by the resolved tokenId (not by slug)", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], trades: [] });
  await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from: null, to: null },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.tradeArgs.where.tokenId, "tok_1");
});

// ============================================
// from/to window
// ============================================

test("loadAgentTradesForChartByPrisma forwards from/to as a Prisma timestamp window", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], trades: [] });
  const from = new Date("2026-04-26T00:00:00Z");
  const to = new Date("2026-04-26T23:59:59Z");
  await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from, to },
    { prisma: stub.prisma as any },
  );
  assert.equal(
    (stub.observed.tradeArgs.where.timestamp.gte as Date).toISOString(),
    from.toISOString(),
  );
  assert.equal(
    (stub.observed.tradeArgs.where.timestamp.lte as Date).toISOString(),
    to.toISOString(),
  );
});

test("loadAgentTradesForChartByPrisma omits the timestamp filter when from/to are both null", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], trades: [] });
  await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from: null, to: null },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.tradeArgs.where.timestamp, undefined);
});

test("loadAgentTradesForChartByPrisma forwards only `from` when `to` is null", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], trades: [] });
  const from = new Date("2026-04-26T00:00:00Z");
  await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from, to: null },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(Object.keys(stub.observed.tradeArgs.where.timestamp), [
    "gte",
  ]);
});

// ============================================
// Order
// ============================================

test("loadAgentTradesForChartByPrisma orders trades ascending by timestamp", async () => {
  const { loadAgentTradesForChartByPrisma } = await import(
    "../services/loadAgentTradesForChart.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], trades: [] });
  await loadAgentTradesForChartByPrisma(
    { slug: "eliza", orgId: "org_1", from: null, to: null },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(stub.observed.tradeArgs.orderBy, { timestamp: "asc" });
});
