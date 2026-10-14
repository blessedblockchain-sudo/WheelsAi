/**
 * Binds the life of an x402 payment (services/x402Payments.ts) to Prisma,
 * the shared connection and the settings. The rules live in the core; this
 * file is the reads and writes it asks for.
 *
 *   insertPayment      the claim. A unique violation on the signature is
 *                      read OUTSIDE any transaction and answered as
 *                      "duplicate_signature": nothing may be sent for it.
 *   markVerified       "submitted" -> "verified"
 *   markFailedOnChain  "submitted" -> "failed"
 *   markServed         servedAt, on a "verified" row neither served nor
 *                      returned
 *   refund             services/x402Refund.ts, in one transaction
 *
 * Every change names the status the row must be in and checks the count:
 * a lost race writes nothing.
 *
 * The fate of a signature is read in its BLOCKHASH form: a payer's
 * transaction carries a blockhash and no last valid block height. A read
 * that does not come back in time is "unknown", which decides nothing.
 *
 * The x402 door of a listing has bindings of its own (buildX402DoorPaymentsDeps,
 * x402DoorChainReads, recordX402SaleInTransaction, below). Nothing in
 * production calls them yet; the deployment's bindings above them are as
 * they were.
 */

import { prisma } from "@wheelsai/db";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

import { env } from "../config/env.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { createLogger } from "../utils/logger.js";
import { readSignatureFate } from "./buildSignatureFateDeps.js";
import { getSolQuote, getSolQuoteMarginBps } from "./buildSolPriceDeps.js";
import type { SignatureFateAnswer, SignatureFateInput } from "./signatureFate.js";
import { solMicroUsdRate } from "./solPrice.js";
import { broadcastX402Transaction, x402NetworkFor } from "./x402.js";
import { decodeX402Payment, x402UsdcTokenAccount } from "./x402Decode.js";
import {
  bindX402Payments,
  type X402DoorChainReads,
  type X402DoorFailure,
  type X402DoorPaymentEvent,
  type X402DoorPaymentsDeps,
  type X402FateReading,
  type X402PaymentEvent,
  type X402PaymentsApi,
  type X402PaymentsDeps,
  type X402Settings,
} from "./x402Payments.js";
import { microUsdToUsd, x402PriceFor } from "./x402Price.js";
import { readX402Quote, signX402Quote } from "./x402Quote.js";
import { returnX402Payment, type X402RefundDb } from "./x402Refund.js";
import { recordX402Sale, type X402SaleInput, type X402SaleResult, type X402SaleTx } from "./x402Sale.js";
import type { X402Asset } from "./x402Types.js";

const logger = createLogger("x402-payments");

/** How often a request asks what became of its payment. */
export const X402_FATE_POLL_MS = 1_000;
/** A fate read that takes longer than this is "unknown". */
export const X402_FATE_READ_TIMEOUT_MS = 10_000;

/** What a failed-on-chain payment's row says. Our own words. */
export const X402_FAILED_ON_CHAIN_REASON = "The payment failed on the chain. Nothing was taken.";

/**
 * What a payment that can never land says on its row. Our own words. Also
 * exported by services/x402Settlement.ts, where it was first written: the
 * door's request writes it too, and the settlement worker imports this file.
 */
export const X402_NEVER_LANDED_REASON = "The payment never reached the chain. Nothing was taken.";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "P2002";
}

let tokenAccountFor: { key: string; address: string } | null = null;

/** The treasury wallet's USDC account, worked out once per wallet and mint. */
function usdcTokenAccount(payTo: string, usdcMint: string): string {
  const key = `${payTo}|${usdcMint}`;
  if (tokenAccountFor?.key !== key) {
    tokenAccountFor = { key, address: x402UsdcTokenAccount(payTo, usdcMint) };
  }
  return tokenAccountFor.address;
}

/** The settings as config/env.ts holds them, read at the moment of the call. */
export function x402SettingsFromEnv(): X402Settings {
  const usdcMint = usdcMintForNetwork(env.SOLANA_NETWORK).toBase58();
  const payTo = env.TREASURY_WALLET_ADDRESS;
  // NOS has no live price and is refused at start with x402 on; anything
  // that is not SOL is asked for in USDC.
  const defaultAsset: X402Asset = env.X402_DEFAULT_ASSET === "SOL" ? "SOL" : "USDC";
  return {
    network: x402NetworkFor(env.SOLANA_NETWORK),
    defaultAsset,
    payTo,
    usdcMint,
    payToTokenAccount: usdcTokenAccount(payTo, usdcMint),
    quoteTtlSeconds: env.X402_QUOTE_TTL_SECONDS,
    confirmWaitMs: env.X402_CONFIRM_WAIT_MS,
    pollIntervalMs: X402_FATE_POLL_MS,
    submitTransactions: env.X402_SUBMIT_TRANSACTIONS,
  };
}

/**
 * The fate of a payer's transaction, by its blockhash, as the core and the
 * settlement worker take it. Never throws; a read that hangs is "unknown".
 */
export async function readX402Fate(
  input: { signature: string; blockhash: string | null },
  read: (input: SignatureFateInput) => Promise<SignatureFateAnswer> = readSignatureFate,
  timeoutMs: number = X402_FATE_READ_TIMEOUT_MS,
): Promise<X402FateReading> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    const answer = await Promise.race([
      read({ signature: input.signature, lastValidBlockHeight: null, blockhash: input.blockhash }),
      late,
    ]);
    if (!answer) return { fate: "unknown" };
    return { fate: answer.fate, confirmationStatus: answer.detail.confirmationStatus };
  } catch {
    return { fate: "unknown" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logEvent(event: X402PaymentEvent): void {
  switch (event.event) {
    case "send_error":
      // The node's words go to the log and nowhere else.
      logger.warn(
        { err: event.error, paymentId: event.paymentId, signature: event.signature },
        "x402 payment: the send reported an error; the chain decides",
      );
      return;
    case "refused":
      logger.info(
        { requestId: event.requestId, reason: event.reason, detail: event.detail },
        "x402 payment refused; nothing was broadcast",
      );
      return;
    case "not_confirmed":
    case "lost_race":
      logger.warn(event, "x402 payment not confirmed in time; left for the settlement worker");
      return;
    default:
      logger.info(event, `x402 payment ${event.event}`);
  }
}

export function buildX402PaymentsDeps(): X402PaymentsDeps {
  return {
    settings: x402SettingsFromEnv,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

    priceFor: x402PriceFor,
    microUsdToUsd,
    solRate: async () => {
      try {
        const price = await getSolQuote();
        if (!price.ok) return null;
        const rate = solMicroUsdRate(price.quote, "in", getSolQuoteMarginBps());
        return rate.ok ? rate.microUsdPerSol : null;
      } catch {
        return null;
      }
    },
    signQuote: (payload) =>
      signX402Quote(
        { ...payload, asset: "SOL" },
        { secret: env.JWT_SECRET, ttlSeconds: env.X402_QUOTE_TTL_SECONDS },
      ),
    readQuote: (token, scope) => {
      const read = readX402Quote(token, { secret: env.JWT_SECRET, ...scope });
      return read.ok ? read.quote.solMicroUsdPerSol : null;
    },
    decode: decodeX402Payment,

    clusterOk: async () => {
      try {
        return (await ensureSolanaCluster()).ok;
      } catch {
        return false;
      }
    },
    broadcast: broadcastX402Transaction,
    readFate: (input) => readX402Fate(input),

    findPaymentBySignature: (signature) =>
      prisma.x402Payment.findUnique({ where: { txSignature: signature }, select: { id: true } }),

    insertPayment: async (data) => {
      try {
        const created = await prisma.x402Payment.create({ data, select: { id: true } });
        return { ok: true, id: created.id };
      } catch (err) {
        // The unique index on tx_signature: another request claimed this
        // signature first. Nothing was written, so nothing may be sent.
        if (!isUniqueViolation(err)) throw err;
        const signature = data.txSignature;
        const existing =
          signature === null
            ? null
            : await prisma.x402Payment
                .findUnique({ where: { txSignature: signature }, select: { id: true } })
                .catch(() => null);
        return { ok: false, reason: "duplicate_signature", id: existing?.id ?? null };
      }
    },

    markVerified: async (paymentId, at) => {
      const res = await prisma.x402Payment.updateMany({
        where: { id: paymentId, status: "submitted" },
        data: { status: "verified", verifiedAt: at, failureReason: null },
      });
      return res.count === 1;
    },

    markFailedOnChain: async (paymentId) => {
      const res = await prisma.x402Payment.updateMany({
        where: { id: paymentId, status: "submitted" },
        data: { status: "failed", failureReason: X402_FAILED_ON_CHAIN_REASON },
      });
      return res.count === 1;
    },

    markServed: async (paymentId, at) => {
      const res = await prisma.x402Payment.updateMany({
        where: { id: paymentId, status: "verified", servedAt: null, refundedAt: null },
        data: { servedAt: at },
      });
      return res.count === 1;
    },

    refund: (input) => returnX402Payment(prisma as unknown as X402RefundDb, input),

    log: logEvent,
  };
}

let bound: X402PaymentsApi | null = null;

/** The life of a payment bound to Prisma, the connection and the settings. */
export function getX402Payments(): X402PaymentsApi {
  if (!bound) bound = bindX402Payments(buildX402PaymentsDeps());
  return bound;
}

// ============================================
// The door of a listing
// ============================================

/**
 * Which unique index a door payment's claim ran into, read from the
 * failure: "duplicate" for the message hash (this payment was presented
 * before), "wallet_busy" for the one-open index (a payment of this wallet is
 * held or submitted), "unknown" for a unique violation that does not say,
 * null for anything else (thrown on). Read on a real database (Prisma 5.22
 * on Postgres, 2026-10-14): meta.target is ["message_hash"] for the hash and
 * ["payer_address"] for the partial index of one open payment per wallet.
 */
export function doorClaimConflict(err: unknown): "duplicate" | "wallet_busy" | "unknown" | null {
  if (!isUniqueViolation(err)) return null;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const text = Array.isArray(target) ? target.map(String).join(",") : String(target ?? "");
  if (/message_hash|messageHash/.test(text)) return "duplicate";
  if (/one_open_door_payment|payer_address|payerAddress/.test(text)) return "wallet_busy";
  return "unknown";
}

/** Door rows only: no door function can touch a deployment's payment. */
const DOOR_ROW = { listingId: { not: null } } as const;

/** "held" -> "failed": the request (or the worker) ended it unsent. */
export async function markDoorHeldFailed(paymentId: string, reason: X402DoorFailure): Promise<boolean> {
  const res = await prisma.x402Payment.updateMany({
    where: { id: paymentId, status: "held", ...DOOR_ROW },
    data: { status: "failed", failureReason: reason },
  });
  return res.count === 1;
}

/** "submitted" -> "unserved": it landed and its answer was not released. */
export async function markDoorUnserved(paymentId: string): Promise<boolean> {
  const res = await prisma.x402Payment.updateMany({
    where: { id: paymentId, status: "submitted", ...DOOR_ROW },
    data: { status: "unserved" },
  });
  return res.count === 1;
}

function logDoorEvent(event: X402DoorPaymentEvent): void {
  switch (event.event) {
    case "send_error":
      // The node's words go to the log and nowhere else.
      logger.warn(
        { err: event.error, paymentId: event.paymentId, signature: event.signature },
        "x402 door payment: the send reported an error; the chain decides",
      );
      return;
    case "unconfirmed":
      logger.warn(event, "x402 door payment not confirmed in time; left submitted for the settlement worker");
      return;
    case "unserved":
    case "not_claimed":
      logger.error(event, `x402 door payment ${event.event}`);
      return;
    default:
      logger.info(event, `x402 door payment ${event.event}`);
  }
}

/** The door's reads and writes of its payment rows, bound to Prisma and the shared connection. */
export function buildX402DoorPaymentsDeps(): X402DoorPaymentsDeps {
  return {
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: X402_FATE_POLL_MS,

    findByMessageHash: (messageHash) =>
      prisma.x402Payment.findUnique({ where: { messageHash }, select: { id: true, status: true } }),

    insertHeld: async (row) => {
      try {
        const created = await prisma.x402Payment.create({ data: row, select: { id: true } });
        return { ok: true, id: created.id };
      } catch (err) {
        // Read OUTSIDE any transaction. Neither index raises a count, and
        // nothing was written.
        const conflict = doorClaimConflict(err);
        if (conflict === null) throw err;
        if (conflict !== "unknown") return { ok: false, reason: conflict };
        // The failure did not name its index: a row with this message is the
        // only way it can be the hash's.
        const same = await prisma.x402Payment
          .findUnique({ where: { messageHash: row.messageHash }, select: { id: true } })
          .catch(() => null);
        return { ok: false, reason: same ? "duplicate" : "wallet_busy" };
      }
    },

    markHeldFailed: markDoorHeldFailed,

    markSubmitted: async (paymentId, sent) => {
      try {
        const res = await prisma.x402Payment.updateMany({
          // The row's own message hash: bytes are recorded only on the row
          // claimed for the message they sign.
          where: { id: paymentId, status: "held", messageHash: sent.messageHash, ...DOOR_ROW },
          data: {
            status: "submitted",
            txSignature: sent.txSignature,
            signedTxB64: sent.signedTxB64,
            submittedAt: sent.submittedAt,
          },
        });
        return res.count === 1 ? "submitted" : "not_held";
      } catch (err) {
        // The only unique this write can meet is tx_signature: the same
        // message is already on another row. Nothing was written.
        if (isUniqueViolation(err)) return "duplicate_signature";
        throw err;
      }
    },

    broadcast: broadcastX402Transaction,
    readFate: (input) => readX402Fate(input),

    markSentFailed: async (paymentId, why) => {
      const res = await prisma.x402Payment.updateMany({
        where: { id: paymentId, status: "submitted", ...DOOR_ROW },
        data: {
          status: "failed",
          failureReason: why === "failed_on_chain" ? X402_FAILED_ON_CHAIN_REASON : X402_NEVER_LANDED_REASON,
        },
      });
      return res.count === 1;
    },

    markUnserved: markDoorUnserved,

    log: logDoorEvent,
  };
}

/** What the door's chain reads need of a connection. web3.js's Connection has it. */
export interface X402DoorConnection {
  getMultipleAccountsInfo(keys: PublicKey[], commitment?: "confirmed"): Promise<Array<{ lamports: number } | null>>;
  isBlockhashValid(blockhash: string, config?: { commitment?: "confirmed" }): Promise<{ value: boolean }>;
  simulateTransaction(
    transaction: VersionedTransaction,
    config: { sigVerify: false; replaceRecentBlockhash: false; commitment: "confirmed" },
  ): Promise<{ value: { err: unknown } }>;
}

class DoorReadTimeout extends Error {
  constructor() {
    super("x402 door: a read of the chain did not come back in time");
    this.name = "DoorReadTimeout";
  }
}

/** A read that takes longer than X402_FATE_READ_TIMEOUT_MS throws: it decides nothing. */
async function inTime<T>(read: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DoorReadTimeout()), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The door's reads of the chain (step 8 and step 13), on the shared
 * connection unless one is handed in. Each throws when it cannot be made in
 * time; a simulation's failure is read from value.err and never thrown.
 */
export function x402DoorChainReads(
  connection: () => X402DoorConnection = getSolanaConnection,
  timeoutMs: number = X402_FATE_READ_TIMEOUT_MS,
): X402DoorChainReads {
  return {
    accounts: async ({ feePayer, source, destination }) => {
      const keys = [feePayer, source, destination].map((key) => new PublicKey(key));
      const infos = await inTime(connection().getMultipleAccountsInfo(keys, "confirmed"), timeoutMs);
      if (!Array.isArray(infos) || infos.length !== keys.length) {
        throw new Error("x402 door: the chain answered a read of accounts with the wrong count");
      }
      const [payerInfo, sourceInfo, destinationInfo] = infos;
      return {
        feePayerLamports: payerInfo ? BigInt(payerInfo.lamports) : null,
        sourceExists: Boolean(sourceInfo),
        destinationExists: Boolean(destinationInfo),
      };
    },

    blockhashValid: async (blockhash) => {
      const answer = await inTime(connection().isBlockhashValid(blockhash, { commitment: "confirmed" }), timeoutMs);
      return answer.value === true;
    },

    simulate: async (transactionB64) => {
      // The deserialized VersionedTransaction, never a legacy Transaction,
      // which web3.js would recompile on a fresh blockhash.
      const transaction = VersionedTransaction.deserialize(Buffer.from(transactionB64, "base64"));
      const answer = await inTime(
        connection().simulateTransaction(transaction, {
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: "confirmed",
        }),
        timeoutMs,
      );
      const err = answer.value.err;
      return err === null || err === undefined ? { ok: true } : { ok: false, err };
    },
  };
}

/** The sale of a confirmed door payment, in one transaction (services/x402Sale.ts). */
export function recordX402SaleInTransaction(input: X402SaleInput): Promise<X402SaleResult> {
  return prisma.$transaction((tx) => recordX402Sale(tx as unknown as X402SaleTx, input));
}
