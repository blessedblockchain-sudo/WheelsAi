import { seg, type RequestOptions, type WheelsAIClient } from "../client.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  /** Optional: the deployment in the path decides the model. */
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
}

export interface ChatCompletionResponse {
  id: string;
  object?: string;
  model?: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function inferenceResource(client: WheelsAIClient) {
  return {
    /**
     * OpenAI-compatible chat completion against one of your running deployments:
     * `POST /v1/{deploymentSlug}/chat/completions`. Streaming is not supported
     * by this method (use the OpenAI SDK for SSE). A deployment on real GPU capacity
     * is billed per GPU-second by a worker, so a request takes no per-token credit hold
     * there; other deployments answer 402 when credits run out.
     */
    chatCompletion: (deploymentSlug: string, request: ChatCompletionRequest, options?: RequestOptions) =>
      client.post<ChatCompletionResponse>(`/v1/${seg(deploymentSlug)}/chat/completions`, request, options),

    /** Your running deployments, in OpenAI's model-list shape. `id` is the deployment slug. */
    listModels: () =>
      client.get<{ object: "list"; data: Array<{ id: string; object: string; created: number; owned_by: string; root?: string }> }>(
        "/v1/models",
      ),
  };
}
