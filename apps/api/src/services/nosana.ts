import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Connection, Keypair } from "@solana/web3.js";
import { Client } from "@nosana/sdk";
import { env } from "../config/env.js";
import {
  getNosanaAccessConfig,
  NOSANA_BACKEND_URLS,
  effectiveTimeoutSeconds,
  secondsToSdkTimeout,
  type NosanaAccessMode,
  type NosanaPrimaryMode,
  type NosanaTimeoutUnit,
} from "../config/nosanaAccess.js";
import { creditPaidTimeoutSeconds, getNosanaDeployConfig } from "../config/nosanaDeploy.js";
import { createLogger } from "../utils/logger.js";
import {
  isAllowedNodeUrl,
  loopbackNodeUrlsAllowed,
  type NodeUrlAllowlistOptions,
} from "./nodeUrlAllowlist.js";
import { isMockNosanaId } from "./nosanaIds.js";
import {
  MARKETS,
  MarketNotConfiguredError,
  resolveMarketAddress,
  toNosanaNetwork,
  type NosanaMarket,
  type NosanaNetwork,
} from "./nosanaMarkets.js";
import {
  checkCreditGate,
  makeCreditBalanceFetcher,
  makeCreditReader,
  NosanaCreditsError,
  requiredCreditsMicroUsd,
  type CreditBalance,
  type CreditReader,
  type FetchLike,
} from "./nosanaCredits.js";
import {
  MARKET_COST_STALE_MAX_MS,
  makeMarketCostReader,
  makeMarketListFetcher,
  retailMicroUsdPerSecond,
  type MarketCost,
  type MarketCostReader,
} from "./nosanaMarketCosts.js";
import {
  createAndStartDeployment,
  creditsFunding,
  DEFAULT_STOP_RETRY,
  ensureVaultRunway,
  normalizeStatus,
  NosanaLifecycleError,
  readDeployment,
  reclaimVault,
  scaleDeployment,
  stopAndReclaim,
  toBaseUnits,
  toEventSnapshots,
  toJobSnapshots,
  vaultFunding,
  type CreateDeploymentBody,
  type DeploymentFunding,
  type DeploymentSnapshot,
  type DeploymentState,
  type EndpointSnapshot,
  type EventSnapshot,
  type JobSnapshot,
  type NosanaDeploymentsPort,
  type ReclaimResult,
  type RunwayResult,
  type ScaleResult,
  type SdkDeploymentLike,
  type SdkEventLike,
  type SdkJobLike,
  type StopAndReclaimResult,
  type StopRetryOptions,
} from "./nosanaDeploymentLifecycle.js";
import {
  collectNosanaPages,
  NOSANA_MAX_LIST_PAGES,
  NOSANA_PAGE_LIMIT,
  NosanaPaginationError,
  readNosanaPage,
  type NosanaPageSize,
} from "./nosanaPagination.js";

const logger = createLogger("nosana-service");

// The GPU tier catalog lives in nosanaMarkets.ts (SDK-free); re-exported here
// because billing and routes have always imported it from this module.
export { MARKETS, MarketNotConfiguredError, type NosanaMarket };
export type { NosanaAccessMode };

// ============================================
// Types
// ============================================

export interface NosanaJobDefinition {
  version: string;
  type: string;
  meta: {
    trigger: string;
  };
  ops: NosanaOperation[];
}

/** How Nosana's tunnel treats an exposed port. */
export type NosanaServiceType = "web" | "api" | "webapi" | "websocket" | "none";

/**
 * A health check of an exposed port. The node uses the first HTTP GET check
 * expecting 200 as the tunnel's backend check for the deployment's URL: with
 * one, a replica that is still loading or has died is taken out of routing;
 * without one, a dead backend behind a live tunnel gives no signal
 * (nosana-node ExposedPortHealthCheck.ts and expose-util.ts). `continuous`
 * is required by the validator.
 */
export type NosanaHealthCheck =
  | {
      type: "http";
      path: string;
      method: "GET" | "POST" | "PUT" | "DELETE";
      expected_status: number;
      headers?: Record<string, string>;
      body?: unknown;
      continuous: boolean;
    }
  | { type: "websocket"; expected_response: string; continuous: boolean };

export interface NosanaExposedPort {
  port: number;
  type?: NosanaServiceType;
  health_checks?: NosanaHealthCheck[];
}

/** A model or file source the node fetches before the container starts. */
export type NosanaResource =
  | { type: "Ollama"; model: string; target?: string }
  | { type: "HF"; target: string; repo: string; revision?: string; files?: string[]; accessToken?: string }
  | { type: "S3"; target: string; url?: string; bucket?: string; files?: string[]; allowWrite?: boolean };

/**
 * A container/run operation: the ContainerRun type of @nosana/types 2.14.2,
 * the version the Deployment Manager validates every create against. Its
 * validator is strict - a key that is not one of these thirteen is refused
 * with 400 - so this type lists them and nothing else. There is no
 * `required_vram`, `work` or `output`, and `resources` is a list of sources,
 * not CPU or memory limits (the schema has none).
 *
 * Narrower than the schema where we only ever send one form: `cmd` and
 * `entrypoint` are arrays (the schema also takes a string), and `expose` is
 * an array.
 */
export interface NosanaOperation {
  type: "container/run";
  id: string;
  args: {
    image: string;
    aliases?: string | string[];
    /**
     * Passed to Docker unchanged, after the image's own entrypoint unless
     * `entrypoint` replaces it. A shell command therefore needs the
     * entrypoint override: see shellCommand.
     */
    cmd?: string[];
    volumes?: Array<{ name: string; dest: string }>;
    expose?: Array<number | NosanaExposedPort>;
    gpu?: boolean;
    work_dir?: string;
    /** Replaces the image's own entrypoint; passed to Docker unchanged. */
    entrypoint?: string[];
    env?: Record<string, string>;
    restart_policy?:
      | "no"
      | "always"
      | "unless-stopped"
      | "on-failure"
      | { policy: "on-failure"; restart_tries?: number };
    private?: boolean;
    resources?: NosanaResource[];
    authentication?: {
      docker?: { username?: string; password?: string; email?: string; server?: string };
    };
  };
}

/**
 * An exposed API port with the HTTP check Nosana's tunnel gates routing on:
 * GET `path` answering 200, at startup and continuously afterwards.
 */
export function apiPortWithHealthCheck(port: number, path: string): NosanaExposedPort {
  return {
    port,
    type: "api",
    health_checks: [{ type: "http", method: "GET", path, expected_status: 200, continuous: true }],
  };
}

/**
 * The entrypoint and cmd that run `script` in the image's shell. Always the
 * pair: the node hands `cmd` to Docker after the image's own entrypoint, so
 * a bare ["/bin/sh", "-c", script] cmd on an image whose entrypoint is a
 * binary runs `<binary> /bin/sh -c ...` and exits.
 */
export function shellCommand(script: string): { entrypoint: string[]; cmd: string[] } {
  return { entrypoint: ["/bin/sh", "-c"], cmd: [script] };
}

/** A market as read from the chain. Prices here are NOS base units, never USD. */
export interface ChainMarket {
  address: string;
  /** market.jobPrice: NOS base units (1e-6 NOS) per second. */
  jobPriceNosBaseUnitsPerSecond: bigint;
  queueLength: number;
}

export interface NosanaJob {
  id: string;
  market: string;
  status: "queued" | "running" | "completed" | "failed";
  nodeUrl?: string;
  /** Base58 pubkey of the host node executing the job. Source-of-truth
   * recipient for treasury auto-pay (plan A3). Undefined when the job
   * isn't yet picked up by a host (queue state) or the SDK reports the
   * SystemProgram zero-pubkey sentinel. */
  nodePubkey?: string;
  startTime?: Date;
  endTime?: Date;
  cost?: number;
}

const SYSTEM_PROGRAM_ZERO_PUBKEY = "11111111111111111111111111111111";

/** What createDeployment returns: a started Nosana deployment. */
export interface NosanaDeployment {
  /** Nosana Deployment-Manager id (store it in `nosanaJobIds`). */
  id: string;
  market: string;
  replicas: number;
  status: "active" | "stopped";
  /**
   * Always [] here. Nosana does compute the endpoints at create - one URL per
   * exposed port of each op, load-balanced across replicas, with
   * online:false - but a URL proves nothing until a node serves it. The
   * status worker reads them, with `online`, from the Nosana API and routes
   * only to online ones. Never synthesised.
   */
  endpoints: EndpointSnapshot[];
  /** Vault holding the platform's funding for this deployment (wallet access only). */
  vaultAddress?: string;
  /**
   * The credential that created it. Store it with the id: every later stop,
   * reclaim, scale and status read must go through the same account. Absent
   * only on the dev-only mock.
   */
  accessMode?: NosanaAccessMode;
  /** True ONLY for the dev-only mock: such an id does not exist on Nosana. */
  mock?: boolean;
}

export interface CreateDeploymentOptions {
  /**
   * "service" (default): long-running inference, kept alive by the configured
   * strategy (SIMPLE-EXTEND). "batch": finite work (training) - strategy SIMPLE,
   * never auto-extended, bounded by NOSANA_BATCH_JOB_TIMEOUT_SECONDS.
   */
  kind?: "service" | "batch";
  /**
   * The name on Nosana, and the create's idempotency_key. Pass a
   * DETERMINISTIC one, unique per run (wheelsaiDeploymentName,
   * modelDeploymentNosanaName): a create that threw, timed out or answered
   * 409 is then looked up by that key, and an unstarted deployment it made is
   * taken on. Nosana releases a key only on DELETE, so a name is never reused.
   */
  name?: string;
  /**
   * Per-job timeout for THIS deployment, in seconds, instead of the configured
   * default for its kind. It sizes the vault funding (wallet) or the credit
   * estimate (API key). Must be an integer >= 60. With API-key access a value
   * under Nosana's minimum for credit-paid jobs (50 minutes) is raised to it:
   * the create, the estimate and the preflight all use the raised value.
   */
  timeoutSeconds?: number;
}

/** Thrown when Nosana deployments are requested but no platform credential exists. */
export class NosanaNotConfiguredError extends Error {
  readonly code = "nosana_not_configured";
  constructor(
    message = "Nosana deployments are not configured: set NOSANA_API_KEY (prepaid credits) or NOSANA_WALLET_PRIVATE_KEY (Solana wallet)",
  ) {
    super(message);
    this.name = "NosanaNotConfiguredError";
  }
}

/**
 * A row was created by an access mode this process holds no credential for
 * (the wallet key was removed after a switch to an API key, or the reverse).
 * Nothing can be read or stopped for it from here; it is named, not guessed.
 */
export class NosanaAccessModeUnavailableError extends Error {
  readonly code = "nosana_access_mode_unavailable";
  constructor(readonly mode: NosanaAccessMode) {
    super(
      `This deployment was created with Nosana ${mode === "wallet" ? "wallet" : "API-key"} access, which is not configured in this process`,
    );
    this.name = "NosanaAccessModeUnavailableError";
  }
}

/**
 * One-shot jobs (submitJob) are listed on chain by a wallet. With an API key
 * the only equivalent pins the job definition to PUBLIC IPFS, so it is refused.
 */
export class NosanaOneShotUnavailableError extends Error {
  readonly code = "nosana_one_shot_unavailable";
  constructor() {
    super("One-shot Nosana jobs are not available with API-key access");
    this.name = "NosanaOneShotUnavailableError";
  }
}

/** Name prefix of every deployment this platform creates on Nosana. */
export const NOSANA_DEPLOYMENT_NAME_PREFIX = "wheelsai-";

/**
 * A deterministic Nosana deployment name for one of our rows, e.g.
 * wheelsaiDeploymentName("model", row.id). Knowing the name before the create
 * call is what lets a deployment be found when that call throws.
 */
export function wheelsaiDeploymentName(scope: string, rowId: string): string {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${NOSANA_DEPLOYMENT_NAME_PREFIX}${clean(scope)}-${clean(rowId)}`.slice(0, 96);
}

/** One row of Nosana's own deployment list. */
export interface NosanaDeploymentSummary {
  id: string;
  name: string;
  /** "unknown" when Nosana reports a status this code does not know. */
  status: DeploymentState | "unknown";
  rawStatus: string;
  replicas: number | null;
  market: string | null;
  createdAt: Date | null;
  /** The create's idempotency_key, when Nosana returns it; null otherwise. */
  idempotencyKey: string | null;
  /** The credential the list was read with. */
  accessMode: NosanaAccessMode;
}

/**
 * What getDeploymentStatus reads besides the deployment body, which no longer
 * carries jobs or events. Omitted: both.
 */
export interface DeploymentReadInclude {
  /** The newest jobs (GET .../jobs). Default true. */
  jobs?: boolean;
  /**
   * The newest events (GET .../events). "when_halted": only when the
   * deployment is ERROR or INSUFFICIENT_FUNDS, where they explain why; that
   * read is best effort (a failure is logged and the snapshot carries no
   * events), so a halted state is never lost to it. Default true.
   */
  events?: boolean | "when_halted";
  /** How many of the newest events (1..1000; read across pages). Default 20. */
  eventCount?: number;
}

/** The deployment body only: status, endpoints, replicas. */
export const DEPLOYMENT_ONLY: Readonly<DeploymentReadInclude> = { jobs: false, events: false };

/** Jobs a status read carries (newest first): a SIMPLE run lists one, an extended service a few. */
const SNAPSHOT_JOBS_LIMIT = 10;
/** Events a status read carries (newest first) unless `eventCount` says otherwise. */
const SNAPSHOT_EVENTS_LIMIT = 20;
/** The most events one read follows pages for. */
const MAX_EVENT_COUNT = 1_000;
const PAGE_SIZES: readonly NosanaPageSize[] = [10, 20, 50, 100];

export type DeploymentJobState = "queued" | "running" | "completed" | "stopped" | "unknown";

/**
 * A job of a deployment, as GET /api/deployments/{id}/jobs/{job} reports it:
 * `state` a number (0 queued, 1 running, 2 completed, 3 stopped), timeStart,
 * timeEnd and listedAt unix seconds, timeEnd 0 for a job that ended by a stop,
 * and jobResult.startTime / endTime in milliseconds (live reads, 2026-10-07).
 */
export interface DeploymentJobSnapshot {
  deploymentId: string;
  job: string;
  state: DeploymentJobState;
  /** What Nosana sent: a number or a string, depending on the backend version. */
  rawState: string | number | null;
  jobStatus: string | null;
  /** Host node public key; null until a host has taken the job. */
  node: string | null;
  market: string | null;
  revision: number | null;
  /**
   * Read as unix SECONDS, or as milliseconds when the value is too large to be
   * seconds; zero or negative means "not yet".
   */
  timeStart: Date | null;
  /**
   * timeEnd; when Nosana reports 0 (a stopped job does), the result's
   * endTime (milliseconds) instead. Null while neither is set.
   */
  timeEnd: Date | null;
  listedAt: Date | null;
  raw: { timeStart: unknown; timeEnd: unknown; listedAt: unknown; resultEndTime: unknown };
  jobResult: unknown;
}

const JOB_STATE_BY_NUMBER: readonly DeploymentJobState[] = ["queued", "running", "completed", "stopped"];
const JOB_STATE_BY_NAME: Readonly<Record<string, DeploymentJobState>> = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  DONE: "completed",
  STOPPED: "stopped",
};

function jobTime(value: unknown): Date | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  // Seconds until the year 5138; anything larger can only be milliseconds.
  const date = new Date(n >= 1e11 ? n : n * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A time Nosana sends in milliseconds (jobResult.startTime / endTime). */
function millisecondTime(value: unknown): Date | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Normalises a raw deployment-job body. Never throws on an odd field. */
export function normalizeDeploymentJob(
  deploymentId: string,
  job: string,
  raw: unknown,
): DeploymentJobSnapshot {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawState =
    typeof body.state === "number" || typeof body.state === "string" ? body.state : null;
  let state: DeploymentJobState = "unknown";
  if (typeof rawState === "number" || (typeof rawState === "string" && /^\d+$/.test(rawState))) {
    state = JOB_STATE_BY_NUMBER[Number(rawState)] ?? "unknown";
  } else if (typeof rawState === "string") {
    state = JOB_STATE_BY_NAME[rawState.toUpperCase()] ?? "unknown";
  }
  const node = typeof body.node === "string" && body.node !== "" ? body.node : null;
  const result =
    typeof body.jobResult === "object" && body.jobResult !== null
      ? (body.jobResult as Record<string, unknown>)
      : null;
  return {
    deploymentId,
    job,
    state,
    rawState,
    jobStatus: typeof body.jobStatus === "string" ? body.jobStatus : null,
    node: node === SYSTEM_PROGRAM_ZERO_PUBKEY ? null : node,
    market: typeof body.market === "string" ? body.market : null,
    revision: typeof body.revision === "number" ? body.revision : null,
    timeStart: jobTime(body.timeStart),
    timeEnd: jobTime(body.timeEnd) ?? millisecondTime(result?.endTime),
    listedAt: jobTime(body.listedAt),
    raw: {
      timeStart: body.timeStart,
      timeEnd: body.timeEnd,
      listedAt: body.listedAt,
      resultEndTime: result?.endTime,
    },
    jobResult: body.jobResult ?? null,
  };
}

/** How one access mode reaches Nosana and pays for it. */
interface NosanaAccess {
  mode: NosanaAccessMode;
  port: NosanaDeploymentsPort;
  funding: DeploymentFunding;
}

/** The part of an API-key SDK client this service uses. */
interface ApiSdkLike {
  deployments: {
    create(body: unknown): Promise<unknown>;
    get(id: string): Promise<unknown>;
  };
}

/** Service estimates cover at least this long, whatever the job timeout. */
const MIN_CREDIT_ESTIMATE_SECONDS = 3_600;
/** The SDK refuses an updateTimeout value below this (its own guard). */
const SDK_MIN_UPDATE_TIMEOUT = 60;

function toSummaryDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDeploymentSummary(raw: unknown, accessMode: NosanaAccessMode): NosanaDeploymentSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") return null;
  const rawStatus = String(row.status ?? "");
  let status: NosanaDeploymentSummary["status"];
  try {
    status = normalizeStatus(rawStatus);
  } catch {
    status = "unknown";
  }
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : "",
    status,
    rawStatus,
    replicas: typeof row.replicas === "number" ? row.replicas : null,
    market: typeof row.market === "string" ? row.market : null,
    createdAt: toSummaryDate(row.created_at),
    idempotencyKey: typeof row.idempotency_key === "string" ? row.idempotency_key : null,
    accessMode,
  };
}

function isRecordWith(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)[key] === "string";
}

/**
 * Sorted newest first by createdAt (stable; rows without one keep their
 * place after the dated ones). Nosana already answers in this order.
 */
function newestFirst<T extends { createdAt?: string | null }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        (b.row.createdAt ?? "").localeCompare(a.row.createdAt ?? "") || a.index - b.index,
    )
    .map((entry) => entry.row);
}

// ============================================
// Deadlines and error bodies of SDK calls
// ============================================

/** A Nosana SDK call that did not settle within NOSANA_SDK_TIMEOUT_MS. */
export class NosanaDeadlineError extends Error {
  readonly code = "nosana_timeout";
  constructor(readonly what: string, readonly ms: number) {
    super(`${what} did not answer within ${ms} ms`);
    this.name = "NosanaDeadlineError";
  }
}

/**
 * `promise`, or a NosanaDeadlineError after `ms`. The call itself is not
 * cancelled (the SDK takes no signal): what it did on the server may still
 * happen, which is why a create that runs out of time is looked up by its
 * idempotency key afterwards. A late rejection is swallowed, not left unhandled.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NosanaDeadlineError(what, ms)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Keys whose values never leave this process, whatever their nesting. */
const SECRET_KEYS = /^(value|values|env|authorization|token|secret|password|api_?key|headers|cmd|args|job_definition|data)$/i;
/** Credentials that may appear inside an error message. */
const SECRET_TEXT = /\b(nos_[A-Za-z0-9_-]{4,}|hf_[A-Za-z0-9]{4,}|Bearer\s+\S+|https?:\/\/[^\s"']*[?&](X-Amz-[A-Za-z]+|sig|signature|token)=[^\s"']*)/g;
const MAX_ERROR_TEXT = 1_000;
const MAX_ERROR_BODY = 4_000;

function redactText(text: string): string {
  const clean = text.replace(SECRET_TEXT, "[redacted]");
  return clean.length > MAX_ERROR_TEXT ? `${clean.slice(0, MAX_ERROR_TEXT)}...` : clean;
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 6) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redactValue(inner, depth + 1);
  }
  return out;
}

/**
 * The body of a Nosana error answer, fit for a log line: JSON keeps its shape
 * (the validator's `path` and `message` are the point) with every value that
 * could carry a secret replaced - a validator's `value`, env, cmd, auth - and
 * key- or signature-shaped text scrubbed; anything else is cut-down text.
 */
export function redactNosanaErrorBody(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactText(text);
  }
  const redacted = redactValue(parsed, 0);
  const size = JSON.stringify(redacted)?.length ?? 0;
  return size > MAX_ERROR_BODY ? redactText(JSON.stringify(redacted)).slice(0, MAX_ERROR_BODY) : redacted;
}

/** A refused create, as the SDK's fetch saw it (its error formatter keeps one field of the body). */
export interface NosanaCreateRefusal {
  status: number;
  body: unknown;
}

/** An error's name, message and code for a log line, redacted; undefined for none. */
function describeCause(cause: unknown): Record<string, unknown> | string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (!(cause instanceof Error)) return redactText(String(cause));
  const code = (cause as { code?: unknown }).code;
  return {
    name: cause.name,
    message: redactText(cause.message),
    ...(typeof code === "string" ? { code } : {}),
  };
}

type GlobalFetch = typeof globalThis.fetch;

function requestUrl(input: Parameters<GlobalFetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Builds an SDK Client whose HTTP client reports every refused
 * POST .../deployments/create to `onRefusal`. SDK 0.4.74's errorFormatter turns
 * a 400 body {error: "Bad Request", message: "<the reason>"} into "Bad
 * Request" and drops the rest, and the openapi-fetch client under it is not
 * exposed - but it takes globalThis.fetch once, when the Client is
 * constructed (openapi-fetch 0.14 createClient). So the Client is built with
 * a reporting fetch in place, synchronously, and the global is restored
 * before anything else can run. Only the answer is read (a clone); requests
 * pass through untouched.
 */
function constructWithReportingFetch<T>(build: () => T, onRefusal: (refusal: NosanaCreateRefusal) => void): T {
  const original: GlobalFetch = globalThis.fetch;
  const reporting: GlobalFetch = async (input, init) => {
    const response = await original(input, init);
    try {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (!response.ok && method === "POST" && /\/deployments\/create$/.test(new URL(requestUrl(input)).pathname)) {
        const text = await response.clone().text();
        onRefusal({ status: response.status, body: redactNosanaErrorBody(text) });
      }
    } catch {
      // Reporting is for the log; it never changes what the SDK sees.
    }
    return response;
  };
  globalThis.fetch = reporting;
  try {
    return build();
  } finally {
    globalThis.fetch = original;
  }
}

// isMockNosanaId lives in nosanaIds.ts (import-free); re-exported because
// routes and tests have always imported it from here.
export { isMockNosanaId };

/**
 * The dev-only mock is honoured only when ALLOW_NOSANA_MOCK is set AND this is a
 * development process. Production boot already rejects the flag (validateEnv);
 * the NODE_ENV check makes the mock structurally unreachable in staging too.
 */
export function isNosanaMockEnabled(
  source: { ALLOW_NOSANA_MOCK?: boolean; NODE_ENV?: string } = env,
): boolean {
  return source.ALLOW_NOSANA_MOCK === true && source.NODE_ENV === "development";
}

/**
 * Options every server-side node fetch (the /v1 proxy, the playground proxy and
 * the health probe) passes to the SSRF allowlist. Loopback needs a development
 * process AND the explicit ALLOW_LOOPBACK_NODE_URLS opt-in.
 */
export function nodeUrlAllowlistOptions(): NodeUrlAllowlistOptions {
  return {
    allowLoopback: loopbackNodeUrlsAllowed(
      env.NODE_ENV,
      getNosanaDeployConfig().allowLoopbackNodeUrls,
    ),
  };
}

/**
 * Where an engine says its model is ready. vLLM serves /health, which answers
 * 200 only once the model is loaded. Ollama has no such route: its server
 * answers (and /api/tags lists the pulled model) before the model is in GPU
 * memory, and the first request then waits for the load (42 seconds on the
 * first live run, past the inference timeout of the day). /api/ps lists the
 * models the server holds, so that is what is read (ollamaModelLoaded); it
 * lists a model from the moment its load begins.
 *
 * Neither is the whole probe. A node's first generation is slow on both
 * engines, so a node is healthy only once it has also answered a load
 * request, one generated token, for the model (checkNodeHealth).
 */
export function nodeHealthPath(engine?: string): string {
  return engine === "ollama" ? OLLAMA_LOADED_MODELS_PATH : "/health";
}

/** Ollama's list of the models loaded in memory now. */
export const OLLAMA_LOADED_MODELS_PATH = "/api/ps";

/** A body larger than this is not an /api/ps answer; it is not read further. */
export const MAX_PROBE_BODY_BYTES = 64 * 1024;

/**
 * The body of a probe answer, or null when it is larger than `maxBytes`. The
 * node belongs to a third-party host, so the cap is applied while reading: a
 * declared length over the cap is refused unread, and a stream is cancelled at
 * the first chunk that passes it. Nothing past the cap is ever held in memory.
 */
export async function readProbeBody(response: Response, maxBytes = MAX_PROBE_BODY_BYTES): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  const reader = response.body?.getReader();
  if (!reader) return "";
  if (Number.isFinite(declared) && declared > maxBytes) {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `name` as Ollama lists it: a reference without a tag is `:latest`. */
function ollamaReference(name: string): string {
  const last = name.slice(name.lastIndexOf("/") + 1);
  return last.includes(":") ? name : `${name}:latest`;
}

/**
 * Whether an /api/ps body lists `model` as loaded:
 * {"models":[{"name":"llama3.2:3b","model":"llama3.2:3b",...}]}. With no
 * model named, any loaded model counts. Anything that is not that shape is
 * "not loaded": the probe fails closed.
 */
export function ollamaModelLoaded(body: unknown, model?: string): boolean {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return false;
  const names = models.flatMap((entry) => {
    const row = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    return [row.name, row.model].filter((value): value is string => typeof value === "string" && value !== "");
  });
  if (model === undefined || model === "") return names.length > 0;
  // Ollama treats model names without regard to letter case.
  const wanted = ollamaReference(model).toLowerCase();
  return names.some((name) => ollamaReference(name).toLowerCase() === wanted);
}

/** Whether a body is an /api/ps answer at all: an Ollama server said which models it holds. */
function isOllamaLoadedModelsAnswer(body: unknown): boolean {
  return Array.isArray((body as { models?: unknown } | null)?.models);
}

// ============================================
// Loading a model that is not loaded
// ============================================

/** Where the load request goes: Ollama's generate route. */
export const OLLAMA_LOAD_PATH = "/api/generate";

/**
 * The load request: the smallest real generation, one token, kept loaded for
 * ever. Ollama loads the model if it has to, runs it and only then answers.
 *
 * A request with no prompt (Ollama's documented preload) is not enough. It is
 * answered as soon as the weights are in memory, and a node's first generation
 * after a cold start takes far longer than any later one: on the second live
 * run a 4090 answered the bare load in 6 seconds and the customer's first
 * request, 19 seconds later, still waited 22. Only an answered generation
 * says the next request will be quick. One token costs a node that is warm
 * about a third of a second.
 */
export function ollamaLoadRequestBody(model: string): string {
  return JSON.stringify({
    model,
    prompt: "Hi",
    stream: false,
    keep_alive: -1,
    // A prediction option, not a runner option: it never makes Ollama reload the model.
    options: { num_predict: 1 },
  });
}

/**
 * Where a vLLM node is sent its load request: the OpenAI completions route.
 */
export const VLLM_LOAD_PATH = "/v1/completions";

/**
 * The load request of a vLLM node: one generated token. vLLM's /health says
 * the engine is up, and the model is in memory by then, but a node's first
 * generation is slow there too: on the first live vLLM deployment (a 4090,
 * 2026-10-08) the first request took 27 seconds, Nosana's health check failed
 * meanwhile and the deployment read as not serving for half a minute, where
 * every later request took a quarter of a second. `model` is the name the
 * engine serves the base model under (its Hugging Face id).
 */
export function vllmLoadRequestBody(model: string): string {
  return JSON.stringify({ model, prompt: "Hi", max_tokens: 1, stream: false });
}

/** The engines whose nodes are sent a load request. */
export type LoadRequestEngine = "ollama" | "vllm";

/** Path and body of the load request, per engine. */
const LOAD_REQUESTS: Readonly<Record<LoadRequestEngine, { path: string; body: (model: string) => string }>> = {
  ollama: { path: OLLAMA_LOAD_PATH, body: ollamaLoadRequestBody },
  vllm: { path: VLLM_LOAD_PATH, body: vllmLoadRequestBody },
};

/**
 * `model` as a confirmation is stored and compared: Ollama compares names
 * without regard to case and reads a missing tag as `:latest`; a vLLM name is
 * taken as it is.
 */
function loadedModelKey(engine: LoadRequestEngine, model: string): string {
  return engine === "ollama" ? ollamaReference(model).toLowerCase() : model;
}

/**
 * How long one load request may take before it is given up. It waits for the
 * whole model to be read into GPU memory and for the node's first generation:
 * 42 seconds for a 2 GB model on a 4090 on the first live run, minutes for a
 * large one. The next probe that still finds the model missing asks again.
 */
export const MODEL_LOAD_DEADLINE_MS = 10 * 60_000;

/**
 * How long a vLLM node's one-token request may take before it is given up.
 * vLLM answers /health with 200 only once the model is in memory, so the
 * request waits for a first generation and for no weights: 3.8 seconds on one
 * live node, 27 for a first chat on another. Only one request per node may be
 * in flight, so an answer lost on the way (the tunnel drops it, the container
 * is replaced mid-request) would otherwise keep a node that answers from
 * being confirmed for the whole of an Ollama load's ten minutes.
 */
export const VLLM_ANSWER_DEADLINE_MS = 90_000;

/** The deadline of a load request, by engine, unless the caller gives one. */
const LOAD_REQUEST_DEADLINES_MS: Record<LoadRequestEngine, number> = {
  ollama: MODEL_LOAD_DEADLINE_MS,
  vllm: VLLM_ANSWER_DEADLINE_MS,
};

/**
 * Sends the load request and reads its answer to the end without keeping it;
 * resolves with the status. Ollama sends nothing, not even headers, until the
 * model is in memory, and the runtime's fetch gives up on a server that has
 * sent no headers after 300 seconds whatever the caller's deadline says. So
 * this goes through node:http(s), which has no limit of its own: `signal` is
 * the only thing that ends it. It never follows a redirect (a 3xx is just a
 * status), and it uses a connection of its own.
 */
function postLoadRequest(url: string, body: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: "POST",
        agent: false,
        signal,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        res.on("error", reject);
        // Closing the connection early would cancel the load: read to the end.
        res.on("close", () =>
          res.complete ? resolve(res.statusCode ?? 0) : reject(new Error("the answer ended early")),
        );
        res.resume();
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** How a load request is sent: resolves with the HTTP status of the answer. */
type LoadRequestTransport = (url: string, body: string, signal: AbortSignal) => Promise<number>;

let loadRequestTransport: LoadRequestTransport = postLoadRequest;

/**
 * Test seam: replaces how a load request is sent and returns what restores
 * it. A test that probes a node name which is not a loopback server needs it:
 * the load does not go through fetch, so stubbing fetch does not hold it back.
 */
export function setLoadRequestTransportForTests(transport: LoadRequestTransport): () => void {
  const previous = loadRequestTransport;
  loadRequestTransport = transport;
  return () => {
    loadRequestTransport = previous;
  };
}

/** The load requests in flight, by node URL: at most one per node at a time. */
const loadRequestsInFlight = new Map<string, { load: Promise<void>; startedAt: number }>();

/** The load requests in flight now (for tests, and for a shutdown that wants to wait). */
export function pendingModelLoads(): Promise<void>[] {
  return [...loadRequestsInFlight.values()].map((entry) => entry.load);
}

/**
 * The nodes whose model this process has seen answer: a load request for it
 * (ollamaLoadRequestBody: one generated token) was answered 2xx. /api/ps
 * cannot say that on its own. It lists a model from the moment its load
 * begins (seen with a real server: listed four seconds before the runner had
 * started), and a model that is in memory has still not run its first, slow,
 * generation. By node URL; the value is the model as Ollama compares names
 * and when it was last seen answering.
 *
 * The URL belongs to the deployment, not to a container: Nosana can run a new
 * container behind it, and that one lists its model while it is still
 * loading. So a confirmation is forgotten on everything that can mean the
 * server behind the URL is not the one that answered: /api/ps not listing the
 * model, a probe that fails or is not answered by Ollama, a load request that
 * fails, and (from the status tick, forgetNodeAnswered) an endpoint
 * Nosana reports offline, a node that is dropped and a row that leaves
 * service. It also has an age (NODE_ANSWERED_MAX_AGE_MS).
 */
const nodesSeenAnswering = new Map<string, { model: string; at: number }>();

/** How many confirmations are kept. Nodes come and go; the oldest are dropped first. */
const MAX_NODES_SEEN_ANSWERING = 10_000;

/**
 * How long a confirmation stands on its own. After it the next probe sends
 * the one-token request again (a third of a second on a warm node) and takes
 * its answer as the new confirmation. A backstop: a container replaced behind
 * the same URL between two probes, with nothing seen failing, is found out
 * within this time.
 */
export const NODE_ANSWERED_MAX_AGE_MS = 5 * 60_000;

/**
 * How long an unanswered load request counts as "not known yet" (`pending`)
 * and not as "not ready". A warm node that is generating a customer's answer
 * queues the one-token request behind it, so the request can go unanswered
 * for the length of that answer without anything being wrong; a model that
 * is really loading takes about this long or longer (49 seconds measured on
 * a 4090).
 */
export const MODEL_LOAD_PENDING_GRACE_MS = 60_000;

function recordNodeAnswered(nodeUrl: string, engine: LoadRequestEngine, model: string): void {
  // Re-inserted, so the map stays ordered by the last confirmation.
  nodesSeenAnswering.delete(nodeUrl);
  nodesSeenAnswering.set(nodeUrl, { model: loadedModelKey(engine, model), at: Date.now() });
  if (nodesSeenAnswering.size > MAX_NODES_SEEN_ANSWERING) {
    const oldest = nodesSeenAnswering.keys().next().value;
    if (oldest !== undefined) nodesSeenAnswering.delete(oldest);
  }
}

/** Whether `model` was seen answering on the node, and no longer ago than `maxAgeMs`. */
function nodeSeenAnswering(
  nodeUrl: string,
  engine: LoadRequestEngine,
  model: string,
  maxAgeMs = NODE_ANSWERED_MAX_AGE_MS,
): boolean {
  const seen = nodesSeenAnswering.get(nodeUrl);
  return (
    seen !== undefined &&
    seen.model === loadedModelKey(engine, model) &&
    Date.now() - seen.at <= maxAgeMs
  );
}

/**
 * Forgets that a node's model was seen answering: the next probe that finds
 * the model listed asks again. Called whenever the server behind the URL may
 * no longer be the one that answered (see nodesSeenAnswering).
 */
export function forgetNodeAnswered(nodeUrl: string): void {
  nodesSeenAnswering.delete(nodeUrl);
}

/** Test seam: forget every confirmed load. */
export function resetNodesSeenAnsweringForTests(): void {
  nodesSeenAnswering.clear();
}

/** Test seam: makes a node's confirmation `ageMs` old. False when there is none. */
export function ageNodeAnsweredForTests(nodeUrl: string, ageMs: number): boolean {
  const seen = nodesSeenAnswering.get(nodeUrl);
  if (!seen) return false;
  seen.at = Date.now() - ageMs;
  return true;
}

/**
 * How long a probe waits for the load request it has just sent. A model that
 * is warm and idle answers it in well under a second, so a node this process
 * has not confirmed yet (every node, after the API restarts) is healthy
 * within that same probe. A model that is still loading, has not finished its
 * first generation, or is busy with a customer's answer does not answer in
 * time: the probe leaves the request running and reports `pending`.
 */
export const MODEL_ANSWER_WAIT_MS = 2_000;

/**
 * What is known about a model /api/ps lists:
 *   ready     - seen answering a load request, recently enough;
 *   pending   - a load request is in flight and not answered yet, for less
 *               than `pendingGraceMs`: loading, or warm and busy. Not known.
 *   not_ready - nothing in flight (the URL is off the allowlist, or the
 *               request just failed), or one unanswered for longer than that.
 */
type ModelReadiness = "ready" | "pending" | "not_ready";

/**
 * Whether a model /api/ps lists can answer now. This process has either seen
 * a load request for it answered, or it sends one now and gives it `waitMs`.
 * A request already in flight is not waited for here. Never throws.
 */
async function modelAnswersNow(
  nodeUrl: string,
  engine: LoadRequestEngine,
  model: string,
  waitMs: number,
  pendingGraceMs: number,
): Promise<ModelReadiness> {
  if (nodeSeenAnswering(nodeUrl, engine, model)) return "ready";
  if (requestModelLoad(nodeUrl, engine, model, { reason: "confirm" })) {
    const sent = loadRequestsInFlight.get(nodeUrl);
    if (sent) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        sent.load,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    if (nodeSeenAnswering(nodeUrl, engine, model)) return "ready";
  }
  const inFlight = loadRequestsInFlight.get(nodeUrl);
  if (!inFlight) return "not_ready";
  return Date.now() - inFlight.startedAt < pendingGraceMs ? "pending" : "not_ready";
}

/**
 * Sends a node its load request: one generated token (LOAD_REQUESTS).
 *
 * Ollama. Requests are only routed to nodes whose probe is healthy, healthy
 * means "the model answers", and Ollama loads a model only when a request for
 * it arrives: a node whose model is not loaded (the in-container preload
 * failed, the runner restarted, the model was unloaded) would otherwise never
 * get the request that loads it. So the probe that finds the server up and
 * the model missing calls this, and the request also keeps the model loaded
 * for ever.
 *
 * Both engines. The same request is how the probe learns that a node which
 * reports its model ready (Ollama: listed by /api/ps; vLLM: /health 200) can
 * answer (modelAnswersNow): a 2xx answer is recorded as the model seen
 * answering on that node.
 *
 * Fire and forget: it returns at once and never throws. One request per node
 * URL at a time (`false`: one is already in flight, or the URL is off the
 * allowlist, and nothing was sent). The record of the request is removed when
 * it ends, however it ends. Same SSRF allowlist and redirect rule as the probe.
 */
export function requestModelLoad(
  nodeUrl: string,
  engine: LoadRequestEngine,
  model: string,
  options: {
    deadlineMs?: number;
    /** For the log: the model was not listed (default), or the node reports ready and has not been seen to answer. */
    reason?: "not_loaded" | "confirm";
  } = {},
): boolean {
  let key: string;
  try {
    if (model === "" || !isAllowedNodeUrl(nodeUrl, nodeUrlAllowlistOptions())) return false;
    // An allowlisted URL is an origin: scheme, host and port, nothing after.
    key = nodeUrl;
    if (loadRequestsInFlight.has(key)) return false;
  } catch {
    return false;
  }
  const startedAt = Date.now();
  const load = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.deadlineMs ?? LOAD_REQUEST_DEADLINES_MS[engine]);
    // The deadline alone must not keep a process that is shutting down alive.
    timer.unref?.();
    try {
      const status = await loadRequestTransport(
        `${key}${LOAD_REQUESTS[engine].path}`,
        LOAD_REQUESTS[engine].body(model),
        controller.signal,
      );
      if (status >= 200 && status < 300) {
        // Answered: the model is in memory and has run a generation.
        recordNodeAnswered(key, engine, model);
        logger.info(
          { nodeUrl: key, engine, model, ms: Date.now() - startedAt },
          "Model loaded on its node and answering",
        );
      } else {
        // Whatever answered before, this server does not answer for the model now.
        forgetNodeAnswered(key);
        logger.warn(
          { nodeUrl: key, engine, model, status },
          "A node refused to load its model; the next probe asks again",
        );
      }
    } catch (err) {
      forgetNodeAnswered(key);
      logger.warn(
        { nodeUrl: key, engine, model, ms: Date.now() - startedAt, err: err instanceof Error ? err.message : String(err) },
        "Loading a model on its node did not complete; the next probe asks again",
      );
    } finally {
      clearTimeout(timer);
      loadRequestsInFlight.delete(key);
    }
  })();
  loadRequestsInFlight.set(key, { load, startedAt });
  if (options.reason === "confirm") {
    logger.debug({ nodeUrl: key, engine, model }, "A node reports its model ready; asking it for one token to confirm it answers");
  } else {
    logger.info({ nodeUrl: key, engine, model }, "A node answers without its model loaded; asking it to load the model");
  }
  return true;
}

// ============================================
// Nosana Client
// ============================================

export class NosanaClient {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private sdk: Client | null = null;
  private isInitialized = false;
  private network: NosanaNetwork;
  /**
   * The network the API key is used on. Its own field: `network` stays the
   * WALLET client's, so making the API key primary never moves wallet-created
   * deployments to another backend and other program addresses.
   */
  private apiNetwork: NosanaNetwork = "mainnet";
  // API-key access, beside the wallet client and never instead of it: `sdk`,
  // `wallet` and `network` keep meaning exactly what they always meant.
  private apiSdk: ApiSdkLike | null = null;
  private apiAccess: { apiKey: string; backendUrl: string } | null = null;
  /** Set by initialize() from config; null means "derive it from what is loaded". */
  private primaryMode: NosanaPrimaryMode | null = null;
  private credits: CreditReader | null = null;
  /** One per backend: with two credentials the two networks price different markets. */
  private marketCosts = new Map<string, MarketCostReader>();
  private authProbe: { at: number; failed: boolean } | null = null;
  /** HTTP seam for the direct reads: credits, markets, the deployment list, jobs and events. */
  private fetcher: FetchLike = (url, init) => fetch(url, init);
  /** Wait between stop attempts Nosana refuses while DRAFT or STARTING (test seam). */
  private sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /**
   * Where a refused create's answer goes: its body, which the SDK's error
   * drops, redacted (test seam; constructWithReportingFetch calls it).
   */
  private reportCreateRefusal: (refusal: NosanaCreateRefusal) => void = (refusal) =>
    logger.error(
      { status: refusal.status, body: refusal.body },
      "Nosana refused a deployment create; the answer's body, redacted",
    );

  constructor() {
    this.connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
    // SOLANA_NETWORK is typed as "devnet" | "mainnet-beta"; Nosana SDK only accepts "devnet" | "mainnet"
    this.network = toNosanaNetwork(env.SOLANA_NETWORK);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    if (env.NOSANA_WALLET_PRIVATE_KEY) {
      try {
        const secretKey = Uint8Array.from(
          JSON.parse(env.NOSANA_WALLET_PRIVATE_KEY)
        );
        this.wallet = Keypair.fromSecretKey(secretKey);
        logger.info(
          { publicKey: this.wallet.publicKey.toBase58() },
          "Nosana wallet loaded"
        );
      } catch (error) {
        logger.error({ error }, "Failed to load Nosana wallet");
        throw new Error("Invalid NOSANA_WALLET_PRIVATE_KEY format");
      }
    } else {
      logger.warn("No Nosana wallet configured - job submission disabled");
    }

    const access = getNosanaAccessConfig();
    for (const warning of access.warnings) {
      // The timeout unit is money: sixty times the credits per listed job.
      if (access.timeoutUnit === "seconds" && warning.startsWith("NOSANA_TIMEOUT_UNIT=seconds")) {
        logger.error(warning);
      } else {
        logger.warn(warning);
      }
    }
    // The wallet client keeps the network it always derived from
    // SOLANA_NETWORK, whichever credential is primary; only an explicit
    // NOSANA_NETWORK moves it. The API key has its own (mainnet by default).
    if (access.networkExplicit) this.network = access.walletNetwork;
    this.apiNetwork = access.apiNetwork;

    // Initialise SDK even without a wallet so read-only operations still work.
    // When no wallet is present pass a dummy key; the SDK needs something for
    // the Anchor provider but we guard all write paths explicitly.
    const sdkWallet = this.wallet ?? Keypair.generate();

    const ipfsConfig =
      env.PINATA_API_KEY && env.PINATA_SECRET_KEY
        ? {
            api: "https://api.pinata.cloud",
            gateway: "https://nosana.mypinata.cloud/ipfs/",
          }
        : undefined;

    // Use OUR RPC for the SDK's on-chain calls (vault top-ups, job listing,
    // market reads) instead of the SDK's built-in shared endpoint.
    const onRefusal = (refusal: NosanaCreateRefusal) => this.reportCreateRefusal(refusal);
    this.sdk = constructWithReportingFetch(
      () =>
        new Client(this.network, sdkWallet, {
          solana: { network: env.SOLANA_RPC_URL },
          ...(ipfsConfig ? { ipfs: ipfsConfig } : {}),
        }),
      onRefusal,
    );

    if (access.apiKey) {
      // An explicit throwaway keypair: with no wallet argument the SDK would
      // pick up process.env.SOLANA_WALLET. It signs nothing - every request
      // carries the Bearer key. The SDK shares one Solana preset per network
      // between clients, so both are given the same `solana` config.
      this.apiSdk = constructWithReportingFetch(
        () =>
          new Client(this.apiNetwork, Keypair.generate(), {
            apiKey: access.apiKey,
            solana: { network: env.SOLANA_RPC_URL },
            ...(access.apiUrl ? { api: { backend_url: access.apiUrl } } : {}),
            ...(ipfsConfig ? { ipfs: ipfsConfig } : {}),
          }),
        onRefusal,
      ) as unknown as ApiSdkLike;
      this.apiAccess = {
        apiKey: access.apiKey,
        backendUrl: access.apiUrl ?? NOSANA_BACKEND_URLS[this.apiNetwork],
      };
      logger.info(
        { keySuffix: access.apiKeySuffix, network: this.apiNetwork, customBackend: !!access.apiUrl },
        "Nosana API key loaded"
      );
    }
    this.primaryMode = access.primary;

    logger.info(
      {
        network: this.getNetwork(),
        ...(this.wallet && this.apiSdk
          ? { walletNetwork: this.network, apiKeyNetwork: this.apiNetwork }
          : {}),
        ipfsConfigured: !!ipfsConfig,
        accessMode: this.getAccessMode(),
        timeoutUnit: access.timeoutUnit,
      },
      "Nosana SDK initialised"
    );

    this.isInitialized = true;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private requireWallet(): Keypair {
    if (!this.wallet) {
      throw new NosanaNotConfiguredError("Wallet not configured - cannot submit jobs");
    }
    return this.wallet;
  }

  private requireSdk(): Client {
    if (!this.sdk) {
      throw new Error("Nosana SDK not initialised - call initialize() first");
    }
    return this.sdk;
  }

  /** True when a platform credential is loaded (deploys can be paid for). */
  isConfigured(): boolean {
    return this.getAccessMode() !== "none";
  }

  /**
   * The credential that creates NEW deployments. Derived from what is actually
   * loaded: a configured mode whose credential is missing counts as absent,
   * and with no configured mode a loaded wallet means "wallet".
   */
  getAccessMode(): NosanaPrimaryMode {
    if (this.primaryMode === "api_key") return this.apiSdk ? "api_key" : "none";
    if (this.primaryMode === "wallet") return this.wallet ? "wallet" : "none";
    if (this.primaryMode === null) {
      if (this.wallet) return "wallet";
      if (this.apiSdk) return "api_key";
    }
    return "none";
  }

  /** Whether this process holds the credential for `mode` (primary or not). */
  hasAccessMode(mode: NosanaAccessMode): boolean {
    return mode === "wallet" ? this.wallet !== null : this.apiSdk !== null;
  }

  /**
   * The port and funding for an access mode. Omitted `mode` = the primary one.
   * A row passes ITS OWN mode (rowAccessMode(row.nosanaAccessMode)); when this
   * process has no credential for it the error says so by name. A process
   * with no credential at all is "not configured", as it always was - only a
   * process that holds the OTHER credential answers "other account".
   */
  private accessFor(mode?: NosanaAccessMode): NosanaAccess {
    const resolved = mode ?? this.getAccessMode();
    if (resolved === "none") throw new NosanaNotConfiguredError();
    if (!this.hasAccessMode(resolved)) {
      if (this.getAccessMode() === "none") throw new NosanaNotConfiguredError();
      throw new NosanaAccessModeUnavailableError(resolved);
    }
    if (resolved === "api_key") {
      return { mode: resolved, port: this.apiDeploymentsPort(), funding: this.creditsFundingFor() };
    }
    const port = this.deploymentsPort();
    return { mode: resolved, port, funding: vaultFunding(port) };
  }

  /**
   * accessFor for a call about an existing id. A mock id was never on Nosana,
   * so a row's stamped mode needs no credential (null = handle it as a mock).
   */
  private accessForId(id: string, mode?: NosanaAccessMode): NosanaAccess | null {
    if (mode !== undefined && isMockNosanaId(id)) return null;
    return this.accessFor(mode);
  }

  private timeoutUnit(): NosanaTimeoutUnit {
    return getNosanaAccessConfig().timeoutUnit;
  }

  /** The deadline of one SDK call (NOSANA_SDK_TIMEOUT_MS). */
  private sdkCall<T>(fn: () => Promise<T>, what: string): Promise<T> {
    return withDeadline(Promise.resolve().then(fn), getNosanaAccessConfig().sdkTimeoutMs, what);
  }

  /** How a stop Nosana refuses while DRAFT or STARTING is retried. */
  private stopRetry(): StopRetryOptions {
    return { ...DEFAULT_STOP_RETRY, sleep: (ms) => this.sleep(ms) };
  }

  /** The network NEW deployments are created on (the primary credential's). */
  getNetwork(): NosanaNetwork {
    return this.networkFor();
  }

  /**
   * The network a credential's deployments live on. Omitted `mode` = the
   * primary one. A row passes its own mode, as for accessFor.
   */
  private networkFor(mode?: NosanaAccessMode): NosanaNetwork {
    const resolved = mode ?? this.getAccessMode();
    return resolved === "api_key" ? this.apiNetwork : this.network;
  }

  /**
   * Pre-flight for routes: throws NosanaNotConfiguredError /
   * MarketNotConfiguredError so an unconfigured platform answers 501 BEFORE any
   * credits are reserved. The dev-only mock passes (it never touches Nosana).
   */
  assertCanDeploy(tier: string): void {
    if (isNosanaMockEnabled()) return;
    if (this.getAccessMode() === "none") throw new NosanaNotConfiguredError();
    this.resolveMarketAddress(tier);
  }

  /**
   * assertCanDeploy plus, with API-key access, the checks that need Nosana:
   * retail must not be below the market's cost, and the credit balance (read
   * FRESH, fail closed) must cover the estimate plus the floor. Call it before
   * anything is reserved. Wallet access adds no outbound call here.
   *
   * Throws NosanaLifecycleError with code gpu_price_below_cost,
   * nosana_credits_low, nosana_credits_unavailable or nosana_auth_failed.
   */
  async preflightDeploy(
    tier: string,
    replicas: number,
    kind: "service" | "batch" = "service",
    options: { timeoutSeconds?: number } = {},
  ): Promise<void> {
    this.assertCanDeploy(tier);
    if (isNosanaMockEnabled() || this.getAccessMode() !== "api_key") return;

    const marketAddress = this.resolveMarketAddress(tier);
    const estimate = await this.admittingCost(tier, marketAddress);

    const gate = await checkCreditGate({
      reader: this.creditReader(),
      costMicroUsdPerSecond: estimate.costMicroUsdPerSecond,
      replicas,
      reserveSeconds: this.creditEstimateSeconds(kind, options.timeoutSeconds),
      floorMicroUsd: getNosanaAccessConfig().minCreditsMicroUsd,
    });
    if (gate.ok) return;
    logger.error(
      {
        reason: gate.code,
        tier,
        replicas,
        requiredMicroUsd: gate.requiredMicroUsd?.toString(),
        availableMicroUsd: gate.availableMicroUsd?.toString(),
      },
      "New Nosana deployment refused by the platform credit gate"
    );
    throw new NosanaLifecycleError(
      gate.code === "nosana_credits_low"
        ? "The platform's Nosana credits do not cover this deployment and the required floor"
        : gate.code === "nosana_auth_failed"
          ? "Nosana rejected the platform API key"
          : "The platform's Nosana credits could not be read",
      "create",
      { code: gate.code },
    );
  }

  /**
   * The job timeout in seconds, as Nosana will apply it: a value that is not a
   * whole number of the unit it is sent in counts for what it rounds up to, so
   * the vault funding and the credit estimate cover the timeout that is sent.
   */
  private jobTimeoutFor(kind: "service" | "batch", timeoutSeconds?: number): number {
    // Credits pay for what the primary credential creates. Nosana never
    // assigns a credit-paid job whose timeout is under its 50-minute floor, so
    // a shorter one is raised to it here, in the one place the create, the
    // credit estimate and the preflight all read. (The configured defaults are
    // already refused below the floor at start-up.)
    const creditPaid = this.getAccessMode() === "api_key";
    const floor = (seconds: number) => (creditPaid ? creditPaidTimeoutSeconds(seconds) : seconds);
    if (timeoutSeconds !== undefined) {
      if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60) {
        throw new RangeError(`timeoutSeconds must be an integer >= 60, got ${timeoutSeconds}`);
      }
      return effectiveTimeoutSeconds(floor(timeoutSeconds), this.timeoutUnit());
    }
    const cfg = getNosanaDeployConfig();
    return effectiveTimeoutSeconds(
      floor(kind === "batch" ? cfg.batchJobTimeoutSeconds : cfg.jobTimeoutSeconds),
      this.timeoutUnit(),
    );
  }

  /** Seconds a credit estimate covers: a batch its whole timeout, a service at least an hour. */
  private creditEstimateSeconds(kind: "service" | "batch", timeoutSeconds?: number): number {
    const timeout = this.jobTimeoutFor(kind, timeoutSeconds);
    return kind === "batch" ? timeout : Math.max(timeout, MIN_CREDIT_ESTIMATE_SECONDS);
  }

  // ---------------------------------------------------------------------------
  // API-key access: credits, market cost, auth failures
  // ---------------------------------------------------------------------------

  private requireApiAccess(): { apiKey: string; backendUrl: string } {
    if (!this.apiAccess) {
      throw new NosanaNotConfiguredError("Nosana API-key access is not configured: NOSANA_API_KEY is not set");
    }
    return this.apiAccess;
  }

  private creditReader(): CreditReader {
    if (!this.credits) {
      const { apiKey, backendUrl } = this.requireApiAccess();
      this.credits = makeCreditReader({
        fetchBalance: makeCreditBalanceFetcher({ backendUrl, apiKey, fetch: this.fetcher }),
        now: () => new Date(),
        cacheMs: getNosanaAccessConfig().creditsCacheMs,
      });
    }
    return this.credits;
  }

  /**
   * The public market list of the backend `mode`'s deployments live on
   * (omitted = the primary one). No credential is sent.
   */
  private marketCostReader(mode?: NosanaAccessMode): MarketCostReader {
    const access = getNosanaAccessConfig();
    const resolved = mode ?? this.getAccessMode();
    const backendUrl =
      access.apiUrl ?? NOSANA_BACKEND_URLS[resolved === "api_key" ? this.apiNetwork : this.network];
    let reader = this.marketCosts.get(backendUrl);
    if (!reader) {
      reader = makeMarketCostReader({
        fetchMarkets: makeMarketListFetcher({ backendUrl, fetch: this.fetcher }),
        now: () => new Date(),
        cacheMs: access.costCacheMs,
        staleMs: MARKET_COST_STALE_MAX_MS,
        onStale: ({ marketAddress, ageMs, reason }) =>
          logger.warn(
            { marketAddress, ageSeconds: Math.round(ageMs / 1000), reason },
            "Nosana market cost not in the current list - using the last one seen"
          ),
      });
      this.marketCosts.set(backendUrl, reader);
    }
    return reader;
  }

  /**
   * Prepaid credit balance (API-key access only, whether or not it is the
   * primary mode). Cached for NOSANA_CREDITS_CACHE_MS unless `fresh`.
   * Throws NosanaLifecycleError: nosana_auth_failed or nosana_credits_unavailable.
   */
  async getCreditBalance(opts: { fresh?: boolean } = {}): Promise<CreditBalance> {
    try {
      return await this.creditReader().read(opts);
    } catch (err) {
      if (err instanceof NosanaCreditsError) {
        throw new NosanaLifecycleError(err.message, "read", { code: err.code, cause: err });
      }
      throw err;
    }
  }

  /**
   * What each tier's market costs the platform in USD, from Nosana's public
   * market list (no credential; works in either mode). A tier the list does not
   * price is null. THROWS when the list cannot be read.
   */
  async getMarketCosts(): Promise<Record<string, MarketCost | null>> {
    const costs = await this.marketCostReader().read();
    const out: Record<string, MarketCost | null> = {};
    for (const [tier, market] of Object.entries(MARKETS)) {
      out[tier] = costs.get(market.address) ?? null;
    }
    return out;
  }

  /**
   * The smallest available balance the credit gate admits anything with: the
   * floor plus one service replica of the cheapest deployable tier, estimated
   * as preflightDeploy does (except that a tier whose cost is unknown is
   * taken at retail here, where the gate itself refuses it). Null when no tier is deployable here.
   * For the operator view and the public status component, which compare a
   * (cached) balance with it; the gate itself always reads fresh.
   */
  async minimumDeployCreditsMicroUsd(): Promise<bigint | null> {
    let cheapest: bigint | null = null;
    for (const tier of Object.keys(MARKETS)) {
      let marketAddress: string;
      try {
        marketAddress = this.resolveMarketAddress(tier);
      } catch {
        continue; // not deployable on this network
      }
      const { costMicroUsdPerSecond } = await this.estimateCost(marketAddress);
      if (cheapest === null || costMicroUsdPerSecond < cheapest) cheapest = costMicroUsdPerSecond;
    }
    if (cheapest === null) return null;
    return requiredCreditsMicroUsd({
      costMicroUsdPerSecond: cheapest,
      replicas: 1,
      reserveSeconds: this.creditEstimateSeconds("service"),
      floorMicroUsd: getNosanaAccessConfig().minCreditsMicroUsd,
    });
  }

  /**
   * Per-replica cost of a market for a figure that ADMITS NOTHING: the
   * operator view, the public status minimum, the credits runway. The market
   * list is the source; when it is unreadable or does not price the market,
   * the tier's retail price stands in. Never use it to admit a deployment -
   * an unknown cost may be ABOVE retail; that is what admittingCost is for.
   */
  private async estimateCost(
    marketAddress: string,
    mode?: NosanaAccessMode,
  ): Promise<{
    costMicroUsdPerSecond: bigint;
    market: MarketCost | null;
    retailMicroUsdPerSecond: bigint | null;
  }> {
    let market: MarketCost | null = null;
    try {
      market = await this.marketCostReader(mode).costFor(marketAddress);
    } catch (err) {
      logger.warn(
        { error: (err as Error).message, marketAddress },
        "Nosana market list unreadable - estimating from the retail price"
      );
    }
    const retail = this.retailFor(marketAddress);
    if (market) {
      return { costMicroUsdPerSecond: market.costMicroUsdPerSecond, market, retailMicroUsdPerSecond: retail };
    }
    if (retail !== null) {
      return { costMicroUsdPerSecond: retail, market: null, retailMicroUsdPerSecond: retail };
    }
    throw new NosanaLifecycleError(
      `No cost is known for Nosana market ${marketAddress}; refusing to estimate`,
      "market_price",
      { code: "nosana_credits_unavailable" },
    );
  }

  private retailFor(marketAddress: string): bigint | null {
    const catalogEntry = Object.values(MARKETS).find((m) => m.address === marketAddress);
    return catalogEntry ? retailMicroUsdPerSecond(catalogEntry.pricePerSecond) : null;
  }

  /**
   * What one replica of an API-key market costs, for a decision that ADMITS a
   * deployment or extra replicas (pre-flight, create, scale-up). Fails CLOSED:
   * the cost comes from Nosana's market list, or from the last value seen for
   * that market within MARKET_COST_STALE_MAX_MS; with neither, nothing is
   * admitted (code gpu_cost_unavailable). Retail never stands in here - when
   * the cost cannot be read it may have risen above retail, and both the
   * below-cost guard and the credit estimate would pass on a guess.
   *
   * With `tier`, also refuses to sell below cost (code gpu_price_below_cost).
   */
  private async admittingCost(
    tier: string | null,
    marketAddress: string,
  ): Promise<{ costMicroUsdPerSecond: bigint; market: MarketCost }> {
    let market: MarketCost | null;
    let cause: unknown;
    try {
      market = await this.marketCostReader("api_key").costFor(marketAddress);
    } catch (err) {
      market = null;
      cause = err;
    }
    if (!market) {
      logger.error(
        {
          tier,
          marketAddress,
          reason: cause ? "market_list_unreadable" : "market_unpriced",
          ...(cause ? { error: (cause as Error).message } : {}),
        },
        "Nosana cost of a GPU market is unknown - nothing is admitted on it"
      );
      throw new NosanaLifecycleError(
        `The compute cost of Nosana market ${marketAddress} could not be confirmed`,
        "market_price",
        { code: "gpu_cost_unavailable", ...(cause ? { cause } : {}) },
      );
    }
    if (tier !== null) {
      this.assertRetailCoversCost(tier, {
        market,
        retailMicroUsdPerSecond: this.retailFor(marketAddress),
      });
    }
    return { costMicroUsdPerSecond: market.costMicroUsdPerSecond, market };
  }

  /** Refuses (API-key request path) to sell a tier below what Nosana charges for it. */
  private assertRetailCoversCost(
    tier: string,
    estimate: { market: MarketCost | null; retailMicroUsdPerSecond: bigint | null },
  ): void {
    const { market, retailMicroUsdPerSecond: retail } = estimate;
    if (!market || retail === null || retail >= market.costMicroUsdPerSecond) return;
    logger.error(
      {
        tier,
        retailMicroUsdPerSecond: retail.toString(),
        costMicroUsdPerSecond: market.costMicroUsdPerSecond.toString(),
      },
      "GPU tier is priced below its Nosana cost - deployment refused"
    );
    throw new NosanaLifecycleError(
      `GPU tier ${tier} is priced below its compute cost`,
      "market_price",
      { code: "gpu_price_below_cost" },
    );
  }

  private creditsFundingFor(): DeploymentFunding {
    return creditsFunding({
      getAvailableMicroUsd: async () =>
        (await this.creditReader().read({ fresh: true })).availableMicroUsd,
      getCachedAvailableMicroUsd: async () => (await this.creditReader().read()).availableMicroUsd,
      // The gate (create, scale-up) refuses on an unknown cost; the runway
      // figure admits nothing and may approximate.
      costMicroUsdPerSecond: async (marketAddress) =>
        (await this.admittingCost(null, marketAddress)).costMicroUsdPerSecond,
      runwayCostMicroUsdPerSecond: async (marketAddress) =>
        (await this.estimateCost(marketAddress, "api_key")).costMicroUsdPerSecond,
      minMicroUsd: getNosanaAccessConfig().minCreditsMicroUsd,
    });
  }

  private authFailed(cause: unknown): NosanaLifecycleError {
    return new NosanaLifecycleError("Nosana rejected the platform API key", "read", {
      code: "nosana_auth_failed",
      cause,
    });
  }

  /**
   * Names an authentication failure. The SDK cannot: a 401 body is the bare
   * string "Unauthorized", which its error formatter drops, leaving the same
   * message as any other failure. So when an API-key call fails, the credit
   * balance endpoint (whose HTTP status we do see) is asked once, and the
   * answer is remembered for NOSANA_CREDITS_CACHE_MS.
   */
  private async classifyApiError(err: unknown): Promise<unknown> {
    if (err instanceof NosanaLifecycleError) return err;
    if (/unauthori[sz]ed/i.test(err instanceof Error ? err.message : String(err))) {
      return this.authFailed(err);
    }
    const now = Date.now();
    const cacheMs = getNosanaAccessConfig().creditsCacheMs;
    if (this.authProbe === null || now - this.authProbe.at >= cacheMs) {
      let failed = false;
      try {
        await this.creditReader().read({ fresh: true });
      } catch (probeError) {
        failed = probeError instanceof NosanaCreditsError && probeError.code === "nosana_auth_failed";
      }
      this.authProbe = { at: now, failed };
    }
    return this.authProbe.failed ? this.authFailed(err) : err;
  }

  /** An API-key SDK call: under the deadline, and an authentication failure named. */
  private async apiCall<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await this.sdkCall(fn, what);
    } catch (err) {
      // Out of time says nothing about the key: no balance probe for it.
      if (err instanceof NosanaDeadlineError) throw err;
      throw await this.classifyApiError(err);
    }
  }

  private requireApiSdk(): ApiSdkLike {
    if (!this.apiSdk) throw new NosanaAccessModeUnavailableError("api_key");
    return this.apiSdk;
  }

  /**
   * Wraps an SDK deployment so its actions run under the deadline (`call`).
   * The SDK mutates its own object after start/stop/scale, so status and
   * replicas are read through. An API-key deployment has no vault (the SDK's
   * object carries a placeholder, which must not be mistaken for one); a
   * wallet one keeps its own, whose on-chain calls are not wrapped.
   */
  private adaptDeployment(
    raw: unknown,
    call: <T>(fn: () => Promise<T>, what: string) => Promise<T>,
    withVault: boolean,
  ): SdkDeploymentLike {
    const sdkDeployment = raw as SdkDeploymentLike;
    const id = () => String(sdkDeployment.id);
    const adapted: SdkDeploymentLike = {
      get id() {
        return id();
      },
      get status() {
        return sdkDeployment.status;
      },
      get replicas() {
        return sdkDeployment.replicas;
      },
      get endpoints() {
        return sdkDeployment.endpoints;
      },
      get jobs() {
        return sdkDeployment.jobs;
      },
      get events() {
        return sdkDeployment.events;
      },
      start: () => call(() => sdkDeployment.start(), `Starting Nosana deployment ${id()}`),
      stop: () => call(() => sdkDeployment.stop(), `Stopping Nosana deployment ${id()}`),
      updateReplicaCount: (replicas: number) =>
        call(
          () => sdkDeployment.updateReplicaCount(replicas),
          `Updating the replica count of Nosana deployment ${id()}`,
        ),
    };
    if (withVault) {
      Object.defineProperty(adapted, "vault", { get: () => sdkDeployment.vault, enumerable: true });
    }
    return adapted;
  }

  private adaptApiDeployment(raw: unknown): SdkDeploymentLike {
    return this.adaptDeployment(raw, (fn, what) => this.apiCall(fn, what), false);
  }

  private adaptWalletDeployment(raw: unknown): SdkDeploymentLike {
    return this.adaptDeployment(raw, (fn, what) => this.sdkCall(fn, what), true);
  }

  /** The lifecycle port over the API-key client: same REST API, no chain reads. */
  private apiDeploymentsPort(): NosanaDeploymentsPort {
    const sdk = this.requireApiSdk();
    const unit = this.timeoutUnit();
    return {
      create: async (body: CreateDeploymentBody) =>
        this.adaptApiDeployment(
          await this.apiCall(
            () =>
              sdk.deployments.create({
                ...body,
                timeout: secondsToSdkTimeout(body.timeout, unit),
              }),
            "Creating a Nosana deployment",
          ),
        ),
      get: async (id: string) =>
        this.adaptApiDeployment(
          await this.apiCall(() => sdk.deployments.get(id), `Reading Nosana deployment ${id}`),
        ),
      getMarketJobPrice: async () => {
        throw new Error("The on-chain market price is not used with API-key access");
      },
      findByIdempotencyKey: async (key: string) =>
        (await this.findDeploymentByIdempotencyKey(key, "api_key"))?.id ?? null,
    };
  }

  /**
   * Market address for a tier on the network of `mode`'s deployments (omitted
   * = the primary credential's), or an honest error.
   */
  resolveMarketAddress(tier: string, mode?: NosanaAccessMode): string {
    return resolveMarketAddress(tier, this.networkFor(mode));
  }

  /**
   * Map a raw SDK Market onto ChainMarket. `jobPrice` is a u64 (an anchor BN at
   * runtime, typed `number` by the SDK) in NOS base units per second.
   */
  private mapSdkMarket(sdkMarket: {
    address?: unknown;
    jobPrice?: unknown;
    queue?: unknown;
  }): ChainMarket {
    const rawAddress = sdkMarket.address as { toBase58?: () => string } | string | undefined;
    const address =
      typeof rawAddress === "object" && rawAddress !== null && typeof rawAddress.toBase58 === "function"
        ? rawAddress.toBase58()
        : String(rawAddress ?? "");

    return {
      address,
      jobPriceNosBaseUnitsPerSecond: toBaseUnits(sdkMarket.jobPrice),
      queueLength: Array.isArray(sdkMarket.queue) ? sdkMarket.queue.length : 0,
    };
  }

  /**
   * Map a Nosana SDK Job state number to our status string.
   * Nosana job states: 0 = queued, 1 = running, 2 = completed, 3 = failed/stopped
   */
  private mapJobState(state: string | number): NosanaJob["status"] {
    const n = typeof state === "string" ? parseInt(state, 10) : state;
    switch (n) {
      case 0:
        return "queued";
      case 1:
        return "running";
      case 2:
        return "completed";
      default:
        return "failed";
    }
  }

  /** The lifecycle module's port, backed by the real SDK. */
  private deploymentsPort(): NosanaDeploymentsPort {
    const sdk = this.requireSdk();
    const unit = this.timeoutUnit();
    return {
      // `timeout` is seconds everywhere in our code; it becomes the Deployment
      // Manager's unit here and nowhere else (a no-op for "seconds").
      create: async (body: CreateDeploymentBody) =>
        this.adaptWalletDeployment(
          await this.sdkCall(
            () =>
              sdk.deployments.create(
                { ...body, timeout: secondsToSdkTimeout(body.timeout, unit) } as unknown as Parameters<
                  typeof sdk.deployments.create
                >[0]
              ),
            "Creating a Nosana deployment",
          ),
        ),
      get: async (id: string) =>
        this.adaptWalletDeployment(
          await this.sdkCall(() => sdk.deployments.get(id), `Reading Nosana deployment ${id}`),
        ),
      getMarketJobPrice: async (marketAddress: string) => {
        const market = await sdk.jobs.getMarket(marketAddress);
        return toBaseUnits((market as { jobPrice?: unknown }).jobPrice);
      },
      // Only with the wallet loaded: the lookup is a signed request. The
      // keyless read port (no credential at all) never creates anything.
      ...(this.wallet
        ? {
            findByIdempotencyKey: async (key: string) =>
              (await this.findDeploymentByIdempotencyKey(key, "wallet"))?.id ?? null,
          }
        : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Live chain read of every Nosana market. Prices are NOS base units per
   * second - a different unit from MARKETS[tier].pricePerSecond (USD), which is
   * why this returns its own type. THROWS on RPC failure: the static catalog is
   * pricing configuration, not a stand-in for chain state.
   */
  async getChainMarkets(): Promise<ChainMarket[]> {
    const sdk = this.requireSdk();
    const rawMarkets = await sdk.jobs.allMarkets();
    logger.debug({ count: rawMarkets.length }, "Fetched markets from chain");
    return rawMarkets.map((m) => this.mapSdkMarket(m as never));
  }

  /** On-chain job price (NOS base units / second) for one market. */
  async getMarketJobPrice(marketAddress: string): Promise<bigint> {
    return this.deploymentsPort().getMarketJobPrice(marketAddress);
  }

  /**
   * Get specific market by tier key. Static catalog (USD retail pricing, VRAM);
   * never queries chain individually to avoid latency on the hot path.
   */
  async getMarket(tier: string): Promise<NosanaMarket | null> {
    return Object.hasOwn(MARKETS, tier) ? (MARKETS[tier] ?? null) : null;
  }

  /** The platform wallet's address (public), or null when no wallet is loaded. */
  getWalletAddress(): string | null {
    return this.wallet ? this.wallet.publicKey.toBase58() : null;
  }

  /**
   * Get real NOS + SOL balance for the configured wallet.
   */
  async getWalletBalance(): Promise<{ sol: number; nos: number }> {
    this.requireWallet(); // guard: wallet must be configured
    const sdk = this.requireSdk();

    const [solLamports, nosToken] = await Promise.all([
      this.connection.getBalance(this.wallet!.publicKey),
      sdk.solana.getNosBalance(this.wallet!.publicKey).catch((err: unknown) => {
        logger.warn(
          { error: (err as Error).message },
          "Failed to fetch NOS balance - defaulting to 0"
        );
        return undefined;
      }),
    ]);

    return {
      sol: solLamports / 1e9,
      nos: nosToken ? Number(nosToken.uiAmount ?? 0) : 0,
    };
  }

  /**
   * Submit a single one-shot job to a Nosana market (legacy path, used by
   * OpenClaw). It has NO extend strategy: the job ends at
   * NOSANA_SINGLE_JOB_TIMEOUT_SECONDS. Long-running inference goes through
   * createDeployment.
   *
   * Flow:
   *  1. Resolve the market address for the tier on this network.
   *  2. Pin job definition to IPFS via the SDK (uses Pinata under the hood).
   *  3. Call nosana.jobs.list() to create the on-chain job listing.
   *  4. Return a NosanaJob with the on-chain job address as the ID.
   *
   * A failure is a failure. Only the dev-only mock (isNosanaMockEnabled) may
   * substitute a fake `mock_job_*` id, and it logs loudly when it does.
   */
  async submitJob(
    definition: NosanaJobDefinition,
    marketTier: string
  ): Promise<NosanaJob> {
    // Never guess which account pays: with API-key access as the primary mode
    // a one-shot job is refused, even when a wallet is also loaded.
    if (this.getAccessMode() === "api_key") throw new NosanaOneShotUnavailableError();
    this.requireWallet();
    const sdk = this.requireSdk();

    const market = await this.getMarket(marketTier);
    if (!market) {
      throw new MarketNotConfiguredError(marketTier, this.network, "unknown_tier");
    }
    const marketAddress = this.resolveMarketAddress(marketTier);

    logger.info(
      { market: market.name, jobType: definition.type },
      "Submitting job to Nosana"
    );

    try {
      // nosana.jobs.list() accepts a JobDefinition directly; it will pin to
      // IPFS internally and create the on-chain listing.
      const result = await sdk.jobs.list(
        definition as unknown as Parameters<typeof sdk.jobs.list>[0],
        getNosanaDeployConfig().singleJobTimeoutSeconds,
        marketAddress
      );

      // result is { tx, job, run } when instructionOnly is false (default)
      const { job: jobAddress } =
        result as { tx: string; job: string; run: string };

      logger.info({ jobId: jobAddress, market: market.name }, "Job listed on-chain");

      return {
        id: jobAddress,
        market: marketAddress,
        status: "queued",
        startTime: new Date(),
      };
    } catch (error) {
      if (!isNosanaMockEnabled()) {
        logger.error(
          { error: (error as Error).message, market: market.name },
          "Nosana job submission failed"
        );
        throw error;
      }
      logger.warn(
        { error: (error as Error).message, market: market.name, mock: true },
        "MOCK: SDK job submission failed - returning a FAKE mock_job id (ALLOW_NOSANA_MOCK, development only)"
      );

      return {
        id: `mock_job_${Date.now().toString(36)}`,
        market: marketAddress,
        status: "queued",
        startTime: new Date(),
      };
    }
  }

  /** Map a raw SDK job onto our NosanaJob shape. */
  private toNosanaJob(
    jobId: string,
    sdkJob: {
      node?: unknown;
      market?: { toBase58?: () => string };
      state: string | number;
      timeStart?: number | null;
      timeEnd?: number | null;
      price?: number | null;
    }
  ): NosanaJob {
    const nodeStr = sdkJob.node ? String(sdkJob.node) : "";
    const hasRealNode = nodeStr && nodeStr !== SYSTEM_PROGRAM_ZERO_PUBKEY;
    const nodeUrl = hasRealNode ? `https://${nodeStr}.node.nos.ci` : undefined;
    const nodePubkey = hasRealNode ? nodeStr : undefined;

    return {
      id: jobId,
      market: sdkJob.market?.toBase58?.() ?? "",
      status: this.mapJobState(sdkJob.state),
      nodeUrl,
      nodePubkey,
      startTime: sdkJob.timeStart
        ? new Date(sdkJob.timeStart * 1000)
        : undefined,
      endTime: sdkJob.timeEnd
        ? new Date(sdkJob.timeEnd * 1000)
        : undefined,
      cost: sdkJob.price ? sdkJob.price / 1e6 : undefined,
    };
  }

  /**
   * Query on-chain job status for a given ON-CHAIN JOB address (not a
   * Deployment-Manager id - use getDeploymentStatus for those).
   * Falls back to a "running" stub if the RPC call fails.
   */
  async getJobStatus(jobId: string): Promise<NosanaJob | null> {
    const sdk = this.requireSdk();

    logger.debug({ jobId }, "Getting job status");

    // Mock IDs (created by the dev-only fallback) cannot be queried on-chain
    if (jobId.startsWith("mock_job_")) {
      return {
        id: jobId,
        market: "",
        status: "running",
        startTime: new Date(),
      };
    }

    try {
      const sdkJob = await sdk.jobs.get(jobId);
      return this.toNosanaJob(jobId, sdkJob);
    } catch (error) {
      logger.warn(
        { jobId, error: (error as Error).message },
        "Failed to fetch job from chain - returning stub"
      );

      return {
        id: jobId,
        market: "",
        status: "running",
        startTime: new Date(),
      };
    }
  }

  /**
   * Strict on-chain job read: THROWS on SDK/RPC failure instead of returning a
   * "running" stub. Mock IDs also throw - mock handling is env-gated at the
   * tick layer, not here.
   *
   * NOTE: takes an on-chain job address. Deployment-Manager ids (what
   * `Deployment.nosanaJobIds` holds) are NOT job addresses and make
   * `jobs.get` throw; use getDeploymentStatus for those.
   */
  async getJobStatusStrict(jobId: string): Promise<NosanaJob> {
    const sdk = this.requireSdk();

    if (isMockNosanaId(jobId)) {
      throw new Error(`Mock Nosana id cannot be queried on-chain: ${jobId}`);
    }

    const sdkJob = await sdk.jobs.get(jobId);
    return this.toNosanaJob(jobId, sdkJob);
  }

  private mockDeployment(
    marketAddress: string,
    replicas: number,
    reason: string
  ): NosanaDeployment {
    logger.warn(
      { reason, mock: true },
      "MOCK: returning a FAKE mock_deploy id - nothing is running on Nosana (ALLOW_NOSANA_MOCK, development only)"
    );
    return {
      id: `mock_deploy_${Date.now().toString(36)}`,
      market: marketAddress,
      replicas,
      status: "active",
      endpoints: [],
      mock: true,
    };
  }

  /**
   * Create, FUND and START a deployment via the Nosana Deployment Manager.
   *
   * `sdk.deployments.create()` alone yields a DRAFT with an empty vault - no GPU
   * host would ever run it. The lifecycle (nosanaDeploymentLifecycle.ts) tops the
   * vault up with NOS + SOL and calls start(); on any failure after creation it
   * stops and withdraws so platform funds are not stranded, then throws a
   * NosanaLifecycleError carrying the Nosana deployment id for the caller to
   * persist.
   *
   * With API-key access there is no vault: the credit gate runs first, then
   * create and start. The result names the access mode that was used.
   */
  async createDeployment(
    definition: NosanaJobDefinition,
    marketTier: string,
    replicas: number,
    options: CreateDeploymentOptions = {}
  ): Promise<NosanaDeployment> {
    const mockEnabled = isNosanaMockEnabled();

    if (this.getAccessMode() === "none") {
      if (mockEnabled) return this.mockDeployment("", replicas, "no wallet configured");
      throw new NosanaNotConfiguredError();
    }
    const access = this.accessFor();

    const market = await this.getMarket(marketTier);
    if (!market) {
      throw new MarketNotConfiguredError(marketTier, this.getNetwork(), "unknown_tier");
    }

    let marketAddress: string;
    try {
      marketAddress = this.resolveMarketAddress(marketTier);
    } catch (error) {
      if (mockEnabled && error instanceof MarketNotConfiguredError) {
        return this.mockDeployment("", replicas, error.message);
      }
      throw error;
    }

    const cfg = getNosanaDeployConfig();
    const batch = options.kind === "batch";
    const kind = batch ? "batch" : "service";
    const jobTimeoutSeconds = this.jobTimeoutFor(kind, options.timeoutSeconds);
    // Wallet: seconds of run-time the vault is funded for. API key: seconds the
    // credit estimate covers. A per-call timeout never funds less than itself.
    const fundSeconds =
      access.mode === "api_key"
        ? this.creditEstimateSeconds(kind, options.timeoutSeconds)
        : batch
          ? jobTimeoutSeconds
          : Math.max(cfg.vaultFundSeconds, jobTimeoutSeconds);

    logger.info(
      { market: market.name, replicas, kind: options.kind ?? "service", jobTimeoutSeconds },
      "Creating Nosana deployment"
    );

    try {
      if (access.mode === "api_key") await this.admittingCost(marketTier, marketAddress);
      const created = await createAndStartDeployment(
        access.port,
        {
          name: options.name ?? `${NOSANA_DEPLOYMENT_NAME_PREFIX}${Date.now().toString(36)}`,
          marketAddress,
          replicas,
          jobTimeoutSeconds,
          definition,
          fundSeconds,
          strategy: batch ? "SIMPLE" : cfg.strategy,
          solFeeLamportsPerReplica: cfg.vaultSolLamportsPerReplica,
          networkFeeBps: cfg.networkFeeBps,
          stopRetry: this.stopRetry(),
        },
        access.funding,
      );

      if (created.recoveredFromCreateError !== undefined) {
        logger.warn(
          {
            deploymentId: created.deploymentId,
            accessMode: access.mode,
            createError: created.recoveredFromCreateError,
          },
          "Nosana deployment create failed, but the deployment it made was found by its idempotency key and started",
        );
      }

      logger.info(
        {
          deploymentId: created.deploymentId,
          replicas,
          strategy: created.strategy,
          accessMode: access.mode,
          fundedNosBaseUnits: created.funding?.nosBaseUnits.toString(),
          fundedSolLamports: created.funding?.solLamports.toString(),
          estimateMicroUsd: created.estimateMicroUsd?.toString(),
        },
        "Nosana deployment created, funded and started"
      );

      return {
        id: created.deploymentId,
        market: marketAddress,
        replicas,
        status: "active",
        endpoints: [],
        vaultAddress: created.vaultAddress,
        accessMode: access.mode,
      };
    } catch (error) {
      if (error instanceof NosanaLifecycleError) error.accessMode = access.mode;
      if (!mockEnabled) {
        logger.error(
          {
            error: (error as Error).message,
            market: market.name,
            replicas,
            deploymentId: (error as { deploymentId?: string }).deploymentId,
            deploymentName: (error as { deploymentName?: string }).deploymentName,
            mayExistOnNosana: (error as { mayExistOnNosana?: boolean }).mayExistOnNosana,
            stage: (error as { stage?: string }).stage,
            code: (error as { code?: string }).code,
            // What the SDK threw, as it threw it (its message keeps one field
            // of Nosana's answer; the whole answer of a refused create is
            // logged, redacted, by reportCreateRefusal).
            cause: describeCause((error as { cause?: unknown }).cause),
          },
          "Nosana deployment creation failed"
        );
        throw error;
      }
      return this.mockDeployment(marketAddress, replicas, (error as Error).message);
    }
  }

  /**
   * STRICT read of a Deployment-Manager deployment: status, REAL endpoints
   * reported by Nosana, and (per `include`, both by default) its newest jobs
   * and events, which Nosana serves from their own routes. Throws on API
   * failure, of any of the reads (and on mock ids) - a failed read must never
   * become a fabricated state.
   */
  async getDeploymentStatus(
    deploymentId: string,
    mode?: NosanaAccessMode,
    include: DeploymentReadInclude = {},
  ): Promise<DeploymentSnapshot> {
    if (isMockNosanaId(deploymentId)) {
      this.requireSdk();
      throw new Error(`Mock Nosana id cannot be queried: ${deploymentId}`);
    }
    const snapshot = await readDeployment(this.readPort(mode), deploymentId);
    // With no credential at all the keyless read above is all there is.
    if (this.getAccessMode() === "none") return snapshot;
    const wantJobs = include.jobs ?? true;
    const whenHalted = include.events === "when_halted";
    const wantEvents = whenHalted
      ? snapshot.status === "error" || snapshot.status === "insufficient_funds"
      : (include.events ?? true);
    const readEvents = (): Promise<EventSnapshot[]> =>
      this.listDeploymentEvents(deploymentId, mode, { count: include.eventCount ?? SNAPSHOT_EVENTS_LIMIT });
    const [jobs, events] = await Promise.all([
      wantJobs ? this.listDeploymentJobs(deploymentId, mode, { count: SNAPSHOT_JOBS_LIMIT }) : snapshot.jobs,
      !wantEvents
        ? snapshot.events
        : whenHalted
          ? // Only the failure text depends on these events. The halted state
            // itself is already read, and it must reach the caller: a read that
            // threw here would leave a halted deployment `running`, billed and
            // never stopped for as long as the events route fails.
            readEvents().catch((err) => {
              logger.warn(
                { deploymentId, status: snapshot.status, error: (err as Error).message },
                "Could not read the events of a halted Nosana deployment; reporting it without them"
              );
              return snapshot.events;
            })
          : readEvents(),
    ]);
    return { ...snapshot, jobs, events };
  }

  /**
   * The port for a read. With no credential at all, the wallet client's
   * keyless read stays available, as it always was (whatever mode is named).
   */
  private readPort(mode?: NosanaAccessMode): NosanaDeploymentsPort {
    if (this.getAccessMode() === "none") {
      this.requireSdk();
      return this.deploymentsPort();
    }
    return this.accessFor(mode).port;
  }

  /** The raw SDK deployment object, for the actions the lifecycle port does not carry. */
  private async rawDeployment(
    deploymentId: string,
    mode?: NosanaAccessMode
  ): Promise<{ access: NosanaAccess; deployment: Record<string, unknown> }> {
    const access = this.accessFor(mode);
    const deployment =
      access.mode === "api_key"
        ? await this.apiCall(
            () => this.requireApiSdk().deployments.get(deploymentId),
            `Reading Nosana deployment ${deploymentId}`,
          )
        : await this.sdkCall(
            () => this.requireSdk().deployments.get(deploymentId),
            `Reading Nosana deployment ${deploymentId}`,
          );
    return { access, deployment: deployment as unknown as Record<string, unknown> };
  }

  // ---------------------------------------------------------------------------
  // Direct REST reads: the lists the SDK reads wrongly (paginated bodies)
  // ---------------------------------------------------------------------------

  /**
   * Where a direct read of `mode`'s account goes and how it authenticates: the
   * API key as a Bearer token, or the wallet's signed header exactly as the
   * SDK's own API client builds it (x-user-id plus a signature over
   * "NosanaApiAuthentication" with the time).
   */
  private async restAccess(
    mode: NosanaAccessMode,
  ): Promise<{ baseUrl: string; headers: Record<string, string> }> {
    if (mode === "api_key") {
      const { apiKey, backendUrl } = this.requireApiAccess();
      return { baseUrl: backendUrl, headers: { Authorization: `Bearer ${apiKey}` } };
    }
    const wallet = this.requireWallet();
    const authorization = (this.requireSdk() as unknown as {
      authorization?: { generate(message: string, options: { includeTime: boolean }): Promise<string> };
    }).authorization;
    if (typeof authorization?.generate !== "function") {
      throw new NosanaLifecycleError("The wallet client cannot sign a Nosana API request", "read");
    }
    return {
      baseUrl: NOSANA_BACKEND_URLS[this.network],
      headers: {
        "x-user-id": wallet.publicKey.toBase58(),
        Authorization: await authorization.generate("NosanaApiAuthentication", { includeTime: true }),
      },
    };
  }

  /** One GET under {backend}/api. `what` names the resource in errors. */
  private async restGet(
    mode: NosanaAccessMode,
    path: string,
    query: Record<string, string | number | undefined>,
    what: string,
  ): Promise<unknown> {
    const { baseUrl, headers } = await this.restAccess(mode);
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const qs = search.toString();
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetcher(`${baseUrl}/api${path}${qs ? `?${qs}` : ""}`, {
        method: "GET",
        headers: { ...headers, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch (err) {
      throw new NosanaLifecycleError(`${what} could not be fetched`, "read", { cause: err });
    }
    if (mode === "api_key" && (response.status === 401 || response.status === 403)) {
      throw this.authFailed(undefined);
    }
    if (!response.ok) {
      throw new NosanaLifecycleError(`${what} answered HTTP ${response.status}`, "read");
    }
    return response.json().catch(() => null);
  }

  /** Every page of a list (limit 100, following cursor_next, capped). */
  private async restListAll(
    mode: NosanaAccessMode,
    path: string,
    query: Record<string, string | number | undefined>,
    key: string,
    what: string,
  ): Promise<unknown[]> {
    try {
      const { items } = await collectNosanaPages(
        (cursor) =>
          this.restGet(mode, path, { ...query, limit: NOSANA_PAGE_LIMIT, cursor: cursor ?? undefined }, what),
        key,
      );
      return items;
    } catch (err) {
      if (err instanceof NosanaPaginationError) {
        throw new NosanaLifecycleError(`${what}: ${err.message}`, "read", { cause: err });
      }
      throw err;
    }
  }

  /**
   * The newest `count` rows of a list (sort_order desc): one page of the
   * smallest size that holds them, following cursor_next only past 100.
   */
  private async restListNewest(
    mode: NosanaAccessMode,
    path: string,
    query: Record<string, string | number | undefined>,
    key: string,
    count: number,
    what: string,
  ): Promise<unknown[]> {
    if (!Number.isSafeInteger(count) || count < 1) throw new RangeError(`count must be a positive integer, got ${count}`);
    const limit = PAGE_SIZES.find((size) => size >= count) ?? NOSANA_PAGE_LIMIT;
    const items: unknown[] = [];
    let cursor: string | null = null;
    for (let pages = 1; ; pages += 1) {
      const page = readNosanaPage(
        await this.restGet(mode, path, { ...query, limit, sort_order: "desc", cursor: cursor ?? undefined }, what),
        key,
      );
      if (!page) throw new NosanaLifecycleError(`${what} is not a list`, "read");
      items.push(...page.items);
      if (items.length >= count || page.cursorNext === null || page.cursorNext === cursor) break;
      if (pages >= NOSANA_MAX_LIST_PAGES) break;
      cursor = page.cursorNext;
    }
    return items.slice(0, count);
  }

  /** The access mode a direct read of an existing id goes through (the row's, else the primary). */
  private restMode(mode?: NosanaAccessMode): NosanaAccessMode {
    return this.accessFor(mode).mode;
  }

  /**
   * Nosana's own list of this account's deployments (read-only), every page.
   * A direct GET in both modes, never the SDK's list(): 0.4.74 maps the body
   * as an array (it is an object now) and parses every `owner` as a public
   * key; 0.4.87 reads the first page only. Throws rather than return a list
   * it could not read whole.
   */
  async listDeployments(mode?: NosanaAccessMode): Promise<NosanaDeploymentSummary[]> {
    const resolved = this.restMode(mode);
    const rows = await this.restListAll(resolved, "/deployments", {}, "deployments", "Nosana's deployment list");
    return this.toSummaries(rows, resolved);
  }

  private toSummaries(rows: unknown[], mode: NosanaAccessMode): NosanaDeploymentSummary[] {
    return rows
      .map((row) => toDeploymentSummary(row, mode))
      .filter((row): row is NosanaDeploymentSummary => row !== null);
  }

  /**
   * The deployment with exactly this name, newest first when Nosana holds
   * several; null when there is none. This is how a deployment whose create
   * call threw (NosanaLifecycleError.mayExistOnNosana) is looked for. The
   * server filters (exact, case-sensitive); the name is checked again here.
   */
  async findDeploymentByName(
    name: string,
    mode?: NosanaAccessMode
  ): Promise<NosanaDeploymentSummary | null> {
    const resolved = this.restMode(mode);
    const rows = await this.restListAll(resolved, "/deployments", { name }, "deployments", "Nosana's deployment list");
    const matches = this.toSummaries(rows, resolved)
      .filter((row) => row.name === name)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    return matches[0] ?? null;
  }

  /**
   * The deployment created with this idempotency_key; null when there is
   * none. Nosana keeps the key unique, so more than one answer means the
   * filter was not applied, and that THROWS rather than pick one.
   */
  async findDeploymentByIdempotencyKey(
    idempotencyKey: string,
    mode?: NosanaAccessMode
  ): Promise<NosanaDeploymentSummary | null> {
    const resolved = this.restMode(mode);
    const rows = await this.restListAll(
      resolved,
      "/deployments",
      { idempotency_key: idempotencyKey },
      "deployments",
      "Nosana's deployment list",
    );
    // A row that names a key must name this one; a row that does not was
    // selected by the server's filter.
    const matches = this.toSummaries(rows, resolved).filter(
      (row) => row.idempotencyKey === null || row.idempotencyKey === idempotencyKey,
    );
    if (matches.length > 1) {
      throw new NosanaLifecycleError(
        `Nosana answered ${matches.length} deployments for one idempotency key; the filter was not applied`,
        "read",
      );
    }
    return matches[0] ?? null;
  }

  /**
   * A deployment's jobs, newest first (GET .../jobs): the newest `count`
   * (default 10), or every page with `all`. `state` filters on Nosana's job
   * state.
   */
  async listDeploymentJobs(
    deploymentId: string,
    mode?: NosanaAccessMode,
    options: { state?: "QUEUED" | "RUNNING" | "COMPLETED" | "STOPPED"; count?: number; all?: boolean } = {},
  ): Promise<JobSnapshot[]> {
    if (isMockNosanaId(deploymentId)) {
      throw new Error(`Mock Nosana id cannot be queried: ${deploymentId}`);
    }
    const resolved = this.restMode(mode);
    const path = `/deployments/${encodeURIComponent(deploymentId)}/jobs`;
    const what = `The jobs of Nosana deployment ${deploymentId}`;
    const rows = options.all
      ? await this.restListAll(resolved, path, { state: options.state, sort_order: "desc" }, "jobs", what)
      : await this.restListNewest(resolved, path, { state: options.state }, "jobs", options.count ?? 10, what);
    return newestFirst(
      toJobSnapshots(
        rows.filter((row): row is SdkJobLike => isRecordWith(row, "job")),
      ),
    );
  }

  /** A deployment's events, newest first (GET .../events): the newest `count` (default 20, at most 1000). */
  async listDeploymentEvents(
    deploymentId: string,
    mode?: NosanaAccessMode,
    options: { count?: number } = {},
  ): Promise<EventSnapshot[]> {
    if (isMockNosanaId(deploymentId)) {
      throw new Error(`Mock Nosana id cannot be queried: ${deploymentId}`);
    }
    const rows = await this.restListNewest(
      this.restMode(mode),
      `/deployments/${encodeURIComponent(deploymentId)}/events`,
      {},
      "events",
      Math.min(options.count ?? SNAPSHOT_EVENTS_LIMIT, MAX_EVENT_COUNT),
      `The events of Nosana deployment ${deploymentId}`,
    );
    return newestFirst(toEventSnapshots(rows.filter((row): row is SdkEventLike => isRecordWith(row, "type"))));
  }

  /**
   * One job of a deployment (state, host node, start/end), via the SDK's
   * deployment.getJob. The state arrives as a number or a string and the time
   * fields have no documented unit: see DeploymentJobSnapshot.
   */
  async getDeploymentJob(
    deploymentId: string,
    jobAddress: string,
    mode?: NosanaAccessMode
  ): Promise<DeploymentJobSnapshot> {
    if (isMockNosanaId(deploymentId)) {
      throw new Error(`Mock Nosana id cannot be queried: ${deploymentId}`);
    }
    const { access, deployment } = await this.rawDeployment(deploymentId, mode);
    const getJob = deployment.getJob as ((job: string) => Promise<unknown>) | undefined;
    if (typeof getJob !== "function") {
      throw new NosanaLifecycleError(
        `Nosana deployment ${deploymentId} does not expose its jobs`,
        "read",
        { deploymentId },
      );
    }
    let raw: unknown;
    try {
      raw =
        access.mode === "api_key"
          ? await this.apiCall(() => getJob(jobAddress), `Reading job ${jobAddress}`)
          : await this.sdkCall(() => getJob(jobAddress), `Reading job ${jobAddress}`);
    } catch (err) {
      if (err instanceof NosanaLifecycleError) throw err;
      throw new NosanaLifecycleError(
        `Could not read job ${jobAddress} of Nosana deployment ${deploymentId}: ${(err as Error).message}`,
        "read",
        { deploymentId, cause: err },
      );
    }
    return normalizeDeploymentJob(deploymentId, jobAddress, raw);
  }

  /**
   * Change a deployment's per-job timeout. `timeoutSeconds` is ours (seconds);
   * the Deployment Manager is sent the value in NOSANA_TIMEOUT_UNIT, rounded
   * up. The SDK refuses a value below 60 in whatever unit that is, and so
   * does Nosana (minimum 60 minutes for every strategy), so nothing under one
   * hour can be set this way.
   *
   * An increase extends a running job once, by the difference. A decrease
   * does NOT shorten a job that is already running - it was prepaid for its
   * full timeout when it was listed - and applies to the next jobs only
   * (nosana-deployment-manager at 127f915,
   * strategies/all/deploymentTimeoutUpdate.ts:22-80). To end a job early,
   * stop the deployment.
   */
  async updateDeploymentTimeout(
    deploymentId: string,
    timeoutSeconds: number,
    mode?: NosanaAccessMode
  ): Promise<{ deploymentId: string; timeoutSeconds: number; sentTimeout: number; unit: NosanaTimeoutUnit }> {
    const unit = this.timeoutUnit();
    const sentTimeout = secondsToSdkTimeout(timeoutSeconds, unit);
    if (sentTimeout < SDK_MIN_UPDATE_TIMEOUT) {
      throw new NosanaLifecycleError(
        `A timeout of ${timeoutSeconds}s is ${sentTimeout} ${unit}; the Nosana SDK refuses an update below ${SDK_MIN_UPDATE_TIMEOUT}`,
        "scale",
        { deploymentId, code: "nosana_timeout_too_short" },
      );
    }
    const { access, deployment } = await this.rawDeployment(deploymentId, mode);
    const updateTimeout = (deployment.updateTimeout as (timeout: number) => Promise<void>).bind(deployment);
    try {
      const what = `Updating the timeout of Nosana deployment ${deploymentId}`;
      if (access.mode === "api_key") await this.apiCall(() => updateTimeout(sentTimeout), what);
      else await this.sdkCall(() => updateTimeout(sentTimeout), what);
    } catch (err) {
      if (err instanceof NosanaLifecycleError) throw err;
      throw new NosanaLifecycleError(
        `Updating the timeout of Nosana deployment ${deploymentId} failed: ${(err as Error).message}`,
        "scale",
        { deploymentId, cause: err },
      );
    }
    return { deploymentId, timeoutSeconds, sentTimeout, unit };
  }

  /**
   * Stop a deployment and try to reclaim its vault. Throws if the stop did not
   * take effect; `reclaimed: false` means the withdraw must be retried later
   * (reclaimDeploymentVault).
   */
  async stopDeployment(
    deploymentId: string,
    mode?: NosanaAccessMode
  ): Promise<StopAndReclaimResult> {
    const access = this.accessForId(deploymentId, mode);

    logger.info({ deploymentId }, "Stopping deployment");

    if (isMockNosanaId(deploymentId)) {
      logger.debug({ deploymentId, mock: true }, "Mock deployment - stop is a no-op");
      return {
        deploymentId,
        stopped: true,
        alreadyStopped: false,
        reclaimed: true,
        remainingNosBaseUnits: 0n,
      };
    }

    const result = await stopAndReclaim(access!.port, deploymentId, access!.funding, {
      stopRetry: this.stopRetry(),
    });
    if (result.stopRefused) {
      logger.error(
        { deploymentId, reclaimed: result.reclaimed, reason: result.reclaimError },
        "Nosana refused the stop of a halted deployment; it stays for the reclaim sweep to stop"
      );
    } else {
      logger.info(
        { deploymentId, reclaimed: result.reclaimed, alreadyStopped: result.alreadyStopped },
        "Deployment stopped via Nosana SDK"
      );
    }
    return result;
  }

  /**
   * Retry the vault withdraw for a stopped/failed deployment. With API-key
   * access there is nothing to withdraw: `reclaimed` means Nosana is no longer
   * running the deployment and will not schedule more work for it.
   */
  async reclaimDeploymentVault(
    deploymentId: string,
    mode?: NosanaAccessMode,
    /** `startMayBeInFlight`: the run failed so recently that its start may still land. */
    options: { startMayBeInFlight?: boolean } = {},
  ): Promise<ReclaimResult> {
    const access = this.accessForId(deploymentId, mode);
    if (isMockNosanaId(deploymentId)) {
      return {
        deploymentId,
        state: "stopped",
        reclaimed: true,
        remainingNosBaseUnits: 0n,
      };
    }
    return reclaimVault(access!.port, deploymentId, access!.funding, {
      stopRetry: this.stopRetry(),
      ...(options.startMayBeInFlight ? { startMayBeInFlight: true } : {}),
    });
  }

  /**
   * Scale a RUNNING deployment to a new replica count. Extra replicas are funded
   * before the count changes. Throws NosanaLifecycleError(code
   * "nosana_not_running") when the deployment is not running.
   */
  async scaleDeployment(
    deploymentId: string,
    newReplicas: number,
    marketTier: string,
    mode?: NosanaAccessMode
  ): Promise<ScaleResult> {
    const access = this.accessForId(deploymentId, mode);

    logger.info({ deploymentId, newReplicas }, "Scaling deployment");

    if (isMockNosanaId(deploymentId)) {
      return { deploymentId, previousReplicas: newReplicas, replicas: newReplicas, funded: null };
    }

    const cfg = getNosanaDeployConfig();
    return scaleDeployment(
      access!.port,
      deploymentId,
      newReplicas,
      {
        marketAddress: this.resolveMarketAddress(marketTier, access!.mode),
        fundSeconds:
          access!.mode === "api_key" ? this.creditEstimateSeconds("service") : cfg.vaultFundSeconds,
        solFeeLamportsPerReplica: cfg.vaultSolLamportsPerReplica,
        networkFeeBps: cfg.networkFeeBps,
      },
      access!.funding,
    );
  }

  /**
   * Refill the vault of a running deployment so its next extension is funded.
   * With API-key access nothing is ever topped up: the result carries reason
   * "credits" and the seconds the shared balance would cover.
   */
  async ensureDeploymentRunway(
    deploymentId: string,
    marketTier: string,
    replicas: number,
    mode?: NosanaAccessMode
  ): Promise<RunwayResult> {
    const access = this.accessFor(mode);
    const cfg = getNosanaDeployConfig();
    return ensureVaultRunway(
      access.port,
      deploymentId,
      {
        marketAddress: this.resolveMarketAddress(marketTier, access.mode),
        replicas,
        minRunwaySeconds: cfg.vaultMinRunwaySeconds,
        fundSeconds: cfg.vaultFundSeconds,
        solFeeLamportsPerReplica: cfg.vaultSolLamportsPerReplica,
        networkFeeBps: cfg.networkFeeBps,
      },
      access.funding,
    );
  }

  /**
   * Probe a node's readiness over HTTP: "the model answers", not "the
   * server answers". The engine must report the model ready (vLLM: /health is
   * 200; Ollama: /api/ps lists `model`, the deployment's served model, or any
   * model when none is given) AND, when a model is named, a load request for
   * it, one generated token, must have been answered: /api/ps lists a model
   * while it is still loading, and a node's first generation is slow on both
   * engines. The URL is checked against the SSRF allowlist first; a
   * disallowed URL is simply unhealthy. Never throws.
   *
   * An Ollama server that answers without the model loaded is asked, in the
   * background, to load it (requestModelLoad); the result of this probe
   * is unhealthy all the same. A listed model this process has not seen answer
   * is asked the same way and given MODEL_ANSWER_WAIT_MS: warm and
   * idle, it answers at once and the probe is healthy. Otherwise the probe is
   * not healthy and says `pending: true` while the request is in flight and
   * younger than MODEL_LOAD_PENDING_GRACE_MS: the node is loading, or it is warm
   * and busy with a customer's answer, and this probe cannot tell which. A
   * pending probe never makes a row `running`; the caller keeps the health a
   * serving node already had (runDeploymentStatusTick).
   *
   * A probe that gets no /api/ps list from the node (no connection, an error
   * status, a body that is not the list) forgets that the node was seen
   * answering: a new container may be behind the URL when it answers again.
   */
  async checkNodeHealth(
    nodeUrl: string,
    engine?: string,
    model?: string,
    options: { loadedCheckWaitMs?: number; pendingGraceMs?: number } = {}
  ): Promise<{ healthy: boolean; latencyMs: number; pending?: true }> {
    const startTime = Date.now();

    if (!isAllowedNodeUrl(nodeUrl, nodeUrlAllowlistOptions())) {
      logger.warn({ nodeUrl }, "Refusing to probe a node URL outside the allowlist");
      return { healthy: false, latencyMs: 0 };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(`${nodeUrl}${nodeHealthPath(engine)}`, {
          signal: controller.signal,
          // Never follow a redirect off the allowlisted host.
          redirect: "manual",
        });
        let healthy = response.ok;
        let pending = false;
        if (!healthy) forgetNodeAnswered(nodeUrl);
        if (healthy && engine === "vllm" && model) {
          // /health is 200: the engine is up. Its first generation is slow all
          // the same, so the node is healthy only once it has answered one
          // token (the same rule as for Ollama below).
          const readiness = await modelAnswersNow(
            nodeUrl,
            "vllm",
            model,
            options.loadedCheckWaitMs ?? MODEL_ANSWER_WAIT_MS,
            options.pendingGraceMs ?? MODEL_LOAD_PENDING_GRACE_MS,
          );
          healthy = readiness === "ready";
          pending = readiness === "pending";
        }
        if (healthy && engine === "ollama") {
          // Read under the same deadline; a body that is not the list is unhealthy.
          // No more than MAX_PROBE_BODY_BYTES of it is read.
          const text = await readProbeBody(response);
          const body: unknown = text === null ? null : JSON.parse(text);
          healthy = ollamaModelLoaded(body, model);
          // Not the list, or the list without the model: whatever was seen
          // answering here before is gone.
          if (!healthy) forgetNodeAnswered(nodeUrl);
          if (model && isOllamaLoadedModelsAnswer(body)) {
            if (!healthy) {
              // The server answers and the model is not in memory: nothing
              // routes a request to this node until it is, so ask the node to
              // load it. Not awaited; this probe stays unhealthy and a later
              // one sees it loaded.
              requestModelLoad(nodeUrl, "ollama", model);
            } else {
              // Listed is not loaded: the list shows a model from the moment
              // its load begins.
              const readiness = await modelAnswersNow(
                nodeUrl,
                "ollama",
                model,
                options.loadedCheckWaitMs ?? MODEL_ANSWER_WAIT_MS,
                options.pendingGraceMs ?? MODEL_LOAD_PENDING_GRACE_MS,
              );
              healthy = readiness === "ready";
              pending = readiness === "pending";
            }
          }
        }
        return {
          healthy,
          latencyMs: Date.now() - startTime,
          ...(pending ? { pending: true as const } : {}),
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // No answer, or not one that could be read: see the doc above.
      forgetNodeAnswered(nodeUrl);
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
      };
    }
  }
}

// ============================================
// Singleton Instance
// ============================================

let nosanaClient: NosanaClient | null = null;

export async function getNosanaClient(): Promise<NosanaClient> {
  if (!nosanaClient) {
    nosanaClient = new NosanaClient();
    await nosanaClient.initialize();
  }
  return nosanaClient;
}

// ============================================
// Job Definition Generator
// ============================================

export interface ModelDeploymentConfig {
  modelId: string;
  hfModelId: string;
  engine: "vllm" | "ollama";
  maxTokens: number;
  gpuMemoryUtilization: number;
  quantization?: string;
  /**
   * Hugging Face token for gated models. Only ever set on jobs created with
   * `confidential: true` (createDeployment always does), because Nosana pins
   * non-confidential job definitions to PUBLIC IPFS. Omitted => no HF_TOKEN.
   */
  hfToken?: string;
  /**
   * A fine-tuned LoRA adapter served on top of the base model (vLLM only).
   * Absent for every other deployment, whose definition it does not change.
   */
  adapter?: VllmAdapterConfig;
}

/** What the vLLM container needs to fetch one adapter and serve it. */
export interface VllmAdapterConfig {
  /** The name the engine serves the adapter under (adapterNameForSlug). */
  name: string;
  /**
   * Where the container GETs the archive: this API's adapter route, signed
   * for the deployment and its run (services/fineTunedModels.ts). It carries
   * a signature, so it travels in the environment of the confidential
   * definition and is never logged.
   */
  downloadUrl: string;
  /**
   * The adapter's LoRA rank (FineTunedModel.loraR). vLLM refuses an adapter
   * whose rank is above --max-lora-rank, and the flag takes only
   * VLLM_MAX_LORA_RANKS: it is set to vllmMaxLoraRank(maxRank).
   */
  maxRank: number;
  /** sha256 of the archive as stored, lower-case hex: checked after download. */
  sha256: string;
  /** Size of the archive as stored; the download stops past it. */
  bytes: number;
}

/** The vLLM image every deployment ran on before tool calling was wired. */
const VLLM_IMAGE = "vllm/vllm-openai:v0.6.0";

/** vLLM's own liveness route: 200 once the engine has loaded the model. */
const VLLM_HEALTH_PATH = "/health";

interface VllmToolCalling {
  /** vLLM's --tool-call-parser value for this model family. */
  parser: "hermes" | "mistral" | "llama3_json";
  /** The oldest pinned image whose server has that parser. */
  image: string;
}

/**
 * Model families vLLM can parse tool calls for, by Hugging Face id prefix.
 * `hermes` and `mistral` shipped with automatic tool choice in v0.6.0;
 * `llama3_json` came later, so those models run a newer pinned image and
 * every other model stays on the image it has always run on.
 *
 * Deliberately short: a parser pointed at a model whose chat template has no
 * tool section yields malformed calls, which is worse than the server's own
 * "tool choice is not enabled" answer.
 */
const VLLM_TOOL_CALLING: ReadonlyArray<{ prefix: string } & VllmToolCalling> = [
  { prefix: "meta-llama/Meta-Llama-3.1-", parser: "llama3_json", image: "vllm/vllm-openai:v0.6.3" },
  { prefix: "meta-llama/Llama-3.2-", parser: "llama3_json", image: "vllm/vllm-openai:v0.6.3" },
  { prefix: "mistralai/Mistral-7B-Instruct-v0.3", parser: "mistral", image: VLLM_IMAGE },
  { prefix: "Qwen/Qwen2.5-", parser: "hermes", image: VLLM_IMAGE },
];

/**
 * How vLLM is started so `tool_choice: "auto"` works for this model, or null
 * when the model has no parser. Without one, a request with `tools` still
 * reaches the model server, which answers 400 for "auto" - passed through to
 * the caller as it is (routes/inference.ts).
 */
export function vllmToolCalling(hfModelId: string): VllmToolCalling | null {
  const match = VLLM_TOOL_CALLING.find((entry) => hfModelId.startsWith(entry.prefix));
  return match ? { parser: match.parser, image: match.image } : null;
}

export function generateVllmJobDefinition(
  config: ModelDeploymentConfig
): NosanaJobDefinition {
  const vllmArgs = [
    "--model",
    config.hfModelId,
    "--host",
    "0.0.0.0",
    "--port",
    "8000",
    "--max-model-len",
    config.maxTokens.toString(),
    "--gpu-memory-utilization",
    config.gpuMemoryUtilization.toString(),
  ];

  if (config.quantization) {
    vllmArgs.push("--quantization", config.quantization);
  }

  // Function calling on /v1: the model decides when to call a tool
  // (tool_choice "auto"), and vLLM turns its output into `tool_calls`.
  const toolCalling = vllmToolCalling(config.hfModelId);
  if (toolCalling) {
    vllmArgs.push("--enable-auto-tool-choice", "--tool-call-parser", toolCalling.parser);
  }

  if (config.adapter) {
    return vllmAdapterJobDefinition(config, config.adapter, vllmArgs, toolCalling);
  }

  return {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "wheelsai",
    },
    ops: [
      {
        type: "container/run",
        id: "vllm-inference",
        args: {
          image: toolCalling?.image ?? VLLM_IMAGE,
          cmd: vllmArgs,
          gpu: true,
          expose: [apiPortWithHealthCheck(8000, VLLM_HEALTH_PATH)],
          // The old literal "${HF_TOKEN}" was never substituted by anything, so
          // gated models were handed that string as their token. Real token or
          // nothing.
          ...(config.hfToken ? { env: { HF_TOKEN: config.hfToken } } : {}),
        },
      },
    ],
  };
}

// ============================================
// vLLM with a fine-tuned adapter
// ============================================

/** Prefix of the name an adapter is served under: never a catalog model id. */
export const ADAPTER_NAME_PREFIX = "ft-";

/** A fine-tuned model's slug, as far as it may reach a job definition. */
export const FINE_TUNED_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

const ADAPTER_NAME_PATTERN = /^ft-[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
/** owner/name on Hugging Face: nothing a shell or an argument parser reads specially. */
const ADAPTER_BASE_MODEL_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
/** http(s) origin, path and query of unreserved characters only. */
const ADAPTER_URL_PATTERN =
  /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]*(?:\?[A-Za-z0-9._~=&-]*)?$/;
const ADAPTER_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ADAPTER_QUANTIZATION_PATTERN = /^[a-z0-9_-]{1,32}$/;
const ADAPTER_MAX_RANK = 256;

/**
 * The only values vLLM 0.6.x accepts for --max-lora-rank (LoRAConfig refuses
 * any other at startup, and the server exits).
 */
export const VLLM_MAX_LORA_RANKS = [8, 16, 32, 64, 128, 256] as const;

/**
 * --max-lora-rank for an adapter of rank `rank`: the smallest value vLLM
 * accepts that is at least the rank. An adapter whose rank is at or below
 * the ceiling loads; a rank-4 adapter is served under 8. Null above 256.
 */
export function vllmMaxLoraRank(rank: number): number | null {
  if (!Number.isInteger(rank) || rank < 1) return null;
  return VLLM_MAX_LORA_RANKS.find((allowed) => allowed >= rank) ?? null;
}
const ADAPTER_MAX_URL_LENGTH = 2048;

/** Where the container unpacks adapters; one directory per adapter name. */
export const ADAPTER_ROOT_DIR = "/adapters";

/**
 * The name the engine serves a fine-tuned model under, or null when the slug
 * is not one that may be placed in a job definition.
 */
export function adapterNameForSlug(slug: unknown): string | null {
  return typeof slug === "string" && FINE_TUNED_SLUG_PATTERN.test(slug)
    ? `${ADAPTER_NAME_PREFIX}${slug}`
    : null;
}

/** A value bound for the adapter job definition failed its pattern. */
export class InvalidAdapterConfigError extends Error {
  readonly code = "invalid_adapter_config";
  constructor(readonly field: string) {
    // The value is not echoed: it is whatever a caller managed to pass in.
    super(`Adapter deployment refused: ${field} is not in the accepted form`);
    this.name = "InvalidAdapterConfigError";
  }
}

/**
 * Checks every value the adapter definition carries (D13). Throws
 * InvalidAdapterConfigError naming the first field that fails.
 */
export function assertValidAdapterConfig(
  config: Pick<ModelDeploymentConfig, "hfModelId" | "quantization">,
  adapter: VllmAdapterConfig,
): void {
  const refuse = (field: string): never => {
    throw new InvalidAdapterConfigError(field);
  };
  if (typeof config.hfModelId !== "string" || !ADAPTER_BASE_MODEL_PATTERN.test(config.hfModelId)) {
    refuse("hfModelId");
  }
  if (config.quantization !== undefined && !ADAPTER_QUANTIZATION_PATTERN.test(config.quantization)) {
    refuse("quantization");
  }
  if (typeof adapter.name !== "string" || !ADAPTER_NAME_PATTERN.test(adapter.name)) {
    refuse("adapter.name");
  }
  if (
    typeof adapter.downloadUrl !== "string" ||
    adapter.downloadUrl.length > ADAPTER_MAX_URL_LENGTH ||
    !ADAPTER_URL_PATTERN.test(adapter.downloadUrl)
  ) {
    refuse("adapter.downloadUrl");
  }
  if (!Number.isInteger(adapter.maxRank) || adapter.maxRank < 1 || adapter.maxRank > ADAPTER_MAX_RANK) {
    refuse("adapter.maxRank");
  }
  if (typeof adapter.sha256 !== "string" || !ADAPTER_SHA256_PATTERN.test(adapter.sha256)) {
    refuse("adapter.sha256");
  }
  if (!Number.isSafeInteger(adapter.bytes) || adapter.bytes < 1) {
    refuse("adapter.bytes");
  }
}

/** The three root-level files of an adapter archive (infra/training/README.md). */
export const ADAPTER_ARCHIVE_FILES = [
  "adapter_config.json",
  "adapter_model.safetensors",
  "wheelsai_manifest.json",
] as const;

/**
 * What the container runs before vLLM: fetch the archive, check it, unpack
 * it, then replace itself with the OpenAI server.
 *
 * A CONSTANT. Nothing is interpolated into it: the URL, the directory, the
 * checksum and the size limit arrive in the environment, and the server's
 * arguments as this process's own argument vector, handed on unchanged. There
 * is no shell anywhere in the chain (the entrypoint is `python3 -c`), so no
 * value can become part of a command.
 *
 * The archive is refused unless it holds exactly the three expected regular
 * files at its root: members are written one by one under their fixed names
 * (never tar's own extraction), so a link, a path or an extra entry cannot
 * place anything outside the adapter directory. The URL is never printed.
 */
export const VLLM_ADAPTER_BOOTSTRAP = `import hashlib, http.client, os, shutil, sys, tarfile, tempfile, time, urllib.error, urllib.request, zlib

URL = os.environ["WHEELSAI_ADAPTER_URL"]
DEST = os.environ["WHEELSAI_ADAPTER_DIR"]
SHA256 = os.environ["WHEELSAI_ADAPTER_SHA256"]
MAX_BYTES = int(os.environ["WHEELSAI_ADAPTER_MAX_BYTES"])
FILES = (${ADAPTER_ARCHIVE_FILES.map((name) => JSON.stringify(name)).join(", ")})
MAX_UNPACKED = max(MAX_BYTES * 8, 1 << 20)


def fail(message):
    sys.stderr.write("wheelsai-adapter: " + message + "\\n")
    sys.exit(78)


def fetch(path):
    last = "no attempt"
    for attempt in range(5):
        if attempt:
            time.sleep(min(30, 2 ** attempt))
        try:
            digest = hashlib.sha256()
            size = 0
            with urllib.request.urlopen(URL, timeout=60) as response, open(path, "wb") as out:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_BYTES:
                        fail("the archive is larger than expected")
                    digest.update(chunk)
                    out.write(chunk)
            return digest.hexdigest()
        except urllib.error.HTTPError as err:
            if err.code < 500 and err.code != 429:
                fail("the download was refused (HTTP %d)" % err.code)
            last = "HTTP %d" % err.code
        except (OSError, ValueError, http.client.HTTPException) as err:
            last = type(err).__name__
    fail("the download failed (" + last + ")")


def unpack(path):
    seen = set()
    total = 0
    with tarfile.open(path, mode="r:gz") as archive:
        for member in archive:
            if member.name not in FILES or member.name in seen or not member.isreg():
                fail("the archive holds an entry that is not one of its three files")
            total += member.size
            if total > MAX_UNPACKED:
                fail("the archive unpacks to more than expected")
            seen.add(member.name)
            source = archive.extractfile(member)
            with open(os.path.join(DEST, member.name), "wb") as out:
                shutil.copyfileobj(source, out, 1 << 20)
    if len(seen) != len(FILES):
        fail("the archive is missing one of its three files")


os.makedirs(DEST, exist_ok=True)
handle, archive_path = tempfile.mkstemp(suffix=".tar.gz")
os.close(handle)
try:
    if fetch(archive_path) != SHA256:
        fail("the archive does not match its checksum")
    try:
        unpack(archive_path)
    except (tarfile.TarError, EOFError, OSError, zlib.error):
        fail("the archive could not be read")
finally:
    os.remove(archive_path)

os.execvp(sys.executable, [sys.executable, "-m", "vllm.entrypoints.openai.api_server"] + sys.argv[1:])
`;

/**
 * The vLLM definition of a deployment that serves an adapter: the base
 * model's server, started by the bootstrap above with LoRA enabled and one
 * module, named for the fine-tuned model.
 */
function vllmAdapterJobDefinition(
  config: ModelDeploymentConfig,
  adapter: VllmAdapterConfig,
  vllmArgs: string[],
  toolCalling: VllmToolCalling | null,
): NosanaJobDefinition {
  assertValidAdapterConfig(config, adapter);
  const directory = `${ADAPTER_ROOT_DIR}/${adapter.name}`;

  return {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "wheelsai",
    },
    ops: [
      {
        type: "container/run",
        id: "vllm-inference",
        args: {
          image: toolCalling?.image ?? VLLM_IMAGE,
          // The image's entrypoint is the server itself; the bootstrap takes
          // its place and ends by exec'ing it with the arguments after it.
          entrypoint: ["python3", "-c"],
          cmd: [
            VLLM_ADAPTER_BOOTSTRAP,
            ...vllmArgs,
            "--enable-lora",
            "--lora-modules",
            `${adapter.name}=${directory}`,
            "--max-lora-rank",
            // Not the rank itself: vLLM takes only VLLM_MAX_LORA_RANKS, so a
            // rank-4 adapter is served under 8 (checked above: 1 to 256).
            String(vllmMaxLoraRank(adapter.maxRank)),
          ],
          gpu: true,
          expose: [apiPortWithHealthCheck(8000, VLLM_HEALTH_PATH)],
          env: {
            ...(config.hfToken ? { HF_TOKEN: config.hfToken } : {}),
            WHEELSAI_ADAPTER_URL: adapter.downloadUrl,
            WHEELSAI_ADAPTER_DIR: directory,
            WHEELSAI_ADAPTER_SHA256: adapter.sha256,
            WHEELSAI_ADAPTER_MAX_BYTES: adapter.bytes.toString(),
          },
        },
      },
    ],
  };
}

/**
 * The Ollama image, pinned to the tag Nosana's markets pre-pull (the
 * required_images of the 3060 and 4070 markets, among others), so a start
 * does not spend paid time pulling it. Never `:latest`: an unpinned tag is
 * pulled on every start and changes under us.
 *
 * Its entrypoint is /bin/ollama with cmd `serve` (the image config on Docker
 * Hub, read 2026-10-07), and it sets OLLAMA_HOST=0.0.0.0:11434 itself.
 */
export const OLLAMA_IMAGE = "docker.io/ollama/ollama:0.32.6";

const OLLAMA_PORT = 11434;

/**
 * Ollama's model list: 200 as soon as a server answers on the exposed port,
 * which ollamaServeScript opens only once the model is there. This is
 * Nosana's health check. It does not say the model is loaded: our own probe
 * (checkNodeHealth) reads /api/ps for that, and a row is `running` only when
 * both pass.
 */
const OLLAMA_HEALTH_PATH = "/api/tags";

/**
 * Where the server that pulls the model listens: inside the container only,
 * on a port the definition does not expose.
 */
const OLLAMA_PULL_HOST = "127.0.0.1:11435";

/**
 * An Ollama model reference as it may reach the shell command below:
 * `name`, `name:tag` or `namespace/name:tag`, and nothing a shell reads.
 */
const OLLAMA_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/**
 * Where the preload reaches the final server from inside the container: the
 * exposed port, on loopback (the definition's own OLLAMA_HOST is the listen
 * address 0.0.0.0).
 */
const OLLAMA_PRELOAD_HOST = `127.0.0.1:${OLLAMA_PORT}`;

/** What the start script writes to the container's log when the preload does not complete. */
export const OLLAMA_PRELOAD_FAILED_LINE = "model preload did not complete; the model loads on the first request";

/**
 * Pulls the model through a server only the container can reach, ends that
 * server, and only then becomes (exec) the server on the exposed port. Nothing
 * listens on that port during the download, so Nosana's health check cannot
 * pass, the endpoint cannot turn online and nobody is billed or routed to a
 * server that has no model yet. The loopback server gets a minute to answer;
 * a failed pull ends the container instead of serving nothing; afterwards the
 * container lives and dies with `ollama serve`.
 *
 * The preload. Ollama loads a model into GPU memory on the first request for
 * it, not when the server starts, and a node's first generation after its
 * container starts is far slower than any later one (first live run: the
 * first request took 42 seconds and ran into the inference timeout; second
 * live run: 49 seconds from the server answering to the first generated
 * token on a 4090). So a background job, started just before the exec, waits
 * for the final server to answer and runs `ollama run <model> ""`. In a
 * container stdin is not a terminal, so the CLI sends a prompt of one space
 * and not Ollama's documented empty preload: the model is loaded and
 * generates a short answer, which is that first slow generation begun the
 * moment the server is up. OLLAMA_KEEP_ALIVE=-1 keeps the model loaded. The
 * job outlives the exec as a child of the server; if it fails the server
 * still runs and it says so in one line on stderr. It is a head start, not
 * what readiness rests on: our probe keeps the deployment out of `running`
 * until the model has answered the platform's own one-token request
 * (requestModelLoad), which loads the model if nothing else did.
 */
function ollamaServeScript(ollamaModel: string): string {
  if (ollamaModel.length > 128 || !OLLAMA_MODEL_PATTERN.test(ollamaModel)) {
    throw new Error("Unsupported Ollama model name");
  }
  const local = `OLLAMA_HOST=${OLLAMA_PULL_HOST}`;
  const exposed = `OLLAMA_HOST=${OLLAMA_PRELOAD_HOST}`;
  return [
    `${local} ollama serve & pid=$!`,
    "i=0",
    `until ${local} ollama list >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge 60 ] && exit 1; sleep 1; done`,
    `${local} ollama pull ${ollamaModel} || exit 1`,
    'kill "$pid"',
    // Quietly: the shell would report the server it just ended ("Terminated").
    'wait "$pid" 2>/dev/null',
    // The preload, in the background (one list element with the exec: `&;` is
    // not shell), then OLLAMA_HOST of the definition's env: the exposed port.
    // The preload writes nothing to the container's log (Ollama draws a
    // progress spinner on stderr); if it does not complete, one plain line
    // says so.
    `(i=0; until ${exposed} ollama list >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge 60 ] && break; sleep 1; done; ` +
      `[ "$i" -lt 60 ] && ${exposed} ollama run ${ollamaModel} "" >/dev/null 2>&1 </dev/null || ` +
      `echo "${OLLAMA_PRELOAD_FAILED_LINE}" >&2) & exec ollama serve`,
  ].join("; ");
}

/**
 * The environment of the Ollama server. Only variables Ollama reads: the
 * context length and GPU layer count are request and Modelfile options
 * (num_ctx, num_gpu), not environment variables.
 */
function ollamaEnv(): Record<string, string> {
  return {
    OLLAMA_HOST: `0.0.0.0:${OLLAMA_PORT}`,
    // Never unload: the model is loaded once, at start (ollamaServeScript),
    // and a reload would be a cold request of tens of seconds.
    OLLAMA_KEEP_ALIVE: "-1",
  };
}

export function generateOllamaJobDefinition(
  config: ModelDeploymentConfig
): NosanaJobDefinition {
  // Map HF model ID to Ollama model name
  const ollamaModel = mapToOllamaModel(config.hfModelId);

  return {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "wheelsai",
    },
    ops: [
      {
        type: "container/run",
        id: "ollama-inference",
        args: {
          image: OLLAMA_IMAGE,
          // A shell in place of the image's /bin/ollama entrypoint: pull the
          // model, then serve it.
          ...shellCommand(ollamaServeScript(ollamaModel)),
          gpu: true,
          expose: [apiPortWithHealthCheck(OLLAMA_PORT, OLLAMA_HEALTH_PATH)],
          env: ollamaEnv(),
        },
      },
    ],
  };
}

/**
 * Generate Ollama job with OpenAI-compatible proxy
 * This uses a sidecar container to provide /v1/chat/completions endpoint
 */
export function generateOllamaWithProxyJobDefinition(
  config: ModelDeploymentConfig
): NosanaJobDefinition {
  const ollamaModel = mapToOllamaModel(config.hfModelId);

  return {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "wheelsai",
    },
    ops: [
      {
        type: "container/run",
        id: "ollama-server",
        args: {
          image: OLLAMA_IMAGE,
          ...shellCommand(ollamaServeScript(ollamaModel)),
          gpu: true,
          expose: [apiPortWithHealthCheck(OLLAMA_PORT, OLLAMA_HEALTH_PATH)],
          env: ollamaEnv(),
        },
      },
      {
        type: "container/run",
        id: "openai-proxy",
        args: {
          image: "ghcr.io/wheelsai/ollama-openai-proxy:latest",
          cmd: [
            "--ollama-host", "http://localhost:11434",
            "--model", ollamaModel,
            "--port", "8000",
          ],
          expose: [8000],
          env: {
            OLLAMA_BASE_URL: "http://localhost:11434",
            DEFAULT_MODEL: ollamaModel,
          },
        },
      },
    ],
  };
}

/**
 * The model name the engine of a deployment answers to: the HF id on vLLM
 * (started without --served-model-name), the pulled tag on Ollama. The /v1
 * proxy rewrites a request's `model` to this.
 */
export function servedModelName(engine: string | null | undefined, hfModelId: string): string {
  return engine === "ollama" ? mapToOllamaModel(hfModelId) : hfModelId;
}

/**
 * The same, for a deployment that may serve a fine-tuned adapter: vLLM
 * answers to the adapter's name for the adapter and to the HF id for the bare
 * base model, so a request must name the adapter to be answered by it.
 */
export function servedModelNameFor(args: {
  engine: string | null | undefined;
  hfId: string;
  /** FineTunedModel.slug of the deployment's adapter; absent for a base deployment. */
  fineTunedSlug?: string | null;
}): string {
  if (args.fineTunedSlug && args.engine !== "ollama") {
    return `${ADAPTER_NAME_PREFIX}${args.fineTunedSlug}`;
  }
  return servedModelName(args.engine, args.hfId);
}

function mapToOllamaModel(hfModelId: string): string {
  // Map common HuggingFace model IDs to Ollama equivalents
  const mapping: Record<string, string> = {
    // Llama 3.1 family
    "meta-llama/Meta-Llama-3.1-8B-Instruct": "llama3.1:8b",
    "meta-llama/Meta-Llama-3.1-70B-Instruct": "llama3.1:70b",
    "meta-llama/Meta-Llama-3.1-405B-Instruct": "llama3.1:405b",
    // Llama 3.2 family
    "meta-llama/Llama-3.2-1B-Instruct": "llama3.2:1b",
    "meta-llama/Llama-3.2-3B-Instruct": "llama3.2:3b",
    // Mistral family
    "mistralai/Mistral-7B-Instruct-v0.2": "mistral:7b",
    "mistralai/Mistral-7B-Instruct-v0.3": "mistral:7b",
    "mistralai/Mixtral-8x7B-Instruct-v0.1": "mixtral:8x7b",
    "mistralai/Mixtral-8x22B-Instruct-v0.1": "mixtral:8x22b",
    // Qwen family
    "Qwen/Qwen2-7B-Instruct": "qwen2:7b",
    "Qwen/Qwen2-72B-Instruct": "qwen2:72b",
    "Qwen/Qwen2.5-7B-Instruct": "qwen2.5:7b",
    "Qwen/Qwen2.5-14B-Instruct": "qwen2.5:14b",
    "Qwen/Qwen2.5-32B-Instruct": "qwen2.5:32b",
    "Qwen/Qwen2.5-72B-Instruct": "qwen2.5:72b",
    // Phi family
    "microsoft/Phi-3-mini-4k-instruct": "phi3:mini",
    "microsoft/Phi-3-medium-4k-instruct": "phi3:medium",
    "microsoft/Phi-3.5-mini-instruct": "phi3.5:mini",
    // Gemma family
    "google/gemma-2-2b-it": "gemma2:2b",
    "google/gemma-2-9b-it": "gemma2:9b",
    "google/gemma-2-27b-it": "gemma2:27b",
    // Code models
    "Qwen/Qwen2.5-Coder-7B-Instruct": "qwen2.5-coder:7b",
    "deepseek-ai/deepseek-coder-6.7b-instruct": "deepseek-coder:6.7b",
    "codellama/CodeLlama-7b-Instruct-hf": "codellama:7b",
    "codellama/CodeLlama-34b-Instruct-hf": "codellama:34b",
  };

  return mapping[hfModelId] ?? hfModelId.split("/").pop() ?? hfModelId;
}

/**
 * Check if a model is available in Ollama
 */
export function isOllamaSupported(hfModelId: string): boolean {
  const ollamaModels = [
    // Llama family
    "meta-llama/Meta-Llama-3.1-8B-Instruct",
    "meta-llama/Meta-Llama-3.1-70B-Instruct",
    "meta-llama/Llama-3.2-1B-Instruct",
    "meta-llama/Llama-3.2-3B-Instruct",
    // Mistral family
    "mistralai/Mistral-7B-Instruct-v0.2",
    "mistralai/Mistral-7B-Instruct-v0.3",
    "mistralai/Mixtral-8x7B-Instruct-v0.1",
    // Qwen family
    "Qwen/Qwen2-7B-Instruct",
    "Qwen/Qwen2.5-7B-Instruct",
    "Qwen/Qwen2.5-14B-Instruct",
    "Qwen/Qwen2.5-32B-Instruct",
    "Qwen/Qwen2.5-72B-Instruct",
    // Phi family
    "microsoft/Phi-3-mini-4k-instruct",
    "microsoft/Phi-3-medium-4k-instruct",
    "microsoft/Phi-3.5-mini-instruct",
    // Gemma family
    "google/gemma-2-2b-it",
    "google/gemma-2-9b-it",
    "google/gemma-2-27b-it",
    // Code models
    "Qwen/Qwen2.5-Coder-7B-Instruct",
    "deepseek-ai/deepseek-coder-6.7b-instruct",
    "codellama/CodeLlama-7b-Instruct-hf",
  ];

  return ollamaModels.includes(hfModelId);
}

export function generateJobDefinition(
  config: ModelDeploymentConfig
): NosanaJobDefinition {
  switch (config.engine) {
    case "vllm":
      return generateVllmJobDefinition(config);
    case "ollama":
      // Ollama has no adapter path here: refuse, never serve the bare base
      // model under a fine-tuned model's name.
      if (config.adapter) throw new InvalidAdapterConfigError("engine");
      return generateOllamaJobDefinition(config);
    default:
      throw new Error(`Unsupported engine: ${config.engine}`);
  }
}
