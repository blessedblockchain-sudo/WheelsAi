import { seg, type RequestOptions, type WheelsAIClient } from "../client.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "./inference.js";

export type AgentFramework = "mastra" | "langchain" | "autogen" | "elizaos" | "crewai" | "custom";
export type AgentSourceType = "inline" | "github" | "ipfs";

/**
 * How people use an agent: they talk to it (`conversation`), they give it a task by
 * filling in a short form and get one result back (`task`), or it runs on its own on a
 * schedule (`scheduled`). The kind picks the front door: every agent still answers a chat.
 */
export type AgentKind = "conversation" | "task" | "scheduled";

/** The kinds, in the order the product shows them. */
export const AGENT_KINDS: readonly AgentKind[] = ["conversation", "task", "scheduled"];

/** What a question of a task form asks for. */
export type TaskFieldType = "short_text" | "long_text" | "number" | "choice" | "yes_no" | "link" | "list";

/** One question of a task form. */
export interface TaskField {
  /**
   * The name in code: what a caller sends and what the model sees. A lowercase letter, then
   * up to 39 lowercase letters, digits or underscores. Made from the label when left out,
   * then kept, so renaming a question never breaks a caller.
   */
  key: string;
  /** Up to 120 characters. */
  label: string;
  type: TaskFieldType;
  required: boolean;
  /** One line under the question, up to 300 characters. */
  help?: string;
  /** `choice` only: 2 to 50 options of up to 100 characters, in order. */
  options?: string[];
}

/** A question as it may be sent: `key`, `type` (`short_text`) and `required` (false) have defaults. */
export type TaskFieldInput = Omit<TaskField, "key" | "type" | "required"> & {
  key?: string;
  type?: TaskFieldType;
  required?: boolean;
};

/**
 * The settings of each kind, one key per kind, so changing an agent's kind and changing
 * back loses nothing.
 */
export interface KindConfig {
  /** The form of a task agent: 1 to 12 questions, in order. */
  task?: { fields: TaskField[] };
  scheduled?: {
    /** A suggested schedule: a five-part cron expression and an IANA time zone. */
    schedule?: { cronExpression: string; timezone?: string };
    /** What the agent is told at each run, up to 2,000 characters. */
    prompt?: string;
  };
}

/**
 * `kindConfig` as it may be sent. A key that is sent replaces that key whole and the other
 * stays as stored; a key set to null removes it. The whole value is at most 16 KB of JSON.
 */
export interface KindConfigInput {
  task?: { fields: TaskFieldInput[] } | null;
  scheduled?: KindConfig["scheduled"] | null;
}

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
  /** Measured per request over answered chats, in ms; null when none was measured. */
  avgLatencyMs: number | null;
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
  /** The name in the agent's public address, `/a/<handle>`, unique across the platform. null until the agent has been public. */
  publicHandle: string | null;
  agentKind: AgentKind;
  /**
   * The agent's OpenAI-compatible chat-completions URL on this API
   * (`<api>/v1/agents/<slug>/chat/completions`). Always on: no deployment is needed.
   * null when the endpoint address cannot be determined.
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
  /** See `Agent.publicHandle`. */
  publicHandle: string | null;
  /** A self-running agent's latest results show on its public page only when this is on. */
  publicResults: boolean;
  tags: string[];
  agentKind: AgentKind;
  /** null when the agent has no settings. A task agent without a form of its own uses one long-text question. */
  kindConfig: KindConfig | null;
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

/** Only `name` is needed. */
export interface CreateAgentInput {
  /** 3 to 100 characters. */
  name: string;
  description?: string;
  /** Defaults to `custom`. */
  framework?: AgentFramework;
  systemPrompt?: string;
  tools?: AgentTool[];
  /** Every field has a default: temperature 0.7, maxTokens 4096. */
  modelConfig?: { modelId?: string; externalModel?: string; temperature?: number; maxTokens?: number };
  /** Defaults to `inline`. */
  sourceType?: AgentSourceType;
  /** Required for `github` and `ipfs`. */
  sourceUrl?: string;
  sourceCode?: string;
  env?: Record<string, string>;
  tags?: string[];
  isPublic?: boolean;
  knowledgeBaseId?: string | null;
  /** Defaults to `conversation`, or to the template's kind. */
  agentKind?: AgentKind;
  /** null clears the settings. A task agent sent with no form gets one long-text question. */
  kindConfig?: KindConfigInput | null;
  /**
   * A published template to start from. Its values are the defaults, and each field sent
   * here replaces the template's. An unknown one answers 404 `template_not_found`.
   */
  templateId?: string;
  /** Left out, the slug is made from the name. Either way it is made unique. */
  slug?: string;
  /**
   * The agent's own schedule, made with the agent. Only with `agentKind: "scheduled"`, or a template
   * of that kind; otherwise the API answers 400 `validation_failed`. Left out, the agent has none yet.
   */
  schedule?: CreateAgentSchedule;
}

/**
 * The schedule a create may carry. The time limit and the number of tries keep their defaults
 * (five minutes, one retry); change them with `agents.schedule.set`.
 */
export interface CreateAgentSchedule {
  /** Five-field cron, for example `0 9 * * 1-5`. */
  cronExpression: string;
  /** An IANA time zone such as `Europe/Berlin`. Defaults to `UTC`. */
  timezone?: string;
  /** What the agent is told at each run, up to 20,000 characters. Left out, it gets a default line. */
  prompt?: string | null;
  /** Where results go: a place from `destinations.list`. null or left out: results are only saved on the agent's page. */
  deliver?: { channelId: string } | null;
  /** Defaults to `true`. */
  enabled?: boolean;
}

/** The agent's own schedule as a create answers it. Never what it is told or where results go. */
export interface CreatedAgentSchedule {
  /** The scheduled task's id. */
  id: string;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string;
  nextRunAt: string | null;
}

/** The answer of `agents.create`. */
export interface CreateAgentResult {
  agent: CreatedAgent;
  /** Always present: null when the agent was created without a schedule. */
  schedule: CreatedAgentSchedule | null;
  message: string;
}

/** The agent in the answer to a create. */
export interface CreatedAgent {
  id: string;
  name: string;
  slug: string;
  framework: AgentFramework;
  agentKind: AgentKind;
  /** See `Agent.apiEndpoint`. */
  apiEndpoint: string | null;
  openaiBaseUrl: string | null;
  openaiModel: string;
}

/**
 * Any part of a create but the template and the slug. Changing `agentKind` or `kindConfig`
 * bumps the agent's patch version; sending the stored values again does not.
 */
export interface UpdateAgentInput extends Partial<Omit<CreateAgentInput, "env" | "templateId" | "slug">> {
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

/**
 * One model your organization runs on its own deployment, as an agent's model choice. Set an
 * agent to it with `agents.update(id, { modelConfig: { externalModel: choice.id } })`.
 */
export interface HostedModelChoice {
  /** What an agent's model is set to: `wheelsai/<catalog model id>`, or `wheelsai/ft-<fine-tuned model slug>`. */
  id: string;
  /** The model's name as the catalog (or the fine-tuned model) gives it. */
  displayName: string;
  /** True when an agent set to this id would be answered right now. */
  available: boolean;
  /** `running`: answering. `starting`: its deployment is not serving yet. `not_answering`: it should be and is not. */
  state: "running" | "starting" | "not_answering";
  fineTuned: boolean;
  /** The deployment an agent set to this id is answered from. */
  deployment: { id: string; slug: string; name: string | null };
}

/** `GET /api/agents/{id}/playground/models`. */
export interface PlaygroundModels {
  freeModels: unknown[];
  externalModels: unknown[];
  /**
   * The models your organization runs itself: available ones first, then by name.
   * `null` when they could not be read just now (the other two lists are still answered).
   */
  hostedModels: HostedModelChoice[] | null;
}

export interface PlaygroundChatResponse {
  content: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: unknown[];
  billing: { listingTitle: string; chargedCents: number; creatorCents: number } | null;
  retrieval: unknown | null;
}

/** The answers to a task agent's form, by question key (`TaskField.key`). */
export type AgentRunInput = Record<string, unknown>;

/** One tool the model called during a run, and how the call ended. */
export interface AgentRunToolCall {
  round: number;
  name: string;
  /** `unavailable`: the tool is not set up on the server. */
  status: "ok" | "unavailable" | "error" | "unknown";
  detail: string | null;
}

/** The answer of `agents.run`. */
export interface AgentRunResult {
  output: { format: "text"; text: string };
  toolCalls: AgentRunToolCall[];
  durationMs: number;
  /** What the run cost a buyer's copy and who it went to; null when nothing was charged. */
  billing: { listingTitle: string; chargedCents: number; creatorCents: number } | null;
}

/** One answer of a task form that needs another look: the `details` of a 422 `input_invalid`. */
export interface TaskInputIssue {
  /** Where in the input, as a JSON pointer: `/topic`, `/keywords/3`; "" is the input as a whole. */
  path: string;
  /** The key of the question it is about, or null for the input as a whole. */
  field: string | null;
  /** That question's label, or null when the form has no such question. */
  label: string | null;
  message: string;
}

/**
 * Where an agent's public page (`/a/<handle>`) stands. `off`: not public. `view_only`: the page
 * shows and nobody can use the agent from it yet. `on`: anyone with the link can use it.
 * `paused`: the page shows, and use is stopped for now.
 */
export type PublicLinkState = "off" | "view_only" | "on" | "paused";

/** What `agents.publicLink.set` can set the link to; `view_only` is read, never asked for. */
export type PublicLinkSwitch = "on" | "paused" | "off";

export interface PublicLink {
  state: PublicLinkState;
  /** The agent's address, kept while the link is off. null until it has one. */
  handle: string | null;
  /** `<web>/a/<handle>`; null without a handle, or when the server does not know its web address. */
  url: string | null;
  /** Uses a day the page allows. */
  dailyCap: number;
  /** Uses counted today (UTC); null when the count could not be read. */
  usedToday: number | null;
  /** Whether a self-running agent's latest results show on its page. */
  showResults: boolean;
  /** The agent has a tool that visitors do not get. */
  toolsOffForVisitors: boolean;
  /** Present while a published listing sells use of this agent; `paid` is whether a price is set. */
  sale?: { paid: boolean; listingSlug: string };
}

export interface PublicLinkInput {
  state: PublicLinkSwitch;
  /** 1 to 100,000 uses a day. */
  dailyCap?: number;
  /** 3 to 40 lower-case letters, digits and hyphens. Left out, the agent keeps its address or gets one made from its name. */
  handle?: string;
  showResults?: boolean;
}

/** A place results can go to. Never its link or its address. */
export interface Destination {
  channelId: string;
  /** "" when the place was removed after it was chosen. */
  name: string;
  /** `slack`, `discord`, `email` or `webhook`; `unknown` when the place was removed after it was chosen. */
  type: string;
  /** true only for an email place that goes to the signed-in person's own address; always false for an API key and for the other types. */
  mine: boolean;
}

/** An agent's own schedule. */
export interface ScheduleView {
  id: string;
  enabled: boolean;
  /** null only for an older task that runs on an interval or once. */
  cronExpression: string | null;
  timezone: string;
  /** What the agent is told at each run. */
  prompt: string;
  /** Whether the date and time are told to the agent at each run. */
  stampTime: boolean;
  deliver: Omit<Destination, "mine"> | null;
  /** A run is stopped after this many seconds (5 to 3,600). */
  timeoutSeconds: number;
  /** Tries after a failed run (0 to 5). */
  maxRetries: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

/** The answer of `agents.schedule.get` and `agents.schedule.set`. */
export interface ScheduleAnswer {
  /** null until the agent has one. */
  schedule: ScheduleView | null;
  /** The times and the line a template or the creator suggested. */
  suggested: { schedule?: { cronExpression: string; timezone?: string }; prompt?: string } | null;
  /** The agent's other scheduled tasks; they are on the Scheduler page. */
  otherTasks: number;
  /** false while no worker fires schedules; runs can still be started by hand. */
  schedulerRunning: boolean;
}

/** What `agents.schedule.set` sends. It creates the schedule, or changes it. */
export interface ScheduleInput {
  enabled: boolean;
  cronExpression: string;
  timezone?: string;
  prompt?: string;
  stampTime?: boolean;
  /** A place from `destinations.list`; null clears it; left out, it stays as it is. */
  deliver?: { channelId: string } | null;
  /** 5 to 3,600. */
  timeoutSeconds?: number;
  /** 0 to 5. */
  maxRetries?: number;
}

/** `running`: not done. `finished`: it has a result. `did_not_finish`: see `failure`. `stopped`: someone stopped it. */
export type RunStatus = "running" | "finished" | "did_not_finish" | "stopped";

/** How sending one result to one place went. */
export interface RunDelivery {
  channelId: string;
  name: string;
  type: string;
  status: "sent" | "failed" | "skipped";
  /** Present unless `status` is `sent`. */
  reason?: string;
  /** When it was tried (ISO). */
  at: string;
}

/** One run of an agent's own schedule. */
export interface RunView {
  id: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  startedBy: "schedule" | "person";
  /** The answer of a finished run; null otherwise. */
  text: string | null;
  /** One plain sentence when the run did not finish; null otherwise. */
  failure: string | null;
  /** Every try to send the result, oldest first. A failed delivery never changes `status`. */
  delivery: RunDelivery[];
}

/** A task run is allowed two minutes; the client waits a little longer by default. */
const RUN_TIMEOUT_MS = 130_000;

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

    /**
     * `POST /api/agents`. A request the API cannot accept answers 400 `validation_failed`:
     * the error's `message` is the first problem as a sentence, and `error.data.fields` has
     * one sentence per field, keyed by its path (`name`, `kindConfig.task.fields[0].label`).
     */
    create: (input: CreateAgentInput) =>
      client.post<CreateAgentResult>("/api/agents", input),

    /**
     * `PATCH /api/agents/{id}`. The answer is the agent row alone: its deployments are not included.
     * `schedulePaused` is `true` only when this change turned the agent's own schedule off, by
     * moving its kind away from `scheduled`; setting the kind back turns nothing on.
     */
    update: (id: string, updates: UpdateAgentInput) =>
      client.patch<{ agent: Omit<AgentDetail, "deployments">; schedulePaused?: true }>(`/api/agents/${seg(id)}`, updates),

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

    /**
     * Run a task agent on one filled-in form and wait for its result: `POST /api/agents/{id}/run`
     * with `stream: false`. `input` holds one answer per question, keyed by `TaskField.key`.
     * A form that does not fit answers 422 `input_invalid`, and `error.data.details` lists each
     * answer to fix as a `TaskInputIssue`; an agent that is not a task agent answers 409
     * `not_a_task_agent`, and answers that are too long 413 `input_too_large`. Nothing is
     * counted or charged for a refused form. A run may take up to two minutes, so the call waits
     * 130 seconds unless `options.timeoutMs` says otherwise.
     */
    run: (id: string, input: AgentRunInput, options?: RequestOptions) =>
      client.post<AgentRunResult>(
        `/api/agents/${seg(id)}/run`,
        { input, stream: false },
        { timeoutMs: RUN_TIMEOUT_MS, ...options },
      ),

    /** The agent's public page, `/a/<handle>`: the switch that lets anyone with the link use the agent. */
    publicLink: {
      /** `GET /api/agents/{id}/public-link`. */
      get: (id: string) => client.get<PublicLink>(`/api/agents/${seg(id)}/public-link`),

      /**
       * `PUT /api/agents/{id}/public-link`: turn the link `on`, `paused` or `off`, and optionally set
       * the daily cap, the address or whether results show. A handle that breaks the rules answers 400
       * `validation_failed`; one another agent has answers 409 `handle_taken`. Needs an owner or admin.
       */
      set: (id: string, body: PublicLinkInput) =>
        client.put<PublicLink>(`/api/agents/${seg(id)}/public-link`, body),
    },

    /** An agent's own schedule: what it is told, when, and where the result goes. */
    schedule: {
      /** `GET /api/agents/{id}/schedule`. `schedule` is null until the agent has one. */
      get: (id: string) => client.get<ScheduleAnswer>(`/api/agents/${seg(id)}/schedule`),

      /**
       * `PUT /api/agents/{id}/schedule`: creates the schedule, or changes it. Times or a time zone
       * the API cannot read answer 400 `invalid_schedule`; a field outside its range 400
       * `validation_failed`; a schedule changed somewhere else in the meantime 409 `schedule_changed`.
       */
      set: (id: string, body: ScheduleInput) =>
        client.put<ScheduleAnswer>(`/api/agents/${seg(id)}/schedule`, body),

      /**
       * `POST /api/agents/{id}/schedule/run`: one run now, billed, bounded, recorded and delivered as
       * a timed run is. An API key needs the `agents:invoke` scope. A run already in flight answers
       * 409 `already_running`; an agent with no schedule 404 `schedule_not_found`.
       */
      runNow: (id: string) => client.post<{ run: RunView }>(`/api/agents/${seg(id)}/schedule/run`),
    },

    /** What an agent's own schedule produced. */
    runs: {
      /**
       * `GET /api/agents/{id}/runs`, newest first. `limit` is 1 to 100 (default 20); `before` is the
       * id of the last run already read, and `hasMore` says whether another page follows it.
       */
      list: (id: string, params?: { limit?: number; before?: string }) =>
        client.get<{ runs: RunView[]; hasMore: boolean }>(`/api/agents/${seg(id)}/runs`, params),

      /**
       * `POST /api/agents/{id}/runs/{runId}/deliver` ("Send again"): posts the saved result of a
       * finished run to the place the schedule names now. It runs nothing. 409 `run_not_finished`;
       * 400 `no_place` when the schedule names no place; 502 `delivery_failed` when the place did not
       * take it (the error's `data.run` has the run, with the failed try recorded).
       */
      resend: (id: string, runId: string) =>
        client.post<{ run: RunView }>(`/api/agents/${seg(id)}/runs/${seg(runId)}/deliver`),
    },

    /**
     * The models an agent can be set to: free ones, ones that need your own provider key, and
     * `hostedModels`, the models your organization runs on its own deployments.
     */
    playgroundModels: (id: string) => client.get<PlaygroundModels>(`/api/agents/${seg(id)}/playground/models`),

    /**
     * `GET /api/agents/hosted-models`: the models your organization runs on its own deployments, as
     * an agent's model choices. The same list as `playgroundModels(id).hostedModels`, without an agent.
     * An agent set to an entry's `id` answers only while `available` is true.
     */
    hostedModels: () => client.get<{ hostedModels: HostedModelChoice[] }>("/api/agents/hosted-models"),

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
