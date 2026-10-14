import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { createBillingLedgerRoutes } from "../routes/billingLedger.js";
import {
  buildBuyerUsageReads,
  paidUseWindowsQuery,
  type BuyerUsageDb,
} from "../services/buildBuyerUsageDeps.js";
import { buildBillingLedgerStore } from "../services/buildBillingLedgerDeps.js";
import {
  BUYER_USAGE_MAX_LISTINGS,
  readBuyerUsage,
  utcMonthStart,
  type BuyerUsageDeps,
  type BuyerUsageLicence,
} from "../services/buyerUsage.js";
import { resolveUseBilling } from "../services/useMetering.js";
import { ORG, OTHER_ORG, makeBillingDb, matches, uuid } from "./billingLedgerStandIn.js";

// services/buyerUsage.ts and its reads: what a buyer has used and spent on
// each listing they pay to use, and GET /api/billing/marketplace-usage.

const NOW = new Date("2026-10-13T12:00:00.000Z");
const at = (iso: string) => new Date(iso);

type Row = Record<string, unknown>;

interface Tables {
  creditBalance: Row[];
  agentInstall: Row[];
  agentListing: Row[];
  agentSubscription: Row[];
  marketplaceRevenue: Row[];
}

/**
 * An in-memory database for the two reads. The licences are answered by the
 * `where`, `orderBy` and `take` the query is sent with. The sum is answered
 * by reading the SQL it is sent: each filter is applied only when the text
 * asks for it, and each window is the WHEN it was written as, so a query
 * that left a filter out would count rows these tests say it must not.
 */
function makeDb(tables: Tables) {
  const calls = { licences: 0, sums: 0, balances: 0 };
  const sql: Array<{ text: string; values: unknown[] }> = [];

  const db: BuyerUsageDb = {
    creditBalance: {
      async findUnique({ where }) {
        calls.balances += 1;
        const row = tables.creditBalance.find((r) => r.orgId === where.orgId);
        return row ? { balanceCents: row.balanceCents as bigint } : null;
      },
    },
    agentInstall: {
      async findMany(args) {
        calls.licences += 1;
        const rows = tables.agentInstall
          .filter((row) => matches(row, args.where as unknown as Record<string, unknown>))
          .sort((a, b) => (b.installedAt as Date).getTime() - (a.installedAt as Date).getTime())
          .slice(0, args.take);
        return rows.map((row) => {
          const listing = tables.agentListing.find((l) => l.id === row.listingId)!;
          const subWhere = args.select.listing.select.subscriptions.where;
          return {
            ...row,
            listing: {
              ...listing,
              subscriptions: tables.agentSubscription.filter(
                (sub) => sub.listingId === listing.id && matches(sub, subWhere),
              ),
            },
          } as never;
        });
      },
    },
    async $queryRawUnsafe<T>(text: string, ...values: unknown[]): Promise<T> {
      calls.sums += 1;
      sql.push({ text, values });
      const value = (index: string) => values[Number(index) - 1];
      const whens = [
        ...text.matchAll(
          /WHEN r\.listing_id = \$(\d+)::uuid AND r\.created_at >= \$(\d+)(?: AND r\.created_at < \$(\d+))? THEN (\d+)/g,
        ),
      ].map((m) => ({
        listingId: value(m[1]!) as string,
        from: value(m[2]!) as Date,
        until: m[3] ? (value(m[3]) as Date) : null,
        bucket: Number(m[4]),
      }));
      const earliest = /AND r\.created_at >= \$(\d+)\n {2}\) AS w/.exec(text);
      const rows = tables.marketplaceRevenue.filter((row) => {
        if (/r\.buyer_id = \$1::uuid/.test(text) && row.buyerId !== values[0]) return false;
        if (/r\.status = 'settled'/.test(text) && row.status !== "settled") return false;
        if (/r\.type = 'per_request'/.test(text) && row.type !== "per_request") return false;
        if (earliest && (row.createdAt as Date) < (value(earliest[1]!) as Date)) return false;
        return true;
      });
      const sums = new Map<number, { uses: number; cents: bigint }>();
      for (const row of rows) {
        const created = row.createdAt as Date;
        const hit = whens.find(
          (w) => w.listingId === row.listingId && created >= w.from && (w.until === null || created < w.until),
        );
        if (!hit) continue;
        const sum = sums.get(hit.bucket) ?? { uses: 0, cents: 0n };
        sum.uses += row.requestCount as number;
        sum.cents += row.grossAmountCents as bigint;
        sums.set(hit.bucket, sum);
      }
      return [...sums].map(([bucket, sum]) => ({ bucket, uses: sum.uses, cents: String(sum.cents) })) as T;
    },
  };
  return { db, calls, sql };
}

// ---- rows ------------------------------------------------------------------

const PUBLISHER = uuid(900_010);
const PLAN_LISTING = uuid(1);
const PER_USE_LISTING = uuid(2);
const MONTHLY_LISTING = uuid(3);
const ENDED_LISTING = uuid(4);
const STARTER = uuid(50);

function listing(id: string, over: Row = {}): Row {
  return {
    id,
    title: `Listing ${id.slice(-2)}`,
    slug: `listing-${id.slice(-2)}`,
    status: "published",
    sells: "use",
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    publisherId: PUBLISHER,
    publisherName: "Creator Org Ltd",
    agent: { publicHandle: `agent-${id.slice(-2)}`, orgId: PUBLISHER, modelConfig: { model: "secret-model-9" } },
    ...over,
  };
}

function licence(listingId: string, over: Row = {}): Row {
  return {
    listingId,
    buyerId: ORG,
    kind: "use",
    status: "active",
    acceptedPricingModel: "per_request",
    acceptedPricePerRequestCents: 5n,
    installedAt: at("2026-09-01T00:00:00Z"),
    totalRequests: 9n,
    ...over,
  };
}

function planSub(listingId: string, over: Row = {}): Row {
  return {
    id: uuid(700),
    listingId,
    subscriberId: ORG,
    status: "active",
    currentPeriodStart: at("2026-10-05T00:00:00Z"),
    currentPeriodEnd: at("2026-11-04T00:00:00Z"),
    cancelAtPeriodEnd: false,
    endReason: null,
    priceCents: 900n,
    planId: STARTER,
    includedUses: 500,
    usedInPeriod: 500,
    carriedUses: 0,
    extraUsePriceCents: 4n,
    // Stays 0 while email is not set up. The warning is read from the count.
    warnedLevel: 0,
    plan: { status: "active", name: "Starter" },
    ...over,
  };
}

let revenueSeq = 0;
function charge(listingId: string, createdAt: string, cents: bigint, over: Row = {}): Row {
  revenueSeq += 1;
  return {
    id: uuid(10_000 + revenueSeq),
    listingId,
    buyerId: ORG,
    publisherId: PUBLISHER,
    type: "per_request",
    grossAmountCents: cents,
    requestCount: 1,
    status: "settled",
    createdAt: at(createdAt),
    ...over,
  };
}

function seed(): Tables {
  return {
    creditBalance: [
      { orgId: ORG, balanceCents: 4_210n },
      { orgId: OTHER_ORG, balanceCents: 77_700n },
    ],
    agentListing: [
      listing(PLAN_LISTING, { title: "Support desk", slug: "support-desk" }),
      listing(PER_USE_LISTING, { title: "Translator", slug: "translator" }),
      listing(MONTHLY_LISTING, {
        title: "Daily brief",
        slug: "daily-brief",
        pricingModel: "monthly",
        pricePerRequestCents: null,
        monthlyPriceCents: 1_500n,
      }),
      listing(ENDED_LISTING, { title: "Researcher", slug: "researcher" }),
    ],
    agentInstall: [
      // A plan start writes no agreement to a price per use.
      licence(PLAN_LISTING, {
        acceptedPricingModel: null,
        acceptedPricePerRequestCents: null,
        installedAt: at("2026-10-04T00:00:00Z"),
      }),
      licence(PER_USE_LISTING, { installedAt: at("2026-10-03T00:00:00Z") }),
      licence(MONTHLY_LISTING, {
        acceptedPricingModel: "monthly",
        acceptedPricePerRequestCents: null,
        installedAt: at("2026-10-02T00:00:00Z"),
      }),
      licence(ENDED_LISTING, {
        acceptedPricingModel: null,
        acceptedPricePerRequestCents: null,
        installedAt: at("2026-10-01T00:00:00Z"),
      }),
    ],
    agentSubscription: [
      planSub(PLAN_LISTING),
      {
        ...planSub(MONTHLY_LISTING, { id: uuid(701), priceCents: 1_500n }),
        planId: null,
        includedUses: null,
        usedInPeriod: 0,
        extraUsePriceCents: null,
        plan: null,
      },
      // Its 30 days ran out a week ago and it was closed.
      planSub(ENDED_LISTING, {
        id: uuid(702),
        status: "expired",
        currentPeriodStart: at("2026-09-06T00:00:00Z"),
        currentPeriodEnd: at("2026-10-06T00:00:00Z"),
        usedInPeriod: 120,
      }),
    ],
    marketplaceRevenue: [
      // The plan's listing: two extra uses in this period, one use paid per
      // use this month before the plan started, one last month.
      charge(PLAN_LISTING, "2026-10-06T10:00:00Z", 4n),
      charge(PLAN_LISTING, "2026-10-07T10:00:00Z", 4n),
      charge(PLAN_LISTING, "2026-10-03T10:00:00Z", 5n),
      charge(PLAN_LISTING, "2026-09-28T10:00:00Z", 5n),
      // Held, and given back: neither is money spent.
      charge(PLAN_LISTING, "2026-10-08T10:00:00Z", 4n, { status: "pending" }),
      charge(PLAN_LISTING, "2026-10-09T10:00:00Z", 4n, { status: "refunded" }),
      // The plan's own price is not a use.
      charge(PLAN_LISTING, "2026-10-05T00:00:00Z", 900n, { type: "subscription" }),
      // Paid per use: two this month, one last month.
      charge(PER_USE_LISTING, "2026-10-02T10:00:00Z", 5n),
      charge(PER_USE_LISTING, "2026-10-10T10:00:00Z", 5n),
      charge(PER_USE_LISTING, "2026-09-30T23:59:59Z", 5n),
      // The ended plan: an extra use of the period that is over.
      charge(ENDED_LISTING, "2026-10-02T10:00:00Z", 4n),
    ],
  };
}

function depsOver(tables: Tables, now: Date = NOW) {
  const standIn = makeDb(tables);
  const deps: BuyerUsageDeps = { ...buildBuyerUsageReads(standIn.db), now: () => now };
  return { deps, ...standIn };
}

// ---- the read ----------------------------------------------------------------

test("a buyer on a plan: the plan as the agent's page builds it, the extra uses of this period only, and what was paid per use before it", async () => {
  const { deps } = depsOver(seed());
  const view = await readBuyerUsage(deps, ORG);
  assert.equal(view.balanceCents, 4_210);
  const row = view.listings.find((l) => l.listingId === PLAN_LISTING)!;
  assert.deepEqual(row, {
    listingId: PLAN_LISTING,
    title: "Support desk",
    slug: "support-desk",
    handle: "agent-01",
    access: "subscribed",
    trialEnded: false,
    plan: {
      id: STARTER,
      name: "Starter",
      trial: false,
      includedUses: 500,
      carriedUses: 0,
      usedUses: 500,
      remainingUses: 0,
      extraUsePriceCents: 4,
      resetsAt: "2026-11-04T00:00:00.000Z",
      // From the count: the stored level is 0.
      warning: 100,
    },
    perUseAfterTrial: null,
    // The end of the 30 days paid for, whether or not the plan renews.
    periodEndsAt: "2026-11-04T00:00:00.000Z",
    renewalPastDue: false,
    extraThisPeriod: { uses: 2, cents: 8 },
    perUseThisMonth: { uses: 1, cents: 5 },
  });
});

test("a plan whose period started before this month: every charge since is an extra use, and nothing is counted twice", async () => {
  const tables = seed();
  tables.agentSubscription[0] = planSub(PLAN_LISTING, {
    currentPeriodStart: at("2026-09-25T00:00:00Z"),
    currentPeriodEnd: at("2026-10-25T00:00:00Z"),
    usedInPeriod: 425,
  });
  const { deps } = depsOver(tables);
  const row = (await readBuyerUsage(deps, ORG)).listings.find((l) => l.listingId === PLAN_LISTING)!;
  // 28 Sep, 3, 6 and 7 Oct: settled, inside the period.
  assert.deepEqual(row.extraThisPeriod, { uses: 4, cents: 18 });
  assert.deepEqual(row.perUseThisMonth, { uses: 0, cents: 0 });
  assert.equal(row.plan?.warning, 85);
  assert.equal(row.plan?.remainingUses, 75);
});

test("a buyer who pays per use: this UTC month's settled uses, and no plan", async () => {
  const { deps } = depsOver(seed());
  const row = (await readBuyerUsage(deps, ORG)).listings.find((l) => l.listingId === PER_USE_LISTING)!;
  assert.equal(row.access, "listing_pricing");
  assert.equal(row.plan, null);
  assert.equal(row.extraThisPeriod, null);
  assert.deepEqual(row.perUseThisMonth, { uses: 2, cents: 10 });
});

test("a monthly subscriber: subscribed, no plan, nothing extra and nothing per use", async () => {
  const { deps } = depsOver(seed());
  const row = (await readBuyerUsage(deps, ORG)).listings.find((l) => l.listingId === MONTHLY_LISTING)!;
  assert.deepEqual(row, {
    listingId: MONTHLY_LISTING,
    title: "Daily brief",
    slug: "daily-brief",
    handle: "agent-03",
    access: "subscribed",
    trialEnded: false,
    plan: null,
    perUseAfterTrial: null,
    periodEndsAt: null,
    renewalPastDue: false,
    extraThisPeriod: null,
    perUseThisMonth: { uses: 0, cents: 0 },
  });
});

test("a plan that ended: the access says so, no plan is told, and what was charged this month is still spending", async () => {
  const { deps } = depsOver(seed());
  const row = (await readBuyerUsage(deps, ORG)).listings.find((l) => l.listingId === ENDED_LISTING)!;
  assert.equal(row.access, "plan_ended");
  assert.equal(row.plan, null);
  assert.equal(row.extraThisPeriod, null);
  assert.deepEqual(row.perUseThisMonth, { uses: 1, cents: 4 });
});

test("a plan that will not renew tells no reset", async () => {
  const tables = seed();
  tables.agentSubscription[0] = planSub(PLAN_LISTING, { cancelAtPeriodEnd: true, usedInPeriod: 10 });
  const { deps } = depsOver(tables);
  const row = (await readBuyerUsage(deps, ORG)).listings.find((l) => l.listingId === PLAN_LISTING)!;
  assert.equal(row.access, "subscribed");
  assert.ok(row.plan);
  assert.equal("resetsAt" in row.plan, false);
  assert.equal(row.plan.warning, null);
  // It still says when the 30 days paid for end, so a page can say "Your plan ends on 4 Nov."
  assert.equal(row.periodEndsAt, "2026-11-04T00:00:00.000Z");
  assert.equal(row.renewalPastDue, false);
});

test("a buyer on a free trial: the plan is marked as a trial and named Free trial, with no time at which it starts again", async () => {
  const tables = seed();
  // The trial's row as its start writes it: a price of nothing, set to end, no extra price.
  tables.agentSubscription[0] = planSub(PLAN_LISTING, {
    priceCents: 0n,
    includedUses: 20,
    usedInPeriod: 17,
    extraUsePriceCents: null,
    cancelAtPeriodEnd: true,
    currentPeriodStart: at("2026-10-10T00:00:00Z"),
    currentPeriodEnd: at("2026-10-17T00:00:00Z"),
    plan: { status: "active", name: "Renamed by hand" },
  });
  const { deps } = depsOver(tables);
  const row = (await readBuyerUsage(deps, ORG)).listings.find((l) => l.listingId === PLAN_LISTING)!;
  assert.equal(row.access, "subscribed");
  assert.deepEqual(row.plan, {
    id: STARTER,
    name: "Free trial",
    trial: true,
    includedUses: 20,
    carriedUses: 0,
    usedUses: 17,
    remainingUses: 3,
    extraUsePriceCents: null,
    warning: 85,
  });
  assert.equal(row.periodEndsAt, "2026-10-17T00:00:00.000Z");
});

// ---- a free trial: that it ended, and what a use costs after its free uses ----

/** The trial's row as its start writes it: a price of nothing, 7 days, set to end, no extra price. */
function trialSub(over: Row = {}): Row {
  return planSub(PLAN_LISTING, {
    priceCents: 0n,
    includedUses: 20,
    usedInPeriod: 20,
    extraUsePriceCents: null,
    cancelAtPeriodEnd: true,
    currentPeriodStart: at("2026-10-10T00:00:00Z"),
    currentPeriodEnd: at("2026-10-17T00:00:00Z"),
    ...over,
  });
}

/** The seed with the plan's listing on a free trial, each of its three rows changed as asked. */
function trialTables(over: { licence?: Row; listing?: Row; sub?: Row; agentKind?: string } = {}): Tables {
  const tables = seed();
  const base = tables.agentListing[0]!;
  tables.agentListing[0] = {
    ...base,
    agent: { ...(base.agent as Row), agentKind: over.agentKind ?? "conversation" },
    ...over.listing,
  };
  // A trial start writes no agreement; the buyer agreed to the price per use afterwards.
  tables.agentInstall[0] = licence(PLAN_LISTING, { installedAt: at("2026-10-04T00:00:00Z"), ...over.licence });
  tables.agentSubscription[0] = trialSub(over.sub);
  return tables;
}

async function trialRow(tables: Tables, now: Date = NOW) {
  const { deps } = depsOver(tables, now);
  return (await readBuyerUsage(deps, ORG)).listings.find((l) => l.listingId === PLAN_LISTING)!;
}

const AFTER_TRIAL = at("2026-10-18T00:00:00Z");

test("trialEnded: true only when what ended was this organization's own free trial", async () => {
  // Its 7 days are over and the buyer agreed to no price per use.
  const ended = trialTables({ licence: { acceptedPricingModel: null, acceptedPricePerRequestCents: null } });
  const row = await trialRow(ended, AFTER_TRIAL);
  assert.equal(row.access, "plan_ended");
  assert.equal(row.trialEnded, true);
  assert.equal(row.plan, null);
  assert.equal(row.perUseAfterTrial, null);

  // The same trial while it runs.
  assert.equal((await trialRow(ended)).trialEnded, false);

  // A paid plan that ended, a buyer who pays per use, a month: never.
  const { deps } = depsOver(seed());
  const view = await readBuyerUsage(deps, ORG);
  const byListing = (id: string) => view.listings.find((l) => l.listingId === id)!;
  assert.equal(byListing(ENDED_LISTING).access, "plan_ended");
  assert.equal(byListing(ENDED_LISTING).trialEnded, false);
  assert.equal(byListing(PER_USE_LISTING).trialEnded, false);
  assert.equal(byListing(MONTHLY_LISTING).trialEnded, false);
  assert.equal(byListing(PLAN_LISTING).trialEnded, false);
});

test("trialEnded: a buyer who agreed to pay per use goes on after the trial, so nothing ended for them", async () => {
  const row = await trialRow(trialTables(), AFTER_TRIAL);
  assert.equal(row.access, "listing_pricing");
  assert.equal(row.trialEnded, false);
  assert.equal(row.perUseAfterTrial, null);
});

test("trialEnded: an ended trial that is another organization's says nothing of this buyer", async () => {
  const mine: BuyerUsageLicence = {
    buyerId: ORG,
    status: "active",
    accepted: { pricingModel: null, pricePerRequestCents: null },
    listing: {
      id: PLAN_LISTING,
      title: "Support desk",
      slug: "support-desk",
      status: "published",
      sells: "use",
      pricingModel: "per_request",
      pricePerRequestCents: 5n,
      publisherId: PUBLISHER,
      handle: "support",
      agentKind: "conversation",
    },
    sub: {
      id: uuid(791),
      subscriberId: OTHER_ORG,
      status: "expired",
      currentPeriodStart: at("2026-10-01T00:00:00Z"),
      currentPeriodEnd: at("2026-10-08T00:00:00Z"),
      cancelAtPeriodEnd: true,
      priceCents: 0n,
      includedUses: 20,
      usedInPeriod: 3,
      carriedUses: 0,
    },
  };
  const deps = (licences: BuyerUsageLicence[]): BuyerUsageDeps => ({
    readBalance: async () => 0n,
    loadLicences: async () => licences,
    sumPaidUses: async () => new Map(),
    now: () => NOW,
  });
  const theirs = (await readBuyerUsage(deps([mine]), ORG)).listings[0]!;
  assert.equal(theirs.trialEnded, false);
  assert.notEqual(theirs.access, "plan_ended");
  // The very same row, when it is this organization's, is an ended trial.
  const own = (await readBuyerUsage(deps([{ ...mine, sub: { ...mine.sub!, subscriberId: ORG } }]), ORG)).listings[0]!;
  assert.equal(own.access, "plan_ended");
  assert.equal(own.trialEnded, true);
});

test("perUseAfterTrial: a buyer on a trial who agreed to the listing's price per use is told that price", async () => {
  const row = await trialRow(trialTables());
  assert.equal(row.access, "subscribed");
  assert.equal(row.plan?.trial, true);
  assert.deepEqual(row.perUseAfterTrial, { priceCents: 5, unit: "message" });
  // Said while free uses are left too: it is what comes after them.
  const early = await trialRow(trialTables({ sub: { usedInPeriod: 3 } }));
  assert.deepEqual(early.perUseAfterTrial, { priceCents: 5, unit: "message" });
});

test("perUseAfterTrial: it is the listing's price now, never the higher one the buyer agreed to", async () => {
  const row = await trialRow(trialTables({ licence: { acceptedPricePerRequestCents: 9n } }));
  assert.deepEqual(row.perUseAfterTrial, { priceCents: 5, unit: "message" });
});

test("perUseAfterTrial: a task agent's use is a run", async () => {
  const row = await trialRow(trialTables({ agentKind: "task" }));
  assert.deepEqual(row.perUseAfterTrial, { priceCents: 5, unit: "run" });
});

test("perUseAfterTrial: null whenever a use past the trial would not be charged without asking", async () => {
  const nothing: Array<[string, Parameters<typeof trialTables>[0]]> = [
    ["the listing asks more than was agreed", { listing: { pricePerRequestCents: 8n } }],
    ["agreed to a month", { licence: { acceptedPricingModel: "monthly", acceptedPricePerRequestCents: null } }],
    ["nothing agreed", { licence: { acceptedPricingModel: null, acceptedPricePerRequestCents: null } }],
    ["agreed per use with no price on the row", { licence: { acceptedPricePerRequestCents: null } }],
    ["a suspended licence", { licence: { status: "suspended" } }],
    ["the listing is not published", { listing: { status: "paused" } }],
    ["the listing is sold by the month", { listing: { pricingModel: "monthly", pricePerRequestCents: null } }],
    ["the listing sells copies", { listing: { sells: "copies" } }],
    ["the listing is free", { listing: { pricingModel: "free", pricePerRequestCents: null } }],
    ["a price of nothing", { listing: { pricePerRequestCents: 0n } }],
  ];
  for (const [name, over] of nothing) {
    const row = await trialRow(trialTables(over));
    // Still on the trial: the row is there to say a price, and says none.
    assert.equal(row.plan?.trial, true, name);
    assert.equal(row.perUseAfterTrial, null, name);
  }
});

test("perUseAfterTrial: never on a paid plan or off a plan, whatever was agreed per use", async () => {
  // A paid plan at its count, on a licence that agreed to the listing's price per use.
  const paid = trialTables({ sub: { priceCents: 900n, includedUses: 500, usedInPeriod: 500, cancelAtPeriodEnd: false } });
  const onPaid = await trialRow(paid);
  assert.equal(onPaid.plan?.trial, false);
  assert.equal(onPaid.perUseAfterTrial, null);

  const { deps } = depsOver(seed());
  const view = await readBuyerUsage(deps, ORG);
  for (const row of view.listings) assert.equal(row.perUseAfterTrial, null, row.title);
  // Among them a buyer who pays per use at exactly the listing's price.
  assert.equal(view.listings.find((l) => l.listingId === PER_USE_LISTING)!.access, "listing_pricing");
});

test("perUseAfterTrial says exactly what the metering charges for a use past the trial's count", async () => {
  const states: Array<[string, Parameters<typeof trialTables>[0]]> = [
    ["agreed at the listing's price", {}],
    ["agreed at more than the listing asks", { licence: { acceptedPricePerRequestCents: 9n } }],
    ["agreed at less than the listing asks", { listing: { pricePerRequestCents: 8n } }],
    ["agreed to a month", { licence: { acceptedPricingModel: "monthly", acceptedPricePerRequestCents: null } }],
    ["nothing agreed", { licence: { acceptedPricingModel: null, acceptedPricePerRequestCents: null } }],
    ["agreed per use with no price on the row", { licence: { acceptedPricePerRequestCents: null } }],
    ["a suspended licence", { licence: { status: "suspended" } }],
    ["the listing is not published", { listing: { status: "paused" } }],
    ["the listing is archived", { listing: { status: "archived" } }],
    ["the listing is sold by the month", { listing: { pricingModel: "monthly", pricePerRequestCents: null } }],
    ["the listing sells copies", { listing: { sells: "copies" } }],
    ["the listing is free", { listing: { pricingModel: "free", pricePerRequestCents: null } }],
    ["a price of nothing", { listing: { pricePerRequestCents: 0n } }],
    ["a task agent", { agentKind: "task" }],
    ["free uses left", { sub: { usedInPeriod: 3 } }],
    // A trial's row never carries a price of its own for an extra use; one that did changes nothing.
    ["a trial row that carries an extra price", { sub: { extraUsePriceCents: 2n } }],
    ["a trial row that is past due", { sub: { status: "past_due" } }],
    ["a trial row whose renewal was not cancelled", { sub: { cancelAtPeriodEnd: false } }],
    // The creator's own organization never pays itself, whatever rows exist.
    ["the buyer's own listing", { listing: { publisherId: ORG } }],
  ];
  let charged = 0;
  for (const [name, over] of states) {
    const tables = trialTables(over);
    const row = await trialRow(tables);
    const listingRow = tables.agentListing[0]!;
    const licenceRow = tables.agentInstall[0]!;
    // The use itself, decided from the same three rows with the trial's uses gone.
    const billing = resolveUseBilling(
      {
        callerOrgId: ORG,
        listing: listingRow as never,
        licence: { id: uuid(600), ...licenceRow } as never,
        sub: { ...tables.agentSubscription[0]!, usedInPeriod: 20 } as never,
      },
      NOW,
    );
    const metered =
      billing.kind === "plan" && billing.extraInstall ? Number(billing.extraInstall.pricePerRequestCents) : null;
    assert.equal(row.perUseAfterTrial?.priceCents ?? null, metered, name);
    if (metered === null) continue;
    charged += 1;
    // What is charged is the listing's price, never the row's own extra price or the price agreed.
    assert.equal(metered, Number(listingRow.pricePerRequestCents), name);
    assert.equal(row.perUseAfterTrial?.unit, over?.agentKind === "task" ? "run" : "message", name);
  }
  // The comparison is not empty on either side.
  assert.equal(charged, 7);
});

test("a plan whose renewal is being retried says so, and its period's end is behind the buyer", async () => {
  const tables = seed();
  // The period ended yesterday and the renewal could not be paid: three days of grace run.
  tables.agentSubscription[0] = planSub(PLAN_LISTING, {
    status: "past_due",
    currentPeriodEnd: new Date("2026-10-12T12:00:00.000Z"),
    usedInPeriod: 10,
  });
  const { deps } = depsOver(tables);
  const row = (await readBuyerUsage(deps, ORG)).listings.find((l) => l.listingId === PLAN_LISTING)!;
  assert.equal(row.access, "subscribed");
  assert.ok(row.plan);
  assert.equal(row.renewalPastDue, true);
  assert.equal(row.periodEndsAt, "2026-10-12T12:00:00.000Z");
});

test("the listings come newest licence first, and only licences for use that the buyer still holds", async () => {
  const tables = seed();
  const COPY = uuid(5);
  const STOPPED = uuid(6);
  tables.agentListing.push(listing(COPY, { sells: "copies" }), listing(STOPPED));
  tables.agentInstall.push(
    licence(COPY, { kind: "copy", installedAt: at("2026-10-12T00:00:00Z") }),
    licence(STOPPED, { status: "uninstalled", installedAt: at("2026-10-12T00:00:00Z") }),
  );
  tables.marketplaceRevenue.push(charge(COPY, "2026-10-12T10:00:00Z", 7n), charge(STOPPED, "2026-10-12T10:00:00Z", 7n));
  const { deps } = depsOver(tables);
  const view = await readBuyerUsage(deps, ORG);
  assert.deepEqual(
    view.listings.map((l) => l.listingId),
    [PLAN_LISTING, PER_USE_LISTING, MONTHLY_LISTING, ENDED_LISTING],
  );
});

test("two queries whatever the number of listings: the licences once, the charges once", async () => {
  const { deps, calls, sql } = depsOver(seed());
  await readBuyerUsage(deps, ORG);
  assert.deepEqual(calls, { licences: 1, sums: 1, balances: 1 });
  // Five windows: the plan's period and the days of this month before it,
  // then one month each for the other three.
  assert.equal((sql[0]!.text.match(/WHEN /g) ?? []).length, 5);
  assert.equal(sql[0]!.values[0], ORG);
});

test("an organization with no licence gets its balance and an empty list, and no charge is read", async () => {
  const tables = seed();
  tables.creditBalance.push({ orgId: uuid(900_003), balanceCents: 250n });
  const { deps, calls } = depsOver(tables);
  assert.deepEqual(await readBuyerUsage(deps, uuid(900_003)), { balanceCents: 250, listings: [] });
  assert.equal(calls.sums, 0);
  // No balance row at all reads as 0.
  assert.deepEqual(await readBuyerUsage(deps, uuid(900_004)), { balanceCents: 0, listings: [] });
});

// ---- two organizations on one listing ---------------------------------------------

function twoOrgs(): Tables {
  const tables = seed();
  tables.agentInstall.push(
    licence(PLAN_LISTING, {
      buyerId: OTHER_ORG,
      acceptedPricingModel: null,
      acceptedPricePerRequestCents: null,
      installedAt: at("2026-10-10T00:00:00Z"),
    }),
  );
  tables.agentSubscription.push(
    planSub(PLAN_LISTING, {
      id: uuid(790),
      subscriberId: OTHER_ORG,
      planId: uuid(51),
      includedUses: 2_000,
      usedInPeriod: 37,
      extraUsePriceCents: 3n,
      currentPeriodStart: at("2026-10-10T00:00:00Z"),
      currentPeriodEnd: at("2026-11-09T00:00:00Z"),
      plan: { status: "active", name: "Scale" },
    }),
  );
  tables.marketplaceRevenue.push(
    charge(PLAN_LISTING, "2026-10-11T10:00:00Z", 3_333n, { buyerId: OTHER_ORG }),
    charge(PLAN_LISTING, "2026-10-06T11:00:00Z", 7_777n, { buyerId: OTHER_ORG }),
  );
  return tables;
}

test("two organizations on one listing: each is told its own plan and its own charges, and nothing of the other's", async () => {
  const { deps } = depsOver(twoOrgs());

  const mine = await readBuyerUsage(deps, ORG);
  const row = mine.listings.find((l) => l.listingId === PLAN_LISTING)!;
  assert.equal(row.plan?.name, "Starter");
  assert.equal(row.plan?.usedUses, 500);
  assert.deepEqual(row.extraThisPeriod, { uses: 2, cents: 8 });
  assert.deepEqual(row.perUseThisMonth, { uses: 1, cents: 5 });
  const text = JSON.stringify(mine);
  for (const theirs of ["Scale", uuid(51), uuid(790), OTHER_ORG, "2000", "3333", "7777", "77700"]) {
    assert.equal(text.includes(theirs), false, `the answer carries ${theirs}`);
  }

  const other = await readBuyerUsage(deps, OTHER_ORG);
  assert.equal(other.balanceCents, 77_700);
  assert.equal(other.listings.length, 1);
  assert.equal(other.listings[0]!.plan?.name, "Scale");
  assert.deepEqual(other.listings[0]!.extraThisPeriod, { uses: 1, cents: 3_333 });
  // 6 Oct was before their plan started: paid per use.
  assert.deepEqual(other.listings[0]!.perUseThisMonth, { uses: 1, cents: 7_777 });
  assert.equal(JSON.stringify(other).includes("Starter"), false);
});

test("a read that answers with another organization's licence or subscription: neither is told", async () => {
  const mineLicence: BuyerUsageLicence = {
    buyerId: ORG,
    status: "active",
    accepted: { pricingModel: "per_request", pricePerRequestCents: 5n },
    listing: {
      id: PLAN_LISTING,
      title: "Support desk",
      slug: "support-desk",
      status: "published",
      sells: "use",
      pricingModel: "per_request",
      pricePerRequestCents: 5n,
      publisherId: PUBLISHER,
      handle: "support",
      agentKind: "conversation",
    },
    // Somebody else's plan, handed back beside this buyer's licence.
    sub: {
      id: uuid(790),
      subscriberId: OTHER_ORG,
      status: "active",
      currentPeriodStart: at("2026-10-10T00:00:00Z"),
      currentPeriodEnd: at("2026-11-09T00:00:00Z"),
      includedUses: 2_000,
      usedInPeriod: 37,
      carriedUses: 0,
      planName: "Scale",
    },
  };
  const asked: unknown[] = [];
  const deps: BuyerUsageDeps = {
    readBalance: async () => 100n,
    loadLicences: async () => [
      mineLicence,
      { ...mineLicence, buyerId: OTHER_ORG, listing: { ...mineLicence.listing, id: PER_USE_LISTING, title: "Theirs" } },
    ],
    sumPaidUses: async (args) => {
      asked.push(args);
      return new Map();
    },
    now: () => NOW,
  };
  const view = await readBuyerUsage(deps, ORG);
  assert.equal(view.listings.length, 1);
  assert.equal(view.listings[0]!.plan, null);
  assert.equal(view.listings[0]!.access, "listing_pricing");
  assert.equal(JSON.stringify(view).includes("Scale"), false);
  assert.equal(JSON.stringify(view).includes("Theirs"), false);
  // Only this buyer's listing, for the month: no window from the other's plan.
  assert.deepEqual(asked, [
    {
      buyerId: ORG,
      windows: [{ key: "per_use:0", listingId: PLAN_LISTING, from: utcMonthStart(NOW), until: null }],
    },
  ]);
});

test("a sum that is not a count and an amount is told as nothing", async () => {
  const { deps } = depsOver(seed());
  const broken: BuyerUsageDeps = {
    ...deps,
    sumPaidUses: async ({ windows }) =>
      new Map(windows.map((w) => [w.key, { uses: Number.NaN, cents: -5n }])),
  };
  const view = await readBuyerUsage(broken, ORG);
  for (const row of view.listings) {
    assert.deepEqual(row.perUseThisMonth, { uses: 0, cents: 0 });
  }
});

test("at most BUYER_USAGE_MAX_LISTINGS licences are asked for", async () => {
  let take = 0;
  await readBuyerUsage(
    {
      readBalance: async () => 0n,
      loadLicences: async (args) => {
        take = args.take;
        return [];
      },
      sumPaidUses: async () => new Map(),
      now: () => NOW,
    },
    ORG,
  );
  assert.equal(take, BUYER_USAGE_MAX_LISTINGS);
});

// ---- the SQL ------------------------------------------------------------------

test("the sum reads the buyer's own settled charges per use, bounded by the earliest window", () => {
  const from = at("2026-10-05T00:00:00Z");
  const month = at("2026-10-01T00:00:00Z");
  const query = paidUseWindowsQuery(ORG, [
    { key: "extra:0", listingId: PLAN_LISTING, from, until: null },
    { key: "per_use:0", listingId: PLAN_LISTING, from: month, until: from },
  ]);
  assert.match(query.text, /r\.buyer_id = \$1::uuid/);
  assert.match(query.text, /r\.status = 'settled'/);
  assert.match(query.text, /r\.type = 'per_request'/);
  assert.match(query.text, /WHEN r\.listing_id = \$2::uuid AND r\.created_at >= \$3 THEN 0/);
  assert.match(query.text, /WHEN r\.listing_id = \$4::uuid AND r\.created_at >= \$5 AND r\.created_at < \$6 THEN 1/);
  assert.match(query.text, /AND r\.created_at >= \$7\n/);
  assert.deepEqual(query.values, [ORG, PLAN_LISTING, from, PLAN_LISTING, month, from, month]);
  // Every value is a parameter: nothing of a row is written into the text.
  assert.equal(query.text.includes(ORG), false);
  assert.equal(query.text.includes(PLAN_LISTING), false);
});

// ---- the route ------------------------------------------------------------------

async function buildApp(usage: BuyerUsageDeps | undefined) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    if (typeof org === "string") {
      (request as unknown as { auth: unknown }).auth = { userId: "user_1", orgId: org, role: "member", type: "jwt" };
    }
  });
  const signedIn = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
  };
  await app.register(
    createBillingLedgerRoutes({
      ledger: { store: buildBillingLedgerStore(makeBillingDb({}).db), now: () => NOW },
      usage,
      guards: { signedIn: [signedIn] },
    }),
    { prefix: "/api/billing" },
  );
  const get = (org: string | null = ORG, query = "") =>
    app.inject({
      method: "GET",
      url: `/api/billing/marketplace-usage${query}`,
      headers: org ? { "x-test-org": org } : {},
    });
  return { app, get };
}

test("GET /marketplace-usage: the balance and a row per listing, for the caller's organization", async () => {
  const { deps } = depsOver(twoOrgs());
  const { app, get } = await buildApp(deps);
  try {
    const res = await get();
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.balanceCents, 4_210);
    assert.deepEqual(
      body.listings.map((l: { title: string }) => l.title),
      ["Support desk", "Translator", "Daily brief", "Researcher"],
    );
    assert.deepEqual(Object.keys(body.listings[0]), [
      "listingId",
      "title",
      "slug",
      "handle",
      "access",
      "trialEnded",
      "plan",
      "perUseAfterTrial",
      "periodEndsAt",
      "renewalPastDue",
      "extraThisPeriod",
      "perUseThisMonth",
    ]);
    // Never tokens, the model, the creator's organization or another buyer.
    for (const never of ["token", "model", "secret-model-9", PUBLISHER, "Creator Org", "publisher", OTHER_ORG, "Scale"]) {
      assert.equal(res.body.toLowerCase().includes(never.toLowerCase()), false, `the answer carries ${never}`);
    }
  } finally {
    await app.close();
  }
});

test("GET /marketplace-usage: the organization is the caller's, whatever the request names", async () => {
  const { deps } = depsOver(twoOrgs());
  const { app, get } = await buildApp(deps);
  try {
    const res = await get(ORG, `?orgId=${OTHER_ORG}&buyerId=${OTHER_ORG}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().balanceCents, 4_210);
    const theirs = await get(OTHER_ORG);
    assert.equal(theirs.json().balanceCents, 77_700);
    assert.equal(theirs.json().listings.length, 1);
  } finally {
    await app.close();
  }
});

test("GET /marketplace-usage: signed out is 401, and a read that fails is one fixed sentence", async () => {
  const { deps } = depsOver(seed());
  const failing: BuyerUsageDeps = {
    ...deps,
    sumPaidUses: async () => {
      throw new Error('relation "marketplace_revenue" does not exist');
    },
  };
  const { app, get } = await buildApp(failing);
  try {
    assert.equal((await get(null)).statusCode, 401);
    const res = await get();
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), {
      error: "billing_unavailable",
      message: "Billing could not be read. Try again in a moment.",
    });
  } finally {
    await app.close();
  }
});

test("GET /marketplace-usage is not mounted without its reads", async () => {
  const { app, get } = await buildApp(undefined);
  try {
    assert.equal((await get()).statusCode, 404);
  } finally {
    await app.close();
  }
});
