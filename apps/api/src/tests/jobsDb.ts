// An in-memory database for the Offerings and Jobs tests: the tables the
// escrow core, the API-key spend cap and the job runner write, with real
// transaction semantics. Each transaction records how to undo its own
// writes, so a failed one rolls back only what it did (a whole-state
// snapshot would also erase a concurrent winner's writes).

import type { ApiKeySpendTx } from "../services/apiKeySpend.js";
import type { EscrowTx } from "../services/jobEscrow.js";
import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

export type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond === null) return v === null || v === undefined;
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; gt?: Date | number; lte?: Date; lt?: number };
      if (c.in) return c.in.includes(v);
      if (typeof c.gt === "number") return typeof v === "number" && v > c.gt;
      if (c.lt !== undefined) return typeof v === "number" && v < c.lt;
      if (c.gt) return v instanceof Date && v.getTime() > c.gt.getTime();
      if (c.lte) return v instanceof Date && v.getTime() <= c.lte.getTime();
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

/** Applies Prisma's `{ increment }` / `{ decrement }` as well as plain values. */
function applyData(row: Row, data: Row): void {
  for (const [k, value] of Object.entries(data)) {
    const op = value as { increment?: number | bigint; decrement?: number | bigint } | null;
    if (op && typeof op === "object" && typeof op.increment === "bigint") {
      row[k] = ((row[k] as bigint | undefined) ?? 0n) + op.increment;
    } else if (op && typeof op === "object" && typeof op.decrement === "bigint") {
      row[k] = ((row[k] as bigint | undefined) ?? 0n) - op.decrement;
    } else if (op && typeof op === "object" && typeof op.increment === "number") {
      row[k] = ((row[k] as number) ?? 0) + op.increment;
    } else if (op && typeof op === "object" && typeof op.decrement === "number") {
      row[k] = ((row[k] as number) ?? 0) - op.decrement;
    } else {
      row[k] = value;
    }
  }
}

export interface JobsDbOptions {
  balance?: bigint;
  noProfile?: boolean;
  /** Extra columns on the seeded offering off_1. */
  offering?: Row;
  /** API keys by id, with their caps. */
  apiKeys?: Record<string, { orgId: string; maxJobPriceCents: bigint | null; dailySpendCapCents: bigint | null }>;
}

export function makeJobsDb(opts: JobsDbOptions = {}) {
  const state = {
    balances: new Map<string, bigint>([["org_buyer", opts.balance ?? 10_000n]]),
    jobs: new Map<string, Row>(),
    revenue: new Map<string, Row>(),
    offerings: new Map<string, Row>([
      ["off_1", { id: "off_1", status: "active", activeJobs: 0, agentId: null, ...opts.offering }],
    ]),
    profiles: new Set<string>(opts.noProfile ? [] : ["org_pub"]),
    ledger: [] as Row[],
    /** What each publisher is owed. An organization that was never credited has no entry. */
    accrued: new Map<string, bigint>(),
    /** Each publisher's lifetime revenue. */
    lifetime: new Map<string, bigint>(),
    /** The publishers' ledger: one row for every change to what they are owed. */
    earnings: [] as EarningsRow[],
    apiKeys: new Map(Object.entries(opts.apiKeys ?? {})),
    /** `${apiKeyId}|${day ISO}` -> cents spent. */
    spendWindows: new Map<string, bigint>(),
  };
  let seq = 0;

  // Each transaction records how to undo its own writes, so a failed
  // transaction rolls back only what it did, like a real database (a
  // whole-state snapshot would also erase a concurrent winner's writes).
  function txFor(undo: Array<() => void>): EscrowTx & ApiKeySpendTx {
    const restoreFields = (row: Row, data: Row) => {
      const before = Object.fromEntries(Object.keys(data).map((k) => [k, row[k]]));
      undo.push(() => Object.assign(row, before));
    };
    // A publisher is credited through the ledger (moveEarnings).
    const earnings = earningsStandIn({
      pending: (orgId) => (state.profiles.has(orgId) ? (state.accrued.get(orgId) ?? 0n) : undefined),
      add: (orgId, pending, total) => {
        const before = { accrued: state.accrued.get(orgId), lifetime: state.lifetime.get(orgId) };
        state.accrued.set(orgId, (before.accrued ?? 0n) + pending);
        state.lifetime.set(orgId, (before.lifetime ?? 0n) + total);
        undo.push(() => {
          const accrued = (state.accrued.get(orgId) ?? 0n) - pending;
          const lifetime = (state.lifetime.get(orgId) ?? 0n) - total;
          // An organization this transaction was the first to credit goes
          // back to having no entry.
          if (before.accrued === undefined && accrued === 0n) state.accrued.delete(orgId);
          else state.accrued.set(orgId, accrued);
          if (before.lifetime === undefined && lifetime === 0n) state.lifetime.delete(orgId);
          else state.lifetime.set(orgId, lifetime);
        });
      },
      write: (row) => {
        state.earnings.push(row);
        undo.push(() => void state.earnings.splice(state.earnings.indexOf(row), 1));
      },
    });
    return {
      ...earnings,
      creditBalance: {
        async updateMany({ where, data }) {
          const bal = state.balances.get(where.orgId) ?? 0n;
          if (bal < where.balanceCents.gte) return { count: 0 };
          state.balances.set(where.orgId, bal - data.balanceCents.decrement);
          undo.push(() => state.balances.set(where.orgId, (state.balances.get(where.orgId) ?? 0n) + data.balanceCents.decrement));
          return { count: 1 };
        },
        async findUnique({ where }) {
          const bal = state.balances.get(where.orgId);
          return bal === undefined ? null : { balanceCents: bal };
        },
        async update({ where, data }) {
          const bal = (state.balances.get(where.orgId) ?? 0n) + data.balanceCents.increment;
          state.balances.set(where.orgId, bal);
          undo.push(() => state.balances.set(where.orgId, (state.balances.get(where.orgId) ?? 0n) - data.balanceCents.increment));
          return { balanceCents: bal };
        },
      },
      creditTransaction: {
        async create({ data }) {
          state.ledger.push(data);
          undo.push(() => state.ledger.splice(state.ledger.indexOf(data), 1));
          return data;
        },
      },
      job: {
        async create({ data }) {
          // The unique (buyerId, idempotencyKey): what a retried hire trips over.
          if (data.idempotencyKey) {
            for (const other of state.jobs.values()) {
              if (other.buyerId === data.buyerId && other.idempotencyKey === data.idempotencyKey) {
                throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
              }
            }
          }
          const row = {
            id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
            attempts: 0,
            rating: null,
            modelCostCents: 0n,
            createdAt: new Date(),
            ...data,
          } as Row;
          state.jobs.set(row.id as string, row);
          undo.push(() => state.jobs.delete(row.id as string));
          return { id: row.id as string, deadlineAt: (row.deadlineAt as Date) ?? null };
        },
        async updateMany({ where, data }) {
          let count = 0;
          for (const row of state.jobs.values()) {
            if (matches(row, where as Row)) {
              restoreFields(row, data as Row);
              applyData(row, data as Row);
              count++;
            }
          }
          return { count };
        },
        async findUnique({ where }) {
          const row = state.jobs.get(where.id);
          return row
            ? { offeringId: row.offeringId as string, modelCostCents: (row.modelCostCents as bigint) ?? 0n }
            : null;
        },
      },
      offering: {
        async updateMany({ where, data }) {
          const row = state.offerings.get(where.id);
          if (!row || !matches(row, where as Row)) return { count: 0 };
          restoreFields(row, data as Row);
          applyData(row, data as Row);
          return { count: 1 };
        },
        async findUnique({ where }) {
          const row = state.offerings.get(where.id);
          return row ? { status: row.status as string, agentId: (row.agentId as string | null) ?? null } : null;
        },
      },
      marketplaceRevenue: {
        async create({ data }) {
          const row = { id: `rev_${++seq}`, modelCostCents: 0n, ...data } as Row;
          state.revenue.set(row.jobId as string, row);
          undo.push(() => state.revenue.delete(row.jobId as string));
          return { id: row.id as string };
        },
        async updateMany({ where, data }) {
          const row = state.revenue.get(where.jobId);
          if (!row || row.status !== where.status) return { count: 0 };
          restoreFields(row, data as Row);
          Object.assign(row, data);
          return { count: 1 };
        },
        async update({ where, data }) {
          const row = state.revenue.get(where.jobId);
          if (!row) throw new Error("escrow row missing");
          restoreFields(row, { platformFeeCents: 0n, creatorAmountCents: 0n, modelCostCents: 0n });
          row.platformFeeCents = (row.platformFeeCents as bigint) + data.platformFeeCents.increment;
          row.creatorAmountCents = (row.creatorAmountCents as bigint) - data.creatorAmountCents.decrement;
          row.modelCostCents = data.modelCostCents;
          return row;
        },
        async findUnique({ where }) {
          const row = state.revenue.get(where.jobId);
          return row
            ? {
                id: row.id as string,
                listingId: (row.listingId as string | null) ?? null,
                buyerId: row.buyerId as string,
                publisherId: row.publisherId as string,
                grossAmountCents: row.grossAmountCents as bigint,
                creatorAmountCents: row.creatorAmountCents as bigint,
              }
            : null;
        },
      },
      apiKey: {
        async findUnique({ where }) {
          return state.apiKeys.get(where.id) ?? null;
        },
      },
      apiKeySpendWindow: {
        async createMany({ data }) {
          for (const row of data) {
            const key = `${row.apiKeyId}|${row.day.toISOString()}`;
            if (!state.spendWindows.has(key)) {
              state.spendWindows.set(key, 0n);
              undo.push(() => state.spendWindows.delete(key));
            }
          }
          return { count: data.length };
        },
        async updateMany({ where, data }) {
          const key = `${where.apiKeyId}|${where.day.toISOString()}`;
          const spent = state.spendWindows.get(key);
          if (spent === undefined || spent > where.spentCents.lte) return { count: 0 };
          state.spendWindows.set(key, spent + data.spentCents.increment);
          undo.push(() => state.spendWindows.set(key, (state.spendWindows.get(key) ?? 0n) - data.spentCents.increment));
          return { count: 1 };
        },
      },
    };
  }

  async function inTransaction<T>(fn: (t: EscrowTx & ApiKeySpendTx) => Promise<T>): Promise<T> {
    const undo: Array<() => void> = [];
    try {
      return await fn(txFor(undo));
    } catch (err) {
      for (const u of undo.reverse()) u();
      throw err;
    }
  }

  const job = (id: string) => state.jobs.get(id)!;
  const escrow = (id: string) => state.revenue.get(id)!;
  const slots = () => state.offerings.get("off_1")!.activeJobs as number;
  return { state, inTransaction, job, escrow, slots };
}

