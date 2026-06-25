import argon2 from "argon2";
import { nanoid } from "nanoid";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { Redis } from "ioredis";

import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";

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
// Nonce Management (Redis-backed)
// ============================================

const NONCE_PREFIX = "nonce:";
const NONCE_TTL_SECONDS = 300; // 5 minutes; Redis handles expiry automatically

const redisClient = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
});

redisClient.on("error", (err) => {
  logger.error({ err }, "Redis client error");
});

export async function generateNonce(walletAddress: string): Promise<string> {
  const nonce = `WheelsAI authentication request.\n\nWallet: ${walletAddress}\nNonce: ${nanoid(32)}\nTimestamp: ${Date.now()}`;
  try {
    await redisClient.set(`${NONCE_PREFIX}${walletAddress}`, nonce, "EX", NONCE_TTL_SECONDS);
  } catch (err) {
    logger.error({ err, walletAddress }, "Failed to store nonce in Redis");
    throw new Error("Nonce storage unavailable, please try again");
  }
  return nonce;
}

export async function getNonce(walletAddress: string): Promise<string | null> {
  try {
    return await redisClient.get(`${NONCE_PREFIX}${walletAddress}`);
  } catch (err) {
    logger.error({ err, walletAddress }, "Failed to retrieve nonce from Redis");
    return null;
  }
}

export async function consumeNonce(walletAddress: string): Promise<boolean> {
  try {
    const deleted = await redisClient.del(`${NONCE_PREFIX}${walletAddress}`);
    return deleted > 0;
  } catch (err) {
    logger.error({ err, walletAddress }, "Failed to delete nonce from Redis");
    return false;
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
    const emailPrefix = email?.split("@")[0] ?? "user";
    const org = await tx.organization.create({
      data: {
        name: email ? emailPrefix : `wallet-${walletAddress?.slice(0, 8)}`,
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
    await createUser({ walletAddress });
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
  // HMAC-SHA256 with server secret prevents offline brute-force from DB leaks
  const crypto = await import("crypto");
  const hmacSecret = env.ENCRYPTION_KEY ?? env.JWT_SECRET;
  return crypto.createHmac("sha256", hmacSecret).update(key).digest("hex");
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
  // Org role for the selected membership ('owner' | 'admin' | 'member').
  // Optional so already-issued tokens stay decodable; an absent role fails
  // closed on role-gated routes (F4).
  role?: string;
  jti?: string;
}

// ============================================
// JWT Blocklist (for logout invalidation)
// ============================================

const JWT_BLOCKLIST_PREFIX = "jwt:blocked:";

export async function blockJwt(jti: string, expiresInSeconds: number): Promise<void> {
  try {
    await redisClient.set(
      `${JWT_BLOCKLIST_PREFIX}${jti}`,
      "1",
      "EX",
      expiresInSeconds
    );
  } catch (err) {
    logger.error({ err, jti }, "Failed to blocklist JWT");
  }
}

export async function isJwtBlocked(jti: string): Promise<boolean> {
  try {
    const result = await redisClient.get(`${JWT_BLOCKLIST_PREFIX}${jti}`);
    return result !== null;
  } catch (err) {
    logger.error({ err, jti }, "Failed to check JWT blocklist");
    return false; // fail open to avoid locking out all users on Redis failure
  }
}

export interface ApiKeyPayload {
  type: "api_key";
  keyId: string;
  orgId: string;
  scopes: string[];
}
