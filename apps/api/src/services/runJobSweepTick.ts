/**
 * The job sweeper's tick (Offerings and Jobs). Everything a job needs that
 * no request or worker is guaranteed to do:
 *
 *   expire      funded|running past deadlineAt        -> expired   REFUND
 *   complete    submitted past reviewDeadlineAt       -> completed SETTLE
 *               (the buyer had their window; silence is acceptance)
 *   re-queue    funded, hired a while ago, never started: its queue entry
 *               was lost (Redis was down at hire) or failed before the claim
 *   take over   running with a lapsed lease, still before the deadline:
 *               its worker died; another one claims it (reclaimJob)
 *
 * The escrow core decides each transition by compare-and-set, with the
 * deadline in the comparison, so this tick can race a worker, a buyer or
 * another tick and each job is still refunded or settled exactly once. A
 * job that lost its race here (JobTransitionError) was handled by whoever
 * won; it is not an error.
 *
 * Batched, never revisiting a row within a tick, one failure never stops
 * the batch.
 *
 * Pure: every IO surface is injected.
 */

import {
  completeJob,
  endJobWithRefund,
  JobSettlementError,
  JobTransitionError,
  type EscrowTx,
} from "./jobEscrow.js";
import { FAILURE } from "./jobRunner.js";

export type SweepKind = "expired" | "reviewLapsed" | "staleFunded" | "lapsedLease";

export interface SweepRow {
  id: string;
  publisherId: string;
}

export interface JobSweepDeps {
  load(args: {
    kind: SweepKind;
    now: Date;
    /** staleFunded only: jobs funded at or before this. */
    fundedBefore: Date;
    limit: number;
    excludeIds: string[];
  }): Promise<SweepRow[]>;
  inTransaction<T>(fn: (tx: EscrowTx) => Promise<T>): Promise<T>;
  /** Puts the job back on the runner's queue. Throws when the queue is down. */
  enqueue(jobId: string): Promise<void>;
  /** Creates the publisher's payout profile when it is missing. */
  ensurePublisherProfile(publisherId: string): Promise<void>;
  /** After a settle: reputation and the like. Must not throw. */
  afterSettle(row: SweepRow): Promise<void>;
  /** Must not throw. */
  notify(event: "job.expired" | "job.completed", jobId: string): Promise<void>;
  now?: () => Date;
}

export interface JobSweepResult {
  scanned: number;
  expired: number;
  completed: number;
  requeued: number;
  reclaimed: number;
  /** Lost to a concurrent transition; already handled elsewhere. */
  superseded: number;
  errors: number;
}

export interface JobSweepOptions {
  batchSize?: number;
  maxBatches?: number;
  /** How long a job may sit funded before its queue entry is presumed lost. */
  staleFundedMs?: number;
}

export const DEFAULT_STALE_FUNDED_MS = 120_000;

export async function runJobSweepTick(deps: JobSweepDeps, opts: JobSweepOptions = {}): Promise<JobSweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: JobSweepResult = {
    scanned: 0,
    expired: 0,
    completed: 0,
    requeued: 0,
    reclaimed: 0,
    superseded: 0,
    errors: 0,
  };
  const fundedBefore = new Date(now.getTime() - (opts.staleFundedMs ?? DEFAULT_STALE_FUNDED_MS));

  const settle = async (row: SweepRow) => {
    const complete = () => deps.inTransaction((tx) => completeJob(tx, { jobId: row.id, auto: true, now }));
    try {
      await complete();
    } catch (err) {
      if (!(err instanceof JobSettlementError)) throw err;
      // The settle rolled back and the escrow is still held. Without a
      // profile to accrue into it would fail the same way on every tick.
      await deps.ensurePublisherProfile(row.publisherId);
      await complete();
    }
    await deps.afterSettle(row);
    await deps.notify("job.completed", row.id);
  };

  const handlers: Record<SweepKind, (row: SweepRow) => Promise<keyof JobSweepResult>> = {
    expired: async (row) => {
      await deps.inTransaction((tx) =>
        endJobWithRefund(tx, { jobId: row.id, to: "expired", reason: FAILURE.expired, now }),
      );
      await deps.notify("job.expired", row.id);
      return "expired";
    },
    reviewLapsed: async (row) => {
      await settle(row);
      return "completed";
    },
    staleFunded: async (row) => {
      await deps.enqueue(row.id);
      return "requeued";
    },
    // The worker makes the claim (reclaimJob); here the job is only handed
    // to one.
    lapsedLease: async (row) => {
      await deps.enqueue(row.id);
      return "reclaimed";
    },
  };

  // Expiry first: a job past its deadline must not be re-queued or taken over.
  for (const kind of ["expired", "reviewLapsed", "staleFunded", "lapsedLease"] as const) {
    const handled: string[] = [];
    for (let batch = 0; batch < (opts.maxBatches ?? 10); batch++) {
      const rows = await deps.load({
        kind,
        now,
        fundedBefore,
        limit: opts.batchSize ?? 100,
        excludeIds: handled,
      });
      if (rows.length === 0) break;
      result.scanned += rows.length;
      for (const row of rows) {
        handled.push(row.id);
        try {
          result[await handlers[kind](row)]++;
        } catch (err) {
          if (err instanceof JobTransitionError) result.superseded++;
          else result.errors++;
        }
      }
    }
  }
  return result;
}
