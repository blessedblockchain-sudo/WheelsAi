import { WheelsAIError, type AgentDeployment } from "@wheelsai/sdk";

export type PollOutcome = "running" | "failed" | "stopped" | "timeout";

export interface PollEvent {
  status: string;
  /** The status seen on the previous poll; null on the first. */
  previous: string | null;
  elapsedMs: number;
  deployment: AgentDeployment;
}

export interface PollOptions {
  fetchDeployment: () => Promise<AgentDeployment>;
  timeoutMs: number;
  /** The steady time between polls. */
  intervalMs: number;
  /**
   * The wait before the second poll; it doubles after each poll until it reaches
   * `intervalMs`, so early changes show quickly without polling fast for the whole wait.
   * Defaults to `intervalMs` (a fixed interval).
   */
  initialIntervalMs?: number;
  /** A status the caller already knows (from the deploy response), so the first poll is not reported as a change. */
  knownStatus?: string;
  /** Called when the status differs from the previous poll. */
  onTransition?: (event: PollEvent) => void;
  /** Called after every successful poll. */
  onPoll?: (event: PollEvent) => void;
  /** Called when a poll fails transiently and will be retried. */
  onRetry?: (error: Error, attempt: number) => void;
  /** Consecutive transient poll failures tolerated before giving up. Default: no limit, the timeout ends the wait. */
  maxConsecutiveErrors?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PollResult {
  outcome: PollOutcome;
  /** The last deployment the API returned; null only if every poll failed. */
  deployment: AgentDeployment | null;
  elapsedMs: number;
  /** On a timeout: the error of the final poll, when status checks were failing at the end. */
  lastError?: Error;
}

const TERMINAL: Record<string, PollOutcome> = {
  running: "running",
  failed: "failed",
  stopped: "stopped",
};

/** 429s that are a spent quota, not the rate limiter: asking again cannot succeed. */
const QUOTA_CODES = new Set(["plan_limit_reached", "deployment_quota_exceeded"]);

/**
 * A request the API refused for a reason that retrying will not change. A 408 and a
 * rate-limit 429 pass with time; a 429 for a used-up quota does not.
 */
export function isFatal(error: unknown): boolean {
  if (!(error instanceof WheelsAIError)) return false;
  if (error.status === 408) return false;
  if (error.status === 429) return QUOTA_CODES.has(error.code ?? "");
  return error.status >= 400 && error.status < 500;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll an agent deployment until it is running, failed or stopped, or the
 * timeout passes. Only statuses the API reports are ever surfaced. Network
 * trouble, a 5xx or the rate limiter do not end the wait (the timeout does); a
 * refusal that will not change (bad credentials, a deleted deployment, a spent
 * quota) does.
 */
export async function waitForDeployment(options: PollOptions): Promise<PollResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxErrors = options.maxConsecutiveErrors ?? Number.POSITIVE_INFINITY;
  const started = now();

  let previous: string | null = options.knownStatus ?? null;
  let last: AgentDeployment | null = null;
  let consecutiveErrors = 0;
  let lastError: Error | undefined;
  let delay = Math.min(options.initialIntervalMs ?? options.intervalMs, options.intervalMs);

  for (;;) {
    try {
      const deployment = await options.fetchDeployment();
      consecutiveErrors = 0;
      lastError = undefined;
      last = deployment;
      const event: PollEvent = {
        status: deployment.status,
        previous,
        elapsedMs: now() - started,
        deployment,
      };
      if (deployment.status !== previous) options.onTransition?.(event);
      options.onPoll?.(event);
      previous = deployment.status;

      const outcome = TERMINAL[deployment.status];
      if (outcome) return { outcome, deployment, elapsedMs: now() - started };
    } catch (error) {
      if (isFatal(error)) throw error;
      consecutiveErrors += 1;
      if (consecutiveErrors > maxErrors) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      options.onRetry?.(lastError, consecutiveErrors);
    }

    const elapsed = now() - started;
    if (elapsed >= options.timeoutMs) {
      return { outcome: "timeout", deployment: last, elapsedMs: elapsed, ...(lastError && { lastError }) };
    }
    await sleep(Math.min(delay, options.timeoutMs - elapsed));
    delay = Math.min(delay * 2, options.intervalMs);
  }
}
