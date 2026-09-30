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
import { agentsApi, agentGraphApi, type GraphNode, type GraphEdge, type GraphTemplate, type GraphRunResult } from "@/lib/api";

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
    } catch (error) {
      console.error("Failed to load builder:", error);
    } finally {
      setLoading(false);
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

  function getDefaultConfig(type: NodeType): Record<string, any> {
    switch (type) {
      case "llm":
        return { model: "default", temperature: 0.7, systemPrompt: "" };
      case "tool":
        return { toolName: "", timeout: 30000 };
      case "condition":
        return { conditions: [] };
      case "memory":
        return { operation: "read", key: "" };
      case "transform":
        return { template: "" };
      case "api":
        return { url: "", method: "GET", headers: {} };
      case "code":
        return { language: "javascript", code: "" };
      case "delay":
        return { duration: 1000 };
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
                      <div>Tool: {node.data.config.toolName}</div>
                    )}
                    {node.type === "condition" && (
                      <div>
                        {node.data.config.conditions?.length || 0} conditions
                      </div>
                    )}
                    {!["llm", "tool", "condition"].includes(node.type) && (
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

              {/* Type-specific config */}
              {selectedNode.node.type === "llm" && (
                <>
                  <div>
                    <label className="text-sm font-medium block mb-1">
                      Temperature
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="2"
                      step="0.1"
                      value={selectedNode.node.data.config.temperature || 0.7}
                      onChange={(e) =>
                        updateNodeConfig("temperature", parseFloat(e.target.value))
                      }
                      className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">
                      System Prompt
                    </label>
                    <textarea
                      value={selectedNode.node.data.config.systemPrompt || ""}
                      onChange={(e) =>
                        updateNodeConfig("systemPrompt", e.target.value)
                      }
                      rows={4}
                      className="w-full px-3 py-2 bg-background text-foreground border border-input rounded-lg text-sm resize-none"
                      placeholder="You are a helpful assistant..."
                    />
                  </div>
                </>
              )}

              {selectedNode.node.type === "tool" && (
                <div>
                  <label className="text-sm font-medium block mb-1">
                    Tool Name
                  </label>
                  <select
                    value={selectedNode.node.data.config.toolName || ""}
                    onChange={(e) => updateNodeConfig("toolName", e.target.value)}
                    className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
                  >
                    <option value="">Select a tool...</option>
                    <option value="web_search">Web Search</option>
                    <option value="calculator">Calculator</option>
                    <option value="code_interpreter">Code Interpreter</option>
                    <option value="file_browser">File Browser</option>
                  </select>
                </div>
              )}

              {selectedNode.node.type === "memory" && (
                <>
                  <div>
                    <label className="text-sm font-medium block mb-1">
                      Operation
                    </label>
                    <select
                      value={selectedNode.node.data.config.operation || "read"}
                      onChange={(e) =>
                        updateNodeConfig("operation", e.target.value)
                      }
                      className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
                    >
                      <option value="read">Read</option>
                      <option value="write">Write</option>
                      <option value="search">Vector Search</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">
                      Key
                    </label>
                    <input
                      type="text"
                      value={selectedNode.node.data.config.key || ""}
                      onChange={(e) => updateNodeConfig("key", e.target.value)}
                      className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
                      placeholder="memory_key"
                    />
                  </div>
                </>
              )}

              {selectedNode.node.type === "transform" && (
                <div>
                  <label className="text-sm font-medium block mb-1">
                    Template
                  </label>
                  <textarea
                    value={selectedNode.node.data.config.template || ""}
                    onChange={(e) =>
                      updateNodeConfig("template", e.target.value)
                    }
                    rows={4}
                    className="w-full px-3 py-2 bg-background text-foreground border border-input rounded-lg text-sm resize-none font-mono"
                    placeholder="{{input}}"
                  />
                </div>
              )}

              {selectedNode.node.type === "delay" && (
                <div>
                  <label className="text-sm font-medium block mb-1">
                    Duration (ms)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="100"
                    value={selectedNode.node.data.config.duration || 1000}
                    onChange={(e) =>
                      updateNodeConfig("duration", parseInt(e.target.value))
                    }
                    className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
                  />
                </div>
              )}

              {selectedNode.node.type === "api" && (
                <>
                  <div>
                    <label className="text-sm font-medium block mb-1">
                      URL
                    </label>
                    <input
                      type="text"
                      value={selectedNode.node.data.config.url || ""}
                      onChange={(e) => updateNodeConfig("url", e.target.value)}
                      className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
                      placeholder="https://api.example.com/endpoint"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">
                      Method
                    </label>
                    <select
                      value={selectedNode.node.data.config.method || "GET"}
                      onChange={(e) =>
                        updateNodeConfig("method", e.target.value)
                      }
                      className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="DELETE">DELETE</option>
                    </select>
                  </div>
                </>
              )}

              {selectedNode.node.type === "code" && (
                <>
                  <div>
                    <label className="text-sm font-medium block mb-1">
                      Language
                    </label>
                    <select
                      value={selectedNode.node.data.config.language || "javascript"}
                      onChange={(e) =>
                        updateNodeConfig("language", e.target.value)
                      }
                      className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
                    >
                      <option value="javascript">JavaScript</option>
                      <option value="python">Python</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">
                      Code
                    </label>
                    <textarea
                      value={selectedNode.node.data.config.code || ""}
                      onChange={(e) => updateNodeConfig("code", e.target.value)}
                      rows={6}
                      className="w-full px-3 py-2 bg-background text-foreground border border-input rounded-lg text-sm resize-none font-mono"
                      placeholder="// Your code here"
                    />
                  </div>
                </>
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

            {runResult?.trace.map((entry) => (
              <div
                key={entry.nodeId}
                className="rounded-lg border p-2 text-xs space-y-1"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{entry.label}</span>
                  <span className="text-muted-foreground">{entry.nodeType}</span>
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
