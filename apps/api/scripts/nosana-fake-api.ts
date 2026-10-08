/**
 * A stand-in Nosana for rehearsing the API-key deployment flow on one machine.
 *
 * Starts, on loopback only:
 *   - the fake Nosana REST API of the unit tests (src/tests/fakeNosanaApi.ts),
 *     which the real @nosana/sdk talks to when NOSANA_API_URL points at it;
 *   - a fake inference node that answers the readiness probes (/health for
 *     vLLM; for Ollama /api/ps, listing FAKE_NODE_MODEL as loaded, and
 *     /api/tags) and the load request of each engine (POST /api/generate for
 *     that model, POST /v1/completions), so a deployment can be observed
 *     "running";
 *   - a stand-in Solana RPC that answers 500 and counts its requests (the
 *     API-key path must make none).
 *
 * Unlike the tests, nobody scripts the state changes here, so the fake moves
 * a deployment on by itself. As on Nosana, a start makes it RUNNING at once;
 * FAKE_START_MS later a node "takes" the job (one job listed) and its one
 * endpoint, pointed at the fake node, comes online. STOPPING becomes STOPPED
 * (the job stopped, the endpoint offline) after FAKE_STOP_MS.
 *
 * This is NOT Nosana and proves nothing about the live service: no GPU, no
 * credit accounting (the balance stays what FAKE_BALANCE_USD says), and the
 * timings are invented. It exists to drive our own code end to end.
 *
 *   npx tsx scripts/nosana-fake-api.ts
 *
 * Environment (all optional):
 *   FAKE_NOSANA_PORT   4310   the REST API
 *   FAKE_NODE_PORT     4311   the inference node
 *   FAKE_RPC_PORT      4312   the Solana RPC stand-in
 *   FAKE_NOSANA_KEY    the only Bearer key accepted (a test constant by default)
 *   FAKE_BALANCE_USD   100    assigned credits
 *   FAKE_LOW_BALANCE_USD 1    what SIGUSR1 sets the balance to (SIGUSR2 restores it)
 *   FAKE_START_MS      8000   RUNNING -> a job listed and the endpoint online
 *   FAKE_STOP_MS       3000   STOPPING -> STOPPED
 *   FAKE_NODE_MODEL    llama3.2:3b   the model the node's /api/ps lists as loaded
 *                      (the platform's Ollama probe is healthy only for the
 *                      deployment's own model; empty = nothing loaded)
 *   FAKE_NODE_TLS_CERT, FAKE_NODE_TLS_KEY   PEM files for the fake node
 *
 * The platform only accepts https endpoints, so the node is advertised as
 * https://127.0.0.1:<port>. Give it a certificate for 127.0.0.1 and trust it
 * in the API process (NODE_EXTRA_CA_CERTS) to see the node probed healthy:
 *
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=127.0.0.1" \
 *     -addext "subjectAltName=IP:127.0.0.1" -keyout node.key -out node.crt
 *
 * Without one the node speaks plain http: the deployment still reaches
 * "provisioning" (a model deployment is "running" only once its node probes
 * healthy) and its node reads unhealthy. Until the node takes the job, the endpoint Nosana computed at
 * create is listed offline.
 *
 * Then start the API with NOSANA_API_KEY=<the key>, NOSANA_ACCESS_MODE=api_key,
 * NOSANA_API_URL=http://127.0.0.1:4310, SOLANA_RPC_URL=http://127.0.0.1:4312,
 * ALLOW_LOOPBACK_NODE_URLS=true and NODE_ENV=development.
 */

/* eslint-disable no-console */

import { readFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";

import { startFakeNosanaApi, type FakeDeploymentStatus } from "../src/tests/fakeNosanaApi.js";

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new Error(`${name} must be a port between 1024 and 65535`);
  }
  return value;
}

function millis(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be >= 0`);
  return value;
}

function listen(server: Server, listenPort: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: none of this may be reachable from another host.
    server.listen(listenPort, "127.0.0.1", resolve);
  });
}

const stamp = () => new Date().toISOString();

async function main(): Promise<void> {
  const nodePort = port("FAKE_NODE_PORT", 4311);
  const rpcPort = port("FAKE_RPC_PORT", 4312);
  const startMs = millis("FAKE_START_MS", 8_000);
  const stopMs = millis("FAKE_STOP_MS", 3_000);
  const balanceUsd = Number(process.env.FAKE_BALANCE_USD ?? 100);

  const api = await startFakeNosanaApi({
    port: port("FAKE_NOSANA_PORT", 4310),
    ...(process.env.FAKE_NOSANA_KEY ? { apiKey: process.env.FAKE_NOSANA_KEY } : {}),
    balance: { assignedCredits: balanceUsd, reservedCredits: 0, settledCredits: 0 },
  });

  // The inference node: ready on both engines' probe paths, and it answers
  // the platform's load request for its model (one generated token), which
  // is what makes an Ollama deployment "running". Nothing else.
  const nodeModel = process.env.FAKE_NODE_MODEL ?? "llama3.2:3b";
  let probes = 0;
  const answerProbe: RequestListener = (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (path === "/health" || path === "/api/tags" || path === "/api/ps")) {
      probes += 1;
      const loaded = nodeModel ? [{ name: nodeModel, model: nodeModel }] : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(path === "/health" ? { status: "ok" } : { models: loaded }));
      return;
    }
    // The load request of either engine: Ollama's generate route, vLLM's completions route.
    if (req.method === "POST" && (path === "/api/generate" || path === "/v1/completions")) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let asked = "";
        try {
          asked = String((JSON.parse(raw) as { model?: unknown }).model ?? "");
        } catch {
          asked = "";
        }
        // A vLLM deployment asks for its Hugging Face id; this node serves whatever is asked on that route.
        const known =
          path === "/v1/completions"
            ? asked !== ""
            : nodeModel !== "" && asked.toLowerCase() === nodeModel.toLowerCase();
        res.writeHead(known ? 200 : 404, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            known
              ? path === "/v1/completions"
                ? { object: "text_completion", model: asked, choices: [{ index: 0, text: " Hi", finish_reason: "length" }] }
                : { model: nodeModel, response: "Hi", done: true, done_reason: "length" }
              : { error: `model '${asked}' not found` },
          ),
        );
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "the fake node only answers readiness probes and the load request" }));
  };
  const tlsCert = process.env.FAKE_NODE_TLS_CERT;
  const tlsKey = process.env.FAKE_NODE_TLS_KEY;
  const node: Server =
    tlsCert && tlsKey
      ? createTlsServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, answerProbe)
      : createServer(answerProbe);
  await listen(node, nodePort);

  let rpcRequests = 0;
  const rpc = createServer((_req, res) => {
    rpcRequests += 1;
    console.log(`${stamp()} solana-rpc request #${rpcRequests} (the API-key path should make none)`);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "fake Solana RPC" }));
  });
  await listen(rpc, rpcPort);

  // Every write the API makes, without its Authorization header.
  let printed = 0;
  // When each deployment entered the state it is in now.
  const since = new Map<string, { status: FakeDeploymentStatus; at: number }>();
  // Deployments whose job a node has taken in their current run.
  const served = new Set<string>();

  const timer = setInterval(() => {
    for (; printed < api.requests.length; printed += 1) {
      const request = api.requests[printed]!;
      if (request.method !== "GET") {
        console.log(`${stamp()} nosana ${request.method} ${request.path} -> ${request.status}`);
      }
    }
    const now = Date.now();
    for (const deployment of api.deployments.values()) {
      const seen = since.get(deployment.id);
      if (!seen || seen.status !== deployment.status) {
        since.set(deployment.id, { status: deployment.status, at: now });
        console.log(`${stamp()} deployment ${deployment.id} (${deployment.name}) is ${deployment.status}`);
        continue;
      }
      if (deployment.status === "RUNNING" && !served.has(deployment.id) && now - seen.at >= startMs) {
        served.add(deployment.id);
        const job = api.addJob(deployment.id);
        api.setEndpoints(deployment.id, [
          { opId: deployment.endpoints[0]?.opId ?? "inference", port: nodePort, url: `https://127.0.0.1:${nodePort}`, online: true },
        ]);
        console.log(`${stamp()} deployment ${deployment.id}: a node took job ${job.job.slice(0, 8)}...; endpoint online`);
      } else if (deployment.status === "STOPPING" && now - seen.at >= stopMs) {
        api.settle(deployment.id);
        served.delete(deployment.id);
      }
    }
  }, 250);

  console.log(`${stamp()} fake Nosana API   ${api.url}`);
  console.log(
    `${stamp()} fake node         https://127.0.0.1:${nodePort}${tlsCert && tlsKey ? "" : " (advertised; serving plain http, so probes fail)"}`,
  );
  console.log(`${stamp()} fake Solana RPC   http://127.0.0.1:${rpcPort}`);
  console.log(`${stamp()} balance $${balanceUsd}; a node takes a RUNNING job after ${startMs} ms; STOPPING->STOPPED after ${stopMs} ms`);

  const shutdown = async () => {
    clearInterval(timer);
    console.log(
      `${stamp()} stopping: ${api.requests.length} Nosana requests, ${api.vaultCalls()} vault requests, ${probes} node probes, ${rpcRequests} Solana RPC requests`,
    );
    await api.close();
    node.closeAllConnections();
    rpc.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => node.close(resolve)),
      new Promise((resolve) => rpc.close(resolve)),
    ]);
    process.exit(0);
  };
  // Rehearse the platform's credit gate: `kill -USR1 <pid>` empties the
  // account, `kill -USR2 <pid>` fills it again.
  const lowUsd = Number(process.env.FAKE_LOW_BALANCE_USD ?? 1);
  const setBalance = (usd: number) => {
    api.setBalance({ assignedCredits: usd, reservedCredits: 0, settledCredits: 0 });
    console.log(`${stamp()} balance is now $${usd}`);
  };
  process.on("SIGUSR1", () => setBalance(lowUsd));
  process.on("SIGUSR2", () => setBalance(balanceUsd));
  console.log(`${stamp()} pid ${process.pid}`);
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
