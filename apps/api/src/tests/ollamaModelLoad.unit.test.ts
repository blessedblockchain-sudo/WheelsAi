import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

// Env must be in place BEFORE config/nosanaDeploy (cached) and config/env are first imported.
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
// A loopback server stands in for a node (development + the explicit opt-in).
process.env.ALLOW_LOOPBACK_NODE_URLS = "true";

// A node whose model is not loaded gets no request (only healthy nodes are
// routed to, and healthy means loaded), and Ollama loads a model only when a
// request for it arrives. So the probe that finds the server up and the model
// missing asks the node to load it: POST /api/generate with the smallest real
// generation (one token, kept loaded for ever).
//
// /api/ps lists a model from the moment its load begins, and a model that is
// in memory has still not run its first, slow, generation. So a listed model
// is healthy only once that request has been answered.

const MODEL = "llama3.2:3b";

/** What the node is sent: one generated token, never unloaded. */
const LOAD_BODY = { model: MODEL, prompt: "Hi", stream: false, keep_alive: -1, options: { num_predict: 1 } };

interface NodeStandIn {
  url: string;
  /** Every request the node received, in order: "METHOD path". */
  requests: string[];
  /** The bodies of the load requests, parsed. */
  loadBodies: unknown[];
  /** What /api/ps lists. A model is listed from the moment its load begins. */
  loaded: string[];
  /** The model is in memory: a load request is answered at once. Otherwise it waits for finishLoads. */
  inMemory: boolean;
  /** What /api/ps answers with: 200 and the list, unless set otherwise. */
  psStatus: number;
  /** What a vLLM node's GET /health answers. */
  healthStatus: number;
  /** Ends the load requests that are waiting, with this status. */
  finishLoads(status?: number): void;
  close(): Promise<void>;
}

/** A node on a port the OS assigns: Ollama's /api/ps, vLLM's /health, and a load request that answers only when told to. */
async function startNode(): Promise<NodeStandIn> {
  const waiting: ServerResponse[] = [];
  const node: NodeStandIn = {
    url: "",
    requests: [],
    loadBodies: [],
    loaded: [],
    inMemory: false,
    psStatus: 200,
    healthStatus: 200,
    finishLoads(status = 200) {
      for (const res of waiting.splice(0)) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: MODEL, done: true, done_reason: "load" }));
      }
    },
    close: () =>
      new Promise((resolve) => {
        node.finishLoads(503);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    node.requests.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/api/ps") {
      res.writeHead(node.psStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: node.loaded.map((name) => ({ name, model: name })) }));
      return;
    }
    // The load request of either engine: Ollama's generate route, vLLM's
    // completions route.
    if (req.method === "POST" && (req.url === "/api/generate" || req.url === "/v1/completions")) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        node.loadBodies.push(JSON.parse(raw));
        // Like the engines: no answer until the model has generated.
        waiting.push(res);
        if (node.inMemory) node.finishLoads(200);
      });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(node.healthStatus);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  node.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return node;
}

const loads = (node: NodeStandIn) => node.requests.filter((r) => r === "POST /api/generate").length;

/** Waits until the node has received `count` load requests (they are sent in the background). */
async function untilLoads(node: NodeStandIn, count: number): Promise<void> {
  for (let i = 0; i < 200 && node.loadBodies.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(node.loadBodies.length, count);
}

test("server up, model missing: one load request with Ollama's preload body, and the probe stays unhealthy; nothing more while it is in flight; a new one after it ends; none once the model is listed", async () => {
  const { NosanaClient, pendingModelLoads, OLLAMA_LOAD_PATH } = await import("../services/nosana.js");
  assert.equal(OLLAMA_LOAD_PATH, "/api/generate");
  const client = new NosanaClient();
  const node = await startNode();
  try {
    const first = await client.checkNodeHealth(node.url, "ollama", MODEL);
    assert.equal(first.healthy, false, "not healthy until /api/ps lists the model");
    await untilLoads(node, 1);
    assert.deepEqual(node.loadBodies[0], LOAD_BODY, "a real generation of one token, never unloaded");
    assert.equal(
      JSON.stringify(node.loadBodies[0]),
      `{"model":"${MODEL}","prompt":"Hi","stream":false,"keep_alive":-1,"options":{"num_predict":1}}`,
    );
    assert.equal(pendingModelLoads().length, 1);

    // A second and a third probe while the load is in flight: no second request.
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, false);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(loads(node), 1, "one load in flight per node");

    // The load ends (here: without the model appearing). Its record is gone,
    // and the next probe that still finds the model missing asks again.
    const inFlight = pendingModelLoads();
    node.finishLoads(500);
    await Promise.all(inFlight);
    assert.equal(pendingModelLoads().length, 0, "the record is removed when the request ends");
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, false);
    await untilLoads(node, 2);
    assert.deepEqual(node.loadBodies[1], LOAD_BODY);

    // This one succeeds: the model is listed, the probe is healthy, and no
    // further load is asked for.
    const second = pendingModelLoads();
    node.loaded = [MODEL];
    node.finishLoads(200);
    await Promise.all(second);
    assert.equal(pendingModelLoads().length, 0);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(loads(node), 2, "model listed: no load request");
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

test("the load request is a generation, not a bare load: a node's first generation after a cold start is the slow one", async () => {
  const { ollamaLoadRequestBody } = await import("../services/nosana.js");
  const body = JSON.parse(ollamaLoadRequestBody(MODEL));
  assert.deepEqual(body, LOAD_BODY);
  assert.ok(typeof body.prompt === "string" && body.prompt.length > 0, "no prompt would be answered before anything was generated");
  assert.equal(body.stream, false, "one answer, when the generation is done");
  assert.equal(body.keep_alive, -1, "never unloaded");
  assert.deepEqual(Object.keys(body.options), ["num_predict"], "no runner option: nothing that makes Ollama reload the model");
  assert.equal(body.options.num_predict, 1);
});

test("model names are compared without regard to letter case", async () => {
  const { NosanaClient, ollamaModelLoaded, pendingModelLoads } = await import("../services/nosana.js");
  assert.equal(ollamaModelLoaded({ models: [{ name: "Llama3.2:3B" }] }, "llama3.2:3b"), true);
  assert.equal(ollamaModelLoaded({ models: [{ name: "phi3:latest" }] }, "PHI3"), true);
  assert.equal(ollamaModelLoaded({ models: [{ name: "llama3.2:1b" }] }, "LLAMA3.2:3B"), false);
  const client = new NosanaClient();
  const node = await startNode();
  try {
    node.loaded = ["LLAMA3.2:3B"];
    node.inMemory = true;
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", "Llama3.2:3B")).healthy, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(loads(node), 1, "seen loaded once, under either spelling");
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

test("a listed model is not healthy while it is still loading: the probe needs its load request answered", async () => {
  const { NosanaClient, pendingModelLoads } = await import("../services/nosana.js");
  const client = new NosanaClient();
  const node = await startNode();
  try {
    // The container's own preload has begun the load: /api/ps lists the model
    // already, and nothing can answer for it yet.
    node.loaded = [MODEL];
    const first = await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 });
    assert.equal(first.healthy, false, "listed is not loaded");
    await untilLoads(node, 1);
    assert.deepEqual(node.loadBodies[0], LOAD_BODY);
    assert.equal(pendingModelLoads().length, 1, "the request is left running, not ended");

    // Later probes while the load goes on: unhealthy, and no second request.
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 })).healthy, false);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 })).healthy, false);
    assert.equal(loads(node), 1);

    // A load that fails proves nothing.
    const failed = pendingModelLoads();
    node.finishLoads(500);
    await Promise.all(failed);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 })).healthy, false);
    await untilLoads(node, 2);

    // The load is done: Ollama answers the request, and the next probe is healthy.
    const loading = pendingModelLoads();
    node.finishLoads(200);
    await Promise.all(loading);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(loads(node), 2, "seen loaded: no further request");
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

test("a model already in memory is healthy within the first probe: nothing is remembered across a restart of the API", async () => {
  const { NosanaClient, pendingModelLoads, resetNodesSeenAnsweringForTests, MODEL_ANSWER_WAIT_MS } =
    await import("../services/nosana.js");
  assert.ok(MODEL_ANSWER_WAIT_MS >= 1_000 && MODEL_ANSWER_WAIT_MS <= 4_000, "inside the probe's own five seconds");
  const client = new NosanaClient();
  const node = await startNode();
  try {
    node.loaded = [MODEL];
    node.inMemory = true;
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true, "answered at once");
    assert.equal(loads(node), 1);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(loads(node), 1, "seen loaded: the list alone is enough from now on");

    // A new process has seen nothing: it asks once more, and is answered at once.
    resetNodesSeenAnsweringForTests();
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(loads(node), 2);
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

test("a model that leaves the list is no longer taken as loaded when it comes back", async () => {
  const { NosanaClient, pendingModelLoads } = await import("../services/nosana.js");
  const client = new NosanaClient();
  const node = await startNode();
  try {
    node.loaded = [MODEL];
    node.inMemory = true;
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(loads(node), 1);

    // The runner restarted: the model is gone, and the node is asked to load it.
    node.loaded = [];
    node.inMemory = false;
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, false);
    await untilLoads(node, 2);

    // It is listed again as soon as that load begins. What was seen before the
    // restart does not count: unhealthy until this load is answered.
    node.loaded = [MODEL];
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 })).healthy, false);
    assert.equal(loads(node), 2, "the load in flight is the one that will say");
    const reloading = pendingModelLoads();
    node.finishLoads(200);
    await Promise.all(reloading);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(loads(node), 2);
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

// After the API restarts nothing has been seen answering. A warm node that is
// generating a customer's answer queues the one-token request behind it: the
// probe cannot say "ready" in time, and must not say "unhealthy" either.
test("a listed model whose request is not answered in time is pending, not unhealthy: warm and busy looks the same as loading", async () => {
  const { NosanaClient, pendingModelLoads, resetNodesSeenAnsweringForTests, MODEL_LOAD_PENDING_GRACE_MS } =
    await import("../services/nosana.js");
  assert.ok(MODEL_LOAD_PENDING_GRACE_MS >= 30_000 && MODEL_LOAD_PENDING_GRACE_MS <= 120_000);
  const client = new NosanaClient();
  const node = await startNode();
  try {
    // Warm and confirmed; then the process restarts while the node is busy.
    node.loaded = [MODEL];
    node.inMemory = true;
    assert.deepEqual(Object.keys(await client.checkNodeHealth(node.url, "ollama", MODEL)).sort(), ["healthy", "latencyMs"]);
    resetNodesSeenAnsweringForTests();
    node.inMemory = false; // the request waits behind the customer's generation

    const first = await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 });
    assert.equal(first.healthy, false);
    assert.equal(first.pending, true, "not known yet");
    await untilLoads(node, 2);
    // While it is in flight: still pending, at once, and no second request.
    const second = await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 });
    assert.deepEqual([second.healthy, second.pending], [false, true]);
    assert.equal(loads(node), 2);

    // Unanswered for longer than the grace: no longer "not known", it is not ready.
    const late = await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40, pendingGraceMs: 0 });
    assert.equal(late.healthy, false);
    assert.equal(late.pending, undefined);

    // The customer's answer is done and the request is answered.
    const waiting = pendingModelLoads();
    node.finishLoads(200);
    await Promise.all(waiting);
    const ready = await client.checkNodeHealth(node.url, "ollama", MODEL);
    assert.equal(ready.healthy, true);
    assert.equal(ready.pending, undefined);

    // A model that is not listed is never pending: it is not loaded.
    node.loaded = [];
    const missing = await client.checkNodeHealth(node.url, "ollama", MODEL);
    assert.deepEqual([missing.healthy, missing.pending], [false, undefined]);
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

// The URL is the deployment's, not a container's. A new container behind it
// lists its model from the moment its own preload begins.
test("a probe that gets no model list forgets what was seen answering: an error status, a body that is not the list, no connection", async () => {
  const { NosanaClient, pendingModelLoads } = await import("../services/nosana.js");
  const client = new NosanaClient();
  const node = await startNode();
  const realFetch = globalThis.fetch;
  try {
    const outages: Array<[string, () => void, () => void]> = [
      ["an error status", () => (node.psStatus = 503), () => (node.psStatus = 200)],
      [
        "a body that is not the list",
        () => (globalThis.fetch = (async () => new Response("Bad gateway", { status: 200 })) as never),
        () => (globalThis.fetch = realFetch),
      ],
      [
        "no connection",
        () =>
          (globalThis.fetch = (async () => {
            throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
          }) as never),
        () => (globalThis.fetch = realFetch),
      ],
    ];
    for (const [what, begin, end] of outages) {
      node.loaded = [MODEL];
      node.inMemory = true;
      assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true, what);
      const seen = loads(node);

      // The container is replaced: nothing answers for a while...
      begin();
      assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, false, what);
      end();

      // ...and the new one lists the model while it is still loading.
      node.inMemory = false;
      const loading = await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 });
      assert.equal(loading.healthy, false, `${what}: listed is not loaded, whatever answered here before`);
      await untilLoads(node, seen + 1);

      const inFlight = pendingModelLoads();
      node.finishLoads(200);
      await Promise.all(inFlight);
      assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true, what);
    }
  } finally {
    globalThis.fetch = realFetch;
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

test("forgetNodeAnswered: the next probe asks the node again (an endpoint that went offline, a dropped node, a row out of service)", async () => {
  const { NosanaClient, pendingModelLoads, forgetNodeAnswered } = await import("../services/nosana.js");
  const client = new NosanaClient();
  const node = await startNode();
  try {
    node.loaded = [MODEL];
    node.inMemory = true;
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(loads(node), 1);

    forgetNodeAnswered(node.url);
    forgetNodeAnswered("https://never-seen.node.k8s.prd.nos.ci"); // nothing to forget: no throw
    node.inMemory = false;
    const probe = await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 });
    assert.equal(probe.healthy, false);
    await untilLoads(node, 2);
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

test("a confirmation has an age: past it the node is asked again, and a request that fails takes the confirmation with it", async () => {
  const {
    NosanaClient,
    pendingModelLoads,
    ageNodeAnsweredForTests,
    NODE_ANSWERED_MAX_AGE_MS,
  } = await import("../services/nosana.js");
  assert.ok(NODE_ANSWERED_MAX_AGE_MS >= 60_000 && NODE_ANSWERED_MAX_AGE_MS <= 15 * 60_000);
  const client = new NosanaClient();
  const node = await startNode();
  try {
    node.loaded = [MODEL];
    node.inMemory = true;
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(ageNodeAnsweredForTests(node.url, NODE_ANSWERED_MAX_AGE_MS - 5_000), true);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(loads(node), 1, "inside its age: the list is enough");

    // Too old, and the node is warm: asked again and answered within the probe.
    ageNodeAnsweredForTests(node.url, NODE_ANSWERED_MAX_AGE_MS + 1);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(loads(node), 2);
    assert.equal((await client.checkNodeHealth(node.url, "ollama", MODEL)).healthy, true);
    assert.equal(loads(node), 2, "confirmed anew");

    // Too old, and what is behind the URL now is loading: pending, then (the
    // request fails) not ready, with nothing left of the old confirmation.
    ageNodeAnsweredForTests(node.url, NODE_ANSWERED_MAX_AGE_MS + 1);
    node.inMemory = false;
    const stale = await client.checkNodeHealth(node.url, "ollama", MODEL, { loadedCheckWaitMs: 40 });
    assert.deepEqual([stale.healthy, stale.pending], [false, true]);
    const inFlight = pendingModelLoads();
    node.finishLoads(500);
    await Promise.all(inFlight);
    assert.equal(ageNodeAnsweredForTests(node.url, 0), false, "forgotten");
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

test("a load that outlives its deadline is given up and its record removed", async () => {
  const { requestModelLoad, pendingModelLoads, MODEL_LOAD_DEADLINE_MS } = await import("../services/nosana.js");
  assert.ok(MODEL_LOAD_DEADLINE_MS >= 5 * 60_000, "minutes: a load reads the whole model into GPU memory");
  const node = await startNode();
  try {
    assert.equal(requestModelLoad(node.url, "ollama", MODEL, { deadlineMs: 40 }), true);
    assert.equal(requestModelLoad(node.url, "ollama", MODEL, { deadlineMs: 40 }), false, "one in flight");
    await Promise.all(pendingModelLoads());
    assert.equal(pendingModelLoads().length, 0);
    assert.equal(loads(node), 1);
    assert.equal(requestModelLoad(node.url, "ollama", MODEL, { deadlineMs: 40 }), true, "free again");
    await Promise.all(pendingModelLoads());
  } finally {
    await node.close();
  }
});

test("server down: no load request and no throw", async () => {
  const { NosanaClient, pendingModelLoads } = await import("../services/nosana.js");
  const client = new NosanaClient();
  // A port nothing listens on: taken from the OS, then released.
  const node = await startNode();
  const url = node.url;
  await node.close();
  const probe = await client.checkNodeHealth(url, "ollama", MODEL);
  assert.equal(probe.healthy, false);
  assert.equal(pendingModelLoads().length, 0);
  assert.deepEqual(node.requests, []);
});

test("a server that answers but is not Ollama (no model list, an error status) is not asked to load anything", async () => {
  const { NosanaClient, pendingModelLoads } = await import("../services/nosana.js");
  const client = new NosanaClient();
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  let answer: () => Response = () => new Response("Ollama is running", { status: 200 });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${url}`);
    return answer();
  }) as never;
  try {
    const url = "http://127.0.0.1:9";
    assert.equal((await client.checkNodeHealth(url, "ollama", MODEL)).healthy, false);
    answer = () => new Response(JSON.stringify({ models: [] }), { status: 502 });
    assert.equal((await client.checkNodeHealth(url, "ollama", MODEL)).healthy, false);
    answer = () => new Response(JSON.stringify({ error: "x" }), { status: 200 });
    assert.equal((await client.checkNodeHealth(url, "ollama", MODEL)).healthy, false);
    // No model named: nothing to ask for.
    answer = () => new Response(JSON.stringify({ models: [] }), { status: 200 });
    assert.equal((await client.checkNodeHealth(url, "ollama")).healthy, false);
    assert.equal(pendingModelLoads().length, 0);
    assert.deepEqual(seen, Array(4).fill(`GET ${url}/api/ps`));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a URL off the allowlist: no request at all, neither the probe nor a load", async () => {
  const { NosanaClient, requestModelLoad, pendingModelLoads } = await import("../services/nosana.js");
  const client = new NosanaClient();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  }) as never;
  try {
    for (const url of ["http://10.0.0.1:11434", "http://169.254.169.254", "https://nos.ci.evil.com", "not a url"]) {
      assert.equal((await client.checkNodeHealth(url, "ollama", MODEL)).healthy, false, url);
      assert.equal(requestModelLoad(url, "ollama", MODEL), false, url);
    }
    assert.equal(pendingModelLoads().length, 0);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the load request: a failure is not thrown and its record is removed", async () => {
  const { requestModelLoad, pendingModelLoads } = await import("../services/nosana.js");
  // A port nothing listens on: taken from the OS, then released.
  const node = await startNode();
  const url = node.url;
  await node.close();
  assert.equal(requestModelLoad(url, "ollama", MODEL), true, "returns at once; the failure is not thrown");
  await Promise.all(pendingModelLoads());
  assert.equal(pendingModelLoads().length, 0, "removed after a failure too");
});

test("the load request never follows a redirect", async () => {
  const { requestModelLoad, pendingModelLoads } = await import("../services/nosana.js");
  const elsewhere = await startNode();
  const seen: string[] = [];
  const redirecting: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(307, { Location: `${elsewhere.url}/api/generate` });
    res.end();
  });
  await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`;
    assert.equal(requestModelLoad(url, "ollama", MODEL), true);
    await Promise.all(pendingModelLoads());
    assert.deepEqual(seen, ["POST /api/generate"]);
    assert.deepEqual(elsewhere.requests, [], "the redirect target is never contacted");
    assert.equal(pendingModelLoads().length, 0);
  } finally {
    redirecting.closeAllConnections();
    await new Promise((resolve) => redirecting.close(resolve));
    await elsewhere.close();
  }
});

// Ollama sends no headers until the load is done, and the runtime's fetch
// gives up on such a server after 300 seconds whatever deadline the caller
// set. The load therefore does not go through fetch: its own deadline is the
// only thing that ends it.
test("the load request's own deadline is what ends it: it is not sent through fetch, whose 300-second header limit would cut a long load", async () => {
  const { requestModelLoad, pendingModelLoads } = await import("../services/nosana.js");
  const node = await startNode();
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    throw new Error("the load must not go through fetch");
  }) as never;
  try {
    const startedAt = Date.now();
    assert.equal(requestModelLoad(node.url, "ollama", MODEL, { deadlineMs: 300 }), true);
    await untilLoads(node, 1);
    assert.deepEqual(node.loadBodies[0], LOAD_BODY);
    // The node never answers: the request is still open just before the deadline...
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(pendingModelLoads().length, 1, "still waiting before its deadline");
    // ...and ends at it.
    await Promise.all(pendingModelLoads());
    const ms = Date.now() - startedAt;
    assert.ok(ms >= 290 && ms < 3_000, `ended at its deadline (${ms} ms)`);
    assert.equal(pendingModelLoads().length, 0);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
    await node.close();
  }
});

// The node belongs to a third-party host. Whatever it sends, the probe holds
// no more than the cap in memory and does not wait for the rest.
test("the probe reads no more than its cap of an answer: an endless body is unhealthy at once, and nothing is asked to load", async () => {
  const { NosanaClient, pendingModelLoads, MAX_PROBE_BODY_BYTES } = await import("../services/nosana.js");
  assert.equal(MAX_PROBE_BODY_BYTES, 64 * 1024);
  const client = new NosanaClient();
  let sent = 0;
  let closedAt = 0;
  const requests: string[] = [];
  const chunk = Buffer.alloc(16 * 1024, " ");
  const endless: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    const pump = setInterval(() => {
      sent += chunk.length;
      res.write(chunk);
    }, 2);
    res.on("close", () => {
      clearInterval(pump);
      closedAt = Date.now();
    });
  });
  await new Promise<void>((resolve) => endless.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(endless.address() as AddressInfo).port}`;
    const startedAt = Date.now();
    const probe = await client.checkNodeHealth(url, "ollama", MODEL);
    const ms = Date.now() - startedAt;
    assert.equal(probe.healthy, false);
    assert.ok(ms < 2_500, `the probe did not wait out its 5-second deadline (${ms} ms)`);
    for (let i = 0; i < 100 && closedAt === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(closedAt > 0, "the connection was dropped at the cap");
    assert.ok(sent < 8 * 1024 * 1024, `the node was not read for long past the cap (${sent} bytes sent)`);
    assert.equal(pendingModelLoads().length, 0);
    assert.deepEqual(requests, ["GET /api/ps"]);
  } finally {
    endless.closeAllConnections();
    await new Promise((resolve) => endless.close(resolve));
  }
});

test("readProbeBody: a declared length over the cap is refused unread; a stream is cut at the first chunk past it; an answer under it is returned whole", async () => {
  const { readProbeBody, ollamaModelLoaded } = await import("../services/nosana.js");
  let pulled = 0;
  const counted = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled];
        pulled += 1;
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });

  // Declared too large: not one chunk is taken.
  pulled = 0;
  const declared = new Response(counted(["x".repeat(10), "x".repeat(10)]), { headers: { "content-length": "999999" } });
  assert.equal(await readProbeBody(declared, 100), null);
  assert.ok(pulled <= 1, "refused on the declared length");

  // No declared length: cut at the chunk that passes the cap, the rest never pulled.
  pulled = 0;
  const streamed = new Response(counted(Array(50).fill("x".repeat(40))));
  assert.equal(await readProbeBody(streamed, 100), null);
  assert.ok(pulled <= 5, `the stream was cancelled at the cap (${pulled} chunks pulled)`);

  // An answer in several chunks under the cap is read whole.
  pulled = 0;
  const answer = JSON.stringify({ models: [{ name: MODEL, model: MODEL }] });
  const whole = await readProbeBody(new Response(counted([answer.slice(0, 7), answer.slice(7)])), 64 * 1024);
  assert.equal(whole, answer);
  assert.equal(ollamaModelLoaded(JSON.parse(whole!), MODEL), true);

  // Exactly at the cap is still an answer.
  assert.equal(await readProbeBody(new Response("y".repeat(100)), 100), "y".repeat(100));
  assert.equal(await readProbeBody(new Response("y".repeat(101)), 100), null);
});

// The first live vLLM deployment (a 4090, 2026-10-08): /health answered 200,
// the row turned `running`, and the first request took 27 seconds while
// Nosana's own health check failed and the deployment read as not serving.
// Every later request took a quarter of a second. So a vLLM node is healthy
// only once it has answered one token, like an Ollama node.
const VLLM_MODEL = "microsoft/Phi-3-mini-4k-instruct";
const VLLM_LOAD_BODY = { model: VLLM_MODEL, prompt: "Hi", max_tokens: 1, stream: false };

test("vLLM: /health 200 is not enough; the node is healthy once it has answered one token on /v1/completions", async () => {
  const { NosanaClient, pendingModelLoads, vllmLoadRequestBody, VLLM_LOAD_PATH } = await import("../services/nosana.js");
  assert.equal(VLLM_LOAD_PATH, "/v1/completions");
  assert.equal(vllmLoadRequestBody(VLLM_MODEL), JSON.stringify(VLLM_LOAD_BODY));
  const client = new NosanaClient();
  const node = await startNode();
  const vllmLoads = () => node.requests.filter((r) => r === "POST /v1/completions").length;
  try {
    // The engine is up and has not generated yet.
    const first = await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL, { loadedCheckWaitMs: 40 });
    assert.equal(first.healthy, false, "up is not answering");
    assert.equal(first.pending, true, "a request is in flight: not known yet");
    await untilLoads(node, 1);
    assert.deepEqual(node.loadBodies[0], VLLM_LOAD_BODY);
    assert.deepEqual(node.requests, ["GET /health", "POST /v1/completions"]);

    // While the first generation runs: still not healthy, and no second request.
    assert.equal((await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL, { loadedCheckWaitMs: 40 })).healthy, false);
    assert.equal(vllmLoads(), 1);

    // It answers: healthy from now on, on /health alone.
    const generating = pendingModelLoads();
    node.finishLoads(200);
    await Promise.all(generating);
    assert.equal((await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL)).healthy, true);
    assert.equal((await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL)).healthy, true);
    assert.equal(vllmLoads(), 1, "seen answering: no further request");
    assert.equal(loads(node), 0, "never Ollama's route");
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

test("vLLM: a warm node is healthy within the first probe; an engine that stops answering /health is asked again when it is back", async () => {
  const { NosanaClient, pendingModelLoads } = await import("../services/nosana.js");
  const client = new NosanaClient();
  const node = await startNode();
  const vllmLoads = () => node.requests.filter((r) => r === "POST /v1/completions").length;
  try {
    node.inMemory = true;
    assert.equal((await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL)).healthy, true, "answered at once");
    assert.equal(vllmLoads(), 1);

    // The container was replaced: /health fails, and what was seen is forgotten.
    node.healthStatus = 503;
    node.inMemory = false;
    assert.equal((await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL)).healthy, false);
    assert.equal(vllmLoads(), 1, "nothing is asked of an engine that is not up");

    // Up again, and cold: not healthy until this engine has answered too.
    node.healthStatus = 200;
    assert.equal((await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL, { loadedCheckWaitMs: 40 })).healthy, false);
    assert.equal(vllmLoads(), 2);
    const generating = pendingModelLoads();
    node.finishLoads(200);
    await Promise.all(generating);
    assert.equal((await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL)).healthy, true);
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

test("vLLM: a node that refuses the request (an unknown model name) is not healthy", async () => {
  const { NosanaClient, pendingModelLoads } = await import("../services/nosana.js");
  const client = new NosanaClient();
  const node = await startNode();
  try {
    assert.equal((await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL, { loadedCheckWaitMs: 40 })).healthy, false);
    const asked = pendingModelLoads();
    node.finishLoads(404);
    await Promise.all(asked);
    const after = await client.checkNodeHealth(node.url, "vllm", VLLM_MODEL, { loadedCheckWaitMs: 40 });
    assert.equal(after.healthy, false, "a refusal proves nothing");
  } finally {
    await node.close();
    await Promise.all(pendingModelLoads());
  }
});

// A vLLM engine whose /health is 200 has its model in memory already, so its
// one-token request has no weights to wait for. One request per node may be
// in flight: an answer that is lost on the way must not hold the node's next
// confirmation back for the ten minutes an Ollama load is given.
test("vLLM: a one-token request that is never answered is given up after a minute and a half, and the node is asked again", async (t) => {
  const { requestModelLoad, pendingModelLoads, setLoadRequestTransportForTests, MODEL_LOAD_DEADLINE_MS, VLLM_ANSWER_DEADLINE_MS } =
    await import("../services/nosana.js");
  assert.equal(VLLM_ANSWER_DEADLINE_MS, 90_000);
  assert.ok(VLLM_ANSWER_DEADLINE_MS < MODEL_LOAD_DEADLINE_MS);
  const node = await startNode();
  // The answer never comes: the request ends only when it is given up.
  let sent = 0;
  const restore = setLoadRequestTransportForTests(
    (_url, _body, signal) =>
      new Promise<number>((_resolve, reject) => {
        sent += 1;
        signal.addEventListener("abort", () => reject(new Error("given up")), { once: true });
      }),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(requestModelLoad(node.url, "vllm", VLLM_MODEL, { reason: "confirm" }), true);
    t.mock.timers.tick(VLLM_ANSWER_DEADLINE_MS - 1);
    assert.equal(requestModelLoad(node.url, "vllm", VLLM_MODEL, { reason: "confirm" }), false, "still in flight");
    const hung = pendingModelLoads();
    t.mock.timers.tick(1);
    await Promise.all(hung);
    assert.equal(pendingModelLoads().length, 0, "given up");
    assert.equal(requestModelLoad(node.url, "vllm", VLLM_MODEL, { reason: "confirm" }), true, "the next probe asks again");
    assert.equal(sent, 2);
    t.mock.timers.tick(VLLM_ANSWER_DEADLINE_MS);
    await Promise.all(pendingModelLoads());

    // An Ollama load reads the weights into GPU memory: it keeps its ten minutes.
    assert.equal(requestModelLoad(node.url, "ollama", MODEL), true);
    t.mock.timers.tick(VLLM_ANSWER_DEADLINE_MS);
    assert.equal(pendingModelLoads().length, 1, "an Ollama load is not given up that early");
    const loading = pendingModelLoads();
    t.mock.timers.tick(MODEL_LOAD_DEADLINE_MS - VLLM_ANSWER_DEADLINE_MS);
    await Promise.all(loading);
    assert.equal(pendingModelLoads().length, 0);
  } finally {
    t.mock.timers.reset();
    restore();
    await node.close();
  }
});

test("with no model named, or no engine, the probe is /health and nothing is asked", async () => {
  const { NosanaClient, pendingModelLoads } = await import("../services/nosana.js");
  const client = new NosanaClient();
  const node = await startNode();
  try {
    assert.equal((await client.checkNodeHealth(node.url, "vllm")).healthy, true);
    assert.equal((await client.checkNodeHealth(node.url, undefined, MODEL)).healthy, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pendingModelLoads().length, 0);
    assert.deepEqual(node.requests, ["GET /health", "GET /health"]);
  } finally {
    await node.close();
  }
});
