"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bot, Play, Square, Code, Zap, MoreVertical } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsApi, type Agent, getErrorMessage } from "@/lib/api";
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

  return (
    <div className="flex flex-col">
      <Header
        title="Agent Studio"
        description="Build and deploy AI agents with your models"
        action={{ label: "New Agent", href: "/dashboard/agents/new" }}
      />

      <div className="p-8">
        {/* Framework overview: counts come from the list, so it is hidden
            (not shown as zeros) when the list failed to load. */}
        {loadError === null && (
          <div className="mb-8 grid gap-4 md:grid-cols-4">
            {[
              { name: "Mastra", count: agents.filter((a) => a.framework === "mastra").length, color: "purple" },
              { name: "LangChain", count: agents.filter((a) => a.framework === "langchain").length, color: "green" },
              { name: "AutoGen", count: agents.filter((a) => a.framework === "autogen").length, color: "blue" },
              { name: "Custom", count: agents.filter((a) => a.framework === "custom").length, color: "gray" },
            ].map((fw) => (
              <Card key={fw.name}>
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-muted-foreground">{fw.name} Agents</p>
                      {isLoading ? (
                        <Skeleton className="my-1 h-6 w-10" />
                      ) : (
                        <p className="text-2xl font-bold">{fw.count}</p>
                      )}
                    </div>
                    <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", `bg-${fw.color}-100`)}>
                      <Bot className={cn("h-5 w-5", `text-${fw.color}-600`)} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
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
            actionLabel="Create Agent"
            actionHref="/dashboard/agents/new"
          />
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
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
                          <div className="mt-1 flex items-center gap-2">
                            <span className={cn("rounded px-2 py-0.5 text-xs font-medium", frameworkColors[agent.framework])}>
                              {agent.framework}
                            </span>
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

        {/* Quick start templates */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-base">Quick Start Templates</CardTitle>
            <CardDescription>
              Start with a pre-built agent template
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              {[
                {
                  name: "Customer Support",
                  description: "Handle customer inquiries with RAG-powered responses",
                  framework: "langchain",
                  icon: "💬",
                },
                {
                  name: "Code Assistant",
                  description: "Generate, review, and explain code",
                  framework: "mastra",
                  icon: "💻",
                },
                {
                  name: "Research Agent",
                  description: "Search the web and synthesize information",
                  framework: "autogen",
                  icon: "🔍",
                },
              ].map((template) => (
                <Link
                  key={template.name}
                  href={`/dashboard/agents/new?template=${encodeURIComponent(template.name.toLowerCase().replace(" ", "-"))}`}
                >
                  <div className="rounded-lg border p-4 transition-colors hover:border-primary/40 hover:bg-primary/10">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{template.icon}</span>
                      <div>
                        <p className="font-medium">{template.name}</p>
                        <p className="text-sm text-muted-foreground">{template.description}</p>
                      </div>
                    </div>
                    <div className="mt-3">
                      <span className={cn("rounded px-2 py-0.5 text-xs font-medium", frameworkColors[template.framework])}>
                        {template.framework}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
