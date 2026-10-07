/**
 * The training job service: create, submit, record what the container
 * reports, reconcile with Nosana, finalise, cancel.
 *
 * The rules it follows are in services/trainingStateMachine.ts (states,
 * transitions, who pays) and services/trainingBilling.ts (the hold and the
 * settlement). In short:
 *
 *   - every status change is a compare-and-set on the expected status; a
 *     count of 0 means another writer won and nothing else is changed;
 *   - the hold is taken in the transaction that creates the row, and returned
 *     (with the charge, when there is one) in the transaction of the terminal
 *     compare-and-set, exactly once;
 *   - container callbacks never write a terminal state and never move money:
 *     they record progress and the trainer's own report and then ask for the
 *     same reconcile the poller runs. Both may run at once;
 *   - a Nosana deployment is never forgotten: it is stopped and verified
 *     released, or handed to the orphan sweep with the credential that
 *     created it, before the job that owned it is refunded.
 *
 * Refusals are returned ({ ok: false, status, code, message }), never thrown.
 * Pure but for the injected dependencies (services/buildTrainingDeps.ts).
 */

import { createHash } from "node:crypto";

import { rowAccessMode, type NosanaAccessMode } from "../config/nosanaAccess.js";
import {
  trainingNosanaTimeoutSeconds,
  trainingRunLimitBounds,
  trainingTransferUrlTtlSeconds,
  type TrainingImageConfig,
} from "../config/training.js";
import {
  findTrainableModel,
  listTrainableModels,
  selectTraining,
  TRAINING_METHODS,
  type TrainableModel,
  type TrainingMethod,
} from "../config/trainingCatalog.js";
import {
  datasetObjectKey,
  datasetObjectState,
  knownDatasetRowCount,
  rowCountUnknownRefusal,
  type DatasetRecord,
} from "./dataset.js";
import type { DeploymentJobSnapshot, NosanaClient } from "./nosana.js";
import { isMockNosanaId } from "./nosanaIds.js";
import type { RecordNosanaOrphanArgs } from "./nosanaOrphans.js";
import { computeRefusal, runDeployPreflight, type DeployPreflightPort } from "./nosanaPreflight.js";
import type { IssueTransferUrlArgs, ObjectStore, TransferUrl } from "./objectStore.js";
import {
  reserveTrainingCredits,
  settleTrainingJob,
  trainingBillableMs,
  trainingCostSoFarCents,
  trainingHoldCents,
  trainingPriceMicroUsdPerSecond,
  TRAINING_RELEASE_LEDGER_TYPE,
  TRAINING_RESERVATION_LEDGER_TYPE,
  TRAINING_USAGE_LEDGER_TYPE,
  type SettleTrainingJobResult,
  type TrainingTerminalFields,
} from "./trainingBilling.js";
import { estimateTraining, type TrainingEstimate } from "./trainingEstimate.js";
import {
  buildTrainingJobDefinition,
  resolveTrainingHyperparams,
  trainingDeploymentName,
  TRAINING_HYPERPARAM_BOUNDS,
  TRAINING_HYPERPARAM_DEFAULTS,
  TRAINING_LORA_RANKS,
  validateTrainingHyperparams,
  type TrainingHyperparams,
} from "./trainingJobDefinition.js";
import {
  recordFailedTrainingSubmit,
  retireTrainingDeployment,
  trainingSubmitStamp,
} from "./trainingNosana.js";
import {
  ACTIVE_TRAINING_STATES,
  CANCELLABLE_TRAINING_STATES,
  classifyTrainingOutcome,
  isTerminalTrainerEvent,
  isTerminalTrainingState,
  parseTrainerCallbackBody,
  parseTrainerEvent,
  parseTrainerEventsFromLog,
  TRAINER_EVENT_PREFIX,
  TRAINER_EXIT,
  TRAINING_FAILURE_CODES,
  type TerminalTrainingState,
  type TrainerEvent,
  type TrainerTerminalEvent,
  type TrainingDeploymentState,
  type TrainingOutcome,
  type TrainingPlatformFinding,
  type TrainingState,
} from "./trainingStateMachine.js";
import {
  isTrainingSubmitNonce,
  TRAINING_CALLBACK_MAX_BYTES,
  verifyTrainingCallbackSignature,
} from "./trainingWebhookAuth.js";

// ============================================
// Time rules of the reconcile
// ============================================

/** A pending row older than this has lost its in-process submitter: the poller submits it. */
export const TRAINING_PENDING_RECOVERY_SECONDS = 60;
/** A submit that has stored no id after this long is treated as lost. */
export const TRAINING_SUBMIT_TIMEOUT_SECONDS = 600;
/** How long a lost submit waits for Nosana's list to be readable before it is refunded anyway. */
export const TRAINING_SUBMIT_LOOKUP_GIVE_UP_SECONDS = 3_600;
/** How long a job that ended may wait for its result (exit code, logs) to appear. */
export const TRAINING_RESULT_GRACE_SECONDS = 300;
/** How far past its Nosana timeout a run may go before we stop it ourselves. */
export const TRAINING_OVERRUN_GRACE_SECONDS = 600;
/** Clock difference tolerated when a Nosana time is used for billing. */
export const TRAINING_CLOCK_SKEW_MS = 5 * 60_000;
/** Stored log text is cut to its last this-many characters. */
export const TRAINING_LOG_MAX_CHARS = 1_048_576;
/** Largest metrics.json accepted (and the size its upload URL is issued for). */
export const TRAINING_METRICS_MAX_BYTES = 5 * 1024 * 1024;

const ADAPTER_CONTENT_TYPE = "application/gzip";
const METRICS_CONTENT_TYPE = "application/json";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// ============================================
// Rows and ports
// ============================================

/** A TrainingJob row, as Prisma returns it. */
export interface TrainingJobRow {
  id: string;
  orgId: string;
  name: string;
  baseModelId: string;
  baseModelHfId: string;
  datasetId: string;
  method: string;
  config: unknown;
  hyperparams: unknown;
  datasetSha256: string | null;
  gpuTier: string;
  gpuCount: number;
  status: string;
  progress: number;
  currentEpoch: number | null;
  totalEpochs: number | null;
  currentStep: number | null;
  totalSteps: number | null;
  failureCode: string | null;
  maxRuntimeSeconds: number | null;
  nosanaTimeoutSeconds: number | null;
  submitNonce: string | null;
  submitStartedAt: Date | null;
  queuedAt: Date | null;
  cancelRequestedAt: Date | null;
  gpuStoppedAt: Date | null;
  lastEventSeq: number;
  lastEventAt: Date | null;
  reportedOutcome: unknown;
  /** When the poller last took the job up (buildTrainingPollerTickDeps). */
  lastReconciledAt: Date | null;
  nosanaJobId: string | null;
  nosanaJobAddress: string | null;
  nosanaAccessMode: string | null;
  outputModelId: string | null;
  outputPath: string | null;
  trainingLoss: number | null;
  evalLoss: number | null;
  metrics: unknown;
  logs: string | null;
  lastError: string | null;
  estimatedCostCents: bigint | null;
  actualCostCents: bigint | null;
  reservationCents: bigint | null;
  priceMicroUsdPerSecond: bigint | null;
  billedSeconds: number | null;
  settledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The columns a list reads: everything but the log text (up to a megabyte a
 * row) and the JSON columns, which only the page of one job shows.
 */
export const TRAINING_JOB_LIST_COLUMNS = [
  "id", "orgId", "name", "baseModelId", "baseModelHfId", "datasetId", "method", "gpuTier",
  "gpuCount", "status", "progress", "currentEpoch", "totalEpochs", "currentStep", "totalSteps",
  "failureCode", "maxRuntimeSeconds", "cancelRequestedAt", "gpuStoppedAt", "queuedAt",
  "outputModelId", "trainingLoss", "evalLoss", "lastError", "estimatedCostCents",
  "actualCostCents", "reservationCents", "priceMicroUsdPerSecond", "billedSeconds", "settledAt",
  "startedAt", "completedAt", "createdAt",
] as const satisfies ReadonlyArray<keyof TrainingJobRow>;

export type TrainingJobListColumn = (typeof TRAINING_JOB_LIST_COLUMNS)[number];
export type TrainingJobListRow = Pick<TrainingJobRow, TrainingJobListColumn>;

export interface FineTunedModelRow {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  trainingJobId: string;
}

export interface TrainingModelRow {
  id: string;
  hfId: string;
  displayName: string;
  parameters: bigint | null;
  isActive: boolean;
}

export interface TrainingLedgerRow {
  id: string;
  type: string;
  amountCents: bigint;
  balanceAfter: bigint;
  description: string | null;
  createdAt: Date;
}

type Where = Record<string, unknown>;
type Data = Record<string, unknown>;

/** What a transaction client must offer (the billing cores take it `as never`). */
export interface TrainingTx {
  trainingJob: {
    create(args: { data: Data }): Promise<TrainingJobRow>;
    count(args: { where: Where }): Promise<number>;
  };
  dataset: {
    findFirst(args: { where: Where }): Promise<DatasetRecord | null>;
  };
  creditBalance: {
    /** The first statement of a create: an update takes the row lock (R3). */
    updateMany(args: { where: Where; data: Data }): Promise<{ count: number }>;
  };
}

/** The slice of the Prisma client this service uses. */
export interface TrainingPrisma {
  trainingJob: {
    findFirst(args: { where: Where }): Promise<TrainingJobRow | null>;
    findMany(args: {
      where: Where;
      select: Record<TrainingJobListColumn, true>;
      orderBy?: Record<string, "asc" | "desc">;
      take?: number;
    }): Promise<TrainingJobListRow[]>;
    count(args: { where: Where }): Promise<number>;
    updateMany(args: { where: Where; data: Data }): Promise<{ count: number }>;
  };
  dataset: {
    findFirst(args: { where: Where }): Promise<DatasetRecord | null>;
    findMany(args: { where: Where }): Promise<DatasetRecord[]>;
  };
  model: {
    findUnique(args: { where: { id: string } }): Promise<TrainingModelRow | null>;
    findMany(args: { where: Where }): Promise<TrainingModelRow[]>;
  };
  fineTunedModel: {
    findUnique(args: { where: { trainingJobId: string } }): Promise<FineTunedModelRow | null>;
    create(args: { data: Data }): Promise<FineTunedModelRow>;
  };
  creditBalance: {
    findUnique(args: { where: { orgId: string } }): Promise<{ balanceCents: bigint } | null>;
  };
  creditTransaction: {
    findMany(args: {
      where: Where;
      orderBy?: Record<string, "asc" | "desc">;
    }): Promise<TrainingLedgerRow[]>;
  };
  $transaction<T>(fn: (tx: TrainingTx) => Promise<T>): Promise<T>;
}

/** What is needed of the Nosana client (services/nosana.ts). */
export type TrainingNosanaPort = DeployPreflightPort &
  Pick<
    NosanaClient,
    | "createDeployment"
    | "getDeploymentStatus"
    | "getDeploymentJob"
    | "findDeploymentByName"
    | "findDeploymentByIdempotencyKey"
    | "stopDeployment"
  >;

export interface TrainingTierInfo {
  name: string;
  vram: number;
  pricePerSecond: number;
}

/** Everything read from configuration, resolved when it is asked for. */
export interface TrainingRuntime {
  image: TrainingImageConfig;
  hfToken: string | undefined;
  /** 0 = the poller is off. */
  pollIntervalMs: number;
  queueTimeoutSeconds: number;
  setupAllowanceSeconds: number;
  maxActiveJobsPerOrg: number;
  /** Jobs of one organization that may end failed and free in a rolling 24 hours. */
  freeFailuresPerDay: number;
  /**
   * The deployment status worker runs (DEPLOYMENT_STATUS_INTERVAL_MS > 0). Its
   * tick is the orphan sweep that stops a deployment a job handed over when
   * its own stop did not land; without it a lost GPU would run unwatched.
   */
  orphanSweepEnabled: boolean;
  adapterMaxBytes: number;
  datasetMaxBytes: number;
  datasetMaxRows: number;
  /** NOSANA_BATCH_JOB_TIMEOUT_SECONDS: the ceiling of run limit + allowance. */
  batchJobTimeoutSeconds: number;
  /** PUBLIC_API_URL without a trailing slash; null when unset. */
  publicApiUrl: string | null;
  /** The development Nosana mock is on: nothing would really run. */
  nosanaMock: boolean;
  /** A Nosana credential is configured. */
  nosanaConfigured: boolean;
  /** Tiers a job may be placed on (every tier when the mock is on). */
  tiers: Record<string, TrainingTierInfo>;
  /** Every tier of the price table, for display. */
  allTiers: Record<string, TrainingTierInfo>;
}

/**
 * The tiers a job may be placed on. While nothing would really run (the
 * development mock is on, or no Nosana credential is configured) every tier
 * of the price table passes the tier check, so the refusal a caller sees is
 * the honest one further down the order (501 training_requires_real_nosana,
 * 501 nosana_not_configured) and not 400 unknown_gpu_tier for a tier that is
 * only missing because there is no account to list it for.
 */
export function placeableTrainingTiers(args: {
  deployable: Record<string, TrainingTierInfo>;
  all: Record<string, TrainingTierInfo>;
  nosanaMock: boolean;
  nosanaConfigured: boolean;
}): Record<string, TrainingTierInfo> {
  return args.nosanaMock || !args.nosanaConfigured ? args.all : args.deployable;
}

export type TrainingWebhookEvent =
  | "training.started"
  | "training.completed"
  | "training.failed"
  | "training.cancelled";

export interface TrainingLog {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface TrainingDeps {
  prisma: TrainingPrisma;
  getNosana(): Promise<TrainingNosanaPort>;
  getRuntime(): Promise<TrainingRuntime>;
  getStore(): ObjectStore | null;
  issueTransferUrl(args: IssueTransferUrlArgs): Promise<TransferUrl>;
  /** deriveTrainingCallbackSecret, bound to the server secret. */
  callbackSecret(jobId: string, submitNonce: string): string;
  recordOrphan(args: RecordNosanaOrphanArgs): Promise<boolean>;
  /** Fire-and-forget organization webhook; must never throw. */
  emit(orgId: string, event: TrainingWebhookEvent, data: Record<string, unknown>, jobId: string): void;
  /** Runs a task after the caller has answered (production: not awaited, errors logged). */
  defer(task: () => Promise<unknown>): void;
  now(): Date;
  newId(): string;
  /** 8-32 characters of [a-z0-9]: part of the deployment name. */
  newNonce(): string;
  log: TrainingLog;
}

export interface TrainingRefusal {
  ok: false;
  status: number;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

function refuse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): TrainingRefusal {
  return { ok: false, status, code, message, ...(extra ? { extra } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/** A short, safe description of an error: its code and the start of its message. */
function describeError(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return `${code ? `${code}: ` : ""}${message}`.slice(0, 300);
}

// ============================================
// Object keys
// ============================================

/** Where a job's adapter archive and metrics.json are stored. */
export function trainingArtifactKeys(orgId: string, jobId: string): {
  prefix: string;
  adapterKey: string;
  metricsKey: string;
} {
  if (!UUID_PATTERN.test(orgId) || !UUID_PATTERN.test(jobId)) {
    throw new RangeError("trainingArtifactKeys: ids must be UUIDs");
  }
  const prefix = `adapters/${orgId}/${jobId}/`;
  return { prefix, adapterKey: `${prefix}adapter.tar.gz`, metricsKey: `${prefix}metrics.json` };
}

/** The slug of the fine-tuned model a job produces: strict, and unique per job. */
export function fineTunedModelSlug(name: string, jobId: string, long = false): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  const suffix = long ? jobId.replace(/-/g, "") : jobId.slice(0, 8);
  return `${base.length > 0 ? base : "model"}-${suffix}`;
}

// ============================================
// Job metrics (TrainingJob.metrics)
// ============================================

/** What this service keeps in TrainingJob.metrics. */
export interface TrainingJobMetrics {
  started?: { gpu: string | null; vramGb: number | null; device: string; trainerVersion: string };
  phase?: string;
  step?: { epoch: number; lr: number; tokensPerSecond: number | null; etaSeconds: number };
  /** [step, loss] pairs, thinned to at most MAX_LOSS_POINTS. */
  trainLoss?: Array<[number, number]>;
  evalLoss?: Array<[number, number]>;
  /** The trainer's `uploaded` event: what finalisation checks storage against. */
  uploaded?: { adapterBytes: number; adapterSha256: string };
  /** Where the stored log text came from. */
  logSource?: "callbacks" | "nosana_result";
  /** A summary of metrics.json, once the job is finalised. */
  result?: Record<string, unknown>;
}

const MAX_LOSS_POINTS = 500;

function readJobMetrics(value: unknown): TrainingJobMetrics {
  return isRecord(value) ? ({ ...value } as TrainingJobMetrics) : {};
}

function pushPoint(
  series: Array<[number, number]> | undefined,
  point: [number, number],
): Array<[number, number]> {
  let next = Array.isArray(series) ? [...series, point] : [point];
  // Halve the series when it is full: old points thin out, recent ones stay.
  if (next.length > MAX_LOSS_POINTS) next = next.filter((_, index) => index % 2 === 1);
  return next;
}

/**
 * What one trainer event changes on the row: columns in `data`, and the
 * metrics object after it. Pure. A terminal event is stored as the trainer's
 * REPORT (reportedOutcome); it never touches status.
 */
export function reduceTrainerEvent(
  metrics: TrainingJobMetrics,
  event: TrainerEvent,
): { data: Data; metrics: TrainingJobMetrics } {
  const next: TrainingJobMetrics = { ...metrics };
  const data: Data = {};
  switch (event.type) {
    case "started":
      next.started = {
        gpu: event.gpu,
        vramGb: event.vramGb,
        device: event.device,
        trainerVersion: event.trainerVersion,
      };
      break;
    case "phase":
      next.phase = event.phase;
      break;
    case "step":
      data.currentStep = event.step;
      data.totalSteps = event.totalSteps;
      data.currentEpoch = Math.max(0, Math.floor(event.epoch));
      data.trainingLoss = event.loss;
      // 100 is written only by the terminal transition.
      data.progress =
        event.totalSteps > 0
          ? Math.max(0, Math.min(99, Math.floor((event.step / event.totalSteps) * 100)))
          : 0;
      next.step = {
        epoch: event.epoch,
        lr: event.lr,
        tokensPerSecond: event.tokensPerSecond,
        etaSeconds: event.etaSeconds,
      };
      next.trainLoss = pushPoint(next.trainLoss, [event.step, event.loss]);
      break;
    case "eval":
      data.evalLoss = event.evalLoss;
      next.evalLoss = pushPoint(next.evalLoss, [event.step, event.evalLoss]);
      break;
    case "uploaded":
      next.uploaded = { adapterBytes: event.adapterBytes, adapterSha256: event.adapterSha256 };
      break;
    case "completed":
      data.currentStep = event.steps;
      data.totalSteps = event.totalSteps;
      if (event.finalTrainLoss !== null) data.trainingLoss = event.finalTrainLoss;
      if (event.finalEvalLoss !== null) data.evalLoss = event.finalEvalLoss;
      data.reportedOutcome = event;
      break;
    case "failed":
      data.reportedOutcome = event;
      break;
  }
  return { data, metrics: next };
}

function appendLog(existing: string | null, addition: string): string {
  const joined = `${existing ?? ""}${addition}`;
  return joined.length > TRAINING_LOG_MAX_CHARS ? joined.slice(-TRAINING_LOG_MAX_CHARS) : joined;
}

/** The trainer's terminal event stored on the row, re-checked. */
function reportedTerminalEvent(row: Pick<TrainingJobRow, "reportedOutcome">): TrainerTerminalEvent | null {
  if (!isRecord(row.reportedOutcome)) return null;
  const parsed = parseTrainerEvent(row.reportedOutcome);
  return parsed.ok && isTerminalTrainerEvent(parsed.event) ? parsed.event : null;
}

// ============================================
// The Nosana job result
// ============================================

/** A container runtime's timestamp in front of a line (docker --timestamps). */
const LOG_TIMESTAMP_PREFIX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}) /;
const MAX_RESULT_LOG_CHARS = 4 * 1024 * 1024;

/**
 * The exit code and the log text out of a deployment job's result
 * (JobResults.opStates of the Nosana API), read defensively: the shape is
 * known from the SDK's types, not from a run. A line that carries a
 * timestamp in front of an event line is given back without it, because an
 * event line must BEGIN with its prefix to count.
 */
export function readTrainerJobResult(jobResult: unknown): {
  exitCode: number | null;
  logText: string | null;
} {
  const ops = isRecord(jobResult) && Array.isArray(jobResult.opStates) ? jobResult.opStates : [];
  const op =
    ops.find((entry) => isRecord(entry) && entry.operationId === "train") ??
    (ops.length === 1 ? ops[0] : undefined);
  if (!isRecord(op)) return { exitCode: null, logText: null };

  const exitCode =
    typeof op.exitCode === "number" && Number.isInteger(op.exitCode) ? op.exitCode : null;

  let text = "";
  for (const entry of Array.isArray(op.logs) ? op.logs : []) {
    if (!isRecord(entry) || typeof entry.log !== "string") continue;
    if (entry.type !== "stdout" && entry.type !== "stderr") continue;
    text += entry.log.endsWith("\n") ? entry.log : `${entry.log}\n`;
    if (text.length > MAX_RESULT_LOG_CHARS) {
      text = text.slice(-MAX_RESULT_LOG_CHARS);
    }
  }
  if (text === "") return { exitCode, logText: null };

  const lines = text.split("\n").map((line) => {
    const match = LOG_TIMESTAMP_PREFIX.exec(line);
    return match && line.slice(match[0].length).startsWith(TRAINER_EVENT_PREFIX)
      ? line.slice(match[0].length)
      : line;
  });
  return { exitCode, logText: lines.join("\n") };
}

interface NosanaView {
  deploymentState: TrainingDeploymentState;
  jobAddress: string | null;
  job: DeploymentJobSnapshot | null;
  exitCode: number | null;
  logText: string | null;
}

/** null = Nosana could not be read; nothing may be concluded from that. */
async function readNosana(deps: TrainingDeps, row: TrainingJobRow): Promise<NosanaView | null> {
  if (!row.nosanaJobId || isMockNosanaId(row.nosanaJobId)) return null;
  const mode = rowAccessMode(row.nosanaAccessMode);
  try {
    const nosana = await deps.getNosana();
    // Its jobs come newest first: with no address stored yet, the newest job
    // is the run's (a SIMPLE deployment lists one).
    const snapshot = await nosana.getDeploymentStatus(row.nosanaJobId, mode, { jobs: true, events: false });
    const deploymentState: TrainingDeploymentState =
      snapshot.status === "error"
        ? "error"
        : snapshot.status === "insufficient_funds"
          ? "insufficient_funds"
          : snapshot.status === "stopping" ||
              snapshot.status === "stopped" ||
              snapshot.status === "archived"
            ? "ended"
            : "running";
    const jobAddress = row.nosanaJobAddress ?? snapshot.jobs[0]?.job ?? null;
    let job: DeploymentJobSnapshot | null = null;
    if (jobAddress) {
      try {
        job = await nosana.getDeploymentJob(row.nosanaJobId, jobAddress, mode);
      } catch (err) {
        deps.log.warn({ jobId: row.id, error: describeError(err) }, "Training job's Nosana job could not be read");
      }
    }
    const result = job ? readTrainerJobResult(job.jobResult) : { exitCode: null, logText: null };
    return { deploymentState, jobAddress, job, ...result };
  } catch (err) {
    deps.log.warn({ jobId: row.id, error: describeError(err) }, "Training job's Nosana deployment could not be read");
    return null;
  }
}

/** A Nosana time, used only when it is plausible: its unit is not documented. */
function plausibleTime(value: Date | null | undefined, notBefore: Date, now: Date): Date | null {
  if (!value) return null;
  const ms = value.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < notBefore.getTime() - TRAINING_CLOCK_SKEW_MS) return null;
  if (ms > now.getTime() + TRAINING_CLOCK_SKEW_MS) return null;
  return value;
}

// ============================================
// Capabilities
// ============================================

export interface TrainingBlocker {
  code: string;
  message: string;
}

/**
 * What a customer reads while something the platform runs keeps fine-tuning
 * from starting. One calm sentence for every platform-side blocker: which
 * setting is missing is the operator's business, and is said to the operator
 * (trainingOperatorBlockers, the start-up log and GET /api/platform/compute).
 */
export const TRAINING_UNAVAILABLE_MESSAGE = "Fine-tuning is temporarily unavailable. Try again later.";

/** The same, as the answer to a job that was refused before anything was written. */
export const TRAINING_UNAVAILABLE_REFUSAL =
  "Fine-tuning is temporarily unavailable. Nothing was created and no credits were held. Try again later.";

/** A platform-side blocker as the operator reads it: its code and what to set. */
export interface TrainingOperatorBlocker {
  code: string;
  message: string;
}

/**
 * Why no job can start on this deployment, in operator language. The codes
 * are the ones customers receive; the sentences are for the operator only.
 * `storageReason` is the storage config's own reason when it has one.
 */
export function trainingOperatorBlockers(
  runtime: TrainingRuntime,
  store: ObjectStore | null,
  storageReason?: string | null,
): TrainingOperatorBlocker[] {
  const blockers: TrainingOperatorBlocker[] = [];
  if (!store) {
    blockers.push({
      code: "dataset_storage_not_configured",
      message: `Object storage for datasets and adapters is not configured${storageReason ? ` (${storageReason})` : ""}. Set STORAGE_DRIVER, or AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and DATASETS_BUCKET.`,
    });
  }
  if (!runtime.image.configured) {
    blockers.push({
      code: "training_image_not_configured",
      message: `The training image is not configured (${runtime.image.reason}).`,
    });
  }
  if (runtime.nosanaMock) {
    blockers.push({
      code: "training_requires_real_nosana",
      message: "The API runs with the development Nosana mock (ALLOW_NOSANA_MOCK), which cannot train a model.",
    });
  } else if (!runtime.nosanaConfigured) {
    blockers.push({
      code: "nosana_not_configured",
      message: "No Nosana account is configured: set NOSANA_API_KEY or NOSANA_WALLET_PRIVATE_KEY.",
    });
  } else if (Object.keys(runtime.tiers).length === 0) {
    blockers.push({
      code: "gpu_market_not_configured",
      message: "No GPU tier has a market on the configured Nosana network (see NOSANA_MARKETS_JSON).",
    });
  }
  if (!runtime.publicApiUrl) {
    blockers.push({
      code: "training_callbacks_not_configured",
      message: "PUBLIC_API_URL is not set, so a training run has no address to report to.",
    });
  }
  if (runtime.pollIntervalMs <= 0) {
    blockers.push({
      code: "training_poller_disabled",
      message: "The training poller is switched off (TRAINING_POLL_INTERVAL_MS is 0), so nothing would follow a run.",
    });
  }
  if (!runtime.orphanSweepEnabled) {
    blockers.push({
      code: "training_orphan_sweep_disabled",
      message:
        "The deployment status worker is switched off (DEPLOYMENT_STATUS_INTERVAL_MS is 0), so a GPU job whose stop did not land would run on unwatched.",
    });
  }
  const bounds = trainingRunLimitBounds(runtime, runtime.batchJobTimeoutSeconds);
  if (bounds.maxSeconds < bounds.minSeconds) {
    blockers.push({
      code: "training_run_limit_unavailable",
      message:
        "NOSANA_BATCH_JOB_TIMEOUT_SECONDS minus the setup allowance (TRAINING_SETUP_ALLOWANCE_SECONDS) leaves no room for the shortest training run.",
    });
  }
  return blockers;
}

/**
 * Why a job cannot start, as a customer reads it: each platform-side blocker
 * keeps its code and carries the one shared sentence.
 */
export function trainingBlockers(runtime: TrainingRuntime, store: ObjectStore | null): TrainingBlocker[] {
  return trainingOperatorBlockers(runtime, store).map((blocker) => ({
    code: blocker.code,
    message: TRAINING_UNAVAILABLE_MESSAGE,
  }));
}

/**
 * What a page needs to know before it offers to start a job. With `orgId`,
 * the organization's own blocker is added: the limit of free failures (R4).
 */
export async function describeTrainingCapabilities(deps: TrainingDeps, args: { orgId?: string } = {}) {
  const runtime = await deps.getRuntime();
  const store = deps.getStore();
  const blockers = trainingBlockers(runtime, store);
  if (args.orgId) {
    const limit = await freeFailureLimit(deps.prisma, args.orgId, runtime, deps.now());
    if (limit) blockers.push({ code: limit.code, message: limit.message });
  }
  const bounds = trainingRunLimitBounds(runtime, runtime.batchJobTimeoutSeconds);
  return {
    canStart: blockers.length === 0,
    blockers,
    storage: {
      configured: store !== null,
      driver: store?.kind ?? null,
      maxDatasetBytes: runtime.datasetMaxBytes,
      maxDatasetRows: runtime.datasetMaxRows,
    },
    image: { configured: runtime.image.configured },
    nosana: {
      configured: runtime.nosanaConfigured && !runtime.nosanaMock,
      mock: runtime.nosanaMock,
      tiers: Object.entries(runtime.allTiers).map(([tier, info]) => ({
        tier,
        name: info.name,
        vramGb: info.vram,
        pricePerSecondUsd: info.pricePerSecond,
        deployable: !runtime.nosanaMock && Object.hasOwn(runtime.tiers, tier),
      })),
    },
    callbacks: { configured: runtime.publicApiUrl !== null },
    poller: { enabled: runtime.pollIntervalMs > 0 },
    gatedModels: { available: runtime.hfToken !== undefined },
    runLimit: {
      minSeconds: bounds.minSeconds,
      maxSeconds: bounds.maxSeconds,
      setupAllowanceSeconds: runtime.setupAllowanceSeconds,
      queueTimeoutSeconds: runtime.queueTimeoutSeconds,
    },
    limits: {
      maxActiveJobs: runtime.maxActiveJobsPerOrg,
      freeFailuresPerDay: runtime.freeFailuresPerDay,
      adapterMaxBytes: runtime.adapterMaxBytes,
    },
    methods: [...TRAINING_METHODS],
    hyperparameters: {
      bounds: TRAINING_HYPERPARAM_BOUNDS,
      defaults: TRAINING_HYPERPARAM_DEFAULTS,
      loraRanks: [...TRAINING_LORA_RANKS],
    },
  };
}

/** The trainable catalog as a page shows it, with why a model is unavailable. */
export async function listTrainingModels(deps: TrainingDeps) {
  const runtime = await deps.getRuntime();
  const options = listTrainableModels({
    tiers: runtime.tiers,
    hfTokenConfigured: runtime.hfToken !== undefined,
  });
  const rows = await deps.prisma.model.findMany({
    where: { id: { in: options.map((option) => option.modelId) } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const reasons: Record<string, string> = {
    hf_token_required: "This model is not available for fine-tuning right now.",
    no_tier_available: "No GPU with enough memory for this model is available right now.",
    model_not_in_catalog: "This model is not available for fine-tuning right now.",
  };
  return options.map((option) => {
    const row = byId.get(option.modelId);
    const unavailableReason =
      !row || !row.isActive ? "model_not_in_catalog" : option.unavailableReason;
    return {
      id: option.modelId,
      hfId: option.hfId,
      displayName: row?.displayName ?? option.modelId,
      parameters: row?.parameters != null ? Number(row.parameters) : null,
      gated: option.gated,
      available: unavailableReason === null,
      unavailableReason,
      unavailableMessage: unavailableReason ? reasons[unavailableReason] : null,
      methods: option.methods,
      supportedMethods: option.methods.map((entry) => entry.method),
      recommendedGpuTier:
        option.methods.map((entry) => entry.recommendedTier).find((tier) => tier !== null) ?? null,
      figuresBasis: "planning" as const,
    };
  });
}

// ============================================
// Free failures (R4)
// ============================================

/** The rolling window of the free-failure limit. */
export const TRAINING_FREE_FAILURE_WINDOW_MS = 24 * 3_600_000;

/**
 * The jobs of an organization that ended as failures charged nothing since
 * `since`: failed, or cancelled after a failure had already happened (the
 * row then keeps its failureCode), settled with a charge of 0. Rows from
 * before fine-tuning was billed (no hold) are the platform's clean-up, not
 * the user's runs, and do not count.
 */
function freeFailureWhere(orgId: string, since: Date): Where {
  return {
    orgId,
    status: { in: ["failed", "cancelled"] },
    failureCode: { not: null },
    reservationCents: { not: null },
    actualCostCents: 0n,
    settledAt: { gte: since },
  };
}

/** "2026-10-13 09:41 UTC": a time a user reads, the same in every time zone. */
function utcMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The refusal of an organization that has had its free failures for the
 * day, or null. `retryAt` is when the oldest of the most recent ones leaves
 * the window, which is when the next job can start.
 */
async function freeFailureLimit(
  prisma: TrainingPrisma,
  orgId: string,
  runtime: Pick<TrainingRuntime, "freeFailuresPerDay">,
  now: Date,
): Promise<TrainingRefusal | null> {
  const limit = runtime.freeFailuresPerDay;
  const rows = await prisma.trainingJob.findMany({
    where: freeFailureWhere(orgId, new Date(now.getTime() - TRAINING_FREE_FAILURE_WINDOW_MS)),
    select: Object.fromEntries(TRAINING_JOB_LIST_COLUMNS.map((column) => [column, true])) as Record<
      TrainingJobListColumn,
      true
    >,
    orderBy: { settledAt: "desc" },
    take: limit,
  });
  if (rows.length < limit) return null;
  const oldest = rows[rows.length - 1]!.settledAt ?? now;
  return freeFailureRefusal(limit, new Date(oldest.getTime() + TRAINING_FREE_FAILURE_WINDOW_MS));
}

function freeFailureRefusal(limit: number, retryAt: Date | null): TrainingRefusal {
  return refuse(
    409,
    "training_free_failure_limit",
    `Fine-tuning cannot start for your organization ${retryAt ? `until ${utcMinute(retryAt)}` : "for now"}: ${limit} of its training runs ended in failures that were not charged in the last 24 hours, the most allowed. Check the reason each one failed before starting another.`,
    { limit, ...(retryAt ? { retryAt: retryAt.toISOString() } : {}) },
  );
}

// ============================================
// Planning a job (shared by the estimate and by create)
// ============================================

export interface TrainingJobInput {
  name?: string;
  baseModelId: string;
  datasetId: string;
  method: string;
  gpuTier: string;
  gpuCount?: number;
  /** The run limit the user chose. Omitted = the estimate's suggestion. */
  maxRuntimeSeconds?: number;
  hyperparams?: unknown;
}

interface TrainingPlan {
  dataset: DatasetRecord;
  model: TrainableModel;
  method: TrainingMethod;
  tier: string;
  requiredVramGb: number;
  pricePerSecondUsd: number;
  hyperparams: TrainingHyperparams;
  estimate: TrainingEstimate | null;
  /** The run limit the job gets: the user's, else the suggestion; null when neither exists. */
  maxRuntimeSeconds: number | null;
  rows: number;
}

/**
 * Steps 1 to 6 of the refusal order (D8): validation, 404s, the dataset's
 * state, then the model, method and tier. Nothing is written.
 */
async function planTrainingJob(
  deps: TrainingDeps,
  runtime: TrainingRuntime,
  orgId: string,
  input: TrainingJobInput,
): Promise<{ ok: true; plan: TrainingPlan } | TrainingRefusal> {
  // 1. Validation.
  const checked = validateTrainingHyperparams(input.hyperparams);
  if (!checked.ok) {
    return refuse(400, checked.code, checked.message, { field: checked.field });
  }
  const bounds = trainingRunLimitBounds(runtime, runtime.batchJobTimeoutSeconds);
  if (input.maxRuntimeSeconds !== undefined) {
    const limit = input.maxRuntimeSeconds;
    if (!Number.isSafeInteger(limit) || limit < bounds.minSeconds || limit > bounds.maxSeconds) {
      return refuse(
        400,
        "run_limit_out_of_range",
        bounds.maxSeconds < bounds.minSeconds
          ? TRAINING_UNAVAILABLE_REFUSAL
          : `The run limit must be between ${bounds.minSeconds} and ${bounds.maxSeconds} seconds.`,
        { minSeconds: bounds.minSeconds, maxSeconds: bounds.maxSeconds },
      );
    }
  }

  // 2. The dataset and the model exist.
  const dataset = await deps.prisma.dataset.findFirst({
    where: { id: input.datasetId, orgId, deletedAt: null },
  });
  if (!dataset) return refuse(404, "dataset_not_found", "Dataset not found");
  const modelRow = await deps.prisma.model.findUnique({ where: { id: input.baseModelId } });
  if (!modelRow || !modelRow.isActive) {
    return refuse(404, "model_not_found", `Model '${input.baseModelId.slice(0, 80)}' not found`);
  }
  if (!findTrainableModel(input.baseModelId)) {
    return refuse(404, "model_not_trainable", `Model '${modelRow.id}' cannot be fine-tuned`);
  }

  // 3. Validated, with a content hash to pin the run to.
  if (!dataset.isValidated || !dataset.contentSha256) {
    return refuse(
      409,
      "dataset_not_validated",
      "Validate the dataset before training: the run is pinned to the bytes validation read.",
    );
  }
  // 4. A known row count: the estimate and the run limit are worked out from it.
  const rows = knownDatasetRowCount(dataset);
  if (rows === null) {
    const refusal = rowCountUnknownRefusal();
    return refuse(refusal.status, refusal.body.error, refusal.body.message);
  }
  // 5. The stored object is still the one validation read (D7). Without a
  // store this cannot be asked; create refuses that further down.
  const store = deps.getStore();
  if (store) {
    let state: Awaited<ReturnType<typeof datasetObjectState>>;
    try {
      state = await datasetObjectState(store, dataset);
    } catch (err) {
      deps.log.warn({ datasetId: dataset.id, error: describeError(err) }, "Dataset object could not be checked");
      return refuse(503, "dataset_storage_unavailable", "The dataset could not be checked in storage. Try again.");
    }
    if (state !== "unchanged") {
      return refuse(
        409,
        "dataset_changed_since_validation",
        "The stored dataset is not the file that was validated. Validate it again before training.",
      );
    }
  }

  // 6. Model, method, GPU count and tier.
  const selection = selectTraining({
    modelId: input.baseModelId,
    method: input.method,
    tier: input.gpuTier,
    gpuCount: input.gpuCount,
    hfTokenConfigured: runtime.hfToken !== undefined,
    tiers: runtime.tiers,
  });
  if (!selection.ok) {
    return refuse(
      selection.code === "model_not_trainable" ? 404 : 400,
      selection.code,
      selection.message,
      selection.code === "tier_too_small" ? { requiredVramGb: selection.requiredVramGb } : undefined,
    );
  }

  let estimate: TrainingEstimate | null = null;
  if (dataset.avgTokensPerRow !== null && dataset.avgTokensPerRow > 0) {
    const estimated = estimateTraining({
      model: selection.model,
      method: selection.method,
      tierVramGb: runtime.tiers[selection.tier]!.vram,
      pricePerSecondUsd: selection.pricePerSecondUsd,
      rows,
      avgTokensPerRow: dataset.avgTokensPerRow,
      hyperparams: checked.hyperparams,
      runLimit: bounds,
      ...(input.maxRuntimeSeconds !== undefined ? { maxRuntimeSeconds: input.maxRuntimeSeconds } : {}),
    });
    if (!estimated.ok) return refuse(400, estimated.code, estimated.message);
    estimate = estimated.estimate;
  }

  return {
    ok: true,
    plan: {
      dataset,
      model: selection.model,
      method: selection.method,
      tier: selection.tier,
      requiredVramGb: selection.requiredVramGb,
      pricePerSecondUsd: selection.pricePerSecondUsd,
      hyperparams: checked.hyperparams,
      estimate,
      maxRuntimeSeconds: input.maxRuntimeSeconds ?? estimate?.runLimit.appliedSeconds ?? null,
      rows,
    },
  };
}

/** The estimate as JSON: bigint cents become numbers. */
export function serializeTrainingEstimate(estimate: TrainingEstimate) {
  const part = (value: { seconds: number; cents: bigint }) => ({
    seconds: value.seconds,
    cents: Number(value.cents),
  });
  return {
    basis: estimate.basis,
    trainTokens: estimate.trainTokens,
    steps: estimate.steps,
    seconds: estimate.seconds,
    estimate: part(estimate.estimate),
    low: part(estimate.low),
    high: part(estimate.high),
    pricePerSecondUsd: estimate.pricePerSecondUsd,
    runLimit: estimate.runLimit,
    maximumCents: Number(estimate.maximumCents),
    fitsRunLimit: estimate.fitsRunLimit,
    suggestionCapped: estimate.suggestionCapped,
  };
}

export type EstimateTrainingJobResult =
  | {
      ok: true;
      /** null when the dataset has no measured tokens per row and a run limit was given. */
      estimate: ReturnType<typeof serializeTrainingEstimate> | null;
      /** What creating this job would hold: price per second x the run limit. */
      hold: { cents: number; maxRuntimeSeconds: number; pricePerSecondUsd: number };
      dataset: { id: string; rowCount: number; avgTokensPerRow: number | null };
      gpuTier: string;
    }
  | TrainingRefusal;

/**
 * The planning estimate of a job, and what creating it would hold. A dataset
 * with no measured tokens per row (a Parquet file) has no estimate; with a
 * run limit given it is still answered, with `estimate: null` and the hold,
 * because the job can be created exactly so. Without one, 422 says to choose
 * a run limit.
 */
export async function estimateTrainingJob(
  deps: TrainingDeps,
  args: { orgId: string; input: TrainingJobInput },
): Promise<EstimateTrainingJobResult> {
  const runtime = await deps.getRuntime();
  const planned = await planTrainingJob(deps, runtime, args.orgId, args.input);
  if (!planned.ok) return planned;
  const { plan } = planned;
  if (plan.maxRuntimeSeconds === null) {
    return refuse(
      422,
      "training_estimate_unavailable",
      "This dataset has no measured tokens per row, so its training time cannot be estimated and no run limit can be suggested. Choose a run limit: the job holds the price per second for that long and is charged for the seconds it runs.",
    );
  }
  const holdCents = trainingHoldCents(
    trainingPriceMicroUsdPerSecond(plan.pricePerSecondUsd),
    plan.maxRuntimeSeconds,
  );
  return {
    ok: true,
    estimate: plan.estimate ? serializeTrainingEstimate(plan.estimate) : null,
    hold: {
      cents: Number(holdCents),
      maxRuntimeSeconds: plan.maxRuntimeSeconds,
      pricePerSecondUsd: plan.pricePerSecondUsd,
    },
    dataset: { id: plan.dataset.id, rowCount: plan.rows, avgTokensPerRow: plan.dataset.avgTokensPerRow },
    gpuTier: plan.tier,
  };
}

// ============================================
// Create
// ============================================

export type CreateTrainingJobResult =
  | {
      ok: true;
      job: TrainingJobRow;
      reservation: { cents: number; maxRuntimeSeconds: number; pricePerSecondUsd: number };
      estimate: ReturnType<typeof serializeTrainingEstimate> | null;
    }
  | TrainingRefusal;

/** Carries a refusal out of the create transaction, rolling it back. */
class CreateAborted extends Error {
  constructor(readonly refusal: TrainingRefusal) {
    super(refusal.code);
  }
}

/** The answer for a Nosana pre-flight that threw. Never rethrows: fail closed. */
function preflightRefusal(error: unknown): TrainingRefusal {
  const code = errorCode(error);
  if (code === "nosana_not_configured") {
    return refuse(501, code, TRAINING_UNAVAILABLE_REFUSAL);
  }
  if (code === "unknown_tier") {
    return refuse(400, "unknown_gpu_tier", "This GPU tier is not available.");
  }
  if (code === "market_not_configured") {
    return refuse(501, "gpu_market_not_configured", "This GPU tier is not available right now. Choose another tier.");
  }
  const refusal = computeRefusal(error);
  if (refusal) {
    return refuse(refusal.status, refusal.body.error, refusal.body.message, { reason: refusal.body.reason });
  }
  return refuse(503, "nosana_unavailable", "The GPU network could not be reached to admit this job. Nothing was reserved.");
}

/**
 * Admits a training job: the refusal order of D8, every step before any row
 * or credit moves, then ONE transaction that creates the row and takes the
 * hold. On success training.started is emitted and the submit is deferred.
 */
export async function createTrainingJob(
  deps: TrainingDeps,
  args: { orgId: string; input: TrainingJobInput & { name: string } },
): Promise<CreateTrainingJobResult> {
  const { orgId, input } = args;
  const runtime = await deps.getRuntime();

  // 1-6: validation, 404s, dataset state, model/method/tier.
  const planned = await planTrainingJob(deps, runtime, orgId, input);
  if (!planned.ok) return planned;
  const { plan } = planned;
  if (plan.maxRuntimeSeconds === null) {
    return refuse(
      400,
      "run_limit_required",
      "Choose a run limit: this dataset's training time cannot be estimated, so none can be suggested.",
    );
  }
  const maxRuntimeSeconds = plan.maxRuntimeSeconds;

  // 7. Storage.
  if (!deps.getStore()) {
    return refuse(503, "dataset_storage_not_configured", TRAINING_UNAVAILABLE_REFUSAL);
  }
  // 8. The image.
  if (!runtime.image.configured) {
    return refuse(501, "training_image_not_configured", TRAINING_UNAVAILABLE_REFUSAL);
  }
  // 9. Nosana. The development mock never runs anything, so it is refused by name.
  if (runtime.nosanaMock) {
    return refuse(501, "training_requires_real_nosana", TRAINING_UNAVAILABLE_REFUSAL);
  }
  const nosanaTimeoutSeconds = trainingNosanaTimeoutSeconds(runtime, maxRuntimeSeconds);
  try {
    await runDeployPreflight(await deps.getNosana(), plan.tier, 1, "batch", {
      timeoutSeconds: nosanaTimeoutSeconds,
    });
  } catch (err) {
    return preflightRefusal(err);
  }
  // 10. Callbacks.
  if (!runtime.publicApiUrl) {
    return refuse(503, "training_callbacks_not_configured", TRAINING_UNAVAILABLE_REFUSAL);
  }
  // 11. The poller: with it off nothing would ever end a job.
  if (runtime.pollIntervalMs <= 0) {
    return refuse(503, "training_poller_disabled", TRAINING_UNAVAILABLE_REFUSAL);
  }
  // 12. The orphan sweep: a job whose stop did not land hands its deployment
  // to it, and settles. With it off that GPU would run on, unwatched (R5).
  if (!runtime.orphanSweepEnabled) {
    return refuse(503, "training_orphan_sweep_disabled", TRAINING_UNAVAILABLE_REFUSAL);
  }
  // 13. Quota, then 14. free failures (both checked again inside the
  // transaction, under the organization's lock).
  const quotaRefusal = (active: number) =>
    refuse(
      409,
      "training_quota_exceeded",
      `Your organization already has ${active} training job${active === 1 ? "" : "s"} in progress (limit ${runtime.maxActiveJobsPerOrg}).`,
      { activeJobs: active, limit: runtime.maxActiveJobsPerOrg },
    );
  const activeNow = await deps.prisma.trainingJob.count({
    where: { orgId, status: { in: [...ACTIVE_TRAINING_STATES] } },
  });
  if (activeNow >= runtime.maxActiveJobsPerOrg) return quotaRefusal(activeNow);
  const freeLimit = await freeFailureLimit(deps.prisma, orgId, runtime, deps.now());
  if (freeLimit) return freeLimit;

  // 15. Credits: the hold, taken with the row.
  const priceMicroUsdPerSecond = trainingPriceMicroUsdPerSecond(plan.pricePerSecondUsd);
  const holdCents = trainingHoldCents(priceMicroUsdPerSecond, maxRuntimeSeconds);
  const jobId = deps.newId();
  const resolved = resolveTrainingHyperparams(plan.hyperparams);

  let job: TrainingJobRow;
  try {
    job = await deps.prisma.$transaction(async (tx) => {
      // First, the organization's credit balance row: an UPDATE takes its row
      // lock until this transaction ends, so a second create of the same
      // organization waits here, and under READ COMMITTED its counts below
      // then see every job committed before it. Without this two creates
      // could each count the other's job as not there yet (R3).
      const locked = await tx.creditBalance.updateMany({
        where: { orgId },
        data: { balanceCents: { increment: 0n } },
      });
      const live = await tx.dataset.findFirst({
        where: { id: plan.dataset.id, orgId, deletedAt: null },
      });
      if (!live) throw new CreateAborted(refuse(404, "dataset_not_found", "Dataset not found"));
      const active = await tx.trainingJob.count({
        where: { orgId, status: { in: [...ACTIVE_TRAINING_STATES] } },
      });
      if (active >= runtime.maxActiveJobsPerOrg) throw new CreateAborted(quotaRefusal(active));
      const freeFailures = await tx.trainingJob.count({
        where: freeFailureWhere(orgId, new Date(deps.now().getTime() - TRAINING_FREE_FAILURE_WINDOW_MS)),
      });
      if (freeFailures >= runtime.freeFailuresPerDay) {
        throw new CreateAborted(freeFailureRefusal(runtime.freeFailuresPerDay, null));
      }
      if (locked.count === 0) {
        // No balance row: nothing to hold from, and nothing to lock on.
        throw new CreateAborted(
          refuse(402, "insufficient_credits", "Not enough credits to hold the cost of the full run limit", {
            requiredCents: Number(holdCents),
          }),
        );
      }

      const row = await tx.trainingJob.create({
        data: {
          id: jobId,
          orgId,
          name: input.name,
          baseModelId: plan.model.modelId,
          baseModelHfId: plan.model.hfId,
          datasetId: plan.dataset.id,
          method: plan.method,
          config: { hyperparams: plan.hyperparams, maxRuntimeSeconds },
          hyperparams: plan.hyperparams,
          datasetSha256: plan.dataset.contentSha256,
          gpuTier: plan.tier,
          gpuCount: 1,
          status: "pending",
          progress: 0,
          totalEpochs: resolved.epochs,
          maxRuntimeSeconds,
          nosanaTimeoutSeconds,
          reservationCents: holdCents,
          priceMicroUsdPerSecond,
          estimatedCostCents: plan.estimate ? plan.estimate.estimate.cents : null,
        },
      });
      const reserved = await reserveTrainingCredits({
        tx: tx as never,
        orgId,
        jobId,
        holdCents,
        gpuTier: plan.tier,
        maxRuntimeSeconds,
      });
      if (!reserved.ok) {
        throw new CreateAborted(
          refuse(402, reserved.code, reserved.message, { requiredCents: Number(reserved.requiredCents) }),
        );
      }
      return row;
    });
  } catch (err) {
    if (!(err instanceof CreateAborted)) throw err;
    if (err.refusal.code === "training_free_failure_limit") {
      // Rolled back; now say when the next run can start.
      return (await freeFailureLimit(deps.prisma, orgId, runtime, deps.now())) ?? err.refusal;
    }
    if (err.refusal.code === "insufficient_credits") {
      const balance = await deps.prisma.creditBalance.findUnique({ where: { orgId } });
      err.refusal.extra = {
        ...err.refusal.extra,
        balanceCents: Number(balance?.balanceCents ?? 0n),
      };
    }
    return err.refusal;
  }

  deps.log.info(
    { jobId, orgId, baseModel: plan.model.modelId, method: plan.method, tier: plan.tier, maxRuntimeSeconds },
    "Training job admitted",
  );
  deps.emit(
    orgId,
    "training.started",
    { jobId, name: job.name, baseModelId: job.baseModelId, method: job.method, gpuTier: job.gpuTier },
    jobId,
  );
  deps.defer(() => submitTrainingJob(deps, jobId));

  return {
    ok: true,
    job,
    reservation: { cents: Number(holdCents), maxRuntimeSeconds, pricePerSecondUsd: plan.pricePerSecondUsd },
    estimate: plan.estimate ? serializeTrainingEstimate(plan.estimate) : null,
  };
}

/** A new job with the configuration of one that is over. */
export async function retryTrainingJob(
  deps: TrainingDeps,
  args: { orgId: string; jobId: string },
): Promise<CreateTrainingJobResult> {
  const row = await deps.prisma.trainingJob.findFirst({ where: { id: args.jobId, orgId: args.orgId } });
  if (!row) return refuse(404, "training_job_not_found", "Training job not found");
  if (!isTerminalTrainingState(row.status)) {
    return refuse(409, "training_job_not_finished", "Only a job that is over can be retried.", { status: row.status });
  }
  if (!isRecord(row.hyperparams) || row.maxRuntimeSeconds === null) {
    return refuse(
      409,
      "training_job_not_retryable",
      "This job was created before fine-tuning could run and has no configuration to repeat. Start a new job.",
    );
  }
  return createTrainingJob(deps, {
    orgId: args.orgId,
    input: {
      name: row.name,
      baseModelId: row.baseModelId,
      datasetId: row.datasetId,
      method: row.method,
      gpuTier: row.gpuTier,
      maxRuntimeSeconds: row.maxRuntimeSeconds,
      hyperparams: row.hyperparams,
    },
  });
}

// ============================================
// Terminal transitions
// ============================================

async function findJob(deps: TrainingDeps, jobId: string): Promise<TrainingJobRow | null> {
  return deps.prisma.trainingJob.findFirst({ where: { id: jobId } });
}

function nosanaDeps(deps: TrainingDeps, row: Pick<TrainingJobRow, "id">) {
  return {
    stopDeployment: async (id: string, mode?: NosanaAccessMode) =>
      (await deps.getNosana()).stopDeployment(id, mode),
    recordOrphan: deps.recordOrphan,
    onStopError: (err: unknown) =>
      deps.log.warn({ jobId: row.id, error: describeError(err) }, "Stopping a training deployment failed"),
  };
}

/**
 * The terminal compare-and-set with its settlement, in one transaction, and
 * the organization webhook from the writer that won it.
 */
async function settleJob(
  deps: TrainingDeps,
  row: TrainingJobRow,
  args: {
    from: TrainingState[];
    to: TerminalTrainingState;
    charge: { kind: "none" } | { kind: "seconds_run"; billableMs: number };
    fields?: TrainingTerminalFields;
    webhook?: Record<string, unknown>;
  },
): Promise<SettleTrainingJobResult> {
  const result = await deps.prisma.$transaction((tx) =>
    settleTrainingJob({
      tx: tx as never,
      jobId: row.id,
      orgId: row.orgId,
      fromStatuses: args.from,
      toStatus: args.to,
      charge: args.charge,
      fields: args.fields,
      now: deps.now(),
    }),
  );
  if (!result.settled) return result;

  deps.log.info(
    {
      jobId: row.id,
      status: args.to,
      failureCode: args.fields?.failureCode ?? null,
      chargeCents: result.chargeCents.toString(),
      holdCents: result.holdCents.toString(),
      billedSeconds: result.billedSeconds,
    },
    "Training job settled",
  );
  deps.emit(
    row.orgId,
    `training.${args.to}` as TrainingWebhookEvent,
    {
      jobId: row.id,
      name: row.name,
      ...(args.fields?.failureCode ? { failureCode: args.fields.failureCode } : {}),
      ...(args.fields?.lastError ? { message: args.fields.lastError } : {}),
      chargedCents: Number(result.chargeCents),
      billedSeconds: result.billedSeconds,
      ...args.webhook,
    },
    row.id,
  );
  return result;
}

function failureSentence(failureCode: string, trainerMessage?: string | null): string {
  if (trainerMessage) return trainerMessage.slice(0, 500);
  return Object.hasOwn(TRAINING_FAILURE_CODES, failureCode)
    ? TRAINING_FAILURE_CODES[failureCode as keyof typeof TRAINING_FAILURE_CODES]
    : "The training run failed";
}

/**
 * Ends a job as failed. Its deployment, when it has one, is retired first:
 * until that is stopped and released or durably recorded, nothing is settled.
 */
async function failJob(
  deps: TrainingDeps,
  row: TrainingJobRow,
  args: {
    from: TrainingState;
    failureCode: string;
    charge: { kind: "none" } | { kind: "seconds_run"; billableMs: number };
    message?: string | null;
    gpuStoppedAt?: Date;
    orphanReason: string;
  },
): Promise<"failed" | "stop_retry" | "lost"> {
  if (row.nosanaJobId && !isMockNosanaId(row.nosanaJobId)) {
    const retired = await retireTrainingDeployment(
      nosanaDeps(deps, row),
      { id: row.id, nosanaJobId: row.nosanaJobId, nosanaAccessMode: row.nosanaAccessMode },
      args.orphanReason,
    );
    if (!retired.handled) return "stop_retry";
  }
  const settled = await settleJob(deps, row, {
    from: [args.from],
    to: "failed",
    charge: args.charge,
    fields: {
      failureCode: args.failureCode,
      lastError: failureSentence(args.failureCode, args.message),
      ...(args.gpuStoppedAt ? { gpuStoppedAt: args.gpuStoppedAt } : {}),
    },
  });
  return settled.settled ? "failed" : "lost";
}

// ============================================
// Submit
// ============================================

export type SubmitTrainingJobResult =
  | { ok: true; nosanaJobId: string }
  | { ok: false; code: "not_pending" | "submit_failed" | "lost_race" | "left_for_recovery"; message: string };

type LostSubmitOutcome = "none_found" | "retired" | "lookup_failed" | "not_handled";

/**
 * Looks the deterministic deployment name up on Nosana and retires what is
 * found (D6). The name is also the create's idempotency_key, which Nosana
 * keeps unique, so the key is asked first; the name filter covers a
 * deployment created before the key was sent. "lookup_failed" means Nosana's
 * list could not be read, so nothing is known; "not_handled" means a
 * deployment exists and could be neither stopped-and-released nor recorded.
 */
async function retireLostSubmit(deps: TrainingDeps, row: TrainingJobRow): Promise<LostSubmitOutcome> {
  const name = row.submitNonce ? trainingDeploymentName(row.id, row.submitNonce) : null;
  if (!name) return "none_found";
  let found: Awaited<ReturnType<TrainingNosanaPort["findDeploymentByName"]>>;
  try {
    const nosana = await deps.getNosana();
    found = (await nosana.findDeploymentByIdempotencyKey(name)) ?? (await nosana.findDeploymentByName(name));
  } catch (err) {
    // No credential at all: nothing can have been created from here.
    if (errorCode(err) === "nosana_not_configured") return "none_found";
    deps.log.warn({ jobId: row.id, deploymentName: name, error: describeError(err) }, "Could not look a lost training deployment up by name");
    return "lookup_failed";
  }
  if (!found) return "none_found";
  const retired = await retireTrainingDeployment(
    nosanaDeps(deps, row),
    { id: row.id, nosanaJobId: found.id, nosanaAccessMode: found.accessMode },
    "submit_lost",
  );
  return retired.handled ? "retired" : "not_handled";
}

/**
 * Submits a pending job to Nosana. One submitter claims the row
 * (pending -> submitting, with a fresh nonce); the deployment is created
 * under a name made of the job id and that nonce, so a deployment whose id
 * never reached the row can still be found and stopped.
 */
export async function submitTrainingJob(
  deps: TrainingDeps,
  jobId: string,
): Promise<SubmitTrainingJobResult> {
  const submitNonce = deps.newNonce();
  const claimed = await deps.prisma.trainingJob.updateMany({
    where: { id: jobId, status: "pending" },
    data: { status: "submitting", submitNonce, submitStartedAt: deps.now() },
  });
  if (claimed.count === 0) {
    return { ok: false, code: "not_pending", message: "Another writer has this job" };
  }
  const row = await findJob(deps, jobId);
  if (!row) return { ok: false, code: "not_pending", message: "The job is gone" };

  /** Before anything was sent to Nosana: nothing to look up. */
  const failBefore = async (reason: string): Promise<SubmitTrainingJobResult> => {
    deps.log.error({ jobId, reason }, "Training job could not be submitted");
    const settled = await settleJob(deps, row, {
      from: ["submitting"],
      to: "failed",
      charge: { kind: "none" },
      fields: { failureCode: "submit_failed", lastError: failureSentence("submit_failed") },
    });
    // A cancel landed meanwhile: finish it, there is nothing on Nosana.
    if (!settled.settled) await reconcileTrainingJob(deps, jobId, { submitterDone: true });
    return { ok: false, code: "submit_failed", message: reason };
  };

  // A row from before fine-tuning was billed holds no credits: never submitted.
  if (row.reservationCents === null || row.maxRuntimeSeconds === null || !row.datasetSha256) {
    return failBefore("the job has no hold or run limit (created before fine-tuning could run)");
  }

  const runtime = await deps.getRuntime();
  const store = deps.getStore();
  if (!store) return failBefore("object storage is not configured");
  if (!runtime.image.configured) return failBefore("the training image is not configured");
  if (!runtime.publicApiUrl) return failBefore("PUBLIC_API_URL is not set");
  if (runtime.nosanaMock) return failBefore("the Nosana mock is on");

  const dataset = await deps.prisma.dataset.findFirst({
    where: { id: row.datasetId, orgId: row.orgId, deletedAt: null },
  });
  if (!dataset) return failBefore("the dataset is gone");
  // The pin (D7): the bytes admitted are the bytes trained on.
  if (dataset.contentSha256 !== row.datasetSha256) return failBefore("the dataset was validated again with other bytes");
  let datasetState: string;
  try {
    datasetState = await datasetObjectState(store, dataset);
  } catch (err) {
    return failBefore(`the dataset object could not be checked (${describeError(err)})`);
  }
  if (datasetState !== "unchanged") return failBefore(`the dataset object is ${datasetState}`);
  const datasetKey = datasetObjectKey(dataset.storageUrl, store);
  if (!datasetKey) return failBefore("the dataset is not in the configured store");

  const model = findTrainableModel(row.baseModelId);
  const requiredVramGb =
    model && (row.method === "lora" || row.method === "qlora") ? model.minVramGb[row.method] : undefined;
  if (!model || requiredVramGb === undefined) return failBefore("the model or method is no longer offered");
  if (model.gated && !runtime.hfToken) return failBefore("the model needs a Hugging Face token");

  const deploymentName = trainingDeploymentName(jobId, submitNonce);
  if (!deploymentName) return failBefore("the deployment name could not be formed");

  const ttlSeconds = trainingTransferUrlTtlSeconds(runtime, row.maxRuntimeSeconds);
  const keys = trainingArtifactKeys(row.orgId, jobId);
  let definition: Parameters<TrainingNosanaPort["createDeployment"]>[0];
  try {
    const [datasetUrl, adapterUrl, metricsUrl] = await Promise.all([
      deps.issueTransferUrl({ op: "get", key: datasetKey, ttlSeconds }),
      deps.issueTransferUrl({
        op: "put",
        key: keys.adapterKey,
        ttlSeconds,
        maxBytes: runtime.adapterMaxBytes,
        contentType: ADAPTER_CONTENT_TYPE,
      }),
      deps.issueTransferUrl({
        op: "put",
        key: keys.metricsKey,
        ttlSeconds,
        maxBytes: TRAINING_METRICS_MAX_BYTES,
        contentType: METRICS_CONTENT_TYPE,
      }),
    ]);
    const built = buildTrainingJobDefinition({
      image: runtime.image.reference,
      registry: runtime.image.registry,
      requiredVramGb,
      jobId,
      baseModelHfId: model.hfId,
      hfToken: model.gated ? runtime.hfToken : null,
      method: row.method,
      datasetUrl: datasetUrl.url,
      datasetFormat: dataset.schemaFormat && dataset.schemaFormat !== "unknown" ? dataset.schemaFormat : "auto",
      datasetFileType: dataset.fileType,
      datasetSha256: row.datasetSha256,
      adapterUploadUrl: adapterUrl.url,
      metricsUploadUrl: metricsUrl.url,
      // The nonce in the URL lets the signature be checked before any lookup.
      callbackUrl: `${runtime.publicApiUrl}/api/training/jobs/${jobId}/events?n=${submitNonce}`,
      callbackSecret: deps.callbackSecret(jobId, submitNonce),
      hyperparams: row.hyperparams,
      maxRuntimeSeconds: row.maxRuntimeSeconds,
    });
    // Only the field is named: the values are credentials.
    if (!built.ok) return failBefore(`the job definition was refused (${built.field})`);
    definition = built.definition as never;
  } catch (err) {
    return failBefore(`the transfer URLs could not be issued (${describeError(err)})`);
  }

  const timeoutSeconds =
    row.nosanaTimeoutSeconds ?? trainingNosanaTimeoutSeconds(runtime, row.maxRuntimeSeconds);

  let created: Awaited<ReturnType<TrainingNosanaPort["createDeployment"]>>;
  try {
    created = await (await deps.getNosana()).createDeployment(definition, row.gpuTier, 1, {
      kind: "batch",
      name: deploymentName,
      timeoutSeconds,
    });
  } catch (err) {
    deps.log.error({ jobId, deploymentName, error: describeError(err) }, "Training job submit failed");
    // A failure past creation carries the id: unless its own cleanup verified
    // it stopped and released, it goes to the sweep.
    const hadId = await recordFailedTrainingSubmit({ recordOrphan: deps.recordOrphan }, jobId, err);
    if (!hadId && typeof (err as { deploymentId?: unknown } | null)?.deploymentId !== "string") {
      // No id: the deployment may still exist (the create call threw after
      // the server acted, or timed out). Look for it by name before refunding.
      const lost = await retireLostSubmit(deps, row);
      if (lost === "lookup_failed" || lost === "not_handled") {
        return {
          ok: false,
          code: "left_for_recovery",
          message: "The submit failed and Nosana could not be asked what exists; the poller will ask again",
        };
      }
    }
    const settled = await settleJob(deps, row, {
      from: ["submitting"],
      to: "failed",
      charge: { kind: "none" },
      fields: { failureCode: "submit_failed", lastError: failureSentence("submit_failed") },
    });
    if (!settled.settled) await reconcileTrainingJob(deps, jobId, { submitterDone: true });
    return { ok: false, code: "submit_failed", message: describeError(err) };
  }

  // The id AND the credential that created it, written in one statement:
  // every later read, stop and reclaim goes through that credential.
  const stamp = trainingSubmitStamp(created);
  if (created.mock === true || isMockNosanaId(created.id)) {
    // Refused at admission; reached only if the mock was switched on since.
    return failBefore("the Nosana mock answered the submit");
  }

  const stored = await deps.prisma.trainingJob.updateMany({
    where: { id: jobId, status: "submitting", submitNonce },
    data: { status: "queued", ...stamp, queuedAt: deps.now() },
  });
  if (stored.count === 0) {
    // The user cancelled while the deployment was being created, or the
    // recovery gave this submit up: stop what was just created.
    await retireTrainingDeployment(
      nosanaDeps(deps, row),
      { id: jobId, nosanaJobId: created.id, nosanaAccessMode: stamp.nosanaAccessMode },
      "submit_lost_race",
    );
    await reconcileTrainingJob(deps, jobId, { submitterDone: true });
    return { ok: false, code: "lost_race", message: "The job was cancelled or given up while it was submitted" };
  }

  deps.log.info({ jobId, nosanaJobId: created.id, accessMode: stamp.nosanaAccessMode }, "Training job submitted to Nosana");
  return { ok: true, nosanaJobId: created.id };
}

// ============================================
// Callbacks
// ============================================

export type RecordTrainingEventResult =
  | { ok: true; applied: boolean }
  | { ok: false; status: number; code: string; message: string };

const INVALID_SIGNATURE = {
  ok: false as const,
  status: 401,
  code: "invalid_callback_signature",
  message: "Missing or invalid callback signature.",
};

/**
 * Records one event the training container posted.
 *
 * Order: body size (413), signature over the RAW body with the secret of
 * (job id, nonce) and the timestamp window (401, before any row is read),
 * the event's shape (400), the row and its nonce (404 / 401), then the
 * sequence: an event is applied only when its seq is greater than the last
 * one stored. A stale or replayed event, and any event for a job that is no
 * longer queued or running, answers 200 applied:false so the container does
 * not retry.
 *
 * It writes progress and, for a terminal event, the trainer's REPORT. It
 * never writes a terminal status and never moves money: the reconcile it
 * defers does, under the same compare-and-set as the poller's.
 */
export async function recordTrainingEvent(
  deps: TrainingDeps,
  args: { jobId: string; nonce: unknown; signatureHeader: unknown; rawBody: string | Buffer },
): Promise<RecordTrainingEventResult> {
  const bytes = typeof args.rawBody === "string" ? Buffer.byteLength(args.rawBody, "utf8") : args.rawBody.length;
  if (bytes > TRAINING_CALLBACK_MAX_BYTES) {
    return { ok: false, status: 413, code: "callback_too_large", message: "Callback body too large." };
  }
  if (!UUID_PATTERN.test(args.jobId) || !isTrainingSubmitNonce(args.nonce)) return INVALID_SIGNATURE;

  const verdict = verifyTrainingCallbackSignature({
    callbackSecret: deps.callbackSecret(args.jobId, args.nonce),
    header: args.signatureHeader,
    rawBody: args.rawBody,
    nowMs: deps.now().getTime(),
  });
  if (!verdict.ok) return INVALID_SIGNATURE;

  const rawText = typeof args.rawBody === "string" ? args.rawBody : args.rawBody.toString("utf8");
  const parsed = parseTrainerCallbackBody(rawText);
  if (!parsed.ok) return { ok: false, status: 400, code: parsed.code, message: parsed.message };
  if (parsed.jobId !== args.jobId) {
    return { ok: false, status: 400, code: "callback_job_mismatch", message: "The event names another job." };
  }
  const { event } = parsed;

  let transitioned = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await findJob(deps, args.jobId);
    if (!row) return { ok: false, status: 404, code: "training_job_not_found", message: "Training job not found" };
    // The secret of an earlier submit attempt signs nothing for this one.
    if (row.submitNonce !== args.nonce) return INVALID_SIGNATURE;

    if (row.status === "queued") {
      // The first word from the container: the run has started (D5 fallback
      // for the billable start; the Nosana start replaces it when known).
      const now = deps.now();
      const moved = await deps.prisma.trainingJob.updateMany({
        where: { id: row.id, status: "queued" },
        data: { status: "running", startedAt: now },
      });
      transitioned = transitioned || moved.count > 0;
      continue;
    }
    if (row.status !== "running") return { ok: true, applied: false };
    if (event.seq <= row.lastEventSeq) return { ok: true, applied: false };

    const metrics = readJobMetrics(row.metrics);
    const reduced = reduceTrainerEvent(metrics, event);
    reduced.metrics.logSource = "callbacks";
    const written = await deps.prisma.trainingJob.updateMany({
      // Exactly the sequence that was read: two events landing together
      // cannot overwrite each other's merge.
      where: { id: row.id, status: "running", lastEventSeq: row.lastEventSeq },
      data: {
        ...reduced.data,
        metrics: reduced.metrics,
        lastEventSeq: event.seq,
        lastEventAt: deps.now(),
        logs: appendLog(row.logs, `${TRAINER_EVENT_PREFIX}${JSON.stringify(event)}\n`),
      },
    });
    if (written.count === 0) continue;

    if (transitioned || isTerminalTrainerEvent(event)) {
      deps.defer(() => reconcileTrainingJob(deps, row.id));
    }
    return { ok: true, applied: true };
  }
  // Lost every race: the row moved on each time. Not an error for the container.
  return { ok: true, applied: false };
}

// ============================================
// Reconcile
// ============================================

export type ReconcileAction =
  | "none"
  | "waiting"
  | "submitted"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "stop_retry";

export interface ReconcileResult {
  jobId: string;
  from: string | null;
  to: string | null;
  action: ReconcileAction;
}

interface StepResult {
  action: ReconcileAction;
  /** The state changed and the next state may have work to do now. */
  again?: boolean;
}

const secondsSince = (from: Date | null, now: Date): number =>
  from ? (now.getTime() - from.getTime()) / 1000 : Number.POSITIVE_INFINITY;

async function reconcilePending(deps: TrainingDeps, row: TrainingJobRow): Promise<StepResult> {
  if (secondsSince(row.createdAt, deps.now()) < TRAINING_PENDING_RECOVERY_SECONDS) {
    // Its in-process submitter is about to claim it.
    return { action: "waiting" };
  }
  const result = await submitTrainingJob(deps, row.id);
  return { action: result.ok ? "submitted" : result.code === "not_pending" ? "none" : "failed" };
}

async function reconcileSubmitting(deps: TrainingDeps, row: TrainingJobRow): Promise<StepResult> {
  const age = secondsSince(row.submitStartedAt, deps.now());
  if (age < TRAINING_SUBMIT_TIMEOUT_SECONDS) return { action: "waiting" };

  // The submitter is gone or stuck. Whatever it created is found by name and
  // retired BEFORE the hold is returned (D6).
  const lost = await retireLostSubmit(deps, row);
  if (lost === "lookup_failed" || lost === "not_handled") {
    if (age < TRAINING_SUBMIT_LOOKUP_GIVE_UP_SECONDS) return { action: "stop_retry" };
    deps.log.error(
      {
        jobId: row.id,
        deploymentName: row.submitNonce ? trainingDeploymentName(row.id, row.submitNonce) : null,
      },
      "COULD NOT CONFIRM whether a lost training deployment exists - look for this name on Nosana and stop it by hand",
    );
  }
  const settled = await settleJob(deps, row, {
    from: ["submitting"],
    to: "failed",
    charge: { kind: "none" },
    fields: { failureCode: "submit_failed", lastError: failureSentence("submit_failed") },
  });
  return { action: settled.settled ? "failed" : "none" };
}

async function reconcileQueued(deps: TrainingDeps, row: TrainingJobRow): Promise<StepResult> {
  const now = deps.now();
  const runtime = await deps.getRuntime();
  const view = await readNosana(deps, row);
  const since = row.queuedAt ?? row.createdAt;

  if (view) {
    if (view.jobAddress && !row.nosanaJobAddress) {
      await deps.prisma.trainingJob.updateMany({
        where: { id: row.id, nosanaJobAddress: null },
        data: { nosanaJobAddress: view.jobAddress },
      });
    }
    const jobState = view.job?.state ?? null;
    if (jobState === "running" || jobState === "completed" || jobState === "stopped") {
      // Also when it has already ended: a job goes through `running`, one
      // compare-and-set at a time.
      const startedAt = plausibleTime(view.job?.timeStart, since, now) ?? now;
      const moved = await deps.prisma.trainingJob.updateMany({
        where: { id: row.id, status: "queued" },
        data: { status: "running", startedAt },
      });
      return { action: moved.count > 0 ? "running" : "none", again: true };
    }
    if (view.deploymentState !== "running") {
      // Error, out of platform funds, or stopped before any node ran it.
      const outcome = classifyTrainingOutcome({
        exitCode: null,
        terminalEvent: null,
        deploymentState: view.deploymentState,
        stopRequestedByUs: false,
      });
      const failed = await failJob(deps, row, {
        from: "queued",
        failureCode: outcome.status === "failed" ? outcome.failureCode : "no_exit_code",
        charge: { kind: "none" },
        orphanReason: "training_failed",
      });
      return { action: failed === "lost" ? "none" : failed };
    }
  }

  // No node took it (or Nosana could not be read for the whole queue time).
  if (secondsSince(since, now) >= runtime.queueTimeoutSeconds) {
    const failed = await failJob(deps, row, {
      from: "queued",
      failureCode: "no_capacity" satisfies TrainingPlatformFinding,
      charge: { kind: "none" },
      orphanReason: "training_queue_timeout",
    });
    return { action: failed === "lost" ? "none" : failed };
  }
  return { action: "waiting" };
}

/** Billable milliseconds of an outcome that is charged for the time run. */
function chargeFor(
  outcome: Pick<TrainingOutcome, "charge">,
  window: { startedAt: Date | null; endedAt: Date; cancelRequestedAt?: Date | null },
): { kind: "none" } | { kind: "seconds_run"; billableMs: number } {
  return outcome.charge === "seconds_run"
    ? { kind: "seconds_run", billableMs: trainingBillableMs(window) }
    : { kind: "none" };
}

async function reconcileRunning(deps: TrainingDeps, row: TrainingJobRow): Promise<StepResult> {
  const now = deps.now();
  const view = await readNosana(deps, row);
  const since = row.queuedAt ?? row.createdAt;

  // The billable start is the Nosana job's, when it is known and plausible.
  const nosanaStart = plausibleTime(view?.job?.timeStart, since, now);
  const startedAt = nosanaStart ?? row.startedAt ?? now;

  const logEvents = view?.logText ? parseTrainerEventsFromLog(view.logText) : [];
  const logTerminal = [...logEvents].reverse().find(isTerminalTrainerEvent) ?? null;
  const terminalEvent = reportedTerminalEvent(row) ?? logTerminal;

  const jobState = view?.job?.state ?? null;
  const jobOver = jobState === "completed" || jobState === "stopped";
  const ended = view !== null && (view.deploymentState !== "running" || jobOver);
  const ranSeconds = (now.getTime() - startedAt.getTime()) / 1000;
  const timeoutSeconds = row.nosanaTimeoutSeconds ?? row.maxRuntimeSeconds ?? 0;

  if (!terminalEvent && !ended) {
    const patch: Data = {};
    if (view?.jobAddress && !row.nosanaJobAddress) patch.nosanaJobAddress = view.jobAddress;
    if (nosanaStart && row.startedAt?.getTime() !== nosanaStart.getTime()) patch.startedAt = nosanaStart;
    if (Object.keys(patch).length > 0) {
      await deps.prisma.trainingJob.updateMany({ where: { id: row.id, status: "running" }, data: patch });
    }
    if (timeoutSeconds > 0 && ranSeconds > timeoutSeconds + TRAINING_OVERRUN_GRACE_SECONDS) {
      // Nosana should have ended it by now. Stop it ourselves: the platform
      // pays for every second it stays up.
      if (view === null && ranSeconds > timeoutSeconds + 2 * TRAINING_OVERRUN_GRACE_SECONDS) {
        const failed = await failJob(deps, row, {
          from: "running",
          failureCode: "no_exit_code",
          charge: { kind: "none" },
          gpuStoppedAt: now,
          orphanReason: "training_overrun",
        });
        return { action: failed === "lost" ? "none" : failed };
      }
      if (row.nosanaJobId) {
        deps.log.error({ jobId: row.id, ranSeconds, timeoutSeconds }, "Training run is past its Nosana timeout - stopping it");
        await nosanaDeps(deps, row)
          .stopDeployment(row.nosanaJobId, rowAccessMode(row.nosanaAccessMode))
          .catch((err) =>
            deps.log.warn({ jobId: row.id, error: describeError(err) }, "Stopping an overrunning training deployment failed"),
          );
      }
      return { action: "stop_retry" };
    }
    return { action: "waiting" };
  }

  // The run is over, or the trainer has said its last word.
  let firstSeenEnded = row.gpuStoppedAt;
  if (!firstSeenEnded) {
    firstSeenEnded = plausibleTime(view?.job?.timeEnd, startedAt, now) ?? now;
    const marked = await deps.prisma.trainingJob.updateMany({
      where: { id: row.id, status: "running", gpuStoppedAt: null },
      data: { gpuStoppedAt: firstSeenEnded },
    });
    if (marked.count > 0) {
      // Once per job, what Nosana itself reported, as it was sent: the unit of
      // its time fields is not documented, and this line is how an operator
      // compares them with the times this service billed from.
      deps.log.info(
        {
          jobId: row.id,
          deploymentState: view?.deploymentState ?? null,
          nosanaJobState: view?.job?.rawState ?? null,
          rawTimeStart: view?.job?.raw.timeStart ?? null,
          rawTimeEnd: view?.job?.raw.timeEnd ?? null,
          startUsed: startedAt.toISOString(),
          startFromNosana: nosanaStart !== null,
          endUsed: firstSeenEnded.toISOString(),
          endFromNosana: plausibleTime(view?.job?.timeEnd, startedAt, now) !== null,
          exitCode: view?.exitCode ?? null,
          resultLogChars: view?.logText?.length ?? 0,
          trainerEvent: terminalEvent?.type ?? null,
          trainerEventFrom: terminalEvent === null ? null : reportedTerminalEvent(row) ? "callback" : "nosana_result",
        },
        "Training run ended",
      );
    }
  }
  const exitCode = view?.exitCode ?? null;
  if (
    !terminalEvent &&
    exitCode === null &&
    secondsSince(firstSeenEnded, now) < TRAINING_RESULT_GRACE_SECONDS
  ) {
    // Ended, but the result (exit code, logs) is not there yet: one failed
    // read must not turn a finished run into a failed one.
    return { action: "waiting" };
  }

  const endedAt = plausibleTime(view?.job?.timeEnd, startedAt, now) ?? firstSeenEnded;
  const outcome = classifyTrainingOutcome({
    exitCode,
    terminalEvent,
    deploymentState: view?.deploymentState ?? "unknown",
    stopRequestedByUs: false,
  });

  // No callback ever told us what the logs do: progress, the report, the text.
  await absorbResultLogs(deps, row, logEvents, view?.logText ?? null);

  if (outcome.status === "completed") {
    const moved = await deps.prisma.trainingJob.updateMany({
      where: { id: row.id, status: "running" },
      data: { status: "finalizing", startedAt, gpuStoppedAt: endedAt },
    });
    return { action: moved.count > 0 ? "finalizing" : "none", again: true };
  }
  if (outcome.status === "cancelled") return { action: "none" };

  if (row.startedAt?.getTime() !== startedAt.getTime()) {
    await deps.prisma.trainingJob.updateMany({ where: { id: row.id, status: "running" }, data: { startedAt } });
  }
  const failed = await failJob(deps, row, {
    from: "running",
    failureCode: outcome.failureCode,
    charge: chargeFor(outcome, { startedAt, endedAt }),
    message: terminalEvent?.type === "failed" ? terminalEvent.message : null,
    gpuStoppedAt: endedAt,
    orphanReason: "training_failed",
  });
  return { action: failed === "lost" ? "none" : failed };
}

/**
 * Fills the row from the job's own log when it says more than the callbacks
 * did: events past the last sequence stored, and the log text itself.
 */
async function absorbResultLogs(
  deps: TrainingDeps,
  row: TrainingJobRow,
  events: TrainerEvent[],
  logText: string | null,
  status: "running" | "cancelling" = "running",
): Promise<void> {
  if (!logText) return;
  const fresh = events.filter((event) => event.seq > row.lastEventSeq);
  let metrics = readJobMetrics(row.metrics);
  let data: Data = {};
  for (const event of fresh) {
    const reduced = reduceTrainerEvent(metrics, event);
    metrics = reduced.metrics;
    data = { ...data, ...reduced.data };
  }
  metrics.logSource = "nosana_result";
  await deps.prisma.trainingJob.updateMany({
    where: { id: row.id, status, lastEventSeq: row.lastEventSeq },
    data: {
      ...data,
      metrics,
      logs: logText.length > TRAINING_LOG_MAX_CHARS ? logText.slice(-TRAINING_LOG_MAX_CHARS) : logText,
      ...(fresh.length > 0
        ? { lastEventSeq: fresh[fresh.length - 1]!.seq, lastEventAt: deps.now() }
        : {}),
    },
  });
}

async function reconcileCancelling(
  deps: TrainingDeps,
  row: TrainingJobRow,
  opts: { submitterDone?: boolean },
): Promise<StepResult> {
  const now = deps.now();
  const cancelledWebhook = {};

  if (!row.nosanaJobId) {
    // Cancelled while it was being submitted (D6): nothing ran for the user,
    // so nothing is charged. The submitter stops what it created; if it is
    // gone, the deployment is found by name.
    if (!opts.submitterDone) {
      const age = secondsSince(row.submitStartedAt, now);
      if (age < TRAINING_SUBMIT_TIMEOUT_SECONDS) return { action: "waiting" };
      const lost = await retireLostSubmit(deps, row);
      if ((lost === "lookup_failed" || lost === "not_handled") && age < TRAINING_SUBMIT_LOOKUP_GIVE_UP_SECONDS) {
        return { action: "stop_retry" };
      }
    }
    const settled = await settleJob(deps, row, {
      from: ["cancelling"],
      to: "cancelled",
      charge: { kind: "none" },
      webhook: cancelledWebhook,
    });
    return { action: settled.settled ? "cancelled" : "none" };
  }

  // What ran before the request is the user's; read it before the stop, while
  // the job can still say when it started.
  const view = await readNosana(deps, row);
  const since = row.queuedAt ?? row.createdAt;
  const startedAt = plausibleTime(view?.job?.timeStart, since, now) ?? row.startedAt;
  const cancelAt = row.cancelRequestedAt ?? now;

  // A cancel cannot buy back or worsen what already happened (R2): when the
  // run had ended, or the trainer had said its last word, before the request,
  // it is classified by how it ended, not as our stop.
  const prior = runEndedBeforeCancel(row, view, startedAt, cancelAt, now);
  if (prior) {
    if (!prior.terminalEvent && prior.exitCode === null) {
      if (secondsSince(prior.endedAt, now) < TRAINING_RESULT_GRACE_SECONDS) {
        // As for a running job: one failed read must not decide the outcome.
        return { action: "waiting" };
      }
    }
    const outcome = classifyTrainingOutcome({
      exitCode: prior.exitCode,
      terminalEvent: prior.terminalEvent,
      deploymentState: view?.deploymentState ?? "unknown",
      stopRequestedByUs: false,
    });
    await absorbResultLogs(deps, row, prior.logEvents, view?.logText ?? null, "cancelling");
    if (outcome.status === "completed") {
      // It finished before the user asked: finalised and charged as a
      // completion, never past the request.
      const endedAt = new Date(Math.min(prior.endedAt.getTime(), cancelAt.getTime()));
      const moved = await deps.prisma.trainingJob.updateMany({
        where: { id: row.id, status: "cancelling" },
        data: { status: "finalizing", ...(startedAt ? { startedAt } : {}), gpuStoppedAt: endedAt },
      });
      return { action: moved.count > 0 ? "finalizing" : "none", again: true };
    }
    if (outcome.status === "failed") {
      const retiredFirst = await retireTrainingDeployment(
        nosanaDeps(deps, row),
        { id: row.id, nosanaJobId: row.nosanaJobId, nosanaAccessMode: row.nosanaAccessMode },
        "training_cancelled",
      );
      if (!retiredFirst.handled) return { action: "stop_retry" };
      // cancelling -> failed is not a transition: the row ends cancelled, but
      // charged as the failure says and naming it.
      const settled = await settleJob(deps, row, {
        from: ["cancelling"],
        to: "cancelled",
        charge: chargeFor(outcome, { startedAt, endedAt: prior.endedAt, cancelRequestedAt: cancelAt }),
        fields: {
          failureCode: outcome.failureCode,
          lastError: failureSentence(
            outcome.failureCode,
            prior.terminalEvent?.type === "failed" ? prior.terminalEvent.message : null,
          ),
          gpuStoppedAt: prior.endedAt,
        },
        webhook: cancelledWebhook,
      });
      return { action: settled.settled ? "cancelled" : "none" };
    }
  }

  const retired = await retireTrainingDeployment(
    nosanaDeps(deps, row),
    { id: row.id, nosanaJobId: row.nosanaJobId, nosanaAccessMode: row.nosanaAccessMode },
    "training_cancelled",
  );
  // Confirmed stopped, or durably handed to the sweep that will stop it.
  if (!retired.handled) return { action: "stop_retry" };

  const endedAt = (startedAt ? plausibleTime(view?.job?.timeEnd, startedAt, now) : null) ?? now;
  const outcome = classifyTrainingOutcome({
    exitCode: view?.exitCode ?? null,
    terminalEvent: reportedTerminalEvent(row),
    deploymentState: "ended",
    stopRequestedByUs: true,
  });
  const settled = await settleJob(deps, row, {
    from: ["cancelling"],
    to: "cancelled",
    // Never past the moment the cancel was requested: the time we then took
    // to stop it is ours.
    charge: chargeFor(outcome, { startedAt, endedAt, cancelRequestedAt: cancelAt }),
    fields: { gpuStoppedAt: endedAt },
    webhook: cancelledWebhook,
  });
  return { action: settled.settled ? "cancelled" : "none" };
}

/** Exit codes our own stop produces: the trainer's interrupted, SIGTERM and SIGKILL. */
const STOP_EXIT_CODES: ReadonlySet<number> = new Set([TRAINER_EXIT.interrupted, 137, 143]);

/**
 * Whether a run being cancelled had already ended, or reported its end,
 * before the cancel was requested, and how. null: it was still going when
 * the user asked, and the cancel is what ended it.
 *
 * Certain: the end this service recorded while the job was still running
 * (gpuStoppedAt, our own clock, written before the cancel's compare-and-set),
 * or a terminal event stored before the request (a cancel after one is
 * refused, R2a). Then the exit code and the log are the run's own.
 *
 * Taken on Nosana's or the trainer's clock: Nosana's end time, or a terminal
 * event in the job's log stamped before the request. Those clocks are not
 * ours, and our stop follows the request closely, so what our stop itself
 * causes - an interruption, SIGTERM (143), SIGKILL (137) - is never taken as
 * having come first on their word alone.
 */
function runEndedBeforeCancel(
  row: TrainingJobRow,
  view: NosanaView | null,
  startedAt: Date | null,
  cancelAt: Date,
  now: Date,
): {
  endedAt: Date;
  exitCode: number | null;
  terminalEvent: TrainerTerminalEvent | null;
  logEvents: TrainerEvent[];
} | null {
  const before = (value: Date | null | undefined): value is Date =>
    value != null && value.getTime() <= cancelAt.getTime();
  const nosanaEnd = startedAt ? plausibleTime(view?.job?.timeEnd, startedAt, now) : null;
  const logEvents = view?.logText ? parseTrainerEventsFromLog(view.logText) : [];
  const logTerminal = [...logEvents].reverse().find(isTerminalTrainerEvent) ?? null;
  const reported = reportedTerminalEvent(row);
  const exitCode = view?.exitCode ?? null;

  if (before(row.gpuStoppedAt) || reported) {
    return {
      endedAt: before(row.gpuStoppedAt) ? row.gpuStoppedAt : before(nosanaEnd) ? nosanaEnd : cancelAt,
      exitCode,
      terminalEvent: reported ?? logTerminal,
      logEvents,
    };
  }

  const isStop = (event: TrainerTerminalEvent | null) =>
    event?.type === "failed" && event.exitCode === TRAINER_EXIT.interrupted;
  const logFirst = logTerminal !== null && !isStop(logTerminal) && Date.parse(logTerminal.ts) <= cancelAt.getTime();
  if (!before(nosanaEnd) && !logFirst) return null;
  const terminalEvent = logTerminal && !isStop(logTerminal) ? logTerminal : null;
  const ownExit = before(nosanaEnd) ? exitCode : null;
  if (!terminalEvent && (ownExit === null || STOP_EXIT_CODES.has(ownExit))) {
    // Only Nosana's clock says it ended first, and nothing says how but what
    // our stop would also have caused: it is taken as the cancel.
    if (ownExit !== null || isStop(logTerminal)) return null;
  }
  return {
    endedAt: before(nosanaEnd) ? nosanaEnd : cancelAt,
    exitCode: ownExit,
    terminalEvent,
    logEvents,
  };
}

/** A non-terminal row with no hold is from before fine-tuning was billed: it ends as failed. */
async function reconcileLegacy(deps: TrainingDeps, row: TrainingJobRow): Promise<StepResult> {
  if (row.status === "pending") {
    // pending -> failed is not a transition: claim it first.
    const claimed = await deps.prisma.trainingJob.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "submitting", submitStartedAt: deps.now() },
    });
    return { action: "none", again: claimed.count > 0 };
  }
  if (row.status === "cancelling") {
    const settled = await settleJob(deps, row, { from: ["cancelling"], to: "cancelled", charge: { kind: "none" } });
    return { action: settled.settled ? "cancelled" : "none" };
  }
  const failed = await failJob(deps, row, {
    from: row.status as TrainingState,
    failureCode: row.status === "finalizing" ? "adapter_missing" : row.status === "running" ? "no_exit_code" : "submit_failed",
    charge: { kind: "none" },
    message: "This job could not run and has been closed. Nothing was charged.",
    orphanReason: "training_legacy_row",
  });
  return { action: failed === "lost" ? "none" : failed };
}

/**
 * Brings one job's row in line with what is true: called by the poller for
 * every non-terminal job and by a callback that changed something. Safe when
 * both run at once - every step is a compare-and-set, and only the winner of
 * a terminal one settles.
 */
export async function reconcileTrainingJob(
  deps: TrainingDeps,
  jobId: string,
  opts: { submitterDone?: boolean } = {},
): Promise<ReconcileResult> {
  let from: string | null = null;
  let action: ReconcileAction = "none";
  let status: string | null = null;

  for (let step = 0; step < 5; step += 1) {
    const row = await findJob(deps, jobId);
    if (!row) break;
    status = row.status;
    from ??= row.status;
    if (isTerminalTrainingState(row.status)) break;

    let result: StepResult;
    if (row.reservationCents === null) {
      result = await reconcileLegacy(deps, row);
    } else {
      switch (row.status as TrainingState) {
        case "pending":
          result = await reconcilePending(deps, row);
          break;
        case "submitting":
          result = await reconcileSubmitting(deps, row);
          break;
        case "queued":
          result = await reconcileQueued(deps, row);
          break;
        case "running":
          result = await reconcileRunning(deps, row);
          break;
        case "finalizing":
          result = await finalizeStep(deps, row);
          break;
        case "cancelling":
          result = await reconcileCancelling(deps, row, opts);
          break;
        default:
          result = { action: "none" };
      }
    }
    if (result.action !== "none" || action === "none") action = result.action;
    if (!result.again) break;
  }

  const after = await findJob(deps, jobId);
  return { jobId, from, to: after?.status ?? status, action };
}

// ============================================
// Finalise
// ============================================

/** A bounded, typed summary of metrics.json: what a page and the model row keep. */
export function summariseTrainerMetrics(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const text = (value: unknown, max = 200) =>
    typeof value === "string" && value.length <= max ? value : null;
  const series = (value: unknown, key: "loss") =>
    Array.isArray(value)
      ? value
          .slice(0, 1_000)
          .map((point) => (isRecord(point) ? [num(point.step), num(point[key])] : null))
          .filter((point): point is [number, number] => point !== null && point[0] !== null && point[1] !== null)
      : [];
  const adapter = isRecord(raw.adapter) ? raw.adapter : {};
  const gpu = isRecord(raw.gpu) ? raw.gpu : {};
  const rows = isRecord(raw.rows) ? raw.rows : {};
  const timings = isRecord(raw.timings) ? raw.timings : {};
  return {
    steps: num(raw.steps),
    totalSteps: num(raw.totalSteps),
    epochs: num(raw.epochs),
    stopReason: text(raw.stopReason, 40),
    finalTrainLoss: num(raw.finalTrainLoss),
    finalEvalLoss: num(raw.finalEvalLoss),
    trainTokens: num(raw.trainTokens),
    trainTokensPerSecond: num(raw.trainTokensPerSecond),
    trainLoss: series(raw.trainLoss, "loss"),
    evalLoss: series(raw.evalLoss, "loss"),
    rows: { total: num(rows.total), used: num(rows.used), truncated: num(rows.truncated), skipped: num(rows.skipped), eval: num(rows.eval) },
    timings: {
      download: num(timings.download),
      load: num(timings.load),
      tokenize: num(timings.tokenize),
      train: num(timings.train),
      upload: num(timings.upload),
    },
    gpu: { name: text(gpu.name), vramGb: num(gpu.vramGb), peakVramGb: num(gpu.peakVramGb) },
    adapter: {
      bytes: num(adapter.bytes),
      sha256: typeof adapter.sha256 === "string" && SHA256_PATTERN.test(adapter.sha256) ? adapter.sha256 : null,
      r: num(adapter.r),
      alpha: num(adapter.alpha),
      trainableParameters: num(adapter.trainableParameters),
    },
  };
}

async function readJsonObject(store: ObjectStore, key: string, maxBytes: number): Promise<unknown> {
  const head = await store.head(key);
  if (!head || head.size > maxBytes) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await store.getStream(key)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) return null;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function sha256OfObject(store: ObjectStore, key: string, maxBytes: number): Promise<{ sha256: string; bytes: number } | null> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of await store.getStream(key)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > maxBytes) return null;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

const isUniqueViolation = (error: unknown): boolean => errorCode(error) === "P2002";

async function finalizeStep(deps: TrainingDeps, row: TrainingJobRow): Promise<StepResult> {
  const runtime = await deps.getRuntime();
  const store = deps.getStore();
  if (!store) {
    deps.log.error({ jobId: row.id }, "A training job cannot be finalised: object storage is not configured");
    return { action: "waiting" };
  }
  const keys = trainingArtifactKeys(row.orgId, row.id);
  const startedAt = row.startedAt;
  const endedAt = row.gpuStoppedAt ?? deps.now();

  const reject = async (finding: "adapter_missing" | "adapter_invalid"): Promise<StepResult> => {
    const outcome = classifyTrainingOutcome({
      exitCode: null,
      terminalEvent: null,
      deploymentState: "ended",
      stopRequestedByUs: false,
      platformFinding: finding,
    });
    const failed = await failJob(deps, row, {
      from: "finalizing",
      failureCode: outcome.status === "failed" ? outcome.failureCode : finding,
      charge: { kind: "none" },
      gpuStoppedAt: endedAt,
      orphanReason: "training_failed",
    });
    return { action: failed === "lost" ? "none" : failed };
  };

  // The adapter as STORAGE has it (D7), never as the trainer describes it.
  let head: Awaited<ReturnType<ObjectStore["head"]>>;
  let metricsRaw: unknown;
  try {
    head = await store.head(keys.adapterKey);
    metricsRaw = await readJsonObject(store, keys.metricsKey, TRAINING_METRICS_MAX_BYTES);
  } catch (err) {
    deps.log.warn({ jobId: row.id, error: describeError(err) }, "Adapter could not be read from storage; will retry");
    return { action: "waiting" };
  }
  if (!head) return reject("adapter_missing");
  if (head.size <= 0 || head.size > runtime.adapterMaxBytes) return reject("adapter_invalid");

  const summary = summariseTrainerMetrics(metricsRaw);
  const jobMetrics = readJobMetrics(row.metrics);
  const summaryAdapter = summary && isRecord(summary.adapter) ? summary.adapter : null;
  // What the trainer said it uploaded: its `uploaded` event, else metrics.json.
  const expected =
    jobMetrics.uploaded ??
    (summaryAdapter && typeof summaryAdapter.sha256 === "string" && typeof summaryAdapter.bytes === "number"
      ? { adapterBytes: summaryAdapter.bytes, adapterSha256: summaryAdapter.sha256 }
      : null);
  if (!expected) return reject("adapter_invalid");
  if (expected.adapterBytes !== head.size) return reject("adapter_invalid");

  let stored: Awaited<ReturnType<typeof sha256OfObject>>;
  try {
    stored = await sha256OfObject(store, keys.adapterKey, runtime.adapterMaxBytes);
  } catch (err) {
    deps.log.warn({ jobId: row.id, error: describeError(err) }, "Adapter could not be hashed; will retry");
    return { action: "waiting" };
  }
  if (!stored || stored.sha256 !== expected.adapterSha256) return reject("adapter_invalid");

  // The model row: unique on the job, so a second finaliser finds the first's.
  let model = await deps.prisma.fineTunedModel.findUnique({ where: { trainingJobId: row.id } });
  if (!model) {
    const hyperparams = resolveTrainingHyperparams(
      isRecord(row.hyperparams) ? (row.hyperparams as TrainingHyperparams) : {},
    );
    for (const long of [false, true]) {
      const slug = fineTunedModelSlug(row.name, row.id, long);
      try {
        model = await deps.prisma.fineTunedModel.create({
          data: {
            id: deps.newId(),
            orgId: row.orgId,
            name: row.name,
            slug,
            liveSlug: slug,
            baseModelId: row.baseModelId,
            baseModelHfId: row.baseModelHfId,
            trainingJobId: row.id,
            method: row.method,
            loraR: hyperparams.loraR,
            adapterKey: keys.adapterKey,
            adapterBytes: BigInt(stored.bytes),
            adapterSha256: stored.sha256,
            metrics: summary ?? {},
            status: "ready",
          },
        });
        break;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        model = await deps.prisma.fineTunedModel.findUnique({ where: { trainingJobId: row.id } });
        if (model) break;
        // Otherwise the slug was taken: once more with the whole job id in it.
      }
    }
    if (!model) throw new Error(`finalizeTrainingJob: no fine-tuned model row for job ${row.id}`);
  }

  // The run is over: stop the deployment and release its funding, or hand it
  // to the sweep with the credential that created it.
  if (row.nosanaJobId && !isMockNosanaId(row.nosanaJobId)) {
    const retired = await retireTrainingDeployment(
      nosanaDeps(deps, row),
      { id: row.id, nosanaJobId: row.nosanaJobId, nosanaAccessMode: row.nosanaAccessMode },
      "training_completed",
    );
    if (!retired.handled) return { action: "stop_retry" };
  }

  if (summary) {
    await deps.prisma.trainingJob.updateMany({
      where: { id: row.id, status: "finalizing" },
      data: { metrics: { ...jobMetrics, result: summary } },
    });
  }
  const reported = reportedTerminalEvent(row);
  const partial =
    (summary?.stopReason ?? (reported?.type === "completed" ? reported.stopReason : null)) ===
    "max_runtime";
  const settled = await settleJob(deps, row, {
    from: ["finalizing"],
    to: "completed",
    charge: { kind: "seconds_run", billableMs: trainingBillableMs({ startedAt, endedAt }) },
    fields: { outputModelId: model.id, outputPath: keys.adapterKey, progress: 100, gpuStoppedAt: endedAt },
    webhook: { fineTunedModelId: model.id, fineTunedModelSlug: model.slug, partial },
  });
  return { action: settled.settled ? "completed" : "none" };
}

/**
 * Finalises a job that is `finalizing`: verifies the adapter in storage,
 * creates the FineTunedModel row (idempotently), retires the deployment, and
 * settles in the transaction of the terminal compare-and-set.
 */
export async function finalizeTrainingJob(deps: TrainingDeps, jobId: string): Promise<ReconcileResult> {
  const row = await findJob(deps, jobId);
  if (!row || row.status !== "finalizing") {
    return { jobId, from: row?.status ?? null, to: row?.status ?? null, action: "none" };
  }
  const result =
    row.reservationCents === null ? await reconcileLegacy(deps, row) : await finalizeStep(deps, row);
  const after = await findJob(deps, jobId);
  return { jobId, from: "finalizing", to: after?.status ?? null, action: result.action };
}

// ============================================
// Cancel
// ============================================

export type CancelTrainingJobResult =
  | { ok: true; status: "cancelled" | "cancelling" }
  | TrainingRefusal;

/**
 * Cancels a job of `orgId`.
 *
 *   pending      -> cancelled at once; the whole hold is returned.
 *   submitting   -> cancelling; ends cancelled, charged nothing, once the
 *                   submitter (or the recovery) has stopped what it created.
 *   queued,
 *   running      -> cancelling, cancelRequestedAt stamped; the deployment is
 *                   stopped and the job ends cancelled, charged for the time
 *                   run up to the request. A run found to have ended before
 *                   the request is settled as it ended (reconcileCancelling).
 *   409 training_already_finished once the trainer's terminal event is
 *   recorded: the run is over and its outcome is decided by how it ended
 *   (R2a). 409 training_job_not_cancellable in every other state.
 */
export async function cancelTrainingJob(
  deps: TrainingDeps,
  args: { orgId: string; jobId: string },
): Promise<CancelTrainingJobResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await deps.prisma.trainingJob.findFirst({ where: { id: args.jobId, orgId: args.orgId } });
    if (!row) return refuse(404, "training_job_not_found", "Training job not found");
    if (!(CANCELLABLE_TRAINING_STATES as readonly string[]).includes(row.status)) {
      return refuse(
        409,
        "training_job_not_cancellable",
        row.status === "cancelling"
          ? "This job is already being cancelled."
          : `A job that is ${row.status} cannot be cancelled.`,
        { status: row.status },
      );
    }

    if (reportedTerminalEvent(row)) {
      return refuse(
        409,
        "training_already_finished",
        "This run has already finished on the GPU and reported how it ended; it is being settled as it ended.",
        { status: row.status },
      );
    }

    if (row.status === "pending") {
      const settled = await settleJob(deps, row, {
        from: ["pending"],
        to: "cancelled",
        charge: { kind: "none" },
      });
      if (settled.settled) return { ok: true, status: "cancelled" };
      continue; // a submitter claimed it meanwhile: read again
    }

    const moved = await deps.prisma.trainingJob.updateMany({
      // The exact event sequence read: a terminal event recorded between the
      // read above and this write makes the write miss, and the next read
      // refuses (R2a).
      where: { id: row.id, orgId: args.orgId, status: row.status, lastEventSeq: row.lastEventSeq },
      data: { status: "cancelling", cancelRequestedAt: deps.now() },
    });
    if (moved.count === 0) continue;

    // Try the stop now; whatever is left, the poller finishes.
    const reconciled = await reconcileTrainingJob(deps, row.id).catch((err) => {
      deps.log.warn({ jobId: row.id, error: describeError(err) }, "Cancel could not be completed inline");
      return null;
    });
    return { ok: true, status: reconciled?.to === "cancelled" ? "cancelled" : "cancelling" };
  }
  return refuse(409, "training_job_not_cancellable", "The job changed state while it was being cancelled. Try again.");
}

// ============================================
// Reading jobs
// ============================================

/** Why a job failed; also for a job cancelled after its run had already failed (R2). */
function failureView(row: TrainingJobListRow) {
  if (row.status !== "failed" && !(row.status === "cancelled" && row.failureCode)) return null;
  const code = row.failureCode ?? "unknown";
  return {
    code,
    message: row.lastError ?? failureSentence(code),
    charged: (row.actualCostCents ?? 0n) > 0n,
  };
}

const cents = (value: bigint | null): number | null => (value === null ? null : Number(value));

/** A job as the list shows it. */
export function serializeTrainingJob(row: TrainingJobListRow, now: Date) {
  const settled = row.settledAt !== null;
  return {
    id: row.id,
    name: row.name,
    baseModelId: row.baseModelId,
    baseModelHfId: row.baseModelHfId,
    datasetId: row.datasetId,
    method: row.method,
    gpuTier: row.gpuTier,
    gpuCount: row.gpuCount,
    status: row.status,
    progress: row.progress,
    currentEpoch: row.currentEpoch,
    totalEpochs: row.totalEpochs,
    currentStep: row.currentStep,
    totalSteps: row.totalSteps,
    trainingLoss: row.trainingLoss,
    evalLoss: row.evalLoss,
    failureCode: row.failureCode,
    lastError: row.lastError,
    failure: failureView(row),
    maxRuntimeSeconds: row.maxRuntimeSeconds,
    estimatedCostCents: cents(row.estimatedCostCents),
    // The hold while the job is alive; what was charged once it is settled.
    reservationCents: cents(row.reservationCents),
    costSoFarCents:
      row.status === "running" || row.status === "finalizing" || row.status === "cancelling"
        ? Number(
            trainingCostSoFarCents({
              priceMicroUsdPerSecond: row.priceMicroUsdPerSecond,
              holdCents: row.reservationCents,
              startedAt: row.startedAt,
              now: row.cancelRequestedAt ?? row.gpuStoppedAt ?? now,
            }),
          )
        : null,
    actualCostCents: settled ? cents(row.actualCostCents) : null,
    billedSeconds: settled ? row.billedSeconds : null,
    charged: settled ? (row.actualCostCents ?? 0n) > 0n : null,
    pricePerSecondUsd:
      row.priceMicroUsdPerSecond === null ? null : Number(row.priceMicroUsdPerSecond) / 1_000_000,
    outputModelId: row.outputModelId,
    createdAt: row.createdAt,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    cancelRequestedAt: row.cancelRequestedAt,
    gpuStoppedAt: row.gpuStoppedAt,
    completedAt: row.completedAt,
    settledAt: row.settledAt,
  };
}

export const TRAINING_LEDGER_TYPES = [
  TRAINING_RESERVATION_LEDGER_TYPE,
  TRAINING_RELEASE_LEDGER_TYPE,
  TRAINING_USAGE_LEDGER_TYPE,
] as const;

export async function listTrainingJobs(
  deps: TrainingDeps,
  args: { orgId: string; status?: string },
) {
  const rows = await deps.prisma.trainingJob.findMany({
    where: { orgId: args.orgId, ...(args.status ? { status: args.status } : {}) },
    select: Object.fromEntries(TRAINING_JOB_LIST_COLUMNS.map((column) => [column, true])) as Record<
      TrainingJobListColumn,
      true
    >,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  // Deleted datasets too: a finished job still names its data.
  const datasets = rows.length
    ? await deps.prisma.dataset.findMany({
        where: { orgId: args.orgId, id: { in: [...new Set(rows.map((row) => row.datasetId))] } },
      })
    : [];
  const names = new Map(datasets.map((dataset) => [dataset.id, dataset.name]));
  const now = deps.now();
  return rows.map((row) => ({
    ...serializeTrainingJob(row, now),
    datasetName: names.get(row.datasetId) ?? null,
  }));
}

/** One job, with its money: the hold, the cost so far, and its ledger rows by reference. */
export async function getTrainingJobDetail(deps: TrainingDeps, args: { orgId: string; jobId: string }) {
  const row = await deps.prisma.trainingJob.findFirst({ where: { id: args.jobId, orgId: args.orgId } });
  if (!row) return null;
  const [dataset, model, ledger] = await Promise.all([
    // Deleted datasets still name the job's data.
    deps.prisma.dataset.findFirst({ where: { id: row.datasetId, orgId: args.orgId } }),
    row.outputModelId ? deps.prisma.fineTunedModel.findUnique({ where: { trainingJobId: row.id } }) : null,
    deps.prisma.creditTransaction.findMany({
      where: { orgId: args.orgId, referenceId: row.id, type: { in: [...TRAINING_LEDGER_TYPES] } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const metrics = readJobMetrics(row.metrics);
  return {
    ...serializeTrainingJob(row, deps.now()),
    hyperparams: row.hyperparams ?? null,
    config: row.config,
    datasetSha256: row.datasetSha256,
    dataset: dataset
      ? {
          id: dataset.id,
          name: dataset.name,
          rowCount: dataset.rowCountKnown ? dataset.rowCount : null,
          deleted: dataset.deletedAt !== null,
        }
      : null,
    metrics,
    partial: isRecord(metrics.result) ? metrics.result.stopReason === "max_runtime" : null,
    fineTunedModel: model ? { id: model.id, slug: model.slug, name: model.name } : null,
    ledger: ledger.map((entry) => ({
      id: entry.id,
      type: entry.type,
      amountCents: Number(entry.amountCents),
      balanceAfterCents: Number(entry.balanceAfter),
      description: entry.description,
      createdAt: entry.createdAt,
    })),
  };
}

export async function getTrainingJobLogs(
  deps: TrainingDeps,
  args: { orgId: string; jobId: string; tail: number },
) {
  const row = await deps.prisma.trainingJob.findFirst({ where: { id: args.jobId, orgId: args.orgId } });
  if (!row) return null;
  const lines = row.logs ? row.logs.replace(/\n$/, "").split("\n") : [];
  return {
    jobId: row.id,
    status: row.status,
    logs: lines.slice(-args.tail).join("\n"),
    totalLines: lines.length,
    source: lines.length === 0 ? ("none" as const) : (readJobMetrics(row.metrics).logSource ?? "callbacks"),
  };
}
