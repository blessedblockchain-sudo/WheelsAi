/**
 * Configuration for fine-tuning: where training data and adapters are stored,
 * and how large a dataset may be.
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
 * The job service of the next build adds its own settings here (the training
 * image, the poller cadence, queue timeout, per-organization job limit): add
 * the variable to rawSchema, the field to TrainingConfig and the mapping in
 * loadTrainingConfig.
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

export interface TrainingConfig {
  storage: ObjectStoreConfig;
  datasetMaxBytes: number;
  datasetMaxRows: number;
}

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
});

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
  };
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
