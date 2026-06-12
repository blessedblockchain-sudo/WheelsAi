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
 *   - getJobStatus throws → rethrow (RPC outage)
 *   - getJobStatus → null → throw "not found"
 *   - nodePubkey missing/empty → throw "no host yet"  (job is queued; retry next tick)
 *
 * Containment (remediation D5): resolution is invoked PER ROW by
 * runSubmitPaymentsTick — never inside the batch loader — so a throw
 * here is contained to its own payment. The driver catches it, leaves
 * the row PENDING with resolutionAttempts incremented (transient
 * failures like "no host yet" or RPC blips simply retry next tick),
 * and PARKs the row after MAX_RESOLUTION_ATTEMPTS so a poison job
 * (e.g. a deleted Nosana job) can't occupy the queue forever. Every
 * other row in the batch still submits in the same tick.
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
