import { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.js";
import {
  getAgentEnabledToolNames,
  toolNodeWarnings,
  getAgentGraph,
  saveAgentGraph,
  deleteAgentGraph,
  getGraphTemplates,
  applyGraphTemplate,
  compileGraph,
  type AgentGraphData,
} from "../services/agentGraph.js";
import {
  MarketplaceLicenceRevokedError,
  MarketplacePaymentRequiredError,
} from "../services/marketplaceMetering.js";
import { getGraphExecutions, runAgentGraph } from "../services/runAgentGraph.js";
import { abortOnClientClose, CLIENT_GONE } from "../services/chatStreamSettlement.js";
import { ServerShuttingDownError } from "../services/inFlightRuns.js";

export async function agentGraphRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook("preHandler", authenticate);

  // ============================================
  // Graph CRUD
  // ============================================

  // Get agent graph
  app.get("/agents/:agentId/graph", async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = request.params as { agentId: string };

    try {
      const graph = await getAgentGraph(agentId, orgId);

      return reply.send({
        success: true,
        data: graph,
      });
    } catch (error: any) {
      return reply.status(404).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Save agent graph
  app.put("/agents/:agentId/graph", async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = request.params as { agentId: string };
    const graphData = request.body as AgentGraphData;

    if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
      return reply.status(400).send({
        success: false,
        error: "Invalid graph data. Must include nodes and edges arrays.",
      });
    }

    try {
      const graph = await saveAgentGraph(agentId, orgId, graphData);

      return reply.send({
        success: true,
        data: graph,
        message: "Graph saved successfully",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Delete agent graph
  app.delete("/agents/:agentId/graph", async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = request.params as { agentId: string };

    try {
      await deleteAgentGraph(agentId, orgId);

      return reply.send({
        success: true,
        message: "Graph deleted",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================
  // Templates
  // ============================================

  // Get available templates
  app.get("/graph-templates", async (request, reply) => {
    const templates = getGraphTemplates();

    return reply.send({
      success: true,
      data: templates,
    });
  });

  // Apply template to agent
  app.post("/agents/:agentId/graph/template", async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = request.params as { agentId: string };
    const { templateId } = request.body as { templateId: string };

    if (!templateId) {
      return reply.status(400).send({
        success: false,
        error: "templateId is required",
      });
    }

    try {
      const graph = await applyGraphTemplate(agentId, orgId, templateId);

      return reply.send({
        success: true,
        data: graph,
        message: "Template applied successfully",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================
  // Compilation / Validation
  // ============================================

  // ============================================
  // Execution (graph interpreter: api/tool/loop/parallel/merge nodes)
  // ============================================

  // Run the graph. Compiling only produced an ORDER; this walks it.
  app.post("/agents/:agentId/graph/run", async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = request.params as { agentId: string };
    const body = (request.body ?? {}) as { input?: unknown };
    const input = typeof body.input === "string" ? body.input : "";

    // A client that closes the tab must not leave the graph running (and
    // a marketplace charge pending): the run is cancelled and refunded. One
    // that left before this handler even ran is not charged at all.
    const abort = abortOnClientClose(reply.raw);
    if (abort.signal.aborted) {
      return reply.status(499).send({ success: false, error: CLIENT_GONE });
    }

    try {
      const result = await runAgentGraph(agentId, orgId, input, { signal: abort.signal });
      // A failed RUN is a 200 with status:"failed" — the trace is the
      // useful part, and the request itself succeeded. Only a bad
      // request (no graph, empty graph, wrong agent) is a 4xx.
      return reply.send({ success: true, data: result });
    } catch (error: any) {
      // A deploy is in progress: nothing was charged, and the retry lands on
      // the new instance.
      if (error instanceof ServerShuttingDownError) {
        return reply
          .status(503)
          .header("Retry-After", "5")
          .send({ success: false, error: error.message, reason: "server_shutting_down" });
      }
      if (error instanceof MarketplaceLicenceRevokedError) {
        return reply.status(403).send({ success: false, error: error.message });
      }
      // "You owe your publisher money" is not a malformed request.
      if (error instanceof MarketplacePaymentRequiredError) {
        return reply.status(402).send({
          success: false,
          error: error.message,
          requiredCents: Number(error.requiredCents),
          balanceCents: Number(error.balanceCents),
        });
      }
      return reply.status(400).send({ success: false, error: error.message });
    }
  });

  // Run history for the builder's run panel.
  app.get("/agents/:agentId/graph/executions", async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = request.params as { agentId: string };
    const { limit } = request.query as { limit?: string };

    try {
      const executions = await getGraphExecutions(
        agentId,
        orgId,
        limit ? Math.min(Number(limit) || 20, 100) : 20,
      );
      return reply.send({ success: true, data: executions });
    } catch (error: any) {
      return reply.status(400).send({ success: false, error: error.message });
    }
  });

  // Compile graph for execution
  app.post("/agents/:agentId/graph/compile", async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = request.params as { agentId: string };

    try {
      const compiled = await compileGraph(agentId, orgId);

      return reply.send({
        success: true,
        data: compiled,
        message: "Graph compiled successfully",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Validate graph without saving
  app.post("/agents/:agentId/graph/validate", async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = request.params as { agentId: string };
    const graphData = request.body as AgentGraphData;

    if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
      return reply.status(400).send({
        success: false,
        error: "Invalid graph data. Must include nodes and edges arrays.",
      });
    }

    let enabledTools: string[];
    try {
      enabledTools = await getAgentEnabledToolNames(agentId, orgId);
    } catch (error: any) {
      return reply.status(404).send({ success: false, error: error.message });
    }

    const issues: { type: "error" | "warning"; message: string }[] = [];

    // Check for required nodes
    const nodeTypes = new Set(graphData.nodes.map((n) => n.type));

    if (!nodeTypes.has("input")) {
      issues.push({ type: "error", message: "Graph must have at least one input node" });
    }

    if (!nodeTypes.has("output")) {
      issues.push({ type: "error", message: "Graph must have at least one output node" });
    }

    // Check for orphan nodes (no connections)
    const connectedNodes = new Set<string>();
    for (const edge of graphData.edges) {
      connectedNodes.add(edge.source);
      connectedNodes.add(edge.target);
    }

    for (const node of graphData.nodes) {
      if (!connectedNodes.has(node.id) && graphData.nodes.length > 1) {
        issues.push({
          type: "warning",
          message: `Node "${node.data.label}" (${node.id}) is not connected`,
        });
      }
    }

    // Check for self-loops
    for (const edge of graphData.edges) {
      if (edge.source === edge.target) {
        issues.push({
          type: "error",
          message: `Self-loop detected on node ${edge.source}`,
        });
      }
    }

    // Check node configurations
    for (const node of graphData.nodes) {
      if (node.type === "llm" && !node.data.config.systemPrompt) {
        issues.push({
          type: "warning",
          message: `LLM node "${node.data.label}" has no system prompt`,
        });
      }

      if (node.type === "tool" && !node.data.config.toolName) {
        issues.push({
          type: "error",
          message: `Tool node "${node.data.label}" has no tool configured`,
        });
      }
    }

    // "Valid" used to be reported for a graph whose tool nodes every run
    // refuses, because only the presence of a tool name was checked.
    for (const message of toolNodeWarnings(graphData.nodes, enabledTools)) {
      issues.push({ type: "warning", message });
    }

    const isValid = issues.filter((i) => i.type === "error").length === 0;

    return reply.send({
      success: true,
      data: {
        valid: isValid,
        issues,
      },
    });
  });
}
