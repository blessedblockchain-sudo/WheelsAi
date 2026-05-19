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
// scan-and-dispatch driver for the stuck-submission reaper.
//
// Each tick:
//   1. loadStuckCandidates(now)        → SUBMITTED rows with submittedAt
//   2. reapStuckSubmissions(...)       (pure; classifies stuck vs OK)
//   3. for each changed result, persistTransition(id, "failed/expired")
//   4. counts {reaped, scanned} returned
//
// Reaping rule: a SUBMITTED row whose submittedAt is older than
// maxAgeSeconds is moved to FAILED with reason "blockhash_expired".
// The poll worker would have ack'd CONFIRMED long ago if the tx
// landed; if it didn't, the blockhash has expired and the tx will
// never confirm.

interface ReaperPayment {
  id: string;
  status: "SUBMITTED" | "PENDING" | "CONFIRMED" | "FAILED";
  txSignature: string | null;
  errorMessage: string | null;
  paidAt: Date | null;
  retryCount: number;
  submittedAt: Date | null;
}

function makeDeps(opts: {
  payments?: ReaperPayment[];
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
  ...overrides,
});

const NOW = new Date("2026-04-26T10:10:00Z");

// ============================================
// Empty batch
// ============================================

test("runReapStuckTick returns zeros when no candidates", async () => {
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
});

// ============================================
// Reaping logic — load-bearing on cutoff
// ============================================

test("runReapStuckTick reaps a SUBMITTED payment whose submittedAt is older than maxAge", async () => {
  // Stuck: submittedAt is 10 minutes ago, maxAge is 5 minutes.
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({
        id: "stuck",
        submittedAt: new Date("2026-04-26T10:00:00Z"),
      }),
    ],
  });
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps as any,
  );
  assert.equal(result.reaped, 1);
  assert.equal(result.scanned, 1);
  const persist = log.find((c) => c.type === "persistTransition");
  assert.equal(persist.id, "stuck");
  // The transition reason — "blockhash_expired" — is what
  // reapStuckSubmissions emits via markFailed.
  assert.equal(persist.transition.errorMessage, "blockhash_expired");
});

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
});

test("runReapStuckTick treats a SUBMITTED payment with null submittedAt as not-reapable", async () => {
  // Pre-migration data could have null submittedAt; we don't reap
  // until we know the age. The next migration would backfill.
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const { log, deps } = makeDeps({
    payments: [
      samplePayment({ id: "no-time", submittedAt: null }),
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
        submittedAt: new Date("2026-04-26T10:00:00Z"),
      }),
      samplePayment({
        id: "fresh",
        submittedAt: new Date("2026-04-26T10:08:00Z"),
      }),
      samplePayment({
        id: "stuck2",
        submittedAt: new Date("2026-04-26T09:50:00Z"),
      }),
    ],
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
    persistShouldThrow: true,
  });
  await assert.rejects(
    runReapStuckTick({ now: NOW, maxAgeSeconds: 300 }, deps as any),
    /persist failed/,
  );
});
