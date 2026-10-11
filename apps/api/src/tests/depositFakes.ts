// A stand-in for the part of the Prisma client the deposit address store
// uses, held in memory. It answers `where` the way Postgres would for the
// few shapes the store sends, counts every write, and throws Prisma's
// P2002 on a second row for an organization or an address.

import { Keypair } from "@solana/web3.js";

import type { DepositAddressStoreDb } from "../services/depositAddresses.js";

export interface FakeAddressRow {
  orgId: string;
  address: string;
  network: string;
  usdcAccountOpenedAt: Date | null;
  usdcAccountOpenedBy: string | null;
  usdcAccountRequestedAt: Date | null;
  lastSolSignature: string | null;
  lastUsdcSignature: string | null;
  lastSeenLamports: bigint;
  lastSeenUsdcRaw: bigint;
  scanRequestedAt: Date | null;
  lastScannedAt: Date | null;
  [column: string]: unknown;
}

export interface FakeReceiptRow {
  id: string;
  orgId: string;
  network: string;
  source: string;
  asset: string;
  amountRaw: bigint;
  status: string;
  ignoredReason: string | null;
  amountUsdCents: bigint | null;
  bonusCents: bigint;
  txSignature: string;
  createdAt: Date;
  creditedAt: Date | null;
}

export interface FakeDb extends DepositAddressStoreDb {
  addresses: Map<string, FakeAddressRow>;
  receipts: FakeReceiptRow[];
  members: Array<{ orgId: string; userId: string; emailVerified: boolean }>;
  transactions: Array<{ orgId: string; type: string; amountCents: bigint }>;
  /** Every create and every updateMany that matched a row. */
  writes: string[];
  /** When set, the next call of that name throws it. */
  failNext: { find?: unknown };
}

export function addressRow(over: Partial<FakeAddressRow> & { orgId: string; address: string }): FakeAddressRow {
  return {
    network: "solana:devnet",
    usdcAccountOpenedAt: null,
    usdcAccountOpenedBy: null,
    usdcAccountRequestedAt: null,
    lastSolSignature: null,
    lastUsdcSignature: null,
    lastSeenLamports: 0n,
    lastSeenUsdcRaw: 0n,
    scanRequestedAt: null,
    lastScannedAt: null,
    ...over,
  };
}

function same(stored: unknown, wanted: unknown): boolean {
  if (stored instanceof Date && wanted instanceof Date) {
    return stored.getTime() === wanted.getTime();
  }
  return stored === wanted;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([column, wanted]) => {
    if (wanted !== null && typeof wanted === "object" && !(wanted instanceof Date)) {
      const rule = wanted as { gte?: Date; gt?: bigint };
      const stored = row[column];
      if (rule.gte !== undefined) {
        return stored instanceof Date && stored.getTime() >= rule.gte.getTime();
      }
      if (rule.gt !== undefined) {
        return typeof stored === "bigint" && stored > rule.gt;
      }
      throw new Error(`fake db: unsupported where for ${column}`);
    }
    return same(row[column], wanted);
  });
}

export function makeFakeDb(): FakeDb {
  const db: FakeDb = {
    addresses: new Map(),
    receipts: [],
    members: [],
    transactions: [],
    writes: [],
    failNext: {},

    depositAddress: {
      findUnique: async ({ where }) => {
        if (db.failNext.find) {
          const err = db.failNext.find;
          db.failNext.find = undefined;
          throw err;
        }
        const row = db.addresses.get(where.orgId);
        return row ? { ...row } : null;
      },
      create: async ({ data }) => {
        const orgId = data.orgId as string;
        const address = data.address as string;
        const taken =
          db.addresses.has(orgId) ||
          [...db.addresses.values()].some((row) => row.address === address);
        if (taken) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        db.addresses.set(orgId, addressRow({ ...(data as object), orgId, address }));
        db.writes.push("create");
        return {};
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of db.addresses.values()) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        if (count > 0) db.writes.push(`update:${Object.keys(data).sort().join(",")}`);
        return { count };
      },
      count: async ({ where }) =>
        [...db.addresses.values()].filter((row) => matches(row, where)).length,
    },

    onchainReceipt: {
      findMany: async ({ where, take }) =>
        db.receipts
          .filter((row) => matches(row as unknown as Record<string, unknown>, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take),
    },

    orgMember: {
      findFirst: async ({ where }) => {
        const wanted = where as { orgId: string; user: { emailVerified: boolean } };
        const found = db.members.find(
          (member) =>
            member.orgId === wanted.orgId &&
            member.emailVerified === wanted.user.emailVerified,
        );
        return found ? { userId: found.userId } : null;
      },
    },

    creditTransaction: {
      findFirst: async ({ where }) => {
        const found = db.transactions.find((row) =>
          matches(row as unknown as Record<string, unknown>, where),
        );
        return found ? { id: "tx" } : null;
      },
    },
  };
  return db;
}

/** A fixed keypair's address, for a test that needs a real one. */
export function addressFromSeed(seed: number): string {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();
}

// What a node, a database or a library might say. None of it may ever be
// part of an answer.
export const HOSTILE =
  "ECONNREFUSED https://rpc.example.invalid/?api-key=SECRET-KEY-123 <script>alert(1)</script> PrismaClientKnownRequestError P2002";
