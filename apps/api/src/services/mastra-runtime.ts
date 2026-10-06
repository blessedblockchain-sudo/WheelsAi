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
 *
 * The pass-through contract is deliberately raw: the provider's bytes are
 * forwarded untouched. Making a stream safe for an OpenAI SDK (our ids, no
 * vendor fields, one [DONE], no provider error text) is the job of
 * `createOpenAiStreamAdapter` in openaiCompat.ts, applied by the /v1 routes.
 *
 * Function calling for API callers: `clientTools` are offered to the model
 * next to the agent's own skills. Skills run here; a call to a client tool is
 * handed back (`clientToolCalls`) for the caller to execute.
 */

import { randomUUID } from "node:crypto";

import { createLogger } from "../utils/logger.js";
import {
  freeModelProviderAndName,
  isFreeModel,
  resolveFreeModelConfig,
} from "../config/free-models.js";
import {
  extensionChunk,
  normalizeFinishReason,
  pickProviderParams,
  toChunk,
  toolCallDeltas,
  usageChunk,
  type ClientToolSpec,
  type CompletionMeta,
  type NormalizedMessage,
  type ProviderRequestParams,
  type ToolChoice,
} from "./openaiCompat.js";
import type { SkillRegistry } from "./skills/registry.js";
import type { ToolMode, ToolSpec } from "./skills/types.js";
import {
  runToolLoop,
  type CallModel,
  type ModelMessage,
  type ModelToolCall,
  type OfferedTool,
  type TokenUsage,
  type ToolCallRecord,
} from "./toolLoop.js";

const logger = createLogger("mastra-runtime");

// ============================================
// Types
// ============================================

/**
 * A conversation turn. Besides plain system/user/assistant text it carries
 * what function calling needs replayed: an assistant turn's `tool_calls` and
 * the `tool` results that answer them.
 */
export type ChatMessage = NormalizedMessage;

export interface ChatResult {
  /** Empty when the turn ended in a hand-back (`clientToolCalls`). */
  content: string;
  /**
   * Summed over every provider call; a call that reported no usage adds
   * zero. Kept for the callers that total it. Anything that SHOWS usage reads
   * `reportedUsage`, which does not pass an unknown off as zero.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** null when any provider call in this run reported no usage. */
  reportedUsage: TokenUsage | null;
  /** The provider's finish_reason for the final turn; "tool_calls" on a hand-back. */
  finishReason: string | null;
  /** Every tool the model called, and how each call ended. */
  toolCalls?: ToolCallRecord[];
  /** Calls to the caller's own functions, for the caller to execute. */
  clientToolCalls: ModelToolCall[];
  /** What the run appended server-side (see ToolLoopResult.transcript). */
  transcript: ModelMessage[];
}

export interface AgentPlaygroundConfig {
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
  /**
   * Caller-supplied sampling parameters. Only the allowlisted keys
   * (openaiCompat.PROVIDER_PARAM_KEYS) are ever sent to the provider;
   * `temperature` and `max_tokens` override the agent's own.
   */
  requestParams?: ProviderRequestParams;
  /** Functions the caller executes; offered next to the agent's skills. */
  clientTools?: ClientToolSpec[];
  /** The caller's tool_choice, applied to the first model call only. */
  toolChoice?: ToolChoice;
  /**
   * Ask the provider to report token usage on a stream. Sent only to
   * providers known to accept `stream_options`; others stream without it and
   * the outcome's usage stays null.
   */
  requestUsage?: boolean;
  /**
   * Wall-clock limit for the whole run (every tool round, and a stream until
   * its last byte). A provider that hangs past it fails with
   * ChatDeadlineError instead of holding the request open.
   */
  deadlineMs?: number;
  /** Test seams. */
  registry?: SkillRegistry;
  fetchImpl?: typeof fetch;
}

/** Why a stream did not produce an answer; drives what the client is told. */
export type StreamFailureCode =
  | "provider_error"
  | "empty_answer"
  | "truncated"
  | "transport"
  | "client_gone"
  | "deadline";

export type StreamOutcome =
  | {
      ok: true;
      usage: TokenUsage | null;
      toolCalls: ToolCallRecord[];
      finishReason?: string | null;
      /** Set when the stream ended in a hand-back from the tool loop. */
      clientToolCalls?: ModelToolCall[];
      transcript?: ModelMessage[];
    }
  | { ok: false; error: string; toolCalls: ToolCallRecord[]; code?: StreamFailureCode };

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
  /** Empty for an endpoint that takes no key (an inference node). */
  apiKey: string;
  baseUrl: string;
  modelName: string;
  /**
   * The endpoint is a third party's server reached by a stored URL (a
   * deployment's inference node): a redirect is refused rather than followed
   * to wherever it points.
   */
  refuseRedirects?: boolean;
  /** The endpoint accepts `stream_options.include_usage` (see STREAM_USAGE_HOSTS). */
  streamUsage?: boolean;
}

/**
 * The PLATFORM has no key for this free model's provider. Nothing the caller
 * can fix: the honest answer is 501 with this reason.
 */
export class ModelNotConfiguredError extends Error {
  readonly code = "model_provider_not_configured";
  constructor(readonly modelId: string) {
    super(
      `Free model "${modelId}" is not available. The required API key is not configured on the platform.`,
    );
    this.name = "ModelNotConfiguredError";
  }
}

/** The AGENT's own provider key is missing from its environment (a 400). */
export class ModelKeyMissingError extends Error {
  readonly code = "agent_model_key_missing";
  constructor(
    readonly modelId: string,
    readonly envKey: string,
  ) {
    super(
      `Model "${modelId}" requires an API key. Set ${envKey} in your agent's environment variables.`,
    );
    this.name = "ModelKeyMissingError";
  }
}

/** A model id no provider table knows: a typo or a retired id (a 400). */
export class UnknownModelError extends Error {
  readonly code = "unknown_model";
  constructor(message: string) {
    super(message);
    this.name = "UnknownModelError";
  }
}

/**
 * `wheelsai/<model>`: a model the org hosts on its own GPU deployment. Agent
 * chat (the playground and /v1) resolves it to that deployment before it gets
 * here (services/hostedModel.ts). The callers that resolve a model with this
 * function alone - graph llm nodes, scheduled tasks - cannot reach a
 * deployment's node yet, so there it is refused by name (501) rather than
 * reported as an unknown provider.
 */
export class HostedModelNotAvailableError extends Error {
  readonly code = "hosted_model_not_available";
  constructor(readonly modelId: string) {
    super(
      `Model "${modelId}" is a WheelsAI-hosted model, which graph nodes and scheduled tasks cannot call yet. It works in the agent's own chat (playground and /v1); here, use a free or bring-your-own-key model.`,
    );
    this.name = "HostedModelNotAvailableError";
  }
}

/** The provider answered with a non-2xx status. The body went to the log. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    /** The provider's own retry-after, in seconds, when it sent one. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(`Model API returned ${status} (${providerErrorHint(status)})`);
    this.name = "ProviderHttpError";
  }
}

/** The run outlived `deadlineMs`. */
export class ChatDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`the model did not answer within ${Math.round(deadlineMs / 1000)}s`);
    this.name = "ChatDeadlineError";
  }
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
      if (!freeModelProviderAndName(modelId)) {
        throw new UnknownModelError(`Free model "${modelId}" is not in the model catalog.`);
      }
      throw new ModelNotConfiguredError(modelId);
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

  if (provider === "wheelsai") throw new HostedModelNotAvailableError(modelId);

  const config = providerConfig[provider ?? "openai"];
  if (!config) {
    throw new UnknownModelError(`Unknown model provider: ${provider}`);
  }

  const apiKey = agentEnv?.[config.envKey];
  if (!apiKey) {
    throw new ModelKeyMissingError(modelId, config.envKey);
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
  requestParams?: ProviderRequestParams,
): Record<string, unknown> {
  // The allowlist is applied HERE, at the last step before the wire, so no
  // caller can widen what reaches a provider by passing a looser object.
  const params: Record<string, unknown> = { ...pickProviderParams(requestParams as Record<string, unknown>) };
  // Some providers reject parallel_tool_calls on a request with no tools.
  if (!extra.tools) delete params.parallel_tool_calls;
  return {
    model: resolved.modelName,
    messages,
    temperature: agentConfig.modelConfig.temperature,
    max_tokens: agentConfig.modelConfig.maxTokens,
    ...params,
    ...extra,
  };
}

/** Providers whose chat API accepts `stream_options.include_usage`. */
const STREAM_USAGE_HOSTS: ReadonlySet<string> = new Set([
  "api.openai.com",
  "api.groq.com",
  "api.together.xyz",
  "generativelanguage.googleapis.com",
]);

function providerAcceptsStreamUsage(resolved: ResolvedModel): boolean {
  if (resolved.streamUsage !== undefined) return resolved.streamUsage;
  try {
    return STREAM_USAGE_HOSTS.has(new URL(resolved.baseUrl).hostname);
  } catch {
    return false;
  }
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, (at - Date.now()) / 1000);
}

export interface Deadline {
  /** The client's signal combined with the deadline (or just the client's). */
  signal: AbortSignal | undefined;
  expired(): boolean;
  clear(): void;
}

/**
 * A real (ref'd) timer that is always cleared, for the reason toolLoop's
 * runWithTimeout gives: `AbortSignal.timeout` is unref'd.
 */
function startDeadline(deadlineMs: number | undefined, client?: AbortSignal): Deadline {
  if (!deadlineMs || deadlineMs <= 0) {
    return { signal: client, expired: () => false, clear: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ChatDeadlineError(deadlineMs)), deadlineMs);
  return {
    signal: client ? AbortSignal.any([client, controller.signal]) : controller.signal,
    expired: () => controller.signal.aborted,
    clear: () => clearTimeout(timer),
  };
}

/** A failure caused by the deadline surfaces as ChatDeadlineError, whatever fetch threw. */
function deadlineError(err: unknown, deadline: Deadline, options: RunChatOptions): unknown {
  if (deadline.expired() && !options.signal?.aborted && options.deadlineMs) {
    return new ChatDeadlineError(options.deadlineMs);
  }
  return err;
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
      ...(resolved.apiKey && { Authorization: `Bearer ${resolved.apiKey}` }),
    },
    body: JSON.stringify(body),
    signal,
    ...(resolved.refuseRedirects && { redirect: "manual" as const }),
  });

  if (resolved.refuseRedirects && (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))) {
    await res.body?.cancel().catch(() => {});
    logger.error({ status: res.status }, "Model endpoint answered with a redirect; refusing to follow it");
    throw new ProviderHttpError(502, null);
  }

  if (!res.ok) {
    // The provider's error body can quote the request, name the account or
    // echo a key prefix, and this message is returned to the client and stored
    // on scheduled runs. The body goes to the log; the caller gets the status
    // and a generic reason.
    const errText = await res.text().catch(() => "Unknown error");
    logger.error({ status: res.status, errText: errText.slice(0, 2_000) }, "Model API error");
    throw new ProviderHttpError(res.status, retryAfterSeconds(res));
  }
  return res;
}

/** The non-streaming model call the tool loop drives. */
function createProviderCallModel(
  fetchImpl: typeof fetch,
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  requestParams?: ProviderRequestParams,
): CallModel {
  return async ({ messages, tools, toolChoice, signal }) => {
    const extra: Record<string, unknown> = { stream: false };
    if (tools && tools.length > 0) {
      extra.tools = tools;
      // "auto" is the provider default; only a forcing value is sent.
      if (toolChoice && toolChoice !== "auto") extra.tool_choice = toolChoice;
    }
    const res = await postChatCompletion(
      fetchImpl,
      resolved,
      buildRequestBody(resolved, agentConfig, messages, extra, requestParams),
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
      // A provider that sends no usage block reported nothing: that is
      // null, not zero tokens.
      usage:
        typeof data.usage?.prompt_tokens === "number"
          ? {
              inputTokens: data.usage.prompt_tokens,
              outputTokens: data.usage.completion_tokens ?? 0,
            }
          : null,
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
  for (const m of messages) {
    // Field by field: a caller's message object never reaches the provider
    // with keys this function did not put there.
    if (m.role === "tool") {
      full.push({ role: "tool", content: m.content, tool_call_id: m.tool_call_id });
    } else if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      full.push({
        role: "assistant",
        content: m.content,
        tool_calls: m.tool_calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.function.name, arguments: call.function.arguments },
        })),
      });
    } else {
      full.push({ role: m.role, content: m.content ?? "" });
    }
  }
  return full;
}

function offeredClientTools(options: RunChatOptions): OfferedTool[] {
  return (options.clientTools ?? []).map((tool) => ({
    type: "function" as const,
    function: { ...tool.function },
  }));
}

async function runToolChat(
  resolved: ResolvedModel,
  agentConfig: AgentPlaygroundConfig,
  messages: ChatMessage[],
  plan: ToolingPlan,
  options: RunChatOptions,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
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
    clientTools: offeredClientTools(options),
    toolChoice: options.toolChoice,
    maxRounds: options.maxToolRounds,
    signal,
    callModel: createProviderCallModel(fetchImpl, resolved, agentConfig, options.requestParams),
    executeTool: async (name, input, toolSignal) => {
      if (!registry) return { status: "error", message: `unknown tool "${name}"` };
      return registry.execute(name, input, { ...ctxBase, signal: toolSignal });
    },
  });

  return {
    content: result.content,
    usage: result.usage,
    reportedUsage: result.reportedUsage,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls,
    clientToolCalls: result.clientToolCalls,
    transcript: result.transcript,
  };
}

/** Emits an already-complete turn as OpenAI-format SSE. */
export function answerToStream(
  result: ChatResult,
  modelName: string,
  includeUsage: boolean,
): ReadableStream<Uint8Array> {
  const meta: CompletionMeta = {
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: modelName,
  };
  const toolCalls = result.toolCalls ?? [];
  const handBack = result.clientToolCalls.length > 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (toolCalls.length > 0) {
        // Extension event. It is a full chunk with `choices: []` so a client
        // that reads `chunk.choices[0]?.delta` gets undefined, not a throw.
        controller.enqueue(
          sseEvent(
            extensionChunk(meta, {
              toolCalls: toolCalls.map((c) => ({
                name: c.name,
                status: c.status,
                detail: c.detail,
              })),
            }),
          ),
        );
      }
      let first = true;
      for (const piece of chunkText(result.content, SSE_CHUNK_CHARS)) {
        controller.enqueue(
          sseEvent(toChunk(meta, first ? { role: "assistant", content: piece } : { content: piece })),
        );
        first = false;
      }
      if (handBack) {
        controller.enqueue(
          sseEvent(
            toChunk(meta, {
              ...(first && { role: "assistant" }),
              tool_calls: toolCallDeltas(result.clientToolCalls),
            }),
          ),
        );
      }
      controller.enqueue(
        sseEvent(toChunk(meta, {}, normalizeFinishReason(result.finishReason, handBack))),
      );
      const usage = includeUsage ? usageChunk(meta, result.reportedUsage) : null;
      if (usage) controller.enqueue(sseEvent(usage));
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
  /** Deltas that carried tool calls: a function-calling turn has no text. */
  toolCallDeltas = 0;
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
    const toolCalls = choice?.delta?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) this.toolCallDeltas += 1;
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

/** What a watched stream has carried so far. */
export interface StreamProgress {
  /** Characters of answer text forwarded. */
  contentChars: number;
  /** The provider's own token count, once (and if) it has sent one. */
  usage: TokenUsage | null;
}

export interface WatchedChatStream extends ChatStream {
  /**
   * Readable at any time, including after a stream that failed or was cut
   * short: per-token billing has to price what WAS generated, and the outcome
   * of a stream that did not finish carries no usage.
   */
  progress(): StreamProgress;
}

/**
 * Forwards a provider stream untouched while judging its outcome. Exported
 * for the model-deployment proxy (routes/inference.ts), whose upstream is an
 * inference node rather than a model provider but speaks the same SSE.
 */
export function passthroughStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  deadline: Deadline,
): WatchedChatStream {
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
    deadline.clear();
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
          finish({ ok: false, error: watcher.errorMessage, toolCalls: [], code: "provider_error" });
        } else if (watcher.contentChars === 0 && watcher.toolCallDeltas === 0) {
          // Tool calls ARE an answer: a function-calling turn carries no text.
          const error = `the model returned no answer${
            watcher.finishReason ? ` (finish_reason: ${watcher.finishReason})` : ""
          }`;
          controller.enqueue(sseError(error));
          finish({ ok: false, error, toolCalls: [], code: "empty_answer" });
        } else if (!watcher.sawDone && !watcher.finishReason) {
          const error = "the model stream ended before the answer finished";
          controller.enqueue(sseError(error));
          finish({ ok: false, error, toolCalls: [], code: "truncated" });
        } else {
          finish({
            ok: true,
            usage: watcher.usage,
            toolCalls: [],
            finishReason: watcher.finishReason,
          });
        }
        controller.close();
      } catch (err) {
        const timedOut = deadline.expired() && !signal?.aborted;
        const error = timedOut
          ? "the model did not answer in time"
          : signal?.aborted
            ? "request cancelled before the answer finished"
            : `model stream failed: ${err instanceof Error ? err.message : String(err)}`;
        finish({
          ok: false,
          error,
          toolCalls: [],
          code: timedOut ? "deadline" : signal?.aborted ? "client_gone" : "transport",
        });
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
        code: "client_gone",
      });
      return reader.cancel(reason);
    },
  });

  return {
    stream,
    outcome,
    progress: () => ({ contentChars: watcher.contentChars, usage: watcher.usage }),
  };
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
  const deadline = startDeadline(options.deadlineMs, options.signal);

  try {
    if (plan.specs.length > 0) {
      const result = await runToolChat(
        resolved,
        agentConfig,
        messages,
        plan,
        options,
        fetchImpl,
        deadline.signal,
      );
      deadline.clear();
      return {
        stream: answerToStream(result, resolved.modelName, options.requestUsage === true),
        outcome: Promise.resolve({
          ok: true as const,
          // Never the zero-filled sum: an unreported round makes it unknown.
          usage: result.reportedUsage,
          toolCalls: result.toolCalls ?? [],
          finishReason: result.finishReason,
          clientToolCalls: result.clientToolCalls,
          transcript: result.transcript,
        }),
      };
    }

    // No server tools: the provider's stream goes straight through. A
    // caller's own functions ride along and come back as tool_call deltas.
    const extra: Record<string, unknown> = { stream: true };
    const clientTools = offeredClientTools(options);
    if (clientTools.length > 0) {
      extra.tools = clientTools;
      if (options.toolChoice && options.toolChoice !== "auto") extra.tool_choice = options.toolChoice;
    }
    if (options.requestUsage && providerAcceptsStreamUsage(resolved)) {
      extra.stream_options = { include_usage: true };
    }

    const res = await postChatCompletion(
      fetchImpl,
      resolved,
      buildRequestBody(
        resolved,
        agentConfig,
        buildMessages(agentConfig, messages),
        extra,
        options.requestParams,
      ),
      deadline.signal,
    );
    if (!res.body) {
      throw new Error("No response body for streaming");
    }
    // The deadline keeps running until the stream's last byte.
    return passthroughStream(res.body, options.signal, deadline);
  } catch (err) {
    deadline.clear();
    throw deadlineError(err, deadline, options);
  }
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
  const deadline = startDeadline(options.deadlineMs, options.signal);
  try {
    return await runToolChat(
      resolved,
      agentConfig,
      messages,
      plan,
      options,
      fetchImpl,
      deadline.signal,
    );
  } catch (err) {
    throw deadlineError(err, deadline, options);
  } finally {
    deadline.clear();
  }
}
