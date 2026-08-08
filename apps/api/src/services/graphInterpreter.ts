/**
 * Linear graph interpreter (W2 — stage 1 of the builder runtime).
 *
 * The visual builder could draw a graph and `compileGraph` could produce
 * a topological order, but NOTHING executed it: the canvas was a drawing.
 * This runs it.
 *
 * "Linear" is the honest scope. The interpreter walks one path from the
 * input node to an output node, taking exactly one outgoing edge per
 * node (a `condition` node picks which). Anything that needs a real
 * scheduler — loops, parallel fan-out, merges — is REFUSED BY NAME with
 * the reason, rather than silently traversing a single arbitrary branch
 * and reporting success. Full graph execution is the Wave 3 ticket.
 *
 * Node types that run:
 *   input      seeds the run value
 *   llm        real inference through the shared playground-parity path
 *   memory     retrieval from a knowledge base (real pgvector search)
 *   transform  DATA-driven text templating — never code
 *   condition  data-driven branch (shares the orchestration evaluator)
 *   delay      bounded wait
 *   output     terminates the run with the current value
 *
 * Node types that refuse, and why:
 *   code                 arbitrary user JS — the exact RCE the test
 *                        runner shipped and Wave 1 closed
 *   api                  needs a DNS-resolved SSRF guard; a hostname-only
 *                        check does not stop a name that resolves to a
 *                        private address
 *   tool                 tool calls belong to the llm node's agent config
 *   loop/parallel/merge  non-linear control flow — stage 2
 *
 * Every IO surface is injected: no models, no Prisma, no timers in tests.
 */

import {
  evaluateCondition,
  type MappingContext,
} from "./orchestrationMapping.js";

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

export interface GraphTraceEntry {
  nodeId: string;
  nodeType: string;
  label: string;
  status: "success" | "failed" | "refused";
  input: string | null;
  output: string | null;
  error: string | null;
  durationMs: number;
}

export interface GraphRunResult {
  status: "completed" | "failed";
  output: string | null;
  error: string | null;
  trace: GraphTraceEntry[];
}

export interface GraphInterpreterDeps {
  /** Real inference; the shared executor path in production. */
  runLlm: (args: {
    prompt: string;
    systemPrompt?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<{ content: string }>;
  /** Knowledge retrieval; returns formatted passages or null. */
  searchKnowledge?: (args: {
    knowledgeBaseId: string;
    query: string;
    limit: number;
  }) => Promise<{ text: string; mode: string } | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Node types the linear interpreter deliberately does not run. */
export const REFUSED_NODE_TYPES: Record<string, string> = {
  code: "the `code` node would execute user-supplied JavaScript in the API process — the same remote-code-execution hole the test runner shipped and Wave 1 closed. It stays refused until it runs in a real sandbox.",
  api: "the `api` node needs a DNS-resolved SSRF guard: a hostname-only check does not stop a name that resolves to a private address, so an arbitrary URL could reach internal services.",
  tool: "tool calls belong to the `llm` node's agent configuration; a standalone tool node has no execution contract yet.",
  loop: "loops are non-linear control flow — the linear interpreter (stage 1) walks one path. Full graph execution is a separate ticket.",
  parallel: "parallel fan-out is non-linear control flow — stage 1 walks one path.",
  merge: "merge joins parallel branches, which the linear interpreter never creates.",
};

const MAX_DELAY_MS = 30_000;

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * DATA-driven templating: `{{value}}` and `{{nodes.<id>}}` only. No
 * expression evaluation — same reasoning as the orchestration mapping
 * layer, which is why this stays a string substitution and not an
 * interpreter.
 */
export function renderTemplate(
  template: string,
  value: string,
  nodeOutputs: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, ref: string) => {
    if (ref === "value" || ref === "input") return value;
    if (ref.startsWith("nodes.")) {
      return nodeOutputs[ref.slice("nodes.".length)] ?? "";
    }
    return "";
  });
}

export async function runGraph(
  nodes: InterpretableNode[],
  edges: InterpretableEdge[],
  runInput: string,
  deps: GraphInterpreterDeps,
): Promise<GraphRunResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const trace: GraphTraceEntry[] = [];
  const nodeOutputs: Record<string, string> = {};

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, InterpretableEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }

  const inputNodes = nodes.filter((n) => n.type === "input");
  if (inputNodes.length === 0) {
    return {
      status: "failed",
      output: null,
      error: "graph has no input node — nothing to start from",
      trace,
    };
  }
  if (inputNodes.length > 1) {
    return {
      status: "failed",
      output: null,
      error: `graph has ${inputNodes.length} input nodes; the linear interpreter starts from exactly one`,
      trace,
    };
  }

  let current: InterpretableNode | undefined = inputNodes[0];
  let value = runInput;
  // A cycle would otherwise spin forever; bound the walk by node count.
  const maxSteps = nodes.length + 1;

  for (let stepCount = 0; current && stepCount <= maxSteps; stepCount++) {
    const node: InterpretableNode = current;
    const config = node.data.config ?? {};
    const label = node.data.label ?? node.id;
    const startedAt = now();
    const inputValue = value;

    const refusal = REFUSED_NODE_TYPES[node.type];
    if (refusal) {
      trace.push({
        nodeId: node.id,
        nodeType: node.type,
        label,
        status: "refused",
        input: inputValue,
        output: null,
        error: refusal,
        durationMs: now() - startedAt,
      });
      return {
        status: "failed",
        output: null,
        error: `node "${label}" (${node.type}) cannot run: ${refusal}`,
        trace,
      };
    }

    let branchHandle: string | undefined;

    try {
      switch (node.type) {
        case "input":
          // The run input seeds the walk; a configured default fills in
          // when the caller supplied nothing.
          if (value.trim().length === 0 && typeof config.default === "string") {
            value = config.default;
          }
          break;

        case "llm": {
          if (value.trim().length === 0) {
            throw new Error("llm node received an empty prompt");
          }
          const result = await deps.runLlm({
            prompt: value,
            systemPrompt:
              typeof config.systemPrompt === "string" ? config.systemPrompt : undefined,
            model: typeof config.model === "string" ? config.model : undefined,
            temperature:
              typeof config.temperature === "number" ? config.temperature : undefined,
            maxTokens:
              typeof config.maxTokens === "number" ? config.maxTokens : undefined,
          });
          value = result.content;
          break;
        }

        case "memory": {
          const knowledgeBaseId =
            typeof config.knowledgeBaseId === "string" ? config.knowledgeBaseId : null;
          if (!knowledgeBaseId) {
            throw new Error(
              "memory node has no knowledgeBaseId configured — pick a knowledge base for it to search",
            );
          }
          if (!deps.searchKnowledge) {
            throw new Error("knowledge retrieval is not available in this runtime");
          }
          const found = await deps.searchKnowledge({
            knowledgeBaseId,
            query: value,
            limit: typeof config.topK === "number" ? config.topK : 4,
          });
          // No hit is a legitimate outcome, not an error: the walk
          // continues with the query, and the trace shows the miss.
          value = found ? found.text : value;
          break;
        }

        case "transform": {
          const template =
            typeof config.template === "string" ? config.template : "{{value}}";
          value = renderTemplate(template, value, nodeOutputs);
          break;
        }

        case "condition": {
          const ctx: MappingContext = {
            input: { value },
            steps: Object.fromEntries(
              Object.entries(nodeOutputs).map(([k, v]) => [k, { output: v }]),
            ),
          };
          const spec = (config.condition ?? {
            left: "$.input.value",
            op: config.op ?? "contains",
            right: config.value,
          }) as Record<string, unknown>;
          const verdict = evaluateCondition(spec, ctx);
          branchHandle = verdict.run ? "true" : "false";
          break;
        }

        case "delay": {
          const ms = typeof config.ms === "number" ? config.ms : 0;
          if (ms < 0 || ms > MAX_DELAY_MS) {
            throw new Error(
              `delay must be between 0 and ${MAX_DELAY_MS}ms (got ${ms})`,
            );
          }
          await sleep(ms);
          break;
        }

        case "output":
          break;

        default:
          throw new Error(`unknown node type "${node.type}"`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace.push({
        nodeId: node.id,
        nodeType: node.type,
        label,
        status: "failed",
        input: inputValue,
        output: null,
        error: message,
        durationMs: now() - startedAt,
      });
      return {
        status: "failed",
        output: null,
        error: `node "${label}" failed: ${message}`,
        trace,
      };
    }

    nodeOutputs[node.id] = value;
    trace.push({
      nodeId: node.id,
      nodeType: node.type,
      label,
      status: "success",
      input: inputValue,
      output: asString(value),
      error: null,
      durationMs: now() - startedAt,
    });

    if (node.type === "output") {
      return { status: "completed", output: value, error: null, trace };
    }

    // --- pick the next node ---
    const next = outgoing.get(node.id) ?? [];
    if (next.length === 0) {
      return {
        status: "failed",
        output: null,
        error: `node "${label}" has no outgoing edge and is not an output node — the path ends nowhere`,
        trace,
      };
    }

    let chosen: InterpretableEdge | undefined;
    if (node.type === "condition") {
      chosen =
        next.find((e) => (e.sourceHandle ?? e.label) === branchHandle) ??
        // A condition wired with a single unlabeled edge is ambiguous;
        // taking it only on the true branch keeps the gate meaningful.
        (branchHandle === "true" && next.length === 1 ? next[0] : undefined);
      if (!chosen) {
        return {
          status: "completed",
          output: value,
          error: null,
          trace,
        };
      }
    } else {
      if (next.length > 1) {
        return {
          status: "failed",
          output: null,
          error: `node "${label}" has ${next.length} outgoing edges; the linear interpreter (stage 1) follows exactly one path. Branching belongs to a condition node, and true fan-out needs the full graph engine.`,
          trace,
        };
      }
      chosen = next[0];
    }

    if (!chosen) {
      return {
        status: "failed",
        output: null,
        error: `node "${label}" resolved no outgoing edge to follow`,
        trace,
      };
    }

    const target = byId.get(chosen.target);
    if (!target) {
      return {
        status: "failed",
        output: null,
        error: `edge ${chosen.id} points at missing node ${chosen.target}`,
        trace,
      };
    }
    current = target;
  }

  return {
    status: "failed",
    output: null,
    error:
      "graph walk exceeded its step budget — the path revisits nodes (a cycle needs the loop node, which stage 1 does not run)",
    trace,
  };
}
