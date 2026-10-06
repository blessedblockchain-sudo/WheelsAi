/**
 * /api/orchestrations — workflows: definitions, plans and runs.
 *
 * Every body and query is parsed by a strict zod schema, so an unknown
 * key is a 400 and never reaches the database. Errors follow the
 * documented contract:
 *
 *   400 validation_failed   the request shape is wrong (zod details)
 *   400 invalid_workflow    the definition cannot run (step, field named)
 *   404                     no such workflow or run in this organization
 *   409 name_taken / stale_definition / workflow_disabled / execution_finished
 *   429 workflow_run_limit  the organization's concurrent-run cap
 *   501 workflow_runner_disabled
 *   503 workflow_queue_unavailable
 *
 * Anything unexpected is rethrown to the global error handler, which
 * logs it and answers a scrubbed 500. Nothing is caught and relabelled
 * as a 400.
 *
 * Starting a run answers 202 with a queued run; a worker executes it and
 * the caller polls GET /:orchId/executions/:execId.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import type * as orchestrationService from "../services/orchestration.js";
import {
  workflowDefinitionSchema,
  workflowPatchSchema,
  workflowReplaceSchema,
} from "../services/workflowDefinition.js";
import { isUniqueViolation, WorkflowError } from "../services/workflowErrors.js";

export type OrchestrationRouteService = Pick<
  typeof orchestrationService,
  | "planWorkflow"
  | "createOrchestration"
  | "getOrchestrations"
  | "getOrchestration"
  | "replaceOrchestration"
  | "updateOrchestration"
  | "deleteOrchestration"
  | "executeOrchestration"
  | "getExecution"
  | "getExecutions"
  | "cancelExecution"
  | "getOrchestrationStats"
>;

export interface OrchestrationRouteDeps {
  /** Defaults to services/orchestration.ts (loaded lazily). */
  service?: OrchestrationRouteService;
}

const MAX_RUN_INPUT_BYTES = 65_536;

const orchParams = z.object({ orchId: z.string().uuid() });
const execParams = z.object({ orchId: z.string().uuid(), execId: z.string().uuid() });

const paging = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
};
const listQuery = z
  .object({ isEnabled: z.enum(["true", "false"]).optional(), ...paging })
  .strict();
const executionsQuery = z
  .object({
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
    ...paging,
  })
  .strict();

const executeBody = z
  .object({
    prompt: z.string().max(20_000).optional(),
    input: z
      .record(z.unknown())
      .refine((input) => Buffer.byteLength(JSON.stringify(input), "utf8") <= MAX_RUN_INPUT_BYTES, {
        message: `input must be at most ${MAX_RUN_INPUT_BYTES} bytes`,
      })
      .optional(),
  })
  .strict();

/**
 * Who started a run comes from how the request authenticated: a session
 * is a person ('manual'), an API key is a program ('api'). It is never
 * read from the body, where `triggeredBy` is an unknown key and a 400.
 */
export function triggerFromAuth(auth: {
  type: "jwt" | "api_key";
  userId: string | null;
  apiKeyId?: string;
}): { triggeredBy: "manual" | "api"; triggeredById: string | null } {
  return auth.type === "api_key"
    ? { triggeredBy: "api", triggeredById: auth.apiKeyId ?? null }
    : { triggeredBy: "manual", triggeredById: auth.userId };
}

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Turns the service's expected failures into their contract responses. */
function guarded(handler: Handler): Handler {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: "validation_failed", details: err.flatten() });
      }
      if (err instanceof WorkflowError) {
        return reply
          .status(err.status)
          .send({ error: err.code, message: err.message, ...err.extra });
      }
      if (isUniqueViolation(err)) {
        return reply
          .status(409)
          .send({ error: "name_taken", message: "A workflow with this name already exists" });
      }
      throw err;
    }
  };
}

/** A malformed id cannot name anything in this organization: 404. */
function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new WorkflowError("not_found", "Not found");
  return parsed.data;
}

export function createOrchestrationRoutes(deps: OrchestrationRouteDeps = {}): FastifyPluginAsync {
  let loaded: OrchestrationRouteService | null = deps.service ?? null;
  const service = async (): Promise<OrchestrationRouteService> =>
    (loaded ??= await import("../services/orchestration.js"));

  return async (app) => {
    app.addHook("preHandler", requireAuth);

    app.get(
      "/stats",
      guarded(async (request) => (await service()).getOrchestrationStats(request.auth!.orgId)),
    );

    // Dry run: validates and plans a definition, writes nothing.
    app.post(
      "/plan",
      guarded(async (request) => {
        const def = workflowDefinitionSchema.parse(request.body);
        return (await service()).planWorkflow(request.auth!.orgId, def);
      }),
    );

    app.post(
      "/",
      guarded(async (request, reply) => {
        const def = workflowDefinitionSchema.parse(request.body);
        const created = await (await service()).createOrchestration(request.auth!.orgId, def);
        return reply.status(201).send(created);
      }),
    );

    app.get(
      "/",
      guarded(async (request) => {
        const query = listQuery.parse(request.query);
        return (await service()).getOrchestrations(request.auth!.orgId, {
          isEnabled: query.isEnabled === undefined ? undefined : query.isEnabled === "true",
          limit: query.limit,
          offset: query.offset,
        });
      }),
    );

    app.get(
      "/:orchId",
      guarded(async (request) => {
        const { orchId } = parseParams(orchParams, request.params);
        return (await service()).getOrchestration(orchId, request.auth!.orgId);
      }),
    );

    // Replaces the whole definition: settings and steps together.
    app.put(
      "/:orchId",
      guarded(async (request) => {
        const { orchId } = parseParams(orchParams, request.params);
        const { expectedUpdatedAt, ...def } = workflowReplaceSchema.parse(request.body);
        return (await service()).replaceOrchestration(
          orchId,
          request.auth!.orgId,
          def,
          expectedUpdatedAt,
        );
      }),
    );

    // Metadata only (name, description, enabled).
    app.patch(
      "/:orchId",
      guarded(async (request) => {
        const { orchId } = parseParams(orchParams, request.params);
        const patch = workflowPatchSchema.parse(request.body);
        return (await service()).updateOrchestration(orchId, request.auth!.orgId, patch);
      }),
    );

    app.delete(
      "/:orchId",
      guarded(async (request, reply) => {
        const { orchId } = parseParams(orchParams, request.params);
        await (await service()).deleteOrchestration(orchId, request.auth!.orgId);
        return reply.status(204).send();
      }),
    );

    app.post(
      "/:orchId/execute",
      guarded(async (request, reply) => {
        const { orchId } = parseParams(orchParams, request.params);
        const body = executeBody.parse(request.body ?? {});
        const auth = request.auth!;
        const execution = await (
          await service()
        ).executeOrchestration(orchId, auth.orgId, body, triggerFromAuth(auth));
        return reply.status(202).send({ execution });
      }),
    );

    app.get(
      "/:orchId/executions",
      guarded(async (request) => {
        const { orchId } = parseParams(orchParams, request.params);
        const query = executionsQuery.parse(request.query);
        return (await service()).getExecutions(orchId, request.auth!.orgId, query);
      }),
    );

    app.get(
      "/:orchId/executions/:execId",
      guarded(async (request) => {
        const { orchId, execId } = parseParams(execParams, request.params);
        return (await service()).getExecution(execId, orchId, request.auth!.orgId);
      }),
    );

    // 200 when a queued run was cancelled outright; 202 when a running
    // run was asked to stop and its worker will end it.
    app.post(
      "/:orchId/executions/:execId/cancel",
      guarded(async (request, reply) => {
        const { orchId, execId } = parseParams(execParams, request.params);
        const { execution, outcome } = await (
          await service()
        ).cancelExecution(execId, orchId, request.auth!.orgId);
        return reply.status(outcome === "cancelled" ? 200 : 202).send({ execution });
      }),
    );
  };
}

export const orchestrationRoutes = createOrchestrationRoutes();
