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

// Drives apps/api/src/services/loadPaymentsByPrisma.ts — Prisma-backed
// loader for GET /agents/:slug/payments. Resolves:
//
//   Agent (slug + orgId, scoped)
//     → agent.listing.agentToken.treasury.id   (payments belong here)
//   ComputePayment
//     where treasuryId = above
//       AND optional status filter
//       AND optional [from, to] window on scheduledFor
//
// Return contract (the route distinguishes these states):
//   null  → agent not found OR not tokenized OR no treasury (404)
//   { payments: [], totalCount: 0 } → tokenized agent, no payments yet (200)

type Status = "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";

interface FakeAgent {
  id: string;
  orgId: string;
  slug: string;
  listing: {
    agentToken: { treasury: { id: string } | null } | null;
  } | null;
}

interface FakePayment {
  id: string;
  treasuryId: string;
  amountLamports: bigint;
  computeSeconds: bigint;
  status: Status;
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
  const observed: {
    agentArgs?: any;
    findManyArgs?: any;
    countArgs?: any;
  } = {};
  const matches = (p: FakePayment, where: any): boolean => {
    if (p.treasuryId !== where.treasuryId) return false;
    if (where.status && p.status !== where.status) return false;
    if (where.scheduledFor?.gte && p.scheduledFor < where.scheduledFor.gte) return false;
    if (where.scheduledFor?.lte && p.scheduledFor > where.scheduledFor.lte) return false;
    return true;
  };
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
        async findMany({ where, orderBy, skip, take }: any) {
          observed.findManyArgs = { where, orderBy, skip, take };
          const all = (opts.payments ?? []).filter((p) => matches(p, where));
          const sorted = [...all].sort(
            (a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime(),
          );
          return sorted.slice(skip ?? 0, (skip ?? 0) + (take ?? sorted.length));
        },
        async count({ where }: any) {
          observed.countArgs = { where };
          return (opts.payments ?? []).filter((p) => matches(p, where)).length;
        },
      },
    },
  };
}

const baseAgent: FakeAgent = {
  id: "agent_1",
  orgId: "org_1",
  slug: "eliza",
  listing: { agentToken: { treasury: { id: "treas_1" } } },
};

const samplePayment = (overrides: Partial<FakePayment> = {}): FakePayment => ({
  id: "cp_1",
  treasuryId: "treas_1",
  amountLamports: 4_500_000n,
  computeSeconds: 3600n,
  status: "CONFIRMED",
  txSignature: "sig_1",
  paidAt: new Date("2026-04-26T11:00:00Z"),
  scheduledFor: new Date("2026-04-26T10:55:00Z"),
  errorMessage: null,
  createdAt: new Date("2026-04-26T10:55:00Z"),
  ...overrides,
});

// ============================================
// Lookup + scoping
// ============================================

test("loadPaymentsByPrisma returns null when agent does not exist", async () => {
  setupEnv();
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [] });
  const result = await loadPaymentsByPrisma(
    {
      slug: "missing",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
});

test("loadPaymentsByPrisma returns null on cross-org access", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, orgId: "org_other" }],
  });
  const result = await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(result, null);
  assert.equal(stub.observed.agentArgs.where.orgId, "org_1");
});

// ============================================
// Treasury gates (null = "no payments path")
// ============================================

test("loadPaymentsByPrisma returns an empty page when the agent has no listing", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: null }],
  });
  const result = await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  // The agent exists; it just has nothing to pay from yet.
  assert.deepEqual(result, { payments: [], totalCount: 0 });
  // Skip the payment query — agent isn't tokenized.
  assert.equal(stub.observed.findManyArgs, undefined);
  assert.equal(stub.observed.countArgs, undefined);
});

test("loadPaymentsByPrisma returns an empty page when the listing has no agentToken (not tokenized yet)", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({
    agents: [{ ...baseAgent, listing: { agentToken: null } }],
  });
  const result = await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, { payments: [], totalCount: 0 });
});

test("loadPaymentsByPrisma returns an empty page when the token has no treasury yet", async () => {
  // A token can exist on pump.fun before its on-chain treasury PDA has
  // been initialized. Until then there are no payments to list.
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({
    agents: [
      {
        ...baseAgent,
        listing: { agentToken: { treasury: null } },
      },
    ],
  });
  const result = await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, { payments: [], totalCount: 0 });
  assert.equal(stub.observed.findManyArgs, undefined);
});

// ============================================
// Tokenized agent with treasury
// ============================================

test("loadPaymentsByPrisma returns { payments: [], totalCount: 0 } when treasury has no payments yet", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments: [] });
  const result = await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, { payments: [], totalCount: 0 });
});

test("loadPaymentsByPrisma scopes the payment query by the resolved treasuryId (not slug)", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments: [] });
  await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.findManyArgs.where.treasuryId, "treas_1");
  assert.equal(stub.observed.countArgs.where.treasuryId, "treas_1");
});

test("loadPaymentsByPrisma maps DB rows into PaymentRow shape preserving BigInts", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({
    agents: [baseAgent],
    payments: [samplePayment()],
  });
  const result = await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(result?.totalCount, 1);
  const p = result!.payments[0]!;
  assert.equal(p.id, "cp_1");
  assert.equal(typeof p.amountLamports, "bigint");
  assert.equal(p.amountLamports, 4_500_000n);
  assert.equal(typeof p.computeSeconds, "bigint");
  assert.equal(p.computeSeconds, 3600n);
  assert.equal(p.status, "CONFIRMED");
  assert.ok(p.scheduledFor instanceof Date);
});

// ============================================
// Pagination
// ============================================

test("loadPaymentsByPrisma applies limit + offset via skip/take", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments: [] });
  await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 50,
      offset: 100,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.findManyArgs.take, 50);
  assert.equal(stub.observed.findManyArgs.skip, 100);
});

test("loadPaymentsByPrisma returns totalCount independent of the page size", async () => {
  // Build 5 payments; ask for page-of-2 → totalCount should still be 5.
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const payments: FakePayment[] = Array.from({ length: 5 }, (_, i) =>
    samplePayment({
      id: `cp_${i}`,
      scheduledFor: new Date(`2026-04-${20 + i}T10:00:00Z`),
    }),
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments });
  const result = await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 2,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(result?.payments.length, 2);
  assert.equal(result?.totalCount, 5);
});

// ============================================
// Status filter
// ============================================

test("loadPaymentsByPrisma forwards a recognized status filter to the where clause", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments: [] });
  await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: "FAILED",
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.findManyArgs.where.status, "FAILED");
  // count uses the same where (so totalCount matches the filtered page).
  assert.equal(stub.observed.countArgs.where.status, "FAILED");
});

test("loadPaymentsByPrisma omits the status key when status is null", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments: [] });
  await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  // Prisma where clauses with `status: undefined` work, but explicitly
  // omitting the key keeps the SQL clean and the index hits predictable.
  assert.equal("status" in stub.observed.findManyArgs.where, false);
  assert.equal("status" in stub.observed.countArgs.where, false);
});

// ============================================
// Date range
// ============================================

test("loadPaymentsByPrisma forwards from/to as a scheduledFor window", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments: [] });
  const from = new Date("2026-04-26T00:00:00Z");
  const to = new Date("2026-04-26T23:59:59Z");
  await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from,
      to,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(
    (stub.observed.findManyArgs.where.scheduledFor.gte as Date).toISOString(),
    from.toISOString(),
  );
  assert.equal(
    (stub.observed.findManyArgs.where.scheduledFor.lte as Date).toISOString(),
    to.toISOString(),
  );
});

test("loadPaymentsByPrisma omits the scheduledFor filter when from/to are both null", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments: [] });
  await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.equal("scheduledFor" in stub.observed.findManyArgs.where, false);
});

test("loadPaymentsByPrisma forwards only `from` when `to` is null", async () => {
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments: [] });
  const from = new Date("2026-04-26T00:00:00Z");
  await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    Object.keys(stub.observed.findManyArgs.where.scheduledFor),
    ["gte"],
  );
});

// ============================================
// Order
// ============================================

test("loadPaymentsByPrisma orders payments newest first by scheduledFor desc", async () => {
  // History view — the dashboard reads top of the list as "most recent".
  const { loadPaymentsByPrisma } = await import(
    "../services/loadPaymentsByPrisma.js"
  );
  const stub = makePrismaStub({ agents: [baseAgent], payments: [] });
  await loadPaymentsByPrisma(
    {
      slug: "eliza",
      orgId: "org_1",
      limit: 20,
      offset: 0,
      status: null,
      from: null,
      to: null,
    },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(stub.observed.findManyArgs.orderBy, {
    scheduledFor: "desc",
  });
});
