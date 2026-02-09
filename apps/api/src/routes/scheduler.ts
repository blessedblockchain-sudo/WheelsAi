import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import {
  createScheduledTask,
  getScheduledTasks,
  getScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  toggleScheduledTask,
  triggerTask,
  getTaskExecutions,
  cancelExecution,
  getSchedulerStats,
} from "../services/scheduler.js";

// ============================================
// Scheduled Tasks / Cron Jobs Routes
// ============================================

export async function schedulerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Get scheduler stats/dashboard
  app.get("/stats", async (request, reply) => {
    try {
      const stats = await getSchedulerStats(request.auth!.orgId);
      return reply.send(stats);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Create a scheduled task
  app.post<{
    Body: {
      agentId: string;
      name: string;
      description?: string;
      scheduleType: string;
      cronExpression?: string;
      intervalSeconds?: number;
      scheduledAt?: string;
      timezone?: string;
      taskType: string;
      payload?: Record<string, any>;
      timeout?: number;
      maxRetries?: number;
    };
  }>("/", async (request, reply) => {
    try {
      const task = await createScheduledTask(request.auth!.orgId, request.body);
      return reply.status(201).send(task);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // List scheduled tasks
  app.get<{
    Querystring: {
      agentId?: string;
      status?: string;
      isEnabled?: string;
      limit?: string;
      offset?: string;
    };
  }>("/", async (request, reply) => {
    try {
      const { agentId, status, isEnabled, limit, offset } = request.query;
      const result = await getScheduledTasks(request.auth!.orgId, {
        agentId,
        status,
        isEnabled: isEnabled === "true" ? true : isEnabled === "false" ? false : undefined,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Get a scheduled task
  app.get<{ Params: { taskId: string } }>("/:taskId", async (request, reply) => {
    try {
      const task = await getScheduledTask(request.params.taskId, request.auth!.orgId);
      return reply.send(task);
    } catch (error: any) {
      return reply.status(404).send({ error: error.message });
    }
  });

  // Update a scheduled task
  app.patch<{
    Params: { taskId: string };
    Body: {
      name?: string; description?: string; scheduleType?: string;
      cronExpression?: string; intervalSeconds?: number; scheduledAt?: string;
      timezone?: string; taskType?: string; payload?: Record<string, any>;
      timeout?: number; maxRetries?: number; isEnabled?: boolean;
    };
  }>("/:taskId", async (request, reply) => {
    try {
      const task = await updateScheduledTask(request.params.taskId, request.auth!.orgId, request.body);
      return reply.send(task);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Delete a scheduled task
  app.delete<{ Params: { taskId: string } }>("/:taskId", async (request, reply) => {
    try {
      await deleteScheduledTask(request.params.taskId, request.auth!.orgId);
      return reply.status(204).send();
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Toggle task enabled/disabled
  app.post<{
    Params: { taskId: string };
    Body: { isEnabled: boolean };
  }>("/:taskId/toggle", async (request, reply) => {
    try {
      const task = await toggleScheduledTask(request.params.taskId, request.auth!.orgId, request.body.isEnabled);
      return reply.send(task);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Trigger a task manually
  app.post<{ Params: { taskId: string } }>("/:taskId/trigger", async (request, reply) => {
    try {
      const execution = await triggerTask(request.params.taskId, request.auth!.orgId);
      return reply.status(201).send(execution);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Get task executions
  app.get<{
    Params: { taskId: string };
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/:taskId/executions", async (request, reply) => {
    try {
      const { status, limit, offset } = request.query;
      const result = await getTaskExecutions(request.params.taskId, request.auth!.orgId, {
        status,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Cancel an execution
  app.post<{
    Params: { taskId: string; executionId: string };
  }>("/:taskId/executions/:executionId/cancel", async (request, reply) => {
    try {
      const result = await cancelExecution(request.params.executionId, request.params.taskId, request.auth!.orgId);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
