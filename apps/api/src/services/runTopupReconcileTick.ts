/**
 * Top-up reconcile tick (payments pass, batch 2): one call = one pass of
 * the worker that finishes wallet top-ups. Pure orchestration; every IO
 * surface is an argument.
 *
 * The request that submits a top-up may never see its end: the send can
 * throw after the network took it, the wait for confirmation can run
 * out, the tab can close. This pass is what ends such a row, and it ends
 * it from the chain alone.
 *
 * Per row, oldest first:
 *   - a row with a signature: ask for the signature's fate
 *       landed_ok      credit it (makeCreditTopup: the status change and
 *                      the grant in one transaction, exactly once)
 *       landed_failed  failed, code failed_on_chain
 *       dead           expired, code never_landed
 *       in_flight      a row that holds its signed bytes gets the SAME
 *                      bytes broadcast again, on every pass until the
 *                      chain says what became of them (the same
 *                      transaction cannot pay twice). A node can take a
 *                      transfer and still drop it, so a row already
 *                      `submitted` is sent again too. A `submitting` row
 *                      the node took becomes `submitted`. Otherwise wait.
 *       unknown        wait. Nothing is inferred from a failed read.
 *   - a `prepared` row past its time with no signature: expired, code
 *     unsigned_expired. Nobody signed it, so nothing can have moved.
 *
 * CHAIN EVIDENCE ENDS A ROW. Once a signature is stored, no clock and no
 * error ends the row here: not the wall-clock expiry, not a send that
 * throws, not a fate that could not be read.
 *
 * Every change is a compare-and-set. Losing one is normal (the submit
 * request or its reconcile got there first) and is counted, not logged
 * as a fault. One row that throws does not stop the others.
 */

import type { SignatureFateAnswer } from "./signatureFate.js";
import type { CreditTopupArgs, CreditTopupResult } from "./walletTopup.js";

/** The reason codes this worker writes to `failure_code`. */
export const TOPUP_FAILURE_CODES = {
  failedOnChain: "failed_on_chain",
  neverLanded: "never_landed",
  unsignedExpired: "unsigned_expired",
} as const;

export type TopupFailureCode =
  (typeof TOPUP_FAILURE_CODES)[keyof typeof TOPUP_FAILURE_CODES];

/** How many rows one pass takes. */
export const TOPUP_RECONCILE_BATCH_SIZE = 50;

export interface ReconcilableTopupRow {
  id: string;
  orgId: string;
  asset: string;
  network: string;
  amountUsdCents: bigint;
  bonusCents: bigint;
  status: string; // 'prepared' | 'submitting' | 'submitted'
  txSignature: string | null;
  /** The signed transaction as the wallet returned it, base64. */
  signedTxB64: string | null;
  lastValidBlockHeight: bigint;
  expiresAt: Date;
}

/** Did the node take the bytes? `detail` is the node's own text: for the
 * log only. A send that was not taken says nothing about the transfer. */
export type TopupResendResult = { ok: true } | { ok: false; detail: string };

export type TopupReconcileAction =
  | "credited"
  | "failed"
  | "expired_never_landed"
  | "expired_unsigned"
  | "resent"
  | "waiting"
  | "lost_race"
  | "error";

/** One row's outcome, for the log. Never sent to a customer. */
export interface TopupReconcileEvent {
  topupId: string;
  action: TopupReconcileAction;
  fate?: SignatureFateAnswer;
  detail?: string;
}

export interface TopupReconcileTickDeps {
  /** `{ ok: true }` only when the node is on the cluster the settings
   * name. Never throws (lib/solana.ts ensureSolanaCluster). */
  checkCluster: () => Promise<{ ok: boolean; reason?: string }>;
  /** Oldest first: rows in flight, and `prepared` rows past `now`. */
  loadTopups: (args: {
    limit: number;
    now: Date;
  }) => Promise<ReconcilableTopupRow[]>;
  /** What happened to this signature. Never throws. */
  readFate: (args: {
    signature: string;
    lastValidBlockHeight: bigint;
  }) => Promise<SignatureFateAnswer>;
  /** makeCreditTopup's creditTopup: `credited: false` is a lost race. */
  creditTopup: (args: CreditTopupArgs) => Promise<CreditTopupResult>;
  /** Compare-and-set submitting|submitted -> failed|expired, for a row
   * that holds `txSignature`. False = the row had already moved on. */
  endFromChain: (args: {
    id: string;
    txSignature: string;
    to: "failed" | "expired";
    failureCode: TopupFailureCode;
    failureReason: string;
  }) => Promise<boolean>;
  /** Compare-and-set prepared (with no signature) -> expired. */
  expireUnsigned: (args: {
    id: string;
    failureCode: TopupFailureCode;
  }) => Promise<boolean>;
  /** Broadcast the stored signed bytes again, unchanged. */
  resendSignedBytes: (args: {
    signedTxB64: string;
    txSignature: string;
  }) => Promise<TopupResendResult>;
  /** Compare-and-set submitting -> submitted. */
  markSubmitted: (args: { id: string }) => Promise<boolean>;
  log?: (event: TopupReconcileEvent) => void;
}

export interface TopupReconcileTickInput {
  /** False turns the pass into a no-op (see topupReconcileEnabled). */
  enabled: boolean;
  limit?: number;
  now?: () => Date;
}

export interface TopupReconcileTickResult {
  ran: boolean;
  /** Why nothing ran, when nothing did. */
  skipped?: "disabled" | "chain_unavailable";
  loaded: number;
  credited: number;
  failed: number;
  expiredNeverLanded: number;
  expiredUnsigned: number;
  resent: number;
  waiting: number;
  lostRace: number;
  errors: number;
}

/** The worker runs only when wallet top-ups are on and it has an
 * interval above zero. */
export function topupReconcileEnabled(settings: {
  walletTopupsEnabled: boolean;
  intervalMs: number;
}): boolean {
  return (
    settings.walletTopupsEnabled === true &&
    Number.isFinite(settings.intervalMs) &&
    settings.intervalMs > 0
  );
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

/** The operator's note for a transfer that can no longer land. */
function neverLandedNote(answer: SignatureFateAnswer): string {
  const d = answer.detail;
  return (
    `${answer.reason}: finalized block height ` +
    `${d.finalizedBlockHeight === null ? "?" : d.finalizedBlockHeight.toString()}` +
    ` is past last valid ` +
    `${d.lastValidBlockHeight === null ? "?" : d.lastValidBlockHeight.toString()}` +
    ` plus ${d.marginBlocks}`
  );
}

async function reconcileOne(
  row: ReconcilableTopupRow,
  now: Date,
  deps: TopupReconcileTickDeps,
): Promise<TopupReconcileEvent> {
  const event = await decideOne(row, now, deps);
  // A `prepared` row that holds a signature should not exist (the claim
  // stores the signature and moves the row to `submitting` together).
  // No compare-and-set here can end it, so a lost one is not a race: it
  // is a row that will never end by itself, and it is said so loudly.
  if (
    event.action === "lost_race" &&
    row.status === "prepared" &&
    row.txSignature
  ) {
    return {
      ...event,
      action: "error",
      detail: "a prepared row holds a signature; it needs an operator",
    };
  }
  return event;
}

async function decideOne(
  row: ReconcilableTopupRow,
  now: Date,
  deps: TopupReconcileTickDeps,
): Promise<TopupReconcileEvent> {
  const signature = row.txSignature;

  if (!signature) {
    // Nobody signed this row, so only the clock can end it, and only
    // while it is still `prepared`. A row in flight with no signature
    // should not exist; it is left alone rather than guessed at.
    if (row.status !== "prepared") {
      // Nothing here can end it, so it must not wait unseen: the detail
      // puts it in the log on every pass.
      return {
        topupId: row.id,
        action: "waiting",
        detail: `a ${row.status} row holds no signature; it needs an operator`,
      };
    }
    if (row.expiresAt.getTime() >= now.getTime()) {
      return { topupId: row.id, action: "waiting" };
    }
    const expired = await deps.expireUnsigned({
      id: row.id,
      failureCode: TOPUP_FAILURE_CODES.unsignedExpired,
    });
    return {
      topupId: row.id,
      action: expired ? "expired_unsigned" : "lost_race",
    };
  }

  // A signature is stored: from here only the chain ends the row.
  const fate = await deps.readFate({
    signature,
    lastValidBlockHeight: row.lastValidBlockHeight,
  });

  switch (fate.fate) {
    case "landed_ok": {
      const credit = await deps.creditTopup({
        topupId: row.id,
        orgId: row.orgId,
        amountUsdCents: row.amountUsdCents,
        bonusCents: row.bonusCents,
        asset: row.asset,
        network: row.network,
      });
      return {
        topupId: row.id,
        action: credit.credited ? "credited" : "lost_race",
        fate,
      };
    }

    case "landed_failed": {
      const ended = await deps.endFromChain({
        id: row.id,
        txSignature: signature,
        to: "failed",
        failureCode: TOPUP_FAILURE_CODES.failedOnChain,
        failureReason: fate.error ?? fate.reason,
      });
      return { topupId: row.id, action: ended ? "failed" : "lost_race", fate };
    }

    case "dead": {
      const ended = await deps.endFromChain({
        id: row.id,
        txSignature: signature,
        to: "expired",
        failureCode: TOPUP_FAILURE_CODES.neverLanded,
        failureReason: neverLandedNote(fate),
      });
      return {
        topupId: row.id,
        action: ended ? "expired_never_landed" : "lost_race",
        fate,
      };
    }

    case "in_flight": {
      if (!row.signedTxB64) {
        return { topupId: row.id, action: "waiting", fate };
      }
      // The first send may never have reached a node, or reached one
      // that then dropped it. These are the bytes the wallet signed, so
      // sending them again is the same transaction: it lands once or
      // not at all.
      let sent: TopupResendResult;
      try {
        sent = await deps.resendSignedBytes({
          signedTxB64: row.signedTxB64,
          txSignature: signature,
        });
      } catch (err) {
        sent = { ok: false, detail: errorText(err) };
      }
      if (!sent.ok) {
        // Nothing is inferred from a send that was not taken.
        return { topupId: row.id, action: "waiting", fate, detail: sent.detail };
      }
      if (row.status !== "submitting") {
        return { topupId: row.id, action: "resent", fate };
      }
      const marked = await deps.markSubmitted({ id: row.id });
      return { topupId: row.id, action: marked ? "resent" : "lost_race", fate };
    }

    default:
      // unknown, and any fate this code does not know: wait.
      return { topupId: row.id, action: "waiting", fate, detail: fate.error };
  }
}

export async function runTopupReconcileTick(
  input: TopupReconcileTickInput,
  deps: TopupReconcileTickDeps,
): Promise<TopupReconcileTickResult> {
  const result: TopupReconcileTickResult = {
    ran: false,
    loaded: 0,
    credited: 0,
    failed: 0,
    expiredNeverLanded: 0,
    expiredUnsigned: 0,
    resent: 0,
    waiting: 0,
    lostRace: 0,
    errors: 0,
  };

  if (!input.enabled) {
    return { ...result, skipped: "disabled" };
  }

  // Fail closed: a node on the wrong cluster, or one that cannot be
  // reached, tells us nothing about these signatures.
  let clusterOk = false;
  try {
    clusterOk = (await deps.checkCluster()).ok === true;
  } catch {
    clusterOk = false;
  }
  if (!clusterOk) {
    return { ...result, skipped: "chain_unavailable" };
  }

  const now = (input.now ?? (() => new Date()))();
  const rows = await deps.loadTopups({
    limit: input.limit ?? TOPUP_RECONCILE_BATCH_SIZE,
    now,
  });
  result.ran = true;
  result.loaded = rows.length;

  for (const row of rows) {
    let event: TopupReconcileEvent;
    try {
      event = await reconcileOne(row, now, deps);
    } catch (err) {
      // The row is left exactly as it was; the next pass asks again.
      event = { topupId: row.id, action: "error", detail: errorText(err) };
    }

    switch (event.action) {
      case "credited":
        result.credited += 1;
        break;
      case "failed":
        result.failed += 1;
        break;
      case "expired_never_landed":
        result.expiredNeverLanded += 1;
        break;
      case "expired_unsigned":
        result.expiredUnsigned += 1;
        break;
      case "resent":
        result.resent += 1;
        break;
      case "waiting":
        result.waiting += 1;
        break;
      case "lost_race":
        result.lostRace += 1;
        break;
      case "error":
        result.errors += 1;
        break;
    }

    try {
      deps.log?.(event);
    } catch {
      // A logger that throws must not stop the batch.
    }
  }

  return result;
}
