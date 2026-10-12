/**
 * /api/training: datasets, and fine-tuning jobs.
 *
 * The job routes are thin: every rule (the refusal order, the hold, the
 * state machine, who pays) lives in services/trainingJobs.ts and is reached
 * through injected dependencies, so the routes can be driven in a test with
 * no database, no Nosana and no object store.
 *
 * One route has no session: POST /jobs/:jobId/events, which the training
 * container calls. It is authenticated by an HMAC over the raw body
 * (services/trainingWebhookAuth.ts) and has its own body parser, scoped to
 * it, that hands the bytes over unparsed.
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { trainableTiers, findTrainableModel, isTrainingMethod } from "../config/trainingCatalog.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { buildDatasetDeps } from "../services/buildDatasetDeps.js";
import { buildTrainingDeps } from "../services/buildTrainingDeps.js";
import {
  createDataset,
  deleteDataset,
  describeDatasetStorage,
  serializeDataset,
  serializeDatasetDetail,
  validateStoredDataset,
  type DatasetDeps,
} from "../services/dataset.js";
import {
  cancelTrainingJob,
  createTrainingJob,
  describeTrainingCapabilities,
  estimateTrainingJob,
  getTrainingJobDetail,
  getTrainingJobLogs,
  listTrainingJobs,
  listTrainingModels,
  recordTrainingEvent,
  retryTrainingJob,
  type CreateTrainingJobResult,
  type TrainingDeps,
  type TrainingJobInput,
  type TrainingRefusal,
} from "../services/trainingJobs.js";
import { TRAINING_STATES } from "../services/trainingStateMachine.js";
import {
  TRAINING_CALLBACK_MAX_BYTES,
  TRAINING_CALLBACK_SIGNATURE_HEADER,
} from "../services/trainingWebhookAuth.js";
import { replaceJsonBodyParser } from "./emptyJsonBody.js";

// ============================================
// Schemas
// ============================================

const createDatasetSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  fileName: z.string().min(1).max(255),
  // The exact size of the file about to be uploaded: the limit is checked
  // against it before a URL is issued, and the URL is good for that size only.
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  // Rows the client counted before uploading, when it did.
  rowCount: z.number().int().nonnegative().optional(),
  // How the file is encoded. Defaults to the file name's extension.
  fileType: z.enum(["jsonl", "csv", "parquet"]).optional(),
  contentType: z.string().max(100).optional(),
  // What the uploader declares; stored as given and never overwritten.
  format: z
    .enum(["jsonl", "csv", "parquet", "alpaca", "sharegpt", "completion", "text"])
    .optional(),
});

/**
 * What a job is made of. `method` and `gpuTier` are plain strings here: the
 * service refuses "full", an unknown tier and more than one GPU by name, in
 * the documented order, which a schema error would pre-empt.
 */
const jobChoiceShape = {
  baseModelId: z.string().min(1).max(100),
  datasetId: z.string().uuid(),
  method: z.string().min(1).max(20).default("lora"),
  gpuCount: z.number().int().min(1).max(64).optional(),
  // The run limit, in either unit (not both).
  maxRuntimeSeconds: z.number().int().positive().max(7 * 86_400).optional(),
  maxRuntimeMinutes: z.number().int().positive().max(7 * 1_440).optional(),
  // The trainer's hyperparameters. `config` is the older name of the same object.
  hyperparams: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
};

const createTrainingJobSchema = z.object({
  name: z.string().trim().min(1).max(100),
  gpuTier: z.string().min(1).max(40),
  ...jobChoiceShape,
});

const estimateSchema = z.object({
  // Omitted = the cheapest tier the model and method fit on.
  gpuTier: z.string().min(1).max(40).optional(),
  // Shorthand for hyperparams.epochs.
  epochs: z.number().int().optional(),
  ...jobChoiceShape,
});

const jobIdParams = z.object({ jobId: z.string().uuid() });

type JobChoice = z.infer<z.ZodObject<typeof jobChoiceShape>>;

/** The two spellings of the run limit and of the hyperparameters, as one input. */
function jobChoice(
  body: JobChoice,
): { ok: true; maxRuntimeSeconds: number | undefined; hyperparams: Record<string, unknown> | undefined } | TrainingRefusal {
  if (body.maxRuntimeSeconds !== undefined && body.maxRuntimeMinutes !== undefined) {
    return {
      ok: false,
      status: 400,
      code: "invalid_run_limit",
      message: "Send maxRuntimeSeconds or maxRuntimeMinutes, not both.",
    };
  }
  if (body.hyperparams !== undefined && body.config !== undefined) {
    return {
      ok: false,
      status: 400,
      code: "invalid_hyperparameter",
      message: "Send hyperparams or config, not both.",
    };
  }
  return {
    ok: true,
    maxRuntimeSeconds:
      body.maxRuntimeSeconds ??
      (body.maxRuntimeMinutes !== undefined ? body.maxRuntimeMinutes * 60 : undefined),
    hyperparams: body.hyperparams ?? body.config,
  };
}

function refusalBody(refusal: TrainingRefusal) {
  return { error: refusal.code, message: refusal.message, ...refusal.extra };
}

function createdBody(result: Extract<CreateTrainingJobResult, { ok: true }>) {
  return {
    job: { id: result.job.id, name: result.job.name, status: result.job.status },
    // What was held: the most this job can cost. The unused part comes back
    // when the job ends.
    reservation: result.reservation,
    estimate: result.estimate,
    message: "Training job created. It is being submitted to the GPU network.",
  };
}

// ============================================
// Routes
// ============================================

export interface TrainingRouteDeps {
  training: TrainingDeps;
  datasets: DatasetDeps;
  /** The session check of the authenticated routes. Default: requireAuth. */
  auth?: preHandlerHookHandler;
}

export function createTrainingRoutes(deps: TrainingRouteDeps): FastifyPluginAsync {
  const training = deps.training;
  const datasetDeps = deps.datasets;
  const auth: preHandlerHookHandler = deps.auth ?? (requireAuth as preHandlerHookHandler);

  return async (app) => {
  // ============================================
  // Datasets
  // ============================================

  /**
   * List datasets
   */
  app.get("/datasets", { preHandler: [auth] }, async (request, _reply) => {
    const { orgId } = request.auth!;

    const datasets = await datasetDeps.db.list(orgId);

    return {
      datasets: datasets.map(serializeDataset),
      total: datasets.length,
      // Whether an upload can be offered at all, and how large it may be.
      storage: describeDatasetStorage(datasetDeps),
    };
  });

  /**
   * Get dataset details
   */
  app.get("/datasets/:datasetId", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { datasetId } = z.object({ datasetId: z.string().uuid() }).parse(request.params);

    const dataset = await datasetDeps.db.find(orgId, datasetId);

    if (!dataset) {
      return reply.notFound("Dataset not found");
    }

    return { dataset: serializeDatasetDetail(dataset) };
  });

  /**
   * Create dataset (get upload URL)
   *
   * Refused before a URL is issued or a row written: 503
   * dataset_storage_not_configured, 400 unsupported_file_type, 413
   * dataset_too_large / dataset_too_many_rows, 409 dataset_name_taken.
   */
  app.post("/datasets", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const body = createDatasetSchema.parse(request.body);

    const result = await createDataset(datasetDeps, orgId, body);
    if (!result.ok) {
      return reply.status(result.status).send(result.body);
    }

    reply.status(201);
    return {
      dataset: {
        id: result.dataset.id,
        name: result.dataset.name,
        fileType: result.dataset.fileType,
      },
      upload: {
        url: result.upload.url,
        method: result.upload.method,
        // Send these with the upload, exactly: the link is signed for them.
        headers: result.upload.headers,
        expiresAt: result.upload.expiresAt,
        maxBytes: result.upload.maxBytes,
      },
      message: "Upload your dataset using the provided URL, then call POST /datasets/:id/validate",
    };
  });

  /**
   * Validate uploaded dataset
   *
   * Reads the whole stored file. Refusals: 404, 409 dataset_not_uploaded,
   * 413 dataset_too_large / dataset_too_many_rows (the file is removed),
   * 503 dataset_storage_not_configured / dataset_storage_unavailable.
   */
  app.post("/datasets/:datasetId/validate", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { datasetId } = z.object({ datasetId: z.string().uuid() }).parse(request.params);

    const result = await validateStoredDataset(datasetDeps, orgId, datasetId);
    if (!result.ok) {
      return reply.status(result.status).send(result.body);
    }
    const { validation } = result;

    return {
      validation: {
        isValid: validation.isValid,
        format: validation.format,
        fileType: validation.fileType,
        schemaFormat: validation.schemaFormat,
        detectedFormat: validation.schemaFormat,
        rowCount: validation.rowCount,
        sizeBytes: validation.sizeBytes,
        errors: validation.errors,
        errorCount: validation.errorCount,
        warnings: validation.warnings,
      },
      stats: validation.stats,
      sampleRows: validation.sampleRows,
    };
  });

  /**
   * Delete dataset
   *
   * A soft delete that frees the name. Refused (409 dataset_in_use) only
   * while a training job that has not finished uses the dataset.
   */
  app.delete("/datasets/:datasetId", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { datasetId } = z.object({ datasetId: z.string().uuid() }).parse(request.params);

    const result = await deleteDataset(datasetDeps, orgId, datasetId);
    if (!result.ok) {
      return reply.status(result.status).send(result.body);
    }

    return { deleted: true, message: "Dataset deleted" };
  });

  // ============================================
  // What this server can do
  // ============================================

  /**
   * Whether a training job can start here, and if not, why: each blocker has
   * a code and a sentence a page can show as it is.
   */
  app.get("/capabilities", { preHandler: [auth] }, async (request) => {
    return describeTrainingCapabilities(training, { orgId: request.auth!.orgId });
  });

  /**
   * Base models that can be fine-tuned, each with its methods and tiers and,
   * when it cannot be started on this server, the reason.
   */
  app.get("/models", { preHandler: [auth] }, async () => {
    return { models: await listTrainingModels(training) };
  });

  // ============================================
  // Training Jobs
  // ============================================

  /**
   * List training jobs
   */
  app.get("/jobs", { preHandler: [auth] }, async (request) => {
    const { orgId } = request.auth!;
    const { status } = z.object({ status: z.enum(TRAINING_STATES).optional() }).parse(request.query);
    const jobs = await listTrainingJobs(training, { orgId, status });
    return { jobs, total: jobs.length };
  });

  /**
   * Get training job details: progress, the hold, the cost so far, and after
   * settlement the charge with the ledger rows that carry this job's id.
   */
  app.get("/jobs/:jobId", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { jobId } = jobIdParams.parse(request.params);
    const job = await getTrainingJobDetail(training, { orgId, jobId });
    if (!job) {
      return reply.status(404).send({ error: "training_job_not_found", message: "Training job not found" });
    }
    return { job };
  });

  /**
   * Create training job
   *
   * Refusals, in this order and all before any row or credit moves: 400
   * validation; 404 dataset_not_found / model_not_found / model_not_trainable;
   * 409 dataset_not_validated; 422 dataset_row_count_unknown; 409
   * dataset_changed_since_validation; 400 unsupported_method /
   * unsupported_gpu_count / hf_token_required / unknown_gpu_tier /
   * tier_too_small; 503 dataset_storage_not_configured /
   * dataset_storage_not_reachable; 501
   * training_image_not_configured; 501 training_requires_real_nosana /
   * nosana_not_configured / gpu_market_not_configured or 503
   * compute_capacity_unavailable / nosana_unavailable; 503
   * training_callbacks_not_configured /
   * training_callbacks_not_reachable; 503 training_poller_disabled; 503
   * training_orphan_sweep_disabled; 409 training_quota_exceeded; 409
   * training_free_failure_limit; 402 insufficient_credits.
   */
  app.post("/jobs", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const body = createTrainingJobSchema.parse(request.body);
    const choice = jobChoice(body);
    if (!choice.ok) return reply.status(choice.status).send(refusalBody(choice));

    const result = await createTrainingJob(training, {
      orgId,
      input: {
        name: body.name,
        baseModelId: body.baseModelId,
        datasetId: body.datasetId,
        method: body.method,
        gpuTier: body.gpuTier,
        gpuCount: body.gpuCount,
        maxRuntimeSeconds: choice.maxRuntimeSeconds,
        hyperparams: choice.hyperparams,
      },
    });
    if (!result.ok) return reply.status(result.status).send(refusalBody(result));
    return reply.status(201).send(createdBody(result));
  });

  /**
   * Retry: a NEW job with the configuration of one that is over. It takes its
   * own hold and can be refused for every reason a new job can.
   */
  app.post("/jobs/:jobId/retry", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { jobId } = jobIdParams.parse(request.params);
    const result = await retryTrainingJob(training, { orgId, jobId });
    if (!result.ok) return reply.status(result.status).send(refusalBody(result));
    return reply.status(201).send({ ...createdBody(result), retryOf: jobId });
  });

  /**
   * Get training job logs
   */
  app.get("/jobs/:jobId/logs", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { jobId } = jobIdParams.parse(request.params);
    const { tail } = z
      .object({ tail: z.coerce.number().int().min(10).max(10000).default(1000) })
      .parse(request.query);
    const logs = await getTrainingJobLogs(training, { orgId, jobId, tail });
    if (!logs) {
      return reply.status(404).send({ error: "training_job_not_found", message: "Training job not found" });
    }
    return logs;
  });

  /**
   * Cancel training job
   *
   * 200 { status: "cancelled" } when it is over already (nothing had reached
   * the GPU network, or the stop was confirmed at once); 202
   * { status: "cancelling" } while the stop is being confirmed. A run is
   * charged for the time it ran up to this request, never for the time the
   * stop then takes. 409 training_job_not_cancellable otherwise.
   */
  app.post("/jobs/:jobId/cancel", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { jobId } = jobIdParams.parse(request.params);
    const result = await cancelTrainingJob(training, { orgId, jobId });
    if (!result.ok) return reply.status(result.status).send(refusalBody(result));
    return reply.status(result.status === "cancelled" ? 200 : 202).send({
      status: result.status,
      message: result.status === "cancelled" ? "Training job cancelled" : "Training job is being cancelled",
    });
  });

  /**
   * Estimate training time and cost. Planning figures, returned with a low
   * and a high bound, the suggested run limit and the most that would be held.
   * `hold` is what creating the job would hold. For a dataset with no measured
   * tokens per row the answer is `estimate: null` with the hold when a run
   * limit is given, and 422 training_estimate_unavailable when none is.
   */
  app.post("/estimate", { preHandler: [auth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const body = estimateSchema.parse(request.body);
    const choice = jobChoice(body);
    if (!choice.ok) return reply.status(choice.status).send(refusalBody(choice));

    let gpuTier = body.gpuTier;
    let recommendedGpuTier: string | null = null;
    const model = findTrainableModel(body.baseModelId);
    if (model && isTrainingMethod(body.method)) {
      const runtime = await training.getRuntime();
      recommendedGpuTier = trainableTiers(model, body.method, runtime.tiers)[0]?.tier ?? null;
    }
    gpuTier ??= recommendedGpuTier ?? "";

    const input: TrainingJobInput = {
      baseModelId: body.baseModelId,
      datasetId: body.datasetId,
      method: body.method,
      gpuTier,
      gpuCount: body.gpuCount,
      maxRuntimeSeconds: choice.maxRuntimeSeconds,
      hyperparams:
        body.epochs !== undefined ? { ...choice.hyperparams, epochs: body.epochs } : choice.hyperparams,
    };
    const result = await estimateTrainingJob(training, { orgId, input });
    if (!result.ok) return reply.status(result.status).send(refusalBody(result));
    return {
      estimate: result.estimate ? { ...result.estimate, gpuTier: result.gpuTier, recommendedGpuTier } : null,
      hold: { ...result.hold, gpuTier: result.gpuTier },
      dataset: result.dataset,
    };
  });

  // ============================================
  // Container callbacks (no session)
  // ============================================

  await app.register(async (scope) => {
    // The signature is over the exact bytes sent: this scope's parser hands
    // them over unparsed, and refuses a body over the limit with a 413.
    replaceJsonBodyParser(scope);
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: TRAINING_CALLBACK_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );

    /**
     * One event from the training container.
     *
     *   X-WheelsAI-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>
     *
     * 200 { received: true, applied } - applied is false for a replayed or
     * out-of-order event and for a job that is no longer queued or running
     * (so the container does not retry). 401 invalid_callback_signature
     * before any row is read; 400 for a body that is not a trainer event; 404;
     * 413 over 64 KB. It never ends a job and never moves credits.
     */
    scope.post("/jobs/:jobId/events", async (request, reply) => {
      const { jobId } = request.params as { jobId?: string };
      const body = request.body;
      if (!Buffer.isBuffer(body) && typeof body !== "string") {
        return reply.status(400).send({ error: "invalid_trainer_event", message: "A callback is a JSON body." });
      }
      const result = await recordTrainingEvent(training, {
        jobId: typeof jobId === "string" ? jobId : "",
        nonce: (request.query as Record<string, unknown> | undefined)?.n,
        signatureHeader: request.headers[TRAINING_CALLBACK_SIGNATURE_HEADER],
        rawBody: body,
      });
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.code, message: result.message });
      }
      return { received: true, applied: result.applied };
    });
  });
  };
}

/** The production plugin: registered under /api/training (index.ts). */
export const trainingRoutes: FastifyPluginAsync = async (app, opts) => {
  await createTrainingRoutes({
    training: buildTrainingDeps(prisma),
    datasets: buildDatasetDeps(prisma),
  })(app, opts);
};
