/**
 * RAG retrieval for agent chat (W2).
 *
 * When an agent is bound to a knowledge base, its chat turns are grounded
 * in retrieved passages instead of the model's parametric memory alone.
 *
 * Design decisions worth stating:
 *
 *   - Grounding is INJECTED AS A SYSTEM MESSAGE, not concatenated into
 *     the user's turn. Rewriting what the user said would corrupt the
 *     conversation transcript and any later replay of it.
 *
 *   - The prompt tells the model to say when the passages don't cover the
 *     question. Retrieval that silently licenses confident guessing is
 *     worse than no retrieval, because the citations make the guess look
 *     sourced.
 *
 *   - The retrieval MODE travels with the result (`semantic` vs
 *     `keyword`). Grounding by word overlap is legitimate and useful, but
 *     it is not semantic retrieval, and the caller says which one ran
 *     rather than letting the UI imply the better one.
 *
 *   - No knowledge base bound, or nothing retrieved ⇒ null, and the chat
 *     path is byte-for-byte what it was before. Binding a KB is the only
 *     thing that changes behavior.
 */

export interface RetrievedSource {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  score: number;
  excerpt: string;
}

export interface RetrievalResult {
  /** Prepend to the message list as a system turn. */
  contextBlock: string;
  sources: RetrievedSource[];
  mode: "semantic" | "keyword";
  /** Present when the search fell back; null when semantic ran. */
  fallbackReason: string | null;
}

export interface SearchLike {
  results: Array<{
    chunkId: string;
    documentId: string;
    documentTitle: string;
    content: string;
    score: number;
  }>;
  mode: "semantic" | "keyword";
  fallbackReason: string | null;
}

export interface RetrieveContextDeps {
  /** Resolves the agent's bound knowledge base, or null when unbound. */
  loadKnowledgeBaseId: (args: {
    agentId: string;
    orgId: string;
  }) => Promise<string | null>;
  search: (args: {
    knowledgeBaseId: string;
    orgId: string;
    query: string;
    limit: number;
  }) => Promise<SearchLike>;
}

export interface RetrieveContextInput {
  agentId: string;
  orgId: string;
  /** Usually the latest user message. */
  query: string;
  limit?: number;
  /** Chunks below this score are dropped as noise. */
  minScore?: number;
  /** Cap on characters injected, so grounding can't eat the context window. */
  maxContextChars?: number;
}

const DEFAULT_LIMIT = 4;
const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_MAX_CONTEXT_CHARS = 6_000;

export function buildContextBlock(sources: RetrievedSource[]): string {
  const passages = sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.documentTitle}\n${s.excerpt}`,
    )
    .join("\n\n");

  return [
    "You have been given passages retrieved from this agent's knowledge base.",
    "Ground your answer in them and cite the passage numbers you use, like [1].",
    "If the passages do not cover the question, say so plainly instead of guessing —",
    "a cited guess is worse than an honest gap.",
    "",
    "--- retrieved passages ---",
    passages,
    "--- end passages ---",
  ].join("\n");
}

export async function retrieveContextForAgent(
  input: RetrieveContextInput,
  deps: RetrieveContextDeps,
): Promise<RetrievalResult | null> {
  const query = input.query.trim();
  if (query.length === 0) return null;

  const knowledgeBaseId = await deps.loadKnowledgeBaseId({
    agentId: input.agentId,
    orgId: input.orgId,
  });
  if (!knowledgeBaseId) return null;

  const limit = input.limit ?? DEFAULT_LIMIT;
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
  const maxChars = input.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;

  const found = await deps.search({
    knowledgeBaseId,
    orgId: input.orgId,
    query,
    limit,
  });

  const kept: RetrievedSource[] = [];
  let budget = maxChars;
  for (const r of found.results) {
    if (r.score < minScore) continue;
    if (budget <= 0) break;
    // Truncate a long chunk rather than dropping it: a partial passage
    // still grounds, and silently omitting the top hit because it was
    // long would be the worst outcome.
    const excerpt =
      r.content.length > budget ? `${r.content.slice(0, budget)}…` : r.content;
    budget -= excerpt.length;
    kept.push({
      chunkId: r.chunkId,
      documentId: r.documentId,
      documentTitle: r.documentTitle,
      score: r.score,
      excerpt,
    });
  }

  if (kept.length === 0) return null;

  return {
    contextBlock: buildContextBlock(kept),
    sources: kept,
    mode: found.mode,
    fallbackReason: found.fallbackReason,
  };
}
