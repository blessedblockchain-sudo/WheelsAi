/**
 * Scan-and-dispatch driver for the reputation-attestation BullMQ worker
 * (plan A4) — confirmation discipline (remediation D6b).
 *
 * The old worker advanced its cursor AND inserted the OnChainAttestation
 * mirror row immediately after sendRawTransaction — broadcast treated as
 * finality. A dropped tx left a phantom mirror row and permanently
 * skipped that usage window. Now:
 *
 *   - the mirror row is the INTENT record: inserted with status
 *     SUBMITTED (plus the signed-tx artifacts) BEFORE the broadcast —
 *     the claim-first protocol from remediation D3
 *   - only CONFIRMED rows count; `observedAt` is set at CONFIRMATION
 *     time (null until then) and the cumulative columns hold values
 *     read back from the on-chain AgentReputation PDA (the program is
 *     the source of truth — never the deltas re-labeled)
 *   - the per-token cursor (AgentToken.lastOnChainAttestationAt)
 *     advances ONLY on CONFIRMED; a FAILED/expired window simply stays
 *     open and the next tick re-attests it with a fresh signature
 *
 * Each tick runs two phases:
 *
 * PHASE 0 — RECOVERY of SUBMITTED mirror rows (broadcast and/or confirm
 * didn't complete; crash or replica overlap). Chain head fetched ONCE
 * up-front so the expiry proof is sound. Per row:
 *   - landed confirmed/finalized → read back cumulatives → CONFIRMED +
 *     observedAt + cursor advance (cursor = attestorUnixTs as a Date;
 *     second-precision — at worst <1s of usage re-counts after a crash)
 *   - landed with err → FAILED; cursor untouched (window retries)
 *   - landed but only 'processed' → leave SUBMITTED (never invent
 *     finality)
 *   - unseen AND head > lastValidBlockHeight → PROVABLY dead → FAILED;
 *     cursor NOT advanced — the window re-attests next tick
 *   - unseen AND head ≤ bound → re-broadcast the STORED bytes verbatim
 *     (same signature ⇒ cluster dedupes ⇒ no duplicate attestation)
 *   - any RPC error → leave untouched (silence is not evidence)
 *
 * PHASE 1 — ATTEST eligible agents. Per row:
 *   1. aggregate(row)        → null/zero deltas → skipped (no tx fee for
 *      an empty period; cursor stays back)
 *   2. prepare(row, agg)     → build + SIGN only. Throw → failed for
 *      that row; nothing was persisted or broadcast.
 *   3. persistIntent(...)    → INSERT the SUBMITTED mirror row with the
 *      artifacts. A throw propagates (BullMQ retries — and if the
 *      insert actually landed, the orphan row is settled by the next
 *      recovery scan; its fresh-blockhash sibling can't collide on the
 *      unique txSignature).
 *   4. broadcast(bytes)      → throw LEAVES the row SUBMITTED; recovery
 *      owns it (the send may have reached the cluster anyway).
 *   5. confirmSignature(sig) → best-effort same-tick poll:
 *      confirmed → readCumulatives (throw → leave SUBMITTED for
 *      recovery) → persistMirrorConfirmed (CONFIRMED + observedAt +
 *      cumulatives + cursor, one DB tx); failed → persistMirrorFailed;
 *      timeout → leave SUBMITTED.
 *
 * DB-write failures are NOT swallowed (the tick throws; BullMQ
 * retries) — safe under claim-first because every half-state is
 * settled by recovery from on-chain evidence.
 */

import type {
  SignatureConfirmOutcome,
  SignatureStatusLite,
} from "./awaitSignatureConfirmation.js";
import type { SignedAttestationArtifact } from "./prepareOnChainAttestation.js";

export interface AttestableAgentRow {
  /** AgentToken row id (Prisma uuid). */
  tokenId: string;
  mintAddress: string;
  /** When the worker last CONFIRMED an attestation for this agent.
   * Used as the lower bound of the usage-record window. Null = first run. */
  lastOnChainAttestationAt: Date | null;
}

export interface AttestationAggregate {
  uptimeSecondsDelta: bigint;
  messageCountDelta: bigint;
  /** Score in 0..=100. The program rejects anything else. */
  score: number;
  /** Inclusive upper bound of the aggregation window — becomes the
   * cursor advance target (on CONFIRMATION) AND the on-chain unix_ts. */
  periodEnd: Date;
}

/** A mirror row left SUBMITTED by a previous tick. Owned by recovery. */
export interface SubmittedAttestationRow {
  /** OnChainAttestation row id. */
  id: string;
  tokenId: string;
  mintAddress: string;
  txSignature: string;
  /** Null only on schema-inconsistent rows (intent always writes it);
   * treated as "expiry unprovable" → re-broadcast, never re-sign. */
  lastValidBlockHeight: bigint | null;
  signedTxB64: string;
  /** Attestor-claimed unix seconds — doubles as the cursor target. */
  attestorUnixTs: bigint;
}

/** Cumulative state read back from the AgentReputation PDA after the
 * attestation CONFIRMS. Null = readback unavailable (recorded as null
 * on the mirror — truthful "unknown", never delta-derived). */
export interface CumulativeReputationReadback {
  cumulativeUptimeSeconds: bigint;
  cumulativeMessageCount: bigint;
  attestationCount: number;
}

export interface AttestationTickInput {
  now: Date;
}

export interface AttestationTickDeps {
  // ---- phase 0: recovery ----
  loadSubmittedMirrors: (args: {
    now: Date;
  }) => Promise<SubmittedAttestationRow[]>;
  /** Chain head height ("confirmed"). Throw = RPC unreachable. */
  getCurrentBlockHeight: () => Promise<bigint>;
  /** getSignatureStatuses([sig], {searchTransactionHistory:true}). */
  getSignatureStatus: (
    txSignature: string,
  ) => Promise<SignatureStatusLite | null>;
  /** sendRawTransaction over stored/just-signed bytes. */
  broadcast: (signedTxB64: string) => Promise<void>;

  // ---- phase 1: attest ----
  loadAgents: (args: { now: Date }) => Promise<AttestableAgentRow[]>;
  aggregate: (
    row: AttestableAgentRow,
    args: { now: Date },
  ) => Promise<AttestationAggregate | null>;
  /** Build + sign WITHOUT broadcasting. Throws on any prepare failure. */
  prepare: (
    row: AttestableAgentRow,
    aggregate: AttestationAggregate,
  ) => Promise<SignedAttestationArtifact>;
  /** INSERT the SUBMITTED mirror row (deltas + artifacts, null
   * cumulatives/observedAt) BEFORE broadcast. Returns the row id. */
  persistIntent: (
    row: AttestableAgentRow,
    aggregate: AttestationAggregate,
    artifact: SignedAttestationArtifact,
    attestorAddress: string,
  ) => Promise<string>;
  /** Best-effort same-tick confirmation poll (short injected timeout). */
  confirmSignature: (txSignature: string) => Promise<SignatureConfirmOutcome>;

  // ---- shared by both phases ----
  /** Read the AgentReputation PDA's cumulative state. Throw = RPC
   * unreachable (caller leaves the row SUBMITTED and retries). */
  readCumulatives: (
    mintAddress: string,
  ) => Promise<CumulativeReputationReadback | null>;
  /** One DB transaction: mirror CAS SUBMITTED→CONFIRMED (+observedAt,
   * +cumulatives) and, only if that CAS won, cursor advance. */
  persistMirrorConfirmed: (args: {
    mirrorId: string;
    tokenId: string;
    cursor: Date;
    cumulatives: CumulativeReputationReadback | null;
  }) => Promise<void>;
  /** CAS SUBMITTED→FAILED. Cursor untouched — the window retries. */
  persistMirrorFailed: (mirrorId: string) => Promise<void>;
  attestorAddress: string;
}

export interface AttestationTickResult {
  /** SUBMITTED mirrors settled by recovery (confirmed/failed/re-broadcast). */
  recovered: number;
  /** Rows that reached CONFIRMED inside this tick (cursor advanced). */
  attested: number;
  /** Rows broadcast but not yet confirmed (recovery owns them). */
  submitted: number;
  /** Prepare failures + landed-with-err rows. Cursor NOT advanced. */
  failed: number;
  /** Zero-delta/null aggregates + RPC-silence skips. */
  skipped: number;
}

export async function runAttestationTick(
  input: AttestationTickInput,
  deps: AttestationTickDeps,
): Promise<AttestationTickResult> {
  const result: AttestationTickResult = {
    recovered: 0,
    attested: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  };

  // ---------- phase 0: recovery ----------
  const submittedRows = await deps.loadSubmittedMirrors({ now: input.now });

  // Head height BEFORE any signature-status query — see D3's recovery.
  let currentBlockHeight: bigint | null = null;
  if (submittedRows.length > 0) {
    try {
      currentBlockHeight = await deps.getCurrentBlockHeight();
    } catch {
      currentBlockHeight = null; // RPC silence — expiry unprovable this tick
    }
  }

  for (const row of submittedRows) {
    let status: SignatureStatusLite | null;
    try {
      status = await deps.getSignatureStatus(row.txSignature);
    } catch {
      result.skipped += 1; // RPC silence — leave untouched
      continue;
    }

    if (status) {
      if (status.err !== null && status.err !== undefined) {
        // Landed but the program rejected it — nothing was recorded
        // on-chain. The window stays open (cursor untouched).
        await deps.persistMirrorFailed(row.id);
        result.recovered += 1;
      } else if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        let cumulatives: CumulativeReputationReadback | null;
        try {
          cumulatives = await deps.readCumulatives(row.mintAddress);
        } catch {
          result.skipped += 1; // readback blip — retry next tick
          continue;
        }
        await deps.persistMirrorConfirmed({
          mirrorId: row.id,
          tokenId: row.tokenId,
          // attestorUnixTs is the on-chain truth for periodEnd; the
          // sub-second remainder lost here can at worst re-count <1s of
          // usage after a crash — bounded and rare.
          cursor: new Date(Number(row.attestorUnixTs) * 1000),
          cumulatives,
        });
        result.recovered += 1;
      } else {
        result.skipped += 1; // 'processed' — indeterminate, re-check next tick
      }
      continue;
    }

    const expired =
      currentBlockHeight !== null &&
      row.lastValidBlockHeight !== null &&
      currentBlockHeight > row.lastValidBlockHeight;

    if (expired) {
      // Provably dead: unseen (searchTransactionHistory) after the
      // expiry bound. FAILED; cursor NOT advanced — window retries.
      await deps.persistMirrorFailed(row.id);
      result.recovered += 1;
      continue;
    }

    if (currentBlockHeight === null) {
      result.skipped += 1; // can't prove anything without the head height
      continue;
    }

    // Still inside the validity window: re-broadcast the SAME bytes.
    try {
      await deps.broadcast(row.signedTxB64);
    } catch {
      result.skipped += 1; // leave SUBMITTED; next recovery retries
      continue;
    }
    result.recovered += 1; // still SUBMITTED; next tick confirms
  }

  // ---------- phase 1: attest ----------
  const rows = await deps.loadAgents({ now: input.now });

  for (const row of rows) {
    const aggregate = await deps.aggregate(row, { now: input.now });
    if (
      !aggregate ||
      (aggregate.uptimeSecondsDelta === BigInt(0) &&
        aggregate.messageCountDelta === BigInt(0))
    ) {
      result.skipped += 1;
      continue;
    }

    // 1. build + sign (no broadcast).
    let artifact: SignedAttestationArtifact;
    try {
      artifact = await deps.prepare(row, aggregate);
    } catch {
      result.failed += 1; // nothing persisted/broadcast — clean retry next tick
      continue;
    }

    // 2. persist the intent BEFORE broadcast (claim-first).
    const mirrorId = await deps.persistIntent(
      row,
      aggregate,
      artifact,
      deps.attestorAddress,
    );

    // 3. broadcast the persisted bytes.
    try {
      await deps.broadcast(artifact.signedTxB64);
    } catch {
      // Leave SUBMITTED — the send may have reached the cluster anyway.
      result.submitted += 1;
      continue;
    }

    // 4. best-effort same-tick confirmation.
    let outcome: SignatureConfirmOutcome;
    try {
      outcome = await deps.confirmSignature(artifact.txSignature);
    } catch {
      outcome = { status: "timeout" };
    }

    if (outcome.status === "confirmed") {
      let cumulatives: CumulativeReputationReadback | null;
      try {
        cumulatives = await deps.readCumulatives(row.mintAddress);
      } catch {
        result.submitted += 1; // confirmed on-chain; recovery records it
        continue;
      }
      await deps.persistMirrorConfirmed({
        mirrorId,
        tokenId: row.tokenId,
        cursor: aggregate.periodEnd, // full-precision in the happy path
        cumulatives,
      });
      result.attested += 1;
    } else if (outcome.status === "failed") {
      await deps.persistMirrorFailed(mirrorId);
      result.failed += 1; // cursor untouched — window retries next tick
    } else {
      result.submitted += 1; // recovery confirms next tick
    }
  }

  return result;
}
