/**
 * /api/scheduler — scheduled tasks and their executions.
 *
 * Bodies and queries are parsed by strict zod schemas, so an unknown key
 * or an unknown task type is a 400 and never reaches the database. The
 * shape of a task is checked here; what depends on the task's type or on
 * the organization (the payload, the ids it points at, the schedule) is
 * checked by the service against the task-type registry.
 *
 * Errors follow the documented contract: 400 validation_failed (details
 * keyed by field, payload fields as "payload.url"), 400 invalid_schedule
 * (reason), 400 invalid_task (the field named), 404 for a task or
 * execution that is not in this organization, 409 name_taken,
 * not_cancellable or already_running. Anything unexpected is rethrown to
 * the global error handler (logged, scrubbed 500), never relabelled as a
 * 400.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import type * as schedulerService from "../services/scheduler.js";
import { TASK_TYPE_IDS } from "../services/scheduledTaskTypes.js";
import { MAX_INTERVAL_SECONDS } from "../services/scheduleCalc.js";
import { isUniqueViolation } from "../services/workflowErrors.js";

export type SchedulerRouteService = Pick<
  typeof schedulerService,
  | "createScheduledTask"
  | "getScheduledTasks"
  | "getScheduledTask"
  | "updateScheduledTask"
  | "deleteScheduledTask"
  | "toggleScheduledTask"
  | "triggerTask"
  | "getTaskExecutions"
  | "cancelExecution"
  | "getSchedulerStats"
  | "getTaskTypes"
>;

export interface SchedulerRouteDeps {
  /** Defaults to services/scheduler.ts (loaded lazily). */
  service?: SchedulerRouteService;
}

const MAX_PAYLOAD_BYTES = 65_536;

// The registry's types: a type the executor would refuse is refused
// here, when the task is saved, not at its first firing.
const TASK_TYPES = TASK_TYPE_IDS;
const SCHEDULE_TYPES = ["cron", "interval", "once"] as const;

const taskFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500),
  taskType: z.enum(TASK_TYPES),
  scheduleType: z.enum(SCHEDULE_TYPES),
  cronExpression: z.string().trim().min(1).max(100),
  // The minimum is the service's to state (invalid_schedule:
  // interval_too_short), with the other schedule rules.
  intervalSeconds: z.number().int().min(1).max(MAX_INTERVAL_SECONDS),
  // An ISO instant, or a local date-time read in the task's time zone.
  scheduledAt: z.string().trim().min(1).max(64),
  timezone: z.string().min(1).max(64),
  payload: z
    .record(z.unknown())
    .refine((p) => Buffer.byteLength(JSON.stringify(p), "utf8") <= MAX_PAYLOAD_BYTES, {
      message: `payload must be at most ${MAX_PAYLOAD_BYTES} bytes`,
    }),
  timeout: z.number().int().min(5_000).max(3_600_000),
  maxRetries: z.number().int().min(0).max(5),
};

const createBody = z
  .object({
    name: taskFields.name,
    description: taskFields.description.optional(),
    taskType: taskFields.taskType,
    agentId: z.string().uuid().nullable().optional(),
    orchestrationId: z.string().uuid().nullable().optional(),
    scheduleType: taskFields.scheduleType,
    cronExpression: taskFields.cronExpression.optional(),
    intervalSeconds: taskFields.intervalSeconds.optional(),
    scheduledAt: taskFields.scheduledAt.optional(),
    timezone: taskFields.timezone.optional(),
    payload: taskFields.payload.optional(),
    timeout: taskFields.timeout.optional(),
    maxRetries: taskFields.maxRetries.optional(),
  })
  .strict()
  .superRefine((task, ctx) => {
    const needs = {
      cron: "cronExpression",
      interval: "intervalSeconds",
      once: "scheduledAt",
    } as const;
    const field = needs[task.scheduleType];
    if (task[field] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `a ${task.scheduleType} schedule needs ${field}`,
      });
    }
  });

const updateBody = z
  .object({
    name: taskFields.name,
    description: taskFields.description,
    taskType: taskFields.taskType,
    agentId: z.string().uuid().nullable(),
    orchestrationId: z.string().uuid().nullable(),
    scheduleType: taskFields.scheduleType,
    cronExpression: taskFields.cronExpression,
    intervalSeconds: taskFields.intervalSeconds,
    scheduledAt: taskFields.scheduledAt,
    timezone: taskFields.timezone,
    payload: taskFields.payload,
    timeout: taskFields.timeout,
    maxRetries: taskFields.maxRetries,
    isEnabled: z.boolean(),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "nothing to update" });

const toggleBody = z.object({ isEnabled: z.boolean() }).strict();

const paging = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
};
const listQuery = z
  .object({
    agentId: z.string().uuid().optional(),
    orchestrationId: z.string().uuid().optional(),
    taskType: z.enum(TASK_TYPES).optional(),
    status: z.string().max(32).optional(),
    isEnabled: z.enum(["true", "false"]).optional(),
    ...paging,
  })
  .strict();
const executionsQuery = z.object({ status: z.string().max(32).optional(), ...paging }).strict();

const taskParams = z.object({ taskId: z.string().uuid() });
const executionParams = z.object({ taskId: z.string().uuid(), executionId: z.string().uuid() });

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

class NotFound extends Error {}

function guarded(handler: Handler): Handler {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: "validation_failed", details: err.flatten() });
      }
      if (err instanceof NotFound) {
        return reply.status(404).send({ error: "not_found", message: "Not found" });
      }
      // Matched by shape, not class: an injected service need not share
      // the production module's SchedulerError.
      const expected = err as { name?: string; status?: number; code?: string; extra?: object };
      if (expected?.name === "SchedulerError" && typeof expected.status === "number") {
        return reply.status(expected.status).send({
          error: expected.code,
          message: (err as Error).message,
          ...(expected.extra ?? {}),
        });
      }
      if (isUniqueViolation(err)) {
        return reply
          .status(409)
          .send({ error: "name_taken", message: "A scheduled task with this name already exists" });
      }
      throw err;
    }
  };
}

/** A malformed id cannot name anything in this organization: 404. */
function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new NotFound();
  return parsed.data;
}

export function createSchedulerRoutes(deps: SchedulerRouteDeps = {}): FastifyPluginAsync {
  let loaded: SchedulerRouteService | null = deps.service ?? null;
  const service = async (): Promise<SchedulerRouteService> =>
    (loaded ??= await import("../services/scheduler.js"));

  return async (app) => {
    app.addHook("preHandler", requireAuth);

    app.get(
      "/stats",
      guarded(async (request) => (await service()).getSchedulerStats(request.auth!.orgId)),
    );

    // A static path: the router prefers it over "/:taskId".
    app.get(
      "/task-types",
      guarded(async () => (await service()).getTaskTypes()),
    );

    app.post(
      "/",
      guarded(async (request, reply) => {
        const body = createBody.parse(request.body);
        const task = await (await service()).createScheduledTask(request.auth!.orgId, body);
        return reply.status(201).send(task);
      }),
    );

    app.get(
      "/",
      guarded(async (request) => {
        const query = listQuery.parse(request.query);
        return (await service()).getScheduledTasks(request.auth!.orgId, {
          agentId: query.agentId,
          orchestrationId: query.orchestrationId,
          taskType: query.taskType,
          status: query.status,
          isEnabled: query.isEnabled === undefined ? undefined : query.isEnabled === "true",
          limit: query.limit,
          offset: query.offset,
        });
      }),
    );

    app.get(
      "/:taskId",
      guarded(async (request) => {
        const { taskId } = parseParams(taskParams, request.params);
        return (await service()).getScheduledTask(taskId, request.auth!.orgId);
      }),
    );

    app.patch(
      "/:taskId",
      guarded(async (request) => {
        const { taskId } = parseParams(taskParams, request.params);
        const body = updateBody.parse(request.body);
        return (await service()).updateScheduledTask(taskId, request.auth!.orgId, body);
      }),
    );

    app.delete(
      "/:taskId",
      guarded(async (request, reply) => {
        const { taskId } = parseParams(taskParams, request.params);
        await (await service()).deleteScheduledTask(taskId, request.auth!.orgId);
        return reply.status(204).send();
      }),
    );

    app.post(
      "/:taskId/toggle",
      guarded(async (request) => {
        const { taskId } = parseParams(taskParams, request.params);
        const { isEnabled } = toggleBody.parse(request.body);
        return (await service()).toggleScheduledTask(taskId, request.auth!.orgId, isEnabled);
      }),
    );

    app.post(
      "/:taskId/trigger",
      guarded(async (request, reply) => {
        const { taskId } = parseParams(taskParams, request.params);
        const { execution, deferred } = await (await service()).triggerTask(
          taskId,
          request.auth!.orgId,
        );
        // 201: the run finished inside this request and its output is in
        // the body. 202: the work was handed on (a queued workflow run)
        // and the execution is still running.
        return reply.status(deferred ? 202 : 201).send(execution);
      }),
    );

    app.get(
      "/:taskId/executions",
      guarded(async (request) => {
        const { taskId } = parseParams(taskParams, request.params);
        const query = executionsQuery.parse(request.query);
        return (await service()).getTaskExecutions(taskId, request.auth!.orgId, query);
      }),
    );

    app.post(
      "/:taskId/executions/:executionId/cancel",
      guarded(async (request) => {
        const { taskId, executionId } = parseParams(executionParams, request.params);
        return (await service()).cancelExecution(executionId, taskId, request.auth!.orgId);
      }),
    );
  };
}

export const schedulerRoutes = createSchedulerRoutes();
