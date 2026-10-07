import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import { prisma } from "@wheelsai/db";
import { triggerWebhook } from "../services/webhooks.js";
import {
  generateTrainingJobDefinition,
  estimateTrainingCost,
  recommendGpuTier,
  parseTrainingLogs,
  DEFAULT_TRAINING_CONFIG,
  DEFAULT_LORA_CONFIG,
} from "../services/training.js";
import {
  deriveTrainingWebhookToken,
  verifyTrainingWebhookToken,
} from "../services/trainingWebhookAuth.js";
import {
  createDataset,
  deleteDataset,
  describeDatasetStorage,
  knownDatasetRowCount,
  rowCountUnknownRefusal,
  serializeDataset,
  serializeDatasetDetail,
  validateStoredDataset,
} from "../services/dataset.js";
import { buildDatasetDeps } from "../services/buildDatasetDeps.js";
import { getNosanaClient } from "../services/nosana.js";
import { NosanaLifecycleError } from "../services/nosanaDeploymentLifecycle.js";
import { recordNosanaOrphan } from "../services/nosanaOrphans.js";
import {
  recordFailedTrainingSubmit,
  stopCancelledTrainingJob,
  trainingSubmitStamp,
} from "../services/trainingNosana.js";

const logger = createLogger("training-routes");

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

const createTrainingJobSchema = z.object({
  name: z.string().min(1).max(100),
  baseModelId: z.string(),
  datasetId: z.string().uuid(),
  method: z.enum(["lora", "qlora", "full"]).default("lora"),
  gpuTier: z.string().default("rtx-4090"),
  gpuCount: z.number().int().min(1).max(8).default(1),
  config: z.object({
    epochs: z.number().int().min(1).max(100).default(3),
    batchSize: z.number().int().min(1).max(64).default(4),
    learningRate: z.number().min(1e-6).max(1e-1).default(2e-4),
    warmupSteps: z.number().int().min(0).max(10000).default(100),
    gradientAccumulationSteps: z.number().int().min(1).max(64).default(4),
    loraR: z.number().int().min(4).max(128).optional(),
    loraAlpha: z.number().int().min(8).max(256).optional(),
    loraDropout: z.number().min(0).max(0.5).optional(),
    targetModules: z.array(z.string()).optional(),
    quantizationBits: z.enum(["4", "8"]).optional(),
  }).default({}),
});

// ============================================
// Routes
// ============================================

export const trainingRoutes: FastifyPluginAsync = async (app) => {
  const datasetDeps = buildDatasetDeps(prisma);

  // ============================================
  // Datasets
  // ============================================

  /**
   * List datasets
   */
  app.get("/datasets", { preHandler: [requireAuth] }, async (request, _reply) => {
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
  app.get("/datasets/:datasetId", { preHandler: [requireAuth] }, async (request, reply) => {
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
  app.post("/datasets", { preHandler: [requireAuth] }, async (request, reply) => {
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
  app.post("/datasets/:datasetId/validate", { preHandler: [requireAuth] }, async (request, reply) => {
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
  app.delete("/datasets/:datasetId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { datasetId } = z.object({ datasetId: z.string().uuid() }).parse(request.params);

    const result = await deleteDataset(datasetDeps, orgId, datasetId);
    if (!result.ok) {
      return reply.status(result.status).send(result.body);
    }

    return { deleted: true, message: "Dataset deleted" };
  });

  // ============================================
  // Training Jobs
  // ============================================

  /**
   * List training jobs
   */
  app.get("/jobs", { preHandler: [requireAuth] }, async (request, _reply) => {
    const { orgId } = request.auth!;
    const { status } = z.object({
      status: z.enum(["pending", "queued", "running", "completed", "failed", "cancelled"]).optional(),
    }).parse(request.query);

    const jobs = await prisma.trainingJob.findMany({
      where: {
        orgId,
        ...(status && { status }),
      },
      include: {
        dataset: {
          select: { name: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        baseModelId: j.baseModelId,
        datasetName: j.dataset.name,
        method: j.method,
        status: j.status,
        progress: j.progress,
        gpuTier: j.gpuTier,
        gpuCount: j.gpuCount,
        estimatedCostCents: j.estimatedCostCents ? Number(j.estimatedCostCents) : null,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
      })),
      total: jobs.length,
    };
  });

  /**
   * Get training job details
   */
  app.get("/jobs/:jobId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.params);

    const job = await prisma.trainingJob.findFirst({
      where: { id: jobId, orgId },
      include: {
        dataset: true,
      },
    });

    if (!job) {
      return reply.notFound("Training job not found");
    }

    // Parse logs for progress if running
    let progress = null;
    if (job.status === "running" && job.logs) {
      progress = parseTrainingLogs(job.logs);
    }

    return {
      job: {
        id: job.id,
        name: job.name,
        baseModelId: job.baseModelId,
        baseModelHfId: job.baseModelHfId,
        dataset: {
          id: job.dataset.id,
          name: job.dataset.name,
          // null, not 0, when the rows could not be counted.
          rowCount: job.dataset.rowCountKnown ? job.dataset.rowCount : null,
        },
        method: job.method,
        config: job.config,
        gpuTier: job.gpuTier,
        gpuCount: job.gpuCount,
        status: job.status,
        progress: job.progress,
        currentEpoch: job.currentEpoch,
        totalEpochs: job.totalEpochs,
        trainingLoss: job.trainingLoss,
        evalLoss: job.evalLoss,
        metrics: job.metrics,
        outputModelId: job.outputModelId,
        outputPath: job.outputPath,
        estimatedCostCents: job.estimatedCostCents ? Number(job.estimatedCostCents) : null,
        actualCostCents: job.actualCostCents ? Number(job.actualCostCents) : null,
        lastError: job.lastError,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      },
      liveProgress: progress,
    };
  });

  /**
   * Create training job
   */
  app.post("/jobs", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const body = createTrainingJobSchema.parse(request.body);

    // Verify dataset exists and is validated
    const dataset = await prisma.dataset.findFirst({
      where: { id: body.datasetId, orgId, deletedAt: null },
    });

    if (!dataset) {
      return reply.notFound("Dataset not found");
    }

    if (!dataset.isValidated) {
      return reply.badRequest("Dataset must be validated before training");
    }

    // The cost below is worked out from the row count. A dataset whose rows
    // could not be counted holds a placeholder 0, which would price the job
    // at nothing: refused before a job row or a credit moves.
    const datasetRows = knownDatasetRowCount(dataset);
    if (datasetRows === null) {
      const refusal = rowCountUnknownRefusal();
      return reply.status(refusal.status).send(refusal.body);
    }

    // Verify model exists
    const model = await prisma.model.findUnique({
      where: { id: body.baseModelId },
    });

    if (!model) {
      return reply.notFound(`Model '${body.baseModelId}' not found`);
    }

    // Estimate cost
    const cost = estimateTrainingCost(
      body.baseModelId,
      body.method,
      datasetRows,
      body.config.epochs || DEFAULT_TRAINING_CONFIG.epochs,
      body.gpuTier
    );

    // Check credit balance
    const balance = await prisma.creditBalance.findUnique({
      where: { orgId },
    });

    if (!balance || Number(balance.balanceCents) < cost.totalCostCents) {
      return reply.paymentRequired(
        `Insufficient credits. Estimated cost: $${(cost.totalCostCents / 100).toFixed(2)}, ` +
        `Available: $${(Number(balance?.balanceCents ?? 0n) / 100).toFixed(2)}`
      );
    }

    // Build training config
    const trainingConfig = {
      epochs: body.config.epochs || DEFAULT_TRAINING_CONFIG.epochs,
      batchSize: body.config.batchSize || DEFAULT_TRAINING_CONFIG.batchSize,
      learningRate: body.config.learningRate || DEFAULT_TRAINING_CONFIG.learningRate,
      warmupSteps: body.config.warmupSteps || DEFAULT_TRAINING_CONFIG.warmupSteps,
      gradientAccumulationSteps: body.config.gradientAccumulationSteps || DEFAULT_TRAINING_CONFIG.gradientAccumulationSteps,
      loraR: body.config.loraR || DEFAULT_LORA_CONFIG.loraR,
      loraAlpha: body.config.loraAlpha || DEFAULT_LORA_CONFIG.loraAlpha,
      loraDropout: body.config.loraDropout || DEFAULT_LORA_CONFIG.loraDropout,
      targetModules: body.config.targetModules || DEFAULT_LORA_CONFIG.targetModules,
      quantizationBits: body.config.quantizationBits ? parseInt(body.config.quantizationBits) : 4,
    };

    // Create job record
    const job = await prisma.trainingJob.create({
      data: {
        orgId,
        name: body.name,
        baseModelId: body.baseModelId,
        baseModelHfId: model.hfId,
        datasetId: body.datasetId,
        method: body.method,
        config: trainingConfig,
        gpuTier: body.gpuTier,
        gpuCount: body.gpuCount,
        status: "pending",
        progress: 0,
        totalEpochs: trainingConfig.epochs,
        estimatedCostCents: BigInt(cost.totalCostCents),
      },
    });

    logger.info(
      { jobId: job.id, baseModel: body.baseModelId, method: body.method },
      "Training job created"
    );

    // Submit to Nosana (async)
    submitTrainingJob(job.id, {
      baseModelId: body.baseModelId,
      baseModelHfId: model.hfId,
      datasetUrl: dataset.storageUrl,
      datasetFormat: dataset.format as any,
      method: body.method,
      ...trainingConfig,
      outputPath: `s3://wheelsai-models/${orgId}/${job.id}`,
      webhookUrl: `${process.env.API_URL}/api/training/jobs/${job.id}/webhook?token=${deriveTrainingWebhookToken(job.id)}`,
    }, body.gpuTier).catch((err) => {
      logger.error({ err, jobId: job.id }, "Failed to submit training job");
    });

    triggerWebhook(
      orgId,
      "training.started",
      { jobId: job.id, name: job.name },
      "training",
      job.id,
    ).catch((err) => logger.error({ err }, "webhook training.started failed"));

    reply.status(201);
    return {
      job: {
        id: job.id,
        name: job.name,
        status: job.status,
      },
      estimate: {
        gpuHours: cost.gpuHours,
        costCents: cost.totalCostCents,
        costUsd: (cost.totalCostCents / 100).toFixed(2),
      },
      message: "Training job created and queued",
    };
  });

  /**
   * Get training job logs
   */
  app.get("/jobs/:jobId/logs", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const { tail } = z.object({
      tail: z.coerce.number().int().min(10).max(10000).default(1000),
    }).parse(request.query);

    const job = await prisma.trainingJob.findFirst({
      where: { id: jobId, orgId },
    });

    if (!job) {
      return reply.notFound("Training job not found");
    }

    // Get last N lines of logs
    const logs = job.logs || "";
    const lines = logs.split("\n");
    const tailLines = lines.slice(-tail).join("\n");

    return {
      jobId,
      status: job.status,
      logs: tailLines,
      totalLines: lines.length,
    };
  });

  /**
   * Cancel training job
   */
  app.post("/jobs/:jobId/cancel", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.params);

    const job = await prisma.trainingJob.findFirst({
      where: { id: jobId, orgId },
    });

    if (!job) {
      return reply.notFound("Training job not found");
    }

    if (!["pending", "queued", "running"].includes(job.status)) {
      return reply.badRequest(`Cannot cancel job with status: ${job.status}`);
    }

    // Stop Nosana job
    if (job.nosanaJobId) {
      const nosana = await getNosanaClient();
      const nosanaJobId = job.nosanaJobId;
      // A cancelled job is never looked at again and TrainingJob has no vault
      // stamp: unless the stop landed AND the vault is verified empty, hand the
      // id to the vault sweep, which stops it and retries the withdraw. Both
      // the stop and the record go through the credential that created the
      // deployment (the row's access-mode stamp), whatever is primary today.
      await stopCancelledTrainingJob(
        {
          stopDeployment: (id, mode) => nosana.stopDeployment(id, mode),
          recordOrphan: (args) => recordNosanaOrphan(prisma, args),
          onStopError: (err) =>
            logger.error({ err, jobId, nosanaJobId }, "Failed to stop Nosana job"),
        },
        { id: jobId, nosanaJobId, nosanaAccessMode: job.nosanaAccessMode },
      );
    }

    // Update status
    await prisma.trainingJob.update({
      where: { id: jobId },
      data: {
        status: "cancelled",
        completedAt: new Date(),
      },
    });

    logger.info({ jobId }, "Training job cancelled");

    return { message: "Training job cancelled" };
  });

  /**
   * Training job webhook (called by Nosana). Authenticated by the per-job
   * HMAC token embedded in the webhook URL at submission time (A6) —
   * accepted via ?token= or the x-webhook-token header.
   */
  app.post("/jobs/:jobId/webhook", async (request, reply) => {
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.params);

    const presentedToken =
      (request.query as Record<string, unknown> | undefined)?.token ??
      request.headers["x-webhook-token"];
    if (
      typeof presentedToken !== "string" ||
      !verifyTrainingWebhookToken(jobId, presentedToken)
    ) {
      return reply.status(401).send({
        error: "invalid_webhook_token",
        message: "Missing or invalid webhook token for this job.",
      });
    }

    const body = z.object({
      status: z.enum(["running", "completed", "failed"]).optional(),
      progress: z.number().int().min(0).max(100).optional(),
      currentEpoch: z.number().int().optional(),
      trainingLoss: z.number().optional(),
      evalLoss: z.number().optional(),
      logs: z.string().optional(),
      error: z.string().optional(),
      outputPath: z.string().optional(),
    }).parse(request.body);

    const job = await prisma.trainingJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      return reply.notFound("Training job not found");
    }

    // Build update
    const update: any = {};

    if (body.status) {
      update.status = body.status;
      if (body.status === "running" && !job.startedAt) {
        update.startedAt = new Date();
      }
      if (body.status === "completed" || body.status === "failed") {
        update.completedAt = new Date();
      }
    }

    if (body.progress !== undefined) update.progress = body.progress;
    if (body.currentEpoch !== undefined) update.currentEpoch = body.currentEpoch;
    if (body.trainingLoss !== undefined) update.trainingLoss = body.trainingLoss;
    if (body.evalLoss !== undefined) update.evalLoss = body.evalLoss;
    if (body.error) update.lastError = body.error;
    if (body.outputPath) update.outputPath = body.outputPath;

    if (body.logs) {
      // Append logs, capped per call and in total so a chatty (or hostile)
      // runner cannot grow the row without bound.
      const MAX_APPEND = 64 * 1024;
      const MAX_TOTAL = 1024 * 1024;
      update.logs = ((job.logs || "") + body.logs.slice(0, MAX_APPEND)).slice(
        -MAX_TOTAL
      );
    }

    await prisma.trainingJob.update({
      where: { id: jobId },
      data: update,
    });

    logger.info({ jobId, status: body.status, progress: body.progress }, "Training job webhook");

    if (body.status === "completed" || body.status === "failed") {
      triggerWebhook(
        job.orgId,
        body.status === "completed" ? "training.completed" : "training.failed",
        { jobId, name: job.name, ...(body.error ? { error: body.error } : {}) },
        "training",
        jobId,
      ).catch((err) => logger.error({ err }, "webhook training terminal failed"));
    }

    return { received: true };
  });

  /**
   * Estimate training cost
   */
  app.post("/estimate", { preHandler: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      baseModelId: z.string(),
      datasetId: z.string().uuid(),
      method: z.enum(["lora", "qlora", "full"]).default("lora"),
      epochs: z.number().int().min(1).max(100).default(3),
      gpuTier: z.string().optional(),
    }).parse(request.body);

    const { orgId } = request.auth!;

    // Get dataset row count
    const dataset = await prisma.dataset.findFirst({
      where: { id: body.datasetId, orgId, deletedAt: null },
    });

    if (!dataset) {
      return reply.notFound("Dataset not found");
    }

    // No estimate from a count that is not known (not validated yet, or the
    // rows could not be counted): a $0.00 figure would be read as a price.
    if (!dataset.isValidated) {
      return reply.badRequest("Dataset must be validated before training");
    }
    const datasetRows = knownDatasetRowCount(dataset);
    if (datasetRows === null) {
      const refusal = rowCountUnknownRefusal();
      return reply.status(refusal.status).send(refusal.body);
    }

    // Get GPU recommendation
    const gpuRec = recommendGpuTier(body.baseModelId, body.method);
    const gpuTier = body.gpuTier || gpuRec.tier;

    // Calculate estimate
    const cost = estimateTrainingCost(
      body.baseModelId,
      body.method,
      datasetRows,
      body.epochs,
      gpuTier
    );

    return {
      estimate: {
        gpuTier,
        recommendedGpuTier: gpuRec.tier,
        minVramGb: gpuRec.minVram,
        gpuHours: cost.gpuHours,
        costPerHour: cost.costPerHour,
        totalCostCents: cost.totalCostCents,
        totalCostUsd: (cost.totalCostCents / 100).toFixed(2),
      },
      dataset: {
        rowCount: datasetRows,
        format: dataset.format,
      },
    };
  });

  /**
   * Get available base models for training
   */
  app.get("/models", { preHandler: [requireAuth] }, async (_request, _reply) => {
    // Models that support fine-tuning
    const trainableModels = await prisma.model.findMany({
      where: {
        isActive: true,
        // Only certain models support fine-tuning
        id: {
          in: [
            "llama-3.1-8b",
            "llama-3.1-70b",
            "mistral-7b",
            "qwen2.5-7b",
            "qwen2.5-14b",
            "qwen2.5-72b",
          ],
        },
      },
      orderBy: { parameters: "asc" },
    });

    return {
      models: trainableModels.map((m) => ({
        id: m.id,
        hfId: m.hfId,
        displayName: m.displayName,
        parameters: m.parameters ? Number(m.parameters) : null,
        supportedMethods: getSupportedMethods(m.id),
        recommendedGpuTier: recommendGpuTier(m.id, "lora").tier,
      })),
    };
  });
};

// ============================================
// Helper Functions
// ============================================

async function submitTrainingJob(
  jobId: string,
  config: any,
  gpuTier: string
): Promise<void> {
  try {
    // Update status to queued
    await prisma.trainingJob.update({
      where: { id: jobId },
      data: { status: "queued" },
    });

    // Generate job definition
    const jobDefinition = generateTrainingJobDefinition(config);

    // Submit to Nosana
    const nosana = await getNosanaClient();
    // kind "batch": finite work. It runs once (strategy SIMPLE), is never
    // auto-extended, and is bounded by NOSANA_BATCH_JOB_TIMEOUT_SECONDS - a
    // long-running "service" deployment here would burn platform funds until
    // someone remembered to stop it.
    const nosanaJob = await nosana.createDeployment(jobDefinition as any, gpuTier, 1, {
      kind: "batch",
    });

    // Store Nosana job ID, with the access mode that created it in the same
    // statement: every later stop or reclaim goes through that credential.
    await prisma.trainingJob.update({
      where: { id: jobId },
      data: trainingSubmitStamp(nosanaJob),
    });

    logger.info({ jobId, nosanaJobId: nosanaJob.id }, "Training job submitted to Nosana");
  } catch (error) {
    logger.error({ error, jobId }, "Failed to submit training job to Nosana");

    // A failure after creation carries the Nosana id; unless its cleanup
    // verified it stopped and drained, keep it for the vault sweep.
    // The record carries the mode the failed call used.
    if (error instanceof NosanaLifecycleError) {
      await recordFailedTrainingSubmit(
        { recordOrphan: (args) => recordNosanaOrphan(prisma, args) },
        jobId,
        error,
      );
    }

    await prisma.trainingJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        lastError: error instanceof Error ? error.message : "Unknown error",
      },
    });

    throw error;
  }
}

function getSupportedMethods(modelId: string): string[] {
  // 70B+ models only support QLoRA on available GPUs
  if (modelId.includes("70b") || modelId.includes("72b")) {
    return ["qlora"];
  }

  // 13B+ models support LoRA and QLoRA
  if (modelId.includes("13b") || modelId.includes("14b")) {
    return ["lora", "qlora"];
  }

  // Smaller models support all methods
  return ["lora", "qlora", "full"];
}
