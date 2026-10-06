import assert from "node:assert/strict";
import test from "node:test";

import { loadSkillsConfig } from "../config/skills.js";
import {
  REFUSED_NODE_TYPES,
  renderTemplate,
  runGraph,
  type GraphInterpreterDeps,
  type InterpretableEdge,
  type InterpretableNode,
} from "../services/graphInterpreter.js";
import { createSkillRegistry } from "../services/skills/registry.js";
import type { SandboxResult, SandboxRunner } from "../services/skills/sandboxRunner.js";

// Drives the graph interpreter (W2). Stage 1 walked one path and refused
// everything non-linear; stage 2 (B3) executes a DAG by topological levels
// and runs api / tool / loop / parallel / merge nodes, plus `code` when an
// external sandbox is configured. The property under test throughout is
// unchanged: what the interpreter cannot honestly run, it REFUSES BY NAME
// with a reason rather than taking an arbitrary path and reporting success.

function node(
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  label?: string,
): InterpretableNode {
  return { id, type, data: { label: label ?? id, config } };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string,
): InterpretableEdge {
  return { id, source, target, sourceHandle };
}

function makeDeps(
  over: Partial<GraphInterpreterDeps> = {},
): { deps: GraphInterpreterDeps; prompts: string[] } {
  const prompts: string[] = [];
  const deps: GraphInterpreterDeps = {
    runLlm: async ({ prompt }) => {
      prompts.push(prompt);
      return { content: `answered: ${prompt}` };
    },
    sleep: async () => {},
    now: () => 0,
    ...over,
  };
  return { deps, prompts };
}

// ============================================
// The happy path
// ============================================

test("a linear input -> llm -> output graph runs and returns the model's answer", async () => {
  const { deps, prompts } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm"), node("out", "output")],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "hello",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "answered: hello");
  assert.deepEqual(prompts, ["hello"]);
  assert.deepEqual(
    result.trace.map((t) => `${t.nodeType}:${t.status}`),
    ["input:success", "llm:success", "output:success"],
  );
});

test("the trace records what entered and left every node", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm"), node("out", "output")],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "seed",
    deps,
  );
  const llmStep = result.trace.find((t) => t.nodeType === "llm")!;
  assert.equal(llmStep.input, "seed");
  assert.equal(llmStep.output, "answered: seed");
});

test("a node's own system prompt and model override the agent's", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { deps } = makeDeps({
    runLlm: async (args) => {
      seen.push(args as unknown as Record<string, unknown>);
      return { content: "ok" };
    },
  });
  await runGraph(
    [
      node("in", "input"),
      node("llm", "llm", {
        systemPrompt: "Be terse.",
        model: "free/groq/llama-3.1-8b",
        temperature: 0.1,
      }),
      node("out", "output"),
    ],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "q",
    deps,
  );
  assert.equal(seen[0]!.systemPrompt, "Be terse.");
  assert.equal(seen[0]!.model, "free/groq/llama-3.1-8b");
  assert.equal(seen[0]!.temperature, 0.1);
});

// ============================================
// Refusals — the honest core
// ============================================

test("a `code` node refuses by name: it would be RCE in the API process", async () => {
  const { deps, prompts } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("code", "code"), node("out", "output")],
    [edge("e1", "in", "code"), edge("e2", "code", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /remote-code-execution/);
  const refused = result.trace.find((t) => t.nodeType === "code")!;
  assert.equal(refused.status, "refused", "refusal is a distinct state, not a generic failure");
  assert.equal(prompts.length, 0);
});

// CHANGED (B3): loop / parallel / merge used to be refused as "non-linear".
// They run now; their behaviour is covered in the sections below. What is
// still refused by name is malformed control flow:
test("a loop with no `body` edge is refused by name, before anything runs", async () => {
  const { deps, prompts } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("lp", "loop", { count: 2 }), node("out", "output")],
    [edge("e1", "in", "lp"), edge("e2", "lp", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /loop node "lp" needs exactly one outgoing edge labelled "body"/);
  assert.deepEqual(result.trace, [], "planning failed before any node ran");
  assert.equal(prompts.length, 0);
});

// CHANGED (B3): `api`, `tool`, `loop`, `parallel`, `merge` left
// REFUSED_NODE_TYPES because they run now. Only `code` remains, and only while
// no sandbox is configured.
test("every refusal carries a reason a builder can act on", () => {
  assert.deepEqual(Object.keys(REFUSED_NODE_TYPES), ["code"]);
  for (const [type, reason] of Object.entries(REFUSED_NODE_TYPES)) {
    assert.ok(reason.length > 40, `${type} needs a real explanation`);
  }
  assert.match(REFUSED_NODE_TYPES.code!, /sandbox/);
  assert.match(REFUSED_NODE_TYPES.code!, /SANDBOX_RUNNER_URL/);
});

// CHANGED (B3): the message now points at the parallel node instead of a
// "full graph engine" that did not exist yet. The refusal itself stands:
// fan-out is explicit, never an accident of drawing two edges.
test("plain fan-out is refused — fan-out belongs to a parallel node", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("a", "output"), node("b", "output")],
    [edge("e1", "in", "a"), edge("e2", "in", "b")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /2 outgoing edges/);
  assert.match(result.error!, /only a parallel node fans out/);
});

// ============================================
// Conditions
// ============================================

test("a condition takes the true branch and skips the false one", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [
      node("in", "input"),
      node("cond", "condition", { op: "contains", value: "urgent" }),
      node("yes", "transform", { template: "ESCALATED: {{value}}" }),
      node("no", "transform", { template: "routine: {{value}}" }),
      node("out", "output"),
    ],
    [
      edge("e1", "in", "cond"),
      edge("e2", "cond", "yes", "true"),
      edge("e3", "cond", "no", "false"),
      edge("e4", "yes", "out"),
      edge("e5", "no", "out"),
    ],
    "this is urgent",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "ESCALATED: this is urgent");
  assert.ok(!result.trace.some((t) => t.nodeId === "no"), "false branch not walked");
});

test("a condition takes the false branch when it does not match", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [
      node("in", "input"),
      node("cond", "condition", { op: "contains", value: "urgent" }),
      node("yes", "transform", { template: "ESCALATED" }),
      node("no", "transform", { template: "routine" }),
      node("out", "output"),
    ],
    [
      edge("e1", "in", "cond"),
      edge("e2", "cond", "yes", "true"),
      edge("e3", "cond", "no", "false"),
      edge("e4", "yes", "out"),
      edge("e5", "no", "out"),
    ],
    "just saying hi",
    deps,
  );
  assert.equal(result.output, "routine");
});

// ============================================
// Transform + memory
// ============================================

test("transform is string templating, never code", () => {
  assert.equal(renderTemplate("Q: {{value}}", "hi", {}), "Q: hi");
  assert.equal(
    renderTemplate("{{nodes.step1}} then {{value}}", "b", { step1: "a" }),
    "a then b",
  );
  // An unknown reference renders empty rather than leaking or executing.
  assert.equal(renderTemplate("{{process.env.SECRET}}", "x", {}), "");
  // A JS-looking template is inert text.
  assert.equal(
    renderTemplate("${globalThis.process.exit(1)}", "x", {}),
    "${globalThis.process.exit(1)}",
  );
});

test("a memory node injects retrieved passages into the walk", async () => {
  const { deps, prompts } = makeDeps({
    searchKnowledge: async ({ query, limit }) => {
      assert.equal(query, "what is the refund policy?");
      assert.equal(limit, 2);
      return { text: "[1] Policy\nRefunds within 30 days.", mode: "semantic" };
    },
  });
  const result = await runGraph(
    [
      node("in", "input"),
      node("mem", "memory", { knowledgeBaseId: "kb-1", topK: 2 }),
      node("llm", "llm"),
      node("out", "output"),
    ],
    [edge("e1", "in", "mem"), edge("e2", "mem", "llm"), edge("e3", "llm", "out")],
    "what is the refund policy?",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.match(prompts[0]!, /Refunds within 30 days/);
});

test("a memory node with no hits continues with the query rather than failing", async () => {
  const { deps, prompts } = makeDeps({
    searchKnowledge: async () => null,
  });
  const result = await runGraph(
    [
      node("in", "input"),
      node("mem", "memory", { knowledgeBaseId: "kb-1" }),
      node("llm", "llm"),
      node("out", "output"),
    ],
    [edge("e1", "in", "mem"), edge("e2", "mem", "llm"), edge("e3", "llm", "out")],
    "obscure question",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(prompts[0], "obscure question", "a miss is not a failure");
});

test("a memory node without a knowledge base fails with an actionable message", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("mem", "memory"), node("out", "output")],
    [edge("e1", "in", "mem"), edge("e2", "mem", "out")],
    "q",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /pick a knowledge base/);
});

// ============================================
// Structural errors
// ============================================

test("a graph with no input node, or several, is refused", async () => {
  const { deps } = makeDeps();
  const none = await runGraph([node("out", "output")], [], "x", deps);
  assert.match(none.error!, /no input node/);

  const many = await runGraph(
    [node("a", "input"), node("b", "input"), node("out", "output")],
    [edge("e1", "a", "out")],
    "x",
    deps,
  );
  assert.match(many.error!, /2 input nodes/);
});

test("a dangling path fails instead of quietly ending", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm")],
    [edge("e1", "in", "llm")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /no outgoing edge/);
});

// CHANGED (B3): a cycle is now detected statically, by name, before any node
// runs - instead of being walked until a step budget ran out.
test("a cycle is refused by name before anything runs", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("a", "transform"), node("b", "transform")],
    [edge("e1", "in", "a"), edge("e2", "a", "b"), edge("e3", "b", "a")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /cycle among nodes: a, b/);
  assert.match(result.error!, /use a loop node to iterate/);
  assert.deepEqual(result.trace, []);
});

test("an llm failure is recorded on its node, not swallowed", async () => {
  const { deps } = makeDeps({
    runLlm: async () => {
      throw new Error("provider 503");
    },
  });
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm"), node("out", "output")],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /provider 503/);
  const failed = result.trace.find((t) => t.nodeType === "llm")!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.input, "x", "the failing node's input is preserved for debugging");
});

test("a delay is bounded — a graph cannot pin a worker for an hour", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("wait", "delay", { ms: 3_600_000 }), node("out", "output")],
    [edge("e1", "in", "wait"), edge("e2", "wait", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /delay must be between/);
});

test("an unknown node type fails by name instead of being skipped", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("weird", "quantum_flux"), node("out", "output")],
    [edge("e1", "in", "weird"), edge("e2", "weird", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /unknown node type "quantum_flux"/);
});

// ============================================================
// B3 - new node types and DAG execution
// ============================================================

const PUBLIC = { resolveHost: async () => ["93.184.216.34"] };

function skillRegistry(env: Record<string, string> = {}) {
  const config = loadSkillsConfig(env);
  return createSkillRegistry({
    getConfig: () => ({ config, error: null }),
    getFileStore: () => null,
    getSandbox: () => null,
    knowledge: {
      loadKnowledgeBaseId: async () => null,
      search: async () => ({ results: [], mode: "keyword", fallbackReason: null }),
    },
    guardDeps: PUBLIC,
  });
}

function fakeHttp(
  respond: (url: string, options: Record<string, any>) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; options: Record<string, any> }> = [];
  const httpFetch: NonNullable<GraphInterpreterDeps["httpFetch"]> = async (url, options) => {
    calls.push({ url, options: options as Record<string, any> });
    return respond(url, options as Record<string, any>);
  };
  return { calls, httpFetch };
}

function fakeSandbox(result: Partial<SandboxResult> = {}) {
  const calls: Array<{ language: string; code: string; stdin?: string }> = [];
  const runner: SandboxRunner = {
    languages: ["python", "javascript"],
    limits: { timeoutMs: 15_000, maxOutputBytes: 65_536 },
    run: async (language, code, _limits, options) => {
      calls.push({ language, code, stdin: options?.stdin });
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 1,
        ...result,
      };
    },
  };
  return { calls, runner };
}

const traceOf = (r: { trace: Array<{ nodeId: string; status: string }> }) =>
  r.trace.map((t) => `${t.nodeId}:${t.status}`);

// ---------------- templating filters ----------------

test("template filters build safe requests; unknown filters and prototype keys are inert", () => {
  assert.equal(renderTemplate('{"q": {{value | json}}}', 'say "hi"\nnow', {}), '{"q": "say \\"hi\\"\\nnow"}');
  assert.equal(renderTemplate("?q={{ value | urlencode }}", "a b&c=d", {}), "?q=a%20b%26c%3Dd");
  assert.equal(renderTemplate("{{item}}/{{index}}", "v", {}, { item: "x", index: "2" }), "x/2");
  assert.throws(() => renderTemplate("{{value | shell}}", "x", {}), /unknown template filter "shell"/);
  assert.equal(renderTemplate("{{nodes.constructor}}|{{nodes.__proto__}}", "x", {}), "|");
});

// ---------------- api node ----------------

test("an api node renders its url, headers and body from upstream data and returns the response", async () => {
  const http = fakeHttp(() => new Response('{"ok":true}', { status: 200 }));
  const { deps } = makeDeps({ httpFetch: http.httpFetch });
  const result = await runGraph(
    [
      node("in", "input"),
      node("call", "api", {
        method: "post",
        url: "https://api.example.com/search?q={{value | urlencode}}",
        headers: { "X-Trace": "run-{{value}}", Accept: "application/json" },
        body: '{"query": {{value | json}}}',
      }),
      node("out", "output"),
    ],
    [edge("e1", "in", "call"), edge("e2", "call", "out")],
    "hello world",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, '{"ok":true}');
  const sent = http.calls[0]!;
  assert.equal(sent.url, "https://api.example.com/search?q=hello%20world");
  assert.equal(sent.options.method, "POST");
  assert.equal(sent.options.body, '{"query": "hello world"}');
  assert.deepEqual(sent.options.headers, { "X-Trace": "run-hello world", Accept: "application/json" });
});

test("an api node does not send a body on GET and bounds its timeout", async () => {
  const http = fakeHttp(() => new Response("x"));
  const { deps } = makeDeps({ httpFetch: http.httpFetch });
  await runGraph(
    [node("in", "input"), node("call", "api", { url: "https://a.example", body: "ignored", timeoutMs: 999_999 }), node("out", "output")],
    [edge("e1", "in", "call"), edge("e2", "call", "out")],
    "x",
    deps,
  );
  assert.equal(http.calls[0]!.options.body, undefined);
  assert.equal(http.calls[0]!.options.timeoutMs, 30_000, "clamped to the 30s ceiling");
});

test("an api node fails on a non-2xx response unless told otherwise", async () => {
  const http = fakeHttp(() => new Response("not here", { status: 404 }));
  const graph = (config: Record<string, unknown>) => ({
    nodes: [node("in", "input"), node("call", "api", { url: "https://a.example/x", ...config }), node("out", "output")],
    edges: [edge("e1", "in", "call"), edge("e2", "call", "out")],
  });

  const strictGraph = graph({});
  const strict = await runGraph(strictGraph.nodes, strictGraph.edges, "x", makeDeps({ httpFetch: http.httpFetch }).deps);
  assert.equal(strict.status, "failed");
  assert.match(strict.error!, /HTTP 404: not here/);
  assert.equal(strict.trace.find((t) => t.nodeId === "call")!.status, "failed");

  const lenientGraph = graph({ failOnHttpError: false });
  const lenient = await runGraph(lenientGraph.nodes, lenientGraph.edges, "x", makeDeps({ httpFetch: http.httpFetch }).deps);
  assert.equal(lenient.output, "not here");
});

test("an oversize api response fails by default and truncates only when asked", async () => {
  const big = () => new Response("Z".repeat(5_000));
  const graph = (config: Record<string, unknown>) => ({
    nodes: [
      node("in", "input"),
      node("call", "api", { url: "https://a.example/x", maxResponseBytes: 1_024, ...config }),
      node("out", "output"),
    ],
    edges: [edge("e1", "in", "call"), edge("e2", "call", "out")],
  });

  const failGraph = graph({});
  const fail = await runGraph(failGraph.nodes, failGraph.edges, "x", makeDeps({ httpFetch: fakeHttp(big).httpFetch }).deps);
  assert.equal(fail.status, "failed");
  assert.match(fail.error!, /larger than 1024 bytes/);

  const cutGraph = graph({ onOversize: "truncate" });
  const cut = await runGraph(cutGraph.nodes, cutGraph.edges, "x", makeDeps({ httpFetch: fakeHttp(big).httpFetch }).deps);
  assert.equal(cut.status, "completed");
  assert.match(cut.output!, /^Z{1024}\n\.\.\.\[response truncated at 1024 bytes\]$/);
});

test("an api url resolved from templating is SSRF-guarded at request time", async () => {
  // No httpFetch injected: the REAL safeFetch. The URL only exists after
  // templating, so a hostname/literal check at save time could never see it.
  const { deps } = makeDeps();
  for (const target of [
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:5432/",
    "http://[::1]/",
    "file:///etc/passwd",
  ]) {
    const result = await runGraph(
      [node("in", "input"), node("call", "api", { url: "{{value}}" }), node("out", "output")],
      [edge("e1", "in", "call"), edge("e2", "call", "out")],
      target,
      deps,
    );
    assert.equal(result.status, "failed", target);
    assert.match(result.error!, /blocked outbound request/, target);
    assert.equal(result.trace.find((t) => t.nodeId === "call")!.status, "failed");
  }
});

test("an api node with no url, a bad method or a forbidden header fails by name", async () => {
  const http = fakeHttp(() => new Response("x"));
  const run = (config: Record<string, unknown>) =>
    runGraph(
      [node("in", "input"), node("call", "api", config), node("out", "output")],
      [edge("e1", "in", "call"), edge("e2", "call", "out")],
      "x",
      makeDeps({ httpFetch: http.httpFetch }).deps,
    );
  assert.match((await run({})).error!, /no url configured/);
  assert.match((await run({ url: "https://a.example", method: "TRACE" })).error!, /unsupported method "TRACE"/);
  assert.match(
    (await run({ url: "https://a.example", headers: { Host: "internal" } })).error!,
    /"Host" header cannot be set/,
  );
  assert.equal(http.calls.length, 0, "none of these reached the network");
});

// ---------------- tool node ----------------

test("a tool node runs a skill, feeding the incoming value to its main text parameter", async () => {
  const { deps } = makeDeps({
    skills: skillRegistry(),
    enabledTools: ["calculator"],
    toolContext: { agentId: "a", orgId: "o" },
  });
  const result = await runGraph(
    [node("in", "input"), node("calc", "tool", { toolName: "calculator" }), node("out", "output")],
    [edge("e1", "in", "calc"), edge("e2", "calc", "out")],
    "17*23",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "391");
});

test("a tool node templates its input values, never its structure", async () => {
  const { deps } = makeDeps({
    skills: skillRegistry(),
    enabledTools: ["calculator"],
    toolContext: { agentId: "a", orgId: "o" },
  });
  const run = (input: unknown, value: string) =>
    runGraph(
      [node("in", "input"), node("calc", "tool", { tool: "calculator", input }), node("out", "output")],
      [edge("e1", "in", "calc"), edge("e2", "calc", "out")],
      value,
      deps,
    );
  assert.equal((await run({ expression: "{{value}} * 2" }, "21")).output, "42");
  assert.equal((await run('{"expression": "{{value}} + 1"}', "9")).output, "10", "a JSON string is parsed first, then templated");
  // A value that looks like JSON structure cannot add an argument.
  const hostile = await run({ expression: "{{value}}" }, '1", "extra": "x');
  assert.equal(hostile.status, "failed");
});

test("a tool whose provider is not configured is REFUSED with the reason, not faked", async () => {
  const { deps } = makeDeps({
    skills: skillRegistry(),
    enabledTools: ["web_search"],
    toolContext: { agentId: "a", orgId: "o" },
  });
  const result = await runGraph(
    [node("in", "input"), node("search", "tool", { toolName: "web_search" }), node("out", "output")],
    [edge("e1", "in", "search"), edge("e2", "search", "out")],
    "solana news",
    deps,
  );
  assert.equal(result.status, "failed");
  const entry = result.trace.find((t) => t.nodeId === "search")!;
  assert.equal(entry.status, "refused");
  assert.equal(entry.output, null);
  assert.match(entry.error!, /unavailable: web search is not configured on this server/);
  assert.match(result.error!, /cannot run: unavailable: web search is not configured/);
});

test("tool node misconfiguration fails by name", async () => {
  const registry = skillRegistry();
  registry.register({
    key: "sum",
    version: "1.0.0",
    name: "Sum",
    description: "adds numbers",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    moneyMoving: false,
    execute: async (input) => {
      const { a, b } = input as { a: number; b: number };
      return { status: "ok", output: String(a + b) };
    },
  });
  const run = (config: Record<string, unknown>, over: Partial<GraphInterpreterDeps> = {}) =>
    runGraph(
      [node("in", "input"), node("t", "tool", config), node("out", "output")],
      [edge("e1", "in", "t"), edge("e2", "t", "out")],
      "x",
      makeDeps({
        skills: registry,
        enabledTools: ["sum", "calculator", "launch_missiles"],
        toolContext: { agentId: "a", orgId: "o" },
        ...over,
      }).deps,
    );
  assert.match((await run({})).error!, /no tool selected/);
  assert.match((await run({ toolName: "launch_missiles" })).error!, /unknown tool "launch_missiles"/);
  // A skill with no text parameter has nowhere to put a bare value...
  assert.match((await run({ toolName: "sum" })).error!, /no single text parameter.*set config.input/);
  // ...but works once the author maps the input explicitly.
  assert.equal((await run({ toolName: "sum", input: { a: 2, b: 3 } })).output, "5");
  const noRegistry = await run({ toolName: "calculator" }, { skills: undefined });
  assert.equal(noRegistry.trace.find((t) => t.nodeId === "t")!.status, "refused");
});

// ---------------- loop ----------------

function loopGraph(config: Record<string, unknown>, bodyTemplate = "[{{index}}:{{item}}]") {
  return {
    nodes: [
      node("in", "input"),
      node("lp", "loop", config),
      node("body", "transform", { template: bodyTemplate }),
      node("out", "output"),
    ],
    edges: [
      edge("e1", "in", "lp"),
      edge("e2", "lp", "body", "body"),
      edge("e3", "lp", "out", "done"),
    ],
  };
}

test("a loop runs its body once per item and collects the results", async () => {
  const { deps } = makeDeps();
  const g = loopGraph({});
  const result = await runGraph(g.nodes, g.edges, '["a","b","c"]', deps);
  assert.equal(result.status, "completed");
  assert.deepEqual(JSON.parse(result.output!), ["[0:a]", "[1:b]", "[2:c]"]);

  const bodyRuns = result.trace.filter((t) => t.nodeId === "body");
  assert.deepEqual(bodyRuns.map((t) => t.iteration), [0, 1, 2], "per-iteration traces");
  assert.ok(bodyRuns.every((t) => t.loopId === "lp"));
  assert.equal(result.trace.filter((t) => t.nodeId === "lp").length, 1);
  assert.deepEqual(traceOf(result).at(-2), "lp:success", "the loop entry follows its iterations");
});

test("a loop iterates lines, counts, and can collect the last result or join", async () => {
  const { deps } = makeDeps();
  const lines = loopGraph({ format: "lines", collect: "join", separator: "|" });
  assert.equal((await runGraph(lines.nodes, lines.edges, "x\n\ny\nz", deps)).output, "[0:x]|[1:y]|[2:z]");

  const count = loopGraph({ mode: "count", count: 3, collect: "last" });
  assert.equal((await runGraph(count.nodes, count.edges, "ignored", deps)).output, "[2:2]");

  const fromNode = loopGraph({ list: "{{nodes.in}}" });
  assert.deepEqual(JSON.parse((await runGraph(fromNode.nodes, fromNode.edges, '["q"]', deps)).output!), ["[0:q]"]);
});

test("a loop is bounded: too many items or a bigger count than the cap fails", async () => {
  const { deps } = makeDeps();
  const g = loopGraph({});
  const items = JSON.stringify(Array.from({ length: 21 }, (_, i) => `n${i}`));
  const tooMany = await runGraph(g.nodes, g.edges, items, deps);
  assert.equal(tooMany.status, "failed");
  assert.match(tooMany.error!, /loop has 21 items but is limited to 20 iterations/);
  assert.equal(tooMany.trace.filter((t) => t.nodeId === "body").length, 0, "no iteration ran");

  const lowCap = loopGraph({ maxIterations: 2 });
  assert.match((await runGraph(lowCap.nodes, lowCap.edges, '["a","b","c"]', deps)).error!, /limited to 2 iterations/);

  const hugeCount = loopGraph({ mode: "count", count: 1_000_000 });
  assert.match((await runGraph(hugeCount.nodes, hugeCount.edges, "x", deps)).error!, /limited to 20 iterations/);

  // A node cannot raise the ceiling by asking.
  const raised = loopGraph({ maxIterations: 500 });
  assert.match((await runGraph(raised.nodes, raised.edges, items, deps)).error!, /limited to 20 iterations/);
});

test("a loop over something that is not a JSON array fails with a fix, not a guess", async () => {
  const { deps } = makeDeps();
  const g = loopGraph({});
  const r = await runGraph(g.nodes, g.edges, "just some text", deps);
  assert.equal(r.status, "failed");
  assert.match(r.error!, /not a JSON array.*format to "lines"/);
  const obj = await runGraph(g.nodes, g.edges, '{"a":1}', deps);
  assert.match(obj.error!, /must be a JSON array/);
  const empty = await runGraph(g.nodes, g.edges, "[]", deps);
  assert.equal(empty.status, "completed");
  assert.equal(empty.output, "[]", "an empty list is zero iterations, not an error");
});

test("a failing loop body stops the loop and names the iteration", async () => {
  const seen: string[] = [];
  const { deps } = makeDeps({
    runLlm: async ({ prompt }) => {
      seen.push(prompt);
      if (prompt === "bad") throw new Error("provider 500");
      return { content: prompt.toUpperCase() };
    },
  });
  const result = await runGraph(
    [node("in", "input"), node("lp", "loop", {}), node("ask", "llm"), node("out", "output")],
    [edge("e1", "in", "lp"), edge("e2", "lp", "ask", "body"), edge("e3", "lp", "out", "done")],
    '["ok","bad","never"]',
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /node "lp" failed: iteration 1 stopped: node "ask" failed: provider 500/);
  assert.deepEqual(seen, ["ok", "bad"], "iteration 2 never ran");
  const failed = result.trace.filter((t) => t.status === "failed").map((t) => `${t.nodeId}@${t.iteration ?? "-"}`);
  assert.deepEqual(failed, ["ask@1", "lp@-"]);
});

test("a multi-node body chains its nodes and feeds each one's output to the next", async () => {
  const { deps, prompts } = makeDeps();
  const result = await runGraph(
    [
      node("in", "input"),
      node("lp", "loop", { collect: "join", separator: ";" }),
      node("t1", "transform", { template: "q:{{value}}" }),
      node("ask", "llm"),
      node("out", "output"),
    ],
    [
      edge("e1", "in", "lp"),
      edge("e2", "lp", "t1", "body"),
      edge("e3", "t1", "ask"),
      edge("e4", "lp", "out", "done"),
    ],
    '["a","b"]',
    deps,
  );
  assert.equal(result.output, "answered: q:a;answered: q:b");
  assert.deepEqual(prompts, ["q:a", "q:b"]);
});

test("malformed loop bodies are refused by name", async () => {
  const { deps } = makeDeps();
  const run = (nodes: InterpretableNode[], edges: InterpretableEdge[]) =>
    runGraph(nodes, edges, "[]", deps);

  // The body rejoins the main path.
  const rejoin = await run(
    [node("in", "input"), node("lp", "loop"), node("b", "transform"), node("j", "transform"), node("out", "output")],
    [
      edge("e1", "in", "lp"),
      edge("e2", "lp", "b", "body"),
      edge("e3", "lp", "j", "done"),
      edge("e4", "j", "out"),
      edge("e5", "b", "j"),
    ],
  );
  assert.match(rejoin.error!, /body reaches "j", which is also on the main path/);

  // An output node inside a body.
  const earlyOut = await run(
    [node("in", "input"), node("lp", "loop"), node("b", "transform"), node("out", "output")],
    [edge("e1", "in", "lp"), edge("e2", "lp", "b", "body"), edge("e3", "lp", "out", "done"), edge("e4", "b", "out")],
  );
  assert.match(earlyOut.error!, /body contains output node "out"/);

  // A condition inside a body.
  const branching = await run(
    [node("in", "input"), node("lp", "loop"), node("c", "condition"), node("out", "output")],
    [edge("e1", "in", "lp"), edge("e2", "lp", "c", "body"), edge("e3", "lp", "out", "done")],
  );
  assert.match(branching.error!, /body contains condition node "c"/);

  // Nested loops.
  const nested = await run(
    [node("in", "input"), node("lp", "loop"), node("inner", "loop"), node("out", "output")],
    [edge("e1", "in", "lp"), edge("e2", "lp", "inner", "body"), edge("e3", "lp", "out", "done")],
  );
  assert.match(nested.error!, /nested loops are not supported/);

  // A back-edge inside the body is a cycle, not a loop.
  const back = await run(
    [node("in", "input"), node("lp", "loop"), node("a", "transform"), node("b", "transform"), node("out", "output")],
    [edge("e1", "in", "lp"), edge("e2", "lp", "a", "body"), edge("e3", "a", "b"), edge("e4", "b", "a"), edge("e5", "lp", "out", "done")],
  );
  assert.match(back.error!, /body revisits node "a"/);

  // Two body edges.
  const two = await run(
    [node("in", "input"), node("lp", "loop"), node("a", "transform"), node("b", "transform"), node("out", "output")],
    [edge("e1", "in", "lp"), edge("e2", "lp", "a", "body"), edge("e3", "lp", "b", "body"), edge("e4", "lp", "out", "done")],
  );
  assert.match(two.error!, /exactly one outgoing edge labelled "body" \(found 2\)/);
});

// ---------------- parallel + merge ----------------

function fanOut(branchCount: number, mergeConfig: Record<string, unknown> = {}, parConfig: Record<string, unknown> = {}) {
  const ids = Array.from({ length: branchCount }, (_, i) => `b${i + 1}`);
  return {
    nodes: [
      node("in", "input"),
      node("par", "parallel", parConfig),
      ...ids.map((id) => node(id, "llm")),
      node("mrg", "merge", mergeConfig),
      node("out", "output"),
    ],
    edges: [
      edge("e_in", "in", "par"),
      ...ids.map((id) => edge(`e_${id}_in`, "par", id)),
      ...ids.map((id) => edge(`e_${id}_out`, id, "mrg")),
      edge("e_out", "mrg", "out"),
    ],
  };
}

function gatedLlm() {
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    get max() {
      return maxInFlight;
    },
    runLlm: async ({ prompt }: { prompt: string }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return { content: `r(${prompt})` };
    },
  };
}

test("a parallel node broadcasts to its branches and a merge joins them in edge order", async () => {
  const { deps } = makeDeps();
  const g = fanOut(3);
  const result = await runGraph(g.nodes, g.edges, "q", deps);
  assert.equal(result.status, "completed");
  assert.deepEqual(JSON.parse(result.output!), ["answered: q", "answered: q", "answered: q"]);
  assert.deepEqual(traceOf(result), [
    "in:success",
    "par:success",
    "b1:success",
    "b2:success",
    "b3:success",
    "mrg:success",
    "out:success",
  ]);
});

test("branches really run concurrently, under the default cap of 4", async () => {
  const llm = gatedLlm();
  const { deps } = makeDeps({ runLlm: llm.runLlm });
  const g = fanOut(6);
  const result = await runGraph(g.nodes, g.edges, "q", deps);
  assert.equal(result.status, "completed");
  assert.equal(llm.max, 4, "4 at once, not 1 and not 6");
});

test("a parallel node's maxConcurrency lowers the cap for its branches", async () => {
  const llm = gatedLlm();
  const { deps } = makeDeps({ runLlm: llm.runLlm });
  const g = fanOut(5, {}, { maxConcurrency: 2 });
  const result = await runGraph(g.nodes, g.edges, "q", deps);
  assert.equal(result.status, "completed");
  assert.equal(llm.max, 2);

  // ...and nothing can raise it past the hard ceiling of 8.
  const wide = gatedLlm();
  const g2 = fanOut(12, {}, { maxConcurrency: 100 });
  await runGraph(g2.nodes, g2.edges, "q", makeDeps({ runLlm: wide.runLlm }).deps);
  assert.equal(wide.max, 8);
});

test("merge can key results by node id or join them as text", async () => {
  const { deps } = makeDeps({
    runLlm: async ({ prompt }) => ({ content: `r(${prompt})` }),
  });
  const obj = fanOut(2, { mode: "object" });
  assert.deepEqual(JSON.parse((await runGraph(obj.nodes, obj.edges, "q", deps)).output!), { b1: "r(q)", b2: "r(q)" });
  const joined = fanOut(2, { mode: "join", separator: " + " });
  assert.equal((await runGraph(joined.nodes, joined.edges, "q", deps)).output, "r(q) + r(q)");
  const bad = fanOut(2, { mode: "zip" });
  assert.match((await runGraph(bad.nodes, bad.edges, "q", deps)).error!, /unknown merge mode "zip"/);
});

test("branches with different depths are merged once the slower one finishes", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [
      node("in", "input"),
      node("par", "parallel"),
      node("fast", "transform", { template: "fast:{{value}}" }),
      node("s1", "transform", { template: "s1:{{value}}" }),
      node("s2", "transform", { template: "s2:{{value}}" }),
      node("mrg", "merge", { mode: "object" }),
      node("out", "output"),
    ],
    [
      edge("e1", "in", "par"),
      edge("e2", "par", "fast"),
      edge("e3", "par", "s1"),
      edge("e4", "s1", "s2"),
      edge("e5", "fast", "mrg"),
      edge("e6", "s2", "mrg"),
      edge("e7", "mrg", "out"),
    ],
    "x",
    deps,
  );
  assert.deepEqual(JSON.parse(result.output!), { fast: "fast:x", s2: "s2:s1:x" });
});

test("a failing branch fails the run, and the sibling branches' traces are kept", async () => {
  const { deps } = makeDeps({
    runLlm: async ({ systemPrompt }) => {
      if (systemPrompt === "explode") throw new Error("branch blew up");
      return { content: "fine" };
    },
  });
  const result = await runGraph(
    [
      node("in", "input"),
      node("par", "parallel"),
      node("good", "llm"),
      node("bad", "llm", { systemPrompt: "explode" }),
      node("mrg", "merge"),
      node("out", "output"),
    ],
    [
      edge("e1", "in", "par"),
      edge("e2", "par", "good"),
      edge("e3", "par", "bad"),
      edge("e4", "good", "mrg"),
      edge("e5", "bad", "mrg"),
      edge("e6", "mrg", "out"),
    ],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /node "bad" failed: branch blew up/);
  assert.deepEqual(traceOf(result), ["in:success", "par:success", "good:success", "bad:failed"]);
});

test("several active branches into a non-merge node are refused: join them with a merge", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [
      node("in", "input"),
      node("par", "parallel"),
      node("a", "transform"),
      node("b", "transform"),
      node("out", "output"),
    ],
    [edge("e1", "in", "par"), edge("e2", "par", "a"), edge("e3", "par", "b"), edge("e4", "a", "out"), edge("e5", "b", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /node "out" receives 2 active branches \(a, b\); join them with a merge node/);
});

test("a merge after a condition joins only the branch that ran", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [
      node("in", "input"),
      node("cond", "condition", { op: "contains", value: "urgent" }),
      node("yes", "transform", { template: "Y:{{value}}" }),
      node("no", "transform", { template: "N:{{value}}" }),
      node("mrg", "merge", { mode: "join" }),
      node("out", "output"),
    ],
    [
      edge("e1", "in", "cond"),
      edge("e2", "cond", "yes", "true"),
      edge("e3", "cond", "no", "false"),
      edge("e4", "yes", "mrg"),
      edge("e5", "no", "mrg"),
      edge("e6", "mrg", "out"),
    ],
    "urgent!",
    deps,
  );
  assert.equal(result.output, "Y:urgent!");
  assert.ok(!traceOf(result).includes("no:success"));
});

test("two output nodes reached is an error; one per condition branch is fine", async () => {
  const { deps } = makeDeps();
  const two = await runGraph(
    [node("in", "input"), node("par", "parallel"), node("o1", "output"), node("o2", "output")],
    [edge("e1", "in", "par"), edge("e2", "par", "o1"), edge("e3", "par", "o2")],
    "x",
    deps,
  );
  assert.equal(two.status, "failed");
  assert.match(two.error!, /reached 2 output nodes/);

  const one = await runGraph(
    [
      node("in", "input"),
      node("cond", "condition", { op: "contains", value: "a" }),
      node("o1", "output", {}, "yes-out"),
      node("o2", "output", {}, "no-out"),
    ],
    [edge("e1", "in", "cond"), edge("e2", "cond", "o1", "true"), edge("e3", "cond", "o2", "false")],
    "zzz",
    deps,
  );
  assert.equal(one.status, "completed");
  assert.deepEqual(traceOf(one), ["in:success", "cond:success", "o2:success"]);
});

test("the builder's default edge handle ('output') does not hide condition labels", async () => {
  const { deps } = makeDeps();
  const labelled = (id: string, s: string, t: string, label: string): InterpretableEdge => ({
    id,
    source: s,
    target: t,
    sourceHandle: "output", // what the builder stamps on every edge
    label,
  });
  const result = await runGraph(
    [
      node("in", "input"),
      node("cond", "condition", { op: "contains", value: "x" }),
      node("yes", "transform", { template: "yes" }),
      node("no", "transform", { template: "no" }),
      node("out", "output"),
    ],
    [
      edge("e1", "in", "cond"),
      labelled("e2", "cond", "yes", "true"),
      labelled("e3", "cond", "no", "false"),
      edge("e4", "yes", "out"),
      edge("e5", "no", "out"),
    ],
    "no match",
    deps,
  );
  assert.equal(result.output, "no");
});

test("a condition with several edges on one branch, or several unlabeled, is refused", async () => {
  const { deps } = makeDeps();
  const dup = await runGraph(
    [node("in", "input"), node("c", "condition"), node("a", "output"), node("b", "output")],
    [edge("e1", "in", "c"), edge("e2", "c", "a", "true"), edge("e3", "c", "b", "true")],
    "x",
    deps,
  );
  assert.match(dup.error!, /condition "c" has 2 edges labelled "true"/);
  const unlabeled = await runGraph(
    [node("in", "input"), node("c", "condition"), node("a", "output"), node("b", "output")],
    [edge("e1", "in", "c"), edge("e2", "c", "a"), edge("e3", "c", "b")],
    "x",
    deps,
  );
  assert.match(unlabeled.error!, /2 unlabeled outgoing edges/);
});

test("a condition whose branch has no edge ends the run with the value at the gate", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("gate", "condition", { op: "contains", value: "go" }), node("out", "output")],
    [edge("e1", "in", "gate"), edge("e2", "gate", "out", "true")],
    "stop here",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "stop here");
});

// ---------------- code node ----------------

test("a code node is REFUSED while no sandbox is configured", async () => {
  const { deps, prompts } = makeDeps({ sandbox: null });
  const result = await runGraph(
    [node("in", "input"), node("c", "code", { language: "python", code: "print(1)" }), node("out", "output")],
    [edge("e1", "in", "c"), edge("e2", "c", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  const entry = result.trace.find((t) => t.nodeId === "c")!;
  assert.equal(entry.status, "refused");
  assert.match(entry.error!, /remote-code-execution/);
  assert.match(entry.error!, /SANDBOX_RUNNER_URL/);
  assert.equal(prompts.length, 0);
});

test("with a sandbox, a code node runs there: value on stdin, stdout as the output", async () => {
  const sb = fakeSandbox({ stdout: "HELLO\n" });
  const { deps } = makeDeps({ sandbox: sb.runner });
  const code = "import sys; print(sys.stdin.read().upper()) # {{value}}";
  const result = await runGraph(
    [node("in", "input"), node("c", "code", { language: "python", code }), node("out", "output")],
    [edge("e1", "in", "c"), edge("e2", "c", "out")],
    "hello",
    deps,
  );
  assert.equal(result.output, "HELLO", "the trailing newline is trimmed");
  assert.deepEqual(sb.calls, [{ language: "python", code, stdin: "hello" }]);
  assert.match(sb.calls[0]!.code, /\{\{value\}\}/, "data never becomes code: the source is not templated");
});

test("a code node fails on a non-zero exit, a timeout or cut-off output", async () => {
  const run = async (result: Partial<SandboxResult>) =>
    runGraph(
      [node("in", "input"), node("c", "code", { code: "x" }), node("out", "output")],
      [edge("e1", "in", "c"), edge("e2", "c", "out")],
      "x",
      makeDeps({ sandbox: fakeSandbox(result).runner }).deps,
    );
  assert.match((await run({ exitCode: 2, stderr: "Traceback..." })).error!, /exited with status 2: Traceback/);
  assert.match((await run({ exitCode: null, timedOut: true })).error!, /timed out after 15000ms/);
  assert.match((await run({ truncated: true })).error!, /output exceeded the 65536-byte limit/);
  assert.match((await runGraph(
    [node("in", "input"), node("c", "code", { code: "  " }), node("out", "output")],
    [edge("e1", "in", "c"), edge("e2", "c", "out")],
    "x",
    makeDeps({ sandbox: fakeSandbox().runner }).deps,
  )).error!, /no code/);
});

// ---------------- limits, cancellation, compatibility ----------------

test("the whole run has a step budget across loop iterations", async () => {
  const g = loopGraph({ maxIterations: 20 });
  const { deps } = makeDeps({ limits: { maxNodeRuns: 10 } });
  const items = JSON.stringify(Array.from({ length: 15 }, (_, i) => `i${i}`));
  const result = await runGraph(g.nodes, g.edges, items, deps);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /step budget of 10 node executions/);
});

test("an aborted run stops at the next node and says so", async () => {
  const controller = new AbortController();
  const { deps } = makeDeps({
    signal: controller.signal,
    runLlm: async () => {
      controller.abort();
      return { content: "done" };
    },
  });
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm"), node("t", "transform"), node("out", "output")],
    [edge("e1", "in", "llm"), edge("e2", "llm", "t"), edge("e3", "t", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error, "run cancelled");
  assert.ok(!traceOf(result).includes("t:success"));
});

test("a delay accepts `ms` (canonical) and `duration` (what the builder used to write)", async () => {
  const waits: number[] = [];
  const { deps } = makeDeps({ sleep: async (ms) => void waits.push(ms) });
  for (const config of [{ ms: 250 }, { duration: 500 }]) {
    await runGraph(
      [node("in", "input"), node("w", "delay", config), node("out", "output")],
      [edge("e1", "in", "w"), edge("e2", "w", "out")],
      "x",
      deps,
    );
  }
  assert.deepEqual(waits, [250, 500]);
});

test("edges leaving an output node are never followed, and unreachable nodes are ignored", async () => {
  const { deps, prompts } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("out", "output"), node("after", "llm"), node("orphan", "llm")],
    [edge("e1", "in", "out"), edge("e2", "out", "after")],
    "x",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(prompts.length, 0);
});

test("duplicate node ids and edges to missing nodes are refused by name", async () => {
  const { deps } = makeDeps();
  const dup = await runGraph([node("in", "input"), node("in", "output")], [], "x", deps);
  assert.match(dup.error!, /duplicate node id "in"/);
  const missing = await runGraph([node("in", "input")], [edge("e9", "in", "ghost")], "x", deps);
  assert.match(missing.error!, /edge e9 points at missing node ghost/);
});

test("llm nodes pass a tool allowlist through and run under the run's abort signal", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const controller = new AbortController();
  const { deps } = makeDeps({
    signal: controller.signal,
    runLlm: async (args) => {
      seen.push(args as unknown as Record<string, unknown>);
      return { content: "ok" };
    },
  });
  await runGraph(
    [node("in", "input"), node("llm", "llm", { tools: ["calculator", 7] }), node("out", "output")],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "q",
    deps,
  );
  assert.deepEqual(seen[0]!.tools, ["calculator"], "non-string entries are dropped");
  // The node gets the RUN's signal (caller cancellation + the run deadline),
  // so aborting the caller's signal reaches the model call.
  const nodeSignal = seen[0]!.signal as AbortSignal;
  assert.equal(nodeSignal.aborted, false);
  controller.abort();
  assert.equal(nodeSignal.aborted, true);
});

// ---------------- tool narrowing ----------------

test("a tool node may only NARROW the agent's enabled tools, never add one", async () => {
  const run = (enabledTools: string[] | undefined, toolName: string) =>
    runGraph(
      [node("in", "input"), node("t", "tool", { toolName }), node("out", "output")],
      [edge("e1", "in", "t"), edge("e2", "t", "out")],
      "2+2",
      makeDeps({
        skills: skillRegistry(),
        enabledTools,
        toolContext: { agentId: "a", orgId: "o" },
      }).deps,
    );

  const enabled = await run(["calculator"], "calculator");
  assert.equal(enabled.output, "4");

  // http_request exists in the registry but this agent's owner never enabled it.
  const added = await run(["calculator"], "http_request");
  assert.equal(added.status, "failed");
  const entry = added.trace.find((t) => t.nodeId === "t")!;
  assert.equal(entry.status, "refused");
  assert.match(entry.error!, /tool "http_request" is not enabled on this agent/);

  // No enabledTools at all means none are enabled.
  const none = await run(undefined, "calculator");
  assert.equal(none.trace.find((t) => t.nodeId === "t")!.status, "refused");
});

test("tool nodes run in the mode the caller set (trial for a marketplace buyer)", async () => {
  const seen: string[] = [];
  const registry = skillRegistry();
  registry.register({
    key: "spend",
    version: "1.0.0",
    name: "Spend",
    description: "moves money",
    inputSchema: { type: "object", properties: { what: { type: "string" } } },
    moneyMoving: true,
    execute: async (_input, ctx) => {
      seen.push(ctx.mode);
      return { status: "ok", output: "spent" };
    },
  });
  const run = (toolMode?: "trial") =>
    runGraph(
      [node("in", "input"), node("t", "tool", { toolName: "spend" }), node("out", "output")],
      [edge("e1", "in", "t"), edge("e2", "t", "out")],
      "x",
      makeDeps({
        skills: registry,
        enabledTools: ["spend"],
        toolMode,
        toolContext: { agentId: "a", orgId: "o" },
      }).deps,
    );

  assert.equal((await run()).output, "spent");
  assert.deepEqual(seen, ["graph"]);

  const trial = await run("trial");
  assert.equal(trial.status, "failed");
  assert.match(trial.error!, /moves money and is disabled in trial mode/);
  assert.deepEqual(seen, ["graph"], "the money-moving skill did not run in trial mode");
});

// ---------------- deadline, cancellation, delay budget ----------------

test("a whole-run wall-clock budget ends a run that hangs, and says so", async () => {
  let llmStarted = false;
  const { deps } = makeDeps({
    limits: { maxRunMs: 40 },
    // A model call that never returns and ignores its signal.
    runLlm: () => {
      llmStarted = true;
      return new Promise(() => {});
    },
  });
  const started = Date.now();
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm"), node("out", "output")],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "x",
    deps,
  );
  assert.ok(llmStarted);
  assert.ok(Date.now() - started < 2_000, "the run did not wait for the hung call");
  assert.equal(result.status, "failed");
  assert.match(result.error!, /run exceeded its time budget of 40ms/);
  assert.equal(result.trace.find((t) => t.nodeId === "llm")!.status, "failed");
});

test("a REAL delay is cut short by the deadline instead of sleeping its full length", async () => {
  // No injected sleep: the default timer-based one.
  const deps: GraphInterpreterDeps = {
    runLlm: async () => ({ content: "x" }),
    limits: { maxRunMs: 50 },
  };
  const started = Date.now();
  const result = await runGraph(
    [node("in", "input"), node("w", "delay", { ms: 30_000 }), node("out", "output")],
    [edge("e1", "in", "w"), edge("e2", "w", "out")],
    "x",
    deps,
  );
  assert.ok(Date.now() - started < 2_000);
  assert.match(result.error!, /time budget/);
});

test("cancelling the caller's signal aborts the run mid-delay (client closed the tab)", async () => {
  const controller = new AbortController();
  const deps: GraphInterpreterDeps = {
    runLlm: async () => ({ content: "x" }),
    signal: controller.signal,
    // An injected sleep that would never finish on its own.
    sleep: () => new Promise(() => {}),
  };
  setTimeout(() => controller.abort(), 20);
  const result = await runGraph(
    [node("in", "input"), node("w", "delay", { ms: 10_000 }), node("after", "transform"), node("out", "output")],
    [edge("e1", "in", "w"), edge("e2", "w", "after"), edge("e3", "after", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error, "run cancelled", "a cancel is not reported as a time budget");
  assert.ok(!traceOf(result).includes("after:success"), "nothing ran after the cancel");
});

test("a loop of delays is held to the run's total delay budget", async () => {
  const waited: number[] = [];
  const { deps } = makeDeps({
    sleep: async (ms) => void waited.push(ms),
  });
  // 20 iterations x 30s would be 10 minutes of sleeping.
  const result = await runGraph(
    [node("in", "input"), node("lp", "loop", { mode: "count", count: 20 }), node("w", "delay", { ms: 30_000 }), node("out", "output")],
    [edge("e1", "in", "lp"), edge("e2", "lp", "w", "body"), edge("e3", "lp", "out", "done")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /total delay budget of 60000ms would be exceeded \(60000ms already used\)/);
  assert.deepEqual(waited, [30_000, 30_000], "it stopped BEFORE sleeping past the budget");
});

test("delays across separate nodes count against the same budget", async () => {
  const { deps } = makeDeps({ sleep: async () => {} });
  const result = await runGraph(
    [
      node("in", "input"),
      node("a", "delay", { ms: 25_000 }),
      node("b", "delay", { ms: 25_000 }),
      node("c", "delay", { ms: 25_000 }),
      node("out", "output"),
    ],
    [edge("e1", "in", "a"), edge("e2", "a", "b"), edge("e3", "b", "c"), edge("e4", "c", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /node "c" failed: the run's total delay budget/);
});

test("the deadline timer does not outlive a finished run", async () => {
  // If the timer were left pending this would hold the process open for 5
  // minutes; the suite finishing promptly is the assertion, and the result is
  // the ordinary completed one.
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("out", "output")],
    [edge("e1", "in", "out")],
    "done",
    deps,
  );
  assert.equal(result.status, "completed");
});

test("outbound failures in an api node carry no resolved address in the trace", async () => {
  const { deps } = makeDeps({
    httpFetch: async () => {
      throw new (await import("../lib/ssrfGuard.js")).SsrfBlockedError(
        "blocked outbound request: host db.internal resolves to 10.0.3.7, which is not a public address",
        "blocked outbound request: the host does not resolve to a public internet address",
      );
    },
  });
  const result = await runGraph(
    [node("in", "input"), node("call", "api", { url: "https://db.internal/" }), node("out", "output")],
    [edge("e1", "in", "call"), edge("e2", "call", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  const blob = JSON.stringify(result);
  assert.ok(!blob.includes("10.0.3.7"), "the internal address must not reach the trace");
  assert.match(result.error!, /does not resolve to a public internet address/);
});
