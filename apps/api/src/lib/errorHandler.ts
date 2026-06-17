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

export function globalErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  request.log.error(error);

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
