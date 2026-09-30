/**
 * Free-Tier Rate Limiter
 *
 * Uses Redis sliding window to enforce per-org rate limits on free model usage.
 */

import { Redis } from "ioredis";
import { getOrgPlan } from "../services/orgPlan.js";
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("free-tier-limit");

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    redis.connect().catch((err) => {
      logger.error({ err }, "Failed to connect to Redis for rate limiting");
    });
  }
  return redis;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: {
    rpm: number;
    rpd: number;
  };
  resetAt: {
    rpm: number; // unix timestamp (seconds)
    rpd: number;
  };
}

/**
 * Check and increment free-tier rate limits for an organization.
 * Returns whether the request is allowed and remaining quota.
 */
export async function checkFreeTierLimit(orgId: string): Promise<RateLimitResult> {
  const r = getRedis();
  const now = Math.floor(Date.now() / 1000);

  // "Priority model access": paid plans get a multiple of the free-model
  // limits. A plan lookup failure falls back to the Starter limits.
  const multiplier = await getOrgPlan(orgId)
    .then(({ limits }) => limits.modelRateMultiplier)
    .catch(() => 1);
  const RPM_LIMIT = env.FREE_TIER_RPM * multiplier;
  const RPD_LIMIT = env.FREE_TIER_RPD * multiplier;

  const rpmKey = `free:rpm:${orgId}`;
  const rpdKey = `free:rpd:${orgId}`;

  try {
    // Use a pipeline for atomicity
    const pipe = r.pipeline();
    pipe.incr(rpmKey);
    pipe.ttl(rpmKey);
    pipe.incr(rpdKey);
    pipe.ttl(rpdKey);

    const results = await pipe.exec();
    if (!results) {
      // Redis unavailable — allow request (fail open)
      return { allowed: true, remaining: { rpm: RPM_LIMIT, rpd: RPD_LIMIT }, resetAt: { rpm: now + 60, rpd: now + 86400 } };
    }

    const rpmCount = (results[0]?.[1] as number) ?? 1;
    const rpmTtl = (results[1]?.[1] as number) ?? -1;
    const rpdCount = (results[2]?.[1] as number) ?? 1;
    const rpdTtl = (results[3]?.[1] as number) ?? -1;

    // Set TTL on first increment
    if (rpmCount === 1 || rpmTtl === -1) {
      await r.expire(rpmKey, 60);
    }
    if (rpdCount === 1 || rpdTtl === -1) {
      await r.expire(rpdKey, 86400);
    }

    const rpmRemaining = Math.max(0, RPM_LIMIT - rpmCount);
    const rpdRemaining = Math.max(0, RPD_LIMIT - rpdCount);

    const allowed = rpmCount <= RPM_LIMIT && rpdCount <= RPD_LIMIT;

    if (!allowed) {
      // Undo the increment since we're rejecting
      await r.pipeline().decr(rpmKey).decr(rpdKey).exec();
    }

    return {
      allowed,
      remaining: { rpm: rpmRemaining, rpd: rpdRemaining },
      resetAt: {
        rpm: now + (rpmTtl > 0 ? rpmTtl : 60),
        rpd: now + (rpdTtl > 0 ? rpdTtl : 86400),
      },
    };
  } catch (err) {
    logger.error({ err }, "Rate limit check failed, allowing request");
    // Fail open
    return { allowed: true, remaining: { rpm: RPM_LIMIT, rpd: RPD_LIMIT }, resetAt: { rpm: now + 60, rpd: now + 86400 } };
  }
}
