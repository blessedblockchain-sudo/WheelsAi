import argon2 from "argon2";
import { nanoid } from "nanoid";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("auth-service");

// ============================================
// Password Hashing
// ============================================

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
  });
}

export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch (error) {
    logger.error({ error }, "Password verification failed");
    return false;
  }
}

// ============================================
// Nonce Management
// ============================================

const nonceStore = new Map<string, { nonce: string; expiresAt: number }>();

export function generateNonce(walletAddress: string): string {
  const nonce = `WheelsAI authentication request.\n\nWallet: ${walletAddress}\nNonce: ${nanoid(32)}\nTimestamp: ${Date.now()}`;

  // Store nonce with 5 minute expiry
  nonceStore.set(walletAddress, {
    nonce,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  // Cleanup expired nonces periodically
  cleanupExpiredNonces();

  return nonce;
}

export function getNonce(walletAddress: string): string | null {
  const stored = nonceStore.get(walletAddress);
  if (!stored) return null;
  if (Date.now() > stored.expiresAt) {
    nonceStore.delete(walletAddress);
    return null;
  }
  return stored.nonce;
}

export function consumeNonce(walletAddress: string): boolean {
  const exists = nonceStore.has(walletAddress);
  nonceStore.delete(walletAddress);
  return exists;
}

function cleanupExpiredNonces(): void {
  const now = Date.now();
  for (const [key, value] of nonceStore.entries()) {
    if (now > value.expiresAt) {
      nonceStore.delete(key);
    }
  }
}

// ============================================
// Solana Signature Verification
// ============================================

export function verifySolanaSignature(
  message: string,
  signature: string,
  walletAddress: string
): boolean {
  try {
    const publicKey = new PublicKey(walletAddress);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);

    return nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKey.toBytes()
    );
  } catch (error) {
    logger.error({ error, walletAddress }, "Signature verification failed");
    return false;
  }
}

// ============================================
// User Management
// ============================================

export interface CreateUserInput {
  email?: string;
  password?: string;
  walletAddress?: string;
}

export async function createUser(input: CreateUserInput) {
  const { email, password, walletAddress } = input;

  if (!email && !walletAddress) {
    throw new Error("Either email or wallet address is required");
  }

  const passwordHash = password ? await hashPassword(password) : null;

  // Create user and default organization in a transaction
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        walletAddress,
      },
    });

    // Create default organization for the user
    const org = await tx.organization.create({
      data: {
        name: email ? email.split("@")[0] : `wallet-${walletAddress?.slice(0, 8)}`,
        ownerId: user.id,
      },
    });

    // Add user as owner member
    await tx.orgMember.create({
      data: {
        orgId: org.id,
        userId: user.id,
        role: "owner",
      },
    });

    // Initialize credit balance
    await tx.creditBalance.create({
      data: {
        orgId: org.id,
        balanceCents: 500, // $5.00 signup bonus
      },
    });

    // Record bonus transaction
    await tx.creditTransaction.create({
      data: {
        orgId: org.id,
        amountCents: 500,
        type: "bonus",
        description: "Signup bonus",
        balanceAfter: 500,
      },
    });

    return { user, org };
  });

  logger.info(
    { userId: result.user.id, orgId: result.org.id },
    "User created with default organization"
  );

  return result;
}

export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({
    where: { email },
    include: {
      memberships: {
        include: {
          org: true,
        },
      },
    },
  });
}

export async function findUserByWallet(walletAddress: string) {
  return prisma.user.findUnique({
    where: { walletAddress },
    include: {
      memberships: {
        include: {
          org: true,
        },
      },
    },
  });
}

export async function findOrCreateUserByWallet(walletAddress: string) {
  let user = await findUserByWallet(walletAddress);

  if (!user) {
    const result = await createUser({ walletAddress });
    user = await findUserByWallet(walletAddress);
  }

  return user;
}

// ============================================
// API Key Management
// ============================================

export async function generateApiKey(
  orgId: string,
  name?: string,
  scopes: string[] = []
): Promise<{ key: string; keyId: string }> {
  // Generate a secure random key
  const keyBody = nanoid(32);
  const key = `wheels_live_${keyBody}`;
  const keyPrefix = key.slice(0, 16);

  // Hash the key for storage
  const keyHash = await hashApiKey(key);

  const apiKey = await prisma.apiKey.create({
    data: {
      orgId,
      keyHash,
      keyPrefix,
      name,
      scopes,
    },
  });

  logger.info({ orgId, keyId: apiKey.id }, "API key created");

  // Return the key only once - it cannot be retrieved later
  return { key, keyId: apiKey.id };
}

async function hashApiKey(key: string): Promise<string> {
  // Use a simple hash for API keys (faster than argon2)
  const crypto = await import("crypto");
  return crypto.createHash("sha256").update(key).digest("hex");
}

export async function validateApiKey(key: string) {
  const keyHash = await hashApiKey(key);

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: {
      org: {
        include: {
          creditBalance: true,
        },
      },
    },
  });

  if (!apiKey) {
    return null;
  }

  // Check if expired
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return null;
  }

  // Update last used timestamp
  await prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  });

  return apiKey;
}

export async function revokeApiKey(keyId: string, orgId: string) {
  const apiKey = await prisma.apiKey.findFirst({
    where: { id: keyId, orgId },
  });

  if (!apiKey) {
    throw new Error("API key not found");
  }

  await prisma.apiKey.delete({
    where: { id: keyId },
  });

  logger.info({ orgId, keyId }, "API key revoked");
}

export async function listApiKeys(orgId: string) {
  return prisma.apiKey.findMany({
    where: { orgId },
    select: {
      id: true,
      keyPrefix: true,
      name: true,
      scopes: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

// ============================================
// JWT Payload Types
// ============================================

export interface JwtPayload {
  userId: string;
  orgId: string;
  email?: string;
  walletAddress?: string;
}

export interface ApiKeyPayload {
  type: "api_key";
  keyId: string;
  orgId: string;
  scopes: string[];
}
