/**
 * Binds the payout worker's run (services/runPayoutExecutorTick.ts) to
 * Prisma, the connection and the settings. The rules live in the run; this
 * file is the writes and reads it asks for, each one a compare-and-set:
 *
 *   claimCredits     pending -> processing, for a payout taken as credits
 *   claimWallet      pending -> processing WITH the signed transfer stored,
 *                    before anything is broadcast
 *   markCompleted    processing -> completed, on the signature that landed
 *   returnToPending  processing -> pending on the signature that failed or
 *                    died: the claim cleared, the signature kept in
 *                    expired_signatures
 *   noteFirstSeen    claimed_at on a payout from before the height was kept
 *   setWaiting       waiting_reason, only while the payout is still pending
 *   failAndRestore   -> failed with its code, and the amount put back on
 *                    the creator's earnings through the earnings ledger, in
 *                    one transaction
 *
 * Every `where` names the status (and the signature, when there is one) the
 * row was read with, and the count is checked: a lost race writes nothing.
 */

import type { Prisma } from "@prisma/client";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";

import { moveEarnings, type EarningsLedgerTx } from "./earningsLedger.js";
import {
  makeSettleCreditsPayout,
  payingWalletCovers,
  readPayingWalletFunds,
  signPayoutTransfer,
  solPayoutAmount,
  type PayoutCreditsDb,
  type PayoutFundsConnection,
} from "./payoutExecutor.js";
import type {
  ClaimablePayoutRow,
  PayoutExecutorTickDeps,
  PayoutTickEvent,
} from "./runPayoutExecutorTick.js";
import type { SignatureFateAnswer, SignatureFateInput } from "./signatureFate.js";
import type { SolPriceResult } from "./solPrice.js";

const WALLET_METHODS = ["crypto_sol", "crypto_usdc"];
/** Operators read failure_reason; the chain's words are kept, to a length. */
const FAILURE_REASON_MAX_LENGTH = 1_000;

/** The columns of a creator_payouts row the worker reads. */
export interface PayoutExecutorDbRow {
  id: string;
  publisherId: string;
  amountCents: bigint;
  payoutMethod: string;
  payoutAddress: string | null;
  status: string;
  txSignature: string | null;
  signedTxB64: string | null;
  lastValidBlockHeight: bigint | null;
  claimedAt: Date | null;
  attemptCount: number;
  waitingReason: string | null;
  amountRaw?: string | null;
}

interface CreatorPayoutWrites {
  updateMany(args: {
    where: Prisma.CreatorPayoutWhereInput;
    data: Prisma.CreatorPayoutUpdateManyMutationInput;
  }): Promise<{ count: number }>;
}

/** What failAndRestore needs of a transaction. */
export interface PayoutExecutorTx extends EarningsLedgerTx {
  creatorPayout: CreatorPayoutWrites;
}

/** The part of a Prisma client the worker touches. */
export interface PayoutExecutorDb {
  creatorPayout: CreatorPayoutWrites & {
    findMany(args: {
      where: Prisma.CreatorPayoutWhereInput;
      orderBy: { requestedAt: "asc" };
      take: number;
    }): Promise<PayoutExecutorDbRow[]>;
    aggregate(args: {
      where: Prisma.CreatorPayoutWhereInput;
      _sum: { amountCents: true };
    }): Promise<{ _sum: { amountCents: bigint | null } }>;
  };
  $transaction<T>(fn: (tx: PayoutExecutorTx) => Promise<T>): Promise<T>;
}

/** The part of a Connection the worker touches. */
export type PayoutExecutorConnection = PayoutFundsConnection &
  Pick<Connection, "getLatestBlockhash" | "sendRawTransaction">;

export interface BuildPayoutExecutorDepsInput {
  /** A Prisma client: `prisma as unknown as PayoutExecutorDb` at the call site. */
  prisma: PayoutExecutorDb;
  connection: PayoutExecutorConnection;
  /**
   * The wallet that pays out (services/payoutKeypair.ts). Without one, no
   * wallet payout is signed: it waits as `wallet_low`, still cancellable.
   * A payout that already has a signature is still followed to its end.
   */
  payoutWallet?: Keypair;
  /** The network's USDC mint (lib/solanaAssets.ts usdcMintForNetwork). */
  usdcMint: PublicKey;
  /** PAYOUT_MAX_ATTEMPTS. */
  maxAttempts: number;
  /** PAYOUT_PLATFORM_MAX_PER_DAY_USD, whole dollars. */
  platformMaxPerDayUsd: number;
  /** lib/solana.ts ensureSolanaCluster. */
  checkCluster: PayoutExecutorTickDeps["checkCluster"];
  /** services/buildSolPriceDeps.ts getSolQuote. */
  getSolQuote: () => Promise<SolPriceResult>;
  /** services/buildSolPriceDeps.ts getSolQuoteMarginBps. */
  solQuoteMarginBps: () => number;
  /** services/buildSignatureFateDeps.ts readSignatureFate. */
  readSignatureFate: (input: SignatureFateInput) => Promise<SignatureFateAnswer>;
  now?: () => Date;
  log?: (event: PayoutTickEvent) => void;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

function toRow(r: PayoutExecutorDbRow): ClaimablePayoutRow {
  return {
    id: r.id,
    publisherId: r.publisherId,
    amountCents: r.amountCents,
    payoutMethod: r.payoutMethod,
    payoutAddress: r.payoutAddress,
    status: r.status,
    txSignature: r.txSignature,
    signedTxB64: r.signedTxB64,
    lastValidBlockHeight: r.lastValidBlockHeight,
    claimedAt: r.claimedAt,
    attemptCount: r.attemptCount,
    waitingReason: r.waitingReason,
    amountRaw: r.amountRaw ?? null,
  };
}

export function buildPayoutExecutorTickDeps(
  input: BuildPayoutExecutorDepsInput,
): PayoutExecutorTickDeps {
  const { prisma, connection } = input;
  const now = input.now ?? (() => new Date());
  if (!Number.isSafeInteger(input.platformMaxPerDayUsd) || input.platformMaxPerDayUsd < 0) {
    throw new Error("buildPayoutExecutorTickDeps: platformMaxPerDayUsd must be a whole number of dollars");
  }
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new Error("buildPayoutExecutorTickDeps: maxAttempts must be a whole number, at least 1");
  }
  const settleCreditsPayout = makeSettleCreditsPayout(prisma as unknown as PayoutCreditsDb);

  return {
    now,
    maxAttempts: input.maxAttempts,
    platformMaxPerDayCents: BigInt(input.platformMaxPerDayUsd) * 100n,
    log: input.log,

    loadClaimablePayouts: async ({ limit }) => {
      // Three reads, each oldest first and each up to the limit, so payouts
      // that are waiting (an empty paying wallet, the day's limit) can
      // never crowd out the ones already being sent, nor the ones nothing
      // is holding: a payout taken as credits needs no wallet at all and
      // must not sit behind a queue of wallet payouts that cannot go.
      const sending = await prisma.creatorPayout.findMany({
        where: { status: "processing" },
        orderBy: { requestedAt: "asc" },
        take: limit,
      });
      const ready = await prisma.creatorPayout.findMany({
        where: { status: "pending", waitingReason: null },
        orderBy: { requestedAt: "asc" },
        take: limit,
      });
      const waiting = await prisma.creatorPayout.findMany({
        where: { status: "pending", waitingReason: { not: null } },
        orderBy: { requestedAt: "asc" },
        take: limit,
      });
      return [...sending, ...ready, ...waiting].map(toRow);
    },

    // ---- credits ----

    claimCredits: async (row) => {
      const res = await prisma.creatorPayout.updateMany({
        where: { id: row.id, status: "pending", payoutMethod: "credits" },
        data: { status: "processing", waitingReason: null },
      });
      return res.count === 1;
    },

    settleCredits: (row) =>
      settleCreditsPayout({
        payoutId: row.id,
        publisherId: row.publisherId,
        amountCents: row.amountCents,
        now,
      }),

    // ---- a wallet payout, before it is signed ----

    checkCluster: input.checkCluster,

    quoteSolAmount: async (amountCents) => {
      try {
        return solPayoutAmount(await input.getSolQuote(), amountCents, input.solQuoteMarginBps());
      } catch (err) {
        return { ok: false, detail: `price read threw: ${(err as Error)?.message ?? String(err)}` };
      }
    },

    walletCentsClaimedSince: async (since) => {
      const sum = await prisma.creatorPayout.aggregate({
        where: {
          payoutMethod: { in: WALLET_METHODS },
          status: { in: ["processing", "completed"] },
          claimedAt: { gte: since },
        },
        _sum: { amountCents: true },
      });
      return sum._sum.amountCents ?? 0n;
    },

    checkFunds: async ({ method, recipient, amountRaw, held }) => {
      if (!input.payoutWallet) {
        return { covered: false, detail: "no paying wallet is configured" };
      }
      const funds = await readPayingWalletFunds(connection, {
        method,
        payer: input.payoutWallet.publicKey,
        recipient: new PublicKey(recipient),
        usdcMint: input.usdcMint,
      });
      return payingWalletCovers(method, amountRaw, funds, held);
    },

    prepare: async ({ method, recipient, amountRaw }) => {
      if (!input.payoutWallet) {
        throw new Error("no paying wallet is configured");
      }
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      return signPayoutTransfer(
        {
          method,
          payer: input.payoutWallet.publicKey,
          recipient: new PublicKey(recipient),
          amountRaw,
          usdcMint: input.usdcMint,
          blockhash,
          lastValidBlockHeight,
        },
        input.payoutWallet,
      );
    },

    // ---- the claim and the send ----

    claimWallet: async (row, claim) => {
      try {
        const res = await prisma.creatorPayout.updateMany({
          // Only a payout that is still pending, has no signature and has
          // had exactly the attempts it was read with. A cancel, another
          // worker's claim, or a claim-and-return in between all lose here.
          where: {
            id: row.id,
            status: "pending",
            txSignature: null,
            attemptCount: row.attemptCount,
          },
          data: {
            status: "processing",
            txSignature: claim.txSignature,
            signedTxB64: claim.signedTxB64,
            lastValidBlockHeight: claim.lastValidBlockHeight,
            amountRaw: claim.amountRaw.toString(),
            quotePriceMicroUsd: claim.quote?.priceMicroUsd ?? null,
            quotePublishTime: claim.quote?.publishTime ?? null,
            quoteSource: claim.quote?.source ?? null,
            claimedAt: claim.claimedAt,
            attemptCount: { increment: 1 },
            waitingReason: null,
          },
        });
        return res.count === 1;
      } catch (err) {
        // The unique index on tx_signature: this signature is already on a
        // row. Nothing was written, so nothing may be sent.
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    broadcast: async (signedTxB64) => {
      await connection.sendRawTransaction(Buffer.from(signedTxB64, "base64"), {
        skipPreflight: false,
        maxRetries: 3,
      });
    },

    // ---- a wallet payout that has a signature ----

    readFate: input.readSignatureFate,

    markCompleted: async (row) => {
      if (!row.txSignature) return false;
      const res = await prisma.creatorPayout.updateMany({
        where: { id: row.id, status: "processing", txSignature: row.txSignature },
        data: { status: "completed", processedAt: now(), waitingReason: null },
      });
      return res.count === 1;
    },

    returnToPending: async (row) => {
      const res = await prisma.creatorPayout.updateMany({
        where: { id: row.id, status: "processing", txSignature: row.txSignature },
        data: {
          status: "pending",
          txSignature: null,
          signedTxB64: null,
          lastValidBlockHeight: null,
          claimedAt: null,
          amountRaw: null,
          quotePriceMicroUsd: null,
          quotePublishTime: null,
          quoteSource: null,
          waitingReason: null,
          ...(row.txSignature ? { expiredSignatures: { push: row.txSignature } } : {}),
        },
      });
      return res.count === 1;
    },

    noteFirstSeen: async (row, at) => {
      if (!row.txSignature) return false;
      const res = await prisma.creatorPayout.updateMany({
        where: { id: row.id, status: "processing", txSignature: row.txSignature, claimedAt: null },
        data: { claimedAt: at },
      });
      return res.count === 1;
    },

    // ---- any payout ----

    failAndRestore: (row, failure) =>
      prisma.$transaction(async (tx) => {
        const failed = await tx.creatorPayout.updateMany({
          // From exactly the state the run judged: a payout that was
          // cancelled, claimed, completed or returned in between is left
          // alone.
          where: { id: row.id, status: row.status, txSignature: row.txSignature },
          data: {
            status: "failed",
            failureCode: failure.code,
            failureReason: failure.reason.slice(0, FAILURE_REASON_MAX_LENGTH),
            waitingReason: null,
            // A failed payout carries nothing that could be sent. Its last
            // signature joins the earlier ones, where it can be looked up.
            ...(row.txSignature
              ? { txSignature: null, signedTxB64: null, expiredSignatures: { push: row.txSignature } }
              : {}),
          },
        });
        // Only the call that failed the row gives the amount back: never
        // twice, and never for a payout that went somewhere else.
        if (failed.count !== 1) return false;
        const restored = await moveEarnings(tx, {
          orgId: row.publisherId,
          amountCents: row.amountCents,
          type: "payout_restored",
          referenceId: row.id,
          description: "Payout failed, amount returned",
        });
        // No profile to put the amount back on: throw, so the payout is not
        // marked failed without its amount given back.
        if (!restored.moved) {
          throw new Error(`payout ${row.id}: earnings could not be restored (${restored.reason})`);
        }
        return true;
      }),

    setWaiting: async (row, reason) => {
      const res = await prisma.creatorPayout.updateMany({
        where: { id: row.id, status: "pending" },
        data: { waitingReason: reason },
      });
      return res.count === 1;
    },
  };
}
