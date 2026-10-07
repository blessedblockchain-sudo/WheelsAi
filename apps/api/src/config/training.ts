/**
 * Configuration for fine-tuning: where training data and adapters are stored,
 * how large a dataset may be, which image trains, and the job's time rules.
 *
 * Like config/nosanaDeploy.ts this module parses its OWN environment variables
 * (it does not extend config/env.ts), so the storage layer can be configured,
 * tested and reasoned about on its own. Nothing is read at import: the first
 * call to getTrainingConfig() parses process.env, and tests pass their own
 * source to loadTrainingConfig().
 *
 * Environment variables
 * ---------------------
 *
 * STORAGE_DRIVER                      ("s3" | "local"; default: inferred)
 *   Which object store holds datasets and adapters.
 *     s3     any S3-compatible store: AWS S3, Cloudflare R2, MinIO.
 *     local  files under STORAGE_LOCAL_DIR. DEVELOPMENT ONLY: it is honoured
 *            only when NODE_ENV=development as well, the same rule as
 *            ALLOW_NOSANA_MOCK, so a deployed server can never report an
 *            upload that sits on one machine's disk.
 *   Unset means "s3 when its settings are complete, otherwise nothing", which
 *   is what the server did before this variable existed.
 *
 * STORAGE_LOCAL_DIR                   (default <os tmp>/wheelsai-object-store)
 *   Directory of the local driver. Created on first write.
 *
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / DATASETS_BUCKET
 *   All three are required for the s3 driver. Missing any of them means
 *   storage is not configured and the dataset routes answer 503
 *   dataset_storage_not_configured before any row is written.
 *
 * AWS_REGION                          (default "us-east-1", or "auto" with S3_ENDPOINT)
 *   The signing region. Cloudflare R2 expects "auto".
 *
 * S3_ENDPOINT                         (optional, an http(s) URL)
 *   Endpoint of an S3-compatible store, e.g.
 *   https://<account id>.r2.cloudflarestorage.com or http://localhost:9000.
 *   Unset means AWS S3.
 *
 * S3_FORCE_PATH_STYLE                 (default false)
 *   Address the bucket as <endpoint>/<bucket>/<key> and not as a subdomain.
 *   MinIO needs it; R2 and AWS work either way.
 *
 * TRAINING_DATASET_MAX_BYTES          (default 209715200 = 200 MB)
 * TRAINING_DATASET_MAX_ROWS           (default 200000)
 *   Largest dataset accepted. Checked when the upload is requested (413 before
 *   a URL is issued) and again against the stored object at validation.
 *
 * TRAINING_IMAGE                      (optional; unset = fine-tuning cannot start)
 *   The training image (infra/training), PINNED BY DIGEST:
 *   <registry>/<repository>@sha256:<64 hex>. A tag alone is refused: a tag
 *   can be moved, and the job would then run code nobody reviewed. Unset or
 *   malformed means POST /api/training/jobs answers 501
 *   training_image_not_configured before any row or credit moves.
 *
 * TRAINING_IMAGE_REGISTRY_SERVER / _USERNAME / _PASSWORD   (optional, all three or none)
 *   Pull credentials for a private registry. They are placed in the job
 *   definition (args.authentication.docker) and so reach the node that runs
 *   the job: use a read-only deploy token. A partial set is a refusal, not a
 *   guess.
 *
 * HF_TOKEN                            (optional)
 *   The same variable config/nosanaDeploy.ts reads. Gated base models are
 *   offered for training only when it is set.
 *
 * TRAINING_POLL_INTERVAL_MS           (default 15000; 0 disables the poller)
 *   How often non-terminal jobs are reconciled with Nosana. With the poller
 *   off nothing would ever end a job, so job creation answers 503
 *   training_poller_disabled.
 *
 * TRAINING_QUEUE_TIMEOUT_SECONDS      (default 1800)
 *   How long a submitted job may wait for a node. Queue time is free; past
 *   this the job fails (no_capacity) and nothing is charged.
 *
 * TRAINING_SETUP_ALLOWANCE_SECONDS    (default 900)
 *   Added to the user's run limit to make the Nosana timeout, so pulling the
 *   image cannot cost the user's run. The platform carries it: the hold and
 *   the charge are capped by the run limit alone. The run limit is therefore
 *   at most NOSANA_BATCH_JOB_TIMEOUT_SECONDS minus this.
 *
 * TRAINING_MAX_ACTIVE_JOBS_PER_ORG    (default 2)
 *   Jobs one organization may have in a non-terminal state at once.
 *
 * TRAINING_FREE_FAILURES_PER_DAY      (default 3)
 *   Jobs one organization may have end failed and charged nothing (out of
 *   memory, a base model that cannot be pulled, no node...) in a rolling 24
 *   hours. The platform pays for the GPU time of each, so at the limit job
 *   creation and retry answer 409 training_free_failure_limit until the
 *   oldest of them is a day old.
 *
 * TRAINING_ADAPTER_MAX_BYTES          (default 2147483648 = 2 GiB)
 *   Largest adapter archive accepted when a job is finalised (read from
 *   storage, never from what the trainer says).
 */

import os from "node:os";
import path from "node:path";
import { z } from "zod";

export class TrainingConfigError extends Error {
  constructor(message: string) {
    super(`Invalid training configuration: ${message}`);
    this.name = "TrainingConfigError";
  }
}

export interface S3StoreConfig {
  driver: "s3";
  bucket: string;
  region: string;
  /** Unset means AWS S3. */
  endpoint: string | undefined;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface LocalStoreConfig {
  driver: "local";
  /** Absolute directory every object lives under. */
  dir: string;
}

export interface NoStoreConfig {
  driver: null;
  /** Why storage is off, in words fit for a log line (never a secret). */
  reason: string;
}

export type ObjectStoreConfig = S3StoreConfig | LocalStoreConfig | NoStoreConfig;

export interface TrainingImageRegistry {
  server: string;
  username: string;
  password: string;
}

export type TrainingImageConfig =
  | { configured: true; reference: string; registry: TrainingImageRegistry | null }
  /** Why the image is unusable, in words fit for a log line (never a secret). */
  | { configured: false; reason: string };

export interface TrainingConfig {
  storage: ObjectStoreConfig;
  datasetMaxBytes: number;
  datasetMaxRows: number;
  image: TrainingImageConfig;
  /** Unset means gated base models are not offered. */
  hfToken: string | undefined;
  /** 0 = the poller is off. */
  pollIntervalMs: number;
  queueTimeoutSeconds: number;
  setupAllowanceSeconds: number;
  maxActiveJobsPerOrg: number;
  freeFailuresPerDay: number;
  adapterMaxBytes: number;
}

/**
 * <registry host>[:port]/<path>@sha256:<64 hex>, optionally with a tag before
 * the digest. Lower case only, as registries require. Also the pattern the
 * job definition re-checks before the reference is placed in it.
 */
export const TRAINING_IMAGE_PATTERN =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?@sha256:[a-f0-9]{64}$/;

/** A registry host, with an optional port. */
export const TRAINING_REGISTRY_SERVER_PATTERN =
  /^(?:https:\/\/)?[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/;

/** Shortest run limit offered. The trainer itself refuses less than 60. */
export const TRAINING_MIN_RUNTIME_SECONDS = 300;

/** Longest a presigned URL may live (the S3 signature limit). */
export const TRAINING_TRANSFER_URL_MAX_TTL_SECONDS = 7 * 86_400;

/** Slack on top of queue + run + allowance: the final upload and clock skew. */
export const TRAINING_TRANSFER_URL_MARGIN_SECONDS = 3_600;

const intFromEnv = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

const boolFromEnv = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const rawSchema = z.object({
  NODE_ENV: z.string().default("development"),
  STORAGE_DRIVER: z.enum(["s3", "local"]).optional(),
  STORAGE_LOCAL_DIR: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  DATASETS_BUCKET: z.string().optional(),
  S3_ENDPOINT: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "must be an http(s) URL")
    .optional(),
  S3_FORCE_PATH_STYLE: boolFromEnv,
  // 1 KiB .. 5 GiB (a single PUT cannot be larger on S3 anyway).
  TRAINING_DATASET_MAX_BYTES: intFromEnv(1_024, 5 * 1024 ** 3).default(200 * 1024 ** 2),
  TRAINING_DATASET_MAX_ROWS: intFromEnv(1, 50_000_000).default(200_000),
  TRAINING_IMAGE: z.string().optional(),
  TRAINING_IMAGE_REGISTRY_SERVER: z.string().optional(),
  TRAINING_IMAGE_REGISTRY_USERNAME: z.string().optional(),
  TRAINING_IMAGE_REGISTRY_PASSWORD: z.string().optional(),
  HF_TOKEN: z.string().optional(),
  // 0 turns the poller off; otherwise 1 s .. 10 min.
  TRAINING_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .refine((value) => value === 0 || (value >= 1_000 && value <= 600_000), {
      message: "must be 0 (off) or between 1000 and 600000",
    })
    .default(15_000),
  TRAINING_QUEUE_TIMEOUT_SECONDS: intFromEnv(60, 86_400).default(1_800),
  TRAINING_SETUP_ALLOWANCE_SECONDS: intFromEnv(0, 7_200).default(900),
  TRAINING_MAX_ACTIVE_JOBS_PER_ORG: intFromEnv(1, 100).default(2),
  TRAINING_FREE_FAILURES_PER_DAY: intFromEnv(1, 1_000).default(3),
  // 1 MiB .. 5 GiB (the largest single PUT on S3).
  TRAINING_ADAPTER_MAX_BYTES: intFromEnv(1024 ** 2, 5 * 1024 ** 3).default(2 * 1024 ** 3),
});

/**
 * An unusable image setting never throws: the storage half of this config
 * must keep working, and job creation answers 501 with the reason.
 */
function resolveImage(raw: z.infer<typeof rawSchema>): TrainingImageConfig {
  if (!raw.TRAINING_IMAGE) return { configured: false, reason: "TRAINING_IMAGE not set" };
  if (raw.TRAINING_IMAGE.length > 512 || !TRAINING_IMAGE_PATTERN.test(raw.TRAINING_IMAGE)) {
    return {
      configured: false,
      reason: "TRAINING_IMAGE must be pinned by digest (<registry>/<repository>@sha256:<64 hex>)",
    };
  }

  const parts = {
    TRAINING_IMAGE_REGISTRY_SERVER: raw.TRAINING_IMAGE_REGISTRY_SERVER,
    TRAINING_IMAGE_REGISTRY_USERNAME: raw.TRAINING_IMAGE_REGISTRY_USERNAME,
    TRAINING_IMAGE_REGISTRY_PASSWORD: raw.TRAINING_IMAGE_REGISTRY_PASSWORD,
  };
  const set = Object.entries(parts).filter(([, value]) => value !== undefined);
  if (set.length === 0) {
    return { configured: true, reference: raw.TRAINING_IMAGE, registry: null };
  }
  if (set.length < 3) {
    const missing = Object.entries(parts)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    return { configured: false, reason: `${missing.join(", ")} not set (all three or none)` };
  }
  if (!TRAINING_REGISTRY_SERVER_PATTERN.test(parts.TRAINING_IMAGE_REGISTRY_SERVER!)) {
    return { configured: false, reason: "TRAINING_IMAGE_REGISTRY_SERVER is not a registry host" };
  }
  return {
    configured: true,
    reference: raw.TRAINING_IMAGE,
    registry: {
      server: parts.TRAINING_IMAGE_REGISTRY_SERVER!,
      username: parts.TRAINING_IMAGE_REGISTRY_USERNAME!,
      password: parts.TRAINING_IMAGE_REGISTRY_PASSWORD!,
    },
  };
}

function resolveStorage(raw: z.infer<typeof rawSchema>): ObjectStoreConfig {
  if (raw.STORAGE_DRIVER === "local") {
    // Fail closed: outside development the local driver does not exist, and
    // it does not silently fall back to a bucket the operator did not pick.
    if (raw.NODE_ENV !== "development") {
      return {
        driver: null,
        reason: "STORAGE_DRIVER=local is honoured only when NODE_ENV=development",
      };
    }
    const dir = raw.STORAGE_LOCAL_DIR ?? path.join(os.tmpdir(), "wheelsai-object-store");
    return { driver: "local", dir: path.resolve(dir) };
  }

  const missing = [
    !raw.AWS_ACCESS_KEY_ID && "AWS_ACCESS_KEY_ID",
    !raw.AWS_SECRET_ACCESS_KEY && "AWS_SECRET_ACCESS_KEY",
    !raw.DATASETS_BUCKET && "DATASETS_BUCKET",
  ].filter((name): name is string => Boolean(name));
  if (missing.length > 0) {
    return { driver: null, reason: `${missing.join(", ")} not set` };
  }

  return {
    driver: "s3",
    bucket: raw.DATASETS_BUCKET!,
    region: raw.AWS_REGION ?? (raw.S3_ENDPOINT ? "auto" : "us-east-1"),
    endpoint: raw.S3_ENDPOINT,
    forcePathStyle: raw.S3_FORCE_PATH_STYLE,
    accessKeyId: raw.AWS_ACCESS_KEY_ID!,
    secretAccessKey: raw.AWS_SECRET_ACCESS_KEY!,
  };
}

export function loadTrainingConfig(
  source: Record<string, string | undefined> = process.env,
): TrainingConfig {
  // Empty strings (e.g. `FOO=` in a .env file) mean "unset".
  const cleaned: Record<string, string | undefined> = {};
  for (const key of Object.keys(rawSchema.shape)) {
    const value = source[key];
    cleaned[key] = value === undefined || value.trim() === "" ? undefined : value.trim();
  }

  const parsed = rawSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TrainingConfigError(
      `${issue?.path.join(".") ?? "config"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  const raw = parsed.data;

  return {
    storage: resolveStorage(raw),
    datasetMaxBytes: raw.TRAINING_DATASET_MAX_BYTES,
    datasetMaxRows: raw.TRAINING_DATASET_MAX_ROWS,
    image: resolveImage(raw),
    hfToken: raw.HF_TOKEN,
    pollIntervalMs: raw.TRAINING_POLL_INTERVAL_MS,
    queueTimeoutSeconds: raw.TRAINING_QUEUE_TIMEOUT_SECONDS,
    setupAllowanceSeconds: raw.TRAINING_SETUP_ALLOWANCE_SECONDS,
    maxActiveJobsPerOrg: raw.TRAINING_MAX_ACTIVE_JOBS_PER_ORG,
    freeFailuresPerDay: raw.TRAINING_FREE_FAILURES_PER_DAY,
    adapterMaxBytes: raw.TRAINING_ADAPTER_MAX_BYTES,
  };
}

// ============================================
// Time: the run limit, the Nosana timeout, URL lifetimes
// ============================================

export interface TrainingRunLimitBounds {
  minSeconds: number;
  /** Below minSeconds when the batch timeout leaves no room: nothing can run. */
  maxSeconds: number;
}

/**
 * The run limits a user may choose. The Nosana timeout of a job is the run
 * limit plus the set-up allowance and may not pass the batch job timeout
 * (NOSANA_BATCH_JOB_TIMEOUT_SECONDS, config/nosanaDeploy.ts), so the allowance
 * comes off the top.
 */
export function trainingRunLimitBounds(
  config: Pick<TrainingConfig, "setupAllowanceSeconds">,
  batchJobTimeoutSeconds: number,
): TrainingRunLimitBounds {
  return {
    minSeconds: TRAINING_MIN_RUNTIME_SECONDS,
    maxSeconds: Math.floor(batchJobTimeoutSeconds) - config.setupAllowanceSeconds,
  };
}

/** The Nosana timeout of a job: the user's run limit plus the allowance. */
export function trainingNosanaTimeoutSeconds(
  config: Pick<TrainingConfig, "setupAllowanceSeconds">,
  maxRuntimeSeconds: number,
): number {
  return maxRuntimeSeconds + config.setupAllowanceSeconds;
}

/**
 * How long the dataset download URL and the adapter and metrics upload URLs
 * of a job must live: it may queue for the whole queue timeout, then run for
 * the whole Nosana timeout, and uploads at the very end. Capped at seven
 * days, the longest a presigned URL can be signed for.
 */
export function trainingTransferUrlTtlSeconds(
  config: Pick<TrainingConfig, "queueTimeoutSeconds" | "setupAllowanceSeconds">,
  maxRuntimeSeconds: number,
): number {
  return Math.min(
    TRAINING_TRANSFER_URL_MAX_TTL_SECONDS,
    config.queueTimeoutSeconds +
      maxRuntimeSeconds +
      config.setupAllowanceSeconds +
      TRAINING_TRANSFER_URL_MARGIN_SECONDS,
  );
}

let cached: TrainingConfig | null = null;

/** Process-wide config, parsed once from process.env on first use. */
export function getTrainingConfig(): TrainingConfig {
  if (!cached) cached = loadTrainingConfig(process.env);
  return cached;
}

/** Test seam: drop the cached parse so the next call re-reads process.env. */
export function resetTrainingConfigForTests(): void {
  cached = null;
}
