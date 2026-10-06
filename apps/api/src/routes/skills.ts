/**
 * GET /api/skills - the skills (tools) catalogue with honest availability.
 *
 * The agent wizard and the playground's tools sidebar are driven from this,
 * so what a user can tick is exactly what the runtime can execute, and a tool
 * that needs server configuration says so instead of looking ready.
 *
 *   ?agentId=<uuid>  optional; folds in agent-level facts (for example
 *                    knowledge_search needs a bound knowledge base).
 *
 * Availability is reported, never hidden: an unavailable skill is still
 * listed, with `available: false` and a reason a user can read.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import type { SkillRegistry } from "../services/skills/registry.js";

export interface SkillsRouteDeps {
  /** Defaults to the production registry (loaded lazily). */
  getRegistry?: () => Promise<SkillRegistry> | SkillRegistry;
  /** Resolves agent-level availability facts, scoped to the org. */
  loadAgentFacts?: (args: {
    agentId: string;
    orgId: string;
  }) => Promise<{ hasKnowledgeBase: boolean } | null>;
}

const querySchema = z.object({ agentId: z.string().uuid().optional() });

export function createSkillsRoutes(deps: SkillsRouteDeps = {}): FastifyPluginAsync {
  return async (app) => {
    app.get(
      "/skills",
      {
        preHandler: [requireAuth],
        schema: {
          tags: ["Skills"],
          description: "List agent skills (tools) with availability and the reason when unavailable",
        },
      },
      async (request, reply) => {
        const query = querySchema.safeParse(request.query);
        if (!query.success) return reply.badRequest("agentId must be a UUID");
        const orgId = request.auth!.orgId;

        let agentFacts: { hasKnowledgeBase: boolean } | undefined;
        if (query.data.agentId) {
          const loader =
            deps.loadAgentFacts ??
            (async ({ agentId, orgId: org }) => {
              const { prisma } = await import("../lib/prisma.js");
              const agent = await prisma.agent.findFirst({
                where: { id: agentId, orgId: org },
                select: { knowledgeBaseId: true },
              });
              return agent ? { hasKnowledgeBase: Boolean(agent.knowledgeBaseId) } : null;
            });
          const facts = await loader({ agentId: query.data.agentId, orgId });
          if (!facts) return reply.notFound("Agent not found");
          agentFacts = facts;
        }

        const registry = deps.getRegistry
          ? await deps.getRegistry()
          : (await import("../services/skills/production.js")).getDefaultRegistry();

        return { skills: registry.describe(agentFacts) };
      },
    );
  };
}

export const skillsRoutes: FastifyPluginAsync = createSkillsRoutes();
