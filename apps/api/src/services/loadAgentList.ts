/**
 * Prisma-backed loadAgentList (companion to routes/agentList.ts).
 *
 * Resolves the dashboard list page in two SQL trips:
 *   prisma.agent.findMany — agent + nested deployments + listing.agentToken.treasury
 *   prisma.agent.count    — totalCount for pagination
 *
 * tokenStatus mapping:
 *   no listing or no agentToken                 → "not_tokenized"
 *   agentToken.status === "BONDING"             → "bonding"
 *   agentToken.status === "GRADUATED"           → "graduated"
 *
 * activeDeploymentCount = sum of replicas across deployments where
 *   status === "running" (stopped/failed deployments are excluded so the
 *   dashboard reflects active capacity).
 *
 * Sort:
 *   newest                  → orderBy { createdAt: desc }
 *   oldest                  → orderBy { createdAt: asc }
 *   name                    → orderBy { name: asc }
 *   treasury_balance_desc   → the substance sort: funded treasuries
 *                             first (balance desc), untokenized agents
 *                             last, createdAt desc as the tiebreak.
 *                             Ordered in memory: Prisma can traverse the
 *                             to-one chain in orderBy but can't control
 *                             NULLS placement through a null relation
 *                             (Postgres DESC = NULLS FIRST — empty
 *                             agents would top the "substance" sort).
 *                             The list is org-scoped, so the full fetch
 *                             is bounded; pagination is applied after
 *                             the in-memory order.
 */

import type {
  AgentListEntry,
  AgentListResult,
  AgentListSort,
} from "../routes/agentList.js";

interface AgentRow {
  id: string;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
  deployments: Array<{ status: string; replicas: number }>;
  listing: {
    agentToken: {
      status: string;
      treasury: { solBalanceLamports: bigint } | null;
    } | null;
  } | null;
}

interface PrismaStub {
  agent: {
    findMany: (args: {
      where: { orgId: string };
      include: unknown;
      orderBy: unknown;
      skip?: number;
      take?: number;
    }) => Promise<AgentRow[]>;
    count: (args: { where: { orgId: string } }) => Promise<number>;
  };
}

export interface LoadAgentListInput {
  orgId: string;
  limit: number;
  offset: number;
  sort: AgentListSort;
}

export interface LoadAgentListDeps {
  prisma: PrismaStub;
}

function buildOrderBy(sort: AgentListSort): unknown {
  switch (sort) {
    case "newest":
      return { createdAt: "desc" };
    case "oldest":
      return { createdAt: "asc" };
    case "name":
      return { name: "asc" };
    case "treasury_balance_desc":
      // Stable base order for the in-memory substance sort (also the
      // tiebreak between equal balances).
      return { createdAt: "desc" };
  }
}

function rowBalance(row: AgentRow): bigint | null {
  return row.listing?.agentToken?.treasury?.solBalanceLamports ?? null;
}

/**
 * Substance order: funded treasuries first (balance desc), untokenized
 * agents last, input order (createdAt desc) preserved between ties.
 */
function sortByTreasuryBalanceDesc(rows: AgentRow[]): AgentRow[] {
  return [...rows].sort((a, b) => {
    const balA = rowBalance(a);
    const balB = rowBalance(b);
    if (balA === null && balB === null) return 0;
    if (balA === null) return 1;
    if (balB === null) return -1;
    if (balA === balB) return 0;
    return balA > balB ? -1 : 1;
  });
}

function mapTokenStatus(
  listing: AgentRow["listing"],
): "not_tokenized" | "bonding" | "graduated" {
  const token = listing?.agentToken;
  if (!token) return "not_tokenized";
  if (token.status === "GRADUATED") return "graduated";
  return "bonding";
}

function mapEntry(row: AgentRow): AgentListEntry {
  const activeDeploymentCount = row.deployments
    .filter((d) => d.status === "running")
    .reduce((sum, d) => sum + (d.replicas ?? 0), 0);

  const treasuryBalanceLamports =
    row.listing?.agentToken?.treasury?.solBalanceLamports ?? null;

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    framework: row.framework,
    createdAt: row.createdAt,
    treasuryBalanceLamports,
    activeDeploymentCount,
    tokenStatus: mapTokenStatus(row.listing),
  };
}

export async function loadAgentListByPrisma(
  input: LoadAgentListInput,
  deps: LoadAgentListDeps,
): Promise<AgentListResult> {
  // The substance sort orders in memory (see header), so it must load the
  // full org-scoped set and paginate after ordering; the scalar sorts
  // paginate in SQL as before.
  const inMemorySort = input.sort === "treasury_balance_desc";

  const [rows, totalCount] = await Promise.all([
    deps.prisma.agent.findMany({
      where: { orgId: input.orgId },
      include: {
        deployments: {
          select: { status: true, replicas: true },
        },
        listing: {
          select: {
            agentToken: {
              select: {
                status: true,
                treasury: { select: { solBalanceLamports: true } },
              },
            },
          },
        },
      },
      orderBy: buildOrderBy(input.sort),
      ...(inMemorySort ? {} : { skip: input.offset, take: input.limit }),
    }),
    deps.prisma.agent.count({ where: { orgId: input.orgId } }),
  ]);

  const page = inMemorySort
    ? sortByTreasuryBalanceDesc(rows).slice(
        input.offset,
        input.offset + input.limit,
      )
    : rows;

  return {
    agents: page.map(mapEntry),
    totalCount,
  };
}
