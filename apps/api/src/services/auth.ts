import argon2 from "argon2";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { Redis } from "ioredis";
import {
  createAttemptLimiter,
  LOGIN_POLICY,
  TWO_FACTOR_POLICY,
} from "../lib/attemptLimiter.js";

import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";
import { readSpentToday, type ApiKeySpendDayDb } from "./apiKeySpend.js";
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

// lazyConnect keeps imports (and unit tests) from opening a socket, but with
// the offline queue disabled the FIRST command after boot failed with
// "Stream isn't writeable": the first wallet login after every deploy
// errored and the first blocklist check failed open. Connect on first use.
let connecting: Promise<void> | null = null;
async function redis(): Promise<Redis> {
  if (redisClient.status === "wait") {
    connecting ??= redisClient.connect().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  if (connecting && redisClient.status !== "ready") await connecting;
  return redisClient;
}

export type NoncePurpose = "sign-in" | "link-wallet";

const NONCE_STATEMENT: Record<NoncePurpose, string> = {
  "sign-in": "Sign in to WheelsAI.",
  "link-wallet": "Link this wallet to your WheelsAI account.",
};

function siteOrigin(): URL {
  return new URL(env.PUBLIC_WEB_URL ?? env.CORS_ORIGIN);
}

function nonceKey(message: string): string {
  return `${NONCE_PREFIX}${createHash("sha256").update(message).digest("hex")}`;
}

/**
 * Issue a one-time message for a wallet to sign, in the Sign-In With
 * Solana layout: it names the site, the purpose, the chain and an expiry,
 * so a phishing page cannot pass it off as its own.
 *
 * Nonces are stored under a hash of the message, not the wallet address:
 * keyed by address, anyone could request a nonce for a victim's wallet and
 * overwrite the one they were about to sign (a login denial of service).
 */
export async function generateNonce(
  walletAddress: string,
  purpose: NoncePurpose = "sign-in",
): Promise<string> {
  const origin = siteOrigin();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_SECONDS * 1000);
  const message = [
    `${origin.host} wants you to sign in with your Solana account:`,
    walletAddress,
    "",
    `${NONCE_STATEMENT[purpose]} This request does not send a transaction or cost any fees.`,
    "",
    `URI: ${origin.origin}`,
    "Version: 1",
    `Chain ID: ${env.SOLANA_NETWORK}`,
    `Nonce: ${nanoid(32)}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
  ].join("\n");
  try {
    await (await redis()).set(nonceKey(message), `${purpose}:${walletAddress}`, "EX", NONCE_TTL_SECONDS);
  } catch (err) {
    logger.error({ err, walletAddress }, "Failed to store nonce in Redis");
    throw new Error("Nonce storage unavailable, please try again");
  }
  return message;
}

/**
 * Atomically claim a nonce (GETDEL): true only if this server issued this
 * exact message, for this wallet and purpose, and nobody claimed it yet.
 */
export async function claimNonce(
  walletAddress: string,
  message: string,
  purpose: NoncePurpose = "sign-in",
): Promise<boolean> {
  try {
    const stored = await (await redis()).getdel(nonceKey(message));
    return stored === `${purpose}:${walletAddress}`;
  } catch (err) {
    logger.error({ err, walletAddress }, "Failed to claim nonce from Redis");
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

    // Start at zero. The $5 signup bonus is granted once, when the owner
    // verifies an email (services/emailTokens.ts); granting it here made
    // free credits farmable with throwaway, unverified accounts.
    await tx.creditBalance.create({
      data: {
        orgId: org.id,
        balanceCents: 0,
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

/**
 * Load a user with memberships by id — used by the 2FA login completion
 * (B5), which knows only the userId the validated challenge carries.
 */
export async function findUserById(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
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
  scopes: string[] = [],
  // A key granted jobs:hire carries the per-job cap and the day's; one
  // granted agents:use carries the per-use cap and the day's. The caller has
  // validated them (config/apiKeyScopes.ts checkKeyGrant).
  caps: {
    maxJobPriceCents?: number | null;
    maxUsePriceCents?: number | null;
    dailySpendCapCents?: number | null;
  } = {}
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
      ...(caps.maxJobPriceCents != null && { maxJobPriceCents: BigInt(caps.maxJobPriceCents) }),
      ...(caps.maxUsePriceCents != null && { maxUsePriceCents: BigInt(caps.maxUsePriceCents) }),
      ...(caps.dailySpendCapCents != null && { dailySpendCapCents: BigInt(caps.dailySpendCapCents) }),
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

/** The key columns a list is answered from. Never the key or its hash. */
const API_KEY_LIST_COLUMNS = {
  id: true,
  keyPrefix: true,
  name: true,
  scopes: true,
  maxJobPriceCents: true,
  maxUsePriceCents: true,
  dailySpendCapCents: true,
  lastUsedAt: true,
  expiresAt: true,
  createdAt: true,
} as const;

interface ApiKeyListRow {
  id: string;
  keyPrefix: string;
  name: string | null;
  scopes: string[];
  maxJobPriceCents: bigint | null;
  maxUsePriceCents: bigint | null;
  dailySpendCapCents: bigint | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

/** What listApiKeys reads. Prisma's client satisfies it; a test passes a stand-in. */
export interface ApiKeyListDb extends ApiKeySpendDayDb {
  apiKey: {
    findMany(args: {
      where: { orgId: string };
      select: typeof API_KEY_LIST_COLUMNS;
      orderBy: { createdAt: "desc" };
    }): Promise<ApiKeyListRow[]>;
  };
}

/**
 * The organization's keys, newest first, each with what it has spent in the
 * UTC day (`spentTodayCents`; 0 for a key that has spent nothing today, and
 * for a key with no caps, which cannot spend). Two queries however many keys
 * there are: the keys, then the day's spend windows of all of them.
 *
 * The day's spend is a number beside the keys and never a reason to lose
 * them: creating a key answers from this list after the key is written, and
 * its secret is shown that one time only. When the windows cannot be read the
 * keys are answered with `spentTodayCents` null, which means not known, and
 * never a 0 that would say nothing was spent.
 */
export async function listApiKeys(
  orgId: string,
  deps: { db?: ApiKeyListDb; now?: Date } = {},
) {
  const db = deps.db ?? (prisma as unknown as ApiKeyListDb);
  const keys = await db.apiKey.findMany({
    where: { orgId },
    select: API_KEY_LIST_COLUMNS,
    orderBy: { createdAt: "desc" },
  });
  let spentToday: Map<string, bigint> | null = null;
  try {
    spentToday = await readSpentToday(
      db,
      keys.map((key) => key.id),
      deps.now ?? new Date(),
    );
  } catch (err) {
    logger.warn({ err, orgId }, "What the keys spent today could not be read; the keys are listed without it");
  }
  // Cents fit a number (the caps are bounded), and a bigint does not serialize.
  return keys.map((key) => ({
    ...key,
    maxJobPriceCents: key.maxJobPriceCents === null ? null : Number(key.maxJobPriceCents),
    maxUsePriceCents: key.maxUsePriceCents === null ? null : Number(key.maxUsePriceCents),
    dailySpendCapCents: key.dailySpendCapCents === null ? null : Number(key.dailySpendCapCents),
    spentTodayCents: spentToday === null ? null : Number(spentToday.get(key.id) ?? 0n),
  }));
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
    await (await redis()).set(
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
    const result = await (await redis()).get(`${JWT_BLOCKLIST_PREFIX}${jti}`);
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

// ============================================
// Per-subject authentication failure caps
// ============================================

const attemptStore = {
  incr: async (key: string) => (await redis()).incr(key),
  expire: async (key: string, seconds: number) => (await redis()).expire(key, seconds),
  get: async (key: string) => (await redis()).get(key),
  del: async (key: string) => (await redis()).del(key),
};

const reportLimiterError = (err: unknown) =>
  logger.error({ err }, "Auth attempt limiter unavailable; per-IP limits still apply");

export const loginAttempts = createAttemptLimiter(attemptStore, LOGIN_POLICY, reportLimiterError);
export const twoFactorAttempts = createAttemptLimiter(
  attemptStore,
  TWO_FACTOR_POLICY,
  reportLimiterError,
);
