/**
 * How fine-tuning is worded and worked out in the dashboard.
 *
 * Pure: every figure a page shows comes from the API (the hold, the cost so
 * far, the charge, the bounds, the tiers) and passes through here only to be
 * chosen and formatted. Nothing in this file knows a price, a model or a
 * limit of its own.
 */

import {
  getApiErrorBody,
  type DatasetFileType,
  type TrainableModel,
  type TrainableModelMethod,
  type TrainingCapabilities,
  type TrainingHyperparamBound,
  type TrainingHyperparams,
  type TrainingJob,
  type TrainingJobStatus,
  type TrainingMethod,
} from "./api";
import { formatCents, formatDuration } from "./jobs";

// ============================================
// States
// ============================================

export type TrainingBadgeVariant = "success" | "warning" | "destructive" | "secondary" | "default";

export interface TrainingStatusView {
  label: string;
  variant: TrainingBadgeVariant;
  /** One sentence on what is happening and what it costs. */
  description: string;
}

const STATUS_VIEWS: Record<TrainingJobStatus, TrainingStatusView> = {
  pending: {
    label: "Pending",
    variant: "secondary",
    description: "Admitted. Credits are held and the job is about to be submitted. Nothing is charged yet.",
  },
  submitting: {
    label: "Submitting",
    variant: "secondary",
    description: "Being submitted to the GPU network. Nothing is charged yet.",
  },
  queued: {
    label: "Queued",
    variant: "secondary",
    description: "Waiting for a GPU node. Time in the queue is free.",
  },
  running: {
    label: "Running",
    variant: "warning",
    description: "Training on a GPU. Billed per second, never more than the amount held.",
  },
  finalizing: {
    label: "Finalizing",
    variant: "warning",
    description: "The run has ended. The adapter is being checked before the job is settled.",
  },
  completed: {
    label: "Completed",
    variant: "success",
    description: "The adapter is stored and the job is settled.",
  },
  failed: {
    label: "Failed",
    variant: "destructive",
    description: "The job ended without a usable adapter.",
  },
  cancelling: {
    label: "Cancelling",
    variant: "secondary",
    description: "The stop is being confirmed. You are not charged for the time this takes.",
  },
  cancelled: {
    label: "Cancelled",
    variant: "secondary",
    description: "Cancelled at your request. Only time on a GPU before the cancel request is charged.",
  },
};

/** A state as a page shows it. An unknown state is shown as it is, never guessed at. */
export function trainingStatusView(status: string): TrainingStatusView {
  return (
    STATUS_VIEWS[status as TrainingJobStatus] ?? {
      label: status,
      variant: "secondary",
      description: "",
    }
  );
}

const TERMINAL: readonly string[] = ["completed", "failed", "cancelled"];
const CANCELLABLE: readonly string[] = ["pending", "submitting", "queued", "running"];

export function isTerminalTrainingStatus(status: string): boolean {
  return TERMINAL.includes(status);
}

/** The states POST /jobs/:id/cancel accepts; any other answers 409. */
export function canCancelTraining(status: string): boolean {
  return CANCELLABLE.includes(status);
}

/** Retry makes a new job from one that is over and has no model. */
export function canRetryTraining(status: string): boolean {
  return status === "failed" || status === "cancelled";
}

// ============================================
// Money
// ============================================

type JobMoney = Pick<
  TrainingJob,
  "status" | "reservationCents" | "costSoFarCents" | "actualCostCents" | "settledAt" | "charged"
>;

export interface TrainingCostView {
  /** What the figure is: the charge, the cost so far, or the hold. */
  kind: "charged" | "not_charged" | "so_far" | "held" | "unknown";
  label: string;
  /** null when the API has no figure (a job that held nothing). */
  cents: number | null;
  text: string;
}

/**
 * The one cost figure a list row shows: the charge once the job is settled,
 * the cost so far while it runs, the hold while nothing has run yet.
 */
export function trainingCostView(job: JobMoney): TrainingCostView {
  if (job.settledAt !== null && job.actualCostCents !== null) {
    return job.actualCostCents > 0
      ? { kind: "charged", label: "Charged", cents: job.actualCostCents, text: formatCents(job.actualCostCents) }
      : { kind: "not_charged", label: "Not charged", cents: 0, text: formatCents(0) };
  }
  if (job.settledAt !== null) {
    // Settled with no charge recorded: nothing was taken.
    return { kind: "not_charged", label: "Not charged", cents: 0, text: formatCents(0) };
  }
  if (job.costSoFarCents !== null) {
    return { kind: "so_far", label: "Cost so far", cents: job.costSoFarCents, text: formatCents(job.costSoFarCents) };
  }
  if (job.reservationCents !== null && !isTerminalTrainingStatus(job.status)) {
    return { kind: "held", label: "Held", cents: job.reservationCents, text: formatCents(job.reservationCents) };
  }
  return { kind: "unknown", label: "Cost", cents: null, text: "Not recorded" };
}

export interface TrainingSettlementView {
  holdCents: number;
  chargeCents: number;
  returnedCents: number;
}

/** The hold, the charge and what came back, once a job is settled. null before that. */
export function trainingSettlement(
  job: Pick<TrainingJob, "reservationCents" | "actualCostCents" | "settledAt">,
): TrainingSettlementView | null {
  if (job.settledAt === null || job.reservationCents === null) return null;
  const chargeCents = job.actualCostCents ?? 0;
  return {
    holdCents: job.reservationCents,
    chargeCents,
    returnedCents: Math.max(0, job.reservationCents - chargeCents),
  };
}

export interface TrainingTotals {
  total: number;
  /** Not over yet. */
  active: number;
  running: number;
  completed: number;
  /** Sum of the charges of settled jobs. */
  chargedCents: number;
  /** Sum of the holds of jobs that are not settled. */
  heldCents: number;
  /** Sum of the seconds billed. */
  billedSeconds: number;
}

/** Totals over the jobs the API listed. Every figure is a sum of API fields. */
export function trainingTotals(
  jobs: Array<
    Pick<
      TrainingJob,
      "status" | "actualCostCents" | "reservationCents" | "settledAt" | "billedSeconds"
    >
  >,
): TrainingTotals {
  const totals: TrainingTotals = {
    total: jobs.length,
    active: 0,
    running: 0,
    completed: 0,
    chargedCents: 0,
    heldCents: 0,
    billedSeconds: 0,
  };
  for (const job of jobs) {
    if (!isTerminalTrainingStatus(job.status)) totals.active += 1;
    if (job.status === "running") totals.running += 1;
    if (job.status === "completed") totals.completed += 1;
    if (job.settledAt !== null) {
      totals.chargedCents += job.actualCostCents ?? 0;
      totals.billedSeconds += job.billedSeconds ?? 0;
    } else if (!isTerminalTrainingStatus(job.status)) {
      totals.heldCents += job.reservationCents ?? 0;
    }
  }
  return totals;
}

const RATE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});

/** "$0.000150 per second ($0.54 per hour)". The per-second price is the one billed. */
export function formatGpuRate(pricePerSecondUsd: number): string {
  return `${RATE.format(pricePerSecondUsd)} per second (${formatCents(
    Math.round(pricePerSecondUsd * 3_600 * 100),
  )} per hour)`;
}

/** "$0.54/hr", for a tier card. */
export function formatHourlyRate(pricePerSecondUsd: number): string {
  return `${formatCents(Math.round(pricePerSecondUsd * 3_600 * 100))}/hr`;
}

const LEDGER_LABELS: Record<string, string> = {
  training_reservation: "Hold taken",
  training_reservation_release: "Hold returned",
  training_usage: "Charge for GPU time",
};

export function trainingLedgerLabel(type: string): string {
  return LEDGER_LABELS[type] ?? type;
}

// ============================================
// Time
// ============================================

export interface TrainingTimelineEntry {
  key: string;
  label: string;
  at: string;
}

/** The times the API recorded for a job, in order. A time it does not have is left out. */
export function trainingTimeline(
  job: Pick<
    TrainingJob,
    | "createdAt"
    | "queuedAt"
    | "startedAt"
    | "cancelRequestedAt"
    | "gpuStoppedAt"
    | "completedAt"
    | "settledAt"
    | "status"
    | "reservationCents"
  >,
): TrainingTimelineEntry[] {
  const ended =
    job.status === "failed" ? "Failed" : job.status === "cancelled" ? "Cancelled" : "Completed";
  const entries: Array<[string, string, string | null]> = [
    // A row from before jobs held credits has no hold to speak of.
    ["created", job.reservationCents !== null ? "Created, credits held" : "Created", job.createdAt],
    ["queued", "Submitted to the GPU network", job.queuedAt],
    ["started", "Training started", job.startedAt],
    ["cancelRequested", "Cancel requested", job.cancelRequestedAt],
    ["gpuStopped", "GPU stopped", job.gpuStoppedAt],
    ["completed", ended, job.completedAt],
    ["settled", "Settled", job.settledAt],
  ];
  return entries
    .filter((entry): entry is [string, string, string] => entry[2] !== null)
    .map(([key, label, at]) => ({ key, label, at }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * A job recorded before jobs held credits and stored adapters: it is over,
 * but has no hold, no settlement and no model. Pages say so instead of
 * describing a settlement that never happened.
 */
export function isLegacyTrainingJob(
  job: Pick<TrainingJob, "status" | "reservationCents" | "settledAt">,
): boolean {
  return isTerminalTrainingStatus(job.status) && job.reservationCents === null && job.settledAt === null;
}

/** "45 minutes", "2 hours 30 minutes". */
export function formatRunTime(seconds: number): string {
  return seconds <= 0 ? "0 seconds" : formatDuration(seconds);
}

/** Whole minutes of a run limit in seconds, rounded so the bounds stay inside the API's. */
export function runLimitMinuteBounds(runLimit: { minSeconds: number; maxSeconds: number }): {
  minMinutes: number;
  maxMinutes: number;
} {
  return {
    minMinutes: Math.ceil(runLimit.minSeconds / 60),
    maxMinutes: Math.floor(runLimit.maxSeconds / 60),
  };
}

/** Why a run limit typed in minutes cannot be sent, or null when it can. */
export function runLimitError(
  raw: string,
  runLimit: { minSeconds: number; maxSeconds: number },
): string | null {
  const { minMinutes, maxMinutes } = runLimitMinuteBounds(runLimit);
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value)) return "Enter a whole number of minutes.";
  if (value < minMinutes || value > maxMinutes) {
    return `The run limit is from ${minMinutes.toLocaleString()} to ${maxMinutes.toLocaleString()} minutes.`;
  }
  return null;
}

// ============================================
// Datasets
// ============================================

/** The file type the API will take from this file name, or null for one it refuses. */
export function datasetFileTypeFromName(fileName: string): DatasetFileType | null {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase();
  if (extension === "jsonl" || extension === "ndjson" || extension === "json") return "jsonl";
  if (extension === "csv") return "csv";
  if (extension === "parquet") return "parquet";
  return null;
}

const ROW_FORMATS: Record<string, { label: string; shape: string }> = {
  alpaca: { label: "Alpaca", shape: "instruction, optional input, output" },
  sharegpt: { label: "ShareGPT", shape: "a conversations list of human and gpt turns" },
  completion: { label: "Prompt and completion", shape: "prompt, completion" },
  text: { label: "Text", shape: "one text field holding the whole example" },
};

/** The detected row format in words; an unknown one is shown as the API named it. */
export function datasetRowFormat(schemaFormat: string | null | undefined): {
  label: string;
  shape: string | null;
} {
  if (!schemaFormat) return { label: "Not detected yet", shape: null };
  const known = ROW_FORMATS[schemaFormat];
  return known ?? { label: schemaFormat, shape: null };
}

export const DATASET_ROW_FORMATS = Object.entries(ROW_FORMATS).map(([id, format]) => ({ id, ...format }));

/** "1.20 MB", "340 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} bytes`;
}

/**
 * Why a dataset cannot be trained on, in the terms of the refusals the API
 * would send (409 dataset_not_validated, 422 dataset_row_count_unknown).
 * null when it can be chosen.
 */
export function datasetTrainingBlocker(dataset: {
  isValidated: boolean;
  rowCount: number | null;
  contentSha256?: string | null;
}): string | null {
  if (!dataset.isValidated) return "It has not passed validation. Open it on the Datasets page to see why.";
  if (dataset.contentSha256 === null) return "Validated before files were fingerprinted. Validate it again first.";
  if (dataset.rowCount === null) return "Its rows could not be counted, so its cost cannot be worked out.";
  return null;
}

// ============================================
// Models, methods and tiers
// ============================================

export function formatParameters(parameters: number | null): string | null {
  if (parameters === null) return null;
  if (parameters >= 1e9) return `${(parameters / 1e9).toFixed(parameters >= 1e10 ? 0 : 1).replace(/\.0$/, "")}B`;
  if (parameters >= 1e6) return `${(parameters / 1e6).toFixed(0)}M`;
  return parameters.toLocaleString();
}

export const TRAINING_METHOD_LABELS: Record<TrainingMethod, { name: string; description: string }> = {
  lora: { name: "LoRA", description: "Trains a small adapter on the full-precision base model." },
  qlora: { name: "QLoRA", description: "Trains the adapter on a 4-bit base model, so it fits on less GPU memory." },
};

/** A method of a model, or undefined when the API does not offer it. */
export function methodOf(model: TrainableModel, method: string): TrainableModelMethod | undefined {
  return model.methods.find((entry) => entry.method === method);
}

/** Why a method of a model cannot be chosen on this server, or null when it can. */
export function methodBlocker(entry: TrainableModelMethod): string | null {
  return entry.tiers.length === 0
    ? `Needs a GPU tier with ${entry.requiredVramGb} GB of memory; none is available right now.`
    : null;
}

export interface TierChoice {
  tier: string;
  name: string;
  vramGb: number;
  pricePerSecondUsd: number;
  selectable: boolean;
  /** Why it cannot be chosen; null when it can. */
  reason: string | null;
}

/**
 * Every tier the server knows, each either selectable for this model and
 * method or carrying the reason it is not: too little memory, or not
 * available on this server. The fit comes from the API's own tier list for
 * the method; nothing is worked out here.
 */
export function tierChoices(
  capabilities: Pick<TrainingCapabilities, "nosana">,
  entry: TrainableModelMethod | undefined,
): TierChoice[] {
  const fits = new Map((entry?.tiers ?? []).map((tier) => [tier.tier, tier]));
  return capabilities.nosana.tiers
    .map((tier) => {
      const fit = fits.get(tier.tier);
      let reason: string | null = null;
      if (!fit) {
        if (entry && tier.vramGb < entry.requiredVramGb) {
          reason = `Too small: this needs ${entry.requiredVramGb} GB of GPU memory.`;
        } else if (!tier.deployable) {
          reason = "Not available right now.";
        } else {
          reason = "Not offered for this model and method.";
        }
      }
      return {
        tier: tier.tier,
        name: tier.name,
        vramGb: tier.vramGb,
        pricePerSecondUsd: fit?.pricePerSecondUsd ?? tier.pricePerSecondUsd,
        selectable: fit !== undefined,
        reason,
      };
    })
    .sort((a, b) => a.pricePerSecondUsd - b.pricePerSecondUsd);
}

// ============================================
// Hyperparameters
// ============================================

/** The numeric hyperparameters the form offers, in display order. */
export const HYPERPARAM_FIELDS = [
  { key: "epochs", label: "Epochs", hint: "Passes over the dataset." },
  { key: "batchSize", label: "Batch size", hint: "Examples per step." },
  { key: "gradientAccumulationSteps", label: "Gradient accumulation", hint: "Steps added up before a weight update." },
  { key: "learningRate", label: "Learning rate", hint: "" },
  { key: "warmupRatio", label: "Warm-up ratio", hint: "Share of steps spent warming up." },
  { key: "loraAlpha", label: "LoRA alpha", hint: "Scaling of the adapter." },
  { key: "loraDropout", label: "LoRA dropout", hint: "" },
  { key: "maxSeqLength", label: "Max sequence length", hint: "Tokens per example; longer ones are cut." },
] as const;

export type HyperparamFieldKey = (typeof HYPERPARAM_FIELDS)[number]["key"];

/** Why a typed value is outside the API's bounds, or null when it is inside. */
export function hyperparamError(
  label: string,
  raw: string,
  bound: TrainingHyperparamBound | undefined,
): string | null {
  if (!bound) return null;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) return `${label} must be a number.`;
  if (bound.integer && !Number.isInteger(value)) return `${label} must be a whole number.`;
  if (value < bound.min || value > bound.max) {
    return `${label} must be from ${bound.min} to ${bound.max}.`;
  }
  return null;
}

/** The form's values as strings, starting from the API's defaults. */
export function hyperparamFormDefaults(
  hyperparameters: TrainingCapabilities["hyperparameters"],
): Record<HyperparamFieldKey | "loraR", string> {
  const out = {} as Record<HyperparamFieldKey | "loraR", string>;
  for (const field of HYPERPARAM_FIELDS) {
    const value = hyperparameters.defaults[field.key];
    out[field.key] = typeof value === "number" ? String(value) : "";
  }
  const rank = hyperparameters.defaults.loraR;
  out.loraR = typeof rank === "number" ? String(rank) : String(hyperparameters.loraRanks[0] ?? "");
  return out;
}

/**
 * The hyperparams object to send: only the values that differ from the
 * API's defaults, so what is stored is what was asked for and the trainer's
 * defaults stay the trainer's.
 */
export function hyperparamsToSend(
  form: Record<string, string>,
  hyperparameters: TrainingCapabilities["hyperparameters"],
): TrainingHyperparams {
  const out: Record<string, number> = {};
  for (const key of [...HYPERPARAM_FIELDS.map((field) => field.key), "loraR"]) {
    const raw = form[key];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (hyperparameters.defaults[key] === value) continue;
    out[key] = value;
  }
  return out as TrainingHyperparams;
}

/** Every field error of the form; empty when it can be sent. */
export function hyperparamFormErrors(
  form: Record<string, string>,
  hyperparameters: TrainingCapabilities["hyperparameters"],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of HYPERPARAM_FIELDS) {
    const message = hyperparamError(field.label, form[field.key] ?? "", hyperparameters.bounds[field.key]);
    if (message) errors[field.key] = message;
  }
  if (!hyperparameters.loraRanks.includes(Number(form.loraR))) {
    errors.loraR = `LoRA rank must be one of ${hyperparameters.loraRanks.join(", ")}.`;
  }
  return errors;
}

// ============================================
// Refusals
// ============================================

export interface TrainingRefusalView {
  status: number;
  code: string;
  message: string;
  /** 402 insufficient_credits: what the hold needs and what the balance is. */
  requiredCents: number | null;
  balanceCents: number | null;
  /** invalid_hyperparameter / unknown_hyperparameter: the field refused. */
  field: string | null;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * A refusal of the training API ({ error, message, ...extra }) as a page
 * shows it. null when the error is not an API response.
 */
export function trainingRefusal(err: unknown): TrainingRefusalView | null {
  const failure = getApiErrorBody(err);
  if (!failure) return null;
  const { body } = failure;
  return {
    status: failure.status,
    code: typeof body.error === "string" ? body.error : "",
    message: typeof body.message === "string" ? body.message : "",
    requiredCents: num(body.requiredCents),
    balanceCents: num(body.balanceCents),
    field: typeof body.field === "string" ? body.field : null,
  };
}

/** "You need $4.20 held for this run and have $1.00: add at least $3.20." */
export function insufficientCreditsSentence(refusal: {
  requiredCents: number | null;
  balanceCents: number | null;
}): string {
  if (refusal.requiredCents === null) return "Your balance does not cover the amount this run would hold.";
  if (refusal.balanceCents === null) {
    return `This run holds ${formatCents(refusal.requiredCents)}, which is more than your balance.`;
  }
  const short = Math.max(0, refusal.requiredCents - refusal.balanceCents);
  return `This run holds ${formatCents(refusal.requiredCents)} and your balance is ${formatCents(
    refusal.balanceCents,
  )}. Add at least ${formatCents(short)} to start it.`;
}

// ============================================
// Loss
// ============================================

/**
 * An SVG polyline for a [step, loss] series in a width x height box, or null
 * when there are fewer than two points to join.
 */
export function lossPolyline(
  series: Array<[number, number]> | undefined,
  width: number,
  height: number,
): string | null {
  const points = (series ?? []).filter(
    (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
  );
  if (points.length < 2) return null;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return points
    .map(([x, y]) => {
      const px = ((x - minX) / spanX) * width;
      const py = height - ((y - minY) / spanY) * height;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
}

/** A number read from the metrics summary, or null. */
export function metricNumber(metrics: Record<string, unknown> | null | undefined, key: string): number | null {
  return metrics ? num(metrics[key]) : null;
}
