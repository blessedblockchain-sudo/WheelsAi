// Stand-ins shared by the payout request tests: an in-memory
// creator_payouts + publisher_profiles + earnings_transactions set, and an
// app with the payout routes over it. Nothing here reaches a database, a
// chain or the network.
import "./unitEnv.js";

import assert from "node:assert/strict";

import {
  buildCancelPayoutDeps,
  buildRequestPayoutDeps,
  cancelPayout,
  listPayouts,
  requestPayout,
  type CancelPayoutDb,
  type PayoutReadsDb,
  type PayoutRequestSettings,
  type PayoutRow,
  type RequestPayoutDb,
  type RequestPayoutDeps,
} from "../services/payoutRequests.js";
import type { AddressOnChain } from "../services/payoutRules.js";
import type { PayoutRouteDeps } from "../routes/payouts.js";

export const ORG = "7f5c1d9e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";
export const OTHER_ORG = "11111111-2222-4333-8444-555555555555";
export const PAYOUT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** Noon UTC, so "today" has a morning before it and an evening after it. */
export const NOW = new Date("2026-10-10T12:00:00Z");

export function payoutRow(over: Partial<PayoutRow> = {}): PayoutRow {
  return {
    id: PAYOUT,
    publisherId: ORG,
    amountCents: 2500n,
    payoutMethod: "credits",
    payoutAddress: null,
    status: "pending",
    txSignature: null,
    grossRevenueCents: 2778n,
    platformFeeCents: 278n,
    periodStart: new Date("2026-09-10T00:00:00Z"),
    periodEnd: new Date("2026-10-10T00:00:00Z"),
    requestedAt: new Date("2026-10-10T00:00:00Z"),
    processedAt: null,
    failureReason: null,
    ...over,
  };
}

/** An earnings_transactions row, as the earnings ledger writes it. */
export type LedgerRow = {
  orgId: string;
  amountCents: bigint;
  type: string;
  referenceId: string | null;
  description: string | null;
  balanceAfter: bigint;
};

const OPEN = ["pending", "processing"];

/**
 * An in-memory creator_payouts + publisher_profiles + earnings_transactions
 * set. Transactions are serialised the way row locks serialise them and
 * commit or roll back as a whole; every write is counted. Like the real
 * table, it lets ONE open payout in per creator: a second insert fails with
 * Prisma's P2002.
 */
export function fakeDb(rows: PayoutRow[], balances: Record<string, bigint>) {
  const state = {
    payouts: rows.map((r) => ({ ...r })),
    balances: { ...balances },
    ledger: [] as LedgerRow[],
    balanceWrites: 0,
    payoutWrites: 0,
    payoutInserts: 0,
    /** When set, every read and write of the payouts table throws it. */
    payoutsBroken: null as Error | null,
    /** When false, the request's "is there an open payout" read sees none. */
    openPayoutVisible: true,
  };
  type Draft = { payouts: PayoutRow[]; balances: Record<string, bigint>; ledger: LedgerRow[] };
  const broken = () => {
    if (state.payoutsBroken) throw state.payoutsBroken;
  };
  let nextId = 1;

  const client = (draft: () => Draft) => ({
    creatorPayout: {
      findFirst: async ({ where }: any) => {
        broken();
        if (where.id !== undefined) {
          return draft().payouts.find((p) => p.id === where.id && p.publisherId === where.publisherId) ?? null;
        }
        if (!state.openPayoutVisible) return null;
        return (
          draft().payouts.find((p) => p.publisherId === where.publisherId && where.status.in.includes(p.status)) ??
          null
        );
      },
      findMany: async ({ where, take }: any) => {
        broken();
        return draft()
          .payouts.filter((p) => p.publisherId === where.publisherId)
          .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
          .slice(0, take);
      },
      aggregate: async ({ where }: any) => {
        broken();
        const counted = draft().payouts.filter(
          (p) =>
            p.publisherId === where.publisherId &&
            where.payoutMethod.in.includes(p.payoutMethod) &&
            where.status.in.includes(p.status) &&
            p.requestedAt.getTime() >= where.requestedAt.gte.getTime(),
        );
        return { _sum: { amountCents: counted.length ? counted.reduce((sum, p) => sum + p.amountCents, 0n) : null } };
      },
      create: async ({ data }: any) => {
        broken();
        const d = draft();
        if (OPEN.includes(data.status) && d.payouts.some((p) => p.publisherId === data.publisherId && OPEN.includes(p.status))) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`publisher_id`)"), { code: "P2002" });
        }
        const id = `00000000-0000-4000-9000-${String(nextId++).padStart(12, "0")}`;
        const row: PayoutRow = {
          id,
          txSignature: null,
          processedAt: null,
          failureReason: null,
          requestedAt: data.periodEnd,
          ...data,
        };
        d.payouts.push(row);
        state.payoutInserts += 1;
        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        broken();
        const statuses: string[] = typeof where.status === "string" ? [where.status] : where.status.in;
        const hit = draft().payouts.filter(
          (p) =>
            p.id === where.id &&
            (where.publisherId === undefined || p.publisherId === where.publisherId) &&
            statuses.includes(p.status),
        );
        for (const p of hit) Object.assign(p, data);
        state.payoutWrites += hit.length;
        return { count: hit.length };
      },
    },
    publisherProfile: {
      // What the earnings ledger uses. A reservation must be conditional on
      // the balance covering it; a restore is not income and must never add
      // to lifetime revenue.
      updateMany: async ({ where, data }: any) => {
        const d = draft();
        assert.deepEqual(Object.keys(data), ["pendingPayoutCents"], "a payout changes the balance only");
        if (!(where.orgId in d.balances)) return { count: 0 };
        if ("decrement" in data.pendingPayoutCents) {
          assert.equal(typeof where.pendingPayoutCents?.gte, "bigint", "the reservation must be conditional");
          if (d.balances[where.orgId]! < where.pendingPayoutCents.gte) return { count: 0 };
          d.balances[where.orgId] = d.balances[where.orgId]! - data.pendingPayoutCents.decrement;
        } else {
          assert.equal(where.pendingPayoutCents, undefined, "a restore is not conditional on the balance");
          d.balances[where.orgId] = d.balances[where.orgId]! + data.pendingPayoutCents.increment;
        }
        state.balanceWrites += 1;
        return { count: 1 };
      },
      findUnique: async ({ where }: any) => {
        const d = draft();
        return where.orgId in d.balances ? { pendingPayoutCents: d.balances[where.orgId]! } : null;
      },
      update: async () => {
        throw new Error("the balance changes only through the earnings ledger");
      },
    },
    earningsTransaction: {
      create: async ({ data }: any) => {
        draft().ledger.push({ ...data });
        return data;
      },
    },
  });

  let chain: Promise<unknown> = Promise.resolve();
  const db = {
    // Outside a transaction a write lands at once, as a single statement does.
    ...client(() => state),
    $transaction: (fn: (tx: any) => Promise<unknown>) => {
      const run = chain.then(async () => {
        const draft: Draft = {
          payouts: state.payouts.map((p) => ({ ...p })),
          balances: { ...state.balances },
          ledger: [...state.ledger],
        };
        const before = { balanceWrites: state.balanceWrites, payoutWrites: state.payoutWrites, payoutInserts: state.payoutInserts };
        try {
          const result = await fn(client(() => draft));
          state.payouts = draft.payouts; // commit
          state.balances = draft.balances;
          state.ledger = draft.ledger;
          return result;
        } catch (err) {
          // Rolled back: the writes it counted never happened.
          Object.assign(state, before);
          throw err;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return { state, db: db as unknown as CancelPayoutDb & RequestPayoutDb & PayoutReadsDb };
}

export type FakeDb = ReturnType<typeof fakeDb>;

/**
 * The worker's claim, as a stand-in: one compare-and-set, pending →
 * processing. The worker's own claim is tested with the worker.
 */
export function standInClaim(db: FakeDb["db"]) {
  return async (payoutId: string): Promise<boolean> => {
    const res = await (db as any).creatorPayout.updateMany({
      where: { id: payoutId, status: "pending" },
      data: { status: "processing" },
    });
    return res.count === 1;
  };
}

export const SETTINGS: PayoutRequestSettings = { perPayoutCents: 50_000n, perDayCents: 100_000n, solOffered: true };

export interface RequestWorld {
  settings?: Partial<PayoutRequestSettings>;
  platformAddresses?: string[];
  /** What the chain says about any address, or a function that says or throws. */
  chain?: AddressOnChain | ((address: string) => Promise<AddressOnChain>);
  now?: Date;
}

/** The request's deps over a fake database, with the chain read counted. */
export function requestDepsOver(db: FakeDb["db"], world: RequestWorld = {}) {
  const chainReads: string[] = [];
  const deps: RequestPayoutDeps = buildRequestPayoutDeps(db, {
    now: () => world.now ?? NOW,
    settings: () => ({ ...SETTINGS, ...world.settings }),
    platformAddresses: () => world.platformAddresses ?? [],
    readAddressOnChain: async (address) => {
      chainReads.push(address);
      if (typeof world.chain === "function") return world.chain(address);
      return world.chain ?? "absent";
    },
  });
  return { deps, chainReads };
}

/** The routes' deps over a fake database. */
export function routeDepsOver(db: FakeDb["db"], world: RequestWorld & { running?: boolean } = {}) {
  const { deps, chainReads } = requestDepsOver(db, world);
  const cancelDeps = buildCancelPayoutDeps(db);
  const routeDeps: PayoutRouteDeps = {
    payoutsAvailable: () => world.running ?? true,
    requestPayout: (input) => requestPayout(deps, input),
    cancelPayout: (input) => cancelPayout(cancelDeps, input),
    listPayouts: (orgId) => listPayouts(db, orgId),
  };
  return { routeDeps, chainReads };
}

export const OWNER = { userId: "u1", orgId: ORG, type: "jwt", role: "owner" };

/**
 * An app with the payout routes, the caller signed in as `principal`. The
 * real guards run: `currentRole` is what the membership lookup answers.
 */
export async function payoutApp(
  routeDeps: PayoutRouteDeps,
  principal: Record<string, unknown> | null = OWNER,
  currentRole: string | null = "owner",
) {
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { createPayoutRoutes } = await import("../routes/payouts.js");
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as any;
  const saved = { member: p.orgMember.findUnique, subscription: p.orgSubscription.findUnique };
  p.orgMember.findUnique = async () => (currentRole ? { role: currentRole } : null);
  // An API key's call is metered against the plan; a plan that cannot be
  // read lets the call through without a counter, so no database or Redis.
  p.orgSubscription.findUnique = async () => {
    throw new Error("no plan lookup in this test");
  };
  const app = Fastify();
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = principal;
  });
  await app.register(createPayoutRoutes(routeDeps));
  app.addHook("onClose", async () => {
    p.orgMember.findUnique = saved.member;
    p.orgSubscription.findUnique = saved.subscription;
  });
  return app;
}
