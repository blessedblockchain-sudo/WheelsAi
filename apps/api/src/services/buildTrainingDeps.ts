/**
 * Composition root of the training job service (services/trainingJobs.ts):
 * binds Prisma, the Nosana client, the object store, configuration, the
 * clock and the organization webhooks.
 *
 * Nothing is read at import. Configuration is resolved each time it is asked
 * for, so a test (or an operator's restart) never sees a stale copy.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { env } from "../config/env.js";
import { getNosanaDeployConfig } from "../config/nosanaDeploy.js";
import { getTrainingConfig } from "../config/training.js";
import { prisma as defaultPrisma } from "../lib/prisma.js";
import { createLogger } from "../utils/logger.js";
import { getNosanaClient, isNosanaMockEnabled } from "./nosana.js";
import { listDeployableTiers, MARKETS } from "./nosanaMarkets.js";
import { recordNosanaOrphan, type NosanaOrphanPrisma } from "./nosanaOrphans.js";
import { getObjectStore, issueTransferUrl } from "./objectStore.js";
import {
  placeableTrainingTiers,
  type TrainingDeps,
  type TrainingPrisma,
  type TrainingRuntime,
  type TrainingTierInfo,
} from "./trainingJobs.js";
import { deriveTrainingCallbackSecret } from "./trainingWebhookAuth.js";
import { triggerWebhook } from "./webhooks.js";

const logger = createLogger("training-jobs");

function tierTable(entries: Array<[string, { name: string; vram: number; pricePerSecond: number }]>) {
  const table: Record<string, TrainingTierInfo> = {};
  for (const [tier, market] of entries) {
    table[tier] = { name: market.name, vram: market.vram, pricePerSecond: market.pricePerSecond };
  }
  return table;
}

/** Configuration as the job service reads it. */
export async function resolveTrainingRuntime(): Promise<TrainingRuntime> {
  const config = getTrainingConfig();
  const nosana = await getNosanaClient();
  const nosanaMock = isNosanaMockEnabled();
  const nosanaConfigured = nosana.getAccessMode() !== "none";
  const publicApiUrl = env.PUBLIC_API_URL?.trim().replace(/\/+$/, "") || null;
  const allTiers = tierTable(Object.entries(MARKETS));
  return {
    image: config.image,
    hfToken: config.hfToken,
    pollIntervalMs: config.pollIntervalMs,
    queueTimeoutSeconds: config.queueTimeoutSeconds,
    setupAllowanceSeconds: config.setupAllowanceSeconds,
    maxActiveJobsPerOrg: config.maxActiveJobsPerOrg,
    freeFailuresPerDay: config.freeFailuresPerDay,
    // The deployment status worker's tick is the orphan sweep (R5).
    orphanSweepEnabled: env.DEPLOYMENT_STATUS_INTERVAL_MS > 0,
    adapterMaxBytes: config.adapterMaxBytes,
    datasetMaxBytes: config.datasetMaxBytes,
    datasetMaxRows: config.datasetMaxRows,
    batchJobTimeoutSeconds: getNosanaDeployConfig().batchJobTimeoutSeconds,
    publicApiUrl,
    nosanaMock,
    nosanaConfigured,
    // With the mock on, or with no credential, every tier passes the tier
    // check, so the refusal a caller sees is the honest one
    // (training_requires_real_nosana, nosana_not_configured).
    tiers: placeableTrainingTiers({
      deployable: tierTable(listDeployableTiers(nosana.getNetwork(), { allowMock: nosanaMock })),
      all: allTiers,
      nosanaMock,
      nosanaConfigured,
    }),
    allTiers,
  };
}

export function buildTrainingDeps(
  prisma: unknown = defaultPrisma,
): TrainingDeps {
  return {
    prisma: prisma as TrainingPrisma,
    getNosana: () => getNosanaClient(),
    getRuntime: resolveTrainingRuntime,
    getStore: () => getObjectStore(),
    issueTransferUrl: (args) => issueTransferUrl(args),
    callbackSecret: (jobId, submitNonce) => deriveTrainingCallbackSecret(jobId, submitNonce),
    recordOrphan: (args) => recordNosanaOrphan(prisma as NosanaOrphanPrisma, args),
    emit: (orgId, event, data, jobId) => {
      triggerWebhook(orgId, event, data, "training", jobId).catch((err) =>
        logger.error({ err, jobId, event }, "Training webhook could not be sent"),
      );
    },
    defer: (task) => {
      task().catch((err) => logger.error({ err }, "Deferred training task failed"));
    },
    now: () => new Date(),
    newId: randomUUID,
    // 16 hex characters: inside the pattern of a deployment name's nonce.
    newNonce: () => randomBytes(8).toString("hex"),
    log: {
      info: (context, message) => logger.info(context, message),
      warn: (context, message) => logger.warn(context, message),
      error: (context, message) => logger.error(context, message),
    },
  };
}
