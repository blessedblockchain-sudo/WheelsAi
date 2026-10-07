import { seg, type WheelsAIClient } from "../client.js";

/** Model (GPU) deployments: `/api/deployments`. Agent deployments are under `agents`. */
export type DeploymentStatus =
  | "pending"
  | "building"
  | "deploying"
  | "provisioning"
  | "running"
  | "degraded"
  | "stopped"
  | "failed";

/** One row of `GET /api/deployments`. */
export interface Deployment {
  id: string;
  name: string;
  slug: string;
  /** The model's display name. */
  model: string;
  engine: string;
  gpuTier: string;
  replicas: number;
  status: DeploymentStatus;
  /** Why the deployment left service (`nosana_error`, `insufficient_credits`, `user_stopped`, ...), else null. */
  statusReason: string | null;
  /** The OpenAI-compatible URL, only while running. May be host-relative when the API has no public URL configured. */
  endpoint: string | null;
  healthyNodes: number;
  totalNodes: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentNode {
  id: string;
  deploymentId: string;
  healthStatus: string;
  latencyMs: number | null;
  [field: string]: unknown;
}

export interface DeploymentDetail {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  modelId: string;
  engine: string;
  gpuTier: string;
  replicas: number;
  config: { maxTokens?: number; gpuMemoryUtilization?: number };
  status: DeploymentStatus;
  statusReason: string | null;
  endpoint: string | null;
  nosanaJobIds: string[];
  model: { id: string; displayName: string; [field: string]: unknown };
  nodes: DeploymentNode[];
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
}

export interface CreateDeploymentInput {
  /** 3 to 50 characters. */
  name: string;
  modelId: string;
  /** A deployable tier id from `models.list({ tier: "gpu" }).gpuTiers`. */
  gpuTier: string;
  engine?: "vllm" | "ollama";
  /** 1 to 10. */
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
    /** End-to-end time of answered requests, in ms; null when none was measured. */
    avgLatencyMs: number | null;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
    /** The answered requests the three latency fields are computed over. */
    latencySampleCount: number;
    errorRate: number;
  };
  byHour: Array<{ period: string; requests: number; inputTokens: number; outputTokens: number }>;
}

/** A lifecycle event Nosana reported for the deployment. */
export interface DeploymentLogEntry {
  timestamp: string | null;
  level: "info" | "error";
  type: string;
  message: string;
  tx?: string;
}

export interface DeploymentLogs {
  deploymentId: string;
  source: string;
  note: string;
  logs: DeploymentLogEntry[];
}

export function deploymentsResource(client: WheelsAIClient) {
  return {
    list: () =>
      client.get<{ deployments: Deployment[]; total: number }>("/api/deployments"),

    get: (id: string) =>
      client.get<{ deployment: DeploymentDetail }>(`/api/deployments/${seg(id)}`),

    create: (input: CreateDeploymentInput) =>
      client.post<{
        deployment: { id: string; name: string; slug: string; status: DeploymentStatus };
        message: string;
      }>("/api/deployments", input),

    /** The answer is the deployment row alone: no `model`, `nodes` or `endpoint` (read those with `get`). */
    update: (id: string, updates: { replicas?: number; config?: { maxTokens?: number } }) =>
      client.patch<{ deployment: Omit<DeploymentDetail, "model" | "nodes" | "endpoint">; note?: string }>(
        `/api/deployments/${seg(id)}`,
        updates,
      ),

    /** Stops the deployment (the API's DELETE is a stop, and is idempotent). */
    delete: (id: string) =>
      client.delete<{ message: string; vaultReclaimed?: boolean }>(`/api/deployments/${seg(id)}`),

    /** Only stopped or failed deployments can be restarted. */
    restart: (id: string) =>
      client.post<{ message: string; deployment: { id: string; status: DeploymentStatus } }>(
        `/api/deployments/${seg(id)}/restart`,
      ),

    /** Nosana lifecycle events; container output is not exposed. `lines` is 10 to 1000 (default 100). */
    logs: (id: string, params?: { lines?: number }) =>
      client.get<DeploymentLogs>(`/api/deployments/${seg(id)}/logs`, params),

    metrics: (id: string) =>
      client.get<DeploymentMetrics>(`/api/deployments/${seg(id)}/metrics`),
  };
}
