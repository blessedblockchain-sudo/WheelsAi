import assert from "node:assert/strict";
import test from "node:test";

import {
  runEmbeddingBackfillTick,
  type EmbeddingBackfillDeps,
} from "../services/runEmbeddingBackfillTick.js";

// Drives the pure embedding-backfill tick (W2 RAG). The property that
// matters: content created before a provider existed must become
// searchable, and a provider outage must not lose or corrupt rows.

interface Recorded {
  embedCalls: string[][];
  chunks: Array<{ id: string; model: string; dimensions: number }>;
  memories: Array<{ id: string; model: string; dimensions: number }>;
  pendingArgs: Array<{ model: string; limit: number }>;
}

function makeDeps(
  over: Partial<EmbeddingBackfillDeps> = {},
): { deps: EmbeddingBackfillDeps; rec: Recorded } {
  const rec: Recorded = {
    embedCalls: [],
    chunks: [],
    memories: [],
    pendingArgs: [],
  };
  const deps: EmbeddingBackfillDeps = {
    getConfig: () => ({ model: "text-embedding-3-small" }),
    loadPendingChunks: async (args) => {
      rec.pendingArgs.push(args);
      return [{ id: "c1", content: "chunk one" }];
    },
    loadPendingMemories: async () => [{ id: "m1", content: "memory one" }],
    embed: async (inputs) => {
      rec.embedCalls.push(inputs);
      return { vectors: inputs.map(() => [0.1, 0.2]), dimensions: 2 };
    },
    persistChunk: async (a) => {
      rec.chunks.push({ id: a.id, model: a.model, dimensions: a.dimensions });
    },
    persistMemory: async (a) => {
      rec.memories.push({ id: a.id, model: a.model, dimensions: a.dimensions });
    },
    ...over,
  };
  return { deps, rec };
}

test("no provider configured: the tick no-ops and says it is disabled", async () => {
  const { deps, rec } = makeDeps({ getConfig: () => null });
  const res = await runEmbeddingBackfillTick({ limit: 10 }, deps);
  assert.equal(res.enabled, false);
  assert.equal(res.chunksEmbedded, 0);
  assert.equal(rec.embedCalls.length, 0, "never calls a provider it doesn't have");
});

test("pending chunks and memories are embedded and persisted with model + dims", async () => {
  const { deps, rec } = makeDeps();
  const res = await runEmbeddingBackfillTick({ limit: 25 }, deps);
  assert.equal(res.enabled, true);
  assert.equal(res.chunksEmbedded, 1);
  assert.equal(res.memoriesEmbedded, 1);
  assert.deepEqual(rec.chunks, [
    { id: "c1", model: "text-embedding-3-small", dimensions: 2 },
  ]);
  assert.deepEqual(rec.memories, [
    { id: "m1", model: "text-embedding-3-small", dimensions: 2 },
  ]);
  // The configured model is passed to the pending query — that's what
  // makes "embedded by a DIFFERENT model" re-embeddable.
  assert.deepEqual(rec.pendingArgs, [
    { model: "text-embedding-3-small", limit: 25 },
  ]);
});

test("a provider failure embeds nothing and counts the batch, leaving rows pending", async () => {
  const { deps, rec } = makeDeps({
    embed: async () => {
      throw new Error("429 rate limited");
    },
  });
  const res = await runEmbeddingBackfillTick({ limit: 10 }, deps);
  assert.equal(res.chunksEmbedded, 0);
  assert.equal(res.memoriesEmbedded, 0);
  assert.equal(res.failedBatches, 2, "both batches reported as failed");
  assert.equal(rec.chunks.length, 0, "nothing persisted from a failed batch");
});

test("one row failing to persist does not lose the rest of a paid-for batch", async () => {
  let calls = 0;
  const { deps, rec } = makeDeps({
    loadPendingChunks: async () => [
      { id: "c1", content: "one" },
      { id: "c2", content: "two" },
      { id: "c3", content: "three" },
    ],
    loadPendingMemories: async () => [],
    persistChunk: async (a) => {
      calls += 1;
      if (a.id === "c2") throw new Error("row locked");
      rec.chunks.push({ id: a.id, model: a.model, dimensions: a.dimensions });
    },
  });
  const res = await runEmbeddingBackfillTick({ limit: 10 }, deps);
  assert.equal(calls, 3, "every row attempted");
  assert.equal(res.chunksEmbedded, 2);
  assert.deepEqual(rec.chunks.map((c) => c.id), ["c1", "c3"]);
});

test("an empty backlog costs no provider call", async () => {
  const { deps, rec } = makeDeps({
    loadPendingChunks: async () => [],
    loadPendingMemories: async () => [],
  });
  const res = await runEmbeddingBackfillTick({ limit: 10 }, deps);
  assert.equal(res.enabled, true);
  assert.equal(res.chunksEmbedded, 0);
  assert.equal(rec.embedCalls.length, 0, "billed API not called for nothing");
});

test("vectors are paired to rows by position, not by iteration luck", async () => {
  const { deps, rec } = makeDeps({
    loadPendingChunks: async () => [
      { id: "first", content: "a" },
      { id: "second", content: "b" },
    ],
    loadPendingMemories: async () => [],
    embed: async () => ({
      vectors: [
        [1, 0],
        [0, 1],
      ],
      dimensions: 2,
    }),
    persistChunk: async (a) => {
      rec.chunks.push({ id: a.id, model: a.model, dimensions: a.dimensions });
      // Capture the actual vector for the pairing assertion.
      (rec as unknown as { vectors?: Record<string, number[]> }).vectors ??= {};
      (rec as unknown as { vectors: Record<string, number[]> }).vectors[a.id] =
        a.vector;
    },
  });
  await runEmbeddingBackfillTick({ limit: 10 }, deps);
  const vectors = (rec as unknown as { vectors: Record<string, number[]> })
    .vectors;
  assert.deepEqual(vectors.first, [1, 0]);
  assert.deepEqual(vectors.second, [0, 1]);
});
