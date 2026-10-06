/**
 * Per-agent write lock for the `file_write` skill.
 *
 * The per-agent file limit is "count, then put", and an object store has no
 * transaction to make that atomic. The first attempt let every writer put and
 * then deleted its own key when a re-count came out over the limit - which
 * deleted ANOTHER writer's file whenever two writers shared a path, after that
 * writer had already been told "ok". A compensating delete cannot be made safe
 * without conditional deletes, which not every S3-compatible backend honours
 * (and one that ignores the condition fails open, silently).
 *
 * So writers to one agent take turns instead: the count and the put happen
 * under this lock and nothing is ever deleted. Reads do not lock.
 *
 * The lock is a lease, not a mutex: it expires on its own, so a crashed holder
 * cannot wedge an agent's storage. The holder gets a `signal` that aborts
 * before the lease does - past that point it must not start a write, because
 * the next writer may already be counting.
 */

import { randomUUID } from "node:crypto";

export interface FileLockLease {
  /** Aborts when the lease is about to lapse: stop, do not start a write. */
  signal: AbortSignal;
  /** Never throws; an unreleased lease simply expires. */
  release(): Promise<void>;
}

export interface AgentFileLock {
  /**
   * Waits its turn for `scope`. null when the turn did not come in time (the
   * caller refuses the write). Throws when the lock backend itself is down -
   * also a refusal: no lock, no write.
   */
  acquire(scope: string): Promise<FileLockLease | null>;
}

export const FILE_LOCK_DEFAULTS = {
  /** Lease length. Far longer than a list + put of a <= 1 MiB object. */
  ttlMs: 30_000,
  /** The holder is told to stop this long before the lease lapses. */
  safetyMarginMs: 5_000,
  /** How long a writer queues behind others before it is refused. */
  waitMs: 10_000,
  retryMs: 50,
};

export type FileLockOptions = Partial<typeof FILE_LOCK_DEFAULTS> & {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The lease's stop signal, plus the timer to clear when it is released. */
function holdSignal(holdMs: number): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, holdMs));
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

// ============================================
// Redis implementation (every API replica shares it)
// ============================================

export interface LockRedis {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<string | null>;
  /** Redis EVAL: a Lua script run atomically on the server. */
  runScript(script: string, keys: string[], args: string[]): Promise<unknown>;
}

// Delete only OUR lease: after an expiry the key may belong to the next
// writer, and a plain DEL would release their lock out from under them.
const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const KEY_PREFIX = "agent-file-lock:";

export function makeRedisAgentFileLock(
  redis: LockRedis,
  options: FileLockOptions = {},
): AgentFileLock {
  const { ttlMs, safetyMarginMs, waitMs, retryMs } = { ...FILE_LOCK_DEFAULTS, ...options };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;

  return {
    async acquire(scope) {
      const key = `${KEY_PREFIX}${scope}`;
      const token = randomUUID();
      const giveUpAt = now() + waitMs;
      for (;;) {
        // Measured from BEFORE the SET: Redis starts the lease's clock no
        // later than this, so the holder can only stop early, never late.
        const askedAt = now();
        if ((await redis.set(key, token, "PX", ttlMs, "NX")) === "OK") {
          const hold = holdSignal(ttlMs - safetyMarginMs - (now() - askedAt));
          return {
            signal: hold.signal,
            release: async () => {
              hold.stop();
              await redis.runScript(RELEASE_SCRIPT, [key], [token]).catch(() => {});
            },
          };
        }
        if (now() + retryMs > giveUpAt) return null;
        await sleep(retryMs);
      }
    },
  };
}

// ============================================
// In-process implementation (tests, single-process development)
// ============================================

/**
 * NOT safe across replicas: two API instances would each hold their own
 * queue. The Redis lock is the real one; production.ts wires it.
 */
export function makeMemoryAgentFileLock(options: FileLockOptions = {}): AgentFileLock {
  const { ttlMs, safetyMarginMs, waitMs } = { ...FILE_LOCK_DEFAULTS, ...options };
  const tails = new Map<string, Promise<void>>();

  return {
    async acquire(scope) {
      const previous = tails.get(scope) ?? Promise.resolve();
      let free!: () => void;
      const mine = new Promise<void>((resolve) => {
        free = resolve;
      });
      const tail = previous.then(() => mine);
      tails.set(scope, tail);
      const forget = () => {
        if (tails.get(scope) === tail) tails.delete(scope);
      };

      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const myTurn = await Promise.race([
        previous.then(() => true),
        new Promise<boolean>((resolve) => {
          waitTimer = setTimeout(() => resolve(false), waitMs);
        }),
      ]);
      clearTimeout(waitTimer);
      if (!myTurn) {
        // Step out of the queue without holding up whoever is behind.
        free();
        void tail.then(forget);
        return null;
      }

      const hold = holdSignal(ttlMs - safetyMarginMs);
      // Like the Redis lease, this one lapses by itself.
      const expiry = setTimeout(free, ttlMs);
      expiry.unref?.();
      return {
        signal: hold.signal,
        release: async () => {
          hold.stop();
          clearTimeout(expiry);
          free();
          forget();
        },
      };
    },
  };
}
