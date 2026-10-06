/**
 * In-flight runs that hold a charge, and how they end when the process does.
 *
 * A metered graph run debits the buyer BEFORE it starts and settles or
 * refunds when it ends. A run may legitimately take minutes; a deploy gives
 * the process seconds. Without this, SIGTERM waited on the run, the platform
 * SIGKILLed the process, and the charge stayed `pending` forever with the
 * buyer debited and nothing delivered.
 *
 * So every such run registers here, and shutdown cancels them FIRST: each
 * one comes back failed through its normal path, which refunds the charge
 * and closes its execution row. Once shutdown has begun no new run is
 * admitted - it would only be charged and then cancelled.
 */

export class ServerShuttingDownError extends Error {
  constructor() {
    super("the server is restarting; nothing was charged - retry in a moment");
    this.name = "ServerShuttingDownError";
  }
}

export interface RunSlot {
  /** Aborts when shutdown cancels the run. */
  signal: AbortSignal;
  /** The run has settled or refunded and recorded itself. Idempotent. */
  done(): void;
}

export interface InFlightRuns {
  /** null once shutdown has begun: refuse the run before charging for it. */
  begin(): RunSlot | null;
  /**
   * Stops admitting runs, cancels every in-flight one and waits (at most
   * `timeoutMs`) for them to finish settling. `unfinished` runs were still
   * settling at the deadline.
   */
  cancelAll(timeoutMs: number): Promise<{ cancelled: number; unfinished: number }>;
  readonly size: number;
}

export function createInFlightRuns(): InFlightRuns {
  const slots = new Map<AbortController, { finished: Promise<void> }>();
  let closed = false;

  return {
    get size() {
      return slots.size;
    },

    begin() {
      if (closed) return null;
      const controller = new AbortController();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      slots.set(controller, { finished });
      return {
        signal: controller.signal,
        done: () => {
          slots.delete(controller);
          finish();
        },
      };
    },

    async cancelAll(timeoutMs) {
      closed = true;
      const running = [...slots.entries()];
      for (const [controller] of running) controller.abort();

      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(running.map(([, slot]) => slot.finished)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      return { cancelled: running.length, unfinished: slots.size };
    },
  };
}
