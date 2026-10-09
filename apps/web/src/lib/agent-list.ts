/**
 * What the agent and template lists need to filter, count and pick, kept out
 * of the components. Run the tests with:
 *   cd apps/web && npx tsx --test src/lib/agent-list.unit.test.ts
 */
import {
  AGENT_KINDS,
  AGENT_KIND_BADGES,
  DEFAULT_AGENT_KIND,
  isAgentKind,
  type AgentKind,
} from "@wheelsai/shared/agent-kind";

// ============================================
// Kinds
// ============================================

export type KindFilter = "all" | AgentKind;

export const KIND_FILTERS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  ...AGENT_KINDS.map((kind) => ({ value: kind as KindFilter, label: AGENT_KIND_BADGES[kind] })),
];

/** The three ways to use an agent, in the words the create screen uses. */
export const KIND_CHOICES: ReadonlyArray<{ kind: AgentKind; title: string; description: string }> = [
  {
    kind: "conversation",
    title: "Talk to it",
    description: "People chat with it and it answers. Good for support, advice and questions.",
  },
  {
    kind: "task",
    title: "Give it a task",
    description: "People fill in a short form and get one result back. Good for writing, summaries and reviews.",
  },
  {
    kind: "scheduled",
    title: "It runs on its own",
    description: "It works on a schedule and sends you what it produced. Good for daily briefings, checks and reports.",
  },
];

/** A missing or unknown kind is a conversation: every agent before kinds existed. */
export function kindOf(value: unknown): AgentKind {
  return isAgentKind(value) ? value : DEFAULT_AGENT_KIND;
}

export function isKindFilter(value: unknown): value is KindFilter {
  return value === "all" || isAgentKind(value);
}

export function newAgentHref(params: { kind?: AgentKind; template?: string }): string {
  const sp = new URLSearchParams();
  if (params.kind) sp.set("kind", params.kind);
  if (params.template) sp.set("template", params.template);
  const q = sp.toString();
  return `/dashboard/agents/new${q ? `?${q}` : ""}`;
}

// ============================================
// Frameworks
// ============================================

const FRAMEWORK_LABELS: Record<string, string> = {
  mastra: "Mastra",
  elizaos: "ElizaOS",
  langchain: "LangChain",
  autogen: "AutoGen",
  crewai: "CrewAI",
  custom: "Custom",
};

export function frameworkLabel(framework: string): string {
  return (
    FRAMEWORK_LABELS[framework] ??
    framework.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// ============================================
// Agents
// ============================================

export interface ListedAgent {
  agentKind?: string | null;
  framework: string;
}

export interface AgentFilters {
  kind: KindFilter;
  /** "" for every framework. */
  framework: string;
}

export const NO_AGENT_FILTERS: AgentFilters = { kind: "all", framework: "" };

export function filterAgents<T extends ListedAgent>(agents: readonly T[], filters: AgentFilters): T[] {
  return agents.filter(
    (a) =>
      (filters.kind === "all" || kindOf(a.agentKind) === filters.kind) &&
      (!filters.framework || a.framework === filters.framework),
  );
}

/** How many agents each kind filter would show, for the numbers beside the buttons. */
export function countByKind(agents: readonly ListedAgent[]): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = { all: agents.length, conversation: 0, task: 0, scheduled: 0 };
  for (const a of agents) counts[kindOf(a.agentKind)] += 1;
  return counts;
}

/** The frameworks that have agents, most used first, then by name. */
export function frameworkCounts(agents: readonly ListedAgent[]): Array<{ framework: string; count: number }> {
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(a.framework, (counts.get(a.framework) ?? 0) + 1);
  return Array.from(counts, ([framework, count]) => ({ framework, count })).sort(
    (a, b) => b.count - a.count || a.framework.localeCompare(b.framework),
  );
}

/**
 * Whether an agent shows its framework chip. An agent made from a description
 * is stored as "custom" with no code, and only agents that carry code show
 * one. The list answer carries no source type or code, so "custom" is the
 * stand-in for "no code".
 */
export function showsFrameworkChip(agent: { framework: string }): boolean {
  return agent.framework !== "custom";
}

export function hasActiveFilters(filters: AgentFilters): boolean {
  return filters.kind !== "all" || filters.framework !== "";
}

// ============================================
// Templates
// ============================================

export interface ListedTemplate {
  id: string;
  agentKind?: string | null;
  isFeatured?: boolean;
  usageCount?: number;
}

export function filterTemplatesByKind<T extends { agentKind?: string | null }>(
  templates: readonly T[],
  kind: KindFilter,
): T[] {
  return kind === "all" ? [...templates] : templates.filter((t) => kindOf(t.agentKind) === kind);
}

/** The templates offered on the agents list: featured first, then the most used. */
export function quickStartTemplates<T extends ListedTemplate>(templates: readonly T[], limit = 3): T[] {
  return [...templates]
    .sort(
      (a, b) =>
        Number(Boolean(b.isFeatured)) - Number(Boolean(a.isFeatured)) ||
        (b.usageCount ?? 0) - (a.usageCount ?? 0),
    )
    .slice(0, limit);
}
