"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { AgentChat } from "@/components/dashboard/agent-chat";
import { Header } from "@/components/dashboard/header";
import { agentsApi, getErrorMessage, type AgentDetail } from "@/lib/api";

/** The full-page chat with one agent. The chat itself is `AgentChat`, shared with the agent page. */
export default function PlaygroundPage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [isLoadingAgent, setIsLoadingAgent] = useState(true);

  useEffect(() => {
    agentsApi
      .get(agentId)
      .then(({ agent }) => setAgent(agent))
      .catch((err) => toast.error(getErrorMessage(err, "Failed to load agent")))
      .finally(() => setIsLoadingAgent(false));
  }, [agentId]);

  if (isLoadingAgent) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <div className="p-8">
          <div className="h-96 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex flex-col">
        <Header title="Agent Not Found" />
        <div className="p-8 text-center text-muted-foreground">Agent not found</div>
      </div>
    );
  }

  return <AgentChat agentId={agentId} agent={agent} badge="Playground" />;
}
