/**
 * Embedding client (W2 RAG) — OpenAI-compatible `/embeddings`.
 *
 * One provider-agnostic call shape (`{model, input: string[]}` →
 * `{data: [{index, embedding}]}`) works across OpenAI, Together, and
 * Google's OpenAI-compat endpoint, so adding a provider is a config
 * entry, not a code path.
 *
 * Contract:
 *   - Vectors come back in INPUT ORDER. Providers are supposed to return
 *     `index` on each item but not all do reliably, so responses are
 *     re-sorted by it when present and length-checked either way —
 *     mis-ordered embeddings would silently attach the wrong vector to
 *     the wrong chunk, which is invisible until search quality dies.
 *   - Every vector in one response must share a dimension count. A
 *     provider changing dimensions mid-batch is a hard error, not
 *     something to average over.
 *   - Failures throw with the provider's own message. Callers decide
 *     whether to degrade (search) or leave rows unembedded (backfill).
 *
 * `fetchImpl` is injectable so this is unit-testable without a network.
 */

export interface EmbeddingRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  input: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface EmbeddingResult {
  /** One vector per input, in input order. */
  vectors: number[][];
  dimensions: number;
  model: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function createEmbeddings(
  req: EmbeddingRequest,
): Promise<EmbeddingResult> {
  if (req.input.length === 0) {
    return { vectors: [], dimensions: 0, model: req.model };
  }

  const doFetch = req.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await doFetch(`${req.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({ model: req.model, input: req.input }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `embeddings request failed: ${res.status} ${detail.slice(0, 300)}`,
    );
  }

  const body = (await res.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
    model?: string;
  };
  const items = body.data;
  if (!Array.isArray(items)) {
    throw new Error("embeddings response missing `data` array");
  }
  if (items.length !== req.input.length) {
    throw new Error(
      `embeddings response length mismatch: sent ${req.input.length}, received ${items.length}`,
    );
  }

  // Re-sort by `index` when the provider supplies it; otherwise trust the
  // documented input order. Either way the vector→input pairing is
  // explicit rather than assumed.
  const ordered = items.every((it) => typeof it.index === "number")
    ? [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    : items;

  const vectors: number[][] = [];
  let dimensions = 0;
  for (const [i, item] of ordered.entries()) {
    const vec = item.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error(`embeddings response item ${i} has no embedding`);
    }
    if (dimensions === 0) {
      dimensions = vec.length;
    } else if (vec.length !== dimensions) {
      throw new Error(
        `embeddings response has mixed dimensions (${dimensions} vs ${vec.length})`,
      );
    }
    vectors.push(vec);
  }

  return { vectors, dimensions, model: body.model ?? req.model };
}

/**
 * Formats a vector as a pgvector literal: `[0.1,0.2,...]`.
 *
 * Used for parameterized raw SQL — pgvector accepts the literal cast to
 * `::vector`. Non-finite values are refused rather than serialized as
 * `NaN`/`Infinity`, which Postgres would reject with a far less obvious
 * error at insert time.
 */
export function toVectorLiteral(vector: number[]): string {
  if (vector.length === 0) {
    throw new Error("toVectorLiteral: empty vector");
  }
  for (const v of vector) {
    if (!Number.isFinite(v)) {
      throw new Error("toVectorLiteral: vector contains a non-finite value");
    }
  }
  return `[${vector.join(",")}]`;
}
