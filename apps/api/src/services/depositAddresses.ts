/**
 * An organization's deposit address: issuing it and reading it.
 *
 * The address is `deriveTopupDepositKeypair` for the organization, the
 * same address its prepared top-ups already pay into. A row of
 * deposit_addresses says that the address was given out on a network and
 * is watched there; it is never where the address comes from.
 *
 * Three rules:
 *   - READING NEVER WRITES. `readDepositAddress` only reads.
 *   - A STORED ADDRESS THAT IS NOT THE DERIVED ONE IS NEVER SHOWN. The
 *     answer is "mismatch" (and a log line) whatever network the row is
 *     labelled for: money sent to an address this server cannot derive
 *     the key of would be lost to it.
 *   - A ROW LABELLED FOR ANOTHER NETWORK is "no address on this network".
 *     Issuing re-labels it and clears everything that was read on the
 *     other one.
 *
 * Pure core with its dependencies as arguments; `buildDepositAddressStore`
 * binds the store to a Prisma-shaped client.
 */

import { createLogger } from "../utils/logger.js";
import type { ChainLabel, DepositAsset } from "./depositTypes.js";

const logger = createLogger("deposit-addresses");

// ============================================
// Rows
// ============================================

/** The columns of deposit_addresses the routes read. */
export interface DepositAddressRow {
  orgId: string;
  address: string;
  network: string;
  usdcAccountOpenedAt: Date | null;
  usdcAccountOpenedBy: string | null;
  usdcAccountRequestedAt: Date | null;
}

/** A receipt of a transfer sent straight to the address, as listed. */
export interface DepositReceiptRow {
  id: string;
  asset: DepositAsset;
  amountRaw: bigint;
  status: string;
  amountUsdCents: bigint | null;
  bonusCents: bigint;
  txSignature: string;
  createdAt: Date;
  creditedAt: Date | null;
}

// ============================================
// The store
// ============================================

export interface DepositAddressStore {
  find: (orgId: string) => Promise<DepositAddressRow | null>;
  /** "exists" when a row for the organization (or the address) is there. */
  create: (data: {
    orgId: string;
    address: string;
    network: ChainLabel;
  }) => Promise<"created" | "exists">;
  /**
   * Compare-and-set on the row as it was read: label it for `network` and
   * clear what was read on `fromNetwork`. False when it matched nothing.
   */
  relabel: (args: {
    orgId: string;
    address: string;
    fromNetwork: string;
    network: ChainLabel;
  }) => Promise<boolean>;
  /** Sets usdcAccountOpenedAt (and who opened it) only while it is null. */
  markUsdcAccountOpen: (args: {
    orgId: string;
    at: Date;
    by: "platform" | null;
  }) => Promise<boolean>;
  /**
   * Compare-and-set of usdcAccountRequestedAt on the value that was read.
   * False when another request changed it first.
   */
  claimUsdcAccountRequest: (args: {
    orgId: string;
    expected: Date | null;
    at: Date;
  }) => Promise<boolean>;
  /** Rows whose usdcAccountRequestedAt is at or after `since`. */
  countUsdcAccountRequestsSince: (since: Date) => Promise<number>;
  /** "Check now": asks the scan for this address. */
  requestScan: (args: {
    orgId: string;
    network: ChainLabel;
    at: Date;
  }) => Promise<boolean>;
  /** Receipts whose source is "direct", newest first. */
  listDirectReceipts: (args: {
    orgId: string;
    network: ChainLabel;
    limit: number;
  }) => Promise<DepositReceiptRow[]>;
  /**
   * A member with a verified email, or one purchase of credits: what
   * "Prepare address" asks before the platform pays to open an account.
   */
  isEligible: (orgId: string) => Promise<boolean>;
}

interface DepositAddressDbRow extends DepositAddressRow {
  [column: string]: unknown;
}

interface ReceiptDbRow {
  id: string;
  asset: string;
  amountRaw: bigint;
  status: string;
  amountUsdCents: bigint | null;
  bonusCents: bigint;
  txSignature: string;
  createdAt: Date;
  creditedAt: Date | null;
}

/** The part of the Prisma client the store uses. */
export interface DepositAddressStoreDb {
  depositAddress: {
    findUnique: (args: {
      where: { orgId: string };
    }) => Promise<DepositAddressDbRow | null>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
  };
  onchainReceipt: {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy: { createdAt: "desc" };
      take: number;
    }) => Promise<ReceiptDbRow[]>;
  };
  orgMember: {
    findFirst: (args: {
      where: Record<string, unknown>;
      select: { userId: true };
    }) => Promise<unknown | null>;
  };
  creditTransaction: {
    findFirst: (args: {
      where: Record<string, unknown>;
      select: { id: true };
    }) => Promise<unknown | null>;
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/** Field by field, so a column added to the table never rides along. */
function toRow(row: DepositAddressDbRow): DepositAddressRow {
  return {
    orgId: row.orgId,
    address: row.address,
    network: row.network,
    usdcAccountOpenedAt: row.usdcAccountOpenedAt,
    usdcAccountOpenedBy: row.usdcAccountOpenedBy,
    usdcAccountRequestedAt: row.usdcAccountRequestedAt,
  };
}

export function buildDepositAddressStore(
  db: DepositAddressStoreDb,
): DepositAddressStore {
  return {
    find: async (orgId) => {
      const row = await db.depositAddress.findUnique({ where: { orgId } });
      return row ? toRow(row) : null;
    },

    // One row an organization, by its primary key: a second create is a
    // unique violation, which is "exists" and nothing more.
    create: async ({ orgId, address, network }) => {
      try {
        await db.depositAddress.create({ data: { orgId, address, network } });
        return "created";
      } catch (err) {
        if (isUniqueViolation(err)) return "exists";
        throw err;
      }
    },

    relabel: async ({ orgId, address, fromNetwork, network }) => {
      const result = await db.depositAddress.updateMany({
        where: { orgId, address, network: fromNetwork },
        data: {
          network,
          lastSolSignature: null,
          lastUsdcSignature: null,
          lastSeenLamports: 0n,
          lastSeenUsdcRaw: 0n,
          usdcAccountOpenedAt: null,
          usdcAccountOpenedBy: null,
          usdcAccountRequestedAt: null,
          scanRequestedAt: null,
          lastScannedAt: null,
        },
      });
      return result.count === 1;
    },

    markUsdcAccountOpen: async ({ orgId, at, by }) => {
      const result = await db.depositAddress.updateMany({
        where: { orgId, usdcAccountOpenedAt: null },
        data: { usdcAccountOpenedAt: at, usdcAccountOpenedBy: by },
      });
      return result.count === 1;
    },

    claimUsdcAccountRequest: async ({ orgId, expected, at }) => {
      const result = await db.depositAddress.updateMany({
        where: { orgId, usdcAccountRequestedAt: expected },
        data: { usdcAccountRequestedAt: at },
      });
      return result.count === 1;
    },

    countUsdcAccountRequestsSince: (since) =>
      db.depositAddress.count({
        where: { usdcAccountRequestedAt: { gte: since } },
      }),

    requestScan: async ({ orgId, network, at }) => {
      const result = await db.depositAddress.updateMany({
        where: { orgId, network },
        data: { scanRequestedAt: at },
      });
      return result.count === 1;
    },

    listDirectReceipts: async ({ orgId, network, limit }) => {
      const rows = await db.onchainReceipt.findMany({
        where: { orgId, network, source: "direct" },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return rows.map((row) => ({
        id: row.id,
        asset: row.asset === "SOL" ? "SOL" : "USDC",
        amountRaw: row.amountRaw,
        status: row.status,
        amountUsdCents: row.amountUsdCents,
        bonusCents: row.bonusCents,
        txSignature: row.txSignature,
        createdAt: row.createdAt,
        creditedAt: row.creditedAt,
      }));
    },

    isEligible: async (orgId) => {
      const verified = await db.orgMember.findFirst({
        where: { orgId, user: { emailVerified: true } },
        select: { userId: true },
      });
      if (verified) return true;
      const purchase = await db.creditTransaction.findFirst({
        where: { orgId, type: "purchase", amountCents: { gt: 0n } },
        select: { id: true },
      });
      return purchase !== null && purchase !== undefined;
    },
  };
}

// ============================================
// The core
// ============================================

export interface DepositAddressDeps {
  store: Pick<
    DepositAddressStore,
    "find" | "create" | "relabel" | "markUsdcAccountOpen"
  >;
  /** The address this server derives for the organization. May throw. */
  deriveAddress: (orgId: string) => string;
  /** The label of the configured chain: `chainLabel(env.SOLANA_NETWORK)`. */
  network: ChainLabel;
  /**
   * One read: is there a USDC account at the address? Throws when the
   * chain cannot be read or is not the configured one.
   */
  usdcAccountExists: (address: string) => Promise<boolean>;
  now?: () => Date;
}

export type DepositAddressRead =
  /** No row, or a row labelled for another network. */
  | { kind: "none" }
  | { kind: "issued"; row: DepositAddressRow }
  /** The stored address is not the derived one. Never shown. */
  | { kind: "mismatch" };

function judge(
  deps: Pick<DepositAddressDeps, "deriveAddress" | "network">,
  orgId: string,
  row: DepositAddressRow | null,
): DepositAddressRead | { kind: "other_network"; row: DepositAddressRow } {
  if (!row) return { kind: "none" };
  if (row.address !== deps.deriveAddress(orgId)) {
    // Neither address is a secret; both are on the chain.
    logger.error(
      { orgId, network: row.network },
      "stored deposit address is not the one this server derives; it is not shown",
    );
    return { kind: "mismatch" };
  }
  if (row.network !== deps.network) return { kind: "other_network", row };
  return { kind: "issued", row };
}

/** Reads the organization's address on this network. Never writes. */
export async function readDepositAddress(
  deps: Pick<DepositAddressDeps, "store" | "deriveAddress" | "network">,
  orgId: string,
): Promise<DepositAddressRead> {
  const read = judge(deps, orgId, await deps.store.find(orgId));
  return read.kind === "other_network" ? { kind: "none" } : read;
}

/**
 * Issues the organization's address on this network. Idempotent: a second
 * call finds the row the first one made. Never answers "none".
 */
export async function issueDepositAddress(
  deps: Pick<DepositAddressDeps, "store" | "deriveAddress" | "network">,
  orgId: string,
): Promise<Exclude<DepositAddressRead, { kind: "none" }>> {
  // Twice at most: once as found, once after this call's own write (or
  // the write of a request that got there first).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = judge(deps, orgId, await deps.store.find(orgId));
    if (read.kind === "issued" || read.kind === "mismatch") return read;
    if (read.kind === "none") {
      await deps.store.create({
        orgId,
        address: deps.deriveAddress(orgId),
        network: deps.network,
      });
    } else {
      await deps.store.relabel({
        orgId,
        address: read.row.address,
        fromNetwork: read.row.network,
        network: deps.network,
      });
    }
  }
  const settled = judge(deps, orgId, await deps.store.find(orgId));
  if (settled.kind === "issued" || settled.kind === "mismatch") return settled;
  throw new Error("the deposit address could not be issued");
}

/**
 * Whether the USDC account at the address exists.
 *
 * Once seen it is never read again (the account is never closed). Before
 * that, one read; with `record` the first sighting is stored. A read that
 * fails is "not open": the answer is advisory and nothing is stored.
 */
export async function readUsdcAccountOpen(
  deps: Pick<DepositAddressDeps, "store" | "usdcAccountExists" | "now">,
  row: DepositAddressRow,
  options: { record: boolean },
): Promise<boolean> {
  if (row.usdcAccountOpenedAt) return true;
  let exists: boolean;
  try {
    exists = await deps.usdcAccountExists(row.address);
  } catch (err) {
    logger.warn({ err, orgId: row.orgId }, "USDC account of a deposit address could not be read");
    return false;
  }
  if (!exists) return false;
  if (options.record) {
    await deps.store.markUsdcAccountOpen({
      orgId: row.orgId,
      at: (deps.now ?? (() => new Date()))(),
      by: null,
    });
  }
  return true;
}
