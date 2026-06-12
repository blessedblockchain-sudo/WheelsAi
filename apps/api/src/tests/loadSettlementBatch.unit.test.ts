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

// Drives apps/api/src/services/loadSettlementBatch.ts — the Prisma-backed
// impl the BullMQ worker uses to find agents whose treasuries are due for
// settlement. Returns the same {deployments, treasuries} shape the
// orchestrator (treasurySettlementCycle) consumes.
//
// Eligibility:
//   - AgentDeployment.status === "running"
//   - Agent.listing.agentToken exists                     (tokenized agent)
//   - AgentToken.treasury exists                          (treasury PDA initialized)
//   - treasury.lastComputeBillAt is NULL                  (never settled)
//     OR treasury.lastComputeBillAt < (now - intervalMs)  (cooldown elapsed)
//   - treasury.balanceSyncedAt is non-null AND within
//     maxBalanceStalenessMs of now                        (D1 staleness guard)
//
// The staleness guard exists because solBalanceLamports is a MIRROR
// written by runTreasuryBalanceSyncTick — a stale or never-written mirror
// means SKIP (counted in skippedStale), never "assume 0".

const LAMPORTS_PER_SOL = 1_000_000_000n;

interface FakeAgentDeployment {
  id: string;
  status: string;
  gpuTier: string;
  nosanaJobIds: string[];
  replicas: number;
  agent: {
    id: string;
    orgId: string;
    listing: {
      agentToken: {
        id: string;
        treasury: {
          id: string;
          tokenId: string;
          treasuryPdaAddress: string;
          solBalanceLamports: bigint;
          lastComputeBillAt: Date | null;
          balanceSyncedAt: Date | null;
        } | null;
      } | null;
    } | null;
  };
}

function makePrismaStub(rows: FakeAgentDeployment[]) {
  let observed: any = null;
  return {
    observed: () => observed,
    prisma: {
      agentDeployment: {
        async findMany({ where, include }: any) {
          observed = { where, include };
          return rows.filter(
            (r) => !where?.status || r.status === where.status,
          );
        },
      },
    },
  };
}

const NOW = new Date("2026-04-26T12:00:00Z");
const INTERVAL_MS = 60 * 60 * 1000;

const baseDeployment = (overrides: Partial<FakeAgentDeployment> = {}): FakeAgentDeployment => ({
  id: "dep_1",
  status: "running",
  gpuTier: "4090",
  nosanaJobIds: ["job_a"],
  replicas: 1,
  agent: {
    id: "agent_1",
    orgId: "org_1",
    listing: {
      agentToken: {
        id: "tok_1",
        treasury: {
          id: "treasury_1",
          tokenId: "tok_1",
          treasuryPdaAddress: "PDA",
          solBalanceLamports: LAMPORTS_PER_SOL,
          lastComputeBillAt: null,
          // Freshly synced mirror (D1) so the staleness guard admits
          // the row; staleness-specific tests override this.
          balanceSyncedAt: NOW,
        },
      },
    },
  },
  ...overrides,
});

// ============================================
// Empty / status filter
// ============================================

test("loadSettlementBatchByPrisma returns empty when no rows match", async () => {
  setupEnv();
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const stub = makePrismaStub([]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.deployments.length, 0);
  assert.equal(result.treasuries.size, 0);
});

test("loadSettlementBatchByPrisma scopes the query to status=running", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const stub = makePrismaStub([
    baseDeployment({ id: "running", status: "running" }),
    baseDeployment({ id: "stopped", status: "stopped" }),
  ]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed().where.status, "running");
  assert.deepEqual(
    result.deployments.map((d) => d.id),
    ["running"],
  );
});

// ============================================
// Token + treasury existence
// ============================================

test("loadSettlementBatchByPrisma excludes deployments whose agent has no listing/token", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const noListing = baseDeployment({
    id: "no_listing",
    agent: { id: "a", orgId: "org_1", listing: null },
  });
  const noToken = baseDeployment({
    id: "no_token",
    agent: {
      id: "a2",
      orgId: "org_1",
      listing: { agentToken: null },
    },
  });
  const stub = makePrismaStub([
    noListing,
    noToken,
    baseDeployment({ id: "ok" }),
  ]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.deployments.map((d) => d.id),
    ["ok"],
  );
});

test("loadSettlementBatchByPrisma excludes tokens that have no treasury PDA yet", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const tokenNoTreasury = baseDeployment({
    id: "no_treasury",
    agent: {
      id: "a",
      orgId: "org_1",
      listing: { agentToken: { id: "tok_x", treasury: null } },
    },
  });
  const stub = makePrismaStub([tokenNoTreasury, baseDeployment({ id: "ok" })]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.deployments.map((d) => d.id),
    ["ok"],
  );
});

// ============================================
// Cooldown
// ============================================

test("loadSettlementBatchByPrisma includes treasuries with lastComputeBillAt = null", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const stub = makePrismaStub([baseDeployment({ id: "fresh" })]); // null by default
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.deployments.length, 1);
});

test("loadSettlementBatchByPrisma excludes treasuries settled inside the cooldown window", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const recent = baseDeployment({ id: "recent" });
  recent.agent.listing!.agentToken!.treasury!.lastComputeBillAt = new Date(
    "2026-04-26T11:30:00Z", // 30 min ago, interval is 60 min
  );
  const stub = makePrismaStub([recent]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.deployments.length, 0);
});

test("loadSettlementBatchByPrisma includes treasuries settled before the cooldown cutoff", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const old = baseDeployment({ id: "due" });
  old.agent.listing!.agentToken!.treasury!.lastComputeBillAt = new Date(
    "2026-04-26T10:30:00Z", // 90 min ago, interval is 60 min
  );
  const stub = makePrismaStub([old]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.deployments.length, 1);
});

// ============================================
// D1 staleness guard
// ============================================

test("loadSettlementBatchByPrisma skips a treasury whose balance was never synced (balanceSyncedAt null)", async () => {
  // The schema default: balanceSyncedAt is null until the first
  // runTreasuryBalanceSyncTick write. Settling against the default-0
  // solBalanceLamports would fabricate insufficient_funds failures.
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const neverSynced = baseDeployment({ id: "never_synced" });
  neverSynced.agent.listing!.agentToken!.treasury!.balanceSyncedAt = null;
  const stub = makePrismaStub([neverSynced, baseDeployment({ id: "ok" })]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.deployments.map((d) => d.id),
    ["ok"],
  );
  assert.equal(result.skippedStale, 1);
});

test("loadSettlementBatchByPrisma skips a treasury whose balance mirror is older than the default 5-minute ceiling", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const stale = baseDeployment({ id: "stale" });
  stale.agent.listing!.agentToken!.treasury!.balanceSyncedAt = new Date(
    NOW.getTime() - 6 * 60 * 1000, // 6 min ago > 5 min default
  );
  const stub = makePrismaStub([stale]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.deployments.length, 0);
  assert.equal(result.skippedStale, 1);
});

test("loadSettlementBatchByPrisma includes a treasury synced inside the staleness ceiling", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const fresh = baseDeployment({ id: "fresh" });
  fresh.agent.listing!.agentToken!.treasury!.balanceSyncedAt = new Date(
    NOW.getTime() - 4 * 60 * 1000, // 4 min ago < 5 min default
  );
  const stub = makePrismaStub([fresh]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.deployments.length, 1);
  assert.equal(result.skippedStale, 0);
});

test("loadSettlementBatchByPrisma honors an injected maxBalanceStalenessMs", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const row = baseDeployment({ id: "two_min_old" });
  row.agent.listing!.agentToken!.treasury!.balanceSyncedAt = new Date(
    NOW.getTime() - 2 * 60 * 1000, // 2 min ago
  );
  const stub = makePrismaStub([row]);

  // 1-minute ceiling → the 2-minute-old mirror is stale.
  const tight = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS, maxBalanceStalenessMs: 60_000 },
    { prisma: stub.prisma as any },
  );
  assert.equal(tight.deployments.length, 0);
  assert.equal(tight.skippedStale, 1);

  // 10-minute ceiling → the same mirror is fresh.
  const loose = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS, maxBalanceStalenessMs: 10 * 60_000 },
    { prisma: stub.prisma as any },
  );
  assert.equal(loose.deployments.length, 1);
  assert.equal(loose.skippedStale, 0);
});

test("loadSettlementBatchByPrisma counts skippedStale only for stale mirrors, not other exclusions", async () => {
  // A row excluded by the cooldown (or with no token/treasury) is not a
  // staleness skip — the counter must isolate the D1 guard so the cycle
  // counters stay diagnosable.
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const cooldown = baseDeployment({ id: "cooldown" });
  cooldown.agent.listing!.agentToken!.treasury!.lastComputeBillAt = new Date(
    "2026-04-26T11:30:00Z", // 30 min ago, interval 60 min → cooldown skip
  );
  const stale = baseDeployment({ id: "stale" });
  stale.agent.listing!.agentToken!.treasury!.balanceSyncedAt = null;
  const stub = makePrismaStub([
    cooldown,
    stale,
    baseDeployment({ id: "ok" }),
  ]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.deployments.map((d) => d.id),
    ["ok"],
  );
  assert.equal(result.skippedStale, 1);
});

// ============================================
// Mapping shape
// ============================================

test("loadSettlementBatchByPrisma maps Prisma rows into DeploymentForSettlement + Treasury Map keyed by agentTokenId", async () => {
  const { loadSettlementBatchByPrisma } = await import(
    "../services/loadSettlementBatch.js"
  );
  const row = baseDeployment({
    id: "dep_42",
    gpuTier: "h100",
    nosanaJobIds: ["job_x", "job_y"],
    replicas: 2,
    agent: {
      id: "agent_42",
      orgId: "org_42",
      listing: {
        agentToken: {
          id: "tok_42",
          treasury: {
            id: "treas_42",
            tokenId: "tok_42",
            treasuryPdaAddress: "PDA42",
            solBalanceLamports: 5_000_000_000n,
            lastComputeBillAt: null,
            balanceSyncedAt: NOW,
          },
        },
      },
    },
  });
  const stub = makePrismaStub([row]);
  const result = await loadSettlementBatchByPrisma(
    { now: NOW, intervalMs: INTERVAL_MS },
    { prisma: stub.prisma as any },
  );

  assert.equal(result.deployments.length, 1);
  const d = result.deployments[0]!;
  assert.equal(d.id, "dep_42");
  assert.equal(d.orgId, "org_42");
  assert.equal(d.gpuTier, "h100");
  assert.equal(d.replicas, 2);
  assert.deepEqual(d.nosanaJobIds, ["job_x", "job_y"]);
  assert.equal(d.agentTokenId, "tok_42");

  // Treasury map keyed by agentTokenId so the cycle can do O(1) lookup.
  const t = result.treasuries.get("tok_42");
  assert.ok(t, "treasury for tok_42 should be present");
  assert.equal(t.id, "treas_42");
  assert.equal(t.tokenId, "tok_42");
  assert.equal(t.solBalanceLamports, 5_000_000_000n);
  assert.equal(t.treasuryPdaAddress, "PDA42");
});
