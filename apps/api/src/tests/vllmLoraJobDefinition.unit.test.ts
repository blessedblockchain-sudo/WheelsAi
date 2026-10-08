import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import "./unitEnv.js";
import {
  ADAPTER_ARCHIVE_FILES,
  InvalidAdapterConfigError,
  VLLM_ADAPTER_BOOTSTRAP,
  adapterNameForSlug,
  generateJobDefinition,
  generateVllmJobDefinition,
  servedModelName,
  servedModelNameFor,
  VLLM_MAX_LORA_RANKS,
  vllmMaxLoraRank,
  type ModelDeploymentConfig,
  type VllmAdapterConfig,
} from "../services/nosana.js";
import { TRAINING_LORA_RANKS } from "../services/trainingJobDefinition.js";

// The vLLM job definition of a deployment that serves a fine-tuned adapter,
// and proof that every other deployment's definition is the pinned one.

const BASE: ModelDeploymentConfig = {
  modelId: "m",
  hfModelId: "microsoft/Phi-3-mini-4k-instruct",
  engine: "vllm",
  maxTokens: 4096,
  gpuMemoryUtilization: 0.9,
};
const SHA = "ee9275b14e49b9cd6249454c034910294034f22b4c59d513c40de4692b1a7dd9";
const ADAPTER: VllmAdapterConfig = {
  name: "ft-support-tone",
  downloadUrl:
    "https://api.example.com/api/training/fine-tuned-models/3f0e1c52-8a4b-4d0e-9b57-0f7f2f1f6a11/adapter" +
    `?d=9a1d6a3e-5a55-4a43-8f0e-6f6c1c9f7b22&g=0&sig=${"ab".repeat(32)}`,
  maxRank: 16,
  sha256: SHA,
  bytes: 18_092_371,
};

// ============================================
// Without an adapter: byte for byte what it was
// ============================================

test("without an adapter the definition is byte for byte the pinned one", () => {
  // Literal strings. Against the generator as it stood at 5dcbf15, vLLM
  // differs only in `expose` (port 8000 now carries the /health check);
  // Ollama was rewritten for the first paid run (pinned image, shell
  // entrypoint, health check, only the variables Ollama reads).
  const pinned: Array<[ModelDeploymentConfig, string]> = [
    [
      BASE,
      '{"version":"0.1","type":"container","meta":{"trigger":"wheelsai"},"ops":[{"type":"container/run","id":"vllm-inference","args":{"image":"vllm/vllm-openai:v0.6.0","cmd":["--model","microsoft/Phi-3-mini-4k-instruct","--host","0.0.0.0","--port","8000","--max-model-len","4096","--gpu-memory-utilization","0.9"],"gpu":true,"expose":[{"port":8000,"type":"api","health_checks":[{"type":"http","method":"GET","path":"/health","expected_status":200,"continuous":true}]}]}}]}',
    ],
    [
      {
        ...BASE,
        hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
        hfToken: "hf_exampleTokenForTests0123",
        quantization: "awq",
      },
      '{"version":"0.1","type":"container","meta":{"trigger":"wheelsai"},"ops":[{"type":"container/run","id":"vllm-inference","args":{"image":"vllm/vllm-openai:v0.6.3","cmd":["--model","meta-llama/Meta-Llama-3.1-8B-Instruct","--host","0.0.0.0","--port","8000","--max-model-len","4096","--gpu-memory-utilization","0.9","--quantization","awq","--enable-auto-tool-choice","--tool-call-parser","llama3_json"],"gpu":true,"expose":[{"port":8000,"type":"api","health_checks":[{"type":"http","method":"GET","path":"/health","expected_status":200,"continuous":true}]}],"env":{"HF_TOKEN":"hf_exampleTokenForTests0123"}}}]}',
    ],
    [
      { ...BASE, hfModelId: "Qwen/Qwen2.5-7B-Instruct", maxTokens: 8192, gpuMemoryUtilization: 0.85 },
      '{"version":"0.1","type":"container","meta":{"trigger":"wheelsai"},"ops":[{"type":"container/run","id":"vllm-inference","args":{"image":"vllm/vllm-openai:v0.6.0","cmd":["--model","Qwen/Qwen2.5-7B-Instruct","--host","0.0.0.0","--port","8000","--max-model-len","8192","--gpu-memory-utilization","0.85","--enable-auto-tool-choice","--tool-call-parser","hermes"],"gpu":true,"expose":[{"port":8000,"type":"api","health_checks":[{"type":"http","method":"GET","path":"/health","expected_status":200,"continuous":true}]}]}}]}',
    ],
    [
      { ...BASE, hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct", engine: "ollama" },
      '{"version":"0.1","type":"container","meta":{"trigger":"wheelsai"},"ops":[{"type":"container/run","id":"ollama-inference","args":{"image":"docker.io/ollama/ollama:0.32.6","entrypoint":["/bin/sh","-c"],"cmd":["OLLAMA_HOST=127.0.0.1:11435 ollama serve & pid=$!; i=0; until OLLAMA_HOST=127.0.0.1:11435 ollama list >/dev/null 2>&1; do i=$((i+1)); [ \\"$i\\" -ge 60 ] && exit 1; sleep 1; done; OLLAMA_HOST=127.0.0.1:11435 ollama pull llama3.1:8b || exit 1; kill \\"$pid\\"; wait \\"$pid\\" 2>/dev/null; (i=0; until OLLAMA_HOST=127.0.0.1:11434 ollama list >/dev/null 2>&1; do i=$((i+1)); [ \\"$i\\" -ge 60 ] && break; sleep 1; done; [ \\"$i\\" -lt 60 ] && OLLAMA_HOST=127.0.0.1:11434 ollama run llama3.1:8b \\"\\" >/dev/null 2>&1 </dev/null || echo \\"model preload did not complete; the model loads on the first request\\" >&2) & exec ollama serve"],"gpu":true,"expose":[{"port":11434,"type":"api","health_checks":[{"type":"http","method":"GET","path":"/api/tags","expected_status":200,"continuous":true}]}],"env":{"OLLAMA_HOST":"0.0.0.0:11434","OLLAMA_KEEP_ALIVE":"-1"}}}]}',
    ],
  ];
  for (const [config, expected] of pinned) {
    assert.equal(JSON.stringify(generateJobDefinition(config)), expected);
    // An explicit `adapter: undefined` is the same as none.
    assert.equal(JSON.stringify(generateJobDefinition({ ...config, adapter: undefined })), expected);
  }
  const args = generateVllmJobDefinition(BASE).ops[0]!.args;
  assert.ok(!("entrypoint" in args), "no entrypoint override without an adapter");
});

// ============================================
// With an adapter
// ============================================

test("with an adapter: the bootstrap replaces the entrypoint and vLLM gets LoRA, the module and the rank", () => {
  const plain = generateVllmJobDefinition(BASE).ops[0]!.args;
  const job = generateVllmJobDefinition({ ...BASE, adapter: ADAPTER });
  assert.equal(job.ops.length, 1);
  const args = job.ops[0]!.args;

  assert.deepEqual(args.entrypoint, ["python3", "-c"], "no shell anywhere in the chain");
  assert.equal(args.cmd![0], VLLM_ADAPTER_BOOTSTRAP, "the script is the constant, untouched by any value");
  assert.deepEqual(args.cmd!.slice(1), [
    ...plain.cmd!,
    "--enable-lora",
    "--lora-modules",
    "ft-support-tone=/adapters/ft-support-tone",
    "--max-lora-rank",
    "16",
  ]);
  assert.equal(args.image, plain.image);
  assert.equal(args.gpu, true);
  assert.deepEqual(args.expose, plain.expose, "the same port and health check as a base deployment");
  assert.deepEqual(args.env, {
    WHEELSAI_ADAPTER_URL: ADAPTER.downloadUrl,
    WHEELSAI_ADAPTER_DIR: "/adapters/ft-support-tone",
    WHEELSAI_ADAPTER_SHA256: SHA,
    WHEELSAI_ADAPTER_MAX_BYTES: "18092371",
  });
  // The signed URL travels in the environment only.
  assert.ok(!args.cmd!.some((part) => part.includes("sig=")));
});

test("--max-lora-rank is a value vLLM accepts: a rank-4 adapter is served under 8, never 4", () => {
  // Found by review: the trainer and the page offer rank 4, and vLLM 0.6.x
  // refuses --max-lora-rank 4 at startup, so such a model could never serve.
  const flag = (maxRank: number) => {
    const cmd = generateVllmJobDefinition({ ...BASE, adapter: { ...ADAPTER, maxRank } }).ops[0]!.args.cmd!;
    return cmd[cmd.indexOf("--max-lora-rank") + 1];
  };
  assert.equal(flag(4), "8");
  for (const rank of TRAINING_LORA_RANKS) {
    assert.ok((VLLM_MAX_LORA_RANKS as readonly number[]).includes(Number(flag(rank))), `rank ${rank}`);
    assert.ok(Number(flag(rank)) >= rank, `rank ${rank} fits under its ceiling`);
  }
  assert.deepEqual([1, 8, 9, 16, 33, 64, 65, 128, 129, 256].map(vllmMaxLoraRank), [8, 8, 16, 16, 64, 64, 128, 128, 256, 256]);
  assert.equal(vllmMaxLoraRank(257), null);
  assert.equal(vllmMaxLoraRank(0), null);
});

test("with an adapter: the image choice, tool-calling flags, quantization and HF token are unchanged", () => {
  const config: ModelDeploymentConfig = {
    ...BASE,
    hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    hfToken: "hf_exampleTokenForTests0123",
    quantization: "awq",
  };
  const plain = generateVllmJobDefinition(config).ops[0]!.args;
  const args = generateVllmJobDefinition({ ...config, adapter: { ...ADAPTER, maxRank: 64 } }).ops[0]!.args;
  assert.equal(args.image, "vllm/vllm-openai:v0.6.3");
  assert.deepEqual(args.cmd!.slice(1, 1 + plain.cmd!.length), plain.cmd);
  assert.equal(args.cmd!.at(-1), "64");
  assert.equal(args.env!.HF_TOKEN, "hf_exampleTokenForTests0123");
});

test("with an adapter: Nosana's own validator accepts the definition", async () => {
  // Offline: the validator is a pure function of the SDK's types.
  const { validateJobDefinition } = await import("@nosana/sdk");
  const verdict = validateJobDefinition(generateVllmJobDefinition({ ...BASE, adapter: ADAPTER }) as never);
  assert.equal(verdict.success, true, JSON.stringify(verdict).slice(0, 300));
});

test("an adapter on Ollama is refused, never served as the bare base model", () => {
  assert.throws(
    () => generateJobDefinition({ ...BASE, engine: "ollama", adapter: ADAPTER }),
    (err) => err instanceof InvalidAdapterConfigError && err.field === "engine",
  );
});

// ============================================
// D13: hostile values
// ============================================

test("a hostile name, URL, model id, rank, checksum or size is refused and never reaches a definition", () => {
  const refused = (field: string, config: ModelDeploymentConfig) =>
    assert.throws(
      () => generateVllmJobDefinition(config),
      (err) => {
        assert.ok(err instanceof InvalidAdapterConfigError, String(err));
        assert.equal(err.field, field);
        return true;
      },
      JSON.stringify(config.adapter),
    );
  const withAdapter = (over: Partial<VllmAdapterConfig>): ModelDeploymentConfig => ({
    ...BASE,
    adapter: { ...ADAPTER, ...over },
  });

  for (const name of [
    "support-tone", // not an adapter name
    "ft-",
    "ft-a b",
    "ft-a=/etc/passwd",
    "ft-a;reboot",
    "ft-$(id)",
    "ft-a\nb",
    "ft-A",
    "ft-a/../b",
    "ft--a",
    `ft-${"a".repeat(81)}`,
    "--model",
  ]) {
    refused("adapter.name", withAdapter({ name }));
  }

  for (const downloadUrl of [
    "ftp://api.example.com/a",
    "file:///etc/passwd",
    "https://api.example.com", // no path
    "https://user:pw@api.example.com/a",
    "https://api.example.com/a b",
    "https://api.example.com/a?x=$(id)",
    "https://api.example.com/a?x=`id`",
    "https://api.example.com/a';reboot;'",
    'https://api.example.com/a"',
    "https://api.example.com/a\nWHEELSAI_ADAPTER_DIR=/",
    "https://api.example.com/a#frag",
    "https://[::1]/a",
    " https://api.example.com/a",
    `https://api.example.com/${"a".repeat(2100)}`,
  ]) {
    refused("adapter.downloadUrl", withAdapter({ downloadUrl }));
  }

  for (const maxRank of [0, -1, 1.5, 257, Number.NaN, "16" as never]) {
    refused("adapter.maxRank", withAdapter({ maxRank }));
  }
  for (const sha256 of ["", SHA.toUpperCase(), SHA.slice(1), `${SHA} `]) {
    refused("adapter.sha256", withAdapter({ sha256 }));
  }
  for (const bytes of [0, -5, 1.5, Number.NaN, 2 ** 60]) {
    refused("adapter.bytes", withAdapter({ bytes }));
  }
  for (const hfModelId of ["phi", "a/b c", "a/b;id", "--model/x", "a/b\n--trust-remote-code", "a/b/c"]) {
    refused("hfModelId", { ...BASE, hfModelId, adapter: ADAPTER });
  }
  refused("quantization", { ...BASE, quantization: "awq --trust-remote-code", adapter: ADAPTER });
});

test("the bootstrap is one constant: no accepted value changes a byte of it", () => {
  const a = generateVllmJobDefinition({ ...BASE, adapter: ADAPTER }).ops[0]!.args.cmd![0];
  const b = generateVllmJobDefinition({
    ...BASE,
    hfModelId: "Qwen/Qwen2-7B-Instruct",
    adapter: {
      name: "ft-x",
      downloadUrl: "http://localhost:4310/api/training/fine-tuned-models/a/adapter?d=b&g=7&sig=c",
      maxRank: 64,
      sha256: "0".repeat(64),
      bytes: 1,
    },
  }).ops[0]!.args.cmd![0];
  assert.equal(a, b);
  assert.equal(a, VLLM_ADAPTER_BOOTSTRAP);
  for (const value of [ADAPTER.downloadUrl, ADAPTER.name, SHA, "/adapters"]) {
    assert.ok(!VLLM_ADAPTER_BOOTSTRAP.includes(value), value);
  }
  for (const file of ADAPTER_ARCHIVE_FILES) assert.ok(VLLM_ADAPTER_BOOTSTRAP.includes(`"${file}"`));
});

// ============================================
// Names
// ============================================

test("adapterNameForSlug accepts a plain slug only", () => {
  assert.equal(adapterNameForSlug("support-tone"), "ft-support-tone");
  assert.equal(adapterNameForSlug("a"), "ft-a");
  for (const slug of ["", "-a", "a-", "A", "a b", "a_b", "a/b", "a".repeat(81), null, undefined, 5]) {
    assert.equal(adapterNameForSlug(slug), null, String(slug));
  }
});

test("servedModelNameFor: the adapter's name for an adapter deployment, the base model's as before otherwise", () => {
  const hfId = "meta-llama/Meta-Llama-3.1-8B-Instruct";
  assert.equal(servedModelNameFor({ engine: "vllm", hfId, fineTunedSlug: "support-tone" }), "ft-support-tone");
  for (const fineTunedSlug of [undefined, null, ""]) {
    assert.equal(servedModelNameFor({ engine: "vllm", hfId, fineTunedSlug }), servedModelName("vllm", hfId));
    assert.equal(servedModelNameFor({ engine: "ollama", hfId, fineTunedSlug }), "llama3.1:8b");
    assert.equal(servedModelNameFor({ engine: null, hfId, fineTunedSlug }), hfId);
  }
  // Ollama serves no adapters: it is asked for what it has.
  assert.equal(servedModelNameFor({ engine: "ollama", hfId, fineTunedSlug: "support-tone" }), "llama3.1:8b");
});

// ============================================
// The bootstrap, run for real
// ============================================
//
// The script is Python, so it is run with the machine's python3 against a
// loopback HTTP server. The OpenAI server it ends by exec'ing is a stand-in
// module on PYTHONPATH that prints the arguments it was started with.

const python = spawnSync("python3", ["--version"]).status === 0;

interface TarEntry {
  name: string;
  body?: Buffer;
  /** "0" regular file (default), "2" symbolic link, "5" directory. */
  type?: string;
  linkname?: string;
}

function tarGz(entries: TarEntry[]): Buffer {
  // Built by python's own tarfile so the archive is exactly what the trainer writes.
  const script = `
import io, json, sys, tarfile, base64
spec = json.load(sys.stdin)
out = io.BytesIO()
with tarfile.open(fileobj=out, mode="w:gz") as archive:
    for entry in spec:
        info = tarfile.TarInfo(entry["name"])
        body = base64.b64decode(entry.get("body", ""))
        info.type = entry.get("type", "0").encode()
        info.linkname = entry.get("linkname", "")
        info.size = len(body) if info.type == b"0" else 0
        archive.addfile(info, io.BytesIO(body) if info.type == b"0" else None)
sys.stdout.buffer.write(out.getvalue())
`;
  const run = spawnSync("python3", ["-c", script], {
    input: JSON.stringify(
      entries.map((entry) => ({ ...entry, body: (entry.body ?? Buffer.alloc(0)).toString("base64") })),
    ),
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr.toString());
  return run.stdout;
}

const GOOD: TarEntry[] = [
  { name: "adapter_config.json", body: Buffer.from('{"r":16}') },
  { name: "adapter_model.safetensors", body: Buffer.from("weights-weights-weights") },
  { name: "wheelsai_manifest.json", body: Buffer.from('{"format":1}') },
];

async function runBootstrap(opts: {
  archive: Buffer;
  sha256?: string;
  maxBytes?: number;
  /** Replaces the default handler, which serves the archive at /adapter. */
  handler?: http.RequestListener;
}) {
  const work = mkdtempSync(path.join(tmpdir(), "wheelsai-adapter-test-"));
  const dest = path.join(work, "adapters", "ft-support-tone");
  const fake = path.join(work, "pkgs", "vllm", "entrypoints", "openai");
  mkdirSync(fake, { recursive: true });
  for (const dir of ["vllm", "vllm/entrypoints", "vllm/entrypoints/openai"]) {
    writeFileSync(path.join(work, "pkgs", dir, "__init__.py"), "");
  }
  writeFileSync(
    path.join(fake, "api_server.py"),
    'import json, sys\nprint("STARTED " + json.dumps(sys.argv[1:]))\n',
  );

  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (opts.handler) return opts.handler(req, res);
    res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": opts.archive.length });
    res.end(opts.archive);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/adapter?d=x&g=0&sig=secretsignature`;
  const serverArgs = ["--model", "a/b", "--lora-modules", "ft-support-tone=/adapters/ft-support-tone", "it's; $(id)"];

  // Asynchronous: the server that answers the script lives on this event loop.
  const child = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
    execFile(
      "python3",
      ["-c", VLLM_ADAPTER_BOOTSTRAP, ...serverArgs],
      {
        env: {
          PATH: process.env.PATH,
          PYTHONPATH: path.join(work, "pkgs"),
          WHEELSAI_ADAPTER_URL: url,
          WHEELSAI_ADAPTER_DIR: dest,
          WHEELSAI_ADAPTER_SHA256: opts.sha256 ?? createHash("sha256").update(opts.archive).digest("hex"),
          WHEELSAI_ADAPTER_MAX_BYTES: String(opts.maxBytes ?? opts.archive.length),
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) =>
        resolve({
          status: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout,
          stderr,
        }),
    ),
  );
  await new Promise((resolve) => server.close(resolve));

  const files = (() => {
    try {
      return readdirSync(dest).sort();
    } catch {
      return null;
    }
  })();
  const outside = readdirSync(work).sort();
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    files,
    read: (name: string) => readFileSync(path.join(dest, name)),
    outside,
    requests,
    serverArgs,
    url,
    port,
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}

test("bootstrap: a good archive is unpacked and the server is started with its arguments untouched", { skip: !python }, async () => {
  const run = await runBootstrap({ archive: tarGz(GOOD) });
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.files, [...ADAPTER_ARCHIVE_FILES].sort());
    assert.equal(run.read("adapter_model.safetensors").toString(), "weights-weights-weights");
    // Every argument arrives as one argument, whatever characters it holds.
    assert.ok(run.stdout.startsWith("STARTED "), run.stdout);
    assert.deepEqual(JSON.parse(run.stdout.slice("STARTED ".length)), run.serverArgs);
    assert.deepEqual(run.requests, ["/adapter?d=x&g=0&sig=secretsignature"]);
  } finally {
    run.cleanup();
  }
});

test("bootstrap: it follows the redirect to the object store", { skip: !python }, async () => {
  const archive = tarGz(GOOD);
  const run = await runBootstrap({
    archive,
    handler: (req, res) => {
      if (req.url?.startsWith("/adapter")) {
        res.writeHead(302, { Location: "/object?X-Amz-Signature=abc" });
        return res.end();
      }
      res.writeHead(200, { "Content-Length": archive.length });
      res.end(archive);
    },
  });
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.requests, ["/adapter?d=x&g=0&sig=secretsignature", "/object?X-Amz-Signature=abc"]);
    assert.deepEqual(run.files, [...ADAPTER_ARCHIVE_FILES].sort());
  } finally {
    run.cleanup();
  }
});

test("bootstrap: anything but the three root-level regular files is refused and the server is not started", { skip: !python }, async () => {
  const hostile: Array<[string, TarEntry[]]> = [
    ["an extra file", [...GOOD, { name: "extra.py", body: Buffer.from("x") }]],
    ["a file missing", GOOD.slice(0, 2)],
    ["a path out of the directory", [...GOOD.slice(0, 2), { name: "../wheelsai_manifest.json", body: Buffer.from("x") }]],
    ["an absolute path", [...GOOD.slice(0, 2), { name: "/tmp/wheelsai_manifest.json", body: Buffer.from("x") }]],
    ["a nested path", [...GOOD.slice(0, 2), { name: "sub/wheelsai_manifest.json", body: Buffer.from("x") }]],
    ["a ./ prefix", [...GOOD.slice(0, 2), { name: "./wheelsai_manifest.json", body: Buffer.from("x") }]],
    ["a symbolic link under an expected name", [...GOOD.slice(0, 2), { name: "wheelsai_manifest.json", type: "2", linkname: "/etc/passwd" }]],
    ["a directory under an expected name", [...GOOD.slice(0, 2), { name: "wheelsai_manifest.json", type: "5" }]],
    ["the same file twice", [...GOOD, GOOD[0]!]],
  ];
  for (const [what, entries] of hostile) {
    const run = await runBootstrap({ archive: tarGz(entries) });
    try {
      assert.equal(run.status, 78, `${what}: ${run.stderr}`);
      assert.ok(!run.stdout.includes("STARTED"), what);
      assert.match(run.stderr, /^wheelsai-adapter: the archive /, what);
      // Nothing was written beside the adapter directory's own tree.
      assert.deepEqual(run.outside, ["adapters", "pkgs"], what);
      for (const file of run.files ?? []) {
        assert.ok((ADAPTER_ARCHIVE_FILES as readonly string[]).includes(file), `${what}: ${file}`);
      }
    } finally {
      run.cleanup();
    }
  }
});

test("bootstrap: a wrong checksum, an oversize body, a body that is no archive and a 404 all stop it, without printing the URL", { skip: !python }, async () => {
  const archive = tarGz(GOOD);
  const cases: Array<[string, Parameters<typeof runBootstrap>[0], RegExp]> = [
    ["checksum", { archive, sha256: "0".repeat(64) }, /does not match its checksum/],
    ["oversize", { archive, maxBytes: archive.length - 1 }, /larger than expected/],
    ["not an archive", { archive: Buffer.from("this is not a gzip tar at all") }, /could not be read/],
    [
      "404",
      {
        archive,
        handler: (_req, res) => {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":"not_found"}');
        },
      },
      /download was refused \(HTTP 404\)/,
    ],
  ];
  for (const [what, opts, message] of cases) {
    const run = await runBootstrap(opts);
    try {
      assert.equal(run.status, 78, `${what}: ${run.stderr}`);
      assert.match(run.stderr, message, what);
      assert.ok(!run.stdout.includes("STARTED"), what);
      assert.deepEqual(run.files ?? [], [], `${what}: nothing unpacked`);
      assert.ok(!run.stderr.includes("secretsignature") && !run.stderr.includes(String(run.port)), what);
      if (what === "404") assert.equal(run.requests.length, 1, "a refusal is not retried");
    } finally {
      run.cleanup();
    }
  }
});

test("adapterNameForSlug accepts the longest slug the job service writes", () => {
  // fineTunedModelSlug: 32 characters of name, a hyphen, the job id without hyphens.
  const longest = `${"a".repeat(32)}-${"0123456789abcdef".repeat(2)}`;
  assert.equal(longest.length, 65);
  assert.equal(adapterNameForSlug(longest), `ft-${longest}`);
  assert.equal(adapterNameForSlug("a".repeat(80)), `ft-${"a".repeat(80)}`);
});
