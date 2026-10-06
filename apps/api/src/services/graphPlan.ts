/**
 * Static planning for the graph interpreter: everything that can be decided
 * about a graph BEFORE running a single node.
 *
 * The visual builder draws a graph; this turns it into something a scheduler
 * can execute, or refuses it by name with a reason. Doing this up front - not
 * lazily while walking - means a malformed graph fails before any LLM call
 * has been paid for, and the failure names the exact node or edge.
 *
 * Model:
 *   - The MAIN graph is acyclic and is executed in topological LEVELS (the
 *     same Kahn levels the orchestration engine uses, services/
 *     orchestrationPlan.ts). Nodes in one level have all their dependencies
 *     satisfied and may run concurrently.
 *   - Fan-out is explicit: only a `parallel` node may have several outgoing
 *     edges (a `condition` picks one of up to two labelled edges; a `loop` has
 *     a `body` edge and one continuation). Anything else with several
 *     outgoing edges is ambiguous and refused.
 *   - A `loop` node's BODY is not part of the main graph. It is the linear
 *     chain reached from the loop's `body` edge, run once per item by the
 *     interpreter. There are no back-edges; a cycle is an error, not a loop.
 */

import {
  OrchestrationPlanError,
  planOrchestration,
  type PlannableStep,
} from "./orchestrationPlan.js";

export interface InterpretableNode {
  id: string;
  type: string;
  data: { label?: string; config?: Record<string, unknown> };
}

export interface InterpretableEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  label?: string;
}

/** Node types that may not appear inside a loop body, and why. */
const BODY_FORBIDDEN: Record<string, string> = {
  input: "an input node starts the graph",
  output: "an output node ends the graph",
  loop: "nested loops are not supported",
  parallel: "a loop body is a single linear chain (put the parallel node outside the loop)",
  merge: "a loop body is a single linear chain",
  condition: "a loop body is a single linear chain (branch before or after the loop)",
};

/** The builder stamps every edge with the default handle "output". */
const DEFAULT_HANDLES = new Set(["", "output", "default"]);

/**
 * The branch name an edge carries: an explicit source handle ("true",
 * "false", "body", ...) wins, then the edge label, otherwise none. The
 * builder's default "output" handle means "no branch".
 */
export function edgeHandle(edge: InterpretableEdge): string | undefined {
  const handle = edge.sourceHandle?.trim();
  if (handle && !DEFAULT_HANDLES.has(handle)) return handle;
  const label = edge.label?.trim();
  return label ? label : undefined;
}

export interface GraphPlan {
  inputId: string;
  byId: Map<string, InterpretableNode>;
  /** Topological levels of the main graph (loop bodies excluded). */
  levels: InterpretableNode[][];
  /** Main-graph edges into / out of each node (loop `body` edges excluded). */
  incoming: Map<string, InterpretableEdge[]>;
  outgoing: Map<string, InterpretableEdge[]>;
  /** loop node id -> its body chain, in execution order. */
  bodies: Map<string, InterpretableNode[]>;
}

export type PlanResult =
  | { ok: true; plan: GraphPlan }
  | { ok: false; error: string };

const fail = (error: string): PlanResult => ({ ok: false, error });

export function labelOf(node: InterpretableNode): string {
  return node.data.label ?? node.id;
}

export function planGraph(
  nodes: InterpretableNode[],
  edges: InterpretableEdge[],
): PlanResult {
  const inputNodes = nodes.filter((n) => n.type === "input");
  if (inputNodes.length === 0) {
    return fail("graph has no input node — nothing to start from");
  }
  if (inputNodes.length > 1) {
    return fail(
      `graph has ${inputNodes.length} input nodes; the interpreter starts from exactly one`,
    );
  }
  const input = inputNodes[0]!;

  const byId = new Map<string, InterpretableNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) return fail(`duplicate node id "${node.id}"`);
    byId.set(node.id, node);
  }

  // An output node is terminal: edges leaving it are never followed.
  const liveEdges = edges.filter((e) => byId.get(e.source)?.type !== "output");
  const outAll = new Map<string, InterpretableEdge[]>();
  for (const edge of liveEdges) {
    const list = outAll.get(edge.source) ?? [];
    list.push(edge);
    outAll.set(edge.source, list);
  }

  // ---- reachability from the input, stepping over loop bodies ----
  const isBodyEdge = (e: InterpretableEdge) =>
    byId.get(e.source)?.type === "loop" && edgeHandle(e) === "body";

  const mainReach = new Set<string>([input.id]);
  const queue = [input.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of outAll.get(id) ?? []) {
      if (!byId.has(edge.target)) {
        return fail(`edge ${edge.id} points at missing node ${edge.target}`);
      }
      if (isBodyEdge(edge)) continue;
      if (!mainReach.has(edge.target)) {
        mainReach.add(edge.target);
        queue.push(edge.target);
      }
    }
  }

  // ---- loop bodies ----
  const bodies = new Map<string, InterpretableNode[]>();
  const bodyOwner = new Map<string, string>();
  for (const id of mainReach) {
    const node = byId.get(id)!;
    if (node.type !== "loop") continue;

    const out = outAll.get(id) ?? [];
    const bodyEdges = out.filter(isBodyEdge);
    if (bodyEdges.length !== 1) {
      return fail(
        `loop node "${labelOf(node)}" needs exactly one outgoing edge labelled "body" (found ${bodyEdges.length}); that edge starts the chain run once per item`,
      );
    }

    const chain: InterpretableNode[] = [];
    const seen = new Set<string>([id]);
    let cursor: InterpretableEdge | undefined = bodyEdges[0];
    while (cursor) {
      const next = byId.get(cursor.target);
      if (!next) return fail(`edge ${cursor.id} points at missing node ${cursor.target}`);
      if (seen.has(next.id)) {
        return fail(
          `loop "${labelOf(node)}" body revisits node "${labelOf(next)}" — a loop body is a forward chain, not a cycle`,
        );
      }
      const forbidden = BODY_FORBIDDEN[next.type];
      if (forbidden) {
        return fail(
          `loop "${labelOf(node)}" body contains ${next.type} node "${labelOf(next)}": ${forbidden}`,
        );
      }
      if (mainReach.has(next.id)) {
        return fail(
          `loop "${labelOf(node)}" body reaches "${labelOf(next)}", which is also on the main path — end the body in its own last node and continue from the loop's other edge`,
        );
      }
      const owner = bodyOwner.get(next.id);
      if (owner && owner !== id) {
        return fail(`node "${labelOf(next)}" belongs to two loop bodies`);
      }
      seen.add(next.id);
      bodyOwner.set(next.id, id);
      chain.push(next);

      const following: InterpretableEdge[] = outAll.get(next.id) ?? [];
      if (following.length > 1) {
        return fail(
          `loop "${labelOf(node)}" body node "${labelOf(next)}" has ${following.length} outgoing edges; a loop body is a single linear chain`,
        );
      }
      cursor = following[0];
    }
    bodies.set(id, chain);
  }

  // ---- main graph edges + fan-out rules ----
  const incoming = new Map<string, InterpretableEdge[]>();
  const outgoing = new Map<string, InterpretableEdge[]>();
  for (const id of mainReach) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of liveEdges) {
    if (!mainReach.has(edge.source) || !mainReach.has(edge.target)) continue;
    if (isBodyEdge(edge)) continue;
    outgoing.get(edge.source)!.push(edge);
    incoming.get(edge.target)!.push(edge);
  }

  for (const id of mainReach) {
    const node = byId.get(id)!;
    const out = outgoing.get(id)!;
    const label = labelOf(node);

    if (node.type === "condition") {
      const byHandle = new Map<string, number>();
      for (const e of out) {
        const h = edgeHandle(e) ?? "";
        byHandle.set(h, (byHandle.get(h) ?? 0) + 1);
      }
      for (const [handle, count] of byHandle) {
        if (count > 1) {
          return fail(
            handle === ""
              ? `condition "${label}" has ${count} unlabeled outgoing edges; label them "true" and "false"`
              : `condition "${label}" has ${count} edges labelled "${handle}"; it picks one branch — use a parallel node to fan out`,
          );
        }
      }
    } else if (node.type !== "parallel" && out.length > 1) {
      return fail(
        `node "${label}" has ${out.length} outgoing edges; only a parallel node fans out (a condition picks one branch) — add a parallel node after it and a merge node to join the branches`,
      );
    }
  }

  // ---- levels (and cycle detection) ----
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const steps: PlannableStep[] = [...mainReach].map((id) => ({
    id,
    name: id,
    stepOrder: order.get(id) ?? 0,
    dependsOn: [...new Set(incoming.get(id)!.map((e) => e.source))],
  }));

  let levels: InterpretableNode[][];
  try {
    const plan = planOrchestration(steps, "parallel", 1);
    levels = plan.levels.map((level) => level.map((s) => byId.get(s.name)!));
  } catch (err) {
    if (err instanceof OrchestrationPlanError) {
      const cycle = err.message.match(/dependency cycle among steps: (.+)$/);
      if (cycle) {
        return fail(
          `graph contains a cycle among nodes: ${cycle[1]} — the interpreter runs acyclic graphs; use a loop node to iterate`,
        );
      }
      return fail(`graph cannot be planned: ${err.message}`);
    }
    throw err;
  }

  return {
    ok: true,
    plan: { inputId: input.id, byId, levels, incoming, outgoing, bodies },
  };
}
