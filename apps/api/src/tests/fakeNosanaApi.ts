/**
 * A fake Nosana REST API for tests and rehearsals: an in-process HTTP server on
 * loopback that answers what the installed @nosana/sdk (0.4.74) calls with an
 * API key, so the REAL SDK client can be driven end to end with no network.
 *
 *   const fake = await startFakeNosanaApi({ apiKey: "nos_test_..." });
 *   new Client("mainnet", keypair, { apiKey, api: { backend_url: fake.url } });
 *
 * Implemented (paths and bodies from node_modules/@nosana/sdk/dist/client/schema.d.ts):
 *   POST  /api/deployments/create
 *   GET   /api/deployments
 *   GET   /api/deployments/{id}
 *   POST  /api/deployments/{id}/start | stop | archive
 *   PATCH /api/deployments/{id}/update-timeout | update-replica-count
 *   GET   /api/deployments/{id}/tasks
 *   GET   /api/deployments/{id}/jobs/{job}
 *   GET   /api/credits/balance
 *   GET   /api/markets/            (public: no Authorization needed)
 *
 * Every other route is a 404; the vault routes are counted (`vaultCalls`) so a
 * test can prove the API-key path never asked for one.
 *
 * What it is NOT: a model of Nosana's real behaviour. State transitions happen
 * only when a test scripts them (`setStatus`, `settle`) and the answers to
 * questions nobody has measured (does a DRAFT accept a stop, when are credits
 * reserved) are whatever the test sets. Nothing observed here says anything
 * about the live service.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeDeploymentStatus =
  | "DRAFT"
  | "ERROR"
  | "STARTING"
  | "RUNNING"
  | "STOPPING"
  | "STOPPED"
  | "INSUFFICIENT_FUNDS"
  | "ARCHIVED";

export interface FakeDeployment {
  id: string;
  name: string;
  vault: string;
  market: string;
  owner: string;
  status: FakeDeploymentStatus;
  replicas: number;
  /** Stored exactly as it was sent: the unit is the caller's business. */
  timeout: number;
  strategy: string;
  confidential: boolean;
  active_revision: number;
  jobs: Array<{ job: string; status: string; tx: string; deployment: string; revision: number; created_at: string }>;
  events: Array<{ category: string; deploymentId: string; type: string; message: string; created_at: string }>;
  endpoints: Array<{ opId: string; port: number; url: string }>;
  created_at: string;
  updated_at: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
  status: number;
}

export interface FakeBalance {
  assignedCredits: number;
  reservedCredits: number;
  settledCredits: number;
}

export interface FakeNosanaApiOptions {
  /** The only key the fake accepts. Default "nos_fake_key_for_tests_0001". */
  apiKey?: string;
  /** Listen port. Default 0 (ephemeral); a rehearsal script passes a fixed one. */
  port?: number;
  /** `owner` (and `vault`) of every deployment. Default: a valid base58 key. */
  owner?: string;
  balance?: FakeBalance;
  /** Body of GET /api/markets/. Default: two PREMIUM markets. */
  markets?: unknown[];
}

export interface FakeNosanaApi {
  url: string;
  port: number;
  apiKey: string;
  requests: FakeRequest[];
  deployments: Map<string, FakeDeployment>;
  /** Requests under /api/deployments/vaults (must stay 0 with an API key). */
  vaultCalls(): number;
  setBalance(balance: FakeBalance): void;
  setMarkets(markets: unknown[]): void;
  /** Replace the accepted key: every request with the old one answers 401. */
  rotateApiKey(next: string): void;
  /** `owner` of deployments created or read from now on (e.g. a non-base58 string). */
  setOwner(owner: string): void;
  setStatus(id: string, status: FakeDeploymentStatus): void;
  /** STARTING -> RUNNING, STOPPING -> STOPPED; anything else is left alone. */
  settle(id: string): void;
  setEndpoints(id: string, endpoints: FakeDeployment["endpoints"]): void;
  /** Body GET /api/deployments/{id}/jobs/{job} answers with. */
  setJob(id: string, job: string, body: unknown): void;
  /** When true, a start answers STARTING and the deployment becomes INSUFFICIENT_FUNDS. */
  setInsufficientFunds(on: boolean): void;
  /** The next `times` requests matching method + path answer with this instead. */
  failNext(match: { method?: string; path: RegExp }, response: { status: number; body: unknown }, times?: number): void;
  close(): Promise<void>;
}

/** A syntactically valid base58 public key (the System Program id). */
export const FAKE_OWNER = "11111111111111111111111111111111";

export const FAKE_MARKETS: unknown[] = [
  {
    address: "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq",
    slug: "nvidia-3060",
    name: "NVIDIA 3060",
    type: "PREMIUM",
    usd_reward_per_hour: 0.0436,
    nos_reward_per_second: 0.00002,
    nos_job_price_per_second: 0.000022,
    network_fee_percentage: 10,
  },
  {
    address: "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf",
    slug: "nvidia-4090",
    name: "NVIDIA 4090",
    type: "PREMIUM",
    usd_reward_per_hour: 0.3636,
    nos_reward_per_second: 0.000167,
    nos_job_price_per_second: 0.000184,
    network_fee_percentage: 10,
  },
];

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startFakeNosanaApi(options: FakeNosanaApiOptions = {}): Promise<FakeNosanaApi> {
  let apiKey = options.apiKey ?? "nos_fake_key_for_tests_0001";
  let owner = options.owner ?? FAKE_OWNER;
  let balance: FakeBalance = options.balance ?? {
    assignedCredits: 100,
    reservedCredits: 0,
    settledCredits: 0,
  };
  let insufficientFunds = false;
  let sequence = 0;
  let vaultCalls = 0;
  let markets = options.markets ?? FAKE_MARKETS;
  const deployments = new Map<string, FakeDeployment>();
  const jobs = new Map<string, unknown>();
  const requests: FakeRequest[] = [];
  const scripted: Array<{ method?: string; path: RegExp; status: number; body: unknown; left: number }> = [];

  const now = () => new Date().toISOString();
  const view = (d: FakeDeployment) => ({ ...d, owner, vault: owner });
  const event = (d: FakeDeployment, type: string, message: string) => {
    d.events.push({ category: "Deployment", deploymentId: d.id, type, message, created_at: now() });
    d.updated_at = now();
  };

  function route(method: string, path: string, body: unknown): { status: number; body: unknown } {
    if (method === "GET" && /^\/api\/markets\/?$/.test(path)) return { status: 200, body: markets };

    if (path === "/api/credits/balance" && method === "GET") return { status: 200, body: balance };

    if (path.startsWith("/api/deployments/vaults")) {
      vaultCalls += 1;
      return { status: 404, body: { error: "Not found" } };
    }

    if (path === "/api/deployments/create" && method === "POST") {
      const b = (body ?? {}) as Record<string, unknown>;
      if (
        typeof b.name !== "string" ||
        typeof b.market !== "string" ||
        typeof b.replicas !== "number" ||
        b.replicas < 1 ||
        typeof b.timeout !== "number" ||
        b.timeout < 1 ||
        b.job_definition === undefined
      ) {
        return { status: 400, body: { error: "Invalid request body" } };
      }
      sequence += 1;
      const id = `fakedm${String(sequence).padStart(4, "0")}`;
      const created = now();
      const deployment: FakeDeployment = {
        id,
        name: b.name,
        vault: owner,
        market: b.market,
        owner,
        status: "DRAFT",
        replicas: b.replicas,
        timeout: b.timeout,
        strategy: typeof b.strategy === "string" ? b.strategy : "SIMPLE",
        confidential: b.confidential === true,
        active_revision: 1,
        jobs: [],
        events: [],
        endpoints: [],
        created_at: created,
        updated_at: created,
      };
      deployments.set(id, deployment);
      return { status: 200, body: view(deployment) };
    }

    if (path === "/api/deployments" && method === "GET") {
      return { status: 200, body: [...deployments.values()].map(view) };
    }

    const match = /^\/api\/deployments\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (!match) return { status: 404, body: { error: "Not found" } };
    const deployment = deployments.get(decodeURIComponent(match[1]!));
    if (!deployment) return { status: 404, body: { error: "Deployment not found" } };
    const action = match[2];

    if (action === undefined && method === "GET") return { status: 200, body: view(deployment) };

    if (action === "start" && method === "POST") {
      if (deployment.status === "STARTING" || deployment.status === "RUNNING") {
        return { status: 400, body: { error: "Deployment is already running" } };
      }
      deployment.status = insufficientFunds ? "INSUFFICIENT_FUNDS" : "STARTING";
      event(deployment, "start", "start requested");
      return { status: 200, body: { status: "STARTING", updated_at: deployment.updated_at } };
    }

    if (action === "stop" && method === "POST") {
      if (deployment.status === "STOPPING" || deployment.status === "STOPPED" || deployment.status === "ARCHIVED") {
        return { status: 400, body: { error: "Deployment is already stopped" } };
      }
      deployment.status = "STOPPING";
      event(deployment, "stop", "stop requested");
      return { status: 200, body: { status: "STOPPING", updated_at: deployment.updated_at } };
    }

    if (action === "archive" && method === "POST") {
      if (deployment.status !== "STOPPED") {
        return { status: 400, body: { error: "Deployment must be stopped before archiving" } };
      }
      deployment.status = "ARCHIVED";
      event(deployment, "archive", "archived");
      return { status: 200, body: { status: "ARCHIVED", updated_at: deployment.updated_at } };
    }

    if (action === "update-timeout" && method === "PATCH") {
      const timeout = (body as { timeout?: unknown } | undefined)?.timeout;
      if (typeof timeout !== "number" || timeout < 60) {
        return { status: 400, body: { error: "Invalid timeout" } };
      }
      deployment.timeout = timeout;
      deployment.updated_at = now();
      return { status: 200, body: { timeout, updated_at: deployment.updated_at } };
    }

    if (action === "update-replica-count" && method === "PATCH") {
      const replicas = (body as { replicas?: unknown } | undefined)?.replicas;
      if (typeof replicas !== "number" || replicas < 1) {
        return { status: 400, body: { error: "Invalid replica count" } };
      }
      deployment.replicas = replicas;
      deployment.updated_at = now();
      return { status: 200, body: { replicas, updated_at: deployment.updated_at } };
    }

    if (action === "tasks" && method === "GET") return { status: 200, body: [] };

    const jobMatch = action ? /^jobs\/([^/]+)$/.exec(action) : null;
    if (jobMatch && method === "GET") {
      const job = jobs.get(`${deployment.id}/${decodeURIComponent(jobMatch[1]!)}`);
      return job === undefined
        ? { status: 404, body: { error: "Job not found" } }
        : { status: 200, body: job };
    }

    return { status: 404, body: { error: "Not found" } };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://fake.local").pathname;
    const authorization = req.headers.authorization;
    const body = await readBody(req);

    let answer: { status: number; body: unknown };
    const isPublic = method === "GET" && /^\/api\/markets(\/|$)/.test(path);
    const script = scripted.find(
      (s) => s.left > 0 && (s.method === undefined || s.method === method) && s.path.test(path),
    );
    if (!isPublic && authorization !== `Bearer ${apiKey}`) {
      // The real API's 401 body is the bare JSON string "Unauthorized".
      answer = { status: 401, body: "Unauthorized" };
    } else if (script) {
      script.left -= 1;
      answer = { status: script.status, body: script.body };
    } else {
      answer = route(method, path, body);
    }

    requests.push({ method, path, authorization, body, status: answer.status });
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  // Loopback only: this server must never be reachable from another host.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  const mustGet = (id: string): FakeDeployment => {
    const deployment = deployments.get(id);
    if (!deployment) throw new Error(`fake Nosana API: no deployment ${id}`);
    return deployment;
  };

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get apiKey() {
      return apiKey;
    },
    requests,
    deployments,
    vaultCalls: () => vaultCalls,
    setBalance: (next) => {
      balance = next;
    },
    setMarkets: (next) => {
      markets = next;
    },
    rotateApiKey: (next) => {
      apiKey = next;
    },
    setOwner: (next) => {
      owner = next;
    },
    setStatus: (id, status) => {
      mustGet(id).status = status;
    },
    settle: (id) => {
      const deployment = mustGet(id);
      if (deployment.status === "STARTING") deployment.status = "RUNNING";
      else if (deployment.status === "STOPPING") deployment.status = "STOPPED";
    },
    setEndpoints: (id, endpoints) => {
      mustGet(id).endpoints = endpoints;
    },
    setJob: (id, job, body) => {
      jobs.set(`${id}/${job}`, body);
    },
    setInsufficientFunds: (on) => {
      insufficientFunds = on;
    },
    failNext: (match, response, times = 1) => {
      scripted.push({ ...match, ...response, left: times });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A loopback server that counts every request and answers 500. Pointed at as
 * the Solana RPC, it proves a code path made no RPC call.
 */
export async function startRequestCounter(): Promise<{ url: string; count(): number; close(): Promise<void> }> {
  let count = 0;
  const server = createServer((_req, res) => {
    count += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no request was expected here" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    count: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
