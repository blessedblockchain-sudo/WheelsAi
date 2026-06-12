import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/runSubmitPaymentsTick.ts — the
// scan-and-dispatch driver for the submit-payment BullMQ worker under
// the claim-first protocol (remediation D3) with per-row recipient
// resolution (remediation D5).
//
// Phase 0 (recovery): SUBMITTING rows are settled from on-chain
// evidence — landed → SUBMITTED; unexpired+unseen → re-broadcast the
// SAME stored bytes; expired+unseen → back to PENDING; RPC silence →
// untouched.
//
// Phase 1 (submit) per row: resolve → prepare (sign only) → claim (CAS
// PENDING→SUBMITTING persisting the artifact) → broadcast → SUBMITTED.
// A broadcast failure leaves the row SUBMITTING (recovery owns it);
// a lost claim race skips the row; resolution failures stay PENDING
// with attempts incremented until PARKED at the 5th.

interface PendingRow {
  id: string;
  treasuryId: string;
  treasuryAddress: string;
  nosanaJobId: string;
  amountLamports: bigint;
  programInitialized: boolean;
  mintAddress: string | null;
  resolutionAttempts: number;
}

interface SubmittingRow {
  id: string;
  txSignature: string;
  lastValidBlockHeight: bigint | null;
  signedTxB64: string;
}

interface Artifact {
  txSignature: string;
  lastValidBlockHeight: bigint;
  signedTxB64: string;
}

function makeDeps(opts: {
  pending?: PendingRow[];
  submitting?: SubmittingRow[];
  currentBlockHeight?: bigint | (() => Promise<bigint>);
  /** sig → landed?; a thrown error simulates RPC failure. */
  hasSignatureLanded?: (sig: string) => Promise<boolean>;
  resolveRecipient?: (jobId: string) => Promise<string>;
  prepare?: (row: PendingRow, recipient: string) => Promise<Artifact>;
  claim?: (id: string, artifact: Artifact) => Promise<boolean>;
  broadcastShouldThrow?: (b64: string) => boolean;
  persistShouldThrow?: (id: string, transition: any) => boolean;
}) {
  const log: any[] = [];
  return {
    log,
    deps: {
      loadSubmittingBatch: async ({ now }: { now: Date }) => {
        log.push({ type: "loadSubmittingBatch", now });
        return opts.submitting ?? [];
      },
      getCurrentBlockHeight: async () => {
        log.push({ type: "getCurrentBlockHeight" });
        const h = opts.currentBlockHeight ?? 100n;
        return typeof h === "function" ? h() : h;
      },
      hasSignatureLanded: async (sig: string) => {
        log.push({ type: "hasSignatureLanded", sig });
        return opts.hasSignatureLanded
          ? opts.hasSignatureLanded(sig)
          : false;
      },
      broadcast: async (b64: string) => {
        log.push({ type: "broadcast", b64 });
        if (opts.broadcastShouldThrow?.(b64)) {
          throw new Error("rpc send failed");
        }
      },
      persistRecoveryTransition: async (id: string, transition: any) => {
        log.push({ type: "persistRecoveryTransition", id, transition });
      },
      loadPendingBatch: async ({ now }: { now: Date }) => {
        log.push({ type: "loadPendingBatch", now });
        return opts.pending ?? [];
      },
      resolveRecipient: async (jobId: string) => {
        log.push({ type: "resolveRecipient", jobId });
        return opts.resolveRecipient
          ? opts.resolveRecipient(jobId)
          : `Host_${jobId}`;
      },
      prepare: async (row: PendingRow, recipient: string) => {
        log.push({ type: "prepare", id: row.id, recipient });
        if (opts.prepare) return opts.prepare(row, recipient);
        return {
          txSignature: `sig_${row.id}`,
          lastValidBlockHeight: 500n,
          signedTxB64: `bytes_${row.id}`,
        };
      },
      claim: async (id: string, artifact: Artifact) => {
        log.push({ type: "claim", id, artifact });
        return opts.claim ? opts.claim(id, artifact) : true;
      },
      persistTransition: async (id: string, transition: any) => {
        log.push({ type: "persistTransition", id, transition });
        if (opts.persistShouldThrow?.(id, transition)) {
          throw new Error("persist failed");
        }
      },
    },
  };
}

const sampleRow = (overrides: Partial<PendingRow> = {}): PendingRow => ({
  id: "cp_1",
  treasuryId: "treas_1",
  treasuryAddress: "TreasuryAddr",
  nosanaJobId: "job_1",
  amountLamports: 1_000_000n,
  programInitialized: false,
  mintAddress: null,
  resolutionAttempts: 0,
  ...overrides,
});

const submittingRow = (
  overrides: Partial<SubmittingRow> = {},
): SubmittingRow => ({
  id: "cp_s",
  txSignature: "sig_s",
  lastValidBlockHeight: 200n,
  signedTxB64: "bytes_s",
  ...overrides,
});

// ============================================
// Empty batch
// ============================================

test("runSubmitPaymentsTick returns zero counts and performs no work when both batches are empty", async () => {
  setupEnv();
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({});
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    submitted: 0,
    failed: 0,
    deferred: 0,
    parked: 0,
    skipped: 0,
  });
  assert.equal(log.filter((c) => c.type === "prepare").length, 0);
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
  // No SUBMITTING rows → no RPC height fetch either.
  assert.equal(log.filter((c) => c.type === "getCurrentBlockHeight").length, 0);
});

// ============================================
// Happy path — claim-first ordering
// ============================================

test("runSubmitPaymentsTick runs resolve → prepare → claim → broadcast → submitted per row, in that order", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [sampleRow({ id: "a", nosanaJobId: "job_a" })],
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.submitted, 1);
  assert.equal(result.failed, 0);

  const sequence = log
    .filter((c) =>
      ["resolveRecipient", "prepare", "claim", "broadcast", "persistTransition"].includes(
        c.type,
      ),
    )
    .map((c) => c.type);
  assert.deepEqual(sequence, [
    "resolveRecipient",
    "prepare",
    "claim",
    "broadcast",
    "persistTransition",
  ]);

  // The CLAIM persisted the full artifact BEFORE the broadcast, and the
  // broadcast sent exactly the claimed bytes.
  const claim = log.find((c) => c.type === "claim");
  assert.deepEqual(claim.artifact, {
    txSignature: "sig_a",
    lastValidBlockHeight: 500n,
    signedTxB64: "bytes_a",
  });
  const broadcast = log.find((c) => c.type === "broadcast");
  assert.equal(broadcast.b64, "bytes_a");

  const transition = log.find((c) => c.type === "persistTransition");
  assert.deepEqual(transition.transition, {
    type: "submitted",
    txSignature: "sig_a",
  });
});

test("runSubmitPaymentsTick processes rows in the order returned by loadPendingBatch", async () => {
  // The loader sorts by scheduledFor asc; the driver must preserve
  // that order so older payments don't get starved by a stream of
  // newer ones (some token's auto-pay loop could otherwise dominate).
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [sampleRow({ id: "older" }), sampleRow({ id: "newer" })],
  });
  await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  const prepares = log.filter((c) => c.type === "prepare");
  assert.deepEqual(
    prepares.map((c) => c.id),
    ["older", "newer"],
  );
});

// ============================================
// Per-row failure isolation — prepare failures
// ============================================

test("runSubmitPaymentsTick records FAILED for a thrown prepare and continues to the next row", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [sampleRow({ id: "bad" }), sampleRow({ id: "good" })],
    prepare: async (row) => {
      if (row.id === "bad") throw new Error("blockhash_unavailable: 503");
      return {
        txSignature: `sig_${row.id}`,
        lastValidBlockHeight: 500n,
        signedTxB64: `bytes_${row.id}`,
      };
    },
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.submitted, 1);
  assert.equal(result.failed, 1);
  const transitions = log.filter((c) => c.type === "persistTransition");
  assert.equal(transitions[0]!.id, "bad");
  assert.equal(transitions[0]!.transition.type, "failed");
  assert.match(transitions[0]!.transition.errorMessage, /blockhash_unavailable/);
  assert.equal(transitions[1]!.transition.type, "submitted");
  // The failed row was never claimed or broadcast.
  assert.equal(log.filter((c) => c.type === "claim").length, 1);
  assert.equal(log.filter((c) => c.type === "broadcast").length, 1);
});

// ============================================
// D5 — resolution failure containment + parking
// ============================================

test("runSubmitPaymentsTick converts a resolution failure into resolution_failed and STILL submits the other rows (no head-of-line blocking)", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [
      sampleRow({ id: "poison", nosanaJobId: "job_deleted" }),
      sampleRow({ id: "healthy_1", nosanaJobId: "job_h1" }),
      sampleRow({ id: "healthy_2", nosanaJobId: "job_h2" }),
    ],
    resolveRecipient: async (jobId) => {
      if (jobId === "job_deleted") {
        throw new Error("Nosana job not found: job_deleted");
      }
      return `Host_${jobId}`;
    },
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  // The poison row deferred; both healthy rows submitted in the SAME tick.
  assert.equal(result.deferred, 1);
  assert.equal(result.submitted, 2);
  const poison = log.find(
    (c) => c.type === "persistTransition" && c.id === "poison",
  );
  assert.equal(poison.transition.type, "resolution_failed");
  assert.match(poison.transition.errorMessage, /not found/);
  // The poison row was never prepared/claimed/broadcast.
  assert.equal(log.filter((c) => c.type === "prepare").length, 2);
  const submitted = log.filter(
    (c) => c.type === "persistTransition" && c.transition.type === "submitted",
  );
  assert.deepEqual(
    submitted.map((c) => c.id),
    ["healthy_1", "healthy_2"],
  );
});

test("runSubmitPaymentsTick PARKs a row whose resolution failure is its 5th attempt", async () => {
  const { runSubmitPaymentsTick, MAX_RESOLUTION_ATTEMPTS } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  assert.equal(MAX_RESOLUTION_ATTEMPTS, 5);
  const { log, deps } = makeDeps({
    // 4 prior failures recorded — this tick's failure is the 5th.
    pending: [sampleRow({ id: "exhausted", resolutionAttempts: 4 })],
    resolveRecipient: async () => {
      throw new Error("Nosana job not found: job_1");
    },
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.parked, 1);
  assert.equal(result.deferred, 0);
  const t = log.find((c) => c.type === "persistTransition");
  assert.equal(t.transition.type, "parked");
  assert.match(t.transition.errorMessage, /not found/);
});

test("runSubmitPaymentsTick defers (does NOT park) a resolution failure below the threshold", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [sampleRow({ id: "queued", resolutionAttempts: 3 })],
    resolveRecipient: async () => {
      throw new Error("no host yet");
    },
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.deferred, 1);
  assert.equal(result.parked, 0);
  assert.equal(
    log.find((c) => c.type === "persistTransition").transition.type,
    "resolution_failed",
  );
});

// ============================================
// CAS claim semantics — concurrent ticks
// ============================================

test("runSubmitPaymentsTick skips a row whose claim was lost (count 0) without broadcasting", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [sampleRow({ id: "stolen" }), sampleRow({ id: "ours" })],
    claim: async (id) => id !== "stolen",
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.skipped, 1);
  assert.equal(result.submitted, 1);
  // ZERO broadcasts for the stolen row.
  const broadcasts = log.filter((c) => c.type === "broadcast");
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]!.b64, "bytes_ours");
  // And no transition write for it either (the claiming worker owns it).
  assert.equal(
    log.filter((c) => c.type === "persistTransition" && c.id === "stolen").length,
    0,
  );
});

test("two concurrent ticks over the same PENDING row: exactly one claims, zero double-broadcasts", async () => {
  // Simulates the two-replica overlap: a shared CAS ledger arbitrates
  // the claim exactly like updateMany WHERE status='PENDING' does.
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const claimedIds = new Set<string>();
  const casClaim = async (id: string) => {
    if (claimedIds.has(id)) return false; // other replica won
    claimedIds.add(id);
    return true;
  };
  const row = sampleRow({ id: "contested" });
  const a = makeDeps({ pending: [row], claim: casClaim });
  const b = makeDeps({ pending: [row], claim: casClaim });

  const [resultA, resultB] = await Promise.all([
    runSubmitPaymentsTick({ now: new Date() }, a.deps as any),
    runSubmitPaymentsTick({ now: new Date() }, b.deps as any),
  ]);

  assert.equal(resultA.submitted + resultB.submitted, 1, "exactly one submits");
  assert.equal(resultA.skipped + resultB.skipped, 1, "exactly one skips");
  const totalBroadcasts =
    a.log.filter((c) => c.type === "broadcast").length +
    b.log.filter((c) => c.type === "broadcast").length;
  assert.equal(totalBroadcasts, 1, "the contested row is broadcast exactly once");
});

// ============================================
// Broadcast failure → row stays SUBMITTING
// ============================================

test("runSubmitPaymentsTick leaves a row SUBMITTING when the broadcast throws (no flip back to PENDING, no FAILED)", async () => {
  // Re-signing after a send error is what creates double-spends: the
  // send may have reached the cluster despite the error. The ONLY safe
  // move is to leave the claimed row for the recovery scan.
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [sampleRow({ id: "wedged" }), sampleRow({ id: "fine" })],
    broadcastShouldThrow: (b64) => b64 === "bytes_wedged",
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.skipped, 1);
  assert.equal(result.submitted, 1); // the next row still ran
  // NO transition write at all for the wedged row — it stays SUBMITTING.
  assert.equal(
    log.filter((c) => c.type === "persistTransition" && c.id === "wedged").length,
    0,
  );
});

// ============================================
// Crash simulation — broadcast ok, SUBMITTING→SUBMITTED write crashes,
// next tick's recovery re-broadcasts the SAME bytes with NO second sign
// ============================================

test("crash between broadcast and submitted-transition: next tick recovers by re-broadcasting the identical base64, never re-signing", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );

  // --- tick 1: broadcast succeeds, then the DB write crashes.
  const tick1 = makeDeps({
    pending: [sampleRow({ id: "crashy" })],
    persistShouldThrow: (_id, transition) => transition.type === "submitted",
  });
  await assert.rejects(
    runSubmitPaymentsTick({ now: new Date() }, tick1.deps as any),
    /persist failed/,
  );
  const tick1Broadcasts = tick1.log.filter((c) => c.type === "broadcast");
  assert.equal(tick1Broadcasts.length, 1);
  const claimedArtifact = tick1.log.find((c) => c.type === "claim").artifact;

  // --- tick 2: the row surfaces as SUBMITTING (the claim committed in
  // tick 1); the tx hasn't landed yet and the blockhash is still valid.
  const tick2 = makeDeps({
    submitting: [
      {
        id: "crashy",
        txSignature: claimedArtifact.txSignature,
        lastValidBlockHeight: claimedArtifact.lastValidBlockHeight,
        signedTxB64: claimedArtifact.signedTxB64,
      },
    ],
    currentBlockHeight: claimedArtifact.lastValidBlockHeight - 10n,
    hasSignatureLanded: async () => false,
  });
  const result2 = await runSubmitPaymentsTick(
    { now: new Date() },
    tick2.deps as any,
  );
  assert.equal(result2.recovered, 1);

  // The recovery broadcast used the IDENTICAL base64 from tick 1's claim.
  const tick2Broadcasts = tick2.log.filter((c) => c.type === "broadcast");
  assert.equal(tick2Broadcasts.length, 1);
  assert.equal(tick2Broadcasts[0]!.b64, tick1Broadcasts[0]!.b64);

  // And crucially: NO second signing happened in tick 2.
  assert.equal(tick2.log.filter((c) => c.type === "prepare").length, 0);
  assert.equal(tick2.log.filter((c) => c.type === "claim").length, 0);

  const recovery = tick2.log.find((c) => c.type === "persistRecoveryTransition");
  assert.equal(recovery.id, "crashy");
  assert.equal(recovery.transition.type, "rebroadcast");
});

// ============================================
// Recovery phase verdicts
// ============================================

test("recovery: a landed signature transitions SUBMITTING→SUBMITTED without re-broadcasting", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    submitting: [submittingRow({ id: "landed_row", txSignature: "sig_landed" })],
    hasSignatureLanded: async (sig) => sig === "sig_landed",
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.recovered, 1);
  const recovery = log.find((c) => c.type === "persistRecoveryTransition");
  assert.equal(recovery.id, "landed_row");
  assert.equal(recovery.transition.type, "landed");
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

test("recovery: unexpired + unseen re-broadcasts the SAME stored bytes and transitions to SUBMITTED", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    submitting: [
      submittingRow({
        id: "inflight",
        lastValidBlockHeight: 300n,
        signedTxB64: "the_exact_claimed_bytes",
      }),
    ],
    currentBlockHeight: 300n, // ≤ lastValidBlockHeight — still valid
    hasSignatureLanded: async () => false,
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.recovered, 1);
  const broadcast = log.find((c) => c.type === "broadcast");
  assert.equal(broadcast.b64, "the_exact_claimed_bytes");
  assert.equal(
    log.find((c) => c.type === "persistRecoveryTransition").transition.type,
    "rebroadcast",
  );
});

test("recovery: expired + unseen goes back to PENDING (claim fields cleared by the writer) and is NOT re-broadcast", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    submitting: [submittingRow({ id: "dead", lastValidBlockHeight: 200n })],
    currentBlockHeight: 201n, // strictly past the bound — provably dead
    hasSignatureLanded: async () => false,
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.recovered, 1);
  const recovery = log.find((c) => c.type === "persistRecoveryTransition");
  assert.equal(recovery.id, "dead");
  assert.equal(recovery.transition.type, "expired");
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

test("recovery: a signature-status RPC error leaves the row untouched", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    submitting: [submittingRow({ id: "blind" })],
    hasSignatureLanded: async () => {
      throw new Error("rpc timeout");
    },
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.recovered, 0);
  assert.equal(result.skipped, 1);
  assert.equal(log.filter((c) => c.type === "persistRecoveryTransition").length, 0);
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

test("recovery: a block-height RPC error leaves an unseen row untouched (no rebroadcast, no expiry verdict)", async () => {
  // Without the head height we can neither prove expiry NOR safely
  // assume validity — silence means do nothing.
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    submitting: [submittingRow({ id: "unknowable" })],
    currentBlockHeight: () => Promise.reject(new Error("rpc down")),
    hasSignatureLanded: async () => false,
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.recovered, 0);
  assert.equal(result.skipped, 1);
  assert.equal(log.filter((c) => c.type === "persistRecoveryTransition").length, 0);
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

test("recovery: a block-height RPC error still allows the positive landed verdict", async () => {
  // The height fetch failing doesn't blind the landed check — positive
  // on-chain evidence is still actionable.
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    submitting: [submittingRow({ id: "landed_anyway" })],
    currentBlockHeight: () => Promise.reject(new Error("rpc down")),
    hasSignatureLanded: async () => true,
  });
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  assert.equal(result.recovered, 1);
  assert.equal(
    log.find((c) => c.type === "persistRecoveryTransition").transition.type,
    "landed",
  );
});

test("recovery: the head height is fetched BEFORE any signature-status check (expiry proof soundness)", async () => {
  // "Unseen past lastValidBlockHeight" only proves death when the status
  // check happens AFTER the height observation.
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    submitting: [submittingRow({ id: "x" })],
    hasSignatureLanded: async () => false,
  });
  await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  const heightIdx = log.findIndex((c) => c.type === "getCurrentBlockHeight");
  const statusIdx = log.findIndex((c) => c.type === "hasSignatureLanded");
  assert.ok(heightIdx !== -1 && statusIdx !== -1);
  assert.ok(heightIdx < statusIdx, "height must be observed before the status check");
});

// ============================================
// Persistence error handling
// ============================================

test("runSubmitPaymentsTick bubbles persistTransition errors so the worker can retry the tick", async () => {
  // If the DB write fails after a successful broadcast, the row stays
  // SUBMITTING with its bytes durable — the recovery scan settles it
  // from on-chain evidence. The tick still throws so BullMQ retries
  // (and so operators see DB failures loudly).
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { deps } = makeDeps({
    pending: [sampleRow()],
    persistShouldThrow: () => true,
  });
  await assert.rejects(
    runSubmitPaymentsTick({ now: new Date() }, deps as any),
    /persist failed/,
  );
});
