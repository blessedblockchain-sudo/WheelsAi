/**
 * A fake Nosana REST API for tests and rehearsals: an in-process HTTP server on
 * loopback that answers what the installed @nosana/sdk (0.4.74) and our own
 * direct reads call with an API key, so the REAL SDK client can be driven end
 * to end with no network.
 *
 *   const fake = await startFakeNosanaApi({ apiKey: "nos_test_..." });
 *   new Client("mainnet", keypair, { apiKey, api: { backend_url: fake.url } });
 *
 * Every route answers both with and without the /api prefix (SDK 0.4.74 sends
 * /api/*, 0.4.87 and the documented host drop it). Implemented, in the shapes
 * the live API sends (Nosana's OpenAPI document and redacted live responses,
 * checked against the Deployment Manager source at 127f915):
 *   POST   /deployments/create          strict job-definition args check, idempotency_key (409 on a duplicate)
 *   GET    /deployments                 paginated: {deployments, pagination}; filters name, idempotency_key, id, status, strategy, vault, search
 *   GET    /deployments/{id}            no jobs or events in the body
 *   POST   /deployments/{id}/start      DRAFT, STOPPED, ERROR, INSUFFICIENT_FUNDS -> RUNNING at once
 *   POST   /deployments/{id}/stop       RUNNING, ERROR, INSUFFICIENT_FUNDS -> STOPPING
 *   POST|PATCH /deployments/{id}/archive, DELETE /deployments/{id}   STOPPED only
 *   PATCH  /deployments/{id}/update-timeout | update-replica-count
 *   GET    /deployments/{id}/jobs | events | tasks    paginated lists
 *   GET    /deployments/{id}/jobs/{job} the single-job shape: numeric state, unix-second times, timeEnd 0 until it ends
 *   GET    /credits/balance
 *   GET    /markets/                    (public: no Authorization needed)
 *
 * A state change Nosana refuses (stop from DRAFT or STARTING, start while
 * running, archive while running) answers HTTP 500 {"error": "Deployment is in
 * the incorrect state."}, as the Deployment Manager does. Paginated routes take
 * `limit` 10, 20, 50 or 100 only (anything else is a 400 FST_ERR_VALIDATION),
 * `sort_order` (default desc, by created_at) and an opaque `cursor`.
 *
 * A create's job definition is checked as the manager's strict validator checks
 * it (jobDefinitionErrors): args keys outside ContainerRun, a `resources` that
 * is not a list of sources, and a malformed exposed port or health check are a
 * 400 FST_ERR_VALIDATION and nothing is created.
 *
 * Endpoints are computed at create, one per exposed port of each container op,
 * with online:false; a test flips them (setEndpointsOnline) to say a node now
 * serves them. Every other route is a 404; the vault routes are counted
 * (`vaultCalls`) so a test can prove the API-key path never asked for one.
 *
 * A test can also script failures: `failNext` answers a request with something
 * else (optionally after carrying it out, as for a create whose answer was
 * lost), and `delayNext` carries one out at once but answers late (a call the
 * caller has given up on).
 *
 * Credit-paid jobs, as the first live run showed them (2026-10-08):
 *   - `timeout` is MINUTES. A deployment whose timeout is under 50 minutes is
 *     accepted and reported RUNNING, and every listing attempt (one at each
 *     start, more with `attemptList`) logs the pair JOB_RESERVE_CONFIRMED,
 *     JOB_LIST_ERROR "Credit-paid jobs must have a timeout of at least 3000
 *     seconds; N was requested." No job is ever listed for it (`addJob`
 *     throws) and nothing is debited.
 *   - A listed job reserves price x timeout at the market's host price
 *     (usd_reward_per_hour, without the network fee): reservedCredits rises
 *     and a `job_debit` row is recorded (`creditRows`). After a stop the
 *     reservation stays until `settleCredits` (or `creditSettleDelayMs`)
 *     moves the used part to settledCredits and returns the rest as a
 *     `job_refund` row (live: a debit of 0.303, then a refund of 0.277 six
 *     minutes 47 seconds after the stop, for a job that cost 0.026).
 *     `creditRows` carry the fields of a row of GET /credits/transactions
 *     ({id, type, amountUsd, createdAt, method}) plus the deployment and job
 *     they belong to, which a live row does not name. The stand-in does not
 *     serve that route: no code of ours reads it.
 *
 * What it is NOT: a model of Nosana's scheduler. Beyond the refused listing
 * above, no job is listed and no node takes one unless a test scripts it
 * (`addJob`, `attemptList`, `updateJob`, `settle`, `setStatus`). Nothing
 * observed here says anything about the live service beyond the shapes and
 * rules above.
 */

import { createHash } from "node:crypto";
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

export type FakeJobState = "QUEUED" | "RUNNING" | "COMPLETED" | "STOPPED";

/** One row of GET /deployments/{id}/jobs, in the live shape. */
export interface FakeJob {
  tx: string;
  deployment: string;
  job: string;
  market: string;
  /** Host node; null until a node has taken the job. */
  node: string | null;
  revision: number;
  state: FakeJobState;
  /** Unix seconds; null until the job started. */
  time_start: number | null;
  created_at: string;
  updated_at: string;
}

/** One row of GET /deployments/{id}/events, in the live shape. */
export interface FakeEvent {
  category: string;
  deploymentId: string;
  type: string;
  message: string;
  created_at: string;
  tx?: string;
}

export interface FakeEndpoint {
  opId: string;
  port: number | string;
  url: string;
  online: boolean;
}

/**
 * The fake's record of a deployment. `jobs` and `events` are kept here for the
 * list routes and for tests to script; the deployment body never carries them.
 */
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
  idempotency_key?: string;
  rotation_time?: number;
  jobs: FakeJob[];
  events: FakeEvent[];
  endpoints: FakeEndpoint[];
  created_at: string;
  updated_at: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  /** The query string, decoded (a repeated key keeps its last value). */
  query: Record<string, string>;
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
  /** Body of GET /markets/. Default: two PREMIUM markets. */
  markets?: unknown[];
  /**
   * When set, a stop that settles (`settle`) moves the stopped jobs' credits
   * this many milliseconds later, as `settleCredits` does. Default: only a
   * test's own `settleCredits` call moves them.
   */
  creditSettleDelayMs?: number;
}

/**
 * A credit movement the fake recorded: the reservation of a listed job
 * (`job_debit`) or the unused part coming back (`job_refund`). The first five
 * fields are those of a live row of GET /credits/transactions.
 */
export interface FakeCreditRow {
  id: string;
  type: "job_debit" | "job_refund";
  /** USD; a debit is rounded up to $0.001. */
  amountUsd: number;
  createdAt: string;
  /** Live rows carry this field; its values for job rows are not modelled. */
  method: string;
  /** Test-side only: a live row carries no deployment id. */
  deployment: string;
  /** Test-side only: a live row carries no job address. */
  job: string;
}

/**
 * Nosana's floor for the timeout of a credit-paid job, in the unit `timeout`
 * is read in (minutes). Written out here, never imported from the services.
 */
export const FAKE_CREDIT_MIN_TIMEOUT_MINUTES = 50;

/** The JOB_LIST_ERROR text of a credit-paid job under the floor (live, 2026-10-08). */
export function creditTimeoutListError(timeoutMinutes: number): string {
  return `Error Failed to assign job batch: Credit-paid jobs must have a timeout of at least ${
    FAKE_CREDIT_MIN_TIMEOUT_MINUTES * 60
  } seconds; ${timeoutMinutes * 60} was requested.`;
}

export interface FakeNosanaApi {
  url: string;
  port: number;
  apiKey: string;
  requests: FakeRequest[];
  deployments: Map<string, FakeDeployment>;
  /** Requests under /deployments/vaults (must stay 0 with an API key). */
  vaultCalls(): number;
  /** The current credit balance (a copy). */
  balance(): FakeBalance;
  /** Every reservation made for a listed job and every refund of an unused part, oldest first. */
  creditRows: FakeCreditRow[];
  /**
   * One listing attempt of Nosana's scheduler. A deployment under the
   * credit-paid minimum logs JOB_RESERVE_CONFIRMED and JOB_LIST_ERROR and
   * gets no job (null). Any other RUNNING deployment logs
   * JOB_RESERVE_CONFIRMED and is listed a job as `addJob` lists it.
   */
  attemptList(id: string): FakeJob | null;
  /**
   * What Nosana does a few minutes after a stop: every reservation of the
   * deployment whose job has ended leaves reservedCredits, and the used part
   * (host price x the seconds the job ran, or `usedSeconds`) is added to
   * settledCredits, and the unused part is recorded as a `job_refund` row.
   * Returns the USD settled. Idempotent.
   */
  settleCredits(id: string, options?: { usedSeconds?: number }): number;
  setBalance(balance: FakeBalance): void;
  setMarkets(markets: unknown[]): void;
  /** Replace the accepted key: every request with the old one answers 401. */
  rotateApiKey(next: string): void;
  /** `owner` of deployments created or read from now on (e.g. a non-base58 string). */
  setOwner(owner: string): void;
  setStatus(id: string, status: FakeDeploymentStatus): void;
  /**
   * STARTING -> RUNNING; STOPPING -> STOPPED, which also ends every QUEUED or
   * RUNNING job (STOPPED, with a JOB_STOPPED_CONFIRMED event) and takes the
   * endpoints offline. Anything else is left alone.
   */
  settle(id: string): void;
  /**
   * Replaces the endpoints. `online` defaults to TRUE: a test that sets an
   * endpoint is saying a node serves it. Endpoints computed at create start
   * offline; flip them with setEndpointsOnline.
   */
  setEndpoints(
    id: string,
    endpoints: Array<{ opId: string; port: number | string; url: string; online?: boolean }>,
  ): void;
  /** Sets `online` on every endpoint of the deployment. */
  setEndpointsOnline(id: string, online: boolean): void;
  /**
   * Lists a job on the deployment (newest last in storage, first in the
   * default list order), records its JOB_LIST_CONFIRMED event and returns it.
   * Defaults: a fresh address, state RUNNING, a node, time_start now (unix
   * seconds). A QUEUED or RUNNING job reserves credits (price x timeout).
   * Throws for a deployment under the credit-paid minimum timeout: Nosana
   * never lists a job for one.
   */
  addJob(id: string, job?: Partial<FakeJob>): FakeJob;
  /** Changes a listed job; throws when the deployment or job does not exist. */
  updateJob(id: string, job: string, patch: Partial<FakeJob>): FakeJob;
  addEvent(id: string, type: string, message: string, category?: string): FakeEvent;
  /**
   * Body GET /deployments/{id}/jobs/{job} answers with, instead of the one
   * derived from the listed job.
   */
  setJob(id: string, job: string, body: unknown): void;
  /** A deployment stored as given (defaults fill the rest), as if created earlier. */
  seedDeployment(deployment: Partial<FakeDeployment> & { name: string }): FakeDeployment;
  /** When true, a start leaves the deployment INSUFFICIENT_FUNDS with a JOB_LIST_ERROR event. */
  setInsufficientFunds(on: boolean): void;
  /**
   * The next `times` requests matching method + path answer with this
   * instead. With `afterAction` the request is carried out first and only
   * its answer is replaced: a create that happened but whose answer failed.
   */
  failNext(
    match: { method?: string; path: RegExp },
    response: { status: number; body: unknown },
    times?: number,
    options?: { afterAction?: boolean },
  ): void;
  /**
   * The next `times` requests matching method + path are carried out at once
   * and answered `ms` later: a call that has happened on the server while its
   * caller is still waiting.
   */
  delayNext(match: { method?: string; path: RegExp }, ms: number, times?: number): void;
  close(): Promise<void>;
}

/** A syntactically valid base58 public key (the System Program id). */
export const FAKE_OWNER = "11111111111111111111111111111111";

/** A host node public key for jobs a test lists without naming one. */
export const FAKE_NODE = "DytPhPyM3GFQLBVwsT9ykQJcWVAGPC8DsMtgqZo23Pio";

/**
 * The keys a container/run op's args may carry: the ContainerRun type of
 * @nosana/types 2.14.2, which the Deployment Manager validates every create
 * against with a strict validator (dist/Jobs/index.js, validateJobDefinition).
 * Any other key is refused with 400. Written out here, never imported: the
 * services must not be checked against their own list.
 */
export const CONTAINER_RUN_ARGS_KEYS: readonly string[] = [
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

/** Unknown args keys of a job definition's container/run ops, as the validator reports them. */
export function unknownJobDefinitionArgs(definition: unknown): string[] {
  const ops = isRecord(definition) && Array.isArray(definition.ops) ? definition.ops : [];
  const errors: string[] = [];
  ops.forEach((op, index) => {
    if (!isRecord(op) || op.type !== "container/run" || !isRecord(op.args)) return;
    for (const [key, value] of Object.entries(op.args)) {
      if (value === undefined || CONTAINER_RUN_ARGS_KEYS.includes(key)) continue;
      errors.push(`job_definition$input.ops[${index}].args.${key}: undefined`);
    }
  });
  return errors;
}

/** The keys of an ExposedPort and of its health checks (@nosana/types 2.14.2, args/expose.d.ts). */
export const EXPOSED_PORT_KEYS: readonly string[] = ["port", "type", "health_checks"];
export const SERVICE_TYPES: readonly string[] = ["web", "api", "webapi", "websocket", "none"];
export const HTTP_HEALTH_CHECK_KEYS: readonly string[] = [
  "type",
  "path",
  "method",
  "expected_status",
  "headers",
  "body",
  "continuous",
];
export const WEBSOCKET_HEALTH_CHECK_KEYS: readonly string[] = ["type", "expected_response", "continuous"];

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function healthCheckErrors(check: unknown, at: string): string[] {
  if (!isRecord(check)) return [`${at}: (HttpHealthCheck | WebSocketHealthCheck)`];
  const errors: string[] = [];
  const allowed = check.type === "websocket" ? WEBSOCKET_HEALTH_CHECK_KEYS : HTTP_HEALTH_CHECK_KEYS;
  for (const key of Object.keys(check)) {
    if (check[key] !== undefined && !allowed.includes(key)) errors.push(`${at}.${key}: undefined`);
  }
  if (typeof check.continuous !== "boolean") errors.push(`${at}.continuous: boolean`);
  if (check.type === "websocket") {
    if (typeof check.expected_response !== "string") errors.push(`${at}.expected_response: string`);
    return errors;
  }
  if (check.type !== "http") errors.push(`${at}.type: ("http" | "websocket")`);
  if (typeof check.path !== "string") errors.push(`${at}.path: string`);
  if (!["GET", "POST", "PUT", "DELETE"].includes(check.method as string)) {
    errors.push(`${at}.method: ("DELETE" | "GET" | "POST" | "PUT")`);
  }
  if (typeof check.expected_status !== "number") errors.push(`${at}.expected_status: number`);
  return errors;
}

function exposeErrors(expose: unknown, at: string): string[] {
  const elements = Array.isArray(expose) ? expose : [expose];
  const errors: string[] = [];
  const seen = new Set<unknown>();
  elements.forEach((element, index) => {
    const here = Array.isArray(expose) ? `${at}[${index}]` : at;
    const port = isRecord(element) ? element.port : element;
    if (typeof port !== "number" && typeof port !== "string") {
      errors.push(`${here}: (ExposedPort | number | string)`);
      return;
    }
    if (seen.has(port)) errors.push(`${at}: Exposed ports must be unique`);
    seen.add(port);
    if (!isRecord(element)) return;
    for (const key of Object.keys(element)) {
      if (element[key] !== undefined && !EXPOSED_PORT_KEYS.includes(key)) errors.push(`${here}.${key}: undefined`);
    }
    if (element.type !== undefined && !SERVICE_TYPES.includes(element.type as string)) {
      errors.push(`${here}.type: ("api" | "none" | "web" | "webapi" | "websocket" | undefined)`);
    }
    if (element.health_checks === undefined) return;
    if (!Array.isArray(element.health_checks)) {
      errors.push(`${here}.health_checks: (Array<HealthCheck> | undefined)`);
      return;
    }
    element.health_checks.forEach((check, i) => {
      errors.push(...healthCheckErrors(check, `${here}.health_checks[${i}]`));
    });
  });
  return errors;
}

/**
 * What the Deployment Manager's validator would refuse in a job definition:
 * the unknown args keys above, plus the value shapes our generators can get
 * wrong - `resources` must be a list of sources (never CPU or memory
 * limits), `cmd` and `entrypoint` a string or strings, `env` a map of
 * strings, an op id without a space or a dot, and every exposed port a
 * number, a range string or an ExposedPort whose keys and health checks are
 * the schema's. Not the whole validator: the parts a create of ours touches.
 */
export function jobDefinitionErrors(definition: unknown): string[] {
  const errors = unknownJobDefinitionArgs(definition);
  const ops = isRecord(definition) && Array.isArray(definition.ops) ? definition.ops : [];
  ops.forEach((op, index) => {
    if (!isRecord(op) || op.type !== "container/run" || !isRecord(op.args)) return;
    const at = `job_definition$input.ops[${index}]`;
    const args = op.args;
    if (typeof op.id !== "string" || /[ .]/.test(op.id)) errors.push(`${at}.id: string & OperationId`);
    if (typeof args.image !== "string") errors.push(`${at}.args.image: string`);
    for (const key of ["cmd", "entrypoint"]) {
      const value = args[key];
      if (value !== undefined && typeof value !== "string" && !isStringArray(value)) {
        errors.push(`${at}.args.${key}: (Array<string> | string | undefined)`);
      }
    }
    if (args.gpu !== undefined && typeof args.gpu !== "boolean") errors.push(`${at}.args.gpu: (boolean | undefined)`);
    if (args.env !== undefined) {
      if (!isRecord(args.env)) errors.push(`${at}.args.env: (Record<string, string> | undefined)`);
      else {
        for (const [name, value] of Object.entries(args.env)) {
          if (typeof value !== "string") errors.push(`${at}.args.env.${name}: string`);
        }
      }
    }
    if (args.resources !== undefined) {
      if (!Array.isArray(args.resources)) errors.push(`${at}.args.resources: (Array<Resource> | undefined)`);
      else {
        args.resources.forEach((resource, i) => {
          if (!isRecord(resource) || !["S3", "HF", "Ollama"].includes(resource.type as string)) {
            errors.push(`${at}.args.resources[${i}]: Resource`);
          }
        });
      }
    }
    if (args.expose !== undefined) errors.push(...exposeErrors(args.expose, `${at}.args.expose`));
  });
  return errors;
}

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

/** Market of a seeded deployment that names none (the 3060 market). */
const SEED_MARKET = "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PAGE_SIZES = new Set(["10", "20", "50", "100"]);
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9:/_.-]{1,128}$/;
const INCORRECT_STATE = { status: 500, body: { error: "Deployment is in the incorrect state." } };
const JOB_STATE_NUMBER: Record<FakeJobState, number> = { QUEUED: 0, RUNNING: 1, COMPLETED: 2, STOPPED: 3 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deterministic 44-character base58 string, in the shape of a Solana address. */
function base58From(seed: string): string {
  let out = "";
  let round = 0;
  while (out.length < 44) {
    for (const byte of createHash("sha256").update(`${seed}:${round}`).digest()) {
      out += BASE58[byte % BASE58.length];
    }
    round += 1;
  }
  return out.slice(0, 44);
}

function validationError(message: string): { status: number; body: unknown } {
  return { status: 400, body: { statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message } };
}

/** The ports a container op exposes: a number, a string, or an array of numbers or {port}. */
function exposedPorts(expose: unknown): Array<number | string> {
  if (typeof expose === "number" || typeof expose === "string") return [expose];
  if (!Array.isArray(expose)) return [];
  const ports: Array<number | string> = [];
  for (const service of expose) {
    const port = isRecord(service) ? service.port : service;
    if (typeof port === "number" || typeof port === "string") ports.push(port);
  }
  return ports;
}

/**
 * Keyset pagination as the Deployment Manager answers it, modelled with an
 * offset cursor: rows sorted by created_at (ties in insertion order), first
 * page without a cursor, cursor_next while rows remain, cursor_prev once a
 * cursor was given.
 */
function paginate<T extends { created_at: string }>(
  rows: T[],
  query: URLSearchParams,
): { ok: true; items: T[]; pagination: Record<string, unknown> } | { ok: false; status: number; body: unknown } {
  const limitText = query.get("limit") ?? "10";
  if (!PAGE_SIZES.has(limitText)) {
    return {
      ok: false,
      ...validationError(
        "querystring/limit must be number, querystring/limit must be equal to constant, querystring/limit must match a schema in anyOf",
      ),
    };
  }
  const sortOrder = query.get("sort_order") ?? "desc";
  if (sortOrder !== "asc" && sortOrder !== "desc") {
    return { ok: false, ...validationError("querystring/sort_order must be equal to constant") };
  }
  const limit = Number(limitText);
  const cursor = query.get("cursor");
  let offset = 0;
  if (cursor !== null) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
      if (typeof decoded.o !== "number" || !Number.isSafeInteger(decoded.o) || decoded.o < 0) throw new Error("bad");
      offset = decoded.o;
    } catch {
      return { ok: false, status: 400, body: { error: "Invalid cursor" } };
    }
  }
  const sorted = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.created_at.localeCompare(b.row.created_at) || a.index - b.index)
    .map((entry) => entry.row);
  if (sortOrder === "desc") sorted.reverse();
  const encode = (o: number) => Buffer.from(JSON.stringify({ o }), "utf8").toString("base64url");
  const items = sorted.slice(offset, offset + limit);
  return {
    ok: true,
    items,
    pagination: {
      cursor_next: items.length > 0 && offset + limit < sorted.length ? encode(offset + limit) : null,
      cursor_prev: cursor !== null && items.length > 0 && offset > 0 ? encode(Math.max(0, offset - limit)) : null,
      total_items: sorted.length,
    },
  };
}

/** Values of a multi-value filter: repeated keys and comma-separated lists. */
function multi(query: URLSearchParams, key: string): string[] | null {
  const values = query.getAll(key).flatMap((v) => v.split(",")).filter((v) => v !== "");
  return values.length > 0 ? values : null;
}

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
  let jobSequence = 0;
  let vaultCalls = 0;
  let markets = options.markets ?? FAKE_MARKETS;
  const creditRows: FakeCreditRow[] = [];
  /** Credits held for a listed job until `settleCredits`. */
  const reservations = new Map<string, { deployment: string; usd: number; usdPerSecond: number; endedAt: number | null }>();
  const deployments = new Map<string, FakeDeployment>();
  const jobBodies = new Map<string, unknown>();
  const requests: FakeRequest[] = [];
  const scripted: Array<{
    method?: string;
    path: RegExp;
    status: number;
    body: unknown;
    left: number;
    afterAction: boolean;
  }> = [];
  const delayed: Array<{ method?: string; path: RegExp; ms: number; left: number }> = [];

  const now = () => new Date().toISOString();
  const view = (d: FakeDeployment) => ({
    id: d.id,
    name: d.name,
    vault: owner,
    market: d.market,
    requirements: null,
    owner,
    status: d.status,
    replicas: d.replicas,
    timeout: d.timeout,
    endpoints: d.endpoints.map((e) => ({ ...e })),
    confidential: d.confidential,
    active_revision: d.active_revision,
    active_jobs: d.jobs.filter((j) => j.state === "RUNNING").length,
    created_at: d.created_at,
    updated_at: d.updated_at,
    strategy: d.strategy,
    ...(d.rotation_time !== undefined ? { rotation_time: d.rotation_time } : {}),
    ...(d.idempotency_key !== undefined ? { idempotency_key: d.idempotency_key } : {}),
  });
  const event = (d: FakeDeployment, type: string, message: string, category = "Deployment"): FakeEvent => {
    const entry: FakeEvent = { category, deploymentId: d.id, type, message, created_at: now() };
    d.events.push(entry);
    d.updated_at = entry.created_at;
    return entry;
  };
  /** The single-job body derived from a listed job, as GET .../jobs/{job} shapes it. */
  const jobView = (d: FakeDeployment, j: FakeJob) => ({
    confidential: d.confidential,
    revision: j.revision,
    market: j.market,
    node: j.node ?? FAKE_OWNER,
    state: JOB_STATE_NUMBER[j.state],
    jobStatus: null,
    jobDefinition: null,
    jobResult: null,
    timeStart: j.time_start ?? 0,
    // A job that ended by a stop reports 0 here; the live API does the same.
    timeEnd: 0,
    listedAt: Math.floor(Date.parse(j.created_at) / 1000),
  });

  function route(method: string, path: string, query: URLSearchParams, body: unknown): { status: number; body: unknown } {
    if (method === "GET" && /^\/markets\/?$/.test(path)) return { status: 200, body: markets };

    if (path === "/credits/balance" && method === "GET") return { status: 200, body: balance };

    if (path.startsWith("/deployments/vaults")) {
      vaultCalls += 1;
      return { status: 404, body: { error: "Not found" } };
    }

    if (path === "/deployments/create" && method === "POST") {
      const b = (body ?? {}) as Record<string, unknown>;
      if (
        typeof b.name !== "string" ||
        typeof b.market !== "string" ||
        typeof b.replicas !== "number" ||
        b.replicas < 1 ||
        typeof b.timeout !== "number" ||
        b.timeout < 1 ||
        !isRecord(b.job_definition) ||
        !Array.isArray(b.job_definition.ops)
      ) {
        return { status: 400, body: { error: "Invalid request body." } };
      }
      if (b.idempotency_key !== undefined && (typeof b.idempotency_key !== "string" || !IDEMPOTENCY_KEY.test(b.idempotency_key))) {
        return validationError("body/idempotency_key must match pattern \"^[a-zA-Z0-9:/_.-]{1,128}$\"");
      }
      const refused = jobDefinitionErrors(b.job_definition);
      if (refused.length > 0) return validationError(refused.join(", "));
      if (b.strategy === "INFINITE" && b.timeout < 60) {
        return { status: 400, body: { error: "Timeout for infinite deployments must be at least 1 hour." } };
      }
      if (
        typeof b.idempotency_key === "string" &&
        [...deployments.values()].some((d) => d.idempotency_key === b.idempotency_key)
      ) {
        return { status: 409, body: { error: "A deployment with this idempotency key already exists" } };
      }
      sequence += 1;
      const id = `fakedm${String(sequence).padStart(4, "0")}`;
      const created = now();
      const endpoints: FakeEndpoint[] = [];
      for (const op of b.job_definition.ops as unknown[]) {
        if (!isRecord(op) || op.type !== "container/run" || !isRecord(op.args)) continue;
        const ports = exposedPorts(op.args.expose);
        for (const port of ports) {
          const opId = String(op.id ?? "");
          endpoints.push({
            opId,
            port,
            url: `https://${base58From(`${id}:${opId}:${ports.length > 1 ? port : 0}`)}.node.k8s.prd.nos.ci`,
            online: false,
          });
        }
      }
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
        ...(typeof b.idempotency_key === "string" ? { idempotency_key: b.idempotency_key } : {}),
        ...(typeof b.rotation_time === "number" ? { rotation_time: b.rotation_time } : {}),
        jobs: [],
        events: [],
        endpoints,
        created_at: created,
        updated_at: created,
      };
      deployments.set(id, deployment);
      if (b.autostart === true) startDeployment(deployment);
      // The create answer leaves the idempotency key out, as the live one does.
      const { idempotency_key: _omitted, ...answer } = view(deployment);
      return { status: 200, body: answer };
    }

    if (path === "/deployments" && method === "GET") {
      const name = query.get("name");
      const key = query.get("idempotency_key");
      const vault = query.get("vault");
      const search = query.get("search")?.toLowerCase() ?? null;
      const ids = multi(query, "id");
      const statuses = multi(query, "status");
      const strategies = multi(query, "strategy");
      const rows = [...deployments.values()].filter(
        (d) =>
          (name === null || d.name === name) &&
          (key === null || d.idempotency_key === key) &&
          (vault === null || owner === vault) &&
          (search === null || d.id.toLowerCase().includes(search) || d.name.toLowerCase().includes(search)) &&
          (ids === null || ids.includes(d.id)) &&
          (statuses === null || statuses.includes(d.status)) &&
          (strategies === null || strategies.includes(d.strategy)),
      );
      const page = paginate(rows, query);
      if (!page.ok) return page;
      return { status: 200, body: { deployments: page.items.map(view), pagination: page.pagination } };
    }

    const match = /^\/deployments\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (!match) return { status: 404, body: { error: "Not found" } };
    const deployment = deployments.get(decodeURIComponent(match[1]!));
    if (!deployment) return { status: 404, body: { error: "Deployment not found." } };
    const action = match[2];

    if (action === undefined && method === "GET") return { status: 200, body: view(deployment) };

    if (action === undefined && method === "DELETE") {
      if (deployment.status !== "STOPPED") return INCORRECT_STATE;
      deployments.delete(deployment.id);
      return { status: 204, body: undefined };
    }

    if (action === "start" && method === "POST") {
      if (!["DRAFT", "STOPPED", "ERROR", "INSUFFICIENT_FUNDS"].includes(deployment.status)) return INCORRECT_STATE;
      startDeployment(deployment);
      // The answer says STARTING; the stored status is already RUNNING (the
      // Deployment Manager moves it as soon as the LIST task is scheduled).
      return { status: 200, body: { status: "STARTING", updated_at: deployment.updated_at } };
    }

    if (action === "stop" && method === "POST") {
      if (!["RUNNING", "ERROR", "INSUFFICIENT_FUNDS"].includes(deployment.status)) return INCORRECT_STATE;
      deployment.status = "STOPPING";
      deployment.updated_at = now();
      return { status: 200, body: { status: "STOPPING", updated_at: deployment.updated_at } };
    }

    if (action === "archive" && (method === "POST" || method === "PATCH")) {
      if (deployment.status !== "STOPPED") return INCORRECT_STATE;
      deployment.status = "ARCHIVED";
      deployment.updated_at = now();
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

    if (action === "tasks" && method === "GET") {
      const page = paginate<{ created_at: string }>([], query);
      if (!page.ok) return page;
      return { status: 200, body: { tasks: page.items, pagination: page.pagination } };
    }

    if (action === "jobs" && method === "GET") {
      const states = multi(query, "state");
      const job = query.get("job");
      const revision = query.get("revision");
      const rows = deployment.jobs.filter(
        (j) =>
          (states === null || states.includes(j.state)) &&
          (job === null || j.job === job) &&
          (revision === null || String(j.revision) === revision),
      );
      const page = paginate(rows, query);
      if (!page.ok) return page;
      return { status: 200, body: { jobs: page.items.map((j) => ({ ...j })), pagination: page.pagination } };
    }

    if (action === "events" && method === "GET") {
      const categories = multi(query, "category");
      const types = multi(query, "type");
      const rows = deployment.events.filter(
        (e) => (categories === null || categories.includes(e.category)) && (types === null || types.includes(e.type)),
      );
      const page = paginate(rows, query);
      if (!page.ok) return page;
      return { status: 200, body: { events: page.items.map((e) => ({ ...e })), pagination: page.pagination } };
    }

    const jobMatch = action ? /^jobs\/([^/]+)$/.exec(action) : null;
    if (jobMatch && method === "GET") {
      const address = decodeURIComponent(jobMatch[1]!);
      const scriptedBody = jobBodies.get(`${deployment.id}/${address}`);
      if (scriptedBody !== undefined) return { status: 200, body: scriptedBody };
      const listed = deployment.jobs.find((j) => j.job === address);
      return listed
        ? { status: 200, body: jobView(deployment, listed) }
        : { status: 404, body: { error: "Job not found." } };
    }

    return { status: 404, body: { error: "Not found" } };
  }

  function startDeployment(deployment: FakeDeployment): void {
    deployment.status = "RUNNING";
    deployment.updated_at = now();
    if (insufficientFunds) {
      deployment.status = "INSUFFICIENT_FUNDS";
      event(deployment, "JOB_LIST_ERROR", "Error Failed to list job: Insufficient credits. Available: $0.000, Required: $0.524");
      return;
    }
    // The first listing attempt of a deployment Nosana will never place. One
    // it can place is listed only when a test says so (addJob, attemptList).
    if (underCreditMinimum(deployment)) refuseListing(deployment);
  }

  /** `timeout` is minutes: under 50 a credit-paid job is never assigned. */
  function underCreditMinimum(deployment: FakeDeployment): boolean {
    return deployment.timeout < FAKE_CREDIT_MIN_TIMEOUT_MINUTES;
  }

  /** The pair of events one refused listing attempt logs; RUNNING is kept. */
  function refuseListing(deployment: FakeDeployment): void {
    event(deployment, "JOB_RESERVE_CONFIRMED", `Reserved ${deployment.replicas} node(s) in market(s) ${deployment.market}`);
    event(deployment, "JOB_LIST_ERROR", creditTimeoutListError(deployment.timeout));
  }

  const usd = (value: number, decimals: number): number => Number(value.toFixed(decimals));
  /** Rounded up to $0.001, as Nosana's debits are. */
  const debitUsd = (value: number): number => Math.ceil(usd(value, 9) * 1000) / 1000;

  /** USD per second a host in this market is paid (no network fee); 0 when the market is not priced. */
  function hostUsdPerSecond(market: string): number {
    const row = markets.find((m) => isRecord(m) && m.address === market);
    const perHour = isRecord(row) && typeof row.usd_reward_per_hour === "number" ? row.usd_reward_per_hour : 0;
    return perHour / 3600;
  }

  function creditRow(type: FakeCreditRow["type"], deployment: string, job: string, amountUsd: number, createdAt: string): void {
    creditRows.push({
      id: `fake-credit-${creditRows.length + 1}`,
      type,
      amountUsd,
      createdAt,
      method: "credits",
      deployment,
      job,
    });
  }

  /** price x timeout, reserved when the job is listed. */
  function reserveFor(deployment: FakeDeployment, job: FakeJob): void {
    const usdPerSecond = hostUsdPerSecond(job.market);
    const amount = debitUsd(usdPerSecond * deployment.timeout * 60);
    if (amount <= 0) return;
    reservations.set(job.job, { deployment: deployment.id, usd: amount, usdPerSecond, endedAt: null });
    balance = { ...balance, reservedCredits: usd(balance.reservedCredits + amount, 6) };
    creditRow("job_debit", deployment.id, job.job, amount, job.created_at);
  }

  function settleCreditsOf(deployment: FakeDeployment, usedSeconds?: number): number {
    let settled = 0;
    for (const job of deployment.jobs) {
      const held = reservations.get(job.job);
      if (!held || held.endedAt === null) continue;
      reservations.delete(job.job);
      const ran = usedSeconds ?? Math.max(0, held.endedAt - (job.time_start ?? held.endedAt));
      const used = Math.min(held.usd, debitUsd(held.usdPerSecond * ran));
      settled = usd(settled + used, 6);
      balance = {
        ...balance,
        reservedCredits: usd(Math.max(0, balance.reservedCredits - held.usd), 6),
        settledCredits: usd(balance.settledCredits + used, 6),
      };
      // The unused part comes back as a row of its own.
      const unused = usd(held.usd - used, 6);
      if (unused > 0) creditRow("job_refund", deployment.id, job.job, unused, now());
    }
    return settled;
  }

  function listJob(deployment: FakeDeployment, job: Partial<FakeJob> = {}): FakeJob {
    if (underCreditMinimum(deployment)) {
      throw new Error(
        `fake Nosana API: deployment ${deployment.id} has timeout ${deployment.timeout} (minutes); Nosana never lists a credit-paid job under ${FAKE_CREDIT_MIN_TIMEOUT_MINUTES}`,
      );
    }
    jobSequence += 1;
    const at = now();
    const entry: FakeJob = {
      tx: base58From(`tx:${deployment.id}:${jobSequence}`),
      deployment: deployment.id,
      job: base58From(`job:${deployment.id}:${jobSequence}`),
      market: deployment.market,
      node: FAKE_NODE,
      revision: deployment.active_revision,
      state: "RUNNING",
      time_start: Math.floor(Date.now() / 1000),
      created_at: at,
      updated_at: at,
      ...job,
    };
    deployment.jobs.push(entry);
    const listed = event(deployment, "JOB_LIST_CONFIRMED", `Successfully listed job - ${entry.job}`);
    listed.tx = entry.tx;
    if (entry.state === "QUEUED" || entry.state === "RUNNING") reserveFor(deployment, entry);
    return entry;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://fake.local");
    const path = url.pathname;
    // Both spellings reach the same routes, as on the live host.
    const routePath = path === "/api" || path.startsWith("/api/") ? path.slice(4) || "/" : path;
    const authorization = req.headers.authorization;
    const body = await readBody(req);

    let answer: { status: number; body: unknown };
    const isPublic = method === "GET" && /^\/markets(\/|$)/.test(routePath);
    const script = scripted.find(
      (s) => s.left > 0 && (s.method === undefined || s.method === method) && s.path.test(path),
    );
    if (!isPublic && authorization !== `Bearer ${apiKey}`) {
      // The real API's 401 body is the bare JSON string "Unauthorized".
      answer = { status: 401, body: "Unauthorized" };
    } else if (script) {
      script.left -= 1;
      if (script.afterAction) route(method, routePath, url.searchParams, body);
      answer = { status: script.status, body: script.body };
    } else {
      answer = route(method, routePath, url.searchParams, body);
    }

    requests.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      authorization,
      body,
      status: answer.status,
    });
    const delay = delayed.find(
      (d) => d.left > 0 && (d.method === undefined || d.method === method) && d.path.test(path),
    );
    if (delay) {
      delay.left -= 1;
      await new Promise<void>((resolve) => setTimeout(resolve, delay.ms).unref());
      if (res.destroyed || res.writableEnded) return;
    }
    if (answer.body === undefined) {
      res.writeHead(answer.status);
      res.end();
      return;
    }
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
    balance: () => ({ ...balance }),
    creditRows,
    attemptList: (id) => {
      const deployment = mustGet(id);
      if (deployment.status !== "RUNNING") return null;
      if (underCreditMinimum(deployment)) {
        refuseListing(deployment);
        return null;
      }
      event(deployment, "JOB_RESERVE_CONFIRMED", `Reserved ${deployment.replicas} node(s) in market(s) ${deployment.market}`);
      return listJob(deployment);
    },
    settleCredits: (id, settleOptions = {}) => settleCreditsOf(mustGet(id), settleOptions.usedSeconds),
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
      else if (deployment.status === "STOPPING") {
        deployment.status = "STOPPED";
        const at = now();
        for (const job of deployment.jobs) {
          if (job.state === "QUEUED" || job.state === "RUNNING") {
            job.state = "STOPPED";
            job.updated_at = at;
            event(deployment, "JOB_STOPPED_CONFIRMED", `Successfully stopped job ${job.job}. TX ${base58From(`stop:${job.job}`)}`);
            // The reservation outlives the stop: Nosana settles it minutes later.
            const held = reservations.get(job.job);
            if (held && held.endedAt === null) held.endedAt = Math.floor(Date.now() / 1000);
          }
        }
        for (const endpoint of deployment.endpoints) endpoint.online = false;
        if (options.creditSettleDelayMs !== undefined) {
          setTimeout(() => settleCreditsOf(deployment), options.creditSettleDelayMs).unref();
        }
      }
    },
    setEndpoints: (id, endpoints) => {
      mustGet(id).endpoints = endpoints.map((e) => ({
        opId: e.opId,
        port: e.port,
        url: e.url,
        online: e.online ?? true,
      }));
    },
    setEndpointsOnline: (id, online) => {
      for (const endpoint of mustGet(id).endpoints) endpoint.online = online;
    },
    addJob: (id, job = {}) => listJob(mustGet(id), job),
    updateJob: (id, job, patch) => {
      const entry = mustGet(id).jobs.find((j) => j.job === job);
      if (!entry) throw new Error(`fake Nosana API: no job ${job} on ${id}`);
      Object.assign(entry, patch, { updated_at: patch.updated_at ?? now() });
      // A job that ended on its own keeps its reservation until it is settled.
      const held = reservations.get(entry.job);
      if (held && held.endedAt === null && (entry.state === "COMPLETED" || entry.state === "STOPPED")) {
        held.endedAt = Math.floor(Date.now() / 1000);
      }
      return entry;
    },
    addEvent: (id, type, message, category) => event(mustGet(id), type, message, category),
    setJob: (id, job, body) => {
      jobBodies.set(`${id}/${job}`, body);
    },
    seedDeployment: (partial) => {
      sequence += 1;
      const id = partial.id ?? `fakedm${String(sequence).padStart(4, "0")}`;
      const at = partial.created_at ?? now();
      const deployment: FakeDeployment = {
        vault: owner,
        market: SEED_MARKET,
        owner,
        status: "RUNNING",
        replicas: 1,
        timeout: 120,
        strategy: "SIMPLE-EXTEND",
        confidential: true,
        active_revision: 1,
        jobs: [],
        events: [],
        endpoints: [],
        updated_at: at,
        ...partial,
        id,
        created_at: at,
      };
      deployments.set(id, deployment);
      return deployment;
    },
    setInsufficientFunds: (on) => {
      insufficientFunds = on;
    },
    failNext: (match, response, times = 1, failOptions = {}) => {
      scripted.push({ ...match, ...response, left: times, afterAction: failOptions.afterAction === true });
    },
    delayNext: (match, ms, times = 1) => {
      delayed.push({ ...match, ms, left: times });
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
