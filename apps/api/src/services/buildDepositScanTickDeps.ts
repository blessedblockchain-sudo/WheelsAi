/**
 * Composition root for the deposit scan (payments pass, batch 5): binds
 * the pure runDepositScanTick and runDepositCheck to Prisma, to the shared
 * Solana connection and to config/env.ts.
 *
 * The money rules live elsewhere; this file only wires them:
 *   - what a transaction did to an address: services/depositScan.ts
 *   - how a found transfer is credited once: services/depositCredit.ts
 *   - when a history is read and how far a cursor moves:
 *     services/runDepositScanTick.ts
 *
 * Every chain read here is at the "finalized" commitment: only finalized
 * transfers are credited. No Connection is made here (lib/solana.ts owns
 * the only one); buildDepositScanDeps takes a getter so a test can pass a
 * stand-in.
 */

import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { createLogger } from "../utils/logger.js";
import { getSolQuote, getSolQuoteMarginBps } from "./buildSolPriceDeps.js";
import {
  makeDepositCredit,
  type DepositCreditDb,
  type DetectedReceipt,
} from "./depositCredit.js";
import {
  transactionFactsFromRpc,
  type RpcTransactionLike,
} from "./depositScan.js";
import {
  chainLabel,
  type ChainLabel,
  type CheckDepositsNow,
} from "./depositTypes.js";
import {
  runDepositCheck,
  type AddressSnapshot,
  type DepositScanDeps,
  type DepositScanEvent,
  type WatchedAddressRow,
} from "./runDepositScanTick.js";
import type { SolPriceResult } from "./solPrice.js";
import { deriveTopupDepositKeypair } from "./topupKeypairs.js";

const logger = createLogger("deposit-scan");

/** The connection calls the scan makes. */
export type DepositScanConnection = Pick<
  Connection,
  "getMultipleAccountsInfo" | "getSignaturesForAddress" | "getTransaction"
>;

/** The columns of onchain_receipts the scan reads back. */
interface ReceiptDbRow {
  id: string;
  orgId: string;
  asset: string;
  amountRaw: bigint;
  txSignature: string;
}

/** The part of the Prisma client the scan uses, beyond what crediting
 * does (services/depositCredit.ts DepositCreditDb). */
export interface DepositScanDb extends DepositCreditDb {
  depositAddress: {
    findMany: (args: {
      where: { network: string };
      orderBy: Array<Record<string, { sort: "asc"; nulls: "first" | "last" }>>;
      take: number;
    }) => Promise<WatchedAddressRow[]>;
    findUnique: (args: {
      where: { orgId: string };
    }) => Promise<WatchedAddressRow | null>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  onchainReceipt: DepositCreditDb["onchainReceipt"] & {
    findMany: (args: {
      where: { network: string; status: "detected"; orgId?: string };
      orderBy: { createdAt: "asc" };
      take: number;
    }) => Promise<ReceiptDbRow[]>;
  };
}

export interface BuildDepositScanDepsInput {
  db: DepositScanDb;
  /** The row label of the chain the settings name. */
  network: ChainLabel;
  usdcMint: PublicKey;
  getConnection: () => DepositScanConnection;
  /** lib/solana.ts ensureSolanaCluster. */
  checkCluster: () => Promise<{ ok: boolean; reason?: string }>;
  /** The address this server derives for an organization. */
  deriveAddress: (orgId: string) => string;
  /** services/buildSolPriceDeps.ts getSolQuote. */
  getSolQuote: () => Promise<SolPriceResult>;
  solMarginBps: () => number;
  log?: (event: DepositScanEvent) => void;
  now?: () => Date;
  /** For tests: a smaller page of history. */
  historyPageSize?: number;
}

// A token account's amount: a u64, little-endian, after the mint and the
// owner (32 bytes each).
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

/** What a USDC account holds. An account that is not there, or is not a
 * token account, holds nothing and is not open. */
function usdcAccountState(
  account: { owner: PublicKey; data: Uint8Array } | null,
): { exists: boolean; raw: bigint } {
  if (
    !account ||
    !account.owner.equals(TOKEN_PROGRAM_ID) ||
    account.data.byteLength < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8
  ) {
    return { exists: false, raw: 0n };
  }
  const raw = new DataView(
    account.data.buffer,
    account.data.byteOffset,
    account.data.byteLength,
  ).getBigUint64(TOKEN_ACCOUNT_AMOUNT_OFFSET, true);
  return { exists: true, raw };
}

function toWatchedRow(row: WatchedAddressRow): WatchedAddressRow {
  return {
    orgId: row.orgId,
    address: row.address,
    network: row.network,
    usdcAccountOpenedAt: row.usdcAccountOpenedAt,
    lastSolSignature: row.lastSolSignature,
    lastUsdcSignature: row.lastUsdcSignature,
    lastSeenLamports: row.lastSeenLamports,
    lastSeenUsdcRaw: row.lastSeenUsdcRaw,
    scanRequestedAt: row.scanRequestedAt,
  };
}

export function buildDepositScanDeps(
  input: BuildDepositScanDepsInput,
): DepositScanDeps {
  const { db, network, usdcMint, getConnection } = input;
  const credit = makeDepositCredit(db, {
    network,
    getSolQuote: input.getSolQuote,
    solMarginBps: input.solMarginBps,
    now: input.now,
  });

  return {
    checkCluster: input.checkCluster,
    deriveAddress: input.deriveAddress,
    usdcAccountOf: (address) =>
      getAssociatedTokenAddressSync(usdcMint, new PublicKey(address)).toBase58(),
    usdcMint: usdcMint.toBase58(),
    log: input.log,
    historyPageSize: input.historyPageSize,

    loadDetected: async ({ limit, orgId }) => {
      const rows = await db.onchainReceipt.findMany({
        where: {
          network,
          status: "detected",
          ...(orgId !== undefined ? { orgId } : {}),
        },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.map(
        (row): DetectedReceipt => ({
          id: row.id,
          orgId: row.orgId,
          asset: row.asset,
          amountRaw: row.amountRaw,
          txSignature: row.txSignature,
        }),
      );
    },

    // Those whose owner asked first (the oldest request first), then the
    // least recently scanned, a row never scanned before any other.
    loadAddresses: async ({ limit }) => {
      const rows = await db.depositAddress.findMany({
        where: { network },
        orderBy: [
          { scanRequestedAt: { sort: "asc", nulls: "last" } },
          { lastScannedAt: { sort: "asc", nulls: "first" } },
        ],
        take: limit,
      });
      return rows.map(toWatchedRow);
    },

    loadAddress: async (orgId) => {
      const row = await db.depositAddress.findUnique({ where: { orgId } });
      return row ? toWatchedRow(row) : null;
    },

    // ONE call: the addresses, then their USDC accounts.
    watch: async (targets) => {
      const keys = [
        ...targets.map((target) => new PublicKey(target.address)),
        ...targets.map((target) => new PublicKey(target.usdcAccount)),
      ];
      const infos = await getConnection().getMultipleAccountsInfo(
        keys,
        "finalized",
      );
      if (!Array.isArray(infos) || infos.length !== keys.length) {
        throw new Error("the node did not answer for every account");
      }
      return targets.map((_, i): AddressSnapshot => {
        const usdc = usdcAccountState(infos[targets.length + i] ?? null);
        return {
          lamports: BigInt(infos[i]?.lamports ?? 0),
          usdcAccountExists: usdc.exists,
          usdcRaw: usdc.raw,
        };
      });
    },

    listSignatures: async ({ account, before, until, limit }) => {
      const page = await getConnection().getSignaturesForAddress(
        new PublicKey(account),
        {
          limit,
          ...(before !== undefined ? { before } : {}),
          ...(until !== undefined ? { until } : {}),
        },
        "finalized",
      );
      return page.map((entry) => entry.signature);
    },

    loadTransaction: async (signature) => {
      const response = await getConnection().getTransaction(signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      return transactionFactsFromRpc(
        signature,
        response as unknown as RpcTransactionLike | null,
      );
    },

    creditFoundTransfer: credit.creditFoundTransfer,
    creditDetectedReceipt: credit.creditDetectedReceipt,

    markWatched: async ({ orgIds, now }) => {
      await db.depositAddress.updateMany({
        where: { orgId: { in: orgIds } },
        data: { lastScannedAt: now },
      });
    },

    markUsdcAccountOpen: async ({ orgId, now }) => {
      await db.depositAddress.updateMany({
        where: { orgId, usdcAccountOpenedAt: null },
        data: { usdcAccountOpenedAt: now },
      });
    },

    saveProgress: async ({ orgId, sol, usdc, answeredRequestAt, now }) => {
      await db.depositAddress.updateMany({
        where: { orgId },
        data: {
          lastScannedAt: now,
          ...(sol
            ? { lastSolSignature: sol.signature, lastSeenLamports: sol.lamports }
            : {}),
          ...(usdc
            ? { lastUsdcSignature: usdc.signature, lastSeenUsdcRaw: usdc.usdcRaw }
            : {}),
        },
      });
      if (answeredRequestAt !== null) {
        // Only the request this run answered: one made while it ran stays.
        await db.depositAddress.updateMany({
          where: { orgId, scanRequestedAt: answeredRequestAt },
          data: { scanRequestedAt: null },
        });
      }
    },
  };
}

// ============================================
// Production
// ============================================

/** How a run's events reach the log. Nothing here reaches a customer. */
export function logDepositScanEvent(event: DepositScanEvent): void {
  const line = {
    orgId: event.orgId,
    address: event.address,
    signature: event.signature,
    asset: event.asset,
    detail: event.detail,
  };
  if (event.kind === "error") {
    logger.error(line, "Deposit scan: error");
  } else if (event.kind === "transfer_out") {
    logger.warn(line, "Deposit scan: a transfer left a deposit address");
  } else if (event.kind === "unexplained") {
    logger.warn(line, "Deposit scan: a balance its history does not explain");
  } else {
    logger.info(line, `Deposit scan: transfer ${event.kind}`);
  }
}

/** The scan's dependencies, bound to Prisma, the shared connection and
 * the settings. */
export function buildProductionDepositScanDeps(): DepositScanDeps {
  return buildDepositScanDeps({
    db: prisma as unknown as DepositScanDb,
    network: chainLabel(env.SOLANA_NETWORK),
    usdcMint: usdcMintForNetwork(env.SOLANA_NETWORK),
    getConnection: () => getSolanaConnection(),
    checkCluster: () => ensureSolanaCluster(),
    deriveAddress: (orgId) =>
      deriveTopupDepositKeypair({
        // Deposits on means the wallet rail is on, which means the key is
        // present (config/env.ts). Without it this throws and the row is
        // not read.
        masterKey: env.WALLET_MASTER_KEY ?? "",
        orgId,
      }).publicKey.toBase58(),
    getSolQuote: () => getSolQuote(),
    solMarginBps: () => getSolQuoteMarginBps(),
    log: logDepositScanEvent,
  });
}

let productionDeps: DepositScanDeps | null = null;

/**
 * "Check now" for one organization, bound to the production connection
 * and settings: reads its address's history whatever its balance and
 * tries its waiting receipts again. Never throws.
 */
export const checkDepositsNow: CheckDepositsNow = (orgId) => {
  if (!productionDeps) productionDeps = buildProductionDepositScanDeps();
  return runDepositCheck(
    orgId,
    {
      enabled: env.DEPOSITS_ENABLED,
      network: chainLabel(env.SOLANA_NETWORK),
    },
    productionDeps,
  );
};
