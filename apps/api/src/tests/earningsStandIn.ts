// What moveEarnings needs of a transaction, for the in-memory databases of
// the tests whose cores credit a creator (a sale, a subscription, a job, a
// contributor's share). Each test keeps its own state; this turns the three
// statements moveEarnings issues into reads and writes of that state, so a
// test that pinned "the creator's balance went up by N" still pins it, and
// can pin the ledger row beside it.

import type { EarningsLedgerTx } from "../services/earningsLedger.js";

/** One `earnings_transactions` row, as moveEarnings writes it. */
export type EarningsRow = Parameters<EarningsLedgerTx["earningsTransaction"]["create"]>[0]["data"];

export interface EarningsStandInOptions {
  /** What the organization is owed now, or undefined when it has no publisher profile. */
  pending(orgId: string): bigint | undefined;
  /** Change what the organization is owed (signed) and its lifetime revenue. */
  add(orgId: string, pendingCents: bigint, totalRevenueCents: bigint): void;
  /** Keep a ledger row. */
  write(row: EarningsRow): void;
  /** Called first for every statement, for the tests that pin which statements are issued. */
  record?(model: "publisherProfile" | "earningsTransaction", op: string, args: unknown): void;
}

export interface EarningsStandIn {
  publisherProfile: {
    updateMany: EarningsLedgerTx["publisherProfile"]["updateMany"];
    /** Answers both the ledger's read of the balance and a core's "is there a profile" read. */
    findUnique(args: {
      where: { orgId: string };
      select?: unknown;
    }): Promise<{ orgId: string; pendingPayoutCents: bigint } | null>;
  };
  earningsTransaction: EarningsLedgerTx["earningsTransaction"];
}

export function earningsStandIn(opts: EarningsStandInOptions): EarningsStandIn {
  return {
    publisherProfile: {
      updateMany: async (args) => {
        opts.record?.("publisherProfile", "updateMany", args);
        const { where, data } = args;
        const owed = opts.pending(where.orgId);
        if (owed === undefined) return { count: 0 };
        // The conditional take, as the database applies it.
        if (where.pendingPayoutCents && owed < where.pendingPayoutCents.gte) return { count: 0 };
        const change =
          "increment" in data.pendingPayoutCents
            ? data.pendingPayoutCents.increment
            : -data.pendingPayoutCents.decrement;
        opts.add(where.orgId, change, data.totalRevenueCents?.increment ?? 0n);
        return { count: 1 };
      },
      findUnique: async (args) => {
        opts.record?.("publisherProfile", "findUnique", args);
        const owed = opts.pending(args.where.orgId);
        return owed === undefined ? null : { orgId: args.where.orgId, pendingPayoutCents: owed };
      },
    },
    earningsTransaction: {
      create: async (args) => {
        opts.record?.("earningsTransaction", "create", args);
        opts.write({ ...args.data });
        return args.data;
      },
    },
  };
}
