/**
 * The rate limiter for callers nobody can identify: the web chat widget and
 * a listing's Try it.
 *
 * Every other limiter in this codebase fails OPEN - when Redis is down the
 * request goes through, because a Redis blip must not take a paying
 * customer's API down. That is the wrong default for an anonymous visitor
 * spending somebody else's allowance: with no count there is no limit at
 * all. This one answers `unavailable` instead, and its callers refuse (503).
 * It never answers `ok` without having counted.
 *
 * `consume(rules)` is all-or-nothing. A request is held to several limits at
 * once (per address, per key, per day); it is counted against all of them or,
 * when any one is used up, against none - so a visitor who is refused by the
 * per-minute limit has not also used up part of the owner's daily cap.
 *
 * Windows are fixed and start at a key's first hit. A limit that must reset
 * on a calendar boundary (a daily cap) puts the day in its key.
 *
 * Pure core plus two stores: one in memory (unit tests), one on Redis.
 */

export interface LimitRule {
  /** What the caller is told was used up: "ip", "key", "session", ... */
  scope: string;
  key: string;
  /** Requests allowed per window. Zero or less refuses every request. */
  limit: number;
  windowSeconds: number;
}

export type LimitDecision =
  | { status: "ok" }
  | { status: "limited"; scope: string; rule: LimitRule; retryAfterSeconds: number }
  | { status: "unavailable" };

export type StoreConsumeResult =
  | { allowed: true }
  | { allowed: false; index: number; retryAfterMs: number };

export interface LimiterStore {
  /**
   * Atomically: when every key is below its limit, count one against each
   * (starting a key's window on its first hit) and allow. Otherwise change
   * nothing and name the first rule that is used up.
   */
  consume(rules: ReadonlyArray<{ key: string; limit: number; windowMs: number }>): Promise<StoreConsumeResult>;
  /** The current count of a key (0 when it has none). Throws when unreadable. */
  peek(key: string): Promise<number>;
}

export interface FailClosedLimiter {
  consume(rules: readonly LimitRule[]): Promise<LimitDecision>;
  /** null when the store cannot be read: unknown, never a made-up zero. */
  peek(key: string): Promise<number | null>;
}

export interface FailClosedLimiterOptions {
  /** How long the store may take before the answer is `unavailable`. */
  timeoutMs?: number;
  onUnavailable?: (err: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 750;

class LimiterTimeout extends Error {
  constructor() {
    super("the limiter store did not answer in time");
    this.name = "LimiterTimeout";
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Not unref'd: it is cleared as soon as the store answers, and a
    // pending decision must not be abandoned by an idle event loop.
    timer = setTimeout(() => reject(new LimiterTimeout()), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createFailClosedLimiter(
  store: LimiterStore,
  options: FailClosedLimiterOptions = {},
): FailClosedLimiter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async consume(rules) {
      // Nothing to count is a caller's bug, and "ok" would be an answer
      // given without counting.
      if (rules.length === 0) return { status: "unavailable" };
      for (const rule of rules) {
        const sane =
          rule.key.length > 0 &&
          Number.isFinite(rule.limit) &&
          Number.isFinite(rule.windowSeconds) &&
          rule.windowSeconds > 0;
        if (!sane) {
          options.onUnavailable?.(new Error(`limiter rule "${rule.scope}" is malformed`));
          return { status: "unavailable" };
        }
      }

      let result: StoreConsumeResult;
      try {
        result = await withTimeout(
          store.consume(
            rules.map((rule) => ({
              key: rule.key,
              limit: Math.floor(rule.limit),
              windowMs: Math.ceil(rule.windowSeconds * 1000),
            })),
          ),
          timeoutMs,
        );
      } catch (err) {
        options.onUnavailable?.(err);
        return { status: "unavailable" };
      }

      // Read defensively: a store's answer is the one thing between a
      // stranger and "ok".
      if (result?.allowed === true) return { status: "ok" };
      const rule = result?.allowed === false ? rules[result.index] : undefined;
      if (!rule) {
        // A store that answers neither "allowed" nor a rule it was given has
        // not counted anything this code can trust.
        options.onUnavailable?.(new Error("the limiter store returned an unreadable answer"));
        return { status: "unavailable" };
      }
      const retryAfterMs =
        Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0
          ? result.retryAfterMs
          : rule.windowSeconds * 1000;
      return {
        status: "limited",
        scope: rule.scope,
        rule,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    },

    async peek(key) {
      try {
        const count = await withTimeout(store.peek(key), timeoutMs);
        return Number.isFinite(count) && count >= 0 ? count : null;
      } catch (err) {
        options.onUnavailable?.(err);
        return null;
      }
    },
  };
}

// ============================================
// Memory store
// ============================================

export function createMemoryLimiterStore(now: () => number = Date.now): LimiterStore {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  const live = (key: string) => {
    const window = windows.get(key);
    if (!window) return null;
    if (window.expiresAt <= now()) {
      windows.delete(key);
      return null;
    }
    return window;
  };

  return {
    async consume(rules) {
      for (const [index, rule] of rules.entries()) {
        const window = live(rule.key);
        if ((window?.count ?? 0) >= rule.limit) {
          return { allowed: false, index, retryAfterMs: window ? window.expiresAt - now() : rule.windowMs };
        }
      }
      for (const rule of rules) {
        const window = live(rule.key);
        if (window) window.count += 1;
        else windows.set(rule.key, { count: 1, expiresAt: now() + rule.windowMs });
      }
      return { allowed: true };
    },
    async peek(key) {
      return live(key)?.count ?? 0;
    },
  };
}

// ============================================
// Redis store
// ============================================

/**
 * Every limiter key carries the same hash tag, so in Redis Cluster they all
 * land in one slot and a script may touch several of them.
 */
export const LIMITER_KEY_PREFIX = "pcl:{public-chat}:";

export const LIMITER_COMMAND = "publicChatConsume";

/**
 * KEYS: one per rule. ARGV: `limit, windowMs` per rule, in order.
 * Returns `{1, 0, 0}` after counting one against every key, or
 * `{0, i, ttlMs}` (i is 1-based) having changed nothing.
 *
 * Check-all-then-increment-all inside one script is what makes consume
 * all-or-nothing: Redis runs a script without interleaving other commands.
 */
export const LIMITER_LUA = `
for i = 1, #KEYS do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count >= tonumber(ARGV[2 * i - 1]) then
    local ttl = redis.call('PTTL', KEYS[i])
    if ttl < 0 then ttl = tonumber(ARGV[2 * i]) end
    return {0, i, ttl}
  end
end
for i = 1, #KEYS do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 or redis.call('PTTL', KEYS[i]) < 0 then
    redis.call('PEXPIRE', KEYS[i], ARGV[2 * i])
  end
end
return {1, 0, 0}
`;

/** The slice of an ioredis client (with LIMITER_COMMAND defined) the store uses. */
export interface LimiterRedis {
  publicChatConsume(numKeys: number, ...keysAndArgs: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export function limiterKey(key: string): string {
  return `${LIMITER_KEY_PREFIX}${key}`;
}

export function createRedisLimiterStore(redis: LimiterRedis): LimiterStore {
  return {
    async consume(rules) {
      const keys = rules.map((rule) => limiterKey(rule.key));
      const args = rules.flatMap((rule) => [rule.limit, rule.windowMs]);
      const reply = await redis.publicChatConsume(keys.length, ...keys, ...args);
      // Anything but the script's own two answers is not a count.
      if (!Array.isArray(reply) || reply.length < 3) {
        throw new Error("unexpected reply from the limiter script");
      }
      const [allowed, index, ttlMs] = reply.map(Number) as [number, number, number];
      if (allowed === 1) return { allowed: true };
      if (allowed === 0 && Number.isInteger(index) && index >= 1 && index <= rules.length) {
        return { allowed: false, index: index - 1, retryAfterMs: ttlMs };
      }
      throw new Error("unexpected reply from the limiter script");
    },
    async peek(key) {
      const raw = await redis.get(limiterKey(key));
      if (raw === null) return 0;
      const count = Number(raw);
      if (!Number.isFinite(count)) throw new Error("the limiter key does not hold a count");
      return count;
    },
  };
}
