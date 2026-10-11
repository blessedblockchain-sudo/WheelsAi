/**
 * Production wiring for the wallet top-up rail.
 *
 * Always mounted under /api/billing — when WALLET_TOPUPS_ENABLED is
 * false the routes answer 501 instead of 404ing, so a probe tells the
 * truth about why.
 *
 * Three parts, so each can be given a stand-in:
 *   - buildWalletTopupStore(db): every read and write of wallet_topups.
 *     Each status change is a compare-and-set with the count checked.
 *   - buildWalletTopupChain(getConnection): the reads and the one send
 *     against the shared Solana connection.
 *   - buildProductionWalletTopupDeps(): the two above, bound to Prisma,
 *     the connection and config/env.ts, plus the quote, the fate and the
 *     cluster check from batch 1.
 *
 * SOL is offered when SOL_PRICE_SOURCE is not "off"; its price is the
 * live quote and nothing else. env.ts enforces at start that
 * WALLET_TOPUPS_ENABLED has WALLET_MASTER_KEY (deposit addresses derive
 * from it) and, outside development, the reconcile worker.
 */

import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { FastifyPluginAsync } from "fastify";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { readSignatureFate } from "../services/buildSignatureFateDeps.js";
import {
  errorDetail,
  getSolQuote,
  getSolQuoteMarginBps,
} from "../services/buildSolPriceDeps.js";
import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import { TOPUP_FAILURE_CODES } from "../services/topupSentences.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import {
  makeCreditTopup,
  type TopupCreditDb,
} from "../services/walletTopup.js";
import {
  createWalletTopupRoutes,
  type PayerBalances,
  type TopupRowView,
  type WalletTopupRouteDeps,
} from "./walletTopup.js";

/** The longest a submit waits for the node before it answers 202. */
export const TOPUP_CONFIRM_WAIT_MS = 30_000;

// ============================================
// The store
// ============================================

/** The columns of wallet_topups the routes read. */
export interface TopupDbRow {
  id: string;
  orgId: string;
  asset: string;
  network: string;
  amountUsdCents: bigint;
  bonusCents: bigint;
  amountRaw: string;
  quotedSolPriceUsd: number | null;
  payerAddress: string;
  depositAddress: string;
  unsignedMessageB64: string;
  txSignature: string | null;
  status: string;
  failureCode: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastValidBlockHeight: bigint;
}

/** The part of the Prisma client the store uses. */
export interface TopupStoreDb {
  walletTopUp: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    findFirst: (args: {
      where: { id: string; orgId: string };
    }) => Promise<TopupDbRow | null>;
    findMany: (args: {
      where: { orgId: string };
      orderBy: { createdAt: "desc" };
      take: number;
    }) => Promise<TopupDbRow[]>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  creditBalance: {
    findUnique: (args: {
      where: { orgId: string };
    }) => Promise<{ balanceCents: bigint } | null>;
  };
  /** The addresses the deposit scan watches (services/runDepositScanTick.ts). */
  depositAddress: {
    findUnique: (args: {
      where: { orgId: string };
    }) => Promise<{ orgId: string } | null>;
    create: (args: {
      data: { orgId: string; address: string; network: string };
    }) => Promise<unknown>;
  };
}

export type WalletTopupStore = Pick<
  WalletTopupRouteDeps,
  | "createTopup"
  | "findTopup"
  | "listTopups"
  | "claimForSubmit"
  | "markStatus"
  | "expireStalePrepared"
  | "readBalanceCents"
>;

/** Field by field, so a column added to the table (failure_reason among
 * them) never rides along into an answer. */
function toView(row: TopupDbRow): TopupRowView {
  return {
    id: row.id,
    orgId: row.orgId,
    asset: row.asset,
    network: row.network,
    amountUsdCents: row.amountUsdCents,
    bonusCents: row.bonusCents,
    amountRaw: row.amountRaw,
    quotedSolPriceUsd: row.quotedSolPriceUsd,
    payerAddress: row.payerAddress,
    depositAddress: row.depositAddress,
    unsignedMessageB64: row.unsignedMessageB64,
    txSignature: row.txSignature,
    status: row.status,
    failureCode: row.failureCode,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastValidBlockHeight: row.lastValidBlockHeight,
  };
}

export function buildWalletTopupStore(db: TopupStoreDb): WalletTopupStore {
  return {
    createTopup: async (data) => {
      // Every address money can arrive at is watched: the organization's
      // deposit_addresses row is made before the transfer is handed out.
      // A row that exists is left exactly as it is. Two requests can both
      // find none; the one that loses the insert has what it wanted.
      const watched = await db.depositAddress.findUnique({
        where: { orgId: data.orgId },
      });
      if (!watched) {
        try {
          await db.depositAddress.create({
            data: {
              orgId: data.orgId,
              address: data.depositAddress,
              network: data.network,
            },
          });
        } catch (err) {
          if ((err as { code?: string }).code !== "P2002") throw err;
          const now = await db.depositAddress.findUnique({
            where: { orgId: data.orgId },
          });
          // The address is held by another organization's row: refuse.
          if (!now) throw err;
        }
      }
      await db.walletTopUp.create({
        data: {
          id: data.id,
          orgId: data.orgId,
          asset: data.asset,
          network: data.network,
          amountUsdCents: data.amountUsdCents,
          bonusCents: data.bonusCents,
          amountRaw: data.amountRaw,
          quotedSolPriceUsd: data.quotedSolPriceUsd,
          quotePriceMicroUsd: data.quotePriceMicroUsd,
          quotePublishTime: data.quotePublishTime,
          quoteSource: data.quoteSource,
          payerAddress: data.payerAddress,
          depositAddress: data.depositAddress,
          unsignedMessageB64: data.unsignedMessageB64,
          expiresAt: data.expiresAt,
          lastValidBlockHeight: data.lastValidBlockHeight,
        },
      });
    },

    findTopup: async ({ id, orgId }) => {
      const row = await db.walletTopUp.findFirst({ where: { id, orgId } });
      return row ? toView(row) : null;
    },

    listTopups: async ({ orgId, limit }) => {
      const rows = await db.walletTopUp.findMany({
        where: { orgId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return rows.map(toView);
    },

    // The claim stores the signature, the signed bytes and the time in
    // the same compare-and-set that takes the row, BEFORE the send.
    claimForSubmit: async ({ id, txSignature, signedTxB64, submittedAt }) => {
      try {
        const result = await db.walletTopUp.updateMany({
          where: { id, status: "prepared" },
          data: {
            status: "submitting",
            txSignature,
            signedTxB64,
            submittedAt,
          },
        });
        return result.count === 1 ? "claimed" : "lost";
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") {
          return "duplicate_signature";
        }
        throw err;
      }
    },

    markStatus: async ({ id, from, to, failureCode, failureReason }) => {
      const result = await db.walletTopUp.updateMany({
        where: { id, status: { in: from } },
        data: {
          status: to,
          ...(failureCode !== undefined ? { failureCode } : {}),
          ...(failureReason !== undefined ? { failureReason } : {}),
        },
      });
      return result.count === 1;
    },

    // Only rows that were never signed: a row with a signature is ended
    // by the chain and by nothing else.
    expireStalePrepared: async ({ orgId, now }) => {
      await db.walletTopUp.updateMany({
        where: {
          orgId,
          status: "prepared",
          txSignature: null,
          expiresAt: { lt: now },
        },
        data: {
          status: "expired",
          failureCode: TOPUP_FAILURE_CODES.unsignedExpired,
        },
      });
    },

    readBalanceCents: async (orgId) => {
      const balance = await db.creditBalance.findUnique({ where: { orgId } });
      return balance ? balance.balanceCents : 0n;
    },
  };
}

// ============================================
// The chain
// ============================================

export type TopupConnection = Pick<
  Connection,
  | "getLatestBlockhash"
  | "getMultipleAccountsInfo"
  | "sendRawTransaction"
  | "getSignatureStatuses"
>;

export type WalletTopupChain = Pick<
  WalletTopupRouteDeps,
  | "getLatestBlockhash"
  | "readPayerBalances"
  | "sendRawTransaction"
  | "waitForConfirmation"
>;

// A token account's amount: a u64, little-endian, after the mint and the
// owner (32 bytes each).
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

function tokenAmount(
  account: { owner: PublicKey; data: Uint8Array } | null,
): bigint | null {
  // No token account is a balance of nothing.
  if (!account) return 0n;
  if (
    !account.owner.equals(TOKEN_PROGRAM_ID) ||
    account.data.byteLength < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8
  ) {
    return null;
  }
  return new DataView(
    account.data.buffer,
    account.data.byteOffset,
    account.data.byteLength,
  ).getBigUint64(TOKEN_ACCOUNT_AMOUNT_OFFSET, true);
}

/** How often the wait asks the node about a signature. */
export const TOPUP_CONFIRM_POLL_MS = 1_500;

/** Resolves when the promise settles or the time is up, whichever is
 * first, and leaves no timer behind. Never rejects. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

export function buildWalletTopupChain(input: {
  getConnection: () => TopupConnection;
  usdcMint: PublicKey;
  confirmWaitMs?: number;
  confirmPollMs?: number;
}): WalletTopupChain {
  const { getConnection, usdcMint } = input;
  const confirmWaitMs = input.confirmWaitMs ?? TOPUP_CONFIRM_WAIT_MS;
  const confirmPollMs = input.confirmPollMs ?? TOPUP_CONFIRM_POLL_MS;

  return {
    getLatestBlockhash: async () => {
      const { blockhash, lastValidBlockHeight } =
        await getConnection().getLatestBlockhash("confirmed");
      return { blockhash, lastValidBlockHeight };
    },

    // ONE call for everything the check needs: the payer, and for USDC
    // the payer's token account and the organization's.
    readPayerBalances: async ({ payerAddress, depositAddress, asset }) => {
      const payer = new PublicKey(payerAddress);
      const keys = [payer];
      if (asset === "USDC") {
        keys.push(
          getAssociatedTokenAddressSync(usdcMint, payer),
          getAssociatedTokenAddressSync(usdcMint, new PublicKey(depositAddress)),
        );
      }
      const infos = await getConnection().getMultipleAccountsInfo(
        keys,
        "confirmed",
      );
      if (!Array.isArray(infos) || infos.length !== keys.length) {
        throw new Error("the node did not answer for every account");
      }
      const balances: PayerBalances = {
        lamports: BigInt(infos[0]?.lamports ?? 0),
        usdcRaw: null,
        depositUsdcAccountExists: null,
      };
      if (asset === "USDC") {
        balances.usdcRaw = tokenAmount(infos[1] ?? null);
        balances.depositUsdcAccountExists = (infos[2] ?? null) !== null;
      }
      return balances;
    },

    // A refusal here says nothing about the chain: a node can refuse or
    // time out on a transaction that another node has already taken.
    sendRawTransaction: async (rawTxBase64) => {
      try {
        await getConnection().sendRawTransaction(
          Buffer.from(rawTxBase64, "base64"),
          { skipPreflight: false, maxRetries: 3 },
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: errorDetail(err) };
      }
    },

    // Asks the node about the signature until it is confirmed or has
    // failed, at most confirmWaitMs. It asks rather than subscribes: a
    // subscription needs a WebSocket, which not every RPC plan serves at
    // the address the HTTP one is at, and without one the request would
    // hold for the whole limit. Whatever the node says or throws decides
    // nothing: the caller reads the signature's fate.
    waitForConfirmation: async ({ signature }) => {
      const deadline = Date.now() + confirmWaitMs;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return;
        let settled = false;
        const read = Promise.resolve()
          .then(() => getConnection().getSignatureStatuses([signature]))
          .then(
            (answer) => {
              const status = answer?.value?.[0] ?? null;
              if (!status) return;
              // Some providers leave the level out; `confirmations: null`
              // is then the node's way of saying the block is rooted.
              settled =
                status.err != null ||
                status.confirmationStatus === "confirmed" ||
                status.confirmationStatus === "finalized" ||
                (status.confirmationStatus == null && status.confirmations === null);
            },
            () => undefined,
          );
        await settledWithin(read, left);
        if (settled) return;
        const rest = deadline - Date.now();
        if (rest <= 0) return;
        await settledWithin(new Promise<void>(() => {}), Math.min(confirmPollMs, rest));
      }
    },
  };
}

// ============================================
// Production
// ============================================

export function buildProductionWalletTopupDeps(): WalletTopupRouteDeps {
  const network = env.SOLANA_NETWORK;
  const usdcMint = usdcMintForNetwork(network);

  const deriveDepositAddress = (orgId: string) =>
    deriveTopupDepositKeypair({
      // enabled ⇒ present, enforced by env.ts; the fallback only makes
      // the closure safe to construct while the rail is disabled.
      masterKey: env.WALLET_MASTER_KEY ?? "",
      orgId,
    }).publicKey.toBase58();

  return {
    enabled: env.WALLET_TOPUPS_ENABLED,
    network,
    solEnabled: env.SOL_PRICE_SOURCE !== "off",
    usdcMint: usdcMint.toBase58(),

    deriveDepositAddress,
    platformAddresses: (orgId) => [
      deriveDepositAddress(orgId),
      derivePayoutKeypair(env.WALLET_MASTER_KEY ?? "").publicKey.toBase58(),
    ],

    ensureCluster: () => ensureSolanaCluster(),
    getSolQuote: () => getSolQuote(),
    solMarginBps: () => getSolQuoteMarginBps(),
    readSignatureFate: (input) => readSignatureFate(input),

    ...buildWalletTopupChain({
      getConnection: () => getSolanaConnection(),
      usdcMint,
    }),
    ...buildWalletTopupStore(prisma as unknown as TopupStoreDb),

    creditTopup: makeCreditTopup(prisma as unknown as TopupCreditDb),
  };
}

export function createWalletTopupRoutesProduction(): FastifyPluginAsync {
  return createWalletTopupRoutes(buildProductionWalletTopupDeps());
}
