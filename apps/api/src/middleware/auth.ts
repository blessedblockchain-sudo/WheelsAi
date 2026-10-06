import { FastifyRequest, FastifyReply, FastifyInstance } from "fastify";
import { meterApiCall } from "../services/orgPlan.js";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";

import { nanoid } from "nanoid";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { validateApiKey, isJwtBlocked, type JwtPayload } from "../services/auth.js";
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
      // null for API-key principals — an API key belongs to an org, not a
      // user, so there is no user identity behind it (F4). Routes that act on
      // behalf of a user (2FA, accept-invite) must guard against null.
      userId: string | null;
      orgId: string;
      orgName?: string;
      email?: string;
      walletAddress?: string;
      // Org role ('owner' | 'admin' | 'member'). Starts as the claim baked
      // into the JWT at login, which can be up to a token lifetime stale;
      // requireRole replaces it with the membership's current role. Absent
      // for API-key principals (F4).
      role?: string | null;
      type: "jwt" | "api_key";
      scopes?: string[];
      // The key behind an API-key principal, so writes can record which key
      // acted instead of inventing a user.
      apiKeyId?: string;
      apiKeyName?: string | null;
      apiKeyPrefix?: string;
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
  app.addHook("onRequest", async (request, _reply) => {
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
        userId: null, // API keys have no user context (F4)
        orgId: validated.orgId,
        type: "api_key",
        scopes: validated.scopes,
        apiKeyId: validated.id,
        apiKeyName: validated.name,
        apiKeyPrefix: validated.keyPrefix,
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

    // Check JWT blocklist (logout invalidation)
    if (decoded.jti && await isJwtBlocked(decoded.jti)) {
      logger.debug({ jti: decoded.jti }, "Bearer token is blocklisted");
      return null;
    }

    return {
      userId: decoded.userId,
      orgId: decoded.orgId,
      email: decoded.email,
      walletAddress: decoded.walletAddress,
      role: decoded.role,
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

    // Check JWT blocklist (logout invalidation)
    if (decoded.jti && await isJwtBlocked(decoded.jti)) {
      logger.debug({ jti: decoded.jti }, "Cookie token is blocklisted");
      return null;
    }

    return {
      userId: decoded.userId,
      orgId: decoded.orgId,
      email: decoded.email,
      walletAddress: decoded.walletAddress,
      role: decoded.role,
      type: "jwt",
    };
  } catch (error) {
    logger.debug({ error }, "Cookie auth verification failed");
    return null;
  }
}

function toLegacyUser(auth: NonNullable<FastifyRequest["auth"]>): LegacyJwtUser {
  // The legacy `request.user` shape predates nullable userId; coerce the
  // API-key (null) case to "" so ~90 existing `request.user.id` callers keep
  // their string typing. New code should read `request.auth.userId` and
  // handle null explicitly (F4).
  return {
    id: auth.userId ?? "",
    userId: auth.userId ?? "",
    orgId: auth.orgId,
    organizationId: auth.orgId,
    email: auth.email,
    walletAddress: auth.walletAddress,
  };
}

// ============================================
// Auth Guards
// ============================================

// Reads are free: polling a deployment's status, listing agents or an
// OpenAI client listing /v1/models must not spend the plan's monthly calls (a
// CLI waiting ten minutes at one poll every three seconds would burn a fifth
// of Starter). The global rate limit still bounds them.
const UNMETERED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a request counts against the plan's monthly API calls: a request
 * that is not a read, made with an API key or to the OpenAI-compatible /v1
 * API (however that one is authenticated). So a chat completion counts once
 * and `GET /v1/models` is free.
 *
 * The /v1 guard (middleware/openaiAuth.ts) applies this same rule.
 */
export function countsAsApiCall(request: {
  authType: "jwt" | "api_key";
  method: string;
  url: string;
}): boolean {
  if (UNMETERED_METHODS.has(request.method.toUpperCase())) return false;
  return request.authType === "api_key" || request.url.startsWith("/v1/");
}

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
  if (
    countsAsApiCall({
      authType: request.auth.type,
      method: request.method,
      url: request.url,
    })
  ) {
    await meterApiCall(request.auth.orgId);
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

/**
 * The member's current role in the org, or null when they are not a member.
 */
export type MemberRoleLookup = (
  orgId: string,
  userId: string
) => Promise<string | null>;

const lookupMemberRole: MemberRoleLookup = async (orgId, userId) => {
  const membership = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { role: true },
  });
  return membership?.role ?? null;
};

/**
 * Build `requireRole` over a membership lookup. Production uses the
 * database-backed `requireRole` below; tests pass a fake.
 */
export function createRequireRole(deps: { getMemberRole: MemberRoleLookup }) {
  return function requireRole(...allowedRoles: string[]) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.auth) {
        return reply.status(401).send({
          error: "unauthenticated",
          message: "Authentication required",
        });
      }

      if (request.auth.type === "api_key") return;

      // The token's role claim is as old as the token: a demoted or removed
      // admin keeps it until expiry. Privileged routes decide on the
      // membership as it is now.
      let role: string | null = null;
      if (request.auth.userId) {
        try {
          role = await deps.getMemberRole(
            request.auth.orgId,
            request.auth.userId
          );
        } catch (error) {
          logger.error(
            { error, orgId: request.auth.orgId },
            "Role lookup failed; refusing the role-gated request"
          );
          return reply.status(503).send({
            error: "role_check_unavailable",
            message: "Could not verify your role right now. Try again shortly.",
          });
        }
      }

      if (!role) {
        // Downstream handlers must not see the stale claim either.
        request.auth.role = null;
        return reply.status(403).send({
          error: "not_a_member",
          message: "You are no longer a member of this organization.",
        });
      }

      request.auth.role = role;

      if (!allowedRoles.includes(role)) {
        return reply.status(403).send({
          error: "insufficient_role",
          message: `Requires role: ${allowedRoles.join(" or ")}`,
        });
      }
    };
  };
}

/**
 * Require one of the given organization roles (remediation F4).
 *
 * The role is read from the caller's current OrgMember row on every request,
 * not from the JWT: the claim baked in at login outlives a demotion or a
 * removal. A missing membership is refused, and so is a failed lookup. Use
 * this on privileged actions a freshly-invited `member` must not perform:
 * reading audit logs, configuring SSO, minting credits, requesting payouts,
 * and member management.
 *
 * Policy: an org-scoped API key acts with org authority and BYPASSES the
 * per-user role check — role gating applies only to JWT (human) sessions. For
 * per-user identity actions (2FA), use `requireJwtAuth` instead, which refuses
 * API keys outright.
 */
export const requireRole = createRequireRole({
  getMemberRole: lookupMemberRole,
});

// ============================================
// Token Generation
// ============================================

export function generateTokens(
  app: FastifyInstance<any, any, any, any>,
  payload: JwtPayload
) {
  // Add a unique token ID for logout/blocklist support
  const jti = nanoid(16);
  const accessToken = app.jwt.sign({ ...payload, jti });

  return { accessToken, jti };
}

export function setAuthCookie(
  reply: FastifyReply,
  token: string,
  maxAge = 24 * 60 * 60 // 24 hours
) {
  reply.setCookie("wheelsai_token", token, {
    path: "/",
    httpOnly: true,
    secure: env.NODE_ENV !== "development",
    sameSite: "lax",
    signed: true,
    maxAge,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}

export function clearAuthCookie(reply: FastifyReply) {
  // Must match the domain it was set with, or the cookie survives logout.
  reply.clearCookie("wheelsai_token", {
    path: "/",
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}

// Aliases for backward compatibility
export const authenticate = requireAuth;
export const authMiddleware = requireAuth;
