/**
 * Per-subject failure caps for authentication (login per account, 2FA per
 * challenge). The global rate limiter is keyed on client IP; this bounds
 * guesses against ONE account even when an attacker spreads them across
 * many IPs.
 *
 * Only failures count; a success clears the counter. Store errors fail
 * OPEN (the per-IP limiter still applies) so a Redis blip cannot lock
 * every user out, and they are reported through onError.
 */
export interface AttemptStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export interface AttemptPolicy {
  prefix: string;
  maxFailures: number;
  windowSeconds: number;
}

export const LOGIN_POLICY: AttemptPolicy = {
  prefix: "auth-fail:login:",
  maxFailures: 10,
  windowSeconds: 15 * 60,
};

export const TWO_FACTOR_POLICY: AttemptPolicy = {
  prefix: "auth-fail:2fa:",
  maxFailures: 5,
  windowSeconds: 10 * 60,
};

export function createAttemptLimiter(
  store: AttemptStore,
  policy: AttemptPolicy,
  onError: (err: unknown) => void = () => undefined,
) {
  const keyFor = (subject: string) => `${policy.prefix}${subject.trim().toLowerCase()}`;
  return {
    async isLocked(subject: string): Promise<boolean> {
      try {
        const raw = await store.get(keyFor(subject));
        return raw !== null && Number(raw) >= policy.maxFailures;
      } catch (err) {
        onError(err);
        return false;
      }
    },
    async recordFailure(subject: string): Promise<number> {
      try {
        const key = keyFor(subject);
        const count = await store.incr(key);
        if (count === 1) await store.expire(key, policy.windowSeconds);
        return count;
      } catch (err) {
        onError(err);
        return 0;
      }
    },
    async clear(subject: string): Promise<void> {
      try {
        await store.del(keyFor(subject));
      } catch (err) {
        onError(err);
      }
    },
  };
}
