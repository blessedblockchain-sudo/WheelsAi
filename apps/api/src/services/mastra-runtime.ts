/**
 * Mastra Runtime Service
 *
 * Provides ephemeral agent execution for the playground.
 * Creates Mastra Agent instances per-request for chat interactions.
 */

import { createLogger } from "../utils/logger.js";
import { isFreeModel, resolveFreeModelConfig } from "../config/free-models.js";

const logger = createLogger("mastra-runtime");

// ============================================
// Types
// ============================================

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatResult {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface AgentPlaygroundConfig {
  name: string;
  systemPrompt?: string;
  tools: Array<{
    name: string;
    description: string;
    type?: string;
    config?: Record<string, unknown>;
  }>;
  modelConfig: {
    externalModel?: string;
    temperature: number;
    maxTokens: number;
  };
}

// ============================================
// Built-in Tool Executors
// ============================================

function createCalculatorExecutor() {
  return async (input: { expression: string }): Promise<string> => {
    try {
      // Safe math evaluation — only allows numbers and basic operators
      const sanitized = input.expression.replace(/[^0-9+\-*/().%\s]/g, "");
      if (sanitized !== input.expression) {
        return "Error: Expression contains invalid characters. Only numbers and +, -, *, /, (), %, . are allowed.";
      }
      const fn = new Function(`"use strict"; return (${sanitized});`);
      const result = fn();
      return String(result);
    } catch {
      return `Error: Could not evaluate expression "${input.expression}"`;
    }
  };
}

function createHttpRequestExecutor() {
  return async (input: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<string> => {
    try {
      // SSRF protection — block private/internal IPs
      const url = new URL(input.url);
      const blockedHosts = [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "169.254.169.254", // AWS metadata
        "metadata.google.internal",
      ];
      if (
        blockedHosts.includes(url.hostname) ||
        url.hostname.startsWith("10.") ||
        url.hostname.startsWith("172.") ||
        url.hostname.startsWith("192.168.")
      ) {
        return "Error: Requests to internal/private addresses are not allowed.";
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(input.url, {
        method: input.method || "GET",
        headers: input.headers,
        body: input.body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const text = await res.text();
      // Truncate large responses
      const truncated = text.length > 5000 ? text.slice(0, 5000) + "\n...[truncated]" : text;
      return `Status: ${res.status}\n\n${truncated}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "Request failed"}`;
    }
  };
}

// ============================================
// Model Resolution
// ============================================

export interface ResolvedModel {
  apiKey: string;
  baseUrl: string;
  modelName: string;
}

/**
 * Resolve model config for playground use.
 * Free models use platform keys; paid models need user-provided keys.
 */
export function resolveModelForPlayground(
  modelId: string,
  agentEnv?: Record<string, string>
): ResolvedModel {
  // Free model — use platform API key
  if (isFreeModel(modelId)) {
    const config = resolveFreeModelConfig(modelId);
    if (!config) {
      throw new Error(
        `Free model "${modelId}" is not available. The required API key is not configured on the platform.`
      );
    }
    return config;
  }

  // Paid model — extract provider and look up key
  const [provider, ...rest] = modelId.split("/");
  const modelName = rest.join("/") || modelId;

  const providerConfig: Record<string, { envKey: string; baseUrl: string }> = {
    openai: { envKey: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
    anthropic: { envKey: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com/v1" },
    google: { envKey: "GOOGLE_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
    together: { envKey: "TOGETHER_API_KEY", baseUrl: "https://api.together.xyz/v1" },
    groq: { envKey: "GROQ_API_KEY", baseUrl: "https://api.groq.com/openai/v1" },
  };

  const config = providerConfig[provider ?? "openai"];
  if (!config) {
    throw new Error(`Unknown model provider: ${provider}`);
  }

  const apiKey = agentEnv?.[config.envKey];
  if (!apiKey) {
    throw new Error(
      `Model "${modelId}" requires an API key. Set ${config.envKey} in your agent's environment variables.`
    );
  }

  return { apiKey, baseUrl: config.baseUrl, modelName };
}

// ============================================
// Chat Execution
// ============================================

/**
 * Run a chat interaction using the OpenAI-compatible API.
 * Works with Groq, Together, Google Gemini (OpenAI compat), and OpenAI itself.
 */
export async function runChat(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
  stream?: false
): Promise<ChatResult>;
export async function runChat(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
  stream: true
): Promise<ReadableStream<Uint8Array>>;
export async function runChat(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
  stream?: boolean
): Promise<ChatResult | ReadableStream<Uint8Array>> {
  // Build tool definitions for the API
  const tools = agentConfig.tools
    .filter((t) => ["calculator", "http_request"].includes(t.name))
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: getToolParameters(t.name),
      },
    }));

  // Prepend system message
  const fullMessages: Array<{ role: string; content: string }> = [];
  if (agentConfig.systemPrompt) {
    fullMessages.push({ role: "system", content: agentConfig.systemPrompt });
  }
  fullMessages.push(...messages);

  const body: Record<string, unknown> = {
    model: resolved.modelName,
    messages: fullMessages,
    temperature: agentConfig.modelConfig.temperature,
    max_tokens: agentConfig.modelConfig.maxTokens,
    stream: Boolean(stream),
  };

  if (tools.length > 0) {
    body.tools = tools;
  }

  const res = await fetch(`${resolved.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    logger.error({ status: res.status, errText }, "Model API error");
    throw new Error(`Model API returned ${res.status}: ${errText}`);
  }

  // Streaming response — return the raw stream for SSE forwarding
  if (stream) {
    if (!res.body) {
      throw new Error("No response body for streaming");
    }
    return res.body;
  }

  // Non-streaming — parse and handle tool calls
  const data = await res.json();
  const choice = data.choices?.[0];
  let content = choice?.message?.content ?? "";

  // Handle tool calls (single round)
  if (choice?.message?.tool_calls?.length > 0) {
    const toolResults = await executeToolCalls(choice.message.tool_calls);
    // Make a follow-up call with tool results
    const followUpMessages = [
      ...fullMessages,
      choice.message,
      ...toolResults,
    ];

    const followUp = await fetch(`${resolved.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: resolved.modelName,
        messages: followUpMessages,
        temperature: agentConfig.modelConfig.temperature,
        max_tokens: agentConfig.modelConfig.maxTokens,
      }),
    });

    if (followUp.ok) {
      const followUpData = await followUp.json();
      content = followUpData.choices?.[0]?.message?.content ?? content;
    }
  }

  return {
    content,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

// ============================================
// Tool Helpers
// ============================================

function getToolParameters(toolName: string): Record<string, unknown> {
  const params: Record<string, Record<string, unknown>> = {
    calculator: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Mathematical expression to evaluate" },
      },
      required: ["expression"],
    },
    http_request: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to request" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], default: "GET" },
        headers: { type: "object", description: "Request headers" },
        body: { type: "string", description: "Request body" },
      },
      required: ["url"],
    },
  };
  return params[toolName] ?? { type: "object", properties: {} };
}

const toolExecutors: Record<string, (input: any) => Promise<string>> = {
  calculator: createCalculatorExecutor(),
  http_request: createHttpRequestExecutor(),
};

async function executeToolCalls(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>
): Promise<Array<{ role: "tool"; tool_call_id: string; content: string }>> {
  const results = [];
  for (const call of toolCalls) {
    const executor = toolExecutors[call.function.name];
    let content: string;
    if (executor) {
      try {
        const args = JSON.parse(call.function.arguments);
        content = await executor(args);
      } catch (err) {
        content = `Error executing ${call.function.name}: ${err instanceof Error ? err.message : "Unknown error"}`;
      }
    } else {
      content = `Tool "${call.function.name}" is not available in playground mode.`;
    }
    results.push({ role: "tool" as const, tool_call_id: call.id, content });
  }
  return results;
}
