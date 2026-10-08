import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives services/nosana.ts (NosanaClient) with a fake @nosana/sdk: the wiring
// of the lifecycle (create -> fund -> start), the market/network resolution,
// the strict status read, the stop/reclaim path, the engine-aware node probe and
// the dev-only mock gate. No network, no wallet funds.

interface SdkCalls {
  ops: string[];
  createBodies: any[];
  topups: any[];
  marketReads: string[];
}

function fakeSdk(opts: {
  jobPrice?: string;
  status?: string;
  endpoints?: Array<{ opId: string; port: number; url: string; online?: boolean }>;
  events?: any[];
  startError?: Error;
  createError?: Error;
  priceError?: Error;
  nosBalance?: { value: number };
  stopError?: Error;
  jobListResult?: { job: string };
} = {}) {
  const calls: SdkCalls = { ops: [], createBodies: [], topups: [], marketReads: [] };
  const vault = { nos: 0 };
  const deployment: any = {
    id: "dm_test",
    status: opts.status ?? "DRAFT",
    replicas: 1,
    endpoints: opts.endpoints ?? [],
    jobs: [],
    events: opts.events ?? [],
    vault: {
      publicKey: { toBase58: () => "VaultKey111111111111111111111111111111111111" },
      topup: async (o: any) => {
        calls.ops.push("topup");
        calls.topups.push(o);
        vault.nos += o.NOS ?? 0;
      },
      getBalance: async () => ({ SOL: 0, NOS: vault.nos / 1e6 }),
      withdraw: async () => {
        calls.ops.push("withdraw");
        vault.nos = 0;
      },
    },
    start: async () => {
      calls.ops.push("start");
      if (opts.startError) throw opts.startError;
      deployment.status = "STARTING";
    },
    stop: async () => {
      calls.ops.push("stop");
      if (opts.stopError) throw opts.stopError;
      deployment.status = "STOPPING";
    },
    updateReplicaCount: async (n: number) => {
      calls.ops.push(`scale:${n}`);
      deployment.replicas = n;
    },
  };
  const sdk = {
    // The wallet's signed API header, as the SDK's AuthorizationManager makes it.
    authorization: {
      generate: async (message: string, options: { includeTime: boolean }) =>
        `signed:${message}:${options.includeTime}`,
    },
    deployments: {
      create: async (body: any) => {
        calls.ops.push("create");
        calls.createBodies.push(body);
        if (opts.createError) throw opts.createError;
        return deployment;
      },
      get: async (id: string) => {
        calls.ops.push(`get:${id}`);
        return deployment;
      },
    },
    jobs: {
      getMarket: async (address: string) => {
        calls.ops.push("getMarket");
        calls.marketReads.push(address);
        if (opts.priceError) throw opts.priceError;
        return { jobPrice: { toString: () => opts.jobPrice ?? "202" } };
      },
      list: async (definition: unknown, timeout: number, market: string) => {
        calls.ops.push("jobs.list");
        calls.createBodies.push({ definition, timeout, market });
        return { tx: "t", job: opts.jobListResult?.job ?? "JobAddr", run: "r" };
      },
    },
  };
  return { sdk, calls, deployment };
}

/**
 * The direct REST reads (jobs, events, the deployment list) go through the
 * client's fetch seam; this stub answers them on no network at all and
 * records what was asked.
 */
function fakeRest(lists: { jobs?: any[]; events?: any[]; deployments?: any[] } = {}) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = async (url: string, init: { headers?: Record<string, string> }) => {
    requests.push({ url, headers: init.headers ?? {} });
    const path = new URL(url).pathname;
    const key = path.endsWith("/jobs") ? "jobs" : path.endsWith("/events") ? "events" : "deployments";
    const items = lists[key] ?? [];
    return {
      status: 200,
      ok: true,
      json: async () => ({ [key]: items, pagination: { cursor_next: null, cursor_prev: null, total_items: items.length } }),
    };
  };
  return { fetcher, requests };
}

async function makeClient(opts: {
  network?: "devnet" | "mainnet";
  wallet?: boolean;
  sdk?: ReturnType<typeof fakeSdk>;
  rest?: ReturnType<typeof fakeRest>;
}) {
  setupEnv();
  const { NosanaClient } = await import("../services/nosana.js");
  const client = new NosanaClient();
  (client as any).sdk = (opts.sdk ?? fakeSdk()).sdk;
  (client as any).wallet = opts.wallet === false ? null : Keypair.generate();
  (client as any).network = opts.network ?? "mainnet";
  (client as any).fetcher = (opts.rest ?? fakeRest()).fetcher;
  (client as any).isInitialized = true;
  return client;
}

const DEFINITION = { version: "0.1", type: "container", meta: { trigger: "wheelsai" }, ops: [] };

// ============================================
// createDeployment: create -> fund -> start
// ============================================

test("createDeployment on mainnet: real market, confidential, short timeout, funded vault, started", async () => {
  const sdk = fakeSdk({ jobPrice: "202" });
  const client = await makeClient({ sdk });

  const result = await client.createDeployment(DEFINITION as any, "4090", 2);

  assert.deepEqual(sdk.calls.ops, ["getMarket", "create", "topup", "start"]);
  assert.deepEqual(sdk.calls.marketReads, ["97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf"]);
  const body = sdk.calls.createBodies[0];
  assert.equal(body.market, "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf");
  assert.equal(body.confidential, true);
  assert.equal(body.strategy, "SIMPLE-EXTEND");
  // The job timeout is 7,200 s; the Deployment Manager is given minutes
  // (config/nosanaAccess.ts, NOSANA_TIMEOUT_UNIT).
  assert.equal(body.timeout, 120);
  assert.ok(body.timeout * 60 < 30 * 24 * 3600, "the 30-day default is gone");
  assert.equal(body.replicas, 2);
  assert.match(body.name, /^wheelsai-/);

  // 202 x 1.10 x 2 replicas x 14,400 s = 6,399,360 base units; 2 x 0.01 SOL
  assert.deepEqual(sdk.calls.topups[0], { NOS: 6_399_360, SOL: 20_000_000, lamports: true });

  assert.equal(result.id, "dm_test");
  assert.equal(result.market, "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf");
  assert.equal(result.replicas, 2);
  assert.equal(result.vaultAddress, "VaultKey111111111111111111111111111111111111");
  assert.deepEqual(result.endpoints, [], "no URL exists yet - none is fabricated");
  assert.ok(!("nodes" in result), "the fabricated node mapping is gone");
  assert.equal(result.mock, undefined);
});

test("wallet createDeployment sends the name as the idempotency key; a create that throws is found by it (signed list) and taken on", async () => {
  // Sent on every create.
  const plain = fakeSdk({ jobPrice: "202" });
  const plainClient = await makeClient({ sdk: plain });
  await plainClient.createDeployment(DEFINITION as any, "4090", 1, { name: "wheelsai-model-w1-r0" });
  assert.equal(plain.calls.createBodies[0].idempotency_key, "wheelsai-model-w1-r0");
  assert.equal(plain.calls.createBodies[0].autostart, undefined, "create and start stay two calls");

  // The create throws after the server acted: the key finds the DRAFT, which
  // is funded and started as if the answer had arrived.
  const sdk = fakeSdk({ jobPrice: "202", createError: new Error("Error creating deployment: socket hang up") });
  const rest = fakeRest({
    deployments: [{ id: "dm_test", name: "wheelsai-model-w2-r0", status: "DRAFT", idempotency_key: "wheelsai-model-w2-r0" }],
  });
  const client = await makeClient({ sdk, rest });
  const created = await client.createDeployment(DEFINITION as any, "4090", 1, { name: "wheelsai-model-w2-r0" });
  assert.equal(created.id, "dm_test");
  assert.equal(created.accessMode, "wallet");
  assert.deepEqual(sdk.calls.ops, ["getMarket", "create", "get:dm_test", "topup", "start"]);
  const lookup = new URL(rest.requests[0]!.url);
  assert.equal(lookup.pathname, "/api/deployments");
  assert.equal(lookup.searchParams.get("idempotency_key"), "wheelsai-model-w2-r0");
  assert.equal(rest.requests[0]!.headers.Authorization, "signed:NosanaApiAuthentication:true");
});

test("createDeployment kind 'batch' uses the SIMPLE strategy and the batch timeout (training is not auto-extended)", async () => {
  const sdk = fakeSdk({ jobPrice: "100" });
  const client = await makeClient({ sdk });
  await client.createDeployment(DEFINITION as any, "4090", 1, { kind: "batch" });
  const body = sdk.calls.createBodies[0];
  assert.equal(body.strategy, "SIMPLE");
  assert.equal(body.timeout, 360, "21,600 s, sent in minutes");
  assert.equal(sdk.calls.topups[0].NOS, Math.ceil((100 * 11000 * 21_600) / 10000), "funded for the batch timeout only");
});

test("createDeployment on devnet with no configured market fails honestly BEFORE touching the SDK", async () => {
  const sdk = fakeSdk();
  const client = await makeClient({ sdk, network: "devnet" });
  const { MarketNotConfiguredError } = await import("../services/nosana.js");

  await assert.rejects(
    () => client.createDeployment(DEFINITION as any, "4090", 1),
    (err: unknown) => {
      assert.ok(err instanceof MarketNotConfiguredError);
      assert.match(err.message, /market for tier 4090 is not configured/);
      return true;
    },
  );
  assert.deepEqual(sdk.calls.ops, [], "no draft deployment, no price read, no funds");
});

test("createDeployment rejects an unknown tier as unknown", async () => {
  const client = await makeClient({});
  const { MarketNotConfiguredError } = await import("../services/nosana.js");
  await assert.rejects(
    () => client.createDeployment(DEFINITION as any, "h200", 1),
    (err: unknown) => err instanceof MarketNotConfiguredError && err.code === "unknown_tier",
  );
});

test("createDeployment without a wallet is NosanaNotConfiguredError (501 material), never a mock", async () => {
  const sdk = fakeSdk();
  const client = await makeClient({ sdk, wallet: false });
  const { NosanaNotConfiguredError } = await import("../services/nosana.js");
  await assert.rejects(
    () => client.createDeployment(DEFINITION as any, "4090", 1),
    (err: unknown) => err instanceof NosanaNotConfiguredError && err.code === "nosana_not_configured",
  );
  assert.deepEqual(sdk.calls.ops, []);
});

test("a failed start is rethrown with the Nosana deployment id - the mock is NOT used (ALLOW_NOSANA_MOCK unset)", async () => {
  const sdk = fakeSdk({ startError: new Error("manager 500") });
  const client = await makeClient({ sdk });
  const { NosanaLifecycleError } = await import("../services/nosanaDeploymentLifecycle.js");

  await assert.rejects(
    () => client.createDeployment(DEFINITION as any, "4090", 1),
    (err: unknown) => {
      assert.ok(err instanceof NosanaLifecycleError);
      assert.equal(err.stage, "start");
      assert.equal(err.deploymentId, "dm_test");
      assert.equal(err.cleanup?.reclaimed, true);
      return true;
    },
  );
  assert.ok(sdk.calls.ops.includes("stop"));
  assert.ok(sdk.calls.ops.includes("withdraw"));
});

test("an unreadable market price stops the deploy before anything is created", async () => {
  const sdk = fakeSdk({ priceError: new Error("account does not exist") });
  const client = await makeClient({ sdk });
  await assert.rejects(() => client.createDeployment(DEFINITION as any, "4090", 1), /price of Nosana market/);
  assert.ok(!sdk.calls.ops.includes("create"));
});

// ============================================
// assertCanDeploy (route pre-flight)
// ============================================

test("assertCanDeploy: ok with wallet + configured market; 501-material errors otherwise", async () => {
  const { NosanaNotConfiguredError, MarketNotConfiguredError } = await import("../services/nosana.js");

  (await makeClient({ network: "mainnet" })).assertCanDeploy("h100"); // h100 has a real market

  await assert.rejects(async () => (await makeClient({ wallet: false })).assertCanDeploy("4090"), NosanaNotConfiguredError);
  await assert.rejects(async () => (await makeClient({ network: "devnet" })).assertCanDeploy("4090"), MarketNotConfiguredError);
  await assert.rejects(async () => (await makeClient({})).assertCanDeploy("nope"), MarketNotConfiguredError);
});

// ============================================
// getDeploymentStatus: strict, real endpoints
// ============================================

test("getDeploymentStatus returns the status and the endpoints Nosana reported - nothing invented", async () => {
  const sdk = fakeSdk({
    status: "RUNNING",
    endpoints: [
      { opId: "vllm-inference", port: 8000, url: "https://abc.node.k8s.prd.nos.ci/", online: true },
      // Created with the deployment and not yet served: kept, and marked so.
      { opId: "sidecar", port: 9000, url: "https://def.node.k8s.prd.nos.ci", online: false },
    ],
  });
  const rest = fakeRest({
    jobs: [{ job: "JobNew", state: "RUNNING", node: "NodeA", created_at: "2026-09-30T10:05:00.000Z" }],
    events: [{ type: "JOB_LIST_CONFIRMED", message: "listed", created_at: "2026-09-30T10:00:00.000Z" }],
  });
  const client = await makeClient({ sdk, rest });
  const snap = await client.getDeploymentStatus("dm_test");
  assert.equal(snap.status, "running");
  assert.deepEqual(snap.endpoints, [
    { url: "https://abc.node.k8s.prd.nos.ci", port: 8000, opId: "vllm-inference", online: true },
    { url: "https://def.node.k8s.prd.nos.ci", port: 9000, opId: "sidecar", online: false },
  ]);
  // Jobs and events come from their own routes, signed by the wallet.
  assert.deepEqual(snap.jobs, [{ job: "JobNew", status: "RUNNING", node: "NodeA", createdAt: "2026-09-30T10:05:00.000Z" }]);
  assert.equal(snap.events[0]!.type, "JOB_LIST_CONFIRMED");
  assert.deepEqual(
    rest.requests.map((r) => new URL(r.url).pathname).sort(),
    ["/api/deployments/dm_test/events", "/api/deployments/dm_test/jobs"],
  );
  for (const request of rest.requests) {
    assert.equal(new URL(request.url).origin, "https://dashboard.k8s.prd.nos.ci", "the wallet client's own backend");
    assert.equal(request.headers.Authorization, "signed:NosanaApiAuthentication:true");
    assert.equal(request.headers["x-user-id"], (client as any).wallet.publicKey.toBase58());
  }
});

test("listDeployments with the wallet reads the paginated list directly, never the SDK's list()", async () => {
  const rest = fakeRest({
    deployments: [{ id: "dm_a", name: "wheelsai-a", status: "RUNNING", created_at: "2026-09-30T10:00:00.000Z" }],
  });
  const client = await makeClient({ rest });
  const rows = await client.listDeployments("wallet");
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.accessMode]), [["dm_a", "running", "wallet"]]);
  assert.equal(new URL(rest.requests[0]!.url).searchParams.get("limit"), "100");
});

test("getDeploymentStatus: no endpoints -> empty list; mock ids and API failures THROW", async () => {
  const client = await makeClient({ sdk: fakeSdk({ status: "STARTING" }) });
  assert.deepEqual((await client.getDeploymentStatus("dm_test")).endpoints, []);

  await assert.rejects(() => client.getDeploymentStatus("mock_deploy_abc"), /Mock Nosana id cannot be queried/);

  const broken = await makeClient({});
  (broken as any).sdk = {
    deployments: {
      get: async () => {
        throw new Error("502 bad gateway");
      },
    },
  };
  await assert.rejects(() => broken.getDeploymentStatus("dm_test"), /502 bad gateway/);
});

// ============================================
// stop / reclaim / scale
// ============================================

test("stopDeployment stops and reclaims the vault; mock ids are a labelled no-op", async () => {
  const sdk = fakeSdk({ status: "RUNNING" });
  const client = await makeClient({ sdk });
  const result = await client.stopDeployment("dm_test");
  assert.equal(result.stopped, true);
  assert.equal(result.reclaimed, true);
  assert.deepEqual(
    sdk.calls.ops.filter((o) => o === "stop" || o === "withdraw"),
    ["stop", "withdraw"],
  );

  const mockResult = await client.stopDeployment("mock_deploy_x");
  assert.equal(mockResult.reclaimed, true);
});

test("stopDeployment surfaces a stop that did not take effect", async () => {
  const client = await makeClient({ sdk: fakeSdk({ status: "RUNNING", stopError: new Error("api 500") }) });
  await assert.rejects(() => client.stopDeployment("dm_test"), /Stopping Nosana deployment dm_test failed/);
});

test("scaleDeployment resolves the tier's market, funds the added replicas, then scales", async () => {
  const sdk = fakeSdk({ status: "RUNNING", jobPrice: "100" });
  const client = await makeClient({ sdk });
  const result = await client.scaleDeployment("dm_test", 3, "4090");
  assert.equal(result.replicas, 3);
  assert.deepEqual(sdk.calls.marketReads, ["97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf"]);
  assert.deepEqual(
    sdk.calls.ops.filter((o) => o === "topup" || o.startsWith("scale")),
    ["topup", "scale:3"],
  );
});

// ============================================
// chain markets + one-shot jobs
// ============================================

test("getMarketJobPrice reads market.jobPrice as NOS base units (bigint)", async () => {
  const client = await makeClient({ sdk: fakeSdk({ jobPrice: "757" }) });
  assert.equal(await client.getMarketJobPrice("Crop49jpc7prcgAcS82WbWyGHwbN5GgDym3uFbxxCTZg"), 757n);
});

test("submitJob (legacy one-shot path): real market address, 24h timeout - not 30 days", async () => {
  const sdk = fakeSdk({ jobListResult: { job: "JobAddr1" } });
  const client = await makeClient({ sdk });
  const job = await client.submitJob(DEFINITION as any, "4090");
  assert.equal(job.id, "JobAddr1");
  assert.equal(job.market, "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf");
  const call = sdk.calls.createBodies[0];
  assert.equal(call.timeout, 86_400);
  assert.equal(call.market, "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf");
});

test("submitJob on devnet with no market is an honest error, not a placeholder address", async () => {
  const sdk = fakeSdk();
  const client = await makeClient({ sdk, network: "devnet" });
  await assert.rejects(() => client.submitJob(DEFINITION as any, "4090"), /market for tier 4090 is not configured/);
  assert.deepEqual(sdk.calls.ops, []);
});

// ============================================
// engine-aware readiness probe
// ============================================

test("nodeHealthPath: vLLM serves /health; Ollama is asked which models are loaded (/api/ps)", async () => {
  setupEnv();
  const { nodeHealthPath } = await import("../services/nosana.js");
  assert.equal(nodeHealthPath("vllm"), "/health");
  assert.equal(nodeHealthPath("ollama"), "/api/ps");
  assert.equal(nodeHealthPath(undefined), "/health");
});

/** GET /api/ps as Ollama answers it (the fields this code reads, plus the size the live run showed). */
function psBody(...names: string[]) {
  return JSON.stringify({
    models: names.map((name) => ({ name, model: name, size: 5_980_000_000, size_vram: 5_980_000_000 })),
  });
}

test("ollamaModelLoaded: only the deployment's own model, loaded now, counts", async () => {
  setupEnv();
  const { ollamaModelLoaded } = await import("../services/nosana.js");
  const loaded = JSON.parse(psBody("llama3.2:3b"));
  assert.equal(ollamaModelLoaded(loaded, "llama3.2:3b"), true, "listed");
  assert.equal(ollamaModelLoaded({ models: [] }, "llama3.2:3b"), false, "the server answers, nothing is loaded");
  assert.equal(ollamaModelLoaded(loaded, "mistral:7b"), false, "another model is loaded");
  assert.equal(ollamaModelLoaded(loaded, "llama3.2:1b"), false, "another tag of the same model");
  // A reference without a tag is listed as :latest.
  assert.equal(ollamaModelLoaded(JSON.parse(psBody("phi3:latest")), "phi3"), true);
  assert.equal(ollamaModelLoaded(JSON.parse(psBody("library/phi3:latest")), "library/phi3"), true);
  // No model named: any loaded model.
  assert.equal(ollamaModelLoaded(loaded), true);
  assert.equal(ollamaModelLoaded({ models: [] }), false);
  // Not the shape: fail closed.
  for (const body of [null, "ok", {}, { models: "llama3.2:3b" }, { models: [null, 7, { name: 3 }] }]) {
    assert.equal(ollamaModelLoaded(body, "llama3.2:3b"), false);
  }
});

test("checkNodeHealth for Ollama: healthy only when /api/ps lists the model and a load request for it was answered; not listed, wrong model and a server that is down are unhealthy", async () => {
  const client = await makeClient({});
  const { setLoadRequestTransportForTests, pendingModelLoads, resetNodesSeenAnsweringForTests } =
    await import("../services/nosana.js");
  const url = "https://abc.node.k8s.prd.nos.ci";
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  let answer: () => Response = () => new Response(psBody("llama3.2:3b"), { status: 200 });
  globalThis.fetch = (async (target: string) => {
    seen.push(target);
    return answer();
  }) as never;
  // The load request does not go through fetch. This name is not a server of
  // ours, so the request is answered here and nothing leaves the process.
  const loadsSent: Array<{ url: string; body: string }> = [];
  let loadStatus = 200;
  const restoreTransport = setLoadRequestTransportForTests(async (target, body) => {
    loadsSent.push({ url: target, body });
    return loadStatus;
  });
  resetNodesSeenAnsweringForTests();
  try {
    assert.equal(
      (await client.checkNodeHealth(url, "ollama", "llama3.2:3b")).healthy,
      true,
      "model listed, and its load request answered",
    );
    assert.deepEqual(seen, [`${url}/api/ps`]);
    assert.deepEqual(loadsSent, [
      {
        url: `${url}/api/generate`,
        body: '{"model":"llama3.2:3b","prompt":"Hi","stream":false,"keep_alive":-1,"options":{"num_predict":1}}',
      },
    ]);
    assert.equal((await client.checkNodeHealth(url, "ollama", "llama3.2:3b")).healthy, true);
    assert.equal(loadsSent.length, 1, "seen loaded: the list is enough from now on");

    // Listed, and the node will not load it: the list alone is not believed.
    resetNodesSeenAnsweringForTests();
    loadStatus = 500;
    assert.equal((await client.checkNodeHealth(url, "ollama", "llama3.2:3b")).healthy, false, "listed, load refused");
    loadStatus = 200;

    answer = () => new Response(JSON.stringify({ models: [] }), { status: 200 });
    assert.equal((await client.checkNodeHealth(url, "ollama", "llama3.2:3b")).healthy, false, "server up, model not loaded");
    await Promise.all(pendingModelLoads());

    answer = () => new Response(psBody("mistral:7b"), { status: 200 });
    assert.equal((await client.checkNodeHealth(url, "ollama", "llama3.2:3b")).healthy, false, "wrong model");
    await Promise.all(pendingModelLoads());
    const asked = loadsSent.length;

    answer = () => new Response("Ollama is running", { status: 200 });
    assert.equal((await client.checkNodeHealth(url, "ollama", "llama3.2:3b")).healthy, false, "not the list");

    answer = () => new Response(psBody("llama3.2:3b"), { status: 502 });
    assert.equal((await client.checkNodeHealth(url, "ollama", "llama3.2:3b")).healthy, false, "the tunnel answers 502");
    assert.equal(loadsSent.length, asked, "nothing is asked of a server that did not answer with its list");

    answer = () => {
      throw new Error("ECONNREFUSED");
    };
    const down = await client.checkNodeHealth(url, "ollama", "llama3.2:3b");
    assert.equal(down.healthy, false, "server down");
    assert.equal(typeof down.latencyMs, "number");

    // vLLM: 200 on /health, whatever the body, and one token answered on its
    // own route.
    answer = () => new Response("", { status: 200 });
    assert.equal((await client.checkNodeHealth(url, "vllm", "meta-llama/Llama-3.2-3B-Instruct")).healthy, true);
    assert.equal(seen.at(-1), `${url}/health`);
    assert.deepEqual(loadsSent.slice(asked), [
      {
        url: `${url}/v1/completions`,
        body: '{"model":"meta-llama/Llama-3.2-3B-Instruct","prompt":"Hi","max_tokens":1,"stream":false}',
      },
    ]);
    // Without a model name there is nothing to ask for.
    assert.equal((await client.checkNodeHealth(url, "vllm")).healthy, true);
    assert.equal(loadsSent.length, asked + 1);
  } finally {
    await Promise.all(pendingModelLoads());
    restoreTransport();
    resetNodesSeenAnsweringForTests();
    globalThis.fetch = realFetch;
  }
});

test("checkNodeHealth probes the engine's own path and never follows redirects", async () => {
  const client = await makeClient({});
  const seen: Array<{ url: string; redirect?: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, redirect: init?.redirect });
    return new Response(psBody("llama3.2:3b"), { status: 200 });
  }) as never;
  try {
    const vllm = await client.checkNodeHealth("https://abc.node.k8s.prd.nos.ci", "vllm");
    const ollama = await client.checkNodeHealth("https://abc.node.k8s.prd.nos.ci", "ollama");
    const unspecified = await client.checkNodeHealth("https://abc.node.k8s.prd.nos.ci");
    assert.equal(vllm.healthy, true);
    assert.equal(ollama.healthy, true);
    assert.equal(unspecified.healthy, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    seen.map((s) => s.url),
    [
      "https://abc.node.k8s.prd.nos.ci/health",
      "https://abc.node.k8s.prd.nos.ci/api/ps",
      "https://abc.node.k8s.prd.nos.ci/health",
    ],
  );
  assert.ok(seen.every((s) => s.redirect === "manual"));
});

test("checkNodeHealth: non-2xx and network errors are unhealthy; a disallowed URL is never fetched", async () => {
  const client = await makeClient({});
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response("nope", { status: 503 });
  }) as never;
  try {
    assert.equal((await client.checkNodeHealth("https://abc.nos.ci", "vllm")).healthy, false);
    assert.equal(fetched, 1);

    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as never;
    assert.equal((await client.checkNodeHealth("https://abc.nos.ci", "vllm")).healthy, false);

    fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return new Response("ok");
    }) as never;
    const evil = await client.checkNodeHealth("https://nos.ci.evil.com", "vllm");
    assert.equal(evil.healthy, false);
    assert.equal(fetched, 0, "SSRF allowlist checked before any request");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("checkNodeHealth refuses loopback URLs unless ALLOW_LOOPBACK_NODE_URLS is set, even though NODE_ENV defaults to development (review #11)", async () => {
  const client = await makeClient({});
  const { nodeUrlAllowlistOptions } = await import("../services/nosana.js");
  assert.equal(process.env.NODE_ENV, "development", "the test process is a development process");
  assert.deepEqual(nodeUrlAllowlistOptions(), { allowLoopback: false });

  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response("ok");
  }) as never;
  try {
    for (const url of ["http://localhost:8000", "http://127.0.0.1:11434", "https://localhost"]) {
      assert.equal((await client.checkNodeHealth(url, "vllm")).healthy, false, url);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0, "localhost is never fetched without the opt-in");
});

// ============================================
// the dev-only mock gate
// ============================================

test("isNosanaMockEnabled is true ONLY for ALLOW_NOSANA_MOCK in a development process", async () => {
  setupEnv();
  const { isNosanaMockEnabled } = await import("../services/nosana.js");
  assert.equal(isNosanaMockEnabled({ ALLOW_NOSANA_MOCK: true, NODE_ENV: "development" }), true);
  assert.equal(isNosanaMockEnabled({ ALLOW_NOSANA_MOCK: true, NODE_ENV: "staging" }), false);
  assert.equal(isNosanaMockEnabled({ ALLOW_NOSANA_MOCK: true, NODE_ENV: "production" }), false);
  assert.equal(isNosanaMockEnabled({ ALLOW_NOSANA_MOCK: false, NODE_ENV: "development" }), false);
  assert.equal(isNosanaMockEnabled({ NODE_ENV: "development" }), false);
  // and the real env in this test process has the flag unset
  assert.equal(isNosanaMockEnabled(), false);
});

test("isMockNosanaId recognises both mock id families", async () => {
  setupEnv();
  const { isMockNosanaId } = await import("../services/nosana.js");
  assert.equal(isMockNosanaId("mock_deploy_abc"), true);
  assert.equal(isMockNosanaId("mock_job_abc"), true);
  assert.equal(isMockNosanaId("8kGjraXnXirSQcgjxTbFBK7QTBVz9fm9ufSRVr3DqBTV"), false);
});
