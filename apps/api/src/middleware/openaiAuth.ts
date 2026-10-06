/**
 * The guard and the error surface of the OpenAI-compatible /v1 API.
 *
 * An OpenAI SDK reads `error.message`, `error.type` and `error.code` out of a
 * failed response, and decides whether to retry from the status and the
 * `x-should-retry` header. The rest of this API answers `{ error: "…",
 * message }`, which such a client prints as `401 "Unauthorized"` and retries
 * blindly. Everything under /v1 that this module touches answers in OpenAI's
 * shape instead: the 401, the scope 403, the plan 429, and - through the
 * error and not-found handlers - whatever Fastify or a plugin throws.
 *
 * Metering is the SAME rule as middleware/auth.ts (`countsAsApiCall`): a
 * request that is not a read counts once, so a chat completion is one plan
 * API call and listing models is free.
 */

import type { FastifyError, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { ZodError } from "zod";

import { meterApiCall } from "../services/orgPlan.js";
import { PlanLimitError } from "../services/plans.js";
import {
  openAiError,
  paramPath,
  type OpenAiErrorCode,
  type OpenAiErrorDetail,
  type OpenAiErrorResponse,
} from "../services/openaiCompat.js";
import { countsAsApiCall } from "./auth.js";

/** The scope a scoped API key needs to call an agent through /v1. */
export const AGENTS_INVOKE_SCOPE = "agents:invoke";

/**
 * The scope a scoped API key needs to run a workflow through /v1. Its own
 * scope, not agents:invoke: one request fans out into every step of the
 * workflow, so a key cut down to chatting with agents does not get it.
 */
export const WORKFLOWS_INVOKE_SCOPE = "workflows:invoke";

export function sendOpenAiError(reply: FastifyReply, error: OpenAiErrorResponse): FastifyReply {
  for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
  return reply.status(error.status).send(error.body);
}

export function replyOpenAiError(
  reply: FastifyReply,
  code: OpenAiErrorCode,
  detail?: OpenAiErrorDetail,
): FastifyReply {
  return sendOpenAiError(reply, openAiError(code, detail));
}

/**
 * Whether the principal may use `scope`. A key created without scopes keeps
 * the full access it has always had; a key that WAS given scopes is held to
 * them. Sessions are not scoped.
 */
export function principalHasScope(
  auth: { type: "jwt" | "api_key"; scopes?: string[] },
  scope: string,
): boolean {
  if (auth.type !== "api_key") return true;
  const scopes = auth.scopes ?? [];
  if (scopes.length === 0) return true;
  return scopes.includes("*") || scopes.includes(scope);
}

function planLimitError(error: PlanLimitError): OpenAiErrorResponse {
  return openAiError("plan_limit_reached", {
    message: error.message,
    extra: { plan: error.plan, limit: error.limit, upgradeUrl: "/dashboard/billing?upgrade=pro" },
  });
}

export interface OpenAiAuthOptions {
  /** A scope a scoped API key must carry (see principalHasScope). */
  scope?: string;
  /** Test seam; counts one plan API call and throws PlanLimitError when over. */
  meter?: (orgId: string) => Promise<unknown>;
}

/**
 * requireAuth for /v1: the same checks in the same order (who are you, then
 * count the call), answered in OpenAI's shape.
 */
export function createOpenAiAuth(options: OpenAiAuthOptions = {}): preHandlerHookHandler {
  const meter = options.meter ?? ((orgId: string) => meterApiCall(orgId));
  return async (request, reply) => {
    const auth = request.auth;
    if (!auth) {
      return replyOpenAiError(reply, "invalid_api_key", {
        message:
          "Missing or invalid API key. Send it as 'Authorization: Bearer <key>'; keys are created in the dashboard under API Keys.",
      });
    }
    if (options.scope && !principalHasScope(auth, options.scope)) {
      return replyOpenAiError(reply, "insufficient_scope", {
        message: `This API key does not have the "${options.scope}" scope.`,
      });
    }
    if (countsAsApiCall({ authType: auth.type, method: request.method, url: request.url })) {
      try {
        await meter(auth.orgId);
      } catch (err) {
        if (err instanceof PlanLimitError && err.limit === "monthlyApiCalls") {
          return sendOpenAiError(reply, planLimitError(err));
        }
        throw err;
      }
    }
  };
}

/**
 * What a thrown error becomes under /v1. Client errors keep their status: a
 * blanket "anything else is a 500" would turn the rate limiter's 429 and
 * Fastify's own 400/413/415 into server errors that SDKs retry.
 */
export function toOpenAiErrorResponse(error: unknown): OpenAiErrorResponse {
  if (error instanceof PlanLimitError) {
    if (error.limit === "monthlyApiCalls") return planLimitError(error);
    // A feature or size limit of the plan: not a quota that resets, a 403.
    return { ...planLimitError(error), status: 403 };
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const param = issue ? paramPath(issue.path) : "";
    return openAiError("validation_failed", {
      param: param.length > 0 ? param : null,
      message: issue ? `${param || "body"}: ${issue.message}` : undefined,
    });
  }

  const err = (typeof error === "object" && error !== null ? error : {}) as Partial<FastifyError>;
  const status = typeof err.statusCode === "number" ? err.statusCode : 500;
  const message = typeof err.message === "string" ? err.message : undefined;

  if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE" || status === 413) return openAiError("request_too_large");
  if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || status === 415) {
    return openAiError("unsupported_media_type");
  }
  // @fastify/rate-limit. It has already put retry-after and the x-ratelimit
  // headers on the reply, which sendOpenAiError leaves in place.
  if (status === 429) return openAiError("rate_limit_exceeded");
  if (status === 401) return openAiError("invalid_api_key");
  if (status === 404) return openAiError("not_found");
  if (status >= 400 && status < 500) {
    // Fastify's own 4xx (malformed JSON, an empty JSON body, ...). Its message
    // describes the request, not this server.
    const response = openAiError("validation_failed", { message });
    return { ...response, status };
  }
  if (status === 503) return openAiError("service_unavailable");
  return openAiError("internal_error");
}

export function openAiErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const response = toOpenAiErrorResponse(error);
  if (response.status >= 500) request.log.error(error);
  else request.log.info({ err: error }, "refused /v1 request");
  return sendOpenAiError(reply, response);
}

/**
 * Unmatched /v1 paths. Named, because an OpenAI client pointed at this base
 * will try endpoints this API does not have (`/v1/responses`, `/v1/embeddings`)
 * and should be told so rather than shown Fastify's default 404.
 */
export function openAiNotFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  const path = request.url.split("?")[0];
  return replyOpenAiError(reply, "not_found", {
    message: `${request.method} ${path} is not part of this API. The OpenAI-compatible endpoints are POST /v1/chat/completions, POST /v1/agents/{slug}/chat/completions, POST /v1/workflows/{slug}/chat/completions, POST /v1/{deployment}/chat/completions and GET /v1/models.`,
  });
}
