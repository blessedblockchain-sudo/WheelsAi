import { seg, type RequestOptions, type WheelsAIClient } from "../client.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "./inference.js";

export type AgentFramework = "mastra" | "langchain" | "autogen" | "elizaos" | "crewai" | "custom";
export type AgentSourceType = "inline" | "github" | "ipfs";

/** Statuses an agent deployment moves through. `running`, `failed` and `stopped` are final for a poller. */
export type AgentDeploymentStatus =
  | "pending"
  | "building"
  | "deploying"
  | "running"
  | "stopped"
  | "failed";

export interface AgentTool {
  name: string;
  type: "function" | "api" | "mcp";
  description?: string;
  config?: Record<string, unknown>;
}

export interface AgentModelConfig {
  /** A WheelsAI model id. */
  modelId?: string;
  /** e.g. `free/groq/llama-3.3-70b` or `openai/gpt-4`. */
  externalModel?: string;
  temperature: number;
  maxTokens: number;
}

/** The newest deployment, as embedded in the agent list. */
export interface AgentLatestDeployment {
  id: string;
  status: AgentDeploymentStatus;
  endpoint: string | null;
  createdAt: string;
}

/** One row of `GET /api/agents`. */
/** What answers a chat: the agent's prompt, model and tools, or its saved graph. */
export type AgentEntrypoint = "chat" | "graph";

/** Sums of an agent's chat traffic (playground and `/v1`) over a period. */
export interface AgentUsageSummary {
  requests: number;
  /** Chats that produced no answer. A caller that hung up is not an error. */
  errors: number;
  streamed: number;
  /** Chats that produced an answer: the base of the latency numbers. */
  answered: number;
  inputTokens: number;
  outputTokens: number;
  /** Answered chats whose provider reported no tokens; NOT in the two sums above. */
  usageUnreported: number;
  toolCalls: number;
  /** null when nothing was answered. */
  avgLatencyMs: number | null;
  /** The upper bound of the latency bucket the percentile falls in; null when unknown. */
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /** errors / requests, 0..1. */
  errorRate: number;
}

export type AgentUsagePeriod = "24h" | "7d" | "30d";

export interface AgentChatUsage {
  period: AgentUsagePeriod;
  since: string;
  total: AgentUsageSummary;
  /** Per entry point: `playground`, `api`. */
  bySource: Record<string, AgentUsageSummary>;
  /** One point per UTC hour that had traffic, oldest first. */
  series: Array<{ periodStart: string; requests: number; errors: number; inputTokens: number; outputTokens: number }>;
}

export interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  framework: AgentFramework;
  version: string;
  tags: string[];
  isPublic: boolean;
  /**
   * The agent's OpenAI-compatible chat-completions URL on this API
   * (`<api>/v1/agents/<slug>/chat/completions`). Always on: no deployment is needed.
   * null when the API has no public address configured (PUBLIC_API_URL).
   */
  apiEndpoint: string | null;
  /** `baseURL` for an OpenAI client talking to this one agent; null as above. */
  openaiBaseUrl: string | null;
  /** The `model` that selects this agent on the unified `<api>/v1` base: `agent/<slug>`. */
  openaiModel: string;
  entrypoint: AgentEntrypoint;
  latestDeployment: AgentLatestDeployment | null;
  createdAt: string;
  updatedAt: string;
}

/** An agent deployment row (`GET /api/agents/{id}/deployments/{deploymentId}`). */
export interface AgentDeployment {
  id: string;
  agentId: string;
  gpuTier: string;
  replicas: number;
  status: AgentDeploymentStatus;
  /** The agent's `/v1` chat-completions URL while the deployment is `running`; null otherwise. */
  endpoint: string | null;
  modelDeploymentId: string | null;
  externalModelUrl: string | null;
  nosanaJobIds: string[];
  walletId: string | null;
  buildLogs: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  /** Present only if the API adds channel information to the row. */
  channels?: unknown;
}

export interface AgentDetail {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  description: string | null;
  framework: AgentFramework;
  systemPrompt: string | null;
  tools: AgentTool[];
  modelConfig: AgentModelConfig;
  sourceType: AgentSourceType;
  sourceUrl: string | null;
  sourceCode: string | null;
  /** Secret values never leave the API: only the names of the variables that are set. */
  env: { keys: string[] };
  knowledgeBaseId: string | null;
  version: string;
  isPublic: boolean;
  tags: string[];
  /** See `Agent.apiEndpoint`. */
  apiEndpoint: string | null;
  openaiBaseUrl: string | null;
  openaiModel: string;
  entrypoint: AgentEntrypoint;
  createdAt: string;
  updatedAt: string;
  /** Every deployment of the agent, newest first. */
  deployments: AgentDeployment[];
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  framework: AgentFramework;
  systemPrompt?: string;
  tools?: AgentTool[];
  /** Required by the API, but every field in it has a default: pass `{}` for the defaults. */
  modelConfig: { modelId?: string; externalModel?: string; temperature?: number; maxTokens?: number };
  sourceType: AgentSourceType;
  /** Required for `github` and `ipfs`. */
  sourceUrl?: string;
  /** Required for `inline`. */
  sourceCode?: string;
  env?: Record<string, string>;
  tags?: string[];
  isPublic?: boolean;
  knowledgeBaseId?: string | null;
}

export interface UpdateAgentInput extends Partial<Omit<CreateAgentInput, "env">> {
  /** A string sets or replaces a variable; null deletes it. */
  env?: Record<string, string | null>;
  /**
   * `graph` makes the agent answer the playground and `/v1` by running its saved graph.
   * The API answers 400 `agent_graph_missing` until the agent has one.
   */
  entrypoint?: AgentEntrypoint;
}

export interface DeployAgentInput {
  /** A deployable tier id from `models.list({ tier: "gpu" }).gpuTiers`. */
  gpuTier: string;
  /** 1 to 5. Defaults to 1. */
  replicas?: number;
  modelDeploymentId?: string;
  externalModelUrl?: string;
  enableWallet?: boolean;
  walletConfig?: { dailyLimitCents?: number; perTxLimitCents?: number; allowedDomains?: string[] };
}

export interface PlaygroundChatResponse {
  content: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: unknown[];
  billing: { listingTitle: string; chargedCents: number; creatorCents: number } | null;
  retrieval: unknown | null;
}

export interface GraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { label: string; config: Record<string, unknown>; inputs?: string[]; outputs?: string[] };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  animated?: boolean;
}

export interface AgentGraph {
  agentId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport?: { x: number; y: number; zoom: number };
  version: number;
}

export interface GraphIssue {
  type: "error" | "warning";
  message: string;
}

export interface GraphValidation {
  valid: boolean;
  issues: GraphIssue[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function agentsResource(client: WheelsAIClient) {
  const list = () => client.get<{ agents: Agent[]; total: number }>("/api/agents");

  return {
    list,

    /**
     * Find an agent in the caller's organization by slug. The API has no slug filter,
     * so this lists the agents and matches client-side. Returns null when none matches.
     */
    findBySlug: async (slug: string): Promise<Agent | null> => {
      const { agents } = await list();
      const wanted = slug.toLowerCase();
      return agents.find((agent) => agent.slug === wanted) ?? null;
    },

    /** Find an agent by id or slug (one list request). Returns null when none matches. */
    resolve: async (idOrSlug: string): Promise<Agent | null> => {
      const { agents } = await list();
      const byId = UUID.test(idOrSlug) ? agents.find((agent) => agent.id === idOrSlug.toLowerCase()) : undefined;
      return byId ?? agents.find((agent) => agent.slug === idOrSlug.toLowerCase()) ?? null;
    },

    get: (id: string) =>
      client.get<{ agent: AgentDetail }>(`/api/agents/${seg(id)}`),

    create: (input: CreateAgentInput) =>
      client.post<{ agent: { id: string; name: string; slug: string; framework: AgentFramework }; message: string }>(
        "/api/agents",
        input,
      ),

    /** `PATCH /api/agents/{id}`. The answer is the agent row alone: its deployments are not included. */
    update: (id: string, updates: UpdateAgentInput) =>
      client.patch<{ agent: Omit<AgentDetail, "deployments"> }>(`/api/agents/${seg(id)}`, updates),

    delete: (id: string) =>
      client.delete<{ message: string }>(`/api/agents/${seg(id)}`),

    /**
     * The agent's chat traffic over a period: requests, errors, tokens and latency, in total,
     * per entry point and per hour. Tokens the provider did not report are counted in
     * `usageUnreported`, never as zero.
     */
    usage: (id: string, period: AgentUsagePeriod = "24h") =>
      client.get<{ usage: AgentChatUsage }>(`/api/agents/${seg(id)}/usage?period=${period}`),

    /**
     * Start a deployment. The response is immediate (status `pending`); poll
     * `getDeployment` for progress. The agent needs `modelConfig.externalModel`,
     * or pass `modelDeploymentId` / `externalModelUrl`.
     */
    deploy: (id: string, input: DeployAgentInput) =>
      client.post<{ deployment: { id: string; status: AgentDeploymentStatus }; message: string }>(
        `/api/agents/${seg(id)}/deploy`,
        input,
      ),

    getDeployment: (agentId: string, deploymentId: string) =>
      client.get<{ deployment: AgentDeployment }>(
        `/api/agents/${seg(agentId)}/deployments/${seg(deploymentId)}`,
      ),

    /** `POST /api/agents/{agentId}/deployments/{deploymentId}/stop`. */
    stopDeployment: (agentId: string, deploymentId: string) =>
      client.post<{ message: string }>(
        `/api/agents/${seg(agentId)}/deployments/${seg(deploymentId)}/stop`,
      ),

    deploymentLogs: (agentId: string, deploymentId: string) =>
      client.get<{ logs: string; error: string | null }>(
        `/api/agents/${seg(agentId)}/deployments/${seg(deploymentId)}/logs`,
      ),

    /**
     * One playground turn. An agent with tools can run several tool rounds before it answers,
     * which may outlast the client's default timeout: raise it for this call with `options.timeoutMs`.
     * `billing` is set when the agent is an installed per-request marketplace listing and the call was charged.
     */
    playgroundChat: (
      id: string,
      body: { messages: Array<{ role: "user" | "assistant" | "system"; content: string }>; model?: string },
      options?: RequestOptions,
    ) => client.post<PlaygroundChatResponse>(`/api/agents/${seg(id)}/playground/chat`, body, options),

    /**
     * An OpenAI-format chat completion from an agent: `POST /v1/agents/{slug}/chat/completions`.
     * Takes the agent's SLUG (not its id). The agent answers with its own prompt, model, tools and
     * knowledge base; `tools` in the request are functions YOU run, handed back as
     * `choices[0].message.tool_calls` with `finish_reason: "tool_calls"` - send the conversation
     * again with a `tool` message per call to continue. `model` in the request is ignored.
     * An agent whose `entrypoint` is `graph` answers by running its graph instead: it refuses
     * `tools` (400) and its response has no `usage`.
     *
     * Not streamed: for server-sent events point the OpenAI SDK at the agent's `openaiBaseUrl`.
     * Tool rounds can outlast the default timeout; raise it with `options.timeoutMs`.
     */
    chatCompletion: (agentSlug: string, request: ChatCompletionRequest, options?: RequestOptions) =>
      client.post<ChatCompletionResponse>(`/v1/agents/${seg(agentSlug)}/chat/completions`, request, options),

    playgroundModels: (id: string) =>
      client.get<{ freeModels: unknown[]; externalModels: unknown[] }>(`/api/agents/${seg(id)}/playground/models`),

    /**
     * The agent's visual graph. Empty (`nodes: []`) when it has none.
     * These routes authorize by user, so they answer an error for API-key credentials.
     */
    getGraph: (id: string) =>
      client.get<{ success: true; data: AgentGraph }>(`/api/agents/${seg(id)}/graph`),

    saveGraph: (id: string, graph: { nodes: GraphNode[]; edges: GraphEdge[]; viewport?: AgentGraph["viewport"] }) =>
      client.put<{ success: true; data: AgentGraph; message: string }>(`/api/agents/${seg(id)}/graph`, graph),

    /** Checks a graph without saving it. */
    validateGraph: (id: string, graph: { nodes: GraphNode[]; edges: GraphEdge[] }) =>
      client.post<{ success: true; data: GraphValidation }>(`/api/agents/${seg(id)}/graph/validate`, graph),
  };
}
