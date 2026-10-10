// What the Earnings page is told about each recent row: a sale of use of the
// creator's own agent and a request charged on a buyer's copy are both
// "per_request" rows, and only the licence behind them tells them apart.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

type Row = Record<string, any>;

const ORG = "org_publisher";

async function revenueWith(
  rows: Row[],
  licences: Row[],
  payouts: { balanceCents?: bigint; walletUsedTodayCents?: bigint | null; hasProfile?: boolean } = {},
) {
  const { prisma } = await import("../lib/prisma.js");
  const { getPublisherRevenue } = await import("../services/marketplace.js");
  const p = prisma as unknown as Record<string, Row>;
  const saved: Record<string, Row> = {};
  const licenceReads: Row[] = [];
  const usedTodayReads: Row[] = [];
  const swap = (model: string, stub: Row) => {
    saved[model] = { ...p[model] };
    Object.assign(p[model]!, stub);
  };
  swap("publisherProfile", {
    findUnique: async () =>
      payouts.hasProfile === false
        ? null
        : {
            orgId: ORG,
            totalRevenueCents: 0n,
            pendingPayoutCents: payouts.balanceCents ?? 0n,
            totalListings: 1,
            totalInstalls: 2,
          },
  });
  swap("marketplaceRevenue", {
    groupBy: async () => [],
    aggregate: async () => ({ _sum: { creatorAmountCents: null }, _count: { _all: 0 } }),
    findMany: async () => rows,
  });
  swap("agentListing", { findMany: async () => [] });
  swap("agentInstall", {
    findMany: async (args: Row) => {
      licenceReads.push(args);
      return licences.filter((licence) => args.where.id.in.includes(licence.id));
    },
  });
  swap("creatorPayout", {
    findMany: async () => [],
    // What this creator has taken to a wallet today, for `payoutLimits`.
    aggregate: async (args: Row) => {
      usedTodayReads.push(args);
      return { _sum: { amountCents: payouts.walletUsedTodayCents ?? null } };
    },
  });
  try {
    return { revenue: (await getPublisherRevenue(ORG)) as Row, licenceReads, usedTodayReads };
  } finally {
    for (const [model, methods] of Object.entries(saved)) Object.assign(p[model]!, methods);
  }
}

function row(over: Row): Row {
  return {
    id: "rev_1",
    type: "per_request",
    grossAmountCents: 5n,
    platformFeeCents: 1n,
    creatorAmountCents: 4n,
    requestCount: 1,
    status: "settled",
    jobId: null,
    installId: null,
    modelCostCents: 0n,
    createdAt: new Date("2026-10-10T10:00:00Z"),
    ...over,
  };
}

test("each recent row says what its licence is for: use, a copy, or nothing", async () => {
  const { revenue, licenceReads } = await revenueWith(
    [
      row({ id: "rev_use", installId: "lic_use" }),
      row({ id: "rev_copy", installId: "lic_copy" }),
      row({ id: "rev_job", type: "job", jobId: "job_1", installId: null }),
      row({ id: "rev_gone", installId: "lic_gone" }),
    ],
    [
      { id: "lic_use", kind: "use" },
      { id: "lic_copy", kind: "copy" },
    ],
  );
  const kinds = Object.fromEntries(revenue.recentTransactions.map((t: Row) => [t.id, t.licenceKind]));
  assert.deepEqual(kinds, { rev_use: "use", rev_copy: "copy", rev_job: null, rev_gone: null });
  // One read for all the rows, of the two columns it needs and nothing of the buyer.
  assert.equal(licenceReads.length, 1);
  assert.deepEqual(licenceReads[0]!.select, { id: true, kind: true });
  assert.deepEqual([...licenceReads[0]!.where.id.in].sort(), ["lic_copy", "lic_gone", "lic_use"]);
  for (const t of revenue.recentTransactions) assert.equal("installId" in t, false, "the licence id itself is not sent");
});

test("with no licence behind any row, no licence is read", async () => {
  const { revenue, licenceReads } = await revenueWith([row({ id: "rev_job", type: "job", jobId: "job_1" })], []);
  assert.equal(licenceReads.length, 0);
  assert.equal(revenue.recentTransactions[0].licenceKind, null);
});

// ---------------------------------------------------------------
// payoutLimits: what can be taken out right now
// ---------------------------------------------------------------

test("the revenue answer carries payoutLimits, worked out from the balance, the settings and today's wallet payouts", async () => {
  const { env } = await import("../config/env.js");
  const e = env as unknown as Record<string, unknown>;
  const saved = {
    perPayout: e.PAYOUT_MAX_PER_PAYOUT_USD,
    perDay: e.PAYOUT_MAX_PER_DAY_USD,
    source: e.SOL_PRICE_SOURCE,
  };
  e.PAYOUT_MAX_PER_PAYOUT_USD = 500;
  e.PAYOUT_MAX_PER_DAY_USD = 1000;
  try {
    e.SOL_PRICE_SOURCE = "off";
    const { revenue, usedTodayReads } = await revenueWith([], [], { balanceCents: 74_000n, walletUsedTodayCents: 12_000n });
    assert.equal(revenue.pendingPayoutCents, 74_000, "today's answer is still there");
    assert.deepEqual(revenue.payoutLimits, {
      minimumCents: 500,
      perPayoutCents: 50_000,
      perDayCents: 100_000,
      usedTodayCents: 12_000,
      largestNowCents: { credits: 74_000, wallet: 50_000 },
      methods: ["credits", "crypto_usdc"],
    });
    // One read: this creator's wallet payouts since midnight UTC that were not given back.
    assert.equal(usedTodayReads.length, 1);
    const where = usedTodayReads[0]!.where;
    assert.equal(where.publisherId, ORG);
    assert.deepEqual(where.payoutMethod, { in: ["crypto_usdc", "crypto_sol"] });
    assert.deepEqual(where.status, { in: ["pending", "processing", "completed"] });
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    assert.ok(Math.abs(where.requestedAt.gte.getTime() - midnight.getTime()) < 2000, "since midnight UTC");
    assert.equal(where.requestedAt.gte.getUTCHours() + where.requestedAt.gte.getUTCMinutes(), 0);

    // SOL is offered once it can be priced.
    e.SOL_PRICE_SOURCE = "pyth";
    const priced = await revenueWith([], [], { balanceCents: 310n });
    assert.deepEqual(priced.revenue.payoutLimits.methods, ["credits", "crypto_usdc", "crypto_sol"]);
    assert.deepEqual(priced.revenue.payoutLimits.largestNowCents, { credits: 310, wallet: 310 });
    assert.equal(priced.revenue.payoutLimits.usedTodayCents, 0);

    // What is left of the day holds the wallet amount, not credits.
    const late = await revenueWith([], [], { balanceCents: 74_000n, walletUsedTodayCents: 97_000n });
    assert.deepEqual(late.revenue.payoutLimits.largestNowCents, { credits: 74_000, wallet: 3_000 });
  } finally {
    e.PAYOUT_MAX_PER_PAYOUT_USD = saved.perPayout;
    e.PAYOUT_MAX_PER_DAY_USD = saved.perDay;
    e.SOL_PRICE_SOURCE = saved.source;
  }
});

test("a creator with no profile still gets payoutLimits: nothing to take, the limits as they are", async () => {
  const { revenue } = await revenueWith([], [], { hasProfile: false });
  assert.equal(revenue.pendingPayoutCents, 0);
  assert.equal(revenue.payoutLimits.minimumCents, 500);
  assert.deepEqual(revenue.payoutLimits.largestNowCents, { credits: 0, wallet: 0 });
  assert.equal(revenue.payoutLimits.usedTodayCents, 0);
  assert.ok(revenue.payoutLimits.methods.includes("credits") && revenue.payoutLimits.methods.includes("crypto_usdc"));
});
