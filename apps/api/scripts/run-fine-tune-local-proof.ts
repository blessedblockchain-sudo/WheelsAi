/**
 * Local end-to-end proof of fine-tuning: the REAL service code, no Nosana, no spend.
 *
 * What runs:
 *   - the API itself (src/index.ts) as a child process, with its real routes,
 *     its real Nosana client and the real BullMQ training poller;
 *   - a disposable copy of the local database, with every migration applied;
 *   - the development-only local object store, in a temporary directory;
 *   - a stand-in Nosana REST API on loopback with a stand-in node
 *     (scripts/fineTuneLocalNode.ts) that runs the training container's
 *     entrypoint as a local CPU process with the environment of the job
 *     definition the API submitted. The trainer downloads the dataset, uploads
 *     the adapter and posts its signed callbacks to the running API.
 *
 * What it proves: OUR pipeline. What is sent, stored, billed and refused, from
 * the dataset upload to the registered model and its adapter download.
 * What it does not prove: anything about Nosana, a GPU, the training image, or
 * the catalog models. The trainer loads a small cached model
 * (HuggingFaceTB/SmolLM2-135M-Instruct) IN PLACE OF the catalog model the job
 * names, on CPU. See docs/FINE-TUNE-RUN.md.
 *
 *   cd apps/api
 *   DEMO_PASSWORD=<the seeded demo owner's password> npx tsx scripts/run-fine-tune-local-proof.ts
 *
 * Options:
 *   --skip-run-limit   leave out the run that is stopped at its own run limit (about 5 minutes)
 *   --only=a,b         run only these scenarios (names: see SCENARIOS below)
 *   --keep             keep the database copy and the object store directory for inspection
 *
 * Environment (all optional but DEMO_PASSWORD):
 *   DEMO_EMAIL            demo@northwind.ai   an owner seeded in the local database
 *   PROOF_DATABASE_URL    URL of the local database to COPY (default: DATABASE_URL of packages/db/.env)
 *   PROOF_DB_NAME         wheelsai_ftproof    name of the copy (created here, dropped at the end)
 *   PROOF_REDIS_URL       redis://localhost:6380/13   must be an index of 9 or higher; flushed at the end
 *   PROOF_API_PORT        4360   (the stand-in Nosana API listens on +1, the Solana RPC counter on +2,
 *                                 the callback blocker on +3)
 *   TRAINER_PYTHON        ~/.cache/wheelsai/trainer-venv/bin/python
 *   TRAINER_HF_HOME       ~/.cache/wheelsai/hf
 *
 * Safety: it refuses to run against a database named "wheelsai", a Redis index
 * below 9 or a port outside 4300-4399; it binds loopback only; it never holds a
 * Nosana or Solana credential (the API child gets a made-up key that only the
 * stand-in accepts, and a Solana RPC URL that answers 500 and counts requests).
 */

/* eslint-disable no-console */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";

import { startLocalNode, type LocalNode, type LocalNodeRun } from "./fineTuneLocalNode.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const SUBSTITUTE_MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct";
const BASE_MODEL_ID = "phi-3-mini";
const TIER = "4090";
const RUN_LIMIT_SECONDS = 300;

const SCENARIOS = [
  "dataset",
  "estimate",
  "happy",
  "callbacks",
  "serving",
  "cancel",
  "data-failure",
  "platform-failure",
  "queue-timeout",
  "submit-failure",
  "logs-only",
  "run-limit",
  "refusals",
] as const;
type Scenario = (typeof SCENARIOS)[number];

// ============================================
// Arguments and settings
// ============================================

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const onlyArg = argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : null;
for (const name of only ?? []) {
  if (!(SCENARIOS as readonly string[]).includes(name)) {
    console.error(`Unknown scenario "${name}". Known: ${SCENARIOS.join(", ")}`);
    process.exit(2);
  }
}
const wanted = (name: Scenario): boolean => {
  if (name === "run-limit" && argv.includes("--skip-run-limit")) return false;
  return only ? only.includes(name) : true;
};

/** Thrown, never process.exit: main's `finally` must stop the servers and drop the copy. */
function fail(message: string): never {
  throw new Error(`PROOF ABORTED: ${message}`);
}

const API_PORT = Number(process.env.PROOF_API_PORT ?? 4360);
if (!Number.isInteger(API_PORT) || API_PORT < 4300 || API_PORT + 3 > 4399) {
  fail("PROOF_API_PORT must leave four ports inside 4300-4399");
}
const NOSANA_PORT = API_PORT + 1;
const RPC_PORT = API_PORT + 2;
const BLOCKER_PORT = API_PORT + 3;
const API = `http://127.0.0.1:${API_PORT}`;

const DB_NAME = process.env.PROOF_DB_NAME ?? "wheelsai_ftproof";
if (!/^wheelsai_[a-z0-9_]{3,40}$/.test(DB_NAME)) fail("PROOF_DB_NAME must look like wheelsai_<name>");

function baseDatabaseUrl(): string {
  if (process.env.PROOF_DATABASE_URL) return process.env.PROOF_DATABASE_URL;
  const envFile = path.join(REPO, "packages/db/.env");
  if (!existsSync(envFile)) fail("Set PROOF_DATABASE_URL (packages/db/.env was not found)");
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("DATABASE_URL="));
  if (!line) fail("packages/db/.env has no DATABASE_URL");
  return line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

const SOURCE_URL = baseDatabaseUrl();
const SOURCE_DB = new URL(SOURCE_URL).pathname.replace(/^\//, "");
const COPY_URL = withDatabase(SOURCE_URL, DB_NAME);
if (!new URL(COPY_URL).pathname.endsWith(`/${DB_NAME}`) || DB_NAME === SOURCE_DB) {
  fail("the database copy would be the source database");
}

const REDIS_URL = process.env.PROOF_REDIS_URL ?? "redis://localhost:6380/13";
const redisIndex = Number(new URL(REDIS_URL).pathname.replace(/^\//, ""));
if (!Number.isInteger(redisIndex) || redisIndex < 9) fail("PROOF_REDIS_URL must name a database index of 9 or higher");

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "demo@northwind.ai";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!DEMO_PASSWORD) fail("Set DEMO_PASSWORD to the password of the seeded owner (DEMO_EMAIL)");

const PYTHON = process.env.TRAINER_PYTHON ?? path.join(homedir(), ".cache/wheelsai/trainer-venv/bin/python");
const HF_HOME = process.env.TRAINER_HF_HOME ?? path.join(homedir(), ".cache/wheelsai/hf");
const TRAIN_PY = path.join(REPO, "infra/training/train.py");
const FIXTURE = path.join(REPO, "infra/training/fixtures/tiny.jsonl");
if (!existsSync(PYTHON)) fail(`the trainer's Python environment is missing (${PYTHON}); see infra/training/README.md`);
if (!existsSync(path.join(HF_HOME, "hub", `models--${SUBSTITUTE_MODEL.replace("/", "--")}`))) {
  fail(`${SUBSTITUTE_MODEL} is not cached under ${HF_HOME}; run infra/training/scripts/cpu_proof.py once`);
}

// Made up for this run; they die with it.
const JWT_SECRET = randomBytes(30).toString("hex");
const NOSANA_KEY = `nos_standin_${randomBytes(12).toString("hex")}`;
// A digest-shaped value: the image is never pulled here, the node runs train.py.
const TRAINING_IMAGE = `registry.invalid/wheelsai/trainer@sha256:${"0".repeat(64)}`;

const SCRATCH = mkdtempSync(path.join(tmpdir(), "wheelsai-ft-proof-run-"));
const STORE_DIR = path.join(SCRATCH, "object-store");

// ============================================
// Output
// ============================================

const SECRETS: string[] = [JWT_SECRET, NOSANA_KEY, DEMO_PASSWORD];

/** Everything printed goes through here: no token, signature or secret reaches the transcript. */
function mask(text: string): string {
  let out = text;
  for (const secret of SECRETS) out = out.split(secret).join("<secret>");
  return out
    .replace(/(\/api\/storage\/t\/)[A-Za-z0-9._~-]+/g, "$1<token>")
    .replace(/([?&]sig=)[a-f0-9]{16,}/g, "$1<signature>")
    .replace(/("CALLBACK_SECRET":\s*")[^"]+/g, "$1<secret>")
    .replace(/(wheelsai_token=)[^;\s"]+/g, "$1<session>");
}

const clock = () => new Date().toISOString().slice(11, 19);
function say(message = ""): void {
  console.log(mask(message));
}
function heading(title: string): void {
  say(`\n=== ${title} ===`);
}
function short(value: unknown, max = 900): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}... (${text.length} characters)` : text;
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  say(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs a command without blocking this process's own servers. */
function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// ============================================
// The database copy
// ============================================

function migrate(): void {
  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: path.join(REPO, "packages/db"),
    env: { ...process.env, DATABASE_URL: COPY_URL },
    encoding: "utf8",
  });
  const lines = `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => line.trim() !== "");
  say(`$ DATABASE_URL=<copy> npx prisma migrate deploy   (packages/db)`);
  for (const line of lines.slice(-6)) say(`  ${line}`);
  if (result.status !== 0) fail("prisma migrate deploy failed on the copy");
}

async function createCopy(): Promise<void> {
  const admin = new PrismaClient({ datasourceUrl: withDatabase(SOURCE_URL, "postgres") });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DB_NAME}" TEMPLATE "${SOURCE_DB}"`);
    say(`CREATE DATABASE ${DB_NAME} TEMPLATE ${SOURCE_DB}`);
  } finally {
    await admin.$disconnect();
  }
}

async function dropCopy(): Promise<void> {
  const admin = new PrismaClient({ datasourceUrl: withDatabase(SOURCE_URL, "postgres") });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    say(`DROP DATABASE ${DB_NAME}`);
  } finally {
    await admin.$disconnect();
  }
}

// ============================================
// The API child process
// ============================================

const WORKERS_OFF: Record<string, string> = {
  ALERT_EVALUATOR_INTERVAL_MS: "0",
  ANALYTICS_SNAPSHOT_INTERVAL_MS: "0",
  BAGS_FEE_SWEEP_INTERVAL_MS: "0",
  CUSTOM_DOMAIN_CHECK_INTERVAL_MS: "0",
  DEPLOYMENT_STATUS_INTERVAL_MS: "0",
  EMBEDDING_BACKFILL_INTERVAL_MS: "0",
  FEE_ROUTER_INTERVAL_MS: "0",
  GPU_BILLING_INTERVAL_MS: "0",
  JOB_SWEEP_INTERVAL_MS: "0",
  PAYMENT_POLL_INTERVAL_MS: "0",
  PAYMENT_REAP_INTERVAL_MS: "0",
  PAYMENT_SUBMIT_INTERVAL_MS: "0",
  PAYOUT_EXECUTOR_INTERVAL_MS: "0",
  REPUTATION_ATTESTATION_INTERVAL_MS: "0",
  SCHEDULER_INTERVAL_MS: "0",
  SUBSCRIPTION_RENEWAL_INTERVAL_MS: "0",
  TOKEN_INDEXER_INTERVAL_MS: "0",
  TREASURY_SETTLEMENT_BATCH_INTERVAL_MS: "0",
  TREASURY_SETTLEMENT_INTERVAL_MS: "0",
  UPTIME_PROBER_INTERVAL_MS: "0",
  WORKFLOW_REAP_INTERVAL_MS: "0",
  X402_SETTLEMENT_WORKER_ENABLED: "false",
  JOB_RUNNER_CONCURRENCY: "0",
  WORKFLOW_RUN_CONCURRENCY: "0",
  PAYOUTS_ENABLED: "false",
};

/** The fine-tuning settings of the proof; a refusal scenario removes or changes one. */
function fineTuningEnv(solanaRpcUrl: string): Record<string, string> {
  return {
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: STORE_DIR,
    PUBLIC_API_URL: API,
    TRAINING_IMAGE,
    TRAINING_POLL_INTERVAL_MS: "2000",
    TRAINING_QUEUE_TIMEOUT_SECONDS: "60",
    TRAINING_MAX_ACTIVE_JOBS_PER_ORG: "2",
    // The proof ends several runs free on purpose; the default of 3 a day
    // would refuse the later scenarios with training_free_failure_limit.
    TRAINING_FREE_FAILURES_PER_DAY: "20",
    // Job creation needs the deployment status worker: its tick is the orphan
    // sweep that stops a deployment a job handed over. It talks only to the
    // stand-in Nosana API and the loopback RPC counter below.
    DEPLOYMENT_STATUS_INTERVAL_MS: "5000",
    NOSANA_WALLET_PRIVATE_KEY: "",
    NOSANA_API_KEY: NOSANA_KEY,
    NOSANA_ACCESS_MODE: "api_key",
    NOSANA_API_URL: `http://127.0.0.1:${NOSANA_PORT}`,
    NOSANA_CREDITS_CACHE_MS: "0",
    ALLOW_NOSANA_MOCK: "false",
    SOLANA_RPC_URL: solanaRpcUrl,
  };
}

interface ApiProcess {
  child: ChildProcess;
  logFile: string;
  log: string[];
}

let api: ApiProcess | null = null;
let apiEnv: Record<string, string> = {};
let bootCount = 0;

async function startApi(env: Record<string, string>, label: string): Promise<void> {
  bootCount += 1;
  const cwd = path.join(SCRATCH, "cwd"); // no .env here: nothing is loaded from the repository
  spawnSync("mkdir", ["-p", cwd]);
  apiEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "development",
    LOG_LEVEL: "info",
    DATABASE_URL: COPY_URL,
    REDIS_URL,
    JWT_SECRET,
    API_PORT: String(API_PORT),
    API_HOST: "127.0.0.1",
    CORS_ORIGIN: `http://localhost:${API_PORT}`,
    RATE_LIMIT_MAX_PER_MINUTE: "100000",
    ...WORKERS_OFF,
    ...env,
  };
  const child = spawn(
    path.join(REPO, "node_modules/.bin/tsx"),
    ["--tsconfig", path.join(REPO, "apps/api/tsconfig.json"), path.join(REPO, "apps/api/src/index.ts")],
    { cwd, env: apiEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const log: string[] = [];
  const logFile = path.join(SCRATCH, `api-${bootCount}.log`);
  const keep = (chunk: Buffer) => {
    log.push(chunk.toString("utf8"));
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  api = { child, logFile, log };

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) {
      console.error(mask(log.join("").slice(-3000)));
      fail(`the API exited while starting (${label})`);
    }
    const ready = await fetch(`${API}/health`).then((response) => response.ok).catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) fail(`the API did not answer /health within 120 s (${label})`);
    await sleep(500);
  }
  say(`[${clock()}] API started on ${API} (${label})`);
}

async function stopApi(): Promise<void> {
  const current = api;
  if (!current) return;
  api = null;
  writeFileSync(current.logFile, current.log.join(""));
  if (current.child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => current.child.kill("SIGKILL"), 15_000);
    current.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    current.child.kill("SIGTERM");
  });
}

function apiLogText(): string {
  return api ? api.log.join("") : "";
}

const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string) => text.replace(ANSI_COLOUR, "");

/** Where the API's log ends now: a scenario prints what was logged after it. */
function logMark(): number {
  return apiLogText().length;
}

/**
 * The message lines of the API's own log (development logs are pretty-printed
 * over several lines; the context lines under a message are left out).
 */
function apiLogLines(pattern: RegExp, since = 0, max = 14): string[] {
  return stripAnsi(apiLogText().slice(since))
    .split("\n")
    .filter((line) => /^\[[0-9:. ]+\] (INFO|WARN|ERROR)/.test(line) && pattern.test(line))
    .slice(-max);
}

/** One message of the API's log with the context lines printed under it. */
function apiLogBlock(message: string, since = 0): string[] {
  const lines = stripAnsi(apiLogText().slice(since)).split("\n");
  const start = lines.findIndex((line) => /^\[[0-9:. ]+\] (INFO|WARN|ERROR)/.test(line) && line.includes(message));
  if (start < 0) return [];
  const block = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

// ============================================
// HTTP
// ============================================

let cookie = "";

interface Answer {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
}

async function call(
  method: string,
  pathname: string,
  body?: unknown,
  opts: { quiet?: boolean; headers?: Record<string, string>; raw?: string | Buffer; max?: number } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...opts.headers };
  let payload: string | Buffer | undefined;
  if (opts.raw !== undefined) payload = opts.raw;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(pathname.startsWith("http") ? pathname : `${API}${pathname}`, {
    method,
    headers,
    body: payload,
    redirect: "manual",
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  if (!opts.quiet) {
    const sent = body !== undefined ? ` ${short(body, 400)}` : "";
    say(`[${clock()}] ${method} ${pathname}${sent}`);
    say(`  -> HTTP ${response.status} ${short(parsed, opts.max ?? 900)}`);
  }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

async function login(): Promise<void> {
  const response = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  const setCookie = response.headers.getSetCookie().find((entry) => entry.startsWith("wheelsai_token="));
  if (response.status !== 200 || !setCookie) fail(`could not sign in as ${DEMO_EMAIL} (HTTP ${response.status})`);
  cookie = setCookie.split(";")[0]!;
  const token = cookie.slice("wheelsai_token=".length);
  SECRETS.push(token);
  say(`[${clock()}] POST /api/auth/login {"email":"${DEMO_EMAIL}","password":"<DEMO_PASSWORD>"} -> HTTP 200, session cookie kept`);
}

// ============================================
// Database reads (the copy)
// ============================================

let db = undefined as unknown as PrismaClient;
let orgId = "";

const cents = (value: bigint | number | null | undefined): string => (value == null ? "null" : value.toString());

async function balance(): Promise<bigint> {
  const row = await db.creditBalance.findUnique({ where: { orgId } });
  return row?.balanceCents ?? 0n;
}

async function ledgerRows(jobId: string) {
  return db.creditTransaction.findMany({ where: { orgId, referenceId: jobId }, orderBy: { createdAt: "asc" } });
}

async function printLedger(jobId: string): Promise<void> {
  const rows = await ledgerRows(jobId);
  say(`  ledger rows with reference ${jobId} (time | amount cents | type | balance after | description):`);
  if (rows.length === 0) say("    (none)");
  for (const row of rows) {
    say(
      `    ${row.createdAt.toISOString().slice(11, 23)} | ${cents(row.amountCents)} | ${row.type} | ${cents(row.balanceAfter)} | ${row.description ?? ""}`,
    );
  }
}

async function jobRow(jobId: string) {
  const row = await db.trainingJob.findUnique({ where: { id: jobId } });
  if (!row) fail(`training job ${jobId} is not in the database`);
  return row;
}

async function printJobRow(jobId: string): Promise<void> {
  const row = await jobRow(jobId);
  const time = (value: Date | null) => (value ? value.toISOString().slice(11, 23) : "null");
  say(
    `  row: status ${row.status} | failure_code ${row.failureCode ?? "null"} | hold ${cents(row.reservationCents)} | ` +
      `charge ${cents(row.actualCostCents)} | billed_seconds ${row.billedSeconds ?? "null"} | ` +
      `price micro-USD/s ${cents(row.priceMicroUsdPerSecond)}`,
  );
  say(
    `       queued ${time(row.queuedAt)} | started ${time(row.startedAt)} | cancel requested ${time(row.cancelRequestedAt)} | ` +
      `gpu stopped ${time(row.gpuStoppedAt)} | completed ${time(row.completedAt)} | settled ${time(row.settledAt)}`,
  );
  say(
    `       nosana id ${row.nosanaJobId ?? "null"} | access mode ${row.nosanaAccessMode ?? "null"} | ` +
      `nosana timeout ${row.nosanaTimeoutSeconds ?? "null"} s | run limit ${row.maxRuntimeSeconds ?? "null"} s | ` +
      `last event seq ${row.lastEventSeq}`,
  );
  if (row.lastError) say(`       last_error: ${row.lastError}`);
}

async function counts(): Promise<string> {
  const [jobs, ledger, bal] = await Promise.all([db.trainingJob.count(), db.creditTransaction.count(), balance()]);
  return `training jobs ${jobs} | ledger rows ${ledger} | balance ${bal}`;
}

// ============================================
// Driving a job
// ============================================

let node = undefined as unknown as LocalNode;

const HAPPY_HYPERPARAMS = {
  epochs: 3,
  batchSize: 4,
  gradientAccumulationSteps: 1,
  learningRate: 0.001,
  maxSeqLength: 128,
  evalSplit: 0.1,
};

async function createJob(name: string, datasetId: string, hyperparams: Record<string, unknown>, quiet = false) {
  const before = await balance();
  const answer = await call(
    "POST",
    "/api/training/jobs",
    { name, baseModelId: BASE_MODEL_ID, datasetId, method: "lora", gpuTier: TIER, maxRuntimeSeconds: RUN_LIMIT_SECONDS, hyperparams },
    { quiet },
  );
  if (answer.status !== 201) fail(`job "${name}" was not admitted: HTTP ${answer.status} ${answer.text}`);
  const jobId = answer.body.job.id as string;
  say(`  balance ${before} -> ${await balance()} cents`);
  return { jobId, before };
}

const TERMINAL = ["completed", "failed", "cancelled"];

/** Polls the job's page (what a user sees) and prints a line whenever it changes. */
async function watch(
  jobId: string,
  opts: { until?: (job: any) => boolean; timeoutMs?: number } = {}, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const until = opts.until ?? ((job) => TERMINAL.includes(job.status));
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  let last = "";
  for (;;) {
    const answer = await call("GET", `/api/training/jobs/${jobId}`, undefined, { quiet: true });
    if (answer.status !== 200) fail(`GET job answered HTTP ${answer.status}`);
    const job = answer.body.job;
    const line =
      `status ${job.status} | progress ${job.progress}% | step ${job.currentStep ?? "-"}/${job.totalSteps ?? "-"} | ` +
      `phase ${job.metrics?.phase ?? "-"} | loss ${job.trainingLoss ?? "-"} | eval ${job.evalLoss ?? "-"} | ` +
      `cost so far ${job.costSoFarCents ?? "-"} | charged ${job.actualCostCents ?? "-"}`;
    if (line !== last) {
      say(`  [${clock()}] ${line}`);
      last = line;
    }
    if (until(job)) return job;
    if (Date.now() > deadline) fail(`job ${jobId} did not reach the expected state in time (last: ${line})`);
    await sleep(700);
  }
}

function nodeRun(jobId: string): LocalNodeRun | undefined {
  return node.runs().find((run) => run.deploymentName.startsWith(`wheelsai-train-${jobId}-`));
}

function standInDeployment(jobId: string) {
  return [...node.fake.deployments.values()].find((deployment) =>
    deployment.name.startsWith(`wheelsai-train-${jobId}-`),
  );
}

async function settlementChecks(jobId: string, before: bigint, expect: { status: string; charged: boolean }) {
  const row = await jobRow(jobId);
  const rows = await ledgerRows(jobId);
  const after = await balance();
  const hold = row.reservationCents ?? 0n;
  const charge = row.actualCostCents ?? 0n;
  const of = (type: string) => rows.filter((entry) => entry.type === type);
  await printJobRow(jobId);
  await printLedger(jobId);
  say(`  balance before the job ${before} | after ${after} | difference ${before - after} cents`);
  check(`status is ${expect.status}`, row.status === expect.status, row.status);
  check("one training_reservation row for the whole hold", of("training_reservation").length === 1 && of("training_reservation")[0]!.amountCents === -hold);
  check("one training_reservation_release row returning the whole hold", of("training_reservation_release").length === 1 && of("training_reservation_release")[0]!.amountCents === hold);
  check(
    expect.charged ? "one training_usage row for the charge" : "no training_usage row",
    expect.charged
      ? of("training_usage").length === 1 && of("training_usage")[0]!.amountCents === -charge && charge > 0n
      : of("training_usage").length === 0 && charge === 0n,
    `charge ${charge}`,
  );
  check("the charge is not above the hold", charge <= hold, `${charge} <= ${hold}`);
  check("the balance fell by exactly the charge", before - after === charge, `${before - after}`);
  let running = before;
  let consistent = true;
  for (const entry of rows) {
    running += entry.amountCents;
    if (entry.balanceAfter !== running) consistent = false;
  }
  check("every row's balance_after follows from the one before", consistent);
  if (row.billedSeconds != null && row.priceMicroUsdPerSecond != null && expect.charged) {
    const expected = (row.priceMicroUsdPerSecond * BigInt(row.billedSeconds) + 9_999n) / 10_000n;
    check(
      "charge = price x billed seconds, rounded up to a cent, capped by the hold",
      charge === (expected < hold ? expected : hold) || charge === expected - 1n || charge === expected + 1n,
      `${row.priceMicroUsdPerSecond} micro-USD x ${row.billedSeconds} s = ${expected} cents (whole seconds; the charge uses milliseconds)`,
    );
  }
  const deployment = standInDeployment(jobId);
  const orphans = await db.nosanaOrphanDeployment.findMany({ where: { sourceId: jobId } });
  say(
    `  stand-in deployment: ${deployment ? `${deployment.name} ${deployment.status}, timeout sent ${deployment.timeout}, strategy ${deployment.strategy}, confidential ${deployment.confidential}` : "none"}` +
      ` | orphan records: ${orphans.length === 0 ? "0" : orphans.map((orphan) => `${orphan.reason}/${orphan.accessMode}`).join(", ")}`,
  );
  return { row, rows, hold, charge };
}

// ============================================
// Scenarios
// ============================================

const state: {
  datasetId?: string;
  longDatasetId?: string;
  bigDatasetId?: string;
  happyJobId?: string;
  fineTunedModelId?: string;
} = {};

async function uploadDataset(name: string, fileName: string, content: Buffer, verbose: boolean): Promise<string> {
  const created = await call(
    "POST",
    "/api/training/datasets",
    { name, fileName, sizeBytes: content.length, fileType: "jsonl" },
    { quiet: !verbose },
  );
  if (created.status !== 201) fail(`dataset "${name}" was not created: HTTP ${created.status} ${created.text}`);
  const upload = created.body.upload;
  const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: content });
  const putText = await put.text();
  if (verbose) {
    say(`[${clock()}] ${upload.method} ${upload.url}   (${content.length} bytes, headers ${JSON.stringify(upload.headers)})`);
    say(`  -> HTTP ${put.status} ${short(putText, 300)}`);
  }
  if (put.status >= 300) fail(`the dataset upload was refused: HTTP ${put.status} ${putText}`);
  const validated = await call("POST", `/api/training/datasets/${created.body.dataset.id}/validate`, undefined, {
    quiet: !verbose,
    max: 700,
  });
  if (validated.status !== 200 || validated.body.validation?.isValid !== true) {
    fail(`dataset "${name}" did not validate: HTTP ${validated.status} ${validated.text.slice(0, 500)}`);
  }
  if (!verbose) say(`  dataset "${name}" uploaded and validated: ${validated.body.validation.rowCount} rows, ${content.length} bytes`);
  return created.body.dataset.id as string;
}

async function scenarioDataset(): Promise<void> {
  heading("A. Dataset: upload through a signed transfer URL, then validation");
  const content = readFileSync(FIXTURE);
  const sha = createHash("sha256").update(content).digest("hex");
  say(`file: infra/training/fixtures/tiny.jsonl, ${content.length} bytes, sha256 ${sha}`);
  state.datasetId = await uploadDataset("proof-tiny", "tiny.jsonl", content, true);
  const row = await db.dataset.findUnique({ where: { id: state.datasetId } });
  say(
    `  row: is_validated ${row?.isValidated} | file_type ${row?.fileType} | schema_format ${row?.schemaFormat} | row_count ${row?.rowCount} | ` +
      `row_count_known ${row?.rowCountKnown} | avg_tokens_per_row ${row?.avgTokensPerRow} | total_tokens ${row?.totalTokens} | content_sha256 ${row?.contentSha256}`,
  );
  check("the stored content hash is the hash of the file that was sent", row?.contentSha256 === sha);

  // A transfer URL is good for the size it was issued for, and for one object.
  const second = await call(
    "POST",
    "/api/training/datasets",
    { name: "proof-wrong-size", fileName: "wrong.jsonl", sizeBytes: 10, fileType: "jsonl" },
    { quiet: true },
  );
  const wrong = await fetch(second.body.upload.url, {
    method: second.body.upload.method,
    headers: second.body.upload.headers,
    body: content,
  });
  say(`  a ${content.length}-byte PUT to a URL issued for 10 bytes -> HTTP ${wrong.status} ${short(await wrong.text(), 200)}`);
  check("an upload of another size than the URL was issued for is refused", wrong.status >= 400);
  await call("DELETE", `/api/training/datasets/${second.body.dataset.id}`, undefined, { quiet: true });
}

async function scenarioEstimate(): Promise<void> {
  heading("B. What this server can do, and the estimate");
  const capabilities = await call("GET", "/api/training/capabilities", undefined, { quiet: true });
  const c = capabilities.body;
  say(`[${clock()}] GET /api/training/capabilities -> HTTP ${capabilities.status}`);
  say(`  canStart ${c.canStart} | blockers ${JSON.stringify(c.blockers)} | storage ${JSON.stringify(c.storage)}`);
  say(`  image ${JSON.stringify(c.image)} | callbacks ${JSON.stringify(c.callbacks)} | poller ${JSON.stringify(c.poller)} | gatedModels ${JSON.stringify(c.gatedModels)}`);
  say(`  runLimit ${JSON.stringify(c.runLimit)} | limits ${JSON.stringify(c.limits)} | methods ${JSON.stringify(c.methods)}`);
  say(`  tiers ${c.nosana.tiers.map((tier: any) => `${tier.tier}:${tier.vramGb}GB:$${tier.pricePerSecondUsd}/s:${tier.deployable ? "deployable" : "not deployable"}`).join(" ")}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  check("the server reports that a job can start", c.canStart === true);

  const models = await call("GET", "/api/training/models", undefined, { quiet: true });
  say(`[${clock()}] GET /api/training/models -> HTTP ${models.status}`);
  for (const model of models.body.models) {
    say(
      `  ${model.id} (${model.hfId}) gated ${model.gated} available ${model.available}${model.unavailableReason ? ` (${model.unavailableReason})` : ""} ` +
        `methods ${model.methods.map((entry: any) => `${entry.method}>=${entry.requiredVramGb}GB`).join(",")} basis ${model.figuresBasis}`, // eslint-disable-line @typescript-eslint/no-explicit-any
    );
  }

  await call(
    "POST",
    "/api/training/estimate",
    { baseModelId: BASE_MODEL_ID, datasetId: state.datasetId, method: "lora", gpuTier: TIER, hyperparams: HAPPY_HYPERPARAMS },
    { max: 1400 },
  );
  await call("POST", "/api/training/estimate", {
    baseModelId: BASE_MODEL_ID,
    datasetId: state.datasetId,
    method: "full",
    gpuTier: TIER,
  });
  await call("POST", "/api/training/estimate", {
    baseModelId: BASE_MODEL_ID,
    datasetId: state.datasetId,
    method: "lora",
    gpuTier: "3060",
  });
  await call("POST", "/api/training/estimate", {
    baseModelId: "llama-3.1-8b",
    datasetId: state.datasetId,
    method: "lora",
    gpuTier: "a100",
  });
}

async function scenarioHappy(): Promise<void> {
  heading("C. A job from creation to a registered model: hold, live progress, settlement");
  say(`The job names ${BASE_MODEL_ID}; the stand-in node loads ${SUBSTITUTE_MODEL} in its place, on CPU.`);
  const mark = logMark();
  const { jobId, before } = await createJob("Proof report style", state.datasetId!, HAPPY_HYPERPARAMS);
  state.happyJobId = jobId;
  await printLedger(jobId);
  const job = await watch(jobId);

  const run = nodeRun(jobId);
  if (run) {
    const names = Object.keys(run.definitionEnv).sort();
    const definition = run.definition as { ops?: Array<{ type?: string; id?: string; args?: Record<string, unknown> }> };
    const op = definition.ops?.[0];
    say(`  what the stand-in Nosana API received for this job:`);
    say(`    op ${op?.type} "${op?.id}", image ${String(op?.args?.image)}, gpu ${String(op?.args?.gpu)}, required_vram ${String(op?.args?.required_vram)}, cmd ${JSON.stringify(op?.args?.cmd ?? null)}`);
    say(`    environment names (${names.length}): ${names.join(", ")}`);
    say(`    BASE_MODEL ${run.definitionEnv.BASE_MODEL} | METHOD ${run.definitionEnv.METHOD} | DATASET_SHA256 ${run.definitionEnv.DATASET_SHA256} | MAX_RUNTIME_SECONDS ${run.definitionEnv.MAX_RUNTIME_SECONDS}`);
    say(`    HYPERPARAMS ${run.definitionEnv.HYPERPARAMS}`);
    say(`    DATASET_URL ${run.definitionEnv.DATASET_URL}`);
    say(`    CALLBACK_URL ${run.definitionEnv.CALLBACK_URL}`);
    say(`    the node replaced: ${run.overridden.join(", ")} (-> ${SUBSTITUTE_MODEL})`);
    say(`  trainer: exit code ${run.exitCode}, ${run.lines.filter((line) => line.log.startsWith("WHEELSAI_EVENT ")).length} event lines on stdout, Nosana job timeStart ${run.timeStart} timeEnd ${run.timeEnd}`);
  }
  const { row } = await settlementChecks(jobId, before, { status: "completed", charged: true });
  check("the job page shows the charge and no cost-so-far once settled", job.actualCostCents === Number(row.actualCostCents) && job.costSoFarCents === null);
  say(`  job page: metrics.started ${JSON.stringify(job.metrics?.started)} | logSource ${job.metrics?.logSource} | partial ${job.partial} | trainLoss points ${job.metrics?.trainLoss?.length} | evalLoss ${JSON.stringify(job.metrics?.evalLoss)}`);
  say(`  job page: result ${short({ ...job.metrics?.result, trainLoss: undefined, evalLoss: undefined }, 700)}`);
  say(`  job page: fineTunedModel ${JSON.stringify(job.fineTunedModel)} | ledger rows on the page ${job.ledger?.length}`);

  // The adapter: storage against the trainer's event against the model row.
  const model = await db.fineTunedModel.findUnique({ where: { trainingJobId: jobId } });
  if (!model) fail("no fine-tuned model row was created");
  state.fineTunedModelId = model.id;
  const file = path.join(STORE_DIR, model.adapterKey);
  const stored = existsSync(file) ? readFileSync(file) : null;
  const storedSha = stored ? createHash("sha256").update(stored).digest("hex") : null;
  const uploaded = run?.lines
    .map((line) => line.log)
    .filter((line) => line.startsWith("WHEELSAI_EVENT "))
    .map((line) => JSON.parse(line.slice("WHEELSAI_EVENT ".length)) as Record<string, unknown>)
    .find((event) => event.type === "uploaded");
  say(`  fine_tuned_models row: id ${model.id} | slug ${model.slug} | status ${model.status} | base ${model.baseModelId} (${model.baseModelHfId}) | method ${model.method} | lora_r ${model.loraR}`);
  say(`    adapter_key ${model.adapterKey} | adapter_bytes ${model.adapterBytes} | adapter_sha256 ${model.adapterSha256}`);
  say(`  trainer's uploaded event: adapterBytes ${String(uploaded?.adapterBytes)} | adapterSha256 ${String(uploaded?.adapterSha256)}`);
  say(`  object in the store:      bytes ${stored?.length ?? "missing"} | sha256 ${storedSha}`);
  check("the stored adapter, the trainer's event and the model row agree on size and sha256",
    stored !== null && storedSha === model.adapterSha256 && storedSha === uploaded?.adapterSha256 &&
      BigInt(stored.length) === model.adapterBytes && stored.length === uploaded?.adapterBytes);
  check("the job row points at the model", row.outputModelId === model.id);
  check("progress came from callbacks", job.metrics?.logSource === "callbacks");

  const logs = await call("GET", `/api/training/jobs/${jobId}/logs?tail=10`, undefined, { quiet: true });
  say(`[${clock()}] GET /api/training/jobs/<id>/logs?tail=10 -> HTTP ${logs.status} source ${logs.body.source} totalLines ${logs.body.totalLines}; last line:`);
  const lines = String(logs.body.logs ?? "").trim().split("\n");
  say(`    ${lines[lines.length - 1]}`);
  for (const line of apiLogLines(/[Tt]raining|Nosana deployment/, mark)) say(`  api log: ${line}`);
  say("  the API's own record of what Nosana reported when the run ended (here: the stand-in):");
  for (const line of apiLogBlock("Training run ended", mark)) say(`    ${line.trim()}`);

  const list = await call("GET", "/api/training/fine-tuned-models", undefined, { quiet: true });
  say(`[${clock()}] GET /api/training/fine-tuned-models -> HTTP ${list.status} total ${list.body.total}: ${short(list.body.fineTunedModels?.map((entry: any) => ({ id: entry.id, slug: entry.slug, baseModelId: entry.baseModelId, method: entry.method, loraR: entry.loraR, adapterBytes: entry.adapterBytes, activeDeployments: entry.activeDeployments, trainingJob: entry.trainingJob?.status })), 600)}`); // eslint-disable-line @typescript-eslint/no-explicit-any
}

function signCallback(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

async function scenarioCallbacks(): Promise<void> {
  heading("D. The callback route: a bad signature is refused before anything is read");
  const jobId = state.happyJobId!;
  const row = await jobRow(jobId);
  const nonce = row.submitNonce!;
  const url = `/api/training/jobs/${jobId}/events?n=${nonce}`;
  // The documented derivation, redone here independently of the API's code.
  const secret = createHmac("sha256", JWT_SECRET).update(`training-callback-v1:${jobId}:${nonce}`).digest("hex");
  SECRETS.push(secret);
  const body = JSON.stringify({
    v: 1,
    seq: 99,
    ts: new Date().toISOString(),
    type: "completed",
    finalTrainLoss: 0.01,
    finalEvalLoss: null,
    trainSeconds: 1,
    steps: 1,
    totalSteps: 1,
    stopReason: "finished",
    jobId,
  });
  const before = await counts();
  const rowBefore = JSON.stringify({ s: row.status, seq: row.lastEventSeq, c: cents(row.actualCostCents), u: row.updatedAt });
  const post = async (label: string, headers: Record<string, string>, raw: string | Buffer, target = url) => {
    const answer = await call("POST", target, undefined, { quiet: true, raw, headers: { "content-type": "application/json", ...headers } });
    say(`  ${label} -> HTTP ${answer.status} ${short(answer.body, 200)}`);
    return answer;
  };
  const noHeader = await post("no signature header", {}, body);
  const wrongKey = await post("signed with another key", { "x-wheelsai-signature": signCallback("0".repeat(64), body) }, body);
  const tampered = await post("valid signature, body changed afterwards", { "x-wheelsai-signature": signCallback(secret, body) }, body.replace('"seq":99', '"seq":98'));
  const stale = await post("valid signature, timestamp 20 minutes old", { "x-wheelsai-signature": signCallback(secret, body, Math.floor(Date.now() / 1000) - 1200) }, body);
  const otherNonce = await post("valid signature, another nonce in the URL", { "x-wheelsai-signature": signCallback(secret, body) }, body, `/api/training/jobs/${jobId}/events?n=${"a".repeat(16)}`);
  const big = Buffer.alloc(70_000, 0x20);
  const oversize = await post("a 70,000-byte body", { "x-wheelsai-signature": signCallback(secret, big.toString()) }, big);
  const notEvent = '{"hello":"world"}';
  const invalid = await post("valid signature, not a trainer event", { "x-wheelsai-signature": signCallback(secret, notEvent) }, notEvent);
  const replay = await post("valid signature, a `completed` event for a job that is already settled", { "x-wheelsai-signature": signCallback(secret, body) }, body);
  check("no header, another key, a changed body, a stale timestamp and another nonce are all 401",
    [noHeader, wrongKey, tampered, stale, otherNonce].every((answer) => answer.status === 401 && answer.body.error === "invalid_callback_signature"));
  check("an oversize body is 413", oversize.status === 413);
  check("a signed body that is not a trainer event is 400", invalid.status === 400);
  check("a correctly signed event for a settled job is accepted and not applied", replay.status === 200 && replay.body.applied === false);
  const after = await jobRow(jobId);
  const rowAfter = JSON.stringify({ s: after.status, seq: after.lastEventSeq, c: cents(after.actualCostCents), u: after.updatedAt });
  say(`  before: ${before}`);
  say(`  after:  ${await counts()}`);
  check("the job row, the ledger and the balance are unchanged", before === (await counts()) && rowBefore === rowAfter);
}

async function scenarioServing(): Promise<void> {
  heading("E. Serving the model: the deployment's job definition and the adapter download route");
  const modelId = state.fineTunedModelId!;
  const model = await db.fineTunedModel.findUnique({ where: { id: modelId } });
  if (!model) fail("the fine-tuned model row is gone");
  say("The deployment is created through POST /api/deployments. Its definition reaches the stand-in only; nothing runs it.");
  const balanceBefore = await balance();
  const created = await call("POST", "/api/deployments", {
    name: "Proof adapter serving",
    fineTunedModelId: modelId,
    gpuTier: TIER,
    engine: "vllm",
    replicas: 1,
  });
  if (created.status !== 201) fail(`the deployment was not created: HTTP ${created.status}`);
  const deploymentId = created.body.deployment.id as string;

  // The submit is deferred: wait until the stand-in holds the deployment.
  const name = `wheelsai-model-${deploymentId}-r0`;
  const deadline = Date.now() + 30_000;
  let request: (typeof node.fake.requests)[number] | undefined;
  while (!request && Date.now() < deadline) {
    request = node.fake.requests.find(
      (entry) => entry.path === "/api/deployments/create" && (entry.body as { name?: string } | undefined)?.name === name,
    );
    if (!request) await sleep(300);
  }
  if (!request) fail("the deployment's definition never reached the stand-in");
  const sent = request.body as { name: string; timeout: number; strategy: string; confidential: boolean; job_definition: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const op = sent.job_definition.ops[0];
  say(`  what the stand-in received: name ${sent.name}, strategy ${sent.strategy}, timeout ${sent.timeout}, confidential ${sent.confidential}`);
  say(`  job definition (the container op):`);
  say(`    image ${op.args.image} | gpu ${op.args.gpu} | required_vram ${op.args.required_vram ?? "-"} | expose ${JSON.stringify(op.args.expose)}`);
  say(`    entrypoint ${JSON.stringify(op.args.entrypoint)}`);
  say(`    cmd[0] the constant Python bootstrap (${String(op.args.cmd[0]).length} characters, sha256 ${createHash("sha256").update(String(op.args.cmd[0])).digest("hex").slice(0, 16)}...)`);
  say(`    cmd[1..] ${JSON.stringify(op.args.cmd.slice(1))}`);
  const env = op.args.env as Record<string, string>;
  for (const key of Object.keys(env).sort()) say(`    env ${key}=${env[key]}`);

  const dbRow = await db.deployment.findUnique({ where: { id: deploymentId } });
  say(`  deployment row: status ${dbRow?.status} | fine_tuned_model_id ${dbRow?.fineTunedModelId} | run_generation ${dbRow?.runGeneration} | engine ${dbRow?.engine} | reservation ${cents(dbRow?.reservationCents)} | balance ${balanceBefore} -> ${await balance()}`);
  check("the deployment row names the fine-tuned model", dbRow?.fineTunedModelId === modelId);
  check("vLLM is started with the adapter as a LoRA module", op.args.cmd.includes("--enable-lora") && op.args.cmd.some((arg: string) => arg === `ft-${model.slug}=/adapters/ft-${model.slug}`));
  check("the definition carries the adapter's sha256 and size from the model row",
    env.WHEELSAI_ADAPTER_SHA256 === model.adapterSha256 && env.WHEELSAI_ADAPTER_MAX_BYTES !== undefined);

  const url = env.WHEELSAI_ADAPTER_URL!;
  say(`  the adapter URL in the definition: ${url}`);
  const good = await fetch(url);
  const bytes = Buffer.from(await good.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  say(`  GET <adapter URL> (no session) -> HTTP ${good.status} ${good.headers.get("content-type")} ${bytes.length} bytes sha256 ${sha}`);
  check("the route streams the adapter for an active deployment row", good.status === 200 && sha === model.adapterSha256);

  const parsed = new URL(url);
  const variant = async (label: string, change: (u: URL) => void) => {
    const u = new URL(parsed.toString());
    change(u);
    const answer = await fetch(u);
    const text = await answer.text();
    say(`  ${label} -> HTTP ${answer.status} ${short(text, 120)}`);
    return answer.status;
  };
  const refusals = [
    await variant("signature with one character changed", (u) => {
      const sig = u.searchParams.get("sig")!;
      u.searchParams.set("sig", (sig[0] === "0" ? "1" : "0") + sig.slice(1));
    }),
    await variant("the next run generation (g=1) with the same signature", (u) => u.searchParams.set("g", "1")),
    await variant("another deployment id with the same signature", (u) => u.searchParams.set("d", "00000000-0000-4000-8000-000000000000")),
    await variant("no signature", (u) => u.searchParams.delete("sig")),
  ];
  check("a forged or re-used signature is answered 404", refusals.every((status) => status === 404));

  // The definition's own bootstrap, run with the definition's environment
  // (only the target directory moved off /adapters). vLLM is not installed
  // here, so the exec at its end fails; everything before it is real.
  const adapterDir = path.join(SCRATCH, "served-adapter");
  const bootstrap = spawnSync(PYTHON, ["-c", String(op.args.cmd[0]), ...op.args.cmd.slice(1)], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env, WHEELSAI_ADAPTER_DIR: adapterDir },
    encoding: "utf8",
    timeout: 120_000,
  });
  const files = spawnSync("ls", ["-1", adapterDir], { encoding: "utf8" }).stdout.trim().split("\n");
  const lastLine = `${bootstrap.stdout}\n${bootstrap.stderr}`.trim().split("\n").pop() ?? "";
  say(`  the bootstrap of the definition, run here against the route: exit ${bootstrap.status}; last line: ${short(lastLine, 200)}`);
  say(`    extracted into the adapter directory: ${files.join(", ")}`);
  check("the bootstrap downloaded, verified and extracted the three files", files.length === 3 && files.includes("adapter_model.safetensors"));
  check("it stopped only at starting vLLM, which is not installed on this machine", /No module named '?vllm/.test(lastLine));

  const generated = spawnSync(
    PYTHON,
    [path.join(HERE, "fine-tune-local-proof-generate.py"), SUBSTITUTE_MODEL, adapterDir, "Add 7 and 8, in WheelsAI report style."],
    { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HF_HOME, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }, encoding: "utf8", timeout: 300_000 },
  );
  say(`  base model with and without the downloaded adapter (peft on CPU, not vLLM):`);
  for (const line of generated.stdout.trim().split("\n")) say(`    ${line}`);
  check("the adapter loads on the substitute base model and answers", generated.status === 0 && /adapter\s+'/.test(generated.stdout));

  const inUse = await call("DELETE", `/api/training/fine-tuned-models/${modelId}`);
  check("the model cannot be deleted while a deployment serves it", inUse.status === 409 && inUse.body.error === "model_in_use");

  const stopped = await call("DELETE", `/api/deployments/${deploymentId}`);
  const after = await db.deployment.findUnique({ where: { id: deploymentId } });
  say(`  deployment row: status ${after?.status} | balance ${await balance()} (the deployment's hold is returned; it never ran)`);
  const revoked = await fetch(url);
  say(`  GET <the same adapter URL> after the stop -> HTTP ${revoked.status} ${short(await revoked.text(), 120)}`);
  check("stopping the deployment revokes its adapter URL", stopped.status === 200 && revoked.status === 404);
  check("the deployment cost nothing", (await balance()) === balanceBefore);
}

async function bigDataset(): Promise<string> {
  if (state.bigDatasetId) return state.bigDatasetId;
  // The fixture's 40 rows, eight times: long enough on CPU to be cancelled or to reach a run limit.
  const rows = readFileSync(FIXTURE, "utf8").trim().split("\n");
  const content = Buffer.from(`${Array.from({ length: 8 }, () => rows).flat().join("\n")}\n`);
  state.bigDatasetId = await uploadDataset("proof-tiny-x8", "tiny-x8.jsonl", content, false);
  return state.bigDatasetId;
}

async function scenarioCancel(): Promise<void> {
  heading("F. A run the user cancels: charged up to the request, not for the stop");
  const datasetId = await bigDataset();
  const { jobId, before } = await createJob("Proof cancelled", datasetId, { epochs: 10, batchSize: 4, gradientAccumulationSteps: 1, maxSeqLength: 128 });
  await watch(jobId, { until: (job) => job.status === "running" && (job.currentStep ?? 0) >= 3 });
  say("  (letting it train for 12 more seconds)");
  await sleep(12_000);
  const cancel = await call("POST", `/api/training/jobs/${jobId}/cancel`);
  check("the cancel is accepted", cancel.status === 200 || cancel.status === 202);
  const again = await call("POST", `/api/training/jobs/${jobId}/cancel`);
  check("a second cancel is 409", again.status === 409);
  await watch(jobId);
  const run = nodeRun(jobId);
  // The job is settled before the node has stopped the process: wait to see how it ended.
  for (let waited = 0; run && run.phase !== "exited" && waited < 30_000; waited += 250) await sleep(250);
  say(`  trainer: exit code ${run?.exitCode}; SIGTERM sent ${run?.stopSignalledAt ? new Date(run.stopSignalledAt).toISOString().slice(11, 23) : "never"}; last event: ${short(run?.lines.filter((line) => line.log.startsWith("WHEELSAI_EVENT ")).pop()?.log ?? "", 260)}`);
  const { row } = await settlementChecks(jobId, before, { status: "cancelled", charged: true });
  if (row.startedAt && row.cancelRequestedAt && row.billedSeconds != null) {
    const toRequest = (row.cancelRequestedAt.getTime() - row.startedAt.getTime()) / 1000;
    say(`  started -> cancel requested: ${toRequest.toFixed(1)} s; billed ${row.billedSeconds} s; cancel requested -> settled: ${((row.settledAt!.getTime() - row.cancelRequestedAt.getTime()) / 1000).toFixed(1)} s`);
    check("billed time ends at the cancel request", row.billedSeconds <= Math.ceil(toRequest) && row.billedSeconds >= Math.floor(toRequest) - 1);
  }
  check("no model was registered", (await db.fineTunedModel.count({ where: { trainingJobId: jobId } })) === 0);
}

async function scenarioDataFailure(): Promise<void> {
  heading("G. A failure the data caused: charged for the seconds run");
  // Valid alpaca rows (the API's validation accepts them), but every prompt is
  // longer than the sequence length chosen, so no answer token is left to learn from.
  const filler = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
  const content = Buffer.from(
    `${Array.from({ length: 12 }, (_, index) => JSON.stringify({ instruction: `Summarise item ${index}: ${filler}`, output: `Summary ${index}.` })).join("\n")}\n`,
  );
  state.longDatasetId = await uploadDataset("proof-long-prompts", "long-prompts.jsonl", content, false);
  const { jobId, before } = await createJob("Proof data failure", state.longDatasetId, { epochs: 1, maxSeqLength: 128 });
  const job = await watch(jobId);
  const run = nodeRun(jobId);
  say(`  trainer: exit code ${run?.exitCode}; last event: ${short(run?.lines.filter((line) => line.log.startsWith("WHEELSAI_EVENT ")).pop()?.log ?? "", 400)}`);
  say(`  job page: failure ${JSON.stringify(job.failure)}`);
  await settlementChecks(jobId, before, { status: "failed", charged: true });
  check("the failure names the trainer's code and says it was charged", job.failure?.code === "dataset_no_usable_rows" && job.failure?.charged === true);
}

async function scenarioPlatformFailure(): Promise<void> {
  heading("H. A failure the platform caused: the base model could not be pulled; charged nothing");
  node.planNext({
    env: { BASE_MODEL: "wheelsai-proof/model-that-does-not-exist" },
    note: "BASE_MODEL names a model that is not in the node's cache, with the Hub switched off",
  });
  const { jobId, before } = await createJob("Proof platform failure", state.datasetId!, HAPPY_HYPERPARAMS);
  const job = await watch(jobId);
  const run = nodeRun(jobId);
  say(`  trainer: exit code ${run?.exitCode}; last event: ${short(run?.lines.filter((line) => line.log.startsWith("WHEELSAI_EVENT ")).pop()?.log ?? "", 400)}`);
  say(`  job page: failure ${JSON.stringify(job.failure)}`);
  await settlementChecks(jobId, before, { status: "failed", charged: false });
  check("the failure is a base-model code and says nothing was charged", String(job.failure?.code).startsWith("base_model_") && job.failure?.charged === false);
}

async function scenarioQueueTimeout(): Promise<void> {
  heading("I. No node takes the job: failed after the queue timeout (60 s here), charged nothing");
  node.planNext({ neverTake: true });
  const { jobId, before } = await createJob("Proof no capacity", state.datasetId!, HAPPY_HYPERPARAMS);
  const job = await watch(jobId, { timeoutMs: 180_000 });
  say(`  job page: failure ${JSON.stringify(job.failure)}`);
  const { row } = await settlementChecks(jobId, before, { status: "failed", charged: false });
  if (row.queuedAt && row.settledAt) say(`  queued -> settled: ${((row.settledAt.getTime() - row.queuedAt.getTime()) / 1000).toFixed(1)} s`);
  check("the failure code is no_capacity", job.failure?.code === "no_capacity");
  check("the deployment was stopped on the stand-in", ["STOPPING", "STOPPED"].includes(standInDeployment(jobId)?.status ?? ""));
}

async function scenarioSubmitFailure(): Promise<void> {
  heading("J. The submit fails (the stand-in answers 500 to the create): failed, charged nothing");
  const listsBefore = node.fake.requests.filter((entry) => entry.method === "GET" && entry.path === "/api/deployments").length;
  const mark = logMark();
  node.fake.failNext({ method: "POST", path: /^\/api\/deployments\/create$/ }, { status: 500, body: { error: "stand-in: create failed" } }, 1);
  const { jobId, before } = await createJob("Proof submit failure", state.datasetId!, HAPPY_HYPERPARAMS);
  const job = await watch(jobId, { timeoutMs: 120_000 });
  say(`  job page: failure ${JSON.stringify(job.failure)}`);
  await settlementChecks(jobId, before, { status: "failed", charged: false });
  const row = await jobRow(jobId);
  const lists = node.fake.requests.filter((entry) => entry.method === "GET" && entry.path === "/api/deployments").length - listsBefore;
  say(`  deployment name of this attempt: wheelsai-train-${jobId}-${row.submitNonce}; list requests to the stand-in after the failure: ${lists}`);
  check("the failure code is submit_failed", job.failure?.code === "submit_failed");
  check("Nosana's list was asked for the deterministic name before the refund", lists >= 1);
  for (const line of apiLogLines(/[Tt]raining|Nosana deployment/, mark, 8)) say(`  api log: ${line}`);
}

let blocker: { server: Server; count(): number } | null = null;

async function startBlocker(): Promise<void> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    req.resume();
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("blocked");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(BLOCKER_PORT, "127.0.0.1", resolve);
  });
  blocker = { server, count: () => count };
}

async function scenarioLogsOnly(): Promise<void> {
  heading("K. Callbacks blocked: the run is followed and completed from the job's logs alone");
  await startBlocker();
  node.planNext({
    env: { CALLBACK_URL: `http://127.0.0.1:${BLOCKER_PORT}/blocked` },
    note: "CALLBACK_URL points at a server that answers 403 to everything",
  });
  const mark = logMark();
  const { jobId, before } = await createJob("Proof logs only", state.datasetId!, HAPPY_HYPERPARAMS);
  const job = await watch(jobId);
  for (const line of apiLogBlock("Training run ended", mark)) say(`    api log: ${line.trim()}`);
  const row = await jobRow(jobId);
  const received = stripAnsi(apiLogText()).split(`${jobId}/events`).length - 1;
  say(`  callbacks the blocker refused: ${blocker!.count()}; mentions of this job's callback route in the API's log: ${received}`);
  await settlementChecks(jobId, before, { status: "completed", charged: true });
  say(`  job page: logSource ${job.metrics?.logSource} | step ${job.currentStep}/${job.totalSteps} | loss ${job.trainingLoss} | eval ${job.evalLoss} | fineTunedModel ${JSON.stringify(job.fineTunedModel)}`);
  const logs = await call("GET", `/api/training/jobs/${jobId}/logs?tail=10`, undefined, { quiet: true });
  say(`  GET logs -> source ${logs.body.source}, totalLines ${logs.body.totalLines}`);
  check("every callback was blocked and none reached the API", blocker!.count() > 0 && received === 0);
  check("progress, the outcome and the log text came from the Nosana job result", job.metrics?.logSource === "nosana_result" && logs.body.source === "nosana_result" && row.lastEventSeq > 0);
  check("the adapter was verified and a model registered", job.fineTunedModel !== null);

  // The read-only script of the paid run's checklist, here against the stand-in.
  // Not spawnSync: the stand-in it reads from lives in this process.
  const checkScript = await runProcess(
    path.join(REPO, "node_modules/.bin/tsx"),
    ["--tsconfig", path.join(REPO, "apps/api/tsconfig.json"), path.join(HERE, "nosana-training-job-check.ts"), row.nosanaJobId ?? ""],
    { cwd: path.join(SCRATCH, "cwd"), env: { ...apiEnv, LOG_LEVEL: "error" } },
  );
  say(`$ npx tsx scripts/nosana-training-job-check.ts ${row.nosanaJobId}   (the API's environment; the stand-in answers)`);
  for (const line of checkScript.stdout.trimEnd().split("\n")) say(`  ${line}`);
  if (checkScript.status !== 0) say(`  exit ${checkScript.status}: ${short(checkScript.stderr.trim(), 600)}`);
  check("the check script reads the job the way the poller did", checkScript.status === 0 && /final event: completed/.test(checkScript.stdout) && /exit code: 0/.test(checkScript.stdout));
}

async function scenarioRunLimit(): Promise<void> {
  heading(`L. A run that reaches its own run limit (${RUN_LIMIT_SECONDS} s): partial adapter, charged, never above the hold`);
  const datasetId = await bigDataset();
  const { jobId, before } = await createJob("Proof run limit", datasetId, { epochs: 10, batchSize: 4, gradientAccumulationSteps: 1, maxSeqLength: 128 });
  const job = await watch(jobId, { timeoutMs: 600_000 });
  const run = nodeRun(jobId);
  say(`  trainer: exit code ${run?.exitCode}; last event: ${short(run?.lines.filter((line) => line.log.startsWith("WHEELSAI_EVENT ")).pop()?.log ?? "", 300)}`);
  const { hold, charge } = await settlementChecks(jobId, before, { status: "completed", charged: true });
  say(`  job page: partial ${job.partial} | step ${job.currentStep}/${job.totalSteps} | fineTunedModel ${JSON.stringify(job.fineTunedModel)}`);
  check("the job is marked partial and has a model", job.partial === true && job.fineTunedModel !== null);
  check("the charge is at or below the hold", charge <= hold);
}

async function scenarioRefusals(rpcUrl: string): Promise<void> {
  heading("M. Job creation refused when something is not configured: no row, no hold");
  const base = fineTuningEnv(rpcUrl);
  const body = {
    name: "Proof refused",
    baseModelId: BASE_MODEL_ID,
    datasetId: state.datasetId,
    method: "lora",
    gpuTier: TIER,
    maxRuntimeSeconds: RUN_LIMIT_SECONDS,
    hyperparams: HAPPY_HYPERPARAMS,
  };
  const cases: Array<{ label: string; env: Record<string, string>; status: number; code: string }> = [
    { label: "TRAINING_IMAGE unset", env: { ...base, TRAINING_IMAGE: "" }, status: 501, code: "training_image_not_configured" },
    { label: "TRAINING_IMAGE is a tag, not a digest", env: { ...base, TRAINING_IMAGE: "registry.invalid/wheelsai/trainer:latest" }, status: 501, code: "training_image_not_configured" },
    { label: "no object storage (STORAGE_DRIVER unset)", env: { ...base, STORAGE_DRIVER: "", STORAGE_LOCAL_DIR: "" }, status: 503, code: "dataset_storage_not_configured" },
    { label: "PUBLIC_API_URL unset", env: { ...base, PUBLIC_API_URL: "" }, status: 503, code: "training_callbacks_not_configured" },
    { label: "TRAINING_POLL_INTERVAL_MS=0", env: { ...base, TRAINING_POLL_INTERVAL_MS: "0" }, status: 503, code: "training_poller_disabled" },
    { label: "DEPLOYMENT_STATUS_INTERVAL_MS=0 (no orphan sweep)", env: { ...base, DEPLOYMENT_STATUS_INTERVAL_MS: "0" }, status: 503, code: "training_orphan_sweep_disabled" },
    { label: "no Nosana credential", env: { ...base, NOSANA_API_KEY: "", NOSANA_ACCESS_MODE: "" }, status: 501, code: "nosana_not_configured" },
    { label: "the development Nosana mock on (ALLOW_NOSANA_MOCK=true)", env: { ...base, ALLOW_NOSANA_MOCK: "true" }, status: 501, code: "training_requires_real_nosana" },
  ];
  for (const entry of cases) {
    await stopApi();
    // An empty value is an unset variable for this purpose.
    const env = Object.fromEntries(Object.entries(entry.env).filter(([, value]) => value !== ""));
    await startApi(env, entry.label);
    const before = await counts();
    const capabilities = await call("GET", "/api/training/capabilities", undefined, { quiet: true });
    say(`  capabilities: canStart ${capabilities.body.canStart}; blockers ${capabilities.body.blockers?.map((blocker: { code: string }) => blocker.code).join(", ") || "none"}`);
    const answer = await call("POST", "/api/training/jobs", body, { quiet: true });
    say(`  POST /api/training/jobs -> HTTP ${answer.status} ${short(answer.body, 300)}`);
    const after = await counts();
    say(`  before: ${before} | after: ${after}`);
    check(`${entry.label}: ${entry.status} ${entry.code}`, answer.status === entry.status && answer.body.error === entry.code);
    check("nothing was created or held", before === after);
  }
  // Insufficient credits, on the full configuration.
  await stopApi();
  await startApi(base, "full configuration again");
  const real = await balance();
  await db.creditBalance.update({ where: { orgId }, data: { balanceCents: 3n } });
  const before = await counts();
  const answer = await call("POST", "/api/training/jobs", body, { quiet: true });
  say(`  with the organization's balance set to 3 cents in the copy: POST /api/training/jobs -> HTTP ${answer.status} ${short(answer.body, 300)}`);
  check("insufficient credits is 402 with the required amount", answer.status === 402 && answer.body.error === "insufficient_credits");
  check("nothing was created or held", before === (await counts()));
  await db.creditBalance.update({ where: { orgId }, data: { balanceCents: real } });
}

// ============================================
// Main
// ============================================

/** Stands where the Solana RPC would: answers 500 and counts, to show nothing asked. */
async function startRequestCounter(): Promise<{ url: string; count(): number; close(): Promise<void> }> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    req.resume();
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no request was expected here" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(RPC_PORT, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${RPC_PORT}`,
    count: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function cleanup(counter: { close(): Promise<void> } | null): Promise<void> {
  await stopApi().catch(() => undefined);
  if (node) await node.close().catch(() => undefined);
  if (counter) await counter.close().catch(() => undefined);
  if (blocker) await new Promise<void>((resolve) => blocker!.server.close(() => resolve()));
  if (db) await db.$disconnect().catch(() => undefined);
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.flushdb();
    say(`Redis index ${redisIndex} flushed`);
  } catch (err) {
    say(`Redis index ${redisIndex} could not be flushed: ${(err as Error).message}`);
  } finally {
    redis.disconnect();
  }
  if (KEEP) {
    say(`--keep: database ${DB_NAME} and ${SCRATCH} are left in place`);
  } else {
    await dropCopy().catch((err) => say(`the copy could not be dropped: ${(err as Error).message}`));
    rmSync(SCRATCH, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  say("Fine-tuning: local end-to-end proof");
  say(`date ${new Date().toISOString()} | commit ${spawnSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim()} (plus the working tree)`);
  say(`API ${API} | stand-in Nosana http://127.0.0.1:${NOSANA_PORT} | database copy ${DB_NAME} | Redis index ${redisIndex} | object store: local driver in a temporary directory`);
  say(`trainer: ${PYTHON.replace(homedir(), "~")} infra/training/train.py --device cpu; base model loaded: ${SUBSTITUTE_MODEL}`);

  let counter: Awaited<ReturnType<typeof startRequestCounter>> | null = null;
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    cleanup(counter).finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    heading("Setup");
    await createCopy();
    migrate();
    db = new PrismaClient({ datasourceUrl: COPY_URL });
    const user = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
    if (!user) fail(`${DEMO_EMAIL} is not in the database copy`);
    const membership = await db.orgMember.findFirst({ where: { userId: user.id } });
    if (!membership) fail(`${DEMO_EMAIL} belongs to no organization`);
    orgId = membership.orgId;

    counter = await startRequestCounter();
    node = await startLocalNode({
      apiKey: NOSANA_KEY,
      port: NOSANA_PORT,
      python: PYTHON,
      trainerEntrypoint: TRAIN_PY,
      hfHome: HF_HOME,
      substituteBaseModel: SUBSTITUTE_MODEL,
      defaultTakeAfterMs: 5_000,
      log: (message) => say(`  [${clock()}] ${message}`),
    });
    say(`stand-in Nosana API and node listening on 127.0.0.1:${NOSANA_PORT}; Solana RPC stand-in (answers 500, counts) on ${counter.url}`);
    await startApi(fineTuningEnv(counter.url), "full configuration");
    for (const line of apiLogLines(/Nosana API key loaded|[Tt]raining poller/, 0, 4)) say(`  api log: ${line}`);
    await login();
    say(`organization ${orgId}: ${await counts()}`);
    const startBalance = await balance();

    // The dataset is needed by everything else.
    await scenarioDataset();
    if (wanted("estimate")) await scenarioEstimate();
    if (wanted("happy") || wanted("callbacks") || wanted("serving")) await scenarioHappy();
    if (wanted("callbacks")) await scenarioCallbacks();
    if (wanted("serving")) await scenarioServing();
    if (wanted("cancel")) await scenarioCancel();
    if (wanted("data-failure")) await scenarioDataFailure();
    if (wanted("platform-failure")) await scenarioPlatformFailure();
    if (wanted("queue-timeout")) await scenarioQueueTimeout();
    if (wanted("submit-failure")) await scenarioSubmitFailure();
    if (wanted("logs-only")) await scenarioLogsOnly();
    if (wanted("run-limit")) await scenarioRunLimit();

    heading("Totals before the refusals");
    const jobs = await db.trainingJob.findMany({ where: { orgId, reservationCents: { not: null } }, orderBy: { createdAt: "asc" } });
    let charged = 0n;
    say("  name | status | failure code | hold | charge | billed seconds");
    for (const job of jobs) {
      charged += job.actualCostCents ?? 0n;
      say(`  ${job.name} | ${job.status} | ${job.failureCode ?? "-"} | ${cents(job.reservationCents)} | ${cents(job.actualCostCents)} | ${job.billedSeconds ?? "-"}`);
    }
    const endBalance = await balance();
    say(`  balance at the start ${startBalance} | now ${endBalance} | difference ${startBalance - endBalance} | sum of the charges ${charged}`);
    check("the balance fell by exactly the sum of the charges", startBalance - endBalance === charged);
    const byType = await db.creditTransaction.groupBy({
      by: ["type"],
      where: { orgId, type: { startsWith: "training_" } },
      _count: true,
      _sum: { amountCents: true },
    });
    say(`  training ledger rows by type: ${byType.map((entry) => `${entry.type} x${entry._count} = ${cents(entry._sum.amountCents)}`).join(" | ")}`);
    const reservations = byType.find((entry) => entry.type === "training_reservation")?._count ?? 0;
    const releases = byType.find((entry) => entry.type === "training_reservation_release")?._count ?? 0;
    check("every hold was released exactly once", reservations === releases && reservations === jobs.length, `${reservations} holds, ${releases} releases, ${jobs.length} jobs`);
    check("no job is left unfinished", jobs.every((job) => TERMINAL.includes(job.status)));
    const requests = node.fake.requests;
    say(`  stand-in: ${requests.length} Nosana requests (${requests.filter((entry) => entry.path === "/api/deployments/create").length} creates, ${requests.filter((entry) => entry.path.endsWith("/stop")).length} stops), ${node.fake.vaultCalls()} vault requests; Solana RPC requests: ${counter.count()}`);
    const orphans = await db.nosanaOrphanDeployment.groupBy({ by: ["reason"], where: { sourceKind: "training" }, _count: true });
    say(`  orphan records written for the sweep (all of them, closed or not; the deployment status worker that runs the sweep is on, every 5 s): ${orphans.map((entry) => `${entry.reason} x${entry._count}`).join(", ") || "none"}`);
    say(`  stand-in deployments at the end: ${[...node.fake.deployments.values()].map((deployment) => `${deployment.id}:${deployment.status}`).join(" ")}`);
    check("no Solana RPC request was made", counter.count() === 0);
    const log = apiLogText();
    check("the Nosana key and the server secret are in no line of the API's log", !log.includes(NOSANA_KEY) && !log.includes(JWT_SECRET));

    if (wanted("refusals")) await scenarioRefusals(counter.url);

    heading("Result");
    say(failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED:\n  - ${failures.join("\n  - ")}`);
  } finally {
    heading("Cleanup");
    await cleanup(counter);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(mask(String((err as Error).stack ?? err)));
  process.exit(1);
});
