"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Save,
  Play,
  AlertTriangle,
  CheckCircle,
  Trash2,
  Copy,
  LayoutTemplate,
  ZoomIn,
  ZoomOut,
  Maximize,
  Settings,
  Plus,
  X,
  MessageSquare,
  Bot,
  Wrench,
  GitBranch,
  RefreshCw,
  Database,
  Code2,
  Timer,
  GitMerge,
  Layers,
  Zap,
} from "lucide-react";
import {
  agentsApi,
  agentGraphApi,
  knowledgeApi,
  skillsApi,
  type GraphNode,
  type GraphEdge,
  type GraphTemplate,
  type GraphRunResult,
  type KnowledgeBase,
  type Skill,
} from "@/lib/api";
import {
  SkillNotEnabledNote,
  SkillStatusBadge,
  SkillUnavailableNote,
} from "@/components/dashboard/skill-status";

// ---- shared form bits -------------------------------------------------
const INPUT_CLS = "w-full px-3 py-2 bg-background border rounded-lg text-sm";
const AREA_CLS =
  "w-full px-3 py-2 bg-background text-foreground border border-input rounded-lg text-sm resize-none font-mono";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-sm font-medium block mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A JSON object field that tolerates being mid-edit: the draft text is kept
 * locally and only a value that parses as an object is committed.
 */
function JsonObjectField({
  value,
  onCommit,
  rows = 3,
  placeholder,
}: {
  value: Record<string, unknown> | undefined;
  onCommit: (next: Record<string, unknown>) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(() =>
    value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : ""
  );
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <textarea
        value={draft}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          if (text.trim() === "") {
            setError(null);
            onCommit({});
            return;
          }
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              setError(null);
              onCommit(parsed as Record<string, unknown>);
            } else {
              setError("Must be a JSON object");
            }
          } catch {
            setError("Not valid JSON yet");
          }
        }}
        className={AREA_CLS}
      />
      {error && <p className="mt-1 text-xs text-yellow-600 dark:text-yellow-500">{error}</p>}
    </div>
  );
}

const CONDITION_OPS = [
  ["contains", "contains"],
  ["not_contains", "does not contain"],
  ["equals", "equals"],
  ["not_equals", "does not equal"],
  ["exists", "is not empty"],
  ["not_exists", "is empty"],
  ["gt", "is greater than"],
  ["gte", "is at least"],
  ["lt", "is less than"],
  ["lte", "is at most"],
] as const;

/** The branch names an edge leaving each branching node can carry. */
const BRANCH_OPTIONS: Record<string, Array<[string, string]>> = {
  condition: [
    ["true", "If true"],
    ["false", "If false"],
  ],
  loop: [
    ["body", "Loop body (runs per item)"],
    ["done", "After the loop"],
  ],
};

function edgeBranch(edge: GraphEdge): string | undefined {
  const h = edge.sourceHandle?.trim();
  if (h && h !== "output" && h !== "default") return h;
  return edge.label?.trim() || undefined;
}

// Node type definitions with icons and colors
const NODE_TYPES = {
  input: {
    label: "Input",
    icon: MessageSquare,
    color: "bg-green-500",
    description: "User input trigger",
  },
  output: {
    label: "Output",
    icon: Bot,
    color: "bg-blue-500",
    description: "Agent response output",
  },
  llm: {
    label: "LLM",
    icon: Zap,
    color: "bg-purple-500",
    description: "Language model inference",
  },
  tool: {
    label: "Tool",
    icon: Wrench,
    color: "bg-orange-500",
    description: "External tool/function call",
  },
  condition: {
    label: "Condition",
    icon: GitBranch,
    color: "bg-yellow-500",
    description: "Conditional branching",
  },
  loop: {
    label: "Loop",
    icon: RefreshCw,
    color: "bg-cyan-500",
    description: "Loop/iteration",
  },
  memory: {
    label: "Memory",
    icon: Database,
    color: "bg-pink-500",
    description: "Memory read/write",
  },
  transform: {
    label: "Transform",
    icon: Code2,
    color: "bg-indigo-500",
    description: "Data transformation",
  },
  api: {
    label: "API",
    icon: Layers,
    color: "bg-teal-500",
    description: "External API call",
  },
  code: {
    label: "Code",
    icon: Code2,
    color: "bg-slate-500",
    description: "Custom code execution",
  },
  delay: {
    label: "Delay",
    icon: Timer,
    color: "bg-gray-500",
    description: "Wait/delay",
  },
  parallel: {
    label: "Parallel",
    icon: Layers,
    color: "bg-emerald-500",
    description: "Parallel execution",
  },
  merge: {
    label: "Merge",
    icon: GitMerge,
    color: "bg-rose-500",
    description: "Merge parallel branches",
  },
} as const;

type NodeType = keyof typeof NODE_TYPES;

interface DragState {
  isDragging: boolean;
  nodeType: NodeType | null;
  startX: number;
  startY: number;
}

interface SelectedNode {
  node: GraphNode;
  index: number;
}

export default function AgentBuilderPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.id as string;
  const canvasRef = useRef<HTMLDivElement>(null);

  const [agent, setAgent] = useState<any>(null);
  // Availability of skills (tool and code nodes) and the knowledge bases a
  // memory node can search. Both are best-effort: the canvas works without.
  const [skills, setSkills] = useState<Skill[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null);
  const [templates, setTemplates] = useState<GraphTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [validation, setValidation] = useState<{
    valid: boolean;
    issues: Array<{ type: "error" | "warning"; message: string }>;
  } | null>(null);
  const [connectionStart, setConnectionStart] = useState<{
    nodeId: string;
    handle: string;
  } | null>(null);
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    nodeType: null,
    startX: 0,
    startY: 0,
  });
  const [nodeBeingDragged, setNodeBeingDragged] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    loadData();
  }, [agentId]);

  async function loadData() {
    try {
      const [agentRes, graphRes, templatesRes] = await Promise.all([
        agentsApi.get(agentId),
        agentGraphApi.getGraph(agentId),
        agentGraphApi.getTemplates(),
      ]);

      setAgent(agentRes.agent);
      setNodes(graphRes.data.nodes || []);
      setEdges(graphRes.data.edges || []);
      if (graphRes.data.viewport) {
        setViewport(graphRes.data.viewport);
      }
      setTemplates(templatesRes.data);
      skillsApi
        .list(agentId)
        .then((res) => setSkills(res.skills))
        .catch(() => setSkills([]));
      knowledgeApi
        .list({ limit: 100 })
        .then((res) => setKnowledgeBases(res.knowledgeBases))
        .catch(() => setKnowledgeBases([]));
    } catch (error) {
      console.error("Failed to load builder:", error);
    } finally {
      setLoading(false);
    }
  }

  // --- Tools enabled on the agent ---
  // A tool node may only run a tool the agent itself has enabled; the run
  // refuses anything else. So the builder only offers enabled tools, and
  // enabling one more is a click here rather than a trip to the API.
  const [enablingTool, setEnablingTool] = useState<string | null>(null);
  const [enableToolError, setEnableToolError] = useState<string | null>(null);
  const agentTools: Array<{ name: string; [key: string]: unknown }> = Array.isArray(agent?.tools)
    ? agent.tools.filter((t: any) => typeof t?.name === "string")
    : [];
  const enabledToolNames = new Set(agentTools.map((t) => t.name));
  const enabledSkills = skills.filter((s) => enabledToolNames.has(s.key));
  const notEnabledSkills = skills.filter((s) => !enabledToolNames.has(s.key));
  // Tools the canvas uses that a run would refuse, each once.
  const refusedToolSkills = notEnabledSkills.filter((s) =>
    nodes.some((n) => n.type === "tool" && n.data.config.toolName === s.key)
  );

  async function enableTool(key: string) {
    const skill = skills.find((s) => s.key === key);
    if (!skill || !agent || enabledToolNames.has(key)) return;
    const tools = [
      ...agentTools,
      { name: key, type: "function" as const, description: skill.description },
    ];
    setEnablingTool(key);
    setEnableToolError(null);
    try {
      const res = await agentsApi.update(agentId, { tools: tools as any });
      setAgent((prev: any) => ({ ...prev, ...res.agent, tools: res.agent?.tools ?? tools }));
    } catch (error) {
      setEnableToolError(
        error instanceof Error ? error.message : `Could not enable ${skill.name}`
      );
    } finally {
      setEnablingTool(null);
    }
  }

  // --- Run (W2 linear interpreter) ---
  const [running, setRunning] = useState(false);
  const [runInput, setRunInput] = useState("");
  const [runResult, setRunResult] = useState<GraphRunResult | null>(null);
  const [showRunPanel, setShowRunPanel] = useState(false);

  async function handleRun() {
    setRunning(true);
    setShowRunPanel(true);
    setRunResult(null);
    try {
      // Save first: the server runs the SAVED graph, so running an
      // unsaved canvas would execute something the author isn't looking at.
      await agentGraphApi.saveGraph(agentId, { nodes, edges, viewport });
      const res = await agentGraphApi.runGraph(agentId, runInput);
      setRunResult(res.data);
    } catch (error) {
      setRunResult({
        executionId: "",
        status: "failed",
        output: null,
        error: error instanceof Error ? error.message : "Run failed",
        trace: [],
        durationMs: 0,
      });
    } finally {
      setRunning(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await agentGraphApi.saveGraph(agentId, { nodes, edges, viewport });
      const validationRes = await agentGraphApi.validateGraph(agentId, {
        nodes,
        edges,
      });
      setValidation(validationRes.data);
    } catch (error) {
      console.error("Failed to save:", error);
    } finally {
      setSaving(false);
    }
  }

  async function handleApplyTemplate(templateId: string) {
    try {
      const result = await agentGraphApi.applyTemplate(agentId, templateId);
      setNodes(result.data.nodes || []);
      setEdges(result.data.edges || []);
      if (result.data.viewport) {
        setViewport(result.data.viewport);
      }
      setShowTemplates(false);
    } catch (error) {
      console.error("Failed to apply template:", error);
    }
  }

  const addNode = useCallback(
    (type: NodeType, x: number, y: number) => {
      const newNode: GraphNode = {
        id: `${type}_${Date.now()}`,
        type,
        position: { x, y },
        data: {
          label: NODE_TYPES[type].label,
          config: getDefaultConfig(type),
        },
      };
      setNodes((prev) => [...prev, newNode]);
      setSelectedNode({ node: newNode, index: nodes.length });
    },
    [nodes.length]
  );

  // Every key here is one the interpreter reads (services/graphInterpreter.ts).
  function getDefaultConfig(type: NodeType): Record<string, any> {
    switch (type) {
      case "llm":
        // No `model`: the node uses the agent's own model unless one is set.
        return { temperature: 0.7, systemPrompt: "" };
      case "tool":
        return { toolName: "", input: "" };
      case "condition":
        return { op: "contains", value: "" };
      case "memory":
        return { knowledgeBaseId: "", topK: 4 };
      case "transform":
        return { template: "{{value}}" };
      case "api":
        return { url: "", method: "GET", headers: {} };
      case "code":
        return { language: "python", code: "" };
      case "delay":
        return { ms: 1000 };
      case "loop":
        return { mode: "list", format: "json", maxIterations: 20, collect: "array" };
      case "parallel":
        return { maxConcurrency: 4 };
      case "merge":
        return { mode: "array" };
      default:
        return {};
    }
  }

  function handleNodeDragStart(
    e: React.MouseEvent,
    nodeId: string,
    nodeIndex: number
  ) {
    e.stopPropagation();
    const node = nodes[nodeIndex];
    if (!node) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    setNodeBeingDragged(nodeId);
    setDragOffset({
      x: e.clientX - rect.left - node.position.x * viewport.zoom - viewport.x,
      y: e.clientY - rect.top - node.position.y * viewport.zoom - viewport.y,
    });
  }

  function handleCanvasMouseMove(e: React.MouseEvent) {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();

    if (nodeBeingDragged) {
      const x =
        (e.clientX - rect.left - dragOffset.x - viewport.x) / viewport.zoom;
      const y =
        (e.clientY - rect.top - dragOffset.y - viewport.y) / viewport.zoom;

      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeBeingDragged ? { ...n, position: { x, y } } : n
        )
      );
    }
  }

  function handleCanvasMouseUp() {
    setNodeBeingDragged(null);
  }

  function handlePaletteNodeDragStart(e: React.DragEvent, type: NodeType) {
    e.dataTransfer.setData("nodeType", type);
    setDragState({
      isDragging: true,
      nodeType: type,
      startX: e.clientX,
      startY: e.clientY,
    });
  }

  function handleCanvasDrop(e: React.DragEvent) {
    e.preventDefault();
    const type = e.dataTransfer.getData("nodeType") as NodeType;
    if (!type || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - viewport.x) / viewport.zoom;
    const y = (e.clientY - rect.top - viewport.y) / viewport.zoom;

    addNode(type, x, y);
    setDragState({ isDragging: false, nodeType: null, startX: 0, startY: 0 });
  }

  function handleCanvasDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleNodeClick(node: GraphNode, index: number) {
    setSelectedNode({ node, index });
  }

  function handleDeleteNode(nodeId: string) {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEdges((prev) =>
      prev.filter((e) => e.source !== nodeId && e.target !== nodeId)
    );
    setSelectedNode(null);
  }

  function handleConnectionStart(nodeId: string, handle: string) {
    setConnectionStart({ nodeId, handle });
  }

  function handleConnectionEnd(nodeId: string, handle: string) {
    if (connectionStart && connectionStart.nodeId !== nodeId) {
      const newEdge: GraphEdge = {
        id: `e_${connectionStart.nodeId}_${nodeId}_${Date.now()}`,
        source: connectionStart.nodeId,
        target: nodeId,
        sourceHandle: connectionStart.handle,
        targetHandle: handle,
      };
      setEdges((prev) => [...prev, newEdge]);
    }
    setConnectionStart(null);
  }

  function handleDeleteEdge(edgeId: string) {
    setEdges((prev) => prev.filter((e) => e.id !== edgeId));
  }

  function updateNodeConfig(key: string, value: any) {
    if (!selectedNode) return;

    setNodes((prev) =>
      prev.map((n, i) =>
        i === selectedNode.index
          ? {
              ...n,
              data: {
                ...n.data,
                label: key === "label" ? value : n.data.label,
                config:
                  key === "label"
                    ? n.data.config
                    : { ...n.data.config, [key]: value },
              },
            }
          : n
      )
    );

    // Update selected node reference
    setSelectedNode((prev) =>
      prev
        ? {
            ...prev,
            node: {
              ...prev.node,
              data: {
                ...prev.node.data,
                label: key === "label" ? value : prev.node.data.label,
                config:
                  key === "label"
                    ? prev.node.data.config
                    : { ...prev.node.data.config, [key]: value },
              },
            },
          }
        : null
    );
  }

  function handleZoom(delta: number) {
    setViewport((prev) => ({
      ...prev,
      zoom: Math.max(0.25, Math.min(2, prev.zoom + delta)),
    }));
  }

  function handleResetView() {
    setViewport({ x: 0, y: 0, zoom: 1 });
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    // `relative` anchors the run panel below; without it the panel would
    // position against the viewport by luck rather than by design.
    <div className="relative h-screen flex flex-col bg-background">
      {/* Header */}
      <div className="h-14 border-b flex items-center justify-between px-4 bg-card">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push(`/dashboard/agents/${agentId}`)}
            className="p-2 hover:bg-accent rounded-lg transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="font-semibold">{agent?.name || "Agent"} - Visual Builder</h1>
            <p className="text-xs text-muted-foreground">
              Drag nodes from the palette to build your agent workflow
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {validation && (
            <div
              className={`flex items-center gap-1 px-2 py-1 rounded text-sm ${
                validation.valid
                  ? "bg-green-500/10 text-green-500"
                  : "bg-yellow-500/10 text-yellow-500"
              }`}
            >
              {validation.valid ? (
                <CheckCircle className="h-4 w-4" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              {validation.valid
                ? "Valid"
                : `${validation.issues.length} issues`}
            </div>
          )}

          <button
            onClick={() => setShowTemplates(true)}
            className="flex items-center gap-2 px-3 py-1.5 border rounded-lg hover:bg-accent transition-colors text-sm"
          >
            <LayoutTemplate className="h-4 w-4" />
            Templates
          </button>

          <button
            onClick={handleRun}
            disabled={running || nodes.length === 0}
            title={nodes.length === 0 ? "Add nodes to run this graph" : "Save and run this graph"}
            className="flex items-center gap-2 px-3 py-1.5 border rounded-lg hover:bg-accent transition-colors text-sm disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            {running ? "Running..." : "Run"}
          </button>

          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Node Palette */}
        <div className="w-56 border-r bg-card p-3 overflow-y-auto">
          <h3 className="text-sm font-semibold mb-3">Node Palette</h3>
          <div className="space-y-2">
            {(Object.entries(NODE_TYPES) as [NodeType, typeof NODE_TYPES[NodeType]][]).map(
              ([type, config]) => {
                const Icon = config.icon;
                return (
                  <div
                    key={type}
                    draggable
                    onDragStart={(e) => handlePaletteNodeDragStart(e, type)}
                    className="flex items-center gap-2 p-2 bg-background border rounded-lg cursor-grab hover:border-primary transition-colors"
                  >
                    <div
                      className={`p-1.5 rounded ${config.color} text-white`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{config.label}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {config.description}
                      </div>
                    </div>
                  </div>
                );
              }
            )}
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 relative overflow-hidden">
          {/* Zoom Controls */}
          <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-card border rounded-lg p-1">
            <button
              onClick={() => handleZoom(-0.1)}
              className="p-1.5 hover:bg-accent rounded transition-colors"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="text-xs w-12 text-center">
              {Math.round(viewport.zoom * 100)}%
            </span>
            <button
              onClick={() => handleZoom(0.1)}
              className="p-1.5 hover:bg-accent rounded transition-colors"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              onClick={handleResetView}
              className="p-1.5 hover:bg-accent rounded transition-colors"
            >
              <Maximize className="h-4 w-4" />
            </button>
          </div>

          <div
            ref={canvasRef}
            className="w-full h-full bg-[url('/grid.svg')] bg-repeat cursor-crosshair"
            style={{
              backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
              backgroundPosition: `${viewport.x}px ${viewport.y}px`,
            }}
            onDrop={handleCanvasDrop}
            onDragOver={handleCanvasDragOver}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
            onClick={() => setSelectedNode(null)}
          >
            {/* SVG for edges */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                transformOrigin: "0 0",
              }}
            >
              <defs>
                <marker
                  id="arrowhead"
                  markerWidth="10"
                  markerHeight="7"
                  refX="9"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon
                    points="0 0, 10 3.5, 0 7"
                    fill="currentColor"
                    className="text-muted-foreground"
                  />
                </marker>
              </defs>
              {edges.map((edge) => {
                const sourceNode = nodes.find((n) => n.id === edge.source);
                const targetNode = nodes.find((n) => n.id === edge.target);
                if (!sourceNode || !targetNode) return null;

                const x1 = sourceNode.position.x + 100;
                const y1 = sourceNode.position.y + 30;
                const x2 = targetNode.position.x;
                const y2 = targetNode.position.y + 30;

                const midX = (x1 + x2) / 2;

                return (
                  <g key={edge.id}>
                    <path
                      d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="text-muted-foreground"
                      markerEnd="url(#arrowhead)"
                    />
                    {edgeBranch(edge) && (
                      <text
                        x={midX}
                        y={(y1 + y2) / 2 - 6}
                        textAnchor="middle"
                        className="fill-foreground text-[11px] font-medium"
                      >
                        {edgeBranch(edge)}
                      </text>
                    )}
                    <path
                      d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="20"
                      className="pointer-events-auto cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteEdge(edge.id);
                      }}
                    />
                  </g>
                );
              })}
            </svg>

            {/* Nodes */}
            {nodes.map((node, index) => {
              const typeConfig = NODE_TYPES[node.type as NodeType];
              const Icon = typeConfig?.icon || Bot;
              const isSelected = selectedNode?.node.id === node.id;

              return (
                <div
                  key={node.id}
                  className={`absolute w-[200px] bg-card border-2 rounded-lg shadow-lg cursor-move transition-shadow ${
                    isSelected
                      ? "border-primary shadow-primary/20"
                      : "border-border hover:border-muted-foreground"
                  }`}
                  style={{
                    left: node.position.x * viewport.zoom + viewport.x,
                    top: node.position.y * viewport.zoom + viewport.y,
                    transform: `scale(${viewport.zoom})`,
                    transformOrigin: "top left",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNodeClick(node, index);
                  }}
                  onMouseDown={(e) => handleNodeDragStart(e, node.id, index)}
                >
                  {/* Node Header */}
                  <div
                    className={`flex items-center gap-2 px-3 py-2 rounded-t-lg ${typeConfig?.color || "bg-gray-500"} text-white`}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="text-sm font-medium truncate flex-1">
                      {node.data.label}
                    </span>
                  </div>

                  {/* Node Body */}
                  <div className="p-2 text-xs text-muted-foreground">
                    {node.type === "llm" && node.data.config.systemPrompt && (
                      <div className="truncate">
                        {node.data.config.systemPrompt.slice(0, 30)}...
                      </div>
                    )}
                    {node.type === "tool" && node.data.config.toolName && (
                      <div>
                        Tool: {node.data.config.toolName}
                        {refusedToolSkills.some(
                          (s) => s.key === node.data.config.toolName
                        ) && (
                          <span className="text-yellow-600 dark:text-yellow-500">
                            {" "}
                            · not enabled
                          </span>
                        )}
                      </div>
                    )}
                    {node.type === "condition" && (
                      <div className="truncate">
                        {node.data.config.op
                          ? `${node.data.config.op} ${node.data.config.value ?? ""}`
                          : "Not configured"}
                      </div>
                    )}
                    {node.type === "api" && node.data.config.url && (
                      <div className="truncate">
                        {node.data.config.method || "GET"} {node.data.config.url}
                      </div>
                    )}
                    {node.type === "loop" && (
                      <div>
                        {node.data.config.mode === "count"
                          ? `${node.data.config.count ?? "?"} times`
                          : "Per list item"}
                      </div>
                    )}
                    {!["llm", "tool", "condition", "api", "loop"].includes(node.type) && (
                      <div className="text-muted-foreground/50">
                        {typeConfig?.description}
                      </div>
                    )}
                  </div>

                  {/* Connection Points */}
                  <div
                    className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 bg-background border-2 border-primary rounded-full cursor-crosshair hover:scale-125 transition-transform"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleConnectionEnd(node.id, "input");
                    }}
                  />
                  <div
                    className="absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 w-3 h-3 bg-background border-2 border-primary rounded-full cursor-crosshair hover:scale-125 transition-transform"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleConnectionStart(node.id, "output");
                    }}
                  />
                </div>
              );
            })}

            {/* Empty state */}
            {nodes.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <Plus className="h-12 w-12 mx-auto mb-3 opacity-20" />
                  <p className="text-lg font-medium">No nodes yet</p>
                  <p className="text-sm">
                    Drag nodes from the palette or use a template
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Properties Panel */}
        {selectedNode && (
          <div className="w-72 border-l bg-card p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold">Node Properties</h3>
              <button
                onClick={() => handleDeleteNode(selectedNode.node.id)}
                className="p-1.5 text-destructive hover:bg-destructive/10 rounded transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Label */}
              <div>
                <label className="text-sm font-medium block mb-1">Label</label>
                <input
                  type="text"
                  value={selectedNode.node.data.label}
                  onChange={(e) => updateNodeConfig("label", e.target.value)}
                  className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
                />
              </div>

              {/* Type-specific config: every field below is one the interpreter reads. */}
              {selectedNode.node.type === "llm" && (
                <>
                  <Field
                    label="Model"
                    hint="Leave empty to use this agent's own model."
                  >
                    <input
                      type="text"
                      value={selectedNode.node.data.config.model || ""}
                      onChange={(e) => updateNodeConfig("model", e.target.value || undefined)}
                      placeholder="e.g. free/groq/llama-3.3-70b"
                      className={INPUT_CLS}
                    />
                  </Field>
                  <Field label="Temperature">
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={selectedNode.node.data.config.temperature ?? 0.7}
                      onChange={(e) =>
                        updateNodeConfig("temperature", parseFloat(e.target.value))
                      }
                      className={INPUT_CLS}
                    />
                  </Field>
                  <Field label="System Prompt">
                    <textarea
                      value={selectedNode.node.data.config.systemPrompt || ""}
                      onChange={(e) => updateNodeConfig("systemPrompt", e.target.value)}
                      rows={4}
                      className="w-full px-3 py-2 bg-background text-foreground border border-input rounded-lg text-sm resize-none"
                      placeholder="You are a helpful assistant..."
                    />
                  </Field>
                  <p className="text-xs text-muted-foreground">
                    The node can use the tools enabled on this agent.
                  </p>
                </>
              )}

              {selectedNode.node.type === "tool" && (
                <>
                  <Field label="Tool">
                    <select
                      value={selectedNode.node.data.config.toolName || ""}
                      onChange={(e) => updateNodeConfig("toolName", e.target.value)}
                      className={INPUT_CLS}
                    >
                      <option value="">Select a tool...</option>
                      {enabledSkills.map((skill) => (
                        <option key={skill.key} value={skill.key}>
                          {skill.name}
                          {skill.available ? "" : " — needs configuration"}
                        </option>
                      ))}
                      {/* Listed so they can be found, not chosen: a run
                          refuses a tool the agent has not enabled. */}
                      {notEnabledSkills.length > 0 && (
                        <optgroup label="Not enabled on this agent">
                          {notEnabledSkills.map((skill) => (
                            <option key={skill.key} value={skill.key} disabled>
                              {skill.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </Field>
                  {(() => {
                    const chosen = skills.find(
                      (s) => s.key === selectedNode.node.data.config.toolName
                    );
                    return chosen ? (
                      <>
                        <div className="rounded-lg border p-2 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">{chosen.description}</span>
                            <SkillStatusBadge skill={chosen} />
                          </div>
                          <SkillUnavailableNote skill={chosen} />
                        </div>
                        {!enabledToolNames.has(chosen.key) && (
                          <SkillNotEnabledNote
                            skill={chosen}
                            onEnable={() => enableTool(chosen.key)}
                            enabling={enablingTool === chosen.key}
                          />
                        )}
                      </>
                    ) : null;
                  })()}
                  {notEnabledSkills.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      <div className="mb-1">Enable another tool on this agent:</div>
                      <div className="flex flex-wrap gap-1">
                        {notEnabledSkills.map((skill) => (
                          <button
                            key={skill.key}
                            type="button"
                            onClick={() => enableTool(skill.key)}
                            disabled={enablingTool !== null}
                            className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-50"
                          >
                            {enablingTool === skill.key ? "Enabling..." : `+ ${skill.name}`}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {enableToolError && (
                    <p className="text-xs text-red-500">{enableToolError}</p>
                  )}
                  <Field
                    label="Input"
                    hint={
                      <>
                        Empty: the incoming value goes to the tool&apos;s main text
                        argument. Or a JSON object of arguments, where values may use{" "}
                        <code>{"{{value}}"}</code> and <code>{"{{nodes.<id>}}"}</code>.
                      </>
                    }
                  >
                    <textarea
                      value={
                        typeof selectedNode.node.data.config.input === "string"
                          ? selectedNode.node.data.config.input
                          : selectedNode.node.data.config.input
                            ? JSON.stringify(selectedNode.node.data.config.input)
                            : ""
                      }
                      onChange={(e) => updateNodeConfig("input", e.target.value)}
                      rows={3}
                      placeholder='{"query": "{{value}}"}'
                      className={AREA_CLS}
                    />
                  </Field>
                </>
              )}

              {selectedNode.node.type === "condition" && (
                <>
                  <Field
                    label="Check"
                    hint="Tests the text flowing into this node. Connect each outgoing line below and label it If true or If false."
                  >
                    <select
                      value={selectedNode.node.data.config.op || "contains"}
                      onChange={(e) => updateNodeConfig("op", e.target.value)}
                      className={INPUT_CLS}
                    >
                      {CONDITION_OPS.map(([op, label]) => (
                        <option key={op} value={op}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {!["exists", "not_exists"].includes(
                    selectedNode.node.data.config.op || "contains"
                  ) && (
                    <Field label="Value">
                      <input
                        type="text"
                        value={selectedNode.node.data.config.value ?? ""}
                        onChange={(e) => updateNodeConfig("value", e.target.value)}
                        className={INPUT_CLS}
                      />
                    </Field>
                  )}
                </>
              )}

              {selectedNode.node.type === "memory" && (
                <>
                  <Field label="Knowledge base" hint="The node searches it with the incoming text.">
                    <select
                      value={selectedNode.node.data.config.knowledgeBaseId || ""}
                      onChange={(e) => updateNodeConfig("knowledgeBaseId", e.target.value)}
                      className={INPUT_CLS}
                    >
                      <option value="">Select a knowledge base...</option>
                      {knowledgeBases.map((kb) => (
                        <option key={kb.id} value={kb.id}>
                          {kb.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Passages to retrieve">
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={selectedNode.node.data.config.topK ?? 4}
                      onChange={(e) => updateNodeConfig("topK", parseInt(e.target.value) || 4)}
                      className={INPUT_CLS}
                    />
                  </Field>
                </>
              )}

              {selectedNode.node.type === "transform" && (
                <Field
                  label="Template"
                  hint={
                    <>
                      Text with <code>{"{{value}}"}</code> (incoming),{" "}
                      <code>{"{{nodes.<id>}}"}</code> (an earlier node) and, inside a loop,{" "}
                      <code>{"{{item}}"}</code> / <code>{"{{index}}"}</code>. Never code.
                    </>
                  }
                >
                  <textarea
                    value={selectedNode.node.data.config.template || ""}
                    onChange={(e) => updateNodeConfig("template", e.target.value)}
                    rows={4}
                    className={AREA_CLS}
                    placeholder="{{value}}"
                  />
                </Field>
              )}

              {selectedNode.node.type === "delay" && (
                <Field label="Duration (ms)" hint="Up to 30,000.">
                  <input
                    type="number"
                    min="0"
                    max="30000"
                    step="100"
                    value={
                      selectedNode.node.data.config.ms ??
                      selectedNode.node.data.config.duration ??
                      1000
                    }
                    onChange={(e) => updateNodeConfig("ms", parseInt(e.target.value) || 0)}
                    className={INPUT_CLS}
                  />
                </Field>
              )}

              {selectedNode.node.type === "api" && (
                <>
                  <Field
                    label="URL"
                    hint={
                      <>
                        May use <code>{"{{value}}"}</code>; use{" "}
                        <code>{"{{value | urlencode}}"}</code> inside a query string. Private
                        and internal addresses are always blocked.
                      </>
                    }
                  >
                    <input
                      type="text"
                      value={selectedNode.node.data.config.url || ""}
                      onChange={(e) => updateNodeConfig("url", e.target.value)}
                      className={INPUT_CLS}
                      placeholder="https://api.example.com/endpoint"
                    />
                  </Field>
                  <Field label="Method">
                    <select
                      value={selectedNode.node.data.config.method || "GET"}
                      onChange={(e) => updateNodeConfig("method", e.target.value)}
                      className={INPUT_CLS}
                    >
                      {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Headers (JSON)">
                    <JsonObjectField
                      key={selectedNode.node.id}
                      value={selectedNode.node.data.config.headers}
                      onCommit={(headers) => updateNodeConfig("headers", headers)}
                      placeholder='{"Authorization": "Bearer …"}'
                    />
                  </Field>
                  {!["GET", "HEAD"].includes(selectedNode.node.data.config.method || "GET") && (
                    <Field
                      label="Body"
                      hint={
                        <>
                          For JSON use <code>{"{{value | json}}"}</code> to embed text safely.
                        </>
                      }
                    >
                      <textarea
                        value={selectedNode.node.data.config.body || ""}
                        onChange={(e) => updateNodeConfig("body", e.target.value)}
                        rows={4}
                        className={AREA_CLS}
                        placeholder='{"query": {{value | json}}}'
                      />
                    </Field>
                  )}
                  <Field label="Timeout (ms)" hint="1,000 to 30,000.">
                    <input
                      type="number"
                      min="1000"
                      max="30000"
                      step="500"
                      value={selectedNode.node.data.config.timeoutMs ?? 10000}
                      onChange={(e) =>
                        updateNodeConfig("timeoutMs", parseInt(e.target.value) || 10000)
                      }
                      className={INPUT_CLS}
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedNode.node.data.config.failOnHttpError !== false}
                      onChange={(e) => updateNodeConfig("failOnHttpError", e.target.checked)}
                    />
                    Fail the run on a non-2xx response
                  </label>
                  <Field
                    label="If the response is too large"
                    hint="The limit is 64 KB by default (256 KB at most)."
                  >
                    <select
                      value={selectedNode.node.data.config.onOversize || "fail"}
                      onChange={(e) => updateNodeConfig("onOversize", e.target.value)}
                      className={INPUT_CLS}
                    >
                      <option value="fail">Fail the run</option>
                      <option value="truncate">Keep the first part</option>
                    </select>
                  </Field>
                </>
              )}

              {selectedNode.node.type === "code" && (
                <>
                  {(() => {
                    const sandbox = skills.find((s) => s.key === "code_interpreter");
                    return sandbox && !sandbox.available ? (
                      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-2 text-xs">
                        This node will be refused when run: {sandbox.unavailableReason}. Code
                        only ever runs in an external sandbox, never on the API server.
                      </div>
                    ) : null;
                  })()}
                  <Field label="Language">
                    <select
                      value={selectedNode.node.data.config.language || "python"}
                      onChange={(e) => updateNodeConfig("language", e.target.value)}
                      className={INPUT_CLS}
                    >
                      <option value="python">Python</option>
                      <option value="javascript">JavaScript</option>
                    </select>
                  </Field>
                  <Field
                    label="Code"
                    hint="The incoming value arrives on stdin; whatever the program prints to stdout is the node's output. Not templated."
                  >
                    <textarea
                      value={selectedNode.node.data.config.code || ""}
                      onChange={(e) => updateNodeConfig("code", e.target.value)}
                      rows={6}
                      className={AREA_CLS}
                      placeholder="import sys&#10;print(sys.stdin.read().upper())"
                    />
                  </Field>
                </>
              )}

              {selectedNode.node.type === "loop" && (
                <>
                  <Field
                    label="Iterate over"
                    hint="Connect the loop's first step with a line labelled “Loop body” and the next node with “After the loop” (below). The body is a straight chain, run once per item, at most 20 times."
                  >
                    <select
                      value={selectedNode.node.data.config.mode === "count" ? "count" : "list"}
                      onChange={(e) => updateNodeConfig("mode", e.target.value)}
                      className={INPUT_CLS}
                    >
                      <option value="list">A list from the previous step</option>
                      <option value="count">A fixed number of times</option>
                    </select>
                  </Field>
                  {selectedNode.node.data.config.mode === "count" ? (
                    <Field label="Times (max 20)">
                      <input
                        type="number"
                        min="0"
                        max="20"
                        value={selectedNode.node.data.config.count ?? 1}
                        onChange={(e) => updateNodeConfig("count", parseInt(e.target.value) || 0)}
                        className={INPUT_CLS}
                      />
                    </Field>
                  ) : (
                    <>
                      <Field
                        label="List"
                        hint={
                          <>
                            Default <code>{"{{value}}"}</code>. Can name an earlier node:{" "}
                            <code>{"{{nodes.<id>}}"}</code>.
                          </>
                        }
                      >
                        <input
                          type="text"
                          value={selectedNode.node.data.config.list || ""}
                          onChange={(e) => updateNodeConfig("list", e.target.value)}
                          placeholder="{{value}}"
                          className={INPUT_CLS}
                        />
                      </Field>
                      <Field label="List format">
                        <select
                          value={selectedNode.node.data.config.format || "json"}
                          onChange={(e) => updateNodeConfig("format", e.target.value)}
                          className={INPUT_CLS}
                        >
                          <option value="json">JSON array</option>
                          <option value="lines">One item per line</option>
                        </select>
                      </Field>
                    </>
                  )}
                  <Field label="Max iterations (hard limit 20)">
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={selectedNode.node.data.config.maxIterations ?? 20}
                      onChange={(e) =>
                        updateNodeConfig("maxIterations", parseInt(e.target.value) || 20)
                      }
                      className={INPUT_CLS}
                    />
                  </Field>
                  <Field label="Result">
                    <select
                      value={selectedNode.node.data.config.collect || "array"}
                      onChange={(e) => updateNodeConfig("collect", e.target.value)}
                      className={INPUT_CLS}
                    >
                      <option value="array">JSON array of every iteration</option>
                      <option value="last">Only the last iteration</option>
                      <option value="join">Joined text</option>
                    </select>
                  </Field>
                  {selectedNode.node.data.config.collect === "join" && (
                    <Field label="Separator">
                      <input
                        type="text"
                        value={selectedNode.node.data.config.separator ?? "\n"}
                        onChange={(e) => updateNodeConfig("separator", e.target.value)}
                        className={INPUT_CLS}
                      />
                    </Field>
                  )}
                </>
              )}

              {selectedNode.node.type === "parallel" && (
                <Field
                  label="Max at once"
                  hint="Every outgoing line is a branch and all branches get the same input. Join them with a Merge node. 1 to 8."
                >
                  <input
                    type="number"
                    min="1"
                    max="8"
                    value={selectedNode.node.data.config.maxConcurrency ?? 4}
                    onChange={(e) =>
                      updateNodeConfig("maxConcurrency", parseInt(e.target.value) || 4)
                    }
                    className={INPUT_CLS}
                  />
                </Field>
              )}

              {selectedNode.node.type === "merge" && (
                <>
                  <Field
                    label="Combine branches as"
                    hint="Only the branches that actually ran are included."
                  >
                    <select
                      value={selectedNode.node.data.config.mode || "array"}
                      onChange={(e) => updateNodeConfig("mode", e.target.value)}
                      className={INPUT_CLS}
                    >
                      <option value="array">JSON array</option>
                      <option value="object">JSON object keyed by node id</option>
                      <option value="join">Joined text</option>
                    </select>
                  </Field>
                  {selectedNode.node.data.config.mode === "join" && (
                    <Field label="Separator">
                      <input
                        type="text"
                        value={selectedNode.node.data.config.separator ?? "\n\n"}
                        onChange={(e) => updateNodeConfig("separator", e.target.value)}
                        className={INPUT_CLS}
                      />
                    </Field>
                  )}
                </>
              )}

              {/* Branch labels: a condition picks one labelled edge; a loop has a body edge. */}
              {BRANCH_OPTIONS[selectedNode.node.type] && (
                <div>
                  <label className="text-sm font-medium block mb-1">Outgoing lines</label>
                  {(() => {
                    const out = edges.filter((e) => e.source === selectedNode.node.id);
                    if (out.length === 0) {
                      return (
                        <p className="text-xs text-muted-foreground">
                          Drag from this node&apos;s right dot to another node, then label the
                          line here.
                        </p>
                      );
                    }
                    const options = BRANCH_OPTIONS[selectedNode.node.type]!;
                    return (
                      <div className="space-y-2">
                        {out.map((edge) => {
                          const target = nodes.find((n) => n.id === edge.target);
                          return (
                            <div key={edge.id} className="flex items-center gap-2">
                              <span className="flex-1 truncate text-xs">
                                → {target?.data.label ?? edge.target}
                              </span>
                              <select
                                value={
                                  options.some(([v]) => v === edgeBranch(edge))
                                    ? edgeBranch(edge)
                                    : ""
                                }
                                onChange={(e) =>
                                  setEdges((prev) =>
                                    prev.map((ed) =>
                                      ed.id === edge.id
                                        ? { ...ed, sourceHandle: e.target.value || "output" }
                                        : ed
                                    )
                                  )
                                }
                                className="px-2 py-1 bg-background border rounded text-xs"
                              >
                                <option value="">Unlabelled</option>
                                {options.map(([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Node ID (read-only) */}
              <div>
                <label className="text-sm font-medium block mb-1 text-muted-foreground">
                  Node ID
                </label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-muted rounded-lg text-xs truncate">
                    {selectedNode.node.id}
                  </code>
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(selectedNode.node.id)
                    }
                    className="p-2 hover:bg-accent rounded transition-colors"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Templates Modal */}
      {showTemplates && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card border rounded-lg w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Agent Templates</h2>
              <button
                onClick={() => setShowTemplates(false)}
                className="p-1 hover:bg-accent rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-4">
              Choose a template to get started quickly. This will replace your
              current graph.
            </p>

            <div className="space-y-3">
              {templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => handleApplyTemplate(template.id)}
                  className="w-full p-4 bg-background border rounded-lg hover:border-primary transition-colors text-left"
                >
                  <div className="font-medium">{template.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {template.description}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {template.nodeCount} nodes
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Run panel — the node-by-node trace of the last run (W2). */}
      {showRunPanel && (
        <div className="absolute bottom-0 left-0 right-0 max-h-[45%] border-t bg-card shadow-lg flex flex-col z-20">
          <div className="flex items-center gap-2 px-4 py-2 border-b">
            <Play className="h-4 w-4" />
            <span className="text-sm font-semibold">Run</span>
            {runResult && (
              <span
                className={
                  runResult.status === "completed"
                    ? "text-xs px-2 py-0.5 rounded bg-green-500/10 text-green-500"
                    : "text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-500"
                }
              >
                {runResult.status} · {runResult.durationMs}ms
              </span>
            )}
            <button
              onClick={() => setShowRunPanel(false)}
              className="ml-auto p-1 hover:bg-accent rounded"
              aria-label="Close run panel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {refusedToolSkills.length > 0 && (
            <div className="px-3 pt-3 space-y-2">
              {refusedToolSkills.map((skill) => (
                <SkillNotEnabledNote
                  key={skill.key}
                  skill={skill}
                  onEnable={() => enableTool(skill.key)}
                  enabling={enablingTool === skill.key}
                />
              ))}
              {enableToolError && <p className="text-xs text-red-500">{enableToolError}</p>}
            </div>
          )}

          <div className="p-3 border-b flex gap-2">
            <input
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              placeholder="Input for the graph's input node"
              className="flex-1 px-3 py-1.5 text-sm border rounded-lg bg-background"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !running) handleRun();
              }}
            />
            <button
              onClick={handleRun}
              disabled={running}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg disabled:opacity-50"
            >
              {running ? "Running..." : "Run"}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {running && (
              <p className="text-sm text-muted-foreground">Executing graph…</p>
            )}

            {runResult?.error && (
              <div className="text-sm rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                {runResult.error}
              </div>
            )}

            {runResult?.trace.map((entry, traceIndex) => (
              <div
                key={`${entry.nodeId}-${entry.iteration ?? "main"}-${traceIndex}`}
                className={`rounded-lg border p-2 text-xs space-y-1 ${
                  entry.iteration !== undefined ? "ml-4 border-dashed" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{entry.label}</span>
                  <span className="text-muted-foreground">{entry.nodeType}</span>
                  {entry.iteration !== undefined && (
                    <span className="px-1.5 rounded bg-cyan-500/10 text-cyan-500">
                      iteration {entry.iteration + 1}
                    </span>
                  )}
                  <span
                    className={
                      entry.status === "success"
                        ? "px-1.5 rounded bg-green-500/10 text-green-500"
                        : entry.status === "refused"
                          ? "px-1.5 rounded bg-amber-500/10 text-amber-500"
                          : "px-1.5 rounded bg-red-500/10 text-red-500"
                    }
                  >
                    {entry.status}
                  </span>
                  <span className="ml-auto text-muted-foreground">
                    {entry.durationMs}ms
                  </span>
                </div>
                {entry.output && (
                  <pre className="whitespace-pre-wrap break-words text-muted-foreground">
                    {entry.output.slice(0, 400)}
                  </pre>
                )}
                {entry.error && (
                  <p className="text-red-600 dark:text-red-400">{entry.error}</p>
                )}
              </div>
            ))}

            {runResult?.status === "completed" && (
              <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm">
                <div className="font-medium mb-1">Output</div>
                <pre className="whitespace-pre-wrap break-words">
                  {runResult.output}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
