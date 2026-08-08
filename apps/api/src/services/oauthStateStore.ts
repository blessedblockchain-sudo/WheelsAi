/**
 * Single-use nonces for OAuth-style flows.
 *
 * A signed state token (services/signedState.ts) proves WE minted it and
 * that it has not expired. It does not stop the same token being
 * presented twice — and an OAuth callback is exactly where replay
 * matters, because the state carries the org binding. So every flow mints
 * a nonce, stores it, and consumes it at the callback: the DELETE must
 * report that it actually removed something, which makes exactly one
 * concurrent consumer the winner.
 *
 * Redis `SET NX EX` / `DEL`-returns-1 is the same idiom the auth nonce
 * store already uses (services/auth.ts), on the same shared client — do
 * not open a second connection.
 *
 * The store surface is injected so routes are testable without Redis.
 */

export interface NonceStore {
  /** false when the key already existed (never overwrite a live nonce). */
  mint: (nonce: string, ttlSeconds: number) => Promise<boolean>;
  /** true only for the caller whose DELETE actually removed the key. */
  consume: (nonce: string) => Promise<boolean>;
}

const KEY_PREFIX = "oauth-state:";

export interface RedisLike {
  set: (
    key: string,
    value: string,
    mode: "EX",
    ttl: number,
    nx: "NX",
  ) => Promise<string | null>;
  del: (key: string) => Promise<number>;
}

export function makeRedisNonceStore(redis: RedisLike): NonceStore {
  return {
    mint: async (nonce, ttlSeconds) => {
      const result = await redis.set(
        `${KEY_PREFIX}${nonce}`,
        "1",
        "EX",
        ttlSeconds,
        "NX",
      );
      return result === "OK";
    },
    consume: async (nonce) => {
      const removed = await redis.del(`${KEY_PREFIX}${nonce}`);
      return removed === 1;
    },
  };
}

/**
 * In-memory store for tests and single-process development.
 *
 * NOT safe across replicas — two API instances would each hold their own
 * map, so a nonce consumed on one is still live on the other. The Redis
 * store is the real one; this exists so tests need no Redis.
 */
export function makeMemoryNonceStore(now: () => number = Date.now): NonceStore {
  const entries = new Map<string, number>();
  return {
    mint: async (nonce, ttlSeconds) => {
      const existing = entries.get(nonce);
      if (existing !== undefined && existing > now()) return false;
      entries.set(nonce, now() + ttlSeconds * 1000);
      return true;
    },
    consume: async (nonce) => {
      const expiry = entries.get(nonce);
      if (expiry === undefined) return false;
      entries.delete(nonce);
      // An expired nonce is not consumable — same as Redis, where the key
      // would already be gone.
      return expiry > now();
    },
  };
}
