/**
 * One chat with a model deployment of the caller's own organization, for
 * callers that are not an HTTP request: a workflow's `model` step.
 *
 * A deployment is admitted and billed by one set of rules whichever way it is
 * reached. The /v1 route (routes/inference.ts) and this service share them
 * piece by piece - the admission checks, the hold's price, the node call, the
 * usage row - so a workflow can never be a cheaper way to do the same work:
 *
 *   GPU-billed    a deployment with a real Nosana id is paid for per
 *                 GPU-second by the billing worker, so the request is included
 *                 in that time and nothing is charged here. It is served only
 *                 while that billing is actually collecting (gpuBillingBlock).
 *   per request   any other deployment: the worst-case cost is held BEFORE the
 *                 node is called (a conditional debit), then settled to the
 *                 node's own token count, or released in full when no answer
 *                 was produced. Exactly one of the two happens, once.
 *
 * What a caller with no HTTP request cannot do is pay by x402: there is no
 * payment header to verify. Where the server requires x402 for per-request
 * deployments, this refuses by name instead of serving unpaid.
 *
 * The node is run by a third party: its URL passes the allowlist, a redirect
 * is refused, and the caller's abort signal stops the call.
 *
 * Pure core: every effect is a dependency (services/buildDeploymentChatDeps.ts
 * binds the real ones). The helpers at the top are the ones the route uses too.
 */

import { PRICING_TIERS, calculateTokenCost } from "@wheelsai/shared";

import type { GpuBillingBlock, NodeInfo } from "./hostedModel.js";
import {
  DEFAULT_COMPLETION_TOKENS,
  MAX_COMPLETION_TOKENS,
  PROMPT_ESTIMATE_MARGIN,
  type HoldResult,
  type SettleResult,
} from "./inferenceCreditHold.js";
import {
  buildLatencySample,
  classifyUpstreamOutcome,
  providerForDeployment,
  type LatencyOutcome,
  type RecordLatency,
} from "./latencySamples.js";
import type { Deadline } from "./mastra-runtime.js";
import { openAiError, type NormalizedMessage, type OpenAiErrorResponse } from "./openaiCompat.js";

// ============================================
// Shared with routes/inference.ts
// ============================================

export interface NodeUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export type PricingTier = keyof typeof PRICING_TIERS;

/** Below this an organization is not admitted to per-request inference. */
export const MIN_INFERENCE_BALANCE_CENTS = 10n;

const NODE_ERROR_MESSAGE_CHARS = 500;

/**
 * The human-readable part of an inference server's error body: vLLM answers
 * `{ object: "error", message }`, OpenAI-style servers `{ error: { message } }`
 * and Ollama `{ error: "…" }`. Bounded, and null when there is none.
 */
export function nodeErrorMessage(body: string): string | null {
  let text: unknown = null;
  try {
    const json = JSON.parse(body) as Record<string, unknown> | null;
    if (json && typeof json === "object") {
      const error = json.error;
      text =
        typeof json.message === "string"
          ? json.message
          : typeof error === "string"
            ? error
            : typeof (error as { message?: unknown } | null)?.message === "string"
              ? (error as { message: string }).message
              : typeof json.detail === "string"
                ? json.detail
                : null;
    }
  } catch {
    // Not JSON (a proxy's HTML page): nothing worth relaying.
  }
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > NODE_ERROR_MESSAGE_CHARS
    ? `${trimmed.slice(0, NODE_ERROR_MESSAGE_CHARS)}…`
    : trimmed;
}

/**
 * What the caller is told when the inference node answered with an error
 * status. The status is passed through, in OpenAI's error shape, so a client
 * can tell its own mistake (a 400 for a `tools` request the model server
 * cannot parse) from an outage (a 5xx it may retry).
 *
 * Three statuses are NOT passed through, because of what an OpenAI SDK does
 * with them on this API: 401 and 403 would read as "your WheelsAI key is
 * wrong", and 404 as "no such deployment", when the deployment was found and
 * the key accepted - the node refusing us is a fault on our side of the
 * proxy, so those answer 502.
 *
 * A 4xx carries the model server's own message: it describes the caller's
 * request to the caller's own deployment. A 5xx does not.
 */
export function nodeStatusError(
  status: number,
  nodeMessage: string | null,
  retryAfterSeconds: number | null,
): OpenAiErrorResponse {
  if (status === 401 || status === 403) {
    return openAiError("provider_auth_failed", {
      message: `The inference node refused the request (status ${status}).`,
    });
  }
  if (status === 404) {
    return openAiError("provider_model_not_found", {
      message: "The inference node does not serve this deployment's model.",
    });
  }
  if (status === 408 || status === 504) {
    return { ...openAiError("upstream_timeout", { message: "The inference node timed out." }), status };
  }
  if (status === 429) {
    return openAiError("provider_rate_limited", {
      message: "The inference node is at capacity. Retry shortly.",
      ...(retryAfterSeconds !== null && { retryAfterSeconds }),
    });
  }
  if (status >= 400 && status < 500) {
    return {
      ...openAiError("provider_rejected_request", {
        message: nodeMessage
          ? `The model server rejected the request: ${nodeMessage}`
          : `The model server rejected the request (status ${status}).`,
      }),
      status,
    };
  }
  const passed = status >= 500 && status <= 599 ? status : 502;
  return {
    ...openAiError(passed === 503 ? "service_unavailable" : "upstream_error", {
      message: `The inference node answered ${status}.`,
    }),
    status: passed,
  };
}

export function retryAfterOf(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export interface NodeDeadline extends Deadline {
  signal: AbortSignal;
  /** Restarts the clock: called for every chunk a stream delivers. */
  touch(): void;
}

/**
 * INFERENCE_TIMEOUT_MS as a limit on SILENCE, kept alive until the body has
 * been read. It used to be cleared when the response headers arrived, which
 * left the body read with no limit at all; as a wall-clock limit it would cut
 * every long streamed answer. So: the node has this long to answer, and a
 * stream has this long between chunks. The client going away aborts too.
 */
export function startNodeDeadline(idleMs: number, client: AbortSignal): NodeDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("inference node timed out")), idleMs);
  };
  arm();
  return {
    signal: AbortSignal.any([client, controller.signal]),
    expired: () => controller.signal.aborted,
    touch: arm,
    clear: () => clearTimeout(timer),
  };
}

export function estimatePromptTokens(messages: NormalizedMessage[]): number {
  let charCount = 0;
  for (const message of messages) {
    charCount += message.content?.length ?? 0;
    if (message.role === "assistant") {
      // Replayed tool calls are prompt too.
      for (const call of message.tool_calls ?? []) {
        charCount += call.function.name.length + call.function.arguments.length;
      }
    }
  }
  return Math.max(1, Math.ceil(charCount / 4));
}

/** Characters of generated text and tool-call arguments in a completion. */
export function completionChars(choices: unknown[]): number {
  let chars = 0;
  for (const choice of choices) {
    const message = (choice as { message?: { content?: unknown; tool_calls?: unknown } } | null)?.message;
    if (typeof message?.content === "string") chars += message.content.length;
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls as Array<{ function?: { arguments?: unknown } }>) {
        if (typeof call?.function?.arguments === "string") chars += call.function.arguments.length;
      }
    }
  }
  return chars;
}

/** The worst case a per-request call can cost: what is held before the node runs. */
export function inferenceHoldCents(
  messages: NormalizedMessage[],
  maxTokens: number,
  pricingTier: PricingTier,
): bigint {
  return BigInt(
    calculateTokenCost(
      Math.ceil(estimatePromptTokens(messages) * PROMPT_ESTIMATE_MARGIN),
      maxTokens,
      pricingTier,
    ),
  );
}

/**
 * The node's own token count from a completion body, or null when it sent
 * none. Never zero-filled: a missing count is priced on an estimate, not on
 * nothing.
 */
export function reportedNodeUsage(body: { usage?: unknown }): NodeUsage | null {
  const usage = body.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined;
  return typeof usage?.prompt_tokens === "number"
    ? {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      }
    : null;
}

/**
 * What a per-request call is priced on: the node's count, or - when it sent
 * none - an estimate of what was generated (the hold already bounds it)
 * rather than zero, which would make the request free.
 */
export function pricedUsage(
  reported: NodeUsage | null,
  messages: NormalizedMessage[],
  generatedChars: number,
): NodeUsage {
  return (
    reported ?? {
      prompt_tokens: estimatePromptTokens(messages),
      completion_tokens: Math.ceil(generatedChars / 4),
    }
  );
}

// ============================================
// The service
// ============================================

export interface DeploymentChatRequest {
  /** The organization the deployment must belong to. */
  orgId: string;
  deploymentId: string;
  /**
   * The model the caller expects the deployment to serve, by any of its names
   * (catalog id, Hugging Face id, the name the engine answers to, or the
   * deployment's slug). null = whatever the deployment serves.
   */
  modelId?: string | null;
  messages: NormalizedMessage[];
  /** The completion cap the node is given (DEFAULT_COMPLETION_TOKENS). */
  maxTokens?: number;
  temperature?: number;
  /** Aborting stops the node call; a per-request hold is released. */
  signal?: AbortSignal;
}

export interface DeploymentChatResult {
  content: string;
  /** The node's own count; null when it reported none. */
  usage: { inputTokens: number; outputTokens: number } | null;
  finishReason: string | null;
  billing:
    | { mode: "gpu_included"; chargedCents: 0 }
    | { mode: "credits"; chargedCents: number };
  /** The ledger reference of a per-request hold and its settlement. */
  requestId: string;
}

export type DeploymentChatErrorCode =
  | "invalid_request"
  | "deployment_not_running"
  | "model_mismatch"
  | "gpu_billing_unavailable"
  | "insufficient_credits"
  | "x402_required"
  | "no_healthy_node"
  | "node_unreachable"
  | "node_timeout"
  | "node_error"
  | "invalid_answer"
  | "empty_answer";

/** Why a deployment chat produced no answer. The message is safe to store. */
export class DeploymentChatError extends Error {
  constructor(
    readonly code: DeploymentChatErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DeploymentChatError";
  }
}

/** The deployment columns a chat reads. `nodes` are the healthy ones. */
export interface DeploymentForChat {
  id: string;
  name: string;
  slug: string;
  /** The catalog model id. */
  modelId: string;
  engine: string | null;
  gpuTier: string;
  replicas: number | null;
  billedThroughAt: Date | null;
  nosanaJobIds: readonly string[] | null;
  nodes: NodeInfo[];
  model: { hfId: string; pricingTier: string };
  /** Set when the deployment serves a fine-tuned adapter. */
  fineTunedModel?: { slug: string } | null;
}

export interface DeploymentChatDeps {
  /** MUST scope by orgId and return running deployments only. */
  findRunningDeployment(args: { orgId: string; deploymentId: string }): Promise<DeploymentForChat | null>;
  /** Billed per GPU-second by the billing worker (services/nosanaIds.ts). */
  isGpuBilled(deployment: DeploymentForChat): boolean;
  /** Why a GPU-billed deployment may not serve now (services/hostedModel.ts). */
  gpuBillingBlock(deployment: DeploymentForChat, orgId: string): Promise<GpuBillingBlock | null>;
  /** This server takes per-request payment by x402 only. */
  x402Required(): boolean;
  balanceCents(orgId: string): Promise<bigint | null>;
  /** Conditional debit + ledger row, in one transaction. */
  hold(args: { orgId: string; holdCents: bigint; requestId: string; description: string }): Promise<HoldResult>;
  settle(args: {
    orgId: string;
    heldCents: bigint;
    actualCents: bigint;
    requestId: string;
    description: string;
  }): Promise<SettleResult>;
  release(args: { orgId: string; heldCents: bigint; requestId: string; reason: string }): Promise<void>;
  selectNode(nodes: NodeInfo[]): NodeInfo | null;
  /**
   * The name the engine answers to (services/nosana.ts): the adapter's when
   * `fineTunedSlug` is given, the base model's otherwise.
   */
  servedModelName(engine: string | null, hfId: string, fineTunedSlug?: string | null): string;
  /**
   * POSTs the completion to the node. MUST refuse a node URL off the
   * allowlist and MUST NOT follow a redirect; throws for both.
   */
  callNode(nodeUrl: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  markNodeUnhealthy(nodeId: string): Promise<void>;
  /** The deployment's hourly usage rollup. Best effort. */
  recordUsage(args: {
    orgId: string;
    deploymentId: string;
    usage: NodeUsage | null;
    latencyMs: number;
    costCents: number;
    gpuTier: string;
    failed: boolean;
  }): Promise<void>;
  /**
   * One latency sample per call that reached a node (services/
   * latencySamples.ts). Synchronous; MUST NOT throw or wait on a write.
   */
  recordLatency: RecordLatency;
  /** INFERENCE_TIMEOUT_MS: how long the node may stay silent. */
  idleTimeoutMs: number;
  newRequestId(): string;
  now?: () => number;
  logger?: {
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

function servesModel(
  deployment: DeploymentForChat,
  servedName: string,
  expected: string,
): boolean {
  return [deployment.modelId, deployment.model.hfId, servedName, deployment.slug].includes(expected);
}

export async function runDeploymentChat(
  request: DeploymentChatRequest,
  deps: DeploymentChatDeps,
): Promise<DeploymentChatResult> {
  const now = deps.now ?? Date.now;
  // The caller's wait starts here, admission and the hold included.
  const receivedAt = now();
  const { orgId, messages } = request;
  const signal = request.signal ?? new AbortController().signal;

  // Every request carries an explicit completion cap, forwarded to the node,
  // so the hold prices the same bounded work the node is asked for.
  const maxTokens = request.maxTokens ?? DEFAULT_COMPLETION_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_COMPLETION_TOKENS) {
    throw new DeploymentChatError(
      "invalid_request",
      `a model deployment generates between 1 and ${MAX_COMPLETION_TOKENS} tokens per request (asked for ${maxTokens})`,
    );
  }

  // 1. The deployment, running, in the caller's organization or not at all.
  const deployment = await deps.findRunningDeployment({ orgId, deploymentId: request.deploymentId });
  if (!deployment) {
    throw new DeploymentChatError(
      "deployment_not_running",
      `model deployment ${request.deploymentId} does not exist in this organization or is not running`,
    );
  }
  const servedName = deps.servedModelName(
    deployment.engine,
    deployment.model.hfId,
    deployment.fineTunedModel?.slug,
  );
  const expected = request.modelId?.trim();
  if (expected && !servesModel(deployment, servedName, expected)) {
    throw new DeploymentChatError(
      "model_mismatch",
      `the step names the model "${expected}", but the deployment "${deployment.name}" serves "${deployment.modelId}" (${deployment.model.hfId}); clear the model id or pick the deployment that serves it`,
    );
  }

  // 2. Billing mode, by the rule /v1 uses.
  const gpuBilled = deps.isGpuBilled(deployment);
  if (gpuBilled) {
    // "Included in the GPU bill" is only true while the GPU is being billed.
    const blocked = await deps.gpuBillingBlock(deployment, orgId);
    if (blocked) {
      throw new DeploymentChatError(
        blocked.code === "insufficient_credits" ? "insufficient_credits" : "gpu_billing_unavailable",
        blocked.message,
        blocked.extra,
      );
    }
  } else {
    if (deps.x402Required()) {
      throw new DeploymentChatError(
        "x402_required",
        `the deployment "${deployment.name}" is paid only from a Solana wallet, request by request; a workflow step has no payment to attach, so it cannot call it`,
      );
    }
    const balance = await deps.balanceCents(orgId);
    if (balance === null || balance < MIN_INFERENCE_BALANCE_CENTS) {
      throw new DeploymentChatError(
        "insufficient_credits",
        "Insufficient credits. Please add more credits to continue.",
      );
    }
  }

  // Nobody is waiting for this answer any more: stop before holding anything.
  if (signal.aborted) throw abortError(signal);

  const requestId = deps.newRequestId();
  const pricingTier = deployment.model.pricingTier as PricingTier;
  const holdDescription = `Inference: ${deployment.name}`;
  let heldCents = 0n;
  if (!gpuBilled) {
    // Credits mode: hold the worst-case cost BEFORE any GPU work.
    const held = await deps.hold({
      orgId,
      holdCents: inferenceHoldCents(messages, maxTokens, pricingTier),
      requestId,
      description: holdDescription,
    });
    if (!held.ok) {
      throw new DeploymentChatError(
        "insufficient_credits",
        "Insufficient credits for this request. Please add more credits to continue.",
        { requiredCents: Number(held.requiredCents) },
      );
    }
    heldCents = held.heldCents;
  }

  // Exactly one of `abandon` and `charge` runs for a request that got this
  // far, and only its first call does anything: the hold is released or
  // settled once, never both and never twice.
  const startTime = now();
  let closed = false;
  const recordUsage = (usage: NodeUsage | null, costCents: number, failed: boolean) => {
    void deps
      .recordUsage({
        orgId,
        deploymentId: deployment.id,
        usage,
        latencyMs: Math.max(0, now() - startTime),
        costCents,
        gpuTier: deployment.gpuTier,
        failed,
      })
      .catch((err) => deps.logger?.error({ err }, "Failed to record usage"));
  };

  // One sample per call that got as far as a node, however it ended. After
  // the money: timing is never a reason to delay a settle or a release.
  let nodeCalled = false;
  let sampled = false;
  const sample = (outcome: LatencyOutcome, extra: { statusCode?: number; outputTokens?: number } = {}) => {
    if (sampled) return;
    sampled = true;
    try {
      const at = now();
      deps.recordLatency(
        buildLatencySample(
          {
            orgId,
            surface: "deployment_step",
            deploymentId: deployment.id,
            model: deployment.model.hfId,
            provider: providerForDeployment(deployment),
            streamed: false,
            outcome,
            totalMs: at - receivedAt,
            upstreamMs: at - startTime,
            ...extra,
          },
          new Date(at),
        ),
      );
    } catch (err) {
      deps.logger?.warn({ err }, "Failed to record a latency sample");
    }
  };

  /** Nothing was produced: the hold goes back. */
  const abandon = async (reason: string, options: { countError?: boolean } = {}) => {
    if (closed) return;
    closed = true;
    if (heldCents > 0n) {
      await deps
        .release({ orgId, heldCents, requestId, reason })
        .catch((err) => deps.logger?.error({ err, orgId, heldCents }, "Failed to release inference hold"));
    }
    if (options.countError) recordUsage(null, 0, true);
  };

  /** An answer was produced; returns what the organization was charged. */
  const charge = async (reported: NodeUsage | null, generatedChars: number): Promise<number> => {
    if (closed) return 0;
    closed = true;
    // Zero for a GPU-billed deployment: the GPU seconds are billed by the
    // worker, not per token.
    let costCents = 0;
    let chargedCents = 0;
    if (!gpuBilled) {
      const priced = pricedUsage(reported, messages, generatedChars);
      costCents = calculateTokenCost(priced.prompt_tokens, priced.completion_tokens, pricingTier);
      if (!reported) {
        deps.logger?.warn(
          { orgId, requestId, deploymentId: deployment.id },
          "Inference node reported no usage; charged on an estimate of the generated text",
        );
      }
      const settled = await deps.settle({
        orgId,
        heldCents,
        actualCents: BigInt(costCents),
        requestId,
        description: holdDescription,
      });
      chargedCents = Number(settled.chargedCents);
      if (settled.shortfallCents > 0n) {
        deps.logger?.warn(
          { orgId, requestId, shortfallCents: Number(settled.shortfallCents) },
          "Inference usage exceeded the hold and the balance; charged the hold only",
        );
      }
    }
    // Only REPORTED tokens are added to the usage rollup; an estimate is a
    // billing basis, not a measurement.
    recordUsage(reported, costCents, false);
    return chargedCents;
  };

  try {
    // 3. A healthy node.
    const node = deps.selectNode(deployment.nodes);
    if (!node) {
      await abandon("No healthy nodes available for this deployment");
      throw new DeploymentChatError(
        "no_healthy_node",
        `the deployment "${deployment.name}" has no healthy node right now; retry shortly`,
      );
    }

    // 4. The call. The engine only answers to the name it was started with.
    const nodeBody: Record<string, unknown> = {
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      max_tokens: maxTokens,
      model: servedName,
      messages,
      stream: false,
    };

    const deadline = startNodeDeadline(deps.idleTimeoutMs, signal);
    let responseBody: { choices?: unknown; usage?: unknown };
    try {
      let response: Response;
      try {
        nodeCalled = true;
        response = await deps.callNode(node.nodeUrl, nodeBody, deadline.signal);
      } catch (error) {
        if (signal.aborted) {
          await abandon("the run was cancelled");
          sample("cancelled");
          throw abortError(signal);
        }
        deps.logger?.error({ error, nodeUrl: node.nodeUrl }, "Node request failed");
        // Best effort: a failure here must not skip the release of the hold.
        await deps
          .markNodeUnhealthy(node.id)
          .catch((err) => deps.logger?.error({ err, nodeId: node.id }, "Failed to mark node unhealthy"));
        const timedOut = deadline.expired();
        await abandon(timedOut ? "inference node timed out" : "inference node unreachable", {
          countError: true,
        });
        sample(classifyUpstreamOutcome({ timedOut }));
        throw timedOut
          ? new DeploymentChatError("node_timeout", "The inference node did not answer in time.")
          : new DeploymentChatError("node_unreachable", "Failed to reach inference node");
      }

      // The node answered, but not with a completion. Nothing is charged for
      // it, and the node is NOT marked unhealthy: it is up and answering.
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        deps.logger?.error(
          { nodeUrl: node.nodeUrl, status: response.status, body: text.slice(0, 2_000) },
          "Node returned non-OK for a deployment chat",
        );
        await abandon(`Inference node responded ${response.status}`, { countError: true });
        sample("error", { statusCode: response.status });
        const error = nodeStatusError(response.status, nodeErrorMessage(text), retryAfterOf(response));
        throw new DeploymentChatError("node_error", error.body.error.message, {
          status: response.status,
        });
      }

      try {
        responseBody = (await response.json()) as typeof responseBody;
      } catch (error) {
        if (signal.aborted) {
          await abandon("the run was cancelled");
          sample("cancelled");
          throw abortError(signal);
        }
        deps.logger?.error({ error, nodeUrl: node.nodeUrl }, "Node answered 200 with a body that is not JSON");
        await abandon("inference node answered with an unreadable body", { countError: true });
        sample(classifyUpstreamOutcome({ timedOut: deadline.expired(), httpOk: true, hasAnswer: false }), {
          statusCode: response.status,
        });
        throw deadline.expired()
          ? new DeploymentChatError("node_timeout", "The inference node did not finish answering in time.")
          : new DeploymentChatError(
              "invalid_answer",
              "The inference node answered with a body that is not a completion.",
            );
      }
    } finally {
      deadline.clear();
    }

    if (typeof responseBody !== "object" || responseBody === null || !Array.isArray(responseBody.choices)) {
      deps.logger?.error({ nodeUrl: node.nodeUrl }, "Node answered 200 without choices");
      await abandon("inference node answered without a completion", { countError: true });
      sample("error", { statusCode: 200 });
      throw new DeploymentChatError(
        "invalid_answer",
        "The inference node answered with a body that is not a completion.",
      );
    }

    // 5. The node did the work: it is billed as /v1 bills it, whatever the
    // text turns out to be.
    const reported = reportedNodeUsage(responseBody);
    const chargedCents = await charge(reported, completionChars(responseBody.choices));
    // A completion, as /v1 counts it - even one whose text turns out empty.
    sample("ok", { statusCode: 200, ...(reported && { outputTokens: reported.completion_tokens }) });

    const choice = responseBody.choices[0] as
      | { message?: { content?: unknown }; finish_reason?: unknown }
      | undefined;
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    if (content.trim() === "") {
      throw new DeploymentChatError(
        "empty_answer",
        `the deployment "${deployment.name}" answered with no text${
          finishReason ? ` (finish reason: ${finishReason})` : ""
        }; the tokens it generated were billed as usual`,
      );
    }

    return {
      content,
      usage: reported
        ? { inputTokens: reported.prompt_tokens, outputTokens: reported.completion_tokens }
        : null,
      finishReason,
      billing: gpuBilled
        ? { mode: "gpu_included", chargedCents: 0 }
        : { mode: "credits", chargedCents },
      requestId,
    };
  } catch (err) {
    // A fault nobody mapped above: the hold must still go back. A no-op when
    // the request was already settled or released.
    await abandon("deployment chat failed");
    // A no-op when the call's ending was already sampled above.
    if (nodeCalled) sample("error");
    throw err;
  }
}
