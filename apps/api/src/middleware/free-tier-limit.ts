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

export interface FreeTierLimitOptions {
  /**
   * What to answer when the limit cannot be counted (Redis down, or a
   * command that failed). An organization's own chats are let through: a
   * Redis blip must not take every customer's playground down. A PUBLIC
   * caller - an anonymous visitor spending the organization's allowance
   * through its widget - is refused instead: unlimited is not a safe default
   * for somebody nobody can identify.
   */
  failClosed?: boolean;
}

/** The slice of ioredis the limiter uses; a fake in the unit tests. */
export interface FreeTierCounter {
  pipeline(): {
    incr(key: string): unknown;
    ttl(key: string): unknown;
    decr(key: string): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface FreeTierLimitDeps {
  counter?: FreeTierCounter;
  /** The plan's multiple of the free-model limits. */
  rateMultiplier?: (orgId: string) => Promise<number>;
  now?: () => number;
}

/**
 * Check and increment free-tier rate limits for an organization.
 * Returns whether the request is allowed and remaining quota.
 */
export async function checkFreeTierLimit(
  orgId: string,
  options: FreeTierLimitOptions = {},
  deps: FreeTierLimitDeps = {},
): Promise<RateLimitResult> {
  const r = deps.counter ?? (getRedis() as unknown as FreeTierCounter);
  const now = Math.floor((deps.now ?? Date.now)() / 1000);

  // "Priority model access": paid plans get a multiple of the free-model
  // limits. A plan lookup failure falls back to the Starter limits.
  const multiplier = await (
    deps.rateMultiplier ?? ((id) => getOrgPlan(id).then(({ limits }) => limits.modelRateMultiplier))
  )(orgId).catch(() => 1);
  const RPM_LIMIT = env.FREE_TIER_RPM * multiplier;
  const RPD_LIMIT = env.FREE_TIER_RPD * multiplier;

  const rpmKey = `free:rpm:${orgId}`;
  const rpdKey = `free:rpd:${orgId}`;

  /** The limit could not be counted. */
  const uncounted = (): RateLimitResult =>
    options.failClosed
      ? { allowed: false, remaining: { rpm: 0, rpd: 0 }, resetAt: { rpm: now + 60, rpd: now + 60 } }
      : {
          allowed: true,
          remaining: { rpm: RPM_LIMIT, rpd: RPD_LIMIT },
          resetAt: { rpm: now + 60, rpd: now + 86400 },
        };

  try {
    // Use a pipeline for atomicity
    const pipe = r.pipeline();
    pipe.incr(rpmKey);
    pipe.ttl(rpmKey);
    pipe.incr(rpdKey);
    pipe.ttl(rpdKey);

    const results = await pipe.exec();
    if (!results) return uncounted();
    if (options.failClosed) {
      // A command that failed inside the pipeline reports its error in its
      // own slot. Reading that as "the first request" would let a public
      // caller through uncounted.
      const counted =
        results.length === 4 &&
        results.every(([err]) => !err) &&
        typeof results[0]?.[1] === "number" &&
        typeof results[2]?.[1] === "number";
      if (!counted) {
        logger.error({ orgId }, "Rate limit could not be counted; refusing the public request");
        return uncounted();
      }
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
      const undo = r.pipeline();
      undo.decr(rpmKey);
      undo.decr(rpdKey);
      await undo.exec();
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
    logger.error(
      { err },
      options.failClosed
        ? "Rate limit check failed; refusing the public request"
        : "Rate limit check failed, allowing request",
    );
    return uncounted();
  }
}
