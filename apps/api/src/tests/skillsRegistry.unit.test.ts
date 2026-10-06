import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getSkillsConfig, loadSkillsConfig, resetSkillsConfigCache, SkillsConfigError } from "../config/skills.js";
import { InMemoryAgentFileStore, sanitizeAgentFilePath } from "../services/skills/agentFileStore.js";
import { makeMemoryAgentFileLock, makeRedisAgentFileLock } from "../services/skills/agentFileLock.js";
import type { BuiltinSkillDeps } from "../services/skills/builtinDeps.js";
import { SkillRegistry, createSkillRegistry } from "../services/skills/registry.js";
import { createSandboxRunner } from "../services/skills/sandboxRunner.js";
import type { SkillDefinition, ToolContext } from "../services/skills/types.js";

// Drives services/skills/*: the registry, its mode guard, and every built-in
// skill. The standing rule under test: a skill that cannot do its job says
// "unavailable: <reason>" - it never returns plausible made-up output - and
// nothing here ever executes code in this process.

const PUBLIC_IP = ["93.184.216.34"];
const guardDeps = { resolveHost: async () => PUBLIC_IP };

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  mode: "playground",
  agentId: "agent_1",
  orgId: "org_1",
  ...over,
});

function makeDeps(
  env: Record<string, string> = {},
  over: Partial<BuiltinSkillDeps> = {},
): BuiltinSkillDeps {
  const config = loadSkillsConfig(env);
  return {
    getConfig: () => ({ config, error: null }),
    getFileStore: () => null,
    getSandbox: () => null,
    knowledge: {
      loadKnowledgeBaseId: async () => null,
      search: async () => ({ results: [], mode: "keyword", fallbackReason: null }),
    },
    guardDeps,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ============================================
// Configuration (config/skills.ts)
// ============================================

test("with nothing configured, every provider reads as unconfigured and limits default", () => {
  const config = loadSkillsConfig({});
  assert.equal(config.tavilyApiKey, undefined);
  assert.equal(config.sandbox, null);
  assert.deepEqual(config.agentFiles, { maxBytes: 1_048_576, maxCount: 50 });
});

test("empty strings from a .env file mean unset, not configured-as-empty", () => {
  const config = loadSkillsConfig({ TAVILY_API_KEY: "  ", SANDBOX_RUNNER_URL: "" });
  assert.equal(config.tavilyApiKey, undefined);
  assert.equal(config.sandbox, null);
});

test("a sandbox is configured from its URL, with documented defaults", () => {
  const config = loadSkillsConfig({
    SANDBOX_RUNNER_URL: "https://runner.example.com/run",
    SANDBOX_RUNNER_TOKEN: "tok",
  });
  assert.deepEqual(config.sandbox, {
    url: "https://runner.example.com/run",
    token: "tok",
    languages: ["python", "javascript"],
    timeoutMs: 15_000,
    maxOutputBytes: 65_536,
  });
});

test("malformed configuration is named, not guessed at", () => {
  assert.throws(() => loadSkillsConfig({ SANDBOX_RUNNER_URL: "not a url" }), SkillsConfigError);
  assert.throws(
    () => loadSkillsConfig({ SANDBOX_RUNNER_URL: "ftp://runner.example.com" }),
    /must be http or https/,
  );
  assert.throws(
    () => loadSkillsConfig({ SANDBOX_RUNNER_URL: "https://user:pw@runner.example.com" }),
    /must not embed credentials/,
  );
  assert.throws(
    () => loadSkillsConfig({ SANDBOX_RUNNER_URL: "https://r.example.com", SANDBOX_TIMEOUT_MS: "5" }),
    /SANDBOX_TIMEOUT_MS/,
  );
  assert.throws(
    () => loadSkillsConfig({ SANDBOX_RUNNER_URL: "https://r.example.com", SANDBOX_LANGUAGES: "py thon" }),
    /not a valid language id/,
  );
  assert.throws(() => loadSkillsConfig({ AGENT_FILES_MAX_COUNT: "0" }), /AGENT_FILES_MAX_COUNT/);
});

test("a misconfigured environment degrades to 'unconfigured' with the error kept", () => {
  const saved = { ...process.env };
  try {
    process.env.SANDBOX_RUNNER_URL = "ftp://nope";
    resetSkillsConfigCache();
    const state = getSkillsConfig();
    assert.equal(state.config.sandbox, null);
    assert.match(state.error!, /must be http or https/);
  } finally {
    process.env = saved;
    resetSkillsConfigCache();
  }
});

// ============================================
// Registry + the money-moving guard
// ============================================

const fakeSkill = (over: Partial<SkillDefinition> = {}): SkillDefinition => ({
  key: "fake",
  version: "1.0.0",
  name: "Fake",
  description: "fake",
  inputSchema: { type: "object", properties: {} },
  moneyMoving: false,
  execute: async () => ({ status: "ok", output: "ran" }),
  ...over,
});

test("the registry lists every built-in with a version and a schema", () => {
  const registry = createSkillRegistry(makeDeps());
  assert.deepEqual(
    registry.list().map((s) => s.key).sort(),
    [
      "calculator",
      "code_interpreter",
      "file_read",
      "file_write",
      "http_request",
      "knowledge_search",
      "web_search",
    ],
  );
  for (const skill of registry.list()) {
    assert.match(skill.version, /^\d+\.\d+\.\d+$/, skill.key);
    assert.equal(skill.inputSchema.type, "object", skill.key);
    assert.equal(skill.moneyMoving, false, `${skill.key}: nothing is money-moving yet`);
  }
});

test("duplicate keys and keys that are not valid function names are refused", () => {
  const registry = new SkillRegistry([fakeSkill()]);
  assert.throws(() => registry.register(fakeSkill()), /already registered/);
  assert.throws(() => registry.register(fakeSkill({ key: "has space" })), /valid function name/);
});

test("money-moving skills are withheld from the model in trial mode and run elsewhere", () => {
  const registry = new SkillRegistry([
    fakeSkill({ key: "hire_agent", moneyMoving: true }),
    fakeSkill({ key: "calculator" }),
  ]);
  const names = (mode: ToolContext["mode"]) =>
    registry.toolSpecs(["hire_agent", "calculator"], { mode }).map((s) => s.function.name);

  assert.deepEqual(names("trial"), ["calculator"]);
  for (const mode of ["playground", "job", "scheduled", "graph"] as const) {
    assert.deepEqual(names(mode), ["hire_agent", "calculator"], mode);
  }
});

test("a hallucinated call to a money-moving skill in trial mode is refused at execute time", async () => {
  let ran = false;
  const registry = new SkillRegistry([
    fakeSkill({
      key: "hire_agent",
      moneyMoving: true,
      execute: async () => {
        ran = true;
        return { status: "ok", output: "hired" };
      },
    }),
  ]);
  const trial = await registry.execute("hire_agent", {}, ctx({ mode: "trial" }));
  assert.equal(trial.status, "unavailable");
  assert.match((trial as { reason: string }).reason, /moves money.*trial/);
  assert.equal(ran, false, "the skill body must not run");

  const real = await registry.execute("hire_agent", {}, ctx({ mode: "playground" }));
  assert.equal(real.status, "ok");
  assert.equal(ran, true);
});

test("unknown skill names are dropped from the tool list and error on execute", async () => {
  const registry = createSkillRegistry(makeDeps());
  assert.deepEqual(registry.toolSpecs(["file_browser", "calculator", "calculator"], { mode: "playground" }).map((s) => s.function.name), ["calculator"]);
  assert.deepEqual(await registry.execute("file_browser", {}, ctx()), {
    status: "error",
    message: 'unknown tool "file_browser"',
  });
});

test("an unavailable skill is still offered to the model, and answers 'unavailable' when called", async () => {
  const registry = createSkillRegistry(makeDeps()); // no Tavily key
  assert.equal(registry.toolSpecs(["web_search"], { mode: "playground" }).length, 1);
  const result = await registry.execute("web_search", { query: "x" }, ctx());
  assert.deepEqual(result, {
    status: "unavailable",
    reason: "web search is not configured on this server",
  });
});

test("a skill that throws becomes a generic error result (no internals leak); an abort still propagates", async () => {
  const registry = new SkillRegistry([
    fakeSkill({
      key: "boom",
      execute: async () => {
        throw new Error("AccessDenied: arn:aws:s3:::internal-bucket/agent-files/org_1");
      },
    }),
  ]);
  assert.deepEqual(await registry.execute("boom", {}, ctx()), {
    status: "error",
    message: "the tool failed unexpectedly",
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    registry.execute("boom", {}, ctx({ signal: controller.signal })),
    (err: unknown) => (err as Error).name === "AbortError",
  );
});

test("describe() reports availability and the reason, including agent-level facts", () => {
  const registry = createSkillRegistry(makeDeps());
  const byKey = Object.fromEntries(registry.describe().map((d) => [d.key, d]));

  assert.equal(byKey.calculator!.available, true);
  assert.equal(byKey.calculator!.unavailableReason, null);

  assert.equal(byKey.web_search!.available, false);
  assert.equal(byKey.web_search!.unavailableReason, "web search is not configured on this server");
  assert.deepEqual(byKey.web_search!.requires, ["TAVILY_API_KEY"]);

  assert.equal(byKey.code_interpreter!.available, false);
  assert.match(byKey.code_interpreter!.unavailableReason!, /code execution sandbox is not configured/);

  assert.equal(byKey.file_write!.available, false);
  assert.match(byKey.file_write!.unavailableReason!, /file storage is not configured/);

  // knowledge_search: server-level it is fine; per agent it needs a KB.
  assert.equal(byKey.knowledge_search!.available, true);
  const noKb = registry.describe({ hasKnowledgeBase: false }).find((d) => d.key === "knowledge_search")!;
  assert.equal(noKb.available, false);
  assert.match(noKb.unavailableReason!, /no knowledge base bound/);
});

test("a malformed skills environment shows up as the reason, not as silence", () => {
  const registry = createSkillRegistry(
    makeDeps({}, {
      getConfig: () => ({
        config: loadSkillsConfig({}),
        error: "Invalid skills configuration: SANDBOX_RUNNER_URL must be http or https",
      }),
    }),
  );
  const byKey = Object.fromEntries(registry.describe().map((d) => [d.key, d]));
  assert.match(byKey.web_search!.unavailableReason!, /misconfigured.*SANDBOX_RUNNER_URL/);
  assert.match(byKey.code_interpreter!.unavailableReason!, /misconfigured/);
});

// ============================================
// calculator
// ============================================

test("calculator evaluates with the parser and reports bad input as an error", async () => {
  const registry = createSkillRegistry(makeDeps());
  assert.deepEqual(await registry.execute("calculator", { expression: "17*23" }, ctx()), {
    status: "ok",
    output: "391",
  });
  const bad = await registry.execute("calculator", { expression: "process.exit(1)" }, ctx());
  assert.equal(bad.status, "error");
  const missing = await registry.execute("calculator", {}, ctx());
  assert.equal(missing.status, "error");
});

// ============================================
// http_request (SSRF guard)
// ============================================

test("http_request refuses loopback, metadata and non-http URLs through the SSRF guard", async () => {
  // No fetchImpl and no guardDeps: the REAL guard, which classifies IP
  // literals without any network.
  const registry = createSkillRegistry(makeDeps({}, { guardDeps: undefined }));
  for (const url of [
    "http://127.0.0.1:5432/",
    "http://169.254.169.254/latest/meta-data/",
    "http://2130706433/",
    "http://[::1]/",
    "file:///etc/passwd",
  ]) {
    const result = await registry.execute("http_request", { url }, ctx());
    assert.equal(result.status, "error", url);
    assert.match((result as { message: string }).message, /blocked outbound request/, url);
  }
});

test("http_request returns status and a clipped body, and never sends forbidden headers", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const registry = createSkillRegistry(
    makeDeps({}, {
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response("B".repeat(9_000), { status: 200 });
      }) as unknown as typeof fetch,
    }),
  );
  const ok = await registry.execute("http_request", { url: "https://example.com/data", method: "get" }, ctx());
  assert.equal(ok.status, "ok");
  const output = (ok as { output: string }).output;
  assert.match(output, /^Status: 200\n\n/);
  assert.match(output, /\[truncated 4000 chars\]/);
  assert.equal(seen[0]!.init.method, "GET");

  const hostHeader = await registry.execute(
    "http_request",
    { url: "https://example.com/", headers: { Host: "internal.service" } },
    ctx(),
  );
  assert.equal(hostHeader.status, "error");
  assert.match((hostHeader as { message: string }).message, /"Host" header cannot be set/);
  assert.equal(seen.length, 1, "the request with a forbidden header was never sent");
});

test("http_request does not follow a redirect into the internal network", async () => {
  const registry = createSkillRegistry(
    makeDeps({}, {
      fetchImpl: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        })) as unknown as typeof fetch,
    }),
  );
  const result = await registry.execute("http_request", { url: "https://example.com/redir" }, ctx());
  assert.equal(result.status, "error");
  assert.match((result as { message: string }).message, /blocked outbound request/);
});

// ============================================
// web_search (Tavily)
// ============================================

test("web_search without a key is 'unavailable', not an empty result list", async () => {
  const registry = createSkillRegistry(makeDeps());
  assert.deepEqual(await registry.execute("web_search", { query: "solana" }, ctx()), {
    status: "unavailable",
    reason: "web search is not configured on this server",
  });
});

test("web_search calls Tavily with a bearer key, no redirects, and formats the results", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const registry = createSkillRegistry(
    makeDeps({ TAVILY_API_KEY: "tvly-secret" }, {
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url, init };
        return jsonResponse({
          results: [
            { title: "Solana docs", url: "https://docs.solana.com", content: "Solana is fast.", score: 0.9 },
            { title: "Blog", url: "https://blog.example", content: "x".repeat(2_000), score: 0.5 },
          ],
        });
      }) as unknown as typeof fetch,
    }),
  );
  const result = await registry.execute("web_search", { query: "what is solana", max_results: 2 }, ctx());
  assert.equal(result.status, "ok");
  const output = (result as { output: string }).output;
  assert.match(output, /\[1\] Solana docs\nhttps:\/\/docs\.solana\.com\nSolana is fast\./);
  assert.match(output, /\[truncated \d+ chars\]/, "excerpts are bounded");

  assert.equal(captured!.url, "https://api.tavily.com/search");
  assert.equal(captured!.init.method, "POST");
  assert.equal((captured!.init.headers as Record<string, string>).Authorization, "Bearer tvly-secret");
  assert.equal(captured!.init.redirect, "manual");
  assert.deepEqual(JSON.parse(String(captured!.init.body)), {
    query: "what is solana",
    max_results: 2,
    search_depth: "basic",
    include_answer: false,
  });
});

test("web_search maps provider failures to honest errors and never leaks the key", async () => {
  const respond = (status: number, body: unknown = {}) =>
    createSkillRegistry(
      makeDeps({ TAVILY_API_KEY: "tvly-secret" }, {
        fetchImpl: (async () => jsonResponse(body, status)) as unknown as typeof fetch,
      }),
    );

  const unauthorized = await respond(401).execute("web_search", { query: "x" }, ctx());
  assert.equal(unauthorized.status, "error");
  assert.match((unauthorized as { message: string }).message, /rejected this server's API key/);

  const limited = await respond(429).execute("web_search", { query: "x" }, ctx());
  assert.match((limited as { message: string }).message, /rate limit/);

  const broken = await respond(200, { results: "nope" }).execute("web_search", { query: "x" }, ctx());
  assert.match((broken as { message: string }).message, /unexpected response shape/);

  for (const r of [unauthorized, limited, broken]) {
    assert.ok(!JSON.stringify(r).includes("tvly-secret"));
  }
});

test("web_search with zero hits says so", async () => {
  const registry = createSkillRegistry(
    makeDeps({ TAVILY_API_KEY: "k" }, {
      fetchImpl: (async () => jsonResponse({ results: [] })) as unknown as typeof fetch,
    }),
  );
  const result = await registry.execute("web_search", { query: "zzzz" }, ctx());
  assert.deepEqual(result, { status: "ok", output: 'No web results found for "zzzz".' });
});

// ============================================
// knowledge_search
// ============================================

test("knowledge_search is 'unavailable' for an agent with no knowledge base", async () => {
  const registry = createSkillRegistry(makeDeps());
  const result = await registry.execute("knowledge_search", { query: "refunds" }, ctx());
  assert.equal(result.status, "unavailable");
  assert.match((result as { reason: string }).reason, /no knowledge base bound/);
});

test("knowledge_search reports the retrieval mode honestly", async () => {
  const search = (mode: "semantic" | "keyword", fallbackReason: string | null) =>
    createSkillRegistry(
      makeDeps({}, {
        knowledge: {
          loadKnowledgeBaseId: async () => "kb_1",
          search: async () => ({
            results: [
              { chunkId: "c1", documentId: "d1", documentTitle: "Refund policy", content: "Refunds within 30 days.", score: 0.8 },
            ],
            mode,
            fallbackReason,
          }),
        },
      }),
    );

  const semantic = await search("semantic", null).execute("knowledge_search", { query: "refunds" }, ctx());
  assert.match((semantic as { output: string }).output, /^retrieval mode: semantic\n\n\[1\] Refund policy \(score 0\.80\)\nRefunds within 30 days\./);

  const keyword = await search("keyword", "no embedding provider is configured").execute(
    "knowledge_search",
    { query: "refunds" },
    ctx(),
  );
  const text = (keyword as { output: string }).output;
  assert.match(text, /retrieval mode: keyword \(word-overlap matching, not semantic - no embedding provider is configured\)/);
});

test("knowledge_search never repeats the embedding provider's error body (the operator's org id and quota)", async () => {
  const { publicFallbackReason } = await import("../services/skills/knowledgeSearchSkill.js");
  // Exactly what trySemanticSearch builds from createEmbeddings' error.
  const leaky =
    'embedding provider error: embeddings request failed: 429 {"error":{"message":"Rate limit reached for text-embedding-3-small in organization org-PLATFORM1234 ... Limit 3000, Used 3000"}}';
  const registry = createSkillRegistry(
    makeDeps({}, {
      knowledge: {
        loadKnowledgeBaseId: async () => "kb_1",
        search: async () => ({
          results: [
            { chunkId: "c1", documentId: "d1", documentTitle: "Refund policy", content: "Refunds within 30 days.", score: 0.8 },
          ],
          mode: "keyword",
          fallbackReason: leaky,
        }),
      },
    }),
  );
  const result = await registry.execute("knowledge_search", { query: "refunds" }, ctx());
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("org-PLATFORM1234"), serialized);
  assert.ok(!serialized.includes("Limit 3000"));
  // The honest part survives: it fell back, and why in our own words.
  assert.match((result as { output: string }).output, /not semantic - embedding provider error \(HTTP 429\)\)/);

  // The playground returns the same reason through the same function.
  assert.equal(publicFallbackReason(leaky), "embedding provider error (HTTP 429)");
  assert.equal(
    publicFallbackReason("embedding provider error: connect ECONNREFUSED 10.0.0.9:443"),
    "embedding provider error",
  );
  assert.equal(publicFallbackReason("no embedding provider is configured"), "no embedding provider is configured");
  assert.equal(publicFallbackReason(null), null);
});

test("knowledge_search with no matching passages says so", async () => {
  const registry = createSkillRegistry(
    makeDeps({}, {
      knowledge: {
        loadKnowledgeBaseId: async () => "kb_1",
        search: async () => ({ results: [], mode: "keyword", fallbackReason: null }),
      },
    }),
  );
  const result = await registry.execute("knowledge_search", { query: "zzz" }, ctx());
  assert.deepEqual(result, { status: "ok", output: "No passages in the knowledge base matched the query." });
});

// ============================================
// file_read / file_write
// ============================================

test("path sanitisation is an allowlist: traversal and oddities are all refused", () => {
  const bad = [
    "",
    "   ",
    "../secret",
    "a/../../b",
    "/etc/passwd",
    "a//b",
    "a/./b",
    ".",
    "..",
    "dir/",
    "a\\b",
    "a\0b",
    "a b",
    "naïve.txt",
    "x".repeat(201),
    "a/b/c/d/e/f/g/h/i",
    "agent-files/other/../x",
  ];
  for (const p of bad) {
    assert.equal(sanitizeAgentFilePath(p).ok, false, JSON.stringify(p));
  }
  assert.equal(sanitizeAgentFilePath(42).ok, false);
  for (const p of ["notes.txt", "a/b/c.md", "my-file_1.json", ".hidden"]) {
    assert.deepEqual(sanitizeAgentFilePath(p), { ok: true, path: p }, p);
  }
});

test("file skills are 'unavailable' without storage, and without an agent context", async () => {
  const noStore = createSkillRegistry(makeDeps());
  for (const [key, input] of [
    ["file_write", { path: "a.txt", content: "x" }],
    ["file_read", { path: "a.txt" }],
  ] as const) {
    const r = await noStore.execute(key, input, ctx());
    assert.deepEqual(r, { status: "unavailable", reason: "file storage is not configured on this server" }, key);
  }

  const store = new InMemoryAgentFileStore();
  const withStore = createSkillRegistry(makeDeps({}, { getFileStore: () => store }));
  const r = await withStore.execute("file_read", { path: "a.txt" }, ctx({ agentId: "", orgId: "" }));
  assert.deepEqual(r, { status: "unavailable", reason: "no agent context for this run" });
});

test("file_write then file_read round-trips under an agent-scoped prefix", async () => {
  const store = new InMemoryAgentFileStore();
  const registry = createSkillRegistry(makeDeps({}, { getFileStore: () => store }));

  const written = await registry.execute("file_write", { path: "notes/todo.txt", content: "buy milk" }, ctx());
  assert.deepEqual(written.status, "ok");
  assert.deepEqual([...store.objects.keys()], ["agent-files/org_1/agent_1/notes/todo.txt"]);

  assert.deepEqual(await registry.execute("file_read", { path: "notes/todo.txt" }, ctx()), {
    status: "ok",
    output: "buy milk",
  });

  // Another agent, same path: a different file, and it cannot see the first.
  const other = await registry.execute("file_read", { path: "notes/todo.txt" }, ctx({ agentId: "agent_2" }));
  assert.equal(other.status, "error");
  assert.match((other as { message: string }).message, /no such file/);
  const otherOrg = await registry.execute("file_read", {}, ctx({ orgId: "org_2" }));
  assert.deepEqual(otherOrg, { status: "ok", output: "No files stored yet." });
});

test("a model cannot reach outside its prefix by naming one", async () => {
  const store = new InMemoryAgentFileStore();
  await store.put("agent-files/org_1/agent_2/secret.txt", "other agent");
  const registry = createSkillRegistry(makeDeps({}, { getFileStore: () => store }));
  for (const p of ["../agent_2/secret.txt", "/agent-files/org_1/agent_2/secret.txt", "..%2Fagent_2/secret.txt"]) {
    const r = await registry.execute("file_read", { path: p }, ctx());
    assert.equal(r.status, "error", p);
  }
});

test("file_write enforces the per-file size limit and the per-agent file count", async () => {
  const store = new InMemoryAgentFileStore();
  const registry = createSkillRegistry(
    makeDeps({ AGENT_FILES_MAX_BYTES: "10", AGENT_FILES_MAX_COUNT: "2" }, { getFileStore: () => store }),
  );

  const tooBig = await registry.execute("file_write", { path: "big.txt", content: "12345678901" }, ctx());
  assert.equal(tooBig.status, "error");
  assert.match((tooBig as { message: string }).message, /11 bytes.*limit is 10/);
  // Bytes, not characters: 4 x 3-byte characters = 12 bytes.
  const multibyte = await registry.execute("file_write", { path: "m.txt", content: "€€€€" }, ctx());
  assert.equal(multibyte.status, "error");

  await registry.execute("file_write", { path: "a.txt", content: "a" }, ctx());
  await registry.execute("file_write", { path: "b.txt", content: "b" }, ctx());
  const third = await registry.execute("file_write", { path: "c.txt", content: "c" }, ctx());
  assert.equal(third.status, "error");
  assert.match((third as { message: string }).message, /already holds 2 files; the limit is 2/);
  assert.equal(store.objects.size, 2);

  // Overwriting an existing file is allowed at the limit.
  const overwrite = await registry.execute("file_write", { path: "a.txt", content: "A" }, ctx());
  assert.equal(overwrite.status, "ok");
  assert.match((overwrite as { output: string }).output, /^Overwrote a\.txt/);
});

test("file_read lists files when no path is given and pages long files", async () => {
  const store = new InMemoryAgentFileStore();
  const registry = createSkillRegistry(makeDeps({}, { getFileStore: () => store }));
  await registry.execute("file_write", { path: "b.txt", content: "bb" }, ctx());
  await registry.execute("file_write", { path: "a.txt", content: "a".repeat(14_000) }, ctx());

  const listing = await registry.execute("file_read", {}, ctx());
  assert.equal((listing as { output: string }).output, "2 file(s):\na.txt (14000 bytes)\nb.txt (2 bytes)");

  const page1 = (await registry.execute("file_read", { path: "a.txt" }, ctx())) as { output: string };
  assert.match(page1.output, /showing characters 0-6000 of 14000; call again with offset=6000/);
  const page3 = (await registry.execute("file_read", { path: "a.txt", offset: 12_000 }, ctx())) as { output: string };
  assert.equal(page3.output, "a".repeat(2_000));
  const past = await registry.execute("file_read", { path: "a.txt", offset: 99_999 }, ctx());
  assert.equal(past.status, "error");
});

test("file_read reports an oversize stored file, but never leaks a storage error's detail", async () => {
  const store = new InMemoryAgentFileStore();
  await store.put("agent-files/org_1/agent_1/big.txt", "x".repeat(50));
  const small = createSkillRegistry(makeDeps({ AGENT_FILES_MAX_BYTES: "10" }, { getFileStore: () => store }));
  const big = await small.execute("file_read", { path: "big.txt" }, ctx());
  assert.deepEqual(big, { status: "error", message: "stored file is larger than 10 bytes" });

  const leaky = createSkillRegistry(
    makeDeps({}, {
      getFileStore: () => ({
        put: async () => {},
        delete: async () => {},
        list: async () => [],
        get: async () => {
          throw new Error("AccessDenied: arn:aws:s3:::internal-bucket");
        },
      }),
    }),
  );
  const result = await leaky.execute("file_read", { path: "a.txt" }, ctx());
  assert.deepEqual(result, { status: "error", message: "the tool failed unexpectedly" });
});

test("file_write rejects a bad path with the reason", async () => {
  const store = new InMemoryAgentFileStore();
  const registry = createSkillRegistry(makeDeps({}, { getFileStore: () => store }));
  const r = await registry.execute("file_write", { path: "../x", content: "y" }, ctx());
  assert.equal(r.status, "error");
  assert.match((r as { message: string }).message, /invalid path/);
  assert.equal(store.objects.size, 0);
});

// ============================================
// code_interpreter + the sandbox runner
// ============================================

const SANDBOX_ENV = {
  SANDBOX_RUNNER_URL: "https://runner.example.com/run",
  SANDBOX_RUNNER_TOKEN: "runner-token",
};

function sandboxDeps(
  respond: (req: { url: string; init: RequestInit; body: Record<string, any> }) => Response,
  env: Record<string, string> = {},
) {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, any> }> = [];
  const config = loadSkillsConfig({ ...SANDBOX_ENV, ...env });
  const runner = createSandboxRunner(config.sandbox, {
    fetchImpl: (async (url: string, init: RequestInit) => {
      const req = { url, init, body: JSON.parse(String(init.body)) };
      requests.push(req);
      return respond(req);
    }) as unknown as typeof fetch,
    guardDeps,
  });
  return { deps: makeDeps({ ...SANDBOX_ENV, ...env }, { getSandbox: () => runner }), requests };
}

test("code_interpreter without a runner is 'unavailable' - the code is never run here", async () => {
  const registry = createSkillRegistry(makeDeps());
  const marker = "__sandbox_was_run_locally__";
  (globalThis as Record<string, unknown>)[marker] = false;
  const result = await registry.execute(
    "code_interpreter",
    { language: "javascript", code: `globalThis.${marker} = true` },
    ctx(),
  );
  assert.equal(result.status, "unavailable");
  assert.match((result as { reason: string }).reason, /^code execution sandbox is not configured/);
  assert.equal((globalThis as Record<string, unknown>)[marker], false);
  delete (globalThis as Record<string, unknown>)[marker];
});

test("code_interpreter sends the documented request and formats the runner's answer", async () => {
  const { deps, requests } = sandboxDeps(() =>
    jsonResponse({ exitCode: 0, stdout: "2\n", stderr: "", timedOut: false, durationMs: 41 }),
  );
  const registry = createSkillRegistry(deps);
  const result = await registry.execute("code_interpreter", { code: "print(1+1)", stdin: "in" }, ctx());

  assert.equal(result.status, "ok");
  assert.equal((result as { output: string }).output, "exit code: 0\nstdout:\n2\n");

  const req = requests[0]!;
  assert.equal(req.url, "https://runner.example.com/run");
  assert.equal(req.init.method, "POST");
  const headers = req.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer runner-token");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(req.init.redirect, "manual", "redirects are never followed with a bearer token");
  assert.deepEqual(req.body, {
    language: "python",
    code: "print(1+1)",
    stdin: "in",
    limits: { timeoutMs: 15_000, maxOutputBytes: 65_536 },
  });
});

test("a non-zero exit shows stderr to the model; a timeout says it was killed", async () => {
  const failing = sandboxDeps(() => jsonResponse({ exitCode: 1, stdout: "", stderr: "NameError: x" }));
  const r1 = await createSkillRegistry(failing.deps).execute("code_interpreter", { code: "x" }, ctx());
  assert.equal(r1.status, "ok", "the sandbox ran; the PROGRAM failed");
  assert.match((r1 as { output: string }).output, /exit code: 1\nstdout:\n\(empty\)\nstderr:\nNameError: x/);

  const slow = sandboxDeps(() => jsonResponse({ exitCode: null, stdout: "partial", stderr: "", timedOut: true }));
  const r2 = await createSkillRegistry(slow.deps).execute("code_interpreter", { code: "while True: pass" }, ctx());
  assert.match((r2 as { output: string }).output, /^execution timed out and was killed/);
});

test("runner output is re-truncated to the operator's cap whatever the runner sent", async () => {
  const { deps } = sandboxDeps(
    () => jsonResponse({ exitCode: 0, stdout: "x".repeat(5_000), stderr: "" }),
    { SANDBOX_MAX_OUTPUT_BYTES: "1024" },
  );
  const result = await createSkillRegistry(deps).execute("code_interpreter", { code: "print('x')" }, ctx());
  const output = (result as { output: string }).output;
  assert.ok(output.length < 1_300, `output was ${output.length} chars`);
  assert.match(output, /output truncated at the size limit/);
});

test("per-call limits are clamped to the configured ceiling", async () => {
  const config = loadSkillsConfig({ ...SANDBOX_ENV, SANDBOX_TIMEOUT_MS: "5000" });
  const bodies: Array<Record<string, any>> = [];
  const runner = createSandboxRunner(config.sandbox, {
    fetchImpl: (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ exitCode: 0, stdout: "", stderr: "" });
    }) as unknown as typeof fetch,
    guardDeps,
  })!;
  await runner.run("python", "pass", { timeoutMs: 999_999, maxOutputBytes: 999_999_999 });
  assert.deepEqual(bodies[0]!.limits, { timeoutMs: 5_000, maxOutputBytes: 65_536 });
});

test("runner failures are explicit errors: HTTP status, bad JSON, contract violations, bad language", async () => {
  const run = async (respond: () => Response, input: Record<string, unknown> = { code: "x" }) => {
    const { deps } = sandboxDeps(respond);
    return createSkillRegistry(deps).execute("code_interpreter", input, ctx());
  };

  const http500 = await run(
    () => new Response("Traceback: /srv/runner/app.py line 12 on host runner-7.internal", { status: 500 }),
  );
  assert.equal((http500 as { message: string }).message, "sandbox runner returned HTTP 500");
  assert.ok(!JSON.stringify(http500).includes("runner-7.internal"), "the runner's error body is logged, not returned");

  const notJson = await run(() => new Response("<html>", { status: 200 }));
  assert.match((notJson as { message: string }).message, /not JSON/);

  const badShape = await run(() => jsonResponse({ stdout: "hi" }));
  assert.equal((badShape as { message: string }).message, "sandbox runner response does not match the contract");

  const lang = await run(() => jsonResponse({ exitCode: 0, stdout: "" }), { language: "ruby", code: "x" });
  assert.match((lang as { message: string }).message, /language "ruby" is not enabled/);
});

test("the runner URL goes through the SSRF guard: a loopback runner is refused", async () => {
  const config = loadSkillsConfig({ SANDBOX_RUNNER_URL: "http://127.0.0.1:9000/run" });
  const runner = createSandboxRunner(config.sandbox)!; // real safeFetch
  await assert.rejects(
    runner.run("python", "print(1)", runner.limits),
    (err: unknown) => {
      // Generic: which address the URL was refused for describes the
      // operator's infrastructure and stays in the log.
      assert.equal((err as Error).message, "sandbox runner unreachable");
      return true;
    },
  );
});

// ============================================
// Concurrency: the per-agent file limit
// ============================================

/** A store whose operations yield, so concurrent writers really interleave. */
class SlowStore extends InMemoryAgentFileStore {
  override async put(key: string, body: string) {
    await new Promise((r) => setTimeout(r, 1));
    await super.put(key, body);
  }
  override async list(prefix: string) {
    await new Promise((r) => setTimeout(r, 1));
    return super.list(prefix);
  }
}

test("CONCURRENT writers cannot push an agent past its file limit", async () => {
  for (let round = 0; round < 10; round++) {
    const store = new SlowStore();
    await store.put("agent-files/org_1/agent_1/seed.txt", "seed");
    const registry = createSkillRegistry(
      makeDeps({ AGENT_FILES_MAX_COUNT: "3" }, { getFileStore: () => store }),
    );

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        registry.execute("file_write", { path: `f${i}.txt`, content: `n${i}` }, ctx()),
      ),
    );

    assert.ok(store.objects.size <= 3, `round ${round}: ${store.objects.size} files stored, limit 3`);
    const ok = results.flatMap((r, i) => (r.status === "ok" ? [`agent-files/org_1/agent_1/f${i}.txt`] : []));
    for (const key of ok) {
      assert.ok(store.objects.has(key), "a writer told 'ok' still has its file");
    }
    for (const [i, r] of results.entries()) {
      if (r.status === "error") {
        assert.ok(
          !store.objects.has(`agent-files/org_1/agent_1/f${i}.txt`),
          "a writer told 'error' left nothing behind",
        );
        assert.match((r as { message: string }).message, /the limit is 3/);
      }
    }
  }
});

test("a storage failure during a write is reported without the store's own words", async () => {
  class DeniedStore extends SlowStore {
    override async put(): Promise<void> {
      throw new Error("AccessDenied: arn:aws:s3:::internal-bucket");
    }
  }
  const store = new DeniedStore();
  const registry = createSkillRegistry(makeDeps({}, { getFileStore: () => store }));
  const r = await registry.execute("file_write", { path: "b.txt", content: "b" }, ctx());
  assert.equal(r.status, "error");
  assert.ok(!JSON.stringify(r).includes("internal-bucket"));
  assert.equal(store.objects.size, 0);
});

const KEY = (path: string) => `agent-files/org_1/agent_1/${path}`;

test("the store has no delete at all: nothing a skill does can remove a file", () => {
  // The data loss came from a compensating delete. Keep the capability out
  // of the interface so it cannot quietly come back.
  assert.equal("delete" in new InMemoryAgentFileStore(), false);
});

test("SAME-PATH concurrent writers: nobody is told 'ok' for a file that is gone or over the limit", async () => {
  for (let round = 0; round < 10; round++) {
    const store = new SlowStore();
    await store.put(KEY("s1"), "s1");
    await store.put(KEY("s2"), "s2");
    const registry = createSkillRegistry(
      makeDeps({ AGENT_FILES_MAX_COUNT: "3" }, { getFileStore: () => store }),
    );

    // A and C race for the same new path while B takes the last slot - the
    // interleaving in which A's rollback used to delete C's content.
    const writes = [
      { path: "p", content: "A-content" },
      { path: "q", content: "B-content" },
      { path: "p", content: "C-content" },
      { path: "p", content: "D-content" },
    ];
    const results = await Promise.all(
      writes.map((w) => registry.execute("file_write", w, ctx())),
    );

    assert.ok(store.objects.size <= 3, `round ${round}: ${store.objects.size} files, limit 3`);
    const okWrites = writes.filter((_, i) => results[i]!.status === "ok");
    assert.ok(okWrites.length >= 1);
    for (const w of okWrites) {
      // The file exists, and holds what SOME successful writer of that path
      // wrote (last writer wins) - never nothing.
      const stored = store.objects.get(KEY(w.path));
      assert.ok(stored !== undefined, `round ${round}: ${w.path} reported ok but is not stored`);
      assert.ok(
        okWrites.some((o) => o.path === w.path && o.content === stored),
        `round ${round}: ${w.path} holds ${stored}`,
      );
    }
    for (const [i, r] of results.entries()) {
      if (r.status !== "ok") {
        assert.match((r as { message: string }).message, /the limit is 3/);
        assert.notEqual(store.objects.get(KEY(writes[i]!.path)), writes[i]!.content);
      }
    }
    // Seeds are never collateral damage.
    assert.equal(store.objects.get(KEY("s1")), "s1");
    assert.equal(store.objects.get(KEY("s2")), "s2");
  }
});

test("two registries (two API replicas) sharing one lock still hold the limit", async () => {
  const store = new SlowStore();
  const fileLock = makeMemoryAgentFileLock();
  const replica = () =>
    createSkillRegistry(makeDeps({ AGENT_FILES_MAX_COUNT: "2" }, { getFileStore: () => store, fileLock }));
  const [a, b] = [replica(), replica()];
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      (i % 2 ? a : b).execute("file_write", { path: `f${i}.txt`, content: "x" }, ctx()),
    ),
  );
  assert.equal(store.objects.size, 2);
  assert.equal(results.filter((r) => r.status === "ok").length, 2);
});

test("the lock is per agent: another agent's writers are not queued behind this one", async () => {
  const store = new InMemoryAgentFileStore();
  const fileLock = makeMemoryAgentFileLock({ waitMs: 20 });
  const registry = createSkillRegistry(makeDeps({}, { getFileStore: () => store, fileLock }));
  const held = await fileLock.acquire("agent-files/org_1/agent_1/");
  assert.ok(held);

  const other = await registry.execute("file_write", { path: "a.txt", content: "a" }, ctx({ agentId: "agent_2" }));
  assert.equal(other.status, "ok");

  // ...while this agent's writer gives up and writes nothing.
  const queued = await registry.execute("file_write", { path: "a.txt", content: "a" }, ctx());
  assert.equal(queued.status, "error");
  assert.match((queued as { message: string }).message, /busy with other writes; nothing was written/);
  assert.equal(store.objects.has(KEY("a.txt")), false);

  await held.release();
  const retried = await registry.execute("file_write", { path: "a.txt", content: "a" }, ctx());
  assert.equal(retried.status, "ok");
});

test("no lock, no write: a lock backend that is down refuses the write (fail closed)", async () => {
  const store = new InMemoryAgentFileStore();
  const registry = createSkillRegistry(
    makeDeps({}, {
      getFileStore: () => store,
      fileLock: {
        acquire: async () => {
          throw new Error("ECONNREFUSED redis.internal:6379");
        },
      },
    }),
  );
  const r = await registry.execute("file_write", { path: "a.txt", content: "a" }, ctx());
  assert.equal(r.status, "unavailable");
  assert.ok(!JSON.stringify(r).includes("redis.internal"));
  assert.equal(store.objects.size, 0);
});

test("a count that cannot be taken refuses the write: nothing lands, and the lock is released", async () => {
  class FlakyList extends InMemoryAgentFileStore {
    failing = true;
    override async list(prefix: string) {
      if (this.failing) throw new Error("503 SlowDown");
      return super.list(prefix);
    }
  }
  const store = new FlakyList();
  const registry = createSkillRegistry(makeDeps({ AGENT_FILES_MAX_COUNT: "1" }, { getFileStore: () => store }));
  const failed = await registry.execute("file_write", { path: "a.txt", content: "a" }, ctx());
  assert.equal(failed.status, "error");
  assert.equal(store.objects.size, 0, "an unverified write was not kept");

  store.failing = false;
  const ok = await registry.execute("file_write", { path: "a.txt", content: "a" }, ctx());
  assert.equal(ok.status, "ok", "the failed attempt did not leave the agent locked");
});

test("a lease that ran out before the put starts no write", async () => {
  const store = new InMemoryAgentFileStore();
  const expired = new AbortController();
  let released = 0;
  const registry = createSkillRegistry(
    makeDeps({}, {
      getFileStore: () => store,
      fileLock: {
        acquire: async () => {
          expired.abort();
          return { signal: expired.signal, release: async () => void released++ };
        },
      },
    }),
  );
  const r = await registry.execute("file_write", { path: "a.txt", content: "a" }, ctx());
  assert.equal(r.status, "error");
  assert.match((r as { message: string }).message, /nothing was written/);
  assert.equal(store.objects.size, 0);
  assert.equal(released, 1);
});

test("a put abandoned when the lease runs out does not claim either outcome", async () => {
  const lease = new AbortController();
  class HangingPut extends InMemoryAgentFileStore {
    override async put(_key: string, _body: string, signal?: AbortSignal): Promise<void> {
      lease.abort();
      signal?.throwIfAborted();
    }
  }
  const store = new HangingPut();
  const registry = createSkillRegistry(
    makeDeps({}, {
      getFileStore: () => store,
      fileLock: { acquire: async () => ({ signal: lease.signal, release: async () => {} }) },
    }),
  );
  const r = await registry.execute("file_write", { path: "a.txt", content: "a" }, ctx());
  assert.equal(r.status, "error");
  assert.match((r as { message: string }).message, /may not have been saved; read the file back/);
});

// ============================================
// The Redis lease behind the file lock
// ============================================

/** SET NX PX + compare-and-delete, on a clock the test controls. */
function fakeLockRedis() {
  const state = { now: 0, keys: new Map<string, { value: string; expiresAt: number }>() };
  const live = (key: string) => {
    const entry = state.keys.get(key);
    if (entry && entry.expiresAt <= state.now) state.keys.delete(key);
    return state.keys.get(key);
  };
  return {
    state,
    set: async (key: string, value: string, _px: "PX", ttlMs: number, _nx: "NX") => {
      if (live(key)) return null;
      state.keys.set(key, { value, expiresAt: state.now + ttlMs });
      return "OK";
    },
    runScript: async (_script: string, [key = ""]: string[], [token]: string[]) => {
      if (live(key)?.value !== token) return 0;
      state.keys.delete(key);
      return 1;
    },
  };
}

test("redis lock: one holder at a time; a waiter gets its turn on release", async () => {
  const redis = fakeLockRedis();
  const sleeps: number[] = [];
  let first: Awaited<ReturnType<ReturnType<typeof makeRedisAgentFileLock>["acquire"]>> = null;
  const lock = makeRedisAgentFileLock(redis, {
    now: () => redis.state.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      redis.state.now += ms;
      // The holder finishes while the waiter sleeps.
      if (sleeps.length === 3) await first!.release();
    },
  });
  first = await lock.acquire("scope");
  assert.ok(first);
  const second = await lock.acquire("scope");
  assert.ok(second, "the waiter acquired once the holder released");
  assert.equal(sleeps.length, 3);
  await second.release();
  assert.equal(redis.state.keys.size, 0);
});

test("redis lock: a waiter that never gets a turn is refused, not let through", async () => {
  const redis = fakeLockRedis();
  const lock = makeRedisAgentFileLock(redis, {
    waitMs: 1_000,
    now: () => redis.state.now,
    sleep: async (ms) => void (redis.state.now += ms),
  });
  assert.ok(await lock.acquire("scope"));
  assert.equal(await lock.acquire("scope"), null);
  assert.ok(await lock.acquire("other-scope"), "scopes do not block each other");
});

test("redis lock: releasing an expired lease does not free the NEXT holder's lock", async () => {
  const redis = fakeLockRedis();
  const lock = makeRedisAgentFileLock(redis, {
    ttlMs: 1_000,
    safetyMarginMs: 100,
    now: () => redis.state.now,
    sleep: async (ms) => void (redis.state.now += ms),
  });
  const stale = await lock.acquire("scope");
  assert.ok(stale);
  redis.state.now += 1_001; // the first holder stalled past its lease
  const next = await lock.acquire("scope");
  assert.ok(next);

  await stale.release();
  assert.equal(redis.state.keys.size, 1, "the late release left the new holder's key alone");
  await next.release();
  assert.equal(redis.state.keys.size, 0, "the real holder's release still works");
});

test("redis lock: the holder is told to stop BEFORE the lease lapses", async () => {
  const lock = makeRedisAgentFileLock(fakeLockRedis(), { ttlMs: 60, safetyMarginMs: 40 });
  const lease = await lock.acquire("scope");
  assert.ok(lease);
  assert.equal(lease.signal.aborted, false);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(lease.signal.aborted, true);
  await lease.release();
});

test("redis lock: a backend error surfaces to the caller instead of reading as 'acquired'", async () => {
  const lock = makeRedisAgentFileLock({
    set: async () => {
      throw new Error("ECONNREFUSED");
    },
    runScript: async () => 0,
  });
  await assert.rejects(lock.acquire("scope"), /ECONNREFUSED/);
});

// ============================================
// test mode: the test runner must not change the agent
// ============================================

test("in test mode file_write is refused with a clear message; read-only skills still run", async () => {
  const store = new InMemoryAgentFileStore();
  await store.put("agent-files/org_1/agent_1/notes.txt", "saved earlier");
  const registry = createSkillRegistry(makeDeps({}, { getFileStore: () => store }));
  const testCtx = ctx({ mode: "test" });

  const write = await registry.execute("file_write", { path: "notes.txt", content: "OVERWRITTEN" }, testCtx);
  assert.equal(write.status, "unavailable");
  assert.match(
    (write as { reason: string }).reason,
    /"file_write" changes the agent's saved data and is disabled in test mode: tests must not modify the agent's files/,
  );
  assert.equal(store.objects.get("agent-files/org_1/agent_1/notes.txt"), "saved earlier");

  assert.deepEqual(await registry.execute("file_read", { path: "notes.txt" }, testCtx), {
    status: "ok",
    output: "saved earlier",
  });
  assert.deepEqual(await registry.execute("calculator", { expression: "2+2" }, testCtx), {
    status: "ok",
    output: "4",
  });

  // The model is not even offered the write tool in test mode.
  const names = registry
    .toolSpecs(["file_read", "file_write", "calculator"], { mode: "test" })
    .map((s) => s.function.name);
  assert.deepEqual(names, ["file_read", "calculator"]);
  // ...and is offered it everywhere else.
  assert.ok(
    registry.toolSpecs(["file_write"], { mode: "playground" }).some((s) => s.function.name === "file_write"),
  );
});

test("test mode also withholds money-moving skills", async () => {
  const registry = new SkillRegistry([fakeSkill({ key: "hire_agent", moneyMoving: true })]);
  assert.deepEqual(registry.toolSpecs(["hire_agent"], { mode: "test" }), []);
  const r = await registry.execute("hire_agent", {}, ctx({ mode: "test" }));
  assert.equal(r.status, "unavailable");
});

// ============================================
// No internal detail in what a model or user sees
// ============================================

test("http_request never reveals what a host resolved to (no internal-address oracle)", async () => {
  const INTERNAL = "10.0.3.7";
  const registry = createSkillRegistry(
    makeDeps({}, { guardDeps: { resolveHost: async () => [INTERNAL] } }),
  );
  const internal = await registry.execute("http_request", { url: "http://db.corp.example/" }, ctx());
  assert.equal(internal.status, "error");
  assert.equal(
    (internal as { message: string }).message,
    "blocked outbound request: the host does not resolve to a public internet address",
  );
  assert.ok(!JSON.stringify(internal).includes(INTERNAL));

  // A name that does not resolve at all reads exactly the same: otherwise the
  // difference between the two answers maps internal DNS.
  const unresolvable = createSkillRegistry(
    makeDeps({}, {
      guardDeps: {
        resolveHost: async () => {
          throw new Error("ENOTFOUND");
        },
      },
    }),
  );
  const missing = await unresolvable.execute("http_request", { url: "http://nope.corp.example/" }, ctx());
  assert.equal((missing as { message: string }).message, (internal as { message: string }).message);

  // Problems that only echo what the caller sent stay specific and useful.
  const scheme = await registry.execute("http_request", { url: "ftp://example.com/x" }, ctx());
  assert.match((scheme as { message: string }).message, /scheme ftp: is not allowed/);
});

// ============================================
// No code execution in the API process, ever
// ============================================

test("no skill or interpreter source can evaluate code in-process", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const servicesDir = path.join(here, "..", "services");
  const files = [
    ...readdirSync(path.join(servicesDir, "skills"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(servicesDir, "skills", f)),
    path.join(servicesDir, "graphInterpreter.ts"),
    path.join(servicesDir, "graphPlan.ts"),
    path.join(servicesDir, "toolLoop.ts"),
    path.join(servicesDir, "mastra-runtime.ts"),
  ];
  const forbidden: Array<[RegExp, string]> = [
    [/\bnew Function\s*\(/, "new Function("],
    [/(^|[^.\w])eval\s*\(/, "eval("],
    [/child_process/, "child_process"],
    [/from ["']node:vm["']|require\(["']vm["']\)/, "node:vm"],
    [/\bvm\.runIn/, "vm.runIn*"],
    [/worker_threads/, "worker_threads"],
  ];
  for (const file of files) {
    // Comments may legitimately NAME these; only code counts.
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const [pattern, name] of forbidden) {
      assert.doesNotMatch(code, pattern, `${path.basename(file)} must not use ${name}`);
    }
  }
});
