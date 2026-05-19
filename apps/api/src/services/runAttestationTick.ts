/**
 * Scan-and-dispatch driver for the reputation-attestation BullMQ worker
 * (plan A4).
 *
 * Each tick:
 *   1. loadAgents(now)                  → eligible-to-attest rows
 *      (each row has cursor + period bounds)
 *   2. aggregate(row)                   → delta uptime + messages + score
 *   3. submit(row, aggregate, now)      → on-chain submit_attestation
 *   4. on success: persistCursor(...)   → cursor + OnChainAttestation mirror
 *      (a single DB transaction so cursor and mirror move together)
 *   5. counts { attested, failed, skipped } returned
 *
 * Skipped: rows where the aggregate computes to zero deltas — no point
 * spending a tx fee to record "nothing happened". The cursor still
 * doesn't advance (next tick may include them if work appears).
 *
 * Failure handling mirrors fee-router:
 *   - submit failures: counted; cursor NOT advanced; retry on next tick
 *   - persistCursor failures (post-submit): THROWN; BullMQ retries the
 *     whole tick. KNOWN RISK: in this rare race, the chain has already
 *     advanced for this period, and the next tick may re-submit. The
 *     on-chain program permits equal unix_ts (multi-attestor support),
 *     so duplicates would double-count cumulative state. Production
 *     hardening: two-phase commit (insert mirror row with txSignature
 *     BEFORE submit, fill the sig after; on retry, dedupe via
 *     getSignatureStatuses). Deferred until the worker is enabled.
 */

export interface AttestableAgentRow {
  /** AgentToken row id (Prisma uuid). */
  tokenId: string;
  mintAddress: string;
  /** When the worker last successfully attested for this agent.
   * Used as the lower bound of the usage-record window. Null = first run. */
  lastOnChainAttestationAt: Date | null;
}

export interface AttestationAggregate {
  uptimeSecondsDelta: bigint;
  messageCountDelta: bigint;
  /** Score in 0..=100. The program rejects anything else. */
  score: number;
  /** Inclusive upper bound of the aggregation window — becomes the
   * cursor advance target AND the on-chain unix_ts. */
  periodEnd: Date;
}

export type AttestationSubmitOutcome =
  | {
      ok: true;
      txSignature: string;
      /** Cumulative values to record in the mirror, in the same shape as
       * the AttestationSubmitted event payload. */
      cumulativeUptimeSeconds: bigint;
      cumulativeMessageCount: bigint;
      attestationCount: number;
    }
  | { ok: false; error: string };

export interface AttestationTickInput {
  now: Date;
}

export interface AttestationTickDeps {
  loadAgents: (args: { now: Date }) => Promise<AttestableAgentRow[]>;
  aggregate: (
    row: AttestableAgentRow,
    args: { now: Date },
  ) => Promise<AttestationAggregate | null>;
  submit: (
    row: AttestableAgentRow,
    aggregate: AttestationAggregate,
  ) => Promise<AttestationSubmitOutcome>;
  /** Atomic in Prisma: advances lastOnChainAttestationAt AND inserts an
   * OnChainAttestation mirror row, in a single transaction. */
  persistCursor: (
    row: AttestableAgentRow,
    aggregate: AttestationAggregate,
    outcome: Extract<AttestationSubmitOutcome, { ok: true }>,
    attestorAddress: string,
  ) => Promise<void>;
  attestorAddress: string;
}

export interface AttestationTickResult {
  attested: number;
  failed: number;
  /** Rows where aggregate(...) returned null or zero deltas. */
  skipped: number;
}

export async function runAttestationTick(
  input: AttestationTickInput,
  deps: AttestationTickDeps,
): Promise<AttestationTickResult> {
  const rows = await deps.loadAgents({ now: input.now });
  let attested = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const aggregate = await deps.aggregate(row, { now: input.now });
    if (
      !aggregate ||
      (aggregate.uptimeSecondsDelta === BigInt(0) &&
        aggregate.messageCountDelta === BigInt(0))
    ) {
      skipped += 1;
      continue;
    }

    let outcome: AttestationSubmitOutcome;
    try {
      outcome = await deps.submit(row, aggregate);
    } catch (err) {
      outcome = { ok: false, error: (err as Error).message ?? String(err) };
    }

    if (!outcome.ok) {
      failed += 1;
      continue;
    }

    // submit succeeded → MUST advance cursor + write mirror or the next
    // tick may double-submit. Throw propagates; BullMQ retries.
    await deps.persistCursor(row, aggregate, outcome, deps.attestorAddress);
    attested += 1;
  }

  return { attested, failed, skipped };
}
