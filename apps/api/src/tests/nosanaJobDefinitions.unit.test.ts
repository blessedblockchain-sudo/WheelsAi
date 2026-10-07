import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import "./unitEnv.js";
import { generateAgentJobDefinition, type AgentConfig } from "../services/agent-runtime.js";
import { compileDeployPlan } from "../services/deployPlan.js";
import { parseElizaCharacter } from "../services/frameworks/eliza.js";
import {
  OLLAMA_IMAGE,
  apiPortWithHealthCheck,
  generateJobDefinition,
  generateOllamaJobDefinition,
  generateOllamaWithProxyJobDefinition,
  generateVllmJobDefinition,
  shellCommand,
  type ModelDeploymentConfig,
  type NosanaJobDefinition,
} from "../services/nosana.js";
import { buildOpenClawJobDefinition } from "../services/openclaw.js";
import { modelDeploymentOpenAiBaseUrl } from "../services/publicEndpoints.js";
import { buildTrainingJobDefinition } from "../services/trainingJobDefinition.js";
import { jobDefinitionErrors, startFakeNosanaApi } from "./fakeNosanaApi.js";

// Every job definition this API can send to Nosana, against the schema the
// Deployment Manager validates a create with (the ContainerRun type of
// @nosana/types 2.14.2, strict: an unknown key is a 400) and against how a
// node runs it (cmd goes to Docker after the image's own entrypoint unless
// the definition replaces it). Loopback only.

const fake = await startFakeNosanaApi();
after(() => fake.close());

// Written out here, not imported from the service or the stand-in: the list
// the generators are held to. @nosana/types 2.14.2, args/index.d.ts:29-43.
const CONTAINER_RUN_KEYS = [
  "image",
  "aliases",
  "cmd",
  "volumes",
  "expose",
  "gpu",
  "work_dir",
  "entrypoint",
  "env",
  "restart_policy",
  "private",
  "resources",
  "authentication",
];
const EXPOSED_PORT_KEYS = ["port", "type", "health_checks"];
const SHELLS = /^(?:\/usr)?(?:\/bin\/)?(?:sh|bash|dash|ash|zsh)$/;

const MODEL: ModelDeploymentConfig = {
  modelId: "m",
  hfModelId: "meta-llama/Llama-3.2-1B-Instruct",
  engine: "vllm",
  maxTokens: 4096,
  gpuMemoryUtilization: 0.9,
};
const SHA = "ee9275b14e49b9cd6249454c034910294034f22b4c59d513c40de4692b1a7dd9";
const ADAPTER = {
  name: "ft-support-tone",
  downloadUrl:
    "https://api.example.com/api/training/fine-tuned-models/3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6a11/adapter" +
    `?d=9a1d6a3e-5a55-4a43-8f0e-6f6c1c9f7b22&g=0&sig=${"ab".repeat(32)}`,
  maxRank: 16,
  sha256: SHA,
  bytes: 18_092_371,
};
const JOB_ID = "5b0b0e5e-2c1c-4a43-9d4e-3a1e0d7f1a11";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agent: {
      id: "agent-1",
      name: "Support",
      slug: "support",
      framework: "mastra",
      systemPrompt: "Be brief.",
      tools: [],
      modelConfig: { modelId: "phi-3-mini", temperature: 0.2, maxTokens: 512 },
      sourceType: "inline",
      sourceCode: "export default {}",
      env: {},
      version: "1",
    },
    ...overrides,
  };
}

// No value here is a real credential.
function training(registry: boolean): NosanaJobDefinition {
  const result = buildTrainingJobDefinition({
    image: `registry.gitlab.com/bprime/wheelsai/trainer@sha256:${"a".repeat(64)}`,
    requiredVramGb: 12,
    jobId: JOB_ID,
    baseModelHfId: "microsoft/Phi-3-mini-4k-instruct",
    method: "qlora",
    datasetUrl: "https://bucket.example.com/datasets/org/ds/data.jsonl?X-Amz-Signature=abc123",
    datasetFormat: "alpaca",
    datasetFileType: "jsonl",
    datasetSha256: "b".repeat(64),
    adapterUploadUrl: "https://bucket.example.com/adapters/org/job/adapter.tar.gz?X-Amz-Signature=def456",
    metricsUploadUrl: "https://bucket.example.com/adapters/org/job/metrics.json?X-Amz-Signature=0a1b2c",
    callbackUrl: `https://api.example.com/api/training/jobs/${JOB_ID}/events`,
    callbackSecret: "c".repeat(64),
    hyperparams: { epochs: 2, loraR: 8 },
    maxRuntimeSeconds: 3600,
    hfToken: "hf_exampleTokenForTests0123",
    ...(registry
      ? { registry: { username: "deploy", password: "registry-pass-0123", server: "registry.gitlab.com" } }
      : {}),
  });
  assert.ok(result.ok, result.ok ? "" : `${result.field}: ${result.message}`);
  return result.definition as unknown as NosanaJobDefinition;
}

/** Every definition a caller of ours can produce, by a name for the failure message. */
function everyDefinition(): Array<[string, NosanaJobDefinition]> {
  const openclaw = buildOpenClawJobDefinition({
    id: "oc-1",
    agentId: "agent-1",
    dockerImage: null,
    openclawVersion: "1.0.0",
    envEncrypted: "",
    channels: [],
    agent: { name: "Eliza", slug: "eliza", systemPrompt: null, modelConfig: { gpuTier: "3060" } },
  } as never).definition;
  const launch = compileDeployPlan({
    agentSpec: parseElizaCharacter({
      name: "Eliza",
      username: "eliza",
      clients: ["telegram"],
      plugins: [],
      modelProvider: "openai",
    }),
    envValues: { OPENAI_API_KEY: "sk-test", TELEGRAM_BOT_TOKEN: "tg-test" },
    gpuTier: "4090",
  }).jobDefinition;

  return [
    ["vllm", generateVllmJobDefinition({ ...MODEL, hfModelId: "microsoft/Phi-3-mini-4k-instruct" })],
    ["vllm with a tool-call parser, a token and quantization", generateVllmJobDefinition({ ...MODEL, hfToken: "hf_exampleTokenForTests0123", quantization: "awq" })],
    ["vllm with an adapter", generateVllmJobDefinition({ ...MODEL, hfModelId: "microsoft/Phi-3-mini-4k-instruct", adapter: ADAPTER })],
    ["ollama", generateOllamaJobDefinition({ ...MODEL, engine: "ollama" })],
    ["ollama through generateJobDefinition", generateJobDefinition({ ...MODEL, engine: "ollama" })],
    ["ollama with the proxy", generateOllamaWithProxyJobDefinition({ ...MODEL, engine: "ollama" })],
    [
      "agent on a model deployment",
      generateAgentJobDefinition(
        agent({ modelDeploymentId: "9a1d6a3e-5a55-4a43-8f0e-6f6c1c9f7b22", modelEndpointUrl: "https://api.example.com/v1/phi" }),
      ),
    ],
    ["agent on an external model", generateAgentJobDefinition(agent({ externalModelUrl: "https://llm.example.com/v1" }))],
    ["training", training(false)],
    ["training from a private registry", training(true)],
    ["openclaw", openclaw],
    ["launch plan", launch],
  ];
}

async function createOnStandIn(name: string, definition: NosanaJobDefinition): Promise<{ status: number; body: any }> {
  const response = await fetch(`${fake.url}/api/deployments/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fake.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      name,
      market: "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq",
      replicas: 1,
      timeout: 60,
      strategy: "SIMPLE-EXTEND",
      confidential: true,
      job_definition: definition,
    }),
  });
  return { status: response.status, body: await response.json() };
}

// ============================================
// Every generator
// ============================================

test("every generated definition stays within the ContainerRun keys, and a shell command always replaces the entrypoint", () => {
  for (const [name, definition] of everyDefinition()) {
    assert.deepEqual(Object.keys(definition).sort(), ["meta", "ops", "type", "version"], name);
    assert.ok(definition.ops.length >= 1, name);
    for (const op of definition.ops) {
      const at = `${name}, op ${op.id}`;
      assert.equal(op.type, "container/run", at);
      assert.deepEqual(Object.keys(op).sort(), ["args", "id", "type"], at);
      assert.match(op.id, /^[^ .]+$/, `${at}: an op id holds no space and no dot`);

      const args = op.args as Record<string, unknown>;
      for (const key of Object.keys(args)) {
        assert.ok(CONTAINER_RUN_KEYS.includes(key), `${at}: '${key}' is not a ContainerRun key`);
      }
      assert.equal(typeof args.image, "string", at);
      assert.doesNotMatch(String(args.image), /^(?:docker\.io\/)?ollama\/ollama(?::latest)?$/, `${at}: Ollama is pinned`);
      if (args.resources !== undefined) assert.ok(Array.isArray(args.resources), `${at}: resources is a list of sources`);
      for (const [key, value] of Object.entries((args.env ?? {}) as Record<string, unknown>)) {
        assert.equal(typeof value, "string", `${at}: env ${key}`);
      }
      for (const service of (args.expose ?? []) as unknown[]) {
        if (typeof service === "number") continue;
        for (const key of Object.keys(service as object)) {
          assert.ok(EXPOSED_PORT_KEYS.includes(key), `${at}: '${key}' is not an ExposedPort key`);
        }
        for (const check of (service as { health_checks?: Array<Record<string, unknown>> }).health_checks ?? []) {
          // `continuous` is required by the validator, on every check.
          assert.equal(typeof check.continuous, "boolean", at);
        }
      }

      // The node hands cmd to Docker after the image's own entrypoint. A
      // shell in cmd therefore runs as an argument of that entrypoint
      // (`/bin/ollama /bin/sh -c ...`) unless the definition replaces it.
      const cmd = (args.cmd ?? []) as string[];
      const entrypoint = args.entrypoint as string[] | undefined;
      assert.ok(Array.isArray(cmd), at);
      assert.equal(SHELLS.test(cmd[0] ?? ""), false, `${at}: a shell in cmd runs under the image's entrypoint`);
      const looksLikeShell = cmd.some((part) => /(?:&&|\|\||[;&|]\s|\$\(|\$\{?[A-Za-z_])/.test(part));
      if (looksLikeShell || cmd.includes("-c")) {
        assert.ok(entrypoint && entrypoint.length > 0, `${at}: a shell command needs an entrypoint override`);
      }
      if (entrypoint && SHELLS.test(entrypoint[0] ?? "")) {
        assert.deepEqual(entrypoint.slice(1), ["-c"], at);
        assert.equal(cmd.length, 1, `${at}: one script, the whole of cmd`);
      }
    }
  }
});

test("the stand-in's strict check accepts every definition we generate, and Nosana's SDK validator agrees", async () => {
  const { validateJobDefinition } = await import("@nosana/sdk");
  fake.deployments.clear();
  let n = 0;
  for (const [name, definition] of everyDefinition()) {
    assert.deepEqual(jobDefinitionErrors(definition), [], name);
    // Offline: the validator is a pure function of the SDK's types. It is the
    // 0.4.74 schema (it still knows required_vram), so it proves the shapes
    // of expose and health checks, not the absence of removed keys.
    const verdict = validateJobDefinition(definition as never);
    assert.equal(verdict.success, true, `${name}: ${JSON.stringify(verdict).slice(0, 300)}`);

    n += 1;
    const created = await createOnStandIn(`wheelsai-definitions-${n}`, definition);
    assert.equal(created.status, 200, `${name}: ${JSON.stringify(created.body)}`);
    // One endpoint per exposed port of each op, offline until a node serves it.
    const ports = definition.ops.flatMap((op) => op.args.expose ?? []);
    assert.equal(created.body.endpoints.length, ports.length, name);
    assert.equal(created.body.endpoints.every((e: { online: boolean }) => e.online === false), true, name);
  }
});

test("the stand-in refuses what the Deployment Manager refuses", async () => {
  fake.deployments.clear();
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    // The three shapes our definitions used to carry.
    ["CPU and memory limits", { image: "x", resources: { memory: "4Gi", cpu: "2" } }, /ops\[0\]\.args\.resources: /],
    ["required_vram", { image: "x", required_vram: 24 }, /ops\[0\]\.args\.required_vram: undefined/],
    ["work and output", { image: "x", work: "/w" }, /ops\[0\]\.args\.work: undefined/],
    ["a health check without continuous", { image: "x", expose: [{ port: 8000, health_checks: [{ type: "http", path: "/health", method: "GET", expected_status: 200 }] }] }, /health_checks\[0\]\.continuous: boolean/],
    ["an unknown key on an exposed port", { image: "x", expose: [{ port: 8000, health: "/health" }] }, /expose\[0\]\.health: undefined/],
    ["an unknown service type", { image: "x", expose: [{ port: 8000, type: "http" }] }, /expose\[0\]\.type: /],
    ["the same port twice", { image: "x", expose: [8000, { port: 8000 }] }, /Exposed ports must be unique/],
    ["a non-string env value", { image: "x", env: { PORT: 8000 } }, /args\.env\.PORT: string/],
  ];
  for (const [name, args, message] of refused) {
    const definition = { version: "0.1", type: "container", meta: { trigger: "t" }, ops: [{ type: "container/run", id: "op", args }] };
    const res = await createOnStandIn("wheelsai-refused", definition as never);
    assert.equal(res.status, 400, name);
    assert.equal(res.body.code, "FST_ERR_VALIDATION", name);
    assert.match(res.body.message, message, name);
  }
  assert.equal(fake.deployments.size, 0, "nothing was created");
});

// ============================================
// Ollama: the engine of the first paid deployment
// ============================================

test("ollama: pinned image, a shell entrypoint with one script, port 11434 with the /api/tags check, only variables Ollama reads", () => {
  assert.equal(OLLAMA_IMAGE, "docker.io/ollama/ollama:0.32.6");
  const single = generateOllamaJobDefinition({ ...MODEL, engine: "ollama" }).ops;
  const withProxy = generateOllamaWithProxyJobDefinition({ ...MODEL, engine: "ollama" }).ops;
  assert.equal(single.length, 1);
  assert.equal(single[0]!.id, "ollama-inference");
  assert.equal(withProxy[0]!.id, "ollama-server");

  for (const op of [single[0]!, withProxy[0]!]) {
    const args = op.args;
    assert.equal(args.image, OLLAMA_IMAGE);
    assert.deepEqual(args.entrypoint, ["/bin/sh", "-c"]);
    assert.equal(args.cmd!.length, 1);
    const script = args.cmd![0]!;
    // The pull goes through a server on loopback; the exposed port opens last.
    assert.match(script, /^OLLAMA_HOST=127\.0\.0\.1:11435 ollama serve & /);
    assert.match(
      script,
      /; OLLAMA_HOST=127\.0\.0\.1:11435 ollama pull llama3\.2:1b \|\| exit 1; kill "\$pid"; wait "\$pid"; exec ollama serve$/,
    );
    assert.ok(script.indexOf("ollama list") < script.indexOf("ollama pull"), "it waits for the server before it pulls");
    assert.equal(args.gpu, true);
    assert.deepEqual(args.expose, [
      {
        port: 11434,
        type: "api",
        health_checks: [{ type: "http", method: "GET", path: "/api/tags", expected_status: 200, continuous: true }],
      },
    ]);
    assert.deepEqual(args.env, { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_KEEP_ALIVE: "24h" });
  }
});

test("ollama: a model name the shell would read is refused before any definition exists", () => {
  for (const tail of ["x; rm -rf /", "x && id", "x$(id)", "x`id`", "x y", "x|y", "x'y", "-x", ""]) {
    assert.throws(
      () => generateOllamaJobDefinition({ ...MODEL, engine: "ollama", hfModelId: `some-org/${tail}` }),
      /Unsupported Ollama model name/,
      JSON.stringify(tail),
    );
  }
  // A plain unknown model still falls back to its last path segment.
  const script = generateOllamaJobDefinition({ ...MODEL, engine: "ollama", hfModelId: "some-org/custom-model-v1" }).ops[0]!.args.cmd![0]!;
  assert.match(script, /ollama pull custom-model-v1 \|\| exit 1/);
});

// The script itself, run by /bin/sh as the node would run it (`sh -c
// <script>`), with a stand-in `ollama` on PATH that records what it is asked.
const sh = spawnSync("/bin/sh", ["-c", "exit 0"]).status === 0;

function runOllamaScript(mode: "ok" | "pull_fails" | "never_up"): { status: number | null; calls: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "wheelsai-ollama-"));
  try {
    const log = path.join(dir, "calls.log");
    const bin = path.join(dir, "ollama");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        // Each call with the address it was given: where a server listens, or
        // which server a client asks.
        `echo "$OLLAMA_HOST $*" >> "${log}"`,
        'case "$1" in',
        "  serve)",
        // The server on the exposed port: it must find the other one gone,
        // and then ends at once with a code the test can tell apart.
        `    if [ "$OLLAMA_HOST" = "0.0.0.0:11434" ]; then kill -0 "$(cat "${dir}/pid")" 2>/dev/null && exit 9; exit 7; fi`,
        // The server on loopback: up after a moment, then it stays until it is
        // told to end (its output closed, so a leftover holds nothing open).
        `    exec >/dev/null 2>&1 </dev/null; echo $$ > "${dir}/pid"; /bin/sleep 0.3; : > "${dir}/up"; exec /bin/sleep 5 ;;`,
        `  list) [ "$MODE" != never_up ] && [ -f "${dir}/up" ] ;;`,
        '  pull) [ "$MODE" != pull_fails ] ;;',
        "esac",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    // `sleep 1` between attempts would make the never-up case take a minute.
    writeFileSync(path.join(dir, "sleep"), '#!/bin/sh\nexec /bin/sleep 0.05\n');
    chmodSync(path.join(dir, "sleep"), 0o755);
    const { entrypoint, cmd, env } = generateOllamaJobDefinition({ ...MODEL, engine: "ollama" }).ops[0]!.args;
    const run = spawnSync(entrypoint![0]!, [...entrypoint!.slice(1), ...cmd!], {
      env: { ...env, PATH: `${dir}:/usr/bin:/bin`, MODE: mode },
      timeout: 30_000,
    });
    return { status: run.status, calls: readFileSync(log, "utf8").trim().split("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PULL_HOST = "127.0.0.1:11435";
const EXPOSED_HOST = "0.0.0.0:11434";

test("ollama script: nothing listens on the exposed port until the model is pulled; then it lives and ends with the server", { skip: !sh }, () => {
  const run = runOllamaScript("ok");
  // The loopback server is started in the background, so its first line may
  // land after the first attempt to reach it.
  assert.equal(run.calls.filter((c) => c === `${PULL_HOST} serve`).length, 1);
  assert.ok(
    run.calls.filter((c) => c === `${PULL_HOST} list`).length >= 2,
    "it asked more than once: the server was not up at first",
  );
  assert.equal(run.calls.filter((c) => c.includes(" pull ")).length, 1);
  // Everything up to and including the pull happens on loopback. The exposed
  // port - the one Nosana's health check and /v1 reach - is opened once, last.
  assert.equal(run.calls.at(-2), `${PULL_HOST} pull llama3.2:1b`);
  assert.equal(run.calls.at(-1), `${EXPOSED_HOST} serve`);
  assert.deepEqual(
    run.calls.slice(0, -1).filter((c) => !c.startsWith(`${PULL_HOST} `)),
    [],
    "before the pull returned, nothing touched the exposed address",
  );
  // 7: the exposed server's own exit code, which it gives only when the
  // loopback server had already ended.
  assert.equal(run.status, 7, "the container's exit is the server's");
});

test("ollama script: a failed pull, or a server that never answers, ends the container instead of serving nothing", { skip: !sh }, () => {
  const failed = runOllamaScript("pull_fails");
  assert.equal(failed.status, 1);
  assert.equal(failed.calls.some((c) => c.startsWith(EXPOSED_HOST)), false, "the exposed port never opened");
  const never = runOllamaScript("never_up");
  assert.equal(never.status, 1);
  assert.equal(never.calls.filter((c) => c === `${PULL_HOST} list`).length, 60, "sixty attempts, then it gives up");
  assert.equal(never.calls.some((c) => c.includes(" pull ")), false);
  assert.equal(never.calls.some((c) => c.startsWith(EXPOSED_HOST)), false);
});

// ============================================
// vLLM
// ============================================

test("vllm, base and adapter: port 8000 is an api with the /health check, and nothing else changed", () => {
  const expected = [
    {
      port: 8000,
      type: "api",
      health_checks: [{ type: "http", method: "GET", path: "/health", expected_status: 200, continuous: true }],
    },
  ];
  assert.deepEqual(apiPortWithHealthCheck(8000, "/health"), expected[0]);
  const base = generateVllmJobDefinition({ ...MODEL, hfModelId: "microsoft/Phi-3-mini-4k-instruct" }).ops[0]!.args;
  const adapter = generateVllmJobDefinition({ ...MODEL, hfModelId: "microsoft/Phi-3-mini-4k-instruct", adapter: ADAPTER }).ops[0]!.args;
  assert.deepEqual(base.expose, expected);
  assert.deepEqual(adapter.expose, expected);
  assert.deepEqual(Object.keys(base), ["image", "cmd", "gpu", "expose"]);
  assert.equal(base.image, "vllm/vllm-openai:v0.6.0");
  assert.equal("entrypoint" in base, false, "the image's own entrypoint, with arguments only");
  assert.deepEqual(Object.keys(adapter), ["image", "entrypoint", "cmd", "gpu", "expose", "env"]);
  assert.deepEqual(adapter.entrypoint, ["python3", "-c"]);
});

test("shellCommand: the entrypoint and the script travel together", () => {
  assert.deepEqual(shellCommand("a && b"), { entrypoint: ["/bin/sh", "-c"], cmd: ["a && b"] });
});

// ============================================
// Agent runtime
// ============================================

test("agent: no resource limits, and the model is reached at a public URL, never an internal hostname", () => {
  const base = modelDeploymentOpenAiBaseUrl("phi 3", "https://api.example.com/");
  assert.equal(base, "https://api.example.com/v1/phi%203");
  assert.equal(modelDeploymentOpenAiBaseUrl("phi", undefined), null, "no host-relative URL for a container");

  const id = "9a1d6a3e-5a55-4a43-8f0e-6f6c1c9f7b22";
  const args = generateAgentJobDefinition(agent({ modelDeploymentId: id, modelEndpointUrl: `${base}/` })).ops[0]!.args;
  assert.equal("resources" in args, false);
  assert.deepEqual(Object.keys(args).sort(), ["env", "expose", "gpu", "image"]);
  assert.equal(args.env!.MODEL_ENDPOINT, base);
  assert.doesNotMatch(JSON.stringify(args), /internal-model/);

  // A model deployment with no public address is refused before any create.
  for (const modelEndpointUrl of [undefined, "", "/v1/phi", "internal-model:8000/v1", "ftp://api.example.com/v1", "https://user:pw@api.example.com/v1"]) {
    assert.throws(
      () => generateAgentJobDefinition(agent({ modelDeploymentId: id, modelEndpointUrl })),
      /no public endpoint/,
      String(modelEndpointUrl),
    );
  }
  // The other two sources of a model endpoint are as they were.
  assert.equal(
    generateAgentJobDefinition(agent({ externalModelUrl: "https://llm.example.com/v1" })).ops[0]!.args.env!.MODEL_ENDPOINT,
    "https://llm.example.com/v1",
  );
});

// ============================================
// Training
// ============================================

test("training: the GPU memory floor picks the tier and never reaches Nosana", () => {
  for (const definition of [training(false), training(true)]) {
    const sent = JSON.stringify(definition);
    assert.doesNotMatch(sent, /required_vram|vram_total_mb|requirements/);
    assert.deepEqual(Object.keys(definition.meta), ["trigger"]);
  }
  assert.deepEqual(Object.keys(training(false).ops[0]!.args).sort(), ["env", "gpu", "image"]);
  assert.deepEqual(Object.keys(training(true).ops[0]!.args).sort(), ["authentication", "env", "gpu", "image"]);
});
