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

// Drives apps/api/src/services/runReapStuckTick.ts — the
// scan-and-dispatch driver for the stuck-submission reaper under the
// D4 rule: wall-clock age only selects WHICH rows to examine; failing
// a payment additionally requires on-chain evidence:
//   (a) current block height strictly past the row's persisted
//       lastValidBlockHeight (when present), AND
//   (b) a final getSignatureStatuses(searchTransactionHistory) lookup
//       returning null (provably unseen).
// Legacy rows (null lastValidBlockHeight) skip (a) but still require (b).
// RPC unreachable → no transitions this tick (the poller's discipline).

interface ReaperPayment {
  id: string;
  status: "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  txSignature: string | null;
  errorMessage: string | null;
  paidAt: Date | null;
  retryCount: number;
  submittedAt: Date | null;
  lastValidBlockHeight: bigint | null;
}

function makeDeps(opts: {
  payments?: ReaperPayment[];
  currentBlockHeight?: bigint | (() => Promise<bigint>);
  /** sig → landed?; throw simulates per-sig RPC failure. */
  hasSignatureLanded?: (sig: string) => Promise<boolean>;
  persistShouldThrow?: boolean;
}) {
  const log: any[] = [];
  return {
    log,
    deps: {
      loadStuckCandidates: async ({ now }: { now: Date }) => {
        log.push({ type: "loadStuckCandidates", now });
        return opts.payments ?? [];
      },
      getCurrentBlockHeight: async () => {
        log.push({ type: "getCurrentBlockHeight" });
        const h = opts.currentBlockHeight ?? 1_000_000n;
        return typeof h === "function" ? h() : h;
      },
      hasSignatureLanded: async (sig: string) => {
        log.push({ type: "hasSignatureLanded", sig });
        return opts.hasSignatureLanded ? opts.hasSignatureLanded(sig) : false;
      },
      persistTransition: async (
        id: string,
        transition: { errorMessage: string },
      ) => {
        log.push({ type: "persistTransition", id, transition });
        if (opts.persistShouldThrow) throw new Error("persist failed");
      },
    },
  };
}

const samplePayment = (overrides: Partial<ReaperPayment> = {}): ReaperPayment => ({
  id: "cp_1",
  status: "SUBMITTED",
  txSignature: "sig_1",
  errorMessage: null,
  paidAt: null,
  retryCount: 0,
  submittedAt: new Date("2026-04-26T10:00:00Z"),
  lastValidBlockHeight: null,
  ...overrides,
});

const NOW = new Date("2026-04-26T10:10:00Z");

// ============================================
// Empty batch
// ============================================

test("runReapStuckTick returns zeros when no candidates and performs no RPC", async () => {
  setupEnv();
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({ payments: [] });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.deepEqual(result, { reaped: 0, scanned: 0 });
  assert.equal(log.filter((c) => c.type === "persistTransition").length, 0);
  // No stale rows → no chain calls at all.
  assert.equal(log.filter((c) => c.type === "getCurrentBlockHeight").length, 0);
});

// ============================================
// D4 — expired + unseen IS reaped
// ============================================

test("runReapStuckTick reaps an old SUBMITTED row only after proving expiry AND signature-unseen", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "stuck",
        submittedAt: new Date("2026-04-26T10:00:00Z"), // 10 min old (maxAge 5)
        lastValidBlockHeight: 500n,
      }),
    ],
    currentBlockHeight: 501n, // strictly past the bound
    hasSignatureLanded: async () => false, // provably unseen
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 1);
  assert.equal(result.scanned, 1);
  const persist = log.find((c) => c.type === "persistTransition");
  assert.equal(persist.id, "stuck");
  assert.equal(persist.transition.errorMessage, "blockhash_expired");
  // Both evidence calls happened — height FIRST, then the status check.
  const heightIdx = log.findIndex((c) => c.type === "getCurrentBlockHeight");
  const statusIdx = log.findIndex((c) => c.type === "hasSignatureLanded");
  assert.ok(heightIdx < statusIdx, "height must be observed before the status check");
});

// ============================================
// D4 — confirmed-on-chain row is NOT failed, however old
// ============================================

test("runReapStuckTick does NOT reap an old row whose signature landed on-chain (poller will confirm it)", async () => {
  // The exact incident D4 prevents: RPC outage blinded the poller, the
  // wall clock ran past maxAge, but the SOL actually moved. Failing the
  // row would say the payment didn't happen when it did.
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "landed_old",
        submittedAt: new Date("2026-04-26T09:00:00Z"), // very old
        lastValidBlockHeight: 500n,
      }),
    ],
    currentBlockHeight: 999n, // expired by height…
    hasSignatureLanded: async () => true, // …but the tx IS on-chain
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 0);
  assert.equal(log.filter((c) => c.type === "persistTransition").length, 0);
});

// ============================================
// D4 — still inside the validity window → not reaped
// ============================================

test("runReapStuckTick does NOT reap an age-stale row whose blockhash is still valid (height ≤ lastValidBlockHeight)", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "still_valid",
        submittedAt: new Date("2026-04-26T10:00:00Z"),
        lastValidBlockHeight: 500n,
      }),
    ],
    currentBlockHeight: 500n, // == bound → tx can still land
    hasSignatureLanded: async () => false,
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 0);
  // It never even reached the signature check — height alone vetoed.
  assert.equal(log.filter((c) => c.type === "hasSignatureLanded").length, 0);
});

// ============================================
// D4 — RPC unreachable → do nothing this tick
// ============================================

test("runReapStuckTick reaps NOTHING when getCurrentBlockHeight is unreachable", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "stuck",
        submittedAt: new Date("2026-04-26T09:00:00Z"),
        lastValidBlockHeight: 500n,
      }),
      samplePayment({
        id: "legacy_stuck",
        submittedAt: new Date("2026-04-26T09:00:00Z"),
        lastValidBlockHeight: null,
      }),
    ],
    currentBlockHeight: () => Promise.reject(new Error("rpc down")),
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.deepEqual(result, { reaped: 0, scanned: 2 });
  assert.equal(log.filter((c) => c.type === "persistTransition").length, 0);
});

test("runReapStuckTick skips a row whose signature-status lookup throws (and still processes the others)", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "blind",
        txSignature: "sig_blind",
        submittedAt: new Date("2026-04-26T09:00:00Z"),
        lastValidBlockHeight: 100n,
      }),
      samplePayment({
        id: "provable",
        txSignature: "sig_provable",
        submittedAt: new Date("2026-04-26T09:00:00Z"),
        lastValidBlockHeight: 100n,
      }),
    ],
    currentBlockHeight: 200n,
    hasSignatureLanded: async (sig) => {
      if (sig === "sig_blind") throw new Error("rpc timeout");
      return false;
    },
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 1);
  const persists = log.filter((c) => c.type === "persistTransition");
  assert.deepEqual(persists.map((c) => c.id), ["provable"]);
});

// ============================================
// Legacy rows (NULL lastValidBlockHeight, pre-migration)
// ============================================

test("runReapStuckTick fails a legacy NULL-lastValidBlockHeight row only after the signature-unseen check", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "legacy",
        submittedAt: new Date("2026-04-26T10:00:00Z"),
        lastValidBlockHeight: null,
      }),
    ],
    hasSignatureLanded: async () => false,
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 1);
  // The final check DID run — legacy rows are never failed blind.
  assert.equal(log.filter((c) => c.type === "hasSignatureLanded").length, 1);
});

test("runReapStuckTick does NOT fail a legacy row whose signature landed", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "legacy_landed",
        submittedAt: new Date("2026-04-26T09:00:00Z"),
        lastValidBlockHeight: null,
      }),
    ],
    hasSignatureLanded: async () => true,
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 0);
  assert.equal(log.filter((c) => c.type === "persistTransition").length, 0);
});

test("runReapStuckTick skips a SUBMITTED row with no txSignature (cannot verify — never fail blind)", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "sigless",
        txSignature: null,
        submittedAt: new Date("2026-04-26T09:00:00Z"),
        lastValidBlockHeight: null,
      }),
    ],
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 0);
  assert.equal(log.filter((c) => c.type === "persistTransition").length, 0);
});

// ============================================
// Age trigger semantics (unchanged from pre-D4)
// ============================================

test("runReapStuckTick does NOT reap a SUBMITTED payment that is still within maxAge", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "fresh",
        submittedAt: new Date("2026-04-26T10:09:00Z"),
      }),
    ],
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 0);
  assert.equal(result.scanned, 1);
  assert.equal(log.filter((c) => c.type === "persistTransition").length, 0);
  // Fresh rows never trigger chain lookups either.
  assert.equal(log.filter((c) => c.type === "getCurrentBlockHeight").length, 0);
});

test("runReapStuckTick treats a SUBMITTED payment with null submittedAt as not-reapable", async () => {
  // Pre-migration data could have null submittedAt; we don't reap
  // until we know the age. The next migration would backfill.
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [samplePayment({ id: "no-time", submittedAt: null })],
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 0);
  assert.equal(log.filter((c) => c.type === "persistTransition").length, 0);
});

// ============================================
// Mixed batch
// ============================================

test("runReapStuckTick processes a mixed batch and reports the right counts", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "stuck1",
        txSignature: "sig_stuck1",
        submittedAt: new Date("2026-04-26T10:00:00Z"),
        lastValidBlockHeight: 100n,
      }),
      samplePayment({
        id: "fresh",
        submittedAt: new Date("2026-04-26T10:08:00Z"),
      }),
      samplePayment({
        id: "stuck2",
        txSignature: "sig_stuck2",
        submittedAt: new Date("2026-04-26T09:50:00Z"),
        lastValidBlockHeight: null, // legacy
      }),
    ],
    currentBlockHeight: 200n,
    hasSignatureLanded: async () => false,
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.scanned, 3);
  assert.equal(result.reaped, 2);
  const persists = log.filter((c) => c.type === "persistTransition");
  assert.deepEqual(
    persists.map((c) => c.id).sort(),
    ["stuck1", "stuck2"],
  );
});

// ============================================
// Persistence error → bubble
// ============================================

test("runReapStuckTick bubbles persistTransition errors so BullMQ retries", async () => {
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { deps } = makeDeps({
    payments: [
      samplePayment({
        id: "stuck",
        submittedAt: new Date("2026-04-26T10:00:00Z"),
      }),
    ],
    hasSignatureLanded: async () => false,
    persistShouldThrow: true,
  });
  await assert.rejects(
    runReapStuckTick({ now: NOW, maxAgeSeconds: 300 }, deps as any),
    /persist failed/,
  );
});
