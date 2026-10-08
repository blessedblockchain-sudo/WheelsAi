/**
 * /api/agents/:agentId/schedule and /runs: an agent's own schedule and what
 * it produced.
 *
 *   GET  /:agentId/schedule              the schedule as it is
 *   PUT  /:agentId/schedule              create it, or change it
 *   POST /:agentId/schedule/run          run it now        key: agents:invoke
 *   GET  /:agentId/runs                  its runs, newest first
 *   POST /:agentId/runs/:runId/deliver   "Send again": post a stored result
 *
 * GET and PUT answer { schedule, suggested, otherTasks, schedulerRunning }.
 * Everything is scoped to the caller's organization inside the service
 * (services/agentSchedule.ts): another organization's agent or run is 404,
 * and so is an id that cannot name one.
 *
 * "Run now" is the Scheduler's own, so a run started here is billed,
 * bounded, recorded and delivered as a timed run is. "Send again" runs
 * nothing.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import { validationFailure } from "../lib/validationFailure.js";
import {
  AGENT_SCHEDULE_MESSAGES,
  AgentScheduleError,
  getAgentSchedule,
  listAgentRuns,
  putAgentSchedule,
  resendRunResult,
  runAgentScheduleNow,
  RUNS_PAGE,
  scheduleBodySchema,
  type AgentScheduleDeps,
} from "../services/agentSchedule.js";
import { OwnScheduleError } from "../services/agentOwnSchedule.js";

export interface AgentScheduleGuards {
  /** Who are you. */
  auth: preHandlerAsyncHookHandler;
  /** An API key must hold agents:invoke to start a run; a session is not scoped. */
  invoke: preHandlerAsyncHookHandler;
}

export interface AgentScheduleRouteDeps {
  schedule: AgentScheduleDeps;
  guards: AgentScheduleGuards;
}

const agentParams = z.object({ agentId: z.string().uuid() });
const runParams = z.object({ agentId: z.string().uuid(), runId: z.string().uuid() });

const runsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(RUNS_PAGE.max).optional(),
    /** The id of the last run already shown: the page after it is answered. */
    before: z.string().uuid().optional(),
  })
  .strict();

/** A malformed id cannot name anything in this organization: 404. */
function parseParams<T>(schema: z.ZodType<T>, params: unknown, message: string): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new AgentScheduleError(404, "not_found", message);
  return parsed.data;
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AgentScheduleError) {
    return reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
  }
  if (err instanceof OwnScheduleError) {
    return reply.status(err.status).send(err.body ?? { error: err.code, message: err.message, ...err.extra });
  }
  if (err instanceof z.ZodError) return reply.status(400).send(validationFailure(err));
  throw err;
}

export function createAgentScheduleRoutes(deps: AgentScheduleRouteDeps): FastifyPluginAsync {
  return async (app) => {
    const { schedule, guards } = deps;
    const schema = { tags: ["Agents"] };

    app.get(
      "/:agentId/schedule",
      { preHandler: [guards.auth], schema: { ...schema, description: "An agent's own schedule" } },
      async (request, reply) => {
        try {
          const { agentId } = parseParams(agentParams, request.params, AGENT_SCHEDULE_MESSAGES.agentNotFound);
          return await getAgentSchedule(schedule, request.auth!.orgId, agentId);
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.put(
      "/:agentId/schedule",
      { preHandler: [guards.auth], schema: { ...schema, description: "Create or change an agent's own schedule" } },
      async (request, reply) => {
        try {
          const { agentId } = parseParams(agentParams, request.params, AGENT_SCHEDULE_MESSAGES.agentNotFound);
          const body = scheduleBodySchema.parse(request.body);
          return await putAgentSchedule(schedule, request.auth!.orgId, agentId, body);
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.post(
      "/:agentId/schedule/run",
      {
        preHandler: [guards.auth, guards.invoke],
        schema: { ...schema, description: "Run an agent's own schedule now" },
      },
      async (request, reply) => {
        try {
          const { agentId } = parseParams(agentParams, request.params, AGENT_SCHEDULE_MESSAGES.agentNotFound);
          return reply.status(201).send(await runAgentScheduleNow(schedule, request.auth!.orgId, agentId));
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.get(
      "/:agentId/runs",
      { preHandler: [guards.auth], schema: { ...schema, description: "The runs of an agent's own schedule" } },
      async (request, reply) => {
        try {
          const { agentId } = parseParams(agentParams, request.params, AGENT_SCHEDULE_MESSAGES.agentNotFound);
          const query = runsQuery.parse(request.query);
          return await listAgentRuns(schedule, request.auth!.orgId, agentId, query);
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.post(
      "/:agentId/runs/:runId/deliver",
      { preHandler: [guards.auth], schema: { ...schema, description: "Send a finished run's saved result again" } },
      async (request, reply) => {
        try {
          const { agentId, runId } = parseParams(runParams, request.params, AGENT_SCHEDULE_MESSAGES.runNotFound);
          return await resendRunResult(schedule, request.auth!.orgId, agentId, runId);
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );
  };
}
