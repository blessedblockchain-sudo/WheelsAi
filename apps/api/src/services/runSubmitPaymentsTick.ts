/**
 * Scan-and-dispatch driver for the submit-payment BullMQ worker —
 * claim-first protocol (remediation D3) + per-row recipient resolution
 * (remediation D5).
 *
 * Each tick runs two phases:
 *
 * PHASE 0 — RECOVERY of SUBMITTING rows (claimed by a previous tick that
 * crashed between claim/broadcast/transition, or by an overlapping
 * replica). For each SUBMITTING row, with the chain head fetched ONCE
 * up-front (so the expiry proof below is sound):
 *   - signature landed (any confirmation status) → SUBMITTING→SUBMITTED;
 *     the confirmation poller takes it from there.
 *   - unseen AND currentBlockHeight ≤ lastValidBlockHeight → re-broadcast
 *     the STORED signedTxB64 verbatim. Same bytes ⇒ same signature ⇒ the
 *     cluster dedupes; this can never double-spend. On send-success →
 *     SUBMITTING→SUBMITTED; on send-failure → leave SUBMITTING (next
 *     tick's recovery retries).
 *   - unseen AND currentBlockHeight > lastValidBlockHeight → the tx is
 *     PROVABLY dead (status was queried with searchTransactionHistory
 *     AFTER the expiry bound passed) → SUBMITTING→PENDING with the claim
 *     fields cleared; re-signing is now safe.
 *   - any RPC error → leave the row untouched (never invent a transition
 *     from silence — the poller's discipline).
 *
 * PHASE 1 — SUBMIT of due PENDING rows. Per-row sequence:
 *   1. resolveRecipient(nosanaJobId)  → Nosana host pubkey. A failure here
 *      is contained to the row (D5): resolutionAttempts is incremented and
 *      the row STAYS PENDING so the next tick retries ("no host yet" and
 *      RPC blips are transient). FAILED is terminal in this pipeline — no
 *      worker re-PENDINGs FAILED rows — so failing terminally on a
 *      transient would drop a legitimate payment. After the
 *      MAX_RESOLUTION_ATTEMPTS-th failure the row is PARKED (terminal
 *      until an operator intervenes) so a poison job (e.g. deleted Nosana
 *      job) can't churn forever.
 *   2. prepare(row, recipient)        → build + SIGN, NO broadcast. A throw
 *      (authority_mismatch, blockhash_unavailable, missing mint …) →
 *      PENDING→FAILED for that row; the tick continues.
 *   3. claim(id, artifact)            → compare-and-set PENDING→SUBMITTING
 *      persisting {txSignature, lastValidBlockHeight, signedTxB64}. false
 *      (count 0) ⇒ another worker claimed the row — benign, skip it.
 *   4. broadcast(artifact.signedTxB64). A throw LEAVES the row SUBMITTING —
 *      recovery owns it. Never flip back to PENDING here: the send may
 *      have reached the cluster despite the error, and re-signing is
 *      exactly what creates double-spends.
 *   5. persistTransition "submitted"  → SUBMITTING→SUBMITTED + submittedAt.
 *
 * One bad row cannot kill the tick — every per-row failure mode above is
 * caught and converted into a per-row transition (or a benign skip).
 *
 * DB-write failures (claim / persistTransition / persistRecoveryTransition
 * throwing) are NOT swallowed: the tick throws so BullMQ retries. Under
 * claim-first this is safe — a row left SUBMITTING is settled by the next
 * recovery scan from on-chain evidence, and a row left PENDING was never
 * broadcast.
 *
 * Concurrency: BullMQ worker runs concurrency=1 per process, but
 * production runs ≥2 replicas — the claim CAS (step 3) is what guarantees
 * at most one broadcastable artifact ever exists per payment.
 */

/** Resolution failures before a PENDING row is PARKED (D5). */
export const MAX_RESOLUTION_ATTEMPTS = 5;

export interface PendingPaymentRow {
  id: string;
  treasuryId: string;
  treasuryAddress: string;
  /** Nosana job whose host gets paid — resolved per row in this tick. */
  nosanaJobId: string;
  amountLamports: bigint;
  /** Dual-mode discriminator: when true, the row routes through the
   * agent-treasury Anchor program (pay_nosana ix); when false, it
   * routes through the legacy SystemProgram.transfer path. The
   * dep-builder honors this; this driver doesn't care which mode
   * — the cardinality of the .prepare() call shape is identical. */
  programInitialized: boolean;
  /** SPL mint owning the treasury PDA. Required when programInitialized
   * is true (used as a PDA seed); ignored otherwise. */
  mintAddress: string | null;
  /** Recipient-resolution failures so far (drives PARKED threshold). */
  resolutionAttempts: number;
}

/** A row claimed by a previous tick: signed, possibly broadcast, not yet
 * transitioned to SUBMITTED. Owned by the recovery phase. */
export interface SubmittingPaymentRow {
  id: string;
  txSignature: string;
  /** Null only on schema-inconsistent rows (claim always writes it);
   * treated as "expiry unprovable" → re-broadcast, never re-sign. */
  lastValidBlockHeight: bigint | null;
  signedTxB64: string;
}

/** Sign-only output of prepare(); persisted verbatim by the claim. */
export interface SignedPaymentArtifact {
  txSignature: string;
  lastValidBlockHeight: bigint;
  signedTxB64: string;
}

export type PaymentTransition =
  | { type: "submitted"; txSignature: string }
  | { type: "failed"; errorMessage: string }
  | { type: "resolution_failed"; errorMessage: string }
  | { type: "parked"; errorMessage: string };

export type RecoveryTransition =
  | { type: "landed" }
  | { type: "rebroadcast" }
  | { type: "expired" };

export interface SubmitPaymentsTickInput {
  now: Date;
}

export interface SubmitPaymentsTickDeps {
  // ---- phase 0: recovery ----
  loadSubmittingBatch: (args: {
    now: Date;
  }) => Promise<SubmittingPaymentRow[]>;
  /** Chain head height ("confirmed"). Throw = RPC unreachable. */
  getCurrentBlockHeight: () => Promise<bigint>;
  /** getSignatureStatuses([sig], {searchTransactionHistory:true}) —
   * true when the cluster has seen the signature in ANY status. */
  hasSignatureLanded: (txSignature: string) => Promise<boolean>;
  /** sendRawTransaction over the stored bytes. Shared by phase 1. */
  broadcast: (signedTxB64: string) => Promise<void>;
  persistRecoveryTransition: (
    id: string,
    transition: RecoveryTransition,
  ) => Promise<void>;

  // ---- phase 1: submit ----
  loadPendingBatch: (args: {
    now: Date;
  }) => Promise<PendingPaymentRow[]>;
  /** Nosana job → host pubkey. Throws on not-found / no-host-yet / RPC. */
  resolveRecipient: (nosanaJobId: string) => Promise<string>;
  /** Build + sign WITHOUT broadcasting. Throws on any prepare failure. */
  prepare: (
    row: PendingPaymentRow,
    recipientAddress: string,
  ) => Promise<SignedPaymentArtifact>;
  /** CAS PENDING→SUBMITTING persisting the artifact. false = lost race. */
  claim: (id: string, artifact: SignedPaymentArtifact) => Promise<boolean>;
  persistTransition: (
    id: string,
    transition: PaymentTransition,
  ) => Promise<void>;
}

export interface SubmitPaymentsTickResult {
  /** SUBMITTING rows settled by recovery (landed/rebroadcast/expired). */
  recovered: number;
  /** Rows that reached SUBMITTED through the full claim-first sequence. */
  submitted: number;
  /** Terminal PENDING→FAILED transitions (prepare failures). */
  failed: number;
  /** Resolution failures left PENDING for retry (attempts incremented). */
  deferred: number;
  /** Rows PARKED after exhausting resolution attempts. */
  parked: number;
  /** Benign skips: lost claim races + broadcast errors left SUBMITTING +
   * recovery rows left untouched on RPC silence. */
  skipped: number;
}

function errMessage(err: unknown): string {
  return (err as Error).message ?? String(err);
}

export async function runSubmitPaymentsTick(
  input: SubmitPaymentsTickInput,
  deps: SubmitPaymentsTickDeps,
): Promise<SubmitPaymentsTickResult> {
  const result: SubmitPaymentsTickResult = {
    recovered: 0,
    submitted: 0,
    failed: 0,
    deferred: 0,
    parked: 0,
    skipped: 0,
  };

  // ---------- phase 0: recovery ----------
  const submittingRows = await deps.loadSubmittingBatch({ now: input.now });

  // Fetch the head height BEFORE any signature-status query: "unseen at a
  // height past lastValidBlockHeight" is only a proof of death when the
  // status check happens after the expiry bound passed.
  let currentBlockHeight: bigint | null = null;
  if (submittingRows.length > 0) {
    try {
      currentBlockHeight = await deps.getCurrentBlockHeight();
    } catch {
      currentBlockHeight = null; // RPC silence — expiry is unprovable this tick
    }
  }

  for (const row of submittingRows) {
    let landed: boolean;
    try {
      landed = await deps.hasSignatureLanded(row.txSignature);
    } catch {
      result.skipped += 1; // RPC silence — leave untouched
      continue;
    }

    if (landed) {
      await deps.persistRecoveryTransition(row.id, { type: "landed" });
      result.recovered += 1;
      continue;
    }

    const expired =
      currentBlockHeight !== null &&
      row.lastValidBlockHeight !== null &&
      currentBlockHeight > row.lastValidBlockHeight;

    if (expired) {
      // Provably dead: unseen after the expiry bound. Re-signing is safe.
      await deps.persistRecoveryTransition(row.id, { type: "expired" });
      result.recovered += 1;
      continue;
    }

    if (currentBlockHeight === null) {
      result.skipped += 1; // can't prove anything without the head height
      continue;
    }

    // Still inside the validity window (or bound unknown on the row):
    // re-broadcast the SAME bytes. Same signature ⇒ idempotent.
    try {
      await deps.broadcast(row.signedTxB64);
    } catch {
      result.skipped += 1; // leave SUBMITTING; next recovery retries
      continue;
    }
    await deps.persistRecoveryTransition(row.id, { type: "rebroadcast" });
    result.recovered += 1;
  }

  // ---------- phase 1: submit ----------
  const rows = await deps.loadPendingBatch({ now: input.now });

  for (const row of rows) {
    // 1. resolve recipient — contained per row (D5).
    let recipientAddress: string;
    try {
      recipientAddress = await deps.resolveRecipient(row.nosanaJobId);
    } catch (err) {
      const attempts = row.resolutionAttempts + 1;
      if (attempts >= MAX_RESOLUTION_ATTEMPTS) {
        await deps.persistTransition(row.id, {
          type: "parked",
          errorMessage: errMessage(err),
        });
        result.parked += 1;
      } else {
        await deps.persistTransition(row.id, {
          type: "resolution_failed",
          errorMessage: errMessage(err),
        });
        result.deferred += 1;
      }
      continue;
    }

    // 2. build + sign (no broadcast).
    let artifact: SignedPaymentArtifact;
    try {
      artifact = await deps.prepare(row, recipientAddress);
    } catch (err) {
      await deps.persistTransition(row.id, {
        type: "failed",
        errorMessage: errMessage(err),
      });
      result.failed += 1;
      continue;
    }

    // 3. claim BEFORE broadcast.
    const claimed = await deps.claim(row.id, artifact);
    if (!claimed) {
      result.skipped += 1; // another worker owns the row — benign
      continue;
    }

    // 4. broadcast the persisted bytes.
    try {
      await deps.broadcast(artifact.signedTxB64);
    } catch {
      // Leave SUBMITTING — the send may have reached the cluster anyway.
      // Recovery settles it from on-chain evidence next tick.
      result.skipped += 1;
      continue;
    }

    // 5. SUBMITTING → SUBMITTED.
    await deps.persistTransition(row.id, {
      type: "submitted",
      txSignature: artifact.txSignature,
    });
    result.submitted += 1;
  }

  return result;
}
