import { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.js";
import {
  getAgentGraph,
  saveAgentGraph,
  deleteAgentGraph,
  getGraphTemplates,
  applyGraphTemplate,
  compileGraph,
  type AgentGraphData,
} from "../services/agentGraph.js";

export async function agentGraphRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook("preHandler", authenticate);

  // ============================================
  // Graph CRUD
  // ============================================

  // Get agent graph
  app.get("/agents/:agentId/graph", async (request, reply) => {
    const { userId } = request.user as { userId: string };
    const { agentId } = request.params as { agentId: string };

    try {
      const graph = await getAgentGraph(agentId, userId);

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
    const { userId } = request.user as { userId: string };
    const { agentId } = request.params as { agentId: string };
    const graphData = request.body as AgentGraphData;

    if (!graphData || !Array.isArray(graphData.nodes) || !Array.isArray(graphData.edges)) {
      return reply.status(400).send({
        success: false,
        error: "Invalid graph data. Must include nodes and edges arrays.",
      });
    }

    try {
      const graph = await saveAgentGraph(agentId, userId, graphData);

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
    const { userId } = request.user as { userId: string };
    const { agentId } = request.params as { agentId: string };

    try {
      await deleteAgentGraph(agentId, userId);

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
    const { userId } = request.user as { userId: string };
    const { agentId } = request.params as { agentId: string };
    const { templateId } = request.body as { templateId: string };

    if (!templateId) {
      return reply.status(400).send({
        success: false,
        error: "templateId is required",
      });
    }

    try {
      const graph = await applyGraphTemplate(agentId, userId, templateId);

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

  // Compile graph for execution
  app.post("/agents/:agentId/graph/compile", async (request, reply) => {
    const { userId } = request.user as { userId: string };
    const { agentId } = request.params as { agentId: string };

    try {
      const compiled = await compileGraph(agentId, userId);

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
    const graphData = request.body as AgentGraphData;

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
