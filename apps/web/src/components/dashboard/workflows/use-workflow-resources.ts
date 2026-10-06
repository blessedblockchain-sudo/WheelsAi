"use client";

import { useCallback, useEffect, useState } from "react";

import { agentsApi, deploymentsApi, knowledgeApi } from "@/lib/api";
import type { WorkflowResources } from "./step-editor-panel";

/** The agents, deployments and knowledge bases a step can point at. */
export function useWorkflowResources() {
  const [resources, setResources] = useState<WorkflowResources | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [agents, deployments, knowledgeBases] = await Promise.all([
        agentsApi.list(),
        deploymentsApi.list(),
        knowledgeApi.list({ limit: 100 }),
      ]);
      setResources({
        agents: agents.agents,
        deployments: deployments.deployments,
        knowledgeBases: knowledgeBases.knowledgeBases,
      });
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { resources, error, reload: load };
}

/** Names by id, for showing which resource a recorded step used. */
export function resourceNameMap(resources: WorkflowResources | null): Record<string, string> {
  const names: Record<string, string> = {};
  for (const agent of resources?.agents ?? []) names[agent.id] = agent.name;
  for (const deployment of resources?.deployments ?? []) names[deployment.id] = deployment.name;
  for (const kb of resources?.knowledgeBases ?? []) names[kb.id] = kb.name;
  return names;
}
