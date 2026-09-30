import assert from "node:assert/strict";
import test from "node:test";

import {
  computeContributorSplit,
  splitCreatorRevenue,
  type ContributorSplitTx,
} from "../services/contributorSplits.js";
import { settleMarketplaceRequest, type MarketplaceCharge } from "../services/marketplaceMetering.js";

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
  const created: string[] = [];
  const earnings: Array<Record<string, unknown>> = [];
  const tx: ContributorSplitTx = {
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
    publisherProfile: {
      findUnique: async ({ where }) => (profiles.has(where.orgId) ? { orgId: where.orgId } : null),
      create: async ({ data }) => {
        created.push(data.orgId);
        profiles.set(data.orgId, { total: 0n, pending: 0n });
        return data;
      },
      update: async ({ where, data }) => {
        const p = profiles.get(where.orgId);
        if (!p) throw new Error(`no profile for ${where.orgId}`);
        p.total += data.totalRevenueCents.increment;
        p.pending += data.pendingPayoutCents.increment;
        return p;
      },
    },
    contributorEarning: {
      create: async ({ data }) => {
        earnings.push(data);
        return data;
      },
    },
  };
  return { tx, profiles, created, earnings };
}

const ARGS = { revenueId: "rev_1", listingId: "lst_1", publisherId: "org_pub", creatorCents: 900n };

test("accepted contributors are paid into the org they own, with an earning row each", async () => {
  const { tx, profiles, created, earnings } = makeTx({
    contributors: [
      { id: "c1", userId: "u_alice", revenueShareBps: 2_000, accepted: true },
      { id: "c2", userId: "u_bob", revenueShareBps: 1_000, accepted: true },
    ],
    ownedOrgs: { u_alice: "org_alice", u_bob: "org_bob" },
    profiles: ["org_pub", "org_bob"],
  });

  const result = await splitCreatorRevenue(tx, ARGS);

  assert.equal(result.publisherCents, 630n);
  assert.deepEqual(
    result.paid.map((p) => [p.recipientOrgId, p.amountCents]),
    [["org_alice", 180n], ["org_bob", 90n]],
  );
  assert.deepEqual(created, ["org_alice"]); // a first-time earner gets a profile to be paid from
  assert.equal(profiles.get("org_alice")!.pending, 180n);
  assert.equal(profiles.get("org_bob")!.pending, 90n);
  assert.deepEqual(earnings[0], {
    revenueId: "rev_1",
    agentId: "agent_1",
    contributorId: "c1",
    userId: "u_alice",
    recipientOrgId: "org_alice",
    publisherId: "org_pub",
    shareBps: 2_000,
    amountCents: 180n,
  });
});

test("pending invitations, shares owned by the publisher, and users with no org pay nothing", async () => {
  const { tx, earnings } = makeTx({
    contributors: [
      { id: "c1", userId: "u_pending", revenueShareBps: 5_000, accepted: false },
      { id: "c2", userId: "u_owner", revenueShareBps: 2_000, accepted: true },
      { id: "c3", userId: "u_orgless", revenueShareBps: 1_000, accepted: true },
    ],
    ownedOrgs: { u_pending: "org_p", u_owner: "org_pub" },
  });
  const result = await splitCreatorRevenue(tx, ARGS);
  assert.equal(result.publisherCents, 900n);
  assert.equal(earnings.length, 0);
});

test("a surface without contributor tables leaves everything with the publisher", async () => {
  assert.deepEqual(await splitCreatorRevenue({}, ARGS), { publisherCents: 900n, paid: [] });
});

test("settling a per-request charge credits the publisher only with what contributors leave", async () => {
  const { tx, profiles } = makeTx({
    contributors: [{ id: "c1", userId: "u_alice", revenueShareBps: 5_000, accepted: true }],
    ownedOrgs: { u_alice: "org_alice" },
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
});
