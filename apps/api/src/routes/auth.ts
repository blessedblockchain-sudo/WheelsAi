import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import {
  verifyPassword,
  createUser,
  findUserByEmail,
  findOrCreateUserByWallet,
  generateNonce,
  getNonce,
  consumeNonce,
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
import { blockJwt } from "../services/auth.js";
import { createLogger } from "../utils/logger.js";

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
  scopes: z.array(z.string()).default([]),
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
    };
  });

  /**
   * Login with email/password
   */
  app.post("/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { tags: ["Auth"], description: "Login with email and password", body: { type: "object", properties: { email: { type: "string" }, password: { type: "string" } }, required: ["email", "password"] } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);

    // Find user
    const user = await findUserByEmail(body.email);
    if (!user || !user.passwordHash) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }

    // Verify password
    const valid = await verifyPassword(user.passwordHash, body.password);
    if (!valid) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid email or password",
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

    // Verify the nonce matches
    const storedNonce = await getNonce(walletAddress);
    if (!storedNonce || storedNonce !== nonce) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid or expired nonce",
      });
    }

    // Verify the signature
    const isValid = verifySolanaSignature(nonce, signature, walletAddress);
    if (!isValid) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid signature",
      });
    }

    // Consume the nonce (one-time use)
    await consumeNonce(walletAddress);

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

    return {
      user: {
        id: userId,
        email,
        walletAddress,
      },
      organization: {
        id: orgId,
      },
      authType: request.auth!.type,
    };
  });

  /**
   * Refresh token
   */
  app.post("/refresh", { preHandler: [requireJwtAuth] }, async (request, reply) => {
    const { userId, orgId, email, walletAddress, role } = request.auth!;

    const payload: JwtPayload = {
      userId: userId!, // requireJwtAuth guarantees a JWT principal (non-null userId)
      orgId,
      email,
      walletAddress,
      role: role ?? undefined,
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

    const { key, keyId } = await generateApiKey(orgId, body.name, body.scopes);
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
          scopes: body.scopes,
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
