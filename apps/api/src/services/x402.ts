/**
 * X-402 Payment Protocol Service
 *
 * Implements the X-402 payment protocol for pay-per-request AI inference.
 * Uses Solana blockchain for payment verification and settlement.
 */

import { randomUUID } from "crypto";

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";

import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";

const logger = createLogger("x402");

// ============================================
// Constants
// ============================================

// USDC token addresses
const USDC_MINT = {
  mainnet: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  devnet: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
};

// NOS token address
const NOS_MINT = {
  mainnet: new PublicKey("nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7"),
  devnet: new PublicKey("nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7"),
};

// WheelsAI treasury address
const TREASURY_ADDRESS = new PublicKey(env.TREASURY_WALLET_ADDRESS);

// ============================================
// Types
// ============================================

export interface PaymentRequirement {
  scheme: "exact" | "max";
  network: "solana:mainnet" | "solana:devnet";
  asset: "USDC" | "SOL" | "NOS";
  amount: string; // Raw amount as string
  amountUsd: number;
  payTo: string;
  memo?: string;
  validUntil?: number; // Unix timestamp
}

export interface PaymentHeader {
  signature: string; // Base64 encoded signed transaction
  network: string;
}

export interface PaymentVerification {
  isValid: boolean;
  payer: string;
  amount: string;
  asset: string;
  txSignature?: string;
  error?: string;
}

export interface PriceQuote {
  inputTokens: number;
  outputTokens: number;
  modelTier: "small" | "medium" | "large";
  priceUsd: number;
  priceUsdc: string; // Raw USDC amount (6 decimals)
  priceSol: string; // Raw SOL amount (9 decimals)
  priceNos: string; // Raw NOS amount
  validUntil: number;
}

// ============================================
// Pricing
// ============================================

// Prices per 1K tokens in USD
const PRICING: Record<PriceQuote["modelTier"], { input: number; output: number }> = {
  small: { input: 0.00015, output: 0.0006 },
  medium: { input: 0.0003, output: 0.0012 },
  large: { input: 0.0009, output: 0.0036 },
};

// Minimum charge in USD
const MIN_CHARGE_USD = 0.0001;

/**
 * Calculate price for a request
 */
export function calculatePrice(
  inputTokens: number,
  outputTokens: number,
  modelTier: "small" | "medium" | "large" = "small"
): PriceQuote {
  const pricing = PRICING[modelTier];

  const inputCost = (inputTokens / 1000) * pricing.input;
  const outputCost = (outputTokens / 1000) * pricing.output;
  const totalUsd = Math.max(inputCost + outputCost, MIN_CHARGE_USD);

  // Convert to token amounts
  // USDC: 6 decimals
  const priceUsdc = Math.ceil(totalUsd * 1_000_000).toString();

  // SOL: 9 decimals — use cached prices (sync) for hot path
  const prices = cachedPrices ?? { sol: 150, usdc: 1, nos: 0.1 };
  const priceSol = Math.ceil((totalUsd / prices.sol) * LAMPORTS_PER_SOL).toString();

  // NOS: 6 decimals
  const priceNos = Math.ceil((totalUsd / prices.nos) * 1_000_000).toString();

  return {
    inputTokens,
    outputTokens,
    modelTier,
    priceUsd: totalUsd,
    priceUsdc,
    priceSol,
    priceNos,
    validUntil: Math.floor(Date.now() / 1000) + 300, // 5 minutes
  };
}

/**
 * Estimate price for a request (before execution)
 */
export function estimatePrice(
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
  modelTier: "small" | "medium" | "large" = "small"
): PriceQuote {
  // Add 20% buffer to estimates
  return calculatePrice(
    Math.ceil(estimatedInputTokens * 1.2),
    Math.ceil(estimatedOutputTokens * 1.2),
    modelTier
  );
}

// ============================================
// Payment Requirement Generation
// ============================================

/**
 * Generate X-Payment-Required header content
 */
export function generatePaymentRequirement(
  quote: PriceQuote,
  asset: "USDC" | "SOL" | "NOS" = env.X402_DEFAULT_ASSET,
  memo?: string
): PaymentRequirement {
  const network =
    env.SOLANA_NETWORK === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";

  let amount: string;
  switch (asset) {
    case "USDC":
      amount = quote.priceUsdc;
      break;
    case "SOL":
      amount = quote.priceSol;
      break;
    case "NOS":
      amount = quote.priceNos;
      break;
  }

  return {
    scheme: "exact",
    network,
    asset,
    amount,
    amountUsd: quote.priceUsd,
    payTo: TREASURY_ADDRESS.toBase58(),
    memo,
    validUntil: quote.validUntil,
  };
}

/**
 * Format payment requirement as HTTP header
 */
export function formatPaymentHeader(requirement: PaymentRequirement): string {
  return JSON.stringify(requirement);
}

/**
 * Check if a requirement has expired
 */
export function isRequirementExpired(requirement: PaymentRequirement): boolean {
  if (!requirement.validUntil) return false;
  return requirement.validUntil < Math.floor(Date.now() / 1000);
}

/**
 * Create a correlation ID for a payment request.
 */
export function createPaymentRequestId(): string {
  return `x402_${randomUUID()}`;
}

// ============================================
// Payment Verification
// ============================================

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

    const { signature, network } = parsed as Record<string, unknown>;
    if (typeof signature !== "string" || typeof network !== "string") {
      return null;
    }

    return { signature, network };
  } catch {
    return null;
  }
}

/**
 * Verify a signed payment transaction
 */
export async function verifyPayment(
  paymentHeader: PaymentHeader,
  expectedRequirement: PaymentRequirement
): Promise<PaymentVerification> {
  try {
    if (paymentHeader.network !== expectedRequirement.network) {
      return {
        isValid: false,
        payer: "",
        amount: "0",
        asset: expectedRequirement.asset,
        error: "Payment network does not match requirement",
      };
    }

    if (isRequirementExpired(expectedRequirement)) {
      return {
        isValid: false,
        payer: "",
        amount: "0",
        asset: expectedRequirement.asset,
        error: "Payment requirement has expired",
      };
    }

    // Decode the signed transaction
    const txBuffer = Buffer.from(paymentHeader.signature, "base64");
    const transaction = Transaction.from(txBuffer);

    // Verify the transaction is properly signed
    if (!transaction.signature) {
      return {
        isValid: false,
        payer: "",
        amount: "0",
        asset: expectedRequirement.asset,
        error: "Transaction is not signed",
      };
    }

    if (!transaction.verifySignatures()) {
      return {
        isValid: false,
        payer: "",
        amount: "0",
        asset: expectedRequirement.asset,
        error: "Transaction signature verification failed",
      };
    }

    if (!transaction.recentBlockhash) {
      return {
        isValid: false,
        payer: "",
        amount: "0",
        asset: expectedRequirement.asset,
        error: "Transaction missing recent blockhash",
      };
    }

    // Get payer from fee payer
    const payer = transaction.feePayer?.toBase58() || "";
    if (!payer) {
      return {
        isValid: false,
        payer: "",
        amount: "0",
        asset: expectedRequirement.asset,
        error: "No fee payer in transaction",
      };
    }

    const txSignature = getTransactionSignature(transaction);
    if (!txSignature) {
      return {
        isValid: false,
        payer,
        amount: "0",
        asset: expectedRequirement.asset,
        error: "Unable to resolve transaction signature",
      };
    }

    // Verify the payment instruction
    const verified = await verifyPaymentInstruction(transaction, expectedRequirement);

    if (!verified.isValid) {
      return {
        isValid: false,
        payer,
        amount: "0",
        asset: expectedRequirement.asset,
        error: verified.error,
      };
    }

    // In production, optionally submit transaction to chain
    if (env.X402_SUBMIT_TRANSACTIONS) {
      const connection = getConnection();
      try {
        const submittedSignature = await connection.sendRawTransaction(txBuffer, {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        // Wait for confirmation
        await connection.confirmTransaction(submittedSignature, "confirmed");

        return {
          isValid: true,
          payer,
          amount: expectedRequirement.amount,
          asset: expectedRequirement.asset,
          txSignature: submittedSignature,
        };
      } catch (err: any) {
        logger.error({ err, payer }, "Failed to submit X-402 payment transaction");
        return {
          isValid: false,
          payer,
          amount: "0",
          asset: expectedRequirement.asset,
          error: `Transaction submission failed: ${err.message}`,
        };
      }
    }

    // Verification-only mode
    return {
      isValid: true,
      payer,
      amount: expectedRequirement.amount,
      asset: expectedRequirement.asset,
      txSignature,
    };
  } catch (err: any) {
    logger.error({ err }, "Payment verification error");
    return {
      isValid: false,
      payer: "",
      amount: "0",
      asset: expectedRequirement.asset,
      error: `Verification error: ${err.message}`,
    };
  }
}

function getTransactionSignature(transaction: Transaction): string | null {
  if (transaction.signature) {
    return bs58.encode(transaction.signature);
  }

  const signedEntry = transaction.signatures.find((entry) => entry.signature);
  if (!signedEntry?.signature) {
    return null;
  }

  return bs58.encode(signedEntry.signature);
}

/**
 * Verify the payment instruction in a transaction
 */
async function verifyPaymentInstruction(
  transaction: Transaction,
  requirement: PaymentRequirement
): Promise<{ isValid: boolean; error?: string }> {
  // Find the transfer instruction
  for (const instruction of transaction.instructions) {
    // Check for SOL transfer
    if (
      requirement.asset === "SOL" &&
      instruction.programId.equals(SystemProgram.programId)
    ) {
      // Decode SystemProgram transfer
      const data = instruction.data;
      if (data.length >= 12) {
        // Transfer instruction: [4 bytes type][8 bytes lamports]
        const instructionType = data.readUInt32LE(0);
        if (instructionType === 2 && instruction.keys.length >= 2) {
          const lamports = data.readBigUInt64LE(4);
          const recipient = instruction.keys[1]?.pubkey;

          if (
            recipient &&
            recipient.toBase58() === requirement.payTo &&
            lamports >= BigInt(requirement.amount)
          ) {
            return { isValid: true };
          }
        }
      }
    }

    // Check for SPL token transfer (USDC, NOS)
    if (
      requirement.asset !== "SOL" &&
      instruction.programId.equals(TOKEN_PROGRAM_ID)
    ) {
      const data = instruction.data;
      if (data.length < 9 || instruction.keys.length < 2) {
        continue;
      }

      const tokenInstructionType = data[0];
      const isTransfer = tokenInstructionType === 3;
      const isTransferChecked = tokenInstructionType === 12 && data.length >= 10;
      if (!isTransfer && !isTransferChecked) {
        continue;
      }

      const amount = data.readBigUInt64LE(1);
      const destination = instruction.keys[1]?.pubkey;
      if (!destination) {
        continue;
      }

      // Verify destination is treasury's token account
      const mint = requirement.asset === "USDC" ? USDC_MINT : NOS_MINT;
      const network = env.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : "devnet";
      const expectedTokenAccount = await getAssociatedTokenAddress(
        mint[network],
        TREASURY_ADDRESS
      );

      if (
        destination.equals(expectedTokenAccount) &&
        amount >= BigInt(requirement.amount)
      ) {
        return { isValid: true };
      }
    }
  }

  return {
    isValid: false,
    error: "No valid payment instruction found in transaction",
  };
}

// ============================================
// Solana Connection
// ============================================

let connectionInstance: Connection | null = null;

function getConnection(): Connection {
  if (!connectionInstance) {
    const endpoint =
      env.SOLANA_NETWORK === "mainnet-beta"
        ? env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
        : "https://api.devnet.solana.com";

    connectionInstance = new Connection(endpoint, "confirmed");
  }
  return connectionInstance;
}

// ============================================
// Helper Functions
// ============================================

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
      message: "This request requires payment via X-402 protocol",
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
// Price Oracle (Placeholder)
// ============================================

interface TokenPrices {
  sol: number;
  usdc: number;
  nos: number;
}

let cachedPrices: TokenPrices | null = null;
let pricesCacheTime = 0;

/**
 * Get current token prices in USD
 */
export async function getTokenPrices(): Promise<TokenPrices> {
  const now = Date.now();

  // Cache prices for 1 minute
  if (cachedPrices && now - pricesCacheTime < 60_000) {
    return cachedPrices;
  }

  // Fetch live prices from CoinGecko (free, no API key needed)
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,nosana&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      cachedPrices = {
        sol: data.solana?.usd ?? 150,
        usdc: 1,
        nos: data.nosana?.usd ?? 0.1,
      };
      pricesCacheTime = now;
      return cachedPrices;
    }
  } catch {
    // CoinGecko unavailable — fall through to defaults
  }

  // Fallback prices if oracle is unreachable
  cachedPrices = {
    sol: 150,
    usdc: 1,
    nos: 0.1,
  };
  pricesCacheTime = now;

  return cachedPrices;
}

/**
 * Convert USD amount to token amount
 */
export async function usdToToken(
  usdAmount: number,
  token: "SOL" | "USDC" | "NOS"
): Promise<string> {
  const prices = await getTokenPrices();

  switch (token) {
    case "SOL":
      return Math.ceil((usdAmount / prices.sol) * LAMPORTS_PER_SOL).toString();
    case "USDC":
      return Math.ceil(usdAmount * 1_000_000).toString(); // 6 decimals
    case "NOS":
      return Math.ceil((usdAmount / prices.nos) * 1_000_000).toString();
    default:
      throw new Error(`Unknown token: ${token}`);
  }
}
