import assert from "node:assert/strict";
import test from "node:test";

import {
  persistChunkEmbedding,
  searchChunksByVector,
  searchMemoriesByVector,
} from "../services/vectorSearch.js";

// Drives apps/api/src/services/vectorSearch.ts (W2 RAG). The SQL itself is
// verified against real Postgres by scripts/verify-pgvector.ts (cosine
// ordering, score math, dimension exclusion); these pin the query SHAPE —
// specifically the guards that are invisible until they're missing.

function makeDb() {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    $queryRawUnsafe: async <T>(query: string, ...values: unknown[]): Promise<T> => {
      calls.push({ query, values });
      return [] as unknown as T;
    },
  };
  return { db, calls };
}

test("chunk search filters by dimension — mismatched vectors would make pgvector throw", async () => {
  const { db, calls } = makeDb();
  await searchChunksByVector(db, {
    knowledgeBaseId: "kb-1",
    queryVector: [1, 0, 0],
    dimensions: 3,
    limit: 5,
  });
  const { query, values } = calls[0]!;
  assert.match(query, /embedding_dims = \$3/, "dimension filter present");
  assert.match(query, /embedding_vec IS NOT NULL/, "unembedded rows excluded");
  assert.deepEqual(values, ["[1,0,0]", "kb-1", 3, 5]);
});

test("chunk search orders by cosine distance and scores as 1-distance", async () => {
  const { db, calls } = makeDb();
  await searchChunksByVector(db, {
    knowledgeBaseId: "kb-1",
    queryVector: [1, 0],
    dimensions: 2,
    limit: 3,
  });
  const { query } = calls[0]!;
  assert.match(query, /ORDER BY c\.embedding_vec <=> \$1::vector/);
  assert.match(query, /1 - \(c\.embedding_vec <=> \$1::vector\) AS score/);
});

test("chunk search is scoped to the knowledge base (no cross-tenant leakage)", async () => {
  const { db, calls } = makeDb();
  await searchChunksByVector(db, {
    knowledgeBaseId: "kb-1",
    queryVector: [1],
    dimensions: 1,
    limit: 1,
  });
  assert.match(calls[0]!.query, /d\.knowledge_base_id = \$2::uuid/);
});

test("memory search is scoped to the conversation and skips inactive memories", async () => {
  const { db, calls } = makeDb();
  await searchMemoriesByVector(db, {
    conversationId: "conv-1",
    queryVector: [0, 1],
    dimensions: 2,
    limit: 4,
  });
  const { query, values } = calls[0]!;
  assert.match(query, /m\.conversation_id = \$2::uuid/);
  assert.match(query, /m\.is_active = true/);
  assert.match(query, /embedding_dims = \$3/);
  assert.deepEqual(values, ["[0,1]", "conv-1", 2, 4]);
});

test("string scores from the driver are coerced to numbers", async () => {
  const db = {
    $queryRawUnsafe: async <T>(): Promise<T> =>
      [
        {
          chunk_id: "c1",
          document_id: "d1",
          document_title: "t",
          content: "hello",
          chunk_index: 0,
          score: "0.87" as unknown as number,
        },
      ] as unknown as T,
  };
  const rows = await searchChunksByVector(db, {
    knowledgeBaseId: "kb",
    queryVector: [1],
    dimensions: 1,
    limit: 1,
  });
  assert.equal(rows[0]!.score, 0.87);
  assert.equal(typeof rows[0]!.score, "number");
});

test("persisting an embedding records the model and dimensions with the vector", async () => {
  const { db, calls } = makeDb();
  await persistChunkEmbedding(db, {
    chunkId: "chunk-1",
    vector: [0.1, 0.2],
    model: "text-embedding-3-small",
    dimensions: 2,
  });
  const { query, values } = calls[0]!;
  assert.match(query, /embedding_vec = \$1::vector/);
  assert.match(query, /embedded_at = NOW\(\)/);
  // Model + dims travel WITH the vector: without them the dimension
  // filter can't work and a model change can't be detected.
  assert.deepEqual(values, ["[0.1,0.2]", "text-embedding-3-small", 2, "chunk-1"]);
});
