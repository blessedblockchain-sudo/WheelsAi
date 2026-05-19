/**
 * Adapter that turns a Nosana job ID into the host pubkey to pay.
 *
 * Used by the payment-submit BullMQ worker: each PENDING ComputePayment
 * row carries a nosanaJobId; the submit pipeline needs the
 * recipientAddress for the SOL transfer. That lookup is one Nosana SDK
 * call — wrapping it in a tiny adapter keeps the dep-builder focused
 * on wiring rather than SDK plumbing, and makes the various failure
 * modes (queued job, missing job, RPC error, blank pubkey) explicit
 * and testable.
 *
 * Failure mode policy:
 *   - getJobStatus throws → rethrow (RPC outage; submit driver records FAILED)
 *   - getJobStatus → null → throw "not found"
 *   - nodePubkey missing/empty → throw "no host yet"  (job is queued; retry next tick)
 *
 * Caller (runSubmitPaymentsTick) catches these into the per-row {ok:false}
 * branch which marks the row FAILED with errorMessage. Because the tick
 * is repeatable and rows that fail are not retried automatically by this
 * worker (they need explicit re-PENDING via lifecycle.shouldRetry), the
 * "queued job" case currently puts a row into FAILED rather than holding.
 * That's acceptable for now — a payment whose job hasn't started yet
 * shouldn't even be PENDING; the upstream settlement cycle is what
 * decides scheduling, and it would only emit a row for a job that's
 * already produced compute time.
 */

import type { NosanaJob } from "./nosana.js";

export interface ResolveNosanaRecipientDeps {
  getJobStatus: (jobId: string) => Promise<NosanaJob | null>;
}

export async function resolveNosanaRecipient(
  jobId: string,
  deps: ResolveNosanaRecipientDeps,
): Promise<string> {
  const job = await deps.getJobStatus(jobId);
  if (!job) {
    throw new Error(`Nosana job not found: ${jobId}`);
  }
  if (!job.nodePubkey || job.nodePubkey.length === 0) {
    throw new Error(
      `Nosana job ${jobId} has no host yet (nodePubkey unassigned; job state=${job.status})`,
    );
  }
  return job.nodePubkey;
}

export function makeNosanaRecipientResolver(
  deps: ResolveNosanaRecipientDeps,
): (jobId: string) => Promise<string> {
  return (jobId) => resolveNosanaRecipient(jobId, deps);
}
