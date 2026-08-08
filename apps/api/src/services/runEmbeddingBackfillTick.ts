/**
 * Embedding backfill tick (W2 RAG) — one call = one pass of the BullMQ
 * backfill worker. Pure orchestration; every IO surface is DI'd.
 *
 * Why this worker exists: embeddings are computed on the upload path, so
 * content created BEFORE a provider was configured — or while the
 * provider was failing — has no vector and is invisible to semantic
 * search. Without a backfill, turning embeddings on only helps future
 * documents, and the knowledge base silently splits into a searchable
 * half and an unsearchable one.
 *
 * It also handles a model CHANGE: rows carry the model that embedded
 * them, so anything embedded by a different model than the configured
 * one is re-embedded rather than left to fail the dimension filter
 * forever.
 *
 * Batch failure is isolated per batch, not per row: embedding APIs are
 * billed and rate-limited per request, so one bad batch backs off and the
 * next tick retries rather than hammering the provider row by row.
 */

export interface BackfillRow {
  id: string;
  content: string;
}

export interface EmbeddingBackfillDeps {
  /** Null when no provider is configured — the tick then no-ops. */
  getConfig: () => { model: string } | null;
  loadPendingChunks: (args: {
    model: string;
    limit: number;
  }) => Promise<BackfillRow[]>;
  loadPendingMemories: (args: {
    model: string;
    limit: number;
  }) => Promise<BackfillRow[]>;
  embed: (inputs: string[]) => Promise<{ vectors: number[][]; dimensions: number }>;
  persistChunk: (args: {
    id: string;
    vector: number[];
    model: string;
    dimensions: number;
  }) => Promise<void>;
  persistMemory: (args: {
    id: string;
    vector: number[];
    model: string;
    dimensions: number;
  }) => Promise<void>;
}

export interface EmbeddingBackfillResult {
  enabled: boolean;
  chunksEmbedded: number;
  memoriesEmbedded: number;
  failedBatches: number;
}

async function backfillBatch(
  rows: BackfillRow[],
  model: string,
  embed: EmbeddingBackfillDeps["embed"],
  persist: (args: {
    id: string;
    vector: number[];
    model: string;
    dimensions: number;
  }) => Promise<void>,
): Promise<{ embedded: number; failed: boolean }> {
  if (rows.length === 0) return { embedded: 0, failed: false };

  let result: { vectors: number[][]; dimensions: number };
  try {
    result = await embed(rows.map((r) => r.content));
  } catch {
    // Provider error (rate limit, outage, bad key). Leave the rows
    // unembedded — they stay pending and the next tick retries.
    return { embedded: 0, failed: true };
  }

  let embedded = 0;
  for (const [i, row] of rows.entries()) {
    const vector = result.vectors[i];
    if (!vector) continue;
    try {
      await persist({
        id: row.id,
        vector,
        model,
        dimensions: result.dimensions,
      });
      embedded += 1;
    } catch {
      // A single row failing to persist must not lose the rest of a
      // batch we already paid the provider for.
    }
  }
  return { embedded, failed: false };
}

export async function runEmbeddingBackfillTick(
  input: { limit: number },
  deps: EmbeddingBackfillDeps,
): Promise<EmbeddingBackfillResult> {
  const config = deps.getConfig();
  if (!config) {
    return {
      enabled: false,
      chunksEmbedded: 0,
      memoriesEmbedded: 0,
      failedBatches: 0,
    };
  }

  const [chunks, memories] = await Promise.all([
    deps.loadPendingChunks({ model: config.model, limit: input.limit }),
    deps.loadPendingMemories({ model: config.model, limit: input.limit }),
  ]);

  const chunkOutcome = await backfillBatch(
    chunks,
    config.model,
    deps.embed,
    deps.persistChunk,
  );
  const memoryOutcome = await backfillBatch(
    memories,
    config.model,
    deps.embed,
    deps.persistMemory,
  );

  return {
    enabled: true,
    chunksEmbedded: chunkOutcome.embedded,
    memoriesEmbedded: memoryOutcome.embedded,
    failedBatches:
      (chunkOutcome.failed ? 1 : 0) + (memoryOutcome.failed ? 1 : 0),
  };
}
