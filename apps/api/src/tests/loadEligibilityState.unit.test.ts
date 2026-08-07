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

// Drives apps/api/src/services/loadEligibilityState.ts — the Prisma-backed
// loader that the POST /tokens route's loadEligibilityState dep delegates
// to in production. Composes:
//
//   Agent (id, orgId)
//     → agent.deployments (AgentDeployment[]) — oldest running → age
//     → agent.listing → agentListing.status, agentToken (alreadyTokenized?)
//   PublisherProfile (orgId) → reputationScore
//   Creator wallet — supplied via deps.getCreatorAddress(orgId) since the
//   "which wallet pays" choice is a product policy (org owner? user?
//   org-level treasury?) that can change without touching this loader.

const NOW = new Date("2026-04-26T00:00:00Z");

interface FakeAgent {
  id: string;
  orgId: string;
  name: string;
  deployments: Array<{
    id?: string;
    status: string;
    createdAt: Date;
    modelDeploymentId?: string | null;
  }>;
  listing: {
    status: string;
    agentToken: { id: string; mintAddress?: string } | null;
  } | null;
}

function makePrismaStub(opts: {
  agents: FakeAgent[];
  publisherProfiles?: Array<{ orgId: string; reputationScore: number }>;
  settledPayments?: number;
}) {
  const observed: { agentArgs?: any; profileArgs?: any; x402Args?: any } = {};
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
      publisherProfile: {
        async findUnique({ where, select }: any) {
          observed.profileArgs = { where, select };
          return (
            (opts.publisherProfiles ?? []).find((p) => p.orgId === where.orgId) ??
            null
          );
        },
      },
      x402Payment: {
        async count({ where }: any) {
          observed.x402Args = { where };
          return opts.settledPayments ?? 0;
        },
      },
    },
  };
}

const baseAgent: FakeAgent = {
  id: "agent_1",
  orgId: "org_1",
  name: "Eliza",
  deployments: [
    {
      status: "running",
      // 14 days before NOW
      createdAt: new Date("2026-04-12T00:00:00Z"),
    },
  ],
  listing: {
    status: "published",
    agentToken: null, // not yet tokenized
  },
};

// ============================================
// Lookup + scoping
// ============================================

test("loadEligibilityStateByPrisma returns null when the agent does not exist", async () => {
  setupEnv();
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({ agents: [] });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "missing", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "PaYer",
    },
  );
  assert.equal(result, null);
});

test("loadEligibilityStateByPrisma scopes by orgId — wrong org returns null", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, orgId: "org_other" }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "PaYer",
    },
  );
  assert.equal(result, null);
  assert.equal(stub.observed.agentArgs.where.orgId, "org_1");
});

// ============================================
// Happy path
// ============================================

test("loadEligibilityStateByPrisma returns the full EligibilityState shape", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
  });

  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "PaYer11111111111111111111111111111111111111",
    },
  );

  assert.ok(result);
  assert.equal(result.agent.id, "agent_1");
  assert.equal(result.agent.name, "Eliza");
  assert.equal(result.reputationScore, 67);
  assert.equal(result.deploymentAgeDays, 14);
  assert.equal(result.hasPublishedListing, true);
  assert.equal(result.alreadyTokenized, false);
  assert.equal(
    result.creatorAddress,
    "PaYer11111111111111111111111111111111111111",
  );
  assert.equal(result.settledPaidRequests, 0);
});

// ============================================
// Sybil discount input (B4/T7)
// ============================================

test("loadEligibilityStateByPrisma counts SETTLED x402 payments attributed to the agent", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        deployments: [
          {
            id: "ad_1",
            status: "running",
            createdAt: new Date("2026-04-12T00:00:00Z"),
            modelDeploymentId: "md_9",
          },
        ],
      },
    ],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
    settledPayments: 12,
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.ok(result);
  assert.equal(result.settledPaidRequests, 12);
  // Only SETTLED payments count (confirmed on-chain), attributed through
  // the agent's own deployments OR the model deployments it is bound to.
  assert.equal(stub.observed.x402Args.where.status, "settled");
  assert.deepEqual(stub.observed.x402Args.where.OR, [
    { agentDeploymentId: { in: ["ad_1"] } },
    { deploymentId: { in: ["md_9"] } },
  ]);
});

test("loadEligibilityStateByPrisma skips the x402 count entirely when the agent has no deployments", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, deployments: [] }],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
    settledPayments: 99, // must NOT be read
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.ok(result);
  assert.equal(result.settledPaidRequests, 0);
  assert.equal(stub.observed.x402Args, undefined, "count never queried");
});

// ============================================
// Reputation
// ============================================

test("loadEligibilityStateByPrisma returns reputationScore=0 when no PublisherProfile exists yet", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    publisherProfiles: [], // newly-created org, no profile yet
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.ok(result);
  assert.equal(result.reputationScore, 0);
});

test("loadEligibilityStateByPrisma reads PublisherProfile by orgId (not by agentId)", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 80 }],
  });
  await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.equal(stub.observed.profileArgs.where.orgId, "org_1");
});

// ============================================
// Deployment age
// ============================================

test("loadEligibilityStateByPrisma uses the OLDEST running deployment to compute age", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        deployments: [
          { status: "running", createdAt: new Date("2026-04-20T00:00:00Z") }, // 6 days
          { status: "running", createdAt: new Date("2026-04-12T00:00:00Z") }, // 14 days (OLDEST)
          { status: "running", createdAt: new Date("2026-04-25T00:00:00Z") }, // 1 day
        ],
      },
    ],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.ok(result);
  assert.equal(result.deploymentAgeDays, 14);
});

test("loadEligibilityStateByPrisma ignores stopped/failed deployments when computing age", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        deployments: [
          // OLDEST is stopped — should NOT count toward uptime
          { status: "stopped", createdAt: new Date("2026-04-01T00:00:00Z") }, // 25 days
          { status: "running", createdAt: new Date("2026-04-22T00:00:00Z") }, // 4 days
        ],
      },
    ],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.ok(result);
  assert.equal(result.deploymentAgeDays, 4);
});

test("loadEligibilityStateByPrisma returns deploymentAgeDays=0 when no running deployments exist", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, deployments: [] }],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.ok(result);
  assert.equal(result.deploymentAgeDays, 0);
});

// ============================================
// Listing + tokenized state
// ============================================

test("loadEligibilityStateByPrisma reports hasPublishedListing=false when listing is not published", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [
      { ...baseAgent, listing: { status: "draft", agentToken: null } },
    ],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.ok(result);
  assert.equal(result.hasPublishedListing, false);
});

test("loadEligibilityStateByPrisma reports hasPublishedListing=false when no listing exists at all", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: null }],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.ok(result);
  assert.equal(result.hasPublishedListing, false);
  assert.equal(result.alreadyTokenized, false);
});

test("loadEligibilityStateByPrisma reports alreadyTokenized=true when the listing has an agentToken", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        listing: { status: "published", agentToken: { id: "tok_1" } },
      },
    ],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
    },
  );
  assert.ok(result);
  assert.equal(result.alreadyTokenized, true);
});

// ============================================
// Creator address (delegated)
// ============================================

test("loadEligibilityStateByPrisma returns creatorAddress='' when the org has no wallet on file", async () => {
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 67 }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "",
    },
  );
  assert.ok(result);
  assert.equal(result.creatorAddress, "");
  // The eligibility check (separately tested) will translate this into a
  // creator_address_missing reason — so the user is told what's wrong.
});

// ============================================
// On-chain reputation precedence (plan A4)
// ============================================

test("loadEligibilityStateByPrisma: on-chain score takes precedence over publisherProfile when reader returns a value", async () => {
  setupEnv();
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        listing: {
          status: "published",
          agentToken: { id: "tok_1", mintAddress: "MintXYZ" },
        },
      },
    ],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 30 }], // off-chain "low"
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
      readOnChainReputation: async () => ({
        cumulativeUptimeSeconds: BigInt(7 * 86400),
        lastScore: 85, // on-chain "high"
        attestationCount: 14,
      }),
    },
  );
  assert.ok(result);
  assert.equal(result.reputationScore, 85);
});

test("loadEligibilityStateByPrisma: on-chain reader returns null → falls back to publisherProfile", async () => {
  setupEnv();
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        listing: {
          status: "published",
          agentToken: { id: "tok_1", mintAddress: "MintXYZ" },
        },
      },
    ],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 42 }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
      readOnChainReputation: async () => null, // PDA not yet initialized
    },
  );
  assert.ok(result);
  assert.equal(result.reputationScore, 42);
});

test("loadEligibilityStateByPrisma: on-chain reader throws → falls back silently to publisherProfile", async () => {
  setupEnv();
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        listing: {
          status: "published",
          agentToken: { id: "tok_1", mintAddress: "MintXYZ" },
        },
      },
    ],
    publisherProfiles: [{ orgId: "org_1", reputationScore: 55 }],
  });
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
      readOnChainReputation: async () => {
        throw new Error("rpc timeout");
      },
    },
  );
  assert.ok(result);
  assert.equal(result.reputationScore, 55);
});

test("loadEligibilityStateByPrisma: no mint (untokenized agent) → on-chain reader is NOT called", async () => {
  setupEnv();
  const { loadEligibilityStateByPrisma } = await import(
    "../services/loadEligibilityState.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent], // listing has agentToken: null
    publisherProfiles: [{ orgId: "org_1", reputationScore: 60 }],
  });
  let readerCalled = 0;
  const result = await loadEligibilityStateByPrisma(
    { agentId: "agent_1", orgId: "org_1", now: NOW },
    {
      prisma: stub.prisma as any,
      getCreatorAddress: async () => "P",
      readOnChainReputation: async () => {
        readerCalled += 1;
        return { cumulativeUptimeSeconds: BigInt(0), lastScore: 99, attestationCount: 0 };
      },
    },
  );
  assert.ok(result);
  assert.equal(readerCalled, 0);
  assert.equal(result.reputationScore, 60);
});
