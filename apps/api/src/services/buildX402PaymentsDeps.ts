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
 */

import { prisma } from "@wheelsai/db";

import { env } from "../config/env.js";
import { ensureSolanaCluster } from "../lib/solana.js";
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
  type X402FateReading,
  type X402PaymentEvent,
  type X402PaymentsApi,
  type X402PaymentsDeps,
  type X402Settings,
} from "./x402Payments.js";
import { microUsdToUsd, x402PriceFor } from "./x402Price.js";
import { readX402Quote, signX402Quote } from "./x402Quote.js";
import { returnX402Payment, type X402RefundDb } from "./x402Refund.js";
import type { X402Asset } from "./x402Types.js";

const logger = createLogger("x402-payments");

/** How often a request asks what became of its payment. */
export const X402_FATE_POLL_MS = 1_000;
/** A fate read that takes longer than this is "unknown". */
export const X402_FATE_READ_TIMEOUT_MS = 10_000;

/** What a failed-on-chain payment's row says. Our own words. */
export const X402_FAILED_ON_CHAIN_REASON = "The payment failed on the chain. Nothing was taken.";

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
        const existing = await prisma.x402Payment
          .findUnique({ where: { txSignature: data.txSignature }, select: { id: true } })
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
