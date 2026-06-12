/**
 * Scan-and-dispatch driver for the fee-router BullMQ worker —
 * row-identity routing + confirmation discipline (remediation D6a).
 *
 * Fees are routed by ROW IDENTITY, not timestamp windows: unrouted
 * trades are `feeRoutingBatchId IS NULL`, so a late-arriving trade
 * (older timestamp, indexed after a batch already routed) simply joins
 * a later batch — the old `timestamp > lastFeeRoutedAt` watermark that
 * permanently leaked such trades is gone. `lastFeeRoutedAt` survives as
 * a display/ops value only.
 *
 * Each tick runs two phases:
 *
 * PHASE 0 — RECOVERY of stale batches (claimed/submitted by a previous
 * tick that crashed, or by an overlapping replica). Chain head fetched
 * ONCE up-front so the expiry proof is sound. Per batch:
 *   - status CLAIMED (older than the loader's grace window): nothing was
 *     ever signed, so nothing can land → FAIL the batch + un-stamp its
 *     trades (they rejoin the next batch). Always safe.
 *   - status SUBMITTED:
 *       · signature landed with err        → FAILED + un-stamp (the tx
 *         consumed its slot but the fee_receive ix did nothing)
 *       · landed confirmed/finalized       → CONFIRMED (fee durably routed)
 *       · landed but only 'processed'      → leave SUBMITTED; re-check
 *         next tick (never invent finality)
 *       · unseen AND head > lastValidBlockHeight → PROVABLY dead →
 *         FAILED + un-stamp; trades rejoin
 *       · unseen AND head ≤ bound → re-broadcast the STORED bytes
 *         verbatim (same signature ⇒ cluster dedupes ⇒ no double-pay);
 *         leave SUBMITTED for the next confirm pass
 *       · any RPC error → leave untouched (poller discipline: silence
 *         is not evidence)
 *
 * PHASE 1 — ROUTE unrouted trades, per treasury:
 *   1. claimBatch(row)  → ONE $transaction: create the FeeRoutingBatch
 *      (CLAIMED) + stamp the trades' feeRoutingBatchId via CAS updateMany.
 *      null = another worker raced us to some of the rows — benign, skip
 *      this treasury for the tick (the transaction rolled back).
 *   2. sign(row)        → build + SIGN only. A throw → FAIL the batch +
 *      un-stamp (nothing was broadcast; re-signing next tick is safe).
 *   3. markSubmitted    → CAS CLAIMED→SUBMITTED persisting {txSignature,
 *      lastValidBlockHeight, signedTxB64} BEFORE any broadcast. false ⇒
 *      a recovery scan on another replica failed our batch first — skip
 *      WITHOUT broadcasting (our artifact is orphaned by design).
 *   4. broadcast        → a throw LEAVES the batch SUBMITTED; recovery
 *      owns it (the send may have reached the cluster anyway).
 *   5. confirmSignature → best-effort same-tick poll (short injected
 *      timeout): confirmed → batch CONFIRMED + bump the display cursor;
 *      failed (landed with err) → FAILED + un-stamp; timeout → leave
 *      SUBMITTED for recovery.
 *
 * DB-write failures (claim/persist throwing) are NOT swallowed: the tick
 * throws so BullMQ retries. Under claim-first this is safe — any
 * half-state (stamped trades, SUBMITTED batch) is settled by the next
 * recovery scan from on-chain evidence; nothing is ever re-signed while
 * its signature could still land.
 *
 * Concurrency: BullMQ worker runs concurrency=1 per process, but
 * production runs ≥2 replicas — the claim CAS (step 1) plus the
 * CLAIMED→SUBMITTED CAS (step 3) guarantee at most one broadcastable
 * artifact ever exists per claimed trade set.
 */

import type {
  SignatureConfirmOutcome,
  SignatureStatusLite,
} from "./awaitSignatureConfirmation.js";

export interface UnroutedFeeRow {
  treasuryId: string;
  mintAddress: string;
  /** Identities of the trades this batch will claim — the routing
   * source of truth (row identity, not a timestamp window). */
  tradeIds: string[];
  feeAmountLamports: bigint;
  /** Timestamp of the latest trade in this row's aggregate. Display/ops
   * only post-D6a: bumps `lastFeeRoutedAt` after confirmation. */
  latestTradeTimestamp: Date;
}

/** A batch left CLAIMED/SUBMITTED by a previous tick (or a replica).
 * Owned by the recovery phase. */
export interface StaleFeeBatchRow {
  id: string;
  treasuryId: string;
  status: "CLAIMED" | "SUBMITTED";
  /** Non-null whenever status is SUBMITTED (the CAS writes all three
   * artifacts atomically; the loader excludes inconsistent rows). */
  txSignature: string | null;
  lastValidBlockHeight: bigint | null;
  signedTxB64: string | null;
}

/** Sign-only output of sign(); persisted verbatim by markSubmitted. */
export interface SignedFeeBatchArtifact {
  txSignature: string;
  lastValidBlockHeight: bigint;
  signedTxB64: string;
}

export interface FeeRouterTickInput {
  now: Date;
}

export interface FeeRouterTickDeps {
  // ---- phase 0: recovery ----
  loadStaleBatches: (args: { now: Date }) => Promise<StaleFeeBatchRow[]>;
  /** Chain head height ("confirmed"). Throw = RPC unreachable. */
  getCurrentBlockHeight: () => Promise<bigint>;
  /** getSignatureStatuses([sig], {searchTransactionHistory:true}). */
  getSignatureStatus: (
    txSignature: string,
  ) => Promise<SignatureStatusLite | null>;
  /** sendRawTransaction over stored/just-signed bytes. Shared by phase 1. */
  broadcast: (signedTxB64: string) => Promise<void>;
  /** CAS SUBMITTED→CONFIRMED. count 0 (already settled) is benign. */
  persistBatchConfirmed: (batchId: string) => Promise<void>;
  /** CAS {CLAIMED,SUBMITTED}→FAILED + un-stamp the batch's trades (one
   * $transaction) so they rejoin the next batch. */
  persistBatchFailed: (batchId: string) => Promise<void>;

  // ---- phase 1: route ----
  loadUnrouted: (args: { now: Date }) => Promise<UnroutedFeeRow[]>;
  /** ONE $transaction: create batch (CLAIMED) + stamp trades via CAS.
   * Returns the batch id, or null when the stamp count came up short
   * (another worker claimed some rows first — transaction rolled back). */
  claimBatch: (row: UnroutedFeeRow) => Promise<string | null>;
  /** Build + sign WITHOUT broadcasting. Throws on any prepare failure. */
  sign: (row: UnroutedFeeRow) => Promise<SignedFeeBatchArtifact>;
  /** CAS CLAIMED→SUBMITTED persisting the artifact. false = lost race. */
  markSubmitted: (
    batchId: string,
    artifact: SignedFeeBatchArtifact,
  ) => Promise<boolean>;
  /** Best-effort same-tick confirmation poll (short injected timeout). */
  confirmSignature: (txSignature: string) => Promise<SignatureConfirmOutcome>;
  /** Display/ops cursor bump (lastFeeRoutedAt) — NOT routing truth. */
  persistCursor: (treasuryId: string, cursor: Date) => Promise<void>;
}

export interface FeeRouterTickResult {
  /** Stale batches settled by recovery (confirmed/failed/re-broadcast). */
  recovered: number;
  /** Batches that reached CONFIRMED inside this tick. */
  routed: number;
  /** Batches broadcast but not yet confirmed (recovery owns them). */
  submitted: number;
  /** Batches FAILED this tick (sign failure or landed-with-err);
   * their trades were un-stamped and rejoin the next batch. */
  failed: number;
  /** Benign skips: lost claim races, lost CAS races, RPC silence. */
  skipped: number;
}

export async function runFeeRouterTick(
  input: FeeRouterTickInput,
  deps: FeeRouterTickDeps,
): Promise<FeeRouterTickResult> {
  const result: FeeRouterTickResult = {
    recovered: 0,
    routed: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  };

  // ---------- phase 0: recovery ----------
  const staleBatches = await deps.loadStaleBatches({ now: input.now });

  // Head height BEFORE any signature-status query: "unseen at a height
  // past lastValidBlockHeight" only proves death when the status check
  // happens after the expiry bound passed.
  let currentBlockHeight: bigint | null = null;
  if (staleBatches.some((b) => b.status === "SUBMITTED")) {
    try {
      currentBlockHeight = await deps.getCurrentBlockHeight();
    } catch {
      currentBlockHeight = null; // RPC silence — expiry unprovable this tick
    }
  }

  for (const batch of staleBatches) {
    if (batch.status === "CLAIMED") {
      // Crashed between claim and sign — no signature exists, nothing
      // can ever land. Un-stamp + FAIL is unconditionally safe. (If the
      // owning replica is actually still alive, its CLAIMED→SUBMITTED
      // CAS will return 0 and it will drop the batch without
      // broadcasting — the loader's grace window makes this rare.)
      await deps.persistBatchFailed(batch.id);
      result.recovered += 1;
      continue;
    }

    if (!batch.txSignature || !batch.signedTxB64) {
      // Schema-inconsistent (the CAS writes all artifacts atomically).
      // Nothing to verify or re-broadcast — leave for operator metrics.
      result.skipped += 1;
      continue;
    }

    let status: SignatureStatusLite | null;
    try {
      status = await deps.getSignatureStatus(batch.txSignature);
    } catch {
      result.skipped += 1; // RPC silence — leave untouched
      continue;
    }

    if (status) {
      if (status.err !== null && status.err !== undefined) {
        // Landed but the fee_receive errored — no lamports moved, and
        // the signature can never land again. Trades rejoin safely.
        await deps.persistBatchFailed(batch.id);
        result.recovered += 1;
      } else if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        await deps.persistBatchConfirmed(batch.id);
        result.recovered += 1;
      } else {
        result.skipped += 1; // 'processed' — indeterminate, re-check next tick
      }
      continue;
    }

    const expired =
      currentBlockHeight !== null &&
      batch.lastValidBlockHeight !== null &&
      currentBlockHeight > batch.lastValidBlockHeight;

    if (expired) {
      // Provably dead: unseen (searchTransactionHistory) after the
      // expiry bound. Un-stamp + FAIL; the trades rejoin the next batch.
      await deps.persistBatchFailed(batch.id);
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
      await deps.broadcast(batch.signedTxB64);
    } catch {
      result.skipped += 1; // leave SUBMITTED; next recovery retries
      continue;
    }
    result.recovered += 1; // still SUBMITTED; next tick confirms
  }

  // ---------- phase 1: route ----------
  const rows = await deps.loadUnrouted({ now: input.now });

  for (const row of rows) {
    // 1. claim trades by row identity (batch row + stamps, one tx).
    const batchId = await deps.claimBatch(row);
    if (batchId === null) {
      result.skipped += 1; // another worker owns (some of) the rows — benign
      continue;
    }

    // 2. build + sign (no broadcast).
    let artifact: SignedFeeBatchArtifact;
    try {
      artifact = await deps.sign(row);
    } catch {
      // Nothing signed reached the wire — un-stamp + FAIL so the trades
      // rejoin the next batch with a fresh blockhash.
      await deps.persistBatchFailed(batchId);
      result.failed += 1;
      continue;
    }

    // 3. persist the artifact BEFORE broadcast (claim-first CAS).
    const marked = await deps.markSubmitted(batchId, artifact);
    if (!marked) {
      // A recovery scan elsewhere FAILED our batch between claim and
      // here; the trades are already un-stamped. Do NOT broadcast — the
      // durable record of these bytes no longer exists.
      result.skipped += 1;
      continue;
    }

    // 4. broadcast the persisted bytes.
    try {
      await deps.broadcast(artifact.signedTxB64);
    } catch {
      // Leave SUBMITTED — the send may have reached the cluster anyway.
      // Recovery settles it from on-chain evidence next tick.
      result.submitted += 1;
      continue;
    }

    // 5. best-effort same-tick confirmation.
    let outcome: SignatureConfirmOutcome;
    try {
      outcome = await deps.confirmSignature(artifact.txSignature);
    } catch {
      outcome = { status: "timeout" };
    }

    if (outcome.status === "confirmed") {
      await deps.persistBatchConfirmed(batchId);
      // Display cursor only — routing truth is the trades' batch stamp.
      await deps.persistCursor(row.treasuryId, row.latestTradeTimestamp);
      result.routed += 1;
    } else if (outcome.status === "failed") {
      // Landed with an on-chain error — fee not paid; trades rejoin.
      await deps.persistBatchFailed(batchId);
      result.failed += 1;
    } else {
      result.submitted += 1; // recovery confirms next tick
    }
  }

  return result;
}
