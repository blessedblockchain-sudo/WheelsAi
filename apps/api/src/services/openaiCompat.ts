/**
 * The OpenAI chat-completions wire format, as a pure module.
 *
 * Everything /v1 says to an OpenAI client is built here, so "drop-in" is one
 * set of functions with one set of tests rather than a shape re-derived in
 * each route:
 *
 *   - the request: what is accepted, what is refused by name (an ignored
 *     `n: 3` or `logprobs` would be a silently wrong answer), and the
 *     normalised form the chat runtime consumes
 *   - the provider parameter allowlist: the only request keys that may ever
 *     be forwarded to a model provider
 *   - responses: chat.completion, chat.completion.chunk, SSE framing
 *   - errors: `{ error: { message, type, param, code } }` with the status,
 *     `x-should-retry` and `retry-after` an OpenAI SDK acts on
 *   - the stream adapter that turns a provider's (or the runtime's) SSE into
 *     a stream that is safe to hand to an OpenAI SDK
 *
 * No I/O and no environment: nothing here knows about Fastify, Prisma or a
 * provider.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { sanitizeMessage } from "../lib/sanitizeErrorPayload.js";
import type { PaidUseErrorCode } from "./paidUse.js";

// ============================================
// Messages and tools
// ============================================

export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A conversation turn in the form the chat runtime sends to a provider. */
export type NormalizedMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

/** A function the CALLER executes (OpenAI "function calling"). */
export interface ClientToolSpec {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface WireUsage {
  inputTokens: number;
  outputTokens: number;
}

// ============================================
// Provider parameter allowlist
// ============================================

/**
 * The only caller-supplied keys that may reach a model provider. Anything
 * else in a request body (vendor extensions, `model`, `messages`, `stream`,
 * `tools`) is set by the runtime itself or not sent at all.
 */
export const PROVIDER_PARAM_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "stop",
  "seed",
  "response_format",
  "presence_penalty",
  "frequency_penalty",
  "user",
  "parallel_tool_calls",
] as const;

export type ProviderParamKey = (typeof PROVIDER_PARAM_KEYS)[number];

export interface ProviderRequestParams {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  seed?: number;
  response_format?: Record<string, unknown>;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  parallel_tool_calls?: boolean;
}

const PROVIDER_PARAM_SET: ReadonlySet<string> = new Set(PROVIDER_PARAM_KEYS);

/** Keeps the allowlisted keys that are actually set; drops everything else. */
export function pickProviderParams(input: Record<string, unknown> | undefined): ProviderRequestParams {
  const out: Record<string, unknown> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!PROVIDER_PARAM_SET.has(key)) continue;
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out as ProviderRequestParams;
}

// ============================================
// Errors
// ============================================

export type OpenAiErrorCode =
  | "validation_failed"
  | "unsupported_parameter"
  | "unsupported_content"
  | "messages_too_large"
  | "tool_name_conflict"
  | "unknown_tool_choice"
  | "unknown_model"
  | "agent_model_key_missing"
  | "provider_rejected_request"
  | "invalid_api_key"
  | "agent_graph_missing"
  | "marketplace_payment_required"
  | "insufficient_credits"
  | "x402_payment_required"
  | "payment_already_used"
  | "licence_revoked"
  | "use_not_started"
  | "not_a_member"
  | "pricing_changed"
  | "own_agent"
  | "not_for_sale"
  | "answer_withheld"
  | "api_key_use_price_cap_exceeded"
  | "api_key_daily_cap_exceeded"
  | "api_key_spend_caps_missing"
  | "insufficient_scope"
  | "agent_not_found"
  | "model_not_found"
  | "not_found"
  | "request_too_large"
  | "unsupported_media_type"
  | "rate_limit_exceeded"
  | "plan_limit_reached"
  | "plan_used_up"
  | "provider_rate_limited"
  | "client_closed_request"
  | "internal_error"
  | "model_provider_not_configured"
  | "hosted_model_not_available"
  | "hosted_model_not_running"
  | "workflow_not_found"
  | "workflow_disabled"
  | "workflow_run_limit"
  | "workflow_cancelled"
  | "workflow_runner_disabled"
  | "workflow_failed"
  | "workflow_timeout"
  | "graph_run_failed"
  | "upstream_error"
  | "provider_auth_failed"
  | "provider_model_not_found"
  | "empty_answer"
  | "tool_loop_exhausted"
  | "service_unavailable"
  | "upstream_timeout";

interface ErrorRule {
  status: number;
  type: string;
  /**
   * false = repeating the identical request cannot succeed, so the SDK is
   * told not to (each automatic retry is another metered call and, for a
   * marketplace agent, another charge). Unset leaves the SDK's own policy.
   */
  retry?: false;
  message: string;
}

const invalid = (status: number, message: string, retry?: false): ErrorRule => ({
  status,
  type: "invalid_request_error",
  message,
  ...(retry === false && { retry }),
});
const server = (status: number, message: string, retry?: false): ErrorRule => ({
  status,
  type: "server_error",
  message,
  ...(retry === false && { retry }),
});

const ERROR_RULES: Record<OpenAiErrorCode, ErrorRule> = {
  validation_failed: invalid(400, "The request body is not valid."),
  unsupported_parameter: invalid(400, "A parameter in the request is not supported."),
  unsupported_content: invalid(400, "Only text content is supported."),
  messages_too_large: invalid(400, "The conversation is too large."),
  tool_name_conflict: invalid(400, "A tool name conflicts with one of the agent's own tools."),
  unknown_tool_choice: invalid(400, "tool_choice names a function that is not in tools."),
  unknown_model: invalid(400, "The model is not one this platform can call."),
  agent_model_key_missing: invalid(400, "The agent's model needs an API key that is not set."),
  provider_rejected_request: invalid(400, "The model provider rejected the request."),
  // The agent answers through its graph, and the graph is gone or empty.
  // Its owner fixes it in the builder; repeating the call cannot.
  agent_graph_missing: invalid(400, "This agent answers through its graph, and it has none.", false),
  invalid_api_key: invalid(401, "Missing or invalid API key."),
  marketplace_payment_required: {
    status: 402,
    type: "payment_required",
    retry: false,
    message: "This agent is billed per request and the credit balance is too low.",
  },
  insufficient_credits: {
    status: 402,
    type: "payment_required",
    retry: false,
    message: "The credit balance does not cover this request.",
  },
  x402_payment_required: {
    status: 402,
    type: "payment_required",
    retry: false,
    message: "This request requires payment via the x402 protocol.",
  },
  // A used payment transaction stays used: OpenAI SDKs retry a 409 by
  // default, and every retry would be another metered call for the same
  // refusal.
  payment_already_used: {
    status: 409,
    type: "invalid_request_error",
    retry: false,
    message: "This payment transaction has already been used.",
  },
  licence_revoked: {
    status: 403,
    type: "permission_error",
    retry: false,
    message: "The licence for this agent is no longer active.",
  },
  // Paid use of somebody else's agent (`model: "a/<handle>"`). None of these
  // is retried: the same request meets the same licence, price or key, and
  // an answer that was withheld was charged and refunded once already.
  use_not_started: {
    status: 403,
    type: "permission_error",
    retry: false,
    message: "You have not started using this agent.",
  },
  // A session whose person was removed from the organization that pays.
  not_a_member: {
    status: 403,
    type: "permission_error",
    retry: false,
    message: "You are no longer a member of this organization.",
  },
  pricing_changed: invalid(409, "The price of this agent changed. Nothing is charged until the new price is accepted.", false),
  own_agent: invalid(409, "This is your own agent, so there is nothing to pay for.", false),
  not_for_sale: invalid(409, "Use of this agent is not for sale.", false),
  answer_withheld: server(502, "This answer could not be shown.", false),
  api_key_use_price_cap_exceeded: {
    status: 403,
    type: "permission_error",
    retry: false,
    message: "This use costs more than this API key may spend on one use.",
  },
  api_key_daily_cap_exceeded: {
    status: 403,
    type: "permission_error",
    retry: false,
    message: "This use would take this API key past what it may spend in one day.",
  },
  api_key_spend_caps_missing: {
    status: 403,
    type: "permission_error",
    retry: false,
    message: "This API key has no spend caps for paid agents.",
  },
  insufficient_scope: {
    status: 403,
    type: "permission_error",
    retry: false,
    message: "This API key is not allowed to call agents.",
  },
  agent_not_found: invalid(404, "No agent with that slug exists in this organization.", false),
  model_not_found: invalid(404, "The model does not exist or you do not have access to it.", false),
  not_found: invalid(404, "Unknown /v1 route.", false),
  request_too_large: invalid(413, "The request body is too large.", false),
  unsupported_media_type: invalid(415, "The request body must be application/json.", false),
  rate_limit_exceeded: {
    status: 429,
    type: "requests",
    message: "Rate limit reached. Retry after the time in the retry-after header.",
  },
  plan_limit_reached: {
    status: 429,
    type: "insufficient_quota",
    retry: false,
    message: "The plan's API call limit for this period has been reached.",
  },
  // A buyer's plan on an agent (services/paidUse.ts): every use of its
  // period is gone and it stops until it renews. A quota that ran out, not a
  // pace that was too fast: sending the request again cannot be answered, so
  // an SDK is told not to.
  plan_used_up: {
    status: 429,
    type: "insufficient_quota",
    retry: false,
    message: "Every use of the plan for this period has been used.",
  },
  provider_rate_limited: {
    status: 429,
    type: "requests",
    message: "The model provider's rate limit was reached.",
  },
  // Nobody reads this body; the status is for the access log.
  client_closed_request: invalid(499, "The client closed the request before the answer was delivered.", false),
  internal_error: server(500, "The request could not be completed."),
  model_provider_not_configured: server(
    501,
    "The model this agent uses is temporarily unavailable. Try again later.",
    false,
  ),
  hosted_model_not_available: server(
    501,
    "WheelsAI-hosted models cannot be called through this endpoint.",
    false,
  ),
  // Not retried: the same request finds the same deployment state, and a
  // marketplace agent would be charged and refunded on every attempt.
  hosted_model_not_running: server(
    503,
    "The WheelsAI-hosted model this agent uses has no running deployment.",
    false,
  ),
  workflow_not_found: invalid(404, "No workflow with that slug exists in this organization.", false),
  // Its owner enables it; repeating the call cannot.
  workflow_disabled: invalid(400, "This workflow is disabled.", false),
  // The organization's cap on concurrent runs. Nothing was started.
  workflow_run_limit: {
    status: 429,
    type: "requests",
    message: "This organization has too many workflow runs in progress.",
  },
  // Someone cancelled the run from outside while this request waited.
  workflow_cancelled: invalid(409, "The workflow run was cancelled.", false),
  workflow_runner_disabled: server(501, "Workflow runs are temporarily unavailable. Nothing was started. Try again later.", false),
  // A finished run is not retried by the SDK: every repeat is a whole new
  // run, and its steps are billed again.
  workflow_failed: server(502, "The workflow run failed.", false),
  workflow_timeout: server(504, "The workflow did not finish in time and was cancelled.", false),
  upstream_error: server(502, "The model provider had an error."),
  // A provider 401/403 is OUR configuration (or the agent's key), never the
  // caller's WheelsAI key: answering 401 would send them to rotate the wrong
  // credential.
  provider_auth_failed: server(502, "The model provider rejected the credentials.", false),
  provider_model_not_found: server(502, "The model provider does not serve this model.", false),
  empty_answer: server(502, "The model returned no answer."),
  graph_run_failed: server(502, "The agent's graph did not produce an answer."),
  tool_loop_exhausted: server(502, "The model kept requesting tools and never produced an answer."),
  service_unavailable: server(503, "The service is temporarily unavailable."),
  upstream_timeout: server(504, "The model did not answer in time."),
};

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: OpenAiErrorCode;
    [extra: string]: unknown;
  };
}

export interface OpenAiErrorResponse {
  status: number;
  headers: Record<string, string>;
  body: OpenAiErrorBody;
}

export interface OpenAiErrorDetail {
  message?: string;
  param?: string | null;
  /** Seconds; sent as `retry-after` (rounded up, at least 1). */
  retryAfterSeconds?: number;
  /** Machine-readable fields merged into the error object (e.g. requiredCents). */
  extra?: Record<string, unknown>;
}

export function openAiError(code: OpenAiErrorCode, detail: OpenAiErrorDetail = {}): OpenAiErrorResponse {
  const rule = ERROR_RULES[code];
  const headers: Record<string, string> = {};
  if (rule.retry === false) headers["x-should-retry"] = "false";
  if (detail.retryAfterSeconds !== undefined && Number.isFinite(detail.retryAfterSeconds)) {
    headers["retry-after"] = String(Math.max(1, Math.ceil(detail.retryAfterSeconds)));
  }
  return {
    status: rule.status,
    headers,
    body: {
      error: {
        ...detail.extra,
        message: String(sanitizeMessage(detail.message ?? rule.message)),
        type: rule.type,
        param: detail.param ?? null,
        code,
      },
    },
  };
}

/**
 * A refusal of a paid use (services/paidUse.ts), structurally: this module
 * imports no service, only the type of that service's codes.
 */
export interface PaidUseRefusalLike {
  code: string;
  message: string;
  retryAfterSeconds?: number;
  access?: string;
  terms?: unknown;
  priceCents?: number;
  balanceCents?: number;
  refundedCents?: number;
  caps?: Record<string, number>;
  /** plan_used_up: when the plan's count starts again. */
  resetsAt?: string;
  /** plan_used_up and plan_ended: the plans on offer. */
  plans?: unknown;
  /** The refusal came after a charge that was given back: a client must not send the request again by itself. */
  noAutomaticRetry?: boolean;
}

/**
 * What each refusal of a paid use, and of a paid run of a workflow, is on
 * /v1. Typed by the paid service's own list of codes, so a code added there
 * with no answer here does not compile: it can never fall through to
 * internal_error. The status a caller of /v1 gets is this row's own, never
 * the refusal's, so each code is mapped to a row with the status its
 * refusal carries.
 */
const PAID_USE_ERROR_CODES: Record<PaidUseErrorCode, OpenAiErrorCode> = {
  invalid_request: "validation_failed",
  agent_not_found: "agent_not_found",
  own_agent: "own_agent",
  not_for_sale: "not_for_sale",
  // Not on sale any more, or sold as results only: for a caller of /v1
  // both are "this cannot be bought here".
  not_offered: "not_for_sale",
  results_only: "not_for_sale",
  use_not_started: "use_not_started",
  not_a_member: "not_a_member",
  pricing_changed: "pricing_changed",
  insufficient_credits: "marketplace_payment_required",
  subscription_lapsed: "marketplace_payment_required",
  plan_ended: "marketplace_payment_required",
  // Every use of a plan's period is gone and it stops. Its own code, so a
  // caller can tell it from a pace that was too fast, and a quota in its
  // type, so an SDK does not send the request again. Retry-After still says
  // when the count starts again.
  plan_used_up: "plan_used_up",
  api_key_use_price_cap_exceeded: "api_key_use_price_cap_exceeded",
  api_key_daily_cap_exceeded: "api_key_daily_cap_exceeded",
  api_key_spend_caps_missing: "api_key_spend_caps_missing",
  rate_limited: "rate_limit_exceeded",
  too_many_refunds: "rate_limit_exceeded",
  client_closed_request: "client_closed_request",
  model_error: "upstream_error",
  answer_withheld: "answer_withheld",
  agent_unavailable: "service_unavailable",
  // The listing is paused (services/listingPause.ts): the same 503, and
  // `reason` says which.
  agent_paused: "service_unavailable",
  rate_limiter_unavailable: "service_unavailable",
  // A run's refusals: not reachable from a chat completion.
  not_a_task_agent: "validation_failed",
  not_a_scheduled_agent: "validation_failed",
  input_too_large: "validation_failed",
  input_invalid: "validation_failed",
  // A paid run of a workflow on sale (model "w/<slug>"). Each is answered
  // as its agent twin is, or by the row the owner's own workflow call uses,
  // and `reason` carries the paid service's code where the two differ.
  workflow_not_found: "workflow_not_found",
  own_workflow: "own_agent",
  workflow_unavailable: "service_unavailable",
  // Every paid run the workflow can hold is going: a pace, as rate_limited is.
  workflow_busy: "rate_limit_exceeded",
  run_failed: "workflow_failed",
  run_timed_out: "workflow_timeout",
};

/**
 * A paid use's refusal in OpenAI's shape. The sentence is the paid
 * service's own, written for the payer; the machine-readable fields it
 * carries (the terms, the plans on offer, the price and the balance, what
 * was refunded, when a plan's count starts again, a key's cap) ride on the
 * error object. A code this table does not know is
 * a 500 that says nothing: never a refusal passed through unread.
 */
export function paidUseOpenAiError(refusal: PaidUseRefusalLike): OpenAiErrorResponse {
  const code = Object.hasOwn(PAID_USE_ERROR_CODES, refusal.code)
    ? PAID_USE_ERROR_CODES[refusal.code as PaidUseErrorCode]
    : null;
  if (!code) return openAiError("internal_error");
  const extra: Record<string, unknown> = {
    ...refusal.caps,
    ...(refusal.access !== undefined && { access: refusal.access }),
    ...(refusal.terms !== undefined && { terms: refusal.terms }),
    ...(refusal.plans !== undefined && { plans: refusal.plans }),
    ...(refusal.priceCents !== undefined && { priceCents: refusal.priceCents }),
    ...(refusal.balanceCents !== undefined && { balanceCents: refusal.balanceCents }),
    ...(refusal.refundedCents !== undefined && { refundedCents: refusal.refundedCents }),
    ...(refusal.resetsAt !== undefined && { resetsAt: refusal.resetsAt }),
    // What the paid service called it, when /v1 folds several into one code.
    ...(code !== refusal.code && { reason: refusal.code }),
  };
  const error = openAiError(code, {
    message: refusal.message,
    ...(refusal.retryAfterSeconds !== undefined && { retryAfterSeconds: refusal.retryAfterSeconds }),
    extra,
  });
  // A paid run of a workflow whose start found no room AFTER its charge: an
  // OpenAI SDK sends a rate limit again by itself, and each try would be
  // another charge and another refund. Only that one refusal says so; the
  // rows above, and every agent's answer, stay as they are.
  if (refusal.noAutomaticRetry === true) error.headers["x-should-retry"] = "false";
  return error;
}

// ============================================
// Request
// ============================================

export const MAX_MESSAGES = 256;
export const MAX_MESSAGE_CHARS = 400_000;
export const MAX_CLIENT_TOOLS = 64;
/** The ceiling an agent's own maxTokens may be configured to (routes/agents.ts). */
export const MAX_COMPLETION_TOKENS = 32_768;

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const contentSchema = z.union([z.string(), z.array(z.record(z.unknown())), z.null()]).optional();

const messageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: contentSchema,
  tool_call_id: z.string().min(1).max(256).optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        type: z.literal("function").optional(),
        function: z.object({ name: z.string().min(1).max(256), arguments: z.string() }),
      }),
    )
    .max(MAX_CLIENT_TOOLS)
    .optional(),
});

const toolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().regex(TOOL_NAME, "must match ^[a-zA-Z0-9_-]{1,64}$"),
    description: z.string().max(4096).optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().nullable().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.object({
    type: z.literal("function"),
    function: z.object({ name: z.string().min(1).max(64) }),
  }),
]);

/** Unknown keys are ignored (zod strips them), exactly as OpenAI does. */
export const chatCompletionRequestSchema = z.object({
  model: z.string().max(256).nullable().optional(),
  messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
  stream: z.boolean().nullable().optional(),
  stream_options: z.object({ include_usage: z.boolean().nullable().optional() }).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  top_p: z.number().min(0).max(1).nullable().optional(),
  max_tokens: z.number().int().min(1).max(MAX_COMPLETION_TOKENS).nullable().optional(),
  max_completion_tokens: z.number().int().min(1).max(MAX_COMPLETION_TOKENS).nullable().optional(),
  stop: z.union([z.string(), z.array(z.string()).min(1).max(4)]).nullable().optional(),
  presence_penalty: z.number().min(-2).max(2).nullable().optional(),
  frequency_penalty: z.number().min(-2).max(2).nullable().optional(),
  seed: z.number().int().nullable().optional(),
  user: z.string().max(256).nullable().optional(),
  response_format: z
    .object({ type: z.enum(["text", "json_object", "json_schema"]) })
    .passthrough()
    .nullable()
    .optional(),
  tools: z.array(toolSchema).max(MAX_CLIENT_TOOLS).nullable().optional(),
  tool_choice: toolChoiceSchema.nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
});

export interface ParsedChatRequest {
  /** Echoed for routing on the unified base; ignored on a path-scoped route. */
  model: string | null;
  messages: NormalizedMessage[];
  stream: boolean;
  includeUsage: boolean;
  params: ProviderRequestParams;
  tools: ClientToolSpec[];
  /** null = the caller did not say; the provider default ("auto") applies. */
  toolChoice: ToolChoice | null;
}

export type ParseChatRequestResult =
  | { ok: true; request: ParsedChatRequest }
  | { ok: false; error: OpenAiErrorResponse };

const refuse = (
  code: OpenAiErrorCode,
  param: string,
  message: string,
): { ok: false; error: OpenAiErrorResponse } => ({
  ok: false,
  error: openAiError(code, { param, message }),
});

/** `["messages", 0, "content"]` -> `messages[0].content`, as OpenAI names params. */
export function paramPath(path: ReadonlyArray<string | number>): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out.length > 0 ? `.${part}` : part;
  }
  return out;
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * Parameters that change what the answer IS and that this API cannot honour.
 * Each is refused by name: silently dropping `n: 3` would return one choice
 * to a caller that indexes three.
 */
function refuseUnsupported(body: Record<string, unknown>): ReturnType<typeof refuse> | null {
  if (isSet(body.n) && body.n !== 1) {
    return refuse("unsupported_parameter", "n", "Only n=1 is supported.");
  }
  if (body.logprobs === true) {
    return refuse("unsupported_parameter", "logprobs", "logprobs is not supported.");
  }
  if (isSet(body.top_logprobs)) {
    return refuse("unsupported_parameter", "top_logprobs", "top_logprobs is not supported.");
  }
  if (isSet(body.logit_bias) && Object.keys(body.logit_bias as object).length > 0) {
    return refuse("unsupported_parameter", "logit_bias", "logit_bias is not supported.");
  }
  if (isSet(body.audio)) {
    return refuse("unsupported_parameter", "audio", "Audio output is not supported.");
  }
  if (isSet(body.modalities)) {
    const modalities = body.modalities;
    const textOnly =
      Array.isArray(modalities) && modalities.length === 1 && modalities[0] === "text";
    if (!textOnly) {
      return refuse("unsupported_parameter", "modalities", 'Only modalities ["text"] is supported.');
    }
  }
  if (isSet(body.functions)) {
    return refuse(
      "unsupported_parameter",
      "functions",
      "The legacy functions parameter is not supported; use tools.",
    );
  }
  if (isSet(body.function_call)) {
    return refuse(
      "unsupported_parameter",
      "function_call",
      "The legacy function_call parameter is not supported; use tool_choice.",
    );
  }
  return null;
}

/** Text of a string or text-part content; a non-text part names itself. */
function flattenContent(
  content: unknown,
): { ok: true; text: string | null } | { ok: false; partType: string } {
  if (content === undefined || content === null) return { ok: true, text: null };
  if (typeof content === "string") return { ok: true, text: content };
  let text = "";
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type !== "text" || typeof part.text !== "string") {
      return { ok: false, partType: typeof part.type === "string" ? part.type : "unknown" };
    }
    text += part.text;
  }
  return { ok: true, text };
}

export function parseChatCompletionRequest(body: unknown): ParseChatRequestResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: openAiError("validation_failed", { message: "The request body must be a JSON object." }) };
  }
  const raw = body as Record<string, unknown>;

  const unsupported = refuseUnsupported(raw);
  if (unsupported) return unsupported;

  const parsed = chatCompletionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const param = issue ? paramPath(issue.path) : "";
    return {
      ok: false,
      error: openAiError("validation_failed", {
        param: param.length > 0 ? param : null,
        message: issue ? `${param || "body"}: ${issue.message}` : undefined,
      }),
    };
  }
  const data = parsed.data;

  const messages: NormalizedMessage[] = [];
  let totalChars = 0;
  for (const [index, message] of data.messages.entries()) {
    const at = `messages[${index}]`;
    const flat = flattenContent(message.content);
    if (!flat.ok) {
      return refuse(
        "unsupported_content",
        `${at}.content`,
        `Content parts of type "${flat.partType}" are not supported; only text is.`,
      );
    }
    totalChars += flat.text?.length ?? 0;

    if (message.role === "tool") {
      if (!message.tool_call_id) {
        return refuse("validation_failed", `${at}.tool_call_id`, "A tool message needs a tool_call_id.");
      }
      messages.push({ role: "tool", content: flat.text ?? "", tool_call_id: message.tool_call_id });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
      for (const call of toolCalls) totalChars += call.function.arguments.length;
      if (toolCalls.length === 0 && flat.text === null) {
        return refuse(
          "validation_failed",
          `${at}.content`,
          "An assistant message needs content unless it carries tool_calls.",
        );
      }
      messages.push({
        role: "assistant",
        content: flat.text,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      });
      continue;
    }

    if (flat.text === null) {
      return refuse("validation_failed", `${at}.content`, `A ${message.role} message needs content.`);
    }
    messages.push({
      // `developer` is OpenAI's newer name for the system role; providers
      // behind this API only know `system`.
      role: message.role === "developer" ? "system" : message.role,
      content: flat.text,
    });
  }
  if (totalChars > MAX_MESSAGE_CHARS) {
    return refuse(
      "messages_too_large",
      "messages",
      `The conversation is ${totalChars} characters; the limit is ${MAX_MESSAGE_CHARS}.`,
    );
  }

  const tools: ClientToolSpec[] = [];
  const names = new Set<string>();
  for (const [index, tool] of (data.tools ?? []).entries()) {
    const name = tool.function.name;
    if (names.has(name)) {
      return refuse("validation_failed", `tools[${index}].function.name`, `Tool "${name}" is listed twice.`);
    }
    names.add(name);
    tools.push({
      type: "function",
      function: {
        name,
        ...(tool.function.description !== undefined && { description: tool.function.description }),
        ...(tool.function.parameters !== undefined && { parameters: tool.function.parameters }),
        ...(typeof tool.function.strict === "boolean" && { strict: tool.function.strict }),
      },
    });
  }

  const toolChoice: ToolChoice | null = data.tool_choice ?? null;
  if (toolChoice !== null && typeof toolChoice === "object" && !names.has(toolChoice.function.name)) {
    // An agent's own tools are never selectable by the caller: they run
    // server-side, on the agent's terms.
    return refuse(
      "unknown_tool_choice",
      "tool_choice",
      `tool_choice names "${toolChoice.function.name}", which is not in tools.`,
    );
  }
  if (toolChoice === "required" && tools.length === 0) {
    return refuse("unknown_tool_choice", "tool_choice", 'tool_choice "required" needs at least one tool.');
  }

  // max_completion_tokens is the current name; when both are sent it wins.
  const maxTokens = data.max_completion_tokens ?? data.max_tokens ?? undefined;
  const params = pickProviderParams({
    temperature: data.temperature,
    top_p: data.top_p,
    max_tokens: maxTokens,
    stop: data.stop,
    seed: data.seed,
    response_format: data.response_format,
    presence_penalty: data.presence_penalty,
    frequency_penalty: data.frequency_penalty,
    user: data.user,
    parallel_tool_calls: data.parallel_tool_calls,
  });

  return {
    ok: true,
    request: {
      model: data.model ?? null,
      messages,
      stream: data.stream === true,
      includeUsage: data.stream_options?.include_usage === true,
      params,
      tools,
      toolChoice,
    },
  };
}

/**
 * The first client tool whose name is also one of the platform's skills, or
 * null. Checked against EVERY registry key, not the agent's enabled set: a
 * caller-defined `web_search` on an agent that later enables the skill would
 * silently change who executes the call.
 */
export function findToolNameConflict(
  tools: ClientToolSpec[],
  skillKeys: Iterable<string>,
): string | null {
  const reserved = new Set(skillKeys);
  for (const tool of tools) {
    if (reserved.has(tool.function.name)) return tool.function.name;
  }
  return null;
}

// ============================================
// Responses
// ============================================

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export function normalizeFinishReason(raw: string | null | undefined, hasToolCalls = false): FinishReason {
  if (hasToolCalls || raw === "tool_calls" || raw === "function_call") return "tool_calls";
  if (raw === "length" || raw === "content_filter") return raw;
  return "stop";
}

export function newCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

export interface CompletionMeta {
  id: string;
  /** Unix seconds. */
  created: number;
  /** What the caller is told the model is, e.g. `agent/<slug>`. */
  model: string;
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function toOpenAiUsage(usage: WireUsage): OpenAiUsage {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

export interface ChatCompletionInput extends CompletionMeta {
  content: string | null;
  finishReason?: string | null;
  /** Calls handed back for the CALLER to execute. */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** null/undefined = the provider reported none. Never zero-filled. */
  usage?: WireUsage | null;
  /** The `wheelsai` extension object, when there is one. */
  extension?: Record<string, unknown>;
}

export function toChatCompletion(input: ChatCompletionInput): Record<string, unknown> {
  const toolCalls = (input.toolCalls ?? []).map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
  const handBack = toolCalls.length > 0;
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          // OpenAI sends null content alongside tool_calls.
          content: handBack && !input.content ? null : (input.content ?? ""),
          refusal: null,
          ...(handBack && { tool_calls: toolCalls }),
        },
        logprobs: null,
        finish_reason: normalizeFinishReason(input.finishReason, handBack),
      },
    ],
    ...(input.usage && { usage: toOpenAiUsage(input.usage) }),
    ...(input.extension && { wheelsai: input.extension }),
  };
}

export function toChunk(
  meta: CompletionMeta,
  delta: Record<string, unknown>,
  finishReason: FinishReason | null = null,
): Record<string, unknown> {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** `delta.tool_calls` entries for calls that already exist in full. */
export function toolCallDeltas(
  calls: Array<{ id: string; name: string; arguments: string }>,
): Array<Record<string, unknown>> {
  return calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));
}

/**
 * A chunk that carries no choice. `choices: []` is what keeps
 * `chunk.choices[0]?.delta` from throwing in an OpenAI SDK consumer; it is
 * also the shape of OpenAI's own usage chunk.
 */
export function extensionChunk(meta: CompletionMeta, extension: Record<string, unknown>): Record<string, unknown> {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [],
    wheelsai: extension,
  };
}

/** null when the provider reported no usage: an unknown is not sent as zero. */
export function usageChunk(meta: CompletionMeta, usage: WireUsage | null | undefined): Record<string, unknown> | null {
  if (!usage) return null;
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [],
    usage: toOpenAiUsage(usage),
  };
}

export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

// ============================================
// Stream adapter
// ============================================

/** The part of the runtime's stream outcome the adapter reads. */
export interface AdaptableOutcome {
  ok: boolean;
  usage?: WireUsage | null;
  /** Why a failed stream failed (the runtime's StreamFailureCode). */
  code?: string;
}

export interface AdaptableStream<O extends AdaptableOutcome> {
  stream: ReadableStream<Uint8Array>;
  outcome: Promise<O>;
}

export interface StreamAdapterOptions extends CompletionMeta {
  /** The caller's stream_options.include_usage. */
  includeUsage: boolean;
  /**
   * When set, the stream opens with OpenAI's own first chunk (the assistant
   * role and empty content) carrying this object as its `wheelsai` field:
   * what the non-streamed response says about the agent, the charge and the
   * grounding, said before the first token instead of not at all.
   */
  opening?: Record<string, unknown>;
}

/**
 * What an OpenAI client is told about a failed stream. Fixed text per cause:
 * the runtime's own error string can quote the provider's error event, and
 * SSE written to the socket never passes the response scrubber.
 */
export function streamFailure(code: string | undefined): { code: OpenAiErrorCode; message: string } {
  switch (code) {
    case "empty_answer":
      return { code: "empty_answer", message: "The model returned no answer." };
    case "truncated":
      return { code: "upstream_error", message: "The model stream ended before the answer finished." };
    case "deadline":
      return { code: "upstream_timeout", message: "The model did not answer in time." };
    case "client_gone":
      return { code: "client_closed_request", message: "The request was cancelled before the answer finished." };
    default:
      return { code: "upstream_error", message: "The model provider reported an error mid-stream." };
  }
}

const DELTA_KEYS = ["role", "content", "refusal"] as const;

function cleanToolCallDeltas(raw: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const [position, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const call = entry as Record<string, unknown>;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    const cleanFn: Record<string, unknown> = {};
    if (typeof fn.name === "string") cleanFn.name = fn.name;
    if (typeof fn.arguments === "string") cleanFn.arguments = fn.arguments;
    out.push({
      index: typeof call.index === "number" ? call.index : position,
      ...(typeof call.id === "string" && call.id.length > 0 && { id: call.id, type: "function" }),
      function: cleanFn,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Rewrites a chat stream into one an OpenAI SDK can consume without
 * surprises:
 *
 *   - every chunk carries OUR id, created and model (`agent/<slug>`), so the
 *     provider's ids, model names and vendor fields (x_groq, ...) never leak
 *   - only `role`, `content`, `refusal` and `tool_calls` survive in a delta
 *   - the runtime's extension event becomes a full chunk with one
 *     empty-delta choice
 *   - upstream usage is withheld; ONE usage chunk is sent at the end, and
 *     only when the caller asked for it and the provider reported it
 *   - the upstream `[DONE]` is held back until the outcome is known: a
 *     successful stream ends with exactly one `[DONE]`, a failed one ends
 *     with one error event and NO `[DONE]` (clients stop reading at `[DONE]`,
 *     so an error sent after it is an empty answer with no explanation)
 *   - a provider's own error event is replaced by fixed text
 */
export function createOpenAiStreamAdapter<O extends AdaptableOutcome>(
  chat: AdaptableStream<O>,
  options: StreamAdapterOptions,
): AdaptableStream<O> {
  const meta: CompletionMeta = { id: options.id, created: options.created, model: options.model };
  const reader = chat.stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let roleSent = false;
  let finished = false;

  const translate = (line: string): string | null => {
    if (!line.startsWith("data:")) return null; // comments, event names, blanks
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") return null;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return null;
    }
    if (typeof json !== "object" || json === null) return null;
    // The outcome says whether the stream failed; the text is not forwarded.
    if (json.error) return null;
    if (json.wheelsai && typeof json.wheelsai === "object") {
      // On an EMPTY-DELTA choice, not `choices: []`: the common consumer
      // loop reads `chunk.choices[0].delta.content` with no guard, and an
      // empty choices array (which OpenAI itself only sends to callers who
      // asked for usage) would throw there.
      return sseFrame({ ...toChunk(meta, {}), wheelsai: json.wheelsai });
    }

    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (!choice) return null; // a usage-only chunk: sent once, at the end

    const rawDelta = (choice.delta ?? {}) as Record<string, unknown>;
    const delta: Record<string, unknown> = {};
    for (const key of DELTA_KEYS) {
      if (typeof rawDelta[key] === "string") delta[key] = rawDelta[key];
    }
    const toolCalls = cleanToolCallDeltas(rawDelta.tool_calls);
    if (toolCalls) delta.tool_calls = toolCalls;

    const finishReason =
      typeof choice.finish_reason === "string" ? normalizeFinishReason(choice.finish_reason) : null;
    // The role is said once, on the first chunk (some providers repeat it).
    if (roleSent) delete delta.role;
    // Reasoning-only and other vendor deltas leave nothing an OpenAI client
    // reads; forwarding the empty shell would be noise.
    if (Object.keys(delta).length === 0 && finishReason === null) return null;

    if (!roleSent) {
      roleSent = true;
      if (delta.role === undefined && finishReason === null) delta.role = "assistant";
    }
    return sseFrame(toChunk(meta, delta, finishReason));
  };

  const drainLines = (flush: boolean): string => {
    let out = "";
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      out += translate(buffer.slice(0, newline).replace(/\r$/, "")) ?? "";
      buffer = buffer.slice(newline + 1);
    }
    if (flush && buffer.length > 0) {
      out += translate(buffer.replace(/\r$/, "")) ?? "";
      buffer = "";
    }
    // A provider that never sends a newline must not grow this unbounded.
    if (buffer.length > 1_000_000) buffer = "";
    return out;
  };

  const ending = async (): Promise<string> => {
    const outcome = await chat.outcome;
    if (!outcome.ok) {
      const failure = streamFailure(outcome.code);
      return sseFrame({
        error: { message: failure.message, type: "server_error", param: null, code: failure.code },
      });
    }
    const usage = options.includeUsage ? usageChunk(meta, outcome.usage) : null;
    return (usage ? sseFrame(usage) : "") + SSE_DONE;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!options.opening) return;
      roleSent = true;
      controller.enqueue(
        encoder.encode(
          sseFrame({ ...toChunk(meta, { role: "assistant", content: "" }), wheelsai: options.opening }),
        ),
      );
    },
    async pull(controller) {
      if (finished) return;
      try {
        // Loop until there is something to enqueue: a pull that enqueues
        // nothing is not called again.
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            const tail = drainLines(true) + (await ending());
            finished = true;
            controller.enqueue(encoder.encode(tail));
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const out = drainLines(false);
          if (out.length > 0) {
            controller.enqueue(encoder.encode(out));
            return;
          }
        }
      } catch {
        // The runtime's streams end with an outcome rather than throwing;
        // this is the guard for one that does not.
        finished = true;
        const failure = streamFailure(undefined);
        try {
          controller.enqueue(
            encoder.encode(
              sseFrame({
                error: { message: failure.message, type: "server_error", param: null, code: failure.code },
              }),
            ),
          );
          controller.close();
        } catch {
          // The consumer is already gone.
        }
      }
    },
    cancel(reason) {
      finished = true;
      return reader.cancel(reason);
    },
  });

  return { stream, outcome: chat.outcome };
}
