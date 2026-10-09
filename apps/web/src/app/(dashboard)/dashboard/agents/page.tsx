"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bot, ChevronDown, FilterX } from "lucide-react";
import { toast } from "sonner";

import { AgentKindBadge } from "@/components/dashboard/agent-kind-badge";
import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsApi, templateApi, type Agent, type AgentTemplate, getErrorMessage } from "@/lib/api";
import {
  KIND_CHOICES,
  KIND_FILTERS,
  NO_AGENT_FILTERS,
  countByKind,
  filterAgents,
  frameworkCounts,
  frameworkLabel,
  hasActiveFilters,
  newAgentHref,
  quickStartTemplates,
  showsFrameworkChip,
  type AgentFilters,
  type KindFilter,
} from "@/lib/agent-list";
import { NEW_AGENT_BUTTON } from "@/lib/nav";
import { cn } from "@/lib/utils";

const frameworkColors: Record<string, string> = {
  mastra: "bg-purple-500/10 text-purple-500",
  langchain: "bg-green-500/10 text-green-500",
  autogen: "bg-blue-500/10 text-blue-500",
  elizaos: "bg-cyan-500/10 text-cyan-500",
  crewai: "bg-orange-500/10 text-orange-500",
  custom: "bg-muted text-foreground",
};

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  building: "warning",
  deploying: "warning",
  pending: "secondary",
  stopped: "secondary",
  failed: "destructive",
};

/** Stand-in for one agent card while the list loads: header, description, tags and footer. */
function AgentCardSkeleton() {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <div className="space-y-2 pt-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [filters, setFilters] = useState<AgentFilters>(NO_AGENT_FILTERS);
  // The starter templates are a convenience: when they cannot be loaded the
  // three ways to start are still shown.
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);

  const loadAgents = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const { agents } = await agentsApi.list();
      setAgents(agents);
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load agents"));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    let cancelled = false;
    templateApi
      .list({ limit: 12 })
      .then((res) => {
        if (!cancelled) setTemplates(quickStartTemplates(res.templates ?? []));
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const kindCounts = useMemo(() => countByKind(agents), [agents]);
  const frameworks = useMemo(() => frameworkCounts(agents), [agents]);
  const visible = useMemo(() => filterAgents(agents, filters), [agents, filters]);

  return (
    <div className="flex flex-col">
      <Header
        title="Agents"
        description="Build and deploy AI agents with your models"
        action={NEW_AGENT_BUTTON}
      />

      <div className="p-8">
        {/* Filters: by how the agent is used, and by framework. Hidden while
            loading and when the list failed, so they never show zeros. */}
        {loadError === null && !isLoading && agents.length > 0 && (
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-2">
              {KIND_FILTERS.map((f) => {
                const pressed = filters.kind === f.value;
                return (
                  <button
                    key={f.value}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => setFilters((cur) => ({ ...cur, kind: f.value as KindFilter }))}
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      pressed
                        ? "border-primary/40 bg-primary/15 text-primary"
                        : "border-border bg-card text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f.label}
                    <span className="text-xs tabular-nums opacity-80">{kindCounts[f.value]}</span>
                  </button>
                );
              })}
            </div>

            {frameworks.length > 1 && (
              <div className="sm:w-56">
                <label htmlFor="agent-framework-filter" className="text-sm font-medium text-foreground">
                  Framework
                </label>
                <div className="relative mt-1.5">
                  <select
                    id="agent-framework-filter"
                    value={filters.framework}
                    onChange={(e) => setFilters((cur) => ({ ...cur, framework: e.target.value }))}
                    className="h-10 w-full appearance-none rounded-md border border-input bg-background px-3 pr-8 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">All frameworks ({agents.length})</option>
                    {frameworks.map((f) => (
                      <option key={f.framework} value={f.framework}>
                        {frameworkLabel(f.framework)} ({f.count})
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Agents list */}
        {loadError !== null ? (
          <ErrorState
            title="Couldn't load agents"
            error={loadError}
            onRetry={() => void loadAgents()}
          />
        ) : isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            {[1, 2, 3].map((i) => (
              <AgentCardSkeleton key={i} />
            ))}
            <span className="sr-only">Loading agents</span>
          </div>
        ) : agents.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create your first AI agent to automate tasks and workflows."
            actionLabel={NEW_AGENT_BUTTON.label}
            actionHref={NEW_AGENT_BUTTON.href}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={FilterX}
            title="No agents match"
            description="None of your agents fit these filters."
            actionLabel="Clear filters"
            onAction={() => setFilters(NO_AGENT_FILTERS)}
          />
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {visible.map((agent) => (
              <Link key={agent.id} href={`/dashboard/agents/${agent.id}`}>
                <Card className="h-full transition-shadow hover:shadow-md">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                          <Bot className="h-5 w-5 text-primary-600" />
                        </div>
                        <div>
                          <CardTitle className="text-base">{agent.name}</CardTitle>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <AgentKindBadge kind={agent.agentKind} />
                            {showsFrameworkChip(agent) && (
                              <span className={cn("rounded px-2 py-0.5 text-xs font-medium", frameworkColors[agent.framework])}>
                                {frameworkLabel(agent.framework)}
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground">v{agent.version}</span>
                          </div>
                        </div>
                      </div>
                      {agent.latestDeployment && (
                        <Badge variant={statusColors[agent.latestDeployment.status]}>
                          {agent.latestDeployment.status}
                        </Badge>
                      )}
                    </div>
                    {agent.description && (
                      <CardDescription className="mt-3 line-clamp-2">
                        {agent.description}
                      </CardDescription>
                    )}
                  </CardHeader>

                  <CardContent>
                    <div className="flex flex-wrap gap-1.5">
                      {agent.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                      {agent.tags.length > 3 && (
                        <Badge variant="outline" className="text-xs">
                          +{agent.tags.length - 3}
                        </Badge>
                      )}
                    </div>

                    <div className="mt-4 flex items-center justify-between border-t pt-4 text-sm">
                      {/* The agent's /v1 API is always on; its model id is how a client names it. */}
                      <code
                        className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
                        title="Model id on the OpenAI-compatible API"
                      >
                        {agent.openaiModel ?? `agent/${agent.slug}`}
                      </code>
                      <span className="text-muted-foreground">
                        {new Date(agent.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        {/* Ways to start: the three kinds, then real templates */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-base">Start something new</CardTitle>
            <CardDescription>Pick how people will use it, or start from a template.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <ul className="grid gap-4 md:grid-cols-3">
              {KIND_CHOICES.map((choice) => (
                <li key={choice.kind}>
                  <Link
                    href={newAgentHref({ kind: choice.kind })}
                    className="flex h-full flex-col gap-2 rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{choice.title}</p>
                      <AgentKindBadge kind={choice.kind} />
                    </div>
                    <p className="text-sm text-muted-foreground">{choice.description}</p>
                  </Link>
                </li>
              ))}
            </ul>

            {templates === null ? (
              <div className="grid gap-4 md:grid-cols-3" aria-busy="true">
                <span className="sr-only">Loading templates</span>
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))}
              </div>
            ) : (
              templates.length > 0 && (
                <div>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium">Start from a template</h2>
                    <Link
                      href="/dashboard/templates"
                      className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Browse all templates
                    </Link>
                  </div>
                  <ul className="grid gap-4 md:grid-cols-3">
                    {templates.map((template) => (
                      <li key={template.id}>
                        <Link
                          href={newAgentHref({ template: template.id })}
                          className="flex h-full flex-col gap-2 rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-medium">{template.title}</p>
                            <AgentKindBadge kind={template.agentKind} />
                          </div>
                          <p className="line-clamp-2 text-sm text-muted-foreground">{template.description}</p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
