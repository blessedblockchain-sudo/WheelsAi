import { seg, type Query, type RequestOptions, type WheelsAIClient } from "../client.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "./inference.js";

export type WorkflowExecutionMode = "sequential" | "parallel" | "conditional" | "pipeline";
export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** A workflow: steps (agents, model deployments, knowledge searches) run as one unit. */
export interface Workflow {
  id: string;
  name: string;
  /**
   * The workflow's address under `/v1`. Set from the name when the workflow is created and
   * unique in the organization; renaming the workflow does not change it.
   */
  slug: string;
  description: string | null;
  executionMode: WorkflowExecutionMode;
  /** The run's time limit in ms. A run through `/v1` is waited for this long, then cancelled. */
  timeout: number;
  isEnabled: boolean;
  /**
   * `<api>/v1/workflows/<slug>/chat/completions`, where the workflow answers as an OpenAI chat
   * completion. null when the server has no public address configured (PUBLIC_API_URL).
   */
  apiEndpoint: string | null;
  /** `<api>/v1/workflows/<slug>`: the base URL for an OpenAI client talking to this workflow only. */
  openaiBaseUrl: string | null;
  /** `workflow/<slug>`: pass it as `model` on the unified base (`inference.chat`). */
  openaiModel: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  status: WorkflowRunStatus;
  /** `api` for a run started with an API key or through `/v1`. */
  triggeredBy: string;
  triggeredById: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  output?: Record<string, unknown> | null;
}

/** `wheelsai.workflow` on a workflow's chat completion: the run behind the answer. */
export interface WorkflowCompletionExtension {
  workflow: {
    slug: string;
    /** Look the run up with `workflows.getRun`. */
    executionId: string;
    status: WorkflowRunStatus;
    durationMs: number | null;
    steps: Array<{
      name: string;
      type: "agent" | "model" | "retrieval";
      status: "success" | "failed" | "skipped";
      /** Loop pass, when the step is a loop. */
      iteration?: number;
      durationMs: number | null;
      error: string | null;
    }>;
  };
}

/** A workflow's chat completion: `wheelsai` describes the run, not an agent. */
export type WorkflowChatCompletionResponse = Omit<ChatCompletionResponse, "wheelsai"> & {
  wheelsai?: WorkflowCompletionExtension;
};

export function workflowsResource(client: WheelsAIClient) {
  return {
    list: (query?: { isEnabled?: boolean; limit?: number; offset?: number }) =>
      client.get<{ orchestrations: Workflow[]; total: number }>("/api/orchestrations", query as Query),

    get: (workflowId: string) => client.get<Workflow>(`/api/orchestrations/${seg(workflowId)}`),

    /**
     * Starts a run and returns at once (`202`, status `queued`); a worker executes it. Poll
     * `getRun` for the outcome. For one call that waits for the answer, use `chatCompletion`.
     */
    run: (workflowId: string, body: { prompt?: string; input?: Record<string, unknown> } = {}) =>
      client.post<{ execution: WorkflowRun }>(`/api/orchestrations/${seg(workflowId)}/execute`, body),

    getRun: (workflowId: string, executionId: string) =>
      client.get<WorkflowRun>(`/api/orchestrations/${seg(workflowId)}/executions/${seg(executionId)}`),

    /** Cancels a queued run outright, or asks a running one to stop (its in-flight step is aborted). */
    cancelRun: (workflowId: string, executionId: string) =>
      client.post<{ execution: WorkflowRun }>(
        `/api/orchestrations/${seg(workflowId)}/executions/${seg(executionId)}/cancel`,
      ),

    /**
     * Runs the workflow and waits for its answer, as an OpenAI chat completion:
     * `POST /v1/workflows/{slug}/chat/completions`. The last user message is the run's input
     * (a JSON object in it is the structured input of a workflow that declares an input schema);
     * the run's output is the assistant message; `usage` is summed over the steps and left out
     * when any step's model call reported none; `wheelsai.workflow` carries the execution id and
     * each step's outcome.
     *
     * One call is one run and one plan API call; every step is billed by its own rules. `tools`
     * are refused (400). The request waits for the workflow's own time limit and the run is
     * cancelled if that passes or if you disconnect, so set `{ timeoutMs }` at least as high as
     * the workflow's `timeout`. A failed run answers 502 `workflow_failed`, a timed-out one 504
     * `workflow_timeout`; neither should be retried blindly, because a repeat is a new run. This
     * method does not stream; for `stream: true` point the OpenAI SDK at `openaiBaseUrl`.
     */
    chatCompletion: (workflowSlug: string, request: ChatCompletionRequest, options?: RequestOptions) =>
      client.post<WorkflowChatCompletionResponse>(
        `/v1/workflows/${seg(workflowSlug)}/chat/completions`,
        request,
        options,
      ),
  };
}
