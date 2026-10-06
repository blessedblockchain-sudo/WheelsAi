/**
 * Chat runtime: one path for every agent conversation.
 *
 * Every caller - the playground, the scheduler, orchestration steps and the
 * graph interpreter's llm node - goes through `runChat`. It speaks the
 * OpenAI-compatible chat API (Groq, Together, Google's OpenAI endpoint,
 * OpenAI itself) and drives tool use through the skills registry and the tool
 * loop, so a tool an agent has enabled either really runs or honestly reports
 * "unavailable: <reason>" - in streaming and non-streaming mode alike.
 *
 * Streaming and tools:
 *   - An agent with NO enabled tools streams the provider's body straight
 *     through (byte for byte), watched on the side so the caller learns
 *     whether a real answer was produced.
 *   - An agent WITH tools runs its tool rounds non-streaming first, then emits
 *     only the final answer as OpenAI-format SSE chunks. Nothing is sent to
 *     the client before the answer exists, so a tool call can never produce an
 *     empty streamed reply and a provider failure still surfaces as a normal
 *     HTTP error before any header is flushed. (Token-level streaming of the
 *     final answer for tool-using agents is not implemented.)
 */

import { randomUUID } from "node:crypto";

import { createLogger } from "../utils/logger.js";
import { isFreeModel, resolveFreeModelConfig } from "../config/free-models.js";
import type { SkillRegistry } from "./skills/registry.js";
import type { ToolMode, ToolSpec } from "./skills/types.js";
import {
  runToolLoop,
  type CallModel,
  type ModelMessage,
  type ModelToolCall,
  type TokenUsage,
  type ToolCallRecord,
} from "./toolLoop.js";

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
  /** Every tool the model called, and how each call ended. */
  toolCalls?: ToolCallRecord[];
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

/** Optional extras; every field may be omitted by pre-existing callers. */
export interface RunChatOptions {
  /** Scope for tools that act on the agent (files, knowledge base). */
  agentId?: string;
  orgId?: string;
  /** Where this chat runs from; gates e.g. money-moving tools. */
  mode?: ToolMode;
  signal?: AbortSignal;
  maxToolRounds?: number;
  /** Test seams. */
  registry?: SkillRegistry;
  fetchImpl?: typeof fetch;
}

export type StreamOutcome =
  | { ok: true; usage: TokenUsage | null; toolCalls: ToolCallRecord[] }
  | { ok: false; error: string; toolCalls: ToolCallRecord[] };

export interface ChatStream {
  /** OpenAI-format SSE bytes, ready to forward to a client. */
  stream: ReadableStream<Uint8Array>;
  /**
   * Resolves (never rejects) once the stream has ended, saying whether a REAL
   * answer was produced. Billing settles on `ok: true` only.
   */
  outcome: Promise<StreamOutcome>;
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

const encoder = new TextEncoder();

function sseEvent(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

const SSE_DONE = encoder.encode("data: [DONE]\n\n");

/** An error event the web client (and any OpenAI-style client) understands. */
function sseError(message: string): Uint8Array {
  return sseEvent({ error: { message } });
}

/** Characters per synthetic content chunk. */
const SSE_CHUNK_CHARS = 160;

function* chunkText(text: string, size: number): Generator<string> {
  const points = Array.from(text); // code points: never split a surrogate pair
  for (let i = 0; i < points.length; i += size) {
    yield points.slice(i, i + size).join("");
  }
}

function buildRequestBody(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: unknown[],
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    model: resolved.modelName,
    messages,
    temperature: agentConfig.modelConfig.temperature,
    max_tokens: agentConfig.modelConfig.maxTokens,
    ...extra,
  };
}

/** What a status means to the user, without anything the provider wrote. */
function providerErrorHint(status: number): string {
  if (status === 401 || status === 403) return "the model provider rejected the credentials";
  if (status === 404) return "the model was not found or is unavailable";
  if (status === 408 || status === 504) return "the model provider timed out";
  if (status === 429) return "the model provider's rate limit was reached";
  if (status >= 500) return "the model provider had an error";
  return "the model provider rejected the request";
}

async function postChatCompletion(
  fetchImpl: typeof fetch,
  resolved: ResolvedModel,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetchImpl(`${resolved.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    // The provider's error body can quote the request, name the account or
    // echo a key prefix, and this message is returned to the client and stored
    // on scheduled runs. The body goes to the log; the caller gets the status
    // and a generic reason.
    const errText = await res.text().catch(() => "Unknown error");
    logger.error({ status: res.status, errText: errText.slice(0, 2_000) }, "Model API error");
    throw new Error(`Model API returned ${res.status} (${providerErrorHint(res.status)})`);
  }
  return res;
}

/** The non-streaming model call the tool loop drives. */
function createProviderCallModel(
  fetchImpl: typeof fetch,
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
): CallModel {
  return async ({ messages, tools, toolChoice, signal }) => {
    const extra: Record<string, unknown> = { stream: false };
    if (tools && tools.length > 0) {
      extra.tools = tools;
      // "auto" is the provider default; only the forcing value is sent.
      if (toolChoice === "none") extra.tool_choice = "none";
    }
    const res = await postChatCompletion(
      fetchImpl,
      resolved,
      buildRequestBody(resolved, agentConfig, messages, extra),
      signal,
    );

    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{
        message?: {
          content?: unknown;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: unknown };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    if (!data) throw new Error("Model API returned a response that is not JSON");

    const choice = data.choices?.[0];
    const message = choice?.message;
    const toolCalls: ModelToolCall[] = (message?.tool_calls ?? []).map((call, index) => ({
      // Some providers send an empty id; the tool result must echo one.
      id: call.id || `call_${randomUUID().slice(0, 8)}_${index}`,
      name: call.function?.name ?? "",
      arguments:
        typeof call.function?.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments ?? {}),
    }));

    return {
      content: typeof message?.content === "string" ? message.content : "",
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      finishReason: choice?.finish_reason ?? null,
    };
  };
}

interface ToolingPlan {
  specs: ToolSpec[];
  registry: SkillRegistry | null;
}

/** Which of the agent's configured tools are real skills in this mode. */
async function planTooling(
  agentConfig: AgentPlaygroundConfig,
  mode: ToolMode,
  explicit?: SkillRegistry,
): Promise<ToolingPlan> {
  const names = agentConfig.tools.map((t) => t.name).filter((n) => typeof n === "string");
  if (names.length === 0) return { specs: [], registry: null };

  const registry =
    explicit ?? (await import("./skills/production.js")).getDefaultRegistry();
  return { specs: registry.toolSpecs(names, { mode }), registry };
}

function buildMessages(
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
): ModelMessage[] {
  const full: ModelMessage[] = [];
  if (agentConfig.systemPrompt) {
    full.push({ role: "system", content: agentConfig.systemPrompt });
  }
  for (const m of messages) full.push({ role: m.role, content: m.content });
  return full;
}

async function runToolChat(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
  plan: ToolingPlan,
  options: RunChatOptions,
  fetchImpl: typeof fetch,
): Promise<ChatResult> {
  const mode = options.mode ?? "playground";
  const ctxBase = {
    mode,
    agentId: options.agentId ?? "",
    orgId: options.orgId ?? "",
  };
  const registry = plan.registry;

  const result = await runToolLoop({
    messages: buildMessages(agentConfig, messages),
    tools: plan.specs,
    maxRounds: options.maxToolRounds,
    signal: options.signal,
    callModel: createProviderCallModel(fetchImpl, resolved, agentConfig),
    executeTool: async (name, input, signal) => {
      if (!registry) return { status: "error", message: `unknown tool "${name}"` };
      return registry.execute(name, input, { ...ctxBase, signal });
    },
  });

  return {
    content: result.content,
    usage: result.usage,
    toolCalls: result.toolCalls,
  };
}

/** Emits an already-complete answer as OpenAI-format SSE. */
function answerToStream(
  content: string,
  modelName: string,
  toolCalls: ToolCallRecord[],
): ReadableStream<Uint8Array> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    sseEvent({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (toolCalls.length > 0) {
        // Extension event: clients that only read `choices` ignore it.
        controller.enqueue(
          sseEvent({
            wheelsai: {
              toolCalls: toolCalls.map((c) => ({
                name: c.name,
                status: c.status,
                detail: c.detail,
              })),
            },
          }),
        );
      }
      let first = true;
      for (const piece of chunkText(content, SSE_CHUNK_CHARS)) {
        controller.enqueue(
          chunk(first ? { role: "assistant", content: piece } : { content: piece }, null),
        );
        first = false;
      }
      controller.enqueue(chunk({}, "stop"));
      controller.enqueue(SSE_DONE);
      controller.close();
    },
  });
}

/**
 * Watches a provider SSE stream as it is forwarded, to learn what actually
 * happened: did any answer text arrive, did the provider embed an error event
 * (which an HTTP 200 stream can do), did it finish.
 */
class SseWatcher {
  private buffer = "";
  private decoder = new TextDecoder();
  contentChars = 0;
  errorMessage: string | null = null;
  sawDone = false;
  finishReason: string | null = null;
  usage: TokenUsage | null = null;

  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      this.line(this.buffer.slice(0, newline).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(newline + 1);
    }
    // A provider that never sends a newline must not grow this unbounded.
    if (this.buffer.length > 1_000_000) this.buffer = "";
  }

  flush(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer.length > 0) this.line(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      this.sawDone = true;
      return;
    }
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json?.error) {
      this.errorMessage =
        typeof json.error === "string"
          ? json.error
          : (json.error.message ?? JSON.stringify(json.error));
      return;
    }
    const choice = json?.choices?.[0];
    const content = choice?.delta?.content;
    if (typeof content === "string") this.contentChars += content.length;
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
    const usage = json?.usage ?? json?.x_groq?.usage;
    if (usage && typeof usage.prompt_tokens === "number") {
      this.usage = {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens ?? 0,
      };
    }
  }
}

/** Forwards a provider stream untouched while judging its outcome. */
function passthroughStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): ChatStream {
  const reader = body.getReader();
  const watcher = new SseWatcher();
  let settled = false;
  let resolveOutcome!: (o: StreamOutcome) => void;
  const outcome = new Promise<StreamOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const finish = (o: StreamOutcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome(o);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) {
          watcher.push(value);
          controller.enqueue(value);
          return;
        }

        watcher.flush();
        if (watcher.errorMessage) {
          // The provider's own error event was already forwarded verbatim.
          finish({ ok: false, error: watcher.errorMessage, toolCalls: [] });
        } else if (watcher.contentChars === 0) {
          const error = `the model returned no answer${
            watcher.finishReason ? ` (finish_reason: ${watcher.finishReason})` : ""
          }`;
          controller.enqueue(sseError(error));
          finish({ ok: false, error, toolCalls: [] });
        } else if (!watcher.sawDone && !watcher.finishReason) {
          const error = "the model stream ended before the answer finished";
          controller.enqueue(sseError(error));
          finish({ ok: false, error, toolCalls: [] });
        } else {
          finish({ ok: true, usage: watcher.usage, toolCalls: [] });
        }
        controller.close();
      } catch (err) {
        const error = signal?.aborted
          ? "request cancelled before the answer finished"
          : `model stream failed: ${err instanceof Error ? err.message : String(err)}`;
        finish({ ok: false, error, toolCalls: [] });
        try {
          controller.enqueue(sseError(error));
          controller.close();
        } catch {
          // The consumer is already gone.
        }
      }
    },
    cancel(reason) {
      finish({
        ok: false,
        error: "client disconnected before the answer finished",
        toolCalls: [],
      });
      return reader.cancel(reason);
    },
  });

  return { stream, outcome };
}

/**
 * Streaming chat with an outcome. Throws (before returning) when the provider
 * rejects the request or a tool round fails, so callers can answer with a
 * plain HTTP error and refund without having flushed any header.
 */
export async function runChatStream(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
  options: RunChatOptions = {},
): Promise<ChatStream> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const plan = await planTooling(agentConfig, options.mode ?? "playground", options.registry);

  if (plan.specs.length > 0) {
    const result = await runToolChat(resolved, agentConfig, messages, plan, options, fetchImpl);
    return {
      stream: answerToStream(result.content, resolved.modelName, result.toolCalls ?? []),
      outcome: Promise.resolve({
        ok: true as const,
        usage: result.usage,
        toolCalls: result.toolCalls ?? [],
      }),
    };
  }

  const res = await postChatCompletion(
    fetchImpl,
    resolved,
    buildRequestBody(resolved, agentConfig, buildMessages(agentConfig, messages), {
      stream: true,
    }),
    options.signal,
  );
  if (!res.body) {
    throw new Error("No response body for streaming");
  }
  return passthroughStream(res.body, options.signal);
}

/**
 * Run a chat interaction using the OpenAI-compatible API.
 * Works with Groq, Together, Google Gemini (OpenAI compat), and OpenAI itself.
 */
export async function runChat(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
  stream?: false,
  options?: RunChatOptions
): Promise<ChatResult>;
export async function runChat(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
  stream: true,
  options?: RunChatOptions
): Promise<ReadableStream<Uint8Array>>;
export async function runChat(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
  stream?: boolean,
  options: RunChatOptions = {}
): Promise<ChatResult | ReadableStream<Uint8Array>> {
  if (stream) {
    return (await runChatStream(resolved, agentConfig, messages, options)).stream;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const plan = await planTooling(agentConfig, options.mode ?? "playground", options.registry);
  return runToolChat(resolved, agentConfig, messages, plan, options, fetchImpl);
}
