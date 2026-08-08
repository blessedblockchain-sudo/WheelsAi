import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextBlock,
  retrieveContextForAgent,
  type RetrieveContextDeps,
  type SearchLike,
} from "../services/agentRetrieval.js";

// Drives apps/api/src/services/agentRetrieval.ts (W2 RAG) — chat
// grounding. The invariants that matter: an unbound agent's chat must be
// untouched, the retrieval mode must travel with the result, and the
// injected context must never silently blow the context window.

function hit(over: Partial<SearchLike["results"][number]> = {}) {
  return {
    chunkId: "c1",
    documentId: "d1",
    documentTitle: "Handbook",
    content: "Refunds are processed within 5 business days.",
    score: 0.9,
    ...over,
  };
}

function makeDeps(
  over: {
    knowledgeBaseId?: string | null;
    search?: SearchLike;
  } = {},
): { deps: RetrieveContextDeps; searched: Array<{ query: string; limit: number }> } {
  const searched: Array<{ query: string; limit: number }> = [];
  const deps: RetrieveContextDeps = {
    loadKnowledgeBaseId: async () =>
      over.knowledgeBaseId === undefined ? "kb-1" : over.knowledgeBaseId,
    search: async (args) => {
      searched.push({ query: args.query, limit: args.limit });
      return (
        over.search ?? {
          results: [hit()],
          mode: "semantic" as const,
          fallbackReason: null,
        }
      );
    },
  };
  return { deps, searched };
}

test("an agent with no knowledge base retrieves nothing — chat is unchanged", async () => {
  const { deps, searched } = makeDeps({ knowledgeBaseId: null });
  const result = await retrieveContextForAgent(
    { agentId: "a1", orgId: "o1", query: "how do refunds work?" },
    deps,
  );
  assert.equal(result, null);
  assert.equal(searched.length, 0, "no search is issued for an unbound agent");
});

test("a bound agent gets grounded context with its sources and mode", async () => {
  const { deps, searched } = makeDeps();
  const result = await retrieveContextForAgent(
    { agentId: "a1", orgId: "o1", query: "how do refunds work?" },
    deps,
  );
  assert.ok(result);
  assert.equal(result.mode, "semantic");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]!.documentTitle, "Handbook");
  assert.match(result.contextBlock, /Refunds are processed/);
  assert.deepEqual(searched, [{ query: "how do refunds work?", limit: 4 }]);
});

test("keyword-mode retrieval is reported as keyword, with the reason", async () => {
  const { deps } = makeDeps({
    search: {
      results: [hit()],
      mode: "keyword",
      fallbackReason: "embeddings not configured (set EMBEDDING_PROVIDER)",
    },
  });
  const result = await retrieveContextForAgent(
    { agentId: "a1", orgId: "o1", query: "refunds" },
    deps,
  );
  assert.ok(result);
  assert.equal(result.mode, "keyword");
  assert.match(result.fallbackReason!, /not configured/);
});

test("low-scoring noise is dropped rather than grounded on", async () => {
  const { deps } = makeDeps({
    search: {
      results: [hit({ score: 0.02, content: "unrelated" })],
      mode: "semantic",
      fallbackReason: null,
    },
  });
  const result = await retrieveContextForAgent(
    { agentId: "a1", orgId: "o1", query: "refunds" },
    deps,
  );
  assert.equal(result, null, "nothing above the score floor ⇒ no grounding");
});

test("the context budget truncates a long passage instead of dropping the top hit", async () => {
  const long = "x".repeat(500);
  const { deps } = makeDeps({
    search: {
      results: [hit({ content: long })],
      mode: "semantic",
      fallbackReason: null,
    },
  });
  const result = await retrieveContextForAgent(
    { agentId: "a1", orgId: "o1", query: "q", maxContextChars: 100 },
    deps,
  );
  assert.ok(result);
  assert.equal(result.sources.length, 1, "top hit survives");
  assert.ok(
    result.sources[0]!.excerpt.length <= 101,
    "excerpt is truncated to the budget",
  );
  assert.match(result.sources[0]!.excerpt, /…$/);
});

test("the budget stops later passages once exhausted", async () => {
  const { deps } = makeDeps({
    search: {
      results: [
        hit({ chunkId: "c1", content: "a".repeat(80) }),
        hit({ chunkId: "c2", content: "b".repeat(80) }),
        hit({ chunkId: "c3", content: "c".repeat(80) }),
      ],
      mode: "semantic",
      fallbackReason: null,
    },
  });
  const result = await retrieveContextForAgent(
    { agentId: "a1", orgId: "o1", query: "q", maxContextChars: 100 },
    deps,
  );
  assert.ok(result);
  assert.equal(result.sources.length, 2, "third passage exceeds the budget");
});

test("an empty query never issues a search", async () => {
  const { deps, searched } = makeDeps();
  const result = await retrieveContextForAgent(
    { agentId: "a1", orgId: "o1", query: "   " },
    deps,
  );
  assert.equal(result, null);
  assert.equal(searched.length, 0);
});

test("the grounding prompt instructs the model to admit gaps, and numbers its sources", () => {
  const block = buildContextBlock([
    {
      chunkId: "c1",
      documentId: "d1",
      documentTitle: "Policy",
      score: 0.9,
      excerpt: "Returns accepted within 30 days.",
    },
    {
      chunkId: "c2",
      documentId: "d2",
      documentTitle: "FAQ",
      score: 0.7,
      excerpt: "Shipping is free over $50.",
    },
  ]);
  // A cited guess is worse than an honest gap — the instruction must be
  // present, or retrieval just makes hallucinations look sourced.
  assert.match(block, /do not cover the question, say so/);
  assert.match(block, /\[1\] Policy/);
  assert.match(block, /\[2\] FAQ/);
});
