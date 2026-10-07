/**
 * The training job state machine: the states, the transitions between them,
 * what a finished run costs, and the parser of what the trainer reports.
 *
 * Pure. Nothing here reads a clock, a database or the environment.
 *
 * States
 * ------
 *   pending      the row and its credit hold exist; nothing is on Nosana.
 *   submitting   one submitter has claimed the row and is creating the
 *                deployment (named wheelsai-train-<job id>-<submit nonce>).
 *   queued       Nosana has the deployment; no node has started it.
 *   running      a node is running the container.
 *   finalizing   the run reported success; the adapter is being verified.
 *   completed    the adapter is verified and a FineTunedModel row exists.
 *   failed
 *   cancelling   the user asked to stop; the stop is not confirmed yet.
 *   cancelled
 *
 * Every transition is a compare-and-set on the row
 * (updateMany where { id, status: <from> }); a count of 0 means another
 * writer won and the caller changes nothing else. A terminal transition is
 * made by settleTrainingJob (services/trainingBilling.ts), in the same
 * transaction as the money.
 *
 * Who writes what
 * ---------------
 * Container callbacks never write a terminal state and never move money: they
 * record progress and the trainer's own report, then call the same reconcile
 * the poller calls. The reconcile gathers the facts and asks
 * classifyTrainingOutcome what they amount to.
 */

// ============================================
// States and transitions
// ============================================

export const TRAINING_STATES = [
  "pending",
  "submitting",
  "queued",
  "running",
  "finalizing",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
] as const;

export type TrainingState = (typeof TRAINING_STATES)[number];

export const TERMINAL_TRAINING_STATES = ["completed", "failed", "cancelled"] as const;
export type TerminalTrainingState = (typeof TERMINAL_TRAINING_STATES)[number];

/** Every state a job is still alive in: what the per-organization limit counts. */
export const ACTIVE_TRAINING_STATES: readonly TrainingState[] = TRAINING_STATES.filter(
  (state) => !(TERMINAL_TRAINING_STATES as readonly string[]).includes(state),
);

export interface TrainingTransition {
  from: TrainingState;
  to: TrainingState;
  /** The writer, and what it stamps in the same statement. */
  when: string;
}

/**
 * The whole machine. Anything not listed is refused: there is no way out of a
 * terminal state, no way back, and no skipping (a job found already finished
 * while still `queued` goes through `running` first, one compare-and-set at a
 * time).
 */
export const TRAINING_TRANSITIONS: readonly TrainingTransition[] = [
  {
    from: "pending",
    to: "submitting",
    when: "a submitter claims the row; sets submitNonce and submitStartedAt",
  },
  {
    from: "pending",
    to: "cancelled",
    when: "the user cancels before anything was submitted; the whole hold is returned",
  },
  {
    from: "submitting",
    to: "queued",
    when: "the deployment was created; stores nosanaJobId, nosanaAccessMode and queuedAt. A submitter that loses this stops what it created",
  },
  {
    from: "submitting",
    to: "failed",
    when: "the submit failed or timed out (submit_failed), after the deployment name was looked up on Nosana and anything found was stopped or orphan-recorded",
  },
  {
    from: "submitting",
    to: "cancelling",
    when: "the user cancels while the submit is in flight; sets cancelRequestedAt",
  },
  {
    from: "queued",
    to: "running",
    when: "the poller sees the job running or the first trainer event arrives; sets startedAt (the Nosana start when known)",
  },
  {
    from: "queued",
    to: "failed",
    when: "no node within the queue timeout (no_capacity), or the deployment went to error or insufficient funds",
  },
  {
    from: "queued",
    to: "cancelling",
    when: "the user cancels; sets cancelRequestedAt",
  },
  {
    from: "running",
    to: "finalizing",
    when: "the run succeeded: exit code 0, or the trainer's `completed` event",
  },
  {
    from: "running",
    to: "failed",
    when: "the run ended any other way; classifyTrainingOutcome names it and says whether it is charged",
  },
  {
    from: "running",
    to: "cancelling",
    when: "the user cancels; sets cancelRequestedAt",
  },
  {
    from: "finalizing",
    to: "completed",
    when: "the adapter is verified in storage and the FineTunedModel row exists",
  },
  {
    from: "finalizing",
    to: "failed",
    when: "the adapter is missing or invalid; nothing is charged",
  },
  {
    from: "cancelling",
    to: "cancelled",
    when: "the stop is confirmed, or there was never a deployment to stop. A run that had already failed before the request ends here too, charged as that failure says, with its failureCode",
  },
  {
    from: "cancelling",
    to: "finalizing",
    when: "only when the run had completed BEFORE the cancel was requested (its end or the trainer's `completed` came first): it is finalised and charged as a completion",
  },
];

const ALLOWED: ReadonlySet<string> = new Set(
  TRAINING_TRANSITIONS.map((transition) => `${transition.from}>${transition.to}`),
);

export function isTrainingState(value: unknown): value is TrainingState {
  return typeof value === "string" && (TRAINING_STATES as readonly string[]).includes(value);
}

export function isTerminalTrainingState(value: unknown): value is TerminalTrainingState {
  return (
    typeof value === "string" && (TERMINAL_TRAINING_STATES as readonly string[]).includes(value)
  );
}

/** True only for a listed transition. Unknown strings are never allowed. */
export function canTransition(from: string, to: string): boolean {
  return ALLOWED.has(`${from}>${to}`);
}

/** The states `to` can be entered from: the `status: { in: [...] }` of a compare-and-set. */
export function transitionSources(to: TrainingState): TrainingState[] {
  return TRAINING_TRANSITIONS.filter((transition) => transition.to === to).map(
    (transition) => transition.from,
  );
}

/** A user may cancel from these; anywhere else the answer is 409. */
export const CANCELLABLE_TRAINING_STATES: readonly TrainingState[] = [
  "pending",
  "submitting",
  "queued",
  "running",
];

// ============================================
// Trainer events
// ============================================

/** The line prefix the trainer prints (infra/training/wheelsai_trainer/events.py). */
export const TRAINER_EVENT_PREFIX = "WHEELSAI_EVENT ";
export const TRAINER_EVENT_VERSION = 1;

/** The trainer keeps lines "well under 64 KB"; anything longer is not one of its lines. */
export const TRAINER_EVENT_MAX_CHARS = 65_536;
/** The trainer cuts messages at 500 characters. */
export const TRAINER_EVENT_MAX_MESSAGE_CHARS = 500;

export const TRAINER_PHASES = [
  "download_dataset",
  "load_model",
  "tokenize",
  "train",
  "upload",
] as const;
export type TrainerPhase = (typeof TRAINER_PHASES)[number];

export const TRAINER_STOP_REASONS = ["finished", "max_steps", "max_runtime"] as const;
export type TrainerStopReason = (typeof TRAINER_STOP_REASONS)[number];

/** Exit codes of the trainer's contract (infra/training/README.md). */
export const TRAINER_EXIT = {
  ok: 0,
  unexpected: 1,
  config: 10,
  dataset: 11,
  baseModel: 12,
  outOfMemory: 13,
  diverged: 14,
  upload: 20,
  interrupted: 30,
} as const;

/** The exit codes a `failed` event may carry. */
const FAILED_EXIT_CODES: ReadonlySet<number> = new Set([1, 10, 11, 12, 13, 14, 20, 30]);

interface TrainerEventBase {
  v: 1;
  seq: number;
  /** UTC, ISO 8601 with milliseconds, as the trainer printed it. */
  ts: string;
}

export interface TrainerStartedEvent extends TrainerEventBase {
  type: "started";
  gpu: string | null;
  vramGb: number | null;
  device: string;
  method: "lora" | "qlora";
  baseModel: string;
  trainerVersion: string;
}

export interface TrainerPhaseEvent extends TrainerEventBase {
  type: "phase";
  phase: TrainerPhase;
}

export interface TrainerStepEvent extends TrainerEventBase {
  type: "step";
  step: number;
  totalSteps: number;
  epoch: number;
  loss: number;
  lr: number;
  tokensPerSecond: number | null;
  etaSeconds: number;
}

export interface TrainerEvalEvent extends TrainerEventBase {
  type: "eval";
  step: number;
  evalLoss: number;
}

export interface TrainerUploadedEvent extends TrainerEventBase {
  type: "uploaded";
  adapterBytes: number;
  adapterSha256: string;
}

export interface TrainerCompletedEvent extends TrainerEventBase {
  type: "completed";
  finalTrainLoss: number | null;
  finalEvalLoss: number | null;
  trainSeconds: number;
  steps: number;
  totalSteps: number;
  stopReason: TrainerStopReason;
}

/** A scalar, or a short list or map of scalars: all a failure detail may be. */
export type TrainerDetailValue =
  | string
  | number
  | boolean
  | null
  | Array<string | number>
  | Record<string, string | number>;

export interface TrainerFailedEvent extends TrainerEventBase {
  type: "failed";
  exitCode: number;
  code: string;
  message: string;
  phase: TrainerPhase | null;
  /** Whatever else the trainer attached: row, field, httpStatus, step, signal... */
  details: Record<string, TrainerDetailValue>;
}

export type TrainerEvent =
  | TrainerStartedEvent
  | TrainerPhaseEvent
  | TrainerStepEvent
  | TrainerEvalEvent
  | TrainerUploadedEvent
  | TrainerCompletedEvent
  | TrainerFailedEvent;

export type TrainerTerminalEvent = TrainerCompletedEvent | TrainerFailedEvent;

export type ParseTrainerEventResult =
  | { ok: true; event: TrainerEvent; jobId: string | null }
  | { ok: false; code: "invalid_trainer_event"; message: string };

function refuse(message: string): ParseTrainerEventResult {
  return { ok: false, code: "invalid_trainer_event", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isShortString = (max: number) => (value: unknown): value is string =>
  typeof value === "string" && value.length <= max;
const nullable =
  <T>(check: (value: unknown) => value is T) =>
  (value: unknown): value is T | null =>
    value === null || check(value);
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === "string" && (values as readonly string[]).includes(value);

/** Exactly what `datetime.isoformat(timespec="milliseconds")` + "Z" prints. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DETAIL_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_FAILURE_DETAILS = 16;
const MAX_DETAIL_ITEMS = 32;
const ENVELOPE_KEYS = ["v", "seq", "ts", "type"] as const;

type FieldChecks = Record<string, (value: unknown) => boolean>;

/** The fields of each event type, and no others (`failed` also takes details). */
const EVENT_FIELDS: Record<TrainerEvent["type"], FieldChecks> = {
  started: {
    gpu: nullable(isShortString(200)),
    vramGb: nullable(isFiniteNumber),
    device: isShortString(40),
    method: oneOf(["lora", "qlora"] as const),
    baseModel: isShortString(500),
    trainerVersion: isShortString(40),
  },
  phase: { phase: oneOf(TRAINER_PHASES) },
  step: {
    step: isCount,
    totalSteps: isCount,
    epoch: isFiniteNumber,
    loss: isFiniteNumber,
    lr: isFiniteNumber,
    tokensPerSecond: nullable(isFiniteNumber),
    etaSeconds: isFiniteNumber,
  },
  eval: { step: isCount, evalLoss: isFiniteNumber },
  uploaded: {
    adapterBytes: isCount,
    adapterSha256: (value) => typeof value === "string" && SHA256_PATTERN.test(value),
  },
  completed: {
    finalTrainLoss: nullable(isFiniteNumber),
    finalEvalLoss: nullable(isFiniteNumber),
    trainSeconds: isFiniteNumber,
    steps: isCount,
    totalSteps: isCount,
    stopReason: oneOf(TRAINER_STOP_REASONS),
  },
  failed: {
    exitCode: (value) => typeof value === "number" && FAILED_EXIT_CODES.has(value),
    code: (value) => typeof value === "string" && FAILURE_CODE_PATTERN.test(value),
    message: isShortString(TRAINER_EVENT_MAX_MESSAGE_CHARS),
    phase: nullable(oneOf(TRAINER_PHASES)),
  },
};

function isDetailValue(value: unknown): value is TrainerDetailValue {
  const scalar = (item: unknown): item is string | number =>
    (typeof item === "string" && item.length <= TRAINER_EVENT_MAX_MESSAGE_CHARS) ||
    isFiniteNumber(item);
  if (value === null || typeof value === "boolean" || scalar(value)) return true;
  if (Array.isArray(value)) return value.length <= MAX_DETAIL_ITEMS && value.every(scalar);
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      entries.length <= MAX_DETAIL_ITEMS &&
      entries.every(([key, item]) => key.length <= 80 && scalar(item))
    );
  }
  return false;
}

/**
 * Parses one event object: the JSON of a WHEELSAI_EVENT line, or a callback
 * body (the same object plus "jobId").
 *
 * It accepts exactly what infra/training emits and refuses anything else: a
 * wrong version, a timestamp that is not the trainer's string form, a missing
 * or mistyped field, a field the type does not have. Only a `failed` event may
 * carry more (its details), and those are bounded scalars. A refusal is a
 * result, never a throw: the caller answers 400 or skips the line.
 */
export function parseTrainerEvent(input: unknown): ParseTrainerEventResult {
  if (!isRecord(input)) return refuse("An event is a JSON object");

  if (input.v !== TRAINER_EVENT_VERSION) return refuse("Unsupported event version");
  if (typeof input.seq !== "number" || !Number.isSafeInteger(input.seq) || input.seq < 1) {
    return refuse("seq must be a positive integer");
  }
  if (
    typeof input.ts !== "string" ||
    !TIMESTAMP_PATTERN.test(input.ts) ||
    Number.isNaN(Date.parse(input.ts))
  ) {
    return refuse("ts must be a UTC ISO 8601 string with milliseconds");
  }
  const type = input.type;
  if (typeof type !== "string" || !Object.hasOwn(EVENT_FIELDS, type)) {
    return refuse("Unknown event type");
  }
  const fields = EVENT_FIELDS[type as TrainerEvent["type"]];

  let jobId: string | null = null;
  if (Object.hasOwn(input, "jobId")) {
    if (typeof input.jobId !== "string" || input.jobId === "" || input.jobId.length > 128) {
      return refuse("jobId must be a string of at most 128 characters");
    }
    jobId = input.jobId;
  }

  for (const [name, check] of Object.entries(fields)) {
    if (!Object.hasOwn(input, name)) return refuse(`${type}: ${name} is missing`);
    if (!check(input[name])) return refuse(`${type}: ${name} is invalid`);
  }

  const known = new Set<string>([...ENVELOPE_KEYS, "jobId", ...Object.keys(fields)]);
  const extra = Object.keys(input).filter((key) => !known.has(key));
  const details: Record<string, TrainerDetailValue> = {};
  if (extra.length > 0) {
    if (type !== "failed") return refuse(`${type}: unexpected field`);
    if (extra.length > MAX_FAILURE_DETAILS) return refuse("failed: too many details");
    for (const key of extra) {
      const value = input[key];
      if (!DETAIL_KEY_PATTERN.test(key) || !isDetailValue(value)) {
        return refuse("failed: a detail is invalid");
      }
      details[key] = value;
    }
  }

  // Rebuilt field by field: the result holds what was checked and nothing else.
  const event: Record<string, unknown> = { v: 1, seq: input.seq, ts: input.ts, type };
  for (const name of Object.keys(fields)) event[name] = input[name];
  if (type === "failed") event.details = details;

  return { ok: true, event: event as unknown as TrainerEvent, jobId };
}

/**
 * Parses one line of a job's log. The line must BEGIN with the prefix: a line
 * that merely quotes one (a library error echoing dataset text, say) is not an
 * event. A trailing carriage return is tolerated; "jobId" is not, because the
 * trainer never prints it.
 */
export function parseTrainerEventLine(line: string): ParseTrainerEventResult {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!text.startsWith(TRAINER_EVENT_PREFIX)) return refuse("Not an event line");
  if (text.length > TRAINER_EVENT_MAX_CHARS) return refuse("Event line too long");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(TRAINER_EVENT_PREFIX.length));
  } catch {
    return refuse("Event line is not JSON");
  }
  if (isRecord(parsed) && Object.hasOwn(parsed, "jobId")) {
    return refuse("An event line carries no jobId");
  }
  return parseTrainerEvent(parsed);
}

/**
 * Parses a callback body. Pass the RAW body the signature was verified over.
 * A callback always names its job, and the caller must still compare that
 * name with the job the URL addresses.
 */
export function parseTrainerCallbackBody(rawBody: string): ParseTrainerEventResult {
  if (rawBody.length > TRAINER_EVENT_MAX_CHARS) return refuse("Callback body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return refuse("Callback body is not JSON");
  }
  const result = parseTrainerEvent(parsed);
  if (result.ok && result.jobId === null) return refuse("A callback names its job");
  return result;
}

/**
 * Every event in a job's log, in the order printed, for rebuilding a run whose
 * callbacks never arrived. Lines that are not events are skipped; an event
 * whose seq does not rise is dropped (a log returned twice, or a forged line
 * after the real one).
 */
export function parseTrainerEventsFromLog(log: string): TrainerEvent[] {
  const events: TrainerEvent[] = [];
  let lastSeq = 0;
  for (const line of log.split("\n")) {
    if (!line.startsWith(TRAINER_EVENT_PREFIX)) continue;
    const result = parseTrainerEventLine(line);
    if (!result.ok || result.event.seq <= lastSeq) continue;
    lastSeq = result.event.seq;
    events.push(result.event);
  }
  return events;
}

export function isTerminalTrainerEvent(event: TrainerEvent): event is TrainerTerminalEvent {
  return event.type === "completed" || event.type === "failed";
}

// ============================================
// What a finished run amounts to, and who pays
// ============================================

/**
 * Failure codes written to TrainingJob.failureCode. When the trainer's
 * `failed` event is known its own finer `code` is stored instead of the
 * generic one of the same exit code (dataset_row_invalid for dataset_error).
 */
export const TRAINING_FAILURE_CODES = {
  submit_failed: "The job could not be submitted to the GPU network",
  no_capacity: "No GPU node took the job within the queue time",
  adapter_missing: "The run reported success but no adapter was stored",
  adapter_invalid: "The stored adapter is not the one the run reported",
  nosana_error: "The GPU deployment went into an error state",
  nosana_insufficient_funds: "The GPU deployment ran out of platform funds",
  interrupted: "The run was interrupted on the node",
  no_exit_code: "The run ended without reporting how",
  killed: "The process was killed on the node",
  unexpected: "The trainer stopped with an unexpected error",
  unexpected_exit: "The trainer stopped with an exit code it does not use",
  invalid_config: "The trainer refused its configuration",
  dataset_error: "The dataset could not be used",
  dataset_download_failed: "The dataset could not be downloaded",
  base_model_error: "The base model could not be loaded",
  out_of_memory: "The run ran out of memory",
  loss_not_finite: "Training diverged: the loss was not a finite number",
  upload_failed: "The adapter could not be uploaded",
} as const;

export type TrainingFailureCode = keyof typeof TRAINING_FAILURE_CODES;

/**
 * What Nosana says about the deployment, reduced to what matters here.
 * `ended` is any normal end (the job finished or was stopped); `unknown` is
 * "could not be read".
 */
export type TrainingDeploymentState =
  | "running"
  | "ended"
  | "error"
  | "insufficient_funds"
  | "unknown";

/**
 * A finding of ours that no exit code can express. When set it decides the
 * outcome on its own, and the outcome is never charged.
 */
export type TrainingPlatformFinding =
  | "submit_failed"
  | "no_capacity"
  | "adapter_missing"
  | "adapter_invalid";

export interface TrainingOutcomeFacts {
  /** The container's exit code as Nosana reports it; null when not known. */
  exitCode: number | null;
  /** The trainer's own last word, from a callback or read back from the log. */
  terminalEvent: Pick<TrainerCompletedEvent, "type" | "stopReason"> |
    Pick<TrainerFailedEvent, "type" | "exitCode" | "code"> | null;
  deploymentState: TrainingDeploymentState;
  /**
   * The user cancelled (the row is `cancelling`, cancelRequestedAt is set)
   * and the run had not already ended before the request. A run that ended
   * first is classified by how it ended (a cancel cannot buy back or worsen
   * what already happened).
   */
  stopRequestedByUs: boolean;
  platformFinding?: TrainingPlatformFinding;
}

export type TrainingOutcome =
  | {
      status: "completed";
      failureCode: null;
      charge: "seconds_run";
      /** The trainer stopped at its run limit and handed over a partial adapter. */
      partial: boolean;
    }
  | {
      status: "cancelled";
      failureCode: null;
      /** Billed to min(end of the Nosana job, the moment the cancel was requested). */
      charge: "seconds_run";
    }
  | {
      status: "failed";
      failureCode: string;
      charge: "seconds_run" | "none";
    };

const failed = (failureCode: string, charge: "seconds_run" | "none"): TrainingOutcome => ({
  status: "failed",
  failureCode,
  charge,
});

/**
 * A failure by exit code. `code` is the trainer's finer string when its event
 * is known. The user pays only for what the data caused: a dataset the trainer
 * could not use (11) and a loss that diverged (14).
 */
function classifyExit(exitCode: number, code: string | null): TrainingOutcome {
  switch (exitCode) {
    case TRAINER_EXIT.dataset:
      // The one dataset failure the data did not cause: the URL we signed
      // expired or storage was down.
      if (code === "dataset_download_failed") return failed(code, "none");
      return failed(code ?? "dataset_error", "seconds_run");
    case TRAINER_EXIT.diverged:
      return failed(code ?? "loss_not_finite", "seconds_run");
    case TRAINER_EXIT.interrupted:
      // We did not ask for it: a cancel is decided before this is reached.
      // Not even at the user's run limit: the trainer stops itself there with
      // exit 0 and a partial adapter, so an interruption at that moment is
      // the node (Nosana's timeout after a slow image pull, say), and the
      // pull is the platform's to carry (D5).
      return failed(code ?? "interrupted", "none");
    case TRAINER_EXIT.config:
      // The API built the configuration, so a refusal of it is ours.
      return failed(code ?? "invalid_config", "none");
    case TRAINER_EXIT.baseModel:
      return failed(code ?? "base_model_error", "none");
    case TRAINER_EXIT.outOfMemory:
      // On a tier and settings the API accepted.
      return failed(code ?? "out_of_memory", "none");
    case TRAINER_EXIT.upload:
      return failed(code ?? "upload_failed", "none");
    case TRAINER_EXIT.unexpected:
      return failed(code ?? "unexpected", "none");
    case 137:
      // SIGKILL or the kernel's out-of-memory killer: no event, no cause.
      return failed("killed", "none");
    default:
      return failed("unexpected_exit", "none");
  }
}

/**
 * Decides how a run ended and whether its seconds are charged. Called once
 * the run is over (or the trainer has said its last word), with whatever
 * facts are known.
 *
 * Order of authority:
 *   1. a finding of ours (the submit failed, no node took the job, the
 *      adapter is missing or wrong): failed, charged nothing;
 *   2. a stop the user asked for: cancelled, charged the seconds run up to
 *      the request, whatever the process then reported;
 *   3. the trainer's terminal event, trusted over the exit code when both are
 *      known (a run that printed `completed` and was then killed while its
 *      callbacks drained still completed);
 *   4. the exit code alone;
 *   5. no exit code at all: charged nothing, whatever the deployment says.
 *
 * `charge: "seconds_run"` means retail price x billable seconds, capped by
 * the hold (services/trainingBilling.ts); "none" returns the whole hold.
 */
export function classifyTrainingOutcome(facts: TrainingOutcomeFacts): TrainingOutcome {
  if (facts.platformFinding) return failed(facts.platformFinding, "none");

  if (facts.stopRequestedByUs) {
    return { status: "cancelled", failureCode: null, charge: "seconds_run" };
  }

  const event = facts.terminalEvent;
  if (event?.type === "completed") {
    return {
      status: "completed",
      failureCode: null,
      charge: "seconds_run",
      partial: event.stopReason === "max_runtime",
    };
  }
  if (event?.type === "failed") {
    return classifyExit(event.exitCode, event.code);
  }

  if (facts.exitCode !== null) {
    if (facts.exitCode === TRAINER_EXIT.ok) {
      // Success with no event read: the stop reason is in metrics.json.
      return { status: "completed", failureCode: null, charge: "seconds_run", partial: false };
    }
    return classifyExit(facts.exitCode, null);
  }

  if (facts.deploymentState === "error") return failed("nosana_error", "none");
  if (facts.deploymentState === "insufficient_funds") {
    return failed("nosana_insufficient_funds", "none");
  }
  return failed("no_exit_code", "none");
}
