/**
 * Composition root for agent RAG retrieval (W2): binds the pure
 * retrieveContextForAgent to Prisma + the knowledge search service.
 *
 * Search goes through `searchKnowledgeBase` rather than straight to
 * pgvector on purpose — the chat path then inherits the exact same
 * semantic/keyword decision and the same honest `mode` the search API
 * reports, instead of growing a second retrieval policy that could
 * silently disagree with it.
 */

import { prisma } from "../lib/prisma.js";
import type { RetrieveContextDeps } from "./agentRetrieval.js";
import { searchKnowledgeBase } from "./knowledge.js";

export function buildAgentRetrievalDeps(): RetrieveContextDeps {
  return {
    loadKnowledgeBaseId: async ({ agentId, orgId }) => {
      const agent = await prisma.agent.findFirst({
        where: { id: agentId, orgId },
        select: { knowledgeBaseId: true },
      });
      return agent?.knowledgeBaseId ?? null;
    },

    search: async ({ knowledgeBaseId, orgId, query, limit }) => {
      const found = await searchKnowledgeBase(knowledgeBaseId, orgId, {
        query,
        limit,
      });
      return {
        results: found.results,
        mode: found.mode,
        fallbackReason: found.fallbackReason,
      };
    },
  };
}
