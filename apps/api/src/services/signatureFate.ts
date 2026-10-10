/**
 * What happened to this signature (payments pass, batch 1).
 *
 * One strict, shared answer for every money path that has to decide
 * between "wait", "settle" and "it is safe to build a new transaction".
 * It is the same idea as the recovery scan in runSubmitPaymentsTick and
 * the poll in awaitSignatureConfirmation, with the proof of death made
 * tight enough to license a re-sign.
 *
 * Fates:
 *   landed_ok      the status has no error and is confirmed or finalized
 *   landed_failed  the status has an error and is confirmed or finalized
 *                  (the transaction is on the chain and moved nothing)
 *   in_flight      it may still land: the status is only "processed", or
 *                  it is absent and death is not proven
 *   dead           it can never land (see below); a new transaction for
 *                  the same payment is now safe
 *   unknown        a read failed or gave a value that cannot be used.
 *                  Nothing is inferred from an error: ask again later
 *
 * ORDER OF READS, which the proof depends on:
 *   1. the FINALIZED slot and block height, together;
 *   2. the signature's status, with the full history search, together
 *      with the slot of the node that answered;
 *   3. only for a transaction we did not build: whether its blockhash is
 *      still valid at finalized, with the slot that answer was read at.
 *
 * dead needs ALL of:
 *   a. the status is absent;
 *   b. the node that answered the status was at or past the finalized
 *      slot read in step 1 (a node behind that slot may simply not have
 *      seen the block the transaction is in);
 *   c. the finalized block height is above lastValidBlockHeight plus the
 *      margin. Finalized, not confirmed: a confirmed height can still be
 *      rolled back, and then the transaction could land after all.
 *
 * For a transaction we did not build there is no lastValidBlockHeight,
 * and (c) is instead: its blockhash is no longer valid at finalized, read
 * at a slot at or past the slot of step 1 and not past the slot of the
 * node that answered the status (a transaction that landed between the
 * two would otherwise be missed). With neither a height nor a blockhash
 * a signature is never dead.
 *
 * CALLER'S DUTY for the blockhash form: a blockhash that is brand new is
 * also "not valid at finalized" until the block that made it is
 * finalized (about 13 seconds). Use the blockhash form only for a
 * transaction first seen long enough ago for that to have passed.
 *
 * Pure: the reads and the margin are arguments. It never throws.
 */

export type SignatureFate =
  | "landed_ok"
  | "landed_failed"
  | "in_flight"
  | "dead"
  | "unknown";

export type SignatureFateReason =
  // landed
  | "status_ok"
  | "status_err"
  // in flight
  | "status_processed"
  | "absent_within_window"
  | "absent_status_node_behind"
  | "absent_blockhash_still_valid"
  | "absent_blockhash_read_behind"
  | "absent_blockhash_read_ahead_of_status"
  | "absent_no_expiry_proof"
  // dead
  | "absent_expired_by_height"
  | "absent_expired_by_blockhash"
  // unknown
  | "finalized_read_failed"
  | "status_read_failed"
  | "blockhash_read_failed"
  | "bad_reading"
  | "bad_margin";

export type SignatureConfirmationLevel =
  | "processed"
  | "confirmed"
  | "finalized"
  | null;

/** A slot or a block height as a dependency may give it. */
export type ChainCount = bigint | number;

export interface SignatureFateInput {
  signature: string;
  /** The transaction's last valid block height when we built it; null
   * for a transaction we did not build. */
  lastValidBlockHeight: ChainCount | null;
  /** Its recent blockhash, used only when there is no height. */
  blockhash?: string | null;
}

export interface FinalizedPosition {
  slot: ChainCount;
  blockHeight: ChainCount;
}

export interface SignatureStatusReading {
  /** null when the node has no record of the signature. */
  status: {
    confirmationStatus: SignatureConfirmationLevel;
    err: unknown | null;
    /** The slot the transaction was processed in, when the node says. */
    slot?: ChainCount | null;
  } | null;
  /** The slot of the node that answered. */
  contextSlot: ChainCount;
}

export interface BlockhashValidityReading {
  valid: boolean;
  /** The finalized slot the answer was read at. */
  contextSlot: ChainCount;
}

export interface SignatureFateDeps {
  /** The FINALIZED slot and block height, read together. Throw = RPC
   * unreachable. */
  getFinalizedPosition: () => Promise<FinalizedPosition>;
  /** The signature's status with the full history search, and the slot
   * of the node that answered. */
  getSignatureStatus: (signature: string) => Promise<SignatureStatusReading>;
  /** Whether a blockhash is still valid at finalized. Optional: without
   * it a transaction with no height is never dead. */
  isBlockhashValid?: (blockhash: string) => Promise<BlockhashValidityReading>;
  /** How far past lastValidBlockHeight the finalized height must be. */
  marginBlocks: number;
}

/** Everything seen on the way to the answer, for the log line. */
export interface SignatureFateDetail {
  finalizedSlot: bigint | null;
  finalizedBlockHeight: bigint | null;
  lastValidBlockHeight: bigint | null;
  marginBlocks: number;
  statusContextSlot: bigint | null;
  confirmationStatus: SignatureConfirmationLevel;
  /** The slot the transaction landed in, when the node said. */
  landedSlot: bigint | null;
  blockhashValid: boolean | null;
  blockhashContextSlot: bigint | null;
}

export interface SignatureFateAnswer {
  fate: SignatureFate;
  reason: SignatureFateReason;
  signature: string;
  /** landed_failed: the chain's error. unknown: what the read said. */
  error?: string;
  detail: SignatureFateDetail;
}

function formatErr(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** A slot or height as a bigint, or null when it is not a whole number
 * at or above zero. */
function toCount(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  return null;
}

export async function signatureFate(
  input: SignatureFateInput,
  deps: SignatureFateDeps,
): Promise<SignatureFateAnswer> {
  const detail: SignatureFateDetail = {
    finalizedSlot: null,
    finalizedBlockHeight: null,
    lastValidBlockHeight: toCount(input.lastValidBlockHeight),
    marginBlocks: deps.marginBlocks,
    statusContextSlot: null,
    confirmationStatus: null,
    landedSlot: null,
    blockhashValid: null,
    blockhashContextSlot: null,
  };
  const answer = (
    fate: SignatureFate,
    reason: SignatureFateReason,
    error?: string,
  ): SignatureFateAnswer => ({
    fate,
    reason,
    signature: input.signature,
    ...(error === undefined ? {} : { error }),
    detail,
  });

  if (!Number.isSafeInteger(deps.marginBlocks) || deps.marginBlocks < 0) {
    return answer("unknown", "bad_margin");
  }
  const margin = BigInt(deps.marginBlocks);

  // 1. The finalized position, BEFORE the status: "absent" proves
  // nothing unless it was read after the expiry bound had passed.
  let finalizedSlot: bigint;
  let finalizedHeight: bigint;
  try {
    const position = await deps.getFinalizedPosition();
    const slot = toCount(position?.slot);
    const height = toCount(position?.blockHeight);
    if (slot === null || height === null) {
      return answer("unknown", "bad_reading", "finalized position");
    }
    finalizedSlot = slot;
    finalizedHeight = height;
  } catch (err) {
    return answer("unknown", "finalized_read_failed", formatErr(err));
  }
  detail.finalizedSlot = finalizedSlot;
  detail.finalizedBlockHeight = finalizedHeight;

  // 2. The status.
  let reading: SignatureStatusReading;
  let statusSlot: bigint;
  try {
    reading = await deps.getSignatureStatus(input.signature);
    const slot = toCount(reading?.contextSlot);
    if (slot === null) {
      return answer("unknown", "bad_reading", "status context slot");
    }
    // "Absent" has to be said: an explicit null. A reading with no
    // status field at all is a broken answer, and a broken answer must
    // never count toward a proof of death.
    if (reading.status !== null && typeof reading.status !== "object") {
      return answer("unknown", "bad_reading", "status");
    }
    statusSlot = slot;
  } catch (err) {
    return answer("unknown", "status_read_failed", formatErr(err));
  }
  detail.statusContextSlot = statusSlot;

  const status = reading.status;
  if (status !== null) {
    const level = status.confirmationStatus ?? null;
    detail.confirmationStatus = level;
    detail.landedSlot = toCount(status.slot);
    if (level !== "confirmed" && level !== "finalized") {
      // Only "processed" (or no level given): the block it is in can
      // still be dropped, with or without an error.
      return answer("in_flight", "status_processed");
    }
    if (status.err !== null && status.err !== undefined) {
      return answer("landed_failed", "status_err", formatErr(status.err));
    }
    return answer("landed_ok", "status_ok");
  }

  // The status is absent. From here the only question is whether death
  // is proven; anything short of proof is in_flight.
  if (statusSlot < finalizedSlot) {
    return answer("in_flight", "absent_status_node_behind");
  }

  const lastValid = detail.lastValidBlockHeight;
  if (lastValid !== null) {
    return finalizedHeight > lastValid + margin
      ? answer("dead", "absent_expired_by_height")
      : answer("in_flight", "absent_within_window");
  }

  // 3. No height: a transaction we did not build. Its blockhash decides.
  const blockhash = input.blockhash;
  if (!blockhash || !deps.isBlockhashValid) {
    return answer("in_flight", "absent_no_expiry_proof");
  }
  let validity: BlockhashValidityReading;
  let blockhashSlot: bigint;
  try {
    validity = await deps.isBlockhashValid(blockhash);
    const slot = toCount(validity?.contextSlot);
    if (slot === null || typeof validity.valid !== "boolean") {
      return answer("unknown", "bad_reading", "blockhash validity");
    }
    blockhashSlot = slot;
  } catch (err) {
    return answer("unknown", "blockhash_read_failed", formatErr(err));
  }
  detail.blockhashValid = validity.valid;
  detail.blockhashContextSlot = blockhashSlot;

  if (validity.valid) {
    return answer("in_flight", "absent_blockhash_still_valid");
  }
  if (blockhashSlot < finalizedSlot) {
    return answer("in_flight", "absent_blockhash_read_behind");
  }
  if (blockhashSlot > statusSlot) {
    // The transaction could have landed after the status was read and
    // before the blockhash ran out.
    return answer("in_flight", "absent_blockhash_read_ahead_of_status");
  }
  return answer("dead", "absent_expired_by_blockhash");
}

/** The answer as plain strings and numbers, safe for any logger (a
 * bigint does not survive JSON.stringify). */
export function describeSignatureFate(
  answer: SignatureFateAnswer,
): Record<string, string | number | boolean | null> {
  const text = (value: bigint | null) =>
    value === null ? null : value.toString();
  const d = answer.detail;
  return {
    signature: answer.signature,
    fate: answer.fate,
    reason: answer.reason,
    error: answer.error ?? null,
    finalizedSlot: text(d.finalizedSlot),
    finalizedBlockHeight: text(d.finalizedBlockHeight),
    lastValidBlockHeight: text(d.lastValidBlockHeight),
    marginBlocks: d.marginBlocks,
    statusContextSlot: text(d.statusContextSlot),
    confirmationStatus: d.confirmationStatus,
    landedSlot: text(d.landedSlot),
    blockhashValid: d.blockhashValid,
    blockhashContextSlot: text(d.blockhashContextSlot),
  };
}
