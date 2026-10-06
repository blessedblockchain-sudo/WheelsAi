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
  endpoints?: Array<{ opId: string; port: number; url: string }>;
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

async function makeClient(opts: {
  network?: "devnet" | "mainnet";
  wallet?: boolean;
  sdk?: ReturnType<typeof fakeSdk>;
}) {
  setupEnv();
  const { NosanaClient } = await import("../services/nosana.js");
  const client = new NosanaClient();
  (client as any).sdk = (opts.sdk ?? fakeSdk()).sdk;
  (client as any).wallet = opts.wallet === false ? null : Keypair.generate();
  (client as any).network = opts.network ?? "mainnet";
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
  assert.equal(body.timeout, 7200);
  assert.ok(body.timeout < 30 * 24 * 3600, "the 30-day default is gone");
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

test("createDeployment kind 'batch' uses the SIMPLE strategy and the batch timeout (training is not auto-extended)", async () => {
  const sdk = fakeSdk({ jobPrice: "100" });
  const client = await makeClient({ sdk });
  await client.createDeployment(DEFINITION as any, "4090", 1, { kind: "batch" });
  const body = sdk.calls.createBodies[0];
  assert.equal(body.strategy, "SIMPLE");
  assert.equal(body.timeout, 21_600);
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
    endpoints: [{ opId: "vllm-inference", port: 8000, url: "https://abc.node.k8s.prd.nos.ci/" }],
    events: [{ type: "JOB_STARTED", message: "started", created_at: "2026-09-30T10:00:00.000Z" }],
  });
  const client = await makeClient({ sdk });
  const snap = await client.getDeploymentStatus("dm_test");
  assert.equal(snap.status, "running");
  assert.deepEqual(snap.endpoints, [
    { url: "https://abc.node.k8s.prd.nos.ci", port: 8000, opId: "vllm-inference" },
  ]);
  assert.equal(snap.events[0]!.type, "JOB_STARTED");
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

test("nodeHealthPath: vLLM serves /health, Ollama does not (it serves /api/tags)", async () => {
  setupEnv();
  const { nodeHealthPath } = await import("../services/nosana.js");
  assert.equal(nodeHealthPath("vllm"), "/health");
  assert.equal(nodeHealthPath("ollama"), "/api/tags");
  assert.equal(nodeHealthPath(undefined), "/health");
});

test("checkNodeHealth probes the engine's own path and never follows redirects", async () => {
  const client = await makeClient({});
  const seen: Array<{ url: string; redirect?: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, redirect: init?.redirect });
    return new Response("ok", { status: 200 });
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
      "https://abc.node.k8s.prd.nos.ci/api/tags",
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
