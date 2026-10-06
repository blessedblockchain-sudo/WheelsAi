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
 * The agent, scoped by ORG like every other agent route. These lookups used
 * to go through org membership of a user id, and an API key has no user: every
 * key-authenticated caller got "not found" for its own agents.
 */
async function assertAgentInOrg(agentId: string, orgId: string) {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, orgId },
    select: { id: true, tools: true },
  });
  if (!agent) {
    throw new Error("Agent not found or access denied");
  }
  return agent;
}

/** Names of the tools enabled on an agent (Agent.tools), org-scoped. */
export async function getAgentEnabledToolNames(agentId: string, orgId: string): Promise<string[]> {
  const agent = await assertAgentInOrg(agentId, orgId);
  return Array.isArray(agent.tools)
    ? (agent.tools as Array<{ name?: unknown }>)
        .map((t) => t?.name)
        .filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * Tool nodes a run would refuse because the agent has not enabled the tool.
 * A warning rather than an error: the graph is well-formed and becomes
 * runnable the moment the tool is enabled, which the builder offers in place.
 */
export function toolNodeWarnings(
  nodes: Array<Pick<GraphNode, "type" | "data">>,
  enabledTools: string[],
): string[] {
  const warnings: string[] = [];
  for (const node of nodes) {
    if (node.type !== "tool") continue;
    const config = node.data?.config ?? {};
    // The same keys, in the same order, as the interpreter's tool node.
    const key = [config.toolName, config.tool, config.skill].find(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    if (key && !enabledTools.includes(key)) {
      warnings.push(
        `Tool node "${node.data.label}" uses "${key}", which is not enabled on this agent - a run will refuse it until the tool is enabled`,
      );
    }
  }
  return warnings;
}

/**
 * Api nodes a run would fail because they have no URL. An error, not a
 * warning: nothing short of editing the node makes it runnable. It is also
 * how a marketplace copy arrives, because a publisher's request details are
 * not copied (marketplaceClone.ts), so the builder names the node to fill in.
 */
export function apiNodeErrors(nodes: Array<Pick<GraphNode, "type" | "data">>): string[] {
  const errors: string[] = [];
  for (const node of nodes) {
    if (node.type !== "api") continue;
    const url = node.data?.config?.url;
    if (typeof url !== "string" || url.trim() === "") {
      errors.push(`API node "${node.data?.label}" has no URL configured`);
    }
  }
  return errors;
}

/**
 * Get agent graph
 */
export async function getAgentGraph(agentId: string, orgId: string) {
  await assertAgentInOrg(agentId, orgId);

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
  orgId: string,
  graphData: AgentGraphData
) {
  await assertAgentInOrg(agentId, orgId);

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
export async function deleteAgentGraph(agentId: string, orgId: string) {
  await assertAgentInOrg(agentId, orgId);

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

// NOTE: llm nodes here deliberately carry NO `model`. The interpreter
// falls back to the agent's own configured model, then to the first
// available free model (buildGraphInterpreterDeps). These templates used
// to ship `model: "default"`, which is not a model id — every template
// applied from the builder failed on its first run with
// "Unknown model provider: default", which is the most obvious click on
// that screen.
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
        position: { x: 350, y: 200 },
        data: {
          label: "Vector Search",
          // Pick the knowledge base to search in the node's properties: a
          // template cannot know your knowledge base id, so the first run
          // fails with "pick a knowledge base" until you do.
          config: {
            topK: 5,
          },
        },
      },
      {
        id: "transform_1",
        type: "transform",
        position: { x: 600, y: 200 },
        data: {
          label: "Format Context",
          config: {
            template: "Context:\n{{value}}\n\nQuestion: {{nodes.input_1}}",
          },
        },
      },
      {
        id: "llm_1",
        type: "llm",
        position: { x: 850, y: 200 },
        data: {
          label: "Generate Answer",
          config: {
            temperature: 0.3,
            systemPrompt: "Answer based on the provided context.",
          },
        },
      },
      {
        id: "output_1",
        type: "output",
        position: { x: 1100, y: 200 },
        data: {
          label: "Response",
          config: { outputType: "text" },
        },
      },
    ],
    edges: [
      // One path: the interpreter follows a single edge out of every node
      // except a parallel node, so retrieval feeds the prompt in sequence
      // and the original question comes back via {{nodes.input_1}}.
      { id: "e1", source: "input_1", target: "memory_1" },
      { id: "e2", source: "memory_1", target: "transform_1" },
      { id: "e3", source: "transform_1", target: "llm_1" },
      { id: "e4", source: "llm_1", target: "output_1" },
    ],
    viewport: { x: 0, y: 0, zoom: 0.8 },
  },
  // Routes a request to the calculator when it needs arithmetic, otherwise
  // answers directly; a merge joins whichever branch ran. Uses only tools that
  // need no provider key, so it runs on any server.
  tool_agent: {
    nodes: [
      {
        id: "input_1",
        type: "input",
        position: { x: 50, y: 200 },
        data: { label: "User Request", config: { inputType: "text" } },
      },
      {
        id: "llm_1",
        type: "llm",
        position: { x: 280, y: 200 },
        data: {
          label: "Plan Action",
          config: {
            temperature: 0,
            // This llm node is the planner only: no tools, so it cannot
            // answer by calling one itself.
            tools: [],
            systemPrompt:
              "If the user's request needs arithmetic, reply with ONLY the arithmetic expression (for example 17*23). Otherwise reply with exactly NONE.",
          },
        },
      },
      {
        id: "condition_1",
        type: "condition",
        position: { x: 510, y: 200 },
        data: {
          label: "Needs Calculator?",
          config: { op: "not_contains", value: "NONE" },
        },
      },
      {
        id: "tool_calc",
        type: "tool",
        position: { x: 740, y: 100 },
        data: { label: "Calculator", config: { toolName: "calculator" } },
      },
      {
        id: "transform_calc",
        type: "transform",
        position: { x: 970, y: 100 },
        data: {
          label: "Frame Result",
          config: {
            template:
              "The user asked: {{nodes.input_1}}\nThe calculator returned: {{value}}\nAnswer the user.",
          },
        },
      },
      {
        id: "llm_calc",
        type: "llm",
        position: { x: 1200, y: 100 },
        data: { label: "Explain Result", config: { temperature: 0.3, tools: [] } },
      },
      {
        id: "transform_direct",
        type: "transform",
        position: { x: 740, y: 300 },
        data: { label: "Original Question", config: { template: "{{nodes.input_1}}" } },
      },
      {
        id: "llm_direct",
        type: "llm",
        position: { x: 970, y: 300 },
        data: { label: "Answer Directly", config: { temperature: 0.7 } },
      },
      {
        id: "merge_1",
        type: "merge",
        position: { x: 1430, y: 200 },
        data: { label: "Whichever Ran", config: { mode: "join" } },
      },
      {
        id: "output_1",
        type: "output",
        position: { x: 1660, y: 200 },
        data: { label: "Response", config: { outputType: "text" } },
      },
    ],
    edges: [
      { id: "e1", source: "input_1", target: "llm_1" },
      { id: "e2", source: "llm_1", target: "condition_1" },
      { id: "e3", source: "condition_1", target: "tool_calc", sourceHandle: "true" },
      { id: "e4", source: "condition_1", target: "transform_direct", sourceHandle: "false" },
      { id: "e5", source: "tool_calc", target: "transform_calc" },
      { id: "e6", source: "transform_calc", target: "llm_calc" },
      { id: "e7", source: "llm_calc", target: "merge_1" },
      { id: "e8", source: "transform_direct", target: "llm_direct" },
      { id: "e9", source: "llm_direct", target: "merge_1" },
      { id: "e10", source: "merge_1", target: "output_1" },
    ],
    viewport: { x: 0, y: 0, zoom: 0.6 },
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
  orgId: string,
  templateId: string
) {
  const template = graphTemplates[templateId];
  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  return saveAgentGraph(agentId, orgId, template);
}

function getTemplateDescription(key: string): string {
  const descriptions: Record<string, string> = {
    simple_chat: "Basic chat agent with single LLM node",
    rag_pipeline: "Retrieval-augmented generation with vector search",
    tool_agent: "Routes arithmetic to the calculator tool, answers the rest directly, then merges",
  };
  return descriptions[key] || "Custom agent workflow";
}

// ============================================
// Graph Compilation (for execution)
// ============================================

/**
 * Compile graph to executable format
 */
export async function compileGraph(agentId: string, orgId: string) {
  const graph = await getAgentGraph(agentId, orgId);

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
