import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import {
  verifyPassword,
  createUser,
  findUserByEmail,
  findUserById,
  findOrCreateUserByWallet,
  generateNonce,
  claimNonce,
  verifySolanaSignature,
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  type JwtPayload,
} from "../services/auth.js";
import {
  requireAuth,
  requireJwtAuth,
  generateTokens,
  setAuthCookie,
  clearAuthCookie,
} from "../middleware/auth.js";
import { blockJwt, loginAttempts, twoFactorAttempts } from "../services/auth.js";
import { sendVerificationEmail } from "./emailAuth.js";
import { createChallenge, validateChallenge } from "../services/twoFactor.js";
import { createLogger } from "../utils/logger.js";
import { checkKeyGrant, isSpendScope } from "../config/apiKeyScopes.js";
import { prisma } from "../lib/prisma.js";

const logger = createLogger("auth-routes");

// ============================================
// Schemas
// ============================================

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const walletNonceSchema = z.object({
  walletAddress: z.string().min(32).max(44),
});

const walletVerifySchema = z.object({
  walletAddress: z.string().min(32).max(44),
  signature: z.string(),
  nonce: z.string(),
});

const createApiKeySchema = z.object({
  name: z.string().max(100).optional(),
  scopes: z.array(z.string().max(64)).max(16).default([]),
  // maxJobPriceCents is required with jobs:hire and maxUsePriceCents with
  // agents:use, each with dailySpendCapCents; refused otherwise (checkKeyGrant).
  maxJobPriceCents: z.number().optional(),
  maxUsePriceCents: z.number().optional(),
  dailySpendCapCents: z.number().optional(),
});

// ============================================
// Routes
// ============================================

export const authRoutes: FastifyPluginAsync = async (app) => {
  // ==========================================
  // Email/Password Authentication
  // ==========================================

  /**
   * Register new user with email/password
   */
  app.post("/register", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { tags: ["Auth"], description: "Register a new user", body: { type: "object", properties: { email: { type: "string" }, password: { type: "string" } }, required: ["email", "password"] } } }, async (request, reply) => {
    const body = registerSchema.parse(request.body);

    // Check if email already exists
    const existingUser = await findUserByEmail(body.email);
    if (existingUser) {
      return reply.status(409).send({
        error: "Conflict",
        message: "Email already registered",
      });
    }

    // Create user with organization
    const { user, org } = await createUser({
      email: body.email,
      password: body.password,
    });

    // Generate JWT
    const payload: JwtPayload = {
      userId: user.id,
      orgId: org.id,
      email: user.email ?? undefined,
      role: "owner", // a new user owns their freshly-created org
    };

    const { accessToken } = generateTokens(app, payload);

    // Set cookie
    setAuthCookie(reply, accessToken);

    logger.info({ userId: user.id }, "User registered via email");

    // The $5 signup bonus arrives when this link is used.
    const emailVerificationSent = user.email
      ? await sendVerificationEmail({ id: user.id, email: user.email })
      : false;

    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      },
      organization: {
        id: org.id,
        name: org.name,
      },
      token: accessToken,
      emailVerificationSent,
    };
  });

  /**
   * Login with email/password
   */
  app.post("/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { tags: ["Auth"], description: "Login with email and password", body: { type: "object", properties: { email: { type: "string" }, password: { type: "string" } }, required: ["email", "password"] } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);

    // Per-account cap on top of the per-IP limit: guesses spread across
    // many IPs still stop at LOGIN_POLICY.maxFailures per window.
    if (await loginAttempts.isLocked(body.email)) {
      return reply.status(429).send({
        error: "too_many_attempts",
        message: "Too many failed sign-in attempts. Try again in 15 minutes.",
      });
    }

    // Find user
    const user = await findUserByEmail(body.email);
    if (!user || !user.passwordHash) {
      // Counted for unknown emails too, so lockout timing can't reveal
      // which addresses have accounts.
      await loginAttempts.recordFailure(body.email);
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }

    // Verify password
    const valid = await verifyPassword(user.passwordHash, body.password);
    if (!valid) {
      await loginAttempts.recordFailure(body.email);
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }
    await loginAttempts.clear(body.email);

    // Get primary organization
    const primaryMembership = user.memberships.find((m) => m.role === "owner");
    if (!primaryMembership) {
      return reply.status(500).send({
        error: "Internal Error",
        message: "User has no organization",
      });
    }

    // 2FA gate (B5). Until now the second factor was collected in
    // settings and then never asked for — a user who enabled it was no
    // safer than one who hadn't. createChallenge returns null when the
    // user has no 2FA, so the common path is unchanged.
    const challenge = await createChallenge(user.id);
    if (challenge) {
      logger.info({ userId: user.id }, "Login awaiting 2FA challenge");
      // NO cookie, NO token: the session is issued only by
      // POST /login/2fa after the code checks out.
      return {
        requires2FA: true,
        challengeToken: challenge.challengeToken,
        expiresAt: challenge.expiresAt,
      };
    }

    // Generate JWT
    const payload: JwtPayload = {
      userId: user.id,
      orgId: primaryMembership.org.id,
      email: user.email ?? undefined,
      role: primaryMembership.role,
    };

    const { accessToken } = generateTokens(app, payload);

    // Set cookie
    setAuthCookie(reply, accessToken);

    logger.info({ userId: user.id }, "User logged in via email");

    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      },
      organization: {
        id: primaryMembership.org.id,
        name: primaryMembership.org.name,
      },
      token: accessToken,
    };
  });

  /**
   * Complete a 2FA-gated login (B5).
   *
   * This is the ONLY place a challenge turns into a session: it
   * validates the challenge + code (validateChallenge marks the
   * challenge used, so a code can't be replayed), then does the same
   * membership lookup → generateTokens → setAuthCookie the password
   * path does. Rate-limited like /login: the challenge token is the
   * bearer of a half-authenticated session and brute-forcing six
   * digits must not be cheap.
   */
  app.post(
    "/login/2fa",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["Auth"],
        description: "Complete a login that requires two-factor authentication",
        body: {
          type: "object",
          properties: {
            challengeToken: { type: "string" },
            token: { type: "string" },
          },
          required: ["challengeToken", "token"],
        },
      },
    },
    async (request, reply) => {
      const body = z
        .object({
          challengeToken: z.string().min(1),
          token: z.string().min(1),
        })
        .parse(request.body);

      // A challenge allows TWO_FACTOR_POLICY.maxFailures wrong codes in
      // total, however many IPs they come from; then the user signs in again.
      if (await twoFactorAttempts.isLocked(body.challengeToken)) {
        return reply.status(429).send({
          error: "too_many_attempts",
          message: "Too many incorrect codes. Please sign in again.",
        });
      }

      let userId: string;
      try {
        const result = await validateChallenge(body.challengeToken, body.token);
        userId = result.userId;
        await twoFactorAttempts.clear(body.challengeToken);
      } catch (err) {
        await twoFactorAttempts.recordFailure(body.challengeToken);
        // Invalid / expired / already-used challenge, or a wrong code.
        // One shape for all of them — don't tell an attacker which.
        logger.warn(
          { err: (err as Error).message },
          "2FA challenge validation failed",
        );
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid or expired verification code",
        });
      }

      const user = await findUserById(userId);
      if (!user) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid or expired verification code",
        });
      }

      const primaryMembership = user.memberships.find((m) => m.role === "owner");
      if (!primaryMembership) {
        return reply.status(500).send({
          error: "Internal Error",
          message: "User has no organization",
        });
      }

      const payload: JwtPayload = {
        userId: user.id,
        orgId: primaryMembership.org.id,
        email: user.email ?? undefined,
        walletAddress: user.walletAddress ?? undefined,
        role: primaryMembership.role,
      };

      const { accessToken } = generateTokens(app, payload);
      setAuthCookie(reply, accessToken);

      logger.info({ userId: user.id }, "User completed 2FA login");

      return {
        user: {
          id: user.id,
          email: user.email,
          createdAt: user.createdAt,
        },
        organization: {
          id: primaryMembership.org.id,
          name: primaryMembership.org.name,
        },
        token: accessToken,
      };
    },
  );

  // ==========================================
  // Wallet Authentication
  // ==========================================

  /**
   * Get nonce for wallet signature
   */
  app.post("/wallet/nonce", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { tags: ["Auth"], description: "Get wallet nonce for signing" } }, async (request, _reply) => {
    const { walletAddress } = walletNonceSchema.parse(request.body);

    const nonce = await generateNonce(walletAddress);

    return { nonce, walletAddress };
  });

  /**
   * Verify wallet signature and authenticate
   */
  app.post("/wallet/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, schema: { tags: ["Auth"], description: "Verify wallet signature" } }, async (request, reply) => {
    const { walletAddress, signature, nonce } = walletVerifySchema.parse(
      request.body
    );

    // Verify the signature over the exact message the client returned...
    const isValid = verifySolanaSignature(nonce, signature, walletAddress);
    if (!isValid) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid signature",
      });
    }

    // ...then atomically claim it: only a message this server issued, for
    // this wallet, for sign-in, and never used before.
    if (!(await claimNonce(walletAddress, nonce, "sign-in"))) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid or expired nonce",
      });
    }

    // Find or create user
    const user = await findOrCreateUserByWallet(walletAddress);
    if (!user) {
      return reply.status(500).send({
        error: "Internal Error",
        message: "Failed to create user",
      });
    }

    // Get primary organization
    const primaryMembership = user.memberships.find((m) => m.role === "owner");
    if (!primaryMembership) {
      return reply.status(500).send({
        error: "Internal Error",
        message: "User has no organization",
      });
    }

    // Same 2FA gate as the password path (B5) — a wallet signature is
    // one factor, and enabling 2FA must cover every door.
    const walletChallenge = await createChallenge(user.id);
    if (walletChallenge) {
      logger.info({ userId: user.id }, "Wallet login awaiting 2FA challenge");
      return {
        requires2FA: true,
        challengeToken: walletChallenge.challengeToken,
        expiresAt: walletChallenge.expiresAt,
      };
    }

    // Generate JWT
    const payload: JwtPayload = {
      userId: user.id,
      orgId: primaryMembership.org.id,
      walletAddress: user.walletAddress ?? undefined,
      role: primaryMembership.role,
    };

    const { accessToken } = generateTokens(app, payload);

    // Set cookie
    setAuthCookie(reply, accessToken);

    logger.info({ userId: user.id, walletAddress }, "User authenticated via wallet");

    return {
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        createdAt: user.createdAt,
      },
      organization: {
        id: primaryMembership.org.id,
        name: primaryMembership.org.name,
      },
      token: accessToken,
    };
  });

  // ==========================================
  // Session Management
  // ==========================================

  /**
   * Logout - clear session and blocklist the JWT
   */
  app.post("/logout", async (request, reply) => {
    // Blocklist the current JWT so it can't be reused via Bearer header
    if (request.auth?.type === "jwt") {
      try {
        // Extract jti from the raw token
        const token =
          request.headers.authorization?.slice(7) ||
          (() => {
            const c = request.cookies.wheelsai_token;
            if (!c) return null;
            const u = request.unsignCookie(c);
            return u.valid ? u.value : null;
          })();
        if (token) {
          const decoded = request.server.jwt.decode<{ jti?: string; exp?: number }>(token);
          if (decoded?.jti && decoded?.exp) {
            const ttl = decoded.exp - Math.floor(Date.now() / 1000);
            if (ttl > 0) {
              await blockJwt(decoded.jti, ttl);
            }
          }
        }
      } catch {
        // Best-effort blocklist — don't fail the logout
      }
    }
    clearAuthCookie(reply);
    return { message: "Logged out successfully" };
  });

  /**
   * Get current user
   */
  app.get("/me", { preHandler: [requireAuth], schema: { tags: ["Auth"], description: "Get current user", security: [{ bearerAuth: [] }] } }, async (request, _reply) => {
    const { userId, orgId, email, walletAddress } = request.auth!;
    // Read live: the JWT's claims predate a later verification.
    const account = userId
      ? await findUserById(userId).catch(() => null)
      : null;

    return {
      user: {
        id: userId,
        email: account?.email ?? email,
        walletAddress,
        emailVerified: account?.emailVerified ?? false,
      },
      organization: {
        id: orgId,
      },
      authType: request.auth!.type,
    };
  });

  /**
   * Organizations the signed-in user belongs to. Login lands in the user's
   * own org; before this there was no way to act inside a team one had
   * been invited to.
   */
  app.get("/orgs", { preHandler: [requireJwtAuth] }, async (request) => {
    const { userId, orgId } = request.auth!;
    const user = await findUserById(userId!);
    return {
      organizations: (user?.memberships ?? []).map((m) => ({
        id: m.org.id,
        name: m.org.name,
        role: m.role,
        current: m.org.id === orgId,
      })),
    };
  });

  /** Re-issue the session for another organization the user belongs to. */
  app.post(
    "/switch-org",
    { preHandler: [requireJwtAuth], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { orgId: targetOrgId } = z.object({ orgId: z.string().uuid() }).parse(request.body);
      const { userId } = request.auth!;
      const user = await findUserById(userId!);
      const membership = user?.memberships.find((m) => m.org.id === targetOrgId);
      if (!user || !membership) {
        return reply.status(403).send({
          error: "not_a_member",
          message: "You are not a member of that organization.",
        });
      }
      const payload: JwtPayload = {
        userId: user.id,
        orgId: membership.org.id,
        email: user.email ?? undefined,
        walletAddress: user.walletAddress ?? undefined,
        role: membership.role,
      };
      const { accessToken } = generateTokens(app, payload);
      setAuthCookie(reply, accessToken);
      return {
        organization: { id: membership.org.id, name: membership.org.name },
        role: membership.role,
        token: accessToken,
      };
    },
  );

  /**
   * Refresh token
   *
   * The new token is built from the user's membership as it is now, never
   * from the old token's claims: copying them let a demoted or removed admin
   * renew an admin session for as long as they kept refreshing.
   */
  app.post("/refresh", { preHandler: [requireJwtAuth] }, async (request, reply) => {
    const { userId, orgId } = request.auth!;

    // requireJwtAuth guarantees a JWT principal (non-null userId)
    const user = await findUserById(userId!);
    const membership = user?.memberships.find((m) => m.org.id === orgId);
    if (!user || !membership) {
      clearAuthCookie(reply);
      return reply.status(401).send({
        error: "membership_revoked",
        message: "You are no longer a member of this organization. Sign in again.",
      });
    }

    const payload: JwtPayload = {
      userId: user.id,
      orgId: membership.org.id,
      email: user.email ?? undefined,
      walletAddress: user.walletAddress ?? undefined,
      role: membership.role,
    };

    const { accessToken } = generateTokens(app, payload);
    setAuthCookie(reply, accessToken);

    return { token: accessToken };
  });

  // ==========================================
  // API Key Management
  // ==========================================

  /**
   * List API keys
   */
  app.get("/keys", { preHandler: [requireJwtAuth] }, async (request, _reply) => {
    const { orgId } = request.auth!;
    const keys = await listApiKeys(orgId);
    const apiKeys = keys.map((key) => ({
      ...key,
      status: "active" as const,
    }));
    return { keys: apiKeys, apiKeys };
  });

  /**
   * Create API key
   */
  app.post("/keys", { preHandler: [requireJwtAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const body = createApiKeySchema.parse(request.body);
    const scopes = [...new Set(body.scopes)];

    // Scopes used to be free text nobody checked. A key now gets only scopes
    // that exist, and a key that can hire, or pay to use agents, always has
    // its spend caps.
    const problem = checkKeyGrant({ ...body, scopes });
    if (problem) {
      return reply.status(problem.code === "invalid_scope" ? 400 : 422).send({
        error: problem.code,
        message: problem.message,
      });
    }
    // Minting a key that can spend is itself a spending decision.
    if (scopes.some(isSpendScope)) {
      const membership = request.auth!.userId
        ? await prisma.orgMember.findUnique({
            where: { orgId_userId: { orgId, userId: request.auth!.userId } },
            select: { role: true },
          })
        : null;
      if (membership?.role !== "owner" && membership?.role !== "admin") {
        return reply.status(403).send({
          error: "insufficient_role",
          message: "Only an owner or admin can create an API key that can spend.",
        });
      }
    }

    const { key, keyId } = await generateApiKey(orgId, body.name, scopes, {
      maxJobPriceCents: body.maxJobPriceCents,
      maxUsePriceCents: body.maxUsePriceCents,
      dailySpendCapCents: body.dailySpendCapCents,
    });
    const createdKey = (await listApiKeys(orgId)).find((candidate) => candidate.id === keyId);
    const apiKey = createdKey
      ? {
          ...createdKey,
          status: "active" as const,
        }
      : {
          id: keyId,
          keyPrefix: key.slice(0, 16),
          name: body.name ?? null,
          scopes,
          maxJobPriceCents: body.maxJobPriceCents ?? null,
          maxUsePriceCents: body.maxUsePriceCents ?? null,
          dailySpendCapCents: body.dailySpendCapCents ?? null,
          lastUsedAt: null,
          expiresAt: null,
          createdAt: new Date(),
          status: "active" as const,
        };

    logger.info({ orgId, keyId }, "API key created");

    reply.status(201);
    return {
      id: keyId,
      key, // Only returned once!
      apiKey,
      message: "Store this key securely - it cannot be retrieved again",
    };
  });

  /**
   * Revoke API key
   */
  app.delete(
    "/keys/:keyId",
    { preHandler: [requireJwtAuth] },
    async (request, _reply) => {
      const { orgId } = request.auth!;
      const { keyId } = z.object({ keyId: z.string() }).parse(request.params);

      await revokeApiKey(keyId, orgId);

      return { message: "API key revoked" };
    }
  );
};
