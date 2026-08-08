/**
 * pgvector similarity search (W2 RAG).
 *
 * Cosine distance via pgvector's `<=>` operator, expressed as raw SQL
 * because Prisma has no native `vector` type (the columns are
 * `Unsupported("vector")`).
 *
 * Two guards that are easy to miss and expensive to debug:
 *
 *   1. DIMENSION FILTER. The embedding columns are dimension-unspecified,
 *      so rows embedded by different models (768 vs 1536) can coexist.
 *      `<=>` throws on mismatched dimensions, which would turn one
 *      leftover row from an old model into a hard failure for every
 *      search. Queries therefore compare only rows whose recorded
 *      dimensions match the query vector's.
 *
 *   2. EXACT SEARCH, NO INDEX. There is no HNSW/IVFFlat index (see the
 *      schema comment): an ANN index requires pinning the column's
 *      dimension, which would make changing embedding model a migration.
 *      Sequential scan is exact and fine at current scale; the index is
 *      the follow-up once a model is settled on.
 *
 * Score convention: `1 - cosine_distance`, so 1.0 is identical and 0 is
 * orthogonal — matching the keyword path's 0..1 score so the two modes
 * are comparable in the same UI.
 */

import { toVectorLiteral } from "./embeddings.js";

export interface VectorSearchRow {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  chunkIndex: number;
  score: number;
}

/** Minimal structural surface — keeps this unit-testable without Prisma. */
export interface VectorSearchDb {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
}

export interface SearchChunksInput {
  knowledgeBaseId: string;
  queryVector: number[];
  dimensions: number;
  limit: number;
}

export async function searchChunksByVector(
  db: VectorSearchDb,
  input: SearchChunksInput,
): Promise<VectorSearchRow[]> {
  const literal = toVectorLiteral(input.queryVector);

  const rows = await db.$queryRawUnsafe<
    Array<{
      chunk_id: string;
      document_id: string;
      document_title: string;
      content: string;
      chunk_index: number;
      score: number;
    }>
  >(
    `SELECT c.id            AS chunk_id,
            c.document_id   AS document_id,
            d.title         AS document_title,
            c.content       AS content,
            c.chunk_index   AS chunk_index,
            1 - (c.embedding_vec <=> $1::vector) AS score
       FROM document_chunks c
       JOIN knowledge_documents d ON d.id = c.document_id
      WHERE d.knowledge_base_id = $2::uuid
        AND c.embedding_vec IS NOT NULL
        AND c.embedding_dims = $3
      ORDER BY c.embedding_vec <=> $1::vector
      LIMIT $4`,
    literal,
    input.knowledgeBaseId,
    input.dimensions,
    input.limit,
  );

  return rows.map((r) => ({
    chunkId: r.chunk_id,
    documentId: r.document_id,
    documentTitle: r.document_title,
    content: r.content,
    chunkIndex: r.chunk_index,
    // Postgres returns numeric as string through some drivers.
    score: typeof r.score === "number" ? r.score : Number(r.score),
  }));
}

export interface SearchMemoriesInput {
  conversationId: string;
  queryVector: number[];
  dimensions: number;
  limit: number;
}

export interface MemorySearchRow {
  memoryId: string;
  type: string;
  content: string;
  importance: number;
  score: number;
}

export async function searchMemoriesByVector(
  db: VectorSearchDb,
  input: SearchMemoriesInput,
): Promise<MemorySearchRow[]> {
  const literal = toVectorLiteral(input.queryVector);

  const rows = await db.$queryRawUnsafe<
    Array<{
      memory_id: string;
      type: string;
      content: string;
      importance: number;
      score: number;
    }>
  >(
    `SELECT m.id         AS memory_id,
            m.type       AS type,
            m.content    AS content,
            m.importance AS importance,
            1 - (m.embedding_vec <=> $1::vector) AS score
       FROM memory_contexts m
      WHERE m.conversation_id = $2::uuid
        AND m.is_active = true
        AND m.embedding_vec IS NOT NULL
        AND m.embedding_dims = $3
      ORDER BY m.embedding_vec <=> $1::vector
      LIMIT $4`,
    literal,
    input.conversationId,
    input.dimensions,
    input.limit,
  );

  return rows.map((r) => ({
    memoryId: r.memory_id,
    type: r.type,
    content: r.content,
    importance: typeof r.importance === "number" ? r.importance : Number(r.importance),
    score: typeof r.score === "number" ? r.score : Number(r.score),
  }));
}

/** Writes a vector onto a chunk row (raw SQL — `vector` is unsupported by Prisma). */
export async function persistChunkEmbedding(
  db: VectorSearchDb,
  args: {
    chunkId: string;
    vector: number[];
    model: string;
    dimensions: number;
  },
): Promise<void> {
  await db.$queryRawUnsafe(
    `UPDATE document_chunks
        SET embedding_vec = $1::vector,
            embedding_model = $2,
            embedding_dims = $3,
            embedded_at = NOW()
      WHERE id = $4::uuid`,
    toVectorLiteral(args.vector),
    args.model,
    args.dimensions,
    args.chunkId,
  );
}

/** Writes a vector onto a memory row. */
export async function persistMemoryEmbedding(
  db: VectorSearchDb,
  args: {
    memoryId: string;
    vector: number[];
    model: string;
    dimensions: number;
  },
): Promise<void> {
  await db.$queryRawUnsafe(
    `UPDATE memory_contexts
        SET embedding_vec = $1::vector,
            embedding_model = $2,
            embedding_dims = $3,
            embedded_at = NOW()
      WHERE id = $4::uuid`,
    toVectorLiteral(args.vector),
    args.model,
    args.dimensions,
    args.memoryId,
  );
}
