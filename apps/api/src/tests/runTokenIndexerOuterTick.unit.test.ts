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

// Drives apps/api/src/services/runTokenIndexerOuterTick.ts — the
// outer loop for the token-trade-indexer BullMQ worker.
//
// Each outer tick:
//   1. loadActiveTokens()              → tokens to index
//   2. for each token, tickToken(...)  → runTokenTradeIndexerTick
//   3. counts {scanned, processed, failed} returned
//
// Per-token failure isolation: if one token's tick throws (RPC issue,
// pumpfun outage, transient DB error), the next token still runs.
// Errors counted in `failed`; `processed` only increments on success.

interface ActiveToken {
  id: string;
  mintAddress: string;
}

function makeDeps(opts: {
  tokens?: ActiveToken[];
  tickResult?: (token: ActiveToken) => Promise<{
    inserted: number;
    holderCount: number;
    totalBalance: number;
  }>;
  sinceFor?: (tokenId: string) => Date;
}) {
  const log: any[] = [];
  return {
    log,
    deps: {
      loadActiveTokens: async () => {
        log.push({ type: "loadActiveTokens" });
        return opts.tokens ?? [];
      },
      tickToken: async (token: ActiveToken, since: Date) => {
        log.push({ type: "tickToken", id: token.id, since });
        return (
          opts.tickResult?.(token) ??
          Promise.resolve({ inserted: 0, holderCount: 0, totalBalance: 0 })
        );
      },
      sinceFor: opts.sinceFor ?? ((_id) => new Date(0)),
    },
  };
}

const NOW = new Date("2026-04-26T10:00:00Z");

// ============================================
// Empty population
// ============================================

test("runTokenIndexerOuterTick is a no-op when no active tokens", async () => {
  setupEnv();
  const { runTokenIndexerOuterTick } = await import(
    "../services/runTokenIndexerOuterTick.js"
  );
  const { log, deps } = makeDeps({ tokens: [] });
  const result = await runTokenIndexerOuterTick(
    { now: NOW },
    deps as any,
  );
  assert.deepEqual(result, { scanned: 0, processed: 0, failed: 0 });
  assert.equal(log.filter((c) => c.type === "tickToken").length, 0);
});

// ============================================
// Iteration
// ============================================

test("runTokenIndexerOuterTick iterates every active token in order", async () => {
  const { runTokenIndexerOuterTick } = await import(
    "../services/runTokenIndexerOuterTick.js"
  );
  const { log, deps } = makeDeps({
    tokens: [
      { id: "a", mintAddress: "A" },
      { id: "b", mintAddress: "B" },
      { id: "c", mintAddress: "C" },
    ],
  });
  const result = await runTokenIndexerOuterTick(
    { now: NOW },
    deps as any,
  );
  assert.equal(result.scanned, 3);
  assert.equal(result.processed, 3);
  assert.equal(result.failed, 0);
  assert.deepEqual(
    log.filter((c) => c.type === "tickToken").map((c) => c.id),
    ["a", "b", "c"],
  );
});

// ============================================
// Per-token failure isolation
// ============================================

test("runTokenIndexerOuterTick counts a thrown tickToken as failed and continues", async () => {
  const { runTokenIndexerOuterTick } = await import(
    "../services/runTokenIndexerOuterTick.js"
  );
  const { log, deps } = makeDeps({
    tokens: [
      { id: "ok1", mintAddress: "A" },
      { id: "boom", mintAddress: "B" },
      { id: "ok2", mintAddress: "C" },
    ],
    tickResult: async (token) => {
      if (token.id === "boom") throw new Error("pumpfun 502");
      return { inserted: 0, holderCount: 0, totalBalance: 0 };
    },
  });
  const result = await runTokenIndexerOuterTick(
    { now: NOW },
    deps as any,
  );
  assert.equal(result.scanned, 3);
  assert.equal(result.processed, 2);
  assert.equal(result.failed, 1);
  // All three tokens were attempted — failure didn't break iteration.
  assert.equal(log.filter((c) => c.type === "tickToken").length, 3);
});

test("runTokenIndexerOuterTick swallows the error so BullMQ doesn't mark the whole tick failed", async () => {
  // Different from poll/submit drivers which throw on bubble: the
  // outer loop's job is to be best-effort across many tokens. A
  // single token's failure shouldn't trigger a BullMQ retry of the
  // whole batch (which would re-poll the OK tokens and risk
  // duplicate fetchTrades calls).
  const { runTokenIndexerOuterTick } = await import(
    "../services/runTokenIndexerOuterTick.js"
  );
  const { deps } = makeDeps({
    tokens: [{ id: "boom", mintAddress: "X" }],
    tickResult: async () => {
      throw new Error("indexer crash");
    },
  });
  // No throw expected — the tick swallows.
  const result = await runTokenIndexerOuterTick(
    { now: NOW },
    deps as any,
  );
  assert.equal(result.failed, 1);
});

// ============================================
// `since` cursor — passed per-token
// ============================================

test("runTokenIndexerOuterTick passes the per-token sinceFor cursor to each tick", async () => {
  // The "since" is the high-water mark per token — usually the
  // timestamp of the last successfully indexed trade. Different
  // per token, so the dep takes a tokenId arg.
  const { runTokenIndexerOuterTick } = await import(
    "../services/runTokenIndexerOuterTick.js"
  );
  const { log, deps } = makeDeps({
    tokens: [
      { id: "a", mintAddress: "A" },
      { id: "b", mintAddress: "B" },
    ],
    sinceFor: (id) =>
      id === "a"
        ? new Date("2026-04-25T00:00:00Z")
        : new Date("2026-04-26T00:00:00Z"),
  });
  await runTokenIndexerOuterTick({ now: NOW }, deps as any);
  const ticks = log.filter((c) => c.type === "tickToken");
  assert.equal(
    (ticks[0]!.since as Date).toISOString(),
    "2026-04-25T00:00:00.000Z",
  );
  assert.equal(
    (ticks[1]!.since as Date).toISOString(),
    "2026-04-26T00:00:00.000Z",
  );
});

// ============================================
// loadActiveTokens error → bubble
// ============================================

test("runTokenIndexerOuterTick bubbles loadActiveTokens errors so BullMQ retries", async () => {
  // If we can't even READ the active set, there's no point continuing.
  // Distinct from per-token failures (which we tolerate).
  const { runTokenIndexerOuterTick } = await import(
    "../services/runTokenIndexerOuterTick.js"
  );
  const deps = {
    loadActiveTokens: async () => {
      throw new Error("DB unreachable");
    },
    tickToken: async () => ({
      inserted: 0,
      holderCount: 0,
      totalBalance: 0,
    }),
    sinceFor: () => new Date(0),
  };
  await assert.rejects(
    runTokenIndexerOuterTick({ now: NOW }, deps as any),
    /DB unreachable/,
  );
});
