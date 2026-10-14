/**
 * Production wiring for the operator's money report (routes/platformMoney.ts,
 * services/platformMoney.ts).
 *
 * Everything here reads: sums over our own tables, one call to the node for
 * what the hot wallet and the treasury hold, the cluster check, the price
 * and the settings. Nothing is written, signed or sent.
 *
 * buildPlatformMoneyDeps takes its collaborators as arguments so the wiring
 * is unit tested against an in-memory store and a stand-in for the node.
 */

import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { FastifyPluginAsync } from "fastify";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection, type ClusterCheckResult } from "../lib/solana.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { getSolQuote } from "../services/buildSolPriceDeps.js";
import { chainLabel } from "../services/depositTypes.js";
import { hotWallet } from "../services/hotWallet.js";
import {
  OPEN_PAYOUT_STATUSES,
  SWEEP_KINDS_FROM_DEPOSIT,
  type MoneyNetwork,
  type MoneyRange,
  type MoneySwitches,
  type PlatformMoneyDeps,
  type WalletHolding,
} from "../services/platformMoney.js";
import type { SolPriceResult } from "../services/solPrice.js";
import { createLogger } from "../utils/logger.js";
import { createPlatformMoneyRoutes } from "./platformMoney.js";

const logger = createLogger("platform-money");

type Row = Record<string, any>;

interface Summed {
  aggregate(args: any): Promise<Row>;
}
interface Grouped {
  groupBy(args: any): Promise<Row[]>;
}

/** The slice of Prisma the report reads. */
export interface PlatformMoneyPrisma {
  creditBalance: Summed & { count(args: any): Promise<number> };
  publisherProfile: Summed;
  creatorPayout: Grouped;
  walletTopUp: Grouped & { findFirst(args: any): Promise<Row | null> };
  onchainReceipt: Grouped;
  stripePurchase: Summed;
  creditTransaction: Summed & Grouped;
  marketplaceRevenue: Summed;
  x402Payment: Grouped;
  depositAddress: Summed & { findFirst(args: any): Promise<Row | null> };
  chainTransfer: Grouped & { count(args: any): Promise<number> };
  platformWallet: { findUnique(args: any): Promise<Row | null> };
}

/** One account as the node answers it, or null when nothing is there. */
export interface ChainAccount {
  lamports: number;
  owner: PublicKey;
  data: Uint8Array;
}

export interface BuildPlatformMoneyDepsInput {
  prisma: PlatformMoneyPrisma;
  adminKey: () => string | undefined;
  now: () => Date;
  solanaNetwork: () => MoneyNetwork;
  treasurySetting: () => string | undefined;
  hotWalletAddress: () => string;
  clusterCheck: () => Promise<ClusterCheckResult>;
  /** One read of several accounts at "finalized", in the order asked. */
  getMultipleAccounts: (keys: PublicKey[]) => Promise<Array<ChainAccount | null>>;
  switches: () => MoneySwitches;
  solPriceSource: () => string;
  getSolQuote: () => Promise<SolPriceResult>;
  reportUnreadable?: (section: string, err: unknown) => void;
}

function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (value === null || value === undefined) return 0n;
  return BigInt(value as number | string);
}

function count(row: Row | null | undefined): number {
  const c = row?._count;
  if (typeof c === "number") return c;
  return typeof c?._all === "number" ? c._all : 0;
}

function within(range: MoneyRange) {
  return { gte: range.from, lt: range.to };
}

/**
 * The USDC a token account holds: 0 when the account is missing. An account
 * at that address that is not this mint's token account is not read as 0:
 * it throws, and the section says "unreadable".
 */
export function usdcHeld(account: ChainAccount | null, mint: PublicKey): bigint {
  if (!account) return 0n;
  const data = Buffer.from(account.data);
  if (!account.owner.equals(TOKEN_PROGRAM_ID) || data.length < 72) {
    throw new Error("the USDC account is not a token account");
  }
  if (!new PublicKey(data.subarray(0, 32)).equals(mint)) {
    throw new Error("the USDC account is for another mint");
  }
  return data.readBigUInt64LE(64);
}

function lamportsHeld(account: ChainAccount | null): bigint {
  if (!account) return 0n;
  if (!Number.isSafeInteger(account.lamports) || account.lamports < 0) {
    throw new Error("the node did not answer with a balance");
  }
  return BigInt(account.lamports);
}

export function buildPlatformMoneyDeps(input: BuildPlatformMoneyDepsInput): PlatformMoneyDeps {
  const db = input.prisma;
  const chain = () => chainLabel(input.solanaNetwork());

  return {
    adminKey: input.adminKey,
    now: input.now,
    network: input.solanaNetwork,
    reportUnreadable: input.reportUnreadable,

    async readCustomers() {
      const [sum, holders] = await Promise.all([
        db.creditBalance.aggregate({ _sum: { balanceCents: true } }),
        db.creditBalance.count({ where: { balanceCents: { gt: 0n } } }),
      ]);
      return { balanceCents: big(sum._sum?.balanceCents), organizationsWithBalance: holders };
    },

    async readCreators(range) {
      const [owed, open, paid] = await Promise.all([
        db.publisherProfile.aggregate({ _sum: { pendingPayoutCents: true } }),
        db.creatorPayout.groupBy({
          by: ["payoutMethod"],
          where: { status: { in: [...OPEN_PAYOUT_STATUSES] } },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        db.creatorPayout.groupBy({
          by: ["payoutMethod"],
          where: { status: "completed", processedAt: within(range) },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
      ]);
      const rows = (list: Row[]) =>
        list.map((r) => ({
          method: String(r.payoutMethod),
          count: count(r),
          amountCents: big(r._sum?.amountCents),
        }));
      return {
        owedCents: big(owed._sum?.pendingPayoutCents),
        openPayouts: rows(open),
        paidOutInRange: rows(paid),
      };
    },

    async readIncome(range) {
      const [topups, deposits, stripe, purchases, bonuses, debits, fees, x402] = await Promise.all([
        db.walletTopUp.groupBy({
          by: ["asset"],
          where: { status: "credited", creditedAt: within(range) },
          _sum: { amountUsdCents: true },
          _count: { _all: true },
        }),
        db.onchainReceipt.groupBy({
          by: ["asset"],
          where: { status: "credited", source: "direct", creditedAt: within(range) },
          _sum: { amountUsdCents: true },
          _count: { _all: true },
        }),
        db.stripePurchase.aggregate({
          where: { status: "completed", completedAt: within(range) },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        db.creditTransaction.aggregate({
          where: { type: "purchase", createdAt: within(range) },
          _sum: { amountCents: true },
          _count: { _all: true },
        }),
        db.creditTransaction.aggregate({
          where: { type: "bonus", createdAt: within(range) },
          _sum: { amountCents: true },
        }),
        db.creditTransaction.groupBy({
          by: ["type"],
          where: { amountCents: { lt: 0n }, createdAt: within(range) },
          _sum: { amountCents: true },
        }),
        db.marketplaceRevenue.aggregate({
          where: { status: "settled", settledAt: within(range) },
          _sum: { platformFeeCents: true },
        }),
        // A deployment's own payments only. A payment with a listing paid one
        // use of a creator's agent from a wallet: its gross is the creator's
        // sale, and the platform's 10% of it is already in the fees above.
        db.x402Payment.groupBy({
          by: ["asset"],
          where: { status: "settled", listingId: null, settledAt: within(range) },
          _sum: { amountUsd: true },
          _count: { _all: true },
        }),
      ]);
      const byAsset = (list: Row[]) =>
        list.map((r) => ({
          asset: String(r.asset),
          count: count(r),
          amountCents: big(r._sum?.amountUsdCents),
        }));
      return {
        walletTopups: byAsset(topups),
        deposits: byAsset(deposits),
        stripe: { count: count(stripe), amountCents: big(stripe._sum?.amountCents) },
        purchases: { count: count(purchases), amountCents: big(purchases._sum?.amountCents) },
        bonusesGrantedCents: big(bonuses._sum?.amountCents),
        debits: debits.map((r) => ({ type: String(r.type), amountCents: big(r._sum?.amountCents) })),
        marketplaceFeesCents: big(fees._sum?.platformFeeCents),
        x402: x402.map((r) => ({
          asset: String(r.asset),
          count: count(r),
          amountUsd: Number(r._sum?.amountUsd ?? 0),
        })),
      };
    },

    treasurySetting: input.treasurySetting,
    hotWalletAddress: input.hotWalletAddress,

    async readTreasuryRow() {
      const row = await db.platformWallet.findUnique({
        where: { role_network: { role: "treasury", network: chain() } },
      });
      return row ? { address: String(row.address) } : null;
    },

    // An address this server derives is one it has handed out: the row of an
    // organization's deposit address, or the address a prepared top-up was
    // sent to (the same derivation, from before the row existed).
    async isDepositAddress(address) {
      const [issued, prepared] = await Promise.all([
        db.depositAddress.findFirst({ where: { address }, select: { orgId: true } }),
        db.walletTopUp.findFirst({ where: { depositAddress: address }, select: { id: true } }),
      ]);
      return issued !== null || prepared !== null;
    },

    async readWallets(addresses) {
      const cluster = await input.clusterCheck();
      if (!cluster.ok) throw new Error(`the Solana cluster check is not ok: ${cluster.reason}`);
      const mint = usdcMintForNetwork(input.solanaNetwork());
      const keys: PublicKey[] = [];
      for (const address of addresses) {
        const owner = new PublicKey(address);
        // true: a treasury setting that is not an ordinary wallet is still
        // read, and rule 4 is what says it is not proven.
        keys.push(owner, getAssociatedTokenAddressSync(mint, owner, true));
      }
      const accounts = await input.getMultipleAccounts(keys);
      if (!Array.isArray(accounts) || accounts.length !== keys.length) {
        throw new Error("the node did not answer for every account");
      }
      const out: WalletHolding[] = [];
      for (let i = 0; i < addresses.length; i += 1) {
        out.push({
          lamports: lamportsHeld(accounts[2 * i] ?? null),
          usdcRaw: usdcHeld(accounts[2 * i + 1] ?? null, mint),
        });
      }
      return out;
    },

    async readDepositHoldings() {
      const sum = await db.depositAddress.aggregate({
        where: { network: chain() },
        _sum: { lastSeenLamports: true, lastSeenUsdcRaw: true },
        _count: { _all: true },
      });
      return {
        count: count(sum),
        lamports: big(sum._sum?.lastSeenLamports),
        usdcRaw: big(sum._sum?.lastSeenUsdcRaw),
      };
    },

    async readSweeps(range) {
      const network = chain();
      const [sent, landed, failed] = await Promise.all([
        db.chainTransfer.count({ where: { network, status: "sent" } }),
        db.chainTransfer.groupBy({
          by: ["kind", "asset"],
          where: { network, status: "landed", settledAt: within(range) },
          _sum: { amountRaw: true },
          _count: { _all: true },
        }),
        db.chainTransfer.count({ where: { network, status: "failed", settledAt: within(range) } }),
      ]);
      return {
        sent,
        landedInRange: landed.map((r) => ({
          kind: String(r.kind),
          asset: String(r.asset),
          count: count(r),
          amountRaw: big(r._sum?.amountRaw),
        })),
        failedInRange: failed,
      };
    },

    async readLedger() {
      const network = chain();
      const [received, swept] = await Promise.all([
        db.onchainReceipt.groupBy({
          by: ["asset"],
          where: { network },
          _sum: { amountRaw: true },
        }),
        db.chainTransfer.groupBy({
          by: ["asset", "fromAddress", "feePayer", "status"],
          // Landed, and failed on the chain: a failed one moved nothing but
          // its fee was taken. A dead one never reached the chain.
          where: { network, status: { in: ["landed", "failed"] }, kind: { in: [...SWEEP_KINDS_FROM_DEPOSIT] } },
          _sum: { amountRaw: true, feeLamports: true },
        }),
      ]);
      const of = (asset: string) =>
        received
          .filter((r) => r.asset === asset)
          .reduce((total, r) => total + big(r._sum?.amountRaw), 0n);
      return {
        receivedUsdcRaw: of("USDC"),
        receivedLamports: of("SOL"),
        swept: swept.map((r) => ({
          asset: String(r.asset),
          fromAddress: String(r.fromAddress),
          feePayer: String(r.feePayer),
          landed: r.status === "landed",
          amountRaw: big(r._sum?.amountRaw),
          feeLamports: big(r._sum?.feeLamports),
        })),
      };
    },

    async clusterCheck() {
      const result = await input.clusterCheck();
      return result.ok ? "ok" : result.reason;
    },

    switches: input.switches,

    async solPrice() {
      const source = input.solPriceSource();
      if (source === "off") return { source, ok: false, ageSeconds: null };
      const result = await input.getSolQuote();
      return result.ok
        ? { source, ok: true, ageSeconds: result.quote.ageSeconds }
        : { source, ok: false, ageSeconds: null };
    },
  };
}

/** Is each money rail switched on with its worker scheduled. */
export function moneySwitches(e: {
  WALLET_TOPUPS_ENABLED: boolean;
  TOPUP_RECONCILE_INTERVAL_MS: number;
  DEPOSITS_ENABLED: boolean;
  DEPOSIT_SCAN_INTERVAL_MS: number;
  SWEEPS_ENABLED: boolean;
  SWEEP_INTERVAL_MS: number;
  PAYOUTS_ENABLED: boolean;
  PAYOUT_EXECUTOR_INTERVAL_MS: number;
}): MoneySwitches {
  return {
    walletTopups: e.WALLET_TOPUPS_ENABLED && e.TOPUP_RECONCILE_INTERVAL_MS > 0,
    // Deposits have no worker of their own: the scan below is theirs.
    deposits: e.DEPOSITS_ENABLED,
    depositScan: e.DEPOSITS_ENABLED && e.DEPOSIT_SCAN_INTERVAL_MS > 0,
    sweeps: e.SWEEPS_ENABLED && e.SWEEP_INTERVAL_MS > 0,
    payouts: e.PAYOUTS_ENABLED && e.PAYOUT_EXECUTOR_INTERVAL_MS > 0,
  };
}

/** Production-wired plugin, as mounted by index.ts at /api/platform. */
export function createPlatformMoneyRoutesProduction(): FastifyPluginAsync {
  return createPlatformMoneyRoutes(
    buildPlatformMoneyDeps({
      prisma: prisma as unknown as PlatformMoneyPrisma,
      // Read per request, so rotating the key needs no reboot.
      adminKey: () => process.env.PLATFORM_ADMIN_KEY,
      now: () => new Date(),
      solanaNetwork: () => env.SOLANA_NETWORK,
      treasurySetting: () => env.TREASURY_WALLET_ADDRESS,
      hotWalletAddress: () => hotWallet.address(),
      clusterCheck: ensureSolanaCluster,
      getMultipleAccounts: (keys) =>
        getSolanaConnection().getMultipleAccountsInfo(keys, "finalized"),
      switches: () => moneySwitches(env),
      solPriceSource: () => env.SOL_PRICE_SOURCE,
      getSolQuote,
      reportUnreadable(section, err) {
        logger.error({ section, err }, "Money report: a section could not be read");
      },
    }),
  );
}
