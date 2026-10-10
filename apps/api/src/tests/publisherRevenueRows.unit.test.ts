// What the Earnings page is told about each recent row: a sale of use of the
// creator's own agent and a request charged on a buyer's copy are both
// "per_request" rows, and only the licence behind them tells them apart.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

type Row = Record<string, any>;

const ORG = "org_publisher";

async function revenueWith(rows: Row[], licences: Row[]) {
  const { prisma } = await import("../lib/prisma.js");
  const { getPublisherRevenue } = await import("../services/marketplace.js");
  const p = prisma as unknown as Record<string, Row>;
  const saved: Record<string, Row> = {};
  const licenceReads: Row[] = [];
  const swap = (model: string, stub: Row) => {
    saved[model] = { ...p[model] };
    Object.assign(p[model]!, stub);
  };
  swap("publisherProfile", {
    findUnique: async () => ({ orgId: ORG, totalRevenueCents: 0n, pendingPayoutCents: 0n, totalListings: 1, totalInstalls: 2 }),
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
  swap("creatorPayout", { findMany: async () => [] });
  try {
    return { revenue: (await getPublisherRevenue(ORG)) as Row, licenceReads };
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
