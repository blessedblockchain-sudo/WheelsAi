/**
 * Composition root for the embedding backfill worker (W2 RAG): binds the
 * pure tick to Prisma + the configured embedding provider.
 *
 * The "pending" queries are the interesting part. A row needs embedding
 * when it has NO vector yet, OR when it was embedded by a DIFFERENT model
 * than the one now configured — otherwise a model switch would leave old
 * rows permanently invisible to search (they'd fail the dimension filter
 * forever). Raw SQL because `vector` is Unsupported in Prisma.
 */

import type { PrismaClient } from "@prisma/client";

import { resolveEmbeddingConfig } from "../config/embeddings.js";
import { createEmbeddings } from "./embeddings.js";
import type {
  BackfillRow,
  EmbeddingBackfillDeps,
} from "./runEmbeddingBackfillTick.js";
import { persistChunkEmbedding, persistMemoryEmbedding } from "./vectorSearch.js";

export function buildEmbeddingBackfillDeps(
  prisma: PrismaClient,
): EmbeddingBackfillDeps {
  return {
    getConfig: () => {
      const config = resolveEmbeddingConfig();
      return config ? { model: config.model } : null;
    },

    loadPendingChunks: async ({ model, limit }) =>
      prisma.$queryRawUnsafe<BackfillRow[]>(
        `SELECT id, content
           FROM document_chunks
          WHERE embedding_vec IS NULL
             OR embedding_model IS DISTINCT FROM $1
          ORDER BY created_at ASC
          LIMIT $2`,
        model,
        limit,
      ),

    loadPendingMemories: async ({ model, limit }) =>
      prisma.$queryRawUnsafe<BackfillRow[]>(
        `SELECT id, content
           FROM memory_contexts
          WHERE is_active = true
            AND (embedding_vec IS NULL
                 OR embedding_model IS DISTINCT FROM $1)
          ORDER BY created_at ASC
          LIMIT $2`,
        model,
        limit,
      ),

    embed: async (inputs) => {
      const config = resolveEmbeddingConfig();
      if (!config) throw new Error("embeddings not configured");
      const result = await createEmbeddings({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        input: inputs,
      });
      return { vectors: result.vectors, dimensions: result.dimensions };
    },

    persistChunk: (args) =>
      persistChunkEmbedding(prisma as never, {
        chunkId: args.id,
        vector: args.vector,
        model: args.model,
        dimensions: args.dimensions,
      }),

    persistMemory: (args) =>
      persistMemoryEmbedding(prisma as never, {
        memoryId: args.id,
        vector: args.vector,
        model: args.model,
        dimensions: args.dimensions,
      }),
  };
}
