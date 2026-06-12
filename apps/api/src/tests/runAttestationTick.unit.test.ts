/**
 * Drives apps/api/src/services/runAttestationTick.ts — the pure
 * scan-and-dispatch driver for the reputation-attestation worker
 * (confirmation discipline, remediation D6b).
 *
 * Pinning:
 *   - skipped: rows where aggregate returns null or zero deltas don't
 *     spend tx fees and don't advance the cursor
 *   - prepare failures are counted, NOT thrown; cursor stays back
 *   - claim-first ordering: persistIntent lands BEFORE broadcast, and
 *     the broadcast bytes are EXACTLY the persisted artifact
 *   - attested: counted only after CONFIRMED + persistMirrorConfirmed;
 *     the cursor advance target is the aggregate's periodEnd
 *   - confirm "failed" (landed with err) → persistMirrorFailed; cursor
 *     NOT advanced (the window stays open and retries)
 *   - broadcast throw / confirm timeout → row LEFT SUBMITTED (recovery
 *     owns it); neither confirmed nor failed is written
 *   - persistMirrorConfirmed failure AFTER on-chain confirm → throws
 *     (BullMQ retries; recovery re-derives CONFIRMED from the chain)
 *   - per-row failure isolation: one bad row doesn't halt the batch
 *   - phase 0 recovery: landed → CONFIRMED with cursor from
 *     attestorUnixTs; landed-with-err / expired+unseen → FAILED with NO
 *     cursor advance; unexpired+unseen → re-broadcast the SAME bytes;
 *     RPC silence / 'processed' → untouched
 */

import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const NOW = new Date("2026-05-14T10:00:00Z");

interface AgentRow {
  tokenId: string;
  mintAddress: string;
  lastOnChainAttestationAt: Date | null;
}

interface Aggregate {
  uptimeSecondsDelta: bigint;
  messageCountDelta: bigint;
  score: number;
  periodEnd: Date;
}

interface SubmittedMirror {
  id: string;
  tokenId: string;
  mintAddress: string;
  txSignature: string;
  lastValidBlockHeight: bigint | null;
  signedTxB64: string;
  attestorUnixTs: bigint;
}

type SigStatus = {
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown | null;
} | null;

function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    tokenId: "tok_1",
    mintAddress: "MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    lastOnChainAttestationAt: null,
    ...overrides,
  };
}

function aggregate(overrides: Partial<Aggregate> = {}): Aggregate {
  return {
    uptimeSecondsDelta: BigInt(3600),
    messageCountDelta: BigInt(12),
    score: 80,
    periodEnd: NOW,
    ...overrides,
  };
}

function submittedMirror(
  overrides: Partial<SubmittedMirror> = {},
): SubmittedMirror {
  return {
    id: "mirror_old",
    tokenId: "tok_1",
    mintAddress: "MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    txSignature: "old_sig",
    lastValidBlockHeight: 500n,
    signedTxB64: "old_bytes",
    attestorUnixTs: BigInt(1_700_000_000),
    ...overrides,
  };
}

const CUMULATIVES = {
  cumulativeUptimeSeconds: BigInt(7200),
  cumulativeMessageCount: BigInt(24),
  attestationCount: 2,
};

function makeDeps(opts: {
  agents?: AgentRow[];
  aggregateFor?: (r: AgentRow) => Aggregate | null;
  submittedMirrors?: SubmittedMirror[];
  currentBlockHeight?: bigint;
  blockHeightThrows?: boolean;
  signatureStatus?: (sig: string) => SigStatus;
  signatureStatusThrows?: boolean;
  prepareShouldThrow?: (r: AgentRow) => boolean;
  broadcastShouldThrow?: boolean;
  confirmOutcome?: (sig: string) =>
    | { status: "confirmed" }
    | { status: "failed"; error: string }
    | { status: "timeout" };
  readCumulativesThrows?: boolean;
  persistConfirmedShouldThrow?: boolean;
}) {
  const log: any[] = [];
  let mirrorSeq = 0;
  return {
    log,
    deps: {
      // phase 0
      loadSubmittedMirrors: async ({ now }: { now: Date }) => {
        log.push({ type: "loadSubmittedMirrors", now });
        return opts.submittedMirrors ?? [];
      },
      getCurrentBlockHeight: async () => {
        log.push({ type: "getCurrentBlockHeight" });
        if (opts.blockHeightThrows) throw new Error("rpc down");
        return opts.currentBlockHeight ?? 1_000n;
      },
      getSignatureStatus: async (sig: string) => {
        log.push({ type: "getSignatureStatus", sig });
        if (opts.signatureStatusThrows) throw new Error("rpc down");
        return opts.signatureStatus?.(sig) ?? null;
      },
      broadcast: async (signedTxB64: string) => {
        log.push({ type: "broadcast", signedTxB64 });
        if (opts.broadcastShouldThrow) throw new Error("send failed");
      },
      // phase 1
      loadAgents: async ({ now }: { now: Date }) => {
        log.push({ type: "loadAgents", now });
        return opts.agents ?? [];
      },
      aggregate: async (r: AgentRow) => {
        log.push({ type: "aggregate", tokenId: r.tokenId });
        return opts.aggregateFor ? opts.aggregateFor(r) : aggregate();
      },
      prepare: async (r: AgentRow, agg: Aggregate) => {
        log.push({ type: "prepare", tokenId: r.tokenId, agg });
        if (opts.prepareShouldThrow?.(r)) {
          throw new Error("blockhash_unavailable: nope");
        }
        return {
          txSignature: `sig_${r.tokenId}`,
          lastValidBlockHeight: 900n,
          signedTxB64: `bytes_${r.tokenId}`,
        };
      },
      persistIntent: async (
        r: AgentRow,
        agg: Aggregate,
        artifact: any,
        attestorAddress: string,
      ) => {
        mirrorSeq += 1;
        const mirrorId = `mirror_${mirrorSeq}`;
        log.push({
          type: "persistIntent",
          tokenId: r.tokenId,
          agg,
          artifact,
          attestorAddress,
          mirrorId,
        });
        return mirrorId;
      },
      confirmSignature: async (sig: string) => {
        log.push({ type: "confirmSignature", sig });
        return opts.confirmOutcome?.(sig) ?? { status: "confirmed" as const };
      },
      // shared
      readCumulatives: async (mintAddress: string) => {
        log.push({ type: "readCumulatives", mintAddress });
        if (opts.readCumulativesThrows) throw new Error("rpc down");
        return CUMULATIVES;
      },
      persistMirrorConfirmed: async (args: {
        mirrorId: string;
        tokenId: string;
        cursor: Date;
        cumulatives: typeof CUMULATIVES | null;
      }) => {
        log.push({ type: "persistMirrorConfirmed", ...args });
        if (opts.persistConfirmedShouldThrow) throw new Error("db down");
      },
      persistMirrorFailed: async (mirrorId: string) => {
        log.push({ type: "persistMirrorFailed", mirrorId });
      },
      attestorAddress: "ATT_PUBKEY",
    },
  };
}

// ============================================
// Empty batch
// ============================================

test("runAttestationTick: empty rows → all-zero counts", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({});
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  assert.equal(log.filter((c) => c.type === "prepare").length, 0);
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

// ============================================
// Skips: null / zero-delta aggregates
// ============================================

test("runAttestationTick: row with null aggregate → skipped, nothing signed or persisted", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    agents: [row()],
    aggregateFor: () => null,
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 0,
    submitted: 0,
    failed: 0,
    skipped: 1,
  });
  assert.equal(log.filter((c) => c.type === "prepare").length, 0);
  assert.equal(log.filter((c) => c.type === "persistIntent").length, 0);
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 0);
});

test("runAttestationTick: zero deltas → skipped (no tx fee for empty period)", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    agents: [row()],
    aggregateFor: () =>
      aggregate({
        uptimeSecondsDelta: BigInt(0),
        messageCountDelta: BigInt(0),
      }),
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 0,
    submitted: 0,
    failed: 0,
    skipped: 1,
  });
  assert.equal(log.filter((c) => c.type === "prepare").length, 0);
});

test("runAttestationTick: non-zero uptime only → still attests", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    agents: [row()],
    aggregateFor: () =>
      aggregate({
        uptimeSecondsDelta: BigInt(60),
        messageCountDelta: BigInt(0),
      }),
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 1,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  assert.equal(log.filter((c) => c.type === "prepare").length, 1);
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 1);
});

// ============================================
// Claim-first ordering
// ============================================

test("runAttestationTick: persistIntent lands BEFORE broadcast; broadcast sends the persisted bytes", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({ agents: [row()] });
  await runAttestationTick({ now: NOW }, deps as any);
  const order = log.map((c) => c.type);
  const intentIdx = order.indexOf("persistIntent");
  const broadcastIdx = order.indexOf("broadcast");
  assert.ok(intentIdx >= 0 && broadcastIdx >= 0);
  assert.ok(
    intentIdx < broadcastIdx,
    "claim-first: the SUBMITTED mirror row must be durable before any broadcast",
  );
  const intent = log.find((c) => c.type === "persistIntent");
  const sent = log.find((c) => c.type === "broadcast");
  assert.equal(intent.artifact.signedTxB64, sent.signedTxB64);
});

test("runAttestationTick: persistIntent receives the aggregate, artifact, and attestorAddress", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const agg = aggregate();
  const { log, deps } = makeDeps({
    agents: [row()],
    aggregateFor: () => agg,
  });
  await runAttestationTick({ now: NOW }, deps as any);
  const intent = log.find((c) => c.type === "persistIntent");
  assert.equal(intent.attestorAddress, "ATT_PUBKEY");
  assert.deepEqual(intent.agg, agg);
  assert.equal(intent.artifact.txSignature, "sig_tok_1");
});

// ============================================
// Confirmation discipline: cursor ONLY advances on CONFIRMED
// ============================================

test("runAttestationTick: CONFIRMED → persistMirrorConfirmed with periodEnd cursor + PDA readback", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const periodEnd = new Date("2026-05-14T09:59:59.750Z"); // sub-second precision kept
  const { log, deps } = makeDeps({
    agents: [row()],
    aggregateFor: () => aggregate({ periodEnd }),
    confirmOutcome: () => ({ status: "confirmed" }),
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.equal(r.attested, 1);
  const confirmed = log.find((c) => c.type === "persistMirrorConfirmed");
  assert.equal(confirmed.mirrorId, "mirror_1");
  assert.equal(confirmed.tokenId, "tok_1");
  // The cursor advance target is the attested window's periodEnd.
  assert.equal(confirmed.cursor.toISOString(), periodEnd.toISOString());
  // Cumulatives are the AgentReputation PDA readback — true on-chain
  // values, never the deltas re-labeled.
  assert.deepEqual(confirmed.cumulatives, CUMULATIVES);
  // Readback happened after confirmation, against the row's mint.
  const read = log.find((c) => c.type === "readCumulatives");
  assert.equal(read.mintAddress, row().mintAddress);
});

test("runAttestationTick: prepare throw → failed; cursor NOT advanced; nothing persisted or broadcast", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    agents: [row()],
    prepareShouldThrow: () => true,
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 0,
    submitted: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(log.filter((c) => c.type === "persistIntent").length, 0);
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 0);
});

test("runAttestationTick: confirm 'failed' (landed with err) → persistMirrorFailed; cursor NOT advanced", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    agents: [row()],
    confirmOutcome: () => ({ status: "failed", error: "InstructionError" }),
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 0,
    submitted: 0,
    failed: 1,
    skipped: 0,
  });
  assert.deepEqual(
    log.filter((c) => c.type === "persistMirrorFailed").map((c) => c.mirrorId),
    ["mirror_1"],
  );
  // The window stays open: no CONFIRMED transition, no cursor advance.
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 0);
});

test("runAttestationTick: broadcast throw leaves the row SUBMITTED (recovery owns it)", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    agents: [row()],
    broadcastShouldThrow: true,
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 0,
    submitted: 1,
    failed: 0,
    skipped: 0,
  });
  // The send may have reached the cluster — NEVER fail or confirm here.
  assert.equal(log.filter((c) => c.type === "persistMirrorFailed").length, 0);
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 0);
});

test("runAttestationTick: confirm timeout leaves the row SUBMITTED for next-tick recovery", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    agents: [row()],
    confirmOutcome: () => ({ status: "timeout" }),
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 0,
    submitted: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(log.filter((c) => c.type === "persistMirrorFailed").length, 0);
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 0);
});

test("runAttestationTick: readCumulatives throw after confirm → left SUBMITTED (recovery records it)", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    agents: [row()],
    confirmOutcome: () => ({ status: "confirmed" }),
    readCumulativesThrows: true,
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 0,
    submitted: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 0);
});

test("runAttestationTick: persistMirrorConfirmed failure AFTER on-chain confirm → throws (BullMQ retries)", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { deps } = makeDeps({
    agents: [row()],
    persistConfirmedShouldThrow: true,
  });
  await assert.rejects(
    () => runAttestationTick({ now: NOW }, deps as any),
    /db down/,
  );
});

// ============================================
// Per-row failure isolation + mixed batch
// ============================================

test("runAttestationTick: one bad row doesn't halt the batch (prepare throw isolation)", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    agents: [row({ tokenId: "a" }), row({ tokenId: "b" })],
    prepareShouldThrow: (r) => r.tokenId === "a",
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 1,
    submitted: 0,
    failed: 1,
    skipped: 0,
  });
  const confirmed = log.filter((c) => c.type === "persistMirrorConfirmed");
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].tokenId, "b");
});

test("runAttestationTick: mixed batch — skipped + failed + attested counts add up", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { deps } = makeDeps({
    agents: [
      row({ tokenId: "skip" }),
      row({ tokenId: "fail" }),
      row({ tokenId: "ok" }),
    ],
    aggregateFor: (rr) =>
      rr.tokenId === "skip"
        ? aggregate({
            uptimeSecondsDelta: BigInt(0),
            messageCountDelta: BigInt(0),
          })
        : aggregate(),
    prepareShouldThrow: (rr) => rr.tokenId === "fail",
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 0,
    attested: 1,
    submitted: 0,
    failed: 1,
    skipped: 1,
  });
});

// ============================================
// Phase 0: recovery
// ============================================

test("runAttestationTick recovery: landed (finalized) → CONFIRMED with cursor from attestorUnixTs", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    submittedMirrors: [
      submittedMirror({ attestorUnixTs: BigInt(1_700_000_000) }),
    ],
    signatureStatus: () => ({ confirmationStatus: "finalized", err: null }),
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 1,
    attested: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  const confirmed = log.find((c) => c.type === "persistMirrorConfirmed");
  assert.equal(confirmed.mirrorId, "mirror_old");
  assert.equal(confirmed.tokenId, "tok_1");
  // Cursor reconstructed from the attestor-claimed unix seconds — the
  // on-chain truth for the attested window's end.
  assert.equal(
    confirmed.cursor.toISOString(),
    new Date(1_700_000_000 * 1000).toISOString(),
  );
  assert.deepEqual(confirmed.cumulatives, CUMULATIVES);
  // Nothing re-broadcast; no FAILED transition.
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
  assert.equal(log.filter((c) => c.type === "persistMirrorFailed").length, 0);
});

test("runAttestationTick recovery: landed WITH err → FAILED; cursor NOT advanced (window retries)", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    submittedMirrors: [submittedMirror()],
    signatureStatus: () => ({
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, "Custom"] },
    }),
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.equal(r.recovered, 1);
  assert.deepEqual(
    log.filter((c) => c.type === "persistMirrorFailed").map((c) => c.mirrorId),
    ["mirror_old"],
  );
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 0);
});

test("runAttestationTick recovery: expired + unseen → FAILED and NO cursor advance", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    submittedMirrors: [submittedMirror({ lastValidBlockHeight: 500n })],
    currentBlockHeight: 501n, // strictly past the bound
    signatureStatus: () => null, // unseen even with searchTransactionHistory
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 1,
    attested: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(
    log.filter((c) => c.type === "persistMirrorFailed").map((c) => c.mirrorId),
    ["mirror_old"],
  );
  // The usage window stays open — re-attested next tick.
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 0);
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

test("runAttestationTick recovery: unexpired + unseen → re-broadcast the SAME stored bytes", async () => {
  // Crash between broadcast and confirm: the mirror sits SUBMITTED with
  // its artifact. Recovery must re-send those EXACT bytes (same
  // signature ⇒ cluster dedupes ⇒ no duplicate attestation) — never
  // re-sign.
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    submittedMirrors: [
      submittedMirror({ lastValidBlockHeight: 500n, signedTxB64: "exact_bytes" }),
    ],
    currentBlockHeight: 400n, // still inside the validity window
    signatureStatus: () => null,
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.deepEqual(r, {
    recovered: 1,
    attested: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  const sends = log.filter((c) => c.type === "broadcast");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].signedTxB64, "exact_bytes");
  // No transition: still SUBMITTED; the next tick confirms or expires it.
  assert.equal(log.filter((c) => c.type === "persistMirrorFailed").length, 0);
  assert.equal(log.filter((c) => c.type === "persistMirrorConfirmed").length, 0);
});

test("runAttestationTick recovery: RPC silence (status throw / head unknown) leaves rows untouched", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  // status throws → untouched
  {
    const { log, deps } = makeDeps({
      submittedMirrors: [submittedMirror()],
      signatureStatusThrows: true,
    });
    const r = await runAttestationTick({ now: NOW }, deps as any);
    assert.equal(r.skipped, 1);
    assert.equal(r.recovered, 0);
    assert.equal(
      log.filter((c) => c.type.startsWith("persistMirror")).length,
      0,
    );
  }
  // head unknown + unseen → expiry unprovable → untouched (no broadcast
  // either: without the head we can't even prove it's still valid).
  {
    const { log, deps } = makeDeps({
      submittedMirrors: [submittedMirror()],
      blockHeightThrows: true,
      signatureStatus: () => null,
    });
    const r = await runAttestationTick({ now: NOW }, deps as any);
    assert.equal(r.skipped, 1);
    assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
  }
});

test("runAttestationTick recovery: 'processed' status is indeterminate → left SUBMITTED", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    submittedMirrors: [submittedMirror()],
    signatureStatus: () => ({ confirmationStatus: "processed", err: null }),
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.equal(r.skipped, 1);
  assert.equal(log.filter((c) => c.type.startsWith("persistMirror")).length, 0);
});

test("runAttestationTick recovery: readback blip on a landed row → left SUBMITTED, retried next tick", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const { log, deps } = makeDeps({
    submittedMirrors: [submittedMirror()],
    signatureStatus: () => ({ confirmationStatus: "confirmed", err: null }),
    readCumulativesThrows: true,
  });
  const r = await runAttestationTick({ now: NOW }, deps as any);
  assert.equal(r.skipped, 1);
  assert.equal(r.recovered, 0);
  assert.equal(log.filter((c) => c.type.startsWith("persistMirror")).length, 0);
});
