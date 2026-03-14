import { prisma } from "@wheelsai/db";

// ============================================
// Node Types for Visual Agent Builder
// ============================================

export type NodeType =
  | "input" // User input/trigger
  | "output" // Agent response
  | "llm" // LLM inference call
  | "tool" // External tool/function call
  | "condition" // Conditional branching
  | "loop" // Loop/iteration
  | "memory" // Memory read/write
  | "transform" // Data transformation
  | "api" // External API call
  | "code" // Custom code execution
  | "delay" // Wait/delay
  | "parallel" // Parallel execution
  | "merge" // Merge parallel branches;

export interface GraphNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: {
    label: string;
    config: Record<string, any>;
    inputs?: string[];
    outputs?: string[];
  };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  animated?: boolean;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface AgentGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport?: GraphViewport;
}

// ============================================
// Graph CRUD Operations
// ============================================

/**
 * Get agent graph
 */
export async function getAgentGraph(agentId: string, userId: string) {
  // Verify ownership
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      org: {
        members: {
          some: { userId },
        },
      },
    },
  });

  if (!agent) {
    throw new Error("Agent not found or access denied");
  }

  const graph = await prisma.agentGraph.findUnique({
    where: { agentId },
  });

  if (!graph) {
    // Return default empty graph
    return {
      agentId,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      version: 0,
    };
  }

  return graph;
}

/**
 * Save agent graph
 */
export async function saveAgentGraph(
  agentId: string,
  userId: string,
  graphData: AgentGraphData
) {
  // Verify ownership
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      org: {
        members: {
          some: { userId },
        },
      },
    },
  });

  if (!agent) {
    throw new Error("Agent not found or access denied");
  }

  // Validate graph structure
  validateGraph(graphData);

  const graph = await prisma.agentGraph.upsert({
    where: { agentId },
    create: {
      agentId,
      nodes: graphData.nodes as any,
      edges: graphData.edges as any,
      viewport: graphData.viewport as any,
    },
    update: {
      nodes: graphData.nodes as any,
      edges: graphData.edges as any,
      viewport: graphData.viewport as any,
      version: { increment: 1 },
    },
  });

  return graph;
}

/**
 * Delete agent graph
 */
export async function deleteAgentGraph(agentId: string, userId: string) {
  // Verify ownership
  const agent = await prisma.agent.findFirst({
    where: {
      id: agentId,
      org: {
        members: {
          some: { userId },
        },
      },
    },
  });

  if (!agent) {
    throw new Error("Agent not found or access denied");
  }

  return prisma.agentGraph.delete({
    where: { agentId },
  });
}

/**
 * Validate graph structure
 */
function validateGraph(graph: AgentGraphData) {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  // Check that all edges reference existing nodes
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source)) {
      throw new Error(`Edge references non-existent source node: ${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      throw new Error(`Edge references non-existent target node: ${edge.target}`);
    }
  }

  // Check for required nodes in a complete graph
  const nodeTypes = new Set(graph.nodes.map((n) => n.type));

  // A valid runnable graph needs at least input and output
  if (graph.nodes.length > 0 && !nodeTypes.has("input")) {
    // Warning: no input node (might be WIP)
  }

  return true;
}

// ============================================
// Graph Templates
// ============================================

export const graphTemplates: Record<string, AgentGraphData> = {
  simple_chat: {
    nodes: [
      {
        id: "input_1",
        type: "input",
        position: { x: 100, y: 200 },
        data: {
          label: "User Input",
          config: { inputType: "text" },
        },
      },
      {
        id: "llm_1",
        type: "llm",
        position: { x: 350, y: 200 },
        data: {
          label: "LLM Response",
          config: {
            model: "default",
            temperature: 0.7,
            systemPrompt: "You are a helpful assistant.",
          },
        },
      },
      {
        id: "output_1",
        type: "output",
        position: { x: 600, y: 200 },
        data: {
          label: "Response",
          config: { outputType: "text" },
        },
      },
    ],
    edges: [
      { id: "e1", source: "input_1", target: "llm_1" },
      { id: "e2", source: "llm_1", target: "output_1" },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  },
  rag_pipeline: {
    nodes: [
      {
        id: "input_1",
        type: "input",
        position: { x: 100, y: 200 },
        data: {
          label: "User Query",
          config: { inputType: "text" },
        },
      },
      {
        id: "memory_1",
        type: "memory",
        position: { x: 350, y: 100 },
        data: {
          label: "Vector Search",
          config: {
            operation: "search",
            topK: 5,
          },
        },
      },
      {
        id: "transform_1",
        type: "transform",
        position: { x: 350, y: 300 },
        data: {
          label: "Format Context",
          config: {
            template: "Context:\n{{context}}\n\nQuestion: {{query}}",
          },
        },
      },
      {
        id: "llm_1",
        type: "llm",
        position: { x: 600, y: 200 },
        data: {
          label: "Generate Answer",
          config: {
            model: "default",
            temperature: 0.3,
            systemPrompt: "Answer based on the provided context.",
          },
        },
      },
      {
        id: "output_1",
        type: "output",
        position: { x: 850, y: 200 },
        data: {
          label: "Response",
          config: { outputType: "text" },
        },
      },
    ],
    edges: [
      { id: "e1", source: "input_1", target: "memory_1" },
      { id: "e2", source: "input_1", target: "transform_1" },
      { id: "e3", source: "memory_1", target: "transform_1" },
      { id: "e4", source: "transform_1", target: "llm_1" },
      { id: "e5", source: "llm_1", target: "output_1" },
    ],
    viewport: { x: 0, y: 0, zoom: 0.9 },
  },
  tool_agent: {
    nodes: [
      {
        id: "input_1",
        type: "input",
        position: { x: 100, y: 200 },
        data: {
          label: "User Request",
          config: { inputType: "text" },
        },
      },
      {
        id: "llm_1",
        type: "llm",
        position: { x: 350, y: 200 },
        data: {
          label: "Plan Action",
          config: {
            model: "default",
            temperature: 0.5,
            systemPrompt: "Decide which tool to use based on user request.",
          },
        },
      },
      {
        id: "condition_1",
        type: "condition",
        position: { x: 600, y: 200 },
        data: {
          label: "Route by Tool",
          config: {
            conditions: [
              { label: "search", expression: "action == 'search'" },
              { label: "calculate", expression: "action == 'calculate'" },
              { label: "default", expression: "true" },
            ],
          },
        },
      },
      {
        id: "tool_search",
        type: "tool",
        position: { x: 850, y: 100 },
        data: {
          label: "Web Search",
          config: { toolName: "web_search" },
        },
      },
      {
        id: "tool_calc",
        type: "tool",
        position: { x: 850, y: 200 },
        data: {
          label: "Calculator",
          config: { toolName: "calculator" },
        },
      },
      {
        id: "merge_1",
        type: "merge",
        position: { x: 1100, y: 200 },
        data: {
          label: "Merge Results",
          config: {},
        },
      },
      {
        id: "llm_2",
        type: "llm",
        position: { x: 1350, y: 200 },
        data: {
          label: "Format Response",
          config: {
            model: "default",
            temperature: 0.7,
          },
        },
      },
      {
        id: "output_1",
        type: "output",
        position: { x: 1600, y: 200 },
        data: {
          label: "Response",
          config: { outputType: "text" },
        },
      },
    ],
    edges: [
      { id: "e1", source: "input_1", target: "llm_1" },
      { id: "e2", source: "llm_1", target: "condition_1" },
      { id: "e3", source: "condition_1", target: "tool_search", sourceHandle: "search" },
      { id: "e4", source: "condition_1", target: "tool_calc", sourceHandle: "calculate" },
      { id: "e5", source: "condition_1", target: "merge_1", sourceHandle: "default" },
      { id: "e6", source: "tool_search", target: "merge_1" },
      { id: "e7", source: "tool_calc", target: "merge_1" },
      { id: "e8", source: "merge_1", target: "llm_2" },
      { id: "e9", source: "llm_2", target: "output_1" },
    ],
    viewport: { x: 0, y: 0, zoom: 0.7 },
  },
};

/**
 * Get all available templates
 */
export function getGraphTemplates() {
  return Object.entries(graphTemplates).map(([key, graph]) => ({
    id: key,
    name: key.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
    nodeCount: graph.nodes.length,
    description: getTemplateDescription(key),
  }));
}

/**
 * Apply a template to an agent
 */
export async function applyGraphTemplate(
  agentId: string,
  userId: string,
  templateId: string
) {
  const template = graphTemplates[templateId];
  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  return saveAgentGraph(agentId, userId, template);
}

function getTemplateDescription(key: string): string {
  const descriptions: Record<string, string> = {
    simple_chat: "Basic chat agent with single LLM node",
    rag_pipeline: "Retrieval-augmented generation with vector search",
    tool_agent: "Agent with conditional tool routing and merging",
  };
  return descriptions[key] || "Custom agent workflow";
}

// ============================================
// Graph Compilation (for execution)
// ============================================

/**
 * Compile graph to executable format
 */
export async function compileGraph(agentId: string, userId: string) {
  const graph = await getAgentGraph(agentId, userId);

  if (!graph.nodes || (graph.nodes as GraphNode[]).length === 0) {
    throw new Error("Graph is empty");
  }

  const nodes = graph.nodes as GraphNode[];
  const edges = graph.edges as GraphEdge[];

  // Find input nodes (entry points)
  const inputNodes = nodes.filter((n) => n.type === "input");
  if (inputNodes.length === 0) {
    throw new Error("Graph must have at least one input node");
  }

  // Find output nodes (exit points)
  const outputNodes = nodes.filter((n) => n.type === "output");
  if (outputNodes.length === 0) {
    throw new Error("Graph must have at least one output node");
  }

  // Build adjacency list for execution order
  const adjacency: Record<string, string[]> = {};
  for (const node of nodes) {
    adjacency[node.id] = [];
  }
  for (const edge of edges) {
    const targets = adjacency[edge.source] ?? [];
    targets.push(edge.target);
    adjacency[edge.source] = targets;
  }

  // Topological sort for execution order
  const executionOrder = topologicalSort(nodes, adjacency);

  return {
    agentId,
    entryPoints: inputNodes.map((n) => n.id),
    exitPoints: outputNodes.map((n) => n.id),
    executionOrder,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: Object.fromEntries(edges.map((e) => [e.id, e])),
  };
}

function topologicalSort(
  nodes: GraphNode[],
  adjacency: Record<string, string[]>
): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function dfs(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    for (const next of adjacency[nodeId] || []) {
      dfs(next);
    }

    result.unshift(nodeId);
  }

  for (const node of nodes) {
    dfs(node.id);
  }

  return result;
}
