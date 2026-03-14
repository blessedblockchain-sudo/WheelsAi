import { FastifyRequest, FastifyReply, FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";

import { env } from "../config/env.js";
import { validateApiKey, type JwtPayload } from "../services/auth.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("auth-middleware");

type LegacyJwtUser = JwtPayload & {
  id: string;
  organizationId: string;
};

// Extend Fastify types
declare module "fastify" {
  interface FastifyRequest {
    auth: {
      userId: string;
      orgId: string;
      orgName?: string;
      email?: string;
      walletAddress?: string;
      type: "jwt" | "api_key";
      scopes?: string[];
    } | null;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: LegacyJwtUser;
  }
}

// ============================================
// Plugin Registration
// ============================================

export async function registerAuthPlugins(
  app: FastifyInstance<any, any, any, any>
) {
  // Register cookie plugin for session management
  await app.register(fastifyCookie, {
    secret: env.JWT_SECRET,
    hook: "onRequest",
  });

  // Register JWT plugin
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN,
    },
    cookie: {
      cookieName: "wheelsai_token",
      signed: true,
    },
  });

  // Add auth decorator
  app.decorateRequest("auth", null);

  // Global auth hook - runs on every request
  app.addHook("onRequest", async (request, reply) => {
    request.auth = null;

    // Try to authenticate from various sources
    const auth = await authenticateRequest(request, app);
    if (auth) {
      request.auth = auth;
      request.user = toLegacyUser(auth);
    }
  });
}

// ============================================
// Authentication Logic
// ============================================

async function authenticateRequest(
  request: FastifyRequest,
  app: FastifyInstance<any, any, any, any>
): Promise<FastifyRequest["auth"]> {
  // 1. Check for API key in header
  const apiKeyAuth = await tryApiKeyAuth(request);
  if (apiKeyAuth) return apiKeyAuth;

  // 2. Check for Bearer token in Authorization header
  const bearerAuth = await tryBearerAuth(request, app);
  if (bearerAuth) return bearerAuth;

  // 3. Check for JWT in cookie
  const cookieAuth = await tryCookieAuth(request, app);
  if (cookieAuth) return cookieAuth;

  return null;
}

async function tryApiKeyAuth(
  request: FastifyRequest
): Promise<FastifyRequest["auth"]> {
  const authHeader = request.headers.authorization;
  if (!authHeader) return null;

  // Check for API key format: "Bearer wheels_live_..."
  if (authHeader.startsWith("Bearer wheels_")) {
    const apiKey = authHeader.slice(7); // Remove "Bearer "

    try {
      const validated = await validateApiKey(apiKey);
      if (!validated) return null;

      return {
        userId: "", // API keys don't have a user context
        orgId: validated.orgId,
        type: "api_key",
        scopes: validated.scopes,
      };
    } catch (error) {
      logger.debug({ error }, "API key validation failed");
      return null;
    }
  }

  return null;
}

async function tryBearerAuth(
  request: FastifyRequest,
  app: FastifyInstance<any, any, any, any>
): Promise<FastifyRequest["auth"]> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);

  // Skip if it looks like an API key
  if (token.startsWith("wheels_")) return null;

  try {
    const decoded = app.jwt.verify<JwtPayload>(token);
    return {
      userId: decoded.userId,
      orgId: decoded.orgId,
      email: decoded.email,
      walletAddress: decoded.walletAddress,
      type: "jwt",
    };
  } catch (error) {
    logger.debug({ error }, "Bearer token verification failed");
    return null;
  }
}

async function tryCookieAuth(
  request: FastifyRequest,
  app: FastifyInstance<any, any, any, any>
): Promise<FastifyRequest["auth"]> {
  const token = request.cookies.wheelsai_token;
  if (!token) return null;

  try {
    // Unsign the cookie
    const unsigned = request.unsignCookie(token);
    if (!unsigned.valid || !unsigned.value) return null;

    const decoded = app.jwt.verify<JwtPayload>(unsigned.value);
    return {
      userId: decoded.userId,
      orgId: decoded.orgId,
      email: decoded.email,
      walletAddress: decoded.walletAddress,
      type: "jwt",
    };
  } catch (error) {
    logger.debug({ error }, "Cookie auth verification failed");
    return null;
  }
}

function toLegacyUser(auth: NonNullable<FastifyRequest["auth"]>): LegacyJwtUser {
  return {
    id: auth.userId,
    userId: auth.userId,
    orgId: auth.orgId,
    organizationId: auth.orgId,
    email: auth.email,
    walletAddress: auth.walletAddress,
  };
}

// ============================================
// Auth Guards
// ============================================

/**
 * Require authentication - returns 401 if not authenticated
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!request.auth) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Authentication required",
    });
  }
}

/**
 * Require specific scope for API key auth
 */
export function requireScope(scope: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Authentication required",
      });
    }

    if (request.auth.type === "api_key") {
      if (!request.auth.scopes?.includes(scope) && !request.auth.scopes?.includes("*")) {
        return reply.status(403).send({
          error: "Forbidden",
          message: `Missing required scope: ${scope}`,
        });
      }
    }
  };
}

/**
 * Require JWT auth specifically (not API key)
 */
export async function requireJwtAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!request.auth || request.auth.type !== "jwt") {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Session authentication required",
    });
  }
}

// ============================================
// Token Generation
// ============================================

export function generateTokens(
  app: FastifyInstance<any, any, any, any>,
  payload: JwtPayload
) {
  const accessToken = app.jwt.sign(payload);

  return { accessToken };
}

export function setAuthCookie(
  reply: FastifyReply,
  token: string,
  maxAge = 24 * 60 * 60 // 24 hours
) {
  reply.setCookie("wheelsai_token", token, {
    path: "/",
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    signed: true,
    maxAge,
  });
}

export function clearAuthCookie(reply: FastifyReply) {
  reply.clearCookie("wheelsai_token", {
    path: "/",
  });
}

// Aliases for backward compatibility
export const authenticate = requireAuth;
export const authMiddleware = requireAuth;
