/**
 * GET /agents — paginated dashboard agent list.
 *
 * Each entry carries enough summary state that the dashboard can render a
 * useful card without a follow-up fetch (treasury balance, deployment
 * count, token status). The runway numbers themselves stay on
 * /agents/:slug/runway so the dashboard list isn't blocked by a price
 * oracle call per row.
 *
 * Persistence is dependency-injected so this route is unit-testable
 * without Prisma; the production wiring (loadAgentListByPrisma) is a
 * thin follow-on slice.
 */

import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SORT = "newest";

export type AgentListSort =
  | "newest"
  | "oldest"
  | "name"
  | "treasury_balance_desc";

export interface AgentListEntry {
  id: string;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
  treasuryBalanceLamports: bigint | null;
  activeDeploymentCount: number;
  tokenStatus: "not_tokenized" | "bonding" | "graduated";
}

export interface AgentListResult {
  agents: AgentListEntry[];
  totalCount: number;
}

export interface AgentListDeps {
  loadAgentList: (args: {
    orgId: string;
    limit: number;
    offset: number;
    sort: AgentListSort;
  }) => Promise<AgentListResult>;
}

const querySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z
    .enum(["newest", "oldest", "name", "treasury_balance_desc"])
    .optional(),
});

function serialize(entry: AgentListEntry) {
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    framework: entry.framework,
    createdAt: entry.createdAt.toISOString(),
    treasuryBalanceLamports:
      entry.treasuryBalanceLamports === null
        ? null
        : entry.treasuryBalanceLamports.toString(),
    activeDeploymentCount: entry.activeDeploymentCount,
    tokenStatus: entry.tokenStatus,
  };
}

export function createAgentListRoutes(
  deps: AgentListDeps,
): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Querystring: Record<string, string> }>(
      "/agents",
      async (request, reply) => {
        if (!request.auth) {
          return reply.status(401).send({ error: "unauthenticated" });
        }
        const { orgId } = request.auth;

        const parsed = querySchema.safeParse(request.query);
        if (!parsed.success) {
          return reply.status(400).send({ error: "invalid_query" });
        }
        const limit = parsed.data.limit ?? DEFAULT_LIMIT;
        const offset = parsed.data.offset ?? 0;
        const sort = (parsed.data.sort ?? DEFAULT_SORT) as AgentListSort;

        const result = await deps.loadAgentList({ orgId, limit, offset, sort });
        return reply.status(200).send({
          agents: result.agents.map(serialize),
          totalCount: result.totalCount,
          limit,
          offset,
          sort,
        });
      },
    );
  };
}
