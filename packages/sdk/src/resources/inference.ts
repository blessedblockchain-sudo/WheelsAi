import { seg, type RequestOptions, type WheelsAIClient } from "../client.js";
import type { UseBilling } from "./use.js";

/** A function call the model asks the CALLER to run (OpenAI "function calling"). */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  /** `tool` carries a function result back and needs `tool_call_id`. */
  role: "system" | "developer" | "user" | "assistant" | "tool";
  /** null on an assistant message that only carries `tool_calls`. */
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

/** A function the caller executes. */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema of the arguments. */
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ChatToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatCompletionRequest {
  /**
   * On the unified base (`inference.chat`): `agent/<slug>`, `workflow/<slug>`, `a/<handle>`,
   * `w/<slug>` or a deployment slug, required. On a path-scoped call (`inference.chatCompletion`, `agents.chatCompletion`,
   * `workflows.chatCompletion`): optional, the path decides.
   */
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  /**
   * Agents only from here on: a model deployment's endpoint accepts the fields above.
   */
  max_completion_tokens?: number;
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  response_format?: { type: "text" | "json_object" | "json_schema"; [key: string]: unknown };
  user?: string;
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

/** What `/v1` adds to an agent's completion; absent on a model deployment's. */
export interface ChatCompletionExtension {
  agent: { slug: string; version: string };
  /**
   * The model that actually answered; `model` on the response is `agent/<slug>`. For a graph
   * agent, the model its llm nodes default to, or null when the agent configures none.
   */
  model: string | null;
  /** `graph` when the agent answered by running its saved graph. */
  runtime: "platform" | "graph";
  /** The run behind a graph agent's answer. */
  graph?: {
    executionId: string;
    durationMs: number;
    steps: Array<{ nodeId: string; nodeType: string; label: string; status: string; durationMs: number }>;
  };
  /** The agent's own server-side tool calls and how each ended. */
  tool_calls?: Array<{ round: number; name: string; status: "ok" | "unavailable" | "error" | "unknown"; detail: string | null }>;
  /** Set when the agent is a per-request marketplace install and the call was charged. */
  billing: { listingTitle: string; chargedCents: number; creatorCents: number } | null;
  retrieval: {
    mode: string;
    fallbackReason: string | null;
    sources: Array<{ chunkId: string; documentId: string; documentTitle: string; score: number }>;
  } | null;
}

export interface ChatCompletionResponse {
  id: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    message: ChatMessage & { refusal?: string | null };
    /** `tool_calls` when `message.tool_calls` holds functions for the caller to run. */
    finish_reason: string | null;
  }>;
  /** Left out when the model provider reported none; never zero-filled. */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /**
   * An agent's extension. A workflow's completion (`model: "workflow/<slug>"`) carries
   * `{ workflow: ... }` here instead: see `WorkflowCompletionExtension`.
   */
  wheelsai?: ChatCompletionExtension;
}

/**
 * What `/v1` adds to the completion of an agent you pay for (`model: "a/<handle>"`): nothing but this.
 * The response has no `usage`, and every chunk of a stream carries `model: "a/<handle>"`; the first chunk of a
 * stream has `choices: []` and this object.
 */
export interface PaidAgentCompletionExtension {
  agent: { handle: string };
  /** What the use cost; `chargedCents` is 0 inside a paid month and for a use a plan includes. On a plan it carries `plan`. */
  billing: UseBilling;
}

/**
 * What `/v1` adds to the completion of a workflow you pay to run (`model: "w/<slug>"`): nothing but this, with
 * the slug of its listing. The response has no `usage`, and its `model` is `w/<slug>`. A stream opens only once
 * the answer is whole; its first chunk has `choices: []` and this object.
 */
export interface PaidWorkflowCompletionExtension {
  workflow: { slug: string };
  /** What the run cost; on a plan it carries `plan`. */
  billing: UseBilling;
}

/**
 * One entry of `GET /v1/models`: a running deployment, an agent, an enabled workflow, an agent you pay for, or a
 * workflow you pay to run.
 */
export interface ModelEntry {
  /** A deployment slug, `agent/<slug>`, `workflow/<slug>`, `a/<handle>` or `w/<slug>`. Pass it as `model` to `inference.chat`. */
  id: string;
  object: string;
  created: number;
  owned_by: string;
  /** Deployments only: the underlying Hugging Face model id. */
  root?: string;
  wheelsai?: { kind: "deployment" | "agent" | "workflow" | "paid_agent" | "paid_workflow" };
}

export function inferenceResource(client: WheelsAIClient) {
  return {
    /**
     * A chat completion on the unified OpenAI base, `POST /v1/chat/completions`. `model` picks what
     * answers: `agent/<slug>` for an agent, `workflow/<slug>` for a workflow (one call is one
     * run; see `workflows.chatCompletion`), `a/<handle>` for an agent you pay to use (see `use`),
     * `w/<slug>` for a workflow you pay to run (see `use.workflow`), or the slug of a running model
     * deployment (`listModels` returns them all). Not streamed: for server-sent events point the
     * OpenAI SDK at `<api>/v1`. An agent with tools, or a long answer from a model deployment, can
     * outlast the client's default timeout of 30 seconds (the API gives a model up to two minutes):
     * pass `{ timeoutMs }`. A `w/<slug>` run can take up to 10 minutes and nothing is sent while it
     * goes: pass `{ timeoutMs: 11 * 60_000 }`, because a call that gives up sooner cancels the run.
     */
    chat: (request: ChatCompletionRequest & { model: string }, options?: RequestOptions) =>
      client.post<ChatCompletionResponse>("/v1/chat/completions", request, options),

    /**
     * OpenAI-compatible chat completion against one of your running deployments:
     * `POST /v1/{deploymentSlug}/chat/completions`. The same wire format as an agent's:
     * `tools` and `tool_choice` are forwarded to the model server, the response's `model` is
     * the deployment's slug, and errors are `{ error: { message, type, param, code } }` with
     * the model server's own status (a 400 it answers is a 400 here). `max_tokens` is at most
     * 8192. This method does not stream; the endpoint does (`stream: true` with the OpenAI SDK
     * pointed at `<api>/v1`). A deployment on real GPU capacity is billed per GPU-second by a
     * worker, so a request takes no per-token credit hold there; other deployments answer 402
     * when credits run out. A long answer can outlast the client's default timeout of 30 seconds
     * (the API gives the model up to two minutes): pass `{ timeoutMs }`.
     */
    chatCompletion: (deploymentSlug: string, request: ChatCompletionRequest, options?: RequestOptions) =>
      client.post<ChatCompletionResponse>(`/v1/${seg(deploymentSlug)}/chat/completions`, request, options),

    /**
     * Everything you can pass as `model`: your running deployments (`id` is the slug), your
     * agents (`agent/<slug>`) and your enabled workflows (`workflow/<slug>`), and the agents
     * (`a/<handle>`) and workflows (`w/<slug>`) of others that your organization has started and
     * pays for, on a plan that is running or at a price it agreed to, in OpenAI's model-list shape.
     * Free: not a metered call.
     */
    listModels: () => client.get<{ object: "list"; data: ModelEntry[] }>("/v1/models"),
  };
}
