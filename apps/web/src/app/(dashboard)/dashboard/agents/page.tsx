"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bot, Plus, Play, Square, Code, Zap, MoreVertical } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentsApi, type Agent } from "@/lib/api";
import { cn } from "@/lib/utils";

const frameworkColors: Record<string, string> = {
  mastra: "bg-purple-100 text-purple-700",
  langchain: "bg-green-100 text-green-700",
  autogen: "bg-blue-100 text-blue-700",
  elizaos: "bg-cyan-100 text-cyan-700",
  crewai: "bg-orange-100 text-orange-700",
  custom: "bg-gray-100 text-gray-700",
};

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  building: "warning",
  deploying: "warning",
  pending: "secondary",
  stopped: "secondary",
  failed: "destructive",
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadAgents() {
      try {
        const { agents } = await agentsApi.list();
        setAgents(agents);
      } catch (error) {
        toast.error("Failed to load agents");
      } finally {
        setIsLoading(false);
      }
    }
    loadAgents();
  }, []);

  return (
    <div className="flex flex-col">
      <Header
        title="Agent Studio"
        description="Build and deploy AI agents with your models"
        action={{ label: "New Agent", href: "/dashboard/agents/new" }}
      />

      <div className="p-8">
        {/* Framework overview */}
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
                    <p className="text-sm text-gray-500">{fw.name} Agents</p>
                    <p className="text-2xl font-bold">{fw.count}</p>
                  </div>
                  <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", `bg-${fw.color}-100`)}>
                    <Bot className={cn("h-5 w-5", `text-${fw.color}-600`)} />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Agents list */}
        {isLoading ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-48 animate-pulse rounded-lg bg-gray-200" />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Bot className="h-16 w-16 text-gray-300" />
              <h3 className="mt-4 text-xl font-medium text-gray-900">
                No agents yet
              </h3>
              <p className="mt-2 text-center text-gray-500">
                Create your first AI agent to automate tasks and workflows
              </p>
              <Link href="/dashboard/agents/new" className="mt-6">
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Agent
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <Link key={agent.id} href={`/dashboard/agents/${agent.id}`}>
                <Card className="h-full transition-shadow hover:shadow-md">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100">
                          <Bot className="h-5 w-5 text-primary-600" />
                        </div>
                        <div>
                          <CardTitle className="text-base">{agent.name}</CardTitle>
                          <div className="mt-1 flex items-center gap-2">
                            <span className={cn("rounded px-2 py-0.5 text-xs font-medium", frameworkColors[agent.framework])}>
                              {agent.framework}
                            </span>
                            <span className="text-xs text-gray-500">v{agent.version}</span>
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
                      {agent.latestDeployment?.endpoint ? (
                        <code className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">
                          {agent.slug}
                        </code>
                      ) : (
                        <span className="text-gray-500">Not deployed</span>
                      )}
                      <span className="text-gray-500">
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
                  <div className="rounded-lg border p-4 transition-colors hover:border-primary-300 hover:bg-primary-50">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{template.icon}</span>
                      <div>
                        <p className="font-medium">{template.name}</p>
                        <p className="text-sm text-gray-500">{template.description}</p>
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
