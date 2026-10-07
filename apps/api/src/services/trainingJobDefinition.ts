/**
 * The Nosana job definition of a training run, and the hyperparameters the
 * trainer accepts.
 *
 * The contract is infra/training/README.md: fourteen environment variables
 * and no others, no command (the image's ENTRYPOINT runs), one container, one
 * GPU. HYPERPARAMS carries only the keys the trainer knows, because it
 * refuses a run over an unknown key (exit 10, unknown_hyperparameter).
 *
 * Nothing is interpolated into a shell here: every value travels as an
 * environment variable. Each one is still checked against a strict pattern
 * before it is placed in the definition, so a value from a user or from
 * storage that is not what it claims to be is refused here and not on a node
 * the user is paying for.
 *
 * The definition holds credentials (the callback secret, signed URLs, the
 * Hugging Face token, registry credentials). It must only ever be submitted
 * as a confidential job and must never be logged.
 *
 * Pure: no clock, no environment, no I/O.
 */

import { TRAINING_IMAGE_PATTERN, TRAINING_REGISTRY_SERVER_PATTERN } from "../config/training.js";

// ============================================
// Hyperparameters
// ============================================

/** The keys of HYPERPARAMS, as infra/training/README.md lists them. */
export interface TrainingHyperparams {
  epochs?: number;
  batchSize?: number;
  gradientAccumulationSteps?: number;
  learningRate?: number;
  warmupRatio?: number;
  loraR?: number;
  loraAlpha?: number;
  loraDropout?: number;
  targetModules?: "all-linear" | string[];
  maxSeqLength?: number;
  maxSteps?: number | null;
  evalSplit?: number | null;
  seed?: number;
}

/** What the trainer uses for a key that is not sent. */
export const TRAINING_HYPERPARAM_DEFAULTS = {
  epochs: 3,
  batchSize: 4,
  gradientAccumulationSteps: 4,
  learningRate: 2e-4,
  warmupRatio: 0.03,
  loraR: 16,
  loraAlpha: 32,
  loraDropout: 0.05,
  targetModules: "all-linear",
  maxSeqLength: 1024,
  maxSteps: null,
  evalSplit: null,
  seed: 42,
} as const satisfies Required<TrainingHyperparams>;

export const TRAINING_LORA_RANKS = [4, 8, 16, 32, 64] as const;

/** Inclusive bounds, the same as the trainer's. A page may show them. */
export const TRAINING_HYPERPARAM_BOUNDS = {
  epochs: { min: 1, max: 10, integer: true },
  batchSize: { min: 1, max: 16, integer: true },
  gradientAccumulationSteps: { min: 1, max: 32, integer: true },
  learningRate: { min: 1e-6, max: 1e-3, integer: false },
  warmupRatio: { min: 0, max: 0.2, integer: false },
  loraAlpha: { min: 1, max: 128, integer: true },
  loraDropout: { min: 0, max: 0.3, integer: false },
  maxSeqLength: { min: 128, max: 4096, integer: true },
  maxSteps: { min: 1, max: 20_000, integer: true },
  evalSplit: { min: 0, max: 0.2, integer: false },
  seed: { min: 0, max: 2_147_483_647, integer: true },
} as const;

const TARGET_MODULE_PATTERN = /^[a-z_]+$/;
const MAX_TARGET_MODULES = 12;
/** Keys that may be sent as null ("let the trainer decide"). */
const NULLABLE_HYPERPARAMS: ReadonlySet<string> = new Set(["maxSteps", "evalSplit"]);
const HYPERPARAM_KEYS: ReadonlySet<string> = new Set(Object.keys(TRAINING_HYPERPARAM_DEFAULTS));

export type ValidateHyperparamsResult =
  | { ok: true; hyperparams: TrainingHyperparams }
  | {
      ok: false;
      code: "unknown_hyperparameter" | "invalid_hyperparameter";
      field: string;
      message: string;
    };

function inBounds(
  value: unknown,
  bounds: { min: number; max: number; integer: boolean },
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!bounds.integer || Number.isInteger(value)) &&
    value >= bounds.min &&
    value <= bounds.max
  );
}

/**
 * Checks a HYPERPARAMS object against the trainer's own rules and returns it
 * with only the keys that were given: nothing is defaulted here, so what is
 * stored and sent is what was asked for and the trainer's defaults stay the
 * trainer's. An unknown key is refused, never dropped: silently ignoring
 * `quantizationBits` would train something other than what was asked.
 */
export function validateTrainingHyperparams(input: unknown): ValidateHyperparamsResult {
  if (input === undefined || input === null) return { ok: true, hyperparams: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      code: "invalid_hyperparameter",
      field: "hyperparams",
      message: "Hyperparameters must be an object",
    };
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!HYPERPARAM_KEYS.has(key)) {
      return {
        ok: false,
        code: "unknown_hyperparameter",
        // The key is the caller's text: it is echoed only when it is harmless.
        field: /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) ? key : "hyperparams",
        message: "Unknown hyperparameter",
      };
    }
    const invalid = (message: string): ValidateHyperparamsResult => ({
      ok: false,
      code: "invalid_hyperparameter",
      field: key,
      message,
    });

    if (value === null) {
      if (!NULLABLE_HYPERPARAMS.has(key)) return invalid(`${key} cannot be null`);
      out[key] = null;
      continue;
    }

    if (key === "loraR") {
      if (!(TRAINING_LORA_RANKS as readonly unknown[]).includes(value)) {
        return invalid(`loraR must be one of ${TRAINING_LORA_RANKS.join(", ")}`);
      }
    } else if (key === "targetModules") {
      if (value !== "all-linear") {
        const names = value;
        if (
          !Array.isArray(names) ||
          names.length < 1 ||
          names.length > MAX_TARGET_MODULES ||
          !names.every(
            (name) => typeof name === "string" && name.length <= 64 && TARGET_MODULE_PATTERN.test(name),
          ) ||
          new Set(names).size !== names.length
        ) {
          return invalid(
            `targetModules must be "all-linear" or 1-${MAX_TARGET_MODULES} distinct names of lower-case letters and underscores`,
          );
        }
      }
    } else {
      const bounds = TRAINING_HYPERPARAM_BOUNDS[key as keyof typeof TRAINING_HYPERPARAM_BOUNDS];
      if (!inBounds(value, bounds)) {
        return invalid(
          `${key} must be ${bounds.integer ? "a whole number" : "a number"} from ${bounds.min} to ${bounds.max}`,
        );
      }
    }
    out[key] = value;
  }
  return { ok: true, hyperparams: out as TrainingHyperparams };
}

/** The values a run will use: what was sent, over the trainer's defaults. */
export function resolveTrainingHyperparams(
  hyperparams: TrainingHyperparams,
): Required<TrainingHyperparams> {
  const resolved: Record<string, unknown> = { ...TRAINING_HYPERPARAM_DEFAULTS };
  for (const [key, value] of Object.entries(hyperparams)) {
    if (value !== undefined) resolved[key] = value;
  }
  return resolved as Required<TrainingHyperparams>;
}

// ============================================
// Names
// ============================================

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBMIT_NONCE_PATTERN = /^[a-z0-9]{8,32}$/;

/**
 * The deployment name of one submit attempt. Deterministic, so a submit that
 * failed or timed out without an id can look its deployment up on Nosana by
 * name (findDeploymentByName) and stop it. Null when either part is not what
 * it should be.
 */
export function trainingDeploymentName(jobId: string, submitNonce: string): string | null {
  if (!UUID_PATTERN.test(jobId) || !SUBMIT_NONCE_PATTERN.test(submitNonce)) return null;
  return `wheelsai-train-${jobId}-${submitNonce}`;
}

// ============================================
// The definition
// ============================================

export const TRAINING_DATASET_FORMATS = ["alpaca", "sharegpt", "completion", "text", "auto"] as const;
export const TRAINING_DATASET_FILE_TYPES = ["jsonl", "csv", "parquet"] as const;

/** The trainer refuses a limit under 60 seconds. */
const TRAINER_MIN_RUNTIME_SECONDS = 60;
const MAX_URL_CHARS = 4_096;

export interface TrainingJobDefinitionInput {
  /** TRAINING_IMAGE: pinned by digest. */
  image: string;
  /** Pull credentials, only when the registry is private. */
  registry?: { server: string; username: string; password: string } | null;
  /** GB of GPU memory the node must have (the catalog's figure for the method). */
  requiredVramGb: number;

  jobId: string;
  /** The Hugging Face id of the base model. */
  baseModelHfId: string;
  hfToken?: string | null;
  method: string;

  datasetUrl: string;
  /** Dataset.schemaFormat, or "auto". */
  datasetFormat: string;
  /** Dataset.fileType. */
  datasetFileType: string;
  /** Dataset.contentSha256: the run is pinned to these bytes. Required. */
  datasetSha256: string;

  adapterUploadUrl: string;
  metricsUploadUrl: string;
  callbackUrl: string;
  callbackSecret: string;

  /** Already through validateTrainingHyperparams, or raw: it is checked again. */
  hyperparams: unknown;
  /** The user's run limit: the trainer's MAX_RUNTIME_SECONDS. */
  maxRuntimeSeconds: number;
}

/** The environment of the container contract: these fourteen names and no others. */
export const TRAINER_ENV_NAMES = [
  "JOB_ID",
  "BASE_MODEL",
  "HF_TOKEN",
  "METHOD",
  "DATASET_URL",
  "DATASET_FORMAT",
  "DATASET_FILE_TYPE",
  "DATASET_SHA256",
  "ADAPTER_UPLOAD_URL",
  "METRICS_UPLOAD_URL",
  "CALLBACK_URL",
  "CALLBACK_SECRET",
  "HYPERPARAMS",
  "MAX_RUNTIME_SECONDS",
] as const;

export type TrainerEnv = Partial<Record<(typeof TRAINER_ENV_NAMES)[number], string>>;

export interface TrainingJobDefinition {
  version: "0.1";
  type: "container";
  meta: { trigger: "wheelsai-training" };
  ops: [
    {
      type: "container/run";
      id: "train";
      args: {
        image: string;
        gpu: true;
        required_vram: number;
        env: Record<string, string>;
        authentication?: { docker: { username: string; password: string; server: string } };
      };
    },
  ];
}

export type BuildTrainingJobDefinitionResult =
  | { ok: true; definition: TrainingJobDefinition; hyperparams: TrainingHyperparams }
  | {
      ok: false;
      code: "invalid_training_input" | "unknown_hyperparameter" | "invalid_hyperparameter";
      /** The input that failed. Never its value: it may be a credential. */
      field: string;
      message: string;
    };

/** <owner>/<name> on Hugging Face. No local paths, no revisions, no ".." */
const HF_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** Tokens and derived secrets: letters, digits and the punctuation tokens use. */
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=_-]{8,512}$/;
/** A registry password: printable ASCII with no space, quote, backslash, backtick or dollar. */
const REGISTRY_PASSWORD_PATTERN = /^(?!.*["'`\\$])[\x21-\x7e]{1,512}$/;
const REGISTRY_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

/**
 * An absolute http(s) URL with nothing a URL should not hold: no whitespace,
 * control character, quote, backslash or backtick anywhere, and no user:pass@
 * part. http is allowed beside https for the development storage driver, as
 * the trainer itself allows.
 */
function isTransferUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS) return false;
  // Code points 0x21..0x7E only, minus the characters that end a quoted string.
  if (!/^[\x21-\x7e]+$/.test(value) || /["'`\\<>{}|^]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname !== "" && url.username === "" && url.password === "";
}

/**
 * Builds the definition, or says which input is not acceptable. A refusal is
 * a result, never a throw, and names the field without quoting it.
 */
export function buildTrainingJobDefinition(
  input: TrainingJobDefinitionInput,
): BuildTrainingJobDefinitionResult {
  const refuse = (field: string, message: string): BuildTrainingJobDefinitionResult => ({
    ok: false,
    code: "invalid_training_input",
    field,
    message,
  });

  if (typeof input.image !== "string" || input.image.length > 512 || !TRAINING_IMAGE_PATTERN.test(input.image)) {
    return refuse("image", "The training image must be a reference pinned by digest");
  }
  const registry = input.registry ?? null;
  if (registry) {
    if (typeof registry.server !== "string" || !TRAINING_REGISTRY_SERVER_PATTERN.test(registry.server)) {
      return refuse("registry.server", "The registry server is not a registry host");
    }
    if (typeof registry.username !== "string" || !REGISTRY_USERNAME_PATTERN.test(registry.username)) {
      return refuse("registry.username", "The registry user name is not valid");
    }
    if (typeof registry.password !== "string" || !REGISTRY_PASSWORD_PATTERN.test(registry.password)) {
      return refuse("registry.password", "The registry password is not valid");
    }
  }
  if (
    !Number.isInteger(input.requiredVramGb) ||
    input.requiredVramGb < 1 ||
    input.requiredVramGb > 1_024
  ) {
    return refuse("requiredVramGb", "The GPU memory requirement must be a whole number of GB");
  }

  if (typeof input.jobId !== "string" || !UUID_PATTERN.test(input.jobId)) {
    return refuse("jobId", "The job id is not a UUID");
  }
  if (
    typeof input.baseModelHfId !== "string" ||
    !HF_MODEL_ID_PATTERN.test(input.baseModelHfId) ||
    input.baseModelHfId.includes("..")
  ) {
    return refuse("baseModelHfId", "The base model is not a Hugging Face model id");
  }
  const hfToken = input.hfToken ?? null;
  if (hfToken !== null && (typeof hfToken !== "string" || !TOKEN_PATTERN.test(hfToken))) {
    return refuse("hfToken", "The Hugging Face token is not valid");
  }
  if (input.method !== "lora" && input.method !== "qlora") {
    return refuse("method", "Only LoRA and QLoRA are offered");
  }

  if (!isTransferUrl(input.datasetUrl)) return refuse("datasetUrl", "The dataset URL is not valid");
  if (!(TRAINING_DATASET_FORMATS as readonly string[]).includes(input.datasetFormat)) {
    return refuse("datasetFormat", "The dataset format is not one the trainer reads");
  }
  if (!(TRAINING_DATASET_FILE_TYPES as readonly string[]).includes(input.datasetFileType)) {
    return refuse("datasetFileType", "The dataset file type is not one the trainer reads");
  }
  if (typeof input.datasetSha256 !== "string" || !SHA256_PATTERN.test(input.datasetSha256)) {
    return refuse("datasetSha256", "The dataset has no content hash to pin the run to");
  }

  if (!isTransferUrl(input.adapterUploadUrl)) {
    return refuse("adapterUploadUrl", "The adapter upload URL is not valid");
  }
  if (!isTransferUrl(input.metricsUploadUrl)) {
    return refuse("metricsUploadUrl", "The metrics upload URL is not valid");
  }
  if (!isTransferUrl(input.callbackUrl)) return refuse("callbackUrl", "The callback URL is not valid");
  if (typeof input.callbackSecret !== "string" || !TOKEN_PATTERN.test(input.callbackSecret)) {
    return refuse("callbackSecret", "The callback secret is not valid");
  }

  if (
    !Number.isInteger(input.maxRuntimeSeconds) ||
    input.maxRuntimeSeconds < TRAINER_MIN_RUNTIME_SECONDS ||
    input.maxRuntimeSeconds > 7 * 86_400
  ) {
    return refuse("maxRuntimeSeconds", "The run limit must be a whole number of seconds, 60 or more");
  }

  const checked = validateTrainingHyperparams(input.hyperparams);
  if (!checked.ok) return checked;

  const env: Record<string, string> = {
    JOB_ID: input.jobId,
    BASE_MODEL: input.baseModelHfId,
    METHOD: input.method,
    DATASET_URL: input.datasetUrl,
    DATASET_FORMAT: input.datasetFormat,
    DATASET_FILE_TYPE: input.datasetFileType,
    DATASET_SHA256: input.datasetSha256,
    ADAPTER_UPLOAD_URL: input.adapterUploadUrl,
    METRICS_UPLOAD_URL: input.metricsUploadUrl,
    CALLBACK_URL: input.callbackUrl,
    CALLBACK_SECRET: input.callbackSecret,
    HYPERPARAMS: JSON.stringify(checked.hyperparams),
    MAX_RUNTIME_SECONDS: String(input.maxRuntimeSeconds),
  };
  // Present only when there is a token: an empty HF_TOKEN is not "no token".
  if (hfToken !== null) env.HF_TOKEN = hfToken;

  return {
    ok: true,
    hyperparams: checked.hyperparams,
    definition: {
      version: "0.1",
      type: "container",
      meta: { trigger: "wheelsai-training" },
      ops: [
        {
          type: "container/run",
          id: "train",
          args: {
            image: input.image,
            gpu: true,
            required_vram: input.requiredVramGb,
            env,
            ...(registry
              ? {
                  authentication: {
                    docker: {
                      username: registry.username,
                      password: registry.password,
                      server: registry.server,
                    },
                  },
                }
              : {}),
          },
        },
      ],
    },
  };
}
