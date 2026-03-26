import type { WheelsAIClient } from "../client.js";

export interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string;
  framework: string;
  status: string;
  version: string;
  tags: string[];
  isPublic: boolean;
  createdAt: string;
}

export interface AgentDetail extends Agent {
  systemPrompt: string | null;
  tools: Array<{ name: string; description: string; type?: string; config?: Record<string, unknown> }>;
  modelConfig: { externalModel?: string; temperature: number; maxTokens: number };
  sourceType: string;
  sourceUrl: string | null;
  sourceCode: string | null;
  env: Record<string, string>;
  deployments: Array<{
    id: string;
    status: string;
    endpoint: string | null;
    gpuTier: string;
    replicas: number;
    createdAt: string;
  }>;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  framework: string;
  systemPrompt?: string;
  tools?: Array<{ name: string; description: string; type?: string }>;
  modelConfig?: { externalModel?: string; temperature?: number; maxTokens?: number };
  sourceType: string;
  sourceCode?: string;
  env?: Record<string, string>;
  tags?: string[];
  isPublic?: boolean;
}

export interface PlaygroundChatResponse {
  content: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export function agentsResource(client: WheelsAIClient) {
  return {
    list: () =>
      client.get<{ agents: Agent[] }>("/api/agents"),

    get: (id: string) =>
      client.get<{ agent: AgentDetail }>(`/api/agents/${id}`),

    create: (input: CreateAgentInput) =>
      client.post<{ agent: Agent }>("/api/agents", input),

    update: (id: string, updates: Partial<CreateAgentInput>) =>
      client.put<{ agent: Agent }>(`/api/agents/${id}`, updates),

    delete: (id: string) =>
      client.delete<{ message: string }>(`/api/agents/${id}`),

    deploy: (id: string, config: { gpuTier: string; replicas?: number }) =>
      client.post<{ deployment: { id: string; status: string } }>(`/api/agents/${id}/deploy`, config),

    stop: (id: string) =>
      client.post<{ message: string }>(`/api/agents/${id}/stop`),

    playgroundChat: (id: string, body: { messages: Array<{ role: string; content: string }>; model?: string }) =>
      client.post<PlaygroundChatResponse>(`/api/agents/${id}/playground/chat`, body),

    playgroundModels: (id: string) =>
      client.get<{ freeModels: unknown[]; externalModels: unknown[] }>(`/api/agents/${id}/playground/models`),
  };
}
