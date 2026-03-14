import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import { prisma } from "@wheelsai/db";
import {
  generateTrainingJobDefinition,
  estimateTrainingCost,
  recommendGpuTier,
  parseTrainingLogs,
  DEFAULT_TRAINING_CONFIG,
  DEFAULT_LORA_CONFIG,
} from "../services/training.js";
import {
  generateUploadUrl,
  validateDataset,
  estimateDatasetStats,
} from "../services/dataset.js";
import { getNosanaClient } from "../services/nosana.js";

const logger = createLogger("training-routes");

// ============================================
// Schemas
// ============================================

const createDatasetSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  fileName: z.string(),
  contentType: z.string().default("application/jsonl"),
  format: z.enum(["jsonl", "csv", "parquet", "alpaca", "sharegpt"]).default("jsonl"),
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
  // ============================================
  // Datasets
  // ============================================

  /**
   * List datasets
   */
  app.get("/datasets", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;

    const datasets = await prisma.dataset.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });

    return {
      datasets: datasets.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        format: d.format,
        rowCount: d.rowCount,
        sizeBytes: Number(d.sizeBytes),
        isValidated: d.isValidated,
        createdAt: d.createdAt,
      })),
      total: datasets.length,
    };
  });

  /**
   * Get dataset details
   */
  app.get("/datasets/:datasetId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { datasetId } = z.object({ datasetId: z.string().uuid() }).parse(request.params);

    const dataset = await prisma.dataset.findFirst({
      where: { id: datasetId, orgId },
    });

    if (!dataset) {
      return reply.notFound("Dataset not found");
    }

    return {
      dataset: {
        id: dataset.id,
        name: dataset.name,
        description: dataset.description,
        format: dataset.format,
        storageType: dataset.storageType,
        rowCount: dataset.rowCount,
        sizeBytes: Number(dataset.sizeBytes),
        isValidated: dataset.isValidated,
        validationErrors: dataset.validationErrors,
        sampleRows: dataset.sampleRows,
        createdAt: dataset.createdAt,
        updatedAt: dataset.updatedAt,
      },
    };
  });

  /**
   * Create dataset (get upload URL)
   */
  app.post("/datasets", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const body = createDatasetSchema.parse(request.body);

    // Check for duplicate name
    const existing = await prisma.dataset.findFirst({
      where: { orgId, name: body.name },
    });

    if (existing) {
      return reply.badRequest(`Dataset '${body.name}' already exists`);
    }

    // Generate upload URL
    const { uploadUrl, datasetId, storageUrl, expiresAt } = await generateUploadUrl(
      orgId,
      body.fileName,
      body.contentType
    );

    // Create dataset record (pending validation)
    const dataset = await prisma.dataset.create({
      data: {
        id: datasetId,
        orgId,
        name: body.name,
        description: body.description,
        storageType: "s3",
        storageUrl,
        format: body.format,
        sizeBytes: BigInt(0),
        rowCount: 0,
        isValidated: false,
      },
    });

    logger.info({ datasetId: dataset.id, name: body.name }, "Dataset created");

    reply.status(201);
    return {
      dataset: {
        id: dataset.id,
        name: dataset.name,
      },
      upload: {
        url: uploadUrl,
        expiresAt,
      },
      message: "Upload your dataset using the provided URL, then call POST /datasets/:id/validate",
    };
  });

  /**
   * Validate uploaded dataset
   */
  app.post("/datasets/:datasetId/validate", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { datasetId } = z.object({ datasetId: z.string().uuid() }).parse(request.params);

    const dataset = await prisma.dataset.findFirst({
      where: { id: datasetId, orgId },
    });

    if (!dataset) {
      return reply.notFound("Dataset not found");
    }

    // Validate dataset
    const validation = await validateDataset(dataset.storageUrl, dataset.format);

    // Calculate stats
    const stats = estimateDatasetStats(
      validation.rowCount,
      validation.sampleRows,
      validation.schema.detectedFormat
    );

    // Update dataset record
    await prisma.dataset.update({
      where: { id: datasetId },
      data: {
        isValidated: validation.isValid,
        rowCount: validation.rowCount,
        sizeBytes: BigInt(validation.sizeBytes),
        format: validation.schema.detectedFormat !== "unknown"
          ? validation.schema.detectedFormat
          : dataset.format,
        validationErrors: validation.errors.length > 0 ? (validation.errors as any) : undefined,
        sampleRows: validation.sampleRows,
      },
    });

    logger.info(
      { datasetId, isValid: validation.isValid, rowCount: validation.rowCount },
      "Dataset validated"
    );

    return {
      validation: {
        isValid: validation.isValid,
        format: validation.format,
        detectedFormat: validation.schema.detectedFormat,
        rowCount: validation.rowCount,
        sizeBytes: validation.sizeBytes,
        errors: validation.errors,
        warnings: validation.warnings,
      },
      stats,
      sampleRows: validation.sampleRows,
    };
  });

  /**
   * Delete dataset
   */
  app.delete("/datasets/:datasetId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { datasetId } = z.object({ datasetId: z.string().uuid() }).parse(request.params);

    const dataset = await prisma.dataset.findFirst({
      where: { id: datasetId, orgId },
    });

    if (!dataset) {
      return reply.notFound("Dataset not found");
    }

    // Check if dataset is used by any training jobs
    const usedByJobs = await prisma.trainingJob.count({
      where: { datasetId },
    });

    if (usedByJobs > 0) {
      return reply.badRequest(`Dataset is used by ${usedByJobs} training job(s) and cannot be deleted`);
    }

    // Delete from S3 would go here
    // await deleteFromS3(dataset.storageUrl);

    await prisma.dataset.delete({
      where: { id: datasetId },
    });

    logger.info({ datasetId }, "Dataset deleted");

    return { message: "Dataset deleted" };
  });

  // ============================================
  // Training Jobs
  // ============================================

  /**
   * List training jobs
   */
  app.get("/jobs", { preHandler: [requireAuth] }, async (request, reply) => {
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
          rowCount: job.dataset.rowCount,
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
      where: { id: body.datasetId, orgId },
    });

    if (!dataset) {
      return reply.notFound("Dataset not found");
    }

    if (!dataset.isValidated) {
      return reply.badRequest("Dataset must be validated before training");
    }

    // Verify model exists
    const model = await prisma.model.findUnique({
      where: { id: body.baseModelId },
    });

    if (!model) {
      return reply.notFound(`Model '${body.baseModelId}' not found`);
    }

    // Get GPU recommendation
    const gpuRec = recommendGpuTier(body.baseModelId, body.method);

    // Estimate cost
    const cost = estimateTrainingCost(
      body.baseModelId,
      body.method,
      dataset.rowCount,
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
      webhookUrl: `${process.env.API_URL}/api/training/jobs/${job.id}/webhook`,
    }, body.gpuTier).catch((err) => {
      logger.error({ err, jobId: job.id }, "Failed to submit training job");
    });

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
      await nosana.stopDeployment(job.nosanaJobId).catch((err) => {
        logger.error({ err, jobId, nosanaJobId: job.nosanaJobId }, "Failed to stop Nosana job");
      });
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
   * Training job webhook (called by Nosana)
   */
  app.post("/jobs/:jobId/webhook", async (request, reply) => {
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(request.params);
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
      // Append logs
      update.logs = (job.logs || "") + body.logs;
    }

    await prisma.trainingJob.update({
      where: { id: jobId },
      data: update,
    });

    logger.info({ jobId, status: body.status, progress: body.progress }, "Training job webhook");

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
      where: { id: body.datasetId, orgId },
    });

    if (!dataset) {
      return reply.notFound("Dataset not found");
    }

    // Get GPU recommendation
    const gpuRec = recommendGpuTier(body.baseModelId, body.method);
    const gpuTier = body.gpuTier || gpuRec.tier;

    // Calculate estimate
    const cost = estimateTrainingCost(
      body.baseModelId,
      body.method,
      dataset.rowCount,
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
        rowCount: dataset.rowCount,
        format: dataset.format,
      },
    };
  });

  /**
   * Get available base models for training
   */
  app.get("/models", { preHandler: [requireAuth] }, async (request, reply) => {
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
    const nosanaJob = await nosana.createDeployment(jobDefinition as any, gpuTier, 1);

    // Store Nosana job ID
    await prisma.trainingJob.update({
      where: { id: jobId },
      data: { nosanaJobId: nosanaJob.id },
    });

    logger.info({ jobId, nosanaJobId: nosanaJob.id }, "Training job submitted to Nosana");
  } catch (error) {
    logger.error({ error, jobId }, "Failed to submit training job to Nosana");

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
