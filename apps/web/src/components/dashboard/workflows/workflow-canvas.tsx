"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  BookOpen,
  Cpu,
  GitBranch,
  Maximize,
  Repeat,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import type { WorkflowStepType } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NODE_HEIGHT, NODE_WIDTH } from "./workflow-model";

/**
 * The workflow graph: steps as nodes, dependencies as arrows.
 *
 *   drag a node              move it
 *   drag from a node's right handle onto another node
 *                            the second step now waits for the first
 *   click an arrow           remove that dependency
 *   drag the background      pan
 *
 * Everything the canvas does is also available without a pointer: the
 * step panel has a "Waits for" list, and each node is a focusable button.
 *
 * Draws its own SVG, like the agent builder; no graph library.
 */

export interface CanvasNode {
  key: string;
  name: string;
  stepType: WorkflowStepType;
  /** The agent, deployment or knowledge base, by name; empty when none is chosen. */
  resource: string;
  position: { x: number; y: number };
  hasCondition: boolean;
  loop: "forEach" | "until" | null;
  /** 1-based position in the run order, when the plan is known. */
  order?: number;
  invalid: boolean;
}

export interface CanvasEdge {
  from: string;
  to: string;
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface WorkflowCanvasProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedKey: string | null;
  viewport: Viewport;
  onViewportChange: (viewport: Viewport) => void;
  onSelect: (key: string | null) => void;
  onMove: (key: string, position: { x: number; y: number }) => void;
  onConnect: (from: string, to: string) => void;
  onDisconnect: (from: string, to: string) => void;
  className?: string;
}

type Drag =
  | { kind: "node"; key: string; offsetX: number; offsetY: number }
  | { kind: "connect"; from: string; x: number; y: number }
  | { kind: "pan"; startX: number; startY: number; originX: number; originY: number };

const STEP_ICONS: Record<WorkflowStepType, React.ElementType> = {
  agent: Bot,
  model: Cpu,
  retrieval: BookOpen,
};

const STEP_LABELS: Record<WorkflowStepType, string> = {
  agent: "Agent",
  model: "Model",
  retrieval: "Retrieval",
};

const CHOOSE_RESOURCE: Record<WorkflowStepType, string> = {
  agent: "Choose an agent",
  model: "Choose a deployment",
  retrieval: "Choose a knowledge base",
};

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  // The control points lean right from the source and left into the
  // target, so an arrow that goes backwards still reads as a curve.
  const reach = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2} ${y2}`;
}

export function WorkflowCanvas({
  nodes,
  edges,
  selectedKey,
  viewport,
  onViewportChange,
  onSelect,
  onMove,
  onConnect,
  onDisconnect,
  className,
}: WorkflowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);

  // The handlers below are attached to window for the length of one drag;
  // refs let them read the latest props without re-subscribing mid-drag.
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const callbacks = useRef({ onMove, onConnect, onViewportChange, onSelect });
  callbacks.current = { onMove, onConnect, onViewportChange, onSelect };

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const vp = viewportRef.current;
    return {
      x: (clientX - (rect?.left ?? 0) - vp.x) / vp.zoom,
      y: (clientY - (rect?.top ?? 0) - vp.y) / vp.zoom,
    };
  }, []);

  const nodeAt = useCallback((clientX: number, clientY: number): string | null => {
    const element = document.elementFromPoint(clientX, clientY);
    return element?.closest<HTMLElement>("[data-step-key]")?.dataset.stepKey ?? null;
  }, []);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (current.kind === "node") {
        const world = toWorld(event.clientX, event.clientY);
        callbacks.current.onMove(current.key, {
          x: world.x - current.offsetX,
          y: world.y - current.offsetY,
        });
      } else if (current.kind === "connect") {
        const world = toWorld(event.clientX, event.clientY);
        setDrag({ ...current, x: world.x, y: world.y });
        const over = nodeAt(event.clientX, event.clientY);
        setHoverTarget(over && over !== current.from ? over : null);
      } else {
        callbacks.current.onViewportChange({
          ...viewportRef.current,
          x: current.originX + (event.clientX - current.startX),
          y: current.originY + (event.clientY - current.startY),
        });
      }
    };

    const up = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current?.kind === "connect") {
        const target = nodeAt(event.clientX, event.clientY);
        if (target && target !== current.from) callbacks.current.onConnect(current.from, target);
      }
      setHoverTarget(null);
      setDrag(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging, toWorld, nodeAt]);

  function zoomBy(delta: number) {
    onViewportChange({
      ...viewport,
      zoom: Math.round(Math.max(0.4, Math.min(1.6, viewport.zoom + delta)) * 10) / 10,
    });
  }

  function fitView() {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || nodes.length === 0) {
      onViewportChange({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const left = Math.min(...nodes.map((n) => n.position.x));
    const top = Math.min(...nodes.map((n) => n.position.y));
    const right = Math.max(...nodes.map((n) => n.position.x + NODE_WIDTH));
    const bottom = Math.max(...nodes.map((n) => n.position.y + NODE_HEIGHT));
    const zoom = Math.max(
      0.4,
      Math.min(1, (rect.width - 80) / (right - left), (rect.height - 80) / (bottom - top))
    );
    onViewportChange({
      zoom,
      x: (rect.width - (right - left) * zoom) / 2 - left * zoom,
      y: (rect.height - (bottom - top) * zoom) / 2 - top * zoom,
    });
  }

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const connectFrom = drag?.kind === "connect" ? byKey.get(drag.from) : undefined;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative touch-none select-none overflow-hidden rounded-lg border border-border bg-muted/30",
        drag?.kind === "pan" ? "cursor-grabbing" : "cursor-grab",
        className
      )}
      style={{
        backgroundImage:
          "radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)",
        backgroundSize: `${20 * viewport.zoom}px ${20 * viewport.zoom}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        onSelect(null);
        setDrag({
          kind: "pan",
          startX: event.clientX,
          startY: event.clientY,
          originX: viewport.x,
          originY: viewport.y,
        });
      }}
    >
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
          <defs>
            <marker id="workflow-arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
              <polygon points="0 0, 10 4, 0 8" className="fill-muted-foreground" />
            </marker>
            <marker id="workflow-arrow-active" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
              <polygon points="0 0, 10 4, 0 8" className="fill-primary" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const from = byKey.get(edge.from);
            const to = byKey.get(edge.to);
            if (!from || !to) return null;
            const d = edgePath(
              from.position.x + NODE_WIDTH,
              from.position.y + NODE_HEIGHT / 2,
              to.position.x,
              to.position.y + NODE_HEIGHT / 2
            );
            const active = selectedKey === edge.from || selectedKey === edge.to;
            return (
              <g key={`${edge.from}->${edge.to}`}>
                <path
                  d={d}
                  fill="none"
                  strokeWidth={2}
                  className={active ? "stroke-primary" : "stroke-muted-foreground"}
                  markerEnd={active ? "url(#workflow-arrow-active)" : "url(#workflow-arrow)"}
                />
                {/* A wide invisible stroke so the arrow is easy to hit. */}
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={16}
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onDisconnect(edge.from, edge.to)}
                >
                  <title>{`${to.name} waits for ${from.name}. Click to remove.`}</title>
                </path>
              </g>
            );
          })}
          {drag?.kind === "connect" && connectFrom && (
            <path
              d={edgePath(
                connectFrom.position.x + NODE_WIDTH,
                connectFrom.position.y + NODE_HEIGHT / 2,
                drag.x,
                drag.y
              )}
              fill="none"
              strokeWidth={2}
              strokeDasharray="6 4"
              className="stroke-primary"
            />
          )}
        </svg>

        {nodes.map((node) => {
          const Icon = STEP_ICONS[node.stepType];
          const selected = selectedKey === node.key;
          const dropTarget = hoverTarget === node.key;
          return (
            <div
              key={node.key}
              data-step-key={node.key}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`Step ${node.name || "unnamed"}, ${STEP_LABELS[node.stepType]}${node.invalid ? ", needs attention" : ""}`}
              className={cn(
                "absolute cursor-pointer rounded-lg border-2 bg-card text-card-foreground shadow-sm transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-primary shadow-md" : "border-border hover:border-muted-foreground",
                node.invalid && !selected && "border-danger/70",
                dropTarget && "border-primary ring-2 ring-primary/40"
              )}
              style={{
                left: node.position.x,
                top: node.position.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                onSelect(node.key);
                const world = toWorld(event.clientX, event.clientY);
                setDrag({
                  kind: "node",
                  key: node.key,
                  offsetX: world.x - node.position.x,
                  offsetY: world.y - node.position.y,
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(node.key);
                }
              }}
            >
              <div className="flex h-full flex-col justify-between px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {node.name || "Unnamed step"}
                  </span>
                  {node.order !== undefined && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {node.order}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">
                    {node.resource || CHOOSE_RESOURCE[node.stepType]}
                  </span>
                  {node.hasCondition && (
                    <span title="Runs only if its condition holds" className="shrink-0 text-primary">
                      <GitBranch className="h-3.5 w-3.5" aria-label="Has a condition" />
                    </span>
                  )}
                  {node.loop && (
                    <span
                      title={node.loop === "forEach" ? "Runs once per item of a list" : "Repeats until a condition holds"}
                      className="shrink-0 text-primary"
                    >
                      <Repeat className="h-3.5 w-3.5" aria-label="Loops" />
                    </span>
                  )}
                  {node.invalid && (
                    <span title="Needs attention" className="shrink-0 text-danger">
                      <AlertTriangle className="h-3.5 w-3.5" aria-label="Needs attention" />
                    </span>
                  )}
                </div>
              </div>

              {/* Input side: where arrows land. Decorative; the whole node is the drop target. */}
              <span
                aria-hidden="true"
                className="absolute left-0 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-muted-foreground bg-background"
              />
              {/* Output handle: drag from here onto the step that should wait for this one. */}
              <span
                title="Drag onto another step to make it wait for this one"
                className="absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 translate-x-1/2 cursor-crosshair rounded-full border-2 border-primary bg-background transition-transform hover:scale-125"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  event.preventDefault();
                  const world = toWorld(event.clientX, event.clientY);
                  setDrag({ kind: "connect", from: node.key, x: world.x, y: world.y });
                }}
              />
            </div>
          );
        })}
      </div>

      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
          <div>
            <p className="text-sm font-medium text-foreground">No steps yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a step, then drag from one step&apos;s handle onto another to make it wait.
            </p>
          </div>
        </div>
      )}

      <div
        className="absolute bottom-3 left-3 flex items-center gap-1 rounded-md border border-border bg-card p-1 shadow-sm"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => zoomBy(-0.1)}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="w-10 text-center font-mono text-xs text-muted-foreground">
          {Math.round(viewport.zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomBy(0.1)}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={fitView}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Fit all steps in view"
        >
          <Maximize className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
