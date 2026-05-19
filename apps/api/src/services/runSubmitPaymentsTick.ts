/**
 * Scan-and-dispatch driver for the submit-payment BullMQ worker.
 *
 * Each tick:
 *   1. loadPendingBatch(now)            → rows due for submission
 *   2. for each row, submit(row)        → ok+sig OR err payload
 *   3. persistTransition(id, transition) → DB lifecycle write
 *   4. counts {submitted, failed} returned
 *
 * Concurrency: BullMQ worker runs concurrency=1 (mirrored from
 * token-indexer); single-process safe. The status filter on the
 * loader plus the persistTransition write are sufficient — no
 * row-level lock required.
 *
 * Per-row failure isolation: a thrown submit is caught and turned
 * into a FAILED transition. One bad row cannot kill the tick — the
 * next row still runs.
 *
 * Per-row persistence failures are NOT swallowed: if the DB write
 * fails after a successful submit, we cannot leave half-done state
 * where the sig is on-chain but the row reads PENDING. The whole
 * tick throws so BullMQ retries; the next tick's loader will
 * surface the same row and we'll re-poll authoritative on-chain
 * status from there.
 */

export interface PendingPaymentRow {
  id: string;
  treasuryId: string;
  treasuryAddress: string;
  recipientAddress: string;
  amountLamports: bigint;
  /** Dual-mode discriminator: when true, the row routes through the
   * agent-treasury Anchor program (pay_nosana ix); when false, it
   * routes through the legacy SystemProgram.transfer path. The
   * dep-builder honors this; this driver doesn't care which mode
   * — the cardinality of the .submit() call shape is identical. */
  programInitialized: boolean;
  /** SPL mint owning the treasury PDA. Required when programInitialized
   * is true (used as a PDA seed); ignored otherwise. */
  mintAddress: string | null;
}

export type SubmitPaymentOutcome =
  | { ok: true; txSignature: string }
  | { ok: false; error: string };

export type PaymentTransition =
  | { type: "submitted"; txSignature: string }
  | { type: "failed"; errorMessage: string };

export interface SubmitPaymentsTickInput {
  now: Date;
}

export interface SubmitPaymentsTickDeps {
  loadPendingBatch: (args: {
    now: Date;
  }) => Promise<PendingPaymentRow[]>;
  submit: (row: PendingPaymentRow) => Promise<SubmitPaymentOutcome>;
  persistTransition: (
    id: string,
    transition: PaymentTransition,
  ) => Promise<void>;
}

export interface SubmitPaymentsTickResult {
  submitted: number;
  failed: number;
}

export async function runSubmitPaymentsTick(
  input: SubmitPaymentsTickInput,
  deps: SubmitPaymentsTickDeps,
): Promise<SubmitPaymentsTickResult> {
  const rows = await deps.loadPendingBatch({ now: input.now });
  let submitted = 0;
  let failed = 0;

  for (const row of rows) {
    let transition: PaymentTransition;
    try {
      const outcome = await deps.submit(row);
      if (outcome.ok) {
        transition = { type: "submitted", txSignature: outcome.txSignature };
      } else {
        transition = { type: "failed", errorMessage: outcome.error };
      }
    } catch (err) {
      transition = {
        type: "failed",
        errorMessage: (err as Error).message ?? String(err),
      };
    }

    await deps.persistTransition(row.id, transition);

    if (transition.type === "submitted") submitted += 1;
    else failed += 1;
  }

  return { submitted, failed };
}
