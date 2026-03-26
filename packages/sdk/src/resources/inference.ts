import type { WheelsAIClient } from "../client.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function inferenceResource(client: WheelsAIClient) {
  return {
    chatCompletion: (request: ChatCompletionRequest) =>
      client.post<ChatCompletionResponse>("/v1/chat/completions", request),

    listModels: () =>
      client.get<{ data: Array<{ id: string; object: string; owned_by: string }> }>("/v1/models"),
  };
}
