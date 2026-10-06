/**
 * What a marketplace install copies of how an agent ANSWERS.
 *
 * An agent answers either as a chat (prompt, model, tools) or by running its
 * saved graph (Agent.entrypoint = "graph"). The install used to copy the chat
 * fields only, so a buyer's copy of a graph agent answered as a plain chat
 * agent: a different product from the one they installed. The copy now
 * carries the entrypoint and the graph.
 *
 * The rule for secrets is the install's own: the publisher's are never
 * copied into the buyer's organization, and the buyer can open the copied
 * graph in the builder. A graph template cannot read the agent's variables,
 * so a publisher's credential for an outbound request can only be a literal
 * in the node, and it can sit anywhere in the request: a header of any name,
 * the query string, the URL's path (a bot token, a webhook URL), the body.
 * Nothing about a literal says whether it is one. So the fields that make
 * up an outbound request or a program are copied only where they are built
 * from template references alone; literal text in them stays with the
 * publisher. That covers:
 *
 *   api node             url, each header, body
 *   code node            code
 *   tool node            input, when the tool is http_request or
 *                        code_interpreter (the same request, the same code)
 *
 * The node itself, its label, method, limits and edges are kept. Each node
 * that lost a field is named in `needsConfiguration`, and the copied graph
 * is marked invalid with one message per node, so the buyer is told what to
 * fill in with their own endpoint and key rather than finding out from a
 * failed run.
 *
 * Pure.
 */

export interface SourceGraph {
  nodes: unknown;
  edges: unknown;
  viewport?: unknown;
  isValid?: boolean | null;
  validationErrors?: unknown;
}

/** A copied node whose request or code the buyer has to supply. */
export interface NodeNeedingConfiguration {
  nodeId: string;
  label: string;
  type: string;
  /** What was not copied: "url", "headers.<name>", "body", "code", "input". */
  fields: string[];
}

export interface ClonedGraph {
  nodes: unknown[];
  edges: unknown[];
  viewport: unknown;
  isValid: boolean;
  validationErrors: unknown;
  needsConfiguration: NodeNeedingConfiguration[];
}

export interface ClonedBehaviour {
  entrypoint: "chat" | "graph";
  /** null when the source agent has no saved graph. */
  graph: ClonedGraph | null;
}

/**
 * One template reference exactly as the interpreter resolves it
 * (renderTemplate in graphInterpreter.ts), narrowed to the names it knows:
 * a `{{...}}` it would render as nothing is literal text here, so a secret
 * cannot ride along dressed as a reference.
 */
const REFERENCE = /\{\{\s*(?:value|input|item|index|nodes\.[\w.-]+)\s*(?:\|\s*(?:json|urlencode)\s*)?\}\}/g;

/** True when the text holds nothing but template references and whitespace. */
export function isReferenceOnly(text: unknown): boolean {
  return typeof text === "string" && text.replace(REFERENCE, "").trim() === "";
}

/** Tools whose input is an outbound request or a program. */
const REQUEST_TOOLS = new Set(["http_request", "code_interpreter"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** Every leaf is a reference-only string; keys are argument names, not data. */
function isReferenceOnlyDeep(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isReferenceOnlyDeep);
  if (isRecord(value)) return Object.values(value).every(isReferenceOnlyDeep);
  return isReferenceOnly(value);
}

/** A tool node's input: an object, JSON text of one, or a plain template. */
function toolInputIsReferenceOnly(input: unknown): boolean {
  if (typeof input !== "string") return isReferenceOnlyDeep(input);
  if (isReferenceOnly(input)) return true;
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) && isReferenceOnlyDeep(parsed);
  } catch {
    return false;
  }
}

/** The node's config without its literal request or code, and what was left out. */
function withoutLiteralRequest(
  type: unknown,
  config: Record<string, unknown>,
): { config: Record<string, unknown>; fields: string[] } {
  const copy = { ...config };
  const fields: string[] = [];
  const withhold = (key: string) => {
    delete copy[key];
    fields.push(key);
  };

  if (type === "api") {
    if (present(config.url) && !isReferenceOnly(config.url)) withhold("url");
    if (isRecord(config.headers)) {
      const kept: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(config.headers)) {
        if (isReferenceOnly(value)) kept[name] = value;
        else fields.push(`headers.${name}`);
      }
      copy.headers = kept;
    } else if (present(config.headers)) {
      withhold("headers");
    }
    if (present(config.body) && !isReferenceOnly(config.body)) withhold("body");
  } else if (type === "code") {
    if (present(config.code)) withhold("code");
  } else if (type === "tool") {
    // The same keys, in the same order, as the interpreter's tool node.
    const tool = [config.toolName, config.tool, config.skill].find(
      (k): k is string => typeof k === "string" && k.length > 0,
    );
    if (tool && REQUEST_TOOLS.has(tool) && present(config.input) && !toolInputIsReferenceOnly(config.input)) {
      withhold("input");
    }
  }
  return { config: copy, fields };
}

function describe(node: NodeNeedingConfiguration): string {
  return `Node "${node.label}" (${node.type}) was installed without its ${node.fields.join(", ")}: the publisher's request details and code are not copied. Set your own before running this agent.`;
}

export function cloneAgentBehaviour(source: {
  entrypoint?: string | null;
  graph?: SourceGraph | null;
}): ClonedBehaviour {
  // Copied even when the graph is missing: the copy then answers the same
  // named agent_graph_missing the original does.
  const entrypoint = source.entrypoint === "graph" ? "graph" : "chat";
  const graph = source.graph ?? null;
  if (!graph) return { entrypoint, graph: null };

  const needsConfiguration: NodeNeedingConfiguration[] = [];
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : []).map((node: unknown) => {
    if (!isRecord(node) || !isRecord(node.data) || !isRecord(node.data.config)) return node;
    const { config, fields } = withoutLiteralRequest(node.type, node.data.config);
    if (fields.length === 0) return node;
    needsConfiguration.push({
      nodeId: String(node.id ?? ""),
      label: typeof node.data.label === "string" && node.data.label ? node.data.label : String(node.id ?? ""),
      type: String(node.type),
      fields,
    });
    return { ...node, data: { ...node.data, config } };
  });

  const complete = needsConfiguration.length === 0;
  return {
    entrypoint,
    graph: {
      nodes,
      edges: Array.isArray(graph.edges) ? graph.edges : [],
      viewport: graph.viewport ?? null,
      // A copy with a node waiting for its request is not a valid graph yet,
      // whatever the publisher's own was.
      isValid: complete && graph.isValid === true,
      validationErrors: complete ? (graph.validationErrors ?? null) : needsConfiguration.map(describe),
      needsConfiguration,
    },
  };
}
