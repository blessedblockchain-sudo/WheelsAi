/**
 * Agent chat: the one service behind the playground and the /v1 agent API.
 *
 * Everything that decides whether an agent may answer, on which model, with
 * what grounding and at whose expense used to live inline in the playground
 * route. A second entry point (/v1) would have had to copy it, and the copies
 * would have drifted on exactly the parts that matter: who is charged, when
 * they are refunded, which tools may run.
 *
 * `prepareAgentChat` runs the checks in ONE fixed order and returns either a
 * typed refusal (the route maps it to its own error shape) or a session:
 *
 *   1. load the agent, scoped to the caller's organization
 *   2. caller restrictions and client-tool validation (no side effects)
 *   3. resolve the model and its provider (no side effects)
 *   4. free-tier limiter - free models only
 *   5. marketplace licence and charge - the only step that moves money, and
 *      the last one that can refuse: nothing above it charges, nothing below
 *      it refuses
 *   6. retrieval (best effort; a failure answers ungrounded)
 *   7. tool mode, and the continuation splice for function calling
 *
 * An agent whose entrypoint is its graph (Agent.entrypoint = "graph") takes
 * steps 1, 2 and 4 and then runs the graph saved in the builder instead of a
 * chat. The graph run charges, settles and refunds itself
 * (services/runAgentGraph.ts), so steps 5-7 are its own; see
 * `prepareGraphChat`.
 *
 * Money: a charge taken in step 5 is settled or refunded EXACTLY ONCE.
 * `session.complete()` does it itself. `session.stream()` returns a stream
 * that must be forwarded with forwardAndSettle (services/sseReply.ts) and
 * `session.meter`, because only the socket knows whether the answer arrived.
 * The meter the session exposes ignores every call after its first, so a
 * double settle or a settle-then-refund cannot happen whatever a route does.
 *
 * Pure core: every effect is a dependency (services/buildAgentChatDeps.ts
 * binds the real ones), so the unit tests drive this file with fakes.
 */

import type { RateLimitResult } from "../middleware/free-tier-limit.js";
import type { RetrievalResult } from "./agentRetrieval.js";
import { CLIENT_GONE, type SettleableMeter } from "./chatStreamSettlement.js";
import type { BeginMeteringResult } from "./marketplaceMeteringProduction.js";
import type { GateToken, RevocationReason } from "./marketplaceMetering.js";
import type {
  AgentPlaygroundConfig,
  ChatMessage,
  ChatResult,
  ChatStream,
  ResolvedModel,
  RunChatOptions,
} from "./mastra-runtime.js";
import { resolveAgentModelId } from "./agentModelResolution.js";
import {
  findToolNameConflict,
  type ClientToolSpec,
  type OpenAiErrorCode,
  type ProviderRequestParams,
  type ToolChoice,
} from "./openaiCompat.js";
import type { RunSlot } from "./inFlightRuns.js";
import type { ToolMode } from "./skills/types.js";
import type { ToolContinuationStore } from "./toolContinuationStore.js";
import type { ModelMessage, TokenUsage } from "./toolLoop.js";

// ============================================
// Input
// ============================================

/**
 * `owner`: a member (or API key) of the organization that owns the agent.
 * `public`: an anonymous visitor of a published agent (the widget). Public
 * callers get the agent exactly as its owner configured it: they cannot
 * steer it with system or tool messages, bring their own tools or pick the
 * model, and the limiter fails closed for them.
 */
export type AgentChatCaller = "owner" | "public";

/** Where the chat came from; recorded with its usage. */
export type AgentChatSource = "playground" | "api" | "widget";

export type AgentRef = { id: string } | { slug: string };

export interface AgentChatInput {
  /** The organization the agent must belong to. */
  orgId: string;
  agent: AgentRef;
  caller: AgentChatCaller;
  source: AgentChatSource;
  messages: ChatMessage[];
  /** A per-request model choice. Owner callers only. */
  modelOverride?: string | null;
  requestParams?: ProviderRequestParams;
  /** Functions the caller executes. Owner callers only. */
  clientTools?: ClientToolSpec[];
  toolChoice?: ToolChoice | null;
  /** Fires when the client goes away; the run stops and is refunded. */
  signal: AbortSignal;
}

/** The agent columns chat reads. */
export interface AgentChatAgent {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  version: string;
  systemPrompt: string | null;
  tools: unknown;
  modelConfig: unknown;
  /** Sealed; opened through deps.openAgentEnv. */
  env: unknown;
  knowledgeBaseId: string | null;
  /** "chat" (prompt, model and tools) or "graph" (the saved graph). */
  entrypoint?: string | null;
}

// ============================================
// Dependencies
// ============================================

export interface AgentChatUsageRecord {
  orgId: string;
  agentId: string;
  source: AgentChatSource;
  modelId: string;
  freeModel: boolean;
  streamed: boolean;
  /** A real answer (or a hand-back) was produced. */
  ok: boolean;
  /** The caller hung up first: counted as a request, not as an error. */
  clientGone: boolean;
  /** null = the provider did not report usage. Never zero-filled. */
  usage: TokenUsage | null;
  toolCallCount: number;
  latencyMs: number;
}

/** One node of a graph run, as a caller may see it (no inputs or outputs). */
export interface AgentGraphStep {
  nodeId: string;
  nodeType: string;
  label: string;
  status: string;
  durationMs: number;
}

/** What a response says about the graph run that produced it. */
export interface AgentGraphRunInfo {
  /** The persisted run (AgentGraphExecution), inspectable in the builder. */
  executionId: string;
  durationMs: number;
  steps: AgentGraphStep[];
}

/**
 * How a graph run ended. The run charges a marketplace buyer before it
 * starts and settles or refunds when it ends, all inside `runGraph`, so the
 * two billing refusals come back from the run itself.
 */
export type AgentGraphOutcome =
  | { kind: "completed"; output: string | null; run: AgentGraphRunInfo }
  /** The run was refunded. `failedStep` is the node that stopped it. */
  | { kind: "failed"; run: AgentGraphRunInfo; failedStep: string | null }
  /** The agent has no saved graph, or an empty one. Nothing was charged. */
  | { kind: "no_graph" }
  | { kind: "licence_revoked"; listingTitle: string; revocation: RevocationReason; token?: GateToken }
  | { kind: "payment_required"; listingTitle: string; requiredCents: bigint; balanceCents: bigint }
  /** The server is restarting; nothing was charged. */
  | { kind: "shutting_down" };

export interface AgentChatDeps {
  /** MUST scope by orgId: another organization's agent is "not found". */
  loadAgent(where: { orgId: string } & AgentRef): Promise<AgentChatAgent | null>;
  openAgentEnv(sealed: unknown): Record<string, string>;
  /** Ids of free models whose provider key the platform has, in catalog order. */
  availableFreeModelIds(): string[];
  isFreeModel(modelId: string): boolean;
  /** Throws the runtime's typed errors (ModelNotConfiguredError, ...). */
  resolveModel(modelId: string, agentEnv: Record<string, string>): ResolvedModel;
  /**
   * `wheelsai/<model id>`: the organization's own running deployment of that
   * model (services/hostedModel.ts). Read-only. Omitted = hosted models are
   * left to resolveModel, which refuses them by name.
   */
  resolveHostedModel?(args: {
    orgId: string;
    modelId: string;
  }): Promise<{ ok: true; resolved: ResolvedModel } | { ok: false; message: string }>;
  checkFreeTierLimit(orgId: string, options: { failClosed: boolean }): Promise<RateLimitResult>;
  retrieveContext(args: {
    agentId: string;
    orgId: string;
    query: string;
  }): Promise<RetrievalResult | null>;
  beginMetering(args: { agentId: string; orgId: string }): Promise<BeginMeteringResult>;
  resolveToolMode(args: { agentId: string; orgId: string; base: ToolMode }): Promise<ToolMode>;
  /** Every skill key the platform knows (reserved function names). */
  skillKeys(): string[];
  runChat(
    resolved: ResolvedModel,
    config: AgentPlaygroundConfig,
    messages: ChatMessage[],
    options: RunChatOptions,
  ): Promise<ChatResult>;
  runChatStream(
    resolved: ResolvedModel,
    config: AgentPlaygroundConfig,
    messages: ChatMessage[],
    options: RunChatOptions,
  ): Promise<ChatStream>;
  /**
   * Runs the agent's saved graph on `input`, metering it as one request.
   * Never throws for a refusal or a failed run (see AgentGraphOutcome).
   * Omitted = this server cannot run graphs; a graph agent answers 501.
   */
  runGraph?(args: {
    agentId: string;
    orgId: string;
    input: string;
    signal: AbortSignal;
  }): Promise<AgentGraphOutcome>;
  /** A finished answer as OpenAI-format SSE (the runtime's answerToStream). */
  answerStream?(result: ChatResult, modelName: string): ReadableStream<Uint8Array>;
  /**
   * Registers a chat that is about to be charged, so shutdown can cancel it
   * and wait for its refund instead of killing the process with the charge
   * stranded. null = shutdown has begun: refuse before charging. Omitted =
   * chats are not tracked.
   */
  beginRun?(): RunSlot | null;
  /** Best effort: a rejection is logged and never reaches the caller. */
  recordUsage(record: AgentChatUsageRecord): Promise<void>;
  /** Omitted = function-calling turns are not resumable server-side. */
  continuations?: ToolContinuationStore;
  /** Wall-clock limit for one chat (AGENT_CHAT_TIMEOUT_MS). */
  deadlineMs: number;
  now?: () => number;
  logger?: {
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
}

// ============================================
// Refusals and failures
// ============================================

export type AgentChatRefusal =
  | { kind: "agent_not_found" }
  /** The request asks for something this caller may not have (400). */
  | { kind: "invalid_request"; code: OpenAiErrorCode; param: string | null; message: string }
  /** Nothing the caller can fix: the platform cannot run this model (501). */
  | {
      kind: "not_configured";
      code: "model_provider_not_configured" | "hosted_model_not_available";
      message: string;
    }
  /**
   * The agent's WheelsAI-hosted model has no deployment that can serve right
   * now: none running, no healthy node, or its GPU time unpaid (503).
   */
  | { kind: "hosted_model_unavailable"; message: string }
  /** The server is restarting; nothing was charged. Retrying will work (503). */
  | { kind: "shutting_down" }
  /** The agent's own model setup is wrong; its owner can fix it (400). */
  | { kind: "model_invalid"; code: "unknown_model" | "agent_model_key_missing"; message: string }
  | { kind: "rate_limited"; limit: RateLimitResult }
  | {
      kind: "licence_revoked";
      listingTitle: string;
      revocation: RevocationReason;
      token?: GateToken;
    }
  | {
      kind: "payment_required";
      listingTitle: string;
      requiredCents: bigint;
      balanceCents: bigint;
    }
  /** The client left before anything was charged. */
  | { kind: "client_gone" };

export type AgentChatFailureCode =
  | "client_gone"
  | "upstream_timeout"
  | "provider_auth_failed"
  | "provider_model_not_found"
  | "provider_rate_limited"
  | "provider_rejected_request"
  | "upstream_error"
  | "empty_answer"
  | "tool_loop_exhausted"
  | "graph_run_failed"
  /** The server began restarting mid-chat; the charge was refunded. */
  | "service_unavailable";

/** A chat that was admitted (and possibly charged) but produced no answer. */
export interface AgentChatFailure {
  code: AgentChatFailureCode;
  /** Safe for a client: never a provider's own words. */
  message: string;
  retryAfterSeconds: number | null;
  /** Machine-readable extras (a failed graph run's executionId, ...). */
  detail?: Record<string, unknown>;
}

export const SHUTTING_DOWN = "the server is restarting; nothing was charged - retry in a moment";

/**
 * Maps whatever the runtime threw to a failure. Duck-typed on `name` and
 * `status` rather than `instanceof`, so this file stays free of the runtime's
 * value imports (and with them the logger and the environment).
 */
export function classifyChatError(err: unknown, clientGone: boolean): AgentChatFailure {
  const error = (typeof err === "object" && err !== null ? err : {}) as {
    name?: string;
    message?: string;
    status?: unknown;
    retryAfterSeconds?: unknown;
  };
  const message = typeof error.message === "string" ? error.message : "the chat failed";
  const fail = (code: AgentChatFailureCode, retryAfterSeconds: number | null = null) => ({
    code,
    message,
    retryAfterSeconds,
  });

  if (clientGone) return { code: "client_gone", message: CLIENT_GONE, retryAfterSeconds: null };
  if (error.name === "ChatDeadlineError") return fail("upstream_timeout");
  if (error.name === "EmptyModelAnswerError") return fail("empty_answer");
  if (error.name === "ToolLoopExhaustedError") return fail("tool_loop_exhausted");
  if (error.name === "ProviderHttpError" && typeof error.status === "number") {
    const { status } = error;
    if (status === 401 || status === 403) return fail("provider_auth_failed");
    if (status === 404) return fail("provider_model_not_found");
    if (status === 408 || status === 504) return fail("upstream_timeout");
    if (status === 429) {
      return fail(
        "provider_rate_limited",
        typeof error.retryAfterSeconds === "number" ? error.retryAfterSeconds : null,
      );
    }
    if (status >= 400 && status < 500) return fail("provider_rejected_request");
    return fail("upstream_error");
  }
  // Anything else is ours (a bug, a transport error). Its text is not shown.
  return { code: "upstream_error", message: "the model call failed", retryAfterSeconds: null };
}

// ============================================
// Session
// ============================================

export interface AgentChatBilling {
  listingTitle: string;
  chargedCents: number;
  creatorCents: number;
}

/**
 * `refusal` is set only for a graph agent: its run takes the marketplace
 * charge itself, so "licence revoked", "cannot pay" and "has no graph" are
 * learned when the run is attempted rather than in prepareAgentChat. Nothing
 * was charged. A route answers it exactly as it answers a prepare refusal.
 */
export type AgentChatNotAnswered =
  | { ok: false; failure: AgentChatFailure; refusal?: undefined }
  | { ok: false; refusal: AgentChatRefusal; failure?: undefined };

export type AgentChatCompletion =
  | { ok: true; result: ChatResult; graph?: AgentGraphRunInfo }
  | AgentChatNotAnswered;

export type AgentChatStreamStart =
  | { ok: true; chat: ChatStream; graph?: AgentGraphRunInfo }
  | AgentChatNotAnswered;

export interface AgentChatSession {
  agent: { id: string; slug: string; name: string; version: string };
  /**
   * What answers: the platform's chat runtime on the agent's prompt, model
   * and tools, or the agent's saved graph.
   */
  runtime: "platform" | "graph";
  /**
   * The resolved model id (e.g. `free/groq/llama-3.3-70b`). For a graph
   * agent, the model its llm nodes default to - a node may name its own -
   * or null when the agent configures none and no free model is available.
   */
  modelId: string | null;
  toolMode: ToolMode;
  /** Set when the model is a free one; drives the rate-limit headers. */
  rateLimit: RateLimitResult | null;
  retrieval: RetrievalResult | null;
  /** What this request cost the buyer, when it is a marketplace install. */
  billing: AgentChatBilling | null;
  /**
   * The charge, if any, behind a first-call-wins guard. Hand it to
   * forwardAndSettle for a stream; `complete()` uses it itself.
   */
  meter: SettleableMeter | null;
  /** Runs the chat and settles or refunds. Never throws. */
  complete(): Promise<AgentChatCompletion>;
  /**
   * Starts a streamed chat. On `ok: false` the charge is already refunded.
   * On `ok: true` the caller MUST forward the stream with forwardAndSettle
   * and `meter`. Never throws.
   */
  stream(): Promise<AgentChatStreamStart>;
}

export type PrepareAgentChatResult =
  | { ok: true; session: AgentChatSession }
  | { ok: false; refusal: AgentChatRefusal };

/**
 * First call wins; every later settle or refund is ignored. The underlying
 * handle is already compare-and-set in the database - this keeps a route
 * from even asking twice.
 */
export function settleOnce(meter: SettleableMeter): SettleableMeter {
  let used = false;
  return {
    settle: async () => {
      if (used) return;
      used = true;
      await meter.settle();
    },
    refund: async (reason: string) => {
      if (used) return;
      used = true;
      await meter.refund(reason);
    },
  };
}

/** `wheelsai/<model id>`; the literal lives here so this file imports no service. */
const HOSTED_MODEL_PREFIX = "wheelsai/";

const TOOL_MODE_BASE: Record<AgentChatSource, ToolMode> = {
  playground: "playground",
  api: "api",
  // Somebody else's visitor is driving the agent: nothing may spend.
  widget: "trial",
};

function publicCallerRefusal(input: AgentChatInput): AgentChatRefusal | null {
  if (input.caller !== "public") return null;
  const refuse = (param: string, message: string): AgentChatRefusal => ({
    kind: "invalid_request",
    code: "unsupported_parameter",
    param,
    message,
  });
  if (input.modelOverride) return refuse("model", "The model of a published agent cannot be changed.");
  if ((input.clientTools ?? []).length > 0) {
    return refuse("tools", "A published agent does not accept caller-defined tools.");
  }
  for (const [index, message] of input.messages.entries()) {
    const steering =
      message.role === "system" ||
      message.role === "tool" ||
      (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0);
    if (steering) {
      return refuse(
        `messages[${index}].role`,
        "A published agent accepts only user and assistant text messages.",
      );
    }
  }
  return null;
}

function modelRefusal(err: unknown): AgentChatRefusal {
  const error = (typeof err === "object" && err !== null ? err : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const message = typeof error.message === "string" ? error.message : "Failed to resolve model";
  if (error.code === "model_provider_not_configured" || error.code === "hosted_model_not_available") {
    return { kind: "not_configured", code: error.code, message };
  }
  if (error.code === "agent_model_key_missing") {
    return { kind: "model_invalid", code: "agent_model_key_missing", message };
  }
  return { kind: "model_invalid", code: "unknown_model", message };
}

/**
 * Puts back the server rounds a function-calling hand-back left out. Each
 * assistant turn the caller replays is looked up by its first call id; a hit
 * replaces that turn with the stored one (which also lists the agent's own
 * calls) followed by their results. A miss leaves the caller's turn as it is.
 */
async function spliceContinuations(
  messages: ChatMessage[],
  scope: { orgId: string; agentId: string },
  store: ToolContinuationStore | undefined,
): Promise<ChatMessage[]> {
  if (!store) return messages;
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const callId = message.role === "assistant" ? message.tool_calls?.[0]?.id : undefined;
    const stored = callId ? await store.load({ ...scope, callId }).catch(() => null) : null;
    if (!stored) {
      out.push(message);
      continue;
    }
    for (const entry of stored) out.push(fromModelMessage(entry));
  }
  return out;
}

function fromModelMessage(message: ModelMessage): ChatMessage {
  if (message.role === "tool") {
    return { role: "tool", content: message.content ?? "", tool_call_id: message.tool_call_id ?? "" };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.tool_calls && message.tool_calls.length > 0 && { tool_calls: message.tool_calls }),
    };
  }
  return { role: message.role, content: message.content ?? "" };
}

/**
 * The one string a graph run takes, from a conversation.
 *
 * A single user message is passed as it is, so `{{input}}` in a node means
 * what its author wrote it to mean. With earlier turns the graph would
 * otherwise answer every message as if it were the first, so they are
 * written out ahead of the current message. null = there is no user message
 * to answer.
 */
export function graphInputFromMessages(messages: ChatMessage[]): string | null {
  const turns = messages.filter(
    (m): m is ChatMessage & { content: string } =>
      m.role !== "tool" && typeof m.content === "string" && m.content.length > 0,
  );
  const lastUser = turns.map((m) => m.role).lastIndexOf("user");
  if (lastUser === -1) return null;
  const current = turns[lastUser]!.content;
  const earlier = turns.slice(0, lastUser);
  if (earlier.length === 0) return current;
  const speaker = { system: "System", user: "User", assistant: "Assistant" } as const;
  return `Conversation so far:\n${earlier
    .map((m) => `${speaker[m.role as keyof typeof speaker]}: ${m.content}`)
    .join("\n")}\n\nCurrent message:\n${current}`;
}

function graphRefusal(outcome: AgentGraphOutcome): AgentChatRefusal | null {
  switch (outcome.kind) {
    case "no_graph":
      return {
        kind: "invalid_request",
        code: "agent_graph_missing",
        param: null,
        message:
          "This agent is set to answer through its graph, and it has no saved graph (or an empty one). Build the graph, or switch the agent's entrypoint back to chat.",
      };
    case "licence_revoked":
      return {
        kind: "licence_revoked",
        listingTitle: outcome.listingTitle,
        revocation: outcome.revocation,
        token: outcome.token,
      };
    case "payment_required":
      return {
        kind: "payment_required",
        listingTitle: outcome.listingTitle,
        requiredCents: outcome.requiredCents,
        balanceCents: outcome.balanceCents,
      };
    case "shutting_down":
      return { kind: "shutting_down" };
    default:
      return null;
  }
}

export async function prepareAgentChat(
  input: AgentChatInput,
  deps: AgentChatDeps,
): Promise<PrepareAgentChatResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const { orgId } = input;
  /** The caller hung up. Distinct from `signal`, which shutdown also fires. */
  const clientSignal = input.signal;
  const refuse = (refusal: AgentChatRefusal): PrepareAgentChatResult => ({ ok: false, refusal });

  // 1. The agent, in the caller's organization or not at all.
  const agent = await deps.loadAgent({ orgId, ...input.agent });
  if (!agent || agent.orgId !== orgId) return refuse({ kind: "agent_not_found" });
  const agentId = agent.id;

  // 2. What this caller may ask for.
  const restricted = publicCallerRefusal(input);
  if (restricted) return refuse(restricted);

  const clientTools = input.clientTools ?? [];
  const conflict = findToolNameConflict(clientTools, deps.skillKeys());
  if (conflict) {
    return refuse({
      kind: "invalid_request",
      code: "tool_name_conflict",
      param: "tools",
      message: `Tool "${conflict}" has the name of a built-in agent tool. Rename it.`,
    });
  }

  // 3. The model. Resolving it touches nothing: no counter, no charge.
  const modelConfig =
    typeof agent.modelConfig === "object" && agent.modelConfig !== null
      ? (agent.modelConfig as Record<string, unknown>)
      : {};
  const graphAgent = agent.entrypoint === "graph";
  const modelId = resolveAgentModelId({
    // A graph's nodes choose their own models; the request does not.
    override: graphAgent ? null : input.modelOverride,
    modelConfig,
    availableFreeModelIds: deps.availableFreeModelIds(),
  });

  const record = (
    streamed: boolean,
    ok: boolean,
    usage: TokenUsage | null,
    toolCallCount: number,
    clientGone = false,
  ): void => {
    void deps
      .recordUsage({
        orgId,
        agentId,
        source: input.source,
        modelId: modelId ?? "graph",
        freeModel: modelId !== null && deps.isFreeModel(modelId),
        streamed,
        ok,
        clientGone,
        usage,
        toolCallCount,
        latencyMs: Math.max(0, now() - startedAt),
      })
      .catch((err) => deps.logger?.error({ err, agentId }, "failed to record agent chat usage"));
  };

  if (graphAgent) {
    return prepareGraphChat({ input, deps, agent, modelId, clientTools, record });
  }

  if (!modelId) {
    return refuse({
      kind: "not_configured",
      code: "model_provider_not_configured",
      message:
        "No model specified and no free models are available. Configure a provider API key on the platform.",
    });
  }
  let resolved: ResolvedModel;
  if (modelId.startsWith(HOSTED_MODEL_PREFIX) && deps.resolveHostedModel) {
    // A model the organization hosts on its own GPU deployment. Its requests
    // are included in the deployment's GPU time, so nothing is charged here.
    const hosted = await deps.resolveHostedModel({ orgId, modelId });
    if (!hosted.ok) return refuse({ kind: "hosted_model_unavailable", message: hosted.message });
    resolved = hosted.resolved;
  } else {
    try {
      resolved = deps.resolveModel(modelId, deps.openAgentEnv(agent.env));
    } catch (err) {
      return refuse(modelRefusal(err));
    }
  }

  // 4. Free models run on the platform's keys, so they are rate limited.
  const freeModel = deps.isFreeModel(modelId);
  let rateLimit: RateLimitResult | null = null;
  if (freeModel) {
    rateLimit = await deps.checkFreeTierLimit(orgId, { failClosed: input.caller === "public" });
    if (!rateLimit.allowed) return refuse({ kind: "rate_limited", limit: rateLimit });
  }

  // 5. Money. Nobody is waiting for this answer any more: stop before
  // charging. From here on nothing refuses - every exit settles or refunds.
  if (clientSignal.aborted) return refuse({ kind: "client_gone" });

  // Registered BEFORE the charge: from here until the charge is settled or
  // refunded, shutdown waits for this chat instead of stranding its money.
  const slot = deps.beginRun ? deps.beginRun() : undefined;
  if (slot === null) return refuse({ kind: "shutting_down" });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slot?.done();
  };
  const signal = slot ? AbortSignal.any([clientSignal, slot.signal]) : clientSignal;
  const shuttingDown = () => slot?.signal.aborted === true && !clientSignal.aborted;

  let metering: BeginMeteringResult;
  try {
    metering = await deps.beginMetering({ agentId, orgId });
  } catch (err) {
    release();
    throw err;
  }
  if (metering && !metering.ok) {
    release();
    if (metering.reason === "licence_revoked") {
      return refuse({
        kind: "licence_revoked",
        listingTitle: metering.listingTitle,
        revocation: metering.revocation,
        token: metering.token,
      });
    }
    return refuse({
      kind: "payment_required",
      listingTitle: metering.listingTitle,
      requiredCents: metering.requiredCents,
      balanceCents: metering.balanceCents,
    });
  }
  const handle = metering?.ok ? metering.handle : null;
  // The chat is over, for shutdown's purposes, once its charge is closed.
  const meter = handle
    ? settleOnce({
        settle: () => handle.settle().finally(release),
        refund: (reason) => handle.refund(reason).finally(release),
      })
    : null;
  const billing: AgentChatBilling | null = handle
    ? {
        listingTitle: handle.charge.install.listingTitle,
        chargedCents: Number(handle.charge.grossCents),
        creatorCents: Number(handle.charge.creatorCents),
      }
    : null;

  let retrieval: RetrievalResult | null = null;
  let toolMode: ToolMode;
  let chatMessages: ChatMessage[];
  try {
    // 6. RAG grounding, only for agents bound to a knowledge base. After the
    // charge: a caller who cannot pay does not get embeddings run for them.
    const lastUserMessage = [...input.messages].reverse().find((m) => m.role === "user");
    if (agent.knowledgeBaseId && lastUserMessage && typeof lastUserMessage.content === "string") {
      try {
        retrieval = await deps.retrieveContext({ agentId, orgId, query: lastUserMessage.content });
      } catch (err) {
        // Retrieval is an enhancement — never fail the chat over it.
        deps.logger?.warn({ err, agentId }, "retrieval failed; answering ungrounded");
      }
    }

    // 7. A marketplace buyer's copy of someone else's agent runs in `trial`
    // mode whatever the entry point: money-moving tools are withheld.
    toolMode = await deps.resolveToolMode({ agentId, orgId, base: TOOL_MODE_BASE[input.source] });

    const spliced = await spliceContinuations(input.messages, { orgId, agentId }, deps.continuations);
    // Grounding rides as its own system turn ahead of the conversation, so
    // the user's own message is never rewritten.
    chatMessages = retrieval
      ? [{ role: "system", content: retrieval.contextBlock }, ...spliced]
      : spliced;
  } catch (err) {
    // Charged and then unable to even start: the money goes back.
    await meter?.refund("the chat could not be started");
    release();
    throw err;
  }

  const agentConfig: AgentPlaygroundConfig = {
    name: agent.name,
    systemPrompt: agent.systemPrompt ?? undefined,
    tools: Array.isArray(agent.tools) ? (agent.tools as AgentPlaygroundConfig["tools"]) : [],
    modelConfig: {
      externalModel: modelId,
      temperature: typeof modelConfig.temperature === "number" ? modelConfig.temperature : 0.7,
      maxTokens: typeof modelConfig.maxTokens === "number" ? modelConfig.maxTokens : 4096,
    },
  };

  const chatOptions: RunChatOptions = {
    agentId,
    orgId,
    mode: toolMode,
    signal,
    requestParams: input.requestParams,
    clientTools,
    toolChoice: input.toolChoice ?? undefined,
    // Always asked of the provider, whatever the caller wants to SEE: usage
    // is recorded for every chat, and a stream reports none unless asked.
    requestUsage: true,
    deadlineMs: deps.deadlineMs,
  };

  /** Keeps the server half of a hand-back for when the caller returns. */
  const keepContinuation = async (
    clientToolCalls: Array<{ id: string }> | undefined,
    transcript: ModelMessage[] | undefined,
  ): Promise<void> => {
    if (!deps.continuations || !clientToolCalls?.length || !transcript?.length) return;
    // With no server tool result there is nothing the caller's own replay
    // lacks.
    if (!transcript.some((m) => m.role === "tool")) return;
    await deps.continuations
      .save({ orgId, agentId }, clientToolCalls.map((c) => c.id), transcript)
      .catch(() => {});
  };

  const fail = async (
    err: unknown,
    streamed: boolean,
  ): Promise<{ ok: false; failure: AgentChatFailure }> => {
    const failure: AgentChatFailure = shuttingDown()
      ? { code: "service_unavailable", message: SHUTTING_DOWN, retryAfterSeconds: 5 }
      : classifyChatError(err, clientSignal.aborted);
    if (failure.code !== "client_gone") {
      deps.logger?.error({ err, agentId, modelId }, streamed ? "Streaming chat error" : "Chat error");
    }
    await meter?.refund(failure.message);
    release();
    record(streamed, false, null, 0, failure.code === "client_gone");
    return { ok: false, failure };
  };

  const session: AgentChatSession = {
    agent: { id: agent.id, slug: agent.slug, name: agent.name, version: agent.version },
    runtime: "platform",
    modelId,
    toolMode,
    rateLimit,
    retrieval,
    billing,
    meter,

    async complete() {
      let result: ChatResult;
      try {
        result = await deps.runChat(resolved, agentConfig, chatMessages, chatOptions);
      } catch (err) {
        return fail(err, false);
      }
      // Generated, but the client hung up while it was: not delivered.
      if (signal.aborted) return fail(null, false);

      await keepContinuation(result.clientToolCalls, result.transcript);
      await meter?.settle();
      release();
      record(false, true, result.reportedUsage, result.toolCalls?.length ?? 0);
      return { ok: true, result };
    },

    async stream() {
      let chat: ChatStream;
      try {
        // Tool rounds (if any) and the provider's acceptance of the request
        // happen BEFORE this resolves, so a failure here is still a plain
        // HTTP error: no header has been flushed.
        chat = await deps.runChatStream(resolved, agentConfig, chatMessages, chatOptions);
      } catch (err) {
        return fail(err, true);
      }
      // The whole answer of a tool-using chat exists by now, and the client
      // may have left while it was produced. Its charge goes back.
      if (signal.aborted) {
        await chat.stream.cancel().catch(() => {});
        return fail(null, true);
      }

      // Settlement belongs to forwardAndSettle (it knows about delivery);
      // usage and the continuation follow the stream's own outcome.
      void chat.outcome.then(async (outcome) => {
        // With a charge, the chat ends when forwardAndSettle closes it.
        if (!meter) release();
        if (outcome.ok) await keepContinuation(outcome.clientToolCalls, outcome.transcript);
        record(
          true,
          outcome.ok,
          outcome.ok ? outcome.usage : null,
          outcome.toolCalls.length,
          !outcome.ok && outcome.code === "client_gone",
        );
      });
      return { ok: true, chat };
    },
  };

  return { ok: true, session };
}

/**
 * The chat of an agent whose entrypoint is its graph.
 *
 * What differs from a chat on the agent's prompt:
 *   - the caller's functions cannot be offered: a graph has no turn in which
 *     to hand a call back and resume
 *   - money is the run's own. `runGraph` charges a marketplace buyer before
 *     the run, settles on delivered output and refunds a failed run, exactly
 *     once (services/runAgentGraph.ts) - so there is no meter here, and the
 *     licence and payment refusals surface from `complete()` / `stream()`
 *   - grounding and tools are the graph's memory and tool nodes
 *   - no provider reports usage for a whole run, so usage is unknown (null),
 *     never zero
 *   - a streamed answer is produced whole and then sent, like a tool-using
 *     chat's
 */
async function prepareGraphChat(args: {
  input: AgentChatInput;
  deps: AgentChatDeps;
  agent: AgentChatAgent;
  modelId: string | null;
  clientTools: ClientToolSpec[];
  record: (streamed: boolean, ok: boolean, usage: TokenUsage | null, toolCallCount: number, clientGone?: boolean) => void;
}): Promise<PrepareAgentChatResult> {
  const { input, deps, agent, modelId, clientTools, record } = args;
  const { orgId, signal } = input;
  const agentId = agent.id;
  const refuse = (refusal: AgentChatRefusal): PrepareAgentChatResult => ({ ok: false, refusal });

  if (clientTools.length > 0) {
    return refuse({
      kind: "invalid_request",
      code: "unsupported_parameter",
      param: "tools",
      message:
        "This agent answers through its graph, which cannot hand function calls back to the caller. Remove tools, or call an agent whose entrypoint is chat.",
    });
  }
  const graphInput = graphInputFromMessages(input.messages);
  if (graphInput === null) {
    return refuse({
      kind: "invalid_request",
      code: "validation_failed",
      param: "messages",
      message: "messages: a graph agent needs a user message to answer.",
    });
  }
  const { runGraph, answerStream } = deps;
  if (!runGraph || !answerStream) {
    return refuse({
      kind: "not_configured",
      code: "model_provider_not_configured",
      message: "This server cannot run agent graphs.",
    });
  }

  // An llm node that names no model falls back to the agent's, and failing
  // that to the first free model - so a run with no model of its own, or a
  // free one, spends the platform's keys and is rate limited like a chat.
  let rateLimit: RateLimitResult | null = null;
  if (modelId === null || deps.isFreeModel(modelId)) {
    rateLimit = await deps.checkFreeTierLimit(orgId, { failClosed: input.caller === "public" });
    if (!rateLimit.allowed) return refuse({ kind: "rate_limited", limit: rateLimit });
  }
  if (signal.aborted) return refuse({ kind: "client_gone" });

  type Ran =
    | { ok: true; result: ChatResult; graph: AgentGraphRunInfo }
    | AgentChatNotAnswered;

  const run = async (streamed: boolean): Promise<Ran> => {
    let outcome: AgentGraphOutcome;
    try {
      outcome = await runGraph({ agentId, orgId, input: graphInput, signal });
    } catch (err) {
      // runGraph reports refusals and failed runs as outcomes; a throw is a
      // fault of ours, and the run's own accounting has already closed.
      deps.logger?.error({ err, agentId }, "Graph chat error");
      record(streamed, false, null, 0, signal.aborted);
      return { ok: false, failure: classifyChatError(err, signal.aborted) };
    }

    const refusal = graphRefusal(outcome);
    if (refusal) return { ok: false, refusal };

    if (outcome.kind === "failed") {
      record(streamed, false, null, 0, signal.aborted);
      if (signal.aborted) {
        return { ok: false, failure: { code: "client_gone", message: CLIENT_GONE, retryAfterSeconds: null } };
      }
      return {
        ok: false,
        failure: {
          code: "graph_run_failed",
          // The node's own error can quote what it was given; the run is
          // stored, and its author reads the detail in the builder.
          message: outcome.failedStep
            ? `The agent's graph failed at "${outcome.failedStep}" and produced no answer. Nothing was charged for the run.`
            : "The agent's graph failed and produced no answer. Nothing was charged for the run.",
          retryAfterSeconds: null,
          detail: { executionId: outcome.run.executionId, failedStep: outcome.failedStep },
        },
      };
    }
    if (outcome.kind !== "completed") {
      // Unreachable: graphRefusal answered every other kind.
      return { ok: false, failure: classifyChatError(null, false) };
    }

    record(streamed, true, null, 0);
    return {
      ok: true,
      graph: outcome.run,
      result: {
        content: outcome.output ?? "",
        usage: { inputTokens: 0, outputTokens: 0 },
        reportedUsage: null,
        finishReason: "stop",
        toolCalls: [],
        clientToolCalls: [],
        transcript: [],
      },
    };
  };

  const session: AgentChatSession = {
    agent: { id: agent.id, slug: agent.slug, name: agent.name, version: agent.version },
    runtime: "graph",
    modelId,
    toolMode: "graph",
    rateLimit,
    retrieval: null,
    // Known only to the run; a buyer's charge shows on their statement.
    billing: null,
    meter: null,

    complete: () => run(false),

    async stream() {
      const ran = await run(true);
      if (!ran.ok) return ran;
      return {
        ok: true,
        graph: ran.graph,
        chat: {
          stream: answerStream(ran.result, modelId ?? "graph"),
          outcome: Promise.resolve({
            ok: true as const,
            usage: null,
            toolCalls: [],
            finishReason: "stop",
          }),
        },
      };
    },
  };
  return { ok: true, session };
}
