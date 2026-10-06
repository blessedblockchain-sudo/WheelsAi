import { z } from "zod";

import { retrieveContextForAgent } from "../agentRetrieval.js";
import type { BuiltinSkillDeps } from "./builtinDeps.js";
import type { SkillDefinition } from "./types.js";

const inputSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.coerce.number().int().min(1).max(8).default(4),
});

const PROVIDER_ERROR = "embedding provider error";

/**
 * The fallback reason as a tenant may see it. Retrieval reports a provider
 * failure as "embedding provider error: <the provider's response body>", and
 * that body is the OPERATOR's: its org id, its quota, its usage. The reason a
 * model, a graph trace or a playground response carries keeps the fact (and
 * the HTTP status, which is ours to share) and drops the provider's words.
 * Every other reason is our own fixed text and passes through.
 */
export function publicFallbackReason(reason: string | null): string | null {
  if (!reason?.startsWith(PROVIDER_ERROR)) return reason;
  const status = /embeddings request failed: (\d{3})\b/.exec(reason)?.[1];
  return status ? `${PROVIDER_ERROR} (HTTP ${status})` : PROVIDER_ERROR;
}

/**
 * On-demand search of the agent's bound knowledge base, through the SAME
 * retrieval the playground grounds with. The retrieval MODE travels in the
 * output: word-overlap matching is useful but it is not semantic search, and
 * the model (and so the user) is told which one ran.
 */
export function createKnowledgeSearchSkill(deps: BuiltinSkillDeps): SkillDefinition {
  return {
    key: "knowledge_search",
    version: "1.0.0",
    name: "Knowledge Search",
    description:
      "Search this agent's knowledge base and return the best-matching passages with their source and retrieval mode. Needs a knowledge base bound to the agent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up in the knowledge base" },
        limit: { type: "number", description: "Maximum passages (1-8)", default: 4 },
      },
      required: ["query"],
    },
    moneyMoving: false,
    availability: (agent) =>
      agent?.hasKnowledgeBase === false
        ? { available: false, reason: "this agent has no knowledge base bound to it" }
        : { available: true },

    async execute(input, ctx) {
      if (!ctx.agentId || !ctx.orgId) {
        return { status: "unavailable", reason: "no agent context for this run" };
      }
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return { status: "error", message: "query must be a non-empty string" };
      }

      const knowledgeBaseId = await deps.knowledge.loadKnowledgeBaseId({
        agentId: ctx.agentId,
        orgId: ctx.orgId,
      });
      if (!knowledgeBaseId) {
        return { status: "unavailable", reason: "this agent has no knowledge base bound to it" };
      }

      const found = await retrieveContextForAgent(
        {
          agentId: ctx.agentId,
          orgId: ctx.orgId,
          query: parsed.data.query,
          limit: parsed.data.limit,
        },
        deps.knowledge,
      );
      if (!found) {
        return {
          status: "ok",
          output: "No passages in the knowledge base matched the query.",
        };
      }

      const fallbackReason = publicFallbackReason(found.fallbackReason);
      const modeLine =
        found.mode === "semantic"
          ? "retrieval mode: semantic"
          : `retrieval mode: keyword (word-overlap matching, not semantic${
              fallbackReason ? ` - ${fallbackReason}` : ""
            })`;
      const passages = found.sources.map(
        (s, i) => `[${i + 1}] ${s.documentTitle} (score ${s.score.toFixed(2)})\n${s.excerpt}`,
      );
      return {
        status: "ok",
        output: `${modeLine}\n\n${passages.join("\n\n")}`,
        data: { mode: found.mode, sources: found.sources },
      };
    },
  };
}
