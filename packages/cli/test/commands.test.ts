/**
 * The commands themselves, run as the real `wheelsai` process against an HTTP server on
 * this machine, with its own throwaway config directory. This is where the wiring between
 * flags, the config file, the session and the output is pinned; the pieces have their own tests.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_ID, DEPLOYMENT_ID, agent, deployment } from "./helpers.js";

const CLI = fileURLToPath(new URL("../src/index.js", import.meta.url));
const KEY = "wheels_live_e2ekey1234567890";

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}
type Handler = (seen: Seen) => { status?: number; body: unknown };

/** A tiny API: `routes` maps "METHOD /path" to an answer. Everything asked of it is recorded. */
async function startApi(routes: Record<string, Handler | unknown> = {}) {
  const seen: Seen[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (chunk) => (text += String(chunk)));
      req.on("end", () => resolve(text));
    });
  const server: Server = createServer(async (req, res) => {
    const raw = await read(req);
    const entry: Seen = {
      method: req.method ?? "GET",
      path: (req.url ?? "/").split("?")[0]!,
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    };
    seen.push(entry);
    const route = api.routes[`${entry.method} ${entry.path}`];
    const answer =
      route === undefined
        ? { status: 404, body: { error: "NotFound", message: `no route for ${entry.method} ${entry.path}` } }
        : typeof route === "function"
          ? (route as Handler)(entry)
          : { body: route };
    res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    routes: routes as Record<string, Handler | unknown>,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return api;
}

const reply = (status: number, body: unknown): Handler => () => ({ status, body });

describe("wheelsai (the built command)", () => {
  let api: Awaited<ReturnType<typeof startApi>>;
  let other: Awaited<ReturnType<typeof startApi>>;
  let configDir: string;

  before(async () => {
    api = await startApi();
    other = await startApi();
  });
  after(async () => {
    await api.close();
    await other.close();
  });
  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "wheelsai-cli-"));
    api.routes = { "GET /api/auth/me": { authType: "api_key", user: { id: "", email: null }, organization: { id: "org-1" } } };
    api.seen.length = 0;
    other.routes = {};
    other.seen.length = 0;
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  /** Run the CLI. Nothing of the developer's own WHEELSAI_* environment or config leaks in. */
  function wheelsai(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { PATH: process.env.PATH ?? "", HOME: configDir, WHEELSAI_CONFIG_DIR: configDir, NO_COLOR: "1", ...options.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(options.stdin ?? "");
    });
  }
  const configFile = () => path.join(configDir, "config.json");
  const saved = () => JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, string>;
  const login = () => wheelsai(["login", "--url", api.url, "--api-key-stdin"], { stdin: `${KEY}\n` });

  describe("login", () => {
    it("takes the API key from stdin, checks it, and saves it bound to that API URL in a private file", async () => {
      const result = await login();
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(api.seen.map((s) => [s.method, s.path, s.authorization]), [["GET", "/api/auth/me", `Bearer ${KEY}`]]);
      assert.equal(saved().apiKey, KEY);
      assert.equal(saved().credentialUrl, api.url);
      assert.equal(saved().apiUrl, api.url);
      assert.equal(statSync(configFile()).mode & 0o777, 0o600);
      assert.equal(statSync(configDir).mode & 0o777, 0o700);
      assert.doesNotMatch(result.stdout + result.stderr, /wheels_live_/, "the key is never printed back");
      assert.match(result.stderr, new RegExp(`API key saved for ${api.url}, organization org-1`));
    });

    it("saves nothing when the API rejects the key, and says what to check", async () => {
      api.routes["GET /api/auth/me"] = reply(401, { error: "Unauthorized", message: "Invalid API key" });
      const result = await login();
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Invalid API key \(HTTP 401\)/);
      assert.match(result.stderr, /Check the key, and that .* is the API it belongs to/);
      assert.doesNotMatch(result.stderr, /Run `wheelsai login`/, "not the stale-session advice");
      assert.equal(saved().apiKey ?? "", "", "the key was checked before anything was saved");
      assert.equal(saved().credentialUrl ?? "", "");
    });

    it("keeps a working login when a later attempt with a bad key fails", async () => {
      await login();
      api.routes["GET /api/auth/me"] = reply(401, { error: "Unauthorized", message: "Invalid API key" });
      const result = await wheelsai(["login", "--url", api.url, "--api-key-stdin"], { stdin: "wheels_live_wrong\n" });
      assert.equal(result.code, 1);
      assert.equal(saved().apiKey, KEY);
    });

    it("refuses to send a credential anywhere when no API URL was ever chosen", async () => {
      const result = await wheelsai(["login", "--api-key-stdin"], { stdin: `${KEY}\n` });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /No API URL is set/);
      assert.match(result.stderr, /Pass --url <api-url>/);
      assert.equal(api.seen.length, 0);
    });

    it("refuses a key with a line break or other junk without echoing it or calling the API", async () => {
      for (const bad of ["wheels_live_SECRET X\n", "not-a-key\n", "wheels_live_SEC\u0000RET\n"]) {
        const result = await wheelsai(["login", "--url", api.url, "--api-key-stdin"], { stdin: bad });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /That is not a WheelsAI API key/);
        assert.doesNotMatch(result.stdout + result.stderr, /SECRET|SEC/);
      }
      assert.equal(api.seen.length, 0);
    });

    it("still accepts --api-key on the command line, but warns where that leaves the key", async () => {
      const result = await wheelsai(["login", "--url", api.url, "--api-key", KEY]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /--api-key is visible in your shell history and to other users in the process list/);
      assert.equal(saved().apiKey, KEY);
    });

    it("signs in with email and a password from stdin, and saves the session bound to the URL", async () => {
      api.routes["POST /api/auth/login"] = { token: "jwt.session.token", user: { id: "u1", email: "you@example.com" }, organization: { id: "org-1", name: "Acme" } };
      const result = await wheelsai(["login", "--url", api.url, "--email", "you@example.com", "--password-stdin"], { stdin: " pass word \n" });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(api.seen[0]?.body, { email: "you@example.com", password: " pass word " });
      assert.equal(saved().token, "jwt.session.token");
      assert.equal(saved().apiKey, "");
      assert.equal(saved().credentialUrl, api.url);
      assert.match(result.stderr, /Signed in to .* as you@example\.com \(organization Acme\)/);
    });

    it("asks for --password-stdin (never the command line) when there is no terminal to ask on", async () => {
      const result = await wheelsai(["login", "--url", api.url, "--email", "you@example.com"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /pipe it in with --password-stdin, or set WHEELSAI_PASSWORD/);
      assert.equal(api.seen.length, 0);
    });

    it("rejects a URL that is not one, and warns on plain http to another machine", async () => {
      const bad = await wheelsai(["login", "--url", "api.example.com", "--api-key-stdin"], { stdin: `${KEY}\n` });
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /--url is not a URL/);

      const insecure = await wheelsai(["config", "set", "apiUrl", "http://api.example.com"]);
      assert.equal(insecure.code, 0);
      assert.match(insecure.stderr, /http:\/\/api\.example\.com is plain http: .* unencrypted/);
      const local = await wheelsai(["config", "set", "apiUrl", "http://localhost:4000"]);
      assert.doesNotMatch(local.stderr, /plain http/);
      const refused = await wheelsai(["config", "set", "apiUrl", "ftp://example.com"]);
      assert.equal(refused.code, 1);
      assert.equal(saved().apiUrl, "http://localhost:4000", "a refused value is not saved");
    });

    it("warns when the environment will override what was just saved", async () => {
      const result = await wheelsai(["login", "--url", api.url, "--api-key-stdin"], { stdin: `${KEY}\n`, env: { WHEELSAI_API_KEY: "wheels_live_fromenv" } });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /WHEELSAI_API_KEY \/ WHEELSAI_TOKEN in your environment override this saved login/);
    });
  });

  describe("a saved credential never goes to another host", () => {
    beforeEach(async () => {
      await login();
      api.seen.length = 0;
    });

    it("is not sent after `config set apiUrl` points at a different server", async () => {
      const set = await wheelsai(["config", "set", "apiUrl", other.url]);
      assert.match(set.stderr, /saved credentials are for .* and will not be sent/);
      const result = await wheelsai(["whoami"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(`saved credentials are for ${api.url}, so they were not sent to ${other.url}`));
      assert.equal(other.seen.length, 0, "the other server never saw a request, let alone the key");
    });

    it("is not sent after `login --url` (URL only) points at a different server", async () => {
      const set = await wheelsai(["login", "--url", other.url]);
      assert.equal(set.code, 0);
      assert.match(set.stderr, /will not be sent to/);
      assert.equal((await wheelsai(["agents", "list"])).code, 1);
      assert.equal(other.seen.length, 0);
    });

    it("is not sent to a WHEELSAI_API_URL from the environment", async () => {
      const result = await wheelsai(["agents", "list"], { env: { WHEELSAI_API_URL: other.url } });
      assert.equal(result.code, 1);
      assert.equal(other.seen.length, 0);
      assert.equal(api.seen.length, 0);
    });

    it("is still used on the server it was issued for", async () => {
      const result = await wheelsai(["whoami", "--json"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(api.seen[0]?.authorization, `Bearer ${KEY}`);
      assert.equal(JSON.parse(result.stdout).organization.id, "org-1");
    });

    it("an environment credential goes where the environment's URL points", async () => {
      other.routes["GET /api/auth/me"] = { authType: "api_key", user: { id: "" }, organization: { id: "org-ci" } };
      const result = await wheelsai(["whoami", "--json"], { env: { WHEELSAI_API_URL: other.url, WHEELSAI_API_KEY: "wheels_live_ci" } });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(other.seen[0]?.authorization, "Bearer wheels_live_ci");
    });
  });

  describe("logout", () => {
    const signIn = async () => {
      api.routes["POST /api/auth/login"] = { token: "jwt.session.token", user: { id: "u1", email: "you@example.com" }, organization: { id: "org-1", name: "Acme" } };
      await wheelsai(["login", "--url", api.url, "--email", "you@example.com", "--password-stdin"], { stdin: "pw\n" });
      api.seen.length = 0;
    };

    it("revokes the session on the server that issued it, whatever URL is in effect, and forgets it", async () => {
      await signIn();
      api.routes["POST /api/auth/logout"] = { message: "Logged out" };
      const result = await wheelsai(["logout"], { env: { WHEELSAI_API_URL: other.url } });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(api.seen.map((s) => [s.path, s.authorization]), [["/api/auth/logout", "Bearer jwt.session.token"]]);
      assert.equal(other.seen.length, 0);
      assert.equal(saved().token, "");
      assert.equal(saved().credentialUrl, "");
    });

    it("says so when the session could not be revoked", async () => {
      await signIn();
      api.routes["POST /api/auth/logout"] = reply(500, { error: "InternalError", message: "Internal Server Error" });
      const result = await wheelsai(["logout"]);
      assert.equal(result.code, 0);
      assert.match(result.stderr, /Could not revoke the session on .* \(Internal Server Error\)\. It stays valid until it expires\./);
      assert.equal(saved().token, "", "the local logout still happened");
    });
  });

  describe("a malformed config file", () => {
    it("fails every command with one clear line, not a stack trace quoting the file", async () => {
      writeFileSync(configFile(), `{"apiUrl": "${api.url}", "apiKey": "${KEY}", `);
      for (const args of [["config", "show"], ["whoami"], ["logout"], ["agents", "list", "--json"]]) {
        const result = await wheelsai(args);
        assert.equal(result.code, 1, args.join(" "));
        assert.ok(result.stderr.includes(`The config file ${configFile()} is not valid JSON`), result.stderr);
        assert.match(result.stderr, /Fix the file or delete it/);
        assert.doesNotMatch(result.stderr, /wheels_live_|SyntaxError|\n\s+at /, args.join(" "));
        assert.equal(result.stdout, "");
      }
    });
  });

  describe("deploy", () => {
    const AGENT_PATH = `/api/agents/${AGENT_ID}`;
    const deployRoutes = (): Record<string, Handler | unknown> => ({
      "GET /api/agents": { agents: [agent()], total: 1 },
      [`GET ${AGENT_PATH}/graph`]: reply(404, { success: false, error: "The request could not be completed." }),
      "GET /api/models": { models: [], gpuTiers: [{ id: "3060", name: "NVIDIA 3060", vram: 12, pricePerHour: 0.2 }] },
      [`POST ${AGENT_PATH}/deploy`]: reply(201, { deployment: { id: DEPLOYMENT_ID, status: "pending" }, message: "Agent deployment started" }),
      [`GET ${AGENT_PATH}/deployments/${DEPLOYMENT_ID}`]: { deployment: deployment({ status: "running", endpoint: "https://api.example.test/v1/agents/my-support-bot/chat/completions" }) },
      "GET /api/openclaw": { deployments: [] },
    });
    const deployPosts = () => api.seen.filter((s) => s.method === "POST" && s.path === `${AGENT_PATH}/deploy`);

    beforeEach(async () => {
      await login();
      Object.assign(api.routes, deployRoutes());
      api.seen.length = 0;
    });

    it("accepts the form shown on the landing page: wheelsai deploy --agent my-support-bot", async () => {
      const result = await wheelsai(["deploy", "--agent", "my-support-bot"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(deployPosts().length, 1);
      assert.deepEqual(deployPosts()[0]?.body, { gpuTier: "3060", replicas: 1 });
      assert.match(result.stdout, /Agent live!/);
      assert.match(result.stdout, new RegExp(`Deployment\\s+${DEPLOYMENT_ID}`));
      // The agent's /v1 URL on the API, as the API returned it, plus what an OpenAI client needs.
      assert.match(result.stdout, /Endpoint\s+https:\/\/api\.example\.test\/v1\/agents\/my-support-bot\/chat\/completions\n/);
      assert.match(result.stdout, /OpenAI base\s+https:\/\/api\.example\.test\/v1\/agents\/my-support-bot\n/);
      assert.match(result.stdout, /Model\s+agent\/my-support-bot\n/);
      assert.match(result.stdout, /Channels\s+none reported by the API/);
      assert.doesNotMatch(result.stdout, /Listed on the marketplace/, "listing needs --publish");
    });

    it("takes the agent as a bare argument too, and prints one JSON document with --json", async () => {
      const result = await wheelsai(["deploy", "my-support-bot", "--json"]);
      assert.equal(result.code, 0, result.stderr);
      const document = JSON.parse(result.stdout);
      assert.equal(document.deployment.id, DEPLOYMENT_ID);
      assert.equal(document.endpoint, "https://api.example.test/v1/agents/my-support-bot/chat/completions");
      assert.equal(document.openaiBaseUrl, "https://api.example.test/v1/agents/my-support-bot");
      assert.equal(document.openaiModel, "agent/my-support-bot");
      assert.deepEqual(document.agent, { id: AGENT_ID, slug: "my-support-bot", name: "My Support Bot" });
    });

    it("prints 'none returned by the API' when the API has no public address, and invents no OpenAI base", async () => {
      api.routes["GET /api/agents"] = { agents: [agent({ apiEndpoint: null, openaiBaseUrl: null })], total: 1 };
      api.routes[`GET ${AGENT_PATH}/deployments/${DEPLOYMENT_ID}`] = { deployment: deployment({ status: "running", endpoint: null }) };
      const result = await wheelsai(["deploy", "--agent", "my-support-bot"]);
      assert.match(result.stdout, /Endpoint\s+none returned by the API/);
      assert.doesNotMatch(result.stdout, /OpenAI base/);
      assert.doesNotMatch(result.stdout, /\/v1\/agents/);
    });

    it("with --json, a failure after the deployment exists still puts its id on stdout", async () => {
      api.routes[`GET ${AGENT_PATH}/deployments/${DEPLOYMENT_ID}`] = reply(401, { error: "Unauthorized", message: "Authentication required" });
      const result = await wheelsai(["deploy", "--agent", "my-support-bot", "--json"]);
      assert.equal(result.code, 1);
      assert.deepEqual(JSON.parse(result.stdout), {
        agent: { id: AGENT_ID, slug: "my-support-bot", name: "My Support Bot" },
        deployment: { id: DEPLOYMENT_ID, status: "pending" },
        error: { message: "Authentication required", status: 401, code: "Unauthorized" },
      });
      assert.ok(result.stderr.includes(`Deployment ${DEPLOYMENT_ID} exists and carries on`), result.stderr);
      assert.ok(result.stderr.includes(`--resume ${DEPLOYMENT_ID}`));
      assert.match(result.stderr, /HTTP 401 Unauthorized/);
    });

    it("without --json, the same failure names the deployment on stderr", async () => {
      api.routes[`GET ${AGENT_PATH}/deployments/${DEPLOYMENT_ID}`] = reply(404, { error: "NotFound", message: "Deployment not found" });
      const result = await wheelsai(["deploy", "--agent", "my-support-bot"]);
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes(`wheelsai logs ${DEPLOYMENT_ID} --agent my-support-bot`), result.stderr);
      assert.doesNotMatch(result.stdout, /Agent live!/);
    });

    it("--resume waits for the existing deployment without a second POST", async () => {
      const result = await wheelsai(["deploy", "--agent", "my-support-bot", "--resume", DEPLOYMENT_ID, "--json"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(deployPosts().length, 0);
      assert.equal(JSON.parse(result.stdout).deployment.id, DEPLOYMENT_ID);
    });

    it("--publish refuses listing values the API would reject before a single request is made", async () => {
      for (const flags of [
        ["--price-per-request", "0"],
        ["--monthly", "50"],
        ["--title", "ab"],
        ["--description", "short"],
        ["--category", "finance"],
        ["--free", "--tokenized"],
      ]) {
        api.seen.length = 0;
        const result = await wheelsai(["deploy", "--agent", "my-support-bot", "--publish", ...flags]);
        assert.equal(result.code, 1, flags.join(" "));
        assert.equal(api.seen.length, 0, `${flags.join(" ")}: nothing was requested, so no GPU and no credits`);
      }
    });

    it("--publish with an agent name the API would refuse as a title stops before the deploy", async () => {
      api.routes["GET /api/agents"] = { agents: [agent({ name: "AB" })], total: 1 };
      api.routes["GET /api/marketplace/my-listings"] = { listings: [] };
      const result = await wheelsai(["deploy", "--agent", "my-support-bot", "--publish"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /"AB" is not 3 to 100 characters/);
      assert.equal(deployPosts().length, 0);
    });

    it("rejects listing flags without --publish, and a --resume that is not an id", async () => {
      assert.equal((await wheelsai(["deploy", "--agent", "my-support-bot", "--title", "Support Pro"])).code, 1);
      assert.equal((await wheelsai(["deploy", "--agent", "my-support-bot", "--resume", "latest"])).code, 1);
      assert.equal(api.seen.length, 0);
    });

    it("defaults to checking status every 30 seconds, the pace the API refreshes it at", async () => {
      const help = await wheelsai(["deploy", "--help"]);
      assert.match(help.stdout, /--interval <seconds>[\s\S]*\(default: "30"\)/);
      assert.match(help.stdout, /--resume <deployment-id>/);
    });
  });

  describe("test", () => {
    beforeEach(async () => {
      await login();
      api.routes["GET /api/agents"] = { agents: [agent()], total: 1 };
      api.seen.length = 0;
    });
    const chat = (extra: Record<string, unknown>) => ({
      content: "Hello there.",
      model: "free/groq/llama-3.3-70b",
      usage: { inputTokens: 12, outputTokens: 5 },
      toolCalls: [],
      billing: null,
      retrieval: null,
      ...extra,
    });

    it("shows the per-request marketplace charge the API reports", async () => {
      api.routes[`POST /api/agents/${AGENT_ID}/playground/chat`] = chat({ billing: { listingTitle: "Support Pro", chargedCents: 25, creatorCents: 20 } });
      const result = await wheelsai(["test", "my-support-bot"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Charged: \$0\.25 for this request \(marketplace listing "Support Pro"\)/);
      assert.match(result.stdout, /Tokens:\s+12 in \/ 5 out/);
    });

    it("shows no charge line when the API reports no billing", async () => {
      api.routes[`POST /api/agents/${AGENT_ID}/playground/chat`] = chat({});
      const result = await wheelsai(["test", "my-support-bot"]);
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /Charged/);
    });

    it("keeps the model's output from driving the terminal", async () => {
      api.routes[`POST /api/agents/${AGENT_ID}/playground/chat`] = chat({
        content: "safe\u001b]52;c;ZXZpbA==\u0007 text\u001b[1A\u001b[2K",
        model: "m\u001b[31m",
        billing: { listingTitle: "T\u001b[0m", chargedCents: 1, creatorCents: 1 },
      });
      const result = await wheelsai(["test", "my-support-bot"]);
      assert.equal(result.code, 0, result.stderr);
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(result.stdout, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, "no control characters reach stdout");
      assert.match(result.stdout, /safe\]52;c;ZXZpbA== text/);
      const json = await wheelsai(["test", "my-support-bot", "--json"]);
      assert.equal(JSON.parse(json.stdout).content, "safe\u001b]52;c;ZXZpbA==\u0007 text\u001b[1A\u001b[2K", "--json stays exact (JSON escapes it)");
    });

    it("strips control characters from an API error message as well", async () => {
      api.routes[`POST /api/agents/${AGENT_ID}/playground/chat`] = reply(500, { error: "InternalError", message: "boom\u001b[2K\u0007" });
      const result = await wheelsai(["test", "my-support-bot"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /boom\[2K/);
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(result.stderr, /[\u0007\u001b]/);
    });
  });

  describe("logs", () => {
    const MODEL_DEPLOYMENT = "88888888-8888-4888-8888-888888888888";
    beforeEach(async () => {
      await login();
      api.routes["GET /api/agents"] = { agents: [agent({ latestDeployment: { id: DEPLOYMENT_ID, status: "deploying", endpoint: null, createdAt: "x" } })], total: 1 };
      api.seen.length = 0;
    });

    it("shows an agent deployment, and does not present its endpoint as live before it runs", async () => {
      api.routes[`GET /api/agents/${AGENT_ID}/deployments/${DEPLOYMENT_ID}`] = { deployment: deployment({ status: "deploying", endpoint: "https://api.example.test/v1/agents/my-support-bot/chat/completions" }) };
      api.routes[`GET /api/agents/${AGENT_ID}/deployments/${DEPLOYMENT_ID}/logs`] = { logs: "No logs available", error: null };
      const result = await wheelsai(["logs", DEPLOYMENT_ID]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Agent deployment my-support-bot/);
      assert.match(result.stdout, /Endpoint\s+https:\/\/api\.example\.test\/v1\/agents\/my-support-bot\/chat\/completions \(not live: the deployment is deploying\)/);
      assert.match(result.stdout, /No logs available/);

      api.routes[`GET /api/agents/${AGENT_ID}/deployments/${DEPLOYMENT_ID}`] = { deployment: deployment({ status: "running", endpoint: "https://api.example.test/v1/agents/my-support-bot/chat/completions" }) };
      const running = await wheelsai(["logs", DEPLOYMENT_ID]);
      assert.match(running.stdout, /Endpoint\s+https:\/\/api\.example\.test\/v1\/agents\/my-support-bot\/chat\/completions\n/);
    });

    it("falls back to a model deployment, and still shows it (exit 1) when its events cannot be read", async () => {
      api.routes[`GET /api/deployments/${MODEL_DEPLOYMENT}`] = {
        deployment: { id: MODEL_DEPLOYMENT, name: "my-chat", status: "running", statusReason: null, engine: "vllm", gpuTier: "3060", replicas: 1, endpoint: null, model: { id: "m", displayName: "Llama 3" }, nodes: [{ id: "n", deploymentId: MODEL_DEPLOYMENT, healthStatus: "healthy", latencyMs: 10 }] },
      };
      api.routes[`GET /api/deployments/${MODEL_DEPLOYMENT}/logs`] = reply(502, { error: "nosana_unavailable", message: "Nosana could not be reached" });
      const result = await wheelsai(["logs", MODEL_DEPLOYMENT, "--model"]);
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Model deployment my-chat/);
      assert.match(result.stdout, /Nodes\s+1\/1 healthy/);
      assert.match(result.stdout, /Unavailable: Nosana could not be reached/);
      assert.match(result.stdout, /HTTP 502 nosana_unavailable/);
      assert.equal(api.seen.filter((s) => s.path.startsWith("/api/agents")).length, 0, "--model skips the agent search");
    });

    it("makes a model deployment's host-relative endpoint absolute against the API it talks to", async () => {
      api.routes[`GET /api/deployments/${MODEL_DEPLOYMENT}`] = {
        deployment: { id: MODEL_DEPLOYMENT, name: "my-chat", status: "running", statusReason: null, engine: "vllm", gpuTier: "3060", replicas: 1, endpoint: "/v1/my-chat/chat/completions", model: { id: "m", displayName: "Llama 3" }, nodes: [] },
      };
      api.routes[`GET /api/deployments/${MODEL_DEPLOYMENT}/logs`] = { logs: [], note: "events" };
      const result = await wheelsai(["logs", MODEL_DEPLOYMENT, "--model"]);
      assert.ok(result.stdout.includes(`${api.url}/v1/my-chat/chat/completions`), result.stdout);
    });

    it("agents get shows the agent's API endpoint, OpenAI base URL and model id as the API returned them", async () => {
      const detail = {
        ...agent(),
        orgId: "o",
        systemPrompt: null,
        tools: [],
        modelConfig: { externalModel: "free/groq/llama-3.3-70b", temperature: 0.7, maxTokens: 4096 },
        sourceType: "inline",
        sourceUrl: null,
        sourceCode: null,
        env: { keys: [] },
        knowledgeBaseId: null,
        deployments: [],
      };
      api.routes[`GET /api/agents/${AGENT_ID}`] = { agent: detail };
      const shown = await wheelsai(["agents", "get", "my-support-bot"]);
      assert.equal(shown.code, 0, shown.stderr);
      assert.match(shown.stdout, /API\s+https:\/\/api\.example\.test\/v1\/agents\/my-support-bot\/chat\/completions\n/);
      assert.match(shown.stdout, /OpenAI base\s+https:\/\/api\.example\.test\/v1\/agents\/my-support-bot\n/);
      assert.match(shown.stdout, /Model id\s+agent\/my-support-bot\n/);

      api.routes[`GET /api/agents/${AGENT_ID}`] = { agent: { ...detail, apiEndpoint: null, openaiBaseUrl: null } };
      const unset = await wheelsai(["agents", "get", "my-support-bot"]);
      assert.match(unset.stdout, /API\s+not configured on the API \(PUBLIC_API_URL is not set\)/);
      assert.doesNotMatch(unset.stdout, /OpenAI base/);
    });

    it("refuses --model with --agent, an id that is not a UUID, and --lines below 10, before any request", async () => {
      assert.equal((await wheelsai(["logs", DEPLOYMENT_ID, "--model", "--agent", "my-support-bot"])).code, 1);
      assert.equal((await wheelsai(["logs", "latest"])).code, 1);
      assert.equal((await wheelsai(["logs", DEPLOYMENT_ID, "--lines", "5"])).code, 1);
      assert.equal(api.seen.length, 0);
    });
  });
});
