import assert from "node:assert/strict";
import test from "node:test";

import {
  accruePendingContributorEarnings,
  computeContributorSplit,
  ContributorShareError,
  splitCreatorRevenue,
  type ContributorSplitTx,
  type PendingAccrualTx,
} from "../services/contributorSplits.js";
import { settleMarketplaceRequest, type MarketplaceCharge } from "../services/marketplaceMetering.js";
import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

// Contributor revenue splits (claims ledger M7). Accepted contributors are
// paid their share of creator revenue into the org they own, at the moment
// the revenue settles; the publisher keeps the rest.

test("shares floor to the cent and the publisher keeps the remainder", () => {
  assert.deepEqual(computeContributorSplit(1_000n, [2_500, 1_000]), { amounts: [250n, 100n], publisherCents: 650n });
  assert.deepEqual(computeContributorSplit(333n, [3_333]), { amounts: [110n], publisherCents: 223n });
  assert.deepEqual(computeContributorSplit(10n, [10_000]), { amounts: [10n], publisherCents: 0n });
  // Stored shares over 100% can never pay out more than the revenue.
  assert.deepEqual(computeContributorSplit(100n, [8_000, 8_000]), { amounts: [80n, 20n], publisherCents: 0n });
});

interface Contributor {
  id: string;
  userId: string;
  revenueShareBps: number;
  accepted: boolean;
}

function makeTx(opts: { contributors: Contributor[]; ownedOrgs: Record<string, string>; profiles?: string[] }) {
  const profiles = new Map<string, { total: bigint; pending: bigint }>(
    (opts.profiles ?? ["org_pub"]).map((orgId) => [orgId, { total: 0n, pending: 0n }]),
  );
  const earnings: Array<Record<string, unknown>> = [];
  // The ledger rows: one for every amount added to a balance.
  const ledger: EarningsRow[] = [];
  const tx: ContributorSplitTx = {
    ...earningsStandIn({
      pending: (orgId) => profiles.get(orgId)?.pending,
      add: (orgId, pending, total) => {
        const p = profiles.get(orgId)!;
        p.pending += pending;
        p.total += total;
      },
      write: (row) => ledger.push(row),
    }),
    agentListing: { findUnique: async () => ({ agentId: "agent_1" }) },
    agentContributor: {
      findMany: async ({ where }) =>
        opts.contributors
          .filter((c) => c.accepted && c.revenueShareBps > where.revenueShareBps.gt)
          .map(({ id, userId, revenueShareBps }) => ({ id, userId, revenueShareBps })),
    },
    organization: {
      findFirst: async ({ where }) =>
        opts.ownedOrgs[where.ownerId] ? { id: opts.ownedOrgs[where.ownerId]!, name: "Contributor Org" } : null,
    },
    contributorEarning: {
      create: async ({ data }) => {
        earnings.push(data);
        return data;
      },
    },
  };
  return { tx, profiles, earnings, ledger };
}

const NOW = new Date("2026-10-06T12:00:00Z");
const ARGS = { revenueId: "rev_1", listingId: "lst_1", publisherId: "org_pub", creatorCents: 900n, now: NOW };

test("accepted contributors are paid into the org they own, with an earning row each", async () => {
  const { tx, profiles, earnings, ledger } = makeTx({
    contributors: [
      { id: "c1", userId: "u_alice", revenueShareBps: 2_000, accepted: true },
      { id: "c2", userId: "u_bob", revenueShareBps: 1_000, accepted: true },
    ],
    ownedOrgs: { u_alice: "org_alice", u_bob: "org_bob" },
    profiles: ["org_pub", "org_alice", "org_bob"],
  });

  const result = await splitCreatorRevenue(tx, ARGS);

  assert.equal(result.publisherCents, 630n);
  assert.deepEqual(
    result.paid.map((p) => [p.recipientOrgId, p.amountCents]),
    [["org_alice", 180n], ["org_bob", 90n]],
  );
  assert.equal(profiles.get("org_alice")!.pending, 180n);
  assert.equal(profiles.get("org_bob")!.pending, 90n);
  // A share is income: it counts toward the contributor's lifetime revenue too.
  assert.equal(profiles.get("org_alice")!.total, 180n);
  assert.equal(profiles.get("org_bob")!.total, 90n);
  // One ledger row per share, against the revenue row it came from. The
  // publisher's own amount is the caller's to credit: no row for it here.
  assert.deepEqual(ledger, [
    {
      orgId: "org_alice",
      amountCents: 180n,
      type: "contributor_share",
      referenceId: "rev_1",
      description: "Contributor share of a sale",
      balanceAfter: 180n,
    },
    {
      orgId: "org_bob",
      amountCents: 90n,
      type: "contributor_share",
      referenceId: "rev_1",
      description: "Contributor share of a sale",
      balanceAfter: 90n,
    },
  ]);
  assert.equal(profiles.get("org_pub")!.pending, 0n);
  assert.deepEqual(earnings[0], {
    revenueId: "rev_1",
    agentId: "agent_1",
    contributorId: "c1",
    userId: "u_alice",
    recipientOrgId: "org_alice",
    publisherId: "org_pub",
    shareBps: 2_000,
    amountCents: 180n,
    accruedAt: NOW,
  });
  assert.deepEqual(result.pending, []);
});

test("a contributor without a payout profile is still owed their share: recorded, not kept by the publisher", async () => {
  const { tx, earnings, profiles, ledger } = makeTx({
    contributors: [{ id: "c1", userId: "u_alice", revenueShareBps: 2_000, accepted: true }],
    ownedOrgs: { u_alice: "org_alice" },
    profiles: ["org_pub"],
  });
  // The money transaction never inserts a profile (a unique violation
  // would abort it); it records the share as owed instead.
  assert.equal((tx.publisherProfile as unknown as { create?: unknown }).create, undefined);
  const result = await splitCreatorRevenue(tx, ARGS);
  assert.equal(result.publisherCents, 720n);
  assert.deepEqual(result.paid, []);
  assert.deepEqual(result.pending, [{ userId: "u_alice", recipientOrgId: "org_alice", amountCents: 180n }]);
  assert.equal(earnings.length, 1);
  assert.deepEqual(
    { amount: earnings[0]!.amountCents, org: earnings[0]!.recipientOrgId, accruedAt: earnings[0]!.accruedAt },
    { amount: 180n, org: "org_alice", accruedAt: null },
  );
  assert.equal(profiles.has("org_alice"), false);
  // Nothing was added to any balance, so the ledger has no row.
  assert.deepEqual(ledger, []);
});

test("a profile that vanishes between the check and the credit throws, so the money transaction rolls back", async () => {
  const { tx, earnings, ledger } = makeTx({
    contributors: [{ id: "c1", userId: "u_alice", revenueShareBps: 2_000, accepted: true }],
    ownedOrgs: { u_alice: "org_alice" },
    profiles: ["org_pub", "org_alice"],
  });
  // The check sees the profile; the credit a statement later does not.
  const gone: ContributorSplitTx = {
    ...tx,
    publisherProfile: { ...tx.publisherProfile, updateMany: async () => ({ count: 0 }) },
  };
  // The ledger's own read after a failed credit finds no profile either.
  const findUnique = tx.publisherProfile.findUnique as (args: {
    where: { orgId: string };
    select: object;
  }) => Promise<unknown>;
  gone.publisherProfile.findUnique = (async (args: { where: { orgId: string }; select: object }) =>
    "orgId" in args.select ? findUnique(args) : null) as ContributorSplitTx["publisherProfile"]["findUnique"];
  await assert.rejects(
    splitCreatorRevenue(gone, ARGS),
    (err: unknown) => err instanceof ContributorShareError && err.orgId === "org_alice",
  );
  assert.deepEqual(ledger, []);
  assert.equal(earnings.length, 0);
});

test("pending invitations and shares owned by the publisher pay nothing; a contributor with no org yet is owed", async () => {
  const { tx, earnings, ledger } = makeTx({
    contributors: [
      { id: "c1", userId: "u_pending", revenueShareBps: 5_000, accepted: false },
      { id: "c2", userId: "u_owner", revenueShareBps: 2_000, accepted: true },
      { id: "c3", userId: "u_orgless", revenueShareBps: 1_000, accepted: true },
    ],
    ownedOrgs: { u_pending: "org_p", u_owner: "org_pub" },
  });
  const result = await splitCreatorRevenue(tx, ARGS);
  assert.equal(result.publisherCents, 810n);
  assert.deepEqual(result.pending, [{ userId: "u_orgless", recipientOrgId: null, amountCents: 90n }]);
  assert.equal(earnings.length, 1);
  assert.equal(earnings[0]!.accruedAt, null);
  assert.deepEqual(ledger, []);
});

// An invitation sent to an email has no account until it is accepted;
// accepted rows always do. A row without one is never paid to anybody.
test("a contributor row bound to no account is skipped", async () => {
  const { tx, earnings } = makeTx({
    contributors: [{ id: "c1", userId: null as unknown as string, revenueShareBps: 5_000, accepted: true }],
    ownedOrgs: {},
  });
  const result = await splitCreatorRevenue(tx, ARGS);
  assert.equal(result.publisherCents, 900n);
  assert.equal(earnings.length, 0);
});

// ============================================
// Accruing owed shares
// ============================================

function makeAccrual(rows: Array<{ id: string; amountCents: bigint; accruedAt?: Date | null }>, profiles: string[]) {
  const earnings = new Map(rows.map((r) => [r.id, { accruedAt: null as Date | null, recipientOrgId: null as string | null, ...r }]));
  const balances = new Map(profiles.map((orgId) => [orgId, 0n]));
  const totals = new Map(profiles.map((orgId) => [orgId, 0n]));
  const ledger: EarningsRow[] = [];
  const tx: PendingAccrualTx = {
    ...earningsStandIn({
      pending: (orgId) => balances.get(orgId),
      add: (orgId, pending, total) => {
        balances.set(orgId, balances.get(orgId)! + pending);
        totals.set(orgId, totals.get(orgId)! + total);
      },
      write: (row) => ledger.push(row),
    }),
    contributorEarning: {
      updateMany: async ({ where, data }) => {
        const row = earnings.get(where.id);
        if (!row || row.accruedAt !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  const deps = {
    listPending: async () =>
      [...earnings.values()].filter((e) => e.accruedAt === null).map(({ id, amountCents }) => ({ id, amountCents })),
    // Snapshot/restore stands in for the transaction's rollback.
    inTransaction: async <T>(fn: (t: PendingAccrualTx) => Promise<T>): Promise<T> => {
      const before = structuredClone([...earnings.entries()]);
      try {
        return await fn(tx);
      } catch (err) {
        earnings.clear();
        for (const [k, v] of before) earnings.set(k, v);
        throw err;
      }
    },
  };
  return { earnings, balances, totals, ledger, deps };
}

test("owed shares are credited once the payout profile exists, each exactly once", async () => {
  const { earnings, balances, totals, ledger, deps } = makeAccrual(
    [
      { id: "e1", amountCents: 180n },
      { id: "e2", amountCents: 90n },
      { id: "e3", amountCents: 500n, accruedAt: new Date("2026-10-01T00:00:00Z") },
    ],
    ["org_alice"],
  );
  const args = { userId: "u_alice", recipientOrgId: "org_alice", now: NOW };

  // Two callers at once (two tabs opening Revenue & Payouts).
  const [a, b] = await Promise.all([
    accruePendingContributorEarnings(deps, args),
    accruePendingContributorEarnings(deps, args),
  ]);
  assert.equal(a.accrued + b.accrued, 2);
  assert.equal(a.amountCents + b.amountCents, 270n);
  assert.equal(balances.get("org_alice"), 270n);
  assert.equal(totals.get("org_alice"), 270n);
  // One ledger row per earning credited, against the earning itself, each
  // with the balance it left; the two callers wrote two rows between them.
  assert.deepEqual(
    [...ledger].sort((x, y) => String(x.referenceId).localeCompare(String(y.referenceId))).map((row) => ({
      ...row,
      balanceAfter: undefined,
    })),
    [
      {
        orgId: "org_alice",
        amountCents: 180n,
        type: "contributor_share",
        referenceId: "e1",
        description: "Contributor share owed from an earlier sale",
        balanceAfter: undefined,
      },
      {
        orgId: "org_alice",
        amountCents: 90n,
        type: "contributor_share",
        referenceId: "e2",
        description: "Contributor share owed from an earlier sale",
        balanceAfter: undefined,
      },
    ],
  );
  // The rows add up to the balance, and the last one written carries it.
  assert.equal(ledger.reduce((sum, row) => sum + row.amountCents, 0n), 270n);
  assert.equal(ledger.at(-1)!.balanceAfter, 270n);
  assert.equal(ledger[0]!.balanceAfter, ledger[0]!.amountCents);
  assert.equal(earnings.get("e1")!.accruedAt, NOW);
  assert.equal(earnings.get("e1")!.recipientOrgId, "org_alice");

  // Nothing is left, and a repeat credits nothing.
  assert.deepEqual(await accruePendingContributorEarnings(deps, args), { accrued: 0, amountCents: 0n });
  assert.equal(balances.get("org_alice"), 270n);
  assert.equal(ledger.length, 2);
});

test("a share that cannot be credited stays owed", async () => {
  const { earnings, ledger, deps } = makeAccrual([{ id: "e1", amountCents: 180n }], []);
  await assert.rejects(
    accruePendingContributorEarnings(deps, { userId: "u_alice", recipientOrgId: "org_alice", now: NOW }),
    (err: unknown) => err instanceof ContributorShareError && err.orgId === "org_alice",
  );
  assert.equal(earnings.get("e1")!.accruedAt, null);
  assert.deepEqual(ledger, []);
});

test("a surface without contributor tables leaves everything with the publisher", async () => {
  assert.deepEqual(await splitCreatorRevenue({}, ARGS), { publisherCents: 900n, paid: [], pending: [] });
});

test("settling a per-request charge credits the publisher only with what contributors leave", async () => {
  const { tx, profiles, ledger } = makeTx({
    contributors: [{ id: "c1", userId: "u_alice", revenueShareBps: 5_000, accepted: true }],
    ownedOrgs: { u_alice: "org_alice" },
    profiles: ["org_pub", "org_alice"],
  });
  const settleTx = {
    ...tx,
    marketplaceRevenue: { updateMany: async () => ({ count: 1 }) },
    agentInstall: { update: async () => ({}) },
    agentListing: { ...tx.agentListing, update: async () => ({}) },
  };
  const charge = {
    revenueId: "rev_9",
    grossCents: 250n,
    platformFeeCents: 25n,
    creatorCents: 225n,
    requestCount: 1,
    install: {
      installId: "ins_1",
      listingId: "lst_1",
      listingTitle: "Support Triage",
      publisherId: "org_pub",
      buyerId: "org_buyer",
      pricePerRequestCents: 250n,
    },
  } as MarketplaceCharge;

  const result = await settleMarketplaceRequest(settleTx as never, { charge });
  assert.deepEqual(result, { settled: true, creatorCents: 225n });
  assert.equal(profiles.get("org_alice")!.pending, 112n);
  assert.equal(profiles.get("org_pub")!.pending, 113n);
  // Two organizations, two rows, both against the one revenue row: the
  // contributor's share first, then the publisher's sale.
  assert.deepEqual(ledger, [
    {
      orgId: "org_alice",
      amountCents: 112n,
      type: "contributor_share",
      referenceId: "rev_9",
      description: "Contributor share of a sale",
      balanceAfter: 112n,
    },
    {
      orgId: "org_pub",
      amountCents: 113n,
      type: "sale",
      referenceId: "rev_9",
      description: "Sale: Support Triage",
      balanceAfter: 113n,
    },
  ]);
});

test("job revenue on an agent with no listing pays its contributors by the agent itself", async () => {
  const { tx, profiles, earnings, ledger } = makeTx({
    contributors: [{ id: "c1", userId: "u_alice", revenueShareBps: 2_500, accepted: true }],
    ownedOrgs: { u_alice: "org_alice" },
    profiles: ["org_pub", "org_alice"],
  });
  // No listing table is consulted: an offering names the agent directly.
  const { agentListing: _unused, ...withoutListings } = tx;
  const result = await splitCreatorRevenue(withoutListings, {
    revenueId: "rev_job",
    agentId: "agent_9",
    publisherId: "org_pub",
    creatorCents: 1_800n,
    now: NOW,
  });

  assert.equal(result.publisherCents, 1_350n);
  assert.deepEqual(result.paid, [{ userId: "u_alice", recipientOrgId: "org_alice", amountCents: 450n }]);
  assert.equal(profiles.get("org_alice")!.pending, 450n);
  assert.equal(earnings.length, 1);
  assert.equal(earnings[0]!.agentId, "agent_9");
  assert.equal(earnings[0]!.revenueId, "rev_job");
  assert.deepEqual(
    ledger.map((row) => [row.orgId, row.amountCents, row.type, row.referenceId, row.balanceAfter]),
    [["org_alice", 450n, "contributor_share", "rev_job", 450n]],
  );
});
