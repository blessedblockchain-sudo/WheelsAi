import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import {
  createOrchestration,
  getOrchestrations,
  getOrchestration,
  updateOrchestration,
  deleteOrchestration,
  executeOrchestration,
  getExecution,
  getExecutions,
  cancelExecution,
  getOrchestrationStats,
} from "../services/orchestration.js";

// ============================================
// Multi-Agent Orchestration Routes
// ============================================

export async function orchestrationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  // Get orchestration stats
  app.get("/stats", async (request, reply) => {
    try {
      const stats = await getOrchestrationStats(request.auth!.orgId);
      return reply.send(stats);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Create orchestration
  app.post<{
    Body: {
      name: string;
      description?: string;
      executionMode: string;
      maxConcurrency?: number;
      timeout?: number;
      retryPolicy?: Record<string, any>;
      inputSchema?: Record<string, any>;
      outputSchema?: Record<string, any>;
      steps: Array<{
        name: string;
        agentId: string;
        inputMapping?: Record<string, any>;
        outputMapping?: Record<string, any>;
        condition?: Record<string, any>;
        onError?: string;
        fallbackAgentId?: string;
        maxRetries?: number;
        timeoutMs?: number;
        dependsOn?: string[];
      }>;
    };
  }>("/", async (request, reply) => {
    try {
      const orch = await createOrchestration(request.auth!.orgId, request.body);
      return reply.status(201).send(orch);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // List orchestrations
  app.get<{
    Querystring: { isEnabled?: string; limit?: string; offset?: string };
  }>("/", async (request, reply) => {
    try {
      const { isEnabled, limit, offset } = request.query;
      const result = await getOrchestrations(request.auth!.orgId, {
        isEnabled: isEnabled === "true" ? true : isEnabled === "false" ? false : undefined,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Get orchestration
  app.get<{ Params: { orchId: string } }>("/:orchId", async (request, reply) => {
    try {
      const orch = await getOrchestration(request.params.orchId, request.auth!.orgId);
      return reply.send(orch);
    } catch (error: any) {
      return reply.status(404).send({ error: error.message });
    }
  });

  // Update orchestration
  app.patch<{
    Params: { orchId: string };
    Body: {
      name?: string;
      description?: string;
      executionMode?: string;
      maxConcurrency?: number;
      timeout?: number;
      isEnabled?: boolean;
    };
  }>("/:orchId", async (request, reply) => {
    try {
      const orch = await updateOrchestration(request.params.orchId, request.auth!.orgId, request.body);
      return reply.send(orch);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Delete orchestration
  app.delete<{ Params: { orchId: string } }>("/:orchId", async (request, reply) => {
    try {
      await deleteOrchestration(request.params.orchId, request.auth!.orgId);
      return reply.status(204).send();
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Execute orchestration
  app.post<{
    Params: { orchId: string };
    Body: { input?: Record<string, any>; triggeredBy?: string };
  }>("/:orchId/execute", async (request, reply) => {
    try {
      const execution = await executeOrchestration(request.params.orchId, request.auth!.orgId, request.body);
      return reply.status(201).send(execution);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // List executions
  app.get<{
    Params: { orchId: string };
    Querystring: { status?: string; limit?: string; offset?: string };
  }>("/:orchId/executions", async (request, reply) => {
    try {
      const { status, limit, offset } = request.query;
      const result = await getExecutions(request.params.orchId, request.auth!.orgId, {
        status,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Get execution detail
  app.get<{
    Params: { orchId: string; execId: string };
  }>("/:orchId/executions/:execId", async (request, reply) => {
    try {
      const exec = await getExecution(request.params.execId, request.params.orchId, request.auth!.orgId);
      return reply.send(exec);
    } catch (error: any) {
      return reply.status(404).send({ error: error.message });
    }
  });

  // Cancel execution
  app.post<{
    Params: { orchId: string; execId: string };
  }>("/:orchId/executions/:execId/cancel", async (request, reply) => {
    try {
      const exec = await cancelExecution(request.params.execId, request.params.orchId, request.auth!.orgId);
      return reply.send(exec);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
