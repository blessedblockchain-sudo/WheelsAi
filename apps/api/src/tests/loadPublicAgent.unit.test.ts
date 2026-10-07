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
    modelDeploymentId: string | null;
  }>;
  openclawDeployment: {
    channels: Array<{ platform: string; enabled: boolean }>;
  } | null;
  /** What the loader's own filter (enabled, not revoked, take 1) returned. */
  widgetKeys?: Array<{ allowedOrigins: string[] }>;
  listing: {
    id: string;
    publisherId: string;
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

interface FakeUsage {
  deploymentId: string;
  computeSeconds: bigint;
  requestCount: number;
}

function makePrismaStub(opts: {
  agents: FakeAgent[];
  payments?: FakePayment[];
  usage?: FakeUsage[];
}) {
  const observed: {
    agentArgs?: any;
    aggArgs?: any;
    manyArgs?: any;
    usageAggArgs?: any;
  } = {};
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
      usageRecord: {
        async aggregate({ where, _sum }: any) {
          observed.usageAggArgs = { where, _sum };
          const rows = (opts.usage ?? []).filter((u) =>
            where.deploymentId.in.includes(u.deploymentId),
          );
          let computeSeconds = 0n;
          let requestCount = 0;
          for (const r of rows) {
            computeSeconds += r.computeSeconds;
            requestCount += r.requestCount;
          }
          return {
            _sum: {
              computeSeconds: rows.length === 0 ? null : computeSeconds,
              requestCount: rows.length === 0 ? null : requestCount,
            },
          };
        },
      },
    },
  };
}

/**
 * Deps bundle for the loader: prisma stub + an eligibility check that
 * records its calls. Override `eligibility` for the throw/false cases.
 */
function makeDeps(
  stub: ReturnType<typeof makePrismaStub>,
  opts: {
    eligibility?: (listingId: string, publisherId: string) => Promise<{ eligible: boolean }>;
  } = {},
) {
  const eligibilityCalls: Array<{ listingId: string; publisherId: string }> = [];
  const deps = {
    prisma: stub.prisma as any,
    checkEligibility: async (listingId: string, publisherId: string) => {
      eligibilityCalls.push({ listingId, publisherId });
      if (opts.eligibility) return opts.eligibility(listingId, publisherId);
      return { eligible: true };
    },
  };
  return { deps, eligibilityCalls };
}

const baseAgent: FakeAgent = {
  id: "agent_1",
  isPublic: true,
  name: "Eliza",
  slug: "eliza",
  framework: "elizaos",
  createdAt: new Date("2026-04-20T00:00:00Z"),
  deployments: [
    { gpuTier: "4090", replicas: 2, status: "running", modelDeploymentId: "md_1" },
  ],
  openclawDeployment: {
    channels: [{ platform: "discord", enabled: true }],
  },
  listing: {
    id: "listing_1",
    publisherId: "org_pub",
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
    makeDeps(stub).deps,
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
    makeDeps(stub).deps,
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
    makeDeps(stub).deps,
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
    makeDeps(stub).deps,
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
    makeDeps(stub).deps,
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
    makeDeps(stub).deps,
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
    makeDeps(stub).deps,
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
    makeDeps(stub).deps,
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
    makeDeps(stub).deps,
  );
  assert.ok(result);
  // The shape's TypeScript type already excludes orgId. Sanity check no
  // accidental fields leaked into the return.
  for (const d of result.deployments) {
    assert.deepEqual(Object.keys(d).sort(), ["gpuTier", "replicas", "status"]);
  }
  for (const c of result.channels) {
    assert.deepEqual(Object.keys(c).sort(), ["enabled", "live", "platform"]);
  }
});

// ============================================
// Channel honesty: a channel is named live only when a message sent there
// reaches the agent
// ============================================

async function channelsOf(agent: FakeAgent) {
  const { loadPublicAgentByPrisma } = await import("../services/loadPublicAgent.js");
  const stub = makePrismaStub({ agents: [agent] });
  const result = await loadPublicAgentByPrisma({ slug: agent.slug, paymentsLimit: 10 }, makeDeps(stub).deps);
  assert.ok(result);
  return { channels: result.channels, stub, result };
}

test("the web channel is listed, live, when the agent has a web chat key that works", async () => {
  const { channels, stub } = await channelsOf({
    ...baseAgent,
    widgetKeys: [{ allowedOrigins: ["https://shop.example"] }],
  });
  assert.deepEqual(channels, [
    { platform: "discord", enabled: true, live: true },
    { platform: "web", enabled: true, live: true },
  ]);
  // Enabled and not revoked is decided in the query; whether a site can use
  // the key is read from its origins, so every such key is fetched.
  assert.deepEqual(stub.observed.agentArgs.include.widgetKeys, {
    where: { enabled: true, revokedAt: null },
    select: { allowedOrigins: true },
  });
});

test("a web chat key no site is allowed to use is configured, not live", async () => {
  // What the OpenClaw wizard's "Web Chat" option creates, and a key made in
  // the dashboard before a site is added: it answers 403 from every site.
  const { channels } = await channelsOf({ ...baseAgent, widgetKeys: [{ allowedOrigins: [] }] });
  assert.deepEqual(channels, [
    { platform: "discord", enabled: true, live: true },
    { platform: "web", enabled: true, live: false },
  ]);

  // It still stands in for a saved "web" platform row, once.
  const replaced = await channelsOf({
    ...baseAgent,
    openclawDeployment: { channels: [{ platform: "webchat", enabled: true }] },
    widgetKeys: [{ allowedOrigins: [] }],
  });
  assert.deepEqual(replaced.channels, [{ platform: "web", enabled: true, live: false }]);

  // One key with a site is enough, wherever it comes in the list.
  const mixed = await channelsOf({
    ...baseAgent,
    widgetKeys: [{ allowedOrigins: [] }, { allowedOrigins: ["https://shop.example"] }],
  });
  assert.deepEqual(mixed.channels.at(-1), { platform: "web", enabled: true, live: true });
});

test("no web chat key (none, or only revoked and disabled ones): the web channel is not listed", async () => {
  for (const widgetKeys of [undefined, []] as const) {
    const { channels } = await channelsOf({ ...baseAgent, widgetKeys: widgetKeys ? [...widgetKeys] : undefined });
    assert.deepEqual(channels.map((c) => c.platform), ["discord"]);
  }
});

test("platform rows with no working inbound path come back live:false, never as active channels", async () => {
  const { channels } = await channelsOf({
    ...baseAgent,
    openclawDeployment: {
      channels: [
        { platform: "discord", enabled: true },
        { platform: "telegram", enabled: false },
        { platform: "twitter", enabled: true },
        { platform: "web", enabled: true },
        { platform: "api", enabled: true },
      ],
    },
  });
  assert.deepEqual(channels, [
    { platform: "discord", enabled: true, live: true },
    // Switched off is not live, whatever the platform.
    { platform: "telegram", enabled: false, live: false },
    { platform: "twitter", enabled: true, live: false },
    // A "web" platform row is a saved wish; the widget key is the channel.
    { platform: "web", enabled: true, live: false },
    { platform: "api", enabled: true, live: false },
  ]);
});

test("a working web chat key replaces a saved 'web' platform row instead of listing the channel twice", async () => {
  const { channels, result } = await channelsOf({
    ...baseAgent,
    openclawDeployment: { channels: [{ platform: "web", enabled: true }] },
    widgetKeys: [{ allowedOrigins: ["https://shop.example"] }],
  });
  assert.deepEqual(channels, [{ platform: "web", enabled: true, live: true }]);
  // The sites a key allows are the owner's business, not the page's.
  assert.ok(!JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes("shop.example"));
});

// ============================================
// Uptime aggregate (plan A5) — Σ computeSeconds over the agent's
// model deployments, the same rows the attestation worker sums
// ============================================

test("loadPublicAgentByPrisma aggregates uptime across the agent's model deployments (deduped, null ids skipped)", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        deployments: [
          { gpuTier: "4090", replicas: 1, status: "running", modelDeploymentId: "md_1" },
          // Same model deployment referenced twice — must be deduped.
          { gpuTier: "4090", replicas: 1, status: "stopped", modelDeploymentId: "md_1" },
          { gpuTier: "A100", replicas: 1, status: "running", modelDeploymentId: "md_2" },
          // No model deployment — contributes nothing.
          { gpuTier: "T4", replicas: 1, status: "failed", modelDeploymentId: null },
        ],
      },
    ],
    usage: [
      { deploymentId: "md_1", computeSeconds: 3_600n, requestCount: 10 },
      { deploymentId: "md_2", computeSeconds: 1_800n, requestCount: 5 },
      // Another agent's deployment — must NOT be included.
      { deploymentId: "md_other", computeSeconds: 999_999n, requestCount: 999 },
    ],
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    makeDeps(stub).deps,
  );
  assert.ok(result);
  assert.equal(result.uptime?.totalComputeSeconds, 5_400n);
  assert.equal(result.uptime?.totalRequests, 15);
  assert.deepEqual(stub.observed.usageAggArgs.where.deploymentId.in.sort(), [
    "md_1",
    "md_2",
  ]);
});

test("loadPublicAgentByPrisma returns uptime=null when the agent has no model deployments (no empty IN clause)", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        deployments: [
          { gpuTier: "4090", replicas: 1, status: "running", modelDeploymentId: null },
        ],
      },
    ],
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    makeDeps(stub).deps,
  );
  assert.ok(result);
  assert.equal(result.uptime, null);
  assert.equal(stub.observed.usageAggArgs, undefined); // query skipped
});

test("loadPublicAgentByPrisma returns uptime zeros (not null) when deployments exist but have no usage yet", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent] }); // md_1, no usage rows
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    makeDeps(stub).deps,
  );
  assert.ok(result);
  assert.equal(result.uptime?.totalComputeSeconds, 0n);
  assert.equal(result.uptime?.totalRequests, 0);
});

// ============================================
// Eligibility badge (plan A5) — boolean only, listing-scoped
// ============================================

test("loadPublicAgentByPrisma checks eligibility with the listing's own id + publisherId", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent] });
  const { deps, eligibilityCalls } = makeDeps(stub);
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    deps,
  );
  assert.ok(result);
  assert.deepEqual(result.eligibility, { eligible: true });
  assert.deepEqual(eligibilityCalls, [
    { listingId: "listing_1", publisherId: "org_pub" },
  ]);
});

test("loadPublicAgentByPrisma returns eligibility=null when the agent has no listing", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({ agents: [{ ...baseAgent, listing: null }] });
  const { deps, eligibilityCalls } = makeDeps(stub);
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    deps,
  );
  assert.ok(result);
  assert.equal(result.eligibility, null);
  assert.deepEqual(eligibilityCalls, []);
});

test("loadPublicAgentByPrisma degrades eligibility to null when the check throws (public page must not 500)", async () => {
  const { loadPublicAgentByPrisma } = await import(
    "../services/loadPublicAgent.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent] });
  const { deps } = makeDeps(stub, {
    eligibility: async () => {
      throw new Error("eligibility backend down");
    },
  });
  const result = await loadPublicAgentByPrisma(
    { slug: "eliza", paymentsLimit: 10 },
    deps,
  );
  assert.ok(result);
  assert.equal(result.eligibility, null);
});
