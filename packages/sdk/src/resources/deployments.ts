import type { WheelsAIClient } from "../client.js";

export interface Deployment {
  id: string;
  name: string;
  slug: string;
  model: string;
  engine: string;
  gpuTier: string;
  replicas: number;
  status: "pending" | "provisioning" | "running" | "degraded" | "stopped" | "failed";
  endpoint: string | null;
  healthyNodes: number;
  totalNodes: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentDetail extends Deployment {
  config: { maxTokens: number; gpuMemoryUtilization: number };
  nodes: Array<{ id: string; healthStatus: string; latencyMs: number | null }>;
}

export interface CreateDeploymentInput {
  name: string;
  modelId: string;
  gpuTier: string;
  engine?: "vllm" | "ollama";
  replicas?: number;
  config?: { maxTokens?: number; gpuMemoryUtilization?: number };
}

export interface DeploymentMetrics {
  deploymentId: string;
  period: string;
  metrics: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    avgLatencyMs: number;
    errorRate: number;
  };
  byHour: Array<{ period: string; requests: number; inputTokens: number; outputTokens: number }>;
}

export function deploymentsResource(client: WheelsAIClient) {
  return {
    list: () =>
      client.get<{ deployments: Deployment[]; total: number }>("/api/deployments"),

    get: (id: string) =>
      client.get<{ deployment: DeploymentDetail }>(`/api/deployments/${id}`),

    create: (input: CreateDeploymentInput) =>
      client.post<{ deployment: Deployment; message: string }>("/api/deployments", input),

    update: (id: string, updates: { replicas?: number }) =>
      client.patch<{ deployment: Deployment }>(`/api/deployments/${id}`, updates),

    delete: (id: string) =>
      client.delete<{ message: string }>(`/api/deployments/${id}`),

    restart: (id: string) =>
      client.post<{ message: string }>(`/api/deployments/${id}/restart`),

    metrics: (id: string) =>
      client.get<DeploymentMetrics>(`/api/deployments/${id}/metrics`),
  };
}
