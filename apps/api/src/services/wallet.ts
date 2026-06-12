/**
 * Agent Wallet Service
 *
 * Manages agent wallets for autonomous payments.
 * Implements budget controls and allowlists.
 */

import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";
import * as crypto from "crypto";
import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { prisma } from "@wheelsai/db";

const logger = createLogger("wallet-service");

// ============================================
// Types
// ============================================

export interface WalletBalance {
  sol: number;
  usdc: number;
  nos: number;
}

export interface TransactionRequest {
  walletId: string;
  recipient: string;
  amount: number;
  token: "SOL" | "USDC" | "NOS";
  memo?: string;
}

export interface BudgetStatus {
  dailyLimitCents: number;
  dailySpentCents: number;
  dailyRemainingCents: number;
  perTxLimitCents: number;
  isWithinBudget: boolean;
}

// ============================================
// Encryption
// ============================================

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Get the key encryption key (KEK) for an organization
 */
function getKEK(orgId: string): Buffer {
  const masterKey = env.WALLET_MASTER_KEY || "development-master-key-do-not-use-in-production";
  return crypto
    .createHash("sha256")
    .update(`${masterKey}:${orgId}:wallet-kek`)
    .digest();
}

/**
 * Encrypt a private key
 */
function encryptKey(privateKey: Uint8Array, orgId: string): Buffer {
  const kek = getKEK(orgId);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, kek, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(privateKey)),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: [iv][authTag][encrypted]
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a private key
 */
function decryptKey(encryptedData: Buffer, orgId: string): Uint8Array {
  const kek = getKEK(orgId);

  const iv = encryptedData.subarray(0, IV_LENGTH);
  const authTag = encryptedData.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = encryptedData.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, kek, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return new Uint8Array(decrypted);
}

// ============================================
// Wallet Management
// ============================================

/**
 * Create a new agent wallet
 */
export async function createAgentWallet(
  orgId: string,
  deploymentId: string,
  options: {
    dailyLimitCents?: number;
    perTxLimitCents?: number;
    allowedDomains?: string[];
  } = {}
): Promise<{ walletId: string; address: string }> {
  // Generate new Solana keypair
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();

  // Encrypt the private key
  const encryptedKey = encryptKey(keypair.secretKey, orgId);

  // Store in database
  const wallet = await prisma.agentWallet.create({
    data: {
      orgId,
      deploymentId,
      walletAddress: address,
      encryptedKey,
      dailyLimitCents: options.dailyLimitCents ? BigInt(options.dailyLimitCents) : null,
      perTxLimitCents: options.perTxLimitCents ? BigInt(options.perTxLimitCents) : null,
      allowedDomains: options.allowedDomains || [],
    },
  });

  logger.info({ walletId: wallet.id, address, orgId }, "Agent wallet created");

  return {
    walletId: wallet.id,
    address,
  };
}

/**
 * Get wallet balance
 */
export async function getWalletBalance(walletId: string): Promise<WalletBalance> {
  const wallet = await prisma.agentWallet.findUnique({
    where: { id: walletId },
  });

  if (!wallet) {
    throw new Error("Wallet not found");
  }

  const connection = getConnection();
  const publicKey = new PublicKey(wallet.walletAddress);

  // Get SOL balance
  const solBalance = await connection.getBalance(publicKey);
  const sol = solBalance / LAMPORTS_PER_SOL;

  // Get USDC balance
  let usdc = 0;
  try {
    const usdcMint = getUsdcMint();
    const usdcAccount = await getAssociatedTokenAddress(usdcMint, publicKey);
    const accountInfo = await getAccount(connection, usdcAccount);
    usdc = Number(accountInfo.amount) / 1_000_000;
  } catch {
    // No USDC account
  }

  // Get NOS balance
  let nos = 0;
  try {
    const nosMint = getNosMint();
    const nosAccount = await getAssociatedTokenAddress(nosMint, publicKey);
    const accountInfo = await getAccount(connection, nosAccount);
    nos = Number(accountInfo.amount) / 1_000_000;
  } catch {
    // No NOS account
  }

  return { sol, usdc, nos };
}

/**
 * Get budget status for a wallet
 */
export async function getBudgetStatus(walletId: string): Promise<BudgetStatus> {
  const wallet = await prisma.agentWallet.findUnique({
    where: { id: walletId },
  });

  if (!wallet) {
    throw new Error("Wallet not found");
  }

  // Get today's spending
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const todayTransactions = await prisma.agentTransaction.findMany({
    where: {
      walletId,
      direction: "out",
      status: { in: ["pending", "confirmed"] },
      createdAt: { gte: todayStart },
    },
  });

  // Calculate total spent (convert lamports to cents approximation)
  // This is simplified - in production, use actual token prices
  const dailySpentCents = todayTransactions.reduce((total, tx) => {
    const lamports = Number(tx.amountLamports);
    // Rough conversion: 1 SOL ≈ $150, so 1 lamport ≈ $0.00000015
    const usd = (lamports / LAMPORTS_PER_SOL) * 150;
    return total + Math.round(usd * 100);
  }, 0);

  const dailyLimitCents = wallet.dailyLimitCents ? Number(wallet.dailyLimitCents) : Infinity;
  const perTxLimitCents = wallet.perTxLimitCents ? Number(wallet.perTxLimitCents) : Infinity;

  return {
    dailyLimitCents,
    dailySpentCents,
    dailyRemainingCents: Math.max(0, dailyLimitCents - dailySpentCents),
    perTxLimitCents,
    isWithinBudget: dailySpentCents < dailyLimitCents,
  };
}

/**
 * Check if a transaction is allowed
 */
export async function checkTransactionAllowed(
  walletId: string,
  recipient: string,
  amountCents: number
): Promise<{ allowed: boolean; reason?: string }> {
  const wallet = await prisma.agentWallet.findUnique({
    where: { id: walletId },
  });

  if (!wallet) {
    return { allowed: false, reason: "Wallet not found" };
  }

  if (!wallet.isActive) {
    return { allowed: false, reason: "Wallet is frozen" };
  }

  // Check per-transaction limit
  if (wallet.perTxLimitCents && amountCents > Number(wallet.perTxLimitCents)) {
    return {
      allowed: false,
      reason: `Amount exceeds per-transaction limit of ${Number(wallet.perTxLimitCents) / 100} USD`,
    };
  }

  // Check daily limit
  const budget = await getBudgetStatus(walletId);
  if (!budget.isWithinBudget) {
    return { allowed: false, reason: "Daily budget exceeded" };
  }

  if (amountCents > budget.dailyRemainingCents) {
    return {
      allowed: false,
      reason: `Amount exceeds remaining daily budget of ${budget.dailyRemainingCents / 100} USD`,
    };
  }

  // Check allowlist (if configured)
  if (wallet.allowedDomains.length > 0) {
    const isAllowed = wallet.allowedDomains.some((domain) => {
      // Domain can be an exact address or a pattern
      if (domain.startsWith("*")) {
        // Wildcard pattern (e.g., *.domain.com)
        return true; // Simplified - in production, implement proper matching
      }
      return domain === recipient;
    });

    if (!isAllowed) {
      return { allowed: false, reason: "Recipient not in allowlist" };
    }
  }

  return { allowed: true };
}

/**
 * Execute a transaction from an agent wallet
 */
export async function executeTransaction(
  request: TransactionRequest
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  const { walletId, recipient, amount, token } = request;

  // Get wallet
  const wallet = await prisma.agentWallet.findUnique({
    where: { id: walletId },
    include: { org: true },
  });

  if (!wallet) {
    return { success: false, error: "Wallet not found" };
  }

  // Convert amount to cents for budget checking
  // This is simplified - in production, use actual token prices
  let amountCents: number;
  switch (token) {
    case "SOL":
      amountCents = Math.round(amount * 150 * 100); // $150/SOL
      break;
    case "USDC":
      amountCents = Math.round(amount * 100);
      break;
    case "NOS":
      amountCents = Math.round(amount * 0.1 * 100); // $0.10/NOS
      break;
  }

  // Check if transaction is allowed
  const check = await checkTransactionAllowed(walletId, recipient, amountCents);
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  // Decrypt wallet key
  const secretKey = decryptKey(wallet.encryptedKey, wallet.orgId);
  const keypair = Keypair.fromSecretKey(secretKey);

  // Create transaction record
  const txRecord = await prisma.agentTransaction.create({
    data: {
      walletId,
      direction: "out",
      amountLamports: BigInt(
        token === "SOL" ? amount * LAMPORTS_PER_SOL : amount * 1_000_000
      ),
      token,
      counterparty: recipient,
      status: "pending",
    },
  });

  try {
    const connection = getConnection();
    const recipientKey = new PublicKey(recipient);

    let transaction: Transaction;

    if (token === "SOL") {
      // SOL transfer
      transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: recipientKey,
          lamports: Math.round(amount * LAMPORTS_PER_SOL),
        })
      );
    } else {
      // SPL token transfer
      const mint = token === "USDC" ? getUsdcMint() : getNosMint();
      const sourceAccount = await getAssociatedTokenAddress(mint, keypair.publicKey);
      const destAccount = await getAssociatedTokenAddress(mint, recipientKey);

      transaction = new Transaction().add(
        createTransferInstruction(
          sourceAccount,
          destAccount,
          keypair.publicKey,
          Math.round(amount * 1_000_000)
        )
      );
    }

    // Sign and send
    const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);

    // Update transaction record
    await prisma.agentTransaction.update({
      where: { id: txRecord.id },
      data: {
        txSignature: signature,
        status: "confirmed",
      },
    });

    logger.info(
      { walletId, recipient, amount, token, signature },
      "Agent wallet transaction executed"
    );

    return { success: true, txSignature: signature };
  } catch (err: any) {
    // Update transaction record with error
    await prisma.agentTransaction.update({
      where: { id: txRecord.id },
      data: {
        status: "failed",
      },
    });

    logger.error({ err, walletId, recipient, amount, token }, "Transaction failed");

    return { success: false, error: err.message };
  }
}

/**
 * Freeze/unfreeze a wallet
 */
export async function setWalletActive(
  walletId: string,
  isActive: boolean
): Promise<void> {
  await prisma.agentWallet.update({
    where: { id: walletId },
    data: { isActive },
  });

  logger.info({ walletId, isActive }, `Wallet ${isActive ? "unfrozen" : "frozen"}`);
}

/**
 * Update wallet budget controls
 */
export async function updateWalletBudget(
  walletId: string,
  options: {
    dailyLimitCents?: number;
    perTxLimitCents?: number;
    allowedDomains?: string[];
  }
): Promise<void> {
  await prisma.agentWallet.update({
    where: { id: walletId },
    data: {
      dailyLimitCents: options.dailyLimitCents !== undefined
        ? BigInt(options.dailyLimitCents)
        : undefined,
      perTxLimitCents: options.perTxLimitCents !== undefined
        ? BigInt(options.perTxLimitCents)
        : undefined,
      allowedDomains: options.allowedDomains,
    },
  });

  logger.info({ walletId, options }, "Wallet budget updated");
}

// ============================================
// Solana Helpers
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

function getUsdcMint(): PublicKey {
  return env.SOLANA_NETWORK === "mainnet-beta"
    ? new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
    : new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
}

function getNosMint(): PublicKey {
  return new PublicKey("nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7");
}
