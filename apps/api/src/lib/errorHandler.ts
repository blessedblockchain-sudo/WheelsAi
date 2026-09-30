/**
 * Global Fastify error handler (remediation F1).
 *
 * ~14 route files validate input with a bare `schema.parse(...)` rather
 * than Fastify's schema option, which throws a ZodError. The handler used
 * to see no `statusCode` on it and fall through to 500 — turning every
 * invalid request body into a server error (and masking the real cause).
 * Map ZodError to a 400 with a flattened, client-readable detail.
 *
 * Order matters: ZodError first (thrown by route code), then Fastify's own
 * schema-validation errors (`error.validation`), then the statusCode-aware
 * fallback that hides internal 500 messages.
 */

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { PlanLimitError } from "../services/plans.js";

export function globalErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  request.log.error(error);

  // Plan limits read the same everywhere: what was hit, which plan, and
  // where to upgrade. Quota exhaustion is 429; a feature/size limit is 403.
  if (error instanceof PlanLimitError) {
    return reply.status(error.limit === "monthlyApiCalls" ? 429 : 403).send({
      error: error.code,
      message: error.message,
      plan: error.plan,
      limit: error.limit,
      upgradeUrl: "/dashboard/billing?upgrade=pro",
    });
  }

  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: "validation_failed",
      details: error.flatten(),
    });
  }

  if (error.validation) {
    return reply.status(400).send({
      error: "Validation Error",
      message: error.message,
      details: error.validation,
    });
  }

  const statusCode = error.statusCode ?? 500;
  const message =
    statusCode === 500 ? "Internal Server Error" : error.message;

  return reply.status(statusCode).send({
    error: statusCode === 500 ? "InternalError" : (error.name ?? "Error"),
    message,
  });
}
