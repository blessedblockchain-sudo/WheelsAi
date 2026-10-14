/**
 * x402: what goes over the wire, and the one call that sends a payment.
 *
 * Paying for one request with an on-chain transfer (the HTTP 402 flow).
 * This file holds the shape of the "payment required" answer, the reading
 * of the `X-Payment` header, the sentences a payer reads, and the
 * broadcast of a payer's signed transaction.
 *
 * It prices nothing and reads no transaction:
 *   the price and the SOL rate lock   services/x402Price.ts, x402Quote.ts
 *   the reading of a signed payment   services/x402Decode.ts
 *   what happens to a payment         services/x402Payments.ts
 *   a payment returned as credits     services/x402Refund.ts
 */

import { randomUUID } from "crypto";

import { getSolanaConnection } from "../lib/solana.js";
import { USDC_MINT } from "../lib/solanaAssets.js";
import type { X402Asset, X402RefusalReason } from "./x402Types.js";

// The USDC mints live in lib/solanaAssets.ts. Re-exported here under the
// same name for the modules that import it from this file.
export { USDC_MINT };

// ============================================
// The wire
// ============================================

export type X402Network = "solana:mainnet" | "solana:devnet";

/** The `payment` object of a 402 answer, and the `X-Payment-Required` header. */
export interface PaymentRequirement {
  scheme: "exact";
  network: X402Network;
  asset: X402Asset;
  /** Base units: USDC base units, or lamports. */
  amount: string;
  /** The same in dollars, to show. Never an input to an amount. */
  amountUsd: number;
  /** The treasury wallet. SOL is sent to it. */
  payTo: string;
  /** USDC only: the token account the transfer must go to. */
  payToTokenAccount: string | null;
  /** USDC only: the mint. */
  mint: string | null;
  memo: string;
  /** Unix seconds. */
  validUntil: number;
  /** SOL only: the rate lock the paid retry hands back. */
  quote: string | null;
}

/** The `X-Payment` header of a paid retry. */
export interface PaymentHeader {
  /** The signed transaction, base64. */
  signature: string;
  network: string;
  /** The rate lock of the challenge. Needed for SOL, ignored for USDC. */
  quote: string | null;
}

/** The network name x402 uses for a configured chain. */
export function x402NetworkFor(network: "devnet" | "mainnet-beta"): X402Network {
  return network === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";
}

/**
 * Format payment requirement as HTTP header
 */
export function formatPaymentHeader(requirement: PaymentRequirement): string {
  return JSON.stringify(requirement);
}

/**
 * Create a correlation ID for a payment request.
 */
export function createPaymentRequestId(): string {
  return `x402_${randomUUID()}`;
}

/**
 * Parse X-Payment header from client
 */
export function parsePaymentHeader(header: string): PaymentHeader | null {
  try {
    const parsed: unknown = JSON.parse(header);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("signature" in parsed) ||
      !("network" in parsed)
    ) {
      return null;
    }

    const { signature, network, quote } = parsed as Record<string, unknown>;
    if (typeof signature !== "string" || typeof network !== "string") {
      return null;
    }

    return {
      signature,
      network,
      quote: typeof quote === "string" && quote.length > 0 ? quote : null,
    };
  } catch {
    return null;
  }
}

/**
 * Create a 402 response with payment requirement
 */
export function create402Response(requirement: PaymentRequirement): {
  status: 402;
  headers: Record<string, string>;
  body: { error: string; message: string; payment: PaymentRequirement };
} {
  return {
    status: 402,
    headers: {
      "X-Payment-Required": formatPaymentHeader(requirement),
      "Access-Control-Expose-Headers": "X-Payment-Required",
    },
    body: {
      error: "Payment Required",
      // Its own wire, not the published x402 format: the public words do not call it x402.
      message:
        "This request needs a payment from a Solana wallet. The X-Payment-Required header says how much and where to send it.",
      payment: requirement,
    },
  };
}

/**
 * Check if a request includes X-402 payment.
 */
export function hasPaymentHeader(
  headers: Record<string, string | string[] | undefined>
): boolean {
  return Boolean(headers["x-payment"] || headers["X-Payment"]);
}

/**
 * Get payment header from request headers.
 */
export function getPaymentFromHeaders(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const headerValue = headers["x-payment"] ?? headers["X-Payment"];
  if (Array.isArray(headerValue)) {
    return headerValue[0] ?? null;
  }
  return headerValue ?? null;
}

// ============================================
// What a payer reads
// ============================================

/**
 * Why a presented payment was not taken, in the API's own words. Nothing
 * from a node, from the database or from a thrown error is ever added.
 */
export const X402_REFUSAL_MESSAGES: Readonly<Record<X402RefusalReason, string>> = {
  quote_expired:
    "The price for this request has expired. Send the request again to get a new one.",
  payment_invalid:
    "That payment does not match this request. Check the address, the asset and the amount, and send the request again.",
  payment_failed_on_chain:
    "Your payment failed on the chain and nothing was taken. Send the request again.",
  payment_not_confirmed:
    "Your payment was not confirmed in time. If it lands, it is returned to your credit balance. Send the request again.",
};

/** A paid request that failed after its payment landed. */
export const X402_RETURNED_MESSAGE =
  "Your payment for this request was returned to your credit balance. Amounts under a cent add up and appear once they reach a cent.";

/** The `payment` field added to the error of a paid request that failed. */
export interface X402ReturnedNotice {
  status: "returned";
  amountUsd: number;
  message: string;
}

/** Micro-dollars as dollars, to show. A float: never an input to an amount. */
export function x402ReturnedNotice(refundMicroUsd: bigint): X402ReturnedNotice {
  return {
    status: "returned",
    amountUsd: Number(refundMicroUsd) / 1_000_000,
    message: X402_RETURNED_MESSAGE,
  };
}

// ============================================
// The chain
// ============================================

/**
 * Send a payer's signed transaction, exactly as it was handed over. Called
 * only AFTER the payment's row is written. It may throw, and a throw
 * decides nothing: only the signature's fate says what became of it.
 */
export async function broadcastX402Transaction(signedTxB64: string): Promise<void> {
  await getSolanaConnection().sendRawTransaction(Buffer.from(signedTxB64, "base64"), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
}
