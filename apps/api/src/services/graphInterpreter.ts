/**
 * Graph interpreter (W2 stage 2 of the builder runtime).
 *
 * The visual builder draws a graph; this runs it. Stage 1 walked one path
 * and refused everything non-linear. This executes a DAG: the graph is
 * planned up front (services/graphPlan.ts: validation, cycle detection,
 * topological levels) and then run level by level, with the nodes of a
 * level running concurrently under a cap.
 *
 * Node types that run:
 *   input      seeds the run value
 *   llm        real inference through the shared chat path (agent tools work)
 *   memory     retrieval from a knowledge base (real pgvector search)
 *   transform  DATA-driven text templating - never code
 *   condition  data-driven branch (shares the orchestration evaluator)
 *   delay      bounded wait
 *   api        HTTP call through the SSRF guard, with timeout + size caps
 *   tool       runs a skills-registry skill (same availability rules as chat)
 *   loop       bounded iteration over a list/count, running a linear sub-path
 *   parallel   fans out to branches that run concurrently (capped)
 *   merge      joins branch outputs (array, object keyed by node id, or text)
 *   code       runs in the EXTERNAL sandbox only when one is configured
 *   output     terminates the run with the current value
 *
 * What is still refused, by name, with the reason:
 *   - `code` without a configured sandbox runner. Arbitrary user code never
 *     runs in the API process (the test runner's `new Function()` was a
 *     remote-code-execution hole that Wave 1 closed).
 *   - a `tool` whose skill is unavailable (provider not configured, ...)
 *   - malformed graphs: no/multiple inputs, cycles, fan-out from anything but
 *     a parallel node, a loop without exactly one `body` edge, a loop body
 *     that is not a linear chain, several active branches feeding a
 *     non-merge node, several output nodes reached.
 *
 * Every IO surface is injected: no models, no Prisma, no network, no timers
 * in tests.
 */

import { safeFetch, type SafeFetchOptions } from "../lib/ssrfGuard.js";
import {
  edgeHandle,
  labelOf,
  planGraph,
  type InterpretableEdge,
  type InterpretableNode,
} from "./graphPlan.js";
import {
  evaluateCondition,
  type MappingContext,
} from "./orchestrationMapping.js";
import {
  clipText,
  describeFetchFailure,
  readBodyCapped,
  sanitizeOutboundHeaders,
} from "./skills/httpLimits.js";
import type { SkillRegistry } from "./skills/registry.js";
import type { SandboxRunner } from "./skills/sandboxRunner.js";
import type { SkillDefinition, ToolMode } from "./skills/types.js";

export type { InterpretableEdge, InterpretableNode } from "./graphPlan.js";

export interface GraphTraceEntry {
  nodeId: string;
  nodeType: string;
  label: string;
  status: "success" | "failed" | "refused";
  input: string | null;
  output: string | null;
  error: string | null;
  durationMs: number;
  /** 0-based iteration when the node ran inside a loop body. */
  iteration?: number;
  /** The loop node whose body this entry belongs to. */
  loopId?: string;
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
    /** Narrows the agent's enabled tools for this node (never widens). */
    tools?: string[];
    signal?: AbortSignal;
  }) => Promise<{ content: string }>;
  /** Knowledge retrieval; returns formatted passages or null. */
  searchKnowledge?: (args: {
    knowledgeBaseId: string;
    query: string;
    limit: number;
  }) => Promise<{ text: string; mode: string } | null>;
  /** Skills for `tool` nodes. Absent => tool nodes refuse. */
  skills?: SkillRegistry;
  /**
   * The tools the agent's owner enabled. A `tool` node may only NARROW this
   * set, exactly like an llm node's `tools`: naming a skill the agent does
   * not have is refused. Absent means none are enabled.
   */
  enabledTools?: readonly string[];
  /** Agent scope the skills run under (files, knowledge base). */
  toolContext?: { agentId: string; orgId: string };
  /**
   * The mode tools run in. "graph" by default; "trial" for a marketplace
   * buyer's run, which withholds money-moving skills.
   */
  toolMode?: ToolMode;
  /** SSRF-guarded fetch for `api` nodes. Defaults to the real guard. */
  httpFetch?: (url: string, options: SafeFetchOptions) => Promise<Response>;
  /** External code sandbox for `code` nodes. Absent/null => code refuses. */
  sandbox?: SandboxRunner | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Caller cancellation (client gone). Combined with the run's own deadline. */
  signal?: AbortSignal;
  limits?: Partial<GraphLimits>;
}

export interface GraphLimits {
  maxDelayMs: number;
  /** Total `delay` time across the whole run, loop iterations included. */
  maxTotalDelayMs: number;
  /** Wall-clock budget for the whole run. */
  maxRunMs: number;
  loopHardCap: number;
  parallelDefault: number;
  parallelHardCap: number;
  maxNodeRuns: number;
  apiTimeoutMs: number;
  apiMaxTimeoutMs: number;
  apiMaxResponseBytes: number;
  apiHardMaxResponseBytes: number;
}

export const GRAPH_LIMITS: GraphLimits = {
  maxDelayMs: 30_000,
  /** A loop of delays must not pin a request for minutes. */
  maxTotalDelayMs: 60_000,
  /** Nothing a graph does may hold a request (and its charge) longer. */
  maxRunMs: 300_000,
  /** Absolute ceiling on loop iterations, whatever a node asks for. */
  loopHardCap: 20,
  /** Default and ceiling for nodes of one level running at once. */
  parallelDefault: 4,
  parallelHardCap: 8,
  /** Node executions per run (loop body runs included). */
  maxNodeRuns: 200,
  apiTimeoutMs: 10_000,
  apiMaxTimeoutMs: 30_000,
  apiMaxResponseBytes: 64 * 1024,
  apiHardMaxResponseBytes: 256 * 1024,
};

/**
 * Node types refused outright, with the reason the builder shows. `code` is
 * only refused while no sandbox runner is configured.
 */
export const REFUSED_NODE_TYPES: Record<string, string> = {
  code: "the `code` node would run user-supplied code, which never happens in the API process (that was the remote-code-execution hole the test runner shipped and Wave 1 closed). It runs only in an external sandbox, and no sandbox is configured on this server (SANDBOX_RUNNER_URL).",
};

/** A node the interpreter deliberately will not run (not a crash). */
class RefusedError extends Error {}

const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

const hasOwn = (obj: object, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);

/**
 * DATA-driven templating: `{{value}}`, `{{nodes.<id>}}` and, inside a loop
 * body, `{{item}}` / `{{index}}`. No expression evaluation - same reasoning
 * as the orchestration mapping layer, which is why this stays a string
 * substitution and not an interpreter.
 *
 * Two data filters exist for building requests safely:
 *   {{value | json}}       a JSON string literal (quotes and escapes included)
 *   {{value | urlencode}}  percent-encoded, for query strings and paths
 * An unknown filter is an error, not an empty string.
 */
export function renderTemplate(
  template: string,
  value: string,
  nodeOutputs: Record<string, string>,
  vars: Record<string, string> = {},
): string {
  return template.replace(
    /\{\{\s*([\w.-]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g,
    (_match, ref: string, filter: string | undefined) => {
      let out = "";
      if (ref === "value" || ref === "input") {
        out = value;
      } else if (hasOwn(vars, ref)) {
        out = vars[ref] ?? "";
      } else if (ref.startsWith("nodes.")) {
        const id = ref.slice("nodes.".length);
        out = hasOwn(nodeOutputs, id) ? (nodeOutputs[id] ?? "") : "";
      }
      if (filter === undefined) return out;
      if (filter === "json") return JSON.stringify(out);
      if (filter === "urlencode") return encodeURIComponent(out);
      throw new Error(`unknown template filter "${filter}" (use json or urlencode)`);
    },
  );
}

interface Scope {
  item?: string;
  index?: number;
  /** Set when running inside a loop body. */
  iteration?: number;
  loopId?: string;
}

type NodeRun =
  | { ok: true; entries: GraphTraceEntry[]; value: string; branch?: string }
  | { ok: false; entries: GraphTraceEntry[]; error: string };

/** Runs items through `fn` with at most `cap` in flight; keeps order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  cap: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(cap, 1), items.length) }, worker),
  );
  return results;
}

/**
 * Settles with `promise`, or rejects as soon as `signal` aborts - whichever is
 * first. Work that ignores the signal keeps running in the background, but the
 * run stops waiting for it.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The abandoned promise may reject later; that must not be unhandled.
    promise.catch(() => {});
    return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** The one string parameter an incoming value can be fed to by default. */
function primaryStringParam(skill: SkillDefinition): string | null {
  const props = skill.inputSchema.properties;
  const isString = (name: string) => props[name]?.type === "string";
  const required = (skill.inputSchema.required ?? []).find(isString);
  return required ?? Object.keys(props).find(isString) ?? null;
}

export async function runGraph(
  nodes: InterpretableNode[],
  edges: InterpretableEdge[],
  runInput: string,
  deps: GraphInterpreterDeps,
): Promise<GraphRunResult> {
  const now = deps.now ?? (() => Date.now());
  const limits = { ...GRAPH_LIMITS, ...deps.limits };

  const trace: GraphTraceEntry[] = [];

  const planned = planGraph(nodes, edges);
  if (!planned.ok) {
    return { status: "failed", output: null, error: planned.error, trace };
  }
  const plan = planned.plan;

  // The run's own clock. However long its nodes take (a loop of delays, an
  // llm node that hangs), the run ends at maxRunMs, and it ends as soon as the
  // caller cancels - so a closed tab stops the work and the charge can refund.
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, limits.maxRunMs);
  const signal: AbortSignal = deps.signal
    ? AbortSignal.any([deps.signal, deadline.signal])
    : deadline.signal;
  const abortMessage = () =>
    timedOut
      ? `run exceeded its time budget of ${limits.maxRunMs}ms`
      : "run cancelled";

  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      }));
  let delayUsedMs = 0;

  // The run itself is a function so the node runners below sit at a function
  // body root; the try/finally around the call only owns the deadline timer.
  const execute = async (): Promise<GraphRunResult> => {
    const outputs: Record<string, string> = Object.create(null);
    const activeEdges = new Set<string>();
    const mergeInputs = new Map<string, Array<{ sourceId: string; value: string }>>();
    const reachedOutputs: Array<{ id: string; label: string; value: string }> = [];
    /** Value at the last condition whose chosen branch had no edge. */
    let gatedValue: string | null = null;
    let nodeRuns = 0;

    const cancelled = (): GraphRunResult => ({
      status: "failed",
      output: null,
      error: abortMessage(),
      trace,
    });

    // --------------------------------------------------------------------
    // One node, one execution (also used for loop body nodes)
    // --------------------------------------------------------------------
    async function runNode(
      node: InterpretableNode,
      inputValue: string,
      scope: Scope,
    ): Promise<NodeRun> {
      const label = labelOf(node);
      const startedAt = now();
      const entries: GraphTraceEntry[] = [];
      const base = {
        nodeId: node.id,
        nodeType: node.type,
        label,
        input: inputValue,
        ...(scope.iteration !== undefined
          ? { iteration: scope.iteration, loopId: scope.loopId }
          : {}),
      };

      try {
        if (++nodeRuns > limits.maxNodeRuns) {
          throw new Error(
            `graph exceeded its step budget of ${limits.maxNodeRuns} node executions`,
          );
        }
        if (signal.aborted) throw new Error(abortMessage());

        const result = await abortable(
          executeNode(node, inputValue, scope, entries),
          signal,
        );
        outputs[node.id] = result.value;
        entries.push({
          ...base,
          status: "success",
          output: asString(result.value),
          error: null,
          durationMs: now() - startedAt,
        });
        return { ok: true, entries, value: result.value, branch: result.branch };
      } catch (err) {
        // An abort surfaces as whatever the interrupted call threw; say what
        // actually happened instead.
        const message = signal.aborted
          ? abortMessage()
          : err instanceof Error
            ? err.message
            : String(err);
        const refused = !signal.aborted && err instanceof RefusedError;
        entries.push({
          ...base,
          status: refused ? "refused" : "failed",
          output: null,
          error: message,
          durationMs: now() - startedAt,
        });
        return {
          ok: false,
          entries,
          error: signal.aborted
            ? message
            : refused
              ? `node "${label}" (${node.type}) cannot run: ${message}`
              : `node "${label}" failed: ${message}`,
        };
      }
    }

    const render = (template: string, value: string, scope: Scope): string => {
      const vars: Record<string, string> = {};
      if (scope.item !== undefined) vars.item = scope.item;
      if (scope.index !== undefined) vars.index = String(scope.index);
      return renderTemplate(template, value, outputs, vars);
    };

    async function executeNode(
      node: InterpretableNode,
      value: string,
      scope: Scope,
      entries: GraphTraceEntry[],
    ): Promise<{ value: string; branch?: string }> {
      const config = node.data.config ?? {};

      switch (node.type) {
        case "input":
          // The run input seeds the walk; a configured default fills in when
          // the caller supplied nothing.
          if (value.trim().length === 0 && typeof config.default === "string") {
            return { value: config.default };
          }
          return { value };

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
            maxTokens: typeof config.maxTokens === "number" ? config.maxTokens : undefined,
            tools: Array.isArray(config.tools)
              ? config.tools.filter((t): t is string => typeof t === "string")
              : undefined,
            signal,
          });
          return { value: result.content };
        }

        case "memory": {
          const knowledgeBaseId =
            typeof config.knowledgeBaseId === "string" && config.knowledgeBaseId
              ? config.knowledgeBaseId
              : null;
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
          // No hit is a legitimate outcome, not an error: the walk continues
          // with the query, and the trace shows the miss.
          return { value: found ? found.text : value };
        }

        case "transform": {
          const template =
            typeof config.template === "string" && config.template !== ""
              ? config.template
              : "{{value}}";
          return { value: render(template, value, scope) };
        }

        case "condition": {
          const ctx: MappingContext = {
            input: { value },
            steps: Object.fromEntries(
              Object.entries(outputs).map(([k, v]) => [k, { output: v }]),
            ),
          };
          const spec = (config.condition ?? {
            left: "$.input.value",
            op: config.op ?? "contains",
            right: config.value,
          }) as Record<string, unknown>;
          const verdict = evaluateCondition(spec, ctx);
          return { value, branch: verdict.run ? "true" : "false" };
        }

        case "delay": {
          // `ms` is canonical; `duration` is what the builder's first forms wrote.
          const raw = config.ms ?? config.duration;
          const ms = typeof raw === "number" ? raw : 0;
          if (ms < 0 || ms > limits.maxDelayMs) {
            throw new Error(`delay must be between 0 and ${limits.maxDelayMs}ms (got ${ms})`);
          }
          // Checked BEFORE sleeping: a loop of delays must not be able to spend
          // minutes before anything notices.
          if (delayUsedMs + ms > limits.maxTotalDelayMs) {
            throw new Error(
              `the run's total delay budget of ${limits.maxTotalDelayMs}ms would be exceeded (${delayUsedMs}ms already used)`,
            );
          }
          delayUsedMs += ms;
          await abortable(sleep(ms), signal);
          return { value };
        }

        case "output":
          return { value };

        case "api":
          return { value: await runApiNode(config, value, scope) };

        case "tool":
          return { value: await runToolNode(config, value, scope) };

        case "code":
          return { value: await runCodeNode(config, value) };

        case "parallel":
          // The fan-out itself is the planner's levels; the value is broadcast.
          return { value };

        case "merge":
          return { value: mergeValues(config, mergeInputs.get(node.id) ?? []) };

        case "loop":
          return { value: await runLoopNode(node, config, value, entries) };

        default:
          throw new Error(`unknown node type "${node.type}"`);
      }
    }

    // --------------------------------------------------------------------
    // api
    // --------------------------------------------------------------------
    async function runApiNode(
      config: Record<string, unknown>,
      value: string,
      scope: Scope,
    ): Promise<string> {
      const method = asString(config.method || "GET").toUpperCase();
      if (!API_METHODS.has(method)) {
        throw new Error(`unsupported method "${method}" (use ${[...API_METHODS].join(", ")})`);
      }
      const urlTemplate = typeof config.url === "string" ? config.url.trim() : "";
      if (!urlTemplate) throw new Error("api node has no url configured");
      // Resolved from the template HERE and validated by the SSRF guard inside
      // the fetch: a url built from upstream data gets exactly the same checks
      // (DNS-resolved address validation, re-validated redirects) as a literal.
      const url = render(urlTemplate, value, scope);

      const rawHeaders: Record<string, string> = {};
      if (config.headers !== undefined && config.headers !== null) {
        if (typeof config.headers !== "object" || Array.isArray(config.headers)) {
          throw new Error("api node headers must be an object of name -> value");
        }
        for (const [name, v] of Object.entries(config.headers as Record<string, unknown>)) {
          if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
            throw new Error(`api node header "${name}" must be text`);
          }
          rawHeaders[name] = render(String(v), value, scope);
        }
      }
      const headers = sanitizeOutboundHeaders(rawHeaders);

      const body =
        typeof config.body === "string" &&
        config.body !== "" &&
        method !== "GET" &&
        method !== "HEAD"
          ? render(config.body, value, scope)
          : undefined;

      const timeoutMs = clampInt(config.timeoutMs, 1_000, limits.apiMaxTimeoutMs, limits.apiTimeoutMs);
      const maxBytes = clampInt(
        config.maxResponseBytes,
        1_024,
        limits.apiHardMaxResponseBytes,
        limits.apiMaxResponseBytes,
      );

      const fetcher = deps.httpFetch ?? safeFetch;
      let res: Response;
      try {
        res = await fetcher(url, {
          method,
          headers,
          body,
          timeoutMs,
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err;
        // The trace is stored and shown: no resolved addresses in it.
        throw new Error(describeFetchFailure(err, "graph api node"));
      }
      const read = await readBodyCapped(res, {
        maxBytes,
        timeoutMs,
        signal,
      });

      let text = read.text;
      if (read.truncated) {
        if (config.onOversize === "truncate") {
          text += `\n...[response truncated at ${maxBytes} bytes]`;
        } else {
          throw new Error(
            `response is larger than ${maxBytes} bytes (set onOversize to "truncate" to keep the first ${maxBytes})`,
          );
        }
      }
      if (!res.ok && config.failOnHttpError !== false) {
        throw new Error(`HTTP ${res.status}: ${clipText(text, 300)}`);
      }
      return text;
    }

    // --------------------------------------------------------------------
    // tool
    // --------------------------------------------------------------------
    async function runToolNode(
      config: Record<string, unknown>,
      value: string,
      scope: Scope,
    ): Promise<string> {
      const key = [config.toolName, config.tool, config.skill].find(
        (k): k is string => typeof k === "string" && k.length > 0,
      );
      if (!key) throw new Error("tool node has no tool selected");
      if (!deps.skills) {
        throw new RefusedError("the skills registry is not available in this runtime");
      }
      // The agent's owner decides which tools exist for it; a node can only
      // narrow that, never add a tool (the same rule llm nodes follow).
      if (!(deps.enabledTools ?? []).includes(key)) {
        throw new RefusedError(
          `tool "${key}" is not enabled on this agent — select this node in the builder and choose "Enable on this agent", or add it to the agent's tools (PATCH /api/agents/:id)`,
        );
      }
      const skill = deps.skills.get(key);
      if (!skill) {
        throw new Error(
          `unknown tool "${key}" (available: ${deps.skills
            .list()
            .map((s) => s.key)
            .join(", ")})`,
        );
      }

      const input = buildToolInput(skill, config, value, scope);
      const result = await deps.skills.execute(key, input, {
        mode: deps.toolMode ?? "graph",
        agentId: deps.toolContext?.agentId ?? "",
        orgId: deps.toolContext?.orgId ?? "",
        signal,
      });
      switch (result.status) {
        case "ok":
          return result.output;
        case "unavailable":
          throw new RefusedError(`unavailable: ${result.reason}`);
        case "error":
          throw new Error(result.message);
      }
    }

    function buildToolInput(
      skill: SkillDefinition,
      config: Record<string, unknown>,
      value: string,
      scope: Scope,
    ): unknown {
      // Only VALUES are templated, never keys or structure: a model-influenced
      // upstream string cannot add or rename an argument.
      const renderDeep = (v: unknown): unknown => {
        if (typeof v === "string") return render(v, value, scope);
        if (Array.isArray(v)) return v.map(renderDeep);
        if (v && typeof v === "object") {
          return Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, renderDeep(x)]),
          );
        }
        return v;
      };

      const raw = config.input;
      if (raw && typeof raw === "object") return renderDeep(raw);

      const primary = primaryStringParam(skill);
      if (typeof raw === "string" && raw.trim() !== "") {
        const text = raw.trim();
        if (text.startsWith("{")) {
          try {
            const parsed: unknown = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return renderDeep(parsed);
            }
          } catch {
            // Not JSON: a plain template for the primary parameter.
          }
        }
        if (!primary) {
          throw new Error(
            `tool "${skill.key}" takes structured input: set config.input to a JSON object`,
          );
        }
        return { [primary]: render(raw, value, scope) };
      }
      if (!primary) {
        throw new Error(
          `tool "${skill.key}" has no single text parameter to feed the incoming value to: set config.input to a JSON object`,
        );
      }
      return { [primary]: value };
    }

    // --------------------------------------------------------------------
    // code
    // --------------------------------------------------------------------
    async function runCodeNode(config: Record<string, unknown>, value: string): Promise<string> {
      const sandbox = deps.sandbox;
      if (!sandbox) throw new RefusedError(REFUSED_NODE_TYPES.code!);

      const code = typeof config.code === "string" ? config.code : "";
      if (code.trim() === "") throw new Error("code node has no code");
      const language = typeof config.language === "string" && config.language ? config.language : "python";

      // Runs in the EXTERNAL sandbox. The incoming value arrives on stdin; the
      // program's stdout becomes the node's output. The code text is not
      // templated - data must never become code.
      const result = await sandbox.run(language, code, sandbox.limits, {
        stdin: value,
        signal,
      });
      if (result.timedOut) {
        throw new Error(`code timed out after ${sandbox.limits.timeoutMs}ms and was killed`);
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `code exited with status ${result.exitCode}: ${clipText(result.stderr, 500) || "(no stderr)"}`,
        );
      }
      if (result.truncated) {
        throw new Error(
          `code output exceeded the ${sandbox.limits.maxOutputBytes}-byte limit and was cut off`,
        );
      }
      return result.stdout.replace(/\r?\n$/, "");
    }

    // --------------------------------------------------------------------
    // merge
    // --------------------------------------------------------------------
    function mergeValues(
      config: Record<string, unknown>,
      inputs: Array<{ sourceId: string; value: string }>,
    ): string {
      const mode = config.mode ?? "array";
      if (mode === "array") return JSON.stringify(inputs.map((i) => i.value));
      if (mode === "object") {
        return JSON.stringify(Object.fromEntries(inputs.map((i) => [i.sourceId, i.value])));
      }
      if (mode === "join") {
        const separator = typeof config.separator === "string" ? config.separator : "\n\n";
        return inputs.map((i) => i.value).join(separator);
      }
      throw new Error(`unknown merge mode "${asString(mode)}" (use array, object or join)`);
    }

    // --------------------------------------------------------------------
    // loop
    // --------------------------------------------------------------------
    const loopTooLong = (count: number, cap: number) =>
      new Error(
        `loop has ${count} items but is limited to ${cap} iterations (hard limit ${limits.loopHardCap}) — shorten the list or split the work`,
      );

    function resolveLoopItems(
      config: Record<string, unknown>,
      value: string,
      cap: number,
    ): string[] {
      const mode =
        config.mode === "count" || (config.mode === undefined && typeof config.count === "number")
          ? "count"
          : "list";

      if (mode === "count") {
        const count = config.count;
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
          throw new Error("loop count must be a non-negative whole number");
        }
        if (count > cap) throw loopTooLong(count, cap);
        return Array.from({ length: count }, (_, i) => String(i));
      }

      const source = render(
        typeof config.list === "string" && config.list !== "" ? config.list : "{{value}}",
        value,
        {},
      );
      if (config.format === "lines") {
        return source.split(/\r?\n/).filter((line) => line.trim().length > 0);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch {
        throw new Error(
          `loop list is not a JSON array (got: ${clipText(source, 80)}). Feed it a JSON array, or set format to "lines" to iterate text lines`,
        );
      }
      if (!Array.isArray(parsed)) {
        throw new Error("loop list must be a JSON array");
      }
      return parsed.map((el) => (typeof el === "string" ? el : JSON.stringify(el)));
    }

    async function runLoopNode(
      node: InterpretableNode,
      config: Record<string, unknown>,
      value: string,
      entries: GraphTraceEntry[],
    ): Promise<string> {
      const body = plan.bodies.get(node.id) ?? [];
      const cap = clampInt(config.maxIterations, 1, limits.loopHardCap, limits.loopHardCap);
      const items = resolveLoopItems(config, value, cap);
      if (items.length > cap) throw loopTooLong(items.length, cap);

      const results: string[] = [];
      for (const [index, item] of items.entries()) {
        let current = item;
        for (const bodyNode of body) {
          const run = await runNode(bodyNode, current, {
            item,
            index,
            iteration: index,
            loopId: node.id,
          });
          entries.push(...run.entries);
          if (!run.ok) throw new Error(`iteration ${index} stopped: ${run.error}`);
          current = run.value;
        }
        results.push(current);
      }

      const collect = config.collect ?? "array";
      if (collect === "array") return JSON.stringify(results);
      if (collect === "last") return results.at(-1) ?? "";
      if (collect === "join") {
        return results.join(typeof config.separator === "string" ? config.separator : "\n");
      }
      throw new Error(`unknown loop collect mode "${asString(collect)}" (use array, last or join)`);
    }

    // --------------------------------------------------------------------
    // The scheduler: level by level
    // --------------------------------------------------------------------
    const failedResult = (error: string): GraphRunResult => ({
      status: "failed",
      output: null,
      error,
      trace,
    });

    for (const level of plan.levels) {
      if (signal.aborted) return cancelled();

      const runnable: Array<{ node: InterpretableNode; input: string }> = [];

      for (const node of level) {
        if (node.id === plan.inputId) {
          runnable.push({ node, input: runInput });
          continue;
        }
        const activeIn = (plan.incoming.get(node.id) ?? []).filter((e) => activeEdges.has(e.id));
        // Not reached on this run (a condition took another branch): skipped.
        if (activeIn.length === 0) continue;

        if (node.type === "merge") {
          const collected = activeIn.map((e) => ({
            sourceId: e.source,
            value: outputs[e.source] ?? "",
          }));
          mergeInputs.set(node.id, collected);
          runnable.push({ node, input: collected.map((c) => c.value).join("\n") });
          continue;
        }
        if (activeIn.length > 1) {
          const label = labelOf(node);
          const sources = activeIn.map((e) => e.source).join(", ");
          trace.push({
            nodeId: node.id,
            nodeType: node.type,
            label,
            status: "failed",
            input: null,
            output: null,
            error: `receives ${activeIn.length} active branches (${sources})`,
            durationMs: 0,
          });
          return failedResult(
            `node "${label}" receives ${activeIn.length} active branches (${sources}); join them with a merge node`,
          );
        }
        runnable.push({ node, input: outputs[activeIn[0]!.source] ?? "" });
      }

      // How many of this level's nodes may run at once: the run default, or -
      // when parallel nodes feed the level - the smallest `maxConcurrency` they
      // ask for (raised or lowered, never past the hard ceiling).
      const defaultCap = clampInt(limits.parallelDefault, 1, limits.parallelHardCap, 4);
      const feeders: number[] = [];
      for (const { node } of runnable) {
        for (const edge of plan.incoming.get(node.id) ?? []) {
          const source = plan.byId.get(edge.source);
          if (source?.type === "parallel") {
            feeders.push(
              clampInt(source.data.config?.maxConcurrency, 1, limits.parallelHardCap, defaultCap),
            );
          }
        }
      }
      const cap = feeders.length > 0 ? Math.min(...feeders) : defaultCap;

      const runs = await mapWithConcurrency(runnable, cap, (r) =>
        runNode(r.node, r.input, {}),
      );
      // Entries are appended in plan order, not completion order, so a trace is
      // the same every time the same graph runs.
      for (const run of runs) trace.push(...run.entries);

      if (signal.aborted) return cancelled();

      const firstFailure = runs.find((r) => !r.ok);
      if (firstFailure && !firstFailure.ok) return failedResult(firstFailure.error);

      for (const [i, run] of runs.entries()) {
        if (!run.ok) continue;
        const node = runnable[i]!.node;
        const out = plan.outgoing.get(node.id) ?? [];

        if (node.type === "output") {
          reachedOutputs.push({ id: node.id, label: labelOf(node), value: run.value });
          continue;
        }
        if (out.length === 0) {
          return failedResult(
            `node "${labelOf(node)}" has no outgoing edge and is not an output node — the path ends nowhere`,
          );
        }

        let chosen = out;
        if (node.type === "condition") {
          chosen = out.filter((e) => edgeHandle(e) === run.branch);
          // A condition wired with a single unlabeled edge is ambiguous; taking
          // it only on the true branch keeps the gate meaningful.
          if (chosen.length === 0 && run.branch === "true") {
            chosen = out.filter((e) => edgeHandle(e) === undefined);
          }
          if (chosen.length === 0) {
            // The branch taken has no edge: this path stops here by design.
            gatedValue = run.value;
            continue;
          }
        }
        for (const edge of chosen) activeEdges.add(edge.id);
      }
    }

    if (reachedOutputs.length === 1) {
      const only = reachedOutputs[0]!;
      return { status: "completed", output: only.value, error: null, trace };
    }
    if (reachedOutputs.length > 1) {
      return failedResult(
        `graph reached ${reachedOutputs.length} output nodes (${reachedOutputs
          .map((o) => `"${o.label}"`)
          .join(", ")}); join the branches with a merge node so exactly one output node runs`,
      );
    }
    if (gatedValue !== null) {
      return { status: "completed", output: gatedValue, error: null, trace };
    }
    return failedResult("graph finished without reaching an output node");
  };

  try {
    return await execute();
  } finally {
    clearTimeout(timer);
  }
}
