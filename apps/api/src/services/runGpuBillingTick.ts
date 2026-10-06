/**
 * GPU billing tick: one call = one tick of the BullMQ gpu-billing worker.
 *
 * For every RUNNING model deployment it charges the org for the GPU time since
 * the deployment's billing cursor (see services/gpuBilling.ts for the money
 * mechanics). Pure orchestration; every IO surface is dependency-injected, so
 * the tick holds no state and a restart just picks the cursors back up.
 *
 * Per row:
 *   - no cursor yet (a row that was already running when billing was deployed):
 *     initialise it to `now` by CAS. Nothing is charged for time before
 *     billing existed.
 *   - otherwise chargeWindow (CAS cursor -> conditional decrement -> ledger):
 *       charged               -> optionally top the Nosana vault up so the next
 *                                job extension stays funded
 *       nothing_to_bill       -> sub-cent window; the cursor stays put and the
 *                                time rolls into the next window
 *       cursor_lost           -> a concurrent ticker/stopper billed it; skip
 *       insufficient_credits  -> the org cannot pay: STOP the deployment on
 *                                Nosana first (the platform pays for every
 *                                second it keeps running), then mark it
 *                                `stopped` with reason "insufficient_credits"
 *                                and release the admission reservation
 *
 * Failure isolation: one row throwing never stops the others, and a failed
 * Nosana stop leaves the row `running` so the next tick retries it.
 */

export interface GpuBillingRow {
  id: string;
  orgId: string;
  gpuTier: string;
  replicas: number;
  status: string;
  /** Usage up to here has been billed; null = never (legacy running row). */
  billedThroughAt: Date | null;
  /** The Nosana Deployment-Manager id. */
  nosanaDeploymentId: string;
  /**
   * Deployment.runGeneration as loaded. The Nosana stop is slow; the row may be
   * stopped and restarted (a new run, running again) before it returns.
   */
  runGeneration: number;
  /**
   * When Nosana confirmed this run's GPUs stopped, if a stop already landed but
   * the row could not be finalised (Deployment.gpuStoppedAt). Nothing is billed
   * past it.
   */
  gpuStoppedAt?: Date | null;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
}

export type GpuChargeOutcome =
  | { kind: "charged"; cents: bigint; coveredSeconds: number }
  | { kind: "nothing_to_bill" }
  | { kind: "cursor_lost" }
  | { kind: "insufficient_credits"; requiredCents: bigint };

export interface GpuStopResult {
  reclaimed: boolean;
  /**
   * Nosana had already stopped the deployment before this call (an earlier
   * tick's stop whose finalisation failed, or Nosana's own doing). The GPUs
   * did not run until now, so this call's clock is not the end of the window.
   */
  alreadyStopped?: boolean;
}

export interface GpuBillingTickInput {
  now: Date;
}

export interface GpuBillingTickDeps {
  /** status = running model deployments that carry a Nosana deployment id. */
  loadRunningDeployments: () => Promise<GpuBillingRow[]>;
  /** CAS billedThroughAt null -> now; count=0 means a concurrent writer won. */
  initialiseCursor: (row: GpuBillingRow, now: Date) => Promise<{ count: number }>;
  /**
   * Bills one window in a single transaction. Reports business outcomes as
   * values (an unpayable window is `insufficient_credits`, not a throw); any
   * other failure throws.
   */
  chargeWindow: (row: GpuBillingRow, now: Date) => Promise<GpuChargeOutcome>;
  /** Stops the deployment on Nosana. THROWS if the stop did not take effect. */
  stopDeployment: (row: GpuBillingRow) => Promise<GpuStopResult>;
  /**
   * After a successful Nosana stop: CAS running -> stopped (reason
   * "insufficient_credits"), release the admission reservation, settle the
   * final window from what the org has left, drop the nodes.
   * `stopped: false` means a concurrent writer already moved the row (or
   * restarted it: the claim names the run and Nosana id that were stopped).
   */
  markStoppedForInsufficientCredits: (
    row: GpuBillingRow,
    stop: GpuStopResult,
  ) => Promise<{ stopped: boolean }>;
  /** Keeps a paid-for deployment's Nosana vault funded. Best effort. */
  ensureRunway?: (row: GpuBillingRow) => Promise<{ toppedUp: boolean }>;
}

export interface GpuBillingTickResult {
  scanned: number;
  charged: number;
  chargedCents: bigint;
  cursorsInitialised: number;
  nothingToBill: number;
  cursorLost: number;
  insufficientCredits: number;
  stoppedForCredits: number;
  stopFailed: number;
  runwayToppedUp: number;
  runwayFailed: number;
  failed: number;
}

export async function runGpuBillingTick(
  input: GpuBillingTickInput,
  deps: GpuBillingTickDeps,
): Promise<GpuBillingTickResult> {
  const rows = await deps.loadRunningDeployments();

  const result: GpuBillingTickResult = {
    scanned: rows.length,
    charged: 0,
    chargedCents: 0n,
    cursorsInitialised: 0,
    nothingToBill: 0,
    cursorLost: 0,
    insufficientCredits: 0,
    stoppedForCredits: 0,
    stopFailed: 0,
    runwayToppedUp: 0,
    runwayFailed: 0,
    failed: 0,
  };

  for (const row of rows) {
    try {
      if (row.billedThroughAt === null) {
        const { count } = await deps.initialiseCursor(row, input.now);
        if (count > 0) result.cursorsInitialised += 1;
        else result.cursorLost += 1;
        continue;
      }

      const outcome = await deps.chargeWindow(row, input.now);
      switch (outcome.kind) {
        case "charged": {
          result.charged += 1;
          result.chargedCents += outcome.cents;
          if (deps.ensureRunway) {
            try {
              const runway = await deps.ensureRunway(row);
              if (runway.toppedUp) result.runwayToppedUp += 1;
            } catch {
              // The org just paid; a failed refill is retried next tick and
              // must not fail the billing of this row.
              result.runwayFailed += 1;
            }
          }
          break;
        }
        case "nothing_to_bill":
          result.nothingToBill += 1;
          break;
        case "cursor_lost":
          result.cursorLost += 1;
          break;
        case "insufficient_credits": {
          result.insufficientCredits += 1;
          // Stop the GPU FIRST: until Nosana confirms, the platform is paying
          // for a deployment nobody is paying for.
          let stop: GpuStopResult;
          try {
            stop = await deps.stopDeployment(row);
          } catch {
            result.stopFailed += 1; // row stays `running`; retried next tick
            break;
          }
          // The stop time is taken inside the dep, AFTER the Nosana stop
          // returned - not `input.now`, which is when the tick started - and
          // recorded there, so a finalisation that fails here is retried
          // against the time the GPUs really stopped.
          const finalised = await deps.markStoppedForInsufficientCredits(row, stop);
          if (finalised.stopped) result.stoppedForCredits += 1;
          else result.cursorLost += 1; // a concurrent writer already moved it
          break;
        }
      }
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
